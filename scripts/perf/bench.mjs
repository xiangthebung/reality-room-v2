import { SCENARIOS } from '../../src/dev/perf/stations.js';
import { boot, runSuite, unsettled, argv, identity, readJson, writeJson, heading, PAD, NUM, DEV_URL, PERF_BUILD_URL, PERF_DIR } from './harness.mjs';
import { median, summarise, normalise } from './stats.mjs';

/**
 * THE REGRESSION GATE.
 *
 *   npm run perf:bench                  measure, compare against the baseline
 *   npm run perf:bench -- --record      make this run the baseline
 *   npm run perf:bench -- --build       measure the instrumented BUILD, not dev
 *   npm run perf:bench -- --repeats=5   for --record: how many passes to measure
 *
 * Exits non-zero when something got worse, so it can sit in `npm run check`.
 *
 *
 * WHAT IS GATED, AND WHY THE TWO HALVES ARE GATED DIFFERENTLY.
 *
 * There are two kinds of number in a run and treating them the same is how you
 * end up with a benchmark nobody trusts.
 *
 *   COUNTERS ARE ALMOST EXACT. Draw calls, triangles, submitted instances. They
 *   do not care what else is running on the machine, so they need no statistics
 *   and they can be believed on a single sample — which makes this half of the
 *   gate about ten times sharper than the timing half. Most real regressions
 *   trip it first, and it says WHICH layer, where a millisecond figure only
 *   says that something did.
 *
 *   "Almost", and the gap is worth stating rather than rounding away. The
 *   forest and the ground stream in sectors, fetched inside one radius and
 *   evicted outside a larger one, so which sectors are resident depends on
 *   where the camera came from as well as where it is. Measured across passes
 *   of this suite that is worth a couple of per cent — the canopy station
 *   reported between 9.91 M and 10.45 M triangles on identical code. A tour of
 *   the suite before recording removes the boot-state outlier (see `tour`); the
 *   residue is real and is gated with a tight, MEASURED tolerance rather than
 *   with a zero that would fire on nothing but itself.
 *
 *   TIMINGS ARE NOT. They drift ±40% between runs of identical code on this
 *   machine. So they are gated on each scenario's RATIO to the run level — the
 *   median scenario of the same session (see `normalise` in stats.mjs) — with a
 *   tolerance derived from how much that ratio actually moved across the
 *   repeats taken when the baseline was recorded, rather than from a number
 *   somebody liked the look of.
 *
 * The blind spot this leaves is stated rather than hidden: a change that makes
 * every scenario slower by the same factor moves no ratio and trips nothing.
 * The absolute medians are recorded and printed on every run for exactly that
 * reason, and a uniform slowdown of the whole renderer is not the kind of thing
 * that arrives quietly.
 */

const args = argv({ repeats: '5', reps: '5' });
const RECORD = args.record === 'true';
const URL = args.build === 'true' ? PERF_BUILD_URL : DEV_URL;
const BASELINE = `${PERF_DIR}/baseline.json`;

/**
 * The floor under every tolerance, as a fraction of the ratio.
 *
 * Even a perfectly-behaved rig cannot resolve a 2% change in a ratio between
 * two workloads measured seconds apart, and a gate that tries will fire on
 * nothing. 8% is a little under half what this project's smallest real
 * optimisation was worth (MSAA, ~20% at peak), so a change worth having is
 * still comfortably visible.
 *
 * It was 6%, and the cheapest scenario in the suite tripped it on a re-run of
 * unchanged code. The wobble that did it is not in the batches — those agree to
 * a few per cent — it is in the ARRIVAL: teleporting, settling and re-streaming
 * lands in a slightly different place each time, and the cheapest scenario is
 * where a fixed wobble is the largest fraction. Hence more passes below as well
 * as a wider floor: the two together attack the same term from both ends.
 */
const FLOOR = 0.08;
/** How many baseline spreads a run has to exceed before it counts as moved. */
const SIGMAS = 3;
/**
 * The floor under the COUNTER tolerance — an order of magnitude tighter than
 * the timing floor, because the only thing moving these is which streamed
 * sectors happen to be resident, and that is worth low single-digit per cent
 * rather than the ±40% a millisecond figure drifts by. A change that adds
 * geometry to the frame will clear this comfortably; a sector arriving one lap
 * early will not.
 */
const COUNTER_FLOOR = 0.025;

const { browser, page, caps } = await boot({ url: URL });

/**
 * A run is not believed until the world it measured is actually there.
 *
 * Both instance rings fill at one sector per frame and the gate opens when they
 * settle, so this should always pass — but "should always pass" is exactly the
 * assumption that produces a benchmark reporting a magnificent improvement
 * because it measured an empty forest. It has to be an assertion.
 */
const before = await page.evaluate(() => window.__RR_PERF__.counters());
if (!before.sectors.forest || !before.sectors.ground) {
  await browser.close();
  console.error(
    `The world had not finished streaming: ${before.sectors.forest} forest sectors, ` +
      `${before.sectors.ground} ground chunks, ${before.sectors.pending} pending.\n` +
      'Measuring this would report a smaller wood as an improvement. Refusing.'
  );
  process.exit(2);
}

/**
 * One un-timed lap before anything is recorded. See `tour` in probe.js: the
 * streamer's resident set depends on where the camera came from, so the first
 * visit to a station after boot sees a measurably different world from every
 * visit after that. Without this the first pass is an outlier and it is the one
 * that gets used when `--record` is not passed.
 */
process.stdout.write('touring the suite once to settle the streamer… ');
await page.evaluate((s) => window.__RR_PERF__.tour(s), SCENARIOS);
console.log('done\n');

const repeats = RECORD ? Math.max(2, Number(args.repeats)) : 1;
const passes = [];
for (let i = 0; i < repeats; i++) {
  if (repeats > 1) console.log(`pass ${i + 1}/${repeats}`);
  passes.push(await runSuite(page, SCENARIOS, { reps: Number(args.reps) }));
}
await browser.close();

const stuck = [...new Set(passes.flatMap(unsettled))];
if (stuck.length) {
  console.error(
    `\nThese stations never reached a stable frame: ${stuck.join(', ')}.\n` +
      'They were timed against a world that was still streaming in, which reports\n' +
      'fewer triangles than are really there and reads as an improvement. Refusing.'
  );
  process.exit(2);
}

/* ---- shape one run into the comparable form ----------------------------- */

/**
 * Turn a pass into `{name: {ratio, ms, counters}}`.
 *
 * Normalising happens per pass, before anything is combined across passes. Done
 * the other way round — average the milliseconds, then take the ratio — a pass
 * that was globally slow would drag the mean of every scenario and the ratios
 * would come out right only by luck.
 */
function shape(pass) {
  const { level, scenarios: rows } = normalise(pass);
  const out = {};
  for (const r of rows) {
    out[r.name] = {
      ratio: r.ratio,
      ms: r.ms,
      spread: summarise(r.batches).rsd,
      counters: r.counters,
      disjoints: r.disjoints,
    };
  }
  return { level, rows: out };
}

const all = passes.map(shape);
const shaped = all.map((s) => s.rows);
const levels = all.map((s) => s.level);
const run = shaped[0];

if (RECORD) {
  /**
   * The baseline stores the MEDIAN ratio across passes and the observed SPREAD
   * of that ratio, and the spread is the point. It is what turns the tolerance
   * from an opinion into a measurement: a scenario whose ratio wandered by 1%
   * across three passes gets a tight gate, and one that wandered by 8% gets a
   * loose one, automatically, because that is what this machine can actually
   * resolve for that scenario. Guessing one number for all of them would be
   * simultaneously too tight for the noisy ones and useless for the quiet ones.
   */
  const scenarios = {};
  for (const name of Object.keys(run)) {
    const ratios = shaped.map((p) => p[name].ratio);
    const mss = shaped.map((p) => p[name].ms);
    const mid = median(ratios);
    /**
     * Counters get the same treatment as ratios and for the same reason: the
     * spread across passes IS the tolerance. Recording the mid-point of what
     * the streamer actually did, plus how far it wandered while doing it, is
     * the difference between a gate calibrated to this engine and a gate
     * calibrated to somebody's intuition about how deterministic a renderer
     * ought to be.
     */
    const counters = {};
    for (const key of ['calls', 'triangles']) {
      const vs = shaped.map((p) => p[name].counters[key]);
      const c = median(vs);
      counters[key] = { value: c, spread: c ? Math.max(...vs.map((v) => Math.abs(v - c))) / c : 0 };
    }
    scenarios[name] = {
      ratio: mid,
      ratioSpread: Math.max(...ratios.map((r) => Math.abs(r - mid))) / (mid || 1),
      ms: median(mss),
      msRange: [Math.min(...mss), Math.max(...mss)],
      counters,
    };
  }
  const baseline = {
    recordedAt: new Date().toISOString(),
    identity: identity(caps, { url: URL, passes: repeats }),
    /**
     * The run level in milliseconds — the median scenario. Informational only:
     * nothing is gated on it, because it is exactly the quantity that drifts.
     * It is recorded so that a reader comparing two baselines months apart can
     * see whether the machine or the game got faster, which is a question the
     * ratios are deliberately unable to answer.
     */
    level: median(levels),
    structural: before,
    scenarios,
  };
  writeJson(BASELINE, baseline);

  console.log(heading('recorded baseline'));
  console.log(`${PAD('scenario', 24)}${PAD('ratio', 9)}${PAD('spread', 9)}${PAD('ms', 9)}gate`);
  for (const [name, s] of Object.entries(scenarios)) {
    const tol = Math.max(SIGMAS * s.ratioSpread, FLOOR);
    console.log(
      PAD(name, 24) +
        NUM(s.ratio, 7, 3) +
        '  ' +
        NUM(s.ratioSpread * 100, 6, 1) +
        '%  ' +
        NUM(s.ms, 6) +
        '   ±' +
        (tol * 100).toFixed(0) +
        '%'
    );
  }
  if (caps.hidden) {
    console.log(
      '\nNOTE: the page was HIDDEN. Timer queries under-report badly when it is\n' +
        '(≈22 ms measured for a frame that really costs ≈88 ms). The ratios are\n' +
        'still internally consistent, but the absolute ms column is fiction.'
    );
  }
  console.log(`\n${BASELINE}`);
  process.exit(0);
}

/* ---- compare ------------------------------------------------------------ */

const baseline = readJson(BASELINE);
if (!baseline) {
  console.error(`No baseline at ${BASELINE}. Record one:\n\n  npm run perf:baseline\n`);
  process.exit(2);
}
if (baseline.identity.seed !== caps.seed) {
  console.error(
    `Baseline was recorded in world "${baseline.identity.seed}" and this run is in ` +
      `"${caps.seed}".\nThe world IS the workload — a different seed is a different ` +
      `forest in front of the camera,\nnot a noisier version of the same one. Refusing to compare.`
  );
  process.exit(2);
}
/**
 * The dev server and the production bundle are not the same program — see the
 * header of build.mjs. Measured across them, most scenarios agree to within a
 * few per cent and the cheapest one moved 10%, which is enough to trip a tight
 * gate. That is the gate working, not the gate being wrong, but it is worth
 * saying out loud before somebody spends an afternoon on it.
 */
if (baseline.identity.url !== URL) {
  console.log(
    `NOTE: baseline was recorded against ${baseline.identity.url} and this run is\n` +
      `${URL}. The dev server and the built bundle differ by a few per cent on the\n` +
      'cheapest scenarios. Record a baseline per environment for a tight gate.\n'
  );
}
if (baseline.identity.gpu !== caps.gpu) {
  console.log(
    `NOTE: baseline GPU "${baseline.identity.gpu}" differs from this one "${caps.gpu}".\n` +
      'Counters still compare exactly; ratios are more forgiving than absolutes but not immune.\n'
  );
}

const failures = [];
const notes = [];

console.log(heading('what is in the frame — draw calls and triangles'));
console.log(`${PAD('scenario', 24)}${PAD('draws', 20)}${PAD('triangles', 24)}`);
for (const [name, base] of Object.entries(baseline.scenarios)) {
  const now = run[name];
  if (!now) {
    notes.push(`${name}: in the baseline, not in this run — the suite changed.`);
    continue;
  }
  const cells = [];
  let moved = false;
  for (const key of ['calls', 'triangles']) {
    const ref = base.counters[key];
    const a = ref.value;
    const b = now.counters[key];
    const tol = Math.max(SIGMAS * ref.spread, COUNTER_FLOOR);
    const change = a ? (b - a) / a : 0;
    const show = key === 'triangles' ? `${(b / 1e6).toFixed(2)}M` : String(b);
    if (Math.abs(change) <= tol) cells.push(show);
    else {
      moved = true;
      cells.push(`${show} ${change > 0 ? '+' : ''}${(change * 100).toFixed(1)}%`);
      // Only MORE is a regression. Less geometry for the same picture is the
      // thing everybody here is trying to achieve, and being told off for it
      // is how a gate teaches people to stop running it.
      if (change > 0) {
        failures.push(
          `${name}: ${key} ${key === 'triangles' ? `${(a / 1e6).toFixed(2)}M → ${(b / 1e6).toFixed(2)}M` : `${a} → ${b}`}` +
            ` (+${(change * 100).toFixed(1)}%, gate ±${(tol * 100).toFixed(1)}%)`
        );
      } else {
        notes.push(`${name}: ${key} down ${(-change * 100).toFixed(1)}% — less in the frame than the baseline had.`);
      }
    }
  }
  console.log(PAD(name, 24) + PAD(cells[0], 20) + PAD(cells[1], 24) + (moved ? 'MOVED' : ''));
}
for (const name of Object.keys(run)) {
  if (!baseline.scenarios[name]) notes.push(`${name}: new scenario, no baseline to compare with.`);
}

console.log(heading('shape of the frame — each scenario against the run level'));
console.log(`${PAD('scenario', 24)}${PAD('ratio', 9)}${PAD('baseline', 10)}${PAD('change', 10)}gate`);
for (const [name, base] of Object.entries(baseline.scenarios)) {
  const now = run[name];
  if (!now) continue;
  const tol = Math.max(SIGMAS * base.ratioSpread, FLOOR);
  const change = (now.ratio - base.ratio) / base.ratio;
  const bad = change > tol;
  const good = change < -tol;
  console.log(
    PAD(name, 24) +
      NUM(now.ratio, 7, 3) +
      '  ' +
      NUM(base.ratio, 8, 3) +
      '  ' +
      `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%`.padStart(8) +
      '  ±' +
      (tol * 100).toFixed(0) +
      '%' +
      (bad ? '   SLOWER' : good ? '   faster' : '')
  );
  if (bad) {
    failures.push(
      `${name}: ${(change * 100).toFixed(1)}% slower relative to the rest of the run ` +
        `(gate ±${(tol * 100).toFixed(0)}%)`
    );
  }
  if (good) {
    notes.push(
      `${name}: ${(-change * 100).toFixed(1)}% faster — worth re-recording the baseline.`
    );
  }
}

/**
 * The absolutes, printed and never gated.
 *
 * Present because the ratio gate is blind to a uniform slowdown and a person
 * reading the report should be able to see one, and because "everything is
 * ×1.6 today" is useful context for judging whether the machine was busy.
 */
console.log(heading('absolute ms — reported, never gated (drifts ±40% between runs)'));
const drift = median(
  Object.entries(baseline.scenarios)
    .filter(([n]) => run[n])
    .map(([n, b]) => run[n].ms / b.ms)
);
for (const [name, base] of Object.entries(baseline.scenarios)) {
  const now = run[name];
  if (!now) continue;
  console.log(
    PAD(name, 24) + NUM(now.ms, 7) + ' ms   baseline ' + NUM(base.ms, 6) + ' ms   ' +
      `×${(now.ms / base.ms).toFixed(2)}`
  );
}
console.log(`\nwhole-run drift (median of the column above): ×${drift.toFixed(2)}`);
const noisiest = Object.entries(run).sort((a, b) => b[1].spread - a[1].spread)[0];
console.log(
  `noisiest scenario: ${noisiest[0]} at ${(noisiest[1].spread * 100).toFixed(1)}% spread across batches`
);
const disjoints = Object.values(run).reduce((n, r) => n + (r.disjoints ?? 0), 0);
if (disjoints) console.log(`${disjoints} batches were discarded as GPU-disjoint`);

if (notes.length) {
  console.log(heading('notes'));
  for (const n of notes) console.log(`  ${n}`);
}

if (failures.length) {
  console.log(heading('REGRESSIONS'));
  for (const f of failures) console.log(`  ${f}`);
  console.log(
    '\nIf these are intended, re-record:  npm run perf:baseline\n'
  );
  process.exit(1);
}
console.log('\nno regressions.\n');
