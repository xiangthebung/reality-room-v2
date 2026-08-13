import * as THREE from 'three';
import { NOISE3, tripUniforms } from '../../trip/living.js';

/**
 * How the animals are shaded, and how they move.
 *
 * WHY THESE ARE MeshLambertMaterial AND NOT ShaderMaterials.
 *
 * The atmosphere's sky, water and motes are hand-written ShaderMaterials because
 * none of them is lit by the scene's lights — they are emissive or they are the
 * sky. An animal is the opposite: it is a solid opaque thing standing in the same
 * dappled light as the trunk beside it, and the moment its lighting is computed
 * by different code from the trunk's it stops belonging to the wood. Half the
 * work of making a deer read as real is that it goes dark when it walks into
 * shade, and that it takes the *same* hemisphere colour, the *same* fog and the
 * *same* shadow map as everything else — all of which three does already and none
 * of which is worth reimplementing by hand.
 *
 * So: three's own material, with the rig and the trip spliced in through
 * `onBeforeCompile`. This is deliberately NOT `makeLiving`, for two reasons.
 *
 *   ORDER. `makeLiving` chains onto whatever `onBeforeCompile` is already there
 *   and then splices its own body in immediately after `#include <begin_vertex>`,
 *   which lands it BEFORE anything a previous hook inserted at the same anchor.
 *   The living layer computes its world position from `transformed`, so it would
 *   be sampling every field at the animal's rest pose while the animal was
 *   somewhere else — the grain would sit still while the deer walked out from
 *   under them.
 *
 *   COST. The living fragment half takes a dozen noise taps per pixel for bark
 *   grain, ground relief and moss patches, none of which belongs on a coat.
 *   What an animal actually needs from the trip is the *regional colour* (so it
 *   is the same violet as the trees around it), the saturation, and the rim —
 *   and the colour field is two taps in the VERTEX shader, interpolated.
 *
 * Everything reads the shared `tripUniforms` block, so the animals breathe on the
 * same clock as the forest and can never disagree about the time. That is the
 * same arrangement `atmosphere.js` uses for the sky and the water.
 */

/** The uniforms every fauna material borrows from the trip. Shared objects. */
function tripSlice() {
  return {
    uTime: tripUniforms.uTime,
    uLevel: tripUniforms.uLevel,
    uBreathPhase: tripUniforms.uBreathPhase,
    uGlow: tripUniforms.uGlow,
    uSat: tripUniforms.uSat,
    uWarmth: tripUniforms.uWarmth,
    uRim: tripUniforms.uRim,
    uSurge: tripUniforms.uSurge,
    uEye: tripUniforms.uEye,
    uAudio: tripUniforms.uAudio,
    uNoiseTex: tripUniforms.uNoiseTex,
  };
}

/**
 * Just the hue rotation, without the noise lattice.
 *
 * `NOISE3` is one function this needs and one `sampler3D` declaration it does
 * not: the colour field is evaluated in the VERTEX shader and interpolated, so
 * no fragment shader in this file ever samples the lattice. Including the whole
 * block would have every fauna fragment program declare a 3D sampler it never
 * reads, which is a texture unit and a bind for nothing — and on the first draw
 * of a newly compiled program it produced a real GL_INVALID_OPERATION about a
 * mismatch between texture format and sampler type. The fix for a uniform that
 * is never used is not to bind it more carefully, it is not to declare it.
 *
 * Verbatim from living.js, and it has to stay that way: it is what keeps a
 * deer's hue shift on the same wheel as the bark of the tree behind it.
 */
const HUE_ROTATE = /* glsl */ `
vec3 rrHueRotate(vec3 c, float angle) {
  const vec3 k = vec3(0.57735);
  float ca = cos(angle);
  return c * ca + cross(k, c) * sin(angle) + k * dot(k, c) * (1.0 - ca);
}
`;

const TRIP_DECL = /* glsl */ `
uniform float uTime;
uniform float uLevel;
uniform float uBreathPhase;
uniform float uGlow;
uniform float uSat;
uniform float uWarmth;
uniform float uRim;
uniform float uSurge;
uniform vec3  uEye;
uniform vec4  uAudio;
`;

/**
 * THE COLOUR FIELD, SAMPLED EXACTLY AS living.js SAMPLES IT.
 *
 * Same scale, same three octaves, same drift vector. That identity is the whole
 * point: a deer standing in the stand of trees that has gone violet must go
 * violet with them. If this field were merely *similar* the animal would read as
 * a separate object that had also been coloured, which is precisely the "several
 * effects being run" failure the trip's design is built to avoid.
 */
const FIELD_VERTEX = /* glsl */ `
  vRrField = vec3(0.0);
  if (uLevel > 0.0005) {
    vec3 rrFp = vFaunaWorld * 0.021 + vec3(uTime * 0.013, uTime * 0.021, uTime * -0.009);
    vRrField = vec3(
      rrFbm2(rrFp),
      rrFbm2(rrFp * 2.7 + 31.7),
      rrFbm2(rrFp * 7.3 - 12.3)
    );
  }
`;

/**
 * The trip, on a coat.
 *
 * AT A FRACTION OF THE WORLD'S AMPLITUDE, for the reason the ground is: the
 * forest floor was capped at 42% of the hue rotation because ground that has
 * gone violet is not ground any more. An animal is worse — a deer is recognised
 * by its *colour* as much as its shape, and one that has gone magenta is not a
 * deer that looks strange, it is a magenta shape moving through the trees, which
 * is a hallucination in the cartoon sense this project exists to avoid. Reports
 * are consistent that living things stay stubbornly themselves while everything
 * around them comes apart; that is both the truer version and the safer one.
 *
 * What the animals DO get, at full strength, is the rim and the eye. Those are
 * the two things that make a creature seem aware of you, and "the deer held my
 * gaze for much too long" is the kind of thing the trip is supposed to produce.
 */
const COAT_FRAGMENT = /* glsl */ `
  vec3 rrC = gl_FragColor.rgb;

  /**
   * COUNTERSHADING, and it is the whole of the coat.
   *
   * Every prey animal in the world is dark on top and pale underneath, because
   * that is what cancels the shading a body gets from overhead light and makes
   * it hard to see. Which means it is also the single cue that makes a lump of
   * geometry read as an ANIMAL rather than as a rock — and it comes out of the
   * body's own local Y for free, no texture, no UVs, nothing to alias.
   *
   * EVERY MARKING HERE IS A MULTIPLIER, NEVER A BLEND TOWARD A COLOUR. This
   * material is diffuse-only, so multiplying the final colour is identical to
   * multiplying the albedo — the marking is then a property of the coat and it
   * goes dark with the animal when it walks into shade. Mixing toward an
   * absolute colour instead paints light onto the pigment, so a white rump would
   * still be white in a shadow, which is a decal.
   */
  float rrUnder = 1.0 - smoothstep(uBelly.y, uBelly.x, vFaunaLocal.y);
  rrC *= mix(vec3(1.0), uPale, rrUnder * uBelly.z);
  // And darker along the spine, which is the same cue from the other end.
  rrC *= 1.0 - smoothstep(uBelly.x, uBelly.w, vFaunaLocal.y) * 0.22;

  /**
   * The flash: a rump patch, a scut, a pale throat. Small, bright, and worth
   * more than its area — a bolting rabbit in this wood is a white dot bouncing
   * away through the ferns and very nearly nothing else, and a fleeing deer is
   * the same trick at four times the size. It is the readable half of "something
   * moved over there".
   */
  float rrFlashD = length((vFaunaLocal - uFlash.xyz) * vec3(1.0, 1.4, 1.0));
  rrC *= 1.0 + 2.6 * (1.0 - smoothstep(uFlash.w * 0.5, uFlash.w, rrFlashD));

  /**
   * PIED, AND ONLY FOR THE ONE ANIMAL IN THIRTY THAT IS.
   *
   * The per-instance tint is a whole-body multiplier, which is the right shape
   * for "this one is darker" and cannot express the morph that is actually
   * worth walking up to: a rabbit with white blotches on it. That needs a
   * PATTERN, and a pattern needs somewhere to come from. Three sines of the
   * body's own local coordinates is the cheapest field with no direction in it
   * — a product of two plus a third at a different rate never lines up into
   * stripes, which is what a single sine or an axis-aligned hash both give you.
   *
   * Still a multiplier, like every other marking here: a white patch that goes
   * dark in shade is pigment, and one that does not is a sticker. The seed is
   * the individual's own, so two pied rabbits are not the same rabbit.
   *
   * SCALED BY THE ANIMAL'S OWN HEIGHT, because the frequency is in metres and a
   * deer is five times a rabbit. Without the divide the same field that gives a
   * rabbit three blotches gives a deer fifteen, which is not a piebald deer, it
   * is a leopard. uBelly.w is the species' top-of-back height and is already
   * here.
   */
  if (vFaunaMorph.x > 0.001) {
    float rrPieF = 3.0 / max(0.2, uBelly.w);
    float rrS = vFaunaMorph.y * 41.0;
    float rrBlot = sin(vFaunaLocal.z * 2.4 * rrPieF + rrS)
                 * sin(vFaunaLocal.y * 3.6 * rrPieF + rrS * 1.7)
                 + 0.6 * sin(vFaunaLocal.x * 4.3 * rrPieF - rrS * 0.6);
    rrC *= mix(1.0, 3.1, vFaunaMorph.x * smoothstep(0.12, 0.5, rrBlot));
  }

  rrC *= vFaunaTint;

  /**
   * THE EYE.
   *
   * One small sphere of added light at a fixed point on the skull, mirrored
   * across the centre line so both eyes come out of one distance test. It is on
   * faintly always — an animal's eye catches light and a stone does not — and it
   * comes up hard with the alert term, which is the value that says this
   * creature has stopped grazing and is looking at YOU.
   *
   * NOTE FOR EDITORS: this block is inside a template literal, so a backtick
   * anywhere in it — including in a comment — ends the string and throws a
   * syntax error pointing at the next word. living.js carries the same warning
   * and it is there because both files have now been caught by it.
   *
   * Additive rather than a colour swap, because an eye is a specular highlight
   * and a specular highlight is light arriving, not pigment.
   */
  float rrEye = 1.0 - smoothstep(0.0, uEyeAt.w, length(vec3(abs(vFaunaLocal.x), vFaunaLocal.yz) - uEyeAt.xyz));
  rrC += vec3(0.9, 0.86, 0.72) * rrEye * (0.10 + vFaunaAlert * 0.55 + vFaunaAlert * uLevel * 2.2);

  if (uLevel > 0.0005) {
    float rrLum = dot(rrC, vec3(0.2126, 0.7152, 0.0722));
    float rrF = vRrField.x;
    float rrF2 = vRrField.y;
    float rrF3 = vRrField.z;

    // 45% of the world's rotation. See the note above this block.
    rrC = rrHueRotate(rrC, (rrF * 1.35 + rrF2 * 0.62 + rrF3 * 0.38) * uLevel * 0.45);
    rrC = mix(vec3(rrLum), rrC, 1.0 + uSat * 0.6);
    vec3 rrW = rrC * vec3(1.0 + uWarmth * 0.24, 1.0 + uWarmth * 0.03, 1.0 - uWarmth * 0.21);
    float rrWl = dot(rrW, vec3(0.2126, 0.7152, 0.0722));
    rrC = rrW * (rrWl > 1e-4 ? rrLum / rrWl : 1.0);

    /**
     * The rim, at full amplitude and with three's own view-space normal.
     *
     * living.js excludes grass, ferns and leaf cards from this because their
     * normals are deliberately not geometric, so the Fresnel evaluates to one
     * number per card and comes out as a flat wash. An animal's normals ARE
     * geometric — a flank is a curved surface — so the band lands exactly where
     * the body turns out of view, which is what an outline is. It is also the
     * effect that most makes a creature read as *present*.
     *
     * vViewPosition points from the fragment to the camera and the shading
     * normal is in the same space, so this needs no world position and no
     * extra varying.
     */
    vec3 rrGlowCol = rrHueRotate(vec3(1.0, 0.46, 0.22), rrF2 * 1.6 + rrF * 0.85);
    float rrFacing = 1.0 - abs(dot(normal, normalize(vViewPosition)));
    float rrEdge = rrFacing * rrFacing;
    rrEdge *= rrEdge;
    rrC += mix(vec3(1.0), rrGlowCol, 0.7) * rrEdge * uRim * (0.6 + 0.9 * vFaunaAlert);

    /**
     * A faint glow along the coat, keyed to the same regional field. Broad and
     * soft, never a network of lines: a branching filament drawn on a moving
     * animal at fifteen metres is sparkle, not structure. This was written when
     * living.js still HAD such a network and the coat was the exception; the
     * network came out of the wood too on 2026-08-11, for the harder version of
     * the same objection. A broad soft luminosity is what "it was lit from
     * inside" looks like on something that is one continuous surface.
     */
    rrC += rrGlowCol * smoothstep(-0.1, 0.5, rrF3) * uGlow * 0.09 * (1.0 + uSurge);
  }

  gl_FragColor.rgb = rrC;
`;

/**
 * A four-legged animal.
 *
 * @param {object} spec
 * @param {THREE.Vector3} spec.neck   object-space pivot the head turns about
 * @param {number} spec.trimRate      radians/s of the ear / antler / tail wobble
 * @param {number} spec.trimAmp       metres of it, at the tip
 * @param {number} spec.bob           metres the body rises per half stride
 * @param {number} spec.lung          metres the flank moves, breathing at rest
 * @param {[number,number,number]} spec.pale  belly REFLECTANCE multiplier, > 1
 * @param {[number,number,number,number]} spec.belly  spineY, bellyY, strength, topY
 * @param {[number,number,number,number]} spec.flash  x, y, z, radius of the pale patch
 * @param {[number,number,number,number]} spec.eye    x, y, z, radius
 * @param {number} spec.colour        base hex
 * @param {[number,number,number]} [spec.horn] where a headpiece folds away to
 */
export function beastMaterial(spec) {
  const material = new THREE.MeshLambertMaterial({ color: spec.colour });
  material.name = `fauna-${spec.name}`;

  const own = {
    uNeck: { value: spec.neck.clone() },
    uTrim: { value: new THREE.Vector2(spec.trimRate, spec.trimAmp) },
    uBob: { value: spec.bob },
    uLung: { value: spec.lung },
    uPale: { value: new THREE.Vector3(...spec.pale) },
    uBelly: { value: new THREE.Vector4(...spec.belly) },
    uFlash: { value: new THREE.Vector4(...spec.flash) },
    uEyeAt: { value: new THREE.Vector4(...spec.eye) },
    /**
     * WHERE THE ANTLERS GO WHEN THERE ARE NONE, and w says whether this species
     * has any to hide. xyz is a point inside the skull.
     *
     * shapes.js promises that "a doe's copy of this geometry can pull them into
     * the skull and vanish them" and until now nothing did it: `aTone.x` only
     * damped the antler WOBBLE, so every deer in the wood wore a full rack and
     * half of them wore a rack that did not move. Half the herd being stags was
     * a comment rather than a fact, which is the exact shape of bug the house
     * style is supposed to catch.
     *
     * It is a mix rather than a flag because a scale is free once you have a
     * pivot: `aTone.x` at 0.55 is a young stag and at 1.15 is an old one, out of
     * the same twenty vertices, and antler size is the one thing a deer wears
     * its age on.
     */
    uHorn: { value: new THREE.Vector4(...(spec.horn ?? [0, 0, 0]), spec.horn ? 1 : 0) },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, tripSlice(), own);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
${TRIP_DECL}
${NOISE3}
uniform vec3 uNeck;
uniform vec2 uTrim;
uniform float uBob;
uniform float uLung;
uniform vec4 uHorn;
attribute vec4 aRig;
attribute vec4 aGait;
attribute vec4 aTone;
attribute vec4 aTint;
varying vec3 vRrField;
varying vec3 vFaunaLocal;
varying vec3 vFaunaWorld;
varying vec3 vFaunaTint;
varying vec2 vFaunaMorph;
varying float vFaunaAlert;
float rrLookYaw;
float rrLookPitch;
float rrTrimSwing;
float rrHorn;
`
      )
      /**
       * THE NORMAL HAS TO BE ROTATED IN THIS CHUNK AND NOWHERE ELSE.
       *
       * three transforms `objectNormal` into view space in
       * `<defaultnormal_vertex>`, which runs BEFORE `<begin_vertex>` — so a
       * normal fixed up alongside the position would be fixed up after it had
       * already been baked into `vNormal`, and a deer that turned its head would
       * have a head lit as though it were still facing forward. The angles are
       * computed here and reused below; both blocks are inside main(), so the
       * locals carry across.
       */
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `#include <beginnormal_vertex>
  rrLookYaw = aGait.z * aRig.z;
  rrLookPitch = aGait.w * aRig.z;
  /**
   * WHICH VERTICES ARE THE HEADPIECE: on the head channel AND on the trim
   * channel at once. That pair picks a deer's antler beam and nothing else —
   * its ears are head-only (aRig.w = 0) and its tail is trim-only (aRig.z = 0)
   * — and uHorn.w keeps it away from the two species where the same pair means
   * something different, because a rabbit's ears ARE head-and-trim.
   */
  rrHorn = uHorn.w * step(0.5, aRig.z) * step(0.05, aRig.w);
  /**
   * The flick, and it is no longer gated on the antler flag.
   *
   * A trailing multiply by aTone.x used to sit on the end of this line, which meant the one
   * channel that shapes.js gives three meanings to — antlers, ears, tail —
   * worked for exactly one of them: rabbits and squirrels are built with
   * antlerChance 0, so their aTone.x is always zero and their ears and tails
   * have never moved a millimetre. The mix keeps the intended behaviour on the
   * antlers (a hornless doe has nothing to wave) and hands the ears back.
   */
  rrTrimSwing = sin(uTime * uTrim.x + aTone.z * 6.2831) * uTrim.y * aRig.w
              * mix(1.0, aTone.x, rrHorn);
  if (aRig.z > 0.0) {
    float cy = cos(rrLookYaw);
    float sy = sin(rrLookYaw);
    objectNormal.xz = vec2(objectNormal.x * cy + objectNormal.z * sy, -objectNormal.x * sy + objectNormal.z * cy);
    float cp = cos(rrLookPitch);
    float sp = sin(rrLookPitch);
    objectNormal.yz = vec2(objectNormal.y * cp - objectNormal.z * sp, objectNormal.y * sp + objectNormal.z * cp);
  }
`
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
  vFaunaLocal = transformed;
  vFaunaTint = aTint.rgb;
  vFaunaMorph = vec2(aTint.w, aTone.z);
  vFaunaAlert = aTone.y;

  // A rack, or no rack, out of one geometry. See uHorn — everything that is
  // not an antler has rrHorn = 0 and is untouched.
  if (rrHorn > 0.5) transformed = mix(uHorn.xyz, transformed, aTone.x);

  /**
   * THE STRIDE. A rotation about the hip, not a translation.
   *
   * aRig.x is how far below its own hip this vertex sits, so
   * (sin a, 1 - cos a) * d is the exact circular path — the leg keeps its
   * length through the whole swing. Displacing the foot along Z instead is the
   * obvious version and it stretches the leg by a good ten per cent at the
   * extremes, which reads as rubber.
   *
   * aRig.y is the diagonal pair. A quadruped moves opposite corners together;
   * getting that wrong gives a rocking horse, which nobody can name and
   * everybody can see.
   */
  if (aRig.y != 0.0) {
    float rrSwing = sin(aGait.x + (aRig.y < 0.0 ? 3.1415927 : 0.0)) * aGait.y;
    transformed.z += sin(rrSwing) * aRig.x;
    transformed.y += (1.0 - cos(rrSwing)) * aRig.x;
  }
  // The body rises twice per stride, off the same phase, so the bounce can
  // never drift out of step with the feet.
  transformed.y += abs(sin(aGait.x)) * aGait.y * uBob;

  // Ears, antlers, tail. One channel, and the amplitude decides what it means.
  transformed.x += rrTrimSwing;
  transformed.z += rrTrimSwing * 0.35;

  if (aRig.z > 0.0) {
    vec3 rrQ = transformed - uNeck;
    float cy = cos(rrLookYaw);
    float sy = sin(rrLookYaw);
    rrQ.xz = vec2(rrQ.x * cy + rrQ.z * sy, -rrQ.x * sy + rrQ.z * cy);
    float cp = cos(rrLookPitch);
    float sp = sin(rrLookPitch);
    rrQ.yz = vec2(rrQ.y * cp - rrQ.z * sp, rrQ.y * sp + rrQ.z * cp);
    transformed = uNeck + rrQ;
  }

  /**
   * IT BREATHES, SOBER.
   *
   * Six millimetres of flank, at about thirteen breaths a minute, on the body
   * vertices only. It is beneath conscious notice and it is the difference
   * between an animal standing still and a statue of one — a creature that
   * holds absolutely still while you look at it has already told you it is a
   * model. The trip's own breath rides on top of it rather than replacing it,
   * so the same motion simply gets deeper.
   *
   * And a fast shiver when it is about to bolt. A prey animal that has decided
   * to run trembles first; that half second is the warning that makes the bolt
   * feel like something you caused.
   */
  float rrBody = (1.0 - aRig.z) * (1.0 - abs(aRig.y)) * (1.0 - aRig.w);
  /**
   * THE TRIP'S BREATH RIDES THE ANIMAL'S OWN PHASE, not a clock of its own.
   *
   * aTone.z is this individual's place in the cycle and the sober term has
   * always used it, which is why a herd does not pulse in unison. The trip's
   * contribution used to be uBreath, one number for the world — so the moment
   * the level came up, every deer in the wood snapped into lockstep with every
   * other deer AND with the trunks behind them. Same offset, same skewed
   * waveform as the forest gets: a herd on mushrooms breathes deeper, not
   * together.
   */
  /**
   * NAMED rrChest AND NOT rrLung, WHICH IS WHAT IT WAS CALLED. NOISE3 is
   * included in this shader and now declares a FUNCTION called rrLung — a
   * local of the same name is a redeclaration, and the compile error names the
   * line rather than the collision.
   */
  float rrChest = sin(uTime * 1.35 + aTone.z * 6.2831) * uLung * (1.0 + aTone.w * 2.0)
                + rrLung(uBreathPhase + aTone.z * 6.2831) * uLevel * uLung * 2.2;
  transformed += objectNormal * rrBody * rrChest;
  transformed.x += sin(uTime * 34.0 + aTone.z * 17.0) * 0.004 * aTone.w;

  vec4 rrW4 = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    rrW4 = instanceMatrix * rrW4;
  #endif
  vFaunaWorld = (modelMatrix * rrW4).xyz;
${FIELD_VERTEX}
`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
${TRIP_DECL}
${HUE_ROTATE}
uniform vec3 uPale;
uniform vec4 uBelly;
uniform vec4 uFlash;
uniform vec4 uEyeAt;
varying vec3 vRrField;
varying vec3 vFaunaLocal;
varying vec3 vFaunaWorld;
varying vec3 vFaunaTint;
varying vec2 vFaunaMorph;
varying float vFaunaAlert;
`
      )
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${COAT_FRAGMENT}`);
  };

  // three hashes onBeforeCompile by identity, so without this every species
  // would share one compiled program and take whichever uniforms compiled first.
  material.customProgramCacheKey = () => `rr-fauna-beast-${spec.name}`;
  return material;
}

/**
 * A bird, a butterfly — anything with two wings.
 *
 * ONE MATERIAL AND ONE MESH FOR BOTH KINDS OF BIRD, and the branch is the reason
 * this file has a flight path in it at all.
 *
 * A flock wheeling over the canopy is periodic motion: every bird is on a closed
 * orbit and comes back to where it started. That is exactly what the vertex
 * shader is for — `aFlight.x > 0` means "you are on an orbit, work out where you
 * are from the clock" and costs the CPU precisely nothing, ever, for ninety
 * birds. A bird perched on a branch that launches when you walk up to it is the
 * opposite: its path is a consequence of where YOU are, so it has to be driven
 * from the CPU, and it arrives through `instanceMatrix` like anything else.
 *
 * Both live in one InstancedMesh because they are the same twelve vertices in the
 * same colour, and one draw call for every bird in the world is worth a branch
 * that is coherent across every vertex of an instance.
 *
 * TWENTY-SIX PERCHERS, SIXTEEN SPECIES AND COUNTING, STILL ONE DRAW CALL.
 *
 * Every perching bird already carries a voice index into `audio/wildlife.js`, so
 * the wood has been full of birds that sing like a toucan and look like a
 * generic dark smudge. Making the bird you can walk up to LOOK like the bird you
 * can hear is the single highest-value thing available here, and the tempting
 * way to do it — a geometry and a material per species — is the one change that
 * would turn six draw calls into twenty.
 *
 * So the species lives in two instanced attributes and nothing else moves:
 *
 *   aBuild  (span, girth, length, mark) — a non-uniform scale, applied to the
 *           ONE geometry. The wings and the body take different components,
 *           because a tinamou is a big broad-winged animal with a fat body
 *           and an aracari is a long-tailed slim one with the same wingspan;
 *           a single uniform scale can say "bigger" and nothing else, and
 *           "bigger" is not a species.
 *   aMark   (r, g, b, radius) — a second colour and how far up the front of the
 *           bird it reaches. A quetzal is not a red bird, it is a green bird with
 *           a crimson front, and one colour per instance cannot say that.
 *
 * THE MARK IS RESOLVED IN THE VERTEX SHADER, which is what makes it free. It
 * folds into `vFaunaTint` — the varying the fragment shader was already
 * multiplying by — so the fragment half is byte-for-byte what it was and the
 * whole feature costs one distance test on twelve to sixteen vertices. The
 * blur that comes from interpolating a mask across a four-sided prism is not a
 * cost either: a breast patch has a soft edge in life and a hard one is a decal.
 */
export function flyerMaterial(spec) {
  const material = new THREE.MeshLambertMaterial({
    color: spec.colour,
    side: THREE.DoubleSide,
  });
  material.name = `fauna-${spec.name}`;

  /**
   * TWO-SIDED WINGS, and the one thing they are for.
   *
   * A blue morpho is not a blue butterfly. It is a brown butterfly with a
   * mirror glued to the top of its wings: the blue is structural, produced by
   * interference in the scale lamellae, and the underside is dead leaf-brown
   * with eyespots. What that means in flight is the thing everybody who has
   * seen one remembers — it does not fly past, it BLINKS past, a flash of
   * impossible electric blue and then nothing, over and over, because on half
   * of every wingbeat you are looking at the other side of the wing.
   *
   * That is a two-sided material and nothing else will do. A single colour
   * flapping is a blue butterfly and a blue butterfly is not interesting; the
   * blink is the whole image. `gl_FrontFacing` gives it for one branch on a
   * surface that was already DoubleSide, and aUnder gives every instance its
   * own underside — which is why this is spliced in per material rather than
   * always: a bird's back and belly differ too, but not like this, and the
   * bird program should not pay for an attribute it has nothing to say with.
   */
  const twoSided = !!spec.twoSided;

  const own = {
    /**
     * (x, y, z) metres the centre wanders, and W THE VERTICAL BOB.
     *
     * The bob used to be a hardcoded 1.5 in the orbit branch, which is right
     * for a bird on a wide circuit over the canopy and absurd for a butterfly
     * on a two-metre one: a 13 cm insect was bouncing three metres peak to peak
     * every lap, which put it through the ground at the bottom and into the
     * mid-storey at the top. It is a fact about the KIND of flyer, so it moved
     * here rather than becoming a fifth channel on an attribute.
     */
    uWander: { value: new THREE.Vector4(spec.wander[0], spec.wander[1], spec.wander[2], spec.wander[3] ?? 1.5) },
    /**
     * Where the mark is anchored on this KIND of flyer, in the geometry's own
     * local units: x, y, z and how heavily sideways distance counts.
     *
     * Per material rather than per instance because it is a fact about the
     * shape, not about the individual — on a bird the interesting second colour
     * is always on the front of the head and the breast (a bill, a throat, a
     * red front, a pale belly), and on a butterfly it is always the outer half
     * of the wing. Everything a species actually varies is then one radius.
     *
     * The x term is measured from |x| so one distance test marks both sides —
     * the same mirror trick the eye highlight uses in the coat shader.
     */
    uMark: { value: new THREE.Vector4(...(spec.mark ?? [0, 0, 0, 1])) },
    /** 1/half-span, i.e. metres of wingtip travel per radian of roll. See the wingbeat. */
    uHinge: { value: spec.hinge ?? 1.15 },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, tripSlice(), own);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
${TRIP_DECL}
${NOISE3}
uniform vec4 uWander;
uniform vec4 uMark;
uniform float uHinge;
attribute vec2 aWing;
attribute vec4 aFlight;
attribute vec4 aBeat;
attribute vec3 aHome;
attribute vec3 aTint;
attribute vec4 aBuild;
attribute vec4 aMark;
varying vec3 vRrField;
varying vec3 vFaunaWorld;
varying vec3 vFaunaTint;
varying float vFaunaAlert;
${twoSided ? 'attribute vec4 aUnder;\nvarying vec4 vRrUnder;' : ''}
vec3 rrRight;
vec3 rrUp;
vec3 rrFwd;
vec3 rrOrigin;
float rrBeat;
`
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `#include <beginnormal_vertex>
  /**
   * THE WINGBEAT.
   *
   * The tip travels and the shoulder does not, so everything is a function of
   * |aWing.x|. Three terms, and the third is the one that matters: the wing
   * SHORTENS as it folds, because a wing seen from the side of its stroke is
   * foreshortened, and without that the bird looks like it is waving two rigid
   * boards. The normal rolls with it too, which is why a distant flock
   * twinkles — every upstroke catches the sky for a frame or two, and that
   * flicker is most of what identifies a smudge at ninety metres as birds.
   */
  rrBeat = sin(uTime * aBeat.z + aBeat.x);
  // Only the WINGS take the rolled normal. The body is a solid prism whose
  // normals point out of it, and overwriting those would light a bird as a flat
  // card from above — which is what it used to be and is no longer.
  if (abs(aWing.x) > 0.06) {
    /**
     * THE ROLL IS A SLOPE, NOT A DISPLACEMENT, and the two were the same number.
     *
     * aBeat.y is the wingtip's travel in METRES. The angle the wing surface is
     * actually tilted at is that travel over the wing's own half-span, and the
     * old line used the metres directly as radians. For a bird those happen to
     * be close — 0.2 m over a 0.31 m half-span is a slope of 0.65, against a
     * 0.23 rad the old form produced, so the flock was under-rolled by a factor
     * of three and nobody could tell at ninety metres.
     *
     * On a butterfly the same line is catastrophic rather than merely wrong.
     * The wingtip travels 7 cm over an 8 cm half-span — a REAL tilt of about
     * fifty degrees, which is what makes a butterfly a butterfly — while the
     * shading normal was rolling four degrees. The geometry was flapping and
     * the lighting was not, and worse, nothing that asks WHICH WAY THE WING IS
     * POINTING could work at all. The morpho's flash is exactly that question.
     *
     * uHinge is 1/half-span, so the product is the true slope and atan is the
     * true angle. For the birds uHinge stays at the 1.15 the old line had baked
     * in, which makes this numerically identical for them to four decimal
     * places (atan(x) ≈ x at a fifth of a radian) — the flock is not being
     * changed by a butterfly pass. Correcting the birds is a separate question
     * with a separate before-and-after.
     */
    float rrRoll = atan(rrBeat * aBeat.y * uHinge) * sign(aWing.x);
    objectNormal = vec3(-sin(rrRoll), cos(rrRoll), 0.0);
  }

  rrOrigin = vec3(0.0);
  rrRight = vec3(1.0, 0.0, 0.0);
  rrUp = vec3(0.0, 1.0, 0.0);
  rrFwd = vec3(0.0, 0.0, 1.0);
  if (aFlight.x > 0.0) {
    /**
     * A FLOCK IS A CIRCLE THAT DOES NOT STAY PUT.
     *
     * A ring of birds on a fixed orbit is a carousel — the eye finds the centre
     * in about four seconds and the illusion is over. Drifting the centre round
     * a slow closed loop of its own fixes it for the same reason the melt's
     * octaves were given orbits rather than straight lines: a domain that comes
     * back to where it started churns in place instead of sliding off the map,
     * so the flock wanders over the wood indefinitely without ever leaving it.
     *
     * The ellipse is 0.78 in Z rather than round, and every bird carries its own
     * radius, phase and centre offset, so what you see is a loose crowd sharing
     * a direction rather than a formation.
     */
    float rrAng = aFlight.z + uTime * aFlight.y;
    rrOrigin = aHome + vec3(
      sin(uTime * 0.037 + aFlight.z) * uWander.x,
      sin(uTime * 0.023 + aFlight.z * 1.7) * uWander.y,
      cos(uTime * 0.031 + aFlight.z) * uWander.z
    );
    float rrR = aFlight.x;
    vec2 rrRing = vec2(cos(rrAng) * rrR, sin(rrAng) * rrR * 0.78);
    rrOrigin += vec3(rrRing.x, sin(rrAng * 2.0 + aBeat.x) * uWander.w, rrRing.y);
    rrFwd = normalize(vec3(-sin(rrAng), 0.0, cos(rrAng) * 0.78));
    // Bank into the turn. A bird that circles flat is an aeroplane.
    rrUp = normalize(vec3(-rrFwd.z * aFlight.w, 1.0, rrFwd.x * aFlight.w));
    rrRight = normalize(cross(rrUp, rrFwd));
    rrUp = cross(rrFwd, rrRight);
    objectNormal = rrRight * objectNormal.x + rrUp * objectNormal.y + rrFwd * objectNormal.z;
  }
`
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
  vFaunaAlert = aBeat.y;
  float rrSpan = abs(aWing.x);

  /**
   * THE SPECIES, AS A NON-UNIFORM SCALE.
   *
   * rrWingy separates the two halves of the animal out of an attribute that
   * is already there: aWing.x is 0 down the body's centre line, ±0.05 at the
   * shoulder and ±1 at the tip, so a smoothstep over that range is "how much of
   * a wing is this vertex". The wing then takes the span multiplier and the body
   * takes the girth, out of one geometry and with no branch that can diverge
   * across an instance.
   *
   * z is the one that carries the tail. There is no attribute that separates a
   * tail feather from the rear of the body — both are aWing.y = 1 — so a long
   * long "length" lengthens the whole rear of the animal, which is what a long-tailed
   * bird looks like anyway and is the reason this is three numbers and not four.
   */
  float rrWingy = smoothstep(0.05, 0.30, rrSpan);
  transformed.x *= mix(aBuild.y, aBuild.x, rrWingy);
  transformed.y *= aBuild.y;
  transformed.z *= mix(aBuild.z, aBuild.x, rrWingy);

  /**
   * THE SECOND COLOUR, resolved here and folded into the tint the fragment
   * shader already multiplies by. See uMark.
   *
   * The unmodified "position", not "transformed", so the patch is nailed to the bird's
   * rest pose and does not slide up its chest when it beats its wings. The 2.4
   * on y is what keeps it on the UNDERSIDE: without it a quetzal's crimson wraps over
   * the crown, and a bird whose whole head is one colour is a toy.
   */
  vec3 rrMd = vec3(abs(position.x) - uMark.x, position.y - uMark.y, position.z - uMark.z);
  float rrMarkD = length(rrMd * vec3(uMark.w, 2.4, 1.0));
  float rrMark = aBuild.w * (1.0 - smoothstep(aMark.w * 0.45, max(aMark.w, 1e-5), rrMarkD));
  vFaunaTint = mix(aTint, aMark.rgb, clamp(rrMark, 0.0, 1.0));
${
  twoSided
    ? /* glsl */ `
  /**
   * THE UNDERSIDE, AND HOW MUCH OF A MIRROR THIS ONE IS — resolved here, for
   * free, out of numbers the vertex shader has already computed.
   *
   * rgb is the colour of the BOTTOM of the wing, darkened where the top has its
   * mark: a morpho's underside is not a flat brown, it carries the eyespots,
   * and reusing rrMark puts a dark blotch out on the wing exactly where the
   * upper surface has its border. One attribute, two markings.
   *
   * w is the mirror, masked to the WINGS. The body of a morpho is a furry brown
   * stick and iridescing it would turn the animal into a lozenge of light; the
   * mask is the same smoothstep over |aWing.x| the species scale already uses,
   * so it costs nothing and it lands the flash on the plates where it belongs.
   * It also carries the underside blend, which is why the thorax stays thorax
   * coloured from below instead of flipping to leaf-brown.
   */
  float rrUnderMask = smoothstep(0.05, 0.24, rrSpan);
  vec3 rrUnderC = aUnder.rgb * mix(1.0, 0.42, clamp(rrMark, 0.0, 1.0));
  vRrUnder = vec4(mix(vFaunaTint, rrUnderC, rrUnderMask), aUnder.w * rrUnderMask);
`
    : ''
}

  // The flap is in metres at the tip, so it has to shrink with the wing. A
  // manakin swinging a wingtip through a toucan's arc is a moth.
  transformed.y += rrBeat * aBeat.y * rrSpan * aBuild.x;
  transformed.x *= 1.0 - 0.30 * abs(rrBeat) * rrSpan * aBeat.y;
  transformed.z -= rrBeat * 0.06 * rrSpan;
  if (aFlight.x > 0.0) {
    transformed *= aBeat.w;
    transformed = rrOrigin + rrRight * transformed.x + rrUp * transformed.y + rrFwd * transformed.z;
  } else {
    /**
     * A SITTING BIRD HAS ITS WINGS SHUT.
     *
     * On the orbit branch aFlight.y is the angular speed; on this one there is
     * no orbit, so the same slot carries the wing SPREAD — 0 folded, 1 open.
     * Folding is two operations: pull the span in toward the body and sweep
     * what is left backward along it, which is what a folded wing is. Without
     * it a perched bird sits on its branch with both wings held straight out,
     * and at three metres that is not a bird, it is a weather vane.
     */
    float rrOpen = aFlight.y;
    transformed.x *= mix(0.13, 1.0, rrOpen);
    transformed.z -= (1.0 - rrOpen) * rrSpan * 0.26;
    transformed.y += (1.0 - rrOpen) * rrSpan * 0.03;
    transformed *= aBeat.w;
  }

  vec4 rrW4 = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    rrW4 = instanceMatrix * rrW4;
  #endif
  vFaunaWorld = (modelMatrix * rrW4).xyz;
${FIELD_VERTEX}
`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
${TRIP_DECL}
${HUE_ROTATE}
varying vec3 vRrField;
varying vec3 vFaunaWorld;
varying vec3 vFaunaTint;
varying float vFaunaAlert;
${twoSided ? 'varying vec4 vRrUnder;' : ''}
`
      )
      .replace(
        '#include <dithering_fragment>',
        /* glsl */ `#include <dithering_fragment>
${
  twoSided
    ? /* glsl */ `
  /**
   * THE BLINK. Which side of the wing is this, and is it catching the light?
   *
   * Two lines and they are the whole feature. gl_FrontFacing is true on the top
   * of the wing — see the winding note in shapes.js, which had to be fixed
   * before this meant anything — so a morpho on the downstroke is blue and on
   * the upstroke is a dead leaf, which is what one actually looks like.
   */
  vec3 rrTint = gl_FrontFacing ? vFaunaTint : vRrUnder.rgb;
  vec3 rrC = gl_FragColor.rgb * rrTint;

  /**
   * THE STRUCTURAL BLUE, AND IT IS ADDED, NOT MULTIPLIED.
   *
   * This is the line the fireflies got wrong. A morpho's blue is a mirror, not
   * a pigment: it is brighter than anything reflective can be, which is why a
   * photograph of one always looks retouched. Folding it into the tint — a
   * multiplier on the Lambert term — would have made it a function of how
   * square the wing happens to be to the sun, and a wing edge-on to the sun has
   * a diffuse term near zero, so the flash would vanish at exactly the moment
   * the real insect is at its most violent. The fireflies lost 93% of their
   * brightness to that same mistake in a different file.
   *
   * So it is an additive term with its own angular law. rrFace is how square
   * the wing is TO THE CAMERA, which is the correct variable: a mirror shows
   * you its colour when it is pointing at you and shows you an edge otherwise.
   * Raised to a power so it is a flash and not a wash — most of the beat it is
   * near nothing and for a few frames it is everything.
   *
   * The light term is deliberately floored. rrLit is the untinted Lambert
   * result, i.e. what the wood is giving this surface, and a morpho in deep
   * shade genuinely IS duller than one in a light shaft — that link is worth
   * keeping, it is what makes the insect belong to the wood rather than sit in
   * front of it. Floored at 0.5 and capped at 1.1 so the total swing is 2.2x
   * and the flash can never be extinguished by shade the way the fireflies
   * were. The pipeline's quarter-res glow buffer does the rest: anything this
   * bright that MOVES drags a comet tail, which is precisely how a morpho
   * registers in peripheral vision.
   */
  if (vRrUnder.w > 0.001) {
    float rrFace = abs(dot(normalize(vNormal), normalize(vViewPosition)));
    float rrLit = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    float rrHit = vRrUnder.w * (gl_FrontFacing ? 1.0 : 0.08) * pow(rrFace, 2.6);
    rrC += rrTint * rrHit * (0.5 + 0.4 * min(rrLit, 1.5));
  }
`
    : /* glsl */ `
  vec3 rrC = gl_FragColor.rgb * vFaunaTint;`
}
  if (uLevel > 0.0005) {
    float rrLum = dot(rrC, vec3(0.2126, 0.7152, 0.0722));
    rrC = rrHueRotate(rrC, (vRrField.x * 1.35 + vRrField.y * 0.62) * uLevel * 0.45);
    rrC = mix(vec3(rrLum), rrC, 1.0 + uSat * 0.6);
    /**
     * A bird against the sky is a silhouette, so the rim is the ONLY term that
     * can do anything to it — a hue rotation on something already near black is
     * arithmetic with no picture in it. This puts the light on the trailing edge
     * of the wing, which is exactly where a real backlit bird carries it.
     */
    vec3 rrGlowCol = rrHueRotate(vec3(1.0, 0.46, 0.22), vRrField.y * 1.6 + vRrField.x * 0.85);
    rrC += rrGlowCol * uRim * 0.5 * (1.0 + uSurge);
    /**
     * A MOVING THING CATCHES YOUR EYE, BECAUSE YOU STOP HABITUATING TO IT.
     *
     * The best-attested auditory finding transfers directly: psilocybin
     * prevents habituation to a repeated stimulus, so what would normally fade
     * into the background keeps its salience. Visually that is not a new
     * effect, it is a failure to stop noticing — and in a wood made of green
     * and brown the things that never stop being noticed are the ones that
     * move. A butterfly working a clearing is the clearest case there is.
     *
     * Implemented as brightness rather than as an outline or a tint, and that
     * choice is doing more work than it looks. The pipeline accumulates a
     * quarter-resolution glow buffer, so anything bright that MOVES already
     * drags a soft comet tail behind it — see the wake in render/pipeline.js.
     * Lifting a flyer past the brightness of the wood therefore gives it a
     * trail for free, and a trail is precisely how the eye is caught: the
     * movement becomes legible as movement rather than as a small shape that
     * happens to be somewhere else now. Nothing static in the frame gains
     * anything, because nothing static leaves a wake.
     *
     * On the flyers only. They are the layer that is moving by definition —
     * a hundred and fifty instances against a hundred thousand trunks and
     * cards — so this cannot wash the wood out however far it goes.
     */
    rrC *= 1.0 + uLevel * 0.55 * (1.0 + 0.7 * uSurge);
  }
  gl_FragColor.rgb = rrC;
`
      );
  };

  material.customProgramCacheKey = () => `rr-fauna-flyer-${spec.name}`;
  return material;
}

/**
 * Midges and fireflies, in one Points cloud.
 *
 * They are the same object — a small bright speck at a coordinate — differing
 * only in where they hang, how they move and what turns them on, so they share a
 * geometry, a material and a draw call and are told apart by one attribute.
 *
 * ALL OF IT IS IN THE VERTEX SHADER. A midge column is periodic motion about a
 * fixed point: sums of sines at incommensurate rates never repeat and never need
 * a CPU. Fourteen hundred insects therefore cost one draw call and zero
 * per-frame work of any kind, which is the only budget at which insects are
 * worth having at all.
 */
export function swarmMaterial(sprite) {
  return new THREE.ShaderMaterial({
    name: 'fauna-swarm',
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      ...tripSlice(),
      uMap: { value: sprite },
      uPixelRatio: { value: 1 },
      /** x: how much daylight there is (midges), y: how dark it is (fireflies). */
      uDusk: { value: new THREE.Vector2(1, 0) },
    },
    vertexShader: /* glsl */ `
      ${NOISE3}
      uniform float uTime;
      uniform float uLevel;
      uniform vec3 uEye;
      uniform vec2 uDusk;
      uniform float uPixelRatio;
      attribute float aSeed;
      attribute float aKind;
      attribute vec3 aSwarm;
      varying float vFade;
      varying float vSeed;
      varying float vKind;

      void main() {
        vSeed = aSeed;
        vKind = aKind;
        float ph = aSeed * 6.2831;
        vec3 p = position;

        /**
         * A MIDGE COLUMN IS NOT A CLOUD OF RANDOM WALKS.
         *
         * What makes a column of gnats unmistakable is that each insect holds
         * station in a small volume and jinks inside it — sharp direction
         * changes at three or four a second, over a slow orbit that keeps it in
         * the beam. Two rates: a lazy one that draws the shape of the swarm, and
         * a fast one at an irrational multiple of it that does the jinking.
         * aSwarm is the column's own half-extents, so a shaft near the ground
         * gets a squat swarm and a tall one gets a pillar.
         */
        float slow = uTime * (0.55 + aSeed * 0.5) + ph;
        float fast = uTime * (5.3 + aSeed * 3.1) + ph * 3.7;
        vec3 jink = vec3(
          sin(slow) * 0.7 + sin(fast) * 0.3,
          sin(slow * 1.31 + 1.1) * 0.6 + sin(fast * 0.83 + 2.0) * 0.4,
          cos(slow * 0.87 + 2.3) * 0.7 + cos(fast * 1.17) * 0.3
        );
        p += jink * aSwarm * mix(1.0, 2.2, aKind);

        /**
         * A firefly rises and sinks on a much longer clock and drifts sideways
         * on the noise field the motes use, because it is flying rather than
         * hovering. Same three lines, ten times slower, and it reads as a
         * completely different animal.
         */
        if (aKind > 0.5) {
          float t = uTime * (0.05 + aSeed * 0.04);
          p.x += rrNoise(vec3(p.xz * 0.06, t)) * 3.4;
          p.z += rrNoise(vec3(p.zx * 0.06, t + 7.3)) * 3.4;
          p.y += sin(t * 3.7 + ph) * 0.8;
        }

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dist = -mv.z;
        // Midges only exist where you can see them lit from behind, which in
        // practice is close; fireflies are their own light and carry much
        // further. Both fade in near the eye so nothing pops at the near plane.
        float reach = mix(30.0, 66.0, aKind);
        vFade = smoothstep(reach, reach * 0.45, dist) * smoothstep(0.7, 3.0, dist)
              * mix(uDusk.x, uDusk.y, aKind);
        gl_Position = projectionMatrix * mv;
        /**
         * Bigger than they look right on paper. A midge column at fifteen
         * metres was drawing four-pixel specks at half alpha over a sunlit
         * hillside and was, measurably, in frame and invisible — the swarm has
         * to be brighter than the thing behind it or it is not there. Real
         * gnats in a beam are backlit and they GLOW; that is the whole reason
         * anyone notices them.
         */
        /**
         * A POINT THAT WILL BE DISCARDED IS COLLAPSED HERE, NOT RASTERISED AND
         * THEN THROWN AWAY.
         *
         * The fragment shader opens by discarding when vFade is below 0.004 —
         * but by the time it runs, the point has already been expanded into a
         * quad of up to 16x16 device pixels and every one of those fragments
         * has been scheduled. vFade is settled right here in the vertex shader,
         * so the cheap version of that same test is a point size of zero, which
         * the rasteriser drops outright.
         *
         * It is exactly the fragments the discard was going to reject, so the
         * picture is unchanged — but every midge past 30 m and every firefly
         * past 66 m stops costing anything at all, and the whole cloud goes
         * free in daylight, when uDusk holds vFade at zero for all 1340.
         */
        gl_PointSize = vFade < 0.004 ? 0.0
                     : min(16.0, mix(2.8, 4.6, aKind) * (1.0 + uLevel * 0.7)
                       * uPixelRatio * 30.0 / max(dist, 1.0));
      }
    `,
    fragmentShader: /* glsl */ `
      ${HUE_ROTATE}
      uniform sampler2D uMap;
      uniform float uTime;
      uniform float uLevel;
      uniform vec4 uAudio;
      varying float vFade;
      varying float vSeed;
      varying float vKind;

      void main() {
        if (vFade < 0.004) discard;
        vec4 tex = texture2D(uMap, gl_PointCoord);
        /**
         * A firefly is not on. It pulses — a slow rise and a fast fall, about
         * once every two seconds, each insect on its own phase. A field of them
         * blinking together would be a string of fairy lights; a field of them
         * blinking independently is unmistakably alive. The eighth power is what
         * makes it a flash rather than a throb.
         */
        float blink = 1.0;
        vec3 col = vec3(1.0, 0.93, 0.74);
        if (vKind > 0.5) {
          float b = sin(uTime * (0.9 + vSeed * 0.7) + vSeed * 31.0) * 0.5 + 0.5;
          /**
           * Fifth power with a floor, not an eighth with none. At the eighth
           * an insect is lit for about a tenth of its cycle, so a field of
           * four hundred showed maybe three at a time and the effect did not
           * exist. The floor matters as much: a real firefly between flashes
           * is a dim moving speck, not nothing, and being able to half-see
           * where the next flash will come from is most of the pleasure.
           */
          blink = 0.06 + 0.94 * pow(b, 5.0);
          col = vec3(0.75, 1.0, 0.42);
        }
        if (uLevel > 0.0005) {
          // Per-insect rather than per-frame: the swarm goes from one colour to
          // dozens, and each speck holds the colour it was given. A hue that
          // cycles on the clock is the sheen this project keeps having to remove.
          col = mix(col, rrHueRotate(col, vSeed * 6.28), uLevel * 0.8);
        }
        /**
         * A MIDGE GETS THE SPRITE PROFILE SQUARED, AND THAT IS AN ADDITIVE-
         * BLENDING DEFENCE RATHER THAN A LOOK CHANGE.
         *
         * These points are additive and they are deliberately arranged in tight
         * columns, which means a column is by construction the place where the
         * most sprites overlap. Additive blending against itself always drives
         * toward white, so a per-point alpha that is perfectly reasonable for
         * ONE insect sums to a solid white disc in the middle of a cluster.
         * That happened: an unrelated change to how the columns were addressed
         * doubled their density and the swarm rendered as hard blobs of
         * confetti hanging in the clearing.
         *
         * Squaring leaves the core alone (tex.a is ~1 at the centre) and pulls
         * the skirt down steeply, so a midge stays as bright as it was and
         * stops contributing nearly as much where it overlaps its neighbours.
         * The fireflies keep the linear profile: they blink on independent
         * phases, so a field of them is almost never lit together, and their
         * whole appeal is the soft halo the skirt makes.
         */
        float profile = mix(tex.a * tex.a, tex.a, vKind);
        float a = profile * vFade * blink * mix(0.85, 1.0, vKind) * (1.0 + uAudio.w * 0.4);
        if (a < 0.003) discard;
        /**
         * And the specks get brighter as well as bigger, for the reason the
         * flyers do — see the note in flyerMaterial. gl_PointSize has scaled
         * with uLevel since this was written, which makes a midge easier to
         * RESOLVE; this makes it harder to ignore, which is the different and
         * more useful thing. Additive blending, so brightness is the only
         * lever there is here anyway.
         */
        col *= 1.0 + uLevel * 0.6;
        gl_FragColor = vec4(col * a, a);
      }
    `,
  });
}
