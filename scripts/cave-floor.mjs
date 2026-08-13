import { chromium } from 'playwright';
import { cavesNear, setWorldSeed } from '../src/world/terrain.js';

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
 * The downward ray is cast by hand against the index buffer and only against
 * the swept lattice — the first `lattice` vertices — so a breakdown block does
 * not get mistaken for the rock floor. THREE.Raycaster is not used because the
 * page does not export three.
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
  await page.waitForTimeout(3500);

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
      /** Vertices belonging to the swept lattice; anything past is loose rock. */
      let lattice = 0;
      for (const p of cave.paths) lattice += p.x.length;
      lattice = (lattice + cave._hood + 1) * 24;

      const castDown = (x, z, fromY, all) => {
        const lx = x - ox;
        const lz = z - oz;
        const ly = fromY - oy;
        let best = -Infinity;
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
          if (y <= ly && y > best) best = y;
        }
        return best === -Infinity ? null : best + oy;
      };

      const hits = [];
      let probes = 0;
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
            /**
             * FROM THE AXIS HEIGHT, NOT FROM UP NEAR THE ROOF.
             *
             * The first version started the ray 0.6 of the half-height up, which
             * at 0.75 of the half-width across is outside the ellipse once the
             * wall displacement is added — so the ray began in rock and reported
             * the wall as the floor. Every "the body is 5 m under the rock"
             * reading in the first run was that, not a real disagreement. The
             * waist is inside the section at any offset the section has, by
             * definition.
             */
            const from = p.y[i];
            const mesh = castDown(x, z, from, false);
            probes++;
            if (mesh === null) continue;
            /**
             * A body standing on a breakdown block is standing on the block, and
             * the analytic floor knows it. Casting against the rock alone would
             * report every boulder in a chamber as two metres of hover, so a
             * probe that agrees with EITHER surface passes.
             */
            const withLoose = castDown(x, z, from, true);
            if (withLoose !== null && Math.abs(analytic - withLoose) <= tol) continue;
            const gap = analytic - mesh;
            if (Math.abs(gap) > tol) {
              hits.push({
                pi,
                i,
                u,
                gap: +gap.toFixed(2),
                analytic: +analytic.toFixed(2),
                mesh: +mesh.toFixed(2),
                from: +from.toFixed(2),
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
        worstHover: hits.length ? Math.max(0, ...hits.map((h) => h.gap)) : 0,
        worstSunk: hits.length ? Math.min(0, ...hits.map((h) => h.gap)) : 0,
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
  worstHover = Math.max(worstHover, report.worstHover);
  console.log(
    `\nk=${c.k}  ${report.probes} probes  ${report.count} disagree by > ${TOL} m  ` +
      `worst hover +${report.worstHover.toFixed(2)} m, worst sunk ${report.worstSunk.toFixed(2)} m`
  );
  for (const h of report.top) {
    console.log(
      `   p${h.pi} ring ${String(h.i).padStart(3)} across ${String(h.u).padStart(5)}` +
        `  analytic ${String(h.analytic).padStart(8)}  rock ${String(h.mesh).padStart(8)}  gap ${h.gap > 0 ? '+' : ''}${h.gap}` +
        `   | sample said ring ${String(h.ring).padStart(3)} floor ${String(h.floor).padStart(8)} inside ${h.inside}` +
        `  (this ring: axis ${h.axis} r ${h.r} f ${h.f}, ray from ${h.from})`
    );
  }
}

console.log(
  `\n${totalBad} disagreements over ${TOL} m; worst hover +${worstHover.toFixed(2)} m` +
    (worstHover > 1 ? '  <-- the body stands in mid-air here' : '')
);
await browser.close();
