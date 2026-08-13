import * as THREE from 'three';
import { makeRng, rngRange } from '../core/util.js';

/**
 * The trunk's texture, and the colour strip beside it.
 *
 * ==== WHY THERE IS A STRIP AT ALL ==========================================
 *
 * The report was that there is NO COLOUR ANYWHERE AT EYE LEVEL, and the reason
 * turned out to be architectural rather than artistic. A tree in this forest is
 * two merged geometries and exactly two materials — bark and canopy — and
 * `forest.js` binds both by fixed key, so there is no third material to hang a
 * scarlet bromeliad on without a new streamed mesh in every resident sector,
 * which is the one cost this project has decided repeatedly it will not pay.
 *
 * That leaves the two materials there are, and only ONE of them can carry a
 * saturated colour:
 *
 *   THE CANOPY CANNOT. Its instance colour is a green from the species' tint
 *   palette and it MULTIPLIES the texel — the brownea entry in trees.js already
 *   records what that does, and it is worth the arithmetic because it is the
 *   whole reason this file exists. A scarlet of sRGB (0.90, 0.12, 0.08) is
 *   linear (0.787, 0.014, 0.007); a kapok's tint 0x62825a is linear (0.118,
 *   0.223, 0.101); the product is linear (0.093, 0.003, 0.0007), which is sRGB
 *   #560A06. Dark maroon. There is no texel that fixes it, because to come back
 *   out at scarlet the canvas would have to hold values above 1.
 *
 *   THE BARK CAN. `scatter.js` gives a trunk instance `0xffffff` offset in
 *   LIGHTNESS ONLY, -0.13 to +0.06 — a neutral grey between 0.74 and 1.06. So
 *   whatever is painted here arrives on screen as itself, modulated by light.
 *
 * ==== WHY IT IS A NARROW STRIP AND NOT AN ATLAS ============================
 *
 * The obvious layout is a grid of cells with a picture in each, and the
 * variants block in trees.js already explains why an atlas is the wrong shape
 * for a MINIFIED alpha-tested texture: the cells average together in the low
 * mips and bleed into each other at exactly the range where nobody thinks to
 * look. That objection applies here with a twist — the thing that must not be
 * contaminated is the BARK, which is 73% of the frame's triangles.
 *
 * The arithmetic decides the layout. Bark is drawn across the left 90% and the
 * trunk geometry samples only the left 50% of the canvas, so a mip texel would
 * have to be 0.4 of the canvas wide before any strip colour could reach the
 * furthest u a trunk asks for. That is mip level 9, i.e. a two-pixel canvas.
 * It cannot happen, so this needs no hand-built mip chain and no padding, and
 * the bark tile itself is drawn at exactly the size and scale it always was —
 * 256 square, repeating once around the circumference and once per 2.86 m of
 * height. The trunks look identical to before this file existed.
 *
 * WHAT THE 40% GUARD IS FOR, since a trunk never reads past 0.5: the trip warps
 * bark UVs. `living.js` clamps that offset to +-0.09 on bark (three times what
 * a leaf card gets, because bark tiles and has no feathered border to fall off)
 * and the guard has to cover it with room. It also decides `wrapS`: clamped,
 * not repeated, so a NEGATIVE warp at u = 0 lands on the left edge of the bark
 * rather than wrapping round onto the far end of the colour strip.
 *
 * ==== WHY THE STRIP IS FLAT COLOUR AND NOT PICTURES ========================
 *
 * Because the adornments are SOLID GEOMETRY, not cards. That is the decision
 * this whole file turns on and it was made on cost.
 *
 * A cutout card needs `alphaTest`, and setting it on the trunk material sets it
 * for every trunk in the world — which defeats early-Z on the largest opaque
 * layer in the frame, to draw a few hundred bromeliads. The measured split on
 * this build is that trunks are 73% of the triangles and 8% of the marginal
 * cost precisely BECAUSE they are cheap opaque fragments that write depth; the
 * cure for no colour must not be to make the cheapest thing in the frame
 * expensive.
 *
 * So a bromeliad is a rosette of little swept straps and a bracket fungus is a
 * squashed lozenge — opaque, depth-writing, no alpha test, at eight per cent
 * marginal cost like every other tube on a tree. All they need from a texture
 * is a colour to be, which is what these eight bands are.
 */

/** How much of the canvas the trunk geometry's u actually spans. */
export const BARK_U = 0.5;
/** Where the colour strip starts. The gap between is the trip-warp guard. */
const STRIP_X0 = 0.9;
const BANDS = 8;

/**
 * The eight colours, and every one of them is brighter than it "should" be.
 *
 * THE LUMA RULE, applied in the direction it is usually applied against. The
 * understorey of a rainforest is dark — the irradiance reaching a trunk at
 * three metres is a few per cent of the sky — and a Lambert surface MULTIPLIES
 * by that. So a botanically honest deep-red bract, chosen by eye against a
 * white page, arrives on screen as a black smudge, which is indistinguishable
 * from the bark it is supposed to interrupt and is exactly the failure this is
 * fixing. Rec.709 luma is given for each; nothing here is allowed below about
 * 110, which is roughly twice the bark it sits on.
 *
 * These are absolute colours in a texture tagged sRGB, NOT ratios, so the
 * linear-multiplier trap does not apply — the only thing multiplying them is a
 * near-white instance grey and the light.
 */
const PALETTE = [
  // 0 STRAP — bromeliad and fern foliage. Luma 108. The one mid-dark entry,
  //   because it is the thing the bright bracts have to be bright against.
  '#4f7a35',
  // 1 SCARLET — the bract of a flowering tank bromeliad. Luma 116.
  '#e83a1c',
  // 2 ORANGE — Guzmania, and the one that survives deepest shade. Luma 145.
  '#f07a12',
  // 3 MAGENTA — orchid and the bromeliad inflorescence. Luma 106.
  '#d63a8e',
  // 4 CREAM — orchid spray, and the lightest thing in the understorey. Luma 226.
  '#f2e6c8',
  // 5 OCHRE — bracket fungus, the shelf on the lower bole. Luma 148.
  '#c98a3c',
  // 6 LICHEN — the pale crust. Luma 158, and deliberately ABOVE the leaf green
  //   rather than below it: a lichen that is merely a darker green is a stain.
  '#93a85a',
  // 7 GLOW — bioluminescent fungus. Pale sage, and it is the DIFFUSE colour
  //   that is being chosen here rather than the glow: in daylight this is just
  //   a cream bracket on a trunk, and a near-white one read as litter stuck to
  //   the bark. Still eight times the bark's own linear value, which is all the
  //   emissive separation needs. Luma 200.
  '#b9d8c2',
];

export const BAND = {
  strap: 0,
  scarlet: 1,
  orange: 2,
  magenta: 3,
  cream: 4,
  ochre: 5,
  lichen: 6,
  glow: 7,
};

/** The uv a piece of adornment geometry should carry to come out that colour. */
export function bandUV(index) {
  return [STRIP_X0 + (1 - STRIP_X0) * 0.5, (index + 0.5) / BANDS];
}

/**
 * THE GLOW IS AN EMITTER AND MUST NOT BE SHADED AS A REFLECTOR.
 *
 * This project has the bug on record: the fireflies multiplied the dust layer's
 * "how much sun is there to reflect" factor and lost 93% of their brightness,
 * so the one thing in the world that makes its own light was dimmest at night.
 *
 * The mechanism here cannot make that mistake, and it is worth writing down why
 * rather than merely asserting it. Three's Lambert output is
 * `diffuse * irradiance + totalEmissiveRadiance`: the emissive term is ADDED
 * after the lighting and is never multiplied by any light quantity, so a glow
 * declared this way is exactly as bright at midnight as at noon and is simply
 * more visible at midnight because everything beside it is darker. Nothing in
 * `living.js` scales `gl_FragColor` by a daylight term on bark — the only
 * post-multiply in that file is the leaf layer's `aCore` shade, which is
 * `RR_LEAF` only. Fog attenuates it, which is correct: distance is not
 * daylight.
 *
 * WHY THE GLOW BAND HAS TO BE NEAR WHITE. `emissiveFromMap` modulates the
 * emissive colour by the map's own texel, which is the whole trick — it is what
 * makes ONE material emit from the glow band and not from the bark beside it.
 * The separation is therefore just the ratio of the two texels' brightness, so
 * the glow band is near 1.0 and the bark is 0.05-0.10 linear: a factor of ten
 * or more, which puts the bark's share of the emissive below a hundredth and
 * out of sight.
 *
 * IT IS THEREFORE NOT GIVEN TO THE CECROPIA. That species' bark is drawn at 58%
 * lightness — the palest in the world by a wide margin and the entire reason it
 * works as a landmark — which is 0.28 linear, only three times below the glow
 * band rather than ten. A third of the glow smeared over the one tree you
 * navigate by is not a trade worth making, so `trees.js` gives that species no
 * emissive at all and the ratio never has to hold there.
 */

const cache = new Map();

/**
 * `hue`, `sat` and `light` are the species' bark, unchanged from `barkTexture`
 * in textures.js — this reproduces that drawing tile-for-tile rather than
 * importing it, because the tile now has to land in a sub-rect of a wider
 * canvas and the exported function returns a finished texture.
 */
export function trunkAtlas({ key = 'bark', hue = 26, sat = 22, light = 22, seed = 'bark' } = {}) {
  const cacheKey = `trunk:${key}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const TILE = 256;
  const W = TILE * 2;
  const H = TILE;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const rng = makeRng(seed);

  // ---- the bark tile, drawn once and stamped twice ------------------------
  const tile = document.createElement('canvas');
  tile.width = TILE;
  tile.height = TILE;
  const t = tile.getContext('2d');
  t.fillStyle = `hsl(${hue} ${sat}% ${light}%)`;
  t.fillRect(0, 0, TILE, TILE);

  for (let i = 0; i < 190; i++) {
    const x = rng() * TILE;
    const w = rngRange(rng, 1.2, 7);
    const shade = rngRange(rng, 0.45, 1.7);
    t.strokeStyle = `hsla(${hue + rngRange(rng, -6, 8)} ${sat}% ${light * shade}% / ${rngRange(rng, 0.25, 0.8)})`;
    t.lineWidth = w;
    t.beginPath();
    let px = x;
    t.moveTo(px, -4);
    for (let y = 0; y <= TILE + 4; y += 16) {
      px += rngRange(rng, -3.4, 3.4);
      t.lineTo(px, y);
    }
    t.stroke();
  }
  // Horizontal lenticels, so the trunk is not corduroy. Tapered strokes rather
  // than filled rectangles: axis-aligned rectangles on a pale trunk are the
  // most legible possible signature of a generated texture.
  for (let i = 0; i < 70; i++) {
    const y = rng() * TILE;
    const x0 = rng() * TILE;
    const w = rngRange(rng, 5, 26);
    t.strokeStyle = `hsla(${hue - 6} ${sat - 6}% ${light * rngRange(rng, 0.35, 1.4)}% / ${rngRange(rng, 0.18, 0.45)})`;
    t.lineWidth = rngRange(rng, 0.8, 2.4);
    t.beginPath();
    t.moveTo(x0, y);
    t.quadraticCurveTo(x0 + w * 0.5, y + rngRange(rng, -1.6, 1.6), x0 + w, y);
    t.stroke();
  }

  /**
   * ==== LICHEN, WHICH IS THE OTHER HALF OF "EVERY TRUNK IS THE SAME GREY" ===
   *
   * The bark above is one hue with 8% lightness contrast scratched into it, so
   * every trunk in the wood is a single colour with a soft Lambert gradient
   * down it, and the only difference between two species is which single colour.
   * Blotching it costs one loop and no memory, and it is the cheapest thing in
   * this pass that attacks the pole monotony directly.
   *
   * SOFT-EDGED AND LOW-CONTRAST, DELIBERATELY. A hard-edged patch on a tiling
   * texture is a shape you learn, and you then see the same shape on nine
   * thousand trunks. Radial gradients to zero alpha give a mottle with no
   * outline to recognise, and at 0.16 alpha it reads as staining rather than as
   * paint.
   *
   * THE LUMA RULE, again, and in the same direction as the palette above:
   * lichen goes LIGHTER than the bark, never greener-and-darker. The temperate
   * grass note has it exactly — greener by eye means darker every time, and a
   * darker patch on a dark trunk is a hole, not a plant. Both blotch colours
   * here sit above the bark's own lightness.
   */
  for (let i = 0; i < 15; i++) {
    const x = rng() * TILE;
    const y = rng() * TILE;
    const r = rngRange(rng, 9, 34);
    const pale = rng() < 0.55;
    const bh = pale ? 74 : 46;
    const bs = pale ? 16 : 10;
    const bl = Math.min(66, light + rngRange(rng, 8, 20));
    const grad = t.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `hsla(${bh} ${bs}% ${bl}% / 0.1)`);
    grad.addColorStop(0.6, `hsla(${bh} ${bs}% ${bl}% / 0.055)`);
    grad.addColorStop(1, `hsla(${bh} ${bs}% ${bl}% / 0)`);
    t.fillStyle = grad;
    t.beginPath();
    // Squashed in Y for the same reason the shader's fissure domain is: things
    // on a trunk run up it.
    t.ellipse(x, y, r, r * rngRange(rng, 0.5, 0.85), 0, 0, Math.PI * 2);
    t.fill();
  }

  // Stamped at 0 and at TILE, so the bark runs continuously across the guard
  // band and a warped u finds bark rather than an edge. The right-hand stamp is
  // clipped by the strip below.
  g.drawImage(tile, 0, 0);
  g.drawImage(tile, TILE, 0);

  // ---- the colour strip ---------------------------------------------------
  const sx = Math.round(W * STRIP_X0);
  const bandH = H / BANDS;
  for (let i = 0; i < BANDS; i++) {
    g.fillStyle = PALETTE[i];
    g.fillRect(sx, i * bandH, W - sx, bandH);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  // Clamped across, repeating up. See the guard-band note at the top: a warped
  // u below zero must land on bark, and a trunk's v is `running * 0.35` and
  // unbounded, so it has to tile.
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  cache.set(cacheKey, tex);
  return tex;
}
