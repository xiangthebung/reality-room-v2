import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { triage } from './known-noise.mjs';

/**
 * Is the fauna the APP builds actually alive?
 *
 * Distinct from `fauna-shot.mjs`, which imports the module itself and drives it
 * from its own loop — useful while main.js belonged to somebody else, but it
 * proves the module works, not that the game runs it. This one touches nothing:
 * it reads `window.RR.fauna`, which is the instance main.js built and ticks.
 *
 * Movement is the whole test — a `fauna.update` that main.js forgot to call
 * would leave every animal posed at t=0 and nothing else in the suite would
 * complain. But the two halves of this menagerie move by completely different
 * means, and testing them the same way gives a confident false answer:
 *
 *   MAMMALS are CPU-driven. Their instance matrices are rewritten each frame,
 *   so a fingerprint of the buffer changes and a stale one is a real fault.
 *   They also stand still on purpose — the deer's whole character is that it
 *   stares at you before it goes — so the window has to be long enough to
 *   outlast a graze. 1.2 s is not; a deer read as dead on the first run of this
 *   script for exactly that reason.
 *
 *   BIRDS, BUTTERFLIES AND MIDGES are drawn entirely by the vertex shader,
 *   which derives the whole flight from `uTime` (`aFlight.z + uTime * aFlight.y`
 *   in fauna/shading.js). Their instance matrices are static BY DESIGN and
 *   always will be. The equivalent check is that the material's `uTime` is
 *   still the same object as the trip's — they are shared, and if a rebuild
 *   ever replaced one with a private copy the flock would freeze while every
 *   buffer-based test kept passing.
 *
 *   node scripts/fauna-wired.mjs [--url=…] [--out=.shots/fauna]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots/fauna');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const raw = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') raw.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => raw.push(`[pageerror] ${e.message}`));

/**
 * DEAFEN THE PAGE TO HOT RELOADS BEFORE IT LOADS.
 *
 * This watches the fauna for five seconds and compares two pose fingerprints to
 * decide whether the animals are actually animating. A save landing in that
 * window rebuilds every instanced mesh underneath the comparison, so the two
 * samples come from different worlds and every layer reports as moving — the
 * exact false PASS this check exists to prevent, on a script that gates
 * `npm run check`. Same guard as play-check.mjs.
 */
await page.routeWebSocket(/.*/, () => {});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(3000);

const inventory = await page.evaluate(() => {
  const f = window.RR.fauna;
  if (!f) return null;
  return {
    wiredIntoRR: true,
    inScene: !!f.group.parent,
    // Capacity is the population; `count` is only what survived this frame's
    // cull, so reporting `count` alone reads as a world with one deer in it.
    herds: f.herds.map(
      (h) => `${h.mesh?.name ?? '?'}: ${h.mesh?.count ?? 0} drawn of ${h.mesh?.instanceMatrix?.count ?? 0}`
    ),
    birds: `${f.birds?.count ?? 0} drawn of ${f.birds?.instanceMatrix?.count ?? 0}`,
    butterflies: `${f.butterflies?.count ?? 0} drawn of ${f.butterflies?.instanceMatrix?.count ?? 0}`,
    midges: f.swarm?.geometry?.attributes?.position?.count ?? 0,
    perchers: f.__perchers?.length ?? 0,
  };
});

/** A cheap fingerprint of a layer's pose: the first few instance matrices. */
const sample = () =>
  page.evaluate(() => {
    const f = window.RR.fauna;
    const grab = (mesh, n = 6) => {
      if (!mesh?.instanceMatrix) return null;
      const a = mesh.instanceMatrix.array;
      let s = 0;
      for (let i = 0; i < Math.min(n * 16, a.length); i++) s += a[i] * (i + 1);
      return +s.toFixed(4);
    };
    const pts = (p) => {
      const a = p?.geometry?.attributes?.position?.array;
      if (!a) return null;
      let s = 0;
      for (let i = 0; i < Math.min(60, a.length); i++) s += a[i] * (i + 1);
      return +s.toFixed(4);
    };
    return {
      birds: grab(f.birds),
      butterflies: grab(f.butterflies),
      swarm: pts(f.swarm),
      ...Object.fromEntries(f.herds.map((h, i) => [h.mesh?.name ?? `herd${i}`, grab(h.mesh)])),
      uTime: window.RR.tripUniforms?.uTime?.value ?? null,
    };
  });

/**
 * Long enough to outlast a graze. The mammal specs give a deer a `watch` of up
 * to a couple of seconds and a territory it wanders inside, so anything under
 * about four seconds is sampling a pose, not a behaviour.
 */
const WATCH_MS = 5000;
const before = await sample();
await page.waitForTimeout(WATCH_MS);
const after = await sample();

console.log('\nfauna as the app builds it');
console.log(JSON.stringify(inventory, null, 2));

/** Layers whose motion lives in the shader; their buffers must NOT change. */
const SHADER_DRIVEN = new Set(['birds', 'butterflies', 'swarm']);

console.log(`\nlayer            how it moves     rewrote buffer in ${WATCH_MS / 1000} s`);
console.log('-'.repeat(56));
const dead = [];
for (const key of Object.keys(before)) {
  if (key === 'uTime') continue;
  const a = before[key];
  const b = after[key];
  const shader = SHADER_DRIVEN.has(key);
  const moved = a !== null && a !== b;
  if (a !== null && !shader && !moved) dead.push(key);
  console.log(
    `${key.padEnd(17)}${(shader ? 'vertex shader' : 'cpu matrices').padEnd(17)}${
      a === null ? 'absent' : moved ? 'yes' : shader ? 'no (correct)' : 'NO'
    }`
  );
}

const clockRan = after.uTime - before.uTime;
console.log(`\nthe trip clock the flyers read advanced ${clockRan.toFixed(2)} s`);
if (clockRan < WATCH_MS / 2000) {
  console.log('FAIL: uTime is not advancing — every shader-driven layer is frozen');
  dead.push('uTime');
}
/**
 * The flyers, tested by looking at them.
 *
 * There is no object identity to assert: `flyerMaterial` injects the trip's
 * shared uniforms inside `onBeforeCompile`, so they land on the compiled
 * program's shader object and never appear on `material.uniforms` at all. An
 * identity check against `material.uniforms.uTime` compares two undefineds and
 * reports a catastrophe that is not happening — it did, on the run before this
 * comment was written.
 *
 * So: hide everything except the flock, hold the camera still, and photograph
 * it twice. If the birds are flying the two frames differ. Nothing else can
 * make them differ, because nothing else is on screen.
 */
/**
 * Two frames being identical is ambiguous: it means "not moving" OR "not on
 * screen", and reporting the first when it is the second is how a working
 * flock gets called dead. So an empty frame is measured explicitly, and a pose
 * that cannot see the layer is skipped rather than failed.
 */
async function look(pose) {
  await page.evaluate((p) => {
    const { controller } = window.RR;
    controller.position.x = p.x;
    controller.position.z = p.z;
    controller.velocity.set(0, 0, 0);
    controller.yaw = p.yaw;
    controller.pitch = p.pitch;
  }, pose);
}

const POSES = [
  { name: 'up from the clearing', x: 0, z: 6, yaw: 0.0, pitch: 0.85 },
  { name: 'level in the wood', x: -34, z: -46, yaw: 1.1, pitch: 0.05 },
  { name: 'up in the wood', x: -30, z: -40, yaw: 0.8, pitch: 0.6 },
];

async function flyerAnimates(layer) {
  for (const pose of POSES) {
    await look(pose);
    await page.evaluate(() => window.RR.probe.all(false));
    await page.waitForTimeout(320);
    const blank = await page.screenshot();
    await page.evaluate((l) => window.RR.probe.only(l), layer);
    await page.waitForTimeout(320);
    const a = await page.screenshot();
    if (a.equals(blank)) continue; // not in frame here; try the next pose
    await page.waitForTimeout(900);
    const b = await page.screenshot();
    return { seen: true, moved: !a.equals(b), where: pose.name };
  }
  return { seen: false, moved: false, where: null };
}

console.log('\nflyer            visible from           animating');
console.log('-'.repeat(56));
for (const layer of ['birds', 'butterflies', 'swarm']) {
  const r = await flyerAnimates(layer);
  console.log(
    `${layer.padEnd(17)}${(r.where ?? 'nowhere tried').padEnd(23)}${
      !r.seen ? 'not on screen' : r.moved ? 'yes' : 'NO'
    }`
  );
  // Never on screen from three sensible poses is its own kind of failure.
  if (!r.seen || !r.moved) dead.push(layer);
}
await page.evaluate(() => window.RR.probe.reset());

// Stand where the animals are rather than at spawn, and look along the ground.
for (const [name, at] of Object.entries({
  clearing: { x: 0, z: 6, yaw: 0.0, pitch: -0.05 },
  wood: { x: -34, z: -46, yaw: 1.1, pitch: 0.0 },
  canopy: { x: -30, z: -40, yaw: 0.8, pitch: 0.7 },
})) {
  await page.evaluate((s) => {
    const { controller } = window.RR;
    controller.position.x = s.x;
    controller.position.z = s.z;
    controller.velocity.set(0, 0, 0);
    controller.yaw = s.yaw;
    controller.pitch = s.pitch;
    document.getElementById('help').style.display = 'none';
    document.getElementById('toast').style.display = 'none';
  }, at);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/wired-${name}.png` });
}

const { problems, suppressed } = triage(raw);
if (problems.length) {
  console.log(`\n${problems.length} console problem(s):`);
  for (const p of problems.slice(0, 15)) console.log(' ', p);
}
if (suppressed) console.log(`(${suppressed} known-noise line(s) suppressed)`);

const bad = !inventory?.wiredIntoRR || !inventory.inScene || dead.length;
if (dead.length) console.log(`\nFAIL: stationary layer(s): ${dead.join(', ')}`);
console.log(bad ? '\nFAUNA CHECK FAILED' : '\nPASS: the animals are wired, in the scene, and moving');

await browser.close();
process.exit(bad ? 1 : 0);
