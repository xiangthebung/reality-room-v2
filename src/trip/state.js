import { clamp01, lerp, smoothstep } from '../core/util.js';

/**
 * The clock and the envelope.
 *
 * Everything else in `trip/` is a pure function of what this file exposes:
 * `level` (how far in you are, 0..1), `dissolve` (the ego-death curve), the
 * phase, and a couple of slow waves. Nothing downstream knows what a minute is.
 *
 * The shape is modelled on the reported experience rather than on a ramp: a long
 * flat come-up where you mostly wonder whether anything is happening, a fast
 * onset, a long plateau, a short passage near the top that is qualitatively
 * different rather than merely more, and a comedown that takes its time.
 */

export const TRIP_SECONDS = 290;

/**
 * `to` is exclusive, the table is contiguous, and `level` is the value reached
 * at the END of each phase — interpolated with a smoothstep from the previous
 * one, so there is no seam anywhere.
 */
export const PHASES = [
  { id: 'comeup', from: 0, to: 48, level: 0.18, label: 'Something is happening' },
  { id: 'onset', from: 48, to: 108, level: 0.56, label: 'The forest is breathing' },
  { id: 'peak', from: 108, to: 205, level: 1, label: 'Peak' },
  { id: 'egodeath', from: 205, to: 236, level: 1, label: 'No one is driving' },
  { id: 'comedown', from: 236, to: TRIP_SECONDS, level: 0, label: 'Coming back' },
];

export const SOBER = { id: 'sober', label: 'Sober', level: 0, from: 0, to: 0 };

function phaseIndexAt(t) {
  for (let i = 0; i < PHASES.length; i++) {
    if (t < PHASES[i].to) return i;
  }
  return -1;
}

/**
 * A redose is an ADDITIVE BUMP anchored at the moment you ate, never a change
 * to the clock.
 *
 * Warping time is the obvious implementation and it is wrong in a way that only
 * shows up on the second dose: eating again during the comedown would have to
 * move effective time backwards, which snaps the level from 0.2 to 1.0 in a
 * single frame. A bump is zero at the instant it starts, so no dose can ever
 * move the level discontinuously; several simply sum.
 */
const BUMP_RISE = 32;
const BUMP_HOLD = 62;
const BUMP_FALL = 150;
export const BUMP_SECONDS = BUMP_RISE + BUMP_HOLD + BUMP_FALL;

/** Tolerance builds within a session, so the fifth is worth a fifth of the first. */
export function bumpAmplitude(index) {
  return 0.5 / (index + 1);
}

export function redoseBump(dt, amplitude) {
  if (!(dt > 0)) return 0;
  if (dt < BUMP_RISE) return amplitude * smoothstep(clamp01(dt / BUMP_RISE));
  if (dt < BUMP_RISE + BUMP_HOLD) return amplitude;
  const k = (dt - BUMP_RISE - BUMP_HOLD) / BUMP_FALL;
  return k >= 1 ? 0 : amplitude * (1 - smoothstep(clamp01(k)));
}

export function bumpTotal(t, redoses) {
  if (!redoses?.length) return 0;
  let sum = 0;
  for (let i = 0; i < redoses.length; i++) sum += redoseBump(t - redoses[i], bumpAmplitude(i));
  return sum;
}

export function totalSecondsFor(redoses) {
  let total = TRIP_SECONDS;
  for (const at of redoses ?? []) total = Math.max(total, at + BUMP_SECONDS);
  return total;
}

function baseLevelAt(t) {
  if (!(t >= 0) || t >= TRIP_SECONDS) return 0;
  const index = phaseIndexAt(t);
  if (index < 0) return 0;
  const phase = PHASES[index];
  const from = index === 0 ? 0 : PHASES[index - 1].level;
  const span = Math.max(1e-3, phase.to - phase.from);
  return clamp01(lerp(from, phase.level, smoothstep(clamp01((t - phase.from) / span))));
}

export function levelAt(t, redoses = null) {
  if (!(t >= 0) || t >= totalSecondsFor(redoses)) return 0;
  return clamp01(baseLevelAt(t) + bumpTotal(t, redoses));
}

export function phaseAt(t, redoses = null) {
  if (!(t >= 0) || t >= totalSecondsFor(redoses)) return SOBER;
  const index = phaseIndexAt(t);
  if (index < 0) {
    return bumpTotal(t, redoses) > 0.04
      ? { id: 'resurge', label: 'Coming back up', from: 0, to: 0, level: 0 }
      : SOBER;
  }
  if (index >= 4 && bumpTotal(t, redoses) > 0.04) {
    return { id: 'resurge', label: 'Coming back up', from: PHASES[4].from, to: PHASES[4].to, level: 0 };
  }
  return PHASES[index];
}

/**
 * Ego death as its own curve rather than as a level.
 *
 * It is not "more intense", it is a different thing happening, and it drives
 * effects that are absent everywhere else in the trip. A raised cosine over the
 * phase rises and falls with no discontinuity at either end, so nothing pops on
 * the way in or on the way out.
 */
export function dissolveAt(t) {
  const phase = PHASES[3];
  if (t <= phase.from || t >= phase.to) return 0;
  const k = (t - phase.from) / (phase.to - phase.from);
  return 0.5 - 0.5 * Math.cos(k * Math.PI * 2);
}

export class TripState {
  constructor() {
    this.seed = '';
    /** Seconds since you ate, or -1 when sober. */
    this.time = -1;
    this.redoses = [];
    this.doses = 0;
    this.level = 0;
    this.dissolve = 0;
    this.phase = SOBER;
    /**
     * The breathing clock, in radians, free-running.
     *
     * The world reads this and NOT `breath`, because a surface adds its own
     * world-sampled offset to it before taking the sine — see the breath block
     * in living.js. Exposed as a phase rather than as a value because you
     * cannot recover a phase from a sine: `asin` loses the half of the cycle
     * you were on, and a world that guesses gets a wave that runs backwards for
     * half of every breath.
     */
    this.breathPhase = 0;
    /**
     * The same wave as a scalar, -1..1, for the things that genuinely are
     * global — the hills, the canopy pulse's envelope, the audio's breath
     * layer, the camera. About seven cycles a minute.
     */
    this.breath = 0;
    /** Two incommensurate periods, so the plateau is never a flat line. */
    this.wave = 0;
    /**
     * THE WAVE THAT ARRIVES, 0..1.
     *
     * Distinct from `wave`, which is a gentle ±13% ripple on the level and
     * exists so the plateau is not a straight line. This is the other thing the
     * reports describe, and it is the reason a plateau can be at full intensity
     * and still read as nothing: for a few seconds the whole wood becomes one
     * organism — the bark organises, the light comes out of the surfaces, the
     * colour goes deep — and then it subsides and it is simply a forest again.
     * Then another wave arrives.
     *
     * A constant is invisible after thirty seconds no matter how large it is.
     * An event is not, and it can be several times the plateau's amplitude
     * without ever becoming the thing you have to navigate through.
     */
    this.surge = 0;
    /** Free-running clock for the generators; keeps going while sober. */
    this.clock = 0;
    /** Set by the debug panel to override the envelope entirely. */
    this.override = null;
    /**
     * DEBUG: STOP THE CLOCK WHERE IT IS, AND ONLY THAT CLOCK.
     *
     * `time` stops advancing; `clock` does not. The difference is the whole
     * point, and it is why this is not the same thing as the panel's speed
     * slider at 0 — that multiplies the dt the director is given, which freezes
     * both, and a trip with `clock` stopped is a dead one: no surges arrive, the
     * breath holds its breath, the audio's sparks never fire and its drone stops
     * moving. Everything you would be listening FOR is on the free-running
     * clock. What stops here is only where in the five minutes you are, so the
     * phase, the level and the ego-death curve hold still and the wood carries
     * on being alive around them.
     *
     * It also stops the trip ENDING. Held at ego death with this off, `time`
     * walks through the comedown and out the far side, `end()` clears the
     * override on the way past, and a tuning session that was standing at full
     * intensity is standing in a sober forest four minutes later — which is the
     * "back to a phase again" that this exists to delete.
     */
    this.paused = false;
  }

  get active() {
    return this.time >= 0 && this.time < this.total;
  }

  get total() {
    return totalSecondsFor(this.redoses);
  }

  get remaining() {
    return this.active ? Math.max(0, this.total - this.time) : 0;
  }

  begin(seed) {
    this.seed = seed;
    this.time = 0;
    this.doses = 1;
    this.redoses = [];
    this._recompute();
  }

  redose() {
    if (!this.active) {
      this.begin(this.seed || `trip-${Math.floor(this.clock)}`);
      return;
    }
    this.redoses.push(this.time);
    this.doses += 1;
  }

  /** Jump to a point in the trip. Debug only. */
  seek(seconds) {
    if (!this.seed) this.seed = `trip-${Math.floor(this.clock)}`;
    this.time = Math.max(0, seconds);
    if (this.doses === 0) this.doses = 1;
    this._recompute();
  }

  end() {
    this.time = -1;
    this.doses = 0;
    this.redoses = [];
    this.override = null;
    // A pause is a hold on a running trip, so ending one releases it. Leaving it
    // set would make the next `eat` start a trip that never moves, several
    // minutes after anybody last touched the control that did it.
    this.paused = false;
    this._recompute();
  }

  update(dt) {
    this.clock += dt;
    if (this.time >= 0 && !this.paused) {
      this.time += dt;
      if (this.time >= this.total) this.end();
    }
    this._recompute();
  }

  _recompute() {
    const t = this.time;
    this.phase = phaseAt(t, this.redoses);
    this.dissolve = t < 0 ? 0 : dissolveAt(t);

    const base = t < 0 ? 0 : levelAt(t, this.redoses);
    // Surges rather than a plateau. A static peak is the single most artificial
    // thing an effect like this can do; two incommensurate periods keep the
    // pattern from audibly looping.
    const w =
      Math.sin(this.clock / 27.3) * 0.62 + Math.sin(this.clock / 11.1 + 1.7) * 0.38;
    this.wave = w;
    /**
     * 0.72 rad/s is a breath every 8.7 seconds, near seven a minute.
     *
     * Slower than resting human breathing, which is twelve to eighteen, and
     * deliberately so: this is the rate the whole forest is doing it at, and a
     * wood inhaling at conversational speed is agitated rather than alive. It
     * is also the rate the audio breath layer and the camera are on, and those
     * two are the ones a body entrains to.
     */
    this.breathPhase = this.clock * 0.72;
    this.breath = Math.sin(this.breathPhase);

    /**
     * The surge: a nineteen-second carrier under a seventy-second ceiling.
     *
     * The power is what makes it an event rather than another oscillator. A raw
     * sine spends half its life above the midpoint, which is a plateau with a
     * wobble; raised to 2.4 the same wave sits near zero for about two thirds of
     * each cycle and is only near the top for three or four seconds. The slow
     * ceiling means consecutive waves do not arrive at the same height, so the
     * rhythm never becomes a metronome — some are barely there and one in three
     * or four goes all the way over.
     */
    const carrier = Math.sin(this.clock * 0.33 + 0.7) * 0.5 + 0.5;
    const ceiling = 0.55 + 0.45 * Math.sin(this.clock * 0.091);
    this.surge = Math.pow(clamp01(carrier), 2.4) * ceiling;

    const envelope = this.override !== null ? clamp01(this.override) : base;
    this.level = clamp01(envelope * (1 + w * 0.13 * envelope));
    if (this.override !== null) this.dissolve = t < 0 ? 0 : this.dissolve;
  }
}
