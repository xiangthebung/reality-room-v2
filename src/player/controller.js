import * as THREE from 'three';
import { clamp, clamp01, damp } from '../core/util.js';
import { modalHasKeyboard, worldHearsKey } from '../core/keys.js';
import { confine, groundUnder, normalAt } from '../world/terrain.js';
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
    this._stepAccum = 0;
    this.onStep = null;
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
    const running = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const target = _moveTarget.set(0, 0, 0);
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
      return;
    }

    if (this.onGround && keys.has('Space')) {
      this.velocity.y = JUMP;
      this.onGround = false;
    }
    this.velocity.y -= GRAVITY * dt;

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

    // Footsteps, driven by the same phase so the sound lands on the low point.
    if (this.onGround && this.speed > 0.7) {
      this._stepAccum += dt * this.speed * 0.52;
      if (this._stepAccum >= 1) {
        this._stepAccum -= 1;
        this.onStep?.(Math.min(1, this.speed / RUN));
      }
    } else {
      this._stepAccum = 0.55;
    }
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
    c.position.set(
      this.position.x + this._bobX,
      this.position.y + this._bobY,
      this.position.z
    );
    c.rotation.set(0, 0, 0);
    c.rotateY(this.yaw);
    c.rotateX(this.pitch);
  }
}
