/**
 * THE WINTER WOOD — a boreal conifer forest under snow.
 *
 * The second land, and it was chosen on ARCHITECTURE rather than on taste. Four
 * things about this repo make a taiga the cheapest possible second world, and
 * every one of them is a reason a desert or a savannah would have been dearer:
 *
 *   THE LAYER TABLE IS A LIST YOU DELETE FROM. A boreal floor has no bramble,
 *   no wildflower meadow, no understorey palms, no bromeliads and no
 *   door-sized aroids. Dropping those six rows removes six alpha-tested card
 *   layers — the most expensive shape in the world, 1.45 ms per Mtri against
 *   the opaque layers' 0.2 — and six placement rules that would otherwise have
 *   had to be rewritten. The usual cost curve for "add content" runs the other
 *   way; this one inverts it.
 *
 *   `needle: true` ALREADY EXISTS as a leaf flag in trees.js, and a conifer is
 *   the easiest tree in that grammar: narrow, high `taper`, whorled branches,
 *   and NONE of `buttress`, `stilts`, `lianas` or `epiphytes`, all four of
 *   which are optional-by-presence. A spruce is five fields fewer than a palm.
 *
 *   A CONIFER STAND STILL SELF-OCCLUDES, which is not a small thing. The
 *   recorded finding is that this forest hides everything past 40 m and that
 *   cutting draw distance is invisible at eye level and catastrophic from
 *   above; `sky` measures as a NET OCCLUDER at -0.07 ms. An open biome is not
 *   automatically cheaper — remove the canopy and you must draw to 384 m in
 *   every direction — so the one structural property the second land had to
 *   keep was a closed roof. This land's mean canopy is deliberately within a
 *   few per cent of the rainforest's; what is open is the FLOOR, not the stand.
 *   The impostor tuning and `REACH_TABLE` therefore survive unchanged.
 *
 *   AND IT IS THE BEST SOCIAL FIT AVAILABLE. `gathering.js` already builds a
 *   commons fire with two rings of logs round it. Cold is the one thing that
 *   makes standing round a fire MEAN something rather than being scenery, and
 *   this app is a place for friends to stand about and talk.
 *
 *
 * ==== WHAT IS ACTUALLY DIFFERENT, AND WHAT IS THE SAME SLOT RENAMED =========
 *
 * The point of a second land is to find out which parts of the abstraction are
 * real, so it is worth being exact about which of this file's differences are
 * structural and which are a coat of paint.
 *
 * GENUINELY DIFFERENT:
 *   `exposure`, a weight the rainforest has no analogue of — wind-scoured
 *   ground where the trees give up. It is what the lichen crusts key to, and it
 *   is the reason this land's bald floor is a PLACE rather than an absence.
 *   `scrub` is NOT excluded from `damp` the way `bramble` is excluded, because
 *   willow and dwarf birch are bog-margin plants; that one dropped factor is
 *   most of why a muskeg here reads as a muskeg.
 *   The water term in the density product is 1.4 rather than 1.6, because black
 *   spruce and larch grow IN the bog. In the rainforest the stream is a hole in
 *   the wood; here it is a place the wood thins into rather than stops at.
 *   Snow, which is a seventh substrate in the ground palette and the only one
 *   that is not a substrate at all — it lies ON the others.
 *
 * THE SAME SLOT RENAMED, and honestly so:
 *   `drift` sits where `meadow` sat (open, lit, high `a`), `needle` where
 *   `litter` sat (the far end of `a` under a closed roof), `thicket` where
 *   `understorey` sat (closed roof, vigorous `b`). That is not a failure of the
 *   abstraction, it is the abstraction being right: any wood has an open end, a
 *   bald end, and a rank shaded end, and the two lattices that decide which is
 *   which are the same two lattices.
 *
 *
 * ==== THE ROSTER IS REAL NOW, AND THE SUBSTITUTION TABLE IS GONE ===========
 *
 * This file used to say the five conifer rows were "a pending patch to
 * trees.js" and carried a `SUBSTITUTE` map so the world would boot without
 * them: spruce -> palm, fir -> palm, birch -> cecropia, larch -> palm,
 * juniper -> brownea. `SPECIES` holds all five conifers now, so every entry in
 * that map was unreachable — and it was actively the wrong fallback to leave
 * lying about, because the only way it could ever fire again is if somebody
 * DELETED a conifer from `SPECIES`, and the thing it would do then is put palm
 * trees in the snow. `treeSector`'s `?? roster[0]` gives spruce instead, which
 * is the right answer to "we lost a species here" in this land and needs no
 * table. So the table is deleted rather than kept as a stale safety net.
 *
 * WHAT THE STALE COMMENT COST, because it is the recorded shape of the bug:
 * `scripts/land-identity.mjs` hard-coded the same five rainforest names beside
 * the same claim, so the pinned taiga hash described a wood made of palms, and
 * because spruce, fir AND larch all folded onto `palm` a change to the
 * spruce/fir altitude threshold produced a bit-identical hash. A gate that
 * cannot see a change is worse than no gate. See `src/world/species-names.js`.
 */

import { TAU, clamp01, rngRange, smoothstep } from '../../core/util.js';

/* ========================================================================== */
/* the roster                                                                 */
/* ========================================================================== */

/**
 * FIVE CONIFERS AND ONE BROADLEAF, which is roughly what a real boreal wood is.
 *
 * All five exist in `SPECIES` — this list used to be a wish and is now a fact,
 * see the header. The shapes they asked for, and got, are all one archetype
 * apart:
 *
 *   spruce   the dominant spire. Narrow, `taper` high, branches short and
 *            whorled and dropping almost to the ground on an open-grown one.
 *   fir      the same silhouette a little softer and a little shorter; it takes
 *            the high ground because that is where fir replaces spruce.
 *   birch    the pale trunk in a light gap. The only broadleaf here and the
 *            only thing in this land that is not dark green, which is precisely
 *            why it is worth its share.
 *   larch    the bog conifer. Larix in muskeg is real and it is the one tree
 *            that should stand IN the wet ground rather than beside it, which
 *            is why it takes the slot the fig takes in the rainforest.
 *   juniper  the low scrub-tree that fills the ground the others left. It is
 *            this land's answer to the empty 2-12 m band the rainforest needed
 *            understorey palms for.
 */
const ROSTER = ['spruce', 'fir', 'birch', 'larch', 'juniper'];

/**
 * Which species wants this spot. Same calling convention as every land's:
 * ONE roll against a ladder of thresholds, never one roll per species.
 *
 * THE SHARES ARE THE ARGUMENT, and they are not the rainforest's numbers with
 * new labels on them. A boreal forest is far less even than a tropical one —
 * two or three species are almost the whole wood — so the ladder is
 * deliberately top-heavy where the rainforest's is spread:
 *
 *   larch    wet ground, roll < 0.70.  The muskeg tree; it is the only one here
 *            whose gate is wetness, and it is a lower share than the fig's 0.75
 *            because the others are allowed into the bog behind it.
 *   fir      high ground, roll < 0.72. Fir replaces spruce with altitude.
 *   spruce   roll < 0.52 everywhere else, and again at the bottom — so it is
 *            the plurality of the wood by a wide margin, which is what a spruce
 *            forest is.
 *   birch    broken canopy, roll < 0.66. A pioneer in a light gap, the same
 *            ecological role and the same `density` gate the brownea has, and
 *            the same reason: a pale crown reads at thirty metres only where
 *            there is sky behind it.
 *   juniper  the remainder, ~20%. Small, dense, and it is what stops the
 *            sightline at knee-to-shoulder height.
 *
 * The `alt` divisor is 34 rather than 40 and the offset is 4 rather than 6:
 * this land's treeline effect should start lower, so that the one 30-46 m ridge
 * every world has actually reads as a change of forest rather than as the same
 * wood higher up.
 */
function speciesAt(y, wet, roll, density = 1) {
  const alt = clamp01((y + 4) / 34);
  if (wet > 0.3 && roll < 0.7) return 'larch';
  if (alt > 0.52 && roll < 0.72) return 'fir';
  if (roll < 0.52) return 'spruce';
  if (density < 0.66 && roll < 0.66) return 'birch';
  return roll < 0.8 ? 'spruce' : 'juniper';
}

/* ========================================================================== */
/* how much forest wants to be here                                           */
/* ========================================================================== */

/**
 * THE MEAN CANOPY IS HELD AND THE CONTRAST IS RAISED, and that pairing is the
 * whole perf story of this land.
 *
 * `groveBase` 0.62 -> 0.60 with `groveGain` 0.55 -> 0.62. `grove()` is a
 * zero-mean fbm, so the MEAN of `base + grove*gain` moves by 0.02 — inside the
 * noise on anything that measures a frame — while the spread widens by 13%.
 * What that buys is stands you can see the edge of and openings you can stand
 * in, which is what a boreal forest looks like from the air and what the
 * rainforest deliberately does not have.
 *
 * IT MUST NOT BECOME AN OPEN BIOME. The recorded finding is that this forest
 * occludes itself and that `sky` measures as a net occluder; a land whose mean
 * canopy dropped to 0.4 would have to draw to 384 m in every direction and
 * would be dearer than the rainforest despite having six fewer card layers.
 * The openness here is in the FLOOR — six dropped layers and a much sparser
 * sward — and not in the stand.
 *
 * `wet` 1.6 -> 1.4. In the rainforest the stream is a hole in the wood; black
 * spruce and larch grow in standing water, so here the wood thins into the bog
 * instead of stopping at it. This is the single most characteristic thing about
 * the boreal margin and it costs one number.
 *
 * `slope` and the three clearing/rim terms are unchanged. The spawn glade is a
 * social feature and it is the same social feature in any weather.
 */
const DENSITY = {
  groveFreq: 0.0125,
  groveOctaves: 3,
  groveGain: 0.62,
  groveBase: 0.6,
  clearingRadius: 14,
  clearingRim: 7,
  wet: 1.4,
  slope: 2.4,
  rimGain: 1.1,
  rimOffset: 6,
  rimWidth: 10,
  /**
   * Unreachable in practice and declared anyway. Seed 0 is `grove-01`, which
   * has no land prefix and is therefore always the rainforest; `taiga:grove-01`
   * is a different string and hashes to something else. If that ever changes,
   * these must not be the rainforest's `5, -9` — two lands sharing a lattice
   * offset is two lands whose stands are in the same places.
   */
  identity: [137, -63],
};

/**
 * A little narrower than the rainforest's 0.50-1.48.
 *
 * A spruce stand is famously even-aged — that is what a stand IS — so a 2.9x
 * spread between the smallest and largest tree of one species reads as damage
 * rather than as variety here. 2.64x, and the top end is well under the 1.643
 * ceiling `stumpCollider` and fauna.js's radius filter impose (0.28·1.45 + 0.34
 * = 0.746, against the 0.8 above which a trunk stops being indexed as a tree
 * and the birds quietly stop perching in it).
 *
 * AREA IS NOT NEUTRAL AGAINST THE RAINFOREST AND DOES NOT NEED TO BE. Canopy
 * cost goes as scale squared and E[s²] over [a,b] is (a²+ab+b²)/3: this range
 * gives 0.9808 against the rainforest's 1.0601, i.e. 7.5% less foliage area per
 * tree before the conifer's own much narrower crown is counted.
 */
const TREE_SCALE = [0.55, 1.45];

/* ========================================================================== */
/* what kind of place this is                                                 */
/* ========================================================================== */

/**
 * EIGHT WEIGHTS, AND THREE OF THEM ARE NOT THE RAINFOREST'S WITH NEW NAMES.
 *
 * See this file's header for which is which. The rules that carry over from
 * `character`'s own header and are not negotiable in any land:
 *
 *   TWO FIELDS, DECORRELATED. `a` is the grain of the ground, `b` is how
 *   vigorous the growth is, and they must not share a lattice.
 *
 *   THE WEIGHTS MUST BE COMPETITIVE. Independent weights give a place that is
 *   40% of three things at once, which on the ground is a mess with no
 *   character at all.
 *
 *   NO THIRD LATTICE. A third fbm is a third pair of hash-lattice taps on every
 *   one of the ~50 000 candidates a sector tests here.
 */
function makeCharacter({ forestDensity, wetness, fbm2, offsets }) {
  return function character(x, z, out) {
    const o = offsets();
    // ~80 m per feature, on the same lattice the rainforest uses. The offsets
    // are per-seed, so two lands on two seeds cannot line up.
    const a = fbm2(x * 0.0125 + o.ax, z * 0.0125 + o.az, 3) * 0.5 + 0.5;
    // ~110 m, and offset a long way off `a`'s lattice.
    const b = fbm2(x * 0.0091 + o.bx, z * 0.0091 + o.bz, 2) * 0.5 + 0.5;
    const canopy = forestDensity(x, z);
    const wet = wetness(x, z);

    out.canopy = canopy;
    out.wet = wet;
    /**
    /**
     * WIDER THAN A FLOOD PLAIN, AND STILL NOT A MUSKEG — and it is worth being
     * exact about that rather than claiming the bog this land wants.
     *
     * The rainforest opens `damp` at wetness 0.26 and saturates over 0.42,
     * which is roughly the top of the stream bank. 0.20 / 0.50 here widens the
     * band by about half, which puts larch and willow scrub further out onto the
     * flats — the right direction, and a small effect.
     *
     * IT CANNOT BE MORE THAN THAT FROM HERE, because `wetness()` is the distance
     * to the stream channel and nothing else. Measured on a 24 m lattice over a
     * 3 km box, `damp > 0.25` reaches 0.4% of the ground in this land and 0.5%
     * in the rainforest: it is a ribbon in both, and no threshold applied to a
     * ribbon makes a region. terrain.js's own header says as much — "sampled on
     * a 4 m lattice it returns 0.000 at every one of the eight camera stations"
     * — and `heightGrid` already works around it for the GROUND COLOUR with a
     * `basin` term (low ground that is also flat, so a hollow holds water and a
     * slope of the same height does not) plus a 50 m `seep` field. That
     * arithmetic is local to the colour loop and is not exported, so the scatter
     * cannot see it.
     *
     * A real muskeg therefore needs `wetness` — or a sibling of it — to gain the
     * basin term and be exported from terrain.js, which would move the
     * rainforest too and is a separate, measurable change rather than something
     * to smuggle into a land descriptor. Recorded here so the next person does
     * not spend an afternoon tuning these two numbers wondering why the bog will
     * not grow.
     */
    out.damp = smoothstep(clamp01((wet - 0.2) / 0.5));

    /**
     * DRIFT — the open, lit ground, where the snow lies deepest and the tussock
     * sedge stands through it.
     *
     * The same slot `meadow` occupies and for the same reason: long grass grows
     * where the trees are not. `1 - canopy * 1.15` is slightly more generous
     * than the rainforest's 1.22 because this land's canopy is more contrasty
     * and its openings are genuinely open; the cut-off lands at canopy 0.87.
     *
     * `1 - damp * 0.55` rather than the rainforest's full exclusion. A frozen
     * bog in winter is open ground with sedge sticking out of it, so damp
     * ground here is only half a reason not to be drift.
     */
    out.drift =
      clamp01(1 - canopy * 1.15) * smoothstep(clamp01((a - 0.4) / 0.24)) * (1 - out.damp * 0.55);

    /**
     * SCRUB — dwarf birch and willow, and THE ONE FACTOR IT DOES NOT CARRY IS
     * WHAT MAKES IT NOT BRAMBLE.
     *
     * `bramble` in the rainforest is multiplied by `1 - damp`: a thicket forms
     * on the dry broken edge and not in the wet. Willow and dwarf birch do the
     * exact opposite — they are bog-margin plants, and the densest scrub in a
     * boreal landscape is the fringe where the muskeg meets the trees. So this
     * carries no damp exclusion at all, and instead a mild `+ damp * 0.4`.
     *
     * That one dropped factor is most of why a bog here reads as a bog rather
     * than as a bald wet patch, and it is the clearest example in this file of a
     * weight that could NOT have been the rainforest's with a different
     * threshold.
     *
     * The edge band is at canopy 0.48 rather than 0.52 — a boreal edge is a
     * wider, softer thing than a tropical one, so the band is broadened to 2.2
     * from 2.6 as well.
     */
    const edge = 1 - Math.abs(canopy - 0.48) * 2.2;
    out.scrub =
      clamp01(clamp01(edge) + out.damp * 0.4) *
      smoothstep(clamp01((b - 0.46) / 0.2)) *
      (1 - out.drift * 0.85);

    /**
     * NEEDLE — the bald floor. Deep duff under a closed stand, and nothing
     * growing on it.
     *
     * The same slot `litter` occupies, with the same shape and the same lesson
     * baked in: the rainforest's version once ANDed two independent one-in-eight
     * conditions together and reached 8.4% of the ground, which is a biome
     * nobody has ever seen. So the `a` half is centred (0.58 / 0.28 clears 0.5
     * at a < 0.44) and the canopy half is a weighting with a floor rather than a
     * second hard AND.
     *
     * It is WIDER here than there, deliberately: 0.4 + 0.6·clamp01(canopy·1.8)
     * against 0.35 + 0.65·clamp01(canopy·1.9). A spruce floor is the emptiest
     * ground in any forest on earth — a closed stand puts almost no light on it
     * and drops an acid duff that almost nothing germinates in — and emptiness
     * is what this land is allowed to spend instead of cards.
     */
    out.needle =
      smoothstep(clamp01((0.58 - a) / 0.28)) *
      (0.4 + 0.6 * clamp01(canopy * 1.8)) *
      (1 - out.damp);

    /**
     * THICKET — young spruce regeneration under a closed vigorous stand. The
     * slot `understorey` occupies, and the layers that read it are the same two
     * (shrubs and saplings) that stop a sightline.
     *
     * `1 - needle * 0.8` rather than a full exclusion, for the reason the
     * rainforest gives: zero would make the two weights a partition and put a
     * visible seam where `a` crosses its threshold.
     */
    out.thicket =
      clamp01(canopy * 1.25) *
      smoothstep(clamp01((b - 0.44) / 0.24)) *
      (1 - out.needle * 0.8) *
      (1 - out.drift * 0.6);

    /**
     * EXPOSURE — THE WEIGHT THE RAINFOREST HAS NO ANALOGUE OF, and the reason
     * this land needed its own `character` rather than the rainforest's with new
     * thresholds.
     *
     * It occupies the SLOT `flower` occupies — open ground at the low end of `b`
     * — and it means the opposite of what `flower` means. Where the rainforest's
     * spare, unvigorous, open ground is a wildflower patch, a boreal one is
     * wind-scoured: thin snow, bare frost-heaved gravel, and mats of pale
     * Cladonia lichen. Both are "the open ground where nothing much is growing";
     * only one of them is pretty about it.
     *
     * It is what the `litter` layer's pale variant keys to, and it is why this
     * land's bald floor is a PLACE with a texture of its own rather than an
     * absence. It costs nothing — two fields this function already has.
     *
     * THE FIRST FITTING OF THIS REACHED 3.1% OF THE GROUND, which is the exact
     * failure the rainforest's `litter` weight has on record and which this land
     * managed to reproduce from scratch on its first try. It read
     * `clamp01(1 - canopy * 1.45) * smoothstep((0.5 - b) / 0.28)`, and both
     * halves were tails: the canopy term is identically zero above canopy 0.69
     * and this world's canopy distribution, measured on a 24 m lattice over a
     * 3 km box, is
     *
     *   0.0  0.9%   0.2  2.7%   0.4  18.5%   0.6  21.7%   0.8  6.7%
     *   0.1  0.5%   0.3  9.2%   0.5  23.2%   0.7  15.3%   0.9  1.4%
     *
     * — 68% of the ground above 0.5 and a mean of 0.577, so the term was 0.16 at
     * the average point and the product of two such conditions covered a
     * thirtieth of the world. A biome that operates on a thirtieth of the world
     * is a biome nobody has ever seen, and the layer keyed to it (the pale
     * lichen mats) would have looked exactly like a layer that works.
     *
     * The fix is the same shape the rainforest's was. `1.45 -> 1.28` moves the
     * cut-off to canopy 0.78 so roughly three quarters of the ground is in play
     * at all, and the `x1.7` gain turns the canopy half from a second hard AND
     * into a weighting — 0.61 at canopy 0.5, 0.39 at 0.6, 0.18 at 0.7 — so the
     * `b` field decides WHERE and the canopy only decides how much. Measured
     * after, on the same lattice: `exposure > 0.25` on 13.3% of the ground
     * against 3.1% before, and against `drift`'s 25.5% and `needle`'s 45.7% —
     * which is the "rarer than merely open ground but still an ordinary place"
     * this was aiming at.
     */
    out.exposure =
      clamp01((1 - canopy * 1.28) * 1.7) *
      smoothstep(clamp01((0.52 - b) / 0.28)) *
      (1 - out.damp);

    return out;
  };
}

const WEIGHTS = ['drift', 'scrub', 'needle', 'damp', 'exposure', 'canopy', 'wet', 'thicket'];

/* ========================================================================== */
/* the ground                                                                 */
/* ========================================================================== */

/**
 * SIX SUBSTRATES AND A SEVENTH THING THAT IS NOT A SUBSTRATE.
 *
 * The six follow the rainforest's rules exactly — chosen in LINEAR, ratios
 * preserved, nothing near-neutral picked by eye on a colour wheel — and the
 * whole palette is pulled cold and desaturated. The trap the rainforest palette
 * records applies verbatim here and bites harder, because a cold grey is
 * exactly the kind of colour whose sRGB hex lies to you: 0x45464a is R69 G70
 * B74, a spread of five counts that by eye is nothing, and that is deliberate —
 * see the rock note there.
 *
 *   moss     0x4f5450  feathermoss and Cladonia under the stand. Grey-green,
 *                      not the rainforest's yellow-olive: a boreal moss layer
 *                      is nearly neutral and it is what most of the un-snowed
 *                      floor actually is.
 *
 *                      WAS 0x4a5348, AND THE CHROMA IS HALVED. See the SNOW
 *                      BLEND ARITHMETIC block below for the whole story; the
 *                      short version is that the substrate showing through
 *                      thin snow was 49% of the frame rather than the tenth
 *                      the palette was picked for, and at that weight this
 *                      entry's 11 counts of green-over-red were reading as
 *                      algae. Rec.709 luma is HELD — 80.3 to 82.7, +3% — and
 *                      only the chroma moved, which is the rule the rainforest
 *                      palette states and the one thing that keeps a hue edit
 *                      from silently being a brightness edit.
 *   litter   0x39291b  needle duff. Darker and much less red than the
 *                      rainforest's leaf litter — spruce duff is nearly black
 *                      where it is wet and a dull rust where it is not.
 *   dry      0x453424  frost-heaved mineral soil where the duff has scoured
 *                      off. It takes the laterite's slot and must stay close to
 *                      `litter` in luma for the same reason: a bank that is
 *                      brighter than the flat reads as a paint stripe.
 *   gravel   0x5a5a55  glacial silt at the waterline. The one PALE substrate,
 *                      and it is neutral rather than warm.
 *   soak     0x24211a  black bog. The darkest thing here by a wide margin,
 *                      which is what makes the muskeg legible from a distance.
 *   rock     0x45464a  cold grey, faintly blue. 1.15x `litter`'s linear luma —
 *                      the same fifth of a stop the rainforest's rock takes,
 *                      because a slope reads as rock by having no hue rather
 *                      than by being bright.
 *
 * ==== AND THEN SNOW, WHICH LIES ON TOP OF ALL OF THEM ======================
 *
 * `snow` is the only entry in either palette that is not answering "what is
 * this ground made of". It is applied LAST, after every other lerp, so it
 * covers rather than competes — which is both physically right and the only
 * arrangement in which the substrate showing through a thin patch is the
 * substrate that would actually be there.
 *
 * ==== THE SNOW BLEND ARITHMETIC, WHICH IS WHERE THE ALGAE CAME FROM ========
 *
 * The photographed complaint was that in DAYLIGHT this floor is a mottle of
 * blue, green, cream and brown that reads as algae and mud, while at night,
 * lit blue, it is lovely. That split is the tell: the lighting is fine and the
 * albedo is wrong. Working it out on paper rather than by eye, because the
 * terms are all in this record and `heightGrid`'s loop is four lines:
 *
 *   lie = clamp01(1.1 - slope*snowSlope - (patch-0.5)*snowPatch)
 *       * clamp01(snowBase + snowCrest*crest²)
 *       * (1 - wetv*snowWet)
 *   colour = lerp(substrate, snow, lie * snowAmt)      // IN LINEAR
 *
 * At a typical flat station: terrain.js measures this world's median slope at
 * 0.005, so the first factor CLAMPS TO 1 and contributes nothing; `crest` is
 * clamp01((h-22)/18) and is 0 everywhere below 22 m, so the second factor was
 * flatly `snowBase` = 0.62; `wetv` floors at `wetFloor`*(0.5+seep*0.7) ~ 0.12,
 * so the third is 0.935. lie = 0.58, times `snowAmt` 0.88 = 0.51.
 *
 * SO HALF OF EVERY FLAT VERTEX WAS SUBSTRATE. Not a tenth — half. Composited
 * in linear against the old 0xa8b2be that came out sRGB (130,135,142) over
 * litter and (133,141,147) over moss and something else again over dry, rock
 * and soak, which is precisely "a mottle of blue, green, cream and brown". The
 * palette was not describing snow, it was describing a late-autumn dusting,
 * and every substrate hue in the table was showing at full strength through it.
 *
 * WHAT MOVED, AND THE ONE THAT MATTERS IS `snowBase`:
 *
 *   `snowBase` 0.62 -> 0.90. This is the fix. Flat low ground is covered.
 *   `snowCrest` 0.38 -> 0.12, so base+crest still saturates at 1.02 and the
 *   white summit — the only terrain-and-canopy-scale landmark this project has
 *   ever got to work — is unchanged.
 *   `snowPatch` 0.26 -> 0.55. With `snowBase` at 0.90 the first factor's 1.1 of
 *   headroom would swallow the old ±0.13 whole and the flat ground would come
 *   out an even sheet; ±0.275 puts the variation back, and it now lands where
 *   it should — in the snow's own VALUE rather than in how much green shows
 *   through it. It also widens the slope at which the cover gives out from a
 *   fixed 0.37 to a wandering 0.28-0.46, which is the painted-iso-line defence
 *   this term existed for in the first place.
 *   `snowAmt` 0.88 -> 0.94. Even deep snow keeps something of what is under it
 *   and a term that reaches 1.0 is a flat card, so this stays under one; a
 *   twentieth is enough now that the variation is carried by `snowPatch`.
 *
 * Computed after: lie runs 0.72-0.89 on flat ground, so the substrate is 15-32%
 * instead of 49%, and the composite over needle duff is sRGB (177,183,190).
 * That is snow — bright, faintly cool, with duff and stone breaking it up.
 *
 * NOT MEASURED ON A SCREEN. Every number above is arithmetic on this record and
 * terrain.js's blend, done because the alternative was picking a colour by eye,
 * which is the one thing this palette's own rules forbid. What has NOT been
 * checked is the tone map — see the clipping note below.
 *
 * 0xd2d9e2 AND STILL NOT WHITE, and this is the number to turn if it is wrong.
 * Its linear Rec.709 luma is 0.6882 against the old 0xa8b2be's 0.4388: 1.568x,
 * or +0.65 of a stop. The previous note here warned that a true white
 * (0xe8eef5, linear ~0.79) would be "another stop and a half"; the honest
 * figure is 0.85 of a stop, and this takes less than half of it. The failure
 * mode being guarded against is not "the snow looks grey", it is the ground
 * clipping to flat white in sun and the tone map eating every other value in
 * the frame with it — the same trap the fireflies and the bromeliads both
 * recorded from the other direction. THE CLIPPING WAS NOT MEASURED. If a noon
 * frame blows out, this entry comes down before anything else does.
 *
 * Saturation went DOWN as the value went up: (max-min)/max is 7.1% here
 * against 11.6% before. That is the shape the complaint asked for — a faint
 * cool hue shift rather than a blue-grey object — and it is why the night, in
 * which the blue comes from the light and not from the albedo, is unharmed.
 */
const GROUND = {
  moss: 0x50514e,
  litter: 0x39291b,
  dry: 0x453424,
  gravel: 0x5a5a55,
  soak: 0x24211a,
  rock: 0x45464a,

  /**
   * WHAT SHOWS THROUGH THIN SNOW SHOULD BE DUFF AND STONE, NOT MOSS.
   *
   * `heightGrid` blends `lerp(moss, litter, clamp01(patch*mossPatch - mossBias
   * - wetv*mossWet))`, so with `patch` uniform on [0,1] the old 1.3/0.10 sat at
   * a mean of 0.50 — an even moss/litter split. That was a fair description of
   * a summer boreal floor and the wrong one for what is left visible under
   * snow: feathermoss is the thing that gets buried, and what stands proud of a
   * winter floor is needle duff, frost-heaved gravel and rock.
   *
   * 1.5/-0.10 moves the mean to 0.80 litter while keeping BOTH ends reachable —
   * `patch` near 0 still gives 0.10, i.e. real moss, so the green has not been
   * deleted, only made the rarer end. A negative bias reads oddly and is
   * deliberate: raising `mossPatch` alone to reach the same mean would have
   * saturated the ramp at patch 0.60 and cut the floor into hard green and
   * brown regions, which is the painted-boundary failure this whole palette
   * keeps guarding against.
   */
  mossPatch: 1.5,
  mossBias: -0.1,
  mossWet: 0.4,
  dryRamp: 2.1,
  dryBias: 0.25,
  bareRamp: 4.2,
  bareBias: 0.55,
  barePatch: 0.22,
  crestFrom: 20,
  crestSpan: 18,
  crestGain: 0.78,
  /**
   * 0.22 -> 0.14. The rainforest's floor term says nothing here is ever
   * properly dry; a boreal one is dry wherever it drains, and the CONTRAST
   * between a drained rise and a bog thirty metres away is the whole reading of
   * the ground. What is lost is the uniform damp sheen, which is exactly what
   * should be lost.
   */
  wetFloor: 0.14,
  basinFrom: 5,
  basinSpan: 14,

  snow: 0xdfe0df,
  snowAmt: 0.975,
  /**
   * WHERE IT LIES. Three terms, and every input is one this loop already has —
   * no new noise, no new sample, and therefore nothing that can move a height.
   *
   *   `snowSlope` 3.0: full on the flat, gone by a slope of 0.37 (~20°). Snow
   *   slides, and a hillside that keeps its snow at 40° is a hillside with no
   *   shape at all. This is the term that gives the winter ridge its form.
   *
   *   `snowCrest` adds it back with height on the same squared `crest` ramp the
   *   rock uses, so the one 30-46 m ridge every world has comes out white on top
   *   and grey on its flanks. That is the single most legible landmark this
   *   world has ever had, and the recorded complaint is that the forest hides
   *   everything past 40 m and three attempts at a landmark were invisible
   *   because they were not terrain-and-canopy scale. A white summit is.
   *
   *   `snowWet` takes it off open water and bog. Ice would be better and ice is
   *   a shader, not a palette entry.
   *
   *   `snowPatch` perturbs the whole thing by ±0.275 at the 22 m `patch` scale,
   *   for the reason the rock ramp gives: a slope-only rule draws its boundary
   *   exactly along an iso-slope curve, which reads as a painted line.
   *
   * FOUR OF THESE FIVE MOVED WHEN THE FLOOR STOPPED READING AS ALGAE. The
   * arithmetic — why `snowBase` was the bug, why raising it forces `snowPatch`
   * up with it, and what the composite comes out as now — is in the SNOW BLEND
   * ARITHMETIC block above the palette. `snowSlope` and `snowWet` are the two
   * that did not move: the first is the winter ridge's shape and the second is
   * what keeps the muskeg dark, and both were doing their jobs.
   */
  snowSlope: 3.0,
  snowBase: 0.9,
  snowCrest: 0.12,
  snowWet: 0.55,
  snowPatch: 0.30,
};

/* ========================================================================== */
/* which layers exist                                                         */
/* ========================================================================== */

/**
 * TWELVE OF THE RAINFOREST'S EIGHTEEN, AND THE SIX MISSING ONES ARE THE POINT.
 *
 * Dropped: `ferns`, `bramble`, `flowers`, `palms`, `bromeliads`, `bigleaf`.
 *
 * Every one of those is a double-sided alpha-tested card layer, which is the
 * most expensive shape in this world by a long way — the ferns alone measure
 * 4.15 ms per million triangles at the canopy station against the sward's 1.03,
 * and the recorded finding is that the canopy's cost is DISCARD rather than
 * fill. Six of them leave together and they take with them:
 *
 *   SIX DRAW CALLS at every rung, which is what actually matters. Potato sits
 *   at 81 draws at the deep station and 123 in the clearing, and the recorded
 *   measurement is that on a main thread throttled 8x, fourteen draw calls is
 *   the difference between a 33.3 ms frame and a 16.7 ms one. This land is six
 *   draws BELOW the rainforest rather than above it, which is the constraint
 *   this whole design was checked against: a new world must not add draw calls
 *   at potato.
 *
 *   SIX GEOMETRIES AND SIX MATERIALS never built, i.e. six canvases never drawn
 *   and their programs never compiled. `bromeliads` alone carries a 8192-entry
 *   slab at 623 KB.
 *
 *   SIX PLACEMENT RULES never written. That is the inverted cost curve this
 *   land was chosen for.
 *
 * NOTHING HAD TO BE TOLD. `forest.js` filters its registry through this set and
 * `underLayer` bails when `bounds[id]` is missing, so a dropped layer's rule
 * simply never runs.
 *
 * `rocks` IS A FAMILY KEY: `forest.js` builds `rocks:0..N` from one entry, so
 * the set names the family and the ids follow.
 */
const LAYERS = new Set([
  'grass',
  'grass-b',
  'rocks',
  'logs',
  'shroom-stem',
  'shroom-cap',
  'meadow',
  'bushes',
  'saplings',
  'sticks',
  'litter',
  'reeds',
  'stumps',
]);

/**
 * The sward's two silhouettes, unchanged in identity and completely changed in
 * meaning: the blade fan is a tussock of dead sedge and the broadleaf rosette is
 * a low evergreen shrub — Vaccinium, Ledum — poking through the snow. Both are
 * things that stand up through a winter floor, which is the only requirement.
 */
const SWARD_FORMS = ['grass', 'grass-b'];

/**
 * The two ends of the sward, in LINEAR light. Straw and dark evergreen.
 *
 * Linear and not hex, for the reason the rainforest's pair gives: an
 * instanceColor is multiplied into diffuseColor with no conversion, so writing
 * these as hex would put two of the three factors in sRGB and one in linear.
 *
 * MUCH DARKER AND MUCH LESS GREEN THAN THE RAINFOREST'S. Rec.709 luma 0.2114
 * (dry straw) and 0.1174 (wet evergreen) against that land's 0.2762 and 0.4839,
 * i.e. the whole layer comes down by more than a stop — and the ratio between
 * the two ends INVERTS, because in this land the dry end is the bright one.
 * A winter floor's grass is bleached, and a Ledum shrub is nearly black; the
 * bright thing down there is the snow, and if the vegetation competes with it
 * the snow stops reading as snow.
 */
const SWARD_DRY = [0.28, 0.23, 0.11];
const SWARD_WET = [0.08, 0.15, 0.09];

/* ========================================================================== */
/* the coarse half of a sector                                                */
/* ========================================================================== */

/**
 * SWARD, STONES, DEADFALL, FUNGI — four blocks where the rainforest has five.
 *
 * The ferns are gone. Everything else keeps the rainforest's structure because
 * the structure is genuinely shared; what moves is the density, the tint, and
 * in the stones' case which ground they want.
 *
 * THE ORDER IS FROZEN FOR THIS LAND. The sector comes off one seeded stream, so
 * a block moved or inserted re-rolls every draw after it. It differs from the
 * rainforest's order (there is no fern block), which is fine and expected — a
 * different land is a different world and owes nothing to that one — but within
 * this land it may not move.
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

  // ---- the sward ----------------------------------------------------------
  /**
   * A WINTER FLOOR IS MOSTLY NOT VEGETATION, AND THIS IS WHERE THAT IS PAID
   * FOR.
   *
   * The sward is the most expensive layer in the world in either land —
   * `.perf/baseline.json` has it at 24 191 submitted instances against the
   * next-biggest layer's 7 188 — so it is also the largest single lever this
   * land has, and it is pulled hard:
   *
   *   `spacing` 0.82 -> 1.15 is 1.97x fewer candidates before any acceptance
   *   runs, i.e. a 49% cut applied uniformly and before anything else.
   *
   *   The acceptance reads `1 - needle` exactly as the rainforest reads
   *   `1 - litter`, and this land's `needle` weight is deliberately WIDER (see
   *   `character`), so the closed stand goes properly bald over more ground.
   *
   *   And a new `1 - exposure * 0.7` factor, which the rainforest has no
   *   equivalent of: scoured ground is not merely un-vegetated, it is scoured,
   *   and the lichen mats in the `litter` layer are what belongs there instead.
   *
   * Together that is somewhere around a third of the rainforest's instance
   * count on the same ground. The ground it leaves behind is not blank — it is
   * snow, sticks and lichen, which are respectively free, opaque and flat.
   */
  {
    /**
     * 1.15 -> 1.40, A SECOND CUT, AND IT WAS MEASURED RATHER THAN ARGUED.
     *
     * The paragraph above is right about why the sward is the lever and wrong
     * about how far to pull it. `scripts/_snow-probe.mjs` reports the mean hue
     * of the ground band of the frame, and standing under the trees at noon it
     * came out at 70-93 degrees — yellow-green, on snow. The ground's own
     * vertex albedo was checked directly and is neutral to three decimal places
     * (0.457 0.454 0.454), so none of that colour is the floor: it is twenty
     * thousand small green-brown cards standing ON the floor.
     *
     * That is a quarter of a million square metres carrying 0.20 tufts per
     * square metre, and a winter clearing does not have one every two metres —
     * it has bare drifts with tussocks at the edges of them. 1.40 is another
     * 1.48x cut, taking this land to about a fifth of the rainforest's sward
     * density, and it is the cheapest of the three levers here: fewer
     * alpha-tested cards is also the most expensive shape in the frame going
     * away, in the one land that can spare it.
     */
    const spacing = 1.4;
    const steps = Math.round(size / spacing);
    const swardIds = SWARD_FORMS.filter((id) => bounds[id]);
    if (swardIds.length) {
      const swardLayers = swardIds.map((id) => layer(id));
      const swardBounds = swardIds.map((id) => bounds[id]);
      for (let j = 0; j < steps; j++) {
        for (let i = 0; i < steps; i++) {
          const x = ox + (i + rng()) * spacing;
          const z = oz + (j + rng()) * spacing;
          if (slopeAt(x, z) > 0.44) continue;
          if (submerged(x, z)) continue;
          const patch = fbm2(x * 0.055 + 3, z * 0.055 + 12, 2) * 0.5 + 0.58;
          const c = character(x, z);
          if (rng() > patch * (1 - c.needle) * (1 - c.exposure * 0.7) * trodden(x, z)) continue;
          if (caveClearance(x, z) > 0.35) continue;
          const y = heightAt(x, z);
          /**
           * Three draws spent on (size, posture, cross-section), the same
           * arrangement the rainforest's sward argues for and for the same
           * reason: three independent uniforms centre hard and produce one
           * object at one size.
           *
           * SHORTER AND BROADER than the rainforest's. A tussock is a low wide
           * thing and a winter one is flattened by the snow that has been
           * sitting on it, so the height multiplier runs 0.48-1.10 against the
           * rainforest's 0.62-1.42 while the width runs wider.
           */
          const size = rngRange(rng, 0.72, 1.22);
          const form = rng();
          const skew = rngRange(rng, 0.82, 1.22);
          const gy = size * (0.48 + form * 0.62);
          const wide = size * (1.38 - form * 0.4);
          const gx = wide * skew;
          const gz = wide / skew;
          /**
           * Every tuft leans its own way, from `latticeHash` and NOT from
           * `rng()`, so the seeded stream does not move by a draw. UP TO 26°
           * here against the rainforest's 19.5°: snow load pushes a tussock
           * over further than rain does, and a field of them all leaning
           * differently is most of what stops a repeated card reading as one.
           *
           * `tiltMatrix`, so both sward meshes must keep `instanceBound(geo,
           * true)` in forest.js — a yaw-only bound is hung at the geometry's
           * centre height and a tilted instance walks straight out of it. The
           * symptom is a `cull-check` pixel diff nobody can attribute.
           */
          const cell = latticeHash(sx * steps + i, sz * steps + j);
          const pitch = (latticeHash(sx * steps + i + 7919, sz * steps + j) - 0.5) * 0.45;
          const roll = (latticeHash(sx * steps + i, sz * steps + j + 104729) - 0.5) * 0.45;
          tiltMatrix(_mat, x, y - 0.05, z, pitch, rng() * TAU, roll, gx, gy, gz);
          /**
           * The colour comes out of a FIELD, not out of a die, for the reason
           * the rainforest's block gives at length: independent per-tuft draws
           * have no spatial extent, so the layer averages to one colour at any
           * distance past a few metres and the one thing a real sward has —
           * patches — is exactly what is missing.
           *
           * Here the field is the damp one and the two ends are straw and
           * evergreen, so a drained rise is bleached sedge and a bog margin is
           * dark Ledum. EXACTLY THREE rng DRAWS, as in the other land: this
           * generator is shared by every layer in the sector and consumed in
           * order.
           */
          const patchy = clamp01(fbm2(x * 0.028 + 61.3, z * 0.028 + 17.7, 2) * 1.5 + 0.5);
          const wet = clamp01(patchy * 0.72 + c.damp * 0.5 + rngRange(rng, -0.12, 0.12));
          const lift = rngRange(rng, 0.84, 1.18);
          const warm = rngRange(rng, -0.025, 0.025);
          _col[0] = (SWARD_DRY[0] + (SWARD_WET[0] - SWARD_DRY[0]) * wet + warm) * lift;
          _col[1] = (SWARD_DRY[1] + (SWARD_WET[1] - SWARD_DRY[1]) * wet) * lift;
          _col[2] = (SWARD_DRY[2] + (SWARD_WET[2] - SWARD_DRY[2]) * wet - warm) * lift;
          // The evergreen rosette wins on the damp end; the dead tussock on the
          // dry. `cell` decides the individual, independently between
          // neighbours, because a patch of one shape is the problem this fixes
          // one order of magnitude larger.
          const k = cell < 0.28 + wet * 0.4 ? swardIds.length - 1 : 0;
          const bound = swardBounds[k];
          const grow = Math.max(gx, gy, gz);
          push(swardLayers[k], _mat, _col, x, y - 0.05 + bound.cy * grow, z, bound.r * grow);
        }
      }
    }
  }

  // ---- stones -------------------------------------------------------------
  /**
   * MORE OF THEM, AND ON DIFFERENT GROUND.
   *
   * The rainforest's rule is `0.1 + slope*0.85 + wet*0.45` — stones on banks and
   * in the stream, which is where erosion exposes them under a deep soil. A
   * glaciated landscape has erratics and frost-heaved boulders lying on the
   * FLAT, which is why the constant floor goes 0.1 -> 0.22 and the exposure
   * weight is added: scoured open ground is where the rock actually shows.
   *
   * They are the cheapest thing this land can put on an empty floor — opaque,
   * depth-writing, shadow-casting, and already built at four size classes — so
   * they are part of how the six dropped card layers are paid back visually
   * without being paid for in fill.
   */
  {
    for (let gi = 0; gi < rockSizes; gi++) {
      const spacing = 8 + gi * 4.5;
      const steps = Math.round(size / spacing);
      const id = `rocks:${gi}`;
      const bound = bounds[id];
      if (!bound) continue;
      const l = layer(id);
      for (let j = 0; j < steps; j++) {
        for (let i = 0; i < steps; i++) {
          const x = ox + (i + rng()) * spacing;
          const z = oz + (j + rng()) * spacing;
          const slope = slopeAt(x, z);
          const wet = wetness(x, z);
          const c = character(x, z);
          if (rng() > 0.22 + slope * 0.8 + wet * 0.35 + c.exposure * 0.5) continue;
          const y = heightAt(x, z);
          const grow = rngRange(rng, 0.6, 1.6);
          tiltMatrix(
            _mat,
            x,
            y - 0.24 - gi * 0.1,
            z,
            rngRange(rng, -0.34, 0.34),
            rng() * TAU,
            rngRange(rng, -0.34, 0.34),
            grow,
            grow,
            grow
          );
          // Colder and less saturated than the rainforest's warm-grey stone, and
          // brighter at the top of the range: a boulder with snow caught on its
          // upper face is a pale object, and it is one of the few pale objects
          // this floor has that is not the ground itself.
          _tint.setHSL(0.58, rngRange(rng, 0.01, 0.06), rngRange(rng, 0.46, 0.76));
          _col[0] = _tint.r;
          _col[1] = _tint.g;
          _col[2] = _tint.b;
          push(l, _mat, _col, x, y - 0.24 - gi * 0.1 + bound.cy * grow, z, bound.r * grow);
          if (gi === rockSizes - 1) collide.push(x, z, 1.5);
        }
      }
    }
  }

  // ---- fallen wood --------------------------------------------------------
  /**
   * TWICE AS MUCH DEADFALL, AND IT IS THE LAND'S CHEAPEST CHARACTER.
   *
   * Decomposition is slow where it is frozen eight months a year, so a boreal
   * floor genuinely is a tangle of fallen trunks in a way a tropical one is not
   * — a rainforest log is gone in a season. `spacing` 16 -> 11 is roughly
   * double the count.
   *
   * IT COSTS ALMOST NOTHING AND IT BUYS THE THING THAT MATTERS. A log is opaque,
   * writes depth, casts a shadow and lies in the 0.3-1 m band; the recorded
   * finding is that the forest occludes itself and that what stops a sightline
   * is the nearest thing crossing it. Six dropped card layers took a lot of
   * near-field cover away with them, and this is the arm that puts it back at
   * a tenth of the fill cost — the same argument the sticks layer makes about
   * being sixteen opaque triangles lying flat.
   *
   * `capacity` in forest.js is 512 against a ceiling of `40 960 / 11² × 0.75 =
   * 254`, so the doubling still fits with a wide margin and no `bufferData`
   * growth event.
   */
  {
    const spacing = 11;
    const steps = Math.round(size / spacing);
    const bound = bounds.logs;
    if (bound) {
      const l = layer('logs');
      for (let j = 0; j < steps; j++) {
        for (let i = 0; i < steps; i++) {
          const x = ox + (i + rng()) * spacing;
          const z = oz + (j + rng()) * spacing;
          if (slopeAt(x, z) > 0.34) continue;
          if (submerged(x, z)) continue;
          if (rng() > forestDensity(x, z) * 0.72 + 0.06) continue;
          const y = heightAt(x, z);
          const gx = rngRange(rng, 0.7, 1.4);
          const gy = rngRange(rng, 0.8, 1.2);
          const gz = rngRange(rng, 0.8, 1.2);
          tiltMatrix(
            _mat,
            x,
            y + 0.26,
            z,
            rngRange(rng, -0.16, 0.16),
            rng() * TAU,
            rngRange(rng, -0.1, 0.1),
            gx,
            gy,
            gz
          );
          // Grey and silvered rather than the rainforest's warm rot. A dead
          // conifer bleaches; it does not blacken.
          _tint.setHSL(0.09, rngRange(rng, 0.03, 0.13), rngRange(rng, 0.3, 0.52));
          _col[0] = _tint.r;
          _col[1] = _tint.g;
          _col[2] = _tint.b;
          const grow = Math.max(gx, gy, gz);
          push(l, _mat, _col, x, y + 0.26 + bound.cy * grow, z, bound.r * grow);
          collide.push(x, z, 1.1);
        }
      }
    }
  }

  // ---- fungi --------------------------------------------------------------
  /**
   * A reason to keep walking, and it survives the change of latitude intact.
   *
   * The density is the rainforest's exactly — one patch per 2720 m², i.e. a 32 m
   * sector wants one 38% of the time — because that number was arrived at by
   * counting what made a thing FINDABLE rather than by anything about the
   * biome, and getting it wrong in the generous direction produces a mushroom
   * every twenty metres, which is a thing you trip over on the way somewhere
   * else rather than a thing you find.
   *
   * `glow` is unchanged too. The bioluminescence is a game object, not a
   * mycological claim, and it is the only thing in this world that rewards
   * walking out into the dark — which in a land with a four-hour winter day is
   * worth more here than it was there.
   */
  {
    const stems = layer('shroom-stem');
    const caps = layer('shroom-cap');
    const stemBound = bounds['shroom-stem'];
    const capBound = bounds['shroom-cap'];
    if (stemBound && capBound) {
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
          // Cold blues and greens rather than the rainforest's magenta band. It
          // is the same card and the same draw call; only the die moved.
          _tint.setHSL(rngRange(rng, 0.45, 0.62), rngRange(rng, 0.34, 0.66), rngRange(rng, 0.36, 0.6));
          _col[0] = _tint.r;
          _col[1] = _tint.g;
          _col[2] = _tint.b;
          push(caps, _mat, _col, x, y - 0.03 + capBound.cy * grow, z, capBound.r * grow);
          glow.push(x, y + 0.24, z);
        }
      }
    }
  }
}

/* ========================================================================== */
/* the understorey table                                                      */
/* ========================================================================== */

/**
 * SEVEN LAYERS WHERE THE RAINFOREST HAS TWELVE.
 *
 * The order is frozen for this land. The two that carry the most weight here
 * are `sticks` and `litter`, which in the rainforest are marked `clutter: true`
 * and dropped entirely at the potato rung — that is a judgement about the
 * rainforest ("would the wood be a different place without it?") and it goes
 * the other way here. On a winter floor the deadfall and the lichen crusts ARE
 * the floor; the cards that were the rainforest's character do not exist. The
 * `clutter` flags are set in forest.js and the exact change is in the report.
 */
const UNDERSTOREY = [
  /**
   * TUSSOCK SEDGE — the `meadow` geometry, standing through the snow.
   *
   * ==== AND IT WAS A HELICONIA. THE ONE TROPICAL OBJECT LEFT IN THE SNOW ====
   *
   * The photographed complaint was "large bright-green fronds standing in the
   * snow at a ridge station". This is them, and the tint below is not what was
   * wrong with them: `meadowGeo` is a 1.95 m x 0.66 m four-card clump and its
   * texture in forest.js is `heliconiaTexture` — an actual tropical broadleaf,
   * drawn green in its own canvas.
   *
   * THIS FILE'S `cards` BLOCK ALREADY STATES WHY NO TINT CAN FIX THAT: a card's
   * screen colour is texture x material x per-instance tint, and both of the
   * factors this land controls are RATIOS over a texture whose hue is baked in.
   * A green base cannot reach straw at any ratio; asking for it just makes the
   * layer dark green. That is the trap, verbatim, and the previous pass fell
   * into it — it moved the material to 0xa9976c and stopped, which took the
   * luma down and left the hue exactly where it was.
   *
   * So the fix is the TEXTURE, and it is the one thing here that lives in a
   * file this pass does not own. `cardTex` on the land record (see the export
   * at the bottom) asks forest.js for `herbTuft` — the same near-neutral blade
   * canvas the sward already uses, at a straw hue — instead of the heliconia.
   * It is a leaf module's worth of change in forest.js, adds no texture family
   * and no draw call, and it is absent from the rainforest, so that land runs
   * the identical expression it always ran.
   *
   * IF THAT PATCH IS NOT APPLIED, THE ONE-LINE FALLBACK IS TO DELETE `'meadow'`
   * FROM `LAYERS` above. Purely subtractive, which is this file's stated
   * principle, and it costs the open ground its only tall element — the young
   * spruce in the `saplings` layer would then be carrying `drift` alone.
   *
   * Keyed to `drift`, which is the same slot `meadow` was keyed to. The height
   * term is much shorter: 0.38 + drift·0.34 against the rainforest's
   * 0.62 + meadow·0.46, so the deepest tussock in this world is about 1.5 m
   * against that one's 2.4. Chest-high hay is a summer object; what stands
   * through a boreal winter is knee-to-waist and mostly flattened.
   */
  {
    id: 'meadow',
    /**
     * 1.7 -> 2.5. Same cut, same reason, and this layer had the worst of it:
     * the clump geometry is 1.95 m x 0.66 m of four cards, so one of these
     * covers as much ground as a dozen tufts and there were two thousand of
     * them in a 320 m square. `cardTex` now hands it the sward's blade canvas
     * instead of a heliconia, which fixes the hue; the count is what fixes the
     * amount.
     */
    spacing: 2.5,
    make: ({ rng, character, trodden, submerged, slopeAt, heightAt, yawMatrix, push, _mat, _col, _tint, fbm2 }) =>
      (x, z, l, bound, p) => {
        if (slopeAt(x, z) > 0.4) return;
        const c = character(x, z);
        if (c.drift < 0.08) return;
        const m = c.drift;
        // A 12 m gathering field, so the sedge is drifts with worn ground between
        // them rather than an even sprinkle. Wider and harsher than the
        // rainforest's: a sedge flat has hard edges where the drainage changes.
        const drift = clamp01((fbm2(x * 0.078 + 17, z * 0.078 - 41, 2) * 0.5 + 0.5) * 2.6 - 0.78);
        if (rng() > clamp01(m * 3.0 - 0.28) * drift * trodden(x, z) * p) return;
        if (submerged(x, z)) return;
        const y = heightAt(x, z);
        const gx = rngRange(rng, 0.85, 1.35);
        const gz = rngRange(rng, 0.85, 1.35);
        const tall = (0.38 + m * 0.34) * rngRange(rng, 0.84, 1.16);
        yawMatrix(_mat, x, y - 0.05, z, rng() * TAU, gx, tall, gz);
        /**
         * BLEACHED STRAW, 42°, and it is the warmest thing in this land.
         *
         * `setHSL` with no colour-space argument writes LINEAR values (see the
         * rainforest's meadow block and avatar.js:392), so these are reflectance
         * multipliers. 0.26-0.50 is a fifth of a stop under the rainforest's
         * 0.30-0.58 — this floor is darker than that one even before the snow
         * takes the light off it — and the saturation is halved, because dead
         * sedge is a grey-gold and not a gold.
         */
        _tint.setHSL(
          0.117 + rngRange(rng, -0.02, 0.035),
          rngRange(rng, 0.12, 0.28),
          rngRange(rng, 0.26, 0.5)
        );
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        const grow = Math.max(gx, tall, gz);
        push(l, _mat, _col, x, y - 0.05 + bound.cy * grow, z, bound.r * grow);
      },
  },

  /**
   * DWARF BIRCH AND WILLOW SCRUB — the `bushes` geometry.
   *
   * Held near the rainforest's count on purpose, and this is the one place in
   * this file where a cut would have been a mistake. The recorded finding is
   * that this forest occludes itself and that the mid-storey is what stops a
   * long sightline; six card layers have already gone, so the two remaining
   * SHAPE layers — this and the saplings — are carrying the whole near-field
   * occlusion budget. `spacing` 5.4 -> 4.9 is a small INCREASE.
   */
  {
    id: 'bushes',
    /**
     * 4.9 -> 6.8, for the reason the sward's second cut records.
     *
     * The tint below is right — dwarf birch in winter IS a mass of brown twigs
     * and the hue is set to 22 degrees to say so — but a tint is a MULTIPLIER
     * over a texture whose base is a green leaf, and this land's own `cards`
     * block states the consequence in as many words: a green base cannot reach
     * straw at any ratio. So each of these reads as an olive-green shrub rather
     * than a brown one, and against snow an olive-green shrub is the loudest
     * object in the frame.
     *
     * The honest fix is a second texture and it is not free; the affordable one
     * is fewer of them. A boreal understorey is genuinely sparse, so this is
     * not a compromise dressed as ecology — it is what the ecology says anyway.
     */
    spacing: 6.8,
    make: ({ rng, character, trodden, submerged, slopeAt, heightAt, yawMatrix, push, rustle, bushCue, _mat, _col, _tint }) =>
      (x, z, l, bound, p) => {
        if (slopeAt(x, z) > 0.44) return;
        const c = character(x, z);
        /**
         * Reads `scrub` for the edge and `thicket` for the shade, which is the
         * same pairing the rainforest's bushes read and for the same reason: a
         * rule that hand-rolls its own canopy band instead of reading a weight
         * is a biome that has quietly forked. The `1 - needle * 0.85` exclusion
         * is here for the reason the rainforest's `1 - litter * 0.9` is: the
         * `scrub` half carries no duff exclusion of its own.
         *
         * The 0.16 floor is a promise that a shrub can turn up anywhere, which
         * is why `trodden` is needed at all — a gathering place is the one kind
         * of "everywhere" that has to be an exception.
         */
        const want = (1 - c.needle * 0.85) * (0.16 + c.scrub * 1.15 + c.thicket * 1.1);
        if (rng() > want * trodden(x, z) * p) return;
        if (submerged(x, z)) return;
        const y = heightAt(x, z);
        // One size with a small wobble per axis, never three independent ranges:
        // three independent draws can produce a shrub 1.5 wide and 0.7 high,
        // which is a flat rosette. `gx` is what `bushCue` sees.
        const g = rngRange(rng, 0.58, 1.42);
        const gx = g * rngRange(rng, 0.92, 1.16);
        const gy = g * rngRange(rng, 0.78, 1.04);
        const gz = g * rngRange(rng, 0.92, 1.16);
        yawMatrix(_mat, x, y - 0.05, z, rng() * TAU, gx, gy, gz);
        /**
         * A BROWN SHRUB, WHICH IS THE POINT.
         *
         * Dwarf birch in winter is a mass of bare purple-brown twigs, not a
         * green bush, and it is the only layer in this land that is allowed a
         * warm dark. Hue 0.06 (22°) at low saturation with the lightness held
         * down: against the snow behind it this reads as a dense dark mass,
         * which is exactly the silhouette a scrub thicket should have.
         */
        _tint.setHSL(
          0.06 + rngRange(rng, -0.025, 0.04),
          rngRange(rng, 0.12, 0.3),
          rngRange(rng, 0.24, 0.46)
        );
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        const grow = Math.max(gx, gy, gz);
        push(l, _mat, _col, x, y - 0.05 + bound.cy * grow, z, bound.r * grow);
        const cue = bushCue(gx);
        if (cue) rustle.push(x, z, cue);
      },
  },

  /**
   * YOUNG SPRUCE — the `saplings` geometry, and the other half of the near-field
   * occlusion budget.
   *
   * Keyed to `thicket` and `drift` where the rainforest keys to `understorey`
   * and `meadow`: a spruce seedling comes up in the shade of its parent and in
   * an opening alike, which is the same two places for the same two reasons.
   * Denser than the rainforest's, 7.2 -> 5.8, because a regenerating spruce
   * stand is genuinely a thicket of them and because it is one of only two
   * layers left that stop a ray.
   */
  {
    id: 'saplings',
    spacing: 5.8,
    make: ({ rng, character, trodden, submerged, slopeAt, heightAt, yawMatrix, push, _mat, _col, _tint }) =>
      (x, z, l, bound, p) => {
        if (slopeAt(x, z) > 0.42) return;
        const c = character(x, z);
        if (rng() > (1 - c.needle * 0.7) * (0.12 + c.thicket * 1.15 + c.drift * 0.45) * trodden(x, z) * p)
          return;
        if (submerged(x, z)) return;
        const y = heightAt(x, z);
        const g = rngRange(rng, 0.5, 1.3);
        const gy = g * rngRange(rng, 1.0, 1.55);
        yawMatrix(_mat, x, y - 0.05, z, rng() * TAU, g, gy, g);
        /**
         * A SPIRE, NOT A BALL, and that is the `gy` range above rather than
         * anything here: 1.0-1.55 against the rainforest's 0.85-1.30 stretches
         * the same card vertically, which is free and is most of what makes a
         * young conifer read as a young conifer.
         *
         * 158° and very dark. Spruce foliage is close to the coldest, darkest
         * green there is, and in this land it is the darkest thing in the frame
         * — the whole value structure here is dark trees against pale ground,
         * where the rainforest is the reverse.
         */
        _tint.setHSL(
          0.44 + rngRange(rng, -0.03, 0.025),
          rngRange(rng, 0.26, 0.46),
          rngRange(rng, 0.16, 0.32)
        );
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        const grow = Math.max(g, gy);
        push(l, _mat, _col, x, y - 0.05 + bound.cy * grow, z, bound.r * grow);
      },
  },

  /**
   * DEADFALL TWIGS — and in this land it is the BIGGEST layer on the floor
   * rather than an afterthought.
   *
   * The rainforest marks this `clutter: true` and drops it at potato, on the
   * test "would the wood be a different place without it?". In a rainforest the
   * answer is no; here it is yes, and that is not sentiment. Six card layers
   * are gone, so a stick is one of three things left between the snow and the
   * canopy, and it is by far the cheapest of the three: sixteen OPAQUE triangles
   * that write depth, lying flat, costing almost nothing in the 0.3-2 m band and
   * opening no sightline.
   *
   * `spacing` 3.0 -> 2.4 is 1.56x the candidates, and the acceptance is keyed to
   * `needle` and `exposure` — the two weights that describe empty ground — so
   * the layer is densest exactly where everything else has gone. That inversion
   * is the whole design: this land fills its bald floor with the cheapest thing
   * it owns instead of leaving it blank or putting cards on it.
   */
  {
    id: 'sticks',
    spacing: 2.4,
    make: ({ rng, character, submerged, slopeAt, heightAt, tiltMatrix, push, _mat, _col, _tint }) =>
      (x, z, l, bound, p) => {
        if (slopeAt(x, z) > 0.5) return;
        const c = character(x, z);
        if (rng() > (0.14 + c.needle * 0.7 + c.exposure * 0.3 + c.canopy * 0.26) * p) return;
        if (submerged(x, z)) return;
        const y = heightAt(x, z);
        // One geometry, length varied by the instance. Longer at the top than the
        // rainforest's 1.8: a fallen spruce branch is a big object and this layer
        // is doing the mid-storey's job now.
        const long = rngRange(rng, 0.4, 2.1);
        const thickY = rngRange(rng, 0.7, 1.4);
        const thickZ = rngRange(rng, 0.7, 1.4);
        tiltMatrix(
          _mat,
          x,
          y + 0.03,
          z,
          rngRange(rng, -0.16, 0.16),
          rng() * TAU,
          rngRange(rng, -0.12, 0.12),
          long,
          thickY,
          thickZ
        );
        // Silvered and cold. A weathered conifer stick is grey, and the range is
        // wide because this layer's whole job is texture on empty ground —
        // uniform value is what makes a field of anything read as a pattern.
        _tint.setHSL(
          0.09 + rngRange(rng, -0.03, 0.02),
          rngRange(rng, 0.02, 0.12),
          rngRange(rng, 0.26, 0.66)
        );
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        const grow = Math.max(long, thickY, thickZ);
        push(l, _mat, _col, x, y + 0.03 + bound.cy * grow, z, bound.r * grow);
      },
  },

  /**
   * NEEDLE DUFF AND LICHEN CRUSTS — the `litter` geometry, and the layer that
   * carries this land's most distinctive floor.
   *
   * The rainforest's version is one card with two tints, moss on the wet and
   * dead leaves elsewhere. Here it is one card with two tints for a different
   * reason: `exposure` high is a PALE grey-green Cladonia mat, which is a thing
   * with no rainforest equivalent at all, and everything else is dark rust duff.
   *
   * The pale variant is the only bright vegetation in this land and it belongs
   * on precisely the ground the snow has been blown off. Getting that pairing
   * right — pale lichen where the snow is thin, because both are decided by
   * exposure — is what makes the open ground read as one place rather than as
   * two unrelated fields overlaid.
   */
  {
    id: 'litter',
    spacing: 2.8,
    make: ({ rng, character, submerged, slopeAt, heightAt, tiltMatrix, push, _mat, _col, _tint }) =>
      (x, z, l, bound, p) => {
        if (slopeAt(x, z) > 0.42) return;
        const c = character(x, z);
        if (rng() > (c.needle * 0.62 + c.exposure * 0.55 + c.damp * 0.4 + c.canopy * 0.12) * p) return;
        if (submerged(x, z)) return;
        const y = heightAt(x, z);
        // `mx`/`mz`, not `sx`/`sz`: those are the sector coordinates.
        const mx = rngRange(rng, 0.8, 1.9);
        const my = rngRange(rng, 0.6, 1.2);
        const mz = rngRange(rng, 0.8, 1.9);
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
        if (c.exposure > 0.34) {
          /**
           * CLADONIA. Very pale, almost no saturation, faintly green — and it is
           * the one place in this land a bright linear value is spent on
           * vegetation. 0.52-0.80 is brighter than anything on the rainforest
           * floor except the bromeliads on their banks, and it is defensible for
           * exactly the reason theirs is not: this stuff is genuinely near-white
           * and it grows in the open, standing in whatever light there is,
           * rather than on a floor receiving 1-2% of the roof's.
           */
          _tint.setHSL(
            0.22 + rngRange(rng, -0.05, 0.05),
            rngRange(rng, 0.03, 0.11),
            rngRange(rng, 0.52, 0.8)
          );
        } else {
          // Needle duff: dark, rust-red, and the darkest card in this land.
          _tint.setHSL(
            0.045 + rngRange(rng, -0.015, 0.025),
            rngRange(rng, 0.22, 0.44),
            rngRange(rng, 0.16, 0.34)
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
   * endless world. Testing wetness before anything else is a real saving:
   * `wetness` is two sines where `heightAt` is a dozen octaves of noise.
   *
   * Thinner and shorter than the rainforest's — the band is narrower and the
   * height term lower — because what stands at a frozen waterline is last
   * year's dead reed, broken off.
   */
  {
    id: 'reeds',
    spacing: 1.6,
    make: ({ rng, wetness, heightAt, yawMatrix, push, WATER_LEVEL, _mat, _col, _tint }) =>
      (x, z, l, bound, p) => {
        const wet = wetness(x, z);
        if (wet < 0.42) return;
        const y = heightAt(x, z);
        if (y < WATER_LEVEL - 0.5 || y > WATER_LEVEL + 1.4) return;
        const band = 1 - clamp01(Math.abs(y - WATER_LEVEL - 0.3) / 1.3);
        if (rng() > band * (0.26 + wet * 0.6) * p) return;
        const g = rngRange(rng, 0.62, 1.2);
        const gy = (0.5 + band * 0.42) * rngRange(rng, 0.82, 1.22);
        yawMatrix(_mat, x, y - 0.06, z, rng() * TAU, g, gy, g);
        // Straw, the same warm end the sedge takes, a little paler because a
        // reed bed in winter catches what light there is off the water.
        _tint.setHSL(
          0.115 + rngRange(rng, -0.02, 0.04),
          rngRange(rng, 0.1, 0.26),
          rngRange(rng, 0.3, 0.56)
        );
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        const grow = Math.max(g, gy);
        push(l, _mat, _col, x, y - 0.06 + bound.cy * grow, z, bound.r * grow);
      },
  },

  /**
   * Stumps, and the 0.82 m collider floor `stumpCollider` enforces is a contract
   * with fauna.js in every land: that file identifies trees inside
   * `colliderGrid` by radius and "anything under 0.8 is a tree and nothing else
   * can be". A stump indexed as a tree is a bird singing eight metres above a
   * knee-high stump, which is the kind of thing that gets noticed in a
   * screenshot six weeks later and attributed to the birds.
   */
  {
    id: 'stumps',
    spacing: 17,
    make: ({ rng, submerged, slopeAt, heightAt, forestDensity, tiltMatrix, push, collide, stumpCollider, _mat, _col, _tint }) =>
      (x, z, l, bound, p) => {
        if (slopeAt(x, z) > 0.32) return;
        if (submerged(x, z)) return;
        if (rng() > (forestDensity(x, z) * 0.6 + 0.08) * p) return;
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
        _tint.setHSL(0.09, rngRange(rng, 0.04, 0.14), rngRange(rng, 0.26, 0.46));
        _col[0] = _tint.r;
        _col[1] = _tint.g;
        _col[2] = _tint.b;
        const grow = Math.max(g, gy);
        push(l, _mat, _col, x, y - 0.12 + bound.cy * grow, z, bound.r * grow);
        collide.push(x, z, stumpCollider(g));
      },
  },
];

/* ========================================================================== */

export const TAIGA = {
  id: 'taiga',
  label: 'Winter wood',
  blurb: 'Spruce and birch under snow. Dark trees, pale ground, and a fire worth standing at.',
  roster: ROSTER,
  /**
   * THE EMERGENT — the species `treeSector` may promote to 2.2-2.8x as a
   * landmark. See the same key in rainforest.js and the giant block in
   * `treeSector`.
   *
   * The widest bole of the five, at `trunkRadius: 0.22` against fir 0.21,
   * larch 0.2, birch 0.19 and juniper 0.16 — and the margin is thin because
   * trees.js deliberately keeps this land's boles within a hair of each other.
   * Which is exactly why the promotion earns its place here: with every trunk
   * the same width, a stand of spruce has nothing in it a person can point at.
   */
  giant: 'spruce',
  speciesAt,
  treeScale: TREE_SCALE,
  density: DENSITY,
  weights: WEIGHTS,
  makeCharacter,
  ground: GROUND,
  layers: LAYERS,
  /**
   * ONLY THE REEDS. `sticks` and `litter` are marked clutter in the rainforest
   * and are NOT here, because on this floor they are not texture — they are the
   * floor. The full argument is at the `clutter` line in forest.js; the short
   * version is that this land has six fewer card layers to begin with, so it
   * can afford to keep two and still draw fewer than the rainforest at potato.
   */
  clutter: new Set(['reeds']),
  makeCoarse,
  understorey: UNDERSTOREY,
  /**
   * THE THREE CARD TINTS THAT WERE STILL RAINFOREST, AND WHY THEY GO DARKER.
   *
   * See the block at `cardTint` in forest.js for the mechanism: a card layer's
   * colour is texture x material x per-instance tint, and the scatter's tint is
   * a RATIO over the material, so a green base cannot reach brown at any ratio.
   * These three layers were sharing the rainforest's constants, and measured on
   * this land the bush came out sRGB (184, 205, 145) and the sapling
   * (115, 205, 141): emerald, in snow.
   *
   * The rainforest's luma rule — move hue, hold Rec.709 luma within 2.5% —
   * exists because on a dark forest floor "greener" done by eye means darker,
   * and darker there reads as a hole rather than as lush. Against SNOW that
   * reasoning runs the other way: the snow is the bright thing, and what makes a
   * dwarf shrub legible is being DARK against it. So these are deliberately well
   * below the luma they replace (197 -> 118, 197 -> 152, 184 -> 136 on the
   * Rec.709 measure), and the drop is the point.
   *
   * What each one is meant to be, since the geometry is shared and only the
   * colour can say it: `shrub` is Vaccinium and Ledum poking through the snow —
   * evergreen, almost black-green, with the bronze cast a boreal dwarf shrub
   * carries all winter. `meadow` is dead standing sedge, which is straw and has
   * no green in it at all. `reed` is the same sedge with more water and less
   * sun.
   */
  cards: {
    shrub: 0x6f7a5e,
    meadow: 0xa9976c,
    reed: 0x8d8a6a,
  },
  /**
   * WHICH CANVAS A CARD LAYER IS DRAWN ON, WHERE A TINT CANNOT REACH.
   *
   * `cards` above is the material colour and it is a RATIO over a texture whose
   * hue is baked into the canvas, so it can change a card's key and never its
   * hue. That is stated at length in `cards` and the previous pass still fell
   * into it: `meadow` is drawn with `heliconiaTexture`, an actual tropical
   * broadleaf, and no straw multiplier over a green canvas has ever produced
   * straw. The photographed symptom was bright green fronds standing in snow.
   *
   * `'tuft'` asks forest.js for `herbTuft` at a straw hue instead — the same
   * near-neutral blade canvas the sward already uses, so no new texture family,
   * no new material, no new draw call, and a `memo` key of its own.
   *
   * THE RAINFOREST HAS NO `cardTex` AT ALL, so `land.cardTex?.meadow` is
   * undefined there and that land runs the expression it has always run. This
   * is the same "absent means today's behaviour" discipline as `substitute`,
   * `clutter` and `sky`.
   *
   * Only `meadow` is listed because only `meadow` is wrong. `shrubTexture` and
   * `reedTexture` are generic enough that the tints in `cards` genuinely reach
   * where this land needs them — measured in that block, 197 -> 118 luma.
   */
  cardTex: { meadow: 'tuft' },
  /**
   * ==== WHICH ANIMALS LIVE HERE. A NAME FILTER AND NOTHING ELSE =============
   *
   * `fauna.js` hard-coded a Neotropical world and had never heard of the land
   * layer, so the winter wood came with capuchin monkeys in the spruces and
   * morpho butterflies over the snow.
   *
   * THE FIRST CUT IS PURELY SUBTRACTIVE, which is this file's stated principle
   * for its layer table and the reason a second land was affordable at all: a
   * `Set` of names, filtered against tables that stay where they are. A dropped
   * kind is a geometry never built, a material never compiled, an InstancedMesh
   * never made and a draw call never issued — the same shape of saving the six
   * dropped card layers give, and it needs nothing to be told.
   *
   * WHAT WENT AND WHY:
   *   `capuchin` — an arboreal Neotropical monkey. It is also the only species
   *   with a `climb` behaviour, gated on `herd.name === 'capuchin'` in the
   *   update loop, so dropping it leaves that branch unentered rather than
   *   broken.
   *   The five Neotropical flutters — morpho, owl (Caligo), postman and zebra
   *   (Heliconius) and julia (Dryas). None of them occurs north of the tropics
   *   at all.
   *
   * WHAT STAYED AND WHY IT IS HONEST:
   *   `tapir` — kept for its BODY, which is a large, dark, solitary,
   *   short-sighted browsing quadruped that lets you walk up on it. That is
   *   also a moose, and the winter coat below is what says so. Renaming the row
   *   would mean a second `BEASTS` entry, a second geometry family and a second
   *   draw call, which is the one thing this land is not allowed to spend.
   *   `agouti` — a hare-shaped ground rodent that bolts. Boreal woods are full
   *   of exactly that shape; it is a mountain hare here.
   *   `sulphur` — Colias. There are genuinely boreal bog sulphurs (C. palaeno),
   *   and this is the one you see most over any clearing in either land.
   *   `swallowtail` — Papilio machaon is circumboreal.
   *
   * The two butterflies keep the rainforest's exact numbers. They are shared
   * rows and a colour edit to either would move `grove-01`, which is not a
   * price a boreal reading is worth when the species are already plausible.
   */
  /**
   * WHERE TRACKS IN THE SNOW WOULD GO, WRITTEN DOWN AND NOT BUILT.
   *
   * This is the obvious next thing and it does not belong in a land record, so
   * the shape is recorded here once rather than rediscovered: a track is a
   * DECAL LAYER, not a fauna feature. `fauna.js` already has every animal's
   * world position every frame on the host; the ground already has a card layer
   * that lies flat, spins and is tinted per instance (`litter`); and the trip
   * law that a world-space field may not become a screen-space one is not in
   * the way, because a footprint is at a world coordinate by construction.
   *
   * The two things that make it hard are the two to think about first. It is
   * the only geometry in this project that would be WRITTEN BY A PLAYER rather
   * than derived from the seed, so it either travels on the wire or it is local
   * and two people see different snow — and the recorded finding is that
   * streamed sectors undo player edits, four steps, see that note. And it is
   * unbounded in time: a trail that never fades is a world that fills up, so it
   * needs a ring buffer with a fade, which is a per-instance age attribute and
   * one more float.
   */
  fauna: {
    kinds: new Set(['tapir', 'agouti']),
    flutter: new Set(['sulphur', 'swallowtail']),
    /**
     * ==== WHICH BIRDS SING HERE. EIGHT OF TWENTY, BY NAME =================
     *
     * The BODIES were made land-aware last wave and the VOICES were not, so a
     * winter wood came with a toucan croaking in the spruces and a quetzal
     * perched in one. `landVoiceIndices` in audio/wildlife.js does the
     * selection, and its own long block explains the one rule that matters: the
     * filter is BY NAME and it hands back indices into the FULL table, so index
     * 3 is the same species in every land and on every machine. This is the
     * winter wood saying which names it has, and nothing more.
     *
     * ONE LIST FOR BOTH LAYERS. `fauna.js` deals its perchers AND its wheeling
     * flocks out of the same indices, so a bird you can hear here is a bird you
     * can see here and the two cannot come apart. That is the whole reason this
     * is a filter over the existing roster rather than a second table of boreal
     * birds: a second table is one that goes stale the next time a row is added,
     * silently, with a hermit wearing a toucan.
     *
     * EIGHT, AND DELIBERATELY NOT PADDED TO TWENTY. Four good voices in a cold
     * wood is more convincing than twenty wrong ones, and a boreal forest
     * genuinely IS a quieter and less various place than a lowland rainforest —
     * that is most of what it sounds like. The names below are Neotropical
     * because the table is, and a name never reaches the player: what reaches
     * them is a sound and a shape, and each of these eight is a bird that
     * exists at 60 degrees north under another name.
     *
     *   `tinamou`     a big round tailless barred ground bird whistling in the
     *                 evening, active [0.28, 1]. That is a capercaillie or a
     *                 hazel grouse, and it is the closest fit in the table.
     *   `woodcreeper` brown, finely barred, clinging to a vertical trunk on a
     *                 stiff tail, thin descending call. That is a treecreeper,
     *                 Certhia familiaris, which is circumboreal.
     *   `musicianwren` twelve centimetres, rufous, barred, tail cocked, and a
     *                 long tumbling song out of all proportion to it. Winter
     *                 wren, also circumboreal, and famous for exactly that.
     *   `potoo`       bark-coloured, mottled, motionless on a broken stump, and
     *                 a mournful descending whistle after dark, active
     *                 [0.38, 1]. Every northern wood has that sound; here it is
     *                 a boreal owl.
     *   `solitaire`   slate grey with an orange bill, and the purest flute in
     *                 the file with enormous silences round it. A northern
     *                 thrush at dusk, and the one voice on this list somebody
     *                 will stop walking for.
     *   `antbird`     a small slate-grey bird with one white throat mark and a
     *                 thin high whistled series. A tit — willow, crested, coal —
     *                 which is the commonest shape in a spruce wood.
     *   `piha`        the table's own control: a featureless grey bird with a
     *                 paler front, and a scream that leaps an octave and falls
     *                 off a cliff. A Siberian jay, which is grey, unremarkable
     *                 and the loudest thing in a taiga.
     *   `antshrike`   fifteen nasal notes accelerating into a snarl, on a barred
     *                 black-and-white crested bird. A woodpecker's rattle, and
     *                 the only percussive voice this land keeps.
     *
     * WHAT WENT, IN ONE LINE: everything whose sound or whose colour IS the
     * tropics. The bellbird's hammered clang, the oropendola's liquid gurgle,
     * the toucan's and aracari's croaks, the trogon's and motmot's slow hoots,
     * and the five small brilliant ones — quetzal, manakin, tanager,
     * honeycreeper and hermit — which are green, gold, turquoise, violet and a
     * hummingbird respectively. The kiskadee goes for its yellow rather than for
     * its voice.
     *
     * A `Set` because `landVoiceIndices` takes either and a set says what this
     * is: membership, with no order and no index of its own. An index into a
     * shortened list is the one thing this layer may never grow.
     */
    voices: new Set([
      'tinamou',
      'woodcreeper',
      'musicianwren',
      'potoo',
      'solitaire',
      'antbird',
      'piha',
      'antshrike',
    ]),
    /**
     * ==== THE CICADA WALL IS THE LOUDEST STATEMENT THE RAINFOREST MAKES ====
     *
     * And a boreal forest in snow makes the opposite one. Read by BOTH
     * `ambience.js` (where it scales `cicadaGain` directly) and `wildlife.js`
     * (where it DIVIDES the night stridulation interval), so one number turns
     * the whole insect bed down at both ends.
     *
     * 0.05 AND NOT 0. As a gain that is −26 dB, which is a lone insect in a
     * thaw rather than a wall, and a thaw does have flies. Zero would be a
     * claim about February that the rest of this land does not make — the
     * hemisphere triple and the snowfall are winter, not vacuum — and it would
     * push `wildlife.js` onto its own `Math.max(0.02, …)` floor, which is a
     * clamp doing the job a number should be doing.
     */
    insects: 0.05,
    /**
     * ==== THE BIG PAIR THAT CROSSES HIGH ==================================
     *
     * `fauna.js` seats three bonded pairs at 54–76 m — above the canopy, where
     * they are the only birds in this wood always against the sky — and
     * `wildlife.js` voices them out of `_throat` rather than out of the VOICES
     * table. That last part is why the roster above cannot reach them: the
     * filter is over `VOICES` by name, and this pair is not in it. So a winter
     * wood got everything else made boreal and kept three pairs of scarlet
     * macaws screaming over the spruces, which is the single most visible wrong
     * thing an observer could report about this land.
     *
     * A SUBSTITUTION AND NOT A DELETION. The six slots are reserved inside an
     * InstancedMesh that is drawn anyway, so removing the pairs would leave six
     * uninitialised matrices — identity, i.e. six birds standing on the world
     * origin — and it would delete the image rather than move it. Every boreal
     * forest on earth has the same image in it: two ravens, high, straight,
     * black, croaking to each other as they go. Same pairs, same machinery,
     * same zero draw calls. Both files carry the numbers, keyed by this name;
     * see HIGH_PAIRS in each. It also switches off the parrot mob, which is a
     * psittacine event by construction and has no northern equivalent worth
     * inventing.
     */
    highPair: 'raven',
    /**
     * THE WINTER COAT, AND IT IS THE ONLY THING IN THIS LAND THAT CHANGES WHAT
     * AN ANIMAL LOOKS LIKE.
     *
     * A whole-list replacement of that species' morphs. Every field in one is
     * already a multiplier on the species' own base coat, countershading and
     * markings — see `MORPHS` in fauna.js — so this cannot produce a
     * differently-shaped object or put the rump flash somewhere new. It is the
     * one lever with the right blast radius: no geometry, no material, no draw
     * call, no extra rng draw, and provably absent from the rainforest.
     *
     * Overriding `spec.colour` instead was the obvious move and is wrong. The
     * tapir's `pale` is [2.25, 2.1, 1.9], fitted to a base that is nearly
     * black and saying so in its own note; lifting the base lifts the belly by
     * the same factor again, and the countershading clips before the coat has
     * moved. A morph scales both together.
     */
    coats: {
      /**
       * Paler, greyer, heavier — the three words in the request, in that order
       * of weight.
       *
       * `ordinary` keeps the plain animal the plurality, because rarity is what
       * makes the odd one legible and that argument is latitude-independent.
       * `winter` replaces the rainforest's `pale` and `red` between them at a
       * much higher weight (0.24 against 0.06): a boreal population in February
       * is not one animal in sixteen that is pale, it is most of them. The cast
       * is cool by 6% on blue against red, which is a faint hue shift and not a
       * blue animal — the same discipline the snow palette above argues for.
       *
       * `heavy` IS THE ONE ADDITION, and it is the "boreal body" this land was
       * allowed at most one of. 1.22x on `m.scale` only — see the note at that
       * line for why not on `base` — which through `m.mass = scale^1.6` also
       * lands and crashes about 40% harder. At `w` 0.08 you meet one every
       * dozen or so encounters, which is the rate at which a thing is an event
       * rather than a feature. Dark and cold with it: a bull moose in a spruce
       * wood is a black shape you hear before you see.
       */
      tapir: [
        { name: 'ordinary', w: 0.62, light: [0.82, 1.1] },
        { name: 'winter', w: 0.24, light: [1.4, 1.8], cast: [0.97, 0.99, 1.06] },
        { name: 'dark', w: 0.06, light: [0.5, 0.66], cast: [0.95, 0.97, 1.04] },
        { name: 'heavy', w: 0.08, light: [0.58, 0.8], cast: [0.96, 0.98, 1.05], size: 1.22 },
      ],
      /**
       * THE MOUNTAIN HARE, AND THE WHITE ONE IS DELIBERATELY NOT WHITE.
       *
       * A morph is a multiplier over `0x6b4526`, a warm grizzled brown whose
       * linear components are (0.147, 0.058, 0.020). Scaling that by any single
       * number gives a brighter ORANGE, not a paler grey: to reach neutral you
       * have to open the cast enormously — roughly [1.3, 2.6, 6.0] — and every
       * one of those factors also multiplies `pale` [1.9, 1.8, 1.62] on the
       * belly, which is where it would clip first.
       *
       * `winter` computes to linear (0.36, 0.29, 0.22) at the middle of its
       * light range, i.e. sRGB ~(160, 148, 132): a pale grey-fawn, which is
       * what a hare in half-moult actually is and is well clear of white. The
       * belly lands at (0.69, 0.51, 0.36), under one, so nothing clips. THIS
       * WAS COMPUTED AND NOT LOOKED AT — if it wants to go further the cast is
       * the field to open, and blue is the channel with the most room.
       *
       * `moulting` is the pied morph doing a different job: a hare caught
       * between coats is genuinely blotched, and it is the same one attribute
       * slot at no cost. `sandy` is dropped — there is no sandy ground here.
       */
      agouti: [
        { name: 'ordinary', w: 0.52, light: [0.82, 1.15] },
        { name: 'winter', w: 0.3, light: [1.7, 2.1], cast: [1.3, 2.6, 6.0] },
        { name: 'moulting', w: 0.11, light: [1.25, 1.6], cast: [1.2, 2.0, 4.0], pied: [0.6, 1.0] },
        { name: 'black', w: 0.07, light: [0.4, 0.55], cast: [0.98, 0.98, 1.03] },
      ],
    },
  },
  /**
   * ==== THE AIR. THREE SCALARS, APPLIED WHERE THE DAY TABLE IS CONSUMED =====
   *
   * `sky: 'boreal'` was advisory and read by nothing. It still is — what a
   * consumer actually reads is this — and the reason the field below is three
   * numbers rather than a second `DAY_KEYS` is the same reason the advisory
   * note gave: that table is ~15 keyframes of ~20 fields of MULTIPLIERS over
   * captured constructor intensities, nobody has measured what switching one
   * costs, and a second copy of it is a second thing to keep in step with every
   * future lighting pass. "Low sun, long cold twilight, grey air" does not need
   * one. It needs the hemisphere down, the fog up and the fog rotated cold, and
   * all three are arithmetic on values `_recompose` already composes.
   *
   *   `hemi` 0.82 — the hemisphere carries 83% of what shade is made of (see
   *   the note beside the light in atmosphere.js), so this is the one knob that
   *   moves the ambient level without touching the sun. 18% down is about a
   *   quarter of a stop: a flatter, dimmer sky, which is what an overcast
   *   winter is. It is NOT lower because the snow is now the brightest albedo
   *   in the project and a dim sky over a bright floor inverts the value
   *   structure this land is built on — dark trees against pale ground.
   *
   *   `fog` 1.4 — cold air over snow is hazier and the horizon goes sooner.
   *   Fog is exponential-squared, so 1.4x density is a visibility distance of
   *   1/1.4 = 0.71 of the rainforest's. It composes with the player's View
   *   distance knob and with the cave depth rather than fighting them, because
   *   it goes in as one more factor in the same product.
   *
   *   `tint` — a lerp of the hour's own fog colour toward 0x8fa2b5 by 0.55. A
   *   ROTATION AND NOT A REPLACEMENT, which matters: the day table's fog colour
   *   is what makes dawn orange and midnight indigo, and a land that assigned
   *   its own would delete the whole day cycle from the horizon. At 0.55 the
   *   hour still moves it and every hour of it comes out colder.
   *
   * THE RAINFOREST DECLARES 1 / 1 / null, and `null` is an identity rather than
   * a lerp by zero for the same reason `snow` in terrain.js is a branch rather
   * than a lerp by zero: an expression that is not evaluated cannot round
   * differently from the one that used to be there.
   */
  air: {
    hemi: 0.82,
    fog: 1.4,
    tint: { colour: 0x8fa2b5, amount: 0.55 },
    /**
     * THE SHADE, WHICH IS WHAT THE PROBE ACTUALLY CAUGHT.
     *
     * See the AIR_LIGHT block in atmosphere.js for the measurement. In short:
     * the hemisphere's GROUND half is the bounce off the floor, the table's
     * value for it is a rainforest's dark green-brown, and a snowfield bounces
     * white at four times the intensity.  at 0.72 is most of the way to
     * white and stops short of all the way, because the duff and the stone
     * showing through the snow do bounce something.
     *
     *  is a colder, paler blue than a tropical sky's, at a third — enough
     * to say winter and not enough to make the shade read as moonlight. The
     * ambient and the fill take 0.7 of that inside the consumer.
     */
    light: {
      sky: 0xb9cbdd,
      ground: 0xdfe3e6,
      sun: 0xf2f6ff,
      skyAmount: 0.34,
      groundAmount: 0.72,
      sunAmount: 0.34,
    },
  },
  /**
   * STILL ADVISORY, AND NOW THE ONLY ONE.
   *
   *   `sky` — kept as the NAME of the look, for anything that wants to branch
   *   on more than the three scalars in `air` (a different star field, a
   *   different sun-shaft colour). `air` is what carries the light itself.
   *
   *   `weather` — the rain system (`RAIN_COUNT = 3600`, `RAIN_SPAN = 46`) is
   *   already a camera-following box of instanced streaks. Snow is that with a
   *   slower fall, a lateral drift and a round sprite, which is three uniforms
   *   and no new draw call. Nothing reads this yet.
   */
  sky: 'boreal',
  weather: 'snow',
};
