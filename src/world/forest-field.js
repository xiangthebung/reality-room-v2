import * as THREE from 'three';

/**
 * The endless wood.
 *
 * `ground.js` made the ground endless and the trees did not come with it. The
 * result was measurably worse than the border it replaced: at 400 m the forest
 * had simply stopped, and there was open grassland to the horizon in every
 * direction, at 400 m and at 2 km alike. An invisible wall is at least a
 * boundary; nothing is not.
 *
 * This streams the forest the same way the ground streams: sectors built in a
 * worker on a ring that follows the camera, evicted behind it with hysteresis.
 * What is different, and what most of the design is about, is that the ground
 * is one mesh per chunk and the forest is not allowed to be.
 *
 *
 * SECTORS LIVE INSIDE THE BUFFERS, NOT IN THE SCENE GRAPH.
 *
 * `culling.js` rejected one InstancedMesh per sector before any of this
 * existed: "Twelve tree archetypes times two meshes times a useful sector size
 * is over a thousand objects, which moves the cost from the GPU to the CPU and
 * keeps it." That is still true and the numbers are worse at a 384 m reach. So
 * there is exactly ONE InstancedMesh per archetype, for the whole endless
 * world, and a sector owns a contiguous span inside its source array — see
 * `packSlab`. Thirty-three streamed meshes in total, against the two hundred
 * and eighty-eight the per-sector arrangement would have needed, and the draw
 * call count moves by tens rather than by hundreds.
 *
 *
 * TWO GRIDS, BECAUSE A TREE AND A BLADE OF GRASS ARE NOT THE SAME PROBLEM.
 *
 * Trees are 128 m sectors on a 384 m ring, matching the ground's reach so the
 * wood never ends before the ground does. Undergrowth is 32 m sectors on an
 * 80 m ring, because grass is 2.8 candidates per square metre and a 384 m ring
 * of it would be a million and a half instances for ground nobody will ever
 * stand on.
 *
 * BOTH RINGS NOW START AT r = 0. There used to be an eager scatter covering a
 * disc around the origin and a rule forbidding these grids to place anything
 * inside 163.4 m of it; that is gone, and the near world arrives here like
 * everywhere else. The visible consequence is that the first fill has real work
 * in it — 71 sectors, all of them full — where the near ones used to reject
 * every candidate and return empty. It costs about a second of the entry gate,
 * which the gate was already spending on the same 71 sectors.
 *
 * 128 m rather than the 256 m first proposed, and the reason changed once the
 * slab allocator existed. 256 m was chosen to hold the OBJECT count down, back
 * when a sector meant a mesh; with one mesh per archetype the object count no
 * longer depends on sector size at all, and the remaining consideration is
 * overshoot. Residency is "the nearest point of the sector is within the ring",
 * so a sector's far corner sits up to s·√2 beyond it — 362 m of waste at 256 m
 * against 181 m at 128 m, which is the difference between generating half as
 * many trees again as the ring asked for and generating a fifth. A 128 m sector
 * is also exactly one terrain chunk, so the two rings tile the same lattice.
 *
 *
 * ONE SECTOR PER FRAME, AND ONE SHADOW ARM AT MOST.
 *
 * A sector landing forces a full repack of the layers it touches, because
 * inserting buckets invalidates the incremental packer's memory of what it last
 * wrote (see packSlab). That is the expensive part of an arrival, so arrivals
 * are taken one at a time however many are waiting — exactly the argument
 * GroundField makes for chunks, and for the same reason: the sector is 300 m
 * away and nobody is waiting for it.
 *
 * The shadow map is the other half. One re-render costs 3.2–4.5 ms on a 2.4 ms
 * frame — it roughly triples it — and the price is fixed, so the only lever is
 * frequency. A sector outside the shadow camera's 58 m box CANNOT change a
 * texel, and in steady walking no sector ever arrives inside it: a sector is
 * only newly wanted when it crosses the ring boundary, which is 384 m away for
 * trees and 80 m for undergrowth. The test exists for the two cases where that
 * argument does not hold — the first fill, and a test script that teleports —
 * and it coalesces multiple arrivals into a single arm at the end of `update`,
 * where it can merge with the one `atmosphere.follow` was going to do anyway.
 */

/** Metres across one tree sector. One terrain chunk. */
const TREE_SECTOR = 128;
/**
 * How far the wood reaches.
 *
 * The same number as the ground ring, and for the same reason: `FogExp2`
 * transmits `exp(-(d·density)²)`, the sober density of 0.0092 dies at 256 m, but
 * the director THINS the fog through the dissolve and at ego death it reaches
 * 402 m — which is exactly the frame on which a forest that stopped at 256 m
 * would announce itself. Trees behind the ground's edge would be a different
 * kind of wrong from trees in front of it, and only one of those is visible, so
 * the two rings are the same number.
 */
const TREE_RING = 384;

/**
 * Metres across one undergrowth sector.
 *
 * 32, not 64, and the reason is overshoot rather than granularity. Residency is
 * "the nearest point of the sector is inside the ring", so the real reach is
 * the ring plus most of a sector diagonal: 125 m at 64 m sectors against 102 at
 * 32. Grass runs at 2.8 candidates per square metre, so that difference is
 * about a third of every blade in the world, all of it in the band beyond
 * 100 m where a 0.42 m clump is two pixels tall.
 *
 * Four times as many sectors, each a quarter the size, is also the better shape
 * for the frame: an arrival forces a full repack of the layers it touches, and
 * paying that for 1400 blades every half-second is smoother than paying it for
 * 5500 every two.
 */
const UNDER_SECTOR = 32;
/**
 * Undergrowth reach.
 *
 * 80 m is past where a 0.42 m grass clump is three pixels tall at 1440p, and
 * the sector overshoot means the real reach is the ring plus most of a sector
 * diagonal — about 112 m in practice. Every metre beyond that is instances
 * nobody can resolve at 2.8 candidates per square metre, which is the most
 * expensive way in this world to buy nothing: measured at 96 m the ring held
 * 47 000 VISIBLE blades at 2 km.
 *
 * THIS IS NOW THE ONLY LIMIT ON GROUND COVER ANYWHERE, and it is worth knowing
 * what it costs to move, because it is the obvious lever the next person will
 * reach for. The protected disc used to leave a bald annulus at 118–163 m and
 * that is gone (see scatter.js); what is left is a soft falloff from about
 * 100 m to about 145 m, identical at every seed and every bearing because it is
 * a distance from the EYE rather than a place in the world. Cover per square
 * metre, averaged over twelve stations across three seeds:
 *
 *     0–100 m  1.5–2.2      100–120 m  0.3–0.8      120–140 m  0.0–0.4
 *
 * WIDENING IT TO 112 m WAS MEASURED AND REJECTED. That reaches ~145 m and takes
 * the resident set from 41 538 to 58 143 instances at the spawn point and from
 * 40 114 to 61 242 out at 700 m. GPU cost at 2560×1440, 80 m against 112 m:
 *
 *     spawn   sober 3.96 -> 4.15   onset 5.09 -> 5.47   peak 4.55 -> 4.43
 *     700 m   sober 4.31 -> 4.48   onset 5.44 -> 6.32   peak 4.36 -> 4.89
 *
 * Up to nine tenths of a millisecond at onset, to plant a band that sits behind
 * 14–35% fog transmission. The standing instruction is "no frame drops"; this
 * is not the way to spend the budget. If the falloff ever does need softening,
 * the cheap direction is the four opaque floor layers — sticks, litter, stumps,
 * flowers — on a wider ring of their own, because those WRITE DEPTH and the
 * tall cards are the entire fill cost.
 */
const UNDER_RING = 80;

/**
 * Evict past 1.5× the ring, not past the ring.
 *
 * Hysteresis, and not optional: without it a player pacing back and forth
 * across a sector boundary would drop and rebuild the same sector every few
 * seconds for ever. The same 1.5 the ground uses, for the same reason.
 */
const EVICT = 1.5;

/**
 * How close a sector must be to be worth a shadow re-render.
 *
 * 66 m: the shadow camera is a 58 m half-extent box on an anchor that trails
 * the body by up to ANCHOR_HOLD (6 m), and the trip's dolly slides the camera
 * up to 1.35 m further from the anchor than that. Tested against the camera
 * because the camera is what `update` is handed.
 */
const SHADOW_REACH = 66;

/**
 * The layers an eaten patch takes with it, and the only two `eatPatch` and
 * `_accept` are allowed to touch.
 *
 * Named once because the two places that suppress a patch have to agree
 * exactly: one removes these after the fact and the other declines to insert
 * them, and a mushroom that came back as a stem with no cap would be the kind
 * of thing nobody looks for.
 */
const SHROOM_LAYERS = ['shroom-stem', 'shroom-cap'];

/** Two, for the same reason ground.js has two. Beyond that the one-per-frame
 * acceptance below is the bottleneck and more workers only buy a longer queue. */
const WORKERS = 2;

/** Squared distance from a point to the nearest point of a sector's footprint. */
function sectorDistance2(sx, sz, size, px, pz) {
  const x0 = sx * size;
  const z0 = sz * size;
  const dx = Math.max(x0 - px, 0, px - (x0 + size));
  const dz = Math.max(z0 - pz, 0, pz - (z0 + size));
  return dx * dx + dz * dz;
}

/**
 * Colliders, in a grid rather than in a list.
 *
 * `colliders` was a flat array scanned twice per frame by the controller —
 * 10.2 µs at 3807 entries, which was fine for a world that could not get any
 * bigger. Streaming removes that guarantee: a 384 m ring holds something like
 * twenty-five thousand trunks, and scanning those twice a frame is a quarter of
 * a millisecond spent almost entirely on trees hundreds of metres away.
 *
 * The largest collider in the world is a boulder at r = 1.5 and the body is
 * 0.34, so nothing further than 1.84 m outside the player's own cell can touch
 * him — a 3×3 gather of 16 m cells is therefore not an approximation, it is
 * exactly the set that can matter. The gather is redone when the player crosses
 * a cell or when the grid changes, which is a few times a minute rather than
 * 240 times a second.
 */
const COLLIDER_CELL = 16;

export class ColliderGrid {
  constructor() {
    this.cells = new Map();
    /** sector key -> the cells it touched and the entries it owns. */
    this.owners = new Map();
    /** Bumped on every mutation, so a cached gather knows it is stale. */
    this.version = 0;
    this._key = null;
    this._at = -1;
    this._near = [];
    /**
     * How much of the authored flat array has been folded in.
     *
     * `gathering.js` pushes a collider per campfire AFTER `buildForest` has
     * returned — main.js builds the forest first because everything standing in
     * it needs to know where the ground is — so a one-shot ingest at
     * construction would silently lose them and the fires would become
     * holograms. Ingesting the tail on every update is O(nothing) once the array
     * has stopped growing and cannot miss a late arrival.
     */
    this.ingested = 0;
  }

  static key(x, z) {
    return `${Math.floor(x / COLLIDER_CELL)},${Math.floor(z / COLLIDER_CELL)}`;
  }

  add(c, owner = null) {
    const key = ColliderGrid.key(c.x, c.z);
    let cell = this.cells.get(key);
    if (!cell) this.cells.set(key, (cell = []));
    cell.push(c);
    if (owner) {
      if (!owner.keys.includes(key)) owner.keys.push(key);
      owner.items.push(c);
    }
    this.version++;
  }

  /** @param {Float32Array} triples x, z, r repeated */
  addSector(id, triples) {
    const owner = { keys: [], items: [] };
    for (let i = 0; i < triples.length; i += 3) {
      this.add({ x: triples[i], z: triples[i + 1], r: triples[i + 2] }, owner);
    }
    this.owners.set(id, owner);
  }

  removeSector(id) {
    const owner = this.owners.get(id);
    if (!owner) return;
    this.owners.delete(id);
    const dead = new Set(owner.items);
    for (const key of owner.keys) {
      const cell = this.cells.get(key);
      if (!cell) continue;
      const kept = cell.filter((c) => !dead.has(c));
      if (kept.length) this.cells.set(key, kept);
      else this.cells.delete(key);
    }
    this.version++;
  }

  /** Everything that could possibly touch a body at (x, z). */
  near(x, z) {
    const key = ColliderGrid.key(x, z);
    if (key === this._key && this._at === this.version) return this._near;
    this._key = key;
    this._at = this.version;
    const cx = Math.floor(x / COLLIDER_CELL);
    const cz = Math.floor(z / COLLIDER_CELL);
    const out = [];
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const cell = this.cells.get(`${cx + i},${cz + j}`);
        if (cell) for (const c of cell) out.push(c);
      }
    }
    this._near = out;
    return out;
  }
}
export class ForestField {
  /**
   * @param {{seed: string, layers: Array, tints: object, archetypes: number,
   *          rockSizes: number, renderer?: THREE.WebGLRenderer,
   *          colliders: ColliderGrid, bushZones: ColliderGrid, patches: Array,
   *          glow: THREE.Points|null}} options
   *   `layers` is one entry per streamed InstancedMesh: `{ id, kind, packer,
   *   bound, bucketSize }`, where `kind` selects which grid builds it.
   */
  constructor({
    seed,
    layers,
    tints,
    archetypes,
    rockSizes,
    renderer = null,
    colliders,
    bushZones,
    patches,
    glow = null,
  }) {
    this.seed = seed;
    this.renderer = renderer;
    this.colliders = colliders;
    this.bushZones = bushZones;
    this.patches = patches;
    this.glow = glow;

    /** id -> packer, for every streamed layer. */
    this.packers = new Map();
    for (const l of layers) this.packers.set(l.id, l.packer);
    /**
     * source layer id -> the layers that want the same data.
     *
     * The level-of-detail split: `trunk:pine:0` and `trunk-far:pine:0` hold the
     * same trees at two resolutions and draw complementary distance bands, so
     * one worker payload feeds both slabs. Done here rather than in the worker
     * because it is a rendering decision — the worker has no idea there is more
     * than one version of a pine, and should not.
     */
    /**
     * Which layers can put a texel in the shadow map at all.
     *
     * Measured at load, back when it was unconditional: 26 shadow re-renders
     * during the first fill, at 3.2–4.5 ms each on top of a 2.4 ms frame.
     *
     * AND THE ARGUMENT FOR THIS TEST GOT WEAKER WHEN THE PROTECTED DISC WENT,
     * which is worth writing down because the code did not change and looks as
     * though it should have. It used to be nearly free to satisfy: an
     * undergrowth sector landing near the player carried grass, ferns and
     * mushrooms and NOTHING that casts, because the stones, deadfall, bushes,
     * saplings and stumps it would otherwise hold were all rejected inside
     * 163.4 m by the old `STREAM_FROM` table. There is no such table now, so a
     * near sector genuinely does arrive full of casters and the SHADOW_REACH
     * test below is what carries the whole saving instead of merely tightening
     * it.
     *
     * That test still holds in steady walking, for the reason it always did: a
     * sector is newly wanted only when it crosses the ring boundary, 384 m out
     * for trees and 80 m for undergrowth, and the shadow camera is a 58 m box.
     * Where it bites is the first fill and any script that teleports — the two
     * cases where a sector really does land under your feet — and those now cost
     * more arms than they did. Measured at load after the change: see the
     * report; `shadowArms` is the counter to watch if the gate ever slows.
     */
    this.castingLayers = new Set(layers.filter((l) => l.castsShadow).map((l) => l.id));
    this.mirrors = new Map();
    for (const l of layers) {
      if (!l.mirrorOf) continue;
      const list = this.mirrors.get(l.mirrorOf) ?? [];
      list.push(l.id);
      this.mirrors.set(l.mirrorOf, list);
    }

    this.grids = [
      { kind: 'trees', size: TREE_SECTOR, ring: TREE_RING, live: new Map(), queue: [], last: null },
      { kind: 'under', size: UNDER_SECTOR, ring: UNDER_RING, live: new Map(), queue: [], last: null },
    ];

    this.inflight = new Set();
    this.done = [];
    this.built = 0;
    this.evicted = 0;
    this.shadowArms = 0;
    this.grows = 0;
    this._shadowDirty = false;
    this._changed = false;
    /**
     * Set by `eatPatch`, read and cleared by the next `update()`.
     *
     * `eatPatch` runs from the keydown handler, outside the frame that calls
     * `update()` — so a flag it set on `_changed` directly would be wiped out
     * by the unconditional reset at the top of the next `update()` before
     * `cull()` ever saw it, and the culler would only notice the eaten patch
     * once the player's own movement crossed the 2.5 m repack threshold. Same
     * shape of bug as the one the `update()` doc comment already describes for
     * arrivals, on the way out instead of the way in.
     */
    this._forced = false;

    /**
     * EVERY PATCH ID ANYBODY HAS EATEN, INCLUDING ONES NOT STREAMED IN.
     *
     * This exists because a sector is not permanent and `eatPatch` alone is not
     * either. Undergrowth evicts at `UNDER_RING * EVICT` — 120 m — and `_accept`
     * re-pushes a returning sector's patches from the worker payload, which has
     * never heard of anybody eating anything. So before this set, walking 120 m
     * away and back regrew the mushroom you had just eaten, and the doc comment
     * on `eatPatch` saying it "does not leave it standing" was true for as long
     * as you stayed in the neighbourhood of it.
     *
     * Ids and not sectors, because an id is what crosses the network. A patch id
     * is `under:sx,sz:i` — derived from the sector grid, which is derived from
     * the seed — so it names the same mushroom on every machine in the room
     * without anything having to be assigned or agreed. That is the whole reason
     * this is three lines of protocol rather than a synchronised world diff.
     *
     * Unbounded in principle and small in practice: one patch per undergrowth
     * sector, so the count is the number of mushrooms a room has eaten, and the
     * server caps what it will remember at `MAX_EATEN`.
     */
    this.eaten = new Set();
    /**
     * The sector keys of `eaten`, so `_accept` costs one lookup rather than a
     * scan of every eaten id on every arriving sector.
     */
    this._eatenSectors = new Set();

    /** sector key -> the glow points it contributed, rebuilt on any change. */
    this._glowBySector = new Map();
    this._glowDirty = false;

    const bounds = {};
    const bucketSize = {};
    for (const l of layers) {
      bounds[l.id] = l.bound;
      bucketSize[l.id] = l.bucketSize;
    }
    this._init = {
      type: 'init',
      seed,
      bounds,
      bucketSize,
      tints,
      archetypes,
      rockSizes,
    };

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
      // `new URL(..., import.meta.url)` rather than a Blob, so Vite sees the
      // dependency and rewrites the bare `three` import in dev and emits a real
      // chunk in a build. Same reasoning as ground.js.
      const w = new Worker(new URL('./forest-worker.js', import.meta.url), { type: 'module' });
      w.postMessage(this._init);
      w.onmessage = (e) => {
        this.done.push(e.data);
        this.inflight.delete(e.data.key);
        this.idle.push(w);
      };
      w.onerror = () => {
        /**
         * A worker that failed to load is worse than none, because the sectors
         * it was given never come back and the forest has a hole in it that
         * nothing will ever fill. Drop it. Unlike the ground there is no
         * main-thread fallback: a missing chunk is a hole you fall through and
         * had to be fixed at any cost, whereas a missing sector of trees on a
         * browser that cannot run module workers is a thinner wood, and 40 ms
         * of synchronous scatter per sector would be far worse than that.
         */
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
   * Bring both rings up to date for this camera. Called once a frame.
   *
   * @returns {boolean} whether any sector arrived or left, which the caller
   *   MUST forward to the culler as a forced repack. Found the hard way: the
   *   culler only repacks after 2.5 m of travel or 3° of turn, and a sector
   *   landing sets `writtenLength = -1` without repacking anything — so a
   *   player standing still watched sectors arrive and stay invisible until he
   *   next took three steps. Every automated check that positions the camera
   *   and holds it there saw an empty forest, which is precisely the case where
   *   nobody would think to look.
   */
  update(camera) {
    const px = camera.position.x;
    const pz = camera.position.z;
    this._changed = this._forced;
    this._forced = false;

    for (const grid of this.grids) {
      /**
       * The wanted set can only change when the camera crosses a sector
       * boundary, so the scan is skipped on the frames where it cannot have.
       *
       * The second clause is the self-healing one, exactly as in ground.js: if
       * a sector is ever lost — a worker that died holding a job, a result
       * discarded because it was evicted mid-build — the ring would otherwise
       * stay one sector short until the player happened to cross a boundary,
       * and there is no bound on how long that is.
       */
      const cell = `${Math.floor(px / grid.size)},${Math.floor(pz / grid.size)}`;
      if (cell !== grid.last || this.pending === 0) {
        grid.last = cell;
        this._rescan(grid, px, pz);
      }
    }

    this._dispatch();
    this._accept(px, pz);
    this._flushGlow();

    // Deliberately last, and at most one: see SHADOW_REACH. main.js calls
    // `atmosphere.follow` before `forest.cull`, so an arm raised here coalesces
    // with the one the anchor was going to raise anyway and costs nothing.
    if (this._shadowDirty) {
      this._shadowDirty = false;
      const renderer = this.renderer ?? (this.renderer = globalThis.RR?.renderer ?? null);
      if (renderer) renderer.shadowMap.needsUpdate = true;
    }
    return this._changed;
  }

  _rescan(grid, px, pz) {
    const ring2 = grid.ring * grid.ring;
    const evict2 = (grid.ring * EVICT) ** 2;

    grid.queue.length = 0;
    const lo = Math.floor((px - grid.ring) / grid.size);
    const hi = Math.floor((px + grid.ring) / grid.size);
    const loZ = Math.floor((pz - grid.ring) / grid.size);
    const hiZ = Math.floor((pz + grid.ring) / grid.size);
    for (let sz = loZ; sz <= hiZ; sz++) {
      for (let sx = lo; sx <= hi; sx++) {
        const d2 = sectorDistance2(sx, sz, grid.size, px, pz);
        // A disc, not a square, for the same reason the ground uses one: a
        // square guarantees only `ring` metres of cover in the axis directions
        // however it is centred, and the axis directions are where the player
        // is usually looking.
        if (d2 > ring2) continue;
        const key = `${grid.kind}:${sx},${sz}`;
        if (grid.live.has(key) || this.inflight.has(key)) continue;
        grid.queue.push({ key, kind: grid.kind, sx, sz, size: grid.size, d2 });
      }
    }
    // Nearest first: the sector you are about to walk into is the one whose
    // absence you would notice.
    grid.queue.sort((a, b) => a.d2 - b.d2);

    for (const [key, sector] of grid.live) {
      if (sectorDistance2(sector.sx, sector.sz, grid.size, px, pz) <= evict2) continue;
      this._drop(grid, key, sector);
    }
  }

  _drop(grid, key, sector) {
    for (const id of sector.layers) this.packers.get(id)?.remove(key);
    this.colliders.removeSector(key);
    this.bushZones.removeSector(key);
    if (sector.patches) {
      for (let i = this.patches.length - 1; i >= 0; i--) {
        if (this.patches[i].sector === key) this.patches.splice(i, 1);
      }
    }
    if (this._glowBySector.delete(key)) this._glowDirty = true;
    grid.live.delete(key);
    this.evicted++;
    this._changed = true;
  }

  /**
   * Remove one mushroom patch — because you ate it, or because somebody else in
   * the room did.
   *
   * Only `shroom-stem` and `shroom-cap` come off — not the sector's trees,
   * grass or rocks, which live under the same key on their own packers and
   * are untouched by `packer.remove`. That is safe rather than lucky: the
   * scatter never puts more than one patch in a sector (see the density
   * comment in scatter.js), so every mushroom instance filed under this
   * sector key belongs to this patch alone.
   *
   * THE PATCH NEED NOT BE STREAMED IN. Somebody two hundred metres away eating
   * one is the ordinary case in a room, and there is nothing on screen to
   * remove; the id is remembered and `_accept` honours it if that ground is ever
   * walked to. This is also what makes it safe to apply the whole of a
   * `welcome`'s eaten list at once, from a standing start, before a single
   * undergrowth sector has arrived.
   *
   * @returns {boolean} whether this id is news. False means it was already
   *   eaten, which is the caller's signal not to announce it again — it is what
   *   stops a relayed eat echoing back around the room.
   */
  eatPatch(id) {
    if (typeof id !== 'string' || !id) return false;
    if (this.eaten.has(id)) return false;
    this.eaten.add(id);
    this._eatenSectors.add(id.slice(0, id.lastIndexOf(':')));

    const i = this.patches.findIndex((p) => p.id === id);
    if (i === -1) return true;
    const { sector } = this.patches[i];
    this.patches.splice(i, 1);
    for (const layer of SHROOM_LAYERS) this.packers.get(layer)?.remove(sector);
    if (this._glowBySector.delete(sector)) this._glowDirty = true;
    this._forced = true;
    return true;
  }

  _dispatch() {
    while (this.idle.length) {
      /**
       * Undergrowth first when both rings want work.
       *
       * Not a fairness question — a preference about what the player can see.
       * An undergrowth sector is always within 96 m and is usually the ground
       * being walked on; a tree sector is 384 m away behind most of the fog in
       * the world. Bald ground under your feet is noticed instantly and a
       * missing far treeline is not noticed at all.
       */
      const grid = this.grids.find((g) => g.queue.length && g.kind === 'under') ??
        this.grids.find((g) => g.queue.length);
      if (!grid) break;
      const job = grid.queue.shift();
      if (grid.live.has(job.key) || this.inflight.has(job.key)) continue;
      const w = this.idle.pop();
      this.inflight.add(job.key);
      w.postMessage({ key: job.key, kind: job.kind, sx: job.sx, sz: job.sz, size: job.size });
    }
  }

  /**
   * Take AT MOST ONE finished sector per frame.
   *
   * What is left on the main thread is one typed-array `set` per layer into the
   * slab plus a bucket-list rebuild — the bucket SORT, which was 6.1 ms of a
   * prototype's 8.3 ms, happens in the worker now. What is not cheap is the
   * consequence: inserting buckets forces a full repack of that layer on the
   * next cull, and taking a whole queue at once would stack every one of those
   * onto the frame a boundary was crossed for no benefit whatever, because the
   * sectors are hundreds of metres away and nobody is waiting for them.
   *
   * The scene graph and the instance buffers are mutated HERE and nowhere else.
   * `onmessage` only appends to a list, so a sector can never appear between a
   * script's two renders of what is supposed to be the same frame — which is
   * what `cull-check.mjs` depends on to diff a culled render against an
   * unculled one.
   */
  _accept(px, pz) {
    const data = this.done.shift();
    if (!data) return;
    const grid = this.grids.find((g) => g.kind === data.kind);
    if (!grid || grid.live.has(data.key)) return;
    // It may have been evicted while it was in flight.
    if (sectorDistance2(data.sx, data.sz, grid.size, px, pz) > (grid.ring * EVICT) ** 2) return;

    /**
     * This sector's mushrooms have already been eaten, so it comes back without
     * them.
     *
     * DECLINING TO INSERT RATHER THAN REMOVING AFTERWARDS. `eatPatch` removes,
     * because by the time it runs the instances are on screen; here they are
     * not yet, and inserting two slabs into the packer only to take them out
     * again in the same frame would force a repack of both layers for a
     * mushroom nobody was ever going to see.
     *
     * Tested per SECTOR while `eaten` is per PATCH, and the two agree because
     * the scatter puts at most one patch in a sector — the same fact `eatPatch`
     * relies on to remove a whole sector's instances for one id. If that density
     * rule is ever relaxed, this is one of the two places that has to learn to
     * remove a subset.
     */
    const eaten = this._eatenSectors.has(data.key);

    const ids = [];
    for (const [id, packed] of Object.entries(data.layers)) {
      if (eaten && SHROOM_LAYERS.includes(id)) continue;
      const packer = this.packers.get(id);
      if (!packer) continue;
      packer.insert(data.key, packed);
      ids.push(id);
      for (const mirror of this.mirrors.get(id) ?? []) {
        this.packers.get(mirror)?.insert(data.key, packed);
        ids.push(mirror);
      }
    }
    this.colliders.addSector(data.key, data.collide);
    this.bushZones.addSector(data.key, data.rustle);

    if (data.patches.length) {
      for (let i = 0; i < data.patches.length; i += 3) {
        // Filtered by id and not by `eaten`, so that the thing you can walk up
        // to and press E at is exactly the thing that has a mushroom on it.
        const id = `${data.key}:${i / 3}`;
        if (this.eaten.has(id)) continue;
        this.patches.push({
          id,
          sector: data.key,
          x: data.patches[i],
          y: data.patches[i + 1],
          z: data.patches[i + 2],
        });
      }
    }
    if (data.glow.length && !eaten) {
      this._glowBySector.set(data.key, data.glow);
      this._glowDirty = true;
    }

    grid.live.set(data.key, {
      sx: data.sx,
      sz: data.sz,
      layers: ids,
      patches: data.patches.length > 0,
    });
    this.built++;
    this._changed = true;

    /**
     * Arm the shadow map only if this sector can actually change a texel.
     *
     * In steady walking it never can — a sector is newly wanted only when it
     * crosses the ring boundary, 384 m out for trees and 96 m for undergrowth,
     * and the shadow camera is a 58 m box. This matters for the first fill and
     * for scripts that teleport, where a sector genuinely does land under the
     * player's feet and its trees would otherwise cast no shadow until he
     * happened to walk six metres.
     */
    if (
      ids.some((id) => this.castingLayers.has(id)) &&
      sectorDistance2(data.sx, data.sz, grid.size, px, pz) < SHADOW_REACH * SHADOW_REACH
    ) {
      this._shadowDirty = true;
      this.shadowArms++;
    }
  }

  /**
   * Rebuild the mushroom glow cloud.
   *
   * One `THREE.Points` for every glow in the world rather than a `Sprite` each,
   * which is what the authored patches use. Seventy-five sprites near the
   * origin is seventy-five scene objects and was affordable; a sprite per cap
   * across a streaming ring is unbounded, and scene objects are the one cost in
   * this design that was worth restructuring the whole thing to avoid.
   *
   * Rebuilt wholesale on any change rather than slab-allocated, because the
   * whole cloud is a few hundred points — the bookkeeping would cost more than
   * the copy.
   */
  _flushGlow() {
    if (!this._glowDirty || !this.glow) return;
    this._glowDirty = false;
    let n = 0;
    for (const list of this._glowBySector.values()) n += list.length / 3;
    const attr = this.glow.geometry.getAttribute('position');
    if (attr.count < n) {
      const grown = new THREE.BufferAttribute(new Float32Array(Math.max(n, attr.count * 2) * 3), 3);
      this.glow.geometry.setAttribute('position', grown);
    }
    const array = this.glow.geometry.getAttribute('position').array;
    let at = 0;
    for (const list of this._glowBySector.values()) {
      array.set(list, at);
      at += list.length;
    }
    this.glow.geometry.getAttribute('position').needsUpdate = true;
    this.glow.geometry.setDrawRange(0, n);
    this.glow.visible = n > 0;
    // The cloud spans the ring, so three's own test can only ever say "maybe".
    // Answering it once here is cheaper than answering it wrongly every frame.
    this.glow.geometry.boundingSphere = null;
    this.glow.frustumCulled = false;
  }

  /** Everything a test needs to know whether the field has settled. */
  get pending() {
    let queued = 0;
    for (const grid of this.grids) queued += grid.queue.length;
    return queued + this.inflight.size + this.done.length;
  }

  /** Resident sectors, per grid, for diagnostics. */
  get sectors() {
    const out = {};
    for (const grid of this.grids) out[grid.kind] = grid.live.size;
    return out;
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
    for (const grid of this.grids) grid.live.clear();
  }
}
