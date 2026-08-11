import * as THREE from 'three';
import { clamp, clamp01, fbm2, hashString, lerp, makeRng, noise2, rngRange, smoothstep } from '../core/util.js';

/**
 * The ground.
 *
 * One analytic height function, sampled into a mesh and also queried directly by
 * the player controller. Everything in the world — trees, rocks, ferns, the
 * jukebox — is placed by asking this function, so nothing can float or sink and
 * there is no collision mesh to keep in sync with the visual one.
 *
 * The shape is deliberate rather than "some fbm":
 *
 *   A BOWL AT THE ORIGIN. You spawn in a clearing that is genuinely lower than
 *   its surroundings, so the first thing you see when you turn around is ground
 *   rising away from you in every direction. A flat spawn on an infinite plane
 *   reads as a demo; a hollow reads as a place.
 *
 *   A RIDGE. One large landmark that is visible from everywhere and that you can
 *   climb. Without a high point the forest has no navigation at all, because
 *   every direction looks the same by design.
 *
 *   A STREAM BED running through the low ground, carved by blending toward an
 *   explicit trench profile. Water is added separately as a flat plane at a
 *   fixed level, so the trench is what decides where the water appears — the
 *   geometry makes the river, not the other way around.
 *
 * All three of those used to be authored constants: the ridge lay along
 * z ≈ -96, the stream's centre line was a fixed function of x, and the clearing
 * was a dish of one fixed size. They are now functions of a world seed. See THE
 * WORLD SEED below for what moved, what deliberately did not, and why the
 * default seed still produces exactly the height field it always did.
 */

export const WORLD_RADIUS = 190;
/** Metres between vertices in the ground mesh. */
const CELL = 1.6;
/**
 * The water plane's height.
 *
 * Must sit BELOW the clearing floor. It did not, in the first build: the bowl
 * bottomed out at -4.2 and the water sat at -3.05, so the glade you spawn in
 * was a metre under a river that stretched to the horizon. Nothing looked
 * obviously wrong — the plane is only visible edge-on from inside it — but every
 * scatter rule that said "not underwater" quietly refused to plant anything in
 * the clearing, which is why the middle of the world was a bald patch.
 */
export const WATER_LEVEL = -3.4;

/* ========================================================================== *
 *  THE WORLD SEED                                                            *
 * ========================================================================== */
/**
 * "I want each world to be different. Nothing needs to be at the same place."
 *
 * Half the world already obeyed that. Every scatter — trees, grass, ferns,
 * rocks, logs, mushrooms, motes, light shafts, fauna — draws from
 * `makeRng(seed)`, so changing the seed moved all of it. The other half did not
 * move at all: `hash21` takes no seed, so the noise lattice was a global
 * constant, and the geography on top of it was three authored numbers — a
 * clearing at the origin, a ridge along z ≈ -96, a stream whose centre line was
 * a fixed function of x. Reseeding therefore rearranged the furniture and left
 * the building alone: same skyline, same river, same high ground, different
 * trees. That is not a different world, it is the same world redecorated.
 *
 *
 * WHY DOMAIN OFFSETS AND NOT A SEEDED HASH.
 *
 * The obvious move is to give `hash21` a third input. It is also the expensive
 * one: `heightAt` is ~100k calls at load and (seg+3)² per streamed chunk, and
 * it bottoms out in `hash21` — four calls per `noise2`, three or four octaves
 * per `fbm2`, ten noise terms per height. Anything added THERE is multiplied by
 * about forty.
 *
 * Every one of those terms already carries an additive constant to keep the
 * octaves off each other's lattice — `fbm2(x * 0.0046 + 13, z * 0.0046 - 7)`,
 * `noise2(x * 0.085 + 11, …)`, and so on. Those constants are decorrelation
 * offsets and nothing else, so making them per-world is very nearly free: the
 * arithmetic is the same add it always was, only against a module binding
 * instead of an immediate.
 *
 * WHAT IT ACTUALLY COST, measured properly — three variants built from this
 * same source by one substitution pass, imported into one process and run
 * interleaved, min of 30 rounds of 100 000 calls, because this machine has
 * other agents' dev servers on it and two runs ten minutes apart differed by
 * 3×:
 *
 *   authored literals throughout          0.461 µs   (matches the 0.47 µs on
 *                                                     record for this function)
 *   + seeded offsets and amplitudes       0.475 µs   +2.95%
 *   + seeded ridge and stream bearings    0.503 µs   +9.13%
 *
 * So two thirds of the price is the BEARINGS, not the noise, and it is not the
 * dozen flops the two rotations add — it is that a literal `-96` and a literal
 * `2*46*46` were folded into the machine code and a module binding has to be
 * loaded. It is worth paying anyway, and the reason is the one thing a
 * screenshot makes obvious: with a fixed bearing, every world in the game has
 * its mountains in the same compass direction and its river in the other, and
 * no amount of reseeding the noise hides that. In absolute terms it is 4 ms
 * added to the ~100k `heightAt` calls at load and 0.38 ms on a 5.24 ms chunk
 * build, which happens on a worker thread.
 *
 * `hash21`, `noise2` and `fbm2` themselves are untouched. Nothing was added to
 * the innermost loop, which is the part that is multiplied by forty.
 *
 * The offsets are also a BETTER field than a seeded hash would be. `fbm2`
 * multiplies the coordinate by 2.03 per octave, so one offset applied at the
 * call site lands on octave k at 1/2.03ᵏ of its world-space size: the octaves
 * of one world are not the octaves of another shifted together, they recombine.
 * Two worlds share a lattice and share nothing else.
 *
 *
 * THE GEOGRAPHY IS SEEDED, NOT DELETED, AND THAT IS A DELIBERATE REVERSAL OF
 * ONE PARAGRAPH AND AN ENDORSEMENT OF THE REST OF IT.
 *
 * `ground.js` used to say the ridge and the stream "are left exactly as they
 * were", because generalising them into a field — ridges and rivers appearing
 * everywhere out of noise — "would replace real geography with texture, and it
 * would cost the one landmark this world can be navigated by". That argument is
 * still right and nothing here does that. What changed is only that a world's
 * bearing, distance, crest height, meander and clearing are drawn from its seed
 * ONCE, at `setWorldSeed`, and are then constants for the rest of that world's
 * life. Every world is still an east–west valley with a mountain range along one
 * side and a river along another; "east–west" is simply no longer literally east
 * and west. There is still exactly one ridge and exactly one river, they still
 * run forever, and they are still the only things you can navigate by.
 *
 *
 * WHAT IS DELIBERATELY NOT SEEDED.
 *
 *   WATER_LEVEL, and the soft floor above it. The water is one flat plane at a
 *   fixed y built in `atmosphere.js`, and `softFloor(h, WATER_LEVEL + 1.9)` is
 *   what guarantees the stream is the only water in the world. Both halves of
 *   that have to agree, in every world, or a seed eventually spawns you in a
 *   lake. Seeding a constant whose only job is to be a constant buys variety
 *   nobody can see and risks the one failure that ruins a world outright.
 *
 *   The clearing's POSITION. It is the origin because the player spawns at the
 *   origin and because `forestDensity` in `scatter.js` carves the tree field's
 *   hole at a hardcoded radius around the origin. Its size and floor are seeded;
 *   moving its centre would need that file to learn about the seed, which is a
 *   change in a file this one does not own.
 *
 *   The region field's structure — REGION_INNER, REGION_OUTER, REGION_SCALE.
 *   Their tuning is a fog-distance argument (see below) and does not vary by
 *   world; the four fbms they drive are offset per world, so where the downland,
 *   the crag and the high ground fall is different every time.
 *
 *
 * THE SEED HAS TO REACH THE WORKERS, AND IT IS NOT AUTOMATIC.
 *
 * `terrain-worker.js` imports this file inside a Worker. That is a separate
 * module instance in a separate realm with its own copy of every binding below,
 * so a seed set on the main thread does NOT exist there and the worker would
 * happily build chunks of a different world. `ground.js` therefore stamps
 * `getWorldSeed()` into the per-chunk `postMessage` payload and the worker
 * applies it before building. Getting that wrong does not throw; it produces
 * ground that disagrees with `heightAt` and every tree in the chunk floats or
 * sinks. `endless-check.mjs` raycasts the mesh and compares against `heightAt`
 * for exactly this reason.
 *
 * `forest-worker.js` has the same problem and its fix lives in that file, not
 * this one.
 *
 *
 * THE DEFAULT SEED IS THE AUTHORED WORLD, BIT FOR BIT.
 *
 * `AUTHORED_SEED` — and 0, and null, and the empty string — normalise to seed 0,
 * which short-circuits every draw below and leaves all of it at the authored
 * value. That is not nostalgia. Roughly fifteen scripts in `scripts/` pixel-diff
 * or hash the terrain, `quality.js` already pins the Auto governor off under
 * `navigator.webdriver` so those scripts stay reproducible, and seed selection
 * pins the seed the same way. If the default seed moved the ground, every
 * terrain expectation in the repo would move on the same commit as the feature
 * and any regression here would be indistinguishable from the intended change.
 *
 * It is also the strongest available regression test, and it is arithmetic
 * rather than tolerance: 53 814 heights sampled from 2.5 m spacing at the origin
 * out to a 3 km disc, before and after, 0 differing values.
 */

/** The seed whose world is the one that shipped. Normalises to the identity. */
const AUTHORED_SEED = 'grove-01';

/** The current world, as a uint32. 0 is the authored world. */
let WORLD_SEED = 0;

/**
 * Noise domain offsets.
 *
 * Each is the authored decorrelation constant plus this world's draw. Named for
 * the term it belongs to rather than numbered, because the whole point is that
 * a reader can tell which lump of terrain each one moves.
 */
let kLandX = 13;
let kLandZ = -7;
let kHillX = 40;
let kHillZ = -17;
let kFineX = 11;
let kFineZ = 5;
let kCragX = -71;
let kCragZ = 29;
let kRegLandX = 311;
let kRegLandZ = -217;
let kRegHillX = -88;
let kRegHillZ = 55;
let kRegLiftX = 129;
let kRegLiftZ = -302;
let kRegCragX = -640;
let kRegCragZ = 410;
let kRidgeX = 0;
let kRidgeZ = 0;
let kDishX = 0;
let kDishZ = 0;
let kBedX = 0;
let kBedZ = 0;
/** Used by `heightGrid`'s colour blend, not by `heightAt`. */
let kBiomeX = 91;
let kBiomeZ = -33;
let kGrainX = 71;
let kGrainZ = -19;
let kGrain2X = -5;
let kGrain2Z = 41;

/**
 * The base terrain's amplitudes and frequencies.
 *
 * Seeded as well as offset, because offsets alone give every world the same
 * character — the same relief, the same size of hill — in a different
 * arrangement. A world that is smooth open downland and a world that is a
 * crumpled mess are different PLACES; two rearrangements of one amplitude are
 * the same place twice. The ranges are deliberately modest: `softFloor`
 * compresses everything under about +3 m onto the waterline, so a much larger
 * landform amplitude does not buy proportionally more relief (that argument is
 * spelled out at `lift` below) and a much smaller one flattens the valley the
 * whole world is set in.
 */
let landFreq = 0.0046;
let landAmp = 19;
let hillFreq = 0.017;
let hillAmp = 4.4;

/**
 * The ridge.
 *
 * `ridgeCos/ridgeSin` rotate world XZ into the ridge's own frame, so `ru` runs
 * ALONG the crest and `rv` across it; the authored world is the identity
 * rotation, where `ru` is x and `rv` is z and the arithmetic below is
 * character-for-character the formula it replaced. `ridgeDist` is signed: the
 * ridge is as likely to be on one side as the other, and the authored -96 is
 * "96 m to the north".
 */
let ridgeCos = 1;
let ridgeSin = 0;
let ridgeDist = -96;
let ridgeWaveK = 0.017;
let ridgeWaveA = 18;
/**
 * The meander's phase, and it exists because leaving it out was a bug.
 *
 * The first version drew a phase, handed it to the keep-out search, and never
 * used it in `heightAt` — so the search was measuring how close a DIFFERENT
 * crest line came to the origin, and the guarantee it produced was about a
 * ridge that did not exist. The two have to be the same line or the check is
 * theatre. Zero in the authored world, and `sin(a + 0)` is `sin(a)` exactly.
 */
let ridgeWaveP = 0;
let ridgeSigma = 46;
/**
 * 2σ², precomputed — and it is a DENOMINATOR rather than a reciprocal, which
 * is not a style choice.
 *
 * The first version hoisted `1 / (2σ²)` and multiplied, which is the obvious
 * micro-optimisation and cost the whole bit-identity guarantee: 1/4232 is not
 * exactly representable, so `a * (1/4232)` and `a / 4232` differ in the last
 * place. It moved 1252 of 53 814 sampled heights — 2.33% — by up to 7.1e-15 m.
 * Nothing in the world can see 7 femtometres, but "the default seed reproduces
 * the shipped terrain exactly" is either an arithmetic fact or it is a
 * tolerance somebody has to keep re-justifying, and one division per `heightAt`
 * against about forty `hash21` calls is not measurable.
 */
let ridgeDenom = 2 * 46 * 46;
let ridgeAmp = 30;
let ridgeRough = 11;

/** The stream. Same rotation trick as the ridge. */
let streamCos = 1;
let streamSin = 0;
let streamDist = 26;
let streamK1 = 0.022;
let streamA1 = 22;
let streamP1 = 0;
let streamK2 = 0.051;
let streamA2 = 7;
let streamP2 = 1.7;

/**
 * The spawn glade: a dish of radius `clearInner` with a `clearRamp` skirt,
 * whose floor is `clearFloor` and which overrides the terrain under it by
 * `CLEARING_MIX`.
 *
 * `clearFloor` must stay comfortably above WATER_LEVEL: it did not in the first
 * build, and the glade you spawn in was a metre under a river that stretched to
 * the horizon. Nothing looked obviously wrong — the plane is only visible
 * edge-on from inside it — but every scatter rule that said "not underwater"
 * quietly refused to plant anything in the clearing, which is why the middle of
 * the world was a bald patch. `guardClearing` below makes that a checked
 * property of every world rather than a property of these numbers.
 */
let clearInner = 10;
let clearRamp = 24;
let clearFloor = -0.6;
/**
 * How much of the clearing is dish and how much is whatever the terrain was
 * doing. Not seeded, and it is the reason a seeded ridge cannot ruin the spawn:
 * at 0.94 the glade keeps 6% of the underlying height, so even a 46 m crest
 * directly overhead arrives as 2.8 m of tilt across the dish.
 */
const CLEARING_MIX = 0.94;

/**
 * How close the stream and the ridge may come to the origin, and both numbers
 * are measurements rather than taste.
 *
 * 28.7 m is the authored stream's OWN closest approach to the origin, found by
 * minimising `hypot(u, streamCentre(u))` at 5 cm steps. It is the tightest the
 * signed-off world ever puts the channel to the spawn point, so it is the
 * tightest any world is allowed to. Below it the corridor — 18 m of half-width
 * — starts eating the dish, and `submerged()` starts rejecting scatter in the
 * clearing, which is the bald-patch failure again.
 *
 * The ridge's authored approach is 92.0 m at σ = 46, i.e. 2.0σ, where the crest
 * contributes exp(-2.0²/2) = 13.5% of its height at the origin. 1.9σ (16.4%) is
 * the same statement for a world whose ridge is wider or narrower, and the 74 m
 * floor stops a very narrow ridge from being allowed to sit on top of the glade
 * just because it is thin.
 *
 * Both are enforced by pushing the feature outward until it complies, not by
 * rejecting and redrawing: rejection sampling here would silently bias every
 * other parameter it is correlated with, and pushing is monotone and always
 * terminates.
 */
const STREAM_KEEP = 28.7;
const RIDGE_KEEP = 74;

/**
 * Distance from the origin to a meandering centre line, minimised.
 *
 * Only |u| ≤ keep can possibly beat `keep`, so the scan is bounded by the answer
 * it is testing against. 0.5 m steps over at most ±120 m is ~480 evaluations of
 * two sines, once per world.
 */
function nearestApproach(dist, a1, k1, p1, a2, k2, p2, keep) {
  let best = Infinity;
  for (let u = -keep; u <= keep; u += 0.5) {
    const c = dist + Math.sin(u * k1 + p1) * a1 + Math.sin(u * k2 + p2) * a2;
    const d2 = u * u + c * c;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/**
 * Push a centre line away from the origin until it clears `keep`.
 *
 * Moving `dist` by δ moves the whole line by δ, so one pass is usually enough;
 * it is a loop because the nearest point can slide along the meander as the line
 * moves, and eight iterations is far more than the fixed point has ever needed.
 */
function pushClear(dist, a1, k1, p1, a2, k2, p2, keep) {
  for (let i = 0; i < 8; i++) {
    const near = nearestApproach(dist, a1, k1, p1, a2, k2, p2, keep);
    if (near >= keep) break;
    dist += Math.sign(dist) * (keep - near + 0.25);
  }
  return dist;
}

/**
 * Make the glade habitable, by measuring it rather than by arguing about it.
 *
 * The player spawns at the origin and falls onto `groundUnder(0, 0)`, so a world
 * whose glade floor came out under the water plane would drop them into a river
 * on frame one. Everything above is chosen so that cannot happen — `clearFloor`
 * is drawn well above WATER_LEVEL and the stream is pushed off the glade — but
 * "cannot happen" is exactly the claim that is worth costing 45 `heightAt` calls
 * (about 25 µs, once per world) to check instead of assert.
 *
 * Raising the floor by δ raises the sampled height by CLEARING_MIX·δ, hence the
 * division; the loop is there because the 6% of terrain the dish lets through is
 * not linear in the floor.
 */
function guardClearing() {
  for (let pass = 0; pass < 4; pass++) {
    let low = heightAt(0, 0);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      for (const r of [4, 9]) low = Math.min(low, heightAt(Math.cos(a) * r, Math.sin(a) * r));
    }
    const want = WATER_LEVEL + 1.2;
    if (low >= want) return;
    clearFloor += (want - low) / CLEARING_MIX;
  }
}

/**
 * Normalise anything into the uint32 the field is actually built from.
 *
 * A string goes through FNV-1a, which is deterministic across machines — it has
 * to be, because a multiplayer room derives its seed from the room id and two
 * peers who disagree about the ground are two peers standing in different
 * worlds. The authored seed and every empty-ish value map to 0.
 */
export function normalizeSeed(seed) {
  if (seed === undefined || seed === null || seed === '' || seed === AUTHORED_SEED) return 0;
  if (typeof seed === 'number') return Number.isFinite(seed) ? seed >>> 0 : 0;
  return hashString(String(seed));
}

/**
 * Choose a world.
 *
 * Call ONCE, before anything samples the height field — before `buildForest`,
 * before `buildAtmosphere`, before the controller exists. Calling it later is
 * not an error but is close to useless: everything already placed keeps the
 * heights it was placed at, and the ground under it moves.
 *
 * Returns the normalised uint32 so the caller can hand the same value to a
 * worker without having to know how a string becomes a world.
 */
export function setWorldSeed(seed) {
  const s = normalizeSeed(seed);
  WORLD_SEED = s;
  /**
   * PUBLISHED ON THE REALM, NOT JUST HELD IN THIS MODULE, AND THAT IS LOAD
   * BEARING.
   *
   * A page can end up with more than one instance of this module. Vite serves
   * an HMR-versioned URL to a late `import()`, so a test script that does
   * `import('/src/world/terrain.js')` from the console gets a SECOND, pristine
   * copy — `endless-check.mjs` does exactly this, on the stated grounds that
   * "heightAt is pure, so a second module copy is harmless". That was true
   * until this file had a seed in it, and would otherwise now be a script that
   * compares the streamed mesh of one world against the height function of
   * another and reports a metre of error as a streaming bug.
   *
   * Writing the seed where the module initialiser can find it makes every copy
   * in the realm agree, which is the invariant that comment was relying on. In
   * a worker `globalThis` is the worker's own, so this is per-realm rather than
   * global, which is exactly the right scope: each realm is told its seed once
   * and every copy inside it follows.
   */
  if (typeof globalThis !== 'undefined') globalThis.RR_WORLD_SEED = s;

  /**
   * Forget every cave slot.
   *
   * Each entry also carries the seed it was built for and `caveAt` compares it,
   * so this is redundant — and it is here anyway because the two are guarding
   * different things. The compare protects a realm that re-seeds while it is
   * running, which is what the terrain worker does on its first message of a
   * session; this releases the objects, which matters because `_caveSlots` is
   * the only structure in this file that holds anything.
   *
   * Safe despite being above the declaration: `setWorldSeed` is only ever
   * CALLED after the module has finished evaluating — see the note at the
   * bottom of the file, which is the same temporal-dead-zone trap that already
   * cost a ReferenceError once.
   */
  _caveSlots.fill(null);

  // The authored world. Every binding above is already at its authored value on
  // first load, so this is a restore rather than a special case, and calling
  // `setWorldSeed('grove-01')` after some other seed puts it all back.
  kLandX = 13;
  kLandZ = -7;
  kHillX = 40;
  kHillZ = -17;
  kFineX = 11;
  kFineZ = 5;
  kCragX = -71;
  kCragZ = 29;
  kRegLandX = 311;
  kRegLandZ = -217;
  kRegHillX = -88;
  kRegHillZ = 55;
  kRegLiftX = 129;
  kRegLiftZ = -302;
  kRegCragX = -640;
  kRegCragZ = 410;
  kRidgeX = 0;
  kRidgeZ = 0;
  kDishX = 0;
  kDishZ = 0;
  kBedX = 0;
  kBedZ = 0;
  kBiomeX = 91;
  kBiomeZ = -33;
  kGrainX = 71;
  kGrainZ = -19;
  kGrain2X = -5;
  kGrain2Z = 41;
  landFreq = 0.0046;
  landAmp = 19;
  hillFreq = 0.017;
  hillAmp = 4.4;
  ridgeCos = 1;
  ridgeSin = 0;
  ridgeDist = -96;
  ridgeWaveK = 0.017;
  ridgeWaveA = 18;
  ridgeWaveP = 0;
  ridgeSigma = 46;
  ridgeDenom = 2 * 46 * 46;
  ridgeAmp = 30;
  ridgeRough = 11;
  streamCos = 1;
  streamSin = 0;
  streamDist = 26;
  streamK1 = 0.022;
  streamA1 = 22;
  streamP1 = 0;
  streamK2 = 0.051;
  streamA2 = 7;
  streamP2 = 1.7;
  clearInner = 10;
  clearRamp = 24;
  clearFloor = -0.6;
  if (s === 0) return 0;

  const rng = makeRng(s);
  /**
   * ±480 lattice units.
   *
   * Big enough that no two worlds are looking at overlapping neighbourhoods of
   * the noise, small enough to cost nothing: `hash21` does `fract(x * 123.34)`,
   * and the high-frequency terms already reach x·1.7 ≈ 17 000 at 10 km out, so
   * another 480 does not move the precision picture at all.
   */
  const off = () => rngRange(rng, -480, 480);
  kLandX += off();
  kLandZ += off();
  kHillX += off();
  kHillZ += off();
  kFineX += off();
  kFineZ += off();
  kCragX += off();
  kCragZ += off();
  kRegLandX += off();
  kRegLandZ += off();
  kRegHillX += off();
  kRegHillZ += off();
  kRegLiftX += off();
  kRegLiftZ += off();
  kRegCragX += off();
  kRegCragZ += off();
  kRidgeX += off();
  kRidgeZ += off();
  kDishX += off();
  kDishZ += off();
  kBedX += off();
  kBedZ += off();
  kBiomeX += off();
  kBiomeZ += off();
  kGrainX += off();
  kGrainZ += off();
  kGrain2X += off();
  kGrain2Z += off();

  landFreq *= rngRange(rng, 0.8, 1.28);
  landAmp = rngRange(rng, 15, 24.5);
  hillFreq *= rngRange(rng, 0.78, 1.32);
  hillAmp = rngRange(rng, 3.3, 6.2);

  const ridgeBearing = rngRange(rng, 0, Math.PI * 2);
  ridgeCos = Math.cos(ridgeBearing);
  ridgeSin = Math.sin(ridgeBearing);
  ridgeWaveK = rngRange(rng, 0.01, 0.026);
  ridgeWaveA = rngRange(rng, 9, 30);
  ridgeSigma = rngRange(rng, 33, 62);
  ridgeDenom = 2 * ridgeSigma * ridgeSigma;
  ridgeAmp = rngRange(rng, 21, 46);
  ridgeRough = rngRange(rng, 6, 17);
  /**
   * The bearing already covers both sides, so the distance is drawn positive
   * and the rotation decides which way "across" points. Drawing a sign as well
   * would just be a second, redundant coin.
   */
  ridgeWaveP = rngRange(rng, 0, Math.PI * 2);
  ridgeDist = pushClear(
    rngRange(rng, 84, 172),
    ridgeWaveA,
    ridgeWaveK,
    ridgeWaveP,
    0,
    0,
    0,
    Math.max(RIDGE_KEEP, ridgeSigma * 1.9)
  );

  const streamBearing = rngRange(rng, 0, Math.PI * 2);
  streamCos = Math.cos(streamBearing);
  streamSin = Math.sin(streamBearing);
  streamK1 = rngRange(rng, 0.013, 0.032);
  streamA1 = rngRange(rng, 12, 30);
  streamP1 = rngRange(rng, 0, Math.PI * 2);
  streamK2 = rngRange(rng, 0.034, 0.072);
  streamA2 = rngRange(rng, 4, 11);
  streamP2 = rngRange(rng, 0, Math.PI * 2);
  streamDist = pushClear(
    rngRange(rng, 24, 62),
    streamA1,
    streamK1,
    streamP1,
    streamA2,
    streamK2,
    streamP2,
    STREAM_KEEP
  );

  clearInner = rngRange(rng, 8, 14);
  clearRamp = rngRange(rng, 19, 30);
  clearFloor = rngRange(rng, -1.3, 0.5);
  guardClearing();
  return s;
}

/**
 * The current world as a uint32, for stamping into a worker payload.
 *
 * `ground.js` uses this and nothing else should need it. It is the normalised
 * number rather than whatever string the caller passed, so the worker cannot
 * disagree with the main thread about how a string becomes a world.
 */
export function getWorldSeed() {
  return WORLD_SEED;
}

/* ========================================================================== */

/**
 * Distance from a point to the stream's centre line, across the channel.
 *
 * Rotates into the stream's frame first: `u` runs along the river and `v`
 * across it. In the authored world the rotation is the identity, `u` is x and
 * `v` is z, and this is the `Math.abs(z - streamCentre(x))` it replaced —
 * exactly, not nearly, because `x * 1 + z * 0` is `x` in IEEE754.
 *
 * One function rather than a centre line plus two call sites: `heightAt` carves
 * the trench and `wetness` reports how wet a point is, and if those two ever
 * disagreed about where the river was, the world would grow plants in the water
 * and refuse to grow them on the bank.
 */
function streamBank(x, z) {
  const u = x * streamCos + z * streamSin;
  const v = z * streamCos - x * streamSin;
  const centre =
    streamDist + Math.sin(u * streamK1 + streamP1) * streamA1 + Math.sin(u * streamK2 + streamP2) * streamA2;
  return Math.abs(v - centre);
}

/**
 * Where the river is, for the things that have to stand on it.
 *
 * `streamBank` answers "how far am I from the water", which is what carving and
 * wetness need. Two consumers need the other question — "where IS the water
 * from here" — and until every world had its own river they answered it with a
 * literal: `atmosphere.js` pinned its mist planes to `(0, …, 30)` and
 * `main.js` followed the stream with `26 + sin(x * 0.022) * 22`, both of which
 * are transcriptions of the AUTHORED channel. In a seeded world those put the
 * mist and the sound of running water over dry ground, several hundred metres
 * from the river, and nothing errors.
 *
 * Returns the nearest point on the centre line to (x, z) and the channel's
 * local bearing there, because the mist planes are oriented and a fog bank lying
 * across the river rather than along it is worse than no fog bank.
 *
 * "Nearest" is approximate and deliberately so: the true nearest point on a
 * meandering curve needs an iterative solve, while dropping a perpendicular in
 * the stream's own frame is one rotation and two sines. The two differ by at
 * most the meander's own gradient — under 2 m at the amplitudes this world
 * uses — which is far inside the 18 m half-width of the channel it is locating.
 * Nobody can see two metres of error in the position of a fog bank; everybody
 * can see three hundred.
 *
 * @param {number} x
 * @param {number} z
 * @param {{x: number, y: number, z: number, angle: number}} [out] reused, because
 *   this is called once a frame and its result is dead before the next one
 */
/**
 * The river's NOMINAL bearing — the straight line it meanders about, not the
 * direction the water happens to be running at some particular bend.
 *
 * Anything long and rigid that has to lie along the channel wants this one
 * rather than `streamPointNear().angle`: the ground-mist bands are 210 m planes,
 * and orienting a 210 m plane to a local tangent that swings ±20° on a bend
 * would walk its far end straight out of the valley.
 */
export function streamBearing() {
  return Math.atan2(streamSin, streamCos);
}

export function streamPointNear(x, z, out = { x: 0, y: 0, z: 0, angle: 0 }) {
  const u = x * streamCos + z * streamSin;
  const centre =
    streamDist + Math.sin(u * streamK1 + streamP1) * streamA1 + Math.sin(u * streamK2 + streamP2) * streamA2;
  // Back out of the stream's frame: (u, centre) is on the centre line by
  // construction, so this is a point in the channel whatever the bearing is.
  out.x = u * streamCos - centre * streamSin;
  out.z = u * streamSin + centre * streamCos;
  out.y = WATER_LEVEL;
  /**
   * The bearing includes the meander, not just the world's stream bearing.
   * dv/du is the slope of the centre line in the stream's frame; adding
   * `atan2` of it to the world bearing gives the direction the water is
   * actually running at this point, which on a tight bend differs from the
   * nominal bearing by a good 20°.
   */
  const slope =
    Math.cos(u * streamK1 + streamP1) * streamA1 * streamK1 +
    Math.cos(u * streamK2 + streamP2) * streamA2 * streamK2;
  out.angle = Math.atan2(streamSin, streamCos) + Math.atan(slope);
  return out;
}

/**
 * REGION CHARACTER — why the far world needed a second field.
 *
 * Making the ground endless made a measurable problem visible. A 640 m block
 * away from the ridge had 11–15 m of relief and a worst step of 0.45 m between
 * adjacent 1.6 m cells; the block at the origin has 43 m and 3.19 m. So the
 * whole world outside the valley was eight times flatter than the one place
 * anybody had ever looked at, and — worse — every far block was flat in the
 * SAME way, because a single fbm with fixed amplitudes is stationary by
 * construction. Walking two kilometres got you two kilometres of the same
 * gentle swell. That is the definition of wallpaper.
 *
 * The fix is a field on the AMPLITUDES rather than more octaves on the height.
 * More octaves make everywhere rougher, which is still stationary — it just
 * moves the sameness up a frequency. Varying the amplitudes over a ~1300 m
 * scale means the character of the ground is itself a thing you travel through:
 * open downland here, broken crag there, and a long enough wavelength that you
 * cross a region rather than notice a pattern.
 *
 * THREE THINGS THIS MUST NOT DO.
 *
 * It must not move a single height inside the authored radius. `regionMask` is
 * `smoothstep(clamp01(...))`, which is exactly 0 — not nearly 0 — for d ≤
 * REGION_INNER, and `amp * (1 + 0)` is exactly `amp` in IEEE754. So the bowl,
 * the clearing, the jukebox's ground and the near mushroom patches are
 * untouched as a matter of arithmetic rather than of tuning.
 * `scripts/terrain-survey.mjs` hashes 210 022 sampled heights inside 181 m
 * against a reference captured before this existed, because "it should be
 * identical" and "it is identical" are different claims.
 *
 * It must not put water on a hilltop or drown the world. Everything here lands
 * BEFORE `softFloor` and before the stream is carved, so the guarantee that the
 * only water is the stream survives whatever amplitude a region asks for.
 *
 * It must not cost anything where it does nothing. The whole block is skipped
 * when the mask is zero, and the ridged term — the expensive one — is skipped
 * wherever its own amplitude is negligible, which is most of the map.
 */
/**
 * 182, and the two extra metres are the whole authored forest.
 *
 * The obvious number is 180.5 — `WORLD_RADIUS * 0.95`, where the authored tree
 * scatter stops — and it would have been quietly wrong. `forestDensity` calls
 * `slopeAt`, which is a central difference with a 0.7 m epsilon, so a candidate
 * ON the scatter's own boundary samples the height field at 181.2 m. A region
 * field that began at 180.5 would therefore perturb the slope at the outermost
 * trees by a few parts in 10⁹, which is enough to flip an accept/reject once in
 * a great many candidates and would have made "the authored forest is
 * unchanged" a statistical claim rather than an arithmetic one.
 *
 * At 182 every input the authored scatter can possibly read is inside the
 * region where this field is exactly the identity, so the authored world is
 * bit-identical by construction rather than by measurement — and the
 * measurement (`scripts/terrain-survey.mjs`, 210 022 hashed heights) is then a
 * check on the reasoning instead of the reasoning itself.
 */
const REGION_INNER = 182;
/**
 * Where the region field is at full strength.
 *
 * 900 m rather than something tighter because the transition must be longer
 * than the fog can see, or the boundary reads as a bowl the world sits in. At
 * the ego-death fog's 402 m reach, a player standing at the inner radius sees
 * the ramp reach only 31% of its strength at the limit of visibility, which is
 * a gradient no eye picks out of noise.
 */
const REGION_OUTER = 900;
/** ~1330 m per feature: several minutes of walking across one region. */
const REGION_SCALE = 0.00075;

/**
 * Ridged multifractal, for the crag regions.
 *
 * `1 - |noise|` folds the field at zero, so what were smooth minima become
 * sharp maxima — the crests of a mountain range rather than the tops of dunes.
 * Squaring sharpens them further and, usefully, keeps the result positive so it
 * only ever adds. Value noise's folds are less crisp than gradient noise's
 * would be, which here is a feature: the world's whole visual language is
 * `noise2`, and a second noise basis in the far field would read as a different
 * artist.
 */
function ridged2(x, y, octaves) {
  let sum = 0;
  let amp = 0.5;
  let px = x;
  let py = y;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise2(px, py));
    sum += n * n * amp;
    px *= 2.03;
    py *= 2.03;
    amp *= 0.5;
  }
  // Mean-centred, so a region with no crag in it is not silently lifted.
  return sum - 0.55;
}

/* ========================================================================== *
 *  CAVES — THE HALF OF THEM THAT IS TERRAIN                                  *
 * ========================================================================== */
/**
 * A height field cannot have a roof. It can have a hole in the ground, and that
 * is exactly the half of a cave that belongs here.
 *
 * The split is: this file carves the NOTCH — a gully cut into the ridge's flank
 * that runs uphill and deepens until the hillside stands ten to twenty metres
 * over your head — and `caves.js` builds the TUBE that carries on from the head
 * of that gully into the dark. Nothing about the tube is known here and nothing
 * about the notch is duplicated there; `caves.js` finds the floor of the gully
 * by asking `heightAt`, the same way every tree in the world finds the ground.
 *
 * That division is what makes the mouth work. The alternative — a hole punched
 * in the hillside by the cave mesh, with the terrain left flat behind it — is a
 * decal, and it reads as one from the first step: the ground runs level up to a
 * black rectangle and stops. Here the ground itself funnels you in. Every tree,
 * fern, rock and mushroom in the world is scattered by asking `heightAt` and
 * rejecting steep ground, so the gully clears itself of undergrowth and grows
 * a bank of plants along each lip without a single line of code in scatter.js
 * knowing that caves exist.
 *
 *
 * WHY THE RIDGE, AND ONLY THE RIDGE.
 *
 * This world has exactly one landmark. `ground.js` argues at length that
 * generalising the ridge and the stream into fields "would replace real
 * geography with texture", and a cave scattered wherever a noise field happened
 * to go over a threshold is precisely that: you would find them by accident and
 * never be able to say where one was. Hanging them off the ridge instead makes
 * them findable — the mountain is visible from everywhere by design, so "the
 * caves are in the mountain" is a rule a player can learn in one sighting and
 * use forever.
 *
 * It is also the only place in the world guaranteed to be steep. A cave mouth
 * needs a hillside; the gaussian flank at 1.3-1.6 sigma is the steepest ground
 * this world reliably has, it is analytic, and — the part that matters for the
 * cost below — its gradient can be differentiated in closed form instead of
 * measured with four more `heightAt` calls.
 *
 *
 * WHAT THIS COSTS `heightAt`, WHICH IS THE ONLY REAL CONSTRAINT.
 *
 * The header of this file spends four paragraphs on the fact that anything
 * added to this function is multiplied by about forty, and that the seeded
 * bearings cost 9.13% and were only just worth it. So the fast path here is
 * four operations:
 *
 *   const k = Math.round(ru * CAVE_INV_SPACING);   multiply, round
 *   const c = caveAt(k);                            array index, two compares
 *   if (c.live) { ... }                             one compare
 *
 * and it now runs at every sample, everywhere. `ru` is not computed for this —
 * it is the ridge's own along-crest coordinate, which the line above already
 * needed — so what was added by dropping the spawn-disc guard is one round, one
 * masked array read and two integer compares on the samples inside 182 m, which
 * is the clearing and nothing else.
 *
 * ONE k IS EXACTLY RIGHT, NOT AN APPROXIMATION. The boundary between slot k and
 * slot k+1 is at 105 m, and everything a cave touches lies inside that:
 *
 *   48 m   the jitter on `u0`
 *   16 m   the mouth's own offset along the crest — the gully runs ACROSS the
 *          ridge, so its 33 m reach down the flank only projects onto the crest
 *          through the shear, which is at most 0.42 rad
 *   25 m   the tor, whose ellipse is 32 x 24 m in the same frame and therefore
 *          reaches sqrt((32 sin 0.42)^2 + 24^2) along the crest
 *
 * which is 89 m against a budget of 105. The notch itself is smaller than the
 * tor in every direction and cannot be the binding term. Checking the three
 * neighbouring slots — the obvious defensive thing — would triple the cost of
 * the fast path to buy a guarantee the arithmetic already gives, and
 * `scripts/cave-check.mjs` walks the ground between adjacent mouths on forty
 * seeds rather than trusting this paragraph.
 *
 *
 * THERE IS NO KEEP-OUT ROUND THE SPAWN, AND SO THERE IS NO CUTOFF EITHER.
 *
 * This used to refuse any mouth within 250 m of the origin, and to skip the
 * notch entirely for d <= 182 m so that the authored disc could be hashed and
 * held bit-identical. Caves near the spawn are wanted now, so both are gone —
 * and they had to go TOGETHER, because either one on its own is broken:
 *
 *   The radial cutoff was only ever safe because the keep-out meant it never
 *   fired. It is a hard `if` on `d`, so a notch that straddled 182 m would be
 *   carved outside the line and not inside it, and the seam between them is a
 *   vertical wall the depth of the gully, following a circle round the spawn.
 *   Keeping the cutoff and dropping the keep-out is the one combination that
 *   puts a cliff in the world.
 *
 *   Ramping the cutoff instead would not fix it either. A smoothstep over the
 *   boundary trades the wall for a ramp, but the gully still shallows out for
 *   no reason a player can see, and it does it exactly where they are standing
 *   when they walk out of the mouth.
 *
 * The price is that `scripts/terrain-survey.mjs` no longer describes an
 * untouched authored world: its reference hash was recaptured with the notches
 * in it, and a seed whose k=0 slot lands near the origin now has a gully in
 * sight of the clearing. That is the feature, not a regression — but it does
 * mean the hash has stopped being evidence that "nothing near spawn moved", and
 * `scripts/cave-check.mjs` carries the replacement: it walks a line straight
 * out through every near notch and asserts the ground has no step in it.
 */

/**
 * Metres along the crest between cave slots.
 *
 * 210 with +/-48 m of jitter, so along a ridge you meet one every three and a
 * half minutes of walking and never at a regular interval. Tighter than this
 * and the ridge is a colander; wider and a player who finds one cave has no
 * reason to believe there is another.
 *
 * The jitter was +/-62 and was cut to make room for the knoll. The two are in
 * direct competition: everything a cave touches has to stay within 105 m of its
 * slot centre along the crest (the ONE k block above), and that budget is spent
 * on the jitter, on how far down the flank the mouth sits, and on the tor's own
 * half-width. 48 + 16 + 24 leaves 17 m of margin; 62 would leave three, and a
 * cave that overran it would not look like a big cave, it would look like a hill
 * sliced off with a knife.
 */
const CAVE_SPACING = 210;
const CAVE_INV_SPACING = 1 / CAVE_SPACING;
/**
 * How close a mouth may be to the stream's centre line.
 *
 * The channel's half-width is 18 m and a notch is up to 11 m across, so 34 m is
 * the channel plus the notch plus a bank. Under it the gully cuts into the
 * riverbed, the notch digs below WATER_LEVEL, and the 768 m water plane —
 * which is everywhere, and is only invisible because `softFloor` holds the
 * ground above it — surfaces inside the cave mouth. A flooded entrance is not
 * the worst thing that could happen, but it is not the thing that was built.
 */
const CAVE_DRY = 34;

/* -------------------------------------------------------------------------- *
 *  THE KNOLL — WHY A CAVE IS A LUMP IN THE GROUND AND NOT ONLY A HOLE IN IT
 * -------------------------------------------------------------------------- *
 *
 * Everything above builds a cave you find by walking into it: a notch in a
 * flank, invisible from anywhere but inside its own gully, with the passage's
 * rock buried so completely that from the hillside above there is nothing there
 * at all. Standing sixty metres downhill in this wood you cannot tell a cave
 * from any other patch of trees, because at sixty metres in a forest you cannot
 * see the ground.
 *
 * Making the mouth's own rock stand proud (see HOOD_PROUD in caves.js) fixes the
 * doorway and does not fix that, for two reasons that are both about scale: the
 * shell is a few metres of rock in a wood whose trees are twenty-five, and it
 * does not exist at all until you are within BUILD_RANGE of it. Whatever is
 * meant to be visible from far away has to be TERRAIN — it streams with the
 * ground at any distance, it is lit by the scene's own sun, it collides, and the
 * scatter reads it, so trees decline to grow on it without being told.
 *
 * So the flank gets a knoll: a broken dome of hill, ten to sixteen metres of it,
 * centred just inside the mouth. Three things then happen for free, all of them
 * from machinery that already existed:
 *
 *   THE GULLY CUTS THROUGH IT. The notch is applied AFTER the lift and takes the
 *   knoll back out again in proportion to its own profile, so the floor you walk
 *   in on is exactly where it was and the knoll stands as the two walls beside
 *   it. A slot cut through a rock dome is what a cave mouth looks like from the
 *   front, and neither half of that shape was authored — it is the notch and the
 *   dome disagreeing.
 *
 *   IT CLEARS ITSELF. `forestDensity` scales by `1 - slope * 2.4` and stops
 *   entirely at 0.417; a 13 m dome over 18 m of flank is a gradient of 0.7, so
 *   the knoll comes out bare in a wood that is otherwise closed. The one
 *   landmark-shaped thing in the near world is also the one bald patch in it.
 *
 *   AND THE PASSAGE ADAPTS. `buildNodes` finds its burial point by walking the
 *   real height field, so a mouth with a dome over it needs less built hood and
 *   gets it, without a line of code in caves.js knowing this exists.
 *
 * WHAT IT COSTS IS ONE `ridged2` AND ONLY WHERE A CAVE IS. The dome is an
 * ellipse test that rejects in three operations everywhere it does not apply,
 * which — the point the whole CAVES block above turns on — is everywhere except
 * a few hundred square metres per 210 m of ridge.
 */

/**
 * Half-length of the knoll along the gully's axis, and across it, in metres.
 *
 * SIZED AGAINST THE TREES, NOT AGAINST THE MOUTH. The first pass made a dome
 * 26 x 18 m and 10-16 m tall, which is a large rock and completely invisible:
 * photographed from sixty metres down its own gully it was six hundred trunks
 * and no cave. In a wood whose canopy is twenty-five metres, anything meant to
 * be seen from outside the clearing it stands in has to reach the canopy — so
 * this is a tor rather than a hillock, and it is wide in proportion or it reads
 * as a boulder somebody dropped.
 *
 * The width is also bounded from above, and tightly: see the ONE k block in the
 * CAVES header. A cave may only influence samples whose nearest slot is its own,
 * which puts every part of its footprint within 105 m of the slot centre along
 * the crest. `scripts/cave-check.mjs` walks the ground between adjacent mouths
 * and fails on the wall that appears if this is ever set past that.
 */
const KNOLL_LONG = 32;
const KNOLL_WIDE = 24;
/**
 * How far past the mouth its centre sits.
 *
 * Inside, so the doorway is in the dome's FACE rather than at its foot. At zero
 * the gully cuts the dome exactly in half and the mouth ends up in a saddle
 * between two hillocks, which reads as two rocks rather than as one with a hole
 * in it.
 */
const KNOLL_IN = 6;

/**
 * The lowest a notch may cut, and it is a WATER constraint rather than a taste
 * one, for the reason spelled out at CAVE_DRY.
 */
const CAVE_BED = WATER_LEVEL + 0.8;

/**
 * The slot cache.
 *
 * A power-of-two ring indexed by `k & 63` rather than a Map, because this is
 * read on the fast path of the hottest function in the project and a Map lookup
 * is an order of magnitude more than the whole rest of that path. Collisions
 * would thrash, and cannot: one chunk build sweeps at most 181 m of `ru`, which
 * at a 210 m spacing touches two adjacent k, whose low six bits differ.
 *
 * The seed is stored per entry and compared rather than the cache being cleared
 * on `setWorldSeed`. Both are done — `setWorldSeed` clears it too — but the
 * compare is the one that is actually safe: a worker re-seeds mid-session, and
 * a stale descriptor is a cave whose gully is carved into the wrong world's
 * hillside, which does not throw and looks like a terrain bug.
 */
const CAVE_SLOTS = 64;
const _caveSlots = new Array(CAVE_SLOTS).fill(null);

/** An empty slot, so `live` is a field on every descriptor and never undefined. */
function deadCave(k) {
  return {
    k,
    seed: WORLD_SEED,
    live: false,
    u0: 0,
    v0: 0,
    inSign: 1,
    ca: 1,
    sa: 0,
    depth: 0,
    aOpen: 0,
    aFull: 0,
    aHold: 0,
    aFade: 0,
    flat: 0,
    wide: 0,
    knoll: 0,
    x: 0,
    z: 0,
    grade: 0,
    reach: 0,
  };
}

/**
 * Everything the height field and the tube builder both need to agree about.
 *
 * All the geometry is in the NOTCH'S OWN FRAME, which is the ridge frame rotated
 * by a small per-cave shear and flipped so that `a` always runs INTO the hill:
 *
 *   a   metres from the flank toward the crest. Negative is out on the open
 *       hillside below the mouth, `aFull` is where the gully is at full depth,
 *       `aHold` is the mouth, `aFade` is where the hillside has closed over.
 *   b   metres across the gully, 0 on its centre line.
 *
 * `inSign` is what makes `a` mean the same thing on both flanks. Get it wrong
 * and half the caves in a world are gullies running down the mountain into thin
 * air, which is a bug that only shows up on the seeds where the coin came down
 * the other way.
 */
function buildCave(k) {
  const c = deadCave(k);
  const rng = makeRng(`${WORLD_SEED}:cave:${k}`);

  c.u0 = k * CAVE_SPACING + rngRange(rng, -48, 48);
  const crest = ridgeDist + Math.sin(c.u0 * ridgeWaveK + ridgeWaveP) * ridgeWaveA;
  /**
   * Which flank, biased toward the one that faces the spawn valley.
   *
   * A cave on the far side of the mountain is a cave nobody finds. `ridgeDist`
   * is signed and the origin is at rv = 0, so the valley is always on the side
   * of the crest whose sign is opposite the ridge's own distance. Two in seven
   * still open the other way, because a world where every cave faces the same
   * compass direction is a world with a rule in it you can feel.
   */
  const valley = ridgeDist < 0 ? 1 : -1;
  const flankSign = rng() < 0.72 ? valley : -valley;
  /**
   * 1.28-1.62 sigma down the flank.
   *
   * The gaussian's steepest point is exactly at 1 sigma and the temptation is to
   * put the mouth there. It is the wrong place twice: the crest is 61% of full
   * height at 1 sigma, so the mouth would sit most of the way up a mountain
   * where nobody walks, and the ground ABOVE it — the rock the tube has to hide
   * under — flattens off toward the summit instead of rising. Further out the
   * hill is a little gentler but there is far more of it overhead, which is what
   * the tube actually needs.
   */
  const flank = ridgeSigma * rngRange(rng, 1.28, 1.62);
  c.v0 = crest + flankSign * flank;
  c.inSign = -flankSign;

  /**
   * A small shear on the gully's axis.
   *
   * Without it every notch in a world runs dead across the ridge and the whole
   * mountainside is combed. +/-0.42 rad is up to 24 degrees, which is enough
   * that two caves a few hundred metres apart clearly do not belong to the same
   * ruler, and little enough that the gully still climbs the flank rather than
   * traversing it.
   */
  const shear = rngRange(rng, -0.42, 0.42);
  c.ca = Math.cos(shear);
  c.sa = Math.sin(shear);

  c.aOpen = -rngRange(rng, 5, 11);
  c.aFull = rngRange(rng, 7, 12);
  c.aHold = c.aFull + rngRange(rng, 12, 21);
  c.aFade = c.aHold + rngRange(rng, 6, 11);
  /**
   * The gully's flat floor is WIDER THAN THE TUNNEL, and it has to be.
   *
   * The first version drew 2.2-3.4 m and the tube is 4.6 m across the bottom, so
   * the notch's V-profile started climbing inside the tunnel's own footprint and
   * the terrain surface pushed up through the floor in the last three metres of
   * the approach — two rocks occupying the same place, with a shading seam
   * between them, exactly where the player is looking hardest. The floor of the
   * gully has to be at least as wide as the doorway at the end of it.
   */
  c.flat = rngRange(rng, 4.6, 5.8);
  c.wide = c.flat + rngRange(rng, 4.5, 8);

  /**
   * How deep to cut, derived rather than drawn.
   *
   * The first version drew the depth from a range and it was wrong on most
   * seeds, in a way that is obvious in hindsight: a fixed 7 m cut into a flank
   * whose gradient is 0.33 gives a proper ravine, and the same cut into one at
   * 0.71 is a scratch that the hillside climbs straight out of. What the gully
   * has to do is stay LEVEL while the mountain rises around it, so the depth at
   * the mouth is the mountain's own rise over the length of the gully — which
   * for a gaussian is one line of algebra rather than four `heightAt` calls:
   *
   *   d/dr [ A exp(-r^2 / 2s^2) ] = -A (r / s^2) exp(-r^2 / 2s^2)
   *
   * `ridgeDenom` IS 2s^2, so this is that derivative exactly. It ignores the
   * base terrain's own slope and the ridge's `ridgeRough` fbm, both of which
   * are small next to the flank and neither of which is analytic; the tube
   * builder samples the real `heightAt` and adapts to whatever is actually
   * there, so this only has to be close.
   */
  c.grade = ridgeAmp * (flank / (ridgeSigma * ridgeSigma)) * Math.exp(-(flank * flank) / ridgeDenom);
  c.depth = clamp(c.grade * c.aHold * rngRange(rng, 0.92, 1.15), 5.5, 18);

  /**
   * How high the knoll stands over the flank it sits on.
   *
   * 20 to 30 m, which is the canopy — the whole point is a bare rock shoulder
   * standing where the trees stop, and a tor that tops out under them is a
   * secret again. It is not derived from the gully's depth on purpose: the depth
   * is the mountain's own rise over the length of the notch and is therefore
   * correlated with the flank, and a tor scaled by the same number would be
   * biggest exactly where the hillside already gives the mouth its shape.
   */
  c.knoll = rngRange(rng, 20, 30);

  const mouth = caveAxisPoint(c, c.aHold, 0, _caveTmp);
  c.x = mouth.x;
  c.z = mouth.z;
  /**
   * The radius of everything this cave can possibly touch, from its mouth.
   * `caves.js` uses it to decide what to stream, and the rejection below uses
   * it to keep the whole footprint out of the river.
   *
   * The knoll is the larger of the two now — it reaches further past the mouth
   * than the notch does — so this is a max rather than the notch's own extent,
   * and a cave streams from where its hill starts rather than from where its
   * gully does.
   *
   * There is no longer a companion rejection for the spawn: a mouth may land as
   * close to the origin as the ridge puts it, including inside the clearing.
   * See the keep-out block above for what had to change with it.
   */
  c.reach = Math.max(
    Math.hypot(c.aFade - c.aHold + 12, c.wide) + 14,
    Math.hypot(KNOLL_IN + KNOLL_LONG, KNOLL_WIDE)
  );

  if (streamBank(c.x, c.z) < CAVE_DRY) return c;
  c.live = true;
  return c;
}

const _caveTmp = { x: 0, z: 0 };

/**
 * A point in a cave's own frame, in world metres.
 *
 * The inverse of the `a`/`b` projection in `caveNotch`, and it has to be the
 * exact inverse or the tube and the gully are two different caves in the same
 * hillside. Written out rather than shared with a matrix because it is three
 * lines and a matrix would need allocating.
 */
export function caveAxisPoint(c, a, b, out = { x: 0, z: 0 }) {
  const du = a * c.sa + b * c.ca;
  const dv = a * c.ca - b * c.sa;
  const ru = c.u0 + du;
  const rv = c.v0 + dv * c.inSign;
  out.x = ru * ridgeCos - rv * ridgeSin;
  out.z = ru * ridgeSin + rv * ridgeCos;
  return out;
}

/** The cave slot a world position belongs to, cached. See CAVE_SLOTS. */
function caveAt(k) {
  const hit = _caveSlots[k & (CAVE_SLOTS - 1)];
  if (hit !== null && hit.k === k && hit.seed === WORLD_SEED) return hit;
  const made = buildCave(k);
  _caveSlots[k & (CAVE_SLOTS - 1)] = made;
  return made;
}

/**
 * How strongly a cave's gully wants the ground to itself, 0..1.
 *
 * WHY THE SCATTER NEEDS ITS OWN QUESTION RATHER THAN READING THE HEIGHT.
 *
 * `forestDensity` already rejects steep ground — it scales by `1 - slope * 2.4`
 * — and that is exactly why the gully plants. A ravine's WALLS are steep and
 * get no trees; its FLOOR is the flattest ground for fifty metres, so it scores
 * a higher density than the hillside it is cut into. The result was three to
 * five trees standing in the last widened stretch before the arch, screening
 * the one thing in the feature that has to be legible from a distance.
 *
 * Fluting the floor (0.4 m at ~3 m wavelength) reads as slope 0.25 and clears
 * most of them, but a cave mouth is a place that should be clear on purpose
 * rather than clear as a side effect of a noise term. This is that purpose,
 * stated once.
 *
 * IT IS THE SAME FRAME AND THE SAME PROFILE `heightAt` CARVES WITH, deliberately
 * — `caveNotch` is the single definition of where the gully is, so the hole in
 * the tree field cannot drift out of register with the hole in the ground the
 * way two hand-tuned radii would. Widened along the axis and across it, because
 * a trunk is not a point: its canopy reaches ~4 m and its roots would stand in
 * the wall.
 *
 * The tor is the second hole in the tree field and the larger one — see the
 * block inside this function for why a hill that clears its own flanks by slope
 * still needs telling about its summit.
 *
 * Returns 0 everywhere there is no cave, which is almost everywhere, for one
 * integer compare and one slot lookup — the same cost `heightAt` already pays.
 */
export function caveClearance(x, z) {
  const ru = x * ridgeCos + z * ridgeSin;
  const rv = z * ridgeCos - x * ridgeSin;
  const c = caveAt(Math.round(ru * CAVE_INV_SPACING));
  if (!c.live) return 0;
  const du = ru - c.u0;
  const dv = (rv - c.v0) * c.inSign;
  const a = dv * c.ca + du * c.sa;
  const b = du * c.ca - dv * c.sa;
  /**
   * The tor is bare, and it is bare on purpose rather than by slope.
   *
   * `forestDensity` stops at a gradient of 0.417 and a 25 m dome over 24 m of
   * half-width is far past that, so its FLANKS clear themselves — but its top is
   * the flattest ground for eighty metres and scored a full stand of trees,
   * which is the same trap the gully floor fell into and which this function was
   * written for. A rock hill with a wood growing on the summit is a hill; the
   * landmark is the bald patch as much as it is the rock.
   *
   * Full clearance from the middle of the dome out to 40% of it, then a ramp to
   * nothing at the skirt, so the glade has a treeline rather than an edge.
   */
  const tor = clamp01((knollDome(c, a, b) - 0.05) / 0.35);
  if (tor >= 1) return 1;
  // The notch profile itself, plus a margin: a canopy overhangs the gully long
  // before a trunk stands in it.
  const cut = caveNotch(c, a, b);
  if (cut > 0) return 1;
  const margin = caveNotch(c, a, b > 0 ? Math.max(0, b - 4.5) : Math.min(0, b + 4.5));
  return Math.max(tor, margin > 0 ? clamp01(margin / Math.max(0.001, cut || margin)) : 0);
}

/**
 * The cave slots near a world position, for `caves.js` to stream from.
 *
 * Returns live descriptors only, nearest first, from the slots within `span`
 * metres along the crest. Not on any hot path — called once every few frames
 * from the streamer — so it allocates.
 */
export function cavesNear(x, z, span = 460) {
  const ru = x * ridgeCos + z * ridgeSin;
  const k0 = Math.round(ru * CAVE_INV_SPACING);
  const reach = Math.ceil(span * CAVE_INV_SPACING) + 1;
  const out = [];
  for (let k = k0 - reach; k <= k0 + reach; k++) {
    const c = caveAt(k);
    if (c.live) out.push(c);
  }
  out.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
  return out;
}

/**
 * How much ground the notch removes at a point in its own frame.
 *
 * Separable — a profile along the gully times a profile across it — which is
 * the same shape the stream's corridor uses and for the same reason: the two
 * ends of the gully and its two banks are independent decisions, and a radial
 * falloff would tie them together into a crater.
 */
function caveNotch(c, a, b) {
  const ab = b < 0 ? -b : b;
  if (a <= c.aOpen || a >= c.aFade || ab >= c.wide) return 0;
  const along =
    smoothstep(clamp01((a - c.aOpen) / (c.aFull - c.aOpen))) *
    (1 - smoothstep(clamp01((a - c.aHold) / (c.aFade - c.aHold))));

  /**
   * THE FLOOR WIDENS TOWARD THE MOUTH, and it is a scatter decision as much as
   * a shape one.
   *
   * The first version used one width for the whole gully, and it had to be at
   * least the tunnel's own 4.6 m or the terrain pushed up through the floor in
   * the last three metres of the approach (see `flat` in `buildCave`). Ten
   * metres of flat floor is prime forest: `forestDensity` in scatter.js scales
   * tree density by `1 - slope * 2.4`, a flat floor scores zero slope, and the
   * ravine came out with full-sized trees standing in it all the way to the
   * entrance. You could not see the cave for the wood, literally.
   *
   * Tapering from 1.9 m at the open end fixes both halves at once. The gully
   * spends most of its length as a slot with walls too steep to plant on — the
   * smoothstep's own gradient peaks at 1.5x the average, which on an 8 m carve
   * over 6 m of bank is 2.0, well past the 0.417 slope where trees stop — and
   * it opens out only in the last stretch, where the doorway needs the room.
   * Squared, so the widening happens late rather than gradually.
   */
  const w = clamp01((a - c.aOpen) / (c.aHold - c.aOpen));
  const flat = 1.9 + (c.flat - 1.9) * w * w;
  const wide = flat + (c.wide - c.flat);
  if (ab >= wide) return 0;
  const across = 1 - smoothstep(clamp01((ab - flat) / (wide - flat)));

  /**
   * Flutes: runnels down the floor, at the scale `slopeAt` measures.
   *
   * The second half of the tree problem. Narrowing the slot removes most of
   * the plantable area and this removes most of what is left, by making the
   * floor measurably not flat: `slopeAt` is a central difference with a 0.7 m
   * epsilon, so a 0.4 m ripple at a ~3 m wavelength reads to it as a slope of
   * about 0.25 and takes the tree density down to 40% — while being, to a
   * walker, a 0.27 gradient, which is a gentle ripple underfoot.
   *
   * It is also simply what the floor of a watercourse looks like, and this one
   * is a watercourse: it is the only thing that could have cut the gully.
   *
   * FADED OUT SIX METRES BEFORE THE MOUTH, and that is not tidiness. The tube's
   * first rings are placed on `heightAt` along this axis and the tube's floor is
   * then analytic and smooth, so any ripple still present where the two meet is
   * half a metre of daylight between the ground you are standing on and the
   * ground being drawn.
   */
  const cut = c.depth * along * across;
  if (cut <= 0) return 0;
  const calm = clamp01((c.aHold - 1 - a) / 5);
  if (calm <= 0) return cut;
  return cut + noise2(a * 0.36 + c.k * 7.3, b * 0.42 - c.k * 3.1) * 0.4 * calm * across;
}

/**
 * The hill the mouth is in the face of. See the knoll block at KNOLL_LONG.
 *
 * An ellipse in the gully's own frame, faded by a smoothstep so the join to the
 * flank has no edge, times a ridged multifractal so that what stands up is a
 * broken crag rather than a dome. `ridged2` is the same function the far-world
 * crag regions are made of and it is used here at a wavelength of about forty
 * metres — one or two humps across a knoll, not detail. Detail on this comes
 * from the terrain's own fbm, which is added before this and rides up with it.
 *
 * Offset per slot so that two knolls a few hundred metres apart are not the same
 * rock twice.
 */
function knollDome(c, a, b) {
  const da = (a - (c.aHold + KNOLL_IN)) / KNOLL_LONG;
  const db = b / KNOLL_WIDE;
  const q = da * da + db * db;
  if (q >= 1) return 0;
  return 1 - smoothstep(Math.sqrt(q));
}

function caveKnoll(c, a, b, x, z) {
  const dome = knollDome(c, a, b);
  if (dome <= 0) return 0;

  /**
   * AND THE SLOT THROUGH IT, WHICH IS THE WHOLE DIFFICULTY.
   *
   * The dome has to be absent where the gully is, and it has to stay absent for
   * a good way PAST the mouth. The first version took it out in proportion to
   * the notch's own profile, which sounds exactly right and plugs the doorway:
   * the notch fades over the six to eleven metres between `aHold` and `aFade` —
   * that fade is how the hillside closes over the tube — so the dome came back
   * up over that same short run, and thirteen metres of hill returning across
   * eight is a wall standing in the entrance. From outside you saw a rock arch
   * with a mound of grass filling it.
   *
   * `open` is that fade, done over eighteen metres instead and starting two past
   * the mouth. The passage buries itself under the returning dome comfortably
   * within it — `buildNodes` lets its floor climb at most 0.34 m per metre while
   * the surface above it rises at 0.7 — and the shape that results is the one
   * that was wanted: a rock dome with a slot cut in its face, closing over you a
   * few strides in.
   *
   * The widths come from the descriptor rather than from constants of their own,
   * so a gully that is wider than usual gets a wider slot. `flat` is the floor's
   * half-width and `wide` the outer lip's, and the dome begins to rise inside
   * that lip on purpose: it is what makes the gully walls tall at the mouth
   * rather than leaving a shelf between the notch and the hill.
   */
  const ab = b < 0 ? -b : b;
  const half = c.flat + 1.5;
  const lip = c.wide + 5;
  const across = ab >= lip ? 0 : 1 - smoothstep(clamp01((ab - half) / (lip - half)));
  const open = 1 - smoothstep(clamp01((a - (c.aHold + 2)) / 18));

  const rough = 0.5 + 0.8 * clamp01(ridged2(x * 0.026 + c.k * 13.7, z * 0.026 - c.k * 9.1, 3) + 0.42);
  return c.knoll * dome * rough * (1 - across * open);
}

/**
 * Height in metres at a world position.
 *
 * Pure, cheap enough to call a few thousand times at load and a handful of times
 * per frame, and the single source of truth for "where is the ground".
 */
/**
 * A soft floor.
 *
 * `Math.max(h, floor)` would put a crease along every contour where the terrain
 * met the limit — an unmistakable straight-ish line running through the woods.
 * Softplus approaches the floor asymptotically instead, so low ground flattens
 * into a broad basin and there is no seam anywhere.
 */
function softFloor(h, floor, k = 0.42) {
  const v = (h - floor) * k;
  // log1p(exp(v)) written to stay finite for large v.
  const soft = v > 20 ? v : Math.log1p(Math.exp(v));
  return floor + soft / k;
}

export function heightAt(x, z) {
  const d = Math.hypot(x, z);

  /**
   * The region's amplitudes. Exactly the authored ones inside REGION_INNER.
   *
   * `land` and `hill` multiply the two fbm terms below; `crag` is an amplitude
   * in metres for a ridged term that does not exist at all near the origin.
   * The two region fbms are sampled at different frequencies AND different
   * offsets: sharing a lattice would correlate "how much relief" with "how
   * broken it is", and every rugged place would then also be the tallest one,
   * which is a rule the eye learns in about ninety seconds.
   */
  let land = 1;
  let hill = 1;
  let crag = 0;
  let lift = 0;
  if (d > REGION_INNER) {
    const mask = smoothstep(clamp01((d - REGION_INNER) / (REGION_OUTER - REGION_INNER)));
    const rx = x * REGION_SCALE;
    const rz = z * REGION_SCALE;
    // ±0.35 in practice; ×3.4 gives a landform amplitude between about 6 m and
    // 50 m, i.e. from downland you can see across to hills that block the view.
    land = 1 + mask * clamp(fbm2(rx + kRegLandX, rz + kRegLandZ, 2) * 3.4, -0.7, 1.7);
    // Hillocks run the OPPOSITE way from the landform, and the sign is the
    // whole point. Smooth sweeping country and fussy broken country are
    // different places; tie the two amplitudes together and every region is
    // merely a louder or quieter copy of the same one.
    hill = 1 + mask * clamp(fbm2(rz * 1.31 + kRegHillX, rx * 1.31 + kRegHillZ, 2) * -2.6, -0.75, 2.6);
    /**
     * LIFT IS THE TERM THAT ACTUALLY MOVED THE NUMBERS, AND THE REASON IS
     * `softFloor`, NOT THE NOISE.
     *
     * Scaling the landform amplitude alone barely changed the measured relief:
     * 11 m per 640 m became 13. The floor is why. `softFloor` compresses
     * everything below about +3 m asymptotically onto the waterline, and a
     * zero-mean fbm spends half its life down there — so most of the amplitude
     * being multiplied was amplitude that had already been squashed flat, and
     * doubling it bought almost nothing.
     *
     * Lifting a region bodily moves its noise up out of the compressed band,
     * where the full amplitude survives. It is also the better idea on its own
     * terms: it makes some regions high ground and others low, which is a
     * distinction you can navigate by, and because the stream is carved AFTER
     * this it cuts a real gorge through the raised ones instead of politely
     * rising with them.
     *
     * Capped at 15 m, and the cap is the gorge. The channel blends from the
     * region's height to the water profile over roughly 12 m of bank, so the
     * lift is very nearly the bank's gradient; past ~15 m it stops reading as a
     * ravine and starts reading as a wall with a river at the bottom.
     *
     *
     * THE LOWER CLAMP IS THE ONE THAT MATTERS, AND IT IS NOT SYMMETRIC WITH THE
     * UPPER ONE BY ACCIDENT.
     *
     * `softFloor(h, WATER_LEVEL + 1.9)` above is the guarantee that the stream
     * is the only water in the world, and it has exactly 1.9 m of headroom.
     * This term is added AFTER it. So any NEGATIVE lift spends that headroom,
     * and a lower clamp of -0.2 spends 0.2 × 15 = 3.0 m of a 1.9 m budget —
     * putting the ground up to 1.10 m under the water plane, outside the
     * channel, with nothing to stop trees growing there because `submerged()`
     * keys off `wetness()` and there is no wetness away from the river. A lake
     * with a wood standing in it.
     *
     * The authored world has always had this: 1.4% of its area at 900–1500 m
     * and 12.3% at 1500–3000 m, all at that same 1.10 m depth. It survived
     * because it is far out and shallow. Seeded worlds are the reason it can no
     * longer survive — they reach the same clamp far more often and much closer
     * in, 8–25% of the area at 600–900 m, which is twenty seconds' walk.
     *
     * -1.75/15 spends 1.75 m of the 1.9 and leaves 15 cm of daylight, so the
     * softFloor guarantee holds by construction rather than by luck. It costs a
     * little of the deepest basins in the far field and nothing else; every
     * radius any test or reference image looks at is inside REGION_INNER, where
     * `lift` is exactly zero.
     */
    lift = mask * clamp(fbm2(rz * 0.61 + kRegLiftX, rx * 0.61 + kRegLiftZ, 2) * 3.1 + 0.25, -1.75 / 15, 1) * 15;
    // Crag is rare: the raw field is negative more often than not and the max
    // floors it at zero, so about a third of the map has any at all and the
    // rest pays neither the amplitude nor the three octaves below.
    crag = mask * Math.max(0, fbm2(rx * 0.83 + kRegCragX, rz * 0.83 + kRegCragZ, 2) * 2.4 - 0.18) * 42;
  }

  // Rolling base terrain. Three scales: landform, hillocks, and the small
  // undulation that stops any patch of ground reading as a plane.
  let h = fbm2(x * landFreq + kLandX, z * landFreq + kLandZ, 3) * landAmp * land;
  h += fbm2(x * hillFreq + kHillX, z * hillFreq + kHillZ, 3) * hillAmp * hill;
  h += noise2(x * 0.085 + kFineX, z * 0.085 + kFineZ) * 0.5;
  /**
   * Sampled an octave coarser than the hillocks so a crag reads as one massif
   * with a broken skyline rather than as gravel scaled up.
   *
   * The first tuning ran this at 0.0135 with a 62 m amplitude and it measured
   * beautifully — 72 m of relief in a block — and looked wrong: ridged noise's
   * top octave is a quarter of the amplitude at a twelfth of the wavelength, so
   * a 100 m crag put 12 m of vertical movement into 9 m of ground and the
   * mountains came out as needles. A mountain is not a rough plain with the
   * contrast turned up; it is a LOW-frequency shape that happens to be steep.
   */
  if (crag > 0.35) h += ridged2(x * 0.0105 + kCragX, z * 0.0105 + kCragZ, 3) * crag;

  /**
   * EVERYTHING IS ABOVE THE WATERLINE EXCEPT WHAT IS CARVED BELOW IT.
   *
   * The water is one flat plane across the whole world, so any hollow the noise
   * happens to dig below it becomes a lake — and with a 19 m landform amplitude
   * the noise digs a great many. The first build spawned the player on the shore
   * of an accidental inland sea seven metres from the jukebox.
   *
   * Lifting the whole field to a soft floor safely above the plane makes the
   * stream the ONLY water in the world, which is both what was wanted and a
   * property that cannot be broken by retuning the noise later.
   */
  h = softFloor(h, WATER_LEVEL + 1.9);
  // After the floor, not before: the point of the lift is to escape the
  // compression, and adding it first would simply give the floor more to
  // squash. Exactly zero inside REGION_INNER, so `h + 0` is `h`.
  h += lift;

  /**
   * The ridge: one long swell, on this world's bearing.
   *
   * `ru` runs along the crest and `rv` across it. In the authored world the
   * rotation is the identity and these two lines are `z - (-96 + sin(x·0.017)·
   * 18)` written out — `x·1 + z·0` is exactly `x`, so the seeded form is not an
   * approximation of the old one, it IS the old one at seed 0.
   *
   * The crest's own meander is a function of `ru` and not of x, which is the
   * part that is easy to get wrong: wobbling on x would make a ridge running
   * north–south ripple along its width instead of along its length, i.e. a row
   * of hills rather than a range.
   */
  const ru = x * ridgeCos + z * ridgeSin;
  const rv = z * ridgeCos - x * ridgeSin;
  const ridgeAxis = rv - (ridgeDist + Math.sin(ru * ridgeWaveK + ridgeWaveP) * ridgeWaveA);
  const ridge = Math.exp(-(ridgeAxis * ridgeAxis) / ridgeDenom);
  h += ridge * (ridgeAmp + fbm2(x * 0.03 + kRidgeX, z * 0.03 + kRidgeZ, 2) * ridgeRough);

  /**
   * The cave mouths, cut into the flank the line above just built.
   *
   * AFTER the ridge because the gully is cut into the mountain and there is no
   * mountain until that line has run. BEFORE the stream because if a channel
   * ever did cross a gully the river should win — it is carved by blending
   * toward an explicit profile and that profile is what guarantees the water
   * plane stays buried. `buildCave` keeps them 34 m apart so this never
   * happens, and the ordering is here so that the day it does the failure is a
   * cave with a river through it rather than a river with a hole in it.
   *
   * And at every radius, including inside the clearing. The notch is a
   * continuous function of position with no reference to `d` in it, which is
   * what lets a gully run right up to the spawn without a seam anywhere; see
   * the keep-out block at CAVE_SPACING for why the radial cutoff that used to
   * be here could not survive the keep-out going away.
   */
  {
    const c = caveAt(Math.round(ru * CAVE_INV_SPACING));
    if (c.live) {
      const du = ru - c.u0;
      const dv = (rv - c.v0) * c.inSign;
      const a = dv * c.ca + du * c.sa;
      const b = du * c.ca - dv * c.sa;
      /**
       * THE KNOLL GOES ON FIRST, AND IT CARRIES ITS OWN HOLE.
       *
       * The dome is added to the ground before the notch is cut, and it is
       * absent along the slot the gully runs in — see `caveKnoll`, which is
       * where that slot is defined and why it has to stay open past the mouth.
       * So the two are independent: the gully is carved into the same flank it
       * always was, at the same depth, and the hill stands beside it.
       *
       * The alternative — lift everything and take the gully back out of the
       * lift — is what this did first, and the fade that closes the hillside
       * over the tube is far too short to also be the fade that returns a
       * thirteen-metre dome. It filled the doorway with hill.
       */
      const lift = caveKnoll(c, a, b, x, z);
      if (lift > 0) h += lift;
      const cut = caveNotch(c, a, b);
      if (cut > 0) {
        /**
         * A SATURATING CUT, NOT `Math.max(h - cut, CAVE_BED)`.
         *
         * The gully has to stay out of the water for the reason at CAVE_DRY,
         * and a hard clamp would put a dead-flat pan in the floor of every
         * deep notch with a visible crease around it — the same objection
         * `softFloor` exists to answer at the waterline.
         *
         * `softFloor` itself is not usable here, because it lifts values that
         * are already well above the floor: at 6 m of clearance it adds 19 cm,
         * so the notch boundary — where `cut` reaches exactly zero — would gain
         * a step of that size all the way round. This is exact at cut = 0 (the
         * limit of m(1 - e^(-c/m)) as c -> 0 is c) and asymptotic to the bed,
         * so it costs one `exp` and has no boundary at all.
         */
        const room = h - CAVE_BED;
        h -= room * (1 - Math.exp(-cut / room));
      }
    }
  }

  // The clearing: a shallow dish centred on the origin. Kept modest — a big flat
  // lawn with trees around the edge is a park, and the enclosed feeling this
  // world runs on comes from the trees being close. Its size and floor vary by
  // world; its CENTRE does not, because `forestDensity` in scatter.js carves the
  // tree field's matching hole at a hardcoded radius around the origin.
  const bowl = 1 - smoothstep(clamp01((d - clearInner) / clearRamp));
  h = lerp(h, clearFloor + noise2(x * 0.13 + kDishX, z * 0.13 + kDishZ) * 0.32, bowl * CLEARING_MIX);

  /**
   * The stream, carved rather than subtracted.
   *
   * Blending toward an explicit V-profile — rather than subtracting a gaussian
   * from whatever the terrain happened to be — is what guarantees the channel
   * floor is below the water plane and the banks are above it, everywhere along
   * its length. A subtraction only guarantees a relative depth, which on a hill
   * gives you a river running along a ridgeline.
   */
  const bank = streamBank(x, z);
  const corridor = 1 - smoothstep(clamp01((bank - 3) / 15));
  const profile =
    WATER_LEVEL -
    1.5 +
    Math.pow(clamp01(bank / 15), 1.6) * 7.5 +
    noise2(x * 0.2 + kBedX, z * 0.2 + kBedZ) * 0.2;
  h = lerp(h, profile, corridor * 0.94);

  /**
   * THERE USED TO BE A WALL HERE.
   *
   *   const edge = smoothstep(clamp01((d - WORLD_RADIUS * 0.86) / (WORLD_RADIUS * 0.34)));
   *   h = lerp(h, h + 16 + edge * 40, edge);
   *
   * Past 163.4 m the ground ramped up by as much as 56 m, so that the plate
   * ended in a rim rather than in a cliff. It was the right answer to the wrong
   * question. The plate is gone — `ground.js` streams chunks and never stops —
   * so there is no longer an edge to hide, and a 56 m ridge of nothing in
   * particular sitting in a ring at a fixed distance from the origin would be
   * the most obviously authored thing in an otherwise endless valley.
   *
   * `clamp01` pinned the argument at 0 below 163.4 m and `smoothstep(0)` is 0,
   * so the lerp was the identity there. Deleting it therefore cannot move a
   * single height inside that radius, and `scripts/world-gridcheck.mjs` samples
   * 223 698 points to confirm it rather than trusting the algebra.
   */
  return h;
}

/** Surface normal by central difference. Used for slope-aware scattering. */
export function normalAt(x, z, out = new THREE.Vector3()) {
  const e = 0.7;
  const hL = heightAt(x - e, z);
  const hR = heightAt(x + e, z);
  const hD = heightAt(x, z - e);
  const hU = heightAt(x, z + e);
  return out.set(hL - hR, 2 * e, hD - hU).normalize();
}

/** 0 on flat ground, 1 on a cliff. */
export function slopeAt(x, z) {
  const n = normalAt(x, z, _n);
  return clamp01(1 - n.y);
}
const _n = new THREE.Vector3();

/** True where the stream runs, used to keep trees out of the water. */
export function wetness(x, z) {
  return clamp01(1 - streamBank(x, z) / 11);
}

/**
 * Sample a rectangular patch of the height field into raw mesh buffers.
 *
 * This is the one place ground geometry is made. `buildTerrainGeometry()` below
 * is a thin wrapper over it for the single 380 m plate the world used to be, and
 * `ground.js` calls it once per streamed 128 m chunk — from inside a worker,
 * which is why it returns plain typed arrays and touches no `BufferGeometry`.
 * Nothing here needs a GL context or a main thread.
 *
 * `ox, oz` is the patch's minimum corner in world metres, `seg` the number of
 * quads per side, `cell` the metres between vertices. It emits (seg+1)²
 * vertices in PlaneGeometry's own order — row-major with z outermost, and the
 * same two-triangle winding — so a wrapper can reproduce the old plate
 * vertex-for-vertex.
 *
 *
 * UNIFORM CELLS, NO LOD, EVER.
 *
 * The obvious thing to do with a streamed heightfield is to coarsen distant
 * chunks, and it would be wrong here twice over. The arithmetic first: a 320 m
 * ring at 1.6 m is 0.32 M triangles against a frame that already draws 13 M, so
 * an entire LOD subsystem — stitching, geomorphing, a second normal path —
 * would exist to save one and a half percent of the triangles.
 *
 * The real objection is that it would break the trip. `living.js` displaces this
 * mesh from its vertex shader: `uHills` adds `(y + 4) * uHills * rrFar`, which
 * at the ridge is 38.6 m of displacement and amplifies any geomorph error 1.42×
 * into a silhouette error against the sky — a couple of pixels of crawling edge
 * on exactly the landmark the whole world is navigated by. And `uFlow`'s
 * eighteen-metre octave is eleven samples across at 1.6 m but 2.8 at 6.4 m,
 * which is the same faceting `living.js` already deletes its six-metre octave
 * over the terrain to avoid (see the `#ifndef RR_TERRAIN` block there). LOD
 * would put the artefact back and make it move.
 *
 *
 * NORMALS FROM A PADDED GRID, NOT FROM `slopeAt` AND NOT FROM
 * `computeVertexNormals()`.
 *
 * Both alternatives are worse, for different reasons.
 *
 * `computeVertexNormals()` averages the faces a vertex belongs to, so a vertex
 * on a chunk EDGE averages only the faces on its own side of the boundary and
 * comes out tilted. That is not merely a shading seam: `living.js` displaces
 * along `objectNormal` for the breath — up to 0.25 m — so two chunks whose
 * shared edge vertices disagree about which way is up would open and close a
 * crack along every chunk border once per breath cycle, about seven times a
 * minute. That is the "looks like the renderer is broken" class of artefact
 * this project exists to avoid.
 *
 * `slopeAt`/`normalAt` have no seam, but they cost five extra `heightAt` calls
 * per vertex. Sampling one extra ring of heights around the patch instead — a
 * (seg+3)² grid for (seg+1)² vertices — gives every emitted vertex, edge ones
 * included, four real neighbours to difference against, and reuses each sample
 * for its four neighbours' normals as well as its own height. Measured on this
 * machine: 6.1 ms for a 6561-vertex chunk this way against 12.5 ms for a
 * 4225-vertex one through `slopeAt`. 2.6× faster AND it fixes the seam.
 *
 * The `slope` that drives the colour blend comes from the same difference. It
 * is therefore taken at the mesh's own spacing rather than at `slopeAt`'s fixed
 * 0.7 m, which is a slightly smoother estimate of the same quantity — see
 * `scripts/world-gridcheck.mjs`, which measures the resulting colour difference
 * rather than assuming it away.
 *
 *
 * `worldXZ` BAKES THE PATCH ORIGIN INTO x AND z. THE HEIGHT IS ALWAYS ABSOLUTE.
 *
 * Streamed chunks leave it off and are positioned with `mesh.position.set(ox, 0,
 * oz)`, so their vertex coordinates stay inside [0, 128] however far you have
 * walked — float32 resolves that to 10 µm, where world coordinates at 10 km
 * resolve to a millimetre, and the trip reads `transformed` and `objectNormal`
 * in object space before the model matrix is applied.
 *
 * Y IS NEVER LOCAL, AND THIS IS THE ONE THING IT IS EASIEST TO GET WRONG. The
 * tempting symmetry is to bake heights relative to the chunk and offset with
 * `mesh.position.y`. `uHills` multiplies the LOCAL `transformed.y`, so under
 * that scheme each chunk would exaggerate its own heights around its own datum
 * and every chunk border would grow a step that got bigger as the trip got
 * stronger.
 *
 * @returns {{position: Float32Array, normal: Float32Array, color: Float32Array,
 *            aWet: Float32Array, index: Uint16Array|Uint32Array}}
 */
export function heightGrid(ox, oz, seg, cell, { worldXZ = false } = {}) {
  const side = seg + 1;
  const pad = seg + 3;
  const count = side * side;

  /**
   * Sample coordinates rounded to float32 BEFORE they reach `heightAt`.
   *
   * The vertex positions end up in a Float32Array either way, so the mesh is
   * drawn at the rounded coordinate whatever we sample at — sampling at the
   * float64 one would put the height a few microns from where the vertex is.
   * It matters for a second and larger reason: two neighbouring chunks share an
   * edge, and they agree on it exactly only if they agree on how the shared
   * coordinate is rounded. `ox` is always a multiple of the chunk size, so
   * `ox_left + seg*cell` and `ox_right + 0` are the same double and round the
   * same way. Without this the seam would be a few microns of crack that the
   * breath displacement would then open up.
   */
  const xs = new Float64Array(pad);
  const zs = new Float64Array(pad);
  for (let k = 0; k < pad; k++) {
    xs[k] = Math.fround(ox + (k - 1) * cell);
    zs[k] = Math.fround(oz + (k - 1) * cell);
  }

  const H = new Float64Array(pad * pad);
  for (let k = 0; k < pad; k++) {
    const z = zs[k];
    const row = k * pad;
    for (let i = 0; i < pad; i++) H[row + i] = heightAt(xs[i], z);
  }

  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  // Per-vertex colour carries the biome blend. Doing it here rather than with a
  // texture means the ground colour follows the actual terrain — moss in the
  // hollows, dry needle litter on the slopes, gravel at the waterline — with no
  // UV seams and no texture memory.
  const color = new Float32Array(count * 3);
  const wet = new Float32Array(count);

  const moss = new THREE.Color(0x5c7a3c);
  const litter = new THREE.Color(0x6a5231);
  const dry = new THREE.Color(0x8a7d47);
  const gravel = new THREE.Color(0x77736a);
  const tmp = new THREE.Color();
  const shade = new THREE.Color();
  const twoCell = 2 * cell;

  for (let j = 0; j < side; j++) {
    const z = zs[j + 1];
    const mid = (j + 1) * pad;
    const down = j * pad;
    const up = (j + 2) * pad;
    for (let i = 0; i < side; i++) {
      const x = xs[i + 1];
      const h = H[mid + i + 1];
      const k = (j * side + i) * 3;

      position[k] = worldXZ ? x : i * cell;
      position[k + 1] = h;
      position[k + 2] = worldXZ ? z : j * cell;

      // Central difference, in exactly the form `normalAt` uses, with the
      // epsilon being the cell rather than an arbitrary 0.7 m.
      let nx = H[mid + i] - H[mid + i + 2];
      let ny = twoCell;
      let nz = H[down + i + 1] - H[up + i + 1];
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      normal[k] = nx;
      normal[k + 1] = ny;
      normal[k + 2] = nz;

      const slope = clamp01(1 - ny);
      const damp = wetness(x, z);
      const patch = fbm2(x * 0.045 + kBiomeX, z * 0.045 + kBiomeZ, 2) * 0.5 + 0.5;

      tmp.copy(moss).lerp(litter, clamp01(patch * 1.35 - 0.12));
      tmp.lerp(dry, clamp01(slope * 2.1 - 0.25));
      tmp.lerp(gravel, clamp01((damp - 0.45) * 2.6));
      // Height-driven desaturation: the ridge is exposed and pale, the hollow is
      // dark and green. It is the cheapest possible aerial perspective and it does
      // most of the work in making the ridge read as *far away and high up*.
      const alt = clamp01((h + 6) / 40);
      tmp.lerp(shade.copy(tmp).offsetHSL(-0.02, -0.16 * alt, 0.1 * alt), alt);

      /**
       * Mottle, at the scale of the mesh itself.
       *
       * The ground was a flat sheet of one green, which is the single most
       * synthetic-looking surface in the world — real forest floor is a mess of
       * leaf litter, moss, bare earth and root. Two octaves of high-frequency
       * noise in both value and hue at roughly the vertex spacing gives it
       * texture for free, no texture map and no UVs.
       */
      const grain =
        noise2(x * 0.62 + kGrainX, z * 0.62 + kGrainZ) * 0.5 +
        noise2(x * 1.7 + kGrain2X, z * 1.7 + kGrain2Z) * 0.25;
      tmp.offsetHSL(grain * 0.035, grain * 0.1, grain * 0.16);

      color[k] = tmp.r;
      color[k + 1] = tmp.g;
      color[k + 2] = tmp.b;
      wet[j * side + i] = damp;
    }
  }

  /**
   * PlaneGeometry's winding, kept exactly.
   *
   * Not superstition: it is what lets the stage-0 refactor be checked against
   * the geometry it replaced index-for-index instead of only statistically.
   */
  const Index = count > 65535 ? Uint32Array : Uint16Array;
  const index = new Index(seg * seg * 6);
  let t = 0;
  for (let iy = 0; iy < seg; iy++) {
    for (let ix = 0; ix < seg; ix++) {
      const a = ix + side * iy;
      const b = ix + side * (iy + 1);
      const c = ix + 1 + side * (iy + 1);
      const d = ix + 1 + side * iy;
      index[t++] = a;
      index[t++] = b;
      index[t++] = d;
      index[t++] = b;
      index[t++] = c;
      index[t++] = d;
    }
  }

  return { position, normal, color, aWet: wet, index };
}

/** Wrap the five buffers `heightGrid` returns in a real BufferGeometry. */
export function gridGeometry(grid) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(grid.position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(grid.normal, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(grid.color, 3));
  geo.setAttribute('aWet', new THREE.BufferAttribute(grid.aWet, 1));
  geo.setIndex(new THREE.BufferAttribute(grid.index, 1));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Build the ground mesh — one 380 m plate centred on the origin.
 *
 * Superseded in play by `ground.js`, which streams the same function in 128 m
 * chunks and never stops. Kept because it is the cheapest way to get the whole
 * authored region in one geometry, which is what every offline check that
 * compares terrain against itself wants, and because it is the reference the
 * stage-0 refactor was verified against.
 *
 * The cell size is `span / segments`, not `CELL`: 380 / 1.6 is 237.5, and
 * rounding that to 238 quads makes the real spacing 1.5966 m. The wrapper has
 * to reproduce that or it is not the same plate.
 */
export function buildTerrainGeometry() {
  const span = WORLD_RADIUS * 2;
  const segments = Math.round(span / CELL);
  return gridGeometry(
    heightGrid(-WORLD_RADIUS, -WORLD_RADIUS, segments, span / segments, { worldXZ: true })
  );
}

/**
 * Sample the ground under a point, with a little smoothing.
 *
 * The controller walks on this rather than on the mesh. Averaging four taps
 * across the body's footprint stops a single sharp vertex from launching the
 * player, which is the classic heightfield walking artefact.
 */
export function groundUnder(x, z, radius = 0.34) {
  const a = heightAt(x - radius, z);
  const b = heightAt(x + radius, z);
  const c = heightAt(x, z - radius);
  const d = heightAt(x, z + radius);
  const centre = heightAt(x, z);
  return Math.max(centre, (a + b + c + d) * 0.25);
}

/**
 * Where the player is allowed to be. Everywhere.
 *
 * This used to clamp to `WORLD_RADIUS * 0.82` = 155.8 m, and that clamp is the
 * single thing this whole change exists to remove. Standing against it, the
 * mesh ended 34 m in front of you and below your eye with sky beyond it; the fog
 * at 34 m passes 91% of the light, so it hid nothing, and the `edge` ramp that
 * was supposed to hide it did not either. You could see the end of the world and
 * you could not walk to it. Both halves of that were the complaint.
 *
 * KEPT AS AN IDENTITY RATHER THAN DELETED, on purpose. "How far may the player
 * go" is a real question that the controller should not have to answer for
 * itself, and the next person to ask it should find the answer here, next to the
 * reason, rather than discover that the question is not asked anywhere at all.
 *
 * There is a horizon, and it is not geometry: `hash21` in util.js takes
 * `fract(x * 123.34)`, so the noise lattice starts losing resolution once |x|
 * is around 1e9 — roughly four years of continuous sprinting. Nothing worth
 * writing a clamp for.
 */
export function confine(v) {
  return v;
}

/**
 * Adopt the realm's seed, if something already set one.
 *
 * Two callers, and they are the reason this is not dead code:
 *
 *   A SECOND COPY OF THIS MODULE. `setWorldSeed` publishes the seed on
 *   `globalThis`, so a late `import()` — Vite hands those an HMR-versioned URL
 *   and therefore a fresh module instance — comes up in the world the page is
 *   already in rather than in the authored one. See the note in
 *   `setWorldSeed`.
 *
 *   A TEST SCRIPT WITH NO SEED WIRING TO REACH. Playwright's `addInitScript`
 *   runs before any module in the page evaluates, so a script can put a world
 *   in place before `main.js` exists to choose one.
 *
 * AT THE BOTTOM OF THE FILE ON PURPOSE. `setWorldSeed` ends in `guardClearing`,
 * which calls `heightAt`, which reads REGION_INNER and its two siblings. Those
 * are `const`, so they are in the temporal dead zone until their declarations
 * run; the same three lines placed next to `setWorldSeed` threw a
 * ReferenceError on the first load with a seed set. Function declarations hoist,
 * module-level `const` bindings do not.
 */
if (typeof globalThis !== 'undefined' && globalThis.RR_WORLD_SEED !== undefined) {
  setWorldSeed(globalThis.RR_WORLD_SEED);
}

export { CELL, clamp };
