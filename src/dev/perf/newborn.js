/**
 * WHAT THE RENDERER MET FOR THE FIRST TIME, AND HOW BIG IT WAS.
 *
 * `renderer.info.memory.geometries` is the counter both hitch reports lean on
 * hardest — `perf:spikes` measured it at a ×20 lift over ordinary frames at the
 * deep station, the largest of anything it can attribute — and on its own it
 * says almost nothing. "A geometry was allocated" covers a 24-vertex box that
 * costs nothing and a 33 000-vertex cave mesh that is 1.8 MB of synchronous
 * `bufferData`, and the report had no way to tell them apart. This does.
 *
 *
 * THE COUNTER DOES NOT MEAN WHAT ITS NAME SUGGESTS, WHICH IS THE WHOLE POINT.
 *
 * It does not move when a geometry is BUILT. It moves the first time one
 * reaches `WebGLGeometries.get`, which is the first time it is drawn — and that
 * is the frame the driver uploads every one of its attribute buffers. Measured
 * over a 20 s walk at the deep station: eight ground chunks were constructed,
 * and twenty-nine were met. The other twenty-one had been built and accepted
 * seconds earlier, out of the frustum, and were met on the frame the player
 * turned far enough to face them.
 *
 * That gap is not a detail, it is the reason the existing counters could not
 * find this. `forest.groundField` announces a chunk when it lands, so the
 * `ground chunk` cause fires on a cheap frame, and the expensive frame — some
 * seconds later, triggered by a mouse movement — has no counter of its own and
 * reads as "no counter this watches moved". The same is true of every streamed
 * or lazily-revealed mesh in the world, and it will be true of everything the
 * visual overhaul adds.
 *
 *
 * WHY IT HOOKS THE DRAW CALL RATHER THAN THE CONSTRUCTOR.
 *
 * Because the construction site is the wrong answer. Knowing that
 * `gridGeometry` made it tells you where to look for the allocation; knowing
 * that a 416 KB `ground-chunk` was first submitted on THIS frame tells you what
 * that frame paid for. `renderBufferDirect` is a public method on the renderer
 * and is handed the geometry, the material and the object, so one wrapper names
 * all three.
 *
 *
 * WHAT IT COSTS PER FRAME. One property load per draw call — `__rrMet` is
 * undefined exactly once per geometry and truthy for ever after — and nothing
 * else. No Set, no Map, no allocation on the ordinary path; the describe-and-
 * push branch runs once in the life of each geometry in the world. Dev-only,
 * imported from the same `if (__PERF__)` block as the rest of this directory
 * and stripped by the same mechanism (`npm run check:perfstrip`).
 *
 *
 * ONE WRAPPER, HOWEVER MANY READERS. `freezes.js` runs in a player's session
 * and `probe.js` runs under the automation, and both want this; installing it
 * twice would wrap the wrapper and double-count. So the log is append-only and
 * shared, and each reader keeps its own cursor into it.
 */

const KEY = '__rrNewborn';

/**
 * Bytes the driver has to move to make this geometry drawable: every attribute
 * plus the index. This is the number that decides whether a first draw is felt.
 */
function sizeOf(geometry) {
  let bytes = 0;
  for (const name in geometry.attributes) {
    const a = geometry.attributes[name];
    bytes += a.array?.byteLength ?? 0;
  }
  if (geometry.index) bytes += geometry.index.array?.byteLength ?? 0;
  return bytes;
}

/**
 * Install (once) and return the shared log.
 *
 * @param {import('three').WebGLRenderer} renderer
 * @returns {{ log: Array<{what: string, bytes: number}> }}
 */
export function newbornWatch(renderer) {
  if (renderer[KEY]) return renderer[KEY];

  const log = [];
  const handle = { log };
  renderer[KEY] = handle;

  const inner = renderer.renderBufferDirect.bind(renderer);
  renderer.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    if (geometry !== undefined && geometry.__rrMet === undefined) {
      geometry.__rrMet = 1;
      /**
       * The object's name before the geometry's type, because the object is
       * what somebody can search the source for. `ground-chunk`, `cave`,
       * `trunk` are all names set at the site that built them; an unnamed
       * object falls back to its class, which is still more than the counter
       * gave.
       */
      log.push({
        what: object?.name || `${object?.type ?? 'object'}/${geometry.type ?? 'BufferGeometry'}`,
        bytes: sizeOf(geometry),
      });
    }
    return inner(camera, scene, geometry, material, object, group);
  };

  return handle;
}

/**
 * Fold everything logged since `cursor` into one line and the new cursor.
 *
 * Returns the count, the total bytes and a short readable summary — "2×
 * ground-chunk 832 KB" — rather than the raw list, because that is what both
 * readers print, and because a frame that meets forty small props should not
 * produce forty lines in a freeze log.
 */
export function drainNewborn(log, cursor) {
  if (cursor >= log.length) return { cursor, count: 0, bytes: 0, summary: '' };
  const counts = new Map();
  let bytes = 0;
  for (let i = cursor; i < log.length; i++) {
    const e = log[i];
    bytes += e.bytes;
    const seen = counts.get(e.what);
    if (seen) seen.n++, (seen.bytes += e.bytes);
    else counts.set(e.what, { n: 1, bytes: e.bytes });
  }
  const parts = [];
  for (const [what, v] of [...counts].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 4)) {
    parts.push(`${v.n > 1 ? `${v.n}× ` : ''}${what} ${kb(v.bytes)}`);
  }
  if (counts.size > 4) parts.push(`+${counts.size - 4} more`);
  return {
    cursor: log.length,
    count: log.length - cursor,
    bytes,
    summary: parts.join(', '),
  };
}

export function kb(bytes) {
  if (bytes >= 1e6) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
