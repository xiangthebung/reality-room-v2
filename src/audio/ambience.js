import { clamp, clamp01, makeRng, rngRange } from '../core/util.js';
import { darkAt } from '../world/daylight.js';
import { currentLand } from '../world/lands/index.js';

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
 *
 * ==== WHAT THE WOOD-YOU-CAN-HEAR PASS ADDED ================================
 *
 * The soundscape above is good and it does not KNOW ANYTHING. It does not know
 * there is a fire over there, that you have walked out of the trees, or which
 * land you are in. Four things were added to fix that, and every one of them
 * follows the stream's pattern rather than inventing a new one: main.js is
 * already handing this file a coordinate and a distance every frame, so a
 * second coordinate and a second distance cost nothing to plumb and everything
 * else falls out.
 *
 *   HEARTH — `gathering.js` builds nine fire sites specifically so people have
 *   somewhere to be, and it exports `nearestFire(x, z)` whose own comment says
 *   it is "for the audio", and until now nothing in the repository called it.
 *   One spatial source for the bed (a 90-320 Hz body and a hiss lidded well
 *   under 2 kHz), one for the pops, both rewritten from the nearest fire each
 *   frame exactly as the stream's is. The bed is on `worldBus` because a fire
 *   is a property of a place; the pops are on `sfxBus` because a pop is an
 *   impact. That is the same test this file already applies to the creak.
 *
 *   THUNDER — a rumble that arrives `km / 0.343` seconds after the flash,
 *   because that is how far sound gets in a second and it is the only physical
 *   constant in this file the player can actually count. Below 1 kHz, so it is
 *   invisible to the harsh gate, and loud enough that it is NOT invisible to
 *   the limiter. See `thunder`.
 *
 *   THE BELL — the ferry has had a brass bell mesh and no sound since the raft
 *   existed. music.js's `bell` recipe, run through a spatial source at the raft
 *   rather than through the jukebox bus, and the distance low-pass does the
 *   rest: a bell heard through two hundred metres of wet forest is almost
 *   entirely its fundamental, which is exactly what `createSpatial`'s air
 *   filter turns it into for free.
 *
 *   THE LAND — the insect wall is a rainforest fact and this project now has a
 *   winter wood in it. It is scaled by a per-land scalar read from the land
 *   record, and the record is ASKED FOR rather than passed in, for the same
 *   reason `darkAt()` is: main.js has no other opinion about audio and a fifth
 *   named parameter is a thing that goes stale.
 *
 * And one thing that was already here and was being fed a lie: `canopy`. The
 * parameter has been documented as "how much foliage is overhead" since the
 * file was written and main.js passed the literal 0.6 for the whole of that
 * time. It is real now, and it is spent in three places — see `update`.
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

/**
 * Past this many metres a fire makes NO sound at all, and the zero is exact.
 *
 * The panner would already have it thirty decibels down — but only thirty. An
 * inverse-distance model with `maxDistance` clamps to a floor rather than to
 * silence, so a hearth four hundred metres away would still be pushing a
 * continuous noise bed into `worldBus` from somewhere behind the horizon, on
 * every frame, in every measurement this repo takes. A hard multiplicative
 * gate means that a player (or `audio-probe`) standing anywhere but at a
 * gathering place measures the world this file has always produced, bit for
 * bit, and there is no "the fire layer contributes a little bit everywhere"
 * term to argue about later.
 *
 * 34 m rather than the stream's 45 because a campfire is genuinely quiet. You
 * can hear a river from further away than you can hear a fire, and the point of
 * the layer is that the last thirty metres of walking toward the clearing are
 * different, not that the whole wood smells of smoke.
 */
const FIRE_RANGE = 34;

/** The metres within which a fire is close enough to be worth scheduling pops. */
const FIRE_POP_RANGE = 22;

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

    /**
     * Where the nearest fire is, and how far away you are from it. Exactly the
     * same contract as `streamPos` above and written by the same block in
     * main.js, from `gathering.nearestFire(x, z)`.
     *
     * The distance starts at 999 and not at 0, which matters on the first
     * frame: 0 would mean "you are standing in a fire" and would open the bed
     * at full level for however many frames it takes main.js to correct it. The
     * stream has the identical guard for the identical reason.
     */
    this.firePos = { x: 0, y: 0, z: 0 };
    this.fireDistance = 999;
    this._nextPop = 1.4;

    /**
     * The last lightning strike this file has already answered.
     *
     * A flash is one frame long, so the caller passes the same descriptor for
     * that frame and null on every other — but a dropped frame, a paused tab,
     * or a caller that latches its own value for two frames would otherwise
     * schedule the same thunder twice, half a second apart, which sounds like a
     * bug rather than like weather. Comparing the strike's id is one integer and
     * it makes the scheduler idempotent.
     */
    this._lastStrike = null;

    /**
     * How loud this land's insects are, 0 to 1. See `setLand`.
     *
     * One until told otherwise, so a caller that never mentions a land — every
     * audio harness in `scripts/` — measures the rainforest wall exactly as it
     * has always been.
     */
    this.insectScale = 1;

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
     * ==== THE HEARTH =========================================================
     *
     * `gathering.js` puts nine fire sites in the world for the express purpose
     * of giving people somewhere to be, and `nearestFire(x, z)` has sat there
     * with a comment saying it is "for the audio" and no caller. A clearing
     * with a lit fire in it that makes no sound is a picture of a fire.
     *
     * IT IS BUILT LIKE THE STREAM AND NOT LIKE A ONE-SHOT, and that is the
     * decision the rest of the block follows from. A fire is continuous, it is
     * at a place, and the place moves — not because the fire moves, but because
     * WHICH fire is nearest changes as you walk. Two persistent spatial sources
     * whose positions are rewritten each frame cost four nodes for the life of
     * the session and nothing per event; a source built per fire would need
     * nine of everything and a rebuild whenever the gathering layer streamed.
     *
     * TWO LAYERS, BECAUSE A FIRE IS TWO SOUNDS AND THEY ARE IN DIFFERENT
     * OCTAVES.
     *
     *   BODY, 90-320 Hz. The roar — a column of hot air leaving, which is a
     *   broadband low rumble and is what you feel rather than hear. It is the
     *   half that survives being fifteen metres away through wet undergrowth,
     *   and it is the half that makes a fire read as BIG.
     *
     *   HISS, 500-1450 Hz with a slow gain wander. Steam and resin leaving the
     *   wood. Without it the body alone is a distant engine; with it, it is a
     *   fire. The wander is one oscillator on one gain and it is the same trick
     *   the cicada wall uses: a steady filtered noise is an air conditioner.
     *
     * THE HISS IS LIDDED AT 1450 AND THAT IS NOT AN AESTHETIC CHOICE. A real
     * fire at two metres has a great deal of energy between 2 and 6 kHz, and
     * `audio-probe` fails any stage whose share of that band drifts up —
     * `continuous-beds-cannot-live-in-2-6khz` records the insect wall having
     * 0.014 of headroom before it was moved below 2 kHz, and this is a second
     * continuous bed that would have to share whatever is left. So the hiss is
     * a fire heard from six metres across a clearing with leaves in the way,
     * which absorbs exactly that band, and it costs nothing perceptually
     * because the POPS carry the top end instead — and a pop is a transient,
     * which the gate does not integrate.
     */
    this.fireSpatial = this.engine.createSpatial(this.firePos, {
      refDistance: 4,
      rolloff: 1.5,
      maxDistance: FIRE_RANGE + 6,
    });
    /**
     * A SECOND SPATIAL FOR THE POPS, ON `sfxBus`.
     *
     * The same coordinate and the same distance, so it is not a second place —
     * it is the same place on the other side of the bus split this file's
     * header describes. The bed is a property of the clearing and belongs with
     * the wind and the stream; a pop is a discrete impact with a hard front and
     * belongs with the plop and the creak. A player who has pulled the world
     * slider down to walk in near silence should still hear the fire crack.
     *
     * Persistent rather than built per pop, unlike the creak: a pop is fifteen
     * milliseconds long and a cluster of three of them would otherwise build
     * and tear down nine nodes inside a fifth of a second, several times a
     * minute, forever.
     */
    this.firePopSpatial = this.engine.createSpatial(this.firePos, {
      refDistance: 3.5,
      rolloff: 1.7,
      maxDistance: FIRE_POP_RANGE + 8,
      bus: this.engine.sfxBus,
    });

    this.fireBodySource = ctx.createBufferSource();
    this.fireBodySource.buffer = buffer;
    this.fireBodySource.loop = true;
    // Well under unity. Pink noise already leans low; slowing it further drags
    // its energy down into the band the filters below are trying to keep,
    // which means they are shaping something that has body rather than
    // amplifying a region that is nearly empty. Same argument as the cicadas'
    // 0.72, arrived at from the other direction.
    this.fireBodySource.playbackRate.value = 0.55;
    const fireBodyHp = ctx.createBiquadFilter();
    fireBodyHp.type = 'highpass';
    fireBodyHp.frequency.value = 90;
    fireBodyHp.Q.value = 0.4;
    const fireBodyLp = ctx.createBiquadFilter();
    fireBodyLp.type = 'lowpass';
    fireBodyLp.frequency.value = 320;
    fireBodyLp.Q.value = 0.4;
    this.fireBodyGain = ctx.createGain();
    this.fireBodyGain.gain.value = 0;
    this.fireBodySource
      .connect(fireBodyHp)
      .connect(fireBodyLp)
      .connect(this.fireBodyGain)
      .connect(this.fireSpatial.input);
    this.fireBodySource.start();

    this.fireHissSource = ctx.createBufferSource();
    this.fireHissSource.buffer = buffer;
    this.fireHissSource.loop = true;
    this.fireHissSource.playbackRate.value = 1.25;
    const fireHissHp = ctx.createBiquadFilter();
    fireHissHp.type = 'highpass';
    fireHissHp.frequency.value = 500;
    fireHissHp.Q.value = 0.4;
    this.fireHissTop = ctx.createBiquadFilter();
    this.fireHissTop.type = 'lowpass';
    // 1450. See the block above — this is the number the harsh gate cares
    // about and it is the one number in the hearth that must not drift up.
    this.fireHissTop.frequency.value = 1450;
    this.fireHissTop.Q.value = 0.3;
    this.fireHissGain = ctx.createGain();
    this.fireHissGain.gain.value = 0;
    /**
     * The wander, and it is deliberately slower than either insect bed.
     *
     * 0.13 Hz — a period of about eight seconds. The cicadas breathe at 0.21
     * and the katydids pulse at 0.34, and this had to be incommensurate with
     * both or the three would periodically line up into one throb, which is the
     * trap the katydid LFO's own comment records. It is also SLOWER than both
     * because that is what a fire does: a chorus of insects surges, a fire
     * settles and flares over several seconds. Depth 0.3 on a base of 0.72, so
     * it swings roughly ±3.5 dB and never reaches zero.
     */
    this.fireHissWander = ctx.createGain();
    this.fireHissWander.gain.value = 0.72;
    this.fireHissLfo = ctx.createOscillator();
    this.fireHissLfo.frequency.value = 0.13;
    const fireHissDepth = ctx.createGain();
    fireHissDepth.gain.value = 0.3;
    this.fireHissLfo.connect(fireHissDepth).connect(this.fireHissWander.gain);
    this.fireHissLfo.start();
    this.fireHissSource
      .connect(fireHissHp)
      .connect(this.fireHissTop)
      .connect(this.fireHissWander)
      .connect(this.fireHissGain)
      .connect(this.fireSpatial.input);
    this.fireHissSource.start();

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
    /**
     * ASK THE REALM WHICH LAND THIS IS, rather than be told.
     *
     * Identical reasoning to `darkAt()` in `update`: main.js does not have an
     * opinion about audio anywhere else, so a parameter threaded through
     * `build()` for this would be a thing that goes stale the first time
     * somebody edits that call site. `setLand` in `world/lands/index.js` is
     * called from main.js beside `setWorldSeed`, long before the audio gate is
     * ever clicked, and `currentLand()` is one property read.
     *
     * The explicit setter still wins if it was used first, because the audio
     * harnesses want to stand in a land the page is not in.
     */
    if (!this._landExplicit) this.setLand(currentLand());
    this.built = true;
  }

  /**
   * WHICH LAND THIS IS, and the only thing this file takes from one.
   *
   * `insects` is a scalar because that is genuinely all that changes here. A
   * winter wood is not a rainforest with different insects, it is a rainforest
   * with almost NO insects — the wall is the single loudest statement the
   * rainforest bed makes and a boreal forest in snow makes the opposite one.
   * Everything else in this file is weather, water and wind, which sound the
   * same in both.
   *
   * WRITTEN DEFENSIVELY BECAUSE THE FIELD MAY NOT EXIST YET, AND BECAUSE ITS
   * NESTING IS NOT SETTLED. The land records are being extended by another pass
   * in the same wave as this one, and that pass reads its mammal roster from
   * `land.fauna.kinds` — so this may land as `land.insects` or as
   * `land.fauna.insects`. Both are accepted, in that order, and a record with
   * neither behaves exactly as the rainforest always has. That is the correct
   * reading: the field was added to make the taiga quiet, not to make the
   * rainforest conditional.
   *
   * @param {{insects?: number, fauna?: {insects?: number}}|null} land a land
   *   record, or null for "as before"
   */
  setLand(land) {
    this._landExplicit = true;
    const v = land?.insects ?? land?.fauna?.insects;
    this.insectScale = Number.isFinite(v) ? clamp01(v) : 1;
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

  /**
   * FOUR SOUNDS THE BODY NOW ASKS FOR, AND WHAT THEIR ARGUMENTS MEAN.
   *
   * Requested by `player/controller.js`, which publishes all four quantities on
   * the frame the movement itself reads them. Every call site optional-chains,
   * so an unimplemented method here is silence and never an exception.
   *
   * land(strength) — the ground arriving. `strength` is 0..1, where 0 is the
   *   softest fall that counts (about 3 m/s, stepping off a root) and 1 is 11
   *   m/s, a 2.75 m drop. NO POSITION ARGUMENT: it happens at your own feet and
   *   the listener is your own head, so a panner would be a 1.7 m offset nobody
   *   can hear and a node per event. Route to `stepBus`, so it inherits the mix
   *   and the cave crossfade the footsteps already have. The shape asked for is
   *   the `step` noise burst band-passed LOW — 120-260 Hz, Q around 0.8,
   *   decaying over ~180 ms — with a sine thump under it (55 Hz sliding to about
   *   40 over 90 ms), and then a SECOND, lighter grain about 45 ms later in a
   *   higher band (300-700 Hz) at roughly 0.4 of the first, so that it is
   *   heel-then-toe rather than one hit. `cave.js` wraps this exactly as it
   *   wraps `step`.
   *
   * scuff(strength) — pushing off, on the frame the jump key fires. 0..1;
   *   main.js sends 0.5. A quieter, longer, scrapier `step` — the same noise
   *   source through a band that sweeps up rather than sitting still. OPTIONAL:
   *   main.js falls back to `step(0.35, wetFeet)` if this does not exist, because
   *   a quiet footstep already is a scuff.
   *
   * wade(position, strength, depth) — water round the legs, once per stride.
   *   `position` is a plain {x, y, z} AT THE FEET — 1.68 m below the listener —
   *   so it has to go through `engine.createSpatial` the way `brush` does, or it
   *   is just a second footstep. `strength` is 0..1.5: anything above 1 is the
   *   entry plunge, and main.js sends exactly 1.4 once, on the frame the feet
   *   break the surface. `depth` is 0..1 and is for the timbre rather than the
   *   level — ankle deep is a bright splash, chest deep is a heavy displacement
   *   with almost no top end.
   *
   * breath(exertion) — CALLED EVERY FRAME with 0..1. The in/out cycle and its
   *   timing belong here, not to the caller; `exertion` only says how hard the
   *   body is working. Filtered noise, an in/out pair tightening from about 2.6 s
   *   at rest to 1.4 s at full, band-limited well below 2 kHz for the reason in
   *   this file's header about continuous beds and the harsh gate — and, the
   *   point, routed with NO PANNER AT ALL, straight to a bus. A breath is the one
   *   sound in this world that legitimately originates inside your own head, and
   *   putting it at a position in the wood would make it somebody else's.
   */

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
   * A CLUSTER OF POPS. One to three, over about a fifth of a second.
   *
   * WHY A CLUSTER AND NOT A POP. A fire does not tick. What it does is go quiet
   * for two seconds and then produce three cracks in quick succession as one
   * pocket of sap lets go and takes its neighbours with it — and the clustering
   * is more of what makes a recording read as "fire" than the timbre of any one
   * crack is. Evenly spaced single pops at the same average rate sound like a
   * clock, which is the same failure `_creak` records about a regular envelope
   * and `_chitter` in wildlife.js records about a regular train.
   *
   * THE LEVEL IS ROLLED, AND THE ROLL IS THE OTHER HALF. Nine pops in ten are
   * barely there — the fire muttering — and the tenth is a bang that makes you
   * look at it. A fire whose pops are all the same size is a loop. The loud one
   * is roughly nine decibels over the quiet ones, which is about the ratio a
   * real one has and is comfortably inside what the limiter absorbs without
   * moving (see `pumping-is-a-swing-not-an-average`).
   *
   * THEY ARE ALLOWED ABOVE 2 kHz AND THE BED IS NOT, which is the one thing to
   * understand before editing either. `audio-probe` integrates energy over a
   * window: a continuous layer contributes its band share to every frame of
   * every stage and a fifteen-millisecond transient every second and a half
   * contributes almost nothing to the integral. So the top end of the fire —
   * the part that makes it crackle rather than roar — lives entirely here,
   * which is why the hiss above could afford to be lidded at 1450.
   *
   * Routed through `_grain`, which already owns the voice budget and the Q
   * clamp, so a cluster arriving on the same frame as a gust and a frog cannot
   * push the count past the ceiling — it just gets shorter.
   */
  _firePops(when, near) {
    const rng = this.rng;
    const count = 1 + Math.floor(rng() * rng() * 3);
    let t = when;
    for (let i = 0; i < count; i++) {
      /**
       * One in ten is loud. `rng() < 0.1` rather than a shaped curve because
       * the interesting quantity here is the CONTRAST and a distribution would
       * fill the gap between the two with pops that are neither.
       */
      const loud = rng() < 0.1;
      const gain = (loud ? rngRange(rng, 0.075, 0.13) : rngRange(rng, 0.008, 0.032)) * near;
      this._grain(this.firePopSpatial.input, t, {
        // A wide window, and the loud ones sit higher in it: a big crack is a
        // faster transient and a faster transient is brighter. Q is left at the
        // default and clamped by `_grain` anyway — a narrow band-pass on noise
        // is a pitch, and a train of pitches is the buzz this project exists
        // downstream of.
        freq: loud ? rngRange(rng, 1400, 2600) : rngRange(rng, 620, 1700),
        q: 0.8,
        decay: loud ? rngRange(rng, 0.035, 0.07) : rngRange(rng, 0.012, 0.035),
        gain,
        rate: rngRange(rng, 0.9, 1.6),
      });
      t += rngRange(rng, 0.035, 0.11);
    }
  }

  /**
   * THUNDER, AND THE DELAY IS THE WHOLE POINT.
   *
   * `ctx.currentTime + km / 0.343` — sound covers 343 metres a second, so a
   * strike three kilometres away arrives eight and a half seconds after you saw
   * it. That is the one physical constant in this entire file that a player can
   * verify by counting, and getting it right is worth more than any amount of
   * work on the timbre: a flash and a bang together is a sound effect, and a
   * flash and then a long wait and then a bang is a storm.
   *
   * TWO LAYERS, AND THE CRACK IS CONDITIONAL.
   *
   *   RUMBLE, 90-220 Hz, always. Distance is a low-pass — air absorbs high
   *   frequencies over kilometres far more than low ones, which is why distant
   *   thunder is a rumble and near thunder is a bang. The corner rides `km`.
   *
   *   CRACK, 200-900 Hz, only inside about four kilometres. This is the leader
   *   stroke, and past a few kilometres there is genuinely none of it left. It
   *   is also the layer that could move the limiter, so gating it on proximity
   *   gates the risk on the same number.
   *
   * WHY IT IS NOT A CONVOLVER OR A SECOND REVERB. `a-long-reverb-needs-sparse-
   * sources` and this file's own brief both say the same thing: the forest
   * impulse is already on everything, and thunder is the sparsest source in the
   * project. It goes through `roomSend` like every other world sound and gets a
   * wood-sized tail for free; what it needs of its own is a LONG exponential
   * decay, two to six seconds, which is the sound rolling round the sky and is
   * not a reverb at all.
   *
   * IT HOLDS A VOICE FOR ITS WHOLE FLIGHT TIME, deliberately. The budget is
   * taken when the strike is scheduled, not when it is heard, so a squall
   * throwing six flashes in ten seconds cannot queue six overlapping rumbles —
   * the later ones are simply refused, which is what a storm sounds like anyway.
   *
   * @param {number} km      how far away the strike was, in kilometres
   * @param {number} energy  0..1, how big it was
   * @param {number|null} bearing radians; null picks one, which is only right
   *                              for a caller that has no flash to agree with
   */
  thunder(km, energy = 1, bearing = null) {
    if (!this.built || this.voices > VOICE_CEILING * 0.8) return;
    const ctx = this.ctx;
    const rng = this.rng;
    /**
     * Clamped at eighteen kilometres, which is fifty-two seconds of flight.
     *
     * Not a range check — a bound on how long one strike may hold a voice. A
     * scheduled buffer source that has not started yet is still a live node and
     * still counted against the ceiling (see the note above about why that is
     * deliberate), and a caller with a runaway distance could otherwise park
     * one for minutes. Eighteen kilometres is also about as far as thunder is
     * audible at all, so the clamp costs nothing real.
     */
    const d = clamp(km, 0.15, 18);
    const e = clamp01(energy);
    const t0 = ctx.currentTime + d / 0.343;
    /**
     * Placed at a fixed audible radius on the strike's bearing rather than at
     * its real distance, and the reason is the same one `_howl` gives: an
     * inverse-distance panner at four thousand metres is silence, and what the
     * bearing is for is telling you WHICH WAY the storm is. So the direction is
     * real, the radius is a stage convention, and the distance is spent on the
     * level, the low-pass corner and the length of the onset instead — which is
     * where a listener actually reads it from.
     */
    const a = bearing === null ? rng() * Math.PI * 2 : bearing;
    const r = rngRange(rng, 90, 150);
    const ears = this._ears();
    _at.x = ears.x + Math.cos(a) * r;
    // High. Thunder is a sheet of sky, and the elevation is the one cue that
    // stops it reading as an explosion at ground level behind the trees.
    _at.y = ears.y + rngRange(rng, 30, 60);
    _at.z = ears.z + Math.sin(a) * r;
    const spatial = this.engine.createSpatial(_at, {
      refDistance: 60,
      // Nearly flat. The radius above is a convention, so letting the panner
      // roll it off steeply would throw away the level this method has just
      // spent care deriving from `km`.
      rolloff: 0.5,
      maxDistance: 220,
    });

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    // Very slow, which drags the pink buffer's energy down an octave and a half
    // before the filters see it. The alternative — a steeper low-pass on
    // unity-rate noise — throws away most of the signal and leaves a bed with
    // no body in it, which is exactly the failure the fire's body layer
    // records solving the same way.
    src.playbackRate.value = 0.28;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    // Nothing below 38 Hz. Small speakers cannot reproduce it, headphones can,
    // and the limiter has to hold it back for everybody either way — so it is
    // pure cost.
    hp.frequency.value = 38;
    hp.Q.value = 0.4;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    // 220 Hz on top of you, 90 at the horizon. See the header.
    lp.frequency.value = 220 - clamp01((d - 0.5) / 12) * 130;
    lp.Q.value = 0.35;

    // A far strike arrives as a swell and a near one as an edge: the onset is
    // the sound having taken more or fewer paths to reach you.
    const rise = 0.04 + clamp01(d / 12) * 1.1;
    const length = rise + rngRange(rng, 2, 6) * (0.55 + clamp01(d / 10) * 0.75);
    /**
     * 0.16 at the top, which is loud — roughly five times the wind bed's peak.
     * It is meant to be: thunder is the loudest thing this world can make and a
     * polite one is a fridge. The transient is the reason the report on this
     * pass flags the limiter: see `pumping-is-a-swing-not-an-average`, a 6 dB
     * event is exactly the shape that moves that metric even when the average
     * level does not.
     */
    const peak = 0.16 * e * (1 - clamp01((d - 0.5) / 22) * 0.8);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(peak, t0 + rise);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + length);
    src.connect(hp).connect(lp).connect(env).connect(spatial.input);
    src.start(t0, rng() * 3);
    src.stop(t0 + length + 0.05);
    this.voices++;

    let crack = null;
    if (d < 4) {
      /**
       * The leader stroke. Short, band-passed at 200-900 Hz, and it arrives a
       * fraction BEFORE the peak of the rumble rather than on it — the crack is
       * the direct path and the rumble is everything that went round.
       */
      const cSrc = ctx.createBufferSource();
      cSrc.buffer = this.noiseBuffer;
      cSrc.loop = true;
      cSrc.playbackRate.value = 0.75;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = rngRange(rng, 240, 620);
      // 0.5. Anything approaching a corner here is a note, and a note in a
      // thunderclap is a gunshot in a film.
      bp.Q.value = 0.5;
      const cEnv = ctx.createGain();
      const cLen = rngRange(rng, 0.5, 1.1);
      const cPeak = peak * 0.85 * (1 - d / 4);
      cEnv.gain.setValueAtTime(0.0001, t0);
      cEnv.gain.linearRampToValueAtTime(cPeak, t0 + 0.012);
      cEnv.gain.exponentialRampToValueAtTime(0.0001, t0 + cLen);
      cSrc.connect(bp).connect(cEnv).connect(spatial.input);
      cSrc.start(t0, rng() * 3);
      cSrc.stop(t0 + cLen + 0.05);
      crack = { cSrc, bp, cEnv };
    }

    src.onended = () => {
      this._release(src);
      try {
        hp.disconnect();
        lp.disconnect();
        env.disconnect();
        if (crack) {
          crack.bp.disconnect();
          crack.cEnv.disconnect();
        }
        spatial.dispose();
      } catch {
        /* already gone */
      }
    };
  }

  /**
   * THE FERRY'S BELL.
   *
   * The raft has had a brass bell mesh since it was built and the only thing
   * that has ever happened when it docks is a line of HUD text. A bell you can
   * see and cannot hear is worse than no bell, because the player has already
   * been told there is one.
   *
   * THE RECIPE IS music.js's AND THAT IS THE POINT. That file's `bell` is two
   * sines at a ratio of 7.12 with a fast-decaying modulation index — its own
   * header calls 7.1 "inharmonic, a bell" — and it is already the sound of a
   * struck metal object in this project. Reproducing it here with different
   * numbers would give the world two bells that disagree. What changes is where
   * it goes: through a spatial source at the raft on `sfxBus`, not through the
   * jukebox bus, because this is an object in the world making a noise and not
   * a note in a piece of music.
   *
   * THE DISTANCE LOW-PASS DOES THE WORK AND NOTHING ELSE HAD TO. A bell's
   * partials sit up in 2-6 kHz, and `createSpatial`'s air filter takes its
   * corner to about 2.5 kHz at eighty metres and to 700 Hz at two hundred — so
   * a bell heard across the river is almost entirely its fundamental, which is
   * exactly what a real one is through that much wet forest. No extra filter,
   * no distance term in the gain, no second recipe for "far".
   *
   * `strikes` rather than two calls from the caller, because the gap between
   * two strikes of the same bell is a fact about the bell — a bosun's double is
   * about three quarters of a second and the second strike is a shade quieter
   * because the metal is still moving.
   *
   * @param {{x:number,y:number,z:number}} at   where the bell is
   * @param {number} strength 0..1
   * @param {number} strikes  how many times it is struck
   */
  bell(at, strength = 1, strikes = 1) {
    if (!this.built || this.voices > VOICE_CEILING * 0.8) return;
    const ctx = this.ctx;
    const rng = this.rng;
    const s = clamp01(strength);
    const spatial = this.engine.createSpatial(at, {
      refDistance: 10,
      // Shallow, because a bell is meant to carry. This is the sound that tells
      // somebody on the far bank that the ferry has arrived, and a rolloff that
      // buried it at forty metres would delete the only reason it exists.
      rolloff: 0.9,
      maxDistance: 260,
      bus: this.engine.sfxBus,
    });
    const ears = this._ears();
    spatial.setDistance(Math.hypot(at.x - ears.x, at.y - ears.y, at.z - ears.z));

    const t0 = ctx.currentTime + 0.01;
    const nodes = [];
    let last = null;
    let t = t0;
    for (let i = 0; i < Math.max(1, strikes); i++) {
      /**
       * MIDI 79, which is G5 at 784 Hz.
       *
       * A small brass bell on a raft, not a church bell. The fundamental has to
       * be high enough that the air filter at two hundred metres still passes
       * it — the corner there is about 700 Hz — and low enough that the 7.12
       * partial at 5.6 kHz is not the whole sound close up. 79 clears the first
       * by a hair, which is deliberate: at the very edge of hearing the bell
       * does not fade, it goes dull and then dark, which is the right way for a
       * sound to leave.
       */
      const f = 440 * 2 ** ((79 + rngRange(rng, -0.25, 0.25) - 69) / 12);
      const decay = 3.2;
      const carrier = ctx.createOscillator();
      carrier.type = 'sine';
      carrier.frequency.value = f;
      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.value = f * 7.12;
      const modGain = ctx.createGain();
      /**
       * Index 4.5 rather than music.js's 6, and it is the one number that was
       * changed.
       *
       * The index sets how much energy goes into the sidebands, and at 7.12 the
       * first pair lands at 5.6 and 6.4 kHz — the top of the band `audio-probe`
       * measures. In the jukebox that is fine, because a bell there is one note
       * in a mix at 0.05 gain. Here it is a solo event at close range. 4.5 is
       * about four decibels less in the partials, which still reads
       * unmistakably as struck brass because the ratio is doing the work, not
       * the depth. It is still worth re-reading `npm run audio` after this.
       */
      modGain.gain.setValueAtTime(f * 4.5, t);
      modGain.gain.exponentialRampToValueAtTime(f * 0.02, t + decay * 0.55);
      mod.connect(modGain).connect(carrier.frequency);

      const env = ctx.createGain();
      // The second strike is quieter: the metal has not stopped moving, so the
      // hammer meets a bell that is already giving.
      const g = 0.19 * s * (i === 0 ? 1 : 0.72);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(g, t + 0.006);
      env.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      carrier.connect(env).connect(spatial.input);
      carrier.start(t);
      mod.start(t);
      carrier.stop(t + decay + 0.05);
      mod.stop(t + decay + 0.05);
      nodes.push(modGain, env);
      last = carrier;
      t += rngRange(rng, 0.62, 0.86);
    }
    this.voices++;
    last.onended = () => {
      this._release(last);
      try {
        for (const n of nodes) n.disconnect();
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
   * @param {object|null} [p.lightning] the strike that fired THIS frame, or
   *   null on every other frame. See the thunder block below for the shape and
   *   for why the caller supplies the distance rather than this file inventing
   *   one.
   */
  update(
    dt,
    { gust = 0, canopy = 0.5, tripLevel = 0, dark = null, rain = 0, lightning = null } = {}
  ) {
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
    const leaves = clamp01(canopy);
    const leafy = 0.35 + leaves * 0.65;
    /**
     * Recorded for the console, exactly as `gustValue` above is and for the
     * same reason: this is a derived number that decides three audible things
     * and there is otherwise no way to ask what it currently is. `RR.ambience`
     * is a getter on the realm object, so `RR.ambience.canopyValue` answers
     * "how closed does the audio think it is here" from a live page — which is
     * the only practical way to check the mapping in main.js against a place
     * you can see.
     */
    this.canopyValue = leaves;

    /**
     * ==== THE CANOPY IS A REAL NUMBER NOW, AND IT IS SPENT THREE WAYS ========
     *
     * This parameter has been documented as "0..1, how much foliage is
     * overhead" since the file was written, and main.js passed the literal 0.6
     * for the whole of that time — so the `leafy` line above, which was always
     * correct, was computing a constant. The value now comes from counting
     * trunk-radius entries in the collider grid within fourteen metres (see the
     * block in main.js).
     *
     *   1. `leafy`, above. More leaves overhead is more surface for the wind to
     *      make a noise on, so the wind's level and its band-pass centre both
     *      open up under trees. Unchanged code; it just stopped being a
     *      constant.
     *
     *   2. The canopy surge, below, is now GATED on there being a canopy. A
     *      swell of leaf noise from six metres over your head in the middle of
     *      a bald clearing is the single most obviously wrong thing this file
     *      could do, and it has been doing it in every meadow in the world.
     *
     *   3. The room send, here. A thicket is wetter and closer than a clearing
     *      — see `engine.setThicket` for why that is a send and not a second
     *      reverb, and for why half canopy is exactly the send this project has
     *      always had.
     *
     * `setThicket` has its own deadband and returns without touching the graph
     * when nothing has moved, so calling it every frame off a value the caller
     * only recomputes at 5 Hz costs one subtract and one compare.
     */
    this.engine.setThicket?.(leaves);
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
    /**
     * `insectScale` is the LAND's share, and it is a different quantity from
     * `insectDuck` above even though they multiply into the same place.
     *
     * The duck asks "is a recording already saying this", and moves over
     * seconds as a bed fades in. The scale asks "does this land have insects at
     * all", and is a constant for the session. Keeping them separate is what
     * lets a winter wood be quiet WITHOUT a bed loaded and lets a rainforest
     * bed duck a wall that is at full cry — one factor could not express both.
     * Exactly 1 in the rainforest, so nothing pinned moves. See `setLand`.
     */
    this.cicadaGain.gain.setTargetAtTime(
      0.55 * day * day * (1 - clamp01(rain) * 0.8) * insectDuck * this.insectScale,
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
    this.katydidGain.gain.setTargetAtTime(
      0.4 * night * night * insectDuck * this.insectScale,
      now,
      8
    );

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
    /**
     * THE WOOD GOES QUIET BEFORE YOU FEEL ANYTHING.
     *
     * A minute after you swallow it, before anything looks different, the birds
     * have stopped — and that is how you know. It was not happening, because
     * this was LINEAR in the level: thirty seconds in, at an eased level of
     * about 0.12, the wood was six per cent quieter, which is inaudible against
     * a chorus whose own intervals already vary by a factor of five.
     *
     * A smoothstep finished by 0.22 puts the whole of the hush inside the come
     * up. Computed against the envelope in trip/state.js with the director's
     * own rising damp: 4.6% quieter at fifteen seconds, 33% at thirty, 54% at
     * forty-five, and the full 60% by one minute — before uSwell is visible and
     * long before the melt exists at all.
     *
     * 0.6 AND NOT 1.0. A wood with no birds in it is a dead wood, and silence
     * you can point at is an effect; two chirps a minute where there were five
     * is a thing you notice you have noticed.
     *
     * wildlife.js CARRIES THE IDENTICAL TWO LINES on its song gain, and its
     * own header requires that the two agree. If this curve changes, that one
     * changes with it.
     */
    const hushQ = Math.min(1, Math.max(0, tripLevel / 0.22));
    const hush = 1 - hushQ * hushQ * (3 - 2 * hushQ) * 0.6;
    this._nextBird -= dt * this.birdRate * hush;
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
    /**
     * AND NOW IT ONLY HAPPENS WHERE THERE ARE LEAVES. See the canopy block
     * above.
     *
     * The gate is on the ARM as well as the fire, so walking out of the trees
     * mid-gust does not leave a surge queued to go off over an empty meadow the
     * moment you cross the treeline. 0.22 rather than 0 because a clearing in
     * this world still has a treeline thirty metres away and hearing the wind
     * hit THAT is right; what is wrong is hearing it hit something directly
     * overhead when there is sky up there. The strength is scaled by the canopy
     * too, so the transition is a fade rather than a switch — a surge that
     * appeared at full level the instant the count crossed a threshold would be
     * audible as a threshold.
     */
    this._surgeHold -= dt;
    if (g < 0.42) this._gustArmed = true;
    if (this._gustArmed && g > 0.58 && this._surgeHold <= 0 && leaves > 0.22) {
      this._gustArmed = false;
      this._surgeHold = rngRange(rng, 15, 32);
      this._canopySurge((0.45 + g * 0.75) * (0.45 + leaves * 0.55));
    }

    /**
     * ==== THE FIRE ===========================================================
     *
     * Two gains chasing the distance, and one scheduler. `near` is 1 inside
     * four metres and reaches EXACTLY ZERO at `FIRE_RANGE` — see the constant
     * for why the zero has to be exact rather than merely small.
     *
     * SQUARED, so the fall-off is heard as a fall-off. A linear ramp over
     * thirty metres of walking is a fader being moved at a constant rate, which
     * is the one thing a continuous bed must never sound like; the square puts
     * most of the change in the last ten metres, which is where it is in a real
     * clearing because that is where the geometry stops being a point source.
     *
     * THE HISS FALLS AWAY FASTER THAN THE BODY, which is the distance cue that
     * does the actual work. A fire at twenty-five metres is a low mutter with
     * no crackle in it; the crackle is the near-field sound. Cubing the hiss
     * against squaring the body costs nothing and is the difference between
     * "the fire is quieter" and "the fire is further away".
     *
     * The time constants are 0.4 and 0.5 — much shorter than the insect wall's
     * six seconds, because this one is supposed to track your walking. Long
     * enough that a frame where `nearestFire` switches to a different hearth
     * does not click.
     */
    const fireNear = clamp01(1 - (this.fireDistance - 4) / (FIRE_RANGE - 4));
    this.fireBodyGain.gain.setTargetAtTime(0.075 * fireNear * fireNear, now, 0.5);
    this.fireHissGain.gain.setTargetAtTime(0.05 * fireNear ** 3, now, 0.4);
    if (this.fireDistance < FIRE_POP_RANGE) {
      this._nextPop -= dt;
      if (this._nextPop <= 0) {
        this._firePops(now + 0.01, clamp01(1 - this.fireDistance / FIRE_POP_RANGE));
        /**
         * 0.6 to 4 seconds, and the spread matters more than the mean. A fire
         * that pops on a tight interval is a metronome however fast it is; the
         * long gaps are what make the next cluster an event.
         */
        this._nextPop = rngRange(rng, 0.6, 4);
      }
    }

    /**
     * ==== THUNDER ============================================================
     *
     * THE INTERFACE, WRITTEN AGAINST A LAYER THAT DID NOT EXIST YET.
     *
     * When this was built there was no lightning anywhere in `atmosphere.js`.
     * There is now, it publishes exactly this shape as `atmosphere.strike`, and
     * `main.js` passes it straight through. One difference from what was
     * predicted, and it is the safe direction: the descriptor is held for the
     * whole ~0.2 s of the flash rather than for a single frame, so a consumer
     * that misses the rising frame — a dropped frame, a tab regaining focus —
     * still hears the thunder. The `_lastStrike` guard below already makes that
     * safe, which is why it was written.
     *
     * The shape it is coded against — and the one a weather layer should expose
     * — is a descriptor that is non-null while a flash is happening:
     *
     *     { id, energy, bearing, km }
     *
     *   `id`      anything that differs between strikes and is the same on two
     *             clients: a strike index, or the hash that fired the flash.
     *             Compared against `_lastStrike` so a caller that latches the
     *             value for two frames cannot double-trigger.
     *   `energy`  0..1, how big the flash was.
     *   `bearing` radians, the direction of the strike in world xz.
     *   `km`      how far away it was.
     *
     * `km` COMES FROM THE CALLER AND IS NOT INVENTED HERE, and that is the
     * whole reason this reads a descriptor rather than a level. The world is a
     * pure function of the seed and the clock: two people in one wood must see
     * the same flash and then count the same number of seconds. If this file
     * rolled the distance off its own rng, the two would hear the same thunder
     * at different times, which is a bug you would never find because each
     * client is individually convincing. The fallback below exists only so a
     * caller that has a flash and no distance still makes a noise — it derives
     * `km` from `energy`, which IS shared, rather than from `rng`.
     */
    if (lightning && lightning.id !== this._lastStrike) {
      this._lastStrike = lightning.id;
      const e = clamp01(lightning.energy ?? 1);
      // A bright flash is a near one. Squared, because apparent brightness
      // falls off with the square of distance and this is that relation read
      // backwards — it puts most of the visible range inside four kilometres,
      // which is where a strike is worth a crack.
      const km = Number.isFinite(lightning.km) ? lightning.km : 0.6 + (1 - e) ** 2 * 15;
      this.thunder(km, e, Number.isFinite(lightning.bearing) ? lightning.bearing : null);
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

  /**
   * Where the nearest lit fire is. Same contract as `setStreamPosition`: copied
   * out by value, because the caller passes a shared scratch and keeps writing
   * to it.
   *
   * BOTH SPATIALS MOVE TOGETHER. They are one place heard on two buses, and a
   * frame in which the bed had followed the new hearth and the pops had not
   * would be a fire crackling somewhere the fire is not. There is no case where
   * these should ever differ, so they are written by one method rather than two.
   */
  setFirePosition(p) {
    this.fireSpatial?.setPosition(p);
    this.firePopSpatial?.setPosition(p);
    this.firePos.x = p.x;
    this.firePos.y = p.y;
    this.firePos.z = p.z;
  }

  setListenerDistanceToFire(d) {
    this.fireDistance = d;
    const clamped = clamp(d, 0, 200);
    this.fireSpatial?.setDistance(clamped);
    this.firePopSpatial?.setDistance(clamped);
  }

  dispose() {
    if (!this.built) return;
    for (const n of [
      this.windSource,
      this.streamSource,
      this.streamLfo,
      this.fireBodySource,
      this.fireHissSource,
      this.fireHissLfo,
    ]) {
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
