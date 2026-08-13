import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TAU, clamp01, fbm2, makeRng, rngRange } from '../core/util.js';
import { setPlantScale } from '../trip/living.js';

/**
 * The floor of the wood, and the argument that it should not be the same floor
 * everywhere.
 *
 * `forest.js` used to scatter exactly six things: trees, one grass tuft, one
 * fern, three sizes of stone, one fallen log and mushrooms. The sward in
 * particular was ONE clump at ONE size at a density that varied only with
 * distance from the origin, twenty-one thousand of them inside a 72 m disc. That
 * produces a wood you can walk across for four minutes without the ground under
 * you changing in any way you could name, and the complaint it earned — "a
 * forest doesn't look the same everywhere" — is not a complaint about quantity.
 * Doubling the grass would have made it worse.
 *
 *
 * SO THE ORGANISING IDEA IS A BIOME FIELD, NOT MORE SPRINKLES.
 *
 * `forestDensity` already demonstrates the pattern this file copies: a
 * low-frequency noise field driving rejection sampling, which is the whole
 * difference between "trees were scattered on a heightmap" and "this is a wood
 * with groves and glades in it". The trees have had that since the first build.
 * The ground cover never did.
 *
 * `character()` — in scatter.js, see the note where it used to live — is the
 * same trick applied to the understorey. Two slow fields, one about eighty
 * metres per feature and one about a hundred and ten, plus the canopy density
 * and the terrain's own wetness, resolved into five weights that every layer
 * here and every streamed sector reads. A place is a meadow OR a bramble
 * thicket OR bare needle litter OR damp mossy deadfall, because the weights are
 * built to exclude one another rather than to sum.
 *
 * THE EMPTY BIOME IS THE MOST VALUABLE ONE AND IT IS FREE. Under the pines,
 * where the canopy is closed and the ground is dry, `litter` is high and every
 * other weight is near zero — so nothing is planted there except cones, needles
 * and dead sticks. Standing in that and then walking a hundred metres into
 * waist-high meadow is a bigger change than any amount of added geometry,
 * because it is a change in kind, and half of it costs nothing to draw.
 *
 *
 * WHAT THIS FILE DOES AND DOES NOT OWN.
 *
 * Geometry and canvas textures only. The scattering, the instancing and the
 * bucket packing all stay in `forest.js` next to the layers that were already
 * there, because the placement rules are the thing you want to read in one
 * place — and because the rng draw order over there is load-bearing (see the
 * note on the undergrowth rng in forest.js).
 */

// ---------------------------------------------------------------------------
// Canvas plumbing, copied from textures.js on purpose.
//
// `canvas`, `finish`, `memo` and `featherEdges` are private to that module and
// another agent is editing it, so importing them is not available and adding an
// export to it is not mine to do. They are twenty lines and they are the rules,
// not an implementation: every texture below has to obey the same ones or it
// will reproduce the artefacts that file spent so long removing.
// ---------------------------------------------------------------------------

const cache = new Map();

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function finish(c, { aniso = 8 } = {}) {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function memo(key, build) {
  if (!cache.has(key)) cache.set(key, build());
  return cache.get(key);
}

/**
 * Erase the alpha near the canvas border. Verbatim from textures.js, and the
 * reasoning there applies to every card in this file without amendment: a plant
 * drawn past its own edge is clipped into a dead straight line, and because one
 * texture is on thousands of instances that straight line becomes a hard
 * rectangular patch repeated across the whole wood. `keepBottom` is for
 * anything rooted at the bottom edge of its card, which is everything here
 * except the litter mats.
 */
function featherEdges(g, w, h, margin, { keepBottom = false } = {}) {
  const previous = g.globalCompositeOperation;
  g.globalCompositeOperation = 'destination-out';
  const bands = [
    [0, 0, margin, 0],
    [w, 0, w - margin, 0],
    [0, 0, 0, margin],
  ];
  if (!keepBottom) bands.push([0, h, 0, h - margin]);
  for (const [x0, y0, x1, y1] of bands) {
    const grad = g.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  }
  g.globalCompositeOperation = previous;
}

// ---------------------------------------------------------------------------
// The biome field — MOVED TO scatter.js, and the move is the whole of the
// endless-understorey change in one line.
//
// `character()` used to live here, immediately below this comment, and it was
// the right home for exactly as long as the understorey was authored-only:
// forest.js is the only thing that scatters, forest.js imports this file for
// the geometry anyway, and the field belongs next to the layers it decides.
//
// It cannot stay here now, because the streamed field has to ask the same
// question and the thing that asks it is a WORKER. `forest-worker.js` imports
// `scatter.js` and nothing else from this directory, deliberately — the header
// there and the header in scatter.js both spell out why: this file draws on a
// `<canvas>` and merges BufferGeometry, neither of which exists in a worker
// realm, and importing it from scatter.js would also close an import cycle
// (scatter -> undergrowth -> scatter) for the sake of ninety lines of noise
// arithmetic that touch no geometry at all.
//
// So the field moved to `scatter.js`, whose entire stated purpose is "the
// placement rules, separated from the meshes they end up in, because they are
// now needed in two places that cannot see each other". That is this situation
// exactly. There is still precisely ONE definition of what kind of place a
// point is; a streamed slab and the authored disc cannot disagree about it,
// because they are calling the same function in the same module.
//
// `import { character } from './scatter.js'` is the import you want.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Crossed cards in a rosette — the workhorse for everything leafy in here.
 *
 * A generalisation of `clumpGeometry` in forest.js rather than a copy of it:
 * that one makes vertical blades rooted on the axis, which is right for grass
 * and ferns and cannot make a bush. The two extra degrees of freedom are
 * `tilt`, which pitches each card outward from vertical, and `spread`, which
 * moves its root off the axis — together those turn the same rosette of
 * quads into a low dome, and a dome is what a shrub is.
 *
 * `aFlex` is `t²` up the card as everywhere else in the project, but `flexBase`
 * lifts the whole curve for things that are attached by a stem rather than
 * rooted in the ground: a bush's lowest leaves still move, a blade of grass's
 * root does not.
 *
 * Normals are pushed upward for the same reason forest.js pushes them: an
 * alpha-tested card lit from the side has a normal in the horizontal plane and
 * goes black, and undergrowth that goes black reads as a hole in the floor. The
 * dome variants get a second push OUTWARD from the axis, which is what stops a
 * bush shading like a stack of flat panels.
 */
export function cardClump({
  width,
  height,
  cards,
  rng,
  lean = 0.18,
  tilt = 0,
  spread = 0,
  rise = 0,
  segments = 3,
  flexBase = 0,
  bulge = 0,
  lift = 1.4,
  scale,
}) {
  const parts = [];
  for (let i = 0; i < cards; i++) {
    const w = width * rngRange(rng, 0.82, 1.18);
    const h = height * rngRange(rng, 0.72, 1.1);
    const geo = new THREE.PlaneGeometry(w, h, 1, segments);
    geo.translate(0, h / 2, 0);
    const pos = geo.attributes.position;
    const flex = new Float32Array(pos.count);
    const phase = new Float32Array(pos.count);
    const ph = rng();
    for (let v = 0; v < pos.count; v++) {
      const t = clamp01(pos.getY(v) / h);
      // Pre-bend, so a card is a curve and not a flag. Same term as the grass.
      pos.setZ(v, pos.getZ(v) + t * t * h * lean);
      flex[v] = flexBase + (1 - flexBase) * t * t;
      phase[v] = ph;
    }
    geo.setAttribute('aFlex', new THREE.BufferAttribute(flex, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.computeVertexNormals();

    const yaw = (i / cards) * Math.PI * 2 + rngRange(rng, -0.35, 0.35);
    if (tilt) geo.rotateX(tilt * rngRange(rng, 0.55, 1.25));
    geo.rotateY(yaw);
    if (spread || rise) {
      geo.translate(
        Math.cos(yaw + Math.PI / 2) * spread * rngRange(rng, 0.3, 1),
        rise * rngRange(rng, 0.2, 1),
        Math.sin(yaw + Math.PI / 2) * spread * rngRange(rng, 0.3, 1)
      );
    }

    const nrm = geo.attributes.normal;
    const n = new THREE.Vector3();
    for (let v = 0; v < nrm.count; v++) {
      n.set(nrm.getX(v), nrm.getY(v), nrm.getZ(v));
      // Same lift the sward uses, and for the same reason: a card lit from the
      // side has a horizontal normal and goes black, and undergrowth that goes
      // black reads as a hole in the floor rather than as a plant.
      n.y += lift;
      if (bulge) {
        n.x += Math.cos(yaw + Math.PI / 2) * bulge;
        n.z += Math.sin(yaw + Math.PI / 2) * bulge;
      }
      n.normalize();
      nrm.setXYZ(v, n.x, n.y, n.z);
    }
    parts.push(geo);
  }
  return setPlantScale(BufferGeometryUtils.mergeGeometries(parts, false), scale);
}

/**
 * A sapling: a real stem with a rosette of foliage on top of it.
 *
 * WHY NOT JUST SCALE DOWN `growTree`. It was the first thing tried and it is
 * cheap in the wrong currency. A grown trunk is 2160–5940 triangles and the
 * canopy is another few hundred; four hundred saplings would put well over a
 * million triangles into a layer whose whole job is to be a knee-high smudge in
 * the middle distance. This is fifty-eight triangles and, at the size a sapling
 * is ever seen from, indistinguishable — the read is entirely "thin stem, small
 * crown, waist height", which is silhouette and not detail.
 *
 * The stem is part of the same geometry rather than a second layer, so the
 * whole thing is one draw. It costs it the bark shader — the stem takes the
 * foliage's alpha-tested card material — which on a two-centimetre stem is
 * nothing anybody will see.
 */
export function saplingGeometry(rng, { height = 1.9, scale }) {
  const stemH = height * rngRange(rng, 0.42, 0.55);
  // 1.6–3.8 cm rather than 1.2–3.0. The sapling grew from 2.0 m to 2.8 m and a
  // stem that is 1% of its own height is a wire: it vanishes at ten metres and
  // leaves the crown floating.
  const stem = new THREE.CylinderGeometry(0.016, 0.038, stemH, 4, 2);
  stem.translate(0, stemH / 2, 0);
  {
    const pos = stem.attributes.position;
    const flex = new Float32Array(pos.count);
    const phase = new Float32Array(pos.count);
    const ph = rng();
    for (let v = 0; v < pos.count; v++) {
      const t = clamp01(pos.getY(v) / stemH);
      // A whippy young stem: leans a little even before the wind gets it.
      pos.setX(v, pos.getX(v) + t * t * height * 0.06);
      flex[v] = t * t * 0.5;
      phase[v] = ph;
    }
    stem.setAttribute('aFlex', new THREE.BufferAttribute(flex, 1));
    stem.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    stem.computeVertexNormals();
  }
  /**
   * FOUR CARDS AND A WIDER CROWN, because there are 42% fewer saplings now.
   *
   * Three cards on a 1.0 m crown was enough when a stand of saplings was 711
   * instances inside the disc; at 416 of them, each one has to be a young tree
   * you notice rather than a smudge in a crowd, and a three-card rosette seen
   * end-on is two cards. The fourth costs twelve triangles on a layer that
   * draws four hundred of them.
   */
  const crown = cardClump({
    width: height * 0.5,
    height: height * 0.56,
    cards: 4,
    rng,
    lean: 0.24,
    tilt: 0.4,
    spread: height * 0.06,
    segments: 2,
    flexBase: 0.35,
    bulge: 0.7,
    scale,
  });
  crown.deleteAttribute('aScale');
  crown.translate(0, stemH * 0.82, 0);
  return setPlantScale(BufferGeometryUtils.mergeGeometries([stem, crown], false), scale);
}

/**
 * ==== THE BAND NOBODY LIVED IN: 8-12 m ====================================
 *
 * A bare stem with a crown on top of it, and both halves of that sentence are
 * cost decisions before they are drawing ones.
 *
 * WHAT THE MEASUREMENT ACTUALLY SAID. `sightlines.mjs` classifies what stopped
 * each ray, and after the tree pass the wood's problem was no longer
 * composition — bare-trunk hits had fallen from ~27% of the 2-12 m band to
 * 2-6%, so rays were being stopped by things with leaves on them. What was left
 * was a HOLE with a specific altitude: the median sight line at 8 m had gone
 * from 23.6 m to 27.5 and at 12 m from 30.2 to 40.1, i.e. those two bands
 * OPENED as the trees got shorter and their crowns clumped downward, and the
 * escape rate at 12 m — rays that fly 120 m and hit nothing at all — went from
 * 4% to 17%. The wood had grown a floor and a roof and lost its middle.
 *
 * SO THE SHAPE IS DICTATED BY WHERE THE HOLE IS, NOT BY TASTE. Filling 8-12 m
 * with anything that also fills 1-4 m is the expensive way to do it: near-field
 * cards are the ones that cover the screen, and the 0.6-4 m bands were already
 * the best-filled part of the wood. A 7 m pole with 3.5 m fronds on the end of
 * it puts every alpha-tested fragment exactly in the empty band and nothing
 * anywhere else — and the pole itself is a six-sided open tube, which is the
 * cheapest geometry in this project by the measured factor of 21 between solid
 * triangles and alpha-tested ones. Sixty triangles of stem to carry forty-two
 * of foliage into the right band is the whole trade.
 *
 * ONE LAYER FOR BOTH THE PALMS AND THE TREE FERNS, which is the same argument
 * the ferns-became-heliconia block in scatter.js makes and for the same reason:
 * a new streamed layer is a new InstancedMesh, a draw call, a slab and a packer
 * repacked on every camera move. At the distance this band is READ from — 15 to
 * 60 m, through fog — an Astrocaryum and a Cyathea are the same silhouette,
 * which is a slim stem and a radial crown of pinnate fronds. The instance scale
 * carries the difference: 0.58 is a 5 m tree fern under the canopy and 1.42 is
 * a 12 m palm with its crown just under it, off one geometry and one draw.
 *
 * THE STEM TAKES THE FROND'S ALPHA-TESTED MATERIAL, and unlike the sapling —
 * whose two-centimetre stem could get away with sampling whatever the shrub
 * texture happened to have at its UVs — a six-metre pole cannot. Wherever the
 * texture's alpha falls under 0.4 the stem is DISCARDED, so a stem mapped
 * carelessly comes out with holes punched through it. `palmFrondTexture`
 * therefore draws a deliberately opaque petiole across the bottom of the card
 * and the stem's UVs are remapped into that strip — see `STEM_UV` below. It is
 * the same colour a palm's stem is, because on the plant it is the same tissue.
 */
const STEM_U0 = 0.46;
const STEM_U1 = 0.54;
/**
 * The top of this window is well clear of where the blade starts. The rachis
 * is stroked with a round cap at its root, which paints a couple of pixels
 * BELOW the base of the blade, and anything of the rachis's colour inside this
 * window becomes a bright band right round the stem at whatever height it maps
 * to.
 */
const STEM_V0 = 0.04;
const STEM_V1 = 0.13;

export function palmGeometry(rng, { height = 9, fronds = 7, scale }) {
  const stemH = height * rngRange(rng, 0.66, 0.74);
  const rBase = height * 0.019;
  const stem = new THREE.CylinderGeometry(rBase * 0.62, rBase, stemH, 6, 6, true);
  stem.translate(0, stemH / 2, 0);
  {
    const pos = stem.attributes.position;
    const uv = stem.attributes.uv;
    const flex = new Float32Array(pos.count);
    const phase = new Float32Array(pos.count);
    const ph = rng();
    // A stem that is dead straight reads as scaffolding. This is a lean of
    // about half a metre over nine, which is what a palm reaching for a gap in
    // the canopy does, and the instance yaw points it in every direction.
    const leanX = rngRange(rng, -0.06, 0.06);
    const leanZ = rngRange(rng, -0.05, 0.05);
    for (let v = 0; v < pos.count; v++) {
      const t = clamp01(pos.getY(v) / stemH);
      pos.setX(v, pos.getX(v) + t * t * height * leanX);
      pos.setZ(v, pos.getZ(v) + t * t * height * leanZ);
      /**
       * BARELY ANY FLEX ON THE STEM, AND THE CROWN PICKS UP EXACTLY WHERE IT
       * STOPS. A palm's trunk is a column that hardly moves and its crown
       * thrashes; getting that the wrong way round gives you a rubber pole. The
       * 0.28 at the top is the same number `flexBase` gets below, so the two
       * halves of the plant do not tear apart at the join.
       */
      flex[v] = t * t * 0.28;
      phase[v] = ph;
      uv.setXY(v, STEM_U0 + (STEM_U1 - STEM_U0) * uv.getX(v), STEM_V0 + (STEM_V1 - STEM_V0) * t);
    }
    stem.setAttribute('aFlex', new THREE.BufferAttribute(flex, 1));
    stem.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    stem.computeVertexNormals();
  }

  /**
   * `tilt: 1.0` is what makes this a crown rather than a shuttlecock.
   *
   * `cardClump` jitters the pitch by 0.55-1.25x, so the seven fronds come out
   * between 31 and 72 degrees off vertical: two or three standing up out of the
   * heart of the crown, the rest laid out and arching over. That spread is
   * worth more than any amount of detail in the texture, because it is what
   * gives the crown two and a half metres of VERTICAL extent — a flat rosette
   * blocks one height and this blocks a band.
   */
  const crown = cardClump({
    width: height * 0.18,
    height: height * 0.36,
    cards: fronds,
    rng,
    lean: 0.3,
    tilt: 1.0,
    spread: height * 0.016,
    segments: 3,
    flexBase: 0.3,
    bulge: 0.55,
    scale,
  });
  crown.deleteAttribute('aScale');
  crown.translate(0, stemH * 0.985, 0);
  return setPlantScale(BufferGeometryUtils.mergeGeometries([stem, crown], false), scale);
}

/**
 * A dead stick lying on the floor.
 *
 * The single cheapest "this is a real wood" cue there is, and the one the brief
 * asked for by name. Five sides and two segments is sixteen triangles; the bend
 * is what stops a field of them reading as dropped pencils, and the taper is
 * what makes one end the broken end.
 *
 * Laid along X so an instance's yaw is the only rotation that matters, and
 * given a small random pitch and roll at the call site so it sits on the ground
 * rather than in it.
 */
export function stickGeometry(rng, length, radius) {
  const geo = new THREE.CylinderGeometry(radius * 0.45, radius, length, 5, 2, true);
  geo.rotateZ(Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getX(i) / length;
    pos.setY(i, pos.getY(i) + Math.sin(t * 2.7 + 0.4) * radius * 1.9);
    pos.setZ(i, pos.getZ(i) + Math.sin(t * 4.1 + 1.3) * radius * 1.4);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * A cut or broken stump.
 *
 * Rare — a few dozen in the whole authored disc — and worth a layer anyway,
 * because a stump is the only object in a wood that says something happened
 * here. The top is a jagged ring rather than a disc: the vertices of the upper
 * cap are pushed up and down independently, so it reads as torn wood rather
 * than as a sawn cylinder, which is both truer and cheaper than modelling a cut.
 */
export function stumpGeometry(rng, height, radius) {
  const geo = new THREE.CylinderGeometry(radius * 0.82, radius * 1.25, height, 9, 3);
  geo.translate(0, height / 2, 0);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const t = clamp01(y / height);
    // Flare the base into the ground, so it looks rooted rather than dropped.
    const flare = 1 + Math.pow(1 - t, 3) * 0.55;
    pos.setX(i, x * flare + fbm2(x * 3.1, z * 3.1, 2) * radius * 0.18);
    pos.setZ(i, z * flare + fbm2(z * 3.1 + 9, x * 3.1 - 4, 2) * radius * 0.18);
    // Tear the top. Only the topmost ring, and only upward-ish, so the splinters
    // stand proud of the break instead of denting it.
    if (t > 0.98) pos.setY(i, y + rngRange(rng, -0.05, 0.26) * radius);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * A mat of fallen leaves, needles or moss.
 *
 * TWO PLANES AND A RUMPLE, AND THE RUMPLE IS NOT DECORATION. A perfectly flat
 * card has a bounding box of zero height, and `check-plants.mjs` divides a
 * plant's peak displacement by its own height — so a flat plant is an infinite
 * ratio and fails the build. Giving it real relief is therefore required, and
 * it happens also to be the right thing to draw: litter drifts and moss mounds,
 * and a mat with a couple of centimetres of lump in it catches the light on one
 * side the way the ground itself does.
 *
 * The outer ring is pulled DOWN as well as rumpled, which is what makes the mat
 * hug ground it does not know the shape of — a flat card on a slope shows a
 * bright sliver of daylight under its uphill edge from twenty metres away.
 */
export function litterPatch(rng, size, scale) {
  const parts = [];
  for (let k = 0; k < 2; k++) {
    const s = size * (k ? 0.66 : 1);
    const geo = new THREE.PlaneGeometry(s, s, 4, 4);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const flex = new Float32Array(pos.count);
    const phase = new Float32Array(pos.count);
    const ph = rng();
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v);
      const z = pos.getZ(v);
      const edge = clamp01(Math.max(Math.abs(x), Math.abs(z)) / (s / 2));
      const lump = fbm2(x * 4.4 + k * 17, z * 4.4 - k * 6, 2);
      pos.setY(v, pos.getY(v) + lump * size * 0.09 - edge * edge * size * 0.05);
      // Barely any flex: a mat of dead leaves stirs, it does not sway.
      flex[v] = 0.12 + edge * 0.3;
      phase[v] = ph;
    }
    geo.setAttribute('aFlex', new THREE.BufferAttribute(flex, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.computeVertexNormals();
    geo.rotateY(rng() * TAU);
    geo.translate(0, k * size * 0.035, 0);
    parts.push(geo);
  }
  return setPlantScale(BufferGeometryUtils.mergeGeometries(parts, false), scale);
}

/**
 * PINE CONES WERE HERE AND WERE CUT, which is worth a note because they are the
 * obvious thing to want in the needle-litter biome.
 *
 * A cone is five centimetres across. At the distance you see the forest floor
 * from — a metre and a half up, looking ahead — it is under two pixels, and two
 * pixels of brown on a brown floor is nothing; the litter mats and the sticks
 * already say everything a cone would have said, at a size that can be read.
 * What it would have cost is a whole extra layer: one more draw, one more
 * scene object walked every frame in two passes, and one more packer repacked
 * on every camera move, for a thing nobody can see. Emptiness carried by two
 * layers beats emptiness carried by three.
 */

// ---------------------------------------------------------------------------
// Textures
//
// EVERY ONE OF THESE IS DRAWN DENSE ON PURPOSE. The measured fact that governs
// this whole file is that alpha-test DISCARDS are what cost, not the surviving
// fragments: a fully opaque canopy measured 13% faster than the see-through one
// because opaque fragments write depth and occlude what is behind them while
// discards defeat early-Z. So a card that is 70% covered and instanced eight
// thousand times is cheaper than a wispy one instanced twenty thousand times to
// reach the same visual density, and every texture below is drawn to fill its
// card rather than to be delicate.
//
//
// AND THEY WERE ALL DRAWN DENSER AGAIN IN THE "FEWER AND BIGGER" PASS, which is
// the one change in this file that is a pure win in both currencies at once.
//
// Every card in the understorey roughly doubled in area and roughly halved in
// count — see the note at the head of the understorey section in forest.js for
// the counts and the reason. A texture is a fixed number of marks spread over a
// fixed canvas, so doubling the card's world size without touching the texture
// would have HALVED the marks per square metre: the same tuft, magnified, with
// the gaps between its blades magnified too. That is the wispy direction, and
// the wispy direction is the expensive one — every one of those enlarged gaps
// is a discarded fragment that no longer writes depth.
//
// So the mark counts below went up with the card sizes: meadow 13 blades to 19
// and half again as wide, shrub 150 leaves to 215, bramble 120 to 170 with two
// more canes, reeds 9 straps to 12, flowers 7 heads to 9. A bigger card at the
// same fill is more opaque per pixel of silhouette, not less, and that is
// exactly the trade the discard measurement says to make.
// ---------------------------------------------------------------------------

/**
 * The tall growth in a light gap: the single most valuable thing added.
 *
 * A taller, denser cousin of `herbTuft` in textures.js and it obeys the same
 * two hard rules. THE BLADES MUST NOT MEET AT THE BOTTOM — each is a spindle
 * with a point at the root, or the bottom strip of the card becomes a solid
 * dark bar sitting under every tuft in the forest. And the tips must land
 * inside the card, or every clump gets the same dead straight vertical cut.
 *
 * Drawn on a 128×256 canvas rather than a square one because the card it goes
 * on is 0.66 m by 1.95 m; a square texture stretched onto that makes every leaf
 * three times too wide.
 *
 *
 * ==== IT WAS A HAY MEADOW AND A RAINFOREST DOES NOT HAVE ONE ==============
 *
 * This layer peaks at seventeen thousand instances and is what a glade in this
 * wood IS, so it was half the answer to "some parts of the forest don't
 * resemble a rainforest" — the other half being the sward, see `herbTuft`. It
 * drew nineteen narrow spindles, bleached to straw at the tip, one in four
 * carrying a nodding grass seed head. That is a July hay meadow in England,
 * drawn to be one, and it was the most convincing thing in the frame.
 *
 * WHAT ACTUALLY FILLS A TROPICAL LIGHT GAP is Heliconia and its relatives: a
 * clump of enormous paddle leaves on stiff stalks, two to four metres, all
 * radiating from one crown at the ground. It is the plant every photograph of
 * the inside of a jungle has in the foreground, and it is the same four control
 * points as a grass blade with two of them moved.
 *
 *   NINE LEAVES, NOT NINETEEN, and each two and a half times as wide. Fill per
 *   card is roughly held — nine blades at 0.2 of the canvas against nineteen at
 *   0.072 — which matters, because fill is the cheap direction and thinning
 *   this card would have cost more than the change is worth. See the note at
 *   the head of this section.
 *
 *   THE BELLY MOVED FROM 0.42 TO 0.7. That single number is the difference
 *   between a blade and a paddle: it is where the leaf is widest, and grass is
 *   widest low and tapers for the rest of its length while a Heliconia holds
 *   its full width almost to the tip and then rounds off.
 *
 *   NO SEED HEADS AND NO STRAW. The tip gradient now runs slightly DARKER than
 *   the middle instead of 1.85× lighter. A pale tip on a tall plant is the read
 *   "dry" and there is nothing dry here.
 *
 *   A MIDRIB AND TWO SPLITS. The splits are the detail worth the most per
 *   stroke: a banana-family leaf tears along its veins in the wind, so a mature
 *   clump is a set of ragged combs rather than clean paddles, and three
 *   transparent slashes across a leaf turn a flat green shape into something
 *   with a structure. They are drawn with `destination-out`, i.e. they cut the
 *   alpha, so they cost nothing and read at any distance the card does.
 */
export function heliconiaTexture({ key = 'meadow', seed = 'meadow', hue = 126, sat = 40, light = 36 } = {}) {
  return memo(`heliconia:${key}`, () => {
    const w = 128;
    const h = 256;
    const c = canvas(w, h);
    const g = c.getContext('2d');
    const rng = makeRng(seed);
    const EDGE = w * 0.08;
    for (let i = 0; i < 9; i++) {
      const root = w * rngRange(rng, 0.2, 0.8);
      const bw = w * rngRange(rng, 0.15, 0.25);
      const reach = w * 0.34;
      const bend = Math.max(
        EDGE + bw - root,
        Math.min(w - EDGE - bw - root, rngRange(rng, -reach, reach))
      );
      // Most leaves reach the top third of the card, and the few short ones are
      // what give the clump a base rather than a fringe.
      const top = h * (rng() < 0.7 ? rngRange(rng, 0.03, 0.22) : rngRange(rng, 0.34, 0.6));
      const belly = h - (h - top) * 0.7;
      const grad = g.createLinearGradient(0, h, 0, top);
      grad.addColorStop(0, `hsl(${hue - 8} ${sat}% ${light * 0.62}%)`);
      grad.addColorStop(0.45, `hsl(${hue} ${sat + 5}% ${light * 1.18}%)`);
      grad.addColorStop(1, `hsl(${hue + 8} ${sat + 8}% ${light * 0.98}%)`);
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(root, h);
      g.quadraticCurveTo(root - bw, belly, root + bend, top);
      g.quadraticCurveTo(root + bw, belly, root, h);
      g.closePath();
      g.fill();

      /**
       * The midrib. On a leaf this wide it is a stalk, not a hair — but it is
       * kept to a third of a stop above the lamina rather than the half stop the
       * sward's uses, because there are nine of them on this card and a bright
       * line down every one turns a clump of leaves back into a clump of
       * grass. The mark has to say "there is a vein here", not draw it.
       */
      g.strokeStyle = `hsl(${hue - 6} ${sat - 14}% ${Math.min(52, light * 1.28)}%)`;
      g.lineWidth = 2.6;
      g.beginPath();
      g.moveTo(root, h);
      g.quadraticCurveTo(root + bend * 0.4, belly, root + bend, top);
      g.stroke();

      // Wind splits, on two leaves in three. `destination-out` cuts the alpha
      // rather than painting over it, so a slash shows whatever is behind the
      // card — which is what a torn leaf does.
      if (rng() < 0.66) {
        g.save();
        g.globalCompositeOperation = 'destination-out';
        g.lineCap = 'butt';
        g.lineWidth = rngRange(rng, 1.6, 3.4);
        for (let s = 0; s < 3; s++) {
          const t = rngRange(rng, 0.25, 0.92);
          const y = h + (top - h) * t;
          const cx = root + bend * t;
          const side = rng() < 0.5 ? -1 : 1;
          g.beginPath();
          g.moveTo(cx, y);
          g.lineTo(cx + side * bw * rngRange(rng, 0.7, 1.05), y + rngRange(rng, 4, 16));
          g.stroke();
        }
        g.restore();
      }
    }
    featherEdges(g, w, h, w * 0.055, { keepBottom: true });
    return finish(c);
  });
}

/**
 * Bramble: tangled, and the one place in the wood the eye is told not to go.
 *
 * Arching canes with small serrated leaves crowded along them. The value of a
 * thicket is contrast — it only reads as impassable next to somewhere that is
 * not — so this is the darkest thing on the floor, and the leaves are
 * deliberately small and numerous so the silhouette is busy rather than leafy.
 *
 * DARKER THAN THE SWARD, NOT DARK. The first version drew this at 22%
 * lightness, which then went through a 0.51 material colour and a 0.26–0.46
 * instance tint and arrived on screen at about four per cent before the light
 * touched it: every thicket in the wood was a solid black blob, and a black
 * blob does not read as vegetation at all, it reads as a hole in the world or
 * as a shadow bug. Three multiplied factors is the trap — each one looks
 * reasonable on its own and the product is nothing — and it is the same trap
 * living.js records for the additive skylight term on pine bark. All three were
 * lifted together; the contrast against the meadow survives because the meadow
 * was lifted with them and is still two stops brighter.
 */
export function brambleTexture({ key = 'bramble', seed = 'bramble', hue = 116, sat = 34, light = 42 } = {}) {
  return memo(`bramble:${key}`, () => {
    const size = 256;
    const c = canvas(size);
    const g = c.getContext('2d');
    const rng = makeRng(seed);
    const LIMIT = size * 0.44;
    const mid = size / 2;

    // The canes first, so the leaves sit on top of them. Nine rather than
    // seven: the card grew from 1.3 × 0.95 m to 1.95 × 1.5 m and a thicket you
    // can count the canes in is a shrub, not a thicket.
    g.lineCap = 'round';
    for (let i = 0; i < 9; i++) {
      const x0 = size * rngRange(rng, 0.2, 0.8);
      const x1 = Math.max(size * 0.12, Math.min(size * 0.88, x0 + rngRange(rng, -0.3, 0.3) * size));
      const y1 = size * rngRange(rng, 0.14, 0.5);
      g.strokeStyle = `hsl(${hue - 40} ${sat - 12}% ${light * 0.85}%)`;
      g.lineWidth = rngRange(rng, 1.6, 3.2);
      g.beginPath();
      g.moveTo(x0, size);
      // Arching: a bramble cane goes up and then falls over, which is the whole
      // silhouette of a thicket.
      g.quadraticCurveTo(x0 + (x1 - x0) * 0.1, size * 0.34, x1, y1);
      g.stroke();
    }

    const leaf = (cx, cy, len, ang, shade) => {
      g.save();
      g.translate(cx, cy);
      g.rotate(ang);
      g.fillStyle = `hsl(${hue + rngRange(rng, -12, 14)} ${sat}% ${Math.round(light * shade)}%)`;
      g.beginPath();
      g.moveTo(0, 0);
      // Serrated, cheaply: three lobes a side rather than a smooth curve.
      g.quadraticCurveTo(-len * 0.5, -len * 0.3, -len * 0.24, -len * 0.55);
      g.quadraticCurveTo(-len * 0.42, -len * 0.72, 0, -len);
      g.quadraticCurveTo(len * 0.42, -len * 0.72, len * 0.24, -len * 0.55);
      g.quadraticCurveTo(len * 0.5, -len * 0.3, 0, 0);
      g.fill();
      g.restore();
    };

    for (let i = 0; i < 170; i++) {
      const len = size * rngRange(rng, 0.055, 0.115);
      // Same bound as textures.js: place it where it FITS rather than letting
      // the canvas crop it into a straight edge.
      const rMax = Math.max(0, LIMIT - len);
      const r = Math.pow(rng(), 0.55) * rMax;
      const a = rng() * TAU;
      // Biased downward — a bramble is heaviest at the bottom, and a card that
      // is heaviest in the middle reads as a bush.
      const cy = mid + Math.sin(a) * r * 0.9 + size * 0.1;
      /**
       * The shade FLOOR is what matters, not the range.
       *
       * 0.6 at the bottom end put the darkest leaves at 20% lightness, and once
       * that had been through the material colour and the instance tint they
       * were at 7% — fine in a lit glade, and in the shade of a trunk the
       * thicket collapsed into a shapeless black mass again. This is the second
       * time this layer has had to be lifted; the first pass raised the three
       * multipliers and left the texture's own darkest tone where it was, which
       * fixed the lit case and not the shaded one.
       */
      leaf(mid + Math.cos(a) * r, Math.min(size, cy), len, rng() * TAU, rngRange(rng, 0.85, 1.55));
    }
    featherEdges(g, size, size, size * 0.05, { keepBottom: true });
    return finish(c);
  });
}

/**
 * Shrub foliage: a dense mass of small round leaves.
 *
 * Used by the bushes and by the saplings' crowns, which is the whole reason it
 * is one texture and not two — the two layers then share a material, and a
 * shared material is a shared uniform write and a shared program.
 *
 * OPAQUE THROUGH THE MIDDLE, ragged only at the rim. See the note above the
 * texture section: the middle of this card is the cheapest pixel in the file,
 * because it writes depth and hides whatever is behind it.
 *
 * 215 LEAVES RATHER THAN 150, AND GATHERED HARDER, because this card carries
 * the layer the "fewer and bigger" pass grew most: the bush went from 1.15 ×
 * 1.05 m to 1.5 × 2.0 m, so the same 150 leaves would have been spread over
 * 2.5× the world area. A shoulder-height shrub you can see daylight through in
 * the middle is not a shrub you would walk around, and it is also the expensive
 * kind — those gaps are discards. This is the one texture where the count and
 * the gather exponent were both moved, and the second matters more: 0.36
 * instead of 0.42 puts noticeably more of the mass in the heart of the card,
 * which is where the depth writes come from.
 */
export function shrubTexture({ key = 'shrub', seed = 'shrub', hue = 118, sat = 36, light = 42 } = {}) {
  return memo(`shrub:${key}`, () => {
    const size = 256;
    const c = canvas(size);
    const g = c.getContext('2d');
    const rng = makeRng(seed);
    const mid = size / 2;
    const LIMIT = size * 0.45;

    for (let i = 0; i < 215; i++) {
      const len = size * rngRange(rng, 0.05, 0.1);
      const rMax = Math.max(0, LIMIT - len);
      // Cubed toward the centre: the heart of the card fills solid and the
      // outer third breaks up into individual leaves.
      const r = Math.pow(rng(), 0.36) * rMax;
      const a = rng() * TAU;
      const cx = mid + Math.cos(a) * r;
      const cy = mid + Math.sin(a) * r * 0.88;
      const shade = rngRange(rng, 0.55, 1.5);
      const ang = a + Math.PI / 2 + rngRange(rng, -1.3, 1.3);
      g.save();
      g.translate(cx, cy);
      g.rotate(ang);
      const grad = g.createLinearGradient(0, 0, 0, -len);
      grad.addColorStop(0, `hsl(${hue - 8} ${sat}% ${Math.round(light * shade * 0.75)}%)`);
      grad.addColorStop(1, `hsl(${hue + 8} ${sat + 5}% ${Math.round(Math.min(70, light * shade * 1.5))}%)`);
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(-len * 0.48, -len * 0.45, 0, -len);
      g.quadraticCurveTo(len * 0.48, -len * 0.45, 0, 0);
      g.fill();
      g.restore();
    }
    featherEdges(g, size, size, size * 0.06);
    return finish(c);
  });
}

/**
 * Understorey flowers: slender stems with small blossoms on them.
 *
 * DRAWN NEARLY WHITE, and that is what makes one layer into six kinds of
 * flower. The blossoms carry only lightness variation, so the per-instance
 * colour multiplied over them decides what colour a patch is — and a patch is
 * one colour because the instances in a patch share a hue, which is how flowers
 * actually grow. A hue baked into the texture would have needed a layer each.
 *
 * The foliage at the base stays green, so the tint has something to be a flower
 * against.
 *
 *
 * THE HEAD IS A SPIKE NOW, NOT A DAISY, and that is a biome fix rather than a
 * drawing preference. A radial rosette of five or six broad petals round a
 * yellow boss is the flower of a temperate meadow herb — buttercup, daisy,
 * campion — and it is what the eye has been trained on by every lawn it has
 * ever seen. Almost nothing on a rainforest floor is shaped like that. What
 * grows down there flowers in SPIKES and dangling clusters: Costus, Calathea,
 * ginger, Psychotria, small bromeliads. So the same nine heads are drawn as a
 * short vertical raceme of four to six blobs down the top of the stem, which is
 * both cheaper (five arcs, no ellipse rotation) and unmistakably a different
 * kind of plant.
 *
 * THE MECHANISM IS UNTOUCHED. The blobs are still drawn near-white with
 * lightness variation only, so everything the per-patch tint could say before it
 * can still say — this changes the SHAPE the colour arrives in and nothing else.
 */
export function flowerTexture({ key = 'flower', seed = 'flower' } = {}) {
  return memo(`flower:${key}`, () => {
    const size = 128;
    const c = canvas(size);
    const g = c.getContext('2d');
    const rng = makeRng(seed);

    // Leaves at the bottom third. Green, and not tinted by the instance colour
    // any more than a green has to be — the blossoms are what the tint is for.
    for (let i = 0; i < 12; i++) {
      const x = size * rngRange(rng, 0.2, 0.8);
      const len = size * rngRange(rng, 0.12, 0.24);
      const a = rngRange(rng, -1.2, 1.2);
      g.save();
      g.translate(x, size);
      g.rotate(a);
      g.fillStyle = `hsl(${114 + rngRange(rng, -10, 10)} 34% ${rngRange(rng, 22, 40)}%)`;
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(-len * 0.3, -len * 0.6, 0, -len);
      g.quadraticCurveTo(len * 0.3, -len * 0.6, 0, 0);
      g.fill();
      g.restore();
    }

    // Nine stems rather than seven, on a card that grew from 0.36 × 0.34 m to
    // 0.52 × 0.5 m. A flower patch is half as many instances now, so each one
    // has to read as a handful of blooms rather than as a single bloom.
    const heads = [];
    for (let i = 0; i < 9; i++) {
      const root = size * rngRange(rng, 0.24, 0.76);
      const top = size * rngRange(rng, 0.14, 0.5);
      const tipX = Math.max(size * 0.14, Math.min(size * 0.86, root + rngRange(rng, -0.16, 0.16) * size));
      g.strokeStyle = `hsl(96 30% ${rngRange(rng, 26, 40)}%)`;
      g.lineWidth = rngRange(rng, 1.5, 2.4);
      g.beginPath();
      g.moveTo(root, size);
      g.quadraticCurveTo(root, size * 0.55, tipX, top);
      g.stroke();
      heads.push([tipX, top, rngRange(rng, 5.5, 10)]);
    }

    for (const [hx, hy, r] of heads) {
      /**
       * Down the stem, not around a point. `hy` is the TOP of the stem, so the
       * spike is built downward from it — a raceme opens from the bottom up and
       * the unopened buds are the ones at the tip, which is why the blobs get
       * smaller and dimmer as they go up.
       */
      const florets = 4 + Math.floor(rng() * 3);
      for (let p = 0; p < florets; p++) {
        const t = p / (florets - 1);
        const bx = hx + Math.sin(p * 2.1) * r * 0.34;
        const by = hy + (1 - t) * r * 1.5;
        g.fillStyle = `hsl(45 12% ${rngRange(rng, 78, 100)}%)`;
        g.beginPath();
        g.arc(bx, by, r * (0.44 - t * 0.16), 0, TAU);
        g.fill();
      }
      // A green bract at the foot of the spike. It is one arc and it is what
      // stops a raceme reading as a string of beads on a wire.
      g.fillStyle = 'hsl(104 32% 34%)';
      g.beginPath();
      g.ellipse(hx, hy + r * 1.7, r * 0.5, r * 0.34, 0, 0, TAU);
      g.fill();
    }
    featherEdges(g, size, size, size * 0.05, { keepBottom: true });
    return finish(c);
  });
}

/**
 * Leaf litter and moss, on one card.
 *
 * DRAWN ALMOST WITHOUT HUE, which is the trick that makes this one layer serve
 * two biomes. The mat carries structure — individual leaf shapes, needle
 * strokes, a dense middle thinning to scattered flecks at the rim — and the
 * per-instance colour decides whether it is rust-brown drift under the pines or
 * a green cushion on the wet ground by the stream. Baking the colour in would
 * have cost a second texture, a second material and a second draw for a
 * difference the instance buffer can express for free.
 *
 * No `keepBottom`: this card lies flat, so it has no root edge and its whole
 * border has to feather or the mats are visible rectangles from above.
 */
export function litterTexture({ key = 'litter', seed = 'litter' } = {}) {
  return memo(`litter:${key}`, () => {
    const size = 256;
    const c = canvas(size);
    const g = c.getContext('2d');
    const rng = makeRng(seed);
    const mid = size / 2;
    const LIMIT = size * 0.46;

    const place = () => {
      // Pow 0.45 gathers the marks into the middle, so the mat has a solid heart
      // and a scatter of individual leaves around it rather than a hard rim.
      const r = Math.pow(rng(), 0.45) * LIMIT;
      const a = rng() * TAU;
      return [mid + Math.cos(a) * r, mid + Math.sin(a) * r, r / LIMIT];
    };

    // Needles first: thin strokes, all over, the substrate everything else
    // lands on.
    g.lineCap = 'round';
    for (let i = 0; i < 260; i++) {
      const [x, y, t] = place();
      const len = size * rngRange(rng, 0.03, 0.075);
      const a = rng() * TAU;
      g.strokeStyle = `hsl(${rngRange(rng, 24, 44)} 14% ${rngRange(rng, 38, 74)}% / ${(1 - t * 0.75).toFixed(2)})`;
      g.lineWidth = rngRange(rng, 1.6, 3);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      g.stroke();
    }

    // Then whole leaves, big enough to be read individually at a metre.
    for (let i = 0; i < 90; i++) {
      const [x, y, t] = place();
      const len = size * rngRange(rng, 0.055, 0.12);
      g.save();
      g.translate(x, y);
      g.rotate(rng() * TAU);
      g.globalAlpha = 1 - t * 0.7;
      g.fillStyle = `hsl(${rngRange(rng, 22, 48)} 15% ${rngRange(rng, 42, 80)}%)`;
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(-len * 0.42, -len * 0.4, 0, -len);
      g.quadraticCurveTo(len * 0.42, -len * 0.4, 0, 0);
      g.fill();
      g.restore();
    }
    featherEdges(g, size, size, size * 0.1);
    return finish(c);
  });
}

/**
 * The bank of the stream: tall, straight, and almost without taper.
 *
 * The opposite drawing problem from a leaf tuft. A blade is a spindle that
 * bends; these are straps that go straight up for two metres and then nod, and
 * getting that stiffness right is what makes the bank of the stream look like a
 * bank rather than like the rest of the wood with its feet wet.
 *
 *
 * ==== THE CATTAILS HAD TO GO ==============================================
 *
 * Two of the straps used to carry one — a dark brown sausage near the top — and
 * the old comment called it "the single most recognisable thing in this entire
 * file". It was, and that was the problem: Typha latifolia is a temperate marsh
 * plant and a bulrush is the universal shorthand for a northern pond. Two of
 * them on a card instanced twelve hundred times along every watercourse in the
 * world put an English millpond in the middle of the Amazon, and it was the
 * clearest single object anywhere in the report that parts of this forest do
 * not look like a rainforest — precisely BECAUSE it was the most recognisable
 * thing here. A cue that strong is worth as much pointing the wrong way as the
 * right one.
 *
 * WHAT REPLACES IT is the same silhouette without the head: a stand of stiff
 * straps, which on a tropical bank is Cyperus, wild cane or the strap leaves of
 * a young Heliconia, and none of those has a mark on it that says a latitude.
 * The head's strokes were not simply deleted — they were spent on making the
 * straps read, since the sausage was carrying the whole card. Two changes:
 *
 *   A DARK MARGIN DOWN EACH EDGE. A strap leaf seen against the sky is a pale
 *   blade with two dark lines on it, and that is what stops a stand of them
 *   reading as a flat green rectangle at ten metres.
 *
 *   A THIRD OF THEM NOD HARDER. `top` used to be uniform, so the tops of all
 *   twelve landed in the same 4% of the card and the stand had a dead flat
 *   ceiling that reads as a hedge trimmed with shears.
 */
export function reedTexture({ key = 'reed', seed = 'reed', hue = 108, sat = 32, light = 38 } = {}) {
  return memo(`reed:${key}`, () => {
    const w = 128;
    const h = 256;
    const c = canvas(w, h);
    const g = c.getContext('2d');
    const rng = makeRng(seed);
    const EDGE = w * 0.1;
    // Twelve straps rather than nine, on a card that grew from 0.5 × 1.7 m to
    // 0.72 × 2.3 m. They grow in stands so thick you cannot see the water
    // through them, which is the one thing a bank has that the wood does not.
    for (let i = 0; i < 12; i++) {
      const root = w * rngRange(rng, 0.2, 0.8);
      /**
       * WIDE ENOUGH TO BE A LEAF RATHER THAN A WIRE.
       *
       * At 0.028–0.048 of a 128 px canvas these were 4–6 px, which on a 0.5 m
       * card is a blade fifteen millimetres across and one metre seventy tall —
       * botanically about right and visually a bundle of dark stringy wires
       * standing in the water. Doubling it costs nothing (a fatter card is
       * cheaper per unit of coverage, not dearer — the discards are what cost)
       * and it is the difference between rushes and a hairbrush.
       */
      const bw = w * rngRange(rng, 0.055, 0.09);
      const bend = Math.max(EDGE + bw - root, Math.min(w - EDGE - bw - root, rngRange(rng, -w * 0.22, w * 0.22)));
      // One in three nods well short of the top, so the stand has a broken
      // ceiling rather than a trimmed one.
      const top = h * (rng() < 0.66 ? rngRange(rng, 0.02, 0.16) : rngRange(rng, 0.26, 0.5));
      const grad = g.createLinearGradient(0, h, 0, top);
      grad.addColorStop(0, `hsl(${hue - 12} ${sat}% ${light * 0.62}%)`);
      grad.addColorStop(0.5, `hsl(${hue} ${sat}% ${light * 1.15}%)`);
      grad.addColorStop(1, `hsl(${hue + 10} ${sat + 6}% ${light * 1.35}%)`);
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(root, h);
      // The belly is near the TOP, not a third of the way up: a strap holds its
      // width all the way and only narrows in the last few centimetres.
      g.quadraticCurveTo(root - bw, top + (h - top) * 0.12, root + bend, top);
      g.quadraticCurveTo(root + bw, top + (h - top) * 0.12, root, h);
      g.closePath();
      g.fill();

      /**
       * The two dark margins. Stroked as the SAME path the fill just used, at a
       * line width the blade can carry, so they follow the leaf's own curve
       * exactly — an edge drawn as two separate lines drifts off the silhouette
       * wherever `bend` is large and reads as a stripe rather than as a rim.
       */
      g.strokeStyle = `hsl(${hue - 16} ${sat + 8}% ${light * 0.5}%)`;
      g.lineWidth = 2;
      g.stroke();
    }
    featherEdges(g, w, h, w * 0.06, { keepBottom: true });
    return finish(c);
  });
}

/**
 * ONE PINNATE FROND, AND A STRIP OF STEM ALONG THE BOTTOM OF THE CARD.
 *
 * The card is the whole leaf: petiole at the bottom edge, rachis up the middle,
 * twenty-six pairs of leaflets sweeping forward off it. Seven of these in a
 * rosette is a palm crown, and the same seven at half the instance scale with a
 * darker tint is a tree fern.
 *
 * THE PETIOLE IS LOAD-BEARING IN TWO DIFFERENT WAYS. On the plant it is the
 * stalk, and drawing it fat is what stops a crown reading as leaves floating
 * over a pole. In the geometry it is the only region of this canvas guaranteed
 * to be fully opaque, and `palmGeometry` maps the whole six-metre stem into a
 * narrow vertical strip of it — see `STEM_UV` there. An alpha-tested material
 * DISCARDS wherever the texture is transparent, so a stem mapped anywhere else
 * on this card would come out with holes punched down its length. The vertical
 * streaking in it is therefore not decoration either: a vertical line on this
 * canvas is a line of constant u, which wraps to a LENGTHWISE fibre up the
 * stem, which is what the trunk of a palm and the trunk of a tree fern both
 * actually look like. The horizontal gradient across it is the cylinder's own
 * shading, dark-bright-dark around the circumference.
 *
 * DRAWN DENSE, like everything else in this file and for the measured reason at
 * the head of the section: the leaflets overlap their neighbours rather than
 * leaving daylight between them, because every gap is a discarded fragment that
 * writes no depth, and this layer's whole job is to stop rays at 8-12 m.
 */
export function palmFrondTexture({ key = 'frond', seed = 'frond', hue = 116, sat = 42, light = 40 } = {}) {
  return memo(`frond:${key}`, () => {
    const w = 128;
    const h = 256;
    const c = canvas(w, h);
    const g = c.getContext('2d');
    const rng = makeRng(seed);
    const mid = w / 2;
    const baseY = h * 0.845;
    const tipY = h * 0.045;

    // ---- the petiole, and therefore the stem ------------------------------
    const stalk = g.createLinearGradient(mid - 9, 0, mid + 9, 0);
    stalk.addColorStop(0, 'hsl(66 13% 20%)');
    stalk.addColorStop(0.44, 'hsl(58 16% 41%)');
    stalk.addColorStop(1, 'hsl(66 11% 23%)');
    g.fillStyle = stalk;
    g.fillRect(mid - 9, baseY - 6, 18, h - baseY + 6);
    g.lineCap = 'butt';
    for (let i = 0; i < 7; i++) {
      const fx = mid - 8 + rngRange(rng, 0.4, 16.2);
      g.strokeStyle = `hsl(${rngRange(rng, 48, 74).toFixed(0)} ${rngRange(rng, 8, 20).toFixed(0)}% ${rngRange(rng, 16, 52).toFixed(0)}% / 0.55)`;
      g.lineWidth = rngRange(rng, 0.9, 2.2);
      g.beginPath();
      g.moveTo(fx, h);
      g.lineTo(fx + rngRange(rng, -1.2, 1.2), baseY - 6);
      g.stroke();
    }

    // ---- the blade --------------------------------------------------------
    const bend = rngRange(rng, -9, 9);
    const rachisX = (t) => {
      // One quadratic, evaluated rather than stroked, so a leaflet and the rib
      // it grows off cannot disagree about where the rib is.
      const u = 1 - t;
      return u * u * mid + 2 * u * t * (mid + bend * 0.35) + t * t * (mid + bend);
    };

    const leaflet = (cx, cy, len, bw, ang, shade) => {
      g.save();
      g.translate(cx, cy);
      g.rotate(ang);
      const grad = g.createLinearGradient(0, 0, 0, -len);
      grad.addColorStop(0, `hsl(${hue - 12} ${sat}% ${Math.round(light * shade * 0.66)}%)`);
      grad.addColorStop(0.55, `hsl(${hue} ${sat + 4}% ${Math.round(Math.min(66, light * shade * 1.16))}%)`);
      grad.addColorStop(1, `hsl(${hue + 10} ${sat + 8}% ${Math.round(light * shade * 0.92)}%)`);
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(0, 0);
      // Holds its width most of the way and then points — a pinna, not a blade
      // of grass. The same profile decision the reed straps record.
      g.quadraticCurveTo(-bw, -len * 0.58, 0, -len);
      g.quadraticCurveTo(bw, -len * 0.58, 0, 0);
      g.fill();
      g.restore();
    };

    const N = 30;
    const maxLen = w * 0.4;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      // A frond is widest a third of the way up and comes to a point; the
      // exponent keeps the base pinnae substantial rather than vestigial.
      const prof = Math.pow(Math.max(0, Math.sin(Math.PI * (0.13 + t * 0.87))), 0.55);
      const len = maxLen * prof * rngRange(rng, 0.9, 1.08);
      if (len < 3) continue;
      const y = baseY + (tipY - baseY) * t;
      const x0 = rachisX(t);
      // Sweeping forward as they go up: 60 degrees off the rib at the base,
      // 40 near the tip, which is what makes a frond look like it is reaching
      // rather than like a feather duster.
      const a = 1.05 - 0.33 * t;
      const bw = 4.2 + 4.0 * prof;
      for (const side of [-1, 1]) {
        // One pinna in fourteen is missing. A frond that has been in the wind
        // for a season has gaps in it, and a comb with no teeth missing is the
        // single most synthetic thing a leaf can be.
        if (rng() < 0.07) continue;
        leaflet(
          x0,
          y,
          len,
          bw,
          side * (a + rngRange(rng, -0.12, 0.12)),
          rngRange(rng, 0.82, 1.28)
        );
      }
    }

    // The rachis last, over the leaflets, so it reads as the thing they are
    // attached to. Tapering, and never brighter than the lamina by much — see
    // the midrib note on the heliconia.
    g.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      const t0 = i / 5;
      const t1 = (i + 1) / 5;
      g.strokeStyle = `hsl(${hue - 8} ${sat - 16}% ${Math.round(Math.min(54, light * (1.18 - t0 * 0.2)))}%)`;
      g.lineWidth = 4.6 * (1 - t0 * 0.82);
      g.beginPath();
      g.moveTo(rachisX(t0), baseY + (tipY - baseY) * t0);
      g.lineTo(rachisX(t1), baseY + (tipY - baseY) * t1);
      g.stroke();
    }

    featherEdges(g, w, h, w * 0.05, { keepBottom: true });
    return finish(c);
  });
}

/**
 * A BROMELIAD ROSETTE, AND THE ONE PLACE IN THE FILE WHERE COLOUR IS THE POINT.
 *
 * WHY THE TINT IS NEARLY WHITE HERE AND NOWHERE ELSE. Every other card layer
 * draws a green texture and multiplies a green instance tint over a green
 * material colour, which is fine for green and arrives at mud for anything
 * else: scarlet at sRGB (0.90, 0.12, 0.08) under this file's usual 0x62825a
 * material comes out #560A06, a dark maroon. Three multiplied factors is the
 * trap the bramble block records. So the colour is baked into the CANVAS, the
 * material colour is 0xffffff and the instance tint carries lightness and a few
 * degrees of hue and nothing else. The texture is the only thing deciding what
 * colour a bromeliad is, which is the only arrangement in which it can be red.
 *
 * CHECKED IN LUMA, not by eye — the rule this project keeps relearning is that
 * moving a colour by eye makes it darker and darker down here reads as a hole.
 * The scarlet heart is hsl(6 86% 52%), Rec.709 luma 101; the green straps run
 * 28-44% lightness, luma 88-125. The red is INSIDE the range of the leaves it
 * sits among, so it reads as a flower and not as a puncture.
 *
 * The cross-banding is four grey-green strokes and it is the cheapest thing on
 * this canvas: Aechmea and Billbergia are banded, nothing temperate is, and a
 * band survives being three pixels wide at thirty metres in a way that a shape
 * does not.
 */
export function bromeliadTexture({ key = 'bromeliad', seed = 'bromeliad' } = {}) {
  return memo(`bromeliad:${key}`, () => {
    const size = 256;
    const c = canvas(size);
    const g = c.getContext('2d');
    const rng = makeRng(seed);
    const rootX = size / 2;
    const rootY = size * 0.98;

    const strap = (ang, len, bw, hue, sat, light, flush) => {
      g.save();
      g.translate(rootX, rootY);
      g.rotate(ang);
      const grad = g.createLinearGradient(0, 0, 0, -len);
      // Wine at the throat, green up the blade, a hint of bronze at the tip.
      grad.addColorStop(0, `hsl(${flush ? 8 : hue - 14} ${flush ? 62 : sat}% ${flush ? 30 : light * 0.62}%)`);
      grad.addColorStop(0.34, `hsl(${hue} ${sat}% ${light}%)`);
      grad.addColorStop(0.82, `hsl(${hue + 6} ${sat + 6}% ${light * 1.12}%)`);
      grad.addColorStop(1, `hsl(${hue - 26} ${sat + 10}% ${light * 0.78}%)`);
      g.fillStyle = grad;
      g.beginPath();
      /**
       * A BLUNT TIP, NOT A POINT, and it is the difference between a bromeliad
       * and an agave. The first build drew each strap as a spindle coming to a
       * point and the rosette read as a spiky desert succulent — a green
       * starburst — which is a plant from the wrong continent AND the wrong
       * biome. A Neoregelia leaf is a strap that holds its width to within a
       * couple of centimetres of the end and then rounds off, so the last 12%
       * of the path is a flat cap rather than a vertex. It also fills more of
       * the card, which is the cheap direction.
       */
      g.moveTo(-bw * 0.34, 0);
      g.quadraticCurveTo(-bw, -len * 0.7, -bw * 0.34, -len * 0.94);
      g.quadraticCurveTo(0, -len * 1.02, bw * 0.34, -len * 0.94);
      g.quadraticCurveTo(bw, -len * 0.7, bw * 0.34, 0);
      g.closePath();
      g.fill();
      // The bands.
      g.strokeStyle = `hsl(${hue + 14} 12% ${Math.round(light * 1.7)}% / 0.5)`;
      g.lineWidth = 2.4;
      for (let b = 0; b < 4; b++) {
        const ly = -len * (0.24 + b * 0.19);
        g.beginPath();
        g.moveTo(-bw * 0.72, ly);
        g.lineTo(bw * 0.72, ly - 1.5);
        g.stroke();
      }
      g.restore();
    };

    // The outer rosette. Laid down almost flat at the edges, which is what
    // makes a bank of these read as a mat rather than as a row of tufts.
    for (let i = 0; i < 18; i++) {
      const ang = rngRange(rng, -1.5, 1.5);
      const lay = Math.abs(ang) / 1.5;
      strap(
        ang,
        size * rngRange(rng, 0.31, 0.54) * (1 - lay * 0.2),
        size * rngRange(rng, 0.052, 0.085),
        112 + rngRange(rng, -8, 10),
        Math.round(rngRange(rng, 32, 48)),
        Math.round(rngRange(rng, 29, 39) + (1 - lay) * 4),
        lay < 0.34 && rng() < 0.8
      );
    }

    /**
     * The scarlet heart. Five short upright bracts rather than one blob,
     * because the thing that reads at thirty metres is a bright shape with
     * structure in it — a solid disc of red reads as a berry or as a bug.
     *
     * SHORTER THAN THE STRAPS AND HELD INSIDE THEM, which was the correction.
     * At 0.16-0.30 of the card they stood proud of the rosette and every plant
     * read as a green starburst with a flame coming out of it — the red was
     * competing with the leaves for the silhouette rather than sitting in the
     * middle of them. A bromeliad's inflorescence is DOWN IN the cup, which is
     * the whole point of the cup; keeping it there also stops a hundred and
     * eighty of these reading as scattered warning lights.
     */
    for (let i = 0; i < 5; i++) {
      const ang = rngRange(rng, -0.55, 0.55);
      const len = size * rngRange(rng, 0.12, 0.23);
      const bw = size * rngRange(rng, 0.028, 0.046);
      g.save();
      g.translate(rootX + rngRange(rng, -8, 8), rootY - size * 0.06);
      g.rotate(ang);
      const grad = g.createLinearGradient(0, 0, 0, -len);
      grad.addColorStop(0, 'hsl(0 72% 34%)');
      grad.addColorStop(0.5, 'hsl(6 86% 52%)');
      grad.addColorStop(1, `hsl(${rngRange(rng, 18, 44).toFixed(0)} 90% 60%)`);
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(-bw, -len * 0.5, 0, -len);
      g.quadraticCurveTo(bw, -len * 0.5, 0, 0);
      g.fill();
      g.restore();
    }

    featherEdges(g, size, size, size * 0.05, { keepBottom: true });
    return finish(c);
  });
}

/**
 * ONE ENORMOUS LEAF ON A STALK, WITH A HELICONIA BRACT BESIDE IT.
 *
 * The strongest "this is a jungle and not a wood" cue available per unit of
 * cost, and the reason is the measured one that governs this whole file: a big
 * solid card is CHEAPER per square metre of coverage than several small wispy
 * ones, because the fragments in the middle of it write depth and occlude what
 * is behind them while a discard defeats early-Z. So this is three cards, each
 * more than a metre and a half across, at eleven-metre spacing — the fewest and
 * largest things in the understorey.
 *
 * THE PERFORATIONS ARE THE WHOLE READ AND THEY ARE THE ONE PLACE FILL IS SPENT.
 * A cordate leaf with holes in it is a Monstera and nothing else on earth; the
 * same leaf without them is a lily pad on a stick. They are cut with
 * `destination-out`, so they cost four ellipses of drawing and some discarded
 * fragments, and there are four of them rather than a dozen for exactly that
 * reason.
 *
 * The bract carries colour on the same terms the bromeliad does — baked into
 * the canvas, white material, near-neutral instance tint — because a scarlet
 * multiplied through a green material and a green tint is a dark maroon.
 */
export function giantLeafTexture({ key = 'bigleaf', seed = 'bigleaf', hue = 110, sat = 50, light = 34 } = {}) {
  return memo(`bigleaf:${key}`, () => {
    const size = 256;
    const c = canvas(size);
    const g = c.getContext('2d');
    const rng = makeRng(seed);
    const bx = size * 0.48;
    /**
     * THE BLADE STARTS AT 0.76 OF THE CARD, NOT 0.6, AND THAT IS THE WHOLE
     * SILHOUETTE FIX.
     *
     * At 0.6 the petiole was forty per cent of the card — a long dark wire with
     * a leaf on the end — and three of those in a rosette read as a lollipop
     * stand rather than as a plant. The real proportion on a Philodendron or a
     * Xanthosoma is a stalk about a quarter of the whole and a blade that is
     * most of it, which is also the cheap way round: the blade is the part that
     * fills solid and writes depth, and the stalk is the part that is nearly
     * all discarded fragments around a two-pixel line.
     */
    const by = size * 0.76;
    const tx = size * 0.53;
    const ty = size * 0.06;

    // The petiole. Long and visible: an aroid holds its leaf out on a stalk
    // half the length of the blade, and that gap is most of the silhouette.
    g.lineCap = 'round';
    g.strokeStyle = `hsl(${hue - 18} 26% 26%)`;
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(size * 0.5, size);
    g.quadraticCurveTo(size * 0.46, size * 0.8, bx, by);
    g.stroke();

    // The blade.
    const spread = size * 0.43;
    const grad = g.createLinearGradient(0, by, 0, ty);
    grad.addColorStop(0, `hsl(${hue - 10} ${sat}% ${light * 0.7}%)`);
    grad.addColorStop(0.45, `hsl(${hue} ${sat + 4}% ${light * 1.24}%)`);
    grad.addColorStop(1, `hsl(${hue + 8} ${sat + 8}% ${light * 1.02}%)`);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(bx, by);
    g.bezierCurveTo(bx - spread, by - size * 0.04, bx - spread * 0.94, ty + size * 0.24, tx, ty);
    g.bezierCurveTo(bx + spread * 0.94, ty + size * 0.24, bx + spread, by - size * 0.04, bx, by);
    g.fill();

    // Midrib and laterals. Half a stop above the lamina, no more — see the
    // heliconia's midrib note, which is the same trap at a different scale.
    g.strokeStyle = `hsl(${hue - 6} ${sat - 18}% ${Math.min(58, light * 1.5)}%)`;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(bx, by);
    g.quadraticCurveTo(bx + (tx - bx) * 0.4, (by + ty) * 0.5, tx, ty);
    g.stroke();
    g.lineWidth = 1.6;
    for (let i = 1; i < 8; i++) {
      const t = i / 8;
      const mxp = bx + (tx - bx) * t;
      const myp = by + (ty - by) * t;
      const reach = spread * Math.sin(Math.PI * (0.16 + t * 0.78)) * 0.86;
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(mxp, myp);
        g.quadraticCurveTo(mxp + side * reach * 0.55, myp - size * 0.02, mxp + side * reach, myp - size * 0.07);
        g.stroke();
      }
    }

    // Four holes and two marginal splits, cut rather than painted.
    g.save();
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 4; i++) {
      const t = rngRange(rng, 0.22, 0.72);
      const side = i % 2 ? 1 : -1;
      const mxp = bx + (tx - bx) * t;
      const myp = by + (ty - by) * t;
      const reach = spread * Math.sin(Math.PI * (0.16 + t * 0.78)) * 0.86;
      g.beginPath();
      g.ellipse(
        mxp + side * reach * rngRange(rng, 0.34, 0.62),
        myp - size * rngRange(rng, 0.01, 0.05),
        size * rngRange(rng, 0.035, 0.058),
        size * rngRange(rng, 0.018, 0.03),
        side * 0.4,
        0,
        TAU
      );
      g.fill();
    }
    g.lineCap = 'butt';
    g.lineWidth = size * 0.028;
    for (let i = 0; i < 2; i++) {
      const t = rngRange(rng, 0.3, 0.66);
      const side = i ? 1 : -1;
      const mxp = bx + (tx - bx) * t;
      const myp = by + (ty - by) * t;
      const reach = spread * Math.sin(Math.PI * (0.16 + t * 0.78)) * 0.86;
      g.beginPath();
      g.moveTo(mxp + side * reach * 1.05, myp - size * 0.05);
      g.lineTo(mxp + side * reach * 0.32, myp - size * 0.02);
      g.stroke();
    }
    g.restore();

    /**
     * The Heliconia. A short stem with five alternating bracts down it, which
     * is the exact silhouette of a lobster claw and is the one flower shape
     * that could not be mistaken for anything in a temperate wood.
     */
    const hx = size * 0.72;
    const hy = size * 0.96;
    g.lineCap = 'round';
    g.strokeStyle = `hsl(${hue - 12} 30% 26%)`;
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(hx + 6, size);
    g.quadraticCurveTo(hx, size * 0.9, hx - 3, size * 0.74);
    g.stroke();
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      const px = hx + 6 - t * 9;
      const py = hy - t * size * 0.22;
      const side = i % 2 ? 1 : -1;
      const len = size * (0.095 - t * 0.026);
      const grd = g.createLinearGradient(px, py, px + side * len, py - len * 0.4);
      grd.addColorStop(0, 'hsl(2 74% 36%)');
      grd.addColorStop(0.55, 'hsl(6 88% 51%)');
      grd.addColorStop(1, 'hsl(40 92% 58%)');
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(px, py);
      g.quadraticCurveTo(px + side * len * 0.7, py - len * 0.62, px + side * len, py - len * 0.28);
      g.quadraticCurveTo(px + side * len * 0.55, py + len * 0.16, px, py + len * 0.2);
      g.closePath();
      g.fill();
    }

    featherEdges(g, size, size, size * 0.05, { keepBottom: true });
    return finish(c);
  });
}

export function disposeUndergrowthTextures() {
  for (const tex of cache.values()) tex.dispose?.();
  cache.clear();
}
