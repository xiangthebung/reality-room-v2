import { boot, argv, DEV_URL } from './harness.mjs';

/**
 * WHAT A CAVE ARRIVING COSTS THE FRAME IT ARRIVES ON.
 *
 * This pins one thing: no single frame of a cave being built may cost more than
 * BUDGET milliseconds. It exists because the whole build was sliced for exactly
 * that reason and then stopped being — twice, in two different places, and
 * neither showed up in any existing instrument.
 *
 *   `prepare()` was never sliced at all. It planned the passage in one go, and
 *   when the passages went from ~300 m to ~650 m it went with them: measured
 *   warm on nine grove-01 caves, a median of 34 ms and a worst of 78 in a SINGLE
 *   frame, on a budget of 3.5-5 ms in the open wood. Four dropped frames at
 *   60 Hz, arriving 320 m from a mouth while somebody walks toward it.
 *
 *   `step()` WAS sliced, at 22 rings a frame, and its last slice was not: the
 *   frame that ran `_link` and `_finish` cost 10-13 ms against 1.0-1.2 ms for
 *   every other slice in the same build. A slicing scheme only bounds the work
 *   it covers, and nothing had ever measured the tail of this one.
 *
 * WHY NEITHER WAS EVER CAUGHT. `perf:spikes` walks the wood and would see this
 * if it happened to cross a build, but a cave is armed at 320 m and its build is
 * over in a couple of seconds — so whether the run contains the hitch at all is
 * a coin toss, and a coin toss is not a gate. `cave-perf` measures the frame
 * INSIDE a finished passage, which is the steady state and by construction has
 * no build in it. `cave-walk` walks into a cave that has already been built. The
 * one moment that costs anything had no instrument pointed at it.
 *
 *
 * TWO MEASUREMENTS, AND THE FIRST IS THE GATE.
 *
 *   THE BUILD, SLICED. Every cave in a fixed set is built off to the side of the
 *   live field, driven exactly as `CaveField.update` drives one — `prepareSlice`
 *   then `step`, both with the shipping deadline, one call per simulated frame —
 *   and every slice is timed. This is deterministic: the same seed gives the
 *   same caves, the same number of slices and the same work in each, so the only
 *   thing that moves run to run is the millisecond column. It is the gate
 *   because it is the only version of the question with no streamer, no
 *   renderer and no scheduler in it.
 *
 *   IN THE FRAME. Then the same thing through the real loop: stand a player
 *   inside BUILD_RANGE of a mouth, walk them at it, and time `caves.update` on
 *   every frame. It is noisier and it is the one that answers "would a player
 *   feel this", so it is reported and checked against a looser bar.
 *
 * WHY `caves.update` AND NOT THE FRAME INTERVAL. Because a frame interval taken
 * with vsync off is not a frame a player would ever see — this project has a
 * documented history of instruments that manufactured 90-200 ms frames inside
 * `render()` by handing the driver frames faster than it could retire them, and
 * concluded there was a hitch. The build is pure CPU in a named phase. Timing
 * that phase asks exactly the question and cannot be answered by the scheduler.
 *
 * WORST AND p99, NEVER THE MEAN. A build is four hundred cheap slices and the
 * whole subject is whether any one of them is not. A mean over that is a number
 * that cannot move no matter how bad the tail gets.
 *
 *   node scripts/perf/cave-build.mjs [--caves=9] [--budget=1.2] [--frames=900]
 */

const args = argv({ caves: '9', reps: '3', budget: '1.8', walk: '2.5', frames: '900' });
const CAVES = Number(args.caves);
/**
 * HOW MANY TIMES EACH CAVE IS BUILT, AND WHY THE ANSWER IS THE BEST OF THEM.
 *
 * Everything deterministic about this run — which caves, how many rings, how
 * many slices, which stage each slice ended in — is identical every time. The
 * millisecond column is not, and on a machine with anything else running it is
 * not by several milliseconds: a major GC, another browser, or a second agent's
 * Playwright run lands a 3 ms stall inside whichever slice happens to be in
 * flight. Measured here across four runs of the same build, the worst slice
 * moved between `rings`, `extras`, `bounds` and `terminus` and was 1.7 ms in the
 * quiet run and 4.2 in the loudest — four well-sliced stages all reporting the
 * same tail is the signature of the machine and not of any of them.
 *
 * A stall can only ever ADD time, so the minimum over repeats is the honest
 * estimate of what the code costs, and it is the statistic the gate uses. The
 * raw worst is still printed, and the by-stage line beside it is what tells the
 * two apart: a real unsliced quantum is the SAME stage at the top on every run.
 */
const REPS = Number(args.reps);
/** ms. BUILD_MS is 0.6 and a slice overruns by the quantum it was in. */
const BUDGET = Number(args.budget);
/** ms, for the in-frame number, which carries the rescan and the sort as well. */
const WALK_BUDGET = Number(args.walk);
const FRAMES = Number(args.frames);

/**
 * `vsync: true`, WHICH IS UNUSUAL IN THIS DIRECTORY AND IS THE POINT.
 *
 * Every other script here runs uncapped, because they compare one build against
 * another and headroom is only visible with the frame limiter off. This one asks
 * "would a player feel it", which is a different question with a different right
 * answer — and uncapped is not merely unhelpful for it, it silently changes what
 * is measured. Uncapped, this machine ran the walk at 280 Hz: 900 frames covered
 * 3.2 seconds and the body walked 24 metres, because dt is what the loop is
 * actually given. Capped, the same 900 frames are fifteen seconds and a hundred
 * and twenty metres of approach, which is a walk toward a cave mouth.
 *
 * Headless, deliberately, and the harness's own note says why that matters
 * whenever `vsync` does: headless Chromium paces rAF from a SIMULATED 60 Hz
 * clock whatever the real monitor does. For any other script that is a lie about
 * this machine's budget. Here it is exactly the machine being asked about — a
 * player on a 60 Hz display, the case where a 4 ms build slice is worth a fifth
 * of the frame and a 38 ms one is worth two whole frames.
 */
const { browser, page } = await boot({ url: DEV_URL, vsync: true });

/* ---- the build, sliced --------------------------------------------------- */

const build = await page.evaluate(async ([n, reps]) => {
  const R = window.RR;
  const terrain = await import('/src/world/terrain.js');
  /**
   * A fixed set in k order rather than "whatever is near the player", so the
   * same nine passages are measured every run. They are the ones grove-01 puts
   * along the first ridge; k is dense and signed, so slicing the sorted list
   * takes a contiguous run of real caves rather than a scatter.
   */
  const near = terrain
    .cavesNear(0, 0, 4000)
    .sort((a, b) => a.k - b.k)
    .slice(0, Number(n));
  if (!near.length) return { error: 'no cave descriptors near the origin' };
  /**
   * `Cave` is not exported and should not be — nothing outside this module has
   * any business making one. Borrowing the constructor off an instance the field
   * made is how this measures the real class rather than a copy of it that could
   * drift.
   */
  R.caves._rescan(near[0].x, near[0].z);
  const any = [...R.caves.caves.values()][0];
  if (!any) return { error: 'a rescan at a mouth produced no cave' };
  const Ctor = any.constructor;

  /**
   * WARM FIRST, AND THROW THE WARM PASS AWAY.
   *
   * The first cave built in a session pays for compiling every path through the
   * walk, the burial and eight placers, and it is 20-40% dearer than the second
   * for reasons that have nothing to do with the geometry. Reporting it would
   * make the first row of the table the worst row every time, which is a fact
   * about V8 and not about caves.
   */
  for (const d of near) new Ctor(d).prepare();

  const rows = [];
  for (const d of near) {
    const reps_ = [];
    for (let rep = 0; rep < reps; rep++) {
      const cave = new Ctor(d);
      /** ms of every simulated frame this cave took, plan and emit together. */
      const ms = [];
      /**
       * …and what it was doing. Every `yield` in the build names the work that
       * ended at it, so `cave.stage` after a slice is the last thing that slice
       * finished — which for a slice that ran long is the thing that ran long.
       * Without it a fat quantum is a number with no address, and finding the
       * one unsliced loop in a two thousand line build means bisecting by hand.
       */
      const stage = [];
      let planFrames = 0;
      let emitFrames = 0;
      for (let guard = 0; guard < 20000; guard++) {
        const t0 = performance.now();
        const done = cave.prepareSlice();
        if (!done) {
          ms.push(performance.now() - t0);
          stage.push(cave.stage);
          planFrames++;
          continue;
        }
        // Same frame and the rest of the same deadline, exactly as
        // `CaveField.update` spends it once the plan is in.
        const whole = cave.step();
        ms.push(performance.now() - t0);
        stage.push(cave.stage);
        emitFrames++;
        if (whole) break;
      }
      const sorted = [...ms].sort((a, b) => a - b);
      const by = {};
      for (let i = 0; i < ms.length; i++) by[stage[i]] = Math.max(by[stage[i]] ?? 0, ms[i]);
      reps_.push({
        rings: cave._rows,
        paths: cave.paths.length,
        metres: cave.length,
        planFrames,
        emitFrames,
        slices: ms.length,
        med: sorted[Math.floor(sorted.length / 2)],
        p99: sorted[Math.min(sorted.length - 1, Math.floor(0.99 * (sorted.length - 1)))],
        max: sorted[sorted.length - 1],
        sum: ms.reduce((a, b) => a + b, 0),
        worstStage: stage[ms.indexOf(sorted[sorted.length - 1])],
        hot: by,
      });
      cave.dispose();
    }
    // The quietest repeat of each statistic. See REPS.
    const pick = (f) => Math.min(...reps_.map(f));
    const quietest = reps_.reduce((a, b) => (a.max <= b.max ? a : b));
    const hot = {};
    for (const [k, v] of Object.entries(reps_[0].hot)) {
      hot[k] = Math.min(...reps_.map((r) => r.hot[k] ?? Infinity));
      if (!Number.isFinite(hot[k])) hot[k] = v;
    }
    rows.push({
      k: d.k,
      rings: reps_[0].rings,
      paths: reps_[0].paths,
      metres: reps_[0].metres,
      planFrames: reps_[0].planFrames,
      emitFrames: reps_[0].emitFrames,
      slices: reps_[0].slices,
      med: pick((r) => r.med),
      p99: pick((r) => r.p99),
      max: pick((r) => r.max),
      raw: Math.max(...reps_.map((r) => r.max)),
      sum: pick((r) => r.sum),
      worstStage: quietest.worstStage,
      hot,
    });
  }
  return { rows };
}, [CAVES, REPS]);

if (build.error) {
  console.log(build.error);
  await browser.close();
  process.exit(1);
}

const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
const stat = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return { med: q(s, 0.5), p99: q(s, 0.99), max: s[s.length - 1], sum: a.reduce((x, y) => x + y, 0) };
};

console.log(`the build, sliced — every frame of every cave, best of ${REPS} builds
`);
console.log('   k   rings  paths  metres   plan  emit    median     p99    worst      raw    total');
for (const r of build.rows) {
  console.log(
    `  ${String(r.k).padStart(3)}  ${String(r.rings).padStart(5)}  ${String(r.paths).padStart(5)}  ` +
      `${r.metres.toFixed(0).padStart(6)}  ${String(r.planFrames).padStart(5)}${String(r.emitFrames).padStart(6)}  ` +
      `${r.med.toFixed(2).padStart(8)}${r.p99.toFixed(2).padStart(8)}${r.max.toFixed(2).padStart(9)}` +
      `${r.raw.toFixed(2).padStart(9)}${r.sum.toFixed(0).padStart(9)}   in ${r.worstStage}`
  );
}
/** The gated pair: the fattest slice any cave produced on its quietest build. */
const worstSlice = Math.max(...build.rows.map((r) => r.max));
const worstK = build.rows.find((r) => r.max === worstSlice).k;
const worstP99 = Math.max(...build.rows.map((r) => r.p99));
console.log(
  `
  ${build.rows.length} caves   median slice ${stat(build.rows.map((r) => r.med)).med.toFixed(2)} ms   ` +
    `worst p99 ${worstP99.toFixed(2)} ms   worst slice ${worstSlice.toFixed(2)} ms (k=${worstK})   ` +
    `whole build ${stat(build.rows.map((r) => r.sum)).med.toFixed(0)} ms median, ` +
    `${Math.max(...build.rows.map((r) => r.sum)).toFixed(0)} ms worst`
);
/**
 * THE GATED NUMBER, AND IT IS THIS ONE RATHER THAN THE WORST SLICE.
 *
 * For each cave and each named stage: the smallest, over the repeats, of the
 * worst slice that stage produced. Then the largest of those.
 *
 * That sounds baroque and it is the only statistic here that holds still. A real
 * unsliced quantum is a property of the code, so it appears in EVERY repeat and
 * always in the SAME stage — the minimum does not touch it. A stall is a
 * property of the machine, so it lands in whichever stage happened to be in
 * flight, which is a different one each time — and the minimum deletes it. On
 * the run this was written against, three of the nine caves took stalls of 4.5,
 * 31.0 and 81.2 ms (another agent's browser starting), the plain worst slice
 * read 2.40 ms, and this read 1.40 — the same 1.40 the quiet run had reported
 * an hour earlier.
 *
 * The plain worst and the raw worst are both still printed, because a run where
 * they are enormous is a run whose millisecond column should not be trusted at
 * all, and that is worth being able to see.
 */
const hot = {};
for (const r of build.rows) {
  for (const [k, v] of Object.entries(r.hot)) hot[k] = Math.max(hot[k] ?? 0, v);
}
const byStage = Object.entries(hot).sort((a, b) => b[1] - a[1]);
const worstStage = byStage[0];
console.log(
  '  worst slice by stage   ' +
    byStage
      .slice(0, 6)
      .map(([k, v]) => `${k} ${v.toFixed(2)}`)
      .join('   ')
);

/* ---- in the frame -------------------------------------------------------- */

/**
 * Walk at a mouth from inside BUILD_RANGE and time the phase.
 *
 * From inside, not from beyond it: the 320 m outside the build range are 39
 * seconds of sprinting in which nothing happens by definition, and a gate that
 * spends them is a gate nobody runs. The cave is streamed by standing the player
 * where the rescan will find it, which is the same event the walk would produce.
 */
const walk = await page.evaluate(async (frames) => {
  const R = window.RR;
  const terrain = await import('/src/world/terrain.js');
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const con = R.controller;
  const near = terrain.cavesNear(0, 0, 4000).sort((a, b) => a.k - b.k);
  const target = near[0];

  // Drop everything already built, so what is timed is a build and not a walk
  // past nine finished ones.
  R.caves.dispose();

  // 300 m out on the line to the mouth: inside BUILD_RANGE, so the next rescan
  // arms the build, and far enough that the whole of it happens while walking.
  const dx = target.x;
  const dz = target.z;
  const d = Math.hypot(dx, dz) || 1;
  const sx = target.x - (dx / d) * 300;
  const sz = target.z - (dz / d) * 300;
  con.fly = false;
  con.keys.clear();
  con.velocity.set(0, 0, 0);
  // On the ground, not dropped onto it: a body falling 200 m spends the first
  // second of the measurement in the air, which is a second of the build.
  con.position.set(sx, terrain.heightAt(sx, sz) + 1.7, sz);
  R.director.ground();
  /**
   * SETTLE BEFORE MEASURING, AND SETTLE ON A SIGNAL RATHER THAN A COUNT.
   *
   * A teleport of three hundred metres leaves the streamer with a screenful of
   * sectors to fetch, and the frames while it does are not frames a walking
   * player ever sees. Waiting for the queue to empty rather than for n frames is
   * the same rule `probe.js` states at `settle` and the same one this project
   * has recorded four instruments getting wrong in a single day. Bounded, so a
   * world that will not settle says so instead of hanging.
   */
  let settled = false;
  for (let i = 0; i < 900 && !settled; i++) {
    await raf();
    settled = i > 30 && R.forest.settled;
  }
  const from = { x: con.position.x, z: con.position.z };

  /**
   * The phase timer, and it wraps the same method `src/dev/perf/probe.js` wraps
   * — one `performance.now()` either side of `caves.update`, which is where
   * every slice this script cares about is spent.
   */
  const per = [];
  const original = R.caves.update.bind(R.caves);
  let acc = 0;
  R.caves.update = function timed(...a) {
    const t0 = performance.now();
    try {
      return original(...a);
    } finally {
      acc += performance.now() - t0;
    }
  };

  con.keys.add('KeyW');
  con.keys.add('ShiftLeft');
  let built = 0;
  for (let i = 0; i < frames; i++) {
    con.yaw = Math.atan2(-(target.x - con.position.x), -(target.z - con.position.z));
    acc = 0;
    await raf();
    per.push(acc);
    built = R.caves.built;
  }
  con.keys.delete('KeyW');
  con.keys.delete('ShiftLeft');
  R.caves.update = original;
  return {
    per,
    built,
    settled,
    streamed: R.caves.caves.size,
    walked: Math.hypot(con.position.x - from.x, con.position.z - from.z),
    left: Math.hypot(target.x - con.position.x, target.z - con.position.z),
  };
}, FRAMES);

const W = stat(walk.per);
const over = walk.per.filter((v) => v > WALK_BUDGET).length;
console.log(
  `\nin the frame — ${walk.per.length} frames toward k=${build.rows[0].k}, ` +
    `${walk.walked.toFixed(0)} m walked, ${walk.left.toFixed(0)} m to the mouth, ` +
    `${walk.built} of ${walk.streamed} streamed caves finished` +
    `${walk.settled ? '' : '  (WORLD NEVER SETTLED)'}`
);
console.log(
  `  caves.update   median ${W.med.toFixed(2)} ms   p99 ${W.p99.toFixed(2)} ms   ` +
    `worst ${W.max.toFixed(2)} ms   over ${WALK_BUDGET} ms: ${over} of ${walk.per.length} frames`
);

/* ---- the verdict --------------------------------------------------------- */

/**
 * TWO BARS, AND THE TIGHT ONE IS THE DETERMINISTIC MEASUREMENT.
 *
 * The build table is the gate: it has no renderer and no streamer in it, it is
 * the best of REPS builds, and its numbers move only when the slicing does.
 *
 * The walk is checked against a looser bar and on p99 rather than on the single
 * worst frame, deliberately. A frame in there carries the rescan, the sort and
 * whatever else the machine was doing — and a gate that fails because somebody
 * opened a browser is a gate that gets ignored, which is worse than not having
 * one. A REAL regression shows in both halves and names the same stage in the
 * by-stage line.
 */
const fails = [];
if (worstStage[1] > BUDGET) {
  fails.push(`${worstStage[0]} slices reach ${worstStage[1].toFixed(2)} ms > ${BUDGET} ms — that stage needs cutting`);
}
if (worstP99 > BUDGET) fails.push(`worst build p99 ${worstP99.toFixed(2)} ms > ${BUDGET} ms`);
if (W.p99 > WALK_BUDGET) {
  fails.push(`caves.update p99 ${W.p99.toFixed(2)} ms > ${WALK_BUDGET} ms while walking`);
}
if (!walk.built) fails.push('no cave finished building during the walk — nothing was measured');
console.log(fails.length ? `\nFAIL  ${fails.join('\n      ')}` : '\nPASS');
await browser.close();
process.exit(fails.length ? 1 : 0);
