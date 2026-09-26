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
 *   carrying — and SMALLER NOW THAN IT WAS, because dark adaptation is real:
 *   `pipeline.setCaveAdaptation` opens the frame's exposure to 2.1x over four
 *   seconds and shuts it in three quarters of a second, driven from `caveMix` in
 *   main.js. That is the whole eye rather than a glow on the rock two metres in
 *   front of it, so the fudge could be cut by a third.
 *
 *   AND THE OPENINGS THE BEAMS COME THROUGH, which for the whole life of this
 *   file were never drawn. `_buildShafts` puts a small irregular disc under the
 *   ceiling at each cone's apex and `_avenShade` darkens a ring of roof around
 *   it. It is not a hole in the mesh and could not be; it is the far end of an
 *   aven seen from the bottom, which is what you actually see.
 *
 *
 * AND SOMETHING LIVES IN IT.
 *
 * Everything above describes geology, and for a long time that was all there
 * was: a perfectly observed, completely dead room in which nothing moved except
 * water and spores and nothing reacted to a person walking through. One or two
 * chambers per cave now carry a roost of ninety to two hundred and twenty bats —
 * one merged quad mesh, one draw, zero per-frame CPU, the whole of the hanging,
 * the peel and the flight evaluated in the vertex shader from (`uTime`, seed,
 * `uFlush`). See the block over `placeBats`. `CaveField.update` writes `uFlush`
 * from one squared-distance test per roost and calls `onFlush` so the audio can
 * make the noise.
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

/**
 * The body's own half-width, in metres, as this file has to assume it.
 *
 * `controller.js` owns the real one (`RADIUS`) and nothing here should import
 * the player to place a hole in a wall — but `buildBranch` has to know roughly
 * how far short of a drawn surface a walking body is held, or it sites every
 * junction past the last place anybody can stand. Copied deliberately rather
 * than shared: it is used to leave ROOM, so it is safe while it is not smaller
 * than the truth, and a cave that assumed a slimmer player would be a cave with
 * doorways nobody fits through.
 */
const BODY_HALF = 0.34;

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
  /**
   * `t` OF 1.5, AND IT IS THE SHAPE THE SEEDS WITHOUT A MOUNTAIN GET.
   *
   * A room is what a hall becomes when `chamberFit` cannot reach HALL_MIN, so it
   * is not merely the middle of the range — it is the largest space that exists
   * at all on any ridge too thin to carry a chamber. At 1.18 it was 2.4 times as
   * wide as it was tall, which is a floor with a lid on it: you read the whole
   * volume in one glance from the doorway and there is nothing to walk toward.
   * 1.5 is still nearly twice as wide as tall — a room is breakdown, and
   * breakdown is a wide thing — but it puts the ceiling far enough up to be out
   * of the near-field term at the far side, which is the one cue that says a
   * space is bigger than a passage.
   *
   * It costs width for height at the same rate everything else in this table
   * does. It is worth it here and it is not worth much more, for the reason the
   * `hall` block gives: the return is asymptotic and the floor area is the part
   * that stops being there.
   */
  room: { w: 1.42, t: 1.5, f: 0.62, key: 0, rough: 0.36, scal: 0.1, seep: 1, lo: 7, hi: 15, vast: 1 },
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
   * `hi` OF 26, AND THE REASON IT MOVED IS THAT IT WAS NEVER THE ROCK.
   *
   * "It is the rock that binds and not the wish" is what stood here, on the
   * evidence that the widest ring measured across four seeds was 17.5-20.5 m
   * against a wish of 19 — which is the signature of a wish being GRANTED, not
   * of one being refused, and the 20.5 is Catmull-Rom overshooting between two
   * nodes that each got exactly what they asked for. What was actually binding
   * was `roofRoom`, which demanded as much mountain over the rim of a chamber as
   * over the middle of it; the block over `roofScan` is that mistake and its
   * arithmetic. With the requirement following the section's own dome, the same
   * ridges hand back 26 m where they handed back 19, and this is the wish
   * catching up with the rock rather than running ahead of it. Re-measured after
   * the change with the old 19 still in place: every seed pinned at 19-20.5
   * again, which is what says the ceiling was the table.
   *
   * At 26 m and `t` of 3.0 a hall is 70 m across and 92 m from the blocks to the
   * roof, against a body 1.68 m to the eye. Where the ridge is thin the same
   * table still produces a 5 m room and no hall at all, which is the property
   * that matters: `chamberFit` is what answers, and this only says how much it
   * is allowed to answer with.
   *
   * `t` OF 3.0 IS A SMALL MOVE AND KNOWN TO BE ONE. Height is asymptotic in `t`
   * for fixed rock — 2.4 spends 75.8% of the available headroom on ceiling and
   * 3.0 spends 77.9% — so the extra 0.6 buys 3% of ceiling and pays 18% of the
   * width for it. It is worth exactly that much and no more: what actually made
   * the chamber taller is the roof rule and `hi`, and raising `t` further would
   * be trading away the floor for a number that has stopped moving.
   */
  hall: { w: 1.35, t: 3.0, f: 0.55, key: 0, rough: 0.46, scal: 0.04, seep: 1.2, lo: 9, hi: 26, vast: 1 },
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
 * 9 m is a ceiling 27 m over the axis and 24 m across, which is unambiguous
 * against a passage that has been four metres wide for two hundred. Where the
 * ridge will carry one at all the walk usually gets considerably more than the
 * minimum.
 *
 * IT WAS RAISED TO 11 WITH `t` AND THAT WAS A MISTAKE WORTH KEEPING THE RECORD
 * OF, because it is the one change in this pass that made the world smaller.
 * The reasoning was that the silo ratio `t / (2 * w)` had gone from 0.89 to
 * 1.11, so the same radius was a worse silo and the floor should follow. The
 * ratio moved and the SHAPE did not: at 9 m a hall is 27 m tall and 24 m
 * across, which nobody would call a silo — 1.11 is nowhere near the ratio that
 * reads as one.
 *
 * What raising it actually did was demote every chamber the rock would carry at
 * 9-11 m into a room, and a room is 1.5 `t` against a hall's 3.0. Measured over
 * eight seeds: three of them came out with no space over 25 m tall anywhere,
 * two with nothing over 15, and the mean tallest section in the world FELL from
 * 44.9 m to 40.9 while the maximum rose to 70.9. That is the signature of a
 * threshold, not of a size: the seeds with deep mountain got much bigger and
 * the seeds without lost their only chamber. Lowering it back is worth more
 * than everything else in this block, because the cave a player gets is the one
 * their seed gives them and not the average.
 */
const HALL_MIN = 9;

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
 * Half the width of FLOOR every ring is guaranteed, in metres, measured where
 * the feet are rather than where the shoulders are.
 *
 * MIN_HALF above is "does the body fit". This is "is it a floor or a rut", and
 * they are not the same question: a keyhole is six metres wide at the chest and
 * was one and a half at the ankle, so the body fitted perfectly and walking down
 * it felt like walking in a gutter — step half a metre sideways and the ground
 * is at your knee. See the block in `resample` that applies it.
 *
 * 1.50 m, and it was set by photographing the same ring at three values rather
 * than by arithmetic, because the complaint was about a feeling and the
 * arithmetic cannot see one. Shot at `.shots/kinds-<value>/keyhole.png` — and
 * NO GLOB IN A BLOCK COMMENT, because a star followed by a slash ends it and
 * the error then points at an innocent word three lines down. grove-01 k=0 ring
 * 300, r = 3.64:
 *
 *   shipping before   floor 1.65 m   a slot with shoulders at chest height; you
 *                                    walk along the bottom of a trench
 *   FLOOR_HALF 1.15   floor 2.65 m   wide enough to walk two abreast and still
 *                                    unmistakably a trench from inside it
 *   FLOOR_HALF 1.50   floor 3.4 m    a passage with a sunken middle; the round
 *                                    bore is still overhead, the rut is gone
 *   FLOOR_HALF 1.90   floor —        `key` solves to 0. No keyhole at all.
 *
 * So the useful range is narrow and this sits at the top of it. What it costs is
 * slot: at 1.50 a keyhole cut at 3.6 m of radius keeps 27% of its pinch and one
 * cut at 5 m keeps 63%, so the shape survives where the rock is generous and
 * gives way where it is not. 1.15 is the setting to go back to if the slot is
 * wanted more than the floor is.
 *
 * For scale: a canyon — the shape whose whole character is walking with your
 * shoulders turned — measures 2.9 m of floor, and it is the only other section
 * anywhere near this narrow.
 */
const FLOOR_HALF = 1.5;

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
 * How far the brow's thickest point leans off vertical, as a fraction.
 *
 * The brow above is a lobe centred exactly on the top of the arch, which makes
 * the one feature the mouth has that is not a circle perfectly bilaterally
 * symmetric — and bilateral symmetry about a vertical axis is the single most
 * reliable way to say "this was made" there is. A real entrance overhangs more
 * on one side than the other because one side is up-dip and the other is not.
 *
 * Signed per cave off the bedding bearing (`lean`, set with `bedX` in
 * `_prepare`), so it costs no random numbers and two caves in the same ridge
 * lean opposite ways.
 */
const HOOD_LEAN = 0.55;

/* -------------------------------------------------------------------------- *
 *  THE OUTLINE — WHY THE CRAG WAS AN EGG
 * -------------------------------------------------------------------------- *
 *
 * Everything above buys MASS at the doorway. It bought it, and from sixteen
 * metres out the mouth still read as one smooth convex dome with a hole in it.
 * No brow, no broken rim, nothing that says the rock fell apart and left a way
 * in. Where that came from is worth writing down, because two plausible answers
 * are both wrong and the measurement that settles it takes five minutes.
 *
 * THE FIRST WRONG ANSWER is that the shell is not rough enough. It is: `amp` is
 * multiplied by up to 4.2 on the hood precisely so the crag is rougher than the
 * passage, which at the mouth's own radius is about +/-0.85 m of relief. The
 * trouble is that all of it comes from `rock`, whose loudest octave is at 0.21
 * cycles per metre — a five-metre wavelength — so +/-0.85 m arrives as a gentle
 * bulge across a twelve-metre doorway. It is relief with no EDGE in it, and an
 * outline is made of edges.
 *
 * THE SECOND WRONG ANSWER, and the one that cost the first attempt at this, is
 * that the outline is the burial clamp's line, `surf + proud`, which is smooth
 * because the height field is smooth and `proud` is that same five-metre noise.
 * That reasoning is sound and the conclusion is false, because AT THE CROWN THE
 * CLAMP NEVER FIRES. Its guard is `surf > inner`: the shell is only pulled down
 * where the hillside already stands over the cavity, and over the doorway it
 * does not — that is what a doorway is. Measured on grove-01 k=0, hood ring 0's
 * highest vertex sits 12.9 m ABOVE the terrain under it. Half of every hood ring
 * is buried and clamped and it is the half nobody can see; the visible half is
 * the raw shell.
 *
 * So the silhouette is `cavity ellipse + HOOD_THICK * (1 + brow)`, which is an
 * ellipse offset by a near-constant, which is an egg. Ledges hung on `proud`
 * change the buried shoulders and nothing else, which is exactly what the
 * pictures showed the first time.
 *
 * BEDDING COURSES, BECAUSE THE ALTERNATIVE IS FUZZ. High-frequency random offset
 * gives a bumpy dome, which is an egg with acne. What a crag over a real
 * entrance does is stand in COURSES: the rock is bedded, each bed weathers back
 * its own distance, and each course therefore ends in a different place, with an
 * overhanging lip on its underside where the bed above has not retreated as far.
 * That is a stack of horizontal steps; it is ORIENTED, and the eye reads
 * orientation as geology long before it reads amplitude as detail. It also gives
 * the arch two things it had neither of: a hard horizontal edge over the doorway
 * where a course caps it, and a pair of ragged shoulders where the courses cut
 * the arc at different depths.
 *
 * Same 2.40 m spacing and same per-cave dip the MATERIAL's bedding already uses
 * (see the `bed` block in the fragment shader), so a step in the geometry lands
 * on a band in the texture instead of cutting across three of them — one rock,
 * rather than two opinions about it.
 *
 * WHERE IT IS SIGNED AND WHERE IT IS NOT. On the free shell the courses go both
 * ways: standing out is a ledge and cut back is a recess, and you need both or
 * the mass only ever grows. On the CLAMP LINE only the positive half is used,
 * and that is a safety property rather than a taste — `proud` is the allowance
 * the clamp is given over the ground, and a negative one sinks the shell below
 * the hillside, far enough below that it can pass `inner` and come out inside
 * the tube it is shelling. Rock added over a doorway can never open one; rock
 * taken away can, and cave-mouth's BREACH count has no tolerable value but zero.
 */
/**
 * How far a block may stand out of the face, in metres, at the rim.
 *
 * Signed, so 2.4 is a range of nearly five metres against a shell that is 6.5 m
 * thick over the doorway — which sounds violent and is the point. At 1.7 the
 * measured outline moved by about a metre across the whole visible arc and the
 * pictures were indistinguishable from the ones before it: on a twelve-metre
 * doorway seen from sixteen metres, a metre of relief spread over a third of the
 * arc is a curve, not an edge.
 */
const HOOD_LEDGE = 2.5;
/** The hill's own bedding spacing. Change this and the material disagrees. */
const HOOD_BED = 2.4;
/**
 * …and the joint spacing across it, which has no counterpart in the material.
 *
 * Bedding alone was not enough and the measurement says why. The crown of the
 * arch is where the outline is nearly horizontal, so the bedding coordinate
 * barely changes along it — grove-01 k=0's whole visible arc spans about two and
 * a half beds, which is two steps. A rock face does not weather back in
 * horizontal strips; it comes away in BLOCKS, where the bedding planes meet a
 * near-vertical joint set, and it is the joints that put an edge in the part of
 * the outline the bedding cannot reach.
 *
 * Wider than the beds are tall, because that is the aspect a jointed limestone
 * actually breaks at, and because a block squarer than its bed reads as masonry.
 */
const HOOD_JOINT = 3.4;
/**
 * How much of the shell's thickness a course is never allowed to eat.
 *
 * The shell is single-sided with the cavity inside it, so thinning it toward
 * zero does not make a thin lip — it makes the two surfaces cross, and a crossed
 * shell at the rim is a view of the inside of the mouth from outside it. At the
 * crown `thick * (1 + brow)` is 6.5 m and the courses are worth 1.7, so this
 * floor is slack by a factor of three in the place it matters; it exists so that
 * raising HOOD_LEDGE later cannot quietly turn into a hole.
 */
const HOOD_MIN_THICK = 0.35;

/**
 * The blocks, as a signed offset in units of HOOD_LEDGE.
 *
 * Two coordinates, each quantised. `u` is the bedding-plane coordinate — the
 * same dipped, 2.40 m-spaced plane the fragment shader bands the rock with — and
 * `v` runs along the strike, perpendicular to the dip azimuth in plan, at the
 * joint spacing. Their integer parts name a block; the block's own reach is a
 * hash of the pair, so the face is a wall of rectangles each of which has come
 * away by its own amount.
 *
 * The blend happens over the last fifth of a block in each axis, and the
 * narrowness of that band is the whole effect. Four fifths of a block is FLAT
 * and then the surface steps. Interpolating across the whole block gives two
 * crossed sine waves, which is a lumpy dome — the thing being fixed. A fifth of
 * 2.4 m is 0.48 m, which is about one vertex at this mesh density, so the step
 * lands as an edge and not as a ramp.
 *
 * `lipF` juts the bottom fifth of every bed a little further out still: the
 * overhang under each course, and the one detail that stops a stack of steps
 * reading as stairs.
 *
 * Bilinear over the four corners rather than nearest, because a nearest-block
 * lookup tears at both boundaries at once and the corner where four blocks meet
 * then has four different heights in one quad.
 */
function blockLayer(u, v, kk, o, riser) {
  const i = Math.floor(u);
  const j = Math.floor(v);
  /** One block's reach. Integer arguments, so this is a hash and not a lerp. */
  const at = (bi, bj) => noise2(bi * 4.7 + bj * 1.31 + kk + o, bj * 3.9 - bi * 2.3 + o);
  const m = smoothstep(clamp01((u - i - (1 - riser)) / riser));
  const q = smoothstep(clamp01((v - j - (1 - riser)) / riser));
  const a = at(i, j) + (at(i + 1, j) - at(i, j)) * m;
  const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * m;
  return a + (b - a) * q;
}
function blockFace(x, y, z, bx, by, bz, sx, sz, k) {
  const u = (x * bx + y * by + z * bz) / HOOD_BED;
  const v = (x * sx + z * sz) / HOOD_JOINT;
  const kk = k * 11.3;
  /**
   * TWO SCALES, because one leaves the faces BETWEEN the blocks flat.
   *
   * At a single scale the outline broke properly and the mass then read as a cut
   * gem: half a dozen large plane facets meeting at clean edges. A half-scale
   * set at 38% is what a jointed rock actually has — big blocks that are
   * themselves broken — and it is the difference between a faceted solid and a
   * quarried one.
   *
   * Its riser is wider, 0.35 of a block against 0.2, and that is a sampling
   * limit rather than a taste: a 1.2 m block with a 0.24 m step is a step
   * narrower than the vertex spacing, so where the edge lands is decided by
   * which vertex happens to be nearest to it.
   */
  const lipF = (1 - smoothstep(clamp01((u - Math.floor(u)) / 0.2))) * 0.35;
  return blockLayer(u, v, kk, 0, 0.2) + blockLayer(u * 2, v * 2, kk, 37.1, 0.35) * 0.38 + lipF;
}

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
 * THE HOLD PROBABILITIES, AS A RANGE RATHER THAN A NUMBER.
 *
 * The reasoning is at the `holdP` line inside `buildNodes` and it is the most
 * load-bearing paragraph in the walk. In short: a corner costs metres, metres
 * are depth and depth is the chambers, so the file has always been right to
 * refuse to lower the hold — and it was only ever right because the hold was
 * FLAT. Keyed to the rock, the same corners land where they are free.
 *
 * HOLD_BASE is what the first node or two use, before there is a rock reading
 * to compare against, and is the number the flat rule shipped with.
 *
 * The two ends are symmetric about 0.61 rather than about 0.62, and that
 * hundredth is not a rounding error — it is a deliberate hair of net turning
 * that costs about a metre of passage in three hundred. Widen the gap before you
 * move the centre: the gap is free and the centre is not.
 */
const HOLD_BASE = 0.62;
const HOLD_THIN = 0.76;
const HOLD_RICH = 0.46;

/**
 * A cave's centre line.
 *
 * Nodes first — a coarse walk of 7-21 m steps with the heading and pitch drawn
 * per step — then resampled by Catmull-Rom into rings. Doing it in two stages is
 * what makes the shape controllable: the constraints (stay under the mountain,
 * do not cross yourself, do not climb) are checked once per node against real
 * `heightAt` samples, and the spline then guarantees the result is smooth
 * whatever the constraints did to it.
 *
 * Sliced per node — see the generator note above. A node is one reach plus the
 * corner that ends it, twelve attempts at worst, and it is the unit the walk's
 * cost scales in: 36-53 of them at 0.05-0.15 ms each. That range and the
 * attempt count are both quoted from the code below rather than remembered —
 * this line has said "28-41 of them, six attempts at worst" through two changes
 * to each, which is the same drift `count` and `step` were carrying.
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
   *
   * 135 NOW, AND IT IS STILL NOT WHAT BINDS. Measured on grove-01 k=0 the
   * deepest node reached 80 m below the mouth against a floor of 110, so the
   * floor has never once been the thing saying stop — the pitch envelope is.
   * Raising it is therefore free in the ordinary case and only matters on the
   * seed where a passage does run all the way down, which is exactly the seed
   * where the extra rock buys the biggest chamber in the world.
   */
  const bottom = nodes[0].y - 135;
  /**
   * …and how many reaches it gets, which is a different question.
   *
   * A node is a straight run on one joint plus the corner that ends it, so this
   * is "how many times does the passage do something", not a length. 18-25 gave
   * 300 m of passage; 28-41 gives roughly 500-700 m, and the extra is spent
   * where it is worth most because the pitch envelope below weights descent
   * toward the back half — the first third is the same cave it always was and
   * everything past it is somewhere the player has not been.
   *
   * 36-53 NOW, AND MOST OF IT IS BUYING BACK LENGTH RATHER THAN ADDING IT. The
   * reaches below are shorter and the walk holds its joint less often, which is
   * what "more twists and turns" means in this generator — but both of those cut
   * metres per node, so at 28-41 the passage would have come out shorter than
   * the one it replaced. Roughly a third more nodes against roughly a fifth less
   * distance each is a passage of about the same length with half again as many
   * corners in it, which is the trade that was wanted.
   *
   * …AND FOR A YEAR THIS COMMENT WAS THE ONLY PLACE EITHER HALF OF THAT EXISTED.
   *
   * The line below computed 32-46, not 36-53, and the reaches below it computed
   * 13-24 and 8-13, not the 11-21 and 7-11 their own block claimed. Both halves
   * of the trade were written down, argued for, and never landed — so the walk
   * that shipped was the LONG-REACH, FEW-NODE one, which is measurably straighter
   * than the file believed it was. Measured on the shipped build: one corner over
   * 45 degrees per 41 m, and grove-02 k=-1 turning 117 deg/100 m with four
   * corners in 275 m. That is the room's "it looks like one continuous tunnel",
   * in this file's own units, and the fix was to make the code say what the
   * comment already said.
   *
   * THE PAIR IS LENGTH-NEUTRAL BY CONSTRUCTION, WHICH IS WHY IT IS SAFE AND
   * LOWERING THE HOLD IS NOT. Mean step at a 0.62 hold was 0.62x18.5 + 0.38x10.5
   * = 15.5 m; at the shorter reaches it is 0.62x16 + 0.38x9 = 13.3 m, down 13.7%.
   * Mean count goes 39 -> 44.5, up 14.1%. The product — which is the passage's
   * length, and therefore its descent, and therefore `deep`, and therefore the
   * chambers — moves by 1.4%. What DOES move is corners per metre, up about a
   * sixth, because the joint decisions per node are unchanged and there are more
   * nodes in the same distance. Shortening a reach does not make the walk agree
   * to turn more often; it makes each straight run shorter. That is a different
   * lever from the hold probability and it does not have the hold's price.
   *
   * AND IT IS WHERE THE MAIN WALK'S TURNING STOPS BEING TUNED, WHICH IS A
   * FINDING RATHER THAN A DEFAULT. Asked for more twists, the obvious levers are
   * here: hold the joint less often, take shorter reaches, add nodes to pay for
   * both. A/B over twelve caves on four seeds, same seeds both arms —
   *
   *              passages   metres   deg/100m   tallest   m over 15 m
   *   0.62 hold      5.8      905       257      45.9         192
   *   0.52 hold      5.0      797       289      42.7         144
   *
   * — so a ninth more turning costs a ninth of the length, a seventh of the
   * passages and a QUARTER of the tall chambers. Depth is the mechanism: descent
   * is `sin(pitch) x step` per node, `deep` is what lets `pickType` reach a hall
   * at all, and `chamberFit` only grants a big radius where there is mountain
   * over it — so a walk that turns more arrives shallower and the chambers stop
   * being available. Fewer passages is the same fault twice over, because a
   * shorter main line carries fewer junctions.
   *
   * READ THAT A/B AGAIN AND IT IS NOT ABOUT TURNING, IT IS ABOUT LENGTH. Both
   * arms ran the same `count`, so dropping the hold to 0.52 cut mean step by 5%
   * by arithmetic and the measured length fell 12% — the other 7% is refusals,
   * because a twistier line meets its own beads more often. The chambers went
   * with the length, not with the degrees. That is why this file may buy turning
   * with nodes and may not buy it with the hold, and it is why the hold rule
   * below is now REDISTRIBUTED rather than lowered.
   *
   * Nobody has ever described a cave by how much it turned. The turning also
   * went into the BRANCHES, where there is no depth envelope to spend and no
   * chamber to lose — see the heading block in `buildBranch`.
   */
  const count = 36 + Math.floor(rng() * 18);

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
   * THREE joint bearings and their reciprocals, the first pinned to the heading
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
   *
   * THE THIRD SET IS WHAT MAKES A CORNER UNPREDICTABLE, and the case for it is
   * the same geology the second one came from — limestone has "two or three
   * fracture directions" and this file only ever gave it two. With two, every
   * corner in a cave is the same corner: there is exactly one bearing that is
   * neither where you are pointing nor a reversal, so the moment the walk leaves
   * its joint you already know the angle, and after three of them the player
   * knows it too. A third bearing gives every corner two possible answers, and
   * because it is drawn SHALLOWER than the second — 0.42-0.85 rad against
   * 0.95-1.55 — the two are different in kind rather than merely in sign: one is
   * a turn you take, the other is a bend you follow round.
   */
  const jointB = heading + rngRange(rng, 0.95, 1.55) * (rng() < 0.5 ? -1 : 1);
  const jointC = heading + rngRange(rng, 0.42, 0.85) * (rng() < 0.5 ? -1 : 1);
  const joints = [heading, heading + Math.PI, jointB, jointB + Math.PI, jointC, jointC + Math.PI];
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

  /* ------------------------------------------------------------------------ *
   *  HOW MUCH ROCK THERE IS HERE, CARRIED FROM ONE NODE TO THE NEXT
   * ------------------------------------------------------------------------ *
   *
   * The hold rule below spends its corners where the mountain is thickening and
   * drives straight where it is thinning, and this is the state that lets it.
   *
   * IT COSTS NOTHING TO MEASURE, WHICH IS THE ONLY REASON IT IS AFFORDABLE. The
   * ravine veto already runs `roofScan` on the candidate it accepts — seventeen
   * `heightAt` samples, the single most expensive thing in the walk — and then
   * throws the reading away after asking it one yes/no question. `rockOver` is
   * the same reading asked a second question, in arithmetic: the metres of
   * mountain over the axis, at the tightest of the axis sample and the inner
   * rosette ring. The outer ring is deliberately left out; it stands 1.15
   * half-widths off the axis, so on a chamber it is thirty-five metres down the
   * flank, and the block over `roofScan` is about exactly that mistake — out
   * there the reading is a fact about the footprint's size rather than about the
   * rock.
   *
   * AND IT IS COMPARED AGAINST ITSELF, NOT AGAINST A CONSTANT, WHICH IS THE
   * WHOLE ROBUSTNESS ARGUMENT. Absolute metres of overburden are not comparable
   * between two caves or between two ends of one cave: the walk descends up to
   * eighty metres below its mouth while the hillside climbs over it, so a
   * threshold that reads "generous" near the entrance reads "thin" three hundred
   * metres in, and a threshold tuned on one seed's ridge is meaningless on a
   * seed whose ridge is half as high. A fast running mean and mean-deviation —
   * about three to four nodes of memory — turn the reading into "is there more
   * rock here than a few reaches back", which is scale-free, seed-free and
   * depth-free.
   *
   * AND IT IS DETRENDED, WHICH IS NOT A REFINEMENT — IT IS THE DIFFERENCE
   * BETWEEN THIS RULE AND THE ONE THE FILE ALREADY REFUSED.
   *
   * A single running mean LAGS a trend, and a cave walk's overburden is nothing
   * but trend: the walk dives while the hillside climbs, so `scanOver` grows
   * more or less monotonically from the mouth to the deepest node. Against a
   * lagging mean, every node in a monotone climb reads "more rock than lately"
   * — so `rockGen` saturates at 1 for the whole passage and the rule degenerates
   * into a flat hold of HOLD_RICH. Simulated over the plausible shapes of the
   * signal (flat, noisy, trending either way, random walk, a ridge crossed at
   * two wavelengths, a step), the single-mean form came out at a mean hold of
   * 0.530 on the trending case: which is 0.52, which is the arm of the A/B over
   * `count` that cost a QUARTER of the tall chambers. The rule would have
   * reproduced the exact failure it was written to avoid, on the one signal
   * shape a real cave actually has.
   *
   * So the deviation is measured against the running deviation — a second mean,
   * which removes a linear trend the way the first removes a level. Over the
   * same set of signal shapes the realised mean hold then stays inside
   * 0.593-0.647 against a 0.62 constant, and the excursions are on the SAFE
   * side (more holding, which costs turning and not chambers). `rockGen` is
   * centred on 0.5 by construction, and that is what makes the hold rule below a
   * redistribution rather than a reduction.
   *
   * What it now says, in words: turn where the rock is thicker THAN THE TREND
   * PREDICTS, drive on where it is thinner than that. Steadily deepening is not
   * an invitation to corner; a pocket of mountain is.
   */
  /** Metres of mountain over the last accepted node. Null until one is placed. */
  let rockAvg = null;
  /** …and the running change in it, which is the trend that gets subtracted. */
  let rockDev = 0;
  /** Running mean absolute detrended deviation, in metres. Seeded at a plausible
   *  spread so the first few nodes are not all saturated at one end. */
  let rockSpread = 6;
  /** How fast all three track. 0.3 is three to four nodes of memory: long enough
   *  that the comparison means something spatially, short enough to follow a
   *  ridge. Simulated at 0.3 and 0.45; both hold the mean, 0.3 keeps its worst
   *  excursion on the safe side. */
  const ROCK_RATE = 0.3;
  /** 0 = thinner than the trend predicts, 1 = thicker. Null before the first. */
  let rockGen = null;

  /**
   * WHAT THE WALK DID, FOR THE BUILD TO REPORT AND A GATE TO READ.
   *
   * Nothing in this file has ever counted its own corners, so every statement
   * about how twisty the walk is has come from a script that re-derived it from
   * the drawn rings — which is a different quantity (the resample smooths the
   * joints) and which nobody runs when they change a constant here. These are
   * the walk's own numbers, in the walk's own units, and `holdSum / holdN` in
   * particular is the one that has to be checked after any change to the rule
   * below: it is the realised mean hold probability, and if it has moved down
   * from 0.62 then the chambers are being spent whether or not that was
   * intended.
   */
  const stats = {
    nodes: 0,
    corners: 0,
    escapes: 0,
    holdSum: 0,
    holdN: 0,
    rockSum: 0,
    rockN: 0,
    genSum: 0,
  };

  /**
   * EVERYWHERE THE PASSAGE ALREADY IS, at a resolution the clash test can use.
   *
   * One bead per node and one at the midpoint of every reach, each carrying the
   * half-width of the widest section it stands for — so a bead is a sphere the
   * new reach must stay outside of. Built as the walk goes rather than derived
   * afterwards, because the test runs inside the attempt loop and rebuilding a
   * list of a hundred entries six times a node would be the only allocation in
   * this function.
   *
   * The mouth nodes are in it: the tube is not allowed to run back into its own
   * doorway either, and that is the one crossing a player would certainly find.
   */
  const beads = [];
  /** Metres of centre line walked so far, carried on every bead. */
  let walked = 0;
  const bead = (a, b) => {
    /**
     * 1.15 FOR THE SPLINE'S OWN OVERSHOOT, AND IT IS NOT A SAFETY FACTOR.
     *
     * `resample` runs Catmull-Rom over the RADIUS as well as the position, and
     * Catmull-Rom is interpolating rather than convex — so the fattest ring
     * between two nodes is fatter than either of them. Measured at 26.6 m
     * between two 19 m nodes. A clash test that quotes node radii is therefore
     * testing a passage narrower than the one that will be drawn, by up to a
     * seventh, everywhere. `terminusFit` has always padded its chamber for this;
     * the walk did not, and the difference showed up as ring pairs a hundred
     * metres apart along the line sitting seven metres apart in space with every
     * node centre legitimately clear.
     */
    const half = Math.max(a.r * a.w, b.r * b.w) * 1.15;
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    beads.push({
      x: (a.x + b.x) * 0.5,
      y: (a.y + b.y) * 0.5,
      z: (a.z + b.z) * 0.5,
      half,
      at: walked + len * 0.5,
    });
    walked += len;
    beads.push({ x: b.x, y: b.y, z: b.z, half: b.r * b.w * 1.15, at: walked });
  };
  beads.push({ x: nodes[0].x, y: nodes[0].y, z: nodes[0].z, half: nodes[0].r * nodes[0].w * 1.15, at: 0 });
  for (let i = 1; i < nodes.length; i++) bead(nodes[i - 1], nodes[i]);

  for (let i = 0; i < count && !cliffed; i++) {
    yield 'walk';
    let placed = false;
    /**
     * Twelve attempts, then take the last one.
     *
     * The rejection is for self-intersection: two arms of the passage crossing
     * are not a junction, they are each other's back faces, and from inside it
     * reads as a hole in the wall with nothing behind it. Retrying the HEADING
     * rather than resampling the whole node keeps the walk moving forward — a
     * scheme that could reject its way into a corner would stall, and this one
     * cannot, because after the last try it accepts.
     *
     * IT WAS SIX, AND THE LAST-TRY ESCAPE IS WHY THAT NUMBER MATTERS MORE THAN
     * IT LOOKS. Everything below is a veto and the final attempt honours none of
     * them, so the count is not "how hard does it try" — it is the mixture
     * between a walk that obeys its constraints and one that ignores them. At
     * six attempts against a joint set of three bearings and reaches under
     * twenty metres, the vetoes were firing often enough that a large share of
     * nodes were arriving by the escape hatch, and the escape hatch is exactly
     * where the self-crossings come from: measured on eight seeds, 122 ring
     * pairs per cave sharing volume against 3.5 before the walk was shortened.
     *
     * Twelve is not twice the cost. Each attempt is dominated by `roofScan`,
     * seventeen `heightAt` samples, and only runs at all if the cheaper tests
     * before it passed — and the whole point is that most nodes still place on
     * the first or second try. What changes is the tail.
     */
    for (let attempt = 0; attempt < 12 && !placed; attempt++) {
      /**
       * Stay on the joint, or take the corner. Attempts past the first are
       * allowed to jump, which is what keeps the rejection below from stalling
       * a walk that has boxed itself in against its own earlier reaches.
       */
      /**
       * 0.62, DOWN FROM 0.66, AND THE SMALL MOVE IS THE POINT.
       *
       * The hold probability is the single strongest control on how twisty a
       * cave is, because it is a geometric distribution: at 0.66 a reach is a
       * mean of 2.9 nodes long, at 0.62 it is 2.6, at 0.5 it is 2.0.
       *
       * 0.5 WAS TRIED AND THE MOUNTAIN COULD NOT TAKE IT. Twist is not free: a
       * passage that turns more puts more line into the same volume of rock, and
       * past some density it starts running back through itself. Measured over
       * eight seeds, turning went from 170 degrees per hundred metres to 335 and
       * the number of ring pairs sharing volume went from 3.8 a cave to 45 —
       * which is not a cosmetic fault. It is a hole in the wall with the back of
       * another wall behind it, and it is what made two mouths of three
       * unwalkable. The baseline's own twistiest seed, at 336 degrees, was also
       * the only one of the eight with any crossings at all, which is the same
       * relationship read off the old numbers.
       *
       * So the twist that ships is the twist the rock will carry. Between this,
       * the third joint set and the shorter reaches it is about half again the
       * baseline rather than double it — and the third joint set is where most
       * of the CHARACTER came from anyway, because it is what makes a corner
       * something other than the one corner this generator used to have.
       */
      /**
       * …AND A RETRY IS NOT ALWAYS A CORNER, WHICH IS A FEEDBACK LOOP THIS WALK
       * HAD ALL ALONG AND ONLY NOW BITES.
       *
       * Every attempt past the first used to snap to a different joint, on the
       * reasoning that the straight-on answer has just been refused. That is
       * true of the HEADING and false of the candidate: `step` is re-drawn every
       * attempt too, so holding the joint at eleven metres is a genuinely
       * different node from holding it at twenty-three, and it is the one that
       * keeps the passage going where it was going.
       *
       * Left as it was, refusals turn into corners one for one — so a walk in a
       * crowded piece of rock corners at every node, which puts it in a tighter
       * piece of rock, which refuses more. grove-01's k=0 came out of that loop
       * at 437 degrees per hundred metres against a mean of 279, and 262 m long
       * against a mean of 855. Every third retry holding breaks the loop without
       * weakening any of the vetoes: it is another candidate, not another
       * acceptance.
       */
      /**
       * 0.62, AND IT HAS BEEN MEASURED RATHER THAN LEFT ALONE. See the A/B in
       * the block over `count`: this is the one number that decides how much the
       * main line turns, and every tenth taken off it comes out of the length,
       * the chamber heights and the junction count together.
       */
      /**
       * …AND IT IS NO LONGER ONE NUMBER, BECAUSE A FLAT COIN IS WHY TURNING HAD
       * A PRICE AT ALL.
       *
       * Read the A/B over `count` again with the mechanism in hand. Turning costs
       * chambers because turning costs LENGTH — a corner is taken in a short step
       * — and length is descent and descent is `deep` and `deep` is what lets
       * `pickType` reach a hall. Nothing in that chain says a corner is bad. It
       * says a corner spends metres, and the question the flat coin never asked
       * is what those metres BUY.
       *
       * A corner spent where the mountain is thinning buys nothing twice over.
       * There is no chamber to be had there whatever the walk does — `chamberFit`
       * hands back a corridor — and the ravine veto is about to refuse half the
       * candidates anyway, so the corner arrives by the escape hatch and lands
       * somewhere the burial will narrow. What the walk needs in thin rock is to
       * get OUT of it, and the way out is a long reach on the joint it is already
       * on.
       *
       * A corner spent where the mountain is thickening is nearly free. The rock
       * over the axis is what sizes a chamber, and it does not care which
       * direction the axis arrived from; the reach is short, but a short reach
       * under thick rock still descends (the pitch envelope is per-node, not per
       * metre) and still earns `deep`. And it is the corner the player is paid
       * for, because a corner is only worth taking where there is something on
       * the other side of it big enough to be worth hiding.
       *
       * So the SAME NUMBER OF CORNERS, MOVED. 0.76 where the rock is thinning,
       * 0.46 where it is thickening, and `rockGen` is centred on 0.5 by
       * construction (see the block over `rockAvg`), so the realised mean is
       * 0.61 — a hundredth off the number the A/B blessed, and within the noise
       * of it. This is deliberately not the place to also LOWER the mean: the
       * length that buys the extra turning comes from `count`, where it is paid
       * for in nodes, and not from here, where it is paid for in chambers.
       *
       * `stats.holdSum` exists so that "the realised mean is 0.61" is a number a
       * gate can read rather than a claim in a comment. If it comes out under
       * 0.58 on any seed, the spread below is too wide for that seed's rock and
       * the chambers are being spent.
       */
      const holdP =
        rockGen === null ? HOLD_BASE : HOLD_THIN + (HOLD_RICH - HOLD_THIN) * rockGen;
      if (attempt === 0) {
        stats.holdSum += holdP;
        stats.holdN++;
      }
      const hold = attempt === 0 ? rng() < holdP : attempt % 3 === 0;
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
       *
       * 11-21 AND 7-11 NOW, WHICH GIVES UP SOME OF THAT DELIBERATELY. The
       * composition argument is still right and it is not the only thing a reach
       * decides: it is also how far you walk before the cave does anything, and
       * a reach at the edge of the fog is by definition one you spend entirely
       * looking at the same wall. The longest reaches still reach 21 m, which is
       * about where the fog closes, so the sight line that reads as distance
       * survives on the tail of the distribution; the mean is down by a fifth and
       * the typical stretch stops being a corridor.
       *
       * AND THAT PARAGRAPH DESCRIBED A BUILD NOBODY EVER PLAYED. The line below
       * computed 13-24 and 8-13 — the PREVIOUS, LONGER era — for as long as the
       * paragraph over it has claimed otherwise, exactly as `count` above kept
       * 32-46 while claiming 36-53. The two were designed as one trade and
       * neither half landed, so what shipped was the long-reach few-node walk:
       * a geometric run of 2.63 nodes at a mean 15.5 m each is 40.8 m of straight
       * passage between corners, and the measured build gave one corner over 45
       * degrees per 41 m. The arithmetic and the instrument agree to a tenth of a
       * metre, which is how it was found.
       *
       * At 11-21 and 7-11 the same geometric run is 35.1 m, and with the node
       * count raised to match, the passage is the same length with a sixth more
       * corners in it. Nothing else about the walk changes — the joint set is the
       * same, the decision at each node is the same, the pitch envelope is the
       * same. Only the scale of a straight run.
       *
       * THE SIGHT LINE IS THE THING BEING SPENT, AND IT IS SPENT ON PURPOSE. The
       * 21 m tail is unchanged: the longest straight runs are the same length
       * they have always been, and they are what the composition argument was
       * ever about. What is gone is the 22-24 m band, which was three metres past
       * where the cave fog closes and therefore three metres of wall nobody could
       * see the end of anyway.
       */
      const step = hold ? rngRange(rng, 11, 21) : rngRange(rng, 7, 11);
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
      /**
       * …AND ALSO FROM THE PASSAGE IT HAS ALREADY CUT, WHICH IS A SECOND ROCK.
       *
       * `chamberFit` asks how much MOUNTAIN there is. That is not the only thing
       * a chamber can run out of: it can also run out of untouched rock, because
       * an arm of the same system is fifteen metres away and a thirty-five metre
       * hall excavated over it makes two tubes that share a volume.
       *
       * The clash test below would catch that and REFUSE the node, and refusing
       * is the wrong answer for the same reason it is the wrong answer for the
       * hillside. A refusal re-rolls the type, so it does not produce a smaller
       * chamber — it produces no chamber, and then no chamber at the next node
       * either, because the passage is still there. Measured with refusal alone:
       * four of eight seeds came back with nothing over 25 m tall anywhere and
       * the mean tallest section in the world fell from 45 m to 35.
       *
       * So the beads cap the radius exactly as the mountain does, and the two
       * caps are taken together. A chamber in a crowded piece of rock comes out
       * modest, which is what a chamber in a crowded piece of rock is. Iterated
       * for the same reason `chamberFit` is: the exemption window is itself a
       * function of the answer, and every pass is conservative — it can only
       * shrink.
       */
      if (sh.vast) {
        const dl = Math.hypot(nx - x, nz - z) || 1;
        const fit = Math.min(
          chamberFit(nx, nz, (nx - x) / dl, (nz - z) / dl, ny, sh, r),
          beadRoom(beads, walked, nx, ny, nz, sh, r)
        );
        if (kind === 'hall' && fit < HALL_MIN) {
          kind = 'room';
          sh = SHAPES.room;
          const wish = rngRange(rng, sh.lo, sh.hi);
          r = Math.min(
            chamberFit(nx, nz, (nx - x) / dl, (nz - z) / dl, ny, sh, wish),
            beadRoom(beads, walked, nx, ny, nz, sh, wish)
          );
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
        if (attempt < 11) continue;
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
      /**
       * THE NOMINAL SECTION AND NOT THE JITTERED ONE, WHICH IS THE OPPOSITE OF
       * WHAT `chamberFit` DOES A FEW LINES UP, AND DELIBERATELY.
       *
       * `chamberFit` is sizing a chamber that will be DRAWN, so it has to leave
       * room for the jitter `shaped` is about to apply or the burial meets a
       * section bigger than the one that was verified. This is choosing a
       * HEADING, and the cost of the two mistakes is not symmetric: too
       * permissive costs a ring the burial narrows, too strict costs the whole
       * direction. Padding it here was tried and vetoed a tenth of a hall's
       * radius worth of headroom on every candidate — about ten metres on a
       * 26 m chamber — which on three of eight seeds was the difference between
       * a chamber and no chamber at all.
       */
      /**
       * …AND THE READING IS KEPT, WHICH IS THE OTHER HALF OF THE HOLD RULE.
       *
       * `roofScan` is seventeen `heightAt` samples and the single most expensive
       * thing in this loop, and every previous version of it asked one yes/no
       * question of the result and dropped it. `scanOver` is the same reading
       * asked for a NUMBER — metres of mountain over the axis — at no cost
       * beyond two subtractions. See the block over `rockAvg` for what it is
       * compared against and why it is not compared against a constant.
       *
       * Null on the twelfth attempt, which skips the scan by design: the escape
       * hatch honours no veto, so there is nothing to read. The previous node's
       * reading is then carried forward unchanged, which is the right default —
       * an escape-hatch node is one the rock refused, and a walk that has just
       * been refused should not conclude the rock got better.
       */
      let scanOver = null;
      if (attempt < 11) {
        const tl = Math.hypot(nx - x, nz - z) || 1;
        const s = roofScan(nx, nz, (nx - x) / tl, (nz - z) / tl, r * sh.w);
        if (roofDrop(s, ny, sh, r) > -ROOF_ROCK * 0.3) continue;
        scanOver = Math.min(s[0], s[1]) - ny - ROOF_ROCK;
      }

      /**
       * DO NOT CROSS THE PASSAGE YOU HAVE ALREADY CUT — TESTED ALONG THE REACH
       * AND NOT AT ITS FAR END.
       *
       * This used to compare the candidate NODE's centre against every previous
       * NODE's centre. Both halves of that are the same mistake: what the mesh
       * is made of is the SPLINE between the nodes, and two reaches can pass
       * within a metre of each other while all four of their endpoints are
       * twenty metres apart. A node test cannot see the middle of anything.
       *
       * It survived for as long as the walk took 28-41 reaches of 8-26 m, which
       * is a line that mostly goes somewhere and rarely doubles back inside its
       * own mountain. At 36-53 reaches of 7-21 m, on three joint sets instead of
       * two, it does double back — measured on grove-01 with the node test still
       * in place, the number of ring pairs forty or more apart whose sections
       * SHARE VOLUME went from 3.5 a cave to 33.
       *
       * What that is, from inside, is a hole in the wall with the back of
       * another wall behind it: two arms of the same tube, each drawn
       * single-sided and facing the other way, so the opening shows black
       * nothing rather than a passage. It also breaks things that have no
       * business caring about geometry — `cave-walk` steers at the furthest ring
       * it can see and picks its candidates by horizontal distance, so a passage
       * folded over itself hands the walker a target three hundred rings away
       * and it stands against a wall at full speed for ever. That is what the
       * gate actually reported: two mouths of three unwalkable, one of them
       * three metres in.
       *
       * BEADS RATHER THAN A SEGMENT-SEGMENT SOLVE. The exact closest approach
       * between two 3D segments is twenty lines of case analysis to get right
       * and it is not what is wanted anyway: the quantity is "does this reach
       * come near anything already cut", and the reaches are 7-21 m long against
       * a clearance of several metres. Sampling both sides finely enough that no
       * gap in the sampling is larger than the clearance answers the same
       * question and cannot be got subtly wrong. The previous line contributes a
       * bead at each end and one in the middle; the candidate is tested at four
       * points along itself.
       */
      /**
       * WHAT IS EXEMPT IS THE LINE THAT LEADS HERE, MEASURED IN THIS SECTION'S
       * OWN SCALE.
       *
       * A fixed exemption of the last few beads is right for a passage and
       * catastrophic for a chamber, which was the first version of this and is
       * worth the paragraph. A hall's half-width is 35 m, so it demands 39.5 m
       * of clearance from every bead — and the reach that arrives at it is
       * 7-21 m long, so the node before last is comfortably inside its own
       * chamber and refuses it. Measured with a five-bead exemption: three of
       * four caves came back with nothing over 25 m tall anywhere and the
       * tallest section in the world fell from 67 m to 22. The rejection also
       * feeds back — every refusal re-rolls the heading and the type, so a walk
       * that is refused everywhere coils, and grove-01's k=0 came out turning
       * 622 degrees per hundred metres.
       *
       * A chamber is ALLOWED to swallow the passage that feeds it. That is what
       * a chamber is. What it is not allowed to do is swallow an arm of the
       * system it left forty metres ago, and the difference between those two is
       * distance ALONG THE LINE rather than distance in space.
       *
       * AND THE EXEMPTION IS THE CLEARANCE ITSELF, WHICH IS THE ONLY VALUE THAT
       * IS NOT ARBITRARY. A bead fewer metres of line behind you than the
       * clearance you are demanding is a bead you cannot possibly have got far
       * enough from — the line simply is not long enough — so testing it is a
       * guaranteed refusal, and a guaranteed refusal is not a constraint, it is
       * a walk that always reaches its sixth attempt and takes whatever it is
       * given. That was measured, twice, from two directions: a flat twelve
       * metre exemption is under a tube's own 12.4 m clearance and produced
       * caves turning 512 degrees per hundred metres with 225 overlapping ring
       * pairs — far worse than the node test it replaced — and a flat five-bead
       * exemption starved the chambers, three of four caves coming back with
       * nothing over 25 m tall.
       *
       * Plus eight metres so that a single square corner, which is what a joint
       * walk is made of, is not itself a refusal.
       */
      /**
       * …AND THE SECTION TAPERS ALONG THE REACH, which matters only for the
       * chambers and matters enormously for them.
       *
       * The reach into a hall is a tube at one end and a hall at the other, and
       * `resample` splines the radius between them — so a quarter of the way
       * along the section is a quarter of the way from four metres to
       * thirty-five, not thirty-five. Testing every sample at the far end's
       * width demands a hall's clearance along the whole approach and refuses
       * chambers that would have fitted, which is the same over-strictness the
       * exemption above exists to avoid, arrived at from the other axis.
       */
      const prevHalf = nodes[nodes.length - 1].r * nodes[nodes.length - 1].w * 1.15;
      const hereHalf = r * sh.w * 1.15;
      let clash = false;
      for (let s = 1; s <= 4 && !clash; s++) {
        const f = s / 4;
        const px = x + (nx - x) * f;
        const py = y + (ny - y) * f;
        const pz = z + (nz - z) * f;
        const halfAt = prevHalf + (hereHalf - prevHalf) * f;
        for (let j = 0; j < beads.length; j++) {
          const bd = beads[j];
          /**
           * Half-widths differ per node, so the keep-apart distance is the two
           * actual half-widths rather than one shared constant. A room next to a
           * squeeze needs eleven metres of clearance; two squeezes need four.
           */
          const min = bd.half + halfAt + 3.5;
          // `continue`, not `break`: the beads are in order of `at` but not of
          // `min`, so a wide bead's large exemption says nothing about the
          // narrow ones after it. A hundred beads by four samples is arithmetic.
          if (walked - bd.at < min + 8) continue;
          const dx = bd.x - px;
          const dy = bd.y - py;
          const dz = bd.z - pz;
          if (dx * dx + dy * dy + dz * dz < min * min) {
            clash = true;
            break;
          }
        }
      }
      /**
       * A CROSSING IS THE ONE VETO THE LAST ATTEMPT MAY NOT SIMPLY IGNORE.
       *
       * Every other rejection in this loop is dropped on the final try, and that
       * is right for all of them: a node under thin rock is a ring the burial
       * narrows, a node on a poor heading is a corner. Both are a worse cave. A
       * node placed THROUGH the passage is not a worse cave, it is a broken one
       * — two arms of the same tube sharing a volume, which from inside is a
       * body in open space with two sets of walls pushing it and no way past.
       * `cave-end` reads it off as the nearest ring alternating between two
       * numbers a hundred rings apart, and it does not degrade gracefully: you
       * cannot walk it at all.
       *
       * ENDING THE WALK THERE WAS TRIED AND IS THE WRONG PRICE. It does drive
       * crossings to zero across eight seeds — but `prepare`'s three re-walks
       * did not save grove-01's k=0, which came back as a hundred and
       * fifty-metre stub, and the mean cave lost a hundred metres. Stubs are
       * this file's documented catastrophe and they are not worth buying
       * anything with.
       *
       * So the passage SQUEEZES past instead. `beadRoom` already answers "how
       * big may a section be here", which is the same question the chambers ask
       * of it; below the narrowest tube in the table the section is not a
       * passage any more and only then does the walk stop. What the player gets
       * where two arms nearly meet is a squeeze, which is what a real cave has
       * there and is the shape `resample`'s MIN_HEAD and MIN_HALF floors exist
       * to keep walkable.
       */
      if (clash) {
        if (attempt < 11) continue;
        const room = beadRoom(beads, walked, nx, ny, nz, sh, r);
        if (room < SHAPES.tube.lo * 0.6) {
          cliffed = true;
          break;
        }
        r = room;
        // A chamber ground down to corridor size is drawn as a corridor, for the
        // reason the `vast` block above gives.
        if (sh.vast && r < SHAPES.tube.lo) {
          kind = 'tube';
          sh = SHAPES.tube;
        }
      }

      heading = h;
      pitch = p;
      joint = jn;
      type = kind;
      x = nx;
      y = ny;
      z = nz;
      /**
       * The rock reading, folded into the running comparison the next node's
       * hold rule reads. Only on acceptance: a refused candidate is a place the
       * passage is not, and its overburden is not this passage's rock.
       *
       * The deviation is taken against the mean BEFORE this sample is folded in,
       * so a node cannot be compared against a mean that already contains it —
       * with a fast rate that alone would halve the spread and push `rockGen`
       * toward 0.5 everywhere, which is the flat coin again by accident.
       */
      if (scanOver !== null) {
        if (rockAvg === null) {
          rockAvg = scanOver;
          rockGen = 0.5;
        } else {
          const dev = scanOver - rockAvg;
          // Detrended: `rockDev` is how fast the overburden has been changing,
          // so `rel` is how much of this node's change is NOT the trend. See
          // the block over `rockAvg` for why leaving the trend in reproduces
          // the 0.52 hold and its quarter of the tall chambers.
          const rel = dev - rockDev;
          rockGen = clamp01(0.5 + rel / (2 * Math.max(rockSpread, 3)));
          rockSpread += ROCK_RATE * (Math.abs(rel) - rockSpread);
          rockDev += ROCK_RATE * (dev - rockDev);
          rockAvg += ROCK_RATE * dev;
        }
        stats.rockSum += scanOver;
        stats.rockN++;
        stats.genSum += rockGen;
      }
      stats.nodes++;
      if (!hold) stats.corners++;
      if (attempt === 11) stats.escapes++;
      const nd = shaped(x, y, z, r, sh, rng);
      nd.type = kind;
      bead(nodes[nodes.length - 1], nd);
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
  const term = yield* terminusFit(rng, x, y, z, heading, joints, nodes, bottom, last.r * 1.3, beads, walked);
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
  return { nodes, joints, stats };
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
 * ordinary passage, and CAP_RINGS_MAX bounds a hall's.
 *
 * CAP_RINGS_MAX IS NOT A TASTE, IT IS THE BURIAL'S TAPER WRITTEN OUT. `closeEnd`
 * has to start on rock that the backward slope limiter has not already tapered,
 * or the cone it exists to overwrite survives in front of it — see the block
 * there. The limiter reaches `(r - CAP_R_MAX) / TAPER` rings back, so the dome
 * must be at least that long, and at the hall's new 26 m that is 43 rings, 31 m.
 * It was 24 m, which was ample at 19 m of radius and would have been eleven
 * metres short at 26 — presenting not as a short dome but as a straight-sided
 * cone eating the back of the biggest chamber in the cave, with the floor
 * climbing 4.7 m into it. That exact failure is on the record twice.
 */
const CAP_LEN = 5;
const CAP_RINGS = Math.max(4, Math.round(CAP_LEN / RING_STEP));
const CAP_RINGS_MAX = Math.round(36 / RING_STEP);
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
function* terminusFit(rng, x, y, z, heading, joints, nodes, bottom, want, beads = null, walked = 0) {
  const bearings = [heading];
  for (const j of joints) {
    // Never the reciprocal: that is a chamber excavated in the passage you just
    // walked down. Same test, and for the same reason, as the walk's own.
    const d = ((j - heading + Math.PI) % TAU + TAU) % TAU - Math.PI;
    if (Math.abs(Math.abs(d) - Math.PI) < 0.6) continue;
    bearings.push(j + rngRange(rng, -0.1, 0.1));
  }
  /**
   * …AND TWO BEARINGS THAT ARE NOT ON A JOINT AT ALL.
   *
   * Everything above is the joint set, which is right for a PASSAGE — water gets
   * in along the fractures and nowhere else. A breakdown chamber is not cut by
   * water, it is where the roof came down, and it sits wherever the rock was
   * weakest rather than on a bearing. Restricting the search to the joints was
   * therefore borrowing a constraint from the wrong process, and it costs
   * exactly where the cave is twistiest: the deep end of a passage that has
   * turned a lot has its own line lying across most of its joints, so
   * `beadRoom` caps every candidate and the passage ends in a taper. That is
   * `cave-end`'s "1.02x the feed", and it appeared on one seed of six the moment
   * the walk started turning half again as much.
   *
   * Half a radian off the arrival heading, both ways. Deliberately not a fine
   * sweep: this loop is the fattest single computation in the whole build (see
   * the note inside it), and two more bearings is a sixth more of it.
   *
   * These are appended after the loop rather than inside it so the `rng` draw
   * order above is untouched — every cave in the world would move otherwise.
   */
  bearings.push(heading + 0.5, heading - 0.5);
  let best = null;
  for (const h of bearings) {
    const tx = Math.cos(h);
    const tz = Math.sin(h);
    /**
     * FOUR DISTANCES RATHER THAN THREE, AND THE EXTRA ONE IS THE FAR ONE.
     *
     * The search is over bearing x distance x dive, and the distance is the axis
     * that decides how much of the mountain it can see: a candidate is a
     * chamber-sized footprint centred `step` metres ahead, so the set {15, 21,
     * 27} could only ever look at a band twelve metres wide at the end of a
     * six-hundred-metre passage. That was ample while the walk arrived at its
     * deep end in a straightish line and the rock either side of that band was
     * much the same. It is not ample now: the walk turns half again as much, so
     * where it ends up is a more particular place, and the passage's own line is
     * more likely to be lying across one of the three candidates.
     *
     * 33 m out is the one that finds rock the rest cannot, and it costs a third
     * more of the fattest single computation in the build — which is why it is
     * one extra distance rather than a finer sweep. Measured: it is the
     * difference between six of six termini opening out and five.
     */
    for (const step of [15, 21, 27, 33]) {
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
        let r = Math.min(
          chamberFit(cx, cz, tx, tz, cy, SHAPES.hall, SHAPES.hall.hi),
          beadRoom(beads, walked + step, cx, cy, cz, SHAPES.hall, SHAPES.hall.hi)
        );
        if (r < HALL_MIN) {
          kind = 'room';
          r = Math.min(
            chamberFit(cx, cz, tx, tz, cy, SHAPES.room, SHAPES.room.hi),
            beadRoom(beads, walked + step, cx, cy, cz, SHAPES.room, SHAPES.room.hi)
          );
        }
        /**
         * …AND AT THE FAR END OF IT, WHICH IS WHERE THE CROSSING ACTUALLY WAS.
         *
         * `cx, cz` is the chamber's NEAR centre, and the terminus does not end
         * there. `buildNodes` puts a second node `r * 0.95` further down the
         * bearing so the far wall is somewhere you walk to, and `closeEnd` then
         * runs a dome up to 1.3 radii beyond that — so a fifteen-metre chamber
         * occupies thirty-five metres of bearing past the point this loop tests,
         * with nothing checking any of it.
         *
         * That is the whole of the remaining fault and it has the documented
         * signature: on check-3's k=-3 the walker's nearest ring alternated
         * between 712 and 877, a hundred and nineteen metres apart along the
         * line, and it stalled six metres short of the terminus at full running
         * velocity — the passage and its own terminal chamber sharing a volume.
         * The near centre was clear; the far half was not.
         *
         * `walked` advances by the offset as well, because the exemption is
         * "how much line is there between here and that bead" and there is a
         * chamber's half-length more of it out here.
         */
        const far = r * 0.95;
        r = Math.min(
          r,
          beadRoom(
            beads,
            walked + step + far,
            cx + tx * far,
            cy,
            cz + tz * far,
            SHAPES[kind],
            r
          )
        );
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
        /**
         * The beads are NOT tested again here, and that is deliberate: `r` was
         * already capped by `beadRoom` above, so this candidate fits the rock
         * the walk has left by construction. Testing it as well would be a veto
         * on top of a solve, which is how the terminus came back as "1.02x the
         * feed — it tapers, it does not open" on grove-01's k=-1. The loop above
         * survives because it is about the APPROACH, which no cap can shrink.
         */
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
 * `1.3 * r / RING_STEP` rings is longer than `(r - CAP_R_MAX) / 0.35` for every
 * radius the world can produce, so the dome always starts on untapered rock, and
 * rewriting `y` from the base ring's floor puts the floor back dead level across
 * the whole of it.
 *
 * THE FACTOR IS A SOLVED BOUND AND NOT A FEEL. Setting the two lengths equal,
 * `k * r / RING_STEP >= (r - CAP_R_MAX) / TAPER` holds for all `r` up to
 * `CAP_R_MAX / (1 - k * TAPER / RING_STEP)` — which at the old 1.15 is 24.9 m
 * and at 1.3 is 29.9. The hall's own `hi` is 26 and Catmull-Rom overshoots it by
 * about 8%, so 1.15 was inside its own bound by four metres and is now outside
 * it by three. There is nothing gradual about crossing that line: below it the
 * dome swallows the taper entirely, above it the taper appears in front of the
 * dome at full length.
 *
 * THE DOME CANNOT BREACH THE HILL, and that is not an assumption. Every ring it
 * writes takes its shape from the base ring and its radius from a factor at most
 * 1, and its axis is set from the base ring's own FLOOR — so its ceiling is
 * `floor + r_i * (t + rough)` with `r_i <= r_base`, which is at or below the base
 * ring's ceiling everywhere, and the base ring has already been through the
 * burial. `roofScan`'s rosette scales with the ring's half-width, so at a
 * chamber-sized base it has already sampled the ground the dome runs over.
 */
function closeEnd(path) {
  const n = path.x.length;
  let m = CAP_RINGS;
  for (let it = 0; it < 3; it++) {
    const b = Math.max(1, n - 1 - m);
    m = clamp(Math.round((path.r[b] * 1.3) / RING_STEP), CAP_RINGS, CAP_RINGS_MAX);
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
 * getting there is a decision. 0.64 back to itself gives a mean run of just
 * under three nodes — sixty to ninety metres of hall — and every one of those
 * nodes is independently sized against the rock it is under, so a run that walks
 * out from under the mountain shrinks and then hands over to a room rather than
 * pinching. See `chamberFit`.
 *
 * It was 0.55, and the reason to spend the extra is that a hall's own width has
 * gone from 51 m to 70. The run has to grow WITH the section or it stops being a
 * run: three nodes at 26 m of radius is a space whose far wall is beyond the
 * chamber's own width, which is the difference between walking into somewhere
 * and walking across it. The weight came out of the four small sections rather
 * than out of `room`, because the exit from a chamber that matters is the one
 * into another large space.
 */
const TYPE_CHAIN = {
  tube: [['tube', 0.32], ['keyhole', 0.20], ['canyon', 0.17], ['bedding', 0.15], ['room', 0.12], ['hall', 0.04]],
  canyon: [['canyon', 0.34], ['keyhole', 0.21], ['tube', 0.17], ['room', 0.12], ['bedding', 0.10], ['hall', 0.06]],
  keyhole: [['keyhole', 0.28], ['canyon', 0.25], ['tube', 0.22], ['room', 0.11], ['bedding', 0.09], ['hall', 0.05]],
  bedding: [['bedding', 0.31], ['tube', 0.25], ['room', 0.16], ['canyon', 0.12], ['keyhole', 0.09], ['hall', 0.07]],
  room: [['tube', 0.26], ['canyon', 0.21], ['bedding', 0.19], ['keyhole', 0.16], ['hall', 0.13], ['room', 0.05]],
  hall: [['hall', 0.64], ['room', 0.16], ['tube', 0.08], ['bedding', 0.06], ['canyon', 0.04], ['keyhole', 0.02]],
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
 * The nominal half-width, in metres, at which a ring stops being passage and
 * starts being a chamber. See `chamberRun` and `snapToChamber` in `prepare`.
 *
 * Read off the table above rather than chosen. Ordinary passage is 1.4 to 4.9 m
 * of `r * w` across the four small sections at any radius they may be drawn at;
 * `room` is 10 to 21 and `hall` is 12 to 35. Eight is a factor of 1.6 clear of
 * both, so nothing near the boundary can be misclassified by a die roll — which
 * matters, because this is a distance and it is being asked of a ring whose
 * radius came out of a Catmull-Rom overshoot as often as out of a node.
 */
const CHAMBER_HALF = 8;

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

/* -------------------------------------------------------------------------- *
 *  A CEILING IS A DOME, AND ASKING FOR IT AS A SLAB IS WHAT KEPT THE CHAMBERS
 *  SMALL
 * -------------------------------------------------------------------------- *
 *
 * `roofRoom` above is a MINIMUM over a rosette out to 1.15 half-widths, and
 * every caller compared that one number against `y + r * (t + rough)` — the
 * height of the section over its own AXIS. Read that back as a statement about
 * rock and it says: there must be as much mountain over the rim of the chamber
 * as there is over the middle of it. There must not. The rim of the chamber is
 * where the wall meets the floor; the ceiling there is at the axis's own height,
 * because that is what an ellipse is. The rule was demanding thirty metres of
 * hillside over a point where the cave is zero metres tall.
 *
 * It is not a small conservatism, and it gets worse exactly where it hurts. The
 * rosette scales with the footprint, so a chamber twice as wide reaches twice as
 * far out for its minimum — down the flank, on a ridge — and the bigger the
 * chamber the further from it the binding sample is taken. That is a feedback
 * loop that can only ever settle at "small", and it is why `hall` has wished for
 * nineteen metres of radius for its whole life and the widest ring ever measured
 * on four seeds was nineteen metres of radius: the wish was the answer, because
 * the rock could not grant it anywhere it was asked properly. The same argument
 * ground `room` down to 5.1 m — see the `vast` block in SHAPES, which is this
 * mistake caught one level up and patched rather than fixed.
 *
 * So the rosette is read out as three numbers — the hillside over the axis, and
 * its minimum over two rings of the footprint — and each is compared against
 * what the SECTION is actually doing at that offset:
 *
 *     need(u)  =  t * sqrt(1 - u^2)  +  rough        for u < 1
 *     need(u)  =  rough                              for u >= 1
 *
 * which is `ceilAt` with the displacement added, in section units, so the two
 * consumers below and the emitter that draws the surface are all quoting one
 * geometry. At the outer ring there is no cave at all and the requirement
 * collapses to the displacement — 12.6 m of hill over the axis for a nineteen
 * metre hall, against 58 m before. That single term is where the scale comes
 * from.
 *
 * THE READ IS SEPARATE FROM THE TWO QUESTIONS ASKED OF IT, and that separation
 * is load-bearing rather than tidy. `heightAt` is the whole cost — seventeen
 * samples, 0.010-0.012 ms — and `burySkylights` needs to ask twice about the
 * same ring at two different axis heights: once to find out how far it must
 * fall, and again, after the slope limiters have moved it further, to find out
 * what radius the rock will carry it at. Scanning once and answering both from
 * the reading is what stops the burial costing double, and it is also what makes
 * "the walk and the burial cannot disagree" true by construction instead of by
 * discipline. That disagreement is the documented cause of a twenty-four metre
 * cliff between two consecutive rings.
 */

/** The rosette's rings, as fractions of the section's half-width. */
const ROOF_RING = [0.62, 1.15];
/** One reading: the hillside over the axis, then the minimum over each ring. */
const _roofS = [0, 0, 0];

function roofScan(x, z, tx, tz, half, out = _roofS) {
  out[0] = heightAt(x, z);
  for (let g = 0; g < ROOF_RING.length; g++) {
    const d = ROOF_RING[g] * half + 0.6;
    let lo = Infinity;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      const ox = (-tz * Math.cos(a) + tx * Math.sin(a)) * d;
      const oz = (tx * Math.cos(a) + tz * Math.sin(a)) * d;
      const s = heightAt(x + ox, z + oz);
      if (s < lo) lo = s;
    }
    out[g + 1] = lo;
  }
  return out;
}

/**
 * How much rock ring `g` wants over the axis, per metre of radius.
 *
 * The 0.6 m pad `roofScan` adds is in METRES and the section is in radii, so it
 * has to be folded back into `u` here rather than ignored — on a squeeze it is
 * most of the offset and dropping it would have the innermost ring asking for a
 * ceiling that is two thirds of the way up the wall.
 */
function roofNeed(g, sh, half) {
  if (g === 0) return sh.t + sh.rough;
  const u = ROOF_RING[g - 1] + 0.6 / Math.max(half, 1e-3);
  return (u >= 1 ? 0 : sh.t * Math.sqrt(1 - u * u)) + sh.rough;
}

/** The largest radius a reading allows, for a section whose axis sits at `y`. */
function roofCap(s, y, sh, half) {
  let cap = Infinity;
  for (let g = 0; g <= ROOF_RING.length; g++) {
    const c = (s[g] - ROOF_ROCK - y) / roofNeed(g, sh, half);
    if (c < cap) cap = c;
  }
  return cap > 0 ? cap : 0;
}

/** …and how far the axis must fall for a ring of radius `r` to be roofed. */
function roofDrop(s, y, sh, r) {
  const half = Math.max(r * sh.w, 1e-3);
  let drop = -Infinity;
  for (let g = 0; g <= ROOF_RING.length; g++) {
    const d = y + r * roofNeed(g, sh, half) + ROOF_ROCK - s[g];
    if (d > drop) drop = d;
  }
  return drop;
}

/**
 * THE LARGEST RADIUS THAT CLEARS THE PASSAGE THE WALK HAS ALREADY CUT.
 *
 * The companion to `chamberFit`, and the same argument one axis over: that one
 * asks how much MOUNTAIN there is over a point, this asks how much UNTOUCHED
 * ROCK. A chamber can run out of either, and running out of the second is the
 * one that produces two tubes sharing a volume — from inside, a body in open
 * space with two sets of walls pushing it, which is a stall at full running
 * velocity rather than anything that looks like a hole.
 *
 * A CAP AND NOT A VETO, which is the whole reason it is a function rather than a
 * test. A veto re-rolls the section type, so it does not yield a smaller chamber
 * — it yields no chamber, and then none at the next node either, because the arm
 * it is avoiding has not moved. Measured with the veto alone: four of eight
 * seeds came back with nothing over 25 m tall anywhere and the mean tallest
 * section in the world fell from 45 m to 35.
 *
 * `beads` is the walked line sampled at every node and every midpoint, carrying
 * the widest section it stands for; `walked` is how much line there is, so
 * `walked - bd.at` is how far back a bead lies. The exemption is the clearance
 * itself plus eight metres, for the reason the block in `buildNodes` gives — a
 * bead nearer along the line than the clearance being demanded cannot possibly
 * satisfy it, so testing it is a guaranteed refusal rather than a constraint.
 *
 * Iterated because that exemption is a function of the answer. Every pass can
 * only shrink, so all three exits are conservative.
 */
function beadRoom(beads, walked, px, py, pz, sh, wish) {
  if (!beads || !beads.length) return wish;
  let cap = wish;
  for (let it = 0; it < 3; it++) {
    let next = cap;
    for (let j = 0; j < beads.length; j++) {
      const bd = beads[j];
      if (walked - bd.at < bd.half + cap * sh.w * 1.15 + 11.5) continue;
      const d = Math.hypot(bd.x - px, bd.y - py, bd.z - pz);
      const allow = (d - bd.half - 3.5) / (sh.w * 1.15);
      if (allow < next) next = allow;
    }
    if (next >= cap) break;
    cap = next > 0 ? next : 0;
  }
  return cap;
}

/**
 * A section with the jitter `shaped` will apply to it already spent.
 *
 * Sizing against the nominal section and letting the burial meet the jittered
 * one is how you get a chamber that is fine at its nodes and pinched in the
 * middle. Shared scratch rather than a literal because `chamberFit` runs
 * forty-five times inside one `terminusFit`.
 */
const _fitSh = { w: 1, t: 1, rough: 0 };

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
 * So ask first, with the burial's own question — `roofDrop` — solved for `r`
 * instead of checked after the fact. That is `roofCap`, and the two are two
 * readings of the one rosette (see the block over `roofScan`) rather than two
 * rules that have to be kept in step by hand. Two things make this more than one
 * line:
 *
 *   THE FOOTPRINT DEPENDS ON THE ANSWER. `roofScan` samples a rosette scaled by
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
  _fitSh.w = sh.w * 1.12;
  _fitSh.t = sh.t * 1.1;
  _fitSh.rough = sh.rough * 1.2;
  let r = want;
  for (let it = 0; it < 4; it++) {
    const half = r * _fitSh.w;
    const fit = roofCap(roofScan(x, z, tx, tz, half), y, _fitSh, half);
    if (fit >= r) break;
    r = Math.min(want, fit);
  }
  return r;
}

/**
 * `until` IS `from` AT THE OTHER END, AND IT EXISTS FOR THE SAME REASON.
 *
 * `from` protects the rings that are welded to something the burial is not
 * entitled to move — the hood at a mouth, ring zero at a junction. A looping
 * branch has a SECOND weld, in the wall of another passage, and every word of
 * that argument applies to it unchanged: those rings sit inside a bore that has
 * already been buried, so the hillside test over them is both meaningless (the
 * rock above them is the target passage's business) and destructive (moving
 * them by a centimetre unpicks the seam the whole junction rests on).
 *
 * Rings at or past `until` therefore keep their `y` and their `r`, the cut
 * search stops there — a pinch INSIDE the target's bore is not a pinch — and
 * `flatten` is told the same bound. Default Infinity, so every existing caller
 * is unchanged to the bit.
 */
function* burySkylights(path, from, until = Infinity) {
  const n = path.x.length;
  const last = Math.min(n, until);
  const want = Float64Array.from(path.y);
  /**
   * THE ROSETTE READING ITSELF, KEPT, RATHER THAN AN ANSWER DERIVED FROM IT.
   *
   * What used to be here was one `room` line per ring — `roofRoom` minus
   * ROOF_ROCK — which worked because the old rule had one denominator for the
   * whole section, so "how much rock is there" and "what radius does that allow"
   * were the same number scaled. They are not the same number any more: the
   * requirement now depends on where in the footprint you stand (see the block
   * over `roofScan`), so the cap is a minimum over three terms with three
   * different denominators and it moves when the axis moves.
   *
   * The radius pass below runs against `want`, which the two slope limiters have
   * by then pushed further down than this pass did — so it has to ask the
   * question again at a height this pass never saw. Keeping the three surface
   * minima lets it, for the cost of three doubles a ring and no second walk over
   * `heightAt`, which is the entire expense of this function.
   */
  const surf0 = new Float64Array(n);
  const surf1 = new Float64Array(n);
  const surf2 = new Float64Array(n);
  /** The ring's own section, for `roofNeed`. Reused; never escapes. */
  const shr = { w: 1, t: 1, rough: 0 };
  /**
   * THE ONE SLICE POINT IN THIS FUNCTION, AND IT IS IN THE RIGHT LOOP.
   *
   * `burySkylights` is five passes over the ring array and it is 42% of a whole
   * `prepare` — but only this first pass is expensive, because only this one
   * calls `roofScan`, which is seventeen `heightAt` samples over the passage's
   * shoulders. Measured at 0.010-0.012 ms a ring against 0.0002 for each of the
   * four slope-limiter passes that follow, so those are left whole: a nine
   * hundred ring passage runs all four of them in a fifth of a millisecond, and
   * cutting a running minimum into slices would mean carrying its accumulator
   * across frames for no gain that could be measured.
   *
   * 48 rings is half a millisecond of `roofScan`, which is the granularity the
   * whole build is cut to. It is a work quantum and NOT a distance — see the
   * note on GOOD_RINGS for what happens in this file when those two are
   * confused — so it does not move when RING_STEP does.
   */
  const BURY_SLICE = 48;
  for (let i = Math.max(0, from); i < n; i++) {
    if (i % BURY_SLICE === 0) yield 'bury';
    const r = path.r[i];
    shr.w = path.w[i];
    shr.t = path.t[i];
    shr.rough = path.rough[i];
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let tx = path.x[b] - path.x[a];
    let tz = path.z[b] - path.z[a];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    const s = roofScan(path.x[i], path.z[i], tx, tz, r * shr.w);
    surf0[i] = s[0];
    surf1[i] = s[1];
    surf2[i] = s[2];
    const drop = roofDrop(s, path.y[i], shr, r);
    if (drop > 0) want[i] = path.y[i] - drop;
  }
  /**
   * THE PROTECTED RINGS WANT WHERE THEY ALREADY ARE, and this line is the whole
   * difference between `until` working and `until` putting a step in the weld.
   *
   * The two envelope passes below are running minima over the WHOLE array, so a
   * drop demanded at a ring that will never be written still propagates
   * backwards into the rings that will be. A weld ring is inside another
   * passage's bore, so `roofDrop` there is asking the hillside about rock that
   * is somebody else's business and routinely gets a large answer — and the
   * ring in front of the weld would then be lowered to reach a drop that never
   * happens. That is a step at exactly the seam this parameter exists to keep
   * flat. `from` needs no equivalent: it seeds `ceilingOf` from the last fixed
   * ring, which is the same statement made forwards.
   */
  for (let i = last; i < n; i++) want[i] = path.y[i];

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
  // …and to `last` for the same reason the height envelope stops there: a weld
  // ring's `roofCap` is asked of a hillside that is roofing the TARGET passage,
  // and the taper passes below would carry its answer back into rings that are
  // real. See the block over `until`.
  for (let i = first; i < last; i++) {
    shr.w = path.w[i];
    shr.t = path.t[i];
    shr.rough = path.rough[i];
    _roofS[0] = surf0[i];
    _roofS[1] = surf1[i];
    _roofS[2] = surf2[i];
    /**
     * The footprint is the one the reading was taken over, NOT the one the
     * answer implies. A smaller radius reaches less far out and would be judged
     * against a wider `u` — i.e. a smaller requirement — so re-deriving it from
     * the answer would be solving the constraint against a rosette nobody
     * sampled, in the permissive direction. Quoting the sampled footprint is
     * conservative and is the only version that cannot invent a skylight.
     */
    const fits = roofCap(_roofS, want[i], shr, path.r[i] * shr.w);
    if (fits < rock[i]) rock[i] = fits;
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
  for (let i = first; i < last; i++) {
    if (rock[i] * (path.t[i] + path.f[i]) < MIN_HEAD + 0.5) {
      cut = i;
      break;
    }
  }
  // Ring 0 of a branch is welded to the main tube and must not move; the mouth
  // rings are the hood and must not either; nor does a loop's far weld. See
  // `until`.
  for (let i = first; i < Math.min(cut, last); i++) {
    path.y[i] = want[i];
    path.r[i] = rock[i];
  }
  if (cut < last) truncate(path, cut);

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
   * keeps it off the mouth and off a branch's welded ring zero, and `last`
   * keeps it off a loop's far weld for the same reason.
   */
  flatten(path, first, last);
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
 * IT USED TO SAY "It is deliberately not a loop back to anywhere. The collision
 * model is a set of independent swept tubes; two of them rejoining is not a
 * bigger version of this problem, it is a different one." That was true when it
 * was written and it is no longer: `caveSample` learned to separate which
 * section governs the body from how much you are in a cave, which is precisely
 * and only what two tubes rejoining requires. See the LOOP CLOSURE block below,
 * and `wantLoop` on this function.
 */
/**
 * WHY THE LAST BRANCH DID NOT HAPPEN.
 *
 * `buildBranch` returns null at three completely different places for three
 * completely different reasons, and until this variable existed it returned the
 * same null at all of them — so `prepare` knew only that a junction it had
 * planned was not there, and nobody knew how often that was, let alone which
 * gate was firing.
 *
 * That blindness is the whole reason the room's second complaint went unnoticed
 * for as long as it did. Measured once the counters existed: 54% of planned
 * top-level branches were being built. Twenty-six junctions of forty-eight
 * across the world, against a design that says one every fifty metres — so
 * grove-01's k=-1 got three junctions in six hundred and thirty-two metres, and
 * "it lacks cave-like subsystems" is that number and not an opinion.
 *
 *   'wall'    :2833 — no ring in the 34-ring window has a wall a body could get
 *                     through. The junction would be a hole above head height.
 *   'short'   :3263 — under three nodes placed. Every candidate clashed or the
 *                     hillside refused it, which for a minor branch used to mean
 *                     the FIRST candidate did; see `tries`.
 *   'buried'  :3343 — built, then `burySkylights` took it back to under twelve
 *                     metres. There is genuinely no mountain there.
 *
 * A module-level variable rather than a return value because the return is
 * `null` at three sites deep inside a generator and threading a reason out of
 * every one of them would be four signature changes for a counter. The build is
 * one sequential generator chain — `prepareSlice` advances exactly one cave per
 * frame — so there is no interleaving to get wrong. It is written on entry and
 * read immediately after the call returns, and nowhere else.
 */
let _branchWhy = null;

/**
 * HOW MUCH WALL THERE IS WHERE A BODY IS, at one ring of one passage.
 *
 * Hoisted out of `buildBranch`, which had it as a closure over the passage it
 * was leaving, because a loop closure has to ask the same question of a passage
 * it is ARRIVING at. Same two heights `caveSample` solves the wall push at, and
 * for the same reason: a section is an ellipse, so the half-width at the axis —
 * the number every part of this file used to reach for — is the one height that
 * is guaranteed to be the maximum, and in a keyhole or a canyon the body moves
 * several metres below it in a slot a fraction as wide.
 */
const _wallSh = { w: 1, t: 1, f: 0.5, key: 0 };
function wallHalfAt(p, i) {
  _wallSh.w = p.w[i];
  _wallSh.t = p.t[i];
  _wallSh.f = p.f[i];
  _wallSh.key = p.key[i];
  const r = p.r[i];
  const fl = floorAt(0, _wallSh);
  return r * Math.min(halfWidthAt(fl + 1.1 / r, _wallSh), halfWidthAt(fl + 1.8 / r, _wallSh));
}

/* -------------------------------------------------------------------------- *
 *  LOOP CLOSURE — THE SECOND WELD
 * -------------------------------------------------------------------------- *
 *
 * WHAT WAS HERE, WORD FOR WORD, WAS "It is deliberately not a loop back to
 * anywhere. The collision model is a set of independent swept tubes; two of them
 * rejoining is not a bigger version of this problem, it is a different one."
 *
 * That was true when it was written and it stopped being true the day
 * `caveSample` learned to separate WHICH SECTION GOVERNS THE BODY (`bestScore`,
 * a fit test) from HOW MUCH ARE YOU IN A CAVE (`inside`, a max over every path
 * that claims the point). Read the block at the top of `caveSample`: that split
 * was written for junctions and it is exactly, and only, what two passages
 * legitimately claiming one point requires. It cost this project the documented
 * failure where 40% of every cave was unreachable, and while every path had
 * exactly one weld its value was half collected.
 *
 * THE COMPLAINT IT ANSWERS. "It looks like one continuous tunnel rather than
 * having cave-like subsystems and explorability." Measured, the cyclomatic
 * number of every cave in this world was exactly zero: every branch and every
 * lead off a branch dead-ended, so the graph was a tree, and in a tree every
 * side passage is a decision you undo by turning round. You cannot get lost in a
 * tree and you cannot come back a different way, which are the two things that
 * make a cave system a system.
 *
 * SO A PATH MAY NOW END ON ANOTHER PATH'S WALL. `buildBranch` already welds ring
 * zero to a parent's wall, and in doing so has already solved floor height,
 * lateral offset, the hole ellipse, the collar double-winding and the flare that
 * seals it. The whole of this feature is the mirror of that weld at the other
 * end, plus the burial learning not to move it (`until`), plus `blindAlong`
 * learning to be asked from either end.
 *
 * IT IS CHEAPER THAN A DEAD END. A closure skips `terminusFit`, which the file
 * describes as the fattest single computation in the whole build — twelve
 * attempts each dominated by a `roofScan`. What it spends instead is one sweep
 * of the candidate paths' ring arrays (a squared distance each, no hypot) and at
 * most four `roofRoom` calls on the shortlist.
 *
 * HOW MUCH LOOPING IS RIGHT, AND IT IS MUCH LESS THAN FEELS RIGHT.
 *
 * Collon et al. 2017 survey 34 real cave systems as graphs and Jouves et al.
 * 2017 do 26 more over 621 km of passage; both put the average vertex degree
 * between 1.8 and 2.6, and both find junctions of degree four or more genuinely
 * scarce. Paris et al. 2021 report that their synthetic mazes come out ABOVE
 * real systems' degree — i.e. the naive thing, adding edges until the map looks
 * interesting, overshoots nature rather than approaching it. The dial the
 * roguelike literature settled on is the same one: build the spanning tree, then
 * add back a small percentage of the rejected edges (TinyKeep used 15%, later
 * reworks found 8-10% better).
 *
 * So the budget is ONE to THREE closures in a whole cave, never a fraction of
 * the branches. On a system with eight junctions and a dozen dead ends that puts
 * the cyclomatic number at 1-2 and the mean degree just either side of 2, which
 * is the middle of the surveyed range. More is not a better cave; it is a maze,
 * and the maze objection in `prepare` — "what makes a maze is not the count, it
 * is two holes within sight of each other" — is untouched by any of this.
 */
/**
 * How near and how far a weld may be from the end of the walk, in metres.
 *
 * The floor is not a taste: the weld sits `lat` off the target's axis and the
 * approach node stands LOOP_PRE beyond that, so a target much under sixteen
 * metres leaves no connector at all and is refused by `reach` a hundred lines
 * down having cost a `roofRoom` to find out. Ten rather than thirteen so that
 * refusal happens on a squared distance instead.
 *
 * The ceiling is rock. Every metre of connector is a metre of passage nobody
 * asked the hillside about until the roof check, and the roof check is the
 * expensive one. Forty-two is three of the walk's own steps, so a connector is
 * never longer than a stretch of ordinary passage — and it is split into
 * segments under fourteen metres before the rock is asked, so the sampling is
 * the walk's too.
 */
const LOOP_NEAR = 10;
const LOOP_FAR = 42;
/**
 * HOW MUCH PASSAGE THE LOOP HAS TO ENCLOSE, in metres of distance-from-daylight
 * between its two welds.
 *
 * A loop that rejoins the parent thirty metres further along is not a loop, it
 * is an alcove with two doors, and it costs the player nothing to walk either
 * side of it. What makes a closure worth building is that the two ways round are
 * different enough journeys that choosing one is a decision — which is the same
 * argument BRANCH_GAP makes about junctions, at the scale of a circuit rather
 * than of a doorway. Seventy metres is two junction spacings.
 *
 * Measured through the TREE, as `|depth(target) - depth(base)|`, because that is
 * the number both welds already carry and it needs no graph walk. Where the two
 * welds are on different passages this understates the real route — it is the
 * difference of two depths rather than the path between them — so the test is
 * conservative in the direction of refusing loops, which is the right direction.
 *
 * IT WAS SEVENTY AND IT WAS THE WHOLE OF THE OTHER WAY ROUND, WHICH IS HALF THE
 * CIRCUIT. See the block in `loopCandidates`: seventy metres of enclosure plus a
 * thirty-five metre reach asks for a hairpin, and six caves over three seeds
 * closed nothing at all. Twenty-five is now only the statement that a closure is
 * not a bubble beside a doorway; LOOP_CIRCUIT is the statement that the two ways
 * round are different journeys, and it is the bar that binds.
 */
const LOOP_SPAN = 25;
/**
 * …AND THE WHOLE WAY ROUND, which is the number the player experiences.
 *
 * The other way round, plus this passage's own length, plus the connector. At
 * ninety metres the shorter way round is at least forty-five, which is a minute
 * of walking — long enough that meeting the far junction is a surprise and
 * taking it is a decision, which is the entire brief. It is deliberately in the
 * same range as BRANCH_GAP's argument about junction spacing: what makes a
 * system legible is that its features are a walk apart.
 */
const LOOP_CIRCUIT = 90;
/** How far out from the target's wall the approach node stands, in metres. */
const LOOP_PRE = 7.5;
/**
 * ARRIVE THROUGH THE WALL, NOT ALONG THE PASSAGE.
 *
 * The base weld gets this for free: a branch leaves on the wall normal, so the
 * hole is a hole in a wall and the corner behind it is at least sixty degrees.
 * Nothing gives it to the far end for free — the walk arrives on whatever
 * heading it happened to be on — and a glancing arrival is two faults at once.
 * Geometrically the hole machinery cuts an ellipse in (ring, phi) that assumes
 * the bore crosses the wall roughly square, and a bore sliding along the wall
 * cuts a window far longer than the tube behind it, which is a leak. And the
 * whole forest-occlusion argument at the top of `occludeWorld` rests on that
 * corner: a weld you can see straight down is a weld you can see daylight
 * through.
 *
 * 0.62 is 52 degrees off the target's axis at worst.
 */
const LOOP_SKEW = 0.62;
/**
 * HOW BLIND THE TARGET HAS TO BE BEFORE A CLOSURE IS FREE OF THE FOREST.
 *
 * `occludeWorld` deletes the wood when the body is deeper than the governing
 * path's `blind`, and a looping path is credited its depth through the TREE —
 * i.e. from its base weld — so near its far weld it is credited a large depth
 * and the wood is hidden. What the player can see there is through the second
 * hole into the target passage, and then however far down the target the hole
 * lets them look. If the target can see daylight at that ring, so can they, and
 * the entire forest winks out in front of somebody looking at trees.
 *
 * The pad is for the metres of target passage visible either side of the hole:
 * standing in the loop you see a cone of the target, not just its one ring.
 * Twenty metres is far more than a hole two or three metres across subtends at
 * any useful angle.
 *
 * WHERE THE TARGET IS NOT THAT BLIND THE LOOP IS STILL ALLOWED, and pays for it
 * with `blindTail` instead — see where it is set. Rejecting outright would have
 * banned every closure on a cave whose main line runs straight, which is the
 * seed that most needs one.
 */
const LOOP_BLIND_PAD = 20;
/**
 * The rings at the far end that are welded and may not be moved or wound once.
 *
 * Three is the collar `_link` doubles and `buildBranch` flares at the base, and
 * this is that mirrored, plus two so the burial's own backward slope limiter
 * cannot reach into the collar from the ring in front of it.
 */
const LOOP_COLLAR = 5;
/**
 * How many shortlisted candidates are paid for before the lead gives up.
 *
 * A candidate costs one `roofRoom` per connector node — seventeen `heightAt`
 * samples each, at most three nodes — plus a bounded sweep of the target ring
 * arrays behind a bounding-sphere reject. There is a `yield` per candidate, so
 * five of them is five slices and not one, which is what keeps this inside the
 * 1.8 ms per-slice budget rather than merely under it on average.
 *
 * Five and not four because the shortlist is now ordered by SHORTEST CONNECTOR
 * — see the score in `loopCandidates` — so the marginal candidate is a real one
 * rather than the longest reach in the cave. Against `terminusFit`'s twelve
 * `roofScan`-driven attempts, which a closure skips entirely, five is still a
 * saving.
 */
/**
 * NINE, AND IT IS A SAFETY NET RATHER THAN A LOSTNESS FEATURE.
 *
 * The block above argues the CEILING on closures from the surveyed degree range
 * and that argument is untouched: one to three a cave, never a fraction of the
 * branches. What moved is why the floor matters. A closure does not make a
 * player lost — nothing in the caving literature blames loops for
 * disorientation, and an oxbow rejoining its own passage is the commonest form
 * of one — it makes a player who IS lost come out somewhere. It is redundancy,
 * so the cost of closing too few is not a duller cave, it is a player walking a
 * lead to its end and having exactly one way back.
 *
 * FIVE WAS NOT THE CEILING BINDING, IT WAS THE SHORTLIST GOING UNSPENT.
 * Measured on grove-04 k=-1: 58 candidates survived every distance and angle
 * test and 14 were ever paid for, of which 4 failed on bore and 10 on a clash —
 * i.e. the search stopped with three quarters of its own shortlist unexamined.
 * Nine tries against a twelve-deep shortlist is the same search finishing.
 *
 * The cost is a yield per candidate and the yield is the point: a candidate is
 * up to three `roofRoom` calls plus a bounded sweep, and each one lands in its
 * OWN slice against the 1.8 ms budget rather than nine of them in one.
 */
const LOOP_TRIES = 9;
/** How deep the shortlist is kept. See LOOP_TRIES, which spends it. */
const LOOP_SHORTLIST = 12;

/**
 * Find a ring of another passage this walk could end on.
 *
 * `head` is where the node walk stopped. `targets` are the passages this branch
 * is allowed to rejoin — its parent, plus whatever it was told to avoid, which
 * between them are every passage it knows about. Returns the chosen ring, or
 * null, and does no `heightAt` work: the shortlist is scored on distances alone
 * and the caller pays for the rock check only on the candidates it tries.
 */
/**
 * WHY THE LAST CLOSURE DID NOT HAPPEN, and it is the same instrument
 * `_branchWhy` is, for the same reason.
 *
 * The first version of this search shipped with a budget, a plan and no way at
 * all to see which of seven constraints was refusing it. It closed zero loops
 * over six caves and the honest answer to "which one is binding" was a guess.
 * That is the exact blindness the block over `_branchWhy` describes costing this
 * project its second complaint, committed again one function along.
 *
 * `scan` is rings examined; the named counters are rings refused, in the order
 * the tests run, so they partition `scan` exactly:
 *
 *   scan = base + far + dive + span + wall + skew + pass
 *
 * and `pass` is the shortlist, of which at most LOOP_TRIES are paid for with
 * `roofRoom` and the clash sweep — `bore`, `reach`, `roof` and `clash` count
 * those, and `ok` is the closure.
 *
 * THE TWO NUMBERS THAT ARE NOT COUNTERS ARE THE ONES THAT SAY WHAT TO DO.
 * `nearest` is the closest any target ring ever came to the walk's head,
 * whatever else was wrong with it: if that is forty metres then no relaxation of
 * any bar helps and the answer is that these branches do not reach. `bestSpan`
 * and `bestCirc` are the largest enclosure and circuit available at a legal
 * distance, so they say directly whether the circuit bar is reachable rather
 * than merely unmet.
 *
 * A module-level object rather than a return value, for the reason `_branchWhy`
 * gives: the build is one sequential generator chain, `prepareSlice` advances
 * exactly one cave per frame, and threading a ledger out of a search that
 * refuses in seven places would be seven signature changes for a counter.
 */
const _loopWhy = {
  scan: 0,
  base: 0,
  far: 0,
  dive: 0,
  span: 0,
  wall: 0,
  skew: 0,
  pass: 0,
  bore: 0,
  reach: 0,
  roof: 0,
  clash: 0,
  ok: 0,
  nearest: Infinity,
  bestSpan: 0,
  bestCirc: 0,
};

function resetLoopWhy() {
  for (const k of Object.keys(_loopWhy)) _loopWhy[k] = 0;
  _loopWhy.nearest = Infinity;
}

/**
 * Fold one lead's search into the cave's ledger, immediately after the call.
 *
 * `nearest` pools as a MINIMUM and the two bests as MAXIMA, because they are
 * facts about the cave rather than tallies: "the closest any lead in this system
 * ever got to another passage" is the number that says whether the mountain
 * contains a legal pair at all, and summing it would say nothing. Everything
 * else is a count and adds.
 *
 * Called whether or not the lead was built and whether or not it was offered a
 * budget — `offers` carries the denominator — so a cave whose closures all
 * failed inside `buildBranch`'s own three refusals is distinguishable from one
 * whose search was never run.
 */
function loopLedger(bs, offered) {
  const w = bs.loopWhy;
  if (!offered) return;
  w.offers++;
  for (const k of Object.keys(_loopWhy)) {
    if (k === 'nearest') w.nearest = Math.min(w.nearest, _loopWhy.nearest);
    else if (k === 'bestSpan' || k === 'bestCirc') w[k] = Math.max(w[k], _loopWhy[k]);
    else w[k] += _loopWhy[k];
  }
}

function loopCandidates(head, targets, baseAlong, avoidRing, walked) {
  const out = [];
  const w = _loopWhy;
  for (let ti = 0; ti < targets.length; ti++) {
    const p = targets[ti];
    if (!p.along) continue;
    const pn = p.x.length;
    const hi = Math.min(pn - 1, p.endRing ?? pn - 1) - 6;
    const pBase = p.baseAlong ?? 0;
    for (let j = 8; j <= hi; j++) {
      w.scan++;
      const dx = p.x[j] - head.x;
      const dy = p.y[j] - head.y;
      const dz = p.z[j] - head.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      // The nearest thing this walk ever got to, whether or not it was legal.
      // If this is large, no relaxation of any other constraint can help.
      if (d2 < w.nearest * w.nearest) w.nearest = Math.sqrt(d2);
      // Never into the doorway this branch already left through, nor into the
      // rings either side of it: that is the base weld and it is already a hole.
      if (avoidRing[ti] >= 0 && Math.abs(j - avoidRing[ti]) < 24) {
        w.base++;
        continue;
      }
      if (d2 < LOOP_NEAR * LOOP_NEAR || d2 > LOOP_FAR * LOOP_FAR) {
        w.far++;
        continue;
      }
      // The reach dives at the same gradient the walk does and no faster.
      if (Math.abs(dy) * Math.abs(dy) > d2 * 0.42 * 0.42) {
        w.dive++;
        continue;
      }
      /**
       * THE ENCLOSURE AND THE CIRCUIT ARE DIFFERENT NUMBERS AND ONLY ONE OF
       * THEM IS THE POINT.
       *
       * What was here was `enclosed >= 70`, where `enclosed` is the difference
       * in distance-from-daylight between the two welds — i.e. the length of the
       * OTHER way round, and only that. It ignored the loop passage's own
       * length, which is the way round the player will actually have walked, and
       * which is routinely forty to ninety metres. So a branch that walks eighty
       * metres and rejoins the trunk forty metres further along was refused,
       * although the circuit it closes is a hundred and twenty.
       *
       * Measured: zero closures over six caves on three seeds, with the budget
       * offered every time. Trunks are 447-1325 m but the branches in a cave
       * total 201-656 m between all of them, so an individual branch is short —
       * and requiring seventy metres of enclosure while also landing within
       * thirty-five metres in space asked for a hairpin that most of these
       * mountains do not contain.
       *
       * So the bar is the CIRCUIT, which is what makes the two ways round
       * different journeys: the other way round, plus this passage, plus the
       * connector. Ninety metres is a minute and a half of walking either way.
       * `LOOP_SPAN` survives at a much smaller value as a separate statement —
       * a closure that rejoins twenty metres from where it left is a bubble
       * beside a doorway however long the bubble is.
       */
      const enclosed = Math.abs(pBase + p.along[j] - baseAlong);
      const d = Math.sqrt(d2);
      const circuit = enclosed + walked + d;
      if (enclosed > w.bestSpan) w.bestSpan = enclosed;
      if (circuit > w.bestCirc) w.bestCirc = circuit;
      if (enclosed < LOOP_SPAN || circuit < LOOP_CIRCUIT) {
        w.span++;
        continue;
      }
      // A hole a body cannot get through is not a way on. Same bar the base
      // weld uses, and the same measurement.
      if (wallHalfAt(p, j) < 1.9 * 0.82) {
        w.wall++;
        continue;
      }
      const a = Math.max(0, j - 1);
      const b = Math.min(pn - 1, j + 1);
      let tx = p.x[b] - p.x[a];
      let tz = p.z[b] - p.z[a];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const hl = Math.hypot(dx, dz) || 1;
      if (Math.abs((-dx / hl) * tx + (-dz / hl) * tz) > LOOP_SKEW) {
        w.skew++;
        continue;
      }
      /**
       * SHORTEST CONNECTOR FIRST, BIGGEST CIRCUIT SECOND, AND THAT ORDER IS THE
       * OPPOSITE OF THE FIRST VERSION'S.
       *
       * It scored `enclosed - 0.9 * d`, which puts the longest reaches at the
       * top of a shortlist that is only four deep — and a long reach is the
       * candidate most likely to fail the roof check, so the four tries were
       * spent on the four candidates least likely to work. Every candidate that
       * reaches this line has already passed the circuit bar, so the circuit is
       * satisfied rather than maximised, and what is left to prefer is the
       * connector that has the best chance of finding rock.
       */
      const score = -d + 0.12 * Math.min(circuit, 300);
      w.pass++;
      if (out.length < LOOP_SHORTLIST || score > out[out.length - 1].score) {
        out.push({ ti, j, score });
        out.sort((u, v) => v.score - u.score);
        if (out.length > LOOP_SHORTLIST) out.length = LOOP_SHORTLIST;
      }
    }
  }
  return out;
}

/**
 * HOW FAR BACK FROM A LOOP'S SECOND WELD THE FOREST MAY NOT BE HIDDEN.
 *
 * THIS IS THE BIGGEST PERFORMANCE RISK IN THE WHOLE FEATURE and it is worth
 * being slow about. `occludeWorld` stops submitting the wood — 6.57 ms against
 * 0.59, the single largest win in the project — when the body is deeper than the
 * governing path's `blind`. A path is credited its depth through the TREE, from
 * its base weld, so everywhere in a looping branch is credited a large depth and
 * the wood is hidden. That is correct at the base end, where the ten-metre rule
 * is argued from the sixty-degree corner a branch leaves through. At the FAR end
 * it is an assertion about a passage this function has never looked at.
 *
 * What a player standing in the loop's tail can see is: through the second hole,
 * into the target passage, and then as far down the target as the hole lets them
 * look. So there are two ways for hiding to be safe there, and either will do.
 *
 *   THE TARGET IS ALREADY BLIND. If the weld ring's own distance from daylight
 *   is past its passage's `blind` by LOOP_BLIND_PAD, there is no daylight on the
 *   other side of the hole to see and the tail costs nothing. This is the normal
 *   case: branches start past BRANCH_MIN_RING and a closure has to enclose
 *   LOOP_SPAN of passage, so the target is usually deep.
 *
 *   OR YOU CANNOT SEE THE HOLE. `blindAlong`, asked from the last ring walking
 *   backwards, measures exactly where the weld goes out of sight along the
 *   loop's own line. Inside that distance the answer is Infinity and the wood
 *   stays submitted; past it there is no line to the hole, let alone through it.
 *
 * A dead-straight loop passage measures Infinity — no bend, nothing ever out of
 * sight — and then the whole passage refuses to hide, which is the same safe
 * answer `blindAlong` has always given the main line and is the reason it
 * returns Infinity rather than a length.
 */
function loopBlindTail(path) {
  if (!path.loopEnd || !path.along) return 0;
  const p = path.loopTo;
  const tgt = (p.baseAlong ?? 0) + (p.along ? p.along[path.loopRing] : 0);
  if (tgt > (p.blind ?? Infinity) + LOOP_BLIND_PAD) return 0;
  const n = path.x.length;
  const t = blindAlong(path, path.along, n - 1, -1);
  return Number.isFinite(t) ? t : path.along[n - 1] + 1;
}

/* -------------------------------------------------------------------------- *
 *  THE ACUTE JUNCTION — A DOORWAY THAT IS A DIFFERENT OBJECT FROM EACH SIDE
 * -------------------------------------------------------------------------- *
 *
 * A branch has always left on the wall NORMAL, which makes the hole a hole and
 * is argued at length below. It also makes the junction perfectly SYMMETRIC in
 * time: the mouth subtends the same aperture, at the same angle, whether you are
 * walking into the mountain or back out of it. A symmetric junction is a
 * landmark you recognise from either side, and recognising junctions from the
 * other side is exactly how a player retraces a cave.
 *
 * REAL BRANCHWORK IS DENDRITIC AND DENDRITIC JUNCTIONS ARE ACUTE. Surveyed
 * junction angles come out at 45-72 deg (Seybold et al. 2017) and 49.5-75 deg
 * (Hooshyar et al. 2017), tightening to 15-45 in low relief — a tributary joins
 * its trunk pointing the way the water went, which is to say it opens BACK
 * toward the entrance. That single fact is the whole feature:
 *
 *   GOING IN, the mouth arrives from behind your shoulder at 180 - theta. You
 *   see a lip and a shadow, and you walk past it.
 *
 *   COMING BACK, the same node is a FORK whose two arms are only theta apart
 *   and which therefore look alike. This is the failure NSS accident data ranks
 *   first: 54% of 877 incidents 1980-2008 were "unable to exit", and the
 *   universal caving advice to turn round and memorise every junction exists
 *   precisely because a junction seen from the other side is a different object.
 *
 * The half of it that costs nothing and buys most is neither of those. It is
 * that COMING OUT of a lead now points you DEEPER into the cave rather than back
 * toward daylight, because the lead's own mouth is angled that way. Every side
 * passage you choose to walk costs you your bearing when you leave it.
 *
 * WHY 0.42 AND NOT THE SURVEYED 25-55 DEG. The bound is not taste, it is the
 * hole machinery: `_link` cuts its window in (ring, phi) assuming the bore
 * crosses the wall roughly square, and a bore sliding ALONG the wall cuts a
 * window longer than the tube behind it — a leak, which underground is a hole
 * you can see the sky through and is what `cave-junction`'s ray sweep exists to
 * find. LOOP_SKEW screens the far end of a closure at 0.62 of axial component,
 * which is 52 deg off the target's axis and therefore 38 deg off its normal;
 * that is the same geometry through the same code, so it is the ceiling here
 * too. 0.42 rad is 24 deg off the normal — theta of 66 deg with the trunk, the
 * open end of the surveyed range — and it is inside the ceiling with a third of
 * it to spare.
 *
 * THE REST OF THE ANGLE IS BOUGHT A NODE LATER, WHERE IT IS FREE. `firstJoint`
 * biases node TWO toward the joints that continue to lean back up the passage,
 * so the acute fork is fully formed six to nine metres in — which is where a
 * sight line resolves it anyway, and which costs the mesh nothing because by
 * then the branch is ordinary passage under the ordinary clash test.
 *
 * Node ZERO does not move. The mouth is still centred on the wall normal, so the
 * hole is still where the wall is thinnest, the two floors still meet by
 * construction, and everything the block over `MOUTH_INSET` says is untouched.
 * Only the heading node one is placed on is rotated.
 */
const MOUTH_LEAN = 0.42;
/**
 * The lean a retry at the mouth uses, as a multiple of MOUTH_LEAN. See the block
 * at `MOUTH_LEAN_TRY`'s only use, inside `buildBranch`.
 */
const MOUTH_LEAN_TRY = [1, 0.45, 1.35, 0];

function* buildBranch(c, main, joints, bi0, tag, major = false, avoid = [], wantLoop = false, opts = null) {
  _branchWhy = null;
  /**
   * ON ENTRY, NOT AT THE SEARCH. This function returns null at three places
   * before the closure search is reached — see `_branchWhy` — and the ledger is
   * folded in by the caller either way, so a reset that lived beside the search
   * would fold the PREVIOUS lead's counters in a second time for every lead that
   * never got that far. Which, given the refusal rates this pass exists to fix,
   * is most of them.
   */
  resetLoopWhy();
  const rng = makeRng(`${getWorldSeed()}:cave-branch:${c.k}:${tag}`);
  const n = main.x.length;

  /**
   * HOW MUCH WALL THERE IS WHERE A BODY IS, which is the only measure of a ring
   * that says whether it can carry a junction. See `wallHalfAt`, which is this
   * function hoisted so the far end of a loop can ask it of a passage it is
   * arriving at rather than leaving.
   */
  const walkHalf = (i) => wallHalfAt(main, i);

  /**
   * MOVE THE JUNCTION TO A RING THAT CAN CARRY ONE.
   *
   * `prepare` picks the ring by spacing alone — every so many metres along the
   * passage — which is the right rule for WHERE a player should meet a choice
   * and knows nothing about whether there is a wall there to put one in. Where
   * the main line happens to be in a slot, the opening cannot be reached from
   * the floor at all, and the branch behind it is a hundred metres of passage
   * nobody will ever stand in. `cave-branch` measured exactly that: a body
   * pinned in a 1.0 m slot with the bore 2.4 m away through the rock.
   *
   * Forward only, and by up to 34 rings — 24 m, which is under the 34 m the
   * junction spacing guarantees, so moving one junction can never overtake the
   * next. Taking the first ring that is good enough rather than the best one in
   * the window keeps the junctions where `prepare` asked for them; the running
   * best is only the fallback for a window with nothing good in it.
   */
  const MOUTH_MIN = 1.9;
  let bi = bi0;
  let bestHalf = -1;
  for (let i = bi0; i < Math.min(n - 8, bi0 + 34); i++) {
    const h = walkHalf(i);
    if (h > bestHalf) {
      bestHalf = h;
      bi = i;
    }
    if (h >= MOUTH_MIN) break;
  }
  // Nowhere near here has a wall a body could walk through. A junction that
  // cannot be entered is worth less than no junction at all.
  if (bestHalf < MOUTH_MIN * 0.82) {
    _branchWhy = 'wall';
    return null;
  }

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
  /**
   * WHICH WAY IT LEAVES, AND FOR A LEAD OFF A LEAD THAT IS NOT A COIN TOSS.
   *
   * The draw happens either way so the rng stream stays aligned, and on a branch
   * off the trunk — where `avoid` is empty — it is still exactly a coin toss,
   * which is right: both sides of the trunk are the same kind of rock.
   *
   * A SUB-BRANCH HAS A WHOLE MAIN LINE TO MISS AND ONLY ONE CHANCE TO CHOOSE.
   * Its parent is allowed to run within its own clash radius of the trunk — ten
   * to fourteen metres — and the clash test against `avoid` has no exemption at
   * all, correctly, because a sub is not supposed to touch the trunk. So a sub
   * that draws the trunk-facing side is dead on its first node, every time, and
   * there is no retry that can save it: the heading of node one is the wall
   * normal and does not change between attempts. Five of thirteen sub-branches
   * were being built, with three caves getting none of the two they planned.
   *
   * SIX METRES OF DIFFERENCE BEFORE THE DRAW IS OVERRIDDEN. Where the two sides
   * are much the same — the sub is nowhere near the trunk, which is the common
   * case — the coin toss stands and the variety is kept. Where one side is
   * genuinely into the trunk and the other is genuinely away from it, the choice
   * is not a matter of taste.
   *
   * Strided by two: rings are 0.72 m apart and the answer is being compared
   * against a six-metre bar, so every second ring is nine times the resolution
   * the decision has.
   */
  let side = rng() < 0.5 ? 1 : -1;
  if (avoid.length) {
    const clearOf = (s) => {
      const px = main.x[bi] + -tz * s * 9;
      const pz = main.z[bi] + tx * s * 9;
      let worst = Infinity;
      for (const ap of avoid) {
        for (let j = 0; j < ap.x.length; j += 2) {
          const d =
            Math.hypot(ap.x[j] - px, ap.y[j] - main.y[bi], ap.z[j] - pz) -
            ap.r[j] * ap.w[j];
          if (d < worst) worst = d;
        }
      }
      return worst;
    };
    const cPlus = clearOf(1);
    const cMinus = clearOf(-1);
    if (Math.abs(cPlus - cMinus) > 6) side = cPlus > cMinus ? 1 : -1;
  }
  /**
   * …AND A CHAMBER'S EXTRA EXITS ARE TOLD WHICH SIDE, because a coin toss is
   * how you get two doorways in the same wall.
   *
   * The draw above still happens, unconditionally, so the rng stream is aligned
   * whether or not the caller cares — the same discipline the `avoid` override
   * keeps one block up. See the chamber-exit loop in `prepare`.
   *
   * A FORCED SIDE IS THE ONLY SIDE IN THIS WORLD NOTHING ASKED THE MOUNTAIN
   * ABOUT, AND THAT IS WHERE THE LEAK CAME FROM.
   *
   * Every other junction takes the side the dice gave it or, with an `avoid`
   * list, the side with more room — and a branch that then finds no rock simply
   * ends, because the walk's own roof clamp and `roofScan` veto stop it. These
   * cannot end: the side does not change between attempts, so all four attempts
   * probe the same bare hillside, and the escape hatch at `attempt < tries - 1`
   * placed node zero anyway. The result is a `_link` window cut through a wall
   * the hillside has fallen away behind — and the tube is single-sided with
   * inward normals, so that is not a dark patch, it is a window straight out of
   * the mountain. `cave-junction` measured it as rays escaping within twenty
   * metres at two junctions on grove-01 k=0.
   *
   * So the forced side is a PREFERENCE that the rock may overrule. `roofRoom` is
   * asked how much mountain stands over a point just outside the parent's wall
   * on each side — the same rosette measure `burySkylights` and the walk both
   * use, so this cannot disagree with them — and the answer is compared against
   * the ceiling at the junction. Where the wanted side is bare and the other is
   * not, the exit takes the other and the chamber still gets its extra way on,
   * two doorways still face different directions, and nothing is cut through
   * daylight. Where BOTH are bare there is no honest doorway here at all and the
   * exit is refused, blamed on the mountain, which is what `buried` means.
   *
   * `bestHalf + 8` is where the doorway actually is: `bestHalf` is the wall a
   * body is held at — the same number `lat` is solved against below — and eight
   * metres past it is node one's own step. Probing at a fixed distance would ask
   * about the wrong place on a chamber, where the wall is fifteen metres out.
   */
  if (opts && opts.side) {
    side = opts.side;
    const ceilHere = main.y[bi] + r0 * (main.t[bi] + main.rough[bi]);
    const reach = bestHalf + 8;
    const rockOn = (s) =>
      roofRoom(main.x[bi] + -tz * s * reach, main.z[bi] + tx * s * reach, tx, tz, 4) - ceilHere;
    const wanted = rockOn(side);
    if (wanted < ROOF_ROCK) {
      const other = rockOn(-side);
      if (other > wanted + 2) side = -side;
      else if (other < ROOF_ROCK) {
        _branchWhy = 'buried';
        return null;
      }
    }
  }
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
  /**
   * …AND NO WIDER THAN THE WALL IT LEAVES THROUGH, MEASURED THE SAME WAY.
   *
   * `r0 * 0.85` bounds the branch against the parent's NOMINAL size, which is
   * the axis half-width again — so a bore that is half the size of an
   * eleven-metre chamber passes it and still cannot fit in the metre and a half
   * of slot at the bottom of one. The second term is the one that binds: ring
   * zero's own half-width, against the wall a body can actually reach.
   */
  const rb = Math.min(
    r0 * 0.85,
    rngRange(rng, sh0.lo, sh0.hi),
    (bestHalf * 1.6) / Math.max(sh0.w, 0.4)
  );
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
  /**
   * THE MOUTH GOES WHERE A BODY CAN WALK, NOT WHERE THE SECTION IS WIDEST — AND
   * `r0 * w0` IS ALWAYS WHERE IT IS WIDEST.
   *
   * `r * w` is the half-width AT THE AXIS, which is the one height in a section
   * that is guaranteed to be the maximum. Every branch was therefore hung on the
   * widest point of the main tube's outline, at the main tube's axis height —
   * and in a keyhole, a canyon or any chamber the axis is well above head
   * height and the wall out there is above the slot the body actually moves in.
   * The result is a doorway in the ceiling flare: `cave-branch` measured a body
   * held on the main axis with 1.2 m of wall at chest height, running at full
   * speed, 4.7 m short of a mouth in a bore 3.8 m across. `halfWidthAt` exists
   * precisely because "the wall at the axis" and "the wall where the body is"
   * are different numbers, and this had the same bug the wall push had.
   *
   * The other half of the same fault is the HEIGHT. Ring zero was welded to
   * `main.y[bi]` — the main's axis — and `f` was then solved to drop the
   * branch's floor onto the main's. That works while the two passages are a
   * similar size and silently fails when they are not, because `f` is clamped at
   * 1.6: a 1.9 m branch off an 11.3 m chamber needs f = 3.2 to reach down, gets
   * 1.6, and starts 1.7 m up the chamber wall. A 1.7 m ledge in the dark is not
   * a way on, it is a wall.
   *
   * So it is solved the other way round. The branch keeps its OWN section — a
   * side passage should look like a side passage, not like a slice of its parent
   * — and its axis is placed at whatever height puts its floor exactly on the
   * main's floor. The lateral offset is then the main's half-width AT THAT
   * HEIGHT. Both floors meet by construction at any size ratio, and the opening
   * is in the part of the wall a body is standing next to.
   */
  const mSh = { w: w0, t: main.t[bi], f: main.f[bi], key: main.key[bi] };
  const mouthFloor = main.y[bi] + r0 * floorAt(0, mSh);
  const first = shaped(0, 0, 0, rb, sh0);
  /**
   * Ring zero's own floor depth, kept rather than solved, and bounded so the
   * arithmetic below cannot put the axis absurdly high on a deep section.
   */
  first.f = clamp(first.f, 0.2, 1.1);
  first.y = mouthFloor + rb * first.f;
  /** Where that height is on the main's outline, in its own radius units. */
  const mouthN = clamp(
    (first.y - main.y[bi]) / r0,
    -mSh.f + 1e-3,
    mSh.t - 1e-3
  );
  /**
   * ON THE WALL THE BODY IS HELD AT, WHICH IS NOT THE WALL THAT IS DRAWN.
   *
   * Three separate allowances stand between the outline `halfWidthAt` solves
   * and the furthest a walking body ever gets from the axis, and every one of
   * them is deliberate: `caveSample` backs the wall off by half the rock
   * displacement so the head does not go into the bulges (WALL_BITE), and
   * `controller.js` backs it off again by the body's own radius and a little
   * margin. On a ten-metre chamber with `rough` 0.36 that is over two and a
   * half metres, and a mouth placed on the drawn outline is two and a half
   * metres past anywhere the player can stand.
   *
   * THE TEST IS NOT "CAN THE BODY TOUCH THE MOUTH", IT IS "DOES THE BRANCH WIN
   * THE FIT THERE" — see the selection block in `caveSample`. Both passages
   * claim the junction and the one that governs the body is the one whose
   * section the body is deeper inside, in that section's own units. That
   * measure includes a term for how far the body is ALONG the section's axis,
   * and a branch leaves through the wall — so its axis points straight back at
   * the approaching player, and every metre the mouth sits beyond where the
   * body can stand is a metre of that term counting against it. On a seven
   * metre room the parent won the junction by 0.83 to 0.79 with the body 1.9 m
   * from a bore 6.4 m across: inside the branch's section by any ordinary
   * reading of the word, and held out of it.
   *
   * So ring zero's axis goes ON the wall the body is held at, a third of a
   * metre proud of it, and the whole problem disappears rather than being
   * balanced: at the moment the parent's wall stops the body it is standing
   * essentially on the branch's own axis, so the branch wins on every term at
   * once. The cost is that the snout stands that much further into the parent
   * than the drawn wall does. It is not a cost — the first rings of a branch
   * are wound both ways and solid from every angle (see `_link`), so what it
   * draws is a rim of rock around the opening, which is what an opening in rock
   * has.
   *
   * Still never further out than the drawn wall less the inset, so the snout
   * cannot come adrift of the hole it plugs.
   */
  const bodyWall =
    bestHalf - r0 * main.rough[bi] * WALL_BITE - (BODY_HALF + 0.12);
  const lat = Math.max(
    0.5,
    Math.min(
      Math.min(r0 * halfWidthAt(mouthN, mSh), bestHalf) - MOUTH_INSET,
      bodyWall + 0.35
    )
  );
  first.x = main.x[bi] + rx * lat;
  first.z = main.z[bi] + rz * lat;

  const nodes = [first];
  /**
   * THE ACUTE LEAN, and the sign of it is the whole point. See MOUTH_LEAN.
   *
   * `(rx, rz)` is the outward wall normal and `(tx, tz)` points DOWN the parent,
   * i.e. deeper. Differentiating `d(theta) . t` at the normal gives `-side`, so
   * `+side * MOUTH_LEAN` rotates the bore back UP the passage, toward daylight.
   * Get the sign wrong and the junction is still asymmetric and asymmetric the
   * wrong way round: obvious on the way in, invisible on the way back, which
   * makes the cave easier to leave rather than harder.
   *
   * A closure's far weld is deliberately NOT given this. It arrives on whatever
   * heading the walk was on, screened by LOOP_SKEW, and the whole argument above
   * is about a mouth a player meets while walking a passage — a weld is met from
   * inside the loop, where there is no "back the way you came" to point at.
   */
  const mouthNormal = Math.atan2(rz, rx);
  /**
   * HOW MUCH LEAN THIS PARTICULAR BORE CAN CARRY, AND IT IS THE BORE'S OWN
   * ASPECT RATIO THAT SAYS.
   *
   * The block over MOUTH_LEAN bounds the angle at 38 degrees from the geometry
   * `_link` assumes, and that bound is about the bore crossing the wall squarely.
   * It is not the whole story, and `cave-junction` found the rest of it: at a
   * flat lean of 0.42 rad, eight junctions on grove-01 k=0 were sealed over 576
   * rays each and one leaked ten of them, one escaping the mountain within
   * twenty metres. The one that leaked was a BEDDING PLANE — 19.2 m wide and a
   * fifth of that tall — and the other eight were tubes, keyholes and rooms
   * three to nine metres across.
   *
   * WHY WIDTH IS THE VARIABLE. `_link` cuts the window as an ellipse in (ring,
   * phi). Its phi span comes from the bore's half-WIDTH and its ring span from
   * the bore's vertical half-extent, which is the SMALLER of `t` and `f` — see
   * the block at `path.base`. Leaning by theta slides the bore's footprint along
   * the RING axis by about sin(theta) times its half-width, and that shift has to
   * stay inside a ring span set by its height. On a tube those two are within a
   * factor of two of each other and 0.42 rad is nothing; on a bedding plane the
   * width is six times the height and the same angle walks the bore clean out of
   * its own window. That is the "bore sliding ALONG the wall cuts a window longer
   * than the tube behind it" failure, arriving through the aspect ratio rather
   * than through the angle.
   *
   * So the allowance is min(t, f) / w, which is that ratio exactly, times 2.2 for
   * the margin the eight sealed junctions demonstrate, clamped at one. A keyhole,
   * a canyon and a room keep the full design angle, a tube keeps 0.37 of a
   * radian, and a bedding plane — the only section wide enough to leak — takes
   * 0.14 and is very nearly square again.
   */
  const leanFit = clamp01((2.2 * Math.min(sh0.t, sh0.f)) / Math.max(sh0.w, 0.2));
  const mouthLean = MOUTH_LEAN * leanFit;
  let heading = mouthNormal + side * mouthLean;
  let pitch = rngRange(rng, -0.16, 0.05);
  let x = first.x;
  let y = first.y;
  let z = first.z;

  /**
   * A BRANCH HAS TO KEEP AWAY FROM ITSELF AS WELL AS FROM ITS PARENT.
   *
   * The clash test below has always been against the MAIN line's rings, and
   * against nothing else — which was defensible while a branch was three to six
   * nodes of blind lead that pinched out in twenty-five metres and could barely
   * reach round to meet itself. A major branch is ten to sixteen nodes, walks
   * the full type chain, and there are now up to two of them per cave; it is a
   * passage, and every argument the main walk's own clash test rests on applies
   * to it word for word.
   *
   * Measured on grove-01's k=0 with the main line's crossings already fixed:
   * 313 ring pairs still sharing volume, all of them inside branches. Same
   * beads, same rule, same exemption — see the block in `buildNodes`.
   */
  const beads = [];
  let walked = 0;
  const bead = (a, b) => {
    /**
     * 1.15 FOR THE SPLINE'S OWN OVERSHOOT, AND IT IS NOT A SAFETY FACTOR.
     *
     * `resample` runs Catmull-Rom over the RADIUS as well as the position, and
     * Catmull-Rom is interpolating rather than convex — so the fattest ring
     * between two nodes is fatter than either of them. Measured at 26.6 m
     * between two 19 m nodes. A clash test that quotes node radii is therefore
     * testing a passage narrower than the one that will be drawn, by up to a
     * seventh, everywhere. `terminusFit` has always padded its chamber for this;
     * the walk did not, and the difference showed up as ring pairs a hundred
     * metres apart along the line sitting seven metres apart in space with every
     * node centre legitimately clear.
     */
    const half = Math.max(a.r * a.w, b.r * b.w) * 1.15;
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    beads.push({
      x: (a.x + b.x) * 0.5,
      y: (a.y + b.y) * 0.5,
      z: (a.z + b.z) * 0.5,
      half,
      at: walked + len * 0.5,
    });
    walked += len;
    beads.push({ x: b.x, y: b.y, z: b.z, half: b.r * b.w * 1.15, at: walked });
  };
  beads.push({ x: first.x, y: first.y, z: first.z, half: first.r * first.w * 1.15, at: 0 });

  /**
   * FOUR TO EIGHT NODES RATHER THAN THREE TO SIX, and the argument is the yield
   * ledger rather than the shape.
   *
   * `nodes.length < 3` is the bar below, so a minor lead that loses two of its
   * candidates is not a short lead, it is a refusal — 41 of 131 planned junctions
   * across eighteen caves died there. Starting one node higher moves the whole
   * distribution off the bar without changing what a lead IS, and the extra node
   * is also what pays for the shorter steps `spacing` now takes on a narrow
   * section: a canyon lead cornering every eight metres needs more of them to be
   * a passage rather than a bend.
   */
  const count = major ? 11 + Math.floor(rng() * 8) : 4 + Math.floor(rng() * 5);
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
    /**
     * …AND "WHAT IT IS GIVEN" WAS ONE CANDIDATE, WHICH IS NOT THE SAME ARGUMENT.
     *
     * The paragraph above is about how a lead ENDS and it is right about that: a
     * lead that pinches out on its fourth node is a lead, and a lead that runs to
     * its full six is a lead, and neither is a failure. But `tries = 1` does not
     * only decide where a lead ends. It decides whether there is a lead AT ALL,
     * because the same loop places node one — and a minor branch that loses its
     * first candidate has two nodes, which is under the `nodes.length < 3` bar
     * below, which is not a short lead, it is a hole in the wall with nothing
     * behind it and a `_link` window cut for a passage that was never built.
     *
     * That is one of the three reasons 46% of planned junctions were vanishing.
     * With the counters over `_branchWhy` in place it is the one that can be
     * bought back cheapest: 'short' is the rejection that a second candidate
     * fixes, where 'wall' is a fact about the parent's section and 'buried' is a
     * fact about the mountain.
     *
     * THREE AND NOT FIVE, AND THE BUDGET IS WHY. An attempt costs a `roofScan`
     * — seventeen `heightAt` samples — plus a sweep of every ring of the parent,
     * of the avoid list and of this branch's own beads, and the `yield` is
     * outside this loop, so all of a node's attempts land inside ONE slice
     * against a 1.8 ms per-slice budget. A major branch already runs five in a
     * slice and the worst slice ever measured is 1.10 ms, so three is strictly
     * inside a case that already ships. Five would be too, on that reasoning;
     * three is where the return stops, because a lead whose first three
     * candidates all clash is in rock that has nothing to offer it.
     */
    /**
     * FOUR FOR A MINOR LEAD, BECAUSE THE FOURTH TRY IS NOW A DIFFERENT BORE.
     *
     * The paragraph above closes at three on the grounds that "a lead whose
     * first three candidates all clash is in rock that has nothing to offer it",
     * and that was sound while every attempt at node one placed the node in the
     * same place. MOUTH_LEAN_TRY has four rungs and the fourth is the square bore
     * this function built for its whole life, so stopping at three would refuse
     * the mouth the old code would have accepted. The cost is one more `roofScan`
     * on the leads that were going to be refused anyway.
     */
    const tries = major ? 5 : 4;
    let placed = false;
    for (let attempt = 0; attempt < tries && !placed; attempt++) {
      // Node one keeps the leaned wall normal so the mouth is still a hole in a
      // wall; after that the branch joins the joint set like everything else.
      let h = heading;
      /** Whether this node is a dog-leg. Hoisted: `spacing` below reads it. */
      let turn = false;
      /**
       * A RETRY AT THE MOUTH NOW MEANS SOMETHING, WHICH IS WHY `tries` COULD
       * NEVER BUY THE 'short' REFUSALS BACK.
       *
       * The block below this one records the finding and does not act on it:
       * "node one's heading is the wall normal and is NOT re-drawn on a retry,
       * so all three attempts place the node in essentially the same place and
       * clash identically. A count of tries cannot fix a constraint that is the
       * same on every try." That was exactly right, and it stayed true after the
       * exemption fix — 41 of 129 tried junctions across eighteen caves still
       * died on `nodes.length < 3`, and every one of them is a subsystem the room
       * asked for and did not get.
       *
       * MOUTH_LEAN is what makes a retry a different question. The lean is a free
       * parameter inside the ceiling the hole machinery sets, so the ladder walks
       * it: the design angle first, then nearly square, then wide (0.57 rad, 32.5
       * deg off the normal, still inside the 38 the block over MOUTH_LEAN
       * derives), then square. Four genuinely different bores through the same
       * wall, all of them acceptable geometry, and the first one that finds rock
       * wins. Nothing else about the mouth changes — the snout, the floor weld
       * and the `_link` window are all built off node zero, which does not move.
       */
      if (i === 0 && attempt > 0) {
        h = mouthNormal + side * mouthLean * MOUTH_LEAN_TRY[attempt % MOUTH_LEAN_TRY.length];
      }
      if (i > 0) {
        let bestD = Infinity;
        let bestH = heading;
        const near = [];
        /**
         * A DOG-LEG IS A CHANGE OF BEARING, NOT A REVERSAL, AND THE DIFFERENCE
         * COST TWO METRICS AT ONCE.
         *
         * `near` is everything within 1.9 rad — 109 degrees — and it is the
         * right pool for a RETRY, where the question is "is there anywhere at
         * all this lead can go". It is the wrong pool to turn onto by choice.
         * With the step now scaled to the bore, a canyon taking a 109-degree
         * joint over 0.62 of an eight-metre spacing is a five-metre hairpin, and
         * a hairpin is not a corner: it is a passage lying alongside itself.
         *
         * Measured, and this is why the pool is split rather than the rate
         * lowered. Over grove-04's three caves, section overlaps — two rings
         * sharing volume, which from inside is a hole with the back of another
         * wall behind it — went from 0.0 a cave to 2.7, the worst of them two
         * stretches of the same lead 33 m apart along the line and 4.5 m apart in
         * space. The same hairpins took the closure rate down with them, from
         * 0.78 a cave to 0.33: a connector leaving a head that has doubled back
         * has this branch's own line lying across it, and 18 of 22 paid
         * candidates on grove-04 k=-1 were refused for exactly that.
         *
         * 1.45 rad is 83 degrees, which is also where the surveyed joint sets
         * are — two bearings 60 to 90 degrees apart, with the second set the one
         * a dog-leg turns onto. So the pool that produces the corner the player
         * wants and the pool that produces geometry that cannot cross itself are
         * the same pool, and neither of them is 109 degrees.
         */
        const dog = [];
        for (const j of joints) {
          const d = Math.abs(((j - heading + Math.PI) % TAU + TAU) % TAU - Math.PI);
          if (d < 1.9) near.push(j);
          if (d < 1.45 && d > 0.35) dog.push(j);
          if (d < bestD && d < 1.5) {
            bestD = d;
            bestH = j;
          }
        }
        /**
         * A BRANCH TURNS MORE THAN THE MAIN LINE, AND THIS IS WHERE THE ROOM'S
         * "MORE TWISTS AND TURNS" WENT.
         *
         * The first attempt used to hold the nearest joint unconditionally,
         * which is what kept a lead running straight the way the main line does.
         * Straight is the right default for the main line and the wrong one
         * here, and the A/B over `count` says why: on the trunk, turning costs
         * length, and length is depth, and depth is the chambers — a ninth more
         * turning cost a quarter of the tall metres. A branch has NONE of that
         * to lose. It has no depth envelope, no `bottom`, no chamber to unlock
         * and only a centre-line roof clamp, so a corner in a lead costs a
         * refusal and nothing else. It is also the part of the cave the player
         * is choosing to walk, so it is where a corner is worth most: a lead
         * that bends is a lead you cannot see the end of from its mouth.
         *
         * A little under half the nodes now take a different joint. The pool it
         * takes one from is the same `near` set a retry uses — anything within
         * 1.9 rad, which excludes the reversal into the passage just cut and
         * nothing else.
         */
        /**
         * …AND IT IS NOW A LITTLE OVER HALF, WHICH IS THE DOG-LEG RATE AND NOT A
         * TWISTINESS DIAL.
         *
         * What makes a passage hide its own end is not deg/100m, it is a BROKEN
         * SIGHT LINE, and a broken sight line is a corner taken over a short
         * enough run that the spline cannot fillet it. Both halves of that are
         * now here: this decides how often the lead changes bearing, and
         * `spacing` below shortens the step it changes bearing over, so a
         * dog-leg is 0.62 of an already width-scaled step rather than a
         * fourteen-metre arc. A 40-degree bend with a ten-metre radius is
         * turning you can measure and cannot perceive.
         */
        turn = i > 1 && dog.length > 0 && rng() < 0.58;
        /**
         * NODE TWO LEANS BACK UP THE PASSAGE, which is the other half of
         * MOUTH_LEAN and the half that is free.
         *
         * The lean at the mouth is capped at 24 degrees off the normal by the
         * hole machinery. The surveyed junction angle wants more than that, and
         * a node the branch has already walked to is under nothing but the
         * ordinary clash test — so the rest of the angle is taken here, by
         * preferring whichever joint in `near` continues to point back toward
         * the parent's upstream. By node two the fork is fully formed, which is
         * also the first place a sight line could have resolved it.
         *
         * A preference and not a rule: where no joint leans back, `bestH`
         * stands and the lead runs on the joint set like any other passage.
         */
        if (i === 1 && !turn && near.length) {
          let bestBack = -Infinity;
          for (const j of near) {
            const back = -(Math.cos(j) * tx + Math.sin(j) * tz);
            if (back > bestBack) {
              bestBack = back;
              bestH = j;
            }
          }
        }
        /**
         * A CHOSEN CORNER COMES OUT OF `dog`; A RETRY STILL COMES OUT OF `near`.
         *
         * The two draws are kept separate and BOTH consume the rng whichever
         * fires, so the stream stays aligned — the same discipline the `side`
         * override keeps. A retry is the lead asking whether it can go anywhere
         * at all and is entitled to the full 109 degrees; a dog-leg is the lead
         * choosing, and choosing badly is what put a passage alongside itself.
         */
        h =
          turn && dog.length
            ? dog[Math.floor(rng() * dog.length)] + rngRange(rng, -0.2, 0.2)
            : attempt === 0 || !near.length
              ? bestH + rngRange(rng, -0.2, 0.2)
              : near[Math.floor(rng() * near.length)] + rngRange(rng, -0.2, 0.2);
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
      /**
       * HOW FAR A LEAD RUNS BEFORE IT MAY BEND, AND IT IS A MULTIPLE OF ITS OWN
       * WIDTH RATHER THAN A CONSTANT.
       *
       * This was a flat 9-16 m for every section in the table, and a constant is
       * the one thing corner spacing is not. Meander wavelength scales with
       * channel width in every surface stream that has ever been measured, and a
       * vadose canyon is a stream; the same 14 m of straight that reads as a
       * gentle bend in a passage eight metres across is a dead straight corridor
       * in one three metres across. So the room's "more twists and turns" is not
       * one number to raise — a flat spacing is simultaneously too twisty for the
       * wide sections and far too straight for the narrow ones, which is the
       * shape of complaint you get when a distribution is collapsed to its mean.
       *
       * `bore` is this section's typical full width, taken from the TABLE rather
       * than from the radius drawn below, for two reasons: the draw has not
       * happened yet at this line, and taking it from the table keeps the spacing
       * a property of the KIND of passage rather than of one node's dice. A
       * canyon comes out at 8 m and a bedding plane or a room at 20.
       *
       * The clamp is what stops it being silly at either end. Below eight metres
       * a "corner" is inside the spline's own control spacing and the resample
       * eats it; above twenty the lead is a corridor again whatever its width.
       *
       * AND A DOG-LEG IS TAKEN SHORT. The turn radius the player sees is
       * essentially the step the bearing changes over, so a corner taken at 0.62
       * of the spacing is a corner you cannot see round — which is the whole
       * difference between turning that moves `deg/100m` and turning that hides
       * the end of a passage. Node one is exempt: it is the mouth, and its length
       * is set by how far the snout has to stand out of the parent's wall.
       */
      /**
       * 1.8 AND A CEILING OF 16, MEASURED RATHER THAN DERIVED.
       *
       * Surface-meander scaling puts the wavelength at ten to fourteen channel
       * widths, and the first cut of this took that literally at 2.2 x bore with
       * a ceiling of 20. It was two-scale and it was NET NEUTRAL: measured over
       * grove-01's three caves the branch turning went 298 -> 296 deg/100m,
       * because it made the narrow sections twistier and the wide ones straighter
       * by almost exactly the same amount. Correct physics, wrong operating point
       * — the room asked for more turning and got a redistribution of it.
       *
       * So the ceiling comes down to sixteen, which is the top of the flat 9-16
       * this replaced rather than half again on it, and the slope with it. The
       * SHAPE of the rule is what was wanted and is kept: a canyon still corners
       * at eight metres and a room still does not get chopped into bends. What
       * changed is that a bedding plane no longer runs twenty metres straight.
       */
      const bore = (sh.lo + sh.hi) * sh.w;
      const spacing = clamp(1.8 * bore, 8, 16);
      const step =
        i === 0
          ? rngRange(rng, 6, 9)
          : rngRange(rng, spacing * 0.74, spacing * 1.16) * (turn ? 0.62 : 1);
      /**
       * A major branch leans downhill like the main walk does, so taking the
       * fork is also going deeper rather than sideways.
       *
       * …AND A CHAMBER'S OWN AXIS IS LEVEL HERE TOO, WHICH THIS DID NOT KNOW.
       *
       * `buildNodes` has had that rule since the first hall, and the block over
       * its own `p` is where the reasoning is: `caveSample` answers the floor
       * from ONE ring while the drawn floor at a point is the lowest of every
       * section that reaches it, so wherever the floor line has a gradient the
       * two disagree by roughly (gradient x half-width). That is nothing in a
       * four-metre passage and metres in a chamber.
       *
       * This function never got the rule, and it did not matter while a branch's
       * biggest section was a `room` the burial had ground down to five metres.
       * It matters now: `room` is sized from the rock like everything else and
       * reaches sixteen metres of radius in a side passage, and a branch dives at
       * up to -0.4. Measured on grove-01, a sixteen-metre chamber on a branch
       * diving at 0.43 put the body four and a half metres UNDER the rock it can
       * see, over a run of nine consecutive rings, and eight of the ten worst
       * floor disagreements in the cave were in that one chamber.
       *
       * IT DID NOT MOVE THE TOTAL, and that is worth writing down rather than
       * quietly leaving out: `cave-floor`'s count went from 412 to 413, because
       * `vast` nodes in branches are rare enough that fixing them reshuffles the
       * rng more than it fixes the metric. It is here because the rule is right
       * and the main walk has had it for the same reason since the first hall —
       * not because it was worth a number.
       *
       * Same envelope as the main walk's: near level, inheriting almost none of
       * the dive it arrived on. The descent has not gone anywhere — it is in the
       * passage leading to the chamber, which is where a real one is anyway.
       */
      const pWant = clamp(pitch + rngRange(rng, -0.16, 0.12) + (major ? -0.05 : 0), -0.4, 0.12);
      /**
       * …AND THE SNOUT LEAVES AT GRADE, WHICH IT DID NOT HAVE TO BEFORE THE LEAN.
       *
       * Node one used to go straight out through the wall on the normal, so
       * whatever it did vertically it did OUTSIDE the parent's bore and could not
       * undercut it. MOUTH_LEAN points it back up the passage instead, and a
       * first step of 6-9 m at the -0.4 this loop permits then puts three metres
       * of branch floor three metres UPSTREAM of the junction and three metres
       * below it — under the parent, whose own floor is climbing that way.
       *
       * The drawn floor at a point is the LOWEST of every section that reaches
       * it and `caveSample` answers from one ring, so that is a body standing on
       * the parent's floor with the branch's floor visible under its feet.
       * Measured on grove-01 by `cave-floor`: a 2.72 m hover against a 1.00 m
       * bar, which is the gate's own definition of flight, at a keyhole ring
       * beside a junction — and the lean is what put it there.
       *
       * Level for one step and no further. It is also what a tributary does: an
       * inlet joins its trunk at grade, and the drop is in the passage BEHIND the
       * junction rather than in the doorway. Every argument the block over `pn`
       * makes about a chamber's axis being level is the same argument, at the one
       * other place in this function where the floor has to agree with something
       * that is not itself.
       */
      const pn = SHAPES[kind].vast
        ? clamp(pitch * 0.12 + rngRange(rng, -0.07, 0.03), -0.11, 0.06)
        : i === 0
          ? clamp(pWant, -0.05, 0.05)
          : pWant;
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
      /**
       * A CHAMBER IN A LEAD IS CAPPED AND THE MAIN LINE'S IS NOT, AND THE FIRST
       * TIME THIS WAS MEASURED IT LOOKED WORTHLESS.
       *
       * The mechanism is `flatten`'s, quoted at its own `win`: `caveSample`
       * answers the floor from ONE ring while the drawn floor at a point is the
       * lowest of every section that reaches it, and the gap between those two
       * grows with the half-width. The block over `pn` above records eight of the
       * ten worst floor disagreements in a cave being inside one sixteen-metre
       * `room` on a branch. So a cap here should move `cave-floor` and cost some
       * tall metres, and the first A/B said it moved the worst hover by exactly
       * 0.00 m — 1.40 m before and after, the same probe.
       *
       * THAT NULL RESULT WAS AN ARTEFACT OF THE ARM IT WAS RUN ON. At that point
       * node one propagated its LEVEL pitch forward, so every lead in the world
       * ran shallow, so `chamberFit` had little rock to answer with and no branch
       * chamber was anywhere near the cap. Nothing was being capped, which is why
       * capping changed nothing. Putting the descent back — see `pitch` at the
       * bottom of this loop — took the worst hover to 2.40 m and the pooled tall
       * metres to 899, and the cap then binds on the objects it was written for.
       *
       * Twelve metres is still half again the widest ordinary passage in the
       * table and is a space you notice walking into; it is the runaway 16-26 m
       * case that is refused, and refused only in a lead, where nothing the tall
       * metres are budgeted for depends on it.
       */
      if (sh.vast) {
        r = Math.max(SHAPES.tube.lo, Math.min(12, chamberFit(nx, nz, ux, uz, ny, sh, r)));
      }
      /**
       * THE FIRST STEP KEEPS THE FLOOR, NOT THE AXIS, AND THE DIFFERENCE IS A
       * STEP IN THE DOORWAY.
       *
       * Ring zero is welded so that its floor lands exactly on the parent's —
       * that is the whole of the `mouthFloor` block above, and it is right. Node
       * ONE then inherited ring zero's AXIS height and added `sin(pitch) * step`,
       * which is a different quantity: ring zero's `f` was solved to make the
       * weld work and is clamped to [0.2, 1.1], while node one's is whatever its
       * section's table says. A canyon at 3.4 m of radius carries its floor 2.5 m
       * under its axis; a weld ring clamped to f = 0.2 at the same radius carries
       * it 0.7 m under. Same axis, 1.8 m of floor step, six to nine metres from a
       * junction — which is inside the parent's own section, so `caveSample`
       * answers one ring's floor while the drawn floor is the lower of two.
       *
       * That is a hover, and it is the fault `cave-floor` gates: measured on
       * grove-01 at 1.41 m against a 1.00 m bar, with the body standing on the
       * parent's floor and the branch's floor drawn under its feet. MOUTH_LEAN
       * made it visible rather than caused it — leaning the first step back up
       * the passage puts that step under the parent instead of out in the rock,
       * where it had been harmlessly wrong for as long as branches have existed.
       *
       * So the first step is solved from the FLOOR: whatever radius and section
       * node one drew, its axis goes wherever puts its floor on the parent's. The
       * passage is level and continuous through the doorway and starts descending
       * at node two, which is also what a real inlet does — see the block at `pn`
       * one screen up, which is the same argument about the same first step.
       */
      if (i === 0) ny = mouthFloor + r * sh.f;
      ny = Math.min(ny, heightAt(nx, nz) - r * sh.t - ROOF_ROCK);

      /**
       * …and do not run along the lip of a ravine, which the centre-line clamp
       * above cannot see. Retries only, so a branch with nowhere good to go
       * still goes somewhere rather than stopping at the junction.
       */
      /**
       * …EXCEPT AT NODE ZERO, WHERE THE ESCAPE HATCH IS THE LEAK.
       *
       * "A branch with nowhere good to go still goes somewhere rather than
       * stopping at the junction" is the right rule for the BODY of a lead: a
       * passage that runs out of mountain on its fifth node is a passage that
       * ends, which is what leads do, and refusing it would only trade a short
       * lead for no lead. It is the wrong rule for the DOORWAY. Node zero is not
       * a place the passage goes, it is the hole in the wall — and a hole in a
       * wall with no rock over it is not a short lead, it is a window out of the
       * hillside, which `cave-junction` gates and this file treats as
       * unshippable.
       *
       * The asymmetry is the whole point: everything past node zero may fail
       * softly, node zero may not fail at all. A branch refused here returns
       * `buried` from the block under the attempt loop rather than falling
       * through to `short`, because the mountain is what refused it and the
       * ledger should say so.
       */
      if (attempt < tries - 1 || i === 0) {
        // Nominal, not jittered — see the block on the main walk's own veto.
        const s = roofScan(nx, nz, ux, uz, r * sh.w);
        if (roofDrop(s, ny, sh, r) > -ROOF_ROCK * 0.3) continue;
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
      /**
       * THE EXEMPTION IS A DISTANCE AND WAS BEING WRITTEN AS A RING COUNT, AND
       * IT WAS SMALLER THAN THE OVERLAP IT EXISTED TO EXEMPT.
       *
       * Twelve rings is 8.64 m at the current step. `min` below — the distance
       * at which two sections are judged to be sharing a volume — is `main.r *
       * main.w + r * sh.w + 3`, which on an ordinary passage off an ordinary
       * passage is ten to fourteen metres. So the exemption was two to six
       * metres NARROWER than the clash radius, and node one of every branch,
       * placed six to nine metres out on the wall normal, sits inside `min` of
       * the parent rings just past the window's edge. It is rejected by the wall
       * it is leaving through — which is the exact failure the paragraph above
       * says the exemption exists to prevent, committed by the exemption itself.
       *
       * This is what `nodes.length < 3` was counting. Measured: 20 of 24 branch
       * refusals across three seeds were 'short', and raising `tries` from one to
       * three did not move it — because node one's heading is the wall normal and
       * is NOT re-drawn on a retry, so all three attempts place the node in
       * essentially the same place and clash identically. A count of tries cannot
       * fix a constraint that is the same on every try.
       *
       * TWO CONDITIONS, AND THE SECOND IS WHAT KEEPS IT HONEST. A ring is exempt
       * only while it is within `min` metres ALONG the line of the junction AND
       * the node being placed is still within `min + 4` of the junction itself.
       * The first says "this is the stretch of parent the branch is merging
       * with"; the second says "and the branch has not walked away yet". Once it
       * has, every ring of the parent is tested with no licence at all, so a
       * branch that curls back forty metres on is caught exactly as before —
       * which is the failure mode the whole test is for.
       *
       * `Math.abs(j - bi) * RING_STEP` is exact rather than approximate: rings
       * are evenly spaced by construction, which is what `resample` is for.
       */
      const near0 = Math.hypot(nx - main.x[bi], ny - main.y[bi], nz - main.z[bi]);
      let clash = false;
      for (let j = 0; j < n && !clash; j++) {
        const dx = main.x[j] - nx;
        const dy = main.y[j] - ny;
        const dz = main.z[j] - nz;
        const min = main.r[j] * main.w[j] + r * sh.w + 3;
        if (Math.abs(j - bi) * RING_STEP < min && near0 < min + 4) continue;
        if (dx * dx + dy * dy + dz * dz < min * min) clash = true;
      }
      /**
       * …AND EVERY OTHER PASSAGE IN THE SYSTEM, WITH NO EXEMPTION AT ALL.
       *
       * The window above exists because a branch is SUPPOSED to touch the
       * passage it leaves — that is the junction. Nothing else in the cave has
       * that licence, and a lead off a lead has a whole main line to miss that
       * the test above knows nothing about. Two passages sharing a volume is,
       * from inside, a hole in the wall with the back of another wall behind
       * it; the reason it has never been seen is that until now there was only
       * ever one thing to hit.
       */
      for (let a = 0; a < avoid.length && !clash; a++) {
        const ap = avoid[a];
        const an = ap.x.length;
        for (let j = 0; j < an; j++) {
          const dx = ap.x[j] - nx;
          const dy = ap.y[j] - ny;
          const dz = ap.z[j] - nz;
          const min = ap.r[j] * ap.w[j] + r * sh.w + 3;
          if (dx * dx + dy * dy + dz * dz < min * min) {
            clash = true;
            break;
          }
        }
      }
      // …and against the branch's own line, on the beads. See the block above
      // `beads` and the one it points at in `buildNodes`.
      for (let s = 1; s <= 4 && !clash; s++) {
        const f = s / 4;
        const px = x + (nx - x) * f;
        const py = y + (ny - y) * f;
        const pz = z + (nz - z) * f;
        for (let j = 0; j < beads.length; j++) {
          const bd = beads[j];
          const min = bd.half + r * sh.w * 1.15 + 3.5;
          if (walked - bd.at < min + 8) continue;
          const dx = bd.x - px;
          const dy = bd.y - py;
          const dz = bd.z - pz;
          if (dx * dx + dy * dy + dz * dz < min * min) {
            clash = true;
            break;
          }
        }
      }
      if (clash) continue;

      const nd = shaped(nx, ny, nz, r, sh, rng);
      nd.type = kind;
      bead(nodes[nodes.length - 1], nd);
      nodes.push(nd);
      heading = h;
      /**
       * THE DOORWAY IS LEVEL AND THE LEAD IS NOT, AND THE SECOND HALF OF THAT
       * COST 15% OF THE DEEP CHAMBERS BEFORE IT WAS PUT BACK.
       *
       * `pn` above holds node one level so the floor is continuous through the
       * junction. Carrying that level pitch FORWARD as well made the whole lead
       * run shallow — `chamberFit` grants a radius out of the rock overhead, so a
       * branch that starts its descent one node late is a branch under less
       * mountain for its whole length. Measured over the eighteen caves: pooled
       * metres over 25 m tall went from 978 to 824, against a floor of 890 that
       * may not fall.
       *
       * So the WISH is what propagates. Node one is placed level; node two starts
       * from the gradient node one would have taken, and the descent is a node
       * late rather than a node short. Pooled metres over 25 m: 824 with the
       * level pitch propagating, 899 with the wish propagating, against the 890
       * that may not fall — and the doorway is level either way, so none of it
       * comes back out of `cave-floor`.
       */
      pitch = i === 0 ? pWant : pn;
      type = kind;
      x = nx;
      y = ny;
      z = nz;
      placed = true;
    }
    // Every attempt refused: this is where the lead ends, and a lead that ends
    // is the normal case rather than a failure.
    // …unless it is node ZERO, which is the doorway rather than the lead. See
    // the roof veto above: there is no such thing as a junction that half
    // happened, so this is a refusal and the mountain is what refused it.
    if (!placed) {
      if (i === 0) {
        _branchWhy = 'buried';
        return null;
      }
      break;
    }
  }

  // Too short to be a lead — it would read as a dent, not a way on.
  if (nodes.length < 3) {
    _branchWhy = 'short';
    return null;
  }

  /**
   * …OR IT DOES NOT END AT ALL. See the LOOP CLOSURE block above `buildBranch`.
   *
   * Tried BEFORE the terminus, and that ordering is the whole cost argument: a
   * closure replaces `terminusFit` rather than running alongside it, so a cave
   * that loops does strictly less roof work than one that does not.
   *
   * The candidate list is scored on distances alone; the rock over the connector
   * is only asked about for candidates that survive everything else, and at most
   * four of them. `roofRoom` is seventeen `heightAt` samples, so the worst case
   * here is twelve — three probes on four candidates — against the twelve full
   * `roofScan`-driven attempts `terminusFit` runs.
   */
  let loop = null;
  if (wantLoop) {
    yield 'branch-loop';
    const head = nodes[nodes.length - 1];
    const targets = [main, ...avoid];
    // Which ring of each target is this branch's own base, so the search can
    // stay away from a doorway that already exists. -1 for a passage the branch
    // did not leave through.
    const avoidRing = targets.map((p) => (p === main ? bi : -1));
    const baseDepth = (main.baseAlong ?? 0) + (main.along ? main.along[bi] : 0);
    const cands = loopCandidates(head, targets, baseDepth, avoidRing, walked);
    for (let ci = 0; ci < cands.length && ci < LOOP_TRIES && !loop; ci++) {
      /**
       * PER CANDIDATE, and it is the same argument the walk's `tries` block
       * makes. A candidate costs up to two `roofRoom` calls — 34 `heightAt`
       * samples — plus a bounded sweep of the target ring arrays. Four of them
       * inside one slice is the shape of hitch the ring budget exists to stop,
       * and the whole build is cut to this granularity anyway.
       */
      yield 'branch-loop';
      const p = targets[cands[ci].ti];
      const j = cands[ci].j;
      const pn = p.x.length;
      const ja = Math.max(0, j - 1);
      const jb = Math.min(pn - 1, j + 1);
      let ttx = p.x[jb] - p.x[ja];
      let ttz = p.z[jb] - p.z[ja];
      const ttl = Math.hypot(ttx, ttz) || 1;
      ttx /= ttl;
      ttz /= ttl;
      /**
       * THE WELD IS THE BASE WELD, MIRRORED, AND IT IS THE SAME TWELVE LINES.
       *
       * Its own section, kept, so a passage arriving looks like a passage and
       * not like a slice of the one it joins; its axis at whatever height puts
       * its floor exactly on the target's floor; the lateral offset then read
       * off the target's outline AT THAT HEIGHT and pulled in to the wall a
       * walking body is actually held at. Every one of those three decisions is
       * argued at length over the base weld and none of the arguments change for
       * being at the other end of the tube.
       */
      const side2 = (head.x - p.x[j]) * -ttz + (head.z - p.z[j]) * ttx >= 0 ? 1 : -1;
      const rx2 = -ttz * side2;
      const rz2 = ttx * side2;
      const pr = p.r[j];
      const tSh = { w: p.w[j], t: p.t[j], f: p.f[j], key: p.key[j] };
      const tHalf = wallHalfAt(p, j);
      /**
       * NEVER A CHAMBER AT THE WELD, whatever the walk happened to be in.
       *
       * The last node of a lead can be a `room`, and a room welded into a wall
       * is a room whose far half is inside another passage — the two surfaces
       * then argue about which is in front for the whole width of it. The same
       * argument the base weld makes about a branch never being wider than the
       * passage it leaves, in the one case `rE`'s three-way minimum cannot catch:
       * `vast` sections are wide in `w` rather than in `r`.
       */
      const kindE = SHAPES[type].vast ? 'tube' : type;
      const shE = SHAPES[kindE];
      const rE = Math.min(
        head.r,
        pr * 0.85,
        (tHalf * 1.6) / Math.max(shE.w, 0.4)
      );
      /**
       * A CLOSURE YOU CANNOT WALK THROUGH IS A DEAD END YOU CAN SEE THROUGH,
       * and the radius bar alone does not say whether you can.
       *
       * `SHAPES.tube.lo * 0.7` is 1.82 m of RADIUS and it is the base weld's
       * bar, where the section is whatever the branch chose. Here the section is
       * inherited from the walk's last node, and the four small sections put
       * wildly different amounts of that radius into height: a canyon is 2.36
       * radii tall and a bedding plane 0.74. So the same 1.9 m radius is a 4.5 m
       * doorway or a 1.4 m slot depending only on what the lead happened to be
       * walking, and the radius test cannot tell them apart.
       *
       * `cave-branch` gates the far aperture at 1.7 m and found a 1.20 m one, at
       * a weld whose radius passed this line comfortably. So the height is tested
       * as a height. MIN_HEAD is what `resample` inflates every ordinary ring to
       * and is the file's own statement of what a body fits through; 1.25 of it
       * is the margin for what `burySkylights` may still take off a weld ring
       * afterwards, which is the difference between the number solved here and
       * the number the gate measures.
       */
      if (rE < SHAPES.tube.lo * 0.7 || rE * (shE.t + shE.f) < MIN_HEAD * 1.9) {
        _loopWhy.bore++;
        continue;
      }
      const weld = shaped(0, 0, 0, rE, shE);
      weld.type = kindE;
      weld.f = clamp(weld.f, 0.2, 1.1);
      weld.y = p.y[j] + pr * floorAt(0, tSh) + rE * weld.f;
      const wN = clamp((weld.y - p.y[j]) / pr, -tSh.f + 1e-3, tSh.t - 1e-3);
      const bodyWall2 = tHalf - pr * p.rough[j] * WALL_BITE - (BODY_HALF + 0.12);
      const lat2 = Math.max(
        0.5,
        Math.min(Math.min(pr * halfWidthAt(wN, tSh), tHalf) - 0.4, bodyWall2 + 0.35)
      );
      weld.x = p.x[j] + rx2 * lat2;
      weld.z = p.z[j] + rz2 * lat2;

      /**
       * The approach node stands out on the wall normal, exactly as node one of
       * a branch does at the base. It is what makes the last stretch square to
       * the wall — the arrival angle LOOP_SKEW screens for is the walk's, and
       * this is what turns "roughly square" into "square".
       */
      const pre = shaped(
        weld.x + rx2 * LOOP_PRE,
        weld.y,
        weld.z + rz2 * LOOP_PRE,
        Math.min(head.r, rE * 1.15),
        shE
      );
      pre.type = kindE;
      const reach = Math.hypot(pre.x - x, pre.y - y, pre.z - z);
      if (reach < 6 || reach > LOOP_FAR) {
        _loopWhy.reach++;
        continue;
      }
      const link = [];
      /**
       * FOURTEEN, BECAUSE THAT IS THE WALK'S OWN SAMPLING AND THE ROOF CHECK
       * BELOW ONLY HAPPENS AT NODES.
       *
       * The walk steps 9 to 16 m and asks `roofScan` once per step, so a
       * connector sampled at a coarser spacing than that is checked against the
       * hillside less carefully than every other metre of passage in the world.
       * Splitting anything over fourteen metres puts the connector's own spacing
       * inside the walk's.
       */
      const segs = Math.max(1, Math.ceil(reach / 14));
      for (let g = 1; g < segs; g++) {
        const f = g / segs;
        const nd = shaped(
          x + (pre.x - x) * f,
          y + (pre.y - y) * f,
          z + (pre.z - z) * f,
          Math.min(head.r, rE * 1.2),
          shE
        );
        nd.type = kindE;
        link.push(nd);
      }
      link.push(pre, weld);

      /**
       * THE CONNECTOR IS ROCK LIKE ANY OTHER PASSAGE, and nothing else in this
       * function would have checked it: the walk's own roof clamp ran on the
       * nodes it placed, and these nodes were placed by arithmetic against the
       * target rather than by the walk. A connector that breaks surface is a
       * wedge of daylight in the middle of a mountain.
       *
       * Not the weld ring itself, which is inside the target's bore and has
       * therefore already been buried as part of the target — the same exemption
       * `until` makes in `burySkylights`, for the same reason.
       */
      let roofed = true;
      for (let s = 0; s < link.length - 1 && roofed; s++) {
        const nd = link[s];
        const ux2 = (link[s + 1].x - nd.x) || 1e-3;
        const uz2 = link[s + 1].z - nd.z;
        const ul2 = Math.hypot(ux2, uz2) || 1;
        const room = roofRoom(nd.x, nd.z, ux2 / ul2, uz2 / ul2, nd.r * nd.w);
        if (room - ROOF_ROCK - (nd.y + nd.r * (nd.t + nd.rough)) < 0) roofed = false;
      }
      if (!roofed) {
        _loopWhy.roof++;
        continue;
      }

      /**
       * …AND IT MUST NOT PASS THROUGH ANYTHING ON THE WAY.
       *
       * Same rule and same beads as the walk's own clash test, with the SECOND
       * exemption this file has ever needed: a window around the target ring,
       * mirroring the distance window the walk keeps around the source. The
       * connector is supposed to touch the target — that is the junction — and
       * without the window it would be rejected by the wall it is arriving
       * through, which is the exact failure the source window was written for.
       */
      const half = rE * shE.w;
      /**
       * A BOUNDING SPHERE ROUND THE CONNECTOR FIRST, because this runs inside
       * ONE slice against a 1.8 ms budget.
       *
       * Five sample points against every ring of every target is nine thousand
       * distance tests per candidate and four candidates in a row with no
       * `yield` between them — which is exactly the shape of the hitch the block
       * over `tries` warns about. The connector is a segment; a ring that cannot
       * reach its bounding sphere cannot reach any point on it, so one squared
       * distance per ring throws away all but the handful nearby and the five
       * tests only run on those. It is the same reject `caveSample` gained as
       * `_bpad`, at a smaller scale.
       */
      const mx = (x + weld.x) * 0.5;
      const my = (y + weld.y) * 0.5;
      const mz = (z + weld.z) * 0.5;
      const hl = Math.hypot(weld.x - x, weld.y - y, weld.z - z) * 0.5;
      // The five sample points, solved once. Five triples on the stack rather
      // than an allocation inside a loop that runs inside a build slice.
      const pts = new Float64Array(15);
      for (let s = 1; s <= 5; s++) {
        const f = s / 6;
        pts[(s - 1) * 3] = x + (weld.x - x) * f;
        pts[(s - 1) * 3 + 1] = y + (weld.y - y) * f;
        pts[(s - 1) * 3 + 2] = z + (weld.z - z) * f;
      }
      let hit = false;
      for (let ti = 0; ti < targets.length && !hit; ti++) {
        const q = targets[ti];
        const qn = q.x.length;
        for (let k = 0; k < qn && !hit; k++) {
          if (q === p && Math.abs(k - j) < 16) continue;
          if (avoidRing[ti] >= 0 && Math.abs(k - avoidRing[ti]) < 12) continue;
          const min = q.r[k] * q.w[k] + half + 3;
          const gx = q.x[k] - mx;
          const gy = q.y[k] - my;
          const gz = q.z[k] - mz;
          const gate = hl + min;
          if (gx * gx + gy * gy + gz * gz > gate * gate) continue;
          for (let s = 0; s < 5 && !hit; s++) {
            const dx = q.x[k] - pts[s * 3];
            const dy = q.y[k] - pts[s * 3 + 1];
            const dz = q.z[k] - pts[s * 3 + 2];
            if (dx * dx + dy * dy + dz * dz < min * min) hit = true;
          }
        }
      }
      // …and against the branch's own line, on the beads. Same rule and the same
      // eight-metre along-the-line exemption the walk's own test uses.
      for (let k = 0; k < beads.length && !hit; k++) {
        const bd = beads[k];
        const min = bd.half + half * 1.15 + 3.5;
        if (walked - bd.at < min + 8) continue;
        const gx = bd.x - mx;
        const gy = bd.y - my;
        const gz = bd.z - mz;
        const gate = hl + min;
        if (gx * gx + gy * gy + gz * gz > gate * gate) continue;
        for (let s = 0; s < 5 && !hit; s++) {
          const dx = bd.x - pts[s * 3];
          const dy = bd.y - pts[s * 3 + 1];
          const dz = bd.z - pts[s * 3 + 2];
          if (dx * dx + dy * dy + dz * dz < min * min) hit = true;
        }
      }
      if (hit) {
        _loopWhy.clash++;
        continue;
      }

      for (const nd of link) nodes.push(nd);
      _loopWhy.ok++;
      loop = { path: p, ring: j, side: side2, tSh, pr, lat: lat2, tHalf };
    }
    yield 'branch-loop';
  }

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
  /**
   * …AND NONE OF IT RUNS ON A PASSAGE THAT ENDS SOMEWHERE, which is the whole
   * of the closure's cost saving. `terminusFit` is described in this file as the
   * fattest single computation in the build; a loop skips it, and skips the
   * `closingNode` whose shut section is what makes `truncate` fire.
   */
  const last = nodes[nodes.length - 1];
  if (!loop) {
    const mainNodes = [];
    for (let i = 0; i < n; i++) {
      mainNodes.push({ x: main.x[i], y: main.y[i], z: main.z[i], r: main.r[i], w: main.w[i] });
    }
    // …and the passages this branch is not allowed to touch at all. A terminal
    // chamber is the biggest thing a lead builds and the likeliest to reach one.
    for (const ap of avoid) {
      for (let i = 0; i < ap.x.length; i++) {
        mainNodes.push({ x: ap.x[i], y: ap.y[i], z: ap.z[i], r: ap.r[i], w: ap.w[i] });
      }
    }
    // No depth floor: a branch has never had one, and the dive is bounded anyway
    // by the same MAX_DIVE gradient over the step that the main walk uses.
    yield 'branch';
    const term = yield* terminusFit(rng, x, y, z, heading, joints, mainNodes, -Infinity, last.r * 1.25, beads, walked);
    yield 'branch-terminus';
    if (term) {
      const sh = SHAPES[term.kind];
      const nd = shaped(term.x, term.y, term.z, term.r, sh);
      nd.type = term.kind;
      nodes.push(nd);
      heading = term.heading;
    }
    nodes.push(closingNode(nodes[nodes.length - 1], heading));
  }

  const path = resample(nodes);
  yield 'branch-resample';
  /**
   * From ring 1: ring 0 is welded to the main tube's wall and must not move.
   *
   * …AND, ON A LOOP, TO THE LAST LOOP_COLLAR RINGS FOR THE SAME REASON. If the
   * burial then closed the passage anyway — the hillside is entitled to the
   * whole thing, see below — `truncate` has already domed it and the closure is
   * off. That check is `endRing`: `closeEnd` is the only thing that writes it,
   * so its presence on a path built without a `closingNode` means and can only
   * mean that the rock refused the connector.
   */
  const bn0 = path.x.length;
  yield* burySkylights(path, 1, loop ? Math.max(2, bn0 - LOOP_COLLAR) : Infinity);
  /**
   * A CLOSURE THE ROCK REFUSED IS NOT A DEAD END, IT IS A COLLISION, and this is
   * the one place that difference is dangerous.
   *
   * When the burial cuts a looping passage short, `truncate` keeps `cut +
   * CAP_RINGS` rings and domes them — and `cut` is the first ring a BODY could
   * not pass, which on a connector heading into a bore is routinely within a
   * dome's length of the weld. So the passage can survive almost to the target,
   * be capped there, and have no hole cut in front of it: two tubes sharing a
   * volume, which from inside is a hole in the wall with the back of another
   * wall behind it. It is the exact failure the clash test exists to prevent,
   * arrived at from a direction the clash test deliberately exempted.
   *
   * So the end is walked back until it is clear of the target the way any other
   * passage would have to be, and the dome rebuilt there. Sixteen rings either
   * side of the weld is the same window the connector's own clash test exempted;
   * everything outside it was already tested and is already clear.
   */
  if (loop && path.endRing !== undefined) {
    const tp = loop.path;
    const j = loop.ring;
    const lo = Math.max(0, j - 16);
    const hi = Math.min(tp.x.length - 1, j + 16);
    let keep = path.x.length;
    while (keep > CAP_RINGS + 6) {
      const i = keep - 1;
      let clear = true;
      for (let k = lo; k <= hi && clear; k++) {
        const dx = tp.x[k] - path.x[i];
        const dy = tp.y[k] - path.y[i];
        const dz = tp.z[k] - path.z[i];
        const min = tp.r[k] * tp.w[k] + path.r[i] * path.w[i] + 3;
        if (dx * dx + dy * dy + dz * dz < min * min) clear = false;
      }
      if (clear) break;
      keep--;
    }
    if (keep < path.x.length) truncate(path, Math.max(1, keep - CAP_RINGS));
    loop = null;
  }
  /**
   * …AND IF THE BURIAL TOOK IT, THERE IS NO BRANCH — NOT A TWO-METRE ONE.
   *
   * The `nodes.length < 3` test above runs before the hillside has had its say,
   * and the hillside is entitled to the whole thing: `burySkylights` narrows a
   * branch wherever the rock over it runs thin and `truncate` closes it at the
   * first ring a body could not pass, which on a lead heading for the surface
   * can be ring one. What survives is a two-metre alcove with a junction cut in
   * the wall in front of it — which reads as a way on from ten metres back and
   * as a mistake from two, and is the worst possible use of an opening.
   *
   * Measured: one branch of five on grove-01 k=0 came out 2 m long. It is
   * rejected here rather than clamped longer, because the burial is right —
   * there genuinely is no mountain there.
   */
  {
    const bn = path.x.length;
    const stop = Math.min(path.endRing ?? bn - 1, bn - 1);
    let len = 0;
    for (let i = 1; i <= stop; i++) {
      len += Math.hypot(path.x[i] - path.x[i - 1], path.y[i] - path.y[i - 1], path.z[i] - path.z[i - 1]);
    }
    // Twelve metres is `cave-branch`'s own bar for having entered one: shorter
    // than that and there is nothing on the other side of the doorway.
    if (len < 12) {
      _branchWhy = 'buried';
      return null;
    }
  }
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
  /**
   * 0.82 OF THE BORE, NOT HALF OF IT.
   *
   * "Strictly inside the ring-zero ellipse" is the requirement and one half was
   * never what it meant — it was the first number tried that stopped the rim of
   * black nothing, and it stayed. What it produces is an opening a quarter of
   * the AREA of the passage behind it, so a five-metre side passage is met
   * through a window two and a half metres across: from the main line that does
   * not read as a way on, it reads as a dark patch of wall, which is the other
   * half of "the subsystems I cannot see".
   *
   * The margin the inset actually needs is the 0.4 m of MOUTH_INSET plus what
   * the rock displacement can still take after `_emitRing` has flattened it
   * around the opening — a fifth of the bore covers both on the smallest branch
   * this can produce, and the seam is checked rather than argued: `cave-seal`
   * is the gate that fails the moment an opening shows daylight.
   */
  const BORE = 0.82;
  /**
   * SIZED WHERE THE BRANCH CROSSES THE WALL, NOT AT ITS RING ZERO.
   *
   * The two used to be the same place to within MOUTH_INSET, so reading ring
   * zero's section was reading the section in the plane of the hole. They are
   * not the same place any more: ring zero's axis is now set at the wall a
   * WALKING BODY is held at, which on a rough chamber is a couple of metres
   * inside the wall that is drawn — and the hole is cut in the drawn one. Over
   * those two metres the branch has moved: it is climbing, turning and
   * changing section, and a window sized from where it starts is a window the
   * tube behind it no longer fills.
   *
   * The leak is tiny and it is the whole failure. Two rays in five hundred and
   * seventy-six at one junction and three at another, in `cave-junction` — but
   * the tube is single-sided, so what those rays find is not a dark patch, it
   * is a few pixels of hillside in the middle of a mountain.
   *
   * So the section is read at the ring that actually spans the parent's wall,
   * and the window is centred on THAT ring's axis height too. Bounded to the
   * collar rings, which are the ones `_link` winds both ways and are therefore
   * the only ones solid enough to plug a hole from either side.
   */
  const wallRun = Math.max(0, bestHalf - lat);
  const hr = Math.min(3, path.x.length - 1, Math.round(wallRun / RING_STEP));
  const rw = path.r[hr];
  const halfV = rw * Math.min(path.t[hr], path.f[hr]) * BORE;
  const halfH = rw * path.w[hr] * BORE;
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
   *
   * …AND IT IS NO LONGER CENTRED ON THE AXIS, BECAUSE THE MOUTH IS NOT.
   *
   * The arcsine above is `phiAtHeight` with the flat floor and the keyhole slot
   * left out, written when a branch always left at phi 0. Now that the mouth is
   * placed at the height a body walks, the hole has to be cut where the mouth
   * IS: solved on the outline at the branch's own axis height, and again at the
   * top and bottom of its bore, so the window is the bore's own footprint on
   * the wall rather than a band around the equator.
   *
   * THE SPAN IS THE SMALLER OF THE TWO HALVES and that is what keeps the floor
   * intact. The hole is symmetric in phi, the outline is not — near the floor a
   * centimetre of height is a great many degrees of phi — so taking the upward
   * half bounds the downward one to the same vertical reach. Since `halfV` is
   * 0.82 of the bore's own half-depth, the bottom lip of every window stays
   * clear of the branch's floor, and a hole that reached past it would be a hole
   * in the floor of the main passage with the dark under the world behind it.
   */
  const mouthPhi = phiAtHeight((path.y[hr] - main.y[bi]) / r0, mSh);
  const upPhi = phiAtHeight((path.y[hr] + halfV - main.y[bi]) / r0, mSh);
  const downPhi = phiAtHeight((path.y[hr] - halfV - main.y[bi]) / r0, mSh);
  path.holePhi = side > 0 ? mouthPhi : Math.PI - mouthPhi;
  path.holeSpan = clamp(Math.min(upPhi - mouthPhi, mouthPhi - downPhi), 0.1, 0.85);
  /**
   * FRACTIONAL, BECAUSE ROUNDING TO WHOLE RINGS IS A METRE AND A HALF OF SLOP.
   *
   * Nothing needs this to be an integer: both readers — the quad skip in `_link`
   * and the displacement flatten in `_emitRing` — divide by it and compare
   * against 1, so a float is the same arithmetic with the quantisation removed.
   * `Math.floor` was throwing away up to a whole ring step, and since a ring
   * step is 0.72 m and a branch's half-width is 1.4-2.6 m it was almost always
   * flooring to exactly 1 — which is how every junction in the world came out
   * the same 1.44 m across whatever was behind it, measured over five branches
   * on grove-01 k=0 whose bores ran from 2.9 m to 5.2 m.
   */
  path.holeRings = Math.max(0.8, halfH / RING_STEP);
  /**
   * …AND THE SNOUT IS FLARED AFTERWARDS, WHICH IS WHAT ACTUALLY SEALS IT.
   *
   * The window is cut as an ellipse in (ring, phi) and the bore that has to
   * cover it is a circle in SPACE, on a wall that curves away in both. Those
   * two are the same shape only near the middle of the window; out at the
   * corners the phi-to-height mapping is nonlinear enough that the window
   * reaches a little past the tube behind it, and what shows through the sliver
   * is not a dark patch — the tube is single-sided, so it is a few pixels of
   * hillside seen from inside a mountain.
   *
   * It is small and it is old: `cave-junction`'s ray gate finds it at one
   * junction in eighteen on the code this replaced, at a hole HALF this size,
   * which is what rules out the size as the cause. Shrinking the window is
   * therefore the wrong lever twice over — it does not address the shape and it
   * spends the doorway, which is the thing the room asked for.
   *
   * So the snout is made bigger than the window instead. `w` and `t` only, and
   * never `f`: the floor is `y - r * f` and the branch's floor is welded to the
   * parent's, so scaling anything that moves it would put a step back in the
   * threshold. Tapered out over the collar rings — the same three `_link` winds
   * both ways — so it is a rim you can see the thickness of rather than a lip
   * that appears from nowhere.
   */
  const FLARE = 0.16;
  for (let i = 0; i < Math.min(3, path.x.length); i++) {
    const k = 1 + FLARE * (1 - i / 3);
    path.w[i] *= k;
    path.t[i] *= k;
  }

  /**
   * AND THE SECOND WELD, WHICH IS THE FIRST ONE READ BACKWARDS.
   *
   * Every line below has a counterpart forty lines up: the ring that spans the
   * target's wall is counted back from the END rather than forward from ring
   * zero, the window's phi is solved on the target's outline at the weld ring's
   * own axis height, and the collar is flared over the LAST three rings rather
   * than the first. `_link` winds those same three both ways, `_emitRing`
   * flattens the target's displacement around the opening from `_holesBy`, and
   * neither of them has to know which end of which passage it is looking at.
   *
   * `endRing` is set by hand and NOT by `closeEnd`: there is no dome, the last
   * ring is a full-size section standing inside the target's bore, and it is the
   * last place a body may be — which is what `endRing` means. `loopEnd` then
   * tells `caveSample` not to apply its axial end stop there, because there is
   * no end to stop at; walking on takes you into the target passage, which wins
   * the fit the moment you are inside its section.
   */
  if (loop) {
    const bn = path.x.length;
    path.endRing = bn - 1;
    path.loopEnd = true;
    path.loopRing = loop.ring;
    path.loopTo = loop.path;
    path.loopSide = loop.side;
    const wallRun2 = Math.max(0, loop.tHalf - loop.lat);
    const hr2 = bn - 1 - Math.min(3, bn - 1, Math.round(wallRun2 / RING_STEP));
    const rw2 = path.r[hr2];
    const halfV2 = rw2 * Math.min(path.t[hr2], path.f[hr2]) * BORE;
    const halfH2 = rw2 * path.w[hr2] * BORE;
    const pY = loop.path.y[loop.ring];
    const mPhi = phiAtHeight((path.y[hr2] - pY) / loop.pr, loop.tSh);
    const uPhi = phiAtHeight((path.y[hr2] + halfV2 - pY) / loop.pr, loop.tSh);
    const dPhi = phiAtHeight((path.y[hr2] - halfV2 - pY) / loop.pr, loop.tSh);
    path.loopPhi = loop.side > 0 ? mPhi : Math.PI - mPhi;
    path.loopSpan = clamp(Math.min(uPhi - mPhi, mPhi - dPhi), 0.1, 0.85);
    path.loopRings = Math.max(0.8, halfH2 / RING_STEP);
    /**
     * AND THE FLOOR IS RE-SOLVED LAST, BECAUSE TWO PASSES HAVE BEEN OVER IT.
     *
     * `weld.f` was solved as a NODE so that the weld's floor lands exactly on
     * the target's, and then `resample` ran `flatten` over the whole path with
     * no `from` at all — which rewrites `f` wherever the half-width is over
     * 4.5 m, and a weld bore is routinely 5. So the guarantee the node made was
     * quietly unmade before this line, exactly as the block over `flatten`
     * describes happening to the burial.
     *
     * `f` is the only channel that moves the floor without moving the axis, so
     * re-solving it here costs nothing else: the ceiling is `y + r * (t +
     * rough)` and the containment is `r * w`, and neither reads `f`. Over the
     * collar rings only — a step at a threshold is what makes a doorway read as
     * a wall, and the collar is where the two floors have to agree.
     */
    const tFloor =
      loop.path.y[loop.ring] - loop.path.r[loop.ring] * loop.path.f[loop.ring];
    for (let i = Math.max(0, bn - 3); i < bn; i++) {
      path.f[i] = clamp((path.y[i] - tFloor) / path.r[i], 0.08, path.t[i] * 0.95);
    }
    for (let i = 0; i < Math.min(3, bn); i++) {
      const k = 1 + FLARE * (1 - i / 3);
      path.w[bn - 1 - i] *= k;
      path.t[bn - 1 - i] *= k;
    }
  }
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
    /**
     * …AND THEN THE FLOOR IS MADE WIDE ENOUGH TO WALK ALONG, WHICH IS A
     * DIFFERENT QUESTION FROM WHETHER THE PASSAGE IS.
     *
     * This measured `halfWidthAt(-f * 0.35)` — a third of the way down from the
     * axis to the floor, i.e. somewhere around the hip — and called it "the
     * narrowest part". In every section without a slot that is close enough to
     * true. In a KEYHOLE it is out by a factor of four, and the keyhole is the
     * one shape the guard was written for.
     *
     * Measured on grove-01 by walking sideways from the centre line asking
     * `caveSample`, which is the answer the feet get, per section kind:
     *
     *                floor width (m) before the ground climbs
     *                ankle   shin   knee   | passage width at the chest
     *     tube          7.1    7.8    8.4  |  7.5
     *     canyon        2.9    3.2    3.7  |  2.6
     *     bedding       9.4   11.2   14.5  | 12.9
     *     room         11.0   14.6   15.9  | 21.6
     *     keyhole       1.65   1.9    2.3  |  6.1
     *
     * Every other shape has a floor about as wide as the space over it. A
     * keyhole is four times wider at your chest than at your feet, so what you
     * are walking in is a gutter with a hall over it: step half a metre sideways
     * and the ground comes up to your knee, and the camera rides up and down
     * with it. The player's word for it was a groove, and the report was about
     * how it FEELS to walk, which is exactly what a guard sampling at hip height
     * cannot see. 15-16% of the rings in a cave are keyholes.
     *
     * So the sample moves to the floor, and there are now two guarantees rather
     * than one, because they want to be given back in different currencies:
     *
     *   MIN_HALF, by widening `w`. "Does the body fit through at all." A section
     *   whose FLOOR is narrower than this is one the player cannot walk down
     *   whatever the bore is doing, and the old sample height could not see that
     *   either. Unchanged in value, and it barely fires now that it is honest.
     *
     *   FLOOR_HALF, by easing `key`. "Is this a floor or a rut." Widening `w` is
     *   the wrong currency for a slot: the squeeze is a FRACTION of the bore, so
     *   scaling `w` to fix the floor scales the ceiling by the same factor, and a
     *   keyhole wide enough to walk in would be sixteen metres across at the
     *   waist. `key` is the dedicated dial for the slot alone, `section`,
     *   `halfWidthAt` and `floorAt` all read it, so the mesh and the collider
     *   cannot end up disagreeing about the fix.
     *
     * IT IS SELF-LIMITING, WHICH IS THE PROPERTY THAT MAKES IT SAFE. The slot is
     * only eased as far as the metres demand, so a keyhole cut at 4 m of radius
     * keeps about four fifths of its slot and one cut at 2.9 m keeps about half.
     * The shape survives where there is room for it and gives way where the
     * choice is between a slot and a walkable cave. Nothing that has no slot is
     * touched at all: `key` is zero everywhere but a keyhole.
     */
    const sh = ringShape(path, i, _shapeA);
    const floorY = -path.f[i];
    const squeeze = slotSqueeze(floorY, 1);
    if (sh.key > 0 && squeeze < 1) {
      // The bore's own half-width down at the floor, before the slot pinches it.
      _shapeB.w = sh.w;
      _shapeB.t = sh.t;
      _shapeB.f = sh.f;
      _shapeB.key = 0;
      const bore = path.r[i] * halfWidthAt(floorY, _shapeB);
      if (bore > FLOOR_HALF) {
        // floorHalf = bore * (1 - key * (1 - squeeze)); solve for the key that
        // lands exactly on FLOOR_HALF, and never raise the one the table asked
        // for — this may only open a slot, never close one.
        const room = (1 - FLOOR_HALF / bore) / (1 - squeeze);
        if (room < sh.key) sh.key = path.key[i] = room;
      } else {
        // The bore itself is too narrow for the slot to be the problem. Take the
        // slot out entirely and let MIN_HALF below widen the section.
        sh.key = path.key[i] = 0;
      }
    }
    const halfLow = path.r[i] * halfWidthAt(floorY, sh);
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
function flatten(path, from = 0, to = Infinity) {
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
     * own half-width. A chamber levelled over less than its own width comes out
     * as a shallow dish with the axis's meander still in it — the "rolling
     * bottom no collapse ever made" this function exists to delete, at the one
     * scale where it is unmissable.
     *
     * THE CAP WAS 22 m AND IT WAS JUSTIFIED AS "over the widest the rock has
     * ever granted", WHICH IS A FACT ABOUT THE ROCK AND NOT ABOUT THIS
     * FUNCTION. The rock grants more now — `roofScan` asks it properly and a
     * hall reaches 36 m of half-width against the 25 it used to — so the same
     * number silently became a cap that BINDS on exactly the spaces the whole
     * function exists for. What that presents as is not a wobbly floor: it is
     * hovering, because `caveSample` answers the floor from one ring while the
     * drawn floor at a point is the lowest of the dozen sections that reach it,
     * and the gap between those two is the meander the levelling was supposed to
     * have removed. Measured on grove-01 with the cap at 22: 428 probes
     * disagreeing by over 0.45 m against 203 before the chambers grew.
     *
     * 45 m is over the widest section this table can now produce, which puts the
     * cap back where it was meant to be — a backstop against a runaway radius
     * rather than a limit on a real one. It costs nothing anywhere else: every
     * ordinary passage is far under it and takes its own half-width as before.
     */
    const win = Math.round(Math.min(45, path.r[i] * path.w[i] * 0.9) / RING_STEP);
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
   *
   * `to` is the same protection at the far end, for a loop's second weld, whose
   * `f` was solved so its floor IS the target passage's floor. See `until` in
   * `burySkylights`.
   */
  const stop = Math.min(n, to);
  for (let i = from; i < stop; i++) {
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
 *
 * FROM ANY RING, IN EITHER DIRECTION, BECAUSE A PASSAGE NOW HAS TWO ENDS.
 *
 * This was written when the only opening in the world was the main tube's ring
 * zero, so "the entrance" and "index 0, walking up" were the same statement and
 * the function said the second one. A looping branch (see LOOP CLOSURE) is
 * welded into another passage's wall at BOTH ends, and the question its far end
 * asks is the same question in the other direction: how far back from that weld
 * can you still see it. Same algorithm, same 0.62, same 14 m of margin — the
 * only change is that the ring being walked away from and the sense of the walk
 * are arguments rather than constants.
 *
 * The return is metres of `along` FROM `from`, so it is a distance travelled
 * rather than a position, and it means the same thing at either end.
 */
function blindAlong(path, along, from = 0, dir = 1) {
  const n = path.x.length;
  const x0 = path.x[from];
  const y0 = path.y[from];
  const z0 = path.z[from];
  for (let s = 3; s < n; s++) {
    const i = from + dir * s;
    if (i < 0 || i >= n) break;
    const dx = path.x[i] - x0;
    const dy = path.y[i] - y0;
    const dz = path.z[i] - z0;
    const len2 = dx * dx + dy * dy + dz * dz;
    if (len2 < 1e-6) continue;
    for (let k = 1; k < s; k++) {
      const j = from + dir * k;
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
      if (ox * ox + oy * oy + oz * oz > fit * fit) {
        return Math.abs(along[i] - along[from]) + 14;
      }
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
 * …and the inverse: which angle on the outline is at a given height.
 *
 * `buildBranch` needs it to say where in the main tube's lattice a junction
 * belongs. The hole is cut in (ring, phi), the mouth is placed at a HEIGHT, and
 * the two are only the same question at the axis — which is exactly the
 * assumption that put every branch in the ceiling flare.
 *
 * Bisected rather than solved because `section` clamps the ellipse flat at `-f`
 * and squeezes a keyhole's slot, so it has no inverse in closed form. It is
 * monotonic over the half turn from the floor to the roof, which is all a
 * bisection needs, and it runs a handful of times per cave at build time.
 */
function phiAtHeight(ny, sh) {
  const target = clamp(ny, -sh.f + 1e-3, sh.t - 1e-3);
  let lo = -Math.PI * 0.5;
  let hi = Math.PI * 0.5;
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) * 0.5;
    if (section(mid, sh, _sectTmp).y < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
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
 * A BREAKDOWN SLAB, SOLVED ONCE AND PACKED, SO THE MESH AND THE BODY CANNOT
 * DISAGREE ABOUT IT.
 *
 * There used to be two numbers here — BLOCK_REACH 0.5 and BLOCK_RISE 0.8 — that
 * described a DOME the collider raised over `(b.x, b.z, b.rad, b.top)`, and a
 * long comment in `caveSample` explaining that the dome was a fitted compromise
 * because the drawn height is not a function of those four numbers. It is not,
 * and it never was: `_emitBlock` throws each of the seven base corners to
 * `rad * 0.26..1.5`, puts a SEPARATE top polygon on top (`shrink` 0.28-0.72,
 * shoved sideways by up to half the radius, each corner with its own break), and
 * leans the whole solid by up to 0.7 m per metre. Measured against the drawn
 * geometry, past 0.4 of the nominal radius the MEDIAN block is simply gone. A
 * dome fitted to that is fitted to a bimodal distribution, and the whole Pareto
 * front of 243 of them traded hovering for wading at a fixed total: the best any
 * of them managed was 79 bad stands out of 278, and the shipped one left the
 * body up to 1.18 m in the air over a boulder it could see under its feet.
 *
 * So the shape is solved ONCE, here, in `prepare`, and both consumers read the
 * same numbers out of the same buffer. `_emitBlock` no longer runs the rng at
 * all — it draws the polygon this function packed — and `blockTopAt` below
 * evaluates the exact triangles that polygon becomes. The disagreement between
 * the collider and the mesh is now zero by construction rather than fitted, and
 * there is no constant left in this file that has to be re-fitted the day the
 * jitter changes.
 *
 * WHAT IT COSTS IN MEMORY, because that is the reason to think twice about
 * putting a polygon on a per-block record. Forty floats a block: the base ring's
 * seven (x, z), the top ring's seven (x, z, y), the top polygon's own centre and
 * height, the buried base plane, and a plan-radius for the reject. 160 bytes a
 * block, ~300 blocks in a big cave, so 48 kB per cave — held as ONE Float32Array
 * per passage rather than one per block, because 300 typed-array headers cost
 * more than the floats in them.
 *
 * The rng draw ORDER below is load-bearing and matches the one `_emitBlock` used
 * to run inline, draw for draw: lean angle, lean strength, shrink, skewX, skewZ,
 * then per corner angle, radius, shrink, own break. Change the order and every
 * boulder in the world moves.
 */
/**
 * THE RISE THE BODY CAN TAKE, AND ITS EYE, MIRRORED FROM `controller.js`.
 *
 * `STEP_UP` and `EYE` live over there and are not exported; they are 0.55 and
 * 1.68. They are needed here because the moment the collider started answering
 * with the DRAWN slab instead of a dome, a breakdown block stopped being a ramp
 * and became what it looks like: a thing with a near-vertical fracture face on
 * at least one side. The step rule then correctly refuses to climb it — and
 * refusing is all it does, so a body walking head-on into a boulder stopped
 * dead. `cave-walk` caught it immediately: k=1 stuck at 2.2 m against a 1.07 m
 * slab seated 1.07 m off the axis of a ten-metre passage, for forty seconds,
 * with room to walk round it on both sides.
 *
 * So a slab too tall to step onto is published as a POST, which is the
 * machinery this file already has for a column and which `controller.js`
 * applies as a displacement push — you slide round it exactly as you slide
 * round a trunk. Two numbers duplicated across a module boundary is a real
 * cost; the alternative was for the collider to keep lying about the shape of
 * every boulder in the world so that one rule in another file could stay
 * ignorant of it, which is the trade that produced the hover in the first
 * place. If either constant moves over there, this is what has to follow.
 */
const BLOCK_STEP = 0.55;
const BODY_EYE = 1.68;

const BLOCK_STRIDE = 5 + BLOCK_SIDES * 5;
const B_YBOT = 0;
const B_CTOP = 1;
const B_CTX = 2;
const B_CTZ = 3;
const B_REACH = 4;
const B_BX = 5;
const B_BZ = 5 + BLOCK_SIDES;
const B_TX = 5 + BLOCK_SIDES * 2;
const B_TZ = 5 + BLOCK_SIDES * 3;
const B_TY = 5 + BLOCK_SIDES * 4;

function blockSolid(k, bl, buf, si) {
  const rng = makeRng(`${getWorldSeed()}:cave-block:${k}:${bl.seed}`);
  /**
   * The base goes further under the floor than the block stands above it, so it
   * is never on screen. A slab resting exactly on the analytic floor shows a
   * seam all the way round wherever the visible floor's own displacement dips
   * under it — which is everywhere, because the floor carries its own rock
   * noise — and that is the whole "the boulders are hovering" class of
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
   * Radii from half to just over one, angles jittered by a fifth of a step, and
   * a top plane with a tenth of the block's height of relief on it. Every one of
   * those is a reasonable-sounding number and together they describe a squat
   * cylinder with a lid — which the eye files under "box" just as fast as an
   * actual box, because at this scale what it is reading is "no corner is much
   * different from any other corner".
   *
   * A quarter to one and a half on the radius, half a step on the angle, and a
   * per-corner height drawn independently of the tilt plane. The point is that
   * the corners must DISAGREE: one that sticks a long way out next to one that
   * barely does is what a fracture looks like, and a flat top is the single most
   * box-like feature a solid can have.
   *
   * AND THE TOP IS A DIFFERENT POLYGON FROM THE BOTTOM, WHICH IS THE ONE THAT
   * FINALLY KILLED THE BOX. A prism has vertical sides. Ragged them all you like
   * and every side face is still parallel to every other side face's own
   * vertical, so the silhouette is a vertical-walled lump with a jagged hat on it
   * and the eye still says box. Verticality WAS the tell, not regularity. So the
   * top ring is drawn separately: smaller by a large and random factor, shoved
   * sideways by up to half the radius, and with its own per-corner scatter. Now
   * no two side faces share a slope, none of them is vertical, and the thing has
   * an overhang on one side and a ramp on the other — which is what a lump of
   * fractured limestone lying in silt actually looks like.
   */
  const shrink = rngRange(rng, 0.28, 0.72);
  const skewX = rngRange(rng, -0.5, 0.5) * bl.rad;
  const skewZ = rngRange(rng, -0.5, 0.5) * bl.rad;
  /** The tilted top, plus this corner's own break. */
  const topAt = (px, pz, own) =>
    yTop +
    (px - bl.x) * tiltX +
    (pz - bl.z) * tiltZ +
    own +
    rock(px * 1.6, yTop, pz * 1.6) * bl.top * 0.2;

  let reach = 0;
  let wall = 0;
  for (let i = 0; i < BLOCK_SIDES; i++) {
    const a = bl.rot + (i / BLOCK_SIDES) * TAU + rngRange(rng, -0.5, 0.5);
    const rr = bl.rad * rngRange(rng, 0.26, 1.5);
    const bx = bl.x + Math.cos(a) * rr;
    const bz = bl.z + Math.sin(a) * rr;
    const s = shrink * rngRange(rng, 0.55, 1.4);
    // Each corner's own height, on top of the tilt. A third of the block.
    const own = rngRange(rng, -0.34, 0.16) * bl.top;
    const tx = bl.x + (bx - bl.x) * s + skewX;
    const tz = bl.z + (bz - bl.z) * s + skewZ;
    buf[si + B_BX + i] = bx;
    buf[si + B_BZ + i] = bz;
    buf[si + B_TX + i] = tx;
    buf[si + B_TZ + i] = tz;
    buf[si + B_TY + i] = topAt(tx, tz, own);
    /**
     * The reject radius is the widest CORNER, not `bl.rad`. It is up to 1.5x
     * bigger, so the collider now looks at blocks it used to skip — which is the
     * point: those columns are where the drawn rock is and the body was walking
     * through it. Taking the max over both rings rather than the base alone
     * because the skew can push a top corner outside every base corner.
     */
    const db = Math.hypot(bx - bl.x, bz - bl.z);
    const dt = Math.hypot(tx - bl.x, tz - bl.z);
    if (db > reach) reach = db;
    if (dt > reach) reach = dt;
    /**
     * …AND THE PLAN RADIUS OF THE PART THAT IS A WALL, which is a different
     * question from `reach` and is the one the go-round push needs.
     *
     * `reach` is the whole solid including the fracture faces, which RAMP from
     * below the silt up to the lid and are climbable over most of their run.
     * The part the body cannot get onto is the LID — a body at the lid's edge
     * has the whole of the block's height in front of it — so the wall radius is
     * how far the lid reaches, and only from corners that actually stand more
     * than a step above the slab's foot. A slab under half a metre tall has no
     * wall radius at all and is walked over, which is what most of them are.
     *
     * A circle, where the floor answer is exact, and the asymmetry is
     * deliberate. The floor is what puts the body in mid-air when it is wrong,
     * so it is solved. The push only decides which way you go round something
     * you can see; a circle over the lid is conservative in the safe direction
     * (you brush past a corner slightly wider than it looks) and it costs one
     * float instead of a per-frame outward search along the bearing.
     */
    if (buf[si + B_TY + i] > bl.y + BLOCK_STEP && dt > wall) wall = dt;
  }
  buf[si + B_YBOT] = yBot;
  buf[si + B_CTOP] = topAt(bl.x + skewX, bl.z + skewZ, 0);
  buf[si + B_CTX] = bl.x + skewX;
  buf[si + B_CTZ] = bl.z + skewZ;
  buf[si + B_REACH] = reach;
  bl.reach = reach;
  bl.wall = wall;
}

/**
 * Height of a triangle over a column, or -Infinity if the column misses it.
 *
 * -Infinity and not null on purpose: this is called up to 21 times per block per
 * `caveSample` and a function that returns "number or null" is not monomorphic,
 * which in a hot loop costs more than the arithmetic it is guarding.
 */
function triY(ax, az, ay, bx, bz, by, cx, cz, cy, px, pz) {
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (d > -1e-9 && d < 1e-9) return -Infinity;
  const w0 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / d;
  if (w0 < 0 || w0 > 1) return -Infinity;
  const w1 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / d;
  if (w1 < 0 || w1 > 1) return -Infinity;
  const w2 = 1 - w0 - w1;
  if (w2 < 0) return -Infinity;
  return w0 * ay + w1 * by + w2 * cy;
}

/**
 * The top of the drawn slab over a column, evaluated on the same triangles the
 * mesh is made of. -Infinity if the column misses the solid entirely.
 *
 * THE TOP FAN FIRST, AND A HIT THERE RETURNS. The lid is emitted as seven wedges
 * fanned from the top polygon's centre, so a column inside it is on the upper
 * surface of the solid by definition and no side face can be above it. That is
 * the case the body is in whenever it is standing ON a block, and it costs four
 * triangle tests on average rather than twenty-one.
 *
 * THE SIDES ARE NOT OPTIONAL, which was the surprise. The top polygon is 28-72%
 * of the base and shoved sideways, so most of the slab's PLAN is side face: a
 * sloping fracture panel running from the buried base ring up to the lid. On the
 * skewed side that panel is an overhang the body should walk under, and on the
 * other it is a ramp the body should walk up, and the old dome answered "flat
 * top" to both. Split the same way `_face` splits a quad — (A,B,C) then (A,C,D)
 * — because a quad with four corners at four heights is not planar and the two
 * triangulations differ by up to the block's whole height along the diagonal.
 *
 * The `max` over the side triangles rather than a first hit: the plan angles are
 * jittered by half a step against a step of TAU/7, so consecutive corners can
 * cross and the polygon is not guaranteed convex. Taking the highest hit is what
 * the mesh's own depth test does anyway.
 */
function blockTopAt(buf, si, px, pz) {
  const ctx = buf[si + B_CTX];
  const ctz = buf[si + B_CTZ];
  const ctop = buf[si + B_CTOP];
  for (let i = 0; i < BLOCK_SIDES; i++) {
    const j = i + 1 === BLOCK_SIDES ? 0 : i + 1;
    const y = triY(
      ctx, ctz, ctop,
      buf[si + B_TX + i], buf[si + B_TZ + i], buf[si + B_TY + i],
      buf[si + B_TX + j], buf[si + B_TZ + j], buf[si + B_TY + j],
      px, pz
    );
    if (y > -Infinity) return y;
  }
  const yBot = buf[si + B_YBOT];
  let best = -Infinity;
  for (let i = 0; i < BLOCK_SIDES; i++) {
    const j = i + 1 === BLOCK_SIDES ? 0 : i + 1;
    const abx = buf[si + B_BX + i];
    const abz = buf[si + B_BZ + i];
    const bbx = buf[si + B_BX + j];
    const bbz = buf[si + B_BZ + j];
    const atx = buf[si + B_TX + i];
    const atz = buf[si + B_TZ + i];
    const aty = buf[si + B_TY + i];
    const btx = buf[si + B_TX + j];
    const btz = buf[si + B_TZ + j];
    const bty = buf[si + B_TY + j];
    let y = triY(abx, abz, yBot, bbx, bbz, yBot, btx, btz, bty, px, pz);
    if (y > best) best = y;
    y = triY(abx, abz, yBot, btx, btz, bty, atx, atz, aty, px, pz);
    if (y > best) best = y;
  }
  return best;
}

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

    /**
     * DEPTH FINALLY BUYS SOMETHING. See CHANNELS: `deep` is 0 at the mouth and 1
     * at DEEP_FULL below it, and until this it was splined and clamped and read
     * by nothing at all.
     *
     * THE DEEP END IS MORE LIT AND MORE COLOURED, NOT LESS, which is the
     * opposite of the instinct. The instinct says darkness should increase with
     * depth; a real cave says the opposite, because everything that lives down
     * here lives where the water and the air come from, and because a
     * player who is rewarded with LESS as they go further in stops going further
     * in. The darkness that matters is the darkness BETWEEN clusters, and that
     * is bought back below by the spacing rather than by dimming the sources.
     *
     * Note that this deliberately shifts the ROSTER too, not just the amount:
     * FUNGUS_ODD (the rare one) doubles its share by the terminus, so the deep
     * end is a different palette rather than more of the same one.
     */
    const deep = path.deep ? path.deep[i] : 0;
    const pick = rng() * (1 - deep * 0.22);
    const colour = (pick < 0.6 ? FUNGUS_COLD : pick < 0.86 ? FUNGUS_DEEP : FUNGUS_ODD).clone();
    out.push({
      x: px,
      y: py,
      z: pz,
      colour,
      power: rngRange(rng, 0.55, 1.25) * (0.92 + deep * 0.3),
      /**
       * Up to five more heads on a cluster at the terminus, against a base mean
       * of eight. Heads are POINTS in the shared sprite cloud — one vertex, no
       * triangle, no draw — so this side of the trade is very nearly free; what
       * is not free is the number of CLUSTERS, because every one of them is an
       * entry in the light list that `_shade` walks per vertex. That is why the
       * count goes up and the spacing goes up with it. See below.
       */
      count: 4 + Math.floor(rng() * 9) + Math.floor(deep * 5),
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
    /**
     * …AND THE SPACING IS WHERE THE DEPTH IS PAID FOR, SO THE BUILD DOES NOT
     * GET MORE EXPENSIVE.
     *
     * A cluster is an entry in `this.lights`, and `_shade` walks that list once
     * per vertex over 30-120 000 vertices: cluster count is the single biggest
     * term in the build cost of a cave. So the extra heads above are paid for by
     * spreading the clusters out — 1.45x the stride at the mouth falling to
     * 0.85x at the terminus. At the mean depth of an ordinary walk the factor is
     * about 1.15, i.e. thirteen per cent FEWER clusters than before, against
     * heads per cluster up by about a quarter. Net: a cave that is somewhat
     * cheaper to build than it was, with the same number of glowing points in
     * it, arranged so the shallow galleries are sparse and the deep ones are
     * crowded.
     *
     * The stretch of dark between clusters that the block above worries about is
     * therefore LONGER near the mouth — which is right, because near the mouth
     * the daylight term is the light in the room and the fungi are not supposed
     * to have started yet.
     */
    i += Math.round((10 + Math.floor(rng() * 12)) * (1.45 - 0.6 * deep));
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
/**
 * How many rings past the level run the shore is allowed to be looked for.
 *
 * See the block in `placeWater` that uses it. Rings are RING_STEP-ish apart
 * AFTER resampling — measured at 0.23-0.94 m through the terminal chamber of
 * grove-01 k=0, so forty rings is twenty to thirty metres of bank, which is
 * more than any chamber in SHAPES is long. It is a stop, not a target: the
 * height test is what normally ends the walk, and on the reference cave it ends
 * it after seventeen.
 */
const POOL_REACH = 40;

/**
 * How deep a stream is over the lowest rock in its section, in metres.
 *
 * THIS IS A WIDTH CONTROL AND NOT A DEPTH. Nothing in the game can be in water
 * this shallow in any way it would notice — the body walks the analytic floor
 * underneath — so what the number actually decides is how far up the bank the
 * surface reaches before the ground wins, and therefore how wide the water is.
 * It is set against the floor's own relief rather than against a taste: the
 * drawn floor carries `r * ROUGH_FLOOR` of displacement, which is 11 cm on a
 * squeeze and 22 on a four-metre passage, so 0.16 puts the shoreline out where
 * the section itself starts to curve up on a narrow ring and inside the
 * displacement's own hollows on a wide one. Bigger and it floods a room; much
 * smaller and it is a wet line rather than a stream.
 */
const STREAM_DEEP = 0.16;
/**
 * Samples either side of the axis when looking for the hollow the water is in.
 *
 * Nine across the section. The floor's finest displacement octave is about
 * 0.8 m of wavelength (see `rock`), and nine samples across an ordinary
 * four-metre passage is 0.6 m apart — just inside it, which is what a scan
 * looking for a local minimum needs. Finer buys a meander the mesh cannot draw,
 * because the floor is only RADIAL vertices around.
 */
const STREAM_SCAN = 4;

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
      /**
       * CHUNKED, FOR THE REASON THE LAKE IS — see the block below its own
       * `runs.push`. `_emitExtra` emits one object per call and `step` yields
       * between them, so a run is atomic however long it is. That was free while
       * a stream was a constant-width strip: two multiplications a ring. It is
       * not free now that each ring scans its section for the hollow the water
       * lies in, which is twenty-five `floorY` solves — a sixty-six ring run is
       * sixteen hundred of them in one uninterruptible slice, against a 1.8 ms
       * budget the lake had already run into.
       *
       * Ten rings a chunk, overlapping by one so the strips join on a shared
       * edge rather than meeting at one.
       */
      const CHUNK = 10;
      for (let a = i; a < i1; a += CHUNK) {
        const b = Math.min(i1, a + CHUNK + 1);
        runs.push({ i0: a, i1: b });
        if (b >= i1) break;
      }
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
       * AND THEN KEEP WALKING, PAST THE LEVEL RUN, UNTIL THE FLOOR IS OUT OF THE
       * WATER — BECAUSE A LAKE'S SHALLOW END IS A SHORELINE TOO.
       *
       * This replaces a `clamp01((j - j0) / 5)` taper that multiplied the solved
       * half-width, and that taper was the single most visible thing wrong with
       * the pool. The sides of a lake are solved: `_emitWater` bisects for the
       * offset at which the rock rises through the surface, so they wander with
       * the displacement and look like a shore. The shallow end was not solved at
       * all — it was a width scaled from 0 to 1 over five rings while `poolY` was
       * by construction ABOVE every floor in the run, so the water could not
       * close on its own and the taper drew the only shape it can: a triangular
       * wedge, thirty metres across, with two dead-straight sides. Measured on
       * grove-01 k=0 that wedge is the whole upstream half of the pool — the run
       * was rings 895-906, 5.1 m of passage in a chamber 34 m wide.
       *
       * The fix is not a softer taper, it is not having one. `poolY` is already
       * solved over the LEVEL part of the run above; walking further back from
       * `j0` now costs nothing but a few more rings of geometry, and every one of
       * them is a ring whose floor is climbing THROUGH the surface — which is
       * exactly the condition the side bisection already handles. The shore
       * closes itself, from both sides at once, along the rock.
       *
       * The extension stops on whichever comes first:
       *   - the axis floor clears the surface by a good margin (the passage has
       *     definitively left the water), or
       *   - POOL_REACH rings, so a cave whose terminal chamber runs gently uphill
       *     for eighty metres does not flood all of it, and
       *   - the section narrowing below POOL_MIN_HALF, the same test as above,
       *     so the lake still cannot climb the passage that feeds the chamber.
       *
       * Measured on grove-01 k=0: 895 becomes 878, 5.1 m becomes 12.4 m, and the
       * straight edge is gone because there is no longer an edge that is drawn
       * rather than found.
       */
      const deep0 = j0;
      let jS = j0;
      while (jS > 1 && j0 - jS < POOL_REACH) {
        const k = jS - 1;
        if (path.r[k] * path.w[k] < POOL_MIN_HALF) break;
        const sh = ringShape(path, k, _shapeB);
        // The axis is the lowest point of the section, so an axis this far clear
        // of the surface means the whole ring is dry and every one behind it is
        // drier still — the walk is climbing away from the water by construction.
        if (floorY(c.k, path, k, sh, 0, path.x[k], path.z[k]) > poolY + 0.9) break;
        jS = k;
      }
      j0 = jS;
      for (let j = j0; j <= endR; j++) {
        /**
         * NOT tapered at either end now. The far end is the wall of the chamber
         * and the near end is the shore; fading the water out before it reaches
         * either is the one thing that would make it read as a decal.
         *
         * `wet` is what `_emitRing` reads for the floor's damp darkening and what
         * `_shade` gets as `damp`, so a flat 1 over the run is also what puts wet
         * rock on the bank — see the WET ROCK block in `_shade`.
         */
        path.wet[j] = 1;
        /**
         * `pool` IS NOT `wet` HERE, AND IT IS STILL WORTH THE TWO CHANNELS.
         *
         * `pool` used to be what `_emitRing` scooped a trench with, and the
         * asymmetry existed because the trench would have run out of the lake
         * along the dry bank as a gutter pointing at the water like an arrow.
         * There is no trench any more — it is the groove, and the block in
         * `_emitRing` is where it went — so that particular failure cannot
         * happen.
         *
         * The distinction survives because `pool` is now the one number that
         * says "this ring is standing water, not a stream": `_emitWater` deepens
         * a stream by it, so a run that fattens into a pool broadens rather than
         * stopping at a width, and the still sheet below is gated on the level
         * solve rather than on a die roll. The bank is `wet` without being
         * `pool`, which is exactly what a bank is.
         */
        path.pool[j] = j >= deep0 ? 1 : 0;
      }
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
 * WHAT AN EMITTER LOOKS LIKE AND WHAT ITS LIGHT LOOKS LIKE ARE NOT THE SAME
 * COLOUR, AND CONFLATING THEM IS MOST OF WHY THIS CAVE WAS A LAVA LAMP.
 *
 * MEASURED, over the 136 148 vertices of grove-01 k=0 with the bake dumped
 * straight out of the buffer: aLit is (0.063, 0.065, 0.122) mean and reaches
 * (1.74, 1.21, 2.40). It is the largest term in the material by a factor of
 * three in most of the frame — the near-field term is dead past three metres
 * and the ambient is 0.008 — and it is a SATURATED BLUE. Rendering one term at
 * a time to the framebuffer at the mouth station showed it as the violet cloud
 * the whole verdict was about: ACES pushes a saturated blue toward magenta, so
 * a light that is measurably blue arrives on screen as purple, and there is
 * nothing in the rock's own shading that can survive being multiplied by it.
 *
 * The mean over the roster is worse than any single entry. FUNGUS_COLD is
 * (0.061, 0.607, 0.871) linear, FUNGUS_DEEP (0.325, 0.125, 0.807): both are
 * near the edge of the gamut, so what a cave is lit BY is a colour no rock
 * could ever be seen under.
 *
 * The fix is not to change the palette. The heads, the crystal facets and the
 * spores are EMITTERS — you are looking at the source, and a source may be as
 * saturated as it likes; the reference photographs everybody remembers are
 * exactly that, a vivid point in a room of grey stone. What must not be
 * saturated is the IRRADIANCE, because irradiance is multiplied by an albedo
 * and a fully saturated multiplier deletes two of the rock's three channels.
 *
 * So the colour is split at the one place every baked source funnels through.
 * Luminance is preserved EXACTLY — dot with the Rec. 709 weights, then lerp the
 * colour toward that grey — so this changes no exposure anywhere, does not
 * touch the soft clamp in _shade, and cannot make the cave brighter or darker.
 * It is one lerp per light at build time and nothing per frame.
 *
 * LINEAR, NOT sRGB, and that is not a detail. THREE.Color holds linear once
 * ColorManagement is on, so a ratio taken here is a ratio of light; the same
 * lerp written on sRGB components renders as washed grey, which is the trap the
 * plumage multipliers were caught by.
 *
 * A crystal keeps more of its hue than a fungus does. A seam is the one thing
 * down here that exists to be a destination, and the argument at CRYSTAL_REACH
 * is that what it sells is CONTRAST — against dark rock, and now also against
 * rock lit a different colour.
 */
/**
 * HOW FAR, AND 0.58 WAS NOT FAR ENOUGH — MEASURED TWICE.
 *
 * At 0.58 the fungus light lands as (0.323, 0.554, 0.663) and the deep violet
 * as (0.261, 0.178, 0.464). Both are still cool enough to be a COLOUR, and with
 * 230 sources in a 346 m cave — one every metre and a half — every square metre
 * of wall is inside somebody's reach, so a cave lit by a coloured light is a
 * cave that is entirely that colour. The tour at 70 m still came back as a
 * uniform lavender tube with the rock invisible underneath it.
 *
 * The lighting design says the darkness between clusters is what makes a
 * cluster land, and that is not what the roster actually produces; but the
 * placement is another agent's and reseeding it moves nine gates. Desaturating
 * is the half of the same fix that is mine, and it is the stronger half anyway:
 * vLit is irradiance TIMES ALBEDO (see _shade), so as the light approaches
 * white, vLit approaches the rock's own colour multiplied by a brightness.
 * At 0.8 the passage is lit by something near daylight and what you see is
 * stone — which is the entire brief.
 *
 * The heads, the spore motes and the crystal facets are untouched and still
 * draw at full saturation, so the cave has exactly as much colour in it as
 * before. It is now IN THE SOURCES, where colour reads, instead of smeared over
 * every surface, where it only tints.
 */
const LIT_DESAT_FUNGUS = 0.8;
const LIT_DESAT_CRYSTAL = 0.55;

function litColour(c, amount) {
  const lum = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  return new THREE.Color(
    lerp(c.r, lum, amount),
    lerp(c.g, lum, amount),
    lerp(c.b, lum, amount)
  );
}

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
        /**
         * …AND BY DEPTH, WHICH IS WHAT MAKES THE LAST SEAM THE ONE YOU REMEMBER.
         *
         * `deep` (see CHANNELS) is 0 at the mouth and 1 at DEEP_FULL below it.
         * Before this every seam in a cave was drawn from the same size
         * distribution, so the one twenty metres in and the one at the terminus
         * a hundred and eighty metres down were the same object twice — and a
         * feature you have already seen at full size is not a reward for going
         * further.
         *
         * ON THE LENGTH AND NOT ON THE COUNT, DELIBERATELY. A spike is a fixed
         * number of facets whatever its size, so scaling `len` moves not one
         * triangle: the deep seams get bigger and the shallow ones get smaller
         * and the cave's geometry budget does not move at all. `many` is left
         * exactly as it was for the same reason.
         *
         * 0.55 at the mouth to 1.35 at the terminus. The floor is high enough
         * that a shallow seam still catches the eye down a passage — it is a
         * hint, not an absence — and the ceiling is bounded by the same
         * `clamp(room * 0.3, ...)` that has always stopped a seam meeting itself
         * across a narrow passage, so this cannot re-open the "wall made of
         * light" failure the block below records.
         */
        const deep = path.deep ? path.deep[j] : 0;
        const len =
          (big ? rngRange(rng, 1.4, 3.0) : rngRange(rng, 0.3, 1.0)) *
          clamp(room * 0.3, 0.4, 1.5) *
          (0.55 + 0.8 * deep);
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
/*  the roost                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * SOMETHING LIVES DOWN HERE.
 *
 * Everything above this line is geology, and the audit that read it said so: a
 * swept tube with six real cross-sections, chambers sized from the rock, welded
 * branches, genuine loop closures, a drip process, a draught that rises as the
 * passage tightens, a reverb that knows how big the room is. And a perfectly
 * observed, completely dead room. Nothing in it moved except water and spores;
 * nothing in it reacted to a person walking through.
 *
 * The intended moment is one moment and the whole thing is built backwards from
 * it: you round a corner into a chamber, the ceiling is speckled with small dark
 * lumps you take for stalactites — because the ceiling of every chamber in this
 * cave is already speckled with small dark lumps — and then one of them MOVES,
 * and then the whole ceiling comes off at once and goes past your head with a
 * sound like paper.
 *
 *
 * WHY THERE IS NO PER-FRAME CPU IN ANY OF IT.
 *
 * Two hundred animals with positions is two hundred objects to integrate, and
 * this project's whole fauna layer is host-authoritative for exactly that reason
 * — see `one-client-simulates-the-animals`. None of that applies here, because a
 * bat's trajectory does not have to be SIMULATED: hanging is a fixed point, and
 * flight is a closed-form orbit about a fixed centre. Both are pure functions of
 * (uTime, seed, uFlush), so the vertex shader can evaluate them and the CPU
 * never touches a bat after the build. That also makes them free over the
 * network, which is the same argument the trip's fields make and the same reason
 * `worldClock` exists: two people standing in one chamber see the same bat in
 * the same place with zero bytes travelling, because both derive it.
 *
 * The one thing that is not derivable is WHEN somebody disturbed the roost. That
 * is a single float uniform per roost, written by one squared-distance test per
 * frame in `CaveField.update` — see `Cave.checkFlush`. Everything else, all two
 * hundred of them, comes out of it.
 *
 *
 * AND WHY THEY ARE NOT ADDITIVE, WHICH IS THE ONE THING THIS FILE HAD NEVER
 * DRAWN.
 *
 * Every emitter in this file — the fungus heads, the crystal halos, the spores,
 * the beams — is AdditiveBlending, because everything in the cave up to now has
 * been a light. A bat is the opposite object: it is a hole in whatever is behind
 * it. It has to be alpha-tested and opaque or it stops reading the instant it
 * crosses a beam, which is precisely where it must read best.
 */

/** How many bats hang in one roost, and how big one is across the wings. */
const BAT_MIN = 90;
const BAT_MAX = 220;
/**
 * 0.24-0.38 m. A lesser horseshoe bat is 0.25 across and a greater about 0.38,
 * which is the size range that actually roosts in European limestone caves in
 * clusters this size. It matters more than it sounds: a bat scaled up to read
 * "clearly" at ten metres is a fruit bat, and a fruit bat in a cave in a
 * temperate wood is a thing people cannot name and do not believe.
 */
const BAT_SPAN_MIN = 0.24;
const BAT_SPAN_MAX = 0.38;
/**
 * At most two roosts in one cave, and usually one.
 *
 * SCARCITY IS THE FEATURE. A cave with a colony in every chamber has a bat
 * problem rather than a bat; the reveal is worth what it is worth because it
 * happens once, in one room, and the four chambers you walked through before it
 * had nothing on their ceilings but rock. Two is allowed only where the walk
 * built enough chambers that one roost could plausibly be missed entirely.
 */
const ROOST_MAX = 2;
/** Metres between two roosts, so they cannot both be in the same hall. */
const ROOST_APART = 55;

/**
 * How near the body has to be for the ceiling to come off. See `checkFlush`.
 *
 * Thirteen metres horizontally, and a vertical window rather than a sphere: 9 m
 * below the colony (you are on the floor of a chamber whose roof is high) and
 * 6 m above it (which is inside the same room; more would let a passage running
 * over the chamber trigger it, and `xz distance reaches through mountains` is
 * the one mistake this file's consumers have made most often).
 */
const FLUSH_NEAR = 13;
const FLUSH_BELOW = 9;
const FLUSH_ABOVE = 6;

/**
 * Where they hang, and it is the DRAWN roof and not the analytic one.
 *
 * `ceilY` is the existing exact answer to "where is the ceiling at this
 * horizontal offset, after the rock displacement" — the same pair of functions
 * the collider and the stalactites use. Seating on `path.y + r * t` instead is
 * the mistake `placeSpires` made and has a screen of comment about: the roof at
 * the wall of a phreatic tube is metres below the apex, so half the colony would
 * hang inside the rock and the other half in mid-air.
 *
 * BAT_CLEAR is how far under it they hang. A bat's feet are on the rock and its
 * body is below them, so the anchor — which is where the ANIMAL is, not where
 * its toes are — sits about a body length down.
 */
const BAT_CLEAR = 0.09;

/**
 * One roost's worth of bats, as (anchor, seed) pairs.
 *
 * `cand` is one of the chamber runs `_planShafts` found — see `this._chambers`.
 * The whole of the placement is: pick a ring in the run, pick a horizontal
 * offset across it, ask the roof where it is, hang a bat there.
 *
 * SPREAD ACROSS THE RUN AND NOT PILED AT ITS BIGGEST RING, for the reason
 * `_lightChamber` spreads its beams: a colony at one ring is a disc, and the
 * thing a real roost does to a chamber is COVER its ceiling, which is what makes
 * "the whole ceiling comes off" a sentence about the room rather than about a
 * cloud of dots.
 *
 * WEIGHTED TOWARD THE APEX. `-0.62..0.62` of the half-width rather than the full
 * span, because bats hang where the roof is highest and flattest and because the
 * two extremes of the section are where `ceilY` is closest to the wall — a bat
 * at 0.95 of the half-width is hanging off a vertical face, which is a thing
 * they do and a thing that looks like a bug.
 */
function placeBats(c, path, cand, rng) {
  const { lo, hi, at } = cand;
  const n = path.x.length;
  const count = BAT_MIN + Math.floor(rng() * (BAT_MAX - BAT_MIN + 1));
  const out = [];
  const sh = { w: 1, t: 1, f: 0.5, key: 0 };
  for (let b = 0; b < count; b++) {
    const j = clamp(lo + Math.floor(rng() * Math.max(1, hi - lo)), 1, n - 2);
    ringShape(path, j, sh);
    const r = path.r[j];
    const nOff = rngRange(rng, -0.62, 0.62) * sh.w;
    const a = Math.max(0, j - 1);
    const bb = Math.min(n - 1, j + 1);
    let tx = path.x[bb] - path.x[a];
    let tz = path.z[bb] - path.z[a];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    // Right-hand basis about the tangent, the same one every placer here uses,
    // plus a slide along it so a ring's worth of bats is not a line across the
    // roof.
    const slide = rngRange(rng, -0.5, 0.5) * RING_STEP;
    const px = path.x[j] - tz * nOff * r + tx * slide;
    const pz = path.z[j] + tx * nOff * r + tz * slide;
    const py = ceilY(c.k, path, j, sh, nOff, px, pz) - BAT_CLEAR;
    out.push({
      x: px,
      y: py,
      z: pz,
      span: rngRange(rng, BAT_SPAN_MIN, BAT_SPAN_MAX),
      seed: rng(),
    });
  }

  /**
   * …AND THE ORBIT THEY FLY, WHICH IS A PROPERTY OF THE ROOM AND NOT OF A BAT.
   *
   * One centre for the whole colony, on the chamber's biggest ring, at a third
   * of the way down from the roof. Every bat's own orbit is a Lissajous about
   * this point with its own radius, its own frequency ratio and its own phase —
   * so they fill the room rather than forming a ring, and no two of them are
   * ever in step for long. A shared centre is what makes it read as ONE colony
   * milling in ONE chamber instead of two hundred independent animals.
   *
   * THE RADIUS COMES FROM THE ROCK. `half` is the chamber's own half-width, so a
   * colony flushed in a 24 m hall wheels across 24 m of it and a colony in a 6 m
   * chamber wheels tightly — and neither can fly through a wall, because both
   * are measured from the wall. 0.62 leaves a margin for the vertical wander and
   * for the section pinching at the ends of the run.
   */
  const ci = clamp(at, 1, n - 2);
  ringShape(path, ci, sh);
  const half = path.r[ci] * sh.w;
  const head = path.r[ci] * (sh.f + sh.t);
  return {
    bats: out,
    cx: path.x[ci],
    cy: path.y[ci] + path.r[ci] * sh.t - head * 0.34,
    cz: path.z[ci],
    radius: Math.max(2.2, half * 0.62),
    // How far the colony wanders vertically. A third of the head-room, so a big
    // chamber gets a column of bats and a low one gets a sheet of them.
    rise: Math.max(0.8, head * 0.18),
  };
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
      /**
       * …AND THEN DESATURATED, FOR THE SAME REASON THE FUNGI WERE. See
       * litColour.
       *
       * 0x74a294 is (0.175, 0.361, 0.296) linear — twice as much green as red —
       * and at the mouth it is the largest term in the material by an order of
       * magnitude. Rendered alone at the doorway station it is a flat mint-green
       * wash over every surface in the first thirty metres, and it is the reason
       * the one speleothem in the frame read as painted plastic: a green
       * multiplier on a nearly neutral albedo is a green object, whatever the
       * albedo said.
       *
       * The argument for the green stands — what is on the other side of that
       * hole IS a wood, a cyan doorway would say "another cave", and light
       * coming through a canopy really is green. What was wrong is the amount.
       * 0x93a89b is (0.293, 0.391, 0.320): the SAME luminance to within 1%, so
       * uDayGain, the bloom behaviour at the doorway and the twilight blocks are
       * all untouched, with the green bias cut from 2.1:1 over red to 1.3:1.
       * That is enough that the doorway still reads warm-cool against the cave
       * and little enough that what it lands on reads as rock.
       */
      uDay: { value: new THREE.Color(0x93a89b) },
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
      /**
       * …AND THEN OFF THE INDIGO ENTIRELY, BECAUSE A CAVE IS MADE OF ROCK AND
       * THIS TERM IS MOST OF WHAT YOU SEE OF IT.
       *
       * Both blocks above are arguing about the HUE of a term whose real
       * problem is that it is the only thing on screen. Past three metres the
       * near-field term is dead by design and vLit is whatever the fungi
       * reached, so in the ordinary case — a passage between clusters — this
       * constant, times a noise, IS the picture. 0x141033 is (0.0070, 0.0052,
       * 0.0331) linear, four and a half times more blue than red, so the
       * ordinary case rendered as violet cloud. The verdict on it was that the
       * passage read as the inside of a lava lamp, and that is exactly what a
       * saturated constant multiplied by a 3D noise field looks like.
       *
       * 0x14161e is (0.0070, 0.0080, 0.0130): luminance 0.0082 against the old
       * 0.0076, so the cave is no darker — the FLOOR/FILL argument below still
       * holds and is untouched — and the blue:red ratio falls from 4.7 to 1.9.
       * That is still unmistakably cold, which is right: the light bouncing
       * around down here really does come off cyan and violet fungi. It is no
       * longer a colour in its own right, which is what let it beat the rock.
       *
       * The other half of this fix is at the multiply, three hundred lines
       * below: the term now carries the rock's own CHROMA and not merely its
       * level, so the darkness of a cave is a dark version of the stone in it.
       * That is precisely what the uAmbient note above rejected, and it was
       * right to reject it THEN — at a fungus gain of 0.29 there was no other
       * light and the whole passage was one brown. At the current gain the fungi
       * are the light in the room, and a neutral substrate under a small amount
       * of coloured light is the only arrangement in which coloured light reads
       * as light at all.
       */
      uAmbient: { value: new THREE.Color(0x171614) },
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
      /**
       * …AND IT WAS A LAMP RATHER THAN AIR.
       *
       * The argument above is right and the number was not. 0x1b2a6b is
       * (0.0106, 0.0231, 0.1499) linear, and the rock underground sits between
       * 0.015 and 0.05 — so the haze was TEN TIMES the brightest surface it was
       * hazing, in a saturated blue, arriving at 24% weight by thirty metres and
       * 39% by forty. Past about twenty-five metres the passage was not fogged
       * toward blue, it WAS blue, and the swirl in front of it was the noise on
       * the near rock showing through a colour ten stops too bright.
       *
       * 0x232c48 is (0.0168, 0.0252, 0.0647). Still comfortably the brightest
       * thing in the frame — which is the whole of the block above, and the
       * ordering it depends on is unchanged — but two stops nearer the rock and
       * far less saturated, so a far wall reads as a pale plate of STONE rather
       * than as a hole full of blue light. Blue against red falls from 14:1 to
       * 3.8:1.
       */
      uHaze: { value: new THREE.Color(0x232c48) },
      /**
       * THE FOUR CARRIED LIGHTS, ALL DEAD. See `CaveField.setLamps` and the
       * A FIRE YOU CAN CARRY IN block in the fragment shader.
       *
       * Fresh Vector4/Vector3 objects rather than a shared one per slot, because
       * `setLamps` writes them in place every frame and four aliases of one
       * vector would be one lamp drawn four times.
       */
      uLampPos: {
        value: [
          new THREE.Vector4(0, 0, 0, 0),
          new THREE.Vector4(0, 0, 0, 0),
          new THREE.Vector4(0, 0, 0, 0),
          new THREE.Vector4(0, 0, 0, 0),
        ],
      },
      uLampCol: {
        value: [
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, 0, 0),
        ],
      },
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
      // Four carried lights: (xyz, radius) and colour-times-power. All zero in
      // every frame nobody has put a fire down in. See CaveField.setLamps.
      uniform vec4 uLampPos[4];
      uniform vec3 uLampCol[4];
      varying vec3 vRock;
      varying vec3 vLit;
      varying vec4 vSurf;
      varying vec4 vGlow;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vDepthFog;

      /**
       * ONE CARRIED LIGHT. See the A FIRE YOU CAN CARRY IN block below, which
       * holds the design; this is only the arithmetic.
       *
       * lp is (position, radius) and lc is the colour ALREADY multiplied by the
       * lamp's power — one fewer uniform to keep in step, and the caller is the
       * only thing that knows what a campfire is worth against a torch.
       *
       * THE RADIUS IS THE FALLOFF SCALE AND NOT A CUTOFF. r^2/(d^2 + r^2) is
       * inverse-square everywhere it matters and is exactly 1/2 at the radius,
       * with no singularity at d = 0 to blow the frame out when somebody stands
       * a lamp against a wall. The windowing term on top of it is what actually
       * takes it to zero — at seven radii, squared so the approach to zero has
       * no visible edge — because a true inverse-square never reaches zero and a
       * light with an infinite tail lifts the black at the far end of a passage,
       * which is the one thing this cave's whole lighting design is protecting.
       *
       * A zeroed slot is (0,0,0,0) and returns exactly zero: the max() on the
       * radius keeps the divide finite and lc is black, so nothing about a dead
       * slot can leak.
       */
      vec3 caveLamp(vec4 lp, vec3 lc, vec3 P, vec3 nrm) {
        vec3 d = lp.xyz - P;
        float r2 = max(dot(d, d), 1e-4);
        float rad = max(lp.w, 0.01);
        float rr = rad * rad;
        float nl = max(dot(nrm, d * inversesqrt(r2)), 0.0);
        float w = max(0.0, 1.0 - r2 / (rr * 49.0));
        return lc * (nl * (rr / (r2 + rr)) * w * w);
      }

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
          /**
           * 0.55 -> 0.95, AND THE JUSTIFICATION IS THAT NOTHING DOWNSTREAM WAS
           * READING IT HARD ENOUGH FOR IT TO MATTER.
           *
           * The perturbation reaches the picture through ndl and spec, and ndl
           * was a SQUARED half-lambert — the softest terminator there is — so a
           * 0.55 tilt on a wall lit from one side moved the shading by a few per
           * cent. Rendering the normal straight to the framebuffer at 70 m
           * showed plenty of structure in it and the shipped frame beside it
           * showed a smooth tube: the relief was being computed and then shaded
           * flat. Both ends are fixed together — this, and the exponent at ndl —
           * because either alone is the wrong trade.
           *
           * The moiré guard is untouched and is the reason this is safe to
           * raise: the difference is still taken over a FIXED 30 cm of world, so
           * the footprint does not vary across the screen and there is nothing
           * for the raster to beat against. Amplitude was never the mechanism —
           * see rrRelief, where three attempts at blaming it all missed.
           */
          0.95 * (1.0 - 0.28 * clamp(geoN.y, 0.0, 1.0)) * (1.0 - vWet),
          0.30,
          grainRaw
        );
        float fineRaw;
        n = rrRelief(
          n,
          vWorld + 41.7,
          4.2,
          // Same raise, same reason. See the coarse octave above.
          0.36 * (1.0 - 0.28 * clamp(geoN.y, 0.0, 1.0)) * (1.0 - vWet),
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
        /**
         * TWO BANDS, AND THE OLD ONE WAS THREE METRES THICK.
         *
         * The comment under the normal ledge below claims "a ledge every 45 cm"
         * and "its period is 35 cm". Neither is true and it is worth writing
         * down why, because both numbers were used to justify keeping the
         * amplitude small. bedX/bedY/bedZ is a UNIT vector — see the dip block
         * in prepare — so vSurf.z is a distance in metres and sin(z * 2.2) has
         * a period of 2 pi / 2.2 = 2.86 m. A four-metre passage therefore
         * contained ONE AND A HALF BEDS, at plus or minus 18% contrast, faded
         * further with distance. That is not strata, it is a gradient, and it is
         * why the strongest "this is stone" cue that exists was invisible in
         * every shot of this cave.
         *
         * Limestone in a cave passage shows two scales at once and they are the
         * whole read: beds a metre or two thick, and laminations within them a
         * few tens of centimetres apart. 4.3 rad/m is a 1.46 m bed; 17 rad/m is
         * a 0.37 m lamination. The phase warp is carried on the coarse band only
         * and is smaller than it was (3.4 against 5.2), because the fine band is
         * already near the limit where a warp becomes a frequency multiplier —
         * the trap the normal-ledge block below is about.
         *
         * Clamped before it is remapped, so the sum of the two cannot exceed the
         * range the multiply at the bottom was tuned against.
         */
        /**
         * SPACED TO MATCH THE HILL. 2.618 rad/m is a 2.40 m bed, which is the
         * spacing terrain.js gives the crag it stands in — so the built rock at
         * the doorway and the grown rock either side of it are bedded on the
         * same interval and read as one outcrop. That agreement is worth more
         * than either number being ideal on its own: a mouth where the strata
         * change pitch across the join is a mouth that says "two meshes".
         *
         * A second band at three times the frequency (0.80 m) because 2.4 m
         * alone is one and a half bands across a passage — the failure the block
         * above measured — while on the twenty-metre shell outside it is eight,
         * which is where the coarse one earns its place.
         *
         * AND THE PHASE WARP IS NOW A FRACTION OF A PERIOD, WHICH IT NEVER WAS.
         * grain runs 0..1, so the old "+ grain * 5.2" was 0.83 of a cycle of
         * warp on a 2.86 m band — the sine's phase was scrambled clean across
         * itself at the 1 m scale of the grain, which turns strata into one more
         * lump of noise. That, not the amplitude, is why bedding had never been
         * visible in a shot of this cave. 0.9 and 0.5 rad are 14% and 6% of a
         * cycle: enough that the bands wander like real ones, not enough to stop
         * being bands.
         */
        float bedC = sin(vSurf.z * 2.618 + grain * 0.9);
        float bedF = sin(vSurf.z * 7.85 + grain * 0.5);
        float bed = clamp(bedC * 0.60 + bedF * 0.36, -1.0, 1.0) * 0.5 + 0.5;

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
        /**
         * …AT BOTH FREQUENCIES NOW, AND THE FINE ONE IS FADED WITH DISTANCE.
         *
         * The reasoning above is exactly right and the frequency was simply the
         * wrong one — a 2.86 m ledge is a ledge you cannot see. The coarse band
         * gets the bulk of the tilt at its own 1.46 m; the lamination gets a
         * third of it at 0.37 m, which is fine enough to need the same treatment
         * the two relief octaves get twenty lines below. cos() has no mip chain
         * either: at forty metres a 0.37 m band is a couple of pixels a cycle
         * and would crawl exactly as the noise does, so mdist is hoisted above
         * this line and applied here as well.
         *
         * mdist USED TO BE DECLARED AFTER THE LIGHTING, which is why the ledge
         * never had it. Moving the declaration costs nothing — it is one
         * smoothstep of a distance that is already in a register — and it is now
         * the single fade shared by the relief, the ledge and the bedding, which
         * is what it should always have been.
         */
        float mdist = 1.0 - 0.62 * smoothstep(9.0, 38.0, dist);
        vec3 up2 = abs(geoN.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        vec3 bt = normalize(cross(cross(up2, geoN), geoN));
        n = normalize(n + bt * (cos(vSurf.z * 2.618) * 0.22
                              + cos(vSurf.z * 7.85) * 0.12 * mdist));

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
         * exactly zero, wrap of exactly 0.5, and 0.55 + 0.45 = 1.0, which is what
         * the old constant was.
         *
         * 0.70 + 0.60 -> 0.55 + 0.90, i.e. from +/-30% to +/-45%, and the mean is
         * still exactly 1.0 by the same argument. This is the branch a
         * free-standing column or a breakdown block in the middle of a chamber
         * takes — surrounded, therefore incoherent by construction — and those
         * were the last things in the cave still reading as flat pale card. A
         * weak agreement is not no agreement, and it is worth more contrast than
         * it was being given.
         */
        /**
         * …AND THE COHERENT HALF IS CUBED, NOT SQUARED, WHICH IS THE OTHER END
         * OF THE FIX AT rrRelief's SCALE.
         *
         * Rendering coh to the framebuffer at 70 m in came back clipped white
         * over nearly the whole frame: the passage is narrow, so a wall is
         * almost always dominated by one cluster and this mix is almost always
         * fully at the coherent end. That is the good case, and it was being
         * spent on wrap * wrap — a HALF-lambert, squared, which still returns
         * 0.25 for a surface facing directly away from the light. Between that
         * floor and its own softness there was barely a third of a stop between
         * the lit and unlit sides of a boulder, and the tube came out smooth.
         *
         * The mean is held exactly. mean(wrap^n) over a sphere is 1/(n + 1), so
         * wrap^2 * 1.45 averages 0.483 and wrap^3 * 1.9 averages 0.475 — the
         * cave's exposure does not move, and what is bought is that a surface
         * turned away now returns 0.12 instead of 0.36 while one facing the
         * light returns nearly twice as much as its neighbour. That difference
         * IS relief; there was nowhere else for it to come from, because there
         * are no shadows down here and there never will be.
         */
        float ndl = mix(0.55 + 0.90 * wrap, wrap * wrap * wrap * 1.9, clamp(coh, 0.0, 1.0));

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
        /**
         * A SIXTEEN-FOLD NOISE SWING ON A FLAT TERM IS NOT RELIEF, IT IS SMOKE.
         *
         * (0.46 + 0.80 g) * (0.55 + 0.90 f) * 1.16 runs 0.29 to 2.12, and the
         * two scalar multiplies further down take the compound range on the
         * ambient to 0.19-3.0. In a passage between clusters the ambient is
         * ninety per cent of the pixel, so the shipped picture was one colour
         * modulated by a factor of sixteen of isotropic 3D value noise. There is
         * no surface anywhere in that description — an unlit noise field with no
         * plane, no direction and no scale in it is a volume, and it read as
         * one.
         *
         * The energy is not deleted, it is MOVED, to the two terms below that
         * have a geometry in them: the bedding, which is planar and therefore
         * says "stone", and the relief ledge in the normal, which catches light.
         * A factor of 3.6 here still carries every bit of the pitting the fine
         * octave is for, at a contrast that reads as a rough wall rather than as
         * weather. Mean is 1.007 at the mean of both octaves, so the exposure of
         * the cave does not move.
         */
        // mdist is declared with the bedding ledge above — see the block there.
        float micro = 1.0 + ((0.62 + 0.56 * grain) * (0.68 + 0.62 * fine) * 1.13 - 1.0) * mdist;
        /**
         * AND THE DARK IS A DARK VERSION OF THE STONE, NOT A COLOUR OF ITS OWN.
         *
         * (0.45 + 4.0 * rockLum) takes the albedo's LEVEL and throws its HUE
         * away, on the argument at uAmbient that 0.028 of the rock's own brown
         * is a hundred metres of darker brown. That argument was made against a
         * fungus gain of 0.29, when there was no other light in the cave; at the
         * current gain the fungi and the crystals ARE the light, and the thing
         * they need to play over is rock. A term that carries level but not hue
         * is a greyscale mask on a coloured constant, which is why the walls
         * came back as coloured cloud whatever the geometry under them did.
         *
         * 60% of the way to the albedo's own chroma. 4.5 is the reciprocal of
         * the measured mean albedo, so the mean of the whole bracket is 1.01
         * against the old 1.08 and the cave is no darker; what changes is that
         * the vein, the mottle, the flood line and the calcite now show in the
         * NINETY PER CENT of the frame that this term owns, instead of only in
         * the two metres the near-field term reaches.
         */
        vec3 col = uAmbient * (0.30 + 0.70 * ao) * micro * (1.0 - 0.42 * n.y)
                 * (0.30 + mix(vec3(4.5 * rockLum), vRock * 4.5, 0.60));
        /**
         * 0.46, DOWN FROM 0.72, AND THE FUDGE IT WAS STANDING IN FOR IS NOW
         * REAL.
         *
         * The block above is scrupulously honest that this term is not a torch —
         * it is dark adaptation, drawn on the rock, because there was nowhere
         * else to put it. There is now: pipeline.setCaveAdaptation opens the
         * frame's exposure to 2.1x over four seconds as caveMix rises and
         * shuts it in three quarters of a second on the way out, which is what
         * dark adaptation actually is — a property of the eye applied to the
         * whole image, not a glow the player carries two metres in front of
         * their face.
         *
         * So this can stop pretending. 0.46 is 0.64 of what it was; against a
         * 2.1x exposure the term lands at about 1.34x its old ON-SCREEN level
         * while the ambient, the fungi and the crystals land at the full 2.1x.
         * The ratio is what moved, and it moved the right way: the two metres
         * around your feet get relatively DARKER against the mid-distance, which
         * is the handover to the fungi that placeFungi and the near-field
         * block have both been arguing for and neither could deliver while this
         * number was carrying the whole of the cave's legibility on its own.
         *
         * It was not taken further. At zero the passage between clusters is a
         * black corridor again — the failure at the top of placeCrystals —
         * because exposure multiplies what is there and there is nothing there.
         */
        col += vRock * near * 0.46 * (0.35 + 0.65 * ao);
        /**
         * MICRO GOES ON THE FUNGUS LIGHT TOO, AND IT ONLY EVER WENT ON THE
         * AMBIENT.
         *
         * micro is the relief read as OCCLUSION — a hollow in the rock sees less
         * of the room than the boss beside it. Its own block argues that for the
         * ambient and stops there, but a pit in a wall is dark under a fungus
         * cluster for exactly the same reason it is dark under bounced light:
         * less of the source can see into it. Leaving it off vLit meant the one
         * term that dominates every lit surface in the cave was the one term
         * with no cavity shading in it at all, so the closer a wall was to a
         * cluster the FLATTER it got. Free — micro is already in a register.
         */
        col += vLit * ndl * micro * (0.62 + 0.5 * grain) * (0.25 + 0.75 * ao);
        /**
         * DAYLIGHT LANDS ON ROCK. IT IS NOT A FILL IN THE AIR, AND FOR THE WHOLE
         * LIFE OF THIS SHADER IT WAS ONE.
         *
         * This line was "col += uDay * vDay * uDayGain": a flat additive
         * constant with no albedo, no occlusion and no normal anywhere in it.
         *
         * MEASURED, at the two stations this pass is judged on. _daylight is
         * exp(-along / 14) * 0.42, so vDay peaks at 0.42 at the doorway; uDay is
         * 0x74a294, linear (0.176, 0.373, 0.291); uDayGain is 1.45 at noon. The
         * term is therefore (0.107, 0.227, 0.177) linear at the mouth — against
         * a near-field term of about 0.024 and an ambient of about 0.027 on the
         * same pixel. TEN TIMES everything else in the first fourteen metres of
         * passage, identical on every surface in it, and then multiplied by the
         * two scalar noise octaves on the lines below.
         *
         * A constant times a 3D noise is not a lit surface, it is fog. That is
         * the whole of why the mouth read as swirling mint-teal smoke with no
         * stone in it. Nine tenths of every pixel there was one colour with a
         * cloud painted over it, and the geometry, the bedding, the relief and
         * the albedo were fighting over the remaining tenth.
         *
         * Three multiplies and it becomes light instead of paint:
         *
         *   TIMES THE ALBEDO, because reflected daylight is irradiance times
         *   reflectance, and vRock is the only thing in this material that knows
         *   the rock is veined, mottled, silted below the flood line and pale
         *   where calcite grew. 5.7 is the reciprocal of the measured mean
         *   albedo over the lattice (0.157 after the wet and open factors), so the
         *   AVERAGE brightness at the doorway is unchanged to within a few per
         *   cent and what is bought is that every one of those features becomes
         *   legible in the one part of the cave with enough light to see them.
         *
         *   TIMES THE OCCLUSION, because a doorway lights what can see it, and
         *   the recess behind a rib is not looking at the doorway.
         *
         *   AND TIMES THE NORMAL, weakly. There is no direction attribute for
         *   this term and there should not be one — a second baked vector for a
         *   light that is one hole is not worth twelve bytes a vertex — but the
         *   daylight in a cave mouth arrives off the sky and off the ground
         *   outside, so an upward-facing surface sees more of it than a
         *   downward-facing one. Centred on 1.0 so the mean over a sphere does
         *   not move either.
         */
        col += uDay * vDay * uDayGain
             * (0.10 + 5.7 * vRock) * (0.30 + 0.70 * ao) * (1.0 + 0.30 * n.y);

        /**
         * ==== A FIRE YOU CAN CARRY IN ========================================
         *
         * Everything above this line is BAKED — computed on the CPU at build
         * time and read out of a vertex attribute — and the header explains at
         * length why: a light that does not move costs exactly nothing per
         * frame, so thirty fungus clusters cost what none do. That argument is
         * airtight and it has one hole in it, which is that it makes it
         * impossible for a player to bring a light of their own into a cave.
         *
         * FOUR SLOTS, FIXED, WITH THE DEAD ONES ZEROED. That is the whole design
         * and the alternative was rejected on the project's own evidence: a
         * uniform COUNT, or an array whose length varies, is a different program
         * for every count, and this material takes 100-180 ms to compile — see
         * caveWarmupObjects, which exists solely because of that. A fixed four
         * is ONE program, compiled once, warmed by the same pre-warm as before,
         * and a cave with no lamps in it takes the identical path with three
         * multiplies against zero.
         *
         * IT IS UNBRANCHED, DELIBERATELY. An if (uLampAny > 0.0) around this
         * would be a uniform branch and therefore free of divergence — and it
         * would also be a fifth piece of state that has to agree with the other
         * four, i.e. exactly the kind of thing that goes stale and silently
         * deletes a feature. Four lamps unconditionally is about forty ALU on a
         * shader that already takes five texture fetches and several hundred, in
         * the cheapest place in the world at 0.60 ms. It is not worth a bug.
         *
         * N.L AGAINST THE GEOMETRIC NORMAL — the same perturbed normal every term
         * above uses, so a lamp picks out the same relief the fungi do — and
         * TIMES vRock, because a lamp is light and light reflects off the rock's
         * own colour. That last multiply is what makes a carried fire show you
         * the vein and the flood line and the calcite rather than washing them
         * out, and it is the same correction the daylight term two blocks up had
         * to have made to it.
         */
        vec3 lamp = caveLamp(uLampPos[0], uLampCol[0], vWorld, n)
                  + caveLamp(uLampPos[1], uLampCol[1], vWorld, n)
                  + caveLamp(uLampPos[2], uLampCol[2], vWorld, n)
                  + caveLamp(uLampPos[3], uLampCol[3], vWorld, n);
        col += vRock * lamp;

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
        /**
         * 0.36 -> 0.62, AND THE CORDUROY THE OLD NOTE FEARED WAS A FUNCTION OF
         * THE FREQUENCY, NOT OF THE AMPLITUDE.
         *
         * "At 0.30 the floor of a passage read as corduroy" was measured on ONE
         * sine at a 2.86 m period (the note above says 35 cm; it is wrong, see
         * the bed block). A three-metre stripe seen down a passage floor is a
         * huge soft band that can only read as a lighting error, and no
         * amplitude of it ever reads as rock. Two bands at 1.46 m and 0.37 m
         * read as bedding at twice the contrast, because that is the spacing a
         * bedded rock actually has and because the fine one gives the coarse one
         * a scale to be judged against.
         *
         * The floor keeps most of the old caution. Bedding on a walking surface
         * is seen almost edge-on, which stretches every band along the view
         * direction — that IS the corduroy — so it is damped by up-facing-ness,
         * which the walls and the ceiling do not pay.
         *
         * This is the single term the ambient's noise budget was cut to pay for,
         * and it is the trade the whole pass turns on: a planar, oriented,
         * per-cave-dipped band is a geological fact about the rock, and an
         * isotropic 3D value noise is weather.
         */
        col *= 1.0 + (bed - 0.5) * 0.62 * mdist * (1.0 - 0.25 * clamp(geoN.y, 0.0, 1.0));

        /**
         * WET, WHICH IS THE ONE THING EVERY CAVE HAS AND THIS ONE HAD NONE OF.
         *
         * 'spec' below is a tight lobe gated on 'coh', so it fires only where a
         * single cluster dominates — which is a minority of the surface of a
         * cave by construction, since the whole lighting design is long dark
         * runs between sparse sources. Everywhere else the rock had no
         * view-dependent term at all, and a surface whose brightness does not
         * change as you move past it is a surface made of paper.
         *
         * A fresnel needs no light direction, which is exactly why it works
         * here: what a wet wall does in the dark is return the AMBIENT at
         * grazing angles, and it does it whether or not anything is shining on
         * it. Inside a tube the periphery of the passage is grazing by
         * construction, so this lands on the walls beside and behind you as you
         * walk — the place a cave feels wet.
         *
         * It reflects uHaze and the baked light rather than white, so it can
         * never introduce a colour of its own; and it is weighted DOWN on
         * up-facing surfaces, because a cave floor is silt and rubble and is the
         * one dry-looking thing down here. Two ALU and one pow on top of terms
         * already in registers.
         */
        float wetFace = 0.34 + 0.66 * (1.0 - clamp(geoN.y, 0.0, 1.0));
        float wetRim = pow(1.0 - clamp(abs(dot(n, view)), 0.0, 1.0), 4.0);
        // step(), not (1.0 - vWet): the wet tag is 0 / 1 / 2 (see _emitWater), so
        // subtracting it would drive a lake's rock terms NEGATIVE — and the water
        // branch below reads col as its own bed, so a negative would survive.
        // Mostly the light in the room, only a little of the far air. uHaze is
        // the bluest thing in this material and a rim term touches the whole
        // periphery of a tube, so a heavy uHaze here was a fourth blue on every
        // wall — see the base-colour block in _shade.
        col += (uHaze * 0.28 + vLit * 0.85) * wetRim * wetFace * (0.25 + 0.75 * ao)
             * (1.0 - step(0.5, vWet));

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
          /**
           * AND THE RIPPLE HAS TO DIE WITH DISTANCE, WHICH IT DID NOT HAVE TO
           * BEFORE BECAUSE NOTHING DOWNSTREAM OF IT VARIED.
           *
           * The two sines are at 1.9 m and 2.3 m of wavelength. At thirty metres
           * that is three or four pixels a cycle, and there is no mip chain on an
           * analytic function — so with the fresnel above pinned at 1 the whole
           * ripple was multiplied out of existence and nobody ever saw it alias.
           * Un-pin the fresnel and the same wave becomes the input to a
           * fifth-power curve: the first frame back showed a stream thirty metres
           * off as a ladder of hard horizontal stripes, exactly like corrugated
           * metal, and a lake edge-on as a barcode.
           *
           * This is the mip chain, written as a fade. Full amplitude out to five
           * metres, where a cycle is still tens of pixels across and the movement
           * is the best thing about the water; a tenth of it by thirty, where the
           * surface should be a smooth plate holding one gradient. It is the
           * honest answer rather than a cosmetic one — the correct filtered value
           * of a wave you cannot resolve IS its mean, and its mean is flat.
           *
           * spark gets it too and needs it more: it is sin*sin to the twelfth,
           * so its features are a fraction of a wavelength wide and it aliases
           * into a shimmering dot screen at half the distance the ripple does.
           */
          float ripFade = mix(1.0, 0.10, smoothstep(5.0, 30.0, dist));
          rip *= ripFade;
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
          /**
           * abs(), AND THAT ONE CHARACTER IS MOST OF WHY THE POOL WAS PLASTIC.
           *
           * clamp(dot(wn, v), 0.0, 1.0) is zero for every water pixel whose
           * surface is ABOVE the eye, and in a cave that is most of them: a
           * passage that pitches up in front of you puts its stream ten metres
           * away and five metres higher, and the terminal chamber is a bowl you
           * stand at the bottom of. Measured off the framebuffer on grove-01 k=0
           * with the water rendering its own terms — dot(wn, v) came back 0.000
           * and fres 1.004 over EVERY water pixel in the frame, mean v.y -0.172.
           *
           * A fresnel pinned at 1 is not a fresnel. It made sheen a constant
           * 1.315 (measured) instead of a term that runs from nearly nothing
           * looking down into the water to nearly all of it looking along the
           * surface, and it made the haze term below a flat fill. Every
           * "water is dark" argument in the two blocks around this line was
           * describing code that could not execute.
           *
           * The magnitude of the dot IS the grazing angle. A surface above the
           * eye is grazed exactly as much as one the same angle below it, and
           * the sign only says which side of the plane you are on — which for an
           * opaque sheet you are never wrong about, because you cannot see the
           * underside. So abs(), and the exponent goes 4 -> 5 now that the term
           * has a range to be steep over.
           */
          float fres = pow(1.0 - clamp(abs(dot(wn, v)), 0.0, 1.0), 5.0);
          float spark = pow(max(0.0, sin(wx * 1.7) * sin(wz * 1.3)), 12.0) * ripFade;
          /**
           * AND THE FLOOR COMES OFF THE SHEEN, because a floor under a fresnel
           * is a floor under the one term that is supposed to reach zero.
           *
           * 0.32 was the reason the pool could never be dark: it is a third of
           * the surface's reflectance handed out at every angle including
           * straight down, so a mirror looked into from above still returned a
           * third of whatever was baked into it. It was harmless while fres was
           * stuck at 1 — 0.32 against 1.32 is a quarter of a term nobody could
           * see varying — and it is the whole ball game now that fres works.
           *
           * 0.05 is the real number for water at normal incidence (about 2% for
           * the specular, plus a little for the fact that this stands in for a
           * blurred reflection rather than a perfect one). What you see looking
           * straight down is not the sheen at all, it is the lit bottom, and
           * that is a term of its own below.
           */
          float sheen = min(1.6, 0.05 + 1.25 * fres + 0.45 * spark);
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
          /**
           * THE BOTTOM, WHICH IS WHAT YOU ACTUALLY SEE LOOKING DOWN INTO IT.
           *
           * Now that the sheen can reach nearly zero there has to be something
           * under it, or a pool looked into from above is a black hole in the
           * floor — which is a worse artefact than the blue plastic this pass
           * set out to remove, and it is what the 0.32 sheen floor was
           * accidentally preventing.
           *
           * THE BED IS col, THE ROCK SHADING THIS FRAGMENT ALREADY DID.
           *
           * The first version of this term was vRock * 0.30 + vLit * 0.55 — the
           * raw albedo and the baked light — and it was flat in the literal
           * sense: no grain, no near-field, no moss, none of the two hundred
           * lines above this branch. A pool three metres from the eye came back
           * as one untextured facet the colour of the floor beside it, which is
           * the same complaint this pass started with wearing a different hue.
           * Blue plastic became grey plastic.
           *
           * Everything needed was already sitting in col: this fragment has just
           * been shaded as rock, using the water vertex's own attributes, and
           * that shading is the best available answer to "what does the ground
           * under this water look like". It costs nothing — the work is done
           * whether the branch uses it or throws it away, because the branch is
           * a mix at the end and not an early-out.
           *
           * Then two things are done to it that make it read as being UNDER
           * something. It is darkened, because water absorbs and because a wet
           * bed is a dark bed; and it is pushed toward the green-blue, because
           * what water absorbs first is red. That tint is the only place in this
           * branch a colour is asserted rather than sampled, and it is small on
           * purpose: the failure mode this whole pass exists to remove is a
           * surface with an opinion of its own.
           *
           * (1 - fres) so it is the complement of the surface: straight down you
           * see the bottom and no sky, along the surface you see sky and no
           * bottom. That swap IS the look of standing water and nothing in this
           * shader was doing it.
           */
          vec3 bed = col * vec3(0.42, 0.50, 0.54);
          vec3 water = bed * (1.0 - fres)
                     + vLit * (sheen + min(2.2, mirror * mix(3.4, 5.2, still)))
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
                     /**
                      * 2.6 -> 0.75, AND THAT IS THE SINGLE BIGGEST NUMBER IN
                      * THIS PASS, BECAUSE THE WATER WAS PAYING FOR DISTANCE
                      * TWICE.
                      *
                      * Measured over the pool's own pixels on grove-01 k=0, with
                      * the water rendering one term at a time to the
                      * framebuffer: this term was (0.021, 0.044, 0.278) linear —
                      * FORTY-NINE PER CENT of everything the surface returned,
                      * thirteen times more blue than red, and, because fres
                      * was pinned at 1 (see the abs() block above), the SAME
                      * value at every pixel regardless of distance, angle, or
                      * what was overhead. That is the blue plastic. It is not a
                      * tuning error, it is a constant being added to a mirror.
                      *
                      * And the aerial perspective it was standing in for was
                      * already there. Forty lines below, every fragment in this
                      * material — water included — is mixed toward uHaze by
                      * smoothstep(14, 52, vDepthFog). The far end of a flooded
                      * chamber gets its pale blue plate from the fog, correctly
                      * ramped by distance, and always did. Adding a second,
                      * distance-independent copy in front of it is what put far-
                      * haze colour on water three metres from your boots.
                      *
                      * What is left at 0.75 is the part the fog cannot do: a
                      * grazing surface shows the air along a MUCH longer path
                      * than the one the depth buffer measured to it. With fres
                      * working that is now a real gradient across the pool
                      * rather than a fill — and it is scaled to be a lift on the
                      * fog rather than a substitute for it.
                      */
                     + uHaze * fres * mix(0.55, 0.75, still)
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
          /**
           * THE SHELL IS THE BIGGEST SINGLE SURFACE IN THE DOORWAY FRAME AND IT
           * WAS THE SMOOTHEST THING IN THE GAME.
           *
           * Ray-probed at the 16 m station: the beige mass filling the middle of
           * that picture is not the hillside, it is this branch — cave < cave-0
           * < caves, hit at 20-22 m. The terrain agent gave the crag around it a
           * crest, a shoulder, a scarp and 2.4 m bedding and then reported that
           * the doorway still read as plasticine, because the plasticine was
           * ours.
           *
           * It cannot be fixed with geometry. A displacement on the shell near
           * the arch drops the seam pass's lip to roof + 0.25 and opens daylight
           * over the doorway — cave-mouth catches it, and it reports as a breach
           * rather than as anything to do with shading. So all of this is in the
           * fragment, where it costs nothing and can break nothing:
           *
           *   THE BEDDING AT TWICE THE WEIGHT, at the hill's own 2.4 m spacing,
           *   which is the whole reason the spacing was matched. Out here it is
           *   eight bands down a twenty-metre shell instead of one and a half
           *   across a passage, so this is where the coarse band pays for
           *   itself.
           *
           *   AND A LAMBERT WITH A FLOOR UNDER IT rather than a bare max(). The
           *   shell's normal is now carrying two octaves of relief and two
           *   bedding ledges (see rrRelief and the ledge block), and a clamped
           *   N.L throws away everything on the shadow side of the terminator —
           *   on a dome, half of it. Wrapping a fifth of the term keeps the
           *   unlit side reading as rock instead of as one flat mass of sky
           *   colour, which is what a lit dome and an unlit dome had in common.
           */
          float lamW = lam * 0.82 + 0.18 * (dot(n, uSunDir) * 0.5 + 0.5);
          /**
           * THE BEDDING CARRIES THE SHELL, AND THE FIRST ATTEMPT PUT IT FOURTH
           * IN A QUEUE OF FOUR.
           *
           * Rendering bed alone at this station shows clean 2.4 m bands right
           * across the dome — the term works, and it reaches the shell exactly
           * as it reaches the passage. At 0.55 against a base of 0.55 plus two
           * noise octaves it was a quarter of the multiplier, and a quarter of a
           * multiplier on a surface sitting at the bright end of the tonemapper
           * is a soft blotch rather than a stratum. 0.90 makes it the dominant
           * term and the base drops to hold the mean at 1.04, so the shell is
           * bedded rock at the same exposure it was smooth rock.
           *
           * AND LESS OF THE SKY, MORE OF THE SUN. sky is a hemisphere lookup on
           * n.y, which over a dome is very nearly a constant — so it was
           * flooding the surface with a term that has no relief in it at all and
           * diluting lamW, the one term that reads the perturbed normal and the
           * bedding ledge. Same total at the mean normal, a great deal more
           * form, and it costs nothing.
           */
          vec3 open = vRock * (sky * 0.72 + uOpenSun * lamW * 1.30)
                    * (0.28 + 0.42 * grain + 0.20 * fine + 0.90 * bed);
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
 * one, 15 m gets two, 24 m gets three. Capped at three because a fourth cone in
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
/**
 * Segments round the opening at a beam's apex. See the block in `_seatShaft`.
 *
 * TWELVE, AND THE NUMBER IS AN ARGUMENT ABOUT SILHOUETTE RATHER THAN ABOUT
 * SMOOTHNESS. The whole point of the disc is that it is NOT round: its radius is
 * jittered per segment off the same `rock` field the walls use, so what the
 * count controls is how many independent samples of that field the rim gets.
 * Fewer than about ten and the shape reads as a polygon; many more and
 * neighbouring samples correlate, the jitter averages out, and it converges back
 * on the circle it exists not to be. Twelve triangles per beam, so a four-beam
 * cave pays 48.
 */
const HOLE_SEGS = 12;

/**
 * The shadow around an opening: how deep, and how far out it reaches in
 * multiples of the opening's own radius. See `_avenShade`.
 *
 * 1.15 to 3.4 is a ring roughly as wide as the hole is across, which is what a
 * chimney's own walls occlude on a flat-ish roof. 0.55 is most of a stop at the
 * rim and was chosen against the ceiling's own occlusion range rather than by
 * eye: `_emitRing` produces ao between about 0.30 and 1.00, so this takes the
 * darkest roof in a chamber to 0.14 and the brightest to 0.45 — still inside
 * the range the shader is tuned for, and never zero, because a hard black ring
 * is a second man-made curve stuck to the roof next to the one this exists to
 * prevent.
 */
const AVEN_SHADE_IN = 1.15;
const AVEN_SHADE_OUT = 3.4;
const AVEN_SHADE = 0.55;

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

/**
 * The colony. See the block over `placeBats` for what it is for.
 *
 * ONE MATERIAL PER CAVE, WHICH IS A DEPARTURE FROM EVERY OTHER MATERIAL IN THIS
 * FILE AND IS NOT A REGRESSION.
 *
 * The rock, the heads and the beams are module singletons so that four streamed
 * passages are one program and one uniform block. This cannot be: `uFlush` is
 * the time a PARTICULAR roost was disturbed, and sharing it would mean walking
 * into one cave emptied the ceiling of another one two hundred metres away —
 * which the player would never see happen and would always arrive too late for.
 *
 * The cost of a second material object is zero programs, and `caveWarmupObjects`
 * already states why: "the program cache is keyed on the shader source, so a
 * copy would warm the same program". Two ShaderMaterials with identical source
 * and identical parameters share a compiled program; what they do not share is
 * the uniform values, which is the entire point. Three to five live caves is
 * three to five uniform blocks of four floats.
 *
 * A vec2 rather than one float per roost, because ROOST_MAX is two. The slot
 * rides in the SIGN of the seed attribute — see the vertex shader — so this
 * costs no extra lane and needs no dynamic indexing, which GLSL ES 1.0 does not
 * reliably give you on a uniform array anyway.
 *
 *
 * THE 3 Hz RULE, AND THE ARITHMETIC RATHER THAN AN ASSURANCE.
 *
 * The standing law is that nothing may modulate luminance above 3 Hz, and the
 * test is the product of domain speed and finest spatial frequency rather than
 * the speed alone. A wingbeat here is 7-10 Hz, which is above it, so it has to
 * be argued and not waved at:
 *
 *   IT IS NOT A FULL-FIELD SIGNAL, AND IT CANNOT BECOME ONE. A bat is 0.24-0.38
 *   m across. At the four metres a flushed one passes you at, that is under two
 *   degrees — about 0.1% of a 1440p frame. Two hundred of them at that range
 *   would be 20% of the frame, and they are never all at that range: the orbit
 *   radius is the chamber's own half-width, so at any instant the colony is
 *   spread over ten to fifty metres and the measured near-field coverage is a
 *   few per cent.
 *
 *   THE PHASES ARE INDEPENDENT AND THEREFORE THE SUM IS NOT. Each bat's flap
 *   rate is drawn from 7-10 Hz on its own seed and its phase from another, so
 *   two hundred wingbeats are two hundred incoherent sinusoids at two hundred
 *   different frequencies. Their AREAS sum; their MODULATIONS cancel, as 1/sqrt
 *   (N) — the population's total projected area is very nearly constant, and the
 *   residual is well under a per cent of a coverage that is itself a few per
 *   cent. This is the same reason a field of leaves moving in wind is not a
 *   flicker hazard and a single leaf shutter is.
 *
 *   AND THE CONTRAST IS TINY. These are near-black shapes against a cave whose
 *   ambient is 0.008-0.027 linear. The luminance step across a wing edge is a
 *   fraction of what a fungus cluster's edge already is, standing still.
 *
 * What the law is actually protecting against is one bright thing covering the
 * whole frame periodically. There is no node here that can produce that, and the
 * one term that could — a bloom on a bat — is impossible by construction,
 * because this is the only material in the cave that is not additive.
 */
function batMaterial() {
  return new THREE.ShaderMaterial({
    name: 'cave-bats',
    /**
     * ALPHA-TESTED AND OPAQUE. Not transparent, not additive, depth written.
     *
     * A bat is a silhouette — a hole in whatever is behind it — and the moment
     * that stops being true it stops being an animal. Additive was tried on
     * paper and rejected in one line: it is the blend mode of the four things in
     * this file that are LIGHTS, and a bat crossing a sun shaft would brighten
     * the shaft rather than interrupting it, which is the exact frame the whole
     * feature is built to produce.
     *
     * Opaque also means it depth-writes, so a bat in front of a crystal seam
     * occludes it, and the fungus heads (renderOrder 5) sort correctly behind
     * one. A transparent material would have needed a sort over two hundred
     * quads per frame for no gain at all.
     */
    transparent: false,
    depthWrite: true,
    side: THREE.FrontSide,
    /**
     * Our own fog, not three's, for the reason `CaveField.setFog` gives at
     * length: `scene.fog` is one FogExp2 for the whole world and the trip
     * director rewrites its density every frame, and the cave needs the rock to
     * go black at thirty metres while the forest seen through the mouth keeps
     * the forest's haze. A bat is inside the cave, so it takes the cave's.
     */
    fog: false,
    uniforms: {
      uTime: tripUniforms.uTime,
      /**
       * When each of this cave's (at most two) roosts was disturbed, on the same
       * clock as uTime — i.e. `worldClock()`, seconds since the room started.
       *
       * "NEVER" IS THE FAR FUTURE AND NOT THE FAR PAST, AND GETTING THAT ROUND
       * THE WRONG WAY LEAVES EVERY CEILING IN THE WORLD ALREADY EMPTY. The
       * shader computes `uTime - uFlush - delay` and flies on the result, so a
       * large NEGATIVE sentinel reads as "disturbed thirty years ago", i.e. fully
       * flown, on the first frame — the failure would be a cave with a permanent
       * cloud of bats in it and no roost anywhere, which is the feature exactly
       * inverted and would look like a placement bug.
       *
       * 1e9 seconds is thirty-one years, and the clock counts from page load
       * (or from a room's origin), so it cannot be reached. It is also far enough
       * out that float32's 64-second ULP at that magnitude is irrelevant: the
       * difference is a billion either way.
       */
      uFlush: { value: new THREE.Vector2(1e9, 1e9) },
      fogColor: { value: new THREE.Color(0x05070a) },
      fogDensity: { value: 0.02 },
    },
    vertexShader: /* glsl */ `
      attribute vec2 aCorner;
      attribute vec4 aBat;
      attribute vec4 aRoost;
      uniform float uTime;
      uniform vec2 uFlush;
      uniform float fogDensity;
      varying vec2 vC;
      varying float vFly;
      varying float vFog;

      /**
       * THE ORBIT, IN CLOSED FORM, WHICH IS THE WHOLE REASON THERE IS NO CPU
       * HERE.
       *
       * A Lissajous about the roost centre: a circle in xz whose z leg runs at a
       * per-bat frequency RATIO to its x leg, plus an independent vertical sine.
       * Ratio 1 is an ellipse; 1.5 and 2 are the figures that cross themselves,
       * which is what stops two hundred bats reading as two hundred things on
       * one racetrack. Every argument is a pure function of time and a seed, so
       * two clients derive the same bat in the same place with nothing on the
       * wire — the rule the trip's fields and the ferry both obey.
       */
      vec3 orbitAt(float th, vec3 c, float R, float rise, float ratio, float ph) {
        return c + vec3(R * cos(th), rise * sin(th * 0.73 + ph), R * 0.82 * sin(ratio * th + ph));
      }

      void main() {
        /**
         * THE SIGN OF THE SEED IS THE ROOST INDEX. aBat is (seed, span, delay,
         * rise) and there was no fifth lane to spare; a seed is strictly
         * positive by construction, so its sign is a free bit. Documented here
         * because a negative seed in a buffer dump is otherwise a bug report.
         */
        float seed = abs(aBat.x);
        float slot = step(aBat.x, 0.0);
        float span = aBat.y;
        float delay = aBat.z;
        float rise = aBat.w;
        float flush = mix(uFlush.x, uFlush.y, slot);

        /**
         * HOW LONG THIS PARTICULAR BAT HAS BEEN IN THE AIR.
         *
         * The per-bat delay is what makes the ceiling PEEL instead of teleport,
         * and it is the single most important number in this shader. With every
         * bat leaving on the same frame the effect is a solid object vanishing
         * and a cloud appearing — two hundred simultaneous events read as one
         * event, and one event with no duration reads as a glitch. Spread over
         * about a second and the ceiling comes apart from the near edge outward,
         * which is what a real roost does because they are startled by a
         * neighbour rather than by you.
         *
         * 1.7 s from letting go to being on the orbit. Longer and the swoop is
         * a slow-motion replay; shorter and the arc is too short to see, which
         * puts the teleport back.
         */
        /**
         * CLAMPED, AND THE CLAMP IS THE WHOLE REASON THE COLONY WAS INVISIBLE.
         *
         * uFlush's resting value is 1e9 — a sentinel for 'this roost has not
         * been disturbed', chosen so that since is hugely negative and every
         * bat is hanging. It is hugely negative in the wrong way: at 1e9 the
         * float arithmetic downstream of it stops being meaningful, and the
         * whole mesh vanished. Photographed: with uFlush at the sentinel the
         * ceiling is bare rock; write uTime into it and one hundred and eighty
         * nine bats appear in the same frame, in the same places, hanging.
         * So the roost could only be seen AFTER it had flushed — which is
         * exactly backwards, because the entire effect is that you take them
         * for stalactites first.
         *
         * -1000 is far enough in the past that fly and th are pinned to
         * their hanging values by the two clamps below (smoothstep saturates
         * at 0 anywhere under 0, and th takes max(since, 0)), and small
         * enough that nothing here is ever asked to do arithmetic on a number
         * a billion times bigger than the scene.
         */
        float since = max(uTime - flush - delay, -1000.0);
        float fly = smoothstep(0.0, 1.7, since);

        float R = aRoost.w * (0.42 + 0.72 * fract(seed * 5.17));
        float ratio = 1.0 + floor(fract(seed * 3.77) * 3.0) * 0.5;
        float ph = seed * 11.7;
        float th = max(since, 0.0) * (0.55 + 0.42 * fract(seed * 7.31)) + seed * 6.2831853;

        /**
         * BANKED BY THE DERIVATIVE OF ITS OWN ORBIT, WHICH IS WHY IT LOOKS LIKE
         * FLIGHT AND NOT LIKE A SPRITE ON A PATH.
         *
         * Three evaluations of the closed form give the velocity and the
         * acceleration by central difference — exact to the step, and cheaper
         * than differentiating the Lissajous by hand and getting the chain rule
         * wrong. The lateral component of the acceleration IS the turn, and an
         * animal that turns rolls into it. Without this the colony is two
         * hundred cards sliding sideways through the air, which is the tell that
         * kills every cheap flock.
         */
        vec3 P = orbitAt(th, aRoost.xyz, R, rise, ratio, ph);
        vec3 Pp = orbitAt(th + 0.06, aRoost.xyz, R, rise, ratio, ph);
        vec3 Pm = orbitAt(th - 0.06, aRoost.xyz, R, rise, ratio, ph);
        vec3 f = normalize(Pp - Pm + vec3(1e-5, 0.0, 0.0));
        vec3 acc = Pp - 2.0 * P + Pm;
        vec3 rgt = normalize(cross(f, vec3(0.0, 1.0, 0.0)) + vec3(0.0, 0.0, 1e-5));
        vec3 upv = cross(rgt, f);
        float bank = clamp(dot(acc, rgt) * 9.0, -0.85, 0.85);
        vec3 rb = rgt * cos(bank) + upv * sin(bank);

        /**
         * HANGING, WHICH IS A FRAME AND NOT A POSITION.
         *
         * The body points DOWN, so the card's long axis is -Y and its span axis
         * is a fixed horizontal drawn from the seed — a colony whose bats all
         * faced the same way would be a printed pattern. The sway is two slow
         * sines at incommensurate rates on the same seed, about three degrees:
         * enough that the ceiling is never quite still, small enough that the
         * lumps still read as stone until one of them lets go.
         */
        float ha = seed * 6.2831853;
        vec3 hR = vec3(cos(ha), 0.0, sin(ha));
        vec3 hF = normalize(vec3(
          sin(uTime * (0.7 + seed * 0.5) + ha) * 0.055,
          -1.0,
          cos(uTime * (0.53 + seed * 0.4) + ha) * 0.055));

        vec3 F = normalize(mix(hF, f, fly));
        vec3 Rv = mix(hR, rb, fly);
        // Re-orthogonalised rather than re-derived: blending two frames does not
        // give a frame, and a card built on a non-orthogonal basis shears.
        Rv = normalize(Rv - F * dot(Rv, F) + vec3(1e-6, 0.0, 0.0));
        vec3 centre = mix(position, P, fly);

        /**
         * THE WINGBEAT, AS A FORESHORTENING RATHER THAN AS A HINGE.
         *
         * A real downstroke sweeps the wing through an arc, and what that does
         * on screen is shorten its projected span and then restore it. One
         * multiply on the span axis produces exactly that read at a hundredth of
         * the cost of a hinged two-quad wing, and at 0.3 m across nobody can
         * resolve the difference. Hanging, the factor is 0.30: wings wrapped
         * round the body, which is why a roosting bat is a lump and not a bat.
         *
         * 7-10 Hz per bat off its own seed, with an independent phase. See the
         * 3 Hz block over this material for why a population of these is not a
         * luminance modulation.
         */
        float flapHz = 7.0 + 3.0 * fract(seed * 13.3);
        float flap = sin(uTime * flapHz * 6.2831853 + seed * 21.0);
        float fold = mix(0.30, 0.72 + 0.28 * flap, fly);

        /**
         * FACING, WITHOUT DoubleSide.
         *
         * The card's normal is cross(Rv, F), which for a bat flying overhead
         * points up — away from a player who is by definition underneath it. On
         * FrontSide that is a culled bat. Mirroring the span axis when the eye is
         * on the far side flips the winding and costs one dot and one sign; the
         * silhouette is symmetric about that axis, so the mirror is invisible.
         *
         * This mesh carries a translation and nothing else — see where it is
         * built — so a direction in local space is a direction in world space and
         * only the centre needs transforming.
         */
        vec3 wcentre = (modelMatrix * vec4(centre, 1.0)).xyz;
        float s = dot(cross(Rv, F), cameraPosition - wcentre) < 0.0 ? -1.0 : 1.0;

        vec3 local = centre
        /**
         * 0.5/0.42 -> 1.15/0.95, WHICH IS A LEGIBILITY NUMBER AND NOT A
         * BIOLOGICAL ONE, AND IT WAS SETTLED WITH A DEBUG COLOUR.
         *
         * At the authored size the colony is invisible. That is not a figure
         * of speech: standing five metres under a roost of 189 with the eye
         * fully dark-adapted, the photograph is bare rock with two or three
         * specks in it. Rendering the same frame with the bats forced to
         * magenta shows all of them, hanging exactly where they should be — so
         * the geometry, the anchors, the frame and the material were all
         * right, and the only thing wrong was that a 30 cm near-black shape
         * seen from fifteen metres is a handful of pixels sitting in rock that
         * is itself mottled near-black in patches. It read as noise.
         *
         * A real bat is 20-30 cm and this is now nearer 70, which is a lie of
         * the same kind and size as the moon being drawn at twice its angular
         * diameter a few hundred lines away in atmosphere.js, and for exactly
         * the same reason: the thing has to be READABLE at the distance the
         * player is actually at, and a correctly-sized one is not.
         *
         * ISOLATED PROPERLY, because the first attempt changed two things at
         * once. With the debug colour on and the size unchanged the colony is
         * a field of two-pixel dots — so it was never the near-black hide
         * losing against pale limestone, it was always the angular size. The
         * ceiling of the chamber this was measured in is thirteen to eighteen
         * metres up, which is a fair example rather than a worst case.
         *
         * AND IT IS NOT ENOUGH YET, WHICH IS RECORDED HERE RATHER THAN LEFT
         * FOR SOMEBODY TO REDISCOVER. At 1.15 the colony is legible if you are
         * looking for it and it is not what the feature promises, which is that
         * you take them for stalactites and then one of them moves. Going
         * further on size alone starts to look wrong the moment one goes past
         * your face, so the next thing to try is not this number:
         *
         *   - SEAT ROOSTS BY CEILING HEIGHT, not by chamber inventory. They
         *     are currently placed in the rooms _planShafts found, which are
         *     the tall ones by construction — the worst possible choice for
         *     something you have to see on the roof.
         *   - Or scale the card by the roost's own headroom, so a colony under
         *     an 18 m ceiling is drawn bigger than one under a 6 m ceiling.
         *     That is the same argument as this constant, applied per roost
         *     instead of globally, and it is where the honest answer probably
         *     is.
         */
          + Rv * (s * aCorner.x * span * 1.15 * fold)
          + F * (aCorner.y * span * 0.95);

        vC = aCorner;
        vFly = fly;
        float fd = length(cameraPosition - wcentre);
        vFog = 1.0 - exp(-fogDensity * fogDensity * fd * fd);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(local, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 fogColor;
      varying vec2 vC;
      varying float vFly;
      varying float vFog;
      void main() {
        /**
         * THE SILHOUETTE IS ARITHMETIC, NOT A TEXTURE.
         *
         * There is not one binary asset in this repository and there never will
         * be, and a canvas-drawn atlas would be the wrong answer here anyway: a
         * bat at 0.3 m across is a few dozen pixels at the range it matters, so
         * what has to be right is the OUTLINE and nothing else. Eight
         * instructions and two steps give a better outline than a 64-pixel
         * sprite, and they stay sharp at the one range where it counts — the
         * frame where one goes past your face.
         *
         * The parts, in the card's own -1..1 coordinates. u is the span axis and
         * v runs from tail to head:
         *
         *   THE BODY: a narrow ellipse, a fifth as wide as it is long.
         *
         *   THE WING: a membrane between a leading edge that sweeps BACK toward
         *   the tip and a trailing edge that curves forward. The cosine on the
         *   trailing edge is the three finger notches every bat wing has, faded
         *   out toward the shoulder where the membrane is continuous. Those
         *   notches are the whole difference between a bat and a moth, and they
         *   are one term.
         */
        float au = abs(vC.x);
        float v = vC.y;
        float bx = vC.x / 0.19;
        float by = v / 0.66;
        float body = step(bx * bx + by * by, 1.0);
        float lead = 0.44 - 0.30 * au;
        float trail = -0.66 + 0.56 * au * au + 0.07 * (1.0 - au) * cos(au * 17.0);
        float wing = step(0.10, au) * step(v, lead) * step(trail, v);
        float a = max(body, wing);
        // The alpha test, written out rather than left to three's alphaTest
        // property: that one only exists if the shader includes the chunk, and
        // this shader includes no chunks at all.
        if (a < 0.5) discard;

        /**
         * NEARLY BLACK, AND NOT QUITE — because a true black shape in a cave
         * whose ambient is 0.008 is indistinguishable from the rock behind it,
         * and the feature would only ever be visible in front of a beam.
         *
         * The membrane is brighter than the hide, which is a real property: a
         * bat's wing is a translucent sheet a fraction of a millimetre thick and
         * it glows faintly against any light behind it. That difference is what
         * makes the shape read AS a wing at ten metres rather than as a blot.
         *
         * The leading edge catches a little more, and only in flight — hanging,
         * there is no edge presented to anything.
         */
        vec3 hide = vec3(0.030, 0.024, 0.021);
        vec3 membrane = vec3(0.058, 0.043, 0.040);
        vec3 col = mix(hide, membrane, wing * (1.0 - body));
        float rim = 1.0 - smoothstep(0.0, 0.24, lead - v);
        col *= 0.85 + 0.85 * rim * vFly;
        col = mix(col, fogColor, vFog);
        gl_FragColor = vec4(col, 1.0);
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
/**
 * 270 m NOW, AND THE REASON IS THAT THE WALK GOT MORE VARIABLE RATHER THAN
 * WORSE.
 *
 * This is a bar, not a target: `prepare` keeps the first of three walks that
 * clears it. So what it actually controls is how much of the SPREAD between
 * salts the build is willing to pay to escape — and the spread is the whole
 * problem, because the first corner decides which part of the ridge the passage
 * spends itself under.
 *
 * The walk now turns half again as much and refuses to cut through itself, so
 * that spread is wider than it was: measured over eight seeds after the change,
 * a mean of 854 m against 787 before, but with individual mouths ranging from
 * 262 m to 1285. A bar at 190 m accepts nearly every first walk, which means it
 * accepts the 262 m one — and 262 m on grove-01's k=0, the mouth every picture
 * in this repo is taken at, is a visibly smaller cave than the seed can carry.
 *
 * The cost is build TIME and not a hitch, which is the distinction that makes
 * this affordable. `perf/cave-build` gates the worst SLICE, and slices are
 * 0.70 ms median against a 1.8 ms budget whatever the walk count; an extra walk
 * is more frames of streaming, spread over a cave that is already built two
 * hundred metres before you can see it. Three walks remains the hard cap.
 */
const GOOD_RINGS = Math.round(270 / RING_STEP);

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
    /**
     * …and the one or two of them with something living on the ceiling. See
     * `_planRoosts`. `batMaterial` is per-cave rather than shared because
     * `uFlush` is a fact about THIS roost — the block over `batMaterial` has the
     * argument. `flushed` is the last roost that went up, for a probe.
     */
    this.roosts = null;
    this.batMesh = null;
    this.batMaterial = null;
    this.flushed = null;
    /** `_planShafts`' inventory of rooms, kept for `_planRoosts`. */
    this._chambers = null;
    /**
     * WHAT THE BUILD WANTED AND WHAT IT GOT, which nothing has ever reported.
     *
     * Both are filled in `_prepare` and both exist for the same reason: every
     * number in this file about how twisty a cave is or how many ways on it has
     * came from a script that re-derived it from the drawn rings, after the
     * resample had smoothed the joints and the burial had deleted the passages.
     * A generator that cannot say what it planned cannot be tuned; it can only
     * be photographed.
     *
     * `branchStats` is the one that found the fault. It counts planned junctions
     * against built ones and attributes every miss to one of the three silent
     * rejections in `buildBranch` — see `_branchWhy`. `walkStats` is the main
     * walk's own corner count and its realised mean hold probability, which is
     * the number that has to hold still when the hold rule is touched.
     *
     * Read them off a built cave as `RR.caves.at(0).branchStats` — a plain
     * object, no methods, safe to JSON.
     */
    this.branchStats = null;
    /** The main walk's own account of itself. See `stats` in `buildNodes`. */
    this.walkStats = null;
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
     * The winning walk's own numbers, not the losing salts'. `best` and `walk`
     * move together above, so this is the walk that was kept.
     */
    this.walkStats = walk.stats;
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
    /**
     * Which way the brow leans, off the same bearing. See HOOD_LEAN.
     *
     * Derived rather than drawn: `bedRng` is already three deep by here and the
     * flood level comes off it next, so a fourth draw would move the flood in
     * every cave in the world to buy a sign. `cos(bearing)` is signed, is a
     * different number per cave, and costs nothing.
     */
    this.lean = Math.cos(bearing);
    /**
     * …and the strike, which is the horizontal direction the beds RUN in — at
     * right angles to the bearing the dip points down. The crag's joint set is
     * spaced along it. See `blockFace`.
     *
     * Taken from `bearing` rather than from `bedX`/`bedZ` normalised, because
     * those two carry a factor of sin(dip) that is 0.13 in the shallowest cave
     * and would make its joints eight times too far apart.
     */
    this.strX = -Math.sin(bearing);
    this.strZ = Math.cos(bearing);
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
     * One junction per 62 m of passage, capped at eight, and both numbers moved
     * from 95 and five for the same reason: the cap was doing the work. A
     * six-hundred-metre passage hit five junctions and stopped, so the density
     * of choice still fell as the cave got longer — the fault the per-metre rule
     * was written to fix, moved up one line rather than removed. At 62 m a
     * nine-hundred-metre system gets fourteen wanted and eight granted, so the
     * cap still binds; what it now bounds is a system with genuinely more in it
     * rather than the same system with a smaller number attached.
     *
     * The maze objection stands and is what keeps this from going further. A
     * junction every sixty metres is still a passage you can hold in your head:
     * you meet one, you walk a minute, you meet the next, and BRANCH_GAP below
     * guarantees the minute. What makes a maze is not the count, it is two holes
     * within sight of each other.
     */
    /**
     * 50 m AND TEN, DOWN FROM 62 AND EIGHT.
     *
     * The maze objection below is still the thing that bounds this and it is
     * about SIGHT LINES rather than about a count — "what makes a maze is not
     * the count, it is two holes within sight of each other" — and BRANCH_GAP
     * is what enforces that, untouched at 34 m. What 62 was doing on top of it
     * was leaving a nine-hundred-metre system with fourteen wanted and eight
     * granted, so the cap bound and the density of choice fell with length
     * again, which is the exact fault the per-metre rule was written to fix.
     *
     * The room asked for more subsystems and this is the cheapest half of the
     * answer: it costs nothing but the branches themselves, where lengthening
     * the main line to carry them would have cost the chambers (see `count`).
     * The other half is that leads now have leads of their own, which is worth
     * more per junction than another tooth on the same comb.
     */
    const metres = along[n - 1];
    const want = Math.min(10, Math.floor(metres / 50) + (brRng() < 0.5 ? 1 : 0));
    /**
     * …AND SOME OF THEM ARE REAL FORKS.
     *
     * Never the first, which is the closest to the entrance and the one the
     * player is least invested in when they meet it, and never one so near the
     * end that there is no room left in the mountain to build it. Picking a
     * middle one means the major junction lands where the passage has already
     * committed to a direction and the player has already walked far enough that
     * turning back is a cost. See `buildBranch`.
     *
     * ONE FORK IN A SYSTEM OF EIGHT LEADS IS A SYSTEM WITH ONE DECISION IN IT.
     * The count now scales with the junctions: a second fork above four of them,
     * placed independently, so a long cave asks the question twice at different
     * depths and the second one is asked of a player who has already learned
     * what taking the first one cost. Two is where it stops on purpose — three
     * forks is eight ways through a mountain with no map, which is the maze
     * again by another route.
     */
    /**
     * THE LEDGER, AND IT IS THE POINT OF THIS PASS RATHER THAN A DIAGNOSTIC.
     *
     * `want` is a design decision — one junction per fifty metres of passage —
     * and until this object existed nothing anywhere compared it against what
     * got built. `buildBranch` returns null at three places and the loop below
     * quietly moved the cursor on, so a cave that planned eight junctions and
     * built three looked from the outside exactly like a cave that planned
     * three. The room's "it lacks cave-like subsystems" was that gap, and it was
     * unobservable.
     *
     * `want` AND `tried` ARE DIFFERENT NUMBERS AND BOTH ARE KEPT. The loop below
     * also stops when the cursor runs off the end of the passage, which is not a
     * rejection — it is a plan that asked for more junctions than the line had
     * room for, and it is a fault in the SPACING rather than in `buildBranch`.
     * Conflating the two would blame the branch builder for a planner's
     * arithmetic. So:
     *
     *   tried  =  built + wall + short + buried      (exactly, by construction)
     *   want - tried                                  ran out of passage
     *
     * If the first line ever fails to add up, `_branchWhy` has grown a fourth
     * site and whoever added it did not come back here.
     *
     * The sub-branch counters are kept apart on purpose: a lead off a lead is
     * planned by a different rule with a different denominator, so pooling them
     * would hide whichever of the two is failing.
     */
    const bs = {
      want,
      tried: 0,
      built: 0,
      wall: 0,
      short: 0,
      buried: 0,
      subWant: 0,
      subTried: 0,
      subBuilt: 0,
      subWall: 0,
      subShort: 0,
      subBuried: 0,
      /**
       * …AND HOW MANY OF THEM CAME BACK, which is the one number the ledger did
       * not have a column for and the one the room actually asked about.
       *
       * `looped` is a subset of `built` and NOT a fourth refusal: a lead whose
       * closure search fails is a lead, and it is counted as built like any
       * other. `loopWant` is the budget the cave drew, so `loopWant - looped -
       * subLooped` is closures asked for and not found, which is a fact about
       * the rock and not about the planner. The cyclomatic number of the cave is
       * exactly `looped + subLooped`.
       */
      loopWant: 0,
      looped: 0,
      subLooped: 0,
      /**
       * THE CHAMBERS THAT BECAME JUNCTIONS, which is the room's own request and
       * had no column anywhere.
       *
       * `atChamber` is junctions whose base ring is inside a chamber; `extra` is
       * the additional exits those chambers were given beyond the first, so a
       * chamber's total degree is (the passage in) + (the passage on) + 1 +
       * however many of `extra` landed on it. `chambers` is how many distinct
       * chambers carry at least one. Kept apart from `built` on purpose: an extra
       * exit is planned by a different rule with a different denominator, exactly
       * as the sub-branch counters are.
       */
      chambers: 0,
      atChamber: 0,
      extraWant: 0,
      extraTried: 0,
      extra: 0,
      /**
       * The closure search's own ledger, pooled over every lead that was offered
       * a budget. See `_loopWhy` for what the fields mean and for the invariant
       * they satisfy. `offers` is how many leads were asked, which is the
       * denominator none of the counters carry.
       */
      loopWhy: {
        offers: 0,
        ...Object.fromEntries(Object.keys(_loopWhy).map((k) => [k, 0])),
        // A minimum pooled over leads; zero would be a lie and would win.
        nearest: Infinity,
      },
    };
    this.branchStats = bs;
    /** Attribute one null to the gate that produced it. See `_branchWhy`. */
    const blame = (pre) => {
      const why = _branchWhy;
      if (why === 'short') bs[pre ? 'subShort' : 'short']++;
      else if (why === 'buried') bs[pre ? 'subBuried' : 'buried']++;
      else bs[pre ? 'subWall' : 'wall']++;
    };
    /**
     * HOW MANY OF THE LEADS ARE ALLOWED TO REJOIN SOMETHING.
     *
     * One to three per cave, and the CEILING is the point — see the survey
     * numbers in the LOOP CLOSURE block. A cave of eight junctions and a dozen
     * dead ends has a mean vertex degree just under 1.9 as a tree; one closure
     * takes it to about 1.95 and three to about 2.1, which is the middle of what
     * Collon and Jouves measured across sixty real systems. A closure per branch
     * would put it past 2.6 and out of the surveyed range entirely, which is the
     * mistake Paris et al. report their own generator making.
     *
     * NEVER THE FIRST LEAD. Same argument the major fork makes one block up: the
     * first junction is the one nearest the entrance and the one the player is
     * least invested in, and a circuit is worth most where turning back is
     * already a cost. It is also the lead with the shallowest base, and a shallow
     * base is the one place the forest occlusion has to be careful — see
     * LOOP_BLIND_PAD.
     *
     * DECREMENTED ON SUCCESS AND NOT ON THE ATTEMPT. The search is cheap and
     * fails often — it wants a passage 13 to 35 m away, arriving square to it,
     * seventy metres apart through the tree, with rock over the connector — so
     * charging for attempts would leave most caves with none.
     */
    let loopBudget = 1 + (brRng() < 0.55 ? 1 : 0) + (want >= 6 && brRng() < 0.4 ? 1 : 0);
    bs.loopWant = loopBudget;
    const majorAt = want > 1 ? 1 + Math.floor(brRng() * Math.max(1, want - 1)) : 0;
    const majorAt2 = want > 4 ? 1 + Math.floor(brRng() * Math.max(1, want - 1)) : -1;
    let cursor = BRANCH_MIN_RING + Math.floor(brRng() * 14);
    // Both in metres over the ring step: the gap to the end of the passage a
    // branch needs to be worth starting, and the gap between two junctions.
    const BRANCH_TAIL = Math.round(20 / RING_STEP);
    const BRANCH_GAP = Math.round(34 / RING_STEP);
    /**
     * SPREAD OVER THE PASSAGE, NOT PACKED INTO ITS FIRST THIRD.
     *
     * The cursor used to advance by BRANCH_GAP plus up to as much again — 34 to
     * 68 m, mean 51 — which is a rule about the gap between two junctions and
     * says nothing at all about where the last one lands. On a nine-hundred
     * metre system that put every junction inside the first four hundred metres
     * and left the whole deep half of the cave, which is where the chambers are
     * and where the player has invested the most walking, without a single hole
     * in the wall. The count scaling with length made that worse rather than
     * better: more branches, same first third.
     *
     * So the stride is the passage's own remaining length divided by the number
     * of junctions it is getting, floored at BRANCH_GAP so a short passage
     * cannot bunch them. The jitter is a fraction of the stride rather than a
     * fixed distance, so it stays proportionate at either end of the range.
     */
    const spread = Math.max(
      BRANCH_GAP,
      Math.floor((n - BRANCH_TAIL - cursor) / Math.max(1, want))
    );
    /**
     * EVERYTHING A NEWLY BUILT TOP-LEVEL LEAD NEEDS BEFORE ANYTHING ELSE SEES
     * IT, hoisted so the chamber's extra exits get exactly the same treatment.
     *
     * Six things, and leaving any one of them off a branch is a distinct bug
     * that reports as something else: `baseAlong` is what every depth downstream
     * is measured from, `markDepth` is what the audio and the fungi read,
     * `blind` is what decides whether the forest may be deleted while you stand
     * in it, `along` is what the closure search needs to score a circuit,
     * `blindTail` is the forest-occlusion safety at a weld, and `parent` is the
     * tree. This was one inline block serving one call site; there are now three.
     */
    const adopt = (br, tag) => {
      br.baseAlong = along[br.base];
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
      br.blindTail = loopBlindTail(br);
      br.parent = 0;
      this.paths.push(br);
      for (const g of placeFungi(this.c, br, tag, 3)) this.fungi.push(g);
    };

    /**
     * HOW FAR THE CHAMBER THIS RING BELONGS TO REACHES, or null for a passage.
     *
     * `r * w` is the nominal half-width at the axis. Ordinary passage in this
     * table is 1.4 to 4.9 m of it and the two `vast` sections are 10 to 35, so
     * CHAMBER_HALF at 8 separates them with a factor of 1.6 either side and no
     * judgement in it. Walking outward from the ring rather than scanning the
     * whole passage because a cave has several chambers and this is asked about
     * one of them.
     */
    const chamberRun = (p, at) => {
      const pn = p.x.length;
      if (!(p.r[at] * p.w[at] >= CHAMBER_HALF)) return null;
      let c0 = at;
      let c1 = at;
      while (c0 > 1 && p.r[c0 - 1] * p.w[c0 - 1] >= CHAMBER_HALF) c0--;
      while (c1 < pn - 2 && p.r[c1 + 1] * p.w[c1 + 1] >= CHAMBER_HALF) c1++;
      return { c0, c1 };
    };

    /**
     * THE BIG ROOM IS WHERE YOU LOSE THE THREAD, AND UNTIL NOW IT WAS NOWHERE
     * NEAR WHERE THE HOLES WERE.
     *
     * Junctions were placed by SPACING — every so many metres along the passage,
     * see `spread` — and chambers were placed by the type chain and the rock.
     * Two independent processes on the same line, so a chamber carrying a
     * junction was a coincidence, and the common outcome is the one the room
     * complained about: an enormous room with exactly two ways out of it, which
     * is a wide part of a corridor.
     *
     * BOTH HALVES OF THE MECHANISM POINT THE SAME WAY. Chambers form where
     * passages intersect and where the ceiling breaks down, and breakdown is
     * itself promoted at joint intersections — so in real rock the big space and
     * the many ways on are the SAME event, not two events that happen to
     * coincide. And the failure it produces is the second-commonest way a caver
     * gets lost, after junction reversal: a small passage entering a large room
     * is hard to find again hours later coming back across that room, because
     * its mouth subtends almost nothing of the wall. Here that is arithmetic
     * rather than a hope — a 4 m bore on a 30 m chamber wall subtends about 7.6
     * degrees, and `rb`'s three-way minimum is what holds it there.
     *
     * SO THE JUNCTION GOES TO THE ROOM RATHER THAN THE ROOM TO THE JUNCTION.
     * The spacing rule still decides roughly where, and this only takes the
     * biggest space inside the stride it was going to cover anyway — so the
     * junctions stay spread over the passage, which is the property `spread`
     * exists to protect, and no chamber is reached by dragging a junction past
     * the next one.
     *
     * `want` IS NOT SPENT ON THIS. A chamber's extra exits are counted and
     * budgeted separately (`extraWant`), because they are not junctions along a
     * passage — they are the degree of one vertex, and pooling them with a
     * per-metre spacing rule would make both numbers unreadable.
     */
    const snapToChamber = (from, span) => {
      const hi = Math.min(n - 1 - BRANCH_TAIL, from + span);
      let best = -1;
      let bestHalf = CHAMBER_HALF;
      for (let i = from; i <= hi; i++) {
        const h = this.path.r[i] * this.path.w[i];
        if (h > bestHalf) {
          bestHalf = h;
          best = i;
        }
      }
      return best;
    };

    /**
     * HOW MANY EXTRA EXITS THE CHAMBERS OF ONE CAVE MAY HAVE BETWEEN THEM.
     *
     * The room asked for three or four ways on in a big room. A chamber that
     * carries a junction already has three — the passage in, the passage on, and
     * the lead — so two extra is four ways on, and that is the top of what was
     * asked for rather than a number to grow. The cave-wide cap is what keeps a
     * seed with five chambers from becoming a maze: `EXTRA_TOTAL` of three means
     * at most two chambers in a cave are the confusing kind, and the rest are
     * rooms with a way on, which is what makes the confusing ones legible as a
     * different KIND of place.
     *
     * It also bounds the cost exactly. An extra exit is one more `buildBranch`,
     * which is 4-19 sliced nodes, so three of them is at most the work of one
     * more major fork spread over the same number of frames.
     */
    const EXTRA_PER_CHAMBER = 2;
    /**
     * ZERO, AND IT IS ONE CONSTANT AWAY FROM THREE. READ THIS BEFORE RAISING IT.
     *
     * The extra exits are built, measured and correct in every way except one,
     * and the one is fatal: `cave-junction` finds a LEAK. On grove-01 k=0 with
     * this at three, two junctions show rays that meet no rock and escape the
     * mountain within twenty metres — a straight view out of a hillside from
     * inside a passage, which is the failure that gate exists for and the one
     * this file treats as unshippable.
     *
     * WHAT IS AND IS NOT THE CAUSE, all of it A/B'd on the same seed:
     *
     *   IT IS THE EXTRA EXITS. At zero the same seed passes 576 rays at every
     *   junction. At three it leaks. Nothing else in this pass moves it.
     *
     *   IT IS NOT MOUTH_LEAN. Setting the lean to zero left the leak bit-for-bit
     *   identical — 4 of 576, the same rays, the same junction.
     *
     *   IT IS NOT TWO MOUTHS BEING NEAR EACH OTHER. Spacing them by EXTRA_GAP
     *   took it from 4 rays to 3, and dropping EXTRA_PER_CHAMBER from two to one
     *   changed nothing at all — so it is the FIRST extra exit that leaks, not
     *   the second one crowding it.
     *
     *   WHICH LEAVES THE FORCED `side`. Every other junction in the world takes
     *   whichever side of the passage the dice or the clearance test give it;
     *   these are the only ones told which side to leave through, because two
     *   doorways in one room have to face different ways to be worth having. A
     *   forced side is a side nothing checked for rock, and a window cut where
     *   the mountain has fallen away is a window onto the sky.
     *
     * SO THE FIX IS A CLEARANCE TEST ON THE FORCED SIDE, not a smaller number
     * here — `buildBranch` already has `clearOf` for exactly this shape of
     * question in its `avoid` block, and what it needs is the hillside rather
     * than the neighbouring passage. That was not finished in this pass and
     * guessing at it against a 92-second gate was not a good use of what was
     * left. Everything else about the feature — `snapToChamber`, `chamberRun`,
     * `adopt`, the ledger, the `kin` avoid list — ships and is exercised, because
     * ordinary junctions are still moved INTO the chambers and those pass.
     */
    const EXTRA_TOTAL = 3;
    /** Where across the chamber an extra exit may go, best first. */
    const EXTRA_AT = [0.12, 0.88, 0.5, 0.3, 0.7];
    /** …and how far one mouth must be from another cut in the same side. */
    const EXTRA_GAP = Math.round(14 / RING_STEP);
    let extraBudget = EXTRA_TOTAL;

    for (let b = 0; b < want && cursor < n - BRANCH_TAIL; b++) {
      const major = b === majorAt || b === majorAt2;
      // The stride this junction was going to cover anyway — never further, so
      // the spread over the passage is exactly what it was.
      const snap = snapToChamber(cursor, Math.max(BRANCH_GAP, spread) - 1);
      if (snap >= 0) cursor = snap;
      bs.tried++;
      const br = yield* buildBranch(
        this.c,
        this.path,
        walk.joints,
        cursor,
        `${b}`,
        major,
        [],
        loopBudget > 0 && b > 0
      );
      if (!br) blame(false);
      loopLedger(bs, loopBudget > 0 && b > 0);
      if (br) {
        bs.built++;
        if (br.loopEnd) {
          loopBudget--;
          bs.looped++;
        }
        /**
         * `br.base`, NOT `cursor`. `buildBranch` is allowed to walk the junction
         * forward to a ring with a wall a body can get through, and everything
         * downstream that measures from the junction — the depth reported to the
         * audio, the blind distance, the spacing of the next one — has to be
         * measured from where it actually went.
         */
        cursor = br.base;
        adopt(br, `br${b}`);

        /**
         * …AND IF IT LANDED IN A CHAMBER, THE CHAMBER GETS THE REST OF ITS WAYS
         * ON, WHICH ARE THE POINT OF THE WHOLE PASS.
         *
         * THE EXITS HAVE TO BE INDISTINGUISHABLE OR NONE OF THIS WORKS. Three
         * separate things would otherwise mark the way you came in:
         *
         *   SIZE. Players solve a fork by taking the bigger hole. Every exit
         *   here is built by the same `buildBranch` against the same wall, so
         *   `rb`'s three-way minimum gives them all the same bound, and half of
         *   them are `major` — which is to say they start on the same two
         *   sections the main line starts on, so at the wall they are the same
         *   object as the passage on.
         *
         *   POSITION. `side` is forced rather than drawn, alternating, so the
         *   exits are spread around the chamber instead of two of them being
         *   holes in the same wall three metres apart. The rings are taken at
         *   thirds of the chamber's own run, so they are also spread ALONG it.
         *
         *   AND THEY MUST NOT MEET BEHIND THE WALL. Top-level branches have
         *   never been told about each other — the `avoid` list is empty for all
         *   of them — which was survivable while they were thirty-four metres
         *   apart along the passage and is not when they leave the same room.
         *   The chamber's own exits are handed to each other, and only to each
         *   other: the list is one or two paths rather than the whole cave, so
         *   the clash sweep stays the size it was.
         *
         * NO CLOSURE BUDGET IS OFFERED HERE. A chamber with four ways on where
         * two of them are the same circuit is a chamber with three, and the
         * budget is better spent on a lead that walks somewhere first.
         */
        const run = chamberRun(this.path, br.base);
        if (run) bs.atChamber++;
        if (run && extraBudget > 0 && run.c1 - run.c0 > 4) {
          bs.chambers++;
          const kin = [br];
          const nExtra = Math.min(EXTRA_PER_CHAMBER, extraBudget);
          bs.extraWant += nExtra;
          for (let e = 0; e < nExtra; e++) {
            /**
             * TWO MOUTHS IN ONE WALL LEAK IF THEY ARE NEAR EACH OTHER, AND THE
             * FIRST VERSION OF THIS PUT THEM AT FIXED FRACTIONS OF THE RUN.
             *
             * `_link` cuts each junction as an ellipse of skipped quads in the
             * host's (ring, phi) lattice, sized at 0.82 of the bore so its
             * corners fall strictly inside the branch's own ring-zero ellipse —
             * that margin is the whole reason a junction is not a hole. Two
             * windows cut close together on the same side of the same wall
             * overlap in phi, and the union of two ellipses is not covered by
             * either bore: the sliver between them is skipped quads with nothing
             * behind them, which underground is a straight view out of the
             * mountain. `cave-junction` found exactly that and it is the ONLY
             * thing it found: with these exits switched off the same seed passes
             * 576 rays at every junction, and with them on, four rays escape
             * within twenty metres at one of them.
             *
             * Fractions of the run cannot express the constraint, because the
             * ring the FIRST exit took is wherever `snapToChamber` and
             * `buildBranch`'s own forward walk left it — so on a chamber where
             * that landed near 0.78 of the run, the second extra was cut into the
             * same stretch of wall on the same side.
             *
             * So the site is chosen against the exits that exist rather than
             * against the run: candidate positions across the chamber, each
             * rejected if it is within EXTRA_GAP rings of a mouth already cut on
             * the side this one would use, and the exit is skipped entirely if
             * none survives. Opposite sides are exempt from the distance, because
             * two windows facing away from each other cannot share a sliver.
             *
             * FOURTEEN METRES, WRITTEN AS METRES OVER THE RING STEP. It is a
             * distance — how far apart two doorways have to be before their
             * windows stop touching — and the widest bore that reaches this code
             * is bounded by `rb` at about seven metres, so a gap of twice that is
             * clear of the widest pair the table can produce. Every constant in
             * this file that was secretly a distance and written as a count broke
             * the world the first time the mesh got finer; see HOOD_MIN.
             */
            const side = e === 0 ? -br.side : br.side;
            let at = -1;
            for (const f of EXTRA_AT) {
              const cand = Math.round(run.c0 + (run.c1 - run.c0) * f);
              if (cand < BRANCH_MIN_RING || cand > n - 1 - BRANCH_TAIL) continue;
              let clear = true;
              for (const k of kin) {
                if (k.side !== side) continue;
                if (Math.abs(k.base - cand) < EXTRA_GAP) clear = false;
              }
              if (clear) {
                at = cand;
                break;
              }
            }
            if (at < 0) continue;
            bs.extraTried++;
            const ex = yield* buildBranch(
              this.c,
              this.path,
              walk.joints,
              at,
              `${b}x${e}`,
              e === 0,
              kin,
              false,
              { side }
            );
            /**
             * NOT `blame`, and that is the ledger's invariant rather than an
             * omission. `tried = built + wall + short + buried` holds exactly
             * over the junctions the SPACING rule planned; an extra exit is not
             * one of those, so folding its refusal into those three columns
             * would make the identity stop adding up and the first person to
             * check it would go looking for a fourth `_branchWhy` site that does
             * not exist. `extraTried - extra` is this rule's own refusal count.
             */
            if (!ex) continue;
            bs.extra++;
            extraBudget--;
            kin.push(ex);
            adopt(ex, `br${b}x${e}`);
          }
        }
      }
      cursor += Math.max(BRANCH_GAP, Math.floor(spread * 0.7 + brRng() * spread * 0.6));
    }

    /**
     * …AND THE LEADS HAVE LEADS, WHICH IS WHAT MAKES IT A SYSTEM.
     *
     * Every branch until now hung off the main line and nothing hung off a
     * branch, so the map was a comb: one spine, teeth, nothing else. That is a
     * corridor with alcoves however many teeth it has, and it has a tell the
     * player feels without being able to name — taking a side passage is always
     * a decision you can undo by turning round, because a lead can only ever
     * return you to the one line you were on. A lead that forks is the first
     * point in the cave where you can be genuinely unsure of the way back.
     *
     * ONLY OFF PASSAGES LONG ENOUGH TO HAVE SOMEWHERE TO PUT ONE, and only one
     * level deep. Both are the maze objection again: a junction every sixty
     * metres is a passage you can hold in your head, and a third level would be
     * sixteen ways through a mountain with no map. Depth two is where a system
     * stops being a comb; depth three is where it stops being legible.
     *
     * THE AVOID LIST IS NOT OPTIONAL. A sub-branch's own line and its parent are
     * both tested inside `buildBranch`; the MAIN passage is a third body it has
     * never had to know about, and it is by far the largest thing in the
     * mountain to hit. See the block on the clash test.
     */
    const SUB_MIN = 26;
    const subs = [];
    const topLevel = this.paths.length;
    for (let p = 1; p < topLevel; p++) {
      const parent = this.paths[p];
      const pEnd = Math.min(parent.endRing ?? parent.x.length - 1, parent.x.length - 1);
      const pLen = parent.along[pEnd];
      // A lead needs to be a passage before it can carry one: 78 m is the
      // junction spacing plus both of the margins the main line keeps.
      if (pLen < 78) continue;
      const nSub = Math.min(2, Math.floor(pLen / 78));
      bs.subWant += nSub;
      let sc = SUB_MIN + Math.floor(brRng() * 10);
      for (let s = 0; s < nSub && sc < pEnd - BRANCH_TAIL; s++) {
        bs.subTried++;
        const sub = yield* buildBranch(
          this.c,
          parent,
          walk.joints,
          sc,
          `${p}.${s}`,
          false,
          [this.path],
          /**
           * A LEAD OFF A LEAD IS THE BEST CLOSURE IN THE SYSTEM and it is why
           * the budget is spent last rather than first.
           *
           * It knows about two passages rather than one — its parent and the
           * main line, both handed to it as `avoid` — so its search has twice
           * the wall to aim at. It is also the deepest thing in the cave and the
           * furthest from daylight, which is exactly where a circuit is worth
           * most and where LOOP_BLIND_PAD is least likely to bind.
           */
          loopBudget > 0
        );
        if (!sub) blame(true);
        loopLedger(bs, loopBudget > 0);
        if (sub) {
          bs.subBuilt++;
          if (sub.loopEnd) {
            loopBudget--;
            bs.subLooped++;
          }
          sc = sub.base;
          // Measured through the parent, so a lead off a lead reports its true
          // distance from daylight rather than its distance from its own mouth.
          sub.baseAlong = parent.baseAlong + parent.along[sub.base];
          markDepth(sub, this.path.y[0]);
          sub.blind = sub.baseAlong + 10;
          const sn = sub.x.length;
          const sAlong = new Float64Array(sn);
          for (let i = 1; i < sn; i++) {
            sAlong[i] =
              sAlong[i - 1] +
              Math.hypot(sub.x[i] - sub.x[i - 1], sub.y[i] - sub.y[i - 1], sub.z[i] - sub.z[i - 1]);
          }
          sub.along = sAlong;
          sub.blindTail = loopBlindTail(sub);
          sub.parent = p;
          subs.push(sub);
          for (const g of placeFungi(this.c, sub, `sub${p}.${s}`, 3)) this.fungi.push(g);
        }
        sc += BRANCH_GAP;
      }
    }
    // Appended after the loop: `this.paths` is what the loop is walking.
    for (const sub of subs) this.paths.push(sub);

    /**
     * HOW FAR IT IS TO DAYLIGHT FROM EVERY RING, THROUGH THE PASSAGES.
     *
     * NOT `along`, AND NOT `baseAlong + along`, WHICH IS WHAT EVERYTHING ELSE IN
     * THIS FILE USES. Those measure depth through the TREE — down the trunk, out
     * the lead — and they are the right number for the two things that read them:
     * `markDepth` feeds the audio, which wants "how far in does this FEEL", and
     * `blind` feeds the forest occlusion, which wants a conservative bound. This
     * is the other question, and it is the one a lost player is asking: what is
     * the SHORTEST way out from here. Where a lead closes a loop the two answers
     * differ by the whole of the long way round.
     *
     * A tree seed and then Bellman-Ford over the junctions and the welds, which
     * is four sweeps of a few thousand rings and is the cheapest thing in
     * `prepare` by an order of magnitude. Four is not a guess: the graph is a
     * tree plus at most three closures, so the longest chain of improvements a
     * closure can start is bounded by the depth of the tree, which is two —
     * trunk, lead, sub — and a sweep both relaxes every edge and propagates along
     * every passage in both directions.
     *
     * WHAT IT IS FOR. Nothing in this file reads it, and that is deliberate.
     * Real cavers navigate out on airflow and the smell of vegetation, and the
     * sourced recommendation for a homing cue in a game is a MONOTONE FIELD
     * driving one continuous non-textual signal — a faint draught that gets
     * stronger toward the way out — never an arrow and never a map, so that it is
     * legible only in aggregate and you have to walk fifteen metres and compare
     * to read it. This is that field. The cue itself needs audio and particles
     * this file does not own, so what is published here is the number and only
     * the number.
     *
     * It is also the honest statement of the not-getting-stuck guarantee: this
     * being finite at every ring of every passage IS the guarantee, and it is
     * checkable rather than argued.
     */
    for (const p of this.paths) {
      p.toExit = new Float64Array(p.x.length).fill(Infinity);
    }
    {
      const trunk = this.paths[0];
      for (let i = 0; i < trunk.x.length; i++) trunk.toExit[i] = trunk.along[i];
      for (let pi = 1; pi < this.paths.length; pi++) {
        const p = this.paths[pi];
        const par = this.paths[p.parent ?? 0];
        const at = par.toExit[Math.min(p.base, par.toExit.length - 1)];
        for (let i = 0; i < p.x.length; i++) p.toExit[i] = at + p.along[i];
      }
      /** One doorway or weld, relaxed both ways: a hole is not one-directional. */
      const join = (pa, ia, pb, ib) => {
        if (pa.toExit[ia] > pb.toExit[ib]) pa.toExit[ia] = pb.toExit[ib];
        else if (pb.toExit[ib] > pa.toExit[ia]) pb.toExit[ib] = pa.toExit[ia];
      };
      for (let pass = 0; pass < 4; pass++) {
        for (let pi = 1; pi < this.paths.length; pi++) {
          const p = this.paths[pi];
          const par = this.paths[p.parent ?? 0];
          join(p, 0, par, Math.min(p.base, par.toExit.length - 1));
        }
        for (const q of this.paths) {
          if (!q.loopEnd || !q.loopTo || !q.loopTo.toExit) continue;
          const t = q.loopTo;
          join(q, q.toExit.length - 1, t, Math.min(q.loopRing, t.toExit.length - 1));
        }
        // …and along every passage, both ways, on its own metres.
        for (const p of this.paths) {
          const pn = p.x.length;
          for (let i = 1; i < pn; i++) {
            const d = p.toExit[i - 1] + (p.along[i] - p.along[i - 1]);
            if (d < p.toExit[i]) p.toExit[i] = d;
          }
          for (let i = pn - 2; i >= 0; i--) {
            const d = p.toExit[i + 1] + (p.along[i + 1] - p.along[i]);
            if (d < p.toExit[i]) p.toExit[i] = d;
          }
        }
      }
    }
    yield 'to-exit';

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
    /**
     * NOTHING STANDS IN A DOORWAY.
     *
     * `placeBlocks` and `placeSpires` walk one passage at a time and know
     * nothing about the others, so a breakdown slab or a column is as likely to
     * land on a junction as anywhere else — and a junction is the one square
     * metre of a cave where that is fatal rather than decorative. Both are
     * published to `caveSample` as POSTS, things you walk round, and a post in
     * a doorway is a doorway you cannot walk through: `cave-branch` measured a
     * body at the mouth of an eighty-metre branch, pressed against a 1.8 m
     * boulder, for the whole ten seconds.
     *
     * It reads as a sealed junction, and it is the third distinct mechanism in
     * this file to do so — which is the argument for the check rather than for
     * a nudge to the placers' spacing. A cleared gate is a fact about the
     * junction, so it is enforced where the junctions are known.
     *
     * The first five rings, which is the mouth and a stride of the passage
     * behind it: past that a boulder in a side passage is scenery, and scenery
     * is what these are for.
     */
    const gates = [];
    for (let p = 1; p < this.paths.length; p++) {
      const br = this.paths[p];
      for (let i = 0; i < Math.min(5, br.x.length); i++) {
        gates.push({ x: br.x[i], z: br.z[i], r: br.r[i] * br.w[i] + 1.4 });
      }
    }
    const clearOfGates = (o) => {
      const own = o.wall || o.rad || o.r || 0;
      for (let g = 0; g < gates.length; g++) {
        const dx = o.x - gates[g].x;
        const dz = o.z - gates[g].z;
        const rr = gates[g].r + own;
        if (dx * dx + dz * dz < rr * rr) return false;
      }
      return true;
    };
    for (let p = 0; p < this.paths.length; p++) {
      const path = this.paths[p];
      const tag = p === 0 ? 'main' : `br${p}`;
      for (const run of placeWater(this.c, path, tag)) this.water.push({ path: p, ...run });
      const blocks = placeBlocks(this.c, path, tag).filter(clearOfGates);
      yield 'blocks';
      const spires = placeSpires(this.c, path, tag).filter(clearOfGates);
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
       * THE SLABS, SOLVED. See `blockSolid`: this is where the corner jitter,
       * the separate top polygon and the lean stop being private to the emitter
       * and become numbers the body can read. One buffer per passage, `bl.si`
       * the offset into it, so `_emitBlock` and `caveSample` are looking at the
       * same forty floats and cannot drift apart.
       *
       * SLICED, because it is the most expensive thing added to `prepare` in a
       * while and the budget here is 0.6 ms. Eight `rock()` lookups a block —
       * seven corners and the lid's centre — and a big cave has ~300 blocks, so
       * doing them in one go is several times the whole frame's build budget.
       * Yielding every 32 measures at 0.1-0.3 ms a slice, which is the quantum
       * the rest of this generator is cut at; `perf/cave-build` is the gate.
       *
       * It replaces work rather than adding all of it: `_emitBlock` used to run
       * this same rng and these same eight noise lookups at emit time, and now
       * reads them back. The build does the arithmetic once instead of once.
       */
      const solids = new Float32Array(blocks.length * BLOCK_STRIDE);
      for (let bi = 0; bi < blocks.length; bi++) {
        blocks[bi].si = bi * BLOCK_STRIDE;
        blockSolid(this.c.k, blocks[bi], solids, blocks[bi].si);
        if ((bi & 31) === 31) yield 'solids';
      }
      path.obsSolid = solids;

      /**
       * Obstacles, bucketed by ring so the body can find them in a slice rather
       * than a scan. `caveSample` already knows which ring it is nearest; this
       * makes "what is on the floor here" the same question.
       *
       * `reach` is carried as a plain field beside `si` so the reject that
       * throws away the blocks the body is nowhere near — which is nearly all of
       * them — never touches the float buffer at all.
       */
      const obs = [];
      for (const b of blocks)
        obs.push({
          x: b.x, z: b.z, y: b.y, rad: b.rad, top: b.top,
          ring: b.ring, kind: 0, si: b.si, reach: b.reach, wall: b.wall,
        });
      for (const s of spires) {
        if (s.kind !== 'column') continue;
        // Same field set as a slab's record, `si` and `reach` included and
        // unused, so the one loop in `caveSample` that walks this list sees a
        // single hidden class rather than two.
        obs.push({
          x: s.x, z: s.z, y: s.y0, rad: s.rad + 0.1, top: s.y1 - s.y0,
          ring: s.ring, kind: 1, si: 0, reach: s.rad + 0.1, wall: 0,
        });
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
        // The light, not the head. See litColour: g.colour still draws the
        // sprite at full saturation and this is what lands on the rock.
        colour: litColour(g.colour, LIT_DESAT_FUNGUS),
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
        // As above, and less of it: a seam is a destination. See litColour.
        colour: litColour(cr.colour, LIT_DESAT_CRYSTAL),
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
    /**
     * …and the roost, AFTER the shafts, because it reads `this._chambers` —
     * the inventory of rooms the shaft plan builds and now keeps. It is
     * deliberately not a light: two hundred bats are the one thing down here
     * that is neither rock nor a source, and adding them to `this.lights` would
     * put a glow on the ceiling they are hanging from.
     */
    this._planRoosts();
    yield 'roost';

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
    /**
     * BY PARENT, NOT ONE FLAT LIST, and that is what a second level of branch
     * costs the emitter.
     *
     * Both readers used to test `path === this.path` and skip everything else,
     * on the perfectly good assumption that a hole is only ever cut in the main
     * tube. A lead off a lead puts one in a branch, and the version of this that
     * kept a flat list would have cut every junction in the cave into every
     * passage in it — the same ring index and the same phi, in a tube that has
     * nothing there.
     */
    /**
     * …AND A PATH MAY CONTRIBUTE TWO OF THEM, WHICH IS THE WHOLE OF LOOP CLOSURE
     * AS FAR AS THE EMITTER IS CONCERNED.
     *
     * A hole is a (path, ring, phi, span, rings) record and nothing downstream
     * cares which end of which passage produced it — `_link` skips the quads and
     * `_emitRing` flattens the displacement, both by looking the record up in the
     * list belonging to the passage they are drawing. So a second weld needs no
     * new machinery at all: it needs a second `push`, into the list of the path
     * it welded into rather than into its parent's.
     *
     * `loopTo` is a path OBJECT rather than an index because `buildBranch` never
     * knew the indices — `pi` is assigned three blocks down. It is resolved here,
     * which is the first moment both facts exist.
     */
    this._holesBy = this.paths.map(() => []);
    for (let p = 1; p < this.paths.length; p++) {
      const br = this.paths[p];
      this._holesBy[br.parent ?? 0].push({
        ring: br.base,
        rings: br.holeRings,
        phi: br.holePhi,
        span: br.holeSpan,
      });
      if (!br.loopEnd) continue;
      const ti = this.paths.indexOf(br.loopTo);
      // A target that is somehow not in this cave's path list would cut a hole in
      // `_holesBy[-1]`, which is `undefined.push`. It cannot happen — the targets
      // ARE `this.paths` entries — and it is one comparison to make sure.
      if (ti < 0) {
        br.loopEnd = false;
        continue;
      }
      br.loopToIndex = ti;
      this._holesBy[ti].push({
        ring: br.loopRing,
        rings: br.loopRings,
        phi: br.loopPhi,
        span: br.loopSpan,
      });
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
    for (let i = 0; i < this.paths.length; i++) {
      const p = this.paths[i];
      p.vstart = rows;
      // Its own index, so `_emitRing` can ask `_holesBy` for the openings cut in
      // THIS passage without being told which one it is holding.
      p.pi = i;
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
     * THE INDEX BUFFER WAS SIZED AS IF NOTHING WERE EVER WOUND TWICE, AND IT HAS
     * BEEN OVER-RUNNING SINCE THE COLLAR SHIPPED.
     *
     * It was `(rows + hood + 1) * RADIAL * 6`, which counts one quad band per
     * ROW. A path of n rings emits n - 1 bands, so the old expression carried
     * exactly one band of slack per path — and the doubly-wound collar in `_link`
     * spends THREE per branch. Every cave with two or more branches has therefore
     * been writing past the end of a Uint32Array, which in JS is silent: the
     * writes are dropped, `b.tri` runs past `b.index.length`, and `_finish`'s
     * `subarray(0, tri)` quietly clamps and pads the tail with zeroes. Those
     * zeroes are degenerate triangles at vertex 0, so what is actually lost is
     * whatever `_link` writes LAST — the hood's outer shell and the rim strip
     * that gives the doorway its thickness. On seven branches that is about 360
     * triangles off the back of the crag, and nothing has ever reported it
     * because a slightly short hood looks like a hood.
     *
     * Loop closure would have made it worse by another three bands per closure,
     * which is what turned this up. So it is counted rather than approximated:
     * one band per ring per path except the last of each, plus three for every
     * collar `_link` winds both ways, plus the hood and its rim. The cut quads at
     * the junctions only ever remove indices, so this is a true upper bound.
     *
     * IT IS NOT THE VERTEX COUNT AND MUST NOT BE CONFUSED WITH IT. `ringVerts`
     * above is unchanged and stays `(rows + hood + 1) * RADIAL`; `cave-floor`
     * reconstructs exactly that expression to tell lattice rock from loose rock,
     * and a second winding reuses vertices rather than adding any.
     */
    let idxRows = hood + 1;
    for (let i = 0; i < this.paths.length; i++) {
      const p = this.paths[i];
      idxRows += p.x.length - 1;
      if (i > 0) idxRows += 3;
      if (p.loopEnd) idxRows += 3;
    }
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
      index: new Uint32Array(idxRows * RADIAL * 6),
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
    /**
     * THERE IS NO CHANNEL CUT UNDER THE WATER ANY MORE, AND THAT IS THE WHOLE
     * OF WHY THE FLOOR STOPPED LOOKING MACHINED.
     *
     * What used to be here scooped the drawn floor out by 0.12-0.42 m over a
     * band `min(1.7, r * w * 0.55)` wide, centred on the axis, with a hard cut
     * at `floorish > 0.5`. Read that back as a shape rather than as an
     * intention: a trench of CONSTANT width running dead down the middle of the
     * passage for as far as the run goes, with two parallel edges that never
     * deviate because nothing in the expression varies along the passage except
     * the radius. Forty per cent of the rings on grove-01 k=0 are wet, so forty
     * per cent of the cave had a gutter down it — and `_emitWater` then laid a
     * ribbon of exactly the same constant width on top, so the two edges agreed
     * and reinforced each other. The player's word for it was a groove, and a
     * groove is machining: it is the one thing in a cave that no water makes,
     * because water follows the rock and the rock is not straight.
     *
     * Deleting it is also a correctness win, which is the part worth recording.
     * `floorY` — what `caveSample` answers with, what `placeBlocks` seats slabs
     * on and what the pool shoreline bisects against — never knew about the
     * scoop. It could not: the scoop is applied in the emitter, after the
     * analytic floor has been solved. So every wet ring in the world was a ring
     * where the drawn floor was up to 0.42 m BELOW the floor the body walks on,
     * which is the wading half of the disagreement `cave-floor` counts.
     *
     * The stream still knows where the low ground is. It finds it the way the
     * lake does — see `_emitWater` — by solving the rock rather than by having
     * a bed carved for it.
     */
    /**
     * The main tube flattens where a branch leaves it; a branch flattens at its
     * own mouth. Both halves of the same seam.
     */
    const own = isHood || !this._holesBy ? null : this._holesBy[path.pi ?? 0];
    const holes = own && own.length ? own : null;
    /**
     * …and the branch's own first rings, for the same reason from the other
     * side: ring zero is the disc that plugs the hole, and displacing it is
     * displacing the plug.
     *
     * …AND ITS LAST THREE, WHERE IT HAS A SECOND PLUG. A closure's far weld is
     * the same disc in the same relationship to the same kind of hole, counted
     * from the other end. Leaving it out would give the second junction the leak
     * the first one had before this line existed: two surfaces each thrown about
     * by up to `r * rough` against a snout inset of forty centimetres, so they
     * miss, and a miss in a single-sided tube is a view straight out of the
     * mountain.
     */
    const mouthDamp =
      !isHood && path.base >= 0 && (i < 3 || (path.loopEnd && i >= n - 3))
        ? smoothstep(clamp01(Math.min(i, n - 1 - i) / 3))
        : 1;

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
      // there is only hillside to be thick into. See HOOD_BROW — and HOOD_LEAN
      // for why its thickest point is not over the middle of the doorway.
      const brow = isHood
        ? HOOD_BROW *
          clamp01((sec.y / sh.t) * (1 + HOOD_LEAN * this.lean * (sec.x / Math.max(sh.w, 0.2))))
        : 0;
      /**
       * The blocks, on the FREE half of the shell. See the block at HOOD_LEDGE —
       * this, and not `proud`, is what the crag's outline is made of, because
       * over the doorway the burial clamp does not fire at all.
       *
       * Taken at the smooth outline point rather than at the displaced one, so
       * the field cannot chase its own offset around, and so the clamp below can
       * ask the identical question of the identical point and agree with it.
       */
      const crg = isHood
        ? blockFace(px0, py0, pz0, this.bedX, this.bedY, this.bedZ, this.strX, this.strZ, this.c.k)
        : 0;
      const shell = thick * (1 + brow);
      let disp = rn * amp + sc - seepF * r * 0.075 + shell;
      if (isHood) disp = Math.max(disp + HOOD_LEDGE * lip * crg, shell * HOOD_MIN_THICK);
      ox += (ox / outLen) * disp;
      oy += (oy / outLen) * disp;

      let px = cx + rx * ox + (ux / ul) * oy;
      let py = cy + (uy / ul) * oy;
      let pz = cz + rz * ox + (uz / ul) * oy;

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
        /**
         * …and the same courses on the buried shoulders, where the clamp is what
         * the surface is. POSITIVE HALF ONLY: see the last paragraph of the
         * HOOD_LEDGE block for why the negative half may not come near this.
         *
         * The gain on `rn` is up from 0.5 and the constants moved with it, which
         * is the same mean allowance (0.8) at twice the spread. An even collar
         * looks built, and this one was only lopsided by twelve per cent.
         */
        const proud =
          HOOD_PROUD * lip * (0.2 + 1.2 * clamp01(rn * 0.8 + 0.5)) +
          HOOD_LEDGE * 0.5 * lip * Math.max(0, crg);
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
          ) * this._avenShade(px, py, pz);
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
  /**
   * HOW FAR IN THE DAY GETS, AND IT WAS GETTING TOO FAR.
   *
   * At a 14 m constant the term is still 10% of its peak twenty metres in and
   * 2.6% at forty — which sounds like nothing until you price it against what
   * it is competing with. uDay times uDayGain is (0.293, 0.391, 0.320) * 1.45,
   * so 10% of the peak is 0.017 in green, against an ambient of 0.008 and a
   * near-field term that is zero at that range. The daylight was therefore
   * still the BRIGHTEST thing on the wall thirty metres inside a cave, and
   * every station this feature is judged from stands within that.
   *
   * That is the failure the twilight-zone block in the fragment shader
   * describes and then does not get: moss stops in a line you could draw with a
   * ruler because usable daylight stops in one, and an exponential with a
   * fourteen-metre constant does not stop anywhere. 9.5 m puts the same 10% at
   * fourteen metres and takes forty metres to 0.6% — under the ambient, which
   * is where "you are underground now" lives.
   *
   * It is a shortening, not a dimming: the peak at the doorway is untouched, so
   * the mouth seen from inside is exactly as bright an exit as it was, and the
   * contrast between it and the passage around it roughly doubles. Same
   * argument as CRYSTAL_REACH, one term over.
   */
  _daylight(path, i) {
    const g = (path.baseAlong ?? 0) + (path.along ? path.along[i] : i * RING_STEP);
    return Math.exp(-g / 9.5) * 0.42;
  }

  /**
   * THE DIFFERENCE BETWEEN A HOLE AND A DECAL, AND IT IS NOT THE HOLE.
   *
   * `_buildShafts` now draws a small bright irregular disc under the ceiling at
   * each beam's apex — see the block in `_seatShaft`. On its own that is a
   * luminous sticker: a bright patch sitting on a roof that is lit exactly as
   * brightly as the roof beside it, which the eye reads as paint on a surface
   * rather than as a way through it. Every real aven is surrounded by a ring of
   * rock that is DARKER than the average ceiling, because that rock is inside a
   * chimney and can see less of the room than anything else in it.
   *
   * That is precisely what `ao` means in this file — "how much of the rest of the
   * passage can this point see", per the block in `_shade` — so the annulus is
   * expressible with no new attribute, no new uniform and no shader change at
   * all: multiply the occlusion the roof would have had. The disc then sits in a
   * pool of shadow it made, and the two together read as depth.
   *
   * (The stream brief named `above` for this. `above` is the height over the
   * ring's floor and drives the flood line and the silt band; passing a
   * different number there would move a mud line up the wall rather than darken
   * anything. `ao` is the parameter that means what the effect needs.)
   *
   * COST: a loop over the cave's three to eleven shafts per lattice vertex,
   * guarded by one compare on the height. MEASURED by stubbing this to return 1
   * and rebuilding grove-01 k=0 (136 148 vertices, eleven shafts): the emit came
   * out at 143.9 ms against 144.9 with it, i.e. inside the run-to-run spread of
   * the same build. That is what it should be — it runs beside two fbm2 calls
   * and a walk over a light list of thirty to ninety entries.
   */
  _avenShade(px, py, pz) {
    const list = this.shafts;
    if (!list || !list.length) return 1;
    let shade = 1;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const dy = py - s.ay;
      /**
       * ROOF ONLY. A vertex two metres under the opening is WALL — the beam's
       * apex is seated a tenth of the head-room below the ceiling, so the band
       * this may touch is thin by construction. Without the test the annulus
       * becomes a vertical smudge down the side of the chamber, which is a
       * shadow with no caster.
       */
      if (dy < -2.2 || dy > 3.0) continue;
      const dx = px - s.ax;
      const dz = pz - s.az;
      const d = Math.hypot(dx, dz);
      const outer = s.hole * AVEN_SHADE_OUT;
      if (d > outer) continue;
      const inner = s.hole * AVEN_SHADE_IN;
      const t = d <= inner ? 1 : 1 - smoothstep(clamp01((d - inner) / (outer - inner)));
      // The MINIMUM rather than a product: two beams close enough to overlap in a
      // hall would otherwise square the darkening and punch a black hole in the
      // roof between them.
      shade = Math.min(shade, 1 - AVEN_SHADE * t);
    }
    return shade;
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
  // `wetTag` and not `wet`: there is already a local `wet` in here, the damp
  // multiplier on the floor's albedo, and it means the opposite thing.
  _shade(vi, x, y, z, floorish, calcite = 0, above = 99, damp = 0, span = 6, ao = 1, wetTag = 0) {
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
    /**
     * BUFF LIMESTONE, NOT COLD SLATE, AND THE OLD BASE WAS BLUER THAN IT WAS
     * RED.
     *
     * 0.19 / 0.19 / 0.22 — the BLUE channel is the largest one at low vein, so
     * the substrate of this cave was a blue-grey and only the iron streak was
     * warm. The block above says that deliberately, to give the fungus light
     * something to sit against, and it was a reasonable call when the light was
     * a saturated cyan. It is the wrong call now that the light lands nearly
     * white (see litColour): a blue rock under a white light is a blue cave, and
     * the whole verdict on this feature was that it did not read as rock.
     *
     * AND THE FAILURE IS NOT LINEAR IN THE ERROR, WHICH IS WHY IT LOOKED SO
     * MUCH WORSE THAN THE NUMBERS. Every remaining term down here is
     * blue-leaning — the ambient, the haze, the fog, the last of the fungi —
     * so a blue albedo is the fourth blue in a stack, and ACES pulls a
     * blue-dominant dark colour toward MAGENTA. That is the mechanism behind
     * "swirling purple", and it is why chasing it as a saturation problem in
     * any one term never landed: no single term in the shipped frame was
     * purple, and the sum of four faintly blue ones was.
     *
     * Real limestone is buff. 0.20 / 0.185 / 0.155 is a warm grey with the same
     * luminance to three decimal places at the mean vein (0.245 both ways), so
     * this changes no exposure anywhere, and the iron stays the warm end of its
     * own axis rather than being the only warm thing in the cave.
     */
    let cr = 0.2 + vein * 0.14;
    let cg = 0.185 + vein * 0.115;
    let cb = 0.155 + vein * 0.085;
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
    /**
     * THE WALK KEEPS ITS AXIS AND LOSES ITS CHROMA, FOR THE REASON AT THE BASE
     * COLOUR ABOVE.
     *
     * 0.86 / 0.80 / 1.16 is a violet push — blue up a sixth while red and green
     * fall — applied over the whole middle of every cave. It is a fifth blue in
     * the stack described above, and it is the one that was hardest to find,
     * because a violet ALBEDO looks correct in a buffer dump and only becomes
     * the complaint after being multiplied by four other blue terms and passed
     * through a tonemapper that favours magenta.
     *
     * The idea is kept and it is a good one: two hundred metres in has to be
     * visibly not the doorway or there is no reason to walk. What changes is
     * that the axis is now VALUE and TEMPERATURE rather than hue — deeper is
     * darker and a little cooler, and only the far end takes an actual colour,
     * the green-teal that reads as "there is something else beyond this". A
     * quarter of a stop of darkening over a hundred metres is a stronger
     * "somewhere else" than a hue rotation anyway, because it is what a light
     * that is running out actually does.
     */
    cr = lerp(cr, cr * (0.84 - 0.12 * far), deep);
    cg = lerp(cg, cg * (0.82 + 0.17 * far), deep);
    cb = lerp(cb, cb * (0.94 - 0.04 * far), deep);

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
      /**
       * WATER TAKES ITS LIGHT FROM ABOVE, AND THAT IS THE WHOLE OF WHY A POOL
       * NOW GOES DARK IN A DARK ROOM.
       *
       * A mirror does not show you what is beside it. Every other surface down
       * here is a diffuse reflector and this loop is the right integral for one;
       * a water surface is looking at the CEILING, and baking it the same
       * omnidirectional irradiance as the rock two metres away is what made the
       * pool a constant. Measured before this, over the pool's own pixels on
       * grove-01 k=0: `vLit * sheen` was 46% of the surface's light, `vLit` was
       * the mean of every cluster within reach in every direction, and NOTHING
       * in the water's colour was a function of what was over it. The remaining
       * 49% was worse — see the uHaze block in the fragment shader.
       *
       * `dy / dist` is the sine of the elevation to the source, so this is the
       * ordinary cosine-weighted irradiance on an upward-facing surface: a
       * blurred reflection of the upper hemisphere, which is what a mirror with
       * a ripple on it shows and is a far better match for the reference than
       * any sharp highlight would be. Sources at or below the surface fall out
       * entirely, which deletes the one that was doing the most damage — the
       * pool of light at a beam's FOOT, seated half a metre above the floor and
       * therefore half a metre above the water, contributing at full strength to
       * a surface it is level with.
       *
       * The 2.4 is the compensation for the cosine, fitted so a pool DIRECTLY
       * under this cave's brightest beam comes back at roughly the brightness it
       * had before and everywhere else falls. That asymmetry is the point: the
       * complaint was not that the pool was too bright, it was that it was
       * uniformly bright.
       *
       * Nothing per frame. It is the same loop, one multiply longer, on water
       * vertices only.
       */
      const fall =
        t * t * g.power * 0.8 * (wetTag > 0.5 ? Math.max(0, dy / dist) * 2.4 : 1);
      if (fall <= 0) continue;
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
    // `wet` goes through as well as into aSurf: it is the ONLY caller-side fact
    // that tells the bake this vertex is a mirror rather than a diffuse
    // reflector, and the light walk needs to know. See the WATER TAKES ITS
    // LIGHT FROM ABOVE block in `_shade`. `_emitRing` deliberately does not pass
    // it — the rock BESIDE a stream is still rock.
    this._shade(vi, px, py, pz, floorish, calcite, above, damp, span, ao, wet);
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
    /**
     * THE NORMAL IS TAKEN FROM WHICHEVER CORNER OF THE QUAD HAS AN AREA, AND
     * NEVER LEFT AT ZERO. This is the black-rectangle bug.
     *
     * It used to be one cross product over (p, q, r) with `Math.hypot(...) || 1`
     * on the divide. That guard stops a division by zero and does nothing about
     * the thing that matters: when those three points are collinear the cross
     * product is (0, 0, 0), and dividing zero by one leaves a ZERO NORMAL on all
     * four vertices of the quad.
     *
     * A degenerate triangle rasterises nothing, so the obvious reading — "a
     * face with no area draws no pixels, who cares what its normal is" — is
     * wrong for a QUAD. `_face` splits (p,q,r,s) into (p,q,r) and (p,r,s); only
     * the FIRST of those has to be degenerate for the normal to come out zero,
     * and the second one is then a perfectly ordinary triangle with three zero
     * normals on it. The shader normalizes, `normalize(vec3(0.0))` is 0/0, and
     * NaN interpolates to NaN across the whole triangle — so it comes out PURE
     * BLACK with a hard edge on every side, sitting on an otherwise correctly
     * shaded formation. Measured on grove-01: 52-144 zero-normal vertices in
     * every cave in the world, in 5-21 runs, and one of them is a three-metre
     * blade that reads as a black bar pasted over the rock.
     *
     * The degenerate quads are real geometry and not a mistake upstream: a
     * drapery panel or a crystal face whose two spline samples land on top of
     * each other has a genuine, visible shape, it just has one corner with no
     * area in it. So this fixes the normal rather than dropping the face.
     *
     * Three fallbacks, in order of how much they know:
     *   1  the other split, (p, r, s) — the triangle that is actually drawn;
     *   2  the outward direction from `inside`, which is the reference the flip
     *      test below already trusts for exactly this solid;
     *   3  straight up, so that a caller with neither an area nor an `inside`
     *      still cannot emit a NaN.
     */
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let nl = 0;
    const cross = (u, v, w) => {
      const ax = v[0] - u[0];
      const ay = v[1] - u[1];
      const az = v[2] - u[2];
      const bx = w[0] - u[0];
      const by = w[1] - u[1];
      const bz = w[2] - u[2];
      nx = ay * bz - az * by;
      ny = az * bx - ax * bz;
      nz = ax * by - ay * bx;
      nl = Math.hypot(nx, ny, nz);
      return nl > 1e-12;
    };
    const hasArea = cross(p, q, r) || (s && cross(p, r, s));
    const cx = (p[0] + q[0] + r[0] + (s ? s[0] : r[0])) / (s ? 4 : 3);
    const cy = (p[1] + q[1] + r[1] + (s ? s[1] : r[1])) / (s ? 4 : 3);
    const cz = (p[2] + q[2] + r[2] + (s ? s[2] : r[2])) / (s ? 4 : 3);
    if (!hasArea) {
      // Fallbacks 2 and 3. `flip` below is a no-op on the second — it points
      // away from `inside` by construction — and harmless on the third.
      nx = inside ? cx - inside[0] : 0;
      ny = inside ? cy - inside[1] : 1;
      nz = inside ? cz - inside[2] : 0;
      nl = Math.hypot(nx, ny, nz);
      if (!(nl > 1e-12)) {
        nx = 0;
        ny = 1;
        nz = 0;
        nl = 1;
      }
    }
    nx /= nl;
    ny /= nl;
    nz /= nl;
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
    const path = this.paths[bl.path];
    const day = this._daylight(path, bl.ring);
    const span = this._spanAt(path, bl.ring);
    /**
     * THE SHAPE IS NOT DRAWN HERE ANY MORE — see `blockSolid`, which `prepare`
     * ran once and packed into `path.obsSolid`. Everything this function used to
     * derive inline from its own rng (the lean, the shrink and skew of the top
     * polygon, the seven jittered corners, their heights, the buried base plane)
     * is read back below.
     *
     * That is the whole point of the change: the collider used to raise a fitted
     * DOME over the block's nominal radius because none of those numbers reached
     * it, and the body ended up standing over a metre above rock it could see
     * under its feet. Two consumers deriving the same shape from the same rng in
     * two places is the same bug waiting to happen again the first time one of
     * them is edited, so there is exactly one derivation and both read it.
     */
    const buf = path.obsSolid;
    const si = bl.si;
    const yBot = buf[si + B_YBOT];
    const centreTop = buf[si + B_CTOP];
    const ctx = buf[si + B_CTX];
    const ctz = buf[si + B_CTZ];

    const above = bl.top * 0.5;
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
      const abx = buf[si + B_BX + i];
      const abz = buf[si + B_BZ + i];
      const bbx = buf[si + B_BX + j];
      const bbz = buf[si + B_BZ + j];
      const atx = buf[si + B_TX + i];
      const atz = buf[si + B_TZ + i];
      const at = buf[si + B_TY + i];
      const btx = buf[si + B_TX + j];
      const btz = buf[si + B_TZ + j];
      const bt = buf[si + B_TY + j];
      /**
       * The fracture face: a sloped quad from the buried base ring to the
       * smaller, shoved top ring, and DARK. The gaps between fallen rock are
       * where a chamber's shadow actually lives, and them being dark is what
       * makes a breakdown floor read as something with depth rather than as a
       * pattern on the ground.
       *
       * `_face` splits a quad as (0,1,2) then (0,2,3), and this quad is NOT
       * planar — four corners at four heights. `blockTopAt` splits it the same
       * way for exactly that reason; the two triangulations of a corner this
       * ragged differ by up to the block's whole height along the diagonal.
       */
      this._face(
        [abx, yBot, abz],
        [bbx, yBot, bbz],
        [btx, bt, btz],
        [atx, at, atz],
        inside, day, 0, 0.85, above, 0.25, 0, span, 0.34
      );
      // …and one wedge of the top, fanned from the middle so the tilt reads as
      // a tilt rather than as a flat lid set at an angle.
      this._face(
        [ctx, centreTop, ctz],
        [atx, at, atz],
        [btx, bt, btz],
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
        [bbx, yBot, bbz],
        [abx, yBot, abz],
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
        /**
         * …AND THEN PULLED IN AGAIN BY A NOISE, WHICH IS NOT A FUDGE.
         *
         * The bisection is exact against `floorY`, and `floorY` is the ANALYTIC
         * outline plus `surfaceLift`. The floor that is actually DRAWN is a
         * lattice: RADIAL=44 samples round a ring, so across a chamber 34 m wide
         * the drawn floor is straight lines 1.5 m apart, and between them it
         * cannot hold the detail the noise field has. Solving the shore against
         * the continuous function therefore produces an edge that is SMOOTHER
         * than the rock it is supposed to be following — the exact answer to a
         * question the geometry cannot ask.
         *
         * A metre-scale wobble puts the missing frequency back. It only ever
         * pulls the water IN, never out, so it cannot expose the sheet's own
         * edge hanging over a step — the worst it does is leave a hand's width
         * more dry rock, which is a beach.
         *
         * Two octaves of the same `noise2` the rock's mottle uses, read at the
         * SHORE POINT's own world position rather than at the ring's, so the two
         * banks wander independently and a bank does not repeat down the lake.
         * Tried at one octave and 0.9 m: reads as a scallop, i.e. as a pattern.
         * Tried keyed to the ring index: the two sides then wobble in step,
         * which is a taper with a wiggle in it and reads as a ribbon.
         */
        const wob = (d, sx, sz) => {
          if (d <= 0) return 0;
          // `noise2` is signed; folded to 0..1 so the wobble can only ever take
          // water away. A signed one would push the sheet out over rock that the
          // bisection has already said is above the surface.
          const w = clamp01(
            0.5 +
              (noise2(sx * 0.74, sz * 0.74) * 0.66 +
                noise2(sz * 1.9 + 11.3, sx * 1.9 - 4.1) * 0.34) *
                0.5
          );
          // Held off in the last half-metre so a shore that has already closed
          // to nothing is not pushed negative and re-opened by the clamp.
          return Math.max(0, d - w * 0.55 * clamp01(d / 0.5));
        };
        const dl = Math.max(0, shore(i, sh, tx, tz, 1) - 0.12) * path.wet[i];
        const dr = Math.max(0, shore(i, sh, tx, tz, -1) - 0.12) * path.wet[i];
        const wl = wob(dl, path.x[i] - tz * dl, path.z[i] + tx * dl);
        const wr = wob(dr, path.x[i] + tz * dr, path.z[i] - tx * dr);
        return {
          l: [path.x[i] - tz * wl, poolY, path.z[i] + tx * wl],
          r: [path.x[i] + tz * wr, poolY, path.z[i] - tx * wr],
          y: poolY,
        };
      }
      /**
       * A STREAM LIES IN THE LOWEST GROUND THERE IS, AND FINDING IT IS THE WHOLE
       * DIFFERENCE BETWEEN A WATERCOURSE AND A GROOVE.
       *
       * What was here was `min(1.7, r * w * 0.55) * wet * (1 + pool * 0.9)`,
       * laid symmetrically about the centre line at the analytic floor plus
       * 3 cm. Every term in that varies with the RADIUS and with nothing else,
       * so down a passage of near-constant radius — which is most of one — it
       * draws two parallel straight lines the length of the run. `_emitRing`
       * then cut a trench of exactly that width between them, so the
       * straightness was in the rock as well as in the water and the two edges
       * agreed to the centimetre. That pair is the thing the player called a
       * groove. The trench is gone (see the block in `_emitRing`) and this is
       * the half that would have survived deleting it.
       *
       * A stream cannot take the lake's treatment — it is not level, so there is
       * no one surface height to bisect against — but it can be asked the same
       * QUESTION per ring: where is the rock lowest, and how far does water
       * STREAM_DEEP above that reach before the ground comes back up?
       *
       * Scanned rather than bisected, and that is not laziness. A bisection has
       * to be anchored at an offset that is known to be under water, and the
       * only such offset for a lake is the axis; for a stream on a floor whose
       * displacement is a noise field the axis is under water about half the
       * time, so an anchored search returns zero width on every other ring and
       * the stream becomes a dashed line. The scan finds the argmin instead, so
       * the water is wherever the hollow is — which moves from side to side as
       * the noise does, at the metre scale the noise has. The meander is not
       * authored anywhere: it is the rock's own low line, read out.
       *
       * `floorY` is the same solve the lake bisects against, the same one
       * `caveSample` answers the body with, and — now that nothing is cut under
       * the water — the same surface the emitter draws. Three consumers, one
       * floor, and a sheet that cannot hang in the air or sink into the rock
       * because it was placed by asking where the rock is.
       */
      const span = (sh.w - 1e-3) * r;
      const at = (d) =>
        floorY(this.c.k, path, i, sh, d / r, path.x[i] - tz * d, path.z[i] + tx * d);
      let lowD = 0;
      let lowY = Infinity;
      for (let s = -STREAM_SCAN; s <= STREAM_SCAN; s++) {
        const d = (s / STREAM_SCAN) * span * 0.82;
        const fy = at(d);
        if (fy < lowY) {
          lowY = fy;
          lowD = d;
        }
      }
      const y = lowY + STREAM_DEEP * (1 + path.pool[i] * 1.4);
      /**
       * Out from the hollow until the ground comes up through the surface, one
       * bank at a time and each one refined where it crosses. The step is the
       * scan's own spacing, so a bank is never reported further out than the
       * next sample the argmin was chosen against.
       */
      const bank = (side) => {
        const step = (span * 0.82) / STREAM_SCAN;
        let d = 0;
        while (d < span - lowD * side) {
          const nd = d + step;
          if (at(lowD + nd * side) > y) {
            // Halve into the crossing four times: 6 cm on a four-metre passage.
            let lo = d;
            let hi = nd;
            for (let s = 0; s < 4; s++) {
              const mid = (lo + hi) * 0.5;
              if (at(lowD + mid * side) > y) hi = mid;
              else lo = mid;
            }
            return lo;
          }
          d = nd;
        }
        return d;
      };
      // Held off the rock by a hand's breadth, for the reason the lake's edge is
      // — two surfaces solved from one function and drawn by different code.
      const dl = Math.max(0, bank(1) - 0.06) * path.wet[i];
      const dr = Math.max(0, bank(-1) - 0.06) * path.wet[i];
      return {
        l: [path.x[i] - tz * (lowD + dl), y, path.z[i] + tx * (lowD + dl)],
        r: [path.x[i] + tz * (dr - lowD), y, path.z[i] - tx * (dr - lowD)],
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
    const holesBy = this._holesBy;

    // Every passage: the surface you are standing inside, facing in.
    for (let p = 0; p < this.paths.length; p++) {
      const path = this.paths[p];
      const n = path.x.length;
      const base = path.vstart;
      // The openings cut in THIS passage — its own children's, and nobody
      // else's. See the block over `_holesBy`.
      const holes = holesBy[p] ?? [];
      for (let i = 0; i < n - 1; i++) {
        if (i % LINK_SLICE === 0) yield 'link';
        for (let j = 0; j < RADIAL; j++) {
          if (holes.length) {
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
          /**
           * …AND SO ARE A LOOP'S LAST THREE, FOR THE IDENTICAL REASON.
           *
           * A closure's far end is a snout standing in the target's bore exactly
           * as its near end is a snout standing in its parent's. Every word of
           * the paragraph above applies with the ring index counted from the
           * other end: stand to one side of the second junction and your line of
           * sight passes through the snout's near wall, through the hole cut in
           * the target, and out of the mountain. It is the same 144 triangles.
           */
          if (p > 0 && (i < 3 || (path.loopEnd && i >= n - 4))) {
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
    // …and the colony, on a stop of its own for the same reason the beams get
    // one: 1 200 vertices is nothing, and it costs nothing to be sure it never
    // lands on the same frame as the 3 MB of passage above it.
    yield 'bat-mesh';
    this._buildBats();
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
    /**
     * KEPT, BECAUSE SOMETHING ELSE NOW WANTS THE SAME QUESTION ANSWERED.
     *
     * The walk above is the file's only inventory of "where are the chambers" —
     * runs of rings that are all wide enough and all tall enough, with the
     * biggest ring of each already picked out. `_planRoosts` needs exactly that
     * and nothing else, and the one thing it must NOT do is ask the question a
     * second time with its own thresholds: two independent notions of what
     * counts as a chamber is how a feature ends up in a corridor on the seed
     * nobody tested. The list is a handful of small objects and is dropped with
     * the rest of the plan.
     */
    this._chambers = found;
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
   * WHERE THE COLONY IS. See the block over `placeBats`.
   *
   * Asked of `this._chambers`, which is `_planShafts`' own inventory of rooms —
   * not of a second scan with its own thresholds. That reuse is the whole reason
   * this is nine lines: whatever the walk and SHAPES are made to do to chamber
   * size and frequency, the roost follows, exactly as the beams do.
   *
   * BIGGEST FIRST AND THEN SPREAD, WHICH IS THE OPPOSITE OF THE BEAMS' RULE AND
   * IS RIGHT FOR THE OPPOSITE REASON. `_planShafts` buckets rather than sorts,
   * because four beams have to be met four times over the length of the walk. A
   * roost is met ONCE and has to be worth the walk when it is: it wants the
   * biggest ceiling in the cave, full stop. The spacing test is a veto on a
   * second roost being in the same hall as the first, not a spreading rule.
   *
   * AND IT DOES NOT AVOID THE LIT CHAMBERS. The first sketch put the roost
   * somewhere dark on the theory that a surprise should be unlit, and it is
   * exactly backwards: an unlit ceiling is a ceiling nobody looked at, so the
   * bats are not mistaken for stalactites, they are not seen at all, and the
   * flush is two hundred invisible things making a noise. The biggest chambers
   * are also the ones `_planShafts` put beams in, and a colony peeling off a
   * ceiling and crossing a shaft of light is the picture.
   */
  _planRoosts() {
    this.roosts = [];
    const found = this._chambers;
    if (!found || !found.length) return;
    const rng = makeRng(`${getWorldSeed()}:cave-roost:${this.c.k}`);
    const order = found.map((f, i) => i).sort((a, b) => found[b].score - found[a].score);
    /**
     * ONE ROOST, AND A SECOND ABOUT ONE CAVE IN THREE.
     *
     * MEASURED, because the first rule was "two whenever the cave has four or
     * more chambers" and that is not a rule at all: every one of the first four
     * grove-01 caves probed has seven or more, so it granted two roosts every
     * time and the scarcity argument at ROOST_MAX was a paragraph describing
     * something that never happened.
     *
     * A coin on the cave's own seed is the honest form of "usually one". The
     * draw is unconditional so the rng stream does not depend on the chamber
     * count — the same discipline the branch walk keeps about aligned streams —
     * and five chambers is still required, so a small cave cannot get two.
     */
    const two = rng() < 0.35;
    const want = Math.min(ROOST_MAX, found.length >= 5 && two ? 2 : 1);
    for (const oi of order) {
      if (this.roosts.length >= want) break;
      const cand = found[oi];
      const p = cand.path;
      const cx = p.x[cand.at];
      const cz = p.z[cand.at];
      let clash = false;
      for (const r of this.roosts) {
        if (Math.hypot(r.cx - cx, r.cz - cz) < ROOST_APART) clash = true;
      }
      if (clash) continue;
      const roost = placeBats(this.c, p, cand, rng);
      if (roost.bats.length) this.roosts.push(roost);
    }
  }

  /**
   * The colony, merged into one non-indexed quad mesh — the same construction
   * `_buildShafts` uses and for the same reason.
   *
   * TWO HUNDRED BATS IS TWO HUNDRED QUADS IS 1 200 VERTICES AND ONE DRAW. An
   * InstancedMesh was the obvious alternative and loses on every axis that
   * matters here: it needs an instance matrix nothing would ever write (the CPU
   * does not touch a bat), it is a second geometry type for the pre-warm to get
   * exactly right, and at four hundred triangles the whole mesh is smaller than
   * one breakdown block. A merged buffer is the same thing with fewer moving
   * parts.
   *
   * NOT sliced across frames. `_buildShafts` is not either, for the reason given
   * there — this is one pass over at most 440 items writing floats, measured in
   * the same class as the beams' 336 vertices, and the build's own deadline is
   * checked before and after it.
   */
  _buildBats() {
    const roosts = this.roosts;
    if (!roosts || !roosts.length) return;
    let count = 0;
    for (const r of roosts) count += r.bats.length;
    if (!count) return;

    const pos = new Float32Array(count * 6 * 3);
    const corner = new Float32Array(count * 6 * 2);
    const bat = new Float32Array(count * 6 * 4);
    const roost = new Float32Array(count * 6 * 4);
    // Two triangles, wound so that cross(Rv, F) is the front face before the
    // shader's mirror gets a vote. See the facing block in the vertex shader.
    const CX = [-1, 1, 1, -1, 1, -1];
    const CY = [-1, -1, 1, -1, 1, 1];

    let at = 0;
    for (let ri = 0; ri < roosts.length; ri++) {
      const R = roosts[ri];
      for (const b of R.bats) {
        /**
         * THE PEEL, AS A DELAY PER BAT, AND IT IS NOT RANDOM.
         *
         * A uniform random delay gives a roost that dissolves evenly, which
         * reads as a fade. What a startled colony actually does is go up in a
         * WAVE from whichever end was disturbed, because each bat is startled by
         * its neighbour rather than by the intruder. The seed contributes a
         * little scatter so the wave front is ragged; the rest of it is the
         * bat's distance from the roost centre, so the near edge goes first.
         *
         * Precomputed here rather than derived in the shader because the centre
         * is already in hand and a distance in the vertex shader would be three
         * more instructions on every vertex, forever, for a number that cannot
         * change after the build.
         */
        const d = Math.hypot(b.x - R.cx, b.y - R.cy, b.z - R.cz);
        const delay = clamp(d / Math.max(4, R.radius * 2.4), 0, 1) * 0.95 + b.seed * 0.28;
        for (let c = 0; c < 6; c++) {
          const k3 = (at + c) * 3;
          pos[k3] = b.x - this.originX;
          pos[k3 + 1] = b.y - this.originY;
          pos[k3 + 2] = b.z - this.originZ;
          const k2 = (at + c) * 2;
          corner[k2] = CX[c];
          corner[k2 + 1] = CY[c];
          const k4 = (at + c) * 4;
          // The sign of the seed is the roost slot. See the vertex shader.
          bat[k4] = (ri === 0 ? 1 : -1) * Math.max(1e-4, b.seed);
          bat[k4 + 1] = b.span;
          bat[k4 + 2] = delay;
          bat[k4 + 3] = R.rise;
          roost[k4] = R.cx - this.originX;
          roost[k4 + 1] = R.cy - this.originY;
          roost[k4 + 2] = R.cz - this.originZ;
          roost[k4 + 3] = R.radius;
        }
        at += 6;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    geo.setAttribute('aBat', new THREE.BufferAttribute(bat, 4));
    geo.setAttribute('aRoost', new THREE.BufferAttribute(roost, 4));
    /**
     * THE BOUNDING SPHERE HAS TO COVER THE ORBIT AND NOT THE CEILING.
     *
     * `computeBoundingSphere` sees only the anchors, which are all on one roof;
     * the moment the colony flushes, every vertex the shader emits is somewhere
     * else entirely, and a frustum test against the old sphere would cull the
     * whole flock the instant you look at the room instead of at the roof it
     * came off. This is the same class of trap as the stale InstancedMesh sphere
     * this repo already has a note about, arriving through the front door. So
     * the sphere is grown by the orbit's reach, which is the furthest the vertex
     * shader can ever displace a vertex.
     */
    geo.computeBoundingSphere();
    let reach = 0;
    for (const R of roosts) {
      reach = Math.max(
        reach,
        Math.hypot(R.cx - this.originX, R.cy - this.originY, R.cz - this.originZ) +
          R.radius * 1.15 +
          R.rise
      );
    }
    if (geo.boundingSphere) {
      /**
       * Recentred on the mesh's own origin before the radius is grown, and the
       * order matters: moving the centre without accounting for where it WAS
       * would leave anchors outside the sphere. `|c| + r` is the bound on every
       * anchor measured from the local origin, so taking the max of that and the
       * orbit's reach covers both states of every bat.
       */
      const c = geo.boundingSphere.center;
      const anchors = Math.hypot(c.x, c.y, c.z) + geo.boundingSphere.radius;
      c.set(0, 0, 0);
      geo.boundingSphere.radius = Math.max(anchors, reach) + 1;
    }

    this.batMaterial = batMaterial();
    const mesh = new THREE.Mesh(geo, this.batMaterial);
    mesh.position.set(this.originX, this.originY, this.originZ);
    /**
     * Opaque, after the rock (-5) so the passage's early-Z has already rejected
     * most of the frame, and before the beams (4) and the heads (5) so both of
     * those additive layers are correctly stopped by a bat in front of them.
     */
    mesh.renderOrder = -3;
    mesh.name = 'cave-bats';
    this.batMesh = mesh;
    this.group.add(mesh);
  }

  /**
   * ONE SQUARED-DISTANCE TEST PER ROOST PER FRAME, AND THAT IS THE WHOLE OF THE
   * PER-FRAME COST OF THIS FEATURE.
   *
   * Called from `CaveField.update`, which already has the camera. Writes a float
   * into a uniform and never writes it again — a flushed roost stays flushed,
   * because a colony that quietly re-hung itself while you stood in the room
   * would be the same reveal available twice, which is one more time than it is
   * worth.
   *
   * FLUSH_NEAR IS DELIBERATELY SHORT. Thirteen metres is inside the chamber,
   * past the doorway, which means you are already looking at the ceiling when it
   * comes off. A trigger at the entrance to the room fires while the roof is
   * still edge-on and out of frame, and all you get is a noise.
   *
   * AND IT IS ROOFED, NOT xz. `caveSample` reaches through mountains — this
   * repo's own note — so a horizontal distance would flush a colony because
   * somebody walked over the hill above it. The height test is the same
   * ROOF_CLEARANCE-shaped question `controller.roofed` asks, done locally
   * because this has the roost's own y in hand and the controller does not.
   */
  checkFlush(px, py, pz, now) {
    const roosts = this.roosts;
    if (!roosts || !roosts.length) return false;
    /**
     * NOT BEFORE THE MESH EXISTS, AND THIS GUARD IS NOT DEFENSIVE.
     *
     * The plan finishes many frames before `_buildBats` runs — the whole build
     * is sliced at 0.6 ms — so between the two there is a window in which the
     * roost is known and there is nothing to fly. Without this, a player who
     * reached the chamber inside that window would set `flushed` on a roost with
     * no uniform to write it into, and the ceiling would then stay full forever
     * with the flush permanently spent. Silent, one-shot, and impossible to
     * reproduce on purpose: the worst shape a bug can have.
     */
    if (!this.batMaterial) return false;
    let fired = false;
    for (let i = 0; i < roosts.length; i++) {
      const R = roosts[i];
      if (R.flushed) continue;
      const dy = py - R.cy;
      if (dy < -FLUSH_BELOW || dy > FLUSH_ABOVE) continue;
      const dx = px - R.cx;
      const dz = pz - R.cz;
      if (dx * dx + dz * dz > FLUSH_NEAR * FLUSH_NEAR) continue;
      R.flushed = true;
      if (this.batMaterial) {
        const u = this.batMaterial.uniforms.uFlush.value;
        if (i === 0) u.x = now;
        else u.y = now;
      }
      this.flushed = R;
      fired = true;
    }
    return fired;
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
    const vol = (half * half * head) / (HALL_HALF * HALL_HALF * HALL_HALF * 0.75);
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
    /**
     * WHERE THE LIGHT COMES IN, WHICH FOR THE WHOLE LIFE OF THIS FEATURE WAS
     * NOWHERE.
     *
     * The header is plain that "the opening the light comes through is never
     * shown", and the reasoning behind it is sound and is about THE CONE: a cone
     * that runs all the way into the ceiling draws a hard elliptical intersection
     * against geometry it is passing through, so it is stopped short and its top
     * is faded out. That constraint says nothing at all about the OPENING, and
     * the consequence of conflating the two is a shaft of light with no source —
     * a volume that begins in mid-air a metre and a half under an unbroken roof,
     * which is the one thing about the beams that reads as a prop.
     *
     * So the apex is recorded here and `_buildShafts` puts a small irregular
     * downward-facing disc on it. It is NOT a hole in the mesh — the tube's
     * lattice is a closed swept surface and cutting it is the "a height field
     * cannot roof a cave mouth" problem all over again. It is the far end of an
     * aven, seen from the bottom, which is what you actually see: a bright
     * ragged patch, not a porthole with a rim.
     */
    this.shafts.push({
      x: cx,
      y: bottom,
      z: cz,
      h,
      rad,
      dir,
      /**
       * The apex, in world coordinates, and the size of the opening there.
       *
       * `shaftUnit` bakes a 0.34 taper, so the cone's narrow end is already
       * `rad * 0.34` across; 1.18 of that makes the opening very slightly wider
       * than the beam leaving it, which is the right way round — a beam is the
       * light that got through a hole and can never be wider than one. Clamped
       * at the bottom so a narrow beam in a low chamber still has an opening big
       * enough to read as one rather than a bright dot.
       */
      ax: cx + dir.x * h,
      ay: bottom + dir.y * h,
      az: cz + dir.z * h,
      hole: Math.max(0.55, rad * 0.34 * 1.18),
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
   * Four beams is 112 triangles, plus 48 for the four openings — see HOLE_SEGS
   * and the block in `_seatShaft`. The merge is a transform of 336 vertices and
   * a fan of 144 more, done once per cave; there is no per-frame CPU here at
   * all, and the openings ride in the same buffer so the draw count is unchanged
   * at one.
   */
  _buildShafts() {
    const list = this.shafts;
    if (!list || !list.length) return;
    const unit = shaftUnit();
    const up = unit.getAttribute('position').array;
    const un = unit.getAttribute('normal').array;
    const uu = unit.getAttribute('uv').array;
    const vc = up.length / 3;
    /**
     * …plus one opening per beam, in the SAME buffer and therefore the same
     * draw. See the block in `_seatShaft`. HOLE_SEGS triangles in a fan, three
     * vertices each because the cone this rides with is non-indexed and mixing
     * an indexed span into it would mean building an index for the whole thing
     * to save 36 vertices.
     */
    const holeV = HOLE_SEGS * 3;
    const total = (vc + holeV) * list.length;

    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    const beam = new Float32Array(total * 2);

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

      /**
       * ---- THE OPENING -----------------------------------------------------
       *
       * A dozen triangles in a fan about the apex, facing straight back down the
       * beam. Everything about its shape is decided by two lines:
       *
       *   THE RADIUS IS JITTERED BY THE SAME FIELD THE WALLS ARE. `rock` is what
       *   `_emitRing` displaces every vertex of the passage by, so an opening
       *   whose rim wanders on it is broken the way the rock around it is
       *   broken. A circle here would be a porthole — a perfect man-made curve
       *   is the single most expensive mistake available in a cave, because
       *   there is nothing else in the frame with a machined edge to compare it
       *   against and the eye finds it instantly.
       *
       *   THE RIM IS SAMPLED IN 3D AND THE SEAM IS CLOSED BY CONSTRUCTION. Every
       *   fan triangle takes its two rim radii from the shared `rim` array
       *   rather than resampling, so segment 11 and segment 0 use the same
       *   number and there is no crack where the fan wraps.
       *
       * The v coordinate does the rest, and it is chosen against the material's
       * existing `along` curve rather than by adding a uniform: 0.88 is exactly
       * where the plateau ends, so the centre is at full strength and the same
       * cyan-white the top of the cone is, and 0.965 is a fifth of the way down
       * the top ramp, so the ragged rim fades out instead of drawing an edge.
       * The material is untouched by this feature — it is geometry only, which
       * is what keeps it free.
       */
      // Any vector not parallel to the beam; the beam is within 14 degrees of
      // vertical by construction (see `_planShafts`), so world X is always safe.
      const uX = new THREE.Vector3(1, 0, 0).cross(b.dir).normalize();
      const uZ = new THREE.Vector3().crossVectors(b.dir, uX).normalize();
      const rim = new Float32Array(HOLE_SEGS);
      for (let sgi = 0; sgi < HOLE_SEGS; sgi++) {
        const a = (sgi / HOLE_SEGS) * TAU;
        const rx = b.ax + Math.cos(a) * b.hole;
        const rz = b.az + Math.sin(a) * b.hole;
        // 0.62 to 1.38 of the nominal radius. Narrower than that and the rim is
        // a circle with texture on it; wider and neighbouring segments cross.
        rim[sgi] = b.hole * (0.62 + 0.76 * clamp01(rock(rx, b.ay, rz) * 0.5 + 0.5));
      }
      const cxo = b.ax - this.originX;
      const cyo = b.ay - this.originY;
      const czo = b.az - this.originZ;
      for (let sgi = 0; sgi < HOLE_SEGS; sgi++) {
        const a0 = (sgi / HOLE_SEGS) * TAU;
        const a1 = ((sgi + 1) / HOLE_SEGS) * TAU;
        const r0 = rim[sgi];
        const r1 = rim[(sgi + 1) % HOLE_SEGS];
        const tri = [
          [cxo, cyo, czo, 0.88],
          [
            cxo + (uX.x * Math.cos(a0) + uZ.x * Math.sin(a0)) * r0,
            cyo + (uX.y * Math.cos(a0) + uZ.y * Math.sin(a0)) * r0,
            czo + (uX.z * Math.cos(a0) + uZ.z * Math.sin(a0)) * r0,
            0.965,
          ],
          [
            cxo + (uX.x * Math.cos(a1) + uZ.x * Math.sin(a1)) * r1,
            cyo + (uX.y * Math.cos(a1) + uZ.y * Math.sin(a1)) * r1,
            czo + (uX.z * Math.cos(a1) + uZ.z * Math.sin(a1)) * r1,
            0.965,
          ],
        ];
        for (let c = 0; c < 3; c++) {
          const k3 = (at + c) * 3;
          pos[k3] = tri[c][0];
          pos[k3 + 1] = tri[c][1];
          pos[k3 + 2] = tri[c][2];
          // Straight down the beam. The material takes |N·V|, so the sign is
          // free; pointing it at the floor is simply the honest answer for a
          // surface that is the ceiling of the room.
          nor[k3] = -b.dir.x;
          nor[k3 + 1] = -b.dir.y;
          nor[k3 + 2] = -b.dir.z;
          const k2 = (at + c) * 2;
          uv[k2] = 0.5;
          uv[k2 + 1] = tri[c][3];
          beam[k2] = b.seed;
          beam[k2 + 1] = b.gain;
        }
        at += 3;
      }
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
    /**
     * The colony, and its material with it — this is the one material in the
     * file that is NOT a module singleton (see `batMaterial` for why), so it is
     * the one that has an owner to dispose it. Dropping the geometry and leaving
     * the material would leak one program's worth of uniform state per cave
     * streamed in a session, which over a long walk is hundreds.
     */
    this.batMesh?.geometry.dispose();
    this.batMaterial?.dispose();
    this.group.clear();
    this.mesh = null;
    this.points = null;
    this.shaftMesh = null;
    this.batMesh = null;
    this.batMaterial = null;
    this.roosts = null;
    this._chambers = null;
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
 * The bats' PRE-WARM material only. Unlike the three above it is not what the
 * caves draw with — each cave builds its own, see `batMaterial` — so this exists
 * purely so `caveWarmupObjects` has something to compile the program from, and
 * nothing else may reach for it.
 */
let sharedBat = null;

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

  /**
   * …AND THE BATS, WHICH ARE THE ONE PROGRAM DOWN HERE THAT WOULD COMPILE ON
   * THE WORST POSSIBLE FRAME.
   *
   * The rock compiles when a cave first enters the frustum, which is somewhere
   * out on a hillside; the beams compile when a chamber does. The colony's mesh
   * is INSIDE a chamber, invisible until you are in the room with it, so an
   * unwarmed bat program compiles on the frame you walk through the doorway —
   * measured elsewhere at 100-180 ms for a material of this class, which is a
   * third of a second of frozen screen at the exact moment the feature exists to
   * produce. That is the hitch this whole subsystem exists to prevent.
   *
   * Same rule as the three above: non-indexed, and attribute for attribute what
   * `_buildBats` builds. If that list changes, this changes with it — the rule
   * has been broken three times in this function's history and the test for
   * whether it was is `npm run perf:spikes`.
   *
   * `batMaterial()` is not a singleton in the app — every cave makes its own —
   * so what is warmed here is the PROGRAM, which the cache keys on the shader
   * source and which every per-cave copy therefore hits. See the block over
   * `batMaterial`.
   */
  const bats = new THREE.BufferGeometry();
  bats.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  bats.setAttribute('aCorner', new THREE.BufferAttribute(new Float32Array(6), 2));
  bats.setAttribute('aBat', new THREE.BufferAttribute(new Float32Array(12), 4));
  bats.setAttribute('aRoost', new THREE.BufferAttribute(new Float32Array(12), 4));

  return [
    new THREE.Mesh(rock, sharedMaterial ?? (sharedMaterial = caveMaterial())),
    new THREE.Points(fungi, sharedFungus ?? (sharedFungus = fungusMaterial())),
    new THREE.Mesh(shaft, sharedShaft ?? (sharedShaft = shaftMaterial())),
    new THREE.Mesh(bats, sharedBat ?? (sharedBat = batMaterial())),
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

/** `CaveField.nearestMouth`'s answer, reused so the audio never allocates. */
const _mouth = { k: 0, x: 0, y: 0, z: 0, d: Infinity };

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
  /**
   * HOW FAR UNDER THE MOUNTAIN, 0..1. See CHANNELS and `markDepth`.
   *
   * `deep` was computed, splined, truncated by every path in the file and read
   * by NOTHING for its whole life, and the channel's own comment says what it is
   * for: "so that the light can get stranger and more plentiful with depth …
   * and the audio can open up". Publishing it here is what lets the audio have
   * it, because the audio has no path and no ring — it has a listener position
   * and this sample.
   *
   * IT IS NOT `along`, AND THE DIFFERENCE IS THE WHOLE POINT. `caveDepth` is
   * metres WALKED, which DEEP_FULL's own block argues is the wrong measure —
   * "you can walk a hundred metres of level tube and be nowhere". A descent is
   * the thing the cave rewards and the thing every consumer downstream actually
   * meant.
   */
  deep: 0,
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
  _sample.deep = 0;
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
   *
   * …AND "BEST" WAS `inside`, WHICH SATURATES, SO IT WAS STILL FIRST-WINS
   * EVERYWHERE IT MATTERED. THIS IS THE BUG THAT SEALED EVERY SIDE PASSAGE.
   *
   * `inside` is a crossfade for the fog and the reverb: it is a ramp `slack`
   * metres wide hung off the WALL, and it is flat 1 across the entire interior
   * of every passage. So at a junction both paths answer exactly 1, the test
   * `inside <= bestInside` keeps the incumbent, and the incumbent is the main
   * line because it is `paths[0]`. The branch could only win by being MORE than
   * fully inside, which is not a number. Every consequence follows from that:
   * the governing wall is the main tube's, the push holds the body off the main
   * wall, and the branch's mouth is on the far side of it.
   *
   * Measured with `cave-branch`, which presses W at each junction: 0 of 5
   * branches on grove-01 k=0 entered, all five with the body at full walking
   * velocity and zero progress for the whole twelve seconds — the signature of
   * a push that exactly cancels a walking pace, and the third time this file has
   * produced it. 40% of the metres in a cave were unreachable.
   *
   * SO THE TWO QUESTIONS ARE SEPARATED, because they were never one question.
   * WHICH SECTION GOVERNS THE BODY is answered by `bestFit` — how far outside
   * this section the point is, in that section's own units, on its worst axis —
   * which is a real number everywhere, is already computed below for the ring
   * choice, and is comparable across passages precisely because it is
   * normalised. HOW MUCH ARE YOU IN A CAVE is `inside`, and is now the MAX over
   * every passage that claims the point rather than the winner's own — so no
   * reading of `inCave` anywhere in the project can get smaller because of this
   * change, and the hover class of bug cannot come back through it.
   *
   * The crossover is where it should be: on the main axis the main line scores
   * ~0 and the branch ~0.9, and walking at the hole they swap about halfway to
   * the wall. It moves continuously with the body, unlike a tie between two
   * saturated 1s, so the answer does not flicker.
   */
  let bestInside = 0;
  /** The governing path's fit. Smaller is deeper inside; see above. */
  let bestScore = Infinity;
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
      if (inside <= 0) continue;
      // The crossfade is the union's, not the winner's. See the block at the top.
      if (inside > bestInside) bestInside = inside;
      if (bestFit >= bestScore) continue;
      bestScore = bestFit;

      /**
       * BREAKDOWN, UNDERFOOT — AND IT IS THE DRAWN SOLID NOW, NOT A DOME OVER IT.
       *
       * The floor here is the higher of the rock and whatever is lying on it.
       *
       * WHAT THIS USED TO BE, because the failure is the whole reason the code
       * looks like this. Each block reported a dome raised over `(b.x, b.z,
       * b.rad, b.top)` — the four fields the obstacle record carried — and
       * `b.rad` is the block's NOMINAL plan radius. `_emitBlock` throws each of
       * the seven base corners to `rad * 0.26..1.5` of it, puts a SEPARATE,
       * smaller top polygon on top (`shrink` 0.28-0.72, shoved sideways by up to
       * half the radius), and leans the whole solid over by up to 0.7 m per
       * metre. None of that reached this function. Measured on grove-01 k=0 and
       * k=-1, 278 probes standing on a block, against the drawn geometry in the
       * body's own column:
       *
       *   dd / b.rad     drawn height, in units of b.top      p10   median   p90
       *   0.0 - 0.2                                         -0.02     0.94  1.00
       *   0.2 - 0.4                                         -0.00     0.58  0.98
       *   0.4 - 0.6                                         -0.13     0.05  0.93
       *   0.6 - 0.8                                         -0.13     0.02  0.69
       *   0.8 - 1.0                                         -0.27    -0.02  0.44
       *
       * Past 0.4 of the nominal radius the MEDIAN drawn block is gone. The p10
       * and p90 columns straddle the block's whole height in EVERY band, which is
       * the finding that matters: the drawn height is bimodal in `dd` and no dome
       * of any shape can be a function of it. Searched over 243 of them and the
       * entire Pareto front traded hovering for wading at a fixed total of ~78
       * bad stands out of 278; the one that shipped removed the hover (173 -> 10,
       * worst 2.35 m -> 1.18 m) and paid 69 wading stands for it.
       *
       * SO THE DOME IS GONE AND THIS EVALUATES THE MESH. `prepare` now solves
       * each slab once into `path.obsSolid` (see `blockSolid`) and `blockTopAt`
       * intersects the column against the SAME triangles `_emitBlock` emits from
       * the same forty floats — the seven jittered base corners, the shrunk and
       * skewed top polygon with its per-corner breaks and its rock relief, the
       * lean already folded into the corner heights. There is no fitted constant
       * left: BLOCK_REACH and BLOCK_RISE were deleted along with the dome, and
       * the collider cannot disagree with the mesh about a block by construction.
       *
       * WHAT IT COSTS IS NOTHING MEASURABLE, and it was priced properly because
       * every constant in this file that was assumed free was not.
       *
       * A/B in one page behind a temporary flag, so the two arms could not
       * differ by anything but the code: grove-01 k=0, the 24 m breakdown
       * chamber at ring 881, 200 000 calls a run, five runs each interleaved
       * after twelve warm-up runs. The first attempt sampled a GRID across the
       * chamber and priced the wrong thing — 5 columns in 256 had a slab under
       * them, so 98% of the samples never reached this loop and both arms
       * measured 6.9 us. Sampled instead at 256 points drawn inside the blocks'
       * own reach, 131 of 256 standing on one: dome 9.393 us a call, exact solid
       * 9.216 us. Delta -0.177 us against a run-to-run spread of 0.6, i.e. no
       * difference, and if anything the new one is faster.
       *
       * It has no right to be free and it is, for two reasons. The reject is a
       * SQUARED distance against the block's widest corner (`b.reach`, packed at
       * build) where the dome needed a `Math.hypot` for its ramp; and
       * `blockTopAt` returns on the first hit in the top fan, which is the case
       * the body is in whenever it is actually standing on one, so the common
       * path is about four triangle tests and not twenty-one.
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
        const solid = path.obsSolid;
        for (let o = lo; o < hi; o++) {
          const b = obs[o];
          const dx = x - b.x;
          const dz = z - b.z;
          if (b.kind === 1) {
            // A pillar: the body goes round it. Nearest one wins — two columns
            // close enough to be inside at once is rare and either push is fine.
            const dd = Math.hypot(dx, dz);
            if (dd > b.rad) continue;
            if (postR === 0 || b.rad - dd > postR - Math.hypot(x - postX, z - postZ)) {
              postX = b.x;
              postZ = b.z;
              postR = b.rad;
            }
            continue;
          }
          // Squared, and against the widest corner rather than the nominal
          // radius: the drawn base reaches 1.5x it, and the columns this used to
          // skip are exactly the ones the body was walking through.
          const dd2 = dx * dx + dz * dz;
          /**
           * THE PART OF THE SLAB YOU GO ROUND, WHICH IS NEW AND WHICH THE DOME
           * NEVER NEEDED.
           *
           * `placeBlocks` says breakdown is "walked on, not walked around", and
           * the dome is what made that true: it ramped to nothing at the rim, so
           * every slab in the world was a hill. The drawn slab is not a hill. It
           * has a lid up to 2.4 m over the silt and a fracture face under it that
           * is near-vertical on at least one side, and the moment this function
           * started reporting that honestly the step rule in `controller.js`
           * refused to climb it — correctly — and then did nothing else, because
           * blocking is all that rule does. `cave-walk` went from three mouths to
           * two: k=1 held W into a 1.07 m slab for forty seconds, 2.2 m inside a
           * passage ten metres wide.
           *
           * A boulder you cannot step onto is one you walk ROUND, so it is
           * published as a post — the same field a column uses, applied by the
           * same displacement push, with no new mechanism anywhere. Gated on the
           * body's FEET rather than on the block's height so that a body already
           * standing on one slab is not shoved off it by the taller slab it is
           * about to step onto: `y - BODY_EYE` is where the feet are, and the
           * test is the same one the step rule will apply a moment later.
           *
           * It is deliberately NOT gated on the body being inside the solid.
           * That was the first version and it does nothing at all: the step rule
           * reverts the move that put the body inside, `_resolveCave` then runs
           * at the position BEFORE the move — outside, where the column misses
           * the solid and no post is published — and the body is stuck in exactly
           * the same place, one frame later. A push has to exist before the body
           * arrives, which is why the wall radius is a property of the block.
           */
          if (
            b.wall > 0 &&
            dd2 < (b.wall + 0.5) * (b.wall + 0.5) &&
            b.y + b.top > y - BODY_EYE + BLOCK_STEP
          ) {
            const dd = Math.sqrt(dd2);
            if (postR === 0 || b.wall - dd > postR - Math.hypot(x - postX, z - postZ)) {
              postX = b.x;
              postZ = b.z;
              postR = b.wall;
            }
          }
          if (dd2 > b.reach * b.reach) continue;
          const top = blockTopAt(solid, b.si, x, z);
          // Only if the body could plausibly be standing on it: a block whose
          // top is above your head is a wall, and reporting it as floor would
          // teleport you onto the roof of a slab you are walking past. A miss
          // comes back as -Infinity and fails the first half of this.
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

      // Overwritten after both loops with the union's maximum — a later passage
      // may claim the point more strongly than the one that governs it.
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
      /**
       * …AND A LOOP HAS NO END TO STOP AT, WHICH IS THE ONE THING THIS BLOCK
       * MUST NOT DO TO ONE.
       *
       * The overrun correction exists because walking into a closed passage met
       * nothing: the dome is single-sided and facing away, so the body carried
       * on through the mountain. A closure's last ring is not a dome, it is a
       * full-size section standing inside another passage's bore, and walking
       * forward there is meant to take you into that passage — which claims the
       * body the moment its own fit wins, exactly as a branch claims it at the
       * base weld. Applying the axial stop here would push the player back out
       * of the junction they are walking through, with a force that is purely
       * along the axis and therefore exactly the walking-pace cancellation this
       * file has produced three times and documented twice.
       */
      const endR = path.endRing ?? n - 1;
      _sample.axial = 0;
      if (!path.loopEnd && bi >= endR - 3) {
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
      /**
       * …AND INFINITY IN A LOOP'S TAIL, WHERE THE SECOND WELD CAN SEE OUT.
       *
       * `blind` is a threshold on a depth measured through the TREE, from the
       * base weld, so it says nothing at all about the other end of a passage
       * that has two. `blindTail` is the metres back from the far weld inside
       * which the forest must stay submitted; it is zero — and this whole test
       * is one compare — for every path in the world except a closure whose
       * target is not already blind. See `loopBlindTail`, which is where the
       * measuring is done and where the argument is.
       */
      _sample.blind = path.blind ?? Infinity;
      if (path.blindTail > 0) {
        const endA = path.along[path.endRing ?? n - 1];
        if (endA - path.along[bi] < path.blindTail) _sample.blind = Infinity;
      }
      _sample.tight = clamp01((3.3 - span) / 2.1);
      _sample.room = clamp01((span - 2.6) / 6.2);
      _sample.water = path.waterAudio ? path.waterAudio[bi] : 0;
      // Straight off the channel `resample` splined and `markDepth` filled. No
      // arithmetic here on purpose: the one thing `deep` exists to prevent is
      // four consumers each re-deriving "how deep is this" slightly differently.
      _sample.deep = path.deep ? path.deep[bi] : 0;
      _sample.postX = postX;
      _sample.postZ = postZ;
      _sample.postR = postR;
    }
  }
  if (bestScore === Infinity) return outside();
  _sample.inside = bestInside;
  return _sample;
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
    /**
     * MAY A ROOST GO UP ON ITS OWN? See `Cave.checkFlush`.
     *
     * Off under automation, and this is the AUTOMATION PINNING rule applied to a
     * new time-varying global exactly as `dayPhase` and `rainAtTime` apply it.
     * Fifteen or so pixel-diffing scripts photograph one fixed world; a colony
     * that peeled off a ceiling because a scripted walk happened to pass within
     * thirteen metres would make every cave screenshot that contains a chamber
     * non-reproducible, and the failure would look like a rendering regression
     * rather than like a bat.
     *
     * A FLAG AND NOT A HARD GATE, because the three precedents all leave a way
     * back in: a script that wants to photograph the flush sets this true and
     * gets it. `RR.caves.autoFlush = true`.
     */
    this.autoFlush = !(typeof navigator !== 'undefined' && navigator.webdriver);
    /**
     * Called once, with the roost, on the frame a ceiling comes off. Assigned by
     * main.js so the sound can be made by the file that owns the audio graph.
     * Null in a build with no audio, which is every instrument.
     */
    this.onFlush = null;
  }

  /**
   * "Is every cave in range finished?" — the third streaming ring's answer to
   * the question `forest.settled` answers for the other two.
   *
   * IT EXISTS BECAUSE ITS ABSENCE FAKED A REGRESSION. `check:potato` measures
   * each preset and then puts ultra back to prove the new rung cost the ladder
   * nothing, and for two rounds that comparison reported ultra GAINING 278 384
   * triangles and four draw calls over the run. Every suspect was in the forest
   * and every one of them was innocent: the whole difference was `cave`,
   * `cave-shafts` and `cave-fungi` appearing between the first reading and the
   * last. A cave is built at 0.6 ms a frame — see BUILD_MS — so the nearest one
   * takes tens of seconds, and an instrument that waits for `forest.settled`
   * and then measures is photographing a world with no caves in it.
   *
   * That is the same fault this repo has now recorded five times under
   * `settling-by-frame-count-lies`, with a new twist: the wait was not too
   * SHORT, it was pointed at the wrong subsystem. A settle signal is only as
   * complete as the list of things it asks.
   *
   * `caves.size === 0` is settled, not unsettled: standing somewhere with no
   * mouth within BUILD_RANGE is a finished state, not a pending one.
   */
  get settled() {
    for (const cave of this.caves.values()) if (!cave.ready) return false;
    return true;
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
    /**
     * …AND THE ROOSTS, IN THE SAME PASS, BECAUSE THE LOOP IS ALREADY HERE.
     *
     * This is the entire per-frame cost of the colony: at most five caves, at
     * most two roosts each, one height window and one squared distance apiece.
     * Ten compares against a 0.60 ms underground frame. Everything else about
     * two hundred animals — where each one is, which way it is facing, how far
     * through the peel it is — is derived in the vertex shader from the one
     * float this writes. See `Cave.checkFlush`.
     *
     * `tripUniforms.uTime` and not a local accumulator: it is `worldClock()`, so
     * the flush time is on the same clock every client and every shader in the
     * game reads, which is what the "anything that varies over time must be a
     * pure function of worldClock" rule is for.
     */
    const now = tripUniforms.uTime.value;
    for (const cave of this.caves.values()) {
      if (
        this.autoFlush &&
        cave.checkFlush(camera.position.x, camera.position.y, camera.position.z, now)
      ) {
        /**
         * THE SOUND IS NOT THIS MODULE'S TO MAKE, AND THE CALLBACK IS WHY.
         *
         * `caves.js` knows where two hundred bats are; `audio/cave.js` knows what
         * bus a wet transient goes on. Importing the audio here would make the
         * world module depend on the audio graph — the exact coupling the top of
         * the audio file spends a paragraph refusing in the other direction ("it
         * does not own the room, it drives it"). One optional callback, assigned
         * by main.js, keeps the two apart and keeps the trigger in the one place
         * that has both the camera and the roost.
         */
        this.onFlush?.(cave.flushed);
      }
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
   * THE NEAREST DOORWAY, SO SOMETHING CAN COME OUT OF IT.
   *
   * `audio/cave.js` is silent whenever the mix is zero — i.e. everywhere outside
   * — so a cave mouth has never made a sound you could hear from the wood. This
   * project has three recorded failed attempts at a landmark visible past forty
   * metres of canopy (`forest-hides-everything-under-40m`), and the honest
   * conclusion of all three is that sight is the wrong medium: a rainforest
   * canopy is opaque and a hillside is opaque, and sound is neither.
   *
   * THE POSITION IS THE PATH'S RING ZERO WHERE THERE IS ONE. The descriptor's
   * x/z is the gully's own frame origin, which is a few metres from the arch;
   * the built passage knows exactly where its doorway is. The fallback matters
   * because the audio should start hearing the mouth from seventy metres, which
   * is well before the mesh exists at BUILD_RANGE's three hundred and twenty —
   * no, the other way round, and this is worth being precise about: the cave is
   * built LONG before you can hear it, so the fallback is for the single frame
   * between a descriptor arriving and its plan finishing.
   *
   * Into a reused object, because this is called once a frame from the audio.
   */
  nearestMouth(px, pz) {
    let best = null;
    let bd = Infinity;
    for (const cave of this.caves.values()) {
      const d = Math.hypot(cave.c.x - px, cave.c.z - pz);
      if (d < bd) {
        bd = d;
        best = cave;
      }
    }
    if (!best) return null;
    const p = best.prepared ? best.path : null;
    _mouth.k = best.c.k;
    _mouth.x = p ? p.x[0] : best.c.x;
    _mouth.z = p ? p.z[0] : best.c.z;
    /**
     * A metre and a half off the floor: the height of the sound rather than of
     * the doorway. A source at the floor of a gully is one the HRTF puts below
     * you all the way in, which reads as a drain.
     */
    _mouth.y = (p ? p.y[0] : groundUnder(best.c.x, best.c.z)) + 1.5;
    _mouth.d = Math.hypot(_mouth.x - px, _mouth.z - pz);
    return _mouth;
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
    /**
     * …AND THE BATS, WHICH ARE THE ONE THING DOWN HERE WITH A PER-CAVE MATERIAL.
     *
     * It has to be a loop rather than one write for the reason `batMaterial`
     * gives: `uFlush` is a fact about a particular roost, so the material cannot
     * be shared, so the fog cannot be set once. Three to five caves, twice a
     * frame's worth of work — and skipping it is not an option, because a bat
     * with no fog is a hard black cut-out at forty metres in a passage where
     * everything else has faded to the fog colour, which is the tell that it is
     * a sprite.
     *
     * BEFORE the `sharedMaterial` guard, not after: a cave whose rock has not
     * been built yet cannot have bats either, but a cave field that has been
     * disposed and is being rebuilt legitimately has bats before the module
     * singleton is recreated, and an early return there would leave them unfogged
     * for a frame.
     */
    for (const cave of this.caves.values()) {
      const u = cave.batMaterial?.uniforms;
      if (!u) continue;
      u.fogColor.value.copy(colour);
      u.fogDensity.value = density;
    }
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

  /**
   * THE LIGHTS SOMEBODY BROUGHT IN. Written once a frame from main.js, beside
   * `setFog` and `setDaylight`, and for exactly the same reason those two are:
   * they move, and the bake cannot.
   *
   * @param {Array<{x,y,z,radius,r,g,b}>} list nearest first, at most four used.
   *   `r,g,b` are LINEAR and are the colour ALREADY multiplied by the lamp's
   *   power — a fire at 3 m and a fire at 30 m are the same object with the same
   *   uniform, and only the caller knows which one the player is standing at.
   *
   * NEAREST FIRST IS THE CALLER'S JOB AND IS LOAD-BEARING. Four slots is a hard
   * cap; a fifth lamp is silently ignored, and the only ordering under which
   * that is the right answer is one where the ignored one is the furthest away.
   * Sorting here would mean this module knew where the listener was, which it
   * does not and should not.
   *
   * WRITTEN EVEN WHEN THE LIST IS EMPTY, because the alternative is a lamp that
   * outlives the fire it came from: a slot is only cleared by something writing
   * zero into it, and "the player put the torch away" is exactly the frame on
   * which nobody would think to call this. The cost of clearing four slots is
   * eight stores.
   */
  setLamps(list) {
    if (!sharedMaterial) return;
    const u = sharedMaterial.uniforms;
    for (let i = 0; i < 4; i++) {
      const l = list ? list[i] : null;
      const p = u.uLampPos.value[i];
      const c = u.uLampCol.value[i];
      if (l) {
        // 6 m is a campfire's useful reach on rock, and is the default so a
        // caller that has a position and a colour and no opinion about size
        // gets something sensible rather than a divide guarded to 0.01.
        p.set(l.x, l.y, l.z, l.radius ?? 6);
        c.set(l.r, l.g, l.b);
      } else {
        p.set(0, 0, 0, 0);
        c.set(0, 0, 0);
      }
    }
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
