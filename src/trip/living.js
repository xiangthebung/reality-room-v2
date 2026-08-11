import * as THREE from 'three';
import { damp } from '../core/util.js';
import { worldClock } from '../core/world-clock.js';

/**
 * THE LIVING-MATERIAL LAYER — and the single most important design decision in
 * this project.
 *
 * The complaint about the previous version was that the trip "looked like a
 * filter on the screen". That is not a tuning problem and no amount of softening
 * a post-process fixes it, because a post-process genuinely *is* a filter on the
 * screen: it is a function of screen coordinates, so it is stuck to the glass and
 * the eye works that out in about two seconds. Turn your head and the pattern
 * comes with you. Nothing that does that will ever read as the world.
 *
 * So the psychedelia lives here instead, inside the shaders of the actual
 * objects, and every field it evaluates is a function of WORLD POSITION. The
 * consequences are the whole point:
 *
 *   - The grain, the fissures and the emergent detail sit on a specific patch of
 *     specific bark. Walk around the tree and they stay on the tree. Look away
 *     and back and they are where you left them.
 *   - The colour shift is regional. One stand of trees goes violet while the
 *     ferns twenty metres away go gold, because the hue is sampled from a slow
 *     three-dimensional field that the forest is standing inside of.
 *   - Breathing is per-surface and out of phase with itself, because it is
 *     driven by the same field. One trunk swells while its neighbour settles.
 *
 * Everything shares ONE uniform object, `tripUniforms`, so a hundred materials
 * cost one write per frame and can never disagree about the time.
 *
 * Materials opt in through `makeLiving(material, kind)`, which sets the defines
 * that select the vertex behaviour. Sober frames take the `uLevel > 0.001`
 * branch out — it is a uniform branch, so it is coherent across every wavefront
 * and costs essentially nothing.
 */

/**
 * THE NOISE LATTICE, BAKED.
 *
 * `rrNoise` used to evaluate eight hashes and seven mixes per tap, and the
 * fragment half below takes dozens of taps per pixel at the peak — the profiler
 * put the trip's fragment path at nearly half the main pass. This texture holds
 * `rrHash` at every integer lattice point, 128³ of them, and the shader-side
 * `rrNoise` becomes one trilinear fetch: the hardware's filter does the
 * eight-corner interpolation, and warping the coordinate by the same smoothstep
 * the ALU version applied to its `f` reproduces the interpolation exactly.
 *
 * ONE HONEST DIFFERENCE: the wrap relabels the lattice. The ALU hash was
 * aperiodic, so hash(-4) and hash(124) were unrelated; under REPEAT they are
 * the same texel. Every field therefore kept its scale, amplitude and
 * character but re-rolled its layout — grain, relief and colour regions sit in
 * new places, exactly as if the world had been reseeded. Nothing depends on
 * the old layout; if a specific fissure on a specific trunk ever matters to a
 * test, it matters relative to this texture now.
 *
 * REPEAT wrapping makes the field tile with period 128 in domain units. The
 * finest domain in this file is the bark fibre at ×27, which therefore repeats
 * every ~4.7 m — but it is summed with a second octave at an irrational ratio
 * and every field seeds a different offset, so there is no distance at which
 * the repetition lines up with itself. Nothing else comes within a factor of
 * four of that scale.
 *
 * 8 bits per lattice value, not float: quantisation is 1/255 of the value
 * BEFORE interpolation, so gradients between lattice points stay perfectly
 * smooth — the error is a ±0.4% jitter in where a contour sits, invisible on
 * fields whose thresholds are twenty times wider.
 *
 *
 * AND IT IS THREE LATTICES NOW, NOT ONE — THE LARGEST SAVING THIS FILE HAS
 * MADE, AND ALL OF IT IN THE VERTEX STAGE.
 *
 * The melt wants a VECTOR: three decorrelated noises at one position, so a
 * trunk can be pushed in x, y and z independently. It got them the only way a
 * one-channel lattice allows — by sampling the same field at three arbitrary
 * offsets (+4.2, +27.1, -8.8) far enough apart to be uncorrelated. Three
 * octave-pairs of that is nine rrFbm2 calls, which is EIGHTEEN trilinear
 * fetches per vertex, and a peak frame has 14.85 M vertices — leaf cards alone
 * are 7.45 M of them, because a card is four vertices for two triangles.
 *
 * That is where the trip's cost actually was, and the way to find out was to
 * halve the pixel count and see what did NOT halve. Sober is almost purely
 * fill: 2560x1440 6.69 ms against 3.51 ms at half the pixels, which is 47% for
 * 50% fewer pixels. At the peak the same halving only took 6.96 to 5.59 — 20%
 * — so ~2.1 ms of the trip is resolution-INDEPENDENT. Fourteen million
 * vertices times twenty-six trilinear fetches is exactly that number.
 *
 * Three decorrelated values at one lattice point is what a colour channel is
 * for. R, G and B hold three independent hashes of the same integer cell, so
 * rrNoise3 returns the whole vector for ONE fetch and the melt drops from 18
 * fetches to 6 (4 on terrain, which has no third octave). Everything else in
 * the file is a scalar field and is untouched.
 *
 * MEASURED, this change alone, at 2560x1440 with a GPU timer query, three
 * A/B rounds in ALTERNATING PROCESSES because two shader variants cannot
 * coexist in one process without a recompile that is itself worth +-0.8 ms:
 *
 *     sober    3.34 -> 3.43   +0.09 ms    +2.7%
 *     onset    5.99 -> 5.24   -0.75 ms   -12.5%
 *     peak     5.62 -> 4.56   -1.06 ms   -18.9%
 *     egodeath 5.57 -> 4.73   -0.84 ms   -15.1%
 *     still    5.70 -> 4.55   -1.15 ms   -20.2%
 *
 * SOBER GETS SLOWER AND THAT IS NOT NOISE. At uLevel 0 nothing samples this
 * texture from the vertex stage at all, but the bark grain, the ground relief,
 * the sky and the water still read channel R from the fragment stage — and a
 * cache line of RGBA8 holds a quarter as many lattice values as a cache line
 * of R8. A tenth of a millisecond on the cheapest frame there is, for a
 * millisecond on the expensive ones. A second R8 texture bound alongside would
 * buy it back and was not taken: it puts an unused sampler3D in every program
 * that includes NOISE3, which is the exact shape of a bug this project has
 * already had (see the note on HUE_ROTATE in world/fauna/shading.js).
 *
 * WHAT IT COSTS, HONESTLY. 8 MB of texture instead of 2, and the melt's LAYOUT
 * is re-rolled: the three components are three hashes now rather than one hash
 * read at three offsets, so a given trunk leans a different way at a given
 * second. Scale, amplitude, octave weights, orbit periods and every statistic
 * of the field are identical — it is the same deformation with a different
 * seed, exactly as when this lattice was first baked. Sober frames are
 * bit-identical because the whole block is branched out at uLevel 0, and
 * channel R is the hash it always was, so bark grain, ground relief, the moss
 * glow, breath, the colour field, the sky, the water and the motes do not move.
 *
 * REJECTED: making it exact by rounding the offsets to integers so a channel
 * could be baked as "the lattice, shifted". A whole-integer shift IS exact
 * under REPEAT — but +27.1 is not +27, and moving it shifts that component by
 * 0.1 of a lattice unit, which at the melt's 0.019/m domain is five metres.
 * That re-rolls the layout too, for none of the saving.
 *
 *
 * AND NOW FOUR LATTICES, BECAUSE THE FOURTH BYTE WAS ALREADY BEING PAID FOR.
 *
 * The note below the loop used to say "alpha is never sampled" and explain that
 * drivers pad an RGB8 3D texture to four bytes anyway, so writing 255 there
 * cost nothing. Both halves of that are true and together they describe a
 * WASTED BYTE ON 2,097,152 TEXELS — two megabytes of the eight, uploaded,
 * resident and fetched on every single tap, carrying the number 255.
 *
 * A fourth independent hash goes there, and the breath — which was two
 * trilinear fetches of its own — reads it out of a fetch the colour field was
 * already doing. Two fetches per vertex to zero, for no memory, no bandwidth
 * and no new sampler. It is the best ratio in the file and it was sitting in
 * plain sight behind a comment saying it was free.
 *
 * The one thing that had to be checked rather than assumed is that the fourth
 * hash is decorrelated from the other three AT THE SAME LATTICE POINT, because
 * the breath now samples exactly where the colour field's fine octave does.
 * Measured over 40 k points against the real bake: |r| <= 0.013 for all six
 * channel pairs, and r = -0.013 between the breath and vRrField.y at the shared
 * position. Independent, as the construction promises.
 */
const NOISE_TEX_SIZE = 128;

/**
 * The four hash seeds, one per channel.
 *
 * R is the original triple and must stay that way. Every scalar field in this
 * file reads channel R through rrNoise, so changing it would reseed the whole
 * world — every fissure, every grain, every colour region.
 *
 * A is the newest and is the only one whose ARRIVAL changed a picture: it holds
 * the breath, which used to be its own two-octave field at its own domain. See
 * the breath block in VERTEX_BODY.
 */
const NOISE_SEEDS = [
  [0.71, 0.113, 0.419],
  [0.231, 0.677, 0.913],
  [0.517, 0.359, 0.187],
  [0.083, 0.797, 0.641],
];

function bakeNoiseTexture() {
  const n = NOISE_TEX_SIZE;
  const data = new Uint8Array(n * n * n * 4);
  const fract = (v) => v - Math.floor(v);
  /**
   * The per-axis half of rrHash depends on one coordinate and one seed only,
   * so it is three tables of 128 rather than 2.1 M evaluations per channel.
   * Without them a four-channel bake is four times the work of the old
   * one-channel bake and is felt on the loading screen; with them the inner
   * loop is the three multiplies it always was, done four times.
   */
  const axis = NOISE_SEEDS.map(([sx, sy, sz]) => ({
    x: Float64Array.from({ length: n }, (_, i) => fract(i * 0.3183099 + sx) * 17),
    y: Float64Array.from({ length: n }, (_, i) => fract(i * 0.3183099 + sy) * 17),
    z: Float64Array.from({ length: n }, (_, i) => fract(i * 0.3183099 + sz) * 17),
  }));
  let i = 0;
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        for (let c = 0; c < 4; c++) {
          const a = axis[c];
          const px = a.x[x];
          const py = a.y[y];
          const pz = a.z[z];
          data[i + c] = Math.round(fract(px * py * pz * (px + py + pz)) * 255);
        }
        i += 4;
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, n, n, n);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.unpackAlignment = 4;
  tex.needsUpdate = true;
  return tex;
}

export const tripUniforms = {
  uTime: { value: 0 },
  /** The baked noise lattice. Bound by every shader that includes NOISE3. */
  uNoiseTex: { value: bakeNoiseTexture() },
  /** Trip intensity, 0..1. Zero means every effect below is skipped. */
  uLevel: { value: 0 },
  /** Ego-death curve, 0..1, non-zero only in that phase. */
  uDissolve: { value: 0 },
  /**
   * THE THREE CANDIDATE EGO-DEATH TREATMENTS, already multiplied by uDissolve:
   * x = fade into the air, y = un-light the surface, z = the soft swarm.
   *
   * Three amounts in one uniform because they are meant to be A/B'd against
   * each other and against a fourth that lives on uRim — see director.ego and
   * the Ego death section of the debug panel. All three are zero by default:
   * the dither that used to be here was deleted for reading as a lattice, and
   * nothing has yet been chosen to replace it.
   *
   * ONE UNIFORM AND ONE BRANCH RATHER THAN THREE. The whole block is skipped
   * on `dot(uEgo, 1) < 0.001`, which is a uniform branch and therefore free
   * and coherent — the same arrangement `uLevel > 0.001` uses to make sober
   * frames cost nothing. Three separate uniforms would be three branches on
   * the same condition for most of a session.
   */
  uEgo: { value: new THREE.Vector3() },
  /**
   * The breath as a SCALAR, -1..1 — one number for the whole world.
   *
   * Kept for the things that genuinely are global: the hills swelling, the
   * canopy pulse riding on the same clock, the audio's breath layer. Anything
   * that lands on a SURFACE uses uBreathPhase instead, because a surface that
   * inhales on the same tick as every other surface is a global scale pulse,
   * and a global scale pulse has a fixed point at the camera.
   */
  uBreath: { value: 0 },
  /**
   * The same breath as a PHASE, in radians, free-running.
   *
   * This is what the vertex stage actually reads. Adding a world-sampled
   * offset to it and taking the sine gives every point in the forest its own
   * place in the cycle, so the breath TRAVELS: a trunk finishes inhaling and
   * the stand behind it is still starting. See the breath block in VERTEX_BODY.
   */
  uBreathPhase: { value: 0 },
  /** Metres of surface displacement at full strength. */
  uBreathAmp: { value: 0 },
  /** Wind/sway amplification. 1 is the sober forest. */
  uSway: { value: 1 },
  /** Vertical exaggeration of distant terrain. "The hills got bigger." */
  uHills: { value: 0 },
  /** Self-luminous brightness — the moss patches, the canopy pulse, the caves. */
  uGlow: { value: 0 },
  /** White-balance shift toward warm, 0..1. */
  uWarmth: { value: 0 },
  /** Extra saturation, added to 1. */
  uSat: { value: 0 },
  /** How much the trees lean toward you, 0..1. */
  uLean: { value: 0 },
  /**
   * Metres of world-space flow: the melt, as geometry.
   *
   * This replaced an image-space warp. See the block that uses it below.
   */
  uFlow: { value: 0 },
  /**
   * THE MORPH GROUP. Four numbers that move the SURFACE rather than the object.
   *
   * Everything above displaces geometry: the trunk goes somewhere it was not.
   * These four leave the geometry exactly where it is and move the *domain* the
   * surface detail is evaluated in, which is a different perception entirely and
   * is the one people actually describe. A wall that breathes does not come
   * toward you; its texture swells while the wall stays where it is. That is
   * only expressible as a change of domain.
   */
  /** Metres the detail domain swells and relaxes, in place. */
  uSwell: { value: 0 },
  /** Metres of steady domain drift: grain flowing through the wood. */
  uCreep: { value: 0 },
  /** Emergent fine structure, 0..1. "Suddenly there is too much detail." */
  uDetail: { value: 0 },
  /**
   * THE VIEW BREATH — the one screen-space displacement in the project, and the
   * exception has to be argued for rather than assumed.
   *
   * Everything else here moves the world and lets the camera photograph it,
   * which is the rule the whole file is built on. This moves the PICTURE. It
   * exists because the world-space families can express a trunk that bends and
   * a surface whose grain swells, and cannot express the thing the reports
   * describe as the room breathing as a whole — a slow travelling swell that
   * crosses the trunk, the gap behind it and the canopy above it as one motion.
   * A per-object effect cannot say "one motion" about objects that do not know
   * about each other.
   *
   * WHAT MAKES IT LEGAL, given that the melt in the same position was rejected:
   *
   *   NO BORDER. The melt was depth-reconstructed and therefore bounded — it
   *   moved the pixels on the tree and not the pixels beside it, and the seam
   *   between the two is optically a pane of glass. This reads no depth and has
   *   no guard: the field is continuous across the entire frame, so there is
   *   nowhere for an edge to be. That is the whole difference, and it is why
   *   the cruder effect is the one that works.
   *
   *   NO FIXED POINT. Nothing here is radial and nothing is a global zoom. The
   *   displacement is the gradient of a noise field, so one region swells while
   *   its neighbour settles, and the domain is offset by uViewPan so the swell
   *   stays on the part of the world it started on when you turn your head. A
   *   field that does not move when the camera does is a filter, and the eye
   *   works that out within about two seconds.
   *
   *   IT IS THE SAME BREATH. The phase comes from uBreathPhase, the same clock
   *   the trunks and the canopy inhale on, offset by the field so the wave
   *   travels. Three systems on one clock is one event happening to the world.
   *
   * Amplitude is in fractions of the frame's smaller axis.
   */
  uViewWarp: { value: 0 },
  /**
   * The camera's rotation, and the half-angles of its frustum.
   *
   * Together these turn a pixel into the WORLD DIRECTION it looks along, which
   * is what the view breath's field is a function of. The alternative — offset
   * a screen-space domain by accumulated yaw and pitch — needs a coefficient
   * relating radians to screen fractions, and that coefficient is a function of
   * the field of view, which drifts during a trip. Get it wrong by a factor of
   * two and the field slides across the world at half the rate you turn, which
   * looks worse than not compensating at all. This has no coefficient to get
   * wrong.
   *
   * The field is therefore locked to world DIRECTIONS: turn your head and the
   * swell stays on the part of the wood it was on. It does not move when you
   * walk, and that is the deliberate limit — anchoring to world POSITIONS needs
   * a depth buffer and a per-object offset, which is precisely the bounded
   * resample that reads as a pane of glass. Walking is slow next to the field's
   * own 0.09 Hz, so nothing about it draws attention.
   */
  uViewRot: { value: new THREE.Matrix3() },
  /** tan(fovY/2) * aspect, tan(fovY/2). Updated whenever the camera's is. */
  uViewTan: { value: new THREE.Vector2(1, 1) },
  /**
   * THE STARE, and it is world-anchored for the same reason everything else in
   * this file is.
   *
   * Almost every effect in the reports carries the same clause: it intensifies
   * while you hold your gaze on a particular thing, and it resets the moment
   * you look away. That is the one dimension this project had nothing on — every
   * amount here has been a function of time and place and none of them of
   * ATTENTION.
   *
   * The naive version is a screen-space vignette of detail, which is exactly the
   * thing that is banned: detail that is always in the middle of the frame is
   * stuck to the glass and the eye works it out immediately. What makes this
   * legal is that the ray is FROZEN. The director watches the camera; while it
   * is held still these two hold the world ray you were looking along at the
   * moment you settled, and uDwell charges. Move or turn and the anchor jumps to
   * the new ray and the charge collapses.
   *
   * So the detail blooms on a specific piece of the world rather than in the
   * middle of the screen, and it stays on that piece while it decays — glance
   * away and back quickly and it is still where you left it, which is precisely
   * the reported behaviour and is not something a screen-space term can do.
   */
  uGazeFrom: { value: new THREE.Vector3() },
  uGazeDir: { value: new THREE.Vector3(0, 0, -1) },
  /** How long the gaze has been held, 0..1. Charges slowly, collapses fast. */
  uDwell: { value: 0 },
  /** Metres the canopy inflates as a pulse of light crosses it. */
  uPulse: { value: 0 },
  /** Luminous contour on the silhouette of things, 0..1. */
  uRim: { value: 0 },
  /**
   * THE SURGE, 0..1 — the wave arriving.
   *
   * Rides on top of every other amount rather than replacing any of them, so
   * when it comes up the glow, the organising, the swelling, the colour and the
   * canopy pulse all rise together off one number. That coherence is the whole
   * effect: several systems moving at once reads as one event happening to the
   * world, and the same systems moving independently reads as several effects
   * being run.
   */
  uSurge: { value: 0 },
  /** Camera position, for distance-keyed effects. */
  uEye: { value: new THREE.Vector3() },
  /** bass, mid, high, transient — all 0..1, smoothed on the JS side. */
  uAudio: { value: new THREE.Vector4() },
  /** Wind phase, shared by every plant so the whole forest gusts together. */
  uWind: { value: new THREE.Vector2(0, 0) },
};

/**
 * Noise, shared by every world material and by the post pass.
 *
 * Three-dimensional on purpose: a 2D field sampled at world XZ would make
 * everything at the same ground position share a colour regardless of height,
 * which shows up immediately as horizontal banding up a tree trunk.
 */
export const NOISE3 = /* glsl */ `
uniform highp sampler3D uNoiseTex;

/**
 * Kept on the ALU: the dissolve grain calls this directly, once, on an
 * already-quantised cell coordinate — a fetch would buy nothing there.
 */
float rrHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

/**
 * One trilinear fetch from the baked lattice — see bakeNoiseTexture in
 * living.js. The fractional part is warped by the same smoothstep the ALU
 * version applied before its mixes, and the texture's REPEAT wrap plus
 * texel-centre offset line the fetch up with the lattice exactly, so this is
 * the identical function evaluated by the sampler instead of by eight hashes.
 */
float rrNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return texture(uNoiseTex, (i + f + 0.5) * (1.0 / ${NOISE_TEX_SIZE}.0)).r * 2.0 - 1.0;
}

/**
 * THREE DECORRELATED NOISES FOR THE PRICE OF ONE FETCH.
 *
 * Same lattice, same interpolation, same warp — the three colour channels are
 * three independent hashes of the same integer cell, so a caller that wants a
 * VECTOR of noise gets it for one trilinear fetch instead of three. Only the
 * melt wants that; every other field here is a scalar and keeps using
 * rrNoise, which still reads channel R and is therefore unchanged to the bit.
 * See bakeNoiseTexture for what this bought and what it cost.
 *
 * NOT a substitute for sampling one field at three POSITIONS. The surface
 * warp's gradient, the bark's directional derivative and the ground's relief
 * all need the same field at neighbouring points, and no number of channels
 * helps with that.
 *
 * NOTE FOR EDITORS: this block is inside a template literal, so there is not a
 * backtick anywhere in it — one ends the string and throws a syntax error
 * pointing at the next word. VERTEX_BODY and FRAGMENT_BODY carry the same
 * warning; this block has already been caught by it once.
 */
vec3 rrNoise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return texture(uNoiseTex, (i + f + 0.5) * (1.0 / ${NOISE_TEX_SIZE}.0)).rgb * 2.0 - 1.0;
}

/**
 * ALL FOUR CHANNELS. Same fetch, same filter, same warp — the caller simply
 * declines to throw the fourth one away.
 *
 * There is exactly one caller and there should stay exactly one: the colour
 * field's fine octave, whose .rgb is the field and whose .w is the breath. Any
 * OTHER pairing would be worse than two honest fetches, because the two fields
 * would then be locked to the same sample POSITION — decorrelated in value
 * (measured, r = -0.013) but identical in where their features sit and in how
 * fast they churn. That is only acceptable when the two fields wanted the same
 * domain anyway, which here they very nearly did: 12.2 m against 11.8 m.
 */
vec4 rrNoise4(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return texture(uNoiseTex, (i + f + 0.5) * (1.0 / ${NOISE_TEX_SIZE}.0)) * 2.0 - 1.0;
}

float rrFbm2(vec3 p) {
  return rrNoise(p) * 0.6 + rrNoise(p * 2.03 + 4.1) * 0.3;
}

/** rrFbm2's two octaves, vectorised: two fetches for three components. */
vec3 rrFbm2v(vec3 p) {
  return rrNoise3(p) * 0.6 + rrNoise3(p * 2.03 + 4.1) * 0.3;
}

float rrFbm3(vec3 p) {
  return rrNoise(p) * 0.53 + rrNoise(p * 2.03 + 4.1) * 0.27 + rrNoise(p * 4.11 - 7.3) * 0.13;
}

/**
 * Rodrigues rotation about the grey axis. Moves colours around the wheel
 * without touching luminance, which is what keeps a hue shift from also being
 * an exposure change.
 */
vec3 rrHueRotate(vec3 c, float angle) {
  const vec3 k = vec3(0.57735);
  float ca = cos(angle);
  return c * ca + cross(k, c) * sin(angle) + k * dot(k, c) * (1.0 - ca);
}

/**
 * A BREATH, NOT AN OSCILLATOR.
 *
 * A sine spends exactly half its life above the midpoint and rises and falls at
 * the same rate, and nothing that breathes does either. Warping the phase by a
 * sine of itself skews the wave without changing its bounds at all: the swell
 * takes about a third of the cycle and the settle takes the other two thirds,
 * which is the shape of an exhale that outlasts the inhale before it.
 *
 * THE BOUND IS THE POINT AND IT IS EXACT. This is sin() of something, so it is
 * in -1..1 whatever the skew is, and check-plants.mjs budgets the breath at
 * exactly 1.0 of its amplitude. A polynomial skew, or the sin(p) - k*sin(2p)
 * that is the obvious way to do this, would both overshoot — and would spend
 * displacement budget the check believes is unspent, which is the exact shape
 * of the bug that combed the grass flat.
 *
 * Lives here rather than in LIVING_LIB because the caves and the animals both
 * want it and neither of them declares LIVING_LIB's uniforms. It is a pure
 * function of a float, as rrHueRotate above is a pure function of a colour.
 */
float rrLung(float p) {
  return sin(p + 0.55 * sin(p));
}

/**
 * A SOFT CEILING ON A HUE ROTATION, and the reason there has to be one.
 *
 * The colour fields are noise. Noise has tails, and a hue rotation is the one
 * effect in this project where the tail is not a stronger version of the effect
 * — it is a different substance. Twenty degrees off green is a leaf in a strange
 * light. Eighty degrees off green is a magenta leaf, and a magenta leaf is not a
 * leaf seen strangely, it is a plastic one. The forest was full of them because
 * the amplitude was bounded on average and unbounded in fact.
 *
 * This is a smooth saturating limiter: slope 1 at the origin, so small rotations
 * pass through untouched and the field keeps every bit of its regional
 * structure, and a horizontal asymptote at arc, so no sample anywhere in the
 * world can leave the band its surface is allowed to live in. One inversesqrt,
 * no branch — and unlike a clamp it has no corner for the eye to find. A hard
 * clamp would draw a visible terminator across every trunk at the exact contour
 * where the field crossed the limit, which is a worse artefact than the one
 * being fixed and is stamped on rather than emergent.
 */
float rrBend(float a, float arc) {
  return a * inversesqrt(1.0 + (a * a) / (arc * arc));
}
`;

const UNIFORM_DECL = /* glsl */ `
uniform float uTime;
uniform float uLevel;
uniform vec3  uEgo;
uniform float uBreath;
uniform float uBreathPhase;
uniform float uBreathAmp;
uniform float uSway;
uniform float uHills;
uniform float uGlow;
uniform float uWarmth;
uniform float uSat;
uniform float uLean;
uniform float uFlow;
uniform float uSwell;
uniform float uCreep;
uniform float uDetail;
uniform float uDwell;
uniform vec3  uGazeFrom;
uniform vec3  uGazeDir;
uniform float uPulse;
uniform float uRim;
uniform float uSurge;
uniform vec3  uEye;
uniform vec4  uAudio;
uniform vec2  uWind;
`;

/**
 * Helpers that both halves of the shader need. Not part of NOISE3, because that
 * one is shared with the sky, the water and the jukebox, and those do not
 * declare uPulse.
 */
const LIVING_LIB = /* glsl */ `
/**
 * THE CANOPY PULSE.
 *
 * Two plane waves crossing the forest: one about a hundred metres from crest to
 * crest and half a minute long, one about twenty-five metres and six seconds.
 * Every leaf on every tree evaluates the same function of its own world
 * position, which is the entire trick — a thousand independently placed cards
 * with no knowledge of each other inflate and brighten in step, and the canopy
 * stops being a pile of foliage and becomes one organism making one slow
 * gesture. The long wave is the gesture; the short one is the ripple running
 * through it.
 */
float rrCanopy(vec3 p) {
  return sin(dot(p.xz, vec2(0.043, 0.031)) - uTime * 0.20)
       + sin(dot(p.xz, vec2(-0.168, 0.207)) - uTime * 1.02) * 0.5;
}

/**
 * HOW HARD IS THIS POINT BEING STARED AT, 0..1.
 *
 * A cone about the frozen gaze ray — see uGazeFrom in the uniform block for why
 * it is frozen and why that is what makes this world-anchored rather than a
 * vignette. The radius grows with distance along the ray so the cone subtends a
 * roughly constant angle, which is what a fovea does: the patch you are
 * examining is a hand's width at arm's length and a whole crown at thirty
 * metres, and in both cases it is the thing you are looking AT.
 *
 * The perpendicular distance is one cross product's worth of arithmetic. Points
 * behind the origin get nothing — t is clamped at zero, so the cone has a flat
 * back and a trunk you have walked past is not still being examined.
 *
 * The falloff is deliberately wide and soft. A hard-edged patch of extra detail
 * is a spotlight, and nobody has ever reported a spotlight.
 */
float rrStare(vec3 p) {
  if (uDwell < 0.004) return 0.0;
  vec3 rel = p - uGazeFrom;
  float t = max(dot(rel, uGazeDir), 0.0);
  float r = length(rel - uGazeDir * t);
  float cone = 0.55 + 0.09 * t;
  return uDwell * (1.0 - smoothstep(cone * 0.45, cone, r));
}

`;

/**
 * The vertex half.
 *
 * `transformed` is object space and `objectNormal` is the un-transformed normal,
 * both supplied by three's own chunks, so this can be spliced into any of the
 * built-in materials without knowing which one it is.
 */
const VERTEX_BODY = /* glsl */ `
  vec4 rrWorld4 = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    rrWorld4 = instanceMatrix * rrWorld4;
  #endif
  rrWorld4 = modelMatrix * rrWorld4;
  vec3 rrWorld = rrWorld4.xyz;

  // ---- wind, which is always on ------------------------------------------
  // The forest moves when you are sober. That matters more than it sounds: if
  // the world is static until you eat something, then movement *is* the drug,
  // and the effect reads as a switch being flipped rather than as the same
  // world seen differently.
  #ifdef RR_PLANT
    float rrFlex = aFlex;
    float rrPhase = aPhase;
    /**
     * aScale is metres of tip travel at unit amplitude — see setPlantScale in
     * this file. EVERY displacement below is a multiple of it. Absolute metres
     * here is the bug that stretched every blade of grass in the forest into a
     * spike pointing at the camera.
     *
     * NOTE FOR EDITORS: this block is inside a template literal. A backtick
     * anywhere in it, including in a comment, ends the string and throws a
     * syntax error pointing at the next word.
     */
    float rrScale = aScale;
    // A travelling gust: one large low-frequency wave crossing the forest, plus
    // a fast per-plant flutter. The gust is what makes a hundred separate plants
    // read as one body of air.
    float gust = sin(dot(rrWorld.xz, vec2(0.055, 0.037)) - uWind.x) * 0.5 + 0.5;
    gust = 0.35 + gust * 0.65;
    float flutter = sin(uWind.x * 2.7 + rrPhase * 6.2831) * 0.5
                  + sin(uWind.y * 1.31 + rrPhase * 12.9) * 0.5;
    float amp = rrFlex * gust * (0.16 + 0.25 * uSway) * rrScale;
    transformed.x += flutter * amp;
    transformed.z += flutter * amp * 0.62;
    // Plants bend, they do not stretch: pull the tip down as it swings out so
    // the distance from the root stays roughly constant.
    transformed.y -= abs(flutter) * amp * 0.35 * rrFlex;
  #endif

  vRrField = vec4(0.0);
  if (uLevel > 0.0005) {
    /**
     * THE COLOUR FIELD, SAMPLED AT THE VERTEX.
     *
     * A slow three-dimensional field the forest sits inside; it drifts upward
     * and sideways over tens of seconds, so hues move THROUGH the trees like
     * weather rather than cycling on a timer. Two scales, because one is a
     * wash: at 0.021/m the features are fifty metres across and a whole
     * hillside sat inside one of them — adding a twelve-metre term means
     * colour changes over a few paces.
     *
     * Sampled HERE and not in the fragment, because its finest feature is
     * twelve metres and the densest geometry in the forest is the 1.6 m ground
     * grid: interpolating it across a triangle is exact to well under the
     * field's own feature size, and it removes the noise taps from every
     * living fragment in the frame — the single largest term in the trip's
     * fill cost. The fragment half reads vRrField and must sample nothing.
     *
     *
     * SIX FETCHES TO TWO, AND THE SPECTRUM IT THREW AWAY WAS ALIASING.
     *
     * This used to be three SCALAR rrFbm2 calls at three domains — 0.021,
     * 0.0567 and 0.153 per metre — which is six trilinear fetches on every one
     * of the frame's ~14.9 M vertices. Three decorrelated values at one lattice
     * point is what a colour channel is for, and rrNoise3 has been sitting
     * right there since the melt was vectorised.
     *
     * The finest component the old version produced had 3.2 m features. The
     * layer carrying most of the frame's vertices is leaf cards, which are 2 to
     * 4 m across — so that octave was sampled roughly once per primitive. That
     * is below Nyquist by construction: it cannot render as detail, only as
     * each card picking an independent value. It was producing aliasing, and
     * removing it is a fix as much as a saving.
     *
     * THE FIELD IS THE SAME FIELD, MEASURED RATHER THAN ASSERTED. The three
     * components were three DOMAINS of one hash and are now three CHANNELS at
     * one domain, so the layout re-rolls — but every statistic the picture
     * depends on is preserved. Sampled at 200 k world positions and clock
     * times against the real baked lattice:
     *
     *   per component      std 0.2482 / 0.2475 / 0.2470  ->  0.2488 / 0.2438 / 0.2470
     *   hue-rotate argument  std 0.3839  ->  0.3772   p1..p99 -0.874..0.859 -> -0.849..0.888
     *   split-tone (0.5+F2)  std 0.2475  ->  0.2438
     *   glow-colour rotation std 0.4534  ->  0.4359
     *
     * The octave weights are unchanged at 0.6 and 0.3, which is why the totals
     * land where they do: the three channels are independent in both versions,
     * so matching the per-component variance matches every weighted sum of
     * them. The lacunarity is 3.9 rather than 2.03 because two octaves have to
     * cover the range six used to — energy-weighted, the old spectrum's coarse
     * head sat at 42 m and its tail at 12 m, which is what 0.021 and 0.082 per
     * metre are.
     */
    vec3 rrFp = rrWorld * 0.021 + vec3(uTime * 0.013, uTime * 0.021, uTime * -0.009);
    /**
     * The fine octave takes all four channels. Three of them are the colour
     * field; the fourth is the breath, which is a hundred and thirty lines
     * below and used to cost two fetches of its own. See rrNoise4.
     */
    vec4 rrFine = rrNoise4(rrFp * 3.9 + 17.0);
    vRrField.xyz = rrNoise3(rrFp) * 0.6 + rrFine.rgb * 0.3;

    #ifdef RR_TERRAIN
      /**
       * THE HILLS GET BIGGER.
       *
       * Keyed to distance from the eye, so the ground you are standing on does
       * not move under your feet while the far ridge swells. That asymmetry is
       * what makes it read as a change in *perception of scale* rather than as
       * the terrain being re-rendered — near depth cues stay honest and far ones
       * exaggerate, which is exactly the reported experience.
       */
      /**
       * AND THIS IS WHAT WAS EATING THE FAR WOOD.
       *
       * Reported as "some trees are disappearing", and it is not the breath or
       * the melt — it is this. Ground chunk vertices carry ABSOLUTE world
       * height (see the note on mesh.position in ground.js), so the old term
       * lifted the far terrain by a fraction of its height above sea level: a
       * ridge standing twenty metres up rose by ten metres at the peak. Trees
       * do not take this term. They are placed once on the sober height field
       * by the worker and they stay there. So every metre the ridge rose was a
       * metre of forest buried, and an eleven-metre tree on high ground was
       * gone entirely — not distorted, not clipped, simply underground. Shot
       * side by side across the valley at only forty per cent of the peak
       * value, the whole far bank of trees is there with the term off and gone
       * with it on.
       *
       * TWO CHANGES, AND THE FIRST IS THE ONE THAT MATTERS.
       *
       * The datum moves from sea level to YOUR OWN FEET. The reported effect is
       * that the hills look bigger, which is a statement about RELIEF — how far
       * the high ground stands above the low — and relief is measured from
       * where you are, not from an origin the world happens to have. So ground
       * at your level does not move at all however far away it is, ground above
       * you rises and ground below you drops. That is a genuine exaggeration of
       * shape rather than a translation of everything upward, it is much closer
       * to the thing being described, and it means the common case — a forest
       * standing on roughly the same ground you are — is not buried at all.
       *
       * The second is a ceiling. rrBend holds any single point to 2.5 m however
       * steep the country is, so the worst a tree can lose is a quarter of
       * itself and no hollow can swallow one. It is a soft asymptote rather
       * than a clamp for the usual reason: a hard limit would draw a contour
       * across the hillside exactly where the terrain crossed it. High ground
       * still moves further than low ground, which is what makes the ridgeline
       * change shape at all; it simply stops doing so without limit.
       *
       * ground.js inflates each chunk's bounding sphere by the old, much larger
       * worst case, so it is now generous rather than wrong. Left alone.
       */
      float rrFar = smoothstep(7.0, 110.0, distance(rrWorld.xz, uEye.xz));
      transformed.y += rrBend((transformed.y - (uEye.y - 1.7)) * uHills * rrFar, 2.5);
    #endif

    /**
     * THE MELT, AND IT IS GEOMETRY BECAUSE IT CANNOT BE ANYTHING ELSE.
     *
     * This used to be a post-process: read the depth buffer, reconstruct each
     * pixel's world position, offset it by this same field, project it back, and
     * resample the frame at the difference. That is world-anchored in the sense
     * that mattered — the ripple stayed on the bark when you turned — and it was
     * still wrong, for a reason no amount of tuning reaches.
     *
     * A bounded screen-space resample IS a pane of glass. Over any patch where
     * the offset is roughly constant it translates the image rigidly, and at the
     * patch's border the offset stops, so the border is a hard edge with a
     * displaced picture on one side and the true one on the other. That is the
     * optical definition of a sheet of glass lying in front of the scene, and it
     * is exactly what people saw: panes around the trunks. Worse, the guard that
     * kept the warp from sampling across silhouettes made it *more* pane-like,
     * because the guard's own threshold is another hard border.
     *
     * Displacing the vertices instead has none of that. There is no resampling,
     * so there is no second copy of anything; occlusion is solved by the depth
     * buffer for free, so there is no silhouette problem to guard against; and a
     * trunk with nine rings up its length bends through the field instead of
     * sliding sideways behind it. The world moves because the world moved.
     *
     * AND IT HAS TO ACTUALLY CHANGE, WHICH THE FIRST VERSION DID NOT.
     *
     * All three octaves used to share one domain and one time offset, and the
     * dominant one — weight 1.55 — was fifty metres across drifting at about
     * half a metre a second. A tree therefore sat in the same part of that field
     * for a minute and a half. The result passes a screenshot and fails the
     * experience: the forest was BENT, permanently, rather than moving, and a
     * deformation that never changes is not a deformation at all, it is just a
     * differently shaped forest. The reported complaint — that everything feels
     * static except the depth going in and out — is exactly what that produces,
     * because the camera dolly was then the only thing on screen with a period
     * under a minute.
     *
     * Two changes. Each octave now has its OWN domain, weight and clock, tilted
     * toward the smaller and faster ones. And each is offset by a vector that
     * travels a closed circle rather than a straight line: a field whose domain
     * orbits comes back to where it started, so it churns in place instead of
     * sliding past, and no part of the wood is ever left holding a pose.
     *
     *
     * TWO WAYS OF DOING LESS OF THIS WERE TRIED AND BOTH MEASURED AT NOTHING.
     * Do not retry them; the reasoning is seductive and the numbers are flat.
     *
     * 1. NOT MELTING THE FAR WOOD. Compute the amplitude first, fade it out
     *    with smoothstep(130, 200, distance) on everything but terrain, and
     *    skip the six fetches where it comes out zero. The arithmetic for the
     *    invisibility is sound — uFlow peaks at 1.05 m, a leaf card takes about
     *    0.22 of it, the normalised field under half again, so 0.12 m, which at
     *    200 m is ONE PIXEL behind fog passing 3.4% sober and 25% at its
     *    thinnest — and 73% of a 384 m ring is past 200 m. It still bought
     *    nothing: reversed-order A/B on a quiet GPU, three rounds each,
     *    sober +0.07, onset +0.06, peak -0.01, egodeath +0.05, still +0.02 ms.
     *    Signs in both directions, so it is zero, not small.
     *
     *    WHY, PROBABLY: after rrNoise3 the melt is six fetches of the fourteen
     *    a vertex takes, and an instanced draw's vertices span every distance
     *    at once, so a wavefront that contains one near vertex executes the
     *    whole branch anyway. The saving is real only where the whole wavefront
     *    is far, and by then the vertex stage is no longer the critical path.
     *
     * 2. MOVING rrPrepare AFTER THE ALPHA TEST for materials that do not offset
     *    their map by the warp — grass, ferns, the nine understorey layers, the
     *    props. Four fetches per discarded fragment on layers that discard
     *    about half of theirs. Measured in the same bundle as (1): flat.
     *
     * The lever that DID work is not doing fewer fetches, it is getting three
     * numbers out of one. See rrNoise3.
     */
    // Fifty metres: the slow current the whole wood leans in.
    vec3 rrPa = rrWorld * 0.019
      + vec3(sin(uTime * 0.081), sin(uTime * 0.063 + 2.1), cos(uTime * 0.071)) * 0.55
      + vec3(uTime * 0.007, uTime * 0.011, uTime * -0.009);
    // Eighteen metres: the one that reads as a stand of trees writhing together.
    vec3 rrPb = rrWorld * 0.055
      + vec3(sin(uTime * 0.19), sin(uTime * 0.157 + 1.3), cos(uTime * 0.173)) * 0.8
      + vec3(uTime * 0.02, uTime * 0.031, uTime * -0.018);
    /**
     * The vertical component is damped to 0.55 of the horizontal ones, so the
     * wood writhes sideways more than it heaves. That used to be three
     * separate 0.55 multiplies on three separate scalars; it is one constant
     * vector now, because the three components arrive together. See rrNoise3
     * for why they do, and for what changed about the field when they started.
     */
    const vec3 rrFlowAxis = vec3(1.0, 0.55, 1.0);
    /**
     * SIX BANDS TO FOUR, BY DELETING THE TWO MOST REDUNDANT ONES RATHER THAN
     * BY REDESIGNING THE FIELD.
     *
     * The two slow domains were rrFbm2v, which is two fetches: an octave at the
     * stated scale and a second at 2.03x it, weighted 0.6 and 0.3. So the melt
     * had a six-band spectrum at 52.6 / 25.9 / 18.2 / 9.0 / 5.9 / 2.9 m —
     * except that 25.9 and 18.2 are less than half an octave apart and carry
     * 0.09 and 0.36 of the variance between them. The second octave of the
     * coarse pair was very nearly a quieter copy of the first octave of the
     * medium pair. The same is true of 9.0 against 5.9.
     *
     * Dropping those two second octaves leaves 52.6 / 18.2 / 5.9 / 2.9 — four
     * fetches, each keeping its EXACT original domain, orbit vector and drift.
     * Nothing about where the field is or how fast it churns changes; there is
     * simply less of it, so the whole is scaled back up to put the variance
     * where it was. That is one constant, and it is why this could be done
     * without re-deriving the clocks the block above spent so long getting
     * right.
     *
     * Measured over 200 k world positions and clock times against the real
     * baked lattice, per component, in metres per unit of uFlow:
     *
     *   plants and props   std 0.1405 -> 0.1403     |max| 0.579 -> 0.565
     *   terrain            std 0.1287 -> 0.1287     |max| 0.538 -> 0.479
     *
     * The peak comes DOWN while the typical excursion holds, which is what
     * fewer octaves at matched variance always does — and it is free headroom
     * for check-plants.mjs, whose flow term assumes a worst case of 1.0.
     *
     * The finest band keeps its old weight exactly (0.62 x 0.3), so the canopy
     * does not fizz any harder than it already did. Raising it was the obvious
     * way to hit the variance target with a clean geometric series and it was
     * REJECTED for that reason: a 2.9 m feature on a 2-4 m leaf card is one
     * sample per card, and doubling its amplitude would have bought a matched
     * spectrum by making every card twitch independently.
     *
     * ALSO REJECTED, and it is the mirror image: compiling the rrPc pair out
     * under RR_LEAF, which would take the canopy to four fetches for a further
     * ~0.09 ms. The undersampling argument for it is sound — the terrain has had
     * exactly this treatment since it was written, and for the same reason — and
     * it is a preprocessor branch, so it does not repeat the mistake that killed
     * "skip the melt on far trees" (no wavefront contains both a leaf and a
     * trunk vertex). What stops it is the OTHER end: renormalise the leaves to
     * keep their amplitude and a canopy then writhes on a different spectrum
     * from the trunk holding it up, which is a stand of trees coming apart;
     * leave the amplitude alone and the canopy moves 18% less than the wood it
     * belongs to. Either way the crown and its trunk stop agreeing, and
     * coherence is the thing this whole file is for. The better version of the
     * idea is pivot sampling, which keeps the spectrum and fixes the shear —
     * see the rejection note above leafCard in world/trees.js for why that is
     * not here either.
     */
    vec3 rrFlow = (rrNoise3(rrPa) + rrNoise3(rrPb)) * 0.6 * rrFlowAxis;
    /**
     * A third octave at about six metres, which is what actually makes a TRUNK
     * writhe rather than merely sway: over ten metres of trunk there is now more
     * than one feature of the field, so the top goes one way while the middle
     * goes the other. Its orbit is the fastest of the three — a seventeen-second
     * period — because this is the scale at which movement is legible as
     * movement rather than as a shape.
     *
     * It KEEPS both of its octaves where the two slower domains lost theirs.
     * They are the only two bands in the field finer than ten metres, so there
     * is nothing for either of them to be redundant against, and 2.9 m is where
     * the writhe stops being a lean and starts being movement.
     *
     * The ground does not get it. The terrain mesh is a 1.6 m grid, so a
     * six-metre feature is four samples across — enough to render as facets, and
     * a faceted hillside is a worse artefact than the one being fixed. Terrain
     * therefore runs on two fetches rather than four.
     */
    #ifndef RR_TERRAIN
      vec3 rrPc = rrWorld * 0.17
        + vec3(sin(uTime * 0.37), sin(uTime * 0.31 + 0.6), cos(uTime * 0.34)) * 0.9
        + vec3(uTime * 0.05, uTime * 0.03, uTime * -0.04);
      rrFlow += rrFbm2v(rrPc) * rrFlowAxis * 0.62;
    #endif
    /**
     * Normalise the field so uFlow really is metres of travel. Was 0.42 when
     * the two slow domains had a second octave each; the two constants below
     * are 0.42 divided by how much of the standard deviation those octaves were
     * carrying — 1.0962 with the fine pair present, 1.1181 without it.
     */
    #ifdef RR_TERRAIN
      rrFlow *= 0.4696;
    #else
      rrFlow *= 0.4604;
    #endif

    float rrFlowAmp = uFlow;
    #ifdef RR_PLANT
      // Same rule as every other displacement: a plant may only move as far as a
      // plant of its size bends, and its roots stay in the ground.
      rrFlowAmp *= rrScale * 0.45 * (0.25 + 0.75 * rrFlex);
    #elif defined(RR_TERRAIN)
      // Not under your own feet. The controller walks on the analytic height
      // field, which knows nothing about this, so ground that moved within a
      // couple of paces would push the camera through itself.
      rrFlowAmp *= smoothstep(3.0, 22.0, distance(rrWorld.xz, uEye.xz));
    #else
      // Props are small and rigid: at their size this is a translation rather
      // than a deformation, and a boulder sliding half a metre reads as a bug.
      rrFlowAmp *= 0.25;
    #endif
    transformed += rrFlow * rrFlowAmp;

    /**
     * BREATHING — regional, along the surface normal.
     *
     * Sampled in world space, so two adjacent trees breathe out of phase
     * because they are at different points of the field, and a single trunk
     * has a wave travelling up it. A global scale pulse would have a fixed
     * point at the camera and would be the same filter problem in 3D.
     *
     *
     * AND IT COSTS NOTHING NOW, WHICH IS THE BEST RATIO IN THE FILE.
     *
     * This was two trilinear fetches — rrFbm2 at 0.085/m, so 11.8 m and 5.8 m
     * features — on every vertex in the frame. It is now the fourth channel of
     * a fetch the colour field was already doing, and the fourth channel was
     * previously the constant 255 on all 2.1 M texels of the lattice. See
     * bakeNoiseTexture: the alpha byte was being uploaded, kept resident and
     * returned by every tap already, and the comment sitting on it said that
     * made it free rather than that it made it wasted.
     *
     * WHAT MOVED, HONESTLY. The breath's domain goes from 11.8 m to 12.2 m and
     * loses its 5.8 m second octave; both fields are described in their own
     * comments as a slow regional swell and nothing anywhere depends on the
     * difference. Its clock changes from its own oscillate-and-drift to the
     * colour field's drift, which at this domain moves features about 1.3 m/s
     * against the old 0.8 — so a stand of trees hands the swell on to its
     * neighbour a little sooner. Measured, at 200 k samples: std 0.2458 ->
     * 0.2483, |max| 0.731 -> 0.663. The 0.664 below is what makes those two
     * standard deviations agree; a single octave has to be scaled to match a
     * two-octave field's variance, and the peak coming down with it is again
     * free headroom for check-plants.mjs.
     *
     * WHAT DOES NOT MOVE is the thing the effect is for. The breath is still a
     * function of world position, so it is still regional and still out of
     * phase with itself, and it is still decorrelated from the colour field it
     * now shares a sample point with — r = -0.013, measured against the real
     * bake. Two fields at one position are only a mistake if they are the same
     * field, and four independent hashes are what stop that.
     *
     *
     * AND IT IS A PHASE NOW, NOT AN AMPLITUDE — WHICH IS THE WHOLE OF WHY THE
     * BREATH DID NOT READ AS BREATHING.
     *
     * The field used to be a signed AMPLITUDE on one global sine: every surface
     * in the forest reached its extreme on the same tick and passed through
     * zero on the same tick, and all the world field decided was how far each
     * one went and in which direction. That is not a wave travelling through a
     * wood, it is two synchronised groups — half of it swelling while the other
     * half shrinks, and both switching over together. The note above this block
     * claimed adjacent trees breathe out of phase; they did not, they breathed
     * in ANTIphase, which is a different and much more mechanical thing.
     *
     * Feeding the same field into the phase instead makes it what the comment
     * always said: a swell that arrives at each surface when the wave reaches
     * it, travels UP a single trunk because the trunk spans a fifth of a
     * feature, and hands off to the next stand a second or two later. Nothing
     * anywhere is at rest, and nothing is in step with anything more than a few
     * metres away.
     *
     * IT IS ALSO FOUR TIMES THE MOTION FOR NONE OF THE BUDGET. The old form was
     * a product of two things that are usually small — the field's own standard
     * deviation is 0.248 and the sine's is 0.707 — so its typical excursion was
     * 0.176 of the amplitude while its worst case was 0.66. A phase-warped sine
     * has a typical excursion of 0.707 and a worst case of exactly 1.0, which is
     * the number check-plants.mjs has always budgeted. So the effect got four
     * times louder in the place it is actually experienced, and the only thing
     * that grew was a peak the check was already reserving room for.
     *
     * The 3.0 is a little under half a cycle per unit of field. At the field's
     * 12 m features that puts roughly a second and a half of phase between one
     * side of a clearing and the other, and about a quarter of that up the
     * height of a mature trunk — a gradient rather than a boundary. Push it much
     * past a full cycle and neighbouring leaf cards on ONE tree land in
     * opposition, which is not a canopy breathing, it is a canopy fizzing.
     */
    float rrBreath = rrLung(uBreathPhase + rrFine.w * 3.0);
    /**
     * A little regional variation in how DEEPLY a place breathes, on a
     * component of the colour field that is already in a register. Bounded to
     * 0.6..1.0 on purpose: the maximum has to stay exactly 1.0 or the budget
     * above stops being true.
     */
    rrBreath *= 0.6 + 0.4 * smoothstep(-0.32, 0.32, vRrField.z);
    vRrField.w = rrBreath;
    /**
     * AND HOW FAR A SURFACE MAY BREATHE IS SET BY HOW THICK IT IS, WHICH IS THE
     * ONE THING THIS TERM CANNOT BE ALLOWED TO IGNORE.
     *
     * THE BUG, reported as "some trees are disappearing". Every other
     * displacement in this file is a TRANSLATION of a neighbourhood — the melt
     * moves a whole stand together, the lean moves a whole crown — so a large
     * one bends the wood and looks wrong. This one is along the NORMAL, which
     * means it moves a surface toward or away from its own inside. Push a tube
     * inward by more than its radius and the surface passes through the axis
     * and comes out the far side, so its winding reverses, so back-face culling
     * removes it. The tree does not look distorted; it is simply not there.
     *
     * The old amplitude was 0.107 m at its absolute worst, and a branch is
     * thinner than that only near the very tips. Doubling the ceiling and
     * moving to the phase form took the worst case to 0.322 m, which is thicker
     * than most of a tree — so entire upper trunks turned inside out at the
     * bottom of each breath and the wood came and went.
     *
     * aFlex is a thickness gauge that is already on every vertex: zero at the
     * root where the trunk is half a metre across, one at the outermost shoot
     * where it is two centimetres. Squared, because radius falls off faster
     * than flex rises. The result is STRICTLY SAFER THAN THE OLD CODE
     * EVERYWHERE IT MATTERS — the two curves cross at aFlex 0.46, so every part
     * of a tree thinner than mid-trunk now breathes LESS than it did before any
     * of this pass, and only the thick wood that can afford it breathes more.
     *
     * Only under RR_BARK, and only inside RR_PLANT: a leaf card is a flat quad
     * displaced along its cluster's outward normal, so it has no inside to
     * pass through, it is drawn DoubleSide anyway, and it is the layer the
     * effect is most visible on. Fallen logs take the prop path below.
     */
    float rrBreathAmp = uBreathAmp;
    #ifdef RR_PLANT
      rrBreathAmp *= rrScale * 1.7;
      #ifdef RR_BARK
        float rrThick = 1.0 - aFlex;
        rrBreathAmp *= 0.05 + 0.95 * rrThick * rrThick;
      #endif
    #elif defined(RR_TERRAIN)
      /**
       * The same guard the melt has, and for the same reason: the controller
       * walks on the analytic height field, which knows nothing about this.
       * Ground heaving a quarter of a metre under your own feet is ground you
       * fall through. Two metres out rather than three, because unlike the melt
       * this is mostly vertical and the floor is what you are standing on.
       */
      rrBreathAmp *= 0.55 * smoothstep(2.0, 16.0, distance(rrWorld.xz, uEye.xz));
    #else
      /**
       * Props are small and solid and take the least of it. A mushroom cap is
       * fifteen centimetres across and a boulder half a metre; at the full
       * amplitude both invert exactly as the branches did, and a patch of
       * mushrooms flickering out of existence twice a breath is the same bug
       * wearing a smaller hat.
       */
      rrBreathAmp *= 0.3;
    #endif
    transformed += objectNormal * rrBreath * rrBreathAmp;

    #ifdef RR_PLANT
      /**
       * TREES LEAN IN.
       *
       * "Trees seem inviting" is a perceptual report, not a metaphor: the
       * canopy appears to bow toward you. Tilting the upper geometry toward the
       * eye by a couple of degrees is enough — past that it looks like a physics
       * bug. Flex-weighted, so trunk bases stay planted, and scaled by the
       * plant's own reach, so a tuft of grass leans a centimetre rather than
       * lunging at your face.
       */
      /**
       * AND ONLY TREES DO IT, WHICH IS BOTH THE TRUER EFFECT AND THE ONLY
       * PLACE THE DISPLACEMENT BUDGET HAD ANY ROOM LEFT.
       *
       * The report this implements is about a CANOPY: "trees seem inviting",
       * the crown bowing toward you as you walk under it. It was being applied
       * to every plant with an aFlex, so a tuft of grass by your boot was also
       * bowing toward you — and being scaled by rrScale did not make that
       * right, it only made it small. Grass does not lean at anything. What it
       * actually looked like was the ground being combed toward the camera,
       * which is a milder version of the exact artefact check-plants.mjs
       * exists to catch.
       *
       * It was also the most expensive term in the whole budget: 0.108 m of
       * grass's 0.286 m allowance, 41% of it, spent on an effect that does not
       * belong on grass. Gating it here is what pays for the breath and the
       * melt below — nothing else in this file had that much slack in it.
       *
       * Keyed on aScale rather than on a new attribute, because aScale already
       * IS the distinction: it is metres of tip travel, 0.515 on a trunk and
       * 0.09 on grass, with the understorey layers spread between. The band
       * puts trees at 1, saplings and reeds at nothing, and the tallest meadow
       * grass at a seventh — which is the right shape, since a stand of
       * two-metre meadow really does have a little of it.
       */
      vec2 toEye = uEye.xz - rrWorld.xz;
      float d = length(toEye) + 1e-3;
      float pull = uLean * aFlex * rrScale * smoothstep(38.0, 6.0, d)
                 * smoothstep(0.25, 0.45, rrScale);
      transformed.xz += normalize(toEye) * pull;
      // Extra swell on the canopy, so foliage looks fuller and heavier. This one
      // is a relative scale already, so it needs no size term.
      transformed *= 1.0 + uLevel * aFlex * 0.05 * (0.6 + 0.4 * uBreath);
    #endif

    #ifdef RR_LEAF
      /**
       * THE CANOPY INFLATES IN WAVES.
       *
       * Along the card's own normal, and a leaf card's normals point outward
       * from the centre of its cluster rather than off the face of the quad —
       * see leafCard in trees.js. That is what turns a displacement into an
       * inflation: every card in a canopy pushes away from the same middle, so
       * the foliage swells as a volume instead of the quads sliding about.
       *
       * Driven by rrCanopy, which is a pure function of world position, so the
       * swell arrives at each tree when the wave reaches it. Watch a stand of
       * them and the pulse visibly crosses the wood.
       */
      transformed += objectNormal * rrCanopy(rrWorld) * uPulse * rrScale;
    #endif
  }

  vTripWorld = rrWorld;
  #ifdef RR_PLANT
    vTripFlex = aFlex;
  #endif
  #ifdef RR_LEAF
    // See normaliseCore in trees.js: 0 in the heart of the crown, 1 at its rim.
    // One float per vertex, passed straight through.
    vRrCore = aCore;
  #endif
`;

/**
 * THE SURFACE DOMAIN, and the answer to "everything is static".
 *
 * Every procedural field in the fragment half — bark grain, ground relief, the
 * moss glow — is a function of world position. `rrSurf` is that world
 * position with a slow warp applied, and every one of them reads it instead of
 * reading `vTripWorld` directly. Change the warp and all of them move together.
 *
 * WHY A DOMAIN WARP RATHER THAN MORE VERTEX DISPLACEMENT. The reports are very
 * specific and very consistent: the wall does not come toward you. Its position
 * stays put while its TEXTURE swells — every bump in the paint rising and
 * sinking together, as though the surface were being breathed from underneath.
 * Moving vertices cannot express that, because moving vertices moves the wall.
 * Only moving the domain leaves the object exactly where it is and makes the
 * skin of it alive. It is also, incidentally, free of every failure mode this
 * project has hit: nothing is resampled, so there is no pane of glass; the
 * field is continuous everywhere, so there is no border; and it is anchored to
 * world position, so it stays on the bark when you turn your head.
 *
 * The warp is the GRADIENT of a noise field, not three independent noises. That
 * costs the same four taps and buys the thing that matters: a gradient field is
 * curl-free, so it has no swirl in it. Displacing along it spreads the texture
 * apart around the field's minima and gathers it in around the maxima — pure
 * dilation and contraction, which is precisely "the distance between the motifs
 * seems to be changing". A field with curl in it would rotate the texture
 * instead, and rotating texture is what an oil slick does.
 *
 * Two amounts ride on the same field. `uSwell` is multiplied by the breath, so
 * it passes through zero twice a cycle and the surface inhales and exhales in
 * place — no wave travelling anywhere, the whole image participating at once.
 * `uCreep` does not change sign, so it is a steady drift: the grain flowing
 * through the wood, curling around whatever the field's features happen to be.
 */
const FRAGMENT_LIB = /* glsl */ `
vec3 rrSurf;
vec2 rrUvOff;

/**
 * THE CONTOUR LATTICE WAS REMOVED HERE, AND THEN SO WAS ITS REPLACEMENT.
 *
 * rrRings drew every level-set of the vein field at a regular interval, so
 * the single wandering filament acquired siblings and became concentric closed
 * loops around each extremum — knots with rings, interlocking circles,
 * rosettes. On paper it is the best-argued effect in this file: it is
 * emergent rather than stamped on, it is continuous with what was already
 * there, and "the random bumps began arranging themselves into repeating
 * motifs" is a real and common report.
 *
 * IT WAS ALSO THE OIL, AND IT WAS THE OIL BY CONSTRUCTION.
 *
 * A level set has no direction. The filament could be squashed along the grain
 * so it ran up a trunk like a fissure; its own contours cannot be, because they
 * close around the field's extrema whatever the domain does to them. So on
 * every curved surface in the world — and the objects the player looks at
 * hardest are cylinders — the effect drew a pair of large smooth closed loops
 * in a colour that differed from the surface around them. That is not an
 * analogy for a film of oil on water. It is the same optical description.
 * Damping it on bark only moved the problem to the boughs and the logs.
 *
 * WHAT REPLACED IT was a third filament family, denser and finer and with no
 * closed loops in it, and it lasted until the whole vein network came out on
 * 2026-08-11 for being lines that a wood has no referent for. See the tombstone
 * in FRAGMENT_BODY where the network used to be. The two removals are the same
 * finding at different depths: rings were the version of the problem you can
 * name, and the filament was the version you cannot, which is why it survived
 * four passes of tuning.
 *
 * If anyone brings either back: they need a surface with no curvature the eye
 * can read as a cylinder, which this world does not have.
 */
void rrPrepare() {
  rrSurf = vTripWorld;
  rrUvOff = vec2(0.0);
  /**
   * THE SKIN BREATHES ON THE SAME TRAVELLING WAVE THE GEOMETRY DOES.
   *
   * vRrField.w is the vertex stage's phase-warped breath at this point in the
   * world — see the breath block in VERTEX_BODY. It used to be uBreath, one
   * number for the entire forest, which meant the single most-reported effect
   * in this file was a global clock: every surface you could see swelled
   * together and relaxed together, so the wood read as one object being
   * scaled rather than as a thousand surfaces each doing this on their own.
   *
   * Reading the vertex's value costs one float of vertex export and no work at
   * all, and it guarantees the two halves agree: the trunk that is furthest
   * out along its normals is also the trunk whose grain is most stretched,
   * because both are the same number.
   */
  float rrSw = uSwell * vRrField.w;
  if (abs(rrSw) + uCreep < 1e-5) return;

  /**
   * THREE AND A HALF METRES BETWEEN FEATURES, NOT ONE AND A HALF — AND THE
   * REASON IS THAT THE WARP WAS FOLDING.
   *
   * This is a displacement field, so what matters is not its amplitude but the
   * JACOBIAN of the map it defines: how much the displacement changes per metre
   * of world. Below 1 the map stretches and compresses the texture, which is the
   * effect. At 1 it becomes singular, and past 1 it FOLDS — two different pieces
   * of world land on the same sample, the field is smeared out along the fold
   * line, and every fine structure evaluated in it turns into a broad soft band.
   *
   * That is exactly what happened when the swell and the creep were raised to
   * make the morph less subtle. Estimated Jacobian: the second derivative of the
   * noise, times the finite-difference offset, times the 2.8, times the domain
   * scale, times the amplitude — about 3.6 per metre of amplitude at 0.62. At
   * the old 0.17 m that is 0.6, strong and safe; at 0.47 m it is 1.7, and the
   * bark grain and the vein filaments both dissolved into the wide cream smears
   * that read as an oil slick on every trunk in the wood.
   *
   * The fix is not less amplitude — the amplitude is the effect and it was asked
   * for. It is a COARSER FIELD. The Jacobian is proportional to the domain scale
   * and the displacement is not: rrGrad is a finite difference in DOMAIN units,
   * so halving the scale halves the folding and leaves the metres of travel
   * where they were. 0.28 puts the Jacobian back at 0.65 with two and a half
   * times the displacement the old value carried.
   *
   * The old note's worry was the other end — that much coarser and the surface
   * slides as one, which is a slab — and 3.6 m is still well inside a trunk's
   * eleven, three fissures wide and sixteen fibres wide. What swells is a patch
   * of bark rather than a single crack, which is also the better description of
   * what people report.
   */
  vec3 rrA = vTripWorld * 0.28 + vec3(0.0, uTime * 0.021, uTime * 0.013);
  float rrN0 = rrNoise(rrA);
  vec3 rrGrad = (vec3(
    rrNoise(rrA + vec3(0.35, 0.0, 0.0)),
    rrNoise(rrA + vec3(0.0, 0.35, 0.0)),
    rrNoise(rrA + vec3(0.0, 0.0, 0.35))
  ) - rrN0) * 2.8;

  #ifdef RR_TERRAIN
    /**
     * The ground gets the breath and NOT the drift, and that is a rule with
     * scars on it. Ground whose detail flows steadily in one direction is a
     * liquid, and a large smooth surface with a slow current in it is the exact
     * description of oil on water — the artefact this project has already had to
     * remove twice. Breathing is safe because it reverses: the floor swells and
     * settles without anything ever going anywhere.
     */
    rrSurf = vTripWorld + rrGrad * rrSw * 0.7;
  #else
    rrSurf = vTripWorld + rrGrad * (rrSw + uCreep);
    #if defined(RR_BARK) || defined(RR_LEAF)
      /**
       * The drawn texture goes with it.
       *
       * Bark grain and leaf cards are canvas textures sampled by UV, so the
       * procedural fields above would breathe while the picture underneath them
       * held still — and a surface where half the detail moves and half does not
       * is worse than one where none of it does. Offsetting the UV as well makes
       * the whole skin one thing.
       *
       * Only on bark and tree foliage. Grass and fern cards are a fifth the
       * size, so the same offset in metres is five times the fraction of a card,
       * and it would push drawn content past the feathered border into the hard
       * rectangular edge that took so long to get rid of.
       */
      /**
       * THE CEILING IS PER SURFACE NOW, BECAUSE ONE OF THEM HAS A BORDER AND
       * THE OTHER DOES NOT.
       *
       * 0.03 was sized against a leaf card and applied to both. Once the swell
       * and the creep nearly doubled, the product reached the limit almost
       * everywhere — so the clamp stopped being a guard and became the value:
       * bark UVs saturated at a fixed offset while the procedural grain
       * evaluated at the warped domain kept moving, which is the failure this
       * whole block exists to prevent, a surface where half the detail flows
       * and half is pinned.
       *
       * Bark tiles. There is no border to pull drawn content past and no
       * feather to fall off, so it can take three times as much and the drawn
       * fissures then travel with the procedural ones. A leaf card keeps 0.03,
       * which is what fits inside its feathered edge — see the note below.
       */
      #ifdef RR_LEAF
        const float rrUvMax = 0.03;
      #else
        const float rrUvMax = 0.09;
      #endif
      rrUvOff = clamp(
        vec2(rrGrad.x + rrGrad.z, rrGrad.y) * (rrSw + uCreep) * 0.34,
        vec2(-rrUvMax), vec2(rrUvMax)
      );
      /**
       * THE CLAMP IS NOT BELT AND BRACES.
       *
       * A leaf card's drawn content stops at 0.46 of the card and the alpha is
       * feathered to nothing over the outer six per cent — see featherEdges in
       * textures.js. The gradient of a noise field is unbounded above; where the
       * field happens to be steep it can be two or three times its typical
       * magnitude, and an offset that large would pull opaque leaf into the
       * border, where the canvas cuts it off in a dead straight line. Tens of
       * thousands of identical straight cuts in the canopy is the single artefact
       * this project has spent the most time removing. Three per cent of a card
       * is well inside the feather and is more movement than the effect needs.
       */
    #endif
  #endif
}
`;

/**
 * Replacements for two of three's own chunks, so the drawn maps are sampled at
 * the warped UV. Written out rather than wrapped because there is no way to
 * modify `vMapUv` itself — it is an input to the fragment stage and therefore
 * read-only.
 */
const MAP_FRAGMENT = /* glsl */ `
#ifdef USE_MAP
  vec4 rrMapTexel = texture2D( map, vMapUv + rrUvOff );
  diffuseColor *= rrMapTexel;
#endif
`;

/**
 * A CANOPY CARD WAS FETCHING THE SAME TEXEL TWICE.
 *
 * The leaf material passes one canvas as BOTH map and emissiveMap — the
 * emissive is "the leaf, but glowing", which is the point of it — and three
 * generates a separate varying and a separate sampler for each, so the same
 * texel of the same 512 texture was read twice per surviving fragment. The
 * canopy is the largest fill layer in the frame by a factor of two, so that is
 * a fetch worth not doing.
 *
 * Only when the two really are the same texture on the same UV, which
 * makeLiving checks rather than assumes; otherwise the honest second fetch
 * stands. Discarded fragments never reach here anyway — alphatest_fragment
 * runs between the two chunks — so this is a saving on the fragments that
 * survive, which are the expensive ones.
 *
 *
 * STOPPING THE FETCH DID NOT STOP THE EXPORT, AND THAT IS THE OTHER HALF.
 *
 * `emissiveMap` being SET is what makes three emit `vEmissiveMapUv` — and
 * `uv_pars_vertex.glsl.js` emits it as a varying of its own, with no dedup
 * against `vMapUv`, even when both slots hold the same texture on the same
 * channel. So the leaf layer's 7.8 M vertices were interpolating two floats
 * across the triangle to deliver a number `vMapUv` already had, plus a uv
 * transform to compute it and a sampler binding nothing read.
 *
 * The fix is to stop setting `emissiveMap` at all and pass `emissiveFromMap`
 * to makeLiving instead — the declaration of intent that the slot was standing
 * in for. Bit-identical output: `rrMapTexel` is `texture2D(map, vMapUv +
 * rrUvOff)`, the old path was `texture2D(emissiveMap, vEmissiveMapUv +
 * rrUvOff)` with the same texture object and therefore the same uv transform,
 * and `emissiveIntensity` is folded into the `emissive` uniform on the JS side
 * rather than applied here. Nothing changes but what is exported.
 */
const EMISSIVEMAP_FRAGMENT = /* glsl */ `
#if defined( RR_EMISSIVE_IS_MAP ) && defined( USE_MAP )
  totalEmissiveRadiance *= rrMapTexel.rgb;
#elif defined( USE_EMISSIVEMAP )
  totalEmissiveRadiance *= texture2D( emissiveMap, vEmissiveMapUv + rrUvOff ).rgb;
#endif
`;

/**
 * The fragment half.
 *
 * Runs on the material's final colour, after three's lighting, so it modulates
 * light that has already bounced rather than painting over it.
 */
const FRAGMENT_BODY = /* glsl */ `
  /**
   * WHAT YOU ARE LOOKING AT, AND HOW LONG YOU HAVE BEEN LOOKING AT IT.
   *
   * rrDet is uDetail plus the stare, and everything downstream that carried
   * "there is suddenly too much detail here" reads rrDet instead. So the effect
   * that was previously a function of how deep the trip was is now also a
   * function of attention, which is how every report describes it: the bark does
   * not have more grain in it because ninety seconds have passed, it has more
   * grain in it because you have been looking at that piece of bark.
   *
   * Costs a cross product's worth of arithmetic per fragment, and rrStare
   * returns on a uniform test before any of it when the gaze is not held — so
   * this is free when sober and free while walking.
   */
  float rrGaze = rrStare(vTripWorld);
  float rrDet = uDetail + rrGaze * 1.5;

  #ifdef RR_LEAF
    /**
     * THE CROWN HAS AN INSIDE — always on, sober or tripping, and this is the
     * answer to "the canopies look like flat green clouds".
     *
     * Every leaf card in a tree was lit identically and carried the same
     * constant emissive at 0.72, so no part of a canopy was ALLOWED to be dark.
     * A crown with no dark in it has no volume: there is nothing for the lit
     * outer shell to sit in front of, so the eye reads the whole thing as one
     * flat surface, and every gap in it reads as a HOLE punched through to the
     * sky rather than as a glimpse into shade. That is why thinning the canopy
     * made it look see-through and why thickening it alone would not have
     * fixed it — a solid flat cloud is still a flat cloud.
     *
     * NOTE FOR EDITORS: this block is inside a template literal, so there is
     * not a backtick anywhere in it — see the same warning in VERTEX_BODY. One
     * ends the string and throws a syntax error pointing at the next word.
     *
     * vRrCore is 0 in the heart of the crown and 1 at its rim (see
     * normaliseCore in trees.js), so this is real canopy self-shadowing: light
     * gets absorbed on its way in, the interior is in the shade of its own
     * foliage, and the cards deep inside — which are now most of them, since
     * foliage hangs on the boughs too — go dark. It is one multiply on a value
     * the vertex stage already had, no new pixels and no new taps, and it does
     * more for "solid" than anything else in this pass.
     *
     * MULTIPLYING AFTER THE FOG IS WHY THE DISTANCE FADE IS THERE. This block
     * runs on gl_FragColor, which at this point is tone-mapped, sRGB-encoded and
     * already mixed toward the fog colour — so at range, where the pixel is
     * mostly fog, darkening it would put a dirty fringe on every distant crown
     * instead of shading it. It is faded out over the same sort of distance the
     * bark grain is, and for the same reason: past sixty metres a crown is a
     * shape in the air and its interior is not resolvable anyway.
     *
     * The floor is 0.52 rather than the 0.4 that reads naturally, and the
     * difference is the colour space. A factor applied here is applied to an
     * sRGB-encoded value, where 0.52 is about 0.23 of the linear light — which
     * is already a deep shade. 0.4 encoded is 0.13 linear, and at that point the
     * interior of every tree is black rather than shaded.
     */
    float rrLdist = distance(vTripWorld, uEye);
    float rrShade = mix(0.52, 1.0, vRrCore);
    gl_FragColor.rgb *= mix(1.0, rrShade, 1.0 - smoothstep(22.0, 68.0, rrLdist));
  #endif

  #ifdef RR_BARK
    /**
     * BARK GETS A SURFACE — always on, sober or tripping, and this is the whole
     * of the answer to "the trees look oily".
     *
     * It was never the veins or the colour. A trunk in this forest is a nine-
     * sided tube carrying a 256-pixel texture whose fissures are drawn at about
     * eight per cent lightness contrast, which at any distance past a couple of
     * metres averages to nothing. So what was actually on screen was a smooth
     * cylinder with a smooth Lambert gradient down it — one broad soft highlight
     * running the length of every trunk in the wood. Put a warm regional colour
     * wash and some added light on top of that and you have described a polished
     * or wet surface exactly: the eye reads a broad unbroken highlight as
     * specular, and specular on wood means varnish.
     *
     * This is the same lesson the forest floor already taught, and the note left
     * on it applies here word for word: a smooth gradient cannot be made to look
     * like earth in any colour. Nor like bark. The cure is not to soften the
     * effects that landed on it, it is to give the surface something to be made
     * of first, so the light has structure to break against.
     *
     * Squashed hard in Y, because that is what makes it bark rather than
     * granite: fissures run UP a trunk. Six or seven features per metre around
     * the circumference, each one wandering a metre or so vertically before it
     * shifts.
     */
    /**
     * ONLY ON WOOD OLD ENOUGH TO HAVE CRACKED.
     *
     * The field is anisotropic in WORLD Y, which is right for a trunk and wrong
     * for everything a trunk holds up: a horizontal bough runs across the
     * squashed axis instead of along it, so it gets a fissure every fifteen
     * centimetres of its LENGTH and comes out looking like bamboo. Segmented
     * branches were the first thing visible when looking up into the canopy.
     *
     * The fix is not a better frame, it is remembering what bark is. Fissures
     * are what happens when a trunk outgrows its own skin; a twig has not done
     * that yet and is smooth. aFlex already encodes exactly that distinction —
     * zero at the root, one at the outermost shoot — so fading the grain out
     * along it puts deep bark on the trunk, shallow bark on the boughs and none
     * at all on the whips at the ends, which is both the correct tree and the
     * end of the banding.
     */
    /**
     * AND "NONE AT ALL ON THE WHIPS" WAS THE WRONG HALF OF THAT FIX.
     *
     * Killing the field on young wood cured the bamboo and re-created, on every
     * bough in the forest, the exact surface the block above exists to abolish:
     * a smooth tube with one broad unbroken Lambert highlight down it. Looking
     * up into a canopy, the boughs were polished brass rods. Adding the trip's
     * warm colour and its filaments of light to that is the "trees look oily"
     * report in one sentence — and the diagnosis in the note above is right and
     * was simply not applied here. Oily is a surface with nothing on it.
     *
     * So young wood keeps a reduced field in an ISOTROPIC domain rather than
     * losing the field. The bamboo came from ANISOTROPY, not from amplitude: a
     * horizontal bough crossing a Y-squashed domain meets a fissure every
     * fifteen centimetres of its length, which is a segment, while the same
     * bough crossing a near-round domain meets an irregular mottle, which is
     * lenticels and lichen and is what a young branch actually has on it.
     *
     * One mix on the Y factor and one on the amplitude. No extra taps anywhere
     * — this is the same four fetches it always was, evaluated in a domain that
     * changes shape along the branch.
     */
    float rrBold = 1.0;
    #ifdef RR_PLANT
      rrBold = 1.0 - smoothstep(0.34, 0.92, vTripFlex);
    #endif
    float rrBwood = mix(0.42, 1.0, rrBold);
    float rrBdist = distance(vTripWorld, uEye);
    /**
     * THE GRAIN FLOWS UP THE TRUNK — "rivers flowing in wood-grained surfaces".
     *
     * This is the most specifically attested thing anyone reports about wood
     * under psilocybin, and it is the effect that replaces the sheen: the
     * Subjective Effects Index files "flowing" as acting almost exclusively on
     * rough detailed textures and names wood grain as its commonest host, and
     * Erowid's FAQ lists rivers in wood grain by name. It is not a sheen moving
     * across a surface — it is the surface's OWN structure travelling, so the
     * fissure you are looking at is still a fissure a moment later and simply
     * somewhere else.
     *
     * ALONG THE GRAIN AND NOT ACROSS IT. The domain is squashed in Y, so a
     * displacement in Y slides the pattern along the direction the fissures
     * already run. Any other direction would drag the fissures sideways across
     * their own length, which is a texture being scrolled — and a picture
     * sliding over a shape it does not belong to is the second definition of a
     * slick this project has had to remove.
     *
     * IN CYCLES OF THE FIELD, NOT IN METRES, and that distinction is the whole
     * reason the offset is applied after the squash rather than before it. The
     * reported band is 0.03 to 0.12 CYCLES per second — a rate of pattern, not
     * a speed of travel — and the two are not the same number here, because the
     * squash makes a fissure 1.1 m long on a trunk and 0.25 m long on a whip.
     * Flowing both at one speed in metres would run the whip at half a hertz,
     * which is the rate at which flowing stops reading as wood and starts
     * reading as water. Flowing both at 0.11 cycles a second means each reads
     * as its own grain moving, which is the thing being described.
     *
     * The 0.2 is that rate divided by the 6.5 the whole vector is scaled by.
     * Only the fissures flow; the fine fibre a few lines below is a
     * micro-texture rather than grain, its features are five times finer, and
     * moving it at a matched rate is fizz.
     *
     * Keyed to uCreep, so it is exactly zero when sober and arrives with the
     * rest of the creep family rather than as an effect of its own.
     */
    float rrBflow = uTime * uCreep * 0.2;
    float rrBsq = mix(0.62, 0.14, rrBold);
    vec3 rrBp = vec3(rrSurf.x, rrSurf.y * rrBsq - rrBflow, rrSurf.z) * 6.5;
    float rrBn = rrFbm2(rrBp);
    /**
     * Relief before colour, again. Two taps to either side give a directional
     * derivative, which is a normal map without a normal map — where the field
     * rises toward the light the ridge brightens and where it falls the fissure
     * goes into shadow. Both offsets are horizontal, because a vertical fissure
     * is lit and shaded across its width, not along its length.
     */
    float rrBrelief = (rrBn - rrFbm2(rrBp + vec3(0.42, 0.0, 0.0)))
                    + (rrBn - rrFbm2(rrBp + vec3(0.0, 0.0, 0.42))) * 0.6;
    // And the fissure itself: a dark line along the zero set, which is where the
    // groove is deep enough that no light reaches the bottom of it.
    float rrGroove = 1.0 - smoothstep(0.0, 0.26, abs(rrBn));

    /**
     * The fibre, for the couple of metres where you can see it.
     *
     * Four times finer than the fissures and rotated off them, so standing with
     * your nose against a trunk gives you the thing people describe — that a
     * surface you had compressed into "brown" turns out to have dozens of
     * separate tones and a structure inside its structure. Faded out with
     * distance because its wavelength is under a pixel at fifteen metres and it
     * would shimmer rather than resolve.
     */
    // The fibre survives a good deal further out on wood you are staring at —
    // which is exactly the reported thing, since a trunk twenty metres away is
    // not something you notice the fibre of until you stop and look at it.
    float rrBclose = 1.0 - smoothstep(1.5 + rrGaze * 3.0, 13.0 + rrGaze * 22.0, rrBdist);
    float rrBfine = 0.0;
    if (rrBclose > 0.002) {
      // Unsquashed on young wood for the same reason the fissures are — see
      // rrBsq above. At twenty-seven times the domain a squashed field on a
      // horizontal whip is a band every four centimetres, which is a thread
      // rather than a branch.
      vec3 rrBq = vec3(
        rrSurf.x * 0.83 + rrSurf.z * 0.56,
        rrSurf.y * mix(0.55, 0.17, rrBold),
        rrSurf.z * 0.83 - rrSurf.x * 0.56
      ) * 27.0;
      rrBfine = (rrFbm2(rrBq) - rrFbm2(rrBq + vec3(0.3, 0.0, 0.21))) * rrBclose;
    }

    /**
     * Same distance rule as the ground, and the floor is low on purpose.
     *
     * At 0.30 a trunk forty metres off still carried a third of the relief, and
     * because relief BRIGHTENS as well as darkens, a wood full of distant trunks
     * came out lighter than it was — which the saturation lift at peak then
     * turned pink. Distant bark should be a shape in the fog, not a texture.
     */
    float rrBdetail = rrBwood * mix(0.16, 1.0, 1.0 - smoothstep(5.0, 30.0, rrBdist));

    /**
     * AND THE WOOD GETS DEEPER AS THE TRIP RISES, which is the other half of
     * what replaced the sheen.
     *
     * "Enhanced availability of sensory information which is normally filtered
     * out" is the reported mechanism for acuity enhancement, and the honest
     * rendering of it is not to add anything to the surface but to stop
     * throwing away what the surface already had. The fibre has been keyed to
     * uDetail since it was written; the fissures and the grooves had not, so
     * the only thing that arrived on a trunk during a trip was LIGHT — which is
     * how a wood ends up looking varnished. Now the fissures cut deeper and the
     * grooves go darker at the same time, so the extra light has structure to
     * break against instead of a smooth tube to lie on.
     */
    vec3 rrBc = gl_FragColor.rgb;
    rrBc *= clamp(
      1.0 + (rrBrelief * 1.7 * (1.0 + rrDet * 0.55)
             + rrBfine * 2.1 * (1.0 + rrDet)
             - rrGroove * 0.40 * (1.0 + rrDet * 0.7)) * rrBdetail,
      0.30, 1.75
    );
    // A ridge is weathered, dry and pale; the inside of a fissure is damp and
    // cold. Two tones is the difference between relief and a grey embossing.
    rrBc = mix(rrBc, rrBc * vec3(1.16, 1.03, 0.85), clamp(rrBrelief * 2.0, 0.0, 1.0) * rrBdetail * 0.6);
    rrBc = mix(rrBc, rrBc * vec3(0.74, 0.80, 0.88), rrGroove * rrBdetail * 0.35);
    /**
     * A ridge catches the sky, and it has to do it ADDITIVELY.
     *
     * Everything above is a multiplier, and a multiplier does nothing to black.
     * Pine bark in this forest is drawn at fifteen per cent lightness and spends
     * most of its life in shade, so the trunk you are standing against is very
     * nearly zero — and all the relief in the world times zero is still zero.
     * The whole point of the block was to stop trunks reading as smooth, and on
     * the darkest species it would have failed silently.
     *
     * Tiny, and only on the raised side of the field, because this is skylight
     * landing on the parts of the bark that face upward and outward. It is
     * invisible on a birch and it is the difference between bark and a silhouette
     * on a pine.
     */
    rrBc += max(0.0, rrBrelief) * 0.014 * rrBdetail;
    gl_FragColor.rgb = rrBc;
  #endif

  #ifdef RR_TERRAIN
    /**
     * GROUND DETAIL — always on, sober or tripping.
     *
     * The forest floor is a 1.6 m grid with per-vertex colour, which means that
     * up close it is a smooth Gouraud gradient with no detail in it at all.
     * Nothing you can do to a smooth gradient makes it look like earth; and when
     * the trip then rotated its hue and laid a network of bright filaments over
     * it, a large smooth surface with swirling colour and sinuous highlights is
     * precisely the description of oil on water. It looked like a slick because
     * optically it *was* one. (The filaments are gone now — see the tombstone in
     * FRAGMENT_BODY — and this texture is what the ground has instead.)
     *
     * The cure is texture — real high-frequency structure that reads as litter,
     * moss and bare earth, so the ground is made of something before the trip
     * ever touches it. Three octaves in world space, no texture map, no UVs, and
     * the finest one fades out with distance so it cannot alias into a shimmer.
     */
    float rrGdist = distance(vTripWorld, uEye);
    // rrSurf, not vTripWorld: the ground's litter and moss and lumps are then
    // evaluated in the breathing domain along with everything else, so the floor
    // swells and settles underfoot without the mesh moving a millimetre. This is
    // the safest surface in the world to do it to and the most valuable, because
    // it is the one always in frame.
    vec3 rrGp = vec3(rrSurf.x, rrSurf.y * 0.4, rrSurf.z);

    /**
     * RELIEF FIRST, COLOUR SECOND.
     *
     * Two extra taps to either side of the sample give a directional derivative
     * of the noise, which is a normal map without a normal map: where the field
     * rises toward the light the ground brightens, where it falls away it goes
     * into shadow. That is what puts lumps and hollows in a surface, and lumps
     * are the whole difference between ground and a painted backdrop. Tinting
     * alone never gets there — a smooth surface stays smooth in any colour.
     */
    vec3 rrGa = rrGp * 0.9;
    float rrH = rrFbm2(rrGa);
    float rrHx = rrFbm2(rrGa + vec3(0.55, 0.0, 0.0));
    float rrHz = rrFbm2(rrGa + vec3(0.0, 0.0, 0.55));
    float rrRelief = (rrH - rrHx) * 0.75 + (rrH - rrHz) * 0.5;

    /**
     * A second, far finer relief for the couple of metres around your feet:
     * twigs, needles, the curled edges of individual leaves. Faded out with
     * distance, because at forty metres its wavelength is under a pixel and it
     * would shimmer rather than resolve.
     *
     * The fade pushes outward a little as the trip deepens, which is the
     * mechanism behind the least dramatic and most frequently reported effect
     * there is: nothing is added to the world, there is simply suddenly too much
     * of it. Carpet stops being beige carpet and becomes fibres, and shadows
     * between fibres, and dozens of tones that used to merge. What the eye is
     * doing is refusing to compress.
     *
     * ONLY A LITTLE, THOUGH. The first attempt pushed the fade from twenty-two
     * metres to forty-eight and turned the hillside into leopard print, exactly
     * as the note above predicts — and on a floor seen at a grazing angle the
     * spots foreshorten into diagonal streaks, which is worse still. Emergent
     * detail belongs where you are actually looking at it: near the camera,
     * where the amplitude term below does the work, and where "too much detail"
     * is something you lean in and discover rather than a rash across the wood.
     */
    /**
     * THE REACH CAME IN WHEN THE AMPLITUDE WENT UP.
     *
     * The note above was written about the fade going out to forty-eight
     * metres; twenty-two plus eight was the corrected value, and it was correct
     * against the exposure and fog density this world had at the time. Once the
     * peak stopped closing a stop of exposure and stopped nearly doubling the
     * fog, the same term at the same amplitude became visible out to thirty
     * metres — and at thirty metres on a floor seen almost edge-on it is not
     * detail, it is a set of horizontal bands following the contour of the
     * hillside, which is the streaky-ground artefact this project has removed
     * twice already.
     *
     * So the amplitude stays and the reach comes in. Emergent detail is a thing
     * you lean in and discover; nineteen metres is well past where you can
     * discover anything, and everything past it is a hillside.
     */
    /**
     * The reach still comes in rather than out with the trip — see the note
     * above, and the leopard-print hillside it is about — but a piece of ground
     * you are actually STARING at is the one case the note excludes. It is near
     * by definition of being examined, it is one patch rather than the whole
     * wood, and "you lean in and discover it" is the exact phrasing of the
     * thing that was wanted. rrGaze buys the reach that uDetail is not allowed.
     */
    float rrGclose = 1.0 - smoothstep(
      4.0 + uDetail * 1.5, 19.0 + uDetail * 3.0 + rrGaze * 16.0, rrGdist
    );
    /**
     * ROTATED OFF THE LATTICE, AND TWO OCTAVES, BOTH FOR THE SAME REASON.
     *
     * rrNoise is value noise on an integer grid. A single-octave derivative of
     * it taken square-on to that grid does not read as relief, it reads as the
     * grid: the first version of this line put a regular chequerboard of dark
     * ovals across the forest floor, in rows, which is precisely the kind of
     * man-made pattern the rest of this file exists to keep out. Two octaves at
     * an irrational ratio and a domain rotation between them leave nothing for
     * the eye to lock onto.
     */
    /**
     * AND IT IS SKIPPED WHERE IT IS MULTIPLIED BY ZERO, WHICH IS MOST OF THE
     * FLOOR. Landed as part of a bundle worth -0.18 ms sober; on its own it is
     * under the noise floor of this machine, which is what four fetches on
     * part of one layer is worth here and may not be on a weaker one.
     *
     * rrGclose is nought past about twenty metres, and the ground is seen at a
     * grazing angle, so most of the terrain pixels in any frame are further
     * away than that — and every one of them was evaluating four trilinear
     * fetches and then multiplying the answer by nothing. The bark's fine
     * fibre a few blocks up has had this guard since it was written; the floor
     * simply never got one.
     *
     * The test is on the fade and not on distance so it tracks uDetail, and it
     * is a uniform-free comparison on a value every fragment of a quad has, so
     * it is as coherent as the geometry is. Nothing here takes a screen-space
     * derivative, and the lattice has no mip chain, so there is no
     * derivative-in-divergent-flow question to answer.
     *
     * The 0.002 floor is not a threshold anyone can see: at that weight the
     * term reaches 0.01 of a multiplier that is clamped into 0.45..1.9, which
     * is a fortieth of one 8-bit code.
     */
    float rrFineRelief = 0.0;
    if (rrGclose > 0.002) {
      vec3 rrGb = vec3(
        rrGp.x * 0.83 + rrGp.z * 0.56,
        rrGp.y,
        rrGp.z * 0.83 - rrGp.x * 0.56
      ) * 4.4;
      rrFineRelief = (rrFbm2(rrGb) - rrFbm2(rrGb + vec3(0.31, 0.0, 0.19))) * rrGclose;
    }

    /**
     * All of it fades with distance, and that is not an optimisation.
     *
     * A metre-scale pattern is texture at four metres and camouflage at forty:
     * the features shrink to a few pixels, the contrast survives intact, and a
     * hillside comes out looking like leopard print. Real ground loses its
     * contrast with distance because the air between you and it is scattering
     * light — so this fades toward the flat vertex colour, and the fog takes
     * over from there.
     */
    float rrGdetail = mix(0.28, 1.0, 1.0 - smoothstep(7.0, 48.0, rrGdist));

    vec3 rrG = gl_FragColor.rgb;
    rrG *= clamp(
      1.0 + (rrRelief * 1.5 * (1.0 + rrDet * 0.2) + rrFineRelief * 1.5 * (1.0 + rrDet * 1.6)
             + rrH * 0.16) * rrGdetail,
      0.45, 1.9
    );

    // Then what it is made of. Fallen leaves are warm and dead, moss is deep
    // and green and holds the light differently; two materials competing for
    // the same ground is most of what a forest floor is.
    float rrLitter = smoothstep(0.05, 0.5, rrFbm2(rrGp * 0.42 + 11.0));
    float rrMossPatch = smoothstep(-0.1, 0.38, rrFbm2(rrGp * 0.27 + 57.0));
    rrG = mix(rrG, rrG * vec3(1.28, 0.97, 0.60), rrLitter * 0.55 * rrGdetail);
    rrG = mix(rrG, rrG * vec3(0.62, 1.14, 0.55), rrMossPatch * 0.55 * rrGdetail);
    gl_FragColor.rgb = rrG;
  #endif

  if (uLevel > 0.0005) {
    vec3 rrC = gl_FragColor.rgb;
    float rrLum = dot(rrC, vec3(0.2126, 0.7152, 0.0722));

    /**
     * HOW MUCH OF THIS PIXEL IS ACTUALLY A SURFACE — and the answer to a
     * mustard-coloured middle distance.
     *
     * This whole block is spliced in after dithering_fragment, which is after
     * fog_fragment, so by the time it runs gl_FragColor has ALREADY been mixed
     * toward the fog colour. At forty metres in a peak-density wood that mix is
     * most of the way over, which means the hue rotation, the vibrance and the
     * white balance were being applied to the AIR — and the air already has the
     * trip on it, because the director shifts the fog colour itself every
     * frame. Two coats of the same treatment on one number: the base fog here
     * is a sage green at eleven per cent saturation, and warmed and pushed
     * through a vibrance it arrives as mustard. Looking up through a canopy the
     * entire background was khaki.
     *
     * Recomputing the fog factor costs one exp on a varying and a uniform that
     * three has already declared for us. Fogged pixels keep a sixth of the
     * surface treatment, so nothing has an edge where the effect stops; the
     * rest of their colour comes from where it should, which is the atmosphere.
     *
     * It also buys the near field, which is the half people actually look at:
     * with the far wood no longer competing, everything within a dozen metres
     * can be pushed harder for the same total. That is the same asymmetry the
     * dissolve grain already uses — the world in arm's reach comes apart and
     * the far trees stay a forest.
     */
    float rrSolid = 1.0;
    #if defined(USE_FOG) && defined(FOG_EXP2)
      rrSolid = 0.16 + 0.84 * exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #endif

    /**
     * THE GROUND IS THE SURFACE YOU JUDGE EVERYTHING ELSE AGAINST.
     *
     * A tree that has gone violet is a tree seen strangely. Ground that has gone
     * violet is not ground any more — it is a coloured plane you happen to be
     * standing on, and once it stops reading as earth the whole world stops
     * being a place. Underfoot is also the one surface always in view, at a
     * grazing angle, filling half the frame, so every effect applied to it is
     * applied at maximum area and minimum texture.
     *
     * So the ground takes the same fields as everything else, at a fraction of
     * the amplitude and NOT at zero. The cap is about 55° of hue rather than
     * 120°, which is the width of the arc that still reads as earth: green one
     * way into wet moss and teal, the other way into gold, dry litter and red
     * clay. Everything outside that arc — and magenta in particular — is where
     * the floor stops being a floor and becomes a coloured plane you happen to
     * be standing on.
     */
    /**
     * AND EVERY OTHER SURFACE NOW HAS ONE TOO, WHICH IS THE FIX FOR THE FOREST
     * FULL OF MAGENTA TRUNKS AND LILAC FERNS.
     *
     * The reasoning above was applied to the ground and to nothing else, on the
     * grounds that a tree that has gone violet is "a tree seen strangely". That
     * is true of a tree that has gone violet by twenty degrees. It is not true
     * of one that has gone violet by eighty, and eighty is what the field was
     * actually delivering: the regional term alone has a p1..p99 span of ±50°
     * and the split tone adds up to another 30° on top of it, so the tails of
     * two independent fields were being summed with no ceiling anywhere. Bark
     * came out hot pink, fern fronds came out lavender, and a canopy that
     * started at hue 100 was arriving at hue 20.
     *
     * A leaf is green because of chlorophyll and bark is brown because of
     * tannin, and no light in any sky moves either of them a quarter of the way
     * round the wheel. What altered perception actually does to colour is
     * reported over and over as DEPTH — the greens go impossibly deep, the
     * shadows turn out to have colour in them, a surface you had filed as
     * "brown" turns out to hold nine browns — and almost never as replacement.
     * Hue replacement is the one colour effect that reads as a rendering mode
     * rather than as a way of seeing, and it is exactly what a LUT does.
     *
     * So each surface gets the width of arc it can travel and still be the
     * thing it is, and rrBend makes that a hard asymptote rather than an
     * average. The numbers are radians of rotation about the grey axis:
     *
     *   LEAF   0.34 (~20°). Green either way is olive and gold on one side and
     *          the blue-green of wet spruce on the other. Both are foliage.
     *          Past about 25° the canopy is either autumn or aquarium.
     *   PLANT  0.36. Grass and ferns, same argument, a shade wider because
     *          undergrowth genuinely does hold more colour than a canopy.
     *   BARK   0.42 (~24°). The widest of the naturals: bark really is
     *          red-brown, grey-brown, olive and near-black between species, so
     *          the eye has no fixed expectation to violate.
     *   GROUND 0.30. The tightest, for every reason the block above gives —
     *          it is the surface the others are judged against, it is half the
     *          frame, and it is seen at a grazing angle with the least texture.
     *   PROP   0.85 (~49°). Rocks, logs, mushrooms, the jukebox, other people.
     *          Small, sparse, seen against the naturals rather than instead of
     *          them — and a genuinely scarlet or violet fungus is a thing the
     *          real forest floor has in it. This is where the colour that was
     *          taken off the wood is allowed to go.
     *
     * WHAT DID NOT GET CAPPED, DELIBERATELY: the rim, the moss glow and the
     * canopy pulse. Those are ADDED LIGHT, not pigment, and light may be any
     * colour it likes — a surface lit from inside reads as something happening
     * in the material however saturated it is, because nothing in the world says
     * what colour a glow has to be. The trip did not get less colourful; the
     * colour moved off the surfaces and into the light, which is where the
     * reports put it.
     */
    #if defined(RR_TERRAIN)
      const float rrArc = 0.30;
    #elif defined(RR_LEAF)
      const float rrArc = 0.34;
    #elif defined(RR_BARK)
      const float rrArc = 0.42;
    #elif defined(RR_PLANT)
      const float rrArc = 0.36;
    #else
      const float rrArc = 0.85;
    #endif

    float rrSplitAmp = 1.0;
    #ifdef RR_TERRAIN
      rrSplitAmp = 0.4;
    #endif

    /**
     * THE COLOUR FIELD — computed in the vertex half, interpolated here.
     *
     * See the block in VERTEX_BODY: the field's finest feature is seven
     * metres, far coarser than any triangle in the forest, so per-fragment
     * evaluation was pure waste. This is the term that makes the colour read
     * as light in the room instead of as a LUT.
     */
    float rrF = vRrField.x;
    float rrF2 = vRrField.y;
    float rrF3 = vRrField.z;

    /**
     * TWO ROTATIONS, ONE CEILING.
     *
     * The first is the regional shift: a patch of forest leans one way while the
     * next leans the other. The second is a SPLIT TONE — shadows are rotated one
     * way and highlights the other, by an amount that itself varies across the
     * world. That second term is what stops the effect reading as a colour
     * filter, because a filter moves every pixel of a surface together, and this
     * opens a hue gap between a leaf's lit face and its own shadow.
     *
     * They are SUMMED AND THEN BENT, not bent separately, and that is the whole
     * reason the arc means anything. Two limiters at 20° each still allow 40°;
     * what a surface is allowed is a total. Bending the sum also costs one
     * inversesqrt rather than two and keeps the gap the split tone opens, since
     * the limiter is monotonic — two arguments that differ still come out
     * differing, just by less at the extremes, which is precisely where they
     * should differ by less.
     *
     * THE SPLIT TONE IS DIRECTIONAL NOW. It used to be scaled by (0.5 + rrF2),
     * and rrF2 reaches -0.9, so about one region of the world in eight had the
     * sign flipped and was rendering its shadows WARM against cool highlights.
     * That is the one lighting arrangement the eye has no physical model for:
     * outdoors, the sun is warm and the sky filling the shade is blue, always,
     * and every photograph anyone has ever seen agrees. So the coefficient is
     * strictly positive now and only its STRENGTH varies regionally. It reads
     * far more strongly than the old version at two thirds of the amplitude,
     * because it is now saying something the eye already believes, louder.
     */
    float rrShadow = 1.0 - smoothstep(0.02, 0.42, rrLum);
    float rrHueArg = ((rrF * 1.35 + rrF2 * 0.62 + rrF3 * 0.38) * uLevel
                   + (rrShadow - 0.4) * 1.15 * uLevel * (0.6 + 0.4 * rrF2) * rrSplitAmp)
                   * rrSolid;
    rrC = rrHueRotate(rrC, rrBend(rrHueArg, rrArc));

    /**
     * VIBRANCE, NOT SATURATION — and this is the other half of the magenta.
     *
     * mix(grey, colour, 1 + s) is a straight-line push away from the grey
     * axis, and it pushes hardest exactly where it should push least. A pixel
     * that is already vivid has a channel close to zero, so scaling its distance
     * from grey by 1.7 drives that channel NEGATIVE, and negative clamps at
     * zero — which is not a deeper colour, it is a clipped one. Clipping two
     * channels leaves a pure primary, and pure primaries are why the ferns came
     * out electric lilac and the far canopy came out cyan. The effect was
     * literally running out of gamut and the residue was the artefact.
     *
     * Rolling the amount off against the pixel's own chroma inverts that. A
     * muted forest green — chroma around 0.3, which is most of this world — is
     * pushed at four fifths strength and goes deep and wet. Something already
     * near the edge of the gamut is pushed at a third and stays where it is.
     * That asymmetry is the reported effect stated exactly: what changes is the
     * colours you had stopped seeing, not the ones you already could.
     *
     * The floor at zero afterwards is belt and braces for the residual, and it
     * costs one instruction.
     */
    float rrMx = max(rrC.r, max(rrC.g, rrC.b));
    float rrMn = min(rrC.r, min(rrC.g, rrC.b));
    float rrChroma = (rrMx - rrMn) / max(rrMx, 1e-4);
    rrC = max(mix(vec3(rrLum), rrC, 1.0 + uSat * rrSolid / (1.0 + rrChroma * rrChroma * 2.6)), 0.0);

    // White balance toward warm, luminance preserving — the light changes
    // temperature without the frame getting brighter. Also keyed to rrSolid:
    // the fog has its own white balance, set by the director, and warming it a
    // second time here is what turned the far canopy to mustard.
    float rrWm = uWarmth * rrSolid;
    vec3 rrW = rrC * vec3(1.0 + rrWm * 0.24, 1.0 + rrWm * 0.03, 1.0 - rrWm * 0.21);
    float rrWl = dot(rrW, vec3(0.2126, 0.7152, 0.0722));
    rrC = rrW * (rrWl > 1e-4 ? rrLum / rrWl : 1.0);

    /**
     * THE VEIN FILAMENTS USED TO BE HERE, AND THEY ARE GONE — 2026-08-11.
     *
     * A three-network ridged-noise system drew self-luminous lines on every
     * trunk, fern and prop: the zero set of a world-space fbm at 1.5/m, a finer
     * one at 5.5/m, and a third built from their difference that thickened as
     * uOrder rose. It was the signature effect of the trip and the single most
     * heavily tuned block in this file — elongation on bark, a dark annulus so
     * it read as carved rather than inked, a hue arc bent to the warm half of
     * the wheel, a soft limiter so a bright vein kept its colour, coverage
     * arithmetic to hold it near a tenth of each surface.
     *
     * NONE OF THAT FIXED THE ACTUAL PROBLEM, which is that a bright line lying
     * along a noise contour has no referent in a wood. Every version was read
     * back as unrealistic, and each fix addressed how the lines were drawn
     * rather than the fact that they were lines: narrower ones are wires,
     * dimmer ones are a smear, warmer ones are amber wires. The removal is
     * therefore of the effect and not of a tuning of it.
     *
     * WHAT SURVIVES IT, because none of it was ever the filaments: the regional
     * glow colour below (still the warm arc, still pinned to place rather than
     * to the clock), the Fresnel edge contour, the moss glow, the canopy pulse,
     * and everything the surface does to itself — grain, fissures, relief,
     * swell, creep, emergent detail. Those are the terms that make a surface
     * read as MORE ITSELF, which is what the brief for this layer has always
     * been; the veins were the one term that added something the surface did
     * not have.
     *
     * uOrder went with it — it had no other consumer — along with rrVeinAmp,
     * the per-surface split that existed only to hold the filaments down on
     * bark and grass, and the RR_NO_VEINS define and its plantVeins quality
     * knob, which bought back the five noise taps a fragment this cost.
     *
     * NO BACKTICKS — this comment is inside FRAGMENT_BODY, which is a template
     * literal, and the pair that used to sit around plantVeins ended the string
     * and stopped the whole app booting with "Unexpected identifier". Same
     * warning as the one on rrNoise3 above, which is there because this has now
     * happened three times.
     */

    /**
     * THE GLOW COLOUR BELONGS TO THE PLACE, NOT TO THE CLOCK.
     *
     * The one warm colour every added-light term in this file is tinted by: the
     * edge contour, the moss glow and the canopy pulse below, and the fauna
     * shader's own copy of it. It used to rotate on uTime and on the audio's
     * high band, which means the hue of the light on a given patch of bark
     * cycled while you stood watching it. A coloured sheen that slides through
     * the spectrum on a fixed surface has exactly one referent in the physical
     * world and it is a film of oil. Sampling the hue from the regional colour
     * field instead pins it: this stand of trees glows amber, the one across
     * the hollow glows rose, and neither of them changes while you look at it.
     * The field itself drifts over tens of seconds, so the colour still moves —
     * as weather through the wood, which is the thing that was wanted, rather
     * than as a sheen on the object, which was the thing that was wrong.
     */
    /**
     * AND IT STAYS IN THE WARM HALF OF THE WHEEL, WHICH IS THE OTHER HALF OF
     * "THE TREES LOOK OILY".
     *
     * Pinning the hue to place fixed the sliding. What it did not fix is WHICH
     * hues: the rotation was uncapped, the argument reaches 1.5 radians, and 86
     * degrees off this base takes a warm orange to magenta. A curved brown tube
     * carrying bright magenta light is an oil film — not by analogy, that is
     * what an oil film looks like.
     *
     * The reported palette is unusually consistent and unusually narrow, and it
     * is not this one. Psilocybin is described over and over as EARTHY — warm
     * reds, yellows, oranges, with deep purple in the shadows — and explicitly
     * against the neon, electric, crystalline register people use for LSD.
     * Magenta light on bark is the second register, and it is the one that
     * reads as a material rather than as a way of seeing.
     *
     * So the arc is bounded and ASYMMETRIC. rrBend caps the argument at 0.62
     * radians, and the two sides are then weighted differently: the rising side
     * runs the full 0.62 and takes the base from orange up to gold, the falling
     * side is held to two thirds of it, reaches rose and copper, and stops
     * before it reaches pink. Everything this light can be is a colour a fire,
     * a low sun or a rotting log can be.
     *
     * The deep purple the reports also describe did not go anywhere; it lives
     * in the split tone above, which cools the shadows of everything in the
     * frame. That is where it belongs — purple is reported IN THE SHADE, not
     * as a light source.
     */
    float rrVh = rrBend(rrF2 * 1.6 + rrF * 0.85, 0.62);
    rrVh *= rrVh > 0.0 ? 1.0 : 0.66;
    vec3 rrGlowCol = rrHueRotate(vec3(1.0, 0.46, 0.22), rrVh);
    /**
     * HOW MUCH ADDED LIGHT THIS SURFACE TAKES: a band with a floor.
     *
     * A rising key alone puts the most added light on the brightest surface in
     * the frame, so a sunlit hillside — already near the top of the exposure —
     * got the full glow on top and bleached to bare khaki. Rolling off above
     * about half brightness moves the effect into the midtones, where there is
     * headroom for it and where the eye reads added light as luminosity rather
     * than as overexposure. That part was right.
     *
     * WHAT WAS WRONG WAS THE BOTTOM. The lower edge ran from 0.015 to 0.22, and
     * the interior of this wood is almost entirely below 0.22 — a shaded trunk
     * sits around 0.03. So every glow term evaluated to roughly two per cent of
     * itself everywhere the player actually stands, and the peak was a hue
     * rotation with nothing in it. That is a bug wearing the costume of a
     * design decision: the note it was written under says light that ignores
     * the lighting looks like a decal, which is true of a FLAT glow and not
     * true of one keyed to the surface's own field.
     *
     * A floor of 0.15 keeps the shaping — a lit surface still takes six or
     * seven times what a black one does — while making the effect exist at all
     * in shade. It also happens to be the more faithful version: this light is
     * reported as SELF-luminous, and a self-luminous thing is by definition
     * brightest where there is no other light on it.
     *
     * NOT ON THE GROUND, which keeps the old strict key. Every reason the floor
     * is right for bark is a reason it is wrong for the floor: the terrain is
     * seen at a grazing angle across most of its area, so its glow field is
     * foreshortened into long bands, and a band of light on a large smooth
     * surface is a caustic. Lifting the ground's glow ten times over turned the
     * hillside into the bottom of a swimming pool within one test render. The
     * ground stays the surface you judge the others against.
     */
    #ifdef RR_TERRAIN
      const float rrKeyFloor = 0.0;
    #else
      const float rrKeyFloor = 0.15;
    #endif
    float rrKey = (rrKeyFloor + (1.0 - rrKeyFloor) * smoothstep(0.015, 0.2, rrLum))
                * (1.0 - smoothstep(0.5, 1.4, rrLum) * 0.7);

    /**
     * THE EDGE CONTOUR — "the outline of the cushion had a band of light on it".
     *
     * This is the single most consistently described effect in the reports
     * after the vein filaments — which is now to say it is the most consistently
     * described one that is still here, since those were removed. Edges stop
     * being the place where one object ends and become objects in their own
     * right, carrying a thin band of enhanced contrast that is not quite neon.
     *
     * It is a Fresnel term — how far the surface has turned away from you — and
     * that is what makes it legal here. A silhouette detector run on the frame
     * would be a filter, stuck to the glass, tracing outlines that slide when
     * you turn your head. This is a property of the SURFACE: the band sits
     * where the trunk's own curvature takes it out of view, so walking around
     * the tree carries the band around with you the way a real grazing highlight
     * does, and looking away and back puts it exactly where it was. It also
     * comes free of geometry — nothing is displaced, nothing resampled.
     *
     * Tinted toward the regional glow colour rather than white, so an edge and
     * the moss and canopy light around it belong to the same light.
     *
     * ONLY ON SURFACES THAT ACTUALLY HAVE A SILHOUETTE, and that rules out more
     * than it sounds like.
     *
     * The term is a function of the shading normal, so it means what it is
     * supposed to mean exactly where the shading normal is the geometric one.
     *
     *   - The GROUND is excluded because Fresnel goes to one at grazing
     *     incidence and the forest floor is grazing across almost its whole
     *     area. A rim on the terrain is not an edge, it is a wash over
     *     everything past ten metres.
     *   - GRASS, FERNS AND LEAF CARDS are excluded because their normals are
     *     deliberately not geometric. Undergrowth normals are pushed toward +Y
     *     so a sward catches the sky (see clumpGeometry in forest.js) and leaf
     *     cards point away from the centre of their cluster (see leafCard in
     *     trees.js). Both are constant across a card, so "how far has this
     *     surface turned away from you" evaluates to one number for the whole
     *     quad and the rim is not an outline at all — it is a flat wash applied
     *     per card. Tested: at 0.2 amplitude every blade in the clearing lit up
     *     pink from root to tip, which is neither an edge nor grass.
     *
     * What is left is everything with real curvature — trunks, boughs, logs,
     * rocks, mushrooms, the jukebox — and those are exactly the objects whose
     * outlines the reports are about. It is also the cheap half of the frame:
     * the two heaviest fill layers in the wood skip the whole block.
     */
    #if !defined(RR_TERRAIN) && (!defined(RR_PLANT) || defined(RR_BARK))
      if (uRim > 0.002) {
        float rrFacing = 1.0 - abs(dot(normal, normalize(uEye - vTripWorld)));
        // Fourth power: a band, not a gradient. A soft falloff over the whole
        // curve of a trunk is a rim LIGHT, which reads as a lamp behind the
        // tree; the reported thing is narrow enough to be an outline.
        float rrEdge = rrFacing * rrFacing;
        rrEdge *= rrEdge;
        /**
         * GATED HARDER BY THE LIGHT THAN IT WAS, and that is the difference
         * between an organic rim and a sci-fi one.
         *
         * The floor was 0.45, so a trunk standing in deep shade still carried
         * nearly half a rim — light appearing on a surface that has none on it,
         * which is the single clearest tell that an outline is a shader effect
         * rather than a grazing highlight. A real rim is light that got there;
         * where no light gets there, there is no rim. rrKey is this surface's
         * own illumination, so keying almost all of the amplitude to it makes
         * the band appear on the sunlit trunks and vanish on the ones in the
         * hollow, which is also far more legible than having it everywhere.
         */
        rrC += mix(vec3(1.0), rrGlowCol, 0.7) * rrEdge * uRim * (0.18 + 0.82 * rrKey);
      }
    #endif

    #ifdef RR_TERRAIN
      /**
       * THE GROUND GLOWS IN PATCHES, NOT IN FILAMENTS.
       *
       * This outlived the vein network that it was written against, and the
       * argument is the one that eventually took that network out everywhere:
       * a filament laid across the forest floor at a grazing angle is
       * compressed by perspective into long sinuous bands of light on a smooth
       * surface, which is a caustic. The ground looked like the bottom of a
       * swimming pool.
       *
       * Broad soft patches instead, in the green the moss already is. Same idea —
       * the ground is lit from inside — with nothing linear to be foreshortened
       * into a ripple, and no chance of it reading as a liquid.
       */
      float rrMossGlow = smoothstep(0.06, 0.52, rrFbm2(rrSurf * 0.13 + vec3(0.0, uTime * 0.015, 0.0)));
      rrC += mix(vec3(0.30, 0.62, 0.24), rrGlowCol, 0.32) * rrMossGlow * rrKey * uGlow * 0.55;

      /**
       * And it gets LUSHER as the trip deepens rather than more chemical: the
       * greens go deep and wet, the way undergrowth does after rain. This is the
       * ground's share of the peak, and it is the one direction it can be pushed
       * hard in without ceasing to be ground.
       */
      rrC = mix(rrC, rrC * vec3(0.84, 1.12, 0.78), uLevel * 0.5);
    #endif

    #ifdef RR_LEAF
      /**
       * LIGHT TRAVELS THROUGH THE CANOPY.
       *
       * The same wave that inflates the cards in the vertex half, read again
       * here — so the swell and the brightening are the same event rather than
       * two effects that happen to be running. A crest passing overhead lifts a
       * whole quarter of the wood a fifth of a stop and drops the quarter behind
       * it, and because the wave is a function of world position the boundary
       * between them travels across the canopy at walking pace.
       *
       * This is the one term in the file that makes a tree read as a single
       * organism instead of as several hundred separate quads, and it is worth
       * more than its amplitude suggests: coherence over a large area is a much
       * stronger cue than brightness.
       */
      /**
       * AND THE LIGHT THAT ARRIVES IS THE LEAF'S OWN COLOUR, WARMED — which is
       * the whole of why the canopy was mustard.
       *
       * The second line used to add rrGlowCol directly: a warm orange, at up to
       * 0.32 of full scale, over half the canopy at once in smooth
       * hundred-metre waves. Orange added to a dark green leaf is olive, and
       * olive run through the saturation lift is mustard — so looking up at the
       * peak, the entire background of the wood was a khaki blob with green
       * only where the wave happened to be in its trough. It is the single
       * largest colour artefact in the user screenshot and it was not a hue
       * rotation at all, it was added light of the wrong colour.
       *
       * Light through a canopy is TRANSMITTED, and transmitted light is the
       * colour of what it came through. That is why a backlit leaf is a deeper,
       * hotter version of itself rather than a lamp behind a green card — red
       * penetrates leaf tissue further than blue does, so thin foliage glows
       * warm from the inside while staying unmistakably green. Multiplying the
       * leaf's own colour by a warm vector says exactly that, for the same one
       * instruction the wrong version cost, and it turns the effect from a wash
       * over the crown into the crown lighting up.
       *
       * A small absolute term survives, at a quarter of the old weight, because
       * a multiplier does nothing to black and the interior cards of a crown
       * are very nearly black — see the shading block at the top of this
       * function. That one is a glimpse of sky through the foliage rather than
       * the foliage itself, so it is allowed to be its own colour.
       */
      float rrPl = rrCanopy(vTripWorld);
      rrC *= 1.0 + rrPl * 0.15 * uLevel * (1.0 + uSurge);
      float rrPlLit = max(0.0, rrPl) * uGlow;
      rrC += rrC * vec3(1.5, 1.05, 0.45) * rrPlLit * 0.16;
      rrC += rrGlowCol * rrPlLit * 0.04;
    #endif

    /**
     * EGO DEATH USED TO DITHER THE SURFACE AWAY HERE, AND IT IS GONE —
     * 2026-08-11.
     *
     * A luminance-keyed dither hashed off floor(worldPos * cells): bright cells
     * survived at 2.02x, the rest dropped to 0.72x, reseeded at 2 Hz. The idea
     * was that a lit forest comes apart into the points of light that were
     * lighting it, and it was world-seeded rather than screen-seeded so the
     * swarm stayed attached to the trees.
     *
     * IT WAS READ BACK AS "thousands of slightly see-through tetris blocks",
     * WHICH IS EXACTLY WHAT floor() ON A DOMAIN MAKES. The cell size had been
     * pinned to about four pixels ON SCREEN to keep it from reading as either
     * Minecraft up close or aliasing at range, and that is precisely what turns
     * it into a regular lattice: a uniform-sized cell everywhere is a GRID
     * everywhere, and a grid of independently-shaded squares over a picture is
     * a mosaic filter no matter what seeded it. The rotation and the domain
     * warp above it removed the axis-aligned ROWS and could not remove the
     * quantisation, because the quantisation was the mechanism.
     *
     * The general form, which is the reusable part: a quantised domain is
     * legible AS quantisation whenever its cells are near-uniform on screen.
     * Anything that wants to dissolve a surface has to do it with a field that
     * has no cell — thresholded continuous noise, a density, a displacement —
     * or with cells whose size varies enough that no lattice is inferable.
     *
     * uDissolve itself is untouched and still drives the rest of ego death: the
     * fov opening out, the fog thinning, the sub-50 Hz pulse in trip-audio, and
     * the camera's dolly. What went is only this one term on the surfaces.
     */

    /**
     * WHAT IS BEING TRIED IN ITS PLACE — three of the four candidates, all off
     * by default, all A/B-able from the panel's Ego death section.
     *
     * The fourth is not here because it is a subtraction rather than an
     * addition: ego.unedge fades uRim out as the dissolve rises, which the
     * director does where it writes that uniform. Objects lose their outlines
     * and the wood stops separating into things. Free, and it inverts the
     * peak's own signature effect, which is what makes the phase change legible
     * rather than merely additive.
     *
     * WHAT THE THREE HAVE IN COMMON, and it is the lesson from the dither: not
     * one of them partitions the screen. There is no cell, no threshold on a
     * quantised domain, and no bounded region with an edge where the treatment
     * stops. Two of them are a lerp on a colour that is already in a register,
     * and the third thresholds a CONTINUOUS field, so the thing that survives
     * has no characteristic size and no lattice can be inferred from it.
     *
     * NONE OF THEM IS KEYED TO SCREEN POSITION EITHER. rrSolid is a function of
     * this fragment's depth and rrSwNear of its distance from the eye, and both
     * of those travel with the world when you turn your head.
     */
    if (dot(uEgo, vec3(1.0)) > 0.001) {
      /**
       * THE LUMINANCE AS IT NOW STANDS, not as rrLum has it.
       *
       * rrLum was taken two hundred lines up, before the hue rotation, the
       * vibrance, the white balance, the rim and the canopy pulse — and every
       * one of those moves it. These three terms are all about how bright this
       * pixel ENDED UP, so they cannot use the one that says how bright it
       * started. One dot product.
       */
      float rrEgoLum = dot(rrC, vec3(0.2126, 0.7152, 0.0722));

      /**
       * 1. THE NEAR WORLD TAKES THE COLOUR OF THE AIR IN IT.
       *
       * Keyed by rrSolid, which is already in a register and is exactly the
       * right number: it IS "how much of this pixel is surface rather than
       * atmosphere", so multiplying by it converts surface into air, most
       * where there is most surface to convert. The far wood is already mostly
       * air and barely moves — which also dodges the trap the fog note above
       * describes, where a term applied without that key gives the distance a
       * second coat and turns the canopy mustard.
       *
       * The percept this is aiming at is the one the reports actually describe:
       * boundaries failing. Objects stop being separate from the space between
       * them, local contrast collapses, and the wood becomes one continuous
       * field of light rather than a set of things standing in air. The fog
       * colour is the right target for it because the director is already
       * tinting the fog every frame, so this converges on the trip's own colour
       * rather than on a grey.
       *
       * Held to 0.6 so it can never fully erase: a frame of flat fog is not a
       * dissolved world, it is a lost one, and there is no way back from it
       * that reads as the phase ending. The first version capped at 0.85 and
       * the panel's preset asked for 0.8 of that, which at a dissolve of 0.96
       * put the near field 65% of the way to the fog colour — a green haze with
       * the wood faintly visible inside it. The reason to write that number
       * down rather than just lower it: this is the one candidate whose failure
       * mode is INVISIBILITY rather than an artefact, so it is the one that a
       * screenshot flatters least and the one most likely to be pushed too far
       * by someone dragging the slider looking for an effect.
       */
      if (uEgo.x > 0.001) {
        #ifdef USE_FOG
          rrC = mix(rrC, fogColor, uEgo.x * rrSolid * 0.6);
        #else
          // No fog on this material, so there is no air to dissolve into.
          // Losing the colour and keeping the luminance is the nearest honest
          // thing, and it is the same direction of travel.
          rrC = mix(rrC, vec3(rrEgoLum), uEgo.x * rrSolid * 0.6);
        #endif
      }

      /**
       * 2. THE SURFACE STOPS BEING LIT FROM OUTSIDE.
       *
       * Every pixel is pushed toward ONE luminance, keeping its hue. A trunk
       * stops having a sunny side and a shaded side; it stops reading as a
       * solid volume with light falling on it and starts reading as a region
       * that is simply luminous. That is the other half of "the surface stops
       * being a surface" — the first candidate takes away its separation from
       * the air, this one takes away its form.
       *
       * A RATIO, NOT A LERP TO A CONSTANT, because a lerp toward a fixed colour
       * is paint and washes the hue out with the shading. Scaling by
       * target/luminance moves the brightness and leaves the chromaticity
       * exactly where it was.
       *
       * THIS ONE BEIGES THE WOOD, AND THAT IS ACES RATHER THAN A BUG IN THE
       * BLOCK. It is the strongest argument against the candidate, so it is
       * written down where the candidate is rather than in a commit message.
       *
       * Measured at the deep station at a dissolve of 0.96, sRGB channel means:
       * the near canopy went from 20.8/33.8/12.1 to 63.7/52.0/22.4 — green
       * dominant to RED dominant — and a shaded trunk went from 25.7/16.9/12.4
       * to 54.0/53.1/14.3, which is the opposite direction. Both moved toward
       * grey, from whichever side they started on.
       *
       * That is what a filmic curve does to anything you lift. The output pass
       * runs a fitted ACES (see pipeline.js), which compresses the largest
       * channel hardest, so raising a saturated dark colour into its knee pulls
       * the channels together — a green canopy loses more green than red, a red
       * trunk loses more red than green, and everything converges on the same
       * warm grey. Flattening luminance and preserving chromaticity in LINEAR
       * space, which is exactly what the ratio below does, does not survive a
       * tone curve applied afterwards.
       *
       * TWO WRONG DIAGNOSES CAME FIRST and both are the reason to record the
       * measurement rather than the conclusion. The cap on the lift was dropped
       * from 3x to 1.8x, on the theory that amplifying near-black amplifies its
       * quantisation error; and the warm tint was changed from a lerp toward an
       * absolute colour to a multiplier, on the theory that adding a colour to
       * near-black is the canopy-pulse mistake all over again. Neither changed
       * the picture perceptibly. The multiplier is kept because it is the right
       * construction whether or not it was the fault here — a multiplier does
       * nothing to black — and the cap is kept because less lift is less time
       * in the knee. But the beige is inherent to what this candidate is.
       *
       * The tint is 0.10 rather than 0.18 for the same reason: ACES is already
       * supplying more warmth than this was ever meant to.
       */
      if (uEgo.y > 0.001) {
        float rrEgoFlat = 0.13;
        vec3 rrFlat = rrC * min(rrEgoFlat / max(rrEgoLum, 0.015), 1.8);
        rrFlat *= mix(vec3(1.0), rrGlowCol * 1.6, 0.10);
        rrC = mix(rrC, rrFlat, uEgo.y * rrSolid);
      }

      /**
       * 3. THE SWARM, WITHOUT A LATTICE — the direct replacement for the
       * dither, and the one that has to earn it.
       *
       * Same intent as the deleted block: keep the bright, drop the rest, so a
       * lit forest comes apart into the points of light that were lighting it.
       * The mechanism is the whole difference. A step() on hash(floor(p*cells))
       * partitions space into cells and shades each one independently, which is
       * a mosaic. A smoothstep() on an fbm partitions nothing — what survives is
       * the super-level set of a continuous field, so the surviving regions are
       * blobs with feathered edges, at every size the field has octaves for,
       * and there is no cell anywhere for the eye to lock onto.
       *
       * THE BAR MOVES WITH THE PIXEL'S OWN BRIGHTNESS, which is what makes this
       * a dissolve rather than a cloud. rrFbm3 has a standard deviation of
       * about 0.25, so a bar at 0.22 leaves roughly a fifth of a dark surface
       * standing and the luminance term takes a sunlit one to about half —
       * light survives, shade goes. The soft edge is +/-0.05, a fifth of a
       * standard deviation: wide enough that no boundary is a line, narrow
       * enough that the result is islands rather than weather.
       *
       * NEAR FIELD ONLY, which is the one thing worth keeping from the old
       * block: it is the world within arm's reach that comes apart and the far
       * trees that stay a forest. That is both the truer version and the one
       * that cannot alias, because the far wood is never asked to resolve it.
       *
       * AND IT DRIFTS RATHER THAN RESEEDING. The old one jumped to a new hash
       * at 2 Hz, chosen to sit under the 3 Hz flash threshold this project
       * documents in its safety section. A continuous field can simply move:
       * the domain travels at 0.22 units per second and rrFbm3's finest octave
       * is x4.11, so the fastest thing on screen changes at about 0.9 Hz — a
       * third of the old rate, and a boil rather than a flicker.
       *
       * The survivors go to 2.15x and the rest to 0.45x, which at the coverage
       * above is very close to average-preserving. A dissolve that also changes
       * the exposure is two effects, and only one of them was asked for.
       */
      if (uEgo.z > 0.001) {
        float rrSwNear = 1.0 - smoothstep(3.0, 30.0, distance(vTripWorld, uEye));
        float rrSw = rrFbm3(rrSurf * 2.4 + vec3(0.0, uTime * 0.22, 0.0));
        float rrSwBar = 0.22 - clamp(rrEgoLum, 0.0, 1.0) * 0.26;
        float rrKeep = smoothstep(rrSwBar - 0.05, rrSwBar + 0.05, rrSw);
        rrC = mix(rrC, rrC * (0.45 + rrKeep * 1.7), uEgo.z * rrSwNear);
      }
    }

    gl_FragColor.rgb = rrC;
  }
`;

/**
 * Attach the living layer to a material.
 *
 * `bark` and `leaf` are refinements of `plant` rather than kinds of their own: a
 * trunk is a plant that is made of wood, a canopy card is a plant that is part
 * of a crown. Both need the plant vertex behaviour, so they are flags.
 *
 * @param {THREE.Material} material
 * @param {'terrain'|'plant'|'prop'} kind
 * @param {{bark?: boolean, leaf?: boolean, emissiveFromMap?: boolean,
 *          receivesShadow?: boolean}} [features]
 */
export function makeLiving(
  material,
  kind = 'prop',
  { bark = false, leaf = false, emissiveFromMap = false, receivesShadow = true } = {}
) {
  material.defines = material.defines ?? {};
  material.defines.RR_LIVING = '';
  if (kind === 'terrain') material.defines.RR_TERRAIN = '';
  if (kind === 'plant') material.defines.RR_PLANT = '';
  if (bark) material.defines.RR_BARK = '';
  if (leaf) material.defines.RR_LEAF = '';
  /**
   * THERE WAS A `veins: false` FLAG HERE (RR_NO_VEINS), for surfaces too small
   * on screen to carry a filament — grass and ferns, driven by the `plantVeins`
   * quality knob. The filaments themselves are gone, so the opt-out and the
   * knob went with them; see the tombstone in FRAGMENT_BODY.
   */
  /**
   * Detected, or declared.
   *
   * The detection is for a material that genuinely hands the same canvas to
   * both slots — it must not silently keep the shortcut if a future material
   * stops doing so, and the UV channels have to agree as well as the textures,
   * because three offsets each map by its own transform and two textures can be
   * the same object with different repeats.
   *
   * `emissiveFromMap` is the newer and better way to ask for the same thing:
   * it says "the emissive IS the map" without setting `emissiveMap`, which is
   * what stops three exporting a second uv varying for it. See
   * EMISSIVEMAP_FRAGMENT. The detection stays for anything that has not been
   * converted.
   */
  if (
    emissiveFromMap ||
    (material.map &&
      material.emissiveMap === material.map &&
      (material.emissiveMap.channel ?? 0) === (material.map.channel ?? 0))
  ) {
    material.defines.RR_EMISSIVE_IS_MAP = '';
  }

  /**
   * A SHADOW COORDINATE THAT NOTHING WILL EVER READ, EXPORTED BY 14.3 MILLION
   * VERTICES.
   *
   * `USE_SHADOWMAP` is a GLOBAL define in three, not a per-object one. Verified
   * in the local three@0.185.1: `WebGLPrograms.js` computes
   * `shadowMapEnabled: renderer.shadowMap.enabled && shadows.length > 0` for
   * the whole renderer, `WebGLProgram.js` emits `#define USE_SHADOWMAP` from
   * that flag alone, and `receiveShadow` is a plain uniform BOOL tested at
   * runtime inside `lights_fragment_begin` — there is no RECEIVE_SHADOW define
   * and no second program.
   *
   * So every trunk and every leaf vertex in this forest was computing
   * `transformNormalByInverseViewMatrix` for the shadow normal bias, then a
   * mat4 x vec4 for `directionalShadowMatrix * shadowWorldPosition`, and then
   * EXPORTING the result as a vec4 varying — for a lookup the fragment shader
   * is guaranteed to skip, because `forest.js` gives the trunk, far-trunk and
   * leaf meshes `receiveShadow: false`.
   *
   * A varying is worth more than it sounds on this GPU specifically. Vertex
   * export space is a wave-scheduling limiter on RDNA, allocation granularity
   * is per-float rather than per-float4, and unused exports are stripped by
   * NVIDIA's compiler and NOT by AMD's. The leaf layer was exporting 23 floats;
   * this takes four of them, and RR_EMISSIVE_IS_MAP above takes two more.
   *
   * THE MECHANISM IS ONE PREPROCESSOR LINE IN EACH HALF, and it is deliberately
   * `#undef` rather than blanking the chunks. Undefining USE_SHADOWMAP makes
   * three's own guards do the work: `shadowmap_pars_vertex` stops declaring the
   * varying, `shadowmap_vertex` stops writing it, `worldpos_vertex` stops
   * computing a world position nothing else wants, `shadowmap_pars_fragment`
   * stops declaring the sampler and the uniform struct, and
   * `lights_fragment_begin` stops emitting the multiply. Every one of those
   * chunks keeps its spot-light path intact, gated on NUM_SPOT_LIGHT_COORDS,
   * which is what blanking the chunks by hand would have broken.
   *
   * THE INVARIANT, AND IT IS NOT CHECKED ANYWHERE: a mesh drawn with a material
   * built this way will not receive shadows, silently and with no warning,
   * whatever `receiveShadow` says. If a trunk or a canopy ever needs to be
   * shadowed, this flag comes off first. Casting is unaffected — the shadow
   * pass uses MeshDepthMaterial and never sees this program.
   */
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.(shader, renderer);
    for (const [name, uniform] of Object.entries(tripUniforms)) {
      shader.uniforms[name] = uniform;
    }

    const noShadow = receivesShadow ? '' : '\n#undef USE_SHADOWMAP\n';

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
${noShadow}${UNIFORM_DECL}
${NOISE3}
${LIVING_LIB}
varying vec3 vTripWorld;
varying vec4 vRrField;
#ifdef RR_PLANT
varying float vTripFlex;
attribute float aFlex;
attribute float aPhase;
attribute float aScale;
#endif
#ifdef RR_LEAF
varying float vRrCore;
attribute float aCore;
#endif
`
      )
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
${noShadow}${UNIFORM_DECL}
${NOISE3}
${LIVING_LIB}
varying vec3 vTripWorld;
varying vec4 vRrField;
#ifdef RR_PLANT
varying float vTripFlex;
#endif
#ifdef RR_LEAF
varying float vRrCore;
#endif
${FRAGMENT_LIB}
`
      )
      /**
       * The warp is computed ONCE, at the top of main, into two globals. Four
       * noise taps is not a lot but the ground, the grain and the relief all
       * want the same answer, and three surfaces disagreeing about which way the
       * surface is breathing would be worse than not breathing at all.
       *
       * `clipping_planes_fragment` is the anchor because it is the first line of
       * main in every one of three's materials, so this lands before the map is
       * sampled no matter what the material turns out to be.
       */
      .replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\n  rrPrepare();'
      )
      .replace('#include <map_fragment>', MAP_FRAGMENT)
      .replace('#include <emissivemap_fragment>', EMISSIVEMAP_FRAGMENT)
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>\n${FRAGMENT_BODY}`
      );
  };

  // Distinct defines already change the cache key, but three hashes
  // onBeforeCompile by identity, so an explicit key keeps the kinds of living
  // material from sharing a compiled program. `receivesShadow` is NOT a define
  // — it edits the source directly — so it has to be in here by hand or two
  // materials that differ only in it would share one program.
  material.customProgramCacheKey = () =>
    `rr-living-${kind}${bark ? '-bark' : ''}${leaf ? '-leaf' : ''}${
      receivesShadow ? '' : '-noshadow'
    }`;
  return material;
}

/**
 * Tag a plant geometry with how far it is allowed to move.
 *
 * THE ONE NUMBER THAT MAKES UNDERGROWTH WORK.
 *
 * Wind, breathing and the lean-toward-you term were all authored in absolute
 * metres, tuned by looking at trees. A branch tip travelling half a metre in a
 * gust is right for a fifteen-metre oak. The identical displacement applied to a
 * fifty-centimetre blade of grass moves its tip further than the blade is long —
 * so every tuft in the forest was stretched into a long straight spike pointing
 * at the camera, and twenty thousand of those read exactly like somebody had
 * combed the ground. That is the artefact.
 *
 * `aScale` is the metres of tip travel this plant gets at unit amplitude, and
 * every displacement term multiplies by it. It is a stiffness as much as a size:
 * grass is short but very flexible, a trunk is enormous and barely moves, and
 * one number covers both because what matters is how far the thing actually
 * goes.
 */
/**
 * GRASS IS THE BINDING CONSTRAINT ON EVERY DISPLACEMENT IN THE PROJECT, and
 * 0.09 rather than 0.1 is what raising the breath and the melt cost.
 *
 * The numbers below are metres of tip travel, but the ceiling that matters is
 * the RATIO to the plant's own height — see check-plants.mjs, which fails the
 * build past 55%. At these scales grass gets 17% of its height per unit of
 * amplitude, ferns 14% and a tree under 6%, so grass is three times more
 * sensitive to any global increase than the thing the increases are tuned
 * against. 0.1 was sized against the old ceilings and sat at 94% of the limit;
 * the extra breath and melt at the peak pushed it to 116% and the check caught
 * it. A tenth off here buys all of that back and costs about a centimetre of
 * sober tip travel, which is under a pixel at the distance you see grass from.
 */
export const PLANT_SCALE = {
  grass: 0.09,
  fern: 0.16,
  tree: 0.6,
};

export function setPlantScale(geometry, metres) {
  const n = geometry.attributes.position.count;
  geometry.setAttribute('aScale', new THREE.BufferAttribute(new Float32Array(n).fill(metres), 1));
  return geometry;
}

/** The always-on rates, per second. The shared baseline every client agrees on. */
const WIND_RATE_X = 0.55;
const WIND_RATE_Y = 0.83;

/**
 * Everything the wind is doing that is NOT the shared baseline, accumulated.
 *
 * Two things push the wind off the world clock, and both are one machine's
 * business: the trip's gust boost, which is a function of a level only this
 * player has, and the debug panel's `windScale`, which is a knob only this
 * player turned. Keeping their contribution in a separate accumulator is what
 * lets the baseline stay derived — see below.
 */
let windSkewX = 0;
let windSkewY = 0;

/**
 * How fast the skew gives itself back, as the fraction surviving each second.
 *
 * A TRIP MUST NOT LEAVE A PERMANENT MARK ON THE ROOM'S WIND. Without this the
 * skew is a ratchet: five minutes at full intensity adds about 150 radians of
 * gust phase, the boost then goes to zero, and that client's trees sway
 * half a minute out of step with everybody else's for the rest of the evening.
 * The trip is over and the divergence it caused is not, which is the same class
 * of bug as the clock this whole file was changed to fix.
 *
 * 0.94 — six percent a second, so a five-minute trip's worth of lead is gone in
 * about a minute. Chosen against what it does to the wind's RATE rather than
 * against how long it takes: the correction is `skew * 0.06` per second against
 * a baseline of 0.55, so even a large skew slows the gust by a few percent
 * while it drains. A faster return would be a wind that visibly stalls after a
 * trip, which trades a divergence nobody can see for an artefact everybody can.
 */
const WIND_SKEW_RETURN = 0.94;

/**
 * The trip level below which the gust boost counts as finished.
 *
 * NOT `=== 0`, AND THE FIRST VERSION OF THIS WAS. `director.level` is an eased
 * value damped toward its target, so when a trip ends it approaches zero
 * asymptotically and does not arrive: it sits at 0.009, then 0.004, then
 * 0.002. An exact comparison therefore never fired the drain even once, and the
 * skew went on growing — slowly, invisibly, and forever. The test caught it as
 * a gap that did not move in six seconds, which is a much better symptom than
 * this deserved to have.
 *
 * Two percent, because that is the point below which the boost is not a thing
 * anybody could see: it adds one percent to the wind's rate, against gusts
 * whose own amplitude varies by more than that from one to the next.
 */
const GUST_DONE_BELOW = 0.02;

/**
 * Advance the always-on wind clock.
 *
 * Separate from the trip so the forest keeps moving when nobody is tripping,
 * and so the gust phase is continuous across a trip starting and ending.
 *
 * DERIVED PLUS SKEW, RATHER THAN ACCUMULATED. This used to be `w.x += dt * …`,
 * which made the phase of every gust in the world a function of how many frames
 * this tab had drawn. Two people in one clearing therefore watched the same
 * trees sway to two different winds, and a tab that had been in the background
 * came back permanently behind. The baseline is now read off the room's clock
 * and only the deviations are integrated, so:
 *
 *   - two sober clients agree exactly, with nothing on the wire;
 *   - a tripping client still gets their harder gusts, because the boost lands
 *     in the skew and nobody else's wind is disturbed by it;
 *   - and when the trip ends the skew drains, so the divergence it caused is as
 *     temporary as the trip was. See `WIND_SKEW_RETURN`;
 *   - `probe.freeze` still stops the wind dead, because it pins the world clock
 *     AND passes `dt = 0`, so neither term can move.
 *
 * @param {number} dt seconds, already zeroed by the caller when frozen
 * @param {number} gustBoost the trip level, 0..1
 * @param {number} scale the debug panel's wind multiplier; 1 in every real session
 */
export function updateWind(dt, gustBoost = 0, scale = 1) {
  const driveX = (scale - 1) * WIND_RATE_X + scale * gustBoost * 0.5;
  const driveY = (scale - 1) * WIND_RATE_Y + scale * gustBoost * 0.4;
  windSkewX += dt * driveX;
  windSkewY += dt * driveY;
  /**
   * Drain only when nothing is pushing.
   *
   * Draining unconditionally would look tidier and would quietly break both
   * drivers. Under a constant drive the skew settles wherever the decay
   * balances it instead of holding the rate asked for — so `windScale: 4` would
   * mean four times for a few seconds and some smaller number forever, and the
   * trip's harder gusts would fade out halfway through the trip. A knob that
   * silently stops meaning what it says is the exact failure the debug panel
   * exists to avoid.
   *
   * The test is on the DRIVERS rather than on the drive they compute, because
   * the drive is a float that approaches zero without reaching it — see
   * `GUST_DONE_BELOW`.
   */
  const idle = gustBoost < GUST_DONE_BELOW && scale === 1;
  if (idle) {
    windSkewX = damp(windSkewX, 0, WIND_SKEW_RETURN, dt);
    windSkewY = damp(windSkewY, 0, WIND_SKEW_RETURN, dt);
  }
  const t = worldClock();
  const w = tripUniforms.uWind.value;
  w.x = t * WIND_RATE_X + windSkewX;
  w.y = t * WIND_RATE_Y + windSkewY;
}
