import * as THREE from 'three';
import { clamp, clamp01, fbm2, makeRng, noise2, rngRange, TAU } from '../core/util.js';
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
/** Vertices around a ring. 20 puts a facet at 18 degrees, which noise hides. */
const RADIAL = 20;
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
/** Cross-section: half-width, half-height and floor, as multiples of radius. */
const SEC_WIDE = 1.3;
const SEC_TALL = 0.98;
const SEC_FLOOR = 0.52;
/** Rock displacement, in metres per metre of radius, on the walls. */
const ROUGH = 0.235;
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
    nodes.push({ x: g.p.x, y: f + r * SEC_FLOOR, z: g.p.z, r });
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
      const turn = rngRange(rng, -0.62, 0.62) * (attempt === 0 ? 1 : 1.6);
      const dive = rngRange(rng, -0.2, 0.14);
      const step = rngRange(rng, 8, 14);
      const h = heading + turn;
      const p = clamp(pitch + dive, -0.44, 0.1);
      const nx = x + Math.cos(h) * step * Math.cos(p);
      const nz = z + Math.sin(h) * step * Math.cos(p);
      let ny = y + Math.sin(p) * step;
      const r = rng() < 0.19 ? rngRange(rng, 6.5, 10.5) : rngRange(rng, 2.5, 4.3);

      /**
       * Never break the surface. This is the one hard constraint in the walk:
       * the tube's ceiling stays ROOF_ROCK below the hillside wherever it
       * wanders, so it can leave the mountain, run under the valley and come
       * back and there is still rock overhead. The clamp is one-sided — a
       * passage is allowed to be far deeper than it asked for, and pulling one
       * up to meet a request would be the thing that surfaces it.
       */
      ny = Math.min(ny, heightAt(nx, nz) - r * SEC_TALL - ROOF_ROCK);
      ny = Math.max(ny, bottom);

      let clash = false;
      for (let j = 0; j < nodes.length - 2 && !clash; j++) {
        const n = nodes[j];
        const dx = n.x - nx;
        const dy = n.y - ny;
        const dz = n.z - nz;
        const min = (n.r + r) * SEC_WIDE + 3.5;
        if (dx * dx + dy * dy + dz * dz < min * min) clash = true;
      }
      if (clash && attempt < 5) continue;

      heading = h;
      pitch = p;
      x = nx;
      y = ny;
      z = nz;
      nodes.push({ x, y, z, r });
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
  nodes.push({ x: x + Math.cos(heading) * 4, y: last.y - 1.2, z: z + Math.sin(heading) * 4, r: last.r * 0.55 });
  nodes.push({ x: x + Math.cos(heading) * 6, y: last.y - 1.6, z: z + Math.sin(heading) * 6, r: 0.05 });
  return nodes;
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
  const cx = [];
  const cy = [];
  const cz = [];
  const cr = [];
  const seg = nodes.length - 1;
  for (let i = 0; i < seg; i++) {
    const p0 = nodes[Math.max(0, i - 1)];
    const p1 = nodes[i];
    const p2 = nodes[i + 1];
    const p3 = nodes[Math.min(seg, i + 2)];
    const span = Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
    const steps = Math.max(1, Math.round(span / RING_STEP));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      cx.push(spline(p0.x, p1.x, p2.x, p3.x, t));
      cy.push(spline(p0.y, p1.y, p2.y, p3.y, t));
      cz.push(spline(p0.z, p1.z, p2.z, p3.z, t));
      cr.push(Math.max(0.05, spline(p0.r, p1.r, p2.r, p3.r, t)));
    }
  }
  const end = nodes[seg];
  cx.push(end.x);
  cy.push(end.y);
  cz.push(end.z);
  cr.push(end.r);
  return {
    x: Float64Array.from(cx),
    y: Float64Array.from(cy),
    z: Float64Array.from(cz),
    r: Float64Array.from(cr),
  };
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
    const top = path.y[i] + path.r[i] * SEC_TALL + 0.5;
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
      if (ox * ox + oy * oy + oz * oz > (path.r[j] * 0.62) ** 2) return along[i] + 14;
    }
  }
  // A passage with no bend in it at all. Nothing is ever out of sight, so
  // nothing is ever hidden — which is the safe answer, not a failure.
  return Infinity;
}

/** The cross-section outline: an ellipse with its bottom cut off flat. */
function section(phi, out) {
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  const ex = cp / SEC_WIDE;
  const ey = sp / SEC_TALL;
  let t = 1 / Math.sqrt(ex * ex + ey * ey);
  if (sp < -1e-4) t = Math.min(t, SEC_FLOOR / -sp);
  out.x = cp * t;
  out.y = sp * t;
  return out;
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

function placeFungi(c, path) {
  const rng = makeRng(`${getWorldSeed()}:cave-fungi:${c.k}`);
  const n = path.x.length;
  const out = [];
  const tmp = { x: 0, y: 0 };
  /**
   * Never at the mouth. The first fifteen metres are lit by the sky and a
   * glowing mushroom in daylight is a mushroom nobody notices; starting them
   * where the daylight has gone is also what makes walking in feel like walking
   * from one lighting scheme into another rather than into a dimmer.
   */
  let i = 14 + Math.floor(rng() * 8);
  while (i < n - 6) {
    const r = path.r[i];
    // On the wall, low, where you would actually find them.
    const phi = (rng() < 0.5 ? -1 : 1) * rngRange(rng, 0.15, 1.15) + (rng() < 0.5 ? 0 : Math.PI);
    section(phi, tmp);
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
      attribute float aDay;
      attribute float aOut;
      varying vec3 vRock;
      varying vec3 vLit;
      varying float vDay;
      varying float vOut;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vDepthFog;
      void main() {
        vRock = aRock;
        vLit = aLit;
        vDay = aDay;
        vOut = aOut;
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
        float rrFloorish = clamp(-normal.y, 0.0, 1.0);
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
      varying vec3 vRock;
      varying vec3 vLit;
      varying float vDay;
      varying float vOut;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vDepthFog;

      void main() {
        vec3 n = normalize(vNormal);
        vec3 toEye = uEye - vWorld;
        float dist = length(toEye);

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
        float bed = sin(vWorld.y * 2.2 + grain * 5.2) * 0.5 + 0.5;

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
    this.fungi = null;
    this.mesh = null;
    this.points = null;
    this.group = new THREE.Group();
    this.group.name = `cave-${descriptor.k}`;
    this.ready = false;
    this._ring = 0;
    this._hood = 0;
    this._buffers = null;
    /** Cursor into the ring list for `caveSample`. See the scan there. */
    this._hint = 0;
  }

  /** Everything the collision line needs, and nothing that touches the GPU. */
  prepare() {
    if (this.path) return;
    this.path = resample(buildNodes(this.c));
    this.fungi = placeFungi(this.c, this.path);
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
    this.length = along[n - 1];
    this.blind = blindAlong(this.path, along);

    const hood = this._hood;
    const verts = (n + hood + 1) * RADIAL;
    this._buffers = {
      position: new Float32Array(verts * 3),
      normal: new Float32Array(verts * 3),
      rock: new Float32Array(verts * 3),
      lit: new Float32Array(verts * 3),
      day: new Float32Array(verts),
      out: new Float32Array(verts),
      index: new Uint32Array((n - 1 + hood + 1) * RADIAL * 6),
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
    const path = this.path;
    const n = path.x.length;
    const hood = this._hood;
    const total = n + hood + 1;
    const end = Math.min(total, this._ring + RINGS_PER_FRAME);

    for (; this._ring < end; this._ring++) {
      const ri = this._ring;
      // The inner surface, then the hood's shell over the same leading rings.
      const isHood = ri >= n;
      const i = isHood ? Math.min(ri - n, hood) : ri;
      // 1 at the rim, 0 at the last hooded ring. Everything the crag does is a
      // function of this one number.
      const taper = isHood ? 1 - (ri - n) / hood : 0;
      this._emitRing(ri, i, taper, isHood);
    }

    if (this._ring < total) return false;
    this._link(n, hood);
    this._finish();
    return true;
  }

  _emitRing(slot, i, taper, isHood) {
    const b = this._buffers;
    const path = this.path;
    const n = path.x.length;
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

    const day = this._daylight(i);
    const sec = { x: 0, y: 0 };

    for (let j = 0; j < RADIAL; j++) {
      const phi = (j / RADIAL) * TAU - Math.PI * 0.5;
      section(phi, sec);
      const floorish = clamp01(-sec.y / SEC_FLOOR);
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
      const amp =
        r * (ROUGH_FLOOR + (ROUGH - ROUGH_FLOOR) * (1 - floorish)) * (isHood ? 1.6 + 2.6 * lip : 1);

      // Position on the smooth outline, then displaced radially by the rock.
      let ox = sec.x * r;
      let oy = sec.y * r;
      const outLen = Math.hypot(ox, oy) || 1;
      const px0 = cx + rx * ox + (ux / ul) * oy;
      const py0 = cy + (uy / ul) * oy;
      const pz0 = cz + rz * ox + (uz / ul) * oy;
      const rn = rock(px0, py0, pz0);
      // The brow: the shell is thicker over the doorway than under it, where
      // there is only hillside to be thick into. See HOOD_BROW.
      const disp = rn * amp + thick * (1 + (isHood ? HOOD_BROW * clamp01(sec.y / SEC_TALL) : 0));
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

      const k = (slot * RADIAL + j) * 3;
      b.position[k] = px - this.originX;
      b.position[k + 1] = py - this.originY;
      b.position[k + 2] = pz - this.originZ;
      b.day[slot * RADIAL + j] = isHood ? day * 0.35 : day;
      b.out[slot * RADIAL + j] = outside;
      this._shade(k, px, py, pz, floorish);
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
  _daylight(i) {
    return Math.exp(-this.along[i] / 14) * 0.42;
  }

  /** Baked albedo, and separately the baked light landing on it. */
  _shade(k, x, y, z, floorish) {
    const b = this._buffers;
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
  _link(n, hood) {
    const b = this._buffers;
    let t = 0;
    // The cavity: the surface you are standing inside, facing in.
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < RADIAL; j++) {
        const j2 = (j + 1) % RADIAL;
        const a = i * RADIAL + j;
        const c = i * RADIAL + j2;
        const d = (i + 1) * RADIAL + j;
        const e = (i + 1) * RADIAL + j2;
        b.index[t++] = a;
        b.index[t++] = c;
        b.index[t++] = d;
        b.index[t++] = c;
        b.index[t++] = e;
        b.index[t++] = d;
      }
    }
    // The hood's outer shell, wound the other way so it faces out.
    for (let i = 0; i < hood; i++) {
      for (let j = 0; j < RADIAL; j++) {
        const j2 = (j + 1) % RADIAL;
        const a = (n + i) * RADIAL + j;
        const c = (n + i) * RADIAL + j2;
        const d = (n + i + 1) * RADIAL + j;
        const e = (n + i + 1) * RADIAL + j2;
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
      const d = n * RADIAL + j;
      const e = n * RADIAL + j2;
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
    const n = this.path.x.length;
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
    for (let ri = 0; ri < n + hood + 1; ri++) {
      const isHood = ri >= n;
      const i = isHood ? Math.min(ri - n, hood) : ri;
      const rowA = Math.max(isHood ? n : 0, ri - 1);
      const rowB = Math.min(isHood ? n + hood : n - 1, ri + 1);
      const cx = this.path.x[i] - this.originX;
      const cy = this.path.y[i] - this.originY;
      const cz = this.path.z[i] - this.originZ;
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
        b.day[ri * RADIAL + j] *= 0.28 + 0.72 * clamp01(ny);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(b.position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(b.normal, 3));
    geo.setAttribute('aRock', new THREE.BufferAttribute(b.rock, 3));
    geo.setAttribute('aLit', new THREE.BufferAttribute(b.lit, 3));
    geo.setAttribute('aDay', new THREE.BufferAttribute(b.day, 1));
    geo.setAttribute('aOut', new THREE.BufferAttribute(b.out, 1));
    geo.setIndex(new THREE.BufferAttribute(b.index.subarray(0, b.tri), 1));
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
   * So this mirrors `_buildMesh` above: indexed, with `normal`, `aRock`,
   * `aLit`, `aDay` and `aOut`. If that attribute list ever changes, this has to
   * change with it — and the test for whether it did is `npm run perf:spikes`,
   * which reports the name of anything that compiles during a walk.
   */
  const rock = new THREE.BufferGeometry();
  rock.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  rock.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
  rock.setAttribute('aRock', new THREE.BufferAttribute(new Float32Array(9), 3));
  rock.setAttribute('aLit', new THREE.BufferAttribute(new Float32Array(9), 3));
  rock.setAttribute('aDay', new THREE.BufferAttribute(new Float32Array(3), 1));
  rock.setAttribute('aOut', new THREE.BufferAttribute(new Float32Array(3), 1));
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
  ring: 0,
  along: 0,
  radial: 0,
  radius: 0,
  floor: 0,
  ceiling: 0,
  cx: 0,
  cy: 0,
  cz: 0,
};

/** A null answer, reused, so the callers never allocate and never see stale data. */
function outside() {
  _sample.inside = 0;
  _sample.cave = null;
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
  for (let ci = 0; ci < live.length; ci++) {
    const cave = live[ci];
    const path = cave.path;
    if (!path) continue;
    const n = path.x.length;
    let best = Infinity;
    let bi = 0;
    const from = Math.max(0, cave._hint - 30);
    const to = Math.min(n, cave._hint + 31);
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
    const d = Math.sqrt(best);
    if (d > r * SEC_WIDE + 2.5) continue;

    cave._hint = bi;
    const floor = path.y[bi] - r * SEC_FLOOR;
    const ceiling = path.y[bi] + r * SEC_TALL;
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
    if (bi === 0 && n > 1) {
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
    _sample.inside =
      clamp01(1.35 - horiz / (r * SEC_WIDE)) * clamp01((ceiling + 1.2 - y) / 1.2) * ends;
    _sample.cave = cave;
    _sample.ring = bi;
    _sample.along = cave.along[bi];
    _sample.radial = horiz;
    _sample.radius = r;
    _sample.floor = floor;
    _sample.ceiling = ceiling;
    _sample.cx = path.x[bi];
    _sample.cy = path.y[bi];
    _sample.cz = path.z[bi];
    if (_sample.inside > 0) return _sample;
  }
  return outside();
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
    live = [...this.caves.values()].filter((c) => c.path);
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
    const want = mix > 0.995 && cave !== null && depth > cave.blind;
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
