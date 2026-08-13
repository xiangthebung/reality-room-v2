import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TAU, clamp01, makeRng, rngRange } from '../core/util.js';
import { leafCluster } from './textures.js';
import { BAND, BARK_U, bandUV, trunkAtlas } from './tree-adorn.js';
import { PLANT_SCALE, makeLiving, setPlantScale } from '../trip/living.js';

/**
 * Trees.
 *
 * Grown rather than modelled: a recursive branch system produces a skeleton, the
 * skeleton is swept into tapered tubes, and leaf cards are hung at the tips. A
 * handful of archetypes per species are grown at load and then instanced a few
 * hundred times each, so the forest has real variety for the cost of a dozen
 * geometries.
 *
 * TWO THINGS ARE DELIBERATE AND EASY TO LOSE.
 *
 * FLEX WEIGHTS. Every vertex carries `aFlex`, which is 0 at the root and 1 at
 * the outermost leaf. Wind, the trip's breathing and the lean-toward-you term
 * all multiply by it, which is the only reason those effects look like a plant
 * bending rather than a mesh being scaled. It is computed from the branch depth
 * and the fraction along each branch, not from world height — a low branch on a
 * big oak should whip more than the trunk at the same altitude.
 *
 * SPHERICAL LEAF NORMALS. The leaf cards' normals point outward from the centre
 * of their cluster rather than off the face of the quad. Flat quad normals make
 * a canopy read as a pile of cardboard because half the cards face away from the
 * sun and go black; spherical normals make the same cards shade as one soft
 * volume, which is what foliage actually does.
 *
 * A THIRD THING, NEWER AND JUST AS EASY TO LOSE: `aCore`. Every leaf vertex
 * carries how far out of the crown it sits, 0 at the middle and 1 at the rim,
 * and the RR_LEAF fragment block darkens by it. Without it every card in a
 * canopy is lit identically and carries the same constant emissive, so no part
 * of a crown is allowed to be dark — and a gap in a uniformly bright canopy
 * reads as a HOLE rather than as shade, which is most of why the crowns looked
 * like flat green clouds instead of volumes. See `normaliseCore` below.
 */

/** @typedef {{trunk: THREE.BufferGeometry, leaf: THREE.BufferGeometry}} TreeGeometry */

/**
 * A NOTE ON THE FOLIAGE NUMBERS, BECAUSE THEY WERE ALL RAISED AT ONCE.
 *
 * The canopy was measured at roughly one optical depth: the fraction of a leaf
 * card's texels that pass alphaTest ran 16.5% on pine, 21% on birch and willow
 * and 25% on oak, so a third of the rays fired into a crown came out the far
 * side, and on a pine it was closer to half. That is the whole of "the trees
 * are see-through" and most of "the crowns look like flat green clouds".
 *
 * WHAT IS FREE AND WHAT IS NOT — the distinction that shaped every number here.
 *
 * `count` and `width` in the `leaf` block below change only what is DRAWN ON
 * THE TEXTURE. The card is the same two triangles and the same square metres of
 * screen either way; a fragment that discards on alphaTest costs about what a
 * fragment that shades costs, so filling in the holes in the picture is not
 * merely free, it PAYS. Opaque fragments write depth and occlude the trunks and
 * crowns behind them, while alpha-test discards defeat early-Z — so a solid
 * canopy is cheaper than a see-through one, and the see-through one was being
 * paid for twice.
 *
 * Measured at 2560×1440, looking up into the crowns, with the card COUNTS held
 * at their old values so that coverage is the only variable: whole frame 3.02 ms
 * at 21% coverage, 2.34 ms at 41%. Filling in the holes took two thirds of a
 * millisecond OFF the frame. There is no reason to leave a card half empty.
 *
 * `leafPerBranch`, `leafOnBough` and `leafSize` are NOT free — every one of them
 * is more rasterised area, and at that station raising them all the way to the
 * densities that looked best put 1.5 ms back on. So they are raised second, by
 * about half of what the eye would like, and spent out of the surplus the free
 * lever produced: the net across the three test stations is +0.32 ms standing in
 * the clearing, −0.06 in the wood and −0.25 looking up.
 *
 * `length` was deliberately NOT raised on the broadleaves, and that is the one
 * dial with a trap in it. A leaf is placed at a radius of `LIMIT - length`, so a
 * longer leaf is a leaf placed further in; past about 1.3x the scatter collapses
 * onto the middle of the card and the biggest leaves start reaching into the
 * feathered border, which is where the canvas cuts them off in a dead straight
 * line. `width` costs nothing in reach — measured, the outermost opaque texel
 * does not move at all — because a leaf is drawn from its stem to its tip along
 * its own axis and the width is perpendicular to that. So the broadleaves got
 * fatter leaves rather than longer ones. See the LIMIT block in textures.js.
 */
/**
 * ==== VARIANTS: WHY EACH ARCHETYPE GETS ITS OWN CANOPY TEXTURE ============
 *
 * The wood had four leaf canvases in it — one per species, shared by every tree
 * of that species in the world — and three hex tints per species jittered a
 * little per instance. That is not a population, it is one tree with noise on
 * it, and it is why the canopy reads as a single green mass from the clearing.
 * It is also why nothing could be in flower: bake blossom into the one texture
 * and every rowan for twenty kilometres blooms on the same day.
 *
 * So a species now carries a `variants` table, one entry per archetype: its own
 * overrides into `leafCluster` (seed, hue, count, width, and any blossom or
 * fruit) and its own tint palette. `speciesMaterials` builds one leaf material
 * per entry.
 *
 *
 * THE OBVIOUS OBJECTION IS DRAW CALLS, AND IT DOES NOT APPLY HERE. THAT IS THE
 * WHOLE REASON THIS SHAPE WAS CHOSEN.
 *
 * A new material per variant normally means a new draw call per sector per
 * variant, and on a streamed world that is the one cost that is never worth
 * paying. It is free in this case because THE CANOPY MESHES ARE ALREADY SPLIT
 * PER ARCHETYPE: forest.js has run `addStreamed('leaf:<species>:<a>', …)` once
 * per archetype since the slab allocator was written, so there were already
 * twelve canopy InstancedMeshes sharing four materials. Giving each of them its
 * own material changes twelve draws into twelve draws — and three's program
 * cache keys on the shader and its defines rather than on the material, so it
 * does not add a program either: `renderer.info.programs.length` reads 68 before
 * and 68 after. Streamed meshes went 53 -> 62 across this whole pass and all
 * nine of those are the fifth species below, which is a separate decision with
 * its own justification.
 *
 * THE ALTERNATIVE — one atlas per species, sub-rect chosen per instance through
 * an instanced attribute — was designed and rejected, and it is worth writing
 * down why, because on paper it is the more sophisticated answer:
 *
 *   IT IS NOT CHEAPER. Four 1024² atlases of four cells is 16 MB of texture;
 *   fifteen 512² canvases is 15 MB. The texel count is the same number of
 *   variants either way, because that is what a variant costs.
 *
 *   IT IS LESS EXPRESSIVE. An atlas cell is a fixed fraction of a fixed canvas,
 *   so every variant of a species must be the same resolution and the same
 *   drawing scale. A separate canvas per variant can be anything.
 *
 *   THE MIP CHAIN LEAKS. An atlas of four cells is four cells that average
 *   together in the bottom three mips, and the canopy is a MINIFIED alpha-tested
 *   texture at almost every range that matters — a distant tree is 83 px tall.
 *   Bleeding a scarlet berry cell into the bare cell beside it tints every
 *   distant tree of that species pink, and it does it at exactly the range where
 *   nobody would think to look for the cause. Padding or a clamped mip range
 *   fixes it and both cost more than the problem the atlas was solving.
 *
 *   IT NEEDS A SHADER CHANGE. The per-instance sub-rect has to arrive as an
 *   instanced attribute and be applied in the vertex shader, which is living.js
 *   — a file with a long block comment about how many varyings the leaf layer
 *   exports and why four of them were just deleted. Spending one back to select
 *   a texture cell, when the meshes are already split the way the cells would
 *   be, is paying twice for the same partition.
 *
 * The one thing the atlas would buy is a variant chosen PER TREE rather than per
 * archetype, i.e. more than three states without more than three shapes. The
 * scatter already picks an archetype per tree uniformly, so per-archetype IS per
 * tree — what it costs is that all the trees in one state share one skeleton.
 * That is a real cost and it is why the rowan below spends two of its three
 * archetypes on flower rather than one: the blossom is the thing the eye goes
 * to, so it is the thing that must not repeat.
 */
/**
 * ==== THE ROSTER IS NEOTROPICAL, AND IT COST NOTHING TO MOVE IT ===========
 *
 * This table used to be pine, birch, oak, willow and rowan — a temperate
 * European wood — while `wildlife.js` next door carried twenty Amazonian
 * voices: piha, bellbird, oropendola, quetzal, potoo, toucan. The ears were in
 * the Amazon and the eyes were in Surrey, and no amount of extra life anywhere
 * else in the project could close a gap that big.
 *
 * THE FIVE SPECIES WERE RESHAPED IN PLACE RATHER THAN ADDED TO, and that is
 * the entire reason this change is free. The rowan block below the table used
 * to explain what a sixth species costs: nine streamed meshes, 11 MB of slab,
 * 11 MB of canvas. Five more species would have been forty-five meshes and a
 * hundred megabytes for a biome swap. Reshaping five entries is zero meshes,
 * zero programs, zero memory and zero draw calls — `speciesAt` still returns
 * five labels off the same single roll against the same ladder of thresholds,
 * so the set of trunks in the world is bit-for-bit the one that was there.
 *
 * THE MAPPING IS STRUCTURAL, NOT COSMETIC. Each old species was chosen for the
 * tropical one whose SHAPE it already had:
 *
 *   pine -> palm.      The only entry in the table with `levels: 1`, i.e. the
 *                      only tree here that does not branch — which is exactly
 *                      what a palm is. It also had `needle: true`, and the
 *                      sprig routine in textures.js draws a shoot with a comb
 *                      of blades down each side, which is a pinnate frond. A
 *                      palm was already sitting in this table under another
 *                      name; it needed a bare bole and a crown at the top.
 *   birch -> cecropia.  The pale-trunked fast pioneer of a temperate wood, and
 *                      cecropia is the pale-trunked fast pioneer of this one.
 *                      Its catkin adornment is already the right shape: a
 *                      cecropia's fruit is a bunch of hanging fingers.
 *   oak -> kapok.       `levels: 3` and the widest bole in the table — the
 *                      heaviest, most branched crown here. That is the
 *                      emergent, so it is the ceiba, and its acorn slot became
 *                      the woody seed pod.
 *   willow -> fig.      `droop: 0.85`, the highest in the table, and keyed to
 *                      wet ground. Hanging is a strangler fig's aerial roots.
 *   rowan -> brownea.   The small flowering tree that comes up where the canopy
 *                      opens. It stays exactly that; only the flower turns from
 *                      cream to scarlet.
 *
 * THE GREENS ALL MOVED DARKER AND DEEPER, and that is the second half of the
 * biome. A temperate canopy in summer is a pale yellow-green; a rainforest
 * canopy is close to black-green with a hard specular sheen on it, and the
 * light that reaches the floor has been through three layers of it. Every tint
 * palette below dropped roughly fifteen points of lightness and gained
 * saturation. This is free — a tint is an instance colour, and a darker one
 * costs the same multiply.
 *
 * ONE THING GOT MORE EXPENSIVE AND IT WAS PAID FOR IN THE SAME EDIT. The kapok
 * is an emergent, so it is taller than the oak it replaces (18-29 m against
 * 11-18). Height is a pure scale on an already-built geometry — the ring and
 * side counts do not move, so it is not one triangle more — but a taller tree
 * covers more screen. It is paid for by the palm, which took `branchStart` from
 * 0.2 to 0.86: nineteen of its twenty fronds used to be strung down the whole
 * length of the bole and are now packed into the top seventh of it, which is
 * both what a palm is and a large net reduction in rasterised canopy area over
 * the commonest tree in the world.
 */
const SPECIES = {
  /**
   * ==== PALM: THE COMMONEST STEM IN THE FOREST ==============================
   *
   * This is not licence. Palms genuinely are around a third of the stems in
   * much of Amazonia — Attalea, Euterpe, Astrocaryum, Oenocarpus — and a
   * rainforest that has none in it reads as a jungle drawn by somebody who has
   * only seen photographs of one. `speciesAt` gives this slot 38% of the wood,
   * which is very close to the real figure and was not adjusted to get there.
   *
   * A BARE BOLE AND A CROWN ON TOP, which is the whole silhouette and the whole
   * saving. `branchStart: 0.86` puts every frond in the top seventh of the
   * tree; a palm has no branches at all, so the twenty "boughs" here are the
   * twenty frond rachises radiating from one point, and `levels: 1` guarantees
   * none of them forks. `taper: 0.74` is the other half — a palm bole is a
   * near-parallel column, not a cone, and at the pine's old 0.13 the top of
   * this tree came to a point like a pencil.
   *
   * THE FROND IS THE SPRIG ROUTINE AND IT NEEDED ONE NUMBER CHANGED. The comb
   * of needles down a bowed shoot is already a pinnate leaf; what makes it a
   * palm rather than a conifer is that the blades are long and few instead of
   * short and dense. `length` 0.32 against the pine's 0.26 is close to the
   * ceiling the LIMIT block in textures.js warns about (past ~1.3x the scatter
   * collapses onto the middle of the card) and is deliberately just under it.
   */
  palm: {
    height: [16, 27],
    /**
     * ==== STATURE: THE CHEAPEST CUBIC METRE IN THIS FILE ======================
     *
     * Measured on the build before this pass, per archetype, as triangle area
     * bucketed by object-space height: only 4.4% of a palm's leaf area and
     * 12.8% of a cecropia's sits between 2 m and 12 m. Weighted by each
     * species' share of the wood, 87% of all the foliage in this forest is
     * above twelve metres. That single number is the whole of the report about
     * the empty band, and it says something specific: the band is not empty
     * because the trees lack detail, it is empty because every tree in the
     * table is TALL. `branchStart` 0.86 on a 16-27 m palm puts the lowest frond
     * at 13 m no matter what else is done to it.
     *
     * A rainforest is not a canopy over a void. It is four or five layers, and
     * the one at 3-10 m — the understorey of young palms and saplings waiting
     * for a gap — is the layer this world had none of.
     *
     * `stature` multiplies the drawn height, so an archetype can be a 7 m
     * understorey palm rather than a small copy of a 24 m one. IT IS FREE, and
     * more than free: leaf card area goes as the square of height, so the short
     * archetypes cost a QUARTER of what they replace. Nothing else here buys
     * mass in the band at a negative price, and it is what pays for the clump
     * crowns below, which are the one genuinely expensive thing added.
     *
     * It is a multiplier rather than a wider `height` range because the two are
     * not the same draw: widening [16, 27] to [7, 27] draws three numbers out of
     * one distribution and can easily give three tall palms. Height and stature
     * are independent, so a species reliably gets a spread of BOTH — and the
     * kapok, which must stay emergent, simply does not carry this key.
     */
    stature: [0.4, 1.06],
    // Slender. A 20 m Attalea is under half a metre through, where the pine
    // this replaces was 0.34 at the base of a flared bole.
    trunkRadius: 0.25,
    // Near-parallel: the crownshaft is barely narrower than the foot.
    taper: 0.74,
    branchStart: 0.86,
    branches: 20,
    // A frond is 3-4 m on a 20 m palm, so a tenth to a sixth of the height.
    // The pine's 0.17-0.34 would have given this tree eight-metre fronds.
    branchLength: [0.1, 0.18],
    // Arching. A palm crown is a shuttlecock: the outer fronds fall almost to
    // the horizontal and the inner ones stand up.
    droop: 0.55,
    levels: 1,
    leafPerBranch: 10,
    leafOnBough: 0,
    leafSize: [1.9, 3.1],
    // Grey-brown and ringed with old frond scars. Lighter than the pine's bark
    // because a palm bole catches what little light gets down here and is one
    // of the few pale verticals in the frame.
    bark: { hue: 34, sat: 13, light: 31 },
    /**
     * NO LIANAS AND NO EPIPHYTES, AND THAT IS A REAL BOTANICAL FACT RATHER
     * THAN A BUDGET DECISION — though it is also the budget decision, because
     * this is 38% of the wood and giving it vines would have cost more than
     * the other four species combined.
     *
     * Palms shed. A palm has no branches for a vine to hang from and its bole
     * drops its old frond bases, so anything that starts climbing one falls off
     * with the next frond. A stand of clean bare palm boles among festooned
     * broadleaves is what the real forest looks like, and it is also what makes
     * the festooned ones read as festooned — if everything is draped, nothing
     * is.
     */
    lianas: 0,
    epiphytes: 0,
    /**
     * STILT ROOTS, AND THIS IS THE SINGLE MOST VALUABLE OBJECT ADDED IN THIS
     * PASS, because of what it is attached to.
     *
     * The complaint was that the 2-12 m band is empty and every sight line down
     * the wood is clear. Thirty-eight per cent of the stems in this forest are
     * this entry, and the block above has just finished explaining that this
     * entry may not carry vines — so 38% of the wood was, by design, a bare
     * pole from the dirt to the crown. Whatever fills the band for a palm has
     * to be something a palm actually grows.
     *
     * A palm grows this. Socratea exorrhiza, Iriartea, Euterpe: a cone of
     * finger-thick roots leaving the bole a metre or two up and reaching the
     * ground a metre out, so the tree appears to be standing on a tripod with
     * daylight under it. It is one of the two or three silhouettes that say
     * "rainforest" on sight, and nothing else in this table has it.
     *
     * IT ONLY REACHES 2.5 m AND THAT IS NOT THE POINT. A sight line is broken
     * by the nearest thing that crosses it, and at eye level in a wood the
     * nearest things are at the FOOT of the trunks in front of you. Nine roots
     * on 38% of the stems, each splayed to 1.4 m, is a thicket of crossing
     * diagonals across the bottom of every long view — and diagonals are what
     * the frame had none of.
     */
    stilts: { count: 9, top: 2.5, reach: 1.4, thick: 0.05, spread: 0.55 },
    /**
     * The palm block above argues that nothing CLIMBS a palm, because the bole
     * sheds its old frond bases and takes whatever started up it along too.
     * That is an argument about vines, and it does not reach these: a bracket
     * fungus is eating the bole rather than clinging to it, and the two
     * rosettes are wedged in the fork where the stilt cone meets the trunk,
     * which is a pocket of litter and the one place on a palm that holds
     * anything. It also matters that this is 38% of the wood — a colour beat
     * that skips the commonest tree is a colour beat that skips the forest.
     */
    adorn: { rosettes: 3, shelves: 3, glowCount: 4 },
    glow: { colour: 0x2f7050, strength: 1.0 },
    /**
     * CLUMPING, WHICH IS THE PART THAT ACTUALLY REACHES THE BAND.
     *
     * Most of the commonest Amazonian palms — açaí above all, and Bactris,
     * Oenocarpus, Astrocaryum — are caespitose: one root mass throws up four or
     * five stems of different ages, so what you walk past is a clump of boles
     * of four different heights with four crowns stacked between 4 m and 20 m.
     * A single stem per palm is the one thing about this species that was
     * botanically wrong, and correcting it puts foliage in the empty band on a
     * third of the trees in the world.
     *
     * THE CROWNS ARE CUT DOWN HARD AND THAT IS A COST DECISION, not a shape
     * one. A sucker's crown is the only expensive thing in this whole pass:
     * swept wood is nearly free here, and leaf cards are alpha-tested area that
     * costs per pixel — and these particular cards land LOW, i.e. near the eye,
     * i.e. covering a lot of screen. So a sucker gets 8 fronds of 5 cards at
     * 0.6 size against the parent's 20 of 10 at 1.0, which is about a seventh
     * of the parent's rasterised area for a crown that reads as a whole palm.
     */
    clump: { count: 3, min: 1, at: [0.16, 0.44], offset: [0.7, 1.6], crowns: 8, leaves: 5, size: 0.6 },
    leaf: { hue: 134, sat: 40, light: 22, needle: true, count: 104, length: 0.32, width: 0.1 },
    tint: [0x5c7f5a, 0x486b48, 0x6b8c62],
    /**
     * Three palms, and they are three genera rather than three moods. The
     * variation the eye wants from a palm stand is "that one is a different
     * palm", because that is the variation a real one has — the crowns differ
     * far more than the boles do.
     */
    variants: [
      // Deep and blue-green: the shade-tolerant understory palm.
      { tint: [0x4a6b4c, 0x557a56, 0x3f5f44, 0x5f8460, 0x466851] },
      {
        // Taller, yellower, thinner-bladed: the ones that reach the light.
        leaf: { hue: 118, sat: 34, light: 27, count: 96 },
        tint: [0x6f8f5e, 0x7a9968, 0x648556, 0x849f72, 0x5d7e52],
      },
      {
        /**
         * In fruit. A palm's inflorescence hangs in a heavy bunch out of the
         * crownshaft, under the fronds, and it is one of the few strong warm
         * colours in a rainforest canopy — so it is worth the paint even though
         * this card is the busiest texture in the wood and a mark on it has to
         * beat the comb. `span` 0.58 off a `length` of 0.32 is the same
         * reasoning the pine cone used at 0.52: a bunch reads at about three
         * blade-lengths and disappears under two.
         */
        leaf: {
          hue: 128,
          count: 100,
          adorn: { kind: 'berry', count: 7, span: 0.58, hue: 26, sat: 72, light: 44 },
        },
        tint: [0x53764f, 0x5e8159, 0x486a46, 0x668a5e, 0x4f7250],
      },
    ],
  },
  /**
   * ==== CECROPIA: THE PALE TRUNK YOU NAVIGATE BY ============================
   *
   * A third of the wood, and it does the job the birch did: it is the one tree
   * whose TRUNK you can see from a distance. Everything else here is a dark
   * column in a dark room. Cecropia bark is chalk-white to pale grey and the
   * tree grows in every gap and along every bank, so a stand of them is a set
   * of white verticals in the middle distance — which, per the note in
   * `forest-hides-everything-under-40m`, is one of the very few things that
   * survives forty metres of this forest.
   *
   * CANDELABRA, NOT A CROWN. `droop: -0.25` and `branchStart: 0.58` give the
   * species its actual habit: a clean pole, then a few thick branches that go
   * UP and out at a wide angle, each ending in one rosette of enormous leaves.
   * `branches: 9` is deliberately sparse — a cecropia has a countable number of
   * limbs and you can see the sky between them, which is exactly the openness
   * a pioneer standing in a light gap should have.
   *
   * THE LEAVES ARE THE BIGGEST IN THE TABLE AND THERE ARE THE FEWEST OF THEM.
   * A cecropia leaf is a 60 cm palmate hand; the tree carries maybe forty of
   * them in total. `leafSize` up to 4.0 with `leafPerBranch: 7` is that shape,
   * and it is roughly cost-neutral against the birch — bigger cards, fewer of
   * them, and `count: 118` on the canvas draws each card as a few big hands
   * instead of two hundred small leaves, which is the free lever.
   */
  cecropia: {
    height: [13, 21],
    // See the palm's block. A pioneer is the one tree that is genuinely present
    // at every size at once, because it is the thing filling every gap at every
    // stage — so the species that most wants a range of statures is this one.
    stature: [0.45, 1.08],
    // Cecropias sucker hard from a cut or a fallen stem, and a clump of three
    // poles of different heights out of one base is the commonest form they
    // take in disturbed ground, which is where they all are.
    clump: { count: 2, min: 0, at: [0.2, 0.5], offset: [0.5, 1.2], crowns: 5, leaves: 5, size: 0.55 },
    trunkRadius: 0.2,
    // Straight and hardly tapered — the classic bamboo-like cecropia pole.
    taper: 0.46,
    branchStart: 0.58,
    branches: 9,
    branchLength: [0.22, 0.4],
    droop: -0.25,
    levels: 2,
    leafPerBranch: 7,
    leafOnBough: 2,
    leafSize: [2.6, 4.0],
    // The palest bark in the world by a wide margin, and that is the point.
    bark: { hue: 44, sat: 7, light: 58 },
    /**
     * Almost clean, and for the best reason in this file: a cecropia houses
     * colonies of Azteca ants in its hollow stem and they strip anything that
     * tries to grow on it. It is one of the few genuinely bare-trunked trees in
     * a forest where everything else is covered — which is lucky, because it is
     * also the tree whose PALE TRUNK is the one thing visible at forty metres,
     * and draping it would have deleted the only long-range landmark the wood
     * has. Two vines rather than none so it is not conspicuously exempt.
     */
    /**
     * FIVE RATHER THAN TWO, AND EVERY ONE OF THEM TIED TO A BOUGH TIP.
     *
     * The paragraph above is still right that a draped cecropia would delete
     * the only landmark this forest has past forty metres — but it was
     * answering the wrong question. What it protects is the BOLE, and a liana
     * anchored at `from.q` hangs from the far end of a limb, two to four metres
     * out from the bole and clear of it all the way down. The pale vertical
     * survives intact and the air beside it fills up.
     *
     * That distinction is worth five rather than two because of the arithmetic
     * in the liana block below: a cecropia's vines cost more of the frame than
     * a kapok's, since there are 8393 of them resident against 4721. This is
     * therefore the most expensive count in the table and also the one that
     * buys the most, because this species branches at 0.58 of 13-21 m — its
     * lowest limb is 8 to 12 m up, so a strand falling from it lands squarely
     * across the 2-12 m band and nothing else here does that as reliably.
     */
    lianas: 5,
    lianaFromTip: 0.85,
    epiphytes: 3,
    /**
     * Cecropia genuinely stands on prop roots — a low cone of them, not the
     * palm's tall tripod — and on a pole this clean they are most of what
     * happens between the litter and the first limb.
     */
    stilts: { count: 6, top: 1.5, reach: 0.8, thick: 0.045, spread: 0.4 },
    // Sparse, and NO GLOW: this species' bark is drawn at 58% lightness, so the
    // emissive-from-map separation that keeps the fungus glowing and the bark
    // dark is only threefold here instead of tenfold. See tree-adorn.js.
    adorn: { rosettes: 1, shelves: 2, glowCount: 0 },
    leaf: { hue: 96, sat: 36, light: 34, count: 118, length: 0.25, width: 0.95 },
    tint: [0x9ab884, 0x86a874, 0xa8c092],
    variants: [
      { tint: [0x8fae7e, 0x9cba88, 0x7f9f70, 0xa5c092, 0x88a878] },
      {
        /**
         * In fruit. A cecropia's fruit is a bunch of pale green fingers hanging
         * where the leaf stalks meet the branch, and the catkin routine draws
         * exactly that. Warmer and lighter than the leaf it hangs against,
         * because the birch note below this one is right about why the first
         * attempt at a catkin was invisible: physically correct and dull, on a
         * card that is already the same colour, is nothing.
         */
        leaf: {
          adorn: { kind: 'catkin', count: 9, span: 1.15, hue: 62, sat: 40, light: 62 },
        },
        tint: [0x93b17e, 0x9fbc8a, 0x87a674, 0xa8c294, 0x8dad7c],
      },
      {
        /**
         * THE SILVER UNDERSIDE, WHICH IS THE THING PEOPLE ACTUALLY NOTICE.
         *
         * A cecropia leaf is dark green above and near-white with felt
         * underneath, and because the leaves are held flat and the wind turns
         * them, a cecropia in a breeze FLASHES. The leaf cards here are
         * double-sided and randomly tilted, so a pale, desaturated variant with
         * the canopy tint pulled toward neutral reproduces the effect for free:
         * a third of the cecropias in any view are the light ones, and because
         * `living.js` moves every card on its own flex weight, the stand
         * shimmers rather than changing colour together.
         */
        leaf: { hue: 88, sat: 18, light: 52, count: 112 },
        tint: [0xc4cdb4, 0xd0d7c0, 0xb6c2a6, 0xcad2ba, 0xbcc7ac],
      },
    ],
  },
  /**
   * ==== KAPOK: THE EMERGENT =================================================
   *
   * The tree that comes out of the roof. A ceiba stands twenty metres clear of
   * a canopy that is itself forty up, and it is the single most recognisable
   * object in an Amazonian landscape — a grey column with a flat, wide, almost
   * horizontal crown floating above everything else.
   *
   * IT INHERITS THE OAK'S SKELETON BECAUSE THE OAK WAS ALREADY THE HEAVY ONE.
   * `levels: 3` is the deepest branching in the table and `trunkRadius` was
   * already the widest; both of those are what an emergent needs and neither is
   * a change. What changed is height, `droop` and the bark.
   *
   * `droop: -0.05` IS THE WHOLE SILHOUETTE. The oak's 0.05 was a very slightly
   * falling bough; a hair the other side of zero is a very slightly RISING one,
   * and combined with the third level of branching it produces the flat-topped,
   * layered, tabular crown that separates a ceiba from every other tree here.
   * It is one character of diff and it does more than anything else in the row.
   *
   * ON THE HEIGHT, WHICH IS THE ONE COST IN THIS TABLE. 18-29 m against the
   * oak's 11-18 is not one extra triangle — the geometry is built at a fixed
   * nine rings and seven sides and then scaled — but it is more screen. It is
   * affordable for two reasons: this species is 18.5% of the wood, the smallest
   * share of the four majors; and the extra height goes into a crown that is by
   * definition ABOVE the canopy, i.e. against sky, at long range, through fog,
   * where a leaf card is cheap. The palm's `branchStart` change pays for it
   * several times over.
   */
  kapok: {
    height: [18, 29],
    // Enormous. A real ceiba bole is three metres through; this is as far as
    // the number can go before `stumpCollider`'s 0.8 m contract with fauna.js
    // starts mis-filing the biggest trees in the wood as something other than
    // trees. See the block on that function in scatter.js.
    trunkRadius: 0.7,
    taper: 0.3,
    branchStart: 0.52,
    branches: 7,
    branchLength: [0.4, 0.66],
    droop: -0.05,
    levels: 3,
    leafPerBranch: 7,
    leafOnBough: 2,
    leafSize: [2.5, 4.3],
    /**
     * GREY-GREEN, WHICH IS NOT A STYLISATION. A young ceiba's bark is
     * photosynthetic and genuinely green-grey, and an old one weathers to pale
     * smooth grey. At `sat: 11` this reads as grey in shade and picks up a
     * green cast in the shafts, which is the correct behaviour and is why the
     * hue is set to a green rather than to the brown every other bark here uses.
     */
    bark: { hue: 96, sat: 11, light: 33 },
    /**
     * THE MOST HEAVILY LADEN TREE IN THE WOOD, which is what an emergent is: a
     * whole hanging garden held above the canopy, with a curtain of woody vine
     * dropping thirty metres out of it to the floor. This is the species where
     * the feature earns its triangles — the vines are long here because the
     * boughs they hang from are 15 m up, so they cross the entire frame from
     * top to bottom and are the strongest vertical in the world.
     *
     * FIVE RATHER THAN SEVEN since the strands learned to meander and loop, and
     * that is a gain rather than a cut — see the cost paragraph in the liana
     * block below, which is also where the arithmetic for this number is.
     */
    lianas: 8,
    epiphytes: 9,
    /**
     * THE BUTTRESS, WHICH IS THE OTHER SILHOUETTE EVERYONE KNOWS.
     *
     * A ceiba does not meet the ground, it FANS into it: six or eight vertical
     * walls of wood three or four metres tall running out from the bole, tall
     * enough to stand between and thin enough to see light through the gap. The
     * `ROOT_FLARE` rings already here are a swelling of the bole, which is a
     * different object and reads at two metres, not at twelve.
     *
     * WHY IT IS WORTH IT ON 18.5% OF THE WOOD, the smallest share of the four
     * majors: because it is on the BIGGEST object in the wood. A kapok is
     * 18-29 m and the widest bole in the table, so it is the tree the eye picks
     * out of any view, and its foot is currently a plain tube entering the
     * dirt. Six plates 2.6 m out is also 2.6 m of ground around every kapok that
     * you cannot see through or walk through, which is exactly the interruption
     * the long sight lines are missing.
     *
     * `squash` 0.17 against a plate half-width of 0.55 m is a fin about 19 cm
     * thick and 1.1 m across — see the block on `sweep` for why the thin axis
     * has to be pinned to the circumference rather than left to the frame.
     */
    buttress: { count: 6, top: 4.2, reach: 2.6, plate: 0.55, squash: 0.17 },
    // The most heavily laden tree in the wood, at its foot as well as in its
    // crown: the pockets between six buttresses are where an Amazonian forest
    // keeps its bromeliads, its ferns and its rot.
    adorn: { rosettes: 7, shelves: 4, glowCount: 5 },
    glow: { colour: 0x2b6b58, strength: 1.0 },
    leaf: { hue: 106, sat: 44, light: 24, count: 176, length: 0.19, width: 0.74 },
    tint: [0x6b8a5e, 0x5c7a52, 0x7a986a],
    variants: [
      { tint: [0x62825a, 0x6e8f64, 0x55744f, 0x789b6c, 0x5d8060] },
      {
        /**
         * In pod. A kapok's fruit is a woody capsule the size of a fist that
         * splits and lets out the floss the tree is named for. The cone routine
         * draws a scaled woody ovoid, which is the same object; `span: 0.9` is
         * larger than the pine cone's 0.52 because a pod is genuinely bigger
         * relative to the leaf beside it than a cone is relative to a needle.
         */
        leaf: {
          adorn: { kind: 'cone', count: 5, span: 0.9, hue: 30, sat: 34, light: 40 },
        },
        tint: [0x66865c, 0x718f66, 0x5a7a52, 0x7a9a6e, 0x628459],
      },
      {
        /**
         * IN FLOWER, AND LEAFLESS, WHICH IS THE REAL BEHAVIOUR AND THE BEST
         * THING IN THIS TABLE.
         *
         * A ceiba is deciduous in the dry season and it flowers on BARE wood —
         * so for a few weeks the biggest tree in the forest is a grey skeleton
         * covered in creamy flowers, standing above a canopy that is still
         * completely green. There is nothing else available here that gives a
         * single tree that much contrast against its own background.
         *
         * `count: 54` is the mechanism and it is the free lever from the note at
         * the top of the file used backwards. Dropping what is DRAWN on the card
         * from 176 marks to 54 does not change one triangle or one card; it
         * makes the canopy texture mostly transparent, so this archetype's
         * crown is a scatter of flowers on visible branch structure rather than
         * a mass of leaves. The tint goes nearly neutral for the same reason the
         * rowan's did: a cream petal under a green instance colour is a green
         * petal.
         */
        leaf: {
          hue: 84,
          sat: 22,
          light: 46,
          count: 54,
          adorn: { kind: 'blossom', count: 12, span: 0.95, hue: 42, sat: 30, light: 90 },
        },
        tint: [0xd8d4c4, 0xd0ccbc, 0xdedac8, 0xcbc7b8, 0xd5d1c0],
      },
    ],
  },
  /**
   * ==== FIG: THE ONE ON THE WET GROUND ======================================
   *
   * Keyed to `wet > 0.32`, so this is the tree on the stream bank, exactly
   * where the willow was. It keeps the willow's `droop: 0.85` — the highest in
   * the table by a factor of two — because on a willow that number was weeping
   * withies and on a fig it is AERIAL ROOTS, and the two read almost
   * identically at any distance: long thin wood falling straight down out of a
   * crown. A strangler fig on a bank with a curtain of roots into the water is
   * one of the images the word "Amazon" actually means.
   *
   * DARK AND GLOSSY. `leaf.light: 30` on a hue of 108 is the deepest green in
   * the table; a fig leaf is thick, waxy and nearly black in shade, and this is
   * the species that gets the least light of the five because of where it
   * grows. The tints go with it — this is the one entry whose palette is
   * allowed to be genuinely dark, because it is always seen against water or
   * against the pale cecropias behind it, and it needs to be the hole in the
   * middle of that.
   */
  fig: {
    height: [12, 19],
    // Wider than the willow's 0.4. A strangler's trunk is a fused basket of
    // roots and it is fat for its height.
    trunkRadius: 0.46,
    taper: 0.38,
    branchStart: 0.36,
    branches: 11,
    branchLength: [0.34, 0.56],
    droop: 0.85,
    levels: 2,
    leafPerBranch: 8,
    leafOnBough: 2,
    leafSize: [2.2, 3.6],
    bark: { hue: 30, sat: 10, light: 27 },
    /**
     * On a fig these are not lianas, they are the tree's OWN aerial roots, and
     * they are the reason this species kept the willow's droop of 0.85. Thick,
     * many, and dropping straight — a strangler on a bank with a curtain of
     * roots into the water is one of the images the word "Amazon" means. Same
     * geometry, different botany.
     *
     * SIX RATHER THAN EIGHT, for the reason the kapok's went 7 -> 5. This is
     * the one species where the loop is arguably wrong botany — an aerial root
     * grows down and does not swag back up — and it is kept anyway, because
     * two thirds of these strands are still plain falls and this tree needs to
     * read as festooned from the far bank rather than pass a botany exam.
     */
    lianas: 9,
    epiphytes: 6,
    // A strangler's foot is the one place both forms occur together: a fused
    // basket of roots that is part buttress and part prop, standing on and over
    // whatever it grew on. It is under 1% of the wood, so both are free here.
    buttress: { count: 5, top: 3.0, reach: 1.9, plate: 0.4, squash: 0.2 },
    adorn: { rosettes: 6, shelves: 3, glowCount: 5 },
    glow: { colour: 0x2a6b5e, strength: 1.0 },
    stilts: { count: 7, top: 3.2, reach: 1.7, thick: 0.07, spread: 0.5 },
    leaf: { hue: 108, sat: 40, light: 30, count: 178, length: 0.2, width: 0.62 },
    tint: [0x53704a, 0x475f42, 0x627f55],
    variants: [
      { tint: [0x4c684a, 0x567455, 0x415c40, 0x5f7d58, 0x496a52] },
      {
        /**
         * In fig. Figs grow in bunches straight out of the trunk and the older
         * wood — not at the tips — and they are the single most important food
         * source in this forest, which is why the toucans and aracaris in
         * `wildlife.js` exist. Scarlet on near-black is the highest-contrast
         * pairing anywhere in this table.
         */
        leaf: {
          adorn: { kind: 'berry', count: 9, span: 0.76, hue: 8, sat: 76, light: 42 },
        },
        tint: [0x506c4c, 0x5a7856, 0x456044, 0x628055, 0x4d6e50],
      },
      {
        // The young leaf flush. A fig puts out new leaves in a copper-pink
        // wave, all at once, over the whole crown — so this archetype is not a
        // dimmer version of the others, it is a different colour of tree.
        leaf: { hue: 44, sat: 38, light: 38, count: 172 },
        tint: [0xa88a6e, 0xb59578, 0x9b7e64, 0xc0a184, 0xa48870],
      },
    ],
  },
  /**
   * ==== BROWNEA: THE SMALL TREE IN THE GAP ==================================
   *
   * The rowan's job, unchanged, in a different genus. `speciesAt` still gates
   * this on `density < 0.7` — i.e. only where the canopy is broken — and every
   * word of the reasoning in that file still applies: a pioneer comes up in a
   * light gap and not under a closed roof, and a flowering tree is worth the
   * paint only where it can be seen against sky.
   *
   * WHAT CHANGED IS THE COLOUR OF THE FLOWER AND IT IS A LARGE CHANGE. A rowan
   * carries flat cream corymbs. A brownea — rose of Venezuela — carries a
   * scarlet ball the size of a fist, hanging under the leaves in the understory
   * gloom, and it is the brightest thing at eye level in a rainforest. Cream
   * against green is a pale patch; scarlet against near-black green is the only
   * genuinely saturated colour in this world that is not a bird.
   *
   * THE TINTS STAY NEARLY NEUTRAL and that is inherited wholesale from the
   * rowan, for the reason its block gives: the instance colour MULTIPLIES the
   * texel, so a scarlet petal under a green tint comes out brown. Painting the
   * true colour into the canvas and tinting near-neutral is what keeps scarlet
   * scarlet. Two of the three archetypes carry flower for the same reason the
   * rowan's did — the blossom is what the eye goes to, so it is the thing that
   * must not repeat.
   */
  brownea: {
    height: [7, 13],
    trunkRadius: 0.17,
    taper: 0.38,
    branchStart: 0.34,
    branches: 9,
    branchLength: [0.32, 0.54],
    // Held open and up, so the flowers are not hidden under the tree's own
    // canopy. Same reasoning as the rowan's -0.12.
    droop: -0.08,
    levels: 2,
    leafPerBranch: 8,
    leafOnBough: 2,
    leafSize: [1.7, 2.9],
    bark: { hue: 28, sat: 13, light: 36 },
    // A small tree in a light gap, so it carries little: a vine needs something
    // tall to climb and this is 7-13 m. The epiphytes are moss and small ferns
    // on the lower limbs, which is what a shaded understory tree actually gets.
    lianas: 4,
    epiphytes: 5,
    // The small tree in the gap already carries the only saturated colour in
    // this world that is not a bird. Giving it bromeliads too is not repetition
    // — the scarlet is 10 m up in the crown and these are at chest height.
    adorn: { rosettes: 4, shelves: 2, glowCount: 4 },
    glow: { colour: 0x306e4e, strength: 1.0 },
    leaf: { hue: 102, sat: 40, light: 31, count: 174, length: 0.18, width: 0.68 },
    tint: [0xc2c8ac, 0xccd0b4, 0xb8bfa2],
    variants: [
      {
        // In full flower. `sat: 88` is the most saturated number in this file
        // and it is on the smallest tree in it, in the darkest place it grows.
        leaf: {
          adorn: { kind: 'blossom', count: 9, span: 0.94, hue: 6, sat: 88, light: 52 },
        },
        tint: [0xd0ccbc, 0xc9c6b6, 0xd6d2c0, 0xc3c1b2, 0xd2ceba],
      },
      {
        // In pod. A brownea is a legume; the fruit is a flat brown pod.
        leaf: {
          adorn: { kind: 'catkin', count: 7, span: 0.8, hue: 26, sat: 44, light: 34 },
        },
        tint: [0xc6c9b0, 0xbdc2a8, 0xcfd1b8, 0xc1c5ac, 0xc9ccb4],
      },
      {
        // Coming into flower: fewer, smaller heads on a greener canvas, so the
        // three browneas in a view are not the same tree three times.
        leaf: {
          hue: 98,
          light: 29,
          count: 178,
          adorn: { kind: 'blossom', count: 4, span: 0.74, hue: 10, sat: 80, light: 48 },
        },
        tint: [0xbcc4a6, 0xc6cdae, 0xb2baa0, 0xc0c8aa, 0xaeb69c],
      },
    ],
  },
};

export const SPECIES_NAMES = Object.keys(SPECIES);

/**
 * Sweep a polyline into a tapered tube.
 *
 * Written out rather than using TubeGeometry because the radius has to vary per
 * ring (a branch is a cone, not a pipe) and because every vertex needs its flex
 * weight, which TubeGeometry has no way to carry.
 *
 * EVERY TUBE IN THIS FOREST USED TO BE INSIDE-OUT, AND THAT WAS THE WHOLE OF
 * "THE TRUNK IS A HOLLOW HALF-CYLINDER".
 *
 * The old index order was `(a, b, a+1), (b, b+1, a+1)`, which for this frame —
 * binormal = tangent × ref, normal = binormal × tangent, vertex at
 * normal·cos + binormal·sin — puts the right-hand face normal of every single
 * triangle POINTING INTO the tube. Measured, not deduced: 2160 of 2160 pine
 * triangles, 5940 of 5940 oak, disagreed in sign with the outward vertex normal
 * the same loop had just written two lines above.
 *
 * MeshLambertMaterial is FrontSide, so GL was culling the wall facing you and
 * drawing the inside of the wall behind it. On a closed convex tube that is
 * almost invisible — the silhouette is identical and the vertex normals were
 * outward, so the lighting still came from somewhere plausible — which is how it
 * survived this long. Everywhere the tube is NOT closed it is glaring:
 *
 *   - The open bottom. You are looking at the inside of the far wall, so the
 *     lower edge of the trunk is the FAR rim, which in perspective is a concave
 *     arc, and below it you can see the ground BETWEEN you and the tree through
 *     the missing near wall. Every trunk in the frame ended in a scooped-out
 *     crescent floating above the dirt. That is the photograph the user sent.
 *   - Branch bases. A bough starts on the trunk's centre line, so its open end
 *     is inside the bole and correctly hidden — but only by a bole you cannot
 *     see through, which this was not.
 *   - Depth. The drawn surface sits a diameter further away than the wood
 *     actually is, so anything tucked behind a trunk drew in front of it.
 *
 * Reversing the two winding orders costs nothing and fixes all of it. `logs` in
 * forest.js are a CylinderGeometry and were always wound correctly, which is why
 * a fallen log never looked like this and a standing tree always did.
 *
 * `capStart` / `capEnd` close the ends with a triangle fan. Nine sides means
 * seven triangles, so this is not a cost decision; the reason it is optional is
 * that a branch tip is 1–4 cm across and never worth even that.
 */
/**
 * `squash` AND `ref` EXIST FOR ONE OBJECT: A BUTTRESS.
 *
 * A ceiba's buttress is not a root, it is a PLATE — a thin vertical fin two or
 * three metres tall running from the bole out to the ground, and the thing that
 * makes it read is that it is wide in one axis and narrow in the other. Swept
 * round, at any radius that is tall enough to see, it is a fat pipe leaning on
 * the tree, which is a prop and not a buttress.
 *
 * So the cross-section may be an ellipse: `squash` scales the frame's NORMAL
 * axis, leaving the binormal at full radius. That is useless on its own,
 * because the frame this function builds is derived from the tangent and lands
 * wherever it lands — the flat of the plate would face a different direction on
 * every fin. `ref` pins it.
 *
 * PASS THE CIRCUMFERENTIAL AXIS, i.e. the one perpendicular to the vertical
 * plane the fin lives in, and not the fin's own outward radial. Both would give
 * the right ellipse; only this one is numerically safe. A buttress path runs
 * outward and downward, so near the ground its tangent is very nearly the
 * radial and `tangent × radial` collapses — the frame would spin through the
 * widest part of the plate. The circumferential axis is perpendicular to the
 * whole path by construction, so the cross product never degenerates. With that
 * reference, binormal comes out inside the radial-vertical plane (the plate's
 * wide axis) and normal comes out along the circumference (the thin one).
 *
 * THE NORMALS HAVE TO BE RE-DERIVED AND THIS IS THE PART THAT IS EASY TO MISS.
 * For a point at (a·cos, b·sin) in the (normal, binormal) basis, the outward
 * normal is (b·cos, a·sin) normalised — NOT (cos, sin). At a squash of 0.22 the
 * difference is a factor of four along one axis, so keeping the circular normal
 * lights a plate as though it were the pipe it is not: the flat faces come out
 * dark and the thin edges come out bright, which is the exact inverse of what a
 * fin does and reads as a smeared cylinder.
 */
function sweep(
  points,
  radii,
  flexes,
  phase,
  radial = 6,
  { capStart = false, capEnd = false, ref: refAxis = null, squash = 1, uvAt = null } = {}
) {
  const rings = points.length;
  const ringVerts = rings * (radial + 1);
  // One centre, plus a rim that repeats the seam vertex so the fan can be
  // indexed without a wrap-around special case.
  const capVerts = radial + 2;
  const count = ringVerts + (capStart ? capVerts : 0) + (capEnd ? capVerts : 0);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const flex = new Float32Array(count);
  const phases = new Float32Array(count);

  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const alt = new THREE.Vector3(1, 0, 0);
  let running = 0;
  /** The frames of whichever ends are being capped, kept for the fans below. */
  const ends = [];

  for (let i = 0; i < rings; i++) {
    const p = points[i];
    if (i < rings - 1) tangent.subVectors(points[i + 1], p).normalize();
    else tangent.subVectors(p, points[i - 1]).normalize();
    // Parallel-ish transport: pick whichever reference axis is least aligned
    // with the tangent, so a branch that turns straight up does not flip.
    // A caller-supplied `ref` overrides it unless it is nearly parallel to the
    // tangent, where the cross product would collapse and the frame spin.
    let ref = Math.abs(tangent.y) > 0.92 ? alt : up;
    if (refAxis && Math.abs(tangent.dot(refAxis)) < 0.9) ref = refAxis;
    binormal.crossVectors(tangent, ref).normalize();
    normal.crossVectors(binormal, tangent).normalize();
    if (i > 0) running += p.distanceTo(points[i - 1]);

    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * TAU;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const ox = normal.x * cos * squash + binormal.x * sin;
      const oy = normal.y * cos * squash + binormal.y * sin;
      const oz = normal.z * cos * squash + binormal.z * sin;
      // See the block above: (cos, squash·sin) rather than (cos, sin), because
      // the outward normal of an ellipse is not the direction of its point.
      let nx = normal.x * cos + binormal.x * sin * squash;
      let ny = normal.y * cos + binormal.y * sin * squash;
      let nz = normal.z * cos + binormal.z * sin * squash;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const idx = i * (radial + 1) + j;
      positions[idx * 3] = p.x + ox * radii[i];
      positions[idx * 3 + 1] = p.y + oy * radii[i];
      positions[idx * 3 + 2] = p.z + oz * radii[i];
      normals[idx * 3] = nx;
      normals[idx * 3 + 1] = ny;
      normals[idx * 3 + 2] = nz;
      /**
       * `BARK_U` is why the trunk texture is twice as wide as its tile: the
       * bark occupies the left half of the canvas and the right tenth is the
       * colour strip the adornments sample. See tree-adorn.js. Scaling u here
       * rather than repeating the texture keeps the tile exactly one turn
       * around the circumference, which is what it always was.
       *
       * `uvAt` pins every vertex of a sweep to one point of that strip, which
       * is how a swept tube comes out scarlet instead of woody.
       */
      uvs[idx * 2] = uvAt ? uvAt[0] : (j / radial) * BARK_U;
      uvs[idx * 2 + 1] = uvAt ? uvAt[1] : running * 0.35;
      flex[idx] = flexes[i];
      phases[idx] = phase;
    }
    if ((capStart && i === 0) || (capEnd && i === rings - 1)) {
      ends.push({
        first: i === 0,
        p: p.clone(),
        r: radii[i],
        n: normal.clone(),
        b: binormal.clone(),
        t: tangent.clone(),
        flex: flexes[i],
      });
    }
  }

  const indices = [];
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j;
      const b = a + radial + 1;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }

  let w = ringVerts;
  for (const end of ends) {
    // The cap faces along the tube's axis, away from the tube. Its vertices
    // cannot be shared with the ring's: those carry radial normals, which on a
    // disc would light it as though it were still the side of the cylinder.
    const facing = end.first ? -1 : 1;
    const put = (x, y, z, u, v) => {
      positions[w * 3] = x;
      positions[w * 3 + 1] = y;
      positions[w * 3 + 2] = z;
      normals[w * 3] = end.t.x * facing;
      normals[w * 3 + 1] = end.t.y * facing;
      normals[w * 3 + 2] = end.t.z * facing;
      uvs[w * 2] = uvAt ? uvAt[0] : u * BARK_U;
      uvs[w * 2 + 1] = uvAt ? uvAt[1] : v;
      flex[w] = end.flex;
      phases[w] = phase;
      return w++;
    };
    const centre = put(end.p.x, end.p.y, end.p.z, 0.5, 0.5);
    const rim = w;
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * TAU;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      // A disc of the bark tile rather than a slice of the tube's UV strip: the
      // strip's u runs 0..1 around the circumference, and fanning that into a
      // centre smears the grain into a star.
      put(
        end.p.x + (end.n.x * cos * squash + end.b.x * sin) * end.r,
        end.p.y + (end.n.y * cos * squash + end.b.y * sin) * end.r,
        end.p.z + (end.n.z * cos * squash + end.b.z * sin) * end.r,
        0.5 + cos * 0.5,
        0.5 + sin * 0.5
      );
    }
    for (let j = 0; j < radial; j++) {
      // (centre, j, j+1) faces along +tangent; the far end wants that and the
      // near end wants it reversed.
      if (end.first) indices.push(centre, rim + j + 1, rim + j);
      else indices.push(centre, rim + j, rim + j + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('aFlex', new THREE.BufferAttribute(flex, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geo.setIndex(indices);
  return geo;
}

/**
 * REJECTED: SAMPLING THE MELT AT THE CARD PIVOT INSTEAD OF AT EACH CORNER.
 *
 * The standard foliage practice, and it is right on the merits — Crytek's rule
 * from GPU Gems 3 ch. 16 is that wind is sampled at the pivot, never at the
 * shaded vertex. Two real prizes: a card would stop SHEARING (its four corners
 * currently evaluate the melt at four different world positions, which stretches
 * a quad that is supposed to be a rigid thing), and a 32-lane wave would issue
 * 8 unique lattice addresses instead of 32, which on an 8 MB LUT that misses L2
 * is worth something the fetch count does not show.
 *
 * It needs an `aPivot` attribute — the card's centre, three floats — and the
 * plan for paying for it was to delete two attributes that look free:
 *
 *   `aScale`, because setPlantScale fills it with ONE CONSTANT for the whole
 *   geometry, so it is four bytes fetched per vertex to deliver a number that
 *   never varies. THIS IS THE ONE THAT KILLS IT. `check-plants.mjs` finds every
 *   plant geometry in the scene by testing `geo.attributes.aScale`, and reads
 *   the value out of it to compute the displacement-to-height ratio that fails
 *   the build past 55%. That check exists for the worst artefact this project
 *   has had — every tuft of grass in the forest stretched into a spike pointing
 *   at the camera — and deleting the attribute would not break it, it would
 *   make it silently find nothing and pass. A regression test that passes
 *   because it stopped looking is worse than no test.
 *
 *   `uv`, because a merged grid of PlaneGeometry quads has uv exactly recoverable
 *   from gl_VertexID. That one is real, but it means overriding three's
 *   `uv_vertex` chunk, which is also where the emissive-uv work in living.js
 *   lives, and it is 8 bytes against the 12 needed.
 *
 * So the pivot would be +12 B on the frame's largest vertex layer against -8 B
 * at best, on a change of MEDIUM confidence that also alters how the canopy
 * deforms — and the brief for this pass allowed exactly one visible change, which
 * was spent on the colour field re-seeding. Revisit when the leaf vertex format
 * is being touched for another reason, and if you do, give check-plants.mjs a
 * different discriminator FIRST.
 */

/** One leaf card, with normals pointing away from the cluster centre. */
function leafCard(centre, position, size, tilt, flexValue, phase) {
  const geo = new THREE.PlaneGeometry(size, size);
  geo.rotateZ(tilt.z);
  geo.rotateX(tilt.x);
  geo.rotateY(tilt.y);
  geo.translate(position.x, position.y, position.z);

  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    n.set(pos.getX(i), pos.getY(i), pos.getZ(i)).sub(centre);
    if (n.lengthSq() < 1e-6) n.set(0, 1, 0);
    n.normalize();
    nrm.setXYZ(i, n.x, n.y, n.z);
  }
  const count = pos.count;
  geo.setAttribute('aFlex', new THREE.BufferAttribute(new Float32Array(count).fill(flexValue), 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(count).fill(phase), 1));
  return geo;
}

/**
 * Tag the merged canopy with how far out of itself each vertex sits: `aCore`,
 * 0 in the heart of the crown and 1 at its rim.
 *
 * Done on the MERGED geometry rather than per card, because the thing it has to
 * be measured against — how far this particular tree's crown actually reaches —
 * is not known until the last card has been hung.
 *
 * THE NORM IS ELLIPSOIDAL, AND THAT IS NOT FASTIDIOUSNESS. A crown is nothing
 * like a ball: a pine's foliage is seventeen metres tall and seven wide.
 * Normalising a plain radius by its maximum therefore divides everything by the
 * distance to the LOWEST bough, and the measured result was a canopy whose
 * median vertex came out at 0.00 and whose 95th percentile came out at 0.28 —
 * that is not an interior, it is the whole tree dimmed by a constant, which is
 * the one thing this must not be. Measuring the horizontal and vertical reaches
 * separately and taking the radius in those units puts the rim at 1 in every
 * direction, which is what "rim" means.
 *
 * THE FLOOR IS AN OFFSET, NOT A CLAMP. Cards hang on branch TIPS, so even with
 * the shape corrected they cluster in a shell rather than filling a solid; the
 * inner third of the ellipsoid is nearly empty and mapping it to output range
 * wastes most of the effect on values nothing has. CORE_INNER slides the band
 * out to where the foliage actually is.
 *
 * Squared, finally, because light falls off through foliage the way it falls off
 * through anything that absorbs: fast. A linear ramp puts the half-dark contour
 * halfway out of the crown, which is much further out than the eye expects a
 * shadow to start, and reads as dirt on the tree rather than as depth in it.
 */
const CORE_INNER = 0.3;

function normaliseCore(geometry, centre) {
  const pos = geometry.attributes.position;
  const n = pos.count;
  const core = new Float32Array(n);
  let maxH = 1e-3;
  let maxV = 1e-3;
  for (let i = 0; i < n; i++) {
    const h = Math.hypot(pos.getX(i) - centre.x, pos.getZ(i) - centre.z);
    const v = Math.abs(pos.getY(i) - centre.y);
    if (h > maxH) maxH = h;
    if (v > maxV) maxV = v;
  }
  for (let i = 0; i < n; i++) {
    const h = Math.hypot(pos.getX(i) - centre.x, pos.getZ(i) - centre.z) / maxH;
    const v = Math.abs(pos.getY(i) - centre.y) / maxV;
    const t = clamp01((Math.hypot(h, v) - CORE_INNER) / (1 - CORE_INNER));
    core[i] = t * t;
  }
  geometry.setAttribute('aCore', new THREE.BufferAttribute(core, 1));
  return geometry;
}

/**
 * Grow one tree.
 *
 * The branch loop is iterative rather than recursive over a stack of segments,
 * which keeps the flex bookkeeping in one place: a child branch inherits its
 * parent's flex at the attachment point and ramps to 1 at its own tip.
 */
/**
 * Every other ring, for the far silhouette.
 *
 * Both the trunk (eleven rings, of which the bottom two are the root flare
 * below) and a branch (seven) have an odd count, so a stride of two keeps the
 * first AND the last — the far version starts and ends exactly where the full
 * one does, which is what stops the two disagreeing about where a tree's tips
 * are when a bucket crosses the level-of-detail boundary. What is thrown away is
 * intermediate samples of a single slow arc, which at 170 m is well under a
 * pixel of curve.
 *
 * THE ODD COUNT IS A CONSTRAINT ON THE ROOT FLARE, not a coincidence it happens
 * to satisfy. Two rings were added below the origin, not one and not three,
 * because an even total drops the topmost ring and the far tree would then be
 * shorter than the near one by its last segment.
 */
const everyOther = (a) => a.filter((_, i) => i % 2 === 0);

/**
 * THE BOLE CONTINUES BELOW THE GROUND LINE, AND WIDENS AS IT GOES.
 *
 * forest.js sinks a tree 0.25 m (`spot.y - 0.25`) and that is all the burial
 * there was. It is not enough for three separate reasons and they compound.
 *
 *   THE WORLD IS HILLY. `spot.y` is the analytic height at the trunk's own
 *   centre, so on a slope the ground falls away from that height in the downhill
 *   direction — at the 0.32 gradient the steepest authored tree stands on, the
 *   dirt is already 0.3 m below the trunk's centre height at the edge of its own
 *   bole, which eats the entire 0.25 m and then some. The rim comes out of the
 *   hillside on the low side.
 *
 *   INSTANCES SHRINK. The scatter scales trees 0.50–1.48, and the 0.25 m is
 *   applied to the instance ORIGIN, so it does not shrink with the tree — but
 *   everything measured in object space does. A metre of buried root is 0.50 m
 *   on the smallest tree. That is fine and it stayed fine when the range was
 *   widened downward: the bole whose rim has to stay buried shrinks by the same
 *   factor, and so does the distance downhill the ground falls away across it,
 *   so the RATIO the paragraph below measures is scale-invariant. The 0.25 m
 *   sink is the only term that does not shrink, and it is a help.
 *
 *   THE BOLE IS WIDE. Burial has to hold at the RIM, not at the axis, and an
 *   oak's flared base is nearly a metre of radius before the instance scale
 *   touches it — so the relevant ground height is the one a metre downhill of
 *   where the tree was placed, not the one under its middle.
 *
 * Checked rather than argued: walking all 2960 authored trunks and sampling the
 * analytic ground at twelve points around the bottom ring, 583 of them had the
 * rim above the dirt somewhere before this and 25 do now — and those 25 show a
 * disc of bark rather than a hole, because of the cap. (The drawn ground is not
 * a suspect: sampled against `heightAt` at six places it agrees to 4 mm.)
 *
 * So the tube runs on down to 0.78 m below the origin (over a metre of burial
 * even at the smallest scale, on top of the 0.25 m sink) and swells 44% wider
 * than the bole as it does. The swell is not only insurance: where a slope DOES
 * expose part of it, what comes out of the hillside is a root spreading into the
 * ground rather than a cut pipe, which is the difference between a tree and a
 * pencil pushed into the dirt. It is nine triangles a ring.
 *
 * Ordered SHALLOWEST FIRST, because each one is unshifted onto the front of the
 * ring list and unshifting reverses. Deepest-first reads better and produces a
 * polyline that goes down 0.3 m, back down to 0.78, and then up past both of
 * them to the base — a bole that doubles back through itself, whose middle
 * segment is inside-out because its tangent is reversed. The winding audit in
 * the scratch probe caught it as exactly nine wrong triangles in the flare, and
 * nothing else would have: from outside it is a solid, plausible, slightly
 * lumpy root that happens to be lit from the wrong side.
 */
const ROOT_FLARE = [
  { drop: 0.3, swell: 1.16 },
  { drop: 0.78, swell: 1.44 },
];

/**
 * How many boughs the far version keeps, at most.
 *
 * NOT a triangle budget — a VERTEX one, and the distinction is the whole reason
 * this number exists. Reducing a sweep from seven sides to three cuts its
 * triangles by 57% but its vertices by only 50%, and `living.js` runs several
 * octaves of noise per vertex for the melt, so a low-radial sweep is a much
 * worse deal than its triangle count suggests. Measured: the far trunks cost
 * 0.97 ms of GPU for 1.47 M triangles where the rest of the frame runs at less
 * than half that per million.
 *
 * A pine has twenty-four boughs under a dense needle canopy that hides all of
 * them; an oak has seven big ones and half its character is their bare
 * silhouette. So the cap bites on exactly the species where it costs nothing
 * and leaves oak, birch and willow untouched at seven to eleven.
 */
const FAR_BRANCHES = 8;

export function growTree(seed, speciesName) {
  const spec = SPECIES[speciesName];
  const rng = makeRng(seed);
  const stature = spec.stature ? rngRange(rng, spec.stature[0], spec.stature[1]) : 1;
  const height = rngRange(rng, spec.height[0], spec.height[1]) * stature;
  /**
   * THE LEAVES HAVE TO COME DOWN WITH THE TREE, and forgetting it was visible
   * from thirty metres.
   *
   * `leafSize` is in METRES, not in fractions of the tree, because until now
   * every tree of a species was roughly one size — so a stature of 0.45 gave a
   * six-metre cecropia still carrying four-metre leaf cards, and the deep-wood
   * station came back full of enormous flat plates hanging in mid-air with a
   * sapling under them. It reads as scenery in the wrong scale, which is
   * exactly what it is.
   *
   * Softened rather than proportional, because a young plant genuinely does
   * carry leaves large for its size — this is most of what a seedling looks
   * like. A quarter of the size is kept fixed and three quarters follows the
   * tree, so a 0.45 archetype gets 59% leaves rather than 45%.
   *
   * It is also the third time `stature` has paid for itself: card area goes as
   * the square of this, so the short archetypes cost about a third of what the
   * tall ones do rather than the two thirds height alone would have given.
   */
  const leafScale = 0.25 + 0.75 * stature;
  const trunkParts = [];
  /**
   * The same tree with its detail thrown away, for everything past 200 m.
   *
   * TRUNKS ARE 89% OF THE WORLD'S TRIANGLES. Measured on this build: 7.32 M of
   * trunk against 0.92 M of leaf in one frame, with individual trunk geometries
   * running 2160–5940 triangles against 240–516 for their foliage. So when the
   * forest became endless and the frame went from 8.8 M triangles to 35 M,
   * essentially all of the increase was branches on trees too far away to
   * resolve one.
   *
   * At 200 m a fifteen-metre tree is 83 pixels tall and its boughs are one or
   * two wide, and the sober fog is passing 3% of the light — so the boughs are
   * being drawn at a couple of pixels and a few per cent of contrast, at
   * roughly nine tenths of the cost of the entire forest. This keeps the bole
   * and the first level of branches at three or four sides instead of nine and
   * seven, drops the second and third levels entirely, and comes out at about a
   * tenth of the triangles.
   *
   * The LEAVES ARE NOT REDUCED and that is the point of doing it this way. The
   * canopy is the silhouette — it is what a distant tree actually is — and it
   * is already cheap. What is thrown away is the structure inside and below it,
   * which at that range is hidden by the foliage or invisible outright, so the
   * two versions of a tree differ in nothing the eye is looking at.
   */
  const farParts = [];
  const leafParts = [];
  const canopyCentre = new THREE.Vector3(0, height * 0.72, 0);

  /**
   * ==== PERSONALITY: THE THREE ARCHETYPES ARE NOW THREE TREES ===============
   *
   * The report was "every trunk is the same diameter and the same perfectly
   * vertical line", and taken literally that is false — `height` varies, `lean`
   * varies, and the scatter scales each instance 0.50-1.48. Taken as what the
   * eye actually sees it is exact, and the reason is that all three of those
   * are SIMILARITY transforms. Scaling a tree by 1.3 gives a tree 30% taller
   * that is 30% fatter in the same proportion, so its outline against the
   * canopy is the identical outline drawn larger. A stand of those is one tree
   * printed at several sizes, which is precisely what a plantation looks like.
   *
   * What changes an outline is a change of RATIO, and there was none anywhere:
   * `trunkRadius` is a species constant, so every palm in the world is exactly
   * as slender for its height as every other palm.
   *
   * These four draws break that. `girth` is the important one — it moves the
   * bole's thickness independently of the tree's height, so one archetype of a
   * species is a thick short-looking column and another is a whip. `leanScale`
   * roughly triples the top of the old lean range, `sway` gives the bole its
   * own amount of wander rather than a fixed one, and `branchLow` slides where
   * the crown starts, which is the other half of a silhouette.
   *
   * DRAWN FIRST, AND WHY THAT IS SAFE HERE. The note on `trunkPhase` below
   * forbids adding draws to this stream, but what it is protecting is the
   * authored scatter's own stream in scatter.js, which is a different generator
   * — this one is seeded per archetype from `${seed}:${name}:${a}`. Nothing
   * outside this function reads it, and `authored-check.mjs` hashes instance
   * TRANSFORMS, not vertices. So the archetypes' shapes may move; where the
   * trunks stand may not, and this cannot touch that.
   */
  /**
   * `girth` HAS A CEILING THAT DEPENDS ON THE SPECIES, and it is a physics
   * contract rather than taste.
   *
   * `stumpCollider` in scatter.js gives every trunk a collision radius of
   * `max(0.82, 0.62 * instanceScale)` — a number that knows nothing about how
   * wide the bole actually is. The kapok entry already records that its 0.70 m
   * radius is as far as that number can be pushed; multiplying it by 1.44 would
   * put a metre of visible bark outside the cylinder the body stops at, and you
   * would walk into the side of the biggest tree in the wood.
   *
   * So the ceiling is whatever keeps the base radius under the collider, and it
   * only bites on the two fat species: kapok clamps to 1.17 and fig to 1.44,
   * which is the unrestricted value anyway. The FLOOR is untouched — a thin
   * kapok is free and is most of what this draw is for, because the variation
   * the eye wants from a stand is that not all of them are the big one.
   */
  const girth = rngRange(rng, 0.68, Math.min(1.44, 0.82 / spec.trunkRadius));
  // Up to about twice the old ceiling and not three times: at 2.9 the top of a
  // 20 m bole is five metres off its own foot, which past a certain angle stops
  // reading as a tree that grew toward the light and starts reading as a tree
  // that is falling over — and because this is drawn per ARCHETYPE, a view with
  // three of them in it gets three at the same angle.
  const leanScale = rngRange(rng, 0.35, 2.0);
  const sway = rngRange(rng, 0.5, 2.3);
  const branchLow = rngRange(rng, -0.09, 0.05);

  // ---- trunk --------------------------------------------------------------
  const trunkRings = 9;
  const trunkPoints = [];
  const trunkRadii = [];
  const trunkFlex = [];
  const leanDir = rng() * TAU;
  const lean = rngRange(rng, 0.02, 0.09) * leanScale;
  for (let i = 0; i < trunkRings; i++) {
    const t = i / (trunkRings - 1);
    // A trunk is never straight. A slow sway plus a small random walk gives the
    // silhouette the irregularity that separates a tree from a lamppost.
    const bend = Math.pow(t, 1.6) * height * lean;
    trunkPoints.push(
      new THREE.Vector3(
        Math.cos(leanDir) * bend + Math.sin(t * 5.1 + rng()) * 0.14 * height * 0.06 * sway,
        t * height,
        Math.sin(leanDir) * bend + Math.cos(t * 4.3 + rng()) * 0.14 * height * 0.06 * sway
      )
    );
    // Root flare: the bottom fifth widens quickly, which is a strong cue that
    // the tree is growing out of the ground rather than resting on it.
    const flare = 1 + Math.pow(Math.max(0, 1 - t * 5), 2.2) * 0.85;
    trunkRadii.push(spec.trunkRadius * girth * (1 - t * (1 - spec.taper)) * flare);
    trunkFlex.push(Math.pow(t, 2.4) * 0.55);
  }
  /**
   * THE CROWN CENTRE FOLLOWS THE BOLE, which it did not have to before because
   * the bole barely moved.
   *
   * `canopyCentre` is what every leaf card's normal points away from and what
   * `normaliseCore` measures the crown's rim against, and it was pinned at the
   * origin — fine at the old lean of at most 0.09, where the top of a 20 m tree
   * is 1.8 m off axis. `leanScale` takes that to 5 m, and a centre 5 m out of
   * the middle of its own crown puts one flank of every leaning tree at core 0
   * and the other at core 1: half the canopy lit as deep interior, half as rim,
   * along a straight line. Reading it off the trunk top costs nothing and is
   * more correct than the constant was even before the lean was widened.
   */
  canopyCentre.x = trunkPoints[trunkRings - 1].x * 0.72;
  canopyCentre.z = trunkPoints[trunkRings - 1].z * 0.72;
  /**
   * The phase is drawn ONCE and reused by both versions.
   *
   * Not thrift — correctness. `rng()` inline here is a draw from the same
   * stream that decides every branch angle, every leaf position and every
   * subsequent tree in the authored scatter, so adding a second draw for the
   * far geometry would shift the entire world by one number. The authored
   * forest is signed off and `authored-check.mjs` hashes all 32 369 of its
   * instances; nothing in this file may consume an extra random.
   */
  const trunkPhase = rng();

  /**
   * The root flare, prepended. See ROOT_FLARE.
   *
   * NOT DRAWN FROM THE RNG, and that is the same rule the phase above is
   * subject to: these rings are a pure function of the base ring, so the stream
   * that decides every branch angle and every leaf position in this tree is
   * untouched and an archetype grown after this change differs from the one
   * before it only by the geometry deliberately added.
   */
  const baseX = trunkPoints[0].x;
  const baseZ = trunkPoints[0].z;
  const baseRadius = trunkRadii[0];
  for (const { drop, swell } of ROOT_FLARE) {
    trunkPoints.unshift(new THREE.Vector3(baseX, -drop, baseZ));
    trunkRadii.unshift(baseRadius * swell);
    // Flex 0: this is the part of the tree that is holding on to the ground.
    trunkFlex.unshift(0);
  }

  /**
   * Both ends closed.
   *
   * The bottom is the one that matters and it is capped even though the flare
   * above should keep it underground: burial is a claim about the terrain and
   * the cap is a guarantee about the mesh. Where the two disagree — a steeper
   * slope than any authored tree stands on, a chunk boundary, a tree the
   * streamed field puts somewhere the authored scatter never would — the worst
   * case is now a disc of bark at the foot of the trunk instead of a hole you
   * can see the far wall of. Seven triangles.
   *
   * The top is capped for a smaller version of the same reason: the last ring
   * is 0.22 m across on an oak, so an uncapped one is a 44 cm well that you look
   * straight down into from anywhere uphill and straight up into wherever the
   * canopy is thin.
   */
  trunkParts.push(
    sweep(trunkPoints, trunkRadii, trunkFlex, trunkPhase, 9, { capStart: true, capEnd: true })
  );
  // The far version gets the bottom cap only. It is four triangles and it is
  // what stops a distant trunk flickering a hole at the horizon; the top of a
  // trunk 170 m away is under a pixel and nothing can be seen through it.
  farParts.push(
    sweep(everyOther(trunkPoints), everyOther(trunkRadii), everyOther(trunkFlex), trunkPhase, 4, {
      capStart: true,
    })
  );

  /**
   * `t` is still a fraction of the ABOVE-GROUND trunk, so every branch lands
   * exactly where it landed before the flare was added. The offset is the whole
   * of the difference: without it a `t` of 0 would attach a bough to a root.
   */
  const pointOnTrunk = (t) => {
    const idx = ROOT_FLARE.length + clamp01(t) * (trunkRings - 1);
    const i0 = Math.floor(idx);
    const i1 = Math.min(trunkPoints.length - 1, i0 + 1);
    return trunkPoints[i0].clone().lerp(trunkPoints[i1], idx - i0);
  };

  /**
   * ==== THE FOOT OF THE TREE ================================================
   *
   * Buttresses, stilt roots and clump stems, in that order, all of them swept
   * tube going into `trunkParts` and none of them into `farParts`.
   *
   * WHY THIS IS THE CHEAPEST PART OF THE PASS AND THE MOST VISIBLE. The measured
   * split on this build is that trunks are 73% of the frame's triangles and 8%
   * of its marginal cost, while leaf cards cost twenty-one times more per
   * triangle because they are alpha-tested and pay per PIXEL. Everything in
   * this block is trunk: a buttress is 40 triangles, a stilt root 32, and a
   * kapok's six plus a palm's nine come to well under a thousand between them,
   * against the 2160-5940 the bole and boughs already cost. The whole block is
   * inside the noise of the cheap layer, and it is the layer that occupies the
   * bottom three metres of every frame.
   *
   * NONE OF IT REACHES THE FAR GEOMETRY, for the reason the liana block gives:
   * past 170 m a fifteen-metre tree is 83 px tall, so a 5 cm root is a fifth of
   * a pixel and a buttress is two. Adding them there would double the cost of
   * the only tree layer that is genuinely expensive per triangle.
   */
  const trunkAt = (y) => pointOnTrunk(y / height);

  const but = spec.buttress;
  if (but) {
    const spin = rng() * TAU;
    for (let i = 0; i < but.count; i++) {
      const a = spin + (i / but.count) * TAU + rngRange(rng, -0.2, 0.2);
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const top = but.top * rngRange(rng, 0.7, 1.18);
      const reach = but.reach * rngRange(rng, 0.76, 1.22);
      const plate = but.plate * rngRange(rng, 0.78, 1.24);
      const hug = baseRadius * 0.8;
      const rings = 6;
      const pts = [];
      const radii = [];
      const flexes = [];
      for (let k = 0; k < rings; k++) {
        const s = k / (rings - 1);
        /**
         * A QUARTER CIRCLE, and the two exponents are what make it a buttress
         * rather than a prop. The path leaves the bole going straight DOWN and
         * arrives at the ground going straight OUT, so `sweep`'s frame rotates
         * a right angle along it — and because the plate's wide axis is the
         * binormal, the fin is a radial flange where it meets the trunk and a
         * long ground ridge where it lands, which is the two halves of the
         * real object. A straight line between the same endpoints gets neither.
         */
        const th = s * Math.PI * 0.5;
        const horiz = hug + (reach - hug) * Math.pow(Math.sin(th), 1.3);
        const y = -0.32 + (top + 0.32) * Math.pow(Math.cos(th), 0.85);
        const on = trunkAt(y);
        pts.push(new THREE.Vector3(on.x + dx * horiz, y, on.z + dz * horiz));
        radii.push(plate * (0.34 + 0.66 * Math.pow(s, 0.55)));
        // Zero all the way: this is the part of the tree holding the ground.
        flexes.push(0);
      }
      /**
       * FOUR SIDES, WHICH IS NOT A BUDGET — IT IS THE RIGHT NUMBER. At radial 4
       * the ring lands at 0°, 90°, 180°, 270°, i.e. exactly on both ends of the
       * squashed axis and both ends of the full one, so the cross-section is a
       * lozenge with a sharp edge top and bottom and its full width across the
       * middle. That is a blade. Six sides would sample neither extreme and
       * round the edge off into the pipe this is trying not to be.
       */
      trunkParts.push(
        sweep(pts, radii, flexes, trunkPhase, 4, {
          ref: new THREE.Vector3(-dz, 0, dx),
          squash: but.squash,
        })
      );
    }
  }

  const st = spec.stilts;
  if (st) {
    const spin = rng() * TAU;
    for (let i = 0; i < st.count; i++) {
      const a = spin + (i / st.count) * TAU + rngRange(rng, -0.26, 0.26);
      const top = st.top * rngRange(rng, 0.55, 1.15);
      const reach = st.reach * rngRange(rng, 0.55, 1.3);
      // A stilt root does not leave the bole along a radius and arrive along
      // the same one; it corkscrews. Without this the cone is a set of coplanar
      // spokes and reads as a tent frame.
      const twist = rngRange(rng, -st.spread, st.spread);
      const thick = st.thick * rngRange(rng, 0.72, 1.4);
      const rings = 5;
      const pts = [];
      const radii = [];
      const flexes = [];
      for (let k = 0; k < rings; k++) {
        const s = k / (rings - 1);
        // Cubed-ish, so the root leaves the trunk almost vertically and only
        // swings out near the ground. Linear gives a straight guy-rope.
        const e = Math.pow(s, 1.55);
        const hug = baseRadius * 0.7;
        const horiz = hug + (reach - hug) * e;
        const y = top * (1 - s) - 0.34 * s;
        const c = a + twist * e;
        const on = trunkAt(Math.max(0, y));
        pts.push(new THREE.Vector3(on.x + Math.cos(c) * horiz, y, on.z + Math.sin(c) * horiz));
        radii.push(thick * (0.85 + 0.5 * s));
        flexes.push(0);
      }
      trunkParts.push(sweep(pts, radii, flexes, trunkPhase, 4));
    }
  }

  /**
   * CLUMP STEMS. See the note in the palm entry for why this species needed
   * them; the mechanism is general because a cecropia suckers too and a
   * strangler is literally several fused stems.
   *
   * The stem is built here and its CROWN is pushed into the branch queue below,
   * because the queue is where foliage gets hung and there is no reason to have
   * a second copy of that code. The entries carry `leafCount` and `sizeScale`
   * so a sucker's crown can be cut down to a seventh of the parent's rasterised
   * area without touching the species numbers.
   */
  const clumpTops = [];
  const cl = spec.clump;
  if (cl) {
    const want = (cl.min ?? 0) + Math.floor(rng() * (cl.count + 1 - (cl.min ?? 0)));
    for (let i = 0; i < want; i++) {
      const a = rng() * TAU;
      const off = rngRange(rng, cl.offset[0], cl.offset[1]);
      const h = height * rngRange(rng, cl.at[0], cl.at[1]);
      const outLean = rngRange(rng, 0.03, 0.13);
      const phase = rng();
      const rings = 6;
      const pts = [];
      const radii = [];
      const flexes = [];
      // Proportional to how much shorter this stem is: a young palm is not a
      // scaled parent, but it is close enough and it keeps the clump reading as
      // one plant of several ages rather than as three unrelated trees.
      const rad = spec.trunkRadius * girth * (0.42 + 0.58 * (h / height));
      for (let k = 0; k < rings; k++) {
        const t = k / (rings - 1);
        const bend = Math.pow(t, 1.6) * h * outLean;
        pts.push(
          new THREE.Vector3(
            baseX + Math.cos(a) * (off + bend),
            t * h - 0.5 * (1 - t),
            baseZ + Math.sin(a) * (off + bend)
          )
        );
        radii.push(rad * (1 - t * (1 - spec.taper)) * (1 + Math.pow(Math.max(0, 1 - t * 4), 2) * 0.5));
        flexes.push(Math.pow(t, 2.4) * 0.55);
      }
      trunkParts.push(sweep(pts, radii, flexes, phase, 6, { capStart: true, capEnd: true }));
      clumpTops.push({ p: pts[rings - 1], h, rad: rad * spec.taper, phase });
    }
  }

  // ---- branches -----------------------------------------------------------
  const farStride = Math.max(1, Math.round(spec.branches / FAR_BRANCHES));
  const queue = [];
  // `branchLow` slides where the crown starts by up to nine per cent of the
  // tree, which on a cecropia is a metre and a half of bare pole gained or
  // lost. Clamped off zero so a species whose whole character is a clean bole
  // cannot accidentally sprout one at the ground.
  const branchStart = clamp01(spec.branchStart + branchLow);
  for (let i = 0; i < spec.branches; i++) {
    const t = branchStart + (1 - branchStart) * Math.pow(i / spec.branches, 0.82);
    const jitter = rngRange(rng, -0.03, 0.03);
    const origin = pointOnTrunk(t + jitter);
    // Golden-angle phyllotaxis around the trunk, so branches never line up.
    const angle = i * 2.39996 + rngRange(rng, -0.35, 0.35);
    const up = (1 - t) * 0.35 + 0.18 - spec.droop * t;
    const dir = new THREE.Vector3(Math.cos(angle), up, Math.sin(angle)).normalize();
    const len = height * rngRange(rng, spec.branchLength[0], spec.branchLength[1]) * (1 - t * 0.45);
    queue.push({
      origin,
      dir,
      len,
      radius: spec.trunkRadius * (1 - t) * 0.42 + 0.02,
      depth: 0,
      flexFrom: Math.pow(t, 2.4) * 0.55,
      // Which bough this is, so the far version can keep a fixed subset of
      // them. The queue below appends children, so an index is the only stable
      // way to ask "is this one of the trunk's own boughs, and which".
      order: i,
    });
  }

  /**
   * The clump stems' crowns, radiating from the top of each sucker.
   *
   * `depth: spec.levels - 1` makes every one of them TERMINAL, so it hangs its
   * foliage and forks no further. That is both the botany (a sucker is young
   * and has not branched yet) and the budget: letting a kapok's clump stem
   * recurse to three levels would grow a second whole tree at half scale, and
   * the whole point of these is that they are cheap crowns low down.
   *
   * `order: -1` keeps them out of the far silhouette — `-1 % farStride` is -1
   * and never 0 — which is the same decision the rest of the foot block makes.
   */
  for (const stem of clumpTops) {
    for (let i = 0; i < cl.crowns; i++) {
      const angle = i * 2.39996 + rngRange(rng, -0.4, 0.4);
      const up = 0.18 - spec.droop * 0.9;
      const dir = new THREE.Vector3(Math.cos(angle), up, Math.sin(angle)).normalize();
      queue.push({
        origin: stem.p.clone(),
        dir,
        len: stem.h * rngRange(rng, spec.branchLength[0], spec.branchLength[1]) * 1.15,
        radius: stem.rad * 0.5 + 0.015,
        depth: Math.max(0, spec.levels - 1),
        flexFrom: 0.42,
        order: -1,
        leafCount: cl.leaves,
        sizeScale: cl.size,
      });
    }
  }

  /** Where the trunk's own boughs are, for the lianas and epiphytes. */
  const boughs = [];

  while (queue.length) {
    const b = queue.shift();
    /**
     * Seven rings and seven sides, not five and five.
     *
     * A branch used to be a five-sided prism with a 72° step between facets,
     * swept along a path that deviated by under 7% over as much as eleven
     * metres. Both halves of that are straight lines: a hard polygonal
     * silhouette, and a bough that genuinely is very nearly a ruler. In a frame
     * with a hundred of them it reads as scaffolding.
     *
     * The bend below is ONE slow arc rather than the old 3.4-cycle wiggle. A
     * wiggle at that frequency sampled by five rings is under five samples per
     * cycle, which does not render as a curve — it renders as a kinked polyline,
     * trading straight pipes for angular ones.
     */
    const rings = 7;
    const pts = [];
    const radii = [];
    const flexes = [];
    const phase = rng();
    const droop = spec.droop * (0.5 + b.depth * 0.4);
    // Shared with the leaf placement below, so foliage stays attached to the
    // bough it is supposed to be hanging from.
    const bendX = (t) => Math.sin(t * 2.1 + phase * 6.28) * b.len * 0.13;
    const bendZ = (t) => Math.cos(t * 1.8 + phase * 6.28) * b.len * 0.13;
    for (let i = 0; i < rings; i++) {
      const t = i / (rings - 1);
      const p = b.origin.clone().addScaledVector(b.dir, b.len * t);
      // Gravity pulls the far end of a branch down, more the further out it is.
      p.y -= droop * b.len * t * t;
      p.x += bendX(t) - bendX(0);
      p.z += bendZ(t) - bendZ(0);
      pts.push(p);
      radii.push(b.radius * (1 - t * 0.86) + 0.012);
      flexes.push(b.flexFrom + (1 - b.flexFrom) * Math.pow(t, 1.5));
    }
    trunkParts.push(sweep(pts, radii, flexes, phase, 7));
    // Only the boughs that grow off the trunk itself, and only every farStride
    // of those. A second-level branch is a third the length of its parent and
    // sits inside the canopy, so at the range this is drawn it is neither
    // visible nor silhouette.
    if (b.depth === 0 && b.order % farStride === 0) {
      farParts.push(sweep(everyOther(pts), everyOther(radii), everyOther(flexes), phase, 3));
    }
    /**
     * Remember where this bough is, for the lianas and epiphytes below.
     *
     * Collected here rather than recomputed afterwards because the bough's
     * points have already been bent, drooped and jittered by the block above —
     * reproducing that arithmetic a second time is exactly the kind of
     * duplicate that drifts. Only the trunk's OWN boughs (depth 0) are
     * recorded: a secondary branch is a third the length of its parent and
     * sits inside the crown, and a vine hanging off one would be a vine
     * hanging inside a canopy where nobody can see it.
     */
    if (b.depth === 0) {
      const at = Math.round((rings - 1) * 0.62);
      /**
       * TWO points, not one, and the second is what makes a hanging LOOP
       * possible. A swag needs two anchors and both of them have to be on the
       * SAME bough: two anchors on different boughs is a chord across the crown
       * and about half of those chords pass straight through the bole, which is
       * a vine threaded through solid wood. Along one limb the strand can only
       * ever hang in front of or below it.
       */
      boughs.push({
        p: pts[at].clone(),
        flex: flexes[at],
        r: radii[at],
        q: pts[rings - 1].clone(),
        qFlex: flexes[rings - 1],
      });
    }

    /**
     * Hang foliage on this bough.
     *
     * `along` is a fraction of the bough's length and may exceed 1 on a terminal
     * branch, which is how the canopy gets an outer shell of cards past the last
     * ring of wood — the silhouette of a tree is foliage, not twigs.
     */
    const hang = (howMany, alongLo, alongHi, spread, sizeScale, flexAt) => {
      for (let l = 0; l < howMany; l++) {
        const along = rngRange(rng, alongLo, alongHi);
        const pos = b.origin
          .clone()
          .addScaledVector(b.dir, b.len * along)
          .add(
            new THREE.Vector3(
              rngRange(rng, -0.9, 0.9),
              rngRange(rng, -0.7, 0.7),
              rngRange(rng, -0.9, 0.9)
            ).multiplyScalar(b.len * spread + 0.4)
          );
        pos.y -= droop * b.len * along * along;
        pos.x += bendX(along) - bendX(0);
        pos.z += bendZ(along) - bendZ(0);
        const size = rngRange(rng, spec.leafSize[0], spec.leafSize[1]) * leafScale * sizeScale;
        leafParts.push(
          leafCard(
            canopyCentre,
            pos,
            size,
            { x: rngRange(rng, -1.4, 1.4), y: rng() * TAU, z: rngRange(rng, -1.4, 1.4) },
            flexAt(along),
            phase
          )
        );
      }
    };

    if (b.depth + 1 < spec.levels && b.len > 1.1) {
      const children = 2 + (rng() < 0.4 ? 1 : 0);
      for (let c = 0; c < children; c++) {
        const t = rngRange(rng, 0.5, 0.95);
        const origin = b.origin.clone().addScaledVector(b.dir, b.len * t);
        origin.y -= droop * b.len * t * t;
        // Follow the bend, or the child sprouts out of thin air beside its parent.
        origin.x += bendX(t) - bendX(0);
        origin.z += bendZ(t) - bendZ(0);
        const spread = rngRange(rng, 0.5, 1.1);
        const around = rng() * TAU;
        const dir = b.dir
          .clone()
          .add(new THREE.Vector3(Math.cos(around) * spread, rngRange(rng, -0.1, 0.4), Math.sin(around) * spread))
          .normalize();
        queue.push({
          origin,
          dir,
          len: b.len * rngRange(rng, 0.42, 0.66),
          radius: b.radius * 0.55,
          depth: b.depth + 1,
          flexFrom: b.flexFrom + (1 - b.flexFrom) * Math.pow(t, 1.5),
        });
      }
      /**
       * A BOUGH IS NOT BARE, and this is the other half of the see-through.
       *
       * Foliage used to hang on TERMINAL branches only, so on an oak the seven
       * primaries and their seventeen secondaries — the biggest, longest,
       * closest-to-the-eye wood in the tree — carried nothing at all. Hide the
       * leaf layer and what is left is not a tree with thin foliage, it is a
       * wide-open lattice of naked tubes with a fringe of green round the
       * outside, and you can see the sky through the middle of it because there
       * is genuinely nothing there.
       *
       * These cards are the crown's INTERIOR: smaller, held tight against the
       * wood rather than thrown out on the ends, and deep enough inside that
       * `aCore` takes most of the light back off them again. That combination is
       * what turns a gap into shade — a dark card behind a lit one is depth, and
       * a hole is a hole.
       *
       * Unlike the texture coverage above this one is NOT free: every card is
       * real rasterised area. TWO per bough rather than a proper reclothing of
       * the wood — three was tried, looked better, and cost about a third of a
       * millisecond more than the free lever had earned back.
       */
      hang(
        spec.leafOnBough,
        0.35,
        0.95,
        0.18,
        0.8 * (b.sizeScale ?? 1),
        // The bough's own flex ramp, plus a little: a leaf hanging off a limb
        // whips further than the limb does.
        (along) => Math.min(1, b.flexFrom + (1 - b.flexFrom) * Math.pow(clamp01(along), 1.5) + 0.15)
      );
    } else {
      // Terminal branch: hang the bulk of the foliage here.
      hang(
        b.leafCount ?? spec.leafPerBranch,
        0.45,
        1.08,
        0.35,
        b.sizeScale ?? 1,
        (along) => 0.72 + 0.28 * clamp01(along)
      );
    }
  }

  /**
   * ==== LIANAS AND EPIPHYTES, BAKED INTO THE ARCHETYPE ======================
   *
   * The brief asked for hanging vines and for bromeliads on the branches, and
   * the obvious implementation of both — a scatter layer, instanced per tree —
   * is the one this project cannot afford. A new streamed layer is an
   * InstancedMesh and a draw call in every resident sector, and there are
   * eighty-odd sectors resident at any moment.
   *
   * SO THEY ARE PART OF THE TREE. `growTree` already returns two merged
   * geometries that get instanced a few hundred times each; adding wood to
   * `trunkParts` and cards to `leafParts` costs triangles inside meshes that
   * are already being drawn and adds NOTHING else — no draw call, no material,
   * no program, no instance, no memory beyond the vertices themselves. It also
   * means the vines inherit the whole rig for free: `aFlex` is written per
   * vertex here exactly as it is for a branch, so a liana sways in the wind and
   * breathes on the trip without one line of code being aware it exists.
   *
   * THE PRICE IS THAT ALL TREES OF ONE ARCHETYPE SHARE THEIR VINES. That is
   * the same price the skeleton already pays — see the variants block at the
   * top of this file — and it is paid in the same currency: there are three
   * archetypes per species, the scatter picks one per tree, and each is grown
   * from its own seed, so the wood has fifteen distinct arrangements of vine
   * rather than one. At the density lianas actually appear that is plenty,
   * because you never see two trees of the same archetype from an angle that
   * lets you compare their vines.
   *
   * THEY ARE ON THE TRUNK MATERIAL, WHICH IS WHY THEY ARE WOODY VINES RATHER
   * THAN LEAFY ONES. A liana IS a woody stem — a rope of wood hanging out of
   * the canopy with its foliage forty metres up where you cannot see it — so
   * the bark texture is the correct one and the epiphyte cards below carry all
   * the green.
   */
  /**
   * ==== WHY THE FIRST VERSION OF THIS READ AS BRANCHES ======================
   *
   * The complaint was "the vines from the trees look like branches", and it was
   * exactly right. The old strand was six rings from a bough to the floor with
   * ONE quadratic drift of up to half a metre across as much as twenty-five —
   * i.e. a straight line to within two per cent — swept at a radius that grew
   * from 0.022 to 0.069 down its length. Every one of those three properties is
   * a description of a branch:
   *
   *   A SINGLE SLOW ARC IS WHAT A BOUGH IS. The block above says so in as many
   *   words: a bough is "ONE slow arc rather than the old 3.4-cycle wiggle".
   *   Giving the vine the same curve as the limb it hangs off meant the only
   *   thing separating them was which way up they were, and half the boughs on
   *   the fig (droop 0.85) point down anyway.
   *
   *   IT GOT FATTER TOWARD THE FREE END. A branch tapers 86% along its length;
   *   this thickened by 56%. Both are monotonic profiles on a straight tube and
   *   the eye does not read the sign of the gradient at twenty metres — it
   *   reads "tapered pole", which is wood.
   *
   *   NONE OF THEM COULD DO ANYTHING WOOD CANNOT. Seven of these off one kapok,
   *   all near-vertical, all the same length because they all ended at the same
   *   floor, came out as a curtain of parallel rods. Parallel straight rods at
   *   even spacing is scaffolding, and it is visible in every wide shot.
   *
   * SO THE FIX IS SHAPE, AND ONLY SHAPE. Nothing here costs a draw call, a
   * material or a texture — this is still geometry merged into `trunkParts` —
   * and the three changes are:
   *
   *   1. A MEANDER AT A FREQUENCY A BOUGH DOES NOT HAVE. Two sines, 1.15 and
   *      1.75 cycles over the whole drop, on independent phases and axes. The
   *      ring count went 6 -> 9 to carry it: the warning in the branch block
   *      applies here word for word, and 9 rings over 1.75 cycles is five
   *      samples per cycle, which is the floor. At six rings this wiggle would
   *      have rendered as a zigzag and traded pipes for lightning bolts. The
   *      frequencies were pulled down from 1.35 and 2.2 for exactly that
   *      reason — see the cost paragraph at the end of this block, where the
   *      rings had to come back and the sampling floor is what decided how far.
   *
   *   2. CONSTANT RADIUS. A liana is a rope: it is the same thickness at the
   *      canopy as at the floor, because unlike a branch it is not holding
   *      anything up. What varies instead is a slow varicosity of ±14%, which
   *      is the knotting a real one has and is NOT a taper — it goes both ways
   *      along the strand, so there is no gradient for the eye to read as a
   *      direction. Thinner too, 0.019-0.034 against 0.028-0.055: the old range
   *      overlapped a kapok's branch TIPS.
   *
   *   3. TWO IN FIVE ARE SWAGS — a hairpin that leaves the bough, falls, and
   *      comes back UP to a second anchor further out on the same limb. This is
   *      the one that does the work, because it is the one shape in the frame
   *      that wood cannot make: a branch has one free end and a swag has none.
   *      One of these in a view is enough to tell the eye what all the strands
   *      beside it are, which is why the split is by count rather than by
   *      species — the fig and the kapok get two or three each.
   *
   *
   * ==== WHAT IT COST, AND WHERE IT WAS PAID FROM ============================
   *
   * A strand went from 40 triangles to 64 (a fall) or 80 (a swag), so at the
   * original counts this put 2.9 M triangles into a 77 M resident ring — and
   * `perf:bench` duly failed every scenario on the ±2.5% triangle gate at
   * +2.6% to +3.2%. THE INTERESTING PART IS WHICH SPECIES PAID, because it is
   * not the one the eye blames: a kapok carries seven of these and a cecropia
   * two, but there are 8393 cecropias resident and 4721 kapoks, so the
   * cecropia's two vines cost MORE of the frame than the kapok's seven. A
   * per-tree budget is the wrong unit; the unit is per-tree times share of the
   * wood, and this table's shares run 38 / 33 / 18.5 / 10 / ~0.
   *
   * So the rings came back to 9 and 11 (the sampling floor above is what
   * stopped them going lower), and the two counts that are multiplied by a
   * large share came down: kapok 7 -> 5 and fig 8 -> 6. That is 1.0 M rather
   * than 2.9 M, about +1.3%, inside the gate with room.
   *
   * FIVE IS NOT A LOSS AGAINST SEVEN AND THAT IS THE WHOLE POINT OF THE CHANGE.
   * Seven identical rods read as one repeated object, which is why the old ones
   * looked like scaffolding; five strands of which two are loops and three
   * meander differently read as a tangle, because variety is what the eye
   * counts down here and not quantity. It is the same trade the understorey's
   * "fewer and bigger" pass made, in the same direction, for the same reason.
   *
   * NOTHING OF THIS REACHES THE FAR GEOMETRY. Lianas go into `trunkParts` and
   * never into `farParts`, so past 200 m a tree has no vines at all and none of
   * the above is being paid twice. At that range a 4 cm strand is a fifth of a
   * pixel.
   */
  const lianaCount = spec.lianas ?? 0;
  for (let i = 0; i < lianaCount && boughs.length; i++) {
    const from = boughs[Math.floor(rng() * boughs.length)];
    const swing = rng() * TAU;
    const lean = rngRange(rng, 0.15, 0.5);
    /**
     * FOUR TO SIXTEEN CENTIMETRES THROUGH, against the 3.8-6.8 this was.
     *
     * The old range was chosen against a real objection — a strand as thick as
     * a branch tip reads as a branch — and it overcorrected into a different
     * failure, which the first pass at the empty band made obvious: at 20 m a
     * 5 cm strand is three pixels wide, and three dark pixels crossing a
     * background of dark trunks is not a vine, it is nothing. The band was not
     * empty of strands, it was empty of anything the eye could resolve.
     *
     * IT IS FREE. Radius is not a triangle: this is the same nine or eleven
     * rings at four sides it always was, and it changes only how many pixels
     * each one covers. Given that trunks are 73% of the frame's triangles and
     * 8% of its cost, widening the cheap layer is the best trade available.
     *
     * The branch-confusion argument survives because the other two properties
     * that block explains — constant radius with a knot rather than a taper,
     * and a meander no bough has — are what actually separate the two shapes.
     * Real canopy lianas run to 20 cm and the big Bauhinia to more than that;
     * 3.8 cm was never the honest number, it was a proxy for "not a branch".
     */
    const thick = rngRange(rng, 0.021, 0.08) * (spec.lianaThick ?? 1);
    // The two meanders. Amplitude is a fraction of the strand's own length, so
    // a short swag wanders proportionally as much as a thirty-metre fall.
    const waveA = rngRange(rng, 0.02, 0.045);
    const waveB = rngRange(rng, 0.012, 0.03);
    const phaseA = rng() * TAU;
    const phaseB = rng() * TAU;
    const knot = rng() * TAU;
    /**
     * Every draw this strand makes happens HERE, unconditionally, before either
     * branch below. The two paths do not consume the same number of numbers on
     * their own, and this stream is shared with every liana and epiphyte after
     * this one — so drawing inside the branches would make the shape of vine 3
     * depend on whether vine 2 happened to be a loop, which is the kind of
     * coupling that turns a one-line tweak into a different tree.
     */
    const wantSwag = rng() < 0.4;
    const phase = rng();
    const sagFrac = rngRange(rng, 0.35, 0.7);
    /**
     * `lianaFromTip` is how the cecropia gets five strands without losing the
     * clean pale bole that is the only landmark this forest has past forty
     * metres. `from.q` is the far END of a limb, so a strand tied there hangs
     * two to four metres out from the trunk and never crosses it.
     */
    const fromTip = rng() < (spec.lianaFromTip ?? 0.5);
    /**
     * Drawn HERE, unconditionally, for the reason the block above this one
     * gives: the two paths below consume different numbers of randoms on their
     * own, and this stream is shared with every strand after this one.
     */
    const foliage = [];
    for (let n = 0; n < 2; n++) {
      foliage.push({
        at: rngRange(rng, 0.42, 0.94),
        size: rngRange(rng, spec.leafSize[0], spec.leafSize[1]) * leafScale * 0.55,
        tilt: { x: rngRange(rng, -1.2, 1.2), y: rng() * TAU, z: rngRange(rng, -1.2, 1.2) },
        off: new THREE.Vector3(rngRange(rng, -0.4, 0.4), rngRange(rng, -0.3, 0.1), rngRange(rng, -0.4, 0.4)),
      });
    }

    const pts = [];
    const radii = [];
    const flexes = [];
    /** Constant, with a slow knot in it that goes both ways. See (2) above. */
    const fatten = (t) => thick * (1 + 0.14 * Math.sin(t * 4.6 + knot));

    /**
     * A SWAG NEEDS ROOM AND MOST BOUGHS DO NOT HAVE IT. `p` and `q` are 0.62
     * and 1.0 along the limb, so on a brownea's two-metre bough they are 0.75 m
     * apart and the loop is a hairpin you cannot see round; under a metre it is
     * indistinguishable from a fold in the bark. Falling through to a plain
     * strand is the right failure — the small trees are the ones whose two
     * lianas are supposed to be inconspicuous.
     */
    const span = from.p.distanceTo(from.q);
    if (wantSwag && span > 1.0) {
      /**
       * How far it sags. Bounded BELOW the anchor's own height so a swag on a
       * low bough cannot dip into the dirt, and never more than nine metres
       * because past that it stops reading as a loop and reads as two strands
       * that happen to meet.
       */
      const low = Math.min(from.p.y, from.q.y);
      const sag = Math.min(9, Math.max(1.2, low * sagFrac));
      const rings = 11;
      for (let k = 0; k < rings; k++) {
        const t = k / (rings - 1);
        const p = from.p.clone().lerp(from.q, t);
        // sin, not a parabola: a hanging chain leaves both anchors going
        // steeply DOWN and flattens at the bottom, and a parabola through the
        // same three points leaves them at a shallow angle. That angle at the
        // anchor is the whole difference between a rope over a branch and a
        // rubber band stretched between two nails.
        p.y -= sag * Math.pow(Math.sin(Math.PI * t), 0.62);
        p.x += Math.sin(t * TAU * 1.15 + phaseA) * span * waveA * 2.4;
        p.z += Math.cos(t * TAU * 1.75 + phaseB) * span * waveB * 2.4;
        pts.push(p);
        radii.push(fatten(t));
        /**
         * Clamped at BOTH ends and free in the middle, which is the opposite of
         * the fall below and of a branch. Getting this wrong is not subtle: a
         * loop whose flex ramps one way pivots about one anchor in the wind and
         * tears itself off the other.
         */
        const base = from.flex + (from.qFlex - from.flex) * t;
        flexes.push(Math.min(1, base + (1 - base) * Math.pow(Math.sin(Math.PI * t), 0.7) + 0.08));
      }
    } else {
      /**
       * A HANGING ROPE. It stops at 0.35 rather than at 0 because the instance
       * scale runs 0.50-1.48 and the tree is sunk 0.25 m — a vine that ended
       * exactly at the origin would disappear into the dirt on the small ones
       * and float on the large. Ending it short means the worst case is a vine
       * that stops a little above the litter, which is what a real one does
       * anyway: they are browsed and broken off at the bottom.
       */
      const anchor = fromTip ? from.q : from.p;
      const drop = anchor.y - 0.35;
      if (drop < 1.5) continue;
      const rings = 9;
      for (let k = 0; k < rings; k++) {
        const t = k / (rings - 1);
        pts.push(
          new THREE.Vector3(
            anchor.x +
              Math.cos(swing) * lean * t * t +
              Math.sin(t * TAU * 1.15 + phaseA) * drop * waveA,
            anchor.y - drop * t,
            anchor.z +
              Math.sin(swing) * lean * t * t +
              Math.cos(t * TAU * 1.75 + phaseB) * drop * waveB
          )
        );
        radii.push(fatten(t));
        /**
         * FLEX RISES DOWNWARD, which is the opposite of a branch and is the
         * whole reason this looks like a rope. A bough is clamped at the trunk
         * and free at the tip, so its flex rises outward; a vine is clamped at
         * the TOP and free at the BOTTOM, so the far end from the anchor is the
         * bottom. Getting this backwards gives a vine that is rigid where it
         * hangs and whips where it is tied on.
         */
        flexes.push(Math.min(1, from.flex + (1 - from.flex) * Math.pow(t, 0.8) + 0.1));
      }
    }
    // Four sides. A vine is 4 cm thick and never fills more than a couple of
    // pixels across; the note on FAR_BRANCHES applies with more force here.
    trunkParts.push(sweep(pts, radii, flexes, phase, 4));

    /**
     * ==== LEAVES ON THE ROPE, WHICH IS THE MID-STOREY ========================
     *
     * The block above is right that a liana is a bare woody stem with its
     * foliage forty metres up — for a MATURE canopy liana. It is not right
     * about the thing the eye is missing, which is green between two and twelve
     * metres. Every strand in a real forest has something growing on it at that
     * height: the vine's own lower shoots, a philodendron that climbed it, moss
     * with a fern in the moss.
     *
     * TWO CARDS PER STRAND, AND THEY ARE THE ONLY EXPENSIVE THING IN THIS PASS.
     * Everything else added here is swept tube at 8% marginal cost; these are
     * alpha-tested leaf cards at 21x that per triangle, and worse, they land
     * LOW — which means close to the eye, which means many more pixels each
     * than a card in a crown fifteen metres up. Two rather than four, and 0.55
     * of the species leaf size rather than full, is the whole of the restraint:
     * with the counts in the table that is 10 on a cecropia, 16 on a kapok, 18
     * on a fig, against crowns of 150-200. Roughly 8% more cards on the two
     * species that carry the wood.
     *
     * They take the STRAND's flex, not a leaf's, so a clump of vine foliage
     * swings with the rope it is tied to instead of fluttering on its own.
     */
    for (const f of foliage) {
      const idx = Math.min(pts.length - 1, Math.round(f.at * (pts.length - 1)));
      leafParts.push(
        leafCard(
          canopyCentre,
          pts[idx].clone().add(f.off),
          f.size,
          f.tilt,
          Math.min(1, flexes[idx] + 0.06),
          phase
        )
      );
    }
  }

  /**
   * EPIPHYTES: clumps of green sitting ON the boughs, not hanging off the tips.
   *
   * This is the detail that most separates a tropical tree from a temperate
   * one at close range. Every horizontal surface in a rainforest carries
   * something growing on it — bromeliads, orchids, ferns, moss — so a bough is
   * not a bare pipe with leaves at the end, it is furred along its whole
   * length.
   *
   * THEY ARE PLACED ON THE BOUGH ITSELF and that is deliberate rather than
   * convenient. `normaliseCore` computes `aCore` from each card's distance to
   * the canopy centre and the RIM is the bright end — so a card stuck on the
   * trunk near the ground would be the furthest thing from the centre and
   * would therefore be lit as the brightest part of the tree, which is exactly
   * backwards for a plant living in the deepest shade the tree casts. Sitting
   * them on the boughs keeps them inside the crown volume where `aCore` means
   * what it is supposed to mean, and it is also where epiphytes actually grow:
   * on the horizontal wood, not the vertical.
   *
   * Small and squat — 0.55 of the species leaf size — because a bromeliad is a
   * rosette the size of a dinner plate against a bough several metres long.
   */
  /**
   * ==== AND SOME OF THEM COME DOWN THE TRUNK ================================
   *
   * The block above argues that an epiphyte belongs on a bough because that is
   * where `aCore` means what it is supposed to mean, and it is right about the
   * mechanism and wrong about which way to resolve it.
   *
   * `aCore` is distance from the crown centre, and the RIM is the bright end,
   * so a card stuck low on the bole comes out at core 1 and is lit as the
   * brightest thing on the tree. The old note reads that as an artefact to be
   * avoided — a shade plant rendered as though it were in full sun. But the
   * complaint this pass exists to answer is that there is NO COLOUR AND NO
   * BRIGHTNESS ANYWHERE AT EYE LEVEL, and a lit card at three metres is not a
   * bug against that brief, it is the entire point: a bromeliad wedged in a
   * fork genuinely is the brightest thing in the understorey, because it is the
   * only thing down there catching a shaft.
   *
   * SO IT IS A REDISTRIBUTION AND NOT AN ADDITION. Roughly two in five of the
   * cards a species already paid for move from twelve metres up to between one
   * and seven — no extra card, no extra triangle, no extra rasterised area, and
   * the area moves from where 87% of the foliage already was to where none of
   * it was. It is the best-value line in this file.
   *
   * The height is capped at half the tree so this cannot put a rosette above
   * the crown of a short brownea, and it is offset to the bole's SURFACE rather
   * than its axis, or on a kapok the card would be swallowed by a bole two and
   * a half metres through.
   */
  const epiCount = spec.epiphytes ?? 0;
  for (let i = 0; i < epiCount && boughs.length; i++) {
    const on = boughs[Math.floor(rng() * boughs.length)];
    // Every draw happens before the branch, for the reason the liana block
    // gives: the two placements below do not consume the same numbers and this
    // stream is shared with everything after them.
    const low = rng() < 0.42;
    const y = Math.min(height * 0.5, rngRange(rng, 1.2, 7.2));
    const around = rng() * TAU;
    const out = rngRange(rng, 0.55, 1.0);
    const jitter = new THREE.Vector3(
      rngRange(rng, -0.5, 0.5),
      rngRange(rng, -0.1, 0.34),
      rngRange(rng, -0.5, 0.5)
    );
    const size = rngRange(rng, spec.leafSize[0], spec.leafSize[1]) * leafScale * 0.55;
    const tilt = { x: rngRange(rng, -0.5, 0.5), y: rng() * TAU, z: rngRange(rng, -0.5, 0.5) };
    const phase = rng();
    let pos;
    let flex;
    if (low) {
      const on2 = trunkAt(y);
      const t = clamp01(y / height);
      const r = spec.trunkRadius * girth * (1 - t * (1 - spec.taper));
      pos = new THREE.Vector3(
        on2.x + Math.cos(around) * (r + size * 0.24) * out,
        y,
        on2.z + Math.sin(around) * (r + size * 0.24) * out
      );
      // The bole's own flex at that height, so a rosette wedged in a fork moves
      // with the wood it is wedged in rather than fluttering like a leaf.
      flex = Math.pow(t, 2.4) * 0.55 + 0.04;
    } else {
      pos = on.p.clone().add(jitter);
      flex = Math.min(1, on.flex + 0.08);
    }
    leafParts.push(leafCard(canopyCentre, pos, size, tilt, flex, phase));
  }

  /**
   * ==== THE COLOUR AT EYE LEVEL =============================================
   *
   * Everything below is opaque swept tube on the BARK material, coloured by
   * pointing its uv at one band of the colour strip described in
   * tree-adorn.js. No card, no alpha test, no second material, no draw call —
   * the same deal the lianas got, for the same reason.
   *
   * WHY IT IS GEOMETRY AND NOT A PICTURE. A bromeliad drawn on a cutout card
   * would be a quarter of the triangles, and it would cost the trunk layer its
   * `alphaTest`-free status: 73% of the frame's triangles are trunks and they
   * are 8% of its marginal cost precisely because they are opaque fragments
   * that write depth and let early-Z throw the hidden ones away. Turning the
   * cheapest layer in the frame into an alpha-tested one to decorate it is a
   * bad trade at any card count, so these are solids.
   *
   * WHERE THEY GO. Mostly on the BOLE between one and eight metres, which is
   * the height the whole pass is about, and a few in the bough forks. The
   * epiphyte block above moved a share of the canopy cards down here for the
   * same reason; this is the part that brings a colour the canopy cannot.
   */
  const basis = (axis) => {
    const e1 = new THREE.Vector3(1, 0, 0);
    if (Math.abs(axis.x) > 0.85) e1.set(0, 0, 1);
    e1.crossVectors(axis, e1).normalize();
    const e2 = new THREE.Vector3().crossVectors(axis, e1).normalize();
    return [e1, e2];
  };

  /**
   * A TANK BROMELIAD: straps out and down, bracts up the middle.
   *
   * The rosette is what makes it read as a bromeliad rather than as a green
   * blob — six straps radiating from one point, arcing up and then falling
   * away, is a shape nothing else on a tree has. Each strap is swept with a
   * flattened section (see `sweep`) so it is a blade rather than a worm, thin
   * across the circumference of its own little rosette and wide in the plane it
   * curves through, which is how a strap leaf is actually held.
   */
  const rosette = (centre, outward, size, flexV, phase, bract) => {
    const axis = new THREE.Vector3(0, 0.78, 0).addScaledVector(outward, 0.62).normalize();
    const [e1, e2] = basis(axis);
    const straps = 6;
    const spin = rng() * TAU;
    for (let k = 0; k < straps; k++) {
      const a = spin + (k / straps) * TAU + rngRange(rng, -0.22, 0.22);
      const dir = e1.clone().multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a));
      const len = size * rngRange(rng, 0.8, 1.3);
      const rings = 4;
      const pts = [];
      const radii = [];
      const flexes = [];
      for (let i = 0; i < rings; i++) {
        const s = i / (rings - 1);
        // Up, over and down. The negative quadratic is what puts the tip below
        // the shoulder, which is the whole silhouette of a rosette.
        const rise = size * (1.15 * s - 0.82 * s * s);
        const out = len * Math.pow(s, 1.2);
        pts.push(centre.clone().addScaledVector(axis, rise).addScaledVector(dir, out));
        radii.push(size * 0.15 * (1 - 0.72 * s) + 0.004);
        flexes.push(flexV);
      }
      trunkParts.push(
        sweep(pts, radii, flexes, phase, 4, {
          // Thin across the blade: perpendicular to both the rosette's axis and
          // this strap's own direction.
          ref: new THREE.Vector3().crossVectors(axis, dir).normalize(),
          squash: 0.3,
          uvAt: bandUV(BAND.strap),
        })
      );
    }
    // The bract. Short, near-vertical, and the only saturated thing down here.
    const uv = bandUV(bract);
    for (let k = 0; k < 3; k++) {
      const a = rng() * TAU;
      const dir = e1.clone().multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a));
      const rings = 3;
      const pts = [];
      const radii = [];
      const flexes = [];
      const len = size * rngRange(rng, 0.6, 0.95);
      for (let i = 0; i < rings; i++) {
        const s = i / (rings - 1);
        pts.push(
          centre
            .clone()
            .addScaledVector(axis, size * 0.12 + len * s)
            .addScaledVector(dir, size * 0.22 * s * s)
        );
        radii.push(size * 0.115 * (1 - 0.6 * s) + 0.005);
        flexes.push(flexV);
      }
      trunkParts.push(sweep(pts, radii, flexes, phase, 4, { uvAt: uv }));
    }
  };

  /**
   * A BRACKET FUNGUS, and the same primitive does the glowing caps at the foot.
   *
   * `ref` IS WORLD UP, WHICH IS THE OPPOSITE END OF THE FRAME FROM THE BUTTRESS
   * AND GIVES THE OPPOSITE OBJECT FROM THE SAME NUMBER.
   *
   * `sweep` scales the NORMAL axis, and normal = (tangent x ref) x tangent. With
   * ref up and a tangent running outward from the bole, the normal comes out
   * vertical and the binormal horizontal — so a squash below one is thin
   * vertically and full width across, i.e. a shelf. The buttress passes the
   * circumferential axis instead and gets its normal along the circumference,
   * so the identical value there is a fin standing on edge.
   *
   * The first version of this passed 3.4, reasoning that a bracket is "wide",
   * and squashed the wrong axis by a factor of thirteen: every fungus in the
   * forest came out as a metre-and-a-half orange flag standing vertically off
   * the trunk. Which axis `squash` acts on is not guessable from the call site
   * and has to be read off the frame.
   */
  const shelf = (at, outward, size, flexV, phase, band) => {
    const rings = 4;
    const pts = [];
    const radii = [];
    const flexes = [];
    for (let i = 0; i < rings; i++) {
      const s = i / (rings - 1);
      pts.push(
        at
          .clone()
          .addScaledVector(outward, size * 1.05 * s)
          .add(new THREE.Vector3(0, -size * 0.3 * s * s, 0))
      );
      radii.push(size * (0.2 + 0.42 * Math.sin(s * Math.PI * 0.8)) + 0.004);
      flexes.push(flexV);
    }
    trunkParts.push(
      sweep(pts, radii, flexes, phase, 4, {
        ref: new THREE.Vector3(0, 1, 0),
        squash: 0.26,
        uvAt: bandUV(band),
      })
    );
  };

  const ad = spec.adorn;
  if (ad) {
    /**
     * NO CREAM. It was in this list for one round and it is the reason the
     * glade came back with what looked like white paper stuck to every third
     * bole: at luma 226 it is the brightest entry in the strip, and a bract is
     * a SPIKE — a long thin near-white object at four metres reads as damage or
     * as litter, never as a flower. Cream survives on the fungus shelf, which
     * is a flat disc lying against the bark and is a shape the eye already
     * expects to be pale.
     */
    const BRACTS = [BAND.scarlet, BAND.orange, BAND.magenta, BAND.orange];
    for (let i = 0; i < (ad.rosettes ?? 0); i++) {
      const onBough = rng() < 0.3 && boughs.length > 0;
      const which = Math.floor(rng() * Math.max(1, boughs.length));
      const y = Math.min(height * 0.55, rngRange(rng, 0.9, 7.5));
      const around = rng() * TAU;
      const size = rngRange(rng, 0.22, 0.4) * (0.7 + 0.3 * Math.min(1.6, height / 15));
      const bract = BRACTS[Math.floor(rng() * BRACTS.length)];
      const phase = rng();
      const outward = new THREE.Vector3(Math.cos(around), 0, Math.sin(around));
      if (onBough) {
        const on = boughs[which];
        rosette(on.p.clone().add(new THREE.Vector3(0, on.r * 0.6, 0)), outward, size, Math.min(1, on.flex), phase, bract);
      } else {
        const t = clamp01(y / height);
        const r = spec.trunkRadius * girth * (1 - t * (1 - spec.taper));
        const on = trunkAt(y);
        rosette(
          new THREE.Vector3(on.x + outward.x * r * 0.85, y, on.z + outward.z * r * 0.85),
          outward,
          size,
          Math.pow(t, 2.4) * 0.55,
          phase,
          bract
        );
      }
    }
    for (let i = 0; i < (ad.shelves ?? 0); i++) {
      const y = Math.min(height * 0.5, rngRange(rng, 0.5, 5.5));
      const around = rng() * TAU;
      const size = rngRange(rng, 0.14, 0.27);
      const phase = rng();
      const band = rng() < 0.86 ? BAND.ochre : BAND.cream;
      const t = clamp01(y / height);
      const r = spec.trunkRadius * girth * (1 - t * (1 - spec.taper));
      const on = trunkAt(y);
      const outward = new THREE.Vector3(Math.cos(around), 0, Math.sin(around));
      shelf(
        new THREE.Vector3(on.x + outward.x * r * 0.9, y, on.z + outward.z * r * 0.9),
        outward,
        size,
        Math.pow(t, 2.4) * 0.55,
        phase,
        band
      );
    }
    /**
     * The foxfire. Small, low, and clustered at the foot of the bole where a
     * dead buttress or a root would actually be rotting — a shelf of glowing
     * fungus at knee height is the one thing in this world that makes its own
     * light and is not an insect.
     */
    for (let i = 0; i < (ad.glowCount ?? 0); i++) {
      const y = rngRange(rng, 0.05, 0.8);
      const around = rng() * TAU;
      const size = rngRange(rng, 0.04, 0.085);
      const phase = rng();
      const t = clamp01(y / height);
      const r = spec.trunkRadius * girth * (1 - t * (1 - spec.taper)) * 1.2;
      const on = trunkAt(y);
      const outward = new THREE.Vector3(Math.cos(around), 0, Math.sin(around));
      shelf(
        new THREE.Vector3(on.x + outward.x * r * 0.9, y, on.z + outward.z * r * 0.9),
        outward,
        size,
        0,
        phase,
        BAND.glow
      );
    }
  }

  /**
   * How far this tree's extremities may travel, in metres, at unit amplitude.
   *
   * Proportional to height, because a big tree moves more than a sapling, but
   * bounded: a twenty-five-metre pine does not sway five times as far as a
   * five-metre one, it sways a bit further and much more slowly.
   */
  const scale = PLANT_SCALE.tree * (0.55 + 0.45 * Math.min(1.6, height / 15));

  return {
    trunk: setPlantScale(BufferGeometryUtils.mergeGeometries(trunkParts, false), scale),
    leaf: setPlantScale(
      normaliseCore(BufferGeometryUtils.mergeGeometries(leafParts, false), canopyCentre),
      scale
    ),
    // The same `scale`, so the wind, the breath and the lean-toward-you move
    // the far version by exactly as much as the near one. A distant stand that
    // swayed at a different amplitude from the one beside it would be far more
    // conspicuous than the branches this drops.
    far: setPlantScale(BufferGeometryUtils.mergeGeometries(farParts, false), scale),
    height,
  };
}

/**
 * Materials for one species: one trunk material shared by every archetype, and
 * one canopy material per VARIANT — see the variants block at the top of this
 * file for why that is free here and would not be anywhere else.
 *
 * `archetypes` is how many shapes forest.js is growing. The variant table is
 * cycled to cover them, so the two numbers do not have to agree: three shapes
 * against two variants gives shapes 0 and 2 the same canopy, and one variant
 * gives the old behaviour exactly. Materials are built per variant and then
 * indexed, so a repeated variant is a repeated REFERENCE — no second program,
 * no second canvas, no second draw call.
 */
export function speciesMaterials(name, archetypes = 1) {
  const spec = SPECIES[name];
  const bark = trunkAtlas({ key: name, ...spec.bark, seed: `bark:${name}` });
  bark.repeat.set(1, 1);

  /**
   * `bark` is what gives the trunk procedural fissures and fibre in the shader.
   *
   * The drawn tile above is only about eight per cent contrast and 256 pixels
   * across a whole trunk, so past a couple of metres it averages to a flat
   * colour and what is left on screen is a smooth tube with one soft highlight
   * down it — which is the description of varnished wood, and is why the trees
   * were reported as looking oily. See the RR_BARK block in living.js.
   */
  /**
   * `receivesShadow: false` MIRRORS forest.js AND IS NOT A FREE CHOICE.
   *
   * The trunk, far-trunk and leaf meshes are all added through `addStreamed`
   * without a `receiveShadow` option, and that helper defaults it to false — so
   * three's runtime `receiveShadow` uniform is already false on every one of
   * them and the shadow lookup in the fragment shader is already never taken.
   * What the flag does is stop the VERTEX shader computing and exporting the
   * coordinate for it, which `USE_SHADOWMAP` being a global define means it was
   * doing on 6.5 M trunk and 7.8 M leaf vertices. See the block in makeLiving.
   *
   * If either of those meshes is ever given `receiveShadow: true` in forest.js,
   * it will not work and nothing will say so. This flag comes off in the same
   * commit or the change is a silent no-op.
   */
  /**
   * `emissive` ON BARK IS THE BIOLUMINESCENT FUNGUS AND NOTHING ELSE.
   *
   * `emissiveFromMap` modulates it by the map's own texel, so the glow band —
   * near-white by construction — emits at full strength while the bark beside
   * it, at 0.05-0.10 linear, emits at under a tenth of that and is invisible.
   * The whole argument, including why the cecropia is exempt, is in the block
   * on the glow in tree-adorn.js; the short version is that this is ADDED
   * radiance and is never multiplied by any light term, which is the recorded
   * bug this project has already paid for once with the fireflies.
   *
   * No slot is set when a species has no glow, so those materials compile
   * exactly as they did.
   */
  const trunkMat = makeLiving(
    new THREE.MeshLambertMaterial({
      map: bark,
      color: 0xffffff,
      ...(spec.glow
        ? { emissive: new THREE.Color(spec.glow.colour), emissiveIntensity: spec.glow.strength }
        : {}),
    }),
    'plant',
    { bark: true, receivesShadow: false, emissiveFromMap: !!spec.glow }
  );

  /**
   * 512, not the default 256.
   *
   * A leaf card is two to four metres across. At 256 that is a centimetre and a
   * half per texel, and standing under a tree magnifies the texture five or six
   * times — every individual mark becomes a visible shape, and whatever
   * regularity the drawing had is enlarged along with it. Fifteen canvases at
   * 512 is 15 MB and buys the canopy its close-range detail and its variety.
   *
   * IT IS ALSO WHERE THE BLOSSOM HAS TO BE LEGIBLE. A rowan corymb is drawn at
   * about 78 texels across; at 256 that would be 39, and the five-petal notches
   * that are the only thing separating a flower from a white blob would be gone
   * by the second mip. The close range decided 512 and the fruit confirms it.
   */
  const variants = spec.variants ?? [{}];
  const built = variants.map((v, i) =>
    makeLeafMaterial(
      leafCluster({
        // Keyed on the VARIANT, not on the species — `leafCluster` memoises on
        // this key, so two archetypes that share a variant share one canvas, and
        // a variant that overrides nothing costs nothing at all.
        key: `${name}:${i}`,
        seed: `leaf:${name}:${i}`,
        size: 512,
        ...spec.leaf,
        ...(v.leaf ?? {}),
      })
    )
  );
  const leafMats = [];
  const tints = [];
  for (let a = 0; a < archetypes; a++) {
    const i = a % variants.length;
    leafMats.push(built[i]);
    tints.push(variants[i].tint ?? spec.tint);
  }

  return { trunkMat, leafMats, tints };
}

/** One canopy material. Split out so every variant is compiled identically. */
function makeLeafMaterial(leafTex) {
  return makeLiving(
    new THREE.MeshLambertMaterial({
      map: leafTex,
      transparent: false,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
      // Foliage is thin and translucent; a little emissive keyed off the map
      // stands in for subsurface scattering, which is the difference between
      // leaves that glow when backlit and leaves that look like plastic. Real
      // backlit foliage is never black — leave it too dark and every canopy card
      // seen against the sky becomes a hard silhouette.
      emissive: new THREE.Color(0x17260f),
      /**
       * `emissiveMap: leafTex` USED TO BE HERE AND IT WAS COSTING A VARYING.
       *
       * The intent is unchanged — the emissive is the leaf, modulated by the
       * leaf's own drawn alpha — but SETTING the slot is what makes three emit
       * a second uv varying, a second sampler and a second uv transform for a
       * texture the map slot already holds. `emissiveFromMap` says the same
       * thing to the shader without any of that; the multiply happens against
       * the map's own texel, which is the fetch the material was already doing.
       * See EMISSIVEMAP_FRAGMENT in living.js. Output is bit-identical.
       *
       * `emissiveIntensity` still applies: three folds it into the `emissive`
       * uniform on the JS side (`WebGLMaterials` multiplies the colour by it),
       * not into the map path.
       */
      emissiveIntensity: 0.72,
    }),
    'plant',
    { leaf: true, emissiveFromMap: true, receivesShadow: false }
  );
}
