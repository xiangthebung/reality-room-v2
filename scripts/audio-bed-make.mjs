import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, renameSync, statSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A PLACEHOLDER FAR CHORUS, SYNTHESISED, SO THE PLAYER CAN BE TESTED WITHOUT
 * LICENSING ANYTHING.
 *
 * `src/audio/bed.js` exists because the unresolvable middle distance of a real
 * rainforest CANNOT be synthesised — that is the whole argument in its header
 * and nothing here contradicts it. What this script makes is not a bed. It is a
 * TEST SIGNAL shaped like one: stereo, continuous, stationary, in roughly the
 * right part of the spectrum, long enough to loop. It is here so that the loop
 * crossfade, the codec selection, the day/night weighting, the wind duck and the
 * streaming-not-decoding claim can all be measured today, against a file this
 * repo owns outright, instead of after somebody has chosen and licensed a
 * recording.
 *
 * NO THIRD-PARTY AUDIO IS DOWNLOADED, HERE OR ANYWHERE ELSE IN THIS PASS.
 *
 * WHAT IT IS MADE OF, and why each part is there:
 *
 *   PINK NOISE, LOW-PASSED, DECORRELATED PER CHANNEL. The air and the distance.
 *   Two independent generators rather than one panned, because the single most
 *   important property of a real stereo field recording is that the two channels
 *   are ALMOST the same and not exactly — a mono bed spread by a width control
 *   is a documented trap in this repo and it collapses to nothing in mono.
 *
 *   A RESONANT MID BAND. The insect wall, at the same 1.5 kHz `ambience.js`
 *   settled on and for the same reason: `audio-probe.mjs` fails any stage with
 *   more than 30% of its energy between 2 and 6 kHz, and a placeholder that fails
 *   the repo's own gate would tell us nothing about the player.
 *
 *   SCATTERED CHIRPS. Short FM bursts at irregular intervals, dull and quiet, so
 *   there is something in the file that is an EVENT rather than a bed — a loop
 *   made only of stationary noise is seamless for trivial reasons and would not
 *   exercise the crossfade at all.
 *
 * THERE IS NO "DELIBERATELY BROKEN" BED HERE, AND THERE WAS ONE.
 *
 * `bed.js`'s third trap is that an equal-power crossfade of CORRELATED material
 * sums to +3.01 dB rather than staying flat, and a seam measurement that has only
 * ever seen well-behaved material is a measurement nobody has tested. This script
 * used to emit a fourth bed containing a steady tone locked to a whole number of
 * cycles across the file, on the theory that its head and tail would therefore be
 * correlated. They are not reliably: seeking a compressed stream lands on a page
 * boundary rather than a sample, so the tone's phase at the seam is randomised by
 * milliseconds, and the control read -1.03, -1.27 and +0.55 dB on three
 * consecutive seams of the same file. That control is gone. `audio-bed-check.mjs`
 * now installs a known-wrong crossfade CURVE instead, which is independent of
 * both phase and material — see `--curve` over there.
 *
 *   node scripts/audio-bed-make.mjs                 the three placeholder beds
 *   node scripts/audio-bed-make.mjs --seconds=40
 *
 * Writes `public/audio/beds/`, including the manifest. That directory is absent
 * from a stock checkout ON PURPOSE — see `AmbienceBed.load`.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const OUT = resolve(process.cwd(), args.out ?? 'public/audio/beds');
const SECONDS = Number(args.seconds ?? 24);
const RATE = 48000;
/** Matches the manifest's crossfade below. The audible loop period is SECONDS - this. */
const CROSSFADE = 2;

/**
 * ffmpeg is REQUIRED and its absence is reported rather than worked around.
 *
 * There is no honest way to produce an Opus or AAC file from Node without it,
 * and a script that quietly emitted WAVs instead would be testing a codepath
 * (`canPlayType` selection, encoder padding, streamed decode) that the real beds
 * will never take. See the repo convention: never claim a measurement you did
 * not take.
 */
let ffmpegVersion = '';
try {
  ffmpegVersion = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0];
} catch {
  console.error(
    'ffmpeg is not on PATH. This script cannot produce Opus or AAC without it, and\n' +
      'emitting WAVs instead would test a different codepath than the real beds take.\n' +
      'Install ffmpeg and run again.'
  );
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// synthesis
// ---------------------------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The same three-pole pink filter `ambience.js` uses, so the tilt matches. */
function pink(rand) {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  return () => {
    const white = rand() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    return (b0 + b1 + b2 + white * 0.1848) * 0.26;
  };
}

/** RBJ biquad. `kind` is 'lowpass' or 'bandpass' (constant peak gain). */
function biquad(kind, freq, q) {
  const w0 = (2 * Math.PI * freq) / RATE;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0;
  let b1;
  let b2;
  if (kind === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const n = [b0 / a0, b1 / a0, b2 / a0];
  const d = [a1 / a0, a2 / a0];
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x) => {
    const y = n[0] * x + n[1] * x1 + n[2] * x2 - d[0] * y1 - d[1] * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

/**
 * One bed.
 *
 * @param {object} spec
 * @param {number} spec.seed
 * @param {number} spec.insectHz   where the resonant wall sits
 * @param {number} spec.insectQ    how narrow it is
 * @param {number} spec.insectGain
 * @param {number} spec.airHz      the low-pass on the broadband layer
 * @param {number} spec.chirpRate  chirps per second, on average
 */
function synth(spec) {
  const n = Math.round(SECONDS * RATE);
  const L = new Float32Array(n);
  const R = new Float32Array(n);

  // Two independent noise chains per layer. See the header on decorrelation.
  for (const [buf, seed] of [
    [L, spec.seed],
    [R, spec.seed ^ 0x5bf03635],
  ]) {
    const p = pink(rng(seed));
    const air = biquad('lowpass', spec.airHz, 0.5);
    const p2 = pink(rng(seed ^ 0x9e3779b9));
    const band1 = biquad('bandpass', spec.insectHz, spec.insectQ);
    const band2 = biquad('bandpass', spec.insectHz, spec.insectQ);
    // Two slow, incommensurate breaths, exactly as ambience.js modulates its own
    // insect wall — a steady filtered noise is an air conditioner.
    const lfoA = 0.21 + (seed % 7) * 0.004;
    const lfoB = 0.34;
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const breathA = 0.72 + 0.28 * Math.sin(2 * Math.PI * lfoA * t);
      const breathB = 0.75 + 0.25 * Math.sin(2 * Math.PI * lfoB * t + 1.7);
      buf[i] = air(p()) * 0.5 * breathB + band2(band1(p2())) * spec.insectGain * breathA;
    }
  }

  /**
   * Chirps. Deliberately dull and quiet: these are the FAR birds, the ones that
   * cannot be resolved, so they are low-passed hard and sit well under the bed.
   */
  const rand = rng(spec.seed ^ 0x1234567);
  let t = rand() * 2;
  while (t < SECONDS - 0.5) {
    const start = Math.round(t * RATE);
    const base = 900 + rand() * 1400;
    const len = 0.06 + rand() * 0.16;
    const pan = rand();
    const level = 0.02 + rand() * 0.05;
    const notes = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < notes; k++) {
      const off = start + Math.round(k * (len + 0.04) * RATE);
      const f = base * Math.pow(2, (rand() * 4 - 2) / 12);
      const dull = biquad('lowpass', 2200, 0.4);
      const m = Math.round(len * RATE);
      for (let i = 0; i < m; i++) {
        if (off + i >= n) break;
        const u = i / m;
        // A plateau, not a bare decay — `ambience.js` and `wildlife.js` both
        // spend a paragraph on why a decaying spectral flash is a mallet.
        const env = Math.min(1, u * 12) * Math.min(1, (1 - u) * 6);
        const ph = (2 * Math.PI * f * i) / RATE;
        const v = dull(Math.sin(ph + 1.2 * Math.sin(ph * 2)) * env * level);
        L[off + i] += v * (1 - pan);
        R[off + i] += v * pan;
      }
    }
    t += 0.4 + rand() * (2 / Math.max(0.05, spec.chirpRate));
  }

  // Normalise to a modest peak. A bed is a floor, not a master.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const g = 0.5 / Math.max(1e-6, peak);
  for (let i = 0; i < n; i++) {
    L[i] *= g;
    R[i] *= g;
  }
  return { L, R, n };
}

function wav({ L, R, n }) {
  const bytes = 44 + n * 4;
  const buf = Buffer.alloc(bytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(bytes - 8, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  let off = 44;
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), off);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), off + 2);
    off += 4;
  }
  return buf;
}

/**
 * The three placeholder beds.
 *
 * They differ in the ways the REAL day/dawn/night recordings will differ, so the
 * slot crossfade is exercised by something audibly distinct rather than by three
 * copies of one file: the day wall is loud, low and steady; the night one is
 * higher, thinner and more deeply pulsed; dawn is quieter with far more chirps
 * in it. Those are the same distinctions `ambience.js` draws between its cicada
 * and katydid beds, for the same reasons, and its header has the argument.
 */
const BEDS = [
  {
    slot: 'day',
    seed: 0xda9,
    insectHz: 1500,
    insectQ: 3.2,
    insectGain: 0.55,
    airHz: 2000,
    chirpRate: 0.35,
    // A recorded day bed is mostly insect wall, so the synthesised wall gives up
    // most of its level and the wind gives up about half.
    duck: { wind: 0.55, insects: 0.35 },
  },
  {
    slot: 'dawn',
    seed: 0xda3,
    insectHz: 1350,
    insectQ: 2.6,
    insectGain: 0.34,
    airHz: 2400,
    chirpRate: 1.4,
    // Dawn is birds, not insects: the wall it replaces is thin, so it takes less.
    duck: { wind: 0.6, insects: 0.6 },
  },
  {
    slot: 'night',
    seed: 0x519,
    insectHz: 1950,
    insectQ: 9,
    insectGain: 0.62,
    airHz: 1400,
    chirpRate: 0.12,
    // Wall-to-wall katydids: the synthesised night wall is almost entirely
    // redundant against a real one.
    duck: { wind: 0.5, insects: 0.25 },
  },
];


// ---------------------------------------------------------------------------
// loudness, encoding, manifest
// ---------------------------------------------------------------------------

/**
 * ==== EVERY BED IS NORMALISED TO THE SAME LOUDNESS BEFORE ENCODING ==========
 *
 * THIS IS THE MOST IMPORTANT THING THIS SCRIPT DOES, and it exists because of a
 * question that could not otherwise be answered.
 *
 * `manifest.gain` is a multiplier on whatever the file happens to contain. Field
 * recordings arrive anywhere from -1 dBFS (normalised by the uploader) to -30
 * (a quiet original left alone), a spread of nearly thirty decibels — so "the
 * right gain" would be a property of the FILE and not of the mix, every
 * measurement of it would be invalidated the moment a recording was swapped, and
 * a level table produced against the synthesised placeholder would transfer to
 * the real beds only by luck.
 *
 * So the encoder measures each source's integrated loudness and applies a single
 * linear gain to put it at `TARGET_LUFS`. After that, `manifest.gain` means the
 * same thing for every bed that has ever been through this script, the level
 * question is asked and answered once, and swapping a recording really is a data
 * change rather than a re-tune.
 *
 * A LINEAR GAIN, NOT `loudnorm`. ffmpeg's `loudnorm` filter is the obvious tool
 * and it is the wrong one: in its default dynamic mode it applies range
 * compression and a true-peak limiter, which is a processor deciding what a
 * rainforest should sound like. What a bed needs is the fader moved. So the
 * loudness is MEASURED with `ebur128` and the delta applied with `volume`, which
 * cannot alter anything but the level.
 *
 * -23 LUFS is EBU R128, chosen because it is a standard rather than because it
 * is special — the absolute number does not matter, only that every bed shares
 * it. It leaves plenty of headroom, so no realistic bed clips after the gain.
 */
const TARGET_LUFS = -23;

/**
 * ISO 9613-1 atmospheric absorption at 20 °C and 70% relative humidity, in
 * dB per kilometre. Rainforest conditions, and the humidity matters — dry air
 * absorbs high frequencies considerably harder, so a table picked for a
 * temperate afternoon would over-dull these beds.
 *
 * Used by `--distance`. See the long block in `encodeBed`.
 */
const AIR_ABSORPTION = [
  [63, 0.1],
  [125, 0.4],
  [250, 1.0],
  [500, 2.8],
  [1000, 5.0],
  [2000, 9.0],
  [4000, 22.9],
  [8000, 76.6],
  [16000, 168],
];

/**
 * Integrated loudness of a file, in LUFS, or null if ffmpeg cannot say.
 *
 * `ebur128` writes its summary to STDERR and ffmpeg still exits 0, so the output
 * has to be captured from stderr on the success path — the obvious
 * `execFileSync(...).toString()` returns an empty string and would silently
 * normalise nothing.
 */
function loudness(file) {
  /**
   * `spawnSync`, NOT `execFileSync`, and that is the whole bug this function
   * had. `execFileSync` RETURNS STDOUT and nothing else — so with ebur128
   * writing its summary to stderr and ffmpeg exiting 0, the returned string was
   * empty, the regex matched nothing, `null` came back, and every bed was
   * silently normalised by exactly 0.00 dB while the table printed "?" for the
   * source loudness. It looked like it worked.
   */
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-'],
    { encoding: 'utf8' }
  );
  const out = `${r.stderr ?? ''}${r.stdout ?? ''}`;
  // The per-frame log also contains `I:`, so the LAST match — the Summary
  // block's integrated figure — is the one wanted.
  const all = [...out.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

/**
 * Trim, normalise and encode one source into the two delivery formats.
 *
 * @param {string} src        any file ffmpeg can read
 * @param {string} slot       day | dawn | night
 * @param {object} [opts]
 * @param {number} [opts.start]   seconds into the source
 * @param {number} [opts.length]  seconds to take
 * @param {number} [opts.opus]    kbps for the Opus encode
 * @param {number} [opts.aac]     kbps for the AAC fallback
 */
function encodeBed(src, slot, { start = 0, length = null, opus = 64, aac = 96, distance = 0 } = {}) {
  const cut = [];
  // BEFORE `-i`, so ffmpeg seeks rather than decoding and discarding. On a
  // thirteen-minute source that is the difference between instant and not.
  if (start > 0) cut.push('-ss', String(start));
  if (length) cut.push('-t', String(length));

  /**
   * Trim FIRST, then measure, and the order matters. Loudness is integrated over
   * whatever it is given, so measuring the whole thirteen minutes and applying
   * that delta to a ninety-second excerpt would normalise the excerpt to the
   * average of a recording it is only a small part of.
   */
  const trimmed = resolve(OUT, `.${slot}-trim.wav`);
  execFileSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', ...cut, '-i', src, '-ac', '2', '-ar', String(RATE), trimmed],
    { stdio: 'inherit' }
  );

  /**
   * ==== THE TILT IS BAKED IN BEFORE THE LOUDNESS IS MEASURED =================
   *
   * This ordering is not a detail, and getting it wrong would have quietly
   * destroyed the one invariant this script exists to hold.
   *
   * `--distance` REMOVES ENERGY, and it removes a different amount from each
   * recording — most from night, which is the brightest of the three, least from
   * day. Measure first and filter afterwards and every bed leaves here at some
   * level BELOW -23 LUFS, each by its own private amount, which is precisely the
   * thirty-decibel spread the block on loudness above exists to abolish. The
   * symptom would be night quietly sitting a decibel or two under day for the
   * rest of the project's life, with a manifest confidently recording that both
   * were normalised to the same figure.
   *
   * So the tilt is applied to the trimmed intermediate, and the loudness is
   * measured on the RESULT. `-23 LUFS` then means what it says for every bed, at
   * whatever distance each was placed, and `manifest.gain` keeps meaning one
   * thing across all of them.
   */
  if (distance > 0) {
    const entries = AIR_ABSORPTION.map(
      ([hz, dbPerKm]) => `entry(${hz},${((-dbPerKm * distance) / 1000).toFixed(2)})`
    ).join(';');
    const tilted = resolve(OUT, `.${slot}-tilt.wav`);
    execFileSync(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-i', trimmed, '-af',
        `firequalizer=gain_entry='${entries}'`, tilted],
      { stdio: 'inherit' }
    );
    rmSync(trimmed, { force: true });
    renameSync(tilted, trimmed);
  }

  const measured = loudness(trimmed);
  const deltaDb = measured === null ? 0 : TARGET_LUFS - measured;

  /**
   * ==== THE RECORDING IS CLOSE AND THE BED IS FAR ============================
   *
   * A field recordist stands IN the chorus. `bed.js` wants the chorus a couple
   * of hundred metres away — that is the entire premise of the layer, the thing
   * that cannot be synthesised, the unresolvable middle distance. Those are not
   * the same signal, and the difference is not level. It is the top end.
   *
   * Measured on the three approved recordings, straight out of the encoder:
   *
   *   day    centroid 6483 Hz   night 9400 Hz   dawn 5786 Hz
   *
   * Night is at NINE KILOHERTZ, because katydids stridulate up there and the mic
   * was underneath them. `audio-probe.mjs` fails anything over 2600 Hz and it was
   * right to: with the bed live, eight stages failed, `ambience only` went from
   * 1720 Hz to 3492 Hz, and every music row roughly doubled its centroid.
   *
   * So the beds are filtered by DISTANCE, using ISO 9613-1 atmospheric
   * absorption at 20 °C and 70% relative humidity — a published table for the
   * actual physical process, rather than a low-pass tuned until a gate went
   * green. That distinction matters: the number below is a claim about where the
   * chorus is, and it can be argued with on those terms.
   *
   * TWO THINGS THIS DOES THAT ARE NOT OBVIOUS.
   *
   * FIRST, IT MAKES THE HARSH FRACTION WORSE BEFORE IT MAKES IT BETTER. Air
   * absorption removes 8 kHz roughly eight times faster than 2 kHz, so the
   * PROPORTION of what survives that lands in the 2–6 kHz band goes UP — night
   * measured 0.285 before and 0.650 after. That reads like a regression against
   * the one gate this repo has least headroom on. It is not: the absolute energy
   * in that band falls 4.6x, and `harsh` is a fraction of a master bus this bed
   * is only part of. The fraction is the wrong number to watch here; the master
   * is measured below and it is what decides.
   *
   * SECOND, AIR ABSORPTION IS THE ONLY TERM MODELLED. Dense foliage scatters and
   * absorbs on top of this, and it is frequency-dependent in the same direction
   * and of the same rough magnitude. So the distance that SOUNDS right is
   * larger than the distance you would have to walk — this knob is honest about
   * the physics it includes and silent about the physics it does not, and a
   * value of 250 here does not assert the birds are 250 m away.
   */
  const filter = deltaDb ? ['-af', `volume=${deltaDb.toFixed(2)}dB`] : [];

  const webm = resolve(OUT, `${slot}.webm`);
  const m4a = resolve(OUT, `${slot}.m4a`);
  /**
   * `-application audio` rather than libopus's speech-tuned default. This is a
   * wideband diffuse signal and the speech modes throw away exactly the top end
   * a bed is made of.
   *
   * `-movflags +faststart` on the m4a so the moov atom is at the front: without
   * it a media element must fetch the tail of the file before it can begin,
   * which turns a stream into a download and defeats the point of the file.
   */
  execFileSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-i', trimmed, ...filter, '-c:a', 'libopus',
      '-b:a', `${opus}k`, '-vbr', 'on', '-application', 'audio', webm],
    { stdio: 'inherit' }
  );
  execFileSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-i', trimmed, ...filter, '-c:a', 'aac',
      '-b:a', `${aac}k`, '-movflags', '+faststart', m4a],
    { stdio: 'inherit' }
  );

  rmSync(trimmed, { force: true });
  return {
    slot,
    seconds: length,
    distance,
    sourceLufs: measured,
    appliedDb: deltaDb,
    webm: statSync(webm).size,
    m4a: statSync(m4a).size,
    opus,
    aac,
  };
}

/**
 * THE MANIFEST. This is the format `bed.js` reads and the whole point of it is
 * that a bed can be added, removed or swapped without touching a line of code.
 *
 *   gain        the whole layer's level, applied to a bed already normalised to
 *               TARGET_LUFS — which is what makes one number right for every
 *               recording. See the block on loudness above.
 *   crossfade   seconds. The audible loop period is `duration - crossfade`.
 *   seamTrimDb  the correction for a bed that is correlated with itself across
 *               the seam. MEASURED by audio-bed-check.mjs, never guessed — see
 *               TRAP THREE in bed.js.
 *   beds[].slot day | dawn | night. Slots not present are simply not used, and
 *               the weights normalise over whatever is here, so a one-bed
 *               manifest is legal and plays that bed all day.
 *   beds[].sources  in preference order; the first whose `type` the browser
 *               admits to is used. Opus first, AAC second — Safari reached full
 *               Opus only in iOS 18.4.
 *   beds[].duck how far the synthesised wind and insect wall give way to THIS
 *               bed. A fact about the recording, which is why it lives with the
 *               recording rather than in ambience.js.
 *   beds[].source  where the audio came from, its licence, and the exact
 *               timecodes trimmed. Not read by any code. It is here so the
 *               attribution and the trim are reproducible from the artefact
 *               itself rather than from somebody's memory — see CREDITS.md.
 *
 * MERGED, NOT OVERWRITTEN, because the real beds are encoded one at a time as
 * they arrive and doing `day` must not delete `night`.
 */
function writeManifest(entries, { note } = {}) {
  const path = resolve(OUT, 'manifest.json');
  let manifest = { version: 1, gain: 0.3, crossfade: CROSSFADE, seamTrimDb: 0, beds: [] };
  if (existsSync(path)) {
    try {
      manifest = { ...manifest, ...JSON.parse(readFileSync(path, 'utf8')) };
    } catch {
      /* unreadable; start again rather than refusing to run */
    }
  }
  if (note !== undefined) manifest.note = note;
  for (const e of entries) {
    const entry = {
      slot: e.slot,
      sources: [
        { type: 'audio/webm; codecs="opus"', src: `${e.slot}.webm` },
        { type: 'audio/mp4; codecs="mp4a.40.2"', src: `${e.slot}.m4a` },
      ],
      gain: 1,
      duck: e.duck,
      ...(e.source ? { source: e.source } : {}),
    };
    const at = manifest.beds.findIndex((b) => b.slot === e.slot);
    if (at >= 0) manifest.beds[at] = { ...manifest.beds[at], ...entry };
    else manifest.beds.push(entry);
  }
  /**
   * The PLACEHOLDER note comes off only when EVERY bed is a real recording.
   *
   * The real beds are encoded one slot at a time, so there is a window where the
   * manifest is half synthesised noise and half field recording. Clearing the
   * note on the first real encode would leave the other two lying about what
   * they are, and this note is the thing that stops somebody shipping a forest
   * made of pink noise believing it is the Amazon.
   */
  if (manifest.beds.length && manifest.beds.every((b) => b.source)) delete manifest.note;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const rows = [];

if (args.in) {
  /**
   * ==== REAL SOURCE MODE =====================================================
   *
   * One slot per invocation, merged into whatever manifest is already there.
   *
   *   node scripts/audio-bed-make.mjs --in=/path/473569.wav --slot=day \
   *        --start=180 --length=90 --opus=48 \
   *        --title="Amazon Jungle - Day" --author=RTB45 \
   *        --url=https://freesound.org/s/473569/ --licence="CC BY 4.0"
   *
   * `--duckWind` / `--duckInsects` override the defaults, which are the ones
   * argued for in the placeholder table above and remain a guess until somebody
   * has actually heard the recording.
   */
  const slot = args.slot;
  if (!['day', 'dawn', 'night'].includes(slot)) {
    console.error('--in needs --slot=day|dawn|night');
    process.exit(1);
  }
  if (!existsSync(args.in)) {
    console.error(`no such file: ${args.in}`);
    process.exit(1);
  }
  const start = Number(args.start ?? 0);
  const length = args.length ? Number(args.length) : 90;
  const row = encodeBed(args.in, slot, {
    start,
    length,
    opus: Number(args.opus ?? 64),
    aac: Number(args.aac ?? 96),
    distance: Number(args.distance ?? 0),
  });
  row.duck = {
    wind: Number(args.duckWind ?? 0.55),
    insects: Number(args.duckInsects ?? 0.35),
  };
  row.source = {
    title: args.title ?? null,
    author: args.author ?? null,
    url: args.url ?? null,
    licence: args.licence ?? null,
    // The whole point of recording these: the trim is reproducible, and a CC BY
    // licence obliges us to say the work was changed.
    originalFile: args.in.split(/[\\/]/).pop(),
    /**
     * WHAT THE SOURCE FILE ACTUALLY WAS, when that is not simply "the original".
     *
     * Freesound serves originals only to a logged-in session, and this project
     * does not hold one — so the beds were built from the public `-hq.mp3`
     * preview transcode instead. That is a real fact about the artefact: the
     * delivered Opus is a SECOND lossy generation, and anyone later wondering
     * why a spectrogram tops out where it does, or whether re-encoding at a
     * higher bitrate would recover anything, needs to know it before they spend
     * an afternoon finding out. `--note` puts it in the manifest beside the
     * timecodes rather than in a commit message nobody reads.
     */
    ...(args.note ? { note: args.note } : {}),
    trimmedFrom: `${start}s`,
    trimmedLength: `${length}s`,
    // Recorded because it is a change to the work that CC BY obliges us to
    // declare, and because the centroid of the delivered file is meaningless
    // without it. `sourceLufs` below is measured AFTER this is applied.
    ...(row.distance > 0
      ? { distanceFilter: `ISO 9613-1 air absorption, ${row.distance} m at 20 C / 70% RH` }
      : {}),
    normalisedTo: `${TARGET_LUFS} LUFS`,
    sourceLufs: row.sourceLufs,
    gainApplied: `${row.appliedDb.toFixed(2)} dB`,
    modified:
      'trimmed, ' +
      (row.distance > 0 ? 'distance-filtered, ' : '') +
      'loudness-normalised, re-encoded and looped',
  };
  rows.push(row);
  writeManifest(rows);
  console.log(ffmpegVersion);
  console.log(`\n${slot}: ${args.in}`);
  console.log(`  trimmed         ${start}s .. ${start + length}s  (${length}s)`);
  console.log(
    `  loudness        ${row.sourceLufs === null ? '?' : `${row.sourceLufs.toFixed(1)} LUFS`}` +
      ` -> ${TARGET_LUFS} LUFS  (${row.appliedDb >= 0 ? '+' : ''}${row.appliedDb.toFixed(2)} dB, linear)`
  );
  console.log(`  opus ${String(row.opus).padStart(3)}k       ${kb(row.webm)}   (${((row.webm * 8) / length / 1000).toFixed(1)} kbps actual)`);
  console.log(`  aac  ${String(row.aac).padStart(3)}k       ${kb(row.m4a)}`);
  console.log(`\nwrote ${resolve(OUT, 'manifest.json')}`);
  console.log('now run `npm run audio:bed` to measure the seam, and update CREDITS.md.');
} else {
  for (const bed of BEDS) {
    const wavPath = resolve(OUT, `${bed.slot}.wav`);
    writeFileSync(wavPath, wav(synth(bed)));
    const row = encodeBed(wavPath, bed.slot, {
      length: SECONDS,
      opus: Number(args.opus ?? 64),
      aac: Number(args.aac ?? 96),
    });
    rmSync(wavPath, { force: true });
    row.duck = bed.duck;
    rows.push(row);
  }
  writeManifest(rows, {
    note:
      'PLACEHOLDER — synthesised by scripts/audio-bed-make.mjs. Not a field recording. ' +
      'No third-party audio has been licensed or downloaded.',
  });

  console.log(ffmpegVersion);
  console.log(`\n${SECONDS}s stereo @ ${RATE} Hz, crossfade ${CROSSFADE}s -> loop period ${SECONDS - CROSSFADE}s`);
  console.log(`normalised to ${TARGET_LUFS} LUFS by linear gain, so manifest.gain means the same here as for a real bed\n`);
  console.log(' ', 'slot'.padEnd(9), 'src LUFS'.padEnd(10), 'applied'.padEnd(11), 'opus'.padEnd(11), 'aac'.padEnd(11), 'duck (wind/insects)');
  let totalWebm = 0;
  for (const r of rows) {
    totalWebm += r.webm;
    console.log(
      ' ',
      r.slot.padEnd(9),
      `${r.sourceLufs === null ? '?' : r.sourceLufs.toFixed(1)}`.padEnd(10),
      `${r.appliedDb >= 0 ? '+' : ''}${r.appliedDb.toFixed(2)} dB`.padEnd(11),
      kb(r.webm).padEnd(11),
      kb(r.m4a).padEnd(11),
      `${r.duck.wind} / ${r.duck.insects}`
    );
  }
  console.log(`\n  opus total ${kb(totalWebm)} (${((totalWebm * 8) / SECONDS / rows.length / 1000).toFixed(1)} kbps avg)`);
  console.log(`\nwrote ${OUT}`);
  console.log('these are TEST SIGNALS, not a bed. See the header, and the shortlist for the real thing.');
}
