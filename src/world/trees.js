import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TAU, clamp01, makeRng, rngRange } from '../core/util.js';
import { barkTexture, leafCluster } from './textures.js';
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
const SPECIES = {
  pine: {
    height: [15, 27],
    trunkRadius: 0.34,
    taper: 0.13,
    /**
     * A SHORTER BOUGH ON THE SAME TRUNK — the pine's crown, pulled in.
     *
     * Pine has `levels: 1`, so all twenty-four boughs are terminal and there is
     * no second tier to hang anything on; it also had the largest crown in the
     * forest and the emptiest card. Every other lever costs pixels. This one
     * does not: the same cards at the same size, over a crown 18% narrower,
     * which is 1.8x the cards per cubic metre for nothing. A pine that is
     * slightly narrower than it was is also simply a better pine — the species
     * is a spire.
     */
    branchStart: 0.2,
    branches: 24,
    branchLength: [0.17, 0.34],
    droop: 0.35,
    levels: 1,
    leafPerBranch: 9,
    leafOnBough: 0,
    leafSize: [2.0, 3.4],
    bark: { hue: 22, sat: 26, light: 15 },
    leaf: { hue: 128, sat: 30, light: 21, needle: true, count: 110, length: 0.26, width: 0.14 },
    tint: [0x93b391, 0x6f9a76, 0xa8bd95],
    /**
     * A conifer stand is genuinely two or three different-coloured trees, and
     * that is not artistic licence — the blue-grey of a spruce beside the
     * yellow-green of a pine is the most reliably visible colour difference in a
     * temperate wood. Cones on the third: pine has `levels: 1`, so every one of
     * its twenty-four boughs is terminal and carries seven cards, which makes it
     * the species where a card-borne detail is most evenly spread through the
     * crown.
     */
    variants: [
      { tint: [0x6f9a76, 0x7ea88a, 0x5c8a6e, 0x8ab396, 0x67947f] },
      {
        leaf: { hue: 146, sat: 24, light: 20, count: 122 },
        tint: [0x9db8a4, 0xa8bd95, 0x8fae9c, 0xb2c4a8, 0x93b391],
      },
      {
        // Small: a pine cone is 8 cm against a 4 cm needle bundle, and `base`
        // here is the SPRIG length rather than a needle, so 0.52 of it lands the
        // cone at about three and a half needles long, which is right. 0.42 was
        // the first try and it disappeared into the comb — a conifer card is the
        // busiest texture in the wood and a mark has to beat the needles.
        leaf: {
          hue: 120,
          count: 108,
          adorn: { kind: 'cone', count: 6, span: 0.52, hue: 22, sat: 42, light: 28 },
        },
        tint: [0x87a878, 0x7d9e6f, 0x9bb488, 0x6f9364, 0x93ad7e],
      },
    ],
  },
  birch: {
    height: [12, 19],
    trunkRadius: 0.21,
    taper: 0.3,
    branchStart: 0.46,
    branches: 11,
    branchLength: [0.24, 0.44],
    droop: -0.15,
    levels: 2,
    leafPerBranch: 8,
    leafOnBough: 2,
    leafSize: [1.9, 3.0],
    bark: { hue: 42, sat: 12, light: 52 },
    leaf: { hue: 84, sat: 46, light: 38, count: 185, length: 0.16, width: 0.875 },
    tint: [0xd8e3b6, 0xc4dfa2, 0xe6e6ae],
    /**
     * Birch is the species that turns first and hardest, and it is 35% of the
     * wood — so one archetype in three going yellow is the biggest single lever
     * on "the forest is all one green" that exists here.
     *
     * DRAWN AT hue 70, NOT AT 46. Gold in the texture AND gold in the tint is a
     * tree the colour of a traffic cone standing in July, which is the paintbox
     * the brief warned about. The canvas moves fourteen degrees toward yellow
     * and the tint palette does the rest, so what comes out is a birch on the
     * turn rather than a birch on fire — and because the tint is per instance,
     * no two of them turn by the same amount.
     */
    variants: [
      { tint: [0xd8e3b6, 0xc4dfa2, 0xe6e6ae, 0xcfe0b4, 0xbdd899] },
      {
        /**
         * Birch catkins hang in threes off the twig ends all spring.
         *
         * THE HARDEST OF THE FIVE TO MAKE VISIBLE, and both reasons are the
         * birch's. Its `length` is the shortest in the table (0.16) so a truss
         * sized off it is the smallest; and its leaves are the widest (0.875),
         * so they cover more of the card than any other species' do. At the
         * first values — span 0.95, a dull olive at 52/42 — the catkins were
         * physically correct and completely invisible: forty-texel marks in a
         * dull yellow-brown, on a yellow-green card, behind the biggest leaves
         * in the wood. Bigger AND warmer AND more of them, because on this
         * species none of the three is enough on its own.
         */
        leaf: {
          adorn: { kind: 'catkin', count: 11, span: 1.25, hue: 44, sat: 64, light: 54 },
        },
        tint: [0xc9dcae, 0xd4e3b8, 0xbcd3a4, 0xdfe5bd, 0xc2d6a6],
      },
      {
        leaf: { hue: 70, sat: 52, light: 41, count: 178 },
        tint: [0xe8d489, 0xf0dd9a, 0xdcc274, 0xe3cf94, 0xd8b968],
      },
    ],
  },
  oak: {
    height: [11, 18],
    trunkRadius: 0.52,
    taper: 0.42,
    branchStart: 0.34,
    branches: 7,
    branchLength: [0.36, 0.6],
    droop: 0.05,
    levels: 3,
    leafPerBranch: 7,
    leafOnBough: 2,
    leafSize: [2.4, 4.1],
    bark: { hue: 28, sat: 20, light: 19 },
    leaf: { hue: 96, sat: 40, light: 27, count: 172, length: 0.19, width: 0.77 },
    tint: [0x8fae7a, 0xa9bd7e, 0x7b9d6c],
    /**
     * `span: 0.95` and not 0.62. At 0.62 an acorn came out 18 texels tall, which
     * is four pixels at thirty metres — under the threshold where a mark is a
     * mark rather than noise, and the brief is explicit that a subpixel speck is
     * not worth the bytes. Looked at on the flat, 0.78 was still a scattering of
     * brown dots rather than acorns. 0.95 puts a nut at 27 texels and six
     * clusters on each of about sixty cards is three hundred and fifty to a
     * tree, which at thirty metres is the brown speckling an oak in mast has and
     * at five is legibly a nut in a cup.
     */
    variants: [
      { tint: [0x8fae7a, 0xa9bd7e, 0x7b9d6c, 0x93b585, 0x6f9161] },
      {
        leaf: {
          adorn: { kind: 'acorn', count: 6, span: 0.95, hue: 34, sat: 48, light: 46 },
        },
        tint: [0x8aa974, 0x9cb47e, 0x7f9e6b, 0xa4bb88, 0x86a271],
      },
      {
        // The dark oak: drawn colder and dimmer and tinted the same way, because
        // a deep shade tree is the counterweight that makes the yellow birches
        // read as yellow rather than as the new normal.
        leaf: { hue: 106, sat: 44, light: 22, count: 178, width: 0.82 },
        tint: [0x62855c, 0x6d9166, 0x587a55, 0x74997a, 0x5f8a6c],
      },
    ],
  },
  willow: {
    height: [10, 15],
    trunkRadius: 0.4,
    taper: 0.36,
    branchStart: 0.4,
    branches: 10,
    branchLength: [0.34, 0.55],
    droop: 0.85,
    levels: 2,
    leafPerBranch: 7,
    leafOnBough: 2,
    leafSize: [2.2, 3.6],
    bark: { hue: 32, sat: 16, light: 24 },
    leaf: { hue: 76, sat: 34, light: 33, count: 158, length: 0.26, width: 0.385 },
    tint: [0xc2cf94, 0xaec288, 0xd2d8a4],
    /**
     * Pussy willow is nearly white and the willow lives on the stream bank in
     * the deepest shade in the world, so it is the highest-contrast fruit
     * treatment of the five for the least paint. `span: 0.7` off a `length` of
     * 0.26 is the largest truss in the table in absolute texels, which is right:
     * a willow catkin is 3 cm against a leaf 8 cm long and 6 mm wide, so it is
     * the one place in this wood where the fruit is genuinely bigger than the
     * leaf that carries it.
     */
    variants: [
      { tint: [0xc2cf94, 0xaec288, 0xd2d8a4, 0xb8c98f, 0xccd39c] },
      {
        leaf: {
          adorn: { kind: 'catkin', count: 8, span: 0.7, hue: 66, sat: 24, light: 76 },
        },
        tint: [0xc8d29e, 0xbccb93, 0xd6dcab, 0xc0cd98, 0xd0d6a2],
      },
      {
        // Glaucous: a real willow trait — the underside of the leaf is waxy and
        // blue, and a bank of them in the wind flickers between two colours.
        leaf: { hue: 104, sat: 22, light: 35, count: 150 },
        tint: [0xa9c3b0, 0xb6ccb8, 0x9bb8a6, 0xc0d2be, 0xa2bdad],
      },
    ],
  },
  /**
   * ==== THE ROWAN: THE FIFTH SPECIES, AND THE ONE THAT IS IN FLOWER =========
   *
   * The brief asked for blossom, and blossom is worth a species of its own
   * rather than a state on an existing one. A rowan does both jobs at once — it
   * carries flat creamy corymbs of flower in spring and dense scarlet trusses of
   * berry in autumn, which are the two most legible things that can be hung in a
   * green canopy — so one addition covers both halves of the request, and the
   * two states can be different archetypes and therefore different skeletons.
   *
   * WHAT THE FIFTH SPECIES ACTUALLY COSTS, because a species is nine streamed
   * meshes and this project does not add draw calls without saying so.
   *
   *   IT ADDS NO TREES, AND THAT IS CHECKED RATHER THAN ASSERTED. `speciesAt`
   *   RE-LABELS trees the wood was already going to plant — it consumes the same
   *   single roll it always did, at the same point in the same stream — so the
   *   set of trunks is bit-for-bit the one that was there before. authored-check
   *   counts 65 143 guaranteed-resident instances at the spawn point both before
   *   and after, over 53 layers and then 62.
   *
   *   IT ADDS NINE MESHES — trunk, far trunk and canopy times three archetypes —
   *   so 53 streamed meshes become 62 and `perf:gpu` reads 142 draws where it
   *   read 151. An empty layer is not a draw call at all: `packSlab` sets
   *   `mesh.visible = false` at zero instances, which is why the three willow
   *   layers cost nothing at a station with eighteen willows in it.
   *
   *   AND IT TAKES 0.73 M TRIANGLES OFF THE FRAME, which was not the plan and is
   *   the best thing about it. A rowan is 9 boughs over 2 levels on an 8–14 m
   *   bole; the oaks it displaces are 7 boughs over THREE levels on an 11–18 m
   *   one, and are among the heaviest trunk geometries in the table. Trunks are
   *   89% of the world's triangles, so swapping a tenth of the oaks for rowans
   *   is worth 13.36 M -> 12.63 M sober and 12.19 M -> 11.57 M at ego death,
   *   measured A/B/A. Nine draw calls for five and a half per cent of the
   *   geometry is a trade this frame takes every time.
   *
   *   IT COSTS MEMORY: nine slabs at TREE_CAPACITY is 11.2 MB and the eleven
   *   extra canopy canvases are another 11. endless-check reads 132.6 MB of heap
   *   before and 159–169 after depending on where the sample lands relative to a
   *   collection — and, which is the number that matters, unchanged end to end
   *   over a 2 km walk. It is allocation, not a leak.
   *
   * A ROWAN IS A SMALL TREE, and that is the second reason to add one rather
   * than to bloom an oak. Its 8–14 m against the pine's 15–27 widens the size
   * range of the wood at the species level, which is half of what "different
   * sizes" asks for; the other half is the instance scale in scatter.js.
   */
  rowan: {
    height: [8, 14],
    trunkRadius: 0.19,
    taper: 0.36,
    branchStart: 0.38,
    branches: 9,
    branchLength: [0.32, 0.54],
    // Negative droop is an upswept branch. A rowan holds its crown open and up,
    // which is what lets you see into it — and a flowering tree whose flowers
    // are hidden under its own canopy is a waste of the paint.
    droop: -0.12,
    levels: 2,
    leafPerBranch: 8,
    leafOnBough: 2,
    leafSize: [1.7, 2.8],
    // Smooth pale grey, nearly unfissured. The bark routine's lenticels do most
    // of the work at this lightness, which is correct: a rowan's trunk is
    // marked with them rather than cracked.
    bark: { hue: 30, sat: 9, light: 43 },
    leaf: { hue: 92, sat: 40, light: 34, count: 170, length: 0.17, width: 0.66 },
    tint: [0xc6cdae, 0xd0d4b6, 0xbcc6a4],
    /**
     * THE TINTS HERE ARE NEARLY NEUTRAL, AND THAT IS THE WHOLE TRICK.
     *
     * The instance colour MULTIPLIES the texel, so a white petal under the green
     * tint the other species use comes out pale green — i.e. the blossom would
     * be a slightly brighter patch of canopy, which is not blossom. Painting the
     * true colour into the canvas and tinting near-neutral is what keeps white
     * white and scarlet scarlet. The leaves are drawn a few points lighter than
     * the other broadleaves to pay for the tint no longer lifting them.
     *
     * The price is that a rowan varies less from tree to tree than an oak does.
     * It is the right way round: the variation the eye wants from a rowan is
     * "that one is in flower and that one is in berry", not "that one is a
     * slightly different green".
     */
    variants: [
      {
        leaf: {
          adorn: { kind: 'blossom', count: 10, span: 0.9, hue: 44, sat: 26, light: 93 },
        },
        tint: [0xd6d2c2, 0xcfcdbe, 0xdcd8c6, 0xc9c8ba, 0xd8d4c0],
      },
      {
        leaf: {
          adorn: { kind: 'berry', count: 8, span: 0.82, hue: 14, sat: 84, light: 47 },
        },
        tint: [0xd2cdba, 0xc7c6b4, 0xd9d2c0, 0xcdc9b6, 0xd4cebc],
      },
      {
        // Coming into flower: fewer, smaller trusses on a greener canvas, so the
        // three rowans in a view are not the same tree three times. This is the
        // archetype that pays for the atlas not existing — see the variants note
        // above — and four trusses against ten is what makes it read as a
        // different tree rather than as the same one dimmed.
        leaf: {
          hue: 88,
          light: 32,
          count: 174,
          adorn: { kind: 'blossom', count: 4, span: 0.72, hue: 40, sat: 22, light: 90 },
        },
        tint: [0xc6cdae, 0xd0d4b6, 0xbcc6a4, 0xcad1b2, 0xb6c19e],
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
function sweep(points, radii, flexes, phase, radial = 6, { capStart = false, capEnd = false } = {}) {
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
    const ref = Math.abs(tangent.y) > 0.92 ? alt : up;
    binormal.crossVectors(tangent, ref).normalize();
    normal.crossVectors(binormal, tangent).normalize();
    if (i > 0) running += p.distanceTo(points[i - 1]);

    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * TAU;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const nx = normal.x * cos + binormal.x * sin;
      const ny = normal.y * cos + binormal.y * sin;
      const nz = normal.z * cos + binormal.z * sin;
      const idx = i * (radial + 1) + j;
      positions[idx * 3] = p.x + nx * radii[i];
      positions[idx * 3 + 1] = p.y + ny * radii[i];
      positions[idx * 3 + 2] = p.z + nz * radii[i];
      normals[idx * 3] = nx;
      normals[idx * 3 + 1] = ny;
      normals[idx * 3 + 2] = nz;
      uvs[idx * 2] = j / radial;
      uvs[idx * 2 + 1] = running * 0.35;
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
      uvs[w * 2] = u;
      uvs[w * 2 + 1] = v;
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
        end.p.x + (end.n.x * cos + end.b.x * sin) * end.r,
        end.p.y + (end.n.y * cos + end.b.y * sin) * end.r,
        end.p.z + (end.n.z * cos + end.b.z * sin) * end.r,
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
  const height = rngRange(rng, spec.height[0], spec.height[1]);
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

  // ---- trunk --------------------------------------------------------------
  const trunkRings = 9;
  const trunkPoints = [];
  const trunkRadii = [];
  const trunkFlex = [];
  const leanDir = rng() * TAU;
  const lean = rngRange(rng, 0.02, 0.09);
  for (let i = 0; i < trunkRings; i++) {
    const t = i / (trunkRings - 1);
    // A trunk is never straight. A slow sway plus a small random walk gives the
    // silhouette the irregularity that separates a tree from a lamppost.
    const bend = Math.pow(t, 1.6) * height * lean;
    trunkPoints.push(
      new THREE.Vector3(
        Math.cos(leanDir) * bend + Math.sin(t * 5.1 + rng()) * 0.14 * height * 0.06,
        t * height,
        Math.sin(leanDir) * bend + Math.cos(t * 4.3 + rng()) * 0.14 * height * 0.06
      )
    );
    // Root flare: the bottom fifth widens quickly, which is a strong cue that
    // the tree is growing out of the ground rather than resting on it.
    const flare = 1 + Math.pow(Math.max(0, 1 - t * 5), 2.2) * 0.85;
    trunkRadii.push(spec.trunkRadius * (1 - t * (1 - spec.taper)) * flare);
    trunkFlex.push(Math.pow(t, 2.4) * 0.55);
  }
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

  // ---- branches -----------------------------------------------------------
  const farStride = Math.max(1, Math.round(spec.branches / FAR_BRANCHES));
  const queue = [];
  for (let i = 0; i < spec.branches; i++) {
    const t = spec.branchStart + (1 - spec.branchStart) * Math.pow(i / spec.branches, 0.82);
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
        const size = rngRange(rng, spec.leafSize[0], spec.leafSize[1]) * sizeScale;
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
        0.8,
        // The bough's own flex ramp, plus a little: a leaf hanging off a limb
        // whips further than the limb does.
        (along) => Math.min(1, b.flexFrom + (1 - b.flexFrom) * Math.pow(clamp01(along), 1.5) + 0.15)
      );
    } else {
      // Terminal branch: hang the bulk of the foliage here.
      hang(spec.leafPerBranch, 0.45, 1.08, 0.35, 1, (along) => 0.72 + 0.28 * clamp01(along));
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
  const bark = barkTexture({ key: name, ...spec.bark, seed: `bark:${name}` });
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
  const trunkMat = makeLiving(
    new THREE.MeshLambertMaterial({
      map: bark,
      color: 0xffffff,
    }),
    'plant',
    { bark: true, receivesShadow: false }
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
