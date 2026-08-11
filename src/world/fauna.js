import * as THREE from 'three';
import { TAU, clamp, clamp01, damp, makeRng, rngRange, wrapAngle } from '../core/util.js';
import { WORLD_RADIUS, heightAt, slopeAt, wetness } from './terrain.js';
import { colliderGrid } from './forest.js';
import { glowSprite } from './textures.js';
import { deerGeometry, flyerGeometry, rabbitGeometry, squirrelGeometry } from './fauna/shapes.js';
import { beastMaterial, flyerMaterial, swarmMaterial } from './fauna/shading.js';
/**
 * A NAMESPACE IMPORT, ON PURPOSE, AND ONLY BECAUSE OF WHAT IS NOT IN IT YET.
 *
 * `VOICE_COUNT` and `Wildlife` are the two things `audio/wildlife.js` exports
 * today; what this file would really like is the species NAMES, because the
 * perchers are now built to look like whatever they sound like and a name is
 * the only stable handle on that (see PLUMAGE). A named import of an export
 * that does not exist is a link-time error in ESM — the whole app fails to
 * start — so asking for one through the namespace is the difference between
 * "picks up the names the day they are exported" and "a blank page if the other
 * file is a day behind". Nothing else is bought by it and nothing is lost.
 */
import * as wildlifeAudio from '../audio/wildlife.js';
import { darkAt, daylightAt, dayPhase } from './daylight.js';

const { VOICE_COUNT, Wildlife } = wildlifeAudio;

/**
 * The things that live here.
 *
 * THE DESIGN PROBLEM IS NOT "ADD ANIMALS", IT IS "MAKE A WALK HAVE EVENTS IN
 * IT". A forest with forty deer standing about in it is a diorama; you learn in
 * ninety seconds that deer are scenery and stop looking at them. What makes a
 * wood feel inhabited is that it keeps *almost* showing you something — a bird
 * bursting out of a bush at your elbow, a white rump going away through the
 * ferns, a squirrel that goes round the back of a trunk and is not there when
 * you follow it. Every one of those is an interaction between the animal and
 * YOU, which is why almost none of this file is about drawing and most of it is
 * about noticing, watching and leaving.
 *
 * So the population is small and it FOLLOWS YOU. Twenty-three ground animals and
 * twenty-six perchers exist in total, their territories are re-seeded around the
 * player whenever they are far away and out of frame, and the world is therefore
 * always about to produce an encounter without ever containing a crowd. It also
 * means the whole system costs twenty-three state machines a frame instead of
 * five hundred, which is the only budget at which any of this is affordable.
 *
 * TWENTY-THREE AND NOT TWENTY BECAUSE OF THE THREE YOUNG. The adult population
 * is exactly what it always was — four deer, ten rabbits, six squirrels — and a
 * fawn and two kits sit on top of it. Taking their slots out of the existing
 * counts would have been the invisible version of this change: the wood would
 * have gained a family and quietly lost a deer and two rabbits, and the thing
 * you would notice is the one that is missing.
 *
 * SIX DRAW CALLS FOR EVERY LIVING THING.
 *
 *   birds       one InstancedMesh — the wheeling flocks AND the perchers, see
 *               flyerMaterial: the flocks are pure vertex-shader orbits and the
 *               perchers arrive by instanceMatrix, and they share a program.
 *   butterflies one, entirely in the vertex shader.
 *   deer / rabbits / squirrels   one each, twenty instances between them.
 *   swarm       one Points cloud holding every midge and every firefly.
 *
 * NOTHING HERE CASTS A SHADOW, and that is a correctness requirement rather than
 * a saving. The shadow map only re-renders when the sun's anchor steps, every
 * eight metres of player movement (see atmosphere.follow) — so a moving animal
 * would leave its shadow standing where it used to be for as long as you stood
 * still, which is far worse than having no shadow at all. They all RECEIVE
 * shadows, which is free and is what actually matters: a deer walking through
 * dapple is most of why it belongs to the wood.
 *
 * A POPULATION IS NOT A SPECIES REPEATED, AND THAT IS THE SAME ARGUMENT AGAIN.
 *
 * Everything above is about an encounter being an event. An encounter with the
 * eleventh identical rabbit is not one, whatever it does — the first three
 * taught you what a rabbit is here and after that the animal is a token. So the
 * variety in this file is spent exactly where a walk can notice it, and nowhere
 * else:
 *
 *   THE PERCHERS ARE SPECIES NOW. Each one already carried a voice index into
 *   the audio table and looked like a generic dark smudge, so the wood was full
 *   of birds that sang like a nuthatch and looked like nothing. A goldcrest is
 *   tiny, a wood pigeon is big and grey, a blackbird is black with a yellow
 *   bill, a robin has a red front — matched to the voice, through two instanced
 *   attributes and the SAME geometry and material. Still one draw call. This is
 *   the highest-value thing in the file per line, because the percher is the
 *   only bird you get within three metres of.
 *
 *   MAMMALS HAVE MORPHS, RARELY. A lightness multiplier is a population of one
 *   animal at different exposures. A black squirrel, a piebald rabbit, a pale
 *   doe — these run between one in ten and one in twenty, and they are worth
 *   stopping for, which is the whole test. See `individual`.
 *
 *   SEX IS SIZE AND NERVE, NEVER AN INVENTED MARKING. A stag is bigger, wears a
 *   rack, stands and watches you for much longer and then goes explosively; a
 *   doe leaves early and quietly and may have a fawn at heel. A rabbit buck is
 *   a tenth larger and holds its ground a beat longer. Nothing carries a badge
 *   the real animal does not have, because a difference the player cannot see
 *   is a comment pretending to be a feature — which is exactly what
 *   `antlerChance` was until the shader was made to honour it.
 *
 *   AND THE COAT IS RE-ROLLED WHEN A CREATURE IS RECYCLED, because the recycle
 *   is a new animal by construction: the one that walked out of frame is gone
 *   and this is a different one, somewhere you have not been. A fixed cast of
 *   twenty means a session either contains a black squirrel or it does not; a
 *   re-rolled one means a long walk eventually shows you one, which is what
 *   "rare" is supposed to mean.
 */

/**
 * Where the living things sit in the forest's opaque draw order.
 *
 * The scheme is ground -4, trunks -3, understorey and props -2, leaves -1,
 * sky 90 — see the block comment at the ground chunk in ground.js for the
 * measurements. Animals are small, opaque and depth-writing, so they belong
 * with the props. The swarm is deliberately NOT given this: it is additive
 * Points and lives in the transparent list, which renderOrder cannot move it
 * out of anyway.
 */
const FAUNA_RENDER_ORDER = -2;

/** How far a creature can be before it is not worth drawing. Metres. */
const FAR = { deer: 130, rabbit: 78, squirrel: 64 };

/** Grid cell for the trunk index, metres. Big enough that a lookup is 9 cells. */
const TRUNK_CELL = 16;

/**
 * Trees, taken out of the collision list.
 *
 * `colliders` is the list of things in this forest you can walk into, and it is
 * built with a radius that identifies what each one is: a trunk is
 * 0.28·scale + 0.34 for scale in 0.68..1.34, so 0.53..0.72; a fallen log is 1.1
 * and a boulder is 1.5. Anything under 0.8 is a tree and nothing else can be.
 *
 * Reading it beats re-deriving the scatter: it is the actual list of the actual
 * trunks in the actual world, so a bird perched from it is on a branch that is
 * really there, and a squirrel climbing one is climbing a tree you can walk up
 * to and touch. Re-running the density field would agree with the forest only
 * as long as nobody retuned it.
 */
/**
 * A QUERY, NOT A SNAPSHOT, and that is what streaming changed.
 *
 * This used to walk `colliders` once at load and build its own 16 m hash of
 * everything under r = 0.8. That was correct for a world of 3600 trees that
 * could never gain another; it is exactly wrong for one that streams, because
 * the index would be a permanent record of the trees near the origin and a
 * bird two kilometres out would find nothing to perch on for ever.
 *
 * `colliderGrid` is already a 16 m hash of every trunk, log and boulder in the
 * ring, authored and streamed, maintained by the field as sectors come and go —
 * so the honest thing is to ask it. The radius filter still identifies what a
 * thing is: a trunk is 0.28·scale + 0.34 for scale in 0.68..1.34, so 0.53..0.72;
 * a fallen log is 1.1 and a boulder is 1.5. Anything under 0.8 is a tree and
 * nothing else can be.
 *
 * Reading the collision list beats re-deriving the scatter for the same reason
 * it always did: it is the actual list of the actual trunks, so a bird perched
 * from it is on a branch that is really there.
 */
function trunkIndex() {
  return {
    /** Nearest trunk to a point, or null. */
    near(x, z, maxDistance = TRUNK_CELL) {
      let best = null;
      let bestD = maxDistance * maxDistance;
      /**
       * `nearCells` rather than `near`, and the radius matters: the grid's own
       * `near` gathers a fixed 3×3 because that is all a BODY can touch, and
       * the squirrels ask for a trunk up to 22 m away — two cells, not one.
       */
      const span = Math.max(1, Math.ceil(maxDistance / TRUNK_CELL));
      const cx = Math.floor(x / TRUNK_CELL);
      const cz = Math.floor(z / TRUNK_CELL);
      for (let i = -span; i <= span; i++) {
        for (let j = -span; j <= span; j++) {
          const cell = colliderGrid.cells.get(`${cx + i},${cz + j}`);
          if (!cell) continue;
          for (const c of cell) {
            if (c.r >= 0.8) continue;
            const d = (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z);
            if (d < bestD) {
              bestD = d;
              best = c;
            }
          }
        }
      }
      // `r` here is the TRUNK's radius, not the collider's: the collision
      // circle is the trunk plus the body's own 0.34, and a bird has to sit on
      // the bark rather than 34 cm off it.
      return best === null ? null : { x: best.x, z: best.z, r: best.r - 0.34 };
    },
  };
}

/**
 * Can something stand here?
 *
 * The same three questions everything else in this world asks — inside the
 * playable disc, out of the stream, off the cliffs. An animal standing in the
 * river is the fauna equivalent of a floating tree and it is exactly as
 * obvious.
 */
const ROAM_RADIUS = WORLD_RADIUS * 0.8;
/**
 * The centre of the roaming disc, which used to be the world origin.
 *
 * THIS WAS THE SINGLE LINE THAT EMPTIED THE FAR WORLD. `standable` gates every
 * reseat, every graze target, every perch and every flee destination, and while
 * it tested a disc around (0, 0) the answer two kilometres out was "no" for all
 * of them — so a deer that wandered out of frame stayed exactly where it was
 * for ever, a startled bird could not find anywhere to land, and the wood
 * beyond the authored region had nothing alive in it at all. The creatures
 * already had follow-the-player recycling; it was disabled by a radius.
 *
 * Anchored on the player, it means the same thing it always did — "somewhere a
 * creature could plausibly be" — and it is now true everywhere. Starts at the
 * origin so that the placement done at load, before any camera exists, is
 * exactly the placement it always was.
 */
let roamX = 0;
let roamZ = 0;
function standable(x, z) {
  const dx = x - roamX;
  const dz = z - roamZ;
  if (dx * dx + dz * dz > ROAM_RADIUS * ROAM_RADIUS) return false;
  if (wetness(x, z) > 0.42) return false;
  return slopeAt(x, z) < 0.42;
}

/** Hoisted scratch. Nothing in the update path may allocate. */
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _m = new THREE.Matrix4();
const _proj = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _sphere = new THREE.Sphere();
const _tint = new THREE.Color();

/**
 * A per-instance tint, which is a MULTIPLIER and not a colour.
 *
 * Every fauna shader ends with `rrC *= vFaunaTint`, so a value of one is "the
 * species colour, exactly". Varying it around one gives darker and lighter
 * individuals with a little warm/cool drift, which is what an actual population
 * looks like; picking absolute colours instead throws away the countershading
 * and the markings that were computed from the species' own numbers.
 */
function shade(out, rng, lo, hi, cast = null) {
  const l = rngRange(rng, lo, hi);
  out.setRGB(l * rngRange(rng, 0.93, 1.08), l, l * rngRange(rng, 0.86, 1.02));
  // A morph's own bias, on top of the lightness. Still a multiplier, so a foxy
  // red squirrel is the species' countershading and markings in a warmer key
  // rather than a differently-coloured object of the same shape.
  if (cast) out.setRGB(out.r * cast[0], out.g * cast[1], out.b * cast[2]);
  return out;
}

/**
 * COAT MORPHS. A LIGHTNESS RANGE IS NOT A POPULATION.
 *
 * `shade` alone gives you one animal photographed at a dozen exposures, which
 * is honest about individual variation and says nothing about the thing a real
 * population actually has: a small number of individuals that are visibly a
 * DIFFERENT ANIMAL. Melanistic squirrels are perhaps one in twenty in the woods
 * that have them; a piebald rabbit is rarer and unmistakable; a pale doe is the
 * one the whole village knows about.
 *
 * WHICH IS WHY THIS IS WORTH THE TABLE AND A UNIFORM COLOUR VARIATION IS NOT.
 * The file's thesis is that a walk should have events in it, and rarity is what
 * makes something an event — a colour every animal has a bit of is scenery, and
 * a colour one animal in twenty has completely is a thing you point at. The
 * weights below are deliberately low enough that most encounters are with the
 * ordinary animal, because the ordinary animal is what makes the odd one legible.
 *
 * `light` stays the multiplier range `shade` always took, so the discipline the
 * block above this describes is intact inside every morph: the countershading,
 * the rump flash and the eye are still computed from the species' own numbers
 * and are still being multiplied, not replaced. `cast` is a warm/cool bias and
 * `pied` is the one thing a multiplier genuinely cannot express — see the pied
 * block in shading.js.
 */
const MORPHS = {
  deer: [
    { name: 'ordinary', w: 0.8, light: [0.88, 1.18] },
    // A dark red deer stag reads almost black in shade and is the single most
    // impressive thing this wood can put in front of you.
    { name: 'dark', w: 0.09, light: [0.5, 0.66], cast: [0.95, 0.97, 1.04] },
    { name: 'pale', w: 0.06, light: [1.55, 1.95], cast: [1.03, 1.0, 0.95] },
    { name: 'red', w: 0.05, light: [1.02, 1.3], cast: [1.18, 0.92, 0.72] },
  ],
  rabbit: [
    { name: 'ordinary', w: 0.78, light: [0.82, 1.22] },
    { name: 'black', w: 0.07, light: [0.4, 0.55], cast: [0.98, 0.98, 1.03] },
    { name: 'sandy', w: 0.08, light: [1.4, 1.85], cast: [1.09, 1.0, 0.84] },
    // The only one that needs a pattern rather than a level. A blotched rabbit
    // is the classic escaped-domestic in a wild warren and it is impossible to
    // mistake for anything else at forty metres.
    { name: 'pied', w: 0.07, light: [0.88, 1.2], pied: [0.65, 1.0] },
  ],
  squirrel: [
    { name: 'ordinary', w: 0.76, light: [0.85, 1.2] },
    { name: 'melanistic', w: 0.1, light: [0.32, 0.46] },
    { name: 'ginger', w: 0.09, light: [1.35, 1.8], cast: [1.14, 0.95, 0.78] },
    { name: 'silvered', w: 0.05, light: [1.15, 1.5], cast: [0.9, 0.94, 1.07] },
  ],
};
/** The weights, summed once at load rather than on every pick. */
const MORPH_TOTAL = Object.fromEntries(
  Object.entries(MORPHS).map(([k, list]) => [k, list.reduce((s, m) => s + m.w, 0)])
);

/** Draw a morph. Falls through to the first entry, which is always the plain one. */
function pickMorph(rng, name) {
  const list = MORPHS[name];
  if (!list) return null;
  let r = rng() * MORPH_TOTAL[name];
  for (const m of list) {
    r -= m.w;
    if (r <= 0) return m;
  }
  return list[0];
}

/**
 * SEX, AND THE RULE THAT DECIDES WHAT MAY GO IN HERE.
 *
 * A difference the player cannot perceive is dead code with a plausible name on
 * it, so every field below has to survive one question: would you see it from
 * where you actually meet this animal? Three things pass.
 *
 *   SIZE. Fifteen per cent between a stag and a doe, ten between a buck rabbit
 *   and a doe. That is visible only when two of them are in frame together,
 *   which happens constantly because they share territories — and it is the
 *   whole reason the scale ranges below were widened past the ±10% they had.
 *
 *   THE RACK. Real, at last: see `horn` and `uHorn`. It is the one true visual
 *   badge in the list and it is not invented, it is the actual difference.
 *
 *   NERVE, which is worth more than either. A stag lets you closer, watches you
 *   for half as long again, and when he finally goes he goes explosively rather
 *   than trotting off; a doe leaves early, from further out, and takes her fawn
 *   with her. You cannot see nerve, but you can see every consequence of it,
 *   and after three encounters you can predict which animal you are looking at
 *   before it has done anything. That is what a sex difference is FOR.
 *
 * What is deliberately absent is any coat marking split by sex. Neither of the
 * two mammals that have one in life shows it at fifteen metres in a wood.
 *
 * `young` is how many of `count` are juveniles rather than adults. They are the
 * last slots, their dams are the slots immediately before them, and those slots
 * are forced female — which is the only reason the table needs to know.
 */
const SEXES = {
  deer: [
    { name: 'stag', nerve: 1.06, size: 1.14, antler: [0.6, 1.2] },
    { name: 'doe', nerve: 0.78, size: 0.94, antler: 0 },
  ],
  rabbit: [
    { name: 'buck', nerve: 1.05, size: 1.08, antler: 0 },
    { name: 'doe', nerve: 0.88, size: 0.93, antler: 0 },
  ],
  squirrel: [
    { name: 'male', nerve: 1.04, size: 1.05, antler: 0 },
    { name: 'female', nerve: 0.9, size: 0.95, antler: 0 },
  ],
};

/**
 * A juvenile, which is the cheapest strong event in this whole file.
 *
 * A fawn is a deer at 0.6 scale that never leaves its mother, and the ENTIRE
 * implementation is: graze around her instead of around an anchor, and go when
 * she goes. It costs one pointer and about eight lines, it adds no state
 * machine, and what it buys is the only relationship between two animals in the
 * wood — which is why it reads as a family and not as a small deer.
 *
 * Nerve well under one, so the pair leaves early: a doe with a fawn at heel is
 * the jumpiest animal in a real wood and that is exactly what makes the sight
 * of one worth something. It also means the encounter usually ends the way the
 * good ones do, with two animals going away through the trees.
 */
const JUVENILE = { nerve: 0.62, size: 0.6, territory: 0.35 };

/**
 * Species table.
 *
 * `notice` is how far away it works out that you are there; `flee` is how close
 * you get before it leaves; `watch` is how long it stares first. That last one
 * is the interesting number, because it is the one the trip multiplies — see
 * the update loop. A deer that watches you for two seconds is a deer. A deer
 * that watches you for eleven is an event.
 *
 * `scale` is the range for an average individual of its sex; the sex factor and
 * the juvenile factor multiply it, so the deer below actually run from a 0.52
 * fawn to a 1.31 stag against the 0.92–1.12 they used to. Twenty per cent
 * either side of the mean is not a herd, it is a rendering tolerance.
 */
const BEASTS = {
  deer: {
    build: deerGeometry,
    count: 5,
    young: 1,
    scale: [0.86, 1.15],
    speed: { graze: 0.5, walk: 1.5, bolt: 8.2 },
    stride: 1.75,
    notice: 36,
    flee: 14,
    watch: [1.8, 4.2],
    territory: 26,
    colour: 0x7a5a3c,
    /** Reflectance multiplier on the underside. A belly is not a colour. */
    pale: [1.75, 1.62, 1.4],
    /** spineY, bellyY, strength, topY — see the countershading block. */
    belly: [1.06, 0.8, 0.85, 1.42],
    /** The rump patch: x, y, z, radius. */
    flash: [0, 1.07, -0.94, 0.32],
    eye: [0.086, 1.84, 1.45, 0.032],
    trimRate: 0.9,
    trimAmp: 0.02,
    bob: 0.05,
    lung: 0.008,
    /**
     * The point inside the skull a doe's antlers fold away to, in the body's
     * own local coordinates — the head blob is at (0, 1.82, 1.36) with radii of
     * about (0.10, 0.115, 0.19), so this is inside it from every angle and the
     * collapsed beam is twenty zero-area triangles nobody can see.
     *
     * It replaces `antlerChance`, which said "half of them are stags" and was
     * read by the shader as a wobble amplitude. Every deer wore a rack; half of
     * them wore one that did not move.
     */
    horn: [0, 1.86, 1.32],
    /** Steps per second at a walk, for the audio. */
    step: 1.6,
  },
  rabbit: {
    build: rabbitGeometry,
    count: 12,
    young: 2,
    scale: [0.78, 1.24],
    speed: { graze: 0.28, walk: 1.1, bolt: 6.4 },
    stride: 0.5,
    notice: 17,
    flee: 7.5,
    watch: [0.5, 1.4],
    territory: 9,
    colour: 0x6e5c46,
    pale: [1.9, 1.8, 1.62],
    belly: [0.24, 0.1, 0.9, 0.4],
    flash: [0, 0.23, -0.23, 0.09],
    eye: [0.055, 0.32, 0.33, 0.016],
    trimRate: 2.6,
    trimAmp: 0.014,
    bob: 0.075,
    lung: 0.004,
    step: 3.4,
  },
  squirrel: {
    build: squirrelGeometry,
    count: 6,
    young: 0,
    scale: [0.78, 1.18],
    speed: { graze: 0.5, walk: 1.4, bolt: 5.2 },
    stride: 0.34,
    notice: 15,
    flee: 9,
    watch: [0.3, 0.9],
    territory: 7,
    colour: 0x7c4a2a,
    pale: [1.85, 1.7, 1.5],
    belly: [0.15, 0.05, 0.95, 0.28],
    /** A pale throat rather than a rump: a squirrel's give-away is its tail. */
    flash: [0, 0.11, 0.19, 0.055],
    eye: [0.035, 0.19, 0.24, 0.013],
    trimRate: 1.7,
    trimAmp: 0.05,
    bob: 0.05,
    lung: 0.003,
    step: 5,
  },
};
// The key, on the value. `reseat` and `individual` are handed a spec and need
// to know which morph table it belongs to, and threading the name through four
// call sites to avoid one assignment is not a trade.
for (const [name, spec] of Object.entries(BEASTS)) spec.name = name;

/**
 * WHAT THE BIRD YOU CAN HEAR LOOKS LIKE.
 *
 * Every percher already holds a voice index into `audio/wildlife.js`, and until
 * now that was the only thing about it that was a species: twenty-six identical
 * dark smudges, one of which sang like a wood pigeon and one like a goldcrest.
 * Coupling the two is the cheapest way to make this wood feel like a place,
 * because it turns the bird in the tree in front of you from a decoration into
 * a FACT that two different systems agree about — and being able to walk toward
 * a sound and find the animal that makes it is most of what a wood is.
 *
 * KEYED BY NAME, NOT BY INDEX, and that is the whole reason this table exists
 * here rather than as an array in voice order. `VOICES` in wildlife.js has grown
 * from six to twelve once already and is growing again; an array indexed 0..11
 * would silently re-skin every bird in the wood the next time somebody inserts
 * a species above the one they were adding. A name either matches or it does
 * not, and a miss falls through to `STRANGERS` and gets a plausible bird.
 *
 * THERE IS NO SIZE IN HERE, AND THAT IS THE SECOND HALF OF THE SAME ARGUMENT.
 * `wildlife.js` carries every species' body length in centimetres and hands it
 * out through `voiceInfo`, so the size of a bird is a fact that already exists
 * in the file that owns the species list. Copying it here would be a second
 * roster of exactly the kind the name-keying above exists to avoid, and it
 * would go stale in the same way and just as quietly. See `sizeOf`.
 *
 * WHAT EACH NUMBER IS, AND WHY THEY ARE THE NUMBERS THEY ARE.
 *
 *   build   [span, girth, length]. A uniform scale can only say
 *           "bigger", and bigger is not a species — a cuckoo has a wood
 *           pigeon's wingspan on a slim long-tailed body, and a wren is a fat
 *           ball with almost no wing and no tail at all. This is the field that
 *           makes two birds of the same size read as different animals.
 *   coat    a MULTIPLIER on the shared bird colour (0x2a2a2c, near black), not
 *           an absolute — the same discipline as `shade`, so a bird still goes
 *           dark when it hops into shade instead of glowing there. Around 2 is
 *           a mid brown, 0.7 is a blackbird, 2.5 with a blue lean is a pigeon.
 *   mark    the second colour, and the reach is how far up the front of the
 *           bird it goes. This is the field that earns the whole attribute: a
 *           robin is a brown bird with a red front, and one colour cannot say
 *           that. At reach 0.05 it is a bill and nothing else; at 0.2 it is the
 *           entire breast. Every bird here has one, because every bird alive is
 *           paler underneath than on top.
 *   dimorph how much duller the hen is, 0 to 1. See `plumageInto`.
 */
const PLUMAGE = {
  /** Warm brown, slate crown, and a pink flush on the breast. */
  chaffinch: {
    build: [1.0, 1.0, 1.02],
    coat: [2.15, 1.62, 1.34],
    mark: [3.5, 1.85, 1.6],
    reach: 0.18,
    // The hen is a completely different-looking bird — plain olive-grey, no
    // pink at all — which is why she is at the top of the range.
    dimorph: 0.85,
  },
  /** Olive back, and the loudest yellow in a British wood. */
  greattit: {
    build: [0.92, 1.06, 0.95],
    coat: [1.5, 1.9, 1.0],
    mark: [4.3, 3.5, 0.8],
    reach: 0.2,
    dimorph: 0.15,
  },
  /** A rufous ball with no tail to speak of. The smallest silhouette here. */
  wren: {
    build: [0.82, 1.22, 0.68],
    coat: [2.3, 1.5, 0.88],
    mark: [2.8, 2.15, 1.5],
    reach: 0.13,
    dimorph: 0,
  },
  /**
   * Black, long-tailed, and the yellow bill is the only thing on it that is not
   * black — which is exactly what `reach` at 0.05 draws. It is also the sharpest
   * test of the mark: get it wrong by a factor of three and you have a
   * blackbird with a yellow head.
   */
  blackbird: {
    build: [0.98, 1.0, 1.16],
    coat: [0.7, 0.66, 0.7],
    mark: [5.4, 3.3, 0.5],
    reach: 0.05,
    // The hen blackbird is brown. Handled by the same rule as everything else
    // — see plumageInto — because pulling near-black toward its own mid grey
    // and then warming it is, usefully, exactly what a hen blackbird is.
    dimorph: 0.75,
  },
  /** Big, broad, blue-grey and stout. The one bird here you cannot mistake. */
  pigeon: {
    build: [1.14, 1.26, 1.0],
    coat: [2.5, 2.55, 2.8],
    mark: [3.5, 3.0, 3.0],
    reach: 0.17,
    dimorph: 0,
  },
  /** Olive-buff, small, and utterly plain. Some birds are. */
  chiffchaff: {
    build: [0.95, 0.92, 1.0],
    coat: [1.7, 1.78, 1.16],
    mark: [3.0, 2.9, 2.0],
    reach: 0.16,
    dimorph: 0,
  },
  /** Round, olive-brown, with the orange-red front that names it. */
  robin: {
    build: [0.9, 1.16, 0.9],
    coat: [1.9, 1.62, 1.15],
    mark: [4.8, 2.0, 0.8],
    reach: 0.17,
    dimorph: 0,
  },
  /** Warm buff-brown above, a pale speckled breast below. */
  songthrush: {
    build: [1.0, 1.06, 1.02],
    coat: [2.2, 1.86, 1.34],
    mark: [3.7, 3.25, 2.4],
    reach: 0.2,
    dimorph: 0,
  },
  /** Blue-grey above, buff below, dumpy, and with practically no tail. */
  nuthatch: {
    build: [0.9, 1.16, 0.76],
    coat: [1.45, 1.75, 2.45],
    mark: [3.3, 2.0, 1.2],
    reach: 0.19,
    dimorph: 0.2,
  },
  /** Tiny. That is the entire identity and the size does all the work. */
  goldcrest: {
    build: [0.85, 1.06, 0.8],
    coat: [1.55, 1.85, 1.12],
    mark: [4.2, 3.5, 1.0],
    reach: 0.055,
    dimorph: 0.3,
  },
  /** Grey, long-winged, long-tailed. Looks far more like a hawk than a songbird. */
  cuckoo: {
    build: [1.22, 0.86, 1.24],
    coat: [1.95, 2.0, 2.2],
    mark: [3.4, 3.4, 3.4],
    reach: 0.19,
    dimorph: 0.25,
  },
  /** Plain warm brown, and famously nothing to look at. */
  nightingale: {
    build: [0.95, 0.96, 1.1],
    coat: [2.0, 1.52, 1.05],
    mark: [2.7, 2.3, 1.75],
    reach: 0.14,
    dimorph: 0,
  },
  /* ---- the third pass, matched to the four voices added with it. ---- */
  /** Olive above, pale yellow below, and slighter than the chiffchaff it hides among. */
  willowwarbler: {
    build: [0.98, 0.9, 1.02],
    coat: [1.68, 1.86, 1.12],
    mark: [3.4, 3.15, 1.5],
    reach: 0.17,
    dimorph: 0,
  },
  /**
   * Streaky brown, long-winged, and it is in a WOOD's fauna table only because
   * the voice is: `wildlife.js` puts a skylark over the field edge and lets you
   * hear it from inside the trees. A percher wearing it is the one you see when
   * the wood opens out, so it gets the long wings and the plain brown and
   * nothing else.
   */
  skylark: {
    build: [1.14, 1.04, 0.98],
    coat: [2.05, 1.8, 1.3],
    mark: [3.2, 2.95, 2.3],
    reach: 0.18,
    dimorph: 0,
  },
  /**
   * Grey-olive, and the cap it is named for is on the CROWN — which this
   * material cannot draw, because the mark is anchored under the head and
   * pulling it over the top would put colour on every bird's forehead. So the
   * blackcap gets its body and not its badge. That is the correct trade: an
   * invented marking is worse than a missing one, and nothing else in the wood
   * is this particular grey.
   */
  blackcap: {
    build: [0.95, 1.0, 1.02],
    coat: [1.72, 1.75, 1.62],
    mark: [2.9, 2.85, 2.6],
    reach: 0.16,
    dimorph: 0.15,
  },
  /**
   * Chestnut back and a head and breast of the brightest yellow in any hedge.
   * The one species in the table the mark was almost designed for — reach at
   * 0.21 is the whole front of the bird, which is exactly where the yellow is.
   */
  yellowhammer: {
    build: [0.98, 1.0, 1.1],
    coat: [2.3, 1.5, 0.95],
    mark: [4.6, 3.9, 0.7],
    reach: 0.21,
    dimorph: 0.55,
  },
};

/**
 * The four birds a voice this file has never heard of turns into.
 *
 * `wildlife.js` is being extended by somebody else and will have species in it
 * that are not above, so the interesting question is not "how do we know them
 * all" but "what does a bird we do not know look like". A generic average of
 * the table would be one shape repeated, which is the thing this whole pass
 * exists to remove; four plausible woodland archetypes picked by a hash of the
 * NAME gives an unknown species a stable, unremarkable, believable appearance
 * that will not be a magenta parrot when the audio agent adds a treecreeper.
 */
const STRANGERS = [
  // A small brown job.
  { build: [0.95, 1.05, 0.96], coat: [1.98, 1.6, 1.2], mark: [2.9, 2.4, 1.8], reach: 0.16, dimorph: 0.2 },
  // A grey one.
  { build: [1.02, 1.0, 1.06], coat: [1.7, 1.75, 1.95], mark: [3.0, 3.0, 3.0], reach: 0.17, dimorph: 0.1 },
  // An olive one.
  { build: [0.9, 1.02, 0.92], coat: [1.6, 1.82, 1.15], mark: [3.2, 3.0, 1.9], reach: 0.15, dimorph: 0.2 },
  // A big dark one.
  { build: [1.03, 1.0, 1.1], coat: [0.95, 0.9, 0.92], mark: [2.4, 2.1, 1.7], reach: 0.12, dimorph: 0.3 },
];

/**
 * The voice table's species names, in its own order — ASKED FOR, NOT COPIED.
 *
 * `wildlife.js` exports `VOICE_NAMES`, and its comment on that export makes the
 * same argument this file would have: the species list is defined by what the
 * thing sounds like, it lives in exactly one place, and a second roster is one
 * that goes stale the next time a row is added, silently, with a nuthatch
 * wearing a wood pigeon. Two agents arrived at that independently, which is
 * usually a sign it is right.
 *
 * The literal below is a floor, not a copy in use: it is what this file falls
 * back to if it is ever loaded next to a `wildlife.js` from before that export
 * existed, and a wrong-but-plausible bird beats twenty-six undefined ones. It
 * is the first twelve names because those are the twelve that were in the table
 * on the day the export did not exist.
 */
const VOICE_ROSTER = wildlifeAudio.VOICE_NAMES ?? [
  'chaffinch',
  'greattit',
  'wren',
  'blackbird',
  'pigeon',
  'chiffchaff',
  'robin',
  'songthrush',
  'nuthatch',
  'goldcrest',
  'cuckoo',
  'nightingale',
];

/** What voice `v` looks like. Never returns null. */
function plumageOf(v) {
  const name = VOICE_ROSTER[v];
  const known = name ? PLUMAGE[name] : null;
  if (known) return known;
  // Hashed from the NAME where there is one, so a species this file has never
  // heard of at least always looks like the same bird, session after session.
  let h = (v * 2654435761) | 0;
  if (name) for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return STRANGERS[Math.abs(h) % STRANGERS.length];
}

/**
 * HOW BIG THAT BIRD IS, OUT OF THE AUDIO TABLE'S OWN CENTIMETRES.
 *
 * `voiceInfo` carries body length because, as its comment says, when and how
 * far a bird sings are facts about where you would see it — and so is how big
 * it is. Taking the number from there rather than from a column in PLUMAGE is
 * the difference between a species list that stays coupled and two lists that
 * agree until somebody edits one: a treecreeper added tomorrow gets the RIGHT
 * SIZE for free and only its colours fall through to `STRANGERS`.
 *
 * The curve is not linear and must not be. True proportions against a 25 cm
 * blackbird would put the wood pigeon at 1.74 and the goldcrest at 0.38 —
 * eighteen triangles at 0.38 is a speck, and the archetype geometry in
 * shapes.js was tuned around the middle of the range and starts to read as a
 * balloon much above 1.4. The 0.85 power compresses both ends without ever
 * reordering them, which is what matters: a goldcrest is still unmistakably the
 * smallest thing in the wood and a pigeon still twice its size. Over the
 * sixteen species in the table it means 0.60 to 1.43, averaging 0.84 — a hair
 * under the 0.885 the old undifferentiated perchers averaged, so the wood has
 * the same amount of bird in it and it is distributed.
 */
function sizeOf(v) {
  const cm = wildlifeAudio.voiceInfo?.(v)?.size ?? 15;
  return 0.3 + 0.046 * Math.pow(cm, 0.85);
}

/**
 * A plumage, resolved onto a hen or a cock, into three scratch arrays.
 *
 * THE HEN IS THE COCK WITH THE CONTRAST TAKEN OUT, and that one rule covers
 * every species in the table without a second colour per row. It is also very
 * nearly the truth: across small woodland birds the female is duller, less
 * saturated and has a smaller or absent version of whatever patch the male
 * wears. Pulling the coat toward its own luminance and the mark toward the coat
 * turns a cock chaffinch into a plain olive one and a cock blackbird into a
 * brown hen, out of one number per species.
 *
 * `dimorph` is that number, and it is zero for most of the table — robins,
 * wrens, pigeons and thrushes genuinely cannot be sexed by eye, and inventing a
 * difference there would be the exact thing the brief forbids.
 */
function plumageInto(coat, mark, spec, hen) {
  const d = hen ? spec.dimorph ?? 0 : 0;
  const lum = spec.coat[0] * 0.2126 + spec.coat[1] * 0.7152 + spec.coat[2] * 0.0722;
  // Toward its own luminance, then warmed a shade: a dull bird is not a grey
  // bird, and a hen blackbird is brown rather than charcoal.
  const warm = [1 + d * 0.34, 1 + d * 0.06, 1 - d * 0.16];
  for (let i = 0; i < 3; i++) {
    coat[i] = (spec.coat[i] + (lum - spec.coat[i]) * d * 0.7) * warm[i];
    mark[i] = spec.mark[i] + (coat[i] - spec.mark[i]) * d * 0.62;
  }
  return spec.reach * (1 - d * 0.45);
}

/**
 * Butterflies, which get the same two attributes for a much smaller sum.
 *
 * The old spread was one hue ramp from orange to yellow and a lightness — which
 * is a good instinct badly served, because the note it was serving is the one
 * in the loop below: a butterfly is the ONLY saturated thing in a wood made of
 * greens and browns and that is exactly why finding one is worth anything. A
 * ramp between two neighbouring hues cannot deliver that; you get twenty-two
 * differently-lit copies of the same marigold.
 *
 * Real species are the answer and they cost nothing extra, because the mark
 * attribute the birds needed does the other half of every one of them: an
 * orange-tip is a WHITE butterfly with orange only at the wingtip, a small
 * tortoiseshell is rust with a dark border, a peacock is maroon with a blue
 * flash out at the corner. The band is the species in almost every case, and
 * the flyer's mark anchor for this material sits out on the wing rather than on
 * the breast for precisely that reason.
 *
 * `w` is how common. Whites and browns are the two you actually see most of in
 * a British wood; a common blue is the one that stops you.
 */
const WINGS = [
  { name: 'white', w: 1.2, size: 0.95, build: [1.0, 1.0, 1.0], coat: [1.5, 1.5, 1.45], mark: [0.55, 0.55, 0.62], reach: 0.038 },
  { name: 'brimstone', w: 1.0, size: 1.05, build: [1.08, 0.95, 1.05], coat: [1.55, 1.45, 0.42], mark: [1.75, 1.5, 0.3], reach: 0.032 },
  { name: 'tortoiseshell', w: 0.9, size: 1.0, build: [1.0, 1.05, 0.98], coat: [1.95, 0.78, 0.2], mark: [0.3, 0.22, 0.24], reach: 0.05 },
  { name: 'meadowbrown', w: 0.9, size: 0.8, build: [0.94, 1.05, 0.95], coat: [0.72, 0.48, 0.3], mark: [1.9, 0.9, 0.26], reach: 0.03 },
  { name: 'orangetip', w: 0.8, size: 0.85, build: [1.02, 0.95, 1.0], coat: [1.55, 1.5, 1.45], mark: [2.5, 1.0, 0.16], reach: 0.055 },
  { name: 'peacock', w: 0.6, size: 1.12, build: [1.05, 1.1, 1.0], coat: [1.35, 0.34, 0.22], mark: [0.42, 0.48, 1.15], reach: 0.042 },
  { name: 'commonblue', w: 0.45, size: 0.68, build: [0.95, 0.95, 0.95], coat: [0.55, 0.72, 2.1], mark: [1.5, 1.5, 1.62], reach: 0.028 },
];
const WINGS_TOTAL = WINGS.reduce((s, k) => s + k.w, 0);

/** Flock birds, drawn entirely by the vertex shader. */
const FLOCK_BIRDS = 96;
const FLOCKS = 4;
/** Birds that sit on real branches and leave when you get near. */
const PERCHERS = 26;
const BUTTERFLIES = 22;
const MIDGES = 880;
const FIREFLIES = 460;

export function buildFauna({ scene, seed = 'grove-01', audio = null } = {}) {
  const rng = makeRng(`${seed}:fauna`);
  const group = new THREE.Group();
  group.name = 'fauna';
  /**
   * The group never moves, and the flock shader depends on that: it writes a
   * WORLD position into `transformed`, which three then puts through
   * modelMatrix. An identity model matrix is the only reason that is the same
   * position it wrote.
   */
  group.matrixAutoUpdate = false;
  scene.add(group);

  const trunks = trunkIndex();
  /** @type {Wildlife|null} */
  let wildlife = null;

  // ---- birds --------------------------------------------------------------
  const birdGeo = flyerGeometry({ span: 0.62, body: 0.3, sweep: 0.22, girth: 1 });
  const birdMat = flyerMaterial({
    name: 'bird',
    colour: 0x2a2a2c,
    /** Metres the flock's own centre wanders, in x, y, z. */
    wander: [22, 3.4, 22],
    /**
     * WHERE A BIRD'S SECOND COLOUR IS ANCHORED, in this geometry's own local
     * units: on the centre line, a hair below the axis, and at z = 0.15, which
     * is the front ring of the body prism — the face and the bill.
     *
     * It is at the FRONT rather than the middle of the breast because that is
     * the end of the range that has to be precise. `reach` grows the patch
     * backward from here, so 0.05 is a blackbird's bill, 0.14 is a throat and
     * 0.2 is the whole front of the animal; anchored at the breast instead, the
     * small end of the range would have been a spot in the middle of the chest,
     * which is not a marking any bird has.
     *
     * The 2.0 keeps sideways distance expensive so the patch stays on the body
     * and does not run out along the wings. Some bleed onto the shoulder is
     * correct — plenty of birds carry breast colour onto the flank — and the
     * wing's own vertices interpolate it away to nothing by the tip.
     */
    mark: [0, -0.008, 0.15, 2.0],
  });
  const BIRD_TOTAL = FLOCK_BIRDS + PERCHERS;
  const birds = new THREE.InstancedMesh(birdGeo, birdMat, BIRD_TOTAL);
  birds.name = 'birds';
  birds.frustumCulled = false;
  birds.receiveShadow = false;
  /**
   * IN THE FOREST'S DRAW ORDER, WITH THE PROPS.
   *
   * three sorts the opaque list by `(groupOrder, renderOrder, material.id, z)`,
   * so anything left at the default 0 draws after everything the forest has
   * explicitly ordered — and every living thing here was, which put small
   * opaque animals behind the alpha-tested canopy. The scheme is ground −4,
   * trunks −3, understorey and props −2, leaves −1, sky 90; see the block
   * comment in ground.js for the measurements behind it.
   *
   * −2 for all five: they are small, opaque and depth-writing, which is exactly
   * what the props are. Worth little on its own — this is the last opaque mesh
   * in the wood that was outside the scheme, and a layer sitting outside it is
   * a thing that gets forgotten and then wondered about.
   */
  birds.renderOrder = FAUNA_RENDER_ORDER;
  const birdFlight = new THREE.InstancedBufferAttribute(new Float32Array(BIRD_TOTAL * 4), 4);
  const birdBeat = new THREE.InstancedBufferAttribute(new Float32Array(BIRD_TOTAL * 4), 4);
  const birdHome = new THREE.InstancedBufferAttribute(new Float32Array(BIRD_TOTAL * 3), 3);
  const birdTint = new THREE.InstancedBufferAttribute(new Float32Array(BIRD_TOTAL * 3), 3);
  /**
   * The species, in two attributes, written once at load and never touched
   * again — a bird does not change what it is.
   *
   * aBuild is (span, girth, length, how much mark) and aMark is (r, g, b, how
   * far the mark reaches). Between them they hold every difference between a
   * goldcrest and a wood pigeon, on one geometry, in one draw call. See the
   * block above `flyerMaterial` in shading.js for why it is these two and not a
   * mesh per species.
   */
  const birdBuild = new THREE.InstancedBufferAttribute(new Float32Array(BIRD_TOTAL * 4), 4);
  const birdMark = new THREE.InstancedBufferAttribute(new Float32Array(BIRD_TOTAL * 4), 4);
  birdGeo.setAttribute('aFlight', birdFlight);
  birdGeo.setAttribute('aBeat', birdBeat);
  birdGeo.setAttribute('aHome', birdHome);
  birdGeo.setAttribute('aTint', birdTint);
  birdGeo.setAttribute('aBuild', birdBuild);
  birdGeo.setAttribute('aMark', birdMark);
  birdFlight.setUsage(THREE.DynamicDrawUsage);
  birdBeat.setUsage(THREE.DynamicDrawUsage);
  birds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(birds);

  /**
   * The flocks. Four rings of two dozen, high over the canopy.
   *
   * Every number here is written once, at load, and never touched again — the
   * shader derives the whole flight from `uTime`. That is what makes ninety-six
   * birds free: there is no per-frame work of any kind, not even a matrix
   * upload, and the only thing they cost is 576 triangles.
   */
  /**
   * Where each flock is, kept so it can be moved.
   *
   * The comment above is still true of a SESSION in the authored world — the
   * shader derives the whole flight from `uTime` and nothing is uploaded per
   * frame — but it stopped being true of an endless one. A flock is a ring at a
   * fixed world coordinate, so walking a kilometre leaves ninety-six birds
   * wheeling over a clearing nobody is standing in and an empty sky overhead.
   *
   * Recorded rather than recomputed: the polar offset and the per-bird jitter
   * are drawn from the same rng stream as every tree in the world, so
   * re-deriving them later would either need a second stream or would move
   * everything. Stored here at no cost and replayed against a new anchor.
   */
  const flocks = [];
  for (let f = 0; f < FLOCKS; f++) {
    /**
     * ONE FLOCK CIRCLES THE CLEARING, AND THAT IS NOT DECORATION.
     *
     * The canopy in this wood is nearly closed — stand under the pines and look
     * up and you see leaves. So a flock scattered at random over the forest is a
     * flock nobody will ever see, however beautifully it wheels. The clearing is
     * the one reliable hole in the roof and it is where the player spawns, so
     * one flock is anchored over it and the ring is wide enough that the birds
     * cross the open sky rather than sitting in the middle of it.
     */
    const overClearing = f === 0;
    const a = rng() * TAU;
    const r = overClearing ? rng() * 10 : 34 + rng() * 96;
    const cx = Math.cos(a) * r;
    const cz = Math.sin(a) * r;
    // Well above the tallest tree, so they are birds over a wood rather than
    // birds in it. Looking up and finding them is the whole effect.
    const lift = rngRange(rng, overClearing ? 24 : 30, overClearing ? 34 : 52);
    const cy = heightAt(cx, cz) + lift;
    const ringR = overClearing ? rngRange(rng, 30, 42) : rngRange(rng, 26, 58);
    const flock = { a, r, lift, birds: [] };
    const speed = rngRange(rng, 0.055, 0.115) * (rng() < 0.5 ? -1 : 1);
    const per = Math.floor(FLOCK_BIRDS / FLOCKS);
    for (let i = 0; i < per; i++) {
      const k = f * per + i;
      if (k >= FLOCK_BIRDS) break;
      // A loose crowd, not a formation: each bird takes its own radius, its own
      // phase and its own offset from the centre.
      birdFlight.setXYZW(
        k,
        ringR * rngRange(rng, 0.72, 1.28),
        speed * rngRange(rng, 0.93, 1.07),
        rng() * TAU,
        rngRange(rng, 0.28, 0.52) * Math.sign(speed)
      );
      birdBeat.setXYZW(
        k,
        rng() * TAU,
        rngRange(rng, 0.13, 0.2),
        rngRange(rng, 6.5, 9.5),
        rngRange(rng, 0.8, 1.35)
      );
      birdHome.setXYZ(
        k,
        cx + rngRange(rng, -14, 14),
        cy + rngRange(rng, -6, 6),
        cz + rngRange(rng, -14, 14)
      );
      // A multiplier on the coat, not a colour: some birds are darker than
      // others and a couple catch the light. Around 1, warm one way, cool the
      // other, so a flock is not one repeated silhouette.
      shade(_tint, rng, 0.55, 1.35);
      birdTint.setXYZ(k, _tint.r, _tint.g, _tint.b);
      /**
       * A LOOSE SPREAD OF BUILDS, AND NO SPECIES.
       *
       * The perchers get a real plumage because you meet them at three metres.
       * A flock bird is a four-pixel silhouette ninety metres up, where the only
       * thing legible about it is the OUTLINE — so it gets a little spread in
       * span, girth and tail and no mark at all, which costs the same one write
       * and stops a wheeling ring from being one shape stamped twenty-four
       * times. A breast patch up there would be a wasted attribute; a
       * long-tailed bird among short-tailed ones is visible.
       */
      birdBuild.setXYZW(
        k,
        rngRange(rng, 0.9, 1.16),
        rngRange(rng, 0.88, 1.12),
        rngRange(rng, 0.92, 1.14),
        0
      );
      birdMark.setXYZW(k, 1, 1, 1, 0);
      // Identity: the shader ignores it, but a garbage matrix would put the
      // mesh's bounding sphere somewhere absurd if anything ever asked.
      birds.setMatrixAt(k, _m.identity());
      flock.birds.push({
        k,
        dx: birdHome.getX(k) - cx,
        dy: birdHome.getY(k) - cy,
        dz: birdHome.getZ(k) - cz,
      });
    }
    flocks.push(flock);
  }

  /**
   * Move the flocks to wherever the player has got to.
   *
   * Hysteresis rather than a lattice, and the same shape as the sun anchor's
   * for the same reason: a flock that re-centred every frame would have its
   * ring sliding under it, which reads as birds being dragged rather than
   * birds circling. FLOCK_HOLD is most of the way to the far ring's radius, so
   * this fires roughly once per two hundred metres of walking and writes
   * ninety-six positions — a few times a minute, against ninety-six identity
   * matrices a frame if they had been made to follow the honest way.
   *
   * The height is re-derived from `heightAt` at the new centre rather than
   * carried, because the region field means the ground two kilometres away can
   * be forty metres higher than it is here and a flock at a remembered altitude
   * would be inside the canopy or in the stratosphere.
   */
  const FLOCK_HOLD = 190;
  let flockX = 0;
  let flockZ = 0;
  function followFlocks(x, z) {
    if ((x - flockX) ** 2 + (z - flockZ) ** 2 < FLOCK_HOLD * FLOCK_HOLD) return;
    flockX = x;
    flockZ = z;
    for (const flock of flocks) {
      const cx = x + Math.cos(flock.a) * flock.r;
      const cz = z + Math.sin(flock.a) * flock.r;
      const cy = heightAt(cx, cz) + flock.lift;
      for (const b of flock.birds) birdHome.setXYZ(b.k, cx + b.dx, cy + b.dy, cz + b.dz);
    }
    birdHome.needsUpdate = true;
  }

  /**
   * A perch: a spot on a real trunk, or failing that on the ground.
   *
   * Height is chosen where the boughs are — trees in this wood run 8 to 20 m —
   * and the bird sits just clear of the bark. `near` biases toward perches you
   * are likely to walk past, which is the whole point of the percher: a bird
   * thirty metres up a tree you never approach is a texture.
   */
  function pickPerch(out, ax, az, minR, maxR) {
    for (let attempt = 0; attempt < 14; attempt++) {
      const a = rng() * TAU;
      const r = minR + Math.pow(rng(), 0.7) * (maxR - minR);
      const x = ax + Math.cos(a) * r;
      const z = az + Math.sin(a) * r;
      if (!standable(x, z)) continue;
      const trunk = trunks.near(x, z, 9);
      if (trunk && rng() < 0.82) {
        const t = rng() * TAU;
        const reach = trunk.r + rngRange(rng, 0.2, 1.5);
        out.set(
          trunk.x + Math.cos(t) * reach,
          heightAt(trunk.x, trunk.z) + rngRange(rng, 3.4, 7.6),
          trunk.z + Math.sin(t) * reach
        );
        return true;
      }
      out.set(x, heightAt(x, z) + rngRange(rng, 0.04, 0.5), z);
      return true;
    }
    out.set(ax, heightAt(ax, az) + 0.3, az);
    return false;
  }

  const perchers = [];
  /** Scratch for the plumage resolve. Nothing at load may allocate either. */
  const _coat = [1, 1, 1];
  const _mark = [1, 1, 1];
  for (let i = 0; i < PERCHERS; i++) {
    const voice = Math.floor(rng() * VOICE_COUNT);
    const plume = plumageOf(voice);
    const size = sizeOf(voice);
    /**
     * COCK OR HEN, and it is not only a colour.
     *
     * In nearly every species in the voice table the male is the one that
     * sings; the female calls occasionally and otherwise gets on with it. That
     * is one multiplier on the sing timer below and it is a real, audible
     * property of the wood — half the birds you walk past are quiet, so the
     * ones that are singing are somebody in particular rather than a uniform
     * field of birdsong. It also happens to take about a third off the demand
     * the perchers put on the audio bucket, which `wildlife.js` has a long and
     * unhappy comment about.
     */
    const hen = rng() < 0.5;
    const reach = plumageInto(_coat, _mark, plume, hen);
    const p = {
      slot: FLOCK_BIRDS + i,
      pos: new THREE.Vector3(),
      home: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      yaw: rng() * TAU,
      state: 'perch',
      timer: rngRange(rng, 0, 9),
      sing: rngRange(rng, 2, 40),
      beat: rng() * TAU,
      /** Wing spread, 0 folded to 1 open. */
      open: 0.04,
      /**
       * The species' size, then the individual's own few per cent on top.
       *
       * The spread used to be 0.72–1.05 with nothing behind it; it now runs
       * from a 0.56 goldcrest to a 1.53 wood pigeon and the number means
       * something — which is the difference between size variety and noise.
       */
      scale: size * rngRange(rng, 0.93, 1.07),
      hen,
      /**
       * Wingbeat rate, against the species' size. A small bird flaps faster:
       * roughly with the inverse cube root of mass in life, and the exponent
       * here is tuned by eye rather than by aerodynamics. A wood pigeon
       * hammering at a goldcrest's rate is the single most obvious thing that
       * can be wrong with a flush.
       */
      wing: Math.pow(size, -0.55),
      /**
       * `VOICE_COUNT`, not a literal.
       *
       * This was `rng() * 6`, frozen at however many species the audio file
       * happened to have the day it was written. Six more were added and none
       * of them could ever be assigned to a bird you can see — they reached the
       * player only through the distant chorus and the cross-species reply, so
       * more than half the wood's voices were unreachable from the one place a
       * listener actually stands. A hard-coded count of somebody else's table
       * is a bug with a delay fuse on it.
       *
       * STILL A UNIFORM PICK, and it is now the pick of the SPECIES and not
       * only of the song. `wildlife.js` has a `rare` weight per voice that
       * would be the honest thing to bias by, and it is not exported; twenty-six
       * uniform draws from twelve is roughly two of each, which is close enough
       * that a wood pigeon is not a surprise and no species is missing.
       */
      voice,
      /** One bird in the wood is the one that starts paying attention. */
      watcher: i === 0,
    };
    pickPerch(p.home, 0, 0, 12, 110);
    p.pos.copy(p.home);
    perchers.push(p);
    birdFlight.setXYZW(p.slot, 0, p.open, 0, 0);
    birdBeat.setXYZW(p.slot, p.beat, 0, 0, p.scale);
    birdHome.setXYZ(p.slot, 0, 0, 0);
    /**
     * The species' coat, and then this individual's own exposure on top of it.
     *
     * `shade` around 1 rather than the 0.7–2.1 that used to be here: the wide
     * spread was doing the entire job of making twenty-six identical birds not
     * look identical, and now that each one is a chaffinch or a nuthatch its
     * job is only the small variation between two chaffinches. Left wide it
     * would have made half of them the wrong colour for their own species,
     * which is worse than the smudges were.
     */
    shade(_tint, rng, 0.88, 1.14);
    birdTint.setXYZ(p.slot, _coat[0] * _tint.r, _coat[1] * _tint.g, _coat[2] * _tint.b);
    birdBuild.setXYZW(p.slot, plume.build[0], plume.build[1], plume.build[2], 1);
    birdMark.setXYZW(p.slot, _mark[0], _mark[1], _mark[2], reach);
  }
  birds.count = BIRD_TOTAL;
  birdFlight.needsUpdate = true;
  birdBeat.needsUpdate = true;
  birdHome.needsUpdate = true;
  birdTint.needsUpdate = true;
  birdBuild.needsUpdate = true;
  birdMark.needsUpdate = true;
  birds.instanceMatrix.needsUpdate = true;

  // ---- butterflies --------------------------------------------------------
  /**
   * Butterflies get the flock path with a two-metre radius and a fast clock,
   * which is not a hack: a butterfly working a patch of clearing genuinely does
   * fly a wobbling circuit and come back, and the bob term — which is a
   * function of the orbit angle — turns that circuit into the up-and-down
   * flutter that identifies one at any distance. Big flap, slow beat, no CPU.
   */
  const FLUTTER_SPAN = 0.13;
  const flutterGeo = flyerGeometry({ span: FLUTTER_SPAN, body: 0.055, sweep: -0.02, girth: 1.5 });
  const flutterMat = flyerMaterial({
    name: 'butterfly',
    colour: 0xffffff,
    wander: [5, 0.7, 5],
    /**
     * OUT ON THE WING, not on the breast — which is the whole reason the mark's
     * anchor is a per-material uniform and its reach is per-instance.
     *
     * The wingtip sits at span·0.5 = 0.065 and the shoulder at 0.005, so an
     * anchor at 0.055 with a reach of 0.03 is a narrow tip flash and one of
     * 0.055 is a band down the outer half. |x| in the shader means one distance
     * test marks both wings. The 1.0 weight is the honest one here: for a
     * butterfly, sideways distance IS the wing.
     */
    mark: [0.055, 0, 0, 1.0],
  });
  const butterflies = new THREE.InstancedMesh(flutterGeo, flutterMat, BUTTERFLIES);
  butterflies.name = 'butterflies';
  butterflies.frustumCulled = false;
  butterflies.renderOrder = FAUNA_RENDER_ORDER;
  const flutterFlight = new THREE.InstancedBufferAttribute(new Float32Array(BUTTERFLIES * 4), 4);
  const flutterBeat = new THREE.InstancedBufferAttribute(new Float32Array(BUTTERFLIES * 4), 4);
  const flutterHome = new THREE.InstancedBufferAttribute(new Float32Array(BUTTERFLIES * 3), 3);
  const flutterTint = new THREE.InstancedBufferAttribute(new Float32Array(BUTTERFLIES * 3), 3);
  /**
   * The same two attributes the birds use, and they are not optional here:
   * `flyerMaterial` declares them, and an attribute a program declares but a
   * geometry does not supply reads as the constant (0, 0, 0, 1) — which for
   * aBuild is a scale of zero, so every butterfly in the wood would collapse to
   * a point. One shared shader is one shared contract.
   */
  const flutterBuild = new THREE.InstancedBufferAttribute(new Float32Array(BUTTERFLIES * 4), 4);
  const flutterMark = new THREE.InstancedBufferAttribute(new Float32Array(BUTTERFLIES * 4), 4);
  flutterGeo.setAttribute('aFlight', flutterFlight);
  flutterGeo.setAttribute('aBeat', flutterBeat);
  flutterGeo.setAttribute('aHome', flutterHome);
  flutterGeo.setAttribute('aTint', flutterTint);
  flutterGeo.setAttribute('aBuild', flutterBuild);
  flutterGeo.setAttribute('aMark', flutterMark);
  for (let i = 0; i < BUTTERFLIES; i++) {
    let x = 0;
    let z = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      const a = rng() * TAU;
      const r = 6 + Math.pow(rng(), 0.6) * 74;
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
      if (standable(x, z)) break;
    }
    flutterFlight.setXYZW(i, rngRange(rng, 1.1, 3.4), rngRange(rng, 0.5, 1.1) * (rng() < 0.5 ? -1 : 1), rng() * TAU, 0.1);
    /**
     * 0.9 of the wing's own half-span, and ~2 Hz: a butterfly claps its wings
     * almost shut.
     *
     * `aBeat.y` is a METRE offset in the shared flyer shader (see shading.js —
     * it displaces the wingtip directly, the same term a bird's 0.13-0.2 uses
     * against its 0.31 m half-span). A bare `0.9` here was that fraction
     * mistaken for the metre value itself: on a 0.13 m butterfly the wingtip
     * was swinging through most of a metre, fourteen times its own wingspan,
     * every beat. Scaling it against FLUTTER_SPAN keeps the "almost shut"
     * amplitude but in the butterfly's own units.
     */
    // A species, weighted. See WINGS.
    let pick = rng() * WINGS_TOTAL;
    let kind = WINGS[0];
    for (const k of WINGS) {
      pick -= k.w;
      if (pick <= 0) {
        kind = k;
        break;
      }
    }
    flutterBeat.setXYZW(
      i,
      rng() * TAU,
      0.9 * FLUTTER_SPAN * 0.5,
      rngRange(rng, 10, 15),
      // Size is now the species and then a few per cent of the individual,
      // which puts a common blue at two-thirds the wingspan of a peacock.
      kind.size * rngRange(rng, 0.86, 1.16)
    );
    flutterHome.setXYZ(i, x, heightAt(x, z) + rngRange(rng, 0.6, 2.4), z);
    // Butterflies are the one thing here allowed a real colour — they are the
    // only saturated object in a wood made of greens and browns, which is
    // exactly why finding one is worth anything. The lift is what keeps them
    // reading as lit from behind rather than as painted cards.
    const lift = rngRange(rng, 0.88, 1.32);
    flutterTint.setXYZ(i, kind.coat[0] * lift, kind.coat[1] * lift, kind.coat[2] * lift);
    flutterBuild.setXYZW(i, kind.build[0], kind.build[1], kind.build[2], 1);
    flutterMark.setXYZW(
      i,
      kind.mark[0] * lift,
      kind.mark[1] * lift,
      kind.mark[2] * lift,
      kind.reach * rngRange(rng, 0.85, 1.15)
    );
    butterflies.setMatrixAt(i, _m.identity());
  }
  butterflies.instanceMatrix.needsUpdate = true;
  group.add(butterflies);

  // ---- beasts -------------------------------------------------------------
  const herds = [];
  for (const [name, spec] of Object.entries(BEASTS)) {
    const { geometry, neck } = spec.build();
    const material = beastMaterial({
      name,
      neck,
      colour: spec.colour,
      pale: spec.pale,
      belly: spec.belly,
      flash: spec.flash,
      eye: spec.eye,
      trimRate: spec.trimRate,
      trimAmp: spec.trimAmp,
      bob: spec.bob,
      lung: spec.lung,
      horn: spec.horn,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, spec.count);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = FAUNA_RENDER_ORDER;
    const gait = new THREE.InstancedBufferAttribute(new Float32Array(spec.count * 4), 4);
    const tone = new THREE.InstancedBufferAttribute(new Float32Array(spec.count * 4), 4);
    /**
     * FOUR FLOATS, NOT THREE, and the fourth is how pied this one is. See the
     * pied block in shading.js — it is the one morph a whole-body multiplier
     * genuinely cannot express, and an attribute slot is four floats wide
     * whether you use three of them or four, so it is free.
     */
    const tint = new THREE.InstancedBufferAttribute(new Float32Array(spec.count * 4), 4);
    geometry.setAttribute('aGait', gait);
    geometry.setAttribute('aTone', tone);
    geometry.setAttribute('aTint', tint);
    gait.setUsage(THREE.DynamicDrawUsage);
    tone.setUsage(THREE.DynamicDrawUsage);
    tint.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(mesh);

    const members = [];
    /**
     * The cast: adults, then dams, then their young.
     *
     * The juveniles are the last `young` slots and each one's dam is the slot
     * immediately in front of the block, which is why those slots are forced
     * female rather than rolled. It is a fixed casting rather than a random one
     * because a fawn needs a mother to exist, and a coin flip that comes up
     * stag twice would leave one standing on its own looking bereaved.
     */
    const young = spec.young ?? 0;
    const firstYoung = spec.count - young;
    for (let i = 0; i < spec.count; i++) {
      const juvenile = i >= firstYoung;
      const dam = juvenile ? firstYoung - 1 - (i - firstYoung) : -1;
      const sexes = SEXES[name];
      const m = {
        pos: new THREE.Vector3(),
        anchor: new THREE.Vector3(),
        target: new THREE.Vector3(),
        yaw: rng() * TAU,
        pitch: 0,
        speed: 0,
        gait: rng() * TAU,
        state: 'graze',
        timer: rngRange(rng, 0, 6),
        alert: 0,
        alarm: 0,
        look: 0,
        lookPitch: 0,
        /**
         * SEX IS FIXED FOR THE LIFE OF THE SLOT, unlike the coat.
         *
         * Recycling is a new animal and gets a new coat and a new size for
         * exactly that reason; sex is the one thing it does not re-roll,
         * because a fawn's dam has to stay a doe and a herd that resolves to
         * four stags over five minutes of walking is not a herd. Dam slots are
         * the last index of `sexes` by convention — the female.
         */
        sex: i >= firstYoung - young && i < firstYoung ? sexes[sexes.length - 1] : sexes[Math.floor(rng() * sexes.length)],
        juvenile,
        /** Filled in below, once every member object exists. */
        parent: null,
        parentIndex: dam,
        scale: 1,
        nerve: 1,
        /** How hard it lands and how much noise it makes leaving. */
        mass: 1,
        tint: new THREE.Color(1, 1, 1),
        pied: 0,
        morph: 'ordinary',
        antler: 0,
        seed: rng(),
        stepClock: 0,
        climb: 0,
        trunk: null,
      };
      members.push(m);
    }
    /**
     * Wired BEFORE anything is placed, and that ordering is the whole reason
     * this is a second loop.
     *
     * `reseat` puts a juvenile beside its dam and falls back to the ring when
     * it has none — so placing the members as they were created would have run
     * every fawn down the ring path, spawning it up to ninety metres from its
     * mother, in frame, on the first second of the session. The placement loop
     * below then works because the dams are always at LOWER indices than their
     * young: by the time a juvenile is placed, the animal it is placed next to
     * is already standing somewhere.
     */
    for (const m of members) if (m.parentIndex >= 0) m.parent = members[m.parentIndex];
    let slot = 0;
    for (const m of members) {
      /**
       * Twice, and on purpose. `reseat` rolls a fresh identity when it succeeds
       * — that is what makes recycling produce new animals rather than moving
       * old ones — but it can fail all twenty of its attempts, and a member
       * that never got one would be a white animal at scale 1 with no coat and
       * no nerve. So: one here to guarantee a formed creature, and then whatever
       * the reseat decides. Five rng draws per member, once, at load.
       */
      individual(m, spec);
      /**
       * THE OPENING RING IS THE SPECIES' OWN DRAW DISTANCE, not a flat ninety.
       *
       * The recycler has always reseated inside `FAR * 0.7` — it knows that a
       * creature placed beyond its own draw distance is a creature that does
       * not exist. The load-time placement did not: it scattered everything out
       * to 90 m, which is fine for a deer (visible to 130) and wrong for a
       * squirrel (64), so a third of the squirrels in a fresh session spent
       * their first minutes as state machines nobody could see, waiting to be
       * recycled into existence. Same expression as the recycler's, which is
       * the point.
       *
       * AND ONE SPOKE EACH, WHICH IS THE ONLY PLACE IN THIS FILE A UNIFORM
       * RANDOM BEARING IS WRONG.
       *
       * Everywhere else the angle is drawn uniformly and that is right, because
       * those placements happen one at a time over a whole session and average
       * out. The load-time placement happens twenty times at once, and twenty
       * independent uniform draws clump — this seed put SEVEN of the ten
       * rabbits inside one eighty-degree arc, and the arc was behind the
       * player, so a fresh session opened on a wood with no rabbits in it in
       * any direction you were looking. `standable` makes it worse rather than
       * better: it rejects the river and the steep ground, so the survivors
       * concentrate in whatever quadrant happens to be walkable.
       *
       * Even spokes with a ±20° jitter cost one counter and mean the opening
       * cast is distributed around you instead of stacked in one corner of it.
       * Measured at the spawn pose, before and after: ONE of twenty ground
       * animals in frame, against eight of twenty-three.
       */
      reseat(
        m,
        spec,
        0,
        0,
        24,
        Math.min(90, FAR[name] * 0.7),
        ((slot++ + rng() * 0.6) / spec.count) * TAU
      );
    }
    const bound = geometry.boundingSphere;
    herds.push({
      name,
      spec,
      mesh,
      gait,
      tone,
      tint,
      members,
      radius: bound.radius,
      centreY: bound.center.y,
    });
  }

  /**
   * WHO THIS ONE IS: a coat, a size, a rack and the nerve that follows from all
   * three.
   *
   * Called once when the member is created and again every time the recycler
   * rehomes it, because the recycler is not moving an animal — it is deleting
   * one you have walked away from and building a different one somewhere you
   * have not been (see the re-seeding block in `updateHerd`). Treating that as
   * the same creature is what made rare morphs almost unreachable: a one-in-
   * fifteen coat rolled twenty-three times at load and never again means most
   * sessions have none at all, and the one session that does hides it in a wood
   * you may never walk into. Rolled on every recycle, a long walk eventually
   * puts a black squirrel in front of you, which is what "one in fifteen" was
   * supposed to mean.
   *
   * It is safe to re-roll here for one reason only: the recycler will not fire
   * unless the animal is out of frame. A coat that changed while you were
   * looking would be the worst artefact this system can produce.
   */
  function individual(m, spec) {
    const morph = pickMorph(rng, spec.name);
    // Nothing in here reads the name back; the capture scripts do, the same way
    // they read `__perchers`. A portrait of the wood's one black squirrel is
    // worth very little if the script cannot tell it found one.
    m.morph = morph.name;
    shade(m.tint, rng, morph.light[0], morph.light[1], morph.cast);
    m.pied = morph.pied ? rngRange(rng, morph.pied[0], morph.pied[1]) : 0;

    const base = rngRange(rng, spec.scale[0], spec.scale[1]);
    // A fawn is a fawn: the sex factor is dropped for juveniles rather than
    // multiplied in, because 0.6 × 1.14 puts a male fawn inside the doe range
    // and the one thing a juvenile has to be is unmistakably small.
    m.scale = base * (m.juvenile ? JUVENILE.size : m.sex.size);
    /**
     * SIZE IS NOT A COSMETIC HERE, and this is the line that makes it mean
     * something. Nerve is the sex's own disposition scaled by how big this
     * individual came out against the middle of its species — so the biggest
     * stag in the wood is nearly twice as steady as the smallest doe, lets you
     * closer, and holds the stare half again as long, while a small animal is
     * gone before you have focused on it. Everything downstream — the flee
     * radius, the watch timer, whether it walks off or explodes — reads this
     * one number.
     */
    const mid = (spec.scale[0] + spec.scale[1]) * 0.5;
    m.nerve = clamp(
      (m.juvenile ? JUVENILE.nerve : m.sex.nerve) * (0.55 + 0.75 * (base / mid)),
      0.5,
      1.8
    );
    /**
     * A loudness proxy for the audio, and the only lever this file has on it.
     * `wildlife.hoof` and `wildlife.bolt` take an intensity and decide the rest
     * themselves; a stag at 1.3 scale therefore lands and crashes about three
     * times as hard as a fawn at 0.55, which is roughly the mass ratio and is
     * the difference you would actually hear. Making a stag and a doe sound
     * like different ANIMALS would need a parameter on those two calls, and
     * that file is not ours.
     */
    m.mass = Math.pow(m.scale, 1.6);
    // A rack, its size scaled by how big and how old the animal is. A juvenile
    // never has one; nor does anything whose sex table says zero.
    const rack = m.juvenile ? 0 : m.sex.antler;
    m.antler = rack ? rngRange(rng, rack[0], rack[1]) * (0.72 + 0.4 * (base / mid)) : 0;
  }

  /**
   * Put a creature somewhere new: a fresh territory in a ring around a point.
   *
   * `spoke` is an optional preferred bearing, used only by the load-time
   * placement — see the block at that call for why a uniform random angle is
   * the wrong thing exactly once.
   */
  function reseat(m, spec, ax, az, minR, maxR, spoke = null) {
    /**
     * A juvenile is rehomed to its mother, not to a ring around the player.
     *
     * Without this the recycler is the one thing that can separate them: she
     * walks out of range and gets rebuilt eighty metres away, and the fawn is
     * left standing in an empty wood. It self-heals in a frame or two either
     * way — the abandoned one is now far from the player too — but "a frame or
     * two" is long enough to photograph.
     */
    if (m.parent) {
      const a = rng() * TAU;
      const r = rngRange(rng, 1.6, 4.5);
      const x = m.parent.pos.x + Math.cos(a) * r;
      const z = m.parent.pos.z + Math.sin(a) * r;
      m.anchor.set(x, heightAt(x, z), z);
      m.pos.copy(m.anchor);
      m.target.copy(m.anchor);
      m.state = 'graze';
      m.speed = 0;
      m.alert = 0;
      m.alarm = 0;
      m.timer = rngRange(rng, 1, 4);
      return true;
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      /**
       * A spoke is a preference that RELAXES rather than one that gives up.
       *
       * The cone opens from ±20° to a full circle over the twenty attempts, so
       * a bearing that points at the river is abandoned gradually and lands as
       * near to where it was wanted as the ground allows. A hard cutoff — take
       * the spoke for eight tries, then go uniform — was the first version and
       * it threw away the whole preference the moment the ideal line was wet,
       * which is exactly the case it exists for: two of five deer ended up back
       * in the same quadrant as each other.
       *
       * The radius closes in with it for the same reason. Unstandable ground in
       * this world is the stream and the cliffs, and both of those are things
       * you get to by going FURTHER — so a bearing that fails at seventy metres
       * very often works at thirty, and thirty is nearer the player anyway.
       *
       * ZERO WHEN THERE IS NO SPOKE, which matters more than it looks: `relax`
       * also shortens the radius, and starting it at one would have quietly
       * pulled every RECYCLED animal — the common case, thousands of times a
       * session — into the near half of its ring. A parameter that means "how
       * far have we given up" has to mean "not at all" when there was nothing
       * to give up on.
       */
      const relax = spoke === null ? 0 : Math.min(1, attempt / 12);
      const a =
        spoke === null
          ? rng() * TAU
          : spoke + rngRange(rng, -0.36, 0.36) + rngRange(rng, -1, 1) * relax * Math.PI;
      const r = minR + Math.pow(rng(), 0.6) * (maxR - minR) * (1 - relax * 0.55);
      const x = ax + Math.cos(a) * r;
      const z = az + Math.sin(a) * r;
      if (!standable(x, z)) continue;
      m.anchor.set(x, heightAt(x, z), z);
      m.pos.copy(m.anchor);
      m.target.copy(m.anchor);
      m.state = 'graze';
      m.speed = 0;
      m.alert = 0;
      m.alarm = 0;
      m.climb = 0;
      m.trunk = null;
      m.timer = rngRange(rng, 1, 5);
      // A different creature, not the same one moved. See `individual`.
      individual(m, spec);
      return true;
    }
    return false;
  }

  /**
   * Pick a spot to amble to inside a creature's own territory — or, for a
   * juvenile, inside a much smaller one centred on its mother.
   *
   * That substitution is the whole of "it stays near an adult". There is no
   * following behaviour, no leash and no extra state: a fawn grazes in a four
   * metre circle that happens to be wherever the doe is standing, so it drifts
   * with her by construction and looks exactly like an animal keeping an eye on
   * its mother.
   */
  function graze(m, spec) {
    const about = m.parent ? m.parent.pos : m.anchor;
    const reach = spec.territory * (m.parent ? JUVENILE.territory : 1);
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = rng() * TAU;
      const r = Math.pow(rng(), 0.5) * reach;
      const x = about.x + Math.cos(a) * r;
      const z = about.z + Math.sin(a) * r;
      if (!standable(x, z)) continue;
      m.target.set(x, heightAt(x, z), z);
      return;
    }
    m.target.copy(about);
  }

  // ---- midges and fireflies ----------------------------------------------
  /**
   * Midges go in the sun shafts, which are real objects with real coordinates —
   * so the swarm is found by asking the scene for them rather than by
   * re-deriving where they were scattered. A column of gnats hanging in a beam
   * of light is the single most specific "this is a summer wood" image there is,
   * and it only works if the two are in the same place to the centimetre.
   *
   * If the shafts are ever renamed or removed this falls back to seeded gaps,
   * because a hard dependency on another agent's object graph is not worth an
   * exception on a first frame.
   */
  const SWARM = MIDGES + FIREFLIES;
  const swarmPos = new Float32Array(SWARM * 3);
  const swarmSeed = new Float32Array(SWARM);
  const swarmKind = new Float32Array(SWARM);
  const swarmSpan = new Float32Array(SWARM * 3);

  const shaftGroup = scene.getObjectByName('shafts');
  const columns = [];
  if (shaftGroup) {
    for (const mesh of shaftGroup.children) {
      const params = mesh.geometry?.parameters;
      if (!params) continue;
      columns.push({
        x: mesh.position.x,
        y: mesh.position.y + params.height * 0.28,
        z: mesh.position.z,
        /**
         * MUCH tighter than the shaft it hangs in, and this is the whole
         * difference between midges and dust. The first version took the
         * beam's own radius and a fifth of its length, which gave a cloud three
         * metres across and six tall — and a loose cloud of bright specks in a
         * forest is indistinguishable from the mote field that is already
         * there. A real column is knee-high and about as wide as your hand,
         * and it is the DENSITY that identifies it: forty insects inside a
         * volume you could put your arms round.
         */
        r: Math.min(1.0, Math.max(0.32, (params.radiusBottom ?? 2) * 0.2)),
        h: 0.85,
      });
    }
  }
  while (columns.length < 12) {
    const a = rng() * TAU;
    const r = 8 + Math.pow(rng(), 0.6) * 70;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    columns.push({ x, y: heightAt(x, z) + rngRange(rng, 1.6, 4.5), z, r: 0.55, h: 0.85 });
  }
  for (let i = 0; i < MIDGES; i++) {
    const c = columns[i % columns.length];
    swarmPos[i * 3] = c.x + rngRange(rng, -c.r, c.r) * 0.4;
    swarmPos[i * 3 + 1] = c.y + rngRange(rng, -c.h, c.h) * 0.5;
    swarmPos[i * 3 + 2] = c.z + rngRange(rng, -c.r, c.r) * 0.4;
    swarmSpan[i * 3] = c.r;
    swarmSpan[i * 3 + 1] = c.h;
    swarmSpan[i * 3 + 2] = c.r;
    swarmSeed[i] = rng();
    swarmKind[i] = 0;
  }
  for (let i = 0; i < FIREFLIES; i++) {
    const k = MIDGES + i;
    let x = 0;
    let z = 0;
    /**
     * The damp low ground, near the water and in the hollows — which is where
     * they actually are, and is also where this world is darkest.
     *
     * With a THIRD OF THEM ANYWHERE, and that is not a compromise. The strict
     * version put a hundred within forty metres of the stream and exactly one
     * in the high dry wood, so a player who happened to be up on the slope at
     * dusk saw none at all and concluded there were none. A gradient of density
     * is a place; an all-or-nothing boundary is a trigger volume.
     */
    for (let attempt = 0; attempt < 20; attempt++) {
      const a = rng() * TAU;
      const r = 6 + Math.pow(rng(), 0.5) * 92;
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
      if (!standable(x, z)) continue;
      if (wetness(x, z) > 0.12 || heightAt(x, z) < 6 || rng() < 0.34) break;
    }
    swarmPos[k * 3] = x;
    swarmPos[k * 3 + 1] = heightAt(x, z) + rngRange(rng, 0.4, 3.2);
    swarmPos[k * 3 + 2] = z;
    swarmSpan[k * 3] = 1.4;
    swarmSpan[k * 3 + 1] = 0.9;
    swarmSpan[k * 3 + 2] = 1.4;
    swarmSeed[k] = rng();
    swarmKind[k] = 1;
  }
  const swarmGeo = new THREE.BufferGeometry();
  swarmGeo.setAttribute('position', new THREE.BufferAttribute(swarmPos, 3));
  swarmGeo.setAttribute('aSeed', new THREE.BufferAttribute(swarmSeed, 1));
  swarmGeo.setAttribute('aKind', new THREE.BufferAttribute(swarmKind, 1));
  swarmGeo.setAttribute('aSwarm', new THREE.BufferAttribute(swarmSpan, 3));
  const swarmMat = swarmMaterial(glowSprite({ key: 'midge', inner: 'rgba(255,250,226,0.95)' }));
  // gl_PointSize is in device pixels, so the ratio has to come from somewhere.
  // main.js's resize() owns the authoritative value and calls setPixelRatio;
  // this is what the first frame renders at before it does.
  swarmMat.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio ?? 1, 1.4);
  const swarm = new THREE.Points(swarmGeo, swarmMat);
  swarm.name = 'swarm';
  swarm.frustumCulled = false;
  swarm.renderOrder = 5;
  group.add(swarm);

  // -------------------------------------------------------------------------
  // the loop
  // -------------------------------------------------------------------------

  let elapsed = 0;

  /**
   * Is this point in the frame? Used to decide when a creature may be moved,
   * NOT to decide when it may be drawn — a creature that teleports while you
   * are looking at it is the worst artefact this system can produce, and the
   * whole "you glimpsed it and now it is gone" effect depends on the move being
   * unobservable.
   */
  function unseen(p, radius) {
    _sphere.center.copy(p);
    _sphere.radius = radius;
    return !_frustum.intersectsSphere(_sphere);
  }

  function updatePerchers(dt, camera, tripLevel) {
    for (const p of perchers) {
      const dx = p.pos.x - camera.position.x;
      const dz = p.pos.z - camera.position.z;
      const dist = Math.hypot(dx, dz);

      /**
       * Move a bird you have walked away from, not only one you frightened.
       *
       * The only recycle a percher had was at the end of a flush: startle it
       * inside nine metres, it flies, and it lands somewhere near you. That is
       * a complete answer for a world 180 m across and no answer at all for an
       * endless one — walk a kilometre without frightening anything and all
       * twenty-six of them are still in the trees around the spawn clearing,
       * singing to nobody, while the wood you are actually standing in has no
       * birds in it.
       *
       * PERCH_FAR is past the 95 m the flush itself re-seats within, so this
       * cannot fight with that; and it only ever fires while the bird is out of
       * frame, so what the player sees is a bird that was always there.
       */
      const PERCH_FAR = 150;
      if (dist > PERCH_FAR && p.state === 'perch' && unseen(p.pos, 2)) {
        if (pickPerch(p.home, camera.position.x, camera.position.z, 26, 95) && unseen(p.home, 2)) {
          p.pos.copy(p.home);
          p.timer = rngRange(rng, 1, 5);
          p.sing = rngRange(rng, 10, 45) * (p.hen ? 2.3 : 1);
          continue;
        }
      }

      if (p.state === 'perch') {
        /**
         * THE STARTLE RADIUS IS THE ENTIRE DESIGN OF THIS CREATURE.
         *
         * Too big and birds explode out of trees fifteen metres away, which
         * reads as a scripted trigger; too small and you walk through them.
         * Nine metres is about where a real bird goes — close enough that it is
         * unmistakably a reaction to you, far enough that you never touch one.
         */
        const startle = 9;
        if (dist < startle) {
          /**
           * THE ONE THAT DOES NOT LEAVE.
           *
           * "A bird that becomes impossibly attentive to you." At the peak the
           * watcher simply stops flushing — you walk right up to it and it turns
           * its head and stays. It is a two-line change and it is the single
           * most unsettling thing in this file, because every other bird in the
           * wood has spent the last five minutes teaching you that they leave.
           */
          if (p.watcher && tripLevel > 0.3) {
            p.yaw = Math.atan2(camera.position.x - p.pos.x, camera.position.z - p.pos.z);
          } else {
            p.state = 'flee';
            p.timer = 0;
            // Away from you, upward, and biased along whatever direction it was
            // already facing — a bird does not reverse out of a bush.
            const away = Math.atan2(dx, dz) + rngRange(rng, -0.5, 0.5);
            // A heavy bird gets away faster once it is going and climbs less
            // steeply doing it; a goldcrest flicks off the branch and is gone
            // vertically. Both are the species' size, once, at the launch.
            const v = rngRange(rng, 6.5, 9) * (0.82 + 0.28 * p.scale);
            p.vel.set(
              Math.sin(away) * v,
              rngRange(rng, 3.4, 5.2) * (1.22 - 0.28 * p.scale),
              Math.cos(away) * v
            );
            p.yaw = away;
            wildlife?.flush(p.pos, clamp01(1 - dist / startle), p.voice);
          }
        } else {
          // Idle: a hop and a look about, at long random intervals.
          p.timer -= dt;
          if (p.timer <= 0) {
            p.timer = rngRange(rng, 2.5, 9);
            p.yaw += rngRange(rng, -1.4, 1.4);
          }
        }

        p.sing -= dt * (p.watcher ? 1.6 : 1);
        if (p.sing <= 0) {
          // Only sing where you might hear it. A song scheduled at 140 m is
          // audio nodes spent on silence.
          if (dist < 62) wildlife?.song(p.pos, p.voice, { answer: true });
          /**
           * 16–70 s, up from 5–26, AND THE POINT IS NOT THAT IT IS QUIETER.
           *
           * 26 perching birds on a 15.5 s mean timer is ~100 song attempts a
           * minute — a call every 0.6 s, which is a dawn chorus running
           * permanently at mid-morning. `wildlife.js` already refuses most of
           * them through its leaky bucket, so the audible rate was already far
           * below this; what the bucket cannot do is choose WHICH ones to drop.
           * The bird three metres from you competed for a token with
           * twenty-five you cannot see, and lost most of the time.
           *
           * Asking less often at the source means a bird that decides to sing
           * actually sings. The bucket's refill was raised in step
           * (SONG_REFILL 0.15 -> 0.3) so the total rate is roughly unchanged —
           * this is the same amount of birdsong, distributed by proximity
           * instead of by lottery.
           *
           * AND THE HEN DOES NOT SING. In nearly every species in that voice
           * table the song is the male's; the female calls now and then and
           * otherwise stays quiet. So half the perchers are on a timer two and
           * a bit times longer, which is not primarily a saving — it is that
           * the bird that IS singing is now somebody in particular rather than
           * a uniform field of birdsong with twenty-six sources. The rate the
           * player hears barely moves, because the bucket in wildlife.js was
           * already refusing most of the demand.
           */
          p.sing = rngRange(rng, 16, 70) * (p.hen ? 2.3 : 1);
        }
        // Sitting still, wings folded, with a shuffle you can only see close up.
        p.open = damp(p.open, 0.04, 0.001, dt);
        birdBeat.setXYZW(
          p.slot,
          p.beat,
          0.02 + 0.03 * Math.max(0, Math.sin(elapsed * 1.7 + p.beat * 3)),
          3.0 * p.wing,
          p.scale
        );
      } else {
        p.timer += dt;
        // Gravity and drag, and a slow curve away: a small bird's escape is a
        // burst, an arc and then a glide, which is three lines of physics.
        p.vel.y += (-9.0 + 16 * clamp01(1 - p.timer * 1.2)) * dt;
        p.vel.multiplyScalar(Math.exp(-0.55 * dt));
        p.pos.addScaledVector(p.vel, dt);
        p.yaw = Math.atan2(p.vel.x, p.vel.z);
        const hammering = clamp01(1.5 - p.timer);
        // The wings snap open in about a tenth of a second — a bird leaving a
        // branch is spread before it has travelled its own length.
        p.open = damp(p.open, 1, 1e-8, dt);
        // `p.wing` on the RATE only. The amplitude is in metres at the tip and
        // the shader already shrinks it by the species' span, so scaling it
        // here as well would give a wood pigeon a wingbeat you could not see.
        birdBeat.setXYZW(
          p.slot,
          p.beat,
          0.12 + hammering * 0.5,
          (16 + hammering * 16) * p.wing,
          p.scale
        );
        const gone = p.timer > 4.5 || p.pos.y > heightAt(p.pos.x, p.pos.z) + 46;
        if (gone) {
          pickPerch(p.home, camera.position.x, camera.position.z, 26, 95);
          if (unseen(p.home, 2)) {
            p.pos.copy(p.home);
            p.state = 'perch';
            p.timer = rngRange(rng, 1, 5);
            p.sing = rngRange(rng, 10, 45) * (p.hen ? 2.3 : 1);
          } else {
            // Keep flying until there is somewhere to land that you are not
            // watching. Cheaper than a fade and completely invisible.
            p.timer = 3.6;
          }
        }
      }

      // Radius 0 selects the instanceMatrix branch in the shader; the second
      // slot is the wing spread there rather than an angular speed.
      birdFlight.setXYZW(p.slot, 0, p.open, 0, 0);
      _v.copy(p.pos);
      _e.set(0, p.yaw, 0);
      _q.setFromEuler(_e);
      _scale.setScalar(1);
      birds.setMatrixAt(p.slot, _m.compose(_v, _q, _scale));
    }
    /**
     * Only the perchers' range is uploaded. The flock's slots were written once
     * at load and the shader has been deriving their flight from the clock ever
     * since, so re-sending 96 identity matrices every frame would be pure bus
     * traffic — this is the same `addUpdateRange` idiom the instance culler
     * uses, for the same reason.
     */
    birds.instanceMatrix.clearUpdateRanges();
    birds.instanceMatrix.addUpdateRange(FLOCK_BIRDS * 16, PERCHERS * 16);
    birds.instanceMatrix.needsUpdate = true;
    birdBeat.clearUpdateRanges();
    birdBeat.addUpdateRange(FLOCK_BIRDS * 4, PERCHERS * 4);
    birdBeat.needsUpdate = true;
    birdFlight.clearUpdateRanges();
    birdFlight.addUpdateRange(FLOCK_BIRDS * 4, PERCHERS * 4);
    birdFlight.needsUpdate = true;
  }

  function updateHerd(herd, dt, camera, tripLevel) {
    const { spec, members, mesh, gait, tone, tint } = herd;
    const eye = camera.position;
    let write = 0;

    for (const m of members) {
      const dx = m.pos.x - eye.x;
      const dz = m.pos.z - eye.z;
      const dist = Math.hypot(dx, dz);

      /**
       * THE TRIP DOES NOT ADD A CREATURE OR A COLOUR. IT CHANGES THE ANIMAL'S
       * MIND.
       *
       * "Your perception of everything is exaggerated… you also get confused."
       * The nearest thing to that in an animal is one that will not do what an
       * animal does. So the deer notices you from further off, lets you get much
       * closer, and above all *watches for far longer* — up to four times as
       * long at the peak, which turns two seconds of eye contact into eight or
       * nine. Nothing is drawn that was not drawn before; the encounter simply
       * refuses to end, which is a much more specific and much more disturbing
       * effect than making it glow.
       */
      const boldness = 1 + tripLevel * 1.6;
      const noticeR = spec.notice * (1 + tripLevel * 0.5);
      /**
       * AND THE ANIMAL'S OWN NERVE, WHICH IS WHERE ITS SIZE AND ITS SEX ARRIVE.
       *
       * One divide, and it is the whole of "a bigger deer is bolder". A heavy
       * stag at nerve 1.5 lets you inside nine metres; a small doe at 0.9 is
       * gone at sixteen; a fawn at 0.55 goes at twenty-five. Standing still in
       * one place and watching two deer react differently to the same approach
       * is the thing that says these are individuals rather than instances, and
       * it is the same shape of multiplier the trip already applies — which is
       * deliberate, because the trip's effect is then legibly "every animal in
       * the wood is behaving like the boldest one".
       */
      const fleeR = spec.flee / boldness / m.nerve;

      /**
       * A JUVENILE GOES WHEN ITS MOTHER GOES.
       *
       * Not when it decides to — it is too young to have decided anything, and
       * the image the whole feature exists for is the pair leaving together
       * with the small one a beat behind. Four lines and no new state: it is
       * put into whatever she is doing, and the walk/bolt case below points its
       * target at her every frame instead of away from you.
       */
      if (m.parent && (m.parent.state === 'bolt' || m.parent.state === 'walk')) {
        if (m.state === 'graze' || m.state === 'watch') {
          m.state = m.parent.state;
          m.timer = m.parent.timer + rngRange(rng, 0.2, 0.8);
          m.target.copy(m.parent.pos);
        }
      }

      switch (m.state) {
        case 'graze': {
          m.alert = damp(m.alert, 0, 0.02, dt);
          m.alarm = damp(m.alarm, 0, 0.01, dt);
          m.timer -= dt;
          if (m.timer <= 0) {
            graze(m, spec);
            m.timer = rngRange(rng, 3, 11);
          }
          /**
           * Head down and up again. Positive pitch is nose-DOWN in the shader's
           * rotation, and the alternation is what says "eating" rather than
           * "idling" — a grazing animal spends most of its time with its face in
           * the grass and looks up every few seconds, which is also why walking
           * up to one works at all.
           */
          m.lookPitch = damp(
            m.lookPitch,
            Math.sin(elapsed * 0.31 + m.seed * 9) > 0.2 ? 0.62 : 0.06,
            0.1,
            dt
          );
          m.look = damp(m.look, 0, 0.2, dt);
          approach(m, spec.speed.graze, dt);
          if (dist < noticeR) {
            m.state = 'watch';
            // Nerve again: the big steady animal holds the stare half again as
            // long as the average and the jumpy one barely holds it at all,
            // which is what turns "it looked at me" into "it sized me up".
            m.timer =
              rngRange(rng, spec.watch[0], spec.watch[1]) * (1 + tripLevel * 3) * m.nerve;
          }
          break;
        }
        case 'watch': {
          m.speed = damp(m.speed, 0, 0.001, dt);
          m.alert = damp(m.alert, 1, 0.02, dt);
          m.alarm = damp(m.alarm, dist < fleeR * 1.5 ? 1 : 0, 0.05, dt);
          // The head goes round to you, and the body does not. That difference
          // is the whole of "it is watching me".
          faceHead(m, eye, dt);
          m.timer -= dt;
          if (dist > noticeR * 1.35) {
            m.state = 'graze';
            m.timer = 1;
          } else if (dist < fleeR) {
            /**
             * WHEN A BOLD ANIMAL FINALLY GOES, IT GOES.
             *
             * The threshold used to be a flat 0.6 of the flee radius, so
             * everything trotted away unless you were nearly on top of it. A
             * steady animal has already let you much closer by the time it
             * moves — that is what its small flee radius means — so the
             * fraction is widened for it and the choice comes out the other
             * way: the stag that stood and watched you for six seconds does
             * not amble off, he leaves at eight metres a second.
             *
             * It is also one of two levers this file has on the deer's VOICE.
             * `wildlife.bolt` fires the bark, and only on a bolt — so a stag
             * barks several times as often as a doe does, and the bark is what
             * you remember about the encounter.
             */
            const hard = dist < fleeR * (m.nerve > 1.15 ? 0.95 : 0.6);
            m.state = hard ? 'bolt' : 'walk';
            m.timer = hard ? rngRange(rng, 2.2, 4.5) : rngRange(rng, 3, 6);
            if (hard) {
              /**
               * The second lever, and mass goes as ITS OWN ARGUMENT now.
               *
               * It used to be multiplied into the nearness term, because that
               * was the only channel available and a quiet bolt is at least in
               * the right direction. But quiet means FAR, not small: a fawn at
               * five metres came out sounding like an adult at thirty, and the
               * panner and the startle hush both agreed with it. `bolt` takes
               * the two apart — nearness moves the level, mass moves the pitch
               * of the throat, the length of the crash and the size of the
               * silence afterwards.
               */
              wildlife?.bolt(m.pos, herd.name, clamp01(1 - dist / (fleeR * 2)), m.mass);
              if (herd.name === 'squirrel') m.trunk = trunks.near(m.pos.x, m.pos.z, 22);
            }
            fleeFrom(m, eye, spec.territory * (hard ? 3.2 : 1.6));
          } else if (m.timer <= 0) {
            // It decided you were not worth the trouble. Deeply anticlimactic,
            // and it is the reason the ones that DO run mean anything.
            m.state = 'graze';
            m.timer = rngRange(rng, 2, 6);
          }
          break;
        }
        case 'walk':
        case 'bolt': {
          const running = m.state === 'bolt';
          m.alert = damp(m.alert, running ? 0.2 : 0.6, 0.02, dt);
          m.alarm = damp(m.alarm, 0, 0.02, dt);
          // Nose up while running, level while walking away.
          m.lookPitch = damp(m.lookPitch, running ? -0.16 : 0.04, 0.05, dt);
          m.look = damp(m.look, 0, 0.05, dt);
          approach(m, running ? spec.speed.bolt : spec.speed.walk, dt);
          m.timer -= dt;
          // A juvenile is not running from you, it is running AFTER HER. Same
          // state, same speeds, a target that moves — and the difference is
          // completely legible from twenty metres because the two animals end
          // up going the same way instead of scattering.
          if (m.parent) m.target.copy(m.parent.pos);
          else if (m.pos.distanceToSquared(m.target) < 4) fleeFrom(m, eye, spec.territory * 2);
          /**
           * A SQUIRREL DOES NOT RUN AWAY, IT RUNS UP.
           *
           * And that is the best disappearing act available, because a trunk
           * hides it from you completely without the animal ever leaving:
           * it spirals as it climbs, so it goes round the far side and is simply
           * not there when you get to the tree. You cannot follow it and there
           * is nothing to find. Every other creature here leaves by getting
           * small; this one leaves by getting hidden.
           */
          if (m.trunk && running) {
            const td = Math.hypot(m.pos.x - m.trunk.x, m.pos.z - m.trunk.z);
            if (td < m.trunk.r + 0.6) {
              m.state = 'climb';
              m.timer = 0;
              m.climb = 0;
            }
          }
          if (m.timer <= 0) {
            m.state = 'graze';
            m.anchor.copy(m.pos);
            m.timer = rngRange(rng, 2, 5);
            m.trunk = null;
          }
          break;
        }
        case 'climb': {
          m.climb += dt;
          const a = m.climb * 3.1 + m.seed * 6;
          const reach = m.trunk.r + 0.09;
          m.pos.set(
            m.trunk.x + Math.cos(a) * reach,
            heightAt(m.trunk.x, m.trunk.z) + m.climb * 3.4,
            m.trunk.z + Math.sin(a) * reach
          );
          // Facing up the trunk, nose first.
          m.yaw = a + Math.PI * 0.5;
          m.pitch = -1.15;
          m.speed = 3.4;
          m.alert = damp(m.alert, 0, 0.02, dt);
          if (m.climb > 2.6) {
            reseat(m, spec, eye.x, eye.z, 30, 78);
            m.pitch = 0;
          }
          break;
        }
        default:
          break;
      }

      if (m.state !== 'climb') {
        m.pitch = damp(m.pitch, 0, 0.02, dt);
        m.pos.y = heightAt(m.pos.x, m.pos.z);
      }

      /**
       * Re-seeding is the population control, and it is why twenty-odd animals feel
       * like a wood full of them. A creature that has got a long way off and is
       * out of the frame is deleted and rebuilt somewhere you have not been —
       * so you are never more than a minute's walk from an encounter and the
       * scene never contains more than twenty-three state machines.
       */
      /**
       * OR IF IT HAS LOST ITS MOTHER, which recycling is the only thing that
       * can do to it: she gets rebuilt eighty metres away and the fawn is left
       * standing in a wood on its own. Twenty-six metres is well outside the
       * nine or ten a fawn ever grazes at, so this cannot fire on a pair that
       * is merely spread out, and like everything else here it waits until it
       * is unobserved. `reseat` puts a juvenile beside its dam rather than in
       * the ring, so the arguments are ignored on that path.
       */
      const strayed = m.parent && m.pos.distanceToSquared(m.parent.pos) > 26 * 26;
      if (
        (dist > FAR[herd.name] * 0.8 || strayed) &&
        unseen(m.pos, herd.radius * m.scale)
      ) {
        reseat(m, spec, eye.x, eye.z, 32, FAR[herd.name] * 0.7);
      }

      // Gait: phase advances with distance travelled, so the feet cannot skate.
      m.gait += (m.speed / (spec.stride * m.scale)) * TAU * dt;
      if (m.gait > 1e5) m.gait -= 1e5;
      const stride = clamp((m.speed / spec.speed.bolt) * 0.85, 0, 0.8);

      // Footfalls, for the audio. One per half stride, only when close enough
      // to matter and only for something heavy enough to be heard.
      if (wildlife && m.speed > 0.9 && dist < 26) {
        m.stepClock += (m.speed / (spec.stride * m.scale)) * dt * 2;
        if (m.stepClock >= 1) {
          m.stepClock -= 1;
          /**
           * Effort and mass, separately, for the same reason `bolt` wants them
           * apart: the first argument is how hard THIS step came down and the
           * second is how big the thing putting it down is. Folded together, a
           * fawn at a flat gallop was indistinguishable from an adult walking,
           * which is exactly backwards — the fawn is the one you hear skittering.
           *
           * The stride clock above is already divided by the animal's scale, so
           * a small one takes quicker steps as well as lighter ones, and the two
           * cues arrive together.
           */
          wildlife.hoof(m.pos, herd.name, clamp01(m.speed / spec.speed.bolt), m.mass);
        }
      }

      // ---- draw ----
      if (dist > FAR[herd.name]) continue;
      _v.copy(m.pos);
      _sphere.center.copy(_v);
      _sphere.center.y += herd.centreY * m.scale;
      // Generous: the rig moves vertices the bounding sphere was computed
      // without, and a deer whose antlers pop at the edge of the frame is a
      // worse bug than one extra sphere test passing.
      _sphere.radius = herd.radius * m.scale * 1.3;
      if (!_frustum.intersectsSphere(_sphere)) continue;

      _e.set(m.pitch, m.yaw, 0);
      _q.setFromEuler(_e);
      _scale.setScalar(m.scale);
      mesh.setMatrixAt(write, _m.compose(_v, _q, _scale));
      gait.setXYZW(write, m.gait, stride, m.look, m.lookPitch);
      tone.setXYZW(write, m.antler, m.alert, m.seed, m.alarm);
      /**
       * THE COAT GOES IN THE DRAW SLOT, NOT THE MEMBER SLOT, AND THAT WAS A BUG.
       *
       * `write` is a COMPACTED index — it counts only the members that survived
       * this frame's distance and frustum tests, so member three draws in slot
       * zero whenever the first three were culled. The matrix, the gait and the
       * tone were all written that way and the tint was not: it was written
       * once at load at the member's own index and left there, which meant an
       * animal wore whatever coat belonged to the slot it happened to land in
       * and swapped coats whenever another one walked out of frame.
       *
       * It was nearly invisible while every tint was a lightness between 0.8
       * and 1.28 — the symptom is a deer subtly changing brightness, which
       * reads as lighting. With morphs in the table it would have been the
       * black squirrel teleporting between individuals, which is how the bug
       * was found. Three floats a frame per drawn animal, against a maximum of
       * twenty.
       */
      tint.setXYZW(write, m.tint.r, m.tint.g, m.tint.b, m.pied);
      write++;
    }

    mesh.count = write;
    if (write > 0) {
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, write * 16);
      mesh.instanceMatrix.needsUpdate = true;
      gait.clearUpdateRanges();
      gait.addUpdateRange(0, write * 4);
      gait.needsUpdate = true;
      tone.clearUpdateRanges();
      tone.addUpdateRange(0, write * 4);
      tone.needsUpdate = true;
      tint.clearUpdateRanges();
      tint.addUpdateRange(0, write * 4);
      tint.needsUpdate = true;
    }
  }

  /** Walk toward the current target, turning rather than sliding. */
  function approach(m, speed, dt) {
    _v2.set(m.target.x - m.pos.x, 0, m.target.z - m.pos.z);
    const d = _v2.length();
    if (d < 0.4) {
      m.speed = damp(m.speed, 0, 0.01, dt);
      return;
    }
    _v2.multiplyScalar(1 / d);
    const want = Math.atan2(_v2.x, _v2.z);
    // Turn at a rate, and only move at full pace once roughly pointed the right
    // way. An animal that strafes is a sprite with a velocity.
    const turn = wrapAngle(want - m.yaw);
    m.yaw += clamp(turn, -3.4 * dt, 3.4 * dt);
    m.speed = damp(m.speed, speed * (1 - clamp01(Math.abs(turn) / 2.2) * 0.75), 0.05, dt);
    m.pos.x += Math.sin(m.yaw) * m.speed * dt;
    m.pos.z += Math.cos(m.yaw) * m.speed * dt;
    // The world's edges are real. Sliding into the river or up a cliff would be
    // the fauna version of a floating tree.
    if (!standable(m.pos.x, m.pos.z)) {
      m.pos.x -= Math.sin(m.yaw) * m.speed * dt;
      m.pos.z -= Math.cos(m.yaw) * m.speed * dt;
      m.yaw += 1.9;
      m.target.copy(m.anchor);
    }
  }

  /** Head down and away from a point, to somewhere it can actually stand. */
  function fleeFrom(m, from, range) {
    const away = Math.atan2(m.pos.x - from.x, m.pos.z - from.z);
    for (let attempt = 0; attempt < 10; attempt++) {
      const a = away + rngRange(rng, -0.7, 0.7);
      const r = range * rngRange(rng, 0.6, 1.2);
      const x = m.pos.x + Math.sin(a) * r;
      const z = m.pos.z + Math.cos(a) * r;
      if (!standable(x, z)) continue;
      m.target.set(x, heightAt(x, z), z);
      return;
    }
    m.target.set(m.pos.x + Math.sin(away) * 6, m.pos.y, m.pos.z + Math.cos(away) * 6);
  }

  /** Turn the head — and only the head — toward a point. */
  function faceHead(m, at, dt) {
    const want = wrapAngle(Math.atan2(at.x - m.pos.x, at.z - m.pos.z) - m.yaw);
    /**
     * Clamped to about 100°, because a neck has a limit and an animal that
     * exceeds it is a horror rather than a deer. Past the limit it gives up on
     * the head and swings its whole body round — which is exactly what a real
     * one does, and is a far stronger signal that it is tracking you than any
     * amount of extra neck would be.
     */
    const limit = 1.75;
    if (Math.abs(want) > limit) m.yaw += clamp(want, -1.2 * dt, 1.2 * dt);
    m.look = damp(m.look, clamp(want, -limit, limit), 0.02, dt);
    // Negative pitch is nose-up, and the player's eye is 1.7 m off the ground,
    // so anything smaller than a deer spends the encounter looking upward.
    const flat = Math.max(3, Math.hypot(at.x - m.pos.x, at.z - m.pos.z));
    const rise = clamp((at.y - m.pos.y - 0.9) / flat, -0.3, 0.75);
    m.lookPitch = damp(m.lookPitch, -rise, 0.02, dt);
  }

  const api = {
    group,
    birds,
    butterflies,
    herds,
    swarm,
    /** For the capture scripts, which need to pin a subject to photograph it. */
    __perchers: perchers,
    /**
     * Audio only exists after the user clicks through the gate, so the world is
     * built without it and told about it later — see main.js. `music` is
     * optional and is what lets the birdsong find the jukebox's key during a
     * trip; without it the birds simply sing in their own tuning.
     */
    attachAudio(engine, music = null) {
      if (!engine?.ready || wildlife) return;
      wildlife = new Wildlife(engine);
      wildlife.build();
      wildlife.setMusic(music);
    },
    /**
     * @param {number} dt   seconds; pass 0 to freeze, as main.js does for the
     *                      wind, so `isolate.mjs` can hold the world still.
     * @param {object} p
     * @param {THREE.Camera} p.camera
     * @param {number} p.tripLevel  0..1
     * @param {number} [p.timeOfDay] 0 = midnight, 0.5 = noon. Defaults to the
     *                               world clock, which is what the game passes
     *                               by passing nothing.
     */
    update(dt, { camera, tripLevel = 0, timeOfDay = null } = {}) {
      if (!camera) return;
      elapsed += dt;

      /**
       * Everything below places creatures relative to HERE, not to the origin.
       *
       * One assignment, and it is what turns the recycling that was already in
       * this file into a world that is alive wherever you are. See `standable`.
       */
      roamX = camera.position.x;
      roamZ = camera.position.z;
      followFlocks(camera.position.x, camera.position.z);

      _proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_proj);

      /**
       * Dusk, AND THERE IS A CLOCK NOW.
       *
       * The paragraph that used to be here explained that the world had one
       * fixed mid-morning sun, that `timeOfDay` therefore defaulted to noon,
       * and that a trip was consequently the only thing in the build that could
       * ever bring a firefly out. That was true and it was the right stopgap;
       * `daylight.js` is the thing it was waiting for.
       *
       * THE DERIVATION MOVED TO THE CLOCK, AND IT HAD TO. The old one was
       * `smoothstep((|tod − 0.5|·2 − 0.55) / 0.3)`, which reaches full dark only
       * outside |tod − 0.5| > 0.425 — a night 15% of the cycle long. The real
       * arc has the sun below the horizon for 42% of it, so keeping the old
       * curve would have had the fireflies waiting an hour and a half of world
       * time after sunset while the wildlife roster, reading the clock's own
       * `dark`, had already sent the crows to roost and started the owl. Two
       * files disagreeing about what time it is, in a way that only shows up as
       * "the fireflies feel late".
       *
       * `timeOfDay` survives as an override because `fauna-shot.mjs` and
       * `fauna-pose.mjs` pass it to photograph the swarm at a chosen hour, and
       * 0.5 still means noon in both curves.
       *
       * The MAX against the trip is kept exactly as it was: a trip is still the
       * other thing that darkens a wood, and a canopy closing over at two in
       * the afternoon should still bring them out. What it can no longer do is
       * make midnight brighter.
       */
      const phase = timeOfDay === null ? dayPhase() : timeOfDay;
      const daylight = daylightAt(phase);
      const dark = Math.max(darkAt(phase), tripLevel * 0.65);
      const dusk = swarmMat.uniforms.uDusk.value;
      dusk.x = damp(dusk.x, daylight * (1 + tripLevel * 0.6), 0.2, dt);
      dusk.y = damp(dusk.y, dark, 0.2, dt);

      updatePerchers(dt, camera, tripLevel);
      for (const herd of herds) updateHerd(herd, dt, camera, tripLevel);

      wildlife?.update(dt, {
        tripLevel,
        dark,
        listener: camera.position,
      });
    },
    /** Points are sized in pixels, so they need the ratio the renderer is at. */
    setPixelRatio(r) {
      swarmMat.uniforms.uPixelRatio.value = r;
    },
    dispose() {
      scene.remove(group);
      birdGeo.dispose();
      birdMat.dispose();
      flutterGeo.dispose();
      flutterMat.dispose();
      swarmGeo.dispose();
      swarmMat.dispose();
      for (const herd of herds) {
        herd.mesh.geometry.dispose();
        herd.mesh.material.dispose();
      }
      wildlife?.dispose();
    },
  };

  // The normal path is main.js calling attachAudio after the gate; this covers
  // the case where a caller already had a running engine to hand.
  if (audio?.ready) api.attachAudio(audio);
  return api;
}
