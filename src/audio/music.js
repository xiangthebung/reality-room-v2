import { clamp } from '../core/util.js';

/**
 * The jukebox's music.
 *
 * Synthesised rather than streamed, for one reason that matters: it is real
 * synthesis inside a PannerNode standing in the clearing, so it is genuinely
 * spatialised, genuinely damped by distance, and the trip can reach in and bend
 * its *tempo* and *tuning* rather than just filtering a stereo file. A track
 * that slows down and detunes as you come up is the single most convincing
 * audio effect in this project, and it is only possible because there is no file.
 *
 * WHY NOTHING IN HERE IS A SAWTOOTH. The previous version's pads were detuned
 * saw stacks through a resonant low-pass, and that combination is exactly how
 * you build a buzz: a saw has every harmonic at 1/n, and a resonant filter picks
 * a band of them out and rings. Reported, correctly, as "the buzzing noise".
 *
 * The replacement vocabulary is:
 *
 *   ADDITIVE PADS — a handful of sine partials at chosen amplitudes. Every
 *   harmonic present is one somebody put there. No filter resonance anywhere.
 *
 *   FM FOR ANYTHING STRUCK — bells, marimbas, plucks. Two sines and an envelope
 *   on the modulation index gives a bright attack that decays into a pure tone,
 *   which is what a struck object does. It cannot buzz because at the end of the
 *   envelope it is literally a sine wave.
 *
 *   PINK NOISE FOR PERCUSSION — through a *gentle* band-pass, never a resonant
 *   one. White noise through a high-Q filter is a whistle; pink noise through a
 *   wide band-pass is a brush.
 */

const midiToFreq = (midi) => 440 * 2 ** ((midi - 69) / 12);

const LOOKAHEAD_S = 0.35;
const TIMER_MS = 45;

/** Pink noise, generated once and looped. Softer than white at every level. */
let noiseBuffer = null;
export function pinkBuffer(ctx) {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer;
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    d[i] = (b0 + b1 + b2 + white * 0.1848) * 0.28;
  }
  noiseBuffer = buf;
  return buf;
}

export const TRACKS = [
  {
    id: 'understory',
    name: 'Understory',
    bpm: 72,
    bars: 4,
    swing: 0.06,
    tilt: 3600,
    // Dm9 – Bbmaj7 – Fmaj7 – Am7. Warm, unhurried, no leading tones.
    chords: [
      [50, 57, 62, 65, 69],
      [46, 53, 58, 62],
      [48, 55, 60, 64],
      [45, 52, 57, 60],
    ],
    roots: [38, 34, 36, 33],
    scale: [62, 65, 67, 69, 72, 74, 77],
    step(bar, s, time, api) {
      const chord = this.chords[bar];
      if (s === 0) {
        api.pad(chord, time, 3.6, 0.075);
        api.bass(this.roots[bar], time, 2.2, 0.16);
      }
      if (s === 0 || s === 10) api.kick(time, s === 0 ? 0.8 : 0.5);
      if (s === 8) api.brush(time, 0.24);
      if (s % 4 === 2) api.shaker(time, 0.05);
      if (s === 2 || s === 6 || s === 11) {
        api.marimba(chord[(s + bar) % chord.length] + 12, time, 0.11);
      }
      if (s === 14 && bar % 2 === 1) api.bell(this.scale[(bar * 2) % this.scale.length] + 12, time, 0.05);
    },
  },
  {
    id: 'sunthrough',
    name: 'Sun Through Leaves',
    bpm: 98,
    bars: 4,
    swing: 0.02,
    tilt: 5200,
    // Amaj-ish, bright and moving.
    chords: [
      [57, 61, 64, 68],
      [59, 62, 66, 69],
      [54, 57, 61, 64],
      [52, 56, 59, 63],
    ],
    roots: [45, 47, 42, 40],
    scale: [69, 71, 73, 76, 78, 81, 83],
    step(bar, s, time, api) {
      const chord = this.chords[bar];
      if (s === 0) api.pad(chord, time, 2.3, 0.055);
      if (s % 4 === 0) api.kick(time, 0.72);
      if (s === 4 || s === 12) api.brush(time, 0.22);
      if (s % 2 === 1) api.shaker(time, 0.04);
      if (s % 2 === 0) api.bass(this.roots[bar], time, 0.28, 0.13);
      // A rolling arpeggio, one octave up, that walks the chord.
      api.marimba(chord[(s + bar * 2) % chord.length] + 12, time, 0.055);
      if (s === 7 || s === 15) api.bell(this.scale[(s + bar * 3) % this.scale.length] + 12, time, 0.045);
    },
  },
  {
    id: 'deepgreen',
    name: 'Deep Green',
    bpm: 54,
    bars: 4,
    swing: 0,
    tilt: 2200,
    // No percussion at all. Four chords, four bars, breathing.
    chords: [
      [43, 50, 55, 59, 62],
      [41, 48, 53, 57, 60],
      [38, 45, 50, 55, 57],
      [40, 47, 52, 56, 59],
    ],
    roots: [31, 29, 26, 28],
    scale: [55, 57, 60, 62, 64, 67],
    step(bar, s, time, api) {
      const chord = this.chords[bar];
      if (s === 0) {
        api.pad(chord, time, 5.6, 0.095);
        api.bass(this.roots[bar], time, 4.4, 0.15);
      }
      if (s === 7 && bar % 2 === 0) api.bell(chord[chord.length - 1] + 12, time, 0.045);
      if (s === 12 && bar === 3) api.bell(this.scale[2] + 12, time, 0.035);
    },
  },
  {
    id: 'nightjar',
    name: 'Nightjar',
    bpm: 86,
    bars: 4,
    swing: 0.075,
    tilt: 3000,
    // Minor, low, with space between the hits.
    chords: [
      [45, 52, 55, 60],
      [43, 50, 53, 58],
      [48, 55, 58, 62],
      [41, 48, 52, 57],
    ],
    roots: [33, 31, 36, 29],
    scale: [57, 60, 62, 63, 67, 69],
    step(bar, s, time, api) {
      const chord = this.chords[bar];
      if (s === 0) api.pad(chord, time, 3.1, 0.07);
      if (s === 0 || s === 6 || s === 11) api.kick(time, s === 0 ? 0.85 : 0.45);
      if (s === 4 || s === 12) api.brush(time, 0.28);
      if (s % 2 === 0) api.shaker(time, s % 4 === 0 ? 0.055 : 0.03);
      if (s === 0 || s === 7) api.bass(this.roots[bar], time, 1.1, 0.17);
      if (s === 3 || s === 9 || s === 14) {
        api.pluck(chord[(s * 2 + bar) % chord.length] + 12, time, 0.075);
      }
      if (s === 13 && bar === 3) api.bell(this.scale[4] + 12, time, 0.05);
    },
  },

  /**
   * THE TWO RECORDS THE MACHINE CAME WITH.
   *
   * Ported from the previous project's jukebox, where they were the first two
   * tracks. They are here because a jukebox standing in a forest clearing should
   * not only know forest music — the four above are all the wood's own voice, and
   * four variations on "unhurried and green" is a shorter playlist than it looks.
   * A lounge record and a driving one are what make the machine feel like an
   * object somebody carried in rather than a feature of the landscape.
   *
   * THE ARRANGEMENTS ARE THE ORIGINALS. Chords, roots, tempo, swing, brightness
   * and every hit are as they were. THE SOUNDS ARE NOT, and could not be: the old
   * pad was a detuned sawtooth stack behind a filter sweeping with Q 1.1, which
   * is not merely similar to the buzz that got the previous version's audio
   * rejected, it is the exact recipe for it — every harmonic present at 1/n, and
   * a resonant filter picking a band of them out to ring. Both tracks are
   * rebuilt out of the additive/FM/pink-noise vocabulary this file already uses,
   * so they keep their groove and lose the buzz. See the header.
   */
  {
    id: 'midnight',
    name: 'Midnight Lounge',
    bpm: 84,
    bars: 4,
    swing: 0.055,
    tilt: 5200,
    /**
     * The crackle. Sparse impulses under the whole track, at about a fifth of a
     * step — see the vinyl branch in _schedule.
     *
     * It is doing real work rather than being a joke about lo-fi: a jukebox is a
     * record player, and surface noise is the strongest single cue that what you
     * are hearing is a recording being played in the clearing rather than music
     * being piped into your head. It is the only track that gets it, because it
     * is the only one that wants to sound old.
     */
    vinyl: true,
    // Am7 – Dm7 – G7 – Cmaj7. The ii-V-I is what makes it read as a lounge.
    chords: [
      [57, 60, 64, 67],
      [50, 57, 60, 65],
      [55, 59, 62, 65],
      [48, 55, 59, 64],
    ],
    roots: [45, 50, 43, 48],
    step(bar, s, time, api) {
      const chord = this.chords[bar];
      if (s === 0) api.pad(chord, time, 2.4, 0.05);
      if (s === 0 || s === 10) api.kick(time, s === 0 ? 0.95 : 0.66);
      if (s === 8) api.snare(time, 0.5);
      if (s % 2 === 0) api.hat(time, s === 4 || s === 12 ? 0.075 : 0.036, s === 12);
      if (s === 0 || s === 6) api.bass(this.roots[bar], time, s === 0 ? 0.9 : 0.4, 0.16);
      if (s === 4 || s === 11 || s === 14) {
        api.pluck(chord[(s + bar) % chord.length] + 12, time, 0.085);
      }
    },
  },
  {
    id: 'neon',
    name: 'Neon Drive',
    bpm: 112,
    bars: 4,
    swing: 0,
    /**
     * Brighter than anything else on the machine, and pulled down from the
     * original's 8200. That number was chosen against a saw stack, where a wide-
     * open tilt is the only thing standing between you and the top of the
     * harmonic series; against six sines and an FM pluck there is nothing up
     * there to let through but hats, and 8200 only spends the 2–6 kHz headroom
     * that audio-probe watches.
     */
    tilt: 6800,
    // Am – F – C – G. Triads, not sevenths: this one wants to move, not to sit.
    chords: [
      [57, 60, 64],
      [53, 57, 60],
      [52, 55, 60],
      [50, 55, 59],
    ],
    roots: [45, 41, 36, 43],
    step(bar, s, time, api) {
      const chord = this.chords[bar];
      if (s === 0) api.pad(chord, time, 1.9, 0.045);
      if (s % 4 === 0) api.kick(time, 0.95);
      if (s === 4 || s === 12) api.snare(time, 0.55);
      if (s % 2 === 1) api.hat(time, 0.05, s === 7);
      if (s % 2 === 0) api.bass(this.roots[bar], time, 0.2, 0.15);
      /**
       * The rolling sixteenth arpeggio, and the reason it calls `fm` directly
       * rather than `pluck`. A step here is 134 ms and the shared pluck decays
       * over 900, so seven of them would be sounding at once and the line would
       * come out as a chord held down rather than as notes. A 260 ms decay leaves
       * each one just overlapping its neighbour, which is what makes an arpeggio
       * sound played.
       */
      api.fm(chord[(s + bar * 2) % chord.length] + 12, time, {
        ratio: 1.01,
        index: 3.4,
        decay: 0.26,
        gain: 0.055,
      });
      if (s === 14) api.pluck(chord[0] + 24, time, 0.09);
    },
  },
];

export class Jukebox {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.trackIndex = 0;
    this.playing = false;
    this.step16 = 0;
    this.nextTime = 0;
    this.timer = null;

    /**
     * The trip's two handles on the music.
     *
     * `tempoScale` below 1 slows the sequencer without changing pitch, because
     * the notes are re-synthesised at the new spacing rather than resampled.
     * `detune` is in cents and is applied to every oscillator at creation.
     * Together they are "the record is dragging", which is a far more specific
     * and more recognisable sensation than "the music got weird".
     */
    this.tempoScale = 1;
    this.detune = 0;

    this.output = ctx.createGain();
    this.output.gain.value = 0;

    this.bus = ctx.createGain();
    this.tilt = ctx.createBiquadFilter();
    this.tilt.type = 'lowpass';
    // Q below 0.7 cannot resonate. That is the whole reason this number is here.
    this.tilt.Q.value = 0.45;
    this.tilt.frequency.value = 3600;
    this.bus.connect(this.tilt);
    this.tilt.connect(this.output);
    if (destination) this.output.connect(destination);

    this.api = this._makeApi();
  }

  get track() {
    return TRACKS[this.trackIndex];
  }

  get trackName() {
    return this.track.name;
  }

  /** How many records are on the machine. For the HUD and for audio-probe. */
  get trackCount() {
    return TRACKS.length;
  }

  start() {
    this.startAt(0);
  }

  /**
   * Start the record already some way through it.
   *
   * THIS IS WHAT MAKES THE JUKEBOX SHAREABLE, and it is the whole of what makes
   * it shareable, because the sequencer is already deterministic: `track.step`
   * is a pure function of `(bar, step, api)`, so two machines that agree about
   * WHICH STEP IT IS agree about every note without a byte of audio crossing
   * between them. A room therefore only has to say which record and when it
   * started, and each client works out the rest from a clock they already share.
   *
   * The offset is converted to a step index rather than to a time, because the
   * step is the sequencer's unit and a time would have to be re-derived into
   * one anyway — at a tempo that the listener's own trip may be dragging. See
   * `applyMusic` in main.js.
   *
   * Rounded DOWN to a whole step, and the remainder is deliberately thrown
   * away. Two clients can be up to one sixteenth-note apart, which at 96 bpm is
   * 156 ms; carrying the fraction would buy phase alignment that nobody can
   * perceive, because nobody hears anybody else's audio — the only shared sound
   * in this game is voice. What matters is that everyone is in the same BAR of
   * the same record, and that is exact.
   *
   * @param {number} offsetSeconds how far into the record to begin
   */
  startAt(offsetSeconds = 0) {
    if (this.playing) return;
    this.playing = true;
    const secondsPerBeat = 60 / this.track.bpm;
    const step = secondsPerBeat / 4;
    this.step16 = Math.max(0, Math.floor(offsetSeconds / step));
    this.nextTime = this.ctx.currentTime + 0.14;
    this.tilt.frequency.setTargetAtTime(this.track.tilt, this.ctx.currentTime, 0.25);
    this.output.gain.setTargetAtTime(1, this.ctx.currentTime, 0.4);
    this.timer = setInterval(() => this._schedule(), TIMER_MS);
    this._schedule();
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
    this.output.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
  }

  toggle() {
    if (this.playing) this.stop();
    else this.start();
    return this.playing;
  }

  setTrack(index) {
    const next = ((index % TRACKS.length) + TRACKS.length) % TRACKS.length;
    if (next === this.trackIndex) return this.track;
    this.trackIndex = next;
    this.step16 = 0;
    this.nextTime = this.ctx.currentTime + 0.12;
    this.tilt.frequency.setTargetAtTime(this.track.tilt, this.ctx.currentTime, 0.3);
    return this.track;
  }

  next() {
    return this.setTrack(this.trackIndex + 1);
  }

  _schedule() {
    if (!this.playing) return;
    const track = this.track;
    const scale = clamp(this.tempoScale, 0.55, 1.35);
    const secondsPerBeat = 60 / (track.bpm * scale);
    const step = secondsPerBeat / 4;
    const horizon = this.ctx.currentTime + LOOKAHEAD_S;

    // A backgrounded tab leaves the clock far behind; resync rather than dump
    // several hundred queued notes into the next quarter second.
    if (this.nextTime < this.ctx.currentTime - 0.4) {
      this.nextTime = this.ctx.currentTime + 0.05;
    }

    while (this.nextTime < horizon) {
      const s = this.step16 % 16;
      const bar = Math.floor(this.step16 / 16) % track.bars;
      const swing = s % 2 === 1 ? track.swing * step * 4 : 0;
      try {
        track.step(bar, s, this.nextTime + swing, this.api);
        /**
         * Surface noise, for the one track that is supposed to be a worn record.
         *
         * Placed at a random offset INSIDE the step rather than on it. A crackle
         * that lands on the grid is a percussion part however quiet it is, because
         * the ear will lock anything periodic into the groove; landing it between
         * the beats is what keeps it underneath the music instead of in it.
         */
        if (track.vinyl && Math.random() < 0.22) {
          this.api.crackle(this.nextTime + Math.random() * step);
        }
      } catch (err) {
        console.warn('[jukebox] step failed', err);
      }
      this.step16 += 1;
      this.nextTime += step;
    }
  }

  _osc(type, freq, time) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = this.detune;
    void time;
    return o;
  }

  _makeApi() {
    const ctx = this.ctx;
    const bus = this.bus;
    const self = this;

    /** Free a chain when its last oscillator ends. */
    const cleanup = (osc, nodes) => {
      osc.onended = () => {
        for (const n of nodes) {
          try {
            n.disconnect();
          } catch {
            /* already gone */
          }
        }
      };
    };

    const noiseSource = (time, duration) => {
      const src = ctx.createBufferSource();
      src.buffer = pinkBuffer(ctx);
      src.loop = true;
      src.playbackRate.value = 0.9 + Math.random() * 0.25;
      src.start(time, Math.random() * 1.5);
      src.stop(time + duration + 0.05);
      return src;
    };

    return {
      /**
       * Additive pad. Six partials per note at 1/n^1.6, which is close enough to
       * a bowed string's roll-off to sound like something with a body, and
       * every one of them is a sine.
       */
      pad: (notes, time, duration = 3, gain = 0.07) => {
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, time);
        env.gain.linearRampToValueAtTime(gain, time + duration * 0.32);
        env.gain.linearRampToValueAtTime(gain * 0.72, time + duration * 0.62);
        env.gain.linearRampToValueAtTime(0.0001, time + duration);
        // A gentle, non-resonant tilt so the pad sits behind the melodic parts.
        const soften = ctx.createBiquadFilter();
        soften.type = 'lowpass';
        soften.frequency.value = 2400;
        soften.Q.value = 0.4;
        env.connect(soften).connect(bus);

        const all = [];
        notes.forEach((midi, ni) => {
          const f0 = midiToFreq(midi);
          for (let p = 1; p <= 6; p++) {
            // Skip a couple of partials per note so the stack does not turn
            // into an organ; which ones are skipped varies by voice.
            if ((p + ni) % 4 === 0) continue;
            const o = self._osc('sine', f0 * p, time);
            // Slight, slow, per-partial detune: this is what makes an additive
            // pad breathe instead of sitting perfectly still.
            o.detune.value = self.detune + (p % 2 === 0 ? 3.5 : -3.5);
            const g = ctx.createGain();
            g.gain.value = (0.42 / Math.pow(p, 1.6)) / notes.length;
            o.connect(g).connect(env);
            o.start(time);
            o.stop(time + duration + 0.1);
            all.push(o, g);
          }
        });
        if (all.length) cleanup(all[all.length - 2], [env, soften]);
      },

      /** Sine fundamental plus a triangle an octave down. Round, no edge. */
      bass: (midi, time, duration = 0.6, gain = 0.16) => {
        const f = midiToFreq(midi);
        const o1 = self._osc('sine', f, time);
        const o2 = self._osc('triangle', f * 0.5, time);
        const g2 = ctx.createGain();
        g2.gain.value = 0.4;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 340;
        lp.Q.value = 0.4;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, time);
        env.gain.linearRampToValueAtTime(gain, time + 0.035);
        env.gain.setValueAtTime(gain, time + duration * 0.6);
        env.gain.exponentialRampToValueAtTime(0.0001, time + duration);
        o1.connect(lp);
        o2.connect(g2).connect(lp);
        lp.connect(env).connect(bus);
        o1.start(time);
        o2.start(time);
        o1.stop(time + duration + 0.06);
        o2.stop(time + duration + 0.06);
        cleanup(o1, [g2, lp, env]);
      },

      /**
       * Two-operator FM. `ratio` picks the character:
       *   1   — a warm plucked string
       *   3.5 — wooden, marimba-like
       *   7.1 — inharmonic, a bell
       * The modulation index decays fast, so every one of these ends as a pure
       * sine no matter how bright it starts.
       */
      fm: (midi, time, { ratio = 3.5, index = 5, decay = 0.7, gain = 0.09 } = {}) => {
        const f = midiToFreq(midi);
        const carrier = self._osc('sine', f, time);
        const mod = self._osc('sine', f * ratio, time);
        const modGain = ctx.createGain();
        modGain.gain.setValueAtTime(f * index, time);
        modGain.gain.exponentialRampToValueAtTime(f * 0.02, time + decay * 0.55);
        mod.connect(modGain).connect(carrier.frequency);

        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, time);
        env.gain.exponentialRampToValueAtTime(gain, time + 0.006);
        env.gain.exponentialRampToValueAtTime(0.0001, time + decay);
        carrier.connect(env).connect(bus);
        carrier.start(time);
        mod.start(time);
        carrier.stop(time + decay + 0.05);
        mod.stop(time + decay + 0.05);
        cleanup(carrier, [mod, modGain, env]);
      },

      marimba: (midi, time, gain = 0.09) =>
        self.api.fm(midi, time, { ratio: 3.98, index: 3.4, decay: 0.62, gain }),
      pluck: (midi, time, gain = 0.09) =>
        self.api.fm(midi, time, { ratio: 1.01, index: 4.2, decay: 0.9, gain }),
      bell: (midi, time, gain = 0.05) =>
        self.api.fm(midi, time, { ratio: 7.12, index: 6, decay: 3.4, gain }),

      /** Sine with a fast pitch drop. The only percussive tone in the kit. */
      kick: (time, gain = 0.8) => {
        const o = self._osc('sine', 118, time);
        o.frequency.setValueAtTime(118, time);
        o.frequency.exponentialRampToValueAtTime(42, time + 0.11);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, time);
        env.gain.linearRampToValueAtTime(0.42 * gain, time + 0.004);
        env.gain.exponentialRampToValueAtTime(0.0001, time + 0.34);
        o.connect(env).connect(bus);
        o.start(time);
        o.stop(time + 0.4);
        cleanup(o, [env]);
      },

      /** Pink noise through a wide band-pass. A brush, not a snare. */
      brush: (time, gain = 0.24) => {
        const src = noiseSource(time, 0.22);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1150;
        bp.Q.value = 0.6;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, time);
        env.gain.linearRampToValueAtTime(gain * 0.34, time + 0.006);
        env.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);
        src.connect(bp).connect(env).connect(bus);
        src.onended = () => {
          bp.disconnect();
          env.disconnect();
        };
      },

      shaker: (time, gain = 0.05) => {
        const src = noiseSource(time, 0.08);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 3000;
        hp.Q.value = 0.5;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, time);
        env.gain.linearRampToValueAtTime(gain, time + 0.004);
        env.gain.exponentialRampToValueAtTime(0.0001, time + 0.07);
        src.connect(hp).connect(env).connect(bus);
        src.onended = () => {
          hp.disconnect();
          env.disconnect();
        };
      },

      /**
       * A BACKBEAT, WHICH THE FOREST TRACKS DO NOT HAVE AND THE IMPORTED ONES ARE.
       *
       * `brush` was the only thing in the kit standing where a snare goes, and it
       * is deliberately not one — a soft wide band that gets out of the way. Put
       * a lounge groove on it and the two and the four vanish, which is where the
       * groove lives. So: its own instrument.
       *
       * Two parallel filters off one noise source rather than one steep band.
       * A single high-Q filter at snare frequencies does not sound like a snare,
       * it sounds like a tuned drum, because a resonant band IS a pitch — the
       * same failure mode as the buzz, one octave up. A wide band for the rattle
       * and a gentle high-pass for the crack give the same brightness with
       * nothing ringing.
       *
       * The tuned body underneath is what makes it a drum rather than a burst of
       * noise: a real snare has a shell, and the shell has a note in it.
       */
      snare: (time, gain = 0.5) => {
        const src = noiseSource(time, 0.2);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1750;
        bp.Q.value = 0.75;
        const air = ctx.createBiquadFilter();
        air.type = 'highpass';
        air.frequency.value = 4400;
        air.Q.value = 0.5;
        const airGain = ctx.createGain();
        airGain.gain.value = 0.55;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, time);
        env.gain.linearRampToValueAtTime(gain * 0.3, time + 0.005);
        env.gain.exponentialRampToValueAtTime(0.0001, time + 0.14);
        src.connect(bp).connect(env);
        src.connect(air).connect(airGain).connect(env);
        env.connect(bus);

        const body = self._osc('triangle', 196, time);
        body.frequency.setValueAtTime(196, time);
        body.frequency.exponentialRampToValueAtTime(150, time + 0.08);
        const bodyEnv = ctx.createGain();
        bodyEnv.gain.setValueAtTime(0.0001, time);
        bodyEnv.gain.linearRampToValueAtTime(gain * 0.14, time + 0.004);
        bodyEnv.gain.exponentialRampToValueAtTime(0.0001, time + 0.09);
        body.connect(bodyEnv).connect(bus);
        body.start(time);
        body.stop(time + 0.12);
        cleanup(body, [bodyEnv]);

        src.onended = () => {
          bp.disconnect();
          air.disconnect();
          airGain.disconnect();
          env.disconnect();
        };
      },

      /**
       * A hi-hat: the shaker's argument, tighter and four octaves of attitude up.
       *
       * `open` doubles as the accent — a hat that never opens is a metronome, and
       * one open hat per bar is most of the difference between a drum machine and
       * a drummer.
       *
       * IT HAS TO FIT UNDER THE TILT, WHICH IS WHY IT IS A DARK HAT.
       *
       * The obvious build is the original's: pink noise high-passed at 8 kHz,
       * where a hi-hat's perceptual centre actually is. Measured, it produced
       * exactly as much energy above 6 kHz as a track with no hats in it at all —
       * inaudible, and only findable by measuring, because "there is a quiet
       * ticking somewhere" is not a thing you notice missing.
       *
       * Two reasons, and they compound. This kit's noise is pink, so it has
       * already lost 3 dB per octave by the time it gets up there. And the bus
       * carries a low-pass at the track's own `tilt` — 5200 Hz on this record —
       * so a hat cornered at 6 kHz is being squeezed from both sides at once and
       * essentially nothing survives the middle.
       *
       * Raising the gain to compensate is the wrong fix: it would amplify the
       * filter's own skirts rather than the hat. Fighting the tilt is worse — the
       * tilt IS the record's tone, and a lo-fi lounge track played on a jukebox
       * in a clearing is *supposed* to be dark. Real hats on a dark record are
       * dull. So the corner sits at 4 kHz, under the tilt, where the sound can
       * actually come out, and the cascade gives it 24 dB/oct so it stays a tick
       * rather than a wash. Yes, that is inside the 2–6 kHz band audio-probe
       * watches; a hi-hat is one of the things that band is legitimately for, and
       * the track measures well inside the ceiling with it.
       */
      hat: (time, gain = 0.05, open = false) => {
        const decay = open ? 0.17 : 0.034;
        const src = noiseSource(time, decay + 0.02);
        const hp1 = ctx.createBiquadFilter();
        hp1.type = 'highpass';
        hp1.frequency.value = 4000;
        hp1.Q.value = 0.5;
        const hp2 = ctx.createBiquadFilter();
        hp2.type = 'highpass';
        hp2.frequency.value = 4000;
        hp2.Q.value = 0.5;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, time);
        env.gain.linearRampToValueAtTime(gain * 3, time + 0.002);
        env.gain.exponentialRampToValueAtTime(0.0001, time + decay);
        src.connect(hp1).connect(hp2).connect(env).connect(bus);
        src.onended = () => {
          hp1.disconnect();
          hp2.disconnect();
          env.disconnect();
        };
      },

      /**
       * Surface noise. One impulse, eight milliseconds long, very quiet.
       *
       * Scheduled by `_schedule` rather than by a track's step function, because
       * crackle is a property of the RECORD and not of the arrangement — it has
       * to land off the grid or it becomes percussion. The band is deliberately
       * below the 2–6 kHz range audio-probe measures as harshness and the Q is
       * under 1, so it cannot ring: at this decay a resonant filter would give
       * each pop a pitch, and a pitched pop at random intervals is a fault rather
       * than a texture.
       */
      crackle: (time, gain = 0.014) => {
        const src = noiseSource(time, 0.012);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1600 + Math.random() * 900;
        bp.Q.value = 0.9;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, time);
        env.gain.linearRampToValueAtTime(gain, time + 0.001);
        env.gain.exponentialRampToValueAtTime(0.0001, time + 0.009);
        src.connect(bp).connect(env).connect(bus);
        src.onended = () => {
          bp.disconnect();
          env.disconnect();
        };
      },
    };
  }

  dispose() {
    this.stop();
    for (const n of [this.bus, this.tilt, this.output]) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
  }
}
