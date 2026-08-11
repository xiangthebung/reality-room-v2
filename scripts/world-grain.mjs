import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * What is striping the open ground at 400 m?
 *
 * Seen from the spawn clearing the ground reads fine, but on a long open
 * hillside it carries broad dark bands running along the world axes, plus a
 * fizz that resolves into blobs only in the last few metres. Two candidates,
 * and they are separable by rewriting one line of terrain.js in flight — the
 * page is otherwise byte-identical, and the repo is not touched.
 *
 *   grain    the per-vertex mottle is `noise2(x·0.62)` plus `noise2(x·1.7)`.
 *            `noise2` is value noise on an INTEGER lattice, so 0.62 puts its
 *            lattice pitch at 1.613 m — and the mesh samples it every 1.6 m.
 *            Sampling a lattice at 0.99 of its own pitch does not give you
 *            mottle, it gives you a beat with a period of 1/(1−0.992) = 125
 *            vertices, or 200 m. That is a stripe, not a texture.
 *
 *   cell     the streamed chunks use exactly 1.6 m where the old 380 m plate
 *            used 380/238 = 1.5966 m. If the striping is a property of the new
 *            spacing rather than of the grain, going back to the old spacing
 *            must remove it.
 *
 * Run it and look at the three images.
 */

const OUT = resolve(process.cwd(), '.shots/world-grain');
mkdirSync(OUT, { recursive: true });

const STATION = { x: 400, z: 0, yaw: Math.PI / 2, pitch: 0.0 };

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist'],
});

async function shoot(name, file, rewrite) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  await page.route('**/@vite/client', (r) => r.abort());
  if (rewrite) {
    // terrain.js is fetched twice — once by the page and once by the worker —
    // and both must get the same edit or the seams would disagree.
    await page.route(`**/src/world/${file}*`, async (route) => {
      const res = await route.fetch();
      const src = await res.text();
      const body = rewrite(src);
      if (body === src) throw new Error(`rewrite of ${file} matched nothing`);
      await route.fulfill({ response: res, body });
    });
  }
  await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
  await page.evaluate(
    async (s) => {
      document.getElementById('gate').classList.add('gone');
      document.getElementById('toast').style.display = 'none';
      document.getElementById('help').style.display = 'none';
      const R = window.RR;
      R.probe.freeze(true);
      R.pipeline.trailEnabled = false;
      R.controller.position.x = s.x;
      R.controller.position.z = s.z;
      R.controller.yaw = s.yaw;
      R.controller.pitch = s.pitch;
      R.controller.velocity.set(0, 0, 0);
      R.controller.applyToCamera();
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      for (let i = 0; i < 500; i++) {
        await raf();
        if (R.forest.groundField.pending === 0 && i > 10) break;
      }
      R.director.ground();
      for (let i = 0; i < 30; i++) R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
      R.tripUniforms.uWind.value.set(11.5, 17.4);
      R.atmosphere.follow(R.camera);
      R.renderer.shadowMap.needsUpdate = true;
      R.forest.cull(R.camera, true);
      for (let i = 0; i < 3; i++) R.pipeline.render(1 / 60);
    },
    STATION
  );
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${name}`);
  await page.close();
}

await shoot('a-asbuilt', null, null);

// Keep everything else — the biome blend, the altitude desaturation — and
// remove only the two high-frequency mottle octaves.
await shoot('b-nograin', 'terrain.js', (src) =>
  src.replace('tmp.offsetHSL(grain * 0.035, grain * 0.1, grain * 0.16);', 'void grain;')
);

/**
 * A different cell size, still tiling exactly. 128/85 = 1.5059 m, at which
 * `noise2(x·0.62)` is sampled 0.9337 of the way across its own lattice cell and
 * the beat period falls from 200 m to 22.7 m. If the bands are the beat, this
 * turns them from a handful of huge stripes into a dense fine pattern; if they
 * are something else, it changes nothing about them.
 */
await shoot('c-cell1_51', 'ground.js', (src) => src.replace('const SEG = 80;', 'const SEG = 85;'));

await browser.close();
console.log(`\nwritten to ${OUT}`);
