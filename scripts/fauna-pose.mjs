import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Portraits.
 *
 * `fauna-shot.mjs` photographs the system as it actually behaves, which is the
 * right test for whether the wood feels inhabited and completely useless for
 * whether a deer is a good deer — the animals are shy on purpose, so the honest
 * shot is usually of the empty forest they just left.
 *
 * This one pins one of each species in front of the camera in the clearing,
 * holds a chosen state, and photographs them from four metres. Anything wrong
 * with the geometry, the gait, the head tracking or the coat is visible here in
 * one frame and effectively invisible everywhere else.
 *
 *   node scripts/fauna-pose.mjs [--url=…] [--out=.shots/fauna-pose]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots/fauna-pose');
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
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
// A Vite full-reload mid-run wipes the injected fauna and every shot after it
// is silently of a forest with no animals in it. Loud, because it is the one
// failure this script cannot detect from the pictures.
let loads = 0;
page.on('load', () => {
  loads++;
  if (loads > 1) console.log('*** PAGE RELOADED — everything after this point is void ***');
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2000);
await page.evaluate(() => {
  document.getElementById('toast').style.display = 'none';
  document.getElementById('help').style.display = 'none';
});

await page.evaluate(async () => {
  const { buildFauna } = await import('/src/world/fauna.js');
  const { heightAt } = await import('/src/world/terrain.js');
  const fauna = buildFauna({ scene: window.RR.scene, seed: 'grove-01' });
  fauna.setPixelRatio(window.RR.renderer.getPixelRatio());
  window.__fauna = fauna;
  window.__heightAt = heightAt;
  window.__pose = null;
  window.__tod = 0.5;

  let last = performance.now();
  const step = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const pose = window.__pose;
    if (pose && pose.bird !== undefined) {
      // Pin one percher in front of the camera. It will still decide to flush
      // if you are inside its startle radius — which is the point of the
      // 'take-off' portrait — and the watcher at a high trip level will not.
      const p = fauna.__perchers[pose.bird];
      p.pos.set(pose.x, heightAt(pose.x, pose.z) + pose.y, pose.z);
      p.home.copy(p.pos);
      p.yaw = pose.yaw;
      if (pose.hold) {
        p.state = 'perch';
        p.timer = 9;
      }
    }
    if (pose && pose.name) {
      // Pin BEFORE the update, so the matrices written this frame are the
      // pinned ones. The state machine still runs; it is simply overruled.
      for (const h of fauna.herds) {
        h.members.forEach((m, i) => {
          if (h.name !== pose.name || i !== 0) {
            // Everything else goes a very long way away so it cannot wander
            // into the portrait.
            m.pos.set(600, 0, 600);
            return;
          }
          m.pos.set(pose.x, heightAt(pose.x, pose.z), pose.z);
          m.anchor.copy(m.pos);
          m.target.copy(m.pos);
          m.yaw = pose.yaw;
          m.state = pose.state;
          m.timer = 99;
          if (pose.state === 'bolt') {
            m.speed = 6;
            m.target.set(pose.x + 40, 0, pose.z);
          }
          if (pose.antler !== undefined) m.antler = pose.antler;
        });
      }
    }
    fauna.update(dt, {
      camera: window.RR.camera,
      tripLevel: window.RR.director.level,
      timeOfDay: window.__tod,
    });
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
});

/**
 * Portraits are taken in the clearing, at a fixed spot, with the sun coming
 * from the same side every time — so any difference between two of these is a
 * difference in the animal.
 */
const CAM = { x: -7, z: 4 };

const SHOTS = [
  { name: '01-stag', species: 'deer', at: 5.5, yaw: 1.5, state: 'watch', antler: 1, pitch: -0.02 },
  { name: '02-doe', species: 'deer', at: 5.5, yaw: 1.5, state: 'watch', antler: 0, pitch: -0.02 },
  { name: '03-stag-front', species: 'deer', at: 5, yaw: 3.14, state: 'watch', antler: 1, pitch: -0.02 },
  { name: '04-stag-graze', species: 'deer', at: 5.5, yaw: 1.5, state: 'graze', antler: 1, pitch: -0.02 },
  { name: '05-stag-bolt', species: 'deer', at: 7, yaw: 1.5, state: 'bolt', antler: 1, pitch: -0.02 },
  { name: '06-rabbit', species: 'rabbit', at: 2.2, yaw: 1.5, state: 'watch', pitch: -0.32 },
  { name: '07-rabbit-bolt', species: 'rabbit', at: 2.6, yaw: 1.5, state: 'bolt', pitch: -0.3 },
  { name: '08-squirrel', species: 'squirrel', at: 1.7, yaw: 1.5, state: 'watch', pitch: -0.42 },
  { name: '09-stag-peak', species: 'deer', at: 5.5, yaw: 1.5, state: 'watch', antler: 1, pitch: -0.02, seek: 190 },
  { name: '10-rabbit-peak', species: 'rabbit', at: 2.2, yaw: 1.5, state: 'watch', pitch: -0.32, seek: 190 },
  { name: '11-percher', bird: 1, at: 11, up: 2.2, yaw: 1.4, hold: true, pitch: 0.13 },
  { name: '12-flush', bird: 2, at: 4.5, up: 1.6, yaw: 1.4, pitch: 0.05 },
  { name: '13-watcher', bird: 0, at: 3.4, up: 1.3, yaw: 0, pitch: 0.0, seek: 190 },
  { name: '14-flock', flock: true, pitch: 0.75 },
  { name: '15-flock-b', flock: true, pitch: 0.75, yaw: 2.4 },
];

for (const s of SHOTS) {
  await page.evaluate(
    ({ shot, cam }) => {
      const { director, controller } = window.RR;
      if (shot.seek === undefined) director.ground();
      else director.seek(shot.seek);
      controller.position.x = cam.x;
      controller.position.z = cam.z;
      controller.velocity.set(0, 0, 0);
      /**
       * The controller's forward is (-sin yaw, 0, -cos yaw) — see controller.js
       * — so yaw 0 looks down NEGATIVE Z, while a creature's own yaw 0 faces
       * positive Z. The two conventions are each internally consistent and they
       * are opposite, which is exactly the sort of thing that puts a portrait
       * subject behind the photographer.
       */
      controller.yaw = 0;
      controller.pitch = shot.pitch;

      if (shot.flock) {
        // Stand in the clearing and look up. Flock zero is anchored over it for
        // exactly this reason — see the flock block in fauna.js.
        controller.position.x = 0;
        controller.position.z = 4;
        controller.yaw = shot.yaw ?? 0;
        window.__pose = null;
        return;
      }

      window.__pose = shot.bird !== undefined
        ? {
            bird: shot.bird,
            x: cam.x,
            y: shot.up,
            z: cam.z - shot.at,
            yaw: shot.yaw,
            hold: shot.hold,
          }
        : {
            name: shot.species,
            x: cam.x,
            z: cam.z - shot.at,
            yaw: shot.yaw,
            state: shot.state,
            antler: shot.antler,
          };
    },
    { shot: s, cam: CAM }
  );
  problems.length = 0;
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${OUT}/${s.name}.png` });
  const uniq = [...new Set(problems)];
  process.stdout.write(`${s.name}${uniq.length ? `   ⚠ ${uniq[0].slice(0, 90)}` : ''}\n`);
}

writeFileSync(`${OUT}/report.json`, JSON.stringify({ problems }, null, 2));
console.log(problems.length ? `\n${problems.length} problem(s):\n  ${problems.slice(0, 20).join('\n  ')}` : '\nno console problems');
await browser.close();
