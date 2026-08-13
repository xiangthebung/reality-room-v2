import * as THREE from 'three';
import { clamp, clamp01, fbm2, lerp, makeRng, noise2, rngRange, smoothstep, TAU } from '../core/util.js';
import { caveAxisPoint, caveMouthPlan, cavesNear, getWorldSeed, groundUnder, heightAt } from './terrain.js';
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
const RING_STEP = 0.72;
/**
 * Slack on `caveSample`'s per-path bounding reject, in metres, on top of the
 * widest section the path actually has.
 *
 * DELIBERATELY GENEROUS, because the two directions are not symmetric. Too much
 * and the reject occasionally fails to fire and a frame does the scan it used
 * to do anyway — which is the behaviour that shipped for months. Too little and
 * a body genuinely inside the tube is not claimed by it, `caveFloorUnder` falls
 * through to `groundUnder`, and the floor clamp puts the player in the air
 * above the mountain — a failure this project has already spent a day on, and
 * one that only shows up at whichever cave happens to have the widest chamber.
 * Sixteen metres is more than the containment ramp and the step-up rule can
 * ever want, and it costs nothing to be wrong in this direction.
 */
const CAVE_SAMPLE_SLACK = 16;
/**
 * Vertices around a ring. 32 puts a facet at 11 degrees.
 *
 * It was 20, then 24 — the extra four spent entirely on the keyhole, whose slot
 * needs enough vertices below the waist to be a cut rather than a triangular
 * notch — and it is now 32, together with a ring step cut from 1.15 m.
 *
 * THE MESH WAS THE CEILING ON EVERYTHING ELSE. At 24 by 1.15 a facet on an
 * ordinary four-metre passage is roughly a metre across, so the surface can
 * carry no shape smaller than that: the displacement field's finest octave was
 * already above the mesh's Nyquist and was aliasing rather than resolving, and
 * the walls came out as big smooth panels with a mottle painted on them. No
 * amount of shader work fixes a silhouette, and the silhouette is what says
 * "cave" from across a chamber.
 *
 * Together the two changes are 1.6x the vertices — a cave goes from about
 * 15 000 to about 24 000, and from 17 000 triangles to 28 000. Against a frame
 * that carries fourteen MILLION triangles in the open, and which now submits
 * almost none of them while you are underground (see `occludeWorld`), this is
 * the cheapest thirty thousand triangles in the project.
 *
 * AND IT IS NOW 44 BY 0.72, WHICH IS THE SAME ARGUMENT WITH THE MEASUREMENT IN
 * FRONT OF IT.
 *
 * `scripts/cave-perf.mjs` prices the shipping underground frame at 0.70 ms at
 * 2560x1440, against 3.5-5 ms in the open wood. That is not a budget that has
 * to be argued for — it is most of an order of magnitude of headroom sitting
 * unspent in the one place in the world where the player is closest to every
 * surface they can see. 44 by 0.72 is 1.8x the vertices again: about 44 000 and
 * 51 000 triangles, which is 0.36% of what the wood carries.
 *
 * What it buys is the SILHOUETTE, which is the thing no amount of shader work
 * can fix. A facet on an ordinary four-metre passage goes from 0.55 m of arc to
 * 0.40, so the displacement's third octave stops being at the edge of what the
 * surface can hold and a fourth one becomes worth adding — see `rock`.
 */
const RADIAL = 44;
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
/**
 * The steepest a passage may dive, as a fraction of the step it dives over.
 *
 * 0.5 is a 27-degree ramp, which is the same gradient the walk's own pitch is
 * already clamped to (-0.44 in sine, 26 degrees) — so this bounds the ONE thing
 * that could previously ignore the pitch, which is the burial clamp. See the
 * block at `roof` in `buildNodes`.
 */
const MAX_DIVE = 0.5;
/**
 * How much of a ring's displacement the collision wall gives back, 0..1.
 *
 * Half, because the displacement is signed: the drawn wall is inside the smooth
 * outline as often as it is outside it. At 1 the body would be held off the
 * outer envelope of every bulge and a rough passage would feel a metre narrower
 * than it looks; at 0 the head walks through the bulges, which is what it did.
 */
const WALL_BITE = 0.55;

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
/**
 * …and on the floor, which is nearly flat because the body walks on the
 * ANALYTIC surface and not on this one.
 *
 * 0.018 was two centimetres on a typical ring: safe, and invisible. The step
 * rule in controller.js now allows STEP_UP of rise before it treats a surface as
 * a wall, so the drawn floor may differ from the walked one by rather more than
 * that without anybody's feet ending up inside the rock — and it has to, because
 * a floor with no relief on it reads as a painted triangle at any light level.
 * 0.045 is about 18 cm on a four-metre ring, a third of the step allowance.
 */
const ROUGH_FLOOR = 0.045;

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
 *
 * IN METRES, DIVIDED BY THE RING STEP, AND THEY WERE COUNTS. How much rock the
 * doorway needs is a fact about doorways; how many rings that is depends on how
 * finely the sweep happens to be sampled, and the two had been the same number
 * since the step was 1.15 m. Cutting the step to 0.72 for the density pass
 * silently shortened the hood from 5.7 m to 4.3 and moved the start of
 * `burySkylights` four rings' worth of ROCK further out — into the stretch where
 * the mouth is deliberately proud of the hill. Two caves of three on grove-01
 * were then truncated at ring 13 and 15, which is a fifteen-metre hole in a
 * hillside where a three-hundred-metre passage had been. Same trap as the
 * fungus spacing and the along-gate in `caveSample`, third door.
 */
const HOOD_MIN = Math.round(5.7 / RING_STEP);
const HOOD_EXTRA = Math.round(4.75 / RING_STEP);
/** …and the two rings of seam `exposedRings` adds, which are 1.9 m of it. */
const HOOD_SEAM = Math.round(1.9 / RING_STEP);

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
function buildNodes(c, salt = 0) {
  const rng = makeRng(`${getWorldSeed()}:cave-path:${c.k}${salt ? `:${salt}` : ''}`);
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
   *
   * ALL OF WHICH NOW HAPPENS IN terrain.js, and that move is not tidying.
   *
   * The ground mesh has to be able to punch a hole where these five nodes are —
   * see the PORTAL block over there for why the mound in the doorway cannot be
   * fixed any other way — and the mesh is built in a worker that has terrain.js
   * and nothing else, for a chunk that streams long before the cave does. So
   * `caveMouthPlan` is the single definition of where a passage begins, and this
   * consumes it. The node is a CENTRE and the floor is `SEC_FLOOR` radii below
   * it: the plan lifts it, so the walkable surface is the gully floor and not
   * 1.8 m under it.
   */
  const plan = caveMouthPlan(c);
  const aStart = plan.aStart;
  for (const p of plan.nodes) nodes.push(shaped(p.x, p.y, p.z, p.r, MOUTH_SHAPE));

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

  /** Set when the walk has run out of mountain. See the dive limit below. */
  let cliffed = false;

  for (let i = 0; i < count && !cliffed; i++) {
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
       *
       * ONE-SIDED IS NOT THE SAME AS UNBOUNDED, and that is what it was.
       *
       * The mountain has a far side. Ten metres of heading can put the next node
       * over ground twenty-five metres lower, and this line then dropped it
       * twenty-five metres to keep it buried — in ONE node, which the resample
       * turns into a cliff between two consecutive rings. Measured on grove-01's
       * k=1: ring 12's axis at 20.46 m, ring 13's at -3.45, nine hundred and
       * fifty millimetres apart. There is no climbing in this game and no
       * falling into anything either, because no ring claims a body standing at
       * the lip: `caveFloorUnder` falls through to `groundUnder` and the player
       * is put back on the hillside. That is the report, in the player's own
       * words — "there's drop but I can't enter the drop" — and `cave-walk`
       * called it as a mouth that stops dead at 12.5 m.
       *
       * So the dive is limited to a gradient the body could walk down, which is
       * the same one the pitch is already clamped to. Where the hillside demands
       * more, the answer is not a shallower dive — that surfaces the tube — it
       * is a different heading, and if six of those will not do it, the passage
       * has reached the edge of its mountain and ENDS there. A cave that stops
       * is a cave; a cave with a twenty-five metre step in it is a bug.
       */
      /**
       * ON THE CENTRE LINE, and the shoulders are `burySkylights`' business.
       *
       * `roofRoom` was tried here — the walk asking the same question the burial
       * asks, so the two could not disagree — and it is far too strict to steer
       * on. It is a MINIMUM over a rosette out to 1.15 half-widths, so a single
       * sample seven metres to the side of a perfectly good heading vetoes it,
       * and on grove-01's k=1 every joint was vetoed within four nodes: a
       * two-hundred-and-fifty ring passage became fourteen. The shoulders are a
       * reason to lower or narrow a ring, not a reason to refuse to go that way.
       */
      const roof = heightAt(nx, nz) - r * sh.t - ROOF_ROCK;
      const deepest = y - step * MAX_DIVE;
      if (roof < deepest) {
        if (attempt < 5) continue;
        cliffed = true;
        break;
      }
      ny = Math.min(ny, roof);
      ny = Math.max(ny, bottom);

      /**
       * …AND DO NOT RUN ALONG THE LIP OF A RAVINE.
       *
       * The centre line is only the middle of a passage that is five to twenty
       * metres wide. A heading that keeps four metres of rock over the AXIS can
       * still put the wall through the face of a gully six metres to the side,
       * and `burySkylights` — which measures the shoulders — then has to drop
       * that ring by everything the ravine is deep. On grove-01's k=1 that was
       * twenty-four metres, and it is the whole reason this walk needs to know
       * about the shoulders at all.
       *
       * A VETO WITH A RETRY, not a hard constraint. Requiring the shoulders to
       * carry full ROOF_ROCK is far too strict to steer on — tried, and it
       * vetoed every joint within four nodes and left a fourteen-ring passage.
       * A third of it is enough to tell a ravine from a slope, and if all six
       * attempts fail the node is taken anyway and the burial narrows it, which
       * is a squeeze rather than a cliff.
       */
      if (attempt < 5) {
        const tl = Math.hypot(nx - x, nz - z) || 1;
        const shoulder = roofRoom(nx, nz, (nx - x) / tl, (nz - z) / tl, r * sh.w);
        if (shoulder < ny + r * sh.t + ROOF_ROCK * 0.35) continue;
      }

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

/**
 * NO SKYLIGHTS: the RINGS are checked against the hillside, not the nodes.
 *
 * `buildNodes` clamps every node to ROOF_ROCK under `heightAt`, and that has
 * always been described as the one hard constraint in the walk. But the nodes
 * are not what gets drawn. The rings are a Catmull-Rom resampling and
 * Catmull-Rom OVERSHOOTS between control points; the RADIUS is splined too, so
 * a ring halfway between two nodes can be fatter than either of them; and
 * `_emitRing` then displaces the ceiling outward by up to `r * rough` on top of
 * that. Three overshoots stacked, none of them ever checked against the ground.
 *
 * Measured over three mouths on grove-01 the day this was written: one passage
 * put four rings through the hillside by up to 20 cm, two hundred metres in. A
 * 20 cm breach in a single-sided tube is a hole you can see the SKY through from
 * inside a mountain — and because the terrain is single-sided too, there is
 * nothing behind it either: it is a hard-edged wedge of daylight in an otherwise
 * black passage, and it does not look like a hole, it looks like a rendering
 * artefact somebody else introduced.
 *
 * Pushing the ring DOWN rather than shrinking it keeps the section's shape,
 * which is what the whole feature is about. `from` exempts the mouth, where
 * being proud of the ground is the hood and is the entire point.
 */
/**
 * The lowest the hillside gets anywhere over a ring's own footprint.
 *
 * SAMPLED ACROSS THE PASSAGE, NOT DOWN ITS CENTRE LINE. A ring is five to twenty
 * metres wide and every cave in this world is cut into a FLANK, so the ground
 * over the downhill shoulder can be metres lower than the ground over the axis —
 * the tube breaks out sideways while its centre still has four metres of rock
 * above it. That is the breach you actually get, and it is the one a centre-line
 * test cannot see.
 *
 * Shared by `burySkylights`, which applies it, and by `buildNodes`, which now
 * asks it BEFORE committing to a heading. Those two disagreeing is what put a
 * twenty-four metre cliff between two consecutive rings: the walk cleared the
 * axis, the burial cleared the shoulders, and the whole difference landed on one
 * ring step. One definition, asked twice.
 */
function roofRoom(x, z, tx, tz, half) {
  let surf = heightAt(x, z);
  const reach = half * 1.15 + 0.6;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    const ox = (-tz * Math.cos(a) + tx * Math.sin(a)) * reach;
    const oz = (tx * Math.cos(a) + tz * Math.sin(a)) * reach;
    surf = Math.min(surf, heightAt(x + ox, z + oz));
    surf = Math.min(surf, heightAt(x + ox * 0.55, z + oz * 0.55));
  }
  return surf;
}

function burySkylights(path, from) {
  const n = path.x.length;
  const want = Float64Array.from(path.y);
  /** The headroom line — `roofRoom` minus ROOF_ROCK — kept for the cut below. */
  const room = new Float64Array(n).fill(Infinity);
  for (let i = Math.max(0, from); i < n; i++) {
    const r = path.r[i];
    const half = r * path.w[i];
    const top = path.y[i] + r * (path.t[i] + path.rough[i]);
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let tx = path.x[b] - path.x[a];
    let tz = path.z[b] - path.z[a];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    const surf = roofRoom(path.x[i], path.z[i], tx, tz, half);
    room[i] = surf - ROOF_ROCK;
    if (top > room[i]) want[i] = path.y[i] - (top - room[i]);
  }

  /**
   * APPLIED AS A SLOPE-LIMITED ENVELOPE, NOT RING BY RING.
   *
   * Dropping one ring by a metre and leaving its neighbours alone puts a notch
   * in the passage: the ceiling over that ring is a metre lower than the ceiling
   * either side of it, and the body — whose head is held 0.28 m under the
   * ceiling and whose feet are held on the floor — is pushed down and up on the
   * same frame and stops dead. `cave-walk` caught it immediately: a mouth that
   * had been walking 116 m stalled at 30 for 1 153 frames.
   *
   * Two passes of a running minimum let the correction spread along the passage
   * at 0.3 m a ring, which is a gradient of about fifteen degrees — a slope you
   * walk down without noticing. It only ever lowers, so it cannot undo the
   * burial it exists to perform.
   */
  const SLOPE = 0.3;
  for (let i = 1; i < n; i++) want[i] = Math.min(want[i], want[i - 1] + SLOPE);
  for (let i = n - 2; i >= 0; i--) want[i] = Math.min(want[i], want[i + 1] + SLOPE);

  /**
   * …AND THE OTHER DIRECTION, WHICH THE ENVELOPE ABOVE CANNOT REACH.
   *
   * The envelope limits how fast the correction may RISE along the passage, and
   * that is what stops a notch. Nothing limited how fast it may FALL, and the
   * write below starts at `from` — so the whole of a drop demanded at the first
   * movable ring lands in the single step between it and the last fixed one. On
   * grove-01's k=1 that was twenty-four metres between two rings 0.95 m apart:
   * a sheer face in the middle of a passage that no ring claims the top of, so
   * `caveFloorUnder` fell through to `groundUnder` and put the player back on
   * the mountain. `cave-walk` reported a mouth that stopped dead at 12.5 m.
   *
   * The dive is now limited to the same MAX_DIVE gradient the walk uses, seeded
   * from the last ring that may not move. `buildNodes` asks `roofRoom` before it
   * commits to a heading, so this is a backstop rather than the mechanism —
   * what reaches it is the Catmull-Rom overshoot between two nodes that were
   * each fine, which is decimetres.
   */
  const first = Math.max(0, from);
  let ceilingOf = first > 0 ? path.y[first - 1] : want[first];
  for (let i = first; i < n; i++) {
    want[i] = Math.max(want[i], ceilingOf - MAX_DIVE * RING_STEP);
    ceilingOf = want[i];
  }

  /**
   * WHERE THE LIMITER CANNOT DELIVER THE BURIAL, THE PASSAGE PINCHES.
   *
   * A tube held up by the dive limit over ground that has fallen away is a tube
   * standing in open air, and a hole in a single-sided surface shows the SKY
   * from inside a mountain. The first answer was to stop the passage there, and
   * it is much worse than the fault it fixes: on grove-01's k=1 it turned two
   * hundred and fifty rings into nineteen. A cave you can walk into for eighteen
   * metres is not a cave.
   *
   * What is left when the hill runs thin is a thinner passage, and that is a
   * real thing rather than a dodge — every cave system in the world narrows as
   * it approaches the surface, and a squeeze that closes down is how one ends.
   * So the radius takes what the height cannot: shrunk to whatever the rock over
   * it allows, slope-limited so it tapers rather than steps, and truncated only
   * where a body genuinely could not pass.
   */
  const rock = new Float64Array(n);
  for (let i = 0; i < n; i++) rock[i] = path.r[i];
  for (let i = first; i < n; i++) {
    const tall = path.t[i] + path.rough[i];
    const fits = (room[i] - want[i]) / Math.max(tall, 0.2);
    if (fits < rock[i]) rock[i] = Math.max(0, fits);
  }
  // 0.35 a ring is a taper you walk into rather than a doorway you meet.
  const TAPER = 0.35;
  for (let i = 1; i < n; i++) rock[i] = Math.min(rock[i], rock[i - 1] + TAPER);
  for (let i = n - 2; i >= 0; i--) rock[i] = Math.min(rock[i], rock[i + 1] + TAPER);

  /**
   * …and it ends where a body could not get through.
   *
   * `MIN_HEAD` is what `caveSample` guarantees the player between floor and
   * ceiling, and it does so by inflating its ANSWER rather than the rock — so a
   * ring whose real section is shorter than that is one where the head is inside
   * the ceiling. Half a metre of margin on top, because the last ring before the
   * cap should be somewhere you can stand and look at the squeeze, not somewhere
   * you are already in it.
   */
  let cut = n;
  for (let i = first; i < n; i++) {
    if (rock[i] * (path.t[i] + path.f[i]) < MIN_HEAD + 0.5) {
      cut = i;
      break;
    }
  }
  // Ring 0 of a branch is welded to the main tube and must not move; the mouth
  // rings are the hood and must not either.
  for (let i = first; i < cut; i++) {
    path.y[i] = want[i];
    path.r[i] = rock[i];
  }
  if (cut < n) truncate(path, cut);
}

/**
 * Shorten every one of a path's parallel arrays to `cut` rings, and close it.
 *
 * The last two rings are pinched to nothing so the sweep converges to a point
 * exactly as `buildNodes` does at a passage's natural end — a tube that simply
 * stops has an open end, and an open end seen from inside is a hole showing the
 * back of its own surface.
 */
function truncate(path, cut) {
  const keep = Math.max(6, cut);
  if (keep >= path.x.length) return;
  // Subarrays, not `length =`: `resample` hands back Float64Arrays and a typed
  // array's length is a getter. Assigning to it throws, silently, inside a build
  // slice — which shows up as three caves in a row reporting `built=false`.
  path.x = path.x.subarray(0, keep);
  path.y = path.y.subarray(0, keep);
  path.z = path.z.subarray(0, keep);
  for (const ch of CHANNELS) path[ch] = path[ch].subarray(0, keep);
  path.r[keep - 1] = 0.05;
  path.r[keep - 2] = path.r[keep - 3] * 0.55;
}

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
  /**
   * Ring zero sits INSIDE the main passage by MOUTH_INSET, not on its wall.
   *
   * Both surfaces carry independent rock displacement — the main wall is pushed
   * about by `rock()` and so is the branch's own first ring — so two surfaces
   * that meet exactly on the nominal wall meet raggedly on the real one, and a
   * few centimetres of miss is a few centimetres of hole. Forty centimetres of
   * overlap costs a snout you can only see by looking for it and removes the
   * whole class of gap.
   */
  const MOUTH_INSET = 0.4;
  const first = shaped(
    main.x[bi] + rx * (r0 * w0 - MOUTH_INSET),
    main.y[bi],
    main.z[bi] + rz * (r0 * w0 - MOUTH_INSET),
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
  // From ring 1: ring 0 is welded to the main tube's wall and must not move.
  burySkylights(path, 1);
  path.base = bi;
  path.side = side;
  /**
   * The hole, in the main tube's own (ring, phi) lattice.
   *
   * phi 0 is +right and phi PI is -right — see the frame in `_emitRing` — so a
   * branch leaving to the right is centred on phi 0 and one leaving left on PI.
   */
  /**
   * The vertical half-extent is the SMALLER of the bore's two, and it has to be.
   *
   * A section is an ellipse cut off flat at the floor, so it reaches `t` above
   * the mid-line and only `f` below it — and the hole is centred on the
   * mid-line and symmetric. Sizing it from `t` alone cuts further down than the
   * branch's floor exists, which leaves a crescent of nothing along the bottom
   * lip of every junction. It is a few pixels, it is pure white against black
   * because it is a straight view out of the hillside, and it is the last thing
   * you would ever find by walking around in the dark.
   */
  const halfV = rb * Math.min(path.t[0], path.f[0]) * 0.5;
  const halfH = rb * path.w[0] * 0.5;
  path.holePhi = side > 0 ? 0 : Math.PI;
  /**
   * THE VERTICAL EXTENT IS AN ARCSINE, NOT AN ARCTANGENT, AND THAT WAS A LEAK.
   *
   * The wall vertex at angle phi sits at height `r0 * t0 * sin(phi)`, so the
   * band of wall within `halfV` of the mid-line is `|phi| <= asin(halfV /
   * (r0*t0))`. The first version took `atan2(halfV, r0*w0)` — the angle
   * subtended at the AXIS — which for a tall branch off a wide passage
   * overestimates badly: it cut to 0.95 rad, which is 54 degrees of a section
   * whose ceiling starts curving over at 40, so the top of the window was up in
   * the roof where the branch's bore never reaches.
   *
   * The symptom is unmistakable once seen and easy to miss in the dark: standing
   * at the junction you could see daylight and the tops of trees through the
   * corner of the opening, because the tube is single-sided and a hole in it
   * looks straight out of the mountain.
   */
  path.holeSpan = Math.min(0.85, Math.asin(clamp(halfV / Math.max(r0 * main.t[bi], 0.5), 0, 0.92)));
  path.holeRings = Math.max(1, Math.floor(halfH / RING_STEP));
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
    /**
     * THE FLOOR CUT HAS TO BE INSIDE THE ELLIPSE, OR THERE IS NO FLOOR.
     *
     * `section` truncates at `f` only where the ellipse reaches below it, so a
     * ring whose `f` exceeds its `t` has no flat bottom at all — its lowest
     * point is `-t` and the section is a plain ellipse. That is survivable for
     * the mesh and fatal for the body: `caveSample` still reports the floor at
     * `-f`, so the walking surface sits below the geometry, the chest height
     * used for the wall solve lands where the ellipse has collapsed to nothing,
     * and `halfWidthAt` returns ~0. The push then pins the player to the ring's
     * centre every frame — full running velocity, zero displacement, in a
     * passage four metres wide with nothing near them.
     *
     * The jitter in `shaped` is what lets f drift past t; 0.95 keeps the cut
     * strictly inside and costs a couple of centimetres of depth.
     */
    path.f[i] = Math.min(path.f[i], path.t[i] * 0.95);
    path.key[i] = clamp01(path.key[i]);
    path.rough[i] = Math.max(0, path.rough[i]);
    path.scal[i] = clamp01(path.scal[i]);
    path.seep[i] = Math.max(0, path.seep[i]);
  }

  flatten(path);

  for (let i = 0; i < n; i++) {
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
 * A CHAMBER HAS A FLOOR. A SWEPT TUBE HAS A BOTTOM, AND THEY ARE NOT THE SAME
 * THING.
 *
 * Every ring's floor sits a fixed fraction of that ring's radius under that
 * ring's axis, so the bottom of the passage inherits every wobble the centre
 * line has — which is invisible in a two-metre squeeze and absurd in a twenty-
 * metre room, where the axis meanders four metres sideways and a metre down
 * over the length of the chamber and takes the floor with it. You get a bowl
 * with a tilted, rolling bottom that no collapse ever made, the breakdown blocks
 * stand on it at angles, and consecutive rings overlap enough that the lowest
 * lobe of the sweep is somewhere the analytic floor does not know about — which
 * is the last two metres of "standing in mid-air" that `caveSample` cannot fix
 * from its end, because the geometry really is down there.
 *
 * So the floor HEIGHT is smoothed along the passage — not the radius, not the
 * shape — over a window that scales with how big the space is, and `f` is
 * solved back out of it. A squeeze is untouched (its window is nothing and its
 * weight is zero); a chamber comes out with one level floor you can cross,
 * which is what the floor of a collapse is.
 */
function flatten(path) {
  const n = path.x.length;
  const floor = new Float64Array(n);
  for (let i = 0; i < n; i++) floor[i] = path.y[i] - path.r[i] * path.f[i];
  const level = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const win = Math.min(16, Math.round(path.r[i] * path.w[i] * 0.9));
    if (win < 2) {
      level[i] = floor[i];
      continue;
    }
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, i - win); k <= Math.min(n - 1, i + win); k++) {
      sum += floor[k];
      count++;
    }
    level[i] = sum / count;
  }
  for (let i = 0; i < n; i++) {
    // 0 under four and a half metres of half-width, 1 over nine. Below that a
    // passage is a passage and its floor should follow it.
    const big = clamp01((path.r[i] * path.w[i] - 4.5) / 4.5);
    if (big <= 0) continue;
    const want = floor[i] + (level[i] - floor[i]) * big;
    path.f[i] = clamp((path.y[i] - want) / path.r[i], 0.08, path.t[i] * 0.95);
  }
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
      // Plus HOOD_EXTRA, and never fewer than HOOD_MIN: the seam needs HOOD_SEAM,
      // the crag needs somewhere to fade. See the crag block above.
      return Math.min(Math.max(HOOD_MIN, i + HOOD_SEAM + HOOD_EXTRA), n - 1);
    }
  }
  return Math.min(Math.round(11.4 / RING_STEP) + HOOD_EXTRA, n - 1);
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

/* -------------------------------------------------------------------------- *
 *  THE FLOOR IS NOT FLAT, AND ASSUMING IT WAS PUT THE BODY INSIDE THE ROCK
 * -------------------------------------------------------------------------- *
 *
 * `caveSample` reported `y - r * f` as the floor at every horizontal offset,
 * which is only the truth where the section is actually cut off flat. It very
 * often is not: `section` clamps the ellipse at `-f` ONLY where the ellipse is
 * deeper than that, so a ring whose `f` is at or above its `t` — every keyhole,
 * and most of the jittered tubes — has no flat part at all. Its floor is a bowl.
 *
 * Measured on grove-01, walking three quarters of the way to the wall of an
 * ordinary passage put the reported floor 2.4 m under the rock the eye can see.
 * You wade. It is the same class of mistake `halfWidthAt` exists to prevent, one
 * axis over, so the fix is the same one: solve the section instead of guessing
 * at it, and solve it with the very function the wall push already uses so the
 * two can never disagree.
 */

/** The section's lowest point at a horizontal offset, in radius units. */
function floorAt(nx, sh) {
  const ax = Math.abs(nx);
  if (ax >= sh.w) return 0;
  const e = ax / sh.w;
  const ell = -sh.t * Math.sqrt(Math.max(0, 1 - e * e));
  const y = Math.max(ell, -sh.f);
  if (sh.key <= 0) return y;
  /**
   * A keyhole's slot pinches the section sideways below the waist, so the
   * deepest point that is still `ax` across is higher than the ellipse says and
   * there is no closed form for it. Ten bisections on `halfWidthAt` is exact to
   * a millimetre on a two-metre section and only runs on the one shape that has
   * a slot.
   */
  let bad = y;
  let good = 0;
  for (let k = 0; k < 10; k++) {
    const mid = (bad + good) * 0.5;
    if (halfWidthAt(mid, sh) >= ax) good = mid;
    else bad = mid;
  }
  return good;
}

/** …and its highest, which has no slot to worry about. */
function ceilAt(nx, sh) {
  const ax = Math.abs(nx);
  if (ax >= sh.w) return 0;
  const e = ax / sh.w;
  return sh.t * Math.sqrt(Math.max(0, 1 - e * e));
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
     * A third octave at 0.95, and a fourth at 1.9.
     *
     * THE CEILING ON THIS IS THE MESH AND THE MESH MOVED. The rule has not
     * changed: displacement finer than the vertex spacing does not become
     * detail, it becomes aliasing that crawls when the melt moves the surface,
     * and the fragment's grain term is where the finer scales belong because a
     * texture lookup is not sampled by the vertex spacing. What changed is the
     * spacing — rings at 0.72 m and 44 vertices to a ring put a facet at about
     * 0.40 m of arc on a typical passage, against 0.55 before, so the surface
     * Nyquists near 0.8 m of wavelength instead of 1.1.
     *
     * The fourth octave is deliberately just under that, and small: it is what
     * gives the finer mesh something to be finer ABOUT. Without it the extra
     * vertices only resolve the same three octaves more exactly, which is more
     * triangles for the same silhouette and the whole point was the silhouette.
     */
    fbm2(y * 0.95 + x * 0.33, x * 0.95 - z * 0.37, 2) * 0.26 +
    fbm2(x * 1.9 - z * 0.51, y * 1.9 + z * 0.44, 2) * 0.115
  );
}

/**
 * Sides on a breakdown slab. Seven: see `_emitBlock` for why not six and not
 * twenty. It is fixed rather than drawn because the vertex budget in `prepare`
 * is allocated up front and an undercount there writes off the end of a typed
 * array, which is silent — the shape simply loses a face somewhere.
 */
const BLOCK_SIDES = 7;

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
    /**
     * CLOSER TOGETHER THAN THE RINGS USED TO BE, WHICH IS THE SAME DISTANCE.
     *
     * This was 7-15 rings and the rings were 1.15 m, then 0.95, and are now
     * 0.72: the spacing of the light in a cave had been quietly following a
     * decision about mesh resolution, and had halved. 10-22 puts it back at
     * seven to sixteen metres, and then takes a metre off the top, because the
     * one place the tour is unreadable is the long stretch between two clusters
     * where the near-field term has run out and nothing else has started.
     */
    i += 10 + Math.floor(rng() * 12);
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

    /**
     * HEIGHT FIRST, THEN WIDTH — AND THAT ORDER IS THE FIX FOR THE FLAT SHARDS.
     *
     * It used to be the other way round: a radius drawn up to `1.1 + half*0.22`,
     * which in a fourteen-metre chamber is four metres, and then a height capped
     * at BLOCK_MAX. Two point four metres tall on an eight-metre span is a
     * pancake, and half of it is then buried — so what stood in the biggest,
     * best rooms in the world was a scatter of wide flat plates showing three
     * facets each above the silt. That is the "3D trapezoid" the player saw, and
     * it was never the shading: it was the aspect ratio.
     *
     * Drawing the height first and the radius from it keeps every block between
     * roughly one and two times as wide as it is tall, which is what a slab off
     * a ceiling actually is, and it means the cap that exists for the body —
     * nothing you climb may put your head in the roof — no longer silently
     * squashes the shape as well.
     */
    const top = Math.min(
      BLOCK_MAX,
      rngRange(rng, 0.45, 1.0 + clamp01((half - 3.4) / 7) * 1.6),
      Math.max(0.25, head - 2.15)
    );
    const rad = Math.max(0.45, top * rngRange(rng, 0.6, 1.25));
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

/**
 * What is drifting in the air, and where it took its colour from.
 *
 * Placed inside the section rather than on the wall — that is the whole point of
 * them; see the spore block in `_buildFungi` — and only where there is light for
 * them to be lit by, because an additive sprite in a dark gallery is a grey dot
 * on black and reads as a dead pixel. The tint is the nearest source's, at the
 * strength that source reaches this point, so a drift of spores crossing from a
 * fungus cluster into a crystal seam changes colour as it goes.
 */
function placeSpores(c, path, tag, lights) {
  const rng = makeRng(`${getWorldSeed()}:cave-spore:${c.k}:${tag}`);
  const n = path.x.length;
  const out = [];
  const tmp = { x: 0, y: 0 };
  for (let i = 6; i < n - 4; i += 2) {
    const r = path.r[i];
    const many = rng() < 0.55 ? 1 + Math.floor(rng() * 3) : 0;
    for (let m = 0; m < many; m++) {
      // Anywhere in the section, weighted toward the lower half where a body
      // walks and where the parallax against the far wall is largest.
      const phi = rngRange(rng, -Math.PI, Math.PI);
      section(phi, ringShape(path, i, _shapeA), tmp);
      const into = Math.sqrt(rng()) * 0.82;
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      let tx = path.x[b] - path.x[a];
      let tz = path.z[b] - path.z[a];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const x = path.x[i] + -tz * tmp.x * r * into + tx * rngRange(rng, -0.5, 0.5);
      const z = path.z[i] + tx * tmp.x * r * into + tz * rngRange(rng, -0.5, 0.5);
      const y = path.y[i] + tmp.y * r * into * 0.75;

      let best = null;
      let bestFall = 0;
      for (let f = 0; f < lights.length; f++) {
        const g = lights[f];
        const d = Math.hypot(g.x - x, g.y - y, g.z - z);
        if (d > g.reach) continue;
        const t = 1 - d / g.reach;
        const fall = t * t * g.power;
        if (fall > bestFall) {
          bestFall = fall;
          best = g;
        }
      }
      // No light within reach: no spore. See the note above about grey dots.
      if (!best || bestFall < 0.06) continue;
      out.push({
        x,
        y,
        z,
        colour: best.colour,
        size: rngRange(rng, 0.16, 0.42) * (0.5 + bestFall),
        seed: rng(),
        drift: rngRange(rng, 0.35, 1),
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 *  CRYSTALS — THE REASON TO WALK ANOTHER HUNDRED METRES IN THE DARK
 * -------------------------------------------------------------------------- *
 *
 * Everything else in this file is an argument about what a cave IS. This is the
 * one thing in it that is an argument about what a cave is FOR.
 *
 * The passage before this pass was, honestly, correct and dull. It had the right
 * shapes, the right water, the right flood line and the right darkness, and a
 * player walked thirty metres into it and turned round — because a corridor of
 * accurate limestone lit by a mushroom every twelve metres offers you nothing to
 * find. Fungi are a lighting scheme; they are not a destination. They are the
 * same brightness everywhere, so no part of the cave is anywhere in particular.
 *
 * A crystal seam is the opposite in every one of those respects:
 *
 *   IT IS VISIBLE FROM A LONG WAY OFF. Six times a fungus cluster's output and
 *   nearly three times its reach, so the glow rounds the corner before you do —
 *   which is the only way a dark, branching space can ever say "this way".
 *
 *   IT IS SOMEWHERE, NOT EVERYWHERE. They come in seams: one roll per cave for
 *   the palette, then clusters along a joint with sixty metres of nothing
 *   between. The nothing is what makes them land, exactly as the darkness
 *   between the fungi is what makes the fungi land.
 *
 *   IT HAS ITS OWN GEOMETRY AND ITS OWN LIGHT. Each spike is a faceted prism
 *   whose facets carry their own normal as their light direction, so the whole
 *   cluster glitters as you move rather than glowing as a lump; and because they
 *   are baked into the rock's light like everything else, the wall behind one is
 *   lit by it.
 *
 * They are not realistic and are not meant to be. There is no cave on earth with
 * a self-luminous beryl seam in it. The brief was awe.
 */

/**
 * Metres a seam carries, and how hard it pushes.
 *
 * BOTH WERE FIRST SET FAR TOO HIGH — 34 m at nearly three times a fungus, on
 * the reasoning in the block above that a seam should be visible from a long
 * way off. What that actually produced was a two-hundred-metre passage lit
 * entirely violet, in which the seam was not a destination because there was
 * nowhere in the cave that was not already the seam's colour. The thing being
 * bought is CONTRAST, and contrast is spent by reaching further, not earned.
 *
 * Twenty metres is about one gallery: the glow rounds one corner and no more,
 * so the approach is dark, the chamber is not, and the walk between them is the
 * whole point. See the same argument at FUNGUS_REACH's distance from the mouth.
 */
const CRYSTAL_REACH = 20;
const CRYSTAL_POWER = 0.85;

/**
 * The palettes, one drawn per cave.
 *
 * PER CAVE AND NOT PER CLUSTER, and that is what makes a cave a place rather
 * than a sampler. Two colours in one seam reads as decoration; one colour, held
 * for two hundred metres, is the character of the whole passage — and it means
 * two caves on the same ridge are somewhere different from each other, which is
 * the property the shapes alone never quite bought.
 *
 * The second colour is the core, always paler and warmer than the rim, because
 * every gem that has ever impressed anybody is brighter in the middle.
 */
const CRYSTAL_KINDS = [
  { rim: 0x2f8fd6, core: 0xa9e8ff, name: 'blue' },
  { rim: 0x8a4fd8, core: 0xe0b6ff, name: 'violet' },
  { rim: 0x21c39a, core: 0xa8ffe4, name: 'green' },
  { rim: 0xd8712a, core: 0xffd9a0, name: 'amber' },
  { rim: 0xd83f6a, core: 0xffc0d4, name: 'rose' },
];

/**
 * Where a seam is, and which way its spikes point.
 *
 * Along a joint, like the speleothems and for the same reason — calcite and
 * crystal both got there because water did, and water follows the cracks. The
 * `vein` field is the same one `placeSpires` reads, at a different scale, so a
 * decorated stretch of passage tends to be decorated in both ways at once.
 *
 * `from` keeps them out of the daylight. A glowing crystal in a lit doorway is
 * a glowing crystal nobody notices, and it would also be the first thing a
 * player sees of the whole feature — spending the effect on the one place in the
 * cave where there is already something to look at.
 */
function placeCrystals(c, path, tag, from) {
  const rng = makeRng(`${getWorldSeed()}:cave-crystal:${c.k}:${tag}`);
  const n = path.x.length;
  const out = [];
  if (n < from + 12) return out;
  const kind = CRYSTAL_KINDS[Math.floor(rng() * CRYSTAL_KINDS.length)];
  const rim = new THREE.Color(kind.rim);
  const core = new THREE.Color(kind.core);
  const tmp = { x: 0, y: 0 };

  let i = from + Math.floor(rng() * 26);
  while (i < n - 6) {
    /**
     * A seam is a run of rings, not a point. Six to fourteen of them — seven to
     * sixteen metres — which is about as far as you can see down a passage by
     * the light of the thing you are looking at, so a seam fills the view when
     * you reach it and is a glow when you do not.
     */
    const runLen = 6 + Math.floor(rng() * 9);
    const seamSeed = rng();
    for (let j = i; j < Math.min(n - 4, i + runLen); j++) {
      const r = path.r[j];
      const vein = clamp01(fbm2(path.x[j] * 0.12 + seamSeed * 9, path.z[j] * 0.12 + path.y[j] * 0.18, 2) * 2 + 0.6);
      const many = Math.floor(rng() * 2.6 * (0.3 + vein * 0.8));
      for (let m = 0; m < many; m++) {
        /**
         * Anywhere round the section but weighted off the floor, because a
         * spike growing straight up out of the walking surface is a spike the
         * player walks through — there is no collision on these, deliberately:
         * they are small, they are everywhere in a seam, and a body that got
         * caught on one in the dark would have no way to understand what had
         * happened.
         */
        const phi = rngRange(rng, -Math.PI, Math.PI);
        section(phi, ringShape(path, j, _shapeA), tmp);
        if (tmp.y < -0.55 * path.f[j] && rng() < 0.6) continue;
        const a = Math.max(0, j - 1);
        const b = Math.min(n - 1, j + 1);
        let tx = path.x[b] - path.x[a];
        let tz = path.z[b] - path.z[a];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        const nx = -tz;
        const nz = tx;
        const slide = rngRange(rng, -0.5, 0.5);
        const px = path.x[j] + nx * tmp.x * r * 0.96 + tx * slide;
        const pz = path.z[j] + nz * tmp.x * r * 0.96 + tz * slide;
        const py = path.y[j] + tmp.y * r * 0.96;
        /**
         * Growing INTO the passage, which is the direction the vector from the
         * wall to the axis points — plus a wide jitter, because a cluster whose
         * spikes are all parallel is a hairbrush. Real ones splay.
         */
        let dx = -nx * tmp.x + rngRange(rng, -0.7, 0.7);
        let dy = -tmp.y * 0.8 + rngRange(rng, -0.5, 0.9);
        let dz = -nz * tmp.x + rngRange(rng, -0.7, 0.7);
        const dl = Math.hypot(dx, dy, dz) || 1;
        dx /= dl;
        dy /= dl;
        dz /= dl;
        /**
         * A FEW BIG ONES AMONG MANY SMALL ONES, WHICH IS WHAT A CLUSTER IS.
         *
         * The first pass drew every spike from one narrow range and the seams
         * came out as gravel that happened to glow — no silhouette, nothing to
         * walk up to, and at half a metre a spike is two facets wide on screen
         * from three metres away. Every crystal cluster anybody has ever
         * photographed has one or two that dominate and a skirt of small ones
         * around them, and the ratio between them is the whole read.
         */
        const big = rng() < 0.18;
        /**
         * SCALED BY THE HALF-WIDTH, NOT BY THE RADIUS, because those are very
         * different numbers in the shapes that matter. A vadose canyon has a
         * perfectly ordinary radius and is 0.6 of it across, so sizing off `r`
         * put three-metre spikes across a passage a metre and a half wide: they
         * met in the middle, and a seam you cannot walk through is a wall made
         * of light.
         */
        const room = r * path.w[j];
        const len =
          (big ? rngRange(rng, 1.4, 3.0) : rngRange(rng, 0.3, 1.0)) *
          clamp(room * 0.3, 0.4, 1.5);
        out.push({
          x: px,
          y: py,
          z: pz,
          dx,
          dy,
          dz,
          len,
          rad: len * rngRange(rng, 0.11, 0.24),
          colour: rim.clone(),
          core: core.clone(),
          power: rngRange(rng, 0.5, 1.15),
          ring: j,
          seed: rng(),
        });
      }
    }
    // …and then a long way of nothing. See the block above.
    i += runLen + 34 + Math.floor(rng() * 62);
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
       * THE COLOUR OF NOTHING, AND IT IS NOT BLACK.
       *
       * The old floor was a flat 0.028 multiplier on the rock's own albedo,
       * which means the darkest part of a cave was a dark version of the rock —
       * a desaturated brown-grey, the single most reliable way to make a
       * hundred metres of passage look like one corridor. Every dark place in
       * the real world takes the colour of whatever light is bouncing around it,
       * and down here that is the fungi and the crystals: cold, blue, and much
       * more saturated than the rock is.
       *
       * So the ambient is its OWN colour rather than a fraction of the albedo,
       * and it is the deepest blue in the project. What it buys is that the
       * unlit rock reads as distance and cold rather than as underexposure, and
       * that the warm formations have something to be warm against.
       */
      uAmbient: { value: new THREE.Color(0x0a1526) },
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
      /**
       * WHERE THE LIGHT IS COMING FROM, TIMES HOW MUCH THE SOURCES AGREE — and
       * in w, how much of the passage this vertex can see.
       *
       * Baked on the CPU next to aLit. See the light block in _shade: without a
       * direction the fragment can only ADD the baked irradiance, which is a
       * term with no relief in it, and no amount of surface noise shows through
       * a flat add. This is what the per-pixel normal has to dot against.
       */
      attribute vec4 aGlow;
      varying vec3 vRock;
      varying vec3 vLit;
      varying vec4 vSurf;
      varying vec4 vGlow;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vDepthFog;
      void main() {
        vRock = aRock;
        vLit = aLit;
        vSurf = aSurf;
        vGlow = aGlow;
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
      uniform vec3 uAmbient;
      varying vec3 vRock;
      varying vec3 vLit;
      varying vec4 vSurf;
      varying vec4 vGlow;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vDepthFog;

      /**
       * RELIEF, AND IT IS SAMPLED IN WORLD SPACE RATHER THAN DIFFERENCED IN
       * SCREEN SPACE. THAT CHOICE IS THE WHOLE OF THIS BLOCK.
       *
       * The geometry carries detail down to about half a metre — thirty-odd
       * vertices to a ring — and rock is mostly finer than that, so everything
       * between half a metre and a centimetre has to come from the fragment or
       * it does not exist at all. The shader this replaced spent its noise on an
       * albedo mottle, which is a photograph of relief rather than relief: it
       * does not move when the light does, it never catches a highlight, and it
       * is why a passage lit by a cluster three metres away came out as flat
       * coloured paper however much noise was multiplied into it.
       *
       * THE OBVIOUS IMPLEMENTATION IS MIKKELSEN'S SURFACE GRADIENT and it was
       * tried first: take dFdx/dFdy of a height you are computing anyway,
       * against dFdx/dFdy of the world position, and the perturbed normal falls
       * out with no tangents, no second UV set and no extra fetch. It is elegant
       * and it is wrong here, for a reason that is specific to this noise.
       *
       * rrNoise is a hardware trilinear fetch of a smoothstep-warped coordinate.
       * Its VALUE is smooth; its DERIVATIVE steps at every cell boundary of the
       * lattice. Nothing in this project had ever differentiated it before —
       * every other user reads it as a colour — so the steps had never mattered.
       * Differenced across a pixel they become a regular grid of creases in the
       * normal, and a regular 3D grid on a curved wall seen at a grazing angle
       * beats against the pixel raster as concentric rings. Those rings were
       * visible down the near wall of every canyon in the cave, they were chased
       * through three wrong explanations — too much amplitude, too fine an
       * octave, insufficient distance fade — and none of them touched it,
       * because the cause is not the frequency of the noise, it is that the
       * FOOTPRINT of the difference varies across the screen. Confirmed by
       * disabling the perturbation entirely: the rings went with it exactly.
       *
       * Three taps at a FIXED world-space offset have no such property. The
       * difference is always taken over 30 cm of rock whatever the angle, the
       * distance or the resolution, so there is nothing for the raster to beat
       * against — and the two extra fetches also give the centre sample away
       * free for the albedo, so the whole thing is three fetches where the
       * previous version's best case was two and its worst was five.
       *
       * The tangent frame is built from the geometric normal rather than passed
       * in. Its BEARING is arbitrary — it swings as the normal turns — but the
       * perturbation it produces does not depend on which way it points, only on
       * the plane it spans, so an arbitrary frame is not merely acceptable here,
       * it is free.
       */
      vec3 rrRelief(vec3 n, vec3 p, float freq, float scale, float e, out float centre) {
        vec3 up = abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        vec3 t1 = normalize(cross(up, n));
        vec3 t2 = cross(n, t1);
        float h0 = rrFbm2(p * freq);
        float h1 = rrFbm2((p + t1 * e) * freq);
        float h2 = rrFbm2((p + t2 * e) * freq);
        centre = h0;
        return normalize(n - (t1 * (h1 - h0) + t2 * (h2 - h0)) * scale);
      }

      void main() {
        vec3 geoN = normalize(vNormal);
        vec3 toEye = uEye - vWorld;
        float dist = length(toEye);
        vec3 view = toEye / max(dist, 1e-4);
        float vDay = vSurf.x;
        float vOut = vSurf.y;
        float vWet = vSurf.w;
        float ao = vGlow.w;

        /**
         * Surface grain, which does more work than a colour multiply.
         *
         * At thirty vertices to a ring the geometry can only carry detail down
         * to about half a metre, and rock is mostly finer than that. Two octaves
         * at a metre, used BOTH as an albedo mottle and — the half that matters
         * — as the height the normal is perturbed by. See rrRelief above for why
         * that perturbation is three world-space taps and not a screen-space
         * derivative, which is the same decision the five-fetch budget note
         * below is about, reached the other way round.
         *
         * THREE FETCHES, AND IT USED TO BE TWO. The two-fetch budget was set
         * when an earlier version of this shader briefly used five — rrFbm3 for
         * the grain plus a second rrFbm2 warping the bedding — and measured
         * 5.73 ms against 3.97 in the open, because inside a passage this
         * material covers EVERY PIXEL and at 2560x1440 that is 3.7 M fragments.
         * That is still the right instinct and three is still cheap: the
         * underground frame now measures 0.60 ms all in, against three and a
         * half to five in the wood, because occludeWorld takes the sky, the
         * motes and the animals down with the trees. The fetch is bought with
         * headroom that was measured, not assumed.
         */
        /**
         * TWO OCTAVES OF RELIEF, WHICH IS FIVE FETCHES.
         *
         * The three-fetch budget was set against a 0.60 ms underground frame and
         * a note that the two it replaced had been chosen when this shader
         * briefly cost 5.73 ms. Both are still true and neither is the reason
         * for the number: cave-perf prices the shipping frame at 0.70 ms
         * against 3.5-5 in the open, so five fetches over 3.7 M fragments is
         * bought out of measured headroom exactly as the third one was.
         *
         * The second octave is at four times the frequency and a third of the
         * amplitude, with its difference taken over 8 cm instead of 30. That is
         * the scale between the coarse relief and the albedo grain — the pitting
         * and the fracture surface — and it is the band the eye actually uses to
         * judge how far away a wall is, because it is the last one still
         * resolvable at arm's length. Without it a passage lit at a tenth of a
         * stop reads as smooth to within half a metre of your face.
         *
         * The offset is fixed in WORLD space for the same reason the first
         * octave's is, and the reason is the whole of rrRelief above: a
         * screen-space derivative of this noise beats against the raster as
         * rings. A finer octave differenced over a finer offset is the same trap
         * with less room to spare, so 8 cm is as tight as this goes.
         */
        float grainRaw;
        vec3 n = rrRelief(
          geoN,
          vWorld,
          1.05,
          // Halved on the floor. Not for the reason ROUGH_FLOOR exists — a
          // normal perturbation moves no geometry and nothing can fall through
          // it — but because a cave floor is silt over rubble and is genuinely
          // the smoothest surface down here at this scale. Off entirely on
          // water, which is flat by definition and has its own ripple.
          0.55 * (1.0 - 0.5 * clamp(geoN.y, 0.0, 1.0)) * (1.0 - vWet),
          0.30,
          grainRaw
        );
        float fineRaw;
        n = rrRelief(
          n,
          vWorld + 41.7,
          4.2,
          0.22 * (1.0 - 0.5 * clamp(geoN.y, 0.0, 1.0)) * (1.0 - vWet),
          0.08,
          fineRaw
        );
        float grain = grainRaw * 0.5 + 0.5;
        // The fine octave's own value, kept for the albedo: pitted rock is
        // lighter where it has broken and darker where it has not.
        float fine = fineRaw * 0.5 + 0.5;
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
         * THE STRATA STAND OUT OF THE WALL RATHER THAN BEING PAINTED ON IT.
         *
         * A horizontal line that does not catch the light is the single most
         * obvious tell that a surface is a texture, so the bedding is tilted
         * back into the normal as a ledge every 45 cm — at its own frequency,
         * UNWARPED. The albedo bed above is sin(depth + grain * 5.2), and the
         * 5.2 is what makes it a good albedo term: five radians of phase warp
         * per unit of grain turns parallel stripes into something that wanders,
         * which is what strata do. In the NORMAL the same warp is a frequency
         * multiplier — the sine completes most of a cycle across one feature of
         * the grain — and the wall fills with a ripple far finer than anything
         * the geometry can carry, which at a grazing angle beats against the
         * pixel raster. Same trap as the screen-space gradient, other door.
         */
        vec3 up2 = abs(geoN.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        vec3 bt = normalize(cross(cross(up2, geoN), geoN));
        n = normalize(n + bt * cos(vSurf.z * 2.2) * 0.16);

        /**
         * THE FUNGUS LIGHT, WITH A DIRECTION IN IT AT LAST.
         *
         * vLit is baked irradiance times albedo and used to be added flat, which
         * lit the side of a boulder facing away from a cluster exactly as
         * brightly as the side facing it. vGlow is the same bake's mean
         * direction, and its LENGTH is how much the sources agreed — see the
         * light block in _shade. So a wall with one cluster on it gets nearly
         * pure N.L and all the relief that implies, and the middle of a chamber
         * lit from six sides keeps the old flat behaviour, which is correct
         * there: many sources at many angles IS ambient.
         *
         * Half-lambert rather than clamped N.L. A hard terminator needs a
         * shadow to be legible against and there is none down here; wrapping it
         * keeps the far side of every rock dark without going to solid black,
         * which at this light level is indistinguishable from a hole.
         */
        float coh = length(vGlow.xyz);
        vec3 ldir = vGlow.xyz / max(coh, 1e-4);
        float wrap = clamp(dot(n, ldir) * 0.5 + 0.5, 0.0, 1.0);
        float ndl = mix(1.0, wrap * wrap * 1.45, clamp(coh, 0.0, 1.0));

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
        /**
         * RETUNED WHEN THE PASSAGE LEARNED TO BE NARROW.
         *
         * 0.30 and 0.36 were fitted against a tube that was six metres across,
         * so the nearest wall was three metres off and the term sat around 0.4.
         * A vadose canyon is three metres across: the wall is at arm's length,
         * exp(-0.33) is 0.72, and the tightest, most oppressive passage in the
         * cave came out as the BRIGHTEST — a washed-out grey-green corridor,
         * which is the exact opposite of what the shape is for.
         *
         * A steeper constant and a smaller coefficient put a wall at one metre
         * at roughly what a wall at three used to be, and take everything past
         * six metres to nothing. That hands the mid-distance back to the fungi,
         * which is where the lighting design always said it belonged.
         */
        /**
         * WRAPPED, BECAUSE A FLOOR IS SEEN EDGE-ON AND WAS THEREFORE BLACK.
         *
         * dot(n, view) is the right shape for a wall — it is what makes the
         * rock beside you brighter than the rock you are glancing past — and it
         * is exactly wrong underfoot. The floor's normal is up and the eye looks
         * along it, so the product is 0.1-0.2 for the two metres of ground the
         * player is actually standing on, and every tour shot came back with a
         * featureless black wedge across the bottom third of the frame. Dark
         * adaptation does not work that way: what it resolves is what is CLOSE,
         * and the angle only changes how much.
         *
         * A third of it unconditionally, the rest by the cosine. The wall keeps
         * its falloff and the floor stops being a hole.
         */
        float near = exp(-dist * 0.34) * mix(0.34, 1.0, max(dot(n, view), 0.0));
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
         *
         * THE AMBIENT IS NOW A COLOUR RATHER THAN A FRACTION OF THE ALBEDO.
         * See uAmbient: 0.028 of the rock's own brown is a darker brown, and a
         * hundred metres of darker brown is the failure this whole pass exists
         * to undo. Occlusion multiplies it, which is the only place AO belongs —
         * it is a measure of how much bounced light reaches a point, and bounced
         * light is precisely what an ambient term stands in for.
         */
        /**
         * THE AMBIENT IS A FLOOR, NOT A FILL, AND THE FIRST TUNING HAD IT AS A
         * FILL.
         *
         * At 0.55 + 0.75 * ao on a colour of 0x0b1626 the darkest rock in the
         * cave came out around 0.18 in blue — three to five times the near-field
         * term next to it — so every surface in the frame was within a stop of
         * every other one and the whole passage read as a flat blue mist with
         * shapes faintly implied in it. The failure looks exactly like the
         * brown-grey it replaced, which is the tell that the problem was never
         * the hue.
         *
         * A quarter of that. What it has to do is stop the far dark being pure
         * black — so that distance reads as cold rather than as a hole cut out
         * of the picture — and then get out of the way of the fungi.
         */
        vec3 col = uAmbient * (0.30 + 0.70 * ao);
        col += vRock * near * 0.72 * (0.35 + 0.65 * ao);
        col += vLit * ndl * (0.62 + 0.5 * grain) * (0.25 + 0.75 * ao);
        col += uDay * vDay * uDayGain;
        col *= 0.78 + grain * 0.42;
        // …and the fine octave as a light mottle, narrow, so it reads as the
        // surface being broken rather than as a second coat of the first one.
        col *= 0.90 + fine * 0.20;

        /**
         * A SHEEN ON THE ROCK, WHICH IS NOT THE SAME AS A SHEEN ON THE WATER.
         *
         * Limestone underground is damp everywhere — that is why it is
         * limestone — and damp rock has a broad, weak specular lobe that is the
         * main thing telling you a surface is stone and not felt. It needs a
         * light direction, which until this pass did not exist in this shader;
         * now that it does, it is four instructions.
         *
         * Gated on 'coh' so it only fires where there is a dominant source to
         * reflect. In the middle of a chamber lit from all sides there is no
         * highlight to be had and faking one puts a moving glint on a wall with
         * nothing to reflect.
         */
        float spec = pow(max(dot(reflect(-ldir, n), view), 0.0), 26.0);
        col += vLit * spec * coh * 1.4;

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
          /**
           * THE SHEEN IS BOUNDED, AND THE FIRST VERSION WAS NOT.
           *
           * At 3.4 fresnel plus 2.2 sparkle the multiplier on the baked light
           * reaches 6.1, and fresnel goes to 1 at exactly the angle you see most
           * of a stream from — along it. A ribbon of water seen down its own
           * length came back as a clipped white wedge lying on the floor, which
           * in a dark passage reads as a hole in the world; I chased it through
           * three unrelated junction fixes before measuring it.
           *
           * Water is DARK. What makes it read is contrast against darker rock
           * and the fact that it moves, not brightness — and the tail is clamped
           * so no viewing angle can take it past its own albedo.
           */
          float fres = pow(1.0 - clamp(dot(wn, v), 0.0, 1.0), 4.0);
          float spark = pow(max(0.0, sin(wx * 1.7) * sin(wz * 1.3)), 12.0);
          float sheen = min(1.6, 0.32 + 1.0 * fres + 0.45 * spark);
          vec3 water = vRock * 0.05
                     + vLit * sheen
                     + uDay * vDay * uDayGain * 0.55;
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
      /** 0 for a fungus head or a crystal halo, >0 for something in the air. */
      attribute float aDrift;
      varying vec3 vTint;
      varying float vFade;
      void main() {
        vTint = aTint;
        vec3 p = position;
        /**
         * THREE SINES, NOT A NOISE FETCH, AND NOT A SIMULATION.
         *
         * A spore hanging in still cave air moves on a scale of centimetres per
         * second and does not go anywhere; what it has to do is not be nailed
         * to the world. Three incommensurate periods per axis, offset by the
         * point's own seed, gives a wander that never repeats visibly and costs
         * six sines on a few hundred vertices. The vertical period is the
         * slowest and the amplitude the largest, because the one thing that
         * reads instantly as "this is drifting rather than vibrating" is a rise
         * that takes longer than you keep watching.
         */
        if (aDrift > 0.0) {
          float s = aSeed * 43.7;
          p += aDrift * vec3(
            sin(uTime * 0.19 + s) * 0.55 + sin(uTime * 0.071 + s * 2.3) * 0.9,
            sin(uTime * 0.083 + s * 1.7) * 1.15,
            cos(uTime * 0.163 + s * 0.9) * 0.55 + cos(uTime * 0.061 + s * 3.1) * 0.9
          );
        }
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dist = -mv.z;
        // A slow, out-of-phase pulse per head, so a cluster shimmers rather
        // than blinking in unison.
        float breathe = 0.72 + 0.28 * sin(uTime * (0.5 + aSeed * 0.7) + aSeed * 31.4);
        vFade = breathe * smoothstep(64.0, 26.0, dist);
        /**
         * A spore fades as it gets NEAR as well as far. It is a fleck of dust,
         * so a metre from the eye it should be a soft smudge rather than a disc
         * filling a tenth of the screen — and without this the drift regularly
         * walks one through the camera, which without a near fade is a flash.
         */
        if (aDrift > 0.0) vFade *= smoothstep(0.35, 1.6, dist);
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
const RINGS_PER_FRAME = 22;

/**
 * How many rings a passage has to reach before it counts as a cave rather than
 * a hole in a hillside. Forty is about thirty-eight metres — past the first
 * corner, so there is somewhere to arrive at. See the re-walk in `prepare`.
 */
const STUB_RINGS = 40;

class Cave {
  constructor(descriptor) {
    this.c = descriptor;
    this.path = null;
    /** The main passage and its branches. `paths[0] === path`. */
    this.paths = null;
    this.blocks = null;
    this.spires = null;
    this.crystals = null;
    this.spores = null;
    this.water = null;
    this.fungi = null;
    /** Every emitter's light, flattened. Built in `prepare`; see the note there. */
    this.lights = null;
    /** Set while a self-luminous surface is being emitted. See `_emitCrystal`. */
    this._emit = null;
    this.mesh = null;
    this.points = null;
    this.group = new THREE.Group();
    this.group.name = `cave-${descriptor.k}`;
    this.ready = false;
    this._ring = 0;
    this._ex = 0;
    this._hood = 0;
    this._buffers = null;
    /** The attributes still to reach the GPU, and how far down them we are. */
    this._priming = null;
  }

  /** Everything the collision line needs, and nothing that touches the GPU. */
  prepare() {
    if (this.path) return;
    /**
     * WALK IT AGAIN IF IT COMES OUT A STUB, and that is not a retry loop for a
     * flaky build — it is the only honest answer to a mouth that opens onto a
     * ravine.
     *
     * `burySkylights` truncates a passage where the hill it is under has run
     * out, and where the hill runs out immediately the passage is thirteen rings
     * long. Twelve metres is not a cave. The mouth is fixed — it is the gully's,
     * and terrain.js has already carved for it — but everything past the fifth
     * node is a seeded joint walk, and a different salt takes a different first
     * corner. On grove-01 that is the difference between k=1 being a stub and
     * k=1 being a cave; on the other two slots the first walk is kept and
     * nothing changes at all.
     *
     * Longest wins rather than first-past-the-post, so a seed where every walk
     * is short still gets the best of them instead of the last.
     */
    let walk = null;
    let best = null;
    let bestLen = -1;
    for (let salt = 0; salt < 3; salt++) {
      const w = buildNodes(this.c, salt);
      const p = resample(w.nodes);
      const hood = Math.max(1, exposedRings(p));
        burySkylights(p, hood + HOOD_SEAM);
      if (p.x.length > bestLen) {
        bestLen = p.x.length;
        best = p;
        walk = w;
        this._hood = hood;
      }
      if (bestLen >= STUB_RINGS) break;
    }
    this.path = best;
    this.path.base = -1;
    this.path.baseAlong = 0;
    this.fungi = placeFungi(this.c, this.path, 'main', 14);
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
    /**
     * NO SKYLIGHTS: the RINGS are checked against the hillside, not the nodes.
     *
     * `buildNodes` clamps every node to ROOF_ROCK under `heightAt` and that has
     * always been described as the hard constraint — but the nodes are not what
     * gets drawn. The rings are a Catmull-Rom resampling, Catmull-Rom overshoots
     * between control points, the RADIUS is splined too (so a ring between two
     * nodes can be fatter than either), and `_emitRing` then displaces the
     * ceiling outward by up to `r * rough` on top of that. Three overshoots
     * stacked, none of them checked.
     *
     * Measured over three mouths on grove-01: one passage put four rings through
     * the hillside by up to 20 cm, two hundred metres in. A 20 cm breach in a
     * single-sided tube is a hole you can see the SKY through from inside a
     * mountain — and because the terrain is single-sided too, it is not subtle:
     * it is a hard-edged wedge of daylight in an otherwise black passage.
     *
     * Pushing the ring DOWN rather than shrinking it keeps the section's shape,
     * which is the thing the whole feature is about. Rings 0..hood are exempt:
     * being proud of the ground there is the mouth, and is the point.
     */
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
     * A BOX ROUND EACH PASSAGE, so `caveSample` can say "not this one" without
     * walking it.
     *
     * `caveSample` runs two to three times a frame and had no bounding reject
     * at all: it entered the ring loop for every path of every cave inside
     * BUILD_RANGE (320 m), and its widen-to-full-scan test — break only if the
     * window's best is nearer than that ring's own section is wide — can never
     * fire when the body is nowhere near the cave, because `best` is enormous.
     * So being FAR from a cave made it scan the whole passage twice, both the
     * centre pass and the fit pass, and the cost went UP the further away you
     * stood until the cave dropped at 545 m. A few hundred metres out on the
     * surface that is thousands of hypot-heavy iterations a frame to conclude
     * "outside", which it was always going to conclude.
     *
     * NOT `c.reach`, WHICH IS THE OBVIOUS WRONG ANSWER. That is the radius of
     * everything the cave touches ON THE SURFACE — the notch and the knoll,
     * measured from the mouth — and a passage bores into the mountain well past
     * it. Rejecting on `c.reach` would silently stop the tube claiming a body
     * that is genuinely inside it, and the failure mode for that is documented
     * and expensive: nothing claims the body, `caveFloorUnder` falls through to
     * `groundUnder`, and the floor clamp fires the player up out of the
     * mountain onto the hillside above. The bound has to come from the rings.
     *
     * `_bpad` is the widest section this path has anywhere, plus the same `+ 3`
     * the scan's own reach test uses, plus slack for the containment ramp. The
     * box is therefore strictly conservative: a point outside it cannot be
     * within reach of any ring on this path, so the reject can only skip work
     * the fit test at the bottom would have thrown away.
     */
    for (const path of this.paths) {
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      let pad = 0;
      for (let i = 0; i < path.x.length; i++) {
        if (path.x[i] < x0) x0 = path.x[i];
        if (path.x[i] > x1) x1 = path.x[i];
        if (path.y[i] < y0) y0 = path.y[i];
        if (path.y[i] > y1) y1 = path.y[i];
        if (path.z[i] < z0) z0 = path.z[i];
        if (path.z[i] > z1) z1 = path.z[i];
        const reach = path.r[i] * path.w[i];
        if (reach > pad) pad = reach;
      }
      path._bpad = pad + 3 + CAVE_SAMPLE_SLACK;
      path._bx0 = x0;
      path._bx1 = x1;
      path._by0 = y0;
      path._by1 = y1;
      path._bz0 = z0;
      path._bz1 = z1;
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
    this.crystals = [];
    for (let p = 0; p < this.paths.length; p++) {
      const path = this.paths[p];
      const tag = p === 0 ? 'main' : `br${p}`;
      for (const run of placeWater(this.c, path, tag)) this.water.push({ path: p, ...run });
      const blocks = placeBlocks(this.c, path, tag);
      const spires = placeSpires(this.c, path, tag);
      const crystals = placeCrystals(this.c, path, tag, p === 0 ? 16 : 2);
      for (const b of blocks) b.path = p;
      for (const s of spires) s.path = p;
      for (const cr of crystals) cr.path = p;
      this.blocks.push(...blocks);
      this.spires.push(...spires);
      this.crystals.push(...crystals);
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
     * EVERYTHING THAT EMITS, IN ONE LIST, BECAUSE `_shade` WALKS IT PER VERTEX.
     *
     * The bake is O(vertices x lights) and it is the most expensive thing in the
     * build, so this exists to keep it a single flat array of plain objects with
     * no branching inside the loop — a fungus and a crystal differ only in their
     * colour, their power and how far they carry, and all three are fields.
     *
     * The crystals reach further and are much stronger than the fungi. That is
     * the whole point of them: a passage lit only by mushrooms is evenly, dimly
     * legible everywhere, and what a cave wants instead is somewhere to walk
     * TOWARD. A crystal chamber is visible from the far end of the gallery
     * leading into it, and the fungi become what you see by once you are past.
     */
    this.lights = [];
    for (const g of this.fungi) {
      this.lights.push({ x: g.x, y: g.y, z: g.z, colour: g.colour, power: g.power, reach: FUNGUS_REACH });
    }
    for (const cr of this.crystals) {
      this.lights.push({
        x: cr.x + cr.dx * cr.len * 0.5,
        y: cr.y + cr.dy * cr.len * 0.5,
        z: cr.z + cr.dz * cr.len * 0.5,
        colour: cr.colour,
        power: cr.power * CRYSTAL_POWER,
        reach: CRYSTAL_REACH,
      });
    }

    // Last, because a spore takes its colour from the nearest light and the
    // list has to be complete before one can be asked for.
    this.spores = [];
    for (let p = 0; p < this.paths.length; p++) {
      const tag = p === 0 ? 'main' : `br${p}`;
      for (const s of placeSpores(this.c, this.paths[p], tag, this.lights)) this.spores.push(s);
    }

    /**
     * The holes, hoisted out of `_link` so `_emitRing` can see them too.
     *
     * Both need them and for related reasons: `_link` skips the quads, and
     * `_emitRing` has to flatten the rock displacement around the opening.
     * Without the second, the two surfaces that have to meet at a junction are
     * each being thrown about by up to `r * rough` — which in a rough room is
     * over a metre, against a snout inset of forty centimetres — so they miss,
     * and a miss in a single-sided tube is a view straight out of the mountain.
     * Flattening the wall near the hole is also just correct: the rim of a real
     * opening is where the rock has been worked hardest.
     */
    this._holes = [];
    for (let p = 1; p < this.paths.length; p++) {
      const br = this.paths[p];
      this._holes.push({ ring: br.base, rings: br.holeRings, phi: br.holePhi, span: br.holeSpan });
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
    /**
     * THE EXTRAS' BUDGET, AND IT MUST BE EXACT.
     *
     * These are hand-counted rather than measured because the buffers are
     * allocated once, up front, from these numbers — an undercount writes past
     * the end of a Float32Array, which in JS is silent: the vertex simply does
     * not exist, and what you see is one facet of one boulder missing somewhere
     * in a two-hundred-metre passage. Every emitter below has its shape spelled
     * out next to it so the two can be checked against each other.
     */
    let exVerts = 0;
    let exIdx = 0;
    for (const _b of this.blocks) {
      // A leaning prism: one tall quad and one top wedge per side, flat shaded.
      exVerts += BLOCK_SIDES * (4 + 3);
      exIdx += BLOCK_SIDES * (6 + 3);
    }
    for (const s of this.spires) {
      // Column: 2 bands x 8 facets x 4. Drape: 5 panels x 4, both sides.
      // Spire: 8 facets x 2 quad bands (4 each) + 8 tip triangles (3 each).
      exVerts += s.kind === 'column' ? 64 : s.kind === 'drape' ? 40 : 8 * (4 + 4 + 3);
      exIdx += s.kind === 'column' ? 96 : s.kind === 'drape' ? 60 : 8 * (6 + 6 + 3);
    }
    for (const _cr of this.crystals) {
      // Six sides: a quad to the shoulder and a triangle to the point.
      exVerts += 6 * (4 + 3);
      exIdx += 6 * (6 + 3);
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
      /** Where the light comes from, times how agreed the sources are, plus AO. */
      glow: new Float32Array(verts * 4),
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
    // The lattice is done and the mesh exists; what is left is the upload,
    // which is metered out one attribute per frame. See `_prime`.
    if (this._priming) return this._prime();

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
    const items =
      this.blocks.length + this.spires.length + this.crystals.length + this.water.length;
    while (this._ex < items && budget > 0) {
      this._emitExtra(this._ex);
      this._ex++;
      budget -= 0.25;
    }
    if (this._ex < items) return false;

    this._link(hood);
    this._finish();
    /**
     * FALSE, not true: the mesh exists but is drawing nothing yet. The caller
     * has to put the group in the scene anyway — see `CaveField.update` — and
     * `_prime` is what eventually says the passage is whole.
     */
    return false;
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
    // How big the space is here, for the albedo. See the `open` block in _shade.
    const span = r * Math.sqrt(sh.w * sh.t);
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
    /**
     * The main tube flattens where a branch leaves it; a branch flattens at its
     * own mouth. Both halves of the same seam.
     */
    const holes = !isHood && path === this.path && this._holes.length ? this._holes : null;
    /**
     * …and the branch's own first rings, for the same reason from the other
     * side: ring zero is the disc that plugs the hole, and displacing it is
     * displacing the plug.
     */
    const mouthDamp = !isHood && path.base >= 0 && i < 3 ? smoothstep(clamp01(i / 3)) : 1;

    for (let j = 0; j < RADIAL; j++) {
      const phi = (j / RADIAL) * TAU - Math.PI * 0.5;
      section(phi, sh, sec);
      /**
       * AGAINST THE SECTION'S REAL DEPTH, NOT AGAINST `f`.
       *
       * `section` clamps the ellipse at `-f` only where the ellipse is deeper
       * than that, so a ring whose `t` is under its `f` — every bedding plane,
       * and that is the shape rooms are widest in — never reaches `-f` at all.
       * Dividing by `f` there means the deepest vertex on the floor scores
       * `t / f`, which for a bedding ring is 0.72, so 28% of the displacement
       * amplitude survives on the one surface that must not have any. In an
       * eleven-metre chamber at ROUGH 0.36 that is over a metre of rock between
       * where the floor is drawn and where the body walks, and it reads as
       * exactly what the player reported: hovering, or sunk to the shin.
       */
      const floorish = clamp01(-sec.y / Math.max(Math.min(sh.f, sh.t), 1e-3));
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
      let amp =
        r * (ROUGH_FLOOR + (rough - ROUGH_FLOOR) * (1 - floorish)) * (isHood ? 1.6 + 2.6 * lip : 1) * mouthDamp;
      // Flat around a junction, fading back to full over twice the opening.
      if (holes) {
        for (let h = 0; h < holes.length; h++) {
          const hh = holes[h];
          const dr = (i - hh.ring) / (hh.rings * 2.2);
          if (Math.abs(dr) > 1) continue;
          const dp =
            Math.abs(((phi - hh.phi + Math.PI) % TAU + TAU) % TAU - Math.PI) / (hh.span * 2.2);
          const e = Math.sqrt(dr * dr + dp * dp);
          if (e < 1) amp *= smoothstep(clamp01(e));
        }
      }

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
      /**
       * How much of the passage this vertex can see. Three terms, all of whose
       * inputs are already in hand: how open the space is, how deep into a
       * hollow the displacement has put this vertex, and the floor — which in
       * a real cave is silt, rubble and the darkest surface in it.
       *
       * The hood is exempt. It is standing in an afternoon, and occluding it
       * against a passage it is on the OUTSIDE of would put a shadow on the one
       * rock in this file that has a sun on it.
       */
      const ao = isHood
        ? 1
        : clamp01(
            (0.30 + 0.70 * clamp01((span - 1.5) / 5.5)) *
              (1 - 0.32 * clamp01(rn * 0.6 + 0.5)) *
              (1 - 0.26 * floorish)
          );
      this._shade(vi, px, py, pz, floorish, calcite, above, wetRing, span, ao);
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

  /**
   * Baked albedo, the light landing on it, where that light is coming from, and
   * how much of the room the point can see.
   *
   * AMBIENT OCCLUSION IS NEARLY THE WHOLE PICTURE DOWN HERE, and it is the
   * caller's to supply because only the caller knows the local relief. There is
   * no sky to be occluded from, so what `ao` measures is how much of the rest of
   * the passage a point can see: a wall in a squeeze is looking at another wall
   * a metre away, a wall in a chamber is looking at twenty metres of dark. The
   * near-field term gets this exactly backwards on its own — it is a function of
   * distance, so it lights a squeeze harder than a hall — and this is what puts
   * the sign back the right way round.
   */
  _shade(vi, x, y, z, floorish, calcite = 0, above = 99, damp = 0, span = 6, ao = 1) {
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
    /**
     * DARKER THAN IT WAS, BECAUSE THE WALL IS NOW WITHIN REACH.
     *
     * 0.30 + 0.22 peaks at 0.52 and the mottle below took it to 0.68, which is
     * chalk — real limestone is 0.3 to 0.4 dry and much less than that wet. It
     * was invisible while every passage was six metres across and the nearest
     * wall was three metres off; a canyon puts it at arm's length, and a 0.68
     * albedo at arm's length is a pale grey-green corridor with no darkness
     * anywhere in it. That is the same failure the near-field term's own comment
     * describes, arriving from the albedo side.
     *
     * Halving it also does the thing the lighting design has always claimed to
     * want: the fungi are unchanged in absolute terms, so they are now roughly
     * twice as important relative to the rock, and the passage is legible
     * BECAUSE of them rather than in spite of them.
     */
    let cr = 0.19 + vein * 0.15;
    let cg = 0.19 + vein * 0.10;
    let cb = 0.22 + vein * 0.04;
    // Damp, dark floor. Real cave floors are mud and rubble, not the walls.
    const wet = 1 - floorish * 0.42;
    cr *= wet;
    cg *= wet;
    cb *= wet;
    const mottle = noise2(x * 1.4, z * 1.4 + y * 0.8) * 0.09;
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
      /**
       * The banding is SMALL. `mottle` is already +/-0.16, so the first pass
       * multiplied it by 2.4 to "add variation" and took calcite to 0.84 —
       * brighter than the value it was introduced to bring down, and measurably
       * so: the probe read 0.79 off a column standing in a canyon.
       */
      const band = mottle * 0.6 + noise2(y * 3.1, (x + z) * 0.9) * 0.08;
      cr = lerp(cr, clamp01(0.33 + band), calcite);
      cg = lerp(cg, clamp01(0.29 + band), calcite);
      cb = lerp(cb, clamp01(0.24 + band), calcite);
    }

    /**
     * A NARROW PASSAGE IS DARKER ROCK, AND THIS IS THE ONLY HONEST FIX FOR THE
     * PROXIMITY PROBLEM.
     *
     * The near-field term is a function of DISTANCE, so the closer a wall is the
     * brighter it reads — which means a three-metre canyon is lit about twice as
     * hard as a twenty-metre chamber, and the tightest place in the cave comes
     * out as the palest. Retuning the exponent cannot fix that: it trades the
     * washed-out canyon for a black room, and I went round that loop twice.
     *
     * What breaks the tie is that the two really do differ in albedo. A squeeze
     * is where the water still runs — it is wet, silted and stained, and wet
     * limestone is roughly half the reflectance of dry. A big chamber is
     * abandoned and dusty. So the fix is a build-time multiply on the vertex
     * colour keyed to the local cross-section, it costs nothing per frame, and
     * it makes the canyon dark for a reason rather than by a fudge factor.
     */
    const open = 0.54 + 0.46 * clamp01((span - 1.9) / 4.6);
    cr *= open;
    cg *= open;
    cb *= open;

    // Wet rock is dark rock. The bank of a stream is the darkest thing here.
    if (damp > 0 && floorish > 0.35) {
      const d = damp * clamp01((floorish - 0.35) / 0.4) * 0.45;
      cr *= 1 - d;
      cg *= 1 - d;
      cb *= 1 - d;
    }

    /**
     * THE LIGHT, AND — THE PART THAT WAS MISSING — WHERE IT IS COMING FROM.
     *
     * Baking irradiance alone gives a number that the fragment shader can only
     * add, which is why the rock has always looked like painted card: a surface
     * lit by a term with no direction in it has no relief, so every bump the
     * geometry and the noise put there is invisible. The passage came out as
     * smooth coloured fabric no matter how much detail was under it.
     *
     * So the walk over the lights accumulates a second, vector quantity: the
     * irradiance-weighted mean direction toward them. One extra vec4 attribute,
     * still nothing per frame, still no light uniforms and no loop in the
     * shader — and with it the fragment can do an honest N.L against a normal
     * it has perturbed per pixel. That single change is most of the difference
     * between "a brown tube" and "rock".
     *
     * IT IS STORED UNNORMALISED, WHICH IS THE COHERENCE FOR FREE. The length of
     * a weighted mean of unit vectors is 1 when one cluster dominates and near 0
     * in the middle of a room lit from six sides — exactly how directional the
     * shading should be in each case. Normalising it away and carrying the
     * coherence in a fifth channel is the same number for another attribute
     * slot, and a vertex between two opposed lights would normalise noise up to
     * full strength and flicker against its neighbours.
     */
    let lr = 0;
    let lg = 0;
    let lb = 0;
    let dxs = 0;
    let dys = 0;
    let dzs = 0;
    let weight = 0;
    const lights = this.lights;
    for (let f = 0; f < lights.length; f++) {
      const g = lights[f];
      const dx = g.x - x;
      const dy = g.y - y;
      const dz = g.z - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const reach = g.reach;
      if (d2 > reach * reach) continue;
      // Quadratic falloff with a soft cut at the reach, so a cluster does not
      // draw a circle on the wall where its influence stops.
      const dist = Math.sqrt(d2) || 1e-3;
      const t = 1 - dist / reach;
      /**
       * THE GAIN WAS 0.29 AND EVERYTHING DOWN HERE WAS UNDEREXPOSED BECAUSE OF
       * IT.
       *
       * At that level a cluster three metres away put about 0.04 on the wall
       * next to it, against an ambient floor of a similar size — so the fungi
       * were not the light in the room, they were a tint on the murk, and the
       * whole passage sat inside half a stop of itself. That is the flat,
       * lightless grey-brown the pass before this one was still producing after
       * the shading had already been rewritten: the shader was fine and there
       * was nothing to shade with.
       *
       * Nearly three times that puts a lit wall around 0.35 and leaves the far
       * end of the gallery at the ambient floor, which is two and a half stops
       * of range inside one view. Contrast is the whole of what makes darkness
       * legible; a dark picture with no bright thing in it is just a dim one.
       */
      const fall = t * t * g.power * 0.8;
      lr += g.colour.r * fall;
      lg += g.colour.g * fall;
      lb += g.colour.b * fall;
      const lum = (g.colour.r + g.colour.g + g.colour.b) * fall;
      dxs += (dx / dist) * lum;
      dys += (dy / dist) * lum;
      dzs += (dz / dist) * lum;
      weight += lum;
    }
    const k4 = vi * 4;
    const inv = weight > 1e-6 ? 1 / weight : 0;
    b.glow[k4] = dxs * inv;
    b.glow[k4 + 1] = dys * inv;
    b.glow[k4 + 2] = dzs * inv;
    b.glow[k4 + 3] = ao;

    b.rock[k] = cr;
    b.rock[k + 1] = cg;
    b.rock[k + 2] = cb;
    /**
     * Irradiance times albedo, done here so the shader adds one term instead of
     * multiplying two. See the note in the fragment shader.
     *
     * AND SOFT-CLAMPED, WHICH IS THE ONLY THING KEEPING A SEAM FROM GOING
     * WHITE.
     *
     * The sum over the lights is unbounded by construction: a crystal seam is a
     * dozen sources within a few metres of the same wall, so a vertex in the
     * middle of one collects a dozen contributions that were each tuned to look
     * right on their own, and the passage came back as clipped lavender with no
     * shape in it at all. Turning any single source down instead trades that for
     * a cave whose ONE crystal, in a wide chamber where it is not stacking, is
     * too dim to be the destination it exists to be.
     *
     * x / (1 + x) is the cheapest curve with the two properties that matter: it
     * is almost exactly the identity while the sum is small — so a lone fungus
     * cluster is unchanged to two decimal places, and every tuning above this
     * line still means what it said — and it cannot exceed one however many
     * sources pile up. Per channel, so a seam saturates toward its own colour
     * rather than toward white, which is the whole point of CRYSTAL_KINDS.
     */
    b.lit[k] = (cr * lr) / (1 + lr * 0.85);
    b.lit[k + 1] = (cg * lg) / (1 + lg * 0.85);
    b.lit[k + 2] = (cb * lb) / (1 + lb * 0.85);
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
  _push(px, py, pz, nx, ny, nz, day, wet, calcite, floorish, above, damp, span = 6, ao = 1) {
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
    this._shade(vi, px, py, pz, floorish, calcite, above, damp, span, ao);
    // A surface that emits is one whose baked light is large and whose light
    // direction is its own normal. See `_emitCrystal`.
    const e = this._emit;
    if (e) {
      buf.lit[k] = e.r;
      buf.lit[k + 1] = e.g;
      buf.lit[k + 2] = e.b;
      buf.rock[k] = e.dr;
      buf.rock[k + 1] = e.dg;
      buf.rock[k + 2] = e.db;
      buf.glow[k4] = nx;
      buf.glow[k4 + 1] = ny;
      buf.glow[k4 + 2] = nz;
      buf.glow[k4 + 3] = 1;
    }
    return vi;
  }

  /**
   * The cross-section size at a path's ring, for the albedo.
   *
   * Everything standing on the floor takes it from the ring it was placed
   * against, so a boulder in a squeeze is as dark as the squeeze and the same
   * boulder in a chamber is not. Without this the loose geometry is shaded as
   * though it were always in a big room, which is exactly how it looked: dark
   * walls with pale blocks and columns floating in front of them.
   */
  _spanAt(path, ring) {
    const i = clamp(ring | 0, 0, path.x.length - 1);
    return path.r[i] * Math.sqrt(path.w[i] * path.t[i]);
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
   *
   * `inside` MAY BE NULL, WHICH MEANS "THE CALLER'S WINDING IS ALREADY RIGHT",
   * and there is exactly one caller that can say so honestly.
   *
   * The derived test assumes the face's own centroid is on the outer side of
   * its own plane, which is true of any convex solid and of every mildly bumpy
   * one. It is NOT true of a breakdown block: those are an icosahedron with each
   * vertex pushed along its own ray by up to a factor of 1.45 either way, so a
   * face with two pushed-out corners and one pulled-in has its centroid inside
   * its own plane, the test inverts it, and on a FrontSide material an inverted
   * face is not drawn at all. The symptom is a solid with a few triangles
   * missing — which does not read as a hole, it reads as a shard of glass lying
   * in the floor, and it survived two rounds of screenshots being mistaken for
   * a shape problem rather than a winding one.
   *
   * A block does not need the test: the icosahedron's face list is wound
   * counter-clockwise from outside by construction, and pushing vertices along
   * their own rays cannot change that. Topology beats geometry here.
   */
  _face(p, q, r, s, inside, day, calcite, floorish, above, damp, wet = 0, span = 6, ao = 1) {
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
    const flip = inside
      ? nx * (inside[0] - cx) + ny * (inside[1] - cy) + nz * (inside[2] - cz) > 0
      : false;
    if (flip) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const pts = s ? [p, q, r, s] : [p, q, r];
    const idx = pts.map((v) =>
      this._push(v[0], v[1], v[2], nx, ny, nz, day, wet, calcite, floorish, above, damp, span, ao)
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
    let s = k - this.blocks.length;
    if (s < this.spires.length) return this._emitSpire(this.spires[s]);
    s -= this.spires.length;
    if (s < this.crystals.length) return this._emitCrystal(this.crystals[s]);
    return this._emitWater(this.water[s - this.crystals.length]);
  }

  /**
   * A crystal: a tapered hexagonal prism with a point on it.
   *
   * EMISSIVE BY HIJACKING THE BAKED-LIGHT CHANNELS RATHER THAN BY ADDING ONE.
   * `aLit` is "light leaving this vertex" and `aGlow.xyz` is "the direction the
   * light it receives comes from" — so a surface that emits is exactly a surface
   * whose aLit is large and whose light direction is its own normal. The
   * fragment shader's N.L then comes out at full strength on every facet and
   * needs no branch, no uniform and no seventh attribute; and because the term
   * still runs through the same wrap, the facets angled away from the eye fall
   * off slightly, which is what makes a cluster glitter rather than glow as one
   * lump.
   *
   * The body colour is pushed nearly to black at the same time. A crystal is not
   * a lit rock, it is a light with an edge, and leaving the limestone albedo
   * under the emission is what made the first attempt look like painted stone.
   */
  _emitCrystal(cr) {
    const path = this.paths[cr.path];
    const day = this._daylight(path, cr.ring);
    const span = this._spanAt(path, cr.ring);
    const rng = makeRng(`${getWorldSeed()}:cave-gem:${this.c.k}:${cr.seed}`);
    const SIDES = 6;

    // An orthonormal frame about the spike's own axis.
    const ax = cr.dx;
    const ay = cr.dy;
    const az = cr.dz;
    let ux = 0;
    let uy = 1;
    let uz = 0;
    if (Math.abs(ay) > 0.92) {
      ux = 1;
      uy = 0;
    }
    let e1x = uy * az - uz * ay;
    let e1y = uz * ax - ux * az;
    let e1z = ux * ay - uy * ax;
    const e1l = Math.hypot(e1x, e1y, e1z) || 1;
    e1x /= e1l;
    e1y /= e1l;
    e1z /= e1l;
    const e2x = ay * e1z - az * e1y;
    const e2y = az * e1x - ax * e1z;
    const e2z = ax * e1y - ay * e1x;

    /**
     * The shoulder at 0.7 rather than a cone straight to the point. A crystal is
     * a prism that has been terminated, and the flat run before the tip is the
     * whole reason one reads as grown rather than as a spike — it is where the
     * facets are parallel and where the highlight runs.
     */
    const SHOULDER = 0.68;
    const flute = [];
    for (let i = 0; i < SIDES; i++) flute.push(rngRange(rng, 0.82, 1.16));
    const at = (t, widen) => {
      const ring = [];
      for (let i = 0; i < SIDES; i++) {
        const a = (i / SIDES) * TAU;
        const rr = cr.rad * flute[i] * widen;
        const cs = Math.cos(a) * rr;
        const sn = Math.sin(a) * rr;
        ring.push([
          cr.x + ax * cr.len * t + e1x * cs + e2x * sn,
          cr.y + ay * cr.len * t + e1y * cs + e2y * sn,
          cr.z + az * cr.len * t + e1z * cs + e2z * sn,
        ]);
      }
      return ring;
    };
    const base = at(0, 1);
    const neck = at(SHOULDER, 0.82);
    const tip = [cr.x + ax * cr.len, cr.y + ay * cr.len, cr.z + az * cr.len];
    const mid = [
      cr.x + ax * cr.len * 0.4,
      cr.y + ay * cr.len * 0.4,
      cr.z + az * cr.len * 0.4,
    ];

    /**
     * Bright enough to reach the bloom's threshold and then some. The bright
     * pass cuts in at 0.85 and this material's output at the tip lands around
     * two and a half, which is a hard core with a wide halo — the look of
     * something too bright to focus on, which is the whole effect.
     */
    /**
     * THE BODY EMITS THE RIM COLOUR, NOT THE CORE COLOUR.
     *
     * The core is deliberately pale — it is what the halo sprite and the very
     * tip are made of — and putting it on the facets as well took every crystal
     * in the cave to clipped white. A blown highlight has no hue, so a violet
     * seam, a green seam and an amber seam all came out as the same white shard
     * with a faintly coloured wall behind it, which throws away the one property
     * CRYSTAL_KINDS exists to give a cave.
     *
     * A third of the way toward the core keeps some of the pale in the mix,
     * clips only the middle of each facet, and leaves a coloured fringe around
     * it — which is what the bloom then spreads.
     */
    const p = 1.15 + cr.power * 1.1;
    this._emit = {
      r: lerp(cr.colour.r, cr.core.r, 0.34) * p,
      g: lerp(cr.colour.g, cr.core.g, 0.34) * p,
      b: lerp(cr.colour.b, cr.core.b, 0.34) * p,
      dr: cr.colour.r * 0.06,
      dg: cr.colour.g * 0.06,
      db: cr.colour.b * 0.06,
    };
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES;
      this._face(base[i], base[j], neck[j], neck[i], mid, day, 0, 0, 99, 0, 0, span, 1);
      this._face(neck[i], neck[j], tip, null, mid, day, 0, 0, 99, 0, 0, span, 1);
    }
    this._emit = null;
  }

  /**
   * A breakdown block, and the single most-complained-about object in the cave.
   *
   * IT WAS A BOX. Eight corners, six quads, per-corner jitter of up to 30% —
   * which sounds like enough and is not, because jittering the corners of a
   * cuboid gives you a cuboid. The topology is the silhouette: four vertical
   * edges and one flat top read as a crate at any jitter you like, and a room
   * with sixty of them in it read, in the player's words, as a room full of 3D
   * trapezoids. No amount of shading fixes an outline.
   *
   * THE OBVIOUS REPLACEMENT WAS ALSO WRONG. The first attempt was an
   * icosahedron with its twelve corners pushed about — twenty triangles, no
   * parallel edges, definitely not a box — and a chamber full of them read as a
   * scatter of low-poly GEMS. That is a worse answer than the box, because a
   * faceted ball is a shape nothing in a cave makes and a box at least has the
   * excuse of being slab-shaped. The eye reads the DISTRIBUTION of the normals,
   * not how many there are: twenty small facets spread evenly over a sphere are
   * a sphere, however hard the corners are jittered.
   *
   * What comes off a limestone ceiling is a SLAB. One big top face; one big
   * bottom face, on the ground and never seen; a handful of tall fracture faces
   * between them, at whatever angles the joints happened to run; and the whole
   * thing lying over because it landed on the last one that fell. Every one of
   * those is a property of an irregular leaning prism and not one of them is a
   * property of a polyhedron approximating a sphere.
   *
   * So: seven sides, with the angles AND the radii drawn independently so the
   * plan is a ragged polygon rather than a heptagon, a top face tilted on its
   * own plane with a little relief in it, and the base buried deeper than the
   * block is tall. Big faces, long arrises, and a silhouette that changes
   * completely as you walk round it — which is what all three versions of this
   * were reaching for.
   */
  _emitBlock(bl) {
    const rng = makeRng(`${getWorldSeed()}:cave-block:${this.c.k}:${bl.seed}`);
    const path = this.paths[bl.path];
    const day = this._daylight(path, bl.ring);
    const span = this._spanAt(path, bl.ring);
    /**
     * The base goes further under the floor than the block stands above it, so
     * it is never on screen. A slab resting exactly on the analytic floor shows
     * a seam all the way round wherever the visible floor's own displacement
     * dips under it — which is everywhere, because the floor carries its own
     * rock noise — and that is the whole "the boulders are hovering" class of
     * screenshot. It costs two triangles a side that nobody ever sees.
     */
    const yTop = bl.y + bl.top;
    const yBot = bl.y - bl.top * 0.5 - 0.5;

    /**
     * The lean, and it is what makes a field of these read as a collapse rather
     * than as a car park. Slabs come to rest against each other and against the
     * rubble under them, so they sit at angles; a scatter of level ones reads as
     * placed, whatever shape they are.
     */
    const leanA = rngRange(rng, 0, TAU);
    const leanK = rngRange(rng, 0.22, 0.7);
    const tiltX = Math.cos(leanA) * leanK;
    const tiltZ = Math.sin(leanA) * leanK;

    /**
     * THE FIRST TUNING OF THIS WAS FAR TOO POLITE AND CAME OUT AS BOXES AGAIN.
     *
     * Radii from half to just over one, angles jittered by a fifth of a step,
     * and a top plane with a tenth of the block's height of relief on it. Every
     * one of those is a reasonable-sounding number and together they describe a
     * squat cylinder with a lid — which the eye files under "box" just as fast
     * as an actual box, because at this scale what it is reading is "no corner
     * is much different from any other corner".
     *
     * A quarter to one and a half on the radius, half a step on the angle, and a
     * per-corner height drawn independently of the tilt plane. The point is that
     * the corners must DISAGREE: one that sticks a long way out next to one that
     * barely does is what a fracture looks like, and a flat top is the single
     * most box-like feature a solid can have.
     */
    /**
     * AND THE TOP IS A DIFFERENT POLYGON FROM THE BOTTOM, WHICH IS THE ONE THAT
     * FINALLY KILLED THE BOX.
     *
     * A prism has vertical sides. Ragged them all you like — jitter the plan,
     * break the lid, lean the whole thing over — and every side face is still
     * parallel to every other side face's own vertical, so the silhouette is a
     * vertical-walled lump with a jagged hat on it and the eye still says box.
     * Verticality WAS the tell, not regularity.
     *
     * So the top ring is drawn separately: smaller by a large and random factor,
     * shoved sideways by up to half the radius, and with its own per-corner
     * scatter. Now no two side faces share a slope, none of them is vertical,
     * and the thing has an overhang on one side and a ramp on the other — which
     * is what a lump of fractured limestone lying in silt actually looks like.
     */
    const shrink = rngRange(rng, 0.28, 0.72);
    const skewX = rngRange(rng, -0.5, 0.5) * bl.rad;
    const skewZ = rngRange(rng, -0.5, 0.5) * bl.rad;
    const plan = [];
    for (let i = 0; i < BLOCK_SIDES; i++) {
      const a = bl.rot + (i / BLOCK_SIDES) * TAU + rngRange(rng, -0.5, 0.5);
      const rr = bl.rad * rngRange(rng, 0.26, 1.5);
      const bx = bl.x + Math.cos(a) * rr;
      const bz = bl.z + Math.sin(a) * rr;
      const s = shrink * rngRange(rng, 0.55, 1.4);
      plan.push({
        bx,
        bz,
        tx: bl.x + (bx - bl.x) * s + skewX,
        tz: bl.z + (bz - bl.z) * s + skewZ,
        // Each corner's own height, on top of the tilt. A third of the block.
        own: rngRange(rng, -0.34, 0.16) * bl.top,
      });
    }
    /** The tilted top, plus this corner's own break. */
    const topAt = (px, pz, own) =>
      yTop +
      (px - bl.x) * tiltX +
      (pz - bl.z) * tiltZ +
      own +
      rock(px * 1.6, yTop, pz * 1.6) * bl.top * 0.2;

    const above = bl.top * 0.5;
    const centreTop = topAt(bl.x + skewX, bl.z + skewZ, 0);
    const inside = [bl.x, (centreTop + yBot) * 0.5, bl.z];
    for (let i = 0; i < BLOCK_SIDES; i++) {
      const j = (i + 1) % BLOCK_SIDES;
      const a = plan[i];
      const b = plan[j];
      const at = topAt(a.tx, a.tz, a.own);
      const bt = topAt(b.tx, b.tz, b.own);
      /**
       * The fracture face: a sloped quad from the buried base ring to the
       * smaller, shoved top ring, and DARK. The gaps between fallen rock are
       * where a chamber's shadow actually lives, and them being dark is what
       * makes a breakdown floor read as something with depth rather than as a
       * pattern on the ground.
       */
      this._face(
        [a.bx, yBot, a.bz],
        [b.bx, yBot, b.bz],
        [b.tx, bt, b.tz],
        [a.tx, at, a.tz],
        inside, day, 0, 0.85, above, 0.25, 0, span, 0.34
      );
      // …and one wedge of the top, fanned from the middle so the tilt reads as
      // a tilt rather than as a flat lid set at an angle.
      this._face(
        [bl.x + skewX, centreTop, bl.z + skewZ],
        [a.tx, at, a.tz],
        [b.tx, bt, b.tz],
        null,
        inside, day, 0, 0.85, above, 0.25, 0, span, 0.95
      );
    }
  }

  /** Stalactites, stalagmites, columns and draperies. */
  _emitSpire(sp) {
    const path = this.paths[sp.path];
    const day = this._daylight(path, sp.ring);
    const span = this._spanAt(path, sp.ring);
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
        this._face(p0, p1, p2, p3, [mx + sp.dirZ * off, my, mz - sp.dirX * off], day, 1, 0.1, half + 2, 0, 0, span);
        this._face(p0, p1, p2, p3, [mx - sp.dirZ * off, my, mz + sp.dirX * off], day, 1, 0.1, half + 2, 0, 0, span);
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
            0,
            0,
            span
          );
        }
      }
      return;
    }

    /**
     * A STALACTITE IS NOT A CONE, AND ONE BAND OF SIX FACETS IS A PARTY HAT.
     *
     * The old emitter was a fan of six triangles from a base circle to a point:
     * straight sides, constant taper, no horizon anywhere on it for the light to
     * fall off across. Standing under one it read as folded card, which is the
     * same complaint the columns had before they were given a waist, and the
     * same fix applies.
     *
     * Three bands and eight facets, on a profile that is a power curve rather
     * than a line — fat at the root, drawn out toward the tip — with a per-band
     * lateral wander so the thing hangs slightly crooked. Water does not deposit
     * evenly and nothing that grew for ten thousand years is straight.
     *
     * Ninety-six vertices against eighteen, on an object a decorated passage has
     * eighty of. That is the budget this pass spends most of, and it is spent
     * here because a speleothem at arm's length is the object in a cave a player
     * actually looks AT.
     */
    const dir = sp.kind === 'mite' ? 1 : -1;
    const SEGS = 8;
    const BANDS = 3;
    const inside = [sp.x, sp.y0 + dir * sp.h * 0.35, sp.z];
    const flute = [];
    for (let i = 0; i <= SEGS; i++) flute.push(rngRange(rng, 0.78, 1.22));
    flute[SEGS] = flute[0];
    const leanX = rngRange(rng, -0.16, 0.16) * sp.h;
    const leanZ = rngRange(rng, -0.16, 0.16) * sp.h;
    // Fat at the root, drawn out to the tip: (1 - t) to the power of 0.62 is
    // the profile of something deposited by a drip rather than turned on a lathe.
    const prof = (t) => sp.rad * Math.pow(Math.max(0, 1 - t), 0.62) * (1 + 0.22 * Math.sin(t * 7.1 + sp.seed * 11));
    const at = (t) => ({
      y: sp.y0 + dir * sp.h * t,
      rr: prof(t),
      ox: leanX * t * t,
      oz: leanZ * t * t,
    });
    const tip = [sp.x + leanX, sp.y0 + dir * sp.h, sp.z + leanZ];
    for (let b = 0; b < BANDS; b++) {
      const lo = at(b / BANDS);
      const hi = at((b + 1) / BANDS);
      const last = b === BANDS - 1;
      for (let i = 0; i < SEGS; i++) {
        const a0 = (i / SEGS) * TAU;
        const a1 = ((i + 1) / SEGS) * TAU;
        const f0 = flute[i];
        const f1 = flute[i + 1];
        const p0 = [sp.x + lo.ox + Math.cos(a0) * lo.rr * f0, lo.y, sp.z + lo.oz + Math.sin(a0) * lo.rr * f0];
        const p1 = [sp.x + lo.ox + Math.cos(a1) * lo.rr * f1, lo.y, sp.z + lo.oz + Math.sin(a1) * lo.rr * f1];
        const p2 = [sp.x + hi.ox + Math.cos(a1) * hi.rr * f1, hi.y, sp.z + hi.oz + Math.sin(a1) * hi.rr * f1];
        const p3 = [sp.x + hi.ox + Math.cos(a0) * hi.rr * f0, hi.y, sp.z + hi.oz + Math.sin(a0) * hi.rr * f0];
        // The last band closes on the tip, so it is a triangle and not a quad.
        this._face(
          p0,
          p1,
          last ? tip : p2,
          last ? null : p3,
          inside,
          day,
          1,
          dir > 0 ? 0.5 : 0.05,
          dir > 0 ? sp.h * 0.4 : 99,
          0,
          0,
          span,
          // Occluded at the root where it meets the rock, open at the tip.
          0.4 + 0.6 * (b / BANDS)
        );
      }
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
      this._face(prev.l, prev.r, cur.r, cur.l, below, this._daylight(path, i), 0, 1, 0.02, 1, 1, this._spanAt(path, i));
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
              /**
               * ELLIPTICAL, NOT RECTANGULAR. A box in (ring, phi) has corners
               * outside the branch's ring-zero ellipse — that is what a bore is
               * — so a rectangular window is a window with four holes at its
               * corners. Same normalised test the branch's own section uses.
               */
              const dr = (i - h.ring) / h.rings;
              if (Math.abs(dr) > 1) continue;
              const dp =
                (Math.abs(((phiC - h.phi + Math.PI) % TAU + TAU) % TAU - Math.PI)) / h.span;
              if (dr * dr + dp * dp <= 1) {
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
          /**
           * A BRANCH'S FIRST RINGS ARE WOUND BOTH WAYS, and this is what finally
           * closed the junction.
           *
           * The tube is FrontSide with inward normals, so a branch's snout only
           * occludes when you are looking INTO its bore. Stand to one side of a
           * junction and your line of sight passes through the snout's near wall
           * — which is not drawn — then through the hole cut in the main tube,
           * and out of the mountain. What you see is a hard-edged wedge of sky,
           * and it survives every adjustment to the hole's size and shape,
           * because the hole was never the problem: three separate fixes to the
           * cut changed nothing at all, which is the tell.
           *
           * Emitting the collar rings a second time with the opposite winding
           * makes the snout solid from every angle. Three rings is about a metre
           * and a half, it costs 144 triangles per junction, and from inside it
           * reads as the rim of the opening — which is what an opening in rock
           * has.
           */
          if (p > 0 && i < 3) {
            b.index[t++] = a;
            b.index[t++] = d;
            b.index[t++] = c;
            b.index[t++] = c;
            b.index[t++] = d;
            b.index[t++] = e;
          }
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
    const position = new THREE.BufferAttribute(b.position.subarray(0, used * 3), 3);
    /**
     * The lattice's indices and the extras' indices are built into two arrays —
     * the lattice's count is not known until the holes have been cut, and the
     * extras are emitted before that — so they are joined here. One copy of a
     * few tens of thousands of ints, once per cave.
     */
    const index = new Uint32Array(b.tri + b.ex);
    index.set(b.index.subarray(0, b.tri), 0);
    index.set(b.exIndex.subarray(0, b.ex), b.tri);

    /**
     * NOTHING IS ATTACHED TO THE GEOMETRY HERE. See `_prime`: the seven buffers
     * go on one per frame, and a geometry with no attributes and no index is
     * submitted, binds nothing and uploads nothing.
     *
     * The bounding sphere still has to be computed from the positions, so they
     * are attached, measured and taken off again. Nothing has been drawn yet, so
     * there is no GL buffer to lose by doing that.
     */
    geo.setAttribute('position', position);
    geo.computeBoundingSphere();
    geo.deleteAttribute('position');
    // The melt moves this by up to a metre or so; a passage that popped out of
    // the frustum at the peak while you were standing inside it would be the
    // worst possible moment for it. Same reasoning as TRIP_SLACK in ground.js.
    geo.boundingSphere.radius += 3;

    const deferred = [
      ['position', position],
      ['index', new THREE.BufferAttribute(index, 1)],
      ['normal', new THREE.BufferAttribute(b.normal.subarray(0, used * 3), 3)],
      ['aRock', new THREE.BufferAttribute(b.rock.subarray(0, used * 3), 3)],
      ['aLit', new THREE.BufferAttribute(b.lit.subarray(0, used * 3), 3)],
      ['aSurf', new THREE.BufferAttribute(b.surf.subarray(0, used * 4), 4)],
      ['aGlow', new THREE.BufferAttribute(b.glow.subarray(0, used * 4), 4)],
    ];

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
    this.group.add(mesh);

    this._buildFungi();
    this._buffers = null;
    /**
     * NEITHER `mesh` NOR `ready` IS PUBLISHED HERE ANY MORE. Both are set at the
     * end of `_prime`, seven frames from now.
     *
     * `ready` is what `CaveField` stops slicing on and what every cave script
     * waits for; `mesh` is what four of those scripts reach straight through to
     * `geometry.index.count` and `attributes.position.count`. In between, this
     * geometry legitimately has neither. Publishing it half-built would turn a
     * timing change into a null dereference in a test, so the rule the field
     * already relied on is kept and strengthened: if `cave.mesh` exists, its
     * buffers are complete and on the GPU.
     */
    this._priming = { mesh, deferred, next: 0 };
    /**
     * Submitted every frame from now until primed, and drawing zero triangles
     * while it is. Both are undone together in `_prime`.
     */
    mesh.frustumCulled = false;
    geo.setDrawRange(0, 0);
    if (this.points) {
      this.points.frustumCulled = false;
      this.points.geometry.setDrawRange(0, 0);
    }
  }

  /**
   * SPREAD THE THREE MEGABYTES OVER SEVEN FRAMES INSTEAD OF SPENDING THEM ON ONE.
   *
   * A finished passage is 32-37 000 vertices carrying six float attributes plus
   * 140-170 000 indices — 3.1 to 3.5 MB, the largest single upload in the world
   * by a wide margin, and until this existed the whole of it landed on whichever
   * frame the mesh first entered the frustum, which is a frame the PLAYER chose
   * by turning his head. Worst frame containing it measured 17.4 ms, against a
   * 5 ms budget on the target machine. One buffer per frame caps it at the
   * largest single one, which is the index at around 600 KB.
   *
   * WHY ATTRIBUTES AND NOT PIECES OF MESH. Three keys its GL buffers on the
   * BufferAttribute, and `bindingStates.setup` uploads whichever attributes the
   * PROGRAM asks for and the geometry currently has. So attaching one attribute
   * per frame to a geometry that is already being submitted uploads exactly that
   * attribute on that frame, and the completed mesh's first real draw finds
   * every buffer already resident. No mesh is split, no draw call is added in
   * the steady state, and not one vertex moves.
   *
   * WHY `setDrawRange(0, 0)` MAKES THIS SAFE. A geometry missing `aRock` would
   * shade from a generic attribute value — garbage — if it rasterised anything.
   * `renderBufferDirect` computes its draw count before it binds, and rejects
   * only a NEGATIVE or infinite one, so a zero-length range still runs
   * `bindingStates.setup` (the upload) and then draws nothing at all. The vertex
   * shader never runs; this is cheaper than the ordinary culled path.
   *
   * WHY THE EIGHT FRAMES ARE NOT A VISUAL CHANGE. The build is armed at
   * BUILD_RANGE, 320 m from the mouth, and already takes ten or more frames of
   * ring slicing during which there is no mesh at all. Eight more frames of a
   * passage that did not exist a moment ago is 33-133 ms further into a wait
   * that is half a minute of sprinting from anywhere it could be seen from.
   *
   * MEASURED, by timing the seven `bufferData` calls a cave needs against a
   * context that had never seen them: 0.6-1.4 ms of client time for the set,
   * and one run in ten where a single 396 KB allocation cost 13.2 ms on its own
   * because the driver grew its heap. That outlier is per-allocation and cannot
   * be optimised away — but seven chances of it on one frame is a different
   * proposition from one, and either way it now lands 320 m from anybody.
   *
   * Returns true when the passage is finally whole.
   */
  _prime() {
    const p = this._priming;
    const geo = p.mesh.geometry;
    if (p.next < p.deferred.length) {
      const [name, attribute] = p.deferred[p.next++];
      if (name === 'index') geo.setIndex(attribute);
      else geo.setAttribute(name, attribute);
      return false;
    }
    /**
     * One more call than there are buffers, because the last one attached has
     * not been submitted yet: `step` runs from `CaveField.update`, which is a
     * frame ahead of the render that does the uploading.
     */
    this._priming = null;
    geo.setDrawRange(0, Infinity);
    p.mesh.frustumCulled = true;
    if (this.points) {
      this.points.geometry.setDrawRange(0, Infinity);
      this.points.frustumCulled = true;
    }
    this.mesh = p.mesh;
    this.ready = true;
    return true;
  }

  /**
   * The glowing heads, and the crystals' halos, in one cloud.
   *
   * A CRYSTAL NEEDS A HALO AND THE GEOMETRY CANNOT GIVE IT ONE. The faceted
   * prism is opaque and ends where it ends, so however bright it is the glow
   * stops dead at its silhouette — and a light source with a hard edge reads as
   * a painted shape, not as something too bright to look at. The halo is what
   * the air around a bright thing does, and here it is one additive sprite per
   * spike, sized to the spike, riding the same cloud and the same draw the fungi
   * already use. Free, and it is most of what sells them from a distance.
   */
  _buildFungi() {
    let count = 0;
    for (const g of this.fungi) count += g.count;
    count += this.crystals.length + this.spores.length;
    if (!count) return;
    const pos = new Float32Array(count * 3);
    const tint = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const size = new Float32Array(count);
    const drift = new Float32Array(count);
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
        drift[at] = 0;
        at++;
      }
    }
    for (const cr of this.crystals) {
      // On the spike's mid-point rather than its tip, so the halo is centred on
      // the mass of it and does not read as a spark hanging off the end.
      pos[at * 3] = cr.x + cr.dx * cr.len * 0.55 - this.originX;
      pos[at * 3 + 1] = cr.y + cr.dy * cr.len * 0.55 - this.originY;
      pos[at * 3 + 2] = cr.z + cr.dz * cr.len * 0.55 - this.originZ;
      tint[at * 3] = cr.core.r;
      tint[at * 3 + 1] = cr.core.g;
      tint[at * 3 + 2] = cr.core.b;
      seed[at] = cr.seed;
      size[at] = 1.4 + cr.len * 1.9;
      drift[at] = 0;
      at++;
    }
    /**
     * SPORES, AND THE AIR IS THE LAST THING IN A CAVE THAT WAS STILL DEAD.
     *
     * Everything else down here is rock: it does not move, and after the melt
     * and the breath were pinned nearly to nothing on the floor for the reasons
     * ROUGH_FLOOR gives, the one place a passage was allowed to be alive was
     * gone too. A room where the only motion is your own head is a room that
     * reads as a photograph, however well lit — and it is the specific reason a
     * cave that was correct in every other respect felt like a corridor.
     *
     * These are the cheapest possible fix and very nearly the best one: a few
     * hundred points in the same cloud, the same draw and the same material as
     * the fungus heads, drifting on three sines in the vertex shader. They cost
     * one attribute and no CPU at all. What they buy is parallax — something at
     * two metres moving against a wall at twenty is the strongest depth cue
     * there is, and depth is exactly what a dark space lacks.
     *
     * TINTED BY WHAT IS NEAR THEM, not by a fixed colour, so a spore in a
     * crystal seam is the seam's colour and one in a plain gallery is the
     * fungi's. They are lit by the room in the only sense an additive sprite
     * can be.
     */
    for (const s of this.spores) {
      pos[at * 3] = s.x - this.originX;
      pos[at * 3 + 1] = s.y - this.originY;
      pos[at * 3 + 2] = s.z - this.originZ;
      tint[at * 3] = s.colour.r;
      tint[at * 3 + 1] = s.colour.g;
      tint[at * 3 + 2] = s.colour.b;
      seed[at] = s.seed;
      size[at] = s.size;
      drift[at] = s.drift;
      at++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aDrift', new THREE.BufferAttribute(drift, 1));
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
    // A passage dropped while its buffers were still going up: the mesh is in
    // the group but has not been published as `this.mesh` yet.
    this._priming?.mesh.geometry.dispose();
    this.points?.geometry.dispose();
    this.group.clear();
    this.mesh = null;
    this.points = null;
    this._buffers = null;
    this._priming = null;
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
  /** …and the floor with nothing lying on it. See the note where it is set. */
  floorRock: 0,
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
      /**
       * The bounding reject. See where `_bpad` is built, in the constructor:
       * the box encloses every ring centre on this path and the pad is the
       * widest section it has anywhere, so a point outside cannot be inside
       * this passage and the two scans below would only have proved it the
       * expensive way.
       *
       * Skipping the path also skips its `_hint` write, which is deliberately
       * harmless: the two-pass widen exists precisely to survive a stale hint,
       * and re-entering a cave after walking away is exactly the jump case its
       * second pass was written for.
       */
      const p = path._bpad;
      if (p !== undefined) {
        if (x < path._bx0 - p || x > path._bx1 + p) continue;
        if (z < path._bz0 - p || z > path._bz1 + p) continue;
        if (y < path._by0 - p || y > path._by1 + p) continue;
      }
      const n = path.x.length;
      let best = Infinity;
      let bi = 0;
      const hint = path._hint | 0;
      const from = Math.max(0, hint - 30);
      const to = Math.min(n, hint + 31);
      /** The window the centre scan actually covered, for the fit below. */
      let scanLo = from;
      let scanHi = to;
      for (let pass = 0; pass < 2; pass++) {
        const lo = pass === 0 ? from : 0;
        const hi = pass === 0 ? to : n;
        scanLo = lo;
        scanHi = hi;
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
        /**
         * WIDEN UNLESS THE WINDOW'S BEST IS BOTH INTERIOR AND ACTUALLY NEAR.
         *
         * The old test was interior alone — "a hit against the edge means the
         * real nearest ring is probably outside it" — which is true and is not
         * enough. A passage bends, so the in-window minimum is very often
         * interior while the real nearest ring is fifty rings away: the window
         * simply contains a local minimum. When that happens the scan keeps a
         * ring twenty metres off, the fit cannot reach past the window either,
         * nothing claims the body, `caveFloorUnder` falls back to `groundUnder`
         * — and the floor clamp fires the player up out of the mountain onto the
         * hillside above it.
         *
         * It only bites after a JUMP of more than the window: a walking body
         * moves a ring a frame and the hint is always fresh, which is why this
         * survived. The first `caveSample` after a cave streams in is a jump
         * (the hint is zero), and so is every teleport in every test script —
         * `cave-tour.mjs` caught it standing on the axis of three rings in a
         * row, reported as inCave 0 with the eye at ground level.
         *
         * The second condition is the honest one: if the best the window can
         * offer is further away than that ring's own section is wide, the
         * window is the wrong window whatever the shape of the minimum.
         */
        if (pass === 0) {
          const reach = path.r[bi] * path.w[bi] + 3;
          if (bi > from && bi < to - 1 && best < reach * reach) break;
        }
      }

      /**
       * NEAREST CENTRE IS NOT THE SAME QUESTION AS WHICH SECTION YOU ARE IN, AND
       * IN A BIG CHAMBER THEY GIVE DIFFERENT ANSWERS.
       *
       * The scan above minimises distance to a ring CENTRE, which is right when
       * every ring is the same size: the sections are congruent, so the nearest
       * centre owns you. A breakdown chamber is eleven metres across and its
       * neighbours two rings along are five, and the axis meanders — so a body
       * standing eight metres out in the room is nearer, in plain metres, to the
       * centre of a narrow ring further along than to the centre of the wide
       * ring it is actually standing inside. That narrow ring then reports the
       * body as outside the cave altogether, `caveFloorUnder` falls back to
       * `groundUnder`, and the floor becomes the summit fifty-five metres up.
       *
       * So the centre scan picks a neighbourhood and this picks the ring out of
       * it, on the measure that actually matters: how deep inside its own
       * section the body is, in the section's own units. Twenty-one rings of
       * arithmetic, no allocation, and it runs only after the window has already
       * been narrowed.
       */
      let bestFit = Infinity;
      {
        /**
         * OVER THE WHOLE WINDOW THE CENTRE SCAN COVERED, NOT TEN RINGS EITHER
         * SIDE OF ITS ANSWER.
         *
         * Ten rings was chosen as "a neighbourhood", on the assumption that the
         * nearest CENTRE is at worst a few rings from the section you are
         * standing in. That assumption fails exactly where it costs most. A
         * bedding plane is 2.1 radii wide, so its half-width here is nine and a
         * half metres — a body three quarters of the way to the wall is seven
         * metres off the axis, and in a chamber whose axis meanders, some ring
         * thirty along passes closer to that point than its own ring does. The
         * fit window then never contains the right ring, no ring claims the
         * point, and `caveFloorUnder` hands back the hillside seventeen metres
         * overhead. One probe in eleven hundred, and it was the last of the
         * mid-air standing.
         *
         * Sixty-one rings of arithmetic instead of twenty-one, three times a
         * frame, on a loop with no allocation in it. The centre scan walks the
         * same window and nobody has ever costed that either.
         */
        const lo = scanLo;
        const hi = Math.min(n - 1, scanHi - 1);
        let fit = bi;
        for (let i = lo; i <= hi; i++) {
          const ri = path.r[i];
          if (ri < 1e-3) continue;
          const a2 = Math.max(0, i - 1);
          const b2 = Math.min(n - 1, i + 1);
          let tx = path.x[b2] - path.x[a2];
          let tz = path.z[b2] - path.z[a2];
          const tl = Math.hypot(tx, tz) || 1;
          tx /= tl;
          tz /= tl;
          const rx = path.x[i] - x;
          const rz = path.z[i] - z;
          const al = rx * tx + rz * tz;
          const hxi = rx - tx * al;
          const hzi = rz - tz * al;
          const horizI = Math.hypot(hxi, hzi);
          // 1 at the wall, 1 at the floor or roof, 1 a ring-step fore or aft.
          const u = horizI / (ri * path.w[i]);
          const dy = (y - path.y[i]) / ri;
          const v = dy > 0 ? dy / Math.max(path.t[i], 1e-3) : -dy / Math.max(path.f[i], 1e-3);
          /**
           * A UNION OVER THIS WINDOW WAS TRIED HERE AND IS NOT THE ANSWER.
           *
           * The mesh is a swept tube, so the void really is the union of every
           * section that reaches a point, and in a chamber a dozen of them do.
           * Taking the lowest closed the last two metres of hover in the biggest
           * rooms — and opened four metres of it in the squeezes that lead into
           * them, because a twenty-metre ring reaches back along the axis far
           * enough to claim a body standing in a two-metre one. Every gate that
           * fixed the squeeze un-fixed the chamber; measured, the union was 349
           * disagreements against 80 without it.
           *
           * The real fault is that a chamber's floor follows a swept ellipse
           * down a meandering axis, which is not what the floor of a breakdown
           * chamber is. It is fixed in the geometry — see `flatten` — rather
           * than papered over here.
           */
          /**
           * THE ALONG GATE IS IN METRES, NOT IN RING STEPS.
           *
           * It was `RING_STEP * 1.5`, which quietly narrowed from 1.7 m to
           * 1.4 m when the step was cut to sharpen the mesh — and the frame
           * after that change one probe in eleven hundred came back with no ring
           * claiming it at all, which is the fifty-five-metre hover in
           * miniature. How far fore or aft of a ring's plane a body may be and
           * still be in its section is a fact about bodies and passages; it has
           * nothing to do with how finely the sweep happens to be sampled, and
           * tying it to that makes the collision quietly a function of a
           * rendering decision.
           */
          const m = Math.max(u, v, Math.abs(al) / 1.9);
          if (m < bestFit) {
            bestFit = m;
            fit = i;
          }
        }
        bi = fit;
      }

      /**
       * REJECTED ON THE FIT, NOT ON A DISTANCE IN METRES.
       *
       * The old gate was "further from this ring's centre than its half-width
       * plus 2.5 m", which is a sound test against the ring the CENTRE scan
       * picked and an unsound one against the ring the FIT picked — those are
       * routinely different, and a point comfortably inside a wide ring's
       * section can be well past a narrow neighbour's half-width plus two and a
       * half metres. When that fired the whole path was skipped, no other path
       * claimed the point either, and `caveFloorUnder` fell back to
       * `groundUnder`: one probe in eleven hundred, standing three quarters of
       * the way to the wall, handed a floor seventeen metres over its head.
       *
       * `bestFit` is already the answer to the question the gate is asking —
       * how far outside the nearest section this point is, in that section's own
       * units, on whichever of the three axes is worst. Past 2.2 of those the
       * point is in rock and no floor here is meaningful.
       */
      if (bestFit > 2.2) continue;
      const r = path.r[bi];
      const sh = ringShape(path, bi, _shapeA);

      path._hint = bi;
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
      /**
       * THE OFFSET IS MEASURED ACROSS THE PASSAGE, NOT TO THE RING'S CENTRE.
       *
       * The ring nearest you is rarely the one you are level with — walking
       * forward, the nearest centre sits slightly behind — so the vector to it
       * has a component ALONG the passage. Using its full length as "how far off
       * the centre line am I" overstates the offset, and pushing along it pushes
       * you backwards.
       *
       * That backward component is a trap with a stable equilibrium, and it cost
       * a long hunt: in a keyhole's slot the wall is about a metre from the axis,
       * the push fires every frame, and the backward part of it exactly cancels
       * a walking pace. The body runs at full speed, on level ground, in a
       * passage with two feet of clearance either side, and does not move —
       * indistinguishable from being blocked by geometry, which is what it was
       * mistaken for three times.
       *
       * Projecting the tangent out leaves a pure sideways push, which is also
       * what makes sliding along a wall feel like sliding rather than like being
       * held.
       */
      const a2 = Math.max(0, bi - 1);
      const b2 = Math.min(n - 1, bi + 1);
      let tx = path.x[b2] - path.x[a2];
      let tz = path.z[b2] - path.z[a2];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const rawX = path.x[bi] - x;
      const rawZ = path.z[bi] - z;
      const alongComp = rawX * tx + rawZ * tz;
      const hx = rawX - tx * alongComp;
      const hz = rawZ - tz * alongComp;
      const horiz = Math.hypot(hx, hz);

      /**
       * FLOOR AND CEILING AT THE OFFSET THE BODY IS ACTUALLY AT.
       *
       * Not at the axis. See `floorAt`: most rings have no flat floor at all,
       * and taking the axis value for the whole width put the reported ground
       * 2.4 m under the visible rock three quarters of the way to the wall.
       *
       * The ceiling gets the same treatment and then a floor of MIN_HEAD over
       * the ground, which is a deliberate asymmetry. Too LOW a ceiling is the
       * dangerous one — it is the roof clamp pressing a body down into a floor
       * that is pushing it up, in a place too dark to understand why — and near
       * the wall of a bedding plane the true section closes to nothing. Too high
       * a ceiling costs only that you do not duck where you might have.
       */
      const nx = horiz / r;
      const floorRock = path.y[bi] + r * floorAt(nx, sh);
      const ceiling = Math.max(path.y[bi] + r * ceilAt(nx, sh), floorRock + MIN_HEAD);
      let floor = floorRock;

      /**
       * CONTAINMENT IN METRES, NOT IN FRACTIONS OF THE HALF-WIDTH.
       *
       * `1.35 - horiz / halfWidth` was a ramp 35% of the passage wide, which is
       * 60 cm in a squeeze and FIVE METRES in a breakdown chamber. The second
       * number is the bug: in a big room the ramp starts falling the moment you
       * leave the axis, `caveFloorUnder` reads a part-strength ramp as "half
       * outdoors" and blends the floor toward `groundUnder` — which underground
       * is the top of the mountain. Measured on grove-01, three quarters of the
       * way to the wall of one chamber the body was handed a floor FIFTY-FIVE
       * METRES above the rock: you walk out into the room and rise off the
       * ground. That is the "it just floats me in midair" report, and it is why
       * the biggest, best chambers were the least enterable places in the world.
       *
       * A fixed slack past the wall is the same distance in both, clamped so a
       * squeeze still gets enough of a ramp to crossfade the reverb over a
       * stride rather than a footfall.
       */
      const wallHere = r * sh.w;
      const slack = clamp(wallHere * 0.5, 0.8, 1.8);
      const inside =
        clamp01((wallHere + slack - horiz) / slack) * clamp01((ceiling + 1.2 - y) / 1.2) * ends;
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
       * The wall, at the narrowest height the body actually occupies.
       *
       * IT WAS CHEST HEIGHT ALONE, and the reasoning for that was half right.
       * The eye is at 1.68 m and in a keyhole that is up in the bore where there
       * is room to spare, so a body that measured its clearance there would walk
       * its shoulders into the slot — true, and the reason chest height is one of
       * the two samples. But every ROUND section narrows the other way: the bore
       * is widest at the waist, so at eye height the wall is nearer than it is at
       * the chest, and a body held out only by its shoulders puts its HEAD in the
       * rock. That is most of "I'm clipping into walls often": you are not
       * clipping the wall, you are clipping the part of it over the wall you were
       * measuring.
       *
       * The minimum of the two is right in both shapes and costs one more solve.
       * Foot level is deliberately not sampled: the section closes to nothing at
       * the floor, and the body is standing ON the floor, so the half-width there
       * is a fact about the rock rather than a constraint on the body.
       */
      const chest = clamp(y - 0.85, floor + 0.2, ceiling - 0.15);
      const head = clamp(y - 0.12, floor + 0.2, ceiling - 0.15);
      const outline = Math.min(
        halfWidthAt((chest - path.y[bi]) / r, sh),
        halfWidthAt((head - path.y[bi]) / r, sh)
      );
      /**
       * …less what the rock displacement takes back, which is the other half.
       *
       * `halfWidthAt` solves the SMOOTH outline, and the mesh is that outline
       * displaced radially by up to `r * rough` — inward as often as outward. So
       * the drawn wall is routinely most of a metre inside the wall the body is
       * being held at, on a passage whose `rough` is 0.36, and the head goes into
       * the bulge. Backing off by half the amplitude puts the body against the
       * mean surface rather than against its outer envelope: it still brushes the
       * bulges, which is what a rough passage should feel like, instead of
       * passing through them.
       */
      const wall = Math.max(0.35, r * outline - r * path.rough[bi] * WALL_BITE);

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
      /**
       * The passage's own floor, WITHOUT anything lying on it.
       *
       * Published beside `floor` so the step rule in controller.js can tell the
       * two apart. A rise because you have reached a breakdown block is a step
       * and may be too tall to take; a rise because the analytic floor moved
       * between one ring and the next is an artefact of this function, and
       * treating it as a step would put an invisible wall across the passage —
       * `cave-walk` caught exactly that, one mouth of three stopping dead at
       * 12.5 m with no stall to show for it.
       */
      _sample.floorRock = floorRock;
      _sample.ceiling = ceiling;
      // The point on the centre LINE level with the body, rather than the ring's
      // own centre — so the push that aims at it is perpendicular by
      // construction. See the projection above.
      _sample.cx = x + hx;
      _sample.cy = path.y[bi];
      _sample.cz = z + hz;
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
  const ramp = clamp01((s.inside - 0.05) / 0.3);
  if (ramp >= 1) return floor;
  const g = groundUnder(x, z);
  /**
   * …AND THE BLEND ONLY EXISTS AT THE DOORWAY.
   *
   * Everything the paragraph above says is true of the mouth and false of the
   * other two hundred metres. Thirty metres inside a hillside `groundUnder` is
   * the summit, so a ramp that has dipped below 1 for any reason — being off
   * the axis of a wide chamber was the one that bit — hands the body a floor
   * part of the way up a mountain and it rises off the ground into the dark.
   *
   * So the blend is gated on being somewhere the two floors can actually agree:
   * within a few metres of ring zero AND at or above the height of the terrain.
   * Past that the passage floor is the only floor there is, and it is returned
   * whatever the containment ramp thinks.
   */
  const mouth = clamp01(1 - s.along / 8) * clamp01((y + 1.2 - g) / 2.4);
  if (mouth <= 0) return floor;
  const w = ramp + (1 - ramp) * (1 - mouth);
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
    /**
     * One system to leave submitted while the body is buried, by name, or null.
     *
     * Read once a frame by the cave block in main.js — never written by it — so
     * that `scripts/cave-perf.mjs` can price the underground occlusion one
     * system at a time against the shipping configuration. Null in every build
     * nobody is measuring, which is all of them.
     */
    this.perfUnhide = null;
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
      const whole = cave.step();
      /**
       * IN THE SCENE AS SOON AS THERE IS A MESH, NOT WHEN IT IS FINISHED.
       *
       * The last six slices of a build are `Cave._prime` feeding the passage's
       * attributes to the GPU one per frame, and an object that is not in the
       * scene is not submitted and therefore uploads nothing. So the group goes
       * in the moment `_finish` has made a mesh — which draws no triangles until
       * the priming is over, by a draw range of zero.
       */
      if (cave.group.children.length && cave.group.parent !== this.group) {
        this.group.add(cave.group);
      }
      if (whole) this.built++;
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
  occludeWorld(forest, mix, depth, keep = false) {
    const cave = live.length ? _sample.cave : null;
    /**
     * The blind distance is the PASSAGE's, not the cave's, now that there is
     * more than one passage. A branch measures its own — see the note where it
     * is set — and reading the main line's here would let a lead that leaves
     * eight metres inside the mouth delete the forest while you can still see
     * out of it.
     */
    const want = !keep && mix > 0.995 && cave !== null && depth > _sample.blind;
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
