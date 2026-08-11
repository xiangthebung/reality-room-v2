import * as THREE from 'three';
import { TAU, makeRng, rngRange } from '../core/util.js';

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
  return memo(`leaf:${key ?? seed}`, () => {
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

    // Belt and braces: the bound above is exact, this only ever touches pixels
    // the scatter already left empty.
    featherEdges(g, size, size, size * 0.06);
    return finish(c);
  });
}

/**
 * A tuft of grass blades on a transparent card.
 *
 * THE BLADES MUST NOT MEET AT THE BOTTOM. The first version drew each blade as a
 * quad whose base spanned a tenth of the card's width, all of them starting on
 * the bottom edge — so the lowest strip of the texture was a solid, opaque, dark
 * green bar. Instanced twenty thousand times, that bar appeared as a hard dark
 * rectangle sitting under every single tuft in the forest, and it read as a
 * shadow bug rather than as grass.
 *
 * So each blade is a spindle: a point at the root, widest a third of the way up,
 * a point at the tip. That is also what a blade of grass actually looks like.
 */
export function grassBlade({ key = 'grass', hue = 88, sat = 40, light = 30, seed = 'blade' } = {}) {
  return memo(`blade:${key}`, () => {
    const size = 128;
    const c = canvas(size);
    const g = c.getContext('2d');
    const rng = makeRng(seed);
    // The tip must land inside the card. A blade that ran off the side was
    // clipped into a straight vertical cut, on every tuft in the forest.
    const EDGE = size * 0.07;
    for (let i = 0; i < 6; i++) {
      const root = size * rngRange(rng, 0.3, 0.7);
      const w = size * rngRange(rng, 0.035, 0.062);
      const reach = size * 0.38;
      const bend = Math.max(
        EDGE + w - root,
        Math.min(size - EDGE - w - root, rngRange(rng, -reach, reach))
      );
      const top = size * rngRange(rng, 0.04, 0.34);
      const belly = size - (size - top) * 0.36;
      const grad = g.createLinearGradient(0, size, 0, top);
      grad.addColorStop(0, `hsl(${hue - 8} ${sat}% ${light * 0.82}%)`);
      grad.addColorStop(0.4, `hsl(${hue} ${sat + 4}% ${light * 1.25}%)`);
      grad.addColorStop(1, `hsl(${hue + 10} ${sat + 8}% ${light * 1.75}%)`);
      g.fillStyle = grad;
      g.beginPath();
      // Up the left edge: root point, out to the belly, in to the tip.
      g.moveTo(root, size);
      g.quadraticCurveTo(root - w, belly, root + bend, top);
      // Back down the right edge.
      g.quadraticCurveTo(root + w, belly, root, size);
      g.closePath();
      g.fill();
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
 * Bark. Tileable vertical fissures built from stacked, warped strips.
 *
 * Wrapped in both directions and used with a repeat, so a tall trunk gets many
 * metres of texture out of a 256 px tile.
 */
export function barkTexture({ key = 'bark', hue = 26, sat = 22, light = 22, seed = 'bark' } = {}) {
  return memo(`bark:${key}`, () => {
    const size = 256;
    const c = canvas(size);
    const g = c.getContext('2d');
    const rng = makeRng(seed);
    g.fillStyle = `hsl(${hue} ${sat}% ${light}%)`;
    g.fillRect(0, 0, size, size);

    for (let i = 0; i < 190; i++) {
      const x = rng() * size;
      const w = rngRange(rng, 1.2, 7);
      const shade = rngRange(rng, 0.45, 1.7);
      g.strokeStyle = `hsla(${hue + rngRange(rng, -6, 8)} ${sat}% ${light * shade}% / ${rngRange(rng, 0.25, 0.8)})`;
      g.lineWidth = w;
      g.beginPath();
      let px = x;
      g.moveTo(px, -4);
      for (let y = 0; y <= size + 4; y += 16) {
        px += rngRange(rng, -3.4, 3.4);
        g.lineTo(px, y);
      }
      g.stroke();
    }
    /**
     * Horizontal lenticels break the strict verticality; without them the trunk
     * reads as corduroy.
     *
     * Drawn as tapered strokes rather than as filled rectangles. Rectangles are
     * what they were, and on a pale trunk a scattering of axis-aligned rectangles
     * is the most legible possible signature of a generated texture — the birches
     * came out looking like they were made of tiled wallpaper.
     */
    for (let i = 0; i < 70; i++) {
      const y = rng() * size;
      const x0 = rng() * size;
      const w = rngRange(rng, 5, 26);
      g.strokeStyle = `hsla(${hue - 6} ${sat - 6}% ${light * rngRange(rng, 0.35, 1.4)}% / ${rngRange(rng, 0.18, 0.45)})`;
      g.lineWidth = rngRange(rng, 0.8, 2.4);
      g.beginPath();
      g.moveTo(x0, y);
      g.quadraticCurveTo(x0 + w * 0.5, y + rngRange(rng, -1.6, 1.6), x0 + w, y);
      g.stroke();
    }
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

export function disposeTextures() {
  for (const tex of cache.values()) tex.dispose?.();
  cache.clear();
}
