import * as THREE from 'three';
import { clamp, clamp01, damp, lerp } from '../core/util.js';
import { playerHue } from '../core/identity.js';
import { groundUnder, normalAt } from '../world/terrain.js';
import { dayPhase, daylightAt, sunVector } from '../world/daylight.js';
import { makeLiving } from '../trip/living.js';

/**
 * YOUR OWN BODY.
 *
 * `avatar.js` has drawn everybody else since the room existed and `new Avatar`
 * has exactly one call site, which is the peer list. So the pitch clamp let you
 * look straight down at the ground where your legs should be and there was
 * nothing there — in a game whose entire subject is being somewhere with other
 * people, you were the only one in the wood who was not present in it.
 *
 * This is that, and deliberately nothing more: two legs, two arms and a cut-off
 * torso, standing at `controller.position`, plus one painted shadow on the
 * ground beneath them.
 *
 *
 * WHAT MAKES IT FREE, AND IT IS THE VISIBILITY GATE RATHER THAN THE GEOMETRY.
 *
 * Five capsules is 1.4k triangles, which against a frame that draws thirteen
 * million is not a number worth discussing — but five MESHES is five draw calls,
 * and on the weak machines that are this project's binding constraint fourteen
 * draw calls is the whole margin (see `perf:weak`). So the rig is not submitted
 * at all unless the pitch is steep enough that some part of it could physically
 * be inside the frustum, and `_gatePitch` computes that from `camera.fov` and
 * the body's own topmost point rather than from a magic number. Every
 * performance station in this project looks level or nearly so, so the perf
 * baseline cannot move: at pitch −0.05 this costs one `Math.atan2` and one
 * boolean write.
 *
 * The SHADOW is the honest exception and is called out here rather than buried:
 * it is on almost every frame you are outdoors in daylight, so it is a permanent
 * +1 draw call and +2 triangles at every station. It was accepted because a body
 * with no shadow does not stand on the ground, it hovers over a picture of it.
 *
 *
 * ONE MATERIAL, AND THAT IS THE OTHER HALF OF FREE.
 *
 * Every part shares a single `makeLiving(MeshLambertMaterial, 'prop')` — the
 * same call `fishing.js` makes for the rod and `avatar.js` makes for a peer's
 * limbs. `makeLiving` returns the same `customProgramCacheKey` for every prop,
 * which is exactly what that key is for, so this adds no program to the count
 * and no compile to the warm-up. It also means your hands take the trip's
 * regional colour field and surface warp like everything else you can see, which
 * is the point `avatar.js` makes at length about other people being subject to
 * the same weather as the wood.
 *
 *
 * ANCHORED TO THE BODY, NEVER TO THE CAMERA.
 *
 * Exactly the argument `fishing.js` writes out where it positions the rod: the
 * trip dollies the camera up to 1.35 m away from the body and swings it around
 * as you turn, so anything pinned to the camera slides away from its owner and
 * the tell is that it stops being attached to anything. Pinned to
 * `controller.position` and `controller.yaw`, your legs stay where your legs are
 * and the camera drifts around them — which is what is actually happening to
 * you. Your own legs will therefore appear to drift during a trip. That is
 * on-brief and it is the same trade the rod already accepts in writing.
 *
 *
 * WHAT IS NOT HERE, AND WHY.
 *
 * NO HANDS HELD FORWARD. The arms hang at the sides and the only thing that ever
 * raises them is a gesture with an end. A pair of forearms parked at the bottom
 * of the screen is a stable, man-made, screen-locked shape — it is the viewmodel
 * every other first-person game has, and it is precisely the persistent chrome
 * this project's whole render argument is built to refuse (see the header of
 * `ui/hud.js`). The one thing a trip must not be given is a reference frame that
 * does not move with the world, and a viewmodel is the largest one available.
 *
 * NO HEAD AND NO NECK. You cannot see your own head, the near plane is at 0.1 m,
 * and a sphere 0.2 m under the camera is a dome that fills the frame the moment
 * you look down. The torso is cut at 1.30 m for the same reason — see TOP_H.
 *
 * NO REAL SHADOW. See `_shadowTexture`.
 */

/** Where the parts sit, in metres above the feet. Shared with avatar.js by hand. */
const HIP_Y = 0.86;
const SHOULDER_Y = 1.4;
/**
 * Eye height, which has to match EYE in controller.js.
 *
 * Not imported, because `controller.js` does not export it and adding an export
 * for one constant would be a wider change to the busiest file in the project
 * than this deserves. If it ever moves, the body sinks into the ground or floats,
 * which is not a subtle failure.
 */
const EYE = 1.68;

/**
 * THE TOPMOST, FRONTMOST POINT OF THE BODY, RELATIVE TO THE EYE. The gate is
 * derived from these two numbers and from `camera.fov`, and from nothing else.
 *
 * TOP_H is how far below the eye the highest thing you could see is, and TOP_R
 * how far in front of the eye's own vertical axis it reaches. The torso capsule
 * is radius 0.185 with its cap top at 1.30 m, so 1.68 − 1.30 = 0.38 and 0.185.
 *
 * The shoulders are not the binding point even though they are higher, and that
 * is worth writing down because it is counter-intuitive: the frustum's bottom
 * plane is a PLANE, so a point's admission depends only on its offset along the
 * camera's own down axis and its distance ahead — a shoulder 0.23 m out to the
 * SIDE and 0.28 m down is 0.28 m down and 0 m ahead, and enters much later than
 * a chest 0.38 m down and 0.185 m ahead. The horizontal field is wider than the
 * vertical one, so sideways offset never binds first.
 */
const TOP_H = 0.38;
const TOP_R = 0.185;
/**
 * How much earlier than strictly necessary the rig is switched on, in radians.
 *
 * 0.07 rad is about 4°, which at the walk's 5.5 cm bob and the trip's field of
 * view sweep is comfortably more than either can move the boundary between two
 * frames. Turning on early costs five draw calls for a few frames; turning on
 * late is a body that pops into existence, and only one of those is visible.
 */
const GATE_MARGIN = 0.07;

/**
 * The gesture, in seconds. See `lookAtHands`.
 *
 * 0.45 up, a beat, 0.45 down — the timing is in the easing rather than here, and
 * this is only how long the pose is HELD before it starts coming back. Two
 * seconds is long enough to actually look at your hands and short enough that it
 * cannot be mistaken for a state you are stuck in.
 */
const HANDS_HOLD = 2;

/**
 * The shadow, in five numbers.
 *
 * SHADOW_H is the height of the caster: 1.75 m, a person, not the eye. It is
 * what turns the sun's elevation into a length — length = h / tan(elevation).
 *
 * SHADOW_MAX is where that stops being a shadow. At 15° of elevation a person is
 * already 6.5 m long, and the last hour before sunset would otherwise draw a
 * fifty-metre smear across the wood. Clamped rather than faded to nothing at the
 * clamp, because a long low shadow IS the look of that hour and the thing that
 * has to go is the arithmetic, not the effect.
 *
 * SHADOW_ALPHA is the darkness directly under you at noon. 0.3 against the
 * avatar's contact disc at 0.26 — a shade darker, because this one is a shape
 * with edges and the disc is a blur, so the same opacity reads lighter.
 *
 * SHADOW_AIR is how far you have to be off the ground for the shadow to fade
 * out. 4 m of air is well past the top of a jump (JUMP is 7.1 m/s, which is 1.15
 * m), so in practice it only fires when you walk off a bank — and there the
 * shadow genuinely should be nowhere near your feet.
 *
 * SHADOW_MOVE is how far the body has to travel before the ground normal under
 * it is resampled. `normalAt` is a five-tap height query, and the slope under a
 * standing person does not change; 0.25 m is a third of a stride, which at RUN
 * is a resample about every three frames and at a stand is none at all.
 */
const SHADOW_H = 1.75;
const SHADOW_MAX = 6.5;
const SHADOW_ALPHA = 0.3;
const SHADOW_AIR = 4;
const SHADOW_MOVE = 0.25;

let sharedGeometry = null;
let sharedShadowTexture = null;

/**
 * Scratch for the ground normal. Hoisted for the same reason controller.js
 * hoists its three: `normalAt` allocates a `THREE.Vector3` when it is not given
 * an output, and this is called from the frame loop.
 */
const _slopeNormal = new THREE.Vector3();

/**
 * The parts.
 *
 * The arm and leg capsules are copied from `avatar.js`'s `geometry()` to the
 * millimetre, deliberately: the thing you are looking down at and the thing
 * somebody else sees you as have to be the same body, and two files that
 * independently decided how long a leg is would drift the first time either one
 * was tuned. They are not IMPORTED because `avatar.js` keeps its table private
 * and exporting it would make a module about other people a dependency of a
 * module about you — the wrong direction, and the same argument avatar.js makes
 * for building its own rod rather than importing fishing's.
 *
 * THE TORSO IS THE ONE PART THAT IS NOT A COPY. The avatar's is a 0.36 capsule
 * centred at 1.12, whose cap tops out at 1.485 — 0.195 m under your own eye,
 * which from the inside is a wall. This one is shorter and lower so that its top
 * is 0.38 m down; see TOP_H, which is derived from it and is the whole gate.
 */
function geometry() {
  if (sharedGeometry) return sharedGeometry;
  sharedGeometry = {
    /**
     * SEGMENT COUNTS RAISED AFTER LOOKING AT IT, and the reason is the one
     * angle this mesh is drawn at.
     *
     * 8 radial and 4 cap segments is the right budget for an avatar seen from
     * four metres away, which is what these numbers were copied from. This mesh
     * is only ever submitted when you are looking DOWN at it from thirty
     * centimetres, and the first thing in frame is the cap of the torso capsule
     * seen end-on — where 8 segments is a visible octagon and 4 cap rings make
     * it a faceted cone. Photographed at a steep look-down it read as three
     * flat blue polygons rather than as a person.
     *
     * 16/6 and 10/4 is about 900 more triangles on a mesh that is not submitted
     * on any normal frame and never appears at any performance station (every
     * one of them looks level, and the visibility gate is 31 degrees below it).
     * Against a frame that draws eight million, this is free in the only sense
     * that matters: it cannot appear in a measurement.
     */
    torso: new THREE.CapsuleGeometry(0.185, 0.3, 6, 16),
    arm: new THREE.CapsuleGeometry(0.062, 0.4, 4, 10),
    leg: new THREE.CapsuleGeometry(0.092, 0.56, 4, 10),
    shadow: new THREE.PlaneGeometry(1, 1),
  };
  return sharedGeometry;
}

/**
 * A person-shaped smudge, drawn once at load like every other texture here.
 *
 * IT IS A DECAL AND NOT A REAL SHADOW, AND THAT IS NOT A SHORTCUT. The renderer
 * has `shadowMap.autoUpdate` off — the map is only re-rendered when the sun's
 * quantised anchor moves, with 6 m of hysteresis on the anchor — so a caster
 * that walks would leave its shadow standing on the ground behind it and then
 * jump six metres sideways when the anchor next moved. Forcing an update every
 * frame instead costs 3.2–4.5 ms against a frame that is 2.9, which is the most
 * expensive thing it is possible to do in this app. `avatar.js` paints a contact
 * disc under every peer for exactly this reason and says so; this is the same
 * decision with a shape on it.
 *
 * BUILT FROM SOFT ELLIPSES RATHER THAN A BLURRED SILHOUETTE. `ctx.filter =
 * 'blur()'` is the obvious way to soften a drawn shape and it is not reliably
 * available in every context this project is rendered in — the automation runs
 * headless under swiftshader and a filter that silently no-ops would give every
 * pixel-diffing script a hard-edged cut-out instead of a shadow, which is the
 * kind of difference that gets blamed on the lighting for a day. A radial
 * gradient is soft by construction and cannot degrade.
 */
function shadowTexture() {
  if (sharedShadowTexture) return sharedShadowTexture;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, size);

  /**
   * One soft lump, in canvas pixels, rotated about its own centre.
   *
   * The gradient runs from `alpha` at the middle to nothing at the rim with a
   * hard-ish shoulder at 0.55, so the lumps overlap into a body rather than
   * summing into a bright core — a linear falloff made the torso a glowing
   * lozenge everywhere the arms crossed it.
   */
  const lump = (cx, cy, rx, ry, angle, alpha) => {
    g.save();
    g.translate(cx, cy);
    g.rotate(angle);
    g.scale(rx, ry);
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    grad.addColorStop(0, `rgba(0,0,0,${alpha})`);
    grad.addColorStop(0.55, `rgba(0,0,0,${alpha * 0.86})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(0, 0, 1, 0, Math.PI * 2);
    g.fill();
    g.restore();
  };

  /**
   * A person seen from the sun, head at the TOP of the canvas — v = 0 in texture
   * space, which after the plane's −90° tilt is the world direction the shadow
   * is thrown in. `update` rotates the quad so that direction points away from
   * the sun, which is the whole of the orientation logic.
   *
   * The proportions are a walking figure rather than a standing one — legs
   * slightly apart, one arm a little out — because a perfectly symmetrical
   * silhouette reads as a mannequin, and because the thing this is mostly seen
   * doing is walking.
   */
  const cx = size * 0.5;
  lump(cx, size * 0.13, size * 0.075, size * 0.075, 0, 0.85); // head
  lump(cx, size * 0.31, size * 0.13, size * 0.17, 0, 0.95); // torso
  lump(cx - size * 0.135, size * 0.3, size * 0.05, size * 0.13, -0.16, 0.75); // left arm
  lump(cx + size * 0.145, size * 0.31, size * 0.05, size * 0.14, 0.22, 0.75); // right arm
  lump(cx - size * 0.06, size * 0.6, size * 0.062, size * 0.21, -0.06, 0.9); // left leg
  lump(cx + size * 0.07, size * 0.6, size * 0.062, size * 0.21, 0.08, 0.9); // right leg

  const tex = new THREE.CanvasTexture(c);
  // No colour space: every texel is black and the only channel that carries
  // anything is alpha, which is linear in every space there is.
  tex.needsUpdate = true;
  sharedShadowTexture = tex;
  return tex;
}

/**
 * ==== THE LIMBS ARE OFF, AND THIS IS THE TOMBSTONE ==========================
 *
 * Everything below still exists and still works. The five capsules are simply
 * not submitted, because they were photographed and they do not read as a body.
 *
 * WHAT IT ACTUALLY LOOKS LIKE. The gate opens at 31 degrees below level, and
 * at that angle the rig is a sliver at the very bottom edge of the frame. Look
 * further down and the first thing that fills the picture is the CAP OF THE
 * TORSO CAPSULE SEEN END-ON, with a shoulder either side of it: three coloured
 * domes along the bottom of the screen. Raising the segment counts from 8 to
 * 16 removed the faceting and changed nothing about the read. Hiding the torso
 * and leaving arms and legs was worse — two shoulder caps and no middle.
 * Sitting, which should be the best case (a first-person body's money shot is
 * your own legs stretched out on a log), is three ovoids lying on the ground.
 *
 * WHY, AND IT IS NOT THE MODEL. The eye is 1.68 m up and the torso's top is
 * 1.335, so the camera sits 34 cm DIRECTLY ABOVE the chest and looks down onto
 * it. A real first-person body works because the eye is set forward in a head
 * that is on top of and BEHIND the chest, so looking down you see the chest
 * sloping AWAY from you, then thighs, then feet — a sequence of shapes at
 * different distances. From straight above, a capsule is a circle, and three
 * circles is what this is. Fixing it means a rig built for the first-person
 * view rather than the avatar's parts reused: the eye offset forward, the
 * torso tapered and pushed back, the thighs brought up into frame. That is
 * real modelling work and it is worth doing; it is not a tuning pass.
 *
 * WHAT STAYS ON, AND IT IS THE HALF THAT WORKED: the shadow. A person-shaped
 * decal stretched along the sun's bearing reads correctly from every angle,
 * costs one draw call and two triangles, and is on almost every outdoor frame.
 * It is the presence cue this file actually delivered.
 *
 * Flip SHOW_RIG to true to see the state described above. Nothing else has to
 * change; the pose code, the gate, the walk cycle locked to the footstep
 * counter and the hands gesture are all still here and still correct.
 */
const SHOW_RIG = false;
export class PlayerBody {
  /**
   * @param {object} deps
   * @param {THREE.Scene} deps.scene
   * @param {import('./controller.js').Controller} deps.controller
   * @param {THREE.PerspectiveCamera} deps.camera the live camera, read for its
   *   field of view only — never for its transform. See the header.
   */
  constructor({ scene, controller, camera }) {
    this.controller = controller;
    this.camera = camera;

    this.group = new THREE.Group();
    this.group.name = 'player-body';
    scene.add(this.group);

    /**
     * The rig and the shadow are siblings rather than parent and child, for two
     * reasons and the second one is a bug that was written and then found.
     *
     * They are switched on by different questions: the shadow is about the sun
     * and the rig is about where you are looking. A shadow parented to a hidden
     * rig would vanish the instant you looked up, which is the one thing about
     * your own shadow you would notice.
     *
     * AND THE YAW LIVES ON THE RIG, NOT ON THE OUTER GROUP. The shadow is
     * oriented on the SUN's bearing, which is a world direction; if it were a
     * child of anything carrying `controller.yaw` its rotation would be composed
     * with yours and your shadow would swing round you as you turned on the
     * spot. So the outer group carries position only, the rig carries the yaw,
     * and the shadow carries its own.
     */
    this.rig = new THREE.Group();
    this.rig.visible = false;
    this.group.add(this.rig);

    this.material = makeLiving(new THREE.MeshLambertMaterial(), 'prop');
    /**
     * YOUR OWN COLOUR, straight out of `identity.js` rather than off the wire.
     *
     * `playerHue()` is the same number the main menu writes and the same one
     * `net.identify` sends, so your hands are the colour everybody else sees you
     * wearing — and they are that colour when you are alone in the wood with no
     * socket open at all, which is the case a hue taken from the net layer could
     * not answer.
     *
     * The recipe is `avatar.js`'s LIMB colour, to the decimal, and the sRGB
     * argument is load-bearing for the reason spelled out at `_dye` over there:
     * `setHSL` defaults to the linear working space, and 0.25 written there
     * displays at about 0.54. It is the limb colour and not the body colour
     * because four fifths of what you can see of yourself is arms and legs.
     */
    this._hue = playerHue();
    this.material.color.setHSL(this._hue, 0.42, 0.25, THREE.SRGBColorSpace);

    const g = geometry();

    this.torso = new THREE.Mesh(g.torso, this.material);
    this.torso.position.y = 1.0;
    this.torso.castShadow = false;
    this.rig.add(this.torso);

    /**
     * Arms and legs, `[left, right]` — side −1 is left, because the body faces
     * −Z and +X is therefore its right hand. `fishing.js` puts the rod at +0.3,
     * which is the same hand, and that is what `rodOut` hides.
     */
    this.arms = [];
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.23, SHOULDER_Y, 0);
      const limb = new THREE.Mesh(g.arm, this.material);
      limb.position.y = -0.26;
      limb.castShadow = false;
      pivot.add(limb);
      this.rig.add(pivot);
      this.arms.push({ pivot, limb, side });
    }
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.1, HIP_Y, 0);
      const limb = new THREE.Mesh(g.leg, this.material);
      limb.position.y = -0.37;
      limb.castShadow = false;
      pivot.add(limb);
      this.rig.add(pivot);
      this.legs.push({ pivot, limb, side });
    }

    /**
     * The shadow quad.
     *
     * `depthWrite` off and `renderOrder` −1, exactly like the avatar's contact
     * disc: it lies on the ground and must not occlude the grass standing in it.
     * A plain `MeshBasicMaterial` and not `makeLiving` — a shadow is an absence
     * of light rather than a surface, and melting it during a trip would make
     * the one thing on screen that says where the ground is stop saying it.
     */
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: shadowTexture(),
      transparent: true,
      opacity: SHADOW_ALPHA,
      depthWrite: false,
    });
    this.shadow = new THREE.Mesh(g.shadow, this.shadowMaterial);
    this.shadow.rotation.order = 'YXZ';
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = -1;
    this.shadow.castShadow = false;
    this.shadow.receiveShadow = false;
    this.shadow.frustumCulled = false;
    this.group.add(this.shadow);

    /** Eased pose values, all 0..1. See `update`. */
    this._sit = 0;
    this._rod = 0;
    this._hands = 0;
    this._handsFor = 0;
    this._wasVisible = false;
    /** Where the ground normal was last sampled. See SHADOW_MOVE. */
    this._normalAt = new THREE.Vector2(1e9, 1e9);
    this._slope = 1;
    this._sun = { x: 0, y: 1, z: 0 };
  }

  /**
   * LOOK AT YOUR HANDS.
   *
   * Fired by `main.js` when `E` is pressed and `findInteractable()` found
   * nothing — so it reuses a key that was doing nothing at that moment rather
   * than claiming a new one. That is not a saving, it is the point: `keys.js`,
   * the README control tables and `check:keys` all stay exactly as they were,
   * and there is no fourteenth letter for a player to learn. E already means
   * "do the thing in front of me", and when there is nothing in front of you the
   * thing in front of you is your hands.
   */
  lookAtHands() {
    this._handsFor = HANDS_HOLD;
  }

  /**
   * The pitch below which some part of the body could be in frame, in radians.
   *
   * Camera at the eye, pitch p (negative is down), looking along f = (0, sin p,
   * −cos p) with up u = (0, cos p, sin p). A point P is inside the bottom of the
   * frustum when P·u / P·f > −tan(halfFov). Putting P = (0, −TOP_H, −TOP_R) and
   * solving for equality gives
   *
   *     tan p = (T·TOP_R − TOP_H) / (T·TOP_H + TOP_R),   T = tan(fov / 2)
   *
   * which at the shipping fov of 66° and this torso comes out to −0.542 rad;
   * less GATE_MARGIN the rig switches on at −0.612 rad, or 35° below level. At
   * the widest the trip takes the field of view — MAX_FOV_DRIFT is 8.5° and the
   * dissolve adds 4 more, so 78.5° — it is −0.503 rad, 29°. Both evaluated
   * rather than guessed.
   *
   * THAT IS NOT THE −0.85 YOU MIGHT EXPECT, and the difference is worth writing
   * down because the smaller number looks like a mistake. −0.85 rad is what you
   * get if the body's topmost point is essentially on the eye's own vertical
   * axis; a real chest is 0.185 m in front of it, and pushing the threshold down
   * to −0.85 with this formula would need a torso whose top was 1.27 m below the
   * eye — a body that stops at the hips. The choice is between a visible torso
   * and a steeper gate, and a torso that vanishes at 30° of look-down while your
   * legs are still there is far more noticeable than five draw calls.
   *
   * READ FROM `camera.fov` EVERY FRAME rather than captured. The trip widens the
   * field of view, and a wider field admits the body EARLIER — a captured
   * threshold would let a chest slide into frame during exactly the sequence in
   * which nothing is allowed to appear from nowhere.
   */
  _gatePitch() {
    const t = Math.tan((this.camera.fov * Math.PI) / 360);
    return Math.atan2(t * TOP_R - TOP_H, t * TOP_H + TOP_R) - GATE_MARGIN;
  }

  /**
   * @param {number} dt
   * @param {object} [state]
   * @param {number} [state.sit] 0..1, `sitting.blend`
   * @param {boolean} [state.rodOut] a rod is in the right hand
   */
  update(dt, { sit = 0, rodOut = false } = {}) {
    const c = this.controller;
    const feet = c.position.y - EYE;

    this.group.position.set(c.position.x, feet, c.position.z);
    this.rig.rotation.y = c.yaw;

    this._updateShadow(feet);

    /**
     * THE GATE, AND NOTHING BELOW IT RUNS WHEN IT IS SHUT.
     *
     * The early return is as important as the `visible = false`: five capsules
     * that are not drawn still cost their pose arithmetic, their matrix updates
     * and — because they are `Group`s with children — a subtree walk, every
     * frame, for a body nobody can see. Returning here means the whole of this
     * class's cost at a level pitch is the shadow above plus one `atan2`.
     */
    // Above the gate, deliberately: it is one subtraction, and a gesture whose
    // clock only runs while you happen to be looking at it is not a gesture,
    // it is a mode you can be stuck in.
    if (this._handsFor > 0) this._handsFor = Math.max(0, this._handsFor - dt);

    const show = SHOW_RIG && c.pitch < this._gatePitch();
    this.rig.visible = show;
    if (!show) {
      this._wasVisible = false;
      return;
    }
    /**
     * The first frame back in view, the eased pose values are snapped rather
     * than eased from wherever they were left.
     *
     * They stop being updated while the rig is hidden — that is the whole point
     * of the early return — so sitting down at a level pitch and then looking
     * down would otherwise play the entire sit animation from scratch, half a
     * second after you sat. Snapping is right because there was no visible
     * transition to preserve: nothing was on screen to move.
     */
    if (!this._wasVisible) {
      this._wasVisible = true;
      this._sit = sit;
      this._rod = rodOut ? 1 : 0;
    }

    /**
     * A change of coat, checked only while you can actually see yourself.
     *
     * Somebody can re-dye mid-session from the main menu, and `avatar.js` has a
     * `setLook` for exactly that. Rather than plumbing a second notification
     * into this file, the hue is compared against the source of truth — one
     * function call and a float compare — and written only when it moved. A
     * colour is a uniform, so re-dyeing costs no shader work at all; the
     * comparison exists to avoid three needless `setHSL` calls a frame, not to
     * avoid a recompile.
     */
    const hue = playerHue();
    if (hue !== this._hue) {
      this._hue = hue;
      this.material.color.setHSL(hue, 0.42, 0.25, THREE.SRGBColorSpace);
    }

    this._sit = damp(this._sit, sit, 0.02, dt);
    this._rod = damp(this._rod, rodOut ? 1 : 0, 0.05, dt);
    this._hands = damp(this._hands, this._handsFor > 0 ? 1 : 0, 0.004, dt);

    /**
     * ---- the walk ----------------------------------------------------------
     *
     * DRIVEN FROM `controller.stride`, WHICH IS THE ONE DETAIL IN THIS FILE THAT
     * MATTERS.
     *
     * `stride` is the footstep counter itself: the controller fires `onStep`
     * when it crosses a whole number, so cos(π·stride) is at an extreme on
     * exactly the frame the sound plays, and the extreme alternates sign each
     * time. The foot you can see plant is the foot you can hear plant, for ever,
     * because there is one number and not two.
     *
     * The alternative — measuring speed and integrating a phase of its own, the
     * way `avatar.js` has to for a remote body it can only observe — was tried
     * first and is subtly wrong here: the bob phase advances at 1.65 per metre
     * and the step rate at 0.52, a ratio of 3.173 against a bob period of π, so
     * the plant walks right round the sound over about a hundred strides. On a
     * body you cannot see (a peer, thirty metres off) nobody could tell. On your
     * own feet, half a metre from the camera, it is the difference between
     * walking and being animated.
     */
    const amplitude = clamp01(c.speed / 5) * 0.62;
    const swing = Math.cos(Math.PI * c.stride) * amplitude;
    const sitBlend = this._sit;

    /**
     * Sitting, copied pose-for-pose from `avatar.js` so that standing up off a
     * log looks the same from inside your own head as it does from across the
     * clearing. The thighs go forward and the whole straight limb follows —
     * there is no knee, and the reasoning for not faking one is over there.
     */
    this.legs[0].pivot.rotation.x = lerp(swing, -1.42, sitBlend);
    this.legs[1].pivot.rotation.x = lerp(-swing, -1.42, sitBlend);
    this.legs[0].pivot.rotation.z = lerp(0, -0.13, sitBlend);
    this.legs[1].pivot.rotation.z = lerp(0, 0.13, sitBlend);
    this.torso.rotation.x = lerp(0, 0.18, sitBlend);
    this.torso.position.y = 1.0;

    /**
     * ---- the arms ----------------------------------------------------------
     *
     * At the sides, opposite the legs, and never forward. The only thing that
     * lifts them is `lookAtHands`, which has an end. See the header.
     *
     * The raise is a big one — most of a right angle at each shoulder plus a
     * pull inward — because it has to bring the hands from beside the hips into
     * a frame you are already looking down into, and a small lift just makes the
     * arms twitch.
     */
    const hands = this._hands;
    const armSwing = -swing * 0.75;
    this.arms[0].pivot.rotation.x = lerp(lerp(armSwing, -0.62, sitBlend), 1.45, hands);
    this.arms[1].pivot.rotation.x = lerp(lerp(-armSwing, -0.62, sitBlend), 1.45, hands);
    this.arms[0].pivot.rotation.z = lerp(-0.11, -0.5, hands);
    this.arms[1].pivot.rotation.z = lerp(0.11, 0.5, hands);

    /**
     * The rod's hand is empty of an arm.
     *
     * `fishing.js` hangs 2.5 m of rod off the body at +0.3 m with no hand on the
     * end of it — its header explains that the arm is a capsule pivoted at the
     * shoulder and that a rod attached to one would swing its butt through the
     * chest. From the outside that reads fine because you are looking at the rod;
     * from the inside, with the arm 40 cm from your eye, an arm that does not
     * hold the thing it is next to is worse than no arm. So the right arm is
     * taken out of the scene while a rod is out, which also gives back a draw
     * call at exactly the moment there is an extra one.
     */
    this.arms[1].limb.visible = this._rod < 0.5;
  }

  /**
   * The shadow: where, how long, how dark.
   *
   * Every branch here is a REASON NOT TO DRAW IT, and they are ordered cheapest
   * first. Underground there is no sun; at night there is no sun; on a steep
   * slope a flat quad lying on a hillside intersects it and becomes a torn
   * triangle, which is far worse than nothing.
   */
  _updateShadow(feet) {
    const c = this.controller;
    /**
     * `roofed` and not `inCave`, the same guard every other question in this
     * project uses: `inCave` is a containment ramp that is high a metre inside a
     * mouth where the sun is still on you, and `roofed` is the honest "is there
     * rock between you and the sky". See its declaration in controller.js.
     */
    // One `dayPhase()` for the whole function. It is pure and cheap, but the
    // house rule about reading the world clock once per frame exists precisely
    // so that two things derived from it cannot disagree — see main.js.
    const phase = dayPhase();
    const light = c.roofed ? 0 : daylightAt(phase);
    if (light <= 0.02) {
      this.shadow.visible = false;
      return;
    }

    const sun = sunVector(phase, this._sun);
    // Below the horizon the geometry is meaningless — the length goes negative
    // and then infinite through the crossing. `daylightAt` has usually shut this
    // off long before, but "usually" is not a guard.
    if (sun.y <= 0.05) {
      this.shadow.visible = false;
      return;
    }

    const ground = groundUnder(c.position.x, c.position.z);
    const air = feet - ground;
    if (air > SHADOW_AIR) {
      this.shadow.visible = false;
      return;
    }

    /**
     * The slope under the feet, resampled only when the body has moved. A quad
     * lying flat on a 30° hillside sinks half its length into the hill at one
     * end and floats it at the other, so the opacity is taken to nothing well
     * before that becomes visible — the shadow is gone by about 34°, which is
     * around the steepest the terrain's own soft floor allows anybody to stand.
     */
    if (
      Math.abs(c.position.x - this._normalAt.x) > SHADOW_MOVE ||
      Math.abs(c.position.z - this._normalAt.y) > SHADOW_MOVE
    ) {
      this._normalAt.set(c.position.x, c.position.z);
      this._slope = normalAt(c.position.x, c.position.z, _slopeNormal).y;
    }
    const flat = clamp01((this._slope - 0.83) / 0.12);
    if (flat <= 0.01) {
      this.shadow.visible = false;
      return;
    }

    /**
     * length = h / tan(elevation), written with the vector's own components so
     * there is no `asin` and no `tan`: sun.y is sin(elevation) and the horizontal
     * magnitude is cos(elevation), so their ratio is the cotangent already.
     */
    const horiz = Math.hypot(sun.x, sun.z);
    const length = clamp((SHADOW_H * horiz) / sun.y, 1.1, SHADOW_MAX);
    const width = 0.95;

    /**
     * Thrown directly away from the sun.
     *
     * The plane is tilted −90° about X first (Euler order 'YXZ', set once in the
     * constructor), which maps its local +Y — the head end of the drawing — onto
     * world −Z. Rotating by θ about Y then sends −Z to (−sin θ, 0, −cos θ), and
     * the direction away from the sun is (−sun.x, −sun.z) normalised, so
     * θ = atan2(sun.x, sun.z). Two lines and no matrix.
     */
    this.shadow.rotation.y = Math.atan2(sun.x, sun.z);
    /**
     * Scaled about the quad's centre, so the FEET have to be pushed back to the
     * head end of it — the drawing has the head at v = 0 and the feet at v = 1,
     * and the feet are the end that is attached to you.
     */
    const away = horiz > 1e-5 ? 1 / horiz : 0;
    const dirX = -sun.x * away;
    const dirZ = -sun.z * away;
    this.shadow.scale.set(width, length, 1);
    this.shadow.position.set(
      dirX * length * 0.5,
      /**
       * 4 cm above the ground it is lying on, in the GROUP's frame — and the
       * group is at the feet, which during a jump are not on the ground. The
       * `-air` puts it back on the hillside. 0.04 rather than the avatar disc's
       * 0.03 because this quad is metres long and the terrain under it is not
       * flat; the extra centimetre is what stops the far end z-fighting on a
       * gentle rise.
       */
      0.04 - air,
      dirZ * length * 0.5
    );
    /**
     * Darkness. Four independent reasons to be fainter, multiplied because they
     * genuinely are independent:
     *
     *   `light` — a shadow needs a sun, and at dusk there is barely one.
     *   `flat` — see above.
     *   air — a body four metres up does not have a sharp shadow at its feet.
     *   length — a long low shadow is a diffuse one. The reference is the noon
     *     length (1.75 · cot(90°) → the clamp's 1.1 floor), and by SHADOW_MAX it
     *     is down to about half.
     */
    this.shadowMaterial.opacity =
      SHADOW_ALPHA *
      light *
      flat *
      clamp01(1 - air / SHADOW_AIR) *
      lerp(1, 0.5, clamp01((length - 1.1) / (SHADOW_MAX - 1.1)));
    this.shadow.visible = this.shadowMaterial.opacity > 0.01;
  }

  dispose() {
    this.material.dispose();
    this.shadowMaterial.dispose();
    this.group.removeFromParent();
  }
}
