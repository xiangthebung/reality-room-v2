import { boot, argv, DEV_URL, PERF_DIR, readJson, writeJson, rule } from './harness.mjs';

/**
 * AN ABSOLUTE MILLISECOND CEILING ON THE ARMED FRAME — the one number
 * `perf:bench` structurally cannot see.
 *
 *   node scripts/perf/ceiling.mjs
 *   node scripts/perf/ceiling.mjs --record
 *   node scripts/perf/ceiling.mjs --levels=high --stations=canopy
 *
 * WHY IT EXISTS. `bench.mjs` gates on RATIOS — every scenario divided by the
 * run's own reference level — and its README states the blind spot itself:
 * "a change that makes everything slower by the same factor moves no ratio and
 * trips nothing." That is not a hypothetical. It is the exact failure mode of a
 * day on which several people add magic in parallel to one tree: twelve
 * individually reasonable additions of 0.2 ms each move no ratio, pass every
 * gate, and halve the frame rate. The ratio table is still the right instrument
 * for attribution — it is stable across GPUs, temperature and driver mood in a
 * way absolute milliseconds are not — and this is the coarse backstop beside it.
 *
 * THE METRIC IS THE ARMED FRAME, for the reason `ultracut.mjs` gives at length:
 * a 240 Hz display drops a frame if any SINGLE frame misses 4.166 ms, and the
 * frame in which the sun's anchor steps pays scene + post + shadow. `cached` is
 * what a player standing still pays and is carried beside it to show where a
 * cost landed, not as the requirement.
 *
 * IT REFUSES TO GATE ACROSS MACHINES. An absolute number recorded on one GPU
 * means nothing on another, and a gate that quietly compares across them is
 * worse than no gate — it produces confident red on a laptop and confident
 * green on a workstation. If the GPU string does not match the recorded one,
 * this prints the table and exits 0 with a loud note. Only the machine that
 * recorded the ceiling is allowed to enforce it.
 *
 * THE SLACK IS DELIBERATE AND GENEROUS. This is not a regression detector —
 * `bench.mjs` is, at ±8%. This is a CEILING: it should be silent through an
 * entire release and speak once, when the frame has actually left the budget the
 * project promised. So the recorded ceiling is the measured armed frame plus a
 * fixed headroom, and the headroom is stated in the file it is written to.
 *
 * A-B-B-A IS NOT USED HERE and that is a considered difference from
 * `shadowcost.mjs` and `ultracut.mjs`. Those measure a DIFFERENCE between two
 * arms minutes apart, where the GPU's clock drift is the same size as the
 * signal. This measures one absolute number against a fixed budget, where a
 * 0.3 ms drift across a run is small against a headroom of 1.0 ms and would
 * only ever make the gate more forgiving. What it does instead is take the
 * MEDIAN of several batches, because a single batch can catch a compositor
 * hiccup and there is nothing to difference it against.
 */

const args = argv({
  url: DEV_URL,
  levels: 'high,ultra',
  stations: 'clearing,deep,canopy',
  batch: '20',
  reps: '3',
  record: 'false',
});

const LEVELS = args.levels.split(',').filter(Boolean);
const STATIONS = args.stations.split(',').filter(Boolean);
const BATCH = Number(args.batch);
const REPS = Number(args.reps);
const RECORD = args.record === 'true';
const FILE = `${PERF_DIR}/ceiling.json`;

/**
 * The promise, per rung, in milliseconds of ARMED frame.
 *
 * These are the project's stated contract and not a measurement: High is
 * promised 240 fps and Ultra is promised 120. They are written down here so
 * that a recorded ceiling can be checked against the promise as well as against
 * the last recording — a ceiling recorded on a build that was already over
 * budget would otherwise bless it for ever.
 */
const PROMISE = { potato: 4.166, low: 4.166, medium: 4.166, high: 4.166, ultra: 8.333 };

/** How much room a recorded ceiling gets over the frame that was measured. */
const HEADROOM = 1.0;

const { browser, page, caps } = await boot({ url: args.url });
if (caps.hidden) {
  console.log('WARNING: the page reports itself hidden. A hidden pane does not composite and\n' +
    'every number below is meaningless. Show the window and run again.\n');
}

/**
 * The rig, lifted from `ultracut.mjs` so the two instruments are comparable.
 * 2560x1440 at the preset's own render scale, MSAA as the preset chooses,
 * dynamic resolution off and the scale pinned, shadow map manual.
 */
await page.evaluate(async () => {
  const R = window.RR;
  const P = window.__RR_PERF__;
  const { renderer, camera, pipeline, atmosphere, controller, forest } = R;
  const W = 2560, H = 1440;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
  P.engage();

  const frame = (armed) => {
    atmosphere.follow(camera, controller.position);
    forest.cull(camera);
    if (armed) renderer.shadowMap.needsUpdate = true;
    pipeline.render(1 / 60);
  };

  window.__CEIL__ = {
    /**
     * Applying a preset invalidates around twenty-two programs, and paying for
     * that inside a timed block is the difference between a 3 ms frame and a
     * 170 ms one. Ninety frames of warm-up with a yield every fifteen is the
     * shape `ultracut` uses and it is enough.
     */
    async level(name) {
      const Q = window.RRSettings;
      Q.setMode(name);
      const scale = Q.get('renderScale');
      renderer.setPixelRatio(scale);
      renderer.setSize(W, H, false);
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
      pipeline.setSize(W, H, scale);
      pipeline.setDynamicResolution(false, { measure: false });
      pipeline.pinScale(1);
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = true;
      R.fauna?.setPixelRatio?.(scale);
      R.caves?.setPixelRatio?.(scale);
      R.gathering?.setPixelRatio?.(scale);
      if (atmosphere.motes?.material?.uniforms?.uPixelRatio) {
        atmosphere.motes.material.uniforms.uPixelRatio.value = scale;
      }
      for (let i = 0; i < 90; i++) { frame(false); if (i % 15 === 14) await nextFrame(); }
      renderer.getContext().finish();
      return String(scale);
    },
    /**
     * `level: 'sober'` is the TRIP level, not the quality preset. `probe.js`
     * throws `unknown level: ultra` if you hand it the preset name, which is
     * how this line was first written.
     */
    async arrive(station) {
      await P.scenario({ station, level: 'sober' }, { reps: 0, batch: 8 });
      for (let i = 0; i < 30; i++) frame(false);
      renderer.getContext().finish();
    },
    /**
     * Armed and cached back to back inside ONE evaluate, polled only afterwards
     * — the shape `ultracut.mjs`'s header argues for. Two `batchMs` calls with a
     * page round trip and a 50 ms poll between them measure the drift as much as
     * the pass.
     */
    async pairMs(n) {
      const c = renderer.getContext();
      const ext = c.getExtension('EXT_disjoint_timer_query_webgl2');
      if (!ext) return { armed: NaN, cached: NaN };
      c.getParameter(ext.GPU_DISJOINT_EXT);
      for (let i = 0; i < 8; i++) frame(true);
      const qa = c.createQuery();
      c.beginQuery(ext.TIME_ELAPSED_EXT, qa);
      for (let i = 0; i < n; i++) frame(true);
      c.endQuery(ext.TIME_ELAPSED_EXT);
      const qc = c.createQuery();
      c.beginQuery(ext.TIME_ELAPSED_EXT, qc);
      for (let i = 0; i < n; i++) frame(false);
      c.endQuery(ext.TIME_ELAPSED_EXT);
      c.flush();
      for (let t = 0; t < 60; t++) {
        await sleep(40);
        if (c.getQueryParameter(qc, c.QUERY_RESULT_AVAILABLE)) break;
      }
      const ok = c.getQueryParameter(qa, c.QUERY_RESULT_AVAILABLE)
        && c.getQueryParameter(qc, c.QUERY_RESULT_AVAILABLE);
      const disjoint = c.getParameter(ext.GPU_DISJOINT_EXT);
      const av = ok ? c.getQueryParameter(qa, c.QUERY_RESULT) : 0;
      const cv = ok ? c.getQueryParameter(qc, c.QUERY_RESULT) : 0;
      c.deleteQuery(qa); c.deleteQuery(qc);
      if (!ok || disjoint) return { armed: NaN, cached: NaN };
      return { armed: av / 1e6 / n, cached: cv / 1e6 / n };
    },
    counters() {
      const info = renderer.info;
      info.autoReset = false; info.reset();
      frame(true);
      const c = { calls: info.render.calls, triangles: info.render.triangles };
      info.autoReset = true;
      return c;
    },
  };
});

const median = (xs) => {
  const v = xs.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};

const rows = [];
for (const level of LEVELS) {
  await page.evaluate((l) => window.__CEIL__.level(l), level);
  for (const station of STATIONS) {
    await page.evaluate((s) => window.__CEIL__.arrive(s), station);
    const samples = [];
    for (let r = 0; r < REPS; r++) samples.push(await page.evaluate((n) => window.__CEIL__.pairMs(n), BATCH));
    const c = await page.evaluate(() => window.__CEIL__.counters());
    rows.push({
      key: `${level}.${station}`,
      level,
      station,
      armed: median(samples.map((s) => s.armed)),
      cached: median(samples.map((s) => s.cached)),
      calls: c.calls,
      triangles: c.triangles,
    });
  }
}

await browser.close();

console.log(`\nabsolute ceiling — ARMED frame, 2560x1440, ${BATCH}-frame batches, median of ${REPS}`);
console.log(rule());
console.log(`  GPU  ${caps.gpu}`);
console.log(`  seed ${caps.seed}\n`);

const stored = readJson(FILE, null);

if (RECORD) {
  const record = {
    recordedAt: new Date().toISOString(),
    gpu: caps.gpu,
    seed: caps.seed,
    url: args.url,
    headroom: HEADROOM,
    note:
      'The ARMED frame (scene + post + shadow) in ms, plus HEADROOM. This is a ' +
      'coarse absolute backstop for the thing bench.mjs cannot see — a uniform ' +
      'slowdown that moves no ratio. Only the recorded GPU may enforce it.',
    ceilings: Object.fromEntries(rows.map((r) => [r.key, +(r.armed + HEADROOM).toFixed(3)])),
    measured: Object.fromEntries(rows.map((r) => [r.key, +r.armed.toFixed(3)])),
  };
  writeJson(FILE, record);
  console.log(`  station          armed   cached   ceiling  promise`);
  for (const r of rows) {
    console.log(
      `  ${r.key.padEnd(16)} ${r.armed.toFixed(2).padStart(5)}   ${r.cached.toFixed(2).padStart(6)}` +
        `   ${(r.armed + HEADROOM).toFixed(2).padStart(7)}  ${String(PROMISE[r.level] ?? '—').padStart(7)}`
    );
  }
  const over = rows.filter((r) => PROMISE[r.level] && r.armed > PROMISE[r.level]);
  console.log(`\nrecorded ${rows.length} ceilings to ${FILE} at +${HEADROOM.toFixed(1)} ms of headroom`);
  if (over.length) {
    console.log(
      `\nNOTE: ${over.length} of these are ALREADY over the promise for their rung ` +
        `(${over.map((r) => r.key).join(', ')}). The ceiling has been recorded anyway — it is a\n` +
        `backstop against getting worse, not a claim that the current frame is inside budget — but\n` +
        `the promise, not the recording, is the number that matters to a player.`
    );
  }
  process.exit(0);
}

if (!stored) {
  console.log('No ceiling recorded yet. Run with --record on the reference machine.');
  process.exit(0);
}

console.log(`  station          armed   cached   ceiling   over by`);
const failures = [];
for (const r of rows) {
  const ceil = stored.ceilings?.[r.key];
  const over = ceil == null ? null : r.armed - ceil;
  console.log(
    `  ${r.key.padEnd(16)} ${r.armed.toFixed(2).padStart(5)}   ${r.cached.toFixed(2).padStart(6)}` +
      `   ${(ceil == null ? '—' : ceil.toFixed(2)).padStart(7)}   ${over == null ? '—' : (over > 0 ? '+' + over.toFixed(2) : '')}`
  );
  if (over != null && over > 0) failures.push({ ...r, ceil, over });
}

if (stored.gpu !== caps.gpu) {
  console.log(
    `\nNOT ENFORCED. The ceiling was recorded on "${stored.gpu}" and this is "${caps.gpu}".\n` +
      'An absolute millisecond recorded on one GPU means nothing on another, so this run is a\n' +
      'report and not a gate. Record a ceiling on this machine if you want it enforced here.'
  );
  process.exit(0);
}

if (failures.length) {
  console.log(`\n${failures.length} station(s) over the absolute ceiling:`);
  for (const f of failures) {
    console.log(`  ${f.key}: ${f.armed.toFixed(2)} ms against a ceiling of ${f.ceil.toFixed(2)} (+${f.over.toFixed(2)})`);
  }
  console.log(
    '\nThis gate has ' + stored.headroom.toFixed(1) + ' ms of slack in it, so it does not fire on drift.\n' +
      'Something in the frame got materially more expensive. `npm run perf:why` attributes it.'
  );
  process.exit(1);
}

console.log('\nevery station inside its absolute ceiling.');
process.exit(0);
