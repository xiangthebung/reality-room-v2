import * as THREE from 'three';
import { TAU, clamp01, fbm2, hashString, makeRng, rngRange, smoothstep } from '../core/util.js';
import {
  WATER_LEVEL,
  caveClearance,
  getWorldSeed,
  groundUnder,
  heightAt,
  slopeAt,
  wetness,
} from './terrain.js';
/**
 * The gathering places, so the forest can leave room for them.
 *
 * `sites.js` imports nothing but `terrain.js` and `core/util.js` — deliberately,
 * because this module is evaluated inside `forest-worker.js`, where THREE and
 * anything that touches a canvas are unavailable. See its header.
 */
import { SITE_RADIUS, pathClearance, pathTrees, siteClearance, sitePlan } from './sites.js';
/**
 * WHICH LAND THIS IS. See `lands/index.js` for how a seed string carries one.
 *
 * This module holds the MACHINERY — the seeded lattice offsets, the density
 * product, the sector grids, the tiling correction, the bucket packer — and the
 * land holds every number and every rule that could differ between two worlds.
 * The line between them is drawn in `lands/rainforest.js`'s header; the short
 * version is that a rule shared by every land lives here and a rule that IS the
 * content of a land lives there.
 *
 * `currentLand()` is one property read on a module-scope binding, so the guards
 * below cost an identity compare rather than a lookup. It cannot be hoisted to a
 * module-scope const: the worker imports this file BEFORE its init message
 * arrives, so at import time this realm has not been told which land it is.
 */
import { currentLand } from './lands/index.js';

/**
 * Where things grow. All of it, everywhere, from one function per layer.
 *
 * The placement rules, separated from the meshes they end up in, because they
 * run in a worker and the meshes cannot: `forest-worker.js` builds every sector
 * of the world off the main thread, and `forest.js` only ever holds the
 * geometries, the materials and the slabs the results land in.
 *
 * NOTHING IN HERE TOUCHES A MESH, A MATERIAL, A TEXTURE OR THE DOM, and that is
 * a hard requirement rather than tidiness: it is imported by a module worker.
 * `THREE.Color` and `THREE.Matrix4` are pure arithmetic and are fine (the
 * terrain worker already imports three); `trees.js` is NOT, because it pulls in
 * `textures.js`, which draws on a canvas. That is why the species tint palettes
 * arrive as data in the worker's init message rather than being imported.
 *
 *
 * ==== THERE IS ONE SAMPLER AND IT STARTS AT r = 0 =========================
 *
 * There used to be two forests. An AUTHORED one — an eager global scatter run
 * on the main thread at load, covering a disc around the origin — and a
 * STREAMED one that was forbidden to place anything inside a protected radius
 * of 163.4 m, so that the two tiled the plane without overlapping. That is
 * gone, and this is the paragraph that has to explain why, because everything
 * below reads differently if you think the disc is still there.
 *
 * THE RULE WAS AN APPROVAL CONSTRAINT AND THE APPROVAL EXPIRED. The stated
 * justification was that the world inside 163.4 m was signed off, every camera
 * station in `shoot.mjs` stood in it, and a per-sector rng would move all three
 * and a half thousand near trees on the first frame. All true while the world
 * was one fixed world. The world became per-session seeded (`setWorldSeed` in
 * terrain.js, `core/world-seed.js`), so the near trees now move on every load
 * anyway: the rule was costing something real to preserve the reproducibility
 * of a layout that is no longer reproduced.
 *
 * WHAT IT COST WAS BALDNESS, AND MORE OF IT THAN THE BUG REPORT SAID. The
 * complaint was a bald annulus between where each authored understorey layer
 * stopped (118–140 m) and where the streamed one was allowed to start (163.4).
 * Measured properly it was worse than that, because the authored SWARD stopped
 * at 72 m and thinned all the way to it. Ground-cover instances per square
 * metre, counted from a camera at the spawn point looking out, before this
 * change:
 *
 *     0–20 m  2.47      60–80 m   0.92      120–140 m  0.11
 *    20–40 m  1.77      80–100 m  0.31      140–160 m  0.07
 *    40–60 m  1.49     100–120 m  0.28      160–180 m  0.01
 *
 * …against the same measurement taken 700 m out, where only the streamed
 * sampler has ever run: 2.07, 1.93, 2.03, 1.97, 1.00 out to 100 m. The endless
 * world was four to six times better planted than the world you spawn in.
 *
 * AND IT COST NOTHING TO FIX, which is the part that decided it. The experiment
 * was available before a line was written, because the answer was already in
 * the world: measure the frame at the spawn point, where the eager scatter was,
 * and then 700 m out, where only this sampler has ever run. Both in ONE process,
 * because whole-app GPU numbers on this machine drift half a millisecond between
 * runs minutes apart. At 2560×1440, spawn against 700 m:
 *
 *     sober 3.70 / 3.99   onset 5.10 / 5.16   peak 4.39 / 4.14   ego 4.12 / 4.01
 *
 * The streamed-only world was 0.3 ms dearer sober, 0.25 ms CHEAPER at peak, and
 * 45 draw calls lighter. Making spawn look like everywhere else was therefore
 * free to within the noise, and that is how it measured afterwards too — spawn
 * moved 0.26 ms sober where the two unchanged far stations moved 0.25, i.e. the
 * whole shift was the machine.
 *
 * `npm run perf:gpu` before and after, and READ THE SPREAD BEFORE THE DELTA:
 * two runs of the identical build minutes apart gave sober 3.61 and 3.94, peak
 * 4.85 and 5.28. Against a before of 3.55 / 4.85 / 4.94 / 4.56 / 4.61 (sober,
 * onset, peak, ego death, still), the after is 3.61 / 4.97 / 4.85 / 4.72 / 4.74
 * taking the best of each — every one of those inside a ±0.35 ms spread, and
 * the peak is the one that went down. Draws 159 -> 129 and 14.02 -> 13.90 M
 * triangles, which are not noisy and are the eager scatter's meshes leaving.
 *
 * The result at the spawn point, same bands as above: 2.12, 1.71, 1.76, 1.93,
 * 1.77, 0.89, 0.55 — six times the planting at 80–100 m and five times at
 * 120–140.
 *
 * SO: no `AUTHORED_RADIUS`, no `STREAM_FROM` table, no per-layer seam fade, and
 * no radius test anywhere in this file except the two that are world FEATURES
 * rather than bookkeeping — the clearing hole in `forestDensity`, and the small
 * bald disc under the player's boots in the meadow rule. Both are documented
 * where they are.
 *
 *
 * WHY THAT MAKES THE WORLD DETERMINISTIC RATHER THAN LESS SO.
 *
 * Every sector is `makeRng(`${seed}:${kind}:${sx}:${sz}`)` and nothing else, so
 * a sector's contents are a pure function of the world seed and its own
 * coordinates. They do not depend on which sectors were built first, on how
 * many workers there are, on the order the results came back, or on where the
 * player walked. The old arrangement had a global scatter whose rng was drawn
 * from in one fixed order across five layers — correct, but correct by
 * discipline, and a single extra draw anywhere in it moved every instance
 * after. Two players on one seed now get the same wood because they compute the
 * same function, not because they ran the same script the same way.
 */

/**
 * WHERE THE GROVES AND GLADES ARE, PER WORLD — the last unseeded field.
 *
 * The terrain is seeded, so `slopeAt` and `wetness` already move the wood
 * about from one world to the next; but they only ever multiply the grove
 * term, so the SHAPE of the dense and open forest — the actual pattern of
 * thicket and clearing you walk through — was `fbm2(x*0.011 + 5, z*0.011 - 9)`
 * in every world that will ever exist. Two players on two different seeds got
 * different hills with the same wood draped over them.
 *
 * SEED 0 MUST REPRODUCE 5 AND -9 EXACTLY, and that is not a nicety either.
 * `grove-01` normalises to 0 (see `normalizeSeed`), it is the identity world,
 * and the pixel-diffing scripts that compare against stored references —
 * `terrain-survey`, every station in `shoot.mjs` — stand in it. So the identity
 * offsets are returned verbatim rather than derived through an arithmetic that
 * happens to land on them.
 *
 * Two independent hashes rather than one split in half: `x` and `z` would
 * otherwise be offset by correlated amounts, and a diagonal correlation in the
 * lattice offset is the sort of thing that shows up as every world's forest
 * being a translation of the same one along a 45° line.
 *
 * CACHED ON THE SEED, because `forestDensity` is called a few hundred thousand
 * times per streamed sector across the layers that read it. `getWorldSeed()` is
 * a module read, so the guard below is one integer compare per call; the two
 * string hashes happen once per world. It cannot be computed at module scope
 * instead: this module is imported by the worker BEFORE its init message
 * arrives, so at import time the realm's seed is still 0.
 */
let _groveSeed = -1;
let _groveLand = null;
let _groveX = 5;
let _groveZ = -9;

function grove(x, z) {
  const s = getWorldSeed();
  const land = currentLand();
  if (s !== _groveSeed || land !== _groveLand) {
    _groveSeed = s;
    _groveLand = land;
    if (s === 0) {
      // The identity offsets, which are the LAND's to name because they are the
      // lattice its grove field was tuned on. Returned verbatim rather than
      // derived, for the reason above.
      _groveX = land.density.identity[0];
      _groveZ = land.density.identity[1];
    } else {
      // Spread over a few hundred lattice units. `noise2` hashes on the integer
      // lattice, so anything smaller than a couple of features (~90 m at this
      // frequency, i.e. ~1 unit of domain) would return nearly the same wood.
      _groveX = (hashString(`grove:x:${s}`) % 100000) / 137.0 - 364;
      _groveZ = (hashString(`grove:z:${s}`) % 100000) / 137.0 - 364;
    }
  }
  const d = currentLand().density;
  return fbm2(x * d.groveFreq + _groveX, z * d.groveFreq + _groveZ, d.groveOctaves);
}

/**
 * A reused output object, and the reason it is reused rather than returned
 * fresh.
 *
 * `character` is called once per understorey scatter candidate, and the layers
 * that read it test about a hundred and forty thousand candidates at load and
 * another four thousand for every streamed sector. Ninety per cent of those are
 * rejected on the first weight they look at, so the allocation would be pure
 * garbage — and the alternative of one exported function per weight would
 * evaluate the same two fbms five times over. One object, filled in place,
 * documented as such.
 *
 * The consequence a caller has to know about: the answer is only valid until
 * the next call. Nothing holds one.
 *
 * ITS FIELDS ARE THE LAND'S, WHICH IS THE WHOLE POINT OF THE LAND LAYER. The
 * rainforest declares `meadow, bramble, litter, damp, flower, canopy, wet,
 * understorey`; the taiga declares `drift, scrub, needle, damp, exposure,
 * canopy, wet, thicket` and shares only three of them. The object is built once
 * per land, with every field pre-declared at 0 so the shape stays monomorphic —
 * a hidden-class transition on the hottest object in the worker would cost more
 * than the two fbms it exists to avoid.
 */
let _ch = null;
let _chLand = null;
let _chFn = null;

/**
 * The kit `makeCharacter` is handed, built once. It is a module-scope const
 * rather than a per-call object because the land's factory captures it, so the
 * per-candidate cost is a closure variable rather than a property load.
 */
const _chKit = { forestDensity, wetness, fbm2, offsets };

/**
 * WHICH WORLD'S BIOMES THESE ARE.
 *
 * Same argument, and the same identity rule, as the grove offsets above: the
 * terrain is seeded per session, so leaving these two lattices on fixed offsets
 * would put the identical arrangement of meadow, thicket and needle litter over
 * every world anybody ever generates — the one thing the understorey exists to
 * stop, just at the scale of a session instead of at the scale of a wood.
 *
 * Seed 0 is `grove-01`, the identity world, and returns the identity offsets
 * verbatim rather than through an arithmetic that lands on them. Cached on the
 * seed for the same reason `grove` is: `character` runs tens of thousands of
 * times per understorey sector, so this must be one integer compare and not two
 * string hashes. It cannot be hoisted to module scope — the worker imports this
 * module before its seed arrives.
 */
let _fieldSeed = -1;
const _off = { ax: 41.3, az: -17.9, bx: -5.1, bz: 63.2 };

function offsets() {
  const s = getWorldSeed();
  if (s !== _fieldSeed) {
    _fieldSeed = s;
    if (s === 0) {
      _off.ax = 41.3;
      _off.az = -17.9;
      _off.bx = -5.1;
      _off.bz = 63.2;
    } else {
      // A separate hash per axis per field. One hash split four ways would
      // correlate the two lattices, and two correlated biome fields are one
      // biome field with a longer comment.
      for (const k of ['ax', 'az', 'bx', 'bz']) {
        _off[k] = (hashString(`biome:${k}:${s}`) % 100000) / 137.0 - 364;
      }
    }
  }
  return _off;
}

/**
 * What kind of place this is. Every weight is 0..1.
 *
 * THIS IS THE SINGLE SOURCE OF BIOME TRUTH, AND IT IS IN THIS FILE FOR THE
 * REASON THE FILE EXISTS.
 *
 * It used to live in undergrowth.js next to the layers it decides, and it
 * cannot: that module draws on a `<canvas>`, and every caller of this function
 * is now inside a worker. Copying the arithmetic across the boundary instead
 * was the alternative, and two copies of a biome field is a world that
 * disagrees with itself about what kind of place a point is at whatever radius
 * the two copies last drifted apart.
 *
 *
 * ==== THE ARITHMETIC MOVED TO THE LAND. THE CONTRACT DID NOT. ==============
 *
 * What is left here is the dispatch and the two invariants every land's version
 * has to keep, because they are properties of the CALLERS rather than of any
 * particular wood:
 *
 *   ONE OBJECT, FILLED IN PLACE. The answer is only valid until the next call.
 *   Ninety per cent of candidates are rejected on the first weight they look at,
 *   so returning a fresh object would be pure garbage in a worker.
 *
 *   TWO FIELDS AT DIFFERENT SCALES, AND THEY MUST NOT SHARE A LATTICE. `a` is
 *   the grain of the ground and `b` is how vigorous the growth is. Sampling both
 *   from the same offsets correlates them, and two correlated biome fields are
 *   one biome field with a longer comment. `offsets()` below hands every land
 *   the same four decorrelated per-seed numbers; what a land chooses is what to
 *   DO with them.
 *
 * AND THE ONE PIECE OF DESIGN ADVICE THAT SURVIVES THE MOVE, because it was
 * learnt the expensive way and applies to any land anybody writes:
 *
 *   THE WEIGHTS MUST BE COMPETITIVE RATHER THAN INDEPENDENT. In the rainforest
 *   `bramble` is multiplied by `1 - meadow`, `meadow` by `1 - damp`, and
 *   `litter` reads the OPPOSITE end of `a` from `meadow`. Independent weights
 *   produce a place that is 40% meadow and 40% thicket and 40% litter, which on
 *   the ground is a mess with no character at all — the eye reads mixture as
 *   noise. Making them exclude one another is what lets a region commit to
 *   being one thing.
 *
 *   AND EVERY PLACEMENT RULE MUST READ A WEIGHT RATHER THAN RE-DERIVING ONE.
 *   This function once went to real trouble to make three weights exclusive and
 *   then SEVEN layers read `out.canopy` raw and ignored all of it — sticks
 *   `0.1 + canopy*0.42`, saplings the same, bigleaf the same, palms
 *   `0.14 + canopy*0.5`, bushes a hand-rolled copy of the `edge` term, and so on
 *   — so every one of them peaked on the same ground and the closed-canopy floor
 *   came out as one uniform mat of everything at once. Roughly a hundred objects
 *   per 100 m², ninety-six of them under 3 m, against the 5-20% projected cover
 *   a real terra firme understorey has. A rule that copies a biome instead of
 *   reading one is a biome that has quietly forked.
 *
 * REBUILT ON A LAND CHANGE, not on every call. `setLand` runs once per realm
 * before anything samples this, so in practice the guard below is one identity
 * compare per candidate and the factory runs once in the life of the process.
 */
export function character(x, z, out) {
  const land = currentLand();
  if (land !== _chLand) {
    _chLand = land;
    _chFn = land.makeCharacter(_chKit);
    _ch = {};
    for (const k of land.weights) _ch[k] = 0;
  }
  return _chFn(x, z, out ?? _ch);
}

/**
 * How much forest wants to be at this point, 0..1.
 *
 * SEVEN TERMS, MULTIPLIED, AND THE PRODUCT IS NOT THE LAND'S TO CHANGE.
 *
 * Only the coefficients come from `land.density`. The SHAPE of this expression
 * stays here because three of its terms are world FEATURES rather than tuning,
 * and a land that could switch one off would be a land with a bug in it:
 *
 *   the clearing hole, because you have to be able to see where you are;
 *   the cave-mouth hole, because the one feature that must be legible from a
 *     distance was the one thing being screened;
 *   the gathering-place hole, because a fourteen-metre screen with four trees in
 *     front of it is not a cinema.
 *
 * Every land gets all three. What a land chooses is how coarse its stands are
 * (`grove*`), how hard water and slope bite, and how tight the ring of trees
 * around the spawn glade is (`rim*`).
 */
/**
 * How much of the tree field a path takes out at its centre.
 *
 * Not 1.0, and the difference is the whole reading of the feature. See the
 * block at the bottom of `forestDensity`.
 */
const PATH_TREE_GAIN = 0.85;

export function forestDensity(x, z) {
  const D = currentLand().density;
  const d = Math.hypot(x, z);
  // Groves and glades.
  let k = grove(x, z) * D.groveGain + D.groveBase;
  // The clearing is a hole in the field, with a soft rim so the edge of the
  // wood is ragged rather than a circle drawn on the ground.
  k *= smoothstep(clamp01((d - D.clearingRadius) / D.clearingRim));
  // Nothing grows in the stream.
  k *= 1 - clamp01(wetness(x, z) * D.wet);
  // Nothing grows on a cliff.
  k *= 1 - clamp01(slopeAt(x, z) * D.slope);
  // A dense band around the clearing, so the space you spawn in feels enclosed.
  k *= 1 + D.rimGain * Math.exp(-Math.pow((d - D.clearingRadius - D.rimOffset) / D.rimWidth, 2));
  /**
   * Nothing grows in a cave mouth, and the slope test above is why this is
   * needed rather than redundant.
   *
   * A ravine's walls are steep and correctly get nothing; its FLOOR is the
   * flattest ground for fifty metres, so it scored a HIGHER density than the
   * hillside it is cut into and the approach to every cave planted three to
   * five trees squarely in front of the arch. The one thing in that feature
   * which has to be legible from a distance was the one thing being screened.
   *
   * `caveClearance` reads the same notch profile `heightAt` carves with, so the
   * hole in the tree field cannot drift out of register with the hole in the
   * ground. It is 0 everywhere there is no cave, which is almost everywhere.
   */
  k *= 1 - caveClearance(x, z);
  /**
   * …and nothing grows where somebody has built something.
   *
   * The third hole in this field, and it exists for the same reason as the other
   * two. It is worse than it sounds without this, and in a way that is worth
   * writing down: the site chooser looks for the FLATTEST ground within 185 m,
   * and this very function scales density by `1 - slope * 2.4`. So "the best
   * place to put a clearing" and "the place the forest most wants to be" are the
   * same question with the same answer, and a build that skipped this step
   * planted every single site it had just chosen. The photographs were
   * unambiguous.
   *
   * `siteClearance` reads the same table `gathering.js` builds the props from —
   * hence it living in `sites.js`, which is the one module both a worker and the
   * main thread can import — so the hole and the thing standing in it cannot
   * drift apart.
   */
  k *= 1 - siteClearance(x, z);
  /**
   * …and thinner, but not empty, where people have WALKED.
   *
   * The fourth hole, and the only one that is deliberately not a hole. The
   * other three are places where a tree would be standing inside something, so
   * they take the density to zero; this one is a line between two of them, and
   * a corridor with no stems in it at all for four hundred metres is a forestry
   * ride. 0.85 leaves roughly one stem in seven standing in the line, which is
   * the difference between a path you follow and a road somebody cut.
   *
   * `pathTrees` is the NARROWER of the two path profiles — see the two-widths
   * block in sites.js. It is behind a 24 m spatial hash rather than a linear
   * scan, because there are eighty-odd segments against `siteClearance`'s nine
   * circles and this function is called a few hundred thousand times a sector.
   */
  k *= 1 - PATH_TREE_GAIN * pathTrees(x, z);
  return clamp01(k);
}

/* -------------------------------------------------------------------------- */
/* trodden ground                                                             */
/* -------------------------------------------------------------------------- */

/**
 * HOW WORN THE FLOOR IS AT THIS POINT: 0 where people stand, 1 in ordinary wood.
 *
 *
 * ==== `siteClearance` GATES TREES AND NOTHING ELSE, AND THAT WAS THE BUG ====
 *
 * `forestDensity` above carries `1 - siteClearance`, so a gathering place is a
 * hole in the TREE field — and every layer that reads `forestDensity` (directly
 * or through `character`) inherits the hole for free. That covers the trunks,
 * the logs, and every shade-loving layer whose weight is keyed to `canopy` or
 * `understorey`.
 *
 * It does the exact OPPOSITE for the sunlit ones, and that is not a detail. A
 * site is a hole in the canopy, `character` reads a hole in the canopy as LIGHT
 * (`meadow = 1 - canopy * 1.22`, `litter` floors out at 0.35), and the sward's
 * acceptance is `patch * (1 - litter)`. So the commons — a 23 m disc chosen for
 * being the flattest, driest ground within 185 m — scored the HIGHEST sward
 * weight in the world, and came out as a uniform lawn running up to and around
 * the fire and the speakers. Same mechanism, same failure, as the cave mouths:
 * clearing the canopy is a licence for the ground layer unless something says
 * otherwise. This is the thing that says otherwise.
 *
 * It is the most important place in the app. People stand in it and talk; it has
 * a screen, benches at 17.2 m and four fires in it. Trodden ground is what a
 * gathering place looks like, it is cheaper than a lawn, and the lighting
 * rebuild means the floor no longer has to be busy to be interesting.
 *
 *
 * ==== WHY THIS IS NOT JUST `1 - siteClearance(x, z)` ====
 *
 * Because that function is flat at 1 across the whole of `SITE_RADIUS` and only
 * fades over `SITE_RIM` — the right profile for trees, which have to be gone
 * from every square metre a bench might stand on, and the wrong one for grass.
 * Cover should come back sooner than the wood does: bare where the boots are,
 * thin through the seating, ordinary understorey by the time you reach the tree
 * line. So the profile here is built from the same table but with its own two
 * radii, and it reaches full cover at the same place the trees do rather than
 * inside them — an inner edge of bare ground and an outer edge of wood with a
 * graded band between is a clearing; two concentric circles a metre apart is a
 * stencil.
 *
 * `SITE_RIM` is not exported (and `sites.js` is not this pass's to edit), hence
 * the two factors below rather than reading it. Against the real table:
 *
 *   commons   r 23   bare to 12.6 m, ordinary by 34.5 m
 *   viewpoint r 8.5  bare to  4.7 m, ordinary by 12.8 m
 *   jetty     r 6.5  bare to  3.6 m, ordinary by  9.8 m
 *   hearth    r 6.2  bare to  3.4 m, ordinary by  9.3 m
 *
 * REJECTED: a flat multiplier on the whole disc (0.3x cover everywhere inside
 * the site). It reads as a texture change rather than as a place — the eye needs
 * the gradient to understand that the middle is where people are. Also rejected:
 * doing this inside `forestDensity`, which would have taken the trees with it
 * and undone the clearing.
 *
 *
 * ==== THE SPAWN DISC LIVES HERE TOO, AND IT USED TO LIVE IN ONE LAYER ====
 *
 * The meadow rule carried a hand-rolled `feet` term — 4.5 m of nothing ramping
 * to full over the next 5.5 — with a comment calling it "the one
 * distance-from-origin term left in the understorey". It was, and it was in one
 * layer of nine, which is why the sward and the giant leaves grew straight
 * through it. Same radii, same shape, now applied to every layer that reads
 * this: the spawn clearing is the ninth gathering place and it is the one you
 * are guaranteed to see first.
 */
const TROD_INNER = 0.55;
const TROD_OUTER = 1.5;
/** The spawn glade's own worn patch. The meadow rule's old `feet` numbers. */
const TROD_SPAWN_R = 4.5;
const TROD_SPAWN_RIM = 5.5;

let _trodSeed = -1;
/** @type {{x: number, z: number, r0: number, span: number, out: number}[]} */
let _trodSites = [];

/**
 * Memoised on the world seed for the reason `sites.js` and `grove()` both give:
 * this module is imported by the worker BEFORE its init message arrives, so at
 * import time the realm's seed is still 0 and anything computed at module scope
 * would describe the wrong world. `sitePlan()` is itself memoised, so the guard
 * below is one integer compare on the hot path.
 */
function troddenSites() {
  const s = getWorldSeed();
  if (s === _trodSeed) return _trodSites;
  _trodSeed = s;
  const plan = sitePlan();
  _trodSites = [];
  const add = (site, kind) => {
    if (!site) return;
    const r0 = SITE_RADIUS[kind] * TROD_INNER;
    const out = SITE_RADIUS[kind] * TROD_OUTER;
    _trodSites.push({ x: site.x, z: site.z, r0, span: out - r0, out });
  };
  add(plan.commons, 'commons');
  for (const h of plan.hearths) add(h, 'hearth');
  for (const v of plan.viewpoints) add(v, 'viewpoint');
  for (const j of plan.jetties) add(j, 'jetty');
  return _trodSites;
}

/**
 * 0 on worn ground, 1 in ordinary wood.
 *
 * The bounding-box bail before the hypot is worth having for the same reason
 * `siteClearance` has one: this runs on every candidate of six layers and misses
 * on almost all of them.
 */
export function trodden(x, z) {
  const d = Math.hypot(x, z);
  let k = smoothstep(clamp01((d - TROD_SPAWN_R) / TROD_SPAWN_RIM));
  /**
   * ==== AND THIS IS THE LINE BETWEEN THEM. ================================
   *
   * THIS FOLD IS WHAT ACTUALLY DRAWS A PATH, and it is worth being explicit
   * about why the mark has to arrive here of all places.
   *
   * The obvious way to draw a trodden line is to darken the ground under it.
   * The ground's vertex colour is computed in terrain.js; terrain.js cannot
   * import sites.js without a cycle (sites.js imports terrain.js for the height
   * field it measures its places on), so the ground literally cannot be told
   * where the paths are. What CAN be told is the scatter, because `trodden` is
   * already threaded into every land layer's `make()` — so the path is drawn by
   * the ABSENCE of sward, ferns and litter along it, which is what a worn line
   * through a wood is anyway. Nothing is painted, nothing is added, and the
   * cost is one hashed lookup per candidate.
   *
   * `pathClearance` is the WIDER of the two profiles — bare where the boots go,
   * against `pathTrees`'s narrower stand-off for the trunks. The two are folded
   * with `min` rather than multiplied for the same reason the site loop below
   * uses `min`: overlapping worn ground is not more worn than the worst of it,
   * and a product would make the junction where a path meets a clearing darker
   * than either, which is the one place it should be least distinct.
   */
  const way = pathClearance(x, z);
  if (way > 0) {
    const w = 1 - way;
    if (w < k) k = w;
    if (k <= 0) return 0;
  }
  const sites = troddenSites();
  for (let i = 0; i < sites.length; i++) {
    const c = sites[i];
    const dx = x - c.x;
    if (dx > c.out || dx < -c.out) continue;
    const dz = z - c.z;
    if (dz > c.out || dz < -c.out) continue;
    const dd = Math.hypot(dx, dz);
    if (dd >= c.out) continue;
    const w = smoothstep(clamp01((dd - c.r0) / c.span));
    if (w < k) k = w;
    if (k <= 0) return 0;
  }
  return k;
}

/**
 * True where a plant would be standing in the stream.
 *
 * Deliberately not "is the ground below the water plane". That test also
 * excludes any hollow that happens to be low, which in the first build was the
 * entire spawn clearing — so the middle of the world came out bald and nobody
 * could see why. Being underwater is a property of the channel, so ask the
 * channel.
 */
export function submerged(x, z) {
  return wetness(x, z) > 0.2 && heightAt(x, z) < WATER_LEVEL + 0.3;
}

/**
 * Which species wants this spot. The ladder itself is the land's — see
 * `speciesAt` in `lands/rainforest.js`, where every threshold and the reason
 * for each of them lives.
 *
 * WHAT STAYS HERE IS THE CALLING CONVENTION, and it is the load-bearing part:
 * `roll` is ONE draw compared against a ladder of thresholds in sequence, not
 * one draw per species. That is the kind of thing that gets "tidied" into five
 * draws by somebody who does not realise it reseeds the wood, and no land may
 * take a second draw here. `density` is `forestDensity(x, z)`, which
 * `treeSector` has already computed one line earlier, so it is a free argument
 * rather than a field evaluation.
 */
export function speciesAt(y, wet, roll, density = 1) {
  return currentLand().speciesAt(y, wet, roll, density);
}

/**
 * How wide a stump is to walk into.
 *
 * Kept here beside the placement rules rather than in forest.js because the
 * collider and the thing it wraps are decided in the same breath and drift
 * apart if they are decided in different files.
 *
 * THE 0.82 m FLOOR IS A CONTRACT WITH fauna.js AND IT IS NOT OPTIONAL.
 *
 * That file identifies trees inside `colliderGrid` by radius: "a trunk is
 * 0.28·scale + 0.34 for scale in 0.50..1.48, so 0.48..0.75; a fallen log is 1.1
 * and a boulder is 1.5. Anything under 0.8 is a tree and nothing else can be."
 * Every bird perch and every squirrel's climbing tree comes out of that filter.
 * `bushCue` below used to share this floor for the same reason; it no longer
 * needs to — see its own comment.
 *
 * THE UPPER END OF THAT RANGE IS THE CEILING ON THE INSTANCE SCALE, and it is
 * the reason the widened scale in `treeSector` stops at 1.48 rather than
 * somewhere rounder: 0.28·s + 0.34 crosses 0.8 at s = 1.643, and past that the
 * largest trees in the wood stop being indexed as trees at all. Nothing would
 * report it. The birds would simply never perch in the biggest tree in a stand.
 * A stump at r = 0.5 would therefore be indexed as a tree, and the symptom
 * would not be an error — it would be a chaffinch singing eight metres in the
 * air above a knee-high stump, which is the kind of thing that gets noticed in
 * a screenshot six weeks later and attributed to the birds.
 *
 * The floor costs nothing in feel. The body is 0.34 across, so a 0.82 m
 * collider stops the player's surface 0.48 m from the stump's centre and the
 * stump is 0.4–0.8 m wide at the base: you stop against it, not near it.
 */
export function stumpCollider(scale) {
  return Math.max(0.82, 0.62 * scale);
}

/**
 * How wide a bush has to be before brushing past it earns a rustle.
 *
 * THIS USED TO BE A PHYSICAL COLLIDER AND NO LONGER IS. Every bush still gets
 * a radius from this function, but it is now filed in `bushZones` — a second
 * `ColliderGrid` the controller only ever queries, never pushes against — so a
 * bush plays a sound instead of stopping the body. `colliderGrid` itself, and
 * therefore fauna's tree filter and the 0.82 m contract above, never sees a
 * bush entry at all: the two grids cannot disagree about what a trunk is
 * because bushes are no longer in the grid that question is asked of.
 *
 * ZERO still means "this one is scenery": most bushes get no cue, only roughly
 * the top third by width, which is the threshold this shares with the old
 * collider so that both scatters still agree on which bushes are worth
 * noticing. That gate was tuned for walkability when it blocked movement — at
 * 1.1 it measured 642 obstacles inside a 163 m disc, mean spacing about nine
 * metres — and is kept unchanged here because it still describes the right set
 * of bushes: not every leaf, but the mass you'd have walked round.
 *
 * The radius itself is also unchanged, `0.66 * scale`, but it is now a trigger
 * zone rather than a wall: the controller fires the cue on entry and does not
 * fire again until the body has left and re-entered, so walking through the
 * middle of one bush is one rustle, not one per frame.
 */
export function bushCue(scale) {
  return scale > 1.1 ? Math.max(0.82, 0.66 * scale) : 0;
}

/**
 * One instanced layer's worth of scattered things, still unbucketed.
 *
 * `matrix` is column-major 16, `color` is rgb or null, and the sphere is the
 * conservative world-space bound the culler tests. Built as plain arrays here
 * and packed into typed arrays by the caller, because the caller is the one
 * that knows how many there will be.
 */
class Layer {
  constructor(id) {
    this.id = id;
    this.matrix = [];
    this.color = [];
    this.cx = [];
    this.cy = [];
    this.cz = [];
    this.r = [];
  }

  get length() {
    return this.cx.length;
  }
}

/**
 * A yaw-and-scale matrix, written out rather than composed through Object3D.
 *
 * `Object3D.updateMatrix` allocates nothing but does compose a quaternion from
 * an Euler and then a full 4×4 from quaternion-plus-scale, and this is called
 * twenty-five thousand times for the grass in a single understorey sector. A
 * yaw-only rotation has six non-trivial entries and they are these.
 */
function yawMatrix(out, x, y, z, yaw, sx, sy, sz) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out[0] = c * sx;
  out[1] = 0;
  out[2] = -s * sx;
  out[3] = 0;
  out[4] = 0;
  out[5] = sy;
  out[6] = 0;
  out[7] = 0;
  out[8] = s * sz;
  out[9] = 0;
  out[10] = c * sz;
  out[11] = 0;
  out[12] = x;
  out[13] = y;
  out[14] = z;
  out[15] = 1;
  return out;
}

const _m4 = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _tint = new THREE.Color();

/** Full three-axis version, for the handful of layers that tumble. */
function tiltMatrix(out, x, y, z, rx, ry, rz, sx, sy, sz) {
  _euler.set(rx, ry, rz);
  _quat.setFromEuler(_euler);
  _pos.set(x, y, z);
  _scale.set(sx, sy, sz);
  _m4.compose(_pos, _quat, _scale);
  for (let i = 0; i < 16; i++) out[i] = _m4.elements[i];
  return out;
}

/**
 * A stable pseudo-random 0..1 from two integers, TAKING NO `rng()` DRAW.
 *
 * This exists because of the draw-order invariant documented on the sward's
 * tint block: a sector's whole contents come off one seeded stream in one
 * order, so anything that wants a per-instance random number and is not willing
 * to move every plant placed after it cannot ask the generator for one. An fbm
 * lookup is the usual escape hatch (the fern and meadow patch fields are both
 * that) but fbm is smooth, and what the sward needs here is the opposite — a
 * value that is INDEPENDENT between neighbouring tufts, because the whole
 * complaint is that adjacent plants are the same object.
 *
 * So: an integer avalanche over the GLOBAL lattice cell, which every layer
 * already has in `(sx, i)` and `(sz, j)`. It is a pure function of world
 * position, identical in both realms, costs four multiplies, and is invisible to
 * the seeded stream. `Math.imul` keeps everything in int32; the constants are
 * the usual xxhash/murmur finalisers.
 */
function latticeHash(a, b) {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function push(layer, matrix, color, cx, cy, cz, r) {
  for (let i = 0; i < 16; i++) layer.matrix.push(matrix[i]);
  if (color) for (let i = 0; i < 3; i++) layer.color.push(color[i]);
  layer.cx.push(cx);
  layer.cy.push(cy);
  layer.cz.push(cz);
  layer.r.push(r);
}

const _mat = new Float64Array(16);
const _col = new Float64Array(3);

/**
 * Every tree in one 128 m sector — which, since the protected disc went, means
 * every tree in the world including the one you spawn under.
 *
 * `bounds` maps a layer id to the `{cy, r}` of its geometry's bounding sphere,
 * measured on the main thread where the geometry lives and shipped in with the
 * worker's init message. The instance's sphere is that scaled and hung on its
 * origin.
 *
 * SPACING IS 4 m AND THE GRID IS ANCHORED TO THE SECTOR, NOT THE WORLD, which
 * is what makes a sector's contents depend on nothing but its own coordinates.
 *
 * That is the whole determinism story and it is worth stating plainly, because
 * it is stronger than what it replaced. Multiplayer is shipped and nothing
 * about the world travels over the wire: every player derives the same tree
 * from `seed:tree:sx:sz` and the same arithmetic, in any order, on any number
 * of workers, whatever route they walked. The eager scatter this replaced drew
 * from one rng in one fixed order across five layers, so it was reproducible
 * only as long as nobody inserted a draw anywhere in the middle of it.
 * Anchoring the grid globally would have been equivalent today; seeding per
 * sector is what makes the property survive somebody changing the sector size.
 */
/**
 * How many accepted trees are dead standing timber.
 *
 * 2% rather than the fifth of the stems a real closed forest carries, and the
 * gap is deliberate: this is not an ecology model, it is a landmark rate. Dead
 * wood is only interesting while it is rare enough that meeting one is an
 * event, and at a fifth of the wood a snag is wallpaper with the additional
 * property of being bald.
 *
 * MEASURED as the difference between the trunk and canopy instance counts over
 * a 7×7 block of 128 m sectors in node, which is exactly what a snag is here:
 * 590 of 29 928 on `grove-01` (1.97%), 545 of 27 905 on `taiga:grove-01`,
 * 531 of 27 509 on `ash-hollow-4471`. That is twelve standing dead trees in a
 * 128 m square — one in sight most of the time, two together occasionally.
 */
const SNAG_CHANCE = 0.02;

export function treeSector({ seed, sx, sz, size, archetypes, bounds, tints }) {
  const rng = makeRng(`${seed}:tree:${sx}:${sz}`);
  const land = currentLand();
  const treeScale = land.treeScale;
  const substitute = land.substitute;
  // The first species this build actually grew. Only read when a substitution
  // is needed, i.e. never in a land whose roster is complete.
  const grown0 = land.roster.find((n) => tints[n]) ?? Object.keys(tints)[0];
  const ox = sx * size;
  const oz = sz * size;
  const spacing = 4.0;
  const steps = Math.round(size / spacing);

  const layers = new Map();
  const collide = [];
  /**
   * STANDING DEAD TIMBER, IN ITS OWN LIST, AND THE REASON IS A BIRD.
   *
   * The dead-wood block below says why the snag collider deliberately stays in
   * the "this is a tree" band — the whole point is that fauna.js keeps treating
   * it as one — and it says what that is FOR: a snag is the one place in this
   * canopy where a perched bird is against the sky instead of behind two metres
   * of alpha-tested leaf card. Cashing that needs the picker to be able to
   * PREFER one, and it cannot, because a snag's collider radius is
   * `0.28*scale + 0.34`, which is exactly a live trunk's. There is nothing in
   * the triple to read.
   *
   * A SECOND FLAT ARRAY RATHER THAN A FOURTH CHANNEL, which is the same answer
   * `rustle` gave to the same question. Widening `collide` to a stride of four
   * would touch every `collide.push` in this file and `ColliderGrid.addSector`
   * for one bit; a parallel list rides the worker payload beside `rustle`, lands
   * in a `ColliderGrid` of its own, and is invisible to everything that does not
   * ask for it. Same triples, same machinery, no new concept.
   *
   * It costs SNAG_CHANCE of the stems — about one in fifty — so this array is
   * roughly a fiftieth the length of `collide`.
   */
  const snags = [];

  /**
   * ==== THE EMERGENT GIANT: "MEET ME AT THE BIG TREE" ======================
   *
   * There was no big tree. `treeScale` is 0.50–1.48, so the largest trunk in
   * the wood is three times the smallest and — because the eye judges a tree
   * against the ones beside it rather than against a metre rule — every stand
   * read as one size. A landmark you can arrange to meet at has to be
   * unmistakable from inside the stand it is in, and 1.48 never was.
   *
   * A SECOND SEEDED GENERATOR, NOT A DRAW FROM THE SECTOR'S STREAM. Everything
   * below is decided per SECTOR, and taking those decisions off `rng` would
   * shift every tree in the world by the number of draws taken — which is
   * survivable but pointless. `${seed}:big:${sx}:${sz}` is the same purity
   * argument the sector stream makes (a pure function of the seed and the
   * sector's own coordinates, independent of build order and of how many
   * workers there are) and it costs one mulberry32 construction per sector.
   *
   * WHICH SPECIES IS READ OFF THE LAND. `land.giant` names the row with the
   * widest bole — kapok at `trunkRadius: 0.7` in the rainforest, three times
   * the palm beside it — because "which of our trees is the emergent" is a fact
   * about a land and not about this file. A land that does not declare one gets
   * no giants and nothing reports a problem: this is scenery, and a land layer
   * that throws because it has not been told about a feature is a land layer
   * nobody can develop against, which is the posture the `substitute` block
   * below already takes.
   *
   * WHERE, rather than which-th. The promotion needs a target BEFORE the
   * acceptance loop runs, because a candidate is pushed the moment it is
   * accepted and rewriting a matrix after the fact would mean buffering every
   * tree in the sector. So a uniform point in the sector is drawn up front and
   * the first eligible accepted candidate within 16 m of it is promoted. The
   * point is uniform, so there is no raster-order bias worth the name (the disc
   * is 32 m across in a 128 m sector); and where the wood happens to be thin
   * around the point no giant appears at all, which is the right answer —
   * an emergent stands in closed forest.
   */
  const meta = makeRng(`${seed}:big:${sx}:${sz}`);
  /**
   * At most one per four sectors.
   *
   * MEASURED over a 7×7 block of 128 m sectors in node, counting the offset
   * collider circles: 11 giants in 49 sectors on `grove-01`, 13 on
   * `taiga:grove-01`, 7 on `ash-hollow-4471` — so 14–27% of sectors get one
   * against the 25% asked for here, the shortfall being sectors whose target
   * point landed on ground too thin to grow the right species. That works out
   * at roughly one giant per 75 000 m², i.e. one within about 150 m of
   * wherever you are standing. Rarer than that and "meet me at the big tree"
   * stops being a thing two people can both find.
   */
  const wantGiant = land.giant && tints[land.giant] && meta() < 0.25;
  const giantX = ox + meta() * size;
  const giantZ = oz + meta() * size;
  /**
   * 2.2–2.8, which is roughly 1.5–1.9 times the biggest ordinary tree.
   *
   * The floor is a judgement: below about 2.1 a kapok among kapoks reads as a
   * lucky tree rather than as THE tree, because the eye judges it against its
   * neighbours and 1.48 already exists. The ceiling is a caution about burial
   * rather than a measurement, and it is the honest statement of what is known:
   * the scale block below records that the root flare is in OBJECT space and so
   * scales with the tree, while the 0.25 m sink is absolute — so a LARGE tree
   * gets proportionally less of it and is the direction in which exposure gets
   * worse. That block measured 0.07% exposure across 15 084 trunks at scales up
   * to 1.48; nothing has measured this range, and 2.8 is where the sink is
   * still a tenth of the 2.5 m bottom-ring radius rather than a fortieth.
   * Somebody adding a bigger one should run that census first.
   */
  const giantScale = 2.2 + meta() * 0.6;
  let giantLeft = wantGiant;

  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      const x = ox + (i + rng()) * spacing;
      const z = oz + (j + rng()) * spacing;
      const density = forestDensity(x, z);
      if (rng() > density) continue;
      if (submerged(x, z)) continue;
      const y = heightAt(x, z);
      /**
       * A SPECIES THE BUILD DID NOT GROW FALLS BACK, RATHER THAN THROWING.
       *
       * `tints` holds exactly the species `forest.js` grew, so this test is
       * "did the roster this land asked for actually exist in `SPECIES`". A
       * roster is a land's wish and `SPECIES` is what exists, they are edited
       * in different files, and a land that throws on a missing row is a land
       * nobody can develop against. It is not hypothetical: the taiga's five
       * conifers were a wish for one release before they landed.
       *
       * NO LAND SHIPS A `substitute` TABLE TODAY. The taiga had one — spruce
       * and fir and larch all onto `palm` — and it was deleted when the
       * conifers landed, because the only way it could ever fire again is if
       * somebody DELETED a conifer from `SPECIES`, and what it would do then is
       * put palm trees in the snow. `?? grown0` gives that land spruce instead,
       * which is the right answer to "we lost a species here" and needs no
       * table. The mechanism stays because "nearest tree we do have" is a
       * judgement about silhouette that only a land can make.
       *
       * IT COSTS ONE PROPERTY TEST ON AN ACCEPTED CANDIDATE and takes no draw,
       * so the stream is untouched and the rainforest — whose roster is
       * complete — never takes the branch.
       */
      let name = speciesAt(y, wetness(x, z), rng(), density);
      if (!tints[name]) name = (substitute && substitute[name]) || grown0;
      const a = Math.floor(rng() * archetypes) % archetypes;
      /**
       * SIZE: 0.50 TO 1.48, AND THE TWO ENDS WERE CHOSEN AGAINST DIFFERENT
       * CONSTRAINTS.
       *
       * It was 0.68–1.34, a ratio of 1.97, and the complaint was that the trees
       * are all the same size. They nearly are: the smallest oak in the world
       * was 11 m × 0.68 = 7.5 m and the smallest birch 8.2 m, so there was no
       * such thing as a young tree between the knee-high `saplings` layer and a
       * two-storey one. The wood had a canopy and a floor and nothing in
       * between. 2.96 is the ratio now, and the bottom of it is a genuine
       * six-metre sapling standing in the same stand as a forty-metre pine.
       *
       * THE TOP IS A COLLIDER CEILING AND IT IS HARD. `collide` below pushes
       * `0.28 * scale + 0.34`, and fauna.js identifies trees in `colliderGrid`
       * by radius — "anything under 0.8 is a tree and nothing else can be". That
       * puts an absolute ceiling on this number at 1.643, above which the
       * BIGGEST trees in the forest stop being indexed as trees and the birds
       * quietly stop perching in them. 1.48 gives 0.754, which is 6% of margin;
       * anything past about 1.6 is asking for a bug that presents as ornithology.
       *
       * THE PAIR IS AREA-NEUTRAL, WHICH IS WHY BOTH ENDS MOVED AT ONCE. Canopy
       * cost is rasterised area, i.e. scale SQUARED, and for a uniform draw on
       * [a,b] the expected square is (a² + ab + b²)/3. The old range gives
       * 1.0564 and this one gives 1.0601 — three parts in a thousand more
       * canopy, which is below anything that could be measured on this machine.
       * Widening only the top would have been +13% of foliage area, or about a
       * quarter of a millisecond at peak, for the same visible effect.
       *
       * BURIAL IS UNAFFECTED, AND IT WAS CHECKED RATHER THAN ARGUED. The reason
       * to expect it to be fine is that the root flare is in OBJECT space, so it
       * shrinks with the tree — but so does the bole whose rim has to stay under
       * the dirt, and so does the distance downhill the ground falls away across
       * it; the ratio is scale-invariant, and the one term that does NOT shrink
       * is the 0.25 m sink below, which a small tree gets in full. See
       * ROOT_FLARE in trees.js.
       *
       * Measured the way that block measures it — 15 084 trunks over a 640 m
       * box, analytic ground sampled at twelve points round the bottom ring —
       * 11 of them have the rim above the dirt somewhere, 0.07%, against the
       * 0.84% that block records for the state it was written in. Split at the
       * OLD floor of 0.68: the worst exposure among the 2710 trees that only
       * exist because of this change is 3 cm, and the worst in the whole world
       * is 44 cm on a tree the old range would have produced as well. The small
       * trees are not the problem and were never going to be.
       */
      const scale = rngRange(rng, treeScale[0], treeScale[1]);
      const yaw = rng() * TAU;

      /**
       * ==== DEAD WOOD ======================================================
       *
       * A SNAG IS THE CANOPY PUSH NOT HAPPENING. `treeSector` pushes the trunk
       * and the canopy as two INDEPENDENT instances that happen to share one
       * matrix, so a standing dead tree costs nothing to express: skip the leaf
       * push, keep the trunk. That is the whole mechanism, and it is why this
       * is six lines rather than an archetype.
       *
       * WHY IT IS WORTH HAVING TWICE OVER. A wood in which every tree is alive
       * and healthy is a wood nobody has ever walked in — dead standing timber
       * is a fifth of the stems in real closed forest — and it is the SECOND
       * effect that decided it: a snag is the one place in this canopy where
       * you can actually see a bird. The perchers are seated off `colliderGrid`
       * (see the 0.82 m contract at `stumpCollider`) and they sit on branches
       * that are, in a living tree, inside two metres of alpha-tested leaf
       * card. On a snag the branch is bare against the sky. So the collider
       * stays squarely in the "this is a tree" band — the whole point is that
       * fauna keeps treating it as one.
       *
       * BLEACHED, NEVER DARKENED, and there is a mechanical reason as well as
       * the tree-adorn luma rule. The trunk tint is WHITE with a lightness
       * offset, multiplied over the bark texel, and `Color.setHSL` clamps
       * lightness to 1 — so the positive half of the ordinary `-0.13..0.06`
       * jitter is already a no-op and the only thing this tint can do is
       * darken. A snag therefore cannot be made greyer than the bark; what it
       * can be is the palest trunk in the wood, which is what `-0.03..0.06`
       * below does. Dead wood in this forest silvers; it does not char.
       *
       * SQUASHED, so it reads as BROKEN rather than merely bare. A bare tree at
       * full height is a tree in winter. Taking a third to a half off the
       * vertical scale foreshortens the crown branches into stubs and thickens
       * the bole against its own height, which is what a snapped-off trunk
       * looks like. Non-uniform scale is free here — `yawMatrix` already takes
       * three of them and only ever got the same number three times.
       *
       * ONE KNOWN SEAM, AND IT IS 384 m AWAY. `forest.js` builds the impostor
       * billboard as a `mirrorOf` the TRUNK payload — one worker result feeding
       * two slabs — so a snag past `IMPOSTOR_REACH` is drawn as a whole leafy
       * tree, and pops bare when the real geometry takes over. Fixing it needs
       * a third payload channel in a file this pass does not own, and 384 m in
       * this wood is past the range at which a canopy hides everything: the
       * recorded finding is that cutting draw distance is invisible at eye
       * level. Worth knowing about if anybody ever puts a snag on a ridge.
       *
       * ONE DRAW, USED TWICE. `deadRoll` decides both whether this is dead wood
       * and, through its position inside the accepting band, how squashed and
       * how far it leans. Deriving the shape from the roll rather than drawing
       * again keeps the stream cost of the whole feature at one draw per
       * accepted candidate instead of three, and the low bits of a mulberry32
       * output are as good as the high ones.
       */
      const deadRoll = rng();
      const snag = deadRoll < SNAG_CHANCE;
      /** 0..1 across the accepting band — the free shape parameter. See above. */
      const deadShape = snag ? deadRoll / SNAG_CHANCE : 0;
      /** Half of them lean. A leaner is a snag that lost the argument. */
      const lean = snag && deadShape > 0.5 ? (deadShape - 0.5) * 0.9 : 0;

      /**
       * ONE PALETTE PER ARCHETYPE, because the archetype is which sub-population
       * this tree belongs to and not merely which skeleton it got.
       *
       * A birch on the turn wants gold and a birch in leaf wants green, and they
       * are archetypes 2 and 0 of the same species; a rowan in blossom wants a
       * nearly neutral tint, because the instance colour MULTIPLIES the texel and
       * a white petal under a green tint is not a white petal. See the variants
       * block in trees.js. The fallback keeps a species with fewer palettes than
       * archetypes working rather than reading `undefined`.
       */
      const palette = tints[name][a] ?? tints[name][0];
      _tint.setHex(palette[Math.floor(rng() * palette.length) % palette.length]);
      /**
       * The jitter, widened from ±0.03 / ±0.09 in hue and lightness.
       *
       * ±0.045 of hue is ±16°, which is about the spread between two trees of
       * one species in one stand and is the difference between a palette of five
       * colours and a continuum through them. It is applied AFTER the palette
       * pick, so a wide palette and a wide jitter compound rather than one
       * hiding the other — five entries at ±16° covers the green band without
       * any entry needing to be a colour a leaf could not be.
       */
      _tint.offsetHSL(rngRange(rng, -0.045, 0.045), rngRange(rng, -0.12, 0.1), rngRange(rng, -0.12, 0.11));
      const lr = _tint.r;
      const lg = _tint.g;
      const lb = _tint.b;
      // Bleached, never darkened. See the dead-wood block above for why the
      // positive half of the ordinary range is a no-op and this range is not.
      _tint
        .setHex(0xffffff)
        .offsetHSL(0, 0, snag ? rngRange(rng, -0.03, 0.06) : rngRange(rng, -0.13, 0.06));

      /**
       * The promotion. `giantLeft` is cleared on the first taker, so a sector
       * that draws a giant gets exactly one however many kapoks stand near the
       * target point. 16 m of radius against the sector's 128 puts ~4 eligible
       * candidates inside the disc in closed forest and none at all in a glade.
       */
      let big = false;
      if (
        giantLeft &&
        name === land.giant &&
        (x - giantX) * (x - giantX) + (z - giantZ) * (z - giantZ) < 256
      ) {
        big = true;
        giantLeft = false;
      }
      /**
       * Girth and height are the same number for everything but a snag.
       *
       * The squash runs 0.50–0.94 of full height across the accepting band, and
       * because `lean` is keyed to the SAME `deadShape`, the two sort
       * themselves out: the upright half of the band (deadShape < 0.5) gets the
       * hard squash and is a broken-off stump, and the leaning half is barely
       * squashed and is a whole tree that has come over. That coupling was not
       * designed, it fell out of reusing one roll — and it is the right way
       * round, so it stays.
       */
      const wide = big ? giantScale : scale;
      const tall = big ? giantScale : snag ? scale * (0.5 + deadShape * 0.44) : scale;

      const base = y - 0.25;
      if (lean !== 0) {
        // A leaner rotates about its own FOOT, because `compose` rotates about
        // the object origin and the trunk geometry's origin is the root plate.
        // Tipping about the middle would put the butt underground and the roots
        // in the air.
        tiltMatrix(_mat, x, base, z, Math.cos(yaw) * lean, yaw, Math.sin(yaw) * lean, wide, tall, wide);
      } else {
        yawMatrix(_mat, x, base, z, yaw, wide, tall, wide);
      }

      const trunkId = `trunk:${name}:${a}`;
      const leafId = `leaf:${name}:${a}`;
      let trunk = layers.get(trunkId);
      if (!trunk) layers.set(trunkId, (trunk = new Layer(trunkId)));

      const tb = bounds[trunkId];
      _col[0] = _tint.r;
      _col[1] = _tint.g;
      _col[2] = _tint.b;
      /**
       * THE WIDER BOUND IS THE PART OF A LEANER THAT MUST NOT BE SKIPPED.
       *
       * The culler tests this sphere and nothing else. A tilted instance keeps
       * its foot but swings its crown up to `cy * tall * sin(lean)` sideways —
       * 3.6 m on a twenty-metre trunk at 26° — and a bound that did not follow
       * would pop the tree out of existence when the sphere left the frustum
       * while the wood was still on screen. Inflating the radius rather than
       * moving the centre is deliberately conservative: it costs a few pixels
       * of overdraw on one instance in fifty and cannot be wrong in the
       * direction that deletes geometry.
       */
      const swing = lean !== 0 ? tb.cy * tall * Math.abs(Math.sin(lean)) : 0;
      push(trunk, _mat, _col, x, base + tb.cy * tall, z, tb.r * wide + swing);
      /**
       * A SNAG HAS NO CANOPY, and that is the whole of the mechanism: the two
       * instances were always independent and this one simply does not happen.
       * Note the layer is not created either — an empty layer is dropped by
       * forest-worker.js anyway, but not making it says what is meant.
       */
      if (!snag) {
        let leaf = layers.get(leafId);
        if (!leaf) layers.set(leafId, (leaf = new Layer(leafId)));
        const lb2 = bounds[leafId];
        _col[0] = lr;
        _col[1] = lg;
        _col[2] = lb;
        push(leaf, _mat, _col, x, base + lb2.cy * tall, z, lb2.r * wide + swing);
      }

      if (big) {
        /**
         * ==== TWO MEANINGS IN ONE NUMBER, PRISED APART ====================
         *
         * `collide` entries carry a radius that is BOTH "how wide is this to
         * walk into" and "what kind of thing is this". fauna.js reads the
         * second meaning off the first — "anything under 0.8 is a tree and
         * nothing else can be" — and it is the reason `treeScale` stops at
         * 1.48: 0.28·s + 0.34 crosses 0.8 at s = 1.643, and past that the
         * biggest trees in the wood stop being indexed as trees. A 2.5× tree
         * pushed as one circle would be r = 1.04, which fauna would silently
         * file as a fallen log. Nothing would report it. The symptom would be
         * that no bird ever perches in the one tree everybody meets at, and it
         * would present as ornithology six weeks later.
         *
         * So the two meanings become two kinds of entry, which is exactly the
         * shape this list already supports:
         *
         *   ONE CENTRE CIRCLE AT 0.75, a deliberate understatement of girth.
         *   This is the INDEX entry — under 0.8, so fauna calls it a tree, and
         *   `trunkIndex` hands the birds `r - 0.34 = 0.41` as the bark radius
         *   to sit on. It is smaller than the real bole, so a bird sits a
         *   little inside the trunk rather than a long way outside it, which is
         *   the direction to be wrong in.
         *
         *   FOUR OFFSET CIRCLES that do the actual blocking, sized to land
         *   BETWEEN fauna's tree threshold (0.8) and the fallen-log radius
         *   (1.1). Nothing in the app reads that band — the hearth colliders
         *   are already at 0.95 — so they stop the body and are invisible to
         *   every classifier. Their union reaches the true collision radius on
         *   the four axes and comes within about five centimetres of it on the
         *   diagonals, which is the thickness of a bark texture.
         *
         * CHECKED BY COUNTING, over a 7×7 block of sectors in node: the number
         * of collider entries under 0.8 is EXACTLY the number of trunk
         * instances in all three worlds tested (29 928 on grove-01, 27 905 on
         * taiga:grove-01, 27 509 on ash-hollow-4471), the offset circles all
         * land in 0.84–0.966, and nothing at all comes out at 1.1 or above. So
         * every tree in the wood — giant, snag and ordinary — contributes one
         * perch and one only, and the blockers are invisible to the filter.
         */
        const wall = 0.28 * giantScale + 0.34;
        const sat = Math.min(1.02, Math.max(0.84, wall * 0.86));
        const off = Math.max(0, wall - sat);
        collide.push(x, z, 0.75);
        for (let q = 0; q < 4; q++) {
          const qa = yaw + q * (Math.PI / 2);
          collide.push(x + Math.cos(qa) * off, z + Math.sin(qa) * off, sat);
        }
      } else {
        // Unchanged, snags included: a snag has to stay in the tree band or the
        // birds stop perching on the one thing you can see them on.
        collide.push(x, z, 0.28 * scale + 0.34);
      }
      /**
       * AND ONCE MORE INTO THE SNAG LIST, if it is one. See `snags` above.
       *
       * After the branch rather than inside either arm, because `snag` and `big`
       * are independent rolls and a tree can be both — an emergent giant that
       * died standing is the single best perch in this wood and would have been
       * the one case a push inside the `else` missed. The radius is whichever
       * circle that branch just used, so the two grids agree to the metre.
       */
      if (snag) snags.push(x, z, big ? 0.75 : 0.28 * scale + 0.34);
    }
  }
  return { layers, collide, rustle: [], snags, patches: [], glow: [] };
}

/**
 * Everything low in one 64 m sector: sward, ferns, stones, deadfall, fungi.
 *
 * They share a sector because they share a scale — none of them is worth
 * looking at past a hundred metres, so none of them wants the tree grid's 384 m
 * reach, and generating a 256 m sector's worth of grass would be a hundred and
 * eighty thousand instances for ground the player will never stand on.
 */
export function underSector({ seed, sx, sz, size, bounds, rockSizes }) {
  const rng = makeRng(`${seed}:under:${sx}:${sz}`);
  const land = currentLand();
  const ox = sx * size;
  const oz = sz * size;
  const layers = new Map();
  const collide = [];
  const rustle = [];
  const patches = [];
  const glow = [];
  const layer = (id) => {
    let l = layers.get(id);
    if (!l) layers.set(id, (l = new Layer(id)));
    return l;
  };

  /**
   * THE KIT, and why it is one object built once per sector rather than a long
   * argument list or a set of module imports.
   *
   * A land's rules need the terrain (`heightAt`, `slopeAt`, `wetness`,
   * `caveClearance`), this file's own fields (`character`, `trodden`,
   * `submerged`, `forestDensity`), its matrix and push helpers, and its three
   * scratch objects. Importing them from a land module would be a cycle —
   * `terrain.js` imports the land layer for its ground palette — so they are
   * INJECTED instead, and the injection point is here because this is where the
   * per-sector state (`rng`, `ox`, `oz`, the layer map) already lives.
   *
   * IT IS PASSED TO A FACTORY, NOT TO A BODY, and that is the whole performance
   * story. Every rule below is `make(K)` returning the per-candidate closure, so
   * a rule's body reads `rng()` and `heightAt(x, z)` as free variables captured
   * once per sector — exactly what they were when this code was welded into this
   * file — rather than as property loads on ninety thousand candidates. Twelve
   * closure allocations per sector against roughly a million property reads
   * saved; it is also what made the extraction a copy rather than a rewrite, and
   * why the identity hash held on the first run.
   */
  const K = {
    rng,
    ox,
    oz,
    size,
    sx,
    sz,
    bounds,
    rockSizes,
    layers,
    layer,
    collide,
    rustle,
    patches,
    glow,
    push,
    yawMatrix,
    tiltMatrix,
    latticeHash,
    _mat,
    _col,
    _tint,
    character,
    trodden,
    submerged,
    forestDensity,
    stumpCollider,
    bushCue,
    slopeAt,
    wetness,
    heightAt,
    groundUnder,
    caveClearance,
    WATER_LEVEL,
    fbm2,
  };

  /**
   * The coarse half — sward, ferns, stones, deadfall, fungi in the rainforest,
   * and whatever a land's own equivalents are. See `makeCoarse` in the land
   * module for why these five are a function and the twelve below are a table.
   *
   * IT RUNS FIRST AND ITS ORDER IS THE LAND'S TO FREEZE. The whole sector comes
   * off one seeded stream in one order.
   */
  land.makeCoarse(K);

  // ---- the understorey ----------------------------------------------------
  /**
   * THE UNDERSTOREY LAYERS — every square metre of the world, including the one
   * you are standing on when the gate lifts.
   *
   * These used to exist twice: once here, and once as an eager scatter in
   * forest.js covering a disc of 118–163 m around the origin, with this half
   * forbidden to place anything inside 163.4 m. What that bought was a bald
   * annulus, because the five tall layers' authored discs stopped between 118
   * and 140 m and this half could not start until 163.4 — 23 to 51 m of ground
   * that neither sampler planted, wide enough to stand in and look along.
   *
   * There is one sampler now and it starts at r = 0. See the file header for the
   * measurements that decided it, and note the shape of the answer: the annulus
   * was not patched, it was made impossible to express.
   *
   *
   * WHY THESE RIDE THE 32 m UNDERGROWTH GRID AND NOT THE 128 m TREE GRID.
   *
   * Because they are undergrowth. An 80 m ring reaching ~112 m with the sector
   * overshoot is past where a 0.42 m grass clump is three pixels tall at 1440p,
   * the eviction and collider plumbing already exists, and putting them on the
   * tree grid would generate bushes out to 565 m at a density nobody could
   * resolve through the fog. The price is that they arrive and leave four times
   * as often as a tree sector does, which is the shape the frame prefers.
   */
  {
    /**
     * One understorey layer's grid over this sector.
     *
     * THE LATTICE TILES THE SECTOR EXACTLY AND THE DENSITY IS CORRECTED FOR IT.
     *
     * `steps = round(size / spacing)` on its own is what the coarse layers do,
     * and it is quietly wrong by up to a quarter at these spacings: the stumps
     * want 20 m in a 32 m sector, which rounds to two steps of 20 m and lays
     * candidates out to 40 m — a fifth of every stump placed in the neighbour's
     * ground, and 56% too many of them. Rocks have the same problem in both
     * directions and have always had it; it is survivable there because a rock
     * is rare and unremarkable, and it is not survivable for a layer the player
     * is standing in.
     *
     * So the step is `size / steps`, which tiles the sector exactly, and the
     * acceptance is multiplied by `(step / spacing)²` to put the expected
     * instances per square metre back on the tuned figure — fewer, bigger cells
     * accept proportionally harder. Stumps come out at 2 steps of 16 m and
     * 0.64× acceptance, which is the density the layer was tuned at to the last
     * decimal rather than to the nearest rounding.
     *
     * `p` handed to the body is that correction and nothing else — the radial
     * seam fade it used to carry went with the seam — so a body reads
     * `if (rng() > <the layer's own probability> * p) continue` and the
     * probability is textually the tuned one.
     *
     * `if (!bound) return` IS HOW A LAND DROPS A LAYER. A land that does not
     * list `bromeliads` never has the geometry built in forest.js, so `bounds`
     * has no entry, so this returns before the grid is walked and the rule never
     * runs. That seam predates the land layer — it is how `SWARD_FORMS` degrades
     * when `grass-b` is absent — and it is why dropping six layers for the taiga
     * needed no edit here at all.
     */
    const underLayer = (id, spacing, body) => {
      const bound = bounds[id];
      if (!bound) return;
      const l = layer(id);
      const steps = Math.max(1, Math.round(size / spacing));
      const step = size / steps;
      const dens = (step / spacing) * (step / spacing);
      for (let j = 0; j < steps; j++) {
        for (let i = 0; i < steps; i++) {
          const x = ox + (i + rng()) * step;
          const z = oz + (j + rng()) * step;
          /**
           * A CAVE MOUTH IS A HOLE IN EVERY UNDERSTOREY LAYER, AND CLEARING THE
           * CANOPY WAS MAKING IT THE OPPOSITE.
           *
           * `caveClearance` reaches these layers only through `forestDensity`,
           * and the rainforest's `character` reads that as
           * `meadow = 1 - canopy * 1.22`: light. So a gully — which is a hole in
           * the tree field on purpose — scored the HIGHEST meadow weight in the
           * world, and the approach to every cave came out as chest-high hay with
           * the doorway somewhere behind it. `.shots/crag/a4-mouth.png` was a
           * photograph of a cave mouth with no cave mouth in it; the mound the
           * portal deletes was only ever the second thing in the way.
           *
           * HERE RATHER THAN IN EACH BODY because it is true of every land as
           * well as of every layer — a cave mouth has to be legible whatever is
           * growing round it — and before the body rather than inside it because
           * the two position draws above have already been taken, so the seeded
           * stream only diverges where there is a cave.
           */
          if (caveClearance(x, z) > 0.35) continue;
          body(x, z, l, bound, dens);
        }
      }
    };

    for (const rule of land.understorey) underLayer(rule.id, rule.spacing, rule.make(K));
  }

  // `snags` is empty here and is returned anyway: the field reads the key on
  // every payload, and an absent one is a crash rather than a no-op. Nothing in
  // this sector stands up — its deadfall is already lying down.
  return { layers, collide, rustle, snags: [], patches, glow };
}

/**
 * Sort a layer's instances into XZ buckets and emit them bucket-contiguous.
 *
 * THIS IS THE WORK THAT MOVED OFF THE MAIN THREAD, and it is most of why a
 * sector can land without being felt. The main-thread packer used to do exactly
 * this with a `Map` keyed on a template string, and it measured 6.1 ms of the
 * 8.3 ms a prototype sector cost — for 13 800 grass, almost all of it string hashing
 * and typed-array shuffling that has nothing whatever to do with the main
 * thread. Doing it here means the main thread receives a buffer it can hand
 * straight to the GPU and a table of spheres it can frustum-test, and does no
 * per-instance work at all.
 *
 * The bucket lattice is GLOBAL — `floor(cx / bucketSize)` on world coordinates,
 * not sector-local — so two sectors can never produce buckets that overlap in
 * space, and a bucket is always the same box wherever it came from.
 *
 * @returns {{matrix: Float32Array, color: Float32Array|null, buckets: Float32Array}}
 *   `buckets` is six floats each: centre x, y, z, radius, start, count.
 */
export function bucketLayer(layer, bucketSize) {
  const n = layer.length;
  const cells = new Map();
  /**
   * A numeric key, biased so it stays non-negative, rather than a string.
   *
   * The obvious `${ix},${iz}` is what the main-thread packer used and it is
   * most of what made bucketing expensive — a fresh string and a string hash
   * per instance, twenty-five thousand times for one sector's grass. The bias
   * is what makes the arithmetic safe: `ix * K + iz` collides across the sign
   * boundary without it (1,-1 and 0,65535 land on the same key), which would
   * silently merge two buckets on opposite sides of the origin into one sphere
   * spanning them both. 8388608² is 7.0e13, comfortably inside the 2^53 where
   * integers are exact, and covers |x| out to 75 000 km at these bucket sizes.
   */
  const BIAS = 4194304;
  const STRIDE = 8388608;
  for (let i = 0; i < n; i++) {
    const key =
      (Math.floor(layer.cx[i] / bucketSize) + BIAS) * STRIDE +
      (Math.floor(layer.cz[i] / bucketSize) + BIAS);
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = []));
    cell.push(i);
  }

  const hasColor = layer.color.length > 0;
  const matrix = new Float32Array(n * 16);
  const color = hasColor ? new Float32Array(n * 3) : null;
  const buckets = new Float32Array(cells.size * 6);
  let offset = 0;
  let b = 0;
  for (const cell of cells.values()) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const i of cell) {
      cx += layer.cx[i];
      cy += layer.cy[i];
      cz += layer.cz[i];
    }
    cx /= cell.length;
    cy /= cell.length;
    cz /= cell.length;
    let radius = 0;
    for (const i of cell) {
      const d = Math.hypot(layer.cx[i] - cx, layer.cy[i] - cy, layer.cz[i] - cz) + layer.r[i];
      if (d > radius) radius = d;
    }
    const start = offset;
    for (const i of cell) {
      for (let k = 0; k < 16; k++) matrix[offset * 16 + k] = layer.matrix[i * 16 + k];
      if (color) for (let k = 0; k < 3; k++) color[offset * 3 + k] = layer.color[i * 3 + k];
      offset++;
    }
    buckets[b] = cx;
    buckets[b + 1] = cy;
    buckets[b + 2] = cz;
    buckets[b + 3] = radius;
    buckets[b + 4] = start;
    buckets[b + 5] = cell.length;
    b += 6;
  }
  return { matrix, color, buckets };
}
