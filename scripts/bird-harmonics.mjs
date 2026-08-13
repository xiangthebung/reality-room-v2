import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * DOES A BIRD IN THIS WOOD SOUND LIKE A BIRD, MEASURED THE WAY BIOLOGISTS
 * MEASURE IT?
 *
 * `fauna-audio.mjs` holds each voice under an analyser for five seconds and asks
 * whether anything is ringing. That is the right question for a buzz and it is
 * the wrong instrument for this one, because five seconds of a forest with one
 * call in it is nine parts wind: the whole spectral difference between a bird
 * and a synthesiser lands inside a two-hundred-millisecond note and is then
 * averaged away. Measured that way, halving the modulation index on twenty rows
 * moves the harsh column by two hundredths and looks like nothing.
 *
 * So this measures the note instead, and it measures the ONE number the
 * literature actually reports. A songbird does not merely have a weak second
 * harmonic by accident; it actively tunes its oropharyngeal-esophageal cavity so
 * the resonance TRACKS the fundamental as the note slides, which suppresses the
 * overtones the syrinx produces. The measurement (PNAS 2006,
 * pmc.ncbi.nlm.nih.gov/articles/PMC1459391) is f0 sitting 23 dB above 2f0 and 33
 * dB above 3f0. That is a number `wildlife.js` can be held to, and this file
 * holds it to it.
 *
 * HOW, AND WHY EACH PIECE IS THE WAY IT IS.
 *
 *   RENDERED OFFLINE, NOT LISTENED TO. Every voice is re-synthesised into an
 *   OfflineAudioContext through a stub engine — no panner, no distance
 *   low-pass, no far tail, no forest. What comes out is the note and nothing
 *   else, which is the only signal in which a 23 dB ratio is even visible.
 *   It is also exact and repeatable, where the live analyser is neither.
 *
 *   BAND ENERGY, NOT PEAK BINS, AND THE BANDS SCALE. Every note in this file
 *   slides — that is the entire design — so a partial is a smear rather than a
 *   line, and the smear at 2f0 is twice as wide as the one at f0. Reading peak
 *   bins would therefore understate every overtone by about 3 dB and flatter
 *   the result. The bands are ±1.5 semitones, which is a constant WIDTH IN
 *   RATIO, so a contour that moves a semitone is fully contained at f0, at 2f0
 *   and at 3f0 alike.
 *
 *   THE FUNDAMENTAL IS FOUND, NOT ASSUMED, AND THEN CHECKED AT HALF. Taking the
 *   loudest band as f0 would make the test circular in exactly the failure mode
 *   it exists to catch: at a modulation index of 1.1 the second harmonic is the
 *   loudest partial, so a naive search would lock onto it, measure 4f0 and 6f0,
 *   and report a beautifully pure bird. So after the peak is found the band an
 *   octave BELOW it is measured too, and if there is real energy down there the
 *   search drops to it. `subHarm` is that number, printed on every row.
 *
 *   WITH AND WITHOUT THE ONSET BREATH, AND MEASURED AS AN ATTACK RATHER THAN AS
 *   A SPECTRUM. `_note` puts six to nine milliseconds of band-passed pink noise
 *   at the front of every note. The obvious thing to do is read the harmonic
 *   ratios twice and call the difference the transient — and that is exactly
 *   what does not work, which is worth writing down because it is the trap this
 *   column was built in and then rebuilt out of.
 *
 *   The breath is broadband, so its energy is spread over about an octave and a
 *   half, and it lasts eight milliseconds against a note of a hundred and fifty.
 *   Both renders therefore come back with harmonic ratios identical to a tenth
 *   of a decibel — measured, on all twenty rows — and a reader would conclude
 *   the feature is not wired up. It is wired up; the ratios are simply the
 *   wrong instrument for it, in the same way five seconds of forest is the
 *   wrong instrument for the ratios.
 *
 *   So the transient is measured as what it is: `onset` is the peak inside the
 *   first twelve milliseconds of the note, in dB relative to the note's own
 *   peak. Without the breath that number is the envelope's attack ramp and sits
 *   far down; with it, it is the breath. The GAP between the two columns is the
 *   attack the change added, and it is the only place in this project where
 *   that is visible at all.
 *
 *   The two renders do NOT contain the same note, and the difference columns
 *   have to be read with that in mind: `_note` draws one random number for the
 *   breath's buffer offset, so the wet render is standing one step further
 *   along the shared rng stream and every per-note detune and gain roll after
 *   it differs. That is worth a few per cent on any level and it is why the
 *   thresholds below are in whole decibels.
 *
 *   node scripts/bird-harmonics.mjs
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

/**
 * The floor for 2f0, in dB below f0, and it is NOT the paper's 23.
 *
 * Three of the table's rows are deliberately not pure whistles — a bellbird
 * clangs, an aracari is a rusty hinge, an antshrike is nasal — and the roster
 * would be worse, not better, if they were held to a hooting motmot's spectrum.
 * The gate is therefore set to catch the failure this file was written after,
 * which is not "slightly bright" but "the fundamental is no longer the loudest
 * thing in its own note": at index 1.1 the aracari's 2f0 was within 4 dB of f0.
 * 8 dB passes every deliberate exception (index 0.55 is -10.9 dB before the
 * breath is added) and fails anything past about index 0.7.
 */
const MIN_2F0_DB = 8;
/**
 * How much energy may sit an octave BELOW the band picked as the fundamental.
 *
 * This is the anti-circularity guard rather than a taste, so it is loose: it
 * only has to separate "there is nothing down there" from "the search locked
 * onto the second harmonic". A real f0 band has 20-40 dB on the octave below it,
 * which is empty; a misidentified one has roughly 0.
 */
const MAX_SUB_DB = -10;

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

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });

/**
 * Render one voice's contact call offline and hand back the samples.
 *
 * `call` and not `_note`, deliberately: it is the shortest public path that
 * plays a row's own timbre — the table's `decay`, `index`, `arc`, `glide`,
 * `lead` and `warble`, with `shape.index` at 1 — so the thing measured is the
 * table rather than a reconstruction of it that can drift away from the table.
 *
 * 24 kHz is enough and not arbitrary: the highest root in the roster is 3.1 kHz
 * (the hermit), so 3f0 is 9.3 kHz and Nyquist at 12 kHz clears it. Halving the
 * sample rate halves the FFT.
 */
const render = await page.evaluate(async () => {
  const { Wildlife, VOICE_COUNT, VOICE_NAMES } = await import('/src/audio/wildlife.js');
  window.__names = VOICE_NAMES;
  window.__count = VOICE_COUNT;
  window.__render = async (voiceIndex, breath) => {
    const SR = 24000;
    const off = new OfflineAudioContext(1, Math.round(SR * 1.4), SR);
    /**
     * The stub. `Wildlife` reaches for exactly four things on its engine and
     * this is all four — a context, two buses and a spatial-source factory.
     * `worldBus` is left DANGLING on purpose: `_buildFarTail` terminates the
     * scattered path on it, and connecting it to the destination would put a
     * quarter of a second of woodland reverb into a measurement whose whole
     * point is that there is nothing in it but the note.
     */
    const engine = {
      ctx: off,
      worldBus: off.createGain(),
      sfxBus: off.createGain(),
      createSpatial() {
        const input = off.createGain();
        input.connect(off.destination);
        return { input, panner: {}, setDistance() {}, dispose() {} };
      },
    };
    const w = new Wildlife(engine);
    w.build();
    // The one guard `_note` already has on the onset transient, used as its
    // off switch. See the header.
    if (!breath) w.noise = null;
    // Well inside the 18 m the wet send starts at, so no second path exists
    // even if the stub above were ever connected.
    w.call({ x: 0, y: 0, z: -4 }, voiceIndex, 'contact');
    const buf = await off.startRendering();
    return { sr: SR, data: Array.from(buf.getChannelData(0)) };
  };
  return { count: VOICE_COUNT, names: VOICE_NAMES };
});

/** In-place iterative radix-2 FFT. Real input, complex in/out. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Power spectrum of the whole render, Hann-windowed, zero-padded to a power of two. */
function spectrum(data, sr) {
  let n = 1;
  while (n < data.length) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const len = data.length;
  for (let i = 0; i < len; i++) {
    // Hann over the OCCUPIED part only. Windowing the zero padding as well
    // would taper the note's tail against samples that are already silent.
    re[i] = data[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
  }
  fft(re, im);
  const half = n >> 1;
  const p = new Float64Array(half);
  for (let i = 0; i < half; i++) p[i] = re[i] * re[i] + im[i] * im[i];
  return { p, binHz: sr / n };
}

/** Energy in a ±1.5 semitone band about `fc`. See the header on why it scales. */
const EDGE = 2 ** (1.5 / 12);
function band(p, binHz, fc) {
  const lo = Math.max(1, Math.floor(fc / EDGE / binHz));
  const hi = Math.min(p.length - 1, Math.ceil((fc * EDGE) / binHz));
  let e = 0;
  for (let i = lo; i <= hi; i++) e += p[i];
  return e;
}

/**
 * Find the fundamental, then refuse to believe it if the octave below is loud.
 *
 * The candidate grid is a twelfth of a semitone, which is far finer than the
 * bands themselves — the bands overlap heavily and the maximum is therefore a
 * smooth function of the centre rather than a lottery between two grid points.
 */
function findF0(p, binHz) {
  let best = 0;
  let bestE = 0;
  for (let c = 150; c < 7000; c *= 2 ** (1 / 144)) {
    const e = band(p, binHz, c);
    if (e > bestE) {
      bestE = e;
      best = c;
    }
  }
  const subE = best / 2 >= 150 ? band(p, binHz, best / 2) : 0;
  const subDb = 10 * Math.log10((subE + 1e-30) / (bestE + 1e-30));
  // Loud enough down there that the peak was an overtone. Drop an octave and
  // report the correction rather than hiding it.
  if (subDb > MAX_SUB_DB) return { f0: best / 2, e0: subE, subDb, dropped: true };
  return { f0: best, e0: bestE, subDb, dropped: false };
}

/**
 * How loud the first twelve milliseconds of the note are against the whole of
 * it, in dB. See the header — this is the transient, measured as an attack.
 *
 * The note starts at `ctx.currentTime + 0.02` and the offline context starts at
 * zero, so 0.02 is exact rather than searched for. Twelve milliseconds is a
 * little wider than the breath's own six to nine so that the window cannot miss
 * it by a sample.
 */
function onsetDb(data, sr) {
  const from = Math.floor(0.02 * sr);
  const to = Math.min(data.length, Math.floor(0.032 * sr));
  let head = 0;
  let all = 0;
  for (let i = 0; i < data.length; i++) {
    const v = Math.abs(data[i]);
    if (v > all) all = v;
    if (i >= from && i < to && v > head) head = v;
  }
  return 20 * Math.log10((head + 1e-30) / (all + 1e-30));
}

function analyse({ sr, data }) {
  const { p, binHz } = spectrum(data, sr);
  const { f0, e0, subDb, dropped } = findF0(p, binHz);
  const e2 = 2 * f0 * EDGE < sr / 2 ? band(p, binHz, 2 * f0) : 0;
  const e3 = 3 * f0 * EDGE < sr / 2 ? band(p, binHz, 3 * f0) : 0;
  const db = (e) => 10 * Math.log10((e + 1e-30) / (e0 + 1e-30));
  return { f0, h2: db(e2), h3: db(e3), subDb, dropped, onset: onsetDb(data, sr) };
}

const rows = [];
for (let i = 0; i < render.count; i++) {
  const dry = analyse(await page.evaluate((v) => window.__render(v, false), i));
  const wet = analyse(await page.evaluate((v) => window.__render(v, true), i));
  rows.push({ name: render.names[i], dry, wet });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(
  pad('voice', 16),
  pad('f0', 10),
  pad('2f0', 9),
  pad('3f0', 9),
  pad('sub', 9),
  pad('onset off', 11),
  pad('onset on', 10),
  'attack'
);
for (const r of rows) {
  console.log(
    pad(r.name, 16),
    pad(`${r.dry.f0.toFixed(0)} Hz`, 10),
    pad(`${r.dry.h2.toFixed(1)} dB`, 9),
    pad(`${r.dry.h3.toFixed(1)} dB`, 9),
    pad(`${r.dry.subDb.toFixed(0)} dB${r.dry.dropped ? '!' : ''}`, 9),
    pad(`${r.dry.onset.toFixed(1)} dB`, 11),
    pad(`${r.wet.onset.toFixed(1)} dB`, 10),
    `+${(r.wet.onset - r.dry.onset).toFixed(1)} dB`
  );
}

/**
 * How much attack the breath must actually add, in dB, on the average row.
 *
 * A floor rather than a per-row number, because `lead` deliberately spreads
 * this: a tinamou is meant to swell out of nothing and legitimately gains
 * almost nothing here, while a kiskadee is meant to hit its note. The mean is
 * what says the feature is switched on at a level that does something, and it
 * is the number that would go to zero if a future edit set `ONSET_LEVEL` to
 * nought or broke the band-loss compensation — which is the failure this file
 * has already caught once, when the transient rendered 26 dB under the note and
 * every other instrument in the project reported that nothing had changed.
 */
const MIN_MEAN_ATTACK_DB = 4;

/**
 * ROWS WHOSE WHOLE NOTE FITS IN THE WINDOW CANNOT BE MEASURED THIS WAY, and
 * they are excluded rather than allowed to drag the mean down.
 *
 * A tanager's note is 55 ms with a 11 ms attack, a hermit's 50 with 10, a
 * honeycreeper's 60 with 12. For those three the note is already at or within a
 * decibel of its own peak twelve milliseconds in, so "the first twelve
 * milliseconds against the whole note" is 0 dB with the breath and 0 dB without
 * it, and the column is measuring the window rather than the transient. Their
 * breath is there — it is the same code path and `ONSET_LEVEL` does not know
 * what row it is on — it simply cannot be separated from the note by a fixed
 * window, and a shorter window would stop containing the breath.
 */
const MEASURABLE = (r) => r.dry.onset < -6;

const fails = [];
for (const r of rows) {
  if (r.dry.dropped) {
    fails.push(`${r.name}: the loudest partial was not the fundamental — index far too high`);
  }
  if (-r.dry.h2 < MIN_2F0_DB) {
    fails.push(
      `${r.name}: 2f0 only ${(-r.dry.h2).toFixed(1)} dB under f0 (floor ${MIN_2F0_DB}) — too rich`
    );
  }
}
const measurable = rows.filter(MEASURABLE);
const attack = measurable.reduce((s, r) => s + (r.wet.onset - r.dry.onset), 0) / measurable.length;
console.log(
  `\nmean attack added by the onset breath: ${attack.toFixed(1)} dB` +
    ` (over ${measurable.length} of ${rows.length} rows;` +
    ' the rest peak inside the window — see MEASURABLE)'
);
if (attack < MIN_MEAN_ATTACK_DB) {
  fails.push(
    `the onset breath adds only ${attack.toFixed(1)} dB of attack on average` +
      ` (floor ${MIN_MEAN_ATTACK_DB}) — it is not doing anything`
  );
}
if (problems.length) fails.push(...problems);

writeFileSync(`${OUT}/bird-harmonics.json`, JSON.stringify({ rows, fails }, null, 2));
console.log(fails.length ? `\nPROBLEMS:\n  ${fails.join('\n  ')}` : '\nno problems');
await browser.close();
process.exitCode = fails.length ? 1 : 0;
