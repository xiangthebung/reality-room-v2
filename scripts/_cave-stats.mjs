import { chromium } from 'playwright';
import { caveAxisPoint, cavesNear, setWorldSeed } from '../src/world/terrain.js';

/**
 * WHAT SHAPE IS THE SYSTEM, IN NUMBERS RATHER THAN IN PICTURES.
 *
 * Every other cave script in here either photographs a passage or asserts one
 * property of it. Neither answers the questions you ask when you are changing
 * the WALK — how much does it turn, how many ways on are there, how big is the
 * biggest space and is any of it out of the light — because those are
 * distributions over the whole system rather than facts about one ring.
 *
 * Reported per seed and summarised across them:
 *
 *   TURNING. Total heading change per 100 m of passage, and the count of
 *   corners over 45 degrees. A worm and a joint walk have the same length and
 *   very different numbers here, and "more twists and turns" is exactly this.
 *
 *   SUBSYSTEMS. Passages per cave, metres of branch against metres of trunk,
 *   and how many junctions a walker actually passes.
 *
 *   SCALE. The tallest floor-to-ceiling anywhere, the widest span, and how many
 *   metres of passage stand over 15 m tall — one enormous ring is a statistic,
 *   a run of them is a chamber.
 *
 *   node scripts/_cave-stats.mjs [--seeds=grove-01,grove-02] [--caves=2]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const SEEDS = (args.seeds ?? 'grove-01,grove-02,grove-03,grove-04').split(',');
const CAVES = Number(args.caves ?? 2);

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
  ],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const problems = [];
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
await page.routeWebSocket(/.*/, () => {});

const all = [];
for (const seed of SEEDS) {
  setWorldSeed(seed);
  const near = cavesNear(0, 0, 900).slice(0, CAVES);
  if (!near.length) continue;
  await page.goto(`${URL}?seed=${seed}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
  await page.click('#enter');
  await page.waitForSelector('#gate.gone', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  for (const c of near) {
    const start = caveAxisPoint(c, c.aOpen - 6, 0);
    await page.evaluate(
      (s) => {
        const { controller, director } = window.RR;
        director.ground();
        controller.keys.clear();
        controller.fly = true;
        controller.position.set(s.x, 60, s.z);
        controller.velocity.set(0, 0, 0);
      },
      { x: start.x, z: start.z }
    );
    /**
     * SETTLE ON THE CAVE BEING BUILT, NOT ON A FRAME COUNT. `prepare` is a
     * sliced generator over several frames and a fixed wait photographs
     * whatever stage it happened to reach — see the note in `_inside.mjs`'s
     * sibling scripts about half-arrived worlds.
     */
    await page
      .waitForFunction((k) => window.RR.caves.caves.get(k)?.ready === true, c.k, {
        timeout: 60000,
        polling: 250,
      })
      .catch(() => {});

    const r = await page.evaluate((k) => {
      const cave = window.RR.caves.caves.get(k);
      if (!cave?.paths) return null;
      const TAU = Math.PI * 2;
      const stat = { paths: cave.paths.length, per: [] };
      for (let pi = 0; pi < cave.paths.length; pi++) {
        const p = cave.paths[pi];
        const n = p.x.length;
        let len = 0;
        let turn = 0;
        let corners = 0;
        let prevH = null;
        /**
         * Heading sampled every 4 m rather than every ring. At 0.72 m the ring
         * step is finer than the displacement on the centre line, so a per-ring
         * sum measures the resample's own wobble and reports a straight tube as
         * turning 300 degrees per 100 m.
         */
        const STRIDE = Math.max(1, Math.round(4 / 0.72));
        let run = 0;
        for (let i = 1; i < n; i++) {
          len += Math.hypot(p.x[i] - p.x[i - 1], p.y[i] - p.y[i - 1], p.z[i] - p.z[i - 1]);
          if (i % STRIDE) continue;
          const a = i - STRIDE;
          const h = Math.atan2(p.z[i] - p.z[a], p.x[i] - p.x[a]);
          if (prevH !== null) {
            const d = Math.abs(((h - prevH + Math.PI) % TAU + TAU) % TAU - Math.PI);
            turn += d;
            run += d;
            // A corner is turning accumulated over a short distance, not one
            // sample: a 90-degree joint change is spread over the spline's own
            // 8-14 m and never appears as one big step.
            if (run > 0.785) {
              corners++;
              run = 0;
            }
          } else run = 0;
          prevH = h;
        }
        let tall = 0;
        let wide = 0;
        let tallM = 0;
        let vastM = 0;
        for (let i = 1; i < n; i++) {
          const step = Math.hypot(p.x[i] - p.x[i - 1], p.y[i] - p.y[i - 1], p.z[i] - p.z[i - 1]);
          const h = p.r[i] * (p.t[i] + p.f[i]);
          const w = 2 * p.r[i] * p.w[i];
          if (h > tall) tall = h;
          if (w > wide) wide = w;
          if (h > 15) tallM += step;
          if (h > 25) vastM += step;
        }
        stat.per.push({
          pi,
          len,
          turnPer100: len > 1 ? (turn * 180) / Math.PI / (len / 100) : 0,
          corners,
          tall,
          wide,
          tallM,
          vastM,
        });
      }
      /**
       * DOES THE PASSAGE COME BACK ON ITSELF, AND HOW BADLY.
       *
       * Two different questions, and only one of them is a bug. OVERLAP is two
       * rings whose sections share volume — a hole in the wall with the back of
       * another wall behind it, which is what the walk's clash test exists to
       * reject. STACKING is two rings that are far apart in Y and near in PLAN,
       * which is a multi-level system and is what real caves do; it is only a
       * hazard because several things in this project find geometry by
       * horizontal distance alone.
       */
      /**
       * ALONG THE LINE, NOT IN RING INDEX, AND THAT IS NOT A DETAIL.
       *
       * The first version of this counted any pair forty rings apart whose
       * sections shared volume, and it reported a chamber as a fault. A hall is
       * 35 m of half-width; forty rings is 29 m of line; so the passage walking
       * out of its own chamber is inside the chamber's footprint by
       * construction, and the metric scored the seeds with the biggest halls
       * worst. It read as an overlap regression caused by making the chambers
       * bigger, which is exactly backwards.
       *
       * A crossing is two parts of the line that are near in SPACE and far along
       * the LINE, and "far" has to be measured against how big they are — twice
       * the two half-widths plus twenty metres. Below that they are the same
       * space seen twice.
       */
      let overlap = 0;
      let stacked = 0;
      let worst = null;
      for (let pi = 0; pi < cave.paths.length; pi++) {
        const p = cave.paths[pi];
        const n = p.x.length;
        const al = p.along;
        if (!al) continue;
        for (let i = 0; i < n; i += 4) {
          for (let j = i + 20; j < n; j += 4) {
            const dx = p.x[i] - p.x[j];
            const dy = p.y[i] - p.y[j];
            const dz = p.z[i] - p.z[j];
            const reach = p.r[i] * p.w[i] + p.r[j] * p.w[j];
            if (al[j] - al[i] < reach * 2 + 20) continue;
            if (dx * dx + dy * dy + dz * dz < reach * reach) {
              overlap++;
              const d = Math.hypot(dx, dy, dz);
              if (worst === null || reach - d > worst.by) {
                worst = {
                  pi,
                  i,
                  j,
                  by: reach - d,
                  d: +d.toFixed(1),
                  reach: +reach.toFixed(1),
                  along: +(al[j] - al[i]).toFixed(0),
                  dy: +dy.toFixed(1),
                };
              }
            }
            if (dx * dx + dz * dz < reach * reach && Math.abs(dy) > 6) stacked++;
          }
        }
      }
      const trunk = stat.per[0];
      const branchLen = stat.per.slice(1).reduce((s, x) => s + x.len, 0);
      return {
        paths: stat.paths,
        trunkLen: trunk.len,
        branchLen,
        totalLen: trunk.len + branchLen,
        turnPer100: trunk.turnPer100,
        corners: trunk.corners,
        tall: Math.max(...stat.per.map((x) => x.tall)),
        wide: Math.max(...stat.per.map((x) => x.wide)),
        tallM: stat.per.reduce((s, x) => s + x.tallM, 0),
        vastM: stat.per.reduce((s, x) => s + x.vastM, 0),
        blocks: cave.blocks.length,
        tris: cave.mesh ? cave.mesh.geometry.index.count / 3 : 0,
        overlap,
        stacked,
        worst,
      };
    }, c.k);
    if (!r) {
      console.log(`${seed} k=${c.k}  NOT BUILT`);
      continue;
    }
    all.push(r);
    console.log(
      `${seed} k=${String(c.k).padStart(2)}  ${r.paths} passages  ` +
        `${r.totalLen.toFixed(0)} m (${r.branchLen.toFixed(0)} branch)  ` +
        `turn ${r.turnPer100.toFixed(0)} deg/100m  ${r.corners} corners  ` +
        `tallest ${r.tall.toFixed(1)} m  widest ${r.wide.toFixed(1)} m  ` +
        `${r.tallM.toFixed(0)} m over 15 m tall, ${r.vastM.toFixed(0)} m over 25  ` +
        `${r.tris} tris  overlap ${r.overlap} stacked ${r.stacked}` +
        (r.worst ? `
    worst: p${r.worst.pi} rings ${r.worst.i}-${r.worst.j}  ${r.worst.along} m apart along the line, ${r.worst.d} m apart in space against ${r.worst.reach} m of section (dy ${r.worst.dy})` : '')
    );
  }
}

const mean = (f) => (all.length ? all.reduce((s, x) => s + f(x), 0) / all.length : 0);
console.log(
  `\n${all.length} caves:  ` +
    `${mean((x) => x.paths).toFixed(1)} passages  ` +
    `${mean((x) => x.totalLen).toFixed(0)} m  ` +
    `turn ${mean((x) => x.turnPer100).toFixed(0)} deg/100m  ` +
    `${mean((x) => x.corners).toFixed(1)} corners  ` +
    `tallest ${mean((x) => x.tall).toFixed(1)} m (max ${Math.max(...all.map((x) => x.tall)).toFixed(1)})  ` +
    `${mean((x) => x.tallM).toFixed(0)} m over 15 m tall  ` +
    `${mean((x) => x.vastM).toFixed(0)} m over 25  ` +
    `overlap ${mean((x) => x.overlap).toFixed(1)}  stacked ${mean((x) => x.stacked).toFixed(1)}`
);
if (problems.length) console.log(`\npage errors:\n  ${problems.join('\n  ')}`);
await browser.close();
