import { chromium } from 'playwright';

/**
 * CAN ANY VERTEX OF A CAVE CARRY A NORMAL THE SHADER CANNOT NORMALIZE?
 *
 * This is the "a black bar randomly appears in caves" gate, and it is here
 * because the failure is invisible to every other check in this directory: the
 * geometry is in the right place, the winding is right, the baked light is
 * right, and one facet of one formation comes out PURE BLACK with a hard edge on
 * all four sides. `cave-check` measures shape, `cave-roof` measures burial,
 * `cave-trip` measures whether a solid can tear — none of them look at the one
 * attribute that decides whether a triangle is shaded at all.
 *
 * WHAT IT CATCHES. `_face` derived its normal from one cross product over the
 * first three corners of a quad and divided by `Math.hypot(...) || 1`. That is a
 * guard against dividing by zero and not against the result: three collinear
 * corners give (0, 0, 0), and a zero normal survives the divide untouched. The
 * quad's OTHER triangle is then an ordinary visible triangle with three zero
 * normals on it, `normalize(vec3(0.0))` is 0/0, and NaN interpolates to NaN
 * across the whole face. Measured before the fix: 52 to 144 such vertices in
 * EVERY cave on every seed tried, in 5 to 21 runs of 4 to 12 — one of which is a
 * three-metre blade, which is the bar in the report.
 *
 * WHY IT TESTS THE BUILT BUFFERS RATHER THAN THE EMITTERS. A zero normal is
 * legal JavaScript, legal in a BufferAttribute, legal to upload, and only means
 * anything the moment a fragment shader normalizes it. There is nowhere upstream
 * of the buffer where it looks wrong, so the buffer is where to look.
 *
 * The threshold is exact rather than epsilon-based on purpose: a normal of
 * length 1e-9 still normalizes to something finite, and this is a check for the
 * one value that does not.
 *
 *   node scripts/cave-normals.mjs [--seeds=grove-01,grove-03] [--caves=2]
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const SEEDS = (args.seeds ?? 'grove-01,grove-03').split(',');
const CAVES = Number(args.caves ?? 2);

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

const fails = [];
let scanned = 0;
let vertices = 0;

for (const SEED of SEEDS) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const problems = [];
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`http://127.0.0.1:5180/?seed=${SEED}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
  await page.click('#enter');
  await page.waitForSelector('#gate.gone', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const rows = await page.evaluate(async (CAVES) => {
    const R = window.RR;
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const terrain = await import('/src/world/terrain.js');
    /**
     * Fly to each mouth and wait for `ready` rather than for a frame count.
     * A cave is built against a millisecond deadline, so how many frames it
     * takes is a property of the machine — see the same wait in cave-seal.
     */
    for (const c of terrain.cavesNear(0, 0, 900).slice(0, CAVES)) {
      R.controller.keys.clear();
      R.controller.fly = true;
      R.controller.position.set(c.x, 60, c.z);
      R.controller.velocity.set(0, 0, 0);
      for (let i = 0; i < 9000 && !R.caves.caves.get(c.k)?.ready; i++) await raf();
    }
    const out = [];
    for (const [k, cave] of R.caves.caves) {
      if (!cave.ready) continue;
      for (const mesh of cave.group ? cave.group.children : [cave.mesh]) {
        const g = mesh?.geometry;
        if (!g?.attributes?.normal) continue;
        const nr = g.attributes.normal.array;
        const ps = g.attributes.position.array;
        const n = g.attributes.normal.count;
        let zero = 0;
        let nan = 0;
        let posNan = 0;
        const where = [];
        for (let v = 0; v < n; v++) {
          const a = nr[v * 3];
          const b = nr[v * 3 + 1];
          const c = nr[v * 3 + 2];
          const bad = !(a === a) || !(b === b) || !(c === c);
          const zed = !bad && a === 0 && b === 0 && c === 0;
          if (bad) nan++;
          if (zed) zero++;
          if (!(ps[v * 3] === ps[v * 3]) || !(ps[v * 3 + 1] === ps[v * 3 + 1])) posNan++;
          if ((bad || zed) && where.length < 6)
            where.push({
              v,
              at: [ps[v * 3], ps[v * 3 + 1], ps[v * 3 + 2]].map((q) => +q.toFixed(1)),
            });
        }
        out.push({ k, mesh: mesh.name || mesh.type, verts: n, zero, nan, posNan, where });
      }
    }
    return out;
  }, CAVES);

  console.log(`\n${SEED}`);
  for (const r of rows) {
    scanned++;
    vertices += r.verts;
    const bad = r.zero + r.nan + r.posNan;
    console.log(
      `  k=${String(r.k).padStart(3)} ${r.mesh.padEnd(12)} ${String(r.verts).padStart(7)} vertices  ` +
        (bad
          ? `ZERO ${r.zero}  NaN ${r.nan}  NaN positions ${r.posNan}`
          : 'every normal is a unit vector')
    );
    if (bad) {
      fails.push(
        `${SEED} k=${r.k} ${r.mesh}: ${r.zero} zero normals, ${r.nan} NaN normals, ` +
          `${r.posNan} NaN positions — first at ${JSON.stringify(r.where.map((w) => w.at))}`
      );
    }
  }
  if (problems.length) fails.push(`${SEED}: page errors ${problems.slice(0, 3).join(' | ')}`);
  await page.close();
}
await browser.close();

console.log(`\n${scanned} meshes, ${vertices} vertices`);
if (fails.length) {
  console.log(`\nFAIL — a zero or NaN normal is a black triangle in the rock\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log('\nPASS: no cave vertex carries a normal the shader cannot normalize');
