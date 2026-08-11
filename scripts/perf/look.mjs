import { boot, argv, heading, PAD, DEV_URL, PERF_BUILD_URL, PERF_DIR, writeJson } from './harness.mjs';
import { median, quantile } from './stats.mjs';

/**
 * IS IT TURNING, OR IS IT MOVING?
 *
 *   npm run perf:look
 *   npm run perf:look -- --leg=12 --level=peak
 *
 * Every other probe in this directory moves the camera and turns it at the same
 * time, because that is what walking looks like — and the one report this game
 * keeps getting is about the mouse specifically, standing or not. A walk that
 * does both cannot tell those apart, and the two have completely different
 * fixes: turning changes the FRUSTUM (culling, first draws, shadow direction),
 * moving changes the STREAMED SET (sectors in, sectors out, geometry created).
 *
 * So the segments here vary exactly one of the two at a time, and every segment
 * is measured the same way: per-frame wall clock, the counter deltas that say
 * what the frame did, and Long Animation Frames for the frames the counters
 * cannot explain.
 */

const args = argv({ station: 'deep', level: 'sober', leg: '10' });
const LEG = Number(args.leg);

const { browser, page } = await boot({
  url: args.build === 'true' ? PERF_BUILD_URL : DEV_URL,
  vsync: args.vsync === 'true',
});
if (args.vsync === 'true') console.log('vsync ON — frame intervals are what a player would see\n');

/**
 * The recorder, installed once and left running across every segment.
 *
 * One rAF chain for the whole run rather than one per segment: a segment
 * boundary is then just a label on a frame, so nothing is lost in the handover
 * and the segments are directly comparable — same observer, same clock, same
 * warm state.
 */
await page.evaluate(() => {
  const R = window.RR;
  const S = {
    phase: 'idle',
    yawRate: 0,
    flick: 0,
    walk: 0,
    frames: [],
    loaf: [],
    started: performance.now(),
  };
  window.__LOOK = S;

  const info = R.renderer.info;
  const mem = performance.memory;
  const seenPrograms = new Set((info.programs ?? []).map((p) => p.cacheKey));

  /**
   * First-draw buffer uploads, named. `info.memory.geometries` moving says one
   * more geometry exists; this says which object it belonged to and how long
   * the frame sat in `renderBufferDirect` for it. `setProgram` runs inside that
   * same call, so a lazy shader compile lands here too and is separated below
   * by whether `info.programs` also moved.
   */
  const seenGeom = new WeakSet();
  const originalRBD = R.renderer.renderBufferDirect;
  let uploadMs = 0;
  const uploadNames = [];
  R.renderer.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    if (seenGeom.has(geometry)) {
      return originalRBD.call(this, camera, scene, geometry, material, object, group);
    }
    seenGeom.add(geometry);
    const t0 = performance.now();
    const r = originalRBD.call(this, camera, scene, geometry, material, object, group);
    uploadMs += performance.now() - t0;
    uploadNames.push(object.name || material.name || '(unnamed)');
    return r;
  };

  /**
   * WHICH CALL INSIDE `frame()`.
   *
   * Long Animation Frames gets as far as "script, in frame()" and stops; this
   * is the same trick probe.js uses to finish the sentence, wrapping the
   * methods on the objects `RR` already exposes rather than editing main.js.
   * Two `performance.now()` calls per phase, paid equally by every phase, so it
   * cannot change their ranking.
   */
  const phaseAccum = Object.create(null);
  for (const [name, owner, method] of [
    ['controller', R.controller, 'update'],
    ['ferry', R.ferry, 'update'],
    ['seats', R.seats, 'update'],
    ['sitting', R.sitting, 'update'],
    ['director', R.director, 'update'],
    ['atmosphere.follow', R.atmosphere, 'follow'],
    ['atmosphere.tick', R.atmosphere, 'tick'],
    ['net', R.net, 'update'],
    ['gathering', R.gathering, 'update'],
    ['fishing', R.fishing, 'update'],
    ['social', R.social, 'update'],
    ['fauna', R.fauna, 'update'],
    ['caves', R.caves, 'update'],
    ['cull', R.forest, 'cull'],
    ['render', R.pipeline, 'render'],
    ['shadow', R.renderer.shadowMap, 'render'],
    ['audio.listener', R.audio, 'updateListener'],
    ['audio.levels', R.audio, 'sampleLevels'],
  ]) {
    if (!owner || typeof owner[method] !== 'function') continue;
    const original = owner[method];
    owner[method] = function timed(...a) {
      const t0 = performance.now();
      try {
        return original.apply(this, a);
      } finally {
        phaseAccum[name] = (phaseAccum[name] ?? 0) + (performance.now() - t0);
      }
    };
  }
  S.phaseAccum = phaseAccum;

  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        S.loaf.push({
          phase: S.phase,
          duration: e.duration,
          blocking: e.blockingDuration,
          renderDelay: e.renderStart ? e.renderStart - e.startTime : 0,
          styleAndLayout: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0,
          scripts: (e.scripts ?? []).map((s) => ({
            fn: s.sourceFunctionName,
            invoker: s.invoker,
            source: s.sourceURL,
            at: s.sourceCharPosition,
            duration: s.duration,
          })),
        });
      }
    });
    obs.observe({ type: 'long-animation-frame', buffered: false });
    S.loafSupported = true;
  } catch {
    S.loafSupported = false;
  }

  let last = performance.now();
  let prev = null;
  const tick = () => {
    const now = performance.now();
    const c = R.controller;
    const t = (now - S.started) / 1000;

    /**
     * The camera is driven straight rather than through synthetic mouse events.
     * `controller.mousemove` does two multiplies and a clamp — it is not the
     * suspect and never was — and driving Playwright's mouse at 300 Hz adds a
     * second event loop to the thing being measured. What matters is the yaw
     * SCHEDULE, and this reproduces it exactly.
     *
     * `flick` is the shape a hand actually makes: short, fast, over the
     * culler's ~3 deg repack threshold on most frames, rather than the smooth
     * constant-rate spin the other probes use — which crosses it predictably
     * and far less often.
     */
    if (S.flick) c.yaw += Math.sin(t * 13.7) * S.flick + Math.sin(t * 5.1) * S.flick * 0.5;
    if (S.yawRate) c.yaw += S.yawRate * (1 / 60);
    if (S.walk) {
      c.position.x += -Math.sin(c.yawWalk ?? 0) * S.walk * (1 / 60);
      c.position.z += -Math.cos(c.yawWalk ?? 0) * S.walk * (1 / 60);
    }

    const now2 = performance.now();
    const cur = {
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      built: R.forest.field?.built ?? 0,
      evicted: R.forest.field?.evicted ?? 0,
      ground: R.forest.groundField?.group?.children?.length ?? 0,
      uploaded: R.forest.culler?.uploaded ?? 0,
      heap: mem ? mem.usedJSHeapSize : 0,
    };
    const fresh = [];
    for (const p of info.programs ?? []) {
      if (seenPrograms.has(p.cacheKey)) continue;
      seenPrograms.add(p.cacheKey);
      fresh.push(p.name || 'unnamed');
    }
    if (prev) {
      S.frames.push({
        phase: S.phase,
        ms: now - last,
        at: now,
        /**
         * Snapshot and clear. This callback is registered after the game's own
         * frame callback and rAF fires in registration order, so everything in
         * the accumulator belongs to the frame whose interval was just taken.
         */
        parts: { ...phaseAccum },
        uploadMs,
        uploads: uploadNames.slice(),
        fresh,
        programs: cur.programs - prev.programs,
        geometries: cur.geometries - prev.geometries,
        textures: cur.textures - prev.textures,
        built: cur.built - prev.built,
        evicted: cur.evicted - prev.evicted,
        ground: cur.ground - prev.ground,
        repacked: cur.uploaded !== prev.uploaded ? cur.uploaded : 0,
        heap: cur.heap - prev.heap,
      });
    }
    uploadMs = 0;
    uploadNames.length = 0;
    for (const k of Object.keys(phaseAccum)) delete phaseAccum[k];
    prev = cur;
    last = now;
    void now2;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const set = (patch) =>
  page.evaluate((p) => Object.assign(window.__LOOK, p), patch);

const home = (station) =>
  page.evaluate((s) => {
    const stations = { deep: { x: -30, z: -40, yaw: 2.1 }, clearing: { x: 0, z: 5, yaw: 0 } };
    const h = stations[s] ?? stations.deep;
    const c = window.RR.controller;
    c.position.x = h.x;
    c.position.z = h.z;
    c.velocity.set(0, 0, 0);
    c.yaw = h.yaw;
    c.pitch = -0.05;
    c.yawWalk = h.yaw;
  }, station);

async function segment(name, seconds, patch) {
  await home(args.station);
  await set({ phase: 'settling', yawRate: 0, flick: 0, walk: 0 });
  await page.waitForTimeout(2500);
  await set({ phase: name, yawRate: 0, flick: 0, walk: 0, ...patch });
  process.stdout.write(`  ${name}…`);
  await page.waitForTimeout(seconds * 1000);
  await set({ phase: 'idle', yawRate: 0, flick: 0, walk: 0 });
  console.log(' done');
}

if (args.level !== 'sober') {
  const seconds = { peak: 160, egodeath: 250 }[args.level];
  await page.evaluate((s) => window.RR.director.seek(s), seconds);
  await page.waitForTimeout(2500);
}

console.log(`segments (${LEG}s each, ${args.station}, ${args.level})`);
/**
 * `still` first, as the control. Everything the game does with no input at all
 * — the wind, the sun, the animals, the audio — is in this row, so any segment
 * that is worse than it is worse BY the thing that segment adds and not by the
 * game merely existing.
 */
await segment('still', LEG, {});
/** Pure rotation, no translation: frustum churn with a frozen streamed set. */
await segment('flick', LEG, { flick: 0.075 });
await segment('spin', LEG, { yawRate: 1.4 });
/** Pure translation, fixed heading: streaming with a near-frozen frustum. */
await segment('walk', LEG, { walk: 4.2 });
/** Both, which is what a player actually does. */
await segment('walk-flick', LEG, { walk: 4.2, flick: 0.075 });

const data = await page.evaluate(() => ({
  frames: window.__LOOK.frames,
  loaf: window.__LOOK.loaf,
  loafSupported: window.__LOOK.loafSupported,
}));
await browser.close();

const PHASES = ['still', 'flick', 'spin', 'walk', 'walk-flick'];
const rows = PHASES.map((p) => data.frames.filter((f) => f.phase === p));

console.log(heading('what each kind of motion costs'));
console.log(
  `${PAD('  segment', 14)}${PAD('n', 7)}${PAD('p50', 8)}${PAD('p99', 8)}${PAD('worst', 9)}` +
    `${PAD('>16.7ms', 10)}${PAD('>50ms', 8)}repacks`
);
for (const [i, fs] of rows.entries()) {
  if (!fs.length) continue;
  const ms = fs.map((f) => f.ms);
  const over = fs.filter((f) => f.ms > 16.7).length;
  const bad = fs.filter((f) => f.ms > 50).length;
  const repacks = fs.filter((f) => f.repacked).length;
  console.log(
    PAD(`  ${PHASES[i]}`, 14) +
      PAD(String(fs.length), 7) +
      PAD(median(ms).toFixed(2), 8) +
      PAD(quantile(ms, 0.99).toFixed(1), 8) +
      PAD(ms.length ? Math.max(...ms).toFixed(1) : '—', 9) +
      PAD(`${((over / fs.length) * 100).toFixed(2)}%`, 10) +
      PAD(`${((bad / fs.length) * 100).toFixed(2)}%`, 8) +
      `${((repacks / fs.length) * 100).toFixed(0)}%`
  );
}

console.log(heading('every frame over 50 ms, with what changed on it'));
const bad = data.frames.filter((f) => f.ms > 50).sort((a, b) => b.ms - a.ms);
if (!bad.length) console.log('  none.');
for (const f of bad.slice(0, 30)) {
  const why = [];
  if (f.programs > 0) why.push(`compiled ${f.fresh.join('/') || f.programs}`);
  if (f.uploadMs > 1) why.push(`${f.uploadMs.toFixed(0)} ms uploading ${[...new Set(f.uploads)].join('/')}`);
  else if (f.geometries > 0) why.push(`+${f.geometries} geometries`);
  if (f.textures !== 0) why.push(`${f.textures > 0 ? '+' : ''}${f.textures} textures`);
  if (f.built > 0) why.push(`+${f.built} sectors`);
  if (f.evicted > 0) why.push(`-${f.evicted} sectors`);
  if (f.ground !== 0) why.push(`${f.ground > 0 ? '+' : ''}${f.ground} ground`);
  if (f.heap < -1e6) why.push(`GC ${(f.heap / 1e6).toFixed(0)} MB`);
  const parts = Object.entries(f.parts ?? {})
    .filter(([, v]) => v > 1)
    .sort((a, b) => b[1] - a[1])
    .map(([n, v]) => `${n} ${v.toFixed(0)}`)
    .join(' + ');
  console.log(
    `  ${PAD(f.phase, 12)}${f.ms.toFixed(1).padStart(7)} ms   ${PAD(parts || 'no phase over 1 ms', 40)}` +
      `${why.join(', ') || ''}`
  );
}

/**
 * The same phases on the typical frame and on the slow ones, per segment. A
 * phase that is merely always expensive has to be visibly distinguishable from
 * one that is occasionally catastrophic, and a single ranked list cannot do it.
 */
console.log(heading('inside frame(): typical vs the worst, per segment'));
for (const [i, fs] of rows.entries()) {
  if (!fs.length) continue;
  const names = [...new Set(fs.flatMap((f) => Object.keys(f.parts ?? {})))];
  const worst = names
    .map((n) => ({
      n,
      typical: median(fs.map((f) => f.parts?.[n] ?? 0)),
      p99: quantile(fs.map((f) => f.parts?.[n] ?? 0), 0.99),
      max: Math.max(0, ...fs.map((f) => f.parts?.[n] ?? 0)),
    }))
    .sort((a, b) => b.max - a.max)
    .filter((r) => r.max > 1)
    .slice(0, 5);
  console.log(`\n  ${PHASES[i]}`);
  for (const r of worst) {
    console.log(
      `    ${PAD(r.n, 20)}typical ${r.typical.toFixed(2).padStart(6)} ms   ` +
        `p99 ${r.p99.toFixed(1).padStart(6)} ms   worst ${r.max.toFixed(1).padStart(7)} ms`
    );
  }
}

console.log(heading("the browser's account of the long frames, by segment"));
if (!data.loafSupported) console.log('  Long Animation Frames unavailable.');
else {
  for (const p of [...PHASES, 'settling', 'idle']) {
    const es = data.loaf.filter((e) => e.phase === p);
    if (!es.length) continue;
    const byFn = new Map();
    for (const e of es) {
      for (const s of e.scripts) {
        const key = `${s.fn || s.invoker || '(anonymous)'} @ ${(s.source || '').split('/').pop()}:${s.at}`;
        const row = byFn.get(key) ?? { n: 0, total: 0, worst: 0 };
        row.n++;
        row.total += s.duration;
        row.worst = Math.max(row.worst, s.duration);
        byFn.set(key, row);
      }
    }
    const scripted = es.reduce((n, e) => n + e.scripts.reduce((m, s) => m + s.duration, 0), 0);
    const total = es.reduce((n, e) => n + e.duration, 0);
    console.log(
      `\n  ${p}: ${es.length} frames over 50 ms, ${total.toFixed(0)} ms total, ` +
        `${((scripted / Math.max(1, total)) * 100).toFixed(0)}% of it script`
    );
    for (const [k, r] of [...byFn.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 5)) {
      console.log(`    ${PAD(k, 46)}${PAD(String(r.n), 5)}${r.total.toFixed(0)} ms   worst ${r.worst.toFixed(1)} ms`);
    }
  }
}

const path = `${PERF_DIR}/look-${args.station}-${args.level}.json`;
writeJson(path, { leg: LEG, station: args.station, level: args.level, frames: data.frames.length, bad: bad.slice(0, 60), loaf: data.loaf.slice(0, 200) });
console.log(`\n${path}\n`);
