import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * What the animals cost, measured against the same frame without them.
 *
 * A/B in ONE PAGE, at the same stations, in the same order, seconds apart —
 * because the absolute frame time from a headless browser is worth very little
 * (this is ANGLE on whatever the machine has, not the RX 9070 XT the budget was
 * written against) while the DIFFERENCE between two runs a few seconds apart on
 * the same context is worth a great deal.
 *
 * Draw calls and triangles are exact and hardware-independent, so they are the
 * numbers to quote. Getting them requires turning off three's per-render auto
 * reset: the pipeline renders the scene, then bloom, then glow, then the output
 * quad, and `info.render.calls` read at the end of a frame otherwise reports the
 * final full-screen triangle and nothing else. This resets once per FRAME, from
 * a rAF callback registered after main.js's, so the totals cover the whole
 * pipeline.
 *
 *   node scripts/fauna-perf.mjs
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots');
mkdirSync(OUT, { recursive: true });

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
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

/**
 * DEAFEN THE PAGE TO HOT RELOADS BEFORE IT LOADS.
 *
 * A save landing mid-run reloads the page and this measures the reload — a cold
 * world streaming its terrain in reads as a frame-time cliff that looks exactly
 * like the regression this script exists to catch. Silent, because a reloaded
 * page has no console problems. Same guard as play-check.mjs.
 */
await page.routeWebSocket(/.*/, () => {});

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
/**
 * The engine's own signal, because `attachAudio` FAILS QUIETLY without it.
 *
 * `fauna.js` guards with `if (!engine?.ready || wildlife) return`, so getting
 * here early does not throw — it builds a fauna with no voices in it and this
 * script then reports the cost of a mute wildlife as the cost of the wildlife.
 * The fixed 3000 ms that used to be here sat exactly on the boundary measured
 * on 2026-08-09 (not ready at 2 s, ready at 3 s), which is the worst place for
 * a number like that to sit: it under-reports at random and never says so.
 */
await page.waitForFunction(() => window.RR.audio?.ctx != null && window.RR.audio.ready === true, {
  timeout: 25000,
});
await page.waitForTimeout(1000);

await page.evaluate(() => {
  window.RR.renderer.info.autoReset = false;
  window.__f = [];
  window.__calls = [];
  window.__tris = [];
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    window.__f.push(now - last);
    last = now;
    const info = window.RR.renderer.info.render;
    window.__calls.push(info.calls);
    window.__tris.push(info.triangles);
    window.RR.renderer.info.reset();
    if (window.__fauna) {
      window.__fauna.update(1 / 60, {
        camera: window.RR.camera,
        tripLevel: window.RR.director.level,
        timeOfDay: 0.5,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const STATIONS = [
  { name: 'spawn', x: 0, z: 5, yaw: 0, pitch: -0.02, seek: null },
  { name: 'deep wood', x: -34, z: -46, yaw: 1.1, pitch: 0.02, seek: null },
  { name: 'canopy', x: -30, z: -40, yaw: 0.8, pitch: 0.72, seek: null },
  { name: 'peak', x: -34, z: -46, yaw: 1.1, pitch: 0.02, seek: 190 },
  { name: 'egodeath', x: -34, z: -46, yaw: 1.1, pitch: 0.02, seek: 220 },
];

async function sample(station) {
  await page.evaluate((s) => {
    const { director, controller } = window.RR;
    if (s.seek === null) director.ground();
    else director.seek(s.seek);
    controller.position.x = s.x;
    controller.position.z = s.z;
    controller.velocity.set(0, 0, 0);
    controller.yaw = s.yaw;
    controller.pitch = s.pitch;
  }, station);
  await page.waitForTimeout(1800);
  await page.evaluate(() => {
    window.__f.length = 0;
    window.__calls.length = 0;
    window.__tris.length = 0;
  });
  await page.waitForTimeout(4500);
  return page.evaluate(() => {
    const f = window.__f.slice().sort((a, b) => a - b);
    const at = (p) => f[Math.min(f.length - 1, Math.floor(f.length * p))] ?? 0;
    const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
    return {
      n: f.length,
      med: at(0.5),
      p95: at(0.95),
      calls: Math.round(mean(window.__calls)),
      tris: Math.round(mean(window.__tris)),
    };
  });
}

const before = [];
for (const s of STATIONS) before.push({ ...s, ...(await sample(s)) });

await page.evaluate(async () => {
  const { buildFauna } = await import('/src/world/fauna.js');
  const f = buildFauna({ scene: window.RR.scene, seed: 'grove-01', audio: window.RR.audio });
  f.setPixelRatio(window.RR.renderer.getPixelRatio());
  f.attachAudio(window.RR.audio, window.RR.music);
  window.__fauna = f;
});
await page.waitForTimeout(2500);

const after = [];
for (const s of STATIONS) after.push({ ...s, ...(await sample(s)) });

const pad = (s, n) => String(s).padEnd(n);
console.log(
  pad('station', 12),
  pad('med ms', 9),
  pad('+fauna', 9),
  pad('Δ ms', 8),
  pad('draws', 8),
  pad('+fauna', 8),
  pad('tris', 10),
  '+fauna'
);
const rows = [];
for (let i = 0; i < STATIONS.length; i++) {
  const a = before[i];
  const b = after[i];
  rows.push({ name: a.name, before: a, after: b });
  console.log(
    pad(a.name, 12),
    pad(a.med.toFixed(2), 9),
    pad(b.med.toFixed(2), 9),
    pad((b.med - a.med).toFixed(2), 8),
    pad(a.calls, 8),
    pad(`+${b.calls - a.calls}`, 8),
    pad(`${(a.tris / 1000).toFixed(0)}k`, 10),
    `+${((b.tris - a.tris) / 1000).toFixed(1)}k`
  );
}

writeFileSync(`${OUT}/fauna-perf.json`, JSON.stringify(rows, null, 2));
await browser.close();
