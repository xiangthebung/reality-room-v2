import { clamp01 } from '../core/util.js';
import { darkAt, dawnAt, dayPhase } from '../world/daylight.js';

/**
 * THE FAR CHORUS. The one layer in this project that is not synthesised.
 *
 * Everything else under `src/audio/` is built from oscillators and filtered
 * noise, and that was the right decision for every one of them: a bird is a
 * contour, a frog is a jittered pulse train, a creak is a staircase envelope.
 * There is exactly one thing in a real forest recording that cannot be built
 * that way, and it is the thing a player means when they say another game's
 * audio "sounds better".
 *
 * WHAT IT IS. A field recording of a rainforest carries several hundred
 * simultaneous distant events — birds too far off to resolve, insects at every
 * bearing, leaves, water, air moving through a canopy — all captured by ONE
 * stereo pair, in ONE room, at ONE moment. Every source in it is therefore
 * mutually correlated through the same air and the same two microphones. That
 * correlation is what the ear reads as "outdoors, and large". It is not a sum of
 * sounds; it is a sum of sounds that have all been through the same place.
 *
 * You cannot synthesise it. `wildlife.js` can put twenty species in the wood and
 * `ambience.js` can put an insect wall behind them, but each of those arrives
 * through its own panner and its own reverb send, which means each of them is
 * its own independent event. Fifty independent events do not become a chorus,
 * they become fifty events. The unresolvable middle distance — the part that is
 * not any particular animal — is the part that has to be recorded.
 *
 * SO THIS FILE STREAMS A RECORDING AND EVERYTHING ELSE STAYS. The bed is the
 * floor; the synthesised layers are what happens on top of it, and they are
 * ducked rather than deleted (see `setBedPresence` in ambience.js) because the
 * wind is coupled to the gust clock the trees visually bend to and removing it
 * would stop the forest being one system.
 *
 *
 * ==== TRAP ONE: STREAM, DO NOT DECODE ======================================
 *
 * The obvious implementation is `fetch` + `decodeAudioData` + a looping
 * `AudioBufferSourceNode`. It is what every other buffer in this project does
 * and it is wrong here by two orders of magnitude.
 *
 * `decodeAudioData` returns an `AudioBuffer`, which is Float32 PCM AT THE
 * AUDIOCONTEXT'S SAMPLE RATE. The cost is:
 *
 *     bytes = seconds x channels x 4 x ctx.sampleRate
 *
 * One stereo minute at a 48 kHz context is 60 x 2 x 4 x 48000 = 23 040 000
 * bytes, i.e. 21.97 MiB, resident for the whole session. Three beds of a minute
 * each is 65.9 MiB of RAM to play back what might be a 500 KB download.
 *
 * THE NON-OBVIOUS PART, AND THE REASON THIS BLOCK IS THIS LONG: DOWNSAMPLING
 * THE SOURCE FILE DOES NOT HELP. `decodeAudioData` resamples to the context
 * rate on the way in. A 24 kHz mono source decoded into a 48 kHz context costs
 * exactly the same 4 bytes per channel per context-sample as a 48 kHz stereo one
 * does per channel — you save on channels and on download, and nothing at all on
 * the resample. The only lever that moves the figure is the CONTEXT rate, which
 * is shared by every other node in `engine.js`; lowering it to save bed memory
 * would degrade the birds, the record and the reverb tails to pay for a bed.
 *
 * `MediaElementAudioSourceNode` decodes in the media pipeline, a packet at a
 * time, into a buffer measured in tens of milliseconds. RAM cost is effectively
 * zero and constant in the file length. Verified by `scripts/audio-bed-check.mjs`,
 * which patches `decodeAudioData` before the page loads and asserts this file
 * never calls it.
 *
 *
 * ==== TRAP TWO: CROSSFADE THE LOOP, DO NOT BUTT-SPLICE ======================
 *
 * Setting `el.loop = true` fails twice over.
 *
 *   THE ENCODER GAP. Both survivors of the codec war put samples that are not in
 *   the source at the front of the file. AAC has an encoder delay of 1024 or
 *   2112 samples depending on the encoder, MP3 has 576 plus its own, and both
 *   pad the tail out to a whole frame. Browsers honour the gapless metadata in
 *   an m4a inconsistently and honour nothing at all in a raw stream. A
 *   butt-spliced loop therefore ticks, and the tick is at exactly the loop
 *   period, which is the most identifiable rhythm a bed can have.
 *
 *   THE SEAM YOU CAN HEAR ANYWAY. Even with a sample-exact loop, the moment
 *   where the tail's noise field is replaced by the head's is a step change in
 *   the correlation between the two channels, and the ear finds it within two or
 *   three repetitions. This is what "I can hear the loop" means when the file has
 *   no click in it.
 *
 * TWO ELEMENTS, ONE FILE, PLAYED AT AN OFFSET. Deck A runs to `crossfade`
 * seconds before the loop end; deck B starts from the loop start and the two are
 * faded across each other over that window; A pauses and the decks swap. The
 * encoder's leading padding lands inside the fade, where it is masked by A still
 * playing, and the correlation step is smeared over two seconds instead of one
 * sample. The audible loop period becomes `duration - crossfade`.
 *
 *
 * ==== TRAP THREE: EQUAL POWER IS +3 dB ON CORRELATED MATERIAL ===============
 *
 * `engine.js`'s `setRoom` uses `cos`/`sin` and explains why: two decorrelated
 * reverb tails sum incoherently, so `cos^2 + sin^2 = 1` holds and a LINEAR fade
 * would dip 3 dB in the middle. That argument is about POWER and it needs the
 * two signals to be uncorrelated.
 *
 * A loop crossfade is the same recording twice. Whether the two windows are
 * correlated is a property of the RECORDING, and it varies:
 *
 *   A dense stationary field — insects, rain, a waterfall — is uncorrelated with
 *   itself at any offset. Equal power is exactly right and the sum is flat.
 *
 *   Anything with a period near the offset is correlated with itself. A generator
 *   hum, a cyclical machine, a bird with a metronomic call, or — most likely here
 *   — a recording short enough that the same insect chorus swell lands in both
 *   windows. Correlated signals sum by AMPLITUDE, so `cos + sin` peaks at sqrt(2)
 *   at the midpoint: +3.01 dB, once per loop, forever.
 *
 * There is no runtime test that distinguishes them cheaply and no curve that is
 * right for both. So the curve is equal power — correct for the material we are
 * actually shopping for — and the manifest carries a per-bed `seamTrimDb`, a
 * raised-cosine dip applied to the SUM of the two decks across the fade window.
 * Zero by default, so a bed that behaves needs no entry. `audio-bed-check.mjs`
 * measures the seam against the steady state and prints the number to put here;
 * do not guess it.
 *
 * `npm run audio` cannot see any of this. It measures 6-second windows at
 * arbitrary moments and a seam is two seconds once a minute, so a +3 dB bump
 * lands inside one window in twenty and moves its RMS by a few per cent. This is
 * the same blindness `record-space.mjs` was written for and it is why the check
 * script exists rather than a threshold being added over there.
 *
 *
 * ==== WHICH BUS, AND WHY IT IS NOT SPATIAL =================================
 *
 * `worldBus`, non-spatial, straight in. Not `createSpatial`, not a panner, no
 * position.
 *
 * The bed is not an object in the world, it IS the world — the sound of being
 * where you are, which by definition has no bearing and no distance. Putting it
 * through an HRTF panner would give it both, and would also collapse a real
 * stereo pair into a mono point and then re-image it, which is the exact fault
 * `external-track.js` spent a rewrite removing from pasted records. Its two
 * channels reach the two outputs unmodified.
 *
 * `worldBus` rather than `preMaster` because it is world: the World slider must
 * hold it, the cave occlusion must muffle it (a forest heard through ten metres
 * of hillside includes the far chorus), and the trip's `recede` insert must pull
 * it back with everything else. All three of those come free from the bus.
 *
 *
 * ==== THE CLOCK IS NOT A NEW CLOCK =========================================
 *
 * Slot weights come from `darkAt` and `dawnAt` in `world/daylight.js` — the same
 * two functions `wildlife.js` reads for its dark windows and `atmosphere.js`
 * reads for the sky. A second opinion about what time it is would drift against
 * the picture, which that module's header names as the failure it exists to
 * prevent. The trip term is `max(the hour, tripLevel * 0.65)`, copied from
 * `ambience.js` and `fauna.js` verbatim for the same reason: every layer that
 * responds to darkness must respond to the trip's darkness identically.
 */

/**
 * Below this weight a bed's media elements are paused outright.
 *
 * Not an optimisation of the audio graph — a gain of 0.001 costs nothing to mix.
 * It is about the MEDIA pipeline: a playing `<audio>` element runs a decoder and
 * holds a network connection whether or not anybody is listening, and a night
 * bed at noon is ten minutes of that for silence. The hysteresis band is wide
 * (10:1) because the alternative is a decoder being torn down and rebuilt every
 * time a weight jitters across one number, and a media element resuming is the
 * one operation here that can audibly stutter.
 */
const RUN_ON = 0.02;
const RUN_OFF = 0.002;

/**
 * How many points the crossfade curves are drawn with.
 *
 * `setValueCurveAtTime` interpolates linearly between them, so this is the
 * resolution of a cosine over two seconds. 128 puts the largest deviation from a
 * true cosine at about 0.0002 — some 74 dB down, i.e. inaudible — for half a
 * kilobyte of Float32 held for the life of the page. A curve rather than a pair
 * of `linearRampToValueAtTime` calls because a linear ramp IS the equal-amplitude
 * fade this file's header spends a paragraph rejecting.
 */
const CURVE_POINTS = 128;

/**
 * How long before a crossfade the incoming deck is seeked into position.
 *
 * 0.75 s. The measured cost of not doing this at all is about 0.9 dB of missing
 * energy at every seam — see `_armed`, which has the numbers. It wants to be
 * comfortably longer than a seek-and-prime on a compressed stream (tens of
 * milliseconds on a warm cache, more on a cold one) and comfortably shorter than
 * the crossfade itself, so that a bed whose loop is short still has a steady
 * stretch between the arm and the fade.
 */
const ARM_LEAD = 0.75;

/** The default manifest location, relative to the app's base URL. */
const MANIFEST = 'audio/beds/manifest.json';

/**
 * The three slots, and the weight each one has at a given phase.
 *
 * Deliberately NOT normalised here — `_weights` does that over whichever slots
 * the manifest actually supplied, so a one-bed manifest plays that bed at full
 * weight all day rather than at a third of it. That is what makes beds
 * addable and removable without touching this file.
 *
 * `day` is what is left over rather than a curve of its own, so the three always
 * account for the whole clock and there is no hour with a hole in it. It is
 * clamped at zero because `dark` and `dawn` overlap through the hour after
 * sunrise — see DAWN_KEYS in daylight.js, which deliberately runs the dawn
 * chorus on into the light.
 */
function slotWeights(phase, tripLevel) {
  const dark = Math.max(darkAt(phase), clamp01(tripLevel) * 0.65);
  const dawn = dawnAt(phase);
  return {
    night: dark,
    dawn,
    day: Math.max(0, 1 - dark - dawn),
  };
}

/**
 * Which encoding this browser will actually play.
 *
 * ASKED, NOT ASSUMED, exactly as `canPlayOpus` in external-track.js is asked —
 * and this one has to be, because the answer has been moving. Opus in webm has
 * worked in Chrome, Firefox and Edge for a decade; Safari shipped partial
 * support late and only reached full Opus in iOS 18.4, so a meaningful share of
 * installed iOS and older macOS can decode the m4a and not the webm. The
 * manifest therefore lists sources in preference order and this walks them.
 *
 * `canPlayType` returns '', 'maybe' or 'probably'. Anything that is not '' is
 * accepted: a browser that says 'maybe' about a codec it names explicitly is
 * being honest about the container, not about the codec, and refusing 'maybe'
 * rejects working configurations.
 */
function pickSource(sources) {
  if (!Array.isArray(sources)) return null;
  const probe = document.createElement('audio');
  for (const s of sources) {
    if (!s?.src) continue;
    if (!s.type || probe.canPlayType(s.type) !== '') return s;
  }
  return null;
}

/**
 * ONE BED: two media elements playing one file at an offset, and the machinery
 * that hands over between them.
 *
 * `a` and `b` are interchangeable. `_cur` is whichever is currently carrying the
 * bed and `_nxt` is the one waiting; they swap at the end of every crossfade, so
 * there is no "primary" element and no state that accumulates across loops.
 */
class Deck {
  /**
   * @param {AudioContext} ctx
   * @param {string} url resolved, already codec-selected
   * @param {object} spec the manifest entry
   */
  constructor(ctx, url, spec) {
    this.ctx = ctx;
    this.spec = spec;
    this.slot = spec.slot;
    this.crossfade = Math.max(0.25, Number(spec.crossfade) || 2);
    /** Where in the file the loop lives. `end` null means "to the end". */
    this.loopStart = Math.max(0, Number(spec.loopStart) || 0);
    this.loopEnd = Number.isFinite(spec.loopEnd) ? Number(spec.loopEnd) : null;

    this.out = ctx.createGain();
    this.out.gain.value = 0;

    /**
     * The seam trim sits on the SUM of the two decks, not on either of them.
     *
     * It has to: what it is correcting is the two decks adding up to more than
     * they should, which is a property of the pair and not of either one. See
     * TRAP THREE in the header. At the default 0 dB this node is a unity gain
     * that is never written to, which is what keeps a well-behaved bed
     * bit-identical to having no trim mechanism at all.
     */
    this.sum = ctx.createGain();
    this.sum.gain.value = 1;
    this.seamTrimDb = Number(spec.seamTrimDb) || 0;
    this.sum.connect(this.out);

    const make = () => {
      const el = new Audio();
      /**
       * `preload = 'auto'` on BOTH, and `crossOrigin` on both.
       *
       * The second element requests a URL the first has already fetched, so in
       * practice it is served from the HTTP cache and costs nothing — but that
       * depends on the response being cacheable, which is a hosting decision
       * this file cannot make. If the beds are ever served with `no-store` the
       * download doubles silently; that is the thing to check if the network
       * panel ever shows two of everything.
       *
       * `crossOrigin` is set even though the beds are same-origin. A media
       * element without it that turns out to be cross-origin does not fail — it
       * taints the node and `createMediaElementSource` outputs SILENCE, with no
       * error anywhere. Setting it up front means a CDN move is a CORS header
       * away rather than a silent dead layer away.
       */
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      el.loop = false;
      el.src = url;
      const src = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain).connect(this.sum);
      return { el, src, gain };
    };
    this.a = make();
    this.b = make();
    this._cur = this.a;
    this._nxt = this.b;
    /** True from the moment a crossfade is scheduled until it has been retired. */
    this._fading = false;
    this._fadeEnds = 0;
    this._running = false;
    this._started = false;
    /**
     * ==== THE SEEK IS DONE EARLY AND SEPARATELY FROM THE PLAY ================
     *
     * `_armed` is true once the incoming deck has been positioned at the loop
     * start and is sitting there paused, waiting.
     *
     * THE FIRST VERSION DID BOTH AT THE FADE'S FIRST INSTANT — `currentTime = 0`
     * and `play()` on the same line as the gain curves — and it cost about a
     * decibel, every loop, measurably. `audio-bed-check.mjs` reported the fade
     * window running 0.85 to 0.97 dB under what the equal-power identity says it
     * should, on three consecutive seams, with a spread of a tenth of a decibel:
     * far too consistent to be material and far too small to hear, which is
     * exactly the kind of thing that survives forever.
     *
     * The cause is that a seek on a compressed stream is not free. The decoder
     * has to find the page, reset, and prime, which is tens of milliseconds — and
     * `play()` cannot deliver samples until it has. Meanwhile the incoming gain
     * curve, scheduled on the AudioContext clock, has already started rising. So
     * the first slice of the fade multiplies a rising gain by NOTHING, and the
     * energy that slice was supposed to contribute is simply absent. It also made
     * the offset between the two decks vary from loop to loop by tens of
     * milliseconds, which is visible in the check script's `--periodic` run as a
     * seam that lands anywhere between -1.3 and +0.6 dB.
     *
     * So the seek happens `ARM_LEAD` seconds before the fade, while the outgoing
     * deck is still carrying the bed on its own and nothing is listening to the
     * incoming one. By the time the curves are scheduled the decoder is primed
     * and `play()` is the cheap half of the operation.
     *
     * THE ELEMENT IS NOT LEFT ROLLING DURING THE ARM, which was the other obvious
     * design and is worse: it would put the incoming deck `ARM_LEAD` seconds into
     * its own content by the time the fade began, silently deleting the first
     * three quarters of a second of the loop and making the audible loop period
     * `duration - crossfade - ARM_LEAD` rather than the documented one.
     */
    this._armed = false;
    /** How many crossfades this deck has performed. For the check script. */
    this.seams = 0;

    // Equal power, drawn once. See CURVE_POINTS.
    this._down = new Float32Array(CURVE_POINTS);
    this._up = new Float32Array(CURVE_POINTS);
    this._dip = new Float32Array(CURVE_POINTS);
    const trim = Math.pow(10, -Math.abs(this.seamTrimDb) / 20);
    for (let i = 0; i < CURVE_POINTS; i++) {
      const t = i / (CURVE_POINTS - 1);
      const angle = t * Math.PI * 0.5;
      this._down[i] = Math.cos(angle);
      this._up[i] = Math.sin(angle);
      // A raised cosine: 1 at both ends, `trim` at the midpoint. Nothing else
      // in this project dips a gain, so it is spelled out rather than shared.
      this._dip[i] = 1 - (1 - trim) * Math.sin(Math.PI * t);
    }
  }

  /** Where the loop ends, in file seconds. NaN until metadata has arrived. */
  _end() {
    const d = this._cur.el.duration;
    if (this.loopEnd !== null) return Math.min(this.loopEnd, Number.isFinite(d) ? d : this.loopEnd);
    return d;
  }

  /**
   * Start or stop the decoders. See RUN_ON.
   *
   * Resuming does NOT rewind: media elements keep `currentTime` across a pause,
   * so a night bed that went quiet at dawn picks up where it left off twelve
   * hours later. That is deliberate — restarting from zero would mean every bed
   * begins at the same point in the file every time it becomes audible, which
   * over a session is a far more recognisable pattern than the loop itself.
   */
  _setRunning(on) {
    if (on === this._running) return;
    this._running = on;
    if (on) {
      if (!this._started) {
        this._started = true;
        this._cur.el.currentTime = this.loopStart;
        this._cur.gain.gain.value = 1;
      }
      // `play()` rejects if the browser refuses autoplay. There is nothing
      // useful to do about it and an unhandled rejection would show up in
      // audio-probe's console watcher as a failure of the whole app.
      this._cur.el.play().catch(() => {});
      if (this._fading) this._nxt.el.play().catch(() => {});
    } else {
      this._cur.el.pause();
      this._nxt.el.pause();
    }
  }

  /**
   * @param {number} weight 0..1, how much of this bed the hour wants
   * @param {number} gain   the bed's own manifest level, times the global one
   */
  tick(weight, gain) {
    const now = this.ctx.currentTime;
    this._setRunning(weight > (this._running ? RUN_OFF : RUN_ON));
    /**
     * Six seconds, which is the same constant `ambience.js` uses for the insect
     * wall and for the same reason: this is a bed that is on all the time, and a
     * bed that is on all the time must never be caught changing. The slot
     * weights move over a twenty-minute day, so the ramp is never the thing
     * limiting how fast the bed can respond; it is only there so that a trip
     * pulling `night` up cannot be heard as a fader.
     */
    /**
     * Kept, because `out.gain.value` is almost always mid-ramp on a six-second
     * time constant and therefore answers "where is it now", not "where is it
     * going". `report()` prints both, and `audio-bed-level.mjs` snaps to this
     * to sweep gains without waiting out thirty seconds of exponential per row.
     */
    this.target = weight * gain;
    this.out.gain.setTargetAtTime(this.target, now, 6);
    if (!this._running) return;

    if (this._fading) {
      if (now >= this._fadeEnds) {
        this._fading = false;
        this._cur.el.pause();
        /**
         * SCHEDULED AT THE CURVE'S END, NOT AT `now`, AND THAT IS NOT PEDANTRY.
         *
         * `gain.value = 0` is defined as `setValueAtTime(0, currentTime)`, and an
         * explicit event landing INSIDE a running `setValueCurveAtTime` window is
         * an error — Chrome throws `setValueAtTime(0, 70.592) overlaps
         * setValueCurveAtTime(..., 68.661, 1.939)`. It happened in practice
         * because this branch fires on the first frame at or after `_fadeEnds`
         * and the AudioContext clock advances between the `currentTime` read at
         * the top of `tick` and the assignment here, so `now` could sit a
         * millisecond short of the curve's own end.
         *
         * The exception propagated out of the frame loop as an unhandled
         * pageerror, which `audio-probe.mjs` fails the whole build on. Writing
         * the zero AT `_fadeEnds` — which is exactly where the curve stops — is
         * both legal and more correct: it is the moment the fade is over.
         */
        try {
          this._cur.gain.gain.setValueAtTime(0, Math.max(now, this._fadeEnds));
        } catch {
          /* a curve is still live; it ends at 0 anyway and the element is paused */
        }
        const done = this._cur;
        this._cur = this._nxt;
        this._nxt = done;
      }
      return;
    }

    const end = this._end();
    if (!Number.isFinite(end) || end <= this.loopStart + this.crossfade + ARM_LEAD) return;
    const at = this._cur.el.currentTime;
    /**
     * Arm first, fade second, and they are separate frames by design — see
     * `_armed`. The seek is idempotent but not free, so it is latched.
     */
    if (!this._armed && at >= end - this.crossfade - ARM_LEAD) {
      this._armed = true;
      this._nxt.gain.gain.cancelScheduledValues(now);
      this._nxt.gain.gain.value = 0;
      this._nxt.el.pause();
      try {
        this._nxt.el.currentTime = this.loopStart;
      } catch {
        // A seek before the element has metadata throws. It will be armed again
        // on the next frame, and the fade below simply does not start until it is.
        this._armed = false;
      }
      return;
    }
    if (!this._armed) return;
    /**
     * RE-ASSERT THE SEEK WHILE ARMED, because it does not always take.
     *
     * The element being armed is usually one that has just run to its natural
     * end, and a seek on an ended media element is not reliably synchronous —
     * observed in practice as the incoming deck arriving at the END of the file
     * instead of the start, which produced a crossfade into two seconds of
     * nothing and then, on the very next frame, a second "fade" 0.03 s long
     * because the new outgoing deck was already at its end. That degenerate fade
     * is where the AudioParam overlap above came from.
     *
     * Cheap to check and idempotent: a seek to where the element already is
     * costs nothing. The tolerance is a tenth of a second because `currentTime`
     * is quantised and because the element is paused, so it should not be moving
     * at all.
     */
    if (Math.abs(this._nxt.el.currentTime - this.loopStart) > 0.1) {
      try {
        this._nxt.el.pause();
        this._nxt.el.currentTime = this.loopStart;
      } catch {
        /* try again next frame */
      }
    }
    if (at < end - this.crossfade) return;
    this._begin(now, end - at);
  }

  /**
   * Hand over from `_cur` to `_nxt`.
   *
   * `remaining` is how much of the outgoing deck is actually left, which is at
   * most `crossfade` and is usually a frame less. Fading over the remaining time
   * rather than over the nominal window is what stops the outgoing element
   * hitting its own end mid-fade and going silent in one sample — the exact
   * click this whole mechanism exists to remove.
   *
   * THE TWO CLOCKS ARE DIFFERENT AND THAT IS FINE. `currentTime` on a media
   * element and `currentTime` on an AudioContext are independent, and the fade
   * is scheduled on the audio clock from a decision made on the media clock.
   * They drift by parts per million; over a two-second window that is
   * microseconds, i.e. far less than the frame quantisation already in the
   * trigger above.
   */
  _begin(now, remaining) {
    /**
     * A FLOOR OF 0.2 s ON THE FADE, which is a guard against arriving late.
     *
     * `remaining` is normally within a frame of `crossfade`. It is much smaller
     * only when the trigger was missed — a long GC pause, a backgrounded tab
     * whose rAF stopped, or the seek race described in `tick`. Fading over the
     * eight milliseconds that are genuinely left is a click, and a click on a
     * continuous bed is the single most audible thing this file could produce.
     * Two hundred milliseconds costs the tail of the outgoing deck (it runs out
     * mid-fade and the last of it is missing) and that is much the lesser evil:
     * a soft two-tenths dip instead of a step.
     */
    const span = Math.min(this.crossfade, Math.max(0.2, remaining));
    this._fading = true;
    this._armed = false;
    this._fadeEnds = now + span;
    // Already seeked and primed — see `_armed`. This is the cheap half.
    this._nxt.el.play().catch(() => {});
    const cur = this._cur.gain.gain;
    const nxt = this._nxt.gain.gain;
    // `setValueCurveAtTime` throws if it overlaps live automation, and these
    // params carry the previous loop's curves.
    cur.cancelScheduledValues(now);
    nxt.cancelScheduledValues(now);
    cur.setValueCurveAtTime(this._down, now, span);
    nxt.setValueCurveAtTime(this._up, now, span);
    if (this.seamTrimDb) {
      this.sum.gain.cancelScheduledValues(now);
      this.sum.gain.setValueCurveAtTime(this._dip, now, span);
    }
    this.seams++;
  }

  dispose() {
    for (const d of [this.a, this.b]) {
      try {
        d.el.pause();
        d.el.removeAttribute('src');
        d.el.load();
        d.src.disconnect();
        d.gain.disconnect();
      } catch {
        /* already gone */
      }
    }
    try {
      this.sum.disconnect();
      this.out.disconnect();
    } catch {
      /* already gone */
    }
  }
}

export class AmbienceBed {
  /**
   * Fetch the manifest and build whatever it describes. Never throws.
   *
   * RETURNS NULL WHEN THERE IS NO BED, AND THAT IS THE NORMAL CASE TODAY. No
   * third-party recording has been licensed yet, so a stock checkout has no
   * `public/audio/beds/` in it, the fetch 404s, and every measuring script in
   * this repo goes on measuring exactly the forest it measured yesterday. That
   * is the whole reason this returns a value instead of installing itself: a bed
   * that half-exists — decks built, nothing playing, wind already ducked for it —
   * would be a quieter forest with nothing in the gap.
   *
   * `fetch` is used rather than an `<audio>` element pointed at the manifest for
   * the same reason: a 404 on `fetch` is an ordinary response with `ok === false`
   * and writes nothing to the console, while a 404 on a media element logs
   * `Failed to load resource` — and `audio-probe.mjs` fails the build on any
   * console error.
   */
  static async load(ctx, engine, options = {}) {
    const base = options.base ?? (import.meta.env?.BASE_URL ?? '/');
    const url = options.manifest ?? `${base}${MANIFEST}`;
    let manifest = null;
    try {
      const res = await fetch(url, { cache: 'default' });
      if (!res.ok) return null;
      manifest = await res.json();
    } catch {
      return null;
    }
    if (!manifest || !Array.isArray(manifest.beds) || !manifest.beds.length) return null;
    const bed = new AmbienceBed(ctx, engine, manifest, base);
    return bed.decks.length ? bed : null;
  }

  constructor(ctx, engine, manifest, base) {
    this.ctx = ctx;
    this.engine = engine;
    this.manifest = manifest;
    /**
     * The whole layer's level, in one place, so a manifest can be made quieter
     * without touching a per-bed number.
     *
     * 0.3 IS A PLACEHOLDER-ERA DEFAULT AND MUST BE RE-DERIVED FOR A REAL
     * RECORDING. Field recordings arrive at wildly different levels — some
     * normalised to -1 dBFS, some peaking at -20 — so no constant here can be
     * right for a file nobody has chosen yet. What the number IS chosen against
     * is headroom, measured:
     *
     *   `check:fauna-audio`'s `all + music + peak` row is the loudest thing this
     *   project measures — every animal, the record, and the trip at its peak —
     *   and it is capped at 0.2 rms. Without a bed it reads 0.1313. With the
     *   synthesised placeholder at gain 0.5 it read 0.1796, i.e. the bed alone
     *   contributed 0.123 rms and ate four fifths of the margin. That row has a
     *   documented 3.2 dB run-to-run swing on identical code, so a default that
     *   close to the ceiling is a gate that fails at random on somebody else's
     *   branch.
     *
     * At 0.3 the same row reads 0.1531 (measured), which keeps roughly the same
     * proportional margin the tree had before this layer existed. The bed is
     * still a first-class layer rather than a whisper: it is comparable in level
     * to the whole of the rest of `ambience.js`, which is the point of it.
     */
    this.gain = Number.isFinite(manifest.gain) ? manifest.gain : 0.3;

    /**
     * Straight onto `worldBus`. No panner, no spatial source. See the header.
     */
    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(engine.worldBus);

    this.decks = [];
    for (const spec of manifest.beds) {
      const pick = pickSource(spec.sources);
      if (!pick) continue;
      const src = /^(https?:)?\/\//.test(pick.src) ? pick.src : `${base}audio/beds/${pick.src}`;
      const deck = new Deck(ctx, src, {
        ...spec,
        crossfade: spec.crossfade ?? manifest.crossfade ?? 2,
        seamTrimDb: spec.seamTrimDb ?? manifest.seamTrimDb ?? 0,
      });
      deck.out.connect(this.output);
      this.decks.push(deck);
      /** The codec that was actually chosen, so a check script can print it. */
      deck.chosen = pick;
    }

    /**
     * The slots this manifest actually covers. Weights are normalised over these
     * and not over all three, so a manifest with only a day bed plays it at full
     * weight at midnight rather than fading to nothing into silence.
     */
    this.slots = new Set(this.decks.map((d) => d.slot));

    /**
     * How much bed is audible, 0..1, for `ambience.setBedPresence`.
     *
     * It is the SUM of the slot weights after normalisation rather than a
     * separate curve, so it is 1 whenever any bed is at full and it falls only
     * when the layer genuinely is not there — which today means "the manifest
     * did not cover this hour". A bed at half weight ducks the wind half as far.
     *
     * IT IS DELIBERATELY INDEPENDENT OF `gain`, AND THAT IS A TRAP FOR WHOEVER
     * RETUNES THIS. Presence is slot COVERAGE, not level, so halving the layer
     * gain does not halve the duck: the wind and the insect wall stay pushed
     * down by exactly as much while the bed that displaced them gets quieter,
     * and the wood ends up thinner overall. Measured on the placeholder — the
     * insect wall reads 0.0077, 0.0074, 0.0070, 0.0074, 0.0077 at gains 0, 0.2,
     * 0.3, 0.45 and 0.6, i.e. flat to within the noise.
     *
     * It is left this way because the alternative needs a constant nobody can
     * defend — "the gain at which a bed is fully present" — and because `gain`
     * and `duck` are both manifest data written by the same hand at the same
     * time. THE RULE IS: if you change `gain` substantially, move the `duck`
     * values with it. A quiet bed should duck less.
     */
    this.presence = 0;
    this._duck = { wind: 1, insects: 1 };
  }

  /**
   * Equal-power normalisation across whichever slots exist.
   *
   * SQUARES, NOT A SUM, and this is the same argument as `setRoom` in engine.js
   * with a different subject. The day, dawn and night beds are three DIFFERENT
   * recordings — different microphones, different mornings — so they are
   * mutually uncorrelated and their powers add. Normalising by the sum of
   * amplitudes would dip 3 dB through every dawn; normalising by the root of the
   * sum of squares holds the total power flat across the transition.
   *
   * Note that this is the opposite trap to the one in the header. The LOOP
   * crossfade is one recording against itself and may be correlated; the SLOT
   * crossfade is two recordings against each other and cannot be.
   */
  _weights(phase, tripLevel) {
    const raw = slotWeights(phase, tripLevel);
    let power = 0;
    for (const slot of this.slots) power += raw[slot] * raw[slot];
    const norm = power > 1e-9 ? 1 / Math.sqrt(power) : 0;
    let sum = 0;
    for (const slot of this.slots) {
      raw[slot] *= norm;
      sum += raw[slot];
    }
    // A single covering slot normalises to exactly 1; two at equal weight
    // normalise to 0.707 each and sum to 1.41. Presence is what the DUCK reads,
    // and the duck is about "is there a bed at all", so it is clamped rather
    // than being allowed to exceed one through a transition.
    this.presence = clamp01(sum);
    return raw;
  }

  /**
   * @param {number} dt
   * @param {object} p
   * @param {number} [p.tripLevel] 0..1
   * @param {number} [p.rain]      0..1
   * @param {number} [p.phase]     override the clock; the check scripts do
   */
  update(dt, { tripLevel = 0, rain = 0, phase = null } = {}) {
    if (!this.decks.length) return;
    const w = this._weights(phase === null ? dayPhase() : phase, tripLevel);
    /**
     * THE BED DUCKS UNDER RAIN, exactly as the insect wall does.
     *
     * `ambience.js` calls that cross-coupling the only one in the file and worth
     * the line, because cicadas genuinely stop when it rains hard. The same
     * applies with more force to a recording OF cicadas: a downpour layered over
     * a dry-season chorus is two different weathers at once, and the recorded one
     * wins because it is the more convincing of the two.
     */
    const wet = 1 - clamp01(rain) * 0.7;
    for (const deck of this.decks) {
      const level = Number.isFinite(deck.spec.gain) ? deck.spec.gain : 1;
      deck.tick(w[deck.slot] ?? 0, level * this.gain * wet);
    }
    this.presence *= wet;

    /**
     * What the synthesised layers should give up, blended across the slots that
     * are audible.
     *
     * PER BED, BECAUSE THE BEDS ARE DIFFERENT RECORDINGS. A night bed that is
     * wall-to-wall katydids should push `ambience.js`'s katydid layer most of the
     * way out; a sparse dawn recording of distant birds should not touch it. The
     * manifest declares it because it is a fact about the file, and the file is
     * the thing that will be swapped.
     */
    let wind = 0;
    let insects = 0;
    let total = 0;
    for (const deck of this.decks) {
      const weight = w[deck.slot] ?? 0;
      if (weight <= 0) continue;
      const d = deck.spec.duck ?? {};
      wind += weight * (Number.isFinite(d.wind) ? d.wind : 0.55);
      insects += weight * (Number.isFinite(d.insects) ? d.insects : 0.45);
      total += weight;
    }
    this._duck.wind = total > 0 ? wind / total : 1;
    this._duck.insects = total > 0 ? insects / total : 1;
  }

  /** For `ambience.setBedPresence`. See that method for what the numbers mean. */
  get duck() {
    return this._duck;
  }

  /** Diagnostics for `scripts/audio-bed-check.mjs`. Allocates; not for the loop. */
  report() {
    return {
      gain: this.gain,
      presence: this.presence,
      duck: { ...this._duck },
      decks: this.decks.map((d) => ({
        slot: d.slot,
        src: d.chosen?.src,
        type: d.chosen?.type,
        crossfade: d.crossfade,
        seamTrimDb: d.seamTrimDb,
        running: d._running,
        fading: d._fading,
        seams: d.seams,
        level: Number(d.out.gain.value.toFixed(4)),
        target: Number((d.target ?? 0).toFixed(4)),
        // Proof that this is a stream and not a decode: a media element that is
        // playing from a network resource has a `buffered` window that is a
        // fraction of the file, and a `readyState` that is not 4 until it has
        // the whole thing. An AudioBuffer has neither concept.
        currentTime: Number(d._cur.el.currentTime.toFixed(3)),
        duration: d._cur.el.duration,
        buffered: d._cur.el.buffered.length ? Number(d._cur.el.buffered.end(0).toFixed(2)) : 0,
        readyState: d._cur.el.readyState,
      })),
    };
  }

  dispose() {
    for (const d of this.decks) d.dispose();
    this.decks.length = 0;
    try {
      this.output.disconnect();
    } catch {
      /* already gone */
    }
  }
}
