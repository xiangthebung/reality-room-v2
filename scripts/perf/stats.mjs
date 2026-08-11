/**
 * The statistics, kept in one file and away from the measuring.
 *
 * Deciding what the middle of a distribution is is a judgement, and judgements
 * belong somewhere they can be read, argued with and re-applied to a stored run
 * without going back to the GPU. Every function here is pure and takes arrays
 * of numbers; nothing in here knows what a frame is.
 *
 *
 * WHY MEDIAN AND MAD RATHER THAN MEAN AND STANDARD DEVIATION.
 *
 * Frame-time samples on a desktop are not normal and are not symmetric. They
 * have a hard floor — the frame cannot cost less than it costs — and an
 * unbounded tail made of everything else that wanted the GPU. A mean is dragged
 * by that tail, a standard deviation is dragged by its square, and the result is
 * a benchmark whose "noise" figure is dominated by whether a browser tab
 * somewhere decided to animate something. The median sits on the floor where
 * the signal is, and the MAD describes the spread without being a hostage to
 * one bad batch.
 */

export function median(xs) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function quantile(xs, p) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const i = (v.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
}

/**
 * Median absolute deviation, scaled to be comparable with a standard deviation
 * on data that happens to be normal. The 1.4826 is that scaling and nothing
 * more; it is included so that a reader who knows what a sigma looks like can
 * read this number without converting it in their head.
 */
export function mad(xs) {
  const m = median(xs);
  return 1.4826 * median(xs.filter(Number.isFinite).map((x) => Math.abs(x - m)));
}

/** Everything worth knowing about one scenario's batches, in one object. */
export function summarise(batches) {
  const v = batches.filter(Number.isFinite);
  const m = median(v);
  return {
    n: v.length,
    median: m,
    mad: mad(v),
    min: v.length ? Math.min(...v) : NaN,
    max: v.length ? Math.max(...v) : NaN,
    /** Spread as a fraction of the middle — the number to judge a run's quality by. */
    rsd: m ? mad(v) / m : NaN,
  };
}

/**
 * A percentile bootstrap confidence interval for the median of paired
 * differences.
 *
 * WHY BOOTSTRAP AND NOT A t-TEST. There are four to eight pairs. Nothing about
 * them is normal, and a t-interval on eight non-normal points is a decoration
 * rather than a statement. Resampling the pairs makes no distributional
 * assumption at all, and with this few points it is honest about how little it
 * knows — which is the useful behaviour, because the alternative is a
 * confident-looking interval around a number that moves every time you run it.
 *
 * WHY THE PAIRS AND NOT THE RAW TIMES. The pairing is the entire defence
 * against drift: within one A-B-B-A quadruple both arms saw the same GPU clock,
 * the same background load and the same thermal state, so the DIFFERENCE is
 * stable even when neither absolute is. Resampling raw times would throw that
 * away and hand back an interval several times too wide.
 *
 * Deterministic by construction — a fixed-seed generator rather than
 * Math.random — so that re-running the report on a stored run cannot change its
 * conclusions. A regression gate that flickers is a regression gate that gets
 * switched off.
 */
export function bootstrapCI(deltas, { iterations = 4000, alpha = 0.05, seed = 0x5eed } = {}) {
  const v = deltas.filter(Number.isFinite);
  if (v.length < 2) return { lo: NaN, hi: NaN, median: median(v) };
  let s = seed >>> 0;
  const rand = () => {
    // xorshift32 — small, fast, and identical on every machine.
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  const draws = new Array(iterations);
  const pick = new Array(v.length);
  for (let i = 0; i < iterations; i++) {
    for (let j = 0; j < v.length; j++) pick[j] = v[(rand() * v.length) | 0];
    draws[i] = median(pick);
  }
  return {
    median: median(v),
    lo: quantile(draws, alpha / 2),
    hi: quantile(draws, 1 - alpha / 2),
  };
}

/**
 * Does this paired difference clear the bar for being called a real difference?
 *
 * Two tests, and BOTH must pass, because they fail in different ways:
 *
 *   The interval must not straddle zero. This is the statistical test and on
 *   its own it is not enough — with enough repetitions a 0.02 ms difference
 *   becomes "significant", and 0.02 ms is not a finding, it is a fact about how
 *   long the run was.
 *
 *   The effect must be larger than `floorMs` AND larger than `floorFraction` of
 *   the baseline arm. This is the practical test. The floor is set from what
 *   this rig can actually resolve rather than from taste — see NOISE_FLOOR_MS.
 */
export function decisive(ci, baseMs, { floorMs = 0.05, floorFraction = 0.01 } = {}) {
  if (!Number.isFinite(ci.lo) || !Number.isFinite(ci.hi)) return false;
  if (ci.lo <= 0 && ci.hi >= 0) return false;
  const size = Math.abs(ci.median);
  return size >= floorMs && size >= Math.abs(baseMs) * floorFraction;
}

/**
 * The smallest difference this rig is willing to call real, in milliseconds.
 *
 * Not a guess: three runs of identical code on the development machine gave
 * 3.84, 6.36 and 4.46 ms for the same frame. The pairing removes most of that,
 * but nothing removes all of it, and a framework that reports 0.03 ms effects
 * will spend its life reporting them. Anything under this is printed as "below
 * the noise floor" rather than as a number, which is a more truthful thing to
 * put in front of a person than four decimal places.
 */
export const NOISE_FLOOR_MS = 0.05;

/**
 * Express every scenario as a multiple of the RUN LEVEL — the median cost of
 * all scenarios measured in the same session.
 *
 * THIS IS THE PART THAT MAKES A REGRESSION GATE POSSIBLE AT ALL.
 *
 * Absolute milliseconds are not comparable across days. They move with the GPU
 * clock, the driver, the ambient temperature and whatever else is running — the
 * ±40% spread quoted above is between runs of *identical* code minutes apart. A
 * gate on absolutes would either be so wide it catches nothing or so tight it
 * fires constantly, and the second kind gets disabled within a week.
 *
 * A ratio between workloads measured in the same session divides all of that
 * out. If the whole machine is 30% slow today, every scenario is 30% slow, and
 * every ratio is unchanged.
 *
 *
 * WHY THE MEDIAN OF ALL OF THEM AND NOT ONE NOMINATED REFERENCE SCENARIO.
 *
 * Because a single reference puts its own noise into every other row, and that
 * is not hypothetical — it is how this function was written first, and the
 * first cross-build run exposed it immediately. Moving from the dev server to
 * the production bundle left the canopy scenarios at ×1.00 of their recorded
 * absolute and moved the reference scenario, the clearing, by ×1.28. Every
 * other row was then reported as 21% FASTER, unanimously and confidently, on a
 * build where almost nothing had changed. The one number every row depended on
 * had moved, so every row was wrong.
 *
 * A median over nine scenarios needs five of them to move before it does. That
 * turns "the denominator moved" from a single point of failure into something
 * that can only happen when the frame really has changed everywhere — which is
 * a finding rather than an artefact.
 *
 * What a ratio still cannot see is a change that makes everything slower by the
 * same factor: the level moves with it and every ratio holds. That blind spot
 * is the price of being immune to drift, it is not fixable from inside this
 * function, and it is why the absolutes are still recorded and printed on every
 * run even though nothing is gated on them.
 */
export function normalise(scenarios) {
  const each = scenarios.map((s) => ({ ...s, ms: median(s.batches) }));
  const level = median(each.map((s) => s.ms));
  return { level, scenarios: each.map((s) => ({ ...s, ratio: level ? s.ms / level : NaN })) };
}
