import { chromium } from 'playwright';

/**
 * Attribute the frame budget, one lever at a time.
 *
 * Everything here is toggled at RUNTIME on one build, so the comparisons are
 * free of driver-state and GPU-clock drift between runs. Three of the five
 * optimisations can be un-done live — the shadow cache, the MSAA level and the
 * instance culling — so those get a true before/after. The two shader ones (the
 * baked noise lattice and the vertex-side colour field) cannot be un-done
 * without editing source, so their value shows up as the shrunken gap between
 * sober and peak rather than as a row here.
 *
 *   node scripts/gpu-compare.mjs [--url=…]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
/**
 * DEAFEN THE PAGE TO HOT RELOADS BEFORE IT LOADS.
 *
 * Every row here is a before/after on ONE build with a lever toggled at
 * runtime, and that is the entire basis for trusting the differences. A reload
 * mid-run resets every lever to its default and puts the two halves of a
 * comparison on different builds, so an optimisation's measured worth becomes a
 * number about nothing — silently. Same guard as play-check.mjs.
 */
await page.routeWebSocket(/.*/, () => {});

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2500);

await page.evaluate(() => {
  window.__bench = async (opts) => {
    const R = window.RR;
    const gl = R.renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

    // 2560×1440 CSS at the given device-pixel ratio.
    R.renderer.setPixelRatio(opts.ratio);
    R.renderer.setSize(2560, 1440, false);
    R.camera.aspect = 2560 / 1440;
    R.camera.updateProjectionMatrix();
    R.pipeline.setSize(2560, 1440, opts.ratio);
    if (R.pipeline.sceneTarget.samples !== opts.samples) {
      R.pipeline.sceneTarget.samples = opts.samples;
      R.pipeline.sceneTarget.dispose();
    }
    R.renderer.shadowMap.autoUpdate = opts.shadowEveryFrame;

    R.director.seek(160);
    for (let i = 0; i < 30; i++) R.director.update(1 / 60, { camera: R.camera, audioLevels: null });

    // Un-culled means every instance genuinely written back, not merely
    // mesh.count raised — the buffer holds only the packed visible set, so
    // raising count alone would submit stale entries and time a fiction.
    if (opts.cull) R.forest.cull(R.camera, true);
    else R.forest.culler.restoreAll();

    const frame = () => {
      R.atmosphere.follow(R.camera);
      if (opts.cull) R.forest.cull(R.camera);
      if (opts.shadowEveryFrame) R.renderer.shadowMap.needsUpdate = true;
      R.pipeline.render(1 / 60);
    };

    for (let i = 0; i < 10; i++) frame();
    gl.finish();

    const info = R.renderer.info;
    info.autoReset = false;
    info.reset();
    frame();
    const calls = info.render.calls;
    const tris = info.render.triangles;
    info.autoReset = true;

    const N = 24;
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    for (let i = 0; i < N; i++) frame();
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    gl.flush();
    for (let t = 0; t < 40; t++) {
      await sleep(80);
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
    }
    const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
    gl.deleteQuery(q);
    return { ms: ns / 1e6 / N, calls, tris };
  };
});

const CURRENT = { ratio: 1.4, samples: 2, shadowEveryFrame: false, cull: true };
const LEGACY = { ratio: 1.75, samples: 4, shadowEveryFrame: true, cull: false };

/**
 * Measured from the shipping config outward: each row un-does ONE lever, so
 * the number in the last column is what that lever is worth today. That is a
 * more honest question than a cumulative ladder, whose middle rows describe
 * configurations that never existed and whose interactions compound.
 */
const rows = [
  ['current', CURRENT],
  ['− shadow cache', { ...CURRENT, shadowEveryFrame: true }],
  ['− culling', { ...CURRENT, cull: false }],
  ['− MSAA 2 (back to 4)', { ...CURRENT, samples: 4 }],
  ['− ratio 1.4 (back to 1.75)', { ...CURRENT, ratio: 1.75 }],
  ['all four un-done (legacy)', LEGACY],
];

console.log('Peak trip, 2560×1440 CSS, all passes.');
console.log('Each row un-does one lever from the shipping config.');
console.log('Every row runs the CURRENT shaders, so the legacy row is still');
console.log('faster than the real original was.\n');

let base = null;
for (const [label, opts] of rows) {
  const r = await page.evaluate((o) => window.__bench(o), opts);
  base ??= r.ms;
  const delta = r.ms === base ? '' : `   ${(((r.ms - base) / base) * 100).toFixed(0).padStart(5)}% slower`;
  console.log(
    `${label.padEnd(27)} ${r.ms.toFixed(2).padStart(7)} ms   ` +
      `${(1000 / r.ms).toFixed(0).padStart(4)} fps   ` +
      `tris ${(r.tris / 1e6).toFixed(2).padStart(5)}M${delta}`
  );
}

await browser.close();
