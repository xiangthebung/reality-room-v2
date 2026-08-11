/**
 * AN OCTAVE DIVIDER. It listens to the bass and plays a sine one octave under
 * it.
 *
 * This is the only piece of sample-rate DSP in the project and the only reason
 * it exists is that the effect cannot be built out of the node graph. A
 * WaveShaper is memoryless, so it can add harmonics ABOVE a signal — full-wave
 * rectification is an octave up — but nothing memoryless can produce an octave
 * DOWN, because the output has to depend on where the input has been, not just
 * on where it is. Something has to count periods, and counting periods means
 * looking at samples.
 *
 * WHY NOT A SHELF. A low shelf makes the bass that is already there louder, and
 * a record whose bass line sits at 90 Hz has nothing at 45 for a shelf to lift.
 * The bottom octave has to be MANUFACTURED, and this is what manufactures it.
 * The two are complementary and both are used: the shelf in `trip-audio.js`
 * adds weight to what exists, this adds an octave underneath it.
 *
 * ---- how it works -------------------------------------------------------
 *
 * Zero crossings with hysteresis, which is the classic analogue octave-divider
 * trick and is chosen here for what it CANNOT do. It has no feedback and no
 * filter state of its own: it counts samples between crossings, divides, and
 * runs an oscillator. It cannot self-oscillate, cannot accumulate and cannot
 * ring — the same standing objection this project applies to everything in
 * `trip-audio.js`.
 *
 * THE HYSTERESIS IS THE WHOLE DIFFERENCE between this and a noise generator. A
 * bare `x > 0` test fires several times per period on anything that is not a
 * pure sine, and a divider driven by a jittering trigger produces an octave that
 * leaps around. The trigger here has to travel below `-h` before an upward
 * crossing counts, where `h` tracks the signal's own envelope, so ripple an
 * order of magnitude smaller than the fundamental cannot re-trigger it.
 *
 * TRUST, and why the output is not simply always on. A zero-crossing divider is
 * a MONOPHONIC device. Given one bass note it is exact; given two at once, or a
 * kick drum landing across a bass note, the crossings stop being periodic and
 * the detected octave jumps. Rather than emit that, the processor keeps a
 * running confidence: consecutive periods that agree with each other to within
 * a semitone or so raise it, disagreements halve it, and silence lets it fall.
 * The output is multiplied by it. On a clean bass line the sub is fully present;
 * on a dense chord it fades out of the way rather than warbling, which is the
 * failure mode that makes cheap octave pedals unusable.
 *
 * THE BAND IS BOUNDED AT BOTH ENDS and both bounds are musical rather than
 * defensive. Below 55 Hz there is no point: an octave under a 50 Hz note is
 * 25 Hz, which is under the hearing threshold and under most speakers, so all
 * it would do is eat headroom and excursion. Above 200 Hz it is not the bass
 * any more, it is the low mids, and an octave under those is a different note
 * rather than a deeper version of the same one.
 *
 * Served from `public/` rather than bundled: an AudioWorklet module is fetched
 * by URL at runtime and must arrive as plain, untransformed JavaScript. Vite's
 * dev server rewrites anything it treats as an application module — adding an
 * HMR preamble that references APIs the worklet scope does not have — so a file
 * under `src/` works in a production build and fails in development, which is
 * the worst way round for a file nobody looks at twice.
 */

/** The range of fundamentals worth dividing. See the header. */
const MIN_F = 55;
const MAX_F = 200;

class SubBassProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** Rectified envelope of the input, used for the trigger and the output. */
    this._env = 0;
    /** true once the signal has been below `-h` — see the header on hysteresis. */
    this._below = false;
    /** Samples since the last accepted crossing. */
    this._since = 0;
    /** The sub's frequency, in Hz. Zero until the first note is identified. */
    this._freq = 0;
    /** Oscillator phase, radians. */
    this._phase = 0;
    /** 0..1, how much the last few periods agreed with each other. */
    this._trust = 0;
    /** The smoothed output gate, so trust changes do not click. */
    this._open = 0;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const o = out[0];
    const inp = inputs[0];

    if (!inp || !inp.length) {
      o.fill(0);
      // Let everything decay rather than freezing it: an input that comes and
      // goes (the graph is rebuilt, the track is swapped) should not resume with
      // a stale note at full confidence.
      this._trust *= 0.5;
      this._open *= 0.5;
      return true;
    }

    const chans = inp.length;
    const n = o.length;
    const sr = sampleRate;
    const TAU = Math.PI * 2;
    /** Longest gap that can still be one period of the slowest note we accept. */
    const maxGap = sr / MIN_F;

    for (let i = 0; i < n; i++) {
      let x = 0;
      for (let c = 0; c < chans; c++) x += inp[c][i];
      x /= chans;

      // Envelope: ~10 ms up, ~100 ms down. Fast enough to follow a bass note's
      // attack, slow enough that it does not follow the waveform itself.
      const a = x < 0 ? -x : x;
      this._env += (a - this._env) * (a > this._env ? 0.002 : 0.0002);

      const h = this._env * 0.35 + 0.001;
      if (this._since < 1e7) this._since++;

      if (!this._below) {
        if (x < -h) this._below = true;
      } else if (x > h) {
        this._below = false;
        const f = sr / this._since;
        this._since = 0;
        if (f >= MIN_F && f <= MAX_F) {
          const target = f * 0.5;
          const ratio = this._freq > 0 ? target / this._freq : 0;
          if (ratio > 0.94 && ratio < 1.06) {
            // This period agrees with the last. Three of these in a row is full
            // confidence, which at bass frequencies is about 50 ms.
            this._freq += (target - this._freq) * 0.4;
            this._trust = Math.min(1, this._trust + 0.34);
          } else {
            // A new note, or two notes at once. Follow it, but stop asserting
            // it until it has been confirmed.
            this._freq = this._freq > 0 ? this._freq + (target - this._freq) * 0.5 : target;
            this._trust *= 0.5;
          }
        } else {
          // Out of band: below 55 Hz there is nothing useful to divide, above
          // 200 Hz this is not the bass. Either way, say nothing.
          this._trust *= 0.6;
        }
      }

      // Nothing has crossed for longer than the slowest note we accept, so
      // whatever was playing has stopped. ~40 ms to fall away.
      if (this._since > maxGap) this._trust *= 0.9995;

      // The level gate. Below this the "bass" is a room tone and dividing it
      // produces a sub-audio drone under a silent passage.
      const gate = this._env > 0.004 ? this._trust : 0;
      this._open += (gate - this._open) * 0.0006;

      this._phase += (TAU * this._freq) / sr;
      if (this._phase > TAU) this._phase -= TAU;

      /**
       * 1.55 restores the peak the envelope lost.
       *
       * `_env` follows the RECTIFIED signal, and the mean of |sin| is 2/pi of
       * its peak — so an envelope taken this way sits about 4 dB below the thing
       * it is describing, and a sub built straight from it arrives quietly for
       * reasons that look like a gain-staging mistake somewhere else entirely.
       */
      o[i] = Math.sin(this._phase) * this._env * 1.55 * this._open;
    }

    return true;
  }
}

registerProcessor('sub-bass', SubBassProcessor);
