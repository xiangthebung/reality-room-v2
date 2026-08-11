import { chromium } from 'playwright';

/**
 * Walk out of the authored region and watch what the ring does.
 *
 *   node scripts/world-walk.mjs [--url=…] [--distance=2000] [--speed=1]
 *
 * The question a streaming world has to answer is not "does it look right at
 * spawn" — the plate did that — but "is it still the same size, and the same
 * cost, ten minutes later". So this drives the body in a straight line for a
 * couple of kilometres and samples the three numbers that would show a leak:
 *
 *   chunks       resident ground meshes. Must PLATEAU, not climb. If eviction
 *                is broken this is the number that tells you, long before the
 *                heap does.
 *   geometries   `renderer.info.memory.geometries`, which three decrements from
 *                the geometry's own dispose event. It counts the whole scene, so
 *                the interesting thing is that its DELTA goes to zero.
 *   heap         `performance.memory.usedJSHeapSize`, sawtoothed by GC, so read
 *                the trend and not any single sample.
 *
 * `speed` is metres per frame written straight onto the body: 1 m/frame is
 * about 60 m/s, seven times a sprint, which is deliberate. The ring accepts one
 * chunk per frame, so walking seven times too fast is the cheapest available
 * stress test of whether that budget is enough — `pending` is reported for
 * exactly that reason and should spend most of the walk at or near zero.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const URL = args.url ?? 'http://127.0.0.1:5180/';
const DISTANCE = Number(args.distance ?? 2000);
const SPEED = Number(args.speed ?? 1);

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--autoplay-policy=no-user-gesture-required',
    // performance.memory needs precise values to be worth reading at all.
    '--enable-precise-memory-info',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`[error] ${m.text().slice(0, 200)}`);
});

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2500);

const boot = await page.evaluate(() => {
  const R = window.RR;
  return {
    chunks: R.forest.groundField?.chunks.size ?? -1,
    pending: R.forest.groundField?.pending ?? -1,
    built: R.forest.groundField?.built ?? -1,
    geometries: R.renderer.info.memory.geometries,
    heap: performance.memory ? performance.memory.usedJSHeapSize : 0,
    workers: R.forest.groundField?.workers.length ?? -1,
  };
});
console.log(
  `at spawn: ${boot.chunks} chunks resident (${boot.built} built, ${boot.pending} pending), ` +
    `${boot.workers} workers, ${boot.geometries} geometries, ` +
    `heap ${(boot.heap / 1e6).toFixed(1)} MB\n`
);

const samples = await page.evaluate(
  async ({ distance, speed }) => {
    const R = window.RR;
    const G = R.forest.groundField;
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const out = [];
    let travelled = 0;
    let maxPending = 0;
    let sinceSample = 0;
    while (travelled < distance) {
      await raf();
      R.controller.position.x += speed;
      R.controller.velocity.set(0, 0, 0);
      travelled += speed;
      sinceSample += speed;
      if (G) maxPending = Math.max(maxPending, G.pending);
      if (sinceSample >= 100) {
        sinceSample = 0;
        out.push({
          x: Math.round(R.controller.position.x),
          chunks: G ? G.chunks.size : -1,
          built: G ? G.built : -1,
          evicted: G ? G.evicted : -1,
          pending: G ? G.pending : -1,
          maxPending,
          geometries: R.renderer.info.memory.geometries,
          heap: performance.memory ? performance.memory.usedJSHeapSize : 0,
          calls: R.renderer.info.render.calls,
          tris: R.renderer.info.render.triangles,
          y: Math.round(R.controller.position.y * 10) / 10,
        });
        maxPending = 0;
      }
    }
    return out;
  },
  { distance: DISTANCE, speed: SPEED }
);

console.log(
  `${'x'.padStart(7)} ${'y'.padStart(7)} ${'chunks'.padStart(7)} ${'built'.padStart(6)} ` +
    `${'evict'.padStart(6)} ${'pend'.padStart(5)} ${'peak'.padStart(5)} ` +
    `${'geoms'.padStart(6)} ${'heapMB'.padStart(7)} ${'draws'.padStart(6)} ${'Mtris'.padStart(6)}`
);
for (const s of samples) {
  console.log(
    `${String(s.x).padStart(7)} ${String(s.y).padStart(7)} ${String(s.chunks).padStart(7)} ` +
      `${String(s.built).padStart(6)} ${String(s.evicted).padStart(6)} ` +
      `${String(s.pending).padStart(5)} ${String(s.maxPending).padStart(5)} ` +
      `${String(s.geometries).padStart(6)} ${(s.heap / 1e6).toFixed(1).padStart(7)} ` +
      `${String(s.calls).padStart(6)} ${(s.tris / 1e6).toFixed(2).padStart(6)}`
  );
}

const half = samples.slice(Math.floor(samples.length / 2));
const chunkVals = half.map((s) => s.chunks);
const geomVals = half.map((s) => s.geometries);
const heapVals = half.map((s) => s.heap);
const range = (a) => Math.max(...a) - Math.min(...a);
console.log(
  `\nover the second half of the walk: chunks ${Math.min(...chunkVals)}–${Math.max(...chunkVals)}, ` +
    `geometries ${Math.min(...geomVals)}–${Math.max(...geomVals)} (range ${range(geomVals)}), ` +
    `heap ${(Math.min(...heapVals) / 1e6).toFixed(1)}–${(Math.max(...heapVals) / 1e6).toFixed(1)} MB`
);
const last = samples[samples.length - 1];
console.log(
  `built ${last.built} chunks and evicted ${last.evicted} over ${DISTANCE} m — ` +
    `net resident ${last.built - last.evicted}`
);

if (problems.length) {
  console.log(`\n${problems.length} console problem(s):`);
  for (const p of problems.slice(0, 20)) console.log(' ', p);
} else {
  console.log('\nno console problems');
}

await browser.close();
