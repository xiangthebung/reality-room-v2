import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * WHERE IN A FIELD RECORDING THE LOOP SHOULD BE CUT.
 *
 * `audio-bed-make.mjs --in=... --start=180 --length=90` takes a trim and does
 * something defensible with it. It has no opinion about whether 180 was a good
 * place to start, and that is the decision this script exists to make — because
 * the alternative is somebody scrubbing a nineteen-minute file, choosing a spot
 * that sounded nice, and writing the number into a manifest where it is
 * indistinguishable from a measured one.
 *
 * A BED IS NOT JUST "AMBIENCE". It has three properties the rest of the file
 * does not necessarily have, and each is a separate measurement here:
 *
 *   STATIONARY. The loop period is `length - crossfade` seconds and the player
 *   hears it over and over. Anything with a shape — a plane going over, a bird
 *   working closer, rain arriving — becomes a rhythm at that period, and a
 *   rhythm is the single most identifiable thing in a background layer. So the
 *   first score is the spread of short-term loudness across the window.
 *
 *   FREE OF SOLOISTS. A near bird is not a bed, it is an event, and `wildlife.js`
 *   is already responsible for events. Worse, a recorded event repeats on a fixed
 *   period while the synthesised ones do not, so the recorded one is the one the
 *   ear locks onto. Counted here as frames well above the window's own median.
 *
 *   SEAM-COMPATIBLE. `bed.js` crossfades the tail into the head. If the two ends
 *   differ in level or in spectrum the loop breathes once per period. This is the
 *   score that cannot be eyeballed from a waveform at all, so it is measured in
 *   both dimensions: level difference in dB, and a per-band spectral distance.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not pick. It prints a ranked table
 * with the sub-scores visible, because the weights below are a judgement and a
 * single number would hide it — a window can win on stationarity and be the
 * quietest thirty seconds of the file, which is a real risk in a recording that
 * fades at either end. Read the columns.
 *
 *   node scripts/audio-bed-scout.mjs --in=day.mp3
 *   node scripts/audio-bed-scout.mjs --in=dawn.mp3 --length=90 --crossfade=2 --top=10
 *
 * Nothing is written. This reads a source and prints.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

/**
 * `--selftest` SYNTHESISES A SOURCE WHOSE ANSWER IS KNOWN, and it is here
 * because of what the first real run printed.
 *
 * Every one of the eight best windows in the day recording read `solo 0.0%` —
 * and so did the WORST window in the file. A column that is zero everywhere is
 * either a recording with no near events or a detector that cannot detect, and
 * the table cannot tell those apart. Guessing which would have meant trusting a
 * trim to a term that might contribute nothing.
 *
 * So: pink-ish noise with a 0.2 s tone burst every 10 s, twenty decibels over
 * the floor. `solo` must come out at 2%, because that is what 0.2-every-10 is,
 * give or take the frames that straddle each edge — and it reads 2.56%, which is
 * the 2% plus exactly the overlap a 64 ms frame on a 32 ms hop adds at two
 * boundaries. The detector fires. The day file really is that clean.
 */
if (args.selftest) {
  const tmp = `${process.env.TEMP || '/tmp'}/rr-bed-scout-selftest.wav`;
  const r = spawnSync(
    'ffmpeg',
    ['-y', '-v', 'error', '-f', 'lavfi', '-i',
      "aevalsrc='0.03*random(0)+0.5*sin(2*PI*1000*t)*lt(mod(t,10),0.2)':d=140:s=16000",
      '-ac', '1', tmp],
    { encoding: 'utf8' }
  );
  if (r.status !== 0) {
    console.error(r.stderr || 'ffmpeg failed to build the self-test source');
    process.exit(1);
  }
  args.in = tmp;
  console.log('SELF-TEST: 0.2 s bursts every 10 s. `solo` must read about 2.6%.\n');
}

if (!args.in || !existsSync(args.in)) {
  console.error('usage: node scripts/audio-bed-scout.mjs --in=<audio file> [--length=90] [--crossfade=2]');
  console.error('       node scripts/audio-bed-scout.mjs --selftest');
  process.exit(1);
}

const LENGTH = Number(args.length ?? 90);
const CROSSFADE = Number(args.crossfade ?? 2);
const TOP = Number(args.top ?? 8);
/** Candidate starts are stepped by this, in seconds. */
const STEP = Number(args.step ?? 1);

/**
 * ANALYSIS RATE. 16 kHz, mono.
 *
 * Mono because every score here is about time and coarse spectrum, and the
 * stereo image of the source is not something a trim can change. 16 kHz because
 * the top octave of a rainforest bed is insect noise that is nearly stationary
 * by construction — including it would add cost and move no score — and because
 * it keeps a nineteen-minute source inside a buffer Node will hand back in one
 * piece.
 */
const RATE = 16000;
const FRAME = 1024;
const HOP = 512;
const HOP_S = HOP / RATE;

// ---------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------

const dec = spawnSync(
  'ffmpeg',
  ['-v', 'error', '-i', args.in, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'],
  { maxBuffer: 1 << 30, encoding: 'buffer' }
);
if (dec.status !== 0) {
  console.error(dec.stderr?.toString() || 'ffmpeg failed');
  process.exit(1);
}
const pcm = new Float32Array(
  dec.stdout.buffer,
  dec.stdout.byteOffset,
  Math.floor(dec.stdout.byteLength / 4)
);
const DURATION = pcm.length / RATE;

if (DURATION < LENGTH + 2) {
  console.error(`source is ${DURATION.toFixed(1)}s; need at least ${LENGTH + 2}s`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// per-frame loudness and spectral shape
// ---------------------------------------------------------------------------

/** In-place iterative radix-2 FFT. `re`/`im` are FRAME long. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
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
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Log-spaced band edges. Eight bands from 40 Hz to the Nyquist-ish 7 kHz: fine
 * enough that a wall of insects moving up a third shows, coarse enough that a
 * single bird moving between two adjacent bins does not dominate the distance.
 */
const EDGES = [40, 100, 220, 460, 900, 1800, 3200, 5200, 7800];
const BANDS = EDGES.length - 1;
const binOf = (hz) => Math.min(FRAME / 2, Math.max(1, Math.round((hz * FRAME) / RATE)));

const hann = new Float32Array(FRAME);
for (let i = 0; i < FRAME; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);

const nFrames = Math.floor((pcm.length - FRAME) / HOP);
const db = new Float32Array(nFrames);
/** nFrames x BANDS, row-major, normalised so each row sums to 1. */
const shape = new Float32Array(nFrames * BANDS);
let clipped = 0;

{
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    let sum = 0;
    for (let i = 0; i < FRAME; i++) {
      const x = pcm[off + i];
      if (Math.abs(x) >= 0.999) clipped++;
      sum += x * x;
      re[i] = x * hann[i];
      im[i] = 0;
    }
    db[f] = 10 * Math.log10(sum / FRAME + 1e-12);
    fft(re, im);
    let total = 0;
    for (let b = 0; b < BANDS; b++) {
      let e = 0;
      for (let k = binOf(EDGES[b]); k < binOf(EDGES[b + 1]); k++) e += re[k] * re[k] + im[k] * im[k];
      shape[f * BANDS + b] = e;
      total += e;
    }
    total = Math.max(total, 1e-20);
    for (let b = 0; b < BANDS; b++) shape[f * BANDS + b] /= total;
  }
}

// ---------------------------------------------------------------------------
// window scoring
// ---------------------------------------------------------------------------

const median = (arr) => {
  const s = Float32Array.from(arr).sort();
  return s[s.length >> 1];
};

/** Mean band shape over a frame range, and the mean level in dB. */
function region(from, to) {
  const acc = new Float64Array(BANDS);
  let lvl = 0;
  for (let f = from; f < to; f++) {
    for (let b = 0; b < BANDS; b++) acc[b] += shape[f * BANDS + b];
    lvl += db[f];
  }
  const n = to - from;
  for (let b = 0; b < BANDS; b++) acc[b] /= n;
  return { shape: acc, db: lvl / n };
}

const framesFor = (s) => Math.round(s / HOP_S);
const winFrames = framesFor(LENGTH);
const xfFrames = framesFor(CROSSFADE);
const wholeMedian = median(db);

const rows = [];
for (let start = 0; start + LENGTH <= DURATION; start += STEP) {
  const f0 = framesFor(start);
  const f1 = f0 + winFrames;
  if (f1 > nFrames) break;

  const slice = db.subarray(f0, f1);
  let mean = 0;
  for (const v of slice) mean += v;
  mean /= slice.length;
  let varSum = 0;
  for (const v of slice) varSum += (v - mean) * (v - mean);
  const spread = Math.sqrt(varSum / slice.length);

  const med = median(slice);
  let loud = 0;
  for (const v of slice) if (v > med + 8) loud++;
  const solo = loud / slice.length;

  /**
   * The seam compares the material the crossfade will actually mix: the FIRST
   * `crossfade` seconds against the LAST. Not the first and last sample — a
   * crossfade is a region, and two regions can meet at a matching instant while
   * being made of different things either side of it.
   */
  const head = region(f0, f0 + xfFrames);
  const tail = region(f1 - xfFrames, f1);
  let spec = 0;
  for (let b = 0; b < BANDS; b++) {
    // Distance in dB per band, so a band at half the energy reads 3 rather than
    // 0.5 — the ear's units, and it keeps the quiet bands from being ignored.
    spec += Math.abs(10 * Math.log10((head.shape[b] + 1e-6) / (tail.shape[b] + 1e-6)));
  }
  spec /= BANDS;
  const seamDb = Math.abs(head.db - tail.db);

  rows.push({
    start,
    mean,
    spread,
    solo,
    seamDb,
    spec,
    // The weights are a judgement, and they are here in one line so it is an
    // arguable one. Soloists are multiplied hardest because a single repeating
    // bird ruins a bed that is otherwise perfect on every other axis.
    score: spread + spec + seamDb * 0.5 + solo * 60 + Math.max(0, wholeMedian - mean) * 0.5,
  });
}

rows.sort((a, b) => a.score - b.score);

const hms = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

console.log(`${args.in}`);
console.log(
  `  ${DURATION.toFixed(1)}s  median ${wholeMedian.toFixed(1)} dB  ` +
    `${clipped ? `${clipped} CLIPPED SAMPLES` : 'no clipping'}  ` +
    `| window ${LENGTH}s, crossfade ${CROSSFADE}s, ${rows.length} candidates\n`
);
console.log('  start       level    spread   solo    seam dB  seam spec  score');
for (const r of rows.slice(0, TOP)) {
  console.log(
    `  ${hms(r.start)} ${String(r.start).padStart(5)}s ` +
      `${r.mean.toFixed(1).padStart(7)} ${r.spread.toFixed(2).padStart(8)} ` +
      `${(r.solo * 100).toFixed(1).padStart(6)}% ${r.seamDb.toFixed(2).padStart(8)} ` +
      `${r.spec.toFixed(2).padStart(10)} ${r.score.toFixed(2).padStart(7)}`
  );
}
const worst = rows[rows.length - 1];
console.log(
  `\n  worst of ${rows.length}: ${hms(worst.start)} score ${worst.score.toFixed(2)} ` +
    `(spread ${worst.spread.toFixed(2)}, solo ${(worst.solo * 100).toFixed(1)}%, spec ${worst.spec.toFixed(2)})`
);

/**
 * THE RANGE OF EVERY SCORE, INCLUDING THE ONES THAT DID NOT FIRE.
 *
 * The first run of this printed `solo 0.0%` on all eight winners — and also on
 * the worst window in the file, which is the tell. A column that reads zero
 * everywhere is either a recording with no near events in it or a detector that
 * cannot detect, and the table cannot tell those apart. This line can: if the
 * maximum across ALL candidates is also zero, the threshold never tripped and
 * that term contributed nothing to the ranking, which is worth knowing before
 * trusting a trim to it.
 */
const range = (get) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rows) {
    const v = get(r);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return `${lo.toFixed(2)}..${hi.toFixed(2)}`;
};
console.log(
  `  across all candidates: spread ${range((r) => r.spread)}  ` +
    `solo ${range((r) => r.solo * 100)}%  seam dB ${range((r) => r.seamDb)}  ` +
    `spec ${range((r) => r.spec)}`
);
console.log('\n  columns: level = mean frame dB (higher is more present)');
console.log('           spread = std dev of frame dB across the window (lower is more stationary)');
console.log('           solo = frames more than 8 dB over the window median (lower is fewer near events)');
console.log('           seam dB / seam spec = level and per-band difference between the two crossfade ends');
