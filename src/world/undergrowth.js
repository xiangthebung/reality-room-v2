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
      n.y += 1.4;
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
 * Long meadow grass: the single most valuable thing added.
 *
 * A taller, denser cousin of `grassBlade` in textures.js and it obeys the same
 * two hard rules. THE BLADES MUST NOT MEET AT THE BOTTOM — each is a spindle
 * with a point at the root, or the bottom strip of the card becomes a solid
 * dark bar sitting under every tuft in the forest. And the tips must land
 * inside the card, or every clump gets the same dead straight vertical cut.
 *
 * Drawn on a 128×256 canvas rather than a square one because the card it goes
 * on is 0.9 m by 1.95 m; a square texture stretched onto that makes every blade
 * two and a half times too wide, which is not grass, it is a leek.
 *
 * NINETEEN BLADES AND HALF AGAIN AS WIDE, up from thirteen thin ones, because
 * the card under it grew from 0.62 × 1.15 m to 0.9 × 1.95 m. The blade width is
 * a fraction of the CANVAS, so the same fraction on a card 1.45× wider is a
 * blade 1.45× wider in the world — which is right, since this is now a plant
 * you stand in rather than one you look down at, and a 5 mm blade at arm's
 * length is a hair. Six more of them keeps the fill up, and the fill is what
 * makes this cheap: see the note at the head of this section.
 */
export function tallGrassTexture({ key = 'meadow', seed = 'meadow', hue = 78, sat = 38, light = 40 } = {}) {
  return memo(`tallgrass:${key}`, () => {
    const w = 128;
    const h = 256;
    const c = canvas(w, h);
    const g = c.getContext('2d');
    const rng = makeRng(seed);
    const EDGE = w * 0.08;
    for (let i = 0; i < 19; i++) {
      const root = w * rngRange(rng, 0.14, 0.86);
      const bw = w * rngRange(rng, 0.05, 0.095);
      const reach = w * 0.4;
      const bend = Math.max(
        EDGE + bw - root,
        Math.min(w - EDGE - bw - root, rngRange(rng, -reach, reach))
      );
      // Tall grass is tall: most blades reach the top third of the card, and
      // the few short ones are what give the tuft a base rather than a fringe.
      // 0.78 rather than 0.72 now that the card is a 1.95 m plant — a short
      // blade on this card is 0.8 m of grass, which is a whole tuft's worth of
      // the OLD plant and does not need to be one blade in three.
      const top = h * (rng() < 0.78 ? rngRange(rng, 0.02, 0.2) : rngRange(rng, 0.32, 0.58));
      const belly = h - (h - top) * 0.42;
      const grad = g.createLinearGradient(0, h, 0, top);
      grad.addColorStop(0, `hsl(${hue - 10} ${sat}% ${light * 0.7}%)`);
      grad.addColorStop(0.45, `hsl(${hue} ${sat + 5}% ${light * 1.2}%)`);
      // Bleached at the tip. Long grass in summer is straw at the top and green
      // at the bottom, and that vertical gradient is most of what distinguishes
      // a hay meadow from a lawn.
      grad.addColorStop(1, `hsl(${hue + 16} ${sat + 10}% ${light * 1.85}%)`);
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(root, h);
      g.quadraticCurveTo(root - bw, belly, root + bend, top);
      g.quadraticCurveTo(root + bw, belly, root, h);
      g.closePath();
      g.fill();

      // A seed head on one blade in four: a nodding spike of small marks. It is
      // the detail that says "this is not mown", and it is six strokes.
      if (rng() < 0.26) {
        g.strokeStyle = `hsl(${hue + 22} ${sat - 8}% ${light * 1.6}%)`;
        g.lineWidth = 2.2;
        g.lineCap = 'round';
        for (let k = 0; k < 7; k++) {
          const t = k / 7;
          const px = root + bend * (1 + t * 0.12);
          const py = top - t * h * 0.055;
          g.beginPath();
          g.moveTo(px, py);
          g.lineTo(px + (k % 2 ? 3.4 : -3.4), py - 4.5);
          g.stroke();
        }
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
export function shrubTexture({ key = 'shrub', seed = 'shrub', hue = 96, sat = 36, light = 42 } = {}) {
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
 * Wildflowers: slender stems with small blossoms on top.
 *
 * DRAWN NEARLY WHITE, and that is what makes one layer into six kinds of
 * flower. The blossoms carry only lightness variation, so the per-instance
 * colour multiplied over them decides whether a patch is buttercup yellow,
 * campion pink, harebell blue or cow-parsley white — and a patch is one colour
 * because the instances in a patch share a hue, which is how flowers actually
 * grow. A hue baked into the texture would have needed a layer each.
 *
 * The foliage at the base stays green, so the tint has something to be a flower
 * against.
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
      g.fillStyle = `hsl(${100 + rngRange(rng, -10, 10)} 34% ${rngRange(rng, 22, 40)}%)`;
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
      const petals = 5 + Math.floor(rng() * 2);
      for (let p = 0; p < petals; p++) {
        const a = (p / petals) * TAU + rng() * 0.3;
        g.fillStyle = `hsl(45 12% ${rngRange(rng, 80, 100)}%)`;
        g.beginPath();
        g.ellipse(hx + Math.cos(a) * r * 0.62, hy + Math.sin(a) * r * 0.62, r * 0.5, r * 0.36, a, 0, TAU);
        g.fill();
      }
      g.fillStyle = 'hsl(48 45% 62%)';
      g.beginPath();
      g.arc(hx, hy, r * 0.28, 0, TAU);
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
 * Reeds at the water's edge: tall, straight, and almost without taper.
 *
 * The opposite drawing problem from grass. A blade of grass is a spindle that
 * bends; a reed is a strap that goes straight up for two metres and then nods,
 * and getting that stiffness right is what makes the bank of the stream look
 * like a bank rather than like the rest of the wood with its feet wet. Two of
 * them get a cattail — a dark brown sausage near the top — which is the single
 * most recognisable thing in this entire file.
 */
export function reedTexture({ key = 'reed', seed = 'reed', hue = 84, sat = 30, light = 38 } = {}) {
  return memo(`reed:${key}`, () => {
    const w = 128;
    const h = 256;
    const c = canvas(w, h);
    const g = c.getContext('2d');
    const rng = makeRng(seed);
    const EDGE = w * 0.1;
    const heads = [];
    // Twelve straps rather than nine, on a card that grew from 0.5 × 1.7 m to
    // 0.72 × 2.3 m. Reeds grow in stands so thick you cannot see the water
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
      const top = h * rngRange(rng, 0.02, 0.2);
      const grad = g.createLinearGradient(0, h, 0, top);
      grad.addColorStop(0, `hsl(${hue - 12} ${sat}% ${light * 0.62}%)`);
      grad.addColorStop(0.5, `hsl(${hue} ${sat}% ${light * 1.15}%)`);
      grad.addColorStop(1, `hsl(${hue + 14} ${sat + 6}% ${light * 1.5}%)`);
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(root, h);
      // The belly is near the TOP, not a third of the way up: a reed holds its
      // width all the way and only narrows in the last few centimetres.
      g.quadraticCurveTo(root - bw, top + (h - top) * 0.12, root + bend, top);
      g.quadraticCurveTo(root + bw, top + (h - top) * 0.12, root, h);
      g.closePath();
      g.fill();
      if (i < 2) heads.push([root + bend, top + h * 0.03, bw]);
    }
    for (const [hx, hy, bw] of heads) {
      const grad = g.createLinearGradient(hx - bw, 0, hx + bw, 0);
      grad.addColorStop(0, 'hsl(26 30% 16%)');
      grad.addColorStop(0.45, 'hsl(28 34% 30%)');
      grad.addColorStop(1, 'hsl(26 30% 18%)');
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(hx, hy + h * 0.075, bw * 1.5, h * 0.075, 0, 0, TAU);
      g.fill();
    }
    featherEdges(g, w, h, w * 0.06, { keepBottom: true });
    return finish(c);
  });
}

export function disposeUndergrowthTextures() {
  for (const tex of cache.values()) tex.dispose?.();
  cache.clear();
}
