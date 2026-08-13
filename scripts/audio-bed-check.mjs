import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * DOES THE STREAMED BED ACTUALLY STREAM, AND IS ITS LOOP ACTUALLY SEAMLESS.
 *
 * Four claims are made in `src/audio/bed.js`'s header and every one of them is
 * the kind that is easy to believe and hard to notice being wrong. This is the
 * only script in the repo that can see any of them.
 *
 *   1. IT STREAMS. `decodeAudioData` is patched before the page loads and its
 *      call count is asserted at zero, and `createBuffer` is patched too so that
 *      the longest AudioBuffer anybody made can be printed next to the bed's own
 *      duration. A bed that had been decoded would show up as a buffer of
 *      exactly its length. The RAM this avoids is computed from the context's
 *      real sample rate rather than assumed.
 *
 *   2. THE LOOP IS SEAMLESS. An analyser is tapped onto the deck's own summing
 *      node — post-crossfade, post-seam-trim, pre-level — and its RMS is sampled
 *      across a full loop period. The seam is then compared against the steady
 *      state IN dB. This is the measurement `npm run audio` structurally cannot
 *      make: it takes 6-second windows at arbitrary moments, and a seam is two
 *      seconds once a loop.
 *
 *   3. THE LEVEL IS RIGHT, i.e. equal-power crossfading has not quietly added
 *      3 dB. Same measurement as 2 — a correlated seam reads as +3.01 dB at its
 *      midpoint and an uncorrelated one reads as 0.0. `--curve` proves the
 *      measurement can see it; see below.
 *
 *   4. THE WIND IS DUCKED AND NOT DELETED. The synthesised wind's gain is read
 *      with the manifest's duck applied and again with it removed at source, and
 *      the ratio is checked against what the manifest declares.
 *
 * `--curve` IS THE PROOF THAT 2 AND 3 ARE REAL TESTS.
 *
 * A seam measurement that has only ever seen a passing build is a measurement
 * nobody has tested — the same argument `record-space.mjs` makes for its `--old`
 * flag. This one replaces the deck's crossfade curves in the page and checks that
 * the reported error is what the arithmetic says it must be:
 *
 *   --curve=linear   equal-AMPLITUDE ramps, which is the mistake `bed.js` spends
 *                    a paragraph rejecting. Mean power over the window is
 *                    P·mean((1-t)² + t²) = 2P/3, i.e. -1.76 dB.
 *
 *   --curve=both     both decks held at unity through the fade. Two uncorrelated
 *                    signals of equal power sum to 2P, i.e. +3.01 dB. This is the
 *                    positive control, and it is what a fully correlated pair
 *                    would do to a correct equal-power fade at its midpoint.
 *
 * BOTH ARE INDEPENDENT OF PHASE AND OF THE MATERIAL, which is why they are patches
 * to the curve rather than a specially-built file.
 *
 * IT IS MEASURED AS A DELTA WITHIN ONE RUN, AND THAT IS THE PART THAT TOOK THREE
 * ATTEMPTS. A control run measures three seams with the real curve, patches the
 * curve in place, and measures three more — then subtracts. The absolute reading
 * cannot be compared against the theory directly, because the references either
 * side of a fade are at DIFFERENT FILE POSITIONS from the fade itself: the last
 * two seconds of the loop and the first two are, by construction, only ever heard
 * inside a crossfade, so the material's own level there is never observable on
 * its own. On the placeholder that offset is a consistent -0.9 dB, which is why a
 * linear fade measured -3.14 dB against a prediction of -1.76 and looked like a
 * failure of the player. Subtracting a baseline taken in the same session, on the
 * same file, at the same positions, cancels it exactly.
 *
 * A FOURTH APPROACH IS DOCUMENTED BECAUSE IT LOOKED RIGHT AND WAS NOT. Before the
 * curve patch there was a bed containing a steady tone locked to a whole number
 * of cycles across the file, on the theory that its head and tail would therefore
 * be correlated. They are not reliably: `currentTime = x` on a compressed stream
 * seeks to a page boundary, not a sample, so the tone's phase at the seam is
 * randomised by several milliseconds and a 220 Hz tone lands anywhere in the
 * cycle. Measured, it read -1.03, -1.27 and +0.55 dB on three consecutive seams
 * of the same file. The average of a random-phase sum is exactly the uncorrelated
 * sum, so that control was, on average, testing nothing.
 *
 *   node scripts/audio-bed-check.mjs --curve=linear    expect a delta of -1.76 dB
 *   node scripts/audio-bed-check.mjs --curve=both      expect a delta of +3.01 dB
 *
 * Run against `npm run dev` on 5180. Nothing here touches the network beyond the
 * dev server, and no third-party audio exists in this repo to touch.
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
 * PATCHED BEFORE THE PAGE EXISTS, WHICH IS THE ONLY MOMENT THAT WORKS.
 *
 * `addInitScript` runs before any of the app's own script does, so this sees
 * every call from the first line of main.js onward. Doing it after `goto` would
 * miss the impulse responses and the four pink-noise beds, which are exactly the
 * calls that make the "no buffer of that length" assertion meaningful — a count
 * that never sees the legitimate buffers cannot show that it would have seen an
 * illegitimate one.
 */
await page.addInitScript(() => {
  window.__bedSpy = { decodes: 0, buffers: [], longest: 0 };
  const AC = window.AudioContext ?? window.webkitAudioContext;
  const decode = AC.prototype.decodeAudioData;
  AC.prototype.decodeAudioData = function (...a) {
    window.__bedSpy.decodes++;
    return decode.apply(this, a);
  };
  const create = AC.prototype.createBuffer;
  AC.prototype.createBuffer = function (ch, len, rate) {
    const seconds = len / rate;
    window.__bedSpy.buffers.push({ ch, seconds: Number(seconds.toFixed(3)) });
    if (seconds > window.__bedSpy.longest) window.__bedSpy.longest = seconds;
    return create.call(this, ch, len, rate);
  };
});

// Same guard as every other measuring script here — see play-check.mjs.
await page.routeWebSocket(/.*/, () => {});

await page.goto(URL_, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForFunction(() => window.RR.audio?.ctx != null && window.RR.audio.ready === true, {
  timeout: 25000,
});

/**
 * The bed arrives on a dynamic import and a fetch, so it is not there on the
 * frame the gate drops and it is ALLOWED never to arrive. A stock checkout has
 * no `public/audio/beds/` in it, which is the whole reason `AmbienceBed.load`
 * returns null — so "no bed" is reported as a skip rather than as a failure.
 */
const havBed = await page
  .waitForFunction(() => window.RR.ambienceBed != null, { timeout: 15000 })
  .then(() => true)
  .catch(() => false);

if (!havBed) {
  console.log(
    'No bed loaded — public/audio/beds/manifest.json is absent or lists nothing this\n' +
      'browser can play. That is the normal state of a stock checkout: no third-party\n' +
      'recording has been licensed. Run `node scripts/audio-bed-make.mjs` first to\n' +
      'generate the synthesised placeholder, then run this again.'
  );
  await browser.close();
  process.exit(0);
}

/** The two known-wrong crossfades and what each must do to the mean. See header. */
const CURVES = {
  linear: { expect: -1.76 },
  both: { expect: 3.01 },
  /**
   * Not a pass/fail control — a decomposition, and the only way to answer "are
   * the two decks correlated across the fade" with a number.
   *
   * It measures four curves in one session, so all four share a baseline, a file
   * and a set of seam positions: the real equal-power fade, then the outgoing
   * deck alone at unity, then the incoming deck alone at unity, then both. That
   * gives Pa and Pb AT THE FADE POSITIONS, which is exactly what the references
   * either side of a seam cannot supply. Uncorrelated material must satisfy
   * `both = down + up` in power; anything above that is correlation, and the
   * excess is what `seamTrimDb` would have to cancel.
   */
  decompose: { expect: null },
};
/** The `_down`/`_up` pair each patch installs, as functions of t across the fade. */
const CURVE_SHAPE = {
  linear: (t) => [1 - t, t],
  both: () => [1, 1],
  downonly: () => [1, 0],
  uponly: () => [0, 1],
};
if (args.curve && !CURVES[args.curve]) {
  console.log(`!! --curve must be one of: ${Object.keys(CURVES).join(', ')}`);
  await browser.close();
  process.exit(1);
}
/**
 * Overwrite the deck's crossfade curves in place.
 *
 * They are `Float32Array`s built once in the Deck constructor and handed to
 * `setValueCurveAtTime` on every seam, so this takes effect from the next seam
 * onward with no other change to the player at all — same scheduling, same
 * arming, same media elements, same file positions.
 */
const patchCurve = (kind) =>
  page.evaluate((k) => {
    const shape = {
      linear: (t) => [1 - t, t],
      both: () => [1, 1],
      downonly: () => [1, 0],
      uponly: () => [0, 1],
      // The real thing, so a decomposition can put it back and re-measure.
      power: (t) => [Math.cos((t * Math.PI) / 2), Math.sin((t * Math.PI) / 2)],
    }[k];
    for (const d of window.RR.ambienceBed.decks) {
      const n = d._down.length;
      for (let i = 0; i < n; i++) {
        const [down, up] = shape(i / (n - 1));
        d._down[i] = down;
        d._up[i] = up;
      }
    }
  }, kind);

/**
 * Under automation `dayPhase` returns AUTHORED_PHASE regardless of the wall
 * clock — see the daylight.js header — which is mid-morning, so the day slot
 * sits at weight 1 and the other two are paused. That is what makes the seam
 * measurement below a measurement of ONE deck rather than of a crossfade between
 * three, and it is why this script does not have to pin anything itself.
 */
await page.waitForTimeout(3500);

const setup = await page.evaluate(() => {
  const RR = window.RR;
  const ctx = RR.audio.ctx;
  const bed = RR.ambienceBed;
  const deck = bed.decks.find((d) => d._running) ?? bed.decks[0];

  /**
   * TAPPED ON THE DECK'S OWN SUM, NOT ON THE MASTER BUS.
   *
   * The master bus carries the wind, the insects, the stream, the jukebox and a
   * 1.9-second reverb tail. A two-second seam two decibels up inside all of that
   * is a fraction of a decibel on the total and is indistinguishable from a gust
   * arriving. `sum` is the node the two decks add into: it is post-crossfade and
   * post-seam-trim, and it is BEFORE `out`, whose gain is the slowly-ramped slot
   * weight. So this sees the crossfade arithmetic and nothing else at all.
   */
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0;
  deck.sum.connect(analyser);

  window.__bed = {
    ctx,
    bed,
    deck,
    analyser,
    time: new Float32Array(analyser.fftSize),
  };
  return {
    sampleRate: ctx.sampleRate,
    report: bed.report(),
    spy: window.__bedSpy,
  };
});

/**
 * Sample the deck for `ms`, keeping RMS and peak per window alongside whether
 * the deck said it was mid-crossfade at the time, and WHEN.
 *
 * The `fading` flag is read from the player rather than inferred from the
 * signal, which is the only way to attribute a level change to the seam rather
 * than to the material. A bed is allowed to get louder on its own — that is what
 * a chorus does — and a measurement that guessed where the seam was would
 * confuse the two.
 *
 * `t` is kept because the reference the seam is judged against is LOCAL. See
 * `seams()` below, which is where this script's first version went wrong.
 */
async function watch(ms) {
  return page.evaluate(async (duration) => {
    const { analyser, deck, time } = window.__bed;
    const out = [];
    const started = performance.now();
    while (performance.now() - started < duration) {
      analyser.getFloatTimeDomainData(time);
      let sumSq = 0;
      let peak = 0;
      for (let i = 0; i < time.length; i++) {
        const v = time[i];
        sumSq += v * v;
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
      out.push({
        t: performance.now() - started,
        rms: Math.sqrt(sumSq / time.length),
        peak,
        fading: deck._fading,
      });
      await new Promise((r) => setTimeout(r, 25));
    }
    return out;
  }, ms);
}

/**
 * ==== WHAT THE SEAM SHOULD READ, COMPUTED FROM THE FILE ITSELF ==============
 *
 * THIS IS THE GATE. Everything above it measures; this is the only thing that
 * knows what the measurement ought to be, and getting here took four wrong
 * answers.
 *
 * The problem is that a bed is not stationary and the crossfade does not weight
 * it evenly. An equal-power fade yields
 *
 *     mean over the window of [ Pa(t)·cos²(πt/2) + Pb(t)·sin²(πt/2) ]
 *
 * which collapses to (Pa + Pb)/2 ONLY if Pa and Pb are constant across the two
 * seconds. On real material they are not, and the difference is not small: the
 * placeholder's energy RISES through the outgoing deck's tail (1.75e-3 to
 * 5.33e-3 per half second) and FALLS through the incoming deck's head (4.99e-3
 * to 1.97e-3), so the fade weights precisely the quiet half of each. Flat
 * average predicts +0.34 dB; the weighted integral predicts -1.04 dB; the
 * browser measures -1.06 dB. The player was right all along and three earlier
 * versions of this file called it a bug.
 *
 * So the prediction is computed by decoding the bed's actual file with ffmpeg
 * and doing the weighted integral over the real samples. The gate is then the
 * DIFFERENCE between prediction and measurement, which is the only quantity that
 * is a fact about the player rather than about the recording.
 *
 * IT ALSO CATCHES THE +3 dB TRAP FOR FREE, and that is the part worth having.
 * The integral above assumes the two decks are uncorrelated — it adds POWERS. If
 * the material is correlated across the seam the real output adds AMPLITUDES and
 * the measurement comes in above the prediction, by up to 3.01 dB. So a single
 * threshold on `measured - predicted` covers both "the crossfade is broken" and
 * "this recording needs a seamTrimDb", and it needs no assumption about the
 * material at all.
 *
 * Falls back to null — and the gate to the crude absolute one — when ffmpeg is
 * missing or the bed is not a local file.
 */
function predictSeam(file, { loopStart, crossfade, guard = 3 }) {
  const raw = resolve(OUT, 'bed-predict.raw');
  try {
    execFileSync(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', '48000', raw],
      { stdio: 'pipe' }
    );
  } catch {
    return null;
  }
  const buf = readFileSync(raw);
  rmSync(raw, { force: true });
  const iv = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const R = 48000;
  const n = iv.length / 2;
  /**
   * Mono, because that is what an AnalyserNode reports. It barely matters — the
   * same prediction computed on the left channel alone and on the right alone
   * differs by 0.14 dB — but there is no reason to introduce the discrepancy.
   */
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = (iv[2 * i] + iv[2 * i + 1]) / 2;
  const dur = n / R;
  const power = (t0, t1) => {
    const s = Math.max(0, Math.round(t0 * R));
    const e = Math.min(n, Math.round(t1 * R));
    let q = 0;
    for (let i = s; i < e; i++) q += m[i] * m[i];
    return e > s ? q / (e - s) : 0;
  };
  // The same two windows `seams()` uses: the outgoing deck's run-up and the
  // incoming deck's run-out.
  const ref = (power(dur - crossfade - guard, dur - crossfade) + power(loopStart + crossfade, loopStart + crossfade + guard)) / 2;
  const sA = Math.round((dur - crossfade) * R);
  const sB = Math.round(loopStart * R);
  const len = Math.round(crossfade * R);
  let acc = 0;
  let flat = 0;
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const c = Math.cos((t * Math.PI) / 2);
    const s = Math.sin((t * Math.PI) / 2);
    const a = m[sA + i] ?? 0;
    const b = m[sB + i] ?? 0;
    acc += a * a * c * c + b * b * s * s;
    flat += (a * a + b * b) / 2;
  }
  if (!(ref > 0) || !(acc > 0)) return null;
  return {
    /** What an equal-power fade of THIS material must produce, in dB vs the sides. */
    db: 10 * Math.log10(acc / len / ref),
    /** The naive (Pa+Pb)/2 answer, kept because the gap between them is the lesson. */
    flatDb: 10 * Math.log10(flat / len / ref),
    seconds: dur,
  };
}

/** Median, which is what a steady state wants — a mean is dragged by the seam. */
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const dB = (a, b) => (b > 0 && a > 0 ? 20 * Math.log10(a / b) : 0);

/**
 * ==== THE REFERENCE IS LOCAL, AND THE FIRST VERSION OF THIS WAS WRONG ========
 *
 * This script originally compared the LOUDEST window inside any crossfade
 * against the MEDIAN of every steady window in the run, and reported +3.57 dB on
 * a bed whose two decks are provably uncorrelated — independent noise chains,
 * different seeds, no shared content at all. The number was real and the
 * conclusion was nonsense, for a reason that will apply to every real recording
 * far more strongly than it applies to the placeholder:
 *
 * A BED BREATHES. `ambience.js` argues at length that a bed which does not is an
 * air conditioner, and the placeholder duly modulates itself ±28% on two slow
 * incommensurate LFOs — about ±2.2 dB, before any crossfade exists. A max taken
 * over ~130 fade windows is therefore being compared against the middle of a
 * distribution that is itself 4 dB wide, and it would read positive on a
 * perfectly flat crossfade. A real dawn chorus swells far more than 28%.
 *
 * THE SECOND VERSION WAS ALSO WRONG, IN THE SAME WAY, ONLY LOCALLY. It compared
 * the loudest window INSIDE a fade against the median of the three seconds
 * either side, and reported +3.4 to +3.8 dB on three consecutive seams — which
 * looks exactly like the correlated-sum failure and is not. The material's own
 * peak-to-median ratio is +5.9 dB (a chirp lands, or two breaths line up), so a
 * max over sixty windows sits well above a median over a hundred and twenty
 * whatever the crossfade is doing. The tell was that the fade's MEDIAN was
 * simultaneously -0.9 dB: a correlated sum raises the whole window, it does not
 * raise the peak while lowering the middle.
 *
 * SO THE THIRD VERSION USES THE IDENTITY INSTEAD OF A STATISTIC. For an equal-
 * power crossfade the instantaneous power is
 *
 *     P(θ) = Pa·cos²θ + Pb·sin²θ,      θ: 0 -> π/2
 *
 * whose MEAN over the window is exactly (Pa + Pb)/2, with no dependence on the
 * shape of anything. If the two decks are instead correlated they sum by
 * amplitude, `(√Pa·cosθ + √Pb·sinθ)²`, whose mean is
 *
 *     (Pa + Pb)/2 + (2/π)·√(Pa·Pb)
 *
 * i.e. +2.14 dB for equal ends. So: mean power inside the fade, against
 * (Pa + Pb)/2 measured either side of it. Uncorrelated reads 0.00 dB by
 * construction; fully correlated reads +2.14. A mean over the whole window is
 * also far more robust to one loud chirp than a max is, which is the property
 * the previous two versions lacked.
 *
 * Three seconds either side because it is long enough to cover a slow LFO's
 * excursion and short enough that the material has not moved on. Power (rms²)
 * rather than amplitude throughout, because that is the quantity the identity is
 * written in. The peak ratio is still printed, clearly labelled, because it says
 * something real about the material even though it says nothing about the fade.
 */
function seams(samples, guard = 3000) {
  const runs = [];
  let start = -1;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].fading && start < 0) start = i;
    if (!samples[i].fading && start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }
  // A run still open at the end of the window is dropped: it has no `after`
  // side, so it has no ceiling to be judged against.
  const power = (s) => s.rms * s.rms;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const between = (lo, hi) =>
    samples.filter((s) => !s.fading && s.t >= lo && s.t <= hi).map(power);
  return runs
    .map(([i0, i1]) => {
      /**
       * MEAN, not median, on both sides — because the quantity the identity
       * predicts is a mean power and the two references have to be the same
       * statistic as the thing being compared to them. Mixing a mean inside with
       * a median outside is how the previous version manufactured 3 dB.
       */
      const before = mean(between(samples[i0].t - guard, samples[i0].t - 1));
      const after = mean(between(samples[i1].t + 1, samples[i1].t + guard));
      if (!before || !after) return null;
      const inside = samples.slice(i0, i1 + 1).map(power);
      const expected = (before + after) / 2;
      const got = mean(inside);
      return {
        at: Math.round(samples[i0].t),
        span: Math.round(samples[i1].t - samples[i0].t),
        beforeRms: Math.sqrt(before),
        afterRms: Math.sqrt(after),
        expectedRms: Math.sqrt(expected),
        gotRms: Math.sqrt(got),
        // 10log10 of a power ratio. 0.00 uncorrelated, +2.14 fully correlated.
        db: 10 * Math.log10(got / expected),
        // Material diagnostics, not a verdict on the fade. See the header.
        peakRms: Math.sqrt(Math.max(...inside)),
        peakDb: 10 * Math.log10(Math.max(...inside) / expected),
      };
    })
    .filter(Boolean);
}

const duration = setup.report.decks[0]?.duration ?? 24;
const crossfade = setup.report.decks[0]?.crossfade ?? 2;
const period = duration - crossfade;
/**
 * Three full loops plus a margin. Two seams is the minimum that proves the loop
 * comes round at all; three gives the local reference above something to
 * disagree about if one of them is a fluke.
 */
const windowMs = Math.min(180000, Math.round((period * 3 + crossfade * 2 + 8) * 1000));

console.log(`bed: ${setup.report.decks.length} deck(s), context ${setup.sampleRate} Hz`);
for (const d of setup.report.decks) {
  console.log(
    `  ${String(d.slot).padEnd(9)} ${String(d.src).padEnd(14)} ${String(d.type).padEnd(30)} ` +
      `${Number.isFinite(d.duration) ? d.duration.toFixed(2) : '?'}s  crossfade ${d.crossfade}s  ` +
      `seamTrim ${d.seamTrimDb} dB  running=${d.running}`
  );
}
console.log(`\nwatching ${(period * 3).toFixed(0)}s of loop (period ${period.toFixed(1)}s)${args.curve ? ', twice — baseline then patched' : ''}\n`);

const samples = await watch(windowMs);
const found = seams(samples);

/**
 * The control's second half: same session, same file, same seam positions, one
 * deliberately wrong curve. Only the DIFFERENCE between the two halves is
 * meaningful — see the header.
 */
let control = null;
let decomposition = null;
if (args.curve === 'decompose') {
  decomposition = {};
  for (const kind of ['downonly', 'uponly', 'both']) {
    await patchCurve(kind);
    decomposition[kind] = seams(await watch(windowMs));
  }
} else if (args.curve) {
  await patchCurve(args.curve);
  control = seams(await watch(windowMs));
}
/**
 * The first second is dropped from the steady-state summary. `getFloatTimeDomainData`
 * returns a zero-filled buffer until the analyser has actually seen fftSize
 * samples, so the opening windows read 0.00000 and drag the printed range down
 * by an infinite number of decibels. It is a property of the instrument, not a
 * dropout in the bed — the seam measurement above never touches those samples
 * because its references are windows adjacent to a fade.
 */
const steady = samples.filter((s) => !s.fading && s.t > 1000).map((s) => s.rms);
const worstDb = found.length ? Math.max(...found.map((s) => s.db)) : 0;
const worstPeakDb = found.length ? Math.max(...found.map((s) => s.peakDb)) : 0;

/** What the streaming path is worth, from the context's real rate. */
const bytes = duration * 2 * 4 * setup.sampleRate;
const decoded = await page.evaluate(() => window.__bedSpy);

/**
 * ==== MEASURING THE DUCK, AND WHY IT IS TWO DIFFERENT EXPERIMENTS ============
 *
 * The obvious version — read the gains, call `setBedPresence(0)`, read them
 * again — fails twice, and both failures produced confident wrong numbers before
 * this comment existed.
 *
 *   MAIN.JS WRITES THE PRESENCE EVERY FRAME. It calls
 *   `ambience.setBedPresence(bed.presence, bed.duck)` in the loop, so a value
 *   poked in from the console is gone in 16 ms and the "without" reading is just
 *   the ducked state again. The duck is therefore removed at its SOURCE — each
 *   deck's manifest `duck` is set to 1 — which travels the real path, one frame
 *   later, exactly as a manifest edit would.
 *
 *   THE TWO LAYERS HAVE TIME CONSTANTS AN ORDER OF MAGNITUDE APART, and one of
 *   them is chasing a moving target:
 *
 *     CICADAS are `setTargetAtTime(..., 6)` and depend only on `day` and `rain`,
 *     both of which are constant under automation. So this is a clean, exact
 *     measurement — but it needs 30 s to settle (five time constants is 99.3%).
 *
 *     WIND is `setTargetAtTime(..., 0.5)` and its target contains the GUST,
 *     which is a slow sine main.js derives from `uWind` and which nothing here
 *     can stop. Two readings thirty seconds apart catch two different gusts, and
 *     the first run of this script duly reported the wind ducked to 0.80 when the
 *     manifest says 0.55. So the wind is measured by INTERLEAVING instead: the
 *     duck is toggled every 3 s (six time constants, 99.75% settled) and the
 *     pairs are compared adjacent, where the gust has barely moved. The median
 *     over several pairs is the answer.
 *
 * Same structure as `record-space.mjs`'s tail measurement and for the same
 * reason: the confound was slower than the thing being measured, so the fix was
 * to remove the confound rather than to average over it.
 */
const state = args.curve
  ? null
  : await page.evaluate(async () => {
  const RR = window.RR;
  const bed = RR.ambienceBed;
  const amb = RR.ambience;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const real = bed.decks.map((d) => d.spec.duck);
  const setDuck = (on) => {
    bed.decks.forEach((d, i) => {
      d.spec.duck = on ? real[i] : { wind: 1, insects: 1 };
    });
  };
  const read = () => ({
    wind: amb.windGain.gain.value,
    windLow: amb.windLowGain.gain.value,
    cicada: amb.cicadaGain.gain.value,
    gust: amb.gustValue,
  });

  // --- wind: interleaved, 3 s per leg ---------------------------------------
  const pairs = [];
  for (let i = 0; i < 4; i++) {
    setDuck(true);
    await wait(3000);
    const on = read();
    setDuck(false);
    await wait(3000);
    const off = read();
    pairs.push({
      wind: on.wind / Math.max(1e-12, off.wind),
      windLow: on.windLow / Math.max(1e-12, off.windLow),
      gustDrift: Math.abs(on.gust - off.gust),
    });
  }

  // --- cicadas: settled, 30 s per leg ---------------------------------------
  setDuck(false);
  await wait(30000);
  const cicadaOff = read().cicada;
  setDuck(true);
  await wait(30000);
  const cicadaOn = read().cicada;

  return {
    presence: bed.presence,
    duck: { ...bed.duck },
    pairs,
    cicada: { on: cicadaOn, off: cicadaOff, ratio: cicadaOn / Math.max(1e-12, cicadaOff) },
    report: bed.report(),
  };
    });

const windRatio = state ? median(state.pairs.map((p) => p.wind)) : 0;
const windLowRatio = state ? median(state.pairs.map((p) => p.windLow)) : 0;

console.log('THE LOOP SEAM — is the crossfade level, and is it the +3 dB trap');
console.log(`  windows            ${samples.length} (${steady.length} steady, ${samples.length - steady.length} in a fade)`);
/**
 * Zero-valued windows are counted and reported separately rather than being
 * allowed into the range.
 *
 * `getFloatTimeDomainData` returns a zero-filled buffer until the analyser has
 * seen a full `fftSize` — 43 ms here — so the opening windows read exactly
 * 0.00000. Left in the range they print a min of zero and an infinite dynamic
 * range, which looks like a dropout in the bed and is a property of the
 * instrument. A count that is more than a couple, or any that arrive late, would
 * be a real dropout; that is what this line is for.
 */
const zeros = steady.filter((v) => v === 0).length;
const nonZero = steady.filter((v) => v > 0);
console.log(`  steady rms         median ${median(nonZero).toFixed(5)}, range ` +
  `${Math.min(...nonZero).toFixed(5)}..${Math.max(...nonZero).toFixed(5)} ` +
  `(${dB(Math.max(...nonZero), Math.min(...nonZero)).toFixed(1)} dB — this is why the reference is local)` +
  `${zeros ? `; ${zeros} empty analyser window(s)` : ''}`);
console.log(`  seams measured     ${found.length}   (0.00 dB = uncorrelated, +2.14 dB = fully correlated)`);
console.log(' ', 'at'.padEnd(8), 'span'.padEnd(7), 'before'.padEnd(9), 'after'.padEnd(9), 'expected'.padEnd(9), 'measured'.padEnd(9), 'error'.padEnd(10), 'peak (material)');
for (const s of found) {
  console.log(
    ' ',
    `${(s.at / 1000).toFixed(1)}s`.padEnd(8),
    `${(s.span / 1000).toFixed(2)}s`.padEnd(7),
    s.beforeRms.toFixed(5).padEnd(9),
    s.afterRms.toFixed(5).padEnd(9),
    s.expectedRms.toFixed(5).padEnd(9),
    s.gotRms.toFixed(5).padEnd(9),
    `${s.db >= 0 ? '+' : ''}${s.db.toFixed(2)} dB`.padEnd(10),
    `${s.peakDb >= 0 ? '+' : ''}${s.peakDb.toFixed(2)} dB`
  );
}
console.log(`  worst              ${worstDb >= 0 ? '+' : ''}${worstDb.toFixed(2)} dB (material peak ${worstPeakDb >= 0 ? '+' : ''}${worstPeakDb.toFixed(2)} dB, not a verdict)`);

/**
 * The prediction, from the file the running deck is actually playing. See
 * `predictSeam` — this is the gate, and the raw dB above is only an input to it.
 */
const runningSrc = setup.report.decks.find((d) => d.running)?.src ?? setup.report.decks[0]?.src;
const localFile = runningSrc ? resolve(process.cwd(), 'public/audio/beds', runningSrc) : null;
const predicted =
  localFile && existsSync(localFile)
    ? predictSeam(localFile, { loopStart: 0, crossfade })
    : null;
let seamError = null;
if (predicted) {
  seamError = worstDb - predicted.db;
  console.log(`\n  predicted from ${runningSrc}, decoded offline:`);
  console.log(`    equal-power integral over the real samples   ${predicted.db >= 0 ? '+' : ''}${predicted.db.toFixed(2)} dB`);
  console.log(`    naive (Pa+Pb)/2, i.e. assuming a flat bed    ${predicted.flatDb >= 0 ? '+' : ''}${predicted.flatDb.toFixed(2)} dB   <- what three earlier versions compared against`);
  console.log(`    measured in the browser                      ${worstDb >= 0 ? '+' : ''}${worstDb.toFixed(2)} dB`);
  console.log(`    error                                        ${seamError >= 0 ? '+' : ''}${seamError.toFixed(2)} dB`);
} else {
  console.log('\n  no offline prediction (ffmpeg missing, or the bed is not a local file) —');
  console.log('  falling back to an absolute threshold, which is material-dependent and crude.');
}

console.log('\nRAM — is it streaming or decoding');
console.log(`  decodeAudioData calls          ${decoded.decodes}`);
console.log(`  AudioBuffers created           ${decoded.buffers.length}, longest ${decoded.longest.toFixed(3)}s`);
console.log(`  bed duration                   ${Number.isFinite(duration) ? duration.toFixed(3) : '?'}s`);
console.log(
  `  what decoding one would cost   ${(bytes / 1024 / 1024).toFixed(2)} MiB ` +
    `(${duration.toFixed(0)}s x 2ch x 4B x ${setup.sampleRate} Hz)`
);
const live = state?.report ?? (await page.evaluate(() => window.RR.ambienceBed.report()));
for (const d of live.decks) {
  console.log(
    `  ${String(d.slot).padEnd(9)} readyState ${d.readyState}  buffered ${d.buffered}s of ` +
      `${Number.isFinite(d.duration) ? d.duration.toFixed(1) : '?'}s  at ${d.currentTime}s  seams ${d.seams}`
  );
}

// Skipped under `--curve`: that run is about the crossfade arithmetic and the
// duck measurement is 72 s of wall clock that says nothing about it.
if (state) {
  console.log('\nTHE DUCK — the wind is quieter, not gone');
  console.log(`  presence           ${state.presence.toFixed(3)}`);
  console.log(`  declared duck      wind ${state.duck.wind.toFixed(2)}  insects ${state.duck.insects.toFixed(2)}`);
  console.log(
    `  wind, interleaved  ${state.pairs.map((p) => p.wind.toFixed(3)).join('  ')}   -> ${windRatio.toFixed(3)} ` +
      `(${dB(windRatio, 1).toFixed(2)} dB); gust drift per pair ${state.pairs.map((p) => p.gustDrift.toFixed(3)).join(', ')}`
  );
  console.log(`  wind low           ${state.pairs.map((p) => p.windLow.toFixed(3)).join('  ')}   -> ${windLowRatio.toFixed(3)}`);
  console.log(
    `  cicada, settled    ${state.cicada.on.toFixed(5)} ducked / ${state.cicada.off.toFixed(5)} open   ` +
      `-> ${state.cicada.ratio.toFixed(3)} (${dB(state.cicada.ratio, 1).toFixed(2)} dB)`
  );
}

const fails = [];
/**
 * Under `--curve` the assertion is INVERTED: the run is supposed to fail, and the
 * only interesting question is whether it failed by the predicted amount. A
 * control that quietly passed would be the worst possible outcome, because it
 * would look like a clean bill of health for the instrument.
 */
const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
if (args.curve === 'decompose') {
  const base = avg(found.map((x) => x.db));
  const d = Object.fromEntries(
    Object.entries(decomposition).map(([k, v]) => [k, avg(v.map((x) => x.db))])
  );
  const lin = (db) => Math.pow(10, db / 10);
  const sum = lin(d.downonly) + lin(d.uponly);
  const sign = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)} dB`;
  console.log('\nDECOMPOSITION — the two decks measured separately across the same seams');
  console.log(`  equal power (real)   ${sign(base)}   over ${found.length} seam(s)`);
  for (const [k, v] of Object.entries(d)) {
    console.log(`  ${k.padEnd(20)} ${sign(v)}   over ${decomposition[k].length} seam(s)`);
  }
  /**
   * If A and B are uncorrelated their powers add, so holding both at unity must
   * measure exactly the sum of holding each at unity. Any excess is correlation
   * — and `rho` inverts `P = Pa + Pb + 2·rho·sqrt(Pa·Pb)` to name it.
   */
  const excess = d.both - 10 * Math.log10(sum);
  const rho = (lin(d.both) - sum) / (2 * Math.sqrt(lin(d.downonly) * lin(d.uponly)));
  console.log(`\n  Pa alone + Pb alone  ${sign(10 * Math.log10(sum))}   <- what "both" must read if uncorrelated`);
  console.log(`  both, measured       ${sign(d.both)}`);
  console.log(`  excess               ${sign(excess)}   -> correlation rho = ${rho.toFixed(3)}`);
  console.log(`\n  equal power predicted from the parts  ${sign(10 * Math.log10(sum / 2))}`);
  console.log(`  equal power measured                 ${sign(base)}`);
  await browser.close();
  process.exit(0);
}
if (args.curve) {
  const want = CURVES[args.curve].expect;
  const base = avg(found.map((x) => x.db));
  const after = avg(control.map((x) => x.db));
  const delta = after - base;
  const off = Math.abs(delta - want);
  console.log(`\nCONTROL — --curve=${args.curve}`);
  console.log(`  baseline (equal power)   ${base >= 0 ? '+' : ''}${base.toFixed(2)} dB over ${found.length} seam(s)`);
  console.log(`  patched                  ${after >= 0 ? '+' : ''}${after.toFixed(2)} dB over ${control.length} seam(s)`);
  console.log(`  per-seam, patched        ${control.map((x) => x.db.toFixed(2)).join('  ')}`);
  console.log(`  delta                    ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} dB`);
  console.log(`  arithmetic says          ${want >= 0 ? '+' : ''}${want.toFixed(2)} dB   (error ${off.toFixed(2)} dB)`);
  const ok = off < 0.6 && control.length >= 2;
  console.log(
    ok
      ? '\nthe instrument resolves a known-wrong crossfade to within 0.6 dB of theory'
      : '\nTHE INSTRUMENT DID NOT SEE IT — the seam measurement cannot be trusted'
  );
  await browser.close();
  process.exit(ok ? 0 : 1);
}
if (decoded.decodes > 0) {
  fails.push(`decodeAudioData was called ${decoded.decodes} times — something is decoding, not streaming`);
}
if (Number.isFinite(duration) && decoded.longest > duration * 0.9) {
  fails.push(
    `an AudioBuffer of ${decoded.longest.toFixed(2)}s exists against a ${duration.toFixed(2)}s bed — ` +
      'the bed looks decoded'
  );
}
if (found.length < 2) fails.push(`only ${found.length} complete seam(s) observed — the loop is not coming round`);
/**
 * 1.0 dB against the identity in `seams()`, and the two failure modes it
 * separates sit either side of it by a comfortable margin.
 *
 * Fully correlated is +2.14 dB and a linear (equal-amplitude) fade on
 * uncorrelated material is -1.25 dB, so a threshold of 1 catches both while
 * leaving room for the references themselves being means over three seconds of
 * material that is allowed to breathe. Measured run-to-run spread on the
 * placeholder is under 0.2 dB.
 *
 * NOTE THAT THE TRIM IS NOT THE ERROR. `seamTrimDb` dips the midpoint, where a
 * correlated sum is +3.01 dB; the number measured here is the MEAN over the
 * window, which is +2.14 for the same signal. The suggestion below converts.
 */
if (seamError !== null) {
  if (Math.abs(seamError) > 1) {
    fails.push(
      `the seam is ${seamError >= 0 ? '+' : ''}${seamError.toFixed(2)} dB away from what this file's own ` +
        'samples say an equal-power crossfade of it must produce — ' +
        (seamError > 0
          ? `the two decks are correlated across the seam. Try seamTrimDb ${(seamError * (3.01 / 2.14)).toFixed(2)} in the manifest.`
          : 'the crossfade is losing energy; check the curve and the arming.')
    );
  }
} else if (Math.abs(worstDb) > 1) {
  /**
   * The fallback, and it is deliberately loose because it is measuring the
   * material as much as the player — see `predictSeam` for why a bed whose loop
   * point sits on a swell legitimately reads a decibel off flat.
   */
  fails.push(
    `the seam is ${worstDb >= 0 ? '+' : ''}${worstDb.toFixed(2)} dB against a flat-bed assumption, and ` +
      'there is no offline prediction to check it against. Install ffmpeg, or listen to it.'
  );
}
if (state && state.presence > 0.01) {
  if (windRatio < 0.15) {
    fails.push(`the wind is ${(windRatio * 100).toFixed(0)}% of its level — that is deletion, not ducking`);
  }
  if (windRatio > 0.99) fails.push('the wind is not ducked at all — setBedPresence is not reaching ambience.js');
  /**
   * The declared duck and the measured one, checked against each other.
   *
   * Not a tuning threshold — a wiring one. `bed.js` declares the duck per bed in
   * the manifest and `ambience.js` applies it as a multiplier; if the two ever
   * disagree it means the value stopped travelling, and a duck that silently
   * reverts to 1 looks exactly like a bed that is too quiet. 12% is loose enough
   * for the gust drift the interleaving cannot fully remove.
   */
  const declared = state.duck.wind + (1 - state.duck.wind) * (1 - state.presence);
  if (Math.abs(windRatio - declared) > 0.12) {
    fails.push(
      `wind ducked to ${windRatio.toFixed(3)} but the manifest declares ${declared.toFixed(3)} at this presence`
    );
  }
  const declaredI = state.duck.insects + (1 - state.duck.insects) * (1 - state.presence);
  if (Math.abs(state.cicada.ratio - declaredI) > 0.08) {
    fails.push(
      `insect wall ducked to ${state.cicada.ratio.toFixed(3)} but the manifest declares ${declaredI.toFixed(3)}`
    );
  }
}
if (problems.length) fails.push(...problems);

writeFileSync(
  `${OUT}/audio-bed-check.json`,
  JSON.stringify({ setup, seams: found, worstDb, worstPeakDb, windRatio, windLowRatio, decoded, state, fails }, null, 2)
);
if (fails.length) {
  console.log('\nPROBLEMS:');
  for (const f of fails) console.log(' ', f);
} else {
  console.log('\nno problems');
}

await browser.close();
process.exit(fails.length ? 1 : 0);
