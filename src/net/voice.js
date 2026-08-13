/**
 * Voice: one microphone out, one PannerNode per person in.
 *
 * The whole point of this file is that a voice is a thing standing in a specific
 * place in the wood. Everything else follows from that — the mono encode in
 * mesh.js, the head position rather than the body origin below, the directivity
 * cone, the refusal to let a conference server anywhere near the audio.
 */

import { clamp01 } from '../core/util.js';

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

/** Desk rumble, HVAC, the thump of a plosive hitting the capsule. Nothing musical lives here. */
const HIGHPASS_HZ = 85;

/**
 * The noise gate, in linear RMS.
 *
 * 0.012 is about -38 dBFS, which sits above a quiet room's floor and below any
 * speech that was aimed at a microphone. It is a default rather than a truth:
 * a mechanical keyboard or a desk fan will cross it, which is what the
 * push-to-talk mode is for.
 */
const GATE_THRESHOLD = 0.012;

/**
 * Hysteresis and hold, because a bare threshold chatters.
 *
 * Speech is not continuously above any level — it has gaps between words and a
 * decaying tail on every one of them. A gate with a single threshold and no
 * hold closes inside those gaps and reopens for the next syllable, which is
 * audible as a stutter on the far end and, worse, makes the speaking indicator
 * on the avatar flicker. The gate opens at the threshold, and only closes once
 * the level has been *below 60% of it* for a fifth of a second.
 */
const GATE_HOLD_S = 0.22;
/** Fast enough that no consonant is lost, slow enough not to click. */
const GATE_ATTACK_S = 0.008;
const GATE_RELEASE_S = 0.09;

/**
 * How loudly you hear your own echo underground.
 *
 * BELOW THE REMOTE LEVEL ON PURPOSE, and it is not modesty. Everybody else's
 * voice reaches the room send having already been through a PannerNode and the
 * distance low-pass, so what feeds the taps is a voice that has crossed a
 * chamber; yours has crossed nothing, and matching the numbers would put your
 * own repeats well over everybody else's. This is also the one path in the whole
 * graph where the source and the sink are in the same physical room, so the
 * conservative number is the one that stays conservative when somebody turns
 * their speakers up.
 */
const SELF_ECHO = 0.34;

export class Microphone {
  /** @param {import('../audio/engine.js').AudioEngine} engine — must be started. */
  constructor(engine) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.available = false;
    this.error = null;

    /** 0..1 perceptual level, for the HUD and for broadcast. */
    this.level = 0;
    this.rms = 0;
    /** The gate is open and we are transmitting. */
    this.speaking = false;
    /** 'open' | 'ptt' — open mic with a gate, or hold-to-talk. */
    this.mode = 'open';
    this.muted = false;
    /** The talk key is down. */
    this.talking = false;

    this._stream = null;
    this._source = null;
    this._gateOpen = false;
    this._hold = 0;
    this._build();
  }

  _build() {
    const ctx = this.ctx;

    this.highpass = ctx.createBiquadFilter();
    this.highpass.type = 'highpass';
    this.highpass.frequency.value = HIGHPASS_HZ;
    this.highpass.Q.value = 0.7;

    /**
     * The analyser taps BEFORE the gate, deliberately.
     *
     * The same RMS has to answer two questions — should the gate open, and how
     * loudly is this person talking — and reading it after the gate makes the
     * first one circular: the gate is shut, so the level is zero, so the gate
     * stays shut.
     */
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.2;
    this._samples = new Float32Array(this.analyser.fftSize);
    this.highpass.connect(this.analyser);

    this.gate = ctx.createGain();
    this.gate.gain.value = 0;
    this.highpass.connect(this.gate);

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -24;
    this.compressor.knee.value = 10;
    this.compressor.ratio.value = 3;
    this.compressor.attack.value = 0.006;
    this.compressor.release.value = 0.14;
    this.gate.connect(this.compressor);

    // A small presence lift. Consonants are what survive the distance low-pass
    // in engine.js's spatial chain, and they are what carries intelligibility
    // once a voice is muffled by twenty metres of forest.
    this.presence = ctx.createBiquadFilter();
    this.presence.type = 'highshelf';
    this.presence.frequency.value = 3400;
    this.presence.gain.value = 2.5;
    this.compressor.connect(this.presence);

    /**
     * Conditioned once, here, rather than by each listener.
     *
     * Everything above happens before the signal leaves this machine, so every
     * peer receives one already-clean stream. The alternative — send it raw and
     * let seven receivers each try to repair it — costs seven times the CPU and
     * cannot work as well, because only this machine knows what its own room
     * sounds like.
     *
     * The destination node is created once and never replaced. Changing
     * microphone rebuilds only the capture side, so the outgoing track identity
     * survives and no WebRTC renegotiation is needed.
     */
    this.destination = ctx.createMediaStreamDestination();
    this.presence.connect(this.destination);

    /**
     * AND THE ONE THING THIS FILE HAS NEVER DONE: LET YOU HEAR YOURSELF.
     *
     * Until now `presence` terminated on the MediaStreamDestination above and
     * nowhere else, so local voice was never monitored at all — correctly, since
     * a monitor of your own microphone is a person hearing themselves a few
     * milliseconds late, which is the single most disruptive thing you can do to
     * somebody trying to speak. A cave is the exception the whole feature exists
     * for: standing in a chamber and presenting to a room, hearing nothing come
     * back is what makes the rock read as wallpaper.
     *
     * WET ONLY, WHICH IS THE ENTIRE SAFETY ARGUMENT AND NOT A MIX PREFERENCE.
     *
     *   There is no connection from here to the dry path, at any level, ever. A
     *   dry monitor is microphone → speakers → microphone with nothing between
     *   the two, which is a feedback loop whose gain is set by how loud the
     *   player happens to have their speakers, and it howls.
     *
     *   What this feeds is `engine.voiceRoomSend`, which is four delay taps and
     *   a convolver and NO feedback at all (see `_buildVoiceRoom`). Nothing that
     *   comes back can arrive sooner than 104 ms, by which time it is a distinct
     *   event rather than part of the loop, and it arrives 6 dB down and rolled
     *   off at 2 kHz.
     *
     *   The browser's own echo cancellation is on — see `open()`, where it stays
     *   on because people play on speakers — and its job is exactly this path:
     *   it has the far-end signal and subtracts it from the capture. A delayed,
     *   darkened copy is the easy case for an AEC, unlike a near-zero-latency
     *   one.
     *
     *   And the gate is upstream of it. Between words this tap is fed a hard
     *   zero, so there is no idle path for a room to ring round even in
     *   principle.
     *
     * It is silent everywhere except under rock regardless: the send's wet gain
     * is zero until `setVoiceRoom` says otherwise, and until somebody has been
     * underground once there is nothing on the other end of this connection at
     * all.
     */
    this.selfEcho = ctx.createGain();
    this.selfEcho.gain.value = SELF_ECHO;
    this.presence.connect(this.selfEcho);
    this.selfEcho.connect(this.engine.voiceRoomSend);
  }

  get track() {
    return this.destination.stream.getAudioTracks()[0] ?? null;
  }

  async open() {
    this.error = null;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Echo cancellation stays on: plenty of people play on speakers, and
          // without it their microphone re-transmits everyone else's voice back
          // into the mesh, which is a feedback loop with N-1 paths in it.
          echoCancellation: true,
          noiseSuppression: true,
          /**
           * Automatic gain control OFF, which is the one non-obvious choice.
           *
           * AGC normalises everything to roughly the same level, which is right
           * for a phone call and wrong here twice over. It makes a fixed gate
           * threshold meaningless, because in a quiet room it winds the gain up
           * until the room noise itself crosses the line. And the broadcast
           * envelope drives a glow on the avatar, so a person murmuring would
           * light up exactly as brightly as a person shouting.
           */
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
    } catch (err) {
      this.available = false;
      this.error = describeMicError(err);
      return false;
    }

    this._teardownCapture();
    this._stream = stream;
    this._source = this.ctx.createMediaStreamSource(stream);
    this._source.connect(this.highpass);
    this.available = true;
    return true;
  }

  _teardownCapture() {
    try {
      this._source?.disconnect();
    } catch {
      /* ignore */
    }
    this._source = null;
    for (const track of this._stream?.getTracks() ?? []) track.stop();
    this._stream = null;
  }

  /** Should any sound be leaving this machine at all right now? */
  get transmitting() {
    if (this.muted) return false;
    if (this.mode === 'ptt') return this.talking;
    return true;
  }

  /** Once a frame. Runs the gate, returns the envelope to broadcast. */
  update(dt) {
    if (!this.available) {
      this.level = 0;
      this.speaking = false;
      return 0;
    }

    this.analyser.getFloatTimeDomainData(this._samples);
    let sum = 0;
    for (let i = 0; i < this._samples.length; i++) sum += this._samples[i] * this._samples[i];
    const rms = Math.sqrt(sum / this._samples.length);
    this.rms = rms;

    if (rms > GATE_THRESHOLD) {
      this._gateOpen = true;
      this._hold = GATE_HOLD_S;
    } else if (rms < GATE_THRESHOLD * 0.6) {
      this._hold -= dt;
      if (this._hold <= 0) this._gateOpen = false;
    }

    /**
     * Holding the talk key forces the gate open rather than merely permitting
     * it. In push-to-talk that is the only thing that opens it at all; in open
     * mic it is the escape hatch for a quiet talker whose voice sits under the
     * threshold, and pressing it is unambiguous consent to transmit.
     */
    const open = this.muted ? false : this.mode === 'ptt' ? this.talking : this._gateOpen || this.talking;
    const target = open ? 1 : 0;
    this.gate.gain.setTargetAtTime(
      target,
      this.ctx.currentTime,
      target > 0 ? GATE_ATTACK_S : GATE_RELEASE_S
    );

    // Map RMS onto 0..1 across roughly -58 dB to -12 dB, which is the range a
    // person actually occupies between muttering and projecting.
    const db = 20 * Math.log10(Math.max(rms, 1e-6));
    const display = clamp01((db + 58) / 46);
    this.level += (display - this.level) * (1 - Math.exp(-dt / 0.05));
    this.speaking = open && this.level > 0.06;

    return open ? this.level : 0;
  }

  close() {
    this._teardownCapture();
    for (const node of [
      this.highpass,
      this.analyser,
      this.gate,
      this.compressor,
      this.presence,
      // The wet tap goes with the rest of the capture chain. Left connected, a
      // closed microphone would still be feeding the cave's delay lines from
      // whatever was in flight when it closed.
      this.selfEcho,
      this.destination,
    ]) {
      try {
        node?.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.available = false;
  }
}

function describeMicError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone blocked. You can still hear everyone.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone found. You can still hear everyone.';
    case 'NotReadableError':
      return 'Your microphone is busy in another app.';
    default:
      return 'No microphone. You can still hear everyone.';
  }
}

// ---------------------------------------------------------------------------
// playback
// ---------------------------------------------------------------------------

/**
 * Voice distances, and why they are not the jukebox's.
 *
 * `engine.js` puts the jukebox at refDistance 4.5 / rolloff 1.25 / max 150,
 * which is a machine in a clearing you are meant to be able to hear from the
 * far side of the wood and navigate back to. A voice is the opposite object:
 * conversational at three metres, private at twenty, and gone before the tree
 * line. So the reference distance comes in to just past arm's length, the
 * rolloff steepens a little, and the maximum comes down hard — at 60 m the
 * inverse model would still be handing back an audible whisper across a world
 * that is only 190 m in radius, and a whisper you can hear everywhere is not
 * proximity voice, it is a chat room with reverb on it.
 */
const VOICE_REF_DISTANCE = 3.2;
const VOICE_ROLLOFF = 1.35;
const VOICE_MAX_DISTANCE = 60;

/**
 * Speech directivity.
 *
 * Roughly the shape of a real head: wide and flat in front, with a distinct
 * shadow behind. It is a small amount of maths for a disproportionate amount of
 * presence, because it is what lets you hear somebody turn away from you
 * mid-sentence — which, in a wood where everyone is walking about, happens
 * constantly and is otherwise completely inaudible.
 */
const CONE_INNER_DEG = 120;
const CONE_OUTER_DEG = 300;
const CONE_OUTER_GAIN = 0.35;

export class PeerVoice {
  /**
   * @param {import('../audio/engine.js').AudioEngine} engine
   * @param {THREE.Vector3} position where this person's mouth is right now
   */
  constructor(engine, position) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.track = null;
    this._element = null;
    this._node = null;
    /** 0..1, from what actually arrived rather than from what was claimed. */
    this.envelope = 0;

    /**
     * Built through the engine's own helper, so a voice is spatialised by the
     * same chain as everything else in the world — distance low-pass, HRTF
     * panner — but it lands on `voiceBus`, NOT on the world bus.
     *
     * It used to default to `worldBus`, which had two consequences, and the
     * second was reported by a player as "the world slider changes everything":
     *
     *   The Voices slider did nothing whatsoever. Its bus existed, its trim
     *   existed, its control was drawn and registered, and no audio in the app
     *   had ever been connected to it — so the one control specifically for
     *   "turn other people down" was the only one that could not.
     *
     *   Speech went through the forest convolver. `engine.js` explains at
     *   length why voice is the one bus deliberately kept dry: another player
     *   talking arrives at your ear directly rather than being a sound
     *   happening in the wood, and 1.9 s of dark tail on speech is the fastest
     *   way to make it unintelligible.
     *
     * This is precisely the call the engine's own header comment recommends.
     *
     * THE CAVE ECHO IS NOT A REGRESSION OF ANY OF THAT, and this is the note to
     * read before assuming it is. `engine.setVoiceRoom` puts a wet path on this
     * bus, but it is not the forest send: it is silent above ground, it is
     * scaled by how far underground the LISTENER is, and it returns to
     * `trims.voice` rather than to `preMaster` — which is the specific thing
     * that keeps the Voices slider governing every part of a voice, dry and wet,
     * and is the rule this comment's own history exists to protect. The engine's
     * header states the same distinction from the other end.
     */
    this.source = engine.createSpatial(position, {
      refDistance: VOICE_REF_DISTANCE,
      rolloff: VOICE_ROLLOFF,
      maxDistance: VOICE_MAX_DISTANCE,
      bus: engine.voiceBus,
    });

    const panner = this.source.panner;
    panner.coneInnerAngle = CONE_INNER_DEG;
    panner.coneOuterAngle = CONE_OUTER_DEG;
    panner.coneOuterGain = CONE_OUTER_GAIN;

    /**
     * The envelope is measured here, from the received audio, not taken from
     * the number the sender broadcast.
     *
     * They are nearly the same number and the difference matters: this one
     * cannot be wrong. It is zero when the peer connection has not formed, zero
     * when the packets are being dropped, and correct when a modified client
     * lies about how loudly it is speaking. An avatar whose mouth glows while
     * you hear nothing is a bug report; an avatar driven by what you can
     * actually hear never produces one.
     */
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.2;
    this._samples = new Float32Array(this.analyser.fftSize);
  }

  setTrack(track) {
    if (this.track === track) return;
    this.detach();
    if (!track) return;
    this.track = track;
    const stream = new MediaStream([track]);

    /**
     * Chromium will not pull samples from a remote MediaStream that is only
     * wired into Web Audio — the stream has to be attached to a media element
     * before it starts flowing. So there is a muted, volume-zero <audio>
     * element per peer whose only job is to exist. Muted playback needs no
     * gesture, and keeping it silent is what stops a second, unspatialised copy
     * of everyone's voice coming out of the speakers at full level.
     */
    const element = new Audio();
    element.srcObject = stream;
    element.muted = true;
    element.autoplay = true;
    element.playsInline = true;
    element.volume = 0;
    element.play().catch(() => {
      /* a rejection on muted playback is harmless */
    });
    this._element = element;

    this._node = this.ctx.createMediaStreamSource(stream);
    this._node.connect(this.source.input);
    // Tapped at the source, before the panner: the glow should say that someone
    // is speaking, not how near they are. Distance is already expressed by how
    // loud they sound.
    this._node.connect(this.analyser);
  }

  detach() {
    try {
      this._node?.disconnect();
    } catch {
      /* ignore */
    }
    this._node = null;
    if (this._element) {
      this._element.srcObject = null;
      this._element = null;
    }
    this.track = null;
    this.envelope = 0;
  }

  get hasAudio() {
    return Boolean(this._node);
  }

  /**
   * @param dt seconds
   * @param head world position of the mouth
   * @param forward unit vector the head is looking along
   * @param listenerDistance metres from the camera, for the air filter
   */
  update(dt, head, forward, listenerDistance) {
    this.source.setPosition(head);
    this.source.setDistance(listenerDistance);

    const panner = this.source.panner;
    if (panner.orientationX) {
      // Ramped rather than assigned, for the same reason engine.js ramps the
      // listener: teleporting a panner parameter every frame is zipper noise in
      // the HRTF convolution.
      const when = this.ctx.currentTime;
      const t = Math.max(0.008, Math.min(0.05, dt));
      panner.orientationX.linearRampToValueAtTime(forward.x, when + t);
      panner.orientationY.linearRampToValueAtTime(forward.y, when + t);
      panner.orientationZ.linearRampToValueAtTime(forward.z, when + t);
    } else {
      panner.setOrientation(forward.x, forward.y, forward.z);
    }

    if (this._node) {
      this.analyser.getFloatTimeDomainData(this._samples);
      let sum = 0;
      for (let i = 0; i < this._samples.length; i++) sum += this._samples[i] * this._samples[i];
      const rms = Math.sqrt(sum / this._samples.length);
      const db = 20 * Math.log10(Math.max(rms, 1e-6));
      const target = clamp01((db + 58) / 46);
      // Asymmetric: the glow arrives with the word and leaves slowly, because a
      // light that follows a speech envelope exactly flickers at syllable rate.
      const tau = target > this.envelope ? 0.04 : 0.16;
      this.envelope += (target - this.envelope) * (1 - Math.exp(-dt / tau));
    } else {
      this.envelope += (0 - this.envelope) * (1 - Math.exp(-dt / 0.16));
    }
  }

  dispose() {
    this.detach();
    try {
      this.analyser.disconnect();
    } catch {
      /* ignore */
    }
    this.source.dispose();
  }
}
