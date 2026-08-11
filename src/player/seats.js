import * as THREE from 'three';
import { clamp, wrapAngle } from '../core/util.js';

/**
 * Somewhere to sit down.
 *
 * THE ARGUMENT FOR THIS EXISTING AT ALL. Everything else in this project is
 * about a body moving through a wood, and sitting is the opposite of moving —
 * so on the face of it it is a feature that turns the game off. That is exactly
 * what it is for. A conversation between people who are all still walking never
 * settles: somebody drifts, somebody follows, and the group spends the whole
 * evening reforming. Give the same people a ring of logs round a fire and they
 * stop, face each other, and talk for an hour. The mechanic is the furniture.
 *
 * WHAT A SEAT IS. A position, a facing, and optionally a thing it is bolted to
 * that might be moving (the ferry's benches are seats on a raft that is drifting
 * down a river). It is NOT a state machine and it does NOT own the player —
 * `Controller` keeps its own authority over the body, and this module hands it a
 * target and a constraint.
 *
 * OCCUPANCY IS DELIBERATELY LOCAL AND UNSYNCHRONISED. Two people can sit in the
 * same spot, and their avatars will interpenetrate for as long as they both find
 * that funny. The alternative is a reservation protocol — a claim, an ack, a
 * timeout for the claim of somebody whose connection dropped — for a problem
 * that resolves itself socially in about one second. Every part of that protocol
 * is a way for a seat to become unusable because a machine somewhere thinks it
 * is taken.
 */

/** How close you have to be for a seat to offer itself. */
export const SEAT_REACH = 2.3;

/**
 * How far you may turn while seated, either way from the seat's facing.
 *
 * A hundred and ten degrees, which is roughly what a person can do with their
 * neck and a shoulder twist. The constraint is not there to be a rule — it is
 * there because a body that pivots 360° on a bench looks like a mounted turret,
 * and because being unable to see behind you is most of what makes sitting down
 * feel like a commitment rather than a pose.
 *
 * It applies to the YAW ONLY. Pitch is left completely free: looking up at the
 * canopy from a log is one of the better things you can do here.
 */
const YAW_ARC = 1.92;

/** Eye height sitting, measured from the seat surface. */
const SEATED_EYE = 0.86;

export class Seat {
  /**
   * @param {object} spec
   * @param {THREE.Vector3|{x:number,y:number,z:number}} spec.position seat surface
   * @param {number} spec.yaw the direction a person sitting here faces
   * @param {string} [spec.kind] 'bench' | 'log' | 'deck' — labels the prompt
   * @param {THREE.Object3D} [spec.parent] a moving thing this is bolted to
   * @param {string} [spec.label] what to call the place, for the prompt
   */
  constructor({ position, yaw, kind = 'bench', parent = null, label = null }) {
    this.local = new THREE.Vector3(position.x, position.y, position.z);
    this.localYaw = yaw;
    this.kind = kind;
    this.parent = parent;
    this.label = label;

    /** World-space, recomputed each frame only when there is a parent. */
    this.position = this.local.clone();
    this.yaw = yaw;
  }

  /**
   * Resolve where this seat actually is.
   *
   * A seat with no parent is at its own coordinates and this is a copy; a seat
   * on the ferry is wherever the raft has drifted to. Called once a frame for
   * moving seats and never for still ones, which is why the two cases are one
   * class rather than two.
   */
  resolve() {
    if (!this.parent) return this;
    this.position.copy(this.local).applyMatrix4(this.parent.matrixWorld);
    this.yaw = this.localYaw + (this.parent.rotation?.y ?? 0);
    return this;
  }
}

export class SeatRegistry {
  constructor() {
    /** @type {Seat[]} */
    this.seats = [];
    /** @type {Seat|null} */
    this.occupied = null;
    this._moving = [];
  }

  /** @param {Seat|Seat[]} seat */
  add(seat) {
    for (const s of Array.isArray(seat) ? seat : [seat]) {
      this.seats.push(s);
      if (s.parent) this._moving.push(s);
    }
    return seat;
  }

  /**
   * The nearest seat you could sit on, or null.
   *
   * A linear scan, and it stays a linear scan: there are a few dozen seats in
   * the whole world and this runs once a frame beside a collision query that
   * already visits a similar number of trunks. A spatial index here would be
   * more code than the thing it indexes.
   */
  nearest(x, z, reach = SEAT_REACH) {
    let best = null;
    let bestD = reach;
    for (const seat of this.seats) {
      if (seat === this.occupied) continue;
      const p = seat.parent ? seat.resolve().position : seat.position;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bestD) {
        bestD = d;
        best = seat;
      }
    }
    return best;
  }

  /** Moving seats have to be re-resolved before anyone asks where they are. */
  update() {
    for (const seat of this._moving) seat.resolve();
  }
}

/**
 * Park a body on a seat, and let it off again.
 *
 * Deliberately a small object that TALKS TO the controller rather than a mode
 * inside it. `controller.update` is the hottest function in the app and it is
 * already carrying the height field, the trunk collisions, the cave walls and
 * the head bob; a seated branch in there would be a fifth thing to reason about
 * in the one function that must never be subtly wrong. This writes the body's
 * position after the controller has finished with it, which is the same
 * relationship the trip director already has with the camera.
 */
export class Sitting {
  /**
   * @param {import('./controller.js').Controller} controller
   * @param {SeatRegistry} registry
   */
  constructor(controller, registry) {
    this.controller = controller;
    this.registry = registry;
    /** @type {Seat|null} */
    this.seat = null;
    this._enterYaw = 0;
    /** Eased 0..1, so standing up is a rise rather than a teleport. */
    this.blend = 0;
  }

  get seated() {
    return this.seat !== null;
  }

  sit(seat) {
    if (!seat) return false;
    this.seat = seat;
    this.registry.occupied = seat;
    seat.resolve();
    this._enterYaw = seat.yaw;
    /**
     * Turn to face the way the seat faces, but only if you are not already
     * looking somewhere sensible.
     *
     * Snapping the view is disorienting and there is rarely a reason for it —
     * somebody who walks up to a bench is usually already looking at the fire it
     * faces. So the yaw is only pulled if it is outside the arc it is about to
     * be confined to, and then only to the edge of that arc rather than to the
     * centre, which is the smallest correction that makes the constraint true.
     */
    const offset = wrapAngle(this.controller.yaw - seat.yaw);
    if (Math.abs(offset) > YAW_ARC) {
      this.controller.yaw = seat.yaw + Math.sign(offset) * YAW_ARC;
    }
    this.controller.velocity.set(0, 0, 0);
    return true;
  }

  stand() {
    if (!this.seat) return false;
    /**
     * Step FORWARD out of the seat, not up out of it.
     *
     * Standing in place leaves the body inside the bench, which the collision
     * pass then resolves by shoving the player sideways at whatever angle the
     * geometry happens to suggest. Half a metre along the seat's own facing is
     * where a person's feet already are.
     */
    const seat = this.seat;
    this.controller.position.x = seat.position.x - Math.sin(seat.yaw) * 0.55;
    this.controller.position.z = seat.position.z - Math.cos(seat.yaw) * 0.55;
    this.seat = null;
    this.registry.occupied = null;
    return true;
  }

  /**
   * Hold the body on the seat.
   *
   * Runs AFTER `controller.update`, which has already applied gravity, walked
   * the body downhill and resolved it out of every trunk within two metres. All
   * of that is thrown away here, on purpose: the seat is the more specific
   * constraint, in exactly the way the cave walls are more specific than the
   * height field. Doing it this way round rather than by disabling the
   * controller means the frame in which you stand up needs no special case — the
   * body simply resumes being wherever the controller last put it.
   */
  update(dt) {
    const seat = this.seat;
    this.blend += ((seat ? 1 : 0) - this.blend) * Math.min(1, dt * 7);
    if (!seat) return;

    seat.resolve();

    /**
     * Any movement key stands you up.
     *
     * There is no "press E to stand": pushing forward is what a person does when
     * they want to leave, and making them find the right key first is the kind
     * of friction that makes people not sit down in the first place. Jump does
     * it too, which is what a player will try when nothing else works.
     */
    const keys = this.controller.keys;
    if (
      keys.has('KeyW') || keys.has('KeyS') || keys.has('KeyA') || keys.has('KeyD') ||
      keys.has('ArrowUp') || keys.has('ArrowDown') || keys.has('ArrowLeft') || keys.has('ArrowRight') ||
      keys.has('Space')
    ) {
      this.stand();
      return;
    }

    const c = this.controller;
    /**
     * Eased toward the seat rather than assigned to it.
     *
     * Sitting down is a body lowering itself, which takes about a third of a
     * second, and a teleport into the seat is the single clearest way to make
     * furniture feel like a menu. On a moving seat this also does the work of
     * following: the raft slides a few centimetres a frame and the body chases
     * it with a lag small enough to be a suspension.
     */
    const k = Math.min(1, dt * 12);
    c.position.x += (seat.position.x - c.position.x) * k;
    c.position.z += (seat.position.z - c.position.z) * k;
    c.position.y += (seat.position.y + SEATED_EYE - c.position.y) * k;
    c.velocity.set(0, 0, 0);
    c.onGround = true;
    /** The walk cycle must not run while the legs are folded. */
    c.speed = 0;

    // The arc. Pitch is untouched — see YAW_ARC.
    const offset = wrapAngle(c.yaw - seat.yaw);
    if (Math.abs(offset) > YAW_ARC) {
      c.yaw = seat.yaw + clamp(offset, -YAW_ARC, YAW_ARC);
    }
  }
}
