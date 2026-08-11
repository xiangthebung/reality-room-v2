import { chromium } from 'playwright';

/** Frame timing at several trip levels, in a real browser. */
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
/**
 * DEAFEN THE PAGE TO HOT RELOADS BEFORE IT LOADS.
 *
 * A save landing mid-run reloads the page, and this then times a world that is
 * still streaming its terrain and compiling its shaders — which reads as a
 * frame-time cliff indistinguishable from the regression the script exists to
 * catch. Worse, it gates `npm run check`, so the cost of the confusion is paid
 * by whoever is next. Silent, because a reloaded page has no console problems.
 * Same guard as play-check.mjs, which documents what it cost.
 */
await page.routeWebSocket(/.*/, () => {});
await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(3000);

await page.evaluate(() => {
  window.__f = [];
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    window.__f.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

async function sample(label, seek) {
  await page.evaluate((s) => { if (s === null) window.RR.director.ground(); else window.RR.director.seek(s); }, seek);
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.__f.length = 0; });
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => {
    const f = window.__f.slice().sort((a, b) => a - b);
    const at = (p) => f[Math.min(f.length - 1, Math.floor(f.length * p))] ?? 0;
    /**
     * THE COUNTERS NEED `autoReset` OFF, AND FOR A LONG TIME THIS DID NOT DO IT.
     *
     * `renderer.info` resets at the top of every `renderer.render()`, and one
     * frame here is several of those — the world, a bright pass, a bloom chain,
     * a glow accumulator, the output pass. Reading it after a frame reports
     * whichever ran last, which is the fullscreen output quad, so these two
     * columns printed a flat `draws 1  tris 0k` at every phase and every quality
     * level. Nobody noticed because nobody expects a number that never moves to
     * be a number at all.
     *
     * Turned off around one hand-driven frame, exactly as
     * `src/dev/perf/probe.js` does it for the regression gate. The frame timings
     * above are unaffected: they come from rAF deltas and were always real.
     */
    const info = window.RR.renderer.info;
    info.autoReset = false;
    info.reset();
    window.RR.pipeline.render(1 / 60);
    const counts = { calls: info.render.calls, tris: info.render.triangles };
    info.autoReset = true;
    return { n: f.length, med: at(0.5), p95: at(0.95), ...counts };
  });
  console.log(String(label).padEnd(12), `${(1000 / r.med).toFixed(0)} fps  median ${r.med.toFixed(1)}ms  p95 ${r.p95.toFixed(1)}ms  draws ${r.calls}  tris ${(r.tris/1000).toFixed(0)}k`);
}

await sample('sober', null);
await sample('onset', 80);
await sample('peak', 160);
await sample('egodeath', 220);
await browser.close();
