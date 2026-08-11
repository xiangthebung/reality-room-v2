import { bucketLayer, treeSector, underSector } from './scatter.js';
import { setWorldSeed } from './terrain.js';

/**
 * The forest, built off the main thread.
 *
 * Same argument as `terrain-worker.js`, only more so. A 256 m tree sector runs
 * `heightAt` and `slopeAt` over four thousand candidates and composes a matrix,
 * a tint and a bounding sphere for each of the two thousand that survive; a
 * 64 m understorey sector does the same for twenty-five thousand blades of
 * grass. On the main thread that is several frames' worth of arithmetic
 * happening at the exact moment the player walks somewhere, which is the one
 * moment a hitch is most obvious.
 *
 *
 * IT RETURNS BUCKET-CONTIGUOUS BUFFERS, NOT A LIST OF INSTANCES.
 *
 * This is the part that matters and it is easy to under-value. The main-thread
 * packer sorted instances into XZ buckets with a `Map` keyed on a template
 * string, and that sort — not the scatter, not the geometry, not the upload —
 * was 6.1 ms of the 8.3 ms a prototype sector cost. It is pure
 * bookkeeping: no GL, no DOM, nothing that has to be on the main thread. So it
 * happens here, and what crosses the boundary is a `Float32Array` the GPU can
 * take verbatim plus a small table of bucket spheres. The main thread's share
 * of a sector is now one `set` into a slab and a bucket-list rebuild.
 *
 *
 * EVERY BUFFER IS TRANSFERRED. A big understorey sector is about 2 MB of
 * matrices, and copying that twice per message would hand most of the saving
 * straight back. Nothing here keeps a sector after posting it, so the detached
 * buffers on this side cost nothing.
 *
 *
 * WHY THE TINT PALETTES ARRIVE AS DATA.
 *
 * The species colours live in `trees.js`, which a worker cannot import: it
 * pulls in `textures.js`, which draws bark and leaves on a canvas. Rather than
 * duplicate the palettes here — where they would drift, and the streamed wood
 * would slowly stop matching the authored one — they are read from the single
 * definition on the main thread and shipped in with `init`. Same for the
 * geometry bounding spheres, which cannot be known without the geometry.
 */

/** Filled by the init message: seed, tint palettes, geometry bounds, bucket sizes. */
let config = null;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    config = msg;
    /**
     * TELL THIS REALM WHICH WORLD IT IS BUILDING, BEFORE IT BUILDS ANY OF IT.
     *
     * A worker is a separate realm, so `terrain.js` here is a SECOND instance of
     * the module with its own seed state — and that state defaults to the
     * authored world. Until this line, every streamed sector ran `heightAt` and
     * `slopeAt` against `grove-01` while the ground beneath it was being built
     * by `terrain-worker.js` from the session's actual seed. Inside about
     * 160 m the two agree exactly (the region field is the identity there, see
     * REGION_INNER), which is precisely why it survived review: the wood you
     * spawn in is correct. Past ~170 m the trees came out a mean of 9.5–12.1 m
     * off, worst ±43 m, and at 2 km there is a screenshot of a bank of trunks
     * hanging in mid-air with their shadows on the ground below them.
     *
     * `msg.seed` is the same string `forest-field.js` already hands to every
     * scatter rng in here, and `main.js` passes the same one to `setWorldSeed`
     * and to `buildForest` — so seeding from it makes this realm's terrain and
     * its scatter consistent by construction rather than by coincidence, and
     * makes all three agree.
     *
     * `setWorldSeed` also publishes onto this worker's `globalThis`, so any
     * further copy of terrain.js that appears in this realm adopts it too.
     */
    setWorldSeed(msg.seed);
    return;
  }

  const { key, kind, sx, sz, size } = msg;
  const built =
    kind === 'trees'
      ? treeSector({
          seed: config.seed,
          sx,
          sz,
          size,
          archetypes: config.archetypes,
          bounds: config.bounds,
          tints: config.tints,
        })
      : underSector({
          seed: config.seed,
          sx,
          sz,
          size,
          bounds: config.bounds,
          rockSizes: config.rockSizes,
        });

  const layers = {};
  const transfer = [];
  for (const [id, layer] of built.layers) {
    if (layer.length === 0) continue;
    const packed = bucketLayer(layer, config.bucketSize[id] ?? 24);
    layers[id] = packed;
    transfer.push(packed.matrix.buffer, packed.buckets.buffer);
    if (packed.color) transfer.push(packed.color.buffer);
  }

  const collide = new Float32Array(built.collide);
  const rustle = new Float32Array(built.rustle);
  const patches = new Float32Array(built.patches);
  const glow = new Float32Array(built.glow);
  transfer.push(collide.buffer, rustle.buffer, patches.buffer, glow.buffer);

  self.postMessage({ key, kind, sx, sz, layers, collide, rustle, patches, glow }, transfer);
};
