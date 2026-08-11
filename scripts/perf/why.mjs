import { LAYERS } from '../../src/dev/perf/stations.js';
import {
  boot,
  argv,
  heading,
  PAD,
  NUM,
  DEV_URL,
  PERF_BUILD_URL,
  PERF_DIR,
  writeJson,
} from './harness.mjs';
import { median, quantile, bootstrapCI, decisive, NOISE_FLOOR_MS } from './stats.mjs';

/**
 * WHY IS THIS FRAME SLOW — the bottleneck report.
 *
 *   npm run perf:why                      the worst frame in the game
 *   npm run perf:why -- --station=deep --level=peak
 *   npm run perf:why -- --only=layers     just one section
 *   npm run perf:why -- --reps=6          more repetitions, tighter intervals
 *
 * Four sections, in the order a person actually needs them:
 *
 *   1. WHAT KIND OF SLOW IS IT. Fill, vertex, or neither. Everything else in
 *      the report is only worth reading in the light of this answer, because
 *      the fix for a fill-bound frame and the fix for a vertex-bound one have
 *      nothing in common — and this frame is BOTH, at different moments of the
 *      same trip, which is exactly why guessing has gone wrong here before.
 *
 *   2. WHAT THE EXISTING LEVERS ARE WORTH TODAY. Each optimisation un-done, one
 *      at a time, from the shipping configuration outward.
 *
 *   3. WHAT EACH LAYER COSTS AT THE MARGIN. Which is not its share — see below.
 *
 *   4. DOES IT HITCH. Measured with the real loop running and the camera moving,
 *      because the hitch is caused by movement and no static benchmark can see
 *      it.
 *
 * Every comparison in sections 1-3 is a paired A-B-B-A difference with a
 * bootstrap interval, and anything whose interval straddles zero — or that is
 * smaller than this rig can resolve — is printed as "below the noise floor"
 * rather than as a number. A report that prints four decimal places for an
 * effect it cannot actually see is worse than one that says it does not know.
 */

const args = argv({ station: 'canopy', level: 'peak', reps: '4', only: 'all' });
const SPEC = { station: args.station, level: args.level };
const REPS = Number(args.reps);
const ONLY = args.only;
const want = (section) => ONLY === 'all' || ONLY === section;

const { browser, page, caps } = await boot({
  url: args.build === 'true' ? PERF_BUILD_URL : DEV_URL,
});

console.log(`station ${SPEC.station}, ${SPEC.level} — ${REPS} A-B-B-A repetitions per row\n`);

/** Run a paired comparison and reduce it to a verdict. */
function verdict(rows, { flip = false } = {}) {
  const deltas = rows.map((r) => (flip ? -r.delta : r.delta));
  const base = median(rows.map((r) => r.a));
  const ci = bootstrapCI(deltas);
  return {
    base,
    deltaMs: ci.median,
    lo: ci.lo,
    hi: ci.hi,
    pct: base ? (ci.median / base) * 100 : NaN,
    real: decisive(ci, base, { floorMs: NOISE_FLOOR_MS }),
    rows,
  };
}

function row(label, v, width = 30) {
  if (!v.real) {
    return PAD(label, width) + '        —        below the noise floor';
  }
  const sign = v.deltaMs >= 0 ? '+' : '';
  return (
    PAD(label, width) +
    `${sign}${v.deltaMs.toFixed(2)}`.padStart(8) +
    ' ms  ' +
    `${sign}${v.pct.toFixed(0)}%`.padStart(6) +
    `   [${v.lo.toFixed(2)}, ${v.hi.toFixed(2)}]`
  );
}

const report = { spec: SPEC, caps, sections: {} };

/* ---- 1. what kind of slow ------------------------------------------------ */

if (want('kind')) {
  console.log(heading('1. what kind of slow is it'));
  /**
   * Half the pixels, same everything else.
   *
   * 1/sqrt(2) in each axis is exactly half the fragments, which makes the
   * arithmetic below a subtraction rather than a fit. Model the frame as
   *
   *     cost = fixed + perPixel x pixels
   *
   * Two points determine both terms: at half the pixels the frame costs
   * `fixed + perPixel x P/2`, so the DIFFERENCE between the two measurements is
   * `perPixel x P/2` — double it and you have the whole resolution-dependent
   * part, and what is left over is everything that does not care how many
   * pixels there are. That residue is the vertex stage, the draw submission and
   * the shadow pass, and on this frame it has been most of the budget during a
   * trip: 14.85 M vertices each doing trilinear noise fetches does not get
   * cheaper when you shrink the window.
   *
   * The model is a straight line through two points and it is stated as such.
   * It does not separate vertex cost from CPU submission cost — both are
   * resolution-independent and both land in `fixed`. What it does do is answer
   * the only question that changes what you would try next, which is whether
   * turning the resolution down would help at all.
   */
  const rows = await page.evaluate(
    ([s, o]) => window.__RR_PERF__.rigPair(s, { ratio: Math.SQRT1_2 }, o),
    [SPEC, { reps: REPS }]
  );
  const full = median(rows.map((r) => r.a));
  const half = median(rows.map((r) => r.b));
  const perPixelPart = Math.max(0, (full - half) * 2);
  const fixedPart = Math.max(0, full - perPixelPart);
  const fillShare = full ? perPixelPart / full : NaN;
  console.log(`  full resolution        ${NUM(full, 7)} ms`);
  console.log(`  half the pixels        ${NUM(half, 7)} ms`);
  console.log(
    `  scales with pixels     ${NUM(perPixelPart, 7)} ms   ${(fillShare * 100).toFixed(0)}% of the frame`
  );
  console.log(
    `  does not               ${NUM(fixedPart, 7)} ms   ${((1 - fillShare) * 100).toFixed(0)}% — vertex stage, submission, shadow pass`
  );
  console.log(
    `\n  ${
      fillShare > 0.65
        ? 'FILL-BOUND. Resolution, overdraw and fragment-shader cost are the levers.'
        : fillShare < 0.35
          ? 'VERTEX-BOUND. Instance and vertex counts are the levers; render scale will not help.'
          : 'MIXED. Neither resolution nor geometry alone will move this much.'
    }`
  );
  report.sections.kind = { full, half, perPixelPart, fixedPart, fillShare };
}

/* ---- 2. the levers ------------------------------------------------------- */

if (want('levers')) {
  console.log(heading('2. what each optimisation is worth today'));
  console.log('  Each row moves ONE setting away from the shipping configuration.');
  console.log('  The number is that arm minus shipping: positive is what the change');
  console.log('  would cost you, negative is what it would save.\n');
  const levers = await page.evaluate(() => window.__RR_PERF__.levers);
  const out = [];
  for (const lever of levers) {
    const rows = await page.evaluate(
      ([n, s, o]) => window.__RR_PERF__.lever(n, s, o),
      [lever.name, SPEC, { reps: REPS }]
    );
    const v = verdict(rows);
    out.push({ ...lever, ...v });
    console.log(row(`  ${lever.name} → ${lever.b}`, v, 40));
    /**
     * A lever that moved the frame the wrong way is reported as such rather
     * than quietly printed with a minus sign. It means one of two things and
     * both are worth knowing: the measurement is broken, or the optimisation
     * is not one — and this project has already found one of the latter (the
     * ground layer, whose removal makes the frame slower because it is the
     * best early-Z occluder in the wood).
     */
    if (v.real && lever.direction === 'slower' && v.deltaMs < 0) {
      console.log(`  ${' '.repeat(38)}↑ un-doing this made the frame FASTER — see the note above`);
    }
    if (v.real && lever.direction === 'faster' && v.deltaMs > 0) {
      console.log(`  ${' '.repeat(38)}↑ switching this OFF made the frame SLOWER`);
    }
  }
  report.sections.levers = out;
}

/* ---- 3. the layers ------------------------------------------------------- */

if (want('layers')) {
  console.log(heading('3. what each layer costs at the margin'));
  console.log('  What HIDING it saves, given everything else is present.');
  console.log('  These do not sum to the frame and are not meant to: occlusion');
  console.log('  means a layer can be worth less than nothing to remove.\n');
  const out = [];
  for (const name of LAYERS) {
    let rows;
    try {
      rows = await page.evaluate(
        ([n, s, o]) => window.__RR_PERF__.layer(n, s, o),
        [name, SPEC, { reps: REPS }]
      );
    } catch (e) {
      console.log(PAD(`  ${name}`, 30) + `        —        ${e.message}`);
      continue;
    }
    /**
     * Flipped, so the column reads "what hiding it SAVES". The raw pair is
     * (visible, hidden) and hiding something makes the frame faster, so the raw
     * delta is negative for everything that costs anything — a table of
     * negative numbers under a heading that says "costs" is a misreading
     * waiting to happen.
     */
    const v = verdict(rows, { flip: true });
    out.push({ name, ...v });
    console.log(row(`  ${name}`, v));
  }
  /**
   * WHAT EACH LAYER IS MADE OF, next to what it costs.
   *
   * Milliseconds alone cannot tell a layer that is expensive because there is a
   * great deal of it from one that is expensive per triangle, and those have
   * completely different fixes — the first is a scatter, LOD or culling
   * problem, the second is a shader problem. `ms/Mtri` is the column that
   * separates them, and it is the one to sort by when deciding what to
   * optimise: a layer high on cost but low on ms/Mtri is doing nothing wrong
   * except existing in quantity.
   */
  const census = await page.evaluate(
    ([names, s]) => window.__RR_PERF__.layerCensus(names, s),
    [LAYERS, SPEC]
  );
  console.log(`\n  what each layer is made of (frame total: ${census.total.calls} draws, ${(census.total.triangles / 1e6).toFixed(2)}M tris)\n`);
  console.log(`${PAD('  layer', 16)}${PAD('draws', 8)}${PAD('triangles', 12)}${PAD('instances', 11)}${PAD('cost', 10)}ms/Mtri`);
  const withGeom = out
    .map((o) => ({ ...o, geom: census.layers[o.name] }))
    .filter((o) => o.geom && !o.geom.missing);
  for (const o of withGeom.sort((a, b) => (b.geom.triangles ?? 0) - (a.geom.triangles ?? 0))) {
    const tri = o.geom.triangles;
    const perM = o.real && tri > 0 ? (o.deltaMs / (tri / 1e6)).toFixed(2) : '—';
    console.log(
      PAD(`  ${o.name}`, 16) +
        PAD(String(o.geom.calls), 8) +
        PAD(tri >= 1e6 ? `${(tri / 1e6).toFixed(2)}M` : String(tri), 12) +
        PAD(String(o.geom.instances), 11) +
        PAD(o.real ? `${o.deltaMs.toFixed(2)} ms` : '—', 10) +
        perM
    );
  }
  report.sections.census = census;

  const negative = out.filter((o) => o.real && o.deltaMs < 0);
  if (negative.length) {
    console.log(
      `\n  Hiding these made the frame SLOWER: ${negative.map((n) => n.name).join(', ')}.`
    );
    console.log('  They are paying for themselves as occluders — the depth they write');
    console.log('  is rejecting more fragments than they cost to draw.');
  }
  report.sections.layers = out;
}

/* ---- 4. does it hitch ---------------------------------------------------- */

if (want('hitch')) {
  console.log(heading('4. frame-time stability, with the world running'));
  const walk = await page.evaluate(
    ([s]) => window.__RR_PERF__.walk({ seconds: 8, station: s.station, level: s.level }),
    [SPEC]
  );
  const iv = walk.intervals.filter((v) => Number.isFinite(v) && v > 0);
  const prologue = walk.prologue.filter((v) => Number.isFinite(v) && v > 0);
  const med = median(iv);
  /**
   * A hitch is relative to this machine's own median, not an absolute
   * millisecond figure. 16.7 ms is a dropped frame on a 60 Hz display and a
   * catastrophe on a 144 Hz one, and a threshold that means different things on
   * different monitors cannot be compared across them. Twice the median is a
   * frame that took the place of two.
   */
  const hitches = iv.filter((v) => v > med * 2);
  const uploaded = walk.uploaded.filter((r) => r > 0);
  console.log(`  frames            ${iv.length}`);
  console.log(`  median            ${NUM(med, 7)} ms`);
  console.log(`  p95 / p99         ${NUM(quantile(iv, 0.95), 7)} / ${NUM(quantile(iv, 0.99), 7)} ms`);
  console.log(`  worst             ${NUM(Math.max(...iv), 7)} ms  (×${(Math.max(...iv) / med).toFixed(1)} the median)`);
  console.log(
    `  hitches >2× med   ${hitches.length}  (${((hitches.length / iv.length) * 100).toFixed(2)}% of frames)`
  );
  console.log(
    `  packer load       median ${median(uploaded).toFixed(0)}, ` +
      `p99 ${quantile(uploaded, 0.99).toFixed(0)} instances re-uploaded by the last repack`
  );
  /**
   * The half-second after the loop is handed back, kept visible. It contains
   * the first repack after a teleport and any program compiled for a layer that
   * was hidden while the rig was measuring, so it is not a fair sample of
   * walking around — but a hitch detector that quietly drops its worst frames
   * is not a hitch detector, so it is printed rather than deleted.
   */
  console.log(
    `\n  resume transient  ${prologue.length} frames before the walk was sampled, ` +
      `worst ${NUM(Math.max(...prologue, 0), 6)} ms`
  );
  console.log('  (the loop restarting and the first repack after a teleport — not a walking frame)');
  report.sections.hitch = {
    frames: iv.length,
    median: med,
    p95: quantile(iv, 0.95),
    p99: quantile(iv, 0.99),
    worst: Math.max(...iv),
    hitches: hitches.length,
    uploadedMedian: median(uploaded),
    prologueWorst: Math.max(...prologue, 0),
  };
}

await browser.close();

const path = `${PERF_DIR}/why-${SPEC.station}-${SPEC.level}.json`;
writeJson(path, report);
console.log(`\n${path}\n`);
