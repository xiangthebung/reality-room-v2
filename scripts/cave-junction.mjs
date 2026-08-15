import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { cavesNear, setWorldSeed } from '../src/world/terrain.js';
import { caveReady } from './_cave-ready.mjs';

/**
 * WHAT A JUNCTION LOOKS LIKE FROM THE PASSAGE — the half of the report that is
 * not a number.
 *
 * `cave-branch` answers "can the body get in", which is a distance and can be
 * gated. It cannot answer "does that read as a way on", and the two failed
 * together for the same reason: a hole sized at half the bore behind it, cut at
 * the widest point of the parent's outline, which in a keyhole or a chamber is
 * up in the ceiling flare. From the floor that is a dark patch on a wall.
 *
 * So this stands where a player meets each junction — on the main line, a few
 * metres short of it, at eye height, looking at the mouth — and photographs it.
 * One frame per junction, named for the seed, the cave and the branch.
 *
 *   node scripts/cave-junction.mjs [--seeds=grove-01] [--caves=1] [--back=7]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const SEEDS = (args.seeds ?? 'grove-01').split(',');
const CAVES = Number(args.caves ?? 1);
/** How far back down the main passage to stand, in metres. */
const BACK = Number(args.back ?? 7);
const OUT = resolve(process.cwd(), args.out ?? '.shots/junction');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
/** Junctions with a hole in them, for the exit code. */
const leaks = [];
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
await page.routeWebSocket(/.*/, () => {});

for (const seed of SEEDS) {
  setWorldSeed(seed);
  const near = cavesNear(0, 0, 900).slice(0, CAVES);
  if (!near.length) continue;
  await page.goto(`${URL}?seed=${seed}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
  await page.click('#enter');
  await page.waitForSelector('#gate.gone', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    for (const id of ['toast', 'help', 'hud']) {
      const e = document.getElementById(id);
      if (e) e.style.display = 'none';
    }
  });

  for (const c of near) {
    await page.evaluate(
      (s) => {
        const { controller, director } = window.RR;
        director.ground();
        controller.keys.clear();
        controller.fly = true;
        controller.position.set(s.x, 80, s.z);
        controller.velocity.set(0, 0, 0);
      },
      { x: c.x, z: c.z }
    );
    await caveReady(page, c.k);

    const count = await page.evaluate((k) => window.RR.caves.caves.get(k)?.paths?.length ?? 0, c.k);
    for (let pi = 1; pi < count; pi++) {
      const info = await page.evaluate(
        async ({ k, pi, back }) => {
          const R = window.RR;
          const raf = () => new Promise((r) => requestAnimationFrame(r));
          const cave = R.caves.caves.get(k);
          const main = cave.paths[0];
          const br = cave.paths[pi];
          const base = br.base;
          /**
           * BACK DOWN THE PASSAGE, NOT AT THE JUNCTION RING.
           *
           * Standing on the junction puts the mouth at ninety degrees and half
           * out of frame; a junction is something you SEE COMING, and the whole
           * question is whether you do. Backing off along the main line by a
           * fixed number of metres — whichever direction the passage runs — is
           * where a player first has it in view.
           */
          const step = Math.hypot(main.x[1] - main.x[0], main.z[1] - main.z[0]) || 0.72;
          const off = Math.max(1, Math.round(back / step));
          const at = Math.max(0, base - off);
          const floor = main.y[at] - main.r[at] * main.f[at];
          R.controller.fly = true;
          R.controller.keys.clear();
          R.controller.position.set(main.x[at], floor + 1.65, main.z[at]);
          R.controller.velocity.set(0, 0, 0);
          R.controller.yaw = Math.atan2(-(br.x[1] - main.x[at]), -(br.z[1] - main.z[at]));
          R.controller.pitch = 0;
          R.controller.applyToCamera();
          for (let i = 0; i < 12; i++) await raf();

          /**
           * DOES THE OPENING SHOW DAYLIGHT — asked of the geometry, not of the
           * picture.
           *
           * This is the failure mode the whole junction has: the tube is drawn
           * single-sided with inward normals, so a hole in it is not a dark
           * patch, it is a window straight out of the mountain — and the two
           * previous versions of the hole arithmetic each shipped one. Nothing
           * gates it. `cave-seal` sounds like it should and does not; it is
           * about the rain and the interaction prompts, both of which are
           * decided by code that has no idea caves exist.
           *
           * A PIXEL TEST WAS THE OBVIOUS INSTRUMENT AND IS THE WRONG ONE. What
           * a leak looks like depends on the hour, the weather and whatever
           * happens to be growing outside, and the fungi down here are lit in
           * colours that overlap a hillside's. So the question is put to the
           * mesh: cast a ray through every cell of a grid across the frame and
           * ask whether it ever meets the cave shell. The shell is `FrontSide`
           * with its normals facing the axis, which is exactly what makes this
           * work — from inside, every direction that is rock returns a hit, and
           * a direction that returns nothing is a direction with no rock in it.
           *
           * There is no lighting, no exposure and no sky in the answer, and it
           * is the same surface the player is looking at.
           */
          const sweep = () => {
            const mesh = cave.mesh;
            if (!mesh) return { miss: 0, total: 0, cells: [], near: 0 };
            const cam = R.camera;
            cam.updateMatrixWorld(true);
            const rc = new R.THREE.Raycaster();
            rc.far = 6000;
            const dir = new R.THREE.Vector3();
            const CX = 32;
            const CY = 18;
            let miss = 0;
            let near = 0;
            const cells = [];
            for (let iy = 0; iy < CY; iy++) {
              for (let ix = 0; ix < CX; ix++) {
                dir
                  .set(((ix + 0.5) / CX) * 2 - 1, ((iy + 0.5) / CY) * 2 - 1, 0.5)
                  .unproject(cam)
                  .sub(cam.position)
                  .normalize();
                rc.set(cam.position, dir);
                if (rc.intersectObject(mesh, false).length === 0) {
                  miss++;
                  cells.push(`${ix},${iy}`);
                  /**
                   * WHERE THE RAY LEFT THE CAVE, which is what tells a hole in
                   * a wall from the pinhole at the end of a passage.
                   *
                   * `closeEnd` runs every terminus down to a 2 cm ring rather
                   * than to a point, so the axis of every passage in the world
                   * ends in a two-centimetre aperture — invisible at forty
                   * metres and a guaranteed miss for a ray aimed exactly down
                   * it. Re-casting from further along does NOT separate the two,
                   * because a point inside the branch is a point whose ray
                   * leaves by the same aperture; the question has to be asked of
                   * the passage rather than of the mesh. So the ray is marched
                   * and the first point that no section contains is the place it
                   * got out. Near the camera is a hole in the wall; sixty metres
                   * away down the bore is a terminus doing what termini do.
                   */
                  let out = -1;
                  for (let d = 2; d <= 120 && out < 0; d += 2) {
                    const px = cam.position.x + dir.x * d;
                    const py = cam.position.y + dir.y * d;
                    const pz = cam.position.z + dir.z * d;
                    let held = false;
                    for (const pth of cave.paths) {
                      const pn = pth.x.length;
                      let bd = Infinity;
                      let bidx = 0;
                      for (let q = 0; q < pn; q++) {
                        const e = (pth.x[q] - px) ** 2 + (pth.y[q] - py) ** 2 + (pth.z[q] - pz) ** 2;
                        if (e < bd) {
                          bd = e;
                          bidx = q;
                        }
                      }
                      const horiz = Math.hypot(pth.x[bidx] - px, pth.z[bidx] - pz);
                      if (horiz < pth.r[bidx] * pth.w[bidx] + 1) {
                        held = true;
                        break;
                      }
                    }
                    if (!held) out = d;
                  }
                  if (out >= 0 && out <= 20) near++;
                  cells.push(`out@${out}m`);
                }
              }
            }
            return { miss, total: CX * CY, cells: cells.slice(0, 12), near };
          };
          const leak = sweep();
          /**
           * THE CONTROL, AND IT IS NOT OPTIONAL. Turned round, looking back
           * down the passage the player came along, there is no junction in the
           * frame — so anything this finds is something the sweep counts
           * everywhere and not a fact about the opening.
           */
          R.controller.yaw += Math.PI;
          R.controller.applyToCamera();
          for (let i = 0; i < 3; i++) await raf();
          leak.control = sweep().miss;
          R.controller.yaw -= Math.PI;
          R.controller.applyToCamera();
          for (let i = 0; i < 3; i++) await raf();

          return {
            base,
            len: br.along ? br.along[Math.min(br.endRing ?? 0, br.along.length - 1)] : 0,
            bore: 2 * br.r[0] * br.w[0],
            dist: Math.hypot(br.x[1] - main.x[at], br.z[1] - main.z[at]),
            leak,
            blind: br.blind ?? 0,
          };
        },
        { k: c.k, pi, back: BACK }
      );
      const name = `${seed}-k${c.k}-br${pi}.png`;
      await page.screenshot({ path: `${OUT}/${name}` });
      const l = info.leak;
      /**
       * ONLY A NEAR ESCAPE COUNTS. `near` is rays that left the passage within
       * twenty metres, which at a station standing ten to fifteen metres back is
       * "at the opening". The rest are the two-centimetre aperture `closeEnd`
       * leaves on the axis of every terminus in the world, sixty metres down the
       * bore — a real hole and not this script's business, and counting it would
       * make the gate fire on every straight branch ever built.
       */
      if (l.near) leaks.push({ name, ...l });
      console.log(
        `${name}  junction at ring ${info.base}, ${info.dist.toFixed(1)} m away, ` +
          `bore ${info.bore.toFixed(1)} m wide, ${info.len.toFixed(0)} m of passage behind it` +
          (l.miss
            ? `
    ${l.near ? 'LEAK' : 'open'}: ${l.miss} of ${l.total} rays met no rock, ${l.near} of them ` +
              `escaping within 20 m; control looking back ${l.control} — ${l.cells.join(' ')}`
            : `  sealed (${l.total} rays)`)
      );
    }
  }
}

if (leaks.length) {
  console.log(
    `\nFAIL: ${leaks.length} junction(s) show a direction with no rock in it, escaping within ` +
      `20 m of the opening — ${leaks.map((l) => `${l.name} (${l.near}/${l.total})`).join(', ')}`
  );
  process.exitCode = 1;
} else {
  console.log('\nPASS: every junction is a hole in a wall and not a hole in the mountain');
}
if (problems.length) console.log(`\npage errors:\n  ${problems.join('\n  ')}`);
await browser.close();
