/** Small maths and RNG helpers. No dependencies, no state. */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);
export const TAU = Math.PI * 2;

/** Inverse-lerp, clamped. */
export const inverseLerp = (a, b, v) => clamp01((v - a) / (b - a || 1e-6));

/**
 * Frame-rate independent exponential approach.
 *
 * `smoothing` is the fraction remaining after one second, so 0.02 means "98% of
 * the way there each second". Every eased value in this app goes through here;
 * a raw `lerp(a, b, 0.1)` is silently frame-rate dependent and produces a
 * different feel on a 144 Hz monitor than on a 60 Hz one.
 */
export function damp(current, target, smoothing, dt) {
  return lerp(target, current, Math.exp(Math.log(Math.max(smoothing, 1e-6)) * dt));
}

/** FNV-1a. Deterministic across machines, which matters for seeded worlds. */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, good enough distribution for scattering trees. */
export function makeRng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hashString(String(seed));
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rngRange = (rng, lo, hi) => lo + rng() * (hi - lo);
export const rngPick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];

/**
 * 2D value noise on the CPU.
 *
 * The terrain height is authored here and baked into real geometry, so the GPU
 * never has to recompute it — the trip's hill exaggeration scales the vertex
 * height it is given rather than re-deriving it. That avoids the whole class of
 * bug where a float32 shader and a float64 script disagree by a few centimetres
 * and every tree in the forest floats or sinks.
 */
const fract = (v) => v - Math.floor(v);

export function hash21(x, y) {
  let px = fract(x * 123.34);
  let py = fract(y * 456.21);
  const d = px * (px + 45.32) + py * (py + 45.32);
  px += d;
  py += d;
  return fract(px * py);
}

export function noise2(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash21(ix, iy);
  const b = hash21(ix + 1, iy);
  const c = hash21(ix, iy + 1);
  const d = hash21(ix + 1, iy + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy) * 2 - 1;
}

export function fbm2(x, y, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let px = x;
  let py = y;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(px, py) * amp;
    px *= 2.03;
    py *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

/** Wrap an angle into -PI..PI. */
export function wrapAngle(a) {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

/** A stable per-frame delta with a ceiling, so a stalled tab does not teleport. */
export class Clock {
  constructor() {
    this.last = performance.now() / 1000;
    this.elapsed = 0;
  }

  tick() {
    const now = performance.now() / 1000;
    const dt = Math.min(0.05, Math.max(0, now - this.last));
    this.last = now;
    this.elapsed += dt;
    return dt;
  }
}
