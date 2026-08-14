import { chromium } from 'playwright';
import { cavesNear, setWorldSeed } from '../src/world/terrain.js';
import { caveReady } from './_cave-ready.mjs';

/**
 * Does the floor you stand on match the floor you can see?
 *
 * `caveFloorUnder` answers from the centre line; the mesh is swept along the
 * same line, so the two are supposed to agree everywhere a body can stand. When
 * the analytic floor is ABOVE the rock, the player hovers over a surface they
 * can see under their feet — the "it just floats me in midair" complaint. When
 * it is below, they wade through the floor.
 *
 * Samples a grid ACROSS the passage rather than only down its axis, because
 * every disagreement this has actually found is off-axis: overlapping passages
 * at a junction, and the containment test reaching 35% past the wall.
 *
 * The column is intersected by hand against the index buffer — THREE.Raycaster
 * is not used because the page does not export three — and the surface NEAREST
 * the analytic floor is the answer, not the first one under a ray. See
 * `nearestTo`: the ray origin was the last guess left in this script and it was
 * worth up to 3.9 m of invented disagreement.
 *
 *   node scripts/cave-floor.mjs [--seed=grove-01] [--tol=0.45]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const SEED = args.seed ?? 'grove-01';
const TOL = Number(args.tol ?? 0.45);
const CAVES = Number(args.caves ?? 2);

setWorldSeed(SEED);
const near = cavesNear(0, 0, 900);

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.routeWebSocket(/.*/, () => {});
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForSelector('#gate.gone', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2000);

let worstHover = 0;
let totalBad = 0;
let totalHover = 0;
let totalWade = 0;
let blockN = 0;
let blockSum = 0;
let blockHover = 0;
let blockWade = 0;
let blockWorstHover = 0;
let blockWorstWade = 0;
for (const c of near.slice(0, CAVES)) {
  await page.evaluate(
    (s) => {
      const { controller, director } = window.RR;
      director.ground();
      controller.keys.clear();
      controller.fly = true;
      controller.position.set(s.x, 60, s.z);
      controller.velocity.set(0, 0, 0);
    },
    { x: c.x, z: c.z }
  );
  /**
   * WAIT FOR THE CAVE, NOT FOR A NUMBER OF SECONDS.
   *
   * This was `waitForTimeout(3500)`, which is a guess about how long a build
   * takes, and a build takes as long as the passage is. The fixed wait expired
   * mid-sweep, `cave.mesh` was null, and the script printed "k=-1: not built"
   * and moved on — the failure `_cave-ready.mjs` exists to describe.
   */
  await caveReady(page, c.k);

  const report = await page.evaluate(
    async ({ k, tol }) => {
      const R = window.RR;
      const mod = await import('/src/world/caves.js');
      const cave = R.caves.caves.get(k);
      if (!cave?.paths || !cave.mesh) return null;
      const geo = cave.mesh.geometry;
      const pos = geo.attributes.position.array;
      const idx = geo.index.array;
      const ox = cave.mesh.position.x;
      const oy = cave.mesh.position.y;
      const oz = cave.mesh.position.z;
      /**
       * Vertices belonging to the swept lattice; anything past is loose rock.
       *
       * THE VERTICES-PER-RING CAME FROM THE MODULE AND NOT FROM MEMORY, and
       * that is the whole of this comment. It was a literal 24, which was
       * `RADIAL` when this script was written and has been 44 since the mesh was
       * sharpened. The bound was therefore 45% short: every triangle belonging
       * to the back half of the lattice was classed as loose rock and skipped,
       * so in the deep half of a passage `castDown` was answering from whatever
       * EARLIER ring's geometry happened to overlap that column — which in a
       * chamber is a surface metres below the floor the body is standing on. The
       * script reported that as the body hovering, and the error grew with the
       * length of the passage, which is exactly the wrong way round for a test
       * whose job is to gate passages getting longer.
       */
      const perRing = mod.CAVE_RADIAL;
      let lattice = 0;
      for (const p of cave.paths) lattice += p.x.length;
      lattice = (lattice + cave._hood + 1) * perRing;

      /**
       * THE SURFACE NEAREST A HEIGHT, NOT THE FIRST SURFACE UNDER A RAY, AND THE
       * DIFFERENCE WAS THIS SCRIPT'S THREE WORST READINGS.
       *
       * `castDown` started its ray at the RING'S AXIS and returned the topmost
       * triangle below it. That is the wrong question twice over. The body does
       * not stand at the axis — in a seven-metre chamber the axis is four metres
       * over its head — and a passage that folds back over itself puts ANOTHER
       * strand of the same tube in between. So the ray was leaving the void the
       * body is standing in, crossing into the strand above, and reporting that
       * strand's floor as "the rock under your feet".
       *
       * Measured, on grove-01 k=0, the three headline rows of the old report:
       *
       *   p0 ring 671 across 0.4    old gap -3.94    drawn floor 0.04 m away
       *   p0 ring 692 across -0.75  old gap -3.65    drawn floor 0.22 m away
       *   p0 ring 689 across -0.4   old gap -2.63    drawn floor 0.05 m away
       *
       * Every one of those columns has the passage's own floor drawn within a few
       * CENTIMETRES of where `caveFloorUnder` puts the body, and a slab of the
       * overlying strand a metre or two above its head. That is a low ceiling —
       * `cave-roof` and MIN_HEAD's business — and this script was reporting it as
       * four metres of the body being buried in stone. 200 disagreements on that
       * cave; only 140 of them were the floor at all.
       *
       * The claim in the header is "the floor you stand on matches the floor you
       * can see", so the test is that claim and nothing else: is there a drawn
       * surface AT the height the body is put? The whole column is searched and
       * the nearest surface to the analytic floor is the answer, which needs no
       * ray origin at all — and a ray origin was the only thing in here that had
       * to be guessed.
       */
      const nearestTo = (x, z, target, all) => {
        const lx = x - ox;
        const lz = z - oz;
        const ly = target - oy;
        let best = null;
        for (let t = 0; t < idx.length; t += 3) {
          const ia = idx[t];
          const ib = idx[t + 1];
          const ic = idx[t + 2];
          if (!all && (ia >= lattice || ib >= lattice || ic >= lattice)) continue;
          const a = ia * 3;
          const b = ib * 3;
          const c = ic * 3;
          const ax = pos[a];
          const az = pos[a + 2];
          const bx = pos[b];
          const bz = pos[b + 2];
          const cx = pos[c];
          const cz = pos[c + 2];
          const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
          if (Math.abs(d) < 1e-9) continue;
          const w0 = ((bz - cz) * (lx - cx) + (cx - bx) * (lz - cz)) / d;
          if (w0 < 0 || w0 > 1) continue;
          const w1 = ((cz - az) * (lx - cx) + (ax - cx) * (lz - cz)) / d;
          if (w1 < 0 || w1 > 1) continue;
          const w2 = 1 - w0 - w1;
          if (w2 < 0 || w2 > 1) continue;
          const y = w0 * pos[a + 1] + w1 * pos[b + 1] + w2 * pos[c + 1];
          if (best === null || Math.abs(y - ly) < Math.abs(best - ly)) best = y;
        }
        return best === null ? null : best + oy;
      };

      const hits = [];
      let probes = 0;
      const blocks = { n: 0, sum: 0, hover: 0, wade: 0, worstHover: 0, worstWade: 0 };
      for (let pi = 0; pi < cave.paths.length; pi++) {
        const p = cave.paths[pi];
        const n = p.x.length;
        for (let i = 2; i < n - 2; i += 3) {
          const a = Math.max(0, i - 1);
          const b2 = Math.min(n - 1, i + 1);
          let tx = p.x[b2] - p.x[a];
          let tz = p.z[b2] - p.z[a];
          const tl = Math.hypot(tx, tz) || 1;
          tx /= tl;
          tz /= tl;
          const half = p.r[i] * p.w[i];
          for (const u of [-0.75, -0.4, 0, 0.4, 0.75]) {
            /**
             * ONLY WHERE A BODY COULD STAND, which three quarters of the way to
             * the wall very often is not.
             *
             * The section is an ellipse cut off at the floor, so its headroom
             * falls to nothing as you approach the wall — at 0.75 of the
             * half-width a bedding plane has about a metre of it. Sampling there
             * asks "what is the floor at a point inside the rock", the honest
             * answer is "there isn't one", and `caveFloorUnder` correctly hands
             * back the hillside — which the probe then reports as seventeen
             * metres of hover. That is a real number about an unreal place, and
             * it hid the two-metre disagreements that are about real ones.
             *
             * The player cannot get there either: the wall push holds the body
             * inside `halfWidthAt` at chest height, which is the same solve.
             */
            const top = p.t[i] * Math.sqrt(Math.max(0, 1 - u * u));
            const bot = Math.max(-top, -p.f[i]);
            if ((top - bot) * p.r[i] < 2.1) continue;
            const x = p.x[i] - tz * half * u;
            const z = p.z[i] + tx * half * u;
            // Where a body standing here would end up, then what is under it.
            const eye = p.y[i] - p.r[i] * p.f[i] + 1.68;
            const analytic = mod.caveFloorUnder(x, z, eye);
            const s = mod.caveSample(x, eye, z);
            const said = { inside: +s.inside.toFixed(2), ring: s.ring, floor: +s.floor.toFixed(2) };
            probes++;
            /**
             * Against ALL the geometry, because a body standing on a breakdown
             * block is standing on the block and the analytic floor knows it.
             * The rock alone is asked for as well, and only so the report can say
             * which of the two a failure is about — a passage floor that has
             * drifted off its mesh and a slab whose collider does not match the
             * solid drawn round it are different bugs in different functions.
             */
            const mesh = nearestTo(x, z, analytic, true);
            const rock = nearestTo(x, z, s.inside > 0 ? s.floorRock : analytic, false);
            if (mesh === null) continue;
            const gap = analytic - mesh;
            /**
             * IS A BLOCK INVOLVED IN THIS COLUMN AT ALL, asked from BOTH sides.
             *
             * `onBlock` below asks only whether the ANALYTIC floor claims a
             * block, and that misses the failure this test exists to catch: a
             * column where a slab is drawn and the collider does not know it is
             * a block failure, and it was being filed under "passage floor"
             * because the analytic answer had no block in it. Asking the mesh
             * too — is there anything in this column that is not the swept
             * lattice — catches that direction, and the union is what the block
             * lines of the summary count.
             */
            const latt = nearestTo(x, z, analytic, false);
            const blockish =
              (s.inside > 0 && s.floor - s.floorRock > 0.05) ||
              (latt !== null && mesh - latt > 0.05);
            if (blockish) {
              blocks.n++;
              blocks.sum += Math.abs(gap);
              if (gap > tol) blocks.hover++;
              else if (gap < -tol) blocks.wade++;
              if (gap > blocks.worstHover) blocks.worstHover = gap;
              if (gap < blocks.worstWade) blocks.worstWade = gap;
            }
            if (Math.abs(gap) > tol) {
              hits.push({
                pi,
                i,
                u,
                gap: +gap.toFixed(2),
                analytic: +analytic.toFixed(2),
                mesh: +mesh.toFixed(2),
                // Whether a block is claiming this column, which is the one
                // thing that says which half of the code a row belongs to.
                onBlock: s.inside > 0 && s.floor - s.floorRock > 0.05,
                rockGap: rock === null ? null : +(s.floorRock - rock).toFixed(2),
                axis: +p.y[i].toFixed(2),
                r: +p.r[i].toFixed(2),
                f: +p.f[i].toFixed(2),
                ...said,
              });
            }
          }
        }
      }
      hits.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
      return {
        probes,
        count: hits.length,
        onBlock: hits.filter((h) => h.onBlock).length,
        /**
         * HOVERING AND WADING COUNTED APART, because they are not one number.
         * Every dome the collider ever raised over a breakdown block traded one
         * for the other at a fixed total — 243 shapes were searched and the
         * whole Pareto front did — so a summary that prints only the total
         * cannot tell "the fit moved along the front" from "the fit got
         * better", and the whole point of solving the drawn solid instead of
         * fitting a dome is that it moves the TOTAL.
         */
        hover: hits.filter((h) => h.gap > tol).length,
        wade: hits.filter((h) => h.gap < -tol).length,
        worstHover: hits.length ? Math.max(0, ...hits.map((h) => h.gap)) : 0,
        worstSunk: hits.length ? Math.min(0, ...hits.map((h) => h.gap)) : 0,
        blocks,
        top: hits.slice(0, 14),
      };
    },
    { k: c.k, tol: TOL }
  );
  if (!report) {
    console.log(`k=${c.k}: not built`);
    continue;
  }
  totalBad += report.count;
  totalHover += report.hover;
  totalWade += report.wade;
  blockN += report.blocks.n;
  blockSum += report.blocks.sum;
  blockHover += report.blocks.hover;
  blockWade += report.blocks.wade;
  blockWorstHover = Math.max(blockWorstHover, report.blocks.worstHover);
  blockWorstWade = Math.min(blockWorstWade, report.blocks.worstWade);
  worstHover = Math.max(worstHover, report.worstHover);
  console.log(
    `\nk=${c.k}  ${report.probes} probes  ${report.count} disagree by > ${TOL} m  ` +
      `(${report.hover} hovering, ${report.wade} wading; ${report.onBlock} of them standing on a breakdown block)  ` +
      `worst hover +${report.worstHover.toFixed(2)} m, worst sunk ${report.worstSunk.toFixed(2)} m`
  );
  const b = report.blocks;
  console.log(
    `   breakdown blocks: ${b.n} columns with a slab in them  ` +
      `${b.hover} hovering / ${b.wade} wading over ${TOL} m  ` +
      `mean |gap| ${(b.n ? b.sum / b.n : 0).toFixed(2)} m  ` +
      `worst +${b.worstHover.toFixed(2)} / ${b.worstWade.toFixed(2)}`
  );
  for (const h of report.top) {
    console.log(
      `   p${h.pi} ring ${String(h.i).padStart(3)} across ${String(h.u).padStart(5)}` +
        `  analytic ${String(h.analytic).padStart(8)}  nearest drawn ${String(h.mesh).padStart(8)}  gap ${h.gap > 0 ? '+' : ''}${h.gap}` +
        `   | ${h.onBlock ? 'ON A BLOCK' : 'passage floor'}, rock floor off by ${h.rockGap ?? '-'}` +
        `  | sample said ring ${String(h.ring).padStart(3)} floor ${String(h.floor).padStart(8)} inside ${h.inside}` +
        `  (this ring: axis ${h.axis} r ${h.r} f ${h.f})`
    );
  }
}

console.log(
  `\n${totalBad} disagreements over ${TOL} m (${totalHover} hovering, ${totalWade} wading); ` +
    `worst hover +${worstHover.toFixed(2)} m` +
    (worstHover > 1 ? '  <-- the body stands in mid-air here' : '')
);
console.log(
  `breakdown blocks alone: ${blockN} columns, ` +
    `${blockHover} hovering + ${blockWade} wading = ${blockHover + blockWade} bad, ` +
    `mean |gap| ${(blockN ? blockSum / blockN : 0).toFixed(2)} m, ` +
    `worst +${blockWorstHover.toFixed(2)} / ${blockWorstWade.toFixed(2)} m`
);
await browser.close();
