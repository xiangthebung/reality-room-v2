/**
 * Generated impulse responses.
 *
 * Two, both built from filtered noise under an envelope:
 *
 *   `forest` — short, dark, sparse. Not a room; the impression of a lot of
 *   scattered soft reflectors, which is what standing among trees sounds like.
 *
 *   `cosmos` — long, fully decorrelated between the ears, with almost no early
 *   reflections at all. Early reflections are the cue the brain uses to work out
 *   the size and direction of a space, so removing them is what makes the tail
 *   read as "everywhere" rather than as "a big hall".
 *
 * A convolver was chosen over a feedback delay network on purpose. An FIR has no
 * recursion: each input sample contributes to a finite window of output and is
 * then gone. It cannot accumulate, cannot self-oscillate and cannot click, which
 * is the failure mode a cross-fed delay network eventually finds in a busy mix.
 */

const cache = new Map();

/** Pink-ish noise. Softer than white, and much less hissy in a long tail. */
function pinkNoise(rand) {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  return () => {
    const white = rand() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    return (b0 + b1 + b2 + white * 0.1848) * 0.22;
  };
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `early`, `earlySpan` and `earlyGain` — and why the last two exist.
 *
 * The forest IR scatters nine discrete taps inside the first 90 ms at 0.45.
 * That is not a room, it is what the file says it is: a lot of soft reflectors
 * close by, none of them flat enough or far enough to send anything back
 * distinctly. A CAVE is the opposite object — hard, wet, and enclosed by
 * surfaces tens of metres apart — and the single thing that makes it sound like
 * one is a handful of loud, LATE, individually audible reflections. Sound
 * travels 343 m/s, so a chamber whose far wall is 25 m away answers at 145 ms;
 * folding that into a 90 ms window turns a slap into a flam.
 *
 * The two new fields default to the forest's own numbers, so `forest`,
 * `cosmos` and `cathedral` generate the same buffers they always have, sample
 * for sample. That matters more here than it looks: the forest convolver is on
 * everything in the game at a fixed send, so a change to this table is a change
 * to the timbre of the whole soundtrack, and `audio-probe.mjs` measures the
 * result as a spectral centroid across eight stages of a trip.
 */
const PRESETS = {
  forest: { seconds: 1.9, decay: 3.4, damp: 0.35, early: 9, spread: 0.55, tilt: 0.55 },
  cosmos: { seconds: 9.5, decay: 1.5, damp: 0.12, early: 0, spread: 1, tilt: 0.25 },
  cathedral: { seconds: 4.6, decay: 2.1, damp: 0.2, early: 4, spread: 0.85, tilt: 0.4 },
  /**
   * A cave. Longer, brighter and with real slap.
   *
   *   seconds 3.6   Long enough that a footstep is still audible three strides
   *                 later, short enough that speech and the jukebox do not turn
   *                 to porridge. `cathedral` at 4.6 was tried first and a cave
   *                 is not a cathedral: a nave has a smooth diffuse tail because
   *                 it is full of scattering stonework, and a passage has a
   *                 sparse one because it is a tube with two ends.
   *
   *   decay 1.9     A much flatter envelope than the forest's 3.4. Wood absorbs
   *                 and rock does not, so the energy leaves slowly and almost
   *                 linearly rather than dropping off a cliff.
   *
   *   damp 0.10     The forest's 0.35 rolls the tail dark as it dies, which is
   *                 air absorption through leaves. Bare rock keeps its top end,
   *                 and keeping it is what makes a drip ring instead of thud.
   *
   *   tilt 0.80     The one-pole's cutoff. High, for the same reason.
   *
   *   spread 0.72   Wide, but not `cosmos` wide. A passage has a direction and
   *                 collapsing it to fully decorrelated would put the walls
   *                 nowhere.
   *
   *   early 14 taps over 190 ms at 0.62 — the slap. This is the whole
   *   difference between "reverb" and "a cave", and it is worth more than every
   *   other number above put together.
   */
  cave: {
    seconds: 3.6,
    decay: 1.9,
    damp: 0.1,
    early: 14,
    earlySpan: 0.19,
    earlyGain: 0.62,
    spread: 0.72,
    tilt: 0.8,
  },
};

export function createImpulseResponse(ctx, preset = 'forest') {
  const key = `${preset}:${ctx.sampleRate}`;
  if (cache.has(key)) return cache.get(key);

  const spec = PRESETS[preset] ?? PRESETS.forest;
  const length = Math.floor(ctx.sampleRate * spec.seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);

  /**
   * Channel 0's bare tail, kept so channel 1 can be blended towards it.
   *
   * Snapshotted BEFORE the early reflections are stamped on, so the two
   * channels' discrete taps stay independent of each other. In a cave those
   * taps are the whole space — see the preset — and leaking one ear's into the
   * other's would turn fourteen distinct reflections into a chorus.
   */
  let reference = null;
  /**
   * Level compensation for that blend, and the reason it is not just a lerp.
   *
   * Channel 1's own noise and channel 0's are uncorrelated — different seeds,
   * three lines down — so mixing them at `spread` and `1 - spread` sums by
   * POWER rather than by amplitude. The result lands at `hypot(spread, 1 -
   * spread)` of one channel's RMS, which is 0.71 at the forest's 0.55 and
   * reaches 1 only at the extremes. Dividing it back out is what lets `spread`
   * change the WIDTH of the tail without also changing how loud the right ear
   * is, which is the entire failure this replaces.
   */
  const norm = Math.hypot(spec.spread, 1 - spec.spread);

  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    // Decorrelated seeds per channel: identical noise in both ears collapses
    // the image to the middle, which is the one thing a wide tail must not do.
    const noise = pinkNoise(rng(0x51ed + channel * 977 + preset.length * 31));
    // A one-pole low-pass whose cutoff falls as the tail decays, so the space
    // gets darker as it dies away — which is what air absorption does.
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const envelope = Math.pow(1 - t, spec.decay);
      const damping = 1 - spec.damp * t;
      lp += (noise() - lp) * Math.max(0.02, damping * spec.tilt);
      let v = lp * envelope;
      /**
       * Stereo spread: how much of its OWN noise the right channel keeps, the
       * remainder being the left channel's. 1 is two independent tails, 0 is
       * the same tail in both ears; the presets sit in between because a wood
       * is wide and a passage has a direction.
       *
       * THIS LINE USED TO READ `v * spread + (1 - spread) * -v`, which is not a
       * blend with anything — both terms are the same sample, so the whole
       * expression collapses to `v * (2 * spread - 1)`. That is not a width
       * control, it is a pure ATTENUATION of the right channel: 0.10 at the
       * forest's spread of 0.55, i.e. the room reverb on every sound in the
       * game arriving 20 dB down in one ear. Measured through a real
       * ConvolverNode rather than reasoned about, at -20.4 dB.
       *
       * WHY IT SURVIVED THIS LONG. It is inaudible on the things this room is
       * mostly applied to. A bird, a footstep, a stream — short, quiet, already
       * panned somewhere — carry a tail nobody can locate, and the synthesised
       * jukebox is dense enough to mask its own. It becomes unmistakable the
       * moment something loud, broadband and CONTINUOUS goes through it, with
       * gaps for the tail to show in: a shared screen's soundtrack, which is
       * what finally caught it. `cosmos` is at spread 1, where `2 * spread - 1`
       * is 1 and the bug did nothing at all — so the trip's reverb, the one
       * with a probe script pointed at it, always sounded exactly right.
       */
      if (channel === 1) v = (v * spec.spread + reference[i] * (1 - spec.spread)) / norm;
      data[i] = v;
    }
    if (channel === 0) reference = data.slice();
    /**
     * Early reflections: a few discrete taps near the front. Present in the
     * forest IR, absent in cosmos, and in `cave` they are the point.
     *
     * `earlySpan` and `earlyGain` default to the 0.09 and 0.45 that were
     * written here as literals, so every preset that does not set them
     * generates exactly the buffer it did before they existed.
     */
    const early = rng(0x9e37 + channel);
    const span = spec.earlySpan ?? 0.09;
    const gain = spec.earlyGain ?? 0.45;
    for (let e = 0; e < spec.early; e++) {
      const at = Math.floor(early() * ctx.sampleRate * span) + 40;
      if (at < length) data[at] += (early() * 2 - 1) * gain * (1 - e / spec.early);
    }
  }

  cache.set(key, buffer);
  return buffer;
}
