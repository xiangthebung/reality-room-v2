import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TAU, clamp01, fbm2, makeRng, rngRange } from '../core/util.js';
import { GroundField } from './ground.js';
import { SPECIES_NAMES, growTree, speciesMaterials } from './trees.js';
import { fernFrond, forestFloor, glowSprite, herbTuft } from './textures.js';
import {
  brambleTexture,
  bromeliadTexture,
  cardClump,
  flowerTexture,
  giantLeafTexture,
  heliconiaTexture,
  litterPatch,
  litterTexture,
  palmFrondTexture,
  palmGeometry,
  reedTexture,
  saplingGeometry,
  shrubTexture,
  stickGeometry,
  stumpGeometry,
  BREATH_OF_THICKNESS,
  gaugeBreath,
  matchSeamNormals,
  weldProp,
} from './undergrowth.js';
import { PLANT_SCALE, makeLiving, setPlantScale } from '../trip/living.js';
import { InstanceCuller, packSlab } from './culling.js';
import { ColliderGrid, ForestField } from './forest-field.js';
import {
  IMPOSTOR_ATLAS_BYTES,
  IMPOSTOR_SPRITES_PER_SIDE,
  IMPOSTOR_TEXTURE_SIZE,
  bakeImpostor,
  bakeRendererReady,
  impostorGeometry,
  impostorMaterial,
} from '../render/impostor.js';

/**
 * The forest.
 *
 * Builds everything that is made of matter: ground, trees, undergrowth, rocks,
 * fallen wood and mushrooms. Sky, light, water and particles live in
 * `atmosphere.js`, because those are the things a trip changes wholesale and
 * keeping them apart makes that obvious.
 *
 * DENSITY IS A FIELD, NOT A NUMBER. Trees are placed by rejection sampling
 * against a low-frequency noise field, so the forest has groves, glades and
 * thickets instead of a uniform sprinkle. That single choice is most of the
 * difference between "trees have been scattered on a heightmap" and "this is a
 * wood" — a uniform density has no interior and no edge, so there is nowhere to
 * walk *to*.
 *
 *
 * THIS FILE PLACES NOTHING. IT BUILDS THINGS AND THEN WAITS.
 *
 * Geometries, materials, textures, the culler and one InstancedMesh per layer
 * — and then a `ForestField`, which fills those meshes from sectors built in a
 * worker on a ring that follows the camera. Every instance in the world arrives
 * that way, from the tree six metres from the spawn point to the one at 20 km.
 *
 * IT USED TO PLACE MOST OF THE VISIBLE WORLD, and the removal is recent enough
 * to be worth explaining rather than merely noting. There was an eager global
 * scatter here — about 3600 trees inside 180.5 m, the sward inside 72 m, ferns
 * inside 118 m, stones, deadfall, fifteen mushroom patches and the nine
 * understorey layers inside 112–140 m — and the streamed field was forbidden to
 * place anything inside a protected radius of 163.4 m so that the two tiled the
 * plane without overlapping. The justification was approval: that disc was
 * signed off and a per-sector rng would move every near tree.
 *
 * Then the world became per-session seeded, so the near trees move on every
 * load regardless, and the rule was left costing a bald annulus — 23 to 51 m of
 * ground that neither sampler planted — to protect a layout nobody reproduces.
 * `scatter.js`'s header carries the measurements: the cover density, the
 * before-and-after GPU numbers, and why one sampler starting at r = 0 was the
 * right shape of fix rather than widening the discs.
 *
 * WHAT SURVIVED THE REMOVAL IS THE EXPENSIVE PART. The card sizes, the geometry
 * proportions, the "fewer and bigger" measurements and the one-program-per-look
 * material rule are all still here and all still load-bearing — those are the
 * decisions that cost milliseconds. Where a thing GOES was never decided here;
 * it only used to be executed here twice.
 */

/**
 * The colliders this module does not get from a sector: the campfires.
 *
 * This was the flat list of every trunk, log and boulder in the authored world.
 * The authored world is gone and so is almost all of its content — what is left
 * is an inbox. `gathering.js` pushes a circle per hearth in here AFTER
 * `buildForest` has returned (main.js builds the forest first, because
 * everything standing in it has to ask where the ground is), and `cull()` folds
 * any new tail into `colliderGrid` on the next frame.
 *
 * It stays exported and stays an array because that is the interface those
 * callers already write to, and because an inbox with a dozen items in it is a
 * clearer thing than a special case in the grid. Everything that READS
 * colliders — the controller's body sweep, fauna's trunk index — goes to
 * `colliderGrid`, which has the streamed world in it.
 *
 * IT IS WRITE-ONCE, which is why the speakers do not use it. A fire never moves;
 * a speaker is furniture the player arranges, and an entry filed into a 16 m
 * cell cannot be dragged out of it by mutating its coordinates. `speakers.js`
 * goes to `colliderGrid.addSector` / `removeSector` with an id of its own —
 * see the note there.
 */
export const colliders = [];

/**
 * The spatial index the body actually collides against.
 *
 * Every streamed sector's trunks, logs, boulders and stumps, plus the jukebox.
 * See ColliderGrid for why a grid rather than the flat scan that was measured
 * at 10.2 µs a frame: that number was fine for 3807 entries and there is no
 * longer any bound on the count.
 *
 * `fauna.js` reads this directly and identifies trunks by radius — anything
 * under 0.8 m is a tree and nothing else can be. That contract is enforced at
 * the other end, by the 0.82 m floor in `stumpCollider`. Bushes used to share
 * this grid and this floor; they no longer do, see `bushZones` below.
 */
export const colliderGrid = new ColliderGrid();

/**
 * The spatial index the controller QUERIES but never pushes against.
 *
 * Every streamed sector's big bushes — the same `ColliderGrid`, reused for a
 * different question. `colliderGrid` answers "is the body allowed here"; this
 * one answers "is the body close enough to a bush for a rustle", and keeping
 * them as two grids rather than one tagged grid is what lets a bush entry stay
 * invisible to `fauna.js`'s tree filter without either file having to filter
 * by kind. See `bushCue` in scatter.js for what goes in.
 */
export const bushZones = new ColliderGrid();

/**
 * Put one opaque forest mesh in its place in the depth-sorted draw order.
 *
 * THE DEFAULT ORDER IS NOT AN ORDER ANYBODY CHOSE. three sorts the opaque list
 * by `(groupOrder, renderOrder, material.id, z)`, and `material.id` outranks z —
 * so with every renderOrder left at 0 the forest draws in the order its
 * materials happened to be CONSTRUCTED in, and z only breaks ties inside a
 * single material. Front-to-back is what early-Z wants and it was happening by
 * accident, per material, at whatever quality the constructor order gave.
 *
 * Measured over five interleaved rounds at seek 160, whole frame in absolute
 * ms: 5.054 shipping, 4.987 with the ground first only, 5.019 with the leaves
 * last only, and 4.890 for the full ground / trunk / understorey / leaf / sky
 * ordering. 0.16 ms for six lines.
 *
 * WHY THE UNDERSTOREY SITS BETWEEN TRUNK AND LEAF. It is denser and more opaque
 * than the canopy — the whole "fewer and bigger" argument in the section below
 * is that these cards fill their silhouette — so it should be laid down before
 * the canopy is drawn, not after it. The canopy goes last of the opaque set
 * because it is the laciest thing in the frame and therefore the worst occluder
 * and the biggest beneficiary of everything else's depth.
 *
 * Every new layer must go through here. The numbers are a scale shared with
 * `ground.js` (the floor at -4, and it is the frame's best occluder by a
 * distance — hiding it costs 2.48 ms) and `atmosphere.js` (the sky at 90).
 * Nothing moves between render lists: `renderOrder` sorts WITHIN one, so the
 * transparent water, mist, shafts and motes still blend against a finished
 * frame.
 */
/**
 * AND THE SOLID THINGS THAT WERE NOT TRUNKS WERE IN THE ALPHA-TESTED BAND.
 *
 * The four numbers above describe an order — ground, wood, understorey, canopy
 * — and the implementation delivered it for the two layers it names and put
 * EVERYTHING ELSE in the understorey slot, including four layers that are
 * completely solid: boulders, fallen logs, mushroom stems and mushroom caps.
 * None of them has an alphaTest and none of them discards a fragment.
 *
 * That matters beyond early-Z, and the reason is the hardware the complaint
 * came from. Apple's tile-based deferred renderers do hidden-surface removal
 * per tile before shading, and the WWDC20 guidance is explicit that the
 * removal is defeated by an alpha-tested draw: a shader that can discard
 * cannot have its depth resolved ahead of shading, so the tile falls back to
 * shading in submission order from the first such draw onward. Submitting
 * opaque, then alpha-tested, then translucent, and never interleaving them, is
 * the whole of the advice. A boulder drawn AFTER a lacy grass card is a solid
 * occluder that arrives too late to occlude anything.
 *
 * So the test is what the mesh IS rather than what it is called: the opaque
 * set is the named list, the canopy stays last, and the alpha-tested
 * understorey is the default. It is one assignment and it changes no pixel —
 * `renderOrder` sorts within the opaque list only, and depth resolves the same
 * image whatever order these are submitted in. Verified at 0 px by
 * `check:cull`, which re-renders every station.
 */
const OPAQUE_SOLIDS = new Set(['trunk', 'rocks', 'logs', 'shroom-stem', 'shroom-cap']);

/**
 * `impostor` RIDES WITH `leaf`, AND ENDS UP AFTER IT, WHICH IS THE POINT.
 *
 * An impostor is a canopy — alpha-tested, and by construction the furthest
 * canopy in the frame — so the rule above puts it in the same last group rather
 * than in the understorey's. Within one `renderOrder` three's painter sort falls
 * through to `material.id`, and the impostor materials are built during the bake
 * on the first frames of the session, long after every leaf material, so they
 * carry the highest ids in the wood and are submitted last of all the trees.
 *
 * That is worth having rather than incidental. The band holds on the order of
 * 1700 quads in a 66° frustum at `medium`, each about 50 px square at 300 m, so
 * it is a few screenfuls of fragments — and almost all of them are behind trunks
 * and crowns that are only occluders once their depth is down.
 */
function orderOpaque(mesh) {
  const canopy = mesh.name === 'leaf' || mesh.name === 'impostor';
  mesh.renderOrder = OPAQUE_SOLIDS.has(mesh.name) ? -3 : canopy ? -1 : -2;
  return mesh;
}


/**
 * Conservative sphere for one instance of a geometry: a centre height and a
 * radius that survive any yaw rotation and any uniform-ish scale, hung on the
 * instance's origin. Folding the sphere centre's horizontal offset into the
 * radius is what makes it rotation-proof.
 *
 * `spin` is for the layers that tumble on all three axes — stones and fallen
 * wood. Yaw cannot move a point away from the vertical axis, so the horizontal
 * offset is all that has to be folded in for a tree; a rock rotated about x can
 * put its sphere centre's HEIGHT out sideways instead, so that has to be folded
 * in too and the centre collapses to the instance origin.
 */
function instanceBound(geometry, spin = false) {
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const s = geometry.boundingSphere;
  if (spin) return { cy: 0, r: s.radius + s.center.length() };
  return { cy: s.center.y, r: s.radius + Math.hypot(s.center.x, s.center.z) };
}

/**
 * One bound that encloses two geometries.
 *
 * Needed because a `mirrorOf` layer pair — the near and far halves of a trunk —
 * is fed ONE worker payload, and that payload carries the bucket spheres the
 * frustum test uses. The spheres can therefore only be measured from one of the
 * two meshes, and measuring the near one is wrong: the far sweep is a different
 * merge of the same tree and is not contained by it.
 *
 * The symptom when this is missed is worth recording, because it is not the one
 * you would predict. It is NOT distant trees quietly missing — it is
 * `cull-check` failing at a streamed station by 14332 pixels with a worst
 * channel delta of 630/765, which is a whole trunk present in one render and
 * absent from the other at the edge of the frame. It took a per-layer pixel
 * bisect to attribute, because every other layer in the same frame differed by
 * a uniform 3/765 of accumulator noise and the counts alone look identical:
 * both packers agree on their bands, both have seen the eye, and
 * `inBand(now) === inBand(stored)` for every one of them. Nothing is wrong with
 * the band arithmetic. The sphere is just too small to be tested against.
 *
 * Both spheres are centred on the same vertical axis, so the enclosing one is
 * the classic two-sphere union along that axis.
 */
function unionBound(a, b) {
  const cy = (a.cy + b.cy) / 2;
  return {
    cy,
    r: Math.max(a.r + Math.abs(a.cy - cy), b.r + Math.abs(b.cy - cy)),
  };
}

/** A clump of crossed cards, used for grass and ferns. */
function clumpGeometry(width, height, blades, rng, lean = 0.18, scale = PLANT_SCALE.grass) {
  const parts = [];
  for (let i = 0; i < blades; i++) {
    const geo = new THREE.PlaneGeometry(width, height, 1, 3);
    geo.translate(0, height / 2, 0);
    const pos = geo.attributes.position;
    const flex = new Float32Array(pos.count);
    const phase = new Float32Array(pos.count);
    const ph = rng();
    for (let v = 0; v < pos.count; v++) {
      const t = clamp01(pos.getY(v) / height);
      // Pre-bend the card so a blade is a curve, not a flag.
      pos.setZ(v, pos.getZ(v) + t * t * height * lean);
      flex[v] = t * t;
      phase[v] = ph;
    }
    geo.setAttribute('aFlex', new THREE.BufferAttribute(flex, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.rotateY((i / blades) * Math.PI + rng() * 0.5);
    geo.computeVertexNormals();
    // Push normals upward: undergrowth lit from the side goes black, and
    // upward-facing normals catch the sky the way a real sward does.
    const nrm = geo.attributes.normal;
    for (let v = 0; v < nrm.count; v++) {
      const n = new THREE.Vector3(nrm.getX(v), nrm.getY(v), nrm.getZ(v));
      n.y += 1.1;
      n.normalize();
      nrm.setXYZ(v, n.x, n.y, n.z);
    }
    parts.push(geo);
  }
  return setPlantScale(BufferGeometryUtils.mergeGeometries(parts, false), scale);
}

/**
 * A rock: an icosahedron beaten out of shape.
 *
 * `mergeVertices` before the normals, and it is not optional. IcosahedronGeometry
 * is non-indexed — every triangle owns its own three vertices — so
 * `computeVertexNormals` gives each face a single flat normal and the rock
 * renders as a bag of hard-edged triangles, which at close range is one of the
 * more obviously man-made objects in the forest. The displacement is a pure
 * function of position, so duplicated vertices land on top of each other and
 * welding them is exact rather than approximate.
 */
function rockGeometry(rng, size) {
  const geo = new THREE.IcosahedronGeometry(size, 2);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  // One squash factor per rock, not per vertex: rng() is stateful, and drawing it
  // inside the loop gave duplicate (pre-weld) copies of the same icosahedron vertex
  // different Y multipliers. That pulled them apart by more than mergeVertices'
  // tolerance below, so the mesh never welded shut there — a real crack, not a
  // culling artifact.
  const squash = rngRange(rng, 0.5, 0.78);
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const n = fbm2(v.x * 1.6 + 20, v.z * 1.6 - 7, 2) * 0.34 + fbm2(v.y * 2.2, v.x * 2.2, 2) * 0.2;
    v.multiplyScalar(1 + n);
    v.y *= squash;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  const welded = BufferGeometryUtils.mergeVertices(geo, 1e-4);
  welded.computeVertexNormals();
  geo.dispose();
  /**
   * AND THE WELD ABOVE DOES NOT ACTUALLY CLOSE ALL OF IT, which is worth saying
   * out loud under a comment that claims it does. `mergeVertices` hashes every
   * attribute and an icosahedron keeps its `uv`, so the nine vertices on the
   * unwrap seam survive as pairs — measured, not assumed. Unlike the props in
   * undergrowth.js the UVs cannot simply be deleted here, because `rockMat` is
   * one of the surfaces whose procedural grain reads them.
   *
   * The residue is small — adjacent faces on a subdivided icosahedron differ by
   * a few degrees, so the seam opens by under a centimetre on a 1.7 m boulder
   * against the 9.6 cm the flat rim of a log was opening — and it is one line to
   * make it exactly zero.
   */
  return matchSeamNormals(welded);
}

/**
 * A fallen log: a slightly bent cylinder with bark.
 *
 * CAPPED SINCE IT WAS WRITTEN, AND STILL OPEN AT BOTH ENDS UNDER A TRIP.
 *
 * `CylinderGeometry` emits the rim twice — once as the last ring of the side,
 * with a radial normal, and once as the edge of the cap, with an axial one —
 * and after the `rotateZ` those two directions are 90° apart. living.js pushes
 * every vertex along its own normal, so the two rings walk away from each other
 * and what opens is an annular crack of up to 9.6 cm at each end of a log 38 cm
 * in radius. It is not subtle and it is not a culling artefact: the before
 * pictures show the pale inside of the log through a band all the way round the
 * end face. `rockGeometry` records this same failure and the same fix.
 *
 * THE CRISP RIM WAS CONSIDERED AND GIVEN UP, because keeping it and closing the
 * crack are the same wish. A hard shading edge IS two normals at one place, and
 * two normals at one place IS two vertices, and two vertices at one place is
 * exactly what the breath pulls apart. Welding blends the rim over about 45°,
 * which on a broken log — the end of a log on a forest floor is a break, not a
 * saw cut — is the truer read anyway. The alternative, pinning the end rings by
 * zeroing their normals, cannot be done: `normalize()` of a zero vector is NaN
 * and the lighting on both rings goes with it.
 *
 * NO GAUGE. The thin end is 0.72 × 0.38 = 27.4 cm in radius against 9.6 cm of
 * breath — 35% of it, comfortably inside `BREATH_OF_THICKNESS`. A log is thick
 * enough to breathe the whole amount and it should, because it is the largest
 * single surface on the floor.
 */
function logGeometry(rng, length, radius) {
  const geo = new THREE.CylinderGeometry(radius * 0.72, radius, length, 8, 4, false);
  geo.rotateZ(Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const t = x / length;
    pos.setY(i, pos.getY(i) + Math.sin(t * 2.4) * radius * 0.5);
    pos.setZ(i, pos.getZ(i) + Math.sin(t * 3.1 + 1) * radius * 0.35);
  }
  void rng;
  // The bend is a function of X alone, so both copies of a rim vertex land in
  // the same place and the weld is exact.
  return weldProp(geo);
}

/**
 * The cap's dome, in radians of polar angle, and how many sides it is drawn on.
 *
 * A hair past the equator, which is what gives a cap its slight overhang. Named
 * because the underside below has to end EXACTLY on the ring this produces —
 * `sin` and `cos` of this angle are the rim's radius and height — and a second
 * literal `Math.PI * 0.52` somewhere else in the file is how that stops being
 * true one edit later.
 */
const CAP_THETA = Math.PI * 0.52;
const CAP_SIDES = 12;

/**
 * Mushroom geometry: a stem and a cap, in two materials.
 *
 * They are the only thing in the forest with an emissive of its own when sober —
 * faint, at the edge of noticeable. Something has to draw the eye across a
 * clearing and say "that". A prompt on the HUD would do the job and would also
 * announce that this is a game.
 *
 *
 * THE CAP HAD NO UNDERSIDE, AND THIS IS THE SHAPE THE PLAYER IS HOLDING WHEN
 * THE COMPLAINT HAPPENS.
 *
 * It was an open hemispherical shell: `SphereGeometry` stopped at `CAP_THETA`
 * and nothing closed it. `capMat` is `FrontSide`, so from below the rim there
 * is no mushroom at all — the near half faces away and is culled, the far half
 * shows you its back and is culled, and a 15 cm cap becomes a hole in the world
 * that the eye can reach by crouching. Then the breath flares the rim outward
 * and downward and widens the band of angles that can see under it.
 *
 * The underside is now a shallow cone from the rim down to a point buried
 * inside the stem, which is 12 triangles on a 156-triangle cap — under 8% — and
 * closes the body completely. It is also what a mushroom looks like: the gills
 * hang, they do not sit flat.
 *
 * WHY NOT MERGE THE CAP AND THE STEM INTO ONE MESH, which is the fix the shape
 * of the bug suggests: because they are two materials — a cream stem with no
 * instance tint and a purple cap that takes one, `push(caps, _mat, _col, ...)`
 * in scatter.js — and one mesh with two materials is a geometry group per
 * material, which is two draw calls and one instance colour shared between
 * them. It would cost the stems their own colour to fix a seam that closing the
 * cap hides anyway. The two meshes still ride the same instance matrix; what
 * changed is that neither of them has an opening for the other to show through.
 *
 * BOTH HALVES ARE GAUGED, and the cap's budget is set by the SHALLOWEST
 * dimension of the closed body rather than by its radius. The cap is 10–17 cm
 * across and only 5–15 cm from its crown to the bottom of its gills, so the
 * radius is the wrong number to size a ±9.6 cm displacement against: at the
 * trough the dome would sink through the underside it now has. The stem is
 * gauged against its 2.8 cm neck for the plain reason living.js gives — 9.6 cm
 * of inward travel on a 2.8 cm tube turns it inside out, which is what made a
 * patch of mushrooms flicker.
 */
function mushroomGeometry(rng) {
  const stemH = rngRange(rng, 0.2, 0.44);
  const stem = new THREE.CylinderGeometry(0.028, 0.045, stemH, 7, 1);
  stem.translate(0, stemH / 2, 0);

  const r = rngRange(rng, 0.1, 0.17);
  const squat = rngRange(rng, 0.55, 0.85);
  const dome = new THREE.SphereGeometry(r, CAP_SIDES, 7, 0, TAU, 0, CAP_THETA);
  dome.scale(1, squat, 1);
  const rimR = r * Math.sin(CAP_THETA);
  const rimY = r * Math.cos(CAP_THETA) * squat;
  /**
   * How far the gills hang below the rim: 45% of the dome's own height above
   * it. A fraction rather than a constant so that the flattest cap the rng can
   * draw still gets an underside with some depth to it, and the tallest one
   * does not get a spike.
   *
   * The cone is built apex-UP by three and turned over, which flips its normals
   * with it — so they point down and outward, which is what makes the underside
   * front-facing to an eye below it and is the whole point of adding it.
   */
  const drop = (r * squat - rimY) * 0.45;
  const gills = new THREE.ConeGeometry(rimR, drop, CAP_SIDES, 1, true);
  gills.rotateX(Math.PI);
  gills.translate(0, rimY - drop / 2, 0);
  /**
   * The two rings meet exactly. `SphereGeometry` lays its rim at
   * `(-cos φ, sin φ) · r sin θ` and `ConeGeometry` lays its base at
   * `(sin θ, cos θ) · radius`; the parameterisations are a reflection of one
   * another, so the two are not the same VERTEX in the same order, but at
   * twelve segments they are the same twelve POINTS — every multiple of 30° on
   * a circle of radius `rimR`. `mergeVertices` welds by position and does not
   * care about the order, so the rim closes into one ring with one normal, and
   * the cap can be inflated and deflated without ever splitting along it.
   */
  const cap = BufferGeometryUtils.mergeGeometries([dome, gills], false);
  dome.dispose();
  gills.dispose();
  cap.translate(0, stemH, 0);
  return {
    stem: gaugeBreath(weldProp(stem), 0.028 * BREATH_OF_THICKNESS),
    cap: gaugeBreath(weldProp(cap), drop * BREATH_OF_THICKNESS),
  };
}

/**
 * METRES ACROSS ONE TILE OF THE FLOOR MAP, AT EACH OF THE TWO SCALES.
 *
 * The map is 512², so the macro tile puts a texel at 1.43 cm and the fine tile
 * at 2.56 mm. What each scale DRAWS follows from that and is the reason there
 * are two of them: `forestFloor`'s leaves are 3.5–10.5% of the canvas, so at
 * 7.3 m they are 26–77 cm — the big entire leaves of a rainforest, seen from
 * standing height — and at 1.31 m the same marks are 4.6–13.7 cm, which is the
 * litter you are actually walking on. Its roots are 60–210 px, so the macro tile
 * draws them at 0.9–3.0 m, which is the scale a real surface root runs at, and
 * the fine tile turns them into twigs.
 *
 * 5.57:1, and deliberately not a round ratio. Two scales of the same canvas at
 * an integer ratio re-align every few tiles and the repeat becomes visible as a
 * plaid; the fine sample is also rotated 34° off the macro one, so there is no
 * bearing along which the two grids agree.
 *
 * NEITHER NUMBER IS A MULTIPLE OR A DIVISOR OF 128, which is the chunk pitch.
 * The UV is world XZ, so the tiling is continuous across chunk borders whatever
 * these are — but a tile that divided the chunk would put a texture seam and a
 * geometry seam in the same place, and coincident seams are what the eye finds.
 */
const FLOOR_MACRO_M = 7.3;
const FLOOR_FINE_M = 1.31;
/**
 * How much of the floor map's structure reaches the albedo.
 *
 * 1.0 is the raw normalised product; this is a `mix` from white, so values ABOVE
 * one extrapolate and are a contrast gain on the map — and because the map's
 * mean is exactly 1.0, extrapolating about it is mean-preserving. That is the
 * whole reason for normalising: a gamma or a scale would have made the floor
 * brighter or darker as a side effect of making it more detailed, and those are
 * two different decisions.
 *
 * The negative tail is clamped. Above 1.0 the extrapolation can in principle
 * cross zero — it does so wherever the normalised product falls below
 * 1 - 1/gain, which at 1.18 is 0.15, and that needs both samples to land on a
 * dark mark at once. Rare and shallow, and clamped anyway: a negative albedo
 * multiplied by a coloured light is a channel inversion, not a dark patch, and
 * the failure would be a scatter of magenta specks rather than anything a
 * reviewer would recognise as a clipping bug.
 */
const FLOOR_AMOUNT = 1.18;
/** Peak sky-sheen added on standing water, at grazing incidence. */
const WET_GLOSS = 2.6;

/**
 * The ground material: Lambert, vertex colours, and the two things the floor was
 * missing.
 *
 *
 * 1. A TEXTURE, PROJECTED FROM WORLD XZ, BECAUSE THE MESH HAS NO UVs.
 *
 * `heightGrid` emits position, normal, colour and `aWet` and nothing else, so
 * `material.map` is not available: three would compute `vMapUv` from a `uv`
 * attribute that does not exist, WebGL would hand it a constant zero, and the
 * whole world would be one texel. Generating UVs is the obvious fix and it is
 * the worse one — a per-chunk float2 attribute is 52 KB more upload per chunk
 * for a value that is a linear function of a position already being uploaded.
 *
 * So the UV is `rrSurf.xz`, which is the world position living.js already
 * exports for the trip. That costs nothing, has no seams anywhere (world space
 * is continuous across chunk borders by construction), and it comes for free
 * with the property that the floor's grain swims with the surface warp during a
 * trip instead of sliding over it.
 *
 * THE MAP IS DIVIDED BY ITS OWN MEAN BEFORE IT MULTIPLIES ANYTHING. See the
 * pivot in `forestFloor`. Its measured linear mean is (0.561, 0.527, 0.483), so
 * sampled twice and multiplied an unnormalised map would take the ground to
 * 0.30/0.28/0.23 of its brightness — a two-stop exposure cut, and a warm one,
 * arriving as a side effect of a texture edit.
 *
 * TWO FETCHES, AND THE FADE IS FREE. Both samples are of a mipped, wrapped,
 * 8×-anisotropic texture, so at distance each one converges to its own mean and
 * the normalised product converges to exactly 1.0 — the modulation fades itself
 * out into the flat vertex colour with no distance term, no smoothstep and no
 * chance of the metre-scale leopard print this project has removed twice.
 *
 *
 * 2. A WET SHEEN, WHICH IS WHAT `aWet` WAS ALWAYS FOR.
 *
 * `aWet` has been computed, transferred and bound since the chunk streamer was
 * written, and read by nothing. Here it is a varying and it does two jobs: the
 * vertex colour is already darker and richer where it is high (terrain.js), and
 * this adds a grazing-angle reflection of the sky on top — which is the whole
 * optics of wet ground. Water fills the surface roughness, so the diffuse goes
 * down and a specular lobe appears, and at the grazing angles a floor is nearly
 * always seen at, that lobe is most of what you see.
 *
 * THE SHEEN COLOUR IS `fogColor`. Not a constant, and not the sun: what a
 * horizontal puddle under a closed canopy reflects is the sky, and `fogColor` is
 * this scene's own idea of what the distance looks like — so the sheen tracks
 * dawn, noon, dusk and the trip's own grading without a line of code here. At
 * night it goes to nearly nothing, which is correct.
 *
 * IT IS SHAPED BY THE FLOOR MAP. `rrFloorL` is the map's luminance at this
 * fragment, and the sheen is gated on the DARK part of it, so the shine lands in
 * the hollows between the leaves and the roots rather than evenly over
 * everything. That is where the puddles come from, and it costs a smoothstep on
 * a value the albedo already computed — no new fetch, no new geometry.
 *
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. Nothing here makes the ground
 * transparent, alpha-tested or double-sided. Hiding the floor was measured at
 * 0.27–2.48 ms SLOWER depending on the station, because it is the frame's best
 * early-Z occluder; the additions are two texture fetches and a dot product on a
 * surface that still writes depth first and unconditionally.
 */
function groundMaterial() {
  const material = makeLiving(new THREE.MeshLambertMaterial({ vertexColors: true }), 'terrain');
  const floor = forestFloor();
  const mean = floor.userData.mean ?? { r: 0.5, g: 0.5, b: 0.5 };

  /**
   * WRAPPED AROUND `makeLiving`'S HOOK RATHER THAN UNDER IT.
   *
   * `makeLiving` chains onto whatever `onBeforeCompile` it finds and calls it
   * FIRST, so a hook installed before it would run before its declarations were
   * spliced in — which is fine for text but means this code could not see
   * `rrSurf`, and could not be placed relative to the living layer's own blocks.
   * Installing afterwards and calling through gives both. The anchors used below
   * — color_fragment and opaque_fragment — are ones living.js does not touch, so
   * neither hook can eat the other's replacement.
   */
  const chained = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    chained?.(shader, renderer);
    shader.uniforms.uFloorMap = { value: floor };
    shader.uniforms.uFloorRep = {
      value: new THREE.Vector2(1 / FLOOR_MACRO_M, 1 / FLOOR_FINE_M),
    };
    shader.uniforms.uFloorNorm = {
      value: new THREE.Vector3(1 / (mean.r * mean.r), 1 / (mean.g * mean.g), 1 / (mean.b * mean.b)),
    };
    shader.uniforms.uFloorAmt = { value: FLOOR_AMOUNT };
    shader.uniforms.uWetGloss = { value: WET_GLOSS };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aWet;\nvarying float vRrWet;'
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vRrWet = aWet;');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform sampler2D uFloorMap;',
          'uniform vec2 uFloorRep;',
          'uniform vec3 uFloorNorm;',
          'uniform float uFloorAmt;',
          'uniform float uWetGloss;',
          'varying float vRrWet;',
          '// The floor map luminance at this fragment, 1.0 = the map average.',
          'float rrFloorL;',
        ].join('\n')
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
  {
    vec2 rrFuv = rrSurf.xz;
    vec3 rrFa = texture2D(uFloorMap, rrFuv * uFloorRep.x).rgb;
    // Rotated 34 degrees so the two scales share no axis. See FLOOR_MACRO_M.
    vec2 rrFrot = vec2(rrFuv.x * 0.829 + rrFuv.y * 0.559, rrFuv.y * 0.829 - rrFuv.x * 0.559);
    vec3 rrFb = texture2D(uFloorMap, rrFrot * uFloorRep.y).rgb;
    vec3 rrFloor = rrFa * rrFb * uFloorNorm;
    rrFloorL = dot(rrFloor, vec3(0.2126, 0.7152, 0.0722));
    diffuseColor.rgb *= max(vec3(0.0), mix(vec3(1.0), rrFloor, uFloorAmt));
  }`
      )
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `
  {
    #ifdef USE_FOG
      vec3 rrSky = fogColor;
    #else
      vec3 rrSky = vec3(0.30, 0.38, 0.48);
    #endif
    // Wet where the terrain says so, and wettest in the map's own hollows.
    float rrWet = clamp(vRrWet, 0.0, 1.0) * smoothstep(1.10, 0.70, rrFloorL);
    if (rrWet > 0.003) {
      // Schlick, near enough: a fourth power is a puddle, a square is a sheet of
      // wet plastic, and the difference at 40 degrees off grazing is 3x.
      float rrF = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
      rrF *= rrF;
      rrF *= rrF;
      outgoingLight += rrSky * (rrF * rrWet * uWetGloss);
    }
  }
#include <opaque_fragment>`
      );
  };
  return material;
}

export function buildForest(scene, seed = 'grove-01') {
  const group = new THREE.Group();
  group.name = 'forest';
  scene.add(group);
  colliders.length = 0;

  // ---- ground -------------------------------------------------------------
  /**
   * One material, many meshes.
   *
   * The ground is no longer a single 380 m plate; it is a ring of 128 m chunks
   * that follows the camera and is rebuilt as you walk (see ground.js). Every
   * chunk shares this one material instance, so the trip's uniform block still
   * costs one write per frame however many chunks are resident, and three's
   * program cache sees exactly one terrain program.
   *
   * Nothing is built here. The first chunks arrive over the following handful
   * of frames, which all happen behind the entry gate.
   */
  const groundMat = groundMaterial();
  const groundField = new GroundField(groundMat);
  group.add(groundField.group);

  // ---- trees --------------------------------------------------------------
  /**
   * Three archetypes per species. Fewer and the repetition is visible from the
   * clearing; more and the load time starts to be felt for a difference nobody
   * can see, because instance rotation and scale already hide a great deal.
   *
   * AN ARCHETYPE IS NOW A SUB-POPULATION, NOT JUST A SKELETON. It carries its
   * own canopy texture and its own tint palette as well as its own shape — see
   * the variants block at the top of trees.js — so the three oaks in a view are
   * a plain one, one in acorn and a dark one rather than the same tree rotated.
   * The count is passed in because the variant table is cycled to cover it:
   * these two numbers are allowed to disagree and must not be assumed equal.
   */
  const ARCHETYPES = 3;
  const archetypes = [];
  for (const name of SPECIES_NAMES) {
    const mats = speciesMaterials(name, ARCHETYPES);
    for (let a = 0; a < ARCHETYPES; a++) {
      const grown = growTree(`${seed}:${name}:${a}`, name);
      archetypes.push({ name, mats, grown });
    }
  }

  /**
   * Every instanced layer in the world goes through the bucket culler — see
   * culling.js. Instances live in a slab grouped by map cell, and the culler
   * copies the visible cells into the mesh's own attributes whenever the camera
   * has moved enough to change which cells those are.
   *
   * One culler for the whole forest, registered layer by layer at the bottom of
   * this function. Nothing is added to it here because nothing is placed here
   * any more: every instance in this wood arrives from a worker.
   */
  const culler = new InstanceCuller();

  // ---- undergrowth --------------------------------------------------------
  /**
   * THE TINTS ON THIS LAYER AND THE THREE BELOW WERE ALL YELLOW-GREEN, AND
   * THEY MOVED TOGETHER.
   *
   * `0xb6cc8c` and its neighbours are a pale hay colour. Multiplied over a
   * texture that was ALSO drawn at a yellow-green hue, the product was the
   * single most temperate thing in the frame — a lawn under an Amazonian
   * canopy. Every one of these moved toward a true green by taking red out and
   * putting a little blue back, and they were checked in luminance rather than
   * by eye: 0xb6cc8c is Rec.709 luma 195 and 0x9ecc94 is 190, a 2.5% drop.
   *
   * THAT CHECK IS NOT PEDANTRY, it is the trap the bramble block in
   * undergrowth.js records at length. A card's screen colour is the texture
   * times the material colour times the instance tint, three factors that each
   * look reasonable alone and whose product can be four per cent. "Greener"
   * done by eye means "darker" every time, and darker down here does not read
   * as lush, it reads as a hole in the floor.
   */
  /**
   * ==== AND THE SWARD'S COLOUR LEFT THIS FILE ENTIRELY ======================
   *
   * `sat: 42` became `sat: 10` and the material colour became white. The
   * sward's hue now lives in ONE place — the two linear triples at the top of
   * scatter.js, lerped by a value-noise field of the world position — and this
   * texture supplies only the shape and the within-blade shading.
   *
   * THAT IS THE FIX FOR THE PROBLEM THE BLOCK ABOVE DESCRIBES, rather than
   * another lap of it. Three green factors multiplied together cannot be
   * balanced by tuning any one of them, because the failure is structural: the
   * old texture's red channel averaged 0.054 of linear light, so whatever red a
   * tint asked for was multiplied by a twentieth and deleted. A layer whose
   * colour cannot reach red cannot have a dry patch in it, and a floor with no
   * dry patch in it is a printed pattern. One factor carrying the colour and
   * two carrying luminance is the only arrangement in which a two-ended ramp
   * reaches both ends.
   *
   * The full before/after luma table — texture, material and tint, measured
   * rather than asserted, product luma 0.07401 to 0.07691 — is in scatter.js
   * with the field that drives it, because that is where the decision is made.
   * The only thing worth repeating here is the direction: this is 3.9%
   * BRIGHTER, and the reason the arithmetic was done at all is that going
   * greener by eye means going darker every time.
   */
  const grassTex = herbTuft({ key: 'sward', seed: `${seed}:grass`, hue: 128, sat: 10, light: 42 });
  /**
   * `receivesShadow: false` HERE AND ON EVERY OTHER CARD LAYER BELOW, for the
   * reason trees.js:2575 states for the trunk and the leaf — and this is the
   * half of that change which never landed.
   *
   * `addStreamed` gives every one of these meshes `receiveShadow: false` (see
   * its default), and in three that is a runtime uniform: the fragment shader
   * skips the lookup, but the VERTEX shader still runs the shadow normal bias,
   * still does the `directionalShadowMatrix` multiply, and still exports a vec4
   * varying carrying the result. Four floats of vertex export, on the largest
   * instance layers in the world — grass is 65 536 capacity and 12 296
   * submitted in a canopy frame — for a value the fragment stage is guaranteed
   * to throw away.
   *
   * The deep station measures VERTEX-BOUND at 67%, so this is the stage that
   * matters, and on this GPU it is worth more than the float count suggests:
   * unused exports are stripped by NVIDIA's compiler and NOT by AMD's, which is
   * the argument living.js already makes at length.
   *
   * THE INVARIANT IS THE SAME ONE, and it is still not checked anywhere: a mesh
   * drawn with one of these will not receive shadows whatever `receiveShadow`
   * says. Every layer using them defaults to false today; `rockMat`, `logMat`
   * and the `stumps` layer that shares `logMat` are the three that genuinely do
   * receive, and they are deliberately left alone.
   */
  const grassMat = makeLiving(
    new THREE.MeshLambertMaterial({
      map: grassTex,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
      // WHITE, AND IT IS A DELETION RATHER THAN A COLOUR. This slot used to
      // hold 0x9ecc94, a third green factor whose own Rec.709 luma is 0.5259 —
      // so it was halving the layer's brightness to say something the tint was
      // already saying. Removing it is what pays for the near-neutral texture
      // and the wider tint range; see the arithmetic above and in scatter.js.
      color: 0xffffff,
    }),
    'plant',
    { receivesShadow: false }
  );
  const grassGeo = clumpGeometry(0.42, 0.52, 3, makeRng(`${seed}:grassgeo`), 0.2, PLANT_SCALE.grass);


  // Ferns: bigger, shade-loving, so they go where the trees are.
  const fernTex = fernFrond({ key: 'fern', seed: `${seed}:fern`, hue: 122, sat: 40, light: 44 });
  const fernMat = makeLiving(
    new THREE.MeshLambertMaterial({
      map: fernTex,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
      color: 0x92c28c,
    }),
    'plant',
    { receivesShadow: false }
  );
  const fernGeo = clumpGeometry(1.5, 1.15, 4, makeRng(`${seed}:ferngeo`), 0.3, PLANT_SCALE.fern);

  // ---- rocks and fallen wood ---------------------------------------------
  const rockMat = makeLiving(new THREE.MeshLambertMaterial({ color: 0x8e8d82 }), 'prop');
  const rockGeos = [0.5, 0.9, 1.7].map((s) => rockGeometry(makeRng(`${seed}:rock:${s}`), s));

  // A fallen log is a trunk lying down, so it takes the same procedural grain.
  // Untextured, which makes it the clearest demonstration of what that block
  // does: everything you can see on one of these is generated in the shader.
  const logMat = makeLiving(new THREE.MeshLambertMaterial({ color: 0x53412c }), 'prop', {
    bark: true,
  });
  const logGeo = logGeometry(makeRng(`${seed}:loggeo`), 5.4, 0.38);

  // ---- mushrooms ----------------------------------------------------------
  const shroomRng = makeRng(`${seed}:shroom`);
  const { stem, cap } = mushroomGeometry(shroomRng);
  const stemMat = makeLiving(
    new THREE.MeshLambertMaterial({ color: 0xd9cdae, emissive: 0x1b1508, emissiveIntensity: 0.5 }),
    'prop',
    { receivesShadow: false }
  );
  const capMat = makeLiving(
    new THREE.MeshLambertMaterial({ color: 0x8e5f9e, emissive: 0x2a1740, emissiveIntensity: 1.1 }),
    'prop',
    { receivesShadow: false }
  );


  /**
   * The glow around a patch: a soft additive blob at each cap, so a patch is
   * visible through undergrowth from a distance and unmistakable up close.
   * Bloom does the rest.
   *
   * ONE `THREE.Points` FOR THE WHOLE WORLD, not a `Sprite` per cap. There used
   * to be a sprite each for the fifteen authored patches near the origin —
   * seventy-five scene objects and seventy-five draw calls — and once every
   * patch in the world streams, a sprite each is unbounded. The cloud is built
   * and refilled by `forest-field.js`; see `glowPoints` at the bottom of this
   * file for the material, which does its own fog for a reason.
   */
  const glowTex = glowSprite({ key: 'shroom', inner: 'rgba(190,150,255,0.85)' });

  // ---- the understorey ----------------------------------------------------
  /**
   * NINE MORE LAYERS, AND A FIELD THAT DECIDES WHICH OF THEM A PLACE GETS.
   *
   * Grass, ferns, stones and deadfall are one thing at one density: a wood with
   * groves and glades in it — `forestDensity` sees to that — standing on a floor
   * that is identical everywhere. These nine apply the same idea to the ground.
   * A couple of slow noise fields decide what KIND of place this is and every
   * layer reads them; see `character()` in scatter.js for the fields themselves
   * and for why the weights are built to exclude one another instead of summing.
   *
   * The regions are meadow (long grass in the glades), bramble (dark thicket on
   * the broken canopy edge), needle litter (dry, shaded, and almost bare),
   * damp deadfall along the stream, and flowery open ground. Four of the five
   * add geometry. The fifth is the most valuable and adds almost none: under a
   * closed canopy the meadow, bramble and flower weights all collapse, so those
   * hundred metres get sticks and leaf litter and nothing else. Emptiness is
   * variety too, and it renders for free.
   *
   * WHAT IS LEFT IN THIS FILE IS THE GEOMETRY AND THE MATERIAL, and that is all
   * that was ever supposed to be here. Every one of these layers used to exist
   * twice — an eager `scatter()` over a disc around the origin, and a per-sector
   * rule in `underSector` — with the streamed half forbidden to place anything
   * inside 163.4 m so the two would not overlap. The eager half is gone; the
   * placement rules live in scatter.js and nowhere else. See that file's header
   * for the measurements, and the comments below for the card sizes, which are
   * unchanged and are the expensive decisions.
   *
   *
   * ==== FEWER AND BIGGER, WHICH IS ONE CHANGE SERVING TWO COMPLAINTS ========
   *
   * The complaints were "I don't see any tall grass and the bushes are small"
   * and "we need better framerate", and they have the same answer, because the
   * frame is fill-bound and fill is paid per DISCARDED FRAGMENT rather than per
   * instance. One large mostly-opaque card is cheaper than six small lacy ones
   * covering the same ground: the opaque one writes depth and occludes what is
   * behind it, the lacy ones defeat early-Z six times over. So every layer
   * below roughly doubled in card area and roughly halved in count.
   *
   * WHY THE TALL GRASS WAS INVISIBLE. Three causes, measured before anything
   * was changed, in order of how much they mattered.
   *
   *   1. IT WAS NOT TALL. The card was 1.15 m and the instance height was
   *      `(0.5 + m·0.5) × 0.82–1.2` where `m` is the meadow weight — and 94% of
   *      the world has `m` below 0.3, so the multiplier sat near 0.55 almost
   *      everywhere. Measured on the ground: mean meadow height 0.71 m at
   *      spawn, 0.65 m at 200 m, and 0.90 m standing in the single most
   *      meadow-y square metre inside 1.5 km. Knee-high, in a wood whose eye is
   *      1.6 m up. The comment here used to claim "waist to chest high", which
   *      described the card and not the plant.
   *
   *   2. IT WAS USUALLY ABSENT. `character()` gated meadow on `1 - canopy·1.45`
   *      against a wood whose mean canopy is 0.586, so the weight was 0.15 at
   *      the average point and zero above canopy 0.69. Counted within 40 m of
   *      the player: 626 at spawn, 321 at 200 m, and ZERO at both 700 m and
   *      1500 m. A layer you can walk a kilometre without meeting is not a
   *      layer the player believes exists.
   *
   *   3. THE CLEARING WAS THE SHORTEST GRASS IN THE WORLD. The spawn damping
   *      multiplied `m` — and therefore the HEIGHT as well as the density — by
   *      0.22 at the centre, so the one place guaranteed to be looked at got
   *      the worst of it. It was not bald, which is why this is third and not
   *      first; it was mown.
   *
   * All three are fixed and each is documented where it lives: the card and the
   * height term here, the light coefficient in `character()` in scatter.js, and
   * the drift and `feet` fields on the meadow rule in `underSector`.
   *
   * WHAT IT COST AND WHAT IT BOUGHT, counted over the disc that scatter used to
   * cover, with the geometry's own bounding box before and after.
   *
   *     meadow    5661 -> 3362   card 0.69x1.12 -> 0.76x1.89, height x2.4
   *     sticks    3939 -> 3281   1.1 m -> 1.7 m long, 2.6 -> 3.8 cm thick
   *     bushes    2244 ->  917   1.40x0.80 -> 1.85x1.64, and upright
   *     bramble   2063 ->  756   1.49x0.93 -> 1.96x1.49
   *     flowers   1676 -> 1511   0.36x0.31 -> 0.51x0.45
   *     litter    1514 -> 1018   1.03 m -> 1.23 m mats
   *     reeds     1157 ->  594   0.49x1.49 -> 0.71x2.02
   *     saplings   711 ->  316   1.67 m -> 2.50 m
   *     stumps      48 ->   78   unchanged geometry, wider reach
   *
   * 19 013 -> 11 833, a 38% cut, and the layers a player is close to are cut
   * harder than that: counted inside the camera frustum at 2560×1440, 7259 ->
   * 4334 instances at spawn and 20 646 -> 11 381 at 200 m, with the understorey
   * triangle count down 42% and 48% at the same two stations.
   *
   * That cut is what paid for the protected disc going away. Extending all nine
   * layers to 163.4 m was costed at the OLD densities as +14 800 always-resident
   * instances and rejected, and at the new ones as 1.69 ms of isolated fill
   * against 0.94 and rejected again. Deleting the disc instead costs neither,
   * because it does not extend anything: it replaces a set of fixed discs with
   * the 80 m ring that already followed the player everywhere else in the world.
   */


  /**
   * ONE MATERIAL PER LOOK, AND EVERY CARD LAYER IN THE WOOD SHARES A PROGRAM.
   *
   * Six materials cover the seven card layers below — the bushes and the
   * saplings share `shrubMat` — and every one of them is a
   * `MeshLambertMaterial` with a map, an alphaTest of 0.4, `DoubleSide` and an
   * instance colour. That is bit for bit the feature set the sward and the
   * ferns already use, so three's program cache hands all nine of those layers
   * the same compiled shader and `makeLiving`'s `customProgramCacheKey` agrees.
   * Seven new card layers therefore cost seven draws and ZERO new programs,
   * which is the difference between this being affordable and not. Deviating
   * from that set — a different `side`, a second alpha-test value,
   * `transparent: true` — would silently compile another one each, and the
   * symptom would be a load-time hitch rather than anything visible.
   *
   * The two woody layers duck the question entirely: sticks take a plain prop
   * Lambert that shares the stones' program, and the stumps reuse `logMat`
   * itself, so a stump is made of the same material as a fallen log and gets
   * the procedural bark for nothing.
   */
  const cardMaterial = (map, color) =>
    makeLiving(
      new THREE.MeshLambertMaterial({ map, alphaTest: 0.4, side: THREE.DoubleSide, color }),
      'plant',
      // See grassMat: none of the eleven layers built from this receives a
      // shadow, so none of them should be exporting a shadow coordinate.
      { receivesShadow: false }
    );

  // ---- meadow: long grass in the glades -----------------------------------
  /**
   * The single most striking thing added, and the only one that needed a size
   * as well as a shape.
   *
   * The existing sward is a 0.52 m tuft. This is a 1.95 m card, so the plant on
   * the ground stands 1.1 m to 2.4 m depending on how deep the meadow is, and
   * standing in it is a different experience from standing on the other — it
   * moves against your legs, it hides the ground, and the fact that it STOPS at
   * the edge of a glade is what makes the glade a place.
   *
   * IT USED TO BE A 1.15 m CARD AND THAT IS WHY NOBODY COULD FIND ANY TALL
   * GRASS. Cause 1 of the three in the section header: measured on the ground,
   * the mean meadow plant was 0.71 m at spawn and 0.65 m at 200 m, because the
   * instance height multiplier `(0.5 + m·0.5)` sits near 0.55 over 94% of the
   * world. A 0.65 m plant is the sward with extra steps. The card is now 1.95 m
   * and the multiplier starts at 0.62 rather than 0.5, which puts the FLOOR of
   * this layer at 1.09 m — above the old ceiling — and its deepest drifts over
   * your head.
   *
   * THE CARD IS NO WIDER THAN IT WAS, AND THAT IS A COST DECISION.
   *
   * It was 0.90 m for one build. Width is what a card costs — a plant's fill is
   * its width times its height, and the ground it hides is its width times its
   * count — and nobody asked for wider grass, they asked for taller. Measured
   * in isolation at 5120×2880, the wide version put this layer 40% over the old
   * one on its own. At 0.66 m the card is 1.82× the area it was, all of it
   * height, and the width that was saved was spent on COUNT instead — which is
   * the same fill for more ground covered, because tall cards packed close
   * overlap and occlude one another where wide ones side by side do not.
   *
   * The texture went from 13 blades to 19 wider ones anyway. On a card the same
   * width and 1.7× the height, more and fatter blades is what keeps the fill
   * per pixel of silhouette up, and fill is the cheap direction. Four cards,
   * unchanged: the way to buy a bigger plant is to draw the same card fuller
   * and scatter fewer of them.
   */
  const meadowGeo = cardClump({
    width: 0.66,
    height: 1.95,
    cards: 4,
    rng: makeRng(`${seed}:meadowgeo`),
    lean: 0.15,
    /**
     * 0.29, up from 0.17, and it is a RATIO that is being held rather than a
     * distance.
     *
     * `check-plants.mjs` measures peak displacement over the plant's own height
     * and fails above 0.55. At the peak every term scales as 2.906 × aScale, so
     * the old 0.17 on a 1.12 m card measured 0.443 — and holding that same 0.44
     * on a 1.95 m card means 0.44 × 1.95 / 2.906 = 0.297. Leaving it at 0.17
     * would have been a two-metre plant that sways like a 1.1 m one, which
     * reads as stiff hay rather than as long grass; the whole point of grass
     * this tall is that it moves.
     */
    scale: 0.29,
  });
  const meadowMat = cardMaterial(
    heliconiaTexture({ key: 'meadow', seed: `${seed}:meadow` }),
    // Was 0xc4cf94. Same luma to within 2% — see the tint note on `grassMat`.
    0xa9cf9a
  );

  // ---- bramble: the thicket -----------------------------------------------
  /**
   * Dark, low, wide and tangled. It has no collider — see the note on colliders
   * at the end of this section — so it does not actually stop you, and it does
   * not need to: the whole value of a thicket is that you can see it from
   * thirty metres and choose to go round, and a wood in which every route is
   * equally walkable is a wood with no geography in it.
   */
  /**
   * A THIRD AS MANY AND HALF AGAIN AS TALL: 1.70 × 1.50 m against 1.30 × 0.95,
   * at 2.5 m spacing rather than 1.5.
   *
   * A thicket is the one thing down here whose whole job is to be an obstacle
   * you read from thirty metres, and 2063 knee-high tangles do that worse than
   * 756 waist-high ones — a mass reads as impassable at the size where you
   * cannot see the ground through it, and the old card was low enough that you
   * always could. The tilt came down from 0.24 to 0.2 with the extra height,
   * because the same pitch on a taller card lays it further over.
   *
   * The width is 1.70 rather than the 1.95 the first attempt used, and `spread`
   * came back from 0.26 to 0.2, both for the reason the meadow's width did: a
   * 4-card rosette 1.95 wide with 0.26 of spread measures 2.24 m across, which
   * is 2.4× the old card's AREA before a single instance is scaled up. Height
   * is what makes a thicket read; width is what makes it expensive.
   */
  const brambleGeo = cardClump({
    width: 1.7,
    height: 1.5,
    cards: 4,
    rng: makeRng(`${seed}:bramblegeo`),
    lean: 0.24,
    tilt: 0.2,
    spread: 0.2,
    bulge: 0.5,
    flexBase: 0.12,
    // Same ratio-holding arithmetic as the meadow: 0.344 × 1.50 / 2.906.
    scale: 0.17,
  });
  const brambleMat = cardMaterial(
    brambleTexture({ key: 'bramble', seed: `${seed}:bramble` }),
    // Was 0xafc48d. Same luma to within 2% — see the tint note on `grassMat`.
    0x99c495
  );

  // ---- bushes and saplings ------------------------------------------------
  /**
   * The mid-storey, which the wood did not have at all.
   *
   * Everything before this was either under your knee or over your head, and a
   * real wood is full of things at eye level — that gap is a large part of why
   * the middle distance read as empty. Two silhouettes off one material: a low
   * wide dome, and a leggy sapling with a visible stem. They deliberately do
   * not share a biome rule, so a stand of saplings and a run of bushes are
   * different sights.
   */
  const shrubTex = shrubTexture({ key: 'shrub', seed: `${seed}:shrub` });
  // Was 0xbfd199. Same luma to within 2% — see the tint note on `grassMat`.
  const shrubMat = cardMaterial(shrubTex, 0xa8d19f);
  /**
   * TALLER AND LESS SPLAYED THAN THE FIRST VERSION, WHICH WAS A BLACK SPLAT.
   *
   * 1.5 m wide, 0.92 m tall and 35° of outward pitch produced a dome twice as
   * wide as it was high, and the eye meets undergrowth from above — a metre
   * sixty up, looking down. So the shape presented to the camera was a flat
   * rosette lying on the ground, and with a 0.85 outward normal bulge the top
   * of that rosette faced sideways rather than at the sky and took almost no
   * light. In shade it came out as a solid black star on the floor, which
   * `isolate.mjs` attributed to this layer by hiding one layer at a time and
   * looking; it was indistinguishable from the bramble in a still.
   *
   * Three changes, all pulling the same way: narrower than it is tall, less
   * pitch, and most of the normal lift going UP rather than outward, so the
   * crown of the bush catches the sky the way the sward already does.
   *
   *
   * AND IT WAS STILL A SPLAT, WHICH IS WHY THE COMPLAINT CAME BACK.
   *
   * "Narrower than it is tall" was the right diagnosis and it was not what got
   * built: the parameters above are 1.15 wide by 1.05 high, but 0.42 rad of
   * pitch lays each card back onto its own width, and the geometry that came
   * out measured 1.40 m wide by 0.795 m TALL. Still nearly twice as wide as
   * high, still a rosette, and at an instance scale of 0.75–1.38 it stood 0.6
   * to 1.1 m — an ankle-to-knee splat you walk through without noticing, which
   * is exactly what "the bushes are small" describes.
   *
   * So this is the second attempt at the same fix and it is measured on the
   * OUTPUT rather than on the inputs. 1.5 × 2.0 with the pitch cut to 0.3, the
   * spread held at 0.22 and `rise` taken from 0.1 to 0.4 gives a bounding box
   * of about 1.72 × 1.64 m: a shoulder-height mass with its bulk lifted off the
   * floor, which is both what a shrub looks like and what stops the camera
   * meeting a flat rosette. 917 of them against 2244 (5.4 m spacing against
   * 3.4), each 2.7× the card area — so this is the one layer that comes out
   * with MORE total coverage than before, which is deliberate: it is the layer
   * the user named, and every other layer in the section paid for it. "Use
   * less" was in the request as well as "make them bigger", and at 5.4 m a
   * bush is something you come across rather than something you are always
   * standing next to, which is also what makes a big one worth noticing.
   *
   * `rise` is doing the real work in the silhouette. Lifting the cards' roots
   * off the ground puts a gap under the bush, and a mass with daylight under it
   * reads as a thing standing on the ground rather than as a decal printed on
   * it. The gap also means the ground's own shading is visible beneath, which
   * is what stops a big dark card looking like a hole.
   */
  const bushGeo = cardClump({
    width: 1.5,
    height: 2.0,
    cards: 4,
    rng: makeRng(`${seed}:bushgeo`),
    lean: 0.1,
    tilt: 0.3,
    spread: 0.22,
    rise: 0.4,
    bulge: 0.45,
    flexBase: 0.25,
    // 0.347 × 1.64 / 2.906, holding the ratio check-plants measured before.
    scale: 0.2,
  });

  /**
   * 2.8 m rather than 2.0, at 6.6 m spacing rather than 5.0.
   *
   * A sapling is the only thing in the mid-storey that is unambiguously a
   * TREE — thin stem, small crown, and a silhouette you read as "young" — and
   * at 2.0 m it was competing with the bushes for the same band of the frame.
   * Pushing it to 2.8 m puts its crown clear above them, which is what makes a
   * stand of saplings and a run of bushes two different sights rather than two
   * dressings of the same lump. 316 of them against 711, and the crown gained a
   * fourth card to survive being seen from further apart.
   */
  const saplingGeo = saplingGeometry(makeRng(`${seed}:saplinggeo`), { height: 2.8, scale: 0.23 });

  // ---- sticks -------------------------------------------------------------
  /**
   * Dead branches on the floor: sixteen triangles each and, per unit of cost,
   * the strongest "this is a real wood" cue in the whole file.
   *
   * ONE GEOMETRY, LENGTH VARIED BY THE INSTANCE. Scaling x from 0.35 to 1.8
   * turns a single 1.1 m stick into everything from a twig to a fallen bough,
   * and the alternative — a second geometry for the big ones — would have been
   * a second draw call for a difference the instance matrix already expresses.
   * The bounding sphere is measured with `spin` because these tumble on all
   * three axes, and `grow` takes the largest scale, so the sphere stays
   * conservative under the non-uniform stretch.
   *
   * Denser under a canopy and denser still on the damp ground, because that is
   * where branches fall and where they stay rather than rotting away.
   */
  /**
   * Thin and grey-brown, and both of those are corrections.
   *
   * At 3.5 cm radius and a warm 0x6d573a these came out as clean orange
   * dowels — the most conspicuous objects in the frame, which is precisely
   * backwards for something whose whole job is to be noticed only once you look
   * down. A dead branch on a forest floor is weathered grey with the colour
   * leached out of it, and it is thinner than you remember. 2.6 cm and a
   * nineteen-per-cent saturation puts them back where they belong.
   *
   * 1.7 m AND 3.8 cm NOW, at half the count. The colour argument above still
   * stands and is untouched; the size one was decided at a density of 3939 in
   * the disc, where a stick was one mark among many and the risk was that a
   * field of them read as a printed pattern. At 1878 the risk runs the other
   * way — a 1.1 m twig at 3 m spacing is a speck on an empty floor. These are
   * fallen BOUGHS as often as twigs now, which is what the litter biome needs,
   * and the instance length range below still takes them from 0.6 m to 3 m.
   * They are opaque and twenty triangles, so this is the cheapest coverage in
   * the file: no discards at all, and every pixel writes depth.
   */
  const stickGeo = stickGeometry(makeRng(`${seed}:stickgeo`), 1.7, 0.038);
  // `sticks` is the only layer using this, and it does not receive. See grassMat.
  const twigMat = makeLiving(new THREE.MeshLambertMaterial({ color: 0x56463a }), 'prop', {
    receivesShadow: false,
  });

  // ---- wildflowers --------------------------------------------------------
  /**
   * Tiny instances, enormous perceived value: they give the eye somewhere to
   * land, which a green floor otherwise never does.
   *
   * TWO NOISE FIELDS DO TWO DIFFERENT JOBS HERE. A 1.8 m field gathers them
   * into clumps, because flowers grow in clumps and an even sprinkle of them
   * reads as confetti. An 11 m field picks the HUE, so a whole patch is
   * buttercup yellow and the next one along is campion pink — the texture is
   * drawn almost white precisely so the instance colour can decide that, which
   * is what makes six kinds of flower cost one layer instead of six.
   */
  const flowerGeo = cardClump({
    width: 0.52,
    height: 0.5,
    cards: 2,
    rng: makeRng(`${seed}:flowergeo`),
    lean: 0.12,
    segments: 2,
    // 0.381 × 0.45 / 2.906, holding the ratio on the bigger card.
    scale: 0.058,
  });
  const flowerMat = cardMaterial(flowerTexture({ key: 'flower', seed: `${seed}:flower` }), 0xffffff);

  // ---- leaf litter and moss -----------------------------------------------
  /**
   * ONE LAYER, TWO MATERIALS OF THE WORLD, and the difference is a colour.
   *
   * Rust-brown drift under the pines and green cushions on the wet ground by
   * the stream are the same mats with different instance tints — see
   * `litterTexture`, which is drawn almost without hue for exactly this. Two
   * layers would have been two draws and two textures for something the
   * instance buffer expresses for nothing.
   *
   * Placed where the ground would otherwise be bare, which is the point: the
   * litter biome and the damp biome are the two regions this file deliberately
   * plants nothing tall in, and a floor with drifts and mats on it reads as a
   * decision rather than as an empty patch.
   */
  /**
   * 1.2 m mats rather than 1.0 m, at 3.5 m spacing rather than 1.9.
   *
   * The deepest cut in the pass and the least visible one, because a litter mat
   * is nearly opaque through its middle and lies FLAT: seen from a metre sixty
   * up at a grazing angle it covers a fraction of the pixels its area suggests,
   * and a bigger mat has proportionally less feathered rim, which is where all
   * its discards are. Cutting the count per square metre by 71% and its area by 44% takes
   * the drifted ground per square metre to 0.42× what it was — which is
   * invisible on a floor, and it is the kind of saving that paid for planting
   * the ground the protected disc used to leave bare.
   */
  const litterGeo = litterPatch(makeRng(`${seed}:littergeo`), 1.2, 0.013);
  const litterMat = cardMaterial(litterTexture({ key: 'litter', seed: `${seed}:litter` }), 0xffffff);

  // ---- reeds at the water -------------------------------------------------
  /**
   * The only layer keyed to the terrain rather than to the biome field, because
   * the stream is not a region — it is a line, and `wetness` already knows
   * where it is.
   *
   * Bounded in HEIGHT as well as in wetness: from a little below the water line
   * to a metre and a half above it, which is the bank. Testing wetness before
   * anything else is a real saving rather than fussiness — the reed grid walks
   * hundreds of cells per sector to find the handful on the bank, and `wetness`
   * is two sines where `heightAt` is a dozen octaves of noise.
   */
  const reedGeo = cardClump({
    width: 0.72,
    height: 2.3,
    cards: 3,
    rng: makeRng(`${seed}:reedgeo`),
    lean: 0.07,
    // 0.389 × 2.02 / 2.906. A reed is the tallest thing on the floor and it
    // should be the one that nods most.
    scale: 0.27,
  });
  // Was 0xb3c489. Same luma to within 2% — see the tint note on `grassMat`.
  const reedMat = cardMaterial(reedTexture({ key: 'reed', seed: `${seed}:reed` }), 0x9bc491);

  // ---- stumps -------------------------------------------------------------
  /**
   * The rarest thing on the floor by two orders of magnitude, sharing `logMat`
   * with the fallen wood — so a stump is literally made of the same material as
   * a log and gets the procedural bark for free, at no extra program and no
   * extra texture.
   *
   * A stump is the only object in a wood that says something HAPPENED here, and
   * that is worth a draw call all by itself. It is also the one layer down here
   * whose bark grain is oriented correctly: the field in living.js is squashed
   * in world Y, which is right for something vertical and is what makes a
   * horizontal log look faintly like bamboo.
   *
   * THE ONE LAYER THE "FEWER AND BIGGER" PASS LEFT ALONE, deliberately. At 20 m
   * spacing there is nothing here to cut, and 0.7 × 0.8 m is already the size of
   * a real stump.
   */
  const stumpGeo = stumpGeometry(makeRng(`${seed}:stumpgeo`), 0.7, 0.4);

  // ---- the mid-storey: understorey palms and tree ferns --------------------
  /**
   * THE ONLY THING IN THIS WOOD BETWEEN 5 m AND THE CANOPY.
   *
   * `sightlines.mjs` classifies what stopped each ray rather than counting
   * whether one was stopped, and after the tree pass its verdict was precise:
   * the composition problem was solved — bare-trunk hits across 2-12 m had gone
   * from ~27% to 2-6% — and what was left was a hole at a specific ALTITUDE.
   * The median sight line at 8 m had gone 23.6 -> 27.5 m and at 12 m 30.2 ->
   * 40.1 m, i.e. those two bands got EMPTIER while the average got better,
   * because shortening the trees and clumping their crowns pulled foliage down
   * out of 8-12 m into 2-6. The tell is the escape rate at 12 m: 4% -> 17% of
   * rays flying a hundred and twenty metres and hitting nothing whatever, at
   * exactly canopy-underside height. A wood with a roof does not do that.
   *
   * A 9 m GEOMETRY AT 0.58-1.42 IS 5.2 TO 12.8 m, so the crowns land between 4
   * and 12 m with the bulk of them at 7-11. That range is chosen against the
   * measurement and nothing else, and the tall skew in the instance scale — see
   * the `palms` rule in scatter.js — is there because the hole is at the top of
   * it.
   *
   * WHY THIS IS THE CHEAP WAY TO FILL THAT BAND, which is the whole reason it
   * is a bare stem with a crown on the end rather than a shrub scaled up. Cost
   * here is screen coverage and overdraw, not instances or triangles: an
   * alpha-tested card is 21x a solid triangle per unit of area. A stem is solid
   * geometry — sixty triangles of open tube, in the 8%-of-the-cost category the
   * per-layer census puts trunks in — and it carries the expensive cards to 8 m
   * and puts NONE of them at 1-4 m, where the wood is already full and where a
   * card fills the most screen. Filling the hole from the ground up would have
   * cost several times this for the same rays stopped, and it would have made
   * the near field claustrophobic, which is its own failure: a cathedral you
   * can see twenty metres into beats a hedge you can see five metres into.
   *
   * NO SHADOW, and that is measured rather than cautious. Leaf cards are 4.01 ms
   * of a 4.77 ms shadow pass while trunks — 73% of all triangles — are 0.42 ms.
   * The shadow camera is a 58 m box, so every one of these inside it would be
   * rendered again as alpha-tested fill. What is lost is real — a palm crown
   * throws a beautiful shadow — and it is not worth a third of the frame.
   *
   * NO COLLIDER EITHER, deliberately, and this is the one omission worth
   * writing down rather than the obvious call. A 12 m palm you walk through is
   * wrong. But `colliderGrid` is what fauna.js identifies trees by, using
   * radius alone — "anything under 0.8 is a tree and nothing else can be" — so
   * a slender stem pushed at its true 0.2 m would be indexed as a tree and the
   * birds would start perching eight metres above a palm as if it were an oak,
   * and pushing it at the 0.82 m floor instead stops the player half a metre
   * short of a pole he can see is thin. Both are worse than walking through it.
   * See `stumpCollider` in scatter.js for the contract.
   */
  const palmGeo = palmGeometry(makeRng(`${seed}:palmgeo`), {
    height: 9,
    /**
     * NINE FRONDS, NOT SEVEN, and the reason is the one thing a screenshot
     * settles that arithmetic cannot. A rosette seen end-on is half the cards
     * it has, and a crown silhouetted against the sky at 10 m has every one of
     * its alpha gaps backlit — the first build read as a handful of sticks with
     * leaves stuck on them. Two more cards is twelve triangles on a layer that
     * draws a few hundred, and the fronds themselves went wider and much
     * denser in the same pass, which is the cheap direction: fill is free,
     * silhouette is not.
     */
    fronds: 9,
    /**
     * 0.5, which is a RATIO of 0.158 rather than the 0.44 the ground layers
     * hold. `check-plants.mjs` measures peak displacement over the plant's own
     * height; at the peak every term scales as 2.906 x aScale, and this
     * geometry's bounding box is about 9.2 m, so 2.906 x 0.5 / 9.2 = 0.158. A
     * palm is a column with a thrashing head, not a blade of grass — holding
     * the grass ratio here would throw a twelve-metre plant four metres
     * sideways. It is still the tallest displacement in the understorey in
     * absolute metres, which is right: the fronds are what you see move.
     */
    scale: 0.5,
  });
  /**
   * A shade darker and less yellow than the shrubs, because these are seen
   * against the SKY as often as against the wood — a crown at 10 m with
   * daylight behind it is the one place in this forest a pale green card
   * blows out into a white smear. Luma 176 against `shrubMat`'s 195.
   */
  const palmMat = cardMaterial(
    palmFrondTexture({ key: 'frond', seed: `${seed}:frond` }),
    0x93bf8c
  );

  // ---- bromeliads: the bank ------------------------------------------------
  /**
   * THE STEEP GROUND WAS THE BALDEST GROUND IN THE WORLD AND IT SHOULD BE THE
   * LUSHEST.
   *
   * Every understorey layer rejects above a slope of 0.30-0.50 and the sward is
   * separately zeroed under a closed canopy, so a steep, high, shaded bank
   * hard-rejects literally every layer except rocks and sticks. That is
   * backwards. A bank in a rainforest gets light from the SIDE, which is the
   * one direction light gets in down there, and it is where the epiphytes that
   * cannot find a branch go instead: a cut slope in Amazonia is a wall of
   * bromeliads, Anthurium and Selaginella.
   *
   * So this layer's slope gate is INVERTED — it wants slope above 0.26 and gets
   * denser as the ground steepens — which makes it the only thing in the file
   * that plants where everything else refuses to. That is also why it can be
   * dense (2.6 m) without touching the frame anywhere the player usually
   * stands: on flat walkable ground it does not exist at all.
   *
   * WHITE MATERIAL, and it is the only card layer here that has one. The colour
   * is in the canvas; see the note on `bromeliadTexture`. A green material
   * colour multiplied over a scarlet texel is a dark maroon, which is the trap
   * this project has now hit three times.
   */
  const bromeliadGeo = cardClump({
    width: 1.25,
    height: 0.95,
    cards: 4,
    rng: makeRng(`${seed}:bromgeo`),
    lean: 0.2,
    tilt: 0.55,
    spread: 0.12,
    rise: 0.05,
    segments: 2,
    flexBase: 0.2,
    bulge: 0.6,
    // 0.34 x 0.85 / 2.906. A bromeliad is a stiff thing bolted to a bank; the
    // grass ratio would have it waving like seaweed.
    scale: 0.1,
  });
  const bromeliadMat = cardMaterial(
    bromeliadTexture({ key: 'bromeliad', seed: `${seed}:bromeliad` }),
    0xffffff
  );

  // ---- giant leaves --------------------------------------------------------
  /**
   * THE FEWEST AND LARGEST THINGS ON THE FLOOR, WHICH IS ALSO THE CHEAPEST WAY
   * TO BUY A JUNGLE.
   *
   * Three cards a metre and a half across at eleven-metre spacing: about a
   * hundred and seventy of them resident against the meadow's ten thousand. A
   * big solid card is cheaper per square metre of coverage than several small
   * wispy ones — the middle of it writes depth and occludes, a discard does
   * neither — so this is the direction the measurement has been pointing the
   * whole time, taken to its end.
   *
   * It is also the one layer here that is not about the sightline number at
   * all. It sits at 1.2-3.4 m, where the wood is already well filled, and it is
   * deliberately sparse so it does not fill it further; what it is for is the
   * complaint that the colour is "specks, not lushness". A perforated cordate
   * leaf the size of a door, with a lobster-claw Heliconia beside it, is a
   * thing you come across rather than a texture you walk through.
   */
  const bigLeafGeo = cardClump({
    width: 1.5,
    height: 2.1,
    cards: 3,
    rng: makeRng(`${seed}:bigleafgeo`),
    lean: 0.16,
    tilt: 0.34,
    spread: 0.2,
    rise: 0.12,
    segments: 3,
    flexBase: 0.18,
    bulge: 0.45,
    // 0.42 x 2.0 / 2.906, the ground-layer ratio: this one really is a floppy
    // leaf on a stalk and it should move like one.
    scale: 0.29,
  });
  const bigLeafMat = cardMaterial(
    giantLeafTexture({ key: 'bigleaf', seed: `${seed}:bigleaf` }),
    0xffffff
  );

  /**
   * TWO OF THESE NINE LAYERS PUSH A COLLIDER AND SEVEN DO NOT.
   *
   * Grass, meadow, bramble, saplings, sticks, flowers, litter and reeds do not,
   * and should not: you walk through undergrowth, and a bramble that physically
   * stopped you would be a wall you cannot see the far side of. The thicket's
   * value is that you can read it from thirty metres and choose to go round,
   * which is geography rather than collision.
   *
   * Stumps and the biggest bushes do, because they are solid objects and
   * walking through one reads as the world being fake in a way that a blade of
   * grass never does. The radii are in scatter.js next to the placement rules,
   * including the 0.82 m floor that keeps fauna.js from perching a chaffinch on
   * a stump — that file identifies trunks in `colliderGrid` by radius, so a
   * knee-high stump under 0.8 m would be indexed as a tree.
   */

  // ---- how it all reaches the screen --------------------------------------
  /**
   * One InstancedMesh per layer for the whole endless world, with sectors
   * allocated inside its buffers.
   *
   * There is exactly one mesh per archetype rather than one per sector, and
   * that is the load-bearing decision in the whole streaming design: twelve
   * tree archetypes times two meshes times a useful sector count is over a
   * thousand scene objects, and three pays a per-object cost every frame for
   * every object whether it draws or not. A sector owns a contiguous span
   * inside a shared slab instead — see `packSlab` in culling.js.
   *
   * Every geometry and material handed to `addStreamed` below is one of the
   * objects built at the top of this function, used once. There is no second
   * copy of anything: a second `speciesMaterials` call would compile a second
   * set of programs and bake a second set of bark and leaf textures for no
   * visible difference and most of a second of load time.
   */
  const streamedLayers = [];
  const streamedMeshes = [];
  /** The reduced-detail trunk meshes, for diagnostics. See `farMeshes`. */
  const farSet = new Set();
  /**
   * Slab growth events, per layer.
   *
   * Worth counting rather than trusting. Growing a slab replaces the mesh's
   * instance attribute, which costs a full `bufferData` of the new capacity on
   * the next render — 8 MB for the sward — and that is a hitch the player feels
   * rather than a number in a log. The initial capacities are sized so this
   * stays at zero in normal play; if it does not, they are wrong.
   */
  const growths = {};
  const addStreamed = (id, name, geometry, material, options) => {
    const mesh = new THREE.InstancedMesh(geometry, material, 1);
    mesh.name = name;
    orderOpaque(mesh);
    mesh.castShadow = options.castShadow ?? false;
    mesh.receiveShadow = options.receiveShadow ?? false;
    const packer = packSlab(mesh, { ...options, onGrow: () => (growths[id] = (growths[id] ?? 0) + 1) });
    culler.add(packer);
    group.add(mesh);
    streamedMeshes.push(mesh);
    if (options.mirrorOf) farSet.add(mesh);
    streamedLayers.push({
      id,
      packer,
      // The mesh, kept because the impostor band has to swap a material onto it
      // once its atlas exists — everything else here only ever needs the packer.
      mesh,
      bound: options.bound,
      bucketSize: options.bucketSize,
      mirrorOf: options.mirrorOf ?? null,
      castsShadow: mesh.castShadow,
    });
    return packer;
  };

  /**
   * Initial capacities, and why they are allowed to be rough.
   *
   * The slab doubles when a sector will not fit, so these only decide how many
   * growth events a session pays for, not whether it works — but a growth is a
   * full `bufferData` of the new capacity on the next render, which is a stall
   * the player feels rather than a number in a log. A 146 ms frame during the
   * first walk out was one.
   *
   * SIZED FOR ONE SPECIES TAKING EVERYTHING, not for the average split. The
   * split at the spawn point measures 38% pine, 33% birch, 19% oak, 10% rowan
   * and a fraction of a per cent of willow, which over a 384 m ring of 25 000
   * trunks and three archetypes each puts the busiest archetype near 3200 — and
   * 4096 duly held every birch and oak layer at 61% while every pine layer grew,
   * because the species rule is `alt > 0.5 → pine` and the region field now
   * produces plateaus that are ENTIRELY high ground. A wet region does the same
   * for willow. So the capacity has to cover the whole ring divided by three
   * archetypes, not by fifteen.
   *
   * THE FIFTH SPECIES DOES NOT CHANGE THAT ARGUMENT, only its arithmetic. The
   * rowan takes its trees off the oak rather than adding any, so the worst case
   * a layer can face is unchanged — it is still "one species takes the whole
   * ring" — and the price is 45 MB over thirty-six tree layers becoming 56 MB
   * over forty-five, of which the nine new ones are 11.2 MB. Memory allocated
   * once and never touched, against a stall that happens exactly when the player
   * is walking somewhere new. `forest.growths` stays empty apart from the
   * sward's one growth, which predates this and is a different number's problem;
   * if a TREE layer ever appears in it, this one is wrong.
   */
  const TREE_CAPACITY = 8192;
  /**
   * Trees are bucketed at 44 m.
   *
   * Not a free choice in either direction. Coarser buckets mean fewer spheres
   * to test per repack — a 384 m ring at 44 m is about 365 cells per archetype,
   * so 8760 across the twenty-four meshes — but `alwaysNear` measures from the
   * bucket's SURFACE, so a coarser bucket also drags the always-visible disc
   * outward: at 44 m the bucket radius is ~39 m and everything within 121 m of
   * the eye is kept regardless of facing, and at 88 m it would be 137 m, which
   * is 40% more trees drawn behind the player's head.
   */
  const TREE_BUCKET = 44;
  /**
   * Where a streamed trunk stops being worth its branches.
   *
   * The forest going endless took the frame from 8.8 M triangles to 35 M and
   * essentially all of it was trunk: 89% of the world's triangles are boughs,
   * and a 384 m ring is mostly boughs on trees a couple of hundred metres away.
   * Past this distance the same tree is drawn from `grown.far` — bole and first
   * boughs at three or four sides, no second or third level, full canopy — at
   * about a tenth of the triangles.
   *
   * 200 m because of the fog, not because of the pixels. A fifteen-metre tree
   * at 200 m is 83 px tall and its boughs are one or two px wide, which would
   * already justify it; but the sober fog transmits only 3% at 200 m and even
   * the thinnest fog the director ever reaches transmits 25%, so whatever
   * difference there is between the two versions arrives at a quarter contrast
   * at best. The switch is per bucket, so a 44 m group of trees changes
   * together — which is less conspicuous than trees popping one at a time,
   * because a whole stand changing by an invisible amount is still invisible.
   *
   * The far mesh does NOT cast a shadow, and that is a consequence rather than
   * a choice: the shadow camera is a 58 m half-extent box around the player,
   * and nothing in this mesh is closer than 200 m.
   */
  const TREE_LOD = 170;

  /**
   * How far a tree is DRAWN, as opposed to how far one is generated.
   *
   * Residency is "the nearest point of a 128 m sector is within the 384 m
   * ring", so a sector's far corner sits up to 181 m past it and the wood is
   * generated out to about 565 m. Drawing all of it would be forty per cent
   * more trees than the ring ever asked for, every one of them behind more fog
   * than the ground's own edge is.
   *
   * 384 is not a new judgement — it is the number `ground.js` already argues
   * for at length, and the arithmetic is the same. `FogExp2` transmits
   * `exp(-(d·ρ)²)`; at the thinnest the director's ego-death fog ever gets,
   * 384 m passes 0.64% of the light, which is under the 1/255 the framebuffer
   * can represent, and the ultra view-distance preset only takes that to about
   * 1.6/255. Sober it is 3.7e-6. So this removes trees that could not have
   * produced a pixel, which is exactly the standard the frustum cull is held
   * to.
   *
   * `restoreAll` honours it too, deliberately — see packSlab. The distance
   * bands are a level-of-detail and reach decision, not a culling one, and
   * cull-check would otherwise be comparing a correct frame against a frame
   * with every distant trunk drawn twice at two resolutions.
   */
  const TREE_REACH = 384;

  /**
   * WHERE THE WOOD STOPS BEING GEOMETRY AND STARTS BEING A SILHOUETTE.
   *
   * The fourth band. Past `reach` — which is whatever the tree-distance knob is
   * set to — a tree is one camera-facing quad reading from a 64-view
   * hemi-octahedral atlas of itself. Four vertices and two triangles against the
   * 2400-6400 the near trunk and canopy cost, and it is the answer to the
   * problem `reach-visible.mjs` found and the comment on the canopy mesh below
   * (which is still right about what it says, and is answered rather than
   * contradicted — see the note appended to it).
   *
   * IT IS 384 AND NOT A NEW PRESET ROW, ON PURPOSE. The quality ladder has five
   * rungs and every knob on it needs five entries; this needs none, because the
   * only sensible value is the one the whole ring is already generated to.
   * `TREE_REACH`'s own block argues at length that 384 m is where a tree stops
   * being able to produce a pixel — that argument is about FOG against a
   * surface, and it is exactly as true for a quad as for a trunk. So the outer
   * edge of this band is the outer edge of the world and the INNER edge is the
   * knob: at `ultra` and `high` the knob is 384 and the band is
   * (384, 384] — empty, no instances, no draw calls, no program, the ladder's
   * top two rungs completely untouched. At `medium` it is (250, 384], at `low`
   * (180, 384], at `potato` (120, 384].
   *
   * Callers who want it off pass `impostorReach` to `setReach`, or call
   * `setImpostors(false)`. Both exist for the A/B scripts and neither is wired
   * to a setting.
   *
   *
   * 384 ON EVERY RUNG, INCLUDING `potato`, AND THAT WAS THE QUESTION.
   *
   * The obvious economy is to shorten this band at the bottom of the ladder:
   * potato exists for weak machines and its band is (90, 384], nearly three
   * hundred metres of quads almost all of which are behind trees from where a
   * player stands. `impostor-knee.mjs` sweeps it. There is no knee — the cost
   * and the benefit fall together, almost proportionally:
   *
   *     impostorReach   quads   wood ms   above-flat mean Δ   picture
   *     none                0     0.00          6.03          bare heightfield
   *     384              5426    +0.39          1.64          treeline to horizon
   *     300              3551    +0.35          2.19          treeline to horizon
   *     240              2105    +0.22          3.21          bare summit returning
   *     140               629    +0.03          4.25          bare heightfield
   *
   * Cutting to 300 recovers a tenth of the cost for an eighth of the picture,
   * which is not a trade worth making; cutting to 240 recovers 44% of it and
   * puts the bare summit back in the frame. AND WHERE IT BREAKS IS A PROPERTY OF
   * THE TERRAIN, not of the number: 240 fails at this station because the ridge
   * that station looks at happens to be about 300 m away. The world is seeded
   * per session, so no preset value below the ring's own edge is safe on a
   * landscape nobody has photographed. 384 is the one value that cannot be
   * wrong, and it is the value `TREE_REACH` already argues for on its own terms.
   *
   * THE OTHER EDGE IS WORSE, and was measured too. Handing the near end of the
   * band back to the far trunk sweep — `geometryReach` of 120, 150, 180 instead
   * of `leafReach`'s 90 — costs MORE (+0.57, +0.68, +0.55 against +0.45) because
   * the trunk geometry it puts back is dearer than the quads it removes, and it
   * costs the picture as well (mean 2.44, 2.85, 3.28 against 1.64) because bare
   * boles above the canopy are exactly what the band exists to stop. Both edges
   * are closed; the band is the size it should be.
   *
   *
   * WHAT IT IS WORTH, AND WHAT IT COSTS. Both measured, both from one page
   * session with the preset pinned so the band is the only thing moving.
   *
   * `reach-visible.mjs`, from 70 m above the canopy, against a full-reach frame
   * — differing pixels and mean delta out of 255:
   *
   *     rung      before             after
   *     medium    14.69%  mean 2.69   4.64%  mean 0.43
   *     low       25.39%       4.28  13.02%       1.09
   *     potato    31.27%       6.01  18.42%       1.65
   *
   * and at every eye-level station, before and after, 0.00-0.04%. It is very
   * nearly the whole of the difference this lever was making to the picture.
   *
   * `impostor-knee.mjs`, 14 interleaved rounds at the potato bands and the
   * potato internal resolution, five stations, with `canopy` — a view straight
   * up into the crown where the band has no instances — carried as the noise
   * control and subtracted:
   *
   *     wood     +0.39 ms        ridge     0.00 ms
   *     clearing  0.00 ms        glade     0.00 ms
   *
   * ONE STATION. The band is free at the long sightlines and at the spawn, and
   * costs a third of a millisecond in the dense interior view, on a 2.4-3.4 ms
   * frame. It also buys back 0.6-3.5% of the frame's triangles, the far sweep it
   * replaces being 216-594 triangles a tree against the quad's two.
   *
   * AN EARLIER VERSION OF THIS BLOCK SAID +0.563 AND +0.505 AND WAS WRONG,
   * which is worth leaving in rather than quietly correcting. Those readings
   * were taken while another agent was driving Chromium on the same GPU; the
   * `canopy` control moved by 0.19-0.42 ms in the same runs, which is the tell
   * and is exactly why that station is in the table. A row is only readable if
   * the control beside it is small. See the header of `impostor-knee.mjs` for
   * the sweep that established the honest numbers.
   */
  const IMPOSTOR_REACH = TREE_REACH;

  /**
   * ONE GEOMETRY FOR ALL FIFTEEN LAYERS, and one dummy material until the
   * atlases exist.
   *
   * The geometry is genuinely shared: a unit plane has nothing archetype-shaped
   * about it, and the tree's size and centre reach the vertex shader as uniforms
   * on the material instead. Fifteen `InstancedMesh`es over one four-vertex
   * buffer is one upload for the wood's entire far band.
   *
   * The material cannot be shared and cannot exist yet, because it holds the
   * atlas. `impostorBakes` below is the work list; `pumpImpostors` in `cull()`
   * works through it and swaps the real material in. Until then the band is held
   * empty by `impostorsReady`, so a mesh with the dummy on it never draws.
   */
  const impostorGeo = impostorGeometry();
  const impostorDummy = new THREE.MeshBasicMaterial({ visible: false });
  impostorDummy.name = 'impostor-unbaked';
  const impostorBakes = [];
  let impostorsReady = false;
  let impostorsOn = true;
  let impostorBytes = 0;
  let impostorBakeMs = 0;
  /**
   * Summed quad area as a fraction of the square one, for the report.
   *
   * A tree is tall and narrow and the sprite has to be square; the QUAD does
   * not. See the three-radii block in `bakeImpostor` — this is the number that
   * says how much of the fill a square quad was wasting, which was 0.56 ms.
   */
  let impostorFill = 0;
  /** Frames `pumpImpostors` has been offered. See the deadline in its body. */
  let impostorCalls = 0;
  const IMPOSTOR_DEADLINE = 300;
  /** The band `setReach` last asked for, applied the moment the bakes finish. */
  let impostorBand = { min: IMPOSTOR_REACH, max: IMPOSTOR_REACH };

  /**
   * THE COARSE TRUNK MODE — MEASURED, REJECTED, AND KEPT SO THAT IT CAN BE
   * REJECTED WITH NUMBERS THE NEXT TIME SOMEBODY HAS THE IDEA. There is no
   * quality preset for this and there should not be. Same standing as
   * `setImpostors` below: a mechanism the A/B scripts drive and no knob does.
   *
   * THE IDEA IS EXTREMELY TEMPTING AND THE ARITHMETIC IS ALL ON ITS SIDE. A near
   * trunk is 4350 triangles on average and 7766 at the worst; at `potato` there
   * are 570 of them in front of the camera at the deep station, 2.49 M of the
   * frame's 3.44 M. Seventy-two per cent of everything the cheapest preset in
   * the game submits is second- and third-order boughs inside crowns you cannot
   * see into. `grown.far` already exists, is built from the same control points,
   * pairs with the same material and the same bucket spheres, and is 206
   * triangles — 3.6% of the near mesh. Pointing the near layer at it takes deep
   * from 3.44 M to 1.05 M with every tree still standing where it was and every
   * leaf card still on it, because the canopy is a different mesh.
   *
   * IT LOOKS WRONG, AND IT LOOKS WRONG IN THE ONE PLACE THE TRIANGLE COUNT
   * CANNOT SEE. `branch-visible.mjs` diffs it against potato-as-shipped inside
   * one page session, one camera, one minute of one day:
   *
   *     arm              triangle cut   worst eye-level mean of 255
   *     lod 30                   30%        0.02
   *     lod 20                   35%        0.22
   *     lod 12                   40%        0.41
   *     coarse (lod 0)           67%       14.06
   *
   * 14 of 255 is the same order as the fog change this project measured its way
   * back out of, and `.perf/shots/branch-stream-{full,coarse}.png` is what it
   * is: the kapok that fills the right third of the frame at the stream station
   * is GONE. Not simplified — the far sweep is three or four sides with no
   * buttress, built for a tree 80 px tall at 170 m, and at four metres it is a
   * pole where a wall used to be. What the far mesh throws away is invisible at
   * the range it was designed for and is the whole subject at arm's length.
   *
   * SO THE HANDOVER DISTANCE IS THE LEVER AND NOT THE GEOMETRY, and it has a
   * floor: the band is tested per BUCKET against the bucket's nearest point,
   * `TREE_BUCKET` is 44 m, so the sphere is about 41 m of radius and no `lod`
   * under about 12 m removes another tree. That is where `REACH_TABLE`'s potato
   * row now sits, and 40% is what this lever is worth. Getting past it needs a
   * THIRD trunk mesh — second-order branches kept, third dropped, fewer sides —
   * which is real work in trees.js and is the honest next move, not this.
   */
  let coarseTrunks = false;
  /** near trunk mesh -> the two geometries it may point at. */
  const trunkDetail = [];
  /** The last `setReach` call, replayed when the trunk detail changes. */
  let lastReach = null;
  /** The understorey layers marked `clutter` — see the table below. */
  const clutterLayers = [];
  let clutterOn = true;

  for (const arch of archetypes) {
    const a = archetypes.filter((x) => x.name === arch.name).indexOf(arch);
    /**
     * The union of the near trunk and the far sweep, NOT the near trunk alone.
     *
     * These two meshes share one worker payload — see `mirrorOf` below — and
     * that payload carries the bucket spheres the frustum test uses, so the
     * sphere has to enclose whichever of the pair is drawing. See `unionBound`
     * for what the near-only version looked like when it failed.
     */
    const trunkBound = unionBound(
      instanceBound(arch.grown.trunk),
      instanceBound(arch.grown.far)
    );
    const leafBound = instanceBound(arch.grown.leaf);
    // `alwaysNear: 82` is shadow arithmetic, not taste: 58 m of shadow
    // half-extent, plus up to ANCHOR_HOLD (6 m) of anchor trail, plus ~15 m of
    // canopy lean. Within that, a tree must exist even when it is behind you or
    // its shadow vanishes from the ground in front of you as you turn.
    addStreamed(`trunk:${arch.name}:${a}`, 'trunk', arch.grown.trunk, arch.mats.trunkMat, {
      capacity: TREE_CAPACITY,
      bucketSize: TREE_BUCKET,
      alwaysNear: 82,
      maxDistance: TREE_LOD,
      thinnable: false,
      castShadow: true,
      bound: trunkBound,
    });
    /**
     * The two geometries this layer may point at. See `coarseTrunks`.
     *
     * Read off `streamedLayers` rather than threaded back out of `addStreamed`,
     * which returns the packer because that is what every one of its forty-odd
     * callers wants. The entry just pushed is this one.
     */
    trunkDetail.push({
      mesh: streamedLayers[streamedLayers.length - 1].mesh,
      full: arch.grown.trunk,
      coarse: arch.grown.far,
    });
    /**
     * The far half of the same trunk, fed by the same sector data.
     *
     * `mirrorOf` makes the field insert one worker payload into two slabs, so
     * the two meshes hold identical matrices and identical bucket spheres and
     * differ only in which distance band they draw. The bands are exactly
     * complementary — `maxDistance` above is `<=`, `minDistance` here is `>` —
     * so every tree is drawn once and never twice.
     *
     * The bucket spheres are the NEAR trunk's, which is conservative for this
     * mesh rather than merely convenient: the far sweep uses a subset of the
     * same control points at a smaller inscribed radius, so its extent is
     * strictly inside the sphere the worker measured.
     */
    addStreamed(`trunk-far:${arch.name}:${a}`, 'trunk', arch.grown.far, arch.mats.trunkMat, {
      capacity: TREE_CAPACITY,
      bucketSize: TREE_BUCKET,
      minDistance: TREE_LOD,
      maxDistance: TREE_REACH,
      thinnable: false,
      castShadow: false,
      bound: trunkBound,
      mirrorOf: `trunk:${arch.name}:${a}`,
    });
    /**
     * One canopy mesh at every distance, and NO reduced version of it.
     *
     * The obvious symmetry would be a far leaf mesh too, and it is the wrong
     * call twice over. The canopy is only 240–516 triangles against the
     * trunk's 2160–5940, so there is an order of magnitude less to win; and it
     * is the SILHOUETTE — a distant tree is its canopy and nothing else, so
     * thinning the cards is the one reduction that would actually be visible at
     * the range where it would happen.
     *
     * `leafMats[a]`, NOT one material for the species. This mesh has existed per
     * archetype since the slab allocator was written, so giving each one its own
     * canopy texture is the same number of draw calls it was already making —
     * which is the entire reason the variants in trees.js could be a material
     * each instead of an atlas with a per-instance sub-rect. Two archetypes that
     * share a variant get the same material OBJECT here, not a copy.
     *
     *
     * THE PARAGRAPH ABOVE IS STILL RIGHT AND IS NOW ANSWERED RATHER THAN
     * OVERTURNED. It rejects a REDUCED canopy: fewer cards, thinner crown, the
     * silhouette eaten at exactly the range where the silhouette is the whole
     * tree. That reasoning has not changed and there is still no far leaf mesh.
     *
     * What follows this block is a different move — not less canopy, but no
     * geometry at all: past the knob's reach a tree is one quad reading a baked
     * 64-view atlas of ITSELF, so the silhouette is not thinned, it is
     * photographed. `reach-visible.mjs` is the reason it had to exist: at eye
     * level shortening the reach moves 0.02-0.05% of the pixels, and from 70 m
     * above the canopy it moves 14.69% at `medium` and 31.27% at `potato`,
     * because up there nothing is in the way and every tree the reach removed
     * was a tree you could have seen. See IMPOSTOR_REACH.
     */
    addStreamed(`leaf:${arch.name}:${a}`, 'leaf', arch.grown.leaf, arch.mats.leafMats[a], {
      capacity: TREE_CAPACITY,
      bucketSize: TREE_BUCKET,
      alwaysNear: 82,
      maxDistance: TREE_REACH,
      thinnable: false,
      castShadow: true,
      bound: leafBound,
    });
    /**
     * AND THE SAME TREE AGAIN, AS ONE QUAD, PAST WHERE THE GEOMETRY STOPS.
     *
     * A THIRD MIRROR OF THE TRUNK PAYLOAD, not a fourth layer in the worker.
     * `mirrorOf` makes `forest-field` insert one sector's trunk matrices into
     * however many slabs name it, so this costs the worker nothing, costs the
     * network nothing, and — this is the part that matters — inherits the trunk
     * layer's bucket spheres, which is what makes the band arithmetic in
     * `setReach` a straight extension of the pairing that was already there.
     *
     * THE TRUNK AND NOT THE LEAF, and the choice is about the instance tint.
     * `treeSector` writes two different colours for one tree: the canopy gets a
     * palette tint jittered ±16° of hue, the trunk gets a near-white lightness
     * jitter. Mirroring the canopy would multiply the impostor — bole included —
     * by a saturated green; mirroring the trunk multiplies it by a grey near 1
     * and lets the atlas carry its own colour, which is what an impostor of a
     * whole tree wants. The price is that all three archetypes of a species show
     * their own baked canopy colour rather than a per-instance one, and at
     * 150 m the fog has already taken 85% of that difference.
     *
     * `castShadow: false` IS A HARD CONSTRAINT, not a saving. The shadow pass is
     * already 84% alpha-tested leaf cards; a shadow map cannot be cast by a
     * camera-facing quad in any case, because the quad faces the eye and the
     * shadow camera is not the eye — it would render as a flat rectangle of
     * whatever sprite the light happens to be looking from. Nothing in this band
     * is closer than `reach`, and the shadow camera is a 58 m box.
     *
     * `alwaysNear` is absent for the same reason it is absent on `trunk-far`:
     * that radius exists to keep a tree behind your head alive for its shadow,
     * and nothing here has one.
     */
    addStreamed(`impostor:${arch.name}:${a}`, 'impostor', impostorGeo, impostorDummy, {
      capacity: TREE_CAPACITY,
      bucketSize: TREE_BUCKET,
      minDistance: IMPOSTOR_REACH,
      maxDistance: IMPOSTOR_REACH,
      thinnable: false,
      castShadow: false,
      bound: unionBound(trunkBound, leafBound),
      mirrorOf: `trunk:${arch.name}:${a}`,
    });
    /**
     * What `pumpImpostors` will need, in the order it will need it.
     *
     * The bake materials are built HERE rather than in impostor.js because
     * everything they are made of is local to this file — and they are FRESH
     * materials rather than `arch.mats`, which is a saving and a correctness fix
     * at once. The world's materials are `makeLiving`-wrapped: they carry the
     * wind, the breath, the lean-toward-you and the whole trip uniform block,
     * all of which are noise on a bake of a tree standing still. Worse, they are
     * compiled against a scene that HAS fog, and three keys its program cache on
     * that, so handing them to a fog-less bake scene would compile a second full
     * set of tree programs — which is the shader hitch this repo has already
     * shipped once and reads as the game freezing.
     *
     * A plain Lambert with the same map, the same alpha test and the same
     * emissive compiles two programs for the whole bake and is what the far band
     * actually wants: the tree, lit, with nothing moving.
     */
    const palette = arch.mats.tints[a];
    impostorBakes.push({
      id: `impostor:${arch.name}:${a}`,
      parts: [
        {
          geometry: arch.grown.trunk,
          material: new THREE.MeshLambertMaterial({ map: arch.mats.trunkMat.map }),
        },
        {
          geometry: arch.grown.leaf,
          material: new THREE.MeshLambertMaterial({
            map: arch.mats.leafMats[a].map,
            // Matched to `makeLeafMaterial` in trees.js, all three of them: the
            // cut, the two-sidedness and the stand-in for subsurface scatter. A
            // canopy baked at FrontSide is half a canopy, because a leaf card is
            // a card.
            alphaTest: 0.42,
            side: THREE.DoubleSide,
            emissive: new THREE.Color(0x17260f),
            emissiveIntensity: 0.72,
            /**
             * The middle of the archetype's own palette, baked in.
             *
             * The canopy's colour is a per-instance multiply in the wood and
             * cannot be one here — see the trunk-mirror note above — so the
             * palette has to be collapsed to one colour, and the middle entry is
             * the one that is least wrong for a rowan in blossom AND a birch on
             * the turn. It is the same array `treeSector` samples.
             */
            color: new THREE.Color(palette[Math.floor(palette.length / 2)]),
          }),
        },
      ],
    });
  }

  // Grass and ferns are the two layers the settings menu's undergrowth slider
  // is allowed to thin, and they are named rather than flagged so that
  // `packSlab`'s own default would reach the same answer on its own.
  addStreamed('grass', 'grass', grassGeo, grassMat, {
    capacity: 65536,
    bucketSize: 18,
    thinnable: true,
    bound: instanceBound(grassGeo),
  });
  addStreamed('ferns', 'ferns', fernGeo, fernMat, {
    capacity: 8192,
    bucketSize: 30,
    thinnable: true,
    bound: instanceBound(fernGeo),
  });
  rockGeos.forEach((geo, gi) => {
    addStreamed(`rocks:${gi}`, 'rocks', geo, rockMat, {
      capacity: 1024,
      bucketSize: 32,
      thinnable: false,
      castShadow: true,
      receiveShadow: true,
      bound: instanceBound(geo, true),
    });
  });
  addStreamed('logs', 'logs', logGeo, logMat, {
    capacity: 512,
    bucketSize: 32,
    thinnable: false,
    castShadow: true,
    receiveShadow: true,
    bound: instanceBound(logGeo, true),
  });
  addStreamed('shroom-stem', 'shroom-stem', stem, stemMat, {
    capacity: 512,
    bucketSize: 24,
    thinnable: false,
    color: false,
    bound: instanceBound(stem, true),
  });
  addStreamed('shroom-cap', 'shroom-cap', cap, capMat, {
    capacity: 512,
    bucketSize: 24,
    thinnable: false,
    bound: instanceBound(cap, true),
  });

  /**
   * THE UNDERSTOREY, STREAMED — the same nine geometries, the same nine
   * materials, the same biome field, everywhere.
   *
   * Everything above this loop was already endless; the nine layers built at
   * the top of this section were not, and the consequence was that the entire
   * world outside a 140 m disc was the forest as it stood before any of that
   * work. Uniform grass, uniform ferns, trunks. Given that the brief was "a
   * forest doesn't look the same everywhere" and the world has no edge, that
   * was the whole change confined to the one place a player spends the least
   * of their time.
   *
   * Geometry and material are the objects built at the top of this function,
   * used once each. A second `cardClump` call would build a second geometry off
   * a second rng, and then a bush would be a different shape depending on which
   * code path happened to place it.
   *
   * The ids are the layer names, so `underSector` in scatter.js emits under
   * exactly these keys and `main.js`'s per-layer probe switches — which filter
   * the forest group by `name` — find them without being told they exist.
   *
   *
   * CAPACITIES ARE SIZED FOR A REGION THAT COMMITS, NOT FOR THE AVERAGE, AND
   * THE AVERAGE IS WHAT MISLEADS.
   *
   * This is the same trap the tree slabs fell into and recorded: `character()`
   * is deliberately built so a place is ONE thing rather than a blend, so a
   * resident ring can legitimately be entirely meadow or entirely thicket.
   * Typical readings out at 700 m are 242 meadow and 98 bramble; those numbers
   * are worthless for sizing, because the whole design is that somewhere else
   * is nothing like here.
   *
   * So each of these is the layer's per-square-metre CEILING — one over the
   * spacing squared, times the largest acceptance its rule can return — over
   * the largest resident area the 80 m ring ever holds, which is about 40
   * sectors of 1024 m². Meadow: 1/1.8² × 1.0 × 40 960 = 12 642 at a weight of
   * 1. Bramble: 1/2.2² × 1.05 × 40 960 = 8 885. Litter and sticks land near
   * 4 500 apiece under a closed canopy.
   *
   * Then checked by standing in the most extreme example of each biome the
   * world actually contains, found by scanning `character()` out to 1.5 km and
   * walking to the winner. Measured resident peaks: meadow 17 058, bramble
   * 7779, flowers 4519, litter 3730, sticks 3190, bushes 1597, reeds 1235,
   * saplings 435, stumps 31. Meadow ALONE justifies the whole exercise — 17 058
   * against a first guess of 16 384, so the naive sizing would have grown a
   * 1.2 MB buffer the first time anybody walked into a hay meadow.
   *
   * Rounded up to a power of two from the larger of the two. The whole table is
   * 16.6 MB against the 45 MB the tree slabs already spend on exactly the same
   * argument, and it buys the same thing: a growth event is a full `bufferData`
   * of the new capacity on the next render, which is a stall the player feels
   * at the moment he walks into a new kind of place. `forest.growths` stays
   * empty at all five extremes; if it ever does not, these numbers are wrong.
   *
   *
   * AND THEY WERE ALL HALVED BY THE "FEWER AND BIGGER" PASS, which is 8.7 MB
   * of the 16.6 handed back.
   *
   * The spacings above roughly doubled, so every ceiling in the paragraph above
   * is recomputed rather than scaled: the numbers quoted are the new ones. The
   * measured peaks above are the OLD readings and are kept because they are
   * what the ratio has to be applied to — each layer's new peak is its old one
   * times the ratio of the new per-m² acceptance to the old, which was measured
   * by Monte-Carlo over the same field: meadow ×0.64, bramble ×0.53, bushes and
   * saplings and sticks and flowers and litter and reeds ×0.50. That predicts
   * peaks of meadow 10 970, bramble 4 093, flowers 2 308, litter 1 923, sticks
   * 1 563, bushes 799, reeds 594, saplings 249, stumps 31, and every capacity
   * below is the power of two above the LARGER of that and the ceiling.
   *
   * Verified rather than trusted, the same way the originals were: `growths`
   * comes back empty after walking to the deepest meadow, thicket, flower bed,
   * litter floor and reed bank the world contains inside 1.4 km. The largest
   * streamed readings taken on that walk were bramble 2392 in the thicket and
   * meadow 2507 in the flower meadow, both far under the predicted peaks —
   * which is expected and not a reason to cut the table further, because the
   * peaks above were found by a search that walked to the single most extreme
   * square metre of each biome and this walk restricts itself to ground you can
   * actually stand on (slope < 0.25). The capacities exist for the case nobody
   * found.
   *
   * NO `maxDistance` ON ANY OF THESE, because there is nothing for one to
   * reject: the undergrowth ring is 80 m and the sector overshoot takes the
   * furthest instance to about 112 m from the eye, which is inside any cap
   * worth writing. A cap earned its keep while these layers also existed as
   * fixed discs around the origin — a player two kilometres out was submitting
   * eighteen thousand instances of hay he had left behind — and that is exactly
   * the failure mode a camera-following ring cannot have.
   */
  const understoreyLayers = [
    /**
     * `clutter: true` MARKS A LAYER THE `potato` RUNG DOES NOT DRAW AT ALL, and
     * the flag is on this table rather than in a list somewhere else because
     * this is where anybody adding a layer will be looking.
     *
     * The test for it is NOT "is this cheap" — every one of these is cheap, and
     * that is the trap. It is: **would the wood be a different place without
     * it?** A stick lying on the floor, a fallen leaf, a wildflower, a bramble
     * runner and a reed are TEXTURE: they read as detail on the ground you are
     * walking over and nothing in the world means anything different when they
     * are gone. A bush, a sapling, a palm, a bromeliad or a giant leaf is
     * SHAPE — you walk round it, it blocks a sight line, it is the difference
     * between a rainforest and a temperate wood — and a stump is a thing you
     * come across. None of those are marked.
     *
     * WHAT IT IS WORTH IS DRAW CALLS AND NOT TRIANGLES, which is why this was
     * nearly not done at all. Measured at the wood station on `potato`: the five
     * layers below are 0.05 M triangles of a 2.24 M frame, and on a desktop GPU
     * removing them is inside the noise floor. On a main thread throttled 8x —
     * see `npm run perf:weak` — removing fourteen draw calls is the difference
     * between a 33.3 ms frame and a 16.7 ms one, because the frame sits exactly
     * on the 60 Hz boundary there and every draw is scene-graph traversal, a
     * render-list insert, a program select and a driver call that a weak core
     * pays for in full. A triangle count is what a weak GPU charges; a draw
     * count is what a weak CPU charges, and this game runs out of the second
     * one first.
     */
    { id: 'meadow', geo: meadowGeo, mat: meadowMat, capacity: 16384, bucketSize: 18 },
    { id: 'bramble', geo: brambleGeo, mat: brambleMat, capacity: 16384, bucketSize: 20, clutter: true },
    { id: 'bushes', geo: bushGeo, mat: shrubMat, capacity: 2048, bucketSize: 26, castShadow: true },
    { id: 'saplings', geo: saplingGeo, mat: shrubMat, capacity: 1024, bucketSize: 26, castShadow: true },
    { id: 'sticks', geo: stickGeo, mat: twigMat, capacity: 8192, bucketSize: 24, spin: true, clutter: true },
    { id: 'flowers', geo: flowerGeo, mat: flowerMat, capacity: 8192, bucketSize: 18, clutter: true },
    { id: 'litter', geo: litterGeo, mat: litterMat, capacity: 8192, bucketSize: 22, spin: true, clutter: true },
    { id: 'reeds', geo: reedGeo, mat: reedMat, capacity: 2048, bucketSize: 18, clutter: true },
    {
      id: 'stumps',
      geo: stumpGeo,
      mat: logMat,
      capacity: 512,
      bucketSize: 32,
      spin: true,
      castShadow: true,
      receiveShadow: true,
    },
    /**
     * THE THREE MID-STOREY LAYERS, AND THEY ARE LAST IN THIS TABLE FOR A REASON
     * THAT HAS NOTHING TO DO WITH DRAWING ORDER.
     *
     * A sector's whole contents come off ONE seeded rng stream, so inserting a
     * layer anywhere but the end reseeds every plant and every tree placed after
     * it — `authored-check.mjs` exists to notice exactly that. These three are
     * appended here and their `underLayer` calls are appended at the end of the
     * sequence in `underSector`, so not one existing instance in the world
     * moves. See the note on test order in scatter.js.
     *
     * CAPACITIES, by the rule the block above states: the layer's per-square-
     * metre ceiling — one over the spacing squared, times the largest acceptance
     * its rule can return — over the ~40 960 m² the 80 m ring holds, rounded up
     * to a power of two.
     *
     *   palms       1/6.2² x 0.64 x 40 960 =   682   ->  2048
     *   bromeliads  1/2.1² x 0.85 x 40 960 = 7 897   ->  8192
     *   bigleaf     1/9²   x 0.82 x 40 960 =   414   ->   512
     *
     * The two that are over-provisioned are over-provisioned on purpose. A
     * growth event is a full `bufferData` of the new capacity on the next
     * render, i.e. a stall the player feels at the moment he walks somewhere
     * new, and the bromeliads are the one layer here whose density is decided by
     * the TERRAIN rather than by a biome weight — a session whose seed puts a
     * long steep escarpment inside the ring is not an unusual session, it is a
     * hilly one. 623 KB against a hitch is the same trade the tree slabs make.
     */
    { id: 'palms', geo: palmGeo, mat: palmMat, capacity: 2048, bucketSize: 30 },
    { id: 'bromeliads', geo: bromeliadGeo, mat: bromeliadMat, capacity: 8192, bucketSize: 20 },
    { id: 'bigleaf', geo: bigLeafGeo, mat: bigLeafMat, capacity: 512, bucketSize: 28 },
  ];
  for (const u of understoreyLayers) {
    addStreamed(u.id, u.id, u.geo, u.mat, {
      capacity: u.capacity,
      bucketSize: u.bucketSize,
      /**
       * NOT thinnable.
       *
       * The settings menu's undergrowth slider drops instances from `grass` and
       * `ferns` only. These nine are the layers that make a place a particular
       * KIND of place, and thinning them does not make the world sparser, it
       * makes it more uniform — which is the opposite of what they are for.
       * Grass and ferns are the two layers where fewer is simply fewer.
       */
      thinnable: false,
      castShadow: u.castShadow ?? false,
      receiveShadow: u.receiveShadow ?? false,
      // `spin` collapses the sphere centre onto the instance origin: a stick,
      // a litter mat and a stump tumble on all three axes, and a sphere hung
      // off-centre would let a rotated instance escape its own bound.
      bound: instanceBound(u.geo, u.spin ?? false),
    });
    if (u.clutter) clutterLayers.push(streamedLayers[streamedLayers.length - 1]);
  }

  /**
   * The mushroom glow, as one point cloud for the whole world.
   *
   * It was a `THREE.Sprite` per cap while the near patches were authored, and
   * each sprite is its own scene object AND its own draw call — seventy-five of
   * them for fifteen patches. A sprite per cap across a streaming ring is
   * unbounded, so this is a single `THREE.Points` refilled by the field.
   *
   * The material is hand-written for one reason: FOG. `PointsMaterial` with fog
   * enabled mixes toward the fog colour, which under additive blending makes
   * distant glows BRIGHTER rather than dimmer, so a patch four hundred metres
   * away would be the most conspicuous thing in the frame. Multiplying the
   * additive contribution by the same `exp(-(d·ρ)²)` the scene fog uses makes
   * them fade the way the sprites do, and it is four lines.
   */
  const glowPointMat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: glowTex },
      uColour: { value: new THREE.Color(0xb98cff) },
      uOpacity: { value: 0.5 },
      uSize: { value: 1.5 },
      uFogDensity: { value: 0.0092 },
    },
    vertexShader: `
      uniform float uSize;
      uniform float uFogDensity;
      varying float vFog;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = -mv.z;
        // The renderer's own point-size convention: half the drawing buffer
        // height over depth, so uSize is a diameter in metres like the
        // sprites' scale is.
        gl_PointSize = uSize * (400.0 / max(d, 0.001));
        float f = d * uFogDensity;
        vFog = exp(-f * f);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform vec3 uColour;
      uniform float uOpacity;
      varying float vFog;
      void main() {
        vec4 tex = texture2D(uMap, gl_PointCoord);
        gl_FragColor = vec4(uColour * tex.rgb * tex.a * uOpacity * vFog, 1.0);
      }
    `,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const glowPoints = new THREE.Points(new THREE.BufferGeometry(), glowPointMat);
  glowPoints.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(1536), 3));
  glowPoints.geometry.setDrawRange(0, 0);
  glowPoints.name = 'shroom-glow';
  glowPoints.visible = false;
  glowPoints.frustumCulled = false;
  group.add(glowPoints);

  /**
   * Drain the `colliders` inbox into the grid the body actually uses.
   *
   * Read as a tail on every frame rather than copied once, because
   * `gathering.js` pushes its entries AFTER this function returns — main.js
   * builds the forest first so everything else can ask where the ground is —
   * and a one-shot copy at construction would leave the fires intangible. It is
   * O(nothing) once the array has stopped growing, and it cannot miss a late
   * arrival.
   */
  const ingestLoose = () => {
    while (colliderGrid.ingested < colliders.length) {
      colliderGrid.add(colliders[colliderGrid.ingested++]);
    }
  };
  ingestLoose();

  /**
   * Mushroom patches you can eat from. Empty at construction, and that is
   * correct rather than a stub: every patch in the world comes from a sector,
   * so this fills over the handful of frames the entry gate is already waiting
   * on and then tracks the ring for the rest of the session.
   */
  const patchList = [];

  const field = new ForestField({
    seed,
    layers: streamedLayers,
    /**
     * Palettes as data, because the worker cannot import `trees.js`.
     *
     * That module pulls in `textures.js`, which draws bark and leaves on a
     * canvas, and a worker has no canvas. Read off the archetypes that were
     * already built rather than by calling `speciesMaterials` again — that call
     * bakes five bark tiles and fifteen 512² canopy canvases, and doing it a
     * second time to fetch a table of hex constants would cost most of a second
     * at load.
     *
     * ONE PALETTE PER ARCHETYPE, not one per species: `tints[name]` is an array
     * indexed by archetype now. That is what lets the rowan in blossom be tinted
     * nearly neutral (so its white petals stay white under the multiply) while
     * the plain rowan beside it is tinted green. `treeSector` indexes it with
     * the archetype it has already drawn.
     */
    tints: Object.fromEntries(archetypes.map((a) => [a.name, a.mats.tints])),
    archetypes: ARCHETYPES,
    rockSizes: rockGeos.length,
    colliders: colliderGrid,
    bushZones,
    patches: patchList,
    glow: glowPoints,
  });

  /**
   * BAKE THE IMPOSTOR ATLASES, ONE ARCHETYPE A FRAME, WHILE THE MENU IS UP.
   *
   * WHEN, and why it is here rather than at construction. `buildForest` has no
   * renderer — main.js builds the forest at line 182 and the Pipeline at 288 —
   * and the atlas is a render target, so the earliest possible moment is the
   * first frame. That is the moment this repo has learned to be afraid of: a
   * one-time stall at load reads as the game freezing, and there is a whole
   * pre-warm block in main.js that exists because of it.
   *
   * So this rides the frame loop instead. `cull()` is called from main.js on
   * every animation frame INCLUDING while the entry gate is up — the gate
   * throttles the DRAW to 10 Hz and returns before it, but the cull happens
   * first, unconditionally. Fifteen archetypes at one a frame is fifteen frames
   * behind an opaque full-page panel that the player is still typing a name
   * into. Nothing that stalls is ever on screen.
   *
   * ONE A FRAME AND NOT ALL FIFTEEN. The whole set is a few hundred
   * milliseconds; done in a single call it would be one long frame, and the gate
   * is not a still image — it has a settings panel and a text field in it, and a
   * 300 ms input delay while somebody is typing is exactly as bad as a hitch in
   * the world. Fifteen ordinary frames is not.
   *
   * IF THE PIPELINE NEVER APPEARS, NOTHING BREAKS. `bakeRendererReady` returns
   * null until the Pipeline constructor has published one, this returns
   * immediately, `impostorsReady` stays false and the band stays shut. A
   * headless probe that builds a forest without a renderer gets the wood exactly
   * as it was before this existed.
   */
  function pumpImpostors() {
    if (!impostorBakes.length) return;
    const renderer = bakeRendererReady();
    if (!renderer) return;
    /**
     * IT YIELDS TO THE STREAMER, AND THAT IS NOT POLITENESS.
     *
     * A bake is about 37 ms of one frame. The forest ring takes ONE sector per
     * frame and the workers reply between frames, so fifteen of them landing
     * during the first fill do not merely slow the fill down — they push the
     * whole arrival about half a second later in wall-clock. That is enough to
     * break `check:potato`, which samples 400 ms after each `setMode` and then
     * asserts that ultra restores to the triangle it started on: with the bake
     * competing, its FIRST sample was of a world still arriving and the final
     * ultra read 110 632 triangles higher, reported as a band mismatch when
     * nothing about the bands had moved. The same race is what a player would
     * see as the wood filling in more slowly behind the menu.
     *
     * So: bake only on frames where the field has nothing queued, in flight or
     * waiting to be merged. At load that is after the first ring is complete —
     * still several seconds before the gate can drop, because main.js waits for
     * the terrain to settle AND for every shader to compile before it fades.
     * If the player walks and the ring goes busy again, the bake simply pauses.
     *
     * THE DEADLINE IS THE HALF OF THIS THAT MATTERS. A ring that never goes
     * quiet — a slow machine, a player sprinting from the first frame — would
     * otherwise leave the band unbaked for ever, so after `IMPOSTOR_DEADLINE`
     * frames it bakes anyway and takes the hitch. Five seconds of frames, which
     * is longer than the gate has ever taken to come down and short enough that
     * a session cannot get far without a treeline.
     */
    impostorCalls++;
    /**
     * BOTH RINGS, and the second one is the one that was actually being starved.
     *
     * The tree field was the obvious suspect and it was innocent: at the moment
     * the gate drops, `field.pending` is already 0. What was still arriving was
     * the GROUND — 110 632 triangles and one draw call of it, which is one
     * chunk — and that is what made `check:potato`'s first ultra sample read
     * short of the ultra it restored to two seconds later. Waiting eight seconds
     * instead makes that test exact, which is how the ground was identified.
     */
    const busy = field.pending > 0 || (groundField.pending ?? 0) > 0;
    if (busy && impostorCalls < IMPOSTOR_DEADLINE) return;
    const job = impostorBakes.shift();
    const layer = streamedLayers.find((l) => l.id === job.id);
    const baked = bakeImpostor(renderer, job.parts, { seed: job.id });
    impostorBytes += baked.bytes;
    impostorBakeMs += baked.ms;
    /**
     * The bake materials are disposed and the GEOMETRIES ARE NOT.
     *
     * `job.parts` holds two throwaway Lambert materials built for this bake
     * alone — but its geometries are `arch.grown.trunk` and `arch.grown.leaf`,
     * the live buffers the whole wood is instanced from. Disposing a part
     * wholesale here would take the forest's own geometry with it.
     */
    for (const p of job.parts) p.material.dispose();
    layer.mesh.material = impostorMaterial(baked.texture, baked);
    impostorFill += baked.fill;
    if (impostorBakes.length) return;

    /**
     * The last one has landed, so the band can open — but only by re-applying
     * the band `setReach` last asked for, not by inventing one.
     *
     * `setReach` runs several times before this point (the quality registry
     * fires it at boot, and again for the shadow toggle), and each time it
     * recorded what the impostor band SHOULD be and then wrote a shut one. This
     * is the deferred half of those calls.
     */
    impostorsReady = true;
    const shut = { min: impostorBand.min, max: impostorBand.min };
    for (const l of streamedLayers) {
      if (!l.id.startsWith('impostor:')) continue;
      l.packer.setBand(impostorsOn ? impostorBand : shut);
    }
    culler.invalidate();
  }

  /**
   * Named rather than returned inline, so that a method may call a sibling
   * without going through `this` — `setTrunkDetail` replays `setReach`, and a
   * `this` that depends on how the caller reached the method is exactly the
   * kind of coupling a settings registry (which stores bare functions) breaks.
   */
  const forest = {
    group,
    field,
    colliderGrid,
    bushZones,
    /** Every streamed InstancedMesh, so the probe and the tests can find them. */
    streamedMeshes,
    /** How many times each streamed layer has had to reallocate. Should be {}. */
    growths,
    /** Live instance counts and capacities per streamed layer, for tuning. */
    slabs() {
      const out = {};
      for (const l of streamedLayers) out[l.id] = [l.packer.instanceCount, l.packer.capacity];
      return out;
    },
    /**
     * The reduced-detail trunks specifically.
     *
     * Exposed because "how much of the frame is far trees" is the question the
     * level-of-detail split exists to answer, and it cannot be read off the
     * scene graph — a far trunk is an InstancedMesh called `trunk` like every
     * other one, deliberately, so that main.js's bisection probe hides the near
     * and far halves of a tree together.
     */
    farMeshes: streamedMeshes.filter((m) => farSet.has(m)),
    /**
     * The bisection probe in main.js does `forest.ground.visible = false`, and
     * this is now a Group rather than a Mesh. That still works — `visible` on a
     * Group hides everything under it — which is why the ground field is
     * exposed here under its old name and the field object separately.
     */
    ground: groundField.group,
    groundField,
    /**
     * The live collision list, exposed rather than imported by test scripts.
     *
     * Vite serves an HMR-versioned URL to a late `import()`, so a script that
     * imports this module gets a second copy whose `colliders` array is empty —
     * and a collision test reading that measures nothing and passes regardless.
     * Same reasoning as `window.RR.tripUniforms` in main.js.
     */
    colliders,
    /**
     * Mushroom patches you can eat from.
     *
     * Mutated in place by the field rather than rebuilt, because main.js holds
     * no reference of its own — `findInteractable` reads `forest.patches` every
     * frame — and because `play-check.mjs` reads it off `window.RR`. Patches are
     * added when their sector lands and spliced out when it is evicted, so the
     * list is a dozen or two entries however far anybody walks.
     */
    patches: patchList,
    /**
     * Live instance counts, and they are LIVE rather than fixed now.
     *
     * These were `treeSpots.length` and `grassSpots.length` — the size of two
     * eager scatters, decided once at load and true for ever. There is no such
     * number any more: what exists is whatever the ring is standing in, so
     * `shoot.mjs` and anything else that logs them gets a reading rather than a
     * constant. Same figures as `slabs()`, summed over the layers that share a
     * name.
     */
    get treeCount() {
      let n = 0;
      for (const l of streamedLayers) {
        if (l.id.startsWith('trunk:')) n += l.packer.instanceCount;
      }
      return n;
    },
    get grassCount() {
      return this.slabs().grass?.[0] ?? 0;
    },
    /**
     * Instances per understorey layer, live.
     *
     * Exposed for the same reason `slabs()` is: these nine are the layers whose
     * counts are the whole cost story, and a number that has to be read off a
     * profiler is a number nobody reads. It is whatever the ring is standing
     * in, so it is a couple of hundred meadow in a pine stand and twenty
     * thousand in a hay meadow — which is the design working, not noise.
     */
    get understorey() {
      const out = {};
      const live = this.slabs();
      for (const u of understoreyLayers) out[u.id] = live[u.id]?.[0] ?? 0;
      return out;
    },
    culler,

    /**
     * "Has the world finished arriving?" — one signal, because three separate
     * instruments have now had to guess at it and all three guessed wrong.
     *
     * A test that waits a fixed time, or that waits for two readings to agree,
     * is asking "is it changing right now" and calling the answer "is it
     * finished". Those differ exactly when a straggler is slower than the
     * polling interval, which is the common case rather than the exotic one:
     * the ground ring accepts ONE 128 m chunk per frame, and one chunk is
     * 110 632 triangles and a single draw call. `check:potato` spent two rounds
     * reporting an ultra restore that missed by precisely that, and the same
     * shortfall made `high` read as having more triangles than `ultra`.
     *
     * Both rings, not just the trees. The tree field is the obvious suspect and
     * it is innocent — `field.pending` is already 0 by the time the gate drops.
     * It was always the ground.
     *
     * The impostor bakes are in here too: fifteen atlases arrive one archetype
     * per frame behind the menu, and a frame sampled before they land has the
     * band drawing nothing.
     */
    get settled() {
      return (
        field.pending === 0 &&
        (groundField.pending ?? 0) === 0 &&
        impostorBakes.length === 0
      );
    },

    /**
     * How far the wood is DRAWN, at runtime.
     *
     * WHY THIS EXISTS, MEASURED. `.perf/presets.json` records that the whole
     * quality ladder moves the triangle count by ONE PER CENT: low submits
     * 16.08 M triangles at the deep station and ultra submits 16.21 M, and the
     * ladder's entire 44% of travel is bought with pixels, MSAA and shadow
     * texels. Fitting frame time against resolution at low gives
     * `1.53 ms + 0.319 ms/Mpixel`, so 75% of that frame is
     * resolution-independent, and hiding the canopy alone is worth 1.10 ms
     * against the 0.37 ms that deleting 71% of every fragment buys. Reach is
     * the only lever in the building that removes geometry, and geometry is
     * what the frame is made of.
     *
     * THE THREE LAYERS MOVE TOGETHER OR THE WOOD BREAKS. A tree is two packers
     * over one worker payload — see the `mirrorOf` block above — and their
     * bands are exactly complementary, `trunk` testing `<= lod` and
     * `trunk-far` testing `> lod`. Set them apart and a bucket lands in both,
     * so every distant trunk is drawn twice at two resolutions z-fighting with
     * itself; set them overlapping the other way and a ring of the wood is
     * missing. Nothing outside this function knows that pairing, which is why
     * `packer.setBand` is deliberately not something callers reach for.
     *
     * AND IT IS NOT USEFUL WITHOUT THE FOG. `TREE_REACH` was chosen so that fog
     * had already deleted the trees before the reach did: sober `FogExp2`
     * transmits `exp(-(d·ρ)²)`, and at 384 m that is 3.7e-6, far below the
     * 1/255 the framebuffer can hold. Which is exactly why cutting reach at
     * today's density does not fade anything out — it opens a hard-edged
     * circular hole that follows the player. Hiding a reach of `d` needs
     * `ρ >= sqrt(ln 255)/d = 2.354/d`: 0.0061 at 384 m, which sober density
     * clears comfortably, but 0.0196 at 120 m, which is 2.1× sober. So a
     * caller shortening the reach MUST thicken the fog to match, and
     * `fogDistance` — the preset that was flattened to [1,1,1,1] precisely
     * because nothing culled on fog — becomes load-bearing the moment
     * something does.
     *
     * @param {number} lod    where the near trunk hands over to the far sweep
     * @param {number} reach  where the wood stops being drawn at all
     * @param {{leafReach?: number, alwaysNear?: number}} [opts]
     *   `leafReach` lets the canopy stop short of the trunks, which is the one
     *   asymmetry worth having: leaves are 45% of the frame for 3.50 M of its
     *   16.08 M triangles — about ten times the cost per triangle of trunk —
     *   so the canopy is where a reach cut pays. Defaults to `reach`.
     *   `alwaysNear` is the radius inside which a bucket skips the frustum test
     *   entirely. Its 82 m default is shadow arithmetic (58 m of shadow
     *   half-extent, 6 m of anchor trail, ~15 m of canopy lean) and is dead
     *   weight on any tier with shadows off — it is what keeps trees behind
     *   your head in the draw.
     */
    setReach(
      lod,
      reach,
      {
        leafReach = reach,
        alwaysNear = null,
        impostorReach = IMPOSTOR_REACH,
        geometryReach = Math.min(reach, leafReach),
      } = {}
    ) {
      if (!(lod > 0) || !(reach > lod)) {
        console.warn(`[forest] setReach(${lod}, ${reach}): need 0 < lod < reach`);
        return;
      }
      /**
       * Remembered so `setTrunkDetail` can replay it.
       *
       * The alternative is for the trunk-detail switch to write the bands
       * itself, which would be a second place that knows the four-band chain —
       * and the chain is the invariant this whole file is most careful about.
       * One writer, replayed, cannot disagree with itself.
       */
      lastReach = { lod, reach, leafReach, alwaysNear, impostorReach, geometryReach };
      /**
       * THE FOURTH BAND JOINS THE CHAIN, AND IT JOINS IT AT `leafReach` RATHER
       * THAN AT `reach`. That is the one thing in here that is not a
       * straightforward extension, so it gets the argument.
       *
       * The pairing was `trunk.max === trunkFar.min` and it is now
       * `trunk.max === trunkFar.min` AND `trunkFar.max === impostor.min` — the
       * same rule applied once more. Every bucket is in exactly one of the three
       * trunk-carrying bands. Overlap them and a distant tree is drawn twice, as
       * a trunk AND as a picture of itself standing in the same place, which
       * reads as a ghost rather than as z-fighting and is easier to miss.
       *
       * WHY THE HANDOVER MOVED IN TO `leafReach`. The whole reason `leafReach`
       * is shorter than `reach` is that a leaf triangle costs about ten times a
       * trunk triangle, so the canopy is cut first and the bare boles are left
       * standing out to `reach` because they are cheap. An impostor is FOUR
       * VERTICES. Past `leafReach` it is cheaper than the far sweep it replaces
       * — 2 triangles against 216-594 — and it is a whole tree with its crown on
       * rather than a bare pole. There is no reading on which the far sweep wins
       * that stretch, and `impostor-ab.mjs` measures it at both handovers,
       * against a full-reach reference, from 70 m above the canopy:
       *
       *     rung      cut today          at `reach`         at `leafReach`
       *     medium    14.69%  mean 2.69   7.59%  mean 0.66   4.50%  mean 0.41
       *     low       25.41%       4.28  16.49%       1.81  12.64%       1.01
       *     potato    31.28%       6.01  19.73%       2.35  18.00%       1.49
       *
       * and at eye level all three are 0.00-0.02%, which is what a change to the
       * far band is supposed to look like from inside a wood.
       *
       * SO `reach` STILL SELECTS THE ROW AND NO LONGER DRAWS THE EDGE. That is a
       * real narrowing of what the knob means and it is deliberate: the outer
       * edge of the wood is now always 384 m, and what the knob moves is how
       * much of it is geometry. `geometryReach` is exposed so `impostor-ab.mjs`
       * can put the old handover back without a rebuild; nothing else passes it.
       *
       * `Math.max(lod, ...)` because a caller may pass a `leafReach` inside the
       * near/far handover. That collapses the far sweep to an empty band and
       * hands straight from the full bole to the quad, which is coherent — what
       * must never happen is a NEGATIVE-width band, because `inBand` tests
       * `> min && <= max` and an inverted pair silently drops a ring of the
       * world.
       */
      const geoReach = Math.max(lod, geometryReach);
      const impostorMax = Math.max(geoReach, impostorsOn ? impostorReach : geoReach);
      impostorBand = { min: geoReach, max: impostorMax };
      /**
       * WHERE THE NEAR TRUNK HANDS OVER, which is `lod` normally and the whole
       * geometry band when the trunks are coarse.
       *
       * With `coarseTrunks` on, both meshes hold `grown.far` and the same
       * material, so the handover is a distinction without a difference — and
       * paying twelve draw calls and twelve slab packs a frame for it is exactly
       * the kind of cost the potato rung exists to stop. Collapsing the far band
       * to (handover, handover] leaves it empty and preserves every equality the
       * chain depends on. See the `coarseTrunks` block.
       */
      const handover = coarseTrunks ? geoReach : lod;
      for (const layer of streamedLayers) {
        const kind = layer.id.split(':')[0];
        if (kind === 'trunk') {
          layer.packer.setBand({
            max: handover,
            ...(alwaysNear === null ? {} : { near: alwaysNear }),
          });
        } else if (kind === 'trunk-far') {
          // min === the near layer's max, max === the impostor layer's min.
          // These two equalities are the invariant `check:potato` asserts.
          layer.packer.setBand({ min: handover, max: geoReach });
        } else if (kind === 'leaf') {
          layer.packer.setBand({
            max: leafReach,
            ...(alwaysNear === null ? {} : { near: alwaysNear }),
          });
        } else if (kind === 'impostor') {
          // Held shut until the atlas exists — a quad with no picture on it is a
          // white rectangle the size of a tree. `pumpImpostors` opens it.
          layer.packer.setBand(
            impostorsReady ? impostorBand : { min: impostorMax, max: impostorMax }
          );
        }
      }
      culler.invalidate();
    },

    /**
     * Draw every standing trunk from the reduced sweep instead of the full one.
     * FOR `branch-visible.mjs`, NOT FOR A KNOB — see the `coarseTrunks` block at
     * the top of this function for the frames that rejected it.
     *
     * What follows is only the mechanism, and the mechanism is small on purpose:
     * an A/B script has to be able to flip this between two reads of the same
     * camera without the frames differing in anything else, so it must not
     * allocate, must not upload and must not recompile.
     *
     * IT COMPILES NOTHING. Both geometries were built by `growTree` from the
     * same control points with the same attribute set, and both meshes were
     * constructed with the SAME MATERIAL OBJECT — see the two `addStreamed`
     * calls, which both pass `arch.mats.trunkMat`. Three keys a program on the
     * material and the geometry's attribute names, and neither moves here, so
     * the swap costs one property write per archetype and the next frame draws.
     * That matters: a level change already rebuilds ~22 programs, and this
     * project has shipped that hitch once. Adding a sixteenth-program rebuild to
     * the rung that exists for weak machines would be the wrong place to do it.
     *
     * IT DOES NOT MOVE THE BUCKET SPHERES either, and does not need to:
     * `trunkBound` is already the UNION of the two meshes' bounds because the
     * pair shares one worker payload, so the sphere enclosing the full tree
     * encloses the reduced one. See the block on `trunkBound`.
     */
    setTrunkDetail(coarse) {
      const next = !!coarse;
      if (next === coarseTrunks) return;
      coarseTrunks = next;
      for (const t of trunkDetail) t.mesh.geometry = next ? t.coarse : t.full;
      /**
       * The bands have to be rewritten, because the near layer's `max` depends
       * on this — replayed through `setReach` rather than written here, so there
       * stays exactly one function in this file that knows the four-band chain.
       * Before the first `setReach` there is nothing to replay and the geometry
       * swap alone is correct: `applyReach` in main.js runs on the next knob.
       */
      if (lastReach) {
        const { lod, reach, ...opts } = lastReach;
        forest.setReach(lod, reach, opts);
      } else {
        culler.invalidate();
      }
    },

    /** Whether the trunks are currently drawn from the reduced sweep. */
    get coarseTrunks() {
      return coarseTrunks;
    },

    /**
     * Draw the floor texture, or do not. Which five layers those are, and the
     * test that decided them, is on the `understoreyLayers` table above.
     *
     * AN EMPTY BAND RATHER THAN `mesh.visible = false`, and that distinction is
     * the entire point of doing it here instead of in the probe. The culler
     * OWNS `visible` — it writes `mesh.visible = write > 0` at the end of every
     * repack — so a `false` poked in from outside survives until the next time
     * the player moves 2.5 m and is then silently undone. Worse, it would save
     * only the draw: the repack would still walk the layer's buckets, still
     * frustum-test them, still copy their matrices into the instance buffer and
     * still flag the upload. Closing the band makes the packer write nothing,
     * which sets `visible` false as a CONSEQUENCE, and both costs go.
     *
     * `min === max === Infinity` for empty, not `max = 0`: `inBand` tests
     * `> min && <= max` and `horizontal` goes NEGATIVE for the bucket the eye is
     * standing inside, so a zero maximum would put the ground under your feet
     * back in the band. That is the trap `minDistance`'s own default records and
     * `setImpostors` avoids the same way.
     */
    setClutter(on) {
      const next = !!on;
      if (next === clutterOn) return;
      clutterOn = next;
      for (const layer of clutterLayers) {
        if (next) {
          // Restored to the band the layer was BUILT with, which for every one
          // of these is the unbounded default — see the `NO maxDistance` note on
          // the understorey table. Recorded rather than assumed all the same, so
          // that adding a bounded clutter layer later cannot silently unbound it.
          layer.packer.setBand(layer.clutterBand);
        } else {
          // `band()` reports the fields under their long names and `setBand`
          // takes the short ones; translated here rather than widening either,
          // because `band()` is what `check:potato` reads and its key names are
          // part of that contract.
          const b = layer.packer.band();
          layer.clutterBand ??= { min: b.minDistance, max: b.maxDistance, near: b.alwaysNear };
          layer.packer.setBand({ min: Infinity, max: Infinity });
        }
      }
      culler.invalidate();
    },

    /** Whether the floor texture layers are being drawn. */
    get clutter() {
      return clutterOn;
    },

    /**
     * Turn the impostor band off wholesale. For the A/B scripts, not for a knob.
     *
     * There is no quality preset for this and there should not be: the band is
     * empty at `high` and `ultra` because their reach is already the world's,
     * and at the three rungs below it is the difference between a treeline and a
     * bare heightfield. What it is for is `impostor-ab.mjs`, which needs to
     * render the same station with and without it inside one page session so
     * that the difference is the band and not the machine.
     */
    setImpostors(on) {
      impostorsOn = !!on;
      // An empty band is min === max, not max = 0: `inBand` tests
      // `> min && <= max`, so a zero max would put the whole ring in the band
      // for any bucket the eye is standing inside, where `horizontal` is
      // negative. Same trap `minDistance`'s own default block records.
      const shut = { min: impostorBand.min, max: impostorBand.min };
      for (const layer of streamedLayers) {
        if (!layer.id.startsWith('impostor:')) continue;
        layer.packer.setBand(impostorsReady && impostorsOn ? impostorBand : shut);
      }
      culler.invalidate();
    },

    /** What the atlases cost and what they cost to make. For the report. */
    impostorStats() {
      return {
        ready: impostorsReady,
        on: impostorsOn,
        pending: impostorBakes.length,
        atlases: archetypes.length - impostorBakes.length,
        textureSize: IMPOSTOR_TEXTURE_SIZE,
        spritesPerSide: IMPOSTOR_SPRITES_PER_SIDE,
        views: IMPOSTOR_SPRITES_PER_SIDE * IMPOSTOR_SPRITES_PER_SIDE,
        bytes: impostorBytes,
        // Mean over the archetypes baked so far; 1.0 would be a square quad.
        quadFill: impostorBakes.length === archetypes.length
          ? 0
          : impostorFill / (archetypes.length - impostorBakes.length),
        bytesEach: IMPOSTOR_ATLAS_BYTES,
        bakeMs: impostorBakeMs,
      };
    },

    /** What every tree layer currently believes its band is. For tests. */
    reachStats() {
      return streamedLayers
        .filter((l) => /^(trunk|trunk-far|leaf|impostor):/.test(l.id))
        .map((l) => ({ id: l.id, ...l.packer.band() }));
    },

    /**
     * Repack the instanced layers for this camera, and bring the ground ring up
     * to date. Call once per frame, after everything that moves the camera and
     * before the render.
     *
     * THE GROUND UPDATE LIVES HERE RATHER THAN IN main.js, and that is a
     * deliberate choice about where the frame's ordering constraints are
     * written down. Both of these things need exactly the same thing: the final
     * camera for this frame. main.js already calls `forest.cull(camera)` last,
     * after the controller, after the trip director has moved the camera, and
     * after the ground-clamp — so hanging the ring off it inherits an ordering
     * that has already been reasoned about, instead of adding a second call
     * whose position in the frame is a fresh opportunity to be one frame stale.
     */
    cull(camera, force = false) {
      pumpImpostors();
      groundField.update(camera);
      /**
       * The forest ring BEFORE the repack, and the ordering is load-bearing.
       *
       * A sector accepted here inserts buckets, which invalidates the packer's
       * memory of what it last wrote; repacking afterwards in the same frame is
       * what makes the new trees appear on the frame they arrive rather than on
       * the next one the camera happens to move enough to trigger. It also means
       * a script that calls `cull(camera, true)` twice gets a settled world,
       * which is what every screenshot station depends on.
       */
      // A sector that landed or left has invalidated the packers it touched,
      // and the culler's own 2.5 m / 3° movement test would otherwise decline
      // to act on that — leaving a player who is standing still watching
      // sectors arrive and never appear. Forwarded as a forced repack.
      const arrived = field.update(camera);
      ingestLoose();
      // The glow points do their own fog, and the trip rewrites the density
      // every frame. Reading it here rather than in the field keeps
      // forest-field.js from needing to know a scene exists.
      if (scene.fog) glowPointMat.uniforms.uFogDensity.value = scene.fog.density;
      return culler.update(camera, force || arrived);
    },
    dispose() {
      groundField.dispose();
      field.dispose();
      scene.remove(group);
    },
  };
  return forest;
}
