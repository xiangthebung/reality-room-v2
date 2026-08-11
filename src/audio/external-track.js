import { clamp01 } from '../core/util.js';
import { TUNING, subscribe as onTuningChange } from './tuning.js';

/**
 * A YouTube link, playing.
 *
 * The counterpart to `music.js`'s `Jukebox`, for the one case that isn't
 * synthesised. Where `Jukebox` sums to a single mono output (see that file's
 * header on why), this is genuinely stereo and gets a genuinely stereo
 * treatment: the two channels are split and each becomes its OWN spatial
 * source at its own speaker position, rather than one `PannerNode` fed a
 * stereo signal. A `PannerNode` models one point in space — see `engine.js`'s
 * HRTF comment — so feeding it two channels does not yield two independently
 * localised speakers, it yields one position with the width folded in.
 * Splitting first is the only way `engine.createSpatial()`'s existing
 * primitives produce real left/right separation, and it needs no changes to
 * `engine.js` to do it: this file just calls `createSpatial` twice.
 *
 * THOSE TWO POSITIONS ARE TWO CABINETS RATHER THAN TWO POINTS INSIDE ONE, and
 * the constructor could not tell the difference — it takes the same two vectors
 * it always did. What changed is that they are metres apart instead of 1.1,
 * which is the difference between a separation the panners can express and one
 * they cannot. See `world/speakers.js` for why that mattered enough to put a
 * second box in the clearing.
 *
 * AND THOSE TWO VECTORS NOW MOVE. The speakers are furniture the player
 * arranges, so the cabinet a channel is coming out of can be somewhere else by
 * the next keypress. This file needs no per-frame work for that and does none:
 * `world/speakers.js` mutates the same two `Vector3`s in place rather than
 * handing out new ones, so `setListener` reads the new positions on the next
 * frame for free, and the only thing that has to be told is the pair of
 * `PannerNode`s whose coordinates were written once at construction — hence
 * `speakersMoved`, called on the keypress and never per frame.
 *
 * THERE WAS A THIRD POSITION HERE AND IT IS GONE. A subwoofer stood between the
 * cabinets taking everything below 110 Hz off a Linkwitz-Riley crossover; the
 * player asked for it to go, and with it went the crossover, which existed for
 * nothing else. The removal is very nearly level-neutral and NOT exactly so: the
 * low band comes back 1.55 dB hotter without the sub than with it, measured as a
 * mono 60 Hz tone through both graphs at `trims.music`. The sub's gain was
 * matched to this file's two paths at the 0.5/0.5 cabinet mix and the knobs are
 * at 1/1 now, so `dryMix + wetMix` had stopped landing on the mark and the box
 * was quietly costing a decibel and a half. The limiter does not care — see
 * `world/speakers.js` for the swing numbers — but the arithmetic below is still
 * the first thing to check if the bass ever moves again.
 *
 * WHAT THIS CANNOT DO THAT `Jukebox` CAN: be bent IN TIME by the trip.
 * `director.js` holds one reference, set once at startup, to the synthesised
 * `Jukebox` — tempo/detune bending only makes sense on notes being generated in
 * real time, and a slowed-down streamed file just sounds broken, not strange
 * (see `director.js`'s own comment). `main.js` keeps this as a second, separate
 * object rather than something `music` ever gets reassigned to, specifically so
 * the trip and the wildlife's key-following keep working on the real `Jukebox`
 * and are never silently pointed at something that can't hear them.
 *
 * WHAT IT CAN NOW DO, AND THE SYNTH JUKEBOX CANNOT: be bent IN SPACE. See
 * `setTrip` and `_aim` — the record comes off the cabinets and into the
 * listener's head as the trip climbs, which is available here precisely because
 * this is the stereo one. `Jukebox` sums to mono by design, and a mono source
 * has no image to bring inside a head; it keeps the time-domain half of the
 * treatment, this one gets the spatial half, and neither is missing anything it
 * could have had.
 */

/**
 * How much of the signal reaches the bus without going through the HRTF
 * panners, and why there has to be any at all.
 *
 * `engine.createSpatial` convolves its input with a head-related impulse
 * response. That is the right thing for a bird or a footstep — it is what makes
 * them locatable — but an HRIR is a filter with deep notches in the 4-10 kHz
 * region, and the two speaker anchors are at different angles from the
 * listener, so the left and right channels get *different* notches. On a synth
 * pad that reads as air. On a mastered stereo mix it is comb filtering across
 * the whole image: the top end dulls and every phase relationship the record
 * was mixed with is destroyed. That is the "compressed", "underwater" quality,
 * and no amount of bitrate upstream survives it.
 *
 * So a parallel path carries the signal to the bus unfiltered. It is still
 * distance-attenuated (see `setListener`) — the music must still fade as you
 * walk into the trees, because following the bass line back to the clearing is a
 * real navigational aid — but it is not HRTF-filtered, so the record arrives
 * with its treble intact while the panners keep telling you where the cabinets
 * are.
 *
 * AND IT IS PANNED BY WHERE THE CABINET ACTUALLY IS, WHICH IT DID NOT USED TO
 * BE. THIS IS THE BUG A PLAYER REPORTED AS "GOING DIRECTLY INTO MY EARS".
 *
 * This path used to re-merge the two channels so that left stayed left and
 * right stayed right, straight onto the bus. That is not a position: it is
 * headphone stereo, welded to the head. It does not turn when you turn, it does
 * not swap when you walk past the machine and round behind it, and it does not
 * weaken when you stand off to one side. Half the record — this path is half of
 * it by level — was arriving from nowhere in the world at all, and because it
 * was the unfiltered half it was the loud, bright, attention-getting one. The
 * panners were describing a clearing and this was describing a pair of
 * headphones, and the ear believes whichever one is clearer.
 *
 * So each channel is now panned by the real bearing of its cabinet relative to
 * where the player is looking, and the pan is written every frame. Amplitude
 * panning, not filtering: it costs no treble, which is the entire reason this
 * path exists, and it is anchored in the world, which is the entire reason it
 * was wrong. Stand in front of the pair and the image is wide; turn ninety
 * degrees and it collapses to one side, as a real pair of speakers does; walk
 * round behind them and the image INVERTS, which is the single thing the old
 * path could never do and the reason the complaint existed.
 *
 * NOT `StereoPannerNode`, AND THAT COST A MEASUREMENT TO FIND OUT. THIS IS THE
 * SAME TRAP AS THE 0.707 PAIR BELOW, WEARING A DIFFERENT HAT.
 *
 * The obvious build is one `StereoPannerNode` per channel. It is one node
 * instead of three and it is wrong here, because its law is EQUAL POWER — the
 * correct law for one source moving between two speakers, since what should stay
 * constant is the power arriving from that source. But this is two sources, and
 * on any real record the loud part of them — the bass, the kick, the middle of
 * the mix — is very nearly the SAME SIGNAL. Correlated signals sum by amplitude.
 * Spreading each channel across both outputs therefore adds coherent cross-terms
 * the old merger never had, and the record simply gets louder: `record-space.mjs`
 * measured sober RMS going from 0.1195 to 0.1432 and the limiter's swing
 * climbing straight back to where the pumping complaint started. Nothing about
 * the image was wrong; it was the level, arriving from a curve chosen for a
 * situation that is not this one.
 *
 * The law that is right here is CONSTANT AMPLITUDE — left and right gains
 * summing to one rather than squaring to one — built by hand out of two gains
 * per channel into a shared merger. For mono content it reproduces the old
 * merger's output *exactly*, at every pan position, so the image can now swing
 * all the way around the listener without the level moving at all and without
 * anything downstream of here needing to be re-tuned. The cost is the mirror of
 * the equal-power one: genuinely uncorrelated content loses up to 3 dB when the
 * pair collapses to one side. That is the right trade, because the correlated
 * part is the loud part, and the loud part is what the limiter hears.
 *
 * Front and back are ambiguous under amplitude panning — a cabinet directly
 * behind you pans centre, the same as one directly ahead. That is what the HRTF
 * half is for, and it is why this is a blend rather than a replacement.
 *
 * HALF AND HALF, NOT THE EQUAL-POWER 0.707 PAIR, AND THE DIFFERENCE IS NOT
 * PEDANTIC.
 *
 * cos/sin of 45 degrees is the right crossfade for two UNCORRELATED sources —
 * it is what `engine.setRoom` uses to fade between two decorrelated reverb
 * tails. These two paths are not uncorrelated; they are the same recording
 * twice. Correlated signals sum by amplitude, so 0.707 + 0.707 is 1.414, which
 * is +3 dB rather than unity. Measured in an OfflineAudioContext, not
 * reasoned about: the pair rendered 0.707 out for 0.5 in.
 *
 * +3 dB matters here specifically because of where it lands. The limiter in
 * engine.js sits at -5 dBFS with an 18:1 ratio, and a mastered record already
 * arrives close to it; three more decibels is audible pumping, which is one of
 * the things that made pasted links sound compressed in the first place.
 * Recovering the treble by making the pumping worse is not a fix.
 *
 * 0.5 and 0.5 is the honest pair. Where the two paths ARE correlated — below
 * roughly 700 Hz, where a head is small against the wavelength and the HRIR is
 * near flat — they sum to exactly unity, so the bass hits the limiter at
 * precisely the level it did before this change and nothing about its
 * behaviour moves. Up where the HRIR's notches decorrelate them they sum to
 * about 0.707, i.e. 3 dB below the theoretical maximum. That is a real cost
 * and it is worth paying: those frequencies were being notched out altogether
 * before, so 3 dB under maximum is still far more top end than the wet path
 * alone ever delivered.
 */
/**
 * Both live in `tuning.js` now, as `dryMix` and `wetMix`, so the balance between
 * treble and localisation can be found by ear with a record playing rather than
 * by argument. The argument above is still the reason the DEFAULTS are what they
 * are, and the 0.707 trap it describes is still the trap.
 */

/** Matches the `spatialOpts` below — see `setDistance`. */
const REF_DISTANCE = 4.5;
const ROLLOFF = 1.25;

let _canPlayOpus = null;

/**
 * Whether this browser can decode Opus-in-webm in an `<audio>` element.
 *
 * Asked, not assumed from a User-Agent. Chrome, Firefox and Edge have always
 * been able to; Safari gained it late enough that older macOS and iOS in the
 * wild still cannot, and those are the installs that need the m4a fallback.
 * The answer cannot change within a page load, so it is computed once.
 */
export function canPlayOpus() {
  if (_canPlayOpus === null) {
    _canPlayOpus = document.createElement('audio').canPlayType('audio/webm; codecs="opus"') !== '';
  }
  return _canPlayOpus;
}

export class ExternalTrack {
  /**
   * @param {AudioContext} ctx
   * @param {import('./engine.js').AudioEngine} engine
   * @param {{id: string, title: string}} track
   * @param {import('three').Vector3} speakerL the left cabinet's own position,
   *   held for the life of the track and re-read every frame. Mutated in place
   *   by whoever owns it when the player moves that speaker — see the header.
   * @param {import('three').Vector3} speakerR the right one
   */
  constructor(ctx, engine, { id, title }, speakerL, speakerR) {
    this.id = id;
    this.title = title;
    this.playing = false;
    this.onEnded = null;
    this._ctx = ctx;
    /**
     * How far into a trip the record is, 0..1. Written every frame by `main.js`
     * and read by `_aim`, `_near`, the two level helpers and `setTrip`.
     *
     * ZERO IS THE WHOLE SOBER BEHAVIOUR, exactly and by construction: every trip
     * term below is multiplied by this, so a caller that never mentions a trip
     * gets the graph this file was measured with. `record-space.mjs` drives this
     * class through `setDistance` and never touches `setTrip`, so its numbers
     * keep meaning what they meant.
     */
    this.trip = 0;

    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.src = `/api/youtube/audio?id=${encodeURIComponent(id)}`;

    /**
     * `createMediaElementSource` binds to `this.el` permanently — it cannot
     * be called again on the same element. The simplest way to live with
     * that is to never try: a fresh `ExternalTrack` (and a fresh `Audio()`)
     * is constructed per pasted link, and the previous one is `dispose()`d.
     */
    const source = ctx.createMediaElementSource(this.el);

    /**
     * Straight into the splitter, full range.
     *
     * There were four biquads here — the high half of a Linkwitz-Riley pair,
     * taking everything below 110 Hz off the cabinets and handing it to a
     * subwoofer standing between them. Both are gone. What is left is the graph
     * as it stood before the sub existed, node for node, which is the reason the
     * deletion needed no re-tuning: a crossover MOVES a band rather than copying
     * it, so putting the filters back in a drawer puts the same total back
     * through the same two boxes.
     */
    const splitter = ctx.createChannelSplitter(2);
    source.connect(splitter);
    this._splitter = splitter;

    // Same numbers as the synth jukebox's own spatial source (main.js) — the
    // cabinet's presence in the room should sound the same regardless of
    // what it happens to be playing.
    const spatialOpts = {
      refDistance: REF_DISTANCE,
      rolloff: ROLLOFF,
      maxDistance: 150,
      bus: engine.musicBus,
    };
    this._left = engine.createSpatial(speakerL, spatialOpts);
    this._right = engine.createSpatial(speakerR, spatialOpts);
    // `createSpatial` returns its input node, which is a GainNode, so the wet
    // trim needs no extra node of its own.
    this._left.input.gain.value = this._wetLevel();
    this._right.input.gain.value = this._wetLevel();

    /**
     * Follow the two cabinet knobs while this track exists.
     *
     * `dryMix` needs nothing — `_aim` reads it on every frame anyway — but the
     * wet trim is written once, here, so without this a slider would only take
     * effect on the NEXT pasted link. Unsubscribed in `dispose`, which is called
     * per link: a track that outlived its own graph and went on writing to two
     * disconnected gain nodes would be invisible until the fourth or fifth
     * paste, when the console started reporting work being done on behalf of
     * records nobody is playing.
     */
    this._unsubscribeTuning = onTuningChange(() => {
      const now = this._ctx.currentTime;
      const wet = this._wetLevel();
      this._left.input.gain.setTargetAtTime(wet, now, 0.02);
      this._right.input.gain.setTargetAtTime(wet, now, 0.02);
      // `headWidth` is the one trip knob that is baked into per-channel state
      // rather than read on each frame, so it needs re-deriving here or the
      // slider would do nothing until the next pasted link.
      for (const s of this._dry) {
        s.home = s.side * TUNING.headWidth;
        this._aim(s, 0.02);
      }
    });
    splitter.connect(this._left.input, 0);
    splitter.connect(this._right.input, 1);

    /**
     * The dry path — see `dryMix` in tuning.js, and the long note in the header for why
     * this is four gain nodes rather than two `StereoPannerNode`s.
     *
     * The merger stays, and is doing a different job than it used to. It is no
     * longer keeping the channels apart — each channel now reaches both of its
     * outputs — it is simply the only way to put a signal on a specific output
     * channel at all. A gain connected straight to a bus is up-mixed to L = R,
     * so without this every one of these four paths would arrive centred and
     * there would be no image to aim.
     */
    const merger = ctx.createChannelMerger(2);
    merger.connect(engine.musicBus);
    this._merger = merger;
    this._dry = [];
    for (const [side, channel] of [
      [-1, 0],
      [1, 1],
    ]) {
      const gL = ctx.createGain();
      const gR = ctx.createGain();
      splitter.connect(gL, channel);
      splitter.connect(gR, channel);
      gL.connect(merger, 0, 0);
      gR.connect(merger, 0, 1);
      // Each channel starts where its own cabinet is: ±0.55, a stereo pair seen
      // from in front, which is where the player is standing when they paste a
      // link. `_aim` writes the real values on the first frame; this is only so
      // that a track which begins before then — or a harness that never calls
      // `setListener` at all — is not briefly centred.
      //
      // `pan` is where the cabinet actually is; `home` is where this channel
      // sits once the record has come off the cabinets and into the head. The
      // trip crossfades one into the other — see `_aim`.
      const entry = { gL, gR, side, home: side * TUNING.headWidth, pan: side * 0.55, attenuation: 1 };
      this._dry.push(entry);
      this._aim(entry, 0);
    }
    /** The two cabinets, so `setListener` can work out where they are. */
    this._speakers = [speakerL, speakerR];

    this._onEnded = () => {
      this.playing = false;
      this.onEnded?.();
    };
    this.el.addEventListener('ended', this._onEnded);
  }

  /**
   * How far the listener is from the cabinet, in metres. Called each frame.
   *
   * TWO THINGS HAPPEN HERE, AND ONLY ONE OF THEM USED TO.
   *
   * The panners get the engine's usual distance damping, which nothing was
   * calling for this class — so a pasted link sat at a fixed brightness while
   * the synth jukebox next to it got duller as you walked away. The header's
   * claim that the cabinet sounds the same whatever it is playing was simply
   * not true, and this is the line that makes it true.
   *
   * The dry gain is attenuated by hand, because it does not pass through a
   * PannerNode and so gets none of the distance model for free. This
   * reproduces the `inverse` model's own curve with the same refDistance and
   * rolloffFactor the panners were built with, so the two paths fade together
   * and their ratio stays fixed at every distance. If they drifted apart, the
   * music would change character as you walked rather than just getting
   * quieter — which is worse than either path alone.
   *
   * The dry path deliberately skips the air filter the panners have. That
   * filter is what recovers nothing and removes the top end; keeping the
   * distance cue on the wet half is enough to sell the distance, and the whole
   * point of this path is that it is unfiltered.
   */
  /**
   * WHAT THE LOW BAND IS WORTH IN HERE. THERE IS NO NODE FOR IT AND THE NUMBER
   * STILL MATTERS.
   *
   * Below roughly 700 Hz the dry path and the HRTF panners are the same signal —
   * a head is small against the wavelength and the HRIR is near flat down there
   * — so they sum by AMPLITUDE rather than by power. That is the fact everything
   * about the low end here rests on, and it is the reason the subwoofer that
   * used to take this band was set to `dryMix + wetMix` rather than to unity:
   * wired at unity it did not move the low end, it HALVED it, and
   * `record-space.mjs` measured sober low-to-mid falling from 1.545 to 0.790 — a
   * box added to produce more bass, quietly deleting most of it.
   *
   * That match was made when both knobs were at 0.5. They are at 1 now, and an
   * A/B of the two graphs on a 60 Hz tone puts the sum 1.55 dB above what the
   * matched sub was producing — so the formula had drifted off the thing it was
   * fitted to, which is what a formula fitted to one operating point does.
   *
   * If the bass ever moves after a change around here, this is the arithmetic to
   * check: two correlated paths, summing by amplitude, not by power.
   */

  /** The direct path's trim, before distance and panning. */
  _dryLevel() {
    return TUNING.dryMix * (1 + (TUNING.headDry - 1) * this.trip);
  }

  /** The HRTF path's trim. Falls toward `headWet` as the trip climbs. */
  _wetLevel() {
    return TUNING.wetMix * (1 + (TUNING.headWet - 1) * this.trip);
  }

  /**
   * THE RECORD DRAWS NEARER, and this has to happen ONCE, upstream of both
   * paths, rather than separately in each.
   *
   * `headNear` compresses the distance from the listener to the cabinet toward
   * `REF_DISTANCE`, so at 1 the record no longer fades or dulls as you walk into
   * the trees, because a thing inside your head does not. What it costs is real:
   * following the bass line home is a genuine navigational aid in a forest that
   * is the same in all directions, which is why it is a slider.
   *
   * WHY NOT SIMPLY BLEND THE DRY GAIN TOWARD UNITY, which is the obvious
   * implementation and was the first one. The dry path's attenuation and the
   * panners' distance model are two different curves that this file goes to some
   * trouble to keep in exact agreement — see the note on `setDistance`, and the
   * reason given there: if they drift apart, the record changes CHARACTER as you
   * walk rather than just getting quieter. Blending the dry gain toward 1 while
   * the panners still heard the true distance would have done precisely that,
   * and only at intermediate trip levels, which is the hardest place to notice
   * it and the easiest place to blame on something else. Moving the distance
   * itself leaves both curves untouched and still agreeing.
   *
   * Inside `REF_DISTANCE` there is nothing to compress — the inverse model is
   * flat in there — so a listener standing at the cabinet is unaffected either
   * way, and the measuring scripts stand exactly there.
   */
  _near(d) {
    if (!(d > REF_DISTANCE)) return d;
    return REF_DISTANCE + (d - REF_DISTANCE) * (1 - this.trip * clamp01(TUNING.headNear));
  }

  /**
   * How far into the trip we are, 0..1. Called every frame by `main.js`.
   *
   * The dry path needs nothing from here — `_aim` runs every frame off
   * `setListener` and reads `this.trip` itself. What this writes is the one trim
   * that is otherwise only touched when a slider moves: the HRTF path's.
   *
   * GUARDED ON THE VALUE HAVING MOVED, because this is a per-frame call and
   * `setTargetAtTime` on an unchanged target is not free — it is a new automation
   * event on the parameter's timeline, sixty times a second, for the entire
   * sober session in which `trip` never leaves zero.
   *
   * 0.25 s. Slower than the 60 ms the image is aimed with, because this is not
   * tracking the head — it is tracking an envelope that already moves in tens of
   * seconds, and the only thing a short constant could add is frame jitter.
   */
  setTrip(level) {
    const t = clamp01(level);
    if (Math.abs(t - this.trip) < 1e-4) return;
    this.trip = t;
    const now = this._ctx.currentTime;
    const wet = this._wetLevel();
    this._left.input.gain.setTargetAtTime(wet, now, 0.25);
    this._right.input.gain.setTargetAtTime(wet, now, 0.25);
  }

  /**
   * A speaker has been stood somewhere else. Called on the keypress that moves
   * one, never per frame.
   *
   * Only the panners need telling. Everything else in this class reads the two
   * position vectors on the frame it needs them — `setListener` recomputes the
   * bearing and the distance from scratch every time — but a `PannerNode`'s
   * coordinates are three AudioParams written once by `createSpatial`, and a
   * panner left at the old coordinates is a record still coming from the corner
   * of the clearing you just carried the box out of.
   *
   * A direct write rather than a ramp, because this is a position rather than a
   * gain: the source genuinely IS somewhere else now, and interpolating it would
   * be a box sliding across the grass. It is inaudible as a discontinuity — the
   * HRTF convolution is what would zipper, and its input has not jumped.
   */
  speakersMoved() {
    this._left.setPosition(this._speakers[0]);
    this._right.setPosition(this._speakers[1]);
  }

  /**
   * One channel's two output gains, from its pan and its distance.
   *
   * `(1 - p) / 2` and `(1 + p) / 2`, which sum to one at every position — see
   * the constant-amplitude argument in the header. `tau` is 0 during
   * construction, where a ramp would be a fade-in from silence on a node nothing
   * is listening to yet, and non-zero afterwards, where a direct write to a
   * parameter is a click.
   */
  /**
   * ---- and what the trip does to all of it ------------------------------------
   *
   * THREE OF THE FOUR TRIP MOVES LAND IN THIS FUNCTION, because all three are
   * the same two gain nodes written differently.
   *
   * THE IMAGE UNWELDS FROM THE CLEARING. `pan` is the real bearing of this
   * channel's cabinet; `home` is where it sits when the record is in your head.
   * `headLock` crossfades between them. The header of this file argues at
   * length that head-locked stereo is wrong and SOBER IT IS — two descriptions
   * of one clearing, and the ear believes the welded one. At the top of a trip
   * the world's own dry path is being ducked and low-passed out of existence
   * (`recede`, in engine.js), so there is no second description left to
   * contradict. The argument has not been overturned; its premise has.
   *
   * AND IT GETS LOUDER TO REPLACE WHAT THE HRTF PATH TOOK. `headDry` lifts this
   * path as `setTrip` drops the other one. The pair does not sum back to where
   * it started, deliberately: the shortfall IS the headroom the trip's own
   * layers need, and handing it all back here would put the mix straight into
   * the limiter again. See the `headWet` note in tuning.js.
   *
   * The third move, drawing the record NEARER, is not here — it is in `_near`,
   * upstream of both paths, for the reason given there.
   */
  _aim(s, tau) {
    const now = this._ctx.currentTime;
    const t = this.trip;
    const lock = t * clamp01(TUNING.headLock);
    const pan = s.pan + (s.home - s.pan) * lock;
    const d = TUNING.dryMix * (1 + (TUNING.headDry - 1) * t) * s.attenuation;
    const l = d * (1 - pan) * 0.5;
    const r = d * (1 + pan) * 0.5;
    if (tau > 0) {
      s.gL.gain.setTargetAtTime(l, now, tau);
      s.gR.gain.setTargetAtTime(r, now, tau);
    } else {
      s.gL.gain.value = l;
      s.gR.gain.value = r;
    }
  }

  /**
   * Distance only, for callers with no camera to hand — the measuring scripts,
   * which stand the listener at the cabinet and care about the processing rather
   * than about where anybody is looking. Leaves the image where it is.
   */
  setDistance(d) {
    // Drawn nearer by the trip BEFORE anything is derived from it, so the dry
    // attenuation and the three panners are all still describing one distance.
    // At `trip === 0` this returns `d` unchanged. See `_near`.
    const near = this._near(d);
    const far = Math.max(near, REF_DISTANCE);
    const attenuation = REF_DISTANCE / (REF_DISTANCE + ROLLOFF * (far - REF_DISTANCE));
    for (const s of this._dry) {
      s.attenuation = attenuation;
      this._aim(s, 0.15);
    }
    this._left.setDistance(near);
    this._right.setDistance(near);
  }

  /**
   * Where the player is and which way they are facing. Called each frame.
   *
   * Does everything `setDistance` does, per cabinet rather than for the pair,
   * and then aims the dry path — see the long note at the top of this file for
   * why the aiming is the point.
   *
   * THE PAN IS THE SINE OF THE BEARING, and that falls out of the geometry
   * rather than being an approximation of it: for a unit vector towards the
   * cabinet, its component along the camera's RIGHT axis is exactly sin of the
   * angle off centre. Directly ahead gives 0, hard right gives 1, and the
   * curve in between is the one a listener's ears actually produce.
   *
   * FLATTENED TO THE HORIZONTAL FIRST. Without that, looking at the sky would
   * shrink the stereo image towards the centre — the bearing to something on the
   * ground would be mostly *below* rather than mostly to one side — and the
   * record would narrow every time the player looked up, which is a thing no
   * pair of speakers has ever done.
   *
   * 60 ms of smoothing. A fast turn moves this parameter by a lot in a few
   * frames, and a stereo pan written directly is the same discontinuity as any
   * other parameter written directly: a click. Short enough to feel welded to the
   * view, long enough that frame jitter cannot zipper it.
   */
  setListener(camera) {
    const p = camera.position;
    // The camera's own right axis, from its world matrix's first column. Read
    // rather than derived from the yaw, so a trip that rolls or tilts the camera
    // is followed rather than ignored.
    const e = camera.matrixWorld.elements;
    let rx = e[0];
    let rz = e[2];
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl;
    rz /= rl;

    const spatial = [this._left, this._right];
    for (let i = 0; i < 2; i++) {
      const s = this._speakers[i];
      const dx = s.x - p.x;
      const dy = s.y - p.y;
      const dz = s.z - p.z;
      const d = this._near(Math.hypot(dx, dy, dz));
      const flat = Math.hypot(dx, dz) || 1;
      const pan = (dx / flat) * rx + (dz / flat) * rz;

      const far = Math.max(d, REF_DISTANCE);
      this._dry[i].attenuation = REF_DISTANCE / (REF_DISTANCE + ROLLOFF * (far - REF_DISTANCE));
      // The TRUE bearing, always. `_aim` is what crossfades it toward `home`,
      // and it has to be the one doing that: this value is also what the pan
      // returns to when `headLock` comes back down, so writing a locked bearing
      // in here would make the effect one-way.
      this._dry[i].pan = Math.max(-1, Math.min(1, pan));
      // 60 ms: short enough to feel welded to the view, long enough that frame
      // jitter cannot zipper it. Distance and pan share the ramp because they
      // are written to the same two gains.
      this._aim(this._dry[i], 0.06);
      spatial[i].setDistance(d);
    }
  }

  /**
   * Start the link, optionally already some way into it.
   *
   * The offset is how a guest who walks in twenty minutes late hears the same
   * moment of the same track as everybody else: the room says when it started,
   * and this seeks to now minus then. See `applyMusic` in main.js.
   *
   * SET BEFORE `play`, not after, so there is no audible jump — assigning
   * `currentTime` on a paused element positions it silently, whereas seeking a
   * playing one emits whatever was already buffered at the old position first.
   *
   * A seek past the end is clamped to a start rather than refused. The likely
   * cause is a room whose clock has outrun a short track, and beginning it
   * again is a better answer than silence from a jukebox that visibly says it
   * is playing. `duration` is NaN until metadata lands, which the guard treats
   * as "no reason to think this is too far".
   *
   * @param {number} offsetSeconds
   */
  async play(offsetSeconds = 0) {
    if (offsetSeconds > 0) {
      const d = this.el.duration;
      this.el.currentTime = Number.isFinite(d) && offsetSeconds >= d ? 0 : offsetSeconds;
    }
    await this.el.play();
    this.playing = true;
  }

  /** Where the playhead is, in seconds. Used to tell a room where we are. */
  get position() {
    return this.el.currentTime || 0;
  }

  pause() {
    this.el.pause();
    this.playing = false;
  }

  dispose() {
    this._unsubscribeTuning?.();
    this._unsubscribeTuning = null;
    this.el.removeEventListener('ended', this._onEnded);
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    try {
      this._splitter.disconnect();
      this._merger.disconnect();
      for (const s of this._dry) {
        s.gL.disconnect();
        s.gR.disconnect();
      }
    } catch {
      /* already gone */
    }
    this._left.dispose();
    this._right.dispose();
  }
}
