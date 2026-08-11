import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * WHAT A PASTED RECORD SOUNDS LIKE ON A TRIP, WITH NUMBERS INSTEAD OF EARS.
 *
 * `audio-probe.mjs` measures eight stages of a trip and has never once heard a
 * streamed track. It cannot: the only music on the machine while it runs is the
 * synthesised jukebox, which is sparse, quiet and mono. Every threshold in that
 * file has therefore been guarding the one source that was never going to fail,
 * and the complaint that started this — a YouTube link turning to echo and then
 * to white noise during a trip — was invisible to it by construction. Same shape
 * of hole as the stereo-spread bug in impulse.js, which also survived for months
 * because nothing loud, broadband and CONTINUOUS ever went through the thing
 * that was broken.
 *
 * So this feeds the graph a synthetic mastered record — dense, broadband, loud,
 * with a kick on every beat — through a REAL `ExternalTrack`, and measures it
 * sober and at the peak of a trip.
 *
 * THE TWO NUMBERS THAT MATTER, and neither is in audio-probe:
 *
 *   TAIL        the record's reverb one second after the record itself is
 *               muted, as a fraction of what the cabinet was putting out while
 *               it played. This is "very echoey" stated as a quantity, and it is
 *               the number that decides whether this file passes. Muting is the
 *               only honest way to see it: while the source is playing, the tail
 *               is buried underneath it and every full-mix metric is dominated
 *               by the dry signal.
 *
 * NEITHER FLATNESS COLUMN WORKS, AND BOTH ARE PRINTED ANYWAY.
 *
 * Spectral flatness — geometric mean over arithmetic mean, 1 being noise and 0
 * being a few strong partials — is the obvious way to measure "sounds like white
 * noise" and this script was built around it first. It does not do the job, on
 * the full mix or on the tail:
 *
 *   FLAT     went DOWN on the broken build at the peak of a trip, 0.270 to
 *            0.214, when the record was at its noisiest. A large low-mid reverb
 *            tilts the spectrum, and a tilted spectrum scores as less flat even
 *            when every bit of the tilt is made of noise.
 *
 *   TAILFLT  reads 0.004 on the broken build and 0.003 on the fixed one. It is
 *            measuring the tail's spectral TILT, which both builds have, rather
 *            than its noisiness.
 *
 * What actually distinguishes them is the tail's LEVEL, and on reflection that
 * is not a consolation prize — it is the mechanism. A convolution tail is a sum
 * of hundreds of scrambled copies of its input and is therefore always noise-
 * shaped; whether a listener CALLS it noise is a question of whether it is loud
 * enough to compete with the record that spawned it. At 56% it is the loudest
 * thing in the room and the ear gives up trying to hear past it. At 12% it is a
 * room. Same spectrum, same flatness, different experience.
 *
 * Both columns stay because they are nearly free and they move for reasons worth
 * looking at. Neither is a threshold, and the paragraph above is here so nobody
 * spends another evening trying to make one of them into one.
 *
 * Run against `npm run dev`. No server and no network needed: the record is
 * generated in the page as a WAV blob, so nothing here touches YouTube.
 *
 * NUMBERS FROM BEFORE 2026-08-11 ARE NOT COMPARABLE WITH NUMBERS AFTER IT. This
 * script used to measure from wherever the player spawned, which is about nine
 * metres from the rig, while telling the record's unfiltered path that it was
 * standing at the cabinet. It now moves the body to the rig so that every path
 * really is at its reference distance. Everything got louder — that is the point
 * — and any figure quoted in a comment from an earlier run was taken at the
 * other distance.
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
  const t = m.text();
  // The ExternalTrack constructor points its element at /api/youtube/audio
  // before we redirect it at the blob, and with no signalling server running
  // that request fails. It is this script's own doing and says nothing about
  // the app.
  if (m.type() === 'error' && !/youtube|Failed to load resource|MEDIA_ELEMENT/i.test(t)) problems.push(`[error] ${t}`);
});

// Same guard as every other measuring script here: an HMR update landing
// mid-run re-evaluates modules underneath the measurement and the failure is
// silent. See play-check.mjs.
await page.routeWebSocket(/.*/, () => {});

await page.goto(URL_, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForFunction(() => window.RR.audio?.ctx != null && window.RR.audio.ready === true, {
  timeout: 25000,
});
await page.waitForTimeout(1200);

/**
 * Build the record, hand it to a real `ExternalTrack`, and stop the synthesised
 * jukebox so the only music in the room is the one being measured.
 *
 * The signal is deliberately what a mastered mix is and the synth jukebox is
 * not: continuous (nothing ever stops), broadband (content from 40 Hz to 12
 * kHz), transient-rich (a kick every 500 ms, hats between) and LOUD (peaks
 * pushed to 0.89, which is roughly where a modern master sits). Those four
 * properties, not the notes, are what a nine-second reverb turns into noise.
 */
await page.evaluate(async () => {
  const RR = window.RR;
  RR.music.stop();

  const ctx = RR.audio.ctx;
  const rate = ctx.sampleRate;
  const seconds = 8;
  const n = rate * seconds;
  const L = new Float32Array(n);
  const Rc = new Float32Array(n);

  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const beat = 0.5; // 120 bpm
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const phase = (t % beat) / beat;

    // Kick: a swept sine with a fast body. The transient the attack detector sees.
    const kEnv = Math.exp(-phase * beat * 14);
    const kick = Math.sin(2 * Math.PI * (52 + 60 * Math.exp(-phase * beat * 30)) * t) * kEnv * 0.85;

    // Bass line, moving every two beats.
    const step = Math.floor(t / (beat * 2)) % 4;
    const bassHz = [55, 61.7, 73.4, 49][step];
    const bass = (Math.sin(2 * Math.PI * bassHz * t) + 0.4 * Math.sin(4 * Math.PI * bassHz * t)) * 0.34;

    // A sustained chord with real harmonics — the mids that get smeared.
    let chord = 0;
    for (const f of [220, 277.2, 329.6, 440, 554.4]) {
      chord += Math.sin(2 * Math.PI * f * t + f) * 0.055;
      chord += Math.sin(2 * Math.PI * f * 2 * t + f) * 0.022;
    }

    // Hats: bursts of noise on the off-beats. The top end.
    const hPhase = (t % (beat / 2)) / (beat / 2);
    const hat = (rnd() * 2 - 1) * Math.exp(-hPhase * beat * 60) * 0.22;

    // A little broadband bed so the spectrum is never empty anywhere.
    const bed = (rnd() * 2 - 1) * 0.02;

    const mono = kick + bass + chord + bed;
    // Slightly different hats and chord phase per ear: a real record is not mono.
    L[i] = mono + hat;
    Rc[i] = mono + (rnd() * 2 - 1) * Math.exp(-hPhase * beat * 60) * 0.22;
  }

  // Hard-limit to a modern master's peak rather than normalising: the point is
  // that this arrives hot, because that is what pasted links do.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(Rc[i]));
  const g = 0.89 / peak;
  for (let i = 0; i < n; i++) {
    L[i] *= g;
    Rc[i] *= g;
  }

  // --- WAV, 16-bit stereo -------------------------------------------------
  const bytes = 44 + n * 4;
  const buf = new ArrayBuffer(bytes);
  const view = new DataView(buf);
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, bytes - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, n * 4, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    view.setInt16(off, Math.max(-1, Math.min(1, L[i])) * 32767, true);
    view.setInt16(off + 2, Math.max(-1, Math.min(1, Rc[i])) * 32767, true);
    off += 4;
  }
  const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));

  /**
   * A second copy of the class, imported here rather than reached through
   * `RR.externalTrack` (which is a getter with no setter).
   *
   * Safe for this module specifically: `external-track.js` holds exactly one
   * piece of module state, the memoised `canPlayOpus`, and nothing in this
   * script or the app reads it across the two copies. The general warning about
   * duplicate modules under HMR — see the `tripUniforms` comment in main.js —
   * applies to modules whose STATE is the thing being measured, and this one's
   * is not.
   */
  let ExternalTrack;
  try {
    ({ ExternalTrack } = await import('/src/audio/external-track.js'));
  } catch {
    /**
     * Only the dev server has `/src`. A built bundle has the class inlined and
     * minified with no way in from outside, and `RR.externalTrack` is a getter
     * with no setter — so there is no honest way to put a record through the
     * real ExternalTrack against `dist`, and pretending otherwise by rebuilding
     * its graph here would mean this script silently stopped testing the file it
     * exists to test.
     *
     * This is a dev-server tool and says so rather than dying in a dynamic
     * import forty lines later. `npm run build` is verified by `check:perfstrip`
     * and by the worklet's own presence in `dist/audio/`.
     */
    throw new Error(
      'record-space.mjs needs the dev server (npm run dev, port 5180) — it imports ' +
        'src/audio/external-track.js, which does not exist in a production build.'
    );
  }
  const track = new ExternalTrack(
    ctx,
    RR.audio,
    { id: 'probe', title: 'probe' },
    RR.speakers.speakerL,
    RR.speakers.speakerR
  );
  track.el.src = url;
  track.el.loop = true;
  await track.play();

  /**
   * STAND AT THE RIG — MOVE THE PLAYER, NOT JUST THE TRACK'S OWN DISTANCE.
   *
   * `setDistance(0)` only tells the unfiltered path to behave as though the
   * listener were at the cabinet. The `PannerNode`s take their distance from the
   * real listener position, which is wherever the player happens to have spawned
   * — so half the record was being measured at the reference distance and half
   * of it forty feet away.
   *
   * That was harmless while both halves radiated from the same two boxes. It
   * stopped being harmless the moment a subwoofer became a THIRD position: the
   * crossover moved the low band from a path the harness was holding at full
   * level onto one it was attenuating, and the script duly reported that adding
   * a subwoofer had cost five decibels of bass. It had not. The measurement had.
   * The subwoofer is gone and the correction stays, because it was never really
   * about the sub — it is about half the record being measured at one distance
   * and half at another, which was true before that box existed.
   *
   * So the body is teleported to just in front of the rig, inside every source's
   * reference distance, and the camera follows it on the next frame. Now every
   * path really is at unity and the numbers are about the processing.
   *
   * `position` is the midpoint between the two speakers, live — the player can
   * move them, so this asks where they are rather than assuming.
   */
  const j = RR.speakers;
  const ahead = 2.0;
  RR.controller.position.x = j.position.x + Math.sin(0.22) * ahead;
  RR.controller.position.z = j.position.z + Math.cos(0.22) * ahead;
  track.setDistance(0);
  window.__record = track;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  RR.audio.master.connect(analyser);
  window.__probe = {
    ctx,
    analyser,
    // The limiter's own gain reduction, in dB. Reading it is the only direct
    // measurement of the thing this project keeps rediscovering the hard way:
    // a mastered record arrives close to a limiter set at -5 dBFS, and anything
    // added underneath it is paid for in gain reduction that tracks the kick
    // drum. Peak and clip counts cannot see that — a mix can pump audibly and
    // never come near full scale, which is exactly what "sounds compressed"
    // means.
    limiter: RR.audio.limiter,
    freq: new Float32Array(analyser.frequencyBinCount),
    time: new Float32Array(analyser.fftSize),
  };
});

/**
 * `--old` PUTS THE BUG BACK, and this flag is not a curiosity.
 *
 * A regression gate that has only ever seen the fixed build is a gate nobody has
 * tested. The thresholds at the bottom of this file were chosen against the
 * numbers below and they are worth exactly as much as the demonstration that
 * they fail on the topology this was written to replace — so that topology is
 * reconstructible from the console, one edge at a time:
 *
 *   preMaster into the send (every bus, plus the forest reverb's own return,
 *   into a 9.5-second tail), the world and sfx taps removed so the world is not
 *   counted twice, and the music's own hall and low band cut off at the source.
 *
 * This is the graph as it stood before, node for node. What it cannot restore is
 * the `_bloom` change, which is arithmetic rather than wiring — but the bloom is
 * frozen for the whole tail measurement anyway (`settle` sets dt to zero), so it
 * does not participate in the number this flag exists to produce.
 *
 *   node scripts/record-space.mjs --old
 */
/**
 * `--nosub` SILENCES THE OCTAVE DIVIDER AND LEAVES EVERYTHING ELSE ALONE.
 *
 * The low shelf covers 30-150 Hz, so it lifts the band under 55 Hz as well —
 * which means the headline "sub +9 dB" cannot, on its own, tell a manufactured
 * octave from a shelf doing what a shelf does. If the divider's confidence
 * gating never opened on real material it would output silence, the shelf would
 * carry the whole measurement, and the number would look exactly the same. This
 * flag is the difference between the two.
 *
 *   node scripts/record-space.mjs --nosub
 *
 * ONE READING GOES STRANGE UNDER THIS FLAG AND IT IS NOT A BUG. `subGain` in the
 * node readout drops to 0 (or to a hundredth of its target) while `lowGain` and
 * `harmGain` sit exactly where the arithmetic says they should — which looks
 * alarming, because all three are written from the same `weight` on the same
 * line of `update`. The cause is that disconnecting the worklet leaves `subDc`
 * and `subGain` with no live input at all, and a gain node with nothing flowing
 * through it is not processed, so the automation on its AudioParam stops being
 * evaluated and `.value` stops advancing. The parameter is still being written
 * every frame and would resume instantly. Only this flag can produce it; do not
 * go looking for a NaN.
 */
if (args.nosub) {
  await page.evaluate(() => {
    window.RR.tripAudio.nodes.subNode?.disconnect();
  });
  console.log('!! --nosub: the octave divider is disconnected\n');
}

if (args.old) {
  await page.evaluate(() => {
    const e = window.RR.audio;
    const n = window.RR.tripAudio.nodes;
    e.trims.world.disconnect(n.send);
    e.trims.sfx.disconnect(n.send);
    e.preMaster.connect(n.send);
    n.musicTrim.disconnect(n.hallHp);
    n.musicTrim.disconnect(n.lowHp);
  });
  console.log('!! --old: the pre-fix topology has been rebuilt in the page\n');
}

await page.waitForTimeout(1500);

async function measure(ms) {
  return page.evaluate(async (duration) => {
    const { ctx, analyser, limiter, freq, time } = window.__probe;
    const bins = analyser.frequencyBinCount;
    const acc = new Float64Array(bins);
    let frames = 0;
    let peak = 0;
    let sumSq = 0;
    let samples = 0;
    let clipped = 0;
    let grSum = 0;
    let grWorst = 0;
    /**
     * EVERY READING, KEPT, BECAUSE PUMPING IS A SWING AND NOT AN AVERAGE.
     *
     * `grMean` and `grWorst` were the only two limiter numbers here and between
     * them they missed the thing a listener actually reports. A limiter sitting
     * at a steady -4 dB is inaudible — it is a volume control. A limiter moving
     * between 0 and -3 dB twice a second is the kick drum turning the whole
     * record down and letting it back up, which is what "pumping" is and is what
     * the player heard on a build whose mean was -0.6 dB and whose worst was
     * -1.8. Both of those looked fine. The swing between them did not exist as a
     * column.
     *
     * So the whole series is kept and reduced to a 5th-to-95th-percentile
     * spread. Percentiles rather than max-minus-min because one stray sample at
     * a phase boundary should not decide the number, and the samples arrive at
     * about 33 Hz — roughly sixteen per beat at the 120 bpm this record runs at,
     * which is enough to see the shape of the duck rather than just its floor.
     */
    const grs = [];
    const started = performance.now();
    while (performance.now() - started < duration) {
      // Sampled per frame rather than averaged by the browser: `reduction` is an
      // instantaneous read, so the worst value across the window is what says
      // whether the limiter is riding the music.
      const gr = limiter.reduction;
      grSum += gr;
      grs.push(gr);
      if (gr < grWorst) grWorst = gr;
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
      await new Promise((r) => setTimeout(r, 30));
    }
    const nyquist = ctx.sampleRate / 2;
    const binHz = nyquist / bins;
    let total = 0;
    let weighted = 0;
    let harsh = 0;
    let logSum = 0;
    /**
     * Band energies in raw analyser units, ABSOLUTE rather than as a share of
     * the total — and the difference is the whole point of them being here.
     *
     * The first version of this script reported low-band energy as a fraction,
     * which cannot answer "is there more bass" at all: taking a great deal of
     * mid-range reverb OUT of the mix raises the bass fraction without adding a
     * single decibel of bass, and adding bass while the drone is also playing
     * moves the fraction by an amount that depends on the drone. It reported the
     * low share FALLING on a change that was adding five decibels of low end.
     *
     * Power, summed, square-rooted, so these are comparable to each other and
     * across runs. What "more bass" actually means is `lowE / midE` going up.
     */
    let subE = 0;
    let lowE = 0;
    let midE = 0;
    let highE = 0;
    /**
     * 160-600 Hz, OVERLAPPING `midE` ON PURPOSE.
     *
     * This is where a bass harmonic generator puts its output, and it is the one
     * band that was invisible here: it lives inside `midE`, which spans three and
     * a half octaves and is dominated by the chord. Adding six decibels of second
     * and third harmonic moves `midE` by a fraction of a decibel and moves this
     * by all of it.
     *
     * Deliberately NOT carved out of `midE`. Every `sub/mid` and `low/mid` figure
     * this script has ever printed is against 160-2000, and redefining the
     * denominator to make room for a new column would silently invalidate
     * comparison with every run before it. An overlapping diagnostic band costs
     * one accumulator and breaks nothing.
     */
    let bodyE = 0;
    for (let i = 1; i < bins; i++) {
      const m = acc[i] / Math.max(1, frames);
      const hz = i * binHz;
      total += m;
      weighted += m * hz;
      if (hz >= 2000 && hz <= 6000) harsh += m;
      // 55 Hz is the divider's own lower bound, so everything below it is either
      // the octave this build manufactures or content the record already had
      // down there. Split out from `lowE` because the shelf and the sub are
      // separate mechanisms answering separate halves of the request, and one
      // band covering both cannot say which of them is working.
      if (hz <= 55) subE += m * m;
      else if (hz <= 160) lowE += m * m;
      else if (hz <= 2000) midE += m * m;
      else highE += m * m;
      if (hz > 160 && hz <= 600) bodyE += m * m;
      logSum += Math.log(m + 1e-12);
    }
    const mean = total / (bins - 1);
    const geo = Math.exp(logSum / (bins - 1));
    grs.sort((a, b) => a - b);
    const pct = (p) => (grs.length ? grs[Math.min(grs.length - 1, Math.floor(p * (grs.length - 1)))] : 0);
    return {
      rms: Math.sqrt(sumSq / Math.max(1, samples)),
      peak,
      clipped,
      grMean: grSum / Math.max(1, frames),
      grWorst,
      // How far the limiter travels, in dB. See the note where `grs` is declared.
      grSwing: pct(0.95) - pct(0.05),
      centroid: total > 0 ? weighted / total : 0,
      harsh: total > 0 ? harsh / total : 0,
      flatness: mean > 0 ? geo / mean : 0,
      subE: Math.sqrt(subE),
      lowE: Math.sqrt(lowE),
      midE: Math.sqrt(midE),
      highE: Math.sqrt(highE),
      bodyE: Math.sqrt(bodyE),
    };
  }, ms);
}

/** What the trip layer's own gains are actually doing, so a silent send shows. */
const tripNodes = () =>
  page.evaluate(() => {
    const n = window.RR.tripAudio?.nodes;
    if (!n) return null;
    const v = (g) => Number(g.gain.value.toFixed(3));
    return {
      wet: v(n.wet),
      send: v(n.send),
      hallWet: v(n.hallWet),
      lowGain: v(n.lowGain),
      subGain: v(n.subGain),
      harmGain: v(n.harmGain),
      // Whether the octave divider actually loaded. It is allowed not to, so
      // "the bass got deeper" has to be reported next to "the thing that makes
      // it deeper is present" or a silent worklet failure reads as a tuning
      // problem in the shelf.
      sub: n.subNode ? 'on' : 'ABSENT',
      hallBand: [Math.round(n.hallHp.frequency.value), Math.round(n.hallLp.frequency.value)],
      level: Number(window.RR.director.eased.toFixed(3)),
      // Whether this run measured the numbers in tuning.js or a browser somebody
      // had been turning knobs in. Nothing persists a tuning, so this should
      // always read 'default' — which is exactly why it is worth printing: the
      // day it does not, every threshold below is describing something that is
      // not in the source.
      tuning: window.RR.tuning?.modified().length ? window.RR.tuning.modified().join(',') : 'default',
      // The one tuning combination with a known failure mode — see the threshold
      // at the bottom of this file.
      cabinetSum: Number((window.RR.tuning.TUNING.dryMix + window.RR.tuning.TUNING.wetMix).toFixed(2)),
    };
  });

/**
 * The record's reverb tail, on its own. This function is the measurement; the
 * rest of the script is scaffolding around it.
 *
 * FOUR VERSIONS OF THIS WERE WRONG BEFORE ONE WAS RIGHT, and each failure is
 * worth more than the code:
 *
 *   1. Mute the record, measure what is left. That is not the record's reverb,
 *      it is the record's reverb plus the drone, the breath, the sparks, the
 *      wind and every bird in the wood. It reported 82% and could not say how
 *      much of that was the record at all.
 *
 *   2. Subtract a bed measured later. Better, but at the peak of a trip the bed
 *      is more than half the total RMS, so the residual after subtracting two
 *      large numbers is mostly whatever they disagree about.
 *
 *   3. Mute the world first, then the record. Right idea, wrong timing: the
 *      world's own tail rings out of a 9.5-second convolver for ten seconds
 *      after its bus goes quiet, so muting them a second apart puts the world's
 *      decay inside the near window and none of it inside the far one.
 *
 *   4. All of the above, with the trip's clock frozen so nothing drifts. Still
 *      unusable, and the reason is the most interesting one: the bed is not
 *      steady even when the trip is standing still. Each of the five drone
 *      voices has its own amplitude LFO between 0.017 and 0.085 Hz — periods of
 *      twelve to sixty seconds — and the murmurs come and go over eight to
 *      twenty. Two windows thirteen seconds apart therefore catch the drone at
 *      two genuinely different amplitudes, and the subtraction went NEGATIVE on
 *      both trip stages. There is no averaging window that fixes this: it is
 *      slower than the thing being measured.
 *
 * So the bed is REMOVED rather than subtracted. Not by muting the trip's
 * outputs, which would be circular — a future topology that sent the record
 * back through the cosmos tail would have that tail muted along with everything
 * else and this would report a clean bill on the exact bug it exists to catch.
 * Instead the trip's own GENERATORS are disconnected — the drone oscillators,
 * the breath noise, the ego-death pulse — and every processing path is left
 * exactly as it is. Whatever the trip does to the MUSIC still happens, through
 * whichever convolver it happens through, and the trip simply has nothing of
 * its own to say while it happens.
 *
 * Sparks need no handling: they are scheduled off `dt`, which `settle` has
 * already frozen at zero, so none are ever born and the last of them is gone
 * within five seconds.
 *
 * THE DENOMINATOR IS MEASURED IN HERE TOO, under the same conditions, and not
 * taken from the headline full-mix number. A tail expressed as a fraction of a
 * mix that also contains a forest is a fact about how loud the forest is, and
 * it would move every time the wildlife was retuned. What is being asked is
 * narrower and does not drift: of everything arriving from that cabinet, how
 * much of it is reverb.
 */
async function tail() {
  const world = (v) =>
    page.evaluate((vol) => {
      window.RR.audio.setBusVolume('world', vol);
      window.RR.audio.setBusVolume('sfx', vol);
    }, v);

  /**
   * Silence the trip's own voice. Reversible, and every disconnect below has
   * exactly one matching reconnect — these are edges `trip-audio.js` made in
   * `build` and `begin`, and leaving one of them off would quietly delete the
   * drone for the rest of the run.
   */
  const hush = (on) =>
    page.evaluate((off) => {
      const n = window.RR.tripAudio.nodes;
      for (const v of n.voices) {
        if (off) v.osc.disconnect();
        else v.osc.connect(v.gain);
      }
      if (off) {
        n.breathSrc.disconnect();
        n.pulseOsc.disconnect();
      } else {
        n.breathSrc.connect(n.breathTone);
        n.pulseOsc.connect(n.pulseGain);
      }
    }, on);

  await world(0);
  await hush(true);
  await page.waitForTimeout(12000);
  const full = await measure(2500);
  await page.evaluate(() => {
    window.__record.el.muted = true;
  });
  await page.waitForTimeout(1000);
  const near = await measure(2000);
  await page.waitForTimeout(11000);
  const bed = await measure(2000);
  await page.evaluate(() => {
    window.__record.el.muted = false;
  });
  await hush(false);
  await world(1);
  await page.waitForTimeout(4000);

  // The bed should now be silence. It is measured anyway and reported, because
  // "the thing I removed is actually gone" is the assumption every number here
  // rests on, and an assumption that is never printed is one nobody checks.
  const minus = (a) => Math.sqrt(Math.max(0, a.rms * a.rms - bed.rms * bed.rms));
  const only = minus(near);
  const cabinet = minus(full);
  return { full, near, bed, only, cabinet, ratio: cabinet > 0 ? only / cabinet : 0 };
}

/**
 * Let the graph arrive, then STOP THE CLOCK.
 *
 * Two separate corrections, both of which this script got wrong first.
 *
 * TWELVE SECONDS RATHER THAN THREE, because every gain in `trip-audio.js` is a
 * `setTargetAtTime` and the slowest has a 2.6-second time constant. Three
 * seconds is barely one of those: the first runs measured the hall at 57% of
 * where it was going and the trip level still climbing. Nothing about that looks
 * wrong in the output — it is a perfectly steady number, just not the one the
 * code asks for.
 *
 * AND THEN `debug.speed = 0`, WHICH IS THE ONE THAT MATTERED MORE. A trip is a
 * timed narrative and a full measurement of one stage takes about fifty seconds
 * of it, so by the last window the run had walked out of the phase it seeked to
 * — on the egodeath stage it walked off the end of the trip entirely, the drone
 * faded out under the measurement, and the "bed" came back 13 dB quieter than
 * the same bed at peak. Every subtraction downstream of that is meaningless, and
 * it reads as a wildly unstable tail rather than as a moving target.
 *
 * `main.js` multiplies the director's dt by `debug.speed`, so zero freezes the
 * trip's clock while leaving `update` running at full rate: the audio gains are
 * still written every frame, from a state that no longer moves. That is exactly
 * what a measurement wants and it is why the control already exists.
 */
async function settle() {
  /**
   * Frozen FIRST, then waited on, and the order is not arbitrary. `seek` snaps
   * `director.eased` straight to the new phase's level rather than easing into
   * it, so the state is already correct the instant it returns — but the audio
   * parameters are `setTargetAtTime` ramps running on the AudioContext's clock,
   * which `debug.speed` does not touch and cannot stop. Freezing immediately
   * means the twelve seconds below are spent with the ramps converging on a
   * target that is standing still, instead of chasing one that is walking away.
   *
   * `state.breath` freezes too, at whatever point in its 8.7-second cycle it
   * happened to be. That is why `lowGain` is in the node readout: the low band
   * is deliberately breath-modulated, so its level legitimately varies between
   * runs by a couple of decibels and the gain that produced any given
   * measurement has to be visible next to it.
   */
  await page.evaluate(() => {
    window.RR.debug.speed = 0;
  });
  await page.waitForTimeout(12000);
}

const rows = [];
const nodes = {};
async function stage(label) {
  nodes[label] = await tripNodes();
  const wet = await measure(5000);
  const t = await tail();
  rows.push({
    label,
    ...wet,
    tailRms: t.only,
    cabinetRms: t.cabinet,
    bedRms: t.bed.rms,
    tailFlat: t.near.flatness,
    tailRatio: t.ratio,
    tailHarsh: t.near.harsh,
    // Where the echo actually sits. The whole point of the second attempt at
    // the hall was to move it off the mids and onto the top of the record, and
    // that is a claim about a centroid rather than about a level.
    tailCentroid: t.near.centroid,
    /**
     * THE ECHO, MEASURED IN THE BAND IT NOW LIVES IN.
     *
     * `tailRatio` compares the tail's total RMS against the record's, and RMS is
     * dominated by bass and low mids — so once the hall was rebuilt to send only
     * the top of the record, that number fell to 1% and stayed there no matter
     * how far the send was opened. It was not reporting an inaudible reverb, it
     * was reporting that a high-frequency tail is a small share of a full-range
     * signal's energy, which is true and useless.
     *
     * Both are kept, because they answer the two halves of the brief and they
     * are supposed to move in opposite directions: `tail%` low, because the
     * complaint was too much room echo, and `hiTail%` high, because the ask was
     * for that echo to be on the high notes.
     */
    hiTail: t.full.highE > 0 ? t.near.highE / t.full.highE : 0,
    // The cabinet with the trip's bed removed: the record's own balance, with
    // no drone in the low band to flatter it.
    cab: {
      sub: t.full.subE,
      low: t.full.lowE,
      mid: t.full.midE,
      high: t.full.highE,
      body: t.full.bodyE,
    },
  });
}

await stage('sober');

await page.evaluate(() => {
  // Speed back to 1 so `seek` runs against a live director; `settle` freezes it again.
  window.RR.debug.speed = 1;
  window.RR.director.seek(160);
});
await settle();
await stage('peak');

await page.evaluate(() => {
  // Speed back to 1 so `seek` runs against a live director; `settle` freezes it again.
  window.RR.debug.speed = 1;
  window.RR.director.seek(220);
});
await settle();
await stage('egodeath');

const pad = (s, n) => String(s).padEnd(n);

console.log('THE WHOLE MIX — what a player actually hears');
console.log(
  ' ',
  pad('stage', 11),
  pad('rms', 8),
  pad('peak', 7),
  pad('centroid', 10),
  pad('harsh', 7),
  pad('flat', 7),
  pad('limit dB', 9),
  pad('swing', 7),
  'clip'
);
for (const r of rows) {
  console.log(
    ' ',
    pad(r.label, 11),
    pad(r.rms.toFixed(4), 8),
    pad(r.peak.toFixed(3), 7),
    pad(`${r.centroid.toFixed(0)}Hz`, 10),
    pad(r.harsh.toFixed(3), 7),
    pad(r.flatness.toFixed(3), 7),
    pad(`${r.grMean.toFixed(1)}/${r.grWorst.toFixed(1)}`, 9),
    pad(r.grSwing.toFixed(2), 7),
    r.clipped
  );
}

/**
 * THE CABINET ALONE — the record and what the trip does to it, with the trip's
 * own drone, breath and pulse removed. Every column above is contaminated by
 * those; the drone in particular sits at 52-74 Hz, squarely on top of the band
 * the sub-octave lands in, so a full-mix low reading cannot tell a manufactured
 * octave from a drone note.
 */
console.log('\nTHE CABINET ALONE — the record, bed removed');
console.log(
  ' ',
  pad('stage', 11),
  pad('sub/mid', 8),
  pad('low/mid', 8),
  pad('body/mid', 9),
  pad('tail%', 7),
  pad('hiTail%', 8),
  pad('tailCent', 9),
  pad('bed', 8)
);
for (const r of rows) {
  console.log(
    ' ',
    pad(r.label, 11),
    pad((r.cab.sub / r.cab.mid).toFixed(3), 8),
    pad((r.cab.low / r.cab.mid).toFixed(3), 8),
    pad((r.cab.body / r.cab.mid).toFixed(3), 9),
    pad(`${(r.tailRatio * 100).toFixed(1)}%`, 7),
    pad(`${(r.hiTail * 100).toFixed(1)}%`, 8),
    pad(`${r.tailCentroid.toFixed(0)}Hz`, 9),
    pad(r.bedRms.toFixed(4), 8)
  );
}

console.log('\ntrip nodes:');
for (const [k, v] of Object.entries(nodes)) console.log(' ', pad(k, 11), JSON.stringify(v));
{
  const s = rows.find((r) => r.label === 'sober');
  const p = rows.find((r) => r.label === 'peak');
  const dB = (a, b) => (b > 0 ? (20 * Math.log10(a / b)).toFixed(1) : 'n/a');
  console.log(
    `\nthe record, sober -> peak:  sub ${dB(p.cab.sub, s.cab.sub)} dB   low ${dB(p.cab.low, s.cab.low)} dB   ` +
      `body ${dB(p.cab.body, s.cab.body)} dB   mid ${dB(p.cab.mid, s.cab.mid)} dB   high ${dB(p.cab.high, s.cab.high)} dB`
  );
}

const sober = rows.find((r) => r.label === 'sober');
const cabinetSum = Object.values(nodes)[0]?.cabinetSum ?? 1;
const fails = [];
for (const r of rows) {
  if (r.clipped > 0) fails.push(`${r.label}: ${r.clipped} clipped samples`);
  if (r.peak > 0.999) fails.push(`${r.label}: peak at full scale (${r.peak.toFixed(3)})`);
  /**
   * THE THRESHOLDS, AND WHY THEY ARE RATIOS AGAINST SOBER RATHER THAN ABSOLUTES.
   *
   * A record is whatever it is — the synthetic one here is denser than most —
   * so "flatness under 0.25" would be a fact about this generator. What is NOT
   * a fact about the generator is how much the trip is allowed to change it.
   * The trip may make the room bigger; it may not turn the record into noise.
   */
  if (r.flatness > sober.flatness * 1.7) {
    fails.push(
      `${r.label}: spectral flatness ${r.flatness.toFixed(3)} vs ${sober.flatness.toFixed(3)} sober ` +
        '— the record is turning into noise'
    );
  }
  // A tail louder than half the music is not a space, it is a second, blurred
  // copy of the record playing over the top of it.
  if (r.tailRatio > 0.5) {
    fails.push(`${r.label}: tail is ${(r.tailRatio * 100).toFixed(0)}% of the music's own level — too echoey`);
  }
  if (r.rms > 0.03 && r.harsh > 0.3) fails.push(`${r.label}: ${(r.harsh * 100).toFixed(0)}% of energy in 2–6 kHz`);
  /**
   * PUMPING, WHICH NEITHER PEAK NOR CLIP CAN SEE.
   *
   * A mix can be riding 8 dB of gain reduction on every kick, breathing
   * audibly, and still never come within a hair of full scale — the limiter is
   * doing its job, and its job is to hide exactly the symptom a peak reading
   * would show. -6 dB average is where the low end this build adds stops being
   * weight and starts being a compressor pedal, which is the "compressed"
   * quality `external-track.js` exists to have got rid of.
   */
  if (r.grMean < -6) {
    fails.push(`${r.label}: limiter averaging ${r.grMean.toFixed(1)} dB of reduction — the mix is squashed`);
  }
  /**
   * AND THE THRESHOLD THAT WOULD ACTUALLY HAVE CAUGHT IT.
   *
   * The mean above passed a build the player described as pumping, and the two
   * numbers are not measuring the same thing. A limiter held at a steady -4 dB
   * is a volume control and nobody can hear it; a limiter travelling 3 dB twice
   * a second is the kick drum ducking the whole record, which is audible at
   * about 1.5 dB of swing and unmistakable by 2.5. The reported build swung 2.9
   * dB at ego death with a mean of -1.6, so the mean was not merely a lenient
   * threshold — it was the wrong quantity, and no value of it would have failed.
   *
   * 2.0 dB, which is deliberately under where it becomes obvious. This is a
   * regression gate for a change whose whole purpose is to add weight without
   * spending it here, so it should fail before a listener would.
   */
  if (r.grSwing > 2) {
    /**
     * NAME THE RIGHT CAUSE, BECAUSE THERE ARE TWO AND THEY NEED DIFFERENT FIXES.
     *
     * The usual one is the low end, which is what this threshold was built for.
     * The other is the cabinet mix: `dryMix` and `wetMix` are the same recording
     * twice and sum by AMPLITUDE, so a pair adding to 2.0 puts the record into
     * the limiter about six decibels hotter before anything else has happened —
     * and then the limiter hands those six decibels back by turning down
     * everything the trip is adding, which is heard as the trip doing nothing
     * rather than as the record being loud.
     *
     * A swing that is already present when SOBER is the tell. Nothing the trip
     * does exists at that point, so a mix that pumps there is pumping on its own
     * account.
     */
    const cause =
      cabinetSum > 1.25
        ? `the cabinet mix sums to ${cabinetSum} (dryMix + wetMix) — the record is ` +
          'arriving hot and the limiter is giving it back'
        : 'the bass is pumping the whole mix';
    fails.push(`${r.label}: the limiter is swinging ${r.grSwing.toFixed(1)} dB — ${cause}`);
  }
}
if (problems.length) fails.push(...problems);

writeFileSync(`${OUT}/record-space.json`, JSON.stringify({ rows, fails }, null, 2));
if (fails.length) {
  console.log('\nPROBLEMS:');
  for (const f of fails) console.log(' ', f);
} else {
  console.log('\nno problems');
}

await browser.close();
