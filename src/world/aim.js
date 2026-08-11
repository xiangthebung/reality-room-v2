import { WATER_LEVEL, heightAt } from './terrain.js';

/**
 * The patch of ground you are looking at, and which way a thing standing there
 * should face.
 *
 * WHY THIS IS ITS OWN MODULE. It was a private function inside `net/index.js`,
 * which was the right place for it while a shared screen was the only object in
 * the world you could stand somewhere. The speakers are the second, and the
 * moment there were two callers the choice was between the net layer exporting a
 * piece of geography — the one thing its header is proud of not knowing — or the
 * march living where the ground does. It lives where the ground does.
 *
 * The bounds and the fallback are shared as well as the arithmetic, and that
 * matters more than the twenty lines: "how far in front of you may you put
 * something" is one rule about arms and eyesight, not a rule per object, and two
 * copies of it would drift the first time either was tuned.
 *
 * A MARCH AND A BISECTION RATHER THAN A RAYCAST. `THREE.Raycaster` against the
 * terrain would mean testing a few hundred thousand triangles of streamed mesh
 * to answer a question the height field answers in closed form — and it would
 * answer it about the MESH, which is only sampled where the current sector's
 * resolution happens to have put a vertex. `heightAt` is the same function the
 * body walks on, so what you put down stands on the floor you are standing on
 * rather than on a triangulation of it.
 *
 * Coarse march to bracket the crossing, six bisections to land on it: about
 * forty height samples for a keypress, against a per-frame budget that already
 * spends fourteen thousand of them at load.
 */

/**
 * How far in front of you a placement may land, in metres.
 *
 * The near bound is arm's length plus the object's own depth, so putting one
 * down never puts it inside your own head. The far bound is a placement you can
 * still see well enough to have meant — past fifteen metres you are aiming at a
 * patch of ground you cannot judge, and the honest gesture there is to walk over
 * and put it where you want it.
 */
const PLACE_MIN_M = 2.6;
const PLACE_MAX_M = 15;
/** Where it goes when the ray finds nothing — you are looking at the sky. */
const PLACE_FALLBACK_M = 5.5;
/** Marching step for the ground intersection. Fine enough not to skip a bank. */
const PLACE_STEP_M = 0.45;

/**
 * @param {{position: {x:number,y:number,z:number}, yaw: number, pitch: number}} controller
 *   the body, not the camera. A trip dollies the camera up to 1.35 m away from
 *   the person and swings it around them, and a screen that landed where the
 *   *camera* was looking would drift with an effect nobody associates with
 *   aiming.
 * @returns {{x: number, y: number, z: number, yaw: number}}
 */
export function aimGround(controller) {
  const eye = controller.position;
  const cp = Math.cos(controller.pitch);
  const dirX = -Math.sin(controller.yaw) * cp;
  const dirY = Math.sin(controller.pitch);
  const dirZ = -Math.cos(controller.yaw) * cp;

  /**
   * Clamped to the waterline like a screen's legs are, so something aimed at a
   * river stands on the surface rather than on the bed two metres under it.
   */
  const above = (t) => {
    const x = eye.x + dirX * t;
    const z = eye.z + dirZ * t;
    return eye.y + dirY * t - Math.max(heightAt(x, z), WATER_LEVEL);
  };

  let lo = PLACE_MIN_M;
  let hi = 0;
  for (let t = PLACE_MIN_M + PLACE_STEP_M; t <= PLACE_MAX_M; t += PLACE_STEP_M) {
    if (above(t) <= 0) {
      hi = t;
      break;
    }
    lo = t;
  }

  /**
   * No crossing means you are looking at the sky, or across a valley, and the
   * honest answer is not "as far away as the ray is allowed to go". Somebody
   * looking up and pressing the key means "put it down", so it goes down in
   * front of them.
   */
  let distance = PLACE_FALLBACK_M;
  if (hi) {
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      if (above(mid) > 0) lo = mid;
      else hi = mid;
    }
    distance = hi;
  }

  const x = eye.x + dirX * distance;
  const z = eye.z + dirZ * distance;
  return {
    x,
    y: Math.max(heightAt(x, z), WATER_LEVEL),
    z,
    /**
     * FACING YOU IS EXACTLY YOUR OWN YAW, which looks like a bug and is a
     * theorem. A `PlaneGeometry` under `rotation.y = r` faces world
     * `(sin r, cos r)`; the thing lands somewhere along your forward vector
     * `(-sin yaw, -cos yaw)`, so the direction from it back to you is
     * `(sin yaw, cos yaw)` — for every distance, on any terrain, because the
     * ray is straight in the horizontal plane whatever the ground does
     * underneath it. Computing `atan2` from the two positions gives the same
     * number and gives 0 when they coincide.
     *
     * A speaker cabinet is built facing its own +Z for exactly this reason, so
     * the same number aims it too.
     */
    yaw: controller.yaw,
  };
}
