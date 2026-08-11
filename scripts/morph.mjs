import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * Does the surface actually move?
 *
 * The complaint this script exists to answer is that the world feels static —
 * that the only thing with a period short enough to notice is the camera going
 * in and out. A still frame cannot answer that, and neither can `shoot.mjs`,
 * which takes one picture per station. So: park the camera hard against a
 * trunk, against the ground and under the canopy, hold the intensity with the
 * envelope override so every clock keeps running, and take the same frame
 * repeatedly a few seconds apart.
 *
 * Flip between the frames of one series afterwards. If the pixels are the same,
 * the effect does not exist however good the single frame looks.
 *
 *   node scripts/morph.mjs [--level=1] [--gap=2500] [--still]
 *
 * `--still` switches the camera family off. The dolly and the fov drift move
 * every pixel in the frame by themselves, which is enough to make any two shots
 * look different and therefore enough to hide the answer. With the camera
 * pinned, anything that changes between frames changed in the WORLD.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const LEVEL = Number(args.level ?? 1);
const GAP = Number(args.gap ?? 2500);
const STILL = args.still === 'true';
const OUT = STILL ? '.shots/morph-still' : '.shots/morph';
mkdirSync(OUT, { recursive: true });

/**
 * Close enough that the surface fills the frame. That is the whole point — a
 * station five metres back tests the silhouette of the forest, not the skin of
 * anything in it.
 *
 * `hug` means "find the nearest trunk and stand against it", resolved in the
 * page from the collider list. Hand-picked coordinates go stale the moment the
 * world seed or the density field changes, and a bark station that is not
 * actually pointing at bark is worse than no bark station.
 */
const STATIONS = {
  bark: { x: -34, z: -46, yaw: 0, pitch: 0.1, hug: true },
  // Looking down at the floor a couple of paces ahead.
  floor: { x: -34, z: -46, yaw: 1.1, pitch: -0.72 },
  // Up into a canopy, for the pulse.
  canopy: { x: -30, z: -40, yaw: 0.8, pitch: 0.85 },
  // The clearing, for the melt at a distance where whole trees are in frame.
  wide: { x: 0, z: 5, yaw: 0, pitch: -0.02 },
};

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });

const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text());
});
page.on('pageerror', (e) => problems.push(`${e.message}`));

await page.goto('http://127.0.0.1:5180/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2200);
await page.evaluate(() => {
  document.getElementById('toast').style.display = 'none';
  document.getElementById('help').style.display = 'none';
});

for (const [name, at] of Object.entries(STATIONS)) {
  await page.evaluate(
    ({ station, level, still }) => {
      const { director, controller } = window.RR;
      director.seek(190);
      director.switches.camera = !still;
      // The override holds the intensity while leaving uTime, the breath and
      // the wind running. Freezing the clock instead would make every frame
      // identical by construction and prove nothing.
      director.state.override = level;
      director.eased = level;
      let { x, z, yaw } = station;
      if (station.hug) {
        /**
         * Trunk positions straight out of the instance matrices, rather than
         * from a list the app happens to export. Elements 12..14 of a column-
         * major 4x4 are its translation, so this needs no matrix library and
         * cannot go out of date with the world.
         */
        let best = null;
        window.RR.scene.traverse((o) => {
          if (o.name !== 'trunk' || !o.instanceMatrix) return;
          const m = o.instanceMatrix.array;
          for (let i = 0; i < o.count; i++) {
            const tx = m[i * 16 + 12];
            const tz = m[i * 16 + 14];
            const d = Math.hypot(tx - x, tz - z);
            if (d > 1.5 && (!best || d < best.d)) best = { x: tx, z: tz, d };
          }
        });
        if (best) {
          const stand = 1.9;
          const a = Math.atan2(z - best.z, x - best.x);
          x = best.x + Math.cos(a) * stand;
          z = best.z + Math.sin(a) * stand;
          // The controller's yaw convention: this is the heading that faces the
          // trunk from where we now stand.
          yaw = Math.atan2(best.x - x, best.z - z) + Math.PI;
        }
      }
      controller.position.x = x;
      controller.position.z = z;
      controller.velocity.set(0, 0, 0);
      controller.yaw = yaw;
      controller.pitch = station.pitch;
    },
    { station: at, level: LEVEL, still: STILL }
  );
  await page.waitForTimeout(900);
  for (let i = 0; i < 4; i++) {
    await page.screenshot({ path: `${OUT}/${name}-${i}.png` });
    if (i < 3) await page.waitForTimeout(GAP);
  }
  process.stdout.write(`${name}: 4 frames ${GAP}ms apart at level ${LEVEL}\n`);
}

if (problems.length) {
  console.log(`\n${problems.length} console problem(s):`);
  for (const p of problems.slice(0, 20)) console.log(' ', p);
} else {
  console.log('\nno console problems');
}

await browser.close();
