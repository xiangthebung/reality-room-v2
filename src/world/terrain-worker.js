import { getWorldSeed, heightGrid, setWorldSeed } from './terrain.js';

/**
 * The ground, built off the main thread.
 *
 * A 128 m chunk is 6561 vertices and about 6 ms of `heightAt`, which is a third
 * of a frame at 60 Hz and a whole frame at 144 — so building one inline is a
 * visible hitch every time the player crosses a chunk boundary, and crossing a
 * boundary is something that happens for the rest of the session. Off-thread it
 * costs the main thread only the assembly of five typed arrays into a
 * BufferGeometry, measured at 0.20 ms p50 / 1.90 ms max.
 *
 * WHY THIS FILE IS THREE LINES AND NOT A COPY OF THE TERRAIN CODE.
 *
 * The single worst way to build this would be to re-implement the height field
 * here, because then the geometry the player SEES and the geometry the player
 * WALKS ON — `groundUnder`, still called on the main thread every frame — would
 * be two implementations of the same maths that could drift apart by a
 * centimetre and drop somebody through a hill. So the worker imports the same
 * `terrain.js` the game does. `heightAt`, `wetness`, `softFloor` and
 * `streamBank` are pure arithmetic over `util.js` and touch no THREE, no DOM
 * and no GL; the only thing the module pulls in that a worker cannot have is
 * `THREE.Color`, and a module worker imports three perfectly happily.
 *
 *
 * SAME FILE, DIFFERENT REALM — WHICH IS WHY THE SEED HAS TO ARRIVE BY MESSAGE.
 *
 * Importing the same module does NOT mean sharing its state. A worker gets its
 * own instance of `terrain.js` with its own copy of every binding in it, so the
 * world seed set on the main thread is simply not here, and without the two
 * lines below this file would cheerfully build the authored world's ground
 * underneath another world's trees. That failure has no error and no console
 * warning; it looks like floating trees, and only in the chunks a worker
 * happened to build, which is most of them.
 *
 * Applied only when it changes, because `setWorldSeed` re-derives forty-odd
 * parameters and runs two bounded search loops — tens of microseconds, nothing
 * next to a 6 ms chunk, but it is per-message work for a value that changes
 * once per session.
 *
 * `THREE.Color` is worth the import rather than a hand-rolled HSL: the biome
 * blend leans on `offsetHSL` four times per vertex and a re-implementation
 * drifted visibly in the pale, desaturated colours the far ridge is made of.
 * It costs 0.29 µs a vertex, which the padded-normal grid pays back several
 * times over.
 *
 * Every buffer is TRANSFERRED, not cloned. 416 KB a chunk copied twice per
 * message would be most of the saving handed back; the transfer costs 0.1–1.1 ms
 * round trip and leaves this side holding detached buffers, which is fine
 * because nothing here keeps a chunk after it has posted it.
 */
self.onmessage = (e) => {
  const { key, ox, oz, seg, cell, seed = 0 } = e.data;
  if (seed !== getWorldSeed()) setWorldSeed(seed);
  const g = heightGrid(ox, oz, seg, cell);
  self.postMessage({ key, ox, oz, ...g }, [
    g.position.buffer,
    g.normal.buffer,
    g.color.buffer,
    g.aWet.buffer,
    g.index.buffer,
  ]);
};
