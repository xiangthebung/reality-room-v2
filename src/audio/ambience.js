import { clamp, clamp01, makeRng, rngRange } from '../core/util.js';
import { darkAt } from '../world/daylight.js';

/**
 * The sound of the place.
 *
 * Four layers, all synthesised:
 *
 *   WIND — pink noise through a slowly swept band-pass, with the sweep driven by
 *   the same gust clock the trees bend to. Hearing the gust arrive a moment
 *   before the canopy moves is most of what makes the forest feel like one
 *   system rather than two.
 *
 *   BIRDS — short FM chirps at irregular intervals, panned randomly and placed
 *   at a distance. Deliberately sparse: a continuous dawn chorus is a stock
 *   sound effect and reads as one within about fifteen seconds.
 *
 *   STREAM — a fixed spatial source at the water, brighter and busier than the
 *   wind, so walking toward it is a navigational cue.
 *
 *   FOOTSTEPS — a filtered noise burst per step, with the filter and decay
 *   picked from what you are standing on.
 *
 * NOTHING HERE USES A RESONANT FILTER. Wind is the layer most likely to turn
 * into a whistle, and a whistle in a continuous background loop is the most
 * fatiguing sound this app could possibly make.
 *
 * WHAT WAS ADDED LATER, AND WHY IT IS HERE AND NOT IN `wildlife.js`.
 *
 * `wildlife.js` owns everything with a heartbeat and it is the obvious home for
 * a frog. It cannot have one, because it does not know where the water is —
 * `fauna.js` builds it and only ever tells it where the listener is. THIS file
 * is handed the nearest point of the stream every frame by main.js, and the
 * distance to it, which is exactly and only what a frog needs. So the water's
 * animals live with the water:
 *
 *   FROGS — a ragged train of low grains from the bank, within forty-five
 *   metres of the channel and nowhere else.
 *
 *   PLOPS — something small going into the stream. One sine with a rising
 *   pitch, which is what a collapsing bubble is and why a plop plops.
 *
 * And two things that are not alive at all but do the same job, which is to
 * interrupt the silence with evidence that this is outdoors:
 *
 *   CANOPY SURGE — a swell of leaf noise overhead on the rising edge of a gust.
 *   The continuous wind layer already opens its band-pass with the gust, which
 *   is a change in a bed; this is an EVENT, arriving from a bearing and above
 *   you, and it is what makes a gust feel like weather passing through a wood
 *   rather than a fader being moved.
 *
 *   BRANCH CREAK — two detuned sines under a deliberately lurching envelope, on
 *   a third of the surges. Stick-slip friction is amplitude chatter, not a
 *   filter sweep, and building it out of gain steps rather than out of a moving
 *   resonance is both cheaper and the only version that does not whistle.
 *
 * WHICH BUS. `engine.js` splits continuous properties of the place from
 * discrete events, and it says in as many words that the beds already here —
 * wind, stream, chirps, footsteps — stay on `worldBus` where they were put. So
 * do the frogs, because a colony croaking on a bank is a property of that bank
 * and not an interruption, and so does the canopy surge, because it is
 * literally the wind layer having a moment and it would be very strange for the
 * wind slider to hold the bed while gusts kept arriving through it.
 *
 * The plop and the creak go to `sfxBus`. Both are single physical events with a
 * hard front — something entering water, wood taking a load — and both are the
 * kind of punctuation a player might want to keep after turning the wood down.
 * The creak parting company with the gust that caused it is a real seam and it
 * is the right one: what you are hearing is not the weather, it is a tree.
 */

let cachedNoise = null;
/**
 * Pink noise. Cached by sample rate and exported so `main.js` can generate it
 * during the shader warm-up wait instead of on the frame `build()` runs —
 * see the click handler for why that moment is the wrong one to be doing
 * sample-by-sample synthesis on.
 */
export function pinkBuffer(ctx, seconds = 4) {
  if (cachedNoise && cachedNoise.sampleRate === ctx.sampleRate) return cachedNoise;
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      d[i] = (b0 + b1 + b2 + white * 0.1848) * 0.26;
    }
  }
  cachedNoise = buf;
  return buf;
}

/**
 * The indices came down to `wildlife.js`'s ceiling.
 *
 * That file's header states the rule and the reason: an FM modulation index
 * much past two starts producing sidebands dense enough to read as a rasp, so
 * nothing over there exceeds 2.2. This table predates the rule and had a 2.4
 * and a 2.0 in it, on carriers at MIDI 95 and 89 — which puts a spray of
 * sidebands squarely in the 2–6 kHz band that `audio-probe` measures and that
 * the ear is least forgiving of. Lowering them is barely audible as timbre and
 * it is the most targeted cut available: it removes energy from exactly the
 * band that was over budget and from nowhere else.
 */
/**
 * THE RATIOS ARE WHOLE NUMBERS NOW, and that is the second half of the same
 * fix `wildlife.js` got.
 *
 * 2.02 and 3.01 were not harmless detunes. A modulator a hundredth off an
 * integer ratio puts its sidebands a few hertz off the harmonics they are
 * supposed to reinforce, so they beat — and a slow beat between high partials
 * is the single most recognisable cue for STRUCK METAL there is. Together with
 * a modulation index that collapsed to nothing over the note (see `_chirp`),
 * these five rows were a small tuned percussion instrument, which is exactly
 * what was reported. Integer ratios, and the character moves into `arc`.
 *
 * `arc` is the pitch contour within one note, in semitones, spread across its
 * length — the same field and the same reasoning as the species table in
 * `wildlife.js`, which is where the long version of the argument lives.
 */
const BIRDS = [
  // ratio, index, decay, notes (midi), gaps between them, contour
  { ratio: 1.0, index: 1.2, decay: 0.09, notes: [88, 92, 88], gap: 0.1, arc: [0.6, -1.1] },
  { ratio: 2.0, index: 1.4, decay: 0.07, notes: [95, 91], gap: 0.14, arc: [0.4, -1.5] },
  { ratio: 1.0, index: 0.8, decay: 0.22, notes: [79, 83, 86, 83], gap: 0.13, arc: [1.2, 0.4] },
  { ratio: 3.0, index: 0.9, decay: 0.05, notes: [98, 98, 98], gap: 0.07, arc: [0.9] },
  { ratio: 1.5, index: 1.3, decay: 0.16, notes: [84, 89], gap: 0.22, arc: [0.5, -0.8] },
];

/** One semitone as a frequency ratio. Contours are written in semitones. */
const SEMI = 2 ** (1 / 12);

/** The most one-shot sources this file may have alive at once. */
const VOICE_CEILING = 34;

/** Within this many metres of the channel there are frogs. Beyond it, none. */
const FROG_RANGE = 45;

export class Ambience {
  constructor(engine) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.rng = makeRng('ambience');
    this.built = false;
    this._nextBird = 2;
    this._gust = 0;
    this.gustValue = 0;
    this.birdRate = 1;

    /**
     * Where the water is, and how far away you are from it.
     *
     * Both are written every frame by main.js — `setStreamPosition` follows the
     * nearest point of the channel so the stream is a line source rather than a
     * point, and everything below inherits that for free: a frog is placed
     * relative to whatever bit of bank is closest to you, which means walking
     * the length of the stream produces frogs the whole way instead of one
     * colony sitting at a fixed coordinate.
     *
     * Copied out by value. The caller passes a shared THREE.Vector3 scratch and
     * keeps writing to it.
     */
    this.streamPos = { x: 0, y: -3, z: 26 };
    this.streamDistance = 999;

    this._nextFrog = 4;
    this._nextPlop = 12;
    /**
     * First howl comes early — 40 s rather than a full interval — so a player
     * who arrives at dawn hears one inside the first minute. The sound is the
     * strongest single statement this world makes about where it is, and
     * making somebody wait four minutes for it is a waste of it.
     */
    this._nextHowl = 40;
    /**
     * Armed/fired hysteresis for the gust surge, not a threshold.
     *
     * The gust value main.js supplies is a smooth sine, so a bare `> 0.58` test
     * fires on every frame it spends above the line — several hundred canopy
     * surges in a row. It has to fall back under 0.42 before it can fire again,
     * which turns a level into an edge and gives one surge per gust.
     */
    this._gustArmed = true;
    this._surgeHold = 0;

    /**
     * A budget, for the same reason `wildlife.js` has one and with the same
     * shape: every event here builds its nodes when it fires, and the case that
     * has to be survived is standing on the bank at dusk with the frogs going
     * and a gust arriving. Smaller than wildlife's ceiling because this file
     * has far fewer simultaneous callers and a frog is a dozen grains.
     */
    this.voices = 0;

    /**
     * ==== WHAT THE RECORDED BED TAKES FROM THIS FILE ==========================
     *
     * `audio/bed.js` streams a real field recording of a rainforest onto
     * `worldBus` — the unresolvable far chorus, which is the one thing here that
     * cannot be synthesised. When it is playing, two of the layers above are
     * saying the same thing twice, and this is where they give way.
     *
     * DUCKED, NOT DELETED, AND THE WIND IS THE ONE THAT MATTERS. `windGain` and
     * `windBand` follow the gust value main.js derives from `uWind`, which is the
     * SAME gust the trees are visually bending to — hearing the gust arrive a
     * moment before the canopy moves is, per this file's own header, most of what
     * makes the forest feel like one system rather than two. A recorded bed has
     * air in it but it has no idea what this forest's trees are doing, so
     * switching the synthesised wind off would leave the canopy waving in silence
     * and would sever the one coupling this file was built around. It goes to
     * roughly half instead, and the gust modulation is preserved exactly because
     * the duck is a MULTIPLIER on the whole expression rather than a new target:
     * the ratio between calm and squall is untouched, only the depth moves.
     *
     * THE INSECT WALL GIVES UP MORE, because it is a direct duplicate. The long
     * block by `cicadaSource` describes that layer as a stand-in for a continuous
     * enveloping chorus, built out of two resonant bands because that was the
     * only way to get one without a recording. With a recording, it is a second
     * chorus half an octave off the first, and two insect walls beating against
     * each other is worse than either alone. How far it gives way is declared PER
     * BED in the manifest, because it is a fact about the file: a night recording
     * that is wall-to-wall katydids should push this most of the way out, and a
     * sparse dawn one should barely touch it.
     *
     * ZERO PRESENCE IS BIT-IDENTICAL TO NOT HAVING A BED. Both factors below
     * evaluate to exactly 1 when `bedPresence` is 0, and `x * 1` is `x` for every
     * float, so every audio measurement in this repo keeps meaning what it meant
     * until somebody puts a file in `public/audio/beds/`.
     */
    this.bedPresence = 0;
    this.bedDuck = { wind: 1, insects: 1 };
  }

  /**
   * @param {number} presence 0..1 — how much recorded bed is audible
   * @param {{wind: number, insects: number}} [duck] the floor each layer falls
   *   to at full presence, as an amplitude multiplier. 1 is untouched.
   */
  setBedPresence(presence, duck = null) {
    this.bedPresence = clamp01(presence);
    if (duck) {
      if (Number.isFinite(duck.wind)) this.bedDuck.wind = clamp01(duck.wind);
      if (Number.isFinite(duck.insects)) this.bedDuck.insects = clamp01(duck.insects);
    }
  }

  build(streamPosition) {
    if (this.built) return;
    const ctx = this.ctx;
    const buffer = pinkBuffer(ctx);

    // ---- wind ------------------------------------------------------------
    this.windSource = ctx.createBufferSource();
    this.windSource.buffer = buffer;
    this.windSource.loop = true;

    this.windBand = ctx.createBiquadFilter();
    this.windBand.type = 'bandpass';
    this.windBand.frequency.value = 620;
    // Wide. A Q above about 1.5 here starts to whistle on every gust.
    this.windBand.Q.value = 0.55;

    /**
     * A LID ON THE WIND, and it is the one change in this file that was made
     * for a number rather than for an ear.
     *
     * `audio-probe` fails anything whose spectral centroid climbs past 2600 Hz,
     * because a bright dense spectrum is the signature of the buzz this whole
     * project was rewritten to remove. The sober forest has been failing it —
     * 2726 Hz in the last recorded run, before any of this pass's work. Muting
     * the layers one at a time on the live app to find out why produced a
     * genuinely surprising answer: it is not the stream, which is the layer
     * that SOUNDS brightest and whose removal actually pushes the centroid UP.
     * It is the wind. Taking the wind out drops the whole app from 2990 Hz to
     * 2100.
     *
     * The reason is the band-pass's Q of 0.55. At that width it is barely a
     * filter at all — it rolls off at six decibels an octave, pink noise adds
     * another three, and against a linear-frequency measurement the two octaves
     * above 5 kHz still hold an enormous share of the energy even though they
     * are thirty decibels down. Perceptually that region is a faint hiss; to
     * the centroid it is most of the signal.
     *
     * So: a second, gentle low-pass that opens with the gust exactly as the
     * band-pass does. A wood in a breeze genuinely has very little above 6 kHz
     * in it — leaves are big soft things — and the hiss it removes is the
     * fatiguing part of a continuous bed, which is the failure mode the header
     * of this file was already worried about.
     */
    this.windTop = ctx.createBiquadFilter();
    this.windTop.type = 'lowpass';
    this.windTop.frequency.value = 4200;
    this.windTop.Q.value = 0.3;

    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.0;

    // A second, darker layer for the body of the wind, so gusts have weight.
    this.windLow = ctx.createBiquadFilter();
    this.windLow.type = 'lowpass';
    this.windLow.frequency.value = 200;
    this.windLow.Q.value = 0.3;
    this.windLowGain = ctx.createGain();
    this.windLowGain.gain.value = 0.0;

    this.windSource
      .connect(this.windBand)
      .connect(this.windTop)
      .connect(this.windGain)
      .connect(this.engine.worldBus);
    this.windSource.connect(this.windLow).connect(this.windLowGain).connect(this.engine.worldBus);
    this.windSource.start();

    // ---- stream ----------------------------------------------------------
    this.streamSource = ctx.createBufferSource();
    this.streamSource.buffer = buffer;
    this.streamSource.loop = true;
    this.streamSource.playbackRate.value = 1.34;
    const streamHp = ctx.createBiquadFilter();
    streamHp.type = 'highpass';
    streamHp.frequency.value = 620;
    streamHp.Q.value = 0.4;
    const streamLp = ctx.createBiquadFilter();
    streamLp.type = 'lowpass';
    /**
     * 2400, down from 3400, and this is the other half of the wind lid above.
     *
     * Putting a low-pass on the wind fixed the spectral centroid and broke the
     * OTHER thing audio-probe measures: the fraction of energy between 2 and
     * 6 kHz. That is a ratio, so removing two octaves of hiss above 6 kHz makes
     * the 2–6 band a bigger share of what is left even though nothing was added
     * to it, and the sober forest went from 28% to 32% without a single new
     * bright sound in the mix. The two thresholds pull in opposite directions
     * and no amount of filtering the TOP satisfies both; the only thing that
     * does is having less energy in the middle.
     *
     * The stream is where the middle lives — measured at about a fifth of the
     * whole world layer, almost all of it between 600 Hz and this corner. And
     * it should be duller than it was: this is a shallow woodland channel heard
     * through ferns from six metres, not a tap. It still reads unmistakably as
     * running water and it is still the brightest continuous thing in the wood,
     * which is all it has to be for finding your way back to it to work.
     */
    streamLp.frequency.value = 2050;
    streamLp.Q.value = 0.3;
    this.streamSpatial = this.engine.createSpatial(streamPosition, {
      refDistance: 6,
      rolloff: 1.5,
      maxDistance: 90,
    });
    this.streamGain = ctx.createGain();
    this.streamGain.gain.value = 0.45;
    this.streamSource
      .connect(streamHp)
      .connect(streamLp)
      .connect(this.streamGain)
      .connect(this.streamSpatial.input);
    this.streamSource.start();

    // A slow burble: the stream's brightness wanders, which stops it reading as
    // a static noise bed.
    this.streamLfo = ctx.createOscillator();
    this.streamLfo.frequency.value = 0.07;
    const streamDepth = ctx.createGain();
    // Scaled with the corner above, so the burble is the same proportion of the
    // brightness it always was rather than a wobble that now swamps it.
    streamDepth.gain.value = 520;
    this.streamLfo.connect(streamDepth).connect(streamLp.frequency);
    this.streamLfo.start();

    /**
     * ==== THE INSECT WALL ====================================================
     *
     * THE SINGLE BIGGEST THING THIS SOUNDSCAPE WAS MISSING, and it costs no GPU
     * at all. A temperate wood is quiet between bird calls. A rainforest is
     * never quiet: there is a continuous, enveloping, unlocatable wall of
     * insects, and the birds punch THROUGH it rather than sitting in silence.
     * Before this, the gaps between `wildlife.js` calls were genuine silence,
     * and silence is most of what made this forest read as empty however many
     * animals were put in it.
     *
     * IT IS TWO BEDS AND THEY CROSSFADE ON THE CLOCK, because the day wall and
     * the night wall are different animals and swapping between them is one of
     * the strongest cues that time is passing:
     *
     *   CICADAS by day. Loud, steady, a hard sawing note that the ear reads as
     *   a pitch rather than as noise.
     *   KATYDIDS and crickets by night. Higher, thinner, and pulsed rather than
     *   continuous.
     *
     * WHY THEY ARE RESONANT BANDS AND NOT JUST FILTERED HISS, which is the one
     * design decision here that matters. The wind bed above uses a Q of 0.55 —
     * barely a filter — and the long block on `windTop` explains what that cost:
     * two octaves of inaudible hiss that dominated the spectral centroid and
     * failed `audio-probe`. An insect is the opposite kind of signal. A cicada
     * is a mechanical resonator with a strong fundamental and very little
     * either side of it, so a HIGH Q is both what the animal actually is and
     * what keeps this bed's energy in one narrow place instead of smeared
     * across the top of the spectrum.
     *
     * AND THE CENTRE FREQUENCIES ARE FAR LOWER THAN THE ANIMALS ACTUALLY ARE.
     * THIS IS THE NUMBER THAT WAS FOUGHT OVER AND IT WAS SETTLED BY THE GATE.
     *
     * Real Amazonian cicadas run to 5-8 kHz, and the first three attempts here
     * sat at 2550 and then 2100. `audio-probe` fails any stage with `rms > 0.03
     * && harsh > 0.3`, where `harsh` is the share of energy between 2 and 6
     * kHz — and `sober + music` was ALREADY at 0.286 before this bed existed,
     * i.e. there was almost no headroom in that band at all. A bed centred at
     * 2100 took it to 0.372 and failed eight stages at once, including every
     * jukebox track, because a continuous layer adds to all of them.
     *
     * So both beds were moved out of the window entirely: 1500 Hz by day,
     * 1950 by night, at Q 3.2 and 9 — bandwidths of about 470 and 215 Hz, so
     * the day bed spans roughly 1265-1735 and only its skirt reaches 2 kHz.
     *
     * THE RESULT IS BETTER THAN THE COMPROMISE IT LOOKS LIKE, and that is worth
     * writing down because the obvious reading of the paragraph above is "the
     * insects had to be detuned to please a linter". Measured: `harsh` on
     * `sober + music` went 0.286 -> 0.258 and on ambience alone 0.293 -> 0.248,
     * i.e. adding this layer made the whole app LESS harsh, because a warm
     * mid-band bed is now carrying energy that the bright thin spectrum
     * previously had to. And it is the right sound anyway. A wall of insects
     * heard across a hundred metres of humid forest has had its top end
     * absorbed by the air and the leaves; what reaches you is a mid-band drone.
     * The 5 kHz saw is what a cicada sounds like at two metres, and there is
     * never only one at two metres.
     *
     * Measured contribution: ambience-only rms 0.0143 -> 0.0181, a 27% lift on
     * a layer that is audible one hundred per cent of the time. See
     * `probes-that-cannot-hear-the-real-thing`: the first version of this bed
     * moved the probe by 0.0003 and I nearly shipped it believing it worked.
     *
     * THE TREMOLO IS THE OTHER HALF OF "ALIVE". A steady filtered noise is an
     * air conditioner. What makes a cicada wall read as thousands of animals is
     * that it BREATHES — it surges and drops on a period of a few seconds, and
     * different parts of it are out of phase. Two oscillators at incommensurate
     * rates (0.21 and 0.34 Hz) modulating the two beds gives that for four
     * nodes and no per-frame work at all: it is wired once here and runs in the
     * audio thread forever.
     */
    this.cicadaSource = ctx.createBufferSource();
    this.cicadaSource.buffer = buffer;
    this.cicadaSource.loop = true;
    // Slower than unity: it pushes the pink noise's own energy down, which
    // means the band-pass below is amplifying a region that already has body
    // in it rather than lifting the buffer's own top end.
    this.cicadaSource.playbackRate.value = 0.72;

    this.cicadaBand = ctx.createBiquadFilter();
    this.cicadaBand.type = 'bandpass';
    this.cicadaBand.frequency.value = 1500;
    // Narrow. This is the number that turns hiss into a note; see above.
    this.cicadaBand.Q.value = 3.2;
    // A second pass through the same corner. One biquad at Q 5.5 still leaks
    // a broad skirt either side, and the skirt is exactly the part that reads
    // as hiss and moves the centroid. Two in series is 12 dB/octave of
    // rejection for one extra node.
    this.cicadaBand2 = ctx.createBiquadFilter();
    this.cicadaBand2.type = 'bandpass';
    this.cicadaBand2.frequency.value = 1500;
    this.cicadaBand2.Q.value = 3.2;

    this.cicadaGain = ctx.createGain();
    this.cicadaGain.gain.value = 0;
    // The breath. `cicadaGain` is set by `update` on the clock; this one is
    // multiplied on top of it at audio rate and never touched again.
    this.cicadaBreath = ctx.createGain();
    this.cicadaBreath.gain.value = 0.72;
    this.cicadaLfo = ctx.createOscillator();
    this.cicadaLfo.frequency.value = 0.21;
    const cicadaDepth = ctx.createGain();
    cicadaDepth.gain.value = 0.28;
    this.cicadaLfo.connect(cicadaDepth).connect(this.cicadaBreath.gain);
    this.cicadaLfo.start();

    this.cicadaSource
      .connect(this.cicadaBand)
      .connect(this.cicadaBand2)
      .connect(this.cicadaBreath)
      .connect(this.cicadaGain)
      .connect(this.engine.worldBus);
    this.cicadaSource.start();

    // ---- night: katydids -------------------------------------------------
    this.katydidSource = ctx.createBufferSource();
    this.katydidSource.buffer = buffer;
    this.katydidSource.loop = true;
    this.katydidSource.playbackRate.value = 1.15;

    this.katydidBand = ctx.createBiquadFilter();
    this.katydidBand.type = 'bandpass';
    this.katydidBand.frequency.value = 1950;
    // Tighter still — a bandwidth of about 215 Hz. A katydid is a nearly pure
    // whistle, and this bed is deliberately thinner and more deeply pulsed
    // than the day one: at night the wall breaks up and individual callers
    // start to separate, which is what the modulation below is for. It sits at
    // 1950 rather than up where the animal is for the reason given at length
    // in the block above — the 2-6 kHz window is spoken for.
    this.katydidBand.Q.value = 9;
    this.katydidBand2 = ctx.createBiquadFilter();
    this.katydidBand2.type = 'bandpass';
    this.katydidBand2.frequency.value = 1950;
    this.katydidBand2.Q.value = 9;

    this.katydidGain = ctx.createGain();
    this.katydidGain.gain.value = 0;
    this.katydidPulse = ctx.createGain();
    this.katydidPulse.gain.value = 0.5;
    this.katydidLfo = ctx.createOscillator();
    // Faster and deeper than the cicadas', and incommensurate with it, so the
    // two beds never line up into one throb during the dawn and dusk crossover
    // when both are audible at once.
    this.katydidLfo.frequency.value = 0.34;
    const katydidDepth = ctx.createGain();
    katydidDepth.gain.value = 0.45;
    this.katydidLfo.connect(katydidDepth).connect(this.katydidPulse.gain);
    this.katydidLfo.start();

    this.katydidSource
      .connect(this.katydidBand)
      .connect(this.katydidBand2)
      .connect(this.katydidPulse)
      .connect(this.katydidGain)
      .connect(this.engine.worldBus);
    this.katydidSource.start();

    /**
     * ==== RAIN, IN TWO LAYERS THAT ARRIVE AT DIFFERENT TIMES =================
     *
     * A single noise bed is what rain sounds like on a microphone in a field.
     * Under a canopy it is two distinct sounds and they are separated in both
     * frequency AND time, which is the detail worth having:
     *
     *   CANOPY. Rain hitting forty metres of leaves above you. Broad, soft,
     *   diffuse, and it starts FIRST — you hear the roof being hit several
     *   seconds before a drop reaches you. It is the sound people mean when
     *   they say they can hear rain coming.
     *
     *   DRIP. What gets through, landing on the litter and the big understory
     *   leaves around you. Lower, closer, sparser, and it LAGS — it fades in
     *   later and, more importantly, it keeps going after the rain has stopped,
     *   because a canopy holds water and lets it down for minutes afterwards.
     *
     * THE LAG IS THE WHOLE FEATURE and it is implemented as nothing more than
     * two different `setTargetAtTime` constants in `update` — 2.5 s for the
     * canopy, 11 s for the drip. Rising, the canopy leads. Falling, the drip
     * trails. No scheduling, no state machine, no per-frame work: two
     * exponentials with different time constants chasing the same target
     * produce the entire behaviour for free.
     *
     * BOTH ARE LIDDED HARD. `audio-probe` fails on energy between 2 and 6 kHz
     * and rain is the single broadest-spectrum thing that could be added to
     * this file — untreated it is pure white noise and it would fail every
     * stage at once. The canopy layer is low-passed at 1800 and the drip at
     * 900, which is also simply what rain heard through a wet forest sounds
     * like: the leaves absorb the top end. See the insect wall above for the
     * same argument made about the same 2-6 kHz window.
     */
    this.rainCanopySource = ctx.createBufferSource();
    this.rainCanopySource.buffer = buffer;
    this.rainCanopySource.loop = true;
    // Faster than unity, which shifts pink noise's energy up: rain has far more
    // top in it than wind does, and this is the cheap way to get some without
    // a second buffer.
    this.rainCanopySource.playbackRate.value = 1.7;
    this.rainCanopyTop = ctx.createBiquadFilter();
    this.rainCanopyTop.type = 'lowpass';
    this.rainCanopyTop.frequency.value = 1800;
    this.rainCanopyTop.Q.value = 0.3;
    this.rainCanopyLow = ctx.createBiquadFilter();
    this.rainCanopyLow.type = 'highpass';
    this.rainCanopyLow.frequency.value = 260;
    this.rainCanopyLow.Q.value = 0.3;
    this.rainCanopyGain = ctx.createGain();
    this.rainCanopyGain.gain.value = 0;
    this.rainCanopySource
      .connect(this.rainCanopyLow)
      .connect(this.rainCanopyTop)
      .connect(this.rainCanopyGain)
      .connect(this.engine.worldBus);
    this.rainCanopySource.start();

    this.rainDripSource = ctx.createBufferSource();
    this.rainDripSource.buffer = buffer;
    this.rainDripSource.loop = true;
    this.rainDripSource.playbackRate.value = 0.9;
    this.rainDripTop = ctx.createBiquadFilter();
    this.rainDripTop.type = 'lowpass';
    this.rainDripTop.frequency.value = 900;
    this.rainDripTop.Q.value = 0.4;
    this.rainDripGain = ctx.createGain();
    this.rainDripGain.gain.value = 0;
    this.rainDripSource
      .connect(this.rainDripTop)
      .connect(this.rainDripGain)
      .connect(this.engine.worldBus);
    this.rainDripSource.start();

    this.birdBus = ctx.createGain();
    /**
     * 0.34, up from 0.22.
     *
     * This gain sits AFTER each note's own envelope, which already peaks at
     * 0.16 times a distance factor — so the old value was multiplying an
     * already-quiet number by less than a quarter, and the loudest possible
     * chirp topped out around 0.035. Against the wind bed above, which is on
     * continuously, that is not a balance a listener can hear as "birds", it
     * is a balance they hear as "wind, and then wind". 0.34 brings a typical
     * chirp to roughly the wind's own baseline instead of well under it.
     */
    this.birdBus.gain.value = 0.34;
    this.birdBus.connect(this.engine.worldBus);

    this.stepBus = ctx.createGain();
    this.stepBus.gain.value = 0.5;
    this.stepBus.connect(this.engine.worldBus);

    this.noiseBuffer = buffer;
    this.built = true;
  }

  /**
   * One bird call, at a random bearing and distance.
   *
   * Placed with a plain StereoPanner rather than an HRTF panner: a bird is a
   * point that exists for a fifth of a second, and the extra realism of a real
   * spatial node is not worth the node churn of creating and destroying one on
   * every call.
   */
  _chirp(when) {
    const ctx = this.ctx;
    const rng = this.rng;
    const kind = BIRDS[Math.floor(rng() * BIRDS.length) % BIRDS.length];
    const pan = ctx.createStereoPanner();
    pan.pan.value = rngRange(rng, -0.85, 0.85);
    // Distance, faked with brightness and level rather than with a panner.
    const distance = rngRange(rng, 0.15, 1);
    const dull = ctx.createBiquadFilter();
    dull.type = 'lowpass';
    dull.frequency.value = 2200 + (1 - distance) * 9000;
    dull.Q.value = 0.3;
    dull.connect(pan).connect(this.birdBus);

    const transpose = rngRange(rng, -3, 3);
    kind.notes.forEach((note, i) => {
      const t = when + i * kind.gap * rngRange(rng, 0.85, 1.2);
      const f = 440 * 2 ** ((note + transpose - 69) / 12);
      /**
       * A whistle, not a struck bar. The long argument is in `wildlife.js`'s
       * `_note`; the short version is that a spectral flash decaying to a pure
       * tone over a bare exponential envelope IS a mallet, and all three of the
       * lines that did that here have been replaced:
       *
       *   the pitch walks a CONTOUR instead of sliding once, and the modulator
       *   walks the same one so the ratio holds and the spectrum stays
       *   harmonic while the note moves;
       *
       *   the index TAPERS instead of collapsing, so it is a timbre rather
       *   than a strike;
       *
       *   and the envelope has a PLATEAU, which is the thing a whistle does
       *   and a struck bar physically cannot.
       */
      const base = f * rngRange(rng, 0.94, 1.06);
      const bend = rngRange(rng, 0.8, 1.25);
      const arc = kind.arc ?? [0];
      const lead = 1.5;
      const walk = (param, from) => {
        const leadT = Math.min(0.012, kind.decay * 0.12, kind.decay / (arc.length + 1));
        param.setValueAtTime(Math.max(40, from * SEMI ** -lead), t);
        param.exponentialRampToValueAtTime(Math.max(40, from), t + leadT);
        for (let s = 0; s < arc.length; s++) {
          const k = (s + 1) / arc.length;
          param.exponentialRampToValueAtTime(
            Math.max(40, from * SEMI ** (arc[s] * bend)),
            t + kind.decay * k
          );
        }
      };
      const carrier = ctx.createOscillator();
      carrier.type = 'sine';
      walk(carrier.frequency, base);
      const mod = ctx.createOscillator();
      mod.type = 'sine';
      walk(mod.frequency, base * kind.ratio);
      const modGain = ctx.createGain();
      modGain.gain.setValueAtTime(f * kind.index, t);
      modGain.gain.linearRampToValueAtTime(f * kind.index * 0.6, t + kind.decay);
      mod.connect(modGain).connect(carrier.frequency);
      const peak = 0.16 * (0.35 + distance * 0.65);
      const atk = Math.min(0.03, Math.max(0.005, kind.decay * 0.2));
      const hold = Math.max(atk + 0.001, kind.decay * 0.5);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(peak, t + atk);
      env.gain.setValueAtTime(peak, t + hold);
      env.gain.exponentialRampToValueAtTime(0.0001, t + kind.decay);
      carrier.connect(env).connect(dull);
      carrier.start(t);
      mod.start(t);
      carrier.stop(t + kind.decay + 0.05);
      mod.stop(t + kind.decay + 0.05);
      /**
       * EVERY note tears its own three nodes down, not just the last one.
       *
       * This used to hang the whole cleanup off the final note's `onended`,
       * which disconnected that note's env, mod and modGain and the two shared
       * ones — and silently left the earlier notes' env and modGain connected
       * for the life of the context. Two gains per chirp, several times a
       * minute, for the whole session. Found by counting `createGain` calls
       * against `disconnect` calls per event: everything else in this file and
       * in `wildlife.js` balanced at zero and this came back with two.
       *
       * The shared filter and pan still belong to the last note, because they
       * are what the earlier notes are still playing through.
       */
      const last = i === kind.notes.length - 1;
      carrier.onended = () => {
        try {
          env.disconnect();
          mod.disconnect();
          modGain.disconnect();
          if (last) {
            dull.disconnect();
            pan.disconnect();
          }
        } catch {
          /* already gone */
        }
      };
    });
  }

  /**
   * One grain of band-passed pink noise, at a place.
   *
   * The same primitive `wildlife.js` calls `_puff`, and it is here rather than
   * imported because the two files own their own noise buffers and their own
   * ceilings; a shared helper would have to be handed both and would save four
   * lines. Q is clamped for the reason the header gives — a narrow band-pass on
   * noise is a pitch, and a train of pitches is the buzz this project exists
   * downstream of.
   */
  _grain(dest, when, { freq, q = 0.7, decay = 0.06, gain = 0.15, rate = 1 }) {
    if (this.voices > VOICE_CEILING) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = rate;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = Math.min(q, 1.2);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.linearRampToValueAtTime(gain, when + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, when + decay);

    src.connect(bp).connect(env).connect(dest);
    src.start(when, this.rng() * 3);
    src.stop(when + decay + 0.03);
    this.voices++;
    src.onended = () => {
      this._release(src);
      try {
        bp.disconnect();
        env.disconnect();
      } catch {
        /* already gone */
      }
    };
  }

  /**
   * Give a voice back, at most once per node. Same latch, and the same reason,
   * as `Wildlife._release` — see the long note there. A concurrency counter
   * that can drift downward is a ceiling that quietly stops being one.
   */
  _release(node) {
    if (node.__rrReleased) return;
    node.__rrReleased = true;
    this.voices--;
  }

  /**
   * Where the ears are, read straight off the WebAudio listener.
   *
   * main.js does not tell this file where the camera is — it tells it where the
   * stream is and how far away that is, which was all the stream ever needed.
   * The new events need an actual position: a frog on the bank is at a
   * coordinate that is not the nearest point of the channel, and a gust in the
   * canopy is over YOUR head.
   *
   * Rather than ask for a hook, take it from the graph. `engine.updateListener`
   * writes the camera into `ctx.listener` every frame with a short ramp, and an
   * AudioParam's `.value` is its current computed value — so this is the real
   * listener position, at most one frame stale, for the cost of three property
   * reads and no new plumbing to keep in sync. Safari's legacy listener has no
   * readable params; there the scratch stays wherever `setListener` last put it
   * and, failing that, at the origin, which puts the surges in the wrong place
   * rather than producing no sound.
   */
  _ears() {
    const l = this.ctx.listener;
    if (l.positionX) {
      _ear.x = l.positionX.value;
      _ear.y = l.positionY.value;
      _ear.z = l.positionZ.value;
    }
    return _ear;
  }

  /** For the legacy listener path, and for tests that want to stand somewhere. */
  setListener(p) {
    _ear.x = p.x;
    _ear.y = p.y;
    _ear.z = p.z;
  }

  /**
   * A point on the bank, somewhere along the stretch of water nearest to you.
   *
   * The channel runs roughly along x at this z, so an offset along x walks up
   * and down the bank and a small offset in z puts the caller on one side of it
   * or the other. Returned in the shared scratch — `createSpatial` copies the
   * numbers out immediately and does not keep the object.
   */
  _bankPoint(spread = 22) {
    const rng = this.rng;
    _at.x = this.streamPos.x + rngRange(rng, -spread, spread);
    _at.y = this.streamPos.y + rngRange(rng, 0.2, 0.7);
    _at.z = this.streamPos.z + rngRange(rng, -7, 7);
    return _at;
  }

  /**
   * ==== A HOWLER TROOP ======================================================
   *
   * The loudest land animal alive, audible over three miles of forest, and the
   * single most identifiable sound the Amazon has. It is also, structurally,
   * unlike anything else in this file: everything here is an EVENT lasting a
   * fraction of a second — a croak, a plop, a chirp — and this runs for the
   * better part of fifteen seconds and builds while it does.
   *
   * WHAT A HOWL ACTUALLY IS. Not a scream and not a bark: a deep, hoarse,
   * continuous ROAR, closer to wind in a tunnel or a distant football crowd
   * than to a monkey. It is produced by a hollow hyoid bone acting as a
   * resonating chamber, which is why it is so low for an animal that size and
   * why it carries so far — low frequencies survive a forest and high ones do
   * not. So it is built from long low noise grains rather than from tones, and
   * it lives between 110 and 520 Hz, comfortably under the 2 kHz the probe
   * cares about. It cannot fail the harsh gate; it is the least harsh thing
   * here.
   *
   * THE SHAPE IS A SLOW SWELL AND A LONG DECAY, and the swell is what makes it
   * frightening. A troop does not start at full volume — one animal begins, the
   * others join over several seconds, it peaks, and then it falls away raggedly
   * as they drop out one by one. `sin(PI * k^0.7)` is that curve: quick to
   * build, slow to die.
   *
   * IT IS ALWAYS FAR AWAY. 90-170 m, which is well past `maxDistance` on most
   * things in this file — deliberately, because the whole point of the sound is
   * that it comes from somewhere you are not and cannot get to. A howler troop
   * you could walk up to would be a monkey; one you can only hear is a place
   * that is bigger than you can see. That also makes it cheap: the distance
   * low-pass takes the top off it and what is left is the part that carries.
   */
  _howl(position) {
    if (!this.built || this.voices > VOICE_CEILING * 0.5) return;
    const rng = this.rng;
    const t0 = this.ctx.currentTime + 0.05;
    const spatial = this.engine.createSpatial(position, {
      // A long reach and a very shallow rolloff. This is the one sound in the
      // world that is supposed to arrive from outside the world.
      refDistance: 30,
      rolloff: 0.85,
      maxDistance: 320,
    });
    const ears = this._ears();
    spatial.setDistance(
      Math.hypot(position.x - ears.x, position.y - ears.y, position.z - ears.z)
    );
    /**
     * How many animals, which is also how long it lasts. A lone male is a
     * short hoarse series; a full troop rolls on for fifteen seconds. Both
     * happen, and the short one is far commoner, which is what keeps the long
     * one worth hearing.
     */
    const roars = 26 + Math.floor(rng() * 30);
    const step = rngRange(rng, 0.19, 0.29);
    let t = t0;
    for (let i = 0; i < roars; i++) {
      const k = i / roars;
      const swell = Math.sin(Math.PI * Math.pow(k, 0.7));
      /**
       * TWO GRAINS PER STEP, AN OCTAVE APART, and that pairing is the voice.
       * A single band gives a hum. The low one is the hyoid chamber and the
       * upper one is the rasp on top of it; without the rasp it is a foghorn,
       * and without the fundamental it is a cough.
       */
      this._grain(spatial.input, t, {
        freq: rngRange(rng, 112, 178),
        q: 1.6,
        decay: rngRange(rng, 0.3, 0.5),
        gain: 0.17 * (0.25 + swell),
        rate: 0.34,
      });
      this._grain(spatial.input, t + rngRange(rng, 0.01, 0.05), {
        freq: rngRange(rng, 300, 520),
        q: 2.4,
        decay: rngRange(rng, 0.16, 0.28),
        gain: 0.075 * (0.2 + swell),
        rate: 0.5,
      });
      t += step * rngRange(rng, 0.78, 1.28);
    }
    const life = (t - t0 + 2.2) * 1000;
    setTimeout(() => {
      try {
        spatial.dispose();
      } catch {
        /* already gone */
      }
    }, life);
  }

  /**
   * A frog.
   *
   * A croak is a pulse train and a pulse train is the thing this project does
   * not do — except that the rule is about NARROW BANDS RINGING, and this is
   * wide-band noise chopped up. The two are not the same spectrum at all: an
   * amplitude-modulated tone has sidebands around a peak, and chopped noise has
   * no peak to put sidebands around. Which is also true of the real animal, and
   * is why a frog sounds like a comb being run rather than like a note.
   *
   * THE GAPS JITTER BY A THIRD, and that is the part that had to be got right.
   * At a regular thirty-five a second the train acquires a pitch of its own —
   * you can hear the rate as a low buzz sitting under the croak — and it stops
   * sounding organic in the same instant. Jittered, the periodicity vanishes
   * from the spectrum entirely and what is left is an animal.
   *
   * Two of them, because one frog is a novelty and two is a pond: a long low
   * rattle for the common frogs and a short high one for whatever is answering.
   */
  _croak(position, high = false) {
    if (!this.built || this.voices > VOICE_CEILING * 0.6) return;
    const rng = this.rng;
    const t0 = this.ctx.currentTime + 0.01;
    const spatial = this.engine.createSpatial(position, {
      refDistance: 7,
      rolloff: 1.45,
      maxDistance: 70,
    });
    // The real distance to THIS frog, not to the channel — it can be twenty
    // metres up the bank from the nearest water, and the distance low-pass is
    // the cue that says so.
    const ears = this._ears();
    spatial.setDistance(
      Math.hypot(position.x - ears.x, position.y - ears.y, position.z - ears.z)
    );
    const pulses = high ? 3 + Math.floor(rng() * 3) : 8 + Math.floor(rng() * 6);
    let t = t0;
    for (let i = 0; i < pulses; i++) {
      // A swell rather than a decay: a croak gets going and then stops, which
      // is the opposite envelope to almost everything else in this project.
      const k = i / pulses;
      const swell = Math.sin(Math.PI * Math.min(1, k * 1.15));
      this._grain(spatial.input, t, {
        freq: high ? rngRange(rng, 900, 1350) : rngRange(rng, 330, 640),
        q: 1.15,
        decay: high ? 0.03 : 0.045,
        gain: (high ? 0.11 : 0.16) * (0.45 + swell * 0.75),
        rate: high ? 0.9 : 0.5,
      });
      t += (high ? 0.075 : 0.036) * rngRange(rng, 0.72, 1.34);
    }
    const life = (t - t0 + 0.8) * 1000;
    setTimeout(() => {
      try {
        spatial.dispose();
      } catch {
        /* already gone */
      }
    }, life);
  }

  /**
   * Something small going into the water.
   *
   * ONE SINE WITH A RISING PITCH, and the rise is the entire sound. A plop is a
   * bubble of air pinched off under the surface: the cavity shrinks as it
   * closes, so its resonance climbs, and a listener reads a fast upward sweep
   * of a pure tone as "that went into a liquid" with no other cue at all. Play
   * the identical envelope with the pitch falling and it is a drip on a table.
   *
   * Six nodes including the spatial, twenty milliseconds of sound, and it is
   * the single most place-specific noise in the file: nothing else here could
   * only have happened next to water.
   */
  _plop(position) {
    if (!this.built || this.voices > VOICE_CEILING) return;
    const spatial = this.engine.createSpatial(position, {
      refDistance: 5,
      rolloff: 1.6,
      maxDistance: 45,
      // An event, not a bed. See the bus note in the header.
      bus: this.engine.sfxBus,
    });
    const ears = this._ears();
    spatial.setDistance(
      Math.hypot(position.x - ears.x, position.y - ears.y, position.z - ears.z)
    );
    // The sweep itself is `_waterPlop`, because the fishing events needed the
    // same twenty milliseconds inside a source they already owned and this is
    // the one piece of synthesis here with a physical argument behind it worth
    // having in exactly one place.
    this._waterPlop(spatial.input, this.ctx.currentTime + 0.01);
    setTimeout(() => {
      try {
        spatial.dispose();
      } catch {
        /* already gone */
      }
    }, 350);
  }

  /**
   * The angler's noises, all six of them, from `player/fishing.js`.
   *
   * WHY THEY LIVE HERE. Every one of them happens at a point on the water, which
   * is the thing this file already knows how to be — it owns the plop, the noise
   * buffer, the voice ceiling and the `_ears` trick, and a second module
   * synthesising water sounds would need all four of those handed to it. So
   * `fishing.js` is given a callback and knows nothing about WebAudio, exactly
   * as it is given `say` and knows nothing about the HUD.
   *
   * WHY ONE SWITCH AND NOT SIX METHODS. They are one family: the same spatial
   * source, the same bus, the same gate, differing only in what is hung off the
   * front of it. Six near-identical setups would be six places to get the
   * distance cue wrong.
   *
   * ALL OF IT ON `sfxBus`, without exception. The header's rule is that the
   * beds — properties of the place — stay on `worldBus` and discrete physical
   * events go to sfx. Nothing about a rod is a property of the river: the river
   * sounds the same whether or not somebody is standing in it, and a player who
   * has turned the wood down to talk over it has not asked to stop hearing their
   * own reel.
   *
   * The cost of the loudest of them is nine nodes for under half a second. The
   * one called most often by far is `reel`, at up to thirteen a second while
   * winding, and it is deliberately the cheapest thing in the file — a single
   * grain, no oscillator, no spatial of its own beyond the shared setup.
   *
   * @param {'cast'|'knock'|'bite'|'strike'|'reel'|'strain'|'snap'|'splash'} kind
   * @param {{x: number, y: number, z: number}} at
   * @param {number} [strength] 0..1, and it means something different per kind
   */
  fishing(kind, at, strength = 1) {
    if (!this.built || this.voices > VOICE_CEILING) return;
    const ctx = this.ctx;
    const rng = this.rng;
    const t0 = ctx.currentTime + 0.01;
    const spatial = this.engine.createSpatial(at, {
      refDistance: 5,
      rolloff: 1.6,
      maxDistance: 55,
      bus: this.engine.sfxBus,
    });
    const ears = this._ears();
    spatial.setDistance(Math.hypot(at.x - ears.x, at.y - ears.y, at.z - ears.z));
    const dest = spatial.input;
    let life = 0.5;

    switch (kind) {
      /**
       * A cast: the line going out, then the float arriving.
       *
       * The WHIR is the half that sells it and it is nearly free — one wide
       * grain played fast and long, which is what a spool of monofilament
       * running off a rod is. The plop lands 180 ms later because that is how
       * long the float is in the air, and hearing the gap is the difference
       * between throwing something and pressing a button.
       */
      case 'cast': {
        this._grain(dest, t0, { freq: 1900, q: 0.35, decay: 0.19, gain: 0.05 * strength, rate: 2.2 });
        this._waterPlop(dest, t0 + 0.18, 0.9 * strength);
        life = 0.6;
        break;
      }

      /**
       * A knock. The same event as a bite and quieter, which is the point: the
       * ear must NOT be able to tell them apart, or the eye never has to learn
       * to. The float is the only honest witness.
       */
      case 'knock': {
        this._waterPlop(dest, t0, 0.35 * strength);
        life = 0.3;
        break;
      }

      /** The take. Lower and wetter than a knock — something pulled it under. */
      case 'bite': {
        this._waterPlop(dest, t0, 0.75 * strength, 0.62);
        this._grain(dest, t0 + 0.02, { freq: 520, q: 0.6, decay: 0.13, gain: 0.05 });
        break;
      }

      /** The rod sweeping up: air, and the line coming tight. */
      case 'strike': {
        this._grain(dest, t0, { freq: 1250, q: 0.4, decay: 0.11, gain: 0.06, rate: 2.6 });
        this._grain(dest, t0 + 0.06, { freq: 2600, q: 0.9, decay: 0.05, gain: 0.035, rate: 1.4 });
        break;
      }

      /**
       * One click of the reel. `strength` is the load on it, and it opens the
       * click up rather than making it louder: a ratchet under strain is a
       * lower, fatter noise, and rate is the cue the player is actually reading
       * anyway because `fishing.js` throttles these by how hard it is going.
       */
      case 'reel': {
        this._grain(dest, t0, {
          freq: 3100 - strength * 900,
          q: 1.1,
          decay: 0.022 + strength * 0.014,
          gain: 0.026 + strength * 0.02,
          rate: 1.8,
        });
        life = 0.15;
        break;
      }

      /**
       * The line singing. A short tone, and it is the ONE resonant thing this
       * file makes — the header forbids narrow bands in the continuous beds, and
       * this is thirty milliseconds of a sound that only exists when something
       * is about to break, which is the case the rule was never about.
       *
       * Pitch climbs with the load. That is the entire warning and it needs no
       * explaining to anybody who has ever pulled on a string.
       */
      case 'strain': {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        const f = 380 + strength * 520;
        osc.frequency.setValueAtTime(f, t0);
        osc.frequency.linearRampToValueAtTime(f * 1.12, t0 + 0.08);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.exponentialRampToValueAtTime(0.03 + strength * 0.045, t0 + 0.006);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
        osc.connect(env).connect(dest);
        osc.start(t0);
        osc.stop(t0 + 0.12);
        osc.onended = () => {
          try {
            env.disconnect();
          } catch {
            /* already gone */
          }
        };
        life = 0.25;
        break;
      }

      /** It parts. A crack, and the recoil hissing back through the rings. */
      case 'snap': {
        this._grain(dest, t0, { freq: 2800, q: 0.5, decay: 0.035, gain: 0.14, rate: 2.4 });
        this._grain(dest, t0 + 0.015, { freq: 900, q: 0.4, decay: 0.14, gain: 0.07, rate: 1.6 });
        break;
      }

      /**
       * Water thrown about: a surge at the surface, or the fish coming out of
       * it. Broadband and short, scaled by how much fish there is — the whole
       * difference between a roach coming in and a pike rolling is how much
       * river gets moved, so `strength` drives the low end and the length rather
       * than the volume alone.
       */
      case 'splash':
      default: {
        const s = clamp01(strength);
        this._grain(dest, t0, {
          freq: 900 + (1 - s) * 1400,
          q: 0.3,
          decay: 0.1 + s * 0.16,
          gain: 0.07 + s * 0.1,
          rate: 1.5 - s * 0.5,
        });
        this._grain(dest, t0 + 0.03, {
          freq: 3200,
          q: 0.4,
          decay: 0.07 + s * 0.08,
          gain: 0.03 + s * 0.04,
          rate: 1.9,
        });
        if (s > 0.45) this._waterPlop(dest, t0 + 0.05 + rng() * 0.05, s * 0.8, 0.75);
        life = 0.7;
        break;
      }
    }

    setTimeout(() => {
      try {
        spatial.dispose();
      } catch {
        /* already gone */
      }
    }, life * 1000);
  }

  /**
   * The rising sine of `_plop`, but into a destination somebody else owns.
   *
   * `_plop` builds its own spatial source because it is called from the ambient
   * clock with nothing but a point; the fishing events already have one and want
   * several sounds inside it. Rather than duplicate the sweep — which is the one
   * piece of synthesis in this file that has a real physical argument behind it,
   * see `_plop` — it moved down here and `_plop` calls it too.
   *
   * @param {AudioNode} dest
   * @param {number} when
   * @param {number} level
   * @param {number} [pitch] multiplies the whole sweep; under 1 is a heavier
   *   thing going in, because a bigger cavity resonates lower.
   */
  _waterPlop(dest, when, level = 1, pitch = 1) {
    if (this.voices > VOICE_CEILING) return;
    const ctx = this.ctx;
    const rng = this.rng;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const from = rngRange(rng, 220, 340) * pitch;
    const length = rngRange(rng, 0.045, 0.08) / pitch;
    osc.frequency.setValueAtTime(from, when);
    osc.frequency.exponentialRampToValueAtTime(from * rngRange(rng, 2.6, 4.2), when + length);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, rngRange(rng, 0.1, 0.19) * level), when + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, when + length);
    osc.connect(env).connect(dest);
    osc.start(when);
    osc.stop(when + length + 0.02);
    // The splash: one bright grain over the top of it, very short. Without it
    // the plop is a synthesiser blip; with it there is water involved.
    this._grain(dest, when, { freq: 3400, q: 0.5, decay: 0.045, gain: 0.05 * level, rate: 1.7 });
    osc.onended = () => {
      try {
        env.disconnect();
      } catch {
        /* already gone */
      }
    };
  }

  /**
   * A gust arriving in the canopy over your head, as an event.
   *
   * The wind bed already brightens with the gust, which is a property changing.
   * This is a thing happening: a swell of leaf noise from a bearing, ten metres
   * up, with a slow attack and a longer tail. The slow attack is what makes it
   * a gust rather than a burst — the wind takes the best part of a second to
   * arrive in a tree, and an instant one reads as a sample being triggered.
   *
   * Placed with a real spatial source rather than a pan, which is worth the
   * three extra nodes for exactly one reason: it comes from ABOVE. Height is
   * the only cue that separates leaves moving from noise being added, and a
   * StereoPanner cannot produce it.
   */
  _canopySurge(strength) {
    if (!this.built || this.voices > VOICE_CEILING * 0.7) return;
    const ctx = this.ctx;
    const rng = this.rng;
    const t0 = ctx.currentTime + 0.02;
    const a = rng() * Math.PI * 2;
    const r = rngRange(rng, 4, 14);
    const ears = this._ears();
    _at.x = ears.x + Math.cos(a) * r;
    _at.y = ears.y + rngRange(rng, 6, 13);
    _at.z = ears.z + Math.sin(a) * r;
    const spatial = this.engine.createSpatial(_at, {
      refDistance: 9,
      rolloff: 1.1,
      maxDistance: 60,
    });

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = rngRange(rng, 1.2, 1.7);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    /**
     * Fifteen hundred to three thousand, and it started an octave higher.
     *
     * Up at 2.2–4.2 kHz it was a convincing rush of leaves and it also moved
     * the whole app's spectral centroid — `audio-probe` measures that as the
     * symptom of the buzz this project was rewritten to remove, and a swell of
     * bright noise every half minute is a real contribution to it. Down here it
     * costs nothing perceptually and gains a lot: a big tree full of leaves is
     * a LOW roar with a hiss on top, not a hiss. The higher band sounded like
     * a smaller tree.
     */
    bp.frequency.value = rngRange(rng, 1500, 2900);
    // 0.5. Leaves are the broadest sound in a wood and anything approaching a
    // corner here would turn a gust into a hiss with a note in it.
    bp.Q.value = 0.5;
    const env = ctx.createGain();
    const rise = rngRange(rng, 0.5, 0.95);
    const length = rise + rngRange(rng, 0.9, 1.9);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(0.034 * strength, t0 + rise);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + length);
    src.connect(bp).connect(env).connect(spatial.input);
    src.start(t0, rng() * 3);
    src.stop(t0 + length + 0.05);
    this.voices++;
    src.onended = () => {
      this._release(src);
      try {
        bp.disconnect();
        env.disconnect();
        spatial.dispose();
      } catch {
        /* already gone */
      }
    };

    /**
     * The creak gets its OWN placement, and that is not tidiness.
     *
     * Hung off the surge's spatial source it was silently truncated: the surge
     * tears its panner down when its noise burst ends, at anything from 1.4 to
     * 2.9 seconds, and a creak starting nine tenths of a second in and running
     * for one and a half plus its release is regularly past that. The audible
     * result is a creak that stops dead halfway through, which sounds like a
     * dropout rather than like a bug and is therefore the kind you ship.
     *
     * It also wants to be somewhere else. The surge is up in the canopy; the
     * branch taking the load is a specific tree at head height off to one side,
     * and separating them is what stops the two reading as one sound effect.
     */
    if (rng() < 0.34) {
      const b = a + rngRange(rng, 0.8, 5.5);
      const br = rngRange(rng, 5, 16);
      _creakAt.x = ears.x + Math.cos(b) * br;
      _creakAt.y = ears.y + rngRange(rng, 1.5, 6);
      _creakAt.z = ears.z + Math.sin(b) * br;
      this._creak(t0 + rngRange(rng, 0.3, 0.9), _creakAt);
    }
  }

  /**
   * A branch taking the load: two detuned sines under a lurching envelope.
   *
   * A creak is stick-slip friction. The surfaces grab, release, grab again,
   * and what you hear is not a pitch changing but an amplitude stuttering at an
   * irregular rate — which is why the obvious build, a resonant filter wandering
   * over noise, sounds like a door in a horror film rather than like a tree, and
   * also why it whistles.
   *
   * So the envelope is a staircase: nine `setValueAtTime` steps at irregular
   * intervals with random levels, on two sines a shade over a perfect fifth
   * apart. The non-integer ratio is deliberate — a harmonic pair reads as one
   * note, and 1.51 reads as a stressed object. It costs four nodes and eleven
   * automation events and it is the sound of a wood having weather in it.
   */
  _creak(when, position) {
    if (!this.built) return;
    const ctx = this.ctx;
    const rng = this.rng;
    const spatial = this.engine.createSpatial(position, {
      refDistance: 6,
      rolloff: 1.3,
      maxDistance: 60,
      // A physical event — a specific branch, taking a load. See the header.
      bus: this.engine.sfxBus,
    });
    const ears = this._ears();
    spatial.setDistance(
      Math.hypot(position.x - ears.x, position.y - ears.y, position.z - ears.z)
    );
    const dest = spatial.input;
    const root = rngRange(rng, 96, 178);
    const length = rngRange(rng, 0.7, 1.5);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    const peak = rngRange(rng, 0.02, 0.045);
    let t = when + 0.03;
    while (t < when + length) {
      // A hard step, not a ramp. The grab is instantaneous and the ear knows it.
      env.gain.setValueAtTime(peak * rngRange(rng, 0.15, 1), t);
      t += rngRange(rng, 0.035, 0.13);
    }
    env.gain.setValueAtTime(peak * 0.3, when + length);
    env.gain.exponentialRampToValueAtTime(0.0001, when + length + 0.12);
    env.connect(dest);

    const oscs = [];
    for (const [mult, level] of [
      [1, 1],
      [1.51, 0.55],
    ]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(root * mult, when);
      // A slow sag as the branch settles. Twenty cents, not a sweep.
      osc.frequency.linearRampToValueAtTime(root * mult * 0.985, when + length);
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(env);
      osc.start(when);
      osc.stop(when + length + 0.2);
      oscs.push({ osc, g });
    }
    oscs[0].osc.onended = () => {
      try {
        env.disconnect();
        for (const o of oscs) o.g.disconnect();
        spatial.dispose();
      } catch {
        /* already gone */
      }
    };
  }

  /** A footstep. `wet` selects between leaf litter and the stream bed. */
  step(strength = 1, wet = 0) {
    if (!this.built) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = rngRange(this.rng, 0.7, 1.3);
    src.start(t, this.rng() * 3);
    src.stop(t + 0.24);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = wet > 0.5 ? rngRange(this.rng, 900, 1600) : rngRange(this.rng, 320, 720);
    bp.Q.value = 0.7;
    const env = ctx.createGain();
    const peak = 0.14 * (0.5 + strength * 0.7);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t + (wet > 0.5 ? 0.19 : 0.12));
    src.connect(bp).connect(env).connect(this.stepBus);
    src.onended = () => {
      bp.disconnect();
      env.disconnect();
    };
  }

  /**
   * A bush brushed past.
   *
   * Replaces what used to be a physical collider on the bigger bushes — see
   * `bushCue` in scatter.js — so this fires once per approach rather than once
   * per frame of contact; the controller handles the enter/exit edge and only
   * calls this on entry.
   *
   * Placed AT THE BUSH, not at the walker, which is the one thing that makes
   * this a cue about the world instead of a second footstep: brushing a shrub
   * on your left should arrive from the left. Routed to `sfxBus` rather than
   * `stepBus`/`worldBus` for the same reason the plop and the creak are —
   * a single physical event with a hard front, not a bed.
   */
  brush(position, strength = 1) {
    if (!this.built) return;
    const ctx = this.ctx;
    const rng = this.rng;
    const t = ctx.currentTime + 0.005;
    const spatial = this.engine.createSpatial(position, {
      refDistance: 3,
      rolloff: 1.6,
      maxDistance: 30,
      bus: this.engine.sfxBus,
    });

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = rngRange(rng, 0.8, 1.2);
    src.start(t, rng() * 3);
    src.stop(t + 0.32);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = rngRange(rng, 1800, 3000);
    bp.Q.value = 0.6;
    const env = ctx.createGain();
    const peak = 0.16 * (0.4 + clamp01(strength) * 0.8);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    src.connect(bp).connect(env).connect(spatial.input);
    src.onended = () => {
      try {
        bp.disconnect();
        env.disconnect();
        spatial.dispose();
      } catch {
        /* already gone */
      }
    };
  }

  /**
   * @param {number} dt
   * @param {object} p
   * @param {number} p.gust       0..1, the same value the trees are bending to
   * @param {number} p.canopy     0..1, how much foliage is overhead
   * @param {number} p.tripLevel  0..1
   * @param {number} [p.dark]     0..1, how far into the evening it is. Optional
   *                              — see below.
   */
  update(dt, { gust = 0, canopy = 0.5, tripLevel = 0, dark = null, rain = 0 } = {}) {
    if (!this.built) return;
    const ctx = this.ctx;
    const rng = this.rng;
    const now = ctx.currentTime;

    /**
     * How dark it is, derived the same way `fauna.js` derives it.
     *
     * The note that used to be here said there was no clock in this build, that
     * a trip was therefore the only thing that could darken the wood, and that
     * this reproduced the trip half of fauna's expression so the frogs and the
     * birds would at least agree with each other. `daylight.js` is the clock it
     * was waiting for, and the expression is now the whole of fauna's rather
     * than half of it: `max(the hour, the trip)`.
     *
     * IT DEFAULTS FROM THE CLOCK RATHER THAN BEING PASSED ONE, and that is a
     * deliberate choice about where a value should live. `main.js` calls this
     * with four named parameters and does not have a day cycle in it anywhere
     * else; adding a fifth would mean the frogs go quiet at midnight only for
     * as long as nobody edits that call site. The clock is a pure function of
     * the wall clock and is importable, so the layer that wants to know the
     * hour asks. The parameter survives for a caller that genuinely wants to
     * override it — the audio harnesses do.
     */
    const night =
      dark === null ? Math.max(clamp01(tripLevel * 0.65), darkAt()) : clamp01(dark);

    // Wind: level and brightness both follow the gust. More canopy overhead
    // means more leaves to rustle, so the band-pass opens up under trees.
    const g = clamp01(gust);
    this.gustValue = g;
    const leafy = 0.35 + canopy * 0.65;
    // 0.022/0.055 and 0.014/0.032, down from 0.03/0.085 and 0.02/0.05: a
    // player reported the wind reading as loud enough to bury the birds under
    // it, and it is the one layer that is on one hundred per cent of the time
    // — a continuous bed does not get to sit at the same gain as an event and
    // read as equally loud. The frequency sweeps that give the gust its
    // brightness are untouched; only how much of it there is moved.
    /**
     * The recorded bed's share of these two layers. See `setBedPresence`.
     *
     * Both are exactly 1 with no bed loaded, so the four writes below are the
     * same four writes they have always been. Only the LEVELS are ducked — the
     * two frequency sweeps are untouched, because the point of keeping the wind
     * at all is that it moves with the gust the trees bend to, and a wind that
     * got quieter without also getting duller is what a gust half a mile off
     * actually sounds like.
     */
    const bed = clamp01(this.bedPresence);
    const windDuck = 1 - bed * (1 - this.bedDuck.wind);
    const insectDuck = 1 - bed * (1 - this.bedDuck.insects);

    this.windGain.gain.setTargetAtTime((0.022 + g * 0.055 * leafy) * windDuck, now, 0.5);
    this.windBand.frequency.setTargetAtTime(520 + g * 1500 * leafy, now, 0.7);
    // The lid rides the gust too, so a squall still gets brighter — it just
    // stops taking two octaves of hiss with it. See windTop.
    this.windTop.frequency.setTargetAtTime(2600 + g * 2800 * leafy, now, 0.7);
    this.windLowGain.gain.setTargetAtTime((0.014 + g * 0.032) * windDuck, now, 0.9);

    /**
     * THE INSECT WALL, CROSSFADED ON THE HOUR. See the build block for what the
     * two beds are and why they sit where they do in the spectrum.
     *
     * NOT A STRAIGHT CROSSFADE, and the overlap is the interesting part. Both
     * beds are audible together through dusk and dawn — the cicadas are still
     * going as the katydids start — because that overlap is precisely what the
     * transition sounds like in the real place, and because a hard swap between
     * two continuous beds is audible as a swap however slow it is.
     *
     * `night` is already `max(the hour, the trip)`, so a trip brings the night
     * wall up under a midday sun. That is inherited from the frogs above and it
     * is correct for the same reason: everything in this file that responds to
     * darkness should respond to the trip's darkness identically, or the layers
     * disagree with each other about what time it is.
     *
     * THE TIME CONSTANTS ARE LONG — 6 and 8 seconds. These are the two slowest
     * moving values in the file by a wide margin. A bed that is on all the time
     * must never be caught changing; anything under a second or two reads as
     * somebody turning a knob.
     */
    const day = 1 - night;
    // Squared, so the cicadas hold up through most of the daylight and then
    // drop away quickly at the end of it rather than fading linearly all
    // afternoon. Real ones do exactly this: they stop almost together.
    this.cicadaGain.gain.setTargetAtTime(
      0.55 * day * day * (1 - clamp01(rain) * 0.8) * insectDuck,
      now,
      6
    );
    // The wall gets brighter as it gets louder — an insect chorus at full cry
    // is genuinely higher in pitch than a few stragglers, because the loudest
    // species are the highest.
    this.cicadaBand.frequency.setTargetAtTime(1380 + day * 300, now, 8);
    this.cicadaBand2.frequency.setTargetAtTime(1380 + day * 300, now, 8);
    /**
     * Below the day bed once the filter losses are accounted for — a Q of 9 in
     * two stages throws away far more of the noise than the day bed's 3.2 does,
     * so the raw numbers here are not comparable and 0.4 against 0.55 is a
     * wider gap than it looks. Night in a rainforest is not louder
     * than day, whatever the recordings suggest — it is EMPTIER and more
     * separated, which is what the deeper pulse modulation is doing rather than
     * the gain. A katydid bed as loud as the cicada one is a wall of whistles
     * and it is unbearable within about ninety seconds.
     */
    this.katydidGain.gain.setTargetAtTime(0.4 * night * night * insectDuck, now, 8);

    /**
     * THE RAIN, AND THE TWO TIME CONSTANTS ARE THE FEATURE. See the build block.
     *
     * 2.5 s on the canopy and 11 s on the drip means the roof layer leads the
     * shower in and the floor layer trails it out — you hear it coming several
     * seconds early, and it is still dripping around you long after the drops
     * have stopped falling. Nothing schedules that; it falls out of two
     * exponentials with different constants chasing one target.
     *
     * The insect wall ducks under heavy rain, which is the only cross-coupling
     * in this file and it is worth the line: cicadas genuinely stop when it
     * rains hard, and leaving a full-cry chorus running underneath a downpour
     * is the single most obviously wrong thing this layer could do.
     */
    const wetness = clamp01(rain);
    this.rainCanopyGain.gain.setTargetAtTime(0.075 * wetness, now, 2.5);
    this.rainDripGain.gain.setTargetAtTime(0.055 * wetness, now, 11);
    // Brighter as it gets heavier: light rain on leaves is a hiss, a downpour
    // is a roar with edge on it.
    this.rainCanopyTop.frequency.setTargetAtTime(1300 + wetness * 900, now, 3);

    /**
     * Birds, and they are THINNER than they were.
     *
     * This layer is five two-note FM chirps behind a stereo pan, and when it
     * was written it was the only birdsong in the project. It is not any more:
     * `wildlife.js` now carries twelve species with real contours, placed with
     * real panners at real coordinates, and running both at their original
     * rates put a bird call in the wood every two and a half seconds, which is
     * a dawn chorus in a permanent mid-morning and is exactly the "zoo" failure
     * the whole design is trying to avoid.
     *
     * So the interval went from 1.6–8.5 s to 4–19, which is a bit under half.
     * The layer is kept rather than deleted because it does one thing the
     * located voices deliberately cannot: it is unplaceable. Everything in
     * wildlife.js is somewhere, and a wood also contains birds that are just
     * out there, and the two together are what produce depth.
     */
    this._nextBird -= dt * this.birdRate * (1 - tripLevel * 0.55);
    if (this._nextBird <= 0) {
      this._chirp(now + rng() * 0.2);
      this._nextBird = rngRange(rng, 4, 19) * (1 + tripLevel);
    }

    /**
     * THE GUST ARRIVES IN THE CANOPY. Rising edge, with hysteresis.
     *
     * `_surgeHold` is a floor on the interval as well, because the gust main.js
     * supplies is a smooth sine and a slow one — without it a run of shallow
     * oscillations around the threshold would produce a surge every few
     * seconds, and a wood where the wind arrives every few seconds is not windy,
     * it is broken.
     */
    this._surgeHold -= dt;
    if (g < 0.42) this._gustArmed = true;
    if (this._gustArmed && g > 0.58 && this._surgeHold <= 0) {
      this._gustArmed = false;
      this._surgeHold = rngRange(rng, 15, 32);
      this._canopySurge(0.45 + g * 0.75);
    }

    /**
     * The water's own animals, and only near the water.
     *
     * The distance gate is the entire point rather than an optimisation. A
     * forest that sounds the same everywhere has no geography in it, and the
     * strongest cheap way to give it some is to have one thing that only exists
     * in one place — walk toward the stream and there are frogs, walk away and
     * there are not, and you learn that in about forty seconds without being
     * told. `FROG_RANGE` is deliberately further than the stream itself carries,
     * so the frogs arrive slightly BEFORE the water does.
     *
     * A croak every four to eleven seconds sounds like a lot written down and
     * is not: half of them are the short high answer, they are quiet, and they
     * are competing with a stream. Below about one every ten seconds the bank
     * stops reading as inhabited and becomes a place where a frog happened once.
     */
    /**
     * THE HOWLER TROOP, WEIGHTED TO DAWN AND DUSK AND TO AFTER THE RAIN.
     *
     * Howlers call most at first light and last light, and they call again
     * when it starts or stops raining — nobody is quite sure why, but they do,
     * reliably, and it is one of those details that makes a soundscape feel
     * observed rather than designed.
     *
     * `twilight` peaks at 1 where `night` is 0.5, i.e. exactly through the
     * transition, and falls to 0 at full day and full dark. It is never zero
     * in practice because of the 0.12 floor: a troop can go off at any hour,
     * just rarely. The interval is then divided by that weight, so a call is
     * roughly every two minutes at dusk and every quarter of an hour at
     * midnight.
     */
    this._nextHowl -= dt;
    if (this._nextHowl <= 0) {
      const twilight = Math.max(0.12, 1 - Math.abs(night * 2 - 1)) + clamp01(rain) * 0.5;
      const ears = this._ears();
      const bearing = rng() * Math.PI * 2;
      const far = rngRange(rng, 90, 170);
      _at.x = ears.x + Math.cos(bearing) * far;
      // Up in the canopy, where they are. A howler troop is never at ground
      // level and the elevation is audible on a panner with a Y term.
      _at.y = ears.y + rngRange(rng, 8, 22);
      _at.z = ears.z + Math.sin(bearing) * far;
      this._howl(_at);
      this._nextHowl = rngRange(rng, 95, 260) / twilight;
    }

    if (this.streamDistance < FROG_RANGE) {
      this._nextFrog -= dt;
      if (this._nextFrog <= 0) {
        this._croak(this._bankPoint(24), rng() < 0.45);
        this._nextFrog = rngRange(rng, 4, 11) * (1 - night * 0.4);
      }
      if (this.streamDistance < 30) {
        this._nextPlop -= dt;
        if (this._nextPlop <= 0) {
          _at.x = this.streamPos.x + rngRange(rng, -12, 12);
          _at.y = this.streamPos.y + 0.06;
          _at.z = this.streamPos.z + rngRange(rng, -2.5, 2.5);
          this._plop(_at);
          this._nextPlop = rngRange(rng, 14, 40);
        }
      }
    }
  }

  setStreamPosition(p) {
    this.streamSpatial?.setPosition(p);
    // By value. The caller passes a shared scratch vector and keeps writing it.
    this.streamPos.x = p.x;
    this.streamPos.y = p.y;
    this.streamPos.z = p.z;
  }

  setListenerDistanceToStream(d) {
    this.streamDistance = d;
    this.streamSpatial?.setDistance(clamp(d, 0, 200));
  }

  dispose() {
    if (!this.built) return;
    for (const n of [this.windSource, this.streamSource, this.streamLfo]) {
      try {
        n.stop();
      } catch {
        /* ignore */
      }
    }
    this.built = false;
  }
}

/**
 * Hoisted scratch. `createSpatial` copies the numbers out into AudioParams and
 * does not keep the object, so one shared point is safe — and the schedulers
 * above must not allocate, because they run inside the frame loop.
 */
const _at = { x: 0, y: 0, z: 0 };
const _ear = { x: 0, y: 0, z: 0 };
const _creakAt = { x: 0, y: 0, z: 0 };
