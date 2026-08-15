import * as THREE from 'three';
import { TAU, clamp, clamp01, damp, lerp, makeRng, rngRange, wrapAngle } from '../core/util.js';
import { WORLD_RADIUS, heightAt, slopeAt, wetness } from './terrain.js';
import { colliderGrid } from './forest.js';
import { glowSprite } from './textures.js';
import {
  tapirGeometry,
  flyerGeometry,
  flutterGeometry,
  agoutiGeometry,
  capuchinGeometry,
} from './fauna/shapes.js';
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
 *   of birds that sang like a toucan and looked like nothing. A manakin is
 *   tiny, a tinamou is big and round, a toucan is black with a yellow bib, a
 *   quetzal trails half a metre of tail — matched to the voice, through two instanced
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
const FAR = { tapir: 130, agouti: 78, capuchin: 64 };

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
/** Whichever observer an animal is currently reacting to. See `nearestEye`. */
const _eye = new THREE.Vector3();

/**
 * How wide a cone counts as "somebody is looking that way", in cosine.
 *
 * 0.34 is about 70° off their forward — half again the horizontal half-angle of
 * the game's camera. Deliberately generous, because this number only ever
 * decides whether an animal is allowed to TELEPORT, and the two errors are not
 * remotely symmetric: too wide and a recycle waits a few seconds longer than it
 * needed to, which nobody can see; too narrow and a deer vanishes in somebody's
 * peripheral vision, which is the single worst artefact this system can produce.
 *
 * A cone and not a frustum because a frustum needs a projection matrix, and what
 * arrives over the network is a position and a yaw. Reconstructing somebody's
 * exact field of view from that would mean sending their fov and aspect, which
 * is three more numbers on every tick to slightly tighten a test whose failure
 * mode is "waited too long".
 */
const PEEK_COS = 0.34;

/**
 * How far behind live a guest replays the animals, in milliseconds.
 *
 * Two sends at the host's six a second, for the reason `INTERP_DELAY_MS` is two
 * body ticks: every frame is then a true interpolation between two samples that
 * have both arrived, and one dropped packet costs nothing rather than a stall.
 *
 * A third of a second is a lot to be behind a person and nothing to be behind a
 * rabbit. There is no way to notice it: an animal has no voice coming out of it
 * and nothing in the world to be out of step with, so the only requirement on
 * this number is that the motion between samples is smooth.
 */
const FAUNA_LAG_MS = 333;

/**
 * The states, in wire order. An index into this is the whole of `state`.
 *
 * Order is load-bearing and append-only: it is an integer on the network, so
 * inserting one in the middle would make every older client read every animal's
 * state as the one next door.
 */
const STATES = ['graze', 'watch', 'walk', 'bolt', 'climb'];

/**
 * Eight numbers per animal, and the choice of which eight is the whole design.
 *
 * The split is between what the host DECIDED and what any machine holding that
 * decision can work out for itself:
 *
 *   x, y, z      where it is. `y` is carried rather than recomputed from
 *                `heightAt` because a climbing squirrel is three metres up a
 *                trunk, and that is the one case where the ground is wrong.
 *   yaw          which way the body faces. Host-owned because `faceHead` swings
 *                the whole body once the neck runs out, so this carries part of
 *                "it has noticed somebody".
 *   look         head yaw against the body — the whole of "it is watching me".
 *                Cannot be derived: it points at WHICHEVER person the animal
 *                noticed, and only the host knows who that was.
 *   lookPitch    the same vertically, and the grazing head-bob.
 *   speed        drives the stride blend, the gait phase and the footfalls, all
 *                of which are then local.
 *   state        an index into `STATES`.
 *
 * DERIVED AND DELIBERATELY ABSENT: `pitch` (zero in four states, a constant in
 * the fifth), `alert` and `alarm` (see `expression`), `gait` (a phase integrated
 * from speed, and no two machines have anything to compare leg phase against),
 * `stride`, the frustum test, the draw-slot compaction, and every sound. Sending
 * those would be half as much again on the wire for nothing anybody could see.
 */
const ANIMAL_FIELDS = 8;

/**
 * How many animals re-describe their coat on each send.
 *
 * THIS IS THE ANSWER TO A PROBLEM THAT LOOKS MUCH BIGGER THAN IT IS. Recycling
 * an animal re-rolls its coat, size, rack and nerve — see `individual` — off a
 * sequential rng, so a guest that never runs the recycler would keep the coat it
 * rolled at load and slowly drift into disagreement about what colour every deer
 * in the wood is.
 *
 * The obvious fix tracks which animals changed and sends those, which needs a
 * dirty flag, a repeat count against packet loss, and a full dump whenever
 * somebody joins. Two a tick, round-robin, needs none of that: the whole
 * population is re-described every two seconds, packet loss heals itself, a late
 * joiner is correct within two seconds of arriving, and there is no state to get
 * wrong. It costs about a tenth of what the transforms cost.
 *
 * The two-second window is invisible because of when a re-roll can happen at
 * all: the recycler only fires on an animal that is in nobody's view.
 */
const COATS_PER_SEND = 2;

/** Wire rounding. See `snapshot` for why the host does this and not the server. */
const r2 = (n) => Math.round(n * 100) / 100;
const r1 = (n) => Math.round(n * 10) / 10;
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
  tapir: [
    { name: 'ordinary', w: 0.8, light: [0.88, 1.18] },
    // A dark red deer stag reads almost black in shade and is the single most
    // impressive thing this wood can put in front of you.
    { name: 'dark', w: 0.09, light: [0.5, 0.66], cast: [0.95, 0.97, 1.04] },
    { name: 'pale', w: 0.06, light: [1.55, 1.95], cast: [1.03, 1.0, 0.95] },
    { name: 'red', w: 0.05, light: [1.02, 1.3], cast: [1.18, 0.92, 0.72] },
  ],
  agouti: [
    { name: 'ordinary', w: 0.78, light: [0.82, 1.22] },
    { name: 'black', w: 0.07, light: [0.4, 0.55], cast: [0.98, 0.98, 1.03] },
    { name: 'sandy', w: 0.08, light: [1.4, 1.85], cast: [1.09, 1.0, 0.84] },
    // The only one that needs a pattern rather than a level. A blotched rabbit
    // is the classic escaped-domestic in a wild warren and it is impossible to
    // mistake for anything else at forty metres.
    { name: 'pied', w: 0.07, light: [0.88, 1.2], pied: [0.65, 1.0] },
  ],
  capuchin: [
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
  /**
   * A tapir's sexes barely differ — the female is slightly the larger, which is
   * the reverse of the deer this replaces and true of the real animal. `antler`
   * is 0 on both because there is no antler geometry left to scale; see the
   * `horn` note in BEASTS.
   */
  tapir: [
    { name: 'male', nerve: 1.04, size: 0.96, antler: 0 },
    { name: 'female', nerve: 0.92, size: 1.05, antler: 0 },
  ],
  agouti: [
    { name: 'buck', nerve: 1.05, size: 1.08, antler: 0 },
    { name: 'doe', nerve: 0.88, size: 0.93, antler: 0 },
  ],
  capuchin: [
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
  /**
   * ==== THE TAPIR, WHICH IS NOT A DEER WITH A NEW NAME ====================
   *
   * Every behavioural number here moved, because the two animals behave
   * nothing alike and the numbers are most of what the player actually meets.
   *
   *   FEWER AND MORE SOLITARY. `count` 5 -> 3 and `territory` 26 -> 34. A red
   *   deer herd is a group you come across; a tapir is almost always alone,
   *   and meeting one should be rarer and therefore worth more.
   *
   *   SLOWER, AND IT DOES NOT BOLT LIKE A DEER. `bolt` 8.2 -> 5.6 m/s. A tapir
   *   is fast for its size but it is a 250 kg animal crashing through
   *   undergrowth, not something that flows away over a hedge. `stride` drops
   *   with the leg length.
   *
   *   IT LETS YOU GET MUCH CLOSER, and this is the one that changes the
   *   encounter. `notice` 36 -> 19 and `flee` 14 -> 8. Tapirs have famously
   *   poor eyesight and rely on scent and hearing, so they blunder about and
   *   notice you late. A deer sees you at thirty-six metres and is gone before
   *   you knew it was there; this you can walk up on, which is the whole
   *   difference between an animal that decorates the wood and one you have an
   *   encounter with.
   */
  tapir: {
    build: tapirGeometry,
    count: 3,
    young: 1,
    scale: [0.88, 1.12],
    speed: { graze: 0.42, walk: 1.15, bolt: 5.6 },
    stride: 1.25,
    notice: 19,
    flee: 8,
    // Longer than a deer's. A short-sighted animal that has heard something
    // stands and works out what it was, and standing still is what makes it
    // photographable.
    watch: [2.6, 6.5],
    territory: 34,
    // Very dark grey-brown. A tapir is nearly black in shade and the pale
    // countershading below is doing more work here than on any other animal.
    colour: 0x3b332e,
    /**
     * Reflectance multiplier on the underside. A belly is not a colour.
     *
     * STRONGER THAN THE DEER'S, because the base coat is now nearly black and
     * a multiplier can only lift what is there. This is the pale throat, chest
     * and lower flank a real tapir has, and against 0x3b332e it is the only
     * thing that keeps the animal from being a silhouette in the understory.
     */
    pale: [2.25, 2.1, 1.9],
    /** spineY, bellyY, strength, topY — see the countershading block. */
    belly: [1.04, 0.72, 0.95, 1.2],
    /**
     * A tapir has no rump flash, so this is doing a different job: the pale
     * EDGE of the rump and the white ear rims are the only markings on the
     * animal. Smaller radius, and moved up and back to sit on the haunch.
     */
    flash: [0, 1.18, -0.86, 0.2],
    // Small, dark and set far forward and low — the head dropped by 0.65 m
    // when the neck was shortened, and the eye has to come with it.
    eye: [0.1, 1.13, 1.36, 0.028],
    // Faster and wider than a deer's: with the antlers gone this channel is
    // the ears alone, and a tapir's ears are never still.
    trimRate: 1.9,
    trimAmp: 0.05,
    bob: 0.04,
    lung: 0.011,
    /**
     * NO `horn`. The antler geometry was deleted from `tapirGeometry` outright
     * rather than folded away, so there is nothing on the head-and-trim channel
     * pair for the headpiece branch to collapse — and omitting the field sets
     * `uHorn.w` to 0, which switches that branch off for this species
     * altogether. See the block at the top of the builder in shapes.js: the
     * side effect is that the full trim swing is handed back to the ears, via
     * the `mix(1.0, aTone.x, rrHorn)` in shading.js, which is exactly what is
     * wanted here.
     */
    /** Steps per second at a walk, for the audio. */
    step: 1.15,
  },
  agouti: {
    build: agoutiGeometry,
    count: 12,
    young: 2,
    scale: [0.78, 1.24],
    speed: { graze: 0.28, walk: 1.1, bolt: 6.4 },
    stride: 0.5,
    notice: 17,
    flee: 7.5,
    watch: [0.5, 1.4],
    territory: 9,
    // Grizzled orange-brown. An agouti's coarse rump hair is the one warm
    // colour on the forest floor and it is what you see going away from you.
    colour: 0x6b4526,
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
  capuchin: {
    build: capuchinGeometry,
    count: 6,
    young: 0,
    scale: [0.78, 1.18],
    speed: { graze: 0.5, walk: 1.4, bolt: 5.2 },
    stride: 0.34,
    notice: 15,
    flee: 9,
    watch: [0.3, 0.9],
    territory: 7,
    // Buff body, dark cap and limbs. The base is the pale part — the coat
    // shader's countershading and the dark cast in the morph table below do
    // the rest, because a multiplier cannot lift a dark base into a light one.
    colour: 0x8a7350,
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
 * this table existed that was the only thing about it that was a species:
 * twenty-six identical dark smudges, one of which sang like a wood pigeon and
 * one like a goldcrest. Coupling the two is the cheapest way to make this
 * forest feel like a place, because it turns the bird in the tree in front of
 * you from a decoration into a FACT that two different systems agree about —
 * and being able to walk toward a sound and find the animal that makes it is
 * most of what a forest is.
 *
 * KEYED BY NAME, NOT BY INDEX, and that is the whole reason this table lives
 * here rather than as an array in voice order. `VOICES` in wildlife.js has been
 * rewritten twice and grown three times; an array indexed 0..19 would silently
 * re-skin every bird in the wood the next time somebody inserted a species
 * above the one they were adding. A name either matches or it does not, and a
 * miss falls through to `STRANGERS` and gets a plausible bird.
 *
 * THERE IS NO SIZE IN HERE, AND THAT IS THE SECOND HALF OF THE SAME ARGUMENT.
 * `wildlife.js` carries every species' body length in centimetres and hands it
 * out through `voiceInfo`, so the size of a bird is a fact that already exists
 * in the file that owns the species list. Copying it here would be a second
 * roster of exactly the kind the name-keying above exists to avoid, and it
 * would go stale in the same way and just as quietly. See `sizeOf`.
 *
 * WHY THE WHOLE TABLE IS NOW A RAINFOREST, AND WHAT THAT CHANGES.
 *
 * The roster was twenty British woodland birds and the honest summary of them
 * as OBJECTS TO LOOK AT is that sixteen of the twenty were brown. That is true
 * of a British wood and it is the wrong problem to have here, because the
 * player's report about this forest was not "the birds are dull", it was I CAN
 * HEAR BIRDS EVERYWHERE AND I CAN NEVER SPOT ONE — and against dark bark, in a
 * wood that is deliberately dim, at twenty-five metres, a small brown bird is
 * genuinely not findable. Half of that problem is where the birds are and how
 * they behave, which is `updatePerchers`; the other half is what they look
 * like, which is this table, and a rainforest fixes it almost for free:
 *
 *   THEY ARE BIGGER. The new roster averages 27 cm of body against 17, which
 *   through `sizeOf` is about a quarter more bird in every direction. A toucan
 *   is 50 cm and a manakin is 10, so the range is wider as well as higher.
 *
 *   THEY ARE SATURATED. A scarlet-rumped tanager, a quetzal and an aracari are
 *   not "a browner brown than the last one" — they are the only saturated
 *   objects in a world made of green and shadow, which is exactly the argument
 *   `WINGS` makes for the butterflies and it applies twice as hard to something
 *   the size of a crow.
 *
 *   THE SILHOUETTES DIVERGE. `build` was carrying small differences between
 *   birds that were all roughly one shape. A quetzal has 60 cm of tail
 *   streamer, a motmot has a bare racket-tipped tail, a tinamou has no tail at
 *   all and is a rugby ball on legs, a hermit is a splinter with a long bill.
 *   Those read at a distance where a colour does not.
 *
 * WHAT EACH NUMBER IS, AND WHY THEY ARE THE NUMBERS THEY ARE.
 *
 *   build   [span, girth, length]. A uniform scale can only say "bigger", and
 *           bigger is not a species. This is the field that makes two birds of
 *           the same size read as different animals, and in this roster it does
 *           more work than in the last one: the range on `length` runs from a
 *           manakin's 0.66 to a quetzal's 1.85, nearly three to one.
 *   coat    a MULTIPLIER on the shared bird colour (0x8c8c90, a mid grey), not
 *           an absolute — the same discipline as `shade`, so a bird still goes
 *           dark when it hops into shade instead of glowing there.
 *
 *           IN LINEAR SPACE, WHICH IS NOT WHERE ANYONE PICKS A COLOUR. Three
 *           converts a material colour to linear on assignment, so these
 *           multiply linear components and the ratios are NOT the ratios of the
 *           sRGB values you would type into a colour picker. The difference is
 *           large and it is not a rounding error: a rufous brown wants 0.39 on
 *           green where the sRGB ratio for the same colour is 0.64, which comes
 *           out a washed-out grey — which is exactly what the first attempt at
 *           the old table did. 1.0 is the base grey, 0.02 is a toucan's black,
 *           and white is around 3.5 rather than around 1.8. DERIVE THEM rather
 *           than guessing — `mult = linear(target) / linear(base)` with the
 *           standard sRGB transfer — and read the result back with
 *           `bird-lineup.mjs`, which prints what each species ended up as,
 *           converted to sRGB so it can be read.
 *   mark    the second colour, and the reach is how far up the front of the
 *           bird it goes. This is the field that earns the whole attribute: a
 *           quetzal is a green bird with a crimson front, and one colour cannot
 *           say that. At reach 0.06 it is a bill and nothing else; at 0.24 it is
 *           the entire breast. Every bird here has one, because every bird alive
 *           is differently coloured underneath than on top — and in this roster
 *           several of them ARE the mark: a toucan is a black bird with a
 *           yellow bib and an enormous yellow bill, and nothing else.
 *   henMark an optional replacement mark for the hen, for the four species where
 *           she is not a duller version of him but a DIFFERENT COLOUR. See
 *           `plumageInto`, which handles every other row with one number. Four
 *           rows use it here against two in the old table, and that is not
 *           inflation: tropical dimorphism is routinely a different ANIMAL
 *           rather than a faded one — a hen manakin and a hen honeycreeper are
 *           both plain green birds whose males are black-and-gold and violet.
 *   dimorph how much duller the hen is, 0 to 1. See `plumageInto`.
 */
const PLUMAGE = {
  /**
   * A screaming piha, and the best joke in the roster: the loudest bird in the
   * forest is a featureless grey nothing with a slightly paler front. It is on
   * the table as the control — proof that the colours below are the species and
   * not a filter applied to everything.
   */
  piha: {
    build: [1.0, 1.02, 1.0],
    coat: [1.05, 1.05, 0.88],
    mark: [1.83, 1.83, 1.56],
    reach: 0.2,
    dimorph: 0,
  },
  /**
   * A three-wattled bellbird: a chestnut body under a pure white head and
   * breast, and the longest reach in the table because on this bird the white
   * really is the whole front third of it.
   */
  bellbird: {
    build: [1.0, 1.15, 0.88],
    coat: [0.56, 0.16, 0.05],
    mark: [3.45, 3.32, 2.84],
    reach: 0.26,
    // She is olive-green and streaky and does not look like the same species,
    // which is what the top of this range is for.
    henMark: [0.72, 0.95, 0.3],
    dimorph: 0.8,
  },
  /**
   * A Montezuma oropendola: nearly black at the front, deep chestnut behind,
   * with a pale bill and a blue cheek patch — which at this reach is a face and
   * not a breast, and a face is exactly what identifies one.
   */
  oropendola: {
    build: [1.06, 1.0, 1.3],
    coat: [0.26, 0.09, 0.03],
    mark: [3.32, 2.46, 0.16],
    reach: 0.12,
    dimorph: 0.15,
  },
  /**
   * A resplendent quetzal, which is the reason a length multiplier exists.
   *
   * 1.85 is the tail streamer and it is the single most extreme number in this
   * table. The bird is 40 cm and the tail is another 60, so a quetzal is very
   * nearly all tail — and since `aBuild.z` lengthens the whole rear of the
   * animal (see the shader), that is what it draws. Iridescent green over a
   * crimson breast, and the crimson gets a long reach because it is most of
   * the underside.
   */
  quetzal: {
    build: [1.0, 0.95, 1.85],
    coat: [0.05, 0.97, 0.3],
    mark: [2.2, 0.02, 0.1],
    reach: 0.22,
    // The hen has no crimson and no streamers; she is a grey-breasted green
    // bird. The mark cannot fade to that, so she gets her own.
    henMark: [0.97, 1.02, 0.83],
    dimorph: 0.5,
  },
  /**
   * A turquoise-browed motmot: green over a rufous belly, with the racket tail
   * and the electric-blue brow that names it. The mark is that brow — a short
   * reach, because it is a stripe over the eye and nothing more.
   */
  motmot: {
    build: [0.95, 1.0, 1.45],
    coat: [0.18, 0.97, 0.52],
    mark: [0.03, 1.83, 2.17],
    reach: 0.12,
    dimorph: 0,
  },
  /**
   * A great tinamou: olive-brown, barred, tailless, and shaped like a rugby
   * ball. The girth at 1.3 and the length at 0.7 are the whole bird — you will
   * hear this species far more often than you see it, and when you do see it,
   * it is on the ground and it is the wrong shape for a bird.
   */
  tinamou: {
    build: [0.85, 1.22, 0.7],
    coat: [0.55, 0.4, 0.18],
    mark: [2.46, 2.08, 1.3],
    reach: 0.18,
    dimorph: 0,
  },
  /**
   * A black-throated trogon: green above, brilliant yellow below, sitting bolt
   * upright and absolutely still on a mid-storey branch. One of the two or three
   * species here you can genuinely walk up to, so the colours matter more than
   * most.
   */
  trogon: {
    build: [0.9, 1.12, 1.2],
    coat: [0.11, 0.56, 0.27],
    mark: [3.39, 2.13, 0.17],
    reach: 0.2,
    // She swaps green for warm brown and keeps the yellow.
    dimorph: 0.45,
  },
  /**
   * A common potoo, which is bark. Grey-brown, mottled, and its entire defence
   * is that it looks like the broken stump it is sitting on — so it gets the
   * narrowest contrast in the table on purpose. Finding one is meant to be
   * hard; hearing one is not.
   */
  potoo: {
    build: [1.05, 1.15, 1.15],
    coat: [0.59, 0.48, 0.33],
    mark: [1.4, 1.16, 0.84],
    reach: 0.12,
    dimorph: 0,
  },
  /**
   * A great kiskadee: rufous wings, a black-and-white striped head and the
   * brightest yellow breast of anything in the understorey. A long reach,
   * because that yellow is the whole front of the bird — and this is the
   * species a player is most likely to identify twice, so it is worth getting
   * loud.
   */
  kiskadee: {
    build: [1.0, 1.08, 0.95],
    coat: [1.43, 0.47, 0.08],
    mark: [3.55, 2.51, 0.01],
    reach: 0.24,
    dimorph: 0,
  },
  /** A musician wren: rufous, barred, tiny, tail cocked. Plain, and famous anyway. */
  musicianwren: {
    build: [0.85, 1.2, 0.72],
    coat: [1.23, 0.39, 0.12],
    mark: [2.73, 2.23, 1.44],
    reach: 0.15,
    dimorph: 0,
  },
  /**
   * A white-plumed antbird: slate grey, and named for the white throat plume
   * that is the only thing on it. Reach 0.1 is that plume — any more and it is
   * a bird with a white chest, which is a different species entirely.
   */
  antbird: {
    build: [0.9, 1.1, 0.85],
    coat: [0.26, 0.3, 0.34],
    mark: [3.26, 3.35, 3.24],
    reach: 0.1,
    dimorph: 0.35,
  },
  /**
   * A golden-headed manakin: a ten-centimetre jet-black bird with a
   * fluorescent yellow head. The single highest contrast in the table, on the
   * single smallest body — and it works, because the head is a fifth of the
   * animal.
   */
  manakin: {
    build: [0.8, 1.25, 0.66],
    coat: [0.03, 0.03, 0.03],
    mark: [3.39, 1.74, 0.02],
    reach: 0.11,
    // She is a plain olive-green bird and nobody would guess they were the same
    // species. `dimorph` can only take contrast out of black, which gives a
    // grey male rather than a green female, so she gets her own colour.
    henMark: [0.59, 0.97, 0.15],
    dimorph: 0.9,
  },
  /**
   * A paradise tanager, which is the most absurdly coloured thing in this
   * forest and is on the roster mostly for that: turquoise breast, apple-green
   * head, black back, scarlet rump. The voice is a thin squeak, so this is the
   * one species you find by LOOKING, which is a useful thing for a roster to
   * contain.
   */
  tanager: {
    build: [0.95, 1.05, 0.95],
    coat: [0.02, 1.43, 1.98],
    mark: [1.3, 2.79, 0.1],
    reach: 0.13,
    dimorph: 0,
  },
  /**
   * A red-legged honeycreeper: violet-blue with a turquoise crown, slim, with a
   * decurved bill.
   */
  honeycreeper: {
    build: [0.92, 0.98, 0.95],
    coat: [0.35, 0.23, 2.07],
    mark: [0.14, 2.41, 1.89],
    reach: 0.1,
    // Plain grass-green, like the manakin's hen and for the same reason.
    henMark: [0.3, 1.23, 0.17],
    dimorph: 0.85,
  },
  /**
   * A long-billed hermit: a dull green-brown hummingbird that is mostly bill
   * and tail spike. The narrowest body in the table and the narrowest wing —
   * 0.78 span on a 0.85 girth is a splinter, which is what one looks like when
   * it stops moving, which is almost never.
   */
  hermit: {
    build: [0.78, 0.85, 1.3],
    coat: [0.56, 0.55, 0.27],
    mark: [3.08, 2.65, 1.56],
    reach: 0.07,
    dimorph: 0,
  },
  /**
   * A barred woodcreeper: warm brown, finely barred, with a stiff tail it props
   * itself on. Long and straight, because it lives clinging to vertical trunks
   * and that is the shape that reads as one.
   */
  woodcreeper: {
    build: [0.95, 1.0, 1.28],
    coat: [0.97, 0.39, 0.12],
    mark: [2.28, 1.61, 0.85],
    reach: 0.18,
    dimorph: 0,
  },
  /**
   * A barred antshrike, and the most extreme dimorphism on the roster: he is
   * black-and-white barred with a crest, she is uniform bright rufous with a
   * chestnut crest. Two different birds by any visual test, and the reason
   * `henMark` exists.
   */
  antshrike: {
    build: [0.92, 1.14, 1.0],
    coat: [1.23, 1.23, 1.19],
    mark: [0.02, 0.02, 0.02],
    henMark: [1.76, 0.34, 0.05],
    reach: 0.12,
    dimorph: 0.8,
  },
  /**
   * A collared aracari: a small toucan, so a slim body, a long tail and a bill
   * half the length of the animal. Dark green above, and a yellow underside
   * with the black-and-red banding that the reach at 0.22 stands in for.
   */
  aracari: {
    build: [1.0, 0.85, 1.4],
    coat: [0.11, 0.44, 0.13],
    mark: [3.39, 2.08, 0.03],
    reach: 0.22,
    dimorph: 0,
  },
  /**
   * A black-faced solitaire: slate grey with a black face and a bright orange
   * bill and legs. Reach 0.06 is the bill and only the bill — the same discipline
   * a bill-only mark always needs, and the same test: get it wrong by a factor of
   * three and it is a grey bird with an orange head.
   */
  solitaire: {
    build: [0.98, 1.0, 1.05],
    coat: [0.3, 0.34, 0.38],
    mark: [3.32, 0.74, 0.02],
    reach: 0.06,
    dimorph: 0,
  },
  /**
   * A keel-billed toucan, which is the bird everybody actually came here for.
   * Black body, brilliant yellow bib, and a bill you can see from forty metres.
   * The mark covers the bib AND the bill because at this geometry they are the
   * same end of the same animal, and the biggest body in the table carries it.
   */
  toucan: {
    build: [0.95, 1.05, 1.25],
    coat: [0.02, 0.02, 0.03],
    mark: [3.55, 2.84, 0.25],
    reach: 0.2,
    dimorph: 0,
  },
};

/**
 * The four birds a voice this file has never heard of turns into.
 *
 * `wildlife.js` is being extended by somebody else and will have species in it
 * that are not above, so the interesting question is not "how do we know them
 * all" but "what does a bird we do not know look like". A generic average of
 * the table would be one shape repeated, which is the thing this whole pass
 * exists to remove; four plausible archetypes picked by a hash of the NAME
 * gives an unknown species a stable, unremarkable, believable appearance.
 *
 * They moved continents with everything else. A "small brown job" is still the
 * right first guess anywhere on earth, but the grey one became a green one and
 * the big dark one got a bright throat, because an unknown bird in THIS forest
 * is far more likely to be green with something loud on the front of it than to
 * be a dunnock.
 */
const STRANGERS = [
  // A small brown job. Every forest has them.
  { build: [0.95, 1.05, 0.96], coat: [1.16, 0.77, 0.4], mark: [2.01, 1.49, 0.83], reach: 0.16, dimorph: 0.2 },
  // A green one, which is what most of the canopy is.
  { build: [0.98, 1.0, 1.05], coat: [0.3, 0.86, 0.35], mark: [2.2, 2.3, 0.6], reach: 0.17, dimorph: 0.25 },
  // An olive understorey bird with a pale throat.
  { build: [0.9, 1.08, 0.92], coat: [0.62, 0.7, 0.38], mark: [2.3, 2.1, 1.4], reach: 0.15, dimorph: 0.2 },
  // Something big and dark with a bright bill.
  { build: [1.03, 1.05, 1.18], coat: [0.14, 0.13, 0.14], mark: [3.2, 2.1, 0.2], reach: 0.12, dimorph: 0.2 },
];

/**
 * The voice table's species names, in its own order — ASKED FOR, NOT COPIED.
 *
 * `wildlife.js` exports `VOICE_NAMES`, and its comment on that export makes the
 * same argument this file would have: the species list is defined by what the
 * thing sounds like, it lives in exactly one place, and a second roster is one
 * that goes stale the next time a row is added, silently, with a hermit wearing
 * a toucan. Two agents arrived at that independently, which is usually a sign
 * it is right.
 *
 * The literal below is a floor, not a copy in use: it is what this file falls
 * back to if it is ever loaded next to a `wildlife.js` from before that export
 * existed, and a wrong-but-plausible bird beats twenty-six undefined ones.
 */
const VOICE_ROSTER = wildlifeAudio.VOICE_NAMES ?? [
  'piha',
  'bellbird',
  'oropendola',
  'quetzal',
  'motmot',
  'tinamou',
  'trogon',
  'potoo',
  'kiskadee',
  'musicianwren',
  'antbird',
  'manakin',
  'tanager',
  'honeycreeper',
  'hermit',
  'woodcreeper',
  'antshrike',
  'aracari',
  'solitaire',
  'toucan',
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
 * reference would put the toucan at 2.0 and the manakin at 0.4 — eighteen
 * triangles at 0.4 is a speck, and the archetype geometry in shapes.js was
 * tuned around the middle of the range and starts to read as a balloon much
 * above 1.4. The 0.85 power compresses both ends without ever reordering them,
 * which is what matters: a manakin is still unmistakably the smallest thing in
 * the forest and a toucan still two and a half times its size.
 *
 * THE RAINFOREST ROSTER MOVED THIS WITHOUT CHANGING A NUMBER IN IT, which is
 * the point of taking the size from the audio table rather than keeping a
 * column here. The old twenty species came out at 0.60 to 1.43 averaging 0.84;
 * the new ones are 0.63 to 1.58 averaging 1.05, because rainforest birds are
 * simply bigger — 27 cm of body against 17. That is a QUARTER more bird in
 * every direction on every percher in the wood, for free, and it is a direct
 * answer to "I can hear them and I can never spot one".
 *
 * Five species now sit above the 1.4 the comment above calls a balloon, and
 * they get away with it through `build` rather than through this curve: an
 * aracari is 0.85 girth, a toucan 1.05, an oropendola 1.0. The one deliberately
 * round animal is the tinamou, which is a rugby ball on legs and is supposed to
 * look like one.
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
 * turns a cock trogon into a warm brown one and a cock bellbird into a streaky
 * olive hen, out of one number per species.
 *
 * `dimorph` is that number, and it is zero for over half of the table —
 * toucans, kiskadees, motmots, tanagers and potoos genuinely cannot be sexed by
 * eye, and inventing a difference there would be the exact thing the brief
 * forbids. Where it is NOT zero here it tends to be extreme, because tropical
 * dimorphism usually is: four rows are at 0.8 or above and every one of them
 * also carries a `henMark`, because at that strength the general rule has
 * stopped describing anything.
 */
function plumageInto(coat, mark, spec, hen) {
  const d = hen ? spec.dimorph ?? 0 : 0;
  const lum = spec.coat[0] * 0.2126 + spec.coat[1] * 0.7152 + spec.coat[2] * 0.0722;
  // Toward its own luminance, then warmed a shade: a dull bird is not a grey
  // bird, and a hen trogon is brown rather than charcoal.
  const warm = [1 + d * 0.34, 1 + d * 0.06, 1 - d * 0.16];
  /**
   * THE FOUR SPECIES THE ONE-NUMBER RULE CANNOT DESCRIBE.
   *
   * The rule above is that a hen is a cock with the contrast taken out, and it
   * is very nearly the truth — but it can only ever move a colour toward the
   * body, and for a hen antshrike the badge does not fade, it turns RUFOUS
   * where his is black. Pulling black toward grey-olive gives a washed-out male
   * and not a female. Same for the hen manakin and the hen honeycreeper, whose
   * males are black-and-gold and violet-blue and who are both, simply, green.
   *
   * So `henMark` replaces the mark outright, and the dimorph rule still runs on
   * the coat underneath it — she is duller AND differently badged, which is
   * both halves of what she actually looks like. Four rows use it and the other
   * sixteen are unaffected, which is the right shape for an exception: the
   * general rule keeps its reach and stops lying about the two cases it cannot
   * reach.
   */
  const badge = hen && spec.henMark ? spec.henMark : spec.mark;
  for (let i = 0; i < 3; i++) {
    coat[i] = (spec.coat[i] + (lum - spec.coat[i]) * d * 0.7) * warm[i];
    mark[i] = spec.henMark && hen ? badge[i] : badge[i] + (coat[i] - badge[i]) * d * 0.62;
  }
  return spec.reach * (1 - d * (spec.henMark ? 0.15 : 0.45));
}

/**
 * Butterflies, which get the same two attributes for a much smaller sum, plus
 * one of their own that only they have any use for.
 *
 * THE ROSTER WAS STILL BRITISH. Aug 2026, and this is the fourth object found
 * in the same state as the forest floor's hay-meadow flowers: the rainforest
 * pass moved the canopy, the birds, the ground cover and the insect bed to the
 * Neotropics and left a peacock and a small tortoiseshell flying about
 * underneath a kapok. Nobody notices, because a butterfly is 13 cm and moving —
 * which is exactly why it was worth fixing, since the SAME argument says the
 * one Amazonian butterfly everybody can picture was also missing.
 *
 * The old note here is still right and is the reason this table exists at all:
 * a butterfly is the only saturated thing in a wood made of greens and browns,
 * so a ramp between two neighbouring hues gets you twenty differently-lit
 * copies of the same marigold and real species get you something worth walking
 * over to look at. The mark attribute the birds needed does the other half of
 * every one of them — a postman is a BLACK butterfly with one scarlet bar, a
 * zebra longwing is a black one with cream stripes, a sulphur is lemon with an
 * orange apex. The band is the species in almost every case, which is why the
 * flyer's mark anchor for this material sits out on the wing.
 *
 * THE MORPHO IS WHY THIS PASS HAPPENED, and it needs the third attribute.
 *
 * Every other butterfly here is one colour with a marking on it, top and
 * bottom, and a single tint says all of it. A blue morpho is not: it is a drab
 * brown insect with a MIRROR on the top of its wings. The blue is structural —
 * interference in the scale lamellae, not pigment — and the underside is
 * leaf-brown with eyespots, so what a morpho does when it flies through a light
 * shaft is BLINK: electric blue, gone, electric blue, gone, once per wingbeat,
 * as the two faces of the same wing alternate. Ask anyone who has been to the
 * Amazon what they saw and this is the image you get back.
 *
 * `under` is that second face, and `flash` is how much of a mirror the species
 * is. They ride one more instanced vec4 on a mesh that is already one draw
 * call, and the shader half is a `gl_FrontFacing` branch — see `flyerMaterial`.
 * Everything else in the table is a pigment butterfly with flash 0, which
 * compiles to the same arithmetic it always did.
 *
 * ALL OF THESE ARE LINEAR MULTIPLIERS ON A WHITE BASE, i.e. they ARE the linear
 * colour, and the sRGB value each one is aiming at is in the comment. Deriving
 * them as sRGB ratios is the mistake that rendered every bird in this wood a
 * washed grey; see PLUMAGE. The lit surface under a canopy is well below 1, so
 * the numbers below land darker than the sRGB they name — for the morpho that
 * gap is closed on purpose by the additive flash, which is what makes it read
 * as a mirror rather than as a blue card.
 *
 * `w` is how common. A sulphur or a julia is the butterfly you see constantly
 * over a Neotropical clearing; the morpho is weighted so that roughly one in
 * five is one, which is often enough to happen and rare enough to be an event.
 */
const WINGS = [
  {
    // Morpho menelaus. Upper #3878F0, border #12141F, underside #6B5A46.
    name: 'morpho',
    w: 1.6,
    size: 1.34,
    build: [1.06, 0.86, 1.0],
    coat: [0.04, 0.188, 0.871],
    mark: [0.006, 0.007, 0.014],
    under: [0.3, 0.21, 0.13],
    flash: 1.2,
    reach: 0.03,
    beat: [0.86, 6.8],
  },
  {
    // Caligo, the owl butterfly. Dull mauve-brown above, dead leaf below.
    name: 'owl',
    w: 0.3,
    size: 1.5,
    build: [1.0, 1.1, 1.02],
    coat: [0.195, 0.127, 0.188],
    mark: [0.014, 0.01, 0.008],
    under: [0.34, 0.22, 0.1],
    flash: 0.0,
    reach: 0.055,
    beat: [0.82, 5.6],
  },
  {
    // Heliconius melpomene. Black, one scarlet bar. Long wings, slow and floppy.
    name: 'postman',
    w: 0.6,
    size: 1.0,
    build: [1.16, 0.82, 1.12],
    coat: [0.01, 0.009, 0.012],
    mark: [0.687, 0.018, 0.013],
    under: [0.075, 0.06, 0.05],
    flash: 0.0,
    reach: 0.045,
    beat: [0.8, 6.2],
  },
  {
    // Heliconius charithonia, the zebra longwing. Black with cream stripes.
    name: 'zebra',
    w: 0.45,
    size: 1.02,
    build: [1.18, 0.8, 1.14],
    coat: [0.013, 0.012, 0.01],
    mark: [0.807, 0.716, 0.188],
    under: [0.11, 0.1, 0.07],
    flash: 0.0,
    reach: 0.052,
    beat: [0.78, 6.0],
  },
  {
    // Phoebis, a sulphur. The one you see most of over any clearing.
    name: 'sulphur',
    w: 0.5,
    size: 0.86,
    build: [1.0, 0.98, 0.98],
    coat: [0.52, 0.36, 0.028],
    mark: [0.58, 0.2, 0.014],
    under: [0.4, 0.36, 0.1],
    flash: 0.0,
    reach: 0.036,
    beat: [0.9, 11.5],
  },
  {
    // Dryas iulia. Long orange wings, dark border.
    name: 'julia',
    w: 0.45,
    size: 1.04,
    build: [1.12, 0.88, 1.08],
    coat: [0.5, 0.1, 0.008],
    mark: [0.03, 0.012, 0.006],
    under: [0.3, 0.16, 0.07],
    flash: 0.0,
    reach: 0.048,
    beat: [0.84, 8.4],
  },
  {
    // Parides / Battus, a swallowtail. Black with an emerald band.
    name: 'swallowtail',
    w: 0.4,
    size: 1.2,
    build: [1.08, 0.9, 1.1],
    coat: [0.009, 0.01, 0.013],
    mark: [0.04, 0.515, 0.156],
    under: [0.07, 0.075, 0.065],
    flash: 0.18,
    reach: 0.042,
    beat: [0.85, 7.2],
  },
];
/**
 * WINGS[0] is the morpho and the code below relies on it, which is worth one
 * line to say out loud: three of the eight slots are dealt it outright rather
 * than rolled for it. See `seatFlutter`.
 */
const MORPHO_SLOTS = 2;
/** Everything that is a pigment butterfly, i.e. everything the deal does not cover. */
const PIGMENT = WINGS.slice(1);
const PIGMENT_TOTAL = PIGMENT.reduce((s, k) => s + k.w, 0);

/** Flock birds, drawn entirely by the vertex shader. */
/**
 * The wheeling flocks, plus MACAW_BIRDS reserved at the end of the same range.
 *
 * 96 was the flock budget and it still is; the six macaws are ADDED rather
 * than carved out, because carving would have taken two birds off each of the
 * four flocks and a flock is already only twenty-four. Six more slots in an
 * InstancedMesh that is already drawn once is nothing — see the macaw block
 * below for why they cost no draw call, no material and no shader branch.
 */
const FLOCK_BIRDS = 96 + 6;
/** Three pairs. See the macaw block after the flock loop. */
const MACAW_PAIRS = 3;
const MACAW_BIRDS = MACAW_PAIRS * 2;
const FLOCKS = 4;
/** Birds that sit on real branches and leave when you get near. */
const PERCHERS = 26;
/**
 * EIGHT, AND ALL OF THEM WITHIN TWENTY-ONE METRES OF YOU.
 *
 * EIGHT IS THE SECOND ANSWER. The first was twenty, chosen by arguing from the
 * old count of twenty-two, and a wide gameplay frame settled it in one look: at
 * twenty there were four to seven butterflies in every 60° frame, spread evenly
 * through the whole depth of the wood, and the eye files that as weather. It
 * stops being an animal and becomes debris blowing about — which is the exact
 * failure the note below about "not sixty" was trying to name and did not
 * bite hard enough on. Measured per station at twenty: clearing 7, glade 6,
 * ridge 5, wood 4. At eight it is two or three, which is a thing you notice
 * one at a time.
 *
 * The radius came down with it, and for a separate reason: the far half of a
 * thirty-metre disc was contributing the specks and none of the images. A
 * butterfly at twenty-five metres is three pixels; it can only ever be
 * confetti. Twenty-one metres is the range at which one is an animal.
 *
 * Twenty-two was the old count, and it used to mean something completely
 * different: they were scattered once, at load, over a disc of eighty metres
 * centred on the WORLD ORIGIN, and never touched again. Two consequences, and
 * between them they are why the recon for this pass came back saying there were
 * no butterflies in this world at all.
 *
 * The first is streaming. This world is endless and the flocks, the herds and
 * the perchers all learned to follow the player; the butterflies never did, so
 * walking two hundred metres left every one of them behind for ever.
 *
 * The second is that eighty metres was the wrong disc even at the origin. A
 * butterfly is 13 cm across. At forty metres that is under two pixels at 1440p
 * and it is behind nine trunks; the far three-quarters of that disc were paying
 * for instances nobody could see. Concentrating the same handful into the
 * radius where a butterfly is actually an image raises the density you
 * experience by about seven times for no cost at all.
 *
 * Eight and not sixty, deliberately. A cloud of butterflies reads as moths and
 * kills the effect stone dead — the thing being reproduced here is finding ONE,
 * not walking through a hatch.
 */
const BUTTERFLIES = 7;
/** The annulus a butterfly is seated in, around the player, in metres. */
const FLUTTER_NEAR = 2.5;
const FLUTTER_FAR = 11;
/**
 * How far one is allowed to get before it is recycled to the near side.
 *
 * Comfortably beyond FLUTTER_FAR, and that gap is the whole of the hysteresis:
 * a butterfly reseated at thirty metres cannot immediately re-qualify, so
 * walking back and forth over one spot does not strobe them. It is also why no
 * frustum test is needed here, unlike the beasts' recycler — the pop happens at
 * forty-four metres and lands no closer than thirty, and at thirty metres a
 * butterfly is two pixels. A teleport you cannot resolve is not a teleport.
 */
const FLUTTER_DROP = 17;
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
    /**
     * A MID GREY, and it used to be 0x2a2a2c — near black.
     *
     * Every coat in PLUMAGE is a multiplier on this, so the base is what
     * decides whether the table has anywhere to go. Against 42 units it did
     * not: a coat had to climb above one just to be visible at all, the
     * brightest species in the wood came out as a dark brown smudge, and
     * nothing could be darker than the base so nothing read as black either.
     * The long version is in PLUMAGE's own docblock; the short version is that
     * a near-black base is why the birds could not be seen.
     */
    colour: 0x8c8c90,
    /** Metres the flock's own centre wanders, in x, y, z. */
    wander: [22, 3.4, 22],
    /**
     * WHERE A BIRD'S SECOND COLOUR IS ANCHORED, in this geometry's own local
     * units: on the centre line, a hair below the axis, and at z = 0.15, which
     * is the front ring of the body prism — the face and the bill.
     *
     * It is at the FRONT rather than the middle of the breast because that is
     * the end of the range that has to be precise. `reach` grows the patch
     * backward from here, so 0.06 is a solitaire's bill, 0.14 is a throat and
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
   * manakin and a toucan, on one geometry, in one draw call. See the
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
  /** Scratch for the per-flock plumage resolve. Nothing at load may allocate. */
  const _fCoat = [1, 1, 1];
  const _fMark = [1, 1, 1];
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
    /**
     * WHAT THIS FLOCK IS. One species for the whole ring — see the build write
     * below for why a flock is not a mixture.
     *
     * Drawn from the same roster the perchers deal from, so a flock overhead is
     * a bird you can also meet in a tree, and biased toward the big ones: the
     * things that actually cross a rainforest canopy in numbers are parrots,
     * toucans and oropendolas rather than manakins. `sizeOf` is already the
     * authority on which is which, so this is two rolls and a comparison rather
     * than a second list of who flocks.
     *
     * THE THRESHOLD WENT UP WITH THE ROSTER, from 0.85 to 1.25, and it had to.
     * The old table averaged 0.84, so 0.85 excluded about half of it; the new
     * one averages 1.05, so the same number would have excluded almost nothing
     * and the flocks would have gone back to being anonymous. 1.25 keeps the
     * top six — motmot, potoo, quetzal, aracari, tinamou, oropendola, toucan —
     * which read as something at forty metres up.
     */
    let flockVoice = Math.floor(rng() * VOICE_ROSTER.length);
    for (let tries = 0; tries < 4 && sizeOf(flockVoice) < 1.25; tries++) {
      flockVoice = Math.floor(rng() * VOICE_ROSTER.length);
    }
    const flockPlume = plumageOf(flockVoice);
    plumageInto(_fCoat, _fMark, flockPlume, false);
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
    const per = Math.floor((FLOCK_BIRDS - MACAW_BIRDS) / FLOCKS);
    for (let i = 0; i < per; i++) {
      const k = f * per + i;
      if (k >= FLOCK_BIRDS - MACAW_BIRDS) break;
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
      shade(_tint, rng, 0.78, 1.18);
      birdTint.setXYZ(k, _fCoat[0] * _tint.r, _fCoat[1] * _tint.g, _fCoat[2] * _tint.b);
      /**
       * A LOOSE SPREAD OF BUILDS, AND A SPECIES PER FLOCK.
       *
       * The perchers get a real plumage because you meet them at three metres.
       * A flock bird is a four-pixel silhouette ninety metres up, where the only
       * thing legible about it is the OUTLINE — so it still gets a little spread
       * in span, girth and tail and no mark, because a breast patch up there is
       * a wasted attribute while a long-tailed bird among short-tailed ones is
       * visible.
       *
       * WHAT IT DID NOT GET, AND SHOULD HAVE, IS A COLOUR. Ninety-six of the
       * hundred and twenty-two birds in this wood are flock birds and every one
       * of them was the bare base tint — which against a near-black base meant
       * ninety-six identical dark specks, and is a large part of "I barely
       * notice them". The species coat costs the same single write that was
       * already happening.
       *
       * BY FLOCK RATHER THAN BY BIRD, because that is what a flock is. Mixed
       * colours wheeling in one ring would be a fairground; twenty-four wood
       * toucans over the clearing and twenty-four green aracaris away to
       * the north is two flocks you can tell apart at distance, which is the
       * thing worth buying.
       */
      birdBuild.setXYZW(
        k,
        rngRange(rng, 0.9, 1.16) * flockPlume.build[0],
        rngRange(rng, 0.88, 1.12) * flockPlume.build[1],
        rngRange(rng, 0.92, 1.14) * flockPlume.build[2],
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
   * ==== MACAW PAIRS =========================================================
   *
   * The one bird everybody pictures, and the reason it is worth its own block
   * is that a macaw is not a flock animal in the way everything else up here
   * is. They fly in PAIRS — bonded for life, and they stay side by side across
   * miles of forest — high, fast, dead straight, and screaming. Seeing two
   * scarlet birds cross a gap in the canopy is one of the two or three images
   * the word "Amazon" reduces to.
   *
   * IT REUSES THE FLOCK MACHINERY EXACTLY AND ADDS NOTHING. Same InstancedMesh,
   * same material, same vertex shader, same orbit branch — a macaw is six more
   * slots in a buffer that is already uploaded and already drawn. There is no
   * new code path in the shader at all: everything below is attribute values.
   *
   *   STRAIGHT FLIGHT OUT OF A CIRCLE. `aFlight.x` is the orbit radius and
   *   `aFlight.y` the angular speed, so linear speed is their product. The
   *   flocks run 26-58 m at 0.055-0.115, i.e. 1.4-6.7 m/s of gentle wheeling.
   *   A macaw pair gets a much bigger radius AND a higher angular speed —
   *   about 11 m/s, which is a real macaw's cruise — and a big radius is what
   *   makes the visible arc nearly a straight line. They cross the sky rather
   *   than circling in it.
   *
   *   `aFlight.w` IS THE BANK, AND IT IS NEARLY ZERO. The comment in
   *   shading.js says a bird that circles flat is an aeroplane, which is true
   *   of a wheeling flock and false here: a macaw in transit holds level and
   *   beats steadily, and banking it would undo the straightness the radius
   *   just bought.
   *
   *   THE PAIR IS THE POINT. Both birds of a pair share one centre, one radius
   *   and one speed, and differ only by a tiny phase offset — so they hold
   *   station on each other forever instead of drifting apart the way the
   *   flock birds deliberately do. That constant few-metre gap is what reads as
   *   "a pair" rather than "two birds".
   *
   * THEY FLY HIGHER THAN ANYTHING ELSE and that is what makes them visible at
   * all. Per `forest-hides-everything-under-40m`, this canopy hides everything
   * past forty metres — the only exception is the sky. At 54-76 m of lift these
   * are always against it.
   */
  for (let m = 0; m < MACAW_PAIRS; m++) {
    /**
     * Scarlet, and it is painted rather than dealt from the voice roster.
     *
     * Every other bird up here takes its colours from `plumageOf` so that the
     * thing you see agrees with the thing you hear. A macaw is the one case
     * where that would lose: the roster's plumage is tuned for birds seen at
     * three metres in shade, and this bird is a silhouette at seventy metres
     * against a bright sky, where the only thing that survives is raw
     * saturation. Per `plumage-multipliers-are-linear`, a ratio that looks
     * right in sRGB renders as washed grey — so these are near-primary values
     * chosen for what comes out the far end, not for what reads well in a
     * table.
     */
    const scarlet = m % 2 === 0;
    const cr = scarlet ? 1.55 : 0.32;
    const cg = scarlet ? 0.24 : 0.62;
    const cb = scarlet ? 0.16 : 1.5;

    const a = rng() * TAU;
    // The centre sits near the player, so the ring passes over rather than
    // orbiting somewhere on the horizon. Same reasoning as `overClearing`.
    const cx = Math.cos(a) * rngRange(rng, 0, 26);
    const cz = Math.sin(a) * rngRange(rng, 0, 26);
    const lift = rngRange(rng, 54, 76);
    const cy = heightAt(cx, cz) + lift;
    const ringR = rngRange(rng, 88, 132);
    // ringR * speed is the cruise. 110 x 0.1 is 11 m/s.
    const speed = (11 / ringR) * (rng() < 0.5 ? -1 : 1) * rngRange(rng, 0.9, 1.12);
    const phase = rng() * TAU;
    /**
     * REGISTERED AS A FLOCK OF TWO, so the existing recentring moves them.
     *
     * This was very nearly the bug that shipped. `flocks` is what the follow
     * routine below walks, and a pair seeded straight into the buffers without
     * being pushed onto that list would be nailed to the world coordinates it
     * was born at — so a player who walked two hundred metres would leave the
     * macaws behind permanently and never see one again. Everything about the
     * pair is already in the right shape for it; it just has to be on the list.
     */
    const pair = { a, r: Math.hypot(cx, cz), lift, birds: [] };
    for (let b = 0; b < 2; b++) {
      const k = FLOCK_BIRDS - MACAW_BIRDS + m * 2 + b;
      birdFlight.setXYZW(
        k,
        // A few metres apart across the ring, so one flies very slightly
        // outside the other — which is how a real pair sits.
        ringR + (b === 0 ? -1.6 : 1.6),
        speed,
        // The phase offset IS the spacing along the track. 0.02 rad on a 110 m
        // ring is about 2.2 m of separation, held forever.
        phase + (b === 0 ? 0 : 0.02) * Math.sign(speed),
        0.12
      );
      birdBeat.setXYZW(
        k,
        rng() * TAU,
        // A deeper, much slower wingbeat than a small bird's. A macaw's beat is
        // heavy and unhurried and it is half of how you identify one in the air.
        rngRange(rng, 0.22, 0.3),
        rngRange(rng, 3.2, 4.1),
        1
      );
      birdHome.setXYZ(k, cx, cy + (b === 0 ? 0 : rngRange(rng, -1.2, 1.2)), cz);
      birdTint.setXYZ(k, cr, cg, cb);
      /**
       * BIG. The build channels are span, body and sweep — a macaw is nearly a
       * metre of bird with a very long tail, so the span goes up hard and the
       * sweep with it. At seventy metres this is the difference between a speck
       * and a shape.
       */
      birdBuild.setXYZW(k, rngRange(rng, 1.85, 2.05), rngRange(rng, 1.5, 1.7), 1.7, 0);
      birdMark.setXYZW(k, 1, 1, 1, 0);
      birds.setMatrixAt(k, _m.identity());
      pair.birds.push({
        k,
        dx: birdHome.getX(k) - cx,
        dy: birdHome.getY(k) - cy,
        dz: birdHome.getZ(k) - cz,
      });
    }
    flocks.push(pair);
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
  /**
   * THE BAND A PERCHER LIVES IN, AND IT IS THE WHOLE REASON THIS WOOD HAD NO
   * BIRDS IN IT.
   *
   * Every re-seat used to draw from 26–95 m. With `pow(rng(), 0.7)` biasing
   * outward that is a mean radius of 67 m, and measuring the running game agreed:
   * instrumenting `engine.createSpatial` for 45 s of standing still caught 17
   * song phrases at a MEAN DISTANCE OF 59 m, one of them inside 20 m, and most
   * lifting the master by less than a quarter over the wind and the stream.
   *
   * Two independent things were wrong with that and they have the same cause.
   *
   *   YOU COULD NOT HEAR THEM. `_phrase` places song with a 7 m reference and a
   *   1.35 rolloff, so 59 m is a ninth of the level of the same bird at 7 m, and
   *   the distance low-pass has by then taken the chiff off the front of every
   *   note — which is the part that identifies the species. Sixteen carefully
   *   distinguished contours, delivered as sixteen indistinguishable rumours.
   *
   *   YOU COULD NOT SEE THEM EITHER, and this is the half that made the whole
   *   feature invisible: THE FOREST HIDES EVERYTHING PAST ABOUT 40 m. Of birds
   *   drawn from 26–95 m, one in nine is inside that. Twenty-six perching birds
   *   existed, on real trunks, at real bough height, and the player's honest
   *   report was that birds only ever fly overhead — because the only birds they
   *   could resolve were the ninety-six flock instances circling above the
   *   canopy.
   *
   * 12–58 m puts the mean at 39 m and about half the roster inside the 40 m the
   * trees allow you to see through, with two or three inside 20 m at any moment.
   * THE INNER RADIUS IS NOT SMALLER THAN THAT ON PURPOSE: the startle radius is
   * 9 m, so a bird seated at 10 would flush the moment you shifted your weight,
   * and a wood that explodes every few seconds is worse than a quiet one. Twelve
   * leaves a bird you can walk up to — and then it goes, which is the point.
   *
   * IT DOES NOT ADD BIRDSONG, IT MOVES IT. `wildlife.js` meters song through a
   * leaky bucket, so the number of phrases a minute is set there and not here;
   * what changed is which birds win the tokens. Its own comment already wanted
   * this — "the same amount of birdsong, distributed by proximity instead of by
   * lottery" — and the bucket could not deliver it while every candidate was
   * sixty metres away.
   */
  const PERCH_NEAR = 12;
  const PERCH_BAND = 58;

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

  /**
   * CAN THIS BIRD ACTUALLY BE SEEN FROM THERE, and it is the missing half of
   * every distance test in this file.
   *
   * The reported symptom is the one thing twenty-six perching birds on real
   * branches at real bough height were still not fixing: "I always hear birds
   * around me but when I turn to look I can never spot them." Every previous
   * pass answered it with RANGE — the roster came in from a 26-95 m band to
   * 12-58, songs are metered by proximity, the birds got bigger and brighter —
   * and range is genuinely most of it. It is not all of it, because in a wood
   * the thing between you and a bird twenty metres away is usually a tree.
   *
   * A trunk is a cylinder and the collider grid already knows where every one
   * of them is, so a sight line is four `trunks.near` queries: walk the segment
   * from the listener to the bird and ask whether anything with a radius is
   * sitting on it. That is not a real occlusion test — it ignores canopy, the
   * understorey and the bird's height — and it does not need to be. It answers
   * the only question anybody is asking, which is IS THERE A TREE IN THE WAY,
   * and that single fact is what separates "I heard something and found it"
   * from "I heard something and there was nothing there".
   *
   * FOUR SAMPLES, NOT A MARCH. The grid query already has a radius on it, so
   * each sample sweeps a disc rather than testing a point, and a trunk wide
   * enough to hide a bird is wide enough to be caught by a sample 25% of the
   * way along a segment. Marching in metres would cost twenty queries to be
   * right about a case — a thin sapling exactly between you and a toucan —
   * where being wrong is one deferred song.
   *
   * It is called when a sing timer expires and at no other time: about two
   * thirds of a call per second across the whole roster, against a grid lookup
   * that the perch picker already does several of per re-seat.
   */
  function clearLine(from, to) {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    for (let i = 1; i <= 4; i++) {
      const k = i / 5;
      // The near end matters more than the far one — a trunk two metres in
      // front of your face hides everything behind it — but a uniform walk is
      // one multiply and the asymmetry is already in the geometry: samples
      // bunch up in angle near the bird, which is where the bird is.
      const t = trunks.near(from.x + dx * k, from.z + dz * k, 1.1);
      if (t) return false;
    }
    return true;
  }

  /**
   * How far a percher will bother to check whether you can see it.
   *
   * Forty-four metres, which is a little past the roughly forty this forest
   * lets you see through at eye level. Beyond it the sight line is not the
   * limiting factor and there is nothing to work out — the answer is no.
   */
  const SIGHT_RANGE = 44;

  const perchers = [];
  /**
   * Whether the roster has been placed in trees that actually exist yet. See the
   * block at the top of `updatePerchers`; false until the first frame on which
   * the streamed forest has put a trunk within reach.
   */
  let seated = false;
  /** Frames spent waiting for them, so a treeless spawn cannot spin for ever. */
  let seatingFrames = 0;
  /**
   * Whether the one corrective pass has run — the birds the first seating left
   * in the grass because their sector had not streamed yet. See `updatePerchers`.
   */
  let settled = false;
  let settleFrames = 0;
  /** Scratch for the plumage resolve. Nothing at load may allocate either. */
  const _coat = [1, 1, 1];
  const _mark = [1, 1, 1];

  /**
   * A DEAL RATHER THAN TWENTY-SIX INDEPENDENT ROLLS, so the wood contains every
   * species it knows about.
   *
   * This was `Math.floor(rng() * VOICE_COUNT)` per bird, which is the obvious
   * thing and quietly costs you three species a session: twenty-six uniform
   * draws from sixteen leaves `16 * (15/16)^26` — almost exactly three — with no
   * percher at all, and a species with no percher can only ever reach the player
   * as a distant phrase from beyond the trees. Every contour in that table was
   * written to be told apart, and the ones that go missing are missing for the
   * whole session, silently, differently each time.
   *
   * So the first cards ARE the roster and any remaining seats are drawn at
   * random, then the deck is shuffled so the extras are not all at the end. It
   * guarantees one of everything, keeps the doubling-up that makes a wood feel
   * unplanned, and costs one array of twenty-six integers at load.
   *
   * Both loops are written against the roster and the seat count rather than
   * against either number, so a table that grows past PERCHERS degrades the
   * only way it can — some species miss out this session — instead of
   * overrunning. It has grown twice already.
   *
   * Fisher-Yates off the fauna rng, which is its own stream (`:fauna`) — so the
   * reordering cannot move a tree, and two players in a seeded world still deal
   * the same wood.
   */
  const deck = [];
  for (let v = 0; v < VOICE_COUNT && deck.length < PERCHERS; v++) deck.push(v);
  while (deck.length < PERCHERS) deck.push(Math.floor(rng() * VOICE_COUNT));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = deck[i];
    deck[i] = deck[j];
    deck[j] = t;
  }

  for (let i = 0; i < PERCHERS; i++) {
    const voice = deck[i];
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
      /**
       * Seconds until this one crosses to another branch of its own accord. See
       * the block in `updatePerchers`. Spread across the whole interval at load
       * so the roster does not take off together on the first frame it is near
       * enough to bother.
       */
      hop: rngRange(rng, 4, 72),
      beat: rng() * TAU,
      /** Wing spread, 0 folded to 1 open. */
      open: 0.04,
      /**
       * SECONDS OF SONG LEFT TO PERFORM, and it is the whole of the visual
       * half of "I can hear them and I can never spot one".
       *
       * Set from what `wildlife.song` returns — see the sing block below — so
       * it is non-zero only while a phrase this bird asked for is actually
       * sounding. A bird that sang and stood still through it was the last
       * thing in this file still behaving like a loudspeaker in a tree.
       */
      show: 0,
      /**
       * The species' size, then the individual's own few per cent on top.
       *
       * The spread used to be 0.72–1.05 with nothing behind it; it now runs
       * from a 0.63 manakin to a 1.58 toucan and the number means
       * something — which is the difference between size variety and noise.
       */
      scale: size * rngRange(rng, 0.93, 1.07),
      hen,
      /**
       * Wingbeat rate, against the species' size. A small bird flaps faster:
       * roughly with the inverse cube root of mass in life, and the exponent
       * here is tuned by eye rather than by aerodynamics. A toucan
       * hammering at a manakin's rate is the single most obvious thing that
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
       * that a toucan is not a surprise and no species is missing.
       */
      voice,
      /** One bird in the wood is the one that starts paying attention. */
      watcher: i === 0,
    };
    pickPerch(p.home, 0, 0, PERCH_NEAR, PERCH_BAND);
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
     * look identical, and now that each one is a trogon or an aracari its
     * job is only the small variation between two trogons. Left wide it
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
  /**
   * A HAND-SIZED INSECT, which is the fact the old 0.13 was missing.
   *
   * Morpho menelaus runs 12 to 15 cm across and the whole reason anybody
   * remembers one is that it is far larger than a butterfly has any business
   * being. The base span is now the size of a middling Neotropical butterfly
   * and the species multiplier does the rest: a sulphur at 0.86 is 9.9 cm, a
   * morpho at 1.34 is 15.4 cm, a Caligo at 1.5 is 17 cm. Those are the real
   * numbers for those animals.
   */
  const FLUTTER_SPAN = 0.115;
  const flutterGeo = flutterGeometry({ span: FLUTTER_SPAN, body: 0.052, girth: 1 });
  const flutterMat = flyerMaterial({
    name: 'butterfly',
    colour: 0xffffff,
    /**
     * The fourth number is the vertical bob, and it is 0.42 rather than the 1.5
     * the birds get. That 1.5 was hardcoded in the orbit branch and shared, so
     * a 13 cm insect on a two-metre circuit was bouncing three metres peak to
     * peak — through the leaf litter at the bottom of every lap and into the
     * mid-storey at the top. 0.42 against a home 1.1–2.7 m up keeps the whole
     * flight in the 0.7–3.8 m band where you actually meet one.
     */
    wander: [3, 0.6, 3, 0.42],
    /** See the docblock on WINGS: the morpho is why this material is two-sided. */
    twoSided: true,
    /**
     * 1/half-span. The wingbeat rolls the shading normal by atan(travel x this),
     * so this is what turns 7 cm of wingtip travel into the ~50 degrees of tilt
     * the wing is really at. Left at its 1.15 default the normal rolled four
     * degrees and the morpho had no flash at all. See the wingbeat in shading.js.
     */
    hinge: 1 / (FLUTTER_SPAN * 0.5),
    /**
     * OUT ON THE WING, not on the breast — which is the whole reason the mark's
     * anchor is a per-material uniform and its reach is per-instance.
     *
     * The apex sits at span·0.5 = 0.0575 and the shoulder at 0.004, so an
     * anchor at 0.05 with a reach of 0.03 is a narrow tip flash and one of
     * 0.055 is a band down the outer half. |x| in the shader means one distance
     * test marks both wings. The 1.0 weight is the honest one here: for a
     * butterfly, sideways distance IS the wing.
     */
    mark: [0.05, 0, 0, 1.0],
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
  /** The underside and the mirror. Butterflies only — see WINGS and flyerMaterial. */
  const flutterUnder = new THREE.InstancedBufferAttribute(new Float32Array(BUTTERFLIES * 4), 4);
  flutterGeo.setAttribute('aFlight', flutterFlight);
  flutterGeo.setAttribute('aBeat', flutterBeat);
  flutterGeo.setAttribute('aHome', flutterHome);
  flutterGeo.setAttribute('aTint', flutterTint);
  flutterGeo.setAttribute('aBuild', flutterBuild);
  flutterGeo.setAttribute('aMark', flutterMark);
  flutterGeo.setAttribute('aUnder', flutterUnder);

  /**
   * A STREAM OF ITS OWN, and this is the one thing in the file that is about
   * the next person rather than about butterflies.
   *
   * Everything here used to draw from the shared `rng`, which means the exact
   * number of calls the butterfly loop makes decides what colour every deer in
   * the wood is — the beasts are seeded after it. `scripts/fauna-wired.mjs` has
   * a documented false failure built entirely out of that coupling. Butterflies
   * are now the layer most likely to be retuned by somebody who has never
   * opened the herd code, so they get their own stream and can be changed
   * freely for ever after. (Splitting it moves the herd exactly ONCE — this
   * commit — and never again.)
   *
   * It is also what makes the recycler below free of consequences: it draws at
   * run time, from here, so a butterfly being reseated cannot perturb anything
   * else's future.
   */
  const flutterRng = makeRng(`${seed}:flutter`);

  /**
   * Seat one butterfly: where it lives, what species it is, how it flies.
   *
   * ONE FUNCTION FOR BOTH LOAD AND RECYCLE, which is the point. It is called
   * twenty times at build with the roam anchor still at the origin — reproducing
   * exactly the placement a fresh world has always had — and then again, one
   * instance at a time, whenever the player walks far enough that a butterfly is
   * no longer anywhere near them.
   *
   * The species is re-rolled on every seating rather than being a fact about
   * the slot. It costs four attribute writes on a twenty-instance mesh, i.e.
   * nothing, and it is what stops a two-kilometre walk being accompanied by the
   * same four morphos the world happened to deal at load.
   *
   * The radius is drawn from sqrt so the disc fills EVENLY. Drawing r linearly
   * is the standard mistake and it piles everything on the player, which is the
   * exact failure the ring-seating note warns about: a uniform r puts half the
   * butterflies inside 17 m of a 30 m disc that only holds a quarter of the area.
   */
  function seatFlutter(i) {
    /**
     * FOUR CANDIDATES, AND THE MOST OPEN ONE WINS.
     *
     * A morpho crossing a shaft of light is the image; the same morpho in
     * closed shade is a dark speck, and no amount of colour work fixes that
     * because the wing is lit by what is above it. So the seating asks the
     * trunk index how far the nearest tree is and keeps the airiest of four
     * throws — a cheap, honest proxy for a canopy gap, since a gap in this
     * forest IS an absence of trunks and the light shafts are drawn through
     * exactly those holes.
     *
     * FOUR AND NOT TWENTY. This is a preference, not a filter, and the
     * difference matters: a hard "must be in a gap" test would fail in closed
     * wood and either loop until it gave up or pile every butterfly into the one
     * clearing, which is the trap the ring-seating note describes. Best-of-four
     * shifts the distribution toward the light and still puts one over the leaf
     * litter now and then, which is also true of real ones.
     *
     * `12` is the search radius, not a distance to beat: `near` returns null
     * when there is no trunk within it, and null is the best possible answer —
     * that is open sky.
     */
    let x = 0;
    let z = 0;
    let best = -1;
    for (let t = 0; t < 4; t++) {
      const a = flutterRng() * TAU;
      const r = Math.sqrt(
        FLUTTER_NEAR * FLUTTER_NEAR +
          flutterRng() * (FLUTTER_FAR * FLUTTER_FAR - FLUTTER_NEAR * FLUTTER_NEAR)
      );
      const cx = roamX + Math.cos(a) * r;
      const cz = roamZ + Math.sin(a) * r;
      const near = trunks.near(cx, cz, 12);
      const open = near === null ? 999 : Math.hypot(near.x - cx, near.z - cz);
      if (open <= best) continue;
      best = open;
      x = cx;
      z = cz;
    }

    /**
     * THE MORPHOS ARE DEALT, THE REST ARE ROLLED.
     *
     * A weighted roll over eight instances has enormous variance, and the first
     * build of this proved it: at a 37% weight the seeded world dealt ONE morpho
     * and three julias, so the one butterfly the entire pass exists for was
     * almost absent from the world that every screenshot and every benchmark in
     * this repo is pinned to. Weighting harder does not fix that, it just moves
     * where the bad rolls are.
     *
     * So the first MORPHO_SLOTS slots ARE morphos, always, everywhere, and the
     * rest draw from the pigment species. It is the same argument as the
     * perchers' roster being dealt so that all sixteen voices are present: when
     * a population is small enough to count, a distribution is a wish and a deal
     * is a fact. The slot keeps its role across recycling, so the mix is stable
     * as you walk while the individuals are not.
     */
    let kind = WINGS[0];
    if (i >= MORPHO_SLOTS) {
      let pick = flutterRng() * PIGMENT_TOTAL;
      kind = PIGMENT[0];
      for (const k of PIGMENT) {
        pick -= k.w;
        if (pick <= 0) {
          kind = k;
          break;
        }
      }
    }

    flutterFlight.setXYZW(
      i,
      rngRange(flutterRng, 0.9, 2.8),
      rngRange(flutterRng, 0.45, 0.95) * (flutterRng() < 0.5 ? -1 : 1),
      flutterRng() * TAU,
      0.1
    );
    /**
     * `aBeat.y` is a METRE offset in the shared flyer shader — it displaces the
     * wingtip directly, the same term a bird's 0.13–0.2 uses against its 0.31 m
     * half-span. A bare fraction here was that mistaken for the metre value
     * itself once already, and it swung the wingtip through fourteen times the
     * insect's own wingspan every beat. `kind.beat[0]` is the fraction of the
     * species' own half-span, so it stays "claps its wings nearly shut" in the
     * butterfly's units whatever size the butterfly is.
     *
     * The rate is the species too, and it separates them at a glance without
     * anybody having to see a colour: a heliconius is famously slow and floppy
     * (~6 Hz here), a sulphur is a fast erratic flicker (~11.5), and the
     * morpho's slow deep beat is exactly what gives the blink time to register.
     * A single 10–15 for all of them made every butterfly in the wood a moth.
     */
    flutterBeat.setXYZW(
      i,
      flutterRng() * TAU,
      kind.beat[0] * FLUTTER_SPAN * 0.5 * kind.size,
      kind.beat[1] * rngRange(flutterRng, 0.9, 1.12),
      kind.size * rngRange(flutterRng, 0.88, 1.12)
    );
    flutterHome.setXYZ(i, x, heightAt(x, z) + rngRange(flutterRng, 1.1, 2.7), z);
    /**
     * A NARROW LIFT, 0.92–1.1, where it used to be 0.88–1.32.
     *
     * The wide spread was doing the whole job of making twenty identical
     * marigolds not look identical, and it is the wrong tool now that each one
     * is a named species: at 1.32 a morpho's blue clips toward cyan and at 0.88
     * a postman's scarlet bar goes maroon, which is two different butterflies
     * rather than two individuals of one. Same argument, same fix, as the
     * birds' `shade` range. It stays non-zero because a butterfly caught from
     * below against the sky genuinely is brighter than one over the litter.
     */
    const lift = rngRange(flutterRng, 0.92, 1.1);
    flutterTint.setXYZ(i, kind.coat[0] * lift, kind.coat[1] * lift, kind.coat[2] * lift);
    flutterBuild.setXYZW(i, kind.build[0], kind.build[1], kind.build[2], 1);
    flutterMark.setXYZW(
      i,
      kind.mark[0] * lift,
      kind.mark[1] * lift,
      kind.mark[2] * lift,
      kind.reach * rngRange(flutterRng, 0.88, 1.12)
    );
    flutterUnder.setXYZW(i, kind.under[0], kind.under[1], kind.under[2], kind.flash);
  }

  for (let i = 0; i < BUTTERFLIES; i++) {
    seatFlutter(i);
    butterflies.setMatrixAt(i, _m.identity());
  }
  const flutterAttrs = [
    flutterFlight,
    flutterBeat,
    flutterHome,
    flutterTint,
    flutterBuild,
    flutterMark,
    flutterUnder,
  ];
  for (const a of flutterAttrs) a.needsUpdate = true;
  butterflies.instanceMatrix.needsUpdate = true;
  group.add(butterflies);

  /**
   * Butterflies follow you, one at a time.
   *
   * THE OTHER LAYERS DO THIS TWO OTHER WAYS AND NEITHER FITS. The flocks jump
   * their whole centre at once every 190 m, which is invisible when a flock is
   * eighty metres up and would be a row of insects teleporting in your face at
   * this range. The beasts recycle individually on a frustum-and-peer-cone test,
   * which is the right shape but far more machinery than a 13 cm object that
   * has no state, makes no sound and cannot be interacted with needs.
   *
   * So: twenty distance tests, and any butterfly further away than FLUTTER_DROP
   * is reseated somewhere in the near annulus. The gap between DROP and FAR is
   * the hysteresis and the invisibility both — see the constants.
   *
   * DERIVED PER CLIENT, ON PURPOSE, and it does not violate host authority.
   * The rule in this file is that anything with STATE is simulated by the host
   * and broadcast; the things every client derives for itself are the ones whose
   * answer is a fact about the local observer — draw culling, audio loudness,
   * the flocks' centre. A butterfly is entirely in that second class: its whole
   * flight is a closed form of `uTime`, its position is a pure function of a home
   * and a clock every client shares, and there is nothing about it another player
   * could ever disagree with you about. Making it travel would be eight numbers
   * a tick to tell you where an insect you cannot touch is.
   */
  function followFlutters(x, z) {
    let moved = false;
    for (let i = 0; i < BUTTERFLIES; i++) {
      const dx = flutterHome.getX(i) - x;
      const dz = flutterHome.getZ(i) - z;
      if (dx * dx + dz * dz < FLUTTER_DROP * FLUTTER_DROP) continue;
      seatFlutter(i);
      moved = true;
    }
    if (!moved) return;
    for (const a of flutterAttrs) a.needsUpdate = true;
  }

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
   * EVERY GROUND ANIMAL IN ONE FLAT LIST, AND THIS IS THE WIRE ORDER.
   *
   * `BEASTS` is an object literal and `herds` is built by iterating it, so this
   * ordering — deer, then rabbits, then squirrels, each in construction order —
   * is fixed by the source and identical in every tab that loads this file.
   * That is the whole addressing scheme: index 7 is the same rabbit on eight
   * machines, so nothing about which animal a row describes has to be sent.
   *
   * It costs one array of references to objects that already exist, built once.
   */
  const everyone = herds.flatMap((h) => h.members);

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
    /**
     * THE SHAFTS ARE ONE INSTANCED MESH NOW, AND READING `children` FOR THEIR
     * PLACES SILENTLY PUTS EVERY MIDGE COLUMN ON THE WORLD ORIGIN.
     *
     * This loop used to walk 25 separate Meshes and take each one's
     * `position`. The sun shafts were instanced into a single InstancedMesh —
     * one draw call instead of 25, which is what paid for the lattice getting
     * denser — and the per-shaft transform moved out of `mesh.position` and
     * into `instanceMatrix`. So `children` became a list of ONE, whose
     * `position` is (0, 0, 0) because that is where an InstancedMesh sits when
     * its instances carry the transforms.
     *
     * The failure was not a crash and not an empty swarm. It was 880 midges
     * dealt round a column list that had gone from 25 entries to 1-plus-11
     * padding, so every column carried roughly twice the insects it was
     * designed for AND one of them sat on the origin — eight metres from where
     * the player spawns. Additive sprites overlapping at that density sum to
     * white, so it read as two hard blobs of confetti hanging in the clearing,
     * and it looked like a bug in the particle system rather than a bug in an
     * address.
     *
     * Read the instance matrices instead. Taking a PREFIX is safe and is the
     * reason the count below is a slice rather than a filter: the shaft cells
     * are sorted nearest-first at build time, so the first N are the closest N.
     * Twenty-four keeps the per-column density the comment below is written
     * about, and keeps `columns.length` above the 12-column floor, which means
     * the padding loop still draws no random numbers and the fauna RNG stream
     * is bit-for-bit what it was.
     */
    const MIDGE_COLUMNS = 24;
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    for (const mesh of shaftGroup.children) {
      const params = mesh.geometry?.parameters;
      if (!params) continue;
      if (mesh.isInstancedMesh) {
        const n = Math.min(mesh.count, MIDGE_COLUMNS);
        for (let i = 0; i < n; i++) {
          mesh.getMatrixAt(i, _m);
          _p.setFromMatrixPosition(_m);
          columns.push({
            x: _p.x,
            y: _p.y + params.height * 0.28,
            z: _p.z,
            r: Math.min(1.0, Math.max(0.32, (params.radiusBottom ?? 2) * 0.2)),
            h: 0.85,
          });
        }
        continue;
      }
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

  /**
   * THE SWARM FOLLOWS YOU NOW, AND UNTIL THIS IT WAS THE ONLY LAYER THAT DID NOT.
   *
   * Everything above is seeded once, in a disc of radius 6–98 m around the world
   * ORIGIN, and was then never written again. In a world that streams outward
   * for ever that is not a seeding strategy, it is a bug with a performance
   * symptom: walk a hundred and twenty metres from spawn and there are no midges
   * and no fireflies anywhere, for the rest of the session — while the draw call,
   * the 1340 vertex-shader invocations and the transparent-queue entry are all
   * still submitted every frame, because `frustumCulled` is false. Dusk in the
   * deep wood had nothing in the air and nobody had noticed, because the station
   * the suite measures and the place you spawn are both inside the disc.
   *
   * THE FLOCK IDIOM, NOT THE BUTTERFLY ONE. `followFlutters` reseats individuals
   * on a 17 m radius because a butterfly is close enough that a jump would
   * happen in your face. This is the other case, and `followFlocks`'s comment
   * describes it exactly: move the whole cloud at once, from far enough away
   * that no part of it is on screen. The fade in the swarm shader is 30 m for a
   * midge and 66 m for a firefly, so a step taken at 150 m is invisible by
   * construction rather than by taste.
   *
   * SLICED, because re-grounding 1340 points is 1340 `heightAt` calls and this
   * file already prices those at ~0.29 ms per 289. Nothing is visible while the
   * move is in progress — that is the premise of taking it at 150 m — so
   * spending 28 frames on it costs nothing and a one-frame spike would be the
   * only part of this a player could detect.
   *
   * `swarmLift` is what makes a translated cloud keep its shape: each point
   * remembers how far above the terrain it was seeded, so re-grounding is one
   * `heightAt` and an add, and a midge column stays a column.
   */
  const swarmLift = new Float32Array(SWARM);
  for (let i = 0; i < SWARM; i++) {
    swarmLift[i] = swarmPos[i * 3 + 1] - heightAt(swarmPos[i * 3], swarmPos[i * 3 + 2]);
  }
  /** How far you may walk from the cloud's centre before it is moved to you. */
  const SWARM_STEP = 150;
  /** Points re-grounded per frame while a move is in progress. */
  const SWARM_SLICE = 48;
  const swarmAnchor = { x: 0, z: 0 };
  let swarmShiftX = 0;
  let swarmShiftZ = 0;
  let swarmCursor = SWARM;

  function followSwarm(x, z) {
    if (swarmCursor >= SWARM) {
      const dx = x - swarmAnchor.x;
      const dz = z - swarmAnchor.z;
      if (dx * dx + dz * dz < SWARM_STEP * SWARM_STEP) return;
      // Latch the whole translation up front, so a player who keeps walking
      // during the sweep does not leave half the cloud behind at an anchor that
      // has since moved again.
      swarmShiftX = dx;
      swarmShiftZ = dz;
      swarmAnchor.x = x;
      swarmAnchor.z = z;
      swarmCursor = 0;
    }
    const end = Math.min(SWARM, swarmCursor + SWARM_SLICE);
    for (let i = swarmCursor; i < end; i++) {
      const px = swarmPos[i * 3] + swarmShiftX;
      const pz = swarmPos[i * 3 + 2] + swarmShiftZ;
      swarmPos[i * 3] = px;
      swarmPos[i * 3 + 2] = pz;
      swarmPos[i * 3 + 1] = heightAt(px, pz) + swarmLift[i];
    }
    const attr = swarmGeo.getAttribute('position');
    attr.clearUpdateRanges();
    attr.addUpdateRange(swarmCursor * 3, (end - swarmCursor) * 3);
    attr.needsUpdate = true;
    swarmCursor = end;
  }

  // -------------------------------------------------------------------------
  // the loop
  // -------------------------------------------------------------------------

  let elapsed = 0;
  /** Midges, fireflies and butterflies. See the `small` block in `update`. */
  let smallLife = true;

  /**
   * THE OTHER PEOPLE IN THE WOOD, IF THERE ARE ANY.
   *
   * `{x, y, z, yaw}` each, refreshed by main.js from the net layer's peers, and
   * empty for the whole of single player — which is what keeps every path below
   * exactly what it was when this file had one pair of eyes to think about.
   */
  let observers = [];

  /**
   * Whether THIS machine is the one deciding what the animals do.
   *
   * True on a solitary walk, true for exactly one person in a room, false for
   * everybody else — see `setHosting` and the header on `snapshot`. A guest runs
   * every line of this file except the deciding: it culls, poses, gaits, sounds
   * and draws, and takes position and intent off the wire instead of off the
   * state machine.
   */
  let hosting = true;

  /** Where the coat round-robin has got to. See `COATS_PER_SEND`. */
  let coatCursor = 0;

  /**
   * Is this point in the frame — ANY frame, belonging to anybody?
   *
   * Used to decide when a creature may be moved, NOT when it may be drawn. A
   * creature that teleports while you are looking at it is the worst artefact
   * this system can produce, and the whole "you glimpsed it and now it is gone"
   * effect depends on the move being unobservable.
   *
   * WHICH IS WHY THIS TAKES A ROOM AND NOT A CAMERA. The local frustum is exact
   * and free, because the local camera is right here; everybody else gets the
   * cone test described at `PEEK_COS`, because a position and a yaw is all that
   * crosses the network. With nobody else in the wood the loop body never runs
   * and this is the function it has always been.
   *
   * Only the host calls it — recycling is a decision — but it is a decision made
   * on everyone's behalf, and getting it wrong is the one failure in this whole
   * feature that a guest would see rather than the host.
   */
  function unseen(p, radius) {
    _sphere.center.copy(p);
    _sphere.radius = radius;
    if (_frustum.intersectsSphere(_sphere)) return false;
    for (const o of observers) {
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      const d = Math.hypot(dx, dz);
      // Close enough to be noticed at all. Past this an animal is a speck in
      // fog for them however directly they are facing it, and holding the
      // recycler on that basis would strand animals nobody can see.
      if (d > FAR.deer) continue;
      // Standing on top of it: no facing test survives a zero-length vector,
      // and somebody that close can see it whichever way they turn.
      if (d < radius + 2) return false;
      // `yaw` is the same convention the avatars use — 0 is -Z, and x leads.
      if ((dx * Math.sin(o.yaw) + dz * Math.cos(o.yaw)) / d > PEEK_COS) return false;
    }
    return true;
  }

  /**
   * The eye an animal is reacting to: the nearest one, in the plane.
   *
   * THE ONE BEHAVIOURAL CHANGE THAT MULTIPLAYER FORCED, and it is a fix rather
   * than a compromise. Every distance in `updateHerd` — notice, flee, watch,
   * which way to run — used to be measured against the local camera, because
   * there was only ever one. Kept that way in a room, the host's own approach
   * would be the only one that could startle anything: four people could walk
   * through a herd and the deer would go on grazing, then all bolt at once when
   * the host arrived from the other side. The nearest observer is what "you
   * walked too close to it" always meant.
   *
   * Returns a scratch vector, valid until the next call, and the local camera
   * whenever the wood is empty of other people.
   */
  function nearestEye(m, camera) {
    _eye.copy(camera.position);
    if (observers.length === 0) return _eye;
    let best = (m.pos.x - _eye.x) ** 2 + (m.pos.z - _eye.z) ** 2;
    for (const o of observers) {
      const d2 = (m.pos.x - o.x) ** 2 + (m.pos.z - o.z) ** 2;
      if (d2 < best) {
        best = d2;
        _eye.set(o.x, o.y, o.z);
      }
    }
    return _eye;
  }

  function updatePerchers(dt, camera, tripLevel) {
    /**
     * SEAT THE ROSTER ONCE THERE ARE TREES TO SEAT IT IN, AND THIS IS A BUG FIX
     * RATHER THAN A REFINEMENT.
     *
     * `pickPerch` puts a bird on a real trunk at real bough height four times in
     * five and on the ground the fifth, which is about right for a wood. What it
     * actually produced was NINETY-SIX PER CENT OF THEM ON THE GROUND — measured,
     * over a live session, by sampling `pos.y - heightAt(pos)` across the roster:
     * median 23 cm, which is the ground fallback's own range and nothing else.
     *
     * The cause is an ordering that only became wrong when the forest started
     * streaming. `trunkIndex` used to walk the collider list once at load; it is
     * now a QUERY against `colliderGrid`, which is the right change and is what
     * lets a bird two kilometres out perch on a tree that did not exist at boot.
     * But main.js builds the forest and then immediately builds the fauna, and at
     * that instant not one sector has streamed in — so the grid holds the loose
     * colliders and no trunks at all, every one of twenty-six `pickPerch` calls
     * misses, and the entire roster is seeded in the grass. Nothing ever moved
     * them, either: a perched bird is only re-seated when you walk PERCH_FAR away
     * from it, so standing anywhere near where you spawned left them there.
     *
     * This is the whole of "birds only ever fly overhead". The birds you could
     * see in the air were the ninety-six flock instances, which is exactly what
     * they are for; the twenty-six that were supposed to be in the branches were
     * in the undergrowth, below the grass, in a wood whose ground cover is waist
     * high.
     *
     * The fix is to wait for the trees, and WAIT FOR ENOUGH OF THEM, which is
     * the whole of the second attempt at this.
     *
     * Two versions of "wait" were wrong before this one, and both failed the
     * same way — they seated the roster while the ring was still streaming
     * OUTWARD, when the only trunks in the world were the ones under the
     * player's feet.
     *
     *   Latching on the first trunk anywhere near the camera moved the number
     *   from 4% in the branches to 6%: on the frame that check passes there is
     *   one sector beneath you and nothing at forty metres, so twenty-five of
     *   the twenty-six re-picks land in the same grass they started in.
     *
     *   Retiring each bird individually as its own pick found a tree was worse
     *   in a way that took a distance histogram to see. It looks unbiased and it
     *   is the opposite: a bird whose candidate lands near the player is retired
     *   on frame one, a bird whose candidate lands at fifty metres finds nothing
     *   and is re-rolled, so the roster is filtered by proximity. SEVENTEEN OF
     *   TWENTY-SIX BIRDS ENDED UP INSIDE SIXTEEN METRES, the wood turned into an
     *   aviary, and the audio ceiling was pinned at 58 of 58.
     *
     * So: ask whether the forest exists AT THE FAR EDGE OF THE BAND, in four
     * directions, and only then place everybody, once. Four grid queries a frame
     * for the handful of frames the entry gate is already waiting through, and
     * the gate is opaque, so there is nothing to see — which is why `unseen` is
     * not consulted.
     *
     * The frame cap is the backstop for a spawn with genuinely no trees at that
     * radius: open moor, or a seed that puts the clearing on a lake shore. There
     * the roster seats itself late and takes whatever `pickPerch` can find,
     * which is the same answer it would have given anyway.
     */
    if (!seated) {
      seatingFrames++;
      /**
       * THREE OF FOUR, AT 60% OF THE BAND, and both numbers are a compromise
       * against how long the player waits rather than against correctness.
       *
       * Four probes at 80% of the band is the strict reading of "the ring has
       * streamed", and it took EIGHT SECONDS to satisfy — long enough that a
       * player who clicks straight through the menu spends their first eight
       * seconds in a wood whose birds are all in the grass. Requiring three of
       * the four covers the case the strict test exists for, which is the ring
       * being one sector wide, while tolerating the ordinary case of one bearing
       * pointing at the stream, a clearing or a slope with no trunk on it — and
       * that lone bearing is exactly what the strict test was waiting out.
       */
      let ring = 0;
      const probe = PERCH_BAND * 0.6;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + 0.7;
        const px = camera.position.x + Math.cos(a) * probe;
        const pz = camera.position.z + Math.sin(a) * probe;
        if (trunks.near(px, pz, 14)) ring++;
      }
      if (ring >= 3 || seatingFrames > 300) {
        seated = true;
        for (const p of perchers) {
          pickPerch(p.home, camera.position.x, camera.position.z, PERCH_NEAR, PERCH_BAND);
          p.pos.copy(p.home);
        }
      }
    } else if (!settled) {
      /**
       * AND THEN ONE SECOND PASS, FOR THE ONES THAT STILL FOUND NOTHING.
       *
       * Seating early and seating well pull against each other: the strict
       * four-bearing test took eight seconds and put 85% of the roster in the
       * branches, the relaxed one takes two and manages 65%, and the difference
       * is entirely birds whose radius happened to fall on a sector that had not
       * arrived yet. Neither number is the one to keep — there is no reason to
       * choose, because the two failures are separated in TIME.
       *
       * So the wood fills immediately and is then corrected: once the ring is
       * properly out, every bird still standing in the grass gets one more roll.
       * It cannot reintroduce the proximity bias that the per-bird retry had,
       * and the reason is the whole point of waiting — by now trees exist at
       * every radius in the band, so a re-roll is no longer filtered by how far
       * out it landed.
       *
       * ONE pass, and `unseen` is honoured this time. The gate may well be down
       * by now, and a bird that vanishes off the leaf litter while you are
       * looking at it is the teleport this file spends most of its recycler
       * avoiding. A bird being watched simply keeps its ground perch, which is a
       * perfectly good thing for a tinamou to be doing.
       */
      settleFrames++;
      let ring = 0;
      const probe = PERCH_BAND * 0.85;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + 2.1;
        const px = camera.position.x + Math.cos(a) * probe;
        const pz = camera.position.z + Math.sin(a) * probe;
        if (trunks.near(px, pz, 14)) ring++;
      }
      if (ring === 4 || settleFrames > 900) {
        settled = true;
        for (const p of perchers) {
          if (p.state !== 'perch') continue;
          if (p.pos.y - heightAt(p.pos.x, p.pos.z) > 1.5) continue;
          if (!unseen(p.pos, 2)) continue;
          pickPerch(p.home, camera.position.x, camera.position.z, PERCH_NEAR, PERCH_BAND);
          if (!unseen(p.home, 2)) continue;
          p.pos.copy(p.home);
        }
      }
    }

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
       * PERCH_FAR is past the PERCH_BAND the flush itself re-seats within, so
       * this cannot fight with that; and it only ever fires while the bird is
       * out of frame, so what the player sees is a bird that was always there.
       *
       * It came down from 150 with the band, and by more than the band did. The
       * clearance is what has to be preserved rather than the number — 30 m of
       * it here — because a bird re-seated at the far edge of the band must not
       * immediately qualify to be re-seated again, which is a bird that moves
       * every frame the player walks away from it.
       */
      const PERCH_FAR = 88;
      if (dist > PERCH_FAR && p.state === 'perch' && unseen(p.pos, 2)) {
        if (
          pickPerch(p.home, camera.position.x, camera.position.z, PERCH_NEAR, PERCH_BAND) &&
          unseen(p.home, 2)
        ) {
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
            // Whatever it was in the middle of saying, it has stopped. The
            // phrase itself is already scheduled and will finish in the air,
            // which is exactly what a flushed bird sounds like.
            p.show = 0;
            // Away from you, upward, and biased along whatever direction it was
            // already facing — a bird does not reverse out of a bush.
            const away = Math.atan2(dx, dz) + rngRange(rng, -0.5, 0.5);
            // A heavy bird gets away faster once it is going and climbs less
            // steeply doing it; a manakin flicks off the branch and is gone
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

          /**
           * AND EVERY SO OFTEN IT SIMPLY MOVES, WHICH IS THE OTHER HALF OF
           * "BIRDS SHOULD LAND ON TREES".
           *
           * Landing after a flush is an arrival you caused, and it is over in
           * the second and a half you spend recovering from having caused it.
           * The thing a wood actually does — constantly, in the corner of your
           * eye, all day — is that a bird you were not looking at crosses a gap
           * and settles somewhere else. Nothing frightened it and nothing is
           * happening; it just went. That is the difference between a wood with
           * animals in it and a wood with animal events in it.
           *
           * IT IS THE ONE THING HERE THAT WANTS TO BE SEEN. Every other move in
           * this file is hidden behind `unseen` because it is a recycle wearing
           * a bird costume, and a recycle you witness is a teleport. This is not
           * a recycle — the bird flies the whole way — so there is nothing to
           * hide, and the check is inverted: it only bothers when somebody is
           * close enough to watch, because a hop nobody sees is wingbeats and
           * a `land` state spent on an empty wood.
           *
           * WHAT IT COSTS, since twenty-six birds could make this expensive: at
           * 22–72 s apart and only inside 46 m, about eight or nine hops a
           * minute across the whole roster, each one a handful of grains from
           * `wingbeats` and a few seconds of the same per-bird arithmetic the
           * loop was already doing. No allocation — `pickPerch` writes into the
           * bird's own `home` — and no draw calls, because these are instances
           * that were being submitted anyway.
           */
          p.hop -= dt;
          if (p.hop <= 0) {
            p.hop = rngRange(rng, 22, 72);
            if (dist < 46) {
              // Six to twenty metres: far enough to be a flight, near enough
              // that the bird stays in the piece of wood you are standing in.
              pickPerch(p.home, p.pos.x, p.pos.z, 6, 20);
              const tx = p.home.x - p.pos.x;
              const tz = p.home.z - p.pos.z;
              const heading = Math.atan2(tx, tz);
              // A push off the branch, and then `land` flies it. Gentler than a
              // flush's launch by half, because nothing is chasing it.
              p.vel.set(Math.sin(heading) * 3.4, 1.9, Math.cos(heading) * 3.4);
              p.yaw = heading;
              p.state = 'land';
              p.timer = 0;
              // A bird in the air is not displaying, and the compose block's
              // pump reads `show` in every state. A long phrase can still be
              // sounding when the early hop this song bought fires — see the
              // hop bid in the sing block.
              p.show = 0;
              /**
               * `wingbeats` and NOT `flush`. A flush carries a sub-200 Hz whump,
               * an alarm note and `_startle`, which stops the entire chorus for
               * four seconds — correct for a bird you frightened and ruinous
               * here, since a wood where every voluntary hop silences every
               * other bird is a wood that is silent. See the header on
               * `wingbeats`.
               */
              wildlife?.wingbeats(p.pos, {
                nearness: clamp01(1 - dist / 46),
                gain: 0.6,
                travel: { x: tx, y: p.home.y - p.pos.y, z: tz },
              });
              // "Going." Half the small birds in a wood say something as they
              // leave a branch, and the flight call is already the note falling
              // away while the panner carries it across you.
              if (rng() < 0.3) wildlife?.call(p.pos, p.voice, 'flight', { gain: 0.85 });
            }
          }
        }

        p.sing -= dt * (p.watcher ? 1.6 : 1);
        if (p.sing <= 0) {
          /**
           * THE BIRD YOU CAN SEE GETS TO SING FIRST, and this is the third and
           * last answer to "I can hear birds and I can never spot one".
           *
           * The first two were range and appearance — the roster came inside
           * the forty metres this forest lets you see through, and it stopped
           * being twenty small brown birds. What neither of them touched is
           * that a bird twenty metres away with a trunk in front of it is, for
           * every purpose a player has, not there: you hear it clearly, you
           * turn, and you are looking at bark. Do that four times in a minute
           * and the honest conclusion is that the birds are fake.
           *
           * So a bird whose sight line is blocked, or which is beyond seeing
           * range anyway, DEFERS about half the time — it does not sing now, it
           * waits a few seconds and asks again. Nothing is silenced and nothing
           * is teleported; what changes is which of twenty-six candidates
           * spends the token, and the effect compounds with the leaky bucket in
           * `wildlife.js` rather than fighting it. The bucket decides how much
           * song there is; this decides who.
           *
           * IT IS A MULTIPLIER ON THE INTERVAL AND NOT A COIN FLIP, AND THE
           * FIRST VERSION WAS THE COIN FLIP. That version deferred an
           * unfindable bird 45% of the time and had it try again in four to
           * twelve seconds, which sounds like a strong bias and is arithmetically
           * almost nothing: expected extra wait is 0.82 firings × 8 s ≈ 6 s on a
           * forty-second timer, a 14% rate reduction. Measured over four
           * seventy-five-second runs it moved the share of near bird sounds
           * coming from a bird in sight to 68, 82, 69 and 68 per cent against a
           * control of 68 and 69 — which is to say it did nothing that thirty
           * events could distinguish from noise.
           *
           * A multiplier does not need a sample to be believed. 0.55 against
           * 1.45 is a bird you can see singing two and two thirds times as often
           * as one you cannot, every time.
           *
           * THE TWO NUMBERS ARE NORMALISED ON RATE AND NOT ON INTERVAL, AND THE
           * FIRST PAIR WAS NORMALISED ON THE WRONG ONE. They were 0.45 and 1.2,
           * chosen so that the MEAN INTERVAL across a roster about 28% findable
           * came out at 0.99 — which looks neutral and is not, because a rate is
           * `E[1/T]` and an interval is `E[T]`, and Jensen's inequality says the
           * first is strictly larger. The actual demand went up by
           * `0.28/0.45 + 0.72/1.2 = 1.22`, and the wood duly measured 45 phrases
           * a minute against 36 before — a fifth more audio work than the change
           * was supposed to cost, every minute, for ever.
           *
           * 0.55 and 1.45 give `0.28/0.55 + 0.72/1.45 = 1.006`. Same ratio
           * between the two kinds of bird, same distribution, and the wood asks
           * for what it asked for before. It matters because the leaky bucket in
           * `wildlife.js` is no longer the binding constraint — measured, the
           * wood emits about 36 of the 39 phrases a minute it asks for — so
           * demand added here is not throttled away somewhere else, it is real
           * oscillators and a real HRTF panner per phrase.
           *
           * AND THE BIAS IS NOT TOTAL. A forest where every audible bird is in
           * your line of sight is a stage set, and the distant chorus and the
           * answering bird in `wildlife.js` are both built on the opposite
           * principle: a voice from somewhere you cannot see is most of what
           * makes the place feel bigger than you. This moves the balance; it
           * does not pick a side.
           */
          const findable = dist < SIGHT_RANGE && clearLine(camera.position, p.pos);
          // Only sing where you might hear it. A song scheduled at 140 m is
          // audio nodes spent on silence.
          if (dist < 62) {
            const sung = wildlife?.song(p.pos, p.voice, { answer: true });
            /**
             * IT PERFORMS FOR EXACTLY AS LONG AS IT IS SOUNDING.
             *
             * `song` returns the phrase or null — null when the leaky bucket
             * refused it — and the length is rolled per rendition inside
             * `_phrase`, so both facts have to come back from the audio rather
             * than be guessed here. A bird miming to a refused token is the
             * one thing worse than a bird standing still.
             *
             * Capped at seven seconds because a musician wren streams for up to
             * twenty and no animal displays continuously for twenty seconds;
             * it sings on and stops throwing itself about.
             */
            if (sung) {
              p.show = Math.min(sung.dur, 7);
              /**
               * AND THEN IT MOVES, WHICH IS WHAT ACTUALLY MAKES YOU FIND ONE.
               *
               * Colour is worth less in here than it looks on paper: at
               * twenty-five metres, in canopy shadow, a toucan is sixty pixels.
               * MOTION at twenty-five metres is unmissable, because peripheral
               * vision is built for nothing else — and this file already has
               * the perfect motion in it, the voluntary hop, doing nothing but
               * firing on a 22-72 s timer that has never once known where you
               * were looking.
               *
               * So a bird that has just sung NEAR you and is OUT OF YOUR VIEW
               * brings its next hop forward to a second or four. The sequence
               * that produces is the entire point of this pass: a song off to
               * your left, you turn toward it, and a bird crosses a gap in
               * front of you. Nothing was scripted and nothing teleported — it
               * flies the whole way, on its own schedule, a little early.
               *
               * `unseen` and not `!unseen`, which is the opposite of every
               * other use of it in this file. Everywhere else the check hides a
               * recycle; here it is asking WHETHER YOU STILL HAVE TO TURN,
               * because a bird already in frame does not need to announce
               * itself and a bird that hops the instant you look at it is a bird
               * reacting to you.
               *
               * Half the time, so it stays a coincidence you noticed rather
               * than a rule you learn — and only inside thirty metres, which is
               * the same 25-30 m gate the landing song has and for the same
               * reason: every early hop costs `wingbeats` and a bid at a
               * fixed-rate bucket, and bids that lose are the reason somebody
               * else's bid lost.
               */
              if (dist < 30 && unseen(p.pos, 2) && rng() < 0.5) {
                p.hop = Math.min(p.hop, rngRange(rng, 1.6, 4.5));
              }
            }
          }
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
          /**
           * AND NEARER BIRDS ASK MORE OFTEN, which is the half of the argument
           * above that was never actually implemented.
           *
           * The reasoning was that a fixed low rate distributes song by
           * proximity rather than by lottery — but the timer itself did not
           * know how far away the bird was, so all it really did was reduce
           * demand evenly and leave the distribution to the bucket. Measured,
           * the wood came out at 68 bird sounds a minute with only 11 of them
           * inside 30 m and NONE inside 10, which is a chorus happening
           * somewhere else. That is the shape of "I don't hear bird songs":
           * plenty of song, nearly all of it at the range where the distance
           * low-pass and the wet tail have taken it apart.
           *
           * Scaled so a bird at your elbow asks about twice as often as one at
           * the 62 m audibility edge. The mean is close to unchanged, so this
           * is the same amount of birdsong yet again — moved inward, where you
           * can hear what it actually is.
           */
          const near = 0.55 + 0.75 * clamp01(dist / 62);
          // And the bird you can actually see asks two and two thirds times as
          // often as the one behind a trunk, at the same TOTAL rate. See the
          // block above `findable`.
          p.sing =
            rngRange(rng, 16, 70) * (p.hen ? 2.3 : 1) * near * (findable ? 0.55 : 1.45);
        }
        /**
         * SITTING STILL — OR SINGING, WHICH LOOKS COMPLETELY DIFFERENT.
         *
         * `p.show` is seconds of phrase left, handed back by `wildlife.song`
         * above. While it runs the bird does the three things a small bird
         * actually does while singing, and every one of them is a number that
         * was already being written to this attribute every frame:
         *
         *   THE WINGS PART AND SHIVER. Spread goes from 0.04 to about 0.18,
         *   which through the shader's `mix(0.13, 1.0, rrOpen)` is a silhouette
         *   over half as wide again, with a fast small flick on top of it. It
         *   is deliberately well short of the 1.0 a launch uses — a singing
         *   bird quivers its wings, it does not hold them out.
         *
         *   THE BEAT SPEEDS UP AND DEEPENS. Three times the idle shuffle's
         *   amplitude at three times its rate.
         *
         *   IT PUMPS AND TURNS, which is the compose block at the bottom of the
         *   loop: a centimetre or two of vertical throw on the body and a few
         *   degrees of yaw, both off the bird's own phase so no two do it
         *   together.
         *
         * WHY THIS IS WORTH ANYTHING AT ALL, given that a bird at twenty-five
         * metres is sixty pixels: because motion at the edge of vision is the
         * one thing that survives being sixty pixels. A colour has to be
         * looked at. A movement is what makes you look.
         */
        if (p.show > 0) {
          p.show -= dt;
          const flick = Math.sin(elapsed * 9.5 + p.beat * 2.7);
          p.open = damp(p.open, 0.18 + 0.05 * flick, 0.02, dt);
          birdBeat.setXYZW(
            p.slot,
            p.beat,
            0.055 + 0.045 * Math.abs(flick),
            9.0 * p.wing,
            p.scale
          );
        } else {
          // Wings folded, with a shuffle you can only see close up.
          p.open = damp(p.open, 0.04, 0.001, dt);
          birdBeat.setXYZW(
            p.slot,
            p.beat,
            0.02 + 0.03 * Math.max(0, Math.sin(elapsed * 1.7 + p.beat * 3)),
            3.0 * p.wing,
            p.scale
          );
        }
      } else if (p.state === 'flee') {
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
        // here as well would give a toucan a wingbeat you could not see.
        birdBeat.setXYZW(
          p.slot,
          p.beat,
          0.12 + hammering * 0.5,
          (16 + hammering * 16) * p.wing,
          p.scale
        );
        /**
         * THE ARC HAD A CEILING AND NO FLOOR.
         *
         * `flee` is ballistic — one shove and then gravity — and it ran for a
         * flat 4.5 s or until the bird passed 46 m above the ground. Nothing
         * looked at the ground itself, so a bird whose arc topped out early
         * spent the rest of its flight descending THROUGH the terrain: watched
         * with a camera that follows one, it reaches about 8 m, comes back down,
         * and is eleven metres underground by the time the recycler collects it.
         *
         * It has always done this and nobody has ever seen it, because a flush
         * goes away from the player and the recycle is hidden behind `unseen` —
         * the bird was only ever underground where there was nothing to compare
         * it to. That stops being true the moment arrivals are things you watch,
         * which is the point of the `land` state below, so the floor is now a
         * condition of the same test as the ceiling: coming back down to head
         * height ends the escape, and what follows is a landing rather than a
         * burial.
         *
         * One `heightAt` per fleeing bird per frame, which is what the ceiling
         * test already cost — the value is taken once and used for both.
         */
        const ground = heightAt(p.pos.x, p.pos.z);
        /**
         * FALLING, and not merely low. One in five perchers is on the ground —
         * see `pickPerch` — and a bird that launches from the leaf litter is
         * below head height for the first half second BY DEFINITION. Testing
         * height alone ended its escape on the frame it began and the tinamous
         * never got off the floor; the escape is over when it is coming back
         * DOWN through head height, which is what the two extra terms say.
         */
        const gone =
          p.timer > 4.5 ||
          p.pos.y > ground + 46 ||
          (p.timer > 0.5 && p.vel.y < 0 && p.pos.y < ground + 2.2);
        if (gone) {
          pickPerch(p.home, camera.position.x, camera.position.z, PERCH_NEAR, PERCH_BAND);
          if (unseen(p.home, 2)) {
            p.pos.copy(p.home);
            p.state = 'perch';
            p.timer = rngRange(rng, 1, 5);
            p.sing = rngRange(rng, 10, 45) * (p.hen ? 2.3 : 1);
            p.hop = rngRange(rng, 20, 70);
          } else {
            /**
             * SOMEBODY IS WATCHING THE BRANCH IT WANTED, SO LET THEM WATCH IT
             * ARRIVE.
             *
             * This used to read `p.timer = 3.6`, which meant "stay in the air
             * and try again in a second" — the bird went on climbing until it
             * found a perch nobody could see and teleported onto it. That is
             * exactly right for hiding a recycle and it is why, in a wood with
             * twenty-six perching birds in it, A PLAYER HAS NEVER ONCE SEEN A
             * BIRD LAND. Every arrival in this file was, by construction,
             * unobservable.
             *
             * So the seen case becomes the good case: fly there and put it down
             * in full view. It costs the `land` state below and nothing else —
             * the perch was already chosen, and the bird was already going to
             * be simulated for the seconds it spends in the air.
             */
            p.state = 'land';
            p.timer = 0;
          }
        }
      } else {
        /**
         * COMING IN. A steer toward the branch, and a flare onto it.
         *
         * Deliberately NOT the flee arc run backwards. A departure is ballistic
         * — a shove and then gravity, which is what `flee` integrates — and an
         * arrival is the opposite kind of motion: a bird lands by aiming at the
         * branch and bleeding off speed until it has none left at exactly the
         * point it touches. Integrating a launch and hoping it lands on a
         * twig-sized target is a simulation problem nobody needs to have.
         *
         * So the velocity is damped toward "the direction of the perch, at a
         * speed proportional to what is left" — which cannot overshoot, arrives
         * asymptotically, and produces the deceleration for free. The `+1.1` on
         * the vertical is the small rise onto the branch that every small bird
         * makes at the last moment, and it is the shape the eye recognises.
         */
        p.timer += dt;
        const tx = p.home.x - p.pos.x;
        const ty = p.home.y - p.pos.y;
        const tz = p.home.z - p.pos.z;
        const left = Math.max(0.001, Math.hypot(tx, ty, tz));
        const want = Math.min(9, 1.2 + left * 1.6) / left;
        p.vel.x = damp(p.vel.x, tx * want, 0.004, dt);
        p.vel.y = damp(p.vel.y, ty * want + 1.1, 0.004, dt);
        p.vel.z = damp(p.vel.z, tz * want, 0.004, dt);
        p.pos.addScaledVector(p.vel, dt);
        if (p.vel.x !== 0 || p.vel.z !== 0) p.yaw = Math.atan2(p.vel.x, p.vel.z);
        /**
         * The flare: wings wide and slow over the last three metres. It is the
         * single most legible frame of a landing — a bird braking is almost all
         * wing — and it is one clamp against the distance left.
         */
        const flare = clamp01(1 - left / 3.2);
        p.open = damp(p.open, 1, 1e-8, dt);
        birdBeat.setXYZW(
          p.slot,
          p.beat,
          0.14 + flare * 0.44,
          (15 - flare * 9) * p.wing,
          p.scale
        );
        /**
         * DOWN — or given up on, and the timer is not a formality.
         *
         * `land` is the only state here that aims at a point rather than simply
         * running out, so it is the only one that can fail to finish: a perch
         * chosen on a trunk the recycler has since moved, or an arc that starts
         * pointing away, leaves a bird converging on nothing. Seven seconds is
         * four times the longest honest approach, and the cost of hitting it is
         * one bird appearing on its branch instead of settling onto it.
         */
        if (left < 0.5 || p.timer > 7) {
          p.pos.copy(p.home);
          p.vel.set(0, 0, 0);
          p.state = 'perch';
          p.timer = rngRange(rng, 1, 5);
          /**
           * AND IT ANNOUNCES ITSELF — BUT ONLY IF IT LANDED WHERE YOU ARE.
           *
           * A bird that arrives on a branch near you and then says nothing for a
           * minute is scenery; a bird that lands and sings within a few seconds
           * is the reason you looked up.
           *
           * THE 25 m GATE IS NOT TIDINESS, IT IS WHAT MAKES THE LINE WORK. Every
           * shortened timer is a bid for a token from the leaky bucket in
           * `wildlife.js`, and the bucket is a fixed rate: bids that lose are not
           * free, they are the reason somebody else's bid lost. Ungated, twenty
           * landings a minute across the whole 46 m hop radius tripled the demand
           * on that bucket and it went from refusing about half of the wood's
           * song to refusing five sixths of it — so the bird that landed at your
           * elbow was MORE likely to be silent than before the line existed.
           * Measured: 41 attempts a minute, 7 of them audible.
           *
           * Bidding only from inside 25 m is what turns it back into a priority
           * rather than a flood.
           */
          if (dist < 25) p.sing = Math.min(p.sing, rngRange(rng, 3, 14) * (p.hen ? 2.3 : 1));
          p.hop = rngRange(rng, 20, 70);
        }
      }

      // Radius 0 selects the instanceMatrix branch in the shader; the second
      // slot is the wing spread there rather than an angular speed.
      birdFlight.setXYZW(p.slot, 0, p.open, 0, 0);
      _v.copy(p.pos);
      /**
       * The pump and the turn, for a bird in the middle of a phrase. See the
       * display block above.
       *
       * Written HERE rather than into `p.pos` and `p.yaw`, which is not
       * tidiness: those two are the bird's actual state and everything else in
       * this loop reads them — the startle distance, the perch it is flying
       * back to, the `unseen` test. A wobble integrated into them would drift,
       * and a bird that had sung a few times would have walked off its branch.
       */
      let yaw = p.yaw;
      if (p.show > 0) {
        _v.y += 0.014 * p.scale * Math.sin(elapsed * 7.4 + p.beat * 2.3);
        yaw += 0.17 * Math.sin(elapsed * 2.1 + p.beat);
      }
      _e.set(0, yaw, 0);
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
    let write = 0;

    for (const m of members) {
      /**
       * TWO DISTANCES NOW, AND CONFLATING THEM IS THE BUG THIS COMMENT EXISTS TO
       * PREVENT.
       *
       * `dist` is to the local camera and answers "what does THIS screen do with
       * it" — whether to draw it, how loud its hooves are, whether its bark is
       * near or far. Every one of those is a fact about the person sitting here
       * and stays local on every machine.
       *
       * `reactDist` is to whoever is NEAREST it and answers "what does the animal
       * do" — notice, watch, flee, recycle. In single player they are the same
       * number and always were. In a room they are not, and using `dist` for the
       * second is what would let four people walk through a herd without
       * disturbing it while the host startled it from across the clearing.
       */
      const eye = nearestEye(m, camera);
      const reactDist = Math.hypot(m.pos.x - eye.x, m.pos.z - eye.z);
      const dist = Math.hypot(m.pos.x - camera.position.x, m.pos.z - camera.position.z);
      const was = m.state;

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
       * THE EARS AND THE TAIL, before anything decides.
       *
       * Split out of the four cases below so that a guest — which does not run
       * those cases at all — still gets an animal that visibly stiffens when it
       * notices somebody, off nothing but the state that arrived on the wire.
       * Extracted rather than duplicated because these are tuned numbers: two
       * copies of `damp(m.alert, 1, 0.02, dt)` is a promise to keep them equal
       * that nobody would keep, and the symptom would be one machine's deer
       * being permanently a little less alarmed than another's.
       *
       * ONLY `alert` AND `alarm`, which is the whole test for what belongs here:
       * they damp toward a target that follows from the state, so anyone holding
       * the state can compute them. The head does not — see `faceHead` in the
       * watch case — and travels instead.
       *
       * Ordering is unchanged. These lines used to run at the top of each case,
       * before that case's decisions, and they still do; none of the four
       * decisions reads a value this writes.
       */
      expression(m, reactDist, fleeR, dt);

      if (!hosting) {
        /**
         * A GUEST DOES NOT DECIDE ANYTHING. Everything from here to the recycler
         * is the host's, and this takes its place: position and intent lifted
         * off the interpolation buffer. See `playback`.
         */
        playback(m, dt);
      } else {

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
          if (reactDist < noticeR) {
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
          /**
           * The head goes round to you, and the body does not. That difference
           * is the whole of "it is watching me".
           *
           * HOST-ONLY, AND THE HEAD IS THEREFORE ON THE WIRE. This turns toward
           * `eye`, which is whichever person the animal actually noticed — so a
           * guest cannot recompute it without knowing who that was, and a guest
           * that ran it against its own camera would produce a deer that looks
           * at everybody at once. It also nudges `yaw` when the neck runs out,
           * and yaw is the host's.
           */
          faceHead(m, eye, dt);
          m.timer -= dt;
          if (reactDist > noticeR * 1.35) {
            m.state = 'graze';
            m.timer = 1;
          } else if (reactDist < fleeR) {
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
             * The bark fires on a bolt and only on a bolt — so a stag barks
             * several times as often as a doe does, and the bark is what you
             * remember about the encounter. It is fired below rather than here,
             * off the state CHANGE, so that a guest hears it too; see `bark`.
             */
            const hard = reactDist < fleeR * (m.nerve > 1.15 ? 0.95 : 0.6);
            m.state = hard ? 'bolt' : 'walk';
            m.timer = hard ? rngRange(rng, 2.2, 4.5) : rngRange(rng, 3, 6);
            if (hard && herd.name === 'capuchin') {
              m.trunk = trunks.near(m.pos.x, m.pos.z, 22);
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
        m.pos.y = heightAt(m.pos.x, m.pos.z);
      }

      /**
       * Re-seeding is the population control, and it is why twenty-odd animals feel
       * like a wood full of them. A creature that has got a long way off and is
       * out of the frame is deleted and rebuilt somewhere you have not been —
       * so you are never more than a minute's walk from an encounter and the
       * scene never contains more than twenty-three state machines.
       *
       * BOTH TESTS ARE NOW ABOUT THE WHOLE ROOM. `reactDist` is the distance to
       * the nearest person, so "a long way off" means far from everybody, and
       * `unseen` means in nobody's view — see the note there for why getting
       * that second one wrong is the only bug in this feature that a guest would
       * see rather than the host.
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
        (reactDist > FAR[herd.name] * 0.8 || strayed) &&
        unseen(m.pos, herd.radius * m.scale)
      ) {
        reseat(m, spec, eye.x, eye.z, 32, FAR[herd.name] * 0.7);
      }

      } // end of the host's decisions

      /**
       * Nose level unless it is up a tree, on both paths.
       *
       * Derived rather than sent: `pitch` is zero in four of the five states and
       * a constant in the fifth, so a guest reads it off the state for nothing.
       * The climb case above sets it directly and this leaves it alone, exactly
       * as it did before there were two paths through here.
       */
      if (m.state !== 'climb') m.pitch = damp(m.pitch, 0, 0.02, dt);

      /**
       * THE BARK, FIRED OFF THE STATE CHANGE AND NOT OFF THE DECISION.
       *
       * Moved out of the `watch` case for one reason: a guest never runs that
       * case, and a wood where the deer bolt in silence for seven people out of
       * eight is worse than one with no bark at all. A transition into `bolt` is
       * the same event whether this machine decided it or read it off the wire,
       * so this is the honest place for it.
       *
       * `dist` and not `reactDist`, deliberately. How loud a bark is depends on
       * how far away YOU are from it — the nearness term was always a fact about
       * the listener, and it is the one place in this loop where the local camera
       * is still the right question. A deer startled by somebody across the
       * clearing should be faint here, and now is.
       */
      if (m.state === 'bolt' && was !== 'bolt') {
        wildlife?.bolt(m.pos, herd.name, clamp01(1 - dist / (fleeR * 2)), m.mass);
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

  /**
   * EVERY ANIMAL IN THE WOOD, AS ONE FLAT ARRAY OF NUMBERS. Host only.
   *
   * The message a room's host sends six times a second. `a` is `ANIMAL_FIELDS`
   * numbers per animal in `everyone` order — no ids, no keys, no brackets per
   * creature — because that order is fixed by the source and is therefore the
   * same on every machine. `c` is the coat round-robin; see `COATS_PER_SEND`.
   *
   * ROUNDED HERE AND NOT BY THE SERVER, which is the difference between the
   * server needing to know what these numbers mean and it not. Two decimals is
   * a centimetre on a position and about half a degree on an angle, both well
   * under what a third of a second of interpolation is already smoothing over,
   * and it is most of the size of the message: `-12.3456789012` is thirteen
   * characters and `-12.35` is six.
   */
  function snapshot() {
    const a = new Array(everyone.length * ANIMAL_FIELDS);
    for (let i = 0; i < everyone.length; i++) {
      const m = everyone[i];
      const o = i * ANIMAL_FIELDS;
      a[o] = r2(m.pos.x);
      a[o + 1] = r2(m.pos.y);
      a[o + 2] = r2(m.pos.z);
      a[o + 3] = r2(m.yaw);
      a[o + 4] = r2(m.look);
      a[o + 5] = r2(m.lookPitch);
      a[o + 6] = r1(m.speed);
      a[o + 7] = STATES.indexOf(m.state);
    }

    const c = [];
    for (let n = 0; n < COATS_PER_SEND; n++) {
      const i = coatCursor % everyone.length;
      coatCursor = (coatCursor + 1) % everyone.length;
      const m = everyone[i];
      // Index first, then the eight things `individual` rolls. `nerve` rides
      // along because a guest reads it in `expression`, and `mass` because a
      // guest's own footfalls and barks are scaled by it.
      c.push(i, r2(m.scale), r2(m.tint.r), r2(m.tint.g), r2(m.tint.b), r2(m.pied), r2(m.antler), r2(m.nerve), r2(m.mass));
    }
    return { a, c };
  }

  /**
   * A snapshot off the wire. Guests only — a host ignores these, because the
   * only thing that could send it one is a room with two hosts in it.
   *
   * Nothing is applied to an animal here; the sample is pushed into that
   * animal's buffer with the time it landed, and `playback` reads it a third of
   * a second later. Applying directly would be a snap six times a second, which
   * is exactly the rubber-banding the buffer exists to prevent.
   */
  function applyRemote(msg) {
    if (hosting || !msg) return;
    const a = msg.a;
    if (Array.isArray(a)) {
      const now = performance.now();
      const n = Math.min(everyone.length, Math.floor(a.length / ANIMAL_FIELDS));
      for (let i = 0; i < n; i++) {
        const m = everyone[i];
        const o = i * ANIMAL_FIELDS;
        const buffer = m.wire ?? (m.wire = []);
        // Out-of-order arrival would drag the interpolator backwards, which
        // shows as a twitch. Same guard as `push` in player/avatar.js.
        if (buffer.length && now < buffer[buffer.length - 1].t) continue;
        buffer.push({
          t: now,
          x: a[o],
          y: a[o + 1],
          z: a[o + 2],
          yaw: a[o + 3],
          look: a[o + 4],
          lookPitch: a[o + 5],
          speed: a[o + 6],
          state: STATES[a[o + 7]] ?? 'graze',
        });
        // Four is a fifth of a second of slack past the replay cursor. Longer
        // buffers do not make it smoother, they make it later.
        if (buffer.length > 4) buffer.shift();
      }
    }

    const c = msg.c;
    if (Array.isArray(c)) {
      for (let o = 0; o + 8 < c.length; o += 9) {
        const m = everyone[c[o]];
        if (!m) continue;
        m.scale = c[o + 1];
        m.tint.setRGB(c[o + 2], c[o + 3], c[o + 4]);
        m.pied = c[o + 5];
        m.antler = c[o + 6];
        m.nerve = c[o + 7];
        m.mass = c[o + 8];
      }
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

  /**
   * How wound up it looks, from the state it is in. Runs on every machine.
   *
   * `alert` is the ears and the stance; `alarm` is the tail. Both are pure
   * functions of the state plus how close the thing it is watching has got, so
   * they are derived on a guest rather than sent — two numbers per animal per
   * tick saved, on values whose whole behaviour is "damp toward the obvious".
   */
  function expression(m, dist, fleeR, dt) {
    switch (m.state) {
      case 'graze':
        m.alert = damp(m.alert, 0, 0.02, dt);
        m.alarm = damp(m.alarm, 0, 0.01, dt);
        break;
      case 'watch':
        m.alert = damp(m.alert, 1, 0.02, dt);
        m.alarm = damp(m.alarm, dist < fleeR * 1.5 ? 1 : 0, 0.05, dt);
        break;
      case 'walk':
      case 'bolt':
        m.alert = damp(m.alert, m.state === 'bolt' ? 0.2 : 0.6, 0.02, dt);
        m.alarm = damp(m.alarm, 0, 0.02, dt);
        break;
      case 'climb':
        m.alert = damp(m.alert, 0, 0.02, dt);
        break;
      default:
        break;
    }
  }

  /**
   * WHERE A GUEST'S ANIMALS COME FROM: the buffer, replayed a third of a second
   * behind live.
   *
   * The same interpolator the avatars use and for the same reasons — see
   * `_interpolate` in player/avatar.js. Two samples that have both already
   * arrived, a cursor between them, and a HOLD rather than an extrapolation once
   * the cursor runs past the newest. Extrapolating a velocity is the standard
   * trick and it is wrong for exactly the animals it would matter for: a bolting
   * deer changes direction hard, so every extrapolated metre has to be taken back
   * when the truth arrives, and the overshoot-and-snap is far more visible than
   * a sixth of a second of standing still.
   *
   * `speed` and `state` are taken from the OLDER of the two samples rather than
   * interpolated, because neither is a quantity: a state is a name, and speed is
   * only ever read as "how fast are the legs going", which wants to change on
   * the same frame the pose does.
   */
  function playback(m, dt) {
    const buffer = m.wire;
    if (!buffer || buffer.length === 0) return;

    const renderTime = performance.now() - FAUNA_LAG_MS;
    while (buffer.length > 2 && buffer[1].t < renderTime) buffer.shift();

    const a = buffer[0];
    const b = buffer.length > 1 ? buffer[1] : null;
    let t = 0;
    if (b && renderTime > a.t) {
      const span = b.t - a.t;
      t = span > 0 ? clamp01((renderTime - a.t) / span) : 1;
    }
    const from = a;
    const to = b ?? a;

    m.pos.set(lerp(from.x, to.x, t), lerp(from.y, to.y, t), lerp(from.z, to.z, t));
    // The short way round, or an animal crossing north spins 350° on the spot.
    m.yaw = from.yaw + wrapAngle(to.yaw - from.yaw) * t;
    m.look = from.look + wrapAngle(to.look - from.look) * t;
    m.lookPitch = lerp(from.lookPitch, to.lookPitch, t);
    m.speed = from.speed;
    m.state = from.state;
    void dt;
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
     * The live wood's own voice, for probes — a GETTER because it does not
     * exist until `attachAudio`.
     *
     * `scripts/fauna-audio.mjs` measures birdsong by constructing its own
     * `Wildlife` and forcing events into it, which is the right way to ask "does
     * this species buzz" and no way at all to ask "can the player hear the birds
     * in this wood". That second question needs THIS instance — the one holding
     * the song bucket the perchers are competing for and the listener position
     * the distance model reads — and it lives in a closure, so until this line
     * there was no way to reach it from a page. See `scripts/bird-check.mjs`.
     */
    get __wildlife() {
      return wildlife;
    },
    /** Every ground animal, in wire order. Read by the checks. See `everyone`. */
    everyone,

    /**
     * WHETHER THIS MACHINE DECIDES WHAT THE ANIMALS DO.
     *
     * True on a solitary walk and for exactly one person in a room — the server
     * picks, and picks whoever has been there longest, so it is stable for as
     * long as that person stays. Everybody else plays back what arrives.
     *
     * TAKING THE JOB IS SEAMLESS AND GIVING IT UP IS NOT, and that asymmetry is
     * worth knowing. A guest promoted mid-session simply starts deciding from
     * wherever its playback had got to, which is a third of a second behind
     * where the old host left off and completely invisible. The reverse — a host
     * demoted because somebody older reconnected — snaps its animals onto that
     * person's version once, and cannot not: two woods that have been simulating
     * independently do not agree, and there is nothing to interpolate between.
     * The server's "longest in the room" rule exists so that this happens on a
     * host leaving and at no other time.
     */
    setHosting(on) {
      const next = Boolean(on);
      if (next === hosting) return hosting;
      hosting = next;
      // Nothing arriving is stale the moment the job changes hands. A promoted
      // guest must not have `playback` fed from a buffer it is no longer
      // reading, and a demoted host must not replay samples from before it was
      // told — either way the first thing that matters is the next send.
      for (const m of everyone) m.wire = null;
      return hosting;
    },
    get hosting() {
      return hosting;
    },

    /**
     * THE OTHER PEOPLE IN THE WOOD: `{x, y, z, yaw}` each, refreshed per frame.
     *
     * Not peers, not avatars, not the net layer's objects — four numbers, so
     * that this file keeps knowing nothing about multiplayer. main.js does the
     * translating, which is the same boundary the speakers and the jukebox use.
     *
     * They matter in two places and both are about the room rather than about
     * you: `nearestEye` (which person an animal reacts to) and `unseen` (whether
     * a recycle would happen in somebody's face).
     */
    setObservers(list) {
      observers = Array.isArray(list) ? list : [];
    },

    /** The host's six-a-second message. Null for a guest, which sends nothing. */
    snapshot: () => (hosting ? snapshot() : null),

    /** One of those, arriving. A no-op on the host. See `applyRemote`. */
    applyRemote,
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

      /**
       * NO BUTTERFLIES UNDERGROUND, and this is a draw call rather than a
       * nicety.
       *
       * `heightAt` is the surface, and the caves are carved below it, so an eye
       * three metres under the height field is inside the hill. Butterflies are
       * seated against `heightAt` and would therefore be flying in a neat swarm
       * through solid rock above your head, visible through nothing but
       * occasionally through a cave mouth. Setting `count` to zero drops the
       * whole mesh out of the frame — the underground frame is the cheapest one
       * in the world at 0.60 ms precisely because every layer that has nothing
       * to say down there says nothing, and this is one of them.
       *
       * It also skips the reseating, so a long walk through a cave does not
       * drag twenty butterflies along inside the ceiling.
       */
      const under = camera.position.y < heightAt(camera.position.x, camera.position.z) - 3;
      /**
       * `smallLife` IS THE SAME SWITCH AS `under`, POINTED AT A DIFFERENT REASON.
       *
       * Underground these two clouds are inside solid rock and turning them off
       * is simply correct. At `potato` they are in the right place and are turned
       * off anyway, because a midge is the least load-bearing thing in the world
       * and this is the rung for a machine that has run out of everything.
       *
       * IT SAVES THE FOLLOW AND NOT ONLY THE DRAW, which is why it is here rather
       * than a `visible = false` from outside: `followFlutters` and `followSwarm`
       * recycle 7 cards and 1340 points against the camera every frame, and that
       * is main-thread work on a frame that — see `npm run perf:weak` — sits
       * exactly on the 60 Hz boundary at 8x throttle. The birds and the mammals
       * are deliberately NOT in here: they are the life of the place, they are
       * what a person standing still is looking at, and they are simulated
       * host-authoritatively, so thinning them on one machine would change the
       * world for everybody in it.
       */
      const small = smallLife && !under;
      butterflies.count = small ? BUTTERFLIES : 0;
      if (small) followFlutters(camera.position.x, camera.position.z);
      /**
       * Same underground reasoning as the butterflies above, and the same two
       * effects: the cloud is seated against `heightAt`, so down here it is a
       * sheet of midges in the rock over your head, and skipping the follow
       * stops a long cave walk dragging it along inside the ceiling. `visible`
       * rather than a count write because this is a `Points` cloud with no
       * count to drop, and false is what keeps it out of `projectObject`.
       */
      swarm.visible = small;
      if (small) followSwarm(camera.position.x, camera.position.z);

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
    /**
     * Whether the insect clouds exist at all. See the `small` block in `update`.
     *
     * Both surfaces are written on the NEXT update rather than here, because
     * `update` writes them unconditionally from `small` and a value poked in
     * from this setter would be overwritten within a frame — the same trap the
     * view-breath switch records in the perf rig. One writer, one place.
     */
    setSmallLife(on) {
      smallLife = !!on;
    },
    get smallLife() {
      return smallLife;
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
