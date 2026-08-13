import { boot, argv, heading, PAD, NUM, DEV_URL, PERF_BUILD_URL, PERF_DIR, writeJson } from './harness.mjs';
import { median, quantile } from './stats.mjs';

/**
 * WHAT CAUSED THAT 211 MILLISECOND FRAME.
 *
 *   npm run perf:spikes
 *   npm run perf:spikes -- --station=deep --level=peak --seconds=20
 *   npm run perf:spikes -- --walks=3      repeat, to see which causes recur
 *
 * The steady-state suite cannot answer this by construction: it holds the world
 * still so that a frame costs the same number twice, and a hitch is by
 * definition the frame where something happened that does not happen every
 * frame. So this hands the loop back, walks the camera, and records what
 * CHANGED during each frame alongside how long that frame took.
 *
 * Attribution is by co-occurrence, and the report says so rather than implying
 * a proof. A frame that compiled a shader and took 200 ms is not proof the
 * compile cost 200 ms — but when every slow frame compiled something and no
 * fast frame did, the case is closed for practical purposes, and the fix is the
 * same either way.
 *
 * The base rates matter as much as the hits, so both are printed: "8 of 9
 * hitches accepted a sector" means nothing until you also know that only 6% of
 * ordinary frames did.
 */

const args = argv({ station: 'deep', level: 'peak', seconds: '20', walks: '2' });
const SPEC = { station: args.station, level: args.level };
const SECONDS = Number(args.seconds);
const WALKS = Number(args.walks);

const { browser, page } = await boot({
  url: args.build === 'true' ? PERF_BUILD_URL : DEV_URL,
  vsync: args.vsync === 'true',
  headed: args.vsync === 'true',
});

/**
 * THE UNCAPPED RUN MANUFACTURES ITS OWN HITCHES, AND THIS SAYS SO RATHER THAN
 * LEAVING THEM TO BE INVESTIGATED AGAIN.
 *
 * The launch flags disable vsync and the frame-rate limit, which is right for
 * every OTHER measurement in this directory: they are the only way to see
 * headroom. Here they are actively misleading. At 500 fps the page hands the
 * driver frames faster than it retires them, the queue backs up, and the next
 * `pipeline.render()` blocks inside a GL call waiting for room. That shows up
 * as a 90-200 ms frame, 100% script, attributed to `frame()` in main.js and to
 * `render` in the phase table — indistinguishable, from inside, from a real
 * stall.
 *
 * Measured both ways on the same build at the deep station: uncapped, mouse-look
 * put 1.49% of frames over 50 ms with a worst of 150 ms and 95% of the long-frame
 * time in script. The same segments with vsync on: 0.14%, and the browser
 * attributed 0% of it to script. The uncapped number is an artifact of the
 * harness and a player with vsync can never see it.
 *
 * So: `--vsync` for "would a player feel this", default for "what changed
 * between two builds". Neither is wrong; reading one as the other cost this
 * project an investigation.
 */
if (args.vsync !== 'true') {
  console.log(
    'NOTE: uncapped. Frames blocked on a backed-up GPU queue will appear here as\n' +
      '      long frames inside render(). Re-run with --vsync for player-visible\n' +
      '      pacing before concluding a spike is real.\n'
  );
}

/**
 * The causes, in the order they are worth suspecting. Each is a predicate over
 * one frame's deltas.
 *
 * `programs` is first because a synchronous shader compile is the only thing in
 * this list that can plausibly cost a tenth of a second on its own, and because
 * it is the one main.js already goes to some trouble to pre-empt before the
 * gate comes down — so a compile happening mid-walk means that pre-warm did not
 * cover this case, which is a specific and fixable finding.
 */
const CAUSES = [
  { name: 'shader compile', of: (d) => d.programs > 0, unit: 'programs' },
  { name: 'sector accepted', of: (d) => d.built > 0, unit: 'sectors' },
  { name: 'sector evicted', of: (d) => d.evicted > 0, unit: 'sectors' },
  { name: 'ground chunk', of: (d) => d.ground !== 0, unit: 'chunks' },
  { name: 'geometry alloc', of: (d) => d.geometries > 0, unit: 'geometries' },
  /**
   * The same event as `geometry alloc`, split by what it actually costs.
   *
   * `geometry alloc` is the largest lift this report has ever measured and the
   * least actionable line in it, because the counter behind it moves on the
   * frame a geometry is first DRAWN and covers a 24-vertex campfire prop and a
   * 1.8 MB cave mesh alike. Measured over a 20 s walk at the deep station: 29
   * ground chunks at 416 KB each, one cave at 1.8 MB, and some eighty small
   * props — and the props are the majority of the count while the chunks and
   * the cave are the whole of the bytes. A quarter of a megabyte is the line
   * between a first draw that hides inside a frame and one that does not.
   */
  { name: '  …of which >256 KB uploaded', of: (d) => d.metBytes > 262144, unit: 'bytes' },
  { name: 'geometry freed', of: (d) => d.geometries < 0, unit: 'geometries' },
  { name: 'texture alloc', of: (d) => d.textures !== 0, unit: 'textures' },
  { name: 'big instance repack', of: (d) => d.uploadedNow > 5000, unit: 'instances' },
  /**
   * A slab doubling: a full `bufferData` of the new capacity on the next
   * render, up to 8 MB, plus an orphaned GL buffer that nothing can release.
   * forest.js sizes the capacities so this never fires; it is here so that
   * "never" is a measurement rather than an intention, and because a content
   * pass that moves the resident peaks is exactly what would break it.
   */
  { name: 'slab doubled', of: (d) => d.grows > 0, unit: 'growths' },
  { name: 'GC (heap fell)', of: (d) => d.heap < -1e6, unit: 'bytes' },
];

const runs = [];
for (let w = 0; w < WALKS; w++) {
  process.stdout.write(`walk ${w + 1}/${WALKS} — ${SECONDS}s at ${SPEC.station}, ${SPEC.level}… `);
  const walk = await page.evaluate(
    ([s, sec]) =>
      window.__RR_PERF__.walk({
        seconds: sec,
        station: s.station,
        level: s.level,
        profile: true,
      }),
    [SPEC, SECONDS]
  );
  console.log(`${walk.intervals.length} frames`);
  runs.push(walk);
}
await browser.close();

const frames = [];
for (const [w, walk] of runs.entries()) {
  for (let i = 1; i < walk.intervals.length; i++) {
    const a = walk.marks[i - 1];
    const b = walk.marks[i];
    if (!a || !b) continue;
    frames.push({
      walk: w + 1,
      at: i,
      fresh: b.fresh ?? [],
      phases: walk.phases?.[i] ?? null,
      ms: walk.intervals[i],
      programs: b.programs - a.programs,
      // Already per-frame — the probe drains its cursor every frame — so unlike
      // everything around it these are read rather than differenced.
      met: b.met ?? 0,
      metBytes: b.metBytes ?? 0,
      metWhat: b.metWhat ?? '',
      grows: (b.grows ?? 0) - (a.grows ?? 0),
      geometries: b.geometries - a.geometries,
      textures: b.textures - a.textures,
      built: b.built - a.built,
      evicted: b.evicted - a.evicted,
      ground: b.ground - a.ground,
      pending: b.pending,
      // The culler holds `uploaded` until the next repack, so the raw value is
      // not per-frame. A CHANGE in it is a repack that moved a different
      // amount, which is the closest honest proxy for "a repack happened here".
      uploadedNow: b.uploaded !== a.uploaded ? b.uploaded : 0,
      heap: b.heap - a.heap,
    });
  }
}

const med = median(frames.map((f) => f.ms));
/**
 * Twice the median, as everywhere else in this framework — a frame that took
 * the place of two. Relative rather than absolute so it means the same thing on
 * a 60 Hz and a 144 Hz display.
 */
const hitches = frames.filter((f) => f.ms > med * 2);
const normal = frames.filter((f) => f.ms <= med * 2);

console.log(heading('the walk'));
console.log(`  frames            ${frames.length} across ${WALKS} walks`);
console.log(`  median            ${NUM(med, 7)} ms`);
console.log(`  p95 / p99 / p999  ${NUM(quantile(frames.map((f) => f.ms), 0.95), 6)} / ${NUM(quantile(frames.map((f) => f.ms), 0.99), 6)} / ${NUM(quantile(frames.map((f) => f.ms), 0.999), 6)} ms`);
console.log(`  worst             ${NUM(Math.max(...frames.map((f) => f.ms)), 7)} ms`);
console.log(`  hitches >2× med   ${hitches.length}  (${((hitches.length / frames.length) * 100).toFixed(2)}%)`);

console.log(heading('what happened on the slow frames vs the rest'));
console.log(`${PAD('cause', 24)}${PAD('in hitches', 14)}${PAD('in normal frames', 20)}lift`);
const attribution = [];
for (const cause of CAUSES) {
  const inH = hitches.filter((f) => cause.of(f)).length;
  const inN = normal.filter((f) => cause.of(f)).length;
  const rateH = hitches.length ? inH / hitches.length : 0;
  const rateN = normal.length ? inN / normal.length : 0;
  /**
   * The ratio of the two rates. A cause that fires on every frame explains
   * nothing however often it appears in the hitches, and this is the column
   * that says so: a lift near 1 means the cause is background, and only a large
   * lift on a cause that is also COMMON in the hitches is worth acting on.
   */
  const lift = rateN > 0 ? rateH / rateN : rateH > 0 ? Infinity : 0;
  attribution.push({ cause: cause.name, inH, inN, rateH, rateN, lift });
  if (inH === 0 && inN === 0) continue;
  console.log(
    PAD(cause.name, 24) +
      PAD(`${inH}/${hitches.length} (${(rateH * 100).toFixed(0)}%)`, 14) +
      PAD(`${inN}/${normal.length} (${(rateN * 100).toFixed(1)}%)`, 20) +
      (lift === Infinity ? '   ∞ — never happens otherwise' : `   ×${lift.toFixed(1)}`)
  );
}

/**
 * Every hitch, listed. With a handful of them the individual rows are more
 * informative than any summary — a single 200 ms frame that compiled three
 * programs is a different story from twenty 40 ms frames that each accepted a
 * sector, and a table of rates cannot tell those apart.
 */
console.log(heading('every slow frame'));
if (!hitches.length) console.log('  none.');
for (const f of hitches.sort((a, b) => b.ms - a.ms).slice(0, 25)) {
  const why = CAUSES.filter((c) => c.of(f)).map((c) => c.name);
  console.log(
    `  walk ${f.walk} f${String(f.at).padEnd(5)} ${f.ms.toFixed(1).padStart(7)} ms  (×${(f.ms / med).toFixed(0)})  ` +
      `${why.length ? why.join(', ') : 'nothing measured here changed'}` +
      `${f.fresh.length ? `  →  ${f.fresh.join(', ')}` : ''}` +
      `${f.built ? ` [+${f.built} sectors]` : ''}` +
      `${f.metWhat ? `  →  first draw: ${f.metWhat}` : ''}` +
      `${f.uploadedNow ? ` [${f.uploadedNow} instances]` : ''}`
  );
}

/**
 * WHAT THE FIRST DRAWS WERE, over the whole walk rather than over the hitches.
 *
 * The hitch rows above can only show the ones that happened to land on a slow
 * frame, and the interesting question is the other way round: this is every
 * mesh whose first upload the walk paid for, biggest first, so the ones worth
 * pre-warming or splitting can be picked off by size rather than by whether
 * they were unlucky. A first draw that costs 400 KB and lands inside a 16.7 ms
 * frame today is a dropped frame on a 240 Hz panel and on a heavier build.
 */
const uploads = new Map();
let uploadBytes = 0;
for (const f of frames) {
  if (!f.metBytes) continue;
  uploadBytes += f.metBytes;
  const row = uploads.get(f.metWhat) ?? { n: 0, bytes: 0, worstMs: 0 };
  row.n++;
  row.bytes += f.metBytes;
  row.worstMs = Math.max(row.worstMs, f.ms);
  uploads.set(f.metWhat, row);
}
if (uploads.size) {
  console.log(heading('first draws during the walk (geometry uploaded on the frame it appeared)'));
  console.log(`${PAD('what', 46)}${PAD('frames', 9)}${PAD('total', 11)}worst frame`);
  for (const [what, row] of [...uploads].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 12)) {
    console.log(
      PAD(what.length > 44 ? `${what.slice(0, 43)}…` : what, 46) +
        PAD(String(row.n), 9) +
        PAD(
          row.bytes >= 1e6 ? `${(row.bytes / 1048576).toFixed(1)} MB` : `${Math.round(row.bytes / 1024)} KB`,
          11
        ) +
        `${row.worstMs.toFixed(1)} ms`
    );
  }
  console.log(
    `\n  ${(uploadBytes / 1048576).toFixed(1)} MB uploaded across ${
      frames.filter((f) => f.metBytes).length
    } of ${frames.length} frames.`
  );
}

/**
 * THE THRESHOLD THAT ACTUALLY MATTERS TO A PLAYER, reported alongside the
 * relative one.
 *
 * Twice the median is the right definition for comparing machines, and on a
 * frame that costs 4.6 ms it flags everything over 9.2 ms — which is 108 fps
 * and not a hitch by any standard a person would recognise. A frame is dropped
 * when it misses the display's period, so that is the second line, and on a
 * fast machine it is the one worth reading: the relative threshold measures
 * jitter, this one measures stutter.
 */
const DISPLAY_MS = 1000 / 60;
const dropped = frames.filter((f) => f.ms > DISPLAY_MS);
console.log(heading('frames a player would actually see drop (>16.7 ms)'));
console.log(
  `  ${dropped.length} of ${frames.length} (${((dropped.length / frames.length) * 100).toFixed(3)}%)` +
    `  —  one every ${(frames.length / Math.max(1, dropped.length) / 60).toFixed(1)} seconds of walking`
);
const droppedCompiles = dropped.filter((f) => f.programs > 0).length;
console.log(
  `  of those, ${droppedCompiles} compiled a shader` +
    `${dropped.length ? ` (${((droppedCompiles / dropped.length) * 100).toFixed(0)}%)` : ''}`
);
const names = {};
for (const f of frames) for (const n of f.fresh) names[n] = (names[n] ?? 0) + 1;
if (Object.keys(names).length) {
  console.log('\n  programs compiled during the walk, by material:');
  for (const [n, c] of Object.entries(names).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${PAD(n, 30)} ${c}×`);
  }
  console.log('\n  Every one of these is a program the pre-warm in main.js did not cover.');
}

/**
 * The unattributed remainder, called out rather than left for the reader to
 * infer from a table. If most slow frames changed none of these counters then
 * the cause is somewhere this report cannot see — a driver stall, a compositor
 * hiccup, another process — and the honest thing is to say so and stop, rather
 * than to blame whichever counter happened to move most often.
 */
const unattributed = hitches.filter((f) => !CAUSES.some((c) => c.of(f)));
console.log(
  `\n  ${unattributed.length} of ${hitches.length} slow frames changed none of these counters.`
);
if (unattributed.length > hitches.length / 2) {
  console.log('  The majority are NOT explained by anything measured here — treat the');
  console.log('  table above as ruling causes OUT rather than as an explanation.');
}

/* ---- inside the frame ---------------------------------------------------- */

/**
 * WHICH PART OF `frame()` WAS SLOW.
 *
 * Long Animation Frames narrows a spike to "script, inside main.js frame()",
 * which rules out the GPU and the compositor and then stops. This is the phase
 * breakdown that finishes the sentence: the same measurement on a typical frame
 * and on the slow ones, side by side, so a phase that is merely always
 * expensive is visibly different from one that is occasionally catastrophic.
 *
 * The median of the typical frames is the baseline; for the slow frames the
 * WORST is what matters, because a spike is a rare event and its median across
 * the slow frames would average away the very thing being looked for.
 */
const profiled = frames.filter((f) => f.phases);
if (profiled.length) {
  console.log(heading('inside frame(): where the time goes'));
  const names = [...new Set(profiled.flatMap((f) => Object.keys(f.phases)))];
  const normalP = profiled.filter((f) => f.ms <= med * 2);
  const slowP = profiled.filter((f) => f.ms > med * 2);

  const rows = names
    .map((n) => ({
      name: n,
      typical: median(normalP.map((f) => f.phases[n] ?? 0)),
      p99: quantile(normalP.map((f) => f.phases[n] ?? 0), 0.99),
      worst: Math.max(0, ...profiled.map((f) => f.phases[n] ?? 0)),
      inSlow: median(slowP.map((f) => f.phases[n] ?? 0)),
    }))
    .sort((a, b) => b.worst - a.worst);

  console.log(
    `${PAD('  phase', 22)}${PAD('typical', 11)}${PAD('p99', 10)}${PAD('median in a spike', 20)}worst`
  );
  for (const r of rows) {
    if (r.worst < 0.02 && r.typical < 0.02) continue;
    console.log(
      PAD(`  ${r.name}`, 22) +
        PAD(`${r.typical.toFixed(2)} ms`, 11) +
        PAD(`${r.p99.toFixed(2)} ms`, 10) +
        PAD(`${r.inSlow.toFixed(2)} ms`, 20) +
        `${r.worst.toFixed(1)} ms`
    );
  }

  /**
   * DOES THE INSTANCE UPLOAD SHOW UP IN `render`?
   *
   * It ought to. `forest.cull()` only copies matrices into a typed array and
   * marks it dirty; the buffer does not reach the driver until something draws
   * it, so the upload of tens of thousands of instance matrices is paid inside
   * `pipeline.render()` on the same frame, under a name that gives no hint of
   * where it came from. That was the hypothesis this row was added to test.
   *
   * MEASURED, IT IS NOT TRUE HERE, and the row is kept because a negative
   * result that took one line to obtain is worth more than the plausible story
   * it replaces. At the deep station, frames where the culler moved over five
   * thousand instances rendered in 3.60 ms against 4.10 ms for frames where it
   * moved nothing — no penalty at all, and if anything the reverse, because a
   * repack happens when the camera has just turned and a turn tends to bring
   * cheaper geometry into view. The incremental packer moves so few bytes that
   * the upload disappears into the noise. Instance repacking is not a hitch
   * cause on this engine, and the report should say so rather than leave a
   * likely-sounding suspect on the list.
   */
  const repacked = normalP.filter((f) => f.uploadedNow > 5000);
  const quiet = normalP.filter((f) => !f.uploadedNow);
  if (repacked.length && quiet.length) {
    const rr = median(repacked.map((f) => f.phases.render ?? 0));
    const rq = median(quiet.map((f) => f.phases.render ?? 0));
    console.log(
      `\n  render on frames where the culler moved >5000 instances: ${rr.toFixed(2)} ms ` +
        `(${repacked.length} frames)\n` +
        `  render on frames where it moved nothing:                 ${rq.toFixed(2)} ms ` +
        `(${quiet.length} frames)\n` +
        `  the instance upload is billed to render, not to cull:    ${(rr - rq >= 0 ? '+' : '') + (rr - rq).toFixed(2)} ms`
    );
  }

  const sumTypical = rows.reduce((n, r) => n + r.typical, 0);
  console.log(
    `\n  measured phases account for ${sumTypical.toFixed(2)} ms of the ${med.toFixed(2)} ms typical frame` +
      ` (${((sumTypical / med) * 100).toFixed(0)}%)`
  );

  /**
   * The single worst frame, itemised. With a spike this rare the individual
   * frame is the evidence; a summary of six events is a summary of nothing.
   */
  const worstFrame = profiled.reduce((a, b) => (b.ms > a.ms ? b : a));
  console.log(`\n  the worst frame of the run — ${worstFrame.ms.toFixed(1)} ms:`);
  const items = Object.entries(worstFrame.phases)
    .filter(([, v]) => v > 0.05)
    .sort((a, b) => b[1] - a[1]);
  for (const [n, v] of items) {
    console.log(`    ${PAD(n, 20)} ${v.toFixed(1).padStart(7)} ms   ${((v / worstFrame.ms) * 100).toFixed(0)}%`);
  }
  const accounted = items.reduce((n, [, v]) => n + v, 0);
  console.log(
    `    ${PAD('unaccounted', 20)} ${(worstFrame.ms - accounted).toFixed(1).padStart(7)} ms   ` +
      `${(((worstFrame.ms - accounted) / worstFrame.ms) * 100).toFixed(0)}%`
  );
}

/* ---- the browser's own account ------------------------------------------ */

/**
 * Long Animation Frames, aggregated by the script that ran.
 *
 * This is the section that answers the frames the counter table cannot. Where
 * the deltas above say "nothing I count changed", this says which function was
 * on the stack and for how long — and because it aggregates across every long
 * frame in every walk, a cause that fires repeatedly separates itself from one
 * that fired once.
 */
console.log(heading("the browser's own account of the long frames"));
const unsupported = runs.some((r) => !r.loafSupported);
if (unsupported) {
  console.log('  Long Animation Frames is not available in this browser — section skipped.');
} else {
  const all = runs.flatMap((r) => r.loaf ?? []);
  console.log(`  ${all.length} frames over 50 ms, across ${WALKS} walks\n`);
  if (!runs[0].heapSupported) {
    console.log('  (performance.memory is unavailable, so the GC row above is "not measured",');
    console.log('   not "did not happen".)\n');
  }
  /**
   * Grouped by function and source position rather than listed, because the
   * same line firing forty times is one finding and forty lines of output.
   */
  const byFn = new Map();
  for (const e of all) {
    for (const s of e.scripts) {
      const key = `${s.fn || s.invoker || '(anonymous)'} @ ${(s.source || '').split('/').pop()}:${s.at}`;
      const row = byFn.get(key) ?? { key, n: 0, total: 0, worst: 0, type: s.type, forced: 0 };
      row.n++;
      row.total += s.duration;
      row.forced += s.forced ?? 0;
      row.worst = Math.max(row.worst, s.duration);
      byFn.set(key, row);
    }
  }
  const ranked = [...byFn.values()].sort((a, b) => b.total - a.total);
  if (!ranked.length) {
    console.log('  No script attribution was recorded for these frames — the time went');
    console.log('  somewhere the page cannot see (driver, compositor, or another process).');
  }
  console.log(`${PAD('  script', 52)}${PAD('hits', 7)}${PAD('total', 10)}worst`);
  for (const r of ranked.slice(0, 12)) {
    console.log(
      PAD(`  ${r.key}`, 52) +
        PAD(String(r.n), 7) +
        PAD(`${r.total.toFixed(0)} ms`, 10) +
        `${r.worst.toFixed(1)} ms`
    );
  }
  /**
   * How much of each long frame the scripts actually account for. A large
   * shortfall means the time was spent between the last script and the frame
   * being presented — GPU work the browser waited on, or the compositor — and
   * that is a completely different investigation from a slow function.
   */
  const scripted = all.reduce((n, e) => n + e.scripts.reduce((m, s) => m + s.duration, 0), 0);
  const total = all.reduce((n, e) => n + e.duration, 0);
  console.log(
    `\n  scripts account for ${scripted.toFixed(0)} ms of ${total.toFixed(0)} ms ` +
      `(${((scripted / Math.max(1, total)) * 100).toFixed(0)}%) of long-frame time`
  );
  const styleLayout = all.reduce((n, e) => n + (e.styleAndLayout || 0), 0);
  console.log(`  style and layout: ${styleLayout.toFixed(0)} ms`);
  if (scripted / Math.max(1, total) < 0.5) {
    console.log('\n  Over half of it is NOT script. The frame was waiting — on the GPU, on');
    console.log('  the compositor, or on something outside the page entirely.');
  }
}

const path = `${PERF_DIR}/spikes-${SPEC.station}-${SPEC.level}.json`;
writeJson(path, {
  spec: SPEC,
  seconds: SECONDS,
  walks: WALKS,
  median: med,
  hitches: hitches.length,
  frames: frames.length,
  attribution,
  worst: hitches.sort((a, b) => b.ms - a.ms).slice(0, 40),
});
console.log(`\n${path}\n`);
