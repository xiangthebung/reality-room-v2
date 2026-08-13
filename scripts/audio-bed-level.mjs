import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * WHERE THE BED SITS AGAINST THE LAYERS IT IS REPLACING, AT SEVERAL GAINS.
 *
 * `manifest.gain` is the one number nobody can derive from first principles: it
 * decides whether the recorded far chorus is the floor of the wood or the whole
 * of it. This produces the evidence to choose it from, rather than choosing it.
 *
 * FOUR LAYERS, MEASURED AT THEIR OWN OUTPUT NODES RATHER THAN BY MUTING.
 *
 *   the bed          `AmbienceBed.output`
 *   the wind         `windGain` + `windLowGain`, summed in power
 *   the insect wall  `cicadaGain` + `katydidGain`, summed in power
 *   everything       `AudioEngine.master`
 *
 * All four taps sit at the same place in the graph — an analyser hung off a
 * node, upstream of the buses — so their levels are directly comparable without
 * anything being switched off. Muting layers to measure them is what the first
 * version did and it is worse: `ambience.js` cross-couples (the insect wall
 * ducks under rain, the bed ducks the wind), so silencing one moves another and
 * the numbers stop describing the mix that actually plays.
 *
 * EVERY GAIN IS MEASURED IN ONE SESSION, and that is not only for speed.
 * `fauna-audio.mjs` documents a 3.2 dB swing on identical code across runs, and
 * names load as a cause — "later, slower runs read quieter". Four separate runs
 * would put that swing between the rows of this table, which is larger than the
 * differences being measured. Sweeping inside one page load makes the
 * comparison a difference rather than four absolutes.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is decide. The composite ceiling that the
 * gain has to respect lives in `check:fauna-audio`, which is a seven-minute run
 * and is the authority; this script prints a `master` column under the same
 * music-and-trip-peak conditions as a fast proxy for it, and the real gate is
 * run separately at the shortlisted gains.
 *
 *   node scripts/audio-bed-level.mjs
 *   node scripts/audio-bed-level.mjs --gains=0.2,0.3,0.45,0.6
 *
 * Run against `npm run dev` on 5180, with beds present in public/audio/beds/.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL_ = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots');
mkdirSync(OUT, { recursive: true });
const GAINS = (args.gains ?? '0,0.2,0.3,0.45,0.6').split(',').map(Number);

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
await page.routeWebSocket(/.*/, () => {});

await page.goto(URL_, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForFunction(() => window.RR.audio?.ready === true, { timeout: 25000 });
const haveBed = await page
  .waitForFunction(() => window.RR.ambienceBed != null, { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
if (!haveBed) {
  console.log('No bed loaded. Run `npm run audio:bed-make` first.');
  await browser.close();
  process.exit(0);
}
/**
 * THIRTY SECONDS BEFORE ANYTHING IS MEASURED, and the first version of this
 * script did not wait and reported nonsense because of it.
 *
 * `ambience.js` writes its insect wall with a SIX-SECOND time constant — the
 * slowest parameter in the project, deliberately, because a bed that can be
 * caught changing is a fader. From a cold page load that layer is climbing from
 * zero for the best part of half a minute, so a sweep that starts at three
 * seconds measures the cicadas arriving and attributes it to whatever the bed
 * gain happened to be on that row. Measured: the insect column rose 0.0057 ->
 * 0.0067 -> 0.0074 across the first three rows, monotonically, on a layer that
 * does not depend on the bed gain at all.
 */
await page.waitForTimeout(30000);

await page.evaluate(() => {
  const RR = window.RR;
  const ctx = RR.audio.ctx;
  const amb = RR.ambience;
  const tap = (node) => {
    const a = ctx.createAnalyser();
    a.fftSize = 4096;
    a.smoothingTimeConstant = 0;
    node.connect(a);
    return a;
  };
  window.__lv = {
    ctx,
    bed: tap(RR.ambienceBed.output),
    wind: tap(amb.windGain),
    windLow: tap(amb.windLowGain),
    cicada: tap(amb.cicadaGain),
    katydid: tap(amb.katydidGain),
    master: tap(RR.audio.master),
    time: new Float32Array(4096),
    freq: new Float32Array(2048),
  };
});

/**
 * @param {number} ms
 * @returns rms per tap, plus centroid/harsh/peak on the master
 */
async function measure(ms) {
  return page.evaluate(async (duration) => {
    const L = window.__lv;
    const names = ['bed', 'wind', 'windLow', 'cicada', 'katydid', 'master'];
    const sumSq = Object.fromEntries(names.map((n) => [n, 0]));
    let samples = 0;
    let peak = 0;
    const bins = L.master.frequencyBinCount;
    const acc = new Float64Array(bins);
    let frames = 0;
    const started = performance.now();
    while (performance.now() - started < duration) {
      for (const n of names) {
        L[n].getFloatTimeDomainData(L.time);
        let s = 0;
        for (let i = 0; i < L.time.length; i++) {
          const v = L.time[i];
          s += v * v;
          if (n === 'master' && Math.abs(v) > peak) peak = Math.abs(v);
        }
        sumSq[n] += s / L.time.length;
      }
      L.master.getFloatFrequencyData(L.freq);
      for (let i = 0; i < bins; i++) acc[i] += Math.pow(10, L.freq[i] / 20);
      frames++;
      samples++;
      await new Promise((r) => setTimeout(r, 30));
    }
    const nyq = L.ctx.sampleRate / 2;
    const binHz = nyq / bins;
    let total = 0;
    let weighted = 0;
    let harsh = 0;
    for (let i = 1; i < bins; i++) {
      const m = acc[i] / Math.max(1, frames);
      const hz = i * binHz;
      total += m;
      weighted += m * hz;
      if (hz >= 2000 && hz <= 6000) harsh += m;
    }
    const out = {};
    for (const n of names) out[n] = Math.sqrt(sumSq[n] / Math.max(1, samples));
    out.peak = peak;
    out.centroid = total > 0 ? weighted / total : 0;
    out.harsh = total > 0 ? harsh / total : 0;
    return out;
  }, ms);
}

/**
 * Put the bed at `g` without waiting out its own ramp.
 *
 * `Deck.tick` writes `out.gain` with a `setTargetAtTime` whose time constant is
 * six seconds — deliberately, because a bed that can be caught changing is a
 * fader rather than a place. Five constants is thirty seconds per row, which is
 * two and a half minutes of this script spent on exponentials.
 *
 * So the target is set AND the current value is forced to it. From the next
 * frame on, `tick`'s `setTargetAtTime` is asked to move a parameter from a value
 * to that same value, which is a no-op — the ramp is not bypassed or patched,
 * it simply has nowhere to go. The audio path under measurement is untouched.
 */
async function setGain(g) {
  await page.evaluate((gain) => {
    window.RR.ambienceBed.gain = gain;
  }, g);
  // One frame of main.js's own loop, so every deck's `target` reflects the new
  // layer gain against its current slot weight.
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    const bed = window.RR.ambienceBed;
    const now = bed.ctx.currentTime;
    for (const d of bed.decks) {
      d.out.gain.cancelScheduledValues(now);
      d.out.gain.value = d.target;
    }
  });
}

/**
 * EVERY GAIN IS VISITED SEVERAL TIMES AND THE MEDIAN IS REPORTED.
 *
 * One pass is not enough, and the reason is the one `record-space.mjs` spends
 * four failed attempts on: the rest of the mix is not steady even when nothing
 * is being changed. The jukebox is generative, the trip's five drone voices each
 * have their own amplitude LFO between 0.017 and 0.085 Hz — periods of twelve to
 * sixty seconds — and the wind follows a slow gust sine nothing here can stop. A
 * single pass samples each gain at a different point in all of those cycles, so
 * the drift lands between the rows as if it were the thing being measured. The
 * first run of this script duly reported the master level FALLING from 0.175 to
 * 0.135 as the bed was turned UP from 0 to 0.2.
 *
 * Three interleaved passes and a median per gain does not remove the drift; it
 * stops it correlating with the gain, which is all the columns need.
 */
const PASSES = Number(args.passes ?? 3);
const raw = [];
const medianOf = (list, key) => {
  const v = list.map((r) => r[key]).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
};
const KEYS = ['bed', 'wind', 'windLow', 'cicada', 'katydid', 'master', 'peak', 'centroid', 'harsh'];
function reduce(phase) {
  for (const g of GAINS) {
    const mine = raw.filter((r) => r.phase === phase && r.gain === g);
    const out = { gain: g, phase, passes: mine.length };
    for (const k of KEYS) out[k] = medianOf(mine, k);
    rows.push(out);
  }
}

const rows = [];
console.log(`bed level sweep — gains ${GAINS.join(', ')}\n`);

// ---- phase A: sober, no music -------------------------------------------
for (let p = 0; p < PASSES; p++) {
  for (const g of GAINS) {
    await setGain(g);
    // Two seconds for the snap to settle through the analysers' own windows.
    await page.waitForTimeout(2000);
    const m = await measure(4000);
    raw.push({ gain: g, phase: 'sober', ...m });
  }
}
reduce('sober');

// ---- phase B: the jukebox running and the trip at its peak ---------------
// The same conditions `check:fauna-audio`'s `all + music + peak` row sets up,
// minus the wildlife burst — see the header on why this is a proxy and not the
// gate.
await page.evaluate(() => {
  window.RR.music.start();
  window.RR.director.seek(190);
});
await page.waitForTimeout(6000);
for (let p = 0; p < PASSES; p++) {
  for (const g of GAINS) {
    await setGain(g);
    await page.waitForTimeout(2000);
    const m = await measure(4000);
    raw.push({ gain: g, phase: 'music+peak', ...m });
  }
}
reduce('music+peak');

const dB = (a, b) => (a > 0 && b > 0 ? 20 * Math.log10(a / b) : NaN);
const f = (v, n = 5) => (Number.isFinite(v) ? v.toFixed(n) : '—');
const sdb = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}` : '—');

for (const phase of ['sober', 'music+peak']) {
  const rs = rows.filter((r) => r.phase === phase);
  console.log(`\n${phase.toUpperCase()}`);
  console.log(
    ' ',
    'gain'.padEnd(7),
    'bed rms'.padEnd(10),
    'wind rms'.padEnd(10),
    'insects'.padEnd(10),
    'bed vs wind'.padEnd(12),
    'bed vs ins'.padEnd(12),
    'master'.padEnd(9),
    'centroid'.padEnd(10),
    'harsh'
  );
  for (const r of rs) {
    const wind = Math.sqrt(r.wind * r.wind + r.windLow * r.windLow);
    const ins = Math.sqrt(r.cicada * r.cicada + r.katydid * r.katydid);
    console.log(
      ' ',
      String(r.gain).padEnd(7),
      f(r.bed).padEnd(10),
      f(wind).padEnd(10),
      f(ins).padEnd(10),
      `${sdb(dB(r.bed, wind))} dB`.padEnd(12),
      `${sdb(dB(r.bed, ins))} dB`.padEnd(12),
      f(r.master, 4).padEnd(9),
      `${r.centroid.toFixed(0)} Hz`.padEnd(10),
      r.harsh.toFixed(3)
    );
  }
}

console.log('\nnotes:');
console.log('  wind    = windGain + windLowGain, summed in power. Ducks as the bed rises.');
console.log('  insects = cicadaGain + katydidGain, likewise. Both ducks are the manifest\'s.');
console.log('  master  = the whole mix at AudioEngine.master. The gate is check:fauna-audio, not this.');
if (problems.length) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log(' ', p);
}
writeFileSync(`${OUT}/audio-bed-level.json`, JSON.stringify({ rows, raw, problems }, null, 2));
await browser.close();
