import { chromium } from 'playwright';

/**
 * DOES THE FPS OVERLAY ACTUALLY DRAW A FREEZE.
 *
 *   node scripts/stats-check.mjs
 *
 * This file exists because `src/ui/stats.js` has now hidden a stall from the
 * person watching it twice, by two unrelated mechanisms, and both times the
 * report that found it was a human saying "it froze and the graph never moved".
 *
 *   1. A `dt > 250 ms` guard threw the sample away before it reached the graph.
 *   2. The scroll loop reset its bucket once per COLUMN rather than once per
 *      call, so every column after the first that a long frame owed was plotted
 *      as `Infinity` — the top of the graph, in the green of a healthy frame.
 *      A 400 ms freeze drew a one-pixel notch and then nine pixels of flawless
 *      framerate.
 *
 * Both were invisible to every other check in this repo, and both would have
 * been caught by the same three lines: drive the panel with a real long frame
 * and LOOK AT THE PIXELS it drew. So that is what this does — no reading of
 * internal counters, because in both bugs the counters were right and the
 * drawing was wrong.
 *
 * WHY A FRESH `StatsPanel` RATHER THAN `RR.stats`.
 *
 * The live one is being called by the game's own rAF loop several hundred times
 * a second, and every one of those calls commits columns of its own between the
 * test's. Constructing one is two DOM nodes and a canvas; it runs the same
 * source, which is the thing under test. (This is the one case where the
 * "importing a module in a test gets you a second copy" trap documented on
 * `RR.tripUniforms` is not a trap: a second copy is exactly what is wanted, and
 * nothing here reads live state.)
 */

const URL = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://127.0.0.1:5180/';

/** ms of the deliberate freeze. Long enough to owe several columns, short enough to stay under MAX_PLOTTABLE_MS. */
const FREEZE_MS = 400;
/** ms of the healthy frames on either side of it. */
const GOOD_MS = 8;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.routeWebSocket(/.*/, () => {});

const problems = [];
page.on('pageerror', (e) => problems.push(`PAGEERROR ${e.message}`));

try {
  await page.goto(URL, { waitUntil: 'load', timeout: 20000 });
} catch {
  console.error(
    `Nothing is serving ${URL}. Start the dev server first:\n  npm run dev`
  );
  await browser.close();
  process.exit(1);
}
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });

const result = await page.evaluate(
  async ([freezeMs, goodMs]) => {
    const { StatsPanel } = await import('/src/ui/stats.js');
    const panel = new StatsPanel();
    panel.setVisible(true);

    const canvas = panel._canvas;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const dpr = panel._dpr;
    const W = canvas.width;
    const H = canvas.height;

    /** Busy-wait, because the point is to make one frame genuinely take this long. */
    const spin = (ms) => {
      const t0 = performance.now();
      while (performance.now() - t0 < ms);
    };

    /**
     * The lowest point of the drawn trace in each device column, as a fraction
     * of the graph's height: 0 is the ceiling (MAX_FPS or better), 1 is the
     * floor (stopped). `null` where nothing was drawn.
     *
     * The background is #0c0f0e and the 60 fps reference tick is white at 0.16
     * over it, which lands at 53; every trace colour is above 100 in at least
     * one channel. So a single brightness threshold separates the line from both
     * without having to know which of the three colours it used.
     */
    const trace = () => {
      const d = ctx.getImageData(0, 0, W, H).data;
      const out = [];
      for (let x = 0; x < W; x++) {
        let lowest = null;
        for (let y = 0; y < H; y++) {
          const i = (y * W + x) * 4;
          if (Math.max(d[i], d[i + 1], d[i + 2]) > 90) lowest = y;
        }
        out.push(lowest === null ? null : lowest / (H - 1));
      }
      return out;
    };

    // Fill the whole graph with healthy frames first, so anything still at the
    // ceiling afterwards got there on purpose rather than by never being drawn.
    for (let i = 0; i < Math.ceil(9000 / goodMs); i++) {
      spin(goodMs);
      panel.update(0);
    }
    const healthy = trace();

    spin(freezeMs);
    panel.update(0);
    const frozen = trace();

    panel.el.remove();
    return { healthy, frozen, dpr, width: W, height: H, maxMs: panel._maxMs };
  },
  [FREEZE_MS, GOOD_MS]
);
await browser.close();

/**
 * How many columns that freeze is worth. SECONDS_VISIBLE / GRAPH_W in stats.js
 * is 8 s across 180 CSS px, so 22.5 CSS px a second — duplicated here as a
 * number rather than imported, because the test should fail if somebody changes
 * the scroll rate without thinking about what it does to a freeze's width.
 */
const PX_PER_SECOND = 180 / 8;
const owed = Math.floor((FREEZE_MS / 1000) * PX_PER_SECOND);
const columns = owed * result.dpr;
const tail = result.frozen.slice(result.width - columns);
const drawn = tail.filter((v) => v !== null);
/** In the bottom quarter of the graph: under 30 fps on a 120 fps axis. */
const low = drawn.filter((v) => v > 0.75).length;
/** Pinned to the ceiling — what the bug drew, and what a healthy frame draws. */
const pinned = drawn.filter((v) => v < 0.1).length;

console.log(`  graph          ${result.width}x${result.height} device px, dpr ${result.dpr}`);
console.log(`  a ${FREEZE_MS} ms frame owes ${owed} CSS columns (${columns} device px)`);
console.log(`  of the ${drawn.length} drawn: ${low} in the bottom quarter, ${pinned} pinned to the ceiling`);
console.log(`  panel's own max ms readout: ${result.maxMs.toFixed(0)} ms`);

if (drawn.length < columns) {
  problems.push(`only ${drawn.length} of ${columns} columns were drawn at all`);
}
/**
 * Two-thirds rather than all of them: the first column a long frame commits
 * also carries whatever healthy frames preceded it in the same bucket, and the
 * boundary column can legitimately land either side. The bug put EIGHT of nine
 * at the ceiling, so there is no ambiguity about which side of this a
 * regression falls on.
 */
if (low < Math.ceil(columns * 0.66)) {
  problems.push(
    `a ${FREEZE_MS} ms freeze drew only ${low} of ${columns} columns as a drop — ` +
      'the dip is not as wide as the freeze was long'
  );
}
if (pinned > 0) {
  problems.push(
    `${pinned} of the freeze's own columns are pinned to the top of the graph — ` +
      'this is the `Infinity` bucket bug: a stall drawing as perfect framerate'
  );
}
/** The control: before the freeze, none of it should be near the floor. */
const healthyLow = result.healthy.filter((v) => v !== null && v > 0.75).length;
if (healthyLow > 0) {
  problems.push(`${healthyLow} columns of ${GOOD_MS} ms frames drew as a drop — the graph is reading something other than the frame time`);
}
if (result.maxMs < FREEZE_MS * 0.9) {
  problems.push(`max ms reads ${result.maxMs.toFixed(0)} after a ${FREEZE_MS} ms frame`);
}

if (problems.length) {
  console.error(`\nFAIL\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
  process.exit(1);
}
console.log('\nPASS  a freeze draws as a dip whose width tracks its duration.\n');
