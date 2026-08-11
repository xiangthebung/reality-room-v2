import * as THREE from 'three';

/**
 * Bucketed instance culling.
 *
 * The forest's instanced meshes each span the whole world, so three's own
 * frustum culling can never reject one — their bounding spheres always
 * intersect the view. The result was every tree, blade and frond submitted to
 * the GPU every frame, twice when the shadow map rendered, whichever way the
 * player was facing.
 *
 * The obvious fix — one InstancedMesh per map sector — multiplies scene
 * objects by the sector count, and three pays a per-object cost every frame
 * for every object whether visible or not. Twelve tree archetypes times two
 * meshes times a useful sector size is over a thousand objects, which moves
 * the cost from the GPU to the CPU and keeps it.
 *
 * So the sectors live INSIDE the buffers instead. Each mesh's instances are
 * sorted into XZ buckets and stored bucket-contiguous in a source array. When
 * the camera has moved or turned enough to matter, the visible buckets are
 * copied — whole buckets at a time, one typed-array `set` each — into the front
 * of the mesh's instance attributes and `mesh.count` is dropped to match. Draw
 * calls, materials and scene objects are exactly what they were; the GPU simply
 * stops being asked to transform what is behind the player.
 *
 * ONE PACKER, `packSlab`, AND IT USED TO BE TWO.
 *
 * There was a `packInstances` alongside it that took a finished list of
 * instances and owned it for the life of the mesh — the right shape for the
 * eager global scatter that used to build the world around the origin at load.
 * That scatter is gone (see forest.js), every instance in the world now arrives
 * from a worker, and a packer nothing calls is a second definition of "how an
 * instance reaches the screen" waiting to drift from the first. What was worth
 * keeping out of it is below: the incremental-repack argument, which was its
 * best idea and which `packSlab` inherited whole.
 *
 * The repack is NOT per frame. It runs when the camera has moved a couple of
 * metres or turned a few degrees since the last one, and the bucket spheres
 * are tested with a margin wide enough to cover everything that can happen
 * between repacks — threshold drift, the trip's camera sway and dolly, head
 * bob. Between repacks the visible set is simply a couple of metres generous.
 *
 * AND MOST REPACKS CHANGE NOTHING, WHICH IS WHY THEY ARE INCREMENTAL.
 *
 * The trigger is 2.5 m of travel or 3° of turn; the buckets are 18–44 m across
 * and tested with a 12 m margin. So the overwhelming majority of repacks
 * select exactly the same buckets in exactly the same order as the previous
 * one, and the old code cheerfully re-copied and re-uploaded the entire
 * visible set — about a megabyte across thirty attributes — to write the bytes
 * that were already there. Measured with a GPU timer query, forcing that on
 * every frame cost 1.32 ms of the GPU's time on a 2.75 ms frame, and the
 * `bufferSubData` calls block the main thread outright when the driver's queue
 * is deep: 216 ms in one batch of forty frames.
 *
 * Since the bucket order is fixed, two packs that select the same buckets
 * produce byte-identical buffers. So the packer remembers the bucket list it
 * last wrote, and:
 *
 *   - identical list  → nothing at all happens, not even a count assignment;
 *   - list diverges at position k → everything before k is already correct, so
 *     only the tail from k is copied and only that span is flagged for upload;
 *   - list is a prefix of the old one → only `mesh.count` moves. The instances
 *     past the count are stale, and that is exactly what the GPU already
 *     ignores.
 *
 * This is not an approximation. The output buffer is bit-for-bit what the
 * full repack would have produced, which is what makes it safe to leave
 * cull-check's zero-pixel-diff requirement standing over it.
 */

const _sphere = new THREE.Sphere();

/**
 * The same packer, for a layer whose instances arrive and leave while the game
 * is running.
 *
 * WHY IT IS A SLAB AND NOT A FINISHED LIST.
 *
 * The packer this replaced took a finished array of instances and owned it for
 * the life of the mesh. A streamed forest does not have a finished list:
 * sectors of trees are built in a worker and injected as the player walks, and
 * evicted behind him. The naive answers are both worse than they look.
 *
 * ONE InstancedMesh PER SECTOR was rejected in this file's own header, and the
 * arithmetic has only got worse since: twelve archetypes times two meshes times
 * the dozen sectors a 384 m ring holds is two hundred and eighty-eight scene
 * objects, each of which three pays for every frame in two passes whether it
 * draws anything or not, to replace twenty-four objects that already work.
 *
 * REBUILDING THE SOURCE ARRAY on every sector change is simple and costs a
 * 2.5 MB memcpy plus a bucket-list rebuild every time a sector lands. It is
 * survivable but it is pure waste: the instances that were already there have
 * not moved, and copying them somewhere else is work done solely to keep the
 * offsets contiguous.
 *
 * So the source array is a SLAB with a free list. A sector allocates a span
 * once, writes its instances into it, and never moves them; eviction returns
 * the span. What changes on a sector event is the bucket list, which is a few
 * hundred small objects rather than a few million floats.
 *
 *
 * A SECTOR EVENT FORCES A FULL REPACK, DELIBERATELY.
 *
 * The incremental path below remembers the bucket list it last wrote, by
 * INDEX. Insert or remove a bucket and every index after it means
 * something different, so the prefix the packer believes is already correct is
 * not — and the failure mode is not a crash or a blank screen, it is a buffer
 * that looks entirely plausible and draws the wrong trees. There is a version
 * of this that keeps the incremental path alive across sector changes, with
 * tombstoned buckets and stable indices, and it is not worth the class of bug
 * it invites for a saving of well under a millisecond on one frame in a
 * thousand. `writtenLength = -1` on every mutation; the arrays are regrown to
 * match; the next repack is a full one.
 *
 *
 * CAPACITY GROWS, AND GROWTH IS THE ONE EXPENSIVE THING IN HERE.
 *
 * How many pines end up in a 384 m ring is a property of the terrain the player
 * happens to be standing on — a sector on a ridge is nearly all pine, one on
 * the flood plain is mostly willow — so no single number is right, and sizing
 * for the worst case everywhere would allocate roughly twenty-six times what is
 * used. Instead capacity starts at an estimate and doubles when a sector will
 * not fit.
 *
 * Doubling, not growing to fit, because growth cannot be made free: three keys
 * its GL buffers on the attribute OBJECT, and there is no public way to release
 * the old one, so each growth orphans a buffer until the context goes away.
 * Doubling bounds that at a handful of events per layer in the first minute of
 * a session, after which the capacity is the largest the world has ever needed
 * and nothing grows again. `check:endless` watches the memory plateau over
 * 10 km precisely so that "and then it stops" is a measurement.
 *
 * @param {THREE.InstancedMesh} mesh  its instance attributes are replaced here
 * @param {{capacity?: number, bucketSize?: number, alwaysNear?: number,
 *          maxDistance?: number, margin?: number, thinnable?: boolean,
 *          color?: boolean, onGrow?: (n: number) => void}} options
 */
export function packSlab(
  mesh,
  {
    capacity = 4096,
    bucketSize = 24,
    alwaysNear = 0,
    /**
     * NOT zero, and the difference is a hole in the world.
     *
     * `horizontal` is the distance to the bucket's SURFACE — centre distance
     * minus radius — so it goes NEGATIVE for the bucket the eye is standing
     * inside, and for its neighbours out to a bucket radius. A default of 0
     * with a `<=` test therefore rejected the nearest trees in the world from
     * the near mesh, while the far mesh rejected them for being closer than its
     * minimum, and nothing drew them at all. It showed up as a clearing that
     * followed the player around, which is a much better description of the
     * symptom than of the cause.
     */
    minDistance = -Infinity,
    maxDistance = Infinity,
    margin = 12,
    thinnable = null,
    color = true,
    onGrow = null,
  } = {}
) {
  let cap = capacity;
  let srcMatrix = new Float32Array(cap * 16);
  let srcColor = color ? new Float32Array(cap * 3) : null;

  /** sector id -> { start, count } into the slab. */
  const spans = new Map();
  /** sector id -> the buckets it contributed. */
  const owned = new Map();
  /** Free spans, kept sorted by start and coalesced on release. */
  let free = [{ start: 0, count: cap }];

  let buckets = [];
  let written = new Int32Array(0);
  let candidate = new Int32Array(0);
  let writtenLength = -1;
  let grows = 0;

  mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  if (color) {
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;

  const canThin = thinnable ?? (mesh.name === 'grass' || mesh.name === 'ferns');
  let density = 1;
  const take = (b) => (density >= 1 ? b.count : Math.max(1, Math.ceil(b.count * density)));

  /**
   * The last eye `update` was given, remembered for `restoreAll`.
   *
   * `minDistance`/`maxDistance` are a LEVEL OF DETAIL band, not a culling
   * decision — a bucket outside a mesh's band is drawn by the mesh whose band
   * it is in, and the two bands are exactly complementary. So "restore
   * everything" has to mean "everything in this mesh's band", or the near and
   * far versions of the same tree would both be submitted and every distant
   * trunk in the frame would be drawn twice, in two different resolutions,
   * z-fighting with itself.
   *
   * That keeps `cull-check` honest rather than blinding it. What that test
   * exists to prove is that the FRUSTUM cull never removes a pixel, and it
   * still renders every bucket the frustum would have rejected. Null until the
   * first update, when there is no band because nothing has been culled yet.
   */
  let eyeX = null;
  let eyeZ = null;

  /** Whether a bucket belongs to this mesh at all, before any frustum test. */
  const inBand = (b) => {
    if (eyeX === null) return true;
    const dx = b.x - eyeX;
    const dz = b.z - eyeZ;
    // sqrt of the sum of squares rather than Math.hypot: hypot guards against
    // intermediate overflow with a scaling pass and is several times slower,
    // and this runs over every bucket of every layer on every repack — five
    // thousand of them for the streamed trees alone.
    const horizontal = Math.sqrt(dx * dx + dz * dz) - b.radius;
    return horizontal > minDistance && horizontal <= maxDistance;
  };

  function grow(atLeast) {
    let next = cap;
    while (next < atLeast) next *= 2;
    const oldMatrix = srcMatrix;
    const oldColor = srcColor;
    srcMatrix = new Float32Array(next * 16);
    srcMatrix.set(oldMatrix);
    if (color) {
      srcColor = new Float32Array(next * 3);
      srcColor.set(oldColor);
    }
    // Every live span keeps its offset, so nothing about the spans, the buckets
    // or the free list below `cap` changes — the new room is one free span on
    // the end, coalesced with whatever tail was already free.
    const tail = free[free.length - 1];
    if (tail && tail.start + tail.count === cap) tail.count += next - cap;
    else free.push({ start: cap, count: next - cap });
    cap = next;

    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (color) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    grows++;
    onGrow?.(cap);
  }

  /** First fit. The free list is a handful of entries; anything cleverer is theatre. */
  function alloc(n) {
    for (let i = 0; i < free.length; i++) {
      if (free[i].count < n) continue;
      const start = free[i].start;
      free[i].start += n;
      free[i].count -= n;
      if (free[i].count === 0) free.splice(i, 1);
      return start;
    }
    /**
     * Nothing big enough. Coalescing first is not optional and it is not the
     * same as growing: the ring translates as the player walks, so spans are
     * released on one side and requested on the other, and without coalescing a
     * layer would fragment into sector-sized holes and grow for ever while
     * using a third of its capacity.
     */
    coalesce();
    for (let i = 0; i < free.length; i++) {
      if (free[i].count < n) continue;
      const start = free[i].start;
      free[i].start += n;
      free[i].count -= n;
      if (free[i].count === 0) free.splice(i, 1);
      return start;
    }
    grow(cap + n);
    return alloc(n);
  }

  function coalesce() {
    free.sort((a, b) => a.start - b.start);
    const out = [];
    for (const span of free) {
      const last = out[out.length - 1];
      if (last && last.start + last.count === span.start) last.count += span.count;
      else out.push({ ...span });
    }
    free = out;
  }

  function release(start, count) {
    free.push({ start, count });
    coalesce();
  }

  /** Flatten the per-sector bucket lists and resize the diff bookkeeping. */
  function rebuild() {
    buckets = [];
    for (const list of owned.values()) for (const b of list) buckets.push(b);
    if (written.length < buckets.length) {
      written = new Int32Array(buckets.length);
      candidate = new Int32Array(buckets.length);
    }
    writtenLength = -1;
    mesh.visible = buckets.length > 0;
  }

  return {
    mesh,
    get instanceCount() {
      let n = 0;
      for (const span of spans.values()) n += span.count;
      return n;
    },
    get capacity() {
      return cap;
    },
    get grows() {
      return grows;
    },

    /**
     * Take one sector's worth of already-bucketed instances.
     *
     * `matrix` and `color` are bucket-contiguous as the worker emitted them,
     * and `table` is six floats per bucket: centre x, y, z, radius, start,
     * count — with `start` relative to this sector, which is why it is rebased
     * onto the span here and nowhere else.
     */
    insert(id, { matrix, color: instanceColor, buckets: table }) {
      if (spans.has(id)) return;
      const n = matrix.length / 16;
      if (n === 0) return;
      const start = alloc(n);
      srcMatrix.set(matrix, start * 16);
      if (srcColor && instanceColor) srcColor.set(instanceColor, start * 3);
      const list = [];
      for (let b = 0; b < table.length; b += 6) {
        list.push({
          x: table[b],
          y: table[b + 1],
          z: table[b + 2],
          radius: table[b + 3],
          start: start + table[b + 4],
          count: table[b + 5],
        });
      }
      spans.set(id, { start, count: n });
      owned.set(id, list);
      rebuild();
    },

    remove(id) {
      const span = spans.get(id);
      if (!span) return;
      spans.delete(id);
      owned.delete(id);
      release(span.start, span.count);
      rebuild();
    },

    has(id) {
      return spans.has(id);
    },

    setDensity(d) {
      const next = canThin ? Math.min(1, Math.max(0.05, d)) : 1;
      if (next === density) return;
      density = next;
      writtenLength = -1;
    },

    /**
     * What this packer believes about its own buckets, for `cull-diff.mjs`.
     *
     * The near and far halves of a tree are two packers over one payload, and
     * a bucket must land in exactly one of their bands. When that fails the
     * symptom is a frame, not a number — either a trunk missing or the same
     * trunk drawn at two resolutions z-fighting with itself — so being able to
     * ask each packer directly is the difference between finding it and
     * guessing.
     */
    bandStats(eye) {
      let inBandNow = 0;
      for (const b of buckets) {
        const dx = b.x - eye.x;
        const dz = b.z - eye.z;
        const horizontal = Math.sqrt(dx * dx + dz * dz) - b.radius;
        if (horizontal > minDistance && horizontal <= maxDistance) inBandNow++;
      }
      return {
        name: mesh.name,
        id: mesh.id,
        buckets: buckets.length,
        // Null here is the bug this exists to catch: `update` returns early on
        // an empty packer BEFORE recording the eye, so a packer that was ever
        // empty answers `inBand` with "everything" until its next real update.
        eyeSeen: eyeX !== null,
        minDistance,
        maxDistance,
        inBandNow,
        inBandStored: buckets.reduce((n, b) => n + (inBand(b) ? 1 : 0), 0),
      };
    },

    restoreAll() {
      const dstMatrix = mesh.instanceMatrix.array;
      const dstColor = mesh.instanceColor ? mesh.instanceColor.array : null;
      /**
       * Bucket by bucket even at full density. The obvious `set` of the whole
       * source in one go is wrong here: the slab has holes in it wherever a
       * sector was evicted, and copying it wholesale would submit whatever an
       * evicted sector left behind.
       */
      let write = 0;
      for (const b of buckets) {
        if (!inBand(b)) continue;
        const c = take(b);
        dstMatrix.set(srcMatrix.subarray(b.start * 16, (b.start + c) * 16), write * 16);
        if (dstColor && srcColor) {
          dstColor.set(srcColor.subarray(b.start * 3, (b.start + c) * 3), write * 3);
        }
        write += c;
      }
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) {
        mesh.instanceColor.clearUpdateRanges();
        mesh.instanceColor.needsUpdate = true;
      }
      mesh.count = write;
      mesh.visible = write > 0;
      writtenLength = -1;
    },

    update(frustum, eye) {
      if (buckets.length === 0) {
        mesh.count = 0;
        mesh.visible = false;
        writtenLength = -1;
        return 0;
      }
      eyeX = eye.x;
      eyeZ = eye.z;
      let diverged = writtenLength < 0 ? 0 : -1;
      let keep = 0;
      let length = 0;
      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        const dx = b.x - eye.x;
        const dz = b.z - eye.z;
        const horizontal = Math.sqrt(dx * dx + dz * dz) - b.radius;
        if (horizontal > maxDistance || horizontal <= minDistance) continue;
        if (horizontal > alwaysNear) {
          _sphere.center.set(b.x, b.y, b.z);
          _sphere.radius = b.radius + margin;
          if (!frustum.intersectsSphere(_sphere)) continue;
        }
        if (diverged < 0) {
          if (length >= writtenLength || written[length] !== i) diverged = length;
          else keep += take(b);
        }
        candidate[length++] = i;
      }

      if (diverged < 0 && length === writtenLength) return 0;
      if (diverged < 0) diverged = length;

      const dstMatrix = mesh.instanceMatrix.array;
      const dstColor = mesh.instanceColor ? mesh.instanceColor.array : null;
      let write = keep;
      for (let k = diverged; k < length; k++) {
        const b = buckets[candidate[k]];
        const c = take(b);
        dstMatrix.set(srcMatrix.subarray(b.start * 16, (b.start + c) * 16), write * 16);
        if (dstColor && srcColor) {
          dstColor.set(srcColor.subarray(b.start * 3, (b.start + c) * 3), write * 3);
        }
        write += c;
      }
      mesh.count = write;
      /**
       * `visible` rather than relying on a zero count, and it is worth 0.1 ms.
       *
       * three's buffer renderer early-returns on an instance count of zero, so
       * an empty mesh draws nothing — but it has already been walked in
       * `projectObject`, sorted into the render list, had its program selected
       * and its vertex array bound by the time it gets there. `visible = false`
       * is tested at the top of `projectObject` and skips all of it. With
       * thirty-odd streamed layers and two passes a frame, most of them empty
       * whenever the player is looking the other way, that is not nothing.
       */
      mesh.visible = write > 0;
      if (write > keep) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(keep * 16, (write - keep) * 16);
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) {
          mesh.instanceColor.clearUpdateRanges();
          mesh.instanceColor.addUpdateRange(keep * 3, (write - keep) * 3);
          mesh.instanceColor.needsUpdate = true;
        }
      }
      written.set(candidate.subarray(0, length));
      writtenLength = length;
      return write - keep;
    },
  };
}

/**
 * Owns the packers and decides when a repack is worth doing.
 *
 * The thresholds and the packer margin are a pair: a repack fires after 2.5 m
 * of travel or ~3° of turn, and the margin covers the drift a set can
 * accumulate before the next one — threshold movement plus the trip camera's
 * sway and dolly (≤ ~1.3 m) with room to spare. Raise the thresholds and the
 * margin must grow with them.
 */
export class InstanceCuller {
  constructor() {
    this.packers = [];
    /**
     * Instances re-copied by the last repack that did any work at all.
     *
     * Kept because the claim "most repacks change nothing" is the whole
     * justification for the incremental path, and a claim like that needs to
     * be readable from a test script rather than believed. scripts/stutter.mjs
     * reports it per repack.
     */
    this.uploaded = 0;
    this._matrix = new THREE.Matrix4();
    this._frustum = new THREE.Frustum();
    this._lastPosition = new THREE.Vector3(Infinity, Infinity, Infinity);
    this._lastQuaternion = new THREE.Quaternion(0, 0, 0, 0);
    this._lastFov = 0;
  }

  add(packer) {
    this.packers.push(packer);
  }

  /** Every instance of every layer, frustum ignored. See packer.restoreAll. */
  restoreAll() {
    for (const packer of this.packers) packer.restoreAll();
    this._lastPosition.set(Infinity, Infinity, Infinity);
  }

  /**
   * Thin the undergrowth. 1 is everything; layers that refuse ignore it.
   *
   * Forgetting the last camera pose is not optional here. Nothing about the
   * camera has changed, so update()'s movement test would decline to run and
   * the new density would not reach the buffer until the player next walked
   * two and a half metres — which reads as a slider that does nothing.
   */
  setDensity(d) {
    for (const packer of this.packers) packer.setDensity(d);
    this._lastPosition.set(Infinity, Infinity, Infinity);
  }

  update(camera, force = false) {
    const moved =
      camera.position.distanceToSquared(this._lastPosition) > 2.5 * 2.5;
    // |q1·q2| = cos(θ/2); this threshold is roughly a 3° turn.
    const turned = Math.abs(camera.quaternion.dot(this._lastQuaternion)) < 0.99966;
    const zoomed = Math.abs(camera.fov - this._lastFov) > 0.25;
    if (!force && !moved && !turned && !zoomed) return false;

    camera.updateMatrixWorld();
    this._matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._matrix);
    this.uploaded = 0;
    for (const packer of this.packers) this.uploaded += packer.update(this._frustum, camera.position);

    this._lastPosition.copy(camera.position);
    this._lastQuaternion.copy(camera.quaternion);
    this._lastFov = camera.fov;
    return true;
  }
}
