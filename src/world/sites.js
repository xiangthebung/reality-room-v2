import { clamp01, makeRng, smoothstep } from '../core/util.js';
import {
  WATER_LEVEL,
  getWorldSeed,
  heightAt,
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
