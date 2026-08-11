import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { median } from './stats.mjs';

/**
 * Getting a browser into a state where a measurement means something.
 *
 * Shared by every script in this directory so there is exactly one answer to
 * "how do you boot the game for measurement" — the alternative, which this
 * project already has thirty-eight examples of, is that each script grows its
 * own slightly different launch flags and slightly different idea of when the
 * page is ready, and two scripts that disagree about that produce two numbers
 * that cannot be compared.
 */

export const DEV_URL = 'http://127.0.0.1:5180/';
export const PERF_BUILD_URL = 'http://127.0.0.1:5182/';
export const PERF_DIR = '.perf';

export function argv(defaults = {}) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v = 'true'] = a.replace(/^--/, '').split('=');
      return [k, v];
    })
  );
  return { ...defaults, ...args };
}

/**
 * Launch flags.
 *
 * `--use-angle=default` rather than SwiftShader: several of the older scripts
 * in scripts/ pass `--enable-unsafe-swiftshader`, which is right for them
 * because they compare PIXELS and a software rasteriser is perfectly
 * reproducible. It is exactly wrong here. Timing a software renderer measures
 * the CPU's ability to pretend to be a GPU, and its cost model has nothing in
 * common with the hardware's — a change that helps the real GPU can easily hurt
 * it. If there is no hardware context, this rig refuses to run rather than
 * quietly measuring the wrong machine.
 *
 * `--disable-frame-rate-limit` and `--disable-gpu-vsync` matter for `walk`,
 * which is the one measurement taken through the real rAF loop: with vsync on,
 * every interval is quantised to the display period and the tail this is trying
 * to see is rounded away.
 */
const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=default',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
  '--autoplay-policy=no-user-gesture-required',
];

/**
 * Boot the game and hand back a page whose instrument is installed and ready.
 *
 * Throws with a plain explanation rather than timing out, for each of the three
 * ways this can legitimately fail: no server, no instrument in the build, no
 * hardware timer. Each of those has a different fix and a bare timeout points
 * at none of them.
 */
export async function boot({
  url = DEV_URL,
  quiet = false,
  vsync = false,
  headed = false,
  /**
   * `enter: false` HANDS BACK A PAGE STILL SITTING AT THE MENU, which every
   * other caller here would consider a broken boot and `scripts/perf/gate.mjs`
   * considers the entire subject.
   *
   * The gate is a screen the player looks at for as long as they take to type a
   * name, and what the frame loop is doing underneath it is a measurement in its
   * own right. Skipping the click also skips the caps report and the settle
   * wait: there is no settled world yet, and saying so would be a lie.
   */
  enter = true,
} = {}) {
  /**
   * `vsync: true` PUTS THE TWO FRAME-RATE FLAGS BACK, and it is not a stylistic
   * option — it is the difference between two questions.
   *
   * Uncapped is right for anything comparing one build against another: it is
   * the only way to see headroom at all. It is wrong for asking whether a
   * PLAYER would feel a hitch, because a page rendering at 500 fps hands the
   * driver frames faster than it can retire them, and the queue backing up
   * produces long blocking frames that no player with vsync on would ever see.
   * A hitch hunt run uncapped will therefore find hitches whether or not the
   * game has any. Presented as a flag rather than a default so that every
   * existing caller keeps the flags it was calibrated with.
   */
  const args = vsync
    ? LAUNCH_ARGS.filter((a) => a !== '--disable-gpu-vsync' && a !== '--disable-frame-rate-limit')
    : LAUNCH_ARGS;
  /**
   * `headed: true` MATTERS WHENEVER `vsync` DOES, and the two are separate
   * flags because forgetting the second one quietly invalidates the first.
   *
   * Headless Chromium has no display to synchronise to, so it paces rAF from a
   * simulated 60 Hz clock whatever the real monitor does. A run that sets
   * `vsync` and stays headless is therefore not measuring this machine's frame
   * budget, it is measuring a 16.7 ms one — which on a 144 or 240 Hz panel is
   * two to four times more headroom than the player actually has, and headroom
   * is exactly what decides whether the adaptive controllers ever engage.
   */
  const browser = await chromium.launch({ args, headless: !headed });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  /**
   * DEAFEN THE PAGE TO HOT RELOADS BEFORE IT LOADS.
   *
   * Every caller of `boot` measures for tens of seconds, and the default url is
   * the dev server — so a save landing mid-run re-evaluates modules underneath
   * a benchmark and the result is a frame-time cliff that reads as a
   * regression. Silent, because a reloaded page has no console problems. Doing
   * it here covers bench, why and every future caller at once; on an
   * instrumented build (`perf:serve`) there is no socket to block and this
   * costs nothing. Same guard as play-check.mjs, which documents what it cost.
   */
  await page.routeWebSocket(/.*/, () => {});

  const fail = async (message) => {
    await browser.close();
    throw new Error(message);
  };

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  } catch {
    await fail(
      `Nothing is serving ${url}.\n` +
        `  dev build:  npm run dev        (then npm run perf:bench)\n` +
        `  perf build: npm run perf:serve (then npm run perf:bench -- --build)`
    );
  }

  await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
  /**
   * The instrument's own handshake, separate from `window.RR`.
   *
   * `RR` exists in every build; `__RR_PERF__` exists only where the instrument
   * was compiled in. Waiting on the second one is what turns "you are pointed
   * at a shipping build" from a 45-second silence into a sentence.
   */
  const instrumented = await page
    .waitForFunction(() => window.__RR_PERF__ !== undefined, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  if (!instrumented) {
    await fail(
      `${url} is serving a build with no performance instrument in it.\n` +
        `That is the correct state for a shipping build — see check:perfstrip.\n` +
        `Measure the dev server (npm run dev) or an instrumented build (npm run perf:serve).`
    );
  }

  if (!enter) return { browser, page, caps: await page.evaluate(() => window.__RR_PERF__.caps()) };

  await page.click('#enter');
  /**
   * The gate does not come down until the terrain has settled and every shader
   * program has been compiled — main.js waits for both before it fades. So
   * waiting for the gate is waiting for a world that is fully streamed and
   * fully warm, which is exactly the precondition every measurement here needs
   * and is far more honest than a fixed sleep. Bounded, because a machine that
   * never finishes should say so rather than hang.
   */
  await page
    .waitForFunction(() => document.getElementById('gate')?.classList.contains('gone'), null, {
      timeout: 90000,
    })
    .catch(() => {});

  const caps = await page.evaluate(() => window.__RR_PERF__.caps());
  if (!caps.timer) {
    await fail(
      'EXT_disjoint_timer_query_webgl2 is unavailable — this is a software GL context.\n' +
        'Timing a software rasteriser measures the CPU pretending to be a GPU. Refusing.'
    );
  }
  if (!quiet) {
    console.log(`gpu    ${caps.gpu}`);
    console.log(`seed   ${caps.seed}`);
    console.log(`url    ${url}\n`);
  }
  return { browser, page, caps };
}

/**
 * Run the scenario suite once and return raw batches plus counters.
 *
 * One `evaluate` per scenario rather than one for the lot. Playwright's bridge
 * is not free, but that is not the reason: a single long evaluate that throws
 * halfway loses every scenario measured before the throw, and a run that takes
 * a minute is a run you do not want to repeat because the eighth scenario found
 * a typo.
 */
export async function runSuite(page, scenarios, opts = {}) {
  const out = [];
  for (const spec of scenarios) {
    const r = await page.evaluate(
      ([s, o]) => window.__RR_PERF__.scenario(s, o),
      [spec, opts]
    );
    out.push(r);
    if (!opts.quiet) {
      const m = median(r.batches);
      process.stdout.write(
        `  ${spec.name.padEnd(22)} ${m.toFixed(2).padStart(7)} ms  ` +
          `draws ${String(r.counters.calls).padStart(4)}  ` +
          `tris ${(r.counters.triangles / 1e6).toFixed(2).padStart(6)}M  ` +
          `eye ${(r.settle?.camera?.drift ?? NaN).toFixed(2).padStart(5)}m  ` +
          `settled in ${String(r.settle?.frames ?? '?').padStart(3)}f` +
          `${r.settle?.settled === false ? '  NOT SETTLED' : ''}` +
          `${r.disjoints ? `  (${r.disjoints} disjoint)` : ''}\n`
      );
    }
  }
  return out;
}

/**
 * Every scenario that failed to reach a stable frame before it was timed.
 *
 * This is a hard error rather than a warning wherever it is checked. A station
 * whose world is still arriving reports fewer draw calls and fewer triangles
 * than it really has, which reads as an improvement — the single most dangerous
 * direction for a benchmark to be wrong in, because nobody investigates good
 * news.
 */
export function unsettled(pass) {
  return pass.filter((r) => r.settle && r.settle.settled === false).map((r) => r.name);
}

/**
 * A run's identity: everything that, if it changed, makes the numbers
 * incomparable with a stored baseline.
 *
 * The seed is in here because the world IS the workload — `grove-01` is the
 * authored wood and any other seed is a different forest with a different
 * number of trees in front of the camera. Comparing across a seed change is not
 * a slightly noisy comparison, it is a meaningless one, and the gate refuses it
 * outright rather than reporting a large regression.
 */
export function identity(caps, extra = {}) {
  return {
    seed: caps.seed,
    gpu: caps.gpu,
    hidden: caps.hidden,
    ...extra,
  };
}

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/* ---- reporting --------------------------------------------------------- */

const PAD = (s, n) => String(s).padEnd(n);
const NUM = (v, n, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—').padStart(n);

export function rule(char = '─', n = 78) {
  return char.repeat(n);
}

export function heading(text) {
  return `\n${text}\n${rule('─', Math.max(text.length, 40))}`;
}

export { PAD, NUM };
