import { boot, argv, heading, PAD, DEV_URL, PERF_BUILD_URL, PERF_DIR, writeJson } from './harness.mjs';

/**
 * WHICH BUFFER UPLOAD FROZE THE FRAME.
 *
 *   npm run perf:uploads
 *   npm run perf:uploads -- --seconds=45 --station=deep
 *
 * `perf:spikes` gets as far as "the slow frames allocated a geometry and spent
 * all their time inside render()", and then stops, because `info.memory.
 * geometries` is a COUNT — it says one more geometry exists, not which one and
 * not how big it was.
 *
 * three uploads a geometry's buffers the first time that geometry is actually
 * DRAWN, inside `renderBufferDirect`, synchronously on the main thread. An
 * object that has been sitting in the scene since boot pays nothing until the
 * frustum finds it — so the bill arrives on the frame the camera turns far
 * enough to see it, which is why this reads to a player as "it freezes when I
 * move the mouse" and never as "it freezes when I walk".
 *
 * So this wraps `renderBufferDirect`, keeps a WeakSet of geometries it has seen
 * drawn, and times the first call for each one. That is the upload, isolated:
 * same call on the same frame the counter moves, with the object's name and its
 * byte count attached.
 */

const args = argv({ station: 'deep', seconds: '40', threshold: '2', level: 'sober' });
const SECONDS = Number(args.seconds);
const THRESHOLD = Number(args.threshold);

const { browser, page } = await boot({
  url: args.build === 'true' ? PERF_BUILD_URL : DEV_URL,
  /**
   * Vsync ON, unlike every other probe here. Uncapped, this page runs at 500 fps
   * and the driver's queue backs up, which produces 90 ms blocking frames INSIDE
   * `render` that no player with vsync could ever see — measured, and they swamp
   * the events this is looking for. What is being measured here is a one-off
   * cost paid on a specific frame, not headroom, so the pacing is free to be
   * realistic.
   */
  vsync: true,
});

/**
 * The wrapper goes on BEFORE anything moves the camera, and deliberately not
 * inside `__RR_PERF__.walk` — `walk` calls `arrive`, which settles the station
 * by rendering it for several frames, and settling is itself a first draw of
 * everything visible from there. Measured through `walk`, every upload lands in
 * the settle and the walk looks clean; that is the instrument hiding the
 * finding, not the finding being absent.
 */
await page.evaluate(() => {
  const renderer = window.RR.renderer;
  const seen = new WeakSet();
  const events = [];
  const original = renderer.renderBufferDirect;
  /**
   * COMPILE OR UPLOAD — the two are not the same finding and they do not have
   * the same fix.
   *
   * `setProgram` runs INSIDE `renderBufferDirect`, so a lazy shader compile and
   * a first buffer upload both land in this timing, and a 66 ms event on a
   * geometry of two kilobytes is obviously not the two kilobytes. Sampling
   * `info.programs.length` either side of the call separates them without
   * having to reason from the byte count: if the program table grew, this frame
   * built a shader.
   */
  renderer.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    if (seen.has(geometry)) {
      return original.call(this, camera, scene, geometry, material, object, group);
    }
    seen.add(geometry);
    const programsBefore = renderer.info.programs?.length ?? 0;
    const t0 = performance.now();
    const r = original.call(this, camera, scene, geometry, material, object, group);
    const ms = performance.now() - t0;
    const compiled = (renderer.info.programs?.length ?? 0) - programsBefore;
    /** The path back to the root, so `(unnamed)` still points at a file. */
    const chain = [];
    for (let o = object; o && chain.length < 6; o = o.parent) {
      chain.push(o.name || o.type);
    }
    let bytes = 0;
    for (const a of Object.values(geometry.attributes ?? {})) bytes += a.array?.byteLength ?? 0;
    if (geometry.index) bytes += geometry.index.array.byteLength ?? 0;
    let instanceBytes = 0;
    if (object.isInstancedMesh) {
      instanceBytes += object.instanceMatrix?.array?.byteLength ?? 0;
      instanceBytes += object.instanceColor?.array?.byteLength ?? 0;
      for (const a of Object.values(geometry.attributes ?? {})) {
        if (a.isInstancedBufferAttribute) instanceBytes += a.array?.byteLength ?? 0;
      }
    }
    events.push({
      ms,
      at: performance.now(),
      compiled,
      chain: chain.join(' < '),
      object: object.name || '(unnamed)',
      type: object.type,
      material: material.name || material.type,
      bytes,
      instanceBytes,
      count: object.isInstancedMesh ? object.count : (geometry.index?.count ?? geometry.attributes?.position?.count ?? 0),
      groups: geometry.groups?.length ?? 0,
    });
    return r;
  };
  window.__UPLOADS = events;
});

/**
 * A LOOK TOUR, not a walk.
 *
 * The point is to spend the camera's angular budget rather than its distance
 * budget: stand somewhere, sweep the whole circle in coarse flicks the way a
 * hand on a mouse does, then move on and do it again. A straight walk with a
 * fixed heading discovers new geometry slowly, in the order the streamer
 * happens to deliver it, and never revisits the 300° behind the player — which
 * is exactly where a never-drawn object waits.
 */
const tour = await page.evaluate(
  ([seconds, stationName, level]) =>
    new Promise((resolve) => {
      const R = window.RR;
      const c = R.controller;
      const stations = {
        deep: { x: -30, z: -40 },
        clearing: { x: 0, z: 5 },
      };
      const home = stations[stationName] ?? stations.deep;
      c.position.x = home.x;
      c.position.z = home.z;
      c.velocity.set(0, 0, 0);
      if (level !== 'sober') R.director.seek(level === 'egodeath' ? 250 : 160);

      const started = performance.now();
      const intervals = [];
      /**
       * EVERY program built after the gate, from every pass.
       *
       * Wrapping `renderBufferDirect` only sees compiles that happen on a scene
       * draw — it is blind to the shadow pass, to the post chain, and to
       * anything three builds outside a buffer draw. `info.programs` is the
       * renderer's own table and misses none of them, so this is the number the
       * claim "the pre-warm is complete" actually rests on. Keyed by cacheKey
       * rather than by length: the table is not append-only, a program whose
       * usedTimes falls to zero is released, and a length diff would then
       * report a compile that did not happen.
       */
      const seenPrograms = new Set((R.renderer.info.programs ?? []).map((p) => p.cacheKey));
      const compiled = [];
      let last = started;
      /**
       * Flick, hold, flick — a fixed schedule rather than a random one, so two
       * runs of this cover the same angles in the same order and a finding is
       * reproducible instead of anecdotal.
       */
      const tick = () => {
        const now = performance.now();
        intervals.push({ ms: now - last, at: now });
        last = now;
        const t = (now - started) / 1000;
        for (const p of R.renderer.info.programs ?? []) {
          if (seenPrograms.has(p.cacheKey)) continue;
          seenPrograms.add(p.cacheKey);
          compiled.push({ name: p.name || 'unnamed', at: now, t: +t.toFixed(1), frameMs: intervals.at(-1).ms });
        }
        // One full revolution every 4 s, in ~12° steps: over the culler's 3°
        // repack threshold every frame, the way a real hand is.
        c.yaw = t * (Math.PI / 2) + Math.sin(t * 11) * 0.22;
        c.pitch = Math.sin(t * 0.7) * 0.5;
        /**
         * AN OUTWARD SPIRAL, not a fixed circle.
         *
         * A circle of 34 m re-treads ground it has already paid the first draw
         * for within one lap, so after the first lap it can only find what the
         * streamer happens to deliver. The spiral keeps arriving somewhere new
         * for the whole run — which is the condition a lazy compile needs, and
         * the reason to run this long rather than often.
         */
        const radius = 20 + t * 3.2;
        c.position.x = home.x + Math.cos(t * 0.35) * radius;
        c.position.z = home.z + Math.sin(t * 0.35) * radius;
        if (now - started > seconds * 1000) {
          resolve({ intervals, frames: intervals.length, compiled });
        } else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  [SECONDS, args.station, args.level]
);

const uploads = await page.evaluate(() => window.__UPLOADS);
await browser.close();

const sorted = [...uploads].sort((a, b) => b.ms - a.ms);
const total = uploads.reduce((n, u) => n + u.ms, 0);

console.log(heading('first-draw buffer uploads during the look tour'));
console.log(`  ${tour.frames} frames over ${SECONDS}s`);
console.log(`  ${uploads.length} geometries drawn for the first time, ${total.toFixed(0)} ms in total`);
console.log(`  worst single upload: ${(sorted[0]?.ms ?? 0).toFixed(1)} ms\n`);

/**
 * The headline claim, stated as a count rather than left to be inferred from
 * an absence of rows. "No program compiled" and "no program compile was
 * noticed" are different sentences and only one of them is evidence.
 */
console.log(
  `  ${tour.compiled.length} programs compiled after the gate` +
    (tour.compiled.length ? ':' : ' — the pre-warm covered this whole tour.')
);
for (const c of tour.compiled) {
  console.log(`    ${PAD(c.name, 30)} at ${String(c.t).padStart(6)}s, on a ${c.frameMs.toFixed(1)} ms frame`);
}
console.log();

console.log(`${PAD('  object', 26)}${PAD('material', 20)}${PAD('ms', 8)}${PAD('why', 10)}${PAD('bytes', 11)}where`);
for (const u of sorted.filter((u) => u.ms >= THRESHOLD).slice(0, 40)) {
  console.log(
    PAD(`  ${u.object}`, 26) +
      PAD(u.material, 20) +
      PAD(u.ms.toFixed(1), 8) +
      PAD(u.compiled > 0 ? `compile` : 'upload', 10) +
      PAD(`${((u.bytes + u.instanceBytes) / 1e6).toFixed(2)} MB`, 11) +
      `${u.chain}`
  );
}

/** Grouped, because forty sectors of the same slab are one finding. */
const byName = new Map();
for (const u of uploads) {
  const row = byName.get(u.object) ?? { n: 0, ms: 0, worst: 0, bytes: 0 };
  row.n++;
  row.ms += u.ms;
  row.bytes += u.bytes + u.instanceBytes;
  row.worst = Math.max(row.worst, u.ms);
  byName.set(u.object, row);
}
console.log(heading('grouped by object name'));
console.log(`${PAD('  object', 34)}${PAD('n', 6)}${PAD('total ms', 11)}${PAD('worst', 9)}bytes`);
for (const [name, r] of [...byName.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 25)) {
  console.log(
    PAD(`  ${name}`, 34) +
      PAD(String(r.n), 6) +
      PAD(r.ms.toFixed(1), 11) +
      PAD(r.worst.toFixed(1), 9) +
      `${(r.bytes / 1e6).toFixed(2)} MB`
  );
}

/**
 * The frames a player would see drop, and how much of each one this explains.
 * A long frame with no upload on it is a different bug and should not be
 * quietly absorbed into this one.
 */
const DROP = 16.7;
const dropped = tour.intervals.filter((f) => f.ms > DROP);
console.log(heading('frames over 16.7 ms, and what was uploading during them'));
console.log(`  ${dropped.length} of ${tour.frames} frames (${((dropped.length / tour.frames) * 100).toFixed(2)}%)\n`);
for (const f of dropped.sort((a, b) => b.ms - a.ms).slice(0, 20)) {
  const during = uploads.filter((u) => u.at > f.at - f.ms && u.at <= f.at);
  const share = during.reduce((n, u) => n + u.ms, 0);
  console.log(
    `  ${f.ms.toFixed(1).padStart(7)} ms   ` +
      (during.length
        ? `${share.toFixed(1)} ms of it uploading: ${during.map((u) => u.object).join(', ')}`
        : 'no first-draw upload on this frame')
  );
}

const path = `${PERF_DIR}/uploads-${args.station}.json`;
writeJson(path, { seconds: SECONDS, frames: tour.frames, uploads: sorted.slice(0, 200) });
console.log(`\n${path}\n`);
