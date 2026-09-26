import { clamp01, makeRng, rngRange } from '../core/util.js';

/**
 * What a cave sounds like.
 *
 * The forest's soundtrack is four layers of continuous texture — wind, water,
 * birds, insects — because a wood is never silent and never still. Underground
 * is the opposite object and needs the opposite construction: almost nothing,
 * for a long time, and then one event that you hear all the way out to the end
 * of its tail. That is the whole design, and everything below follows from it.
 *
 *   THE AIR. One very low bed and nothing else. No mid, no top, no melody. It
 *   exists so the silence has a floor — a room tone you stop hearing after
 *   fifteen seconds and notice the absence of the moment you walk out.
 *
 *   THE DRIPS. Discrete, sparse, spatially placed, and the one thing in this
 *   file that has to be right. See `_scheduleDrip`.
 *
 *   THE FOOTSTEPS. `ambience.js` already makes a footstep and it is a thud in
 *   leaf litter. The same body on rock is a click with a ring on it, and the
 *   ring is not this file's reverb — it is `engine.setRoom`, which by the time
 *   you are deep enough for this to fire is most of the way to the cave IR.
 *
 *   THE FLUSH. One event, once, per colony: two hundred bats leaving a ceiling.
 *   Fired from outside — `caves.js` knows where they are, this knows what a wet
 *   transient sounds like. See `flush`, and the roost block in caves.js.
 *
 *   AND THE MOUTH, WHICH IS THE ONLY PART OF THIS THAT PLAYS IN THE OPEN AIR.
 *   Everything above is silent whenever the mix is zero, i.e. everywhere you
 *   normally stand. A cave you cannot hear until you are in it is a cave nobody
 *   finds, and this project has three recorded failures at making one VISIBLE
 *   through the canopy. See `_buildMouth`.
 *
 * IT DOES NOT OWN THE ROOM OR THE OCCLUSION, IT DRIVES THEM. Both live in
 * `engine.js` because both are properties of the graph rather than of this
 * layer — the cave reverb is on the jukebox and the birds and everything else,
 * not on the drips. This file is the only thing that knows how far underground
 * the listener is, so it is the only thing that can say.
 *
 *
 * WHY IT IS DRIVEN FROM ONE NUMBER AND NOT FROM A STATE MACHINE.
 *
 * The first sketch had `enter()` and `leave()` and a boolean, and it is wrong
 * in a way that is worth recording because it is tempting. A cave mouth is not
 * a door: you stand in it, you step half out, you look back in. Anything with
 * an edge in it flaps — the reverb switching twice a second while somebody
 * stands in the entrance is far more noticeable than either state is. `mix` is
 * a continuous 0..1 that the caller has already smoothed, every parameter here
 * is a function of it, and there is no state to be in.
 */

/** The longest gap between drips at full depth, and the shortest. */
const DRIP_MIN = 1.4;
const DRIP_MAX = 9.5;

/**
 * WHERE THE MOUTH STARTS AND STOPS BEING AUDIBLE FROM OUTSIDE.
 *
 * Built on first approach at seventy metres, torn down past a hundred and ten,
 * on the existing voice-room precedent — the hysteresis is not fussiness, it is
 * what stops a player standing on the boundary from building and disposing an
 * AudioBufferSourceNode, two biquads and an HRTF panner twice a second.
 *
 * Seventy is chosen against the thing this exists to defeat: the canopy is
 * opaque past forty metres (see `forest-hides-everything-under-40m`), so the
 * outside voice has to arrive while the mouth is still hidden or it is not
 * doing the job — it would merely be describing something you can already see.
 */
const MOUTH_BUILD = 70;
const MOUTH_DROP = 110;
/**
 * How near you have to be for the cave's own tail to reach you in the open.
 *
 * Thirty metres, and this is the one thing in this file that reaches OUT of the
 * cave and touches the whole mix — `setRoom` is an equal-power crossfade between
 * the wood's reverb and the cave's, so lifting it in the open trades a little
 * forest for a little cave on everything. That is not a liberty: standing in a
 * doorway, your own footsteps and your friend's voice genuinely come back off
 * the passage behind you, and it is the single most convincing thing a cave
 * entrance does before you are in it.
 *
 * 0.16 IS SMALL AND THE CROSSFADE IS WHY IT HAS TO BE STATED IN THE RIGHT
 * UNITS. `setRoom` maps its argument through an equal-power pair, so 0.16 leaves
 * cos(0.16 x pi/2) = 0.97 of the wood's reverb in place and adds sin(...) = 0.25
 * of the cave's before the size factor, which outside a cave is at its 0.34
 * floor. Net: the wood loses three per cent of its tail and gains about a tenth
 * of a cave's. It is a colour on the doorway and can never be a state.
 *
 * Away from a mouth `near` is exactly 0 and this line is bit-for-bit the call
 * that was here before — which matters, because `roomSend` is upstream of the
 * only reverb on every sound in the game and a default that was not exactly the
 * old one would move `audio-probe` on every stage at once.
 */
const MOUTH_ROOM_NEAR = 30;
const MOUTH_ROOM_MAX = 0.16;

let cachedNoise = null;
/**
 * Pink noise for the cave bed. Cached by sample rate and exported so
 * `main.js` can generate it during the shader warm-up wait rather than on
 * the frame `build()` runs, alongside the same generator in `ambience.js`
 * and `wildlife.js`.
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

export class CaveAudio {
  constructor(engine) {
    this.engine = engine;
    this.ctx = null;
    this.built = false;
    this.mix = 0;
    this.depth = 0;
    /** How constricted the passage is here, and how near running water. */
    this.tight = 0;
    this.water = 0;
    this._next = 3;
    this.rng = makeRng('cave-audio');
    /** Counters, so a probe can prove any of this fired. */
    this.drips = 0;
    this.steps = 0;
    /** …and the two new ones. See `flush` and `_buildMouth`. */
    this.flushes = 0;
    this.mouthDrips = 0;
    /**
     * How far under the mountain, 0..1, published by `caveSample` as `deep`.
     *
     * NOT `depth`, WHICH IS METRES WALKED. The shapes header in caves.js argues
     * at length that walked distance is the wrong measure — "you can walk a
     * hundred metres of level tube and be nowhere" — and this layer was the
     * loudest consumer of the wrong one: the drip rate, which is the single
     * thing in this file that tells you how far in you are, was keyed to how far
     * you had strolled rather than to how far you had descended.
     */
    this.deep = 0;
    /**
     * The outside voice: null until a mouth is within MOUTH_BUILD. See
     * `_buildMouth` for the whole of what it is and why it exists.
     */
    this.mouth = null;
    this.mouthK = null;
  }

  build() {
    const engine = this.engine;
    if (!engine?.ready || this.built) return false;
    const ctx = engine.ctx;
    this.ctx = ctx;

    /**
     * The bed: filtered noise, two octaves below anything else in the game.
     *
     * A four-second loop of pink noise through a 24 dB/octave pair at 105 Hz.
     * Two cascaded low-passes rather than one, because a single pole leaves
     * enough 400-800 Hz through to read as hiss, and hiss is the sound of a
     * broken tape rather than of a large dark space.
     *
     * The slow gain wander is what stops it being a test tone. 0.031 Hz is a
     * 32-second period — below the rate at which the ear tracks a change, so it
     * is felt as the room breathing rather than heard as an LFO.
     */
    this.noiseBuffer = pinkBuffer(ctx);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const lp1 = ctx.createBiquadFilter();
    lp1.type = 'lowpass';
    lp1.frequency.value = 105;
    lp1.Q.value = 0.7;
    const lp2 = ctx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.value = 140;
    lp2.Q.value = 0.5;
    this.airGain = ctx.createGain();
    this.airGain.gain.value = 0;
    src.connect(lp1).connect(lp2).connect(this.airGain);
    /**
     * Kept, because the bed now OPENS WITH DEPTH. See `update`.
     *
     * (The paragraph above describes a slow gain wander at 0.031 Hz. No line in
     * this file has ever built one — the description outlived the code, which is
     * the most expensive kind of comment there is. It is real on the OUTSIDE
     * voice, where it belongs more anyway: see `_buildMouth`. The inside bed's
     * level instead varies with `mix` squared, which changes continuously as you
     * walk and is what has actually been stopping it reading as a test tone.)
     */
    this.airLp1 = lp1;
    this.airLp2 = lp2;

    /**
     * The bed goes STRAIGHT TO THE BUS, not through the room.
     *
     * `caveBus` feeds `trims.world`, which feeds `roomSend` — so everything on
     * it is convolved with a 3.6 s cave tail. That is right for a drip and
     * completely wrong for a continuous bed: convolving steady noise with a long
     * IR is a low-pass and a 3.6 s smear, which takes an already-shapeless
     * source and removes what little shape it had, at the cost of a full
     * convolution block per buffer for a signal that cannot benefit. The bed is
     * the room; it does not need to be put in one.
     */
    this.airGain.connect(engine.trims.world);
    src.start();
    this.airSource = src;

    /**
     * THE DRAUGHT, and it is the best exploration cue this game has.
     *
     * Caves breathe. A system with two entrances moves air between them all
     * year, and where the passage narrows that air speeds up and the constriction
     * whistles. Cavers find new cave by following it — cold air on your face out
     * of a crack means there is more, and no other signal in the world tells you
     * that about a place you cannot see into.
     *
     * Here it is a bandpass on the same pink noise, and BOTH its gain and its
     * centre frequency track how tight the passage is. The frequency is the half
     * that matters: a squeeze does not merely get louder, it goes UP, and that
     * rising pitch as the walls close in is a thing people react to before they
     * have worked out what they are hearing. A gain-only version was the first
     * attempt and it read as the volume knob moving.
     *
     * Straight to the bus rather than through the room, for the reason the bed
     * is — see above. It is the sound of the space, not a sound in it.
     */
    const wind = ctx.createBufferSource();
    wind.buffer = this.noiseBuffer;
    wind.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 420;
    this.windFilter.Q.value = 3.2;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wind.connect(this.windFilter).connect(this.windGain).connect(engine.trims.world);
    wind.start();
    this.windSource = wind;

    /**
     * WATER YOU CAN HEAR BEFORE YOU CAN SEE IT.
     *
     * `caves.js` precomputes, per ring, how near a stream run is — smeared over
     * a dozen rings either side — so this rises as you approach and falls as you
     * leave, and it does it around corners, because the measure is distance
     * along the passage rather than line of sight. That is exactly right: sound
     * goes round a bend and light does not, and a noise ahead of you that has no
     * visible source is the single strongest reason anybody has ever kept
     * walking into a cave.
     *
     * Two poles and a highpass. The low end has to come out or it fights the
     * bed, which owns everything under 140 Hz and cost seventeen decibels to
     * find out about — see `update`.
     */
    const stream = ctx.createBufferSource();
    stream.buffer = this.noiseBuffer;
    stream.loop = true;
    stream.playbackRate.value = 0.8;
    const streamHp = ctx.createBiquadFilter();
    streamHp.type = 'highpass';
    streamHp.frequency.value = 240;
    const streamLp = ctx.createBiquadFilter();
    streamLp.type = 'lowpass';
    streamLp.frequency.value = 1700;
    this.streamGain = ctx.createGain();
    this.streamGain.gain.value = 0;
    stream.connect(streamHp).connect(streamLp).connect(this.streamGain).connect(engine.trims.world);
    stream.start();
    this.streamSource = stream;

    /** Drips and footsteps DO go through the room. That is the point of them. */
    this.wetBus = ctx.createGain();
    this.wetBus.gain.value = 1;
    this.wetBus.connect(engine.caveBus);

    this.built = true;
    return true;
  }

  /**
   * Take over the footstep callback.
   *
   * `main.js` assigns `controller.onStep` to the ambience's litter footstep. A
   * second assignment would silently replace it and the wood would lose its
   * footsteps; a second callback slot on the controller would be a change to a
   * file whose job is movement, for a reason that is entirely about audio. So
   * this captures whatever is already there and routes by depth, which keeps
   * both behaviours and puts the decision in the only file that can make it.
   *
   * Idempotent, because a hot reload that ran it twice would otherwise nest the
   * wrapper and play the litter step twice.
   */
  captureStep(controller) {
    if (!controller || controller._caveStepWrapped) return;
    const previous = controller.onStep;
    controller._caveStepWrapped = true;
    controller.onStep = (strength) => {
      /**
       * A CROSSFADE, NOT A CHOICE. Halfway into the mouth a footstep is half
       * gravel and half rock, which is what standing in a cave entrance
       * actually sounds like — and it means there is no depth at which the
       * footsteps change over in one stride.
       */
      const mix = this.mix;
      if (mix < 0.92) previous?.(strength * (1 - mix * 0.85));
      if (mix > 0.06) this.step(strength, mix);
    };
  }

  /**
   * …and the landing, wrapped exactly the same way and for exactly the same
   * reason.
   *
   * `controller.onLand` fires when the body arrives on the floor with an impact
   * of 0..1 (see the landing block in player/controller.js). Underground that
   * floor is rock, and the ambience's `land` is a low thump plus a lighter
   * second grain 45 ms behind it — which down here wants the passage answering
   * on top of it rather than instead of it.
   *
   * Idempotent for the same reason `captureStep` is: a hot reload that ran it
   * twice would nest the wrapper and play the litter thump twice.
   */
  captureLand(controller) {
    if (!controller || controller._caveLandWrapped) return;
    const previous = controller.onLand;
    controller._caveLandWrapped = true;
    controller.onLand = (impact) => {
      const mix = this.mix;
      if (mix < 0.92) previous?.(impact * (1 - mix * 0.85));
      // Scaled up before the clamp because a landing is a harder hit than a
      // stride and this is the same rock voice the footsteps use.
      if (mix > 0.06) this.step(Math.min(1, impact * 1.4), mix);
    };
  }

  /**
   * A footstep on rock.
   *
   * Two parts, and the second one is the whole difference from `ambience.step`.
   * A short broadband click for the heel, then a narrow high-Q band that rings
   * for a fifth of a second — grit skittering, and the wall answering. The
   * litter step is a 320-720 Hz bandpass at Q 0.7 decaying in 120 ms, which is
   * a thud by construction; this is at 1.4-3.2 kHz and Q 9, which is not.
   */
  step(strength = 1, mix = 1) {
    if (!this.built) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;
    const rng = this.rng;
    this.steps++;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = rngRange(rng, 0.85, 1.5);
    src.start(t, rng() * 3);
    src.stop(t + 0.4);

    const click = ctx.createBiquadFilter();
    click.type = 'highpass';
    click.frequency.value = 900;
    const clickEnv = ctx.createGain();
    const peak = 0.1 * (0.45 + strength * 0.7) * mix;
    clickEnv.gain.setValueAtTime(0.0001, t);
    clickEnv.gain.linearRampToValueAtTime(peak, t + 0.005);
    clickEnv.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);

    const ring = ctx.createBiquadFilter();
    ring.type = 'bandpass';
    ring.frequency.value = rngRange(rng, 1400, 3200);
    ring.Q.value = 9;
    const ringEnv = ctx.createGain();
    ringEnv.gain.setValueAtTime(0.0001, t);
    ringEnv.gain.linearRampToValueAtTime(peak * 0.55, t + 0.012);
    ringEnv.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);

    src.connect(click).connect(clickEnv).connect(this.wetBus);
    src.connect(ring).connect(ringEnv).connect(this.wetBus);
    src.onended = () => {
      try {
        click.disconnect();
        clickEnv.disconnect();
        ring.disconnect();
        ringEnv.disconnect();
      } catch {
        /* already gone */
      }
    };
  }

  /**
   * One drip.
   *
   * A sine that falls a fourth in 40 ms into a very short, very resonant
   * decay — which is the whole of a water droplet hitting a pool. The pitch
   * bend is not decoration: a fixed-pitch blip reads as a synthesiser and the
   * downward chirp is what the ear identifies as a small volume of liquid
   * closing behind an impact. Everybody knows this sound and gets it wrong by
   * leaving the bend out.
   *
   * It is PANNED, hard and randomly. A drip in the middle of the stereo field
   * is a sound effect; a drip nine metres to the left, behind you, is a place
   * with water in it. There is no PannerNode and no position — a StereoPanner
   * is one multiply against an HRTF convolution, and for a source that lasts
   * 300 ms and is followed by three seconds of cave reverb the reverb is doing
   * all the spatial work anyway.
   */
  /**
   * TWO HUNDRED BATS LEAVING A CEILING, AND IT IS A TEXTURE RATHER THAN A SOUND.
   *
   * Fired once, by `main.js`, off the roost trigger in `caves.js`. There is no
   * loop, no state and nothing to stop: the whole event is scheduled into the
   * Web Audio clock in one call and then forgotten, which is the same idiom
   * `_drip` uses and the reason a cave with a colony in it costs exactly what a
   * cave without one costs on every frame except this one.
   *
   * WHY IT IS BURSTS OF FILTERED NOISE AND NOT A SYNTHESISED WING.
   *
   * The sound of a colony flushing is not two hundred copies of one wingbeat. It
   * is a dense irregular clatter of membrane against air with no pitch in it at
   * all — everybody describes it as paper, and paper is exactly what a short
   * band-passed noise burst is. This project has already learned the opposite
   * lesson twice from the other direction: the birdsong pass found that an FM
   * voice with too much energy in its harmonics reads as a xylophone, i.e. as a
   * MALLET, because a struck object has a pitch and a bird does not. A wing has
   * even less pitch than a bird.
   *
   * 900-2600 Hz, and the top of that range is deliberate and slightly awkward.
   * The harsh gate in this project's audio checks wants continuous beds out of
   * 2-6 kHz (`continuous-beds-cannot-live-in-2-6khz`), and this reaches into the
   * bottom of it — which is allowed and is the distinction the note itself
   * draws: the rule is about CONTINUOUS content, and this is 1.2 seconds, once,
   * per cave, per session. A flush that stayed under 2 kHz is a rustle in a
   * hedge; the crack at the top of the band is what makes it leather.
   *
   * THE ONSETS ARE UNEVEN AND THE PANS ARE HARD AND RANDOM, both for the reasons
   * `_drip` sets out at length one function down. Evenly spaced onsets are a
   * machine gun within four events; a centred flush is a sound effect rather
   * than two hundred animals going past both sides of your head.
   *
   * Through `wetBus`, so the cave's own 3.6 s tail carries it — which is the
   * whole difference between a clatter and a clatter IN A CHAMBER, and the one
   * thing that tells the player how big the room they cannot see is.
   */
  flush(strength = 1) {
    if (!this.built) return;
    const ctx = this.ctx;
    const rng = this.rng;
    this.flushes++;
    /**
     * 18-30 bursts over about 1.25 s. Fewer and you can count them, which makes
     * it a sequence of events rather than a mass; more and the gaps close and it
     * becomes a continuous noise, i.e. a whoosh, which is the sound of a
     * transition and not of animals.
     */
    const n = 18 + Math.floor(rng() * 13);
    let t = ctx.currentTime + 0.03;
    /** The level of the whole event, and it is the loudest thing down here. */
    const level = (0.35 + 0.65 * this.mix) * strength;
    for (let i = 0; i < n; i++) {
      /**
       * A SHAPE OVER THE TRAIN, so it is a wave and not a block. It starts with
       * one or two, swells as the ceiling comes apart, and thins out — which is
       * the same envelope the vertex shader's per-bat delay puts on the picture,
       * arrived at independently and worth keeping in step.
       */
      const u = i / (n - 1);
      const swell = Math.sin(Math.PI * Math.pow(u, 0.75));

      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      src.playbackRate.value = rngRange(rng, 0.8, 1.6);
      src.start(t, rng() * 3);
      src.stop(t + 0.35);

      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = rngRange(rng, 900, 2600);
      /**
       * Q 2.4, which is broad. A high Q here would ring, and a ringing burst has
       * a pitch — see the block above about mallets. Broad enough to stay noise
       * and narrow enough that the band moves audibly from burst to burst, which
       * is what makes two hundred of them sound like different animals.
       */
      band.Q.value = 2.4;

      const env = ctx.createGain();
      const peak = rngRange(rng, 0.05, 0.135) * level * (0.35 + 0.65 * swell);
      const decay = rngRange(rng, 0.045, 0.12);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(peak, t + 0.006);
      env.gain.exponentialRampToValueAtTime(0.0001, t + decay);

      const pan = ctx.createStereoPanner();
      pan.pan.value = rngRange(rng, -0.95, 0.95);

      src.connect(band).connect(env).connect(pan).connect(this.wetBus);
      src.onended = () => {
        try {
          band.disconnect();
          env.disconnect();
          pan.disconnect();
        } catch {
          /* already gone */
        }
      };
      // 10-95 ms between onsets, drawn flat rather than exponentially: a flush
      // is a burst of activity with a beginning and an end, which is exactly the
      // thing a Poisson process is NOT — see `update`, where the drips need the
      // opposite property for the opposite reason.
      t += rngRange(rng, 0.01, 0.095);
    }
  }

  /**
   * THE MOUTH, HEARD FROM OUTSIDE, WHICH IS THE ONLY LANDMARK THAT REACHES.
   *
   * This file is silent whenever the mix is zero, which is everywhere outside a
   * cave — so for its whole life the most dramatic piece of geometry in the
   * world has been completely inaudible until you were standing in it. Three
   * separate attempts at making a cave mouth VISIBLE from more than forty metres
   * have failed and are recorded (`forest-hides-everything-under-40m`); the
   * conclusion of all three is that a rainforest canopy is opaque and there is
   * no amount of contrast that fixes that. Sound is not stopped by leaves.
   *
   * WHAT IT IS, AND IT IS DELIBERATELY ALMOST NOTHING:
   *
   *   A LOW BED at the mouth's position, through the same cascaded low-pass pair
   *   the inside bed uses. The frequencies are HIGHER than the inside bed's
   *   105/140 and that is not a compromise, it is the requirement: below about
   *   150 Hz an HRTF has essentially no interaural level difference to work
   *   with, so a source down there is heard but cannot be LOCATED — and a
   *   landmark you cannot point at is not a landmark. 190/240 keeps it firmly
   *   under everything in the wood and still gives the panner something to aim.
   *
   *   AND THE SLOW WANDER, at 0.031 Hz — a 32-second period, below the rate at
   *   which the ear tracks a change, so it is felt as the hill breathing rather
   *   than heard as an LFO. (This is the wander the inside bed's comment has
   *   always described and never had. It belongs out here more anyway: the
   *   inside bed's level already moves continuously with the player's own
   *   depth, and a mouth heard from the wood does not.)
   *
   * ONE NUMBER, NO STATE MACHINE. Everything is scaled by `(1 - mix)`, so the
   * outside voice fades out exactly as the inside room fades in and there is no
   * depth at which both are audible or neither is. That is this file's own
   * opening rule applied to the one thing that lives on the other side of it.
   */
  _buildMouth(mouth) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    // Slowed, which drops the whole spectrum a fourth before the filters see it
    // — cheaper than a steeper filter and it also decorrelates this loop from
    // the three other layers reading the same four seconds of buffer.
    src.playbackRate.value = 0.72;

    const lp1 = ctx.createBiquadFilter();
    lp1.type = 'lowpass';
    lp1.frequency.value = 190;
    lp1.Q.value = 0.7;
    const lp2 = ctx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.value = 240;
    lp2.Q.value = 0.5;

    // Two gains in series so the wander is a RATIO and the level is a level.
    // One node doing both would make the depth of the breathing depend on how
    // far away you are, which is exactly backwards.
    const wob = ctx.createGain();
    wob.gain.value = 1;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.031;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.34;
    lfo.connect(lfoDepth).connect(wob.gain);
    lfo.start();

    const gain = ctx.createGain();
    gain.gain.value = 0;

    /**
     * refDistance 9 and a gentle rolloff, because the thing being modelled is a
     * hole in a hillside rather than a point: an aperture that size does not
     * obey inverse-square until you are well outside it, and a steep rolloff
     * would make the whole voice appear over the last fifteen metres, which is
     * inside the canopy's own range and defeats the purpose.
     */
    const spatial = this.engine.createSpatial(mouth, {
      refDistance: 9,
      rolloff: 0.95,
      maxDistance: 150,
    });
    src.connect(lp1).connect(lp2).connect(wob).connect(gain).connect(spatial.input);
    src.start();
    this.mouth = { src, gain, spatial, lfo, lfoDepth, wob, lp1, lp2 };
    this.mouthK = mouth.k;
  }

  _dropMouth() {
    const m = this.mouth;
    if (!m) return;
    try {
      m.src.stop();
      m.lfo.stop();
      m.gain.disconnect();
      m.wob.disconnect();
      m.lfoDepth.disconnect();
      m.spatial.dispose();
    } catch {
      /* already gone */
    }
    this.mouth = null;
    this.mouthK = null;
  }

  /**
   * A drip that comes OUT of the cave instead of happening around you.
   *
   * Roughly one in four, and it is the half of the outside voice that carries
   * the information. A continuous bed tells you a large space is over there; a
   * discrete transient tells you it is a WET large space with a floor and a roof
   * and water falling between them, and it does it in one event. It is also the
   * only part of this that survives a windy afternoon in the wood, because a bed
   * at 200 Hz sits under the canopy noise and a 1.5 kHz tick does not.
   *
   * Through the mouth's own panner rather than the listener-local `wetBus`, so
   * it arrives from the doorway with the same HRTF and the same distance
   * low-pass as the bed — which is what puts the two in the same place. Nothing
   * else about it differs from `_drip`: same falling fourth, same short
   * resonant decay, for the reasons set out there.
   */
  _mouthDrip() {
    const m = this.mouth;
    if (!m) return;
    const ctx = this.ctx;
    const rng = this.rng;
    const t = ctx.currentTime + 0.02;
    this.mouthDrips++;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const f = rngRange(rng, 780, 2400);
    osc.frequency.setValueAtTime(f * 1.32, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.04);

    const env = ctx.createGain();
    /**
     * Louder at source than an inside drip — 0.09-0.26 against 0.035-0.115 —
     * because everything downstream of it takes level away that an inside drip
     * never loses: the panner's distance model, the air low-pass, and the
     * (1 - mix) scaling. At the level the inside drips use, nothing came out of
     * the hole at all past twenty metres.
     */
    const peak = rngRange(rng, 0.09, 0.26) * (1 - this.mix);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t + rngRange(rng, 0.12, 0.3));

    osc.connect(env).connect(m.spatial.input);
    osc.start(t);
    osc.stop(t + 0.45);
    osc.onended = () => {
      try {
        env.disconnect();
      } catch {
        /* already gone */
      }
    };
  }

  _drip() {
    const ctx = this.ctx;
    const rng = this.rng;
    const t = ctx.currentTime + 0.02;
    this.drips++;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    /**
     * 780-2400 Hz. Higher is a smaller droplet into a shallower pool, and the
     * spread matters more than the centre: two drips at the same pitch are one
     * drip repeating, and one drip repeating on a timer is the sound of a level
     * rather than of a cave.
     */
    const f = rngRange(rng, 780, 2400);
    osc.frequency.setValueAtTime(f * 1.32, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.04);

    const env = ctx.createGain();
    const peak = rngRange(rng, 0.035, 0.115) * this.mix;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t + rngRange(rng, 0.1, 0.26));

    const pan = ctx.createStereoPanner();
    pan.pan.value = rngRange(rng, -0.85, 0.85);

    osc.connect(env).connect(pan).connect(this.wetBus);
    osc.start(t);
    osc.stop(t + 0.4);
    osc.onended = () => {
      try {
        env.disconnect();
        pan.disconnect();
      } catch {
        /* already gone */
      }
    };
  }

  /**
   * @param {number} dt
   * @param {number} mix   0..1, how far into a cave the listener is
   * @param {number} depth metres along the passage
   * @param {number} deep  0..1, how far BELOW the mouth. See `this.deep`.
   * @param {object} mouth the nearest doorway, or null. See `_buildMouth`.
   */
  update(dt, mix = 0, depth = 0, tight = 0, room = 1, water = 0, deep = 0, mouth = null) {
    if (!this.built) return;
    this.mix = clamp01(mix);
    this.depth = depth;
    this.deep = clamp01(deep);
    this.tight = clamp01(tight);
    this.water = clamp01(water);
    const ctx = this.ctx;
    const now = ctx.currentTime;

    /**
     * THE OUTSIDE VOICE, FIRST, BECAUSE IT IS THE ONE THING HERE THAT RUNS WHEN
     * THE MIX IS ZERO — i.e. everywhere in the game except inside a cave.
     *
     * Build/teardown hysteresis on the existing voice-room precedent; see
     * MOUTH_BUILD. `mouthK` is the cave the current voice belongs to, so walking
     * from one mouth to another past the drop range rebuilds rather than teleports
     * the source, which would be a bed sliding two hundred metres sideways.
     */
    if (!mouth || mouth.d > MOUTH_DROP || (this.mouthK !== null && this.mouthK !== mouth.k)) {
      this._dropMouth();
    }
    if (mouth && !this.mouth && mouth.d < MOUTH_BUILD) this._buildMouth(mouth);
    if (this.mouth) {
      const m = this.mouth;
      m.spatial.setPosition(mouth);
      m.spatial.setDistance(mouth.d);
      /**
       * ONE NUMBER. `(1 - mix)` and nothing else decides whether you are hearing
       * the cave from outside or from inside — squared, so the outside voice is
       * gone by the time the doorway is behind you rather than lingering half a
       * passage in, which is where the inside bed (on mix squared, the other way
       * round) is arriving.
       *
       * 0.055 is set against the inside bed's 0.075 and the whole of the note
       * there about being wrong by 17 dB in the sub-bass and not noticing. This
       * one lands in the open wood, whose measured RMS is 0.037, and it must be
       * a thing you notice only when you stop walking.
       */
      const out = 1 - this.mix;
      m.gain.gain.setTargetAtTime(0.055 * out * out, now, 0.5);
    }
    /**
     * …AND THE CAVE'S OWN TAIL, REACHING A LITTLE WAY OUT OF THE DOORWAY.
     *
     * See MOUTH_ROOM_NEAR. Composed with `Math.max` against the depth term
     * rather than added to it, so this can only ever raise the cave's share and
     * never fights the inside crossfade — the moment you step in, `mix` is
     * larger than this and the entrance term stops existing.
     */
    const near =
      mouth && mouth.d < MOUTH_ROOM_NEAR
        ? MOUTH_ROOM_MAX * (1 - mouth.d / MOUTH_ROOM_NEAR) * (1 - this.mix)
        : 0;

    /**
     * The reverb now knows how big the room is, and that is the largest single
     * change to what this file sounds like since it was written.
     *
     * One tail for every passage meant a crawl and a chamber were acoustically
     * the same place, so the shape work in `caves.js` — the whole of it — was
     * inaudible. `setRoom`'s second argument is a wetness rather than a second
     * IR; see the note there for why it cannot be spent on the crossfade.
     *
     * Floored at 0.25 rather than 0: even a squeeze in rock is wetter than a
     * wood, and a passage that went fully dry would sound like headphones.
     */
    this.engine.setRoom(Math.max(this.mix, near), 0.25 + 0.75 * clamp01(room));
    this.engine.setOcclusion(this.mix);
    /**
     * …and the one room that is NOT on the send above.
     *
     * Voice is deliberately outside `setRoom` — engine.js argues it at length
     * and net/voice.js records the bug that came of getting it wrong — so speech
     * is the one thing in the mix that would otherwise be exactly as dry sixty
     * metres inside a mountain as it is in the clearing. That is the single most
     * noticeable dead spot down here, because a cave is precisely the place a
     * person expects to hear themselves come back.
     *
     * ON `mix` ALONE AND NOT ON `room`. The size argument that `setRoom` makes
     * is about how wet a crawl is against a chamber, and it is right about the
     * world's own sounds. A voice is not one of them: the taps in engine.js are
     * fixed distances chosen to be countable, and scaling their level by how
     * wide the passage happens to be at your feet would make somebody's speech
     * pulse as they walked, which is a thing no room does.
     */
    this.engine.setVoiceRoom(this.mix);

    /**
     * The draught, on the SQUARE of tightness, so it is genuinely absent in the
     * open and arrives as the walls close rather than following you around.
     */
    const squeeze = this.tight * this.tight;
    this.windGain.gain.setTargetAtTime(0.034 * this.mix * squeeze, now, 0.45);
    this.windFilter.frequency.setTargetAtTime(360 + 980 * this.tight, now, 0.6);
    this.streamGain.gain.setTargetAtTime(0.052 * this.mix * this.water, now, 0.3);
    /**
     * The bed comes up on the SQUARE of the mix, so it is inaudible in the
     * entrance and arrives with the darkness rather than before it.
     *
     * 0.075 and not the 0.5 this was first written at, and the difference is
     * not taste — it is the one number a probe caught that no amount of
     * listening on this machine would have. Measured on the master bus,
     * thirty metres in, the bed at 0.5 gave an RMS of 0.259 against the open
     * wood's 0.037: SEVEN TIMES the loudness of the entire forest, with a
     * spectral centroid of 82 Hz. Every other layer was still there and still
     * correct, and all of them were underneath a wall of sub-bass driving the
     * limiter. Sub-100 Hz content is the easiest thing in an audio graph to be
     * wrong about by 17 dB and not notice, because small speakers do not
     * reproduce it and headphones make it feel like presence rather than level.
     */
    this.airGain.gain.setTargetAtTime(0.075 * this.mix * this.mix, ctx.currentTime, 0.4);
    /**
     * …AND IT OPENS A LITTLE WITH DEPTH, WHICH IS THE CHANNEL'S OWN STATED JOB.
     *
     * `deep`'s definition in caves.js says it exists so that "the light can get
     * stranger and more plentiful with depth … and the audio can open up",
     * and until now nothing anywhere read it. This is the audio opening up.
     *
     * A HANDFUL OF HERTZ AND NOT AN OCTAVE, deliberately. The whole argument of
     * the bed is that it is two octaves below anything else in the game and that
     * a single pole leaves enough 400-800 Hz through to read as hiss. Widening
     * to 160/210 at full depth adds body — the deep end of a system genuinely
     * moves more air, because it is where the passage is biggest — while staying
     * far under the band where hiss lives. The measured constraint that fixed
     * the level at 0.075 is untouched: this changes the SHAPE of the bed, not
     * how much of it there is.
     */
    this.airLp1.frequency.setTargetAtTime(105 + 55 * this.deep, now, 1.2);
    this.airLp2.frequency.setTargetAtTime(140 + 70 * this.deep, now, 1.2);

    if (this.mix < 0.05) {
      // Held rather than zeroed, so stepping out and back in does not fire a
      // drip on the frame you re-enter.
      this._next = Math.max(this._next, 1.5);
      /**
       * …but the mouth keeps dripping, because the mouth is the thing you can
       * hear from out here. One in four, at the OUTSIDE rate — a quarter of the
       * events over the same Poisson process, which is what routing "roughly one
       * drip in four" out through the doorway means when the other three would
       * not have been audible anyway.
       */
      if (this.mouth) {
        this._nextOut = (this._nextOut ?? 4) - dt;
        if (this._nextOut <= 0) {
          this._mouthDrip();
          this._nextOut = Math.min(
            DRIP_MAX * 2,
            DRIP_MIN * 2 + -Math.log(1 - this.rng() * 0.999) * 14
          );
        }
      }
      return;
    }

    /**
     * REAL SPACING, WHICH MEANS UNEVEN SPACING.
     *
     * The obvious implementation is a timer with a bit of jitter and it is
     * unmistakably a timer: the ear locks onto the average within four or five
     * events and from then on the cave has a tempo. Real drips are a Poisson
     * process — the gaps are exponentially distributed, so most are short and
     * a few are very long, and there is no rate to lock onto. `-ln(U)` is that
     * distribution exactly, from one uniform and one log.
     *
     * Clamped at both ends: under 1.4 s it is a leak rather than a drip, and
     * over 9.5 s the player has decided the cave is silent and stopped
     * listening. The mean falls with depth, so the far end of a passage is
     * wetter than the entrance.
     */
    this._next -= dt;
    if (this._next > 0) return;
    /**
     * ONE IN FOUR GOES OUT THROUGH THE DOORWAY INSTEAD, when there is a doorway
     * near enough to have a voice. It is the same drip either way; what differs
     * is whether it is around your head or coming from a hole in a hillside.
     *
     * Taken out of the same Poisson process rather than run as a second one, so
     * a cave never sounds wetter merely because you can also see the entrance —
     * the total rate is a property of the passage and this only decides where
     * each event lands.
     */
    if (this.mouth && this.rng() < 0.25) this._mouthDrip();
    else this._drip();
    /**
     * Wetter where there is water: the drips and the stream are the same water.
     *
     * ON `deep` AND NOT ON `depth`, WHICH IS THE FIX AND NOT A REFACTOR.
     *
     * `depth` is metres WALKED, and DEEP_FULL's block in caves.js is blunt about
     * why that is the wrong measure: "you can walk a hundred metres of level
     * tube and be nowhere". The audible consequence was that a long level
     * gallery near the entrance got the same drip rate as the bottom of a
     * shaft — so the one cue in this file that says how far into the world you
     * are was measuring how tired your legs were. `deep` is the descent, 0 at
     * the mouth and 1 at forty-five metres below it, splined along the passage
     * and correct across branches by construction.
     *
     * The COEFFICIENTS are unchanged, which is deliberate: 5.2 falling to 2.8
     * was tuned by ear and is still the right pair of numbers. What moved is
     * what drives them, and on a passage that descends steadily — most of
     * them — the mean rate at the far end is very close to what it was.
     */
    const mean = (5.2 - 2.4 * this.deep) * (1 - 0.45 * this.water);
    this._next = Math.min(DRIP_MAX, DRIP_MIN + -Math.log(1 - this.rng() * 0.999) * mean);
  }

  dispose() {
    try {
      this.airSource?.stop();
      this.airGain?.disconnect();
      this.windSource?.stop();
      this.windGain?.disconnect();
      this.streamSource?.stop();
      this.streamGain?.disconnect();
      this.wetBus?.disconnect();
      this._dropMouth();
    } catch {
      /* already gone */
    }
    this.built = false;
  }
}
