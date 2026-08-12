import { chromium } from 'playwright';

/**
 * What the player actually hears from the birds, in the running game.
 *
 * `fauna-audio.mjs` builds its own Wildlife and forces events into it, so it has
 * never heard the app's own wood. This wraps the live engine's `createSpatial`
 * and reads the stack — in a dev build that names the wildlife.js method that
 * asked for it — then reports the DISTANCE distribution, which is the number
 * that decides whether any of it is audible at all.
 */
const URL = process.argv[2] ?? 'http://127.0.0.1:5180/';
const SECONDS = Number(process.argv[3] ?? 45);
const LABEL = process.argv[4] ?? URL;

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
const seen = new Set();
page.on('pageerror', (e) => {
  if (seen.has(e.message)) return;
  seen.add(e.message);
  console.log('[pageerror]', e.message);
});

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.evaluate(() => {
  const gate = document.getElementById('gate');
  if (gate && !gate.classList.contains('gone')) document.getElementById('enter')?.click();
});
await page.waitForFunction(() => window.RR.audio?.ctx != null && window.RR.audio.ready === true, {
  timeout: 25000,
});
await page.waitForTimeout(1500);

await page.evaluate(() => {
  const engine = window.RR.audio;
  // The record would mask everything and is not what is being measured.
  window.RR.music?.stop?.();
  window.__events = [];
  const inner = engine.createSpatial.bind(engine);
  engine.createSpatial = (pos, opts) => {
    const stack = (new Error().stack || '').split('\n').slice(2, 9).join('|');
    if (/Wildlife/.test(stack)) {
      const m = stack.match(/at ([A-Za-z_$][\w$.]*)/g) || [];
      const c = window.RR.camera.position;
      window.__events.push({
        who: m.slice(1, 3).join('<').replace(/at |Wildlife\./g, ''),
        d: Math.hypot(pos.x - c.x, pos.y - c.y, pos.z - c.z),
        t: performance.now(),
      });
    }
    return inner(pos, opts);
  };
  const an = engine.ctx.createAnalyser();
  an.fftSize = 2048;
  an.smoothingTimeConstant = 0;
  engine.master.connect(an);
  window.__an = { an, buf: new Float32Array(an.fftSize) };
  window.__trace = [];
  // How many perchers are close enough to see, sampled alongside the audio.
  window.__nearSeen = [];
});

await page.evaluate(async (secs) => {
  const { an, buf } = window.__an;
  const t0 = performance.now();
  while (performance.now() - t0 < secs * 1000) {
    an.getFloatTimeDomainData(buf);
    let peak = 0;
    let sq = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i]);
      if (v > peak) peak = v;
      sq += buf[i] * buf[i];
    }
    window.__trace.push({ t: performance.now(), peak, rms: Math.sqrt(sq / buf.length) });
    const c = window.RR.camera.position;
    const ps = window.RR.fauna.__perchers ?? [];
    let within40 = 0;
    let within20 = 0;
    let flying = 0;
    for (const p of ps) {
      const d = Math.hypot(p.pos.x - c.x, p.pos.z - c.z);
      if (d < 40) within40++;
      if (d < 20) within20++;
      if (p.state !== 'perch') flying++;
    }
    window.__nearSeen.push({ within40, within20, flying, total: ps.length });
    await new Promise((r) => setTimeout(r, 25));
  }
}, SECONDS);

const out = await page.evaluate(() => ({
  events: window.__events,
  trace: window.__trace,
  near: window.__nearSeen,
}));

const { events, trace, near } = out;
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const rms = trace.map((f) => f.rms).sort((a, b) => a - b);
const bed = rms[Math.floor(rms.length * 0.2)];

console.log(`\n=== ${LABEL} — ${SECONDS}s standing still, music off ===`);
console.log(
  `perchers within 40 m: ${avg(near.map((n) => n.within40)).toFixed(1)} of ${near[0]?.total ?? 0}` +
    `   within 20 m: ${avg(near.map((n) => n.within20)).toFixed(1)}` +
    `   in flight: ${avg(near.map((n) => n.flying)).toFixed(2)}`
);

const perMin = (n) => ((n / SECONDS) * 60).toFixed(1);
console.log(`\nbird events: ${events.length} (${perMin(events.length)}/min)`);
const bins = [10, 20, 30, 45, 65, 100, 1e9];
const labels = ['<10m', '10-20', '20-30', '30-45', '45-65', '65-100', '100m+'];
const hist = new Array(bins.length).fill(0);
for (const e of events) hist[bins.findIndex((b) => e.d < b)]++;
console.log('distance histogram:');
for (let i = 0; i < hist.length; i++) {
  if (!hist[i]) continue;
  console.log(`  ${labels[i].padEnd(7)} ${'#'.repeat(hist[i])} ${hist[i]}`);
}
const nearEv = events.filter((e) => e.d < 30);
console.log(
  `\n  WITHIN 30 m (the range the trees let you hear detail at): ` +
    `${nearEv.length} (${perMin(nearEv.length)}/min)`
);
console.log(`  mean distance of all bird events: ${avg(events.map((e) => e.d)).toFixed(0)} m`);

const byKind = {};
for (const e of events) (byKind[e.who] ??= []).push(e.d);
console.log('\nby kind:');
for (const [k, ds] of Object.entries(byKind).sort((a, b) => b[1].length - a[1].length)) {
  console.log(
    `  ${String(ds.length).padStart(3)}  ${k.padEnd(24)} mean ${avg(ds).toFixed(0)} m, nearest ${Math.min(...ds).toFixed(0)} m`
  );
}

let lifted = 0;
for (const e of events) {
  const win = trace.filter((f) => f.t >= e.t && f.t < e.t + 1200);
  if (win.length && Math.max(...win.map((f) => f.rms)) / bed > 1.5) lifted++;
}
console.log(`\nbed rms ${bed.toFixed(5)};  events that lifted it by half again: ${lifted}/${events.length}`);

await browser.close();
