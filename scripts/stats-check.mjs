import { chromium } from 'playwright';

/**
 * DOES THE FPS OVERLAY ACTUALLY DRAW A FREEZE.
 *
 *   node scripts/stats-check.mjs
 *
 * This file exists because `src/ui/stats.js` has now hidden a stall from the
 * person watching it three times, by three unrelated mechanisms, and every time
 * the report that found it was a human saying "it froze and the graph never
 * moved".
 *
 *   1. A `dt > 250 ms` guard threw the sample away before it reached the graph.
 *   2. The scroll loop reset its bucket once per COLUMN rather than once per
 *      call, so every column after the first that a long frame owed was plotted
 *      as `Infinity` — the top of the graph, in the green of a healthy frame.
 *      A 400 ms freeze drew a one-pixel notch and then nine pixels of flawless
 *      framerate.
 *   3. `realMs > MAX_PLOTTABLE_MS` dropped any interval over 2 s outright, on
 *      the stated grounds that no real frame could be that slow. A 2500 ms
 *      freeze therefore drew NOTHING — not a notch, not a colour change — and
 *      `max ms` and the two lows never heard about it either. This check passed
 *      the whole time it was true, because 400 ms is under 2 s: that is why the
 *      freeze here is now driven at several durations rather than one, with the
 *      longest of them deliberately past where that filter used to sit.
 *
 * All three were invisible to every other check in this repo, and all three
 * would have been caught by the same few lines: drive the panel with a real long
 * frame and LOOK AT THE PIXELS it drew. So that is what this does — the counters
 * are read only where the drawing cannot answer (the freeze badge's text), because
 * in all three bugs the counters were right and the drawing was wrong.
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

/** ms of the deliberate freeze in the main case. Long enough to owe several columns. */
const FREEZE_MS = 400;
/**
 * ...and past the 2 s filter that used to swallow a freeze whole. Bug 3 above,
 * and the reason a single duration is not enough coverage for this panel.
 */
const LONG_FREEZE_MS = 2500;
/** The threshold case: FREEZE_MS in ui/stats.js, the shortest hitch that must be marked, not just dipped. */
const ALERT_MS = 150;
/** Longer than MAX_FREEZE_COLUMNS is willing to scroll for, so the cap is exercised. */
const MONSTER_MS = 5000;
/** ms of the healthy frames on either side of it. */
const GOOD_MS = 8;
/** Columns one frame may commit — MAX_FREEZE_COLUMNS in ui/stats.js, duplicated for the same reason PX_PER_SECOND is below. */
const MAX_FREEZE_COLUMNS = 90;

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

const phases = await page.evaluate(
  async ([durations, goodMs, fullFillMs, shortFillMs]) => {
    const { StatsPanel } = await import('/src/ui/stats.js');

    /** Busy-wait, because the point is to make one frame genuinely take this long. */
    const spin = (ms) => {
      const t0 = performance.now();
      while (performance.now() - t0 < ms);
    };

    /**
     * One freeze, driven through a panel of its own.
     *
     * A FRESH PANEL PER DURATION. `max ms` and the two lows come off a ring over
     * the whole session, so once a 2500 ms sample is in one, a later phase asking
     * "did MY freeze reach the counters" cannot tell its own answer from the
     * previous phase's. A panel is two DOM nodes and a canvas; a shared one would
     * cost the only assertion that catches bug 3.
     */
    const probe = (freezeMs, fillMs) => {
      const panel = new StatsPanel();
      panel.setVisible(true);

      const canvas = panel._canvas;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const W = canvas.width;
      const H = canvas.height;

      /**
       * TWO READINGS PER DEVICE COLUMN.
       *
       * `lowest` is the lowest point of the drawn trace, as a fraction of the
       * graph's height: 0 is the ceiling (MAX_FPS or better), 1 is the floor
       * (stopped), `null` where nothing was drawn. The background is #0c0f0e and
       * the 60 fps reference tick is white at 0.16 over it, which lands at 53;
       * every trace colour is above 100 in at least one channel. So a single
       * brightness threshold separates the line from both without having to know
       * which of the three colours it used.
       *
       * `banded` is whether the column carries the freeze band, read at row 0 —
       * the top of the graph, where a healthy frame's trace can also sit (8 ms is
       * over MAX_FPS and pins there). The band is the only red-DOMINANT thing the
       * panel draws: the healthy green is #7fd8a0, more green than red, and the
       * amber #e0c060 likewise. Hence the ratio test rather than a brightness one.
       */
      const read = () => {
        const d = ctx.getImageData(0, 0, W, H).data;
        const lowest = [];
        const banded = [];
        for (let x = 0; x < W; x++) {
          let low = null;
          for (let y = 0; y < H; y++) {
            const i = (y * W + x) * 4;
            if (Math.max(d[i], d[i + 1], d[i + 2]) > 90) low = y;
          }
          lowest.push(low === null ? null : low / (H - 1));
          const top = x * 4;
          banded.push(d[top] > 90 && d[top] > d[top + 1] * 2);
        }
        return { lowest, banded };
      };

      // Fill the graph with healthy frames first, so anything still at the
      // ceiling afterwards got there on purpose rather than by never being drawn.
      for (let i = 0; i < Math.ceil(fillMs / goodMs); i++) {
        spin(goodMs);
        panel.update(0);
      }
      const healthy = read();
      /** The control for the alarm: healthy frames must not have lit any of it. */
      const badgeBefore = { hidden: panel._freezeEl.hidden, count: panel._freezeCount };

      spin(freezeMs);
      panel.update(0);
      const frozen = read();

      const badge = {
        hidden: panel._freezeEl.hidden,
        text: panel._freezeEl.textContent,
        hot: panel._freezeEl.classList.contains('hot'),
        panelLit: panel.el.classList.contains('froze'),
        count: panel._freezeCount,
      };

      panel.el.remove();
      return {
        freezeMs,
        healthy,
        frozen,
        badge,
        badgeBefore,
        dpr: panel._dpr,
        width: W,
        height: H,
        maxMs: panel._maxMs,
      };
    };

    const out = [];
    for (let i = 0; i < durations.length; i++) {
      // Only the first case needs a full graph of history behind it; the rest
      // assert about the freeze's own columns and the ones just left of them.
      out.push(probe(durations[i], i === 0 ? fullFillMs : shortFillMs));
      // Let the page breathe between phases: each one blocks the main thread for
      // its whole duration, and a browser held for half a minute without a single
      // task boundary is a different experiment from the one being run.
      await new Promise((res) => setTimeout(res, 0));
    }
    return out;
  },
  [[FREEZE_MS, LONG_FREEZE_MS, ALERT_MS, MONSTER_MS], GOOD_MS, 9000, 2500]
);
await browser.close();

/**
 * How many columns that freeze is worth. SECONDS_VISIBLE / GRAPH_W in stats.js
 * is 8 s across 180 CSS px, so 22.5 CSS px a second — duplicated here as a
 * number rather than imported, because the test should fail if somebody changes
 * the scroll rate without thinking about what it does to a freeze's width.
 */
const PX_PER_SECOND = 180 / 8;

console.log(`  graph          ${phases[0].width}x${phases[0].height} device px, dpr ${phases[0].dpr}`);

for (const phase of phases) {
  const { freezeMs, dpr, width } = phase;
  const uncapped = Math.floor((freezeMs / 1000) * PX_PER_SECOND);
  const owed = Math.min(uncapped, MAX_FREEZE_COLUMNS);
  const columns = owed * dpr;
  const tail = phase.frozen.lowest.slice(width - columns);
  const drawn = tail.filter((v) => v !== null);
  /** In the bottom quarter of the graph: under 30 fps on a 120 fps axis. */
  const low = drawn.filter((v) => v > 0.75).length;
  /** Pinned to the ceiling — what bug 2 drew, and what a healthy frame draws. */
  const pinned = drawn.filter((v) => v < 0.1).length;
  const banded = phase.frozen.banded.slice(width - columns).filter(Boolean).length;
  /**
   * Two-thirds rather than all of them: the first column a long frame commits
   * also carries whatever healthy frames preceded it in the same bucket, and the
   * boundary column can legitimately land either side. Bug 2 put EIGHT of nine at
   * the ceiling and bug 3 drew none of them at all, so there is no ambiguity
   * about which side of this a regression falls on.
   */
  const most = Math.ceil(columns * 0.66);

  console.log(
    `\n  ${freezeMs} ms freeze — owes ${uncapped} columns, may draw ${owed}; ` +
      `of ${drawn.length} drawn: ${low} at the floor, ${pinned} at the ceiling, ${banded} banded`
  );
  console.log(`  max ms ${phase.maxMs.toFixed(0)}    badge "${phase.badge.text}"`);

  if (drawn.length < columns) {
    problems.push(`${freezeMs} ms: only ${drawn.length} of ${columns} columns were drawn at all`);
  }
  if (low < most) {
    problems.push(
      `${freezeMs} ms: only ${low} of ${columns} columns drew as a drop — ` +
        'the dip is not as wide as the freeze was long'
    );
  }
  if (pinned > 0) {
    problems.push(
      `${freezeMs} ms: ${pinned} of the freeze's own columns are pinned to the top of the graph — ` +
        'this is the `Infinity` bucket bug: a stall drawing as perfect framerate'
    );
  }
  if (banded < most) {
    problems.push(
      `${freezeMs} ms: only ${banded} of ${columns} freeze columns carry the alert band — ` +
        'a freeze over FREEZE_MS is supposed to be unmissable, not a two-pixel notch'
    );
  }
  /** The controls: before the freeze, nothing near the floor and no alarm anywhere. */
  const healthyLow = phase.healthy.lowest.filter((v) => v !== null && v > 0.75).length;
  if (healthyLow > 0) {
    problems.push(
      `${freezeMs} ms: ${healthyLow} columns of ${GOOD_MS} ms frames drew as a drop — ` +
        'the graph is reading something other than the frame time'
    );
  }
  const healthyBands = phase.healthy.banded.filter(Boolean).length;
  if (healthyBands > 0) {
    problems.push(`${freezeMs} ms: ${healthyBands} columns of ${GOOD_MS} ms frames were banded as freezes`);
  }
  if (!phase.badgeBefore.hidden || phase.badgeBefore.count !== 0) {
    problems.push(`${freezeMs} ms: the freeze badge was already showing before anything froze`);
  }
  /**
   * The readouts, and the assertion bug 3 turned on: a dropped sample left
   * `max ms` reporting the healthiest frame in the session across a 2.5 s stop.
   */
  if (phase.maxMs < freezeMs * 0.9) {
    problems.push(`${freezeMs} ms: max ms reads only ${phase.maxMs.toFixed(0)} — the sample never reached the counters`);
  }
  if (phase.badge.hidden || !phase.badge.hot || !phase.badge.panelLit || phase.badge.count !== 1) {
    problems.push(`${freezeMs} ms: the freeze was not called out in words (${JSON.stringify(phase.badge)})`);
  }
  /**
   * The number in the badge is the frame that was actually measured, not the one
   * that was asked for — a busy-wait overshoots by however long the update after
   * it took — so this is a range, and a wide one on the short case where a
   * millisecond of overshoot is a percent of the total.
   */
  const named = Number(phase.badge.text.replace(/[^0-9.]/g, ''));
  if (!phase.badge.text.startsWith('FROZE') || !(named >= freezeMs * 0.9 && named <= freezeMs * 1.5 + 20)) {
    problems.push(`${freezeMs} ms: the badge reads "${phase.badge.text}", which does not name the frame`);
  }
}

/**
 * ...and the cap, checked on the longest case: a freeze may take at most half the
 * graph, because a solid wall of red with no "before" left on it is a picture of
 * nothing. The monster case owes 112 columns and is allowed 90.
 */
const monster = phases[phases.length - 1];
const allBanded = monster.frozen.banded.filter(Boolean).length;
const survived = monster.frozen.lowest.filter((v, x) => v !== null && !monster.frozen.banded[x]).length;
console.log(`\n  ${monster.freezeMs} ms freeze — ${allBanded} banded columns, ${survived} columns of history left`);
if (allBanded > MAX_FREEZE_COLUMNS * monster.dpr) {
  problems.push(`a ${monster.freezeMs} ms freeze banded ${allBanded} columns, past the ${MAX_FREEZE_COLUMNS}-column cap`);
}
if (survived === 0) {
  problems.push(`a ${monster.freezeMs} ms freeze scrolled every healthy sample off the graph`);
}

if (problems.length) {
  console.error(`\nFAIL\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
  process.exit(1);
}
console.log('\nPASS  a freeze of any length draws as a dip whose width tracks its duration, is banded, and is named.\n');
