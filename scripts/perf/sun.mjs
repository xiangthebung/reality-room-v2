import { boot, argv, heading, PAD, NUM, DEV_URL, PERF_BUILD_URL, PERF_DIR, writeJson } from './harness.mjs';
import { median, quantile } from './stats.mjs';

/**
 * WHAT THE DAY COSTS, HOUR BY HOUR.
 *
 *   npm run perf:sun
 *   npm run perf:sun -- --from=0.10 --to=0.45 --seconds=45   just the sunrise
 *   npm run perf:sun -- --live                                vsync + both controllers
 *
 * THE BLIND SPOT THIS EXISTS TO CLOSE.
 *
 * `daylight.js` returns AUTHORED_PHASE under `navigator.webdriver`, and
 * `probe.js` pins the clock to the same value in `engage()` and again at the end
 * of every `walk()`. Both are right for what they are for — fifteen pixel-diffing
 * scripts and a regression gate need the sky to hold still. The consequence is
 * that NOTHING IN scripts/perf HAS EVER MEASURED A FRAME IN WHICH THE SUN MOVED.
 * `perf:spikes` walks the wood at half past nine in the morning and always will.
 *
 * That is the same shape of hole `navigator.webdriver` left in the Auto governor
 * — see the block at the top of `governor.mjs` — and it hid the same class of
 * bug: a cost that only exists while a controller nothing measures is doing its
 * job. So this script drives the phase by hand, one write per frame, and walks
 * the wood underneath it.
 *
 * WHY IT SWEEPS FASTER THAN REAL TIME, AND WHAT THAT COSTS.
 *
 * A cycle is twenty minutes. Sweeping one at 1x to find a hitch that lasts a
 * tenth of a second is twenty minutes per sample and nobody would run it twice.
 * At the default (a whole cycle in 90 s, 13x) everything that is a property of
 * the CYCLE is preserved exactly — which hour a program compiles on, whether a
 * rung moves, what the sun's step rate does as the light comes up — and one
 * thing is not: the SHADOW RE-RENDER RATE, which is 13x too high, because the
 * sun crosses SUN_STEP thirteen times as often. So the per-hour `ms` column is
 * an upper bound and the `steps/s` column is reported alongside it, divided back
 * down, precisely so the two cannot be confused. Anything looking for a hitch
 * reads the spike table; anything looking for a steady-state cost reads
 * `perf:bench`, which is what that is for.
 */

const args = argv({
  from: '0',
  to: '1',
  seconds: '90',
  station: 'deep',
  level: 'sober',
  live: 'false',
  pin: 'false',
  width: '2560',
  height: '1440',
});
const FROM = Number(args.from);
const TO = Number(args.to);
const SECONDS = Number(args.seconds);
const LIVE = args.live === 'true';

/**
 * `--live` is the "would a player feel this" arm, and it needs all three of
 * vsync, a real window and the two controllers put back — see the note on
 * uncapped runs in `spikes.mjs` and the live section of `governor.mjs`. Without
 * it this is the "what changed between two builds" arm, where a backed-up GPU
 * queue invents 90-200 ms frames of its own.
 */
const { browser, page } = await boot({
  url: args.build === 'true' ? PERF_BUILD_URL : DEV_URL,
  vsync: LIVE,
  headed: LIVE,
});
/**
 * The window size is a parameter because the two adaptive controllers read the
 * frame's wall clock, and the frame's wall clock is mostly a function of how
 * many pixels it has. `boot` hands back 1280x720, which on a card like this one
 * has so much headroom that neither controller can ever be provoked — see the
 * live section of `governor.mjs`, which sets 3840x2160 for exactly this reason.
 */
if (LIVE) {
  await page.setViewportSize({ width: Number(args.width), height: Number(args.height) });
  await page.waitForTimeout(1500);
}
if (!LIVE) {
  console.log(
    'NOTE: uncapped, governor off. Long frames here are candidates, not verdicts —\n' +
      '      re-run with --live before concluding a player would feel one.\n'
  );
}

const run = await page.evaluate(
  ([o]) =>
    new Promise((resolve) => {
      const R = window.RR;
      const Q = window.RRSettings;
      const info = R.renderer.info;
      const atmos = R.atmosphere;
      const c = R.controller;

      if (o.live) {
        Q.startAuto();
        R.pipeline.setDynamicResolution(true);
      }
      if (o.level !== 'sober') R.director.seek({ onset: 80, peak: 160, egodeath: 220 }[o.level] ?? 160);

      /**
       * WHICH PART OF `frame()` WAS SLOW — the same wrapping trick `probe.js`
       * uses, repeated here rather than reused because its list is missing the
       * two subsystems a day cycle actually drives: `ambience.update` carries
       * the whole wildlife roster, and the roster is a function of the hour.
       */
      const phaseAccum = Object.create(null);
      for (const [name, owner, method] of [
        ['controller', () => R.controller, 'update'],
        ['director', () => R.director, 'update'],
        ['atmosphere.follow', () => atmos, 'follow'],
        ['atmosphere.tick', () => atmos, 'tick'],
        ['audio.listener', () => R.audio, 'updateListener'],
        ['audio.levels', () => R.audio, 'sampleLevels'],
        ['ambience', () => R.ambience, 'update'],
        ['speakers', () => R.speakers, 'tick'],
        ['net', () => R.net, 'update'],
        ['gathering', () => R.gathering, 'update'],
        ['ferry', () => R.ferry, 'update'],
        ['seats', () => R.seats, 'update'],
        ['sitting', () => R.sitting, 'update'],
        ['fishing', () => R.fishing, 'update'],
        ['social', () => R.social, 'update'],
        ['fauna', () => R.fauna, 'update'],
        ['caves', () => R.caves, 'update'],
        ['cull', () => R.forest, 'cull'],
        ['render', () => R.pipeline, 'render'],
      ]) {
        const target = owner();
        if (!target || typeof target[method] !== 'function') continue;
        const original = target[method];
        target[method] = function timed(...a) {
          const t0 = performance.now();
          try {
            return original.apply(this, a);
          } finally {
            phaseAccum[name] = (phaseAccum[name] ?? 0) + (performance.now() - t0);
          }
        };
      }

      const seen = new Set((info.programs ?? []).map((p) => p.cacheKey));
      const frames = [];
      const loaf = [];
      let observer = null;
      try {
        observer = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            loaf.push({
              start: e.startTime,
              duration: e.duration,
              styleAndLayout: e.styleAndLayoutStart
                ? e.startTime + e.duration - e.styleAndLayoutStart
                : 0,
              scripts: (e.scripts ?? []).map((s) => ({
                fn: s.sourceFunctionName,
                src: s.sourceURL,
                at: s.sourceCharPosition,
                dur: s.duration,
                invoker: s.invoker,
              })),
            });
          }
        });
        observer.observe({ type: 'long-animation-frame', buffered: false });
      } catch {
        observer = null;
      }

      const s = o.station;
      c.position.x = s.x;
      c.position.z = s.z;
      c.yaw = s.yaw;

      const started = performance.now();
      let last = started;
      let lastSteps = atmos.sunSteps;
      let lastLevel = Q.autoLevel;
      let lastScale = R.pipeline.drs?.scale ?? 1;
      const changes = [];

      const tick = () => {
        const now = performance.now();
        const ms = now - last;
        last = now;
        const t = (now - started) / 1000;
        /**
         * `--pin` IS THE CONTROL ARM, and it is the reason this script can say
         * anything at all. A long frame that turns up during a sweep has two
         * candidate explanations — the hour it landed on, and the fact that
         * something was walking the wood for the first time — and a sweep alone
         * cannot separate them. Holding the clock at `from` and doing everything
         * else identically settles it: a spike that survives the pin is not the
         * day's, whatever o'clock it happened to occur at.
         */
        const u = o.pin ? 0 : Math.min(1, t / o.seconds);
        const phase = ((o.from + (o.to - o.from) * u) % 1 + 1) % 1;
        atmos.day.set(phase);

        /**
         * A circle for the body and a shaken yaw on top of it — the same two
         * motions `walk()` and the governor's live arm use, and both are needed:
         * the circle drives the culler's travel trigger and the shadow anchor's
         * hysteresis, the shake is the mouse-look that the report is about.
         */
        c.position.x = s.x + Math.cos(t * 0.6) * 9;
        c.position.z = s.z + Math.sin(t * 0.6) * 9;
        c.yaw = s.yaw + t * 0.35 + Math.sin(t * 13.7) * 0.075 + Math.sin(t * 5.1) * 0.037;
        /**
         * AND THE PITCH SWEEPS, which the other walks in this project do not do
         * and which this one cannot leave out. The report is about the sun
         * coming through the canopy, and a walk that holds the pitch at eye
         * level never once puts the sun disc, its halo or a shaft seen end-on
         * into the frustum — so it would be measuring a wood with the sky
         * cropped off. Slower than the yaw shake because a player looks up and
         * holds, rather than flicking.
         */
        c.pitch = -0.05 + Math.sin(t * 0.31) * 0.75;

        const fresh = [];
        for (const p of info.programs ?? []) {
          if (seen.has(p.cacheKey)) continue;
          seen.add(p.cacheKey);
          fresh.push(p.name || 'unnamed');
        }
        if (Q.autoLevel !== lastLevel) {
          changes.push({ kind: 'rung', from: lastLevel, to: Q.autoLevel, phase: +phase.toFixed(4), t: +t.toFixed(1), ms });
          lastLevel = Q.autoLevel;
        }
        const sc = R.pipeline.drs?.scale ?? 1;
        if (Math.abs(sc - lastScale) > 1e-6) {
          changes.push({ kind: 'scale', from: +lastScale.toFixed(3), to: +sc.toFixed(3), phase: +phase.toFixed(4), t: +t.toFixed(1), ms });
          lastScale = sc;
        }
        frames.push({
          ms,
          t,
          phase,
          fresh,
          steps: atmos.sunSteps - lastSteps,
          programs: info.programs?.length ?? 0,
          geometries: info.memory.geometries,
          textures: info.memory.textures,
          phases: { ...phaseAccum },
        });
        for (const k of Object.keys(phaseAccum)) delete phaseAccum[k];
        lastSteps = atmos.sunSteps;

        if (t > o.seconds) {
          observer?.disconnect();
          atmos.day.set(null);
          resolve({ frames, loaf, changes, loafSupported: !!observer, status: Q.status() });
        } else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  [
    {
      from: FROM,
      to: TO,
      seconds: SECONDS,
      live: LIVE,
      pin: args.pin === 'true',
      level: args.level,
      station: {
        deep: { x: -34, z: -46, yaw: 1.1 },
        clearing: { x: 0, z: 5, yaw: 0.0 },
        canopy: { x: -30, z: -40, yaw: 0.8 },
        ridge: { x: 96, z: -104, yaw: -2.1 },
      }[args.station],
    },
  ]
);
await browser.close();

/**
 * The first half-second is the resume transient, for the reason `walk()` gives:
 * handing the loop back is itself an event and leaving it in makes "worst frame"
 * a property of the instrument.
 */
let cut = 0;
for (let acc = 0; cut < run.frames.length && acc < 500; cut++) acc += run.frames[cut].ms;
const frames = run.frames.slice(cut);
const prologue = run.frames.slice(0, cut);
const speed = Math.abs(TO - FROM) / (SECONDS / 1200);

console.log(heading('the sweep'));
console.log(`  phase             ${FROM} -> ${TO} over ${SECONDS}s  (${speed.toFixed(1)}x real time)`);
console.log(`  frames            ${frames.length}`);
console.log(`  median            ${NUM(median(frames.map((f) => f.ms)), 7)} ms`);
console.log(`  p99 / worst       ${NUM(quantile(frames.map((f) => f.ms), 0.99), 6)} / ${NUM(Math.max(...frames.map((f) => f.ms)), 6)} ms`);
console.log(`  sun commits       ${frames.reduce((n, f) => n + f.steps, 0)}  (${(frames.reduce((n, f) => n + f.steps, 0) / SECONDS / speed).toFixed(2)}/s at 1x)`);
console.log(`  programs          ${frames[0]?.programs} -> ${frames[frames.length - 1]?.programs}`);
/**
 * The prologue is REPORTED, not silently dropped — the discipline `walk()` sets
 * out: a hitch detector that quietly cuts frames is how a hitch detector comes
 * to report no hitches.
 */
console.log(
  `  prologue          ${prologue.length} frames cut, worst ${NUM(Math.max(0, ...prologue.map((f) => f.ms)), 6)} ms`
);

/* ---- hour by hour -------------------------------------------------------- */

const BUCKETS = 12;
console.log(heading('hour by hour'));
console.log(`${PAD('  phase', 16)}${PAD('clock', 8)}${PAD('frames', 9)}${PAD('median', 10)}${PAD('p99', 10)}${PAD('worst', 10)}${PAD('shadow/s @1x', 14)}compiles`);
const hours = [];
for (let b = 0; b < BUCKETS; b++) {
  const lo = b / BUCKETS;
  const hi = (b + 1) / BUCKETS;
  const inB = frames.filter((f) => f.phase >= lo && f.phase < hi);
  if (!inB.length) continue;
  const secs = inB.reduce((n, f) => n + f.ms, 0) / 1000;
  const steps = inB.reduce((n, f) => n + f.steps, 0);
  const compiles = inB.reduce((n, f) => n + f.fresh.length, 0);
  const row = {
    lo,
    hi,
    frames: inB.length,
    median: median(inB.map((f) => f.ms)),
    p99: quantile(inB.map((f) => f.ms), 0.99),
    worst: Math.max(...inB.map((f) => f.ms)),
    shadowPerSec: steps / secs / speed,
    compiles,
  };
  hours.push(row);
  console.log(
    PAD(`  ${lo.toFixed(3)}-${hi.toFixed(3)}`, 16) +
      PAD(`${String(Math.floor(lo * 24)).padStart(2, '0')}:00`, 8) +
      PAD(String(row.frames), 9) +
      PAD(`${row.median.toFixed(2)} ms`, 10) +
      PAD(`${row.p99.toFixed(1)} ms`, 10) +
      PAD(`${row.worst.toFixed(0)} ms`, 10) +
      PAD(row.shadowPerSec.toFixed(2), 14) +
      (compiles ? `${compiles}  <-` : '')
  );
}

/* ---- the spikes ---------------------------------------------------------- */

const med = median(frames.map((f) => f.ms));
const hitches = frames.filter((f) => f.ms > Math.max(med * 4, 25)).sort((a, b) => b.ms - a.ms);
console.log(heading('every long frame, and what time it was'));
if (!hitches.length) console.log('  none.');
for (const f of hitches.slice(0, 30)) {
  /**
   * The itemised phases, on the same line as the frame. A hitch table that only
   * gives a time and a phase-of-day has named the moment and not the cause, and
   * the moment is the half everybody can already see.
   */
  const items = Object.entries(f.phases ?? {})
    .filter(([, v]) => v > 0.5)
    .sort((a, b) => b[1] - a[1])
    .map(([n, v]) => `${n} ${v.toFixed(0)}ms`);
  const accounted = Object.values(f.phases ?? {}).reduce((n, v) => n + v, 0);
  console.log(
    `  phase ${f.phase.toFixed(4)}  ${String(Math.floor(f.phase * 24)).padStart(2, '0')}:${String(Math.floor(((f.phase * 24) % 1) * 60)).padStart(2, '0')}` +
      `  t=${f.t.toFixed(1).padStart(5)}s` +
      `  ${f.ms.toFixed(1).padStart(8)} ms  (x${(f.ms / med).toFixed(0)})` +
      `${f.steps ? '  [sun commit]' : ''}` +
      `${f.fresh.length ? `  [compiled ${f.fresh.join(', ')}]` : ''}` +
      `\n      ${items.join(', ') || 'no phase over 0.5 ms'}  (unaccounted ${(f.ms - accounted).toFixed(0)} ms)`
  );
}

const compiled = {};
for (const f of frames) for (const n of f.fresh) (compiled[n] ??= []).push(f.phase);
if (Object.keys(compiled).length) {
  console.log(heading('programs compiled during the day'));
  for (const [n, at] of Object.entries(compiled)) {
    console.log(`  ${PAD(n, 30)} ${at.length}x   first at phase ${at[0].toFixed(4)}`);
  }
  console.log('\n  Every one of these is a program the pre-warm in main.js did not cover.');
}

if (run.changes.length) {
  console.log(heading('what the two adaptive controllers did'));
  for (const c of run.changes) {
    console.log(
      `  ${PAD(c.kind, 6)} phase ${c.phase.toFixed(4)}  t=${String(c.t).padStart(5)}s  ` +
        `${String(c.from).padStart(6)} -> ${String(c.to).padEnd(6)}  on a ${c.ms.toFixed(0)} ms frame`
    );
  }
}

/* ---- the browser's account ----------------------------------------------- */

if (run.loaf.length) {
  console.log(heading("the browser's own account of the long frames"));
  const byFn = new Map();
  for (const e of run.loaf) {
    for (const s of e.scripts) {
      const key = `${s.fn || s.invoker || '(anonymous)'} @ ${(s.src || '').split('/').pop()}:${s.at}`;
      const row = byFn.get(key) ?? { key, n: 0, total: 0, worst: 0 };
      row.n++;
      row.total += s.dur;
      row.worst = Math.max(row.worst, s.dur);
      byFn.set(key, row);
    }
  }
  console.log(`  ${run.loaf.length} frames over 50 ms\n`);
  console.log(`${PAD('  script', 56)}${PAD('hits', 7)}${PAD('total', 10)}worst`);
  for (const r of [...byFn.values()].sort((a, b) => b.total - a.total).slice(0, 12)) {
    console.log(PAD(`  ${r.key}`, 56) + PAD(String(r.n), 7) + PAD(`${r.total.toFixed(0)} ms`, 10) + `${r.worst.toFixed(1)} ms`);
  }
}

const path = `${PERF_DIR}/sun-${args.station}-${args.level}${LIVE ? '-live' : ''}.json`;
writeJson(path, { from: FROM, to: TO, seconds: SECONDS, live: LIVE, speed, hours, worst: hitches.slice(0, 40), compiled, changes: run.changes });
console.log(`\n${path}\n`);
