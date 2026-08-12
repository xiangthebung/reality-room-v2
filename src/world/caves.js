import * as THREE from 'three';
import { clamp, clamp01, fbm2, lerp, makeRng, noise2, rngRange, smoothstep, TAU } from '../core/util.js';
import { caveAxisPoint, cavesNear, getWorldSeed, groundUnder, heightAt } from './terrain.js';
import { NOISE3, tripUniforms } from '../trip/living.js';
import { glowSprite } from './textures.js';

/**
 * The underground.
 *
 * `terrain.js` carves the gully; this builds everything from the head of it
 * inward — the passage itself, the rock that roofs it, the light in it, and the
 * answers to "where is the floor" and "where is the ceiling" that the body walks
 * on. Read the CAVES block in terrain.js first; the two halves only make sense
 * together.
 *
 *
 * WHY A SWEPT TUBE AND NOT A VOLUME.
 *
 * The obvious representation for a cave is a signed distance field marched into
 * geometry, because that is the only one that unifies with the terrain — one
 * field, one surface, no seam anywhere by construction. It was rejected, and not
 * on grounds of effort:
 *
 *   THE TERRAIN IS NOT A VOLUME AND CANNOT CHEAPLY BE MADE ONE. `heightAt` is a
 *   height, sampled by everything in the world — the scatter, the collider, the
 *   worker, the motes. Marching cubes needs the ground as an SDF, which for a
 *   height field means `y - heightAt(x, z)`, and that is only a true distance
 *   near flat ground; on the flank the error is the slope, which is exactly
 *   where every cave in this world is. Fixing it means iterating, per voxel.
 *
 *   IT COSTS AT LEAST TWO ORDERS OF MAGNITUDE MORE. A 200 m passage at a 0.6 m
 *   voxel is ~3 M cells against the 3 600 vertices this emits. Even culled to a
 *   shell that is minutes of CPU, in a project whose entire ground streamer is
 *   built around never spending more than 6 ms in one place.
 *
 *   AND THE FRAME IS THE POINT. The measured budget is 3.55-4.94 ms with 159
 *   draws and 14.02 M triangles. A cave is one draw and 7 200 triangles: 0.05%
 *   of the triangles, and it is the only opaque thing on screen while you are in
 *   it. A representation that cost a hundred times more would buy nothing the
 *   player can see, because what a cave has to do is be dark, be enclosed, and
 *   have a floor you can trust.
 *
 * A tube also has a property an SDF does not: its centre line IS the collision
 * geometry. `caveSample` below answers floor, ceiling and wall from the same
 * polyline the mesh was swept along, so there is no second representation to
 * drift out of sync — the same argument terrain.js makes for having no collision
 * mesh.
 *
 *
 * THE MOUTH, WHICH IS WHERE THIS IS WON OR LOST.
 *
 * A height field surface is opaque and has nothing behind it, so at the mouth it
 * can only be ABOVE the tube (in which case it hides the entrance and you walk
 * up the hill instead of into it) or BELOW it (in which case there is no rock
 * over the doorway and the tube is a pipe lying in a ditch). There is no
 * position where it is "around" the hole. That is the same "a height field
 * cannot have a roof" problem, at the one place it is unavoidable.
 *
 * So the terrain hands over, over about six metres, and the tube's own geometry
 * carries the rock for that stretch:
 *
 *   The gully floor is the tunnel floor. The first rings are placed ON
 *   `heightAt` — the notch's own carved floor — so walking in is walking, not a
 *   step or a trigger. Nothing about the transition is scripted.
 *
 *   The hood. Where the tube is not yet buried, it is emitted TWICE: the cavity
 *   surface facing in, and an outer shell 1.6 m outside it facing out, joined at
 *   the rim. That is the rock lip you stand under. Every outer vertex is then
 *   pushed below `heightAt` wherever the hillside is higher, so the shell does
 *   not emerge from the ground anywhere — the join between the built rock and
 *   the grown rock happens inside the hill, where nobody can see it.
 *
 *   And it stops as soon as it can. `_exposed` walks the rings and finds the
 *   first one the hillside already covers by half a metre; the hood spans only
 *   up to there, which on a normal flank is four to seven rings. Past it the
 *   mountain is the roof and the tube is invisible from outside — it is drawn
 *   single-sided with inward normals, so from the hillside above there is
 *   nothing there at all.
 *
 *
 * LIGHT, WITHOUT A SECOND SHADOW PASS.
 *
 * One shadow map re-render is 3.2-4.5 ms on a 2.2-2.8 ms frame, so a cave that
 * added a shadow-casting light would cost more than the whole rest of the frame.
 * Nothing here touches `scene`'s lights at all. The rock is a ShaderMaterial
 * that does its own lighting, from three sources and in this order of
 * importance:
 *
 *   THE FUNGI, and they are real objects at real positions — the rule
 *   atmosphere.js opens with. Each cluster is a point of coloured light, and
 *   its contribution to every vertex is computed ON THE CPU AT BUILD TIME and
 *   baked into the vertex colour. They do not move, the geometry does not move,
 *   so per-frame this is free: no light uniforms, no loop in the shader, no
 *   limit on how many there are. Thirty clusters cost exactly what none do.
 *
 *   DAYLIGHT FROM THE MOUTH, as a per-vertex attribute of distance along the
 *   passage. It stays a uniform-multiplied attribute rather than being baked
 *   because it is the one term that has to move: it is what makes the mouth
 *   read as an exit from thirty metres in, and the trip pushes it into HDR so
 *   the opening blooms.
 *
 *   A NEAR-FIELD TERM, small, so the floor at your feet is not black. Framed
 *   honestly in the shader as dark adaptation rather than as a torch nobody is
 *   carrying.
 *
 *
 * COST WHEN YOU ARE NOT IN ONE.
 *
 * Nothing. `CaveField.update` keeps meshes only for caves within BUILD_RANGE,
 * and the ridge puts one every 210 m, so the usual state is zero meshes, zero
 * draws, an empty `live` list and a single `length` test in `caveFloorUnder`.
 * The notch in the height field is the only thing that exists everywhere, and
 * that is four instructions — see terrain.js.
 */

/* -------------------------------------------------------------------------- */
/*  the passage                                                               */
/* -------------------------------------------------------------------------- */

/** Metres between ring centres. Also the resolution of the collision line. */
const RING_STEP = 1.15;
/**
 * Vertices around a ring. 24 puts a facet at 15 degrees, which noise hides.
 *
 * It was 20, and the extra four are spent entirely on the keyhole: a section
 * whose lower half closes to a slot needs enough vertices below the waist to
 * describe the slot, and at 20 there were three of them — a triangular notch
 * rather than a cut. The cost is 20% more triangles on a mesh that is 0.13% of
 * the frame's.
 */
const RADIAL = 24;
/**
 * How much rock there must always be between the ceiling and the sky.
 *
 * Not an aesthetic margin — it is what makes the containment test in
 * `caveSample` sound. That test is purely "am I inside the tube", with no
 * reference to the terrain at all, which is what lets the mouth work (at the
 * mouth the tube IS at ground level, so any test involving the surface would
 * fail there). The price is that a player standing on the hillside directly over
 * a shallow passage must be further from the centre line than the tube's own
 * radius, or they would be reported as inside a cave they are standing on top
 * of. 4.2 m of rock plus the ceiling puts the walker at least 5.9 m out against
 * a containment radius of 1.1 x the tube's, which fails for every radius this
 * generates.
 */
const ROOF_ROCK = 4.2;
/**
 * Cross-section: half-width, half-height and floor, as multiples of radius.
 *
 * THESE ARE NOW THE MOUTH'S SHAPE AND NOT THE PASSAGE'S. Every ring carries its
 * own `w`, `t` and `f` (see SHAPES), and the first few rings are pinned to these
 * three numbers so the doorway, the hood and the gully seam are bit-identical to
 * what they were before the passage learned to change shape — that seam is the
 * hardest-won thing in this file and nothing below is worth reopening it for.
 */
const SEC_WIDE = 1.3;
const SEC_TALL = 0.98;
const SEC_FLOOR = 0.52;
/** Rock displacement, in metres per metre of radius, on the walls. */
const ROUGH = 0.235;

/* -------------------------------------------------------------------------- *
 *  WHAT SHAPE A PASSAGE IS, WHICH IS THE WHOLE OF WHY A CAVE IS INTERESTING
 * -------------------------------------------------------------------------- *
 *
 * One swept ellipse of constant proportions is a corridor. It does not matter
 * how well it is lit or how rough its walls are: if the cross-section never
 * changes, every metre of it carries the same information as the last and the
 * player stops looking after thirty seconds. That was the honest failure of the
 * first cave, and no amount of decoration fixes it, because decoration is what
 * you notice AFTER the space has told you something.
 *
 * A real passage is a cast of the water that made it, and there are only a
 * handful of ways water makes a hole in limestone. Each one has a signature
 * cross-section, and a caver reads the section the way you read a hallway:
 *
 *   TUBE      Phreatic — cut underwater, under pressure, so the water was
 *             touching the whole perimeter and dissolved it evenly. Round,
 *             smooth, and the only one that carries scallops.
 *   CANYON    Vadose — a free-surface stream cutting down. Tall, narrow,
 *             meandering; you walk with your shoulders turned.
 *   KEYHOLE   Both, in order: a tube that went dry when the water table fell,
 *             with a slot incised beneath it. Cross-section as history.
 *   BEDDING   Water spreading sideways between two limestone beds. Wide, low,
 *             floor and ceiling near parallel, and it runs away into the dark
 *             on both sides where your light does not reach.
 *   ROOM      Breakdown — the ceiling failed. Big, and the floor is blocks.
 *
 * The shapes are per NODE, so a change takes the 8-14 m the spline needs to get
 * from one to the other, which is about the distance over which a real passage
 * changes character. Nothing switches; the tube narrows and heightens and you
 * are in a canyon before you noticed leaving the tube.
 *
 * `key` is the slot, `scal` is how strongly the walls are scalloped, `seep` is
 * how much flowstone runs down them, and `rough` is the displacement amplitude —
 * a phreatic tube is polished and a breakdown room is not.
 */
const SHAPES = {
  tube: { w: 1.16, t: 1.02, f: 0.46, key: 0, rough: 0.15, scal: 1, seep: 0.35, lo: 2.6, hi: 4.2 },
  canyon: { w: 0.60, t: 1.62, f: 0.74, key: 0, rough: 0.28, scal: 0.15, seep: 0.8, lo: 2.4, hi: 3.4 },
  keyhole: { w: 1.10, t: 1.10, f: 0.96, key: 1, rough: 0.19, scal: 0.7, seep: 0.5, lo: 2.9, hi: 4.1 },
  bedding: { w: 1.95, t: 0.44, f: 0.30, key: 0, rough: 0.21, scal: 0.45, seep: 0.25, lo: 3.4, hi: 5.2 },
  room: { w: 1.42, t: 1.18, f: 0.62, key: 0, rough: 0.36, scal: 0.1, seep: 1, lo: 6.5, hi: 11 },
};
/** The mouth, pinned to the old constants. See SEC_WIDE. */
const MOUTH_SHAPE = { w: SEC_WIDE, t: SEC_TALL, f: SEC_FLOOR, key: 0, rough: ROUGH, scal: 0.5, seep: 0.3 };

/**
 * Floor to ceiling, in metres, that every ring is guaranteed.
 *
 * The body is 1.68 m to the eye and the roof clamp in `controller.js` holds it
 * 0.28 m under the ceiling, so anything under 1.96 m is a ring the player is
 * pushed up by the floor and down by the roof on the same frame — stuck, in a
 * place they cannot see well enough to understand why. 2.15 leaves a fifth of a
 * metre over that, and it is applied by raising `t` rather than by raising `r`,
 * because raising the radius would widen a squeeze that is narrow on purpose.
 *
 * This is what stops BEDDING from being a crawl in the literal sense. There is
 * no crouch in this game, so a passage you would really have to lie down in is a
 * wall with extra steps; what the shape buys instead is a ceiling close over
 * your head and a floor running away sideways past both edges of your light,
 * which is what a bedding plane actually feels like to be in.
 */
const MIN_HEAD = 2.15;
/** …and the narrowest a squeeze may be across, for the same reason. */
const MIN_HALF = 0.78;

/** The channels a node carries besides its position and radius. */
const CHANNELS = ['r', 'w', 't', 'f', 'key', 'rough', 'scal', 'seep'];

/** A centre-line node wearing one of the SHAPES, with per-node jitter. */
function shaped(x, y, z, r, sh, rng = null) {
  const j = rng ? (lo, hi) => rngRange(rng, lo, hi) : () => 1;
  return {
    x,
    y,
    z,
    r,
    w: sh.w * j(0.9, 1.12),
    t: sh.t * j(0.92, 1.1),
    f: sh.f * j(0.9, 1.1),
    key: sh.key,
    rough: sh.rough * j(0.85, 1.2),
    scal: sh.scal,
    seep: sh.seep * j(0.4, 1.5),
  };
}
/**
 * …and on the floor, where it is nearly nothing.
 *
 * The floor the body stands on is the analytic one — `caveSample` reads the
 * centre line, not the mesh, exactly as the player walks on `heightAt` and not
 * on the ground mesh. Displacing the visible floor by half a metre while the
 * walkable floor stayed flat would put the player's feet inside rock on one step
 * and in the air on the next. Two centimetres is texture; anything more is a
 * lie about where the ground is.
 */
const ROUGH_FLOOR = 0.018;

/**
 * Thickness of the hood's rock shell at the rim, in metres.
 *
 * 3.4 rather than something subtle, because this is the only part of a cave you
 * ever see from outside and a thin lip reads as sheet metal. It tapers linearly
 * to nothing at the last hooded ring, where the shell closes onto the tube and
 * the hillside has taken over.
 */
const HOOD_THICK = 3.4;

/* -------------------------------------------------------------------------- *
 *  THE CRAG — WHY THE MOUTH STANDS OUT OF THE HILL RATHER THAN IN IT
 * -------------------------------------------------------------------------- *
 *
 * Everything above this line describes a cave that is careful never to be seen.
 * The hood exists only to carry rock over the doorway, every one of its vertices
 * is pushed BELOW `heightAt` so the built rock meets the grown rock inside the
 * hill, and past the fourth or fifth ring the mountain takes over and the tube
 * is invisible from outside. That is a beautiful seam and it has one cost: from
 * anywhere but inside the gully there is nothing to see, so a cave is something
 * you find by walking into it.
 *
 * These three constants buy the opposite property — a rock mass at the entrance
 * that is visible against the hillside from a distance — without giving up the
 * seam, because they change only how far the shell is ALLOWED to rise, not what
 * it is joined to. Buried and proud are the same surface; the burial clamp is
 * simply given an allowance that fades out along the hood.
 *
 * The one thing this must not become is the culvert failure `buildNodes` opens
 * with: a length of tube lying in the open reads as pipe, not cave. What keeps
 * it on the right side of that line is that none of it is PASSAGE. The flare is
 * a collar barely deeper than the shell is thick, the crag fades to nothing over
 * the hood's own length, and the cavity behind it still starts exactly where the
 * hillside can roof it.
 *
 * And it is only half the answer. The other half is terrain: `caveKnoll` in
 * terrain.js stands a tor over the mouth, which is what a player sees from
 * outside the gully — this is what they see once they are in it.
 */

/**
 * How far the shell may stand above the hillside at the rim, in metres.
 *
 * Squared taper along the hood, so this is a lump of rock around the doorway
 * rather than a ridge running up the hill — by the fourth ring it is under a
 * metre and by the last it is zero, which is where the old buried behaviour
 * resumes exactly.
 *
 * It is also modulated by the same `rock` field that displaces the walls, so
 * what emerges is lopsided and lumpy. An unmodulated allowance produces a
 * perfectly even collar, which reads as masonry — a built arch rather than a
 * hole in a mountain.
 */
const HOOD_PROUD = 5;

/**
 * How far the outermost shell ring is pushed back out of the mouth, in metres.
 *
 * Along the tube's own tangent, so the rim strip that joins the cavity to the
 * shell stops being a flat washer at the mouth plane and becomes a collar with
 * depth — the overhang you stand under, seen from the front. Squared taper
 * again: only the first two or three rings step out at all.
 *
 * SMALL, AND IT WAS TWICE THIS. At 2.4 m the collar stands clear of the
 * hillside all the way round the doorway, and a ring of rock standing in front
 * of a hole with daylight round the outside of it is an inner tube: you read the
 * ring, not the opening. The mass belongs ABOVE the entrance, which is what
 * HOOD_PROUD spends it on — the burial clamp only lets rock rise where there is
 * hillside over the cavity, so it cannot pile up in the doorway.
 */
const HOOD_FLARE = 1.2;

/**
 * Extra thickness on the shell's upward-facing half, as a fraction of `thick`.
 *
 * The brow. A uniform collar puts as much rock under the doorway as over it,
 * and the rock under it is the part nobody can see — it is inside the hillside
 * the gully is cut into. Weighting it upward spends the geometry where the
 * overhang is, which is the silhouette that says "cave" from two hundred
 * metres.
 */
const HOOD_BROW = 0.9;

/**
 * Hooded rings: the minimum, and how many past where the hillside takes over.
 *
 * `exposedRings` finds the first ring the hill already covers, which is what the
 * burial seam needs and nothing more. The crag needs a few rings beyond it, or
 * the proud rock has no length to fade over and stops dead against the terrain
 * at the ring where the hood ends.
 */
const HOOD_MIN = 6;
const HOOD_EXTRA = 5;

/**
 * A cave's centre line.
 *
 * Nodes first — a coarse walk of 8-14 m steps with the heading and pitch drawn
 * per step — then resampled by Catmull-Rom into rings. Doing it in two stages is
 * what makes the shape controllable: the constraints (stay under the mountain,
 * do not cross yourself, do not climb) are checked once per node against real
 * `heightAt` samples, and the spline then guarantees the result is smooth
 * whatever the constraints did to it.
 */
function buildNodes(c) {
  const rng = makeRng(`${getWorldSeed()}:cave-path:${c.k}`);
  const nodes = [];

  /**
   * WHERE THE TUBE STARTS, WHICH IS NOT WHERE THE GULLY STARTS.
   *
   * The first attempt began the tube fourteen metres down the notch and it was
   * the pipe-in-a-ditch failure in its purest form: a five-metre-tall tube lying
   * in an eight-metre gully has two metres of itself in open air for its whole
   * length, and no amount of rock shell makes twenty-four metres of exposed
   * culvert read as a cave. The gully is the APPROACH — open sky, a stream bed
   * of a path, walls climbing on both sides — and the tube must not appear until
   * the hillside is within a few metres of being able to roof it.
   *
   * So walk the gully's own floor inward and find `aBury`, the first metre at
   * which the hillside stands clear over a passage of this size. Ring zero goes
   * three metres in front of that. Three metres is what the hood has to carry,
   * and on a flank rising at 0.9-1.4 that leaves only the top of the arch in the
   * open — which is an overhang, which is what a cave mouth is.
   *
   * The floor tracking is the entire seam and there is nothing else to it: the
   * notch carved a floor, and the tube takes its height FROM that floor, sample
   * by sample, so crossing the mouth does not move the ground under your feet by
   * a millimetre. `min` against the running floor is what stops the tube
   * climbing back out — past `aHold` the carve ramps away and `heightAt` shoots
   * up the hillside, and a tube that followed it would surface on the mountain.
   */
  const rMouth = rngRange(rng, 3.5, 4.5);
  const need = rMouth * (SEC_FLOOR + SEC_TALL) + 0.6;
  const gullyFloor = (a) => {
    const p = caveAxisPoint(c, a, 0);
    return { p, surf: heightAt(p.x, p.z) };
  };
  let ref = gullyFloor(c.aHold - 9).surf;
  let aBury = c.aFade + 6;
  for (let a = c.aHold - 8; a <= c.aFade + 8; a += 1) {
    const g = gullyFloor(a);
    ref = Math.min(g.surf, ref + 0.12);
    if (g.surf > ref + need) {
      aBury = a;
      break;
    }
  }

  let prevFloor = Infinity;
  const aStart = aBury - 3;
  for (let i = 0; i < 5; i++) {
    const a = aStart + i * 3;
    const g = gullyFloor(a);
    const r = i === 0 ? rMouth : rngRange(rng, 3.0, 4.2);
    const f = Math.min(g.surf, prevFloor + 0.34);
    prevFloor = f;
    /**
     * The node is a CENTRE and the floor is `SEC_FLOOR` radii below it, so the
     * centre has to be lifted or the walkable surface would sit 1.8 m under the
     * ground you walked in on — a hole in the floor three metres before the
     * mouth, which is what the first build did.
     */
    nodes.push(shaped(g.p.x, f + r * SEC_FLOOR, g.p.z, r, MOUTH_SHAPE));
  }

  // Heading is the gully's own axis, continued into the hill.
  const last0 = nodes[nodes.length - 1];
  const ahead = caveAxisPoint(c, aStart + 18, 0);
  let heading = Math.atan2(ahead.z - last0.z, ahead.x - last0.x);
  let pitch = -0.18;
  let x = last0.x;
  let y = last0.y;
  let z = last0.z;

  /**
   * How deep it is allowed to get.
   *
   * Relative to the mouth rather than absolute, because the mouth's own height
   * is a property of the seed — a ridge 46 m high puts its caves fifty metres
   * above a ridge that is 21. 62 m of descent is about four minutes of walking
   * downhill, which is as far as anything this size should go without the
   * passage having somewhere to arrive at.
   */
  const bottom = nodes[0].y - 62;
  const count = 18 + Math.floor(rng() * 8);

  /**
   * THE JOINT SET, WHICH IS WHY A CAVE MAP LOOKS LIKE A STREET GRID.
   *
   * The old walk drew a turn of +/- 0.62 rad per node from a flat distribution,
   * which produces a smooth wandering worm — the shape a random walk makes and
   * the shape no cave has ever been. Limestone is jointed: it has two or three
   * fracture directions, water can only get in along them, so a passage runs
   * dead straight for fifty metres and then takes a corner that is nearly a
   * right angle. Every survey you have ever seen looks like lightning for this
   * reason and for no other.
   *
   * Two joint bearings and their reciprocals, the first pinned to the heading
   * the gully hands over so the entrance does not immediately fight the terrain.
   * Each node either continues on its current joint — most of the time, and with
   * a longer step, because that is what a straight reach IS — or snaps to
   * another one. Reversal is excluded: a passage that doubles back down its own
   * bearing is the self-intersection the attempt loop below exists to reject,
   * arrived at deliberately.
   *
   * The payoff is not the map, which nobody sees. It is that corners hide what
   * is past them. A worm shows you forty metres of identical tube; a joint walk
   * shows you a wall, and the space only exists once you have committed to
   * walking to it.
   */
  const jointB = heading + rngRange(rng, 0.95, 1.55) * (rng() < 0.5 ? -1 : 1);
  const joints = [heading, heading + Math.PI, jointB, jointB + Math.PI];
  let joint = 0;

  /**
   * …and the passage type, as a chain rather than a draw.
   *
   * Independent per-node draws give a passage that is a different thing every
   * twelve metres, which reads as noise — the player learns that shape carries
   * no information and stops reading it. A chain that mostly repeats itself
   * gives REACHES: forty metres of canyon, then a room, then a long bedding
   * crawl. Length is what makes a shape mean something, and the contrast when it
   * finally changes is the whole reward.
   */
  let type = rng() < 0.5 ? 'tube' : 'keyhole';

  for (let i = 0; i < count; i++) {
    let placed = false;
    /**
     * Six attempts, then take the last one.
     *
     * The rejection is for self-intersection: two arms of the passage crossing
     * are not a junction, they are each other's back faces, and from inside it
     * reads as a hole in the wall with nothing behind it. Retrying the HEADING
     * rather than resampling the whole node keeps the walk moving forward — a
     * scheme that could reject its way into a corner would stall, and this one
     * cannot, because after six tries it accepts.
     */
    for (let attempt = 0; attempt < 6 && !placed; attempt++) {
      /**
       * Stay on the joint, or take the corner. Attempts past the first are
       * allowed to jump, which is what keeps the rejection below from stalling
       * a walk that has boxed itself in against its own earlier reaches.
       */
      const hold = attempt === 0 ? rng() < 0.66 : false;
      let jn = joint;
      if (!hold) {
        for (let tries = 0; tries < 6; tries++) {
          const cand = Math.floor(rng() * joints.length);
          /**
           * Never the reciprocal of where we are pointing: that is a U-turn into
           * the passage we just cut.
           *
           * `d` is the signed turn to the candidate, so a reversal is |d| near
           * PI and the test REJECTS those. This condition shipped inverted once
           * and the symptom is worth recording, because it did not look like a
           * heading bug at all: the walk took a reversal at nearly every corner,
           * the passage folded back within its own width, and two rings twenty
           * apart ended up neighbours. What that presents as is a player who
           * walks nine metres in and stops dead — pushed by two tube walls that
           * are each other's — with a full five metres of clearance reported on
           * both sides, because the wall the body was jammed against belonged to
           * a ring the sampler was not looking at.
           */
          const d = ((joints[cand] - heading + Math.PI) % TAU + TAU) % TAU - Math.PI;
          if (Math.abs(Math.abs(d) - Math.PI) < 0.5) continue;
          jn = cand;
          break;
        }
      }
      const nextType = hold && attempt === 0 ? type : pickType(rng, type, !hold);
      const sh = SHAPES[nextType];
      // A straight reach on one joint is long; a corner is taken in a short step.
      const step = hold ? rngRange(rng, 11, 19) : rngRange(rng, 7, 11);
      const h = joints[jn] + rngRange(rng, -0.13, 0.13);
      /**
       * A canyon is a stream that is cutting DOWN and a room is a floor that is
       * flat. Tying the pitch to the shape is most of what makes the two read as
       * different places rather than as the same place with different walls: you
       * feel a vadose reach in your knees before you have looked at its section.
       */
      const want =
        nextType === 'canyon'
          ? rngRange(rng, -0.40, -0.13)
          : nextType === 'room'
            ? rngRange(rng, -0.09, 0.04)
            : rngRange(rng, -0.22, 0.07);
      const p = clamp(pitch * 0.45 + want * 0.55, -0.44, 0.1);
      const nx = x + Math.cos(h) * step * Math.cos(p);
      const nz = z + Math.sin(h) * step * Math.cos(p);
      let ny = y + Math.sin(p) * step;
      const r = rngRange(rng, sh.lo, sh.hi);

      /**
       * Never break the surface. This is the one hard constraint in the walk:
       * the tube's ceiling stays ROOF_ROCK below the hillside wherever it
       * wanders, so it can leave the mountain, run under the valley and come
       * back and there is still rock overhead. The clamp is one-sided — a
       * passage is allowed to be far deeper than it asked for, and pulling one
       * up to meet a request would be the thing that surfaces it.
       */
      ny = Math.min(ny, heightAt(nx, nz) - r * sh.t - ROOF_ROCK);
      ny = Math.max(ny, bottom);

      let clash = false;
      for (let j = 0; j < nodes.length - 2 && !clash; j++) {
        const n = nodes[j];
        const dx = n.x - nx;
        const dy = n.y - ny;
        const dz = n.z - nz;
        // Half-widths now differ per node, so the keep-apart distance is the two
        // actual half-widths rather than one shared constant. A room next to a
        // squeeze needs eleven metres of clearance; two squeezes need four.
        const min = n.r * n.w + r * sh.w + 3.5;
        if (dx * dx + dy * dy + dz * dz < min * min) clash = true;
      }
      if (clash && attempt < 5) continue;

      heading = h;
      pitch = p;
      joint = jn;
      type = nextType;
      x = nx;
      y = ny;
      z = nz;
      const nd = shaped(x, y, z, r, sh, rng);
      nd.type = nextType;
      nodes.push(nd);
      placed = true;
    }
  }

  /**
   * The last node closes the passage.
   *
   * A tube that simply stops has an open end, and an open end viewed from inside
   * is a hole showing the far side of its own surface — the single most
   * "unfinished level" thing a cave could do. Repeating the final centre with a
   * collapsing radius makes the sweep converge to a point, so the cap is the
   * sweep rather than a separate fan that would need its own normals.
   */
  const last = nodes[nodes.length - 1];
  const pinch = SHAPES[last.type === 'room' ? 'canyon' : last.type ?? 'tube'];
  nodes.push(shaped(x + Math.cos(heading) * 4, last.y - 1.2, z + Math.sin(heading) * 4, last.r * 0.55, pinch));
  nodes.push(shaped(x + Math.cos(heading) * 6, last.y - 1.6, z + Math.sin(heading) * 6, 0.05, pinch));
  return { nodes, joints };
}

/**
 * The passage-type chain. See the block in `buildNodes`.
 *
 * `turned` biases toward a room, because in a real system the big chambers are
 * at the junctions — that is where two lines of weakness cross, where the water
 * came from two directions, and where the ceiling had the least left holding it
 * up. Putting the rooms on the corners is also the best thing that ever happened
 * to this cave from thirty metres away: you take a corner and the space opens,
 * which is the one moment a passage can surprise you.
 */
const TYPE_CHAIN = {
  tube: [['tube', 0.32], ['keyhole', 0.21], ['canyon', 0.18], ['bedding', 0.16], ['room', 0.13]],
  canyon: [['canyon', 0.36], ['keyhole', 0.22], ['tube', 0.18], ['room', 0.13], ['bedding', 0.11]],
  keyhole: [['keyhole', 0.29], ['canyon', 0.26], ['tube', 0.23], ['room', 0.12], ['bedding', 0.10]],
  bedding: [['bedding', 0.33], ['tube', 0.27], ['room', 0.17], ['canyon', 0.13], ['keyhole', 0.10]],
  room: [['tube', 0.30], ['canyon', 0.24], ['bedding', 0.22], ['keyhole', 0.19], ['room', 0.05]],
};

function pickType(rng, from, turned) {
  const table = TYPE_CHAIN[from] ?? TYPE_CHAIN.tube;
  let total = 0;
  for (const [name, wgt] of table) total += name === 'room' && turned ? wgt * 2.6 : wgt;
  let u = rng() * total;
  for (const [name, wgt] of table) {
    u -= name === 'room' && turned ? wgt * 2.6 : wgt;
    if (u <= 0) return name;
  }
  return table[0][0];
}

/* -------------------------------------------------------------------------- *
 *  SIDE PASSAGES — THE DIFFERENCE BETWEEN A CORRIDOR AND A SYSTEM
 * -------------------------------------------------------------------------- *
 *
 * Everything above builds one line. A line has a length and nothing else: you
 * walk it, you reach the end, and the only question it ever asked you was
 * whether to keep going. What makes a cave pull is that at some point your light
 * finds a hole in the wall that is not the way you came and not the way you are
 * going, and the passage you are standing in stops being a route and becomes a
 * choice. Nothing else in this file buys that.
 *
 * A branch is a second swept path whose ring zero sits ON the main tube's wall,
 * pointing out through it. Three things make that work and each one is a trap:
 *
 *   THE HOLE IS CUT SMALLER THAN THE BORE. `_link` skips the main tube's quads
 *   in a window around the branch mouth. The window is 0.62 of the branch's own
 *   half-extents, which puts its corners inside the branch's ring-zero ellipse
 *   (0.62^2 + 0.62^2 = 0.77 < 1) — so whatever angle you look through it from,
 *   what is behind the hole is branch wall. Cut it any bigger and there is a
 *   sliver of nothing at the rim, which underground is black on black and gets
 *   through review, and then shows up the first time somebody stands in the one
 *   spot the fog is thin.
 *
 *   THE FLOORS HAVE TO AGREE AT THE JOIN. Ring zero's centre is the main ring's
 *   centre height, and its `f` is solved so that `rb * f_branch` equals the
 *   main's `r * f` — the same floor, from two different radii. Get it wrong and
 *   there is a step in the doorway, which the body resolves by climbing or
 *   falling, and which reads as the two halves of the cave being different
 *   objects. Which they are; the point is that nobody should be able to tell.
 *
 *   AND IT LEAVES THROUGH THE WALL, NOT ALONG IT. The initial bearing is the
 *   wall normal, so the mouth is a hole rather than an alcove smeared down
 *   twenty metres of passage. It picks up the joint set from node two onward,
 *   which is where it starts to look like the rest of the cave.
 */

/** How many rings past the mouth a branch may start. See `blind`, below. */
const BRANCH_MIN_RING = 22;

function buildBranch(c, main, joints, bi, tag) {
  const rng = makeRng(`${getWorldSeed()}:cave-branch:${c.k}:${tag}`);
  const n = main.x.length;
  const r0 = main.r[bi];
  const w0 = main.w[bi];

  // The main tube's frame at the base ring — same construction as `_emitRing`.
  const a = Math.max(0, bi - 1);
  const b = Math.min(n - 1, bi + 1);
  let tx = main.x[b] - main.x[a];
  let tz = main.z[b] - main.z[a];
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl;
  tz /= tl;
  const side = rng() < 0.5 ? 1 : -1;
  const rx = (-tz) * side;
  const rz = tx * side;

  const type = rng() < 0.42 ? 'canyon' : rng() < 0.6 ? 'bedding' : 'tube';
  const sh = SHAPES[type];
  /**
   * Never bigger than the passage it leaves. A branch wider than its parent
   * pokes its own ceiling through the main tube's, and the two surfaces argue
   * about which is in front for the six metres either side of the junction.
   */
  const rb = Math.min(r0 * 0.85, rngRange(rng, sh.lo, sh.hi));
  const first = shaped(
    main.x[bi] + rx * r0 * w0,
    main.y[bi],
    main.z[bi] + rz * r0 * w0,
    rb,
    sh
  );
  // Solved, not drawn: the branch's floor IS the main's floor at the join.
  first.f = clamp((r0 * main.f[bi]) / rb, 0.1, 1.6);
  first.t = clamp((r0 * main.t[bi]) / rb, 0.35, 1.9);

  const nodes = [first];
  let heading = Math.atan2(rz, rx);
  let pitch = rngRange(rng, -0.16, 0.05);
  let x = first.x;
  let y = first.y;
  let z = first.z;

  const count = 3 + Math.floor(rng() * 4);
  for (let i = 0; i < count; i++) {
    // Node one keeps the wall normal so the mouth is a hole; after that the
    // branch joins the joint set like everything else.
    if (i > 0) {
      let bestD = Infinity;
      let bestH = heading;
      for (const j of joints) {
        const d = Math.abs(((j - heading + Math.PI) % TAU + TAU) % TAU - Math.PI);
        if (d < bestD && d < 1.5) {
          bestD = d;
          bestH = j;
        }
      }
      heading = bestH + rngRange(rng, -0.2, 0.2);
    }
    const step = i === 0 ? rngRange(rng, 6, 9) : rngRange(rng, 8, 14);
    pitch = clamp(pitch + rngRange(rng, -0.16, 0.12), -0.4, 0.12);
    const nx = x + Math.cos(heading) * step * Math.cos(pitch);
    const nz = z + Math.sin(heading) * step * Math.cos(pitch);
    const r = rngRange(rng, sh.lo, sh.hi) * (i > count - 2 ? 0.8 : 1);
    let ny = y + Math.sin(pitch) * step;
    ny = Math.min(ny, heightAt(nx, nz) - r * sh.t - ROOF_ROCK);

    /**
     * Do not run back into the passage you left.
     *
     * Tested against the main line EXCEPT the twelve rings around the base,
     * which is the junction and is supposed to touch. Without the exemption
     * every branch is rejected on its first node by the wall it is leaving
     * through; without the test at all, a branch that curls back produces two
     * tubes sharing a volume, which from inside is a hole in the floor with the
     * ceiling of somewhere else visible through it.
     */
    let clash = false;
    for (let j = 0; j < n && !clash; j++) {
      if (Math.abs(j - bi) < 12) continue;
      const dx = main.x[j] - nx;
      const dy = main.y[j] - ny;
      const dz = main.z[j] - nz;
      const min = main.r[j] * main.w[j] + r * sh.w + 3;
      if (dx * dx + dy * dy + dz * dz < min * min) clash = true;
    }
    if (clash) break;

    const nd = shaped(nx, ny, nz, r, sh, rng);
    nd.type = type;
    nodes.push(nd);
    x = nx;
    y = ny;
    z = nz;
  }

  // Too short to be a lead — it would read as a dent, not a way on.
  if (nodes.length < 3) return null;

  /**
   * The terminus, and it is deliberately not a neat cap.
   *
   * A blind lead that ends in a smooth dome reads as built. Real ones pinch: the
   * passage gets lower and narrower until it is a slot too small to follow, and
   * the reason you turn round is that you cannot fit, not that there is a wall.
   * Two collapsing nodes with the section still narrowing give exactly that, and
   * they cost nothing because the sweep is doing the work either way.
   */
  const last = nodes[nodes.length - 1];
  const pinchA = shaped(
    last.x + Math.cos(heading) * 4.5,
    last.y - 0.9,
    last.z + Math.sin(heading) * 4.5,
    last.r * 0.42,
    SHAPES.canyon
  );
  const pinchB = shaped(
    last.x + Math.cos(heading) * 6.5,
    last.y - 1.3,
    last.z + Math.sin(heading) * 6.5,
    0.05,
    SHAPES.canyon
  );
  nodes.push(pinchA, pinchB);

  const path = resample(nodes);
  path.base = bi;
  path.side = side;
  /**
   * The hole, in the main tube's own (ring, phi) lattice.
   *
   * phi 0 is +right and phi PI is -right — see the frame in `_emitRing` — so a
   * branch leaving to the right is centred on phi 0 and one leaving left on PI.
   */
  const halfV = rb * path.t[0] * 0.62;
  const halfH = rb * path.w[0] * 0.62;
  path.holePhi = side > 0 ? 0 : Math.PI;
  // Vertical extent converted to an angle at the wall, capped so a fat branch
  // off a thin passage cannot unzip half the tube.
  path.holeSpan = Math.min(0.95, Math.atan2(halfV, Math.max(r0 * w0, 0.5)));
  path.holeRings = Math.max(1, Math.round(halfH / RING_STEP));
  return path;
}

/** Catmull-Rom on one component. Uniform parameterisation; the nodes are even. */
function spline(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * Resample the node walk into evenly spaced rings.
 *
 * Even spacing matters for two things that would otherwise be subtly wrong: the
 * rock displacement is a function of world position and would band where the
 * rings bunched, and `caveSample` treats the ring list as a polyline and finds
 * the nearest one by scanning, which is only a good approximation of the nearest
 * point on the curve while the rings are close together and evenly spread.
 */
function resample(nodes) {
  const seg = nodes.length - 1;
  const out = { x: [], y: [], z: [] };
  for (const ch of CHANNELS) out[ch] = [];
  for (let i = 0; i < seg; i++) {
    const p0 = nodes[Math.max(0, i - 1)];
    const p1 = nodes[i];
    const p2 = nodes[i + 1];
    const p3 = nodes[Math.min(seg, i + 2)];
    const span = Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
    const steps = Math.max(1, Math.round(span / RING_STEP));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.x.push(spline(p0.x, p1.x, p2.x, p3.x, t));
      out.y.push(spline(p0.y, p1.y, p2.y, p3.y, t));
      out.z.push(spline(p0.z, p1.z, p2.z, p3.z, t));
      /**
       * THE SHAPE CHANNELS GO THROUGH THE SAME SPLINE AS THE POSITION, and that
       * is the entire mechanism by which one kind of passage becomes another.
       * There is no blend state and no transition code: `w` at this ring is
       * simply Catmull-Rom between the two nodes' `w`, so a tube whose next node
       * is a canyon narrows and heightens over the eleven metres between them.
       *
       * Clamped afterwards because Catmull-Rom OVERSHOOTS — it is an
       * interpolating spline, not a convex one, and a `key` of 0 followed by a
       * `key` of 1 passes through -0.15 on its way, which is a section with a
       * negative slot squeeze: walls that cross through each other, drawn
       * inside-out, in the two rings either side of every keyhole in the world.
       */
      for (const ch of CHANNELS) out[ch].push(spline(p0[ch], p1[ch], p2[ch], p3[ch], t));
    }
  }
  const end = nodes[seg];
  out.x.push(end.x);
  out.y.push(end.y);
  out.z.push(end.z);
  for (const ch of CHANNELS) out[ch].push(end[ch]);

  const path = { x: Float64Array.from(out.x), y: Float64Array.from(out.y), z: Float64Array.from(out.z) };
  for (const ch of CHANNELS) path[ch] = Float64Array.from(out[ch]);

  const n = path.x.length;
  for (let i = 0; i < n; i++) {
    path.r[i] = Math.max(0.05, path.r[i]);
    path.w[i] = Math.max(0.12, path.w[i]);
    path.t[i] = Math.max(0.12, path.t[i]);
    path.f[i] = Math.max(0.08, path.f[i]);
    path.key[i] = clamp01(path.key[i]);
    path.rough[i] = Math.max(0, path.rough[i]);
    path.scal[i] = clamp01(path.scal[i]);
    path.seep[i] = Math.max(0, path.seep[i]);

    /**
     * …and then the passage is made big enough to walk through. See MIN_HEAD.
     *
     * Applied to `t` and `w` rather than to `r` because the radius is what makes
     * a squeeze a squeeze — inflating it to buy headroom would take the one
     * shape the player is supposed to feel and turn it into an ordinary tube.
     * The last few rings are exempt: the sweep collapses to a point there on
     * purpose, and that terminus is the closed end of the passage, not somewhere
     * anybody has to fit.
     */
    if (i < n - 3) {
      const head = path.r[i] * (path.f[i] + path.t[i]);
      if (head < MIN_HEAD) path.t[i] += (MIN_HEAD - head) / path.r[i];
      // The slot, if there is one, is the narrowest part and is what has to fit.
      const halfLow = path.r[i] * halfWidthAt(-path.f[i] * 0.35, ringShape(path, i, _shapeA));
      if (halfLow < MIN_HALF) path.w[i] *= MIN_HALF / Math.max(halfLow, 1e-3);
    }
  }
  return path;
}

/**
 * How far in the hillside takes over the roofing.
 *
 * Returns the number of leading rings that need a built hood. Tested against the
 * ring's own ceiling rather than its centre, and with half a metre of slack,
 * because a ring whose ceiling merely grazes the surface would show a sliver of
 * sky through the rock — and one sliver of sky in a cave ceiling undoes the
 * whole thing.
 */
function exposedRings(path) {
  const n = path.x.length;
  for (let i = 0; i < n; i++) {
    const top = path.y[i] + path.r[i] * path.t[i] + 0.5;
    if (heightAt(path.x[i], path.z[i]) > top) {
      // Plus HOOD_EXTRA, and never fewer than HOOD_MIN: the seam needs i + 2,
      // the crag needs somewhere to fade. See the crag block above.
      return Math.min(Math.max(HOOD_MIN, i + 2 + HOOD_EXTRA), n - 1);
    }
  }
  return Math.min(12 + HOOD_EXTRA, n - 1);
}

/**
 * How far in you have to be before the mouth is out of sight, in metres.
 *
 * This is the number the whole performance case rests on, so it is measured
 * rather than assumed. Walk outward from ring zero; for each candidate ring i,
 * test whether the straight line from ring i's centre back to ring zero stays
 * inside the passage the whole way. The first one for which it does not is the
 * bend that hides the entrance, and past it there is no line of sight to
 * daylight from anywhere on the centre line.
 *
 * O(n^2) in the worst case, which for 250 rings is 62 500 distance tests, once,
 * on a passage that took four milliseconds to build. It is bounded in practice
 * by the first bend, which on these paths is twenty or thirty rings.
 *
 * 0.62 of the radius rather than the full radius, and a margin added on top,
 * because the test is on the CENTRE LINE and the player is not: standing
 * against the outside of a bend buys back a few metres of sight line. The
 * consequence of getting this wrong is the whole forest popping out of
 * existence in front of somebody, so it is deliberately pessimistic.
 */
function blindAlong(path, along) {
  const n = path.x.length;
  const x0 = path.x[0];
  const y0 = path.y[0];
  const z0 = path.z[0];
  for (let i = 3; i < n; i++) {
    const dx = path.x[i] - x0;
    const dy = path.y[i] - y0;
    const dz = path.z[i] - z0;
    const len2 = dx * dx + dy * dy + dz * dz;
    if (len2 < 1e-6) continue;
    for (let j = 1; j < i; j++) {
      const px = path.x[j] - x0;
      const py = path.y[j] - y0;
      const pz = path.z[j] - z0;
      const t = clamp01((px * dx + py * dy + pz * dz) / len2);
      const ox = px - dx * t;
      const oy = py - dy * t;
      const oz = pz - dz * t;
      // The NARROWEST half-dimension at that ring, not the radius: a canyon is
      // 0.6 radii across and a line of sight that fits inside its radius is a
      // line of sight through its wall. Being pessimistic here is free; being
      // optimistic pops the whole forest out of existence in front of somebody.
      const fit = path.r[j] * Math.min(path.w[j], path.t[j]) * 0.62;
      if (ox * ox + oy * oy + oz * oz > fit * fit) return along[i] + 14;
    }
  }
  // A passage with no bend in it at all. Nothing is ever out of sight, so
  // nothing is ever hidden — which is the safe answer, not a failure.
  return Infinity;
}

/**
 * How far below the waist the keyhole's slot starts, and how far it closes.
 *
 * The slot is a HORIZONTAL squeeze applied under the bore, not a narrower
 * ellipse: a keyhole is a round tube with a knife cut under it, and scaling the
 * whole lower half would give a teardrop, which is a shape water does not make.
 */
const SLOT_TOP = 0.10;
const SLOT_RAMP = 0.55;
const SLOT_CLOSE = 0.62;

/** 1 above the waist, falling to `1 - SLOT_CLOSE * key` in the slot. */
function slotSqueeze(ny, key) {
  if (key <= 0 || ny >= -SLOT_TOP) return 1;
  return 1 - key * SLOT_CLOSE * smoothstep(clamp01((-ny - SLOT_TOP) / SLOT_RAMP));
}

/**
 * The cross-section outline: an ellipse, cut off flat at the floor, optionally
 * pinched into a slot below the waist.
 *
 * `sh` carries the per-ring `w`, `t`, `f` and `key` — see SHAPES. Everything is
 * in units of the ring's radius, so the caller multiplies by `r` once.
 */
function section(phi, sh, out) {
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  const ex = cp / sh.w;
  const ey = sp / sh.t;
  let t = 1 / Math.sqrt(ex * ex + ey * ey);
  if (sp < -1e-4) t = Math.min(t, sh.f / -sp);
  out.y = sp * t;
  out.x = cp * t * slotSqueeze(out.y, sh.key);
  return out;
}

/**
 * The horizontal half-width at a given height, and it is the COLLISION half of
 * `section` rather than an approximation of it.
 *
 * The body needs "how far can I walk sideways from the centre line, at chest
 * height", and taking that from `section` at the angle the player happens to sit
 * at is wrong in exactly the place it matters: in a keyhole the slot is narrow
 * and the bore above it is not, and the angle to a point in the slot points at
 * a part of the outline that is neither. Solving the ellipse for x at a given y
 * is two lines and is exact, so the wall the body feels and the wall the eye
 * sees are the same wall — the argument the floor has always made, applied
 * sideways.
 */
function halfWidthAt(ny, sh) {
  const y = clamp(ny, -sh.f + 1e-3, sh.t - 1e-3);
  const inner = 1 - (y / sh.t) * (y / sh.t);
  const x = sh.w * Math.sqrt(inner > 0 ? inner : 0);
  return x * slotSqueeze(y, sh.key);
}

/**
 * Lift one ring's shape out of the path's parallel arrays.
 *
 * Into a caller-supplied object, never a fresh one: this is called from
 * `caveSample`, which runs three times a frame from the movement code, and an
 * allocation there is 180 objects a second of garbage for four floats.
 */
function ringShape(path, i, out) {
  out.w = path.w[i];
  out.t = path.t[i];
  out.f = path.f[i];
  out.key = path.key[i];
  return out;
}
const _shapeA = { w: 1, t: 1, f: 0.5, key: 0 };
const _shapeB = { w: 1, t: 1, f: 0.5, key: 0 };

/**
 * Scallops: the asymmetric hollows water leaves on a phreatic wall.
 *
 * They are the one surface feature that is not noise, and the reason to have
 * them is not that anybody will identify them — it is that they are DIRECTIONAL.
 * A wall of isotropic lumps says "rock"; a wall of hollows that are all steep on
 * the same side says "this was full of water and the water was going that way",
 * and the eye reads the second one as a place with a history before the brain
 * gets anywhere near the word scallop.
 *
 * The profile is a sine hollow biased toward its leading edge — steep upstream,
 * drawn out downstream. Modulated across the ring by a coarse hash so they come
 * in patches rather than in bands, because a hollow that runs the whole way
 * round the tube is a groove, and a groove is machining.
 *
 * Cheap, and it has to be: this runs once per vertex at build time, next to two
 * fbm lookups that cost twenty times as much.
 */
const SCALLOP_LEN = 0.92;
function scallop(along, phi, seed) {
  const u = along / SCALLOP_LEN + noise2(phi * 2.7 + seed, along * 0.21) * 0.9;
  const s = u - Math.floor(u);
  // Deepest a third of the way through, then a long tail: the spoon shape.
  const hollow = Math.sin(Math.PI * Math.pow(s, 0.62));
  const patch = 0.45 + 0.55 * clamp01(noise2(phi * 1.6 + seed * 3.1, along * 0.11) * 1.7 + 0.5);
  return -hollow * hollow * patch;
}

/**
 * Rock, as two decorrelated 2D fields.
 *
 * `util.js` has no 3D noise and is not this file's to extend, so height is
 * folded into both lookups at different rates. That is not a true 3D field —
 * it repeats along one direction in the 4-space — but the tube never revisits
 * the same (x, z) at two heights for more than a few metres, so the degeneracy
 * has nowhere to show.
 */
function rock(x, y, z) {
  return (
    fbm2(x * 0.21 + y * 0.63, z * 0.21 - y * 0.29, 3) * 0.72 +
    fbm2(z * 0.74 - y * 0.41, x * 0.74 + y * 0.17, 3) * 0.44 +
    /**
     * A third octave at 0.95, and not a metre finer.
     *
     * The rings are 1.15 m apart and a ring vertex is 0.55 m of arc at a
     * typical radius, so the mesh Nyquists at about 1.1 m of wavelength.
     * Displacement above that frequency does not become detail, it becomes
     * aliasing that crawls when the melt moves the surface — and the fragment's
     * grain term is where the finer scales actually belong, because a texture
     * lookup is not sampled by the vertex spacing.
     */
    fbm2(y * 0.95 + x * 0.33, x * 0.95 - z * 0.37, 2) * 0.26
  );
}

/* -------------------------------------------------------------------------- */
/*  the fungi                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What lights a cave.
 *
 * Clusters on the walls, spaced along the passage, each a coloured point whose
 * light is baked into the rock's vertex colours. Mostly cold — a cave lit warm
 * reads as a mine with lamps in it — with a minority of violet so the palette
 * has somewhere to go when the trip starts rotating hue.
 *
 * They are also the reason the passage is legible. Without placed light a tube
 * lit only by a near-field term is a black corridor with a grey circle round
 * your feet, and every part of it looks the same; with a light every twelve
 * metres you can see the shape of the next chamber before you reach it, which
 * is what makes a cave feel like somewhere you are going rather than somewhere
 * you are.
 */
const FUNGUS_COLD = new THREE.Color(0x74c6b4);
const FUNGUS_DEEP = new THREE.Color(0x6f8fd0);
const FUNGUS_ODD = new THREE.Color(0xd09257);
/** Metres a cluster reaches. Quadratic falloff, so most of it is much closer. */
const FUNGUS_REACH = 13;

function placeFungi(c, path, tag = 'main', from = 0) {
  const rng = makeRng(`${getWorldSeed()}:cave-fungi:${c.k}:${tag}`);
  const n = path.x.length;
  const out = [];
  const tmp = { x: 0, y: 0 };
  /**
   * Never at the mouth. The first fifteen metres are lit by the sky and a
   * glowing mushroom in daylight is a mushroom nobody notices; starting them
   * where the daylight has gone is also what makes walking in feel like walking
   * from one lighting scheme into another rather than into a dimmer.
   */
  let i = from + Math.floor(rng() * 8);
  while (i < n - 6) {
    const r = path.r[i];
    // On the wall, low, where you would actually find them.
    const phi = (rng() < 0.5 ? -1 : 1) * rngRange(rng, 0.15, 1.15) + (rng() < 0.5 ? 0 : Math.PI);
    section(phi, ringShape(path, i, _shapeA), tmp);
    const tx = path.x[i + 1] - path.x[i];
    const tz = path.z[i + 1] - path.z[i];
    const tl = Math.hypot(tx, tz) || 1;
    // Right-hand basis about the (mostly horizontal) tangent.
    const rx = -tz / tl;
    const rz = tx / tl;
    const px = path.x[i] + rx * tmp.x * r * 0.94;
    const pz = path.z[i] + rz * tmp.x * r * 0.94;
    const py = path.y[i] + tmp.y * r * 0.94;

    const pick = rng();
    const colour = (pick < 0.6 ? FUNGUS_COLD : pick < 0.86 ? FUNGUS_DEEP : FUNGUS_ODD).clone();
    out.push({
      x: px,
      y: py,
      z: pz,
      colour,
      power: rngRange(rng, 0.55, 1.25),
      count: 4 + Math.floor(rng() * 9),
      seed: rng(),
    });
    i += 7 + Math.floor(rng() * 9);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  water, breakdown and formations                                           */
/* -------------------------------------------------------------------------- */

/**
 * The stream, and the reason it is worth the geometry.
 *
 * A cave with no water in it is a cave that has stopped. Every shape above was
 * cut by water and every formation below is being built by water, so a passage
 * with a dry floor everywhere is a room full of evidence for a thing that is not
 * there — and the ear notices before the eye does, because `audio/cave.js` has
 * been dripping into a cave with nothing to drip into since the day it was
 * written.
 *
 * Runs rather than a continuous stream: real water is in the passage for a while
 * and then goes somewhere you cannot follow. Each run is a strip of quads along
 * the centre line at floor level, in the SAME mesh and the SAME material as the
 * rock — flagged by the `wet` channel of `aSurf`, which the fragment shader
 * reads to swap albedo for a rippled sheen. One draw for a cave, still.
 *
 * `waterAudio` is the same runs, smeared over twelve rings either side, and it
 * is the whole of "you can hear water you cannot see yet". It is precomputed
 * because the alternative is a search over the ring list three times a frame for
 * a number that cannot change.
 */
function placeWater(c, path, tag) {
  const rng = makeRng(`${getWorldSeed()}:cave-water:${c.k}:${tag}`);
  const n = path.x.length;
  path.wet = new Float32Array(n);
  path.pool = new Float32Array(n);
  const runs = [];
  let i = 8 + Math.floor(rng() * 22);
  while (i < n - 8) {
    const len = 14 + Math.floor(rng() * 52);
    const i1 = Math.min(n - 6, i + len);
    if (i1 - i > 8) {
      for (let j = i; j < i1; j++) {
        // Tapered at both ends, so a run does not begin and end with a step in
        // the water's width — which reads as a bath rather than as a stream.
        const edge = Math.min(j - i, i1 - 1 - j);
        path.wet[j] = clamp01(edge / 4);
      }
      /**
       * Pools where the floor flattens, because that is where they are.
       *
       * Standing water needs a gradient near zero; a pool drawn on a slope is
       * the one water mistake everybody can see without knowing why. The test is
       * the run's own descent over five rings, which is the same number the
       * spline was smoothed with, so it is measuring the passage rather than the
       * resampling.
       */
      for (let j = i + 3; j < i1 - 3; j++) {
        const drop = path.y[j - 3] - path.y[j + 3];
        if (drop < 0.16 && rng() < 0.16) {
          const w = 2 + Math.floor(rng() * 4);
          for (let k = Math.max(i, j - w); k < Math.min(i1, j + w); k++) {
            path.pool[k] = Math.max(path.pool[k], 1 - Math.abs(k - j) / (w + 1));
          }
          j += w * 2;
        }
      }
      runs.push({ i0: i, i1 });
    }
    i = i1 + 30 + Math.floor(rng() * 90);
  }

  const audio = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    let best = 0;
    for (let k = Math.max(0, j - 12); k < Math.min(n, j + 13); k++) {
      const v = path.wet[k] * (1 - Math.abs(k - j) / 13);
      if (v > best) best = v;
    }
    audio[j] = best;
  }
  path.waterAudio = audio;
  return runs;
}

/**
 * Breakdown: the floor of a room, which is not a floor.
 *
 * A big chamber with a smooth floor is a stadium. The reason a real one takes
 * ten minutes to cross is that the ceiling that is no longer over your head is
 * under your feet, in pieces, and every one of them is the size of a car. That
 * is the single most recognisable thing about a large cave and it was the most
 * conspicuous absence in this one.
 *
 * WALKED ON, NOT WALKED AROUND, and the shape is what makes that safe. Each
 * block reports a height that is flat across its top and ramps to nothing at its
 * rim — so the body climbs it the way it climbs a hill, through the existing
 * floor clamp, with no step logic anywhere. The VISIBLE block is an angular
 * lump that does not match that dome, and does not have to: it is the same
 * bargain the floor has always made here, and the same one `heightAt` makes with
 * the ground mesh. What you must not do is let the two disagree by more than the
 * body's own step, which is why `top` is capped against the local headroom —
 * standing on a block must not put your head in the ceiling.
 */
const BLOCK_MAX = 2.4;
function placeBlocks(c, path, tag) {
  const rng = makeRng(`${getWorldSeed()}:cave-blocks:${c.k}:${tag}`);
  const n = path.x.length;
  const out = [];
  for (let i = 4; i < n - 4; i++) {
    const r = path.r[i];
    const half = r * path.w[i];
    const head = r * (path.f[i] + path.t[i]);
    /**
     * Density follows the section, and that is the whole placement rule. Rooms
     * are breakdown by definition — they exist BECAUSE the roof came down —
     * and a squeeze is swept clean by the water still going through it.
     */
    const density = clamp01((half - 3.4) / 5.5) * 0.55 + (path.wet[i] > 0.1 ? 0 : 0.03);
    if (rng() > density) continue;

    const ang = rngRange(rng, 0, TAU);
    const off = Math.sqrt(rng()) * (half - 0.9);
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let tx = path.x[b] - path.x[a];
    let tz = path.z[b] - path.z[a];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    const px = path.x[i] + (-tz) * Math.cos(ang) * off + tx * Math.sin(ang) * 0.9;
    const pz = path.z[i] + tx * Math.cos(ang) * off + tz * Math.sin(ang) * 0.9;

    const rad = rngRange(rng, 0.7, 1.1 + half * 0.22);
    /**
     * Height capped three ways: by the rubble's own scale, by what is left
     * between the floor and the ceiling once a body is standing on it, and by
     * the rim slope. A 2.4 m block on a 1.2 m radius is a wall you cannot climb
     * and cannot see over; tying the two means the big ones are also broad,
     * which is what a house-sized breakdown slab actually is.
     */
    const top = Math.min(BLOCK_MAX, rad * rngRange(rng, 0.5, 1.15), Math.max(0.25, head - 2.15));
    out.push({
      x: px,
      z: pz,
      y: path.y[i] - r * path.f[i],
      rad,
      top,
      ring: i,
      kind: 0,
      rot: rngRange(rng, 0, TAU),
      seed: rng(),
    });
  }
  return out;
}

/**
 * Speleothems, placed the way water places them.
 *
 * The temptation is to scatter these evenly, and the result is a novelty cave: a
 * uniform lawn of stalagmites says nothing except that somebody had a stalagmite
 * function. Calcite is deposited where water GETS IN, which is along joints, so
 * they come in lines and clusters with bare rock between — and the bare rock is
 * what makes the clusters read, exactly as the darkness between the fungi is
 * what makes the fungi read.
 *
 * `seep` is the per-ring version of that, from the shape chain: a breakdown room
 * is freshly broken and barely decorated, a long-abandoned phreatic tube is
 * covered. Columns are where a pair happened to meet, which is why they are
 * generated as a pair that met rather than as a third kind of object.
 */
function placeSpires(c, path, tag) {
  const rng = makeRng(`${getWorldSeed()}:cave-spires:${c.k}:${tag}`);
  const n = path.x.length;
  const out = [];
  const tmp = { x: 0, y: 0 };
  for (let i = 3; i < n - 4; i++) {
    const r = path.r[i];
    const head = r * (path.f[i] + path.t[i]);
    // A joint line: clusters recur along the passage rather than being uniform.
    const vein = clamp01(fbm2(path.x[i] * 0.14, path.z[i] * 0.14 + path.y[i] * 0.2, 2) * 2.1 + 0.55);
    const chance = path.seep[i] * vein * 0.5;
    const many = 1 + Math.floor(rng() * 3);
    for (let m = 0; m < many; m++) {
      if (rng() > chance) continue;
      const phi = rngRange(rng, -Math.PI, Math.PI);
      section(phi, ringShape(path, i, _shapeA), tmp);
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      let tx = path.x[b] - path.x[a];
      let tz = path.z[b] - path.z[a];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const nx = -tz;
      const nz = tx;
      const along = rngRange(rng, -0.5, 0.5);
      const px = path.x[i] + nx * tmp.x * r * 0.9 + tx * along;
      const pz = path.z[i] + nz * tmp.x * r * 0.9 + tz * along;
      const floor = path.y[i] - r * path.f[i];
      const ceil = path.y[i] + r * path.t[i];

      const roll = rng();
      if (roll < 0.10 && head < 7.5 && head > 2.4) {
        /**
         * A column: one pair that met. Collides as a post — you walk round it,
         * you do not climb it — which is the only formation that needs to,
         * because it is the only one tall and thin enough to be a hazard rather
         * than scenery.
         */
        const rad = rngRange(rng, 0.22, 0.55);
        out.push({ kind: 'column', x: px, z: pz, y0: floor, y1: ceil, rad, ring: i, seed: rng() });
      } else if (roll < 0.34) {
        const h = Math.min(head * 0.42, rngRange(rng, 0.35, 1.7));
        out.push({
          kind: 'mite',
          x: px,
          z: pz,
          y0: floor,
          h,
          rad: h * rngRange(rng, 0.22, 0.42),
          ring: i,
          seed: rng(),
        });
      } else if (roll < 0.78) {
        const h = Math.min(head * 0.45, rngRange(rng, 0.3, 2.0));
        out.push({
          kind: 'tite',
          x: px,
          z: pz,
          y0: ceil,
          h,
          // Straws: long, and barely thicker than the drop that made them.
          rad: rng() < 0.28 ? rngRange(rng, 0.035, 0.07) : h * rngRange(rng, 0.13, 0.28),
          ring: i,
          seed: rng(),
        });
      } else {
        /**
         * A drapery, which is a curtain and therefore has two sides.
         *
         * The material is FrontSide — see the winding note in `_link` — so a
         * single sheet of quads is invisible from one half of the passage, and
         * invisible in a way that looks like a bug in the geometry rather than
         * like a missing surface. It is emitted twice with opposed windings.
         * Twelve triangles for the thing that catches a light better than
         * anything else down here is not a cost worth optimising.
         */
        out.push({
          kind: 'drape',
          x: px,
          z: pz,
          y0: ceil,
          /**
           * Small, and smaller than the first pass drew them. A curtain 3.4 m
           * across and nearly 2 m deep is a wall, and a flat quad that size
           * standing near a passage wall reads as a piece of set dressing that
           * has come loose. Draperies are decoration on rock, not rock.
           */
          h: Math.min(head * 0.34, rngRange(rng, 0.35, 1.1)),
          run: rngRange(rng, 0.7, 1.9),
          dirX: tx,
          dirZ: tz,
          ring: i,
          seed: rng(),
        });
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  the material                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One material for every cave in the world.
 *
 * Shared, so however many are streamed at once they are still one program and
 * one set of uniforms. Everything that differs between caves is in the vertex
 * buffers, which is also why the lighting is baked: a per-cave uniform block
 * would make this per-cave, and then two caves in view would be two draws with
 * two state changes for no visible gain.
 *
 * A ShaderMaterial rather than a `makeLiving`-wrapped standard material,
 * because `makeLiving` hooks three's built-in chunks and every one of those
 * materials is lit by the scene's four lights — which underground means full
 * mid-morning sun on the ceiling. `atmosphere.js` writes the sky, the shafts and
 * the water the same way and for the same reason; the trip terms are imported
 * from the same uniform block, so a cave hue-rotates and melts with everything
 * else without going through three's lighting at all.
 */
function caveMaterial() {
  return new THREE.ShaderMaterial({
    name: 'cave',
    side: THREE.FrontSide,
    fog: true,
    uniforms: {
      uTime: tripUniforms.uTime,
      uLevel: tripUniforms.uLevel,
      uSurge: tripUniforms.uSurge,
      uGlow: tripUniforms.uGlow,
      uSat: tripUniforms.uSat,
      uFlow: tripUniforms.uFlow,
      uBreathPhase: tripUniforms.uBreathPhase,
      uBreathAmp: tripUniforms.uBreathAmp,
      uSwell: tripUniforms.uSwell,
      uDetail: tripUniforms.uDetail,
      uAudio: tripUniforms.uAudio,
      uEye: tripUniforms.uEye,
      uNoiseTex: tripUniforms.uNoiseTex,
      /** The colour and strength of what comes in at the mouth. */
      uDay: { value: new THREE.Color(0x62806e) },
      uDayGain: { value: 1 },
      /** What grows in the last of the daylight. See the twilight block. */
      uMoss: { value: new THREE.Color(0x35502a) },
      /**
       * AND THE WEATHER OUTSIDE, FOR THE PART OF THIS ROCK THAT IS OUT IN IT.
       *
       * Everything else in this material is lit for a hole in a mountain: baked
       * fungus light, a near-field term standing in for dark adaptation, and a
       * daylight attribute that has fallen to nothing fourteen metres in. Point
       * any of it at rock standing in an afternoon and you get a black lump —
       * which is exactly what the first crag was, a dark dome on a sunlit
       * hillside with no sun on it, because the shader had no concept of a sun.
       *
       * So the shell gets a second, ordinary lighting model — one lambert term
       * and a hemisphere — blended in by `aOut`, which is how far above the
       * ground the vertex ended up. It is three uniforms written once a frame
       * from main.js rather than a light in the scene, for the reason the top
       * of this file gives: a shadow-casting light here would cost more than
       * everything else in the feature put together.
       */
      uOpenSun: { value: new THREE.Color(0xffeac4) },
      uOpenSky: { value: new THREE.Color(0x8ea7c4) },
      uOpenGround: { value: new THREE.Color(0x40492f) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.45) },
      fogColor: { value: new THREE.Color(0x0a0d0e) },
      fogDensity: { value: 0.0175 },
    },
    vertexShader: /* glsl */ `
      ${NOISE3}
      uniform float uTime;
      uniform float uLevel;
      uniform float uFlow;
      uniform float uBreathPhase;
      uniform float uBreathAmp;
      uniform float uSwell;
      uniform vec3 uEye;
      attribute vec3 aRock;
      attribute vec3 aLit;
      /**
       * ONE VEC4 RATHER THAN FOUR FLOATS: x daylight, y how far out in the
       * open, z the bedding coordinate, w wetness.
       *
       * It began as two separate float attributes and grew two more, at which
       * point it was four attribute slots and four varyings for four scalars
       * that are always read together. "z" is the one that pays for the packing
       * on its own — see _shade — and "w" is what lets water live in this
       * material instead of needing its own draw.
       *
       * QUOTES AND NOT BACKTICKS, and that is not a style choice: this comment
       * is inside a template literal, so a backtick here ends the shader. See
       * the note at the top of trip/living.js.
       */
      attribute vec4 aSurf;
      varying vec3 vRock;
      varying vec3 vLit;
      varying vec4 vSurf;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vDepthFog;
      void main() {
        vRock = aRock;
        vLit = aLit;
        vSurf = aSurf;
        vec3 p = position;
        vec3 world = (modelMatrix * vec4(p, 1.0)).xyz;

        /**
         * THE TRIP HAS TO REACH UNDERGROUND.
         *
         * The melt is the term that matters: it is world-space displacement,
         * living.js runs it on every surface in the forest, and a cave that
         * held still while the wood ran would be the one place the effect
         * visibly stopped. It is applied to the walls at the same amplitude the
         * plants get and pulled almost to nothing on the floor, for the reason
         * ROUGH_FLOOR exists — the body walks on the analytic centre line, so a
         * floor that melted a metre would be a floor the player fell through.
         */
        /**
         * THE SIGN HERE WAS BACKWARDS AND IT HAD BEEN DAMPING THE CEILING.
         *
         * The cavity's normals point AT the centre line — _finish flips them
         * until they do, because that is the surface being looked at — so a
         * floor vertex has n.y near +1 and a ceiling vertex has n.y near -1.
         * Negating n.y therefore selected the roof, and the melt was running at
         * full amplitude on the one surface the body stands on: exactly the
         * failure ROUGH_FLOOR exists to prevent, arriving through the other
         * door. It never showed as falling through the floor because the body
         * walks the analytic centre line and the analytic line does not melt —
         * what it showed as was the floor visibly detaching from your feet at
         * the peak, which is easy to read as intended and is not.
         *
         * Water is pinned harder still. A surface that is flat by definition is
         * the one thing in the world with nowhere to hide a displacement.
         */
        float rrFloorish = max(clamp(normal.y, 0.0, 1.0), aSurf.w);
        float rrFree = 1.0 - rrFloorish * 0.86;
        if (uLevel > 0.0005) {
          vec3 flow = rrFbm2v(world * 0.075 + vec3(0.0, uTime * 0.05, 0.0));
          p += flow * uFlow * rrFree;
          /**
           * THE BREATH TRAVELS DOWN THE TUNNEL, as it does through the wood.
           *
           * uBreath is one number for the whole world, and a tube whose every
           * wall moves in and out together is a bellows — the one shape a cave
           * must not have, because a passage that pulses as a unit reads as a
           * throat and the player is inside it. Offsetting the phase by a world
           * field the length of a few strides means the swell runs along the
           * gallery instead: the wall beside you is settling while the one ten
           * metres ahead is still filling. See rrLung, and the breath block in
           * living.js for why the phase form is worth four times the motion of
           * the amplitude form at the same peak.
           */
          float rrBph = uBreathPhase + rrNoise(world * 0.085 + 31.0) * 3.0;
          p += normal * (rrLung(rrBph) * uBreathAmp * 0.7 + uSwell * 0.35) * rrFree;
        }

        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec4 mv = viewMatrix * wp;
        vDepthFog = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE3}
      uniform float uTime;
      uniform float uLevel;
      uniform float uSurge;
      uniform float uGlow;
      uniform float uSat;
      uniform float uDetail;
      uniform vec4 uAudio;
      uniform vec3 uEye;
      uniform vec3 uDay;
      uniform float uDayGain;
      uniform vec3 uOpenSun;
      uniform vec3 uOpenSky;
      uniform vec3 uOpenGround;
      uniform vec3 uSunDir;
      uniform vec3 fogColor;
      uniform float fogDensity;
      uniform vec3 uMoss;
      varying vec3 vRock;
      varying vec3 vLit;
      varying vec4 vSurf;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vDepthFog;

      void main() {
        vec3 n = normalize(vNormal);
        vec3 toEye = uEye - vWorld;
        float dist = length(toEye);
        float vDay = vSurf.x;
        float vOut = vSurf.y;
        float vWet = vSurf.w;

        /**
         * Surface grain, and it does more work than a colour multiply.
         *
         * At twenty vertices to a ring the geometry can only carry detail down
         * to about half a metre, and rock is mostly finer than that. Two
         * octaves at a metre, used BOTH as an albedo mottle and — the half
         * that matters — as a perturbation on the lighting term, which is a
         * normal map without the map: it breaks a smooth tube into something
         * with grain in it for the price of fetches it was making anyway.
         *
         * TWO FETCHES, NOT FIVE, AND THAT IS A MEASURED CHOICE. This began as
         * rrFbm3 for the grain plus a second rrFbm2 warping the bedding — five
         * trilinear fetches from the 3D lattice. Inside a cave this material
         * covers EVERY PIXEL, which at 2560x1440 is 3.7 M fragments, so five
         * fetches is eighteen million of them: the frame measured 5.73 ms
         * against 3.97 in the open, and the one place in the world that ought
         * to be the cheapest was the most expensive thing in it. One rrFbm2,
         * reused to warp the bedding, is indistinguishable at arm's length.
         *
         * Plus bedding. vWorld.y * 2.2 is a horizontal stratification about
         * 45 cm apart — the one visual cue that says the material was laid down
         * rather than extruded, and the one thing a radially symmetric tube
         * cannot suggest on its own.
         */
        float grain = rrFbm2(vWorld * 1.05) * 0.5 + 0.5;
        /**
         * Bedding, and the coordinate it runs along is BAKED rather than being
         * vWorld.y.
         *
         * Horizontal strata are what a height taken straight from world Y gives
         * you, and horizontal is the one dip that says "this was drawn by a
         * shader". Real beds are tilted, by a few degrees or by thirty, and the
         * tilt is a property of the hillside — every passage cut through the
         * same rock shows the same dip, and a passage that climbs across the
         * bedding shows it sweeping up the wall as you walk.
         *
         * Lane z of aSurf is dot(worldPosition, beddingNormal), computed per cave on
         * the CPU, so the dip is per-cave, costs one attribute, and removes two
         * instructions from every fragment in the frame that this material
         * covers — which, inside a cave, is all of them.
         */
        float bed = sin(vSurf.z * 2.2 + grain * 5.2) * 0.5 + 0.5;

        /**
         * DARK ADAPTATION, NOT A HEAD TORCH.
         *
         * The player is not carrying a light and this is not pretending they
         * are: it is a small near-field lift that stands in for the fact that a
         * dark-adapted eye resolves the surface a couple of metres away and
         * nothing beyond it. The exponent is steep — half of it is gone by two
         * and a half metres — because anything gentler lights the whole passage
         * evenly and the fungi stop being the light in the room, which is the
         * whole lighting design. The first attempt used 0.19 and 0.17 and the
         * result was a uniformly lit corridor with no darkness anywhere in it.
         */
        float near = exp(-dist * 0.30) * max(dot(n, normalize(toEye)), 0.0);
        near *= 0.62 + 0.5 * grain + 0.24 * bed;

        /**
         * ALBEDO TIMES LIGHT, PLUS LIGHT. vLit is baked irradiance — the
         * fungi, already multiplied by the rock's own colour on the CPU — and
         * it is ADDED rather than folded into the near-field product. It was
         * folded in at first, which meant a cluster twenty metres away made the
         * wall next to your face glow: the baked term was acting as albedo, so
         * the closer you stood to anything the more of somebody else's light
         * came off it. Light does not work that way and the cave came out a
         * uniform luminous teal.
         */
        vec3 col = vRock * (0.016 + near * 0.36);
        col += vLit * (0.78 + 0.44 * grain);
        col += uDay * vDay * uDayGain;
        col *= 0.78 + grain * 0.42;

        /**
         * THE TWILIGHT ZONE, which is the one cue everybody recognises and
         * nobody can name.
         *
         * Moss, algae and fern grow on cave rock as far back as usable daylight
         * reaches and then STOP, in a line you could draw with a ruler. That
         * line, not the arch, is where a cave begins — it is a biological
         * measurement of how far in the sun gets, and walking through it is the
         * moment the outside is over.
         *
         * It rides on vDay, which already knows exactly that, and on the
         * normal, because the green is on the surfaces the light lands on.
         * Patched by the grain so it is a colonisation rather than a coat of
         * paint: bare rock between, more of it the further in you go.
         */
        float moss = smoothstep(0.035, 0.21, vDay) * clamp(n.y * 0.45 + 0.62, 0.0, 1.0);
        moss *= smoothstep(0.30, 0.74, grain);
        col = mix(col, col * 0.5 + uMoss * (0.42 + near * 0.85), moss * 0.72);

        /**
         * Water, in the same material and therefore in the same draw.
         *
         * There is no light DIRECTION anywhere in this shader — the fungi are
         * baked irradiance and nothing else down here emits — so the usual
         * specular is unavailable, and a flat dark quad is what you get without
         * one. What sells still water instead is fresnel: a pool is nearly black
         * looked straight down into and a mirror at a grazing angle, and that is
         * a function of the view vector alone.
         *
         * Two sines for the ripple rather than a noise fetch, with their
         * derivatives taken analytically for the normal. The whole surface is a
         * few hundred pixels and it is inside the branch that covers every
         * pixel in the frame, so the cost of being tasteful here is real.
         */
        if (vWet > 0.5) {
          float wx = vWorld.x * 3.3 + uTime * 0.5;
          float wz = vWorld.z * 2.7 - uTime * 0.38;
          vec3 wn = normalize(vec3(cos(wx) * 0.07 + cos(wz * 0.7) * 0.03, 1.0,
                                   cos(wz) * 0.06 + cos(wx * 0.6) * 0.03));
          vec3 v = normalize(toEye);
          float fres = pow(1.0 - clamp(dot(wn, v), 0.0, 1.0), 4.0);
          float spark = pow(max(0.0, sin(wx * 1.7) * sin(wz * 1.3)), 12.0);
          vec3 water = vRock * 0.05
                     + vLit * (0.5 + 3.4 * fres + 2.2 * spark)
                     + uDay * vDay * uDayGain * 0.7;
          col = mix(col, water, clamp((vWet - 0.5) * 2.0, 0.0, 1.0));
        }

        /**
         * The crag, lit like anything else standing in the open.
         *
         * MIXED, NOT ADDED. Adding daylight to a surface that also carries the
         * cave's own terms would make the underside of the lip — which is both
         * outside and in shadow — brighter than the rock beside it, and the two
         * models disagree by about a factor of ten. vOut is a geometric fact
         * (how far above the ground this vertex is) and reads as one: the crag
         * is daylit, the passage is not, and the metre or so where they overlap
         * is the doorway.
         *
         * The grain term is carried into it deliberately. It is the only thing
         * making a 3 500-triangle shell look like rock rather than like a
         * balloon, and the open-air half needs it more than the dark half does,
         * because outside there is a sun to show up how smooth a surface is.
         */
        if (vOut > 0.0015) {
          float lam = max(dot(n, uSunDir), 0.0);
          vec3 sky = mix(uOpenGround, uOpenSky, n.y * 0.5 + 0.5);
          // 0.62 + 0.5 grain rather than a flat multiplier: on a lit surface the
          // grain has to carry most of the small-scale variation, because the
          // twenty vertices to a ring cannot.
          vec3 open = vRock * (sky + uOpenSun * lam) * (0.62 + 0.5 * grain + 0.28 * bed);
          col = mix(col, open, vOut);
        }

        if (uLevel > 0.0005) {
          float f = rrFbm2(vWorld * 0.055 + vec3(0.0, uTime * 0.03, 0.0));
          col = rrHueRotate(col, f * 1.5 * uLevel);
          float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(vec3(lum), col, 1.0 + uSat * 1.2);
          /**
           * Veins. The rock in a forest is inert and the rock in a cave at the
           * peak is not — this is the same self-luminous term living.js puts
           * on bark, keyed to the same uniform, so the underground comes up with
           * the wood instead of on its own schedule.
           */
          float vein = rrFbm2(vWorld * 0.42 + vec3(uTime * 0.05));
          /**
           * A NARROW band, and the first tuning was not.
           *
           * 0.16-0.62 selects roughly a third of the surface, and a third of
           * the surface at nearly unit brightness is not a vein, it is a
           * repaint: at the peak the whole passage went to clipped violet and
           * the bloom smeared what was left. It matters more underground than
           * it does in the wood because there is nothing else lit down here to
           * hold a scale against — in the forest the same term sits next to a
           * sunlit trunk and reads as an accent.
           */
          vein = smoothstep(0.27, 0.40, abs(vein)) * (1.0 - smoothstep(0.40, 0.55, abs(vein)));
          col += rrHueRotate(vec3(0.35, 0.85, 0.72), uTime * 0.11 + vWorld.y * 0.05)
               * vein * uGlow * (0.26 + uAudio.x * 0.4) * (1.0 + uSurge * 0.7);
          col *= 1.0 + uDetail * grain * 0.35;
        }

        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vDepthFog * vDepthFog);
        col = mix(col, fogColor, clamp(fogFactor, 0.0, 1.0));

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

/** The glowing heads themselves: additive sprites, same idiom as the motes. */
function fungusMaterial() {
  return new THREE.ShaderMaterial({
    name: 'cave-fungi',
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: tripUniforms.uTime,
      uLevel: tripUniforms.uLevel,
      uAudio: tripUniforms.uAudio,
      uMap: { value: glowSprite({ key: 'cave-fungus', inner: 'rgba(220,255,244,0.98)' }) },
      uPixelRatio: { value: 1 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uPixelRatio;
      attribute vec3 aTint;
      attribute float aSeed;
      attribute float aSize;
      varying vec3 vTint;
      varying float vFade;
      void main() {
        vTint = aTint;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dist = -mv.z;
        // A slow, out-of-phase pulse per head, so a cluster shimmers rather
        // than blinking in unison.
        float breathe = 0.72 + 0.28 * sin(uTime * (0.5 + aSeed * 0.7) + aSeed * 31.4);
        vFade = breathe * smoothstep(64.0, 26.0, dist);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = min(30.0, aSize * uPixelRatio * 46.0 / max(dist, 0.8));
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uLevel;
      uniform vec4 uAudio;
      varying vec3 vTint;
      varying float vFade;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a * vFade * (0.55 + uLevel * 0.5)
                * (1.0 + uAudio.w * 0.6);
        if (a < 0.004) discard;
        gl_FragColor = vec4(vTint * a, a);
      }
    `,
  });
}

/* -------------------------------------------------------------------------- */
/*  building one cave                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The build is sliced across frames, and that is not caution.
 *
 * A 200 m passage is ~3 600 vertices, each one two fbm lookups for the rock plus
 * a walk over every fungus cluster for the baked light — measured at 4.1 ms in
 * one go on this machine, which is a whole frame at 240 Hz and most of one at
 * 144. The stated requirement for this session is no frame drops, and 4 ms
 * arriving unannounced while somebody is walking is a drop. RINGS_PER_FRAME
 * spreads it over five or six frames at well under a millisecond each.
 *
 * There is no worker, deliberately. A worker would need this module's realm to
 * be told the world seed and to keep it in step with the main thread's — the
 * trap `ground.js` and `terrain-worker.js` each spend a screen of comment on,
 * whose failure mode is silent and looks like a different bug. Slicing gets the
 * same frame profile for none of that risk, because unlike a ground chunk
 * nothing is waiting on the result: the build is armed at BUILD_RANGE, which is
 * half a minute of sprinting from the mouth.
 */
const RINGS_PER_FRAME = 42;

class Cave {
  constructor(descriptor) {
    this.c = descriptor;
    this.path = null;
    /** The main passage and its branches. `paths[0] === path`. */
    this.paths = null;
    this.blocks = null;
    this.spires = null;
    this.water = null;
    this.fungi = null;
    this.mesh = null;
    this.points = null;
    this.group = new THREE.Group();
    this.group.name = `cave-${descriptor.k}`;
    this.ready = false;
    this._ring = 0;
    this._ex = 0;
    this._hood = 0;
    this._buffers = null;
  }

  /** Everything the collision line needs, and nothing that touches the GPU. */
  prepare() {
    if (this.path) return;
    const walk = buildNodes(this.c);
    this.path = resample(walk.nodes);
    this.path.base = -1;
    this.path.baseAlong = 0;
    this.fungi = placeFungi(this.c, this.path, 'main', 14);
    // At least one hooded ring, or the taper in `step` divides by zero and the
    // whole mouth comes out NaN — which draws as nothing, silently.
    this._hood = Math.max(1, exposedRings(this.path));
    const n = this.path.x.length;
    /**
     * Ring 0 is the mouth and the last ring is the point the sweep collapses
     * to; the origin is put at ring 0 so every vertex coordinate is a small
     * number. Local coordinates matter here for the same reason they do in
     * `heightGrid`: a cave 8 km from the origin would otherwise carry world
     * coordinates in float32, which resolves to about a millimetre there — and
     * the trip reads `position` in object space before the model matrix.
     */
    this.originX = this.path.x[0];
    this.originY = this.path.y[0];
    this.originZ = this.path.z[0];
    // Metres along the passage, for the daylight falloff and for the audio.
    const along = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      along[i] =
        along[i - 1] +
        Math.hypot(
          this.path.x[i] - this.path.x[i - 1],
          this.path.y[i] - this.path.y[i - 1],
          this.path.z[i] - this.path.z[i - 1]
        );
    }
    this.along = along;
    this.path.along = along;
    this.length = along[n - 1];
    this.blind = blindAlong(this.path, along);
    this.path.blind = this.blind;

    /**
     * The bedding dip, per cave. See the `bed` block in the fragment shader.
     *
     * A near-vertical normal is a near-horizontal bed. 0.13 to 0.42 radians off
     * vertical is the range that reads as tilted rather than as either a floor
     * or a wall, and the bearing is free — so two caves in the same ridge have
     * different dips, which is wrong geologically and right visually, because
     * the alternative is that every cave in the world is the same rock.
     */
    const bedRng = makeRng(`${getWorldSeed()}:cave-bed:${this.c.k}`);
    const dip = rngRange(bedRng, 0.13, 0.42);
    const bearing = rngRange(bedRng, 0, TAU);
    this.bedX = Math.sin(dip) * Math.cos(bearing);
    this.bedY = Math.cos(dip);
    this.bedZ = Math.sin(dip) * Math.sin(bearing);
    /** How high the passage floods, above the floor. See `_shade`. */
    this.flood = rngRange(bedRng, 1.4, 3.6);

    /**
     * The branches, and where they are allowed to be.
     *
     * Past BRANCH_MIN_RING because a lead within sight of the entrance is a lead
     * that can see the entrance, and `occludeWorld` would then be deciding
     * whether to delete the forest based on a sight line down a passage it never
     * measured. Spaced 26 rings apart because two junctions inside thirty metres
     * is a maze, and a maze is a different feature with a different set of
     * problems — chiefly that you cannot make one legible with fungi.
     */
    this.paths = [this.path];
    const brRng = makeRng(`${getWorldSeed()}:cave-branches:${this.c.k}`);
    const want = n > 90 ? 1 + Math.floor(brRng() * 3) : n > 55 ? 1 : 0;
    let cursor = BRANCH_MIN_RING + Math.floor(brRng() * 14);
    for (let b = 0; b < want && cursor < n - 26; b++) {
      const br = buildBranch(this.c, this.path, walk.joints, cursor, `${b}`);
      if (br) {
        br.baseAlong = along[cursor];
        /**
         * A branch is blind ten metres in, and that is a measurement rather than
         * a guess: it leaves through the WALL, so the mouth is behind a corner
         * of at least sixty degrees from the first node onward. Ten metres past
         * that there is no line to daylight from anywhere in it. Branches are
         * also all past BRANCH_MIN_RING, so this is never smaller than the main
         * passage's own blind distance at the junction.
         */
        br.blind = br.baseAlong + 10;
        const bn = br.x.length;
        const bAlong = new Float64Array(bn);
        for (let i = 1; i < bn; i++) {
          bAlong[i] =
            bAlong[i - 1] +
            Math.hypot(br.x[i] - br.x[i - 1], br.y[i] - br.y[i - 1], br.z[i] - br.z[i - 1]);
        }
        br.along = bAlong;
        this.paths.push(br);
        for (const g of placeFungi(this.c, br, `br${b}`, 3)) this.fungi.push(g);
      }
      cursor += 26 + Math.floor(brRng() * 30);
    }

    /**
     * Everything that is not the tube. Planned here, on the CPU, with no GPU
     * contact — same contract as the centre line, and for the same reason: the
     * body has to be able to collide with a breakdown block before the mesh
     * carrying it exists.
     */
    this.water = [];
    this.blocks = [];
    this.spires = [];
    for (let p = 0; p < this.paths.length; p++) {
      const path = this.paths[p];
      const tag = p === 0 ? 'main' : `br${p}`;
      for (const run of placeWater(this.c, path, tag)) this.water.push({ path: p, ...run });
      const blocks = placeBlocks(this.c, path, tag);
      const spires = placeSpires(this.c, path, tag);
      for (const b of blocks) b.path = p;
      for (const s of spires) s.path = p;
      this.blocks.push(...blocks);
      this.spires.push(...spires);
      /**
       * Obstacles, bucketed by ring so the body can find them in a slice rather
       * than a scan. `caveSample` already knows which ring it is nearest; this
       * makes "what is on the floor here" the same question.
       */
      const obs = [];
      for (const b of blocks) obs.push({ x: b.x, z: b.z, y: b.y, rad: b.rad, top: b.top, ring: b.ring, kind: 0 });
      for (const s of spires) {
        if (s.kind !== 'column') continue;
        obs.push({ x: s.x, z: s.z, y: s.y0, rad: s.rad + 0.1, top: s.y1 - s.y0, ring: s.ring, kind: 1 });
      }
      obs.sort((a, b) => a.ring - b.ring);
      const at = new Int32Array(path.x.length + 1);
      let k = 0;
      for (let i = 0; i <= path.x.length; i++) {
        while (k < obs.length && obs[k].ring < i) k++;
        at[i] = k;
      }
      path.obstacles = obs;
      path.obsAt = at;
    }

    /**
     * The slot map: which path and which ring each vertex row belongs to.
     *
     * `step()` emits rows by a single integer cursor so the slicing stays as
     * simple as it was when there was one path, and this is what lets it: two
     * small integer arrays built once, instead of a search per row or a closure
     * per ring.
     */
    let rows = 0;
    for (const p of this.paths) {
      p.vstart = rows;
      rows += p.x.length;
    }
    this._rows = rows;
    this._pathAt = new Int32Array(rows);
    this._ringAt = new Int32Array(rows);
    for (let p = 0; p < this.paths.length; p++) {
      const path = this.paths[p];
      for (let i = 0; i < path.x.length; i++) {
        this._pathAt[path.vstart + i] = p;
        this._ringAt[path.vstart + i] = i;
      }
    }

    const hood = this._hood;
    const ringVerts = (rows + hood + 1) * RADIAL;
    let exVerts = 0;
    let exIdx = 0;
    for (const _b of this.blocks) {
      exVerts += 24;
      exIdx += 36;
    }
    for (const s of this.spires) {
      // Column: 2 bands x 8 facets x 4. Drape: 5 panels x 4, both sides.
      exVerts += s.kind === 'column' ? 64 : s.kind === 'drape' ? 40 : 18;
      exIdx += s.kind === 'column' ? 96 : s.kind === 'drape' ? 60 : 18;
    }
    for (const run of this.water) {
      const len = run.i1 - run.i0;
      exVerts += len * 4;
      exIdx += Math.max(0, len - 1) * 6;
    }

    const verts = ringVerts + exVerts;
    this._buffers = {
      position: new Float32Array(verts * 3),
      normal: new Float32Array(verts * 3),
      rock: new Float32Array(verts * 3),
      lit: new Float32Array(verts * 3),
      surf: new Float32Array(verts * 4),
      index: new Uint32Array((rows + hood + 1) * RADIAL * 6),
      exIndex: new Uint32Array(exIdx),
      /** Cursors: the lattice is fixed-stride, the extras are not. */
      vert: ringVerts,
      ex: 0,
      tri: 0,
    };
  }

  /**
   * Emit up to RINGS_PER_FRAME rings. Returns true when the mesh is complete.
   *
   * The inner surface is emitted first, ring by ring, then the hood's outer
   * shell, then the rim that joins them. Keeping the hood at the END of the
   * buffer rather than interleaved is what lets both be a plain regular grid,
   * which is what makes the normals below a difference rather than a
   * face-averaging pass — see `heightGrid` in terrain.js for why an averaged
   * normal on a shared edge is worse than it looks.
   */
  step() {
    const rows = this._rows;
    const hood = this._hood;
    const total = rows + hood + 1;
    let budget = RINGS_PER_FRAME;

    while (this._ring < total && budget > 0) {
      const ri = this._ring;
      // Every path's rings, then the hood's shell over the main path's leading
      // ones. The slot map built in `prepare` is what keeps this a single
      // integer cursor now that there is more than one passage to sweep.
      const isHood = ri >= rows;
      if (isHood) {
        // 1 at the rim, 0 at the last hooded ring. Everything the crag does is a
        // function of this one number.
        this._emitRing(ri, this.path, Math.min(ri - rows, hood), 1 - (ri - rows) / hood, true);
      } else {
        this._emitRing(ri, this.paths[this._pathAt[ri]], this._ringAt[ri], 0, false);
      }
      this._ring++;
      budget--;
    }
    if (this._ring < total) return false;

    /**
     * Then the things standing on the floor and hanging from the roof, at four
     * to a ring's worth of budget.
     *
     * A block is 24 vertices against a ring's 24, but nearly all of a ring's
     * cost is the two fbm lookups and the fungus walk per vertex — an extra is
     * shaded from its host ring's numbers, so it is genuinely about a quarter of
     * the work. Counting them at all matters: a room can carry sixty blocks and
     * a hundred formations, and emitting those in one go is the 4 ms hitch this
     * whole slicing scheme exists to avoid.
     */
    const items = this.blocks.length + this.spires.length + this.water.length;
    while (this._ex < items && budget > 0) {
      this._emitExtra(this._ex);
      this._ex++;
      budget -= 0.25;
    }
    if (this._ex < items) return false;

    this._link(hood);
    this._finish();
    return true;
  }

  _emitRing(slot, path, i, taper, isHood) {
    const b = this._buffers;
    const n = path.x.length;
    const sh = ringShape(path, i, _shapeA);
    let cx = path.x[i];
    let cy = path.y[i];
    let cz = path.z[i];
    const r = path.r[i];
    const thick = isHood ? HOOD_THICK * taper : 0;
    // Squared, so the crag is a mass at the doorway and not a ridge up the hill.
    const lip = taper * taper;

    // Tangent by central difference, then a right/up basis about it. `up` is
    // kept near world up rather than parallel-transported: the passage never
    // pitches past 0.44 rad, so there is no twist to transport, and a floor that
    // stays a floor is worth more than a mathematically tidy frame.
    const a = Math.max(0, i - 1);
    const c2 = Math.min(n - 1, i + 1);
    let tx = path.x[c2] - path.x[a];
    let ty = path.y[c2] - path.y[a];
    let tz = path.z[c2] - path.z[a];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    // right = normalize(tangent x up)
    let rx = -tz;
    let rz = tx;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl;
    rz /= rl;
    // up = right x tangent
    const ux = -rz * ty;
    const uy = rz * tx - rx * tz;
    const uz = rx * ty;
    const ul = Math.hypot(ux, uy, uz) || 1;

    /**
     * The collar steps back OUT of the mouth, along the tube's own tangent.
     *
     * Hood ring zero shares its path index with cavity ring zero, so without
     * this the two are coincident and the rim strip between them is a flat
     * washer standing in the mouth plane — thickness you can only see edge-on.
     * Moving the shell's first rings a couple of metres down the gully gives the
     * lip a front face, and it is the front face that reads as an overhang from
     * outside.
     *
     * It moves the whole ring rather than only its upper half, because the lower
     * half goes into the gully floor and the ground hides it — a shell that
     * flared only upward would part company with the terrain at its shoulders.
     */
    if (isHood) {
      const out = HOOD_FLARE * lip;
      cx -= tx * out;
      cy -= ty * out;
      cz -= tz * out;
    }

    const day = this._daylight(path, i);
    const sec = { x: 0, y: 0 };
    /** Metres along this passage, for the scallops and the flowstone patches. */
    const alongHere = path.along ? path.along[i] : i * RING_STEP;
    const scal = isHood ? 0 : path.scal[i];
    const seep = isHood ? 0 : path.seep[i];
    const wetRing = isHood ? 0 : path.wet[i];
    // How wide the water is here, and how far the visible floor is scooped out
    // under it. See `placeWater` — the body still walks the analytic floor, so
    // this is a channel the stream sits IN rather than a step the player takes.
    const waterHalf = wetRing > 0.01 ? Math.min(1.7, r * sh.w * 0.55) * wetRing : 0;
    const troughMax = 0.12 + 0.30 * (isHood ? 0 : path.pool[i]);

    for (let j = 0; j < RADIAL; j++) {
      const phi = (j / RADIAL) * TAU - Math.PI * 0.5;
      section(phi, sh, sec);
      const floorish = clamp01(-sec.y / Math.max(sh.f, 1e-3));
      /**
       * THE SHELL IS FAR ROUGHER THAN THE CAVITY, AND MOST OF ALL WHERE IT IS
       * OUT IN THE LIGHT.
       *
       * Inside, ROUGH is a texture on something you only ever see by fungus
       * light at two metres. The crag is the width of the doorway plus its own
       * thickness, standing in an afternoon against a hillside, and at the
       * cavity's own amplitude it came out a smooth pale dome — inflated
       * rather than quarried,
       * because a sun on a smooth surface is the most reliable way to say
       * "balloon" there is. Nobody walks on it, so the reason the floor is
       * nearly flat (ROUGH_FLOOR) does not apply, and it can take as much
       * displacement as the silhouette needs.
       */
      const rough = isHood ? ROUGH : Math.max(ROUGH_FLOOR, path.rough[i]);
      const amp =
        r * (ROUGH_FLOOR + (rough - ROUGH_FLOOR) * (1 - floorish)) * (isHood ? 1.6 + 2.6 * lip : 1);

      // Position on the smooth outline, then displaced radially by the rock.
      let ox = sec.x * r;
      let oy = sec.y * r;
      const outLen = Math.hypot(ox, oy) || 1;
      const px0 = cx + rx * ox + (ux / ul) * oy;
      const py0 = cy + (uy / ul) * oy;
      const pz0 = cz + rz * ox + (uz / ul) * oy;
      const rn = rock(px0, py0, pz0);

      /**
       * Scallops, outward — they are hollows, so they make the passage bigger.
       *
       * Killed on the floor (`1 - floorish`), because the floor of a passage is
       * sediment and rubble and does not carry the wall's record of the flow,
       * and killed on the hood, where the surface is a hillside rather than
       * something water was ever inside.
       */
      const sc = scal > 0.02 ? scallop(alongHere, phi, this.c.k) * scal * r * 0.055 * (1 - floorish) : 0;

      /**
       * Flowstone, inward — it is deposited ON the wall, so it takes room away.
       *
       * Patchy by construction: one fbm over (along, phi) thresholded high, so
       * most of the wall is bare and a few metres of it are a sheet. Weighted
       * toward the upper wall, because it got there by running down from a joint
       * in the ceiling, and a flowstone patch that starts at the floor is a
       * flowstone patch that came from nowhere.
       */
      let seepF = 0;
      if (seep > 0.02) {
        const s = fbm2(alongHere * 0.33 + phi * 1.9, phi * 2.6 - alongHere * 0.11, 2) * 2.2 + 0.2;
        seepF = clamp01((clamp01(s) - 0.55) * 2.6) * seep * clamp01(0.3 + sec.y / Math.max(sh.t, 0.2));
      }
      const calcite = clamp01(seepF * 1.7);

      // The brow: the shell is thicker over the doorway than under it, where
      // there is only hillside to be thick into. See HOOD_BROW.
      const disp =
        rn * amp +
        sc -
        seepF * r * 0.075 +
        thick * (1 + (isHood ? HOOD_BROW * clamp01(sec.y / sh.t) : 0));
      ox += (ox / outLen) * disp;
      oy += (oy / outLen) * disp;

      let px = cx + rx * ox + (ux / ul) * oy;
      let py = cy + (uy / ul) * oy;
      let pz = cz + rz * ox + (uz / ul) * oy;

      // The stream's channel, cut into the visible floor only.
      if (waterHalf > 0 && floorish > 0.5) {
        const acrossN = Math.abs(sec.x * r) / (waterHalf * 1.3);
        if (acrossN < 1) py -= troughMax * (1 - acrossN * acrossN) * (floorish - 0.5) * 2;
      }

      /**
       * Bury the shell — but ONLY where there is a hillside to bury it in.
       *
       * Where the terrain already stands over the cavity, the shell is pulled to
       * just under it, so the built rock and the grown rock meet inside the hill
       * and the join is not on screen anywhere. That is the whole trick of the
       * mouth.
       *
       * The `surf > inner` guard is not defensive, it is the difference between
       * an arch and a razor. At the rim the terrain is the GULLY FLOOR, metres
       * below the cavity's ceiling, so an unguarded clamp collapses the top of
       * the shell onto the tube it is shelling — and the one part of the cave
       * you always see from outside becomes a paper edge with no thickness at
       * all. Where the hillside is lower than the hole, the shell keeps its full
       * thickness and IS the overhang.
       *
       * AND IT IS BURIED TO A LINE ABOVE THE GROUND, NOT TO THE GROUND.
       *
       * `proud` is the whole of the crag. Where the hillside covers the cavity
       * the shell is still clamped — the seam is still made inside the hill —
       * but the line it is clamped to is up to HOOD_PROUD metres over the
       * surface at the rim, falling to zero by the last hooded ring, at which
       * point this is the old flush burial exactly. What emerges is a mass of
       * the same rock the passage is made of, standing out of the slope around
       * the doorway, and it is lit by the same shader, so it is not a decal
       * stuck on a hillside.
       *
       * Modulated by `rn` — the same displacement field the walls use — so the
       * mass is lopsided. An even allowance gives an even collar, and an even
       * collar looks built.
       */
      let outside = 0;
      if (isHood) {
        const inner = cy + (uy / ul) * (sec.y * r);
        const surf = heightAt(px, pz) - 0.18;
        const proud = HOOD_PROUD * lip * (0.35 + 0.9 * clamp01(rn * 0.5 + 0.5));
        if (surf > inner && py > surf + proud) py = surf + proud;
        /**
         * …and how much daylight it is standing in, which is the SAME QUESTION
         * asked of the same two numbers.
         *
         * A vertex a metre and a half over the ground is in the open and is lit
         * like it; one below the ground is not there as far as anybody can see.
         * Deriving it here rather than from a flag is what keeps the two halves
         * of the shell from disagreeing: whatever the burial clamp decided, the
         * lighting agrees with it by construction.
         */
        outside = clamp01((py - surf + 0.3) / 1.4);
      }

      const vi = slot * RADIAL + j;
      const k = vi * 3;
      b.position[k] = px - this.originX;
      b.position[k + 1] = py - this.originY;
      b.position[k + 2] = pz - this.originZ;
      const k4 = vi * 4;
      b.surf[k4] = isHood ? day * 0.35 : day;
      b.surf[k4 + 1] = outside;
      b.surf[k4 + 2] = px * this.bedX + py * this.bedY + pz * this.bedZ;
      b.surf[k4 + 3] = 0;
      // Height above this ring's floor, for the flood line. Taken from the
      // analytic floor rather than from the vertex's own displacement, so the
      // line is level across a wall that is not.
      const above = py - (cy - r * sh.f);
      this._shade(vi, px, py, pz, floorish, calcite, above, wetRing);
    }
  }

  /**
   * Daylight, as a function of distance along the passage.
   *
   * Exponential rather than linear and with a short constant: 14 m is about
   * where a real cave stops having any sky in it, and matching that is what
   * makes the mouth read as bright from inside instead of as a gradient. The
   * fungi start just past where this has gone (see `placeFungi`), so the two
   * lighting schemes hand over rather than overlapping into grey.
   */
  _daylight(path, i) {
    const g = (path.baseAlong ?? 0) + (path.along ? path.along[i] : i * RING_STEP);
    return Math.exp(-g / 14) * 0.42;
  }

  /** Baked albedo, and separately the baked light landing on it. */
  _shade(vi, x, y, z, floorish, calcite = 0, above = 99, damp = 0) {
    const b = this._buffers;
    const k = vi * 3;
    /**
     * The rock's own colour, and it is deliberately not grey.
     *
     * A neutral cave is a cave that goes dead the moment the fog turns
     * near-black, because there is nothing left for the light to be a colour OF.
     * A cold slate with a warm iron streak through it gives the fungus light
     * something to sit against, and gives the trip's hue rotation two hues to
     * pull apart instead of one.
     */
    const vein = clamp01(fbm2(x * 0.09, z * 0.09 + y * 0.14, 2) * 1.6 + 0.5);
    let cr = 0.30 + vein * 0.22;
    let cg = 0.30 + vein * 0.15;
    let cb = 0.34 + vein * 0.06;
    // Damp, dark floor. Real cave floors are mud and rubble, not the walls.
    const wet = 1 - floorish * 0.42;
    cr *= wet;
    cg *= wet;
    cb *= wet;
    const mottle = noise2(x * 1.4, z * 1.4 + y * 0.8) * 0.16;
    cr = clamp01(cr + mottle);
    cg = clamp01(cg + mottle);
    cb = clamp01(cb + mottle);

    /**
     * THE FLOOD LINE, WHICH IS THE ONE DETAIL DOWN HERE THAT FRIGHTENS PEOPLE.
     *
     * A mud line four metres up the wall, and sticks jammed in a crack above
     * your head, is how a caver finds out that the room they are standing in is
     * periodically a pipe. It is not a jump scare and it is not signposted; it
     * is a stain, and everybody who understands it goes quiet.
     *
     * Costs nothing: it is a band in the vertex colour, keyed to height above
     * the analytic floor, which `_emitRing` has already worked out. Brown and
     * dull below the line — silt gets everywhere it reaches — with a darker,
     * narrower band right at the top of it where the water stood longest.
     */
    const flood = this.flood;
    if (above < flood + 0.35) {
      const silt = clamp01(1 - above / (flood + 0.35));
      const band = clamp01(1 - Math.abs(above - flood) / 0.28);
      const mud = clamp01(silt * 0.45 + band * 0.55);
      cr = lerp(cr, 0.20 + mottle * 0.5, mud * 0.55);
      cg = lerp(cg, 0.155 + mottle * 0.4, mud * 0.55);
      cb = lerp(cb, 0.105 + mottle * 0.3, mud * 0.55);
    }

    /**
     * Calcite is not grey rock and painting it grey wastes the geometry.
     *
     * Flowstone and speleothems are almost white where they are clean and honey
     * where iron got into them, and they are the only bright thing in a passage
     * — which is why a lamp finds them from thirty metres and why they are what
     * anybody remembers. Warm, because the rock around them is deliberately
     * cold: see the vein note above.
     */
    if (calcite > 0) {
      /**
       * BRIGHTER THAN THE ROCK, NOT BRIGHT. This was 0.72 and it was a mistake
       * that only shows up standing next to one: the near-field term already
       * multiplies anything facing you at arm's length by about 0.4, so an
       * albedo that high comes back as flat pale card and a column three feet
       * away fills the frame with what looks like painted hardboard. Roughly
       * half the rock's distance from black is enough to read as "the only
       * light-coloured thing down here", which is all calcite has to do.
       *
       * Carried on the same `mottle` the rock uses, so it is not a flat fill.
       * A speleothem is banded — it was deposited in layers, over a very long
       * time, and the layers are what stop it looking moulded.
       */
      const band = mottle * 2.4 + noise2(y * 3.1, (x + z) * 0.9) * 0.12;
      cr = lerp(cr, clamp01(0.46 + band), calcite);
      cg = lerp(cg, clamp01(0.40 + band), calcite);
      cb = lerp(cb, clamp01(0.33 + band), calcite);
    }

    // Wet rock is dark rock. The bank of a stream is the darkest thing here.
    if (damp > 0 && floorish > 0.35) {
      const d = damp * clamp01((floorish - 0.35) / 0.4) * 0.45;
      cr *= 1 - d;
      cg *= 1 - d;
      cb *= 1 - d;
    }

    let lr = 0;
    let lg = 0;
    let lb = 0;
    const fungi = this.fungi;
    for (let f = 0; f < fungi.length; f++) {
      const g = fungi[f];
      const dx = g.x - x;
      const dy = g.y - y;
      const dz = g.z - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > FUNGUS_REACH * FUNGUS_REACH) continue;
      // Quadratic falloff with a soft cut at the reach, so a cluster does not
      // draw a circle on the wall where its influence stops.
      const t = 1 - Math.sqrt(d2) / FUNGUS_REACH;
      const fall = t * t * g.power * 0.29;
      lr += g.colour.r * fall;
      lg += g.colour.g * fall;
      lb += g.colour.b * fall;
    }

    b.rock[k] = cr;
    b.rock[k + 1] = cg;
    b.rock[k + 2] = cb;
    // Irradiance times albedo, done here so the shader adds one term instead of
    // multiplying two. See the note in the fragment shader.
    b.lit[k] = cr * lr;
    b.lit[k + 1] = cg * lg;
    b.lit[k + 2] = cb * lb;
  }

  /* ---- the things that are not the tube ---------------------------------- *
   *
   * All of it goes into the SAME buffers and therefore the same draw. A cave is
   * one mesh whether it has sixty breakdown blocks in it or none, which is the
   * only reason any of this was affordable: the alternative — a Mesh per class
   * of object, or worse per object — is sixty draw calls and sixty bounding
   * spheres to cull, for geometry that is always either entirely visible or
   * entirely behind a hillside.
   *
   * They carry their own normals rather than going through `_finish`'s lattice
   * pass, because they are not a lattice. That also means they can be FLAT
   * shaded, which is most of why a breakdown block reads as broken rock: a
   * smooth-normalled boulder is a potato.
   */

  /** One vertex, shaded, into the extras region. Returns its index. */
  _push(px, py, pz, nx, ny, nz, day, wet, calcite, floorish, above, damp) {
    const buf = this._buffers;
    const vi = buf.vert++;
    const k = vi * 3;
    buf.position[k] = px - this.originX;
    buf.position[k + 1] = py - this.originY;
    buf.position[k + 2] = pz - this.originZ;
    buf.normal[k] = nx;
    buf.normal[k + 1] = ny;
    buf.normal[k + 2] = nz;
    const k4 = vi * 4;
    buf.surf[k4] = day;
    buf.surf[k4 + 1] = 0;
    buf.surf[k4 + 2] = px * this.bedX + py * this.bedY + pz * this.bedZ;
    buf.surf[k4 + 3] = wet;
    this._shade(vi, px, py, pz, floorish, calcite, above, damp);
    return vi;
  }

  _tri(a, b, c) {
    const buf = this._buffers;
    buf.exIndex[buf.ex++] = a;
    buf.exIndex[buf.ex++] = b;
    buf.exIndex[buf.ex++] = c;
  }

  /**
   * A flat-shaded quad whose winding is DERIVED rather than asserted.
   *
   * The winding rule in `_link` is famously the opposite of the obvious one and
   * getting it wrong is silent — the surface simply is not drawn. Rather than
   * reason about it six more times per block, this takes a point that is inside
   * the solid and flips the face if the computed normal points at it. Four
   * subtractions and a dot per face, at build time, to make an entire class of
   * invisible bug impossible.
   */
  _face(p, q, r, s, inside, day, calcite, floorish, above, damp, wet = 0) {
    let ax = q[0] - p[0];
    let ay = q[1] - p[1];
    let az = q[2] - p[2];
    const bx = r[0] - p[0];
    const by = r[1] - p[1];
    const bz = r[2] - p[2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const cx = (p[0] + q[0] + r[0] + (s ? s[0] : r[0])) / (s ? 4 : 3);
    const cy = (p[1] + q[1] + r[1] + (s ? s[1] : r[1])) / (s ? 4 : 3);
    const cz = (p[2] + q[2] + r[2] + (s ? s[2] : r[2])) / (s ? 4 : 3);
    const flip = nx * (inside[0] - cx) + ny * (inside[1] - cy) + nz * (inside[2] - cz) > 0;
    if (flip) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const pts = s ? [p, q, r, s] : [p, q, r];
    const idx = pts.map((v) =>
      this._push(v[0], v[1], v[2], nx, ny, nz, day, wet, calcite, floorish, above, damp)
    );
    if (flip) {
      if (s) {
        this._tri(idx[0], idx[2], idx[1]);
        this._tri(idx[0], idx[3], idx[2]);
      } else {
        this._tri(idx[0], idx[2], idx[1]);
      }
    } else if (s) {
      this._tri(idx[0], idx[1], idx[2]);
      this._tri(idx[0], idx[2], idx[3]);
    } else {
      this._tri(idx[0], idx[1], idx[2]);
    }
  }

  _emitExtra(k) {
    if (k < this.blocks.length) return this._emitBlock(this.blocks[k]);
    const s = k - this.blocks.length;
    if (s < this.spires.length) return this._emitSpire(this.spires[s]);
    return this._emitWater(this.water[s - this.spires.length]);
  }

  /** A breakdown block: six irregular faces, flat shaded, buried at the base. */
  _emitBlock(bl) {
    const rng = makeRng(`${getWorldSeed()}:cave-block:${this.c.k}:${bl.seed}`);
    const path = this.paths[bl.path];
    const day = this._daylight(path, bl.ring);
    const ca = Math.cos(bl.rot);
    const sa = Math.sin(bl.rot);
    const hz = bl.rad * rngRange(rng, 0.68, 1.15);
    const yTop = bl.y + bl.top;
    /**
     * The bottom goes UNDER the floor, and not by a token amount.
     *
     * A block resting exactly on the analytic floor shows a seam all the way
     * round wherever the visible floor's own displacement dips below it — which
     * is everywhere, because the floor carries 2 cm of rock noise. Sinking it
     * 0.8 m costs two triangles nobody sees and removes the entire class of
     * "the boulders are hovering" screenshots.
     */
    const yBot = bl.y - 0.8;
    const c = [];
    for (let i = 0; i < 8; i++) {
      const sx = i & 1 ? 1 : -1;
      const sz = i & 2 ? 1 : -1;
      const top = (i & 4) !== 0;
      // Per-corner jitter: a slab that has been broken, not a crate.
      const lx = sx * bl.rad * rngRange(rng, 0.7, 1.0);
      const lz = sz * hz * rngRange(rng, 0.7, 1.0);
      c.push([
        bl.x + lx * ca - lz * sa,
        top ? yTop * rngRange(rng, 0.86, 1) + bl.y * (1 - rngRange(rng, 0.86, 1)) : yBot,
        bl.z + lx * sa + lz * ca,
      ]);
    }
    const mid = [bl.x, (yTop + yBot) * 0.5, bl.z];
    const above = bl.top * 0.5;
    const faces = [
      [4, 5, 7, 6],
      [0, 2, 3, 1],
      [0, 1, 5, 4],
      [2, 6, 7, 3],
      [0, 4, 6, 2],
      [1, 3, 7, 5],
    ];
    for (const f of faces) {
      this._face(c[f[0]], c[f[1]], c[f[2]], c[f[3]], mid, day, 0, 0.85, above, 0.25);
    }
  }

  /** Stalactites, stalagmites, columns and draperies. */
  _emitSpire(sp) {
    const path = this.paths[sp.path];
    const day = this._daylight(path, sp.ring);
    const rng = makeRng(`${getWorldSeed()}:cave-spire:${this.c.k}:${sp.seed}`);
    const SEG = 6;

    if (sp.kind === 'drape') {
      /**
       * A curtain: panels along the wall with a wavy lower edge, emitted twice
       * with opposed windings. See the note in `placeSpires` for why twice.
       */
      const n = 5;
      const half = sp.run * 0.5;
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n - 0.5;
        const x = sp.x + sp.dirX * sp.run * t;
        const z = sp.z + sp.dirZ * sp.run * t;
        const drop = sp.h * (0.45 + 0.55 * Math.abs(Math.sin(t * 5.1 + sp.seed * 9)));
        pts.push([x, z, drop]);
      }
      for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const p0 = [a[0], sp.y0, a[1]];
        const p1 = [b[0], sp.y0, b[1]];
        const p2 = [b[0], sp.y0 - b[2], b[1]];
        const p3 = [a[0], sp.y0 - a[2], a[1]];
        // Two "inside" points on opposite sides: the same quad, twice, facing
        // out of each face. Half a metre either way of the sheet is enough to
        // make `_face`'s test decisive without being near another surface.
        const mx = (a[0] + b[0]) * 0.5;
        const mz = (a[1] + b[1]) * 0.5;
        const my = sp.y0 - (a[2] + b[2]) * 0.25;
        const off = 0.5;
        this._face(p0, p1, p2, p3, [mx + sp.dirZ * off, my, mz - sp.dirX * off], day, 1, 0.1, half + 2, 0);
        this._face(p0, p1, p2, p3, [mx - sp.dirZ * off, my, mz + sp.dirX * off], day, 1, 0.1, half + 2, 0);
      }
      return;
    }

    if (sp.kind === 'column') {
      /**
       * A COLUMN IS AN HOURGLASS, and a straight prism is the giveaway.
       *
       * It is a stalactite and a stalagmite that grew into each other, so it is
       * fat at both ends and pinched where they met — that waist is the entire
       * silhouette, and without it you have a post. The first version was one
       * band of six flat facets from floor to ceiling, which standing next to it
       * read as painted hardboard: no waist, no horizon, nothing for the
       * near-field light to fall off across.
       *
       * Two bands and eight facets. Sixty-four vertices for the most-looked-at
       * object in a decorated passage is not where this file's budget is.
       */
      const COL = 8;
      const inside = [sp.x, (sp.y0 + sp.y1) * 0.5, sp.z];
      const h = sp.y1 - sp.y0;
      const flute = [];
      for (let i = 0; i <= COL; i++) flute.push(rngRange(rng, 0.8, 1.18));
      flute[COL] = flute[0];
      // Fat, pinched, fat.
      const prof = (t) => sp.rad * (1 - 0.42 * Math.sin(Math.PI * t)) * (1 + 0.25 * (t - 0.5) * (t - 0.5));
      const ring = (t) => {
        const rr = prof(t);
        const y = sp.y0 + h * t;
        return { rr, y };
      };
      const bands = [
        [ring(0), ring(0.5)],
        [ring(0.5), ring(1)],
      ];
      for (const [lo, hi] of bands) {
        for (let i = 0; i < COL; i++) {
          const a0 = (i / COL) * TAU;
          const a1 = ((i + 1) / COL) * TAU;
          const f0 = flute[i];
          const f1 = flute[i + 1];
          this._face(
            [sp.x + Math.cos(a0) * lo.rr * f0, lo.y, sp.z + Math.sin(a0) * lo.rr * f0],
            [sp.x + Math.cos(a1) * lo.rr * f1, lo.y, sp.z + Math.sin(a1) * lo.rr * f1],
            [sp.x + Math.cos(a1) * hi.rr * f1, hi.y, sp.z + Math.sin(a1) * hi.rr * f1],
            [sp.x + Math.cos(a0) * hi.rr * f0, hi.y, sp.z + Math.sin(a0) * hi.rr * f0],
            inside,
            day,
            1,
            0.1,
            lo.y - sp.y0 + h * 0.25,
            0
          );
        }
      }
      return;
    }

    // A cone, up from the floor or down from the ceiling.
    const dir = sp.kind === 'mite' ? 1 : -1;
    const apex = [sp.x, sp.y0 + dir * sp.h, sp.z];
    const inside = [sp.x, sp.y0 + dir * sp.h * 0.3, sp.z];
    for (let i = 0; i < SEG; i++) {
      const a0 = (i / SEG) * TAU;
      const a1 = ((i + 1) / SEG) * TAU;
      const r0 = sp.rad * rngRange(rng, 0.8, 1.2);
      const r1 = sp.rad * rngRange(rng, 0.8, 1.2);
      this._face(
        [sp.x + Math.cos(a0) * r0, sp.y0, sp.z + Math.sin(a0) * r0],
        [sp.x + Math.cos(a1) * r1, sp.y0, sp.z + Math.sin(a1) * r1],
        apex,
        null,
        inside,
        day,
        1,
        dir > 0 ? 0.5 : 0.05,
        dir > 0 ? sp.h * 0.4 : 99,
        0
      );
    }
  }

  /**
   * The stream: a strip of quads down the middle of a run, at floor level.
   *
   * Three centimetres over the analytic floor, which is where the body walks —
   * so you are ankle-deep in it rather than walking on it, and the visible
   * channel `_emitRing` cuts under it is what makes that read as wading rather
   * than as a decal. Winding is derived from a point below the surface, so a
   * passage that pitches downhill cannot flip the water inside out.
   */
  _emitWater(run) {
    const path = this.paths[run.path];
    const n = path.x.length;
    const edge = (i) => {
      const r = path.r[i];
      const sh = ringShape(path, i, _shapeB);
      const wide = Math.min(1.7, r * sh.w * 0.55) * path.wet[i] * (1 + path.pool[i] * 0.9);
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      let tx = path.x[b] - path.x[a];
      let tz = path.z[b] - path.z[a];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const y = path.y[i] - r * sh.f + 0.03;
      return {
        l: [path.x[i] - tz * wide, y, path.z[i] + tx * wide],
        r: [path.x[i] + tz * wide, y, path.z[i] - tx * wide],
        y,
      };
    };
    let prev = edge(run.i0);
    for (let i = run.i0 + 1; i < run.i1; i++) {
      const cur = edge(i);
      // "Inside" is a metre under the surface, so the derived winding always
      // faces up however the passage is pitching. See `_face`.
      const below = [
        (prev.l[0] + cur.r[0]) * 0.5,
        (prev.y + cur.y) * 0.5 - 1,
        (prev.l[2] + cur.r[2]) * 0.5,
      ];
      this._face(prev.l, prev.r, cur.r, cur.l, below, this._daylight(path, i), 0, 1, 0.02, 1, 1);
      prev = cur;
    }
  }

  /**
   * Index the two grids, then the rim strip that closes the hood's front.
   *
   * THE WINDING IS THE OPPOSITE OF EVERY TUBE YOU HAVE EVER WRITTEN, and
   * getting it backwards is silent. The material is `FrontSide`, so a cavity
   * wound outward is simply not drawn from inside it — no error, no warning,
   * and what you get is a screenshot of the forest with a rock arch floating in
   * it, because the HOOD (which is wound the other way, and was therefore also
   * wrong, and therefore visible) is the only part of the mesh facing you.
   *
   * The frame is `right = tangent x worldUp`, `up = right x tangent`, and phi
   * runs from +right toward +up, which makes `dPhi x dRing` point INWARD. So
   * the cavity's triangles are (i,j) (i,j+1) (i+1,j) — the order that would
   * face away on an ordinary extruded tube — and the hood, which is the same
   * rings seen from outside, is the reverse of that.
   */
  _link(hood) {
    const b = this._buffers;
    const rows = this._rows;
    let t = 0;

    /**
     * The holes the branches leave through, in the main tube's own lattice.
     *
     * This is the only place a quad is ever skipped, and it is what makes a
     * junction a junction rather than two tubes that happen to overlap. Sized
     * strictly inside the branch's ring-zero ellipse — see the block above
     * `buildBranch` for why "strictly", and for what a rim of black nothing
     * looks like when it is not.
     */
    const holes = [];
    for (let p = 1; p < this.paths.length; p++) {
      const br = this.paths[p];
      holes.push({ ring: br.base, rings: br.holeRings, phi: br.holePhi, span: br.holeSpan });
    }

    // Every passage: the surface you are standing inside, facing in.
    for (let p = 0; p < this.paths.length; p++) {
      const path = this.paths[p];
      const n = path.x.length;
      const base = path.vstart;
      for (let i = 0; i < n - 1; i++) {
        for (let j = 0; j < RADIAL; j++) {
          if (p === 0 && holes.length) {
            const phiC = ((j + 0.5) / RADIAL) * TAU - Math.PI * 0.5;
            let cut = false;
            for (const h of holes) {
              if (Math.abs(i - h.ring) > h.rings) continue;
              const d = Math.abs(((phiC - h.phi + Math.PI) % TAU + TAU) % TAU - Math.PI);
              if (d <= h.span) {
                cut = true;
                break;
              }
            }
            if (cut) continue;
          }
          const j2 = (j + 1) % RADIAL;
          const a = (base + i) * RADIAL + j;
          const c = (base + i) * RADIAL + j2;
          const d = (base + i + 1) * RADIAL + j;
          const e = (base + i + 1) * RADIAL + j2;
          b.index[t++] = a;
          b.index[t++] = c;
          b.index[t++] = d;
          b.index[t++] = c;
          b.index[t++] = e;
          b.index[t++] = d;
        }
      }
    }
    // The hood's outer shell, wound the other way so it faces out.
    for (let i = 0; i < hood; i++) {
      for (let j = 0; j < RADIAL; j++) {
        const j2 = (j + 1) % RADIAL;
        const a = (rows + i) * RADIAL + j;
        const c = (rows + i) * RADIAL + j2;
        const d = (rows + i + 1) * RADIAL + j;
        const e = (rows + i + 1) * RADIAL + j2;
        b.index[t++] = a;
        b.index[t++] = d;
        b.index[t++] = c;
        b.index[t++] = c;
        b.index[t++] = d;
        b.index[t++] = e;
      }
    }
    // The rim: inner ring 0 out to outer ring 0, facing out of the mouth, so
    // the lip has a thickness you can see rather than being a paper edge.
    for (let j = 0; j < RADIAL; j++) {
      const j2 = (j + 1) % RADIAL;
      const a = j;
      const c = j2;
      const d = rows * RADIAL + j;
      const e = rows * RADIAL + j2;
      b.index[t++] = a;
      b.index[t++] = d;
      b.index[t++] = c;
      b.index[t++] = c;
      b.index[t++] = d;
      b.index[t++] = e;
    }
    b.tri = t;
  }

  _finish() {
    const b = this._buffers;
    const rows = this._rows;
    const hood = this._hood;
    /**
     * Normals from the grid, not from face averaging.
     *
     * Same argument as `heightGrid`: this is a regular (ring, radial) lattice so
     * a central difference is available, it costs two subtractions per vertex,
     * and it gives a seamless normal at the radial wrap where averaging faces
     * would leave a crease running the whole length of the passage. They point
     * INWARD on the cavity — that is the surface being looked at — and outward
     * on the hood, which the sign flip below picks up from the winding.
     */
    for (let ri = 0; ri < rows + hood + 1; ri++) {
      const isHood = ri >= rows;
      /**
       * The central difference must not step across a passage boundary.
       *
       * Every path's rings are laid out end to end in one buffer, so row
       * `vstart - 1` is the LAST ring of the previous passage — thirty metres
       * away and pointing somewhere else. Differencing across that seam gives a
       * garbage tangent, and the symptom is one ring of black at the start of
       * every branch, which reads as a shading bug rather than as an indexing
       * one. `lo`/`hi` are that passage's own extent and nothing else's.
       */
      const path = isHood ? this.path : this.paths[this._pathAt[ri]];
      const i = isHood ? Math.min(ri - rows, hood) : this._ringAt[ri];
      const lo = isHood ? rows : path.vstart;
      const hi = isHood ? rows + hood : path.vstart + path.x.length - 1;
      const rowA = Math.max(lo, ri - 1);
      const rowB = Math.min(hi, ri + 1);
      const cx = path.x[i] - this.originX;
      const cy = path.y[i] - this.originY;
      const cz = path.z[i] - this.originZ;
      for (let j = 0; j < RADIAL; j++) {
        const j0 = (j + RADIAL - 1) % RADIAL;
        const j1 = (j + 1) % RADIAL;
        const k = (ri * RADIAL + j) * 3;
        const ka = (ri * RADIAL + j1) * 3;
        const kb = (ri * RADIAL + j0) * 3;
        const kc = (rowB * RADIAL + j) * 3;
        const kd = (rowA * RADIAL + j) * 3;
        const ax = b.position[ka] - b.position[kb];
        const ay = b.position[ka + 1] - b.position[kb + 1];
        const az = b.position[ka + 2] - b.position[kb + 2];
        const bx = b.position[kc] - b.position[kd];
        const by = b.position[kc + 1] - b.position[kd + 1];
        const bz = b.position[kc + 2] - b.position[kd + 2];
        let nx = ay * bz - az * by;
        let ny = az * bx - ax * bz;
        let nz = ax * by - ay * bx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl;
        ny /= nl;
        nz /= nl;
        // Point it at the centre line (cavity) or away from it (hood shell).
        const tox = cx - b.position[k];
        const toy = cy - b.position[k + 1];
        const toz = cz - b.position[k + 2];
        const want = isHood ? -1 : 1;
        if ((nx * tox + ny * toy + nz * toz) * want < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        b.normal[k] = nx;
        b.normal[k + 1] = ny;
        b.normal[k + 2] = nz;

        /**
         * Daylight lands on the FLOOR, and this is the pass that knows which
         * way each vertex is facing.
         *
         * `_daylight` is a function of distance along the passage only, which on
         * its own paints the ceiling as brightly as the ground and makes the
         * first twenty metres a uniformly lit grey pipe. Light entering a hole
         * travels roughly horizontally and lands on what is horizontal: the
         * floor of a cave mouth is bright, the walls are grazed, and the ceiling
         * directly above the entrance is the darkest thing in the frame. That
         * contrast is most of what makes an entrance read as an entrance, and it
         * costs one clamp per vertex because the normals are already here.
         */
        b.surf[(ri * RADIAL + j) * 4] *= 0.28 + 0.72 * clamp01(ny);
      }
    }

    const used = b.vert;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(b.position.subarray(0, used * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(b.normal.subarray(0, used * 3), 3));
    geo.setAttribute('aRock', new THREE.BufferAttribute(b.rock.subarray(0, used * 3), 3));
    geo.setAttribute('aLit', new THREE.BufferAttribute(b.lit.subarray(0, used * 3), 3));
    geo.setAttribute('aSurf', new THREE.BufferAttribute(b.surf.subarray(0, used * 4), 4));
    /**
     * The lattice's indices and the extras' indices are built into two arrays —
     * the lattice's count is not known until the holes have been cut, and the
     * extras are emitted before that — so they are joined here. One copy of a
     * few tens of thousands of ints, once per cave.
     */
    const index = new Uint32Array(b.tri + b.ex);
    index.set(b.index.subarray(0, b.tri), 0);
    index.set(b.exIndex.subarray(0, b.ex), b.tri);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeBoundingSphere();
    // The melt moves this by up to a metre or so; a passage that popped out of
    // the frustum at the peak while you were standing inside it would be the
    // worst possible moment for it. Same reasoning as TRIP_SLACK in ground.js.
    geo.boundingSphere.radius += 3;

    const mesh = new THREE.Mesh(geo, sharedMaterial ?? (sharedMaterial = caveMaterial()));
    mesh.position.set(this.originX, this.originY, this.originZ);
    /**
     * BEFORE THE GROUND, WHICH IS THE ONLY REASON THIS IS CHEAPER INSIDE THAN
     * OUT.
     *
     * three sorts the opaque list by renderOrder and the project has an explicit
     * order — ground -4, trunks -3, understorey -2, leaves -1, sky 90 — chosen
     * because the ground is the frame's best early-Z occluder (hiding it makes
     * the frame 2.48 ms SLOWER). Inside a cave the passage is a better one
     * still: it is small, entirely opaque, and it covers every pixel. Drawing it
     * first means the twenty-five thousand trunks the culler still submits are
     * rejected before they shade anything.
     *
     * It costs nothing from outside, where the mesh is a handful of triangles at
     * the back of a hillside and mostly frustum-culled.
     */
    mesh.renderOrder = -5;
    mesh.name = 'cave';
    this.mesh = mesh;
    this.group.add(mesh);

    this._buildFungi();
    this._buffers = null;
    this.ready = true;
  }

  _buildFungi() {
    let count = 0;
    for (const g of this.fungi) count += g.count;
    if (!count) return;
    const pos = new Float32Array(count * 3);
    const tint = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const size = new Float32Array(count);
    let at = 0;
    for (const g of this.fungi) {
      const rng = makeRng(`${getWorldSeed()}:cave-head:${this.c.k}:${g.seed}`);
      for (let i = 0; i < g.count; i++) {
        pos[at * 3] = g.x - this.originX + rngRange(rng, -1.1, 1.1);
        pos[at * 3 + 1] = g.y - this.originY + rngRange(rng, -0.7, 0.9);
        pos[at * 3 + 2] = g.z - this.originZ + rngRange(rng, -1.1, 1.1);
        tint[at * 3] = g.colour.r;
        tint[at * 3 + 1] = g.colour.g;
        tint[at * 3 + 2] = g.colour.b;
        seed[at] = rng();
        size[at] = rngRange(rng, 0.5, 1.5) * g.power;
        at++;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.computeBoundingSphere();
    const points = new THREE.Points(geo, sharedFungus ?? (sharedFungus = fungusMaterial()));
    points.position.set(this.originX, this.originY, this.originZ);
    points.renderOrder = 5;
    points.name = 'cave-fungi';
    this.points = points;
    this.group.add(points);
  }

  dispose() {
    this.mesh?.geometry.dispose();
    this.points?.geometry.dispose();
    this.group.clear();
    this.mesh = null;
    this.points = null;
    this._buffers = null;
    this.ready = false;
    this._ring = 0;
    this._ex = 0;
  }
}

let sharedMaterial = null;
let sharedFungus = null;

/**
 * Objects carrying the cave materials, for the shader pre-warm. Nothing draws
 * these; they exist so that something can be compiled.
 *
 * WHY THIS IS NEEDED AT ALL. `renderer.compileAsync(scene, camera)` can only
 * warm materials that are IN the scene, and no cave is: the field streams a
 * passage in when the player comes near a mouth, and the two shared materials
 * are created lazily on that first build. So the rock and the fungi compile
 * synchronously on the frame you first see a cave — measured at 100-180 ms
 * each, which is a visible stall at exactly the moment somebody is walking into
 * somewhere dark and unfamiliar.
 *
 * Creating the singletons here rather than throwaway copies is deliberate: the
 * program cache is keyed on the shader source, so a copy would warm the same
 * program — but the real mesh would then be the first to use these exact
 * material objects, and three does a little per-material setup on first use
 * that this way is also already done.
 *
 * A Points for the fungi rather than a Mesh, because the object type
 * participates in the program that gets built and warming the wrong one would
 * leave the same hitch with more ceremony.
 */
export function caveWarmupObjects() {
  /**
   * THE STAND-IN HAS TO MATCH THE REAL GEOMETRY, ATTRIBUTE FOR ATTRIBUTE.
   *
   * A program's cache key is derived from the material AND the object it is
   * being compiled for, so a stand-in that differs from the real mesh warms a
   * program the real mesh will not use — which is the same failure the whole
   * pre-warm had before it was pointed at the right render target, one level
   * down. The first version of this used a bare three-vertex triangle and the
   * cave still compiled on first sight; the keys differed in exactly one token.
   *
   * So this mirrors `_finish` above: indexed, with `normal`, `aRock`, `aLit`
   * and `aSurf`. If that attribute list ever changes, this has to change with
   * it — and the test for whether it did is `npm run perf:spikes`, which
   * reports the name of anything that compiles during a walk. It changed once
   * already: `aDay` and `aOut` became the first two lanes of `aSurf`, and this
   * stand-in had to move with them on the same commit or the pre-warm would
   * have been silently warming a program nothing uses.
   */
  const rock = new THREE.BufferGeometry();
  rock.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  rock.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
  rock.setAttribute('aRock', new THREE.BufferAttribute(new Float32Array(9), 3));
  rock.setAttribute('aLit', new THREE.BufferAttribute(new Float32Array(9), 3));
  rock.setAttribute('aSurf', new THREE.BufferAttribute(new Float32Array(12), 4));
  rock.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));

  const fungi = new THREE.BufferGeometry();
  fungi.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  fungi.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(9), 3));
  fungi.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(3), 1));
  fungi.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(3), 1));

  return [
    new THREE.Mesh(rock, sharedMaterial ?? (sharedMaterial = caveMaterial())),
    new THREE.Points(fungi, sharedFungus ?? (sharedFungus = fungusMaterial())),
  ];
}

/* -------------------------------------------------------------------------- */
/*  where the body is                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Caves whose collision line exists right now.
 *
 * A module-level list rather than something threaded through call sites,
 * because the two hottest consumers — the frame loop's camera clamp and the
 * controller's floor — must be able to answer "no cave here" in one array-length
 * test. The list is short (0-3) and is maintained only by `CaveField.update`.
 */
let live = [];

const _sample = {
  inside: 0,
  cave: null,
  path: null,
  ring: 0,
  along: 0,
  radial: 0,
  radius: 0,
  /** The wall, in the direction the body is actually standing. See `wallDist`. */
  wallDist: 0,
  floor: 0,
  ceiling: 0,
  cx: 0,
  cy: 0,
  cz: 0,
  /** Where the mouth goes out of sight on THIS passage. See `occludeWorld`. */
  blind: Infinity,
  /** For the audio: 0 open chamber, 1 squeeze; and how big the space is. */
  tight: 0,
  room: 0,
  water: 0,
  /** A pillar the body is inside, if any. `postR` is 0 when there is none. */
  postX: 0,
  postZ: 0,
  postR: 0,
};

/** A null answer, reused, so the callers never allocate and never see stale data. */
function outside() {
  _sample.inside = 0;
  _sample.cave = null;
  _sample.path = null;
  _sample.blind = Infinity;
  _sample.postR = 0;
  _sample.tight = 0;
  _sample.room = 0;
  _sample.water = 0;
  return _sample;
}

/**
 * Where the passage is, relative to a point.
 *
 * Scans the ring list for the nearest centre and reports the floor, the ceiling
 * and how far off the centre line the point is. `inside` is 0..1 rather than a
 * boolean and that is deliberate: it is the crossfade the fog, the reverb and
 * the forest's occlusion all ride on, and a hard boundary would make the whole
 * soundscape and the whole colour of the world switch on one footstep.
 *
 * THE CONTAINMENT TEST NEVER MENTIONS THE TERRAIN. It cannot: at the mouth the
 * tube is at ground level by construction, so any "am I below the surface" test
 * reports the one place that matters as outdoors. See ROOF_ROCK for what makes
 * the purely geometric test safe.
 *
 * The scan starts from the last answer. A full pass over ~200 rings is about
 * 1.5 microseconds and would be perfectly affordable three times a frame; the
 * hint is there because it also makes the answer STABLE. Two rings of a passage
 * that doubles back can be equally near, and a bare minimum flips between them
 * on alternate frames, which the audio hears as the depth jumping.
 */
export function caveSample(x, y, z) {
  if (!live.length) return outside();
  /**
   * BEST WINS, RATHER THAN FIRST WINS, AND THAT CHANGED WITH THE BRANCHES.
   *
   * The old loop returned the first passage that contained the point at all,
   * which was sound when there was one passage per cave. At a junction there are
   * two, they overlap by construction, and the main line's nearest ring is out
   * at its own wall while the branch's ring zero is right where you are
   * standing. First-wins there hands back the main passage's floor and the main
   * passage's wall for a body that has walked into the side lead — so the wall
   * push shoves you back out of the branch you just entered, from a surface
   * three metres behind you, which is unplayable and very hard to read.
   */
  let bestInside = 0;
  for (let ci = 0; ci < live.length; ci++) {
    const cave = live[ci];
    if (!cave.paths) continue;
    for (let pi = 0; pi < cave.paths.length; pi++) {
      const path = cave.paths[pi];
      const n = path.x.length;
      let best = Infinity;
      let bi = 0;
      const hint = path._hint | 0;
      const from = Math.max(0, hint - 30);
      const to = Math.min(n, hint + 31);
      for (let pass = 0; pass < 2; pass++) {
        const lo = pass === 0 ? from : 0;
        const hi = pass === 0 ? to : n;
        for (let i = lo; i < hi; i++) {
          const dx = path.x[i] - x;
          const dy = path.y[i] - y;
          const dz = path.z[i] - z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < best) {
            best = d2;
            bi = i;
          }
        }
        // A hit against the edge of the window means the real nearest ring is
        // probably outside it, so widen to the whole passage and try again.
        if (pass === 0 && bi > from && bi < to - 1) break;
      }

      const r = path.r[bi];
      const sh = ringShape(path, bi, _shapeA);
      const d = Math.sqrt(best);
      if (d > r * sh.w + 2.5) continue;

      path._hint = bi;
      const floorRock = path.y[bi] - r * sh.f;
      const ceiling = path.y[bi] + r * sh.t;
      let floor = floorRock;
    /**
     * THE MOUTH NEEDS AN END STOP, AND THE NEAREST-RING SCAN DOES NOT GIVE ONE.
     *
     * Standing four metres out in the gully, the nearest ring is still ring
     * zero, so without this the player is reported as inside a passage they
     * have not reached — and `caveFloorUnder` hands back a floor 1.8 m below
     * where they are standing, which is a hole in the ground in front of every
     * cave in the world. Projecting onto the ring's own tangent gives the signed
     * distance past the mouth plane, and the metre and a half of ramp is short
     * enough to be one stride and long enough that the fog and the reverb do not
     * switch on a single frame.
     */
      let ends = 1;
      if (pi === 0 && bi === 0 && n > 1) {
        let tx = path.x[1] - path.x[0];
        let ty = path.y[1] - path.y[0];
        let tz = path.z[1] - path.z[0];
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl;
        ty /= tl;
        tz /= tl;
        const s = (x - path.x[0]) * tx + (y - path.y[0]) * ty + (z - path.z[0]) * tz;
        ends = clamp01((s + 0.4) / 1.5);
      }
    /**
     * The radial measure is taken in the cross-section's own units, so a point
     * is "1" at the wall whether the wall is 2.5 m away or 10. Horizontal
     * distance rather than true distance, because the section is much wider
     * than it is tall and the vertical extent is already covered by the floor
     * and ceiling.
     */
      const hx = path.x[bi] - x;
      const hz = path.z[bi] - z;
      const horiz = Math.hypot(hx, hz);
      const inside =
        clamp01(1.35 - horiz / (r * sh.w)) * clamp01((ceiling + 1.2 - y) / 1.2) * ends;
      if (inside <= 0 || inside <= bestInside) continue;
      bestInside = inside;

      /**
       * BREAKDOWN, UNDERFOOT.
       *
       * The floor here is the higher of the rock and whatever is lying on it.
       * Each block reports a dome — flat across the top, ramping to nothing at
       * the rim — so the body climbs one through the ordinary floor clamp with
       * no step logic and nothing to get caught on. The visible block is angular
       * and does not match that dome, which is the same bargain the passage
       * floor has always made with its own displacement, and it is invisible for
       * the same reason: you cannot see your feet.
       *
       * Bucketed by ring in `prepare`, so this is a walk over the handful of
       * blocks within three rings rather than over a room's worth of them.
       */
      let postX = 0;
      let postZ = 0;
      let postR = 0;
      const obs = path.obstacles;
      if (obs && obs.length) {
        const lo = path.obsAt[Math.max(0, bi - 3)];
        const hi = path.obsAt[Math.min(path.obsAt.length - 1, bi + 4)];
        for (let o = lo; o < hi; o++) {
          const b = obs[o];
          const dx = x - b.x;
          const dz = z - b.z;
          const dd = Math.hypot(dx, dz);
          if (dd > b.rad) continue;
          if (b.kind === 1) {
            // A pillar: the body goes round it. Nearest one wins — two columns
            // close enough to be inside at once is rare and either push is fine.
            if (postR === 0 || b.rad - dd > postR - Math.hypot(x - postX, z - postZ)) {
              postX = b.x;
              postZ = b.z;
              postR = b.rad;
            }
            continue;
          }
          const t = clamp01((b.rad - dd) / (b.rad * 0.45));
          const top = b.y + b.top * smoothstep(t);
          // Only if the body could plausibly be standing on it: a block whose
          // top is above your head is a wall, and reporting it as floor would
          // teleport you onto the roof of a slab you are walking past.
          if (top > floor && top < y + 0.6) floor = top;
        }
      }

      /**
       * The wall, at the height the body actually occupies.
       *
       * Chest height rather than the eye, because the eye is at 1.68 and in a
       * keyhole that is up in the bore where there is room to spare — a body
       * that measured its clearance up there would walk its shoulders into the
       * slot. `halfWidthAt` solves the section rather than sampling it, so this
       * is the same wall the mesh has, not an approximation of it.
       */
      const chest = clamp(y - 0.85, floor + 0.2, ceiling - 0.15);
      const wall = r * halfWidthAt((chest - path.y[bi]) / r, sh);

      // How enclosed it is here, for the reverb and the draught. A squeeze and a
      // chamber are the two ends of the same measurement.
      const span = r * Math.sqrt(sh.w * sh.t);

      _sample.inside = inside;
      _sample.cave = cave;
      _sample.path = path;
      _sample.ring = bi;
      _sample.along = (path.baseAlong ?? 0) + (path.along ? path.along[bi] : 0);
      _sample.radial = horiz;
      _sample.radius = r;
      _sample.wallDist = wall;
      _sample.floor = floor;
      _sample.ceiling = ceiling;
      _sample.cx = path.x[bi];
      _sample.cy = path.y[bi];
      _sample.cz = path.z[bi];
      _sample.blind = path.blind ?? Infinity;
      _sample.tight = clamp01((3.3 - span) / 2.1);
      _sample.room = clamp01((span - 2.6) / 6.2);
      _sample.water = path.waterAudio ? path.waterAudio[bi] : 0;
      _sample.postX = postX;
      _sample.postZ = postZ;
      _sample.postR = postR;
    }
  }
  return bestInside > 0 ? _sample : outside();
}

/**
 * The floor the body stands on — the drop-in replacement for `groundUnder`.
 *
 * `main.js` clamps the camera to `groundUnder(x, z) + 0.35` every frame, which
 * underground is a command to teleport the player to the top of the mountain.
 * This is the predicate that fixes it: outside a cave it IS `groundUnder`, to
 * the bit, and inside it is the passage's own floor.
 *
 * `y` is not decoration. Standing on the hillside directly above a shallow
 * passage must give the hillside, and the only thing that distinguishes the two
 * cases is where the asker is.
 */
export function caveFloorUnder(x, z, y) {
  if (!live.length) return groundUnder(x, z);
  const s = caveSample(x, y, z);
  if (s.inside <= 0) return groundUnder(x, z);
  const floor = s.floor;
  /**
   * Cross-faded over the first third of the containment ramp, not switched.
   *
   * The two floors AGREE at the mouth — the tube's first rings are placed on
   * `heightAt` for exactly that reason — so this is not papering over a step.
   * It is there because they only agree ON the axis: three metres out in the
   * gully the nearest ring is still the mouth's, and its floor is the height of
   * the ground at the MOUTH rather than at the asker's feet. Blending over the
   * ramp instead of switching means the disagreement is spread across a stride
   * rather than delivered in one frame as a jolt.
   */
  const w = clamp01((s.inside - 0.05) / 0.3);
  if (w >= 1) return floor;
  const g = groundUnder(x, z);
  return g + (floor - g) * w;
}

/**
 * 0 outside, 1 well inside. Smoothed by the caller, not here.
 *
 * The audio and the fog both key off this. It is a product of two terms — how
 * far in you are along the passage, and how enclosed the passage is where you
 * are — so a wide chamber twenty metres in is less "cave" than a squeeze at the
 * same depth, which is what a room actually sounds like.
 */
export function caveEnclosure(x, y, z) {
  const s = caveSample(x, y, z);
  if (s.inside <= 0) return 0;
  const depth = clamp01(s.along / 26);
  return clamp01(s.inside) * (0.25 + 0.75 * depth);
}

/* -------------------------------------------------------------------------- */
/*  streaming                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Where a cave starts to exist as geometry, and where it stops.
 *
 * BUILD_RANGE is thirty seconds of sprinting, which is a long time to spread
 * five frames of work over. It also has to be generous for a reason that is not
 * about the build: the collision line comes up with the mesh, and a player who
 * arrived at a mouth before `prepare()` had run would walk into an unremarkable
 * hillside. DROP_RANGE is 1.7x that, as hysteresis — the same argument
 * ground.js makes for EVICT, and for the same reason: without it, pacing across
 * the boundary rebuilds the same passage for ever.
 *
 * IT ALSO HAS TO BE FURTHER THAN THE CRAG IS VISIBLE, which is what raised it
 * from 200 m. A mouth that only exists inside 200 m is fine while the only thing
 * to see is a dark hole you have to be in the gully to notice; it is exactly
 * wrong once there is a rock mass at the entrance meant to be picked out from
 * across the valley, because the thing a player walks toward would materialise
 * as they approached. The extra caves this streams are one draw and ~7 200
 * triangles each against a frame that carries 14 M.
 */
const BUILD_RANGE = 320;
const DROP_RANGE = 545;

export class CaveField {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'caves';
    /** k -> Cave */
    this.caves = new Map();
    this.built = 0;
    this._scan = 0;
    /** Whether the wood is currently not being submitted. See `occludeWorld`. */
    this.hidden = false;
  }

  /**
   * Called once a frame from the same place `forest.cull` is.
   *
   * The rescan is throttled to twice a second because it costs a string build
   * and a sort and nothing it can discover changes faster than a player walks
   * 250 m. Between rescans the only work is at most one build slice.
   */
  update(camera, dt = 0) {
    this._scan -= dt;
    if (this._scan <= 0) {
      this._scan = 0.5;
      this._rescan(camera.position.x, camera.position.z);
    }
    for (const cave of this.caves.values()) {
      if (cave.ready) continue;
      cave.prepare();
      if (cave.step()) {
        this.group.add(cave.group);
        this.built++;
      }
      // ONE cave slice per frame, whatever else is waiting. See RINGS_PER_FRAME.
      break;
    }
    return this.caves.size;
  }

  _rescan(px, pz) {
    const near = cavesNear(px, pz, DROP_RANGE + 260);
    const want = new Set();
    for (const c of near) {
      if (Math.hypot(c.x - px, c.z - pz) - c.reach > BUILD_RANGE) continue;
      want.add(c.k);
      if (!this.caves.has(c.k)) this.caves.set(c.k, new Cave(c));
    }
    for (const [k, cave] of this.caves) {
      if (want.has(k)) continue;
      if (Math.hypot(cave.c.x - px, cave.c.z - pz) - cave.c.reach < DROP_RANGE) continue;
      this.group.remove(cave.group);
      cave.dispose();
      this.caves.delete(k);
    }
    live = [...this.caves.values()].filter((c) => c.paths);
  }

  setPixelRatio(r) {
    if (sharedFungus) sharedFungus.uniforms.uPixelRatio.value = r;
  }

  /**
   * STOP SUBMITTING THE WOOD WHILE YOU ARE BURIED IN ROCK.
   *
   * This is the single largest thing in the whole feature and it is worth
   * spelling out, because on the face of it the renderer should already be
   * handling it. It is not, and cannot: three frustum-culls, and the forest is
   * all around you when you are underneath it. Every trunk within 384 m is
   * still transformed, and the project's own measurement is that at the peak the
   * frame is VERTEX-bound rather than fill-bound — so the passage drawing first
   * at renderOrder -5 wins the fragment battle and does nothing at all about
   * fourteen million vertices for a wood that is behind ten metres of rock.
   *
   * Measured at 2560x1440, all passes, 138 m into a passage:
   *
   *   wood submitted      6.57 ms sober, 6.82 at the peak, 94 draws, 14.1 M tris
   *   wood not submitted  0.59 ms sober, 0.85 at the peak, 21 draws, 0.03 M tris
   *
   * An eleven-fold difference, and it is the difference between a cave being
   * the most expensive place in the world and the cheapest. That is also the
   * right answer aesthetically: the brief was that a cave should be cheaper
   * inside than the forest is outside, because the wood is occluded — this is
   * that statement, made true.
   *
   * WHAT MAKES IT SAFE IS `blind`, NOT A GUESS AT A DEPTH.
   *
   * The failure mode is the entire world winking out in front of somebody who
   * can still see the entrance, and no fixed depth is defensible against a
   * passage that happens to run straight. `blindAlong` measures, per cave, where
   * the last line of sight to ring zero is broken, and adds fourteen metres. A
   * passage with no bend at all returns Infinity and is never hidden.
   *
   * Returns true only on a TRANSITION, because the caller has to re-arm the
   * shadow map: the map is rendered on demand, so one taken while the casting
   * set was hidden is an empty map, and without this the player would walk out
   * of a cave into a wood with no shadows in it until they had gone another six
   * metres.
   */
  occludeWorld(forest, mix, depth) {
    const cave = live.length ? _sample.cave : null;
    /**
     * The blind distance is the PASSAGE's, not the cave's, now that there is
     * more than one passage. A branch measures its own — see the note where it
     * is set — and reading the main line's here would let a lead that leaves
     * eight metres inside the mouth delete the forest while you can still see
     * out of it.
     */
    const want = mix > 0.995 && cave !== null && depth > _sample.blind;
    if (want === this.hidden) return false;
    this.hidden = want;
    forest.group.visible = !want;
    return true;
  }

  /**
   * Fog, and it is the cave's own rather than the scene's.
   *
   * `scene.fog` is one FogExp2 for the whole world and the trip director
   * rewrites its density from `atmosphere.base` on every frame, so this material
   * carries its own two uniforms and does its own exponential — exactly as the
   * water in atmosphere.js does, and for the same reason. That is what lets the
   * rock go to black at thirty metres while the forest visible THROUGH the
   * mouth keeps the forest's own haze: two fogs, each on the surface it belongs
   * to, instead of one global compromise that is wrong in both places.
   */
  setFog(colour, density) {
    if (!sharedMaterial) return;
    sharedMaterial.uniforms.fogColor.value.copy(colour);
    sharedMaterial.uniforms.fogDensity.value = density;
  }

  /**
   * The sun, for the crag — the only part of a cave that is ever in it.
   *
   * Written every frame from the same place `setFog` is, and for the same
   * reason: the hour moves, and a rock lit at build time would be lit for
   * whatever the sky happened to be doing when the player walked into range.
   * Three colours and a direction, on a shared material — it does not scale
   * with the number of caves, and when there are none it returns on the first
   * line because the material has not been created yet.
   *
   * `sun`, `sky` and `ground` arrive PRE-MULTIPLIED by their intensities. The
   * alternative is passing the lights and doing it here, which would make this
   * module know about three's lighting model — the exact dependency the top of
   * this file explains the material exists to avoid.
   */
  setDaylight(dir, sun, sky, ground) {
    if (!sharedMaterial) return;
    const u = sharedMaterial.uniforms;
    u.uSunDir.value.copy(dir);
    u.uOpenSun.value.copy(sun);
    u.uOpenSky.value.copy(sky);
    u.uOpenGround.value.copy(ground);
  }

  dispose() {
    for (const cave of this.caves.values()) cave.dispose();
    this.caves.clear();
    this.group.clear();
    live = [];
    this.hidden = false;
  }
}

export function buildCaves(scene) {
  const field = new CaveField();
  scene.add(field.group);
  return field;
}

/** The cross-section, for the controller's wall push and for the checks. */
export { SEC_WIDE, SEC_FLOOR, SEC_TALL, ROOF_ROCK };
