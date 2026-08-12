import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../core/util.js';
import { createImpulseResponse } from './impulse.js';

/**
 * The audio engine.
 *
 * One AudioContext, one graph, built lazily on the first gesture because that is
 * the only moment a browser will let it start.
 *
 *   music ────▶ musicBus ─▶ musicTrim ──────────────┐
 *   world ────▶ worldBus ─▶ worldTrim ─▶ recede ────┤
 *   effects ──▶ sfxBus   ─▶ sfxTrim   ──────────────┼─▶ preMaster ─▶ limiter ─▶ masterTrim ─▶ master ─▶ out
 *   voices ───▶ voiceBus ─▶ voiceTrim ──────────────┘        │
 *                     │                                       └─ analyser (drives the visuals)
 *                     └─(music/world/effects only)─▶ roomSend ─▶ roomVerb ─▶ roomReturn ─▶ preMaster
 *
 * `recede` is the trip's only insert and is transparent at rest — see its own
 * note below, and note that it sits downstream of every send, so the world's
 * reverb keeps its level while the world's dry does not.
 *
 * WHY THE ANALYSER IS ON preMaster. The visuals are driven by what the room
 * actually sounds like, and preMaster is the last point where that is true
 * before the limiter starts changing the gain. Reading after the limiter would
 * mean the picture responded to gain reduction as well as to the music, which
 * shows up as the world dimming on every kick drum.
 *
 * WHY THE PLAYER'S VOLUMES ARE SEPARATE `*Trim` NODES RATHER THAN THE BUS GAIN.
 *
 * Each bus gain already carries a mix decision — music sits at 0.85 against
 * world at 0.9 because that is where the jukebox stops burying the wind. A
 * volume slider that wrote those gains would erase the mix the moment anybody
 * touched it, and "music at 100%" would mean something different from what the
 * tuning meant. So the player's control is a second gain in series: it
 * multiplies the mix instead of replacing it, and every existing caller that
 * reads or writes `musicBus.gain` keeps working with exactly the meaning it had.
 *
 * The trims sit BEFORE the limiter, because a mix control belongs upstream of
 * the thing protecting the output. Master is the exception and sits AFTER it:
 * a master volume in front of a limiter changes how much limiting happens, so
 * turning the game down would also quietly change its dynamics.
 *
 * WHY VOICE IS DRY. `voiceBus` is the only bus that does not feed the forest
 * convolver. Another player talking is not a sound happening in the wood at the
 * listener's position — it arrives at the ear directly — and putting 1.9 s of
 * dark tail on speech is the single fastest way to make it unintelligible.
 * Positional voice is still available and is the better default: run it through
 * `createSpatial(position, { bus: engine.voiceBus })`, which keeps the HRTF
 * panner and the distance low-pass without the room.
 *
 * NOTE ON THE TRIP. `trip-audio.js` connects its own output to `limiter`
 * directly rather than to a bus here, so it is deliberately outside all of
 * this: it is not a mix element the player is meant to balance, and it is not
 * in the analyser's path.
 *
 * WHAT IT TAKES FROM THIS GRAPH IS NOT SYMMETRICAL, AND THE ASYMMETRY IS THE
 * POINT. It taps `trims.world` and `trims.sfx` for its long reverb, and
 * `trims.music` for two paths of its own — a much shorter, band-limited hall
 * and a low shelf. It used to tap `preMaster`, which is all of these at once
 * plus the room returns, and that is what turned a pasted record into noise on
 * a trip; see the send comment in that file. Three consequences to know about
 * before moving anything here:
 *
 *   The trip reads the TRIMS, so it inherits occlusion and the player's volumes
 *   exactly as `roomSend` does. Re-pointing any of those three taps at a bus
 *   instead would leave a trip reverb running on a source the player has turned
 *   off, which is the same haunting the room send's own comment warns about.
 *
 *   `voiceBus` reaches none of it, which is the same rule the rest of this file
 *   applies to speech, now applied to the longest tail in the game.
 *
 *   The room returns reach none of it either. They fed a 1.9-second tail into a
 *   9.5-second one, which is not a bigger space, only a blurrier one.
 *
 * SPATIAL SOUND. Each jukebox cabinet — there are two, standing a few metres
 * apart — is a PannerNode at its own coordinates with an HRTF panner and a
 * distance-dependent low-pass, so the music genuinely gets duller as you walk
 * into the trees. That is worth the complexity: being able to find your way back
 * to the clearing by following the bass line is a real navigational aid in a
 * forest that is otherwise the same in all directions. Two of them rather than
 * one because a stereo record needs two positions to be a stereo record, and
 * faking that inside the listener's head is what `external-track.js` used to do
 * and no longer does.
 */

/**
 * The buses a player can turn down, and the node each one's trim sits on.
 *
 * `master` is listed first because it is the one that is not a mix element:
 * everything else is a share of the picture, master is how loud the picture is.
 */
export const BUSES = ['master', 'music', 'world', 'sfx', 'voice'];

/**
 * Slider position -> gain.
 *
 * Loudness is roughly the cube of amplitude, so a linear slider spends its top
 * third doing almost nothing audible and its bottom tenth doing everything. An
 * exponent close to 3 gives travel that feels even, reaches about -30 dB at the
 * quarter mark, and — the part that matters for not breaking anything — still
 * maps 1 to exactly 1, so a fresh profile leaves every gain in this graph at
 * the value it was tuned to. Zero is forced to a hard zero rather than a very
 * small number, because "off" has to mean off.
 */
const VOLUME_EXPONENT = 2.8;

/**
 * How far a mix bus can be pushed past unity. `master` never uses this — it
 * sits after the limiter (see the graph above), so boosting it would change
 * how much limiting happens rather than just how loud the room is, and stays
 * hard-capped at 1 in `setBusVolume`. The mix buses sit before the limiter,
 * so pushing one past unity is exactly as safe as the tuning that already
 * lives there. Without this, every bus topped out at "the tuned mix, or
 * quieter" and there was no way to bring one forward — only to turn the
 * others down.
 *
 * Kept in sync by hand with the slider `max` in quality.js, which does not
 * import this module by design (see that file's header comment).
 */
export const VOLUME_BOOST_MAX = 1.5;

export function volumeToGain(v) {
  if (v <= 0) return 0;
  if (v <= 1) return Math.pow(v, VOLUME_EXPONENT);
  // Past unity: linear, up to +6 dB (roughly double amplitude) at VOLUME_BOOST_MAX.
  return lerp(1, 2, (Math.min(v, VOLUME_BOOST_MAX) - 1) / (VOLUME_BOOST_MAX - 1));
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this._analyserData = null;
    /** bass, mid, high, transient — smoothed, 0..1. */
    this.levels = new THREE.Vector4();
    this._attack = 0;
    this._prevEnergy = 0;
    /**
     * Player volumes, 0..1, remembered whether or not the graph exists yet.
     *
     * The settings menu is restored from localStorage at page load and the
     * AudioContext cannot be created until the first gesture, so volumes are
     * routinely set several seconds before there is anything to set them on.
     * Keeping the intent here and replaying it at the end of `start()` is what
     * makes "I turned the music down last night" survive a reload.
     */
    this.volumes = Object.fromEntries(BUSES.map((b) => [b, 1]));
    /** bus name -> its trim GainNode, once the graph exists. */
    this.trims = {};
  }

  /**
   * Create the AudioContext without resuming it.
   *
   * Split out of `start()` so the context — and its sample rate, which is
   * available the instant it exists — can be handed to the impulse-response
   * and noise-buffer generators while the gate is still up, instead of after
   * it drops. None of that generation needs the context to be running, only
   * to exist; only `resume()` below needs the gesture, and it still runs
   * inside the same click handler it always did. Safe to call more than once.
   */
  createContext() {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    return this.ctx;
  }

  async start() {
    if (this.ready) return true;
    const ctx = this.createContext();
    if (!ctx) return false;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;

    /**
     * A limiter, not a compressor with a musical ratio.
     *
     * Everything downstream of this is synthesised at runtime and several
     * layers can peak together — a kick, a footstep and a trip surge landing on
     * the same sample is entirely possible. A fast, high-ratio limiter at the
     * end means no combination of them can ever clip, which matters more here
     * than transparency because there is no mastering stage to catch it.
     */
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -5;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 18;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.22;

    this.preMaster = ctx.createGain();
    this.preMaster.gain.value = 1;

    this.musicBus = ctx.createGain();
    this.worldBus = ctx.createGain();
    this.musicBus.gain.value = 0.85;
    this.worldBus.gain.value = 0.9;

    /**
     * Two new buses, both empty on arrival.
     *
     * `sfxBus` is for discrete events — interactions, one-shots, anything a UI
     * grows later. The existing world sounds (wind, birds, stream, footsteps)
     * stay on `worldBus` where they were put, because they are continuous
     * properties of the place rather than effects, and because moving a working
     * caller to prove a point is how you break a working caller.
     *
     * `voiceBus` is reserved for other players and nothing feeds it yet. It
     * exists now so that whoever wires up multiplayer finds a bus with a
     * volume control already attached to it instead of inventing a second one.
     */
    this.sfxBus = ctx.createGain();
    this.voiceBus = ctx.createGain();
    this.sfxBus.gain.value = 1;
    /**
     * Voice starts at 0.95 rather than 1 for headroom, not for taste: speech is
     * the one source here that is not synthesised to a known peak, and a hot
     * microphone arriving on a bus at unity is the one thing in this graph
     * capable of driving the limiter on its own.
     */
    this.voiceBus.gain.value = 0.95;

    /**
     * A short forest reverb on everything, always.
     *
     * Not an effect — a property of the place. Dry synthesis in a 3D forest
     * sounds like synthesis; the same synthesis with 1.9 seconds of dark,
     * sparse tail sounds like it is happening among trees. It is on at a fixed
     * modest level so that when the trip's own long reverb opens up, the change
     * is the space getting *bigger* rather than reverb appearing from nowhere.
     */
    this.roomVerb = ctx.createConvolver();
    this.roomVerb.buffer = createImpulseResponse(ctx, 'forest');
    this.roomSend = ctx.createGain();
    this.roomSend.gain.value = 0.3;
    this.roomReturn = ctx.createGain();
    this.roomReturn.gain.value = 0.85;

    /**
     * A SECOND ROOM, IN PARALLEL, BECAUSE A CONVOLVER CANNOT CHANGE ITS MIND.
     *
     * Assigning a new buffer to a live ConvolverNode does not crossfade — it
     * truncates whatever is in flight and starts the new response from zero.
     * With 1.9 seconds of tail on every sound in the game, that is an audible
     * cut on the frame the player crosses a threshold, which is the single
     * moment the transition has to be invisible. Two convolvers fed from the
     * same send with opposed returns cost one extra FFT block per buffer and
     * can be faded over any duration you like.
     *
     * They share `roomSend`, so a sound is never sent to one room and not the
     * other and there is nothing to get out of step. `setRoom` below is the only
     * thing that touches the two returns.
     */
    this.caveVerb = ctx.createConvolver();
    this.caveVerb.buffer = createImpulseResponse(ctx, 'cave');
    this.caveReturn = ctx.createGain();
    this.caveReturn.gain.value = 0;
    /** 0 is the wood, 1 is underground. See `setRoom`. */
    this._room = 0;
    /** …and how big the underground place is. 0 is a crawl, 1 is a chamber. */
    this._size = 1;

    /**
     * The player's trims, one per bus, inserted between the bus and everything
     * downstream of it.
     *
     * The room send taps the TRIM rather than the bus. It has to: if it tapped
     * the bus, turning the music to zero would leave the jukebox's reverb tail
     * playing in the clearing with no jukebox, which is a haunting and not a
     * volume control.
     */
    for (const name of BUSES) this.trims[name] = ctx.createGain();

    /**
     * THE WOOD, HEARD THROUGH ROCK.
     *
     * An occlusion insert between each bus and its trim: a low-pass and a gain,
     * both wide open by default, closed as the player goes underground. It has
     * to be a FILTER and not just a level. Ten metres of hillside does not turn
     * the birds down, it removes their top two octaves — that is what makes a
     * sound read as "outside, through something" rather than as "outside, quiet"
     * — and it is the only cue that tells you the forest is still up there while
     * you are standing in the dark.
     *
     * WHERE IT SITS IS THE WHOLE DESIGN.
     *
     *   BEFORE the trim, so the player's volume slider still means what it
     *   meant. After it, occlusion would multiply the slider and "world at 50%"
     *   would be a different amount of world depending on where you stood.
     *
     *   BEFORE the room send, which taps the trim — so the reverb hears the
     *   occluded signal, not the open one. Without that, a bird call would
     *   arrive muffled with a perfectly bright forest tail behind it, which is
     *   worse than no occlusion at all: it sounds like a broken filter rather
     *   than like a wall.
     *
     *   NOT ON VOICE. The header's argument for keeping speech dry applies with
     *   more force here: another player is not a sound in the wood, and
     *   low-passing them to 620 Hz because the listener walked into a cave would
     *   make them unintelligible for reasons they cannot see.
     */
    this._occlude = {};
    for (const name of ['music', 'world', 'sfx']) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 20000;
      lp.Q.value = 0.5;
      const gain = ctx.createGain();
      gain.gain.value = 1;
      lp.connect(gain).connect(this.trims[name]);
      this._occlude[name] = { lp, gain };
    }

    this.musicBus.connect(this._occlude.music.lp);
    this.worldBus.connect(this._occlude.world.lp);
    this.sfxBus.connect(this._occlude.sfx.lp);
    this.voiceBus.connect(this.trims.voice);

    /**
     * The one bus that is NOT occluded, because it is what is doing the
     * occluding.
     *
     * Drips, the air moving in the passage, footsteps ringing off rock — those
     * are sounds happening in the room the listener is standing in, and putting
     * them behind the same filter as the birds would mute the cave in proportion
     * to how far into it you were. It joins the world trim rather than
     * preMaster so the World slider still governs it, and joining the trim also
     * hands it the room send for free.
     */
    this.caveBus = ctx.createGain();
    this.caveBus.gain.value = 1;
    this.caveBus.connect(this.trims.world);

    /**
     * THE WORLD STEPS BACK, and it is the only insert in this graph that exists
     * for the trip rather than for the room.
     *
     * Three nodes, all transparent at rest — 20 kHz, 0 dB, unity — and driven
     * only by `trip-audio.js`. A sober session cannot tell this is here.
     *
     * WHERE IT SITS IS, AGAIN, THE WHOLE DESIGN.
     *
     *   AFTER the trim, unlike occlusion, because this is not a property of
     *   where the listener is standing — it is the mix changing shape, and it
     *   belongs downstream of every decision the player and the cave have
     *   already made.
     *
     *   IN THE DRY PATH ONLY. `roomSend` and the trip's own cosmos send both
     *   tap `trims.world` upstream of this, so they keep receiving the world at
     *   full level while what reaches `preMaster` directly falls away. That
     *   asymmetry is not a side effect, it is the point: a source whose dry
     *   drops while its reverb holds is the oldest distance cue there is, and
     *   getting it here means the trip does not have to add a single node to
     *   produce it.
     *
     *   A FILTER AND A CUT, NOT JUST A GAIN. Ten metres of hillside does not
     *   turn the birds down (see the occlusion note above) and neither does
     *   forty metres of air; both take the top off. The peaking section is the
     *   one that is not about distance at all — it scoops the band the record's
     *   detail lives in, so the wood makes ROOM rather than merely getting
     *   smaller. See `worldCarve` in tuning.js.
     *
     * THE CAVE RIDES ALONG, via `caveBus`'s join into this trim, and that is
     * correct: the passage is world too, and a trip underground should have the
     * rock recede exactly as the wood does.
     */
    const recedeLp = ctx.createBiquadFilter();
    recedeLp.type = 'lowpass';
    // Over-damped, like every other broad tilt in this project. A resonant
    // corner sweeping across the whole world is a filter effect, and a filter
    // effect is a buzz.
    recedeLp.frequency.value = 20000;
    recedeLp.Q.value = 0.4;
    const recedeCarve = ctx.createBiquadFilter();
    recedeCarve.type = 'peaking';
    recedeCarve.frequency.value = 1250;
    // Wide — a shade over an octave. Narrow enough to be a notch and the wood
    // acquires a pitch it is missing, which is far more noticeable than the
    // room it was supposed to be clearing.
    recedeCarve.Q.value = 0.9;
    recedeCarve.gain.value = 0;
    const recedeGain = ctx.createGain();
    recedeGain.gain.value = 1;
    this.recede = { lp: recedeLp, carve: recedeCarve, gain: recedeGain };

    this.trims.music.connect(this.preMaster);
    this.trims.world.connect(recedeLp).connect(recedeCarve).connect(recedeGain);
    recedeGain.connect(this.preMaster);
    this.trims.sfx.connect(this.preMaster);
    this.trims.voice.connect(this.preMaster);

    this.trims.music.connect(this.roomSend);
    this.trims.world.connect(this.roomSend);
    this.trims.sfx.connect(this.roomSend);
    // voice does not — see the header.
    this.roomSend.connect(this.roomVerb).connect(this.roomReturn).connect(this.preMaster);
    this.roomSend.connect(this.caveVerb).connect(this.caveReturn).connect(this.preMaster);

    this.preMaster.connect(this.limiter);
    this.limiter.connect(this.trims.master);
    this.trims.master.connect(this.master);
    this.master.connect(ctx.destination);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.72;
    this.preMaster.connect(this.analyser);
    this._analyserData = new Uint8Array(this.analyser.frequencyBinCount);

    this.ready = true;
    /**
     * Replay the player's volumes, and do it AFTER `ready`.
     *
     * `setBusVolume` refuses to touch the graph until the engine says it is
     * ready — it has to, because it is routinely called before the context
     * exists. So this has to come after the flag, not next to the wiring where
     * it reads better: put it above and it silently does nothing, the trims stay
     * at unity, and settings restored from localStorage are quietly ignored on
     * every reload. Which is exactly what happened the first time.
     */
    for (const name of BUSES) this.setBusVolume(name, this.volumes[name]);

    return true;
  }

  /**
   * A spatial source: a gain, a distance low-pass and an HRTF panner.
   *
   * Returns the input node. Feeding it is the caller's business; the geometry
   * is handled here.
   */
  createSpatial(position, { refDistance = 4, rolloff = 1.15, maxDistance = 130, bus = null } = {}) {
    const ctx = this.ctx;
    const input = ctx.createGain();
    // `bus` is new and defaults to exactly what this always did. Positional
    // voice wants `{ bus: engine.voiceBus }`; everything already calling this
    // wants worldBus and gets it without changing a character.
    const destination = bus ?? this.worldBus;

    // Distance damping. High frequencies lose energy over distance far faster
    // than low ones, which is why a distant sound is dull rather than merely
    // quiet — and it is the cue that sells "that music is a long way off".
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = 18000;
    air.Q.value = 0.4;

    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDistance;
    panner.rolloffFactor = rolloff;
    panner.maxDistance = maxDistance;
    panner.positionX.value = position.x;
    panner.positionY.value = position.y;
    panner.positionZ.value = position.z;

    input.connect(air).connect(panner).connect(destination);
    /**
     * ONE PATH, FULLY HRTF-FILTERED. This comment used to describe "a second,
     * drier path straight to the bus" that no line here has ever built, which
     * is worth naming because the missing path turned out to matter: a
     * mastered stereo record run through two HRIRs at two angles comes out
     * comb-filtered and dull, and it is what made pasted YouTube links sound
     * compressed. The fix lives in external-track.js rather than here, because
     * a dry blend that preserves stereo needs a panner per channel aimed by the
     * listener's own bearing, and only that one caller has two channels to keep
     * apart. Everything else feeding this is a mono point source that wants the
     * HRTF undiluted.
     */
    return {
      input,
      panner,
      air,
      setPosition(p) {
        panner.positionX.value = p.x;
        panner.positionY.value = p.y;
        panner.positionZ.value = p.z;
      },
      /** Called each frame with the listener distance, in metres. */
      setDistance(d) {
        const cutoff = 20000 * Math.exp(-d * 0.026) + 420;
        air.frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.15);
      },
      dispose() {
        try {
          input.disconnect();
          air.disconnect();
          panner.disconnect();
        } catch {
          /* already gone */
        }
      },
    };
  }

  /** Point the WebAudio listener at the camera. */
  updateListener(camera, dt) {
    if (!this.ready) return;
    const l = this.ctx.listener;
    const p = camera.position;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const when = this.ctx.currentTime;
    if (l.positionX) {
      // A short ramp rather than an assignment: teleporting the listener on
      // every frame produces zipper noise in the HRTF convolution.
      const t = Math.max(0.008, Math.min(0.05, dt));
      l.positionX.linearRampToValueAtTime(p.x, when + t);
      l.positionY.linearRampToValueAtTime(p.y, when + t);
      l.positionZ.linearRampToValueAtTime(p.z, when + t);
      l.forwardX.linearRampToValueAtTime(fwd.x, when + t);
      l.forwardY.linearRampToValueAtTime(fwd.y, when + t);
      l.forwardZ.linearRampToValueAtTime(fwd.z, when + t);
      l.upX.linearRampToValueAtTime(up.x, when + t);
      l.upY.linearRampToValueAtTime(up.y, when + t);
      l.upZ.linearRampToValueAtTime(up.z, when + t);
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  /**
   * Read the spectrum into three bands plus a transient detector.
   *
   * Bands rather than raw bins because the visuals want musical quantities:
   * something to be pushed by the bass, something to be coloured by the treble,
   * and something that fires on an attack. All three are smoothed here so no
   * shader has to filter.
   */
  sampleLevels(dt) {
    if (!this.ready) return this.levels;
    this.analyser.getByteFrequencyData(this._analyserData);
    const data = this._analyserData;
    const n = data.length;
    const bandEnd = [Math.floor(n * 0.06), Math.floor(n * 0.28), n];
    let start = 0;
    const out = [0, 0, 0];
    for (let b = 0; b < 3; b++) {
      let sum = 0;
      for (let i = start; i < bandEnd[b]; i++) sum += data[i];
      out[b] = sum / Math.max(1, bandEnd[b] - start) / 255;
      start = bandEnd[b];
    }
    // Perceptual weighting: the top band has far less energy in any real mix,
    // so a linear read of it never moves anything.
    out[0] = clamp01(out[0] * 1.25);
    out[1] = clamp01(out[1] * 1.8);
    out[2] = clamp01(out[2] * 3.1);

    const k = Math.min(1, dt * 7);
    this.levels.x += (out[0] - this.levels.x) * k;
    this.levels.y += (out[1] - this.levels.y) * k;
    this.levels.z += (out[2] - this.levels.z) * k;

    // Transient: fast rise, slow fall, on total energy.
    const energy = (out[0] + out[1] + out[2]) / 3;
    const rise = Math.max(0, energy - this._prevEnergy) * 6;
    this._prevEnergy = energy;
    this._attack = Math.max(this._attack * Math.exp(-dt * 3.6), clamp01(rise));
    this.levels.w = this._attack;

    return this.levels;
  }

  /**
   * The legacy absolute master gain. Untouched.
   *
   * This writes `master.gain` directly, so `setMasterVolume(1)` still means
   * "gain exactly 1" and flattens the 0.9 the graph was tuned at, exactly as it
   * always has. The settings menu deliberately does NOT use it — it goes
   * through `setBusVolume('master', …)`, which multiplies the tuned level
   * instead of replacing it. Both paths work and they compose.
   */
  setMasterVolume(v) {
    if (!this.ready) return;
    this.master.gain.setTargetAtTime(clamp01(v), this.ctx.currentTime, 0.05);
  }

  /**
   * A player-facing volume, 0..1, on one of BUSES.
   *
   * Safe before `start()`: the value is remembered and applied when the graph
   * is built. The ramp is a `setTargetAtTime` like every other parameter write
   * in this project — a direct assignment to an audio parameter is a click, and
   * a click is exactly what a volume slider dragged quickly would produce.
   * 30 ms is short enough to feel immediate and long enough that no zero
   * crossing gets stepped over.
   */
  setBusVolume(bus, v) {
    if (!BUSES.includes(bus)) return;
    const value = clamp(Number(v), 0, bus === 'master' ? 1 : VOLUME_BOOST_MAX);
    this.volumes[bus] = value;
    const trim = this.trims[bus];
    if (!this.ready || !trim) return;
    trim.gain.setTargetAtTime(volumeToGain(value), this.ctx.currentTime, 0.03);
  }

  getBusVolume(bus) {
    return this.volumes[bus] ?? 1;
  }

  /**
   * Crossfade the room, 0 = the wood, 1 = underground.
   *
   * EQUAL POWER, NOT EQUAL AMPLITUDE. The two tails are decorrelated noise —
   * different seeds, different lengths — so they sum incoherently and a linear
   * crossfade would dip by about 3 dB in the middle. On a five-second walk
   * through a cave mouth that dip is a hole in the ambience exactly where the
   * transition is supposed to be seamless. `cos`/`sin` sums to constant power
   * for uncorrelated sources, which is what these are.
   *
   * THE SEND RISES AS WELL AS THE ROOM CHANGING. A cave is not just a different
   * reverb, it is a much wetter one — there is nothing in a rock passage to
   * absorb anything, so the ratio of reflected to direct sound is far higher
   * than it is among trees. 0.30 to 0.52 is the difference between "this sound
   * has a cave on it" and "this sound is happening in a cave".
   *
   * Ramped rather than assigned, for the reason every parameter write in this
   * file is ramped: 45 ms is under a frame at walking pace and long enough that
   * no zero crossing is stepped over.
   */
  /**
   * @param {number} t    0 the wood, 1 underground
   * @param {number} size 0 a crawl, 1 a chamber
   *
   * SIZE IS A WETNESS, NOT A SECOND ROOM, and that distinction is the whole of
   * why this is two numbers on one method rather than a third convolver.
   *
   * A tight passage and a big chamber are not different reverbs in any way this
   * graph could afford — they are the same rock, the same absorption, the same
   * total lack of anything soft. What differs is the RATIO of reflected to
   * direct sound, because in a crawl the walls are close enough that the early
   * energy has already died before the tail could build, and in a chamber there
   * is a hundred metres of path length to fill first. So a crawl gets the same
   * IR at a much lower send, and it reads as dead the way a real one does.
   *
   * It must NOT be spent on `t`. Turning the crawl down by lowering the cave
   * crossfade brings the FOREST reverb back up underneath it, which is a wood
   * you can hear through ten metres of rock — the one thing this crossfade
   * exists to prevent.
   *
   * The size default is 1, so every caller that predates this is bit-identical.
   */
  setRoom(t, size = 1) {
    if (!this.ready) return;
    const v = clamp01(t);
    const s = clamp01(size);
    if (Math.abs(v - this._room) < 1e-3 && Math.abs(s - this._size) < 1e-3) return;
    this._room = v;
    this._size = s;
    const when = this.ctx.currentTime;
    const angle = v * Math.PI * 0.5;
    this.roomReturn.gain.setTargetAtTime(0.85 * Math.cos(angle), when, 0.045);
    this.caveReturn.gain.setTargetAtTime(0.95 * Math.sin(angle) * (0.34 + 0.66 * s), when, 0.045);
    this.roomSend.gain.setTargetAtTime((0.3 + 0.22 * v) * (0.48 + 0.52 * s), when, 0.045);
  }

  /**
   * How much rock is between the listener and the wood. 0 = none.
   *
   * The cutoff is swept GEOMETRICALLY. Pitch is logarithmic, so a linear sweep
   * from 20 kHz spends nine tenths of its travel in the top octave and a half,
   * where there is almost nothing to remove, and then closes the last four
   * octaves in the final tenth — which is heard as the forest vanishing in one
   * step at the very end of the walk in. An exponential sweep removes roughly
   * one octave per equal increment of `t`, which is what "sinking into a
   * hillside" actually sounds like.
   *
   * 620 Hz and 0.32 at full: still clearly audible, which is deliberate. The
   * wood going completely silent underground would be cheaper to implement and
   * would cost the best thing about being down there — that you can still hear
   * it, a long way off, through the rock.
   */
  setOcclusion(t) {
    if (!this.ready || !this._occlude) return;
    const v = clamp01(t);
    if (Math.abs(v - (this._occlusion ?? 0)) < 1e-3) return;
    this._occlusion = v;
    const when = this.ctx.currentTime;
    const cutoff = 20000 * Math.pow(620 / 20000, v);
    const level = 1 - 0.68 * v;
    for (const name of ['music', 'world', 'sfx']) {
      const o = this._occlude[name];
      o.lp.frequency.setTargetAtTime(cutoff, when, 0.12);
      o.gain.gain.setTargetAtTime(level, when, 0.12);
    }
  }
}
