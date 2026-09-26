import { clamp01, makeRng, rngRange, smoothstep } from '../core/util.js';
import {
  WATER_LEVEL,
  cavesNear,
  getWorldSeed,
  heightAt,
  slopeAt,
  streamBearing,
  streamPointNear,
  wetness,
} from './terrain.js';

/**
 * WHERE PEOPLE MEET, decided by measuring the ground.
 *
 * This module holds the ANSWER — a handful of coordinates — and nothing that
 * draws it. That split is not tidiness. `scatter.js` has to know these places
 * exist so it can leave room for them, and `scatter.js` runs inside a worker
 * that cannot import THREE, a material, or anything that touches a canvas. So
 * everything a worker needs is here, and everything that makes a mesh out of it
 * is in `gathering.js`.
 *
 *
 * WHY THE FOREST HAS TO BE TOLD.
 *
 * The first build put a fourteen-metre screen, three rows of benches and four
 * fires into the world without touching the tree field, on the reasoning that
 * the site chooser already prefers flat, dry ground. The photographs were
 * unambiguous: a cinema in a thicket. You could not see the screen from the back
 * row because there were four trunks in the way, and you could not walk between
 * the benches at all. Flat ground in a forest is where the forest most wants to
 * be — `forestDensity` scales by `1 - slope * 2.4`, so choosing the flattest
 * spot for a hundred metres is choosing the densest one.
 *
 * `forestDensity` already has exactly this mechanism twice over: the spawn
 * clearing is a hole in the field, and `caveClearance` is a hole in front of
 * every cave mouth for the same reason — the one thing that has to be legible
 * from a distance was the one thing being screened. This is the third instance
 * of the same idea, and it reads the same table the props are built from, so the
 * hole in the wood cannot drift out of register with the thing standing in it.
 *
 *
 * IT IS A PURE FUNCTION OF THE SEED, AND IT HAS TO BE.
 *
 * Two people in one room build their worlds independently — nothing about the
 * world travels over the wire — so if this returned anything that depended on
 * when it was called or on which realm it ran in, one person's benches would
 * stand in another person's trees. Hence: no wall clock, no `Math.random`, and
 * the memo below keyed on the world seed rather than computed once at module
 * scope, because a worker imports this module BEFORE its init message arrives
 * and at import time the realm's seed is still zero.
 */

/* -------------------------------------------------------------------------- */
/* the search                                                                 */
/* -------------------------------------------------------------------------- */

const SEARCH_MIN_R = 30;
const SEARCH_MAX_R = 185;
const SEARCH_RINGS = 24;
const SEARCH_SPOKES = 64;

/** Half-width of the box a site's flatness is judged over. */
const FLAT_PROBE = 7;

/** Nothing may be nearer to anything else than this. */
const SITE_SPACING = 52;

/**
 * How much room each kind of place needs, in metres, and how wide the ragged
 * edge of it is.
 *
 * The commons is the big one and its number is not a taste: the screen is 13.4 m
 * wide and the back row of benches is at 17.2 m, so anything under about 22
 * leaves trees standing inside the seating. The soft rim is deliberately wider
 * than the others — a 24 m circle with a sharp edge is a crop circle, and the
 * one thing a clearing must not look like is a stencil.
 */
export const SITE_RADIUS = {
  commons: 23,
  hearth: 6.2,
  viewpoint: 8.5,
  jetty: 6.5,
};
const SITE_RIM = {
  commons: 11,
  hearth: 5,
  viewpoint: 6,
  jetty: 4.5,
};

/**
 * How level, dry and walkable a place is.
 *
 * `relief` is the range of the height field over a 14 m box — the number that
 * decides whether a bench stands on the ground or hovers at one end. Sampled on
 * a 3×3 rather than densely, because the field has no high-frequency content at
 * this scale: `terrain.js` soft-floors and smooths, and the corners and the
 * middle bound the interior to well under the tolerance a log seat needs.
 */
function assess(x, z) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const h = heightAt(x + i * FLAT_PROBE, z + j * FLAT_PROBE);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  return { y: heightAt(x, z), relief: hi - lo, wet: wetness(x, z) };
}

/* -------------------------------------------------------------------------- */
/* the river                                                                  */
/* -------------------------------------------------------------------------- */

/** Metres of water needed under a flat-bottomed raft. See `solveReach`. */
const MIN_DEPTH = 0.34;
const SEARCH_M = 900;
const SEARCH_STEP = 6;
/**
 * How far from the origin the ferry service runs, either way.
 *
 * MEASURED AGAINST THE WAIT, which is the only number a passenger experiences.
 * `grove-01`'s river is navigable for 758 m, and a raft serving all of it takes
 * fifteen minutes to come round — so somebody who walks down to the landing just
 * after it left stands there for seven. That is not a slow ferry, it is a broken
 * one. 240 m either way puts the round trip at about seven minutes with three
 * landings on it, and it keeps the whole route inside the part of the world that
 * has anything in it.
 */
const SERVICE_HALF_M = 240;

const _point = { x: 0, y: 0, z: 0, angle: 0 };

/**
 * Where on the centre line the along-channel parameter `u` puts you.
 *
 * Feeding `streamPointNear` a point that is already on the axis is exact rather
 * than approximate: for P = u·(cos, sin) the projection u' = x·cos + z·sin is
 * u·cos² + u·sin² = u, so the function's own parameterisation and this one are
 * the same number.
 */
export function pointAt(u, out = _point) {
  const bearing = streamBearing();
  return streamPointNear(u * Math.cos(bearing), u * Math.sin(bearing), out);
}

/**
 * Measure the river and find the longest stretch a raft can actually use.
 *
 * Returns `{u0, u1, length}` along the channel, or null when this world's river
 * has no navigable water near the origin — a legitimate outcome for a seed whose
 * stream runs high, and one the caller must handle by not having a ferry rather
 * than by pretending. Measured across three seeded worlds: `grove-01` is
 * navigable end to end, and `ash-hollow-4471` has two hundred metres where the
 * bed stands 87 cm ABOVE the water plane.
 */
export function solveReach() {
  let bestStart = null;
  let bestLength = 0;
  let runStart = null;

  for (let u = -SEARCH_M; u <= SEARCH_M; u += SEARCH_STEP) {
    const p = pointAt(u);
    const depth = WATER_LEVEL - heightAt(p.x, p.z);
    if (depth >= MIN_DEPTH) {
      if (runStart === null) runStart = u;
      const length = u - runStart;
      if (length > bestLength) {
        bestLength = length;
        bestStart = runStart;
      }
    } else {
      runStart = null;
    }
  }

  /**
   * Short reaches are worse than none. A ferry that shuttles forty metres back
   * and forth is not a tour, it is a fairground ride, and it would be visible
   * from the bank doing it. The same posture `caves.js` takes toward a ridge
   * that does not suit it.
   */
  if (bestStart === null || bestLength < 140) return null;

  /** Keep clear of the ends, where the bed is shelving up to the threshold. */
  let u0 = bestStart + 8;
  let u1 = bestStart + bestLength - 8;
  /**
   * Trim to the served range, but never off the navigable water. Each end is
   * clamped independently and the result re-checked, so a world whose only deep
   * reach is four hundred metres upstream still gets a ferry — it just gets one
   * that runs where the water is.
   */
  const t0 = Math.max(u0, -SERVICE_HALF_M);
  const t1 = Math.min(u1, SERVICE_HALF_M);
  if (t1 - t0 >= 140) {
    u0 = t0;
    u1 = t1;
  } else if (u1 - u0 > SERVICE_HALF_M * 2) {
    if (Math.abs(u0) < Math.abs(u1)) u1 = u0 + SERVICE_HALF_M * 2;
    else u0 = u1 - SERVICE_HALF_M * 2;
  }
  return { u0, u1, length: u1 - u0 };
}

/**
 * Where the dry bank is at a point along the river, and which way the water is.
 *
 * Walks outward perpendicular to the channel until the ground comes up out of
 * the water. Both sides are tried and the gentler one wins, because a jetty on a
 * two-metre cut bank is a diving board.
 */
export function bankAt(u) {
  const centre = pointAt(u, { x: 0, y: 0, z: 0, angle: 0 });
  const nx = -Math.sin(centre.angle);
  const nz = Math.cos(centre.angle);

  let best = null;
  for (const side of [-1, 1]) {
    for (let v = 4; v <= 15; v += 0.5) {
      const x = centre.x + nx * v * side;
      const z = centre.z + nz * v * side;
      const y = heightAt(x, z);
      if (y < WATER_LEVEL + 0.35) continue;
      const climb = y - heightAt(centre.x + nx * (v - 2) * side, centre.z + nz * (v - 2) * side);
      const score = -climb - Math.abs(v - 7) * 0.1;
      if (!best || score > best.score) {
        best = {
          x,
          y,
          z,
          score,
          /**
           * Looking back across the water, which is the view worth having.
           *
           * `Controller.forward` is `(-sin yaw, -cos yaw)`, so the yaw that
           * looks along a unit vector W is `atan2(-W.x, -W.z)`. Here W points
           * from the bank back to the middle of the channel — `(-nx·side,
           * -nz·side)` — and the two negations cancel.
           */
          yaw: Math.atan2(nx * side, nz * side),
        };
      }
      break;
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* the plan                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Choose everywhere, once.
 *
 * Returns plain data, so a test can ask a world where its fires are without
 * building anything, and so it is obviously a function of the seed and nothing
 * else.
 */
/**
 * @param {string} seed
 * @param {{u0: number, u1: number}|null} [reach] a reach the caller has already
 *   measured. The default is `undefined`, not `null`, and the difference is
 *   load-bearing: `undefined` means "nobody has measured, go and do it" while an
 *   explicit `null` means "measured, and this world has no navigable water".
 *   Defaulting to `null` silently gave every world no river and therefore no
 *   landings and no ferry, with nothing anywhere reporting a problem.
 */
export function planSites(seed, reach = undefined) {
  const rng = makeRng(`${seed}:gathering`);
  const candidates = [];

  for (let ring = 0; ring < SEARCH_RINGS; ring++) {
    const r = SEARCH_MIN_R + ((SEARCH_MAX_R - SEARCH_MIN_R) * ring) / (SEARCH_RINGS - 1);
    for (let spoke = 0; spoke < SEARCH_SPOKES; spoke++) {
      /**
       * The spoke angle is jittered by the seed rather than being a clean
       * multiple of 2π/64. Without it every world's sites sit on the same
       * sixty-four bearings from the origin — invisible in any one session and
       * glaring the moment anybody compares two.
       */
      const a = (spoke / SEARCH_SPOKES) * Math.PI * 2 + rng() * ((Math.PI * 2) / SEARCH_SPOKES);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const info = assess(x, z);
      if (info.wet > 0.08) continue;
      candidates.push({ x, z, r, a, ...info });
    }
  }

  const taken = [];
  /**
   * Take the best candidate far enough from everything already chosen.
   *
   * Greedy, and the spacing test is what makes greedy work: without it every
   * site lands in the same flattest hollow, because flatness is a smooth field
   * and its best few thousand square metres are contiguous.
   */
  const take = (score, spacing = SITE_SPACING) => {
    let best = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      if (c.used) continue;
      let clear = true;
      for (const t of taken) {
        if (Math.hypot(c.x - t.x, c.z - t.z) < spacing) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      const s = score(c);
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    if (best) {
      best.used = true;
      taken.push(best);
    }
    return best;
  };

  /**
   * THE COMMONS wants the flattest large area within a walk of the origin.
   *
   * Distance is a hard preference rather than a filter: a screen and thirty
   * seats a hundred and eighty metres from where you arrive is a place nobody
   * ever finds, and the first thing a person should be able to do is stumble
   * into the room everyone is in. 55–95 m is far enough to be a destination and
   * near enough that you reach it before deciding to go anywhere.
   *
   * The fallback is a floor rather than a real answer: `take` returns null only
   * for a world with no dry ground in a 155 m annulus, which this terrain cannot
   * produce — but everything downstream is built on this, so it gets somewhere
   * rather than a crash.
   */
  const commons =
    take((c) => -c.relief * 3 - Math.abs(c.r - 72) * 0.06) ??
    { x: 0, z: -60, r: 60, a: 0, ...assess(0, -60) };

  const hearths = [];
  for (let i = 0; i < 3; i++) {
    /**
     * Fires want flat ground too, but they want it SPREAD — one in the near
     * wood, one out at the edge of things. Biasing each successive fire further
     * out gives the world a middle and an outskirts instead of a cluster.
     */
    const want = 58 + i * 46;
    const site = take((c) => -c.relief * 2.2 - Math.abs(c.r - want) * 0.05);
    if (site) hearths.push(site);
  }

  const viewpoints = [];
  for (let i = 0; i < 2; i++) {
    /**
     * The opposite request: HIGH, with the ground falling away. `relief` is a
     * virtue here rather than a fault, but only if the site itself is standable
     * — hence the flatness term surviving with a much smaller weight and the
     * altitude doing the work.
     */
    const site = take((c) => c.y * 0.5 + c.relief * 0.9 - Math.abs(c.r - (110 + i * 45)) * 0.03, 70);
    if (site) viewpoints.push(site);
  }

  /**
   * LANDINGS are chosen by a completely different rule: the ferry's navigable
   * reach decides where they can be, and the bank decides where they are.
   */
  const jetties = [];
  const water = reach === undefined ? solveReach() : reach;
  if (water) {
    const count = 3;
    for (let i = 0; i < count; i++) {
      const u = water.u0 + ((water.u1 - water.u0) * (i + 0.5)) / count;
      const bank = bankAt(u);
      if (bank) jetties.push({ ...bank, u });
    }
  }

  return { commons, hearths, viewpoints, jetties, reach: water };
}

/* -------------------------------------------------------------------------- */
/* the hole in the wood                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The memo.
 *
 * `siteClearance` is called once per scatter candidate — a few hundred thousand
 * times per streamed sector across the layers that read `forestDensity` — and
 * planning costs about fourteen thousand height samples. So it happens once per
 * world and the hot path is a guard plus one loop over a dozen circles.
 *
 * Keyed on `getWorldSeed()` exactly like `grove()` in scatter.js, and for the
 * same reason: this module is imported by the worker before its init message
 * arrives, so at import time the realm's seed is still 0 and anything computed
 * at module scope would describe the wrong world.
 */
let _seed = -1;
/** @type {{x: number, z: number, r: number, rim: number}[]} */
let _clearings = [];
/** @type {ReturnType<typeof planSites>|null} */
let _plan = null;
/**
 * The third derived structure: the ways between the places. See the block at
 * `pathClearance` for what it is and why it lives in this memo rather than in
 * a module of its own.
 */
/** @type {Segment[]} */
let _paths = [];
/** @type {Map<number, Segment[]>} */
let _pathGrid = new Map();
/**
 * The fourth derived structure: what each of the nine places is CALLED, and
 * which of them the body is currently standing in. See the block at
 * `namePlaces`. Built lazily — see the note where `ensurePlan` drops them.
 */
/** @type {Place[]|null} */
let _places = null;
/** @type {Map<object, string>|null} */
let _placeOf = null;
/** @type {Set<string>} */
const _inside = new Set();

function ensurePlan() {
  const s = getWorldSeed();
  if (s === _seed) return _plan;
  _seed = s;
  /**
   * THE NUMERIC SEED, AND EVERY CALLER MUST COME THROUGH HERE.
   *
   * A worker realm has the number and not the string — `setWorldSeed` is given
   * the string on the main thread and only the hash survives the trip. So the
   * plan is derived from the number, which both realms have, and `gathering.js`
   * asks `sitePlan()` rather than calling `planSites` with the string it happens
   * to be holding.
   *
   * That is not a style preference. Two different arguments to `makeRng` are two
   * different draws, so a main thread planning from `"ash-hollow-4471"` and a
   * worker planning from `2903414851` would choose two different sets of sites —
   * and the symptom would be a clearing in the wood with nothing in it and a
   * cinema fifty metres away with trees growing through the screen.
   */
  _plan = planSites(String(s));
  _clearings = [];
  const push = (site, kind) => {
    if (site) _clearings.push({ x: site.x, z: site.z, r: SITE_RADIUS[kind], rim: SITE_RIM[kind] });
  };
  push(_plan.commons, 'commons');
  for (const h of _plan.hearths) push(h, 'hearth');
  for (const v of _plan.viewpoints) push(v, 'viewpoint');
  for (const j of _plan.jetties) push(j, 'jetty');
  /**
   * The paths, built LAST and published last.
   *
   * `_pathGrid` is emptied before `planPaths` runs rather than after, because
   * the build samples `wetness`, `slopeAt` and `cavesNear` and a future version
   * of any of those reaching back into `pathClearance` would otherwise be
   * answered out of the PREVIOUS world's index — the same class of bug the
   * seed guard above exists for, one memo down. An empty map answers 0
   * everywhere, which is the only safe wrong answer available.
   */
  _pathGrid = new Map();
  _paths = planPaths(_plan, String(s));
  _pathGrid = indexPaths(_paths);
  /**
   * The names are dropped rather than rebuilt, and they are the one derived
   * structure in this memo that is LAZY. Naming costs two dozen `heightAt`
   * calls (the viewpoints' fall, measured with the same twenty-metre gradient
   * `gathering.js` aims the bench with), and the realm that pays for this memo
   * hardest is the scatter worker, which will never ask a place what it is
   * called. So the plan and the paths are built here, where every realm needs
   * them, and the names are built on the first realm that asks.
   *
   * `_inside` goes with them: it is where the player was standing in the world
   * that has just been thrown away.
   */
  _places = null;
  _inside.clear();
  return _plan;
}

/** The plan for the world this realm is currently building. */
export function sitePlan() {
  return ensurePlan();
}

/**
 * How much of a hole there is in the tree field at this point, 0..1.
 *
 * `smoothstep` on the rim rather than a hard edge, for the reason the spawn
 * clearing gives: the edge of a wood should be ragged, not a circle drawn on the
 * ground. The clearing itself is a full 1 — a screen with two oaks in front of
 * it is not a partial success — and the rim does the blending.
 *
 * Bailing out on the bounding box before the hypot is worth it: this runs a few
 * hundred thousand times a sector and misses on almost all of them.
 */
export function siteClearance(x, z) {
  ensurePlan();
  let most = 0;
  for (let i = 0; i < _clearings.length; i++) {
    const c = _clearings[i];
    const dx = x - c.x;
    if (dx > c.r + c.rim || dx < -c.r - c.rim) continue;
    const dz = z - c.z;
    if (dz > c.r + c.rim || dz < -c.r - c.rim) continue;
    const d = Math.hypot(dx, dz);
    if (d >= c.r + c.rim) continue;
    const k = d <= c.r ? 1 : 1 - smoothstep(clamp01((d - c.r) / c.rim));
    if (k > most) most = k;
    if (most >= 1) return 1;
  }
  return most;
}

/* -------------------------------------------------------------------------- */
/* the ways between them                                                      */
/* -------------------------------------------------------------------------- */

/**
 * PATHS. The third derived structure in the memo above, and the reason it is
 * there rather than in a module of its own.
 *
 *
 * ==== WHY THERE WAS NOTHING TO WALK ALONG =================================
 *
 * `siteClearance` is a set of circles and `trodden()` in scatter.js reads the
 * same circles with its own radii. So the nine gathering places were NINE
 * ROOMS WITH NO CORRIDORS: every one of them was a hole in the wood with a
 * ragged edge, and beyond that edge the forest was — to within the grove field
 * — homogeneous in every direction for as far as you can see, which in this
 * wood is about forty metres. Nothing on the surface of this world had a
 * DIRECTION in it. You could walk four hundred metres and the only evidence you
 * had moved was that the trees were different trees.
 *
 * A path fixes that with the cheapest thing in the project. It is not a mesh,
 * not a decal, not a texture and not a draw call: it is two scalar fields
 * sampled at scatter time, in the worker, exactly like the three holes
 * `forestDensity` already carries. The cost per frame is zero.
 *
 *
 * ==== IT IS `siteClearance` WITH A SEGMENT INSTEAD OF A CENTRE =============
 *
 * Structurally this is that function line for line — a max over primitives of a
 * smoothstep on distance, behind a bounding-box reject — and it is written that
 * way on purpose, so the two cannot drift into being different ideas about what
 * a soft edge is. The only differences are the ones a line has and a disc does
 * not:
 *
 *   THE PRIMITIVE IS A CAPSULE. Distance to a segment rather than to a point,
 *   which is four multiplies and a clamp more.
 *
 *   THERE ARE 60 TO 170 OF THEM, NOT NINE, SO THE LINEAR SCAN HAD TO GO. This
 *   is called a few hundred thousand times per streamed sector, the same as
 *   `siteClearance`; nine circles is fine to walk, and a hundred and seventy
 *   segments is fifty million bounding-box compares a sector. So the
 *   segments are filed into a 24 m hash on their own AABBs and the query is one
 *   `Math.floor` pair and one `Map.get` — which misses everywhere in the world
 *   that has no path in it, i.e. almost everywhere — and then a scan of the two
 *   or three segments that could possibly be near. The numeric key is
 *   `bucketLayer`'s trick from scatter.js, biased so it stays non-negative; a
 *   template-string key would allocate and hash a string per candidate, which
 *   is most of what that function's own comment says made the old packer slow.
 *
 *   TWO PROFILES PER SEGMENT, NOT ONE. See the block at `WAY`.
 *
 * MEASURED, in node on this machine, 500 000 calls each: a miss costs 18.5 ns
 * against `siteClearance`'s own 18.1 — i.e. adding paths to `forestDensity`
 * costs exactly one more `siteClearance`, which is the price this file has
 * always charged. For scale, the whole of `forestDensity` is 2 100–2 200 ns a
 * call (three-octave fbm, `wetness`, `slopeAt`), so this is under one per cent
 * of it. A union bounding box over all the paths as a first reject was written
 * and thrown away: at 18 ns there is nothing left to save, and the four extra
 * compares would have cost most of what they removed.
 *
 * Segment counts and build times, four seeds, same run: 58 segments / 734 m
 * (grove-01), 169 / 2050 m (ash-hollow-4471), 64 / 813 m (taiga:fen-mire-3204),
 * 148 / 1794 m (oak-shore-77), and the whole plan — sites, clearings and paths
 * — takes 9–16 ms once per world. (Those were 67 / 177 / 72 / 155 before the
 * links were trimmed back off the furniture; a hub costs about one node.) The spread is the river: a seed with three
 * landings a long way from its fires has three times the trail of one whose
 * landings are close.
 *
 *
 * ==== THE PATH TO THE CAVE IS THE POINT OF THE WHOLE THING ================
 *
 * There is a cave every 210 m along the ridge and until now literally nothing
 * in the world told you so. `cavesNear` is already exported from terrain.js and
 * this module already imports terrain.js, so the answer costs one call at
 * world-build time: the commons gets a way out of it that leads to the nearest
 * mouth. A player who follows a trodden line for two hundred metres and finds a
 * hole in a mountain has discovered something; a player who happens to walk
 * within forty metres of the same arch has noticed some scenery.
 */

/**
 * @typedef {{
 *   x0: number, z0: number, vx: number, vz: number, inv: number,
 *   minx: number, maxx: number, minz: number, maxz: number,
 *   r: number, rim: number, tr: number, trim: number,
 * }} Segment
 */

/**
 * Metres between nodes.
 *
 * The node spacing is what decides how tightly a path can turn, and 12 m is the
 * point where it can go round a wet hollow without the polyline reading as a
 * chain of straight bits. Halving it would double the segment count for a
 * curvature nothing in this terrain needs — the height field has no feature
 * finer than about 20 m at the scale a walker cares about.
 */
const PATH_SPAN = 12;

/**
 * How many lateral positions a node may try before it gives up and takes the
 * least bad, and how far apart those tries are.
 *
 * BOUNDED, because the alternative — search until you find dry, level ground —
 * is a loop with no upper bound running inside a memo that everything else
 * waits on, and on a seed whose commons sits across a bog it would never
 * terminate. The last try is always the STRAIGHT point, so the worst case
 * degenerates to a ruled line through the wet rather than to a hang.
 */
const PATH_TRIES = 6;
const PATH_STEP = 2.4;

/**
 * Nothing links two places further apart than this.
 *
 * Aimed at the cave link, which is the only one that can be long: caves are
 * 210 m apart along a crest that may pass a long way from the origin, and a
 * seed whose nearest mouth is 800 m out should get NO path rather than a
 * six-hundred-metre trail across country nobody will ever walk. 620 m is about
 * three cave spacings, which is far enough that the ordinary case always gets
 * its path.
 */
const PATH_MAX_M = 620;

/** What a path goes round. Above these it starts paying a cost to be here. */
const PATH_WET = 0.3;
const PATH_SLOPE = 0.4;

/**
 * THE TWO WIDTHS, AND WHY THE TREES GET THE NARROWER ONE.
 *
 * `r`/`rim` is the COVER profile — what `trodden()` reads, and therefore what
 * thins the sward, the ferns and the litter along the line. That is the profile
 * you actually SEE, because the ground's vertex colour is computed in
 * terrain.js and terrain.js cannot import this module without a cycle. The mark
 * on the world is the absence of understorey, not a stripe of paint.
 *
 * `tr`/`trim` is the TREE profile, multiplied into `forestDensity` at 0.85
 * rather than 1.0 (see `PATH_TREE_GAIN` in scatter.js). Two things follow from
 * that, and both were the point:
 *
 *   THE ODD SAPLING SURVIVES IN THE LINE. A corridor with zero trees in it for
 *   four hundred metres is a forestry ride or a road. A deer path has stems
 *   standing in it that you step round, and the 15% that gets through is what
 *   makes it read as worn rather than as cut.
 *
 *   IT IS NARROWER THAN THE COVER, which is the opposite of the intuition. The
 *   instinct is to clear trees wider than grass — that is what a builder does.
 *   A path is not built: it is the ground people have walked on, so the bare
 *   strip is exactly as wide as the traffic and the trunks only have to stand
 *   off it far enough not to be in the way.
 */
const WAY = { wander: 5.5, jitter: 1.3, r: 1.45, rim: 3.1, tr: 1.1, trim: 3.4, terms: 2 };

/**
 * THE WAY OUT OF THE CLEARING — the one path every player is guaranteed to
 * stand on, so it is the one that gets to be obvious.
 *
 * ==== IT WAS A ROAD, AND THE NUMBER THAT MADE IT ONE WAS THE BARE WIDTH ====
 *
 * The first version of this line was `r: 3.4, rim: 3.0`, asked for as a "3–4 m
 * corridor", and in the photograph it reads as a forestry ride rather than as a
 * way. The measurement says why. What a player sees is not `pathClearance`, it
 * is `trodden()` in scatter.js — the fold of this profile with the spawn disc
 * and the site discs — and sampling that perpendicular to every segment of the
 * corridor in node, at three stations per segment, gives a median of:
 *
 *   old (3.4 / 3.0):  bare to 3.6 m either side, half-cover to 5.6 m
 *                     → a 7.2 m strip of nothing with an 11.2 m graded band
 *   new (1.7 / 3.5):  bare to 1.9 m either side, half-cover to 3.4 m
 *                     → a 3.8 m strip with a 6.8 m band
 *
 * A MEDIAN OVER THE WHOLE LINK AND NOT A SAMPLE AT ITS MIDPOINT, because both
 * ends of this one sit inside discs that are bare already — the spawn glade for
 * 4.5 m and the commons for 12.7 — so one station half way along measures the
 * corridor on some seeds and a clearing on others. The first version of this
 * measurement did exactly that and reported an 18.4 m corridor on
 * `ash-hollow-4471`, which is the width of the clearing it ends in.
 *
 * Seven metres of bare ground is a lane you could drive down. Under four is two
 * people walking abreast, which is what a way between two places actually is,
 * and the graded band is deliberately left almost as wide — the thing you are
 * meant to notice from the spawn camera is the FERNS THINNING toward a line,
 * not a clearing with an edge. Widening the soft part while narrowing the hard
 * part is the whole of the fix.
 *
 * THE TREE CORRIDOR IS BARELY TOUCHED (2.2 → 2.0) and that is deliberate: it is
 * the open sight line, not the bare ground, that makes a path legible END-ON,
 * which is the only way this one is ever first seen. `spawnLook()` points the
 * arriving camera straight down it, the forest hides everything past 40 m, and
 * a corridor you can see along is worth more than a corridor you can see the
 * floor of. It still stays narrower than the cover, for the reason above.
 *
 * `terms: 1` is the other difference from `WAY`: ONE low-frequency bend along
 * the corridor's own parameter instead of two. A single slow curve is a path
 * leaving a clearing; two harmonics on a seventy-metre run is a wiggle, and a
 * wiggle in the first thing anybody sees reads as an artefact.
 */
const HOME = { wander: 6.5, jitter: 1.1, r: 1.7, rim: 3.5, tr: 2.0, trim: 3.6, terms: 1 };

/**
 * WHERE A LINK STOPS SHORT OF THE PLACE IT IS GOING TO.
 *
 * Every link used to run from one site's CENTRE to another's, and the centre of
 * a hearth is the fire. Measured on four seeds, every path passed within 0.00 m
 * of a flame and of a jetty's shore point — which sounds worse than it was,
 * because `trodden()` has already scrubbed the floor bare well past those radii
 * (a hearth is bare to 3.4 m, the commons to 12.7), so the last few metres of
 * every link were drawing a worn line on ground that was worn anyway. Nothing
 * was ever visibly ploughed through a ring of logs.
 *
 * The suspicion was that it cost the commons something. Six links — the spawn
 * corridor, three fires, a viewpoint and the cave — all converged on one point,
 * and sampling the ring at 14 m says 176° of `ash-hollow-4471`'s clearing
 * perimeter is path, in one unbroken arc of 149°. That reads as a parade
 * ground, and the block below is what happened when it was measured properly.
 *
 * Either way a link now ENDS ON THE RIM of the place it serves, because a worn
 * line has no business inside a ring of logs whether or not you can see it:
 *
 *   COMMONS 12.5 m — just outside the outer ring of nine logs at 9.2 m and just
 *   inside where the clearing's own trodden disc stops being bare (23 × 0.55 =
 *   12.65 m in scatter.js). The way and the clearing therefore meet without a
 *   seam, and inside the ring of logs there is no line at all — which is right,
 *   because inside a room people do not walk in lines.
 *
 *   HEARTH 3.4 m — the ring of five logs is at 2.45 m and a log is 0.42 m deep,
 *   so this is a stride clear of the seating and exactly at the edge of the
 *   hearth's own bare disc (6.2 × 0.55 = 3.41).
 *
 *   VIEWPOINT 2.6 m — one bench, so the path arrives at it rather than at a rim.
 *
 * A LANDING AND A CAVE GET NO TRIM AT ALL. The jetty's site point IS the place
 * you step onto the deck from, and the deck goes out over water where
 * `submerged()` has already deleted the scatter; and a cave path is supposed to
 * run right up under the arch, which is what the block below `planPaths` says.
 */
const COMMONS_HUB = 12.5;
const HEARTH_HUB = 3.4;
const VIEW_HUB = 2.6;

/**
 * ==== AND THE PARADE GROUND, WHICH TURNED OUT NOT TO BE THERE ==============
 *
 * The other half of that measurement was supposed to be a fix, and it is
 * recorded here because the next person will have the same idea.
 *
 * Six ways converge on the commons, and sampling the ring at 14 m said a third
 * to a half of its perimeter was path — on `ash-hollow-4471`, 176° of it, in one
 * unbroken arc of 149°.
 * That reads as a parade ground until you ask what is actually DRAWN there:
 * `trodden()` folds the clearing's own disc in, and a commons is bare to
 * 23 × 0.55 = 12.65 m and still only 1% covered at 14 m. Nothing is visible at
 * the radius the complaint was measured at. Re-sampled at 26–32 m, where the
 * understorey has climbed back to two-thirds and a bare line finally has
 * something to contrast against, the same four seeds give four to six separate
 * arcs of 10–42°, which is six ways out of a clearing.
 *
 * THE FIX WAS WRITTEN AND MEASURED AND THEN DELETED. It spaced the legs round
 * the rim — sort by bearing, push adjacent pairs apart by half their shortfall,
 * eight passes — so that no two ways left within 30° of each other. It cannot
 * work, and the reason is worth keeping: a path BENDS BACK TO WHERE IT IS
 * GOING within a node or two, so moving the point it leaves from does not move
 * the line it settles onto. Measured, it took `ash-hollow-4471`'s worst merged
 * arc at 22 m from 69° to 82° and its total path arc from 150° to 163°, i.e.
 * very slightly the wrong way, and left the other three seeds unchanged within
 * noise. Two ways that share a destination bearing can only be separated by
 * bending both of them for their whole length, which is a trail network and not
 * a rim.
 */

/** The hash the query walks. 24 m is a segment's own AABB plus its rim. */
const PATH_CELL = 24;
const PATH_BIAS = 4194304;
const PATH_STRIDE = 8388608;
const pathKey = (ix, iz) => (ix + PATH_BIAS) * PATH_STRIDE + (iz + PATH_BIAS);

/** @returns {Segment} */
function makeSeg(ax, az, bx, bz, style) {
  const vx = bx - ax;
  const vz = bz - az;
  const reach = Math.max(style.r + style.rim, style.tr + style.trim);
  return {
    x0: ax,
    z0: az,
    vx,
    vz,
    /** 1/|v|², so the projection is a multiply rather than a divide per call. */
    inv: 1 / Math.max(1e-6, vx * vx + vz * vz),
    minx: Math.min(ax, bx) - reach,
    maxx: Math.max(ax, bx) + reach,
    minz: Math.min(az, bz) - reach,
    maxz: Math.max(az, bz) + reach,
    r: style.r,
    rim: style.rim,
    tr: style.tr,
    trim: style.trim,
  };
}

/**
 * One link, subdivided, wandered, and re-projected off ground a walker would
 * have gone round.
 *
 * WHY THE WANDER IS A PAIR OF SEEDED HARMONICS AND NOT JUST THE PER-NODE
 * JITTER. Independent lateral jitter at every node is the obvious reading of
 * "make it not a ruled line", and at a 12 m node spacing it does not produce a
 * wandering path — it produces a zigzag with a 12 m period, because there is no
 * correlation between one node's offset and the next's. What a path looks like
 * on a map is one or two slow bends over its whole length with a little grain
 * on top, so that is what this is: a low-frequency term in the link's own
 * parameter `t` (one harmonic for the spawn corridor, two for everything else)
 * carrying a small independent jitter. Both are tapered by `sin(pi t)`, which
 * is zero at both ends, so the path arrives EXACTLY at the middle of the place
 * it is going to rather than sixty centimetres to one side of the fire.
 *
 * THE RE-PROJECTION IS A COST, NOT A TEST. A hard "is this wet? then move"
 * needs somewhere to move to, and on a seed where the whole corridor crosses a
 * bank there is nowhere; so each node scores a handful of lateral positions and
 * takes the first that is clean, or the cheapest if none is. The last candidate
 * is always the straight point, so the degenerate case is a straight path
 * through the wet — a path that looks slightly wrong — rather than a node flung
 * a long way off the line, which is a path that looks broken.
 *
 * ONE `rng()` DRAW PER NODE FOR THE GRAIN, TAKEN OUTSIDE THE RETRY LOOP, so a
 * world where one node happens to need five tries does not draw a different
 * number of times from a world where it needs one. The retry count depends on
 * the terrain, and letting the seeded stream depend on the terrain would make
 * every path after it depend on the shape of the ground under the one before.
 */
function pathLink(rng, ax, az, bx, bz, style, out, from = 0, to = 0) {
  let vx = bx - ax;
  let vz = bz - az;
  let len = Math.hypot(vx, vz);
  /**
   * The LENGTH TEST IS TAKEN ON THE UNTRIMMED LINE, because `PATH_MAX_M` is
   * answering "is this destination too far to be worth a path" — a fact about
   * where the two places are, not about where the walking stops. Trimming first
   * would make a cave at 619 m get a path and one at 621 m not, by a rule that
   * depends on the size of a ring of logs at the other end.
   */
  if (len > PATH_MAX_M) return;
  /**
   * Stop short of the furniture. See the `COMMONS_HUB` block for why.
   *
   * Both cuts are scaled together if they would eat more than 60% of the link,
   * so a landing that happens to sit twelve metres from a fire gets a short
   * path rather than an inverted one. The `len < 14` floor below then throws
   * away anything that is left too short to be a walk.
   */
  if (len > 1e-6 && from + to > 0) {
    const k = Math.min(1, (len * 0.6) / (from + to));
    const ux = vx / len;
    const uz = vz / len;
    ax += ux * from * k;
    az += uz * from * k;
    bx -= ux * to * k;
    bz -= uz * to * k;
    vx = bx - ax;
    vz = bz - az;
    len = Math.hypot(vx, vz);
  }
  if (len < 14) return;
  const n = Math.max(2, Math.round(len / PATH_SPAN));
  /** The lateral unit vector: the along vector turned a quarter turn. */
  const nx = -vz / len;
  const nz = vx / len;

  const w1 = rngRange(rng, 0.55, 1.0) * style.wander;
  const k1 = rngRange(rng, 0.6, 1.4);
  const p1 = rng() * Math.PI * 2;
  /**
   * The second harmonic's three draws are taken whether or not it is used, so
   * that `terms` changes the SHAPE of a path and not the seeded stream every
   * path after it comes off. Three unused draws to keep the stream independent
   * of a style flag is the same bargain `speciesAt` makes with its single roll.
   */
  const w2 = rngRange(rng, 0.18, 0.45) * style.wander * (style.terms > 1 ? 1 : 0);
  const k2 = rngRange(rng, 2.0, 3.3);
  const p2 = rng() * Math.PI * 2;

  let px = ax;
  let pz = az;
  for (let i = 1; i <= n; i++) {
    let qx;
    let qz;
    if (i === n) {
      qx = bx;
      qz = bz;
    } else {
      const t = i / n;
      const taper = Math.sin(Math.PI * t);
      const wave =
        (Math.sin(t * k1 * Math.PI * 2 + p1) * w1 + Math.sin(t * k2 * Math.PI * 2 + p2) * w2) *
        taper;
      const grain = rngRange(rng, -style.jitter, style.jitter) * taper;
      const cx = ax + vx * t;
      const cz = az + vz * t;
      let bestX = cx;
      let bestZ = cz;
      let bestCost = Infinity;
      for (let k = 0; k < PATH_TRIES; k++) {
        // k = 0 is the wander itself, 1..4 step off it alternately either way,
        // and the last is the straight line. See the block above.
        const off =
          k === PATH_TRIES - 1
            ? 0
            : wave + grain + (k === 0 ? 0 : (k & 1 ? 1 : -1) * Math.ceil(k / 2) * PATH_STEP * taper);
        const tx = cx + nx * off;
        const tz = cz + nz * off;
        const cost =
          Math.max(0, wetness(tx, tz) - PATH_WET) * 6 +
          Math.max(0, slopeAt(tx, tz) - PATH_SLOPE) * 4;
        if (cost < bestCost) {
          bestCost = cost;
          bestX = tx;
          bestZ = tz;
        }
        if (cost <= 0) break;
      }
      qx = bestX;
      qz = bestZ;
    }
    out.push(makeSeg(px, pz, qx, qz, style));
    px = qx;
    pz = qz;
  }
}

/** Nearest of a list to a point, or null for an empty list. */
function nearestTo(list, x, z) {
  let best = null;
  let bestD = Infinity;
  for (const s of list) {
    const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/**
 * WHICH PLACES ARE JOINED TO WHICH, and the shape of the answer is a tree
 * rather than a mesh.
 *
 * Every link starts at somewhere you already are: the spawn disc leads to the
 * commons, the commons leads out to the fires, to a view and to the cave, and
 * each landing hangs off whichever fire is nearest it. Joining every pair
 * instead would be twenty-eight links, and a wood criss-crossed by trodden
 * lines is a park — the whole value of a path is that following it is a
 * DECISION, which requires that there be somewhere it does not go.
 *
 * The build order is fixed and every link draws from one stream in it, for the
 * usual reason: a plan that depended on which link was built first would not be
 * the same plan in two players' worlds.
 */
function planPaths(plan, seed) {
  /** @type {Segment[]} */
  const segs = [];
  const c = plan.commons;
  if (!c) return segs;
  const rng = makeRng(`${seed}:paths`);

  /**
   * The way out of the clearing, first, because it is the one that has to be
   * there whatever else this seed did or did not manage to place.
   *
   * It runs from the spawn to the commons RIM rather than into the middle of
   * it. `spawnLook()` still aims the arriving camera at the commons CENTRE and
   * is deliberately left doing so: the centre is where you are going, and the
   * rim is only where the trodden line stops. The two differ by nothing you can
   * see, because the trim is taken along the straight line — the corridor's far
   * end is on exactly the bearing from the spawn that it always was, it just
   * stops twelve and a half metres short of the fire.
   */
  pathLink(rng, 0, 0, c.x, c.z, HOME, segs, 0, COMMONS_HUB);

  for (const h of plan.hearths) {
    pathLink(rng, c.x, c.z, h.x, h.z, WAY, segs, COMMONS_HUB, HEARTH_HUB);
  }

  const view = nearestTo(plan.viewpoints, c.x, c.z);
  if (view) pathLink(rng, c.x, c.z, view.x, view.z, WAY, segs, COMMONS_HUB, VIEW_HUB);

  for (const j of plan.jetties) {
    const from = nearestTo(plan.hearths, j.x, j.z);
    /**
     * A landing hangs off the nearest FIRE, and off the commons rim when this
     * seed placed no fires at all. The two cases take different trims because
     * they are leaving different things: a ring of logs, or a clearing whose
     * rim point this leg does not have — hence the commons centre with a
     * `COMMONS_HUB` trim, which lands on the rim at the bearing of the landing.
     */
    if (from) pathLink(rng, from.x, from.z, j.x, j.z, WAY, segs, HEARTH_HUB, 0);
    else pathLink(rng, c.x, c.z, j.x, j.z, WAY, segs, COMMONS_HUB, 0);
  }

  /**
   * …and the one that is the answer to "nothing tells you there are caves".
   *
   * `cavesNear` returns live descriptors nearest first and a descriptor's
   * `x, z` IS its mouth (see the `caveAxisPoint(c, c.aHold, 0)` assignment in
   * terrain.js), so this is one call and no new machinery. The path is allowed
   * to run all the way INTO the gully: `caveClearance` has already emptied the
   * tree field there, so the only thing the last few segments do is keep the
   * ground bare right up to the arch, which is exactly where a worn line
   * should stop. Hence the trim at the commons end and none at the cave's — the
   * ONLY link in this world that is supposed to end at the thing it names.
   */
  const cave = cavesNear(c.x, c.z, 900)[0];
  if (cave) pathLink(rng, c.x, c.z, cave.x, cave.z, WAY, segs, COMMONS_HUB, 0);

  return segs;
}

/** File every segment into the 24 m hash on its own AABB. */
function indexPaths(segs) {
  /** @type {Map<number, Segment[]>} */
  const grid = new Map();
  for (const s of segs) {
    const i0 = Math.floor(s.minx / PATH_CELL);
    const i1 = Math.floor(s.maxx / PATH_CELL);
    const j0 = Math.floor(s.minz / PATH_CELL);
    const j1 = Math.floor(s.maxz / PATH_CELL);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const key = pathKey(i, j);
        let cell = grid.get(key);
        if (!cell) grid.set(key, (cell = []));
        cell.push(s);
      }
    }
  }
  return grid;
}

/**
 * How much of a path there is at this point, 0..1. `tree` selects the narrower
 * profile — see the two-widths block at `WAY`.
 */
function pathAt(x, z, tree) {
  ensurePlan();
  const cell = _pathGrid.get(pathKey(Math.floor(x / PATH_CELL), Math.floor(z / PATH_CELL)));
  if (cell === undefined) return 0;
  let most = 0;
  for (let i = 0; i < cell.length; i++) {
    const s = cell[i];
    if (x < s.minx || x > s.maxx || z < s.minz || z > s.maxz) continue;
    const r = tree ? s.tr : s.r;
    const rim = tree ? s.trim : s.rim;
    const dx = x - s.x0;
    const dz = z - s.z0;
    let t = (dx * s.vx + dz * s.vz) * s.inv;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = dx - s.vx * t;
    const ez = dz - s.vz * t;
    const d = Math.hypot(ex, ez);
    if (d >= r + rim) continue;
    const k = d <= r ? 1 : 1 - smoothstep(clamp01((d - r) / rim));
    if (k > most) most = k;
    if (most >= 1) return 1;
  }
  return most;
}

/**
 * The COVER profile: 1 on the worn line, 0 in ordinary wood.
 *
 * `trodden()` in scatter.js folds this in, and that is what actually draws the
 * path — the sward, the ferns and the small bald-disc layers thin along it. It
 * has to happen through the scatter rather than through the ground's vertex
 * colour because the vertex colour is computed in terrain.js, and terrain.js
 * cannot import this module without a cycle.
 */
export function pathClearance(x, z) {
  return pathAt(x, z, false);
}

/** The TREE profile, narrower. `forestDensity` multiplies by `1 - 0.85 * this`. */
export function pathTrees(x, z) {
  return pathAt(x, z, true);
}

/**
 * Every segment of every path in this world, for scripts and the debug pane.
 * Not on any hot path; the world uses the hash, not this.
 */
export function sitePaths() {
  ensurePlan();
  return _paths;
}

/**
 * Where to look when you arrive, and which way the corridor leaves.
 *
 * Exported because two things outside this module have to agree with the path:
 * the spawn yaw (a player who arrives facing across the trodden line will never
 * see it — the forest hides everything past 40 m, and a path is only legible
 * along its own axis) and the opening position of the speakers, which stood at
 * (1.2, -6.0) and would otherwise be two cabinets planted in the middle of the
 * way out of the clearing.
 *
 * `yaw` is a `Controller.yaw`: `forward` is `(-sin yaw, -cos yaw)`, so the yaw
 * that looks along a unit vector W is `atan2(-W.x, -W.z)`. `(sx, sz)` is the
 * lateral unit vector, for anything that wants to stand BESIDE the path.
 */
export function spawnLook() {
  const plan = ensurePlan();
  const c = plan.commons;
  const d = Math.hypot(c.x, c.z) || 1;
  const dx = c.x / d;
  const dz = c.z / d;
  return { dx, dz, sx: -dz, sz: dx, yaw: Math.atan2(-dx, -dz) };
}

/* -------------------------------------------------------------------------- */
/* what the places are called                                                 */
/* -------------------------------------------------------------------------- */

/**
 * THE WOOD SAYS THE NAMES OF ITS OWN PLACES.
 *
 * `Seat.label` has carried 'the commons', 'the view' and 'the landing' since the
 * furniture was built, and until this pass nothing read it. That one dead field
 * is the whole situation: the world already had a vocabulary for its own places
 * and never said a word of it out loud. Nine places, every one of them chosen by
 * measuring the ground, and no way to tell a friend which one you are at.
 *
 * A NAME IS A THING TWO PEOPLE CAN BOTH FIND, and that is the entire value of
 * it. "Meet me at the far fire" only works if the far fire is the far fire on
 * both machines — so a name is a pure function of the site plan, which is a pure
 * function of the seed, and nothing about a name goes on the wire for exactly
 * the reason nothing about a fire does.
 *
 * WHAT MAKES A GOOD ONE. It has to be something a person would say out loud to
 * somebody standing next to them, which rules out both halves of the obvious
 * failure: "Site 3" on one side and "the Whispering Glade of Elderfall" on the
 * other. So every name is `the <epithet> <noun>`; the noun is what the place IS
 * and the epithet is the one fact that distinguishes it from its siblings. The
 * epithets are drawn from the world rather than from a list of pretty words, and
 * each is drawn from the SAME property the site was chosen for:
 *
 *   THE FIRES by how far out they are, because that is how they were placed —
 *   `planSites` biases each successive hearth further from the origin, so near
 *   and far are facts about the plan and not adjectives chosen to fill a slot.
 *   The middle of three takes a compass point instead, because "the middle fire"
 *   is not a name anybody has ever used for anything.
 *
 *   THE VIEWPOINTS by the thing they were chosen FOR. `planSites` scores them on
 *   altitude and relief; the one with the ground falling furthest away from it
 *   is the long view and the other is the lookout. Measured here with the same
 *   twenty-metre gradient `gathering.js` uses to aim the bench, so the name and
 *   the direction the seat faces come off one reading of the ground.
 *
 *   THE LANDINGS by where they are on the river. `u` runs downstream — the water
 *   shader advects its wave train as `q = vec2(u - uTime * 0.85, v)`, i.e. the
 *   pattern travels toward +u — so the smallest `u` is the upper landing and the
 *   largest is the lower, and with the three this world usually has, the middle
 *   one is simply the landing.
 *
 * FOUR CARDINALS, NOT EIGHT, and it is a deliberate difference from `main.js`'s
 * arrival line. That is writing a SENTENCE, where "the river lies 60 m
 * north-east" is a direction somebody can walk. This is writing a NAME, and "the
 * north-east fire" is not one.
 *
 * THE UNIQUENESS PASS IS A SAFETY NET RATHER THAN THE MECHANISM. Every rule
 * above already produces distinct names at the counts this world generates; the
 * guard exists so that a land layer which one day asks for four hearths cannot
 * produce two places with the same name, which is the one failure that would
 * make a name worse than no name at all.
 */

/**
 * @typedef {{
 *   x: number, z: number, kind: string, name: string, in: number, out: number,
 * }} Place
 */

/**
 * How near you have to be to be IN a place rather than near it.
 *
 * Not `SITE_RADIUS`. That is how much room the FOREST has to leave, which is
 * always bigger than the room — the commons reserves 23 m to hold a ring of nine
 * logs at 9.2. These are read off the furniture in gathering.js instead:
 *
 *   commons   12    the outer ring of nine logs is at 9.2 m and a log is 2.9 m
 *                   long, so 12 is a stride past the back of the outermost seat.
 *                   It is also, near enough, the `ring: 10.5` that `setCompany`
 *                   uses for "is this person AT this fire" — the same question
 *                   asked for a different reason, and it is a good sign that two
 *                   independent readings of the same furniture agree.
 *   hearth     5.5  five logs at 2.45 m, so this is comfortably outside the ring
 *                   and comfortably inside the 52 m that separates any two sites.
 *   viewpoint  6    one bench, so this one is a judgement rather than a reading:
 *                   far enough that you are told before you sit down.
 *   jetty      7    the deck runs 5.4 m out over the water from the site point
 *                   and the bench stands 1 m inland of it, so this covers the
 *                   whole structure from either end of it.
 *
 * AND THE HYSTERESIS. 1.45x the radius you came in at, so the commons lets go of
 * you at 17.4 m and a hearth at 8.0. Without it, standing on the boundary and
 * shifting your weight says the name again on every crossing, which is exactly
 * how a remark turns into chrome. The multiplier is chosen against the WALK
 * rather than against the jitter: 1.45x of a hearth is 2.5 m of dead band, which
 * is three paces — far enough that you have plainly left, near enough that
 * walking out and coming back is still something you did on purpose.
 */
const NAME_IN = { commons: 12, hearth: 5.5, viewpoint: 6, jetty: 7 };
const NAME_HYSTERESIS = 1.45;

const NAME_CARDINAL = ['north', 'east', 'south', 'west'];

/** Screen north is -z and the compass runs clockwise from it. See ui/debug.js. */
function cardinal(dx, dz) {
  const deg = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return NAME_CARDINAL[Math.round(((deg + 360) % 360) / 90) % 4];
}

/**
 * How far the ground falls away from a viewpoint, over the landform rather than
 * over the bump it happens to be standing on.
 *
 * Twelve bearings at twenty metres, which is `gathering.js`'s own aiming loop:
 * at two metres the answer is the tussock under the bench. Quoted rather than
 * shared because that one also needs the BEARING it found and feeds it into a
 * mesh, and this file may not import anything that makes one.
 */
function fall(site) {
  let most = -Infinity;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const drop = site.y - heightAt(site.x + Math.sin(a) * 20, site.z + Math.cos(a) * 20);
    if (drop > most) most = drop;
  }
  return most;
}

/**
 * Name every place in the plan. See the block above for the rules.
 *
 * @param {ReturnType<typeof planSites>} plan
 */
function namePlaces(plan) {
  /** @type {Place[]} */
  const places = [];
  /** @type {Map<object, string>} */
  const bySite = new Map();
  const used = new Set();
  const c = plan.commons;

  const add = (site, kind, name) => {
    if (!site) return;
    /**
     * The safety net. A duplicate takes a compass point instead, and a duplicate
     * of THAT keeps its bearing and gains a count — which is ugly, and is meant
     * to be: it is the visible sign that somebody has added a kind of place
     * without giving it a rule, and it is still a name two people can both use.
     */
    let final = name;
    if (used.has(final)) final = `the ${cardinal(site.x - c.x, site.z - c.z)} ${kind}`;
    for (let n = 2; used.has(final); n++) final = `${name} (${n})`;
    used.add(final);
    const reach = NAME_IN[kind] ?? 6;
    places.push({
      x: site.x,
      z: site.z,
      kind,
      name: final,
      in: reach,
      out: reach * NAME_HYSTERESIS,
    });
    bySite.set(site, final);
  };

  add(c, 'commons', 'the commons');

  /**
   * NEAR AND FAR ARE MEASURED FROM THE SPAWN, and the first draft measured them
   * from the commons, which produced names that were true and useless.
   *
   * `planSites` asks for its three hearths at 58, 104 and 150 m FROM THE ORIGIN
   * — that is where the spread comes from and it is the only axis along which
   * these three places are actually separated. Sorting them by distance from the
   * commons instead gave, on `grove-01`, 76 m, 81 m and 82 m: "the near fire"
   * and "the far fire" six metres apart, which is a distinction nobody standing
   * in this wood could ever use. From the spawn the same three are 57, 111 and
   * 145.
   *
   * It is also the frame everybody already shares. The origin is the one point
   * in the world every player has stood on, `main.js`'s arrival line gives its
   * bearings from exactly there, and "the near fire" meaning near where we all
   * came in is a sentence that needs no explaining.
   */
  const fires = plan.hearths
    .slice()
    .sort((p, q) => Math.hypot(p.x, p.z) - Math.hypot(q.x, q.z));
  fires.forEach((h, i) => {
    let epithet = '';
    if (fires.length > 1) {
      if (i === 0) epithet = 'near ';
      else if (i === fires.length - 1) epithet = 'far ';
      else epithet = `${cardinal(h.x, h.z)} `;
    }
    add(h, 'hearth', `the ${epithet}fire`);
  });

  const views = plan.viewpoints.slice().sort((p, q) => fall(q) - fall(p));
  views.forEach((v, i) => {
    add(v, 'viewpoint', i === 0 ? 'the long view' : i === 1 ? 'the lookout' : 'the high seat');
  });

  const landings = plan.jetties.slice().sort((p, q) => p.u - q.u);
  landings.forEach((j, i) => {
    let epithet = '';
    if (landings.length > 1) {
      if (i === 0) epithet = 'upper ';
      else if (i === landings.length - 1) epithet = 'lower ';
    }
    add(j, 'jetty', `the ${epithet}landing`);
  });

  return { places, bySite };
}

function ensureNames() {
  ensurePlan();
  if (!_places) {
    const named = namePlaces(_plan);
    _places = named.places;
    _placeOf = named.bySite;
  }
  return _places;
}

/**
 * Every named place in this world, for the debug pane and for scripts.
 * @returns {Place[]}
 */
export function sitePlaces() {
  return ensureNames();
}

/**
 * What this world calls a site from its own plan, or null.
 *
 * Keyed on the site OBJECT rather than on its coordinates, which is exact and
 * needs no tolerance: `gathering.js` builds its furniture out of the very
 * objects `sitePlan()` handed it, so the thing it is holding when it wants a
 * label is the same reference this map was filled from.
 */
export function siteName(site) {
  ensureNames();
  return (site && _placeOf?.get(site)) ?? null;
}

/**
 * THE ARRIVAL EDGE: the place you have just walked into, once, or null.
 *
 * Returns the name capitalised, in the form it should be SAID — 'The commons' —
 * because the caller is a HUD toast, while `siteName`'s callers want it lower
 * case inside a sentence. One function, one job, and no capitalisation
 * arithmetic left sitting at a call site in main.js.
 *
 * A SET OF PLACES YOU ARE IN, NOT A SINGLE ONE. Two places can overlap in
 * principle — a landing is chosen off the bank rather than out of `taken`, so
 * nothing stops one being twelve metres from a fire on some seed — and a single
 * `here` would flap between them once a frame. So the state is which places
 * currently hold you, entering one is the edge, and leaving it is what lets it
 * speak again. That is the rule this was asked for: a place says its name once,
 * and not again until you have left and come back.
 *
 * AT MOST ONE PER CALL, AND THE INNERMOST WINS. Two toasts in one frame is one
 * toast anyway, because `hud.toast` replaces whatever is up; choosing the one
 * you are deepest inside means the answer is the place you are actually at
 * rather than whichever the plan happened to list first.
 *
 * THE CALLER OWNS THE ROOF. This is an xz question, and xz distance reaches
 * through mountains — a passage running under the commons would otherwise
 * announce it to somebody forty metres below the fire. `main.js` guards on
 * `controller.roofed`, which is this project's standing answer to that, and the
 * only cost of guarding OUTSIDE rather than inside is that the set goes stale
 * while you are underground: the first call after you surface sees where you
 * really are and corrects it in that same frame.
 *
 * NOT PART OF THE WORLD. Everything else in this file is a pure function of the
 * seed because two machines have to agree on it. This is the opposite kind of
 * state — where THIS body is standing — and none of it is shared, which is why
 * it may live in a module-level set without breaking the rule at the top of the
 * file. It is dropped with the plan for the same reason a memo is.
 */
export function enteredPlace(x, z) {
  const places = ensureNames();
  let said = null;
  let deepest = Infinity;
  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    const held = _inside.has(p.name);
    const d = Math.hypot(x - p.x, z - p.z);
    // The hysteresis: you are in at `in`, and stay in until `out`.
    if (d < (held ? p.out : p.in)) {
      if (!held) {
        _inside.add(p.name);
        const k = d / p.in;
        if (k < deepest) {
          deepest = k;
          said = p.name;
        }
      }
    } else if (held) {
      _inside.delete(p.name);
    }
  }
  return said ? said.charAt(0).toUpperCase() + said.slice(1) : null;
}
