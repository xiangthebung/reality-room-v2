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
import { siteClearance } from './sites.js';

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

const CLEARING_RADIUS = 14;

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
let _groveX = 5;
let _groveZ = -9;

function grove(x, z) {
  const s = getWorldSeed();
  if (s !== _groveSeed) {
    _groveSeed = s;
    if (s === 0) {
      _groveX = 5;
      _groveZ = -9;
    } else {
      // Spread over a few hundred lattice units. `noise2` hashes on the integer
      // lattice, so anything smaller than a couple of features (~90 m at this
      // frequency, i.e. ~1 unit of domain) would return nearly the same wood.
      _groveX = (hashString(`grove:x:${s}`) % 100000) / 137.0 - 364;
      _groveZ = (hashString(`grove:z:${s}`) % 100000) / 137.0 - 364;
    }
  }
  return fbm2(x * 0.011 + _groveX, z * 0.011 + _groveZ, 3);
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
 */
const _ch = { meadow: 0, bramble: 0, litter: 0, damp: 0, flower: 0, canopy: 0, wet: 0 };

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
 * TWO FIELDS AT DIFFERENT SCALES, AND THEY MUST NOT SHARE A LATTICE. `a` is the
 * grain of the ground — dry and open at one end, rank and shaded at the other —
 * and `b` is how vigorous the growth is. Sampling both from the same offsets
 * would correlate them, and then every meadow would also be a flower meadow and
 * every thicket would also be needle litter, which is one biome with two names.
 * Different frequencies AND different offsets is the same rule `terrain.js`
 * applies to its region amplitudes, for the same reason.
 *
 * The weights are deliberately competitive rather than independent: `bramble`
 * is multiplied by `1 - meadow`, `meadow` by `1 - damp`, and `litter` reads the
 * OPPOSITE end of `a` from `meadow`. Independent weights produce a place that
 * is 40% meadow and 40% thicket and 40% litter, which on the ground is a mess
 * with no character at all — the eye reads mixture as noise. Making them
 * exclude one another is what lets a region commit to being one thing.
 */
export function character(x, z, out = _ch) {
  const o = offsets();
  // ~80 m per feature: you cross one in about a minute of walking.
  const a = fbm2(x * 0.0125 + o.ax, z * 0.0125 + o.az, 3) * 0.5 + 0.5;
  // ~110 m, and offset a long way off `a`'s lattice.
  const b = fbm2(x * 0.0091 + o.bx, z * 0.0091 + o.bz, 2) * 0.5 + 0.5;
  const canopy = forestDensity(x, z);
  const wet = wetness(x, z);

  out.canopy = canopy;
  out.wet = wet;
  // The damp ground is the stream's flood plain, not the stream: `wetness`
  // reaches 1 in the channel itself, and 0.28 is roughly the top of the bank.
  out.damp = smoothstep(clamp01((wet - 0.26) / 0.42));

  /**
   * MEADOW WANTS LIGHT. `1 - canopy * 1.22` is near zero under a closed canopy
   * and near one in a glade, which is not a stylistic choice — long grass is
   * what grows where the trees are not, and putting a hay meadow under a dense
   * stand of pine is the kind of detail that reads as wrong without the viewer
   * being able to say why.
   *
   *
   * IT WAS 1.45 AND THAT PUT THE MEADOW OUT OF REACH OF THE PLAYER.
   *
   * The complaint was "I don't see any tall grass", and this coefficient is one
   * of the three reasons — the one that decides not how tall the grass is but
   * whether there is any. At 1.45 the term is zero above a canopy of 0.69, and
   * this wood runs at a MEAN canopy of 0.586 with 72–76% of its ground above
   * 0.5: the term was 0.15 at the average point in the forest, so meadow was
   * 30% of the authored understorey and 1–8% of the streamed one. Counted
   * within 40 m of the player on the shipped build: 626 clumps at spawn, 321 at
   * 200 m, and ZERO at both 700 m and 1500 m. A player who walks a kilometre in
   * a straight line and meets no long grass is right to say there is none.
   *
   * 1.22 moves the cut-off from canopy 0.69 to 0.82 and roughly doubles the
   * term at the mean, which is the difference between "meadow lives in glades"
   * and "meadow lives in glades and anywhere the canopy is broken" — the second
   * being both truer of a real wood and the thing that makes it findable.
   * Measured over a 3 km box on a 24 m tile grid: the fraction of tiles that
   * grow any meadow at all goes from 38% to 54%.
   *
   * IT IS NOT A DENSITY CHANGE. Widening the biome and then leaving the
   * acceptance alone would have added instances, which is the opposite of what
   * that pass was for; the meadow's spacing went from 0.9 m to 1.8 m in the same
   * change and its acceptance lost its floor, for a net cut over MORE of the
   * world.
   *
   * WHAT ELSE MOVES. `out.bramble` reads `1 - meadow * 0.9`, so a wider meadow
   * is a slightly narrower thicket, which is the exclusion working as designed.
   * Nothing else reads `meadow`, and in particular `litter` does not — which
   * matters because the sward's acceptance is gated on `1 - litter * 0.8`, so
   * changing this line cannot move a blade of it.
   */
  out.meadow =
    clamp01(1 - canopy * 1.22) *
    smoothstep(clamp01((a - 0.44) / 0.22)) *
    (1 - out.damp);

  /**
   * BRAMBLE WANTS THE EDGE. Not the deep shade and not the open glade, but the
   * broken canopy in between, which is where a thicket actually forms — so the
   * canopy term is a band rather than a ramp. Excluded from the meadow so the
   * two do not interleave into scrub.
   */
  const edge = 1 - Math.abs(canopy - 0.52) * 2.6;
  out.bramble =
    clamp01(edge) * smoothstep(clamp01((b - 0.5) / 0.2)) * (1 - out.damp) * (1 - out.meadow * 0.9);

  /**
   * LITTER IS THE ABSENCE. The far end of `a` from the meadow, under a closed
   * canopy: dry ground, deep shade, and nothing growing on it. Every layer that
   * can be suppressed tests `1 - litter` somewhere — the sward included, as of
   * the streaming pass — so raising this weight is how a region gets emptied.
   */
  out.litter = smoothstep(clamp01((0.44 - a) / 0.2)) * clamp01(canopy * 1.35) * (1 - out.damp);

  /**
   * FLOWERS ARE A SEPARATE ROLL, not a property of the meadow.
   *
   * Tying them to the meadow weight makes every meadow a flower meadow, and
   * then the flowers stop being a thing you come across. Keyed to `b` LOW where
   * bramble is keyed to `b` high, so a region is either flowery or rank, and
   * both of those are found in the same open ground.
   *
   * Keyed to `b` only, and NOT also to `a`. Three conditions at once is one
   * condition too many: gating on open ground AND low `b` AND high `a` left
   * flowers on 0.9% of the disc and produced 334 of them in the whole world,
   * which is not a wildflower patch, it is a rounding error. Two fields is
   * enough to make a region mean something.
   */
  out.flower = clamp01(1 - canopy * 0.8) * smoothstep(clamp01((0.56 - b) / 0.3)) * (1 - out.damp * 0.8);

  return out;
}

/**
 * The five hues a wildflower patch can be.
 *
 * Named rather than inlined because the flower texture is drawn almost white so
 * that the instance colour decides whether a patch is buttercup, campion,
 * harebell, poppy or bluebell — the palette is the layer's whole identity and
 * it should be findable from the top of the file rather than buried in the
 * middle of a scatter rule.
 */
export const FLOWER_HUES = [0.14, 0.92, 0.62, 0.1, 0.78];

/** How much forest wants to be at this point, 0..1. */
export function forestDensity(x, z) {
  const d = Math.hypot(x, z);
  // Groves and glades.
  let k = grove(x, z) * 0.55 + 0.62;
  // The clearing is a hole in the field, with a soft rim so the edge of the
  // wood is ragged rather than a circle drawn on the ground.
  k *= smoothstep(clamp01((d - CLEARING_RADIUS) / 7));
  // Nothing grows in the stream.
  k *= 1 - clamp01(wetness(x, z) * 1.6);
  // Nothing grows on a cliff.
  k *= 1 - clamp01(slopeAt(x, z) * 2.4);
  // A dense band around the clearing, so the space you spawn in feels enclosed.
  k *= 1 + 1.1 * Math.exp(-Math.pow((d - CLEARING_RADIUS - 6) / 10, 2));
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
   * two. The spawn clearing is a hole because you have to be able to see where
   * you are; a cave mouth is a hole because the one feature that must be legible
   * from a distance was the one thing being screened. A gathering place is a hole
   * because a fourteen-metre screen with four oaks in front of it is not a
   * cinema, and a ring of benches you cannot walk between is not somewhere to sit
   * down.
   *
   * It is worse than it sounds without this, and in a way that is worth writing
   * down: the site chooser looks for the FLATTEST ground within 185 m, and this
   * very function scales density by `1 - slope * 2.4`. So "the best place to put
   * a clearing" and "the place the forest most wants to be" are the same
   * question with the same answer, and a build that skipped this step planted
   * every single site it had just chosen. The photographs were unambiguous.
   *
   * `siteClearance` reads the same table `gathering.js` builds the props from —
   * hence it living in `sites.js`, which is the one module both a worker and the
   * main thread can import — so the hole and the thing standing in it cannot
   * drift apart.
   */
  k *= 1 - siteClearance(x, z);
  return clamp01(k);
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
 * Which species wants this spot.
 *
 * Conifers take the high ground, willows hug the water, birch likes the light
 * near the clearing edge. Written as a function of (altitude, wetness, roll)
 * rather than inline in `treeSector` because the argument order of the tests is
 * load-bearing — `roll` is one draw, compared against five thresholds in
 * sequence — and that is the kind of thing that gets "tidied" into five draws
 * by somebody who does not realise it reseeds the wood.
 *
 *
 * THE ROWAN IS KEYED TO LIGHT, AND `density` COSTS NOTHING TO PASS.
 *
 * It is the only species here that reads the canopy field, and there are two
 * reasons, one ecological and one about where a flowering tree is worth putting.
 *
 * A rowan is a pioneer. It comes up on the edge of a glade, in a gap, along a
 * ride — anywhere the canopy is broken — and it does not grow under a closed
 * one, so a flat share of the wood would have put white blossom in the darkest
 * places in it. And a tree in flower is worth the paint only where it can be
 * seen: gating on light puts every rowan at the edge of an opening, with sky
 * behind it, which is the one place in this forest where a pale crown reads at
 * thirty metres instead of dissolving into the green.
 *
 * `density` is `forestDensity(x, z)`, which `treeSector` has ALREADY computed
 * for its rejection test one line earlier, so this is a free argument rather
 * than a fifth field evaluation. No extra `rng()` is drawn — the roll is still
 * one draw against a ladder of thresholds — so the world stays a pure function
 * of its seed and the draw ORDER is untouched.
 *
 * THE SHARE WAS TUNED BY COUNTING, and the first guess was half of what it
 * needed to be. Oak gives up 0.42..0.62 of the roll wherever the canopy is under
 * 0.70. At the first values — under 0.62 canopy and 0.42..0.58 of the roll — the
 * rowan came out at 5.1% of 15 084 trees over a 640 m box, which sounds like a
 * tenth of the wood and is not: trees are placed BY rejection against the same
 * density field, so the trees that exist are already weighted toward the dense
 * places, and a threshold that covers 40% of the ground covers far less than
 * 40% of the trees standing on it. At 0.70 / 0.62 it measures 10.3% — 1551 of
 * 15 084 — against oak's 18.5%, birch's 33.1% and pine's 38.0%.
 *
 * Two thirds of those carry flower (archetypes 0 and 2), so about one tree in
 * fifteen in the whole wood is in blossom, concentrated where the canopy opens.
 * From inside a thicket you see none, from the edge of a glade you see three.
 * That is the distribution the species should have and it is also the one that
 * makes the blossom worth having: a flowering tree everywhere is wallpaper.
 */
export function speciesAt(y, wet, roll, density = 1) {
  const alt = clamp01((y + 6) / 40);
  if (wet > 0.32 && roll < 0.75) return 'willow';
  if (alt > 0.5 && roll < 0.78) return 'pine';
  if (roll < 0.42) return 'birch';
  if (density < 0.7 && roll < 0.62) return 'rowan';
  return roll < 0.78 ? 'oak' : 'pine';
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
export function treeSector({ seed, sx, sz, size, archetypes, bounds, tints }) {
  const rng = makeRng(`${seed}:tree:${sx}:${sz}`);
  const ox = sx * size;
  const oz = sz * size;
  const spacing = 4.0;
  const steps = Math.round(size / spacing);

  const layers = new Map();
  const collide = [];

  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      const x = ox + (i + rng()) * spacing;
      const z = oz + (j + rng()) * spacing;
      const density = forestDensity(x, z);
      if (rng() > density) continue;
      if (submerged(x, z)) continue;
      const y = heightAt(x, z);
      const name = speciesAt(y, wetness(x, z), rng(), density);
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
      const scale = rngRange(rng, 0.5, 1.48);
      const yaw = rng() * TAU;

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
      _tint.setHex(0xffffff).offsetHSL(0, 0, rngRange(rng, -0.13, 0.06));

      const base = y - 0.25;
      yawMatrix(_mat, x, base, z, yaw, scale, scale, scale);

      const trunkId = `trunk:${name}:${a}`;
      const leafId = `leaf:${name}:${a}`;
      let trunk = layers.get(trunkId);
      if (!trunk) layers.set(trunkId, (trunk = new Layer(trunkId)));
      let leaf = layers.get(leafId);
      if (!leaf) layers.set(leafId, (leaf = new Layer(leafId)));

      const tb = bounds[trunkId];
      const lb2 = bounds[leafId];
      _col[0] = _tint.r;
      _col[1] = _tint.g;
      _col[2] = _tint.b;
      push(trunk, _mat, _col, x, base + tb.cy * scale, z, tb.r * scale);
      _col[0] = lr;
      _col[1] = lg;
      _col[2] = lb;
      push(leaf, _mat, _col, x, base + lb2.cy * scale, z, lb2.r * scale);

      collide.push(x, z, 0.28 * scale + 0.34);
    }
  }
  return { layers, collide, rustle: [], patches: [], glow: [] };
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

  // ---- grass --------------------------------------------------------------
  {
    const spacing = 0.6;
    const steps = Math.round(size / spacing);
    const bound = bounds.grass;
    const l = layer('grass');
    for (let j = 0; j < steps; j++) {
      for (let i = 0; i < steps; i++) {
        const x = ox + (i + rng()) * spacing;
        const z = oz + (j + rng()) * spacing;
        if (slopeAt(x, z) > 0.46) continue;
        if (submerged(x, z)) continue;
        const patch = fbm2(x * 0.06 + 3, z * 0.06 + 12, 2) * 0.5 + 0.62;
        /**
         * ONE ACCEPTANCE, NO DISTANCE TERM AT ALL, and that is the change.
         *
         * There were two of them and both were about the origin. The authored
         * sward thinned with `near = 1 - d/96` and then stopped dead at 72 m,
         * and this one ramped back up from 0.35 over the 50 m past the
         * protected radius so the two would meet without a step. Between them
         * they made the ground round the spawn point the thinnest in the world:
         * 0.31 cover instances per m² at 80–100 m against 1.97 out at 700 m,
         * where only this sampler had ever run.
         *
         * The ramp's own argument was sound and is simply spent. It existed
         * because the sward "has to begin SOMEWHERE, and a step from bare
         * ground to 0.95 acceptance on a circle centred on the spawn point is
         * the most conspicuous shape a boundary can have". It does not begin
         * anywhere now. There is no circle to soften.
         *
         * THE SWARD READS THE BIOME, which is the one factor here that is not a
         * constant: under a closed dry canopy every other weight collapses, so
         * the ground gets sticks and leaf drift and NOTHING ELSE — and until
         * this factor existed, short grass grew there anyway and no biome could
         * ever go properly bald. Emptiness is variety, and it renders free.
         */
        if (rng() > patch * (1 - character(x, z).litter * 0.8)) continue;
        const y = heightAt(x, z);
        const gx = rngRange(rng, 0.7, 1.5);
        const gy = rngRange(rng, 0.6, 1.7);
        const gz = rngRange(rng, 0.7, 1.5);
        yawMatrix(_mat, x, y - 0.04, z, rng() * TAU, gx, gy, gz);
        _tint.setHSL(
          0.22 + rngRange(rng, -0.035, 0.045),
          rngRange(rng, 0.26, 0.48),
          rngRange(rng, 0.46, 0.72)
        );
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        const grow = Math.max(gx, gy, gz);
        push(l, _mat, _col, x, y - 0.04 + bound.cy * grow, z, bound.r * grow);
      }
    }
  }

  // ---- ferns --------------------------------------------------------------
  {
    const spacing = 2.2;
    const steps = Math.round(size / spacing);
    const bound = bounds.ferns;
    const l = layer('ferns');
    for (let j = 0; j < steps; j++) {
      for (let i = 0; i < steps; i++) {
        const x = ox + (i + rng()) * spacing;
        const z = oz + (j + rng()) * spacing;
        if (slopeAt(x, z) > 0.5) continue;
        if (submerged(x, z)) continue;
        const shade = forestDensity(x, z);
        const damp = clamp01(wetness(x, z) * 1.2 + 0.25);
        // No radial fade and no radial cut-off: a fern grows where there is
        // shade and damp, at 20 m and at 20 km, and nowhere else.
        if (rng() > shade * 0.7 + damp * 0.35) continue;
        const y = heightAt(x, z);
        const grow = rngRange(rng, 0.62, 1.5);
        yawMatrix(_mat, x, y - 0.06, z, rng() * TAU, grow, grow, grow);
        _tint.setHSL(
          0.26 + rngRange(rng, -0.05, 0.035),
          rngRange(rng, 0.22, 0.42),
          rngRange(rng, 0.5, 0.74)
        );
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        push(l, _mat, _col, x, y - 0.06 + bound.cy * grow, z, bound.r * grow);
      }
    }
  }

  // ---- rocks --------------------------------------------------------------
  {
    for (let gi = 0; gi < rockSizes; gi++) {
      const spacing = 9 + gi * 5;
      const steps = Math.round(size / spacing);
      const id = `rocks:${gi}`;
      const bound = bounds[id];
      const l = layer(id);
      for (let j = 0; j < steps; j++) {
        for (let i = 0; i < steps; i++) {
          const x = ox + (i + rng()) * spacing;
          const z = oz + (j + rng()) * spacing;
          const slope = slopeAt(x, z);
          const wet = wetness(x, z);
          if (rng() > 0.1 + slope * 0.85 + wet * 0.45) continue;
          const y = heightAt(x, z);
          const grow = rngRange(rng, 0.6, 1.5);
          tiltMatrix(
            _mat,
            x,
            y - 0.2 - gi * 0.1,
            z,
            rngRange(rng, -0.3, 0.3),
            rng() * TAU,
            rngRange(rng, -0.3, 0.3),
            grow,
            grow,
            grow
          );
          _tint.setHSL(0.1, rngRange(rng, 0.02, 0.1), rngRange(rng, 0.44, 0.68));
          _col[0] = _tint.r;
          _col[1] = _tint.g;
          _col[2] = _tint.b;
          push(l, _mat, _col, x, y - 0.2 - gi * 0.1 + bound.cy * grow, z, bound.r * grow);
          if (gi === rockSizes - 1) collide.push(x, z, 1.5);
        }
      }
    }
  }

  // ---- fallen wood --------------------------------------------------------
  {
    const spacing = 16;
    const steps = Math.round(size / spacing);
    const bound = bounds.logs;
    const l = layer('logs');
    for (let j = 0; j < steps; j++) {
      for (let i = 0; i < steps; i++) {
        const x = ox + (i + rng()) * spacing;
        const z = oz + (j + rng()) * spacing;
        if (slopeAt(x, z) > 0.3) continue;
        if (submerged(x, z)) continue;
        if (rng() > forestDensity(x, z) * 0.7 + 0.05) continue;
        const y = heightAt(x, z);
        const gx = rngRange(rng, 0.7, 1.3);
        const gy = rngRange(rng, 0.8, 1.2);
        const gz = rngRange(rng, 0.8, 1.2);
        tiltMatrix(
          _mat,
          x,
          y + 0.26,
          z,
          rngRange(rng, -0.12, 0.12),
          rng() * TAU,
          rngRange(rng, -0.08, 0.08),
          gx,
          gy,
          gz
        );
        _tint.setHSL(0.09, rngRange(rng, 0.1, 0.24), rngRange(rng, 0.26, 0.42));
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        const grow = Math.max(gx, gy, gz);
        push(l, _mat, _col, x, y + 0.26 + bound.cy * grow, z, bound.r * grow);
        collide.push(x, z, 1.1);
      }
    }
  }

  // ---- mushrooms ----------------------------------------------------------
  /**
   * A reason to keep walking.
   *
   * The authored world puts fifteen patches inside 114 m and one of them right
   * at the edge of the glade, on the argument that a player who searches for
   * four minutes and finds nothing concludes there is nothing to find. That
   * argument does not stop at 114 m. An endless forest with all its mushrooms
   * in the first two hundred metres is an endless forest with nothing in it,
   * and the mushrooms are the only thing out there that rewards going anywhere.
   *
   * The density is copied from the authored world rather than picked: fifteen
   * patches inside 114 m is one per 2720 m², so a 32 m sector wants one patch
   * 38% of the time. Getting this wrong is worse in the generous direction —
   * one patch per sector measured at 62 of them inside the ring, which is a
   * mushroom every twenty metres, and a thing you trip over on the way
   * somewhere else is not a thing you find.
   *
   * THE FIRST PATCH IS NO LONGER GUARANTEED TO BE NEAR THE GLADE, and that is
   * the one thing this rule lost when the authored scatter went. That scatter
   * placed patch zero at 17–23 m from the origin deliberately, "because a
   * player who walks for four minutes without finding the thing the world is
   * named after concludes there is nothing to find". The same density arrived
   * at from the other end says roughly the same thing without promising it:
   * five sectors of ground lie inside 40 m of the spawn point, so the chance of
   * meeting nothing within a forty-metre stroll is 0.62⁵ ≈ 9%. Counted on the
   * resident ring at the spawn point, `forest.patches` holds a dozen or more.
   *
   * Re-adding the guarantee would mean a distance-from-origin special case in
   * the one file whose whole argument is now that there are none, to buy a
   * one-in-eleven case where the player walks eighty metres instead of forty.
   * It is not worth the exception; if it ever turns out to be, the honest fix
   * is to raise the density everywhere rather than to bless the origin.
   */
  {
    const stems = layer('shroom-stem');
    const caps = layer('shroom-cap');
    const stemBound = bounds['shroom-stem'];
    const capBound = bounds['shroom-cap'];
    const wanted = rng() < 0.38 ? 1 : 0;
    for (let p = 0; p < wanted; p++) {
      let px = 0;
      let pz = 0;
      let ok = false;
      for (let attempt = 0; attempt < 24; attempt++) {
        px = ox + rng() * size;
        pz = oz + rng() * size;
        if (!submerged(px, pz) && slopeAt(px, pz) < 0.34) {
          ok = true;
          break;
        }
      }
      if (!ok) continue;
      const n = 3 + Math.floor(rng() * 5);
      patches.push(px, groundUnder(px, pz), pz);
      for (let i = 0; i < n; i++) {
        const a = rng() * TAU;
        const r = Math.pow(rng(), 0.6) * 1.5;
        const x = px + Math.cos(a) * r;
        const z = pz + Math.sin(a) * r;
        const y = groundUnder(x, z);
        const grow = rngRange(rng, 0.75, 1.7);
        tiltMatrix(
          _mat,
          x,
          y - 0.03,
          z,
          rngRange(rng, -0.16, 0.16),
          rng() * TAU,
          rngRange(rng, -0.16, 0.16),
          grow,
          grow,
          grow
        );
        push(stems, _mat, null, x, y - 0.03 + stemBound.cy * grow, z, stemBound.r * grow);
        _tint.setHSL(rngRange(rng, 0.72, 0.88), rngRange(rng, 0.3, 0.62), rngRange(rng, 0.34, 0.56));
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        push(caps, _mat, _col, x, y - 0.03 + capBound.cy * grow, z, capBound.r * grow);
        glow.push(x, y + 0.24, z);
      }
    }
  }

  // ---- the understorey ----------------------------------------------------
  /**
   * THE NINE UNDERSTOREY LAYERS — every square metre of the world, including
   * the one you are standing on when the gate lifts.
   *
   * These used to exist twice: once here, and once as an eager scatter in
   * forest.js covering a disc of 118–163 m around the origin, with this half
   * forbidden to place anything inside 163.4 m. What that bought was a bald
   * annulus, because the five tall layers' authored discs stopped between 118
   * and 140 m and this half could not start until 163.4 — 23 to 51 m of ground
   * that neither sampler planted, wide enough to stand in and look along.
   *
   * There is one sampler now and it starts at r = 0. See the file header for
   * the measurements that decided it, and note the shape of the answer: the
   * annulus was not patched, it was made impossible to express.
   *
   *
   * WHY THESE RIDE THE 32 m UNDERGROWTH GRID AND NOT THE 128 m TREE GRID.
   *
   * Because they are undergrowth. An 80 m ring reaching ~112 m with the sector
   * overshoot is past where a 0.42 m grass clump is three pixels tall at 1440p,
   * the eviction and collider plumbing already exists, and putting them on the
   * tree grid would generate bushes out to 565 m at a density nobody could
   * resolve through the fog. The price is that they arrive and leave four times
   * as often as a tree sector does, which is the shape the frame prefers — see
   * the note on UNDER_SECTOR in forest-field.js.
   *
   * That reach is now what the SPAWN POINT gets too, where it used to get an
   * authored disc reaching 118–163 m, and the trade is the right way round:
   * measured cover per square metre at the spawn point goes from 0.31 to
   * roughly 2.0 over 80–100 m and from 0.28 to 0.21 over 100–120, i.e. the band
   * a player can actually resolve gets six times the planting and the band
   * behind the fog loses a quarter of almost nothing.
   */
  {
    /**
     * One understorey layer's grid over this sector.
     *
     * THE LATTICE TILES THE SECTOR EXACTLY AND THE DENSITY IS CORRECTED FOR IT.
     *
     * `steps = round(size / spacing)` on its own is what every layer above
     * does, and it is quietly wrong by up to a quarter at these spacings: the
     * stumps want 20 m in a 32 m sector, which rounds to two steps of 20 m and
     * lays candidates out to 40 m — a fifth of every stump placed in the
     * neighbour's ground, and 56% too many of them. Rocks have the same problem
     * in both directions and have always had it; it is survivable there because
     * a rock is rare and unremarkable, and it is not survivable for a layer the
     * player is standing in.
     *
     * So the step is `size / steps`, which tiles the sector exactly, and the
     * acceptance is multiplied by `(step / spacing)²` to put the expected
     * instances per square metre back on the tuned figure — fewer, bigger
     * cells accept proportionally harder. Stumps come out at 2 steps of 16 m
     * and 0.64× acceptance, which is the density the layer was tuned at to the
     * last decimal rather than to the nearest rounding.
     *
     * `p` handed to the body is that correction and nothing else now — the
     * radial seam fade it used to carry went with the seam — so a body reads
     * `if (rng() > <the layer's own probability> * p) continue` and the
     * probability is textually the tuned one.
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
          body(ox + (i + rng()) * step, oz + (j + rng()) * step, l, bound, dens);
        }
      }
    };

    /**
     * A note on test ORDER.
     *
     * The cheap rejections come first: `slopeAt` and `wetness` before
     * `character`, and `character` before `heightAt`. `character` is two fbms,
     * a `forestDensity` and a `wetness`, and it is called for every candidate
     * that gets past the slope test — about ninety thousand of them per sector
     * across the nine layers — so the ordering is worth real time. Reordering
     * pure predicates cannot change the acceptance PROBABILITY, only which
     * draws are taken, and since the whole sector comes off one seeded stream
     * that is a change to the world: do not shuffle these without expecting
     * `authored-check`'s cross-seed comparison to notice.
     */

    // ---- meadow -----------------------------------------------------------
    underLayer('meadow', 1.3, (x, z, l, bound, p) => {
      if (slopeAt(x, z) > 0.42) return;
      const c = character(x, z);
      if (c.meadow < 0.07) return;
      const m = c.meadow;
      /**
       * A 12 m gathering field, so the meadow is drifts with worn ground
       * between them rather than an even sprinkle — the eye reads an even
       * sprinkle as a lawn ornament, and the whole point of long grass is that
       * some of it is over your head and some of it is not there.
       */
      const drift = clamp01((fbm2(x * 0.085 + 17, z * 0.085 - 41, 2) * 0.5 + 0.5) * 2.4 - 0.62);
      /**
       * A SMALL BALD DISC WHERE THE PLAYER'S BOOTS ARE, and it is the one
       * distance-from-origin term left in the understorey.
       *
       * It is a world feature and not bookkeeping. The spawn clearing is a hole
       * in `forestDensity`, so the canopy term that gates this layer is at its
       * MAXIMUM there — the glade you start in is the single most meadow-y place
       * in the world, and without this the first frame of the game is a wall of
       * chest-high hay a metre from your face and a jukebox buried to its dial.
       * 4.5 m of nothing ramping to full over the next 5.5 m: you start standing
       * on short ground with the drifts five metres away, which is the whole
       * request. The drift field does the rest — the bare ground between drifts
       * inside the glade IS the path.
       *
       * It multiplies the DENSITY only. `m` reaches the height term untouched,
       * so the drifts you can see from the spawn point are full height.
       *
       * This lived in the authored scatter in forest.js and had to come with it
       * when that went. Everywhere except the glade it is identically 1, which
       * is why it is safe to have a radius here at all: it is 10 m wide, not
       * 163.
       */
      const feet = smoothstep(clamp01((Math.hypot(x, z) - 4.5) / 5.5));
      if (rng() > clamp01(m * 3.2 - 0.3) * drift * feet * p) return;
      if (submerged(x, z)) return;
      const y = heightAt(x, z);
      const gx = rngRange(rng, 0.85, 1.3);
      const gz = rngRange(rng, 0.85, 1.3);
      // Height tracks the biome weight, so a meadow is deepest in its middle
      // and shortens toward the trees instead of ending in a wall of hay. On
      // the 1.95 m card 0.62 at the gate is 1.09–1.45 m after the jitter, which
      // is waist to chest, and the deepest drift in the world is 2.4 m.
      const tall = (0.62 + m * 0.46) * rngRange(rng, 0.86, 1.14);
      yawMatrix(_mat, x, y - 0.05, z, rng() * TAU, gx, tall, gz);
      _tint.setHSL(
        0.19 + rngRange(rng, -0.028, 0.05),
        rngRange(rng, 0.24, 0.46),
        rngRange(rng, 0.44, 0.72)
      );
      _col[0] = _tint.r;
      _col[1] = _tint.g;
      _col[2] = _tint.b;
      const grow = Math.max(gx, tall, gz);
      push(l, _mat, _col, x, y - 0.05 + bound.cy * grow, z, bound.r * grow);
    });

    // ---- bramble ----------------------------------------------------------
    underLayer('bramble', 2.5, (x, z, l, bound, p) => {
      if (slopeAt(x, z) > 0.46) return;
      const c = character(x, z);
      if (c.bramble < 0.12) return;
      if (rng() > c.bramble * 1.05 * p) return;
      if (submerged(x, z)) return;
      const y = heightAt(x, z);
      const g = rngRange(rng, 0.7, 1.45);
      const gy = g * rngRange(rng, 0.75, 1.25);
      yawMatrix(_mat, x, y - 0.08, z, rng() * TAU, g, gy, g);
      _tint.setHSL(
        0.27 + rngRange(rng, -0.05, 0.03),
        rngRange(rng, 0.18, 0.36),
        rngRange(rng, 0.5, 0.74)
      );
      _col[0] = _tint.r;
      _col[1] = _tint.g;
      _col[2] = _tint.b;
      const grow = Math.max(g, gy);
      push(l, _mat, _col, x, y - 0.08 + bound.cy * grow, z, bound.r * grow);
    });

    // ---- bushes -----------------------------------------------------------
    underLayer('bushes', 5.4, (x, z, l, bound, p) => {
      if (slopeAt(x, z) > 0.44) return;
      const c = character(x, z);
      // Bushes are the generalist: they grow anywhere the ground is not bare
      // needle litter and not standing water, and they thicken on the edge.
      const want = (1 - c.litter * 0.9) * (0.14 + (1 - Math.abs(c.canopy - 0.55) * 1.6) * 0.5);
      if (rng() > want * p) return;
      if (submerged(x, z)) return;
      const y = heightAt(x, z);
      // One size with a small wobble on each axis, not three independent
      // ranges: three independent draws can produce a bush 1.5 wide and 0.7
      // high, which is the flat rosette the geometry spent two attempts getting
      // rid of, reintroduced by the instance matrix on one bush in twenty.
      // `gx` is what `bushCue` sees.
      const g = rngRange(rng, 0.62, 1.5);
      const gx = g * rngRange(rng, 0.9, 1.12);
      const gy = g * rngRange(rng, 0.88, 1.14);
      const gz = g * rngRange(rng, 0.9, 1.12);
      yawMatrix(_mat, x, y - 0.05, z, rng() * TAU, gx, gy, gz);
      _tint.setHSL(
        0.24 + rngRange(rng, -0.045, 0.04),
        rngRange(rng, 0.2, 0.42),
        rngRange(rng, 0.5, 0.78)
      );
      _col[0] = _tint.r;
      _col[1] = _tint.g;
      _col[2] = _tint.b;
      const grow = Math.max(gx, gy, gz);
      push(l, _mat, _col, x, y - 0.05 + bound.cy * grow, z, bound.r * grow);
      // Roughly the top third by width earns a rustle; the rest is scenery,
      // and `bushCue` returns 0 for those. The threshold and the radius live
      // up at the top of this file so that a shrub worth noticing and a shrub
      // that is just leaves are one decision. This goes to `rustle`, not
      // `collide` — bushes no longer block the body, see `bushCue`.
      const cue = bushCue(gx);
      if (cue) rustle.push(x, z, cue);
    });

    // ---- saplings ---------------------------------------------------------
    underLayer('saplings', 7.2, (x, z, l, bound, p) => {
      if (slopeAt(x, z) > 0.4) return;
      const c = character(x, z);
      // Seedlings come up where there is light AND a seed source: the edge of a
      // glade rather than its middle, which is `canopy` in a band again.
      if (rng() > (1 - c.litter * 0.8) * (0.1 + c.canopy * 0.42) * p) return;
      if (submerged(x, z)) return;
      const y = heightAt(x, z);
      const g = rngRange(rng, 0.5, 1.35);
      const gy = g * rngRange(rng, 0.85, 1.3);
      yawMatrix(_mat, x, y - 0.05, z, rng() * TAU, g, gy, g);
      _tint.setHSL(
        0.25 + rngRange(rng, -0.04, 0.045),
        rngRange(rng, 0.24, 0.44),
        rngRange(rng, 0.5, 0.78)
      );
      _col[0] = _tint.r;
      _col[1] = _tint.g;
      _col[2] = _tint.b;
      const grow = Math.max(g, gy);
      push(l, _mat, _col, x, y - 0.05 + bound.cy * grow, z, bound.r * grow);
    });

    // ---- sticks -----------------------------------------------------------
    underLayer('sticks', 3.0, (x, z, l, bound, p) => {
      if (slopeAt(x, z) > 0.5) return;
      const c = character(x, z);
      if (rng() > (0.1 + c.canopy * 0.42 + c.damp * 0.3 + c.litter * 0.22) * p) return;
      if (submerged(x, z)) return;
      const y = heightAt(x, z);
      // One geometry, length varied by the instance: 0.35 to 1.8 turns a single
      // 1.7 m stick into everything from a twig to a three-metre fallen bough.
      // Named rather than `sx`/`sz`, which are this function's SECTOR
      // coordinates.
      const long = rngRange(rng, 0.35, 1.8);
      const thickY = rngRange(rng, 0.7, 1.35);
      const thickZ = rngRange(rng, 0.7, 1.35);
      // Lying down, and only just: a couple of degrees of pitch and roll is
      // what keeps a field of these from looking like a printed pattern.
      tiltMatrix(
        _mat,
        x,
        y + 0.03,
        z,
        rngRange(rng, -0.14, 0.14),
        rng() * TAU,
        rngRange(rng, -0.1, 0.1),
        long,
        thickY,
        thickZ
      );
      _tint.setHSL(
        0.07 + rngRange(rng, -0.02, 0.02),
        rngRange(rng, 0.03, 0.17),
        rngRange(rng, 0.4, 0.85)
      );
      _col[0] = _tint.r;
      _col[1] = _tint.g;
      _col[2] = _tint.b;
      const grow = Math.max(long, thickY, thickZ);
      push(l, _mat, _col, x, y + 0.03 + bound.cy * grow, z, bound.r * grow);
    });

    // ---- wildflowers ------------------------------------------------------
    underLayer('flowers', 1.8, (x, z, l, bound, p) => {
      const c = character(x, z);
      if (c.flower < 0.12) return;
      // A 1.8 m field gathers them into clumps, because flowers grow in clumps
      // and an even sprinkle of them reads as confetti.
      const clump = fbm2(x * 0.55 + 91, z * 0.55 - 33, 2) * 0.5 + 0.5;
      if (rng() > c.flower * clump * clump * 1.45 * p) return;
      if (slopeAt(x, z) > 0.42) return;
      if (submerged(x, z)) return;
      const y = heightAt(x, z);
      // An 11 m field picks the HUE, so a whole patch is buttercup yellow and
      // the next one along is campion pink.
      const hue = fbm2(x * 0.09 + 500, z * 0.09 - 220, 1) * 0.5 + 0.5;
      const h = FLOWER_HUES[Math.min(4, Math.floor(hue * 5))];
      const g = rngRange(rng, 0.7, 1.5);
      const gy = g * rngRange(rng, 0.8, 1.35);
      yawMatrix(_mat, x, y - 0.02, z, rng() * TAU, g, gy, g);
      _tint.setHSL(h + rngRange(rng, -0.02, 0.02), rngRange(rng, 0.22, 0.62), rngRange(rng, 0.6, 0.88));
      _col[0] = _tint.r;
      _col[1] = _tint.g;
      _col[2] = _tint.b;
      const grow = Math.max(g, gy);
      push(l, _mat, _col, x, y - 0.02 + bound.cy * grow, z, bound.r * grow);
    });

    // ---- leaf litter and moss ---------------------------------------------
    underLayer('litter', 3.5, (x, z, l, bound, p) => {
      if (slopeAt(x, z) > 0.4) return;
      const c = character(x, z);
      if (rng() > (c.litter * 0.85 + c.damp * 0.7 + c.canopy * 0.14) * p) return;
      if (submerged(x, z)) return;
      const y = heightAt(x, z);
      // `mx`/`mz`, not `sx`/`sz`: those are this function's sector coordinates.
      const mx = rngRange(rng, 0.7, 1.7);
      const my = rngRange(rng, 0.6, 1.3);
      const mz = rngRange(rng, 0.7, 1.7);
      tiltMatrix(
        _mat,
        x,
        y + 0.015,
        z,
        rngRange(rng, -0.06, 0.06),
        rng() * TAU,
        rngRange(rng, -0.06, 0.06),
        mx,
        my,
        mz
      );
      // Moss on the wet ground, dead leaves everywhere else — one card, two
      // materials of the world, and the difference is the instance colour.
      if (c.damp > 0.45) {
        _tint.setHSL(
          0.28 + rngRange(rng, -0.04, 0.03),
          rngRange(rng, 0.24, 0.48),
          rngRange(rng, 0.4, 0.64)
        );
      } else {
        _tint.setHSL(
          0.07 + rngRange(rng, -0.015, 0.025),
          rngRange(rng, 0.3, 0.55),
          rngRange(rng, 0.28, 0.48)
        );
      }
      _col[0] = _tint.r;
      _col[1] = _tint.g;
      _col[2] = _tint.b;
      const grow = Math.max(mx, my, mz);
      push(l, _mat, _col, x, y + 0.015 + bound.cy * grow, z, bound.r * grow);
    });

    // ---- reeds at the water -----------------------------------------------
    /**
     * The only layer keyed to the terrain rather than to the biome field,
     * because the stream is not a region — it is a line, and it runs across the
     * whole endless world. Testing wetness before
     * anything else is a real saving rather than fussiness: this grid used to
     * walk 1156 cells per sector to find the handful on the bank — 576 now, at
     * the wider spacing — and `wetness` is two sines where `heightAt` is a
     * dozen octaves of noise.
     */
    underLayer('reeds', 1.35, (x, z, l, bound, p) => {
      const wet = wetness(x, z);
      if (wet < 0.42) return;
      const y = heightAt(x, z);
      if (y < WATER_LEVEL - 0.55 || y > WATER_LEVEL + 1.7) return;
      // Thickest right at the waterline and thinning up the bank.
      const band = 1 - clamp01(Math.abs(y - WATER_LEVEL - 0.35) / 1.5);
      if (rng() > band * (0.3 + wet * 0.7) * p) return;
      const g = rngRange(rng, 0.68, 1.3);
      const gy = (0.62 + band * 0.5) * rngRange(rng, 0.85, 1.25);
      yawMatrix(_mat, x, y - 0.06, z, rng() * TAU, g, gy, g);
      _tint.setHSL(
        0.21 + rngRange(rng, -0.03, 0.05),
        rngRange(rng, 0.2, 0.44),
        rngRange(rng, 0.4, 0.7)
      );
      _col[0] = _tint.r;
      _col[1] = _tint.g;
      _col[2] = _tint.b;
      const grow = Math.max(g, gy);
      push(l, _mat, _col, x, y - 0.06 + bound.cy * grow, z, bound.r * grow);
    });

    // ---- stumps -----------------------------------------------------------
    underLayer('stumps', 20, (x, z, l, bound, p) => {
      if (slopeAt(x, z) > 0.3) return;
      if (submerged(x, z)) return;
      if (rng() > (forestDensity(x, z) * 0.55 + 0.06) * p) return;
      const y = heightAt(x, z);
      const g = rngRange(rng, 0.6, 1.6);
      const gy = g * rngRange(rng, 0.6, 1.5);
      tiltMatrix(
        _mat,
        x,
        y - 0.12,
        z,
        rngRange(rng, -0.1, 0.1),
        rng() * TAU,
        rngRange(rng, -0.1, 0.1),
        g,
        gy,
        g
      );
      _tint.setHSL(0.09, rngRange(rng, 0.08, 0.22), rngRange(rng, 0.3, 0.5));
      _col[0] = _tint.r;
      _col[1] = _tint.g;
      _col[2] = _tint.b;
      const grow = Math.max(g, gy);
      push(l, _mat, _col, x, y - 0.12 + bound.cy * grow, z, bound.r * grow);
      collide.push(x, z, stumpCollider(g));
    });
  }

  return { layers, collide, rustle, patches, glow };
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
