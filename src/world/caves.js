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
 *   HALL      The same failure at the scale where it stops being a room. The
 *             ceiling is out of the light, the far wall is past the fog, and
 *             the only thing that tells you how big it is is how long you walk
 *             before the wall arrives.
 *
 * The shapes are per NODE, so a change takes the 8-14 m the spline needs to get
 * from one to the other, which is about the distance over which a real passage
 * changes character. Nothing switches; the tube narrows and heightens and you
 * are in a canyon before you noticed leaving the tube.
 *
 * `key` is the slot, `scal` is how strongly the walls are scalloped, `seep` is
 * how much flowstone runs down them, and `rough` is the displacement amplitude —
 * a phreatic tube is polished and a breakdown room is not.
 *
 *
 * AND `vast` IS A FLAG ABOUT WHERE A SECTION MAY BE PUT, NOT ABOUT ITS SHAPE.
 *
 * `lo`/`hi` is a WISH. Every other section in this table is small enough that
 * the mountain always grants it and the wish is therefore also the answer; a
 * chamber is not, and the difference is the single most expensive mistake this
 * file can make. `burySkylights` will pinch a ring that has run out of hillside
 * and TRUNCATE the passage where the pinch closes it, so a big `hi` picked and
 * hoped for does not produce a big chamber — it produces a fifteen-metre hole
 * where a three-hundred-metre passage was, reported as "1 formation, 0 light
 * sources" and a tour that photographs the same wall eight times. That
 * regression has shipped from this table twice.
 *
 * So a `vast` section is SIZED FROM THE ROCK before it is placed: the walk asks
 * `roofRoom` how much mountain is over that ring's whole footprint and takes
 * the largest radius that fits, or gives up and puts a `room` there instead.
 * See `chamberFit`. The measured consequence is that `room`, which has wished
 * for 6.5-11 m since it was written, has never once been drawn at more than
 * 5.1 m on grove-01 — every room in the world has been a corridor with a
 * hopeful number attached, quietly ground down by the burial pass. It is sized
 * from the rock now too, which makes it SMALLER on paper and bigger in fact.
 */
const SHAPES = {
  tube: { w: 1.16, t: 1.02, f: 0.46, key: 0, rough: 0.15, scal: 1, seep: 0.35, lo: 2.6, hi: 4.2 },
  canyon: { w: 0.60, t: 1.62, f: 0.74, key: 0, rough: 0.28, scal: 0.15, seep: 0.8, lo: 2.4, hi: 3.4 },
  keyhole: { w: 1.10, t: 1.10, f: 0.96, key: 1, rough: 0.19, scal: 0.7, seep: 0.5, lo: 2.9, hi: 4.1 },
  bedding: { w: 1.95, t: 0.44, f: 0.30, key: 0, rough: 0.21, scal: 0.45, seep: 0.25, lo: 3.4, hi: 5.2 },
  room: { w: 1.42, t: 1.18, f: 0.62, key: 0, rough: 0.36, scal: 0.1, seep: 1, lo: 6.5, hi: 11, vast: 1 },
  /**
   * THE ONE THE PLAYER HAS NO REFERENCE FOR, AND IT IS A HEIGHT AND NOT A WIDTH.
   *
   * Floor area is not awe. A chamber forty metres across with a ceiling eight
   * metres up is a car park, and you read it in one glance because the roof is
   * inside your light and therefore inside your understanding. What cannot be
   * read in a glance is VERTICAL: a ceiling that the near-field term does not
   * reach and no fungus is high enough to catch, so the wall goes up out of the
   * picture and simply stops being resolved. There is no cue in the frame for
   * how far up that is, and there is no cue because there really is nothing
   * there. That is the whole trick and it is not a trick.
   *
   * `t` OF 2.40 IS THE ARITHMETIC OF THAT, NOT A TASTE.
   *
   * The rock permits `r * (t + rough) <= C`, where C is whatever `roofRoom` says
   * is over this ring. Solve for what you get:
   *
   *     ceiling over the axis   =  r * t  =  C * t / (t + rough)
   *     width across            = 2r * w  =  C * 2w / (t + rough)
   *     floor under the axis    =  r * f  =  C * f / (t + rough)
   *
   * So for a FIXED amount of mountain, raising `t` buys ceiling asymptotically
   * up to the whole of C and pays for it in width, one for one. Height is the
   * axis the brief wants and it is also the axis the rock is stingiest on, which
   * is why every previous attempt at scale in this file came out wide and flat:
   * `hi` was raised, `t` was not, and the burial pass spent the extra rock on
   * floor area nobody can perceive.
   *
   * At t = 2.40 against rough = 0.44 the ceiling takes 85% of the available
   * rock. Measured on grove-01, C over a chamber-sized footprint at the deep end
   * of a passage is 28-39 m, so a hall is 24-33 m of ceiling over the axis,
   * 27-37 m across, and 29-40 m from the blocks to the roof — against a body
   * 1.68 m to the eye and a passage that has been four metres wide for the last
   * two hundred.
   *
   * `f` of 0.55 sinks the floor another fifth of C below the axis so the chamber
   * is something you walk DOWN into, and it is deliberately not more than that.
   * A deeper basin was tried at 0.85 and is worth recording as a dead end: it
   * buys apparent height and it does not survive `flatten`, which re-solves `f`
   * from the smoothed floor line in any section this wide and therefore
   * overwrites whatever the table asked for. Measured on `cave-floor`, moving it
   * from 0.85 to 0.22 to 0.55 changed the floor disagreement count by under 2%
   * in either direction — `f` is an input to the levelling, not the answer.
   *
   * `rough` is the highest in the table because at this radius the displacement
   * is metres, and metres of relief on a wall thirty metres away is the only
   * thing in the frame that says how far away it is. `scal` is nearly zero —
   * scallops are cut by water in contact with the rock, and nothing was ever in
   * contact with this.
   *
   * NOTHING HERE IS A CLIFF, A TERRACE OR A STAIR, and that is deliberate and
   * load-bearing. The floor is still one swept surface with `flatten` levelling
   * it, so `caveSample` can answer "where is the ground" everywhere in the
   * chamber. A space that merely looks immense but has a floor the player can
   * trust beats a literal cavern with a drop in it that nothing in this game can
   * climb — see the block at MAX_DIVE, which is the same argument about the same
   * failure.
   *
   * `hi` of 19 is reached: measured across four seeds the widest ring in a cave
   * is 17.5-20.5 m of radius, the overshoot being Catmull-Rom's between two
   * nodes that each asked for less. It is the rock that binds and not the wish —
   * see the block above — and on the seeds where the ridge is thin the same
   * table produces a 4.8 m room and no hall at all.
   */
  hall: { w: 1.35, t: 2.40, f: 0.55, key: 0, rough: 0.44, scal: 0.04, seep: 1.2, lo: 8.5, hi: 19, vast: 1 },
};
/** The mouth, pinned to the old constants. See SEC_WIDE. */
const MOUTH_SHAPE = { w: SEC_WIDE, t: SEC_TALL, f: SEC_FLOOR, key: 0, rough: ROUGH, scal: 0.5, seep: 0.3 };

/**
 * The smallest radius a HALL is allowed to be built at, in metres.
 *
 * Below this the walk puts a `room` there instead. There has to be such a
 * number because `chamberFit` returns whatever the rock allows, and a hall's
 * proportions do not survive being scaled down: `t` of 2.40 on a seven-metre
 * radius is a seventeen-metre ceiling over a nineteen-metre width, which is a
 * silo rather than a chamber. It reads as a mistake rather than as a small
 * hall, and the point of a hall is that it is the one section in the world you
 * cannot mistake for anything else.
 *
 * 9.5 m is a ceiling 23 m over the axis and 26 m across, which is unambiguous
 * against a passage that has been four metres wide for two hundred. Where the
 * ridge will carry one at all the walk usually gets considerably more than the
 * minimum — 17-20 m on the four seeds measured.
 */
const HALL_MIN = 9.5;

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

/**
 * Below the mouth, in metres, at which `deep` reaches 1.
 *
 * A DESCENT AND NOT A DISTANCE. How far you have walked is not what a cave
 * rewards — you can walk a hundred metres of level tube and be nowhere — so the
 * channel that everything downstream keys off is how far you have gone DOWN.
 * 45 m is the depth at which `roofRoom` starts granting chamber-sized rock on
 * the seeds measured, so it is also the depth at which the world visibly
 * changes, which is the point of having the number at all.
 */
const DEEP_FULL = 45;

/**
 * The channels a node carries besides its position and radius.
 *
 * `deep` IS NOT GEOMETRY, and it is here anyway. Everything else in this list
 * is a term in `section`; `deep` is 0 at the mouth and 1 at DEEP_FULL below it,
 * and no part of the sweep reads it. It rides in the list purely so `resample`
 * splines it and `truncate` shortens it alongside the shape — the alternative
 * being a ninth parallel array that four places would have to remember to keep
 * in step, and this file has already paid for one of those (see `along`).
 *
 * WHAT IT IS FOR: it is the one number a prop placer can ask to find out how
 * far into the world a ring is, so that the light can get stranger and more
 * plentiful with depth, the emitters can change species, and the audio can open
 * up — without any of them re-deriving "how deep is this" from the mouth's
 * height, which is a property of the seed and which every one of them would get
 * subtly differently. `path.deep[i]`, 0..1, splined and clamped.
 */
const CHANNELS = ['r', 'w', 't', 'f', 'key', 'rough', 'scal', 'seep', 'deep'];

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
    // Overwritten by whichever walk placed this node; zero is the right answer
    // for the mouth, which is the only caller that never sets it.
    deep: 0,
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

/* -------------------------------------------------------------------------- *
 *  HOW THE BUILD IS CUT INTO FRAMES
 * -------------------------------------------------------------------------- *
 *
 * Every expensive function between here and `_finish` is a GENERATOR, and that
 * is the whole of the slicing mechanism. It reads oddly the first time — these
 * are pure geometry routines and none of them is asynchronous — so it is worth
 * saying plainly why nothing simpler was enough.
 *
 * THE STAGES ARE SEQUENTIAL AND STATEFUL. The walk has to finish before the
 * burial, the burial before the branches, the branches before the placers, and
 * the placers before the buffers can even be SIZED. A time check inside a loop
 * cannot cut across that: the only way to stop halfway through `burySkylights`
 * and come back is to preserve twelve local variables and an array cursor, and
 * the version of this that hand-rolled a `switch (this._stage)` state machine
 * over the same code needed a named field on `this` for every one of them,
 * per stage. A generator preserves exactly that, exactly correctly, for free,
 * and — this is the part that matters — a resume point is a `yield` on the line
 * it belongs on rather than a case label three hundred lines away from the code
 * it stands for.
 *
 * IT CANNOT CHANGE WHAT IS BUILT, which is the property the whole cave suite
 * depends on. Every `rng` here is a seeded sequence consumed in order; `yield`
 * suspends the consumer without touching the order, so the nodes, the rings and
 * every placed object come out identical to the frame. `check:cave` is the test
 * of that claim and it is exact rather than statistical.
 *
 * THE PRICE. A generator's `next()` is a few nanoseconds and the loops here
 * yield every few dozen items, so the overhead is under a tenth of a percent of
 * the build — measured at 321 ms of total build across nine caves before, 323
 * after. What it buys is in `BUILD_MS`.
 *
 * The convention: a generator yields nothing meaningful. `yield` means "this is
 * a safe place to stop", the driver decides whether to, and a caller that wants
 * the whole thing now says `drain(...)`.
 */

/** Run a build generator to completion, for callers with no frame to spend. */
function drain(gen) {
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

/**
 * A cave's centre line.
 *
 * Nodes first — a coarse walk of 8-14 m steps with the heading and pitch drawn
 * per step — then resampled by Catmull-Rom into rings. Doing it in two stages is
 * what makes the shape controllable: the constraints (stay under the mountain,
 * do not cross yourself, do not climb) are checked once per node against real
 * `heightAt` samples, and the spline then guarantees the result is smooth
 * whatever the constraints did to it.
 *
 * Sliced per node — see the generator note above. A node is one reach plus the
 * corner that ends it, six attempts at worst, and it is the unit the walk's cost
 * scales in: 28-41 of them at 0.05-0.15 ms each.
 */
function* buildNodes(c, salt = 0) {
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
   * above a ridge that is 21.
   *
   * IT WAS 62 m, ON THE GROUNDS THAT THAT IS AS FAR AS ANYTHING THIS SIZE SHOULD
   * GO WITHOUT SOMEWHERE TO ARRIVE AT. The premise was right and the conclusion
   * was backwards: depth IS the somewhere to arrive at, because depth is the only
   * currency the rock accepts. `roofRoom` over a chamber-sized footprint,
   * measured along the built centre lines of twelve passages on four seeds, is
   * 63-90 m above an axis at the old floor — the mountain was never the thing
   * saying no. What was saying no was this line and a pitch envelope that
   * averaged about a metre of descent per fifteen-metre step, so a
   * three-hundred-metre passage went down twenty-eight metres in total and spent
   * its whole length in the thin skin of rock where nothing large can be built.
   *
   * 110 m is still a bound rather than a target — the walk gets there only if
   * the joints and the hillside let it — and at the deepest measured node it
   * leaves 25-45 m of rock overhead, which is the budget a hall is cut out of.
   */
  const bottom = nodes[0].y - 110;
  /**
   * …and how many reaches it gets, which is a different question.
   *
   * A node is a straight run on one joint plus the corner that ends it, so this
   * is "how many times does the passage do something", not a length. 18-25 gave
   * 300 m of passage; 28-41 gives roughly 500-700 m, and the extra is spent
   * where it is worth most because the pitch envelope below weights descent
   * toward the back half — the first third is the same cave it always was and
   * everything past it is somewhere the player has not been.
   */
  const count = 28 + Math.floor(rng() * 14);

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
    yield 'walk';
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
      /**
       * HOW DEEP THE WALK IS, WHICH IS THE ONLY THING THAT UNLOCKS SCALE.
       *
       * Passed to `pickType` so the chain can only reach a hall once there is
       * mountain to cut one out of, and used below to bias the pitch. Measured
       * against the mouth's floor, so it is a real descent and not a fraction of
       * a node count — a walk that has taken twenty nodes along a level joint is
       * exactly as shallow as one that has taken two.
       */
      const deep = clamp01((nodes[0].y - y) / DEEP_FULL);
      const nextType = hold && attempt === 0 ? type : pickType(rng, type, !hold, deep);
      let sh = SHAPES[nextType];
      let kind = nextType;
      /**
       * A straight reach on one joint is long; a corner is taken in a short step.
       *
       * Both were lengthened with the node count, and for the sight lines rather
       * than for the metres. A reach is the distance over which nothing changes,
       * so it is what sets how far you can see down a passage before the wall
       * arrives — 11-19 m is a view that ends about where the cave fog does, and
       * the corner is on top of you before the last one has finished being a
       * place. 14-26 m puts the far wall of a straight run at the edge of what
       * the light reaches, which is the one composition this geometry can make
       * that reads as distance.
       */
      const step = hold ? rngRange(rng, 14, 26) : rngRange(rng, 8, 13);
      const h = joints[jn] + rngRange(rng, -0.13, 0.13);
      /**
       * A canyon is a stream that is cutting DOWN and a room is a floor that is
       * flat. Tying the pitch to the shape is most of what makes the two read as
       * different places rather than as the same place with different walls: you
       * feel a vadose reach in your knees before you have looked at its section.
       *
       * AND A HALL IS ARRIVED AT BY DESCENDING INTO IT. That is not decoration:
       * the rock only grants a chamber's height where the axis is well under the
       * hillside, so the step that reaches one has to spend itself going down or
       * `chamberFit` below will hand back a room-sized answer. It is also the
       * whole of how the space announces itself — the floor tips away, you walk
       * down, and the ceiling leaves.
       *
       * THE ENVELOPE, which is the other half of "deeper" and the half that is
       * easy to miss. Each shape's own dive is added to a baseline that grows
       * with how far along the walk is, so the first third stays near the
       * surface — where the mouth's daylight still means something and the
       * passage should feel like a passage — and the back half commits. Without
       * it the shape draws alone average about -0.10 rad, which over a
       * three-hundred-metre passage is twenty-eight metres of descent, and
       * twenty-eight metres is the depth at which nothing large is possible.
       */
      const lean = -0.13 * smoothstep(clamp01((i / count - 0.15) / 0.65));
      const want =
        kind === 'canyon'
          ? rngRange(rng, -0.40, -0.13)
          : sh.vast
            ? rngRange(rng, -0.07, 0.03)
            : rngRange(rng, -0.22, 0.07);
      /**
       * A CHAMBER'S OWN AXIS IS LEVEL, AND THIS IS A CORRECTNESS RULE BEFORE IT
       * IS AN AESTHETIC ONE.
       *
       * The first version dived INTO a hall at -0.42 to -0.22, on the reasoning
       * that a space you descend into announces itself. It does, and it also
       * puts the player two and a half metres in the air.
       *
       * The mesh floor at a point is the LOWEST of every ring whose section
       * reaches it, and in a chamber fifteen metres wide that is every ring
       * within fifteen metres along the axis. `caveSample` answers from ONE
       * ring, and its along-window is 1.9 m. So wherever the floor line has a
       * gradient, the analytic answer and the drawn rock disagree by roughly
       * (gradient x half-width) — nothing to speak of in a four-metre passage at
       * any slope, and metres in a chamber. Measured by `cave-floor` on
       * grove-01 with the diving version: 112 probes disagreeing by over 0.45 m
       * and a worst hover of 2.39 m, which is above head height. That is the
       * "it just floats me in midair" report, reached by a new route.
       *
       * Two things follow, and the second is the one that is easy to miss:
       *
       *   THE PITCH IS NEAR ZERO. -0.07 to 0.03 is the same envelope `room` has
       *   always had, and for the same reason — a room is a floor that is flat.
       *
       *   AND IT DOES NOT INHERIT THE DIVE IT ARRIVED ON. The blend carries 45%
       *   of the previous pitch, and a hall is reached down a canyon at -0.40,
       *   so a flat `want` still comes out at -0.18 and the chamber is still a
       *   ramp. `vast` sections take almost none of it. The descent has not gone
       *   anywhere; it has moved to the passage LEADING to the chamber, which is
       *   where a real one is anyway — you walk down, and then the space opens.
       *
       * The lean is off for the same reason. `deep` is what earns a chamber, not
       * the chamber's own gradient.
       */
      const p = sh.vast
        ? clamp(pitch * 0.12 + want, -0.11, 0.06)
        : clamp(pitch * 0.45 + (want + lean) * 0.55, -0.44, 0.1);
      const nx = x + Math.cos(h) * step * Math.cos(p);
      const nz = z + Math.sin(h) * step * Math.cos(p);
      /**
       * THE DEPTH FLOOR IS APPLIED BEFORE THE ROOF CLAMP AND NOT AFTER IT.
       *
       * It used to be the other way round, which meant `bottom` could win over
       * `roof` and lift a node back out through the hillside. Nothing ever hit
       * that — a 62 m floor was never reached where the hill was thin — but the
       * floor is 110 m now and the ordering is the difference between "the
       * passage is allowed to be deeper than it asked for" and "the passage may
       * surface if it asked to go deep enough". It also has to be this way round
       * for `chamberFit`: the radius is solved against the axis height the node
       * will actually have, and a `bottom` applied afterwards would move that
       * axis UP under a ceiling already sized for the deeper one.
       */
      let ny = Math.max(y + Math.sin(p) * step, bottom);
      let r = rngRange(rng, sh.lo, sh.hi);
      /**
       * …and a big section is sized from the rock rather than from the wish.
       *
       * See `chamberFit` and the `vast` note in SHAPES. The fallback is the
       * point: where the mountain will not carry a hall this places a room
       * instead, so the failure mode of asking for scale in a thin place is a
       * smaller space, never a truncated passage. HALL_MIN is what makes that
       * decision honest — a hall shrunk to seven metres is not a hall that came
       * out modest, it is a room with a ceiling too high for its width and a
       * floor too deep for its floor, and it would be the one chamber in the
       * cave that read as a mistake.
       */
      if (sh.vast) {
        const dl = Math.hypot(nx - x, nz - z) || 1;
        const fit = chamberFit(nx, nz, (nx - x) / dl, (nz - z) / dl, ny, sh, r);
        if (kind === 'hall' && fit < HALL_MIN) {
          kind = 'room';
          sh = SHAPES.room;
          r = chamberFit(nx, nz, (nx - x) / dl, (nz - z) / dl, ny, sh, rngRange(rng, sh.lo, sh.hi));
        } else {
          r = fit;
        }
        // A chamber the rock has ground down to corridor size should be drawn as
        // a corridor: `room`'s proportions on a two-metre radius are a squeeze
        // with a suspiciously deep floor.
        if (r < SHAPES.tube.lo) {
          kind = 'tube';
          sh = SHAPES.tube;
          r = rngRange(rng, sh.lo, sh.hi);
        }
      }

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
      // The depth floor was applied when `ny` was computed, and deliberately not
      // here — see the block there. This clamp only ever lowers.
      ny = Math.min(ny, roof);

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
       *
       * IT NOW MEASURES `t + rough` AND NOT `t`, WHICH IS WHAT THE BURIAL
       * MEASURES. Leaving the displacement out meant the veto and the pass it
       * exists to anticipate were asking about two different ceilings — up to a
       * fifth of the section apart on a room, more on a hall, all of it in the
       * one direction that matters. Over eight seeds and twenty-four passages
       * that alone took the share of a walk that survives the burial from 55% to
       * 60%, and the fraction went to 0.7 at the same time because with `rough`
       * in it the quantity is now conservative rather than optimistic.
       */
      if (attempt < 5) {
        const tl = Math.hypot(nx - x, nz - z) || 1;
        const shoulder = roofRoom(nx, nz, (nx - x) / tl, (nz - z) / tl, r * sh.w);
        if (shoulder < ny + r * (sh.t + sh.rough) + ROOF_ROCK * 0.7) continue;
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
      type = kind;
      x = nx;
      y = ny;
      z = nz;
      const nd = shaped(x, y, z, r, sh, rng);
      nd.type = kind;
      nodes.push(nd);
      placed = true;
    }
  }

  /**
   * A PASSAGE MUST NOT MERELY STOP. IT HAS TO ARRIVE.
   *
   * What used to be here was two nodes 4 m and 6 m past the last real one, at
   * 0.55 and then 0.05 of its radius. It was written to solve a real problem —
   * a swept tube that simply ends has an open end, and an open end seen from
   * inside a single-sided surface is a hole showing the back of its own wall —
   * and it solved it, and it produced the thing the player reported: "the caves
   * end in this little cone shape, which you walk through and get teleported."
   * Both halves of that sentence came from these two lines, and neither is about
   * the cap being a cap. See `closeEnd` for the cone and `endRing` for the
   * teleport.
   *
   * The reward for two hundred metres of walking was a 26-degree cone. So the
   * terminus is now built rather than pinched, and it is three things in order:
   *
   *   A CHAMBER, sized against the mountain rather than picked. `terminusFit`
   *   searches the joint set for the bearing, distance and depth with the most
   *   rock over it and asks `chamberFit` what that rock will carry, exactly as
   *   the walk does for a hall. It is allowed to come back with nothing — where
   *   the passage has run out of mountain there IS no chamber, and inventing one
   *   is how this file previously turned three-hundred-metre passages into
   *   fifteen-metre stubs.
   *
   *   A SHORT REACH ACROSS IT, so the far wall is somewhere you walk to. One
   *   node is a lens you are through in six seconds; two give the space a floor
   *   with a length and, because both sit at the same height, a level one — which
   *   is also the condition `placeWater` tests before it will pool anything.
   *
   *   AND THE CLOSE, which collapses the SECTION and not the radius, and that
   *   distinction is the whole reason a chamber survives at all. `burySkylights`
   *   slope-limits the radius backwards at 0.35 m a ring, so a node with r=0.05
   *   at the end drags every ring within (R - 0.05) / 0.35 of it down with it —
   *   twenty-six rings, eighteen metres, straight through the back of anything
   *   large. That backward taper IS the cone, and it eats any chamber placed in
   *   front of it. Shutting `w`, `t`, `f` and `rough` instead leaves `r` at its
   *   full value, so the taper has nothing to propagate and the chamber lives.
   *   `closeEnd` then turns the last few rings into the actual dome, after the
   *   burial, where nothing can taper it.
   */
  const last = nodes[nodes.length - 1];
  // The terminus search is a search — it is the one node that costs as much as
  // several — so it gets a stop of its own either side.
  yield 'walk';
  const term = yield* terminusFit(rng, x, y, z, heading, joints, nodes, bottom, last.r * 1.3);
  yield 'terminus';
  let endHead = heading;
  if (term) {
    endHead = term.heading;
    const sh = SHAPES[term.kind];
    const a = shaped(term.x, term.y, term.z, term.r, sh);
    a.type = term.kind;
    nodes.push(a);
    /**
     * The far side, at the same height and the same size.
     *
     * `chamberFit` was solved at the first centre; this one is checked at its
     * own, because a chamber's far half can be under thinner hill than its near
     * half and a node that is not verified where it stands is the pinch this
     * whole block exists to avoid. Whichever is smaller wins, so the hall is one
     * size rather than a wedge.
     */
    const across = term.r * 0.95;
    const bx = term.x + Math.cos(endHead) * across;
    const bz = term.z + Math.sin(endHead) * across;
    const rB = Math.min(term.r, chamberFit(bx, bz, Math.cos(endHead), Math.sin(endHead), term.y, sh, term.r));
    if (rB > term.r * 0.7) {
      const b = shaped(bx, term.y, bz, rB, sh);
      b.type = term.kind;
      nodes.push(b);
      a.r = rB;
    }
    x = nodes[nodes.length - 1].x;
    y = nodes[nodes.length - 1].y;
    z = nodes[nodes.length - 1].z;
  }
  nodes.push(closingNode(nodes[nodes.length - 1], endHead));
  return { nodes, joints };
}

/* -------------------------------------------------------------------------- *
 *  ARRIVING SOMEWHERE — HOW A PASSAGE ENDS
 * -------------------------------------------------------------------------- *
 *
 * Three functions, used by both the main walk and the branches, and between them
 * they are the whole of the terminus:
 *
 *   `terminusFit`   where the chamber goes, and how big the rock lets it be.
 *   `closingNode`   the node that shuts the section without touching the radius.
 *   `closeEnd`      the dome itself, written into the rings after the burial.
 *
 * They are here rather than beside their callers because `buildBranch` needs all
 * three as well and a blind lead's terminus differs from a main passage's only
 * in how much it is allowed to ask for.
 */

/**
 * How far past the last real node the closing node sits, in metres, and the
 * shortest and longest dome `closeEnd` will build, in rings.
 *
 * CAP_LEN is not the dome. It only has to be long enough to be a safe spline
 * segment — a short final segment next to a fifteen-metre one gives Catmull-Rom a
 * tangent seven times the segment's own length and the ring swings metres
 * BACKWARD — and short enough that the whole ramp lands inside the region
 * `closeEnd` rewrites. The dome's real length is solved from the radius it has to
 * close; CAP_RINGS is its floor, about five metres, which is right for an
 * ordinary passage, and CAP_RINGS_MAX bounds a hall's at twenty-four.
 */
const CAP_LEN = 5;
const CAP_RINGS = Math.max(4, Math.round(CAP_LEN / RING_STEP));
const CAP_RINGS_MAX = Math.round(24 / RING_STEP);
/**
 * What the closing node's section is, as a fraction of the passage's.
 *
 * Not zero, and it cannot be: `resample` floors `w` and `t` at 0.12 and `f` at
 * 0.08 to keep the section solvable, so a node asking for nothing still emits a
 * ring 0.12 radii across — which on a twelve-metre hall is a metre and a half of
 * open hole at the end of the world. Getting from there to a point is `closeEnd`'s
 * job, and it runs after those clamps. 0.1 is small enough that the ramp into the
 * dome is already most of the way shut when the dome takes over.
 */
const CAP_SHUT = 0.1;
/**
 * The largest radius a closing node may keep, in metres.
 *
 * THIS IS WHAT GUARANTEES `truncate` RUNS AT ALL, and every terminus in the world
 * depends on it. `burySkylights` only calls `truncate` where some ring fails
 * `r * (t + f) < MIN_HEAD + 0.5`, and the channel floors in `resample` mean the
 * smallest section a ring can express is `r * 0.20` however hard the node shuts.
 * So a ring wider than (MIN_HEAD + 0.5) / 0.20 = 13.25 m never fails that test,
 * never gets cut, and never reaches `closeEnd` — which on the one thing in the
 * world that is bigger than that, a hall, means the biggest chamber in the cave
 * is the one with an open hole at the back of it.
 *
 * 11 leaves two metres of margin. IT IS NOT FREE, and the cost is worth naming:
 * a radius this far under a hall's puts `burySkylights`' backward slope limiter
 * to work, and it walks (r - 11) / 0.35 rings back into the chamber — twenty-three
 * on a nineteen-metre hall — shrinking the radius and leaving the axis alone,
 * which straightens the close into a cone AND ramps the floor up 4.7 m. That is
 * why `closeEnd`'s dome is sized to be longer than that reach for every radius
 * this world produces: the taper is not prevented, it is overwritten.
 */
const CAP_R_MAX = 11;
/**
 * Below this radius a ring is cap geometry and no rule that divides by the radius
 * may be applied to it. See the block over `capFrom` in `resample`.
 *
 * 0.4 m is a quarter of the narrowest half-width MIN_HALF guarantees, so nothing
 * a body could ever be inside is caught by it, and it is twenty times the 0.02 m
 * `closeEnd` writes at the pole — far enough above the floating-point end of the
 * profile that the guard fires on the shape rather than on rounding.
 */
const CAP_MIN_R = 0.4;

/**
 * The node that closes a passage, without collapsing its radius. See the block
 * at the end of `buildNodes` for why the radius must be left alone.
 *
 * THE AXIS DESCENDS BY EXACTLY WHAT THE FLOOR WOULD OTHERWISE RISE. Every ring's
 * floor sits `r * f` below its own axis, so shutting `f` lifts the floor toward
 * the centre line — over a twelve-metre hall that is a ten-metre ramp up into the
 * back wall, which is the one thing the brief for this space rules out. Dropping
 * the axis by `r * (f - fEnd)` leaves `y - r * f` where it was, to the millimetre,
 * so the floor you walk out on is the floor you walk to the end on.
 */
function closingNode(from, heading) {
  const fEnd = Math.min(from.f * CAP_SHUT, 0.08);
  const n = shaped(
    from.x + Math.cos(heading) * CAP_LEN,
    from.y - from.r * (from.f - fEnd),
    from.z + Math.sin(heading) * CAP_LEN,
    Math.min(from.r, CAP_R_MAX),
    { w: 1, t: 1, f: 1, key: from.key, rough: 1, scal: from.scal, seep: from.seep }
  );
  /**
   * SHUT TO THE FLOORS THEMSELVES, NOT MERELY TOWARD THEM, AND THAT IS A BUG THIS
   * CAUGHT RATHER THAN A REFINEMENT.
   *
   * A tenth of the section was the first version and it works on every passage in
   * the world except the one that matters. `truncate` — the only place a dome is
   * ever built — is reached only when some ring fails
   * `r * (t + f) < MIN_HEAD + 0.5`, and a hall's `t + f` is 3.0, so a tenth of it
   * is 0.30 and a capped 11 m radius gives 3.3. Above the threshold. The biggest
   * chamber in the cave was therefore the one place the dome was never built:
   * `cave-end` found grove-01's k=1 ending in an open three-metre hole with no
   * `endRing` published at all, on a 542 m passage, and reported it as a two-metre
   * step because the body was walking up the un-domed collapse.
   *
   * Taking the smaller of "a tenth of the passage" and the floors `resample` will
   * hold anyway makes `t + f` exactly 0.20 whatever section it is closing, so the
   * cut fires for every radius up to (MIN_HEAD + 0.5) / 0.20 = 13.25 m — which is
   * what CAP_R_MAX is under.
   */
  n.w = Math.min(from.w * CAP_SHUT, 0.12);
  n.t = Math.min(from.t * CAP_SHUT, 0.12);
  n.f = fEnd;
  n.rough = from.rough * CAP_SHUT;
  n.type = from.type;
  return n;
}

/**
 * Where a passage's terminal chamber goes, or null if there is nowhere for one.
 *
 * A SEARCH AND NOT A CHOICE, and that is the difference between this and every
 * previous attempt at scale in this file. The rock over the deep end of a passage
 * is not uniform: the walk has been steered by `roofRoom` for two hundred metres
 * and has arrived wherever the hillside let it, so the mountain thirty metres
 * ahead on one joint can be twice the mountain fifteen metres ahead on another.
 * Picking a radius and hoping is what produced the documented regression — two of
 * three caves on grove-01 reduced to fifteen-metre stubs, reported as "0 light
 * sources, 1 formation". Asking `chamberFit` at every candidate and keeping the
 * best is the same amount of code and cannot do that.
 *
 * THE DIVE IS PART OF THE SEARCH, not a consequence of it. Headroom is
 * `roofRoom - ROOF_ROCK - y`, so a metre of extra depth is a metre of extra
 * ceiling for free, and the deepest candidate is usually the biggest by a wide
 * margin. It is bounded by the same MAX_DIVE gradient the walk is — a chamber
 * you arrive at down a ramp is the point, a chamber at the bottom of a step you
 * cannot climb back out of is the bug that block describes.
 *
 * `want` is what the feeding passage is already doing. Anything under it is not
 * an arrival, it is the passage continuing, and the honest answer there is no
 * chamber at all: the dome alone still ends the passage properly.
 */
function* terminusFit(rng, x, y, z, heading, joints, nodes, bottom, want) {
  const bearings = [heading];
  for (const j of joints) {
    // Never the reciprocal: that is a chamber excavated in the passage you just
    // walked down. Same test, and for the same reason, as the walk's own.
    const d = ((j - heading + Math.PI) % TAU + TAU) % TAU - Math.PI;
    if (Math.abs(Math.abs(d) - Math.PI) < 0.6) continue;
    bearings.push(j + rngRange(rng, -0.1, 0.1));
  }
  let best = null;
  for (const h of bearings) {
    const tx = Math.cos(h);
    const tz = Math.sin(h);
    for (const step of [15, 21, 27]) {
      /**
       * THE FATTEST SINGLE THING IN THE WHOLE BUILD, AND IT LOOKS LIKE NOTHING.
       *
       * Forty-five candidates, each of them two `chamberFit` rosettes, two
       * `roofRoom` samples and — this is the term that got away — a pass over
       * EVERY node of the passage it is ending. For a branch that list is the
       * main line's rings rather than its nodes, which is nine hundred to
       * fourteen hundred entries: 45 x 1 400 x two distance tests. Measured at
       * 2.3 ms for the main walk and 3.2 for a branch, in one unbroken quantum,
       * which was the worst frame in the sliced build by a factor of three once
       * everything around it had been cut.
       *
       * Per bearing-and-step: fifteen stops of about 0.2 ms. Nothing inside the
       * loops draws from `rng` — the bearings did that above, before any of this
       * — so where it stops has no effect on what it finds.
       */
      yield 'terminus';
      const cx = x + tx * step;
      const cz = z + tz * step;
      for (const dive of [1, 0.55, 0.15]) {
        const cy = Math.max(bottom, y - step * MAX_DIVE * dive);
        /**
         * A hall if the rock will carry one, a room if it will not, and the
         * order matters: `hall` asks for far more than `room` and the fit is
         * solved against the shape's own proportions, so trying the ambitious
         * one first is how a big answer is ever found. HALL_MIN is what stops a
         * hall being built at a size its 2.15 `t` turns into a silo.
         */
        let kind = 'hall';
        let r = chamberFit(cx, cz, tx, tz, cy, SHAPES.hall, SHAPES.hall.hi);
        if (r < HALL_MIN) {
          kind = 'room';
          r = chamberFit(cx, cz, tx, tz, cy, SHAPES.room, SHAPES.room.hi);
        }
        if (r < want) continue;
        const sh = SHAPES[kind];
        /**
         * The approach has to be roofed too. The chamber's own rosette reaches
         * about a radius out, which on a fifteen-metre step does not see the
         * ground halfway there — and a passage that surfaces on its way to the
         * hall is a hole in the hillside, not a chamber problem.
         */
        let open = true;
        for (const at of [0.45, 0.75]) {
          const px = x + tx * step * at;
          const pz = z + tz * step * at;
          const py = y + (cy - y) * at;
          if (roofRoom(px, pz, tx, tz, 4.5) - ROOF_ROCK - py < 3.4) open = false;
        }
        if (!open) continue;
        /**
         * …AND IT MUST NOT BE EXCAVATED THROUGH THE PASSAGE THAT LEADS TO IT.
         *
         * This is the one failure a big terminal chamber can produce that a
         * `hall` in the middle of the walk cannot, and it is the reason the test
         * is more careful than the walk's own. A chamber is twenty-five to sixty
         * metres across; a passage that has taken two right-angle corners on its
         * joint set can easily be running back past its own deep end at fifteen
         * metres' remove, and a chamber excavated over it makes two tubes that
         * share a volume. From inside that is not a hole — you are standing in
         * open space with two sets of walls pushing you, and the documented
         * symptom is a body at full running velocity that does not move.
         * `cave-end` caught exactly that on check-12's k=0: the nearest ring
         * alternated between 930 and 377, and the walk stalled eleven metres
         * short of the terminus.
         *
         * TWO TESTS AND NOT ONE, because the chamber and the passage leading to
         * it need different clearances and a single margin is wrong for both.
         * Sized at the chamber's radius the approach rejects every candidate —
         * the node three back is legitimately twenty metres away and the margin
         * is forty. Sized at the passage's, the chamber is not covered at all.
         *
         * The chamber's own margin pays for the SPLINE's overshoot: `resample` is
         * Catmull-Rom on the radius as well as the position, so the fattest ring
         * between two nodes is fatter than either — measured at 26.6 m against a
         * 19 m node radius. The approach's is the same 4.5 m half-width the roof
         * check above uses, which is what the passage into a chamber actually is.
         *
         * Three nodes are exempt rather than two: the chamber sits up to
         * twenty-seven metres ahead of a walk whose last steps are seven to
         * nineteen, so the two or three behind it are what it is arriving FROM
         * and are supposed to be close.
         */
        let clash = false;
        const ax = cx - x;
        const ay = cy - y;
        const az = cz - z;
        const len2 = ax * ax + ay * ay + az * az || 1;
        for (let j = 0; j < nodes.length - 3 && !clash; j++) {
          const nd = nodes[j];
          const cd2 = (nd.x - cx) ** 2 + (nd.y - cy) ** 2 + (nd.z - cz) ** 2;
          const cmin = nd.r * nd.w + r * sh.w * 1.15 + 3.5;
          if (cd2 < cmin * cmin) clash = true;
          const u = clamp01(((nd.x - x) * ax + (nd.y - y) * ay + (nd.z - z) * az) / len2);
          const ad2 =
            (nd.x - (x + ax * u)) ** 2 + (nd.y - (y + ay * u)) ** 2 + (nd.z - (z + az * u)) ** 2;
          const amin = nd.r * nd.w + 4.5 + 3;
          if (ad2 < amin * amin) clash = true;
        }
        if (clash) continue;
        if (!best || r > best.r) best = { x: cx, y: cy, z: cz, r, kind, heading: h };
      }
    }
  }
  return best;
}

/**
 * Turn the last CAP_RINGS rings of a built path into a dome.
 *
 * A CONE IS WHAT YOU GET FROM A LINEAR TAPER, AND THAT IS ALL THIS EVER WAS. The
 * old close ran the radius to nothing over two ring steps — 1.44 m — and
 * `burySkylights`' backward slope limiter smeared that into a 26-degree cone
 * eighteen metres long. Either way the surface meets the axis at a fixed angle,
 * and a surface that meets the axis at a fixed angle is a cone whatever the
 * angle is. You can see the apex from thirty metres away and there is nothing
 * else to look at, which is exactly the report.
 *
 * `sqrt(1 - u^2)` is the profile of a sphere and it has the two properties a
 * cone does not: at u = 0 its slope is zero, so it leaves the passage tangentially
 * and there is no crease where the close begins; at u = 1 its slope is vertical,
 * so the surface meets the axis FACE ON and the last thing in front of you is a
 * wall you are looking at rather than a point you are aimed into.
 *
 * WHY IT IS HERE AND NOT IN THE NODE WALK. Everything a node asks for goes
 * through `resample`'s channel floors, `flatten`, and then `burySkylights`, which
 * slope-limits the radius in both directions at 0.35 m a ring. A quarter ellipse
 * closes far faster than that near its end, so a dome expressed as nodes comes
 * out of the burial as — precisely — a 26-degree cone. This runs after all of it,
 * from `truncate`, which is the one place every passage in the world is
 * guaranteed to pass through.
 *
 * IT IS AS LONG AS THE THING IT IS CLOSING, WHICH IS NOT A STYLE CHOICE.
 *
 * A fixed five metres was the first version and it is right for a four-metre
 * passage and absurd for a hall: closing a nineteen-metre radius over five metres
 * puts the whole of the collapse in the last ring step, which is a flat disc with
 * a rim, and it leaves the SECOND defect below untouched. The length is solved
 * from the radius at the base, iterated because the base depends on the length —
 * three passes, converging upward, no allocation.
 *
 * AND IT HAS TO SWALLOW THE BURIAL'S OWN TAPER, WHICH IS THE REAL CONE.
 *
 * `burySkylights` slope-limits the radius backwards at 0.35 m a ring. The closing
 * node's radius is capped at CAP_R_MAX so the cut fires at all (see there), so on
 * a nineteen-metre hall the limiter walks (19 - 11) / 0.35 = 23 rings — sixteen
 * metres — back into the chamber, shrinking `r` and leaving `y` alone. That is
 * two faults at once: the straight-sided cone the player described, and a FLOOR
 * THAT CLIMBS, because the floor sits `r * f` below the axis and `r` is falling
 * while the axis is not. Measured on grove-01's k=1 it was a 4.7 m rise over the
 * back of the chamber with a 2.2 m step in it, which `cave-end` caught as a body
 * jumping two metres in one frame.
 *
 * `1.15 * r / RING_STEP` rings is longer than `(r - CAP_R_MAX) / 0.35` for every
 * radius the world can produce, so the dome always starts on untapered rock, and
 * rewriting `y` from the base ring's floor puts the floor back dead level across
 * the whole of it.
 *
 * THE DOME CANNOT BREACH THE HILL, and that is not an assumption. Every ring it
 * writes takes its shape from the base ring and its radius from a factor at most
 * 1, and its axis is set from the base ring's own FLOOR — so its ceiling is
 * `floor + r_i * (t + rough)` with `r_i <= r_base`, which is at or below the base
 * ring's ceiling everywhere, and the base ring has already been through the
 * burial. `roofRoom`'s rosette scales with the ring's half-width, so at a
 * chamber-sized base it has already sampled the ground the dome runs over.
 */
function closeEnd(path) {
  const n = path.x.length;
  let m = CAP_RINGS;
  for (let it = 0; it < 3; it++) {
    const b = Math.max(1, n - 1 - m);
    m = clamp(Math.round((path.r[b] * 1.15) / RING_STEP), CAP_RINGS, CAP_RINGS_MAX);
  }
  const base = Math.max(1, n - 1 - m);
  const span = n - 1 - base;
  const floor = path.y[base] - path.r[base] * path.f[base];
  const r0 = path.r[base];
  for (let k = 1; k <= span; k++) {
    const i = base + k;
    const s = Math.sqrt(Math.max(0, 1 - (k / span) * (k / span)));
    path.r[i] = Math.max(0.02, r0 * s);
    path.w[i] = path.w[base];
    path.t[i] = path.t[base];
    path.f[i] = path.f[base];
    path.key[i] = path.key[base];
    // Displacement scales with the section, or a twelve-metre hall's half-metre
    // of relief lands on a ring 20 cm across and the dome turns inside out.
    path.rough[i] = path.rough[base] * s;
    path.scal[i] = path.scal[base];
    path.seep[i] = path.seep[base];
    path.y[i] = floor + path.r[i] * path.f[i];
  }
  /**
   * WHERE THE BODY IS STILL ALLOWED TO BE, published for `caveSample`.
   *
   * The rings past this one are cap: their section is smaller than a person, so
   * `horiz / (r * w)` explodes for a body a hand's breadth off the axis and the
   * fit test hands the whole passage back as "outside". That is the teleport —
   * nothing claims the point, `caveFloorUnder` falls through to `groundUnder`,
   * and the floor clamp puts the player on the hillside forty metres overhead.
   * Containment near a terminus has to answer from the last ring that is a
   * PLACE, and this is the index of it.
   *
   * ONE RING BACK FROM THAT, because a body has a radius and a ring is a plane.
   * The last ring with MIN_HEAD in it still has the dome closing 0.72 m in front
   * of it, so stopping the body exactly on its plane stops it with its face in
   * the rock. A ring step of margin is the same 0.34 m the wall push already
   * keeps, rounded to the resolution this file measures anything in.
   */
  let end = n - 1;
  while (end > 1 && path.r[end] * (path.t[end] + path.f[end]) < MIN_HEAD) end--;
  path.endRing = Math.max(1, end - 1);
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
 *
 * `hall` REPEATS ITSELF HARDER THAN ANYTHING ELSE IN THIS TABLE, and that is
 * the difference between a chamber and a bulge.
 *
 * One hall node is a lens: the spline ramps the section up over the eight metres
 * before it and back down over the eight after, so the space is twenty-five
 * metres end to end and you are through it in six seconds having never stopped
 * walking. What makes a chamber is that its far wall is far enough away that
 * getting there is a decision. 0.55 back to itself gives a mean run of a bit
 * over two nodes — forty to sixty metres of hall — and every one of those nodes
 * is independently sized against the rock it is under, so a run that walks out
 * from under the mountain shrinks and then hands over to a room rather than
 * pinching. See `chamberFit`.
 */
const TYPE_CHAIN = {
  tube: [['tube', 0.32], ['keyhole', 0.20], ['canyon', 0.17], ['bedding', 0.15], ['room', 0.12], ['hall', 0.04]],
  canyon: [['canyon', 0.34], ['keyhole', 0.21], ['tube', 0.17], ['room', 0.12], ['bedding', 0.10], ['hall', 0.06]],
  keyhole: [['keyhole', 0.28], ['canyon', 0.25], ['tube', 0.22], ['room', 0.11], ['bedding', 0.09], ['hall', 0.05]],
  bedding: [['bedding', 0.31], ['tube', 0.25], ['room', 0.16], ['canyon', 0.12], ['keyhole', 0.09], ['hall', 0.07]],
  room: [['tube', 0.26], ['canyon', 0.21], ['bedding', 0.19], ['keyhole', 0.16], ['hall', 0.13], ['room', 0.05]],
  hall: [['hall', 0.55], ['room', 0.18], ['tube', 0.11], ['bedding', 0.08], ['canyon', 0.05], ['keyhole', 0.03]],
};

/**
 * `deep` IS THE GATE ON SCALE, AND IT IS A GATE AND NOT A NUDGE.
 *
 * The chain above is allowed to name a hall anywhere; this is what decides
 * whether it may have one. Under a third of DEEP_FULL the multiplier is zero,
 * so the first stretch of every cave in the world is the cave it always was —
 * which matters, because a chamber in the first forty metres would be the
 * biggest thing in the cave and the player would meet it before they had any
 * sense of what a passage is. There would then be nothing left to find.
 *
 * Past that it ramps to full and `room` climbs with it. The player's experience
 * of that is the only thing here that is not arithmetic: going down is the only
 * thing that makes the world larger, they will not be told so, and the
 * measurement of whether it worked is whether they keep going.
 *
 * The `vast` fallback in `buildNodes` is the safety net under all of it — this
 * gate says a hall is ALLOWED here, `chamberFit` says whether the rock agrees,
 * and the two disagreeing costs a room rather than a truncated passage.
 */
function pickType(rng, from, turned, deep = 0) {
  const table = TYPE_CHAIN[from] ?? TYPE_CHAIN.tube;
  const scale = (name) => {
    // `smoothstep` here is the bare cubic and does NOT clamp or take edges; the
    // clamp01 is the whole of the gate and removing it would let the multiplier
    // go negative above the top edge, which silently deletes halls again.
    if (name === 'hall') return smoothstep(clamp01((deep - 0.32) / 0.48)) * (turned ? 1.9 : 1);
    if (name === 'room') return (turned ? 2.6 : 1) * (1 + deep * 0.9);
    return 1;
  };
  let total = 0;
  for (const [name, wgt] of table) total += wgt * scale(name);
  let u = rng() * total;
  for (const [name, wgt] of table) {
    u -= wgt * scale(name);
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

/**
 * How far past the mouth a branch may start. See `blind`, below.
 *
 * IN METRES, DIVIDED BY THE RING STEP, AND IT WAS A BARE 22. This is a distance
 * — "far enough in that a lead cannot see daylight" is a fact about sight lines
 * and fog, not about how finely the sweep is sampled — and written as a ring
 * count it quietly shrank from 25 m to 16 m the last time the mesh was
 * sharpened, along with three other things that were also secretly distances.
 * The file now writes every one of them this way; see HOOD_MIN.
 */
const BRANCH_MIN_RING = Math.round(26 / RING_STEP);

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

/**
 * THE BIGGEST CHAMBER THIS PIECE OF MOUNTAIN WILL ACTUALLY CARRY.
 *
 * The wish-and-hope version of this function is the one regression this file
 * keeps having. Pick a radius, place the node, and `burySkylights` — which is
 * the only thing that ever measures the SHOULDERS — discovers eleven metres too
 * late that there was never enough hill, pinches the ring to whatever fits,
 * taper-limits the pinch into its neighbours, and where the pinch closes below
 * head height TRUNCATES. A single over-optimistic chamber two thirds of the way
 * along therefore does not come out as a smaller chamber. It comes out as the
 * passage ENDING there, and on grove-01 that has twice meant three-hundred-metre
 * caves reported as fifteen-metre holes.
 *
 * So ask first. The burial's own test is
 *
 *     y + r * (t + rough)  <=  roofRoom(footprint) - ROOF_ROCK
 *
 * and this is that inequality solved for `r` instead of checked after the fact.
 * Two things make it more than one line:
 *
 *   THE FOOTPRINT DEPENDS ON THE ANSWER. `roofRoom` samples a rosette scaled by
 *   the ring's half-width, so a smaller chamber is measured over less ground and
 *   is allowed to be relatively taller — the constraint is not linear in `r`.
 *   Iterating converges in two or three passes and every exit is CONSERVATIVE:
 *   either `fit >= r`, in which case `r` was verified at its own footprint, or
 *   the loop runs out and returns a radius that was solved for a footprint
 *   larger than the one it will actually have.
 *
 *   AND THE NUMBER MEASURED LATER IS NOT THE NUMBER ASKED FOR HERE. `shaped`
 *   jitters `t` by up to 1.1 and `rough` by up to 1.2, and `resample`'s
 *   Catmull-Rom then overshoots both between control points. Sizing against the
 *   nominal section and letting the burial meet the jittered one is how you get
 *   a chamber that is fine at its nodes and pinched in the middle. The margins
 *   are the jitter's own worst case, so nothing downstream can exceed them.
 */
/**
 * Fill a built path's `deep` channel. See CHANNELS.
 *
 * AFTER THE BURIAL AND NOT BEFORE IT, which is why this is a pass over the
 * rings rather than a field on the node. `burySkylights` moves rings down by up
 * to the depth of whatever ravine they were running under, so the depth a node
 * asked for and the depth its rings ended up at are different numbers — and the
 * one everything downstream cares about is where the player will actually be
 * standing. Doing it here also means the two collapsing rings at every terminus
 * carry the depth of the passage they close instead of the zero `shaped`
 * defaults them to, which would otherwise spline the channel back to "at the
 * surface" over the last few metres of the deepest part of the cave.
 *
 * `mouthY` is the MAIN passage's ring zero for every path including branches: a
 * branch's own ring zero is already a hundred metres underground, and measuring
 * a branch's depth from it would say a lead off the deepest chamber in the
 * system is as shallow as one off the entrance series.
 */
function markDepth(path, mouthY) {
  for (let i = 0; i < path.x.length; i++) path.deep[i] = clamp01((mouthY - path.y[i]) / DEEP_FULL);
}

function chamberFit(x, z, tx, tz, y, sh, want) {
  const tall = sh.t * 1.1 + sh.rough * 1.2;
  let r = want;
  for (let it = 0; it < 4; it++) {
    const surf = roofRoom(x, z, tx, tz, r * sh.w * 1.12);
    const fit = Math.max(0, (surf - ROOF_ROCK - y) / tall);
    if (fit >= r) break;
    r = Math.min(want, fit);
  }
  return r;
}

function* burySkylights(path, from) {
  const n = path.x.length;
  const want = Float64Array.from(path.y);
  /** The headroom line — `roofRoom` minus ROOF_ROCK — kept for the cut below. */
  const room = new Float64Array(n).fill(Infinity);
  /**
   * THE ONE SLICE POINT IN THIS FUNCTION, AND IT IS IN THE RIGHT LOOP.
   *
   * `burySkylights` is five passes over the ring array and it is 42% of a whole
   * `prepare` — but only this first pass is expensive, because only this one
   * calls `roofRoom`, which is nine `heightAt` samples over the passage's
   * shoulders. Measured at 0.010-0.012 ms a ring against 0.0002 for each of the
   * four slope-limiter passes that follow, so those are left whole: a nine
   * hundred ring passage runs all four of them in a fifth of a millisecond, and
   * cutting a running minimum into slices would mean carrying its accumulator
   * across frames for no gain that could be measured.
   *
   * 48 rings is half a millisecond of `roofRoom`, which is the granularity the
   * whole build is cut to. It is a work quantum and NOT a distance — see the
   * note on GOOD_RINGS for what happens in this file when those two are
   * confused — so it does not move when RING_STEP does.
   */
  const BURY_SLICE = 48;
  for (let i = Math.max(0, from); i < n; i++) {
    if (i % BURY_SLICE === 0) yield 'bury';
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

  /**
   * …AND THEN LEVEL THE FLOOR AGAIN, BECAUSE THIS PASS HAS JUST INVALIDATED IT.
   *
   * `flatten` runs inside `resample` and solves each ring's `f` so that
   * `y - r * f` lands on the smoothed floor line. The two lines above then
   * rewrite `y` AND `r` on every ring the burial touched — the drop is metres in
   * a ravine and the radius shrink is taper-limited at 0.35 m a ring, which over
   * a chamber is several metres of radius across its length — and `f` is left
   * solved against numbers that no longer exist. The floor it describes is
   * therefore not level any more, and it is not level in the worst possible way:
   * `floor = y - r * f` now moves by 0.35 * f a ring, so consecutive rings in the
   * same chamber disagree about where the ground is by a fifth of a metre each,
   * accumulating.
   *
   * That is not a cosmetic wobble. `caveSample` answers the floor from ONE ring —
   * the best-fitting one — and in a chamber a dozen sections reach any given
   * point, so the ring it picks and the ring whose geometry is actually drawn
   * lowest there are routinely different. Every centimetre those two disagree by
   * is a centimetre of the body standing above or inside the visible rock.
   * Measured by `cave-floor` on grove-01 before this call existed: 111 probes
   * disagreeing by more than 0.45 m and a worst hover of 2.29 m, which is over
   * head height — you walk out into the biggest chamber in the cave and rise off
   * its floor. It is the same fault the block on `flatten` describes, arrived at
   * from the other end: there, `f` was never solved; here, it was solved and then
   * silently unsolved.
   *
   * It is safe to re-level after the burial and NOT the other way round, because
   * `flatten` only ever writes `f`. The roof is `y + r * (t + rough)` and the
   * containment is `r * w`; neither reads `f`, so nothing this pass just
   * guaranteed about staying under the hillside can be undone by it. `first`
   * keeps it off the mouth and off a branch's welded ring zero.
   */
  flatten(path, first);
}

/**
 * End a path at `cut`, and dome it. THE ONE PLACE A PASSAGE IS EVER CLOSED.
 *
 * `cut` is the first ring a body no longer fits through, and it arrives here
 * from two completely different situations that used to be handled the same way
 * and must not be:
 *
 *   THE PASSAGE HAS ARRIVED. `buildNodes` and `buildBranch` both end with a
 *   `closingNode`, whose shut section makes the last few rings fail the fit test
 *   by construction — so `cut` is within CAP_RINGS of the end and there is
 *   nothing to throw away. Everything the walk built, including the terminal
 *   chamber, is kept and the last few rings become its dome.
 *
 *   THE HILL HAS RUN OUT. `burySkylights` has narrowed the passage to nothing
 *   halfway along because there is no longer mountain over it, and `cut` is a
 *   hundred rings from the end. The rest is discarded — those rings were never
 *   buried and would stand in open air — and the dome is built in the CAP_RINGS
 *   immediately after the last ring that was. That is a squeeze closing down,
 *   which is how a real passage ends where it approaches the surface, and it is
 *   also the case the player was actually complaining about: it is far more
 *   common than the natural end.
 *
 * WHAT WAS HERE BEFORE was `path.r[keep-1] = 0.05` and `path.r[keep-2] =
 * path.r[keep-3] * 0.55` — a full-size ring collapsed to a point over two ring
 * steps, 1.44 m. That is the cone, undiluted: no dome, no floor at the end of it,
 * and (because the last claimable section was 3 cm across) no containment either,
 * so walking into it dropped `inCave` to zero and the floor clamp put the player
 * on the hillside. One line of geometry produced both halves of the report.
 */
function truncate(path, cut) {
  const n = path.x.length;
  // Never shorter than a dome plus a few rings to hang it off; `prepare` re-walks
  // anything this short anyway, and a negative base index is a silent overrun.
  const keep = Math.min(n, Math.max(cut + CAP_RINGS, Math.min(n, CAP_RINGS + 6)));
  if (keep < n) {
    // Subarrays, not `length =`: `resample` hands back Float64Arrays and a typed
    // array's length is a getter. Assigning to it throws, silently, inside a build
    // slice — which shows up as three caves in a row reporting `built=false`.
    path.x = path.x.subarray(0, keep);
    path.y = path.y.subarray(0, keep);
    path.z = path.z.subarray(0, keep);
    for (const ch of CHANNELS) path[ch] = path[ch].subarray(0, keep);
  }
  closeEnd(path);
}

/**
 * A SIDE PASSAGE, AND `major` IS THE DIFFERENCE BETWEEN A DENT AND A DECISION.
 *
 * Every branch used to be 3-6 nodes of canyon or bedding that pinched out in
 * twenty-five metres. That is a real thing — most leads in a real cave are
 * exactly that, and they are what makes the ones that go feel like they go —
 * but a system made entirely of them never asks the player anything. You put
 * your light down the hole, you see it close, and you carry on. The passage was
 * never a choice; it was a decoration on a corridor.
 *
 * A major branch is built to be indistinguishable from the main line at the
 * junction: the same starting sections, the full type chain from node one, ten
 * to sixteen nodes, its own descent, and the same shoulder veto the main walk
 * uses so it does not immediately bury itself out of existence. Standing at
 * that junction there is no cue as to which way is the way on, because there is
 * no way on — there are two ways on, and the cave stops being a route.
 *
 * It is deliberately not a loop back to anywhere. The collision model is a set
 * of independent swept tubes; two of them rejoining is not a bigger version of
 * this problem, it is a different one.
 */
function* buildBranch(c, main, joints, bi, tag, major = false) {
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

  /**
   * A blind lead announces itself in its section and a way on does not.
   *
   * A canyon or a bedding plane leaving the wall is legible as a side passage
   * from the moment you see it — it is a different KIND of hole. A major branch
   * starts on the same two sections the main walk starts on, so at the junction
   * the two openings are the same object and the choice is a real one.
   */
  const type0 = major
    ? rng() < 0.5
      ? 'tube'
      : 'keyhole'
    : rng() < 0.42
      ? 'canyon'
      : rng() < 0.6
        ? 'bedding'
        : 'tube';
  const sh0 = SHAPES[type0];
  /**
   * Never bigger than the passage it leaves. A branch wider than its parent
   * pokes its own ceiling through the main tube's, and the two surfaces argue
   * about which is in front for the six metres either side of the junction.
   */
  const rb = Math.min(r0 * 0.85, rngRange(rng, sh0.lo, sh0.hi));
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
    sh0
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

  const count = major ? 10 + Math.floor(rng() * 7) : 3 + Math.floor(rng() * 4);
  let type = type0;
  for (let i = 0; i < count; i++) {
    // Per node, as the main walk is. A branch node is dearer than a main one —
    // the clash test below is a pass over every ring of the passage it leaves.
    yield 'branch';
    /**
     * A MINOR BRANCH TAKES WHAT IT IS GIVEN AND A MAJOR ONE RETRIES.
     *
     * A blind lead that dies on its fourth node because the hillside fell away
     * is a blind lead, which is what it was going to be anyway. A major branch
     * that dies on its fourth node is a junction that promised a passage and
     * delivered a dent — the worst outcome available here, because the player
     * has already spent the walk to it. Five attempts, exactly as the main walk
     * gets, and for the same reason.
     */
    const tries = major ? 5 : 1;
    let placed = false;
    for (let attempt = 0; attempt < tries && !placed; attempt++) {
      // Node one keeps the wall normal so the mouth is a hole; after that the
      // branch joins the joint set like everything else.
      let h = heading;
      if (i > 0) {
        let bestD = Infinity;
        let bestH = heading;
        const near = [];
        for (const j of joints) {
          const d = Math.abs(((j - heading + Math.PI) % TAU + TAU) % TAU - Math.PI);
          if (d < 1.9) near.push(j);
          if (d < bestD && d < 1.5) {
            bestD = d;
            bestH = j;
          }
        }
        // The first attempt holds the nearest joint, which is what keeps a
        // branch running straight the way the main line does. A retry is
        // allowed any joint that is not a reversal, because the whole point of
        // retrying is that the straight-on answer has just been refused.
        h = (attempt === 0 || !near.length ? bestH : near[Math.floor(rng() * near.length)]) +
          rngRange(rng, -0.2, 0.2);
      }
      /**
       * Sections from node one, for a major branch only, and never a `hall`.
       *
       * `deep` is passed as zero, which zeroes the hall weight in `pickType`.
       * A chamber inside a side passage is the wrong place for the biggest
       * space in the cave — it belongs on the line the player is already
       * committed to — and a branch has no `bottom`, no depth envelope and only
       * a centre-line roof clamp, so it is also the place least able to carry
       * one. Rooms still occur, and are sized from the rock below like any other
       * `vast` section.
       */
      const kind = major && i > 0 ? pickType(rng, type, false, 0) : type0;
      const sh = SHAPES[kind];
      const step = i === 0 ? rngRange(rng, 6, 9) : rngRange(rng, 9, 16);
      // A major branch leans downhill like the main walk does, so taking the
      // fork is also going deeper rather than sideways.
      const pn = clamp(pitch + rngRange(rng, -0.16, 0.12) + (major ? -0.05 : 0), -0.4, 0.12);
      const nx = x + Math.cos(h) * step * Math.cos(pn);
      const nz = z + Math.sin(h) * step * Math.cos(pn);
      let r = rngRange(rng, sh.lo, sh.hi) * (i > count - 2 ? 0.8 : 1);
      let ny = y + Math.sin(pn) * step;
      const ul = Math.hypot(nx - x, nz - z) || 1;
      const ux = (nx - x) / ul;
      const uz = (nz - z) / ul;
      // Same rule as the main walk: a big section is sized from the rock, never
      // from the wish. Without this a room in a branch is drawn at 9 m, pinched
      // by the burial to under head height, and takes the rest of the branch
      // with it — a truncation, which in a branch nothing re-walks.
      if (sh.vast) r = Math.max(SHAPES.tube.lo, chamberFit(nx, nz, ux, uz, ny, sh, r));
      ny = Math.min(ny, heightAt(nx, nz) - r * sh.t - ROOF_ROCK);

      /**
       * …and do not run along the lip of a ravine, which the centre-line clamp
       * above cannot see. Retries only, so a branch with nowhere good to go
       * still goes somewhere rather than stopping at the junction.
       */
      if (attempt < tries - 1) {
        const shoulder = roofRoom(nx, nz, ux, uz, r * sh.w);
        if (shoulder < ny + r * (sh.t + sh.rough) + ROOF_ROCK * 0.7) continue;
      }

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
      if (clash) continue;

      const nd = shaped(nx, ny, nz, r, sh, rng);
      nd.type = kind;
      nodes.push(nd);
      heading = h;
      pitch = pn;
      type = kind;
      x = nx;
      y = ny;
      z = nz;
      placed = true;
    }
    // Every attempt refused: this is where the lead ends, and a lead that ends
    // is the normal case rather than a failure.
    if (!placed) break;
  }

  // Too short to be a lead — it would read as a dent, not a way on.
  if (nodes.length < 3) return null;

  /**
   * A BLIND LEAD SHOULD STILL BE SOMEWHERE.
   *
   * What was here was two collapsing nodes and an argument for them: real leads
   * pinch out, you turn round because you cannot fit rather than because there is
   * a wall, and a smooth cap reads as built. All of that is true of a squeeze and
   * none of it survives being the answer EVERY time. A system whose every side
   * passage dies in an identical taper teaches the player within two branches
   * that leads are not worth walking, and the leads are the only reason the cave
   * is a system rather than a corridor.
   *
   * So a branch gets the same terminus the main line does, asked smaller. The
   * search is what makes that safe rather than greedy: `terminusFit` returns
   * whatever the rock over this particular dead end will carry, which past the
   * end of a lead is usually nothing — the branch has no depth envelope and only
   * a centre-line roof clamp, so it is far more often out of mountain than the
   * main walk is. When it comes back empty the lead just closes, which is the old
   * behaviour and the right one. When it does not, the lead opens into a small
   * chamber, and a system with a few of those in it is a system worth exploring.
   *
   * `main` is passed as the clash list rather than the branch's own nodes: a
   * terminal chamber excavated into the passage it left is the one collision
   * here that matters, and the branch's own line is behind it by construction.
   */
  const last = nodes[nodes.length - 1];
  const mainNodes = [];
  for (let i = 0; i < n; i++) {
    mainNodes.push({ x: main.x[i], y: main.y[i], z: main.z[i], r: main.r[i], w: main.w[i] });
  }
  // No depth floor: a branch has never had one, and the dive is bounded anyway
  // by the same MAX_DIVE gradient over the step that the main walk uses.
  yield 'branch';
  const term = yield* terminusFit(rng, x, y, z, heading, joints, mainNodes, -Infinity, last.r * 1.25);
  yield 'branch-terminus';
  if (term) {
    const sh = SHAPES[term.kind];
    const nd = shaped(term.x, term.y, term.z, term.r, sh);
    nd.type = term.kind;
    nodes.push(nd);
    heading = term.heading;
  }
  nodes.push(closingNode(nodes[nodes.length - 1], heading));

  const path = resample(nodes);
  yield 'branch-resample';
  // From ring 1: ring 0 is welded to the main tube's wall and must not move.
  yield* burySkylights(path, 1);
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
    path.deep[i] = clamp01(path.deep[i]);
  }

  flatten(path);

  /**
   * WHERE THE TERMINUS STARTS, which is what the inflation below must not touch.
   *
   * THE OLD TEST WAS `i < n - 3` AND IT WAS WRONG IN BOTH DIRECTIONS AT ONCE.
   *
   * Too generous, first. The close is not three rings long — it never was. Under
   * `burySkylights`' backward slope limiter it is (r - 0.05) / 0.35 rings, which
   * on an ordinary four-metre passage is eleven and on a chamber is twenty-six.
   * Every one of those except the last three was being held at full MIN_HEAD and
   * MIN_HALF while its radius collapsed underneath it, so the drawn section stayed
   * 2.15 m tall and 1.56 m wide right up to ring n-4 and then fell off a cliff.
   * That is why the old terminus read as a hard cone rather than as a taper: the
   * shape you saw was not the radius closing, it was the inflation holding the
   * section open and then stopping.
   *
   * Too mean, second, and this is the half the player feels. The three exempt
   * rings were the only ones the body could not stand up in, so the walkable
   * floor stopped three rings — 2.16 m — short of the geometry, in the dark,
   * with no wall there to explain it.
   *
   * WHAT THE GUARD IS ACTUALLY PROTECTING, and it is not the index: `t` is
   * inflated by `(MIN_HEAD - head) / r`, which divides by a radius that is on its
   * way to 0.02. On a cap ring that asks for a `t` in the hundreds — a section
   * scale so large that `flatten`, `halfWidthAt` and the `_bpad` bound all read a
   * ring twenty metres tall where the sweep is supposed to be a point. So the
   * cause is a vanishing radius, and the test is now that cause and nothing else:
   * the TRAILING run of rings that a body does not fit through is the terminus by
   * definition, and CAP_MIN_R stops the arithmetic itself blowing up. A ring in
   * the MIDDLE that fails MIN_HEAD is still inflated, which is the whole point of
   * the inflation and is exactly what an index-based guard could never express.
   */
  let capFrom = n;
  while (capFrom > 1 && path.r[capFrom - 1] * (path.t[capFrom - 1] + path.f[capFrom - 1]) < MIN_HEAD) {
    capFrom--;
  }
  for (let i = 0; i < n; i++) {
    /**
     * …and then the passage is made big enough to walk through. See MIN_HEAD.
     *
     * Applied to `t` and `w` rather than to `r` because the radius is what makes
     * a squeeze a squeeze — inflating it to buy headroom would take the one
     * shape the player is supposed to feel and turn it into an ordinary tube.
     */
    if (i >= capFrom || path.r[i] < CAP_MIN_R) continue;
    const head = path.r[i] * (path.f[i] + path.t[i]);
    if (head < MIN_HEAD) path.t[i] += (MIN_HEAD - head) / path.r[i];
    // The slot, if there is one, is the narrowest part and is what has to fit.
    const halfLow = path.r[i] * halfWidthAt(-path.f[i] * 0.35, ringShape(path, i, _shapeA));
    if (halfLow < MIN_HALF) path.w[i] *= MIN_HALF / Math.max(halfLow, 1e-3);
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
function flatten(path, from = 0) {
  const n = path.x.length;
  const floor = new Float64Array(n);
  for (let i = 0; i < n; i++) floor[i] = path.y[i] - path.r[i] * path.f[i];
  const level = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    /**
     * THE WINDOW IS A DISTANCE AND WAS BEING WRITTEN AS A RING COUNT — BOTH
     * HALVES OF IT.
     *
     * `Math.min(16, r * w * 0.9)` compared a ring count against a half-width in
     * METRES and then used the result as a ring count, so the window a chamber
     * actually got was 0.9 x its half-width x RING_STEP — 0.65 of its half-width
     * in metres, not 0.9 — and the cap was 11.5 m rather than the 16 it reads
     * as. Both were tuned by eye at a ring step that has since changed twice,
     * which is exactly how the four other constants in this file that were
     * secretly distances came to be wrong.
     *
     * As metres it says what it means: level the floor over most of the space's
     * own half-width, out to 22 m, which is over the widest the rock has ever
     * granted. A chamber levelled over less than its own width comes out as a
     * shallow dish with the axis's meander still in it — the "rolling bottom no
     * collapse ever made" this function exists to delete, at the one scale where
     * it is unmissable.
     */
    const win = Math.round(Math.min(22, path.r[i] * path.w[i] * 0.9) / RING_STEP);
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
  /**
   * `from` protects rings that have already been SOLVED against something else.
   *
   * The averaging above still reads them — they are real floor heights and a
   * chamber that begins six rings in should level toward them, not step at
   * them — but nothing writes to them. Two callers need that: a branch's ring
   * zero carries an `f` solved so its floor IS the main tube's floor at the
   * junction, and a re-level after the burial must not touch the mouth, whose
   * floor is the gully's carved floor and is the one seam in this file that is
   * not allowed to move by a centimetre.
   */
  for (let i = from; i < n; i++) {
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
/** `section`'s output, for the build-time placers. Never used per frame. */
const _sectTmp = { x: 0, y: 0 };


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
 * WHERE THE ROCK IS ACTUALLY DRAWN, WHICH IS NOT WHERE IT WAS PLANNED.
 *
 * `_emitRing` builds a ring on the analytic section and then pushes every
 * vertex radially by `rn * amp + sc - seepF * r * 0.075`. Nothing standing on
 * that surface knew about it: crystals were seated at `r * 0.96`, spires at
 * `r * 0.9`, every floor object at `y - r * f`. On a four-metre passage the
 * push reaches +/-0.9 m, so a crystal was as likely to be hanging a foot clear
 * of the wall — presenting the open base ring `_emitCrystal` never capped, on a
 * FrontSide material, i.e. a hole you look through the crystal with — as it was
 * to be buried in the rock. That is the "I can see through some of them" report
 * and it is a PLACEMENT bug, not a shading one.
 *
 * `rock` is deterministic and costs four fbm lookups, so the fix is to ask it
 * at placement time. This returns the metres `_emitRing` will push one point of
 * one ring, positive outward.
 *
 * THE SAMPLE POINT IS AN ARGUMENT, WHICH IS THE WHOLE REASON THIS IS NOT JUST A
 * TABLE LOOKUP. A ring vertex samples the field at its own analytic position;
 * an object standing on the floor two metres off the axis wants the field where
 * IT is, not where the nearest ring vertex is. Same function, same amplitude
 * rule, different point.
 *
 * A MIRROR AND NOT A SHARED CALL, and that is a deliberate, uncomfortable
 * choice. `_emitRing` computes this inside a 44-iteration loop that also owns
 * the frame, the hood taper, the water trough and the vertex write; lifting six
 * lines out of the one function the whole passage IS, in order to fix the
 * objects standing next to it, is a bad trade. The rule is that this function
 * and the `disp` line in `_emitRing` are one decision written twice: change
 * either and change both.
 *
 * TWO TERMS ARE DELIBERATELY NOT MIRRORED, both because both exist only within
 * a couple of rings of a seam:
 *   - `mouthDamp`, which fades the push in over a branch's first three rings.
 *     No placer emits before ring 3, so at worst one ring of one branch seats
 *     against 100% of a push that is drawn at 65% of it — 0.3 m on a wide
 *     branch, against the 0.9 m this function removes everywhere else.
 *   - the junction flatten, which takes the push to zero around a hole. A prop
 *     inside one is placed up to `amp` off the drawn wall, which is exactly
 *     what every prop in the cave suffered before this function existed.
 */
function wallPush(k, path, i, phi, sh, sec, sx, sy, sz) {
  const r = path.r[i];
  const floorish = clamp01(-sec.y / Math.max(Math.min(sh.f, sh.t), 1e-3));
  const rough = Math.max(ROUGH_FLOOR, path.rough[i]);
  const amp = r * (ROUGH_FLOOR + (rough - ROUGH_FLOOR) * (1 - floorish));
  const along = path.along ? path.along[i] : i * RING_STEP;
  const scal = path.scal[i];
  const seep = path.seep[i];
  const sc = scal > 0.02 ? scallop(along, phi, k) * scal * r * 0.055 * (1 - floorish) : 0;
  let seepF = 0;
  if (seep > 0.02) {
    const s = fbm2(along * 0.33 + phi * 1.9, phi * 2.6 - along * 0.11, 2) * 2.2 + 0.2;
    seepF = clamp01((clamp01(s) - 0.55) * 2.6) * seep * clamp01(0.3 + sec.y / Math.max(sh.t, 0.2));
  }
  return rock(sx, sy, sz) * amp + sc - seepF * r * 0.075;
}
const _secC = { x: 0, y: 0 };

/** The vertical component of that push, which is what a thing standing on the
 *  floor or hanging from the roof actually needs. `_emitRing` moves the outline
 *  point along its own ray, so the y term is `sec.y / |sec|` of it. */
function surfaceLift(k, path, i, sh, sec, x, z) {
  const r = path.r[i];
  const ol = Math.hypot(sec.x, sec.y) || 1;
  const d = wallPush(k, path, i, Math.atan2(sec.y, sec.x), sh, sec, x, path.y[i] + r * sec.y, z);
  return (sec.y / ol) * d;
}

/**
 * THE DRAWN FLOOR AND THE DRAWN CEILING AT A POINT OFF THE AXIS, which is two
 * corrections at once and both of them were being skipped.
 *
 * `placeSpires` used `path.y[i] -/+ r * f` and `r * t` — the section's very
 * bottom and very top — for objects whose x/z it had already pushed most of the
 * way to the WALL. In a phreatic tube the roof at the wall is metres below the
 * apex, so a stalactite seated near one hung from a point well inside the rock
 * and the visible object began halfway down: the "flat paper cut-out" shots are
 * partly this, a formation whose root is buried and whose remaining stub is
 * seen edge-on. `floorAt`/`ceilAt` are the existing exact answers to "where is
 * the outline at this horizontal offset" — the same two functions the collider
 * uses — so the anchor is now the local roof, not the apex.
 *
 * Then `surfaceLift` adds what the rock displacement does to it. The floor's
 * own amplitude is small by design (ROUGH_FLOOR, +/-0.36 m on the widest rooms
 * in grove-01); the roof carries the full wall roughness and moves five times
 * as far.
 */
function floorY(k, path, i, sh, nOff, x, z) {
  _secC.x = clamp(nOff, -sh.w + 1e-3, sh.w - 1e-3);
  _secC.y = floorAt(_secC.x, sh);
  return path.y[i] + path.r[i] * _secC.y + surfaceLift(k, path, i, sh, _secC, x, z);
}

function ceilY(k, path, i, sh, nOff, x, z) {
  _secC.x = clamp(nOff, -sh.w + 1e-3, sh.w - 1e-3);
  _secC.y = ceilAt(_secC.x, sh);
  return path.y[i] + path.r[i] * _secC.y + surfaceLift(k, path, i, sh, _secC, x, z);
}

/**
 * Sides on a breakdown slab. Seven: see `_emitBlock` for why not six and not
 * twenty. It is fixed rather than drawn because the vertex budget in `prepare`
 * is allocated up front and an undercount there writes off the end of a typed
 * array, which is silent — the shape simply loses a face somewhere.
 */
const BLOCK_SIDES = 7;

/**
 * How much of a breakdown slab the BODY is allowed to stand on, against how much
 * of it is drawn. Fitted, not derived — the long block in `caveSample` is where
 * the measurement and the reasoning are, and neither of these numbers means
 * anything without it.
 *
 * Kept here rather than inline because they are a fact about `_emitBlock`'s
 * shape, not about the collider: the day the plan jitter or the lean in that
 * function changes, these are what has to be re-fitted, and they should be
 * sitting next to it when it happens.
 */
const BLOCK_REACH = 0.5;
const BLOCK_RISE = 0.8;

/**
 * How far back from the drawn wall a formation's root is bedded, in METRES.
 *
 * A quarter of a metre is about the amplitude of the fragment shader's own
 * relief, so a root at this depth is inside rock the eye reads as solid
 * whatever the per-pixel normal is doing, and it is small enough that a straw
 * 7 cm across is still standing in the room rather than growing out of the
 * middle of the wall. It is a length and not a fraction of the radius on
 * purpose — see the block in `placeSpires`.
 */
const SPIRE_BED = 0.25;

/**
 * …and the same for a crystal, which wants the opposite sign of the same idea.
 *
 * A speleothem grows off the rock and its root is a joint. A crystal grows OUT
 * OF the rock: its base belongs inside the wall, or the base cap is on screen
 * and the whole spike reads as a shard lying against the wall rather than as
 * one that came out of it. Half the spike's own radius plus a fixed 6 cm, so a
 * three-metre blade is buried proportionately and a 4 cm needle is not swallowed
 * whole.
 */
const CRYSTAL_BED = 0.06;

/**
 * Panels across a drapery, and the thickness of the sheet they make.
 *
 * Eight rather than the five the flat version had, because the shape's whole
 * job is now its OUTLINE — a curtain read as a dark silhouette against a lit
 * chamber, which is the one thing down here that can say how big the room is —
 * and five segments of a sine give you a lower edge with three bumps in it,
 * which reads as a decorative moulding. Eight carries a second, finer wave that
 * breaks the regularity of the first.
 *
 * Twelve centimetres at the ridge tapering to four at the free edge: real
 * flowstone is deposited from the top down and is thickest where it is oldest.
 * It also has to be thicker than the fragment shader's relief, or the per-pixel
 * normal makes the two faces of a thin sheet disagree about which way they
 * point and the edge sparkles.
 *
 * Fixed rather than drawn, for the reason at BLOCK_SIDES: the vertex budget is
 * allocated from this number.
 */
const DRAPE_PANELS = 8;
const DRAPE_THICK = 0.12;
/** How far the ridge is buried in the roof, so the join is never on screen. */
const DRAPE_ROOT = 0.18;

/**
 * HOW FREELY THE MELT MAY CARRY A BODY, BY WHAT THAT BODY IS ATTACHED TO —
 * `aBody.w`, and the reason that attribute is a vec4 rather than a vec3.
 *
 * living.js:1029-1033 damps the melt on every prop above ground to 0.25 flat,
 * because up there a prop stands on TERRAIN whose own melt is switched off
 * within a few metres of the eye: the ground does not move, so a boulder that
 * did would visibly slide across it.
 *
 * UNDERGROUND THAT REASONING INVERTS, AND COPYING THE CONSTANT WITHOUT THE
 * REASONING PUT THE BUG BACK IN A NEW PLACE. The cave wall melts at FULL
 * amplitude — 1.7 m of uFlow at the peak — and the floor at 0.14 of it, because
 * `rrFree` pins the surface the body walks on and nothing else. So a stalactite
 * damped to 0.25 does not stay still relative to its rock, it is left BEHIND by
 * a roof travelling four times faster, and at the peak it hangs a metre under a
 * ceiling it is supposed to be growing out of — showing the root cap, which is
 * exactly the detached-formation report arriving through the other door. It is
 * plainly visible in `scripts/cave-trip.mjs`'s straw station.
 *
 * The honest rule is one sentence and it covers both worlds: A BODY MOVES WITH
 * THE SURFACE IT IS ATTACHED TO. Roof and wall formations therefore take the
 * wall's own factor and travel with the rock; anything standing on the floor,
 * or colliding, takes the floor's, which is 1 - 0.86 and is where that number
 * comes from. Both are per-BODY constants, so the translation is still rigid
 * and nothing can tear.
 *
 * Blocks and columns are the two things down here with collision, and their
 * obstacle records do not move, so the floor's figure is also the one that
 * keeps the visible object on top of the thing the body actually climbs.
 */
const MELT_FLOOR = 0.14;
const MELT_ROCK = 1;

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
/**
 * REPAINTED CYAN / VIOLET / AMBER, AND THE THIRD ONE IS THE REASON THE OTHER
 * TWO READ AS COLD.
 *
 * The old trio was teal (0x74c6b4), a muted cornflower (0x6f8fd0) and a dull
 * terracotta (0xd09257) — three colours that are all about a third of the way
 * to grey, which is why the tour shots of the middle of a passage came back as
 * a single grey-green wash however much light was in them. Nothing in the frame
 * was saturated, so nothing in the frame had a hue.
 *
 * The reference the palette is now aimed at holds two saturated cool families —
 * cyan and violet — against a very small amount of amber, and the amber is not
 * decoration: a frame with no warm in it at all does not read as cool, it reads
 * as monochrome. FUNGUS_ODD is drawn 14% of the time and a cluster is a couple
 * of metres across, so it lands at well under the 5% of frame the reference
 * spends on warmth, which is what the ratio has to be for it to work.
 *
 * Authored as sRGB hex and converted on the way in — `THREE.ColorManagement` is
 * on by default in three 0.185, so a `new THREE.Color(0x...)` here IS linear by
 * the time `_shade` multiplies it. That is the opposite of the plumage-multiplier
 * trap in `forest.js`, where the ratios are bare floats and no conversion
 * happens; the rule is that a hex goes through Color and a multiplier does not.
 */
const FUNGUS_COLD = new THREE.Color(0x46cdf0);
const FUNGUS_DEEP = new THREE.Color(0x9a63e8);
const FUNGUS_ODD = new THREE.Color(0xf0a048);
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
/**
 * How level the floor has to stay, and how wide the section has to be, for the
 * terminal pool to keep walking backwards. See the block at the end of
 * `placeWater`.
 *
 * 0.45 m over up to ninety rings is a gradient of well under one in a hundred,
 * which is what "the terminus levelled it" produces and what nothing else in the
 * cave does — the walk's own pitch is clamped at MAX_DIVE, twenty-seven degrees.
 * 4.5 m of half-width is comfortably above every corridor section in SHAPES and
 * comfortably below `room`'s narrowest day, so the run cannot escape the chamber
 * up the passage that feeds it.
 */
const POOL_LEVEL = 0.45;
const POOL_MIN_HALF = 4.5;
/**
 * Metres of water over the HIGHEST floor in the run.
 *
 * A still pool is level by definition, so its surface is one Y for the whole run
 * and the shoreline is wherever the ground rises through it — see `_emitWater`.
 * Taking the surface off the highest floor rather than the mean guarantees every
 * ring has water in it; twenty centimetres there means twenty to sixty-five
 * across the pool, against a body that walks the analytic floor underneath it.
 * Deeper was tried at 0.6 and is a lake you wade through to the waist, which
 * reads as a hazard rather than as a mirror.
 */
const POOL_DEPTH = 0.2;

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

  /**
   * AND THE ONE AT THE END IS NOT LEFT TO CHANCE.
   *
   * Everything above this line is a stream: seeded from its own generator,
   * running for fourteen to sixty-six rings, then thirty to a hundred and twenty
   * of nothing. The pools in it are opportunistic — a one-in-six roll wherever
   * the floor happens to be flat inside a run — and the runs are placed with no
   * knowledge of where the passage ends, so on a six-hundred-metre cave the last
   * run stops well short of the terminal chamber more often than not. Measured on
   * grove-01 k=0 before this: twelve runs, none of them still, the last of them
   * ninety metres from the end.
   *
   * The terminal chamber is the one place in the world where a still pool is
   * guaranteed to be RIGHT rather than merely possible. `terminusFit` levels its
   * floor deliberately, which is exactly the condition the opportunistic test
   * above is looking for, and it is the largest space in the cave — so the thing
   * the reference is mostly made of, a still sheet doubling a room too big to
   * see the far side of, was being decided by a die roll in a function that does
   * not know the chamber exists.
   *
   * So: walk back from `endRing` — published by the terminus work for this — for
   * as long as the floor stays within POOL_LEVEL of the terminal floor and the
   * section stays wider than POOL_MIN_HALF. That test finds a chamber and stops
   * at the passage feeding it, because a passage that arrives at a chamber
   * arrives DOWN, and it costs nothing on a cave whose end is a plain dome:
   * there the section fails POOL_MIN_HALF within a ring or two and no run is
   * pushed at all.
   */
  const endR = Math.min(n - 3, (path.endRing ?? n - 1) - 1);
  const lastRun = runs.length ? runs[runs.length - 1].i1 : 0;
  if (endR > lastRun + 10) {
    const base = path.y[endR] - path.r[endR] * path.f[endR];
    let j0 = endR;
    while (j0 > lastRun + 2 && endR - j0 < 90) {
      const k = j0 - 1;
      const fl = path.y[k] - path.r[k] * path.f[k];
      if (Math.abs(fl - base) > POOL_LEVEL) break;
      if (path.r[k] * path.w[k] < POOL_MIN_HALF) break;
      j0 = k;
    }
    if (endR - j0 >= 8) {
      for (let j = j0; j <= endR; j++) {
        /**
         * Tapered at the SHALLOW end only. A stream is tapered at both because
         * both of its ends are arbitrary; a lake's far end is the wall of the
         * chamber, and fading the water out before it reaches the rock is the
         * one thing that would make it read as a decal.
         */
        path.wet[j] = clamp01((j - j0) / 5);
        path.pool[j] = Math.max(path.pool[j], path.wet[j]);
      }
      /**
       * ONE SURFACE HEIGHT FOR THE WHOLE LAKE, SOLVED HERE AND CARRIED.
       *
       * It is the highest DRAWN floor in the run — `floorY` is the analytic
       * outline plus the rock displacement `_emitRing` applies, i.e. the ground
       * you can actually see — plus POOL_DEPTH, so no ring is left dry. It has to
       * be one number for the run because still water is level, and it is
       * computed here rather than in `_emitWater` because of the chunking below.
       */
      let poolY = -Infinity;
      for (let j = j0; j <= endR; j++) {
        const sh = ringShape(path, j, _shapeB);
        poolY = Math.max(poolY, floorY(c.k, path, j, sh, 0, path.x[j], path.z[j]));
      }
      poolY += POOL_DEPTH;
      /**
       * CUT INTO CHUNKS, BECAUSE ONE EXTRA IS ONE UNINTERRUPTIBLE SLICE.
       *
       * `_emitExtra` emits one object per call and `step` yields between them,
       * so a water run is atomic however long it is. That was free while a run
       * was a strip of quads with a constant width; a lake solves its shoreline
       * by bisection at every ring on both sides, and `cave-build` caught it
       * immediately — the extras stage went from a 1.40 ms worst slice to 1.90
       * against a 1.8 ms budget, on a gate that exists precisely because two
       * other stages had already grown out of their slicing.
       *
       * Ten rings a chunk, overlapping by one so the strips join on a shared
       * edge rather than meeting at one. Same geometry, same surface height,
       * emitted in pieces the slicer can put down between frames.
       */
      const CHUNK = 10;
      for (let a = j0; a < endR; a += CHUNK) {
        const b = Math.min(endR + 1, a + CHUNK + 1);
        runs.push({ i0: a, i1: b, still: true, poolY });
        if (b > endR) break;
      }
    }
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
     * THE FOOT, ON THE ROCK THAT IS DRAWN RATHER THAN THE ROCK THAT WAS
     * PLANNED — and it is TWO corrections, of which only the second is new.
     *
     * `y` was `path.y[i] - r * f`: the section's deepest point, used for a slab
     * that has already been thrown up to `half - 0.9` metres sideways. A
     * passage floor is a bowl (see the block above `floorAt`), so a block near
     * the wall was seated up to a couple of metres BELOW the ground it stands
     * on and half of it vanished. `floorY` solves the outline at the block's own
     * offset — the same function the collider uses — and then adds the rock
     * displacement `_emitRing` applies there.
     *
     * IT IS ALSO THE NUMBER THE OBSTACLE LIST TAKES, deliberately: the visible
     * slab and the surface the body climbs stay one object. What that costs is
     * that the walkable top is now up to 0.36 m off the ANALYTIC floor beside
     * it — the same bargain, and the same magnitude, ROUGH_FLOOR was already
     * tuned against the body's step allowance for.
     *
     * AND THE HEADROOM CAP HAD TO FOLLOW IT. `head` was the axis's own floor to
     * ceiling; a block seated on the bowl's side and capped by the axis figure
     * could put a standing player's head in a roof that is metres lower out
     * there. Both ends are now local, so "nothing you climb may put your head in
     * the roof" means what it says wherever the block ended up. Neither call
     * touches `rng`, so the draw order below is untouched and the world is the
     * same world.
     */
    const sh = ringShape(path, i, _shapeA);
    const nOff = (Math.cos(ang) * off) / r;
    const foot = floorY(c.k, path, i, sh, nOff, px, pz);
    const head = ceilY(c.k, path, i, sh, nOff, px, pz) - foot;

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
      y: foot,
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
      const sh = ringShape(path, i, _shapeA);
      section(phi, sh, tmp);
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
      /**
       * A FIXED BED IN THE DRAWN WALL, NOT A TENTH OF THE RADIUS OF AN IDEAL ONE.
       *
       * `r * 0.9` meant two things at once and got both of them wrong. It was
       * measured off the ANALYTIC ellipse, which `_emitRing` then pushes by up to
       * `r * ROUGH` — 0.9 m on a four-metre passage, five times the inset — so
       * whether a formation ended up standing in the room or buried in the rock
       * was decided by a noise lookup nobody consulted. And the inset itself was
       * a fraction of the radius, so in a twelve-metre chamber every stalagmite
       * stood a metre and a bit out from the wall, in mid-air.
       *
       * Seated on the surface the mesh draws, then bedded SPIRE_BED metres back
       * into the room from it. The correction is radial, so at the top and bottom
       * of the section — where `tmp.x` is near zero and where the floor and roof
       * anchors below take over — it comes to nothing on its own, which is
       * exactly right: a stalagmite under the middle of the roof is placed by its
       * floor, not by the wall.
       */
      const ax0 = path.x[i] + nx * tmp.x * r + tx * along;
      const az0 = path.z[i] + nz * tmp.x * r + tz * along;
      const ay0 = path.y[i] + tmp.y * r;
      const ol = Math.hypot(tmp.x, tmp.y) || 1;
      const seat = wallPush(c.k, path, i, phi, sh, tmp, ax0, ay0, az0) - SPIRE_BED;
      const nOff = tmp.x + ((tmp.x / ol) * seat) / r;
      const px = path.x[i] + nx * nOff * r + tx * along;
      const pz = path.z[i] + nz * nOff * r + tz * along;
      // The roof and the ground where this thing actually is. See `floorY`.
      const floor = floorY(c.k, path, i, sh, nOff, px, pz);
      const ceil = ceilY(c.k, path, i, sh, nOff, px, pz);
      /**
       * …and the height between them, which is what a formation may grow into.
       * `head` above is the AXIS's floor-to-ceiling and stays the axis's: it
       * decides which KIND of thing is drawn here, and re-deciding that on a
       * local figure would change the roster of every cave in the world for a
       * reason that has nothing to do with the bug. What it must not go on
       * deciding is how tall the thing is where it stands.
       */
      const room = Math.max(0.3, ceil - floor);

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
        const h = Math.min(room * 0.42, rngRange(rng, 0.35, 1.7));
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
        const h = Math.min(room * 0.45, rngRange(rng, 0.3, 2.0));
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
         * A drapery, which is a curtain, and it is now a SOLID one.
         *
         * WHAT IT WAS. Five flat quads, emitted twice at identical coordinates
         * with opposed windings, because the material is FrontSide and one sheet
         * is invisible from half the passage. Two coplanar copies of the same
         * surface z-fight before the trip touches them; under the trip they were
         * worse than that, because the second copy's normals are the exact
         * negation of the first's and the breath moves each face along its own
         * normal — so the two halves of a zero-thickness object were driven
         * APART by up to 0.67 m. That is the single most visible instance of the
         * "shapes breathing apart" report, and no amount of shader damping fixes
         * a shape that has no inside.
         *
         * WHAT IT IS. A slab with a real thickness, a wavy plan, a scalloped
         * lower edge and closed ends — see `_emitSpire`. Which is also why the
         * size argument that used to sit here has been reversed rather than
         * repeated. It said a curtain 3.4 m across was "a piece of set dressing
         * that has come loose", and it was right about a FLAT QUAD that size: a
         * plane with no thickness reads as a decal at any scale, and the bigger
         * it is the more obviously so. A hanging mass of rock is the opposite —
         * it is one of the few things in a cave that can carry SCALE, because it
         * is read as a silhouette against whatever is lit behind it, and a small
         * silhouette says the room is small.
         *
         * So they are long now, and they are capped against the local roof
         * height rather than the axis's.
         */
        out.push({
          kind: 'drape',
          x: px,
          z: pz,
          y0: ceil,
          h: Math.min(room * 0.62, rngRange(rng, 0.9, 3.2)),
          run: rngRange(rng, 1.4, 4.2),
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
function* placeSpores(c, path, tag, lights) {
  const rng = makeRng(`${getWorldSeed()}:cave-spore:${c.k}:${tag}`);
  const n = path.x.length;
  const out = [];
  const tmp = { x: 0, y: 0 };
  /**
   * The one placer that is sliced, and the only one that needed to be.
   *
   * Measured share of `prepare` on nine grove-01 caves: spores 6.7%, spires
   * 2.6%, blocks 1.0%, crystals 0.3%, water 0.2%, fungi 0.1%. Spores are dear
   * for a reason none of the others share — each one walks the WHOLE light list
   * to find what is lighting it, and both terms grew with the passage, so this
   * is the only placer whose cost is quadratic in the length of the cave. The
   * rest are a fraction of a millisecond each and are taken whole between two
   * stops in `_prepare`, which is cheaper than slicing them would be.
   */
  const SPORE_SLICE = 64;
  for (let i = 6; i < n - 4; i += 2) {
    if (i % SPORE_SLICE < 2) yield 'spores';
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
/**
 * THE AMBER AND THE ROSE ARE GONE, AND DELETING THEM IS THE POINT OF THIS EDIT.
 *
 * A kind is drawn PER CAVE, so `amber` did not mean "some warm crystals": it
 * meant a whole two-hundred-metre passage lit orange, in which nothing was cool
 * and the sparse warm accent the palette is built around had nothing to be an
 * accent against. The same argument retires `rose`. Warmth in this cave now
 * comes only from FUNGUS_ODD, which is a per-CLUSTER draw at 14% and therefore
 * actually sparse — see the note there.
 *
 * What is left is five readings of one idea: cyan through violet to magenta,
 * with a teal-green that is the far arch of the reference and an ice-blue that
 * is nearly the key light's own colour. Two caves on the same ridge are still
 * somewhere different from each other; they are now different in a way that
 * belongs to the same world, which the amber never did.
 *
 * MEASURED AGAINST THE BRIGHT PASS, because these are the only things down here
 * that reach it. `_emitCrystal` emits lerp(rim, core, 0.34) * (1.15 + power *
 * 1.1), power 0.5-1.15, so the multiplier is 1.70-2.42 and the peak channel of
 * the lerp decides where in the 0.85-threshold/0.55-knee curve a facet lands.
 * The five below peak at 0.79-1.00 in their strongest channel, i.e. 1.34-2.42
 * emitted — the same 1.15-2.4 band the previous set was tuned into, so the
 * bloom behaviour is unchanged and only the hue has moved.
 */
const CRYSTAL_KINDS = [
  { rim: 0x1f9fd8, core: 0xa9ecff, name: 'cyan' },
  { rim: 0xa04ff0, core: 0xe0b6ff, name: 'violet' },
  { rim: 0xd060ff, core: 0xf4c8ff, name: 'magenta' },
  { rim: 0x1fc4b4, core: 0xa8ffee, name: 'teal' },
  { rim: 0x5f8fe8, core: 0xd8ecff, name: 'ice' },
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
        const sh = ringShape(path, j, _shapeA);
        section(phi, sh, tmp);
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
        /**
         * ROOTED IN THE ROCK THAT IS DRAWN. See `wallPush`.
         *
         * `r * 0.96` is a 4% inset on the IDEAL ellipse, and `_emitRing` then
         * moves the real wall by up to `r * ROUGH` — 23%, six times as much, in
         * either direction. So on any given spike the 4% decided nothing: a
         * crystal was seated a metre out in the passage as often as it was
         * seated a metre inside the wall, and the one seated out in the passage
         * showed you its uncapped base ring, which on a FrontSide material is a
         * hole you look through the crystal with. That is the razor-edged
         * see-through surface in the 88 m frame.
         *
         * The seat is computed here; the depth needs `rad`, so it is applied at
         * the bottom where the size is known.
         */
        const ax0 = path.x[j] + nx * tmp.x * r + tx * slide;
        const ay0 = path.y[j] + tmp.y * r;
        const az0 = path.z[j] + nz * tmp.x * r + tz * slide;
        const ol = Math.hypot(tmp.x, tmp.y) || 1;
        const push = wallPush(c.k, path, j, phi, sh, tmp, ax0, ay0, az0);
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
        const rad = len * rngRange(rng, 0.11, 0.24);
        // The drawn wall, then far enough behind it that the (now capped) base
        // is inside the rock. See CRYSTAL_BED. `len` and the direction are
        // untouched: this moves a spike, it does not resize one.
        const bed = push - (CRYSTAL_BED + rad * 0.5);
        const px = ax0 + nx * (tmp.x / ol) * bed;
        const py = ay0 + (tmp.y / ol) * bed;
        const pz = az0 + nz * (tmp.x / ol) * bed;
        out.push({
          x: px,
          y: py,
          z: pz,
          dx,
          dy,
          dz,
          len,
          rad,
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
      /**
       * The colour and strength of what comes in at the mouth.
       *
       * COOLER AND BRIGHTER, AND uDayGain IS NOW WRITTEN. It was declared,
       * plumbed into both places in the fragment shader that use vDay, and left
       * at a hard 1 that nothing ever assigned — so the one term the header
       * (see LIGHT, WITHOUT A SECOND SHADOW PASS) says must stay live was in
       * practice as baked as everything else.
       *
       * `setDaylight` writes it now, from the hour. That fixes a real bug on
       * the way past: uDay is a constant, so before this the mouth of every
       * cave in the world glowed the same daylight green at three in the
       * morning. It is floored rather than taken to zero, because a mouth you
       * cannot find in the dark is a mouth you are trapped behind.
       *
       * The hue moved from 0x62806e — a green-grey — toward a teal, and the
       * base gain to 1.45. The mouth is the only real light source in the
       * feature and the reference this pass is aimed at is built on the
       * brightest thing being far away: at 1.45 the doorway seen from thirty
       * metres in clips into the bloom and becomes a shape rather than a
       * gradient, which is exactly the read the header asks this term for. It
       * stays green-ish rather than going to the reference's cyan-white because
       * what is on the other side of it is a wood, and a cyan doorway would
       * say "another cave".
       */
      uDay: { value: new THREE.Color(0x74a294) },
      uDayGain: { value: 1.45 },
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
      /**
       * MOVED FROM A NAVY TO AN INDIGO, AT THE SAME LUMINANCE.
       *
       * 0x0a1526 is (0.0030, 0.0075, 0.0194) linear, and the middle number is
       * the problem: it is the largest of the three and green is 71% of
       * luminance, so the "deepest blue in the project" was in fact carrying
       * most of its weight in green. Against rock that is also slightly green
       * the far dark had no hue at all, which is the grey-teal every tour shot
       * of a long gallery came back as.
       *
       * 0x141033 is (0.0070, 0.0052, 0.0331): luminance 0.0076 against the old
       * 0.0074 — the same stop, deliberately, because the note below about this
       * being a FLOOR and not a FILL is still the thing that keeps the passage
       * from turning into blue mist. All that has changed is where the energy
       * sits, and now the darkest part of a cave is violet.
       */
      uAmbient: { value: new THREE.Color(0x141033) },
      /**
       * THE MIDDLE DISTANCE, WHICH IS THE LAYER THE FOG DID NOT HAVE.
       *
       * `fogColor` is one colour and an exp2 curve, so everything past the
       * point where the curve bites is the same colour — the far wall of a
       * chamber and the wall thirty metres behind it are both fogColor and the
       * two therefore lie in the same plane. That is why a big room read as
       * small: it had a foreground and a backdrop and nothing in between.
       *
       * The reference separates three depths with three different hazes, and
       * the cheapest honest version of that is to let the fog COLOUR itself
       * move with distance rather than only its density. Near, it is the fog
       * the atmosphere composed (near-black); by forty metres it has lifted
       * into this — a blue that is brighter than anything the rock can be, so a
       * far surface is lighter than a near one whatever its albedo, which is
       * the whole of aerial perspective and the only depth cue that works in a
       * space with no sky in it.
       *
       * It costs one mix and one smoothstep in the fragment that already
       * computes fogFactor. Measured at 0.00 ms against the noise: it is two
       * ALU on a shader whose bill is five texture fetches.
       */
      uHaze: { value: new THREE.Color(0x1b2a6b) },
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
      /**
       * THE ANCHOR OF THE BODY THIS VERTEX BELONGS TO, and the whole of the fix
       * for "the shapes are breathing apart".
       *
       * On the tube lattice it is the vertex's OWN position, so "position -
       * aBody" is exactly the zero vector and every term below collapses, one by
       * one, to the arithmetic that was here before this attribute existed. On an
       * extras vertex it is that one object's centroid, which lets the same three
       * lines ask their question about the SOLID instead of about the facet.
       *
       * WHY THE FACET WAS THE WRONG THING TO ASK. Every extras vertex is an
       * unwelded duplicate carrying a flat face normal — deliberately; a
       * smooth-normalled boulder is a potato — and both displacement terms were
       * keyed on it.
       *
       *   rrFree is a function of normal.y, which is DISCONTINUOUS across a
       *   block's own arris. A top face scored 0.14 and the overhanging side
       *   face sharing an edge with it scored 1.0, at the same world position:
       *   up to 1.1 m of relative slide between two triangles that are supposed
       *   to touch. That is the tearing, and it is the loudest of the four.
       *
       *   The breath moves each face along its own normal, so a 90 degree edge
       *   opens by 2*amp*sin(theta/2) — 0.48 m at the peak, on straws whose
       *   radius is 3.5 cm and crystals 0.3 to 1.0 m long. The displacement was
       *   several times the radius of the thing being displaced, so these did not
       *   deform, they detonated into face-shaped shards with culled backs.
       *
       * WHAT IT COSTS, MEASURED rather than guessed. grove-01 k=0 is 122 088
       * vertices; the other six attributes are 20 floats a vertex, so this vec3
       * is 12 bytes on 80. 1.397 MB against 9.31 MB of everything else, +15%.
       * The two neighbouring caves come out at 1.185 and 1.117 MB on the same
       * ratio.
       *
       * The only way to get the same result without it is to weld the extras so
       * their normals are smooth, which deletes the faceting the breakdown
       * blocks and the crystals exist for — and nothing else already on the
       * vertex says which object a vertex came from, so there is no third
       * option. aSurf is full, aGlow is full, and aRock and aLit are colours the
       * fragment shader reads.
       *
       * AND w IS A FOURTH CHANNEL FOR FOUR BYTES: how freely the melt may carry
       * this body, which has to be a per-BODY constant or the melt is a shear
       * rather than a translation, and which nothing else on the vertex can
       * supply. See MELT_FLOOR. It is ignored entirely on the lattice — rrProp
       * is zero there and the mix never reads it.
       */
      attribute vec4 aBody;
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
        /**
         * THE BODY, AND WHY EVERY BRANCH BELOW IS A mix() AND NOT AN if().
         *
         * rrProp is 0 on the tube and 1 on anything standing in it. The lattice
         * writes each vertex's own position into aBody, so rrReach is exactly
         * 0.0 there and mix(x, y, 0.0) is x*(1.0-0.0) + y*0.0 — x, bit for bit,
         * for any finite y. THAT is how "the wall does not change" is
         * guaranteed: by the arithmetic, not by a tolerance and not by a test I
         * remembered to write. Verified against a per-vertex readback of the
         * lattice rows before and after: max |delta| 0.0 m over 33 792 wall
         * vertices at the peak.
         *
         * 1e-4 rather than 0.0 only so the divide below cannot see a zero. No
         * emitter can produce an extras vertex sitting on its own centroid —
         * every centroid here is interior to its solid — and if one ever did it
         * would simply take the wall path for that one vertex.
         */
        vec3 rrArm = position - aBody.xyz;
        float rrReach = length(rrArm);
        float rrProp = step(1e-4, rrReach);
        /** The body's own outward direction: SMOOTH over the whole solid, which
         *  is the property the flat face normal does not have. Two vertices at
         *  the same corner of a block get the same rrOut whatever facets they
         *  belong to, so nothing can slide against anything it touches. */
        vec3 rrOut = rrArm / max(rrReach, 1e-4);
        /** Where the world fields are sampled. A prop reads them ONCE, at its
         *  anchor, so the melt can only ever translate it. */
        vec3 rrAt = mix(world, (modelMatrix * vec4(aBody.xyz, 1.0)).xyz, rrProp);

        float rrFloorish = max(clamp(normal.y, 0.0, 1.0), aSurf.w);
        /**
         * …and the same question asked of the body rather than of the face.
         *
         * "Which way is up here" is meaningful for a prop — you stand on the top
         * of a breakdown block, so its upper surface has to be as reluctant to
         * move as the floor is — but reading it off the facet is what tore the
         * blocks apart. rrOut.y is the same number, continuous.
         */
        rrFloorish = mix(rrFloorish, clamp(rrOut.y, 0.0, 1.0), rrProp);
        float rrFree = 1.0 - rrFloorish * 0.86;
        if (uLevel > 0.0005) {
          vec3 flow = rrFbm2v(rrAt * 0.075 + vec3(0.0, uTime * 0.05, 0.0));
          /**
           * THE MELT, AND THE DAMPING THE CAVE HAD NEVER HAD.
           *
           * uFlow went into this shader raw, on every surface, so a cave prop
           * moved about four times as far as an identical boulder in the wood —
           * where living.js:1029-1033 damps it, with the note that at a prop's
           * size this is a translation rather than a deformation and a boulder
           * sliding half a metre reads as a bug.
           *
           * The factor is per BODY, out of aBody.w, and not the one constant
           * living.js uses: see MELT_FLOOR for why the same reasoning gives a
           * different answer underground, where the rock a formation is attached
           * to is itself the thing that melts hardest.
           *
           * It replaces rrFree for props rather than multiplying it, because
           * rrFree varies over the body and a melt scaled per vertex is not a
           * translation, it is a shear. One number for the whole solid is what
           * makes it rigid.
           */
          p += flow * uFlow * mix(rrFree, aBody.w, rrProp);
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
          float rrBph = uBreathPhase + rrNoise(rrAt * 0.085 + 31.0) * 3.0;
          /**
           * THE BREATH, TWICE: once for a surface with an inside, once for a
           * surface that IS one.
           *
           * The wall's term is untouched. It is a closed watertight tube whose
           * normals all point at the centre line, so pushing every vertex along
           * its own normal narrows the passage and cannot open a seam anywhere;
           * this is the one place the DC part of the uSwell term is harmless,
           * and leaving it is what keeps the lattice provably identical.
           *
           * A PROP GETS THREE CHANGES, AND ALL THREE ARE THE SAME IDEA.
           *
           *   ALONG THE BODY, NOT ALONG THE FACE. rrOut is continuous over the
           *   whole solid, so adjacent faces move together: the object deforms
           *   instead of coming apart at every arris.
           *
           *   GAUGED BY ITS OWN SIZE. living.js:1151-1157 will not let a surface
           *   move further than it is thick, because past that it passes through
           *   its own inside and back-face culling deletes it — "some trees are
           *   disappearing". A cave prop had no gauge at all, so 0.22 m of
           *   breath was applied to a 3.5 cm straw. rrReach IS the thickness
           *   gauge here, free: it is how far this vertex is from the middle of
           *   its own object. A third of it is a visible swell that can never
           *   reach the centre, whatever the director does.
           *
           *   AND THE SWELL RIDES THE BREATH RATHER THAN SITTING UNDER IT.
           *   uSwell entered as "+ uSwell * 0.35", a DC offset — every face
           *   permanently pushed out along its own normal, i.e. every shell
           *   permanently held open, by 0.112 m at the plain peak and 0.258 m
           *   at a surge. living.js:1281-1285 multiplies uSwell BY the breath
           *   for exactly this reason: it passes through zero twice a cycle and
           *   the surface inhales and exhales in place. Same treatment.
           */
          vec3 rrWallStep =
            normal * (rrLung(rrBph) * uBreathAmp * 0.7 + uSwell * 0.35) * rrFree;
          float rrPropAmp = min(uBreathAmp * 0.3 + uSwell * 0.12, rrReach * 0.35);
          vec3 rrPropStep = rrOut * (rrLung(rrBph) * rrPropAmp * rrFree);
          p += mix(rrWallStep, rrPropStep, rrProp);
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
      uniform vec3 uHaze;
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
        /**
         * CONTRAST-EXPANDED, AND THE REASON IS A MEASUREMENT RATHER THAN A
         * PREFERENCE.
         *
         * rrFbm2 is 0.6 of a value noise plus 0.3 of the same at twice the
         * frequency, so its output is a sum of two roughly triangular
         * distributions: the full -0.9..0.9 exists, but it is reached rarely and
         * NEVER WITHIN ONE OBJECT. Dumped to the framebuffer, grain over the
         * whole face of a two-metre breakdown slab spans 0.52 to 0.67. Every
         * multiplier in this shader keyed to it is written as though it saw
         * 0.05..0.95 — 0.78 + 0.42 * grain is "a factor of two across the cave"
         * and is in fact six per cent across a block, which is why three
         * successive attempts at putting rock grain on the props measured 3/255
         * and were invisible.
         *
         * A gain of 1.9 about the midpoint takes the slab's span to 0.28 and
         * clips the tails. Clipping is not a defect here: what it produces is
         * patches of rock with no relief in them, which is what a broken face
         * of limestone has. The alternative — raising every coefficient instead
         * — buys the same local contrast and four times the global contrast,
         * and the wall was never the thing that was wrong.
         */
        float grain = clamp(grainRaw * 0.95 + 0.5, 0.0, 1.0);
        /**
         * The fine octave's own value, kept for the albedo: pitted rock is
         * lighter where it has broken and darker where it has not.
         *
         * It is expanded LESS, and it is the one carrying most of the new
         * contrast below, because at 4.2 cycles per metre its local range over
         * one object already IS most of its global range — eight cycles across a
         * slab's face against the coarse octave's two. That is the whole
         * asymmetry: the band that shows an object's form is the coarse one and
         * it barely varies over an object; the band that shows its SURFACE is
         * the fine one and it varies fully. Weight accordingly.
         */
        float fine = clamp(fineRaw * 0.62 + 0.5, 0.0, 1.0);
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
        /**
         * THE INCOHERENT FLOOR IS NO LONGER FLAT, AND THAT IS THE WHOLE OF WHY A
         * BREAKDOWN BLOCK HAD NO ROCK IN IT.
         *
         * This was mix(1.0, ...), i.e. "many sources at many angles IS ambient",
         * and as a statement about ENERGY that is still true. As a statement
         * about SHADING it deleted the feature. Everything above this line —
         * two octaves of world-space relief and a bedding ledge — reaches the
         * picture through exactly two terms, this one and 'spec', and both were
         * multiplied by 'coh'. A prop standing in the middle of a chamber has
         * coh near zero by construction (it is surrounded), so its relief was
         * computed, five fetches' worth, and then thrown away: the blocks and
         * the columns came out as smooth pale card that did not belong to the
         * same stone as the wall beside them. Confirmed by dumping
         * vec3(grain, fine, bed) straight to the framebuffer — the props carry
         * all three, identically to the lattice, and always did.
         *
         * A weak agreement is not NO agreement. 0.70 + 0.60 * wrap is centred on
         * 1.0 — mean(wrap) over a sphere is a half — so the average brightness of
         * every surface in the cave is unchanged to the bit, and what it adds is
         * a +/-30% swing that reads the perturbed normal. The degenerate case is
         * exact rather than approximate: vGlow of exactly zero gives ldir of
         * exactly zero, wrap of exactly 0.5, and 0.70 + 0.30 = 1.0, which is what
         * the old constant was.
         */
        float ndl = mix(0.70 + 0.60 * wrap, wrap * wrap * 1.45, clamp(coh, 0.0, 1.0));

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
        /**
         * …AND THE AMBIENT HAS RELIEF IN IT NOW, WHICH IT HAD TO BECAUSE IN THE
         * BIG CHAMBERS IT IS THE ONLY TERM LEFT.
         *
         * The near-field term is dead past three metres by design, and vLit is
         * whatever the fungi reached. In a hall — 24 m of half-width against a
         * cluster that carries thirteen — that leaves the ambient as ninety per
         * cent of every pixel, and the ambient was one flat colour times a
         * per-vertex occlusion. A flat term over a surface with five fetches of
         * relief on it is a surface with no relief on it.
         *
         * Two multiplies, and neither costs a fetch because both heights are
         * already in registers:
         *
         *   'micro' is the relief read as OCCLUSION rather than as a normal — a
         *   hollow in the rock sees less of the room than the boss beside it, and
         *   that is true with no light direction anywhere, which is exactly the
         *   case that was failing. Centred so it neither brightens nor darkens
         *   the cave on average: 0.52 + 0.66 * grain has mean 0.85, times the
         *   fine octave's mean 0.99, times the 1.19 below.
         *
         *   AND THE BOUNCE COMES FROM UNDERNEATH. Every emitter down here is on
         *   or near the floor — the fungi are placed low "where you would find
         *   them", the water is on the floor, and a shaft's pool is the floor —
         *   so the light bouncing around a chamber arrives from below, and a
         *   ceiling is the brightest ambient surface in it rather than the
         *   darkest. It is worth two ALU on its own for that; what it is HERE for
         *   is that it dots the perturbed normal, so relief survives on a surface
         *   with no light on it at all. Mean 1.0 over a sphere, again by
         *   construction.
         */
        /**
         * AND IT IS MODULATED BY THE ALBEDO'S LEVEL WITHOUT TAKING THE ALBEDO'S
         * HUE, WHICH IS THE ACTUAL FIX FOR THE PALE SMOOTH BLOCKS.
         *
         * Measured, because three plausible fixes missed first. grain over one
         * breakdown slab's face spans 0.52 to 0.67, not 0.05 to 0.95 — a value
         * noise's LOCAL range is a fraction of its global one, so every
         * grain-driven multiply above is worth six to fifteen per cent across an
         * object even though it is worth a factor of two across the cave. Dumping
         * vec3(grain, fine, micro) to the framebuffer showed all three varying
         * strongly and the shipped frame showed a slab flat to within 3/255. The
         * fragment relief was never what made the wall look like rock; what does
         * that is vLit and vRock varying across it, and a prop in a hall has
         * neither — vLit because nothing reaches it, vRock because the ambient,
         * which is most of its pixels, never carried albedo at all.
         *
         * uAmbient's own note explains why it is a COLOUR and not a fraction of
         * the albedo: 0.028 of the rock's brown is a darker brown and a hundred
         * metres of it is the failure the whole lighting pass exists to undo.
         * That argument is about HUE. Bounced light is still reflected light, so
         * carrying the albedo's LEVEL is not merely allowed, it is the correct
         * thing — and the level is where the variation lives, because mottle
         * is +/-0.09 on a rock that averages 0.135 and is baked at 0.7 m, which
         * is fine enough that the four corners of a slab's face disagree.
         *
         * 0.45 + 4.0 * lum has mean 0.99 at the measured mean albedo and spans
         * 0.65 to 1.45 over the range the bake actually produces. The cave's
         * average exposure does not move; a block gets its own form back.
         */
        float rockLum = dot(vRock, vec3(0.3333));
        /**
         * …AND ALL OF THE SURFACE DETAIL FADES OUT WITH DISTANCE, WHICH IS THE
         * MIP-MAP THIS NOISE DOES NOT HAVE.
         *
         * rrNoise is a single trilinear fetch of a 3D texture with no mip chain,
         * so a 4.2 cycle-per-metre band on a wall forty metres away is being
         * point-sampled at well under one texel per pixel. Standing still that is
         * only a grainy wall; moving, it crawls, and a fifty-metre chamber is
         * mostly wall at that distance. The old weights were small enough to hide
         * it; these are not, so the fade is not optional.
         *
         * It is also correct rather than merely safe. Micro-relief is what you
         * can resolve, and you cannot resolve a two-centimetre pit at forty
         * metres — what a far wall shows is its SHAPE and its light, which is
         * exactly what is left when this goes to 1.0. Three ALU, no fetch, and it
         * is the same argument the near-field term makes about dark adaptation
         * one screen up.
         */
        float mdist = 1.0 - 0.62 * smoothstep(9.0, 38.0, dist);
        float micro = 1.0 + ((0.46 + 0.80 * grain) * (0.55 + 0.90 * fine) * 1.16 - 1.0) * mdist;
        vec3 col = uAmbient * (0.30 + 0.70 * ao) * micro * (1.0 - 0.42 * n.y)
                 * (0.45 + 4.0 * rockLum);
        col += vRock * near * 0.72 * (0.35 + 0.65 * ao);
        col += vLit * ndl * (0.62 + 0.5 * grain) * (0.25 + 0.75 * ao);
        col += uDay * vDay * uDayGain;
        col *= 0.78 + grain * 0.42;
        // …and the fine octave as a light mottle, narrow, so it reads as the
        // surface being broken rather than as a second coat of the first one.
        col *= 0.82 + fine * 0.36;
        /**
         * …AND THE BEDDING, WHICH IS THE ONE BAND WITH FULL LOCAL CONTRAST.
         *
         * It was only ever in the near-field term, i.e. only within three metres
         * of the eye. That is the wrong place for it for the reason the whole of
         * this pass is about: bed is a SINE at 2.2 radians a metre, so its
         * period is 35 cm and it completes six cycles across a breakdown slab's
         * face — it is the only term in this shader whose range over one object
         * is its range over the cave, and it was being spent on the two metres of
         * wall where there was already plenty to look at.
         *
         * Strata on fallen rock is also just correct. A block came off a bedded
         * ceiling and broke along and across the beds; the lines on it are the
         * single most recognisable thing about limestone breakdown, and the props
         * had none.
         *
         * Kept to +/-18% and centred on 1.0. It is a fifth of what the two noise
         * octaves are worth put together, because a stripe is a strong percept:
         * at 0.30 the floor of a passage read as corduroy.
         */
        col *= 1.0 + (bed - 0.5) * 0.36 * mdist;

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
          /**
           * 1 IS A STREAM AND 2 IS A LAKE, and everything after this line reads
           * that one number. See the wetTag block in _emitWater.
           *
           * A stream is a ribbon a metre wide with a current in it; a still pool
           * is the only surface in this world that is a MIRROR, and the two want
           * opposite tunings of the same four terms. Sharing the branch costs one
           * step() and keeps water in the rock's own draw, which is the whole
           * reason it lives in this material at all.
           */
          float still = step(1.5, vWet);
          /**
           * Standing water has ripples an order of magnitude smaller and slower
           * than running water — what disturbs it is drips off a ceiling forty
           * metres up, not a gradient — and the ripple amplitude IS the mirror's
           * blur radius. At the stream's 0.07 the reflection of a beam breaks up
           * within a couple of metres of its foot, which is exactly the length
           * over which it has to hold together to double the room.
           */
          float rip = mix(1.0, 0.22, still);
          float wsp = mix(1.0, 0.35, still);
          float wx = vWorld.x * 3.3 + uTime * 0.5 * wsp;
          float wz = vWorld.z * 2.7 - uTime * 0.38 * wsp;
          vec3 wn = normalize(vec3((cos(wx) * 0.07 + cos(wz * 0.7) * 0.03) * rip, 1.0,
                                   (cos(wz) * 0.06 + cos(wx * 0.6) * 0.03) * rip));
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
          /**
           * A REFLECTION THAT IS A COLUMN AND NOT A BLOB, WHICH IS THE ONE
           * THING THAT MAKES A POOL DOUBLE THE HEIGHT OF A ROOM.
           *
           * There IS a light direction in this shader now — vGlow's mean, the
           * same one the rock's N.L uses — so the water can finally reflect
           * something instead of only being fresnel-bright at the edges. The
           * naive version, pow(dot(reflect(-v, wn), ldir), n), is a round
           * highlight, and a round highlight on water reads as a lamp lying on
           * the floor: what everybody has actually seen is a narrow streak
           * running from the light TOWARD them, several times as long as it is
           * wide.
           *
           * The streak is anisotropy and it is free here. Squashing the Y of
           * both vectors before the dot makes the lobe tolerant of a mismatch
           * in ELEVATION and as tight as ever in AZIMUTH — so a crystal seam
           * four metres up the far wall smears down the pool toward the eye,
           * and moving your head sideways moves the streak sideways. 0.28 is
           * roughly the aspect of a real one; at 1.0 it is the blob, and below
           * about 0.15 the streak runs the whole length of the pool and reads
           * as a painted stripe.
           *
           * BOUNDED, for the reason the block above this one is about: it is
           * added to a sheen that already reaches 1.6, and vLit in a crystal
           * seam is not small.
           */
          /**
           * ON A LAKE THE LOBE IS TALLER AND TIGHTER, WHICH IS THE COLUMN.
           *
           * The elevation squash goes from 0.28 to 0.14 and the exponent from 22
           * to 46: narrower across, twice as tolerant up and down, which is a
           * streak roughly four times as long as it is wide instead of two. That
           * is the shape of a beam reflected in water and it is the whole of what
           * this term is for — a shaft is seated within a third of the half-width
           * of the axis (see _seatShaft) and the terminal pool is centred on
           * the axis, so on a hall the beam's foot is very nearly always ON the
           * pool and ldir at the water's surface points straight at it.
           */
          float aniso = mix(0.28, 0.14, still);
          vec3 rv = reflect(-v, wn);
          float mirror = pow(
            max(dot(normalize(vec3(rv.x, rv.y * aniso, rv.z)),
                    normalize(vec3(ldir.x, ldir.y * aniso, ldir.z))), 0.0),
            mix(22.0, 46.0, still)
          ) * coh;
          vec3 water = vRock * 0.05
                     + vLit * (sheen + min(2.2, mirror * mix(3.4, 5.2, still)))
                     /**
                      * …and the air above it. A pool at a grazing angle is
                      * showing you the far haze, which by uHaze's own note is
                      * the brightest thing in the frame — so the far end of a
                      * flooded chamber is a pale blue plate and the near end is
                      * black, which is the same depth gradient the fog draws on
                      * the walls, drawn again upside down. That doubling is the
                      * cheapest height a chamber can be given.
                      */
                     /**
                      * AND THE LAKE GETS MORE OF THE AIR, WHICH IS THE HONEST
                      * ANSWER TO "WHY IS THERE NO REAL REFLECTION IN IT".
                      *
                      * There is not, and the option was open — this pass owns
                      * _emitWater, so the pool could have been lifted out of
                      * the rock's mesh into a transparent pass that does not
                      * write depth, and a mirrored beam drawn under it. It was
                      * priced and declined, and the price is the point:
                      *
                      *   A MIRRORED CONE IS NOT A REFLECTION, IT IS ONE OBJECT.
                      *   Inverting the four beams under the floor doubles the
                      *   brightest thing in the room and nothing else — not the
                      *   ceiling, not the blocks standing in the water, not the
                      *   far wall — so the pool would show a beam floating on a
                      *   surface reflecting nothing else, which reads as a
                      *   decal. What the reference doubles is the ROOM.
                      *
                      *   AND DOING IT PROPERLY IS A SECOND RENDER OF THE CAVE.
                      *   A planar pass needs a mirrored camera, a clip plane, a
                      *   render target and a second material variant, and the
                      *   underground frame is 0.70 ms of which the rock is most
                      *   — so it is very nearly a doubling of the cheapest frame
                      *   in the game, for one surface, in one chamber. That is
                      *   affordable and it is a one-way door: it puts a render
                      *   target and a quality gate into a feature whose whole
                      *   design is "one draw, nothing per frame".
                      *
                      *   AND IT WOULD COST THE POOL ITS LIGHT. The water is in
                      *   the rock's mesh because that is how it gets aLit and
                      *   aGlow — the same baked irradiance and the same mean
                      *   direction the wall beside it has. A separate transparent
                      *   pass either re-bakes them or loses them, and the streak
                      *   below is built out of exactly those two.
                      *
                      * So the doubling is done with the two things that are
                      * already free: the anisotropic streak, which IS the beam
                      * reflected, and this — the far haze, which by uHaze's own
                      * note is the brightest thing in the frame, so a still
                      * surface seen across a chamber is a pale blue plate lying
                      * where the floor should be and reading as depth. 2.6 on a
                      * lake against 1.9 on a stream: a stream is a metre wide and
                      * is never seen at the angles that matter, a lake is thirty
                      * and is mostly seen at nothing else.
                      */
                     + uHaze * fres * mix(1.9, 2.6, still)
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

        /**
         * THREE DEPTHS, NOT TWO. See uHaze.
         *
         * The density curve is untouched — it is composed by atmosphere.js out
         * of four opinions and this material is only ever told the answer — but
         * the colour it converges ON now moves with distance. Near-black for the
         * first fifteen metres, so the foreground stays the near-black ledge the
         * reference opens with; lifting through the twenties and thirties; fully
         * into the blue by fifty, which is past where the density has closed
         * anyway, so the far wall of a big chamber is a flat blue silhouette
         * plate and everything in front of it is darker than it is.
         *
         * That ordering is the whole trick and it is the reverse of what a fog
         * normally does in this project: outdoors the haze is DARKER than the
         * sunlit thing it is fogging. Underground there is nothing bright to fog
         * out, so the only way distance can read at all is if the air itself is
         * the brightest thing in the frame.
         *
         * smoothstep and not a second exp: the curve has to be flat for the
         * first ten metres or the rock at your feet picks up the blue, and an
         * exponential is steepest exactly there.
         */
        vec3 haze = mix(fogColor, uHaze, smoothstep(14.0, 52.0, vDepthFog));
        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vDepthFog * vDepthFog);
        col = mix(col, haze, clamp(fogFactor, 0.0, 1.0));

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
/*  light in the air                                                          */
/* -------------------------------------------------------------------------- */

/**
 * ==== A SHAFT, UNDERGROUND, AND WHY THERE WAS NOT ONE =======================
 *
 * Everything this file lights is a SURFACE. The fungi are baked into vertex
 * colours, the crystals are emissive facets, the near-field term is a function
 * of the distance to a wall — so a cave could be full of light and the AIR in it
 * was still perfectly empty. That is fine in a passage three metres across,
 * where there is no air to speak of between you and the rock. It is the whole
 * failure in a chamber, because the only thing that tells you a room is twenty
 * metres tall rather than four is that you can see the light crossing it.
 *
 * The forest has had this since the beginning (`buildShafts` in atmosphere.js)
 * and it is force-hidden past CAVE_BURIED — correctly, since those are shafts of
 * SUNLIGHT through a canopy and there is no canopy down here. This is the same
 * technique with three things changed, and the technique itself is worth reading
 * that file's comments for: an additive open cone standing in for a volume, an
 * |N·V| silhouette fade so it has no outline, and a NEAR fade so that walking
 * into one is not the milky-gel-over-the-lens percept the whole project refuses.
 *
 * WHAT IS DIFFERENT HERE, AND EACH OF THE THREE IS FORCED BY THE CEILING:
 *
 *   THE BRIGHT END IS AT THE TOP AND IT DOES NOT TOUCH THE ROOF. A forest shaft
 *   fades out over its top and is brightest low down, because what it runs into
 *   above is a canopy that hides the join. A cave roof is opaque, single-sided
 *   and RIGHT THERE, so a cone that reached it would draw the hard polygon
 *   intersection atmosphere.js has three paragraphs about. So the cone stops
 *   about a tenth of the room's height below the ceiling and fades over its top
 *   eighth — the beam simply begins in mid-air, which is also the honest reading
 *   of the reference, where the opening the light comes through is never shown.
 *
 *   THE PEAK IS HIGH AND THE FOOT IS NEARLY GONE. `along` plateaus between 55%
 *   and 88% of the height. That is the reference's first and most important
 *   property — the brightest thing in the frame is far away and above you, and
 *   the near ground is nearly black — and it is also the fix for the cone
 *   cutting the floor, which is the same problem the roof has upside down.
 *
 *   IT IS A CAVE FIXTURE, NOT A WEATHER FIXTURE. The forest lattice is a field
 *   of shafts placed on world cells and re-pointed at the sun every frame. There
 *   are at most four of these in a cave, they are placed by QUERYING the built
 *   path for rings that are actually in a big chamber, and they never move. So
 *   they are one static merged mesh per cave in one draw, built once, with no
 *   per-frame CPU at all — the same bargain `_buildFungi` strikes.
 *
 * COST. It is fill, and fill is the only thing that costs in this project, so
 * the geometry is deliberately tiny (14 segments, 28 triangles a beam) and the
 * near fade is doing double duty: a cone at 2 m covers hundreds of times the
 * pixels of the same cone at 40 m, so fading the first few metres out deletes
 * the most expensive fragments the feature can generate. Measured in
 * `cave-perf` and reported with this pass.
 */
const SHAFT_TOP = 0xbfe6ff;
const SHAFT_LOW = 0x4a63d8;
/**
 * The pale blue the shaft's FOOT bakes into the rock, and it is not the same
 * colour as the beam.
 *
 * A beam of light you cannot see landing on anything is a decal. The two lights
 * `_seatShaft` pushes into `this.lights` are what make the floor under a shaft
 * a pool and the wall beside it faintly lit, and they cost nothing per frame
 * because they go through the same bake every fungus does. Slightly duller and
 * less blue than SHAFT_TOP, because what you are looking at there is limestone
 * reflecting the beam rather than the beam itself, and the rock takes a bite
 * out of the blue on the way back — the same argument `_shade` makes for
 * multiplying the albedo into the baked irradiance in the first place.
 */
const SHAFT_LIGHT = new THREE.Color(0x8fc4ee);

/**
 * How big a chamber has to be before it gets one, AS A QUERY AND NOT A LIST.
 *
 * Nothing here knows where the chambers are. It walks the finished path and
 * asks each ring how wide and how tall it is, which means the beams follow
 * whatever `SHAPES` and the walk currently produce — including changes to them
 * made after this was written. Hard-coding "the room at ring 140" would have
 * been half the code and would break the first time anybody retuned a shape.
 *
 * The two thresholds are set against the shape table rather than by eye. At
 * 4.6 m of half-width and 7 m of head, `room` (w 1.42, t+f 1.80, r 6.5-11)
 * clears both by a factor of two on its narrowest day; `keyhole`, the next
 * biggest thing in the table, tops out at 4.5 m of half-width and is excluded
 * by a tenth of a metre, which is deliberate — a keyhole is tall, and a beam in
 * one would read as a lit corridor rather than as a room. `tube` and `bedding`
 * fail on head. So this selects exactly the chambers and nothing else, and
 * there is roughly a metre of slack in both directions if the shapes move.
 */
const SHAFT_HALF = 4.6;
const SHAFT_HEAD = 7.0;
/** Rings of chamber before it counts. Six is about four metres of room. */
const SHAFT_RUN = 6;
/** …and rings of nothing after one, so two beams are never in the same view. */
const SHAFT_GAP = 30;
/**
 * A DENSITY, NOT A COUNT, AND THAT DISTINCTION COST THE FIRST BUILD.
 *
 * A passage with a beam in every chamber has no beams in it, in the same sense
 * CRYSTAL_REACH's note means: the thing being bought is the moment you come
 * round a corner and there is light standing in the room, and that moment is
 * spent by the second one. So the first version of this was a flat cap of four,
 * chosen against the two-hundred-metre passages this file's comments were
 * written for.
 *
 * The cave being edited alongside it is six hundred and forty-seven metres and
 * nine hundred rings. Four beams over that is one every hundred and sixty
 * metres, all four of them in the first third because the walk finds its
 * chambers in path order and then stops — and a twelve-stop tour of it went
 * past none of them. A constant that means "this many per cave" silently means
 * "this dense" and stops meaning it the moment somebody changes the length,
 * which is the same class of mistake as `placeFungi`'s spacing quietly halving
 * when the ring step did.
 *
 * One per hundred and twenty metres, floor of two, ceiling of eight. The
 * ceiling is the scarcity argument above; the floor is so a short passage that
 * happens to have one chamber still gets its beam.
 */
const SHAFT_PER_M = 1 / 120;
const SHAFT_MIN = 2;
const SHAFT_MAX = 8;
/**
 * Not in the daylight, for the third time in this file — see FUNGUS_REACH's
 * distance from the mouth and `placeCrystals`'s `from`. Twenty-four rings is
 * about seventeen metres, which is where `_daylight` has fallen to 0.12 of its
 * value at the door.
 */
const SHAFT_FROM = 24;
/** Metres the foot's pool of light carries. About one chamber. */
const SHAFT_REACH = 17;

/* -------------------------------------------------------------------------- *
 *  A ROOM YOU CANNOT SEE THE SIZE OF IS NOT A BIG ROOM
 * -------------------------------------------------------------------------- *
 *
 * Every reach in this file was fitted against a passage four to six metres
 * across, and every one of them is a CONSTANT: FUNGUS_REACH 13 m, CRYSTAL_REACH
 * 20 m, SHAFT_REACH 17 m. The walk now produces terminal chambers measuring
 * 24-27 m of half-width and 47-58 m from the blocks to the roof, which means
 * that in the biggest room in the world NOT ONE EMITTER REACHES THE FAR WALL,
 * the ceiling, or in most cases the next block along. The geometry is there; the
 * measured result is a frame in which nothing has an edge, because every surface
 * in it converges on the same fog plate. Tour stop 11 of `.shots/tour-scale` is
 * that frame.
 *
 * The fix is not "more light". It is that a reach is a RATIO to the room, and
 * always was — the arguments in the two blocks above are both about contrast
 * inside one gallery, and both are correct, and neither says anything about what
 * happens when the gallery is five times wider than the number they were fitted
 * to. In a four-metre passage a thirteen-metre cluster lights the wall opposite
 * and forty metres of passage beyond it stay dark, which is the whole design. In
 * a twenty-four-metre hall the same cluster does not reach the opposite wall at
 * all, so there is no contrast to spend: it is all dark.
 *
 * So every reach is multiplied by `roomGain` below, which is exactly 1.0 for
 * anything the old constants were fitted against and rises only where the rock
 * gave the walk a chamber. Corridors are bit-identical — `clamp01` of a negative
 * number is zero and `1 + 0 * k` is one — which is the property that makes this
 * safe to do to numbers three other blocks of comments are about.
 *
 * The knee is at 6 m of half-width, which is a `room` on its narrowest day and
 * wider than anything else in SHAPES can produce; it saturates at 20 m, which is
 * `hall`'s own `hi`. 2.1x at the top puts a wall cluster's reach at 27 m against
 * a 24 m half-width — the far wall, and no further.
 */
const ROOM_KNEE = 6;
const ROOM_FULL = 20;
function roomGain(half, k) {
  return 1 + clamp01((half - ROOM_KNEE) / (ROOM_FULL - ROOM_KNEE)) * k;
}
/**
 * Half-width, in metres, at which a chamber stops being a room and starts
 * needing its own lighting plan rather than one cone.
 *
 * `hall`'s `lo` is 8.5 m of RADIUS, which at w = 1.35 is 11.5 m of half-width,
 * and HALL_MIN holds the walk to 9.5 m of radius before it will build one at
 * all — so 12 m is "the walk actually built a hall here", expressed in the
 * quantity `_planShafts` already measures. Below it a chamber gets exactly what
 * it got before this pass: one beam, two lights, and the fungi that happened to
 * land in it.
 */
const HALL_HALF = 12;
/**
 * How much light a great hall gets, and the unit is VOLUME rather than count.
 *
 * A 24 m x 50 m chamber is about forty times the volume of the 6 m room the
 * single-cone version was written for, and the honest reading of "one beam is
 * enough" at that size is a torch in a cathedral — which is the phrase already
 * in `_seatShaft` about the beam's RADIUS, arrived at again one level up. The
 * count is the cube root of the volume ratio so that it grows the way the eye's
 * sense of scale does and not the way the numbers do: 12 m of half-width gets
 * one, 18 m gets two, 26 m gets three. Capped at three because a fourth cone in
 * one room is a light rig.
 */
const HALL_BEAMS_MAX = 3;
/**
 * …and the bounce, which is what actually makes the far wall exist.
 *
 * A beam is a volume of lit air. It is not a light source in `this.lights` —
 * only its foot and its mid-point are — so a hall with three cones in it still
 * has three small pools on a floor the size of a car park. What a shaft landing
 * on rock really does is turn that patch of floor into an area source pointing
 * at everything else in the room, and an area source is what a ring of baked
 * points is a cheap stand-in for. They are free per frame for the reason the top
 * of this file gives; they cost O(vertices) once, at build, and a hall is where
 * that budget should go because it is the one place in the cave where the
 * existing sources have all fallen short.
 */
const HALL_BOUNCE = 4;

/**
 * The unit cone, built once for every cave in the world.
 *
 * NON-INDEXED, because `_buildShafts` merges four transformed copies of it into
 * one buffer and an index would have to be rebuilt with an offset per copy for
 * 28 triangles' worth of saving. The taper is baked at 0.34 — narrow at +Y,
 * which is the end that points at the ceiling — so a beam's shape is a
 * non-uniform scale of this and nothing else.
 */
let sharedShaftGeo = null;
function shaftUnit() {
  if (sharedShaftGeo) return sharedShaftGeo;
  const g = new THREE.CylinderGeometry(0.34, 1, 1, 14, 1, true).toNonIndexed();
  g.translate(0, 0.5, 0);
  sharedShaftGeo = g;
  return g;
}

function shaftMaterial() {
  return new THREE.ShaderMaterial({
    name: 'cave-shaft',
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    /**
     * ONE DRAW, NOT TWO, and the argument is atmosphere.js's verbatim: three
     * splits a transparent DoubleSide material into a back pass and a front
     * pass with `needsUpdate = true` set BETWEEN them, which is a full program
     * rebuild twice per object per frame. It is safe to refuse here for the
     * same reason it is safe there — the blending is additive, addition is
     * commutative, and a cone's two walls sum to the same number either way.
     */
    forceSinglePass: true,
    uniforms: {
      uTime: tripUniforms.uTime,
      uLevel: tripUniforms.uLevel,
      uAudio: tripUniforms.uAudio,
      uTop: { value: new THREE.Color(SHAFT_TOP) },
      uLow: { value: new THREE.Color(SHAFT_LOW) },
      /**
       * (nearOut, nearIn, farIn, farOut) in metres, and the near pair is the
       * one that matters — see the header. It is tighter than the forest's
       * 5/18 because a cave beam is a third of the width and you are meant to
       * be able to get close enough to stand in the pool at its foot.
       */
      uReach: { value: new THREE.Vector4(1.6, 7.0, 44, 88) },
      uStrength: { value: 1 },
      /**
       * FLOORED AT A THIRD RATHER THAN GATED TO ZERO.
       *
       * These are lit from a hole in a mountain, so at midnight the honest
       * answer is that they should be gone — which is what atmosphere.js does
       * with `uDaylight` for the forest shafts, and it is right there because
       * twenty-five warm cones standing in a wood at 2 a.m. is absurd. Down
       * here it deletes the centrepiece of the feature for half the day cycle
       * and leaves a chamber that is measurably worse than the one before this
       * pass. A third, cold, reads as moonlight down the same hole, which is a
       * thing that happens and is the better of the two wrong answers.
       */
      uDaylight: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute vec2 aBeam;
      varying vec2 vUvS;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec2 vBeam;
      void main() {
        vUvS = uv;
        vBeam = aBeam;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPos = world.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uLevel;
      uniform vec4 uAudio;
      uniform vec3 uTop;
      uniform vec3 uLow;
      uniform vec4 uReach;
      uniform float uStrength;
      uniform float uDaylight;
      varying vec2 vUvS;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec2 vBeam;
      void main() {
        float v = vUvS.y;
        /**
         * THE PLATEAU IS HIGH. See the header block: 0 at the floor, full by
         * 55% of the way up, held to 88%, gone by the top. The bottom ramp is
         * long so that whatever the cone crosses on the way down — a breakdown
         * block, a spire, the floor itself — it crosses faint, which is the
         * only cheap defence against a shell drawing a hard silhouette against
         * geometry it intersects. The top ramp is short because there is
         * nothing up there to intersect: the cone is seated clear of the roof.
         */
        float along = smoothstep(0.0, 0.55, v) * smoothstep(1.0, 0.88, v);

        vec3 toEye = cameraPosition - vWorldPos;
        float dist = length(toEye);
        /**
         * |N·V| squared, and the exponent is above one on purpose. A shell
         * standing in for a volume should be as bright as the volume is THICK
         * along the view ray, and the whole of why the exponent must not go
         * below one is in atmosphere.js's note on the same line: at the
         * silhouette the normal swings through ninety degrees inside a handful
         * of pixels, so a falloff written below one spends all of itself in
         * those pixels and draws a hard straight edge.
         */
        float facing = abs(dot(normalize(vWorldNormal), toEye / max(dist, 1e-4)));
        float radial = facing * facing;
        float reach = smoothstep(uReach.x, uReach.y, dist) * (1.0 - smoothstep(uReach.z, uReach.w, dist));
        if (reach <= 0.0) discard;

        /**
         * Dust, as two incommensurate world-space sines rather than a noise
         * fetch. This material covers a lot of screen when you are near a beam
         * and it is additive, so it is exactly the surface where a texture
         * fetch is least affordable — the same budget argument the rock's five
         * fetches are justified against, on the other side of the ledger.
         * Seeded per beam so four of them do not breathe in unison.
         */
        float s = vBeam.x * 37.0;
        float dust = 0.74 + 0.26
          * sin(vWorldPos.y * 0.85 + uTime * 0.13 + s)
          * cos(vWorldPos.x * 0.66 - vWorldPos.z * 0.52 + uTime * 0.09 + s * 1.7);

        /**
         * THE AMPLITUDE, AGAINST A BRIGHT PASS AT 0.85 WITH A 0.55 KNEE.
         *
         * 0.40 through one wall of the cone and 0.80 down the middle, where you
         * see both — so the core of a beam is just under the threshold and the
         * body of it is inside the knee, which opens from about 0.30. That is a
         * beam with a glow ON it rather than a beam made of glow, which is the
         * same place atmosphere.js parked the forest shafts and for the same
         * stated reason.
         *
         * IT IS HIGHER THAN THE FOREST'S 0.22 AND THE FIRST TRY AT 0.30 WAS
         * STILL TOO LOW. A shaft in a wood is seen against sunlit leaf, so a
         * small addition is a large ratio; a shaft in a cave is seen against
         * fog at 0.02, where the eye is reading the ABSOLUTE level because
         * there is nothing else in the frame to scale it against. At 0.30 the
         * beam in the 23 m chamber at the end of the tour came out as a grey
         * smudge on a black ceiling — present in the shot, and not present in
         * the picture.
         *
         * The trip's share is small and the ceiling is hard. The director
         * multiplies uStrength by up to 2.7 at a surge and every previous
         * attempt at a volumetric in this project has died at the same place —
         * a single shell past about 0.8 additive is a flat white slab with a
         * clipped edge. min() rather than a knee, so the sober frame is
         * untouched by the protection.
         */
        float a = along * radial * reach * dust * vBeam.y * uStrength * uDaylight
                * (0.40 + uLevel * 0.05 + uAudio.x * 0.05);
        a = min(a, 0.66);
        /**
         * Cyan-white where it comes in, blue-violet where it dies out in the
         * dust — the reference's key light landing in the reference's indigo.
         * The gradient is the same idea as the forest's warm-to-green one and
         * it runs the right way round by construction: the geometry's narrow
         * end is at v = 1 and that is the end pointed at the ceiling.
         */
        vec3 col = mix(uLow, uTop, smoothstep(0.12, 0.86, v));
        gl_FragColor = vec4(col * a, a);
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
 * arriving unannounced while somebody is walking is a drop.
 *
 * There is no worker, deliberately. A worker would need this module's realm to
 * be told the world seed and to keep it in step with the main thread's — the
 * trap `ground.js` and `terrain-worker.js` each spend a screen of comment on,
 * whose failure mode is silent and looks like a different bug. Slicing gets the
 * same frame profile for none of that risk, because unlike a ground chunk
 * nothing is waiting on the result: the build is armed at BUILD_RANGE, which is
 * half a minute of sprinting from the mouth.
 *
 *
 * IT WAS `RINGS_PER_FRAME = 22`, AND A RING COUNT CANNOT BOUND A FRAME.
 *
 * That number was tuned against a 200 m passage and it held the emit to "well
 * under a millisecond" at the time. Then the passages went to 500-700 m, the
 * sections to 24-27 m half-width, and the extras with them — and 22 rings of a
 * hall is not 22 rings of a tube, because a ring's cost is its 44 vertices times
 * the length of the light list, and both ends of that grew. Measured on nine
 * grove-01 caves at RINGS_PER_FRAME = 22: median slice 1.0-1.2 ms, which is a
 * quarter of the whole frame budget and no longer "well under" anything.
 *
 * That is the same fault this file has now recorded three times — GOOD_RINGS
 * below, HOOD_MIN above, the light spacing — a quantity that is really a
 * duration or a distance, written as a count of rings, and silently revalued the
 * next time anything about a ring changed. The cure is the same one: say what
 * you actually mean.
 *
 * WHAT 0.6 ms MEANS. The frame in the open wood is 3.55-4.94 ms and underground
 * it is 1.00. A build slice is therefore about an eighth of the budget at its
 * worst, which is a number a player cannot see under any frame pacing: it never
 * turns a 4.9 ms frame into a missed 60 Hz deadline, and at 144 Hz it leaves
 * 1.4 ms of headroom. It is checked BETWEEN quanta, so a slice overruns by the
 * cost of whichever quantum it was in the middle of — that is why the yields
 * through the build are placed at a third of a millisecond's work rather than
 * per item, and why the measured worst slice is 0.9 ms rather than 0.6.
 *
 * IT IS A DEADLINE AND NOT AN ALLOWANCE, so a machine half as fast does half as
 * much work per frame and takes twice as many frames, instead of dropping the
 * same frame twice as hard. There is nowhere for that to go wrong: the build is
 * armed 320 m out, and even at a fifth of this machine's speed it lands with
 * thirty seconds to spare. See the arithmetic at BUILD_RANGE.
 *
 * AND THAT IS WHY THERE IS NO QUALITY SETTING FOR IT. A knob in `quality.js`
 * would say "spend less time per frame on a slow machine", and a millisecond
 * deadline already says exactly that, to the machine actually running rather
 * than to whichever preset the governor last chose. What a preset could
 * legitimately buy — a shorter passage, fewer props — is a change to the WORLD
 * and belongs nowhere near the scheduler; `.perf/presets.json` already records
 * that the whole ladder moves this project's triangle count by one per cent, so
 * a cave that was smaller on low would be the first thing in the game that
 * differed between two players standing in it.
 */
const BUILD_MS = 0.6;

/**
 * How far a passage has to reach before the re-walk in `prepare` stops looking
 * for a better one.
 *
 * IT WAS `STUB_RINGS = 40`, AND IT WAS A DISTANCE WRITTEN AS A RING COUNT THAT
 * HAD ALREADY DRIFTED. The comment on it said "forty is about thirty-eight
 * metres", which was true at a ring step of 0.95 and has been 28.8 m since the
 * mesh was sharpened to 0.72 — so the bar quietly dropped by a quarter, in the
 * one test whose whole job is to notice a passage that came out too short. It
 * is in metres over the step now, like everything else here that is a distance.
 *
 * The VALUE moved for a separate reason: see the block at the re-walk. 46 m was
 * "not a stub", which is the wrong question to stop on now that a walk can
 * propose six hundred; 190 m is "this is a cave", and asking for it costs 0.42
 * of an extra walk and buys a third more passage.
 */
const GOOD_RINGS = Math.round(190 / RING_STEP);

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
    /** The chambers big enough for light in the air. See `_planShafts`. */
    this.shafts = null;
    this.shaftMesh = null;
    this.group = new THREE.Group();
    this.group.name = `cave-${descriptor.k}`;
    this.ready = false;
    this._ring = 0;
    this._ex = 0;
    this._hood = 0;
    this._buffers = null;
    /** The attributes still to reach the GPU, and how far down them we are. */
    this._priming = null;
    /**
     * `prepared` IS THE GATE, AND `paths` USED TO BE, WHICH WAS A LATENT BUG.
     *
     * `_rescan` publishes the module-level `live` list — the one `caveSample`
     * walks — as every cave that has a `paths` array. That was a sound test for
     * exactly as long as `prepare` ran to completion inside one frame, because
     * then `paths` went from absent to fully built between two rescans and no
     * intermediate state was observable.
     *
     * It is not sound now, and it would not have been sound the moment anything
     * else made `prepare` re-entrant. `this.paths` is assigned at the BRANCHES
     * stage, which is a third of the way through: at that point the paths have
     * no `_bpad` bounding box, no `along`, no `obstacles` and no `obsAt`. A
     * rescan landing in that window — and it fires twice a second, so it lands
     * in that window most builds — would hand `caveSample` a path whose
     * bounding reject is `undefined` (so it is never rejected, and every frame
     * scans the whole passage) and whose `obsAt` is missing (so the obstacle
     * lookup indexes undefined). The player is 320 m away and cannot be inside
     * it, so what this actually produces is a wrong answer nobody is standing
     * in — until the day BUILD_RANGE shrinks or a cave streams in behind
     * somebody, and then it is a crash or a floor that is not there.
     *
     * One flag, written on the last line of `_prepare` and nowhere else, and
     * `live` is rebuilt the moment it turns true rather than at the next rescan.
     */
    this.prepared = false;
    /** The suspended plan, or null before it starts and after it finishes. */
    this._prep = null;
    /** The suspended close — indexing and mesh build. Same contract. */
    this._close = null;
    /**
     * What the last slice finished doing, by the name on the `yield` it stopped
     * at. One string assignment per slice, which is free, and it is the only
     * reason `scripts/perf/cave-build.mjs` can say WHICH stage produced the
     * worst frame instead of only how bad it was. Every fat quantum found while
     * this was being cut — the resample, the branch's clash test, the fungus
     * mesh — was found by reading this column.
     */
    this.stage = null;
  }

  /**
   * Everything the collision line needs, and nothing that touches the GPU.
   *
   * A generator: see the note over `buildNodes` for why, and `prepareSlice` for
   * what drives it. `prepare()` below still runs the whole thing in one go for
   * the callers that have no frame to spend.
   */
  *_prepare() {
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
     *
     * AND IT STOPS AT A CAVE, NOT AT NOT-A-STUB, WHICH IS WHERE IT WAS STOPPING.
     *
     * The early break was at 46 m, and once the walk learned to go deep that
     * became a bad bargain rather than a thrifty one. Measured over eight seeds
     * and twenty-four passages: the walk now proposes 880 rings on average and
     * the burial keeps 490 of them, but the SPREAD between salts is enormous —
     * the same mouth gives 204 rings on one salt and 776 on the next, because
     * the first corner decides which part of the ridge the whole passage spends
     * itself under. Breaking at the first result over 46 m took whatever the
     * first corner happened to be: mean 489 rings kept, worst 65.
     *
     * Breaking at 190 m instead costs 1.42 walks per cave rather than 1.00 —
     * about 4 ms on a `prepare` that is 20 — and gives mean 649 and worst 309.
     * Nearly a third more cave, and the worst case stops being a hole. That is
     * the best-value four milliseconds in this file.
     *
     * It is deliberately a good-enough bar and not a maximum: raising it to
     * 320 m buys another 80 rings for another 2.5 walks, which is paying a
     * hitch for a diminishing return on seeds whose mountain has already said
     * no. Three walks remains the hard cap; a slot where all three are short is
     * a slot whose ridge is genuinely small, and the honest answer there is a
     * short cave.
     */
    let walk = null;
    let best = null;
    let bestLen = -1;
    for (let salt = 0; salt < 3; salt++) {
      const w = yield* buildNodes(this.c, salt);
      const p = resample(w.nodes);
      yield 'resample';
      const hood = Math.max(1, exposedRings(p));
      yield* burySkylights(p, hood + HOOD_SEAM);
      if (p.x.length > bestLen) {
        bestLen = p.x.length;
        best = p;
        walk = w;
        this._hood = hood;
      }
      if (bestLen >= GOOD_RINGS) break;
    }
    this.path = best;
    this.path.base = -1;
    this.path.baseAlong = 0;
    /**
     * The depth channel, filled before anything is placed in the passage.
     *
     * See `markDepth` and CHANNELS. It has to be before `placeFungi` and before
     * every other placer, because they read it to decide what goes where — a
     * pass that ran afterwards would be correct in the data and useless to
     * everything that had already asked.
     */
    markDepth(this.path, this.path.y[0]);
    this.fungi = placeFungi(this.c, this.path, 'main', 14);
    yield 'fungi';
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
    yield 'along';

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
    /**
     * HOW MANY, AS A JUNCTION EVERY SO MANY METRES OF PASSAGE.
     *
     * It was `n > 90 ? 1 + rng*3 : n > 55 ? 1 : 0`, which is two ring-count
     * thresholds standing in for two distances (65 m and 40 m at the current
     * step, 86 and 52 at the one they were written for) and a count that stopped
     * scaling the moment a passage was longer than the second threshold. A
     * six-hundred-metre passage got the same one-to-three junctions a
     * seventy-metre one did, so the density of choice FELL as the cave got
     * bigger — the opposite of what a system should do.
     *
     * One junction per 95 m of passage, capped at five. The cap is not a
     * performance limit — each branch is a few hundred triangles on a mesh that
     * costs 0.6 ms — it is that a passage with a hole in the wall every forty
     * metres is a maze, and a maze is a different feature with a different set
     * of problems, chiefly that you cannot make one legible with fungi.
     */
    const metres = along[n - 1];
    const want = Math.min(5, Math.floor(metres / 95) + (brRng() < 0.5 ? 1 : 0));
    /**
     * …AND ONE OF THEM IS A REAL FORK.
     *
     * Never the first, which is the closest to the entrance and the one the
     * player is least invested in when they meet it, and never one so near the
     * end that there is no room left in the mountain to build it. Picking a
     * middle one means the major junction lands where the passage has already
     * committed to a direction and the player has already walked far enough that
     * turning back is a cost. See `buildBranch`.
     */
    const majorAt = want > 1 ? 1 + Math.floor(brRng() * Math.max(1, want - 1)) : 0;
    let cursor = BRANCH_MIN_RING + Math.floor(brRng() * 14);
    // Both in metres over the ring step: the gap to the end of the passage a
    // branch needs to be worth starting, and the gap between two junctions.
    const BRANCH_TAIL = Math.round(20 / RING_STEP);
    const BRANCH_GAP = Math.round(34 / RING_STEP);
    for (let b = 0; b < want && cursor < n - BRANCH_TAIL; b++) {
      const br = yield* buildBranch(this.c, this.path, walk.joints, cursor, `${b}`, b === majorAt);
      if (br) {
        br.baseAlong = along[cursor];
        // Measured from the MAIN mouth, so a lead off the deepest chamber in the
        // system reports as deep as the chamber it leaves. See `markDepth`.
        markDepth(br, this.path.y[0]);
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
      cursor += BRANCH_GAP + Math.floor(brRng() * BRANCH_GAP);
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
    yield 'boxes';

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
      yield 'blocks';
      const spires = placeSpires(this.c, path, tag);
      yield 'spires';
      const crystals = placeCrystals(this.c, path, tag, p === 0 ? 16 : 2);
      yield 'crystals';
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
      yield 'obstacles';
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
    /**
     * A REACH IS A RATIO TO THE ROOM. See the ROOM_KNEE block: every constant
     * below this line was fitted against a four-metre passage and every one of
     * them is unchanged there, to the bit, because `roomGain` is exactly 1 for
     * anything narrower than a `room`.
     *
     * The extra clusters go in FIRST so the query below sees the same list the
     * bake will — and so a spore, which takes its colour from the nearest light,
     * can find one in a chamber that previously had none within reach.
     */
    this._seedHallFungi();
    this.lights = [];
    for (const g of this.fungi) {
      const gain = roomGain(this._localHalf(g.x, g.y, g.z), 0.7);
      this.lights.push({
        x: g.x,
        y: g.y,
        z: g.z,
        colour: g.colour,
        /**
         * DIVIDED BY THE SAME GAIN, AND THIS LINE IS THE WHOLE DIFFERENCE
         * BETWEEN A LIT HALL AND A FLOODED ONE.
         *
         * The falloff is `(1 - d/R)^2 * P`, so widening R alone does not merely
         * extend the light — it raises it EVERYWHERE inside the old radius, and
         * by a great deal in the middle. Measured at ten metres with R going
         * 13 -> 22: (1 - 10/22)^2 is 0.30 against (1 - 10/13)^2 at 0.053, i.e.
         * five and a half times. The first build of this pass shipped without
         * the compensation and the terminal chamber came back as a milky teal
         * cavern with no darkness anywhere in it — the exact failure `uAmbient`,
         * the near-field term and CRYSTAL_REACH each have a paragraph about,
         * arriving through a fourth door.
         *
         * P * 13/R holds the value at four to six metres — where a cluster is
         * the light in the room — to within a few per cent of what it has always
         * been, and leaves the extra reach as what it should be: a thin wash on
         * rock that previously got nothing at all. At fifteen metres in a hall it
         * is 0.048 against a hard zero.
         *
         * A CLUSTER DOES NOT GET BRIGHTER WHEN ITS LIGHT CARRIES FURTHER. IT
         * GETS THINNER.
         */
        power: g.power / gain,
        reach: FUNGUS_REACH * gain,
      });
    }
    for (const cr of this.crystals) {
      const cx = cr.x + cr.dx * cr.len * 0.5;
      const cy = cr.y + cr.dy * cr.len * 0.5;
      const cz = cr.z + cr.dz * cr.len * 0.5;
      /**
       * Less gain than a fungus gets, and the difference is the argument at
       * CRYSTAL_REACH: twenty metres is "one gallery", and a seam that lit two
       * galleries was measured and rejected. A hall IS one gallery, so what this
       * buys is that the seam still reads as one room's worth of light when the
       * room is the big one — not that it reaches further into the passage
       * beyond, which it does not, because the passage beyond is narrow and the
       * gain there is 1.
       */
      const gain = roomGain(this._localHalf(cx, cy, cz), 0.45);
      this.lights.push({
        x: cx,
        y: cy,
        z: cz,
        colour: cr.colour,
        power: (cr.power * CRYSTAL_POWER) / gain,
        reach: CRYSTAL_REACH * gain,
      });
    }
    /**
     * …and the shafts, which push two lights each. HERE rather than in
     * `_finish`, because a beam's foot is a light like any other and `_shade`
     * only ever walks this list once: the pool of pale blue on the floor under
     * a shaft has to be in it before the bake starts or it does not exist.
     */
    this._planShafts();
    yield 'shafts';

    // Last, because a spore takes its colour from the nearest light and the
    // list has to be complete before one can be asked for.
    this.spores = [];
    for (let p = 0; p < this.paths.length; p++) {
      const tag = p === 0 ? 'main' : `br${p}`;
      for (const s of yield* placeSpores(this.c, this.paths[p], tag, this.lights)) {
        this.spores.push(s);
      }
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
    /**
     * EVERY ONE OF THESE GREW, BECAUSE EVERY ONE OF THESE SOLIDS WAS OPEN.
     *
     * The material is FrontSide and opaque, so a face an emitter never wrote is
     * not a subtle saving, it is a hole you look through the object with — and
     * on a lump of rock a hole reads as a razor edge and a view of whatever is
     * behind it. Five shapes were open: blocks had no bottom, mites, tites,
     * columns and crystals had no base cap (a column had neither end), and the
     * drapery was two zero-thickness sheets rather than a solid at all.
     */
    let exVerts = 0;
    let exIdx = 0;
    for (const _b of this.blocks) {
      // A leaning prism: one tall quad, one top wedge and one bottom wedge per
      // side, flat shaded. The bottom is buried and never seen — until the melt
      // translates the whole block, which it now does rigidly and can do by a
      // quarter of a metre.
      exVerts += BLOCK_SIDES * (4 + 3 + 3);
      exIdx += BLOCK_SIDES * (6 + 3 + 3);
    }
    for (const s of this.spires) {
      // Column: 2 bands x 8 facets x 4, plus a fan of 8 at each end.
      // Drape: DRAPE_PANELS x (front, back, sole, ridge) x 4, plus 2 end caps.
      // Spire: 8 facets x 2 quad bands (4 each) + 8 tip triangles (3 each),
      //        plus a fan of 8 closing the root.
      exVerts +=
        s.kind === 'column'
          ? 64 + 2 * 8 * 3
          : s.kind === 'drape'
            ? DRAPE_PANELS * 4 * 4 + 2 * 4
            : 8 * (4 + 4 + 3) + 8 * 3;
      exIdx +=
        s.kind === 'column'
          ? 96 + 2 * 8 * 3
          : s.kind === 'drape'
            ? DRAPE_PANELS * 4 * 6 + 2 * 6
            : 8 * (6 + 6 + 3) + 8 * 3;
    }
    for (const _cr of this.crystals) {
      // Six sides: a quad to the shoulder and a triangle to the point, plus a
      // fan of six closing the base.
      exVerts += 6 * (4 + 3 + 3);
      exIdx += 6 * (6 + 3 + 3);
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
      /**
       * The anchor of the body each vertex belongs to. See the aBody block in
       * `caveMaterial`. For every lattice vertex this is a copy of its own
       * position, which is what makes the wall's motion provably unchanged;
       * `_emitRing` writes it in the same statement that writes the position so
       * the two cannot drift apart.
       */
      body: new Float32Array(verts * 4),
      /** Where the light comes from, times how agreed the sources are, plus AO. */
      glow: new Float32Array(verts * 4),
      index: new Uint32Array((rows + hood + 1) * RADIAL * 6),
      exIndex: new Uint32Array(exIdx),
      /** Cursors: the lattice is fixed-stride, the extras are not. */
      vert: ringVerts,
      ex: 0,
      tri: 0,
    };
    /**
     * THE LAST LINE, AND IT HAS TO BE THE LAST LINE. See the note in the
     * constructor: this is what lets `caveSample` see the passage, and it is a
     * promise that every field the sampler reads has been written.
     */
    this.prepared = true;
  }

  /**
   * Advance the plan until `until`, and say whether it is done.
   *
   * The deadline is checked between yields rather than inside them, so a slice
   * always overruns by whatever the last quantum cost — that is the granularity
   * the yields are placed at and it is why they are placed as finely as they
   * are. Checking the clock is not free either: `performance.now()` at every
   * yield of a 900-ring burial is thousands of calls, which is still nothing
   * against the 0.01 ms a ring of `roofRoom` costs, so it is checked at every
   * one rather than every nth — a counter would be a second constant to keep in
   * step with the first.
   */
  prepareSlice(until = performance.now() + BUILD_MS) {
    if (this.prepared) return true;
    if (!this._prep) this._prep = this._prepare();
    for (;;) {
      const at = this._prep.next();
      if (at.done) {
        this._prep = null;
        this.stage = null;
        return true;
      }
      this.stage = at.value;
      if (performance.now() >= until) return false;
    }
  }

  /** The whole plan, now, for a caller with no frame to spend. See `drain`. */
  prepare() {
    if (this.prepared) return;
    if (!this._prep) this._prep = this._prepare();
    drain(this._prep);
    this._prep = null;
  }

  /**
   * Emit rings until the deadline. Returns true when the mesh is complete.
   *
   * The inner surface is emitted first, ring by ring, then the hood's outer
   * shell, then the rim that joins them. Keeping the hood at the END of the
   * buffer rather than interleaved is what lets both be a plain regular grid,
   * which is what makes the normals below a difference rather than a
   * face-averaging pass — see `heightGrid` in terrain.js for why an averaged
   * normal on a shared edge is worse than it looks.
   */
  step(until = performance.now() + BUILD_MS) {
    // The lattice is done and the mesh exists; what is left is the upload,
    // which is metered out one attribute per frame. See `_prime`.
    if (this._priming) {
      this.stage = 'prime';
      return this._prime();
    }

    const rows = this._rows;
    const hood = this._hood;
    const total = rows + hood + 1;

    this.stage = 'rings';
    while (this._ring < total) {
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
      if (performance.now() >= until) return false;
    }

    /**
     * Then the things standing on the floor and hanging from the roof.
     *
     * A block is 24 vertices against a ring's 24, but nearly all of a ring's
     * cost is the two fbm lookups and the fungus walk per vertex — an extra is
     * shaded from its host ring's numbers, so it is genuinely about a quarter of
     * the work. That ratio used to be spelled out as `budget -= 0.25` against a
     * ring's 1; against a clock it does not need to be stated at all, which is
     * the second thing the millisecond budget bought.
     */
    const items =
      this.blocks.length + this.spires.length + this.crystals.length + this.water.length;
    this.stage = 'extras';
    while (this._ex < items) {
      this._emitExtra(this._ex);
      this._ex++;
      if (performance.now() >= until) return false;
    }

    /**
     * AND THE CLOSE, WHICH WAS THE SECOND HITCH AND WAS NOT SLICED AT ALL.
     *
     * `_link` and `_finish` ran together on the frame the last extra was
     * emitted, and between them they are one pass over 60 000 quads and another
     * over 64 000 vertices. Measured on nine grove-01 caves before this: the
     * median build had one slice of 10.0 ms and the worst had one of 13.1 ms —
     * against 1.0-1.2 ms for every other slice in the same build. So the ring
     * budget was doing its job perfectly and the frame it was protecting was
     * being dropped nine slices later by the two functions that ran after it.
     *
     * It is the failure the comment over RINGS_PER_FRAME warns about, committed
     * inside the mechanism that comment describes: a slicing scheme only bounds
     * the work it actually covers, and nothing had ever measured the tail.
     */
    if (!this._close) this._close = this._closeOut(hood);
    for (;;) {
      const at = this._close.next();
      if (at.done) {
        this._close = null;
        break;
      }
      this.stage = at.value;
      if (performance.now() >= until) break;
    }
    /**
     * FALSE, not true: the mesh exists but is drawing nothing yet. The caller
     * has to put the group in the scene anyway — see `CaveField.update` — and
     * `_prime` is what eventually says the passage is whole.
     */
    return false;
  }

  /**
   * Index the lattice, then turn it into a mesh. One generator so the two share
   * a single deadline: they are one operation from the frame's point of view and
   * splitting them into two cursors would only give the driver two things to
   * remember.
   */
  *_closeOut(hood) {
    yield* this._link(hood);
    yield* this._finish();
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
      /**
       * A LATTICE VERTEX IS ITS OWN BODY, and that is not a placeholder — it is
       * the mechanism. `aBody` is what an extras vertex uses to ask about the
       * SOLID it belongs to instead of about its own facet; the tube is not a
       * collection of solids, it is one continuous surface, so the honest answer
       * for a wall vertex is "here". The shader's "position - aBody.xyz" is then
       * exactly zero and every branch collapses to the old code. Copied from
       * `position` rather than recomputed, so the two cannot drift.
       *
       * w is never read here: rrProp is exactly 0 for a self-anchored vertex and
       * the mix that would use it returns its first argument. Written as 1 so a
       * dump of the buffer cannot be misread as a body pinned in place.
       */
      const k4 = vi * 4;
      b.body[k4] = b.position[k];
      b.body[k4 + 1] = b.position[k + 1];
      b.body[k4 + 2] = b.position[k + 2];
      b.body[k4 + 3] = 1;
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
    /**
     * TWO PROJECTIONS, NOT ONE, AND THE SECOND ONE IS THE PROPS' HALF OF IT.
     *
     * `fbm2` and `noise2` are 2D, so both of these were one plane of noise read
     * at (x, z + ky) — which varies over the tube's wall beautifully, because a
     * swept ellipse never holds x and z still for long. A BREAKDOWN BLOCK'S FACE
     * does. A fracture face whose normal happens to lie near the x axis has a
     * constant first argument over its whole area, and a 2D noise with one
     * argument pinned is a 1D stripe: the block came out with a smooth vertical
     * gradient and nothing else, whichever way it was lit. Every flat-faced
     * solid in the cave — blocks, spires, the crystals' prisms — was reading a
     * degenerate slice of the field the wall reads properly.
     *
     * Averaging a second sample taken on a different pair of axes cannot be
     * degenerate on both at once, because the two planes share only a line. It
     * is one extra `noise2` and one extra `fbm2` per vertex at BUILD time and
     * nothing per frame; measured over the 120 452 vertices of grove-01 k=0 it
     * is inside the noise of the build timer.
     *
     * The weights are 0.62/0.38 rather than half and half so the wall — which
     * was never broken — keeps the field it was tuned against as the dominant
     * term, and the second projection is a correction rather than a repaint.
     */
    const vein = clamp01(
      (fbm2(x * 0.09, z * 0.09 + y * 0.14, 2) * 0.62 +
        fbm2(y * 0.105 + 5.7, x * 0.075 - z * 0.085, 2) * 0.38) *
        1.6 +
        0.5
    );
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
    // Same two projections, at the metre scale. See the block at `vein`.
    const mottle =
      (noise2(x * 1.4, z * 1.4 + y * 0.8) * 0.62 + noise2(y * 1.55 + 3.1, x * 1.15 - z * 1.3) * 0.38) * 0.09;
    cr = clamp01(cr + mottle);
    cg = clamp01(cg + mottle);
    cb = clamp01(cb + mottle);

    /**
     * DEEPER IS A DIFFERENT ROCK, AND THAT IS THE ONLY AXIS THE PALETTE VARIES
     * ALONG.
     *
     * The brief for this pass was an "uncontrollable thirst to go deeper", and
     * a thirst is not produced by a place being nice — it is produced by the
     * place two hundred metres in being visibly not the place at the door. Every
     * other colour decision down here is a function of the LOCAL cross-section
     * (see `open` below, and the flood line above), so a wide chamber at 40 m
     * and a wide chamber at 220 m were the same wide chamber.
     *
     * So the albedo walks: cold slate near the mouth, indigo-violet through the
     * middle, and a teal-green at the far end — the green-teal arch of the
     * reference, which is the one warm-ish cool in the picture and reads as
     * "there is something else beyond this". It rides on the same iron `vein`
     * so it is a change in the ROCK rather than a wash over it.
     *
     * MEASURED AS THE HORIZONTAL DISTANCE FROM THE MOUTH, not as `along`, and
     * that is a deliberate approximation rather than an oversight. `_shade`'s
     * signature is called from four emitters and two of them (the blocks and
     * the crystals) do not have a ring index to hand at the point they call it;
     * threading one through would touch code three other agents are inside
     * right now. The origin IS ring zero — `prepare` sets it — so hypot(x - ox,
     * z - oz) is the straight-line distance from the doorway, which for a
     * passage that wanders is 60-85% of the true distance along it. That is a
     * softer ramp than the honest one and nothing else keys off it, so the
     * error is a tuning constant, not a bug. The one case it gets wrong is a
     * passage that doubles back over itself, where the far end is a shade less
     * deep than it has earned.
     */
    const fromMouth = Math.hypot(x - this.originX, z - this.originZ);
    const deep = clamp01((fromMouth - 22) / 96);
    const far = clamp01((fromMouth - 105) / 90);
    cr = lerp(cr, cr * (0.86 - 0.24 * far), deep);
    cg = lerp(cg, cg * (0.80 + 0.34 * far), deep);
    cb = lerp(cb, cb * (1.16 - 0.10 * far), deep);

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
    /**
     * THE OBJECT THIS VERTEX IS PART OF, set by whichever emitter is running.
     *
     * `this._body` is the centroid of the solid currently being emitted, in
     * world coordinates; every face of one block, one spire, one crystal shares
     * it, which is what lets the shader treat them as one thing. See the aBody
     * block in `caveMaterial`.
     *
     * NULL MEANS "THIS IS NOT A SOLID", and there is exactly one caller that
     * says so: `_emitWater`. A stream is a flat sheet lying on the floor with no
     * inside and nothing to hold together, and giving a forty-metre run one
     * centroid would let the melt slide the whole river sideways. Falling back
     * to the vertex's own position puts it on the lattice's path — pinned by
     * `aSurf.w`, exactly as it was.
     */
    const bd = this._body;
    const kb = vi * 4;
    buf.body[kb] = (bd ? bd[0] : px) - this.originX;
    buf.body[kb + 1] = (bd ? bd[1] : py) - this.originY;
    buf.body[kb + 2] = (bd ? bd[2] : pz) - this.originZ;
    // How freely the melt may carry this solid. See MELT_FLOOR.
    buf.body[kb + 3] = bd ? this._meltFree : 1;
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
    /**
     * Cleared here rather than trusted to each emitter's exit path. `_body` is
     * what every vertex of the next object will be anchored to; an emitter that
     * returned early and left the previous object's centroid set would tie one
     * solid's vertices to another solid's middle, and what that looks like is a
     * boulder that flies across the room at the peak and holds still at rest —
     * i.e. it would only ever show up while tripping, which is the class of bug
     * this whole pass exists to remove.
     */
    this._body = null;
    this._meltFree = MELT_FLOOR;
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
     * The spike's own middle, and the anchor every vertex of it will carry.
     *
     * `mid` already IS that point — it is the "inside" reference `_face` uses to
     * derive its windings, at four tenths of the length because a tapered prism
     * has more mass at the root. Reusing it means the winding test and the trip
     * displacement are asking about the same middle, which is the only middle a
     * convex-ish solid has.
     *
     * A crystal grows OUT OF the wall, so it travels with the wall. See
     * MELT_FLOOR: a seam damped to a quarter would be left behind by the rock it
     * is embedded in and every spike in it would be floating by the peak.
     */
    this._body = mid;
    this._meltFree = MELT_ROCK;

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
    /**
     * The base ring's own centre, so the hexagon at t = 0 can be closed.
     *
     * IT WAS NOT, AND ON A FrontSide MATERIAL THAT IS A WINDOW. Every crystal
     * in the world was a tube with a point on one end and nothing on the other,
     * relying on the other end being inside the wall — which it was not, because
     * placement never knew where the wall was drawn (see `wallPush`). Look into
     * one from slightly off-axis and you see the inside of the far facets, lit
     * as emissive, with a razor-sharp rim: exactly the "I can see through some of
     * them" frame at 88 m.
     */
    const foot = [cr.x, cr.y, cr.z];
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES;
      this._face(base[i], base[j], neck[j], neck[i], mid, day, 0, 0, 99, 0, 0, span, 1);
      this._face(neck[i], neck[j], tip, null, mid, day, 0, 0, 99, 0, 0, span, 1);
      // …and one wedge of the base, fanned from the axis. Dark: this is the
      // face that is buried, and the one that shows if a spike is ever loose.
      this._face(foot, base[j], base[i], null, mid, day, 0, 0, 99, 0, 0, span, 0.25);
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
    /**
     * The slab's own middle. `inside` is already it — the point `_face` uses to
     * decide which way each face is wound — so the winding test and the trip
     * displacement are anchored to the same place by construction.
     *
     * A block lies ON the floor and has a collider, so it takes the floor's melt
     * factor: it must not slide out from under the thing the body climbs.
     */
    this._body = inside;
    this._meltFree = MELT_FLOOR;
    // The base ring's centre, so the underside can be closed. See below.
    const foot = [bl.x, yBot, bl.z];
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
      /**
       * …AND A REAL UNDERSIDE, WHICH IS SEVEN TRIANGLES NOBODY WILL EVER SEE
       * AND IS WORTH IT ANYWAY.
       *
       * The comment above `yBot` says the base goes further under the floor than
       * the block stands above it "so it is never on screen", and then relied on
       * that to leave the solid open at the bottom. Two things have since made
       * the reliance unsafe. The floor it is buried in is displaced by up to
       * 0.36 m in the widest rooms and the block did not know it (fixed at
       * placement, see `floorY`), and the melt now translates the whole block
       * RIGIDLY rather than shearing it — 0.25 * uFlow, up to about a quarter of
       * a metre — so at the peak a slab genuinely can lift clear of the silt. An
       * open-bottomed solid that lifts is a hole in the world you can see the
       * far wall through, and the failure would only ever appear while tripping.
       *
       * Darker than the fracture faces, which are already dark: this is the
       * underside of a rock lying in silt.
       */
      this._face(
        foot,
        [b.bx, yBot, b.bz],
        [a.bx, yBot, a.bz],
        null,
        inside, day, 0, 1, above, 0.55, 0, span, 0.12
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
       * A CURTAIN OF ROCK, AND IT IS NOW A SOLID ONE. This is the shape that was
       * most wrong in the cave and it was wrong in four independent ways at once.
       *
       * IT HAD NO THICKNESS. Five quads, emitted TWICE at identical coordinates
       * with opposite windings, because the material is FrontSide and one sheet
       * is invisible from half the passage. Two coplanar copies of a surface
       * z-fight stone cold sober — that is the flickering slab in the 88 m frame,
       * seen edge-on as a razor with the passage visible through it.
       *
       * AND THE TRIP TOOK THE TWO COPIES APART. `_face` negates the normal on
       * its flipped branch, so the second copy's normals are the exact negation
       * of the first's, and the breath moved each face along its own normal:
       * the two halves of a zero-thickness object were driven in OPPOSITE
       * directions, by up to 0.67 m on an object 0.35 to 1.1 m deep. Turned
       * inside out, twice a breath. This is the clearest single instance of
       * "the shapes are breathing apart" in the whole feature.
       *
       * IT HUNG FROM A CEILING IT WAS NOT TOUCHING. `y0` was the section's apex
       * rather than the roof above the point it hangs from, and neither knew
       * about the rock displacement. See `ceilY`.
       *
       * AND IT WAS TOO SMALL TO BE WORTH ANY OF THAT. See the size argument in
       * `placeSpires`.
       *
       * So: a slab with a real thickness, a plan that wanders off the straight
       * line, a hem with two incommensurate waves in it and the ends drawn up,
       * a ridge buried DRAPE_ROOT metres in the roof so the join is never on
       * screen, and closed ends. Every face has an inside; there are no coplanar
       * duplicates anywhere; and the whole thing is one body as far as the trip
       * is concerned, so it swings instead of delaminating.
       *
       * 136 vertices against 40. It is the most expensive object per unit in the
       * cave and it is the one that carries the SCALE of a chamber, because a
       * hanging mass read as a dark silhouette against a lit far wall is the one
       * shape down here whose size the eye can actually judge.
       */
      const n = DRAPE_PANELS;
      const half = sp.run * 0.5;
      // The sheet's own normal: horizontal, square across the run.
      const sx = sp.dirZ;
      const sz = -sp.dirX;
      const yRidge = sp.y0 + DRAPE_ROOT;
      const thTop = DRAPE_THICK * 0.5;
      const thHem = DRAPE_THICK * 0.5 * 0.33;
      const pts = [];
      let bx = 0;
      let bz = 0;
      let by = 0;
      for (let i = 0; i <= n; i++) {
        const t = i / n - 0.5;
        /**
         * The plan wanders. A drapery follows the joint it was deposited along
         * and a joint is not a straight line; a dead-straight sheet reads as a
         * quad from every angle, which is exactly what it used to be.
         */
        const bow =
          Math.sin(t * 4.3 + sp.seed * 17) * sp.run * 0.14 +
          Math.sin(t * 11.7 + sp.seed * 5) * sp.run * 0.05;
        const x = sp.x + sp.dirX * sp.run * t + sx * bow;
        const z = sp.z + sp.dirZ * sp.run * t + sz * bow;
        /**
         * …and so does the hem, on two waves at rates that do not divide into
         * each other, so the lower edge never repeats across the run.
         *
         * THE END TAPER IS DELIBERATELY WEAK. The first version drew the ends up
         * to a third of the depth on a clean ellipse and the result was a shield
         * — a single smooth arc, which is a shape with one feature in it and
         * reads as a logo. A curtain IS deeper in the middle, but only a little,
         * and what carries it is the ragged edge, not the envelope. So the
         * envelope only takes 38% off at the very ends and the two waves have
         * most of the range.
         */
        const e = t * 2;
        const ends = 0.62 + 0.38 * Math.sqrt(Math.max(0, 1 - e * e * 0.9));
        const drop =
          sp.h *
          ends *
          (0.46 +
            0.34 * Math.abs(Math.sin(t * 7.3 + sp.seed * 9)) +
            0.2 * Math.abs(Math.sin(t * 17.9 + sp.seed * 23)));
        const yHem = sp.y0 - drop;
        pts.push({
          tf: [x + sx * thTop, yRidge, z + sz * thTop],
          tb: [x - sx * thTop, yRidge, z - sz * thTop],
          bf: [x + sx * thHem, yHem, z + sz * thHem],
          bb: [x - sx * thHem, yHem, z - sz * thHem],
          y: yHem,
        });
        bx += x;
        bz += z;
        by += (yRidge + yHem) * 0.5;
      }
      // One anchor for the whole curtain, and it hangs off the ROOF, so it goes
      // where the roof goes. See MELT_FLOOR.
      this._body = [bx / (n + 1), by / (n + 1), bz / (n + 1)];
      this._meltFree = MELT_ROCK;
      const midOf = (a, b) => [
        (a.tf[0] + a.tb[0] + b.tf[0] + b.tb[0] + a.bf[0] + a.bb[0] + b.bf[0] + b.bb[0]) / 8,
        (a.tf[1] + b.bf[1]) * 0.5,
        (a.tf[2] + a.tb[2] + b.tf[2] + b.tb[2] + a.bf[2] + a.bb[2] + b.bf[2] + b.bb[2]) / 8,
      ];
      for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        /**
         * One inside point for all four faces of the panel, which is the whole
         * reason the old two-sided hack can be deleted: a slab HAS an inside, so
         * `_face` can derive every winding from it the way it does for a block.
         * No opposed copies, no coplanar pairs, nothing to z-fight with.
         */
        const inside = midOf(a, b);
        // Front, back, sole, ridge.
        this._face(a.tf, b.tf, b.bf, a.bf, inside, day, 1, 0.1, half + 2, 0, 0, span, 0.9);
        this._face(a.tb, b.tb, b.bb, a.bb, inside, day, 1, 0.1, half + 2, 0, 0, span, 0.9);
        this._face(a.bf, b.bf, b.bb, a.bb, inside, day, 1, 0.1, half + 2, 0, 0, span, 0.3);
        this._face(a.tf, b.tf, b.tb, a.tb, inside, day, 1, 0.1, half + 2, 0, 0, span, 0.2);
      }
      // The two ends, so the sheet is a closed solid and not a trough.
      const capIn = [midOf(pts[0], pts[1]), midOf(pts[n - 1], pts[n])];
      for (const [k, e] of [[0, capIn[0]], [n, capIn[1]]]) {
        const q = pts[k];
        this._face(q.tf, q.tb, q.bb, q.bf, e, day, 1, 0.1, half + 2, 0, 0, span, 0.45);
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
      /**
       * The waist, which is also the anchor the trip moves the whole post about.
       * A column takes the FLOOR's factor although it touches both surfaces: it
       * is the one formation with a collider, that collider does not move, and a
       * post you can walk through is a worse failure than a post whose top parts
       * company with a roof four metres over your head.
       */
      this._body = inside;
      this._meltFree = MELT_FLOOR;
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
      /**
       * BOTH ENDS, AND IT HAD NEITHER. A column was an open tube: look up one
       * from close to its foot on a FrontSide material and you see straight
       * through the floor end, up the inside of the post, and out at the roof.
       * It survived because a column is usually seen from far enough away that
       * the apertures are a few pixels — and because both ends are meant to be
       * against rock, which placement had no way of guaranteeing until `floorY`
       * and `ceilY` existed.
       *
       * Sixteen triangles. `_face` derives the winding from `inside`, so the
       * floor cap and the roof cap need no sign between them.
       */
      for (const t of [0, 1]) {
        const rr = prof(t);
        const y = sp.y0 + h * t;
        const cap = [sp.x, y, sp.z];
        for (let i = 0; i < COL; i++) {
          const a0 = (i / COL) * TAU;
          const a1 = ((i + 1) / COL) * TAU;
          const f0 = flute[i];
          const f1 = flute[i + 1];
          this._face(
            cap,
            [sp.x + Math.cos(a0) * rr * f0, y, sp.z + Math.sin(a0) * rr * f0],
            [sp.x + Math.cos(a1) * rr * f1, y, sp.z + Math.sin(a1) * rr * f1],
            null,
            inside, day, 1, 0.1, t * h, 0, 0, span, 0.18
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
    /**
     * The formation's own middle, at 0.35 of its length from the root because
     * the profile puts the mass there. Every vertex of the spire is anchored to
     * it, which is what turns the breath from "each of 88 facets moves along its
     * own normal" into "the whole thing swells". On a straw of radius 3.5 cm the
     * old form displaced each facet by up to 0.22 m — six times the object's own
     * radius — and it came apart into a cloud of triangles.
     *
     * A stalagmite is built by the floor and goes where the floor goes; a
     * stalactite is part of the roof. See MELT_FLOOR — this is the pair that
     * made the rule necessary, because a straw damped to a quarter hangs a metre
     * below its own ceiling at the peak.
     */
    this._body = inside;
    this._meltFree = dir > 0 ? MELT_FLOOR : MELT_ROCK;
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
    /**
     * THE ROOT, WHICH WAS AN OPEN RING.
     *
     * `prof(0)` is the widest ring on the object and nothing closed it: a
     * stalagmite was a cone with a hole in the bottom and a stalactite a cone
     * with a hole in the top, both trusting that the hole is against rock. It
     * very often was not — placement put the root on the analytic floor or the
     * analytic apex while the mesh drew the surface up to 0.9 m away (see
     * `wallPush`) — so a passage full of formations was a passage full of
     * apertures you could see the far wall through, each with a hard bright rim
     * where the widest facets end. That is the "flat black paper cut-out" read:
     * not a thin object, an object with its inside facing you.
     *
     * Eight triangles, fanned from the root's own centre, and dark.
     */
    const root = at(0);
    const rootC = [sp.x + root.ox, root.y, sp.z + root.oz];
    for (let i = 0; i < SEGS; i++) {
      const a0 = (i / SEGS) * TAU;
      const a1 = ((i + 1) / SEGS) * TAU;
      const f0 = flute[i];
      const f1 = flute[i + 1];
      this._face(
        rootC,
        [sp.x + root.ox + Math.cos(a0) * root.rr * f0, root.y, sp.z + root.oz + Math.sin(a0) * root.rr * f0],
        [sp.x + root.ox + Math.cos(a1) * root.rr * f1, root.y, sp.z + root.oz + Math.sin(a1) * root.rr * f1],
        null,
        inside,
        day,
        1,
        dir > 0 ? 0.5 : 0.05,
        dir > 0 ? 0 : 99,
        0,
        0,
        span,
        0.22
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
    /**
     * A STILL POOL IS LEVEL AND ITS EDGE IS SOLVED, WHICH IS TWO DIFFERENCES
     * FROM A STREAM AND BOTH OF THEM ARE THE DEFINITION OF THE WORD.
     *
     * The stream path below takes its Y from each ring's own floor and its width
     * from a constant capped at 1.7 m. Neither is defensible for standing water:
     * a surface that follows the floor down the passage is not still, and a
     * 1.7 m sheet in a chamber 48 m across is a puddle in a car park.
     *
     * ONE Y FOR THE WHOLE RUN, taken over the HIGHEST floor in it plus
     * POOL_DEPTH, so no ring is left dry. And then the edge is not a width at
     * all — it is the SHORELINE, found by bisecting the section's own floor
     * outline for the offset at which the ground comes up through the surface.
     * That is what a shoreline is, and it is the only version of this that
     * cannot be wrong: the water meets the rock exactly where the rock rises,
     * whatever the section is doing, whatever the displacement did to it, on
     * both sides independently because a cave floor is not symmetric.
     *
     * `floorY` is the same solve `placeBlocks` seats its slabs with and the same
     * one the collider answers from, so the pool's edge and the ground the body
     * walks are one number. Ten bisections a side is 2 cm on a 20 m chamber,
     * against a shoreline that is then pulled in by 12 cm anyway.
     *
     * `poolY` comes in on the run, solved once in `placeWater` over the WHOLE
     * lake — see the chunking note there. It cannot be worked out here because
     * here is one chunk of it, and a lake with a different surface height in each
     * chunk is a staircase.
     */
    const poolY = run.poolY ?? 0;
    /** The furthest offset, in metres, at which the floor is still under water. */
    const shore = (i, sh, tx, tz, side) => {
      const r = path.r[i];
      let lo = 0;
      let hi = (sh.w - 1e-3) * r;
      for (let s = 0; s < 10; s++) {
        const mid = (lo + hi) * 0.5;
        const d = mid * side;
        const y = floorY(this.c.k, path, i, sh, d / r, path.x[i] - tz * d, path.z[i] + tx * d);
        if (y < poolY - 0.02) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    const edge = (i) => {
      const r = path.r[i];
      const sh = ringShape(path, i, _shapeB);
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      let tx = path.x[b] - path.x[a];
      let tz = path.z[b] - path.z[a];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      if (run.still) {
        // Pulled in by a hand's breadth so the sheet ends just SHORT of the
        // rock rather than exactly on it: the two surfaces are solved from the
        // same function but drawn by different code, and a coincident edge is
        // the one place z-fighting could show on an otherwise opaque mesh.
        const wl = Math.max(0, shore(i, sh, tx, tz, 1) - 0.12) * path.wet[i];
        const wr = Math.max(0, shore(i, sh, tx, tz, -1) - 0.12) * path.wet[i];
        return {
          l: [path.x[i] - tz * wl, poolY, path.z[i] + tx * wl],
          r: [path.x[i] + tz * wr, poolY, path.z[i] - tx * wr],
          y: poolY,
        };
      }
      const wide = Math.min(1.7, r * sh.w * 0.55) * path.wet[i] * (1 + path.pool[i] * 0.9);
      const y = path.y[i] - r * sh.f + 0.03;
      return {
        l: [path.x[i] - tz * wide, y, path.z[i] + tx * wide],
        r: [path.x[i] + tz * wide, y, path.z[i] - tx * wide],
        y,
      };
    };
    /**
     * 1 for a stream, 2 for standing water, and it rides the SAME `wet` channel
     * the fragment shader already tests with `vWet > 0.5`.
     *
     * There is no attribute slot left — see the aSurf block — and there did not
     * need to be one: the branch is a threshold and everything above it is
     * water, so the lane can carry a second threshold above that for free. What
     * it buys is that a mirror can behave like a mirror and a stream cannot,
     * which is the whole difference between the two in the reference.
     */
    const wetTag = run.still ? 2 : 1;
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
      this._face(
        prev.l,
        prev.r,
        cur.r,
        cur.l,
        below,
        this._daylight(path, i),
        0,
        1,
        0.02,
        1,
        wetTag,
        this._spanAt(path, i)
      );
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
  *_link(hood) {
    const b = this._buffers;
    const rows = this._rows;
    let t = 0;
    /**
     * 32 rows is about a third of a millisecond of quads, which is the same
     * granularity the burial and the emit are cut to. Yielding per row would be
     * 1 400 suspensions to save 0.3 ms of overshoot; yielding per passage would
     * be four, and the main passage is nine tenths of the work.
     */
    const LINK_SLICE = 32;

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
        if (i % LINK_SLICE === 0) yield 'link';
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

  *_finish() {
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
    // Same 32 rows the indexing is cut at, and for the same reason.
    for (let ri = 0; ri < rows + hood + 1; ri++) {
      if (ri % 32 === 0) yield 'normals';
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

    yield 'geometry';
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
    yield 'index';

    /**
     * NOTHING IS ATTACHED TO THE GEOMETRY HERE. See `_prime`: the seven buffers
     * go on one per frame, and a geometry with no attributes and no index is
     * submitted, binds nothing and uploads nothing.
     *
     * The bounding sphere still has to be computed from the positions, and it
     * USED TO BE `geo.computeBoundingSphere()` with the attribute attached,
     * measured and taken off again.
     *
     * THAT ONE CALL WAS THE LAST HITCH IN THE BUILD, at 1.8-3.5 ms on every cave
     * measured — three times anything else left in it, and by then the largest
     * single frame the whole feature produced. It is not three's fault: it is
     * two passes over 60-80 000 vertices, one for the box and one for the
     * radius, and it is a single synchronous call with nowhere to stop.
     *
     * So it is done here instead, to the same definition — centre of the
     * bounding box, radius the furthest vertex from it — in chunks that can
     * yield. `_finish` is the only thing that ever asks, the answer is identical
     * to a float, and the alternative (deriving a sphere from the ring centres
     * and radii) was rejected: it would have to be conservative, a bound that is
     * WRONG in the small direction pops a passage out of the frustum while you
     * are standing inside it, and there is no cheap way to be sure it never is.
     */
    const BOUND_SLICE = 8192;
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < used; i++) {
      if (i % BOUND_SLICE === 0) yield 'bounds';
      const px = b.position[i * 3];
      const py = b.position[i * 3 + 1];
      const pz = b.position[i * 3 + 2];
      if (px < x0) x0 = px;
      if (py < y0) y0 = py;
      if (pz < z0) z0 = pz;
      if (px > x1) x1 = px;
      if (py > y1) y1 = py;
      if (pz > z1) z1 = pz;
    }
    const ox = (x0 + x1) * 0.5;
    const oy = (y0 + y1) * 0.5;
    const oz = (z0 + z1) * 0.5;
    let maxSq = 0;
    for (let i = 0; i < used; i++) {
      if (i % BOUND_SLICE === 0) yield 'bounds';
      const dx = b.position[i * 3] - ox;
      const dy = b.position[i * 3 + 1] - oy;
      const dz = b.position[i * 3 + 2] - oz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > maxSq) maxSq = d2;
    }
    // The melt moves this by up to a metre or so; a passage that popped out of
    // the frustum at the peak while you were standing inside it would be the
    // worst possible moment for it. Same reasoning as TRIP_SLACK in ground.js.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(ox, oy, oz), Math.sqrt(maxSq) + 3);

    const deferred = [
      ['position', position],
      ['index', new THREE.BufferAttribute(index, 1)],
      ['normal', new THREE.BufferAttribute(b.normal.subarray(0, used * 3), 3)],
      ['aRock', new THREE.BufferAttribute(b.rock.subarray(0, used * 3), 3)],
      ['aLit', new THREE.BufferAttribute(b.lit.subarray(0, used * 3), 3)],
      ['aSurf', new THREE.BufferAttribute(b.surf.subarray(0, used * 4), 4)],
      ['aGlow', new THREE.BufferAttribute(b.glow.subarray(0, used * 4), 4)],
      /**
       * An eighth buffer, so `_prime` now takes nine frames rather than eight.
       * The argument in `_prime` is unchanged and the extra frame is free: the
       * build is armed 320 m from the mouth and already spends ten or more
       * frames slicing rings with no mesh at all, so one more 400 KB upload
       * lands half a minute of sprinting away from anybody who could see it.
       */
      ['aBody', new THREE.BufferAttribute(b.body.subarray(0, used * 4), 4)],
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

    // Two more meshes. The fungi are 25 000 sprites and slice themselves — see
    // there. The beams are a handful of stamped cones, measured at 0.14 ms, and
    // get one stop of their own so they cannot land on the same frame as the
    // geometry above.
    yield 'fungi-mesh';
    yield* this._buildFungi();
    yield 'shaft-mesh';
    this._buildShafts();
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
   * WHICH CHAMBERS GET LIGHT IN THE AIR, ASKED OF THE PATH RATHER THAN TOLD.
   *
   * Walks every ring of every passage and finds RUNS of rings that are all wide
   * enough and all tall enough — see SHAFT_HALF — then puts one beam at the
   * biggest ring of each run. A run rather than a ring, because the radius is
   * splined and a single fat ring between two normal ones is an overshoot and
   * not a room; six of them in a row is a room.
   *
   * Every number this reads (`r`, `w`, `f`, `t`) is produced by code three other
   * people are editing today. That is precisely why this is a query: whatever
   * `SHAPES` and the walk are made to do to chamber size and frequency, the
   * beams follow, and nothing here has to be told about it.
   */
  _planShafts() {
    this.shafts = [];
    const rng = makeRng(`${getWorldSeed()}:cave-shaft:${this.c.k}`);
    /**
     * ONE BEARING AND ONE TILT FOR THE WHOLE CAVE, and this is the difference
     * between four beams and a fairground. Light entering a mountain comes in
     * from one sky, so every shaft in one hill leans the same way; four cones at
     * four independent angles reads instantly as four separate props. The tilt
     * is small — up to 14 degrees — because at the heights involved anything
     * more walks the top of the cone into the wall it was seated clear of.
     */
    const bearing = rngRange(rng, -Math.PI, Math.PI);
    const tilt = rngRange(rng, 0.06, 0.25);

    /**
     * EVERY candidate first, and the budget applied afterwards. Taking the first
     * N as they are found is what put all four of the first build's beams in the
     * first third of a 647 m passage: the walk goes in path order, so a cap
     * spends itself before it has seen the cave. See SHAFT_PER_M.
     */
    const found = [];
    let metres = 0;
    for (let p = 0; p < this.paths.length; p++) {
      const path = this.paths[p];
      const n = path.x.length;
      metres += n * RING_STEP;
      /**
       * A branch measures from its own start rather than from the mouth. It is
       * already deep by construction — a lead leaves the main line somewhere
       * inside — so holding it to the main passage's twenty-four rings would
       * exclude the first chamber on every branch in the world for a reason
       * that only applies to the entrance.
       */
      let i = p === 0 ? SHAFT_FROM : 4;
      while (i < n - 4) {
        if (path.r[i] * path.w[i] < SHAFT_HALF || path.r[i] * (path.f[i] + path.t[i]) < SHAFT_HEAD) {
          i++;
          continue;
        }
        let j = i;
        let at = i;
        let best = -1;
        while (j < n - 4) {
          const half = path.r[j] * path.w[j];
          const head = path.r[j] * (path.f[j] + path.t[j]);
          if (half < SHAFT_HALF || head < SHAFT_HEAD) break;
          // Biggest by VOLUME rather than by either alone: a beam belongs in the
          // middle of the room, and the middle is where both are largest at once.
          if (half * head > best) {
            best = half * head;
            at = j;
          }
          j++;
        }
        // `lo`/`hi` are kept because a great hall is lit across its whole run
        // rather than at one ring of it. See `_lightHall`.
        if (j - i >= SHAFT_RUN) found.push({ path, at, lo: i, hi: j, score: best });
        i = j + SHAFT_GAP;
      }
    }
    if (!found.length) return;

    /**
     * BUCKETED, NOT SORTED, AND THAT IS THE WHOLE OF THE SELECTION RULE.
     *
     * Sorting by size and keeping the top few gives you the biggest chambers,
     * which in a passage that gets steadily bigger as it descends means every
     * beam is in the last quarter of it. Cutting the candidate list into as many
     * equal buckets as there is budget and keeping the best of each spreads them
     * over the whole walk AND still puts each one in the most impressive room
     * available near where it lands. Two lines, and it is the difference between
     * a feature you meet four times and one you meet at the end.
     */
    const budget = clamp(Math.round(metres * SHAFT_PER_M), SHAFT_MIN, SHAFT_MAX);
    const take = Math.min(budget, found.length);
    const chosen = [];
    for (let b = 0; b < take; b++) {
      const lo = Math.floor((b * found.length) / take);
      const hi = Math.floor(((b + 1) * found.length) / take);
      let pick = lo;
      for (let c = lo; c < hi; c++) if (found[c].score > found[pick].score) pick = c;
      chosen.push(pick);
    }
    /**
     * AND THE BIGGEST CHAMBER IN THE CAVE IS NOT ALLOWED TO MISS.
     *
     * The bucketing above is right and stays: spreading the beams over the walk
     * is what fixed "all four in the first third". But spreading is a statement
     * about WHERE, and it makes no promise about WHAT — a bucket boundary can
     * fall either side of the one room that most needed the light, and on
     * grove-01 k=0 it did. The measured consequence was a 24 m x 48 m terminal
     * chamber whose nearest beam was ninety metres back up the passage, and a
     * tour frame of it that is very nearly uniformly black.
     *
     * One extra pass, and it cannot double-book: if the global best is already
     * chosen this is a no-op, and if it is not it is appended, which is at most
     * one beam over budget in the one case where the budget was wrong.
     */
    let top = 0;
    for (let c = 1; c < found.length; c++) if (found[c].score > found[top].score) top = c;
    if (!chosen.includes(top)) chosen.push(top);

    for (const c of chosen) this._lightChamber(found[c], rng, bearing, tilt);
  }

  /**
   * One chamber's whole lighting plan, which for a small one is one beam.
   *
   * WHY THE DECISION IS HERE AND NOT IN `_seatShaft`. A beam is a piece of
   * geometry with a position and a size; how many of them a room wants, and how
   * far its light has to carry, are properties of the ROOM. Keeping them apart
   * is what lets the hall case be a handful of lines that call the existing
   * seater more than once instead of a second, parallel version of it.
   */
  _lightChamber(cand, rng, bearing, tilt) {
    const { path, at } = cand;
    const half = path.r[at] * path.w[at];
    const head = path.r[at] * (path.f[at] + path.t[at]);
    if (half < HALL_HALF) {
      this._seatShaft(path, at, rng, bearing, tilt);
      return;
    }
    /**
     * VOLUME, CUBE-ROOTED. See HALL_BEAMS_MAX. The reference volume is the
     * smallest thing that gets here — a 12 m half-width chamber with the head
     * that goes with it — so a room exactly on the threshold gets exactly one
     * beam and the transition across HALL_HALF is continuous rather than a step.
     */
    const vol = (half * half * head) / (HALL_HALF * HALL_HALF * HALL_HALF * 2.2);
    const beams = clamp(Math.round(Math.cbrt(Math.max(1, vol))), 1, HALL_BEAMS_MAX);
    /**
     * Spread across the run rather than stacked at its biggest ring. Two cones a
     * metre apart is one fat cone; two cones twenty metres apart is a room with
     * depth in it, which is the only thing that answers "how far away is that
     * wall". The ends of the run are avoided by a fifth because the run's ends
     * are where the chamber is narrowing back into passage.
     */
    const lo = cand.lo + Math.round((cand.hi - cand.lo) * 0.2);
    const hi = cand.hi - Math.round((cand.hi - cand.lo) * 0.2);
    for (let b = 0; b < beams; b++) {
      const i = beams === 1 ? at : Math.round(lo + ((hi - lo) * b) / (beams - 1));
      this._seatShaft(path, clamp(i, 1, path.x.length - 2), rng, bearing, tilt, half);
    }
    this._bounceHall(path, cand, half);
  }

  /**
   * The bounce: a ring of baked points around a hall, at three heights.
   *
   * See HALL_BOUNCE for what it is standing in for. Three things about it are
   * decisions rather than parameters:
   *
   *   IT IS ON THE WALL, NOT IN THE AIR. A point source floating in the middle
   *   of a chamber lights the near face of everything and reads as a lamp
   *   nobody hung; a source ON the rock at the perimeter lights the room across
   *   its widest axis, which is the measurement the player is being asked to
   *   make. `into` of 0.86 keeps it just inside the wall so the rock it is
   *   sitting on is lit too — a bounce with a dark patch at its own origin is
   *   the tell that it is not really there.
   *
   *   IT IS SHAFT_LIGHT AND NOT A FUNGUS COLOUR. This is the beam's light after
   *   one bounce off limestone, so it is the same pale blue the beam's own foot
   *   bakes, and it is deliberately the coldest thing in the room: the warm and
   *   the violet down here belong to objects you can walk up to, and a hall
   *   whose ambient was tinted by them would put the fungi's colour on rock
   *   forty metres from the nearest fungus.
   *
   *   AND THE TOP RING IS THE POINT OF THE WHOLE THING. `placeFungi` puts its
   *   clusters low, "where you would actually find them", so the upper half of
   *   a fifty-metre chamber has never had a source in it at any distance — see
   *   the same observation in `_seatShaft`'s second light. A ring at three
   *   quarters of the height is what turns "the wall goes up out of the picture"
   *   into "the wall goes up, and up, and there is a roof on it".
   */
  _bounceHall(path, cand, half) {
    const n = path.x.length;
    const lo = cand.lo;
    const hi = cand.hi;
    /**
     * Reach spans the chamber and no more. `half * 2.1` is corner to corner
     * across the widest axis plus a little, which is the largest number that
     * cannot leak into the passage feeding it: the feed is 3.3-4.7 m wide and
     * the falloff is quadratic, so a source at the far side of the hall arrives
     * at the passage mouth at under a twentieth of its value.
     */
    const reach = Math.max(SHAFT_REACH, half * 1.7);
    for (let b = 0; b < HALL_BOUNCE; b++) {
      const i = clamp(Math.round(lo + ((hi - lo) * (b + 0.5)) / HALL_BOUNCE), 1, n - 2);
      const r = path.r[i];
      const a = Math.max(0, i - 1);
      const c = Math.min(n - 1, i + 1);
      let tx = path.x[c] - path.x[a];
      let tz = path.z[c] - path.z[a];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      // Alternate sides down the length of the hall, so the two walls are lit
      // from each other rather than one wall being lit and the other being it.
      //
      // MIRRORED AS `PI - phi` AND NOT AS `-phi`, because cos is even: negating
      // the angle flips the HEIGHT and leaves the wall alone, which is the
      // opposite of what "the other side" means and would have stacked all
      // twenty-one points down one wall. Same trap `placeFungi` sidesteps by
      // adding PI, which flips both.
      const side = b % 2 === 0 ? 1 : -1;
      for (const up of [0.0, 0.62]) {
        let phi = -0.12 + up * 1.33;
        if (side < 0) phi = Math.PI - phi;
        section(phi, ringShape(path, i, _shapeA), _sectTmp);
        const into = 0.86;
        const px = path.x[i] - tz * _sectTmp.x * r * into;
        const pz = path.z[i] + tx * _sectTmp.x * r * into;
        const py = path.y[i] + _sectTmp.y * r * into;
        this.lights.push({
          x: px,
          y: py,
          z: pz,
          colour: SHAFT_LIGHT,
          /**
           * Weakest at the top, because the bounce that got there has travelled
           * furthest and hit least. It is also the ring with the least to hit —
           * a ceiling has no floor under it to bounce off — so a strong one
           * there reads as a light fixture rather than as air.
           */
          power: (0.13 - up * 0.04) * clamp(half / HALL_HALF, 1, 1.6),
          reach,
        });
      }
    }
    /**
     * NOT ONE DRAW OF `rng` IN HERE, AND THAT IS DELIBERATE.
     *
     * `_planShafts`'s stream is shared by every beam in the cave: a draw taken
     * between two chambers would change the `seed` and the lateral offset of
     * every beam after it, so a hall's bounce ring could not be retuned without
     * silently moving the beams in the rooms downstream of it. The pattern is
     * deterministic from the path instead — same trap `fauna-wired` documents
     * one file over, avoided by not reaching for the generator at all.
     */
  }

  /**
   * The nearest ring's half-width, for anything that has a position and no ring.
   *
   * Coarse then fine, because the answer is a lighting ratio and not a
   * collision: a stride of eight rings is 5.76 m and the refine window is the
   * same distance either side, so it is exact for any point whose nearest ring
   * is within one window of the coarse winner — which on a spline that bends by
   * at most a few degrees a ring is all of them. Roughly 450 distance tests per
   * query against the 120 000-vertex bake that reads the answer.
   */
  _localHalf(x, y, z) {
    let best = Infinity;
    let half = 0;
    for (const path of this.paths) {
      const n = path.x.length;
      let ci = 0;
      let cd = Infinity;
      for (let i = 0; i < n; i += 8) {
        const dx = path.x[i] - x;
        const dy = path.y[i] - y;
        const dz = path.z[i] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < cd) {
          cd = d;
          ci = i;
        }
      }
      for (let i = Math.max(0, ci - 8); i < Math.min(n, ci + 9); i++) {
        const dx = path.x[i] - x;
        const dy = path.y[i] - y;
        const dz = path.z[i] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) {
          best = d;
          half = path.r[i] * path.w[i];
        }
      }
    }
    return half;
  }

  /**
   * More mushrooms in a bigger room, which is the rule `placeFungi` does not have.
   *
   * Its spacing is 10-22 RINGS whatever the section is doing, so a hall gets the
   * same three or four clusters a corridor of the same length gets — the
   * terminus work reported its chambers as "far too big for the fungi in it",
   * and that is the arithmetic of it. Density per unit of WALL is the honest
   * rule: a chamber has five times the rock surface of the passage feeding it and
   * things grow on rock.
   *
   * SEEDED HERE RATHER THAN IN `placeFungi` because this is a lighting decision
   * and `placeFungi`'s rng stream is the seed of every cluster in the world — a
   * change to its draw order silently reseeds every cave on every ridge, which is
   * the class of bug the fauna work has a whole note about. This runs afterwards,
   * on its own stream, and appends; nothing existing moves by a millimetre.
   */
  _seedHallFungi() {
    const rng = makeRng(`${getWorldSeed()}:cave-hall-fungi:${this.c.k}`);
    for (const path of this.paths) {
      const n = path.x.length;
      for (let i = 6; i < n - 6; i++) {
        const half = path.r[i] * path.w[i];
        if (half < HALL_HALF * 0.75) continue;
        /**
         * One roll per ring, at a probability that is zero at three quarters of
         * HALL_HALF and about one in seven at the widest thing the table can
         * build. Over a sixty-ring chamber that is six to ten extra clusters,
         * against the three `placeFungi` left there.
         */
        if (rng() > clamp01((half - HALL_HALF * 0.75) / 14) * 0.15) continue;
        const r = path.r[i];
        /**
         * Anywhere on the wall INCLUDING high up, which is the one thing
         * `placeFungi` deliberately does not do. Its reason — you find them low,
         * where the water is — is right for a passage and wrong for a chamber
         * whose lower walls are buried in forty metres of breakdown: the rock
         * that is at "floor level" for a colony up there IS the upper wall. It
         * is also the only source in the world that can put light on a ceiling
         * this high, and a ceiling with no light on it is not a tall room, it is
         * a room with no ceiling.
         */
        let phi = rngRange(rng, -0.45, 1.32);
        if (rng() < 0.5) phi = Math.PI - phi;
        section(phi, ringShape(path, i, _shapeA), _sectTmp);
        const a = Math.max(0, i - 1);
        const b = Math.min(n - 1, i + 1);
        let tx = path.x[b] - path.x[a];
        let tz = path.z[b] - path.z[a];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        const pick = rng();
        this.fungi.push({
          x: path.x[i] - tz * _sectTmp.x * r * 0.94,
          y: path.y[i] + _sectTmp.y * r * 0.94,
          z: path.z[i] + tx * _sectTmp.x * r * 0.94,
          colour: (pick < 0.62 ? FUNGUS_COLD : pick < 0.88 ? FUNGUS_DEEP : FUNGUS_ODD).clone(),
          power: rngRange(rng, 0.7, 1.4),
          count: 5 + Math.floor(rng() * 10),
          seed: rng(),
        });
        i += 3;
      }
    }
  }

  /**
   * One beam, and the two lights that are the only evidence it lands anywhere.
   *
   * THE TOP IS CLEAR OF THE CEILING AND THE FOOT IS UNDER THE FLOOR, which are
   * the two halves of "a shell must never draw its own intersection". The cone
   * stops a tenth of the room's height below the roof so there is no join to
   * see, and its base is sunk 0.6 m below the analytic floor so that the floor's
   * own rock displacement — up to `r * rough`, which in a room is over a metre —
   * cannot leave a rim of cone standing proud of it. Neither end is visible in
   * either case, because the fragment shader has faded both to nothing before
   * they get there; this is belt and braces on the one artefact that would be
   * unmistakable.
   */
  _seatShaft(path, i, rng, bearing, tilt, hallHalf = 0) {
    const n = path.x.length;
    const r = path.r[i];
    /**
     * `hallHalf` is the CHAMBER's half-width, passed only when `_lightChamber`
     * is spreading several beams over one hall. The rings a spread beam lands on
     * are not the biggest in the run — that is the point of spreading them — so
     * sizing each cone from its own ring would make the outer two visibly
     * skinnier than the middle one and read as a big beam with two small ones
     * beside it rather than as three beams in a hall. Zero means "size me from
     * where you put me", which is every other caller.
     */
    const half = Math.max(r * path.w[i], hallHalf * 0.8);
    const floorY = path.y[i] - r * path.f[i];
    const ceilY = path.y[i] + r * path.t[i];
    const head = ceilY - floorY;

    // The same right-hand basis about the tangent that `placeFungi` uses.
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let tx = path.x[b] - path.x[a];
    let tz = path.z[b] - path.z[a];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    /**
     * NEAR THE AXIS, AND THAT IS NOT LAZINESS ABOUT THE COMPOSITION.
     *
     * A third of the half-width at most. Two reasons, and the second is the one
     * that matters: the centre line at floor level is where `placeWater` puts
     * its runs, so a beam seated near the axis has a real chance of landing ON
     * a pool — and a beam standing in water is the reference's whole lower half.
     * The first is duller: the axis is the one place in the section guaranteed
     * to have head-room above it and floor below it, so a beam there cannot
     * clip a wall that the section happens to pinch.
     */
    const off = rngRange(rng, -0.33, 0.33) * half;
    const cx = path.x[i] - tz * off;
    const cz = path.z[i] + tx * off;

    const bottom = floorY - 0.6;
    const top = ceilY - head * 0.10;
    const h = Math.max(3, top - bottom);
    /**
     * Wide enough to be a room's beam and never wide enough to be the room.
     * Rather over a third of the half-width, capped at seven metres: past that
     * the cone starts to cover most of the section, at which point standing
     * anywhere in the chamber means standing inside it and the near fade is
     * carrying the whole feature on its own.
     *
     * The first tuning was 0.32 and a five-metre cap, fitted against the
     * `room` shape's stated 6.5-11 m radius. The chambers on the ridge as built
     * measure 15-17 m of half-width, so a beam in one was two thirds the width
     * it should have been and read as a torch in a cathedral. Both numbers are
     * ratios of the room now, which is the form that survives the next change
     * to the shape table.
     */
    const rad = clamp(half * 0.38, 1.1, 7.0);
    const dir = new THREE.Vector3(
      Math.sin(tilt) * Math.cos(bearing),
      Math.cos(tilt),
      Math.sin(tilt) * Math.sin(bearing)
    );
    this.shafts.push({
      x: cx,
      y: bottom,
      z: cz,
      h,
      rad,
      dir,
      seed: rng(),
      // Bigger rooms get brighter beams, gently. A 20 m hall with the same beam
      // as an 8 m one reads as the hall being lit by a torch.
      gain: clamp(0.78 + (half - SHAFT_HALF) * 0.055, 0.78, 1.4),
    });

    /**
     * TWO LIGHTS, AND THE UPPER ONE IS NOT DECORATION.
     *
     * The foot is the obvious one: a pale blue pool on the floor and the bottom
     * of the walls, which is what stops the beam being a decal painted over the
     * room. The upper one, at two thirds of the height and reaching further, is
     * what puts the light on the CEILING and the upper walls — and that is the
     * term that makes a chamber read as tall, because `_shade`'s only other
     * source at that height is whatever fungus happens to be up there, which is
     * usually none: `placeFungi` puts them low, where you would find them.
     *
     * Both go through the same bake, the same quadratic falloff and the same
     * x/(1+x) soft clamp as every other emitter, so a beam in a crystal seam
     * saturates toward the sum of the two colours instead of clipping white.
     */
    /**
     * …AND BOTH REACHES ARE RATIOS TO THE ROOM NOW. See the ROOM_KNEE block.
     * SHAFT_REACH is 17 m, "about one chamber", and it was: the chambers it was
     * written against were eight to eleven metres across. In a hall it is a
     * seventeen-metre pool of light on a fifty-metre floor with a hard dark edge
     * where it stops — which is worse than no pool, because a circle of light on
     * a floor with nothing else lit reads as a spotlight and gives the eye a
     * false scale to measure the room by.
     */
    const gain = this.shafts[this.shafts.length - 1].gain;
    const room = roomGain(half, 0.9);
    // Divided by the gain, for the reason the fungus list gives at length: a
    // wider reach on a quadratic falloff is a brighter light everywhere inside
    // the old one, and the pool at a beam's foot is already as bright as this
    // cave gets.
    this.lights.push({
      x: cx,
      y: floorY + 0.5,
      z: cz,
      colour: SHAFT_LIGHT,
      power: (1.25 * gain) / room,
      reach: SHAFT_REACH * room,
    });
    this.lights.push({
      x: cx + dir.x * h * 0.66,
      y: bottom + dir.y * h * 0.66,
      z: cz + dir.z * h * 0.66,
      colour: SHAFT_LIGHT,
      power: (0.8 * gain) / room,
      reach: SHAFT_REACH * 1.3 * room,
    });
  }

  /**
   * The beams, merged into one mesh, exactly as `_buildFungi` merges the heads.
   *
   * ITS OWN GEOMETRY AND ITS OWN MATERIAL, on the cave group, and deliberately
   * nowhere near the rock's shared vertex allocation in `prepare`. It has to be
   * a second draw whatever happens — it is transparent and the rock is opaque —
   * so there is nothing to be gained by sharing a buffer with it and a great
   * deal to be lost.
   *
   * Four beams is 112 triangles. The merge is a transform of 336 vertices done
   * once per cave; there is no per-frame CPU here at all.
   */
  _buildShafts() {
    const list = this.shafts;
    if (!list || !list.length) return;
    const unit = shaftUnit();
    const up = unit.getAttribute('position').array;
    const un = unit.getAttribute('normal').array;
    const uu = unit.getAttribute('uv').array;
    const vc = up.length / 3;

    const pos = new Float32Array(vc * list.length * 3);
    const nor = new Float32Array(vc * list.length * 3);
    const uv = new Float32Array(vc * list.length * 2);
    const beam = new Float32Array(vc * list.length * 2);

    const m = new THREE.Matrix4();
    const nm = new THREE.Matrix3();
    const q = new THREE.Quaternion();
    const t = new THREE.Vector3();
    const s = new THREE.Vector3();
    const v = new THREE.Vector3();
    const YUP = new THREE.Vector3(0, 1, 0);
    let at = 0;
    for (const b of list) {
      q.setFromUnitVectors(YUP, b.dir);
      m.compose(
        t.set(b.x - this.originX, b.y - this.originY, b.z - this.originZ),
        q,
        s.set(b.rad, b.h, b.rad)
      );
      /**
       * The inverse transpose, because the scale is non-uniform — (rad, h, rad)
       * — and the |N·V| silhouette fade IS the shape of the beam. Transforming
       * the normals by the model matrix instead tilts every one of them toward
       * the vertical by the ratio of the two scales, which for a tall narrow
       * beam is a factor of four: the fade would then be at its softest looking
       * along the cone and hardest looking across it, i.e. backwards.
       */
      nm.getNormalMatrix(m);
      for (let i = 0; i < vc; i++) {
        const k3 = (at + i) * 3;
        v.set(up[i * 3], up[i * 3 + 1], up[i * 3 + 2]).applyMatrix4(m);
        pos[k3] = v.x;
        pos[k3 + 1] = v.y;
        pos[k3 + 2] = v.z;
        v.set(un[i * 3], un[i * 3 + 1], un[i * 3 + 2]).applyMatrix3(nm).normalize();
        nor[k3] = v.x;
        nor[k3 + 1] = v.y;
        nor[k3 + 2] = v.z;
        const k2 = (at + i) * 2;
        uv[k2] = uu[i * 2];
        uv[k2 + 1] = uu[i * 2 + 1];
        beam[k2] = b.seed;
        beam[k2 + 1] = b.gain;
      }
      at += vc;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aBeam', new THREE.BufferAttribute(beam, 2));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, sharedShaft ?? (sharedShaft = shaftMaterial()));
    mesh.position.set(this.originX, this.originY, this.originZ);
    /**
     * After the rock (-5) and before the fungus heads (5). Both of those are
     * additive so the order between them buys nothing visually; what it buys is
     * that a beam is depth-tested against a passage that has already written
     * depth, so the wall of the next gallery hides the beam behind it instead of
     * the beam glowing through the mountain.
     */
    mesh.renderOrder = 4;
    mesh.name = 'cave-shafts';
    this.shaftMesh = mesh;
    this.group.add(mesh);
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
  *_buildFungi() {
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
    /**
     * A STOP PER CLUSTER, BECAUSE THIS IS 2.5 ms AND NOT THE 0.4 IT LOOKS LIKE.
     *
     * Fifty to ninety clusters of a few dozen heads each, plus every crystal and
     * every one of five to seven hundred spores — measured at 2.5 ms on a
     * grove-01 cave, which was the third fattest thing in the build once the
     * plan and the close had been cut. It looks cheap because each write is a
     * float; it is not, because there are 25 000 of them and every head draws
     * six random numbers.
     */
    for (const g of this.fungi) {
      yield 'fungi-mesh';
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
    yield 'fungi-mesh';
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
    yield 'fungi-mesh';
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
    // The beams are a merged buffer of their own; the unit cone they were
    // stamped from is module-level and shared, so it is not touched here.
    this.shaftMesh?.geometry.dispose();
    this.group.clear();
    this.mesh = null;
    this.points = null;
    this.shaftMesh = null;
    this._buffers = null;
    this._priming = null;
    this.ready = false;
    this._ring = 0;
    this._ex = 0;
    /**
     * A suspended build holds its whole stack frame alive — the node list, the
     * `want`/`room`/`rock` scratch of a burial, a Float64Array per channel — so
     * a cave dropped mid-plan would keep several hundred kilobytes for as long
     * as anything referenced it. Dropping the generators is what lets the
     * closure go, and `prepared` going false with them is what stops a
     * half-built cave being republished into `live` if one is ever reused.
     */
    this._prep = null;
    this._close = null;
    this.prepared = false;
  }
}

let sharedMaterial = null;
let sharedFungus = null;
let sharedShaft = null;

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
  /**
   * `aGlow` AND `aDrift` WERE MISSING, WHICH IS THE EXACT FAILURE THE BLOCK
   * ABOVE DESCRIBES, TWICE.
   *
   * Both attributes were added after this function was written — `aGlow` when
   * the bake learned to carry a light direction, `aDrift` when the spores
   * arrived — and neither commit updated the stand-ins. So the two programs
   * this warms differed from the two the real meshes need by one attribute
   * each, and the pre-warm has been compiling a pair of shaders nothing in the
   * world uses ever since. The rule the comment states was correct and was
   * simply not followed; adding them here is the whole fix.
   */
  rock.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(12), 4));
  /**
   * …and `aBody`, which is the eighth. Added the same hour the attribute was —
   * the rule two blocks up has now been broken three times and kept once, and
   * the only reason it was kept this time is that the block says so in capitals.
   * A vec4: xyz is the body's anchor, w is how freely the melt may carry it.
   */
  rock.setAttribute('aBody', new THREE.BufferAttribute(new Float32Array(12), 4));
  rock.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));

  const fungi = new THREE.BufferGeometry();
  fungi.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  fungi.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(9), 3));
  fungi.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(3), 1));
  fungi.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(3), 1));
  fungi.setAttribute('aDrift', new THREE.BufferAttribute(new Float32Array(3), 1));

  /**
   * And the beams. Same rule, same attribute list as `_buildShafts` builds:
   * position, normal, uv, aBeam, non-indexed. A shaft material compiling on
   * first sight would land at the worst possible moment — it is the frame you
   * walk into the chamber it is standing in.
   */
  const shaft = new THREE.BufferGeometry();
  shaft.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  shaft.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
  shaft.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2));
  shaft.setAttribute('aBeam', new THREE.BufferAttribute(new Float32Array(6), 2));

  return [
    new THREE.Mesh(rock, sharedMaterial ?? (sharedMaterial = caveMaterial())),
    new THREE.Points(fungi, sharedFungus ?? (sharedFungus = fungusMaterial())),
    new THREE.Mesh(shaft, sharedShaft ?? (sharedShaft = shaftMaterial())),
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
  /**
   * How far past the closed end of the passage the body is, in metres, and the
   * horizontal tangent to push it back along. `axial` is 0 everywhere except at
   * the terminus. See where it is set, and the block it is applied in.
   */
  axial: 0,
  axX: 0,
  axZ: 0,
};

/** A null answer, reused, so the callers never allocate and never see stale data. */
function outside() {
  _sample.inside = 0;
  _sample.cave = null;
  _sample.path = null;
  _sample.blind = Infinity;
  _sample.postR = 0;
  _sample.axial = 0;
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
        /**
         * NOT PAST `endRing`, AND THAT IS THE TELEPORT AT THE END OF EVERY CAVE.
         *
         * The rings past `endRing` are the dome — a section smaller than a person,
         * closing to a 2 cm pole. `u` here is `horiz / (r * w)`, so on a cap ring
         * whose half-width is three centimetres a body standing a hand's breadth
         * off the axis scores four or five, `bestFit` never comes under the 2.2
         * gate, the path is skipped, and with no other path claiming the point
         * `caveFloorUnder` falls through to `groundUnder` — which under a
         * mountain is its summit. `inCave` drops to zero on the same frame, so
         * `occludeWorld` re-submits the whole forest as well: the floor and the
         * world both snap at once, which is why it reads as a teleport rather
         * than as a collision fault.
         *
         * The `ri < 1e-3` guard below never caught it because 0.05 is not 0.001 —
         * the old cap's radius was fifty times the number the guard tested. It is
         * kept as the arithmetic backstop it always was; this is the geometric
         * one. Containment near a terminus is answered from the last ring that is
         * a place, extended along its own axis by the `al` term, which reaches
         * 2.2 * 1.9 = 4.18 m — most of the way to the pole, and further than the
         * axial stop below ever lets a body get.
         */
        const lo = scanLo;
        const hi = Math.min(n - 1, scanHi - 1, path.endRing ?? n - 1);
        if (hi < lo) continue;
        let fit = clamp(bi, lo, hi);
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
      /**
       * …AND WITH THE ROCK'S OWN DISPLACEMENT ON IT, WHICH THE DRAWN FLOOR HAS
       * ALWAYS CARRIED AND THE ANALYTIC ONE NEVER HAS.
       *
       * `path.y[bi] + r * floorAt(nx, sh)` is the SMOOTH outline. Every vertex
       * of the drawn floor is that outline moved along its own ray by
       * `wallPush` — and on the floor that is ROUGH_FLOOR, which is 0.045 of the
       * radius and therefore 0.61 m on a 13.6 m chamber. It is small in a
       * passage and it is not small in a room, and the analytic floor was
       * ignoring all of it. Measured on grove-01 k=0 and k=-1, 3509 probes
       * across the passage: the smooth floor disagreed with the drawn lattice by
       * more than 0.45 m at 160 of them, worst +0.93 m of hover and -0.89 m of
       * wading, mean 0.62 m — which is the ROUGH_FLOOR amplitude of the rings
       * those probes stand in, to within the noise.
       *
       * `floorY` is the function the object placers already use to seat a
       * stalagmite on the visible floor, and it is `floorAt` plus exactly that
       * displacement. Using it here is the same argument `halfWidthAt` and
       * `floorAt` each made in turn: solve the surface with the function that
       * DRAWS it, so the two cannot disagree.
       *
       * PRICED, because this runs three times a frame and the last four
       * constants in this file that were assumed free were not. 200 000 calls
       * standing in the 24 m chamber at 640 m in, median of five runs: 3.431 us
       * a call with it against 3.053 us without. That is 0.38 us, so three calls
       * a frame is 0.0011 ms — a thousandth of the 1.80 ms the whole frame costs
       * down there.
       *
       * THE CEILING DELIBERATELY DOES NOT GET IT. The roof carries the full wall
       * roughness rather than ROUGH_FLOOR and moves five times as far, and the
       * asymmetry the paragraph above describes is the reason: too LOW a ceiling
       * is the roof clamp pressing a body into a floor that is pushing it up, in
       * the dark. A ceiling that is up to a metre too high costs only that you do
       * not duck where you might have.
       *
       * A UNION OVER THE OVERLAPPING RINGS WAS THE OTHER CANDIDATE AND IT IS NOT
       * WHERE THE METRES WERE. `cave-floor` was reporting disagreements of 2.5 to
       * 3.9 m and blaming the single-ring answer; the drawn lattice at those very
       * columns is within 0.04-0.33 m of what this function already said. See the
       * ray-origin block in `scripts/cave-floor.mjs` for what those readings
       * actually were.
       */
      const floorRock = floorY(cave.c.k, path, bi, sh, nx, x, z);
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
       * Each block reports a dome — ramping to nothing at the rim — so the body
       * climbs one through the ordinary floor clamp with no step logic and
       * nothing to get caught on.
       *
       * THE BARGAIN THIS USED TO NAME — "the visible block is angular and does
       * not match the dome, and it is invisible because you cannot see your
       * feet" — WAS BEING PAID IN METRES, AND IT IS THE WHOLE OF THE HOVER.
       *
       * `b.rad` is the block's NOMINAL plan radius. `_emitBlock` draws the base
       * polygon with each of its seven corners at `rad * 0.26..1.5` of it, puts a
       * separate, smaller top polygon on top (`shrink` 0.28-0.72, shoved sideways
       * by up to half the radius), and then LEANS the whole solid over by up to
       * 0.7 — so the drawn top plane falls by up to 0.7 m per metre from the
       * centre. None of that reaches this function: the obstacle record carries
       * x, z, y, rad and top and nothing else.
       *
       * The dome was reading the nominal radius as if the block filled it. It
       * does not, and the gap is not subtle. Measured on grove-01 k=0 and k=-1,
       * 278 probes standing on a block, against the drawn geometry in the body's
       * own column:
       *
       *   dd / b.rad     drawn height, in units of b.top      p10   median   p90
       *   0.0 - 0.2                                         -0.02     0.94  1.00
       *   0.2 - 0.4                                         -0.00     0.58  0.98
       *   0.4 - 0.6                                         -0.13     0.05  0.93
       *   0.6 - 0.8                                         -0.13     0.02  0.69
       *   0.8 - 1.0                                         -0.27    -0.02  0.44
       *
       * Past 0.4 of the nominal radius the MEDIAN drawn block is gone — half of
       * those columns have bare floor in them. The old dome held full height out
       * to 0.55 of the radius and rode a smoothstep to the rim, so over most of
       * its own disc it was inventing a floor out of nothing: 173 of 278 stands
       * put the body more than 0.45 m above anything drawn, worst 2.35 m, mean
       * error 0.84 m. And because the ramp is gentle enough to climb — 0.12 m a
       * frame at a walk, against STEP_UP's 0.55 — the body is not stopped by it.
       * It walks up the invisible ramp and stands in the air over a boulder. That
       * is the "standing on nothing" report, and it is not the passage floor.
       *
       * WHAT IS CHOSEN HERE, AND WHY IT IS A CHOICE RATHER THAN A DERIVATION.
       * With only (dd, rad, top) the drawn height is very nearly bimodal — the
       * p10 and p90 columns above straddle the block's whole height in every
       * band — so no dome of this shape can be right; searched over 243 of them,
       * the best total error any of them reaches is 77 of 278 against this one's
       * 79, and the entire Pareto front trades hovering for wading at a fixed
       * total. So the front is picked at the point that removes the hover:
       * half the nominal radius, 0.8 of the height, linear. 173 hovering stands
       * become 10, the worst falls from 2.35 m to 1.18 m, and the mean error
       * falls from 0.84 m to 0.35 m — the lowest of any candidate. It is paid for
       * with 69 stands where the body wades through the outer, spiky part of a
       * slab instead of climbing it, up from 10. That direction is the right one
       * to be wrong in: a boulder you clip is a boulder, and a boulder you stand
       * two metres above is a bug in the sky.
       *
       * THE EXACT FIX IS ONE FIELD AWAY AND IS NOT IN THIS FUNCTION. `_emitBlock`
       * already knows `tiltX`, `tiltZ`, `shrink`, `skewX` and `skewZ`; if the
       * obstacle record built in `prepare` carried the tilt vector and the top
       * polygon's own centre and radius, this could evaluate the same tilted
       * plane the mesh draws and the disagreement would be the corner jitter
       * alone. That record is built in `prepare`, which is not this pass's to
       * change.
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
          // Half the nominal radius, 0.8 of the height, linear to the rim. See
          // the table above for where those three numbers come from; `dd > b.rad`
          // has already skipped, and this skips the outer half of that again.
          const t = 1 - dd / (b.rad * BLOCK_REACH);
          if (t <= 0) continue;
          const top = b.y + b.top * BLOCK_RISE * t;
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
      /**
       * HOW FAR PAST THE END OF THE PASSAGE THE BODY IS, WHICH NOTHING HAS EVER
       * MEASURED.
       *
       * There is no end-cap collision in this file and there never was. The only
       * push a cave applies is the wall's, and that one is horizontal and strictly
       * PERPENDICULAR by design — see the projection above, and the day it cost to
       * establish that a push aimed at the ring's own centre cancels forward
       * motion exactly and gives a stable equilibrium in a keyhole's slot. So
       * walking forward into the closed end of a passage met nothing at all: the
       * body carried on into a surface that is single-sided and facing away, which
       * draws nothing, and out through the mountain.
       *
       * REPORTED HERE, APPLIED IN `controller.js`, and the separation is the whole
       * point. Handing the overrun and the tangent to the controller lets it add a
       * correction that is purely axial, alongside a wall push that stays purely
       * radial — folding the two together is precisely the mistake the block above
       * records.
       *
       * MEASURED AGAINST `endRing` AND NOT AGAINST THE RING THE FIT PICKED.
       *
       * Reusing `alongComp` — the fit ring's own projection — was the first
       * version, and it has a hole in it exactly where the terminus is widest: in
       * a low wide section a body a few metres off the axis is better fitted by a
       * NEIGHBOUR of the end ring, so `bi` comes back short of it, no overrun is
       * reported, and the body walks on. `cave-end` measured 0.69 m past the end
       * plane on check-7's k=1, which is most of the ring step of margin
       * `closeEnd` leaves. Where the passage stops is a fact about the passage,
       * not about which ring happens to fit best, so it is asked of the end ring
       * every time — five extra operations, and only within a few rings of the
       * end, which is the only place `axial` can be non-zero anyway.
       */
      const endR = path.endRing ?? n - 1;
      _sample.axial = 0;
      if (bi >= endR - 3) {
        const ea = Math.max(0, endR - 1);
        const eb = Math.min(n - 1, endR + 1);
        let ex = path.x[eb] - path.x[ea];
        let ez = path.z[eb] - path.z[ea];
        const el = Math.hypot(ex, ez) || 1;
        ex /= el;
        ez /= el;
        _sample.axial = Math.max(0, (x - path.x[endR]) * ex + (z - path.z[endR]) * ez);
        _sample.axX = ex;
        _sample.axZ = ez;
      }
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
 * AND IT IS NOT FIVE FRAMES ANY MORE — IT IS ABOUT THREE HUNDRED. Worth stating
 * with the arithmetic, because "the build is armed half a minute out" is the
 * sentence four separate comments in this file lean on and it is the sentence
 * that a longer build could quietly falsify.
 *
 *   the whole build   174 ms of work for the median grove-01 cave and 245 for
 *                     the worst, measured over nine of them
 *   per frame         BUILD_MS, 0.6 ms, and ONE cave advances per frame
 *   so                290 frames median and 410 worst — 4.8 s and 6.8 s at
 *                     60 Hz, 2.0 s and 2.8 s at 144
 *   the walk in       BUILD_RANGE is 320 m and RUN is 8.2 m/s: 39 seconds
 *
 * Measured rather than only derived: `perf:cave-build` walks a body at a mouth
 * from 300 m and finishes three of the four caves that stream in on the way in
 * 900 frames of 60 Hz, which is fifteen seconds and a hundred and nine metres.
 *
 * FOUR MOUTHS IN RANGE IS THE CASE THAT USES THE MARGIN UP, because only one
 * cave advances per frame — four builds back to back is around twenty seconds
 * against thirty-nine. That is comfortable and it was NOT comfortable in the
 * wrong order, which is why `update` now takes the nearest unfinished cave
 * rather than the first the map happens to hold; see the note there.
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
    /**
     * ONE DEADLINE FOR THE WHOLE FRAME'S BUILD WORK, taken here and not inside
     * the cave.
     *
     * The plan and the emit are two halves of one build, and a cave that
     * finishes planning halfway through its slice should spend the rest of that
     * slice emitting rather than getting a second full budget for it. Taking the
     * clock once is also what makes BUILD_MS mean what it says: with a deadline
     * per phase, a frame that happened to cross a phase boundary would cost two.
     */
    const until = performance.now() + BUILD_MS;
    /**
     * THE NEAREST UNFINISHED CAVE, NOT THE FIRST ONE THE MAP HAPPENS TO HOLD.
     *
     * One cave advances per frame, so with four mouths in range the fourth
     * finishes four builds after the first — nineteen seconds at 60 Hz against
     * the thirty-nine BUILD_RANGE buys. That margin is fine, and it is fine in
     * the wrong ORDER: `this.caves` is keyed in the order `cavesNear` returned
     * the descriptors, which has nothing to do with where the player is going.
     * So the mouth being walked at could be the last of four to be built, for no
     * reason at all.
     *
     * A linear scan over at most five caves, once a frame, sorted by nothing —
     * just the minimum. It cannot make the build slower and it makes the one
     * case that matters four times safer.
     */
    let next = null;
    let nearest = Infinity;
    for (const cave of this.caves.values()) {
      if (cave.ready) continue;
      const d = Math.hypot(cave.c.x - camera.position.x, cave.c.z - camera.position.z);
      if (d < nearest) {
        nearest = d;
        next = cave;
      }
    }
    // ONE cave per frame, whatever else is waiting. See BUILD_MS.
    if (next && next.prepareSlice(until)) {
      /**
       * THE MOMENT IT BECOMES SAMPLEABLE, AND NOT AT THE NEXT RESCAN.
       *
       * `live` is what `caveSample` walks and it was only ever rebuilt in
       * `_rescan`, twice a second — so a passage whose collision line was
       * finished could be invisible to the body for another half second. That
       * was survivable while the plan arrived in one frame 320 m away; it is
       * worth closing anyway, because it is the same class of fault as the
       * `paths`-versus-`prepared` bug in the constructor and it costs one array
       * rebuild per cave per session to be rid of both.
       */
      if (!live.includes(next)) live = [...this.caves.values()].filter((c) => c.prepared);
      const whole = next.step(until);
      /**
       * IN THE SCENE AS SOON AS THERE IS A MESH, NOT WHEN IT IS FINISHED.
       *
       * The last six slices of a build are `Cave._prime` feeding the passage's
       * attributes to the GPU one per frame, and an object that is not in the
       * scene is not submitted and therefore uploads nothing. So the group goes
       * in the moment `_finish` has made a mesh — which draws no triangles until
       * the priming is over, by a draw range of zero.
       */
      if (next.group.children.length && next.group.parent !== this.group) {
        this.group.add(next.group);
      }
      if (whole) this.built++;
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
    // `prepared`, not `paths`: see the constructor. A cave halfway through its
    // plan has an array of paths and no bounding boxes to reject them with.
    live = [...this.caves.values()].filter((c) => c.prepared);
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
  /**
   * …AND THE TWO THINGS INSIDE THE CAVE THAT ALSO COME FROM THE SKY.
   *
   * `uDay` is a fixed colour and `uDayGain` was a fixed 1, so until this the
   * mouth of every cave in the world glowed the same daylight green at three in
   * the morning — and the beams, which are light down a hole in a mountain,
   * would have done the same. Both now ride the hour.
   *
   * MEASURED OFF THE HEMISPHERE AND NOT THE SUN, because the sun is a
   * direction: it sets before the sky does, it is occluded by the ridge the
   * cave is in for a good part of the day, and what actually comes down a
   * shaft or through a doorway is sky. `sky` arrives pre-multiplied by the
   * hemisphere's intensity (main.js does the 0.3), so its luminance is a clean
   * proxy for "how much daylight is there" — around 0.03 at the authored hour
   * and two orders of magnitude down at night. The smoothstep is generous at
   * both ends so dusk is a long fade rather than a switch.
   */
  setDaylight(dir, sun, sky, ground) {
    if (!sharedMaterial) return;
    const u = sharedMaterial.uniforms;
    u.uSunDir.value.copy(dir);
    u.uOpenSun.value.copy(sun);
    u.uOpenSky.value.copy(sky);
    u.uOpenGround.value.copy(ground);
    const lum = sky.r * 0.2126 + sky.g * 0.7152 + sky.b * 0.0722;
    const day = clamp01((lum - 0.0015) / 0.018);
    /**
     * The mouth keeps a quarter of its gain at midnight. It is the one thing in
     * the cave that has to stay findable — see the uDayGain note in the
     * material — and moonlight through a doorway is a real percept, whereas a
     * doorway that has gone completely black is a player walking into a wall.
     */
    u.uDayGain.value = 1.45 * (0.25 + 0.75 * day);
    // A third at night. See uDaylight in `shaftMaterial`.
    if (sharedShaft) sharedShaft.uniforms.uDaylight.value = 0.34 + 0.66 * day;
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
/**
 * `CAVE_RADIAL` is exported for the instruments and for nothing in the app.
 *
 * `cave-floor.mjs` has to tell the swept lattice from the loose rock in one flat
 * vertex buffer, and the only way to do that is rings x vertices-per-ring. It
 * had the second number as a literal 24, which was right when it was written and
 * silently wrong from the moment RADIAL went to 44 — see the note there. A gate
 * that carries its own stale copy of a constant is a gate that stops testing the
 * thing it names.
 */
export { SEC_WIDE, SEC_FLOOR, SEC_TALL, ROOF_ROCK, RADIAL as CAVE_RADIAL };
