import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Listen to the app, with numbers instead of ears.
 *
 * You cannot hear a headless browser, and "does it buzz" is exactly the kind of
 * question that a spectrum answers better than a description does. This taps the
 * master bus with an analyser and reports, at several points in a trip:
 *
 *   RMS / PEAK          is it a sensible level, and is anything clipping
 *   CENTROID            the spectral centre of mass, in Hz. A buzz is a bright,
 *                       harmonically dense sound, so a centroid that climbs into
 *                       the low thousands on an ambient patch is the symptom.
 *   HARSH               the fraction of total energy between 2 and 6 kHz, which
 *                       is where a resonant filter on a sawtooth lives and where
 *                       the ear is least forgiving.
 *   PEAKINESS           max bin over mean bin. A single narrow spike means
 *                       something is ringing — a resonant filter, or a feedback
 *                       path about to become one.
 *   FLATNESS            geometric mean over arithmetic mean. Near 1 is noise,
 *                       near 0 is a few strong partials.
 *
 * The thresholds at the bottom are what the rewrite was trying to achieve, so
 * this doubles as a regression test for the complaint that started it.
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
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
const problems = [];
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`[error] ${m.text()}`);
});

/**
 * DEAFEN THE PAGE TO HOT RELOADS BEFORE IT LOADS.
 *
 * Vite pushes HMR updates over a websocket, and a save landing mid-run
 * re-evaluates modules underneath a script that is halfway through a
 * measurement. The failure is silent: a reloaded page has no console problems,
 * so this would tap the analyser onto a master bus that no longer exists, or
 * average six seconds of a splash screen and call it an ambience. Every stage
 * below is a number that gets believed, so there is nothing to catch it. Same
 * guard as play-check.mjs, which documents what it cost.
 */
await page.routeWebSocket(/.*/, () => {});

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
/**
 * WAIT FOR THE ENGINE TO SAY IT IS READY, NOT FOR A NUMBER OF MILLISECONDS.
 *
 * `AudioEngine.start()` assigns `ctx` first and sets `ready` last, after the
 * whole graph is built — so `ctx != null` alone would let this connect to a
 * `master` that does not exist yet, and the conjunction is the actual
 * precondition. The fixed 2000 ms that used to be here failed 3 runs in 6 on
 * 2026-08-09 with `Cannot read properties of null (reading 'createAnalyser')`:
 * the engine now becomes ready somewhere between 2 and 3 seconds after the
 * click, so the margin had gone negative and nobody had touched this file.
 * A condition cannot go stale as the boot gets slower. The second wait is for
 * the graph to settle into a steady state, which is a real duration rather than
 * an event, so it stays a sleep.
 */
await page.waitForFunction(() => window.RR.audio?.ctx != null && window.RR.audio.ready === true, {
  timeout: 25000,
});
await page.waitForTimeout(1000);

// Install the probe on the master bus.
await page.evaluate(() => {
  const engine = window.RR.audio;
  const ctx = engine.ctx;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  engine.master.connect(analyser);
  const freq = new Float32Array(analyser.frequencyBinCount);
  const time = new Float32Array(analyser.fftSize);
  window.__probe = { ctx, analyser, freq, time };
});

/** Average the spectrum over `ms`, then reduce it to a handful of numbers. */
async function measure(label, ms = 6000) {
  const result = await page.evaluate(async (duration) => {
    const { ctx, analyser, freq, time } = window.__probe;
    const bins = analyser.frequencyBinCount;
    const acc = new Float64Array(bins);
    let frames = 0;
    let peak = 0;
    let sumSq = 0;
    let samples = 0;
    let clipped = 0;
    const started = performance.now();
    while (performance.now() - started < duration) {
      analyser.getFloatFrequencyData(freq);
      analyser.getFloatTimeDomainData(time);
      for (let i = 0; i < bins; i++) acc[i] += Math.pow(10, freq[i] / 20);
      for (let i = 0; i < time.length; i++) {
        const v = Math.abs(time[i]);
        if (v > peak) peak = v;
        if (v >= 0.999) clipped++;
        sumSq += time[i] * time[i];
        samples++;
      }
      frames++;
      await new Promise((r) => setTimeout(r, 40));
    }
    const nyquist = ctx.sampleRate / 2;
    const binHz = nyquist / bins;
    let total = 0;
    let weighted = 0;
    let harsh = 0;
    let maxBin = 0;
    let logSum = 0;
    for (let i = 1; i < bins; i++) {
      const m = acc[i] / Math.max(1, frames);
      total += m;
      weighted += m * i * binHz;
      const hz = i * binHz;
      if (hz >= 2000 && hz <= 6000) harsh += m;
      if (m > maxBin) maxBin = m;
      logSum += Math.log(m + 1e-12);
    }
    const mean = total / (bins - 1);
    const geo = Math.exp(logSum / (bins - 1));
    return {
      rms: Math.sqrt(sumSq / Math.max(1, samples)),
      peak,
      clipped,
      centroid: total > 0 ? weighted / total : 0,
      harsh: total > 0 ? harsh / total : 0,
      peakiness: mean > 0 ? maxBin / mean : 0,
      flatness: mean > 0 ? geo / mean : 0,
      frames,
    };
  }, ms);
  return { label, ...result };
}

const rows = [];

rows.push(await measure('sober + music'));

/**
 * Every track on its own, sober.
 *
 * The trip stages below all run on whichever record happens to be loaded, so a
 * single bright track could sit in the playlist for months without any of them
 * noticing. That mattered the moment the jukebox stopped being four variations
 * on the same ambient patch: the two imported from the previous project are a
 * lounge groove and a driving arpeggio, they are the only things on the machine
 * with a snare and hats in them, and they came from the build whose audio was
 * rejected for buzzing. They get measured individually or the thresholds at the
 * bottom of this file are not actually guarding anything.
 */
const totalTracks = await page.evaluate(() => window.RR.music.trackCount);
for (let i = 0; i < totalTracks; i++) {
  const name = await page.evaluate((index) => {
    window.RR.music.setTrack(index);
    return window.RR.music.trackName;
  }, i);
  // Two bars at the slowest tempo on the machine, so the measurement covers a
  // whole chord cycle rather than whichever hit it happened to land on.
  await page.waitForTimeout(1200);
  rows.push(await measure(`♪ ${name}`, 5000));
}
await page.evaluate(() => window.RR.music.setTrack(0));
await page.waitForTimeout(800);

await page.evaluate(() => window.RR.director.seek(24));
await page.waitForTimeout(1500);
rows.push(await measure('comeup'));

await page.evaluate(() => window.RR.director.seek(80));
await page.waitForTimeout(1500);
rows.push(await measure('onset'));

await page.evaluate(() => window.RR.director.seek(160));
await page.waitForTimeout(2500);
const atPeak = await page.evaluate(() => ({
  droneVoices: window.RR.tripAudio?.nodes?.voices?.length ?? 0,
  tempoScale: window.RR.music?.tempoScale,
  detune: window.RR.music?.detune,
  wet: window.RR.tripAudio?.nodes?.wet.gain.value,
}));
rows.push(await measure('peak'));

await page.evaluate(() => window.RR.director.seek(220));
await page.waitForTimeout(2500);
rows.push(await measure('egodeath'));

await page.evaluate(() => {
  window.RR.director.ground();
  window.RR.music.stop();
});
await page.waitForTimeout(2500);
rows.push(await measure('ambience only'));

const jukebox = await page.evaluate(() => ({
  tracks: window.RR.music ? window.RR.music.constructor.name : null,
  tempoScale: window.RR.music?.tempoScale,
  detune: window.RR.music?.detune,
  droneVoices: window.RR.tripAudio?.nodes?.voices?.length ?? 0,
}));

const pad = (s, n) => String(s).padEnd(n);
console.log(
  pad('stage', 16),
  pad('rms', 8),
  pad('peak', 8),
  pad('centroid', 10),
  pad('harsh', 8),
  pad('peaky', 8),
  pad('flat', 8),
  'clip'
);
for (const r of rows) {
  console.log(
    pad(r.label, 16),
    pad(r.rms.toFixed(4), 8),
    pad(r.peak.toFixed(3), 8),
    pad(`${r.centroid.toFixed(0)} Hz`, 10),
    pad(r.harsh.toFixed(3), 8),
    pad(r.peakiness.toFixed(0), 8),
    pad(r.flatness.toFixed(3), 8),
    r.clipped
  );
}
console.log('\njukebox:', jukebox);

const fails = [];
for (const r of rows) {
  if (r.clipped > 0) fails.push(`${r.label}: ${r.clipped} clipped samples`);
  if (r.peak > 0.999) fails.push(`${r.label}: peak at full scale (${r.peak.toFixed(3)})`);
  // A buzz is bright and dense. Nothing in this app should sit up there.
  if (r.centroid > 2600) fails.push(`${r.label}: spectral centroid ${r.centroid.toFixed(0)} Hz — too bright`);
  // Only meaningful where there is something to be harsh ABOUT. Below this
  // level the residual is wind and water, which is broadband by nature: 36% of
  // almost nothing is a quiet forest, not a buzz.
  if (r.rms > 0.03 && r.harsh > 0.3) fails.push(`${r.label}: ${(r.harsh * 100).toFixed(0)}% of energy in 2–6 kHz`);
  if (r.rms > 0 && r.rms < 0.0005) fails.push(`${r.label}: effectively silent (rms ${r.rms})`);
}
if (problems.length) fails.push(...problems);

writeFileSync(`${OUT}/audio.json`, JSON.stringify({ rows, jukebox, atPeak, fails }, null, 2));
if (fails.length) {
  console.log('\nPROBLEMS:');
  for (const f of fails) console.log(' ', f);
} else {
  console.log('\nno problems');
}

await browser.close();
