import { chromium } from 'playwright';

/**
 * Can you hear a bird over the wood, in the band a bird occupies?
 *
 * Broadband RMS says no, because the wind and the stream are all below 1 kHz and
 * dominate the number. Song lives at 1.5–5 kHz. This fires the real wood's own
 * Wildlife at a set of distances and reports the in-band signal-to-noise.
 */
const URL = process.argv[2] ?? 'http://127.0.0.1:5180/';
const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.evaluate(() => {
  const g = document.getElementById('gate');
  if (g && !g.classList.contains('gone')) document.getElementById('enter')?.click();
});
await page.waitForFunction(() => window.RR.audio?.ctx != null && window.RR.audio.ready === true, {
  timeout: 25000,
});
await page.waitForTimeout(1500);

const res = await page.evaluate(async () => {
  const engine = window.RR.audio;
  window.RR.music?.stop?.();
  const w = window.RR.fauna.__wildlife;
  if (!w) return { error: 'no wildlife on fauna' };
  const ctx = engine.ctx;
  const an = ctx.createAnalyser();
  an.fftSize = 4096;
  an.smoothingTimeConstant = 0;
  engine.master.connect(an);
  const buf = new Float32Array(an.frequencyBinCount);
  const hz = ctx.sampleRate / 2 / buf.length;
  const lo = Math.round(1500 / hz);
  const hi = Math.round(5000 / hz);

  // Per-bin power, so a narrow bird is not diluted across 3.5 kHz of band.
  const snap = () => {
    an.getFloatFrequencyData(buf);
    const o = new Float64Array(hi - lo);
    for (let i = lo; i < hi; i++) o[i - lo] = Math.pow(10, buf[i] / 10);
    return o;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The bed: 3 s of whatever the wood is doing with no bird in it, per bin.
  const bed = new Float64Array(hi - lo);
  let n = 0;
  for (let i = 0; i < 90; i++) {
    const f = snap();
    for (let k = 0; k < bed.length; k++) bed[k] += f[k];
    n++;
    await sleep(33);
  }
  for (let k = 0; k < bed.length; k++) bed[k] = bed[k] / n + 1e-12;

  const out = [];
  for (const d of [8, 15, 25, 40, 60]) {
    // Four species, so the answer is not one contour's accident.
    for (const voice of [0, 3, 7, 12]) {
      const c = window.RR.camera.position;
      const at = { x: c.x, y: c.y + 2.5, z: c.z - d };
      let peak = 0;
      w.song(at, voice, { answer: false, throttle: false });
      const t0 = performance.now();
      while (performance.now() - t0 < 2600) {
        const f = snap();
        for (let k = 0; k < bed.length; k++) {
          const r = f[k] / bed[k];
          if (r > peak) peak = r;
        }
        await sleep(20);
      }
      out.push({ d, voice, snr: 10 * Math.log10(peak) });
      await sleep(400);
    }
  }
  return { bed, out };
});

if (res.error) {
  console.log('ERROR:', res.error);
} else {
  const byD = {};
  for (const r of res.out) (byD[r.d] ??= []).push(r.snr);
  console.log('\nin-band (1.5-5 kHz) peak over the bed, per song:');
  for (const [d, xs] of Object.entries(byD)) {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log(
      `  ${String(d).padStart(3)} m   ${mean.toFixed(1)} dB   (${xs.map((x) => x.toFixed(0)).join(', ')})`
    );
  }
}
await browser.close();
