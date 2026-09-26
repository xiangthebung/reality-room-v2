import * as THREE from 'three';
import { TAU, makeRng, rngRange } from '../core/util.js';
import { currentLand } from './lands/index.js';

/**
 * Procedurally drawn textures.
 *
 * No binary assets anywhere in this project. Partly that keeps the repository a
 * repository, but mostly it is because a generated texture can be *parameterised*
 * — the same leaf routine draws a birch cluster and a pine frond by changing four
 * numbers, and the trip can regenerate a palette without shipping a second atlas.
 *
 * Everything here is cached by key: these are drawn once at load and reused by
 * every instance in the forest.
 */

const cache = new Map();

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

function finish(c, { srgb = true, aniso = 8, wrap = false } = {}) {
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  tex.wrapS = tex.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function memo(key, build) {
  if (!cache.has(key)) cache.set(key, build());
  return cache.get(key);
}

/**
 * DOES THE FOLIAGE IN THIS WORLD HAVE SNOW ON IT.
 *
 * Read through a function rather than latched into a module constant, for the
 * same reason atmosphere.js reads `currentLand()` at build time rather than at
 * import time: the land is decided from the seed prefix before anything is
 * built, but module evaluation order is not something this file gets to have an
 * opinion about, and one property read is not worth a load-order rule.
 *
 * It is the LAND'S OWN `weather` field and not a second switch. taiga.js
 * already declares `weather: 'snow'` and atmosphere.js already turns that into
 * falling snow and a snow palette on the ground; a third place deciding
 * independently what counts as winter is how a world ends up with snow in the
 * air, snow on the floor and green trees, which is exactly the state this
 * function exists to get out of.
 */
function snowLand() {
  return currentLand().weather === 'snow';
}

/**
 * Erase the alpha near the canvas border.
 *
 * EVERY PLANT TEXTURE IN THIS FILE DRAWS PAST ITS OWN EDGE. The leaf scatter
 * puts cluster centres up to 0.44 of the canvas from the middle and then draws a
 * leaf up to another 0.16 beyond that; grass blades bend up to 0.38 sideways
 * from a root already at 0.7; fern fronds lean 0.24 and hang pinnae off the end.
 * Measured, the worst reach is 296 px on a 256 px canvas.
 *
 * The canvas clips them, so the alpha silhouette runs off the side in a
 * perfectly straight line — and because the same texture is on every card in the
 * forest, that straight line is repeated tens of thousands of times. It is the
 * hard-edged rectangular patches that kept showing up in the canopy and the
 * undergrowth, and it is present sober; the trip only made it easier to see.
 *
 * Feathering the alpha to zero inside the border guarantees the silhouette is
 * whatever the plant drew, or nothing. `keepBottom` exists because grass and
 * ferns are rooted at the bottom edge of their card and erasing there would make
 * them float.
 */
function featherEdges(g, w, h, margin, { keepBottom = false } = {}) {
  const previous = g.globalCompositeOperation;
  g.globalCompositeOperation = 'destination-out';
  const bands = [
    [0, 0, margin, 0], // left
    [w, 0, w - margin, 0], // right
    [0, 0, 0, margin], // top
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

/**
 * A cluster of leaves on a transparent card.
 *
 * Canopies in this forest are built from a few dozen of these quads, jittered in
 * orientation. The reason a card beats a mesh blob is silhouette: the alpha edge
 * gives you hundreds of individual leaf tips against the sky for the cost of two
 * triangles, and a forest is mostly silhouette.
 *
 * Each leaf is drawn as two quadratic curves meeting at a tip, with a vein, and
 * with lighting faked as a gradient from the stem outward. The leaves near the
 * card's edge are drawn smaller and more transparent so the cluster fades into
 * the next one instead of ending in a visible rectangle.
 */
export function leafCluster({
  key,
  hue = 96,
  sat = 42,
  light = 34,
  count = 46,
  size = 256,
  length = 0.19,
  width = 0.42,
  needle = false,
  seed = 'leaf',
  adorn = null,
} = {}) {
  const snowy = snowLand();
  // The land goes in the KEY as well as in the drawing. A land is fixed for the
  // life of a page, so today the two variants can never both be wanted — but a
  // memo whose output depends on something outside its key is a cache that
  // silently serves the wrong picture the first time that stops being true, and
  // the cost of not having that bug is nine characters.
  return memo(`leaf:${key ?? seed}${snowy ? ':snow' : ''}`, () => {
    const c = canvas(size);
    const g = c.getContext('2d');
    const rng = makeRng(seed);
    g.clearRect(0, 0, size, size);

    const drawLeaf = (cx, cy, len, ang, scale, alpha, shade) => {
      g.save();
      g.translate(cx, cy);
      g.rotate(ang);
      g.globalAlpha = alpha;
      const w = len * width * scale;
      const l = len * scale;
      const grad = g.createLinearGradient(0, 0, 0, -l);
      const l1 = Math.round(light * shade);
      const l2 = Math.round(light * shade * 1.55 + 6);
      grad.addColorStop(0, `hsl(${hue - 6} ${sat}% ${l1}%)`);
      grad.addColorStop(0.55, `hsl(${hue} ${sat + 6}% ${l2}%)`);
      grad.addColorStop(1, `hsl(${hue + 10} ${sat - 4}% ${Math.round(l2 * 0.82)}%)`);
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(-w, -l * 0.45, 0, -l);
      g.quadraticCurveTo(w, -l * 0.45, 0, 0);
      g.closePath();
      g.fill();
      // Midrib. One pixel of darker line per leaf reads as structure at a
      // distance and costs nothing.
      g.strokeStyle = `hsla(${hue - 14} ${sat}% ${Math.round(l1 * 0.7)}% / 0.5)`;
      g.lineWidth = Math.max(0.6, l * 0.03);
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(0, -l * 0.92);
      g.stroke();
      g.restore();
    };

    /**
     * A CONIFER SPRIG: A TWIG CARRYING A COMB OF SHORT NEEDLES.
     *
     * Pines used to be drawn with the same routine as broadleaves, just with a
     * narrow triangle instead of a leaf shape — which made each "needle" as long
     * as a whole birch leaf. On a three-metre card that is a needle a metre long
     * and fourteen centimetres wide, and forty of them radiating from a point is
     * a starburst of straight black slashes: silhouetted against the sky it read
     * as broken glass in the canopy, which is exactly the artefact class this
     * project keeps having to hunt down.
     *
     * A real needle is a few centimetres, and it never appears alone — it comes
     * in a dense comb along a shoot. So: draw the shoot, then comb it. The
     * individual marks are then small enough that no single one can read as a
     * line, and the thing they collectively make is a soft feathered spray,
     * which is what a conifer actually looks like from four metres away.
     */
    const drawSprig = (cx, cy, len, ang, alpha, shade) => {
      g.save();
      g.translate(cx, cy);
      g.rotate(ang);
      g.globalAlpha = alpha;
      g.lineCap = 'round';
      const l1 = Math.round(Math.min(62, light * shade));
      const l2 = Math.round(Math.min(74, light * shade * 1.5 + 8));

      /**
       * THE SHOOT BOWS AND THE NEEDLES ARE JITTERED, AND BOTH ARE REQUIRED.
       *
       * A straight shoot combed at even intervals with alternating sides draws a
       * HERRINGBONE — a perfectly regular chevron running the length of every
       * sprig. Swapping metre-long spikes for a repeating zigzag is not progress;
       * it is the same failure at a smaller scale, and a canopy full of chevrons
       * is if anything easier to spot than one full of spines because the eye is
       * built to find periodicity.
       *
       * So the shoot is a parabola, the needles land at jittered positions along
       * it, and each one picks its own side rather than alternating.
       */
      const bow = rngRange(rng, -0.3, 0.3);
      const sx = (t) => bow * len * t * t;
      const sy = (t) => -len * t;

      /**
       * The shoot itself. Thin and dull — it is a support, not a feature.
       *
       * TRIED AND REVERTED: 2.2 px and opaque, on the theory that a 1.4 px line
       * at 0.8 alpha has almost no core left after alphaTest 0.42 and that the
       * one mark running the whole length of every sprig ought to survive it.
       * It is worth exactly nothing — 20.4% of texels either way, to the tenth,
       * at every sprig count tested — because the needles are combed off the
       * shoot at a 1.45 px pitch and their roots already cover the line they
       * grow out of. All a thicker shoot buys is a fatter twig.
       */
      g.strokeStyle = `hsla(${hue - 30} ${Math.round(sat * 0.5)}% ${Math.round(l1 * 0.75)}% / 0.8)`;
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(0, 0);
      for (let k = 1; k <= 6; k++) g.lineTo(sx(k / 6), sy(k / 6));
      g.stroke();

      /**
       * A DENSER COMB, AND THE DENSITY IS THE POINT.
       *
       * Measured, a pine card was passing alphaTest on 16.5% of its texels —
       * the thinnest canopy of the four species by a third, on the largest crown
       * in the forest, with every one of its twenty-four boughs terminal and
       * carrying seven cards. Roughly one optical depth: a ray fired into a pine
       * crown came out the other side about half the time, and what you saw
       * through it was sky.
       *
       * The three numbers below are the whole of the fix on the texture side and
       * none of them costs a pixel at run time — the card is the same two
       * triangles either way, and a fragment that discards on alphaTest and a
       * fragment that shades cost about the same. So: needles every 1.45 px of
       * shoot instead of every 2.1, a sixth longer, and half a pixel thicker.
       *
       * PITCH FIRST, THICKNESS LAST, and that ordering is deliberate. Doubling
       * the width of a needle doubles its coverage too, but it also doubles the
       * size of the smallest mark on the card, and the note above is emphatic
       * about where that ends: the whole reason for the comb is that no single
       * stroke is allowed to be legible as a line. Packing more small marks in
       * keeps the spray a spray. 3.0 px on a 512 card that is three metres
       * across is about 1.8 cm, which is fat for a needle and reads correctly at
       * the two metres you ever get to a conifer here.
       */
      const n = Math.max(9, Math.round(len / 1.45));
      const needle = size * 0.03;
      for (let i = 0; i < n; i++) {
        const t = Math.min(1, ((i + rngRange(rng, -0.45, 0.45)) / n) * 0.94 + 0.06);
        const side = rng() < 0.5 ? -1 : 1;
        // Needles shorten toward the tip, so the sprig tapers to a point rather
        // than ending in a chisel.
        const nl = needle * (1.2 - t * 0.6) * rngRange(rng, 0.7, 1.45);
        const spread = rngRange(rng, 0.35, 1.15);
        g.strokeStyle = `hsl(${hue + side * 6} ${sat + 4}% ${rng() < 0.34 ? l1 : l2}%)`;
        // Never under about 1.7: alphaTest is 0.42, and a stroke thinner than
        // this is all antialiasing and no core, so it fails the test and the
        // spray comes out patchy.
        g.lineWidth = rngRange(rng, 2.1, 3.0);
        g.beginPath();
        g.moveTo(sx(t), sy(t));
        g.lineTo(sx(t) + side * nl * Math.sin(spread), sy(t) - nl * Math.cos(spread));
        g.stroke();
      }
      g.restore();
    };

    /**
     * ==== FLOWERS AND FRUIT, PAINTED ONTO THE CARD THAT IS ALREADY THERE ====
     *
     * A tree that carries only leaves is a tree with one idea in it, and the
     * request was for blossom and fruit. The perf-correct place to put them is
     * HERE, in the canvas, rather than on quads of their own — the frame is
     * fill-bound sober and vertex-bound on a trip, a card is four vertices
     * whatever is printed on it, and this project has the measurement: raising
     * a leaf texture's opaque coverage from 21% to 41% with the card counts held
     * fixed took a test station from 3.02 ms to 2.34 ms, because an alpha-test
     * discard defeats early-Z and an opaque texel writes depth and occludes the
     * trunk behind it. A truss of berries is coverage. It pays for itself. A
     * truss of berries on its own quad is 1.8 M extra vertices and does not.
     *
     *
     * DRAWN AT THE SAME EXAGGERATION AS THE LEAVES — which is not a compromise
     * with realism, it is the only scale that is consistent with the card.
     *
     * A card is about three metres across and 512 texels, so one texel is 6 mm
     * and a rowan berry at life size is one and a third texels: invisible at any
     * range, and gone entirely at the first mip. But the LEAVES on the same card
     * are already drawn at roughly six times life — `length: 0.19` on the oak is
     * 97 texels, i.e. a sixty-centimetre oak leaf — because a card stands in for
     * a whole clump of foliage rather than for one twig. So a truss drawn at
     * about the size of one of those leaves is not an exaggeration RELATIVE TO
     * ITS NEIGHBOURS; it is the same one, and it is the only choice that keeps
     * the fruit and the foliage looking like they grew on the same tree.
     *
     * Checked in the frame rather than argued: at `span: 0.6` a truss is about
     * 100 px across at five metres and 20 px at thirty, which are the two ranges
     * the brief asked to be legible at.
     *
     *
     * EVERY ROUTINE DRAWS INSIDE A CIRCLE OF RADIUS R ABOUT ITS OWN ORIGIN, AND
     * THAT IS A CONTRACT, NOT A HABIT.
     *
     * It is what lets the placement loop below bound the scatter exactly, the
     * same way the leaf scatter is bounded — see the LIMIT block. Anything drawn
     * past its own R lands in the feathered border, where the canvas cuts it off
     * in a dead straight line on every card of every tree of that archetype.
     * That is the artefact class this whole file exists to prevent, and it would
     * be far worse here than it is for leaves: a straight green edge in a green
     * canopy is a smudge, and a straight scarlet edge is a rectangle.
     *
     * The margins are worked out per routine and written down beside it. None of
     * them is above 0.97 R.
     */
    const aHue = adorn?.hue ?? 0;
    const aSat = adorn?.sat ?? 70;
    const aLight = adorn?.light ?? 45;

    /**
     * A corymb of small five-petalled flowers — the rowan's, and the single
     * most visible thing that can be added to a green wood.
     *
     * FIVE SEPARATE PETAL DISCS, NOT ONE ROSETTE PATH. The notch between two
     * petals is the only mark that says "flower" rather than "blob" once the
     * whole head is twenty pixels across, and a path with five lobes loses those
     * notches to antialiasing the moment it is minified. Overlapping discs keep
     * a hard concave junction at every join, which survives the mip chain a long
     * way further down.
     *
     * The yellow eye is two texels and is the mark the eye finds first. Without
     * it a white corymb reads as a gap in the canopy, which is precisely the
     * wrong thing for it to read as.
     *
     * Reach: floret centre 0.60 R + petal offset 0.187 R + petal radius 0.144 R
     * = 0.93 R.
     */
    const drawBlossom = (R) => {
      const florets = Math.max(6, Math.round(R * 0.42));
      for (let i = 0; i < florets; i++) {
        const a = rng() * TAU;
        const rr = Math.pow(rng(), 0.55) * R * 0.6;
        const fx = Math.cos(a) * rr;
        const fy = Math.sin(a) * rr * 0.86;
        const pr = R * rngRange(rng, 0.17, 0.24);
        const spin = rng() * TAU;
        for (let p = 0; p < 5; p++) {
          const pa = spin + (p / 5) * TAU;
          g.fillStyle = `hsl(${aHue + rngRange(rng, -7, 7)} ${aSat}% ${Math.min(96, aLight * rngRange(rng, 0.9, 1.08))}%)`;
          g.beginPath();
          g.ellipse(
            fx + Math.cos(pa) * pr * 0.78,
            fy + Math.sin(pa) * pr * 0.78,
            pr * 0.6,
            pr * 0.46,
            pa,
            0,
            TAU
          );
          g.fill();
        }
        g.fillStyle = `hsl(46 ${Math.min(92, aSat + 46)}% ${Math.round(Math.min(70, aLight * 0.72))}%)`;
        g.beginPath();
        g.arc(fx, fy, pr * 0.33, 0, TAU);
        g.fill();
      }
    };

    /**
     * A truss of berries.
     *
     * Each one gets a radial gradient with the highlight off-centre, and that
     * one detail is the whole difference between fruit and a red dot: a berry is
     * a sphere, so it has a lit side and a terminator, and a flat disc of colour
     * repeated thirty times reads as spots of paint on the leaves. The gradient
     * costs nothing at run time — this is drawn once, at load.
     *
     * Reach: 0.78 R + 0.19 R = 0.97 R, the widest of the five.
     */
    const drawBerries = (R) => {
      const n = Math.max(9, Math.round(R * 0.7));
      for (let i = 0; i < n; i++) {
        const a = rng() * TAU;
        const rr = Math.pow(rng(), 0.5) * R * 0.78;
        const bx = Math.cos(a) * rr;
        const by = Math.sin(a) * rr * 0.82;
        const br = R * rngRange(rng, 0.13, 0.19);
        const grad = g.createRadialGradient(bx - br * 0.34, by - br * 0.38, br * 0.05, bx, by, br);
        grad.addColorStop(0, `hsl(${aHue + 12} ${aSat}% ${Math.min(82, aLight * 1.75)}%)`);
        grad.addColorStop(0.55, `hsl(${aHue} ${aSat}% ${aLight}%)`);
        grad.addColorStop(1, `hsl(${aHue - 12} ${aSat}% ${Math.round(aLight * 0.5)}%)`);
        g.fillStyle = grad;
        g.beginPath();
        g.arc(bx, by, br, 0, TAU);
        g.fill();
      }
    };

    /**
     * Acorns: a nut in a cup, two or three together.
     *
     * The cup is drawn as a separate darker dome over the top of the nut rather
     * than as part of one silhouette. Two tones stacked is what makes a 25 px
     * shape read as an acorn instead of as a bud, and it is the cheapest
     * possible way to say it.
     *
     * Reach: cluster offset 0.34 R + half-height 0.372 R = 0.71 R.
     */
    const drawAcorns = (R) => {
      const n = 2 + (rng() < 0.5 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + rng();
        const ax = Math.cos(a) * R * 0.34;
        const ay = Math.sin(a) * R * 0.34 * 0.7;
        const w = R * rngRange(rng, 0.3, 0.4);
        const h = w * 1.5;
        g.save();
        g.translate(ax, ay);
        g.rotate(rngRange(rng, -0.5, 0.5));
        const grad = g.createLinearGradient(-w * 0.5, -h * 0.4, w * 0.5, h * 0.4);
        grad.addColorStop(0, `hsl(${aHue + 8} ${aSat}% ${Math.min(74, aLight * 1.5)}%)`);
        grad.addColorStop(1, `hsl(${aHue - 6} ${aSat}% ${Math.round(aLight * 0.58)}%)`);
        g.fillStyle = grad;
        g.beginPath();
        g.ellipse(0, h * 0.12, w * 0.5, h * 0.5, 0, 0, TAU);
        g.fill();
        g.fillStyle = `hsl(${aHue - 14} ${Math.round(aSat * 0.8)}% ${Math.round(aLight * 0.44)}%)`;
        g.beginPath();
        g.ellipse(0, -h * 0.24, w * 0.56, h * 0.3, 0, 0, TAU);
        g.fill();
        g.restore();
      }
    };

    /**
     * A cone.
     *
     * The cross-hatch of scales is not decoration. A plain brown ovoid in a
     * conifer is a bud or a gall; the scale rows are the only thing that makes
     * it a cone at the twenty pixels it is usually seen at, and they are six
     * strokes.
     *
     * Reach: the ellipse's own semi-major axis, 0.80 R, plus half a stroke.
     */
    const drawCone = (R) => {
      const L = R * rngRange(rng, 1.25, 1.6);
      const W = L * rngRange(rng, 0.3, 0.38);
      g.rotate(rngRange(rng, -0.45, 0.45));
      const grad = g.createLinearGradient(-W * 0.5, 0, W * 0.5, 0);
      grad.addColorStop(0, `hsl(${aHue} ${aSat}% ${Math.round(aLight * 0.55)}%)`);
      grad.addColorStop(0.42, `hsl(${aHue + 6} ${aSat}% ${Math.min(68, aLight * 1.45)}%)`);
      grad.addColorStop(1, `hsl(${aHue - 8} ${aSat}% ${Math.round(aLight * 0.42)}%)`);
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(0, 0, W * 0.5, L * 0.5, 0, 0, TAU);
      g.fill();
      g.strokeStyle = `hsla(${aHue - 10} ${aSat}% ${Math.round(aLight * 0.3)}% / 0.8)`;
      g.lineWidth = Math.max(0.9, R * 0.04);
      g.lineCap = 'butt';
      for (let r = 1; r < 6; r++) {
        const y = -L * 0.5 + L * (r / 6);
        const hw = W * 0.5 * Math.sqrt(Math.max(0, 1 - Math.pow(y / (L * 0.5), 2)));
        g.beginPath();
        g.moveTo(-hw, y - hw * 0.28);
        g.quadraticCurveTo(0, y + hw * 0.32, hw, y - hw * 0.28);
        g.stroke();
      }
    };

    /**
     * A catkin: a hanging spindle of beads.
     *
     * FATTEST IN THE MIDDLE AND TAPERED AT BOTH ENDS. A uniform sausage is a
     * caterpillar, and a canopy with forty caterpillars per card in it is a
     * worse problem than a canopy with nothing in it. The bead pitch is fine
     * enough that no single circle is legible on its own, which is the same rule
     * the conifer comb above obeys and for the same reason.
     *
     * L is deliberately shorter than the cone's. Reach is hypot(0.28 R sway +
     * 0.15 R bead, 0.70 R half-length + 0.15 R bead) = 0.95 R, and at the 1.75
     * length this originally had it was 1.28 R — over the edge, into the
     * feather, straight line on every card. The bound is the reason for the
     * number.
     */
    const drawCatkin = (R) => {
      const L = R * rngRange(rng, 1.1, 1.4);
      const W = R * rngRange(rng, 0.2, 0.3);
      const sway = rngRange(rng, -0.2, 0.2);
      g.rotate(rngRange(rng, -0.5, 0.5));
      const beads = Math.max(7, Math.round(L / Math.max(1.4, W * 0.5)));
      for (let i = 0; i < beads; i++) {
        const t = i / (beads - 1);
        const y = -L * 0.5 + L * t;
        const x = sway * L * t * t;
        const w = W * (0.42 + Math.sin(Math.min(1, t * 1.04) * Math.PI) * 0.64);
        g.fillStyle = `hsl(${aHue + rngRange(rng, -9, 9)} ${aSat}% ${Math.round(Math.min(88, aLight * rngRange(rng, 0.74, 1.34)))}%)`;
        g.beginPath();
        g.arc(x, y, w * 0.5, 0, TAU);
        g.fill();
      }
    };

    const ADORN = {
      blossom: drawBlossom,
      berry: drawBerries,
      acorn: drawAcorns,
      cone: drawCone,
      catkin: drawCatkin,
    };

    const mid = size / 2;
    const base = size * length;
    /**
     * BOUND THE DRAWING, DO NOT CROP IT AFTERWARDS.
     *
     * The scatter used to put a leaf centre up to 0.44 of the canvas from the
     * middle and then draw a leaf up to another 0.16 beyond it — a reach of 296
     * px on a 256 px canvas. The canvas clipped the overflow, so the alpha
     * silhouette ended in a dead straight line, on every card, on every tree in
     * the forest. Those were the hard rectangular patches in the canopy.
     *
     * Feathering the alpha afterwards does not fix it: thresholding a linear
     * gradient laid over opaque content still yields a straight contour, just
     * moved inwards. The leaf has to be placed where it fits in the first place,
     * so the radius available to each leaf is whatever is left after its own
     * length is accounted for.
     */
    const LIMIT = size * 0.46;
    if (needle) {
      // Sprigs are cheaper per unit of coverage than leaves, so there are more
      // of them; a thin conifer card reads as a dead branch.
      const sprigs = Math.round(count * 1.6);
      for (let i = 0; i < sprigs; i++) {
        const len = base * rngRange(rng, 0.55, 1.1);
        /**
         * The needles overhang the shoot's tip, so the bound has to allow for
         * them as well as for the shoot. Same rule as below: place it where it
         * fits rather than letting the canvas crop it into a straight edge.
         *
         * 0.052 is not a margin, it is the exact worst case and it moves when
         * the comb does: `needle * 1.2 * 1.45` with needle at `size * 0.03`.
         * It was 0.045 against a needle of 0.026 — right then, and quietly two
         * thirds of a needle short the moment the comb was made denser.
         */
        const rMax = Math.max(0, LIMIT - len - size * 0.052);
        const r = Math.pow(rng(), 0.6) * rMax;
        const a = rng() * TAU;
        const fade = 1 - Math.pow(r / LIMIT, 1.7);
        drawSprig(
          mid + Math.cos(a) * r,
          mid + Math.sin(a) * r * 0.82,
          len,
          a + rngRange(rng, -0.9, 0.9),
          Math.max(0.2, fade),
          rngRange(rng, 0.68, 1.25)
        );
      }
    } else {
      for (let i = 0; i < count; i++) {
        const fadeGuess = rng();
        const scale = rngRange(rng, 0.62, 1.25) * (0.55 + fadeGuess * 0.6);
        const reach = base * scale;
        const rMax = Math.max(0, LIMIT - reach);
        /**
         * Polar scatter biased to the middle, so the cluster has a dense heart
         * and a ragged edge — WHICH IS NOT WHAT THE EXPONENT USED TO DO.
         *
         * It was 0.62, and for u uniform on 0..1, u^0.62 pulls values UP: the
         * median stem lands at 0.65 of the available radius, which is further
         * out than even a uniform-area disc (u^0.5) would put it. The comment
         * described the intent and the code did the opposite, and a leaf is
         * drawn from its stem OUTWARD, so the middle of the card was left empty.
         * Dumping the four alpha-tested silhouettes onto a magenta ground showed
         * it plainly: birch and oak came out as rings with a bare hole in the
         * centre, on every card, on every tree.
         *
         * It was survivable at the old leaf sizes and it is not at these — a
         * fatter leaf needs a smaller rMax, so the hole grows as the coverage
         * does, and a donut repeated tens of thousands of times through the
         * canopy is precisely the class of motif this file exists to keep out.
         * Above 1 the exponent is centre-biased against area, which is what the
         * comment always claimed and what a cluster of leaves on a twig is.
         */
        const r = Math.pow(rng(), 1.15) * rMax;
        const a = rng() * TAU;
        const cx = mid + Math.cos(a) * r;
        const cy = mid + Math.sin(a) * r * 0.82;
        const fade = 1 - Math.pow(r / LIMIT, 1.7);
        // Leaves point outward from the stem, roughly.
        const ang = a + Math.PI / 2 + rngRange(rng, -1.1, 1.1);
        drawLeaf(cx, cy, base, ang, scale, Math.max(0, fade) * rngRange(rng, 0.72, 1), rngRange(rng, 0.62, 1.3));
      }
    }
    /**
     * The trusses go on LAST, over the leaves, and that ordering is the whole
     * of whether they are visible.
     *
     * Blossom drawn first and then covered by a hundred and eighty leaves is
     * blossom you can see about a fifth of. Fruit hangs in front of the foliage
     * in life too — it is on the outside of the twig, which is the point of
     * fruit — so painting it over the top is both the cheap answer and the
     * correct one.
     *
     * The scatter is the leaves' scatter with two numbers changed. The exponent
     * is 0.85 rather than 1.15, i.e. biased OUTWARD instead of inward, because a
     * truss buried in the heart of the clump is a truss nobody sees; and the
     * fade at the rim has a floor of 0.42 rather than 0, because these are
     * fifteen marks on a card carrying two hundred and a truss that dissolves is
     * simply absent. `alphaTest` is 0.42, so that floor is also the point below
     * which a texel would vanish outright rather than blend.
     */
    if (adorn && ADORN[adorn.kind]) {
      const draw = ADORN[adorn.kind];
      const R0 = base * (adorn.span ?? 0.6) * 0.5;
      for (let i = 0; i < (adorn.count ?? 6); i++) {
        const R = R0 * rngRange(rng, 0.78, 1.24);
        // Exactly the leaves' rule: placed where it fits, never cropped after.
        // Every routine above draws inside its own R, so this bound is tight.
        const rMax = Math.max(0, LIMIT - R);
        const r = Math.pow(rng(), 0.85) * rMax;
        const a = rng() * TAU;
        const fade = 1 - Math.pow(r / LIMIT, 1.7);
        g.save();
        g.translate(mid + Math.cos(a) * r, mid + Math.sin(a) * r * 0.82);
        g.globalAlpha = Math.max(0.42, fade);
        draw(R);
        g.restore();
      }
    }

    /**
     * ==== SNOW ON THE BRANCHES, AND IT MAY NOT COST ONE CARD ================
     *
     * The winter wood had snow on the ground, snow in the air and none on the
     * trees, which is the first thing anybody looking at a photograph of it
     * says. The tempting fixes are all card fixes — a white shell over each
     * crown, a second layer of foliage in white, a capped quad on every bough —
     * and every one of them is forbidden by the same measurement this file
     * keeps quoting: A SOLID CANOPY IS CHEAPER THAN A SEE-THROUGH ONE, DENSER
     * TEXTURES ARE FREE, MORE CARDS ARE NOT. Raising a leaf texture's opaque
     * coverage from 21% to 41% with card counts held fixed took a station from
     * 3.02 ms to 2.34 ms; adding cards goes the other way and takes the shadow
     * pass with it, which is already 84% alpha-tested leaf fill.
     *
     * So this is paint on the canvas that is already being drawn, and it is
     * `source-atop`, which is the whole trick. That operator composites the new
     * paint ONLY where the destination is already opaque AND LEAVES THE
     * DESTINATION ALPHA EXACTLY AS IT WAS. Not approximately: the alpha channel
     * is not a term in the source-atop formula at all except as the mask. So
     * the silhouette is bit-identical, the `alphaTest` discard rate does not
     * move by one texel, the shadow pass does not notice, and `featherEdges`
     * below still has the same job to do. The entire cost of snow on every
     * conifer in the world is one gradient fill and sixteen radial blobs, once,
     * at load, on a canvas that already exists.
     *
     * TWO MARKS, BECAUSE ONE IS A GRADIENT AND A GRADIENT IS NOT SNOW.
     *
     *   THE LOAD is the linear wash: pale at the top of the card, gone by 82%
     *   of the way down. Snow settles on upward-facing surfaces and a canopy
     *   card stands in for a clump of foliage seen from the side, so "up" on
     *   the card is "up" in the world. On its own it reads as a lighting
     *   gradient rather than as a substance.
     *
     *   THE CLUMPS are what make it snow. Sixteen soft discs biased into the
     *   top two thirds, at radii from 4% to 13% of the card, so the load has
     *   lumps sitting in it and its lower boundary is ragged instead of level.
     *   A conifer holds snow in pads where a spray forks and drops it
     *   everywhere else, and a ragged edge is the only cue that separates the
     *   two readings.
     *
     * HEAVIER ON NEEDLES. A needle spray is a horizontal shelf and a broadleaf
     * clump is not; 0.82 against 0.58 at the top of the wash is that, fitted by
     * eye rather than measured. Both are under 1 so the darkest needle marks
     * still show through as texture rather than being painted out — a card that
     * goes uniformly white is a white card, and a canopy of those is fog.
     *
     * IT IS DELIBERATELY NOT KEYED TO THE HOUR OR THE WEATHER. Falling snow
     * comes and goes on `precipAt`; snow LYING on a branch is the standing
     * condition of the land, the same argument taiga.js makes for its floor
     * palette. Making it dynamic would mean regenerating this canvas at run
     * time, which is the one thing a load-time texture may never do.
     */
    if (snowy) {
      const previous = g.globalCompositeOperation;
      g.globalCompositeOperation = 'source-atop';
      g.globalAlpha = 1;
      const top = needle ? 0.82 : 0.58;
      const load = g.createLinearGradient(0, 0, 0, size * 0.82);
      load.addColorStop(0, `rgba(238, 245, 253, ${top})`);
      load.addColorStop(0.45, `rgba(228, 238, 250, ${top * 0.40})`);
      load.addColorStop(1, 'rgba(216, 230, 246, 0)');
      g.fillStyle = load;
      g.fillRect(0, 0, size, size);
      for (let i = 0; i < 16; i++) {
        // Biased upward by squaring a uniform: y = size * u^2 * 0.7 puts two
        // thirds of the pads in the top third of the card, which is where the
        // wash they are meant to be lumps in actually is.
        const bx = rng() * size;
        const by = rng() * rng() * size * 0.7;
        const br = size * rngRange(rng, 0.04, 0.13);
        const pad = g.createRadialGradient(bx, by, 0, bx, by, br);
        pad.addColorStop(0, `rgba(246, 250, 255, ${top * 0.9})`);
        pad.addColorStop(0.6, `rgba(234, 243, 253, ${top * 0.45})`);
        pad.addColorStop(1, 'rgba(228, 238, 250, 0)');
        g.fillStyle = pad;
        g.beginPath();
        g.arc(bx, by, br, 0, TAU);
        g.fill();
      }
      g.globalCompositeOperation = previous;
    }

    // Belt and braces: the bound above is exact, this only ever touches pixels
    // the scatter already left empty.
    featherEdges(g, size, size, size * 0.06);
    return finish(c);
  });
}

/**
 * A tuft of the ground layer, on a transparent card.
 *
 * THE BLADES MUST NOT MEET AT THE BOTTOM. The first version drew each blade as a
 * quad whose base spanned a tenth of the card's width, all of them starting on
 * the bottom edge — so the lowest strip of the texture was a solid, opaque, dark
 * green bar. Instanced twenty thousand times, that bar appeared as a hard dark
 * rectangle sitting under every single tuft in the forest, and it read as a
 * shadow bug rather than as grass.
 *
 * So each blade is a spindle: a point at the root, widest partway up, a point at
 * the tip.
 *
 *
 * ==== IT IS NOT GRASS ANY MORE, AND THAT IS THE POINT =====================
 *
 * This is the commonest card in the world — twenty thousand of them inside
 * seventy metres — so whatever it draws is what the floor of this forest IS.
 * It drew six narrow spindles with a straw-bleached tip, which is a tuft of
 * meadow grass, and the report was that parts of the wood do not look like a
 * rainforest. This layer is the largest single reason: THERE IS ALMOST NO GRASS
 * ON A RAINFOREST FLOOR. Grass is a full-sun plant and the floor of a closed
 * tropical forest gets one or two per cent of the light that lands on the
 * canopy. What grows down there instead is broad and soft — palm and Calathea
 * seedlings, aroids, Selaginella, the odd sprouting nut — because in that little
 * light the only strategy that works is a large, thin, cheap collector.
 *
 * SO THE BLADES BECAME LEAVES. Seven of them rather than six, three times as
 * wide, with a pale midrib and a blunt tip instead of a wire taper.
 * That is the whole edit. The card is the same 128², the same count, the same
 * geometry, the same draw call and the same fill — a wider mark on the same
 * canvas costs nothing to rasterise and, per the note at the head of the
 * undergrowth textures, an opaque texel is cheaper than the discard it
 * replaces.
 *
 * AND THE TIP STOPPED BEING BLEACHED. The old gradient ran to 1.75× lightness
 * at the top of every blade — hay in July, and the most temperate thing in the
 * frame. This runs the other way: darkest at the margins, slightly lifted along
 * the midrib, which is how a thin shade leaf actually sits against the light.
 */
export function herbTuft({ key = 'herb', hue = 128, sat = 40, light = 30, seed = 'blade' } = {}) {
  return memo(`blade:${key}`, () => {
    const size = 128;
    const c = canvas(size);
    const g = c.getContext('2d');
    const rng = makeRng(seed);
    // The tip must land inside the card. A leaf that ran off the side was
    // clipped into a straight vertical cut, on every tuft in the forest.
    const EDGE = size * 0.07;
    for (let i = 0; i < 7; i++) {
      const root = size * rngRange(rng, 0.2, 0.8);
      const w = size * rngRange(rng, 0.11, 0.18);
      /**
       * SPLAYED, not gathered. At a reach of 0.34 all five leaves left the same
       * narrow column and the tuft filled about half its card, leaving a hard
       * empty margin down one side — which on a 128² texture instanced twenty
       * thousand times is a fifth of the layer's rasterised area spent on
       * nothing. A ground rosette lies OUT, nearly flat, because that is how a
       * plant in one per cent of full sun presents the most area to the sky.
       */
      const reach = size * 0.46;
      const bend = Math.max(
        EDGE + w - root,
        Math.min(size - EDGE - w - root, rngRange(rng, -reach, reach))
      );
      const top = size * rngRange(rng, 0.08, 0.44);
      /**
       * The belly sits HIGH — two thirds of the way to the tip rather than a
       * third. That is the difference between a spindle and a leaf: a blade of
       * grass is widest near its base and tapers for the rest of its length, and
       * a shade leaf holds its width almost to the end and then closes quickly.
       * Same four control points, and it is the whole silhouette.
       */
      const belly = size - (size - top) * 0.62;
      const grad = g.createLinearGradient(0, size, 0, top);
      grad.addColorStop(0, `hsl(${hue - 6} ${sat}% ${light * 0.7}%)`);
      grad.addColorStop(0.45, `hsl(${hue} ${sat + 4}% ${light * 1.15}%)`);
      grad.addColorStop(1, `hsl(${hue + 6} ${sat + 6}% ${light * 0.95}%)`);
      /**
       * A BLUNT TIP, which is the last thing separating this from grass.
       *
       * Two quadratics that meet at one point make a needle however wide the
       * belly is, and a needle is a blade whatever colour it is drawn. Ending
       * the two curves a short way APART and joining them across is four extra
       * characters of path and it is what turns the silhouette into a leaf: a
       * shade leaf is elliptic and closes over a centimetre or two, it does not
       * come to a spine.
       */
      const nib = w * 0.22;
      g.fillStyle = grad;
      g.beginPath();
      // Up the left edge: root point, out to the belly, in to the tip.
      g.moveTo(root, size);
      g.quadraticCurveTo(root - w, belly, root + bend - nib, top);
      g.lineTo(root + bend + nib, top);
      // Back down the right edge.
      g.quadraticCurveTo(root + w, belly, root, size);
      g.closePath();
      g.fill();

      // The midrib, which is what tells a two-pixel mark it is a leaf and not a
      // blade. Lighter than the lamina by half a stop and no more — a bright
      // line down every leaf in the wood would read as a specular seam.
      g.strokeStyle = `hsl(${hue - 4} ${sat - 10}% ${Math.min(60, light * 1.5)}%)`;
      g.lineWidth = Math.max(1, size * 0.008);
      g.beginPath();
      g.moveTo(root, size);
      g.quadraticCurveTo(root + bend * 0.42, belly, root + bend, top);
      g.stroke();
    }
    featherEdges(g, size, size, size * 0.05, { keepBottom: true });
    return finish(c);
  });
}

/** A fern frond: a stem with paired pinnae that shorten toward the tip. */
export function fernFrond({ key = 'fern', hue = 104, sat = 38, light = 26, seed = 'fern' } = {}) {
  return memo(`fern:${key}`, () => {
    const size = 256;
    const c = canvas(size);
    const g = c.getContext('2d');
    const rng = makeRng(seed);

    /**
     * The whole frond, pinnae included, must fit inside the card.
     *
     * A fern is the largest single card in the undergrowth and it is often right
     * next to the camera, so its silhouette is the one most likely to be read in
     * detail — and a frond clipped by the canvas gave it a dead straight
     * vertical edge and a flat top, which is what made it look like a cut-out
     * rather than a plant.
     */
    const PINNA = size * 0.12;
    const MARGIN = PINNA + size * 0.04;
    const clampX = (x) => Math.max(MARGIN, Math.min(size - MARGIN, x));

    for (let f = 0; f < 3; f++) {
      const rootX = clampX(size * rngRange(rng, 0.32, 0.68));
      const tipX = clampX(rootX + rngRange(rng, -0.22, 0.22) * size);
      const tipY = size * rngRange(rng, 0.1, 0.24);
      // More pinnae, each smaller: the silhouette needs to be fine enough to
      // read as a frond rather than as a row of teeth.
      const steps = 30;
      g.strokeStyle = `hsl(${hue - 12} ${sat}% ${light * 0.8}%)`;
      g.lineWidth = 2.2;
      g.beginPath();
      g.moveTo(rootX, size);
      g.quadraticCurveTo(rootX + (tipX - rootX) * 0.2, size * 0.5, tipX, tipY);
      g.stroke();

      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const px = rootX + (tipX - rootX) * (t * t * 0.8 + t * 0.2);
        const py = size + (tipY - size) * t;
        const len = PINNA * (1 - t) * (1 - t * 0.35) + size * 0.01;
        const shade = light * rngRange(rng, 0.8, 1.5);
        g.fillStyle = `hsl(${hue + rngRange(rng, -8, 10)} ${sat}% ${shade}%)`;
        for (const side of [-1, 1]) {
          g.save();
          g.translate(px, py);
          g.rotate(side * (0.85 + t * 0.35));
          g.beginPath();
          g.moveTo(0, 0);
          g.quadraticCurveTo(len * 0.5, -len * 0.24, len, 0);
          g.quadraticCurveTo(len * 0.5, len * 0.2, 0, 0);
          g.fill();
          g.restore();
        }
      }
    }
    featherEdges(g, size, size, size * 0.05, { keepBottom: true });
    return finish(c);
  });
}

/**
 * ============================ BARK ==========================================
 *
 * TRUNKS ARE 81% OF THE TRIANGLES IN THIS WORLD, so this is the single largest
 * surface area there is and the highest-leverage texture in the project. It was
 * also the worst: the previous drawing was 190 CONTINUOUS TOP-TO-BOTTOM strokes
 * whose lightness ran from 0.45x to 1.70x the species' base, which on the
 * cecropia (base 58%) meant streaks at 99% lightness — a high-contrast
 * near-vertical smear with pale, almost white-green highlights. It read as
 * galvanised steel or painted PVC pipe. Three separate things were wrong and
 * all three are fixed here.
 *
 *
 * 1. THE CONTRAST WAS BACKWARDS. Wood is LOW contrast.
 *
 * Most Neotropical boles are smooth to finely fissured mid-to-dark grey-brown,
 * and what variation there is comes from LICHEN, MOSS AND ALGAL FILM rather
 * than from deep grooves — a rainforest trunk is a substrate for other
 * organisms far more than it is a sculpture. The mark lightness is now
 * `light * (1 + d * u)` with `u` in [-1, +0.5] and `d` a per-style depth of
 * 0.16-0.30, so the range on a cecropia is 49-63% instead of 26-99%. The
 * asymmetry is deliberate and physical: a fissure is a shadow and can be much
 * darker than the face, but the ridge between two fissures is the SAME wood at
 * a slightly better angle and cannot be much brighter. Every "highlight" in the
 * old drawing was brighter than any real bark ever is.
 *
 * The mean of the multiplier is 1 - 0.25d, so this also takes 4-8% off the
 * trunks' average albedo. That is the right direction — nothing here is
 * allowed to brighten the world — and it is small enough not to disturb the
 * emissive ratio tree-adorn.js depends on (bark 0.05-0.10 linear against a
 * near-1.0 glow band).
 *
 *
 * 2. THE VERTICALITY WAS UNBROKEN, which is what "extruded" means.
 *
 * A stroke that runs the full height of a tiling canvas repeats forever up the
 * trunk as one unbroken line. That is not a bark feature, it is an extrusion
 * artefact, and it is the single strongest cue that a surface came out of a
 * machine. Fissures are now SEGMENTS — 5-42% of the tile depending on species,
 * with round caps, wrapped across both edges — so the vertical grain is
 * interrupted and irregular. Each is drawn twice: a dark groove and a narrower,
 * fainter lip beside it, which is the whole of what makes a groove look like a
 * groove without a normal map.
 *
 *
 * 3. FIVE SPECIES SHARED ONE LOOK, differing only in one fill colour.
 *
 * `trees.js` has carried per-species `bark: {hue, sat, light}` all along and
 * this drawing threw away everything except the numbers. It now takes `key` —
 * which the caller already passes as the species name — and picks a STRUCTURE
 * as well, because the difference between a palm and a kapok is not a hue:
 *
 *   palm      stacked horizontal frond scars, few fissures. The tile is 2.857 m
 *             of trunk over 256 px (the trunk's v is `running * 0.35`), so
 *             89.6 px per metre and a 15 px scar pitch is 16.7 cm, which is
 *             what a real palm leaves behind. This is the cheapest strong
 *             silhouette cue in the file: rings at a regular pitch are
 *             instantly a monocot and nothing else.
 *   cecropia  smooth, pale, conspicuously RINGED with leaf scars at a 30 px /
 *             33 cm internode. Its bark is the world's landmark — the palest
 *             thing in the wood by a wide margin — and it now says so with
 *             structure instead of only with lightness.
 *   kapok     smooth grey-green with CONICAL SPINES. A ceiba spine is 2-4 cm
 *             at the base, which is 2-4 px here, so they are drawn as a dense
 *             stud field: a bumpy bole at 2 m and a fine mottle at 30 m, which
 *             is exactly the right pair of readings.
 *   fig       smoothest of the five, mottled grey, heavy film and almost no
 *             fissure. A strangler's bole is a fused mass, not a grooved one.
 *   brownea   the generic fissured bark, and the default for any species not
 *             named here — an unknown tree gets a plain wood rather than
 *             nothing.
 *
 * WHAT WAS REJECTED. Per-species canvases at a larger size, so a palm could
 * have finer scars: five 512² canvases instead of five 256² ones is 4x the
 * texture memory and 4x the build for detail that is past the mip chain at any
 * range a player stands. And a normal map, which is the "correct" way to make a
 * fissure look like a fissure: it doubles the fetches on 81% of the triangles
 * in the frame, and the budget note is that Ultra stands at 4.18 ms against a
 * 4.17 ms target. Painting the lip is free.
 *
 * THE TILE WRAPS IN BOTH AXES NOW, which it did not before. The trunk's u goes
 * once around the circumference, so px 0 and px 256 are the same point on the
 * tree and every mark that overhangs an edge has to reappear on the other one
 * or there is a seam down every trunk in the world. `tileWrap` does it for four
 * comparisons a mark.
 */

/** Per-species bark structure. Anything not listed falls back to `brownea`. */
const BARK_STYLES = {
  // pitch/shelf are in tile pixels; 89.6 px is one metre of trunk.
  palm: {
    fissure: 30,
    len: [0.08, 0.2],
    depth: 0.26,
    ring: { pitch: 15, jitter: 0.35, depth: 0.34, width: 2.6, shelf: 5 },
    lenticel: 20,
    spine: 0,
    film: 12,
    speck: 260,
  },
  cecropia: {
    fissure: 12,
    len: [0.05, 0.12],
    depth: 0.16,
    ring: { pitch: 30, jitter: 0.22, depth: 0.26, width: 1.8, shelf: 0 },
    lenticel: 30,
    spine: 0,
    film: 22,
    speck: 200,
  },
  kapok: {
    fissure: 22,
    len: [0.12, 0.3],
    depth: 0.2,
    ring: null,
    lenticel: 46,
    spine: 130,
    film: 26,
    speck: 320,
  },
  fig: {
    fissure: 18,
    len: [0.09, 0.24],
    depth: 0.18,
    ring: null,
    lenticel: 34,
    spine: 0,
    film: 30,
    speck: 300,
  },
  brownea: {
    fissure: 62,
    len: [0.16, 0.42],
    depth: 0.3,
    ring: null,
    lenticel: 70,
    spine: 0,
    film: 16,
    speck: 340,
  },
};

/**
 * Draw a mark, and draw it again across whichever edges it overhangs.
 *
 * The same two-comparison trick `forestFloor` uses: the nine-copy version is
 * nine times the work for a mark in the middle, which is most of them.
 */
function tileWrap(size, x, y, reach, draw) {
  for (let dx = -1; dx <= 1; dx++) {
    if (dx === -1 && x + reach < size) continue;
    if (dx === 1 && x - reach > 0) continue;
    for (let dy = -1; dy <= 1; dy++) {
      if (dy === -1 && y + reach < size) continue;
      if (dy === 1 && y - reach > 0) continue;
      draw(x + dx * size, y + dy * size);
    }
  }
}

/**
 * Paint one tileable bark square into an existing 2D context.
 *
 * Separated from `barkTexture` because the live consumer is `trunkAtlas` in
 * tree-adorn.js, which needs the tile stamped into a sub-rect of a wider canvas
 * beside its colour strip and so cannot use a finished texture. That file used
 * to hold a VERBATIM COPY of this drawing — the two were edited apart at least
 * once already, and a duplicated 40-line procedural texture is a bug waiting
 * for whoever fixes only one of them.
 *
 * `lichen` is off for that caller only: tree-adorn draws its own pale crust
 * pass after this returns, and its note explains why that half must go LIGHTER
 * than the bark. The dark algal film below is the other half and is new — a
 * rainforest trunk is stained black-green with algae wherever water runs down
 * it, and nothing in this project drew that at all.
 */
export function paintBark(
  g,
  size,
  { key = 'bark', hue = 26, sat = 22, light = 22, seed = 'bark', lichen = true } = {}
) {
  const rng = makeRng(seed);
  const style = BARK_STYLES[key] ?? BARK_STYLES.brownea;

  g.fillStyle = `hsl(${hue} ${sat}% ${light}%)`;
  g.fillRect(0, 0, size, size);

  const prevCap = g.lineCap;
  const prevJoin = g.lineJoin;
  g.lineCap = 'round';
  g.lineJoin = 'round';

  // ---- fissures: finite segments, a groove and a lip ------------------------
  for (let i = 0; i < style.fissure; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const len = size * rngRange(rng, style.len[0], style.len[1]);
    const w = rngRange(rng, 1, 4.5);
    const d = style.depth * rngRange(rng, 0.55, 1.15);
    const steps = Math.max(2, Math.round(len / 12));
    const drift = [];
    let dx = 0;
    for (let s = 0; s <= steps; s++) {
      drift.push(dx);
      dx += rngRange(rng, -2, 2);
    }
    const grooveA = rngRange(rng, 0.22, 0.55);
    const lipA = rngRange(rng, 0.1, 0.28);
    const reach = len + Math.abs(dx) + w * 2;
    tileWrap(size, x, y, reach, (px, py) => {
      for (const [off, width, alpha, mul, dh] of [
        [0, w, grooveA, 1 - d, -4],
        [w * 0.75, w * 0.5, lipA, 1 + d * 0.5, 3],
      ]) {
        g.strokeStyle = `hsla(${hue + dh} ${sat}% ${light * mul}% / ${alpha})`;
        g.lineWidth = width;
        g.beginPath();
        for (let s = 0; s <= steps; s++) {
          const sx = px + off + drift[s];
          const sy = py + (len * s) / steps;
          if (s === 0) g.moveTo(sx, sy);
          else g.lineTo(sx, sy);
        }
        g.stroke();
      }
    });
  }

  /**
   * The dark algal/moss film. Drawn OVER the fissures, because a stain grows on
   * a surface after the surface exists, and squashed in y because water runs
   * down a trunk and so does everything living on one.
   *
   * Low alpha and soft-edged for the reason tree-adorn's lichen note gives: a
   * hard-edged patch on a tiling texture is a shape you learn, and you then see
   * it on nine thousand trunks.
   */
  for (let i = 0; i < style.film; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = rngRange(rng, 12, 46);
    const ry = r * rngRange(rng, 0.55, 0.95);
    const fh = rngRange(rng, 96, 142);
    const fl = light * rngRange(rng, 0.7, 0.9);
    tileWrap(size, x, y, r, (px, py) => {
      const grad = g.createRadialGradient(px, py, 0, px, py, r);
      grad.addColorStop(0, `hsla(${fh} ${sat + 8}% ${fl}% / 0.13)`);
      grad.addColorStop(0.55, `hsla(${fh} ${sat + 8}% ${fl}% / 0.075)`);
      grad.addColorStop(1, `hsla(${fh} ${sat + 8}% ${fl}% / 0)`);
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(px, py, r, ry, 0, 0, TAU);
      g.fill();
    });
  }

  /**
   * Leaf and frond scars — the horizontal structure the old drawing had none of
   * and the reason a palm now looks like a palm.
   *
   * Full width, so they wrap in x for free, with a sine sag whose period is
   * exactly the tile so it wraps too. The sag is 1-3 px and it exists only to
   * stop a scar being a ruler line: a real scar on an unrolled cylinder IS
   * straight, but a perfectly straight axis-aligned line is the signature of a
   * generated texture that this file has already had to remove once (the
   * lenticel rectangles below).
   *
   * `shelf` is the palm's alone: under each scar a soft gradient band, which is
   * the remains of the frond base rather than a line. It is what separates
   * "stacked scars" from "hoops".
   */
  if (style.ring) {
    const { pitch, jitter, depth, width, shelf } = style.ring;
    for (let y = rng() * pitch; y < size; y += pitch * (1 + rngRange(rng, -jitter, jitter))) {
      const sag = rngRange(rng, 1, 3);
      const phase = rng() * TAU;
      const line = (yy, off, lw, mul, alpha, dh) => {
        g.strokeStyle = `hsla(${hue + dh} ${sat}% ${light * mul}% / ${alpha})`;
        g.lineWidth = lw;
        g.beginPath();
        for (let px = 0; px <= size; px += 16) {
          const py = yy + off + Math.sin((px / size) * TAU + phase) * sag;
          if (px === 0) g.moveTo(px, py);
          else g.lineTo(px, py);
        }
        g.stroke();
      };
      // At y and at y +- size: a scar within a few pixels of an edge has to
      // appear on the other one or the tile seam cuts it in half.
      for (const yy of [y - size, y, y + size]) {
        if (shelf > 0) {
          const grad = g.createLinearGradient(0, yy, 0, yy + shelf);
          grad.addColorStop(0, `hsla(${hue - 4} ${sat}% ${light * (1 - depth * 0.7)}% / 0.3)`);
          grad.addColorStop(1, `hsla(${hue - 4} ${sat}% ${light * (1 - depth * 0.7)}% / 0)`);
          g.fillStyle = grad;
          g.fillRect(0, yy, size, shelf);
        }
        line(yy, 0, width, 1 - depth, rngRange(rng, 0.45, 0.7), -4);
        line(yy, -width * 0.9, width * 0.6, 1 + depth * 0.55, rngRange(rng, 0.2, 0.4), 2);
      }
    }
  }

  /**
   * Lenticels — short horizontal pores. They were the only horizontal mark in
   * the old drawing and there is nothing wrong with them, so they are kept
   * exactly as they were except for the contrast, which followed everything
   * else down: `light * (0.35..1.4)` became `light * (1 + d*[-1, +0.5])`.
   *
   * Still tapered strokes rather than filled rectangles. Rectangles are what
   * they were before that, and on a pale trunk a scattering of axis-aligned
   * rectangles is the most legible possible signature of a generated texture —
   * the birches came out looking like they were made of tiled wallpaper.
   */
  for (let i = 0; i < style.lenticel; i++) {
    const y = rng() * size;
    const x0 = rng() * size;
    const w = rngRange(rng, 5, 26);
    const d = style.depth * rngRange(rng, 0.6, 1.2);
    tileWrap(size, x0, y, w + 4, (px, py) => {
      g.strokeStyle = `hsla(${hue - 6} ${Math.max(0, sat - 6)}% ${light * (1 + d * rngRange(rng, -1, 0.5))}% / ${rngRange(rng, 0.18, 0.45)})`;
      g.lineWidth = rngRange(rng, 0.8, 2.4);
      g.beginPath();
      g.moveTo(px, py);
      g.quadraticCurveTo(px + w * 0.5, py + rngRange(rng, -1.6, 1.6), px + w, py);
      g.stroke();
    });
  }

  /**
   * Conical spines. Kapok only, and the one mark here that is a SHAPE rather
   * than a stroke: a shadow ellipse at the base and a bright triangle above it,
   * which is the cheapest possible lit cone. Two or three pixels each, so at
   * range they mip down into the fine grey-green mottle a ceiba bole actually
   * has, and up close they are studs.
   */
  for (let i = 0; i < style.spine; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = rngRange(rng, 2.2, 5.5);
    tileWrap(size, x, y, r * 2, (px, py) => {
      g.fillStyle = `hsla(${hue - 4} ${sat}% ${light * (1 - style.depth)}% / 0.34)`;
      g.beginPath();
      g.ellipse(px, py + r * 0.35, r * 0.9, r * 0.45, 0, 0, TAU);
      g.fill();
      g.fillStyle = `hsla(${hue + 4} ${sat}% ${light * (1 + style.depth * 0.6)}% / 0.5)`;
      g.beginPath();
      g.moveTo(px - r * 0.55, py + r * 0.4);
      g.lineTo(px + r * 0.55, py + r * 0.4);
      g.lineTo(px, py - r * 0.6);
      g.closePath();
      g.fill();
    });
  }

  /**
   * Pale lichen crust. THE LUMA RULE, in the direction tree-adorn.js states it:
   * lichen goes LIGHTER than the bark, never greener-and-darker, because a
   * darker patch on a dark trunk is a hole rather than a plant. Capped at 68%
   * so it cannot become the white streak this whole rewrite exists to delete.
   *
   * Skipped for `trunkAtlas`, which draws its own — see the note on `lichen`.
   */
  if (lichen) {
    for (let i = 0; i < 15; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const r = rngRange(rng, 9, 34);
      const pale = rng() < 0.55;
      const bh = pale ? 74 : 46;
      const bs = pale ? 16 : 10;
      const bl = Math.min(68, light + rngRange(rng, 8, 20));
      tileWrap(size, x, y, r, (px, py) => {
        const grad = g.createRadialGradient(px, py, 0, px, py, r);
        grad.addColorStop(0, `hsla(${bh} ${bs}% ${bl}% / 0.1)`);
        grad.addColorStop(0.6, `hsla(${bh} ${bs}% ${bl}% / 0.055)`);
        grad.addColorStop(1, `hsla(${bh} ${bs}% ${bl}% / 0)`);
        g.fillStyle = grad;
        g.beginPath();
        g.ellipse(px, py, r, r * rngRange(rng, 0.5, 0.85), 0, 0, TAU);
        g.fill();
      });
    }
  }

  // Fine grain, last. The layer that survives minification: past about fifteen
  // metres every mark above has averaged out and this is the only thing keeping
  // a trunk from being a flat cylinder of one colour.
  for (let i = 0; i < style.speck; i++) {
    const x = rng() * size;
    const y = rng() * size;
    g.fillStyle = `hsla(${hue} ${sat}% ${light * (1 + style.depth * rngRange(rng, -1, 0.5))}% / ${rngRange(rng, 0.1, 0.34)})`;
    g.beginPath();
    g.ellipse(x, y, rngRange(rng, 0.5, 1.6), rngRange(rng, 0.8, 2.6), 0, 0, TAU);
    g.fill();
  }

  g.lineCap = prevCap;
  g.lineJoin = prevJoin;
}

/**
 * Bark as a finished, both-ways-wrapping texture.
 *
 * NOTHING IMPORTS THIS TODAY. The live trunk path is `trunkAtlas` in
 * tree-adorn.js, which needs the tile inside a wider canvas next to its colour
 * strip and so calls `paintBark` directly. This is kept as the plain
 * single-tile entry point — it is how the drawing is inspected in isolation and
 * it is what anything that wants bark WITHOUT the adornment strip should use.
 * If it is still unused a year from now, delete it rather than leaving it: an
 * export nobody calls is the thing that lets a duplicate drift.
 */
export function barkTexture({ key = 'bark', hue = 26, sat = 22, light = 22, seed = 'bark' } = {}) {
  return memo(`bark:${key}`, () => {
    const size = 256;
    const c = canvas(size);
    paintBark(c.getContext('2d'), size, { key, hue, sat, light, seed });
    return finish(c, { wrap: true });
  });
}

/** A soft round sprite. Motes, fireflies, pollen, the glow around a mushroom. */
export function glowSprite({ key = 'glow', inner = '#ffffff', outer = 'rgba(255,255,255,0)' } = {}) {
  return memo(`glow:${key}`, () => {
    const size = 128;
    const c = canvas(size);
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, inner);
    grad.addColorStop(0.25, inner);
    grad.addColorStop(1, outer);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return finish(c, { srgb: true });
  });
}

/**
 * A falling raindrop, as a vertical streak.
 *
 * WHY A STREAK AND NOT A DOT. A raindrop at terminal velocity crosses several
 * metres during one frame's exposure, so what a camera — and, for the same
 * reason, an eye — actually records is a short bright line, not a sphere. Rain
 * drawn as round points reads as snow or as static; the elongation IS the
 * speed, and it is the only cue that the drop is moving at all, because
 * everything else about a raindrop is featureless.
 *
 * IT IS DRAWN INTO A SQUARE BECAUSE A THREE.Points SPRITE IS A SQUARE. There
 * is no way to give one point a non-square footprint without moving to quads,
 * which would be four vertices and an index buffer per drop instead of one
 * vertex. So the streak is painted down the middle of a square canvas with
 * empty space either side, and the cost of that emptiness is texels — which are
 * free — rather than fill, because the transparent columns discard.
 *
 * Rain falls near-vertically on screen at any camera pitch a walking player
 * uses, so a screen-aligned square with a vertical streak in it needs no
 * rotation to look right. That is the whole reason this works.
 */
export function rainStreak({ key = 'rain' } = {}) {
  return memo(`rain:${key}`, () => {
    const w = 32;
    const h = 128;
    const c = canvas(1);
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    // Brightest in the middle of the fall and tapering at both ends, so a drop
    // does not begin and end on a hard edge. A drop with square ends reads as a
    // dash rather than as water.
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.16, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.85, 'rgba(255,255,255,0.62)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    /**
     * ONE AND A HALF PIXELS OF CORE OUT OF THIRTY-TWO, AND THE RATIO IS THE
     * WHOLE POINT.
     *
     * A THREE.Points sprite is sampled over a SQUARE footprint whatever shape
     * the texture is, so this canvas's own 32x128 aspect buys nothing — the
     * streak's on-screen width is `core/32 * gl_PointSize` and its height is
     * the full `gl_PointSize`. Width and length are therefore not independent:
     * asking for a longer streak by raising the point size makes it
     * proportionally fatter at the same time.
     *
     * At the first values — a 3 px core and 0.9 alpha — a near drop came out
     * six pixels wide and bright white, and the frame was full of what looked
     * like falling pills rather than rain. 1.5/32 is 4.7%, so a 48 px streak is
     * 2.2 px across, which is the widest a raindrop may be before it stops
     * being a line. The taper was pulled in to the ends at the same time: the
     * old stops put the opaque part in the middle 40% of the sprite, which
     * shortened the visible streak to well under what the point size suggested
     * and was the other half of the pill.
     */
    g.fillRect(w / 2 - 0.75, 0, 1.5, h);
    return finish(c, { srgb: true });
  });
}

/**
 * A wide, wispy band of mist.
 *
 * Drawn as overlapping soft ellipses with a hard alpha falloff at the top and
 * bottom edges, so a stack of these planes in the hollow reads as ground fog
 * rather than as a stack of planes.
 */
export function mistBand({ key = 'mist', seed = 'mist' } = {}) {
  return memo(`mist:${key}`, () => {
    const w = 512;
    const h = 128;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    const rng = makeRng(seed);
    for (let i = 0; i < 70; i++) {
      const x = rng() * w;
      const y = h * rngRange(rng, 0.3, 0.7);
      const rx = rngRange(rng, 30, 120);
      const ry = rngRange(rng, 8, 30);
      const grad = g.createRadialGradient(x, y, 0, x, y, rx);
      const a = rngRange(rng, 0.03, 0.1);
      grad.addColorStop(0, `rgba(255,255,255,${a})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.save();
      g.translate(x, y);
      g.scale(1, ry / rx);
      g.translate(-x, -y);
      g.beginPath();
      g.arc(x, y, rx, 0, TAU);
      g.fill();
      g.restore();
    }
    // Feather the vertical edges to nothing so the plane has no border.
    const fade = g.createLinearGradient(0, 0, 0, h);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(0.5, 'rgba(0,0,0,0)');
    fade.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = fade;
    g.fillRect(0, 0, w, h);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  });
}

/**
 * THE FOREST FLOOR, AND WHY THE GROUND HAD NO TEXTURE AT ALL UNTIL NOW.
 *
 * `heightGrid` carries the ground's colour in a per-VERTEX attribute — moss in
 * the hollows, laterite on the banks, silt at the water — and the argument for
 * that is good and unchanged: the colour follows the actual terrain, there are
 * no UV seams and it costs no texture memory. What it cannot do is DETAIL. The
 * mesh is a 1.6 m grid, so the finest thing a vertex colour can express is 3.2 m
 * across, and the two octaves of "mottle" that block adds at 0.62 and 1.7
 * cycles per metre are both far past that lattice's Nyquist limit. They do not
 * draw grain; they draw random numbers at the vertices, which Gouraud then
 * smears into exactly the low-frequency khaki blur that photographs as "the
 * floor is a mud plane".
 *
 * So this is the missing half: a tiling detail map, multiplied over the vertex
 * palette, carrying everything smaller than the mesh can hold. The two do
 * different jobs and neither replaces the other — the vertex colour still says
 * WHAT this ground is, and this says what it is made of.
 *
 * DRAWN ALMOST WITHOUT HUE, for the reason `litterTexture` gives: the palette
 * underneath is already doing the biome, and a green cast baked in here would
 * fight the red bank and win, because it is on every square metre of the world.
 * There is a little warmth in the leaves and none anywhere else.
 *
 * THE MEAN IS DIVIDED OUT, SO THIS CANVAS CANNOT CHANGE THE GROUND'S COLOUR OR
 * ITS BRIGHTNESS. WORTH SAYING FIRST, BECAUSE IT IS THE OPPOSITE OF WHAT A
 * TEXTURE NORMALLY DOES.
 *
 * The bottom of this function measures the canvas's own linear mean per channel
 * and ships it on the texture; `groundMaterial` divides by it before
 * multiplying. So the base fill, the average lightness of the marks and any net
 * tint are ALL removed downstream — make everything here twice as dark and the
 * ground on screen is bit-for-bit unchanged. What survives normalisation is
 * only the per-texel DEVIATION from the mean: the size of the marks, their
 * spatial frequency, their contrast, and the hue spread ABOUT the average.
 *
 * The consequence is a division of labour that has to be respected in both
 * directions. "The floor is too bright" and "the floor is the wrong colour" are
 * questions for the vertex palette in terrain.js and can only be answered
 * there. "The floor is the wrong SCALE" and "the floor is blotchy" are
 * questions for this canvas and can only be answered here.
 *
 *
 * WHAT SIZE EVERY MARK COMES OUT AT, WHICH IS THE 2026-08 FIX.
 *
 * The map is sampled twice, at 7.3 m and 1.31 m per tile (FLOOR_MACRO_M and
 * FLOOR_FINE_M in forest.js). 512 px over 7.3 m is 1.43 cm per texel, so a mark
 * drawn at a fraction f of the canvas is 7.3f metres across on the ground.
 * Every size below is chosen from that arithmetic and not by eye:
 *
 *   leaves   1.8-5.2% of the canvas -> 13-38 cm at the macro scale, 2.3-6.8 cm
 *            at the fine one. They were 3.5-10.5%, i.e. 26-77 cm, and a 77 cm
 *            leaf on a forest floor is a banana frond. Real Neotropical litter
 *            is 10-35 cm entire leaves, which is what these now are, and the
 *            fine sample turns the same marks into the leaflets underneath.
 *   blotches 5-17% radius -> 0.37-1.23 m. They were 8-29%, i.e. 0.6-2.1 m
 *            radius, at ±0.10 of lightness on a 0.74 base — a two-metre stain
 *            REPEATING ON A 7.3 M GRID, which is the enormous low-frequency
 *            mottle the floor was reported for. It is the one defect on this
 *            canvas that a viewer reads as a bug rather than as ground.
 *   roots    60-210 px -> 0.86-3.0 m at the macro scale. Unchanged: that is
 *            genuinely the scale a surface root runs at and it was never the
 *            complaint.
 *
 * THE MARKS SHRANK AND `FLOOR_MACRO_M` DID NOT, AND THAT IS THE WHOLE POINT.
 * Cutting the macro scale from 7.3 m to ~4 m would have shrunk the leaves by
 * the same factor — and would also have shrunk the TILE, so the repeat period
 * of every blotch on this canvas would have come down with it and the tiling
 * would have become MORE visible, not less. Shrinking the marks inside a canvas
 * whose repeat stays at 7.3 m fixes the leaves and fixes the blotching at once.
 * Do not "fix" this by touching the two scales in forest.js.
 *
 * DARK IS NOT AVAILABLE HERE, ONLY CONTRAST. The mark lightnesses came down
 * (leaves 46-100% -> 42-90%, grain 40-100% -> 38-94%) not to darken anything —
 * see the normalisation note above, it cannot — but to stop the top of the
 * distribution reading as bright specks against the dark red-brown the palette
 * now paints underneath. The hue spread came in with it, 20-46° -> 12-34°, so
 * the deviation about the mean is red-brown either side rather than running out
 * to yellow. The yellow-olive cast the floor was reported for was the palette's
 * and has been fixed in terrain.js.
 *
 *
 * AND THEN THE SPREAD CAME DOWN AGAIN, WHICH IS THE SECOND 2026-08 FIX.
 *
 * Shrinking the marks fixed the scale and left the floor reading as popcorn at
 * standing height. Measured on the canvas, in linear luma: the per-texel std was
 * 20.4% of the mean, and the residual after a 3 px blur — marks a texel or two
 * across, which is the salt-and-pepper band — was 6.9% of the mean. It is now
 * 15.3% and 4.4%. Every mark size and the 7.3 m repeat are untouched; only the
 * LIGHTNESS RANGES and two counts moved, which is the one axis normalisation
 * leaves alive.
 *
 * IT WAS THE LEAVES, NOT THE GRAIN, AND THAT IS THE SURPRISE. Zeroing the 3400
 * grain dots moved the total std from 0.0989 to 0.0990 — the fine specks are
 * alpha-blended toward the middle of the distribution, so what they add in
 * variance they take back in smoothing, and they are very nearly free. Zeroing
 * the leaves moved it from 0.0989 to 0.0489. 880 leaves carrying a 42-90
 * lightness range is where essentially all of this canvas's contrast lives, at
 * every spatial band, and it is the only place worth touching.
 *
 * TWO SAMPLES MULTIPLY, SO SPREAD COMPOUNDS. groundMaterial fetches this map at
 * 7.3 m and again at 1.31 m and multiplies the two, then applies a 1.18 contrast
 * gain. For independent samples the product's relative spread is
 * sqrt((1+r²)² - 1), about sqrt(2)·r — so the 20.4% above arrived on screen as
 * 34.4% and now arrives as 25.7%. Anything chosen by eye on this canvas alone
 * lands 40% hotter than it looked.
 *
 * AND THE LIGHTING NOW CARRIES THE CONTRAST. Sun to shade was rebuilt this
 * session from 1.23 stops to 2.94, so the floor is genuinely shaded with bright
 * sunflecks across it. High-frequency albedo variation used to substitute for
 * that and now competes with it: the same numbers that were merely busy before
 * the lighting change read as static after it. If the lighting ratio is ever
 * pulled back, this is the first place that can afford to go back up.
 *
 * IT HAS TO TILE, so every mark is drawn up to four times — see `wrapped`. The
 * repeat is set at the call site (`ground.js`) rather than here, because how
 * many metres a tile covers is a property of the terrain and not of the canvas.
 */
export function forestFloor({ key = 'floor', seed = 'floor' } = {}) {
  return memo(`floor:${key}`, () => {
    const size = 512;
    const c = canvas(size);
    const g = c.getContext('2d');
    const rng = makeRng(seed);

    /**
     * Draw a mark, and draw it again across whichever edges it overhangs.
     *
     * The naive nine-copy version is nine times the canvas work for a mark in
     * the middle, which is most of them. Testing the overhang costs two
     * comparisons and skips the copies that cannot be visible.
     */
    const wrapped = (x, y, reach, draw) => {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === -1 && x + reach < size) continue;
        if (dx === 1 && x - reach > 0) continue;
        for (let dy = -1; dy <= 1; dy++) {
          if (dy === -1 && y + reach < size) continue;
          if (dy === 1 && y - reach > 0) continue;
          draw(x + dx * size, y + dy * size);
        }
      }
    };

    g.fillStyle = 'hsl(36 8% 74%)';
    g.fillRect(0, 0, size, size);

    /**
     * The substrate: soft blotches, which is what makes one tile of this not
     * look like one tile of this. Litter drifts unevenly — there are bare
     * patches and there are ankle-deep piles — and a uniform confetti of leaves
     * has no such structure, so the repeat would be visible as a texture rather
     * than as ground.
     *
     * SMALLER, WEAKER AND MORE OF THEM: 70 at 26-86 px and 0.34 alpha, from 46
     * at 40-150 px and 0.5. The old ones were 0.6-2.1 m radius on a tile that
     * repeats every 7.3 m, so there were only about three blotch-widths across
     * a tile and the eye locked onto the period — the "enormous low-frequency
     * blotching that reads as staining". Six across a tile at two thirds the
     * amplitude is drift; three across a tile at full amplitude is a pattern.
     * The lightness swing came in with the alpha (54-94 -> 62-88 against a 74
     * base), which is ±0.09 before the 1.18 contrast gain in the shader rather
     * than ±0.17.
     */
    for (let i = 0; i < 70; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const r = rngRange(rng, 26, 86);
      const light = rngRange(rng, 62, 88);
      wrapped(x, y, r, (px, py) => {
        const grad = g.createRadialGradient(px, py, 0, px, py, r);
        grad.addColorStop(0, `hsla(${rngRange(rng, 16, 36)} 10% ${light}% / 0.34)`);
        grad.addColorStop(1, 'hsla(30 10% 74% / 0)');
        g.fillStyle = grad;
        g.beginPath();
        g.arc(px, py, r, 0, TAU);
        g.fill();
      });
    }

    /**
     * Surface roots. The one mark on this canvas that is not litter, and the
     * one that says "rainforest" rather than "woodland": tropical soils are
     * thin, so the feeder roots run ACROSS the top of the ground rather than
     * down into it, and the floor is a net of them. Long, low-contrast, and
     * branching — a root that does not fork is a stick.
     */
    g.lineCap = 'round';
    for (let i = 0; i < 34; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const a = rng() * TAU;
      const len = rngRange(rng, 60, 210);
      const w = rngRange(rng, 2.5, 9);
      const dark = rng() < 0.5;
      wrapped(x, y, len, (px, py) => {
        // The pale root came down from 84-96% to 78-88% and from 0.45 alpha to
        // 0.34. A root catching a sunfleck is the brightest thing this canvas
        // is allowed to draw, and at 96% on a 74% base it was a white cord
        // three metres long — the one mark that survives every mip and reads,
        // correctly for its width and wrongly for its colour, as a pipe.
        g.strokeStyle = dark
          ? `hsla(26 12% ${rngRange(rng, 44, 58)}% / 0.55)`
          : `hsla(30 10% ${rngRange(rng, 78, 88)}% / 0.34)`;
        g.lineWidth = w;
        g.beginPath();
        g.moveTo(px, py);
        let cx = px;
        let cy = py;
        let ca = a;
        const steps = 5;
        for (let s = 0; s < steps; s++) {
          ca += rngRange(rng, -0.5, 0.5);
          cx += Math.cos(ca) * (len / steps);
          cy += Math.sin(ca) * (len / steps);
          g.lineTo(cx, cy);
        }
        g.stroke();
        // One fork, from the middle. Two lines, and it is the whole difference
        // between a root system and a scatter of worms.
        g.lineWidth = w * 0.55;
        g.beginPath();
        g.moveTo((px + cx) / 2, (py + cy) / 2);
        g.lineTo(
          (px + cx) / 2 + Math.cos(a + 1.1) * len * 0.4,
          (py + cy) / 2 + Math.sin(a + 1.1) * len * 0.4
        );
        g.stroke();
      });
    }

    /**
     * Whole fallen leaves, big enough to read individually from standing
     * height. This is the mark that carries the biome: a rainforest floor is
     * ankle deep in large entire leaves, not in the small toothed ones a
     * temperate wood drops, so these are long ovals with a midrib and no lobes.
     *
     * 780 AT 1.8-5.2% OF THE CANVAS, from 240 at 3.5-10.5%. See the size
     * arithmetic at the top: these were 26-77 cm on the ground and are now
     * 13-38 cm, which is what a Neotropical entire leaf actually measures.
     *
     * THE COUNT HAD TO GO UP TO KEEP THE FLOOR COVERED, and it costs nothing.
     * Leaf area goes as len², and integrating the two uniform ranges gives 74k
     * px² of lamina for 780 small leaves against 91k for the old 240 large ones
     * — LESS paint, spread over 3.3x the paths. Rasterised area is what a
     * canvas build costs and path setup is what it does not, so this is the
     * same cost class or better; the blotch loop above cut its own coverage
     * from 1.45 M px² to 756 k at the same time, and the 6.3 ms
     * mean-measurement pass at the bottom dominates the whole function anyway.
     *
     * 52-80% LIGHTNESS, FROM 42-90, AND THAT IS THE WHOLE POPCORN FIX. This
     * loop is where all of the canvas's contrast lives — see the measurement in
     * the header: delete it and the per-texel std falls by half, delete the
     * 3000 grain dots instead and it does not move at all. A 48-point lightness
     * range spread over 780 small marks is a field of confetti; a 28-point one
     * over the same marks is litter you can still pick individual leaves out of.
     * The count came down 880 -> 780 as well, but that is worth only a fifth of
     * the change — the RANGE is the knob and the count is the character, so the
     * count was cut as little as the number allowed.
     */
    for (let i = 0; i < 780; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const len = size * rngRange(rng, 0.018, 0.052);
      const wid = len * rngRange(rng, 0.3, 0.52);
      const rot = rng() * TAU;
      const light = rngRange(rng, 52, 80);
      const hue = rngRange(rng, 12, 34);
      const sat = rngRange(rng, 8, 22);
      wrapped(x, y, len, (px, py) => {
        g.save();
        g.translate(px, py);
        g.rotate(rot);
        g.fillStyle = `hsl(${hue} ${sat}% ${light}%)`;
        g.beginPath();
        g.moveTo(0, -len / 2);
        g.quadraticCurveTo(wid, 0, 0, len / 2);
        g.quadraticCurveTo(-wid, 0, 0, -len / 2);
        g.fill();
        // The midrib, a few points off the lamina either way. It is one stroke
        // and it is what stops a field of these reading as gravel. 0.9 px now
        // rather than 1.2: the leaves are 2.9x smaller in area and a midrib
        // that does not scale with them turns the smallest ones into sticks.
        //
        // ±15/16 WAS A FULL STOP ON A ONE-PIXEL LINE, which is a hard edge at
        // exactly the frequency the floor was reported noisy at, once per leaf
        // and 780 times per tile. At ±8/9 the rib is still legible when you
        // look at a leaf and stops being a speck when you do not. It has to
        // scale with the lamina range: this is 8 of the 28 points the leaves
        // now span, the same share 15 was of the old 48.
        g.strokeStyle = `hsl(${hue} ${sat}% ${light > 68 ? light - 8 : light + 9}%)`;
        g.lineWidth = 0.9;
        g.beginPath();
        g.moveTo(0, -len / 2);
        g.lineTo(0, len / 2);
        g.stroke();
        g.restore();
      });
    }

    /**
     * Fine grain, last and over everything. Three thousand specks is the layer
     * that survives minification: by the time a tile is eight pixels across the
     * leaves have averaged out and this is what is left, and without it the
     * middle distance goes back to being smooth.
     *
     * 3000 at 0.5-1.9 px, from 2200 at 0.6-2.4. The leaves above stopped being
     * the mark that carries detail at reading distance — they are 13-38 cm now
     * — so this layer has to carry more of it, and it is the cheapest paint on
     * the canvas: an unwrapped `arc` of two pixels is a handful of texels.
     *
     * THIS LAYER IS NOT WHERE THE SPECKLE CAME FROM, WHICH IS COUNTER-INTUITIVE
     * AND WAS MEASURED. One dot per 77 px² at a radius of one texel sits right
     * at the canvas's Nyquist limit and is the obvious suspect; zeroing the
     * whole loop moved the per-texel std from 0.0989 to 0.0990, i.e. not at all.
     * These are alpha-blended toward the middle of the distribution, so the
     * variance they add they very nearly take back in smoothing. Do not come
     * here first when the floor is reported noisy — go to the leaves.
     *
     * IT WAS STILL WORTH CALMING, at 6% of the fine band once the leaves were
     * fixed: 46-88% lightness from 38-94, alpha 0.12-0.34 from 0.18-0.5. The
     * count came down only 3400 -> 3000, because count is what makes this layer
     * survive minification and spread is what made it grate; those are two
     * different properties and only one of them was the complaint.
     */
    for (let i = 0; i < 3000; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const r = rngRange(rng, 0.5, 1.9);
      g.fillStyle = `hsla(28 8% ${rngRange(rng, 46, 88)}% / ${rngRange(rng, 0.12, 0.34)})`;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
    }

    const tex = finish(c, { wrap: true, aniso: 8 });
    /**
     * ITS OWN MEAN, MEASURED, SHIPPED WITH IT.
     *
     * This map multiplies the ground, so its average brightness is a global
     * exposure change on the largest object in the frame — a 0.78 mean is the
     * whole world a fifth of a stop down, on every station, and that is a
     * lighting decision arriving through the back door of a texture edit. The
     * consumer divides by this before multiplying, so the map contributes
     * STRUCTURE at a mean of exactly 1.0 and the exposure stays where the
     * lighting put it. Change any mark above and the pivot follows it.
     *
     * LINEAR, per channel, because that is what `texture2D` returns: the texture
     * is uploaded as sRGB and the sampler decodes it, so the mean of the decoded
     * values is not the decode of the mean — 0.78 sRGB is 0.573 linear, and the
     * mean of this canvas in linear is lower still because decoding is convex
     * and the marks are spread either side. Per channel because the leaves carry
     * a little warmth, and normalising by a scalar would leave the map with a
     * net tint that lands on every square metre of the world.
     *
     * MEASURED AT BUILD, NEVER QUOTED AS A CONSTANT. As of the 2026-08 spread
     * pass it reads r 0.522, g 0.479, b 0.437 — warm by 19% red over blue,
     * which is the leaves, and dividing by a scalar would have left that as a
     * permanent warm cast on every square metre of the world. Exactly the bias
     * this whole file's other notes warn about, arriving through a
     * normalisation rather than through a fill colour. It was r 0.561, g 0.527,
     * b 0.483 before the mark pass.
     *
     * TREAT ANY TRIPLE WRITTEN DOWN ANYWHERE AS STALE. Every mark above has
     * changed size, count and lightness range twice this month, so the mean has
     * moved twice; the code reads it off the canvas and nothing depends on the
     * number in the prose. The one place it is written down and DOES need
     * re-reading by hand is `groundMaterial` (forest.js), which quotes the old
     * 0.561/0.527/0.483 — read `forestFloor().userData.mean` in a live page and
     * correct it there.
     *
     * THE SPREAD IS NOT SHIPPED, ONLY THE MEAN, and that is deliberate: the
     * consumer needs the pivot to normalise about and has no use for the
     * variance. The variance is a design decision made here, and the numbers it
     * was made from are in the header — measure them the same way if you change
     * a mark, because the canvas is the only place they can be read and the
     * shader multiplies two samples of it before you get to see the result.
     *
     * 262 144 texels once at load: 6.3 ms measured, against a first frame that
     * already spends 250–320 ms compiling shaders behind the entry gate. The
     * alternative is a magic number that silently stops being true the first
     * time somebody adds a mark.
     */
    const px = g.getImageData(0, 0, size, size).data;
    const lin = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const s = i / 255;
      lin[i] = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }
    let mr = 0;
    let mg = 0;
    let mb = 0;
    for (let i = 0; i < px.length; i += 4) {
      mr += lin[px[i]];
      mg += lin[px[i + 1]];
      mb += lin[px[i + 2]];
    }
    const n = px.length / 4;
    tex.userData.mean = { r: mr / n, g: mg / n, b: mb / n };
    return tex;
  });
}

export function disposeTextures() {
  for (const tex of cache.values()) tex.dispose?.();
  cache.clear();
}
