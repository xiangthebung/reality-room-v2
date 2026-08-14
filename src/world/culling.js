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
 *
 * THAT SENTENCE IS ABOUT THE ARRAY, NOT ABOUT THE GPU, and for a long time only
 * the first half was true. "Only that span is flagged for upload" is a promise
 * that has to be kept across every repack that happens before the next draw, and
 * there is no rule anywhere that those are one to one — behind the main menu
 * there are five or six repacks per drawn frame. See `flagUpload`.
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
 * A SECTOR EVENT USED TO FORCE A FULL REPACK, AND NOW FORCES A SUFFIX.
 *
 * The incremental path below remembers the bucket list it last wrote, by
 * INDEX. Insert or remove a bucket and every index after it means something
 * different, so the prefix the packer believes is already correct is not — and
 * the failure mode is not a crash or a blank screen, it is a buffer that looks
 * entirely plausible and draws the wrong trees. That argument was right, and
 * `writtenLength = -1` on every mutation was the safe answer to it. What it
 * missed is that the two mutations are not symmetric:
 *
 *   INSERT APPENDS. `owned` is a Map and a new sector is a new key, so its
 *   buckets go on the END of the flattened list. Every index that already
 *   existed still means what it meant. `written` is therefore still true, and
 *   because `update` builds its candidate list in ascending bucket order the
 *   new buckets can only ever appear AFTER every old one — so the diff
 *   diverges at the first new visible bucket and copies from there. A tree
 *   sector landing 384 m behind the player is out of the frustum entirely and
 *   the repack it forces is now literally zero bytes, where it used to be the
 *   whole visible set.
 *
 *   REMOVE SHIFTS, but only from the removed span onwards. Everything before
 *   the evicted sector's first bucket keeps its index, and `written` is
 *   strictly ascending, so the prefix of it that is still valid is exactly the
 *   entries below that index. Truncating to there is the same argument the
 *   incremental path already makes about the camera moving, applied to the
 *   bucket list instead of the frustum.
 *
 * THE COUNT HAS TO COME DOWN WITH THE TRUNCATION, and this is the one trap in
 * here. `update` early-returns without touching `mesh.count` when the candidate
 * list matches what was written — so if a removal shortened `writtenLength`
 * without shortening `count`, the very next repack could decline to do anything
 * while the mesh still drew instances belonging to the sector that was just
 * evicted. Their slab span is already back on the free list, so those bytes are
 * whatever the last tenant left. `truncateWritten` therefore recomputes the
 * count of the prefix it keeps, which is O(visible buckets) and correct by the
 * same arithmetic `update` uses.
 *
 * What is NOT attempted is a stable-index scheme with tombstones: it buys
 * nothing over this, since the prefix argument already covers the case that
 * matters, and it is the version that invites the plausible-but-wrong buffer.
 *
 *
 * THE ONE THING THIS GIVES UP, STATED PLAINLY.
 *
 * A sector-event repack used to re-test every bucket against the CURRENT
 * frustum, so it doubled as a free refresh of the whole visible set. It does
 * not any more: the buckets that were already resident keep the answer they
 * were given at the last repack, and only the arriving ones are tested now.
 *
 * That is not a new approximation, it is the existing one. `InstanceCuller`
 * only repacks after 2.5 m of travel or ~3° of turn, so between repacks the
 * visible set is ALREADY up to that stale, and the 12 m bucket margin exists
 * precisely to cover it — "Between repacks the visible set is simply a couple
 * of metres generous", as this file has said from the start. A sector event no
 * longer resets that clock early, so the staleness is bounded by the same
 * threshold it always was and by nothing new. What used to happen was a bonus,
 * not a guarantee, and it cost a full repack to get.
 *
 * Both halves of that are checked rather than argued: over four thousand
 * randomised sector events and camera moves, the incremental buffer is
 * byte-identical to a full repack for as long as the pose holds, and once the
 * pose has drifted below the threshold no instance INSIDE the frustum is ever
 * missing from it. The second property is the one `cull-check`'s zero-pixel
 * diff is really testing, and it still passes.
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
  /**
   * How many buckets the last repack actually LOOKED at, from the front.
   *
   * The distance and frustum test for a bucket depends on the bucket and the
   * camera and on nothing else, so when the camera has not moved since the last
   * repack the answer for every bucket below this index is already recorded in
   * `written` and re-deriving it is pure waste. It is only ever below
   * `buckets.length` because a sector event moved the list underneath it —
   * appended past it, or removed a span at `at` and set this to `at` — which is
   * exactly the case where a repack is forced with the camera standing still.
   *
   * A ring holds thousands of buckets per layer across dozens of layers, and a
   * forced full scan of all of them was up to 4.3 ms in the phase table. This
   * turns a sector arrival into a scan of that sector's own buckets.
   */
  let scanned = 0;
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
   * "Instances [from, to) were just rewritten — send them."
   *
   * NOTHING HERE CLEARS THE PENDING RANGES, AND THAT IS THE WHOLE POINT.
   *
   * These two lines used to be `clearUpdateRanges()` then `addUpdateRange(...)`,
   * on the reasonable-sounding grounds that this repack's range supersedes the
   * last one's. It does not, and the assumption hiding inside it is that every
   * repack is followed by a draw before the next repack. **A repack is not a
   * frame.** three uploads an attribute's ranges from inside `WebGLAttributes.
   * update`, which only runs when the mesh is actually submitted — and it bumps
   * `version` on `needsUpdate`, so once a range is dropped the version has
   * already moved past it and the bytes it described are never sent again. Two
   * repacks between two draws therefore lose the first one's writes PERMANENTLY:
   * the CPU slab is right, the GPU keeps whatever it had, and the frame draws a
   * plausible mixture of the two.
   *
   * The case that proved it is not exotic. `gateUp` in main.js throttles the
   * draw to 10 Hz while the menu is up while the cull keeps running every tick
   * (it is what streams the world in), so behind the title card there are five
   * or six repacks per draw and five of every six sets of writes were being
   * thrown away. Every screenshot script that dismisses the gate by hand rather
   * than clicking `#enter` — `look-shots.mjs` and the several that copied its
   * seating — stays in that state for its whole run, which is why two runs of it
   * against unchanged code produced frames differing across a THIRD of the
   * viewport: which repacks happened to land on a drawn frame is a question
   * about wall-clock timing, so the picture was a coin toss. It also reaches a
   * player: a sector that arrived while they were choosing a name could keep its
   * stale transforms after the gate lifted.
   *
   * Accumulating instead is unconditionally safe, because a range describes a
   * REGION rather than a snapshot: re-uploading a region uploads whatever is in
   * the array at upload time, which is by definition the current answer. three
   * sorts, merges adjacent ranges in place and clears them once it has sent
   * them, so the list cannot grow without bound and the merge means overlapping
   * suffixes usually collapse into one `bufferSubData`.
   *
   * `restoreAll` still clears — it queues no range at all, and an empty list is
   * three's own signal to upload the whole attribute, which supersedes anything
   * outstanding by covering it.
   */
  function flagUpload(from, to) {
    mesh.instanceMatrix.addUpdateRange(from * 16, (to - from) * 16);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.addUpdateRange(from * 3, (to - from) * 3);
      mesh.instanceColor.needsUpdate = true;
    }
  }

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
    /**
     * THE DESTINATION BUFFER IS BRAND NEW AND EMPTY, so nothing the packer
     * believes about what it last wrote survives this.
     *
     * The two lines above replace `mesh.instanceMatrix` outright and
     * deliberately do NOT copy the old attribute's contents across — there is
     * no point, since the next repack rewrites the whole visible set from the
     * slab. That was safe for as long as every mutation reset `writtenLength`,
     * which is exactly what `insert` used to do and no longer does: with the
     * incremental insert path, a growth would otherwise leave the packer
     * convinced that a prefix it never wrote is already correct, and the mesh
     * would draw that many instances of a zero matrix.
     *
     * Found by the randomised equivalence check rather than by reading, and it
     * took 3800 steps to appear, because a growth only happens when a sector
     * will not fit and the capacities are sized so it should never happen at
     * all. `scanned` goes with it for the same reason: an answer recorded
     * against a buffer that no longer exists is not an answer.
     */
    writtenLength = -1;
    scanned = 0;
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

  /**
   * Room in the diff bookkeeping for `buckets.length` entries.
   *
   * `written` is COPIED across the growth and `candidate` is not, and the
   * difference is not an oversight: `candidate` is refilled from scratch at the
   * top of every `update`, while `written` is the memory of the last repack and
   * throwing it away here would silently turn the append path below back into
   * the full repack it exists to avoid. Doubling rather than fitting, so a ring
   * that gains a sector every few seconds does not reallocate every few seconds.
   */
  function ensureIndexRoom() {
    if (written.length >= buckets.length) return;
    const size = Math.max(buckets.length, written.length * 2);
    const grown = new Int32Array(size);
    grown.set(written);
    written = grown;
    candidate = new Int32Array(size);
  }

  /**
   * Keep the first `p` entries of the last repack and forget the rest.
   *
   * See the header: the count must come down with it, or the next `update` can
   * early-return on a matching prefix while the mesh is still drawing instances
   * past it. `buckets[written[k]]` is safe for k < p precisely because p was
   * chosen as the first entry whose index moved.
   */
  function truncateWritten(p) {
    if (writtenLength < 0) return;
    if (p >= writtenLength) return;
    let n = 0;
    for (let k = 0; k < p; k++) n += take(buckets[written[k]]);
    writtenLength = p;
    mesh.count = n;
    mesh.visible = n > 0;
  }

  /**
   * THE INVARIANT `insert` AND `remove` MAINTAIN BETWEEN THEM:
   *
   *   buckets === [...owned.values()].flat()
   *
   * There used to be a `rebuild()` here that asserted it by recomputing it, and
   * both mutations called it. Nothing calls it now — `insert` appends and
   * `remove` splices, which is the whole point — and a flatten that nothing
   * runs is a second definition of the bucket order waiting to disagree with
   * the first. That is the same argument this file's header makes for having
   * deleted `packInstances`, so it goes the same way. `scripts/perf/
   * slab-equiv.mjs` checks the invariant where it belongs: in the output.
   */

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
      /**
       * APPEND, rather than reflatten. `owned` is a Map and `id` is a new key,
       * so the flattened order this produces is exactly what `rebuild` would
       * have produced — the same buckets in the same order — and every index
       * that already existed is untouched, which is what lets `writtenLength`
       * survive. See the header. The cost also stops depending on how much of
       * the world is resident: this is O(this sector) where reflattening was
       * O(every bucket in the layer), and the layer count and the ring are both
       * expected to grow.
       */
      for (const b of list) buckets.push(b);
      ensureIndexRoom();
      // `scanned` deliberately stays where it was: the appended buckets are the
      // only ones whose answer is not already known.
      if (writtenLength < 0) mesh.visible = buckets.length > 0;
    },

    remove(id) {
      const span = spans.get(id);
      if (!span) return;
      /**
       * Where this sector's buckets start in the flattened list. O(sectors),
       * not O(buckets) — the ring holds a dozen or so of the former and
       * thousands of the latter.
       */
      let at = 0;
      for (const [key, earlier] of owned) {
        if (key === id) break;
        at += earlier.length;
      }
      const list = owned.get(id);
      spans.delete(id);
      owned.delete(id);
      release(span.start, span.count);
      buckets.splice(at, list.length);
      /**
       * `written` is strictly ascending, so the entries still meaning what they
       * meant are exactly those below `at`, and they are a prefix. Everything
       * from the first entry at or past `at` shifted and is forgotten.
       */
      if (writtenLength > 0) {
        let p = 0;
        while (p < writtenLength && written[p] < at) p++;
        truncateWritten(p);
      }
      // Everything from `at` on has moved down by this sector's bucket count,
      // so its recorded answer is filed under the wrong index and has to be
      // taken again. Everything before it has not moved.
      if (scanned > at) scanned = at;
      if (writtenLength < 0) mesh.visible = buckets.length > 0;
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
     * Move this layer's level-of-detail band at runtime.
     *
     * `minDistance`, `maxDistance` and `alwaysNear` were closure constants until
     * the potato tier needed them, and the reason they need to move is measured:
     * `.perf/presets.json` records that the whole quality ladder changes the
     * triangle count by ONE PER CENT, so every rung from low to ultra submits
     * the same ~16 M triangles and buys its 44% with pixels and shadow texels
     * alone. Reach is the only lever that removes geometry, and geometry is
     * 75% of the frame at low.
     *
     * WHATEVER MOVES THESE MUST KEEP THE NEAR AND FAR BANDS COMPLEMENTARY.
     * A tree is two packers over one payload — see the `mirrorOf` block in
     * forest.js — and the bands meet exactly, `maxDistance` being `<=` and
     * `minDistance` being `>`. Set them independently and a bucket either lands
     * in both bands, so every distant trunk is drawn twice at two resolutions
     * z-fighting with itself, or in neither, so a ring of the wood is missing.
     * `forest.setReach` is the only caller that knows the pairing, and it is
     * where that invariant is enforced.
     *
     * `writtenLength = -1` and nothing else, exactly as `setDensity` does: it
     * forces the next update down the full-repack path, which re-tests every
     * bucket and resets `scanned` itself at the end of the loop. Resetting
     * `scanned` here as well would be harmless and is not needed.
     *
     * It does NOT forget the camera pose — the culler owns that thresholding
     * and would decline to repack at all until the player walked 2.5 m. See
     * `InstanceCuller.setBand`, which is what callers should use.
     */
    setBand({ min, max, near } = {}) {
      const nextMin = min ?? minDistance;
      const nextMax = max ?? maxDistance;
      const nextNear = near ?? alwaysNear;
      if (nextMin === minDistance && nextMax === maxDistance && nextNear === alwaysNear) return;
      minDistance = nextMin;
      maxDistance = nextMax;
      alwaysNear = nextNear;
      writtenLength = -1;
    },

    /** What band this layer is drawing, for `forest.setReach` and for tests. */
    band() {
      return { name: mesh.name, minDistance, maxDistance, alwaysNear };
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
      scanned = 0;
    },

    /**
     * @param {boolean} poseUnchanged  the camera is in the same place, facing
     *   the same way, with the same field of view as at the last repack — so
     *   this repack was forced by a sector event and by nothing else. The
     *   culler is the only thing that can know this, because it owns the
     *   thresholds; see InstanceCuller.update.
     */
    update(frustum, eye, poseUnchanged = false) {
      /**
       * AN EMPTY BAND IS A FREE LAYER, AND SAYING SO HERE IS WHAT MAKES IT ONE.
       *
       * `inBand` tests `horizontal > minDistance && horizontal <= maxDistance`,
       * so a layer whose two bounds are equal can never accept a bucket however
       * many it holds — the scan below is guaranteed to reject all of them and
       * then write nothing. That was a theoretical waste until the impostor band
       * arrived: at `high` and `ultra` its reach EQUALS the tree reach, so all
       * fifteen impostor layers sit on an empty band holding the trunk layers'
       * full set of bucket spheres, and the two top rungs of the ladder would be
       * paying about 5500 distance tests a repack for meshes that cannot draw.
       *
       * This is what lets the change claim the top of the ladder costs nothing,
       * rather than claiming it costs nothing measurable.
       */
      /**
       * THE EYE IS RECORDED BEFORE THE EARLY-OUTS, AND THAT IS NOT TIDINESS.
       *
       * `restoreAll` decides what belongs to this mesh with `inBand`, and
       * `inBand` returns TRUE for everything while `eyeX` is still null, because
       * "no update has run yet" has to mean "no band has been applied yet".
       * Return above this line and an empty-band layer never records an eye — so
       * `update` correctly draws nothing while `restoreAll` correctly draws
       * every bucket it holds, and `check:cull` reports ten stations losing
       * geometry with a worst delta of 616/765. It is the culled frame that is
       * right in that comparison, which is exactly the shape of failure that is
       * hardest to read.
       */
      eyeX = eye.x;
      eyeZ = eye.z;
      if (buckets.length === 0 || minDistance >= maxDistance) {
        mesh.count = 0;
        mesh.visible = false;
        writtenLength = -1;
        scanned = 0;
        return 0;
      }

      /**
       * THE SECTOR-EVENT PATH: test the buckets that arrived and nothing else.
       *
       * `written` is still true for everything below `scanned` (see its
       * declaration), the appended buckets all sort after it, and `mesh.count`
       * is by invariant the instance count of exactly the prefix `written`
       * describes — so the new buckets can simply be tested, appended to
       * `written`, and their instances written on the end of the buffer. The
       * region below `count` is untouched, which is also why the update range
       * flagged for upload starts there.
       *
       * When nothing new is visible this costs one distance test per arriving
       * bucket and zero bytes, which is the common case: a tree sector becomes
       * newly wanted when it crosses the 384 m ring, and that is behind the
       * player as often as not and outside the frustum most of the rest of the
       * time.
       */
      if (poseUnchanged && writtenLength >= 0) {
        if (scanned >= buckets.length) return 0;
        let added = 0;
        for (let i = scanned; i < buckets.length; i++) {
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
          written[writtenLength + added] = i;
          added++;
        }
        scanned = buckets.length;
        if (added === 0) return 0;

        const dstMatrix = mesh.instanceMatrix.array;
        const dstColor = mesh.instanceColor ? mesh.instanceColor.array : null;
        const keep = mesh.count;
        let write = keep;
        for (let k = 0; k < added; k++) {
          const b = buckets[written[writtenLength + k]];
          const c = take(b);
          dstMatrix.set(srcMatrix.subarray(b.start * 16, (b.start + c) * 16), write * 16);
          if (dstColor && srcColor) {
            dstColor.set(srcColor.subarray(b.start * 3, (b.start + c) * 3), write * 3);
          }
          write += c;
        }
        writtenLength += added;
        mesh.count = write;
        mesh.visible = write > 0;
        flagUpload(keep, write);
        return write - keep;
      }

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
      scanned = buckets.length;

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
      if (write > keep) flagUpload(keep, write);
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

  /**
   * "Whatever you concluded about the camera last time, forget it."
   *
   * The same correction `setDensity` and `restoreAll` already make by hand,
   * named once so that anything else changing a packer out from under the
   * culler can say so. Without it `update` looks at a camera that has not
   * moved 2.5 m or turned 3°, declines to repack, and the change does not
   * reach the buffer until the player next walks — which reads as a control
   * that does nothing, and then works a moment later, which is worse.
   */
  invalidate() {
    this._lastPosition.set(Infinity, Infinity, Infinity);
  }

  update(camera, force = false) {
    const moved =
      camera.position.distanceToSquared(this._lastPosition) > 2.5 * 2.5;
    // |q1·q2| = cos(θ/2); this threshold is roughly a 3° turn.
    const turned = Math.abs(camera.quaternion.dot(this._lastQuaternion)) < 0.99966;
    const zoomed = Math.abs(camera.fov - this._lastFov) > 0.25;
    if (!force && !moved && !turned && !zoomed) return false;

    /**
     * A FORCED REPACK WITH THE CAMERA STANDING STILL is a sector event and
     * nothing else, and the packers can do far less work when they are told so.
     *
     * This is the only place that can say it: `_lastPosition`, `_lastQuaternion`
     * and `_lastFov` are updated at the end of every repack, so all three tests
     * reading false means the pose is bit-for-bit the one the last repack was
     * given. `restoreAll` and `setDensity` both reset `_lastPosition` to
     * Infinity precisely so that they can never be mistaken for this.
     */
    const poseUnchanged = !moved && !turned && !zoomed;

    camera.updateMatrixWorld();
    this._matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._matrix);
    this.uploaded = 0;
    for (const packer of this.packers) {
      this.uploaded += packer.update(this._frustum, camera.position, poseUnchanged);
    }

    this._lastPosition.copy(camera.position);
    this._lastQuaternion.copy(camera.quaternion);
    this._lastFov = camera.fov;
    return true;
  }
}
