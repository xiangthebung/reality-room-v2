import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://127.0.0.1:5185/';
const SECONDS = Number(process.argv[3] ?? 40);

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
  /* music left playing */
  window.__events = [];
  const inner = engine.createSpatial.bind(engine);
  engine.createSpatial = (pos, opts) => {
    const stack = (new Error().stack || '').split('\n').slice(2, 8).join('|');
    const m = stack.match(/at ([A-Za-z_$][\w$.]*)/g) || [];
    const c = window.RR.camera.position;
    if (/Wildlife/.test(stack)) {
      window.__events.push({
        who: m.slice(0, 3).join(' < '),
        d: Math.hypot(pos.x - c.x, pos.y - c.y, pos.z - c.z),
        t: performance.now(),
      });
    }
    return inner(pos, opts);
  };
  const ctx = engine.ctx;
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  an.smoothingTimeConstant = 0;
  engine.master.connect(an);
  window.__an = { an, buf: new Float32Array(an.fftSize) };
  window.__trace = [];
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
    await new Promise((r) => setTimeout(r, 25));
  }
}, SECONDS);

const out = await page.evaluate(() => ({
  events: window.__events,
  trace: window.__trace,
  songGainNote: 'see wildlife.songGain',
  vol: {
    master: window.RR.audio.master?.gain?.value,
    world: window.RR.audio.trims?.world?.gain?.value,
    sfx: window.RR.audio.trims?.sfx?.gain?.value,
    music: window.RR.audio.trims?.music?.gain?.value,
  },
}));

const { events, trace, vol } = out;
console.log('\ntrims:', JSON.stringify(vol));

// Baseline: the quietest 20% of frames = the bed with nothing on it.
const rms = trace.map((f) => f.rms).sort((a, b) => a - b);
const bed = rms[Math.floor(rms.length * 0.2)];
const loud = rms[Math.floor(rms.length * 0.95)];
console.log(`bed rms (20th pct): ${bed.toFixed(5)}   95th pct: ${loud.toFixed(5)}`);

const byKind = {};
for (const e of events) {
  const k = e.who;
  (byKind[k] ??= []).push(e.d);
}
console.log(`\n${events.length} wildlife events in ${SECONDS}s:`);
for (const [k, ds] of Object.entries(byKind).sort((a, b) => b[1].length - a[1].length)) {
  const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
  console.log(
    `  ${String(ds.length).padStart(3)}  ${k}\n        distance m: min ${Math.min(...ds).toFixed(0)}  mean ${mean.toFixed(0)}  max ${Math.max(...ds).toFixed(0)}`
  );
}

// What does the master do in the 1.2 s after each event?
console.log('\nlevel around each event (peak in the 1.2s after, vs bed rms):');
let audible = 0;
for (const e of events) {
  const win = trace.filter((f) => f.t >= e.t && f.t < e.t + 1200);
  if (!win.length) continue;
  const p = Math.max(...win.map((f) => f.peak));
  const r = Math.max(...win.map((f) => f.rms));
  const ratio = r / bed;
  if (ratio > 1.35) audible++;
  console.log(
    `  d=${e.d.toFixed(0).padStart(3)}m  peak ${p.toFixed(4)}  rms ${r.toFixed(5)}  x${ratio.toFixed(2)} bed  ${e.who.split(' < ').slice(1).join('<')}`
  );
}
console.log(`\n  events that lifted the mix by >35%: ${audible}/${events.length}`);

await browser.close();
