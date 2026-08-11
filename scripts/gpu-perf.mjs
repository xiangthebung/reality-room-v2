import { chromium } from 'playwright';

/**
 * GPU frame cost, measured properly.
 *
 * perf.mjs measures wall-clock between rAF callbacks, which vsync pins to
 * 16.7 ms as long as the app is fast enough to hit it — so it can tell you the
 * frame rate is fine and nothing about how much headroom is left. This drives
 * the pipeline directly and times it with EXT_disjoint_timer_query_webgl2, so
 * the number is the GPU's actual cost per frame and keeps falling as the app
 * gets faster.
 *
 *   node scripts/gpu-perf.mjs [--url=…] [--width=2560] [--height=1440]
 *
 * Draw calls and triangles are captured with info.autoReset off, so they cover
 * every pass — shadow, scene and post — rather than whatever the last one was.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const URL = args.url ?? 'http://127.0.0.1:5180/';
const WIDTH = Number(args.width ?? 2560);
const HEIGHT = Number(args.height ?? 1440);

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
 * A timer query spans frames, and a reload landing inside one leaves the query
 * object owned by a GL context that no longer exists — which surfaces as a
 * disjoint result, i.e. as a silently discarded or absurd GPU time rather than
 * as an error. The whole point of this file is that its number keeps being
 * trustworthy as the app gets faster. Same guard as play-check.mjs.
 */
await page.routeWebSocket(/.*/, () => {});

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2500);

const ok = await page.evaluate(
  ({ w, h }) => {
    const R = window.RR;
    const gl = R.renderer.getContext();
    if (!gl.getExtension('EXT_disjoint_timer_query_webgl2')) return false;
    // Measure at a fixed internal resolution regardless of the window, so runs
    // are comparable across machines and across changes to the ratio cap.
    R.renderer.setPixelRatio(1);
    R.renderer.setSize(w, h, false);
    R.camera.aspect = w / h;
    R.camera.updateProjectionMatrix();
    R.pipeline.setSize(w, h, 1);
    return true;
  },
  { w: WIDTH, h: HEIGHT }
);
if (!ok) {
  console.error('EXT_disjoint_timer_query_webgl2 unavailable — is this a software GL context?');
  await browser.close();
  process.exit(1);
}

async function sample(label, seek) {
  const r = await page.evaluate(async (s) => {
    const R = window.RR;
    const gl = R.renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

    if (s === null) R.director.ground();
    else R.director.seek(s);
    // Settle the eased level and the atmosphere before timing.
    for (let i = 0; i < 30; i++) {
      R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
    }
    R.forest?.cull?.(R.camera, true);

    const frame = () => {
      R.atmosphere.follow(R.camera);
      R.forest?.cull?.(R.camera);
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
  }, seek);

  const fps = 1000 / r.ms;
  console.log(
    `${String(label).padEnd(10)} ${r.ms.toFixed(2).padStart(6)} ms/frame   ` +
      `${fps.toFixed(0).padStart(4)} fps-equivalent   ` +
      `draws ${String(r.calls).padStart(4)}   tris ${(r.tris / 1e6).toFixed(2)}M`
  );
  return r;
}

console.log(`GPU frame cost at ${WIDTH}×${HEIGHT}, all passes\n`);
await sample('sober', null);
await sample('onset', 80);
await sample('peak', 160);
await sample('egodeath', 220);

// Standing still is the common case and the shadow cache's whole point.
const still = await page.evaluate(async () => {
  const R = window.RR;
  const gl = R.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  R.director.seek(160);
  for (let i = 0; i < 30; i++) R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
  // No follow(), no cull(): the camera has not moved, so neither would fire.
  for (let i = 0; i < 10; i++) R.pipeline.render(1 / 60);
  gl.finish();
  const N = 24;
  const q = gl.createQuery();
  gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
  for (let i = 0; i < N; i++) R.pipeline.render(1 / 60);
  gl.endQuery(ext.TIME_ELAPSED_EXT);
  gl.flush();
  for (let t = 0; t < 40; t++) {
    await sleep(80);
    if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
  }
  const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
  gl.deleteQuery(q);
  return ns / 1e6 / N;
});
console.log(`${'peak still'.padEnd(10)} ${still.toFixed(2).padStart(6)} ms/frame   ${(1000 / still).toFixed(0).padStart(4)} fps-equivalent   (shadow map cached)`);

await browser.close();
