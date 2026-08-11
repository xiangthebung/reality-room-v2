import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * Measure how much a single effect actually contributes, with the world frozen.
 *
 * Freezing (trip clock AND wind) is what makes the number mean anything: two
 * frames of a moving forest differ everywhere regardless of the effect under
 * test, so an unfrozen difference image measures time passing.
 *
 *   node scripts/isolate.mjs melt
 */
const WHAT = process.argv[2] ?? 'melt';
const OUT = '.shots/isolate';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
/**
 * DEAFEN THE PAGE TO HOT RELOADS BEFORE IT LOADS.
 *
 * Freezing the world is the whole method here: the difference image is only
 * about the effect because nothing else moved between the two frames. A reload
 * un-freezes everything and re-seeds the wind, so the difference becomes the
 * reload — a large, confident number attributed to whichever effect was under
 * test. Same guard as shoot.mjs.
 */
await page.routeWebSocket(/.*/, () => {});
await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2000);
await page.evaluate(() => { document.getElementById('ui').style.display = 'none'; });

const STATIONS = {
  deep: { x: -34, z: -46, yaw: 1.1, pitch: -0.16 },
  clearing: { x: 0, z: 5, yaw: 0.0, pitch: -0.02 },
  up: { x: -30, z: -40, yaw: 0.8, pitch: 0.85 },
};

for (const [name, station] of Object.entries(STATIONS)) {
  await page.evaluate((s) => {
    const { controller, director, probe } = window.RR;
    probe.reset();
    probe.freeze(false);
    director.seek(190);
    director.state.override = 1;
    director.eased = 1;
    controller.position.x = s.x; controller.position.z = s.z;
    controller.velocity.set(0, 0, 0);
    controller.yaw = s.yaw; controller.pitch = s.pitch;
  }, station);
  await page.waitForTimeout(3500);
  await page.evaluate(() => window.RR.probe.freeze(true));
  await page.waitForTimeout(800);
  const on = (await page.screenshot()).toString('base64');
  await page.evaluate((w) => window.RR.probe.set(w, false), WHAT);
  await page.waitForTimeout(500);
  const off = (await page.screenshot()).toString('base64');

  const stats = await page.evaluate(async ([a, b]) => {
    const load = (d) => new Promise((res) => {
      const img = new Image(); img.onload = () => res(img); img.src = 'data:image/png;base64,' + d;
    });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const c = document.createElement('canvas');
    c.width = ia.width; c.height = ia.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(ia, 0, 0);
    const da = g.getImageData(0, 0, c.width, c.height).data;
    g.clearRect(0, 0, c.width, c.height); g.drawImage(ib, 0, 0);
    const db = g.getImageData(0, 0, c.width, c.height).data;
    const n = c.width * c.height;
    const diff = new Float32Array(n);
    let sum = 0, max = 0;
    for (let i = 0; i < n; i++) {
      const d = (Math.abs(da[i*4]-db[i*4]) + Math.abs(da[i*4+1]-db[i*4+1]) + Math.abs(da[i*4+2]-db[i*4+2])) / 3 / 255;
      diff[i] = d; sum += d; if (d > max) max = d;
    }
    const out = g.createImageData(c.width, c.height);
    for (let i = 0; i < n; i++) {
      const v = Math.min(255, diff[i] * 255 * 5);
      out.data[i*4] = v; out.data[i*4+1] = v; out.data[i*4+2] = v; out.data[i*4+3] = 255;
    }
    g.putImageData(out, 0, 0);
    return {
      mean: sum / n, max,
      moved: diff.reduce((a2, v) => a2 + (v > 0.04 ? 1 : 0), 0) / n,
      png: c.toDataURL('image/png').split(',')[1],
    };
  }, [on, off]);

  writeFileSync(`${OUT}/${WHAT}-${name}-diff.png`, Buffer.from(stats.png, 'base64'));
  writeFileSync(`${OUT}/${WHAT}-${name}-on.png`, Buffer.from(on, 'base64'));
  console.log(`${name.padEnd(9)} mean ${stats.mean.toFixed(4)}  max ${stats.max.toFixed(3)}  pixels moved >4% ${(stats.moved*100).toFixed(1)}%`);
}
await browser.close();
