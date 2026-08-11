import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Look at the animals, in the real app, before main.js knows about them.
 *
 * `buildFauna` is not wired into main.js yet — another agent owns that file —
 * so this script imports the module into the live page and drives it from its
 * own rAF loop. That is not a mock: Vite serves the same module URL main.js's
 * graph would, so the dynamic import gets the SAME instance of living.js and
 * therefore the same `tripUniforms` object the rest of the world is reading.
 * The script asserts that identity before it does anything, because if it ever
 * stopped being true (a versioned HMR URL would do it) every trip-driven shot
 * below would silently be of a sober forest.
 *
 *   node scripts/fauna-shot.mjs [--url=…] [--out=.shots/fauna] [--wait=1100]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots/fauna');
const SETTLE = Number(args.wait ?? 1100);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });

const problems = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') problems.push(`[${t}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

/**
 * DEAFEN THE PAGE TO HOT RELOADS BEFORE IT LOADS.
 *
 * A save landing mid-run reloads the page and every station after it
 * photographs a splash screen. Silent, because a reloaded page has no console
 * problems — the contact sheet just quietly stops being of the wood. Same guard
 * as shoot.mjs, which lost a whole run of twelve to this.
 */
await page.routeWebSocket(/.*/, () => {});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
/**
 * The engine's own signal, because `attachAudio` below FAILS QUIETLY.
 *
 * `fauna.js` guards with `if (!engine?.ready || wildlife) return`, so arriving
 * early does not throw — it builds a fauna with no voices and reports success.
 * The engine became ready between 2 and 3 seconds when this was measured on
 * 2026-08-09, so the 2200 ms that used to be here was losing that coin flip.
 */
await page.waitForFunction(() => window.RR.audio?.ctx != null && window.RR.audio.ready === true, {
  timeout: 25000,
});
await page.waitForTimeout(1000);
await page.evaluate(() => {
  document.getElementById('toast').style.display = 'none';
  document.getElementById('help').style.display = 'none';
});

const wiring = await page.evaluate(async () => {
  const living = await import('/src/trip/living.js');
  const { buildFauna } = await import('/src/world/fauna.js');
  const shared = living.tripUniforms === window.RR.tripUniforms;
  const fauna = buildFauna({ scene: window.RR.scene, seed: 'grove-01', audio: window.RR.audio });
  fauna.setPixelRatio(window.RR.renderer.getPixelRatio());
  fauna.attachAudio(window.RR.audio, window.RR.music);
  window.__fauna = fauna;
  window.__tod = 0.5;
  let last = performance.now();
  const step = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    fauna.update(dt, {
      camera: window.RR.camera,
      tripLevel: window.RR.director.level,
      timeOfDay: window.__tod,
    });
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return { shared, trees: fauna.herds.map((h) => `${h.name}:${h.members.length}`) };
});

if (!wiring.shared) {
  console.log('WARNING: the dynamic import got a SECOND copy of living.js — trip shots are void.');
}
console.log('herds:', wiring.trees.join('  '));

/**
 * Stations. Two rules: at least one that looks up (the flocks are the only
 * thing above the canopy) and at least one deliberately parked a few metres from
 * a creature, since the whole design is about proximity.
 */
const AT = {
  spawn: { x: 0, z: 5, yaw: 0, pitch: 0.06 },
  up: { x: -30, z: -40, yaw: 0.8, pitch: 0.72 },
  sky: { x: 0, z: 5, yaw: 1.9, pitch: 0.55 },
  deep: { x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
  edge: { x: 18, z: 22, yaw: 2.4, pitch: 0.0 },
  stream: { x: 4, z: 20, yaw: 0.1, pitch: -0.12 },
};

const SHOTS = [
  { name: '01-spawn', at: 'spawn', seek: null, note: 'clearing, sober' },
  { name: '02-sky', at: 'sky', seek: null, note: 'flocks over the canopy' },
  { name: '03-up', at: 'up', seek: null, note: 'looking up through the trees' },
  { name: '04-deep', at: 'deep', seek: null, note: 'inside the wood' },
  { name: '05-stream', at: 'stream', seek: null, note: 'the water' },
  { name: '06-close', at: 'closest', seek: null, note: 'parked at the nearest animal' },
  { name: '07-peak-close', at: 'closest', seek: 190, note: 'the same animal, at the peak' },
  { name: '08-peak-sky', at: 'sky', seek: 190, note: 'flocks at the peak' },
  { name: '09-dusk', at: 'stream', seek: null, note: 'fireflies at the water', tod: 0.95 },
  { name: '09b-dusk-glade', at: 'spawn', seek: null, note: 'fireflies in the clearing', tod: 0.95 },
  { name: '10-peak-deep', at: 'deep', seek: 190, note: 'the wood at the peak' },
  { name: '11-shaft', at: 'midges', seek: null, note: 'a midge column in a sun shaft' },
];

for (const shot of SHOTS) {
  await page.evaluate(
    ({ seek, station, at, tod }) => {
      const { director, controller } = window.RR;
      window.__tod = tod ?? 0.5;
      if (seek === null) director.ground();
      else director.seek(seek);
      if (at === 'midges') {
        /**
         * Stand seven metres from the busiest midge column. The swarm's home
         * positions are the shafts' own coordinates (see the column block in
         * fauna.js), so this finds a real one rather than guessing.
         */
        const g = window.__fauna.swarm.geometry;
        const pos = g.attributes.position.array;
        const kind = g.attributes.aKind.array;
        let bx = 0;
        let by = 0;
        let bz = 0;
        for (let i = 0; i < kind.length; i++) {
          if (kind[i] > 0.5) continue;
          bx = pos[i * 3];
          by = pos[i * 3 + 1];
          bz = pos[i * 3 + 2];
          break;
        }
        const a = Math.atan2(bx, bz);
        controller.position.x = bx - Math.sin(a) * 7;
        controller.position.z = bz - Math.cos(a) * 7;
        controller.yaw = a + Math.PI;
        // The column sits four to eight metres up its shaft, seven metres off:
        // half a radian looks at the middle of that range. Deriving it from
        // controller.position.y reads the height of the station we just LEFT.
        controller.pitch = 0.5;
        controller.velocity.set(0, 0, 0);
        void by;
        return;
      }
      if (at === 'closest') {
        /**
         * Find the nearest ground animal and stand nine metres from it,
         * looking at it. Nine because that is outside every flee radius —
         * a station inside one photographs the empty forest it just left.
         */
        let best = null;
        let bestD = 1e9;
        for (const h of window.__fauna.herds) {
          for (const m of h.members) {
            const d = Math.hypot(m.pos.x, m.pos.z);
            if (d < bestD) {
              bestD = d;
              best = m;
            }
          }
        }
        if (best) {
          const a = Math.atan2(best.pos.x, best.pos.z);
          controller.position.x = best.pos.x - Math.sin(a) * 9;
          controller.position.z = best.pos.z - Math.cos(a) * 9;
          // The controller looks down -Z at yaw 0 (see controller.js), so
          // pointing it at something a bearing `a` away is a + π.
          controller.yaw = a + Math.PI;
          controller.pitch = -0.16;
        }
      } else {
        controller.position.x = station.x;
        controller.position.z = station.z;
        controller.yaw = station.yaw;
        controller.pitch = station.pitch;
      }
      controller.velocity.set(0, 0, 0);
    },
    { seek: shot.seek ?? null, station: AT[shot.at] ?? AT.spawn, at: shot.at, tod: shot.tod }
  );
  const mark = problems.length;
  await page.waitForTimeout(SETTLE);
  await page.screenshot({ path: `${OUT}/${shot.name}.png` });
  const fresh = [...new Set(problems.slice(mark))];
  process.stdout.write(
    `${shot.name}  ${shot.note}${fresh.length ? `\n    ⚠ ${fresh[0].slice(0, 100)}` : ''}\n`
  );
}

const stats = await page.evaluate(() => {
  /**
   * COUNTED WITH `autoReset` OFF AROUND ONE HAND-DRIVEN FRAME.
   *
   * `renderer.info` resets at the top of every `renderer.render()` and a frame
   * here is several — world, bright pass, bloom chain, output pass. Read after a
   * frame, as this used to be, it reports the fullscreen output quad, so the
   * "whole frame" line below printed `1 draws, 2 tris` on every run and made the
   * fauna's own triangle count look like the entire world.
   *
   * `fauna-perf.mjs` next door already does this correctly and says why in its
   * header; this file simply never did.
   */
  const info = window.RR.renderer.info;
  info.autoReset = false;
  info.reset();
  window.RR.pipeline.render(1 / 60);
  const r = { calls: info.render.calls, triangles: info.render.triangles };
  info.autoReset = true;

  const f = window.__fauna;
  let tris = 0;
  let drawn = 0;
  const per = [];
  for (const o of f.group.children) {
    if (o.isInstancedMesh) {
      const t = (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
      tris += t * o.count;
      drawn += o.count;
      per.push(`${o.name}=${o.count}×${t}`);
    } else if (o.isPoints) {
      per.push(`${o.name}=${o.geometry.attributes.position.count}pts`);
    }
  }
  return { calls: r.calls, sceneTris: r.triangles, faunaTris: Math.round(tris), drawn, per };
});

writeFileSync(`${OUT}/report.json`, JSON.stringify({ stats, wiring, problems }, null, 2));
console.log('\nfauna:', stats.per.join('  '));
console.log(`fauna triangles ${stats.faunaTris}  |  whole frame: ${stats.calls} draws, ${stats.sceneTris} tris`);
if (problems.length) {
  console.log(`\n${problems.length} console problem(s):`);
  for (const p of problems.slice(0, 30)) console.log(' ', p);
} else {
  console.log('\nno console problems');
}

await browser.close();
