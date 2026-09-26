/**
 * THE RAINFOREST, as data.
 *
 * Everything in this file was welded into `scatter.js` and `terrain.js` until
 * the land layer existed, and every number in it is UNCHANGED — this is a move,
 * not a pass. The proof is a hash: `scripts/land-identity.mjs` runs nine tree
 * sectors and twenty-five understorey sectors of `grove-01` through the real
 * scatter and digests every matrix, tint, bounding sphere and collider it
 * produces. It reads 500308b1b1dc before this file existed and after it. If you
 * change a number here, that hash moves, and it is supposed to.
 *
 *
 * ==== WHAT IS A ROW AND WHAT IS A FUNCTION, AND WHY THE SPLIT IS WHERE IT IS
 *
 * The temptation with a job like this is to make everything a table of
 * coefficients, and it is the wrong answer twice over: a table that can express
 * this wood is a table with sixty fields nobody can hold in their head, and a
 * table that CANNOT express it quietly deletes whichever half of the argument
 * did not fit. So the split is by KIND rather than by tidiness:
 *
 *   A ROW where the shape of the rule is genuinely shared. Which species exist,
 *   which one wants a spot, the density product's seven terms, the ground
 *   palette, which streamed layers are built at all, each understorey layer's
 *   lattice spacing. Two lands really do want the same arithmetic here with
 *   different numbers in it.
 *
 *   A FUNCTION where the rule itself is the content. `character()` is the
 *   obvious one — its whole job is to decide what KINDS of place a land has,
 *   and a boreal wood's kinds are not this wood's with different thresholds,
 *   they are different kinds (see taiga.js). The twelve placement bodies are
 *   the same: each is three or four terms picked out of that land's weight
 *   vocabulary, and a schema general enough to express both would be a small
 *   programming language.
 *
 * WHAT KEEPS THE FUNCTIONS HONEST is that they are FACTORIES. Each is handed a
 * kit `K` of the terrain and scatter machinery once per sector and returns the
 * closure that runs per candidate, so the body reads with exactly the free
 * variable names it had inside `scatter.js` — `rng`, `heightAt`, `character`,
 * `_mat`, `push` — and the per-candidate cost is unchanged. That is not
 * cosmetic: it is what made this a copy rather than a rewrite, and it is why
 * the identity hash held on the first run.
 *
 *
 * ==== WHAT IS STILL WELDED, DELIBERATELY ==================================
 *
 *   THE SHARED PLUMBING in `underSector`: the lattice-tiling correction, the
 *   `caveClearance` pre-gate, the bucket packing, the seeded-stream ORDER. A
 *   land that wanted its own plumbing would be a land that reseeds the world,
 *   and the whole file is built on that stream being one stream in one order.
 *
 *   `trodden()`. Nine gathering places are a social feature, not a biome one;
 *   people stand round a fire in any weather.
 *
 *   `softFloor` in terrain.js, and therefore the fact that this world has one
 *   stream and no lakes and no cliffs. That is a hard architectural limit and
 *   no land may express its way out of it.
 *
 *   The two-field `a`/`b` lattice and its per-seed offsets. Every land so far
 *   wants exactly two decorrelated fields at ~80 m and ~110 m; a third is a
 *   third pair of hash taps on ninety thousand candidates a sector and the
 *   argument against it is in `character`'s own header.
 */

import { TAU, clamp01, rngRange, smoothstep } from '../../core/util.js';

/* ========================================================================== */
/* the roster                                                                 */
/* ========================================================================== */

/**
 * WHICH TREES EXIST HERE.
 *
 * Names into `SPECIES` in trees.js. `forest.js` grows three archetypes of each
 * of these and nothing else, so a land that names four species compiles four
 * bark tiles and twelve canopy canvases instead of five and fifteen.
 *
 * This list is exactly `SPECIES_NAMES` today and that is a coincidence of there
 * being one land. It is written out rather than defaulted to the whole table
 * because the moment a second land adds conifers to `SPECIES`, defaulting would
 * silently grow spruce in the Amazon.
 */
const ROSTER = ['palm', 'cecropia', 'kapok', 'fig', 'brownea'];

/**
 * Which species wants this spot. The `speciesAt` ladder, verbatim.
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
 *
 *
 * THE THRESHOLDS ARE UNCHANGED FROM THE TEMPERATE ROSTER, DELIBERATELY.
 *
 * `trees.js` swapped pine/birch/oak/willow/rowan for palm/cecropia/kapok/fig/
 * brownea by reshaping the five entries in place rather than adding to them —
 * see the roster block at the top of that file. This function is the reason
 * that was free: it still returns five labels off ONE roll against the same
 * ladder of numbers, so the draw stream is untouched, every trunk in the world
 * is bit-for-bit where it was, and the per-layer instance counts do not move.
 * Only the labels changed, and each new label was chosen for the old one whose
 * shape and habitat it already had:
 *
 *   wet ground        -> fig, where the willow stood. A strangler on a bank.
 *   high ground       -> palm, where the pine stood. It is 38% of the wood,
 *                        which is close to the real share of palm stems in
 *                        Amazonia and was not tuned to get there.
 *   the common tree   -> cecropia, where the birch stood. Pale trunk, pioneer.
 *   broken canopy     -> brownea, where the rowan stood. Small, in flower, in
 *                        a light gap — the whole of that block above still
 *                        applies word for word, including why it is keyed to
 *                        `density` and why the share had to be counted rather
 *                        than guessed.
 *   everything else   -> kapok, where the oak stood. The emergent.
 */
function speciesAt(y, wet, roll, density = 1) {
  const alt = clamp01((y + 6) / 40);
  if (wet > 0.32 && roll < 0.75) return 'fig';
  if (alt > 0.5 && roll < 0.78) return 'palm';
  if (roll < 0.42) return 'cecropia';
  if (density < 0.7 && roll < 0.62) return 'brownea';
  return roll < 0.78 ? 'kapok' : 'palm';
}

/* ========================================================================== */
/* how much forest wants to be here                                           */
/* ========================================================================== */

/**
 * The seven terms of `forestDensity`, as coefficients.
 *
 * The PRODUCT is welded in `scatter.js` and only the numbers are here, which is
 * the right way round: three of those terms are world FEATURES rather than
 * tuning — the clearing hole, the cave-mouth hole, the gathering-place hole —
 * and a land that could switch them off would be a land where the spawn glade
 * fills with trees or the arch is screened. Every land gets those. What a land
 * chooses is how coarse its stands are, how hard water and slope bite, and how
 * tight the ring of trees around the clearing is.
 *
 *   grove{Freq,Gain,Base,Octaves}  the ~90 m field of thicket and glade.
 *   clearing{Radius,Rim}           the spawn hole and how ragged its edge is.
 *   wet, slope                     nothing grows in the stream or on a cliff.
 *   rim{Gain,Offset,Width}         the dense band that encloses the clearing.
 *
 * `groveFreq` 0.011 is ~90 m per feature and is the number the identity offsets
 * `5, -9` are attached to — see the `grove` block in scatter.js, which explains
 * why seed 0 must reproduce those two verbatim rather than through an arithmetic
 * that lands on them.
 */
const DENSITY = {
  groveFreq: 0.011,
  groveOctaves: 3,
  groveGain: 0.55,
  groveBase: 0.62,
  clearingRadius: 14,
  clearingRim: 7,
  wet: 1.6,
  slope: 2.4,
  rimGain: 1.1,
  rimOffset: 6,
  rimWidth: 10,
  /** The identity `grove()` offsets. Seed 0 is `grove-01` and must get these. */
  identity: [5, -9],
};

/** The instance scale range for a trunk. See the long block in `treeSector`. */
const TREE_SCALE = [0.5, 1.48];

/* ========================================================================== */
/* what kind of place this is                                                 */
/* ========================================================================== */

/**
 * THIS LAND'S SEVEN-AND-A-HALF WEIGHTS, and the reason the SET of them is per
 * land rather than the thresholds.
 *
 * `meadow, bramble, litter, damp, flower, canopy, wet, understorey`. Read the
 * names: six of the eight are statements about a temperate-to-tropical wood.
 * A boreal winter wood has no bramble edge and no flower meadow and its bald
 * ground is not "dry litter", it is wind-scoured crust — so the taiga does not
 * ship these weights with different numbers in them, it ships different weights
 * (`drift, scrub, needle, damp, exposure, canopy, wet, thicket`). The header on
 * this function used to call itself THE SINGLE SOURCE OF BIOME TRUTH, and it
 * still is; what moved is that there is now more than one truth to be the
 * source of.
 *
 * A factory, taking the kit once per realm. The body below is verbatim.
 */
function makeCharacter({ forestDensity, wetness, fbm2, offsets }) {
  return function character(x, z, out) {
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
     *
     * IT WAS 0.44 / 0.20 x clamp01(canopy x 1.35) AND IT REACHED 8% OF THE GROUND.
     *
     * That is the gap between what this comment claims and what the arithmetic
     * did, and it is the single reason "deep wood goes properly bald" — the stated
     * design goal, and the thing the grass block takes at its word — was never
     * visible anywhere. Two independent fields both had to be at an extreme at
     * once: `a < 0.34` for the smoothstep to clear 0.5 (P = 10.0% on this lattice,
     * mean 0.504, sd 0.123) AND `canopy > 0.74` for the second factor to reach 1
     * (P = 16.8%, canopy mean 0.596). Sampled on a 420x420 lattice at 3.1 m over
     * grove-01, `litter > 0.5` covered 8.4% of the ground and `litter > 0.25`
     * covered 15.7%. A biome that operates on a twelfth of the world is a biome
     * nobody has ever seen.
     *
     * THE TWO FIXES ARE DIFFERENT IN KIND AND BOTH WERE NEEDED.
     *
     * `0.44 -> 0.55` and `0.20 -> 0.26` moves the `a` half from a tail of the
     * distribution to its middle: the smoothstep now clears 0.5 at `a < 0.42`,
     * which is 26% of the ground rather than 10%. That is the half that decides
     * WHERE the bald ground is, and it should be an ordinary place, not a rarity.
     *
     * `clamp01(canopy * 1.35)` -> `0.35 + 0.65 * clamp01(canopy * 1.9)` is the
     * half that mattered more, because it was not a weighting at all — it was a
     * second hard AND, and multiplying two independent 1-in-8 conditions is how
     * you get a 1-in-12 biome. The floor of 0.35 says a dry patch is still a dry
     * patch under a broken canopy, and 1.9 saturates at canopy 0.526 (the mean is
     * 0.596) rather than at 0.74, so the closed wood is fully weighted instead of
     * asymptotically approaching it.
     *
     * MEASURED AFTER, same lattice: `litter > 0.5` on 27.5% of the ground and
     * `litter > 0.25` on 39.9%, mean weight 0.102 -> 0.288.
     */
    out.litter =
      smoothstep(clamp01((0.55 - a) / 0.26)) *
      (0.35 + 0.65 * clamp01(canopy * 1.9)) *
      (1 - out.damp);

    /**
     * THE SHADE-LOVERS' BIOME — the fourth cell of a 2x2 of `canopy` against `b`.
     *
     * This function went to real trouble to make meadow, bramble and litter
     * exclusive, and then SEVEN layers read `canopy` raw and ignored all of it.
     * Measured, they were near-identical curves — sticks `0.1 + canopy*0.42`,
     * saplings the same, bigleaf the same, palms `0.14 + canopy*0.5`, bushes a
     * band at canopy 0.55, bromeliads a floor of `canopy*0.13`, ferns
     * `shade*0.7` — so every one of them peaked on the same ground and the
     * closed-canopy floor came out as one uniform mat of everything at once.
     *
     *                     b LOW                     b HIGH
     *   canopy HIGH   bare litter floor         understorey thicket
     *                 (`litter`, keyed to a)    (`understorey`, here)
     *   canopy MID    flowery open ground       bramble edge
     *   canopy LOW    (`flower`)                (`bramble`)
     *
     * `1 - litter * 0.85` rather than `1 - litter`: a bald patch keeps the odd
     * plant in it. Zero would make the two weights a partition and put a visible
     * seam where the `a` field crosses its threshold.
     *
     * `canopy * 1.3` saturates at 0.77, i.e. this stays a genuine canopy ramp
     * rather than the near-constant `clamp01(canopy * 1.9)` the litter weight
     * wants. A thicket should thin visibly as you walk out from under the roof;
     * bald ground should not care how closed the roof is once it is closed.
     *
     * REUSING `b` RATHER THAN ADDING A THIRD LATTICE was deliberate: a third fbm
     * is a third pair of hash-lattice taps on every one of the ~90 000 candidates
     * a sector tests, and three conditions at once is one condition too many.
     */
    out.understorey =
      clamp01(canopy * 1.3) *
      smoothstep(clamp01((b - 0.42) / 0.24)) *
      (1 - out.litter * 0.85) *
      (1 - out.meadow * 0.6);

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
     * which is not a wildflower patch, it is a rounding error.
     */
    out.flower =
      clamp01(1 - canopy * 0.8) * smoothstep(clamp01((0.56 - b) / 0.3)) * (1 - out.damp * 0.8);

    return out;
  };
}

/** The reused output object's field set. See the `_ch` block in scatter.js. */
const WEIGHTS = ['meadow', 'bramble', 'litter', 'damp', 'flower', 'canopy', 'wet', 'understorey'];

/* ========================================================================== */
/* the ground                                                                 */
/* ========================================================================== */

/**
 * THE SIX SUBSTRATES, and every one of them is chosen in LINEAR.
 *
 * The long argument for each of these hexes is in `heightGrid` in terrain.js,
 * where they used to be function-local consts, and it is not repeated here
 * because it is about this wood rather than about the palette mechanism. The
 * two facts that reach anybody adding a land:
 *
 *   `THREE.Color(hex)` decodes sRGB into the linear working space and the
 *   decode is convex, so BOTH numbers a palette is picked by lie on the way
 *   through. A near-neutral sRGB hex is not near-neutral: 0x413b34 looks like a
 *   reasonable stone and has 41% of `litter`'s linear chroma. A 15% cut in sRGB
 *   luma is a 32% cut in light.
 *
 *   The ground is the frame's best early-Z occluder and its largest opaque
 *   layer. This palette is a per-vertex lerp of six colours and NOT a texture
 *   fetch, which is why it costs nothing; a land that wanted a seventh
 *   substrate gets it free, and a land that wanted a second detail map would be
 *   charging a third fetch on every fragment of that layer.
 *
 * `snow` is absent here and present in the taiga. The blend in `heightGrid`
 * skips the whole term when a land does not declare one, so the rainforest's
 * arithmetic is not a lerp toward white by zero — it is the same expression it
 * always was, which is what keeps the ground colours bit-identical.
 */
const GROUND = {
  moss: 0x3e5333,
  litter: 0x4f331c,
  dry: 0x5e321b,
  gravel: 0x534a3f,
  soak: 0x362c1d,
  rock: 0x3f3d3a,
  /**
   * The blend's own coefficients, in the order `heightGrid` applies them.
   *
   * `mossPatch/mossWet` split moss from litter on the 22 m `patch` field with a
   * third of a bias from the water — moss follows the water, and the old blend
   * did not know it, so moss appeared in bands across dry ridges and bare litter
   * sat in bogs.
   *
   * `dryRamp/dryBias` open the laterite at slope 0.119 (28°). `bareRamp/bareBias`
   * open bare rock at 0.133 (30°) and saturate at 0.356 (50°) — the p95–p99 band
   * of THIS terrain, measured over 164 025 vertices, and the reason it must open
   * AFTER the laterite is that rock is lerped after `dry` and would otherwise
   * simply overwrite the red bank.
   *
   * `crestFrom/crestSpan/crestGain` grey the ridge near its top only; the term is
   * SQUARED, so it is still only 0.25 at 31 m, and it tops out at 0.72 because a
   * summit that goes fully bare is a bald patch with trees standing on it.
   *
   * `wetFloor` is the biome in one number: nothing in this forest is ever
   * properly dry, and a floor with genuinely dry patches in it reads as
   * woodland.
   */
  mossPatch: 1.35,
  mossBias: 0.12,
  mossWet: 0.34,
  dryRamp: 2.1,
  dryBias: 0.25,
  bareRamp: 4.5,
  bareBias: 0.6,
  barePatch: 0.22,
  crestFrom: 22,
  crestSpan: 18,
  crestGain: 0.72,
  wetFloor: 0.22,
  basinFrom: 5,
  basinSpan: 14,
};

/* ========================================================================== */
/* which layers exist                                                         */
/* ========================================================================== */

/**
 * EVERY STREAMED LAYER THIS LAND BUILDS, and the list is a list you DELETE FROM.
 *
 * `forest.js` filters its whole streamed registry through this, and
 * `underLayer` in scatter.js already bails when `bounds[id]` is missing — so a
 * land that omits `bromeliads` needs no other edit anywhere: the geometry is
 * never built, the mesh is never added, the draw call never happens, and the
 * placement rule never runs. That seam existed before the land layer did (it is
 * how `SWARD_FORMS` degrades when `grass-b` is absent) and it is the single
 * cheapest thing in this design.
 *
 * The ids are also the mesh names every instrument identifies a layer by —
 * `culling.js`'s `thinnable` default, the undergrowth slider, `perf/stations.js`,
 * `presets.mjs`'s UNDERSTOREY arm — so a land that renames a layer makes it
 * invisible to all of them. Reuse an id or accept that no gate can see it.
 */
const LAYERS = new Set([
  'grass',
  'grass-b',
  'ferns',
  // A FAMILY KEY: `forest.js` builds `rocks:0..N` from one entry, so the set
  // names the family and the ids follow.
  'rocks',
  'logs',
  'shroom-stem',
  'shroom-cap',
  'meadow',
  'bramble',
  'bushes',
  'saplings',
  'sticks',
  'flowers',
  'litter',
  'reeds',
  'stumps',
  'palms',
  'bromeliads',
  'bigleaf',
]);

/**
 * The five hues a wildflower patch can be.
 *
 * Named rather than inlined because the flower texture is drawn almost white so
 * that the instance colour decides what colour a patch is — the palette is the
 * layer's whole identity.
 *
 * THE FIVE VALUES ARE UNCHANGED FROM THE TEMPERATE ROSTER AND DID NOT NEED TO
 * MOVE. They used to be named for buttercup, campion, harebell, poppy and
 * bluebell; the same five hues are gold Calathea, pink Costus, blue
 * Dichorisandra, scarlet Psychotria and violet Tradescantia, all of which are
 * understorey plants of this forest. A hue is not a latitude — what said
 * "meadow" was the SHAPE the colour arrived in, and that is fixed in
 * `flowerTexture`.
 */
const FLOWER_HUES = [0.14, 0.92, 0.62, 0.1, 0.78];

/**
 * THE SWARD'S SILHOUETTES, in the order a candidate chooses between them.
 * Filtered against `bounds` at use, so a build that does not create the second
 * mesh simply gets the first form for everything and nothing has to be told.
 */
const SWARD_FORMS = ['grass', 'grass-b'];

/**
 * The two ends of the sward, in LINEAR light.
 *
 * The texture is near-neutral and the material colour is white, so these two
 * triples are the ONLY colour the commonest card in the world has. Linear, not
 * hex, because an instanceColor is multiplied into diffuseColor with no
 * conversion — writing them as hex would put two of the three factors in sRGB
 * and one in linear, which is the exact confusion this layer's history is made
 * of. Encoded they are about #7ACC7D and #A08E61; Rec.709 luma 0.4839 and
 * 0.2762, a 1.75x range.
 */
const SWARD_WET = [0.19, 0.6, 0.2];
const SWARD_DRY = [0.35, 0.27, 0.12];

/* ========================================================================== */
/* the coarse half of a sector                                                */
/* ========================================================================== */

/**
 * SWARD, FERNS, ROCKS, DEADFALL AND MUSHROOMS — and why this is one function
 * rather than five rows.
 *
 * The understorey table below IS a table because its twelve members really do
 * share a shape: one lattice, one acceptance, one instance. These five do not.
 * The sward walks its own grid and splits between two meshes; the rocks are a
 * loop over however many size classes `forest.js` built; the mushrooms are a
 * patch spawner that draws a centre, retries up to twenty-four times for
 * unflooded ground, and then scatters three to seven caps round it. Forcing
 * those into a schema would produce a schema with a `kind` field and five
 * branches, i.e. this function with an indirection in front of it.
 *
 * IT RUNS FIRST AND ITS ORDER IS FIXED FOREVER. The sector comes off ONE seeded
 * stream, so a layer moved, inserted or removed anywhere above the end of this
 * function re-rolls every draw after it and moves every plant and every tree in
 * the world. `authored-check.mjs` exists to notice exactly that. A land may
 * choose a different order — a different land is a different world and owes
 * nothing to this one — but within a land it is frozen.
 */
function makeCoarse(K) {
  const {
    rng,
    ox,
    oz,
    size,
    sx,
    sz,
    bounds,
    rockSizes,
    layer,
    collide,
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
    slopeAt,
    wetness,
    heightAt,
    groundUnder,
    caveClearance,
    fbm2,
  } = K;

  // ---- grass --------------------------------------------------------------
  /**
   * THE RAINFOREST FLOOR IS BARE, AND THAT IS BOTH THE LOOK AND THE SAVING.
   *
   * This is the most expensive layer in the world — `.perf/baseline.json` had
   * it at 24 191 submitted instances against the next-biggest layer's 7 188 —
   * and under the temperate roster it grew a bright meadow sward everywhere the
   * canopy was not completely shut. That is exactly wrong for this biome. Under
   * a closed tropical canopy something like 1-2% of the light reaches the
   * ground; there is no turf down there, there is leaf litter, roots, seedlings
   * and bare mud.
   *
   *   `spacing` 0.6 -> 0.82 is 1.87x fewer candidates before any acceptance
   *   runs, i.e. a 47% cut to the layer, applied uniformly.
   *
   *   The acceptance went from `1 - litter * 0.8` to a full `1 - litter`, so a
   *   closed canopy now takes the sward to ZERO instead of to a fifth.
   *
   * Censused after that pass this layer runs at 62.8 instances per 100 m² in
   * ordinary wood. What the two blocks below change is the SHAPE of a tuft
   * (there are two of them now, and no two lean the same way) and WHERE the
   * layer is allowed to be (nowhere anybody stands).
   */
  {
    const spacing = 0.82;
    const steps = Math.round(size / spacing);
    /**
     * ==== THE SWARD IS TWO SHAPES NOW, NOT ONE ====
     *
     * The dominant "video game" tell left on this floor was not density, it was
     * REPETITION: ~9 700 instances at the canopy station, every one of them the
     * same three-blade fan. A real terra firme floor is a MIX, so there are two
     * geometries — the blade fan (`grass`) and a broadleaf herb rosette
     * (`grass-b`) — and a candidate picks one.
     *
     *   ONE DRAW CALL, world-wide. Streamed layers are one InstancedMesh for
     *   the whole endless world, not one per sector, so a second geometry is +1
     *   draw. Against potato's 81 at the deep station that is +1.2%.
     *
     *   ZERO new shader programs and zero new textures: `grass-b` is handed the
     *   SAME material object. This was the deciding constraint — a second
     *   material would have been a compile hitch.
     *
     *   NEGATIVE triangles. 12 against the fan's 18, split roughly evenly, so
     *   the layer's mean goes 18 -> 15 per instance.
     *
     * TO GATE IT OFF: drop `grass-b` from this land's LAYERS set. `SWARD_FORMS`
     * is filtered against `bounds` right here, so every instance silently falls
     * back to the fan and nothing else in the file has to know.
     *
     * REJECTED — packing several variants into ONE geometry and collapsing the
     * unused ones in the vertex shader. Zero draw calls and four times the
     * vertex work: a 4-way atlas takes the layer from 221 k to 885 k triangles
     * submitted, ~+0.7 ms, to save 1 draw. The deep station measures
     * vertex-bound at 67%.
     */
    const swardIds = SWARD_FORMS.filter((id) => bounds[id]);
    const swardLayers = swardIds.map((id) => layer(id));
    const swardBounds = swardIds.map((id) => bounds[id]);
    for (let j = 0; j < steps; j++) {
      for (let i = 0; i < steps; i++) {
        const x = ox + (i + rng()) * spacing;
        const z = oz + (j + rng()) * spacing;
        if (slopeAt(x, z) > 0.46) continue;
        if (submerged(x, z)) continue;
        const patch = fbm2(x * 0.06 + 3, z * 0.06 + 12, 2) * 0.5 + 0.62;
        /**
         * ONE ACCEPTANCE, NO DISTANCE TERM AT ALL. There were two of them and
         * both were about the origin; between them they made the ground round
         * the spawn point the thinnest in the world, 0.31 cover instances per m²
         * at 80–100 m against 1.97 out at 700 m. There is no circle to soften
         * any more.
         *
         * THE SWARD READS THE BIOME: under a closed dry canopy every other
         * weight collapses, so the ground gets sticks and leaf drift and NOTHING
         * ELSE. Emptiness is variety, and it renders free.
         *
         * AND `trodden`, WHICH IS THE OTHER HALF OF "THE COMMONS IS A LAWN".
         * `litter` collapses where the canopy does, so every hole this file
         * deliberately puts in the tree field came back as the densest sward in
         * the world. Applied to the SAME acceptance draw rather than as a
         * separate `if`, so the candidate still costs exactly one `rng()`.
         */
        if (rng() > patch * (1 - character(x, z).litter) * trodden(x, z)) continue;
        /**
         * AND THE SWARD HAS TO KNOW ABOUT CAVES, WHICH IT DID NOT.
         *
         * Every other layer is gated by `forestDensity`, which carries
         * `caveClearance` — so the trees, bushes, stumps and cover all stayed
         * out of a gully, and the grass, which is sampled directly and has its
         * own acceptance, walked straight into it. `.shots/crag/a4-mouth.png`
         * was a photograph of a cave mouth with no cave mouth visible in it.
         *
         * Last, after the acceptance, so the lookup runs on the candidates that
         * survived rather than on all 180 000 of them.
         */
        if (caveClearance(x, z) > 0.35) continue;
        const y = heightAt(x, z);
        /**
         * ==== THE SAME THREE DRAWS, SPENT ON SHAPE INSTEAD OF ON SIZE ====
         *
         * This read three independent ranges, which is a correct description of
         * "varied" and a poor one of "different plants": three independent
         * uniforms centre hard, so nearly every tuft was the base geometry at
         * about 1.1x. The three draws are unchanged in NUMBER — they have to be
         * — and re-spent as (overall size, upright vs sprawling, cross-section).
         *
         *   mean multiplier   gy 1.15 -> 0.969   gx/gz 1.10 -> 0.99
         *   mean tuft         height 0.598 -> 0.551 m   width 0.476 -> 0.444 m
         *
         * A smaller mean and a wider spread: the average blade gets out of the
         * way and the occasional one is worth looking at.
         */
        const size = rngRange(rng, 0.7, 1.2);
        const form = rng();
        const skew = rngRange(rng, 0.85, 1.18);
        const gy = size * (0.62 + form * 0.8);
        const wide = size * (1.28 - form * 0.48);
        const gx = wide * skew;
        const gz = wide / skew;
        /**
         * ==== AND EVERY TUFT LEANS ITS OWN WAY, WHICH COSTS NOTHING ====
         *
         * Yaw alone cannot stop a repeated object reading as a repeated object:
         * a rotationally near-symmetric fan looks the same from every bearing.
         * Up to 0.34 rad (19.5°) of pitch and roll, from `latticeHash` and NOT
         * from `rng()`, so the seeded stream does not move by a single draw.
         *
         * `tiltMatrix` instead of `yawMatrix`, and the bound has to follow: both
         * sward layers are registered with `instanceBound(geo, true)`, which
         * collapses the sphere centre onto the instance origin. A yaw-only bound
         * is hung at `cy` and a tilted instance walks straight out of it — the
         * failure mode is a `cull-check` pixel diff nobody can attribute.
         */
        const cell = latticeHash(sx * steps + i, sz * steps + j);
        const pitch = (latticeHash(sx * steps + i + 7919, sz * steps + j) - 0.5) * 0.34;
        const roll = (latticeHash(sx * steps + i, sz * steps + j + 104729) - 0.5) * 0.34;
        tiltMatrix(_mat, x, y - 0.04, z, pitch, rng() * TAU, roll, gx, gy, gz);
        /**
         * ==== THE SWARD'S COLOUR COMES OUT OF A FIELD, NOT OUT OF A DIE ====
         *
         * The tint before this was three independent uniform draws per tuft —
         * hue, saturation and lightness, each rolled fresh. That is a correct
         * description of "varied" and the wrong description of a MEADOW, because
         * the variation had no spatial extent: every tuft was statistically
         * independent of the one beside it, so the layer read as a uniform green
         * with salt-and-pepper noise on it, and the noise averaged out to a
         * single colour at any distance past a few metres. The one thing a real
         * sward has that this did not is PATCHES.
         *
         * x0.03 per metre over two octaves puts the coarse features at about
         * 33 m and the fine at 16 m, which is the scale at which a difference is
         * a PLACE rather than a texture. Sampled at 160 000 points on a 1.6 km
         * square the remapped field has mean 0.491 and its 10th and 90th
         * percentiles sit at 0.01 and 0.98 — so the x1.5 gain is what makes the
         * two ends actually get reached instead of everything hugging the middle.
         *
         *
         * ==== THE LUMA ARITHMETIC, BECAUSE THIS IS THE FOUR-PER-CENT TRAP ==
         *
         * A card's screen colour is texture x material colour x instance tint,
         * and the note at forest.js:580 and the bramble block in undergrowth.js
         * both record what happens when those are chosen one at a time by eye.
         * All three of them moved in this change, so all three were measured.
         * Every number below is LINEAR light, alpha-weighted over the texels that
         * survive alphaTest 0.4, Rec.709 luma 0.2126R + 0.7152G + 0.0722B:
         *
         *   BEFORE
         *     texture  herbTuft sat 42   (0.0540, 0.3726, 0.0809)
         *     material 0x9ecc94          (0.3419, 0.6038, 0.2961)
         *     tint     mean of the HSL   (0.2806, 0.4511, 0.1888)
         *     product                    (0.00518, 0.10149, 0.00452)
         *     LUMA                        0.07401
         *
         *   AFTER
         *     texture  herbTuft sat 10   (0.1286, 0.2195, 0.1411)
         *     material 0xffffff          (1, 1, 1)
         *     tint     mean at m=0.491   (0.2714, 0.4322, 0.1593)
         *     product                    (0.03490, 0.09489, 0.02249)
         *     LUMA                        0.07691
         *
         * +3.9%, which satisfies "at or above" without turning the floor into a
         * lawn — the sward has to stay BELOW the litter it grows out of.
         *
         * WHY DESATURATING THE TEXTURE IS THE POINT AND NOT A SIDE EFFECT. The
         * old texture's red channel is 0.054. Multiply anything by that and it is
         * gone: a dry, straw-coloured tint could not render as dry, because the
         * factor that was supposed to carry the red had already deleted it, and
         * the same for blue at 0.081. That is why every tuft in the world came
         * out the same green whatever the die said.
         *
         * Note that desaturating at constant HSL lightness LOWERS luma — green
         * carries 0.7152 of it — 0.2838 to 0.1945 on the texture alone, a 31%
         * drop. Dropping the material colour, whose own luma is 0.5259, is what
         * pays for that and for the wider tint range.
         *
         * EXACTLY THREE rng DRAWS, as before, and that is not tidiness. This
         * generator is shared by every layer in the sector and consumed in order,
         * so taking a different number of values here would re-roll every fern,
         * stone, log and mushroom placed after it.
         */
        const patchy = clamp01(fbm2(x * 0.03 + 61.3, z * 0.03 + 17.7, 2) * 1.5 + 0.5);
        // Per-tuft jitter ON TOP of the field, so neighbours inside one patch
        // are not identical. Zero-mean, so it cannot move the luma above.
        const wet = clamp01(patchy + rngRange(rng, -0.13, 0.13));
        const lift = rngRange(rng, 0.86, 1.14);
        const warm = rngRange(rng, -0.03, 0.03);
        _col[0] = (SWARD_DRY[0] + (SWARD_WET[0] - SWARD_DRY[0]) * wet + warm) * lift;
        _col[1] = (SWARD_DRY[1] + (SWARD_WET[1] - SWARD_DRY[1]) * wet) * lift;
        _col[2] = (SWARD_DRY[2] + (SWARD_WET[2] - SWARD_DRY[2]) * wet - warm) * lift;
        /**
         * WHICH SHAPE, AND IT IS DECIDED BY A FIELD AS WELL AS BY A DIE.
         *
         * `wet` is the sward's damp/dry field with its per-tuft jitter already
         * on it, computed just above and free to reuse — so the broadleaf herb's
         * share runs from 34% on dry rises to 66% in damp hollows, which is both
         * the right ecology and the reason the mix is a PLACE rather than a
         * dither. `cell` then decides each individual tuft, and it is independent
         * between neighbours on purpose: a spatially smooth choice would put the
         * two forms in patches, and a patch of one shape is the problem this is
         * fixing, one order of magnitude larger.
         *
         * No extra field lookup and no extra draw: both inputs already existed.
         */
        const k = cell < 0.34 + wet * 0.32 ? swardIds.length - 1 : 0;
        const bound = swardBounds[k];
        const grow = Math.max(gx, gy, gz);
        push(swardLayers[k], _mat, _col, x, y - 0.04 + bound.cy * grow, z, bound.r * grow);
      }
    }
  }

  // ---- ferns --------------------------------------------------------------
  /**
   * THIS LAYER GREW INTO THE UNDERSTORY GIANTS, RATHER THAN A LAYER BEING ADDED
   * FOR THEM.
   *
   * The brief wanted heliconia and philodendron — the big paddle leaves at head
   * height that are most of what "jungle" means at eye level. A new scatter
   * layer is a new streamed InstancedMesh in every resident sector and a draw
   * call, which is the one cost this project does not pay casually. It is also
   * unnecessary: a fern here is already a shade-and-damp-loving frond card that
   * grows exactly where a heliconia grows, so the giants are the SAME LAYER with
   * its size range opened up.
   *
   * `grow` 0.62-1.5 became 0.7-2.6, deliberately skewed rather than uniform:
   * `pow(rng(), 1.7)` keeps most plants near the bottom and lets a few reach the
   * top, so what comes out is an understory of ordinary ferns with occasional
   * two-metre paddles standing over them.
   *
   * ==== AND IT WAS NOT PAID FOR, WHICH IS WHY THIS LAYER WAS THE CLUTTER ====
   *
   *   E[pow(u, 1.7)] = 1/2.7 = 0.370, so mean `grow` was 1.404 and the base card
   *   was 1.5 m wide — a MEAN FERN 2.11 m ACROSS, and 3.9 m at the top.
   *
   *   Censused over 640 000 m² the layer places 11.05 instances per 100 m²,
   *   i.e. a mean nearest-neighbour spacing of 3.05 m.
   *
   * Plants 2.11 m wide on 3.05 m centres do not stand next to one another, they
   * OVERLAP, and four crossed double-sided alpha cards each is the most
   * occluding shape in the file. It has the worst cost ratio of any layer in the
   * world at the canopy station, 4.15 ms per million triangles against the
   * sward's 1.03.
   *
   *   The base card is 1.5 m -> 0.95 m in forest.js, so the mean fern is now
   *   1.33 m. The `grow` range is UNTOUCHED.
   *
   *   A 15 m PATCH FIELD, which is the change that actually fixes the look. It
   *   is an fbm lookup and NOT an rng draw.
   *
   *   `shade` is now `character().understorey`.
   */
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
        const c = character(x, z);
        /**
         * ~15 m per feature, on a lattice offset well off every other field in
         * this file. `x2.6 - 0.95` is a threshold, not a fade, and that is the
         * point: measured over a 700x700 lattice it is identically ZERO on 14.9%
         * of the ground, reaches full density on 1.3%, and means 0.364. A plain
         * `0..1` multiplier would have thinned the wall evenly and left it a
         * wall. What is wanted is floor you can see.
         */
        const patch = clamp01((fbm2(x * 0.066 + 129.7, z * 0.066 - 58.3, 2) * 0.5 + 0.5) * 2.6 - 0.95);
        // No radial fade and no radial cut-off: a fern grows where the biome is
        // rank and shaded, at 20 m and at 20 km, and nowhere else. `trodden` is
        // not a radial fade — it is nine small holes where people stand, and the
        // `0.09` floor is exactly what walked a 1.3 m rosette into the middle of
        // the commons in spite of `understorey` being zero there.
        if (rng() > (0.09 + c.understorey * 1.9 + c.damp * 0.45) * patch * trodden(x, z)) continue;
        const y = heightAt(x, z);
        const grow = 0.7 + Math.pow(rng(), 1.7) * 1.9;
        yawMatrix(_mat, x, y - 0.06, z, rng() * TAU, grow, grow, grow);
        /**
         * Deeper and much less bright: at a lightness of 0.74 these were pale
         * mint cards glowing in the darkest part of the frame. A heliconia leaf
         * is a heavy saturated green with a wax sheen, so saturation goes UP as
         * lightness comes down — the pairing that reads as glossy rather than
         * dusty.
         *
         * THE HUE IS 0.375 (135°) AND IT IS THE COLD END OF THE WHOLE WORLD.
         * Every green in this file used to lie between 68° and 134°, which is one
         * green with jitter on it. This layer is the biggest of the leafy ones,
         * so it takes the far end. The lightness is NOT dropped with the rest of
         * the understorey tints — at 0.22-0.46 it is already the darkest card
         * layer in the world.
         */
        _tint.setHSL(
          0.375 + rngRange(rng, -0.045, 0.03),
          rngRange(rng, 0.34, 0.58),
          rngRange(rng, 0.22, 0.46)
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
   * The authored world put fifteen patches inside 114 m on the argument that a
   * player who searches for four minutes and finds nothing concludes there is
   * nothing to find. That argument does not stop at 114 m. An endless forest
   * with all its mushrooms in the first two hundred metres is an endless forest
   * with nothing in it, and the mushrooms are the only thing out there that
   * rewards going anywhere.
   *
   * The density is copied from the authored world rather than picked: fifteen
   * patches inside 114 m is one per 2720 m², so a 32 m sector wants one patch
   * 38% of the time. Getting this wrong is worse in the generous direction — one
   * patch per sector measured at 62 of them inside the ring, and a thing you
   * trip over on the way somewhere else is not a thing you find.
   *
   * THE FIRST PATCH IS NO LONGER GUARANTEED TO BE NEAR THE GLADE. Five sectors
   * of ground lie inside 40 m of the spawn point, so the chance of meeting
   * nothing within a forty-metre stroll is 0.62⁵ ≈ 9%. Re-adding the guarantee
   * would mean a distance-from-origin special case in the one file whose whole
   * argument is now that there are none.
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
}

/* ========================================================================== */
/* the understorey table                                                      */
/* ========================================================================== */

/**
 * THE TWELVE UNDERSTOREY LAYERS, in the order the seeded stream visits them.
 *
 * Each row is `{ id, spacing, make }`. `make` is handed the sector kit once and
 * returns the per-candidate body with the signature `underLayer` has always
 * called: `(x, z, l, bound, p)`, where `p` is the lattice-tiling density
 * correction and nothing else.
 *
 * THE ORDER IS FROZEN WITHIN A LAND. A row inserted anywhere but the end
 * re-rolls every draw after it and moves every plant in the world. The three
 * mid-storey layers at the bottom are appended for exactly that reason and the
 * same rule put them last in the table in forest.js.
 *
 * A note on test ORDER inside a body. The cheap rejections come first:
 * `slopeAt` and `wetness` before `character`, and `character` before `heightAt`.
 * `character` is two fbms, a `forestDensity` and a `wetness`, and it is called
 * for every candidate that gets past the slope test — about ninety thousand of
 * them per sector across the layers — so the ordering is worth real time.
 * Reordering pure predicates cannot change the acceptance PROBABILITY, only
 * which draws are taken, and since the whole sector comes off one seeded stream
 * that is a change to the world.
 */
const UNDERSTOREY = [
  {
    id: 'meadow',
    spacing: 1.3,
    make: ({ rng, character, trodden, submerged, slopeAt, heightAt, yawMatrix, push, _mat, _col, _tint, fbm2 }) =>
      (x, z, l, bound, p) => {
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
         * A SMALL BALD DISC WHERE THE PLAYER'S BOOTS ARE — WHICH IS `trodden`,
         * AND IS NO LONGER THIS LAYER'S PRIVATE PROPERTY.
         *
         * The spawn clearing is a hole in `forestDensity`, so the canopy term
         * that gates this layer is at its MAXIMUM there — the glade you start in
         * is the single most meadow-y place in the world, and without this the
         * first frame of the game is a wall of chest-high hay a metre from your
         * face and a jukebox buried to its dial.
         *
         * It multiplies the DENSITY only. `m` reaches the height term untouched,
         * so the drifts you can see from the spawn point are full height.
         */
        if (rng() > clamp01(m * 3.2 - 0.3) * drift * trodden(x, z) * p) return;
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
        /**
         * ==== THE FLOOR WAS AUTHORED BRIGHTER THAN THE ROOF ====
         *
         * `setHSL` with no colour-space argument writes into the WORKING space,
         * which is linear — see the block at avatar.js:392, where the same fact
         * made every avatar chalky. So these three numbers are not perceptual
         * lightnesses, they are linear reflectance multipliers, and 0.44-0.72 was
         * a very bright one. The canopy's own instance tints run at an HSV value
         * of 0.37-0.60; real rainforest floor irradiance is 1-2% of the roof's.
         *
         * 0.44-0.72 -> 0.30-0.58 here, and a comparable 0.14 comes off the
         * bramble, bushes, saplings, reeds, sticks, palms, bromeliads and giant
         * leaves. The ferns are the one card layer NOT dropped.
         *
         * ==== AND THE HUE IS THE WARM END OF THE SPLIT ====
         *
         * Every green in the world used to lie between 68° and 134° with the bulk
         * in 95-120 — a 66° window, which is one green with jitter on it. The
         * layers are now spread across it deliberately, warmest first: meadow 52°,
         * reeds 56°, saplings 67°, bushes 76°, palms 94-119°, bramble 124°,
         * ferns 135°.
         *
         * The warm ACCENT palettes are untouched and must stay so: `FLOWER_HUES`
         * and the `PALETTE` in tree-adorn.js are the only non-green in the world.
         */
        _tint.setHSL(
          0.145 + rngRange(rng, -0.028, 0.05),
          rngRange(rng, 0.24, 0.46),
          rngRange(rng, 0.3, 0.58)
        );
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        const grow = Math.max(gx, tall, gz);
        push(l, _mat, _col, x, y - 0.05 + bound.cy * grow, z, bound.r * grow);
      },
  },

  {
    id: 'bramble',
    spacing: 2.5,
    make: ({ rng, character, trodden, submerged, slopeAt, heightAt, yawMatrix, push, _mat, _col, _tint }) =>
      (x, z, l, bound, p) => {
        if (slopeAt(x, z) > 0.46) return;
        const c = character(x, z);
        if (c.bramble < 0.12) return;
        // `trodden` for the reason the sward gives, and this layer has the
        // sharpest version of it: `bramble` peaks at a canopy of 0.52, which is
        // precisely the graded rim of every clearing in the world, so a thicket
        // formed a ring around each site exactly where people walk in.
        if (rng() > c.bramble * 1.05 * trodden(x, z) * p) return;
        if (submerged(x, z)) return;
        const y = heightAt(x, z);
        const g = rngRange(rng, 0.7, 1.45);
        const gy = g * rngRange(rng, 0.75, 1.25);
        yawMatrix(_mat, x, y - 0.08, z, rng() * TAU, g, gy, g);
        // 124° and 0.36-0.60: the cold end of the split, and 0.14 off a linear
        // lightness that had the thicket brighter than the canopy over it.
        _tint.setHSL(
          0.345 + rngRange(rng, -0.05, 0.03),
          rngRange(rng, 0.18, 0.36),
          rngRange(rng, 0.36, 0.6)
        );
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        const grow = Math.max(g, gy);
        push(l, _mat, _col, x, y - 0.08 + bound.cy * grow, z, bound.r * grow);
      },
  },

  {
    id: 'bushes',
    spacing: 5.4,
    make: ({ rng, character, trodden, submerged, slopeAt, heightAt, yawMatrix, push, rustle, bushCue, _mat, _col, _tint }) =>
      (x, z, l, bound, p) => {
        if (slopeAt(x, z) > 0.44) return;
        const c = character(x, z);
        /**
         * Bushes are the generalist: they grow anywhere the ground is not bare
         * leaf litter and not standing water, and they thicken on the edge.
         *
         * THE EDGE IS `bramble`, NOT A BAND ON RAW `canopy`. This read
         * `0.14 + (1 - |canopy - 0.55| * 1.6) * 0.5`, which is a hand-rolled copy
         * of the `edge` term inside `character` — and copying a biome instead of
         * reading it is exactly the bypass that function's header describes. Two
         * consequences, both visible: a bush ignored the `b` field entirely, and
         * it peaked at canopy 0.55 whatever the thicket was doing, so bushes and
         * bramble were two different densities of the same shrub on the same
         * ground.
         *
         * THE OUTER `1 - litter * 0.9` STAYS, unlike the palms' and the giant
         * leaves', and it is not an oversight that it doubles up with the
         * `1 - litter * 0.85` inside `understorey`. The `bramble` half of this
         * sum carries no litter exclusion of its own, so removing this factor
         * would let a thicket edge plant bushes on the bald floor. The
         * double-count costs the layer about 12% at the mean.
         */
        const want = (1 - c.litter * 0.9) * (0.18 + c.bramble * 1.0 + c.understorey * 1.25);
        /**
         * `trodden` HERE IS NOT A THINNING OF THE MID-STOREY.
         *
         * This layer and the saplings are deliberately held near their old counts
         * because they are what stops a long sightline — the forest occludes
         * itself, and cutting them is invisible at eye level and catastrophic
         * from anywhere with height. `trodden` is identically 1 outside a 34.5 m
         * disc at the commons and ~9-13 m discs at the other eight places, so
         * this removes bushes from about 0.1% of the world's area and none of it
         * is ground anybody is looking ACROSS.
         *
         * The 0.18 floor is why it is needed at all: like the ferns' 0.09 and the
         * aroids' 0.1, it plants regardless of biome, and a site is exactly where
         * every biome weight has gone to zero.
         */
        if (rng() > want * trodden(x, z) * p) return;
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
        // 76° and 0.36-0.64. The generalist shrub takes a middling olive between
        // the saplings' new flush and the palms.
        _tint.setHSL(
          0.21 + rngRange(rng, -0.045, 0.04),
          rngRange(rng, 0.2, 0.42),
          rngRange(rng, 0.36, 0.64)
        );
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        const grow = Math.max(gx, gy, gz);
        push(l, _mat, _col, x, y - 0.05 + bound.cy * grow, z, bound.r * grow);
        // Roughly the top third by width earns a rustle; the rest is scenery,
        // and `bushCue` returns 0 for those. This goes to `rustle`, not
        // `collide` — bushes no longer block the body.
        const cue = bushCue(gx);
        if (cue) rustle.push(x, z, cue);
      },
  },

  {
    id: 'saplings',
    spacing: 7.2,
    make: ({ rng, character, trodden, submerged, slopeAt, heightAt, yawMatrix, push, _mat, _col, _tint }) =>
      (x, z, l, bound, p) => {
        if (slopeAt(x, z) > 0.4) return;
        const c = character(x, z);
        /**
         * Seedlings come up where there is light AND a seed source.
         *
         * This used to read `0.1 + canopy * 0.42`, which is the same curve the
         * sticks, the bigleaf and (near enough) the palms were all using, and the
         * comment above it claimed it was "`canopy` in a band" when it is a plain
         * ramp. A seedling wants two different places and neither of them is
         * "wherever the canopy is closed": the lit floor of a glade (`meadow`)
         * and the rank shaded floor where a parent is dropping seed
         * (`understorey`).
         *
         * `trodden` and it is the strongest case of the six, because of the
         * `meadow` term. A gathering place is a hole in the canopy, `meadow`
         * reads a hole in the canopy as light, and a seedling that wants light
         * therefore wanted the middle of the cinema more than anywhere else in
         * the wood.
         */
        if (
          rng() >
          (1 - c.litter * 0.8) * (0.1 + c.understorey * 1.0 + c.meadow * 0.55) * trodden(x, z) * p
        )
          return;
        if (submerged(x, z)) return;
        const y = heightAt(x, z);
        const g = rngRange(rng, 0.5, 1.35);
        const gy = g * rngRange(rng, 0.85, 1.3);
        yawMatrix(_mat, x, y - 0.05, z, rng() * TAU, g, gy, g);
        // 67°, the second-warmest green in the world after the meadow, and it is
        // the one hue here with an ecological reason rather than a compositional
        // one: the new flush on a tropical seedling is a yellow-bronze thing that
        // greens up as it hardens.
        _tint.setHSL(
          0.185 + rngRange(rng, -0.04, 0.045),
          rngRange(rng, 0.24, 0.44),
          rngRange(rng, 0.36, 0.64)
        );
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        const grow = Math.max(g, gy);
        push(l, _mat, _col, x, y - 0.05 + bound.cy * grow, z, bound.r * grow);
      },
  },

  {
    id: 'sticks',
    spacing: 3.0,
    make: ({ rng, character, submerged, slopeAt, heightAt, tiltMatrix, push, _mat, _col, _tint }) =>
      (x, z, l, bound, p) => {
        if (slopeAt(x, z) > 0.5) return;
        const c = character(x, z);
        /**
         * STICKS ARE THE BARE FLOOR'S FURNITURE, AND THE WEIGHTS ARE NOW ROUND
         * THAT WAY UP.
         *
         * This read `0.1 + canopy * 0.42 + damp * 0.3 + litter * 0.22`: the same
         * `canopy * 0.42` ramp four other layers were using, with litter as an
         * afterthought a fifth its size. So the deadfall piled up in exactly the
         * places that were already full and was thinnest on the ground that had
         * nothing on it. Swapping the two coefficients is close to free and it is
         * what makes the widened bald biome READ as a rainforest floor rather
         * than as a missing texture.
         *
         * It is also the cheapest way to fill that ground. A stick is sixteen
         * opaque triangles that write depth, lying flat — it costs almost nothing
         * in the 0.3-2 m band the clutter complaint is about, and it does not
         * open a sightline the way deleting cover does.
         */
        if (rng() > (0.1 + c.litter * 0.62 + c.damp * 0.3 + c.canopy * 0.2) * p) return;
        if (submerged(x, z)) return;
        const y = heightAt(x, z);
        // One geometry, length varied by the instance: 0.35 to 1.8 turns a single
        // 1.7 m stick into everything from a twig to a three-metre fallen bough.
        // Named rather than `sx`/`sz`, which are the sector coordinates.
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
        // The hue stays where it is — this is the one layer down here that is
        // already not green. The linear lightness comes down 0.10-0.17: a
        // bleached stick at 0.85 was the brightest thing on the forest floor, and
        // the floor of a rainforest is the darkest place in it.
        _tint.setHSL(
          0.07 + rngRange(rng, -0.02, 0.02),
          rngRange(rng, 0.03, 0.17),
          rngRange(rng, 0.3, 0.68)
        );
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        const grow = Math.max(long, thickY, thickZ);
        push(l, _mat, _col, x, y + 0.03 + bound.cy * grow, z, bound.r * grow);
      },
  },

  /**
   * THE ONE GROUND LAYER DELIBERATELY NOT GIVEN `trodden`, and it is worth
   * saying why rather than leaving it looking like an omission.
   *
   * Six layers lost their share of the gathering places in that pass, which left
   * the commons as bare earth, leaf mats and twigs — correct, and featureless.
   * Wildflowers are 10 cm tall, they cost nothing, they carry the only non-green
   * in the world, and a worn clearing with flowers coming up through it is what
   * a place people sit in actually looks like. Censused inside 12 m of
   * `grove-01`'s commons they are 10.8 instances per 100 m², i.e. one every
   * three metres.
   */
  {
    id: 'flowers',
    spacing: 1.8,
    make: ({ rng, character, submerged, slopeAt, heightAt, yawMatrix, push, _mat, _col, _tint, fbm2 }) =>
      (x, z, l, bound, p) => {
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
      },
  },

  {
    id: 'litter',
    spacing: 3.5,
    make: ({ rng, character, submerged, slopeAt, heightAt, tiltMatrix, push, _mat, _col, _tint }) =>
      (x, z, l, bound, p) => {
        if (slopeAt(x, z) > 0.4) return;
        const c = character(x, z);
        /**
         * 0.85 -> 0.6 ON THE LITTER TERM, WHICH IS A CUT THAT LEAVES MORE MATS.
         *
         * The weight this multiplies nearly tripled in `character` (mean 0.102 ->
         * 0.288), so holding the coefficient would have taken this layer up by
         * two thirds. Some of that rise is wanted — mats are what a bald floor is
         * made of, they lie flat, and they are the darkest thing down there — but
         * not all of it. 0.6 lands the layer up by about a third instead.
         */
        if (rng() > (c.litter * 0.5 + c.damp * 0.7 + c.canopy * 0.14) * p) return;
        if (submerged(x, z)) return;
        const y = heightAt(x, z);
        // `mx`/`mz`, not `sx`/`sz`: those are the sector coordinates.
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
          // 119°: moss is the coolest green on the ground, next to the ferns, and
          // it should not be mistaken for the sward it grows beside.
          _tint.setHSL(
            0.33 + rngRange(rng, -0.04, 0.03),
            rngRange(rng, 0.24, 0.48),
            rngRange(rng, 0.3, 0.54)
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
      },
  },

  /**
   * The only layer keyed to the terrain rather than to the biome field, because
   * the stream is not a region — it is a line, and it runs across the whole
   * endless world. Testing wetness before anything else is a real saving rather
   * than fussiness: this grid used to walk 1156 cells per sector to find the
   * handful on the bank — 576 now, at the wider spacing — and `wetness` is two
   * sines where `heightAt` is a dozen octaves of noise.
   */
  {
    id: 'reeds',
    spacing: 1.35,
    make: ({ rng, wetness, heightAt, yawMatrix, push, WATER_LEVEL, _mat, _col, _tint }) =>
      (x, z, l, bound, p) => {
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
        // 56°, the warmest green in the world after the meadow's 52°. A stand of
        // reeds at the waterline is straw as much as it is green, and it is the
        // one place on this floor that stands in open sky — so it keeps more of
        // its brightness than anything else here, but it still comes down 0.10.
        _tint.setHSL(
          0.155 + rngRange(rng, -0.03, 0.05),
          rngRange(rng, 0.2, 0.44),
          rngRange(rng, 0.3, 0.6)
        );
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        const grow = Math.max(g, gy);
        push(l, _mat, _col, x, y - 0.06 + bound.cy * grow, z, bound.r * grow);
      },
  },

  {
    id: 'stumps',
    spacing: 20,
    make: ({ rng, submerged, slopeAt, heightAt, forestDensity, tiltMatrix, push, collide, stumpCollider, _mat, _col, _tint }) =>
      (x, z, l, bound, p) => {
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
      },
  },

  /**
   * ==== THE MID-STOREY, AND WHY IT IS APPENDED HERE ====
   *
   * These three are LAST, and that is the one structural fact about them. The
   * whole sector comes off a single seeded stream, so a layer inserted anywhere
   * above this point would re-roll every draw after it and move every plant in
   * the world; appended here, not one existing instance changes.
   *
   *   `palms` fills 8-12 m, which is the only band `sightlines.mjs` still
   *   reports as a hole and the one that got WORSE as the trees improved.
   *
   *   `bromeliads` plant the steep ground, which every other layer in this file
   *   hard-rejects and which in a rainforest is the lushest place there is.
   *
   *   `bigleaf` is the jungle cue at eye level: very few, very large.
   *
   * ONE LAYER FOR TWO PLANTS in the palms' case, split by the instance scale —
   * 0.58 is a five metre tree fern in deep shade and 1.42 is a twelve metre palm
   * with its crown just under the canopy. `pow(rng(), 0.7)` RATHER THAN A
   * UNIFORM DRAW is the only tuning number here that came straight off the
   * instrument: a uniform range puts as much of this layer at 5-7 m, where the
   * wood is already full, as at 9-12 m, where the hole is.
   */
  {
    id: 'palms',
    spacing: 6.2,
    make: ({ rng, character, trodden, submerged, slopeAt, heightAt, yawMatrix, push, _mat, _col, _tint }) =>
      (x, z, l, bound, p) => {
        if (slopeAt(x, z) > 0.52) return;
        const c = character(x, z);
        /**
         * `understorey` RATHER THAN RAW `canopy`, AND THE COUNT IS HELD.
         *
         * `(0.14 + canopy * 0.5) * (1 - litter * 0.45)` was the fourth near-copy
         * of the same shade ramp. Reading the biome instead puts the same number
         * of palms in a third of the places — and it is the layer where holding
         * the count matters most, because `sightlines.mjs` reports 8-12 m as the
         * one band still thin and this is the only thing that fills it.
         *
         * `trodden`, AND THIS ONE WAS FOUND BY COUNTING RATHER THAN BY LOOKING.
         * A census of the commons after the five obvious layers were gated still
         * showed three palms inside 12 m of the centre — a five-metre tree fern
         * standing where the screen is, from the 0.17 floor, on ground where
         * `understorey` is identically zero. It is the fourth constant floor in
         * this file to do exactly this (ferns 0.09, aroids 0.1, bushes 0.18): a
         * floor term is a promise that a layer appears everywhere, and a
         * gathering place is the one kind of "everywhere" that has to be an
         * exception.
         */
        const want = (0.17 + c.understorey * 1.0) * (1 - c.meadow * 0.5);
        if (rng() > want * trodden(x, z) * p) return;
        if (submerged(x, z)) return;
        const y = heightAt(x, z);
        const grow = 0.58 + Math.pow(rng(), 0.7) * 0.84;
        const gy = grow * rngRange(rng, 0.9, 1.12);
        yawMatrix(_mat, x, y - 0.15, z, rng() * TAU, grow, gy, grow);
        /**
         * THE TINT IS CORRELATED WITH THE HEIGHT, which is what turns one
         * geometry into two plants. A five-metre tree fern is standing in the
         * darkest part of the wood and a twelve-metre palm has its head in the
         * light under the canopy. It costs nothing — this is an instance colour
         * either way — and it is worth more than any amount of geometry, because
         * a stand in which every plant is the same value reads as one object
         * repeated however varied its silhouette is.
         *
         * THE HUE SWING WENT FROM 0.02 TO 0.075 IN THE GREEN-BAND SPLIT, and this
         * is the one layer that carries the split INSIDE itself rather than
         * against its neighbours: 119° in the dark and 92° in the light.
         */
        const tallT = (grow - 0.58) / 0.84;
        _tint.setHSL(
          0.33 - tallT * 0.075 + rngRange(rng, -0.03, 0.035),
          rngRange(rng, 0.28, 0.5),
          0.32 + tallT * 0.24 + rngRange(rng, -0.06, 0.08)
        );
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        const big = Math.max(grow, gy);
        push(l, _mat, _col, x, y - 0.15 + bound.cy * big, z, bound.r * big);
      },
  },

  /**
   * THE ONLY LAYER IN THIS FILE WHOSE SLOPE GATE IS THE RIGHT WAY UP.
   *
   * Every other rule here rejects above a slope of 0.30-0.50 and the sward is
   * separately zeroed under a closed canopy, so a steep shaded bank rejects every
   * layer in the world except rocks and sticks and comes out bald. That is
   * backwards twice over: a bank is the one surface in a rainforest that gets
   * light from the SIDE, and it is where the epiphytes that could not find a
   * branch end up. A cut slope in Amazonia is a wall of bromeliads.
   *
   * So this rule REQUIRES slope and gets denser as the ground steepens, which is
   * what makes it affordable at 2.1 m spacing: on the flat ground the player
   * actually walks over it does not exist.
   */
  {
    id: 'bromeliads',
    spacing: 2.1,
    make: ({ rng, character, submerged, slopeAt, heightAt, yawMatrix, push, _mat, _col, _tint }) =>
      (x, z, l, bound, p) => {
        const c = character(x, z);
        /**
         * THE RAMP WAS MEASURED, AND THE FIRST GUESS PRODUCED EXACTLY ZERO OF
         * THIS LAYER IN THE WHOLE WORLD.
         *
         * It read `clamp01((slope - 0.26) * 1.6)`, which does not reach 1 until a
         * slope of 0.885 — and this terrain's steepest square metre inside a
         * 440 m box measures 0.742. So the acceptance never got above 0.38
         * anywhere, and the layer counted 0 instances at all three stations.
         * Nothing reported it: a layer that places nothing looks exactly like a
         * layer that works.
         *
         *     < 0.05  75.1%     0.15-0.20   2.0%     0.30-0.40   1.0%
         *   0.05-0.10 13.6%     0.20-0.25   1.0%     0.40-0.60   0.9%
         *   0.10-0.15  5.3%     0.25-0.30   0.8%     > 0.60      0.3%
         *
         * The ramp now starts at 0.08 — a bank you would notice leaning into, not
         * a cliff — and is full by 0.24, which puts a real wall on 6.6% of the
         * ground rather than a rounding error on 3%.
         *
         * AND THERE IS A FLOOR UNDER THE CLOSED CANOPY, which is the half of this
         * rule that is not about slope at all. A steep bank is where the wall is;
         * the deep shaded floor is where the COLOUR is missing, and this is the
         * only layer in the file that can carry a saturated one.
         *
         * The floor term reads `understorey`, not raw `canopy`. The BANK term is
         * untouched and deliberately still keyed to `canopy`: it is a slope rule,
         * and a cut bank grows these whatever biome it is in.
         */
        const bank = clamp01((slopeAt(x, z) - 0.08) * 6.25) * (0.5 + c.canopy * 0.35);
        const want = Math.max(bank, c.understorey * 0.28) * (1 - c.damp * 0.35);
        if (rng() > want * p) return;
        if (submerged(x, z)) return;
        const y = heightAt(x, z);
        const g = rngRange(rng, 0.62, 1.8);
        const gy = g * rngRange(rng, 0.8, 1.2);
        // Sunk proportionally rather than by a constant. On a 0.5 slope the
        // ground falls 0.3 m across a 1.25 m card, so a rosette planted at the
        // sampled height shows a bright sliver of daylight under its uphill edge
        // from twenty metres away.
        const base = y - 0.11 * g;
        yawMatrix(_mat, x, base, z, rng() * TAU, g, gy, g);
        /**
         * NEARLY NEUTRAL, AND THAT IS THE WHOLE COLOUR ARGUMENT.
         *
         * The scarlet is in the canvas and the material colour is 0xffffff, so
         * this tint is the last chance to destroy it. Saturation is held at
         * 0.04-0.16 — enough for one rosette to be warmer than its neighbour, far
         * too little to drag a red texel toward green. Every other card layer in
         * the world does the opposite, and every other card layer in the world is
         * green.
         *
         * WHICH IS ALSO WHY THE HUE IS NOT PART OF THE GREEN-BAND SPLIT. At this
         * saturation the number is not a hue, it is a rounding error on a grey.
         * What DID move is the lightness: 0.58-0.94 was the brightest tint in the
         * world and it is a linear multiplier, so this layer was lit like a thing
         * in a spotlight on a floor that gets 1-2% of the roof's light.
         */
        _tint.setHSL(
          0.24 + rngRange(rng, -0.09, 0.09),
          rngRange(rng, 0.04, 0.16),
          rngRange(rng, 0.44, 0.8)
        );
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        const big = Math.max(g, gy);
        push(l, _mat, _col, x, base + bound.cy * big, z, bound.r * big);
      },
  },

  /**
   * ELEVEN METRE SPACING, WHICH MAKES THIS THE SPARSEST GREEN THING IN THE
   * WORLD, AND THAT IS THE DESIGN.
   *
   * A door-sized perforated leaf is the strongest "jungle, not wood" cue
   * available and it stops being one the moment there are enough of them to be a
   * texture. About a hundred and seventy resident against the meadow's ten
   * thousand: one every eleven metres of shaded floor, which is a thing you come
   * across.
   *
   * It is also the layer with the least right to spend anything. The 0.6-4 m
   * bands are the best-filled part of the wood already and near-field cards are
   * the ones that cover the screen, so this exists for the colour and the
   * silhouette rather than to stop a ray.
   */
  {
    id: 'bigleaf',
    spacing: 9,
    make: ({ rng, character, trodden, submerged, slopeAt, heightAt, yawMatrix, push, _mat, _col, _tint }) =>
      (x, z, l, bound, p) => {
        if (slopeAt(x, z) > 0.46) return;
        const c = character(x, z);
        // `understorey` rather than raw `canopy`, the fifth of the seven. The
        // aroids belong in the rank shaded corners, not on every square metre of
        // closed floor; `understorey` already carries the litter exclusion, so
        // the `1 - litter * 0.5` factor is gone rather than doubled.
        const want = (0.1 + c.understorey * 1.2 + c.damp * 0.5) * (1 - c.meadow * 0.7);
        /**
         * ==== THE PLANT THAT FILLED HALF OF `01-spawn.png` WAS THIS LAYER ====
         *
         * `bigLeafGeo` is 1.5 x 2.1 m and the instance scale reaches 1.6, so a big
         * one is 2.4 m across and 3.4 m tall — the largest card in the world by a
         * long way, and this rule could put one anywhere because of the `0.1`
         * floor. In the spawn glade every OTHER factor is zero, and the
         * `1 - meadow * 0.7` exclusion only takes it down to 0.03. One in three
         * sectors therefore grew a door-sized perforated aroid somewhere in the
         * glade, and the glade is 14 m across.
         *
         * The floor is not removed — a thing you come across should be findable in
         * odd places. What it must not do is stand in the one clearing whose whole
         * purpose is that you can see across it.
         */
        if (rng() > want * trodden(x, z) * p) return;
        if (submerged(x, z)) return;
        const y = heightAt(x, z);
        const g = rngRange(rng, 0.62, 1.6);
        const gy = g * rngRange(rng, 0.85, 1.15);
        yawMatrix(_mat, x, y - 0.06, z, rng() * TAU, g, gy, g);
        /**
         * Neutral for the same reason the bromeliads are: the Heliconia bract on
         * this card is the second-most saturated thing in the world and a green
         * tint over it is a dark maroon.
         *
         * 0.42-0.78 -> 0.30-0.60, WHICH IS THE SECOND HALF OF THE SPAWN PLANT.
         * `setHSL` with no colour-space argument writes LINEAR values, so this is
         * a reflectance multiplier and 0.78 was the brightest one left on the
         * floor. The lighting rebuild took sun:shade from 1.23 to 2.94 stops and
         * the floor is genuinely in shade, so a card at 0.78 does not read as a
         * pale leaf, it reads as an emitter — the same failure the fireflies
         * recorded from the other direction.
         *
         * The RANGE is held at 0.30 rather than compressed. This layer is meant
         * to be the thing your eye lands on.
         */
        _tint.setHSL(
          0.26 + rngRange(rng, -0.06, 0.06),
          rngRange(rng, 0.05, 0.18),
          rngRange(rng, 0.3, 0.6)
        );
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        const big = Math.max(g, gy);
        push(l, _mat, _col, x, y - 0.06 + bound.cy * big, z, bound.r * big);
      },
  },
];

/* ========================================================================== */

export const RAINFOREST = {
  id: 'rainforest',
  label: 'Rainforest',
  blurb: 'Kapok and palm over a bare, wet floor. Hot, close and very green.',
  roster: ROSTER,
  /**
   * THE EMERGENT — the species `treeSector` may promote to 2.2-2.8x as a
   * landmark you can arrange to meet somebody at.
   *
   * It is the widest bole in this roster and by a long way: `trunkRadius: 0.7`
   * in trees.js against the palm's 0.25 standing beside it. That is the whole
   * criterion, because a slender tree at two and a half times scale reads as a
   * stretched copy of its neighbours rather than as a different kind of thing —
   * and the kapok is already the tree this land calls its emergent.
   *
   * A land that omits this key gets no giants and nothing errors. See the giant
   * block in `treeSector`, which also explains why the promotion is drawn from
   * a second seeded generator rather than from the sector's own stream.
   */
  giant: 'kapok',
  speciesAt,
  treeScale: TREE_SCALE,
  density: DENSITY,
  weights: WEIGHTS,
  makeCharacter,
  ground: GROUND,
  layers: LAYERS,
  /**
   * The layers the `potato` rung does not draw at all. See the long block at
   * the `clutter` line in forest.js for the test — it is "would the wood be a
   * different place without it?", not "is this cheap" — and for why the taiga
   * answers it differently for two of these five.
   */
  clutter: new Set(['bramble', 'sticks', 'flowers', 'litter', 'reeds']),
  makeCoarse,
  understorey: UNDERSTOREY,
  /**
   * ==== WHICH ANIMALS LIVE HERE, AND WHY IT IS WRITTEN OUT ==================
   *
   * These are every row `fauna.js` holds, so this record is an identity filter
   * and `grove-01` cannot move by a bit: `BEASTS` filtered by all three of its
   * own names is `BEASTS`, and `WINGS` filtered by all seven of its own names
   * is `WINGS` in `WINGS` order — same list, same weights, same deal, same rng
   * stream. The gate for that is that `dealt` in `buildFauna` compares against
   * `WINGS[0]` by identity, so the morpho deal is on here and unchanged.
   *
   * IT IS WRITTEN OUT RATHER THAN OMITTED, and that is the same judgement the
   * `roster` field makes a hundred lines up. `fauna.js` does fall back to the
   * whole table when a land names nothing — it has to, because a land that
   * named nothing would otherwise be a wood with no animals in it and nothing
   * saying so — but relying on that here would mean the day somebody adds a
   * boreal hare row to `BEASTS`, it silently turns up in the Amazon. A land
   * that lists its animals cannot acquire one by accident.
   *
   * NO `coats`: the morph tables in fauna.js are this land's, unmodified. See
   * the taiga's block for what that field is for and why it is a morph list
   * rather than a base colour.
   */
  fauna: {
    kinds: new Set(['tapir', 'agouti', 'capuchin']),
    flutter: new Set(['morpho', 'owl', 'postman', 'zebra', 'julia', 'sulphur', 'swallowtail']),
  },
  /**
   * THE AIR, DECLARED AS AN IDENTITY SO THAT IT IS PROVABLY INVISIBLE HERE.
   *
   * A hemisphere scalar, a fog-density scalar and a fog-colour rotation, all
   * applied in `_recompose` where the day table is consumed. 1 and 1 multiply
   * to the number that was there; `tint: null` is a BRANCH that is not taken
   * rather than a lerp by zero, so no float in this land's frame is even
   * recomputed. See the taiga's block for what the three are and why they are
   * three scalars instead of a second `DAY_KEYS`.
   */
  air: { hemi: 1, fog: 1, tint: null },
  /**
   * Which sky this land asks `atmosphere.js` for. See the taiga's note — `air`
   * above is what actually carries the light; this is the name of the look.
   */
  sky: 'humid',
  /** No precipitation override: the rain system stays rain. */
  weather: null,
  /**
   * No `cardTex`: every card layer here is drawn on the canvas forest.js picks
   * for it. See the taiga's block — the field exists because a tint is a ratio
   * over a texture and cannot change its hue, and this is the land those
   * textures were drawn for.
   */
};
