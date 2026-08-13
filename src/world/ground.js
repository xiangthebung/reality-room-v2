import * as THREE from 'three';
import { getWorldSeed, gridGeometry, heightGrid } from './terrain.js';

/**
 * The endless ground.
 *
 * The world used to be one 380 m plate with the player clamped to a 155.8 m
 * disc inside it. From that clamp the mesh ended 34 m ahead of you and below
 * your eye with open sky beyond it, and the fog at 34 m still passes 91% of the
 * light, so nothing hid it: there was a visible border at the edge of the world
 * and an invisible wall stopping you reaching it. This replaces the plate with a
 * ring of 128 m chunks that follows the camera and is rebuilt as you walk, so
 * there is no edge to find.
 *
 * WHAT DID NOT NEED TO CHANGE, AND MUST NOT.
 *
 * The ridge and the stream are already infinite. The ridge's crest is a
 * gaussian about a meandering line with no bound along its own axis — still
 * 84–88 m of crest at 500 m out, at 2000 and at 10000 — and the stream's centre
 * line oscillates inside a fixed band forever. So the extended world is not
 * "more noise": it is a long valley with a mountain range along one side and a
 * river along the other, and it was that all along. Generalising either into a
 * field so that ridges and rivers appear "everywhere" would replace real
 * geography with texture, and it would cost the one landmark this world can be
 * navigated by. That has not been done and must not be.
 *
 * WHAT DID CHANGE, AND WHY IT IS NOT THAT.
 *
 * The ridge used to lie along z ≈ -96 and the stream's centre line used to be a
 * fixed function of x, in every world, so reseeding moved every tree and left
 * the landscape byte-identical. Both are now drawn from the world seed ONCE, in
 * `setWorldSeed` — bearing, distance, crest height, width, meander — and are
 * constants thereafter. There is still exactly one ridge and exactly one river
 * and they still run forever; only "which way is north" is now a property of the
 * world rather than of the file. The paragraph above survives intact: nothing
 * here turned geography into a field.
 *
 * WHY THE GROUND IS THE CHEAP HALF OF THIS.
 *
 * Trunks are 85% of the world's triangles and the ground is 0.8% — 113 288 of
 * 13.53 M. A 320 m ring at 1.6 m cells is 0.32 M triangles, so making the ground
 * endless costs about two percent of a frame that is already dominated by
 * something else entirely. That is also the argument against LOD; the longer
 * version is at `heightGrid` in terrain.js.
 */

/** Metres across one chunk. Also the lattice pitch — chunks tile, they do not overlap. */
const CHUNK = 128;
/** Quads per side. 128/80 makes the cell exactly 1.6 m, matching the old plate. */
const SEG = 80;
const CELL = CHUNK / SEG;

/**
 * HOW FAR THE GROUND HAS TO REACH, WHICH IS A FOG NUMBER AND NOT A TASTE ONE.
 *
 * `FogExp2` transmits `exp(-(d·density)²)`. Sober density is 0.00920, so 1/255
 * of contrast survives to 256 m and a 256 m ring would be invisible — but the
 * director THINS the fog through the dissolve, and at t ≈ 221 s (ego death) the
 * density is 0.00585, which reaches 402 m. Sizing the ring from the sober number
 * would put the edge of the world on screen on exactly the frame the world is
 * supposed to open up, which is the worst possible moment for it.
 *
 * At 320 m the ego-death fog still passes 3.0% of the light, and at 384 m it
 * passes 0.64% — under the 1/255 the frame buffer can even represent. The extra
 * ring of chunks is ~10 draws and 0.13 M triangles against a frame that draws
 * 13 M, so the honest number wins on the arithmetic as well as on the eye.
 */
const RING = 384;
/**
 * Evict past this, not past RING.
 *
 * The gap is hysteresis and it is not optional: without it, a player pacing
 * back and forth across a chunk boundary would drop and rebuild the same chunk
 * every few seconds forever. 1.5× puts the boundary 192 m behind the one that
 * matters, which is 23 seconds of sprinting.
 *
 * Eviction ITSELF is not optional either, for a reason that is easy to miss
 * because it does not show up in a two-minute test: twenty minutes at 8.2 m/s
 * covers about 10 km, which is roughly 4700 chunks, which at ~340 KB of buffers
 * each is about 1.6 GB. A streaming world without eviction is a memory leak with
 * a view.
 */
const EVICT = RING * 1.5;

/**
 * Two workers.
 *
 * One is enough for walking — a chunk takes 6.1 ms p50 and crossing a boundary
 * at a sprint exposes about seven of them over 15 seconds — but not for the
 * first fill, where thirty-odd chunks are wanted at once, and not for a
 * teleport. Beyond two the bottleneck moves to the one-per-frame consumption
 * below, so more workers would only buy a longer queue of finished work.
 */
const WORKERS = 2;

/**
 * Trip headroom on each chunk's bounding sphere.
 *
 * Chunks are frustum-culled, and that is worth roughly two thirds of the ring's
 * draw calls — but three tests the sphere of the UNDISPLACED geometry, and
 * `living.js` moves this mesh a long way. `uHills` adds `(y + 4)·0.42` to every
 * vertex, which on a chunk containing the ridge is nearly 39 m; the melt adds up
 * to about 1.2 m of `uFlow`; the breath adds 0.25 m along the normal. A chunk
 * that has swelled past its own sphere and is culled anyway pops out of the
 * frame at the top of the screen, which is precisely the peak of the trip.
 */
const MAX_HILLS = 0.42;
const TRIP_SLACK = 2.5;

/**
 * How close a new chunk has to be before it is worth re-rendering the shadow map.
 *
 * A SHADOW MAP RE-RENDER COSTS 3.2–4.5 ms ON A 2.2–2.8 ms FRAME. It roughly
 * triples the frame it lands on, it is not fill-bound (dropping the map to
 * 1024² saves 0.62 ms of 3.25), and halving the casting set saves about 5% — so
 * there is nothing to optimise about the pass itself and the only lever is how
 * OFTEN it runs. That is why `atmosphere.follow` was rebuilt around 6 m of
 * hysteresis on the body: it took an instrumented walk from 21 re-renders in six
 * seconds down to the 3 the distance actually called for.
 *
 * Arming the map for every chunk that arrives would put all of that straight
 * back, at chunk rate, for nothing: the shadow camera is a 58 m half-extent box
 * around the anchor, so a chunk outside it CANNOT change a single texel. Almost
 * every chunk arrives 250–380 m away and is irrelevant.
 *
 * 66 m, not 58: the anchor lags the body by up to ANCHOR_HOLD (6 m) and the
 * trip's dolly slides the camera up to 1.35 m further, and this test is against
 * the camera because that is what `update` is handed.
 */
const SHADOW_REACH = 66;

/**
 * HOW MANY CHUNKS MAY BE WAITING FOR THEIR FIRST SUBMISSION AT ONCE.
 *
 * See `_prime`. The list only grows when chunks are landing on frames where the
 * ground is not being drawn at all — which happens for exactly one reason, a
 * body buried in rock with `occludeWorld` holding the wood out of the render —
 * and a player can stay down there for as long as they like. Twelve is more
 * than the streamer can produce in the time it takes to walk out of a passage;
 * past that the oldest are let go and pay for themselves on first sight, which
 * is the behaviour this whole mechanism replaces and is therefore safe to fall
 * back to.
 */
const PRIME_BACKLOG = 12;

/** Squared distance from a point to the nearest point of a chunk's footprint. */
function chunkDistance2(cx, cz, px, pz) {
  const x0 = cx * CHUNK;
  const z0 = cz * CHUNK;
  const dx = Math.max(x0 - px, 0, px - (x0 + CHUNK));
  const dz = Math.max(z0 - pz, 0, pz - (z0 + CHUNK));
  return dx * dx + dz * dz;
}

/**
 * Set on the mesh, not captured in a closure, so that one shared function
 * serves every chunk and `_accept` allocates nothing extra per chunk.
 */
function markPrimed() {
  this.__rrPrimed = 1;
}

function release(mesh) {
  mesh.frustumCulled = true;
  delete mesh.onAfterRender;
}

export class GroundField {
  /**
   * @param {THREE.Material} material the shared living terrain material
   * @param {{renderer?: THREE.WebGLRenderer}} [options]
   */
  constructor(material, { renderer = null } = {}) {
    this.material = material;
    this.group = new THREE.Group();
    // main.js's bisection probe looks this name up, and setting `visible` on a
    // Group hides its children, so `probe.show('ground', false)` still works.
    this.group.name = 'ground';
    this.renderer = renderer;

    /** key -> { mesh, cx, cz } for everything currently in the scene. */
    this.chunks = new Map();
    /** keys handed to a worker and not yet back. */
    this.inflight = new Set();
    /** finished chunks waiting for a frame to accept them. */
    this.done = [];
    /** keys wanted but not yet dispatched, refreshed every update. */
    this.queue = [];
    /** meshes being force-submitted so their buffers upload now. See `_prime`. */
    this.warming = [];

    this.built = 0;
    this.evicted = 0;
    /** How many arrivals were close enough to be worth a shadow re-render. */
    this.shadowArms = 0;
    this._shadowDirty = false;
    this._lastCell = null;

    this.workers = [];
    this.idle = [];
    for (let i = 0; i < WORKERS; i++) {
      const w = this._spawn();
      if (!w) break;
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  _spawn() {
    try {
      /**
       * `new URL(..., import.meta.url)` rather than a Blob, so Vite sees the
       * dependency: in dev it serves the worker through the same transform
       * pipeline as everything else (which is what rewrites the bare `three`
       * import), and in a build it emits a real chunk. A Blob URL works in dev
       * and silently loses its module graph in a build.
       */
      const w = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        this.done.push(e.data);
        this.inflight.delete(e.data.key);
        this.idle.push(w);
      };
      w.onerror = () => {
        // A worker that failed to load is worse than none, because the chunks
        // it was given never come back. Drop it and let the main thread take
        // over — a hitch is survivable, a hole in the ground is not.
        const at = this.workers.indexOf(w);
        if (at >= 0) this.workers.splice(at, 1);
        this.idle = this.idle.filter((x) => x !== w);
        this.inflight.clear();
      };
      return w;
    } catch {
      return null;
    }
  }

  /**
   * Bring the ring up to date for this camera. Called once a frame from
   * `forest.cull()`, which main.js already calls last, after everything that
   * can move the camera.
   */
  update(camera) {
    const px = camera.position.x;
    const pz = camera.position.z;

    // Before anything else, because `_accept` below adds to the list this
    // clears and the two must not be the same frame — see `_prime`.
    this._release();

    /**
     * The wanted set can only change when the camera crosses a chunk boundary,
     * so the scan is skipped on the ~99.9% of frames where it cannot have.
     *
     * The second clause is the self-healing one, and it is why this is not just
     * the boundary test. If a chunk is ever lost — a worker that died with a job
     * in flight, a result discarded because it was evicted mid-build — the ring
     * would otherwise stay one chunk short until the player happened to walk
     * across a boundary, and there is no bound on how long that is. Rescanning
     * whenever there is no work outstanding fixes any hole within a frame and
     * costs about fifty distance tests, because when the ring is complete every
     * candidate is rejected by `chunks.has` before anything is allocated.
     */
    const cell = `${Math.floor(px / CHUNK)},${Math.floor(pz / CHUNK)}`;
    if (cell !== this._lastCell || this.pending === 0) {
      this._lastCell = cell;
      this._rescan(px, pz);
    }

    this._dispatch();
    this._accept(px, pz);

    /**
     * One arm per frame at most, and only for a chunk that can actually change
     * a texel. See SHADOW_REACH.
     *
     * Deliberately at the END of `update`, not inside `_accept`: main.js calls
     * `atmosphere.follow` before `forest.cull`, so if the anchor also moved this
     * frame the two arms coalesce into the one re-render that was going to
     * happen anyway, and the chunk costs nothing at all.
     */
    if (this._shadowDirty) {
      this._shadowDirty = false;
      const renderer = this.renderer ?? (this.renderer = globalThis.RR?.renderer ?? null);
      if (renderer) renderer.shadowMap.needsUpdate = true;
    }
    return this.chunks.size;
  }

  _rescan(px, pz) {
    const ring2 = RING * RING;
    const evict2 = EVICT * EVICT;

    this.queue.length = 0;
    const lo = Math.floor((px - RING) / CHUNK);
    const hi = Math.floor((px + RING) / CHUNK);
    const loZ = Math.floor((pz - RING) / CHUNK);
    const hiZ = Math.floor((pz + RING) / CHUNK);
    for (let cz = loZ; cz <= hiZ; cz++) {
      for (let cx = lo; cx <= hi; cx++) {
        const d2 = chunkDistance2(cx, cz, px, pz);
        // A disc, not a square. A 5×5 square of 128 m chunks guarantees only
        // 256 m of ground in the axis directions however you centre it — the
        // camera sits somewhere inside its own chunk, not at the middle of it —
        // and 256 m is where the ego-death fog still passes a tenth of the
        // light. Testing the real distance costs two subtractions per candidate
        // and reaches the same distance in every direction, which is the whole
        // requirement.
        if (d2 > ring2) continue;
        const key = `${cx},${cz}`;
        if (this.chunks.has(key) || this.inflight.has(key)) continue;
        this.queue.push({ key, cx, cz, d2 });
      }
    }
    // Nearest first: the chunk you are about to walk onto is the one whose
    // absence you would notice.
    this.queue.sort((a, b) => a.d2 - b.d2);

    for (const [key, chunk] of this.chunks) {
      if (chunkDistance2(chunk.cx, chunk.cz, px, pz) <= evict2) continue;
      this.group.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
      this.chunks.delete(key);
      this.evicted++;
    }
  }

  /**
   * EVERY CHUNK CARRIES THE WORLD SEED, AND THAT IS NOT BELT AND BRACES.
   *
   * A worker is a separate realm with its own instance of `terrain.js`, so the
   * seed the main thread chose does not exist in it and the worker's height
   * field defaults to the authored world. Ground built there would then
   * disagree with the `heightAt` that placed every tree, rock and mushroom on
   * it, and with the `groundUnder` the player walks on. It does not throw and it
   * does not look like a bug in the seeding: it looks like the trees are
   * floating, and only in the chunks a worker happened to build.
   *
   * Stamped per chunk rather than sent once at spawn because there is no
   * "once": `_spawn` is also called on recovery, `onerror` drops a worker
   * mid-session, and a message that arrives before the worker's module has
   * evaluated is a race nobody wants to reason about. A uint32 in a payload
   * that already carries five typed arrays costs nothing, and the worker
   * re-applies it only when it changes.
   */
  _dispatch() {
    const seed = getWorldSeed();
    while (this.idle.length && this.queue.length) {
      const job = this.queue.shift();
      if (this.chunks.has(job.key) || this.inflight.has(job.key)) continue;
      const w = this.idle.pop();
      this.inflight.add(job.key);
      w.postMessage({
        key: job.key,
        ox: job.cx * CHUNK,
        oz: job.cz * CHUNK,
        seg: SEG,
        cell: CELL,
        seed,
      });
    }
    /**
     * No workers at all — a browser that refused the module worker, or one that
     * errored out above. Build on the main thread instead, still one per frame.
     * 6 ms of hitch on the frames a boundary is crossed is a bad experience;
     * ground that never arrives is not an experience at all.
     *
     * Nothing to stamp here: this is the main thread's own `terrain.js`, which
     * is where the seed was set in the first place. Worth saying out loud
     * because it is the path nobody tests, and a fallback that silently built
     * the authored world would be the same floating-trees bug with a much
     * smaller audience.
     */
    if (!this.workers.length && this.queue.length) {
      const job = this.queue.shift();
      const g = heightGrid(job.cx * CHUNK, job.cz * CHUNK, SEG, CELL);
      this.done.push({ key: job.key, ox: job.cx * CHUNK, oz: job.cz * CHUNK, ...g });
    }
  }

  /**
   * Take AT MOST ONE finished chunk per frame.
   *
   * What is left on the main thread per chunk is the BufferGeometry assembly and
   * the first-render upload of ~416 KB — 0.20 ms p50 but 1.90 ms max, plus about
   * 1.1 ms of GPU upload. Accepting the whole queue on the frame the player
   * crosses a boundary would stack seven of those into one frame for no benefit,
   * because the chunks are 300 m away and nobody is waiting for them. Injected
   * into the live game at one per 0.5 s — fifteen times faster than sprinting
   * demands — this left the frame-delta distribution unchanged: p50 4.2 ms,
   * p99 5.1 ms, max 5.7 ms, against a 4.2/5.3/7.7 baseline.
   *
   * The scene graph is mutated HERE and nowhere else. `onmessage` only appends
   * to a list, so a chunk can never appear between a script's two renders of
   * what is supposed to be the same frame — which is what `cull-check.mjs`
   * depends on to diff a culled render against an unculled one.
   */
  _accept(px, pz) {
    const data = this.done.shift();
    if (!data) return;
    const key = data.key;
    // It may have been evicted, or already rebuilt, while it was in flight.
    if (this.chunks.has(key)) return;
    const [cx, cz] = key.split(',').map(Number);

    const geo = gridGeometry(data);
    /**
     * Room for the trip inside the frustum test. See TRIP_SLACK.
     *
     * `center.y + radius` is an upper bound on the chunk's highest vertex, which
     * is what `uHills` scales, so this is conservative without needing a second
     * pass over the positions to find the true maximum.
     */
    const s = geo.boundingSphere;
    s.radius += (s.center.y + s.radius + 4) * MAX_HILLS + TRIP_SLACK;

    const mesh = new THREE.Mesh(geo, this.material);
    /**
     * THE OFFSET IS IN x AND z ONLY. `position.y` STAYS ZERO.
     *
     * The vertices carry absolute world height. Baking heights relative to the
     * chunk and lifting the mesh with `position.y` would look identical when
     * sober and come apart the moment anyone ate anything: `uHills` multiplies
     * the LOCAL `transformed.y`, so every chunk would exaggerate around its own
     * datum and every border would grow a step that scaled with the trip.
     */
    mesh.position.set(cx * CHUNK, 0, cz * CHUNK);
    mesh.receiveShadow = true;
    /**
     * FIRST IN THE OPAQUE LIST, BECAUSE THE FLOOR IS THIS FRAME'S BEST OCCLUDER.
     *
     * Measured by hiding one layer at a time at the trip's peak: every other
     * layer costs what you would expect, and the ground costs **−2.48 ms** —
     * hiding the floor makes the frame two and a half milliseconds SLOWER. It is
     * a cheap, entirely opaque, depth-writing surface that covers most of the
     * lower screen, and everything drawn after it gets early-Z rejection for
     * free.
     *
     * three sorts the opaque list by `(groupOrder, renderOrder, material.id, z)`,
     * and `material.id` outranks z — so with every renderOrder left at 0 the
     * forest's draw order is really *the order its materials happened to be
     * constructed in*, and z only breaks ties within a single material. That is
     * not an order anybody chose. Explicit ordering — ground, trunk,
     * understorey, leaf, then sky — measured 4.890 ms against 5.054 shipping,
     * five interleaved rounds at seek 160.
     *
     * Nothing moves between render lists: `renderOrder` sorts WITHIN one, so the
     * transparent water, mist, shafts and motes still come afterwards and still
     * blend against a finished frame.
     */
    mesh.renderOrder = -4;
    mesh.name = 'ground-chunk';
    this.group.add(mesh);
    this.chunks.set(key, { mesh, cx, cz });
    this.built++;

    /**
     * The shadow map is rendered on demand — `autoUpdate` is off, and
     * `atmosphere.follow()` only arms it once the BODY has moved ANCHOR_HOLD
     * (6 m) from the anchor, with hysteresis rather than on a lattice. So a
     * chunk that lands inside the shadow volume between two of those would
     * render unlit until the player happened to walk far enough — which is
     * exactly what the chunk under your feet does at load: it arrives after the
     * first shadow render, and then the player stands still reading the toast.
     *
     * Flagged rather than armed, and only when it is close enough to matter.
     */
    if (chunkDistance2(cx, cz, px, pz) < SHADOW_REACH * SHADOW_REACH) {
      this._shadowDirty = true;
      this.shadowArms++;
    }

    this._prime(mesh);
  }

  /**
   * PAY FOR THE GPU UPLOAD ON THE FRAME THAT BUILT THE CHUNK, NOT ON THE FRAME
   * THE PLAYER HAPPENED TO LOOK AT IT.
   *
   * A BufferGeometry costs nothing until it is DRAWN. The first time one reaches
   * the renderer, three creates a GL buffer per attribute and `bufferData`s the
   * lot — 416 KB for a chunk, five buffers — and that is the frame that pays.
   * `_accept` runs one chunk per frame and nearly every chunk lands 250-380 m
   * away, out of the frustum, so the two events are separated by however long it
   * takes the player to turn round: instrumented over a 20 s walk, eight chunks
   * were built and TWENTY-NINE were met, the other twenty-one having been
   * sitting behind the camera for seconds. That is why the accept-time counter
   * showed no correlation with hitches while the first-draw counter showed a
   * x20-83 lift — they fire on different frames, and the expensive one was
   * chosen by a mouse movement.
   *
   * The fix is to make the first submission happen HERE, on a frame that is
   * already spending on this chunk and is capped at one chunk. `frustumCulled`
   * off for a single frame is all it takes, and it is the same trick main.js
   * uses behind the loading gate for the hearth and the ferry — the comment
   * there explains it at length. The chunk is off screen, so the draw rasterises
   * nothing: 6 561 vertices are transformed and every triangle is clipped away.
   *
   * MEASURED COST OF THE UPLOAD ITSELF, on this machine, by timing the five
   * `bufferData` calls a chunk needs against a context that had never seen them:
   * 0.1-0.3 ms typical, and 1.7 ms on one allocation in thirty when the driver
   * had to grow its heap. Four chunks in one frame — which is what a head turn
   * across fresh terrain produces — measured 0.3-0.7 ms of client time on top of
   * whatever that frame was already doing. Capping it at one per frame is the
   * point; the bytes were always going to be paid.
   *
   * NOT `setDrawRange(0, 0)`, which would upload the buffers with the vertex
   * shader never running and is genuinely free. It also makes the chunk
   * invisible for exactly one frame, and `cull-check.mjs` renders the same frame
   * twice and diffs the pixels. Transforming six thousand vertices is cheaper
   * than reasoning about that.
   */
  _prime(mesh) {
    mesh.frustumCulled = false;
    mesh.onAfterRender = markPrimed;
    this.warming.push(mesh);
    // See PRIME_BACKLOG. Oldest first, because the oldest is the one whose
    // chance of being drawn soon is worst.
    while (this.warming.length > PRIME_BACKLOG) release(this.warming.shift());
  }

  /**
   * Give back the forced submission, one frame later.
   *
   * WHY THIS IS NOT DONE IN `onAfterRender` ITSELF. Two reasons, and the second
   * one is the one that would have been found the hard way. The callback runs
   * INSIDE `render`, so restoring there mutates the scene between two renders of
   * what is supposed to be the same frame — which is exactly what
   * `cull-check.mjs` does. And the ground is not always submitted at all: while
   * the body is buried, `occludeWorld` takes the whole wood out of the render,
   * and a chunk that landed then would never be primed. So the callback only
   * RECORDS that the draw happened, and the release is a frame-boundary
   * operation that waits for it.
   *
   * A mesh with no parent has been evicted while it waited; there is nothing
   * left to prime and nothing to restore.
   */
  _release() {
    for (let i = this.warming.length - 1; i >= 0; i--) {
      const mesh = this.warming[i];
      if (!mesh.__rrPrimed && mesh.parent) continue;
      release(mesh);
      this.warming.splice(i, 1);
    }
  }

  /** Everything a test needs to know whether the ring has settled. */
  get pending() {
    return this.queue.length + this.inflight.size + this.done.length;
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
    for (const mesh of this.warming) release(mesh);
    this.warming.length = 0;
    for (const chunk of this.chunks.values()) chunk.mesh.geometry.dispose();
    this.chunks.clear();
    this.group.clear();
  }
}
