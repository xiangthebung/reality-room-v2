import * as THREE from 'three';
import { clamp, clamp01, damp } from '../core/util.js';
import { modalHasKeyboard, worldHearsKey } from '../core/keys.js';
import { WATER_LEVEL, confine, groundUnder, normalAt } from '../world/terrain.js';
import { colliderGrid, bushZones } from '../world/forest.js';
import { caveSample } from '../world/caves.js';

/**
 * The body.
 *
 * A capsule that walks on the heightfield and pushes out of tree trunks. The
 * camera is a *child concept* rather than the body itself: the controller owns
 * position and yaw/pitch, and everything the trip does to the view — roll,
 * sway, dolly, field of view — is applied on top by the trip director, after
 * this has finished. Keeping those apart is what makes it safe to let the trip
 * move the camera a couple of metres without the player ever falling through a
 * hill or reaching through a tree.
 *
 * WHAT IT PUBLISHES, AND WHY IT IS A LIST RATHER THAN A SET OF QUERIES.
 *
 * `inCave`/`roofed`/`caveDepth`, `wade`/`wetFeet`, `stride`, `exertion` and the
 * landing dip are all facts about where this body is and what it is doing, and
 * every one of them has at least three consumers — the movement here, a sound,
 * and something drawn. They are written once, in this file, on one frame, for
 * the reason spelled out at `inCave` in the constructor: a consumer that asked
 * its own question at its own point in the loop would be answering about a body
 * that something else had already moved, and the failure mode is a footstep that
 * disagrees with the water you can see yourself standing in.
 */

/**
 * Scratch for the movement vector, the yaw axis, and the ground normal.
 *
 * Hoisted out of `update()` because three `THREE.Vector3` allocations per frame
 * is 180 a second of garbage from the hottest function in the app, for values
 * that are overwritten before anything reads them.
 */
const _moveTarget = new THREE.Vector3();
const _upAxis = new THREE.Vector3(0, 1, 0);
const _slopeNormal = new THREE.Vector3();

const EYE = 1.68;
const RADIUS = 0.34;
const WALK = 4.4;
const RUN = 8.2;
const ACCEL = 14;
const GRAVITY = 22;
const JUMP = 7.1;
/**
 * How hard uphill drags on speed, in `_climbScale`'s 1 / (1 + climb * CLIMB_K).
 *
 * `climb` is sin(slope angle) in the direction of travel — see `_climbScale` —
 * so 0.3 of it is the low end of what `scatter.js` calls sloped ground and
 * 0.8-1 is its steepest walkable hillsides. At 1.6 those come out to roughly
 * two-thirds speed and a third to a quarter: noticeable without ever reading
 * as a wall, since nothing here actually blocks the climb.
 */
const CLIMB_K = 1.6;

/**
 * LANDING, in four numbers.
 *
 * A jump off a four-metre bank used to be completely silent with no camera
 * response at all — you left the ground, the ground arrived, and the only thing
 * that changed was that `onGround` went back to true. Everything else about the
 * body is simulated (an uphill cost from the real gradient, a step-up rule, a
 * roof you bang your head on) and the one moment a body most obviously has mass
 * was the one moment nothing happened.
 *
 * LAND_SOFT is where a touchdown starts to count. Walking off a 20 cm root at
 * WALK arrives at about 2 m/s under GRAVITY, and a kerb is not an event; JUMP is
 * 7.1 m/s up, so landing a flat jump on level ground arrives at 7.1 m/s down and
 * is comfortably an event. 3 sits between them.
 *
 * LAND_HARD is the top of the scale rather than a limit. GRAVITY is 22, so 11
 * m/s is a 2.75 m drop — the bank above the river, the lip of the gully at the
 * cave mouth, the step off a boulder. Anything worse is still 1; a scale that
 * kept going would spend its whole range on falls the world does not contain.
 *
 * LAND_DIP is how far the camera drops at full impact. 9 cm is a knee bend and
 * not a stumble: the head bob is 5.5 cm at a full sprint, so this is a little
 * under twice the largest vertical motion the view already makes, which is the
 * most you can add before it reads as the camera coming loose from the body.
 *
 * LAND_W is the spring's frequency, critically damped. The impulse response of
 * a critically damped spring is v0·t·e^(-ωt), which peaks at t = 1/ω — so
 * ω = 14 rad/s puts the bottom of the dip 71 ms after the foot lands. Stepped
 * through the closed form below at 165, 60, 30 and 12 fps it peaks at 9.00,
 * 8.98, 8.98 and 8.89 cm and is back inside 4 mm by 0.42-0.50 s. Slower than
 * this and you are still sinking when you have started walking again; faster and
 * it is a click rather than a compression.
 */
const LAND_SOFT = 3;
const LAND_HARD = 11;
const LAND_DIP = 0.09;
const LAND_W = 14;
/**
 * WATER, in two numbers.
 *
 * The channel `heightAt` carves is about a metre and a half deep in the middle,
 * and until now wading through it changed nothing at all: not your speed, not
 * your footstep, not the audio. WADE_FULL is the depth at which the drag and the
 * sound are at full — 1.4 m against an eye at 1.68 puts "full" at roughly chest
 * deep, which is as deep as the river gets and as deep as anybody would walk.
 *
 * WET_STEPS is how many strides you leave wet prints for after climbing out.
 * Two dozen at the walking cadence (`speed * 0.52` strides a second, so about
 * 2.3 a second at WALK) is a little over ten seconds — long enough that coming
 * out of the river is a thing that happened to you rather than a state you
 * instantly leave.
 */
const WADE_FULL = 1.4;
const WET_STEPS = 24;

/**
 * How long a tapped wave stays on the wire, in seconds.
 *
 * The pose row goes out at TICK_HZ = 18, so anything under 56 ms can land
 * entirely between two ticks and be seen by nobody. 1.6 s is about one full
 * raise-wave-lower, is nearly thirty ticks so a dropped packet is invisible, and
 * is short enough that a stuck key is a person waving rather than a statue.
 */
const WAVE_HOLD = 1.6;

/**
 * The tallest rise a stride can take you up, in metres. Underground only.
 *
 * 0.55 is a big step rather than a scramble: it clears the breakdown chip and
 * the flowstone lip and the rippled floor, and stops at anything you would
 * actually have to put a hand on. See the step block in `update`.
 */
const STEP_UP = 0.55;
/**
 * How much hillside has to be over your head before the surface is out of
 * reach, in metres. See `roofed`.
 *
 * 2.4 is head height plus a stretch: the eye is at 1.68 and the longest reach
 * anything in the world asks for is a mushroom at 2.6 m, so at this clearance
 * there is nothing on the surface you could plausibly be touching. Above it,
 * every reach through the ceiling is somebody standing under a mountain — and
 * below it you are at a mouth, where the ground overhead IS the ground you are
 * about to walk out onto and everything should still work.
 */
const ROOF_CLEARANCE = 2.4;
/**
 * Flight, which exists for the debug panel and for nothing else.
 *
 * Both numbers are guarded by `this.fly`, which is false in every shipping path,
 * so the walking body below is bit-identical to the one that existed before this
 * — the only cost to a player is one `if` per frame in a function that already
 * does two grid queries.
 *
 * Space rises and Shift descends, which is the arrangement every creative mode
 * in every game uses; Shift therefore stops meaning "run" while flying, and
 * FLY_BOOST is why that costs nothing.
 */
const FLY_BOOST = 2.4;
const FLY_CLIMB = 9;

export class Controller {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.position = new THREE.Vector3(0, 0, 5);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -0.05;
    this.onGround = true;
    this.locked = false;
    this.enabled = true;
    /** Head bob phase and the current bob offset, in metres. */
    this._bob = 0;
    this._bobY = 0;
    this._bobX = 0;
    /** Smoothed speed, used for bob and for the audio's footstep rate. */
    this.speed = 0;
    /**
     * FOOTFALLS AS A CONTINUOUS COUNT, WHICH IS WHAT MADE THE LEGS POSSIBLE.
     *
     * This was `_stepAccum`, a 0..1 sawtooth that fired `onStep` and subtracted
     * one. That is all the SOUND ever needed, and it is not enough for a body:
     * a fractional accumulator says how far through a stride you are and says
     * nothing about WHICH foot, so legs driven from it would swing at the right
     * rate with both feet planting together.
     *
     * `stride` is the same quantity integrated and never reset, so every whole
     * number is a footfall and its parity is the foot. `body.js` takes
     * cos(π·stride) for the swing, which is at an extreme exactly on the integers
     * — so the visible foot plants on the frame the sound is played, and the two
     * cannot drift apart because there is only one number.
     *
     * IT IS NOT THE BOB PHASE, and that was the first attempt. `_bob` advances at
     * 1.65 per metre and the step rate at 0.52, a ratio of 3.173 against the
     * bob's own period of π — a 1% mismatch that walks the foot right round the
     * bob over about a hundred strides. Locking the legs to the sound rather than
     * to the bob is the version where the plant is always on the beat.
     */
    this.stride = 0;
    this._nextStep = 1;
    this.onStep = null;
    /**
     * LANDING, PUBLISHED THE SAME WAY THE CAVE IS.
     *
     * `_landY` is the current dip in metres (negative is down) and `_landV` its
     * velocity; `applyToCamera` adds the first to the eye and nothing else reads
     * either. `onLand(impact)` fires once on touchdown with 0..1, and `onJump()`
     * on the frame the jump key takes — a take-off scuff, because leaving the
     * ground is as much a physical event as arriving and half a jump's worth of
     * sound is worse than none.
     */
    this._landY = 0;
    this._landV = 0;
    /** One warning, ever. See `_guardFinite`. */
    this._warnedFinite = false;
    this.onLand = null;
    this.onJump = null;
    /**
     * HOW DEEP IN THE RIVER YOU ARE, 0..1, PUBLISHED RATHER THAN ASKED FOR.
     *
     * Exactly the argument the `inCave` block below makes and for exactly the
     * same failure: the movement scaling, the footstep and the audio all have an
     * opinion about the water and they must agree on ONE frame. A consumer that
     * recomputed it from `position.y` at a different point in the loop would be
     * reading a body that the floor clamp had already moved.
     *
     * `wetFeet` is the same thing plus the tail: it stays high for WET_STEPS
     * strides after you climb out, so `ambience.step` keeps choosing its wet
     * variant while your boots are still full. It is what main.js should hand
     * the footstep, `max`-ed with the horizontal `wetness(x, z)` — see the note
     * on that bug in main.js.
     */
    this.wade = 0;
    this.wetFeet = 0;
    this._wetSteps = 0;
    this.onWade = null;
    /**
     * HOW HARD YOU HAVE BEEN WORKING, 0..1.
     *
     * Rises over about nine seconds of sprinting and falls over about twenty-two
     * of standing still, which is the asymmetry that makes it a state rather than
     * a speedometer — you can be out of breath while standing at the top of the
     * hill you just ran up, and that is the only interesting thing this number
     * can say. Read by `ambience.breath`, and by nothing that moves the body:
     * this deliberately does not slow you down, because a stamina bar is a
     * mechanic and this is a sound.
     */
    this.exertion = 0;
    /** Positive slope in the direction of travel, kept by `_climbScale`. */
    this._climb = 0;
    /**
     * The two hand gestures, read off the held-key set in `update`. Booleans, so
     * `net/index.js` can turn them straight into pose bits with no state of its
     * own — see the block that reads them.
     */
    this.pointing = false;
    this.waving = false;
    this._waveHeld = false;
    this._waveTimer = 0;
    /** Bush zones the body is currently inside, so `onBrush` fires once per approach. */
    this._insideBush = new WeakSet();
    this.onBrush = null;
    /**
     * Look and bob, exposed because the settings menu owns them and this file
     * does not. Sensitivity multiplies the base rate rather than replacing it,
     * so 1 is exactly the feel this was tuned at and nothing changes for a
     * player who never opens the menu.
     */
    this.lookSensitivity = 1;
    this.invertLook = false;
    /** 0 pins the camera to the body. Motion-sickness control, not taste. */
    this.bobScale = 1;
    /**
     * The debug panel's two levers on the body, both inert at their defaults.
     *
     * `speedScale` multiplies walking and running — a wood is 900 m across and
     * checking something at the far edge of it should not be a two-minute walk.
     * `fly` drops gravity, the trunk push, the cave walls and the ground clamp;
     * see FLY_BOOST above and the branch in `update`. Neither is reachable
     * without the panel, and neither is persisted.
     */
    this.speedScale = 1;
    this.fly = false;
    /**
     * Underground, published rather than asked for.
     *
     * `inCave` is the containment ramp, 0..1; `caveFloor` is the surface the
     * body is standing on when it is non-zero; `caveDepth` is metres into the
     * passage. Three consumers read them and none of them should have to run
     * `caveSample` again: the frame loop needs the depth for the fog crossfade,
     * the cave audio needs it for the reverb and the occlusion, and the step
     * callback needs to know whether a footstep is a thud or a ring. Sampling
     * once per frame in the one place that already has to is cheaper than three
     * scans, and — the part that matters — it means all four agree about where
     * the player is on the same frame, which they would not if each asked at a
     * different point in the loop.
     */
    this.inCave = 0;
    this.caveFloor = 0;
    this.caveDepth = 0;
    /**
     * IS THERE ROCK BETWEEN YOU AND THE SKY. Published beside the other five and
     * for the same reason: it is a fact about where the body is, `caveSample`
     * has already run, and every consumer must agree about it on one frame.
     *
     * IT IS NOT `inCave > 0.5` AND THAT DISTINCTION IS THE WHOLE POINT. The
     * containment ramp says how ENCLOSED you are, which is high one metre inside
     * a narrow mouth where you can still see the clearing and reach a mushroom
     * growing in it — and only about 0.5 in the middle of a chamber sixty metres
     * under a mountain. Every question anybody actually wants to ask of it is
     * "can I touch the surface from here", and the honest answer to that is a
     * height, not a ramp: how far the hillside overhead stands above the floor
     * the body is standing on. See `ROOF_CLEARANCE`.
     */
    this.roofed = false;
    /**
     * …and what the passage is like where the body is, for the audio.
     *
     * `caveTight` is how constricted, `caveRoom` is how big, `caveWater` is how
     * near running water. Published for the same reason the three above are:
     * `caveSample` is a scan and the audio must not run a second one, and — the
     * part that matters — the reverb, the draught and the stream have to agree
     * with the geometry on the same frame or a squeeze sounds like the chamber
     * you left. Zero outside, so the audio layer needs no special case.
     */
    this.caveTight = 0;
    this.caveRoom = 0;
    this.caveWater = 0;
    /**
     * HOW FAR UNDER THE MOUNTAIN, 0..1, AND IT IS NOT `caveDepth`.
     *
     * `caveDepth` is metres walked along the passage. `caveDeep` is the DESCENT
     * — 0 at the mouth, 1 at forty-five metres below it — which is the measure
     * caves.js keys everything on and which its own shapes header argues for:
     * you can walk a hundred metres of level tube and be nowhere. Published
     * beside the other five for the reason they all are: `caveSample` is a scan,
     * it has already run this frame, and every consumer has to agree about where
     * the player is on ONE frame.
     */
    this.caveDeep = 0;

    this.keys = new Set();
    this._bind();
    this.position.y = groundUnder(this.position.x, this.position.z) + EYE;
  }

  _bind() {
    const canvas = this.dom;
    canvas.addEventListener('click', () => {
      if (!navigator.webdriver && !this.locked) canvas.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      document.body.classList.toggle('locked', this.locked);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      const s = 0.0022 * this.lookSensitivity;
      this.yaw -= e.movementX * s;
      const pitchDelta = e.movementY * s * (this.invertLook ? -1 : 1);
      this.pitch = clamp(this.pitch - pitchDelta, -1.35, 1.35);
    });
    window.addEventListener('keydown', (e) => {
      // Let the debug panel's inputs receive their own keys.
      if (e.target instanceof HTMLInputElement) return;
      /**
       * `allowRepeat`, because a Set does not care how many times you add the
       * same code and the first press is what matters. The two guards that DO
       * matter here are the other two:
       *
       * A key held as half a browser chord is not a movement key, and on macOS
       * it is a trap — `Cmd+W`, `Cmd+A`, `Cmd+S` deliver a `keydown` for the
       * letter and then no `keyup` at all, because the system takes the chord.
       * The code stayed in this set for the rest of the session and walked you
       * quietly into a tree.
       *
       * And a modal panel owns the keyboard while it is up. See `update`.
       */
      if (!worldHearsKey(e, { allowRepeat: true })) return;
      this.keys.add(e.code);
    });
    // NOT guarded. A release has to be heard whatever was true when the key
    // went down — guard this and a key pressed before a menu opened is held for
    // ever after it closes.
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  get eyeHeight() {
    return EYE;
  }

  /** Unit vector the player is facing, on the ground plane. */
  forward(out = new THREE.Vector3()) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  update(dt) {
    if (!this.enabled) return;
    /**
     * WALKING AWAY UNDER THE SETTINGS MENU.
     *
     * The guard on the keydown listener stops NEW keys arriving while a panel
     * is up; it cannot do anything about the ones already down when it opened,
     * and that is the case that actually happened. Escape is how the menu
     * opens, you press it mid-stride with `W` held, and the browser sends the
     * `keyup` for `W` to whoever has focus — which by then is the dialog. So
     * `W` stayed in the set and the body walked, blind, for as long as the menu
     * was up, and you closed it somewhere you had never been.
     *
     * Cleared rather than early-returned: gravity, collisions and the ground
     * clamp all still have to run, because this is not a pause — the sun keeps
     * moving, the ferry keeps sailing and there may be seven other people in
     * the room. You simply stop walking.
     */
    if (modalHasKeyboard()) this.keys.clear();
    const keys = this.keys;

    /**
     * ---- the two things you can do with your hands --------------------------
     *
     * READ HERE RATHER THAN IN A NEW LISTENER, because this file already owns a
     * guarded `keydown` and a held-key set, and a sixth `window` listener is
     * exactly what `worldHearsKey` exists to stop growing. It also means both
     * gestures inherit the two guards that took a day each: a browser chord does
     * not fire them, and a key held when the settings menu opened is cleared
     * rather than stuck.
     *
     * POINTING IS A HELD STATE and waving is a LATCHED one, and the difference is
     * the network. Pointing has a duration a person chooses — you hold it while
     * you say "over there" — so it is simply the key. A wave is a tap, and the
     * pose row goes out at 18 Hz: a tap shorter than 55 ms would fall between two
     * ticks and nobody would see it. WAVE_HOLD is a little over a full wave
     * gesture and comfortably longer than a dropped packet, so the bit is on for
     * long enough that the arm gets all the way up and back down.
     *
     * Neither of these does ANYTHING to the body here — no speed change, no
     * pose, no camera. They are two booleans that `net/index.js` turns into two
     * bits and `avatar.js` turns into an arm. The whole cost is two Set lookups
     * a frame.
     */
    this.pointing = keys.has('KeyR');
    const waveKey = keys.has('KeyH');
    if (waveKey && !this._waveHeld) this._waveTimer = WAVE_HOLD;
    this._waveHeld = waveKey;
    if (this._waveTimer > 0) this._waveTimer = Math.max(0, this._waveTimer - dt);
    this.waving = this._waveTimer > 0;

    const running = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const target = _moveTarget.set(0, 0, 0);
    // Stale unless `_climbScale` runs this frame, and standing still or flying
    // is genuinely no climb at all. See `exertion` below.
    this._climb = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) target.z -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) target.z += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) target.x -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) target.x += 1;

    if (target.lengthSq() > 0) {
      target.normalize().applyAxisAngle(_upAxis, this.yaw);
      const base = (running && !this.fly ? RUN : WALK) * this.speedScale;
      // No hill to fight while flying, and no run key either — Shift is the
      // descent. See FLY_BOOST.
      target.multiplyScalar(this.fly ? base * FLY_BOOST : base * this._climbScale(target.x, target.z));
      /**
       * WATER DRAG, ON THE TARGET AND NEVER AS A PUSH.
       *
       * Folded in here, next to `_climbScale`, because it is the same kind of
       * thing: a scale on the speed you are asking for, applied before the ease
       * so the body accelerates toward a slower walk rather than being fought
       * while it walks at the old one.
       *
       * THE ALTERNATIVE IS THE ONE THIS FILE'S HEADER IS FULL OF POST-MORTEMS
       * ABOUT. Every stall this body has ever produced — the trunk push at a cave
       * mouth, the radial push in a keyhole slot — was a POSITIONAL correction
       * whose backward component happened to cancel a walking pace, and each one
       * read from outside as full velocity and no displacement. A current in the
       * river implemented as a shove would be another, and would be worse,
       * because it would only fire in one place in the world.
       *
       * 0.62 at full depth: chest-deep water is a bit under two-fifths off, so
       * WALK becomes 2.7 m/s and a sprint into the river becomes a heavy jog.
       * That is enough to feel the moment you step in without ever reading as
       * being held — nothing here blocks, exactly as nothing about the hill does.
       *
       * `this.wade` is last frame's, by one frame. It is a depth that changes at
       * most a few centimetres per frame at RUN down a river bank, so the error
       * is under a percent of the scale; computing it here instead would mean
       * sampling the floor twice, before and after the move.
       */
      if (this.wade > 0) target.multiplyScalar(1 - this.wade * 0.62);
    }

    // Horizontal velocity eases toward the target; vertical is pure ballistics.
    this.velocity.x = damp(this.velocity.x, target.x, Math.exp(-ACCEL * 0.5), dt);
    this.velocity.z = damp(this.velocity.z, target.z, Math.exp(-ACCEL * 0.5), dt);

    /**
     * ---- flight, the debug branch ------------------------------------------
     *
     * Everything the walking body does about the vertical is replaced rather
     * than modified: no jump, no gravity, no trunk push, no cave wall, no floor.
     * `confine` still runs, because leaving the world's own bounds is not a
     * useful place to be able to get to and the height field does not exist out
     * there. `_resolveCave` still runs too — it is what publishes `inCave` and
     * `caveDepth` to the fog and the reverb — but its pushes are skipped, so
     * flying through rock reads as being inside the hill rather than as being
     * shoved back out of it.
     */
    if (this.fly) {
      this.velocity.y = 0;
      const climb = FLY_CLIMB * this.speedScale * dt;
      if (keys.has('Space')) this.position.y += climb;
      if (running) this.position.y -= climb;
      this.position.x += this.velocity.x * dt;
      this.position.z += this.velocity.z * dt;
      this.onGround = false;
      confine(this.position);
      this._resolveCave();
      this._bobY = damp(this._bobY, 0, 0.001, dt);
      this._bobX = damp(this._bobX, 0, 0.001, dt);
      this.speed = damp(this.speed, 0, 0.001, dt);
      // A debug camera is not a body: no water, no landing, no effort. Zeroed
      // rather than left stale so flying out of the river does not leave the
      // walk permanently slowed when `fly` is switched back off.
      this.wade = 0;
      this.wetFeet = damp(this.wetFeet, 0, 0.001, dt);
      this.exertion = damp(this.exertion, 0, 0.4, dt);
      this._landY = 0;
      this._landV = 0;
      return;
    }

    if (this.onGround && keys.has('Space')) {
      this.velocity.y = JUMP;
      this.onGround = false;
      // The scuff of pushing off, on the frame the push happens. Half of a jump
      // having a sound is worse than none: it teaches you that the ground makes
      // a noise only when you arrive.
      this.onJump?.();
    }
    this.velocity.y -= GRAVITY * dt;

    /**
     * How fast the body is falling, captured BEFORE anything can clamp it.
     *
     * The floor clamp, the roof clamp and the step rule all write
     * `velocity.y = 0`, and by the time `onGround` flips there is nothing left
     * in the vertical to measure. Three lines further down is too late; this is
     * the only place the number exists.
     */
    const fallSpeed = this.velocity.y;
    const wasAirborne = !this.onGround;

    /**
     * Where the feet were, and what they were standing on, before the step.
     *
     * Only used underground — see the step block after the collision passes.
     */
    const fromX = this.position.x;
    const fromZ = this.position.z;
    const fromFloor = this.inCave > 0 ? this.caveFloor : this.position.y - EYE;

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.position.y += this.velocity.y * dt;

    this._resolveCollisions();
    this._resolveBrush();
    confine(this.position);
    this._resolveCave();

    /**
     * A STEP YOU COULD NOT TAKE, WHICH IS THE ONE THING THE HEIGHT FIELD NEVER
     * NEEDED AND THE CAVE CANNOT DO WITHOUT.
     *
     * "The walking logic is different from on land — I go up objects instantly."
     * It was, and this is why. On the surface the floor is `groundUnder`, a
     * height field: it is continuous, so the clamp below never moves the body
     * more than the hillside's own gradient times a frame's travel, and anything
     * that is not walkable — a trunk, a boulder — is a COLLIDER and gets walked
     * round. Underground the floor is whatever `caveSample` says, and it says
     * "the top of that breakdown block" the instant your circle overlaps one.
     * The clamp then teleports the body up to it: the guard over there only
     * requires the block's top to be under `y + 0.6`, which with the eye at 1.68
     * is a free 2.3 m lift. You do not climb a boulder, you appear on it.
     *
     * So the same rule the surface gets for nothing: a rise you could step onto
     * you step onto, and a rise you could not is a wall. Blocking is the whole
     * of it — the horizontal move is given back and the velocity is left alone,
     * so you slide along the face of the block exactly as you slide along a
     * trunk, and the next `caveSample` is the price. Nothing lifts the body but
     * the clamp, and now nothing lifts it by more than a stride.
     *
     * ONLY UNDERGROUND, and that restraint is deliberate rather than timid. The
     * surface has cliffs steeper than STEP_UP over a frame's travel at RUN, and
     * a body that suddenly could not climb them is a change nobody asked for to
     * a world people have already walked.
     */
    if (
      this.inCave > 0 &&
      this.onGround &&
      this.caveStep > 0.05 &&
      this.caveFloor - fromFloor > STEP_UP
    ) {
      this.position.x = fromX;
      this.position.z = fromZ;
      this._resolveCave();
    }

    /**
     * The floor, which underground is not the ground.
     *
     * `groundUnder` is the height FIELD, and a height field has exactly one
     * surface per column — so thirty metres inside a hillside it still answers
     * "the top of the hill", and the clamp below would fire the player up
     * through the rock every frame. `_resolveCave` has already worked out which
     * surface the body is actually standing on and left it in `this.caveFloor`;
     * outside a cave that is `groundUnder` to the bit and this line is exactly
     * what it always was.
     *
     * Note the ROOF clamp does not live here. It is in `_resolveCave`, above,
     * because it has to be applied before the floor test — a jump that puts the
     * head through the ceiling and is then pushed back down must not also be
     * reported as landing.
     */
    const floor = (this.inCave > 0 ? this.caveFloor : groundUnder(this.position.x, this.position.z, RADIUS)) + EYE;
    if (this.position.y <= floor) {
      this.position.y = floor;
      this.velocity.y = 0;
      this.onGround = true;
    } else if (this.position.y > floor + 0.02) {
      this.onGround = false;
    }

    /**
     * ---- the ground arriving ------------------------------------------------
     *
     * `wasAirborne` and not "velocity was negative", because walking down a
     * slope steeper than the frame's travel leaves the body a couple of
     * centimetres off the floor for one frame at a time and re-clamps it, all
     * day, at whatever speed gravity got to in 16 ms. That is not landing. The
     * `onGround` edge only opens after the body has genuinely left the surface —
     * the `+ 0.02` hysteresis in the clamp above is what makes it trustworthy —
     * and LAND_SOFT then throws away everything that is not a fall.
     */
    if (wasAirborne && this.onGround && fallSpeed < -LAND_SOFT) {
      const impact = clamp01((-fallSpeed - LAND_SOFT) / (LAND_HARD - LAND_SOFT));
      /**
       * v0 = D·ω·e, from the impulse response quoted at LAND_DIP: a critically
       * damped spring kicked with velocity v0 peaks at v0/(ωe), so this is that
       * read backwards and the dip is LAND_DIP·impact metres to the centimetre.
       * Negative because the head goes DOWN.
       */
      this._landV = -impact * LAND_DIP * LAND_W * Math.E;
      /**
       * A WHOLE STRIDE OUT OF THE LANDING. Without this the first footstep after
       * a jump fires on whatever fraction of a stride was left when you took off
       * — which after a long fall is usually immediately, so the sound of the
       * landing and the sound of the first step arrive on the same frame and
       * read as one muddy noise. Parked exactly on a footfall boundary, so the
       * legs in `body.js` start the next stride from a plant.
       */
      this.stride = Math.ceil(this.stride);
      this._nextStep = this.stride + 1;
      this.onLand?.(impact);
    }

    /**
     * …and the spring that makes it visible, advanced here and applied in
     * `applyToCamera`.
     *
     * ADVANCED IN CLOSED FORM RATHER THAN INTEGRATED, and that is not showing
     * off. The first version was semi-implicit Euler and it was wrong by 29% —
     * measured, by running the loop: a kick sized for a 9 cm dip peaked at 6.4
     * cm, because at ω = 14 even an 11 ms substep loses that much amplitude to
     * the discretisation. Substepping harder would have chased it; a machine
     * that has just hitched is also exactly the machine that lands on a 60 ms
     * frame, and there the explicit form is not merely inaccurate but heading for
     * unstable (it needs 2ζωΔt < 2, i.e. Δt < 143 ms).
     *
     * A critically damped spring has the exact solution y(t) = (A + Bt)e^(−ωt)
     * with A = y₀ and B = v₀ + ωy₀, so one `exp` a frame gives the true state at
     * ANY dt with no stability condition at all — and the dip really is
     * LAND_DIP · impact, which is the whole reason those constants are written
     * down as metres.
     */
    if (this._landV !== 0 || this._landY !== 0) {
      const decay = Math.exp(-LAND_W * dt);
      const b = this._landV + LAND_W * this._landY;
      const next = this._landY + b * dt;
      this._landV = (b - LAND_W * next) * decay;
      this._landY = next * decay;
      // Snapped to rest rather than left ringing at 10⁻⁷ m for ever, so the
      // branch above is genuinely skipped for the 99% of frames nobody landed on.
      if (Math.abs(this._landY) < 1e-4 && Math.abs(this._landV) < 1e-3) {
        this._landY = 0;
        this._landV = 0;
      }
    }

    /**
     * ---- the river ---------------------------------------------------------
     *
     * `roofed` and not `inCave`: the cave stream runs along the bottom of some
     * passages at heights that have nothing to do with the surface river, and a
     * body sixty metres under a mountain is not standing in the channel however
     * far below WATER_LEVEL its feet happen to be. Same guard, same reason, as
     * every other xz-distance question in this project — see `roofed` above.
     */
    const wadeWas = this.wade;
    this.wade = this.roofed
      ? 0
      : clamp01((WATER_LEVEL - (this.position.y - EYE)) / WADE_FULL);
    /**
     * The edge, which is the loudest moment the water has.
     *
     * One event, at the instant the feet break the surface, at above full
     * strength — walking into a river is a plunge and then a wash, and a wash
     * that simply fades up from nothing has no moment in it at all. 0.06 rather
     * than 0 so that standing on the waterline with the height field jittering a
     * centimetre either side cannot chatter it.
     */
    if (wadeWas < 0.06 && this.wade >= 0.06) {
      this.onWade?.(this._feetPoint(), 1.4, this.wade);
    }

    // ---- head bob --------------------------------------------------------
    // Small, and mostly vertical. Bob is the cheapest way to convey that a body
    // is doing the walking; overdone, it is also the fastest way to make someone
    // motion sick, so the lateral component is a third of the vertical one.
    const horizontal = Math.hypot(this.velocity.x, this.velocity.z);
    this.speed = damp(this.speed, this.onGround ? horizontal : 0, 0.001, dt);
    this._bob += dt * this.speed * 1.65;
    const amount = Math.min(this.speed / RUN, 1) * 0.055 * this.bobScale;
    this._bobY = damp(this._bobY, Math.sin(this._bob * 2) * amount, 0.001, dt);
    this._bobX = damp(this._bobX, Math.sin(this._bob) * amount * 0.34, 0.001, dt);

    /**
     * Footsteps.
     *
     * THIS USED TO SAY "driven by the same phase so the sound lands on the low
     * point", and that was never quite true — the bob advances at 1.65 per metre
     * and this at 0.52, a ratio of 3.173 against the bob's own period of π, so
     * the step drifts a percent per stride against the low point and goes right
     * round it over about a hundred of them. Nobody has ever noticed, because a
     * 5.5 cm bob and a noise burst are not two things an ear can align.
     *
     * They are now, because `stride` also drives the legs you can SEE (see its
     * declaration, and `body.js`), so the sound and the plant are locked to each
     * other by being the same number rather than by two rates that nearly agree.
     * The bob is left exactly as it was.
     */
    if (this.onGround && this.speed > 0.7) {
      /**
       * A LONGER STRIDE IN WATER, which is a rate change and not a volume one.
       *
       * Nobody takes short quick paces through a metre of river; you lift a knee,
       * reach, and put it down. So the strides-per-second falls with depth while
       * the speed scaling above is already making each one cover less ground —
       * the two together are what makes wading read as heavy rather than as
       * walking-but-slower. A quarter longer at chest depth, which against the
       * 0.62 speed drag is roughly half the footfall rate of a dry walk.
       */
      const strideScale = 1 + this.wade * 0.28;
      this.stride += (dt * this.speed * 0.52) / strideScale;
      if (this.stride >= this._nextStep) {
        // `floor(stride) + 1` rather than `+= 1`, so a 200 ms hitch that covers
        // three strides plays one footstep and then resumes in phase, exactly
        // as the old `-= 1` did.
        this._nextStep = Math.floor(this.stride) + 1;
        const strength = Math.min(1, this.speed / RUN);
        this.onStep?.(strength);
        if (this.wade > 0.05) {
          this.onWade?.(this._feetPoint(), strength, this.wade);
          this._wetSteps = WET_STEPS;
        } else if (this._wetSteps > 0) {
          this._wetSteps--;
        }
      }
    } else {
      // Parked 0.45 of a stride short of a footfall, which is what the old
      // `_stepAccum = 0.55` meant: setting off from a stand plays a step almost
      // at once rather than after a full pace of silence.
      this.stride = this._nextStep - 0.45;
    }
    /**
     * Wet boots. `wade` while you are in it, then a linear tail as the prints
     * dry — see WET_STEPS. The max is what makes the transition seamless: at the
     * moment you step out `_wetSteps` is full, so the two agree at 1.
     */
    this.wetFeet = Math.max(this.wade, this._wetSteps / WET_STEPS);

    /**
     * ---- effort -------------------------------------------------------------
     *
     * The target is what the body is doing right now; the two smoothings are
     * what make it a state. `damp`'s constant is the fraction REMAINING after a
     * second, so 0.72 puts a flat sprint nine tenths of the way up in 7.0 s
     * (ln 0.1 / ln 0.72) and 0.87 takes 23 s to fall back inside 4% of rest. The
     * asymmetry is the whole point and it is how lungs work: you can be out of
     * breath standing perfectly still at the top of the hill you just ran up, and
     * that is the only interesting thing this number can say.
     *
     * THE HILL IS ADDED AFTER THE SPEED PENALTY IS ALREADY PAID, and that is
     * deliberate rather than an accident of ordering. `_climbScale` has already
     * SLOWED you on the way up, so a speed-only measure would say a hill is
     * EASIER than the flat — which is exactly backwards. `_climb` is sin(slope)
     * in the direction of travel, so it is 0 on the flat and 0.8-1 on the
     * steepest walkable ground, and it can carry the term past 1 before the
     * clamp: running up the tor is the hardest thing in the world and it should
     * pin.
     */
    const effort = clamp01((this.speed / RUN) * (1 + this._climb * 0.9));
    this.exertion = damp(this.exertion, effort, effort > this.exertion ? 0.72 : 0.87, dt);

    this._guardFinite();
  }

  /**
   * ---- THE LAST LINE OF DEFENCE: A BODY WITH A NUMBER IN IT ----------------
   *
   * If `position` ever goes non-finite the game does not crash, it STOPS, and
   * it stops in a way that takes an afternoon to attribute. Here is the whole
   * chain, observed rather than imagined:
   *
   *   `position.y` goes NaN
   *     -> `applyToCamera` writes NaN into `camera.position`
   *     -> `AudioEngine.updateListener` calls `linearRampToValueAtTime(NaN)`
   *     -> WebAudio THROWS, out of the audio block, every single frame
   *     -> everything after that block in `frame()` never runs, so the animals
   *        stop moving, `findInteractable` never updates and `E` does nothing
   *
   * The report that arrives is "the mushrooms are broken and the deer are
   * frozen", which are two features that have nothing to do with each other and
   * nothing to do with the body. It cost most of a debugging session and it was
   * found by trapping non-finite arguments to every AudioParam method — the
   * value only reaches the audio because that is the first thing in the frame
   * that validates its input.
   *
   * WHERE IT COMES FROM. Not the height field: `heightAt`, `groundUnder` and
   * `normalAt` were swept over 400 000 points of grove-01 in pure node and are
   * finite everywhere. It takes a body that is somewhere a body cannot walk to
   * — teleported to a distant x/z while keeping the y it had, so it is standing
   * twenty-nine metres inside a mountain with a cave in it — and then one of
   * the underground queries has nothing sensible to say.
   *
   * SO THIS IS A GUARD AND NOT A FIX, DELIBERATELY. A player cannot reach that
   * state: the body moves continuously and `confine` keeps it in the world. But
   * a debug panel, a test harness, a seat on a moving raft and a streaming
   * hiccup all can, and the failure mode is out of all proportion to the cause.
   * Putting the body back on the ground under it costs one comparison a frame
   * on the hottest function in the app and turns "the game silently stopped"
   * into one line in the console and a step you probably do not notice.
   *
   * It warns ONCE. A guard that logs every frame is a second denial of service.
   */
  _guardFinite() {
    const p = this.position;
    if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) return;
    const x = Number.isFinite(p.x) ? p.x : 0;
    const z = Number.isFinite(p.z) ? p.z : 0;
    p.set(x, groundUnder(x, EYE + 60, z) + EYE, z);
    this.velocity.set(0, 0, 0);
    this._landY = 0;
    this._landV = 0;
    this._bobY = 0;
    this._bobX = 0;
    if (!this._warnedFinite) {
      this._warnedFinite = true;
      console.warn(
        '[controller] the body went non-finite and was put back on the ground. ' +
          'See _guardFinite — this is reachable by teleporting to an x/z without a y.'
      );
    }
  }

  /**
   * Where the feet are, for a sound that has to arrive from below.
   *
   * A fresh object per call, like `_resolveBrush`'s, and for the same reason:
   * this hands a position to an audio layer that may hold it, and it is called a
   * couple of times a second at most rather than every frame. Hoisting it would
   * save nothing measurable and buy an aliasing bug the first time somebody
   * queues a sound a few hundred milliseconds out.
   */
  _feetPoint() {
    return { x: this.position.x, y: this.position.y - EYE, z: this.position.z };
  }

  /**
   * How much a step toward (dirX, dirZ) — a unit vector — is fighting the hill.
   *
   * `normalAt` returns normalize(-dh/dx, 1, -dh/dz), so its horizontal part
   * already points downhill with magnitude sin(slope angle). Negating it and
   * dotting with the travel direction projects that onto the direction of
   * travel: positive when heading into the hill, negative heading away from
   * it, and zero across the face of a slope or on the flat.
   *
   * Only positive — climbing — is scaled. Downhill is left at full speed
   * rather than boosted: nobody asked for a downhill rush, and an unearned one
   * would make every descent feel like standing on ice.
   */
  _climbScale(dirX, dirZ) {
    const n = normalAt(this.position.x, this.position.z, _slopeNormal);
    const climb = -(dirX * n.x + dirZ * n.z);
    /**
     * Kept for `exertion`, which wants the raw slope rather than the scale.
     * Recomputing it there would be a second `normalAt` — a five-tap height
     * query — in the hottest function in the app, for a number this line already
     * has in a register.
     */
    this._climb = climb > 0 ? climb : 0;
    return climb > 0 ? 1 / (1 + climb * CLIMB_K) : 1;
  }

  /**
   * Push out of trunks.
   *
   * Circle-on-circle, resolved by displacement rather than by cancelling
   * velocity, so sliding along a tree feels smooth instead of sticky. Two
   * passes, because pushing out of one trunk can push into its neighbour and a
   * single pass leaves the player embedded in the second one.
   *
   * THE LIST IS NOW A QUERY, AND THAT IS A STREAMING CONSEQUENCE.
   *
   * This used to scan one flat global array twice per frame — 10.2 µs at 3807
   * entries, which was fine because 3807 was all there would ever be. The
   * forest streams now and a 384 m ring holds something like twenty-five
   * thousand trunks, so the same scan would be a quarter of a millisecond a
   * frame spent almost entirely on trees hundreds of metres away.
   *
   * `colliderGrid.near` returns the 3×3 block of 16 m cells around the body,
   * which is not an approximation: the largest collider in the world is a
   * boulder at r = 1.5 and the body is 0.34, so nothing whose centre is further
   * than 1.84 m outside the player's own cell can reach him. The gather is
   * recomputed when the player crosses a cell or when a sector lands, and
   * returned from cache otherwise — so the common case is one string build and
   * a map lookup, and the two passes below share the one result.
   */
  _resolveCollisions() {
    /**
     * A TRUNK IS A CIRCLE ON A MAP, AND UNDERGROUND THAT IS THE WRONG SHAPE.
     *
     * `colliderGrid` holds `{x, z, r}` — no height, no extent, because for the
     * whole of this project's life the body and the trees stood on the same
     * single-valued surface and a circle was exactly right. A cave is the first
     * place where two things can share a coordinate and not touch: walk twelve
     * metres into a passage and you are under the hillside, where trees grow,
     * and every trunk up there is still a post through the tunnel as far as this
     * function is concerned.
     *
     * The symptom is not subtle and it is not "you clip a tree" — it is that
     * caves cannot be entered. `cave-walk.mjs` holds W from the gully and the
     * body walks in, reaches the first trunk rooted over the passage, and is
     * pushed back out at half a metre a second with its heading still pointing
     * inward. Three mouths on three different slots all stopped within a metre
     * of the same depth, which is the tree line resuming past the cleared gully.
     *
     * Faded out by `inCave` rather than switched off, because the ramp is a
     * metre and a half wide at the mouth and a trunk on the lip of the gully is
     * still a real trunk. Nothing underground can be a legitimate collider:
     * `caveClearance` keeps the scatter out of the gully and off the tor, and
     * the passage is under rock everywhere else.
     *
     * The vertical fix — giving colliders a height and testing it — is the
     * "right" one and is not worth it: it is a wider entry in the busiest grid
     * in the project, ingested per streamed sector, to answer a question one
     * float already answers.
     */
    /**
     * FADED BY DEPTH AS WELL AS BY CONTAINMENT, and the second term is not
     * belt-and-braces — the first one stopped being sufficient.
     *
     * `inCave` was a reliable "is there rock all round me" while every passage
     * was the same tube: it sat at 1 from a few metres in until the mouth. It no
     * longer does. A wide chamber is deliberately less enclosed than a squeeze —
     * that is what the fog and the reverb ride on — and at a junction the
     * winning passage can be the branch you are entering, measured from its own
     * wall. Both put `inCave` around 0.6 with thirty metres of hillside
     * overhead, which handed a third of the trunk push back to trees rooted on
     * the mountain above.
     *
     * The symptom was a body walking at full speed and not moving: the push
     * displaces position without touching velocity, so it stands there running.
     * `cave-walk` caught it as a 600-frame stall at 31 m on one mouth of three,
     * which is exactly the shape of a bug that would otherwise have shipped —
     * two thirds of the caves in the world are fine.
     *
     * Depth is the honest predicate. Six metres past the doorway there is no
     * tree that can legitimately be a collider, whatever the section is doing.
     */
    const solid = (1 - this.inCave) * clamp01(1 - this.caveDepth / 6);
    if (solid <= 0.001) return;
    const colliders = colliderGrid.near(this.position.x, this.position.z);
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      for (let i = 0; i < colliders.length; i++) {
        const c = colliders[i];
        const dx = this.position.x - c.x;
        const dz = this.position.z - c.z;
        const min = c.r + RADIUS;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const push = ((min - d) / d) * solid;
        this.position.x += dx * push;
        this.position.z += dz * push;
        moved = true;
      }
      if (!moved) break;
    }
  }

  /**
   * Bush zones: query only, never push.
   *
   * Same grid mechanics as `_resolveCollisions` — `bushZones.near` is the same
   * cached 3×3 gather, just against the other grid — but nothing here ever
   * moves `this.position`. A bush no longer has a body to push against, only a
   * radius the walker can be inside or outside of, so this tracks that as a
   * boolean per zone and calls `onBrush` on the frame it flips false-to-true.
   * `_insideBush` is a WeakSet keyed on the zone objects themselves, which is
   * what lets it need no cleanup: a zone dropped by `ColliderGrid.removeSector`
   * when its sector unloads is simply no longer reachable, and the WeakSet
   * entry for it collects along with it.
   *
   * The exit test has a margin the enter test does not, so straddling the
   * boundary does not chatter the cue on and off.
   */
  _resolveBrush() {
    // Same map-circle problem as the trunks, in its harmless form: a bush on the
    // hillside over a passage would rustle at somebody thirty metres under it.
    if (this.inCave > 0.5) return;
    const zones = bushZones.near(this.position.x, this.position.z);
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      const dx = this.position.x - z.x;
      const dz = this.position.z - z.z;
      const d2 = dx * dx + dz * dz;
      const enter = z.r + RADIUS;
      const inside = this._insideBush.has(z);
      if (!inside && d2 < enter * enter) {
        this._insideBush.add(z);
        this.onBrush?.(
          { x: z.x, y: groundUnder(z.x, z.z) + 1, z: z.z },
          Math.min(1, this.speed / RUN)
        );
      } else if (inside && d2 > (enter + 0.5) * (enter + 0.5)) {
        this._insideBush.delete(z);
      }
    }
  }

  /**
   * Underground: the floor, the roof, and the walls.
   *
   * Runs AFTER the trunk push and after `confine`, because it is the more
   * specific constraint — a tree cannot grow inside a cave, so nothing the
   * trunk pass does can be undone here, and if the two ever disagreed the rock
   * has to win. Runs BEFORE the floor clamp for the reason given there.
   *
   * ALL THREE COME FROM THE CENTRE LINE, NOT FROM THE MESH. `caves.js` sweeps
   * the visible tube along the same polyline `caveSample` reads, so there is
   * one representation and it cannot drift — the same argument terrain.js makes
   * for the player walking on `heightAt` rather than on the ground mesh. It is
   * also why the rock displacement on the floor is held to 2 cm over there: the
   * walkable surface is the analytic one, and a floor that visibly bulged half
   * a metre while the body walked the smooth line would put your feet inside
   * the rock on every other step.
   *
   * `inCave` is 0..1 rather than a flag. Everything downstream of it — the
   * reverb crossfade, the fog, the footstep timbre — wants a ramp, and a
   * boolean here would force each of them to invent its own.
   */
  _resolveCave() {
    const s = caveSample(this.position.x, this.position.y, this.position.z);
    this.inCave = s.inside;
    if (s.inside <= 0) {
      this.caveDepth = 0;
      this.caveTight = 0;
      this.caveRoom = 0;
      this.caveWater = 0;
      this.caveDeep = 0;
      this.roofed = false;
      return;
    }
    this.caveFloor = s.floor;
    /**
     * Five height samples, and only ever underground — where the whole frame is
     * 0.60 ms and this is the cheapest thing in it. On the surface the early
     * return above means it is not computed at all.
     *
     * `groundUnder` and not `heightAt` because it is the same surface the body
     * would be standing on if it were up there, and the two differ by a few
     * centimetres on a slope; `s.floor` and not `position.y` because a jump must
     * not un-bury you for the third of a second you are in the air.
     */
    this.roofed = groundUnder(this.position.x, this.position.z) - s.floor > ROOF_CLEARANCE;
    /** How much of the floor is something lying on it rather than the passage. */
    this.caveStep = s.floor - s.floorRock;
    this.caveDepth = s.along;
    // Straight off the channel caves.js splines and clamps. See `caveDeep`.
    this.caveDeep = s.deep;
    this.caveTight = s.tight;
    this.caveRoom = s.room;
    this.caveWater = s.water;
    // Flying: publish where the body is, push it nowhere. See the branch in
    // `update` for why the two halves of this function are separable.
    if (this.fly) return;

    /**
     * The wall, pushed in the horizontal plane only.
     *
     * A radial push in 3D would shove the player DOWN whenever they were near
     * the ceiling and up whenever they were near the floor, which turns a
     * corridor into a funnel you slide along. The section is 2.6 radii wide and
     * 1.5 tall, so horizontal is where nearly all the room is anyway, and the
     * vertical extent is already covered by the floor clamp and the roof below.
     *
     * Resolved by displacement rather than by cancelling velocity, exactly like
     * the trunks, so sliding along a passage wall is smooth instead of sticky.
     */
    /**
     * `wallDist`, NOT the radius times a constant.
     *
     * The section is no longer one shape: a canyon is 0.6 radii across and a
     * bedding plane is nearly 2, so a single multiplier is now wrong in both
     * directions at once — it holds you out of the middle of a wide passage and
     * lets you walk through the wall of a narrow one. `caveSample` solves the
     * outline at the body's own chest height and hands back the answer, so the
     * wall the body feels is the wall the sweep drew.
     */
    /**
     * Clamped so the push can never reach the centre line, and never pass it.
     *
     * `push` of 1 puts the body exactly on the axis; above 1 it overshoots to
     * the far side and oscillates. Either one destroys forward motion, because
     * a body snapped to the same ring's centre every frame never leaves that
     * ring however fast it is running — which is precisely the failure a
     * degenerate section produced before the floor cut was fixed upstream. The
     * geometry bug is fixed; this is the guard that makes the whole class of it
     * a slow walk instead of a full stop.
     */
    const wall = Math.max(0.25, s.wallDist - RADIUS - 0.12);
    /**
     * Published for diagnosis, three assignments a frame.
     *
     * Every stall this feature has produced looked identical from outside — full
     * velocity, no displacement — and each time the first hour went on working
     * out WHICH constraint was doing it. These are the three numbers that
     * answer it, and they are free next to the scan that produced them.
     */
    this.caveWall = wall;
    this.caveRadial = s.radial;
    this.cavePost = s.postR;
    /**
     * WHICH passage is holding the body, which the three numbers above cannot
     * say and which is the first thing you want at a junction.
     *
     * `-1` is the main line and anything else is the main ring a branch leaves
     * through, so it names the junction as well as the passage. Two passages
     * overlap by construction wherever a branch starts, and a stall there reads
     * identically whether the main tube is holding you out or the branch is
     * pinning you in. See the selection block at the top of `caveSample`.
     */
    this.cavePathBase = s.path ? s.path.base : null;
    this.caveRing = s.ring;
    if (s.radial > wall && s.radial > 1e-4) {
      const push = Math.min(0.85, (s.radial - wall) / s.radial);
      this.position.x += (s.cx - this.position.x) * push;
      this.position.z += (s.cz - this.position.z) * push;
    }

    /**
     * …and the closed end, which is the one direction the wall push cannot hold.
     *
     * A SECOND CORRECTION RATHER THAN A CHANGE TO THE FIRST, deliberately. The
     * push above is perpendicular to the passage on purpose — a push aimed at the
     * ring's centre has a backward component that exactly cancels a walking pace
     * in a keyhole's slot, which cost a day to find and reads as being blocked by
     * geometry that is not there. Giving it any forward-backward authority
     * reopens that. So `caveSample` measures the overrun past the last ring with
     * standing room in it and reports it separately, and this puts the body back
     * on that plane along the passage's own tangent and does nothing else.
     *
     * Displacement only, and the velocity is left alone, exactly like the wall
     * and the trunks: walking into the back of a chamber at an angle should slide
     * you along it rather than stop you dead. Without this the passage's far end
     * is not solid at all — the mesh there faces inward and is not drawn from
     * behind, so you walk through the rock, out of containment, and the floor
     * clamp puts you on the hillside overhead. Same failure as the roof clamp
     * below, one axis over.
     */
    if (s.axial > 0) {
      this.position.x -= s.axX * s.axial;
      this.position.z -= s.axZ * s.axial;
    }

    /**
     * …and out of a pillar, or out of the part of a breakdown slab you cannot
     * climb: the two things down here you go ROUND.
     *
     * A column is a post from floor to ceiling: there is no over it, and
     * treating one as floor would stand the player on top of a two-metre pillar
     * with their head in the roof.
     *
     * A SLAB IS THE SAME THING ON ONE SIDE AND NOT ON THE OTHER, and it only
     * became so when the collider started answering with the drawn solid rather
     * than a dome fitted over it. A dome ramps to nothing at its rim, so every
     * boulder in the world was a hill and every one of them was climbed. The
     * drawn slab has a lid over a near-vertical fracture face, the step rule
     * above correctly refuses it, and refusing is all that rule does — so
     * without this, walking head-on into a boulder was a dead stop with room to
     * pass on both sides. `caveSample` publishes the lid's plan radius as a post
     * when the body's feet are more than STEP_UP below it; the ramp side stays
     * floor and is still walked up.
     *
     * Same displacement push as the trunks, and for the same reason —
     * cancelling velocity against something you are sliding past is sticky.
     */
    if (s.postR > 0) {
      const dx = this.position.x - s.postX;
      const dz = this.position.z - s.postZ;
      const d = Math.hypot(dx, dz);
      const want = s.postR + RADIUS;
      if (d < want && d > 1e-4) {
        this.position.x = s.postX + (dx / d) * want;
        this.position.z = s.postZ + (dz / d) * want;
      }
    }

    /**
     * The roof.
     *
     * The one thing a height field has never needed and the only reason a jump
     * is dangerous underground: JUMP is 7.1 m/s, which is 1.15 m of clearance,
     * and a squeeze is barely three and a half metres tall. Without this the
     * player leaves the passage through the ceiling and is then outside the
     * containment test, at which point `inCave` drops to zero and the floor
     * clamp teleports them to the top of the mountain.
     *
     * Zeroing upward velocity as well as the position is what makes it read as
     * hitting your head rather than as sticking to the ceiling.
     */
    const head = s.ceiling - 0.28;
    if (this.position.y > head) {
      this.position.y = head;
      if (this.velocity.y > 0) this.velocity.y = 0;
    }
  }

  /** Write the base camera transform. The trip modifies it afterwards. */
  applyToCamera() {
    const c = this.camera;
    /**
     * The landing dip rides on `bobScale` exactly as the bob does.
     *
     * That slider is not a taste control — it is the accessibility answer to
     * motion sickness, and its promise is that at 0 the camera is PINNED to the
     * body. A vertical impulse the slider could not turn off would be the
     * largest single camera motion in the app and would break that promise on
     * the one gesture most likely to trigger the problem. Scaled here rather
     * than at the kick so a player who moves the slider mid-air gets the
     * setting they just chose.
     */
    c.position.set(
      this.position.x + this._bobX,
      this.position.y + this._bobY + this._landY * this.bobScale,
      this.position.z
    );
    c.rotation.set(0, 0, 0);
    c.rotateY(this.yaw);
    c.rotateX(this.pitch);
  }
}
