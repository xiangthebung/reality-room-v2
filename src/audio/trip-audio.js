import { clamp, clamp01, makeRng, rngRange } from '../core/util.js';
import { createImpulseResponse } from './impulse.js';
import { TUNING, subscribe as onTuningChange } from './tuning.js';

/**
 * What the trip does to the sound.
 *
 * The visual side is what people expect. The audio side is what makes it
 * convincing, because the reported experience is overwhelmingly about *space* —
 * sounds arriving from further away than the thing making them, hanging in the
 * air after they should have stopped, and the whole room breathing.
 *
 * Six layers, and every one of them was chosen partly for what it CANNOT do.
 *
 *   SPACE      A ten-second convolution send that rises past unity. An FIR, so
 *              it cannot accumulate, self-oscillate or click however long it
 *              runs. This is the layer doing most of the work.
 *
 *   TILT       A slow, non-resonant low-pass sweep on the send. Sounds go dull
 *              and bright again in waves. Q is fixed at 0.4: the same sweep with
 *              resonance is a filter effect, and a filter effect is a buzz.
 *
 *   DRONE      Sines and triangles on a just-intonation scale, a few cents
 *              apart so pairs beat over tens of seconds. NO SAWTOOTHS ANYWHERE.
 *              A detuned saw stack behind a resonant filter is precisely the
 *              "buzzing noise" this rewrite exists to remove; the harmonics of a
 *              saw are all there whether you wanted them or not, and a resonant
 *              filter then picks a band of them out and rings on it.
 *
 *   BREATH     Wide, soft noise swells at the breathing rate, filtered dark.
 *              Synchronised with the visual breath, so the room inhaling is one
 *              event across both senses rather than two coincidences.
 *
 *   SPARKS     Occasional FM bells drawn from the drone's own scale, panned at
 *              random and thrown deep into the reverb. Sparse on purpose — the
 *              gaps are what make them feel like they are happening to you
 *              rather than being played at you.
 *
 *   PULSE      A sine under 50 Hz during ego death. Nothing else in the app goes
 *              near that register, so it arrives as a body sensation rather than
 *              as a sound.
 *
 *   BLOOM      The send's own level, rising AFTER each transient rather than
 *              with it. See _bloom below — this is the most specifically
 *              described auditory effect there is and it was the one thing the
 *              list above had no answer to.
 *
 *   VOICES     Resonant bandpasses on the breath noise, tuned to the drone's
 *              own scale, arriving and leaving over four or five seconds. The
 *              wind stops being wind for a moment. See _buildVoices.
 *
 *   HALL       A second, much shorter reverb that ONLY the music goes through,
 *              fed the top of the record and almost none of its middle. See
 *              _buildMusic — this exists because the layers above are all built
 *              for sparse sources and a record is not one.
 *
 *   WEIGHT     A parallel low band on the music, swelling with the breath.
 *              Also _buildMusic. The bass is the one thing that must not go
 *              into any of the reverbs, and the one thing there should be more
 *              of.
 *
 *   SUB        An octave that is not in the recording, tracked off the bass and
 *              synthesised. The only sample-rate DSP in the project and the only
 *              part of this file allowed to fail to exist — see _attachSub and
 *              public/audio/sub-bass-processor.js.
 *
 *   BODY       Harmonics of the bass, an octave and a twelfth ABOVE it, where a
 *              small speaker and a preoccupied ear can both find them. The layer
 *              that makes the low end audible rather than merely present, and
 *              the only one of the three that costs almost no headroom. Also
 *              _buildMusic.
 *
 * The music's own tempo and tuning are bent from `director.js` instead of here,
 * because the jukebox synthesises its notes and can simply be asked to play
 * slower and flatter — which is a truer version of "the record is dragging" than
 * any amount of processing after the fact.
 */

/**
 * The four numbers the music's trip treatment is tuned on.
 *
 * `lowMax` is how much of the 30-150 Hz band is summed back onto the record.
 * `subMax` is the same for the synthesised octave beneath it. `harmMax` is the
 * harmonics generated ABOVE the bass. `hallMax` is the reverb send. All four are
 * summed gains rather than decibels because that is what the nodes actually take,
 * and converting in the comment is cheaper than converting on every frame.
 *
 * "MORE BASS" IS A RATIO, NOT A LEVEL, and forgetting that cost a whole round of
 * tuning. The hall was originally a MID-band reverb, so opening it raised the
 * mids by nearly 3 dB — and the low shelf underneath it was raising the lows by
 * 4.2. Two changes that each sounded right on their own were cancelling each
 * other out: the record's actual tilt moved about 1.4 dB, which is on the edge
 * of audible, while every absolute measurement cheerfully reported that the bass
 * was up. Only the low-to-mid column in `record-space.mjs` showed it. Sending
 * the hall the top of the record instead of the middle of it fixed both
 * complaints at once — the roar and the cancellation were the same fact.
 *
 * AND THEN THE RATIO WENT UP AND THE MIX STARTED PUMPING, WHICH IS THE SECOND
 * THING THESE NUMBERS ARE ABOUT.
 *
 * `engine.js` limits at -5 dBFS with an 18:1 ratio, and a mastered record
 * arrives close to it already. Everything added underneath is paid for in gain
 * reduction, and low frequencies are the most expensive thing there is to add:
 * they are the largest excursions in any mix, so they set the peak, and the peak
 * is the only thing a limiter can see. Nine decibels under 160 Hz bought a
 * limiter that moved 2.1 dB in time with the kick drum — the whole record
 * ducking twice a second, which is audible as pumping long before it is audible
 * as bass.
 *
 * THE ANSWER IS NOT LESS BASS, IT IS BASS THAT COSTS LESS PEAK. Two mechanisms,
 * both in `_buildMusic`:
 *
 *   A SOFT CEILING on the low path, so its crest factor stops setting the
 *   master's. Peaks are rounded off where they occur instead of being handed to
 *   a limiter that responds by turning down everything else as well.
 *
 *   HARMONICS ABOVE THE BASS, which is where most of `harmMax` goes. The ear
 *   infers a fundamental from its overtones — the effect every small speaker in
 *   the world relies on — so an octave and a twelfth above the bass line reads
 *   as more bass while adding energy in the one region that is cheap in peak
 *   terms and, unlike the shelf, is not competing with the kick for the same
 *   millisecond.
 *
 * `record-space.mjs` reports `swing`, the distance the limiter travels, and it
 * is the column these four numbers are actually constrained by. Mean gain
 * reduction is not: the pumping build averaged -1.4 dB, which is nothing.
 *
 * WHAT IS ACTUALLY MOVING THE LIMITER, MEASURED RATHER THAN ASSUMED. At ego
 * death, disconnecting one layer at a time: 0.22 dB of swing with every low path
 * off, 1.47 with them on, 1.95 with the trip's own ego-death pulse on top. So
 * roughly three quarters of it is these four numbers and a quarter is the pulse
 * — a sub-50 Hz sine deliberately amplitude-modulated at 0.85 Hz, which is a
 * designed body sensation and is not something to tune away. That measurement is
 * what says the shelf and the sub are worth trading down and the harmonics are
 * worth trading up, rather than that everything should simply be quieter.
 */
/**
 * THE VALUES THEMSELVES NOW LIVE IN `tuning.js`, one import away, because they
 * are the part of this file that has to be decided by ear and everything else
 * is the part that has to be decided by argument. `TUNING.lowMax` and its
 * neighbours are read live — per frame for the gains, and through
 * `_applyTuning` for anything that has to be written into a node — so the debug
 * panel's sliders move them while a record is playing. Nothing here caches
 * them.
 */

/**
 * ---- the two transfer curves ------------------------------------------------
 *
 * Both are `WaveShaper` curves, which is to say both are memoryless: output
 * depends on this sample and nothing else. That is the property that makes them
 * usable here and it is worth being explicit about what it rules out.
 *
 * A COMPRESSOR WAS THE OBVIOUS ANSWER AND IS THE WRONG ONE. `DynamicsCompressor`
 * is one node and does exactly what the low path needs; it also has a pre-delay
 * on the implementations that use one, and this is a PARALLEL path summed back
 * against a dry record that still contains the same bass. A few milliseconds of
 * delay on a 50 Hz signal is most of a quarter cycle, and summing a signal with
 * a phase-shifted copy of itself is a comb filter — the low band would partly
 * CANCEL, which is the failure mode that would look like "the boost does
 * nothing" and would take a day to find. Correlated signals sum by amplitude,
 * and they subtract by it too.
 *
 * That also settles `oversample`, which must stay 'none'. 2x and 4x are FIR
 * resamplers and carry latency for the same reason, so the setting that exists
 * to prevent aliasing would reintroduce the exact problem the compressor was
 * rejected for. It is safe to turn off here because both shapers are fed
 * band-limited signals — nothing above 150 Hz reaches either — and the harmonics
 * of a 150 Hz tone are still thousands of hertz below Nyquist.
 *
 * An odd number of points so the middle sample lands exactly on x = 0. With an
 * even count the curve is interpolated across zero and a shaper that should be
 * flat there has a tiny step in it, which on a low-level signal is the only
 * thing you can hear.
 */
const CURVE_POINTS = 4097;

/**
 * A SOFT CEILING WITH UNITY SLOPE AT ZERO.
 *
 * `tanh(kx)/k` rather than `tanh(kx)`: dividing by k puts the gradient at the
 * origin back to exactly 1, so quiet material passes through untouched and this
 * is a ceiling rather than a level change. What it costs is the top: output can
 * never exceed `tanh(k)/k`, about 0.44 at k = 2.2, and everything approaches
 * that gradually instead of hitting it.
 *
 * Inputs beyond ±1 are clamped by the shaper to the curve's endpoints, which is
 * the correct behaviour here and not an accident to be guarded against — the
 * ceiling is meant to be a ceiling however hard the band is driven.
 */
function softCeilingCurve(k) {
  const c = new Float32Array(CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i++) {
    const x = (i / (CURVE_POINTS - 1)) * 2 - 1;
    c[i] = Math.tanh(x * k) / k;
  }
  return c;
}

/**
 * ASYMMETRIC, WHICH IS THE ENTIRE DESIGN.
 *
 * A symmetric transfer curve — any odd function, which is what `tanh` on its own
 * is — can only produce ODD harmonics: the third, the fifth. The third harmonic
 * of a bass note is an octave and a fifth above it, and a bass line reinforced
 * only by its twelfth sounds hollow and slightly sour, because the interval it
 * adds is not the one the ear was expecting.
 *
 * Bending the two halves by different amounts breaks that symmetry and produces
 * the EVEN harmonics as well — the second, which is the octave, and the fourth,
 * which is two octaves. Those are the ones that read as the same note, louder.
 * Every valve stage and every transformer that has ever been described as warm
 * is doing this, and it is doing it for this reason.
 *
 * The price is a DC offset that rises with signal level, since the curve no
 * longer averages to zero. `_buildMusic` high-passes hard after this, which
 * removes it along with the fundamental that came through unchanged.
 *
 * Normalised by peak rather than by slope, because unlike the ceiling above this
 * is not trying to be transparent anywhere — it is a generator, and what matters
 * is that its output is bounded and predictable so `harmMax` means something
 * stable from one record to the next.
 */
function harmonicCurve(up, down) {
  const c = new Float32Array(CURVE_POINTS);
  let peak = 0;
  for (let i = 0; i < CURVE_POINTS; i++) {
    const x = (i / (CURVE_POINTS - 1)) * 2 - 1;
    c[i] = Math.tanh(x * (x >= 0 ? up : down));
    peak = Math.max(peak, Math.abs(c[i]));
  }
  for (let i = 0; i < CURVE_POINTS; i++) c[i] /= peak;
  return c;
}

/**
 * ---- the spectral microscope ------------------------------------------------
 *
 * Four bands of the record, each swimming forward and back on its own slow
 * cycle. The bands are spaced roughly by musical thirds of the spectrum — the
 * bass line, the body and vowels, the presence region where a voice's
 * consonants and a guitar's pick noise live, and the air.
 *
 * THE RATES ARE THE EFFECT AND THEY MUST NOT DIVIDE INTO EACH OTHER. Four
 * oscillators at 1:2:3:4 realign every cycle of the slowest, which is a pattern,
 * and a pattern at this timescale is a phaser. These four have no common period
 * shorter than several minutes, so no two bands are ever up together twice in
 * the same relationship and the ear never finds the loop.
 *
 * Q IS 1.1, WHICH IS DELIBERATELY BROAD. This is attention moving across a
 * record, not an EQ curve being drawn on it: adjacent bands overlap, so what
 * swims forward is a REGION of the music with soft edges rather than a slice
 * with a filtered rim. At Q = 4 the same automation sounds like a wah pedal.
 *
 * The pans are fixed and modest. A band that both moves in level and moves in
 * space is two effects, and the second one wins — the record would start
 * sloshing side to side, which is a much cruder thing than the one this is for.
 */
const SCOPE_BANDS = [180, 520, 1500, 4200];
const SCOPE_RATES = [1, 1.63, 2.41, 3.77];
const SCOPE_PANS = [-0.28, 0.44, -0.52, 0.33];

/** Just intervals: the beating is slow and consonant rather than sour. */
const SCALES = [
  [1, 9 / 8, 4 / 3, 3 / 2, 5 / 3],
  [1, 6 / 5, 3 / 2, 9 / 5, 12 / 5],
  [1, 5 / 4, 3 / 2, 15 / 8, 5 / 2],
  [1, 7 / 6, 11 / 8, 3 / 2, 7 / 4],
];

export class TripAudio {
  constructor(engine) {
    this.engine = engine;
    this.built = false;
    this.nodes = null;
    this._seed = '';
    this._nextSpark = 4;
    this._scale = SCALES[0];
    this._root = 62;
    /**
     * The lagged transient that drives the reverb bloom. Initialised HERE and
     * not lazily in update(): the smoothing line reads its own previous value,
     * and `undefined` propagates through one subtraction into a NaN that
     * `setTargetAtTime` rejects on every frame thereafter — the parameter is
     * then stuck wherever it was, silently, for the rest of the session.
     */
    this._bloom = 0;
    /**
     * How busy the last twenty seconds have been. See `update`, which subtracts
     * it. Initialised here for the same reason as `_bloom` above, and it is the
     * same trap: this one reads `_bloom`, so a lazy initialisation would put a
     * NaN into the wet gain rather than into itself.
     */
    this._bloomBed = 0;
    /**
     * How hard the low end is being driven, 0..1, published for the subwoofer's
     * cone to show. The manufactured bass reaches the mix without a position of
     * its own — low frequencies are non-directional and routing them through a
     * panner would attenuate them a second time, since they are tapped from
     * `trims.music` which is already downstream of the cabinets' own distance
     * model. This is the one way it becomes visible.
     */
    this.weight = 0;
  }

  get ctx() {
    return this.engine?.ctx ?? null;
  }

  build() {
    if (this.built) return true;
    const ctx = this.ctx;
    if (!ctx || !this.engine.ready) return false;

    /**
     * A SEND, NOT AN INSERT.
     *
     * The dry path stays bit-identical to the sober path, so a failure anywhere
     * in here can only ever be silence in this layer — never a forest that has
     * lost its audio. Re-plumbing preMaster as an insert would be tidier on
     * paper and one thrown exception away from a broken world.
     */
    const send = ctx.createGain();
    send.gain.value = 0;

    const convolver = ctx.createConvolver();
    convolver.normalize = true;
    convolver.buffer = createImpulseResponse(ctx, 'cosmos');

    const tilt = ctx.createBiquadFilter();
    tilt.type = 'lowpass';
    tilt.frequency.value = 1600;
    tilt.Q.value = 0.4;

    const tiltLfo = ctx.createOscillator();
    const tiltDepth = ctx.createGain();
    tiltLfo.frequency.value = 0.031; // ~32 s
    tiltDepth.gain.value = 900;
    tiltLfo.connect(tiltDepth).connect(tilt.frequency);

    const wet = ctx.createGain();
    wet.gain.value = 0;
    send.connect(convolver).connect(tilt).connect(wet);

    // ---- drone ------------------------------------------------------------
    const droneBus = ctx.createGain();
    droneBus.gain.value = 0;
    const droneTone = ctx.createBiquadFilter();
    droneTone.type = 'lowpass';
    droneTone.frequency.value = 900;
    droneTone.Q.value = 0.35;
    const droneLfo = ctx.createOscillator();
    const droneDepth = ctx.createGain();
    droneLfo.frequency.value = 0.037;
    droneDepth.gain.value = 380;
    droneLfo.connect(droneDepth).connect(droneTone.frequency);
    droneBus.connect(droneTone);
    // The drone goes through the same reverb as everything else, so it sits in
    // the room rather than in the headphones.
    const droneSend = ctx.createGain();
    droneSend.gain.value = 0.75;
    droneTone.connect(droneSend).connect(send);

    // ---- breath -----------------------------------------------------------
    const breathBus = ctx.createGain();
    breathBus.gain.value = 0;
    const breathTone = ctx.createBiquadFilter();
    breathTone.type = 'lowpass';
    breathTone.frequency.value = 480;
    breathTone.Q.value = 0.3;
    const breathSrc = ctx.createBufferSource();
    {
      const len = Math.floor(ctx.sampleRate * 5);
      const buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let b0 = 0;
        let b1 = 0;
        for (let i = 0; i < len; i++) {
          const w = Math.random() * 2 - 1;
          b0 = 0.997 * b0 + w * 0.1;
          b1 = 0.96 * b1 + w * 0.3;
          d[i] = (b0 + b1) * 0.4;
        }
      }
      breathSrc.buffer = buf;
      breathSrc.loop = true;
    }
    breathSrc.connect(breathTone).connect(breathBus);
    breathBus.connect(send);

    /**
     * ---- voices in the wind -------------------------------------------------
     *
     * AUDITORY MISINTERPRETATION, which is the effect the reports describe most
     * fondly and the one this file had nothing for: ambient noise is briefly
     * heard as voices or as elaborately detailed music, and it stops the instant
     * you identify it. The trigger material is always the same in the accounts —
     * fans, running water, rain, wind — and this forest is already full of it.
     *
     * THREE RESONANT BANDPASSES ON THE BREATH NOISE, NOT A COMB BANK. The
     * textbook implementation is short feedback combs at 0.75-0.85, and that is
     * a recursion — the one structure this project has a standing rejection of,
     * because a resonator with feedback is a hair's breadth from a self-
     * oscillating synth and the complaint that started the rewrite was a buzz.
     * A bandpass has no feedback at all: it cannot ring on past its input,
     * cannot accumulate and cannot be driven into oscillation, and on noise it
     * produces exactly the same percept — a pitch you can hear but not quite
     * pin down, made of the sound that was already there.
     *
     * Q IS 26, WHICH SOUNDS HIGH AND IS THE POINT. On a tonal source that would
     * be a whistle; on band-limited noise it is a breathy near-pitch, because
     * what comes out is still noise, just narrower. Below about 15 it is only a
     * colouration and nobody hears a voice; above about 40 the ring time gets
     * long enough to read as a struck resonator.
     *
     * EVERYTHING ABOUT THE TIMING IS DOING THE WORK. The partials fade in over
     * four seconds and out over six, never more than two at once, on periods
     * that do not divide into each other. A fast attack is a synth note; a slow
     * one is the forest deciding. And they are pitched from the drone's own
     * scale, so when one does surface it is consonant with everything else and
     * reads as the wood joining in rather than as a second instrument.
     *
     * Under 900 Hz, all of them. audio-probe fails the mix past a 2600 Hz
     * spectral centroid or 30% of the energy between 2 and 6 kHz, and a bank of
     * resonators is exactly the shape of thing that trips both.
     */
    const voiceBus = ctx.createGain();
    voiceBus.gain.value = 0;
    voiceBus.connect(send);
    const voiceDry = ctx.createGain();
    voiceDry.gain.value = 0.34;
    voiceBus.connect(voiceDry);
    const murmurs = [];
    for (let i = 0; i < 3; i++) {
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 220;
      band.Q.value = 26;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      pan.pan.value = 0;
      breathTone.connect(band).connect(gain).connect(pan).connect(voiceBus);
      murmurs.push({ band, gain, pan, on: false, until: 0 });
    }

    // ---- ego-death pulse --------------------------------------------------
    const pulseOsc = ctx.createOscillator();
    pulseOsc.type = 'sine';
    pulseOsc.frequency.value = 42;
    const pulseGain = ctx.createGain();
    pulseGain.gain.value = 0;
    const pulseLfo = ctx.createOscillator();
    pulseLfo.type = 'triangle';
    // 0.85 Hz — a resting heart rate, and comfortably under the 3 Hz threshold
    // the photosensitivity guidance is built around.
    pulseLfo.frequency.value = 0.85;
    const pulseDepth = ctx.createGain();
    pulseDepth.gain.value = 0;
    pulseOsc.connect(pulseGain);
    pulseLfo.connect(pulseDepth).connect(pulseGain.gain);

    // ---- sparks -----------------------------------------------------------
    const sparkBus = ctx.createGain();
    sparkBus.gain.value = 0;
    sparkBus.connect(send);
    const sparkDry = ctx.createGain();
    sparkDry.gain.value = 0.25;
    sparkBus.connect(sparkDry);

    // ---- into the engine ---------------------------------------------------
    const target = this.engine.limiter ?? ctx.destination;
    wet.connect(target);
    droneTone.connect(target);
    pulseGain.connect(target);
    sparkDry.connect(target);
    voiceDry.connect(target);

    /**
     * WHAT FEEDS THE SEND, AND WHY IT IS NO LONGER preMaster.
     *
     * This line used to read `this.engine.preMaster.connect(send)`, which is
     * every bus in the game plus the forest reverb's own return, all of it into
     * a nine-and-a-half second tail. On the things this layer was designed for
     * — a bird, a footstep, a stick cracking — that is the whole effect and it
     * is wonderful. On a pasted YouTube link it is the bug: a mastered record is
     * continuous, broadband and loud, so at any instant the tail is carrying
     * about nineteen beats of phase-scrambled history at once, and a sum of
     * nineteen decorrelated copies of a broadband signal is, to a very good
     * approximation, noise. `scripts/record-space.mjs` measures the tail one
     * second after the record stops, as a fraction of what the cabinet was
     * putting out: 0.6% sober, 58% at the peak of a trip, 70% at ego death.
     * That is not a space around the music, it is a second blurred copy of the
     * music playing over the top of it — which is exactly the report, "very
     * echoey, and it starts sounding like white noise in the back".
     *
     * That script can rebuild this topology from the console (`--old`) so the
     * comparison stays checkable rather than becoming a claim in a comment.
     *
     * So the two are separated. `worldBus` and `sfxBus` keep the cosmos tail
     * unchanged, because they are the sparse sources it was tuned on and
     * nothing about them was ever wrong. Music gets its own, sized for music —
     * see `_buildMusic`.
     *
     * THE TRIMS, NOT THE BUSES, for the reason `engine.js` gives for its own
     * room send: tapping a bus means turning the world down to zero leaves its
     * reverb tail playing on without it. Tapping the trim also means this gets
     * cave occlusion for free, so a trip underground is a trip underground.
     *
     * TWO THINGS QUIETLY LEAVE THE COSMOS TAIL HERE and both are improvements.
     * Voice, which `engine.js` keeps dry from every other reverb in the game for
     * reasons that apply with more force to a nine-second one. And the forest
     * and cave returns, which were being convolved a second time — a tail fed
     * into a longer tail, pre-smeared before it ever arrived.
     */
    this.engine.trims.world.connect(send);
    this.engine.trims.sfx.connect(send);

    const music = this._buildMusic(ctx, target, murmurs);

    for (const osc of [tiltLfo, droneLfo, pulseOsc, pulseLfo]) osc.start();
    breathSrc.start();

    this.nodes = {
      send,
      convolver,
      tilt,
      wet,
      droneBus,
      droneTone,
      breathBus,
      breathTone,
      pulseGain,
      pulseOsc,
      pulseDepth,
      sparkBus,
      voiceBus,
      voiceDry,
      murmurs,
      oscillators: [tiltLfo, droneLfo, pulseOsc, pulseLfo],
      breathSrc,
      voices: [],
      target,
      ...music,
    };
    this.built = true;
    this._applyTuning(this.nodes);
    /**
     * Follow the knobs for as long as this graph exists.
     *
     * `this.nodes` rather than a captured reference, because `dispose` sets it
     * to null and this must not be the thing that keeps a torn-down graph alive
     * — `_applyTuning` returns immediately on null. The unsubscribe in `dispose`
     * is what actually stops it; this is the belt to that pair of braces.
     */
    this._unsubscribeTuning?.();
    this._unsubscribeTuning = onTuningChange(() => this._applyTuning(this.nodes));
    // Deliberately not awaited: see `_attachSub`. `build()` is called from a
    // synchronous path and the sub is the one part of this file that is allowed
    // to never turn up.
    void this._attachSub(ctx, this.nodes);
    return true;
  }

  /**
   * THE RECORD'S OWN SPACE, AND THE WEIGHT UNDER IT.
   *
   * Two parallel taps off the music trim, both sends, neither in the dry path.
   *
   * ---- the hall ------------------------------------------------------------
   *
   * A SHORTER ROOM. `cathedral` is 4.6 seconds against cosmos's 9.5 and its
   * envelope falls off as (1-t)^2.1 rather than ^1.5, so at any instant it is
   * holding roughly a third of the history. It also has four early reflections
   * where cosmos deliberately has none: early reflections are what tell the
   * brain how big a space is and where it is, and that is the difference
   * between music that is playing in a large room and music that is nowhere.
   * Cosmos wants to be nowhere. A record wants to be somewhere, because there
   * is a cabinet standing in the clearing that you can walk up to.
   *
   * ONLY THE TOP OF THE RECORD IS SENT, AND THIS WAS THE SECOND ATTEMPT.
   *
   * The first version high-passed the send at 210 Hz and low-passed it at
   * 2.4 kHz, on the reasoning that the noise in "sounds like white noise" lives
   * between 2 and 6 kHz — the band `audio-probe.mjs` calls `harsh` — so the way
   * to stop a tail hissing is to stop sending it anything up there. That
   * reasoning was about the wrong axis. What it built was a reverb fed almost
   * entirely by the LOW MIDS, which is where a mix keeps most of its energy:
   * bass fundamentals, the body of a snare, the vowels of a vocal, every guitar.
   * Convolving the loudest part of a record produces a continuous, dense roar
   * that never gets out of the way, and a roar behind music is exactly what gets
   * described as noise in the background. Halving the tail's LEVEL made it
   * quieter without making it any less of a roar.
   *
   * So the send is high-passed at 1.4 kHz instead. What goes into the tail is
   * cymbals, the edge of a snare, the air on a voice, the harmonics of anything
   * bright — content that is sparse and transient, which is what a long reverb
   * has always wanted and is the same reason cosmos works on birdsong. The
   * result reads as shimmer around the record rather than as fog behind it, and
   * the mids are left alone, which is where the music actually is.
   *
   *   ONE BIQUAD, 12 dB PER OCTAVE, NOT A BRICK WALL, and that is deliberate:
   *   the mid range is meant to be REDUCED rather than removed. At 700 Hz this
   *   is 12 dB down and at 350 Hz 24 dB, so the low mids still put something
   *   into the room — just an order of magnitude less than the top does. A true
   *   cut-off would make the tail sound detached from the record, like a
   *   separate bright thing playing alongside it.
   *
   *   THE LOW-PASS STAYS, at 6 kHz, and is now the only thing standing between
   *   this and literal hiss. Sending the top and nothing but the top is one
   *   filter away from a noise generator; cathedral is already fairly dark
   *   (damp 0.2, tilt 0.4) and this keeps the last octave and a half out of it.
   *
   * FED ALWAYS, GATED AT THE END. The convolver sees the music whether or not a
   * trip is running and only `hallWet` opens. A convolver that starts receiving
   * signal at the moment the trip begins has four and a half seconds of silent
   * history in it, so the space would fade in over four and a half seconds
   * regardless of how the gain was ramped. Keeping it fed means the room is
   * already there when the door opens.
   *
   * ---- the weight ----------------------------------------------------------
   *
   * TWO PATHS, BECAUSE "MORE BASS" AND "DEEPER BASS" ARE NOT THE SAME REQUEST
   * AND ONE MECHANISM CANNOT ANSWER BOTH.
   *
   * THE SHELF makes what is already there louder. A parallel low band, summed
   * back — which IS a low shelf, the same one a mixer would reach for, and
   * doing it as a send rather than an insert keeps the promise this whole file
   * makes: the sober path is untouched, so the worst this layer can do is be
   * silent. 150 Hz catches a kick's fundamental and the whole bass line without
   * reaching up into the vowels, and at `lowMax` the band sums to about +9 dB.
   * The high-pass at 30 Hz under it is not optional: subsonic content is
   * inaudible, it is present in plenty of masters, and boosting it into a
   * limiter set at -5 dBFS makes the whole mix duck on energy nobody can hear.
   *
   * THE SUB adds an octave that was never recorded. A shelf cannot do this: a
   * record whose bass line sits at 90 Hz has nothing at 45 Hz to lift, and no
   * amount of gain on an empty band produces a note. `sub-bass-processor.js`
   * follows the bass and plays a sine an octave beneath it — see that file for
   * why it has to be an AudioWorklet and how it avoids warbling on chords. This
   * is the "deeper", where the shelf is the "more".
   *
   * The sub is fed from its own 40–190 Hz band rather than sharing the shelf's,
   * because the two want opposite things. The shelf wants everything under
   * 150 Hz including the kick's click and the low mids, since all of it is
   * weight. The divider wants ONLY the pitched fundamental, because everything
   * else in the band is another zero crossing to be confused by.
   *
   * THE HARMONICS are the third mechanism and the one that answers "more bass
   * that I can actually hear". A note is identified by its overtone series, not
   * by its fundamental — the fundamental can be missing entirely and the ear
   * still reports the note, which is how a telephone conveys a male voice
   * through a channel that starts at 300 Hz and how any speaker smaller than a
   * wardrobe produces bass at all. So the bass line is fed to a deliberately
   * asymmetric transfer curve and the octave and twelfth it generates are summed
   * back at 100-620 Hz.
   *
   *   THIS IS THE CHEAP ONE, and that is why most of the new weight comes from
   *   here. The shelf and the sub both add energy exactly where the mix is
   *   already largest, so every decibel of them is a decibel off the peak
   *   budget; harmonics land where there is room, and the ear credits them to
   *   the bass anyway. It is more bass for less limiter.
   *
   *   IT IS ALSO THE STEADY ONE. A saturating curve compresses what it is given
   *   — twice the input is nowhere near twice the output — so this layer's
   *   contribution barely moves between a verse and a chorus. A shelf tracks the
   *   kick drum and hands the master limiter a moving target; this does not.
   *
   * ---- the ceiling ----------------------------------------------------------
   *
   * BOTH LOW PATHS SUM INTO ONE SOFT CEILING BEFORE THEY REACH THE MIX, and it
   * has to be their sum rather than one each. The shelf and the sub are the same
   * bass line an octave apart with the same envelope, so they are strongly
   * correlated and add by amplitude; two ceilings each holding its own path
   * inside a sensible bound still lets the pair arrive together at twice it.
   * What the master limiter reacts to is the total, so the total is what gets
   * bounded.
   *
   * The guard low-pass after it is not optional. A saturator generates harmonics
   * by definition, and these are harmonics of a 40-150 Hz signal, so unfiltered
   * they would put a few hundred hertz of buzz into the mids on every kick —
   * the same content the harmonics path above produces deliberately and with a
   * level control, arriving here by accident and without one.
   *
   * IT BREATHES, and that is what makes it "surrounding" rather than just
   * "loud". All three paths ride the same breath the visuals do, so the low end
   * swells and settles with the room instead of sitting at a fixed level. Low
   * frequencies are non-directional — these bypass the panners entirely, which
   * for bass is not a compromise but the correct answer — so they arrive from
   * everywhere at once and move.
   */
  _buildMusic(ctx, target, murmurs) {
    const musicTrim = this.engine.trims.music;

    const hallHp = ctx.createBiquadFilter();
    hallHp.type = 'highpass';
    hallHp.frequency.value = TUNING.hallLow;
    hallHp.Q.value = 0.5;
    const hallLp = ctx.createBiquadFilter();
    hallLp.type = 'lowpass';
    hallLp.frequency.value = 6000;
    hallLp.Q.value = 0.4;
    const hallVerb = ctx.createConvolver();
    hallVerb.normalize = true;
    hallVerb.buffer = createImpulseResponse(ctx, 'cathedral');
    const hallWet = ctx.createGain();
    hallWet.gain.value = 0;
    musicTrim.connect(hallHp).connect(hallLp).connect(hallVerb).connect(hallWet).connect(target);

    const lowHp = ctx.createBiquadFilter();
    lowHp.type = 'highpass';
    lowHp.frequency.value = 30;
    lowHp.Q.value = 0.6;
    const lowLp = ctx.createBiquadFilter();
    lowLp.type = 'lowpass';
    lowLp.frequency.value = TUNING.lowCorner;
    // Over-damped on purpose. A resonant corner here would be a boom at one
    // pitch — the single most recognisable sound of a bad bass boost — and the
    // gentler phase slope keeps the sum with the dry path from notching the
    // low-mids out.
    lowLp.Q.value = 0.5;
    const lowGain = ctx.createGain();
    lowGain.gain.value = 0;

    /**
     * Where the shelf and the sub meet, and the only point in this file that
     * touches the mix on their behalf. Both of them now end here rather than at
     * `target` — see the ceiling note in the header above for why it has to be
     * their sum.
     */
    const bassSum = ctx.createGain();
    bassSum.gain.value = 1;
    const bassShape = ctx.createWaveShaper();
    /**
     * k = 3, a ceiling of about 0.33. Because the curve has unity slope at the
     * origin, raising k lowers the ceiling WITHOUT touching anything quiet: it
     * takes decibels off the loudest moments only, which are the ones the master
     * limiter reacts to. Turning `lowMax` down instead buys a similar reduction
     * by making the whole low end quieter, including all the parts that were
     * causing no trouble.
     *
     * THERE IS A LIMIT TO THAT ARGUMENT AND 3.6 IS PAST IT. Raising k further
     * was tried, on the reasoning above, and made the limiter move MORE rather
     * than less: 1.75 and 2.04 dB of swing against 1.33 and 1.78 at k = 3, on
     * two runs each. A ceiling is compression, and compression flattens a
     * waveform towards a square — which lowers the peak and RAISES the sustained
     * energy behind it, so past some point what the limiter gains on the
     * transient it loses on everything in between. The comment above was written
     * before that measurement and would have gone on justifying the wrong
     * direction indefinitely.
     *
     * AND MEASURE IT AT THE WORST BREATH PHASE, NOT THE AVERAGE ONE. `weight`
     * swells by 5 dB over the breath cycle and `record-space.mjs` freezes
     * wherever that cycle happens to be, so ego-death swing varies by more than
     * half a decibel between runs of an identical build, tracking `lowGain`. One
     * passing run near the threshold means nothing.
     */
    bassShape.curve = softCeilingCurve(TUNING.bassCeiling);
    bassShape.oversample = 'none';
    const bassGuard = ctx.createBiquadFilter();
    bassGuard.type = 'lowpass';
    bassGuard.frequency.value = 170;
    bassGuard.Q.value = 0.5;
    bassSum.connect(bassShape).connect(bassGuard).connect(target);

    musicTrim.connect(lowHp).connect(lowLp).connect(lowGain).connect(bassSum);

    // The divider's own feed and its output trim. The processor between them
    // arrives later and may never arrive at all — see `_attachSub`.
    const subHp = ctx.createBiquadFilter();
    subHp.type = 'highpass';
    subHp.frequency.value = 40;
    subHp.Q.value = 0.7;
    const subLp = ctx.createBiquadFilter();
    subLp.type = 'lowpass';
    subLp.frequency.value = 190;
    subLp.Q.value = 0.5;
    /**
     * A guard between the synthesised octave and the speakers. The lowest note
     * the divider will accept is 55 Hz, so the lowest sine it can produce is
     * 27.5 Hz and this barely touches it — it is here for what happens if the
     * processor ever misbehaves, since the one thing a bug in an oscillator can
     * produce that nothing else in this graph can is sustained inaudible energy
     * at full amplitude.
     */
    const subDc = ctx.createBiquadFilter();
    subDc.type = 'highpass';
    subDc.frequency.value = 24;
    subDc.Q.value = 0.7;
    const subGain = ctx.createGain();
    subGain.gain.value = 0;
    musicTrim.connect(subHp).connect(subLp);
    subDc.connect(subGain).connect(bassSum);

    /**
     * ---- the harmonics ------------------------------------------------------
     *
     * Its own feed, for the same reason the divider has one: what a generator
     * wants is the pitched fundamental and nothing else. 45-150 Hz, the two
     * corners chosen from opposite ends — 45 because below it there is no
     * fundamental worth doubling on any record, and 150 because above it the
     * shaper would start distorting the low mids of the actual music rather than
     * synthesising overtones for the bass.
     *
     * THE DRIVE IS FIXED AND THAT IS THE FEATURE. It sets how far up the curve a
     * typical bass note reaches, and because the curve saturates, a fixed drive
     * means a near-constant output level: this layer sounds the same through a
     * quiet passage and a loud one. Making it track the input would restore
     * exactly the dynamics that make the shelf expensive.
     *
     * AND THEN EVERYTHING BELOW 165 Hz IS THROWN AWAY AGAIN, which sounds
     * self-defeating and is the entire difference between an exciter and a third
     * bass shelf. Two things come out of the shaper that must not reach the mix:
     * the fundamental itself, which arrived unchanged and would just be a
     * distorted copy of the shelf, and a DC offset that grows with level because
     * the curve is deliberately asymmetric.
     *
     *   FOURTH ORDER, AS TWO BIQUADS, AND IT HAS TO BE. This was one 12 dB/oct
     *   section at 100 Hz and the measurement was brutal: 47% of the output was
     *   still BELOW 100 Hz and another 41% between 100 and 160, so 88% of what
     *   this path contributed was bass — the fundamental leaking straight
     *   through a filter that is only 8 dB down an octave below its corner. The
     *   band it exists to fill got 12%. It was measurably raising `low` and
     *   measurably not raising `body`, which is the exact opposite of the
     *   request, and every level change made it more wrong rather than less.
     *
     *   At 24 dB/oct the fundamental of a 55 Hz bass note is 39 dB down and the
     *   octave above it 15 dB down, so what survives is the twelfth and above —
     *   which is the part that lands where a small speaker and a distracted ear
     *   can both find it.
     *
     *   The Q pair is a fourth-order Butterworth split into its two sections
     *   rather than two identical Q = 0.707 filters. Cascading two of those
     *   gives -6 dB at the corner instead of -3 and droops for an octave above
     *   it, which would eat the third harmonic this is being built around.
     *
     * The low-pass at 700 Hz is the other bound. Past there these stop being
     * overtones of a bass note and start being midrange distortion sitting on
     * top of the vocal.
     *
     * The aggressive high-pass turns out to earn its keep twice. Intermodulation
     * between the kick and the bass note produces SUM AND DIFFERENCE tones, and
     * the difference tones — the inharmonic ones, the ones that sound like
     * clangour rather than weight — are by construction lower in frequency than
     * either source. They land below 165 Hz and leave with the fundamental.
     */
    const harmHp = ctx.createBiquadFilter();
    harmHp.type = 'highpass';
    harmHp.frequency.value = 45;
    harmHp.Q.value = 0.7;
    const harmLp = ctx.createBiquadFilter();
    harmLp.type = 'lowpass';
    harmLp.frequency.value = 150;
    harmLp.Q.value = 0.5;
    const harmDrive = ctx.createGain();
    /**
     * 1.2, WHICH IS WELL SHORT OF WHAT PRODUCES THE MOST HARMONICS, because
     * harmonic distortion is not the only thing a saturator makes.
     *
     * Given two tones it also produces INTERMODULATION — sums and differences of
     * the two, which are not harmonically related to either and so read as
     * clangour rather than as weight. Harmonic distortion grows roughly with the
     * drive; intermodulation grows faster. This band contains a kick and a bass
     * note at the same time on almost every record ever mastered, so the useful
     * range ends well before the curve is being used hard.
     *
     * The synthetic record in `record-space.mjs` cannot see this — its bass line
     * plays one note at a time, which is the friendliest possible input to a
     * nonlinearity — so the drive is set conservatively on the argument rather
     * than on the measurement, which cannot fail it.
     */
    harmDrive.gain.value = TUNING.harmDrive;
    const harmShape = ctx.createWaveShaper();
    harmShape.curve = harmonicCurve(3.0, 1.6);
    harmShape.oversample = 'none';
    const harmHp2 = ctx.createBiquadFilter();
    harmHp2.type = 'highpass';
    harmHp2.frequency.value = TUNING.harmLow;
    // -5.33 and +2.32 dB: the fourth-order Butterworth section Qs of 0.5412 and
    // 1.3066, converted into the decibels this parameter is actually specified
    // in for a highpass. Written as literals with the working shown rather than
    // computed, because a reader checking this against a filter table needs to
    // see both numbers. See `crossover.js` for what the units cost to discover.
    harmHp2.Q.value = -5.33;
    const harmHp3 = ctx.createBiquadFilter();
    harmHp3.type = 'highpass';
    harmHp3.frequency.value = TUNING.harmLow;
    harmHp3.Q.value = 2.32;
    /**
     * A CEILING ON THE HARMONICS TOO, AND LEAVING IT OUT WAS THE LAST BUG.
     *
     * The shelf and the sub were bounded and this path was not, so as soon as it
     * was carrying most of the added weight it became the thing moving the master
     * limiter — trading `lowMax` down and `harmMax` up made the swing WORSE,
     * 2.1-2.7 dB against 1.3-1.8, which is the opposite of what the whole design
     * predicts and is what exposed this.
     *
     * The cause is that the output of a band-pass is not the shape of its input.
     * The shaper's output is bounded — it is a saturator — but a kick drum
     * through a 165-700 Hz window is a decaying burst that RINGS, and the
     * measured crest factor was 3.2 against the bass path's 2.2 after its own
     * ceiling. Those spikes land on the kick, which is exactly when the record is
     * already loudest, so they were the most expensive energy in the entire
     * design.
     *
     * BEFORE the low-pass rather than after it, which is the whole reason this
     * needs no filter of its own: a ceiling generates harmonics, and putting it
     * here means the 700 Hz corner that was already required is also the guard
     * against them.
     */
    const harmCeil = ctx.createWaveShaper();
    harmCeil.curve = softCeilingCurve(TUNING.harmCeiling);
    harmCeil.oversample = 'none';
    const harmLp2 = ctx.createBiquadFilter();
    harmLp2.type = 'lowpass';
    harmLp2.frequency.value = TUNING.harmHigh;
    harmLp2.Q.value = 0.5;
    const harmGain = ctx.createGain();
    harmGain.gain.value = 0;
    musicTrim.connect(harmHp).connect(harmLp).connect(harmDrive).connect(harmShape);
    harmShape.connect(harmHp2).connect(harmHp3).connect(harmCeil);
    harmCeil.connect(harmLp2).connect(harmGain).connect(target);

    /**
     * ---- the microscope -----------------------------------------------------
     *
     * See SCOPE_BANDS above for why there are four and why their rates are what
     * they are. Each band's gain is a fixed 0.5 with an LFO of depth 0.5 summed
     * onto it, so it travels the full 0..1 and spends real time at each end —
     * a band that only ever varies between 0.6 and 1.0 is a tremolo, and the
     * whole point is that parts of the record genuinely go away for a while and
     * come back with your attention on them.
     *
     * AN AudioParam SUMS ITS CONNECTIONS ONTO ITS VALUE rather than replacing
     * it, which is what makes offset-plus-depth work without a second node. It
     * is also why `scopeBus` has to be the thing that gates the layer: writing
     * these gains to zero would fight four oscillators that are still driving
     * them, and the layer would breathe quietly on forever after the trip ended.
     */
    const scopeBus = ctx.createGain();
    scopeBus.gain.value = 0;
    scopeBus.connect(target);
    const scope = [];
    const scopeOscillators = [];
    for (let i = 0; i < SCOPE_BANDS.length; i++) {
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = SCOPE_BANDS[i];
      band.Q.value = 1.1;
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = TUNING.scopeRate * SCOPE_RATES[i];
      const depth = ctx.createGain();
      depth.gain.value = 0.5;
      lfo.connect(depth).connect(gain.gain);
      const pan = ctx.createStereoPanner();
      pan.pan.value = SCOPE_PANS[i];
      musicTrim.connect(band).connect(gain).connect(pan).connect(scopeBus);
      lfo.start();
      scope.push({ band, gain, lfo, depth, pan, rate: SCOPE_RATES[i] });
      scopeOscillators.push(lfo);
    }

    /**
     * ---- the record grows voices --------------------------------------------
     *
     * The same three resonators the wind already feeds — see `_buildVoices`'s
     * note in `build` — given a second input. Auditory misinterpretation is
     * reported about music at least as often as about running water, and it
     * needs no new machinery at all: three connections into filters that are
     * already there, already pitched from the drone's scale, already fading in
     * over four seconds and out over six.
     *
     * BAND-LIMITED FIRST, 250 Hz TO 2 kHz. Below that the bass would drive a
     * Q = 26 resonator hard enough to ring audibly on every kick, which is a
     * boing and not a voice. Above it there is nothing but cymbals, and a
     * resonator fed cymbals is a tuned hiss.
     *
     * The murmur gain nodes downstream are shared, so this rides the same
     * arrival-and-departure schedule the wind voices do. What changes is only
     * WHAT the resonators are made of — and on a passage where the record is
     * busy, the same filter that was producing a breathy near-pitch out of noise
     * starts producing one out of the music.
     */
    const murmurFeedHp = ctx.createBiquadFilter();
    murmurFeedHp.type = 'highpass';
    murmurFeedHp.frequency.value = 250;
    murmurFeedHp.Q.value = 0.6;
    const murmurFeedLp = ctx.createBiquadFilter();
    murmurFeedLp.type = 'lowpass';
    murmurFeedLp.frequency.value = 2000;
    murmurFeedLp.Q.value = 0.5;
    const murmurFeed = ctx.createGain();
    murmurFeed.gain.value = 0;
    musicTrim.connect(murmurFeedHp).connect(murmurFeedLp).connect(murmurFeed);
    for (const m of murmurs) murmurFeed.connect(m.band);

    /**
     * ---- the shimmer --------------------------------------------------------
     *
     * TWO TAPS, NO FEEDBACK, NOTHING BELOW 1.8 kHz, and each of those three is a
     * standing rejection in this project written as a number.
     *
     * No feedback, because a delay with feedback is a recursion and this file's
     * whole argument against comb banks and resonant filter sweeps applies
     * unchanged: a structure that can accumulate is one bad parameter from
     * self-oscillating, and the complaint that started the rewrite was a buzz.
     * Two taps give the sense of more going on in there and cannot build.
     *
     * Nothing below 1.8 kHz, because a broadband delay behind a record is fog,
     * and this project has arrived at fog twice by two different routes already.
     * Up here the material is transient and sparse — cymbals, consonants, pick
     * noise, the edge of a snare — which is what any time-domain effect has
     * always wanted.
     *
     * CROSS-PANNED HARD, and the taps at 1 : 1.6 rather than 1 : 2. An octave
     * relationship between two delay times makes the second tap land on the
     * beat the first one implies, which reads as rhythm; an irrational-ish ratio
     * reads as space. The second is quieter, so the pair has a direction.
     *
     * 105 ms IS PAST THE ECHO THRESHOLD ON PURPOSE. Under about 30 ms this stops
     * being two taps and becomes comb filtering — the top end goes metallic and
     * fixed, which is exactly the "compressed" quality the cabinet work spent so
     * long removing. The slider goes down there so you can hear it happen.
     */
    const shimHp = ctx.createBiquadFilter();
    shimHp.type = 'highpass';
    shimHp.frequency.value = 1800;
    shimHp.Q.value = 0.6;
    const shimBus = ctx.createGain();
    shimBus.gain.value = 0;
    shimBus.connect(target);
    musicTrim.connect(shimHp);
    const shimTaps = [];
    for (const [mult, level, panTo] of [
      [1, 1, -0.78],
      [1.6, 0.68, 0.78],
    ]) {
      // 1 s of line for a control that stops at 400 ms × 1.6 — a DelayNode's
      // maximum is fixed at construction and cannot be raised later, so the
      // headroom is free and the alternative is a slider that silently clamps.
      const delay = ctx.createDelay(1);
      delay.delayTime.value = (TUNING.shimmerTime / 1000) * mult;
      const gain = ctx.createGain();
      gain.gain.value = level;
      const pan = ctx.createStereoPanner();
      pan.pan.value = panTo;
      shimHp.connect(delay).connect(gain).connect(pan).connect(shimBus);
      shimTaps.push({ delay, gain, pan, mult });
    }

    return {
      scopeBus,
      scope,
      scopeOscillators,
      murmurFeedHp,
      murmurFeedLp,
      murmurFeed,
      shimHp,
      shimBus,
      shimTaps,
      hallHp,
      hallLp,
      hallVerb,
      hallWet,
      lowHp,
      lowLp,
      lowGain,
      bassSum,
      bassShape,
      bassGuard,
      subHp,
      subLp,
      subDc,
      subGain,
      subNode: null,
      harmHp,
      harmLp,
      harmDrive,
      harmShape,
      harmHp2,
      harmHp3,
      harmCeil,
      harmLp2,
      harmGain,
      musicTrim,
    };
  }

  /**
   * Push the tuning into the nodes that only get written once.
   *
   * The four level knobs need nothing from here — `update` reads them straight
   * off `TUNING` on every frame — but a filter corner, a drive and two transfer
   * curves are set at build time and would otherwise ignore a slider until the
   * next trip. Called once from `_buildMusic` so the graph is born correct, and
   * again from a subscription for as long as it lives.
   *
   * RAMPED, LIKE EVERY OTHER PARAMETER WRITE IN THIS FILE. A biquad recomputes
   * its coefficients from `frequency`, and a step change in them is a click —
   * which, dragged, is a click per input event.
   */
  _applyTuning(n) {
    const ctx = this.ctx;
    if (!n || !ctx) return;
    const now = ctx.currentTime;
    n.lowLp.frequency.setTargetAtTime(TUNING.lowCorner, now, 0.02);
    n.hallHp.frequency.setTargetAtTime(TUNING.hallLow, now, 0.02);
    n.harmHp2.frequency.setTargetAtTime(TUNING.harmLow, now, 0.02);
    n.harmHp3.frequency.setTargetAtTime(TUNING.harmLow, now, 0.02);
    n.harmLp2.frequency.setTargetAtTime(TUNING.harmHigh, now, 0.02);
    n.harmDrive.gain.setTargetAtTime(TUNING.harmDrive, now, 0.02);
    /**
     * The microscope's four rates and the shimmer's two taps, both of which are
     * written once at build time and would otherwise ignore a slider until the
     * next trip.
     *
     * A DELAY TIME IS THE ONE PARAMETER IN THIS FILE WHERE A RAMP IS AUDIBLE AS
     * SOMETHING OTHER THAN A CLICK. Sliding a delay line resamples what is
     * already in it, which is a pitch bend — dragging this slider makes the
     * shimmer swoop. That is correct and is not worth designing away: the
     * alternative is a step change, which on a buffer full of cymbals is a
     * tear. 0.05 is slow enough not to tear and fast enough to feel connected
     * to the hand.
     */
    for (const s of n.scope) {
      s.lfo.frequency.setTargetAtTime(TUNING.scopeRate * s.rate, now, 0.05);
    }
    for (const t of n.shimTaps) {
      t.delay.delayTime.setTargetAtTime((TUNING.shimmerTime / 1000) * t.mult, now, 0.05);
    }
    /**
     * The curves are lookup tables rather than parameters, so there is nothing
     * to ramp and nothing to click — a `WaveShaper` keeps no state between
     * samples, which is the same property that makes it usable in a parallel
     * path at all.
     *
     * Rebuilt only when the number actually moved. This runs on every slider
     * event, and two four-thousand-point tables per event is a lot of garbage to
     * produce in order to write the values that are already there.
     */
    if (this._bassK !== TUNING.bassCeiling) {
      this._bassK = TUNING.bassCeiling;
      n.bassShape.curve = softCeilingCurve(TUNING.bassCeiling);
    }
    if (this._harmK !== TUNING.harmCeiling) {
      this._harmK = TUNING.harmCeiling;
      n.harmCeil.curve = softCeilingCurve(TUNING.harmCeiling);
    }
  }

  /**
   * Splice the octave divider in, if this browser has one and if it loads.
   *
   * ASYNCHRONOUS AND ENTIRELY OPTIONAL, which is the only reason a worklet is
   * acceptable in a file whose central promise is that it cannot break the
   * game. `addModule` is a network fetch and a compile; it can fail on an old
   * Safari with no `audioWorklet` at all, on a stale service worker, on a
   * hosting setup that rewrites unknown paths. Every one of those outcomes ends
   * with `subLp` connected to nothing and `subGain` fed by nothing, which is
   * silence in one layer of one effect. `build()` does not await this and does
   * not care whether it succeeds.
   *
   * The module is fetched once per context and the promise is shared: `build()`
   * runs again after a `dispose()`, and two concurrent `addModule` calls for the
   * same URL are wasteful rather than harmful, but the failure path has to clear
   * the cache or a single transient network error would disable the sub for the
   * rest of the session.
   */
  async _attachSub(ctx, nodes) {
    if (!ctx.audioWorklet) return;
    try {
      if (!TripAudio._subModule) {
        TripAudio._subModule = ctx.audioWorklet.addModule(
          `${import.meta.env.BASE_URL}audio/sub-bass-processor.js`
        );
      }
      await TripAudio._subModule;
      // `dispose()` may have run while that was in flight, in which case these
      // nodes are no longer the live ones and connecting them would build half
      // a graph nobody owns.
      if (this.nodes !== nodes) return;
      const node = new AudioWorkletNode(ctx, 'sub-bass', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      nodes.subLp.connect(node);
      node.connect(nodes.subDc);
      nodes.subNode = node;
    } catch {
      TripAudio._subModule = null;
    }
  }

  /** Start an epoch. The drone's key comes from the seed. */
  begin(seed) {
    if (!this.build()) return;
    if (this._seed === seed && this.nodes.voices.length) return;
    this._seed = seed;
    this._stopVoices();

    const ctx = this.ctx;
    const rng = makeRng(`${seed}:drone`);
    const scale = SCALES[Math.floor(rng() * SCALES.length) % SCALES.length];
    this._scale = scale;
    const root = rngRange(rng, 52, 74);
    this._root = root;

    for (let i = 0; i < 5; i++) {
      const ratio = scale[i % scale.length] * (i >= scale.length ? 2 : 1);
      const osc = ctx.createOscillator();
      // Sine for the low voices, triangle higher up. A triangle's harmonics fall
      // off as 1/n², so even the brightest voice here has almost nothing above
      // the fifth partial — which is why this drone reads as warm rather than as
      // an electrical hum.
      osc.type = i < 2 ? 'sine' : 'triangle';
      osc.frequency.value = root * ratio;
      osc.detune.value = rngRange(rng, -7, 7);

      const gain = ctx.createGain();
      const level = 0.16 / (1 + i * 0.5);
      gain.gain.value = level;

      const lfo = ctx.createOscillator();
      const lfoDepth = ctx.createGain();
      lfo.frequency.value = rngRange(rng, 0.017, 0.085);
      lfoDepth.gain.value = level * 0.75;
      lfo.connect(lfoDepth).connect(gain.gain);

      const panner = ctx.createStereoPanner();
      panner.pan.value = rngRange(rng, -0.85, 0.85);
      // Each voice drifts across the stereo field on its own slow cycle, so the
      // chord never settles into a fixed image.
      const panLfo = ctx.createOscillator();
      const panDepth = ctx.createGain();
      panLfo.frequency.value = rngRange(rng, 0.011, 0.04);
      panDepth.gain.value = rngRange(rng, 0.2, 0.5);
      panLfo.connect(panDepth).connect(panner.pan);

      osc.connect(gain).connect(panner).connect(this.nodes.droneBus);
      osc.start();
      lfo.start();
      panLfo.start();
      this.nodes.voices.push({ osc, lfo, panLfo, gain, panner, lfoDepth, panDepth });
    }
  }

  /** One bell from the drone's scale, thrown into the reverb. */
  _spark(strength) {
    const ctx = this.ctx;
    /**
     * A BELL WITH NO LEVEL IS NOT A QUIET BELL, IT IS A THROWN EXCEPTION.
     *
     * The envelope below is exponential, because a bell's is, and an exponential
     * ramp to exactly zero is not a curve — `exponentialRampToValueAtTime`
     * rejects any target inside ±1.4e-45 and throws a DOMException instead. So
     * `sparkMax` at 0, which is the bottom of its own slider and is what the
     * `none` and near-silent presets ask for, turned every scheduled spark into
     * a red line in the console, several a second, for as long as the trip ran.
     *
     * Returning early is the whole fix, and it is the right one rather than a
     * clamp to 0.0001: a spark at a millionth of full scale is inaudible, and it
     * still allocates four nodes, starts two oscillators and keeps them alive for
     * up to four and a half seconds. Silence should cost nothing.
     */
    if (!(TUNING.sparkMax * strength > 0)) return;
    const rng = makeRng(`${this._seed}:${Math.floor(ctx.currentTime * 13)}`);
    const t = ctx.currentTime + 0.02;
    const octave = 2 ** (2 + Math.floor(rng() * 2));
    const f = this._root * this._scale[Math.floor(rng() * this._scale.length)] * octave;

    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = f;
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    // An inharmonic ratio gives it the shimmer of struck metal, and the index
    // envelope means it ends as a pure tone rather than as a clang.
    mod.frequency.value = f * 5.43;
    const modGain = ctx.createGain();
    const decay = rngRange(rng, 1.8, 4.5);
    modGain.gain.setValueAtTime(f * 3.2, t);
    modGain.gain.exponentialRampToValueAtTime(f * 0.01, t + decay * 0.4);
    mod.connect(modGain).connect(carrier.frequency);

    const env = ctx.createGain();
    const peak = TUNING.sparkMax * strength * rngRange(rng, 0.5, 1);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(peak, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t + decay);

    const pan = ctx.createStereoPanner();
    pan.pan.value = rngRange(rng, -0.95, 0.95);

    carrier.connect(env).connect(pan).connect(this.nodes.sparkBus);
    carrier.start(t);
    mod.start(t);
    carrier.stop(t + decay + 0.1);
    mod.stop(t + decay + 0.1);
    carrier.onended = () => {
      try {
        mod.disconnect();
        modGain.disconnect();
        env.disconnect();
        pan.disconnect();
      } catch {
        /* already gone */
      }
    };
  }

  /**
   * Per-frame levels.
   *
   * Every write is a `setTargetAtTime` ramp. A direct assignment to an audio
   * parameter is a discontinuity, a discontinuity is a click, and a click on
   * every animation frame is a buzz at the frame rate — which is one of the
   * ways the previous version earned its complaint.
   */
  update(dt, { intensity = 0, dissolve = 0, breath = 0, phase = '', transient = 0 } = {}) {
    if (!this.built) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const strength = clamp01(intensity);

    const n = this.nodes;

    /**
     * ---- the bloom ---------------------------------------------------------
     *
     * THE TAIL SWELLS AFTER THE SOUND, NOT WITH IT.
     *
     * Auditory distortion is described with unusual precision and it is not
     * what a reverb normally does: echoes and murmurs rise IN THE WAKE of each
     * sound. A reverb tail decays from the onset; this one grows from it, a
     * second or so late, and that lag is the entire effect. It is why a stick
     * cracking underfoot on mushrooms is unsettling rather than merely wet —
     * the room answers you slightly too late and slightly too much.
     *
     * `transient` is the engine's attack detector, the same number the visuals
     * take their flicker from, so the sound and the light are answering the
     * same event. It is charged through a lag of about a second and a half and
     * released over three or four, which is the shape described; a fast release
     * would be a ducker and would read as compression.
     *
     * On the send's WET level and nothing else. The dry path is untouched, so
     * the worst this can do is be a louder or quieter tail — it cannot smear an
     * attack, cannot pump the mix, and cannot arrive at all when the send is
     * closed.
     */
    /**
     * A DEVIATION ABOVE THE RECENT NORM, NOT AN ABSOLUTE LEVEL.
     *
     * `transient` is a fast-rise slow-fall attack detector on the whole mix, so
     * against a forest it spends most of its time near zero and spikes when
     * something happens — which is what the paragraphs above assume. Against a
     * record with a kick drum in it, it never comes down: it re-triggers twice a
     * second and `_bloom` charges to near 1 and simply stays there. The wet gain
     * then sat at 0.72 + 0.5 = 1.22 continuously instead of resting at 0.72 and
     * rising after events, which turned "the room answers you slightly too late"
     * into "the room is always at maximum". The effect this comment describes so
     * carefully was the first casualty of the thing it was measured against.
     *
     * So the bloom is now the amount by which this moment exceeds the last
     * twenty seconds. A quiet wood with one crack in it: `_bloomBed` is near
     * zero, the crack is a full bloom, unchanged. A record: `_bloom` and
     * `_bloomBed` sit together and the bloom is near zero, so the tail rests at
     * the level it was tuned at and still surges when something genuinely
     * louder than the music happens.
     */
    this._bloom += (clamp01(transient) - this._bloom) * Math.min(1, dt * 0.7);
    this._bloomBed += (this._bloom - this._bloomBed) * Math.min(1, dt * 0.05);
    const bloom = clamp01(this._bloom - this._bloomBed) * strength;
    // The space opens early and closes last: it is the first thing you notice,
    // long before anything looks different, and it outlasts the visuals, which
    // gives the comedown somewhere to land.
    /**
     * The wet rises FURTHER than the dry world falls, and that pair is the
     * distance cue — see `worldWet` in tuning.js and the `recede` note in
     * engine.js. This send is fed from `trims.world`/`trims.sfx` upstream of the
     * recession, so it is unaffected by the ducking below and the ratio moves
     * the whole way.
     */
    n.wet.gain.setTargetAtTime(
      strength * 0.72 * (1 + (TUNING.worldWet - 1) * strength) + bloom * 0.5,
      now,
      1.4
    );
    n.send.gain.setTargetAtTime(strength > 0.004 ? 0.62 : 0, now, 1.4);
    n.tilt.frequency.setTargetAtTime(1100 + strength * 4200, now, 2.2);

    /**
     * ---- the world steps back ----------------------------------------------
     *
     * The only place in this file that turns something DOWN, and the reason the
     * rest of it is audible at all. Everything else here is a send into a
     * limiter that was already close to its threshold; until something made
     * room, adding layers only bought gain reduction.
     *
     * THE LOW-PASS INTERPOLATES GEOMETRICALLY, not linearly. Pitch is
     * logarithmic, so a linear sweep from 20 kHz to 1.5 kHz spends its first
     * half moving through the top two octaves — where there is almost nothing
     * and nothing is audible — and does the entire perceptible journey in its
     * last few percent. Raised to a power, the corner falls at a constant number
     * of octaves per unit of intensity, which is the rate an ear reads as even.
     *
     * SLOW, AND SLOWER THAN THE LAYERS THAT REPLACE IT. 2.6 s against the
     * cosmos send's 1.4: the world should always be receding slightly behind
     * whatever is arriving, so there is no instant at which something has gone
     * and nothing has taken its place.
     */
    const rec = this.engine.recede;
    if (rec) {
      rec.gain.gain.setTargetAtTime(1 - strength * clamp01(TUNING.worldDuck), now, 2.2);
      rec.lp.frequency.setTargetAtTime(
        20000 * Math.pow(Math.max(20, TUNING.worldFar) / 20000, strength),
        now,
        2.6
      );
      rec.carve.gain.setTargetAtTime(-TUNING.worldCarve * strength, now, 2.2);
      rec.carve.frequency.setTargetAtTime(TUNING.worldCarveAt, now, 0.4);
    }

    // The drone stays under everything and only really arrives past the onset.
    n.droneBus.gain.setTargetAtTime(Math.max(0, strength - 0.24) * TUNING.droneMax, now, 2.2);

    // Breath: the audible half of the visual breathing, in antiphase with the
    // filter sweep so an inhale is darker and quieter and the release opens up.
    const breathLevel = clamp01(strength - 0.12) * (0.5 + breath * 0.5) * TUNING.breathMax;
    n.breathBus.gain.setTargetAtTime(breathLevel, now, 0.6);
    n.breathTone.frequency.setTargetAtTime(280 + (breath * 0.5 + 0.5) * 900, now, 0.8);

    n.sparkBus.gain.setTargetAtTime(strength, now, 1.5);
    this._nextSpark -= dt * (0.2 + strength * 1.5);
    if (this._nextSpark <= 0 && strength > 0.18) {
      this._spark(strength);
      this._nextSpark = rngRange(makeRng(`spark:${Math.floor(now * 7)}`), 1.6, 7) * (1.3 - strength * 0.6);
    }

    /**
     * ---- the voices --------------------------------------------------------
     *
     * Late, and not before. Each layer in this file arrives at its own
     * threshold rather than all of them fading up together on one knob, because
     * effects that arrive in sequence read as a progression and effects that
     * arrive at once read as a wet/dry control. The space is there from the
     * first minute; this is a peak phenomenon and starts at 0.45.
     *
     * At most two of the three sound at any moment, and each holds its pitch
     * for eight to twenty seconds before going away. What makes it a voice
     * rather than a note is that it is never quite in tune with attention: it
     * has already been there for several seconds by the time you notice it, and
     * it leaves over six more.
     */
    const voice = clamp01((strength - 0.45) / 0.55);
    n.voiceBus.gain.setTargetAtTime(voice * TUNING.voiceMax, now, 3.0);
    /**
     * The record into the same resonators, on the same schedule. Slower than
     * the bus it feeds — 4 s against 3 — because this one changes what the
     * voices are MADE of, and a material that swaps over in the same breath as
     * the level is a switch rather than a transformation.
     */
    n.murmurFeed.gain.setTargetAtTime(voice * TUNING.murmurMusic, now, 4.0);
    if (voice > 0.02) {
      let lit = 0;
      for (const m of n.murmurs) if (m.on) lit++;
      for (let i = 0; i < n.murmurs.length; i++) {
        const m = n.murmurs[i];
        if (now < m.until) continue;
        if (m.on) {
          m.on = false;
          m.gain.gain.setTargetAtTime(0, now, 2.0);
          m.until = now + rngRange(makeRng(`hush:${i}:${Math.floor(now)}`), 5, 17);
          lit--;
          continue;
        }
        if (lit >= 2) continue;
        const rng = makeRng(`${this._seed}:murmur:${i}:${Math.floor(now / 7)}`);
        // From the drone's own scale, two or three octaves up, so a murmur is
        // consonant with the bed it comes out of. Capped under 900 Hz — see the
        // note on audio-probe where these are built.
        const f = Math.min(
          880,
          this._root * this._scale[Math.floor(rng() * this._scale.length)] * 2 ** (1 + Math.floor(rng() * 2))
        );
        m.band.frequency.setTargetAtTime(f, now, 1.1);
        m.pan.pan.setTargetAtTime(rngRange(rng, -0.8, 0.8), now, 2.0);
        m.gain.gain.setTargetAtTime(rngRange(rng, 0.5, 1.0), now, 1.4);
        m.on = true;
        m.until = now + rngRange(rng, 8, 20);
        lit++;
      }
    } else {
      for (const m of n.murmurs) {
        if (!m.on) continue;
        m.on = false;
        m.until = 0;
        m.gain.gain.setTargetAtTime(0, now, 1.5);
      }
    }

    /**
     * ---- the two music detail layers ---------------------------------------
     *
     * EACH AT ITS OWN THRESHOLD, like everything else in this file. The shimmer
     * is the earlier of the two at 0.2 — it is only air around the top of the
     * record and reads as the room getting slightly more interesting. The
     * microscope waits until 0.3, because a record whose bands are swimming is
     * unmistakably something being done to it, and at the come-up the brief is
     * "something is slightly different" rather than "something is happening to
     * the music".
     *
     * Long ramps on both. These are gates on layers that are already moving on
     * their own — four LFOs and two delay lines — so anything fast here would
     * be a second modulation on top of the first, and two rates on one signal
     * is where a texture becomes an effect.
     */
    const shimmer = clamp01((strength - 0.2) / 0.8);
    n.shimBus.gain.setTargetAtTime(shimmer * TUNING.shimmerMax, now, 2.4);
    const scope = clamp01((strength - 0.3) / 0.7);
    n.scopeBus.gain.setTargetAtTime(scope * TUNING.scopeMax, now, 3.2);

    const pulse = clamp01(dissolve) * TUNING.pulseMax;
    n.pulseDepth.gain.setTargetAtTime(pulse, now, 0.6);
    n.pulseOsc.frequency.setTargetAtTime(36 + clamp01(dissolve) * 14, now, 1.2);

    /**
     * ---- the record's hall, and its weight ---------------------------------
     *
     * NO BLOOM ON THE HALL, deliberately, and it is not an oversight. The bloom
     * is a tail that answers a discrete event; a record has no gaps for it to
     * answer in, and the two paragraphs above are the story of what happens when
     * it is applied to one anyway. The music's space is a steady room that gets
     * larger as the trip does, and nothing more.
     *
     * 0.95, WHICH IS HIGHER THAN THE COSMOS SEND AND STILL A QUARTER OF THE
     * REVERB. Both halves of that are measured rather than judged.
     *
     * `record-space.mjs` reports the tail one second after the record stops, as
     * a fraction of what the cabinet was putting out — the old topology sat at
     * 59% at peak and 70% at ego death, which is not a space around the music
     * but a second blurred copy of it. The first version of this hall was set at
     * 0.34 and measured 5%, which fixed the complaint by very nearly deleting
     * the effect: a quarter of a decibel of room on a record that is supposed to
     * be having something done to it. The number that matters is neither of
     * those. It is somewhere around 15% — unmistakably a large room, and nowhere
     * near a second copy.
     *
     * That it takes a HIGHER send than cosmos to get there is the whole argument
     * for the band-limiting in one number. Almost all of this energy lands in
     * the mids, where a tail reads as a room; the old one spread the same energy
     * across the whole spectrum, where it read as fog.
     *
     * THE WEIGHT ARRIVES EARLY AND LEAVES LAST. It starts lifting from the first
     * moment of the come-up, well before the hall opens at all, because low end
     * is the part of this that is felt rather than heard and the body notices
     * before the ears do. `0.55 + breath * 0.45` means it never drops out — the
     * floor is most of the way up and the breath is a swell on top, not a
     * tremolo.
     *
     * 0.7 s OF SMOOTHING, AND IT WAS 6.0 FIRST, WHICH SILENTLY DELETED THE
     * BREATH. The reasoning for the long one was "bass that moves quickly is a
     * pump" — true of an envelope follower on audio, and irrelevant here,
     * because nothing fast ever reaches this line. `strength` and `breath` are
     * both smooth per-frame quantities; there is no transient in the control
     * signal for a long time constant to protect against, so all it can do is
     * lag. The breath is a sine every 8.7 seconds (`state.js`), and a one-pole
     * at 6 s takes 13 dB off a 0.115 Hz signal and delays what survives by most
     * of a quarter cycle. The swell this paragraph describes was down to a
     * fifth of its amplitude and arriving two seconds late. At 0.7 s it keeps
     * 89% of it, and is still far too slow to zipper on frame jitter.
     */
    n.hallWet.gain.setTargetAtTime(strength * TUNING.hallMax, now, 2.6);
    const weight = strength * (0.55 + breath * 0.45);
    this.weight = weight;
    n.lowGain.gain.setTargetAtTime(weight * TUNING.lowMax, now, 0.7);
    /**
     * The sub arrives LATER than the shelf and that is the point of the 0.35.
     *
     * The shelf is an EQ move: it is the same record, weighted differently, and
     * it can be there from the first minute without anything sounding odd. The
     * sub is a note that is not in the recording. Fading it in over the first
     * third of the trip means the bottom of the music keeps dropping away as the
     * level climbs, which is a thing that happens rather than a setting that is
     * on — and at the come-up, where the effect is meant to be "something is
     * slightly different", an octave appearing under the bass is far too large a
     * gesture.
     */
    n.subGain.gain.setTargetAtTime(clamp01((strength - 0.12) / 0.35) * weight * TUNING.subMax, now, 0.9);
    /**
     * The harmonics arrive with the shelf rather than with the sub, on the same
     * breath and the same early threshold.
     *
     * They are an EQ move in the way the shelf is: everything they add was
     * implied by the record already, so there is no moment at which something
     * appears that was not there. The sub is the one that needs easing in,
     * because a manufactured octave IS a new note.
     */
    n.harmGain.gain.setTargetAtTime(weight * TUNING.harmMax, now, 0.7);

    // Ego death opens the tail all the way: the space stops having a colour.
    if (phase === 'egodeath') {
      n.tilt.frequency.setTargetAtTime(7600, now, 1.6);
      // The record's hall opens with it, to 9 kHz. These two numbers were left
      // at 2.4 and 3.6 kHz when the hall was rebuilt as a high-band send, which
      // put a low-pass BELOW the high-pass feeding it: the two filters were
      // fighting over a band an octave wide and the reverb had almost nothing
      // to work with. The measurement caught it — a tail at one percent of the
      // record — and the node readout in `record-space.mjs` named it, because
      // it prints the corner frequencies rather than only the gains.
      n.hallLp.frequency.setTargetAtTime(11000, now, 2.0);
    } else {
      n.hallLp.frequency.setTargetAtTime(9000, now, 2.0);
    }
  }

  end() {
    if (!this.built) return;
    const now = this.ctx.currentTime;
    for (const key of [
      'wet',
      'send',
      'droneBus',
      'breathBus',
      'sparkBus',
      'voiceBus',
      'hallWet',
      'murmurFeed',
      'shimBus',
      'scopeBus',
    ]) {
      this.nodes[key].gain.setTargetAtTime(0, now, 1.1);
    }
    /**
     * GIVE THE WORLD BACK, and give it back more slowly than anything else here
     * lets go — 3.4 s against 1.1.
     *
     * `update` stops running the moment a trip ends, so this is the last word on
     * these three parameters until the next one begins. Forgetting the line
     * would not be silence in a layer, which is this file's usual worst case; it
     * would be a forest left permanently ducked and dull, with nothing in the
     * mix to explain why and no way to recover it short of a reload. It is the
     * one write in this class whose omission would outlive the effect.
     *
     * Slow because the world coming back is the last thing that happens in a
     * comedown and the one that says it is over. The layers go first, and then
     * the wood is simply there again.
     */
    this._releaseWorld(3.4);
    /**
     * The weight leaves more slowly than everything else, over about eight
     * seconds. It is the layer the body rather than the ear is holding on to,
     * and pulling it at the same rate as the reverb makes the comedown land as
     * a cut. `update` is not running while this decays — `end` is the last word
     * on these gains until the next trip begins.
     */
    this.nodes.lowGain.gain.setTargetAtTime(0, now, 2.6);
    // Harmonics leave with the shelf they belong to. Faster would separate the
    // two halves of one low end and the bass would appear to change character on
    // the way down rather than simply receding.
    this.nodes.harmGain.gain.setTargetAtTime(0, now, 2.6);
    // The manufactured octave goes faster than the shelf it sits under. It is
    // the one thing here that was never in the recording, so it is the one thing
    // whose absence returns the record to being itself.
    this.nodes.subGain.gain.setTargetAtTime(0, now, 1.4);
    for (const m of this.nodes.murmurs) {
      m.on = false;
      m.until = 0;
      m.gain.gain.setTargetAtTime(0, now, 1.1);
    }
    this.nodes.pulseDepth.gain.setTargetAtTime(0, now, 0.7);
    this._seed = '';
    const voices = this.nodes.voices.splice(0);
    setTimeout(() => {
      for (const v of voices) {
        try {
          v.osc.stop();
          v.lfo.stop();
          v.panLfo.stop();
          v.osc.disconnect();
          v.lfo.disconnect();
          v.panLfo.disconnect();
          v.gain.disconnect();
          v.panner.disconnect();
          v.lfoDepth.disconnect();
          v.panDepth.disconnect();
        } catch {
          /* already gone */
        }
      }
    }, 5000);
  }

  /**
   * The world recession, returned to transparent.
   *
   * Its nodes belong to `engine.js` and outlive this class, so every exit from a
   * trip has to come through here: `end`, `dispose`, and the director's audio
   * switch. Tolerant of a missing `recede` because the measuring harnesses build
   * partial engines.
   */
  _releaseWorld(tau) {
    const rec = this.engine?.recede;
    const ctx = this.ctx;
    if (!rec || !ctx) return;
    const now = ctx.currentTime;
    rec.gain.gain.setTargetAtTime(1, now, tau);
    rec.lp.frequency.setTargetAtTime(20000, now, tau);
    rec.carve.gain.setTargetAtTime(0, now, tau);
  }

  _stopVoices() {
    for (const v of this.nodes?.voices?.splice(0) ?? []) {
      try {
        v.osc.stop();
        v.lfo.stop();
        v.panLfo.stop();
      } catch {
        /* ignore */
      }
    }
  }

  dispose() {
    if (!this.built) return;
    this._unsubscribeTuning?.();
    this._unsubscribeTuning = null;
    this._stopVoices();
    // Immediately, not over seconds: a graph being torn down has no future in
    // which to finish a ramp, and leaving the wood ducked is the one failure
    // here that the player cannot undo.
    this._releaseWorld(0.01);
    for (const osc of [...this.nodes.oscillators, ...this.nodes.scopeOscillators]) {
      try {
        osc.stop();
      } catch {
        /* ignore */
      }
    }
    /**
     * Every tap this class made into the engine's graph, released.
     *
     * One `disconnect` per connection made in `build`/`_buildMusic`, each in its
     * own try: these are nodes owned by `engine.js` and a throw on any one of
     * them must not leave the rest attached. A missed line here is not a leak of
     * memory, it is a live send into a convolver whose owner believes it is
     * gone — silent, and audible only as a room that never quite closes.
     */
    for (const [node, to] of [
      [this.engine.trims.world, this.nodes.send],
      [this.engine.trims.sfx, this.nodes.send],
      [this.nodes.musicTrim, this.nodes.hallHp],
      [this.nodes.musicTrim, this.nodes.lowHp],
      [this.nodes.musicTrim, this.nodes.subHp],
      [this.nodes.musicTrim, this.nodes.harmHp],
      [this.nodes.musicTrim, this.nodes.murmurFeedHp],
      [this.nodes.musicTrim, this.nodes.shimHp],
      // One per band, and the loop above is why they are listed rather than
      // disconnected wholesale: `musicTrim.disconnect()` with no argument would
      // take the engine's own music path out with them.
      ...this.nodes.scope.map((s) => [this.nodes.musicTrim, s.band]),
    ]) {
      try {
        node.disconnect(to);
      } catch {
        /* ignore */
      }
    }
    /**
     * The worklet, if it ever arrived. Disconnected rather than left dangling:
     * an AudioWorkletNode with a live input keeps its `process` running on the
     * audio thread for the lifetime of the context, so a graph rebuilt a few
     * times would accumulate octave dividers all quietly analysing the same
     * bass line and outputting into nothing.
     */
    try {
      this.nodes.subNode?.disconnect();
    } catch {
      /* ignore */
    }
    this.nodes = null;
    this.built = false;
    void clamp;
  }
}
