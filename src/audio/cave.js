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
   * @param {number} depth metres along the passage, for the drip rate
   */
  update(dt, mix = 0, depth = 0, tight = 0, room = 1, water = 0) {
    if (!this.built) return;
    this.mix = clamp01(mix);
    this.depth = depth;
    this.tight = clamp01(tight);
    this.water = clamp01(water);
    const ctx = this.ctx;
    const now = ctx.currentTime;

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
    this.engine.setRoom(this.mix, 0.25 + 0.75 * clamp01(room));
    this.engine.setOcclusion(this.mix);

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

    if (this.mix < 0.05) {
      // Held rather than zeroed, so stepping out and back in does not fire a
      // drip on the frame you re-enter.
      this._next = Math.max(this._next, 1.5);
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
    this._drip();
    // Wetter where there is water: the drips and the stream are the same water.
    const mean = (5.2 - 2.4 * clamp01(depth / 90)) * (1 - 0.45 * this.water);
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
    } catch {
      /* already gone */
    }
    this.built = false;
  }
}
