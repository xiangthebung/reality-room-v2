/**
 * Is the incremental packer bit-for-bit what a full repack would have written?
 *
 * `cull-check.mjs` answers this in pixels, which is the answer that matters but
 * needs a browser and only covers the poses it happens to visit. This answers
 * it in bytes over a randomised sequence of the four things that can happen to
 * a slab — a sector arrives, a sector is evicted, the camera moves, the camera
 * turns — by running two identical packers side by side and forcing one of them
 * to repack from scratch every time.
 */
import * as THREE from 'three';
import { packSlab } from '../../src/world/culling.js';

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function makeMesh(name) {
  const m = new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(), 1);
  m.name = name;
  return m;
}

/** One sector's worth of bucketed instances, deterministic in `id`. */
function payload(id, sx, sz) {
  const nBuckets = 2 + Math.floor(rnd() * 5);
  const matrix = [];
  const color = [];
  const table = [];
  let start = 0;
  for (let b = 0; b < nBuckets; b++) {
    const count = 1 + Math.floor(rnd() * 6);
    const cx = sx * 100 + b * 25 + rnd() * 5;
    const cz = sz * 100 + b * 11 + rnd() * 5;
    table.push(cx, 3, cz, 12, start, count);
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 16; k++) matrix.push(id * 1000 + b * 100 + i * 16 + k + rnd());
      color.push(rnd(), rnd(), rnd());
    }
    start += count;
  }
  return {
    matrix: new Float32Array(matrix),
    color: new Float32Array(color),
    buckets: new Float32Array(table),
  };
}

const OPTS = { capacity: 64, bucketSize: 24, alwaysNear: 0, margin: 12, thinnable: false };
const incMesh = makeMesh('inc');
const refMesh = makeMesh('ref');
const inc = packSlab(incMesh, { ...OPTS });
const ref = packSlab(refMesh, { ...OPTS });

const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
const frustum = new THREE.Frustum();
const mat = new THREE.Matrix4();
const live = [];
let checks = 0;
let mismatches = 0;
let fastPathHits = 0;

function aim(x, z, yaw) {
  camera.position.set(x, 2, z);
  camera.rotation.set(0, yaw, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  mat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(mat);
}

let lastOp = '';
let lastPose = false;
let drifted = false;
const _p = new THREE.Vector3();
let subsetChecks = 0;
let dropped = 0;
/**
 * Nothing the reference draws INSIDE the frustum may be missing from the
 * incremental buffer. The margin means the reference also carries buckets just
 * outside it, and those are allowed to differ.
 */
function compareVisible(where) {
  subsetChecks++;
  const have = new Set();
  const a = incMesh.instanceMatrix.array;
  for (let i = 0; i < incMesh.count; i++) {
    have.add(`${a[i * 16 + 12]},${a[i * 16 + 13]},${a[i * 16 + 14]}`);
  }
  const b = refMesh.instanceMatrix.array;
  for (let i = 0; i < refMesh.count; i++) {
    _p.set(b[i * 16 + 12], b[i * 16 + 13], b[i * 16 + 14]);
    if (!frustum.containsPoint(_p)) continue;
    if (have.has(`${b[i * 16 + 12]},${b[i * 16 + 13]},${b[i * 16 + 14]}`)) continue;
    dropped++;
    if (dropped < 5) console.log(`  DROPPED an in-frustum instance at ${where}`);
    return;
  }
}

function compare(where) {
  checks++;
  if (incMesh.count !== refMesh.count) {
    mismatches++;
    console.log(`  MISMATCH count at ${where} op=${lastOp}: ${incMesh.count} vs ${refMesh.count}  grows ${inc.grows}/${ref.grows} cap ${inc.capacity}/${ref.capacity} n ${inc.instanceCount}/${ref.instanceCount} poseUnchanged=${lastPose}`);
    return;
  }
  const a = incMesh.instanceMatrix.array;
  const b = refMesh.instanceMatrix.array;
  for (let i = 0; i < incMesh.count * 16; i++) {
    if (a[i] !== b[i]) {
      mismatches++;
      console.log(`  MISMATCH matrix[${i}] at ${where}: ${a[i]} vs ${b[i]} (count ${incMesh.count})`);
      return;
    }
  }
  const ca = incMesh.instanceColor.array;
  const cb = refMesh.instanceColor.array;
  for (let i = 0; i < incMesh.count * 3; i++) {
    if (ca[i] !== cb[i]) {
      mismatches++;
      console.log(`  MISMATCH color[${i}] at ${where}`);
      return;
    }
  }
  if (incMesh.visible !== refMesh.visible) {
    mismatches++;
    console.log(`  MISMATCH visible at ${where}: ${incMesh.visible} vs ${refMesh.visible}`);
  }
}

const lastPos = new THREE.Vector3(Infinity, Infinity, Infinity);
const lastQuat = new THREE.Quaternion(0, 0, 0, 0);
let nextId = 0;
let px = 0;
let pz = 0;
let yaw = 0;
aim(px, pz, yaw);

for (let step = 0; step < 4000; step++) {
  const roll = rnd();
  if (roll < 0.3 || live.length < 3) {
    const id = `s${nextId++}`;
    const p = payload(nextId, Math.floor(rnd() * 6) - 3, Math.floor(rnd() * 6) - 3);
    inc.insert(id, p);
    ref.insert(id, p);
    live.push(id);
    lastOp = 'insert';
  } else if (roll < 0.5) {
    const at = Math.floor(rnd() * live.length);
    const id = live.splice(at, 1)[0];
    inc.remove(id);
    ref.remove(id);
    lastOp = 'remove';
  } else if (roll < 0.75) {
    // Move less than the culler's 2.5 m threshold: this is the case that makes
    // the culler pass poseUnchanged, and the one the fast path exists for.
    // Deliberately NOT a move. This is the case the fast path is for: the
    // camera is where it was at the last repack and a sector event forced a
    // repack anyway. Here byte-identity with a full repack must hold exactly.
    lastOp = 'still';
  } else if (roll < 0.88) {
    // Below the culler's 2.5 m threshold, so it still reports poseUnchanged.
    // Byte-identity CANNOT hold here and is not claimed: the old buckets keep
    // the answer they were given at the last repack, which is exactly the
    // staleness the 12 m bucket margin is sized to absorb. What must hold is
    // that nothing actually inside the frustum went missing.
    px += rnd() * 0.6 - 0.3;
    pz += rnd() * 0.6 - 0.3;
    aim(px, pz, yaw);
    lastOp = 'creep';
  } else {
    px += rnd() * 40 - 20;
    pz += rnd() * 40 - 20;
    yaw += rnd() * 2 - 1;
    aim(px, pz, yaw);
    lastOp = 'jump';
  }

  /**
   * EXACTLY InstanceCuller.update's decision, because `poseUnchanged` is a
   * claim about the last REPACK and not about the last frame — a test that
   * asserts it after moving the camera is asserting something false, and the
   * packer is entitled to believe it.
   */
  const mutated = roll < 0.5;
  const moved = camera.position.distanceToSquared(lastPos) > 2.5 * 2.5;
  const turned = Math.abs(camera.quaternion.dot(lastQuat)) < 0.99966;
  if (!mutated && !moved && !turned) continue;
  const poseUnchanged = !moved && !turned;
  if (poseUnchanged) fastPathHits++;
  lastPose = poseUnchanged;

  /**
   * Byte-identity is only claimable while the pose has not moved AT ALL since
   * the last full repack. One sub-threshold creep and the incremental buffer
   * legitimately keeps the older frustum's answers — and keeps them until the
   * next pose-changing repack rebuilds from scratch — so from that point until
   * then the weaker, and true, property is the one to assert.
   */
  const crept = poseUnchanged && !camera.position.equals(lastPos);
  if (crept) drifted = true;
  inc.update(frustum, camera.position, poseUnchanged);
  ref.restoreAll();
  ref.update(frustum, camera.position, false);
  lastPos.copy(camera.position);
  lastQuat.copy(camera.quaternion);
  if (!poseUnchanged) drifted = false;
  if (drifted) compareVisible(`step ${step}`);
  else compare(`step ${step}`);
}

console.log(
  `\n${checks} comparisons, ${fastPathHits} of them after a pose-unchanged update, ` +
    `${mismatches} mismatches`
);
console.log(`${subsetChecks} sub-threshold-drift comparisons: ${dropped} in-frustum instances dropped`);
const bad = mismatches + dropped;
console.log(
  bad
    ? 'FAIL'
    : 'PASS: byte-identical to a full repack while the pose holds, and nothing\n' +
      '      inside the frustum is lost once it has drifted below threshold'
);
process.exit(bad ? 1 : 0);
