import { WATER_LEVEL, heightAt } from './terrain.js';
import { caveFloorUnder, caveSample } from './caves.js';

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
 *
 *
 * AND UNDERGROUND IT IS A DIFFERENT MARCH, WHICH IS THE ONE THING THIS FILE
 * COULD NOT DO UNTIL NOW.
 *
 * Every placement gesture in the game refused underground — `placeSpeaker` in
 * main.js and all three ways a screen goes up in net/index.js each carried their
 * own `if (controller.roofed) return` and their own apology — because a march
 * against `heightAt` inside a hillside is a march against the SUMMIT. `above(t)`
 * is negative from the first sample, the bisection converges immediately, and
 * the object is stood on the mountainside thirty metres over your head, in
 * daylight, audible and unreachable. The refusals named what a real fix needed
 * and this is it, in three parts:
 *
 *   THE FLOOR IS `caveFloorUnder`, which is `groundUnder` bit for bit outside a
 *   passage and the passage's own floor inside one.
 *
 *   THERE IS NO WATERLINE. `WATER_LEVEL` is a fact about the river on the
 *   surface; there is no river under the mountain, and clamping to -3.4 m down
 *   here would float a speaker off any floor that happens to be cut below it.
 *
 *   THE RAY IS ALSO CONTAINED. This is the part that is not obvious. A ray
 *   aimed up the passage, at the ceiling, or across a chamber leaves the rock
 *   long before it meets a floor, and out there `caveFloorUnder` falls straight
 *   through to `groundUnder` — the summit again, the original bug wearing a
 *   different hat. So the march stops the instant the ray leaves the passage and
 *   the placement lands on the last point that was still inside it, which is
 *   "against the wall you were looking at". That single rule answers the ceiling
 *   case as well: looking up puts the thing on the floor a couple of metres in
 *   front of you rather than inside the roof.
 *
 * WHY IT BRANCHES ON `controller.roofed` AND NOT ON `inCave`. `roofed` is "there
 * is rock over my head" — `groundUnder - floor > 2.4 m`, computed by the body
 * from the same `caveSample` the movement uses. `inCave` is a containment RAMP:
 * it reads about 1 one metre inside a mouth and about 0.5 in the middle of a
 * chamber, so a threshold on it flips the whole march on and off while somebody
 * stands still. The same distinction `findInteractable` makes in main.js.
 *
 * The surface path is untouched and is meant to stay arithmetically identical:
 * `groundUnder` is a five-tap average and `Math.max(heightAt, WATER_LEVEL)` is
 * one sample with a clamp, so swapping one for the other outdoors is NOT a
 * no-op — it would move every screen and speaker already standing in the world
 * by a few centimetres. Hence a branch rather than a substitution.
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
 * How much air a standing object has to leave under the rock, in metres.
 *
 * The same 0.28 the body's own roof clamp keeps between the eye and the ceiling
 * — see the roof block in player/controller.js. It is a margin against the
 * analytic ceiling rather than a design allowance: the visible tube is swept
 * along the same centre line `caveSample` reads, but the rock shader displaces
 * it, so a screen whose top edge touched the number exactly would have its
 * corners in the ceiling on every second ring.
 */
const PLACE_ROOF_MARGIN_M = 0.28;

/**
 * How far above a floor the passage is asked ABOUT that floor, in metres.
 *
 * THIS IS A CONVENTION AND EVERYTHING HAS TO SHARE IT, which is why it is
 * exported rather than being a 1 in three files.
 *
 * `caveSample` picks the ring nearest the point it is given, in three
 * dimensions, so the answer depends on the height you ask from as well as the
 * xz. Where a passage bends or narrows, asking from the floor and asking from a
 * metre above it can land on different rings and come back with floors 40 cm
 * apart — which is invisible until two parts of one object ask from different
 * heights, and then it is a screen whose legs end well below the picture it is
 * holding up. (Measured: 0.389 m, on a 2.1 m ring six hundred metres into
 * grove-01's first cave.)
 *
 * A METRE, because that is roughly where a standing thing's mass is and because
 * it is the height the rest of the game already asks from — the body queries
 * from its eye, 1.68 m up, and the camera clamp in main.js from the same place.
 * A point ON a floor is the one height that cannot answer, being on the boundary
 * of the section rather than in it.
 */
export const STAND_PROBE_M = 1;

/**
 * The floor an object standing at `(x, z)` rests on, given the height it was
 * placed at.
 *
 * EXPORTED BECAUSE A PLACEMENT IS RESOLVED MORE THAN ONCE. `aimGround` answers
 * for the middle of the object, and then a screen's two legs each sample their
 * own patch of ground (see `_standLegs` in video-surface.js) — which on the
 * surface is the whole reason an easel sits on a hill instead of hovering over
 * it, and underground was the whole reason a screen stood in a passage grew a
 * pair of thirty-metre stilts reaching for the hillside. One function, so the
 * legs and the middle cannot disagree about which world they are in.
 *
 * `y` IS THE QUESTION, NOT A HINT. There are two floors at most of the map — the
 * hillside and whatever passage runs under it — and the only thing that
 * distinguishes them is where the asker is. A caller with no `y` at all is
 * asking about the surface by construction, and should call `groundUnder`.
 *
 * …BUT ONLY THE FIRST ANSWER DEPENDS ON IT, and that is what the loop is for.
 * See `STAND_PROBE_M`: `caveFloorUnder` gives slightly different floors when
 * asked from different heights, so a `y` that came from where a ray stopped and
 * a `y` that came from a leg's own arithmetic would disagree by a few
 * centimetres about one patch of rock. Re-asking from a fixed height above the
 * answer removes the caller's starting point from the result: whatever anybody
 * comes in with, they leave with the floor that answers "a metre above me is
 * this floor". Two iterations is what it takes on grove-01; the third is there
 * because a body standing exactly between two rings can oscillate rather than
 * settle, and one of two answers a centimetre apart is a perfectly good floor
 * while an unbounded loop is not.
 */
export function standingFloor(x, z, y) {
  /**
   * The containment test, not `controller.roofed`, and this is the one place the
   * two questions differ. The body's flag is about the BODY; this is asked about
   * a point several metres in front of it, and about placements that arrived
   * over the network from somebody standing somewhere else entirely. What
   * matters here is whether that point is in a passage.
   *
   * `.inside` is copied out before anything else is called: `caveSample` returns
   * one shared scratch object and `caveFloorUnder` samples again on its own.
   */
  const inside = caveSample(x, y, z).inside;
  /**
   * Clamped to the waterline like a screen's legs are, so something aimed at a
   * river stands on the surface rather than on the bed two metres under it.
   */
  if (inside <= 0) return Math.max(heightAt(x, z), WATER_LEVEL);

  let floor = caveFloorUnder(x, z, y);
  for (let i = 0; i < 3; i++) {
    const settled = caveFloorUnder(x, z, floor + STAND_PROBE_M);
    if (Math.abs(settled - floor) < 0.01) break;
    floor = settled;
  }
  return floor;
}

/**
 * @param {{position: {x:number,y:number,z:number}, yaw: number, pitch: number,
 *          roofed?: boolean}} controller
 *   the body, not the camera. A trip dollies the camera up to 1.35 m away from
 *   the person and swings it around them, and a screen that landed where the
 *   *camera* was looking would drift with an effect nobody associates with
 *   aiming.
 * @returns {{x: number, y: number, z: number, yaw: number, headroom: number}}
 *   `headroom` is how tall a thing may stand on that spot before its top is in
 *   the rock, and it is `Infinity` everywhere the sky is the ceiling — which is
 *   the whole surface. Added as a field rather than as a second return value or
 *   a thrown refusal so that every existing caller keeps working untouched: a
 *   caller that does not care about roofs never mentions it, and one that does
 *   compares it against its own object's height and says so in the HUD.
 */
export function aimGround(controller) {
  const eye = controller.position;
  const cp = Math.cos(controller.pitch);
  const dirX = -Math.sin(controller.yaw) * cp;
  const dirY = Math.sin(controller.pitch);
  const dirZ = -Math.cos(controller.yaw) * cp;
  const roofed = controller.roofed === true;

  const above = (t) => {
    const x = eye.x + dirX * t;
    const z = eye.z + dirZ * t;
    const y = eye.y + dirY * t;
    return y - (roofed ? caveFloorUnder(x, z, y) : Math.max(heightAt(x, z), WATER_LEVEL));
  };

  /** Is the ray still in the rock at `t`? Only ever asked underground. */
  const contained = (t) =>
    caveSample(eye.x + dirX * t, eye.y + dirY * t, eye.z + dirZ * t).inside > 0;

  let lo = PLACE_MIN_M;
  let hi = 0;
  /**
   * The furthest sample PROVED to be still inside the passage, and the reason
   * the loop below is not just the surface loop with a different predicate.
   *
   * SEEDED BY SEARCHING BACKWARDS FROM THE NEAR BOUND, WHICH IS NOT DEFENSIVE
   * PROGRAMMING — IT IS THE ORIGINAL BUG, SURVIVING AT SHORT RANGE.
   *
   * This was `= PLACE_MIN_M`, on the reasoning that the body is in the passage
   * so 2.6 m in front of it must be too, and the worst case was an object
   * standing where you are. Both halves are false in a 2 m passage: face a wall
   * closer than arm's length and the first coarse sample is already in rock, the
   * march breaks out immediately, and the placement is pinned to a point NOBODY
   * EVER TESTED. `standingFloor` then finds no passage there and falls through
   * to the surface — so the screen goes on the mountainside overhead, which is
   * exactly the failure this whole file exists to remove, hiding in the one case
   * that only happens in a tight passage. Caught by `cave-present.mjs` on the
   * narrowest ring of grove-01's first cave, as a screen with 0 m of rock over
   * it and a body 50 m under the hill.
   *
   * Six samples, at most, and only underground: a real answer exists because
   * `t = 0` is the body's own position and the body is in the passage by
   * construction. Down there "as near as arm's length" is a wall, and putting it
   * at your feet is what a person does when they cannot step back.
   */
  let lastInside = PLACE_MIN_M;
  if (roofed) {
    // 0 is the body's own feet, and it is the answer when even the near bound
    // is in rock. It is a real placement rather than a giving-up value.
    lastInside = 0;
    for (let t = PLACE_MIN_M; t > 0; t -= PLACE_STEP_M) {
      if (contained(t)) {
        lastInside = t;
        break;
      }
    }
  }
  let escaped = false;
  for (let t = PLACE_MIN_M + PLACE_STEP_M; t <= PLACE_MAX_M; t += PLACE_STEP_M) {
    if (roofed) {
      if (!contained(t)) {
        escaped = true;
        break;
      }
      lastInside = t;
    }
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
   *
   * Underground there is a third answer between those two: the ray left through
   * a wall or the roof without ever meeting a floor, and the place it meant is
   * the last point that was still in the passage. Note that the fallback is
   * clamped by the same number — a ceiling two metres over your head is nearer
   * than the 5.5 m "in front of them" would put it, and unclamped that is a
   * screen inside the roof.
   */
  let distance = PLACE_FALLBACK_M;
  if (hi) {
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      if (above(mid) > 0) lo = mid;
      else hi = mid;
    }
    distance = hi;
  } else if (escaped) {
    distance = lastInside;
  }
  if (roofed) distance = Math.min(distance, lastInside);

  const x = eye.x + dirX * distance;
  const z = eye.z + dirZ * distance;
  /**
   * The ray's own height where it stopped, which is what tells `caveFloorUnder`
   * which of the two floors at this xz was meant. In the crossing case it is
   * already within a bisection of the floor; in the other two it is somewhere in
   * the passage's air, which is the same answer.
   */
  const rayY = eye.y + dirY * distance;
  /**
   * `standingFloor` UNDERGROUND AND THE BARE EXPRESSION OUTDOORS, which looks
   * redundant — the function's own surface branch is that same expression — and
   * is not. The march above chose its floor from `controller.roofed`, and this
   * has to agree with the march or the object lands somewhere the ray never
   * went. `standingFloor` decides from CONTAINMENT, which is a different
   * question and gives a different answer in exactly one place: a body standing
   * on a hillside, not roofed, aiming at a patch of ground with a shallow
   * passage under it. There the march found the hillside and containment would
   * find the passage, and a screen would drop through the ground it was aimed at.
   *
   * Underground the two agree by construction, because the march clamped the
   * distance to a point it had already proved was inside — and `standingFloor`
   * is what settles the answer so the legs and the headroom read the same floor.
   * See its own note.
   */
  const y = roofed ? standingFloor(x, z, rayY) : Math.max(heightAt(x, z), WATER_LEVEL);

  return {
    x,
    y,
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
    headroom: roofed ? headroomAt(x, y, z) : Infinity,
  };
}

/**
 * How tall a thing may stand at a resolved spot, in metres.
 *
 * A SHARE SCREEN IS OVER THREE METRES TALL at its default width, which is taller
 * than a good many passages — so "can it go here" is a real question with a real
 * "no" in it, and the alternative to asking is a picture buried to its eyebrows
 * in rock with nothing to tell the player why. The callers turn the number into
 * a refusal and a line of HUD text; this only measures.
 *
 * `Infinity` when the probe says there is no passage here, which is not a
 * fallback so much as the truth: `y` came back from the surface branch, the
 * ceiling is the sky, and no object in this game is tall enough to reach it.
 */
function headroomAt(x, y, z) {
  const s = caveSample(x, y + STAND_PROBE_M, z);
  if (s.inside <= 0) return Infinity;
  return Math.max(0, s.ceiling - y - PLACE_ROOF_MARGIN_M);
}
