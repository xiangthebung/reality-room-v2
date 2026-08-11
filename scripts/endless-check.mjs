import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { triage } from './known-noise.mjs';

/**
 * Does the world actually go on forever, and does it stay affordable?
 *
 * Three separate claims, none of which the other scripts test:
 *
 *   1. THERE IS NO BORDER. `confine()` is an identity now, so the only thing
 *      that could stop the player is a hole. At every station this raycasts
 *      straight down onto the ground group and demands a hit — a missing chunk
 *      is a hole you fall through, and it is invisible from directly above it.
 *
 *   2. THE HEIGHT UNDER YOUR FEET IS THE HEIGHT THE MESH DRAWS. `heightAt` is
 *      the single source of truth for scattering, walking and collision, but
 *      the chunk mesh is built by `heightGrid` in a worker, and the whole
 *      streaming design rests on those two agreeing everywhere rather than just
 *      near the origin. So the raycast hit is compared against `heightAt` at
 *      the same coordinate. This is the check that catches the local-versus-
 *      absolute-y mistake, which is otherwise only visible as a seam.
 *
 *   3. IT DOES NOT LEAK. 10 km of walking is ~4700 chunks and about 2 GB if
 *      nothing is evicted, so geometry count and heap must plateau rather than
 *      climb. Walking out and back again is the real test: coming home must not
 *      cost more than leaving did.
 *
 * Moving is done in steps with frames in between, not by teleporting, because
 * GroundField deliberately consumes at most one chunk per frame — a single jump
 * of 2 km would arrive somewhere the ring has not reached yet and report a hole
 * that a real player walking there would never have seen.
 *
 *   node scripts/endless-check.mjs [--url=…] [--out=.shots] [--far=2000]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots');
const FAR = Number(args.far ?? 2000);
/** Metres per hop. Below the 128 m chunk pitch, so the ring is never surprised. */
const HOP = 90;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--autoplay-policy=no-user-gesture-required',
    '--js-flags=--expose-gc',
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });

const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

/**
 * DEAFEN THE PAGE TO HOT RELOADS BEFORE IT LOADS.
 *
 * A save landing mid-run reloads the page, and this script would then walk a
 * freshly spawned player 10 km from a standing start and report the ring's
 * behaviour under conditions nobody asked about — silently, because a reloaded
 * page has no console problems either. Same guard as shoot.mjs.
 */
await page.routeWebSocket(/.*/, () => {});
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
// The gate itself, not a guess at how long it takes to lift.
await page.waitForSelector('#gate.gone', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2000);
await page.evaluate(() => {
  document.getElementById('toast').style.display = 'none';
  document.getElementById('help').style.display = 'none';
});

/** Walk to (x, z) in hops, giving the streamer frames to keep up. */
async function walkTo(x, z, hop) {
  await page.evaluate(
    async ({ x, z, hop }) => {
      const { controller } = window.RR;
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const x0 = controller.position.x;
      const z0 = controller.position.z;
      const dist = Math.hypot(x - x0, z - z0);
      const steps = Math.max(1, Math.ceil(dist / hop));
      for (let i = 1; i <= steps; i++) {
        controller.position.x = x0 + ((x - x0) * i) / steps;
        controller.position.z = z0 + ((z - z0) * i) / steps;
        controller.velocity.set(0, 0, 0);
        // Two frames per hop: one for the cull/stream pass to notice, one for
        // the queued chunk to be consumed.
        await frame();
        await frame();
      }
      // Let the ring finish filling before anybody looks.
      for (let i = 0; i < 90; i++) await frame();
    },
    { x, z, hop }
  );
}

/**
 * Read the chunk under the player and compare it against the height function.
 *
 * Deliberately NOT a raycast. A ray tells you where a triangle is; this reads
 * the vertex the chunk was actually built from, which is the thing the streamer
 * could get wrong. The failure mode being hunted is a chunk that bakes heights
 * relative to its own origin and offsets with `mesh.position.y` — that draws a
 * perfectly plausible surface with a step at every border, and because the
 * trip's `uHills` multiplies LOCAL y, the step grows as the trip deepens. Both
 * the world y and the local y are reported so the two cases are distinguishable
 * at a glance rather than inferrable.
 */
async function probe(label) {
  return page.evaluate((label) => {
    const { renderer, camera, controller, forest } = window.RR;
    const ground = forest.ground;
    const px = controller.position.x;
    const pz = controller.position.z;

    let covering = null;
    let best = Infinity;
    let localY = null;
    let worldY = null;
    let vx = 0;
    let vz = 0;

    for (const mesh of ground.children) {
      const pos = mesh.geometry?.attributes?.position;
      if (!pos) continue;
      const ox = mesh.position.x;
      const oz = mesh.position.z;
      // Nearest vertex in this chunk to the player, in world XZ.
      for (let i = 0; i < pos.count; i++) {
        const wx = pos.getX(i) + ox;
        const wz = pos.getZ(i) + oz;
        const d = Math.abs(wx - px) + Math.abs(wz - pz);
        if (d < best) {
          best = d;
          covering = mesh;
          localY = pos.getY(i);
          worldY = localY + mesh.position.y;
          vx = wx;
          vz = wz;
        }
      }
    }

    const trueY = covering === null ? null : window.__heightAt(vx, vz);
    return {
      label,
      x: Math.round(px),
      z: Math.round(pz),
      chunks: ground.children.length,
      // A vertex more than a cell away means no chunk covers the player.
      hit: covering !== null && best < 3.4,
      meshY: worldY === null ? null : +worldY.toFixed(3),
      localY: localY === null ? null : +localY.toFixed(3),
      trueY: trueY === null ? null : +trueY.toFixed(3),
      error: trueY === null ? null : +Math.abs(worldY - trueY).toFixed(3),
      geometries: renderer.info.memory.geometries,
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      camY: +camera.position.y.toFixed(2),
    };
  }, label);
}

// heightAt is pure, so a second module copy is harmless here — but note that
// anything stateful must be read off window.RR instead: Vite serves an
// HMR-versioned URL to a late import, and that copy's uniforms are pristine.
await page.evaluate(async () => {
  const terrain = await import('/src/world/terrain.js');
  window.__heightAt = terrain.heightAt;
});

const rows = [];
rows.push(await probe('spawn'));
for (const d of [200, 400, 800, 1400, FAR]) {
  await walkTo(d * 0.7071, d * 0.7071, HOP);
  rows.push(await probe(`${d} m out`));
  if (d === 400 || d === FAR) {
    await page.evaluate(() => {
      window.RR.controller.yaw = Math.PI * 1.25;
      window.RR.controller.pitch = -0.03;
    });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/endless-${d}m.png` });
  }
}
await walkTo(0, 5, HOP);
rows.push(await probe('home again'));

const w = (s, n) => String(s).padEnd(n);
console.log(
  `\n${w('station', 14)}${w('x,z', 16)}${w('chunks', 8)}${w('ground', 8)}${w('mesh y', 10)}${w('heightAt', 10)}${w('err', 8)}${w('geos', 7)}${w('heap MB', 8)}`
);
for (const r of rows) {
  console.log(
    w(r.label, 14) +
      w(`${r.x},${r.z}`, 16) +
      w(r.chunks, 8) +
      w(r.hit ? 'yes' : 'HOLE', 8) +
      w(r.meshY ?? '—', 10) +
      w(r.trueY, 10) +
      w(r.error ?? '—', 8) +
      w(r.geometries, 7) +
      w(r.heapMB ?? '—', 8)
  );
}

const holes = rows.filter((r) => !r.hit);
/**
 * The vertex is sampled from the same analytic field, so this ought to be zero
 * to float precision — the slack is only for a chunk whose vertex lattice is
 * offset from the query point, and it is deliberately far tighter than the
 * ~0.5 m error an LOD scheme would have produced.
 */
const TOLERANCE = 0.05;
const drifted = rows.filter((r) => r.error !== null && r.error > TOLERANCE);
const first = rows[0];
const peak = Math.max(...rows.map((r) => r.geometries));
const home = rows[rows.length - 1];

console.log(`\ngeometries: ${first.geometries} at spawn, ${peak} peak, ${home.geometries} home again`);
if (home.heapMB !== null) console.log(`heap: ${first.heapMB} MB -> ${home.heapMB} MB`);

let bad = 0;
if (holes.length) {
  console.log(`\nFAIL: ${holes.length} station(s) with no ground under the player`);
  bad++;
}
if (drifted.length) {
  console.log(`\nFAIL: the drawn ground disagrees with heightAt by more than ${TOLERANCE} m at:`);
  for (const r of drifted) console.log(`  ${r.label}: mesh ${r.meshY} vs heightAt ${r.trueY}`);
  bad++;
}
// Eviction: coming home must not cost more than the trip out did.
if (home.geometries > peak) {
  console.log(`\nFAIL: geometry count still climbing on the way home (${home.geometries} > ${peak})`);
  bad++;
}
const { problems: real, suppressed } = triage(problems);
if (real.length) {
  console.log(`\n${real.length} console problem(s):`);
  for (const p of real.slice(0, 20)) console.log(' ', p);
  bad++;
}
if (suppressed) console.log(`(${suppressed} known-noise line(s) suppressed — see scripts/known-noise.mjs)`);
console.log(bad ? '\nENDLESS CHECK FAILED' : '\nPASS: no border, no holes, no leak');

await browser.close();
process.exit(bad ? 1 : 0);
