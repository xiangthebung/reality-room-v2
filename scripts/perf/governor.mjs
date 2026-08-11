import { boot, argv, heading, PAD, DEV_URL, PERF_BUILD_URL, PERF_DIR, writeJson } from './harness.mjs';
import { median, quantile } from './stats.mjs';

/**
 * WHAT A QUALITY CHANGE COSTS ON THE FRAME IT LANDS.
 *
 *   npm run perf:governor
 *   npm run perf:governor -- --width=3584 --height=2016 --swaps=6
 *
 * THE BLIND SPOT THIS EXISTS TO COVER. Both adaptive controllers in this app —
 * the AutoGovernor in core/quality.js and dynamic resolution in
 * render/pipeline.js — switch themselves off when `navigator.webdriver` is set,
 * and they are right to: every other script in scripts/ compares pixels or
 * milliseconds against expectations, and a controller moving the resolution
 * halfway through would make all of them non-reproducible.
 *
 * The consequence is that the one code path that runs ONLY on a real player's
 * machine has never been timed by anything. And it is not a small path. Moving
 * one rung can, in a single synchronous burst inside a `set`:
 *
 *   msaa            reallocate the multisampled HDR scene target
 *   renderScale     resize the renderer AND all nine pipeline targets
 *   shadowMapSize   dispose the shadow map and force a full shadow re-render
 *   instanceDensity re-thin and repack every instance bucket in the wood
 *
 * (`plantVeins` used to be on that list — a define flip on the plant materials,
 * two program builds. The filaments it switched were removed on 2026-08-11 and
 * the knob went with them.)
 *
 * A player sees that as one frame that stopped. This measures it directly:
 * settle, swap the rung, and read the interval of the frame the swap landed on.
 * `setMode` rather than the governor's own `_setAutoLevel` because they run the
 * identical `_applyGraphics`, and driving it by hand makes the event happen on
 * a frame we know the number of instead of one we have to wait for.
 */

const args = argv({ swaps: '5', width: '2560', height: '1440', hold: '1800' });
const SWAPS = Number(args.swaps);
const HOLD = Number(args.hold);

const { browser, page } = await boot({
  url: args.build === 'true' ? PERF_BUILD_URL : DEV_URL,
  vsync: true,
  headed: args.headed !== 'false',
});

/**
 * A realistic frame, not a 1280x720 one.
 *
 * The rung costs scale with the buffers being reallocated, and the harness's
 * default viewport is a quarter of the pixels a player is looking at. Measuring
 * the reallocation of a small target and reporting it as the cost of the real
 * one would understate this by exactly that factor.
 */
await page.setViewportSize({ width: Number(args.width), height: Number(args.height) });
await page.waitForTimeout(800);

const geometry = await page.evaluate(() => ({
  dpr: window.devicePixelRatio,
  canvas: [window.RR.renderer.domElement.width, window.RR.renderer.domElement.height],
  level: window.RRSettings.autoLevel,
  mode: window.RRSettings.mode,
  gpu: window.RRSettings.gpu,
}));
console.log(
  `viewport ${args.width}x${args.height}  dpr ${geometry.dpr}  ` +
    `drawing buffer ${geometry.canvas[0]}x${geometry.canvas[1]}`
);
console.log(`settings seeded to "${geometry.level}" (mode ${geometry.mode})\n`);

await page.evaluate(() => {
  const R = window.RR;
  const S = { frames: [], marks: [], started: performance.now() };
  window.__GOV = S;

  const phaseAccum = Object.create(null);
  for (const [name, owner, method] of [
    ['cull', R.forest, 'cull'],
    ['render', R.pipeline, 'render'],
    ['shadow', R.renderer.shadowMap, 'render'],
    ['controller', R.controller, 'update'],
    ['fauna', R.fauna, 'update'],
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

  /**
   * The swap is timed from INSIDE `setMode`, as well as by frame interval.
   *
   * Two numbers rather than one because they answer different questions and can
   * disagree: the synchronous part is what `set` itself blocks for, and the
   * frame interval also contains the work the swap DEFERRED to the next draw —
   * a program rebuild happens when the material is next used, not when
   * `needsUpdate` is written, and a reallocated target is not paid for until
   * something renders into it. A fix that only moves the synchronous half off
   * the frame has not fixed anything.
   */
  const settings = window.RRSettings;
  const originalSetMode = settings.setMode.bind(settings);
  S.swap = (mode) => {
    const t0 = performance.now();
    originalSetMode(mode);
    const sync = performance.now() - t0;
    S.marks.push({ mode, at: performance.now(), sync, frame: S.frames.length });
    return sync;
  };

  const info = R.renderer.info;
  let last = performance.now();
  /**
   * NEW CACHE KEYS, NOT THE LENGTH OF THE TABLE — and the difference is the
   * whole finding.
   *
   * Flipping a define on every material in the scene releases the old program
   * as it acquires the new one, so `info.programs.length` comes back to almost
   * exactly where it started. Read as a delta it reports ZERO programs built
   * for a swap that in fact rebuilt the entire wood, which is how a
   * second-and-a-half stall can sit in plain sight looking like nothing
   * happened.
   */
  const seen = new Set((info.programs ?? []).map((p) => p.cacheKey));
  const tick = () => {
    const now = performance.now();
    let built = 0;
    for (const p of info.programs ?? []) {
      if (seen.has(p.cacheKey)) continue;
      seen.add(p.cacheKey);
      built++;
    }
    S.frames.push({
      ms: now - last,
      at: now,
      parts: { ...phaseAccum },
      programs: built,
    });
    for (const k of Object.keys(phaseAccum)) delete phaseAccum[k];
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const swap = async (mode) => {
  const sync = await page.evaluate((m) => window.__GOV.swap(m), mode);
  await page.waitForTimeout(HOLD);
  return sync;
};

/**
 * Every ADJACENT pair on the ladder, in both directions, because they are not
 * the same change. ultra -> high moves two knobs; high -> medium moves six,
 * including the two that rebuild shader programs.
 */
const LADDER = ['low', 'medium', 'high', 'ultra'];
console.log(`swapping rungs ${SWAPS}x, holding ${HOLD} ms either side`);
await page.evaluate(() => window.RRSettings.setMode('ultra'));
await page.waitForTimeout(2500);

for (let i = 0; i < SWAPS; i++) {
  for (let r = LADDER.length - 1; r > 0; r--) {
    await swap(LADDER[r - 1]);
    await swap(LADDER[r]);
  }
  process.stdout.write(`  round ${i + 1}/${SWAPS}\n`);
}

const data = await page.evaluate(() => ({ frames: window.__GOV.frames, marks: window.__GOV.marks }));
await browser.close();

/**
 * The frame a swap landed on, plus the two after it. The deferred half of the
 * cost — a program rebuilt on next use, a shadow map re-rendered — does not
 * necessarily land on the same frame as the call, and a window of one would
 * report a cheap swap that stalls the frame after it as free.
 */
const WINDOW = 3;
const events = [];
for (const m of data.marks) {
  const window3 = data.frames.slice(m.frame, m.frame + WINDOW);
  if (!window3.length) continue;
  const worst = window3.reduce((a, b) => (b.ms > a.ms ? b : a));
  events.push({
    mode: m.mode,
    sync: m.sync,
    worst: worst.ms,
    total: window3.reduce((n, f) => n + f.ms, 0),
    programs: window3.reduce((n, f) => n + f.programs, 0),
    parts: worst.parts,
  });
}

const baseline = median(data.frames.map((f) => f.ms));
console.log(heading('what one rung change costs'));
console.log(`  typical frame in this session: ${baseline.toFixed(1)} ms\n`);
console.log(
  `${PAD('  to', 10)}${PAD('n', 5)}${PAD('sync in set()', 16)}${PAD('worst frame', 14)}` +
    `${PAD('3-frame total', 15)}programs built`
);
for (const mode of LADDER) {
  const es = events.filter((e) => e.mode === mode);
  if (!es.length) continue;
  console.log(
    PAD(`  ${mode}`, 10) +
      PAD(String(es.length), 5) +
      PAD(`${median(es.map((e) => e.sync)).toFixed(1)} ms`, 16) +
      PAD(`${median(es.map((e) => e.worst)).toFixed(1)} ms  (max ${Math.max(...es.map((e) => e.worst)).toFixed(0)})`, 14) +
      PAD(`${median(es.map((e) => e.total)).toFixed(1)} ms`, 15) +
      `${median(es.map((e) => e.programs)).toFixed(0)}`
  );
}

console.log(heading('the worst swap of each kind, itemised'));
for (const mode of LADDER) {
  const es = events.filter((e) => e.mode === mode);
  if (!es.length) continue;
  const worst = es.reduce((a, b) => (b.worst > a.worst ? b : a));
  const parts = Object.entries(worst.parts ?? {})
    .filter(([, v]) => v > 0.5)
    .sort((a, b) => b[1] - a[1])
    .map(([n, v]) => `${n} ${v.toFixed(0)} ms`)
    .join(', ');
  console.log(`  -> ${PAD(mode, 8)}${worst.worst.toFixed(1).padStart(8)} ms   ${parts || 'no phase over 0.5 ms'}`);
}

/**
 * How a change reads against the frames around it, which is the number that
 * decides whether a player feels it. A 60 ms event on a 16.7 ms display is four
 * dropped frames and is visible; the same event on a session that is already
 * missing slots is not what anybody would notice first.
 */
const all = events.map((e) => e.worst);
console.log(
  `\n  a rung change is ${(median(all) / baseline).toFixed(1)}x a normal frame ` +
    `(worst ${(Math.max(...all) / baseline).toFixed(1)}x)`
);
console.log(
  `  p95 of every swap: ${quantile(all, 0.95).toFixed(1)} ms   worst: ${Math.max(...all).toFixed(1)} ms`
);

/* ---- would a player's mouse actually trigger one? ------------------------ */

/**
 * The cost above only matters as often as the change happens, and the governor
 * decides that from a statistic this machine's 60 Hz vsync hides completely: at
 * 16.6 ms per frame with a 4 ms frame to render, nothing is ever late and the
 * rung never moves. That is a fact about this display, not about the game.
 *
 * So the honest way to ask "would this fire for a player" is to measure the GPU
 * cost of the frame — which is display-independent — and then run the
 * governor's own arithmetic against the display periods players actually have.
 * `late` is the fraction of frames over 1.5x the period, and the governor drops
 * a rung when that exceeds 6% for 2.5 s.
 */
console.log(heading('would mouse-look trigger a rung change at all?'));

const { browser: b2, page: p2 } = await boot({ url: DEV_URL, quiet: true, vsync: true });
await p2.setViewportSize({ width: Number(args.width), height: Number(args.height) });
await p2.waitForTimeout(800);
if (args.level !== 'sober') {
  await p2.evaluate(() => window.RR.director.seek(160));
  await p2.waitForTimeout(3000);
}

const gpu = await p2.evaluate(
  ([level]) =>
    new Promise((resolve) => {
      const R = window.RR;
      /**
       * The GPU clock ON with the controller's hands tied — `measure` without
       * `enabled`, which is exactly the control arm pipeline.js documents. The
       * scale must stay pinned at 1 or the samples describe a moving workload.
       */
      R.pipeline.setDynamicResolution(false, { measure: true });
      R.pipeline.pinScale(1);
      if (level !== 'sober') R.director.seek(160);

      const c = R.controller;
      const out = { still: [], flick: [] };
      const started = performance.now();
      let phase = 'still';
      const tick = () => {
        const now = performance.now();
        const t = (now - started) / 1000;
        if (t > 8) phase = 'flick';
        if (phase === 'flick') c.yaw += Math.sin(t * 13.7) * 0.075 + Math.sin(t * 5.1) * 0.037;
        const ms = R.pipeline.drsReport().gpuMs;
        if (ms > 0 && t > 2) out[phase].push(ms);
        if (t > 20) resolve(out);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  [args.level]
);
await b2.close();

const DISPLAYS = [60, 120, 144, 165, 240];
console.log(`  GPU cost of the frame at ${args.width}x${args.height}, ${args.level}:\n`);
console.log(`${PAD('  motion', 12)}${PAD('p50', 10)}${PAD('p95', 10)}p99`);
for (const [name, xs] of Object.entries(gpu)) {
  if (!xs.length) continue;
  console.log(
    PAD(`  ${name}`, 12) +
      PAD(`${median(xs).toFixed(2)} ms`, 10) +
      PAD(`${quantile(xs, 0.95).toFixed(2)} ms`, 10) +
      `${quantile(xs, 0.99).toFixed(2)} ms`
  );
}
/**
 * THE BUDGET, NOT THE PERIOD — and the difference is the fix being tested.
 *
 * The controllers used to take the display's own period as the budget, which on
 * a 240 Hz panel is 4.2 ms and is what made this game put a 9070 XT on the Low
 * preset. They now floor it at MAX_USEFUL_FPS, so this table has to apply the
 * same floor or it is projecting the behaviour of the build before the fix and
 * reporting it as the behaviour of this one.
 */
const MAX_USEFUL_FPS = 120;
console.log(`\n  the governor drops a rung when over 6% of a 4 s window is late (>1.5x budget),`);
console.log(`  and the budget is the SLOWER of the display period and 1/${MAX_USEFUL_FPS} s:\n`);
console.log(`${PAD('  display', 12)}${PAD('budget', 10)}${PAD('late while still', 19)}late while flicking`);
for (const hz of DISPLAYS) {
  const period = Math.max(1000 / hz, 1000 / MAX_USEFUL_FPS);
  const lateOf = (xs) => (xs.length ? xs.filter((m) => m > period * 1.5).length / xs.length : 0);
  const s = lateOf(gpu.still);
  const f = lateOf(gpu.flick);
  const verdict = f > 0.06 ? '  <- DROPS' : f > 0.02 ? '  <- holds, will not climb' : '';
  console.log(
    PAD(`  ${hz} Hz`, 12) +
      PAD(`${period.toFixed(1)} ms`, 10) +
      PAD(`${(s * 100).toFixed(1)}%`, 19) +
      `${(f * 100).toFixed(1)}%${verdict}`
  );
}
console.log(
  '\n  GPU time is not the whole frame — this is a lower bound on lateness, and\n' +
    '  the governor reads wall clock, which also carries the CPU side.'
);

/* ---- both controllers live, which is a state no probe has ever been in --- */

/**
 * THE CLOSEST THING TO A PLAYER THIS RIG CAN GET.
 *
 * `quality.startAuto()` and `setDynamicResolution(true)` put back exactly what
 * `navigator.webdriver` switches off, and the window is opened at a size a
 * person might actually play at. Then the camera is turned, because turning is
 * what the report is about: it raises the frame cost — more geometry enters the
 * frustum, the culler repacks — and on a machine whose frame already sits near
 * the display period, that is the push that makes frames miss vsync, which is
 * the only signal the governor acts on.
 *
 * If a rung moves here, the loop is closed: mouse-look -> late frames ->
 * rung change -> the stall measured at the top of this file.
 */
if (args.live === 'true') {
  console.log(heading('both controllers live, under mouse-look'));
  const { browser: b3, page: p3 } = await boot({
    url: DEV_URL,
    quiet: true,
    vsync: true,
    headed: args.headed !== 'false',
  });
  await p3.setViewportSize({ width: Number(args.liveWidth ?? 3840), height: Number(args.liveHeight ?? 2160) });
  await p3.waitForTimeout(1200);

  const live = await p3.evaluate(
    ([seconds, level]) =>
      new Promise((resolve) => {
        const R = window.RR;
        const Q = window.RRSettings;
        Q.startAuto();
        R.pipeline.setDynamicResolution(true);
        if (level !== 'sober') R.director.seek(160);

        const changes = [];
        const frames = [];
        let lastLevel = Q.autoLevel;
        let lastScale = R.pipeline.drs.scale;
        const c = R.controller;
        const started = performance.now();
        let last = started;
        const tick = () => {
          const now = performance.now();
          const ms = now - last;
          last = now;
          const t = (now - started) / 1000;
          frames.push(ms);
          // Eight seconds still, then turn for the rest.
          if (t > 8) c.yaw += Math.sin(t * 13.7) * 0.075 + Math.sin(t * 5.1) * 0.037;
          if (Q.autoLevel !== lastLevel) {
            changes.push({ kind: 'rung', from: lastLevel, to: Q.autoLevel, t: +t.toFixed(1), ms });
            lastLevel = Q.autoLevel;
          }
          const s = R.pipeline.drs.scale;
          if (Math.abs(s - lastScale) > 1e-6) {
            changes.push({ kind: 'scale', from: +lastScale.toFixed(3), to: +s.toFixed(3), t: +t.toFixed(1), ms });
            lastScale = s;
          }
          if (t > seconds) {
            resolve({
              changes,
              frames,
              status: Q.status(),
              drs: R.pipeline.drsReport(),
            });
          } else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    [Number(args.liveSeconds ?? 70), args.level]
  );
  await b3.close();

  const rungs = live.changes.filter((c) => c.kind === 'rung');
  const scales = live.changes.filter((c) => c.kind === 'scale');
  console.log(
    `  ${live.frames.length} frames, median ${median(live.frames).toFixed(1)} ms, ` +
      `${live.frames.filter((m) => m > 50).length} over 50 ms`
  );
  console.log(
    `  governor: ${live.status.mode} / ${live.status.autoLevel}, ` +
      `${(live.status.late * 100).toFixed(1)}% late, p95 ${(live.status.p95 * 1000).toFixed(1)} ms`
  );
  console.log(`  dynamic resolution settled at scale ${live.drs.scale.toFixed(2)} (${live.drs.changes} moves)\n`);
  console.log(`  ${rungs.length} rung changes, ${scales.length} resolution moves`);
  for (const c of rungs) {
    console.log(`    ${String(c.t).padStart(6)}s  ${c.from} -> ${c.to}   on a ${c.ms.toFixed(1)} ms frame`);
  }
  if (!rungs.length) {
    console.log('    the rung never moved at this size on this machine — the swap cost above');
    console.log('    is latent here, not firing. It is a property of the display and window.');
  }
  writeJson(`${PERF_DIR}/governor-live.json`, live);
}

const path = `${PERF_DIR}/governor.json`;
writeJson(path, { geometry, baseline, events, gpu });
console.log(`\n${path}`);

/* ---- the gate ------------------------------------------------------------ */

/**
 * WHAT THIS REFUSES TO LET BACK IN.
 *
 * Two properties, both of which were false when this file was written and both
 * of which are cheap to break again by accident:
 *
 *   NO RUNG CHANGE MAY COMPILE A SHADER. The pre-warm in main.js covers the
 *   whole ladder; add a knob that flips a define, or a material that the warm
 *   passes cannot traverse to, and it stops covering it. The symptom is a
 *   once-per-session stall of over a second at the moment the machine is
 *   already struggling, and nothing else in the suite can see it — the steady
 *   state is identical either way.
 *
 *   NO RUNG CHANGE MAY COST MORE THAN A HANDFUL OF FRAMES. Reallocating the
 *   targets and re-rendering the shadow map is real work and is allowed to drop
 *   a frame; it is not allowed to stop the game. The threshold is absolute
 *   rather than a ratio to the local frame, because what a player notices is
 *   milliseconds and because on a 240 Hz display a ratio would flag an
 *   imperceptible 12 ms as a 3x regression.
 */
const BUDGET_MS = 40;
const failures = [];
for (const e of events) {
  if (e.programs > 0) {
    failures.push(
      `-> ${e.mode} compiled ${e.programs} programs. The pre-warm in main.js no longer covers ` +
        `this rung; see the variant warm-up block there.`
    );
  }
  if (e.worst > BUDGET_MS) {
    failures.push(`-> ${e.mode} stopped the game for ${e.worst.toFixed(0)} ms (budget ${BUDGET_MS} ms).`);
  }
}
if (failures.length) {
  console.log(`\n${'!'.repeat(60)}`);
  for (const f of [...new Set(failures)]) console.log(`  ${f}`);
  console.log(`${'!'.repeat(60)}\n`);
  process.exitCode = 1;
} else {
  console.log(
    `\nOK — ${events.length} rung changes, worst ${Math.max(...events.map((e) => e.worst)).toFixed(0)} ms, ` +
      `no shader compiled.\n`
  );
}
