import * as THREE from 'three';
import { clamp01, fbm2, noise2 } from '../src/core/util.js';
import { WORLD_RADIUS, heightAt, heightGrid, slopeAt, wetness } from '../src/world/terrain.js';

/**
 * Prove the stage-0 refactor changed nothing it was not supposed to change.
 *
 *   node scripts/world-gridcheck.mjs
 *
 * `heightGrid()` replaced a loop over a PlaneGeometry. That loop is reproduced
 * below VERBATIM, from the commit before the change, and the two are compared
 * vertex for vertex. Embedding the old code rather than diffing against git is
 * deliberate: this file then keeps working as a regression test after the old
 * one is gone, and it says out loud what the reference actually was.
 *
 * Three of the five buffers must match exactly and two must not:
 *
 *   position  identical. Same lattice, same float32 rounding, same order.
 *   index     identical. Same winding.
 *   aWet      identical. `wetness` is unchanged and takes no derivative.
 *   normal    DIFFERENT, and that is the point — averaged face normals against
 *             an analytic central difference. Reported as an angle, and a few
 *             degrees is the expected answer.
 *   color     slightly different, because the `slope` feeding the blend now
 *             comes from the 1.6 m central difference instead of `slopeAt`'s
 *             fixed 0.7 m one. Measured rather than asserted away.
 *
 * It also checks the two properties the streaming depends on, which the old
 * single-plate code never had to have:
 *
 *   - two adjacent chunks agree BIT FOR BIT on their shared edge, in height,
 *     in normal and in colour. Anything less and the breath displacement opens
 *     a crack along every border.
 *   - `heightAt` inside d < 163.4 m is unchanged by deleting the `edge` term.
 */

const fail = [];
const note = (ok, label, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${detail}`);
  if (!ok) fail.push(label);
};

/* -------------------------------------------------------------------------- */
/* the reference: buildTerrainGeometry() as it stood before heightGrid()       */
/* -------------------------------------------------------------------------- */

const CELL = 1.6;

function referenceGeometry() {
  const span = WORLD_RADIUS * 2;
  const segments = Math.round(span / CELL);
  const geo = new THREE.PlaneGeometry(span, span, segments, segments);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const count = pos.count;
  const colours = new Float32Array(count * 3);
  const damp = new Float32Array(count);

  const moss = new THREE.Color(0x5c7a3c);
  const litter = new THREE.Color(0x6a5231);
  const dry = new THREE.Color(0x8a7d47);
  const gravel = new THREE.Color(0x77736a);
  const tmp = new THREE.Color();
  const shade = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = heightAt(x, z);
    pos.setY(i, h);

    const slope = slopeAt(x, z);
    const wet = wetness(x, z);
    const patch = fbm2(x * 0.045 + 91, z * 0.045 - 33, 2) * 0.5 + 0.5;

    tmp.copy(moss).lerp(litter, clamp01(patch * 1.35 - 0.12));
    tmp.lerp(dry, clamp01(slope * 2.1 - 0.25));
    tmp.lerp(gravel, clamp01((wet - 0.45) * 2.6));
    const alt = clamp01((h + 6) / 40);
    tmp.lerp(shade.copy(tmp).offsetHSL(-0.02, -0.16 * alt, 0.1 * alt), alt);

    const grain =
      noise2(x * 0.62 + 71, z * 0.62 - 19) * 0.5 + noise2(x * 1.7 - 5, z * 1.7 + 41) * 0.25;
    tmp.offsetHSL(grain * 0.035, grain * 0.1, grain * 0.16);

    colours[i * 3] = tmp.r;
    colours[i * 3 + 1] = tmp.g;
    colours[i * 3 + 2] = tmp.b;
    damp[i] = wet;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geo.setAttribute('aWet', new THREE.BufferAttribute(damp, 1));
  geo.computeVertexNormals();
  return geo;
}

/* -------------------------------------------------------------------------- */
/* 1. the plate, vertex for vertex                                            */
/* -------------------------------------------------------------------------- */

console.log('heightGrid() against the PlaneGeometry loop it replaced\n');

let t0 = Date.now();
const ref = referenceGeometry();
const refMs = Date.now() - t0;
const span = WORLD_RADIUS * 2;
const segments = Math.round(span / CELL);
t0 = Date.now();
const grid = heightGrid(-WORLD_RADIUS, -WORLD_RADIUS, segments, span / segments, {
  worldXZ: true,
});
const gridMs = Date.now() - t0;

const rp = ref.attributes.position.array;
const rn = ref.attributes.normal.array;
const rc = ref.attributes.color.array;
const rw = ref.attributes.aWet.array;
const ri = ref.index.array;
const n = ref.attributes.position.count;

note(
  n === grid.position.length / 3,
  'vertex count',
  `${n} vertices, ${segments}² quads, cell ${(span / segments).toFixed(6)} m`
);

let dPos = 0;
let dHeight = 0;
let dWet = 0;
for (let i = 0; i < n; i++) {
  dPos = Math.max(dPos, Math.abs(rp[i * 3] - grid.position[i * 3]));
  dPos = Math.max(dPos, Math.abs(rp[i * 3 + 2] - grid.position[i * 3 + 2]));
  dHeight = Math.max(dHeight, Math.abs(rp[i * 3 + 1] - grid.position[i * 3 + 1]));
  dWet = Math.max(dWet, Math.abs(rw[i] - grid.aWet[i]));
}
note(dPos === 0, 'x/z lattice identical', `max |Δ| ${dPos}`);
note(dHeight < 1e-9, 'heights identical to 1e-9', `max |Δ| ${dHeight}`);
note(dWet === 0, 'aWet identical', `max |Δ| ${dWet}`);

let dIndex = 0;
for (let i = 0; i < ri.length; i++) if (ri[i] !== grid.index[i]) dIndex++;
note(
  ri.length === grid.index.length && dIndex === 0,
  'index buffer identical',
  `${ri.length} indices, ${dIndex} differ`
);

/**
 * Normals: expected to differ, and split by whether the vertex is on the
 * plate's boundary.
 *
 * The interior number is the honest "averaged faces against an analytic central
 * difference" comparison and should be a fraction of a degree. The BOUNDARY
 * number is the bug being fixed: `computeVertexNormals` averages only the faces
 * that exist, so an edge vertex has half its neighbourhood missing and comes out
 * tilted by whole degrees. On one plate that was a cosmetic rim nobody looked
 * at. On a field of chunks it is a mismatched normal on both sides of every
 * shared edge, displaced along by the breath — a crack that opens and shuts
 * seven times a minute. If these two numbers are not clearly different, the
 * padding is not doing anything.
 */
const gridSide = segments + 1;
let maxAngle = 0;
let sumAngle = 0;
let interior = 0;
let maxEdgeAngle = 0;
let sumEdgeAngle = 0;
let edges = 0;
for (let i = 0; i < n; i++) {
  const d =
    rn[i * 3] * grid.normal[i * 3] +
    rn[i * 3 + 1] * grid.normal[i * 3 + 1] +
    rn[i * 3 + 2] * grid.normal[i * 3 + 2];
  const a = (Math.acos(Math.min(1, Math.max(-1, d))) * 180) / Math.PI;
  const ix = i % gridSide;
  const iy = (i / gridSide) | 0;
  const onEdge = ix === 0 || iy === 0 || ix === gridSide - 1 || iy === gridSide - 1;
  if (onEdge) {
    edges++;
    sumEdgeAngle += a;
    if (a > maxEdgeAngle) maxEdgeAngle = a;
  } else {
    interior++;
    sumAngle += a;
    if (a > maxAngle) maxAngle = a;
  }
}
note(
  maxAngle < 4,
  'normals, interior (expected to differ slightly)',
  `mean ${(sumAngle / interior).toFixed(3)}°, max ${maxAngle.toFixed(3)}°`
);
note(
  sumEdgeAngle / edges > (sumAngle / interior) * 3,
  'normals, boundary — the seam the padding fixes',
  `mean ${(sumEdgeAngle / edges).toFixed(3)}°, max ${maxEdgeAngle.toFixed(3)}° over ${edges} rim vertices`
);

// Colours: expected to differ only where the two slope estimates disagree.
let maxCol = 0;
let sumCol = 0;
let over1of255 = 0;
for (let i = 0; i < n * 3; i++) {
  const d = Math.abs(rc[i] - grid.color[i]);
  sumCol += d;
  if (d > maxCol) maxCol = d;
  if (d > 1 / 255) over1of255++;
}
note(
  maxCol < 0.12,
  'colours track (slope now taken at the cell)',
  `mean Δ ${(sumCol / (n * 3)).toFixed(6)}, max ${maxCol.toFixed(5)}, ` +
    `${((over1of255 / (n * 3)) * 100).toFixed(2)}% of channels over 1/255`
);

console.log(`\n     build cost: reference ${refMs} ms, heightGrid ${gridMs} ms\n`);

/* -------------------------------------------------------------------------- */
/* 2. the seam between two chunks                                             */
/* -------------------------------------------------------------------------- */

const CHUNK = 128;
const SEG = 80;
const CHUNK_CELL = CHUNK / SEG;

const a = heightGrid(0, 0, SEG, CHUNK_CELL);
const b = heightGrid(CHUNK, 0, SEG, CHUNK_CELL);
const c = heightGrid(0, CHUNK, SEG, CHUNK_CELL);
const side = SEG + 1;

let seamPos = 0;
let seamNrm = 0;
let seamCol = 0;
for (let j = 0; j < side; j++) {
  // a's east column (i = SEG) against b's west column (i = 0).
  const ia = j * side + SEG;
  const ib = j * side + 0;
  seamPos = Math.max(seamPos, Math.abs(a.position[ia * 3 + 1] - b.position[ib * 3 + 1]));
  for (let k = 0; k < 3; k++) {
    seamNrm = Math.max(seamNrm, Math.abs(a.normal[ia * 3 + k] - b.normal[ib * 3 + k]));
    seamCol = Math.max(seamCol, Math.abs(a.color[ia * 3 + k] - b.color[ib * 3 + k]));
  }
  // a's north row (j = SEG) against c's south row (j = 0).
  const ja = SEG * side + j;
  const jc = 0 * side + j;
  seamPos = Math.max(seamPos, Math.abs(a.position[ja * 3 + 1] - c.position[jc * 3 + 1]));
  for (let k = 0; k < 3; k++) {
    seamNrm = Math.max(seamNrm, Math.abs(a.normal[ja * 3 + k] - c.normal[jc * 3 + k]));
    seamCol = Math.max(seamCol, Math.abs(a.color[ja * 3 + k] - c.color[jc * 3 + k]));
  }
}
note(seamPos === 0, 'chunk seam: heights bit-identical', `max |Δ| ${seamPos}`);
note(seamNrm === 0, 'chunk seam: normals bit-identical', `max |Δ| ${seamNrm}`);
note(seamCol === 0, 'chunk seam: colours bit-identical', `max |Δ| ${seamCol}`);

// And the chunk lattice really does land on the world coordinates it claims.
let latticeErr = 0;
for (let j = 0; j < side; j++) {
  for (let i = 0; i < side; i++) {
    const k = (j * side + i) * 3;
    latticeErr = Math.max(latticeErr, Math.abs(b.position[k] + CHUNK - (CHUNK + i * CHUNK_CELL)));
  }
}
note(latticeErr < 1e-4, 'chunk x/z are local, offset by the origin', `max |Δ| ${latticeErr}`);

/* -------------------------------------------------------------------------- */
/* 3. the edge term, inside 163.4 m                                           */
/* -------------------------------------------------------------------------- */

/**
 * `heightAt` used to end with
 *
 *   const edge = smoothstep(clamp01((d - WORLD_RADIUS * 0.86) / (WORLD_RADIUS * 0.34)));
 *   h = lerp(h, h + 16 + edge * 40, edge);
 *
 * `WORLD_RADIUS * 0.86` is 163.4, and `clamp01` pins the argument at 0 below
 * it, so `smoothstep(0)` is 0 and the lerp is the identity. Deleting the term
 * therefore cannot move a single height inside that radius — this samples it
 * rather than taking the algebra's word for it, because "it is zero there" is
 * exactly the kind of claim that is true of the code somebody meant to write.
 */
const LIMIT = WORLD_RADIUS * 0.86;
function withEdge(x, z) {
  const h = heightAt(x, z);
  const d = Math.hypot(x, z);
  const t = clamp01((d - WORLD_RADIUS * 0.86) / (WORLD_RADIUS * 0.34));
  const edge = t * t * (3 - 2 * t);
  return h + (h + 16 + edge * 40 - h) * edge;
}

let inside = 0;
let insideMax = 0;
let outside = 0;
let outsideMax = 0;
for (let i = 0; i < 400000; i++) {
  // A spiral rather than a grid, so the sample set is not correlated with the
  // 1.6 m lattice the mesh happens to use.
  const ang = i * 2.399963229728653;
  const r = Math.sqrt(i / 400000) * WORLD_RADIUS * 1.15;
  const x = Math.cos(ang) * r;
  const z = Math.sin(ang) * r;
  const d = Math.max(0, Math.abs(withEdge(x, z) - heightAt(x, z)));
  if (Math.hypot(x, z) <= LIMIT) {
    inside++;
    insideMax = Math.max(insideMax, d);
  } else {
    outside++;
    outsideMax = Math.max(outsideMax, d);
  }
}
note(
  insideMax === 0,
  `heightAt bit-identical inside ${LIMIT.toFixed(1)} m`,
  `${inside} samples, max |Δ| ${insideMax}`
);
note(
  outsideMax > 0,
  'and the outer ring really did change',
  `${outside} samples, max |Δ| ${outsideMax.toFixed(2)} m`
);

console.log(fail.length ? `\nFAIL: ${fail.join(', ')}` : '\nPASS');
process.exit(fail.length ? 1 : 0);
