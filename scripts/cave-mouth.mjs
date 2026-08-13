import { chromium } from 'playwright';
import { cavesNear, setWorldSeed } from '../src/world/terrain.js';

/**
 * IS THERE A HILL STANDING IN THE DOORWAY?
 *
 * The player's report was "the entrance is blocked by terrain", and the picture
 * showed exactly that: a tan, grass-topped mound filling the bottom half of a
 * perfectly good rock arch. It is not the hood and it is not a boulder — it is
 * the height FIELD, caught halfway through the only thing it is ever asked to do
 * at a cave mouth, which is get from the gully floor up to the hillside over the
 * passage. Measured here at up to 5.7 m proud of the floor, over four rings.
 *
 * The fix is the PORTAL block in terrain.js. This is its gate, and it has to
 * watch BOTH failures, because they are each other's cure:
 *
 *   blocked   ground drawn between the passage's floor and its ceiling. The
 *             mound. What the player walked into.
 *   BREACH    no ground drawn over a column where the hillside stands well clear
 *             of the roof, for more than one cell. A hole in the mountain, with
 *             daylight behind it. What every over-eager version of the fix did
 *             instead, and the worse of the two to look at.
 *
 * It reads the GROUND CHUNKS' OWN INDEX BUFFERS rather than `heightAt`. The
 * portal moves and cuts the mesh and leaves the height field alone — on purpose,
 * so that nothing else in the world has to know — so `heightAt` still reports
 * the mound and a probe that trusted it would fail a fixed build for ever.
 *
 *   node scripts/cave-mouth.mjs [--seed=grove-01] [--caves=2] [--rings=70]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const SEED = args.seed ?? 'grove-01';
const CAVES = Number(args.caves ?? 2);
const RINGS = Number(args.rings ?? 70);
/** How far above the floor counts as standing in the way, in metres. */
const TOL = Number(args.tol ?? 0.35);

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
await page.goto(URL + `?seed=${SEED}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForSelector('#gate.gone', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2000);

let totalLit = 0;
let totalGone = 0;
let worst = 0;
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
    async ({ k, rings, tol }) => {
      const R = window.RR;
      const caves = await import('/src/world/caves.js');
      const terrain = await import('/src/world/terrain.js');
      const cave = R.caves.caves.get(k);
      if (!cave?.paths) return null;
      const p = cave.paths[0];

      /**
       * THE DRAWN GROUND, NOT `heightAt`.
       *
       * The portal does not move the height field — it deletes triangles from
       * the mesh, so `heightAt` still answers for the mound and a probe that
       * reads it reports a bug that is no longer on screen. This walks the
       * ground chunks' own index buffers and reports the highest ground surface
       * actually drawn over a column, which is the thing the player sees.
       */
      const chunks = [];
      R.forest.groundField.group.traverse((o) => {
        if (o.isMesh && o.geometry?.index) chunks.push(o);
      });
      const groundDrawn = (x, z) => {
        let best = null;
        for (const m of chunks) {
          const g = m.geometry;
          const pos = g.attributes.position.array;
          const idx = g.index.array;
          const lx = x - m.position.x;
          const lz = z - m.position.z;
          const bs = g.boundingSphere;
          if (bs) {
            const dx = lx - bs.center.x;
            const dz = lz - bs.center.z;
            if (dx * dx + dz * dz > bs.radius * bs.radius) continue;
          }
          for (let t = 0; t < idx.length; t += 3) {
            const a = idx[t] * 3;
            const b = idx[t + 1] * 3;
            const c = idx[t + 2] * 3;
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
            if (best === null || y > best) best = y;
          }
        }
        return best;
      };
      /** The ground lattice's pitch, from ground.js: 128 m over 80 quads. */
      const CELL = 1.6;
      const n = Math.min(p.x.length, rings);
      const rows = [];
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1);
        const b = Math.min(p.x.length - 1, i + 1);
        let tx = p.x[b] - p.x[a];
        let tz = p.z[b] - p.z[a];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        const half = p.r[i] * p.w[i];
        let inCount = 0;
        let worstIn = 0;
        let gone = 0;
        let overAll = true;
        let underAll = true;
        for (const u of [-0.8, -0.5, -0.2, 0, 0.2, 0.5, 0.8]) {
          const x = p.x[i] - tz * half * u;
          const z = p.z[i] + tx * half * u;
          const eye = p.y[i] - p.r[i] * p.f[i] + 1.68;
          const s = caves.caveSample(x, eye, z);
          if (s.inside <= 0) continue;
          const h = groundDrawn(x, z);
          /**
           * THE OTHER FAILURE, AND IT IS THE WORSE ONE.
           *
           * The portal deletes ground, so it can take out ground that was never
           * in the way — and where the hillside stands four metres over the
           * ceiling, deleting it is a hole in the mountain with the sky behind
           * it. It photographs as a patch of sunlit forest hanging inside the
           * arch.
           *
           * WIDER THAN ONE CELL, though, and that qualification is the whole
           * test. The portal is MEANT to leave exactly one row of quads missing
           * — the seam where the pulled ground meets the hillside — and a column
           * that lands on it correctly reports no ground drawn. So a single
           * missing column is the design; three metres of missing columns is the
           * bug. `CELL` is the ground lattice's own pitch.
           */
          if (h === null) {
            const wide =
              groundDrawn(x + CELL * 1.5 * -tz, z + CELL * 1.5 * tx) === null &&
              groundDrawn(x - CELL * 1.5 * -tz, z - CELL * 1.5 * tx) === null;
            if (wide && terrain.heightAt(x, z) > s.ceiling + 1.5) gone++;
            continue;
          }
          if (h > s.floor + tol && h < s.ceiling) {
            inCount++;
            worstIn = Math.max(worstIn, h - s.floor);
          }
          if (h < s.ceiling) overAll = false;
          if (h > s.floor + tol) underAll = false;
        }
        rows.push({
          i,
          along: +(p.along ? p.along[i] : i * 0.95).toFixed(1),
          inCount,
          gone,
          worstIn: +worstIn.toFixed(2),
          state: overAll ? 'over' : underAll ? 'under' : 'in',
        });
      }
      return { rows, blind: p.blind ?? Infinity, k };
    },
    { k: c.k, rings: RINGS, tol: TOL }
  );
  if (!report) {
    console.log(`k=${c.k} not built`);
    continue;
  }
  const blind = report.blind;
  const bad = report.rows.filter((r) => r.inCount > 0);
  const lit = bad.filter((r) => r.along < blind);
  const breached = report.rows.filter((r) => r.gone > 0);
  totalLit += lit.length;
  totalGone += breached.length;
  for (const r of lit) worst = Math.max(worst, r.worstIn);
  console.log(
    `\nk=${report.k}  blind at ${Number.isFinite(blind) ? blind.toFixed(1) + ' m' : 'never'}` +
      `  ${bad.length} rings with terrain in the passage, ${lit.length} of them where the ground is still drawn`
  );
  const first = report.rows.find((r) => r.state === 'over');
  console.log(`  terrain first clears the ceiling at ring ${first ? first.i : '—'} (${first ? first.along : '—'} m)`);
  for (const r of lit.slice(0, 14)) {
    console.log(
      `    ring ${String(r.i).padStart(3)}  ${String(r.along).padStart(6)} m  ` +
        `${r.inCount}/7 samples blocked  worst +${r.worstIn.toFixed(2)} m over the floor`
    );
  }
  for (const r of breached.slice(0, 8)) {
    console.log(
      `    BREACH ring ${String(r.i).padStart(3)}  ${String(r.along).padStart(6)} m  ` +
        `${r.gone}/7 columns have no ground drawn where the hill is over the roof`
    );
  }
}

await browser.close();
console.log(
  `\n${totalLit} lit rings have the height field standing inside the passage; worst +${worst.toFixed(2)} m`
);
process.exit(totalLit > 0 ? 1 : 0);
