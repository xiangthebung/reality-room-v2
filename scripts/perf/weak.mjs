/**
 * WHAT A SLOW MACHINE IS ACTUALLY CHARGED — the half of the budget every other
 * script in this directory cannot see.
 *
 *   npm run perf:weak
 *   npm run perf:weak -- --rates=1,4,8 --levels=potato,low --stations=deep,clearing
 *
 * Every instrument here measures GPU time on a desktop part, and on that part
 * `potato` costs about a millisecond however it is configured — which is a true
 * number and a useless one for deciding what to cut for a Chromebook. Two things
 * are different on the machine this rung exists for, and NEITHER is visible in a
 * timer query:
 *
 *   1. THE CPU IS THREE TO EIGHT TIMES SLOWER. Everything the frame does before
 *      it submits — the controller, the trip director, the culler's repack over
 *      every bucket of every layer, the fauna step, the audio pump, the driver
 *      call per draw — is main-thread work that a weak core pays for in full.
 *      `Emulation.setCPUThrottlingRate` is a real division of instruction rate
 *      by the CDP, so this is a measurement rather than an estimate.
 *
 *   2. THE FRAME IS VERTEX-BOUND RATHER THAN FILL-BOUND. That cannot be
 *      throttled from here, so it is reported rather than simulated: triangles
 *      and draw calls are exact, reproducible, machine-independent counts, and
 *      they are what a part with a tenth of the geometry throughput is charged.
 *
 * WHAT THIS DOES NOT DO IS PRETEND TO BE A CHROMEBOOK. Throttling the CPU does
 * not throttle the GPU, the driver, or memory bandwidth, and a 4x-throttled
 * desktop is not an N4500 — the caches are different, the memory is different,
 * and the GPU underneath is still enormous. What it IS is the only way to find
 * out whether this game's frame falls over on CPU before it falls over on the
 * GPU, which is a question with a yes/no answer and one this project had never
 * asked.
 *
 * IT DRIVES THE REAL rAF LOOP, not the instrument's held one. The whole subject
 * is main-thread work, and `__RR_PERF__.engage()` holds the game's own frame
 * loop precisely so that it cannot interfere with a GPU timing — which would
 * remove everything being measured here. So the page is left running normally
 * and the window is read off `performance.now()` deltas the way the Auto
 * governor reads them.
 */
import { chromium } from 'playwright';
import { argv, PERF_DIR, writeJson, heading, PAD, NUM } from './harness.mjs';
import { median } from './stats.mjs';

const args = argv({
  url: 'http://127.0.0.1:5180/',
  rates: '1,4,8',
  levels: 'potato,low',
  stations: 'deep,clearing',
  seconds: '4',
  json: `${PERF_DIR}/weak.json`,
});

const RATES = args.rates.split(',').map(Number);
const LEVELS = args.levels.split(',').filter(Boolean);
const STATIONS = args.stations.split(',').filter(Boolean);
const SECONDS = Number(args.seconds);

/**
 * VSYNC STAYS ON AND THE WINDOW IS HEADED.
 *
 * `uncapped-probes-invent-hitches` is the note this is obeying: with
 * `--disable-gpu-vsync` the page hands the driver frames faster than it can
 * retire them and the queue backing up produces 90-200 ms frames inside
 * `render()` that no player would ever see. This measures whether frames ARRIVE
 * ON TIME, which is a question only a vsynced clock can answer — and headless
 * Chromium paces rAF from a simulated 60 Hz clock whatever the monitor does,
 * which for once is exactly the 16.7 ms budget being tested against.
 */
const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
await page.routeWebSocket(/.*/, () => {});
const cdp = await page.context().newCDPSession(page);

await page.goto(args.url, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page
  .waitForFunction(() => document.getElementById('gate')?.classList.contains('gone'), null, { timeout: 90000 })
  .catch(() => {});

const caps = await page.evaluate(() => window.__RR_PERF__.caps());
console.log(`gpu    ${caps.gpu}`);
console.log(`seed   ${caps.seed}`);
console.log(`window 1366x768, vsync on, headless (60 Hz simulated)\n`);

/**
 * Install a frame-interval recorder that rides the page's OWN loop.
 *
 * A separate rAF of our own would measure the same clock, but it would also add
 * a callback to every frame — which at 8x throttling is not free and would be
 * charged to the thing being measured. `performance.now()` deltas inside one
 * rAF chain are what the Auto governor already uses; this is that, with a
 * histogram.
 */
await page.evaluate(() => {
  window.__WEAK__ = {
    samples: [],
    running: false,
    start() {
      this.samples.length = 0;
      this.running = true;
      let last = performance.now();
      const step = (now) => {
        if (!this.running) return;
        requestAnimationFrame(step);
        const dt = now - last;
        last = now;
        // The first interval after a start spans the setup, and a tab that lost
        // focus produces intervals in the hundreds. Neither is a frame.
        if (dt > 0 && dt < 250) this.samples.push(dt);
      };
      requestAnimationFrame(step);
    },
    stop() {
      this.running = false;
      return this.samples.slice();
    },
    /** Triangles and draws for one frame, all passes. Machine-independent. */
    counters() {
      const R = window.RR;
      const info = R.renderer.info;
      info.autoReset = false;
      info.reset();
      R.forest.cull(R.camera, true);
      R.pipeline.render(1 / 60);
      const c = { calls: info.render.calls, triangles: info.render.triangles };
      info.autoReset = true;
      return c;
    },
    /**
     * Seat the body at a station and let both streaming rings drain.
     *
     * `forest.settled` rather than a frame count: `settling-by-frame-count-lies`
     * is a mistake this repo has made four times, and a station photographed
     * half-arrived reports fewer triangles than it has, which reads as a win.
     */
    async seat(x, z, yaw, pitch) {
      const R = window.RR;
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      R.controller.position.x = x;
      R.controller.position.z = z;
      R.controller.position.y = -1e4;
      R.controller.velocity.set(0, 0, 0);
      R.controller.yaw = yaw;
      R.controller.pitch = pitch;
      R.controller.applyToCamera();
      R.director.ground();
      for (let i = 0; i < 600 && !R.forest.settled; i++) await raf();
      for (let i = 0; i < 60; i++) await raf();
      return R.forest.settled;
    },
  };
});

/** Lifted from src/dev/perf/stations.js so the numbers line up with everything else. */
const SEATS = {
  deep: [-34, -46, 1.1, 0.02],
  clearing: [0, 8, 0, -0.03],
  canopy: [-34, -46, 1.1, 0.85],
  stream: [4, 20, 0.1, -0.12],
  ridge: [400, -96, -Math.PI / 2, -0.05],
};

const report = { caps, spec: { rates: RATES, levels: LEVELS, stations: STATIONS, seconds: SECONDS }, rows: [] };

for (const level of LEVELS) {
  await page.evaluate((l) => window.RRSettings.setMode(l), level);
  for (const station of STATIONS) {
    const seat = SEATS[station];
    if (!seat) throw new Error(`unknown station ${station}`);
    // Unthrottled while the world arrives: streaming a ring at 8x is minutes,
    // and how long the ARRIVAL takes is not what this is measuring.
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const settled = await page.evaluate((s) => window.__WEAK__.seat(...s), seat);
    const counters = await page.evaluate(() => window.__WEAK__.counters());

    for (const rate of RATES) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      await page.evaluate(() => window.__WEAK__.start());
      // Throw the first second away: the throttle takes effect on the next
      // execution slice and the frames either side of it are neither speed.
      await page.waitForTimeout(1000);
      await page.evaluate(() => window.__WEAK__.start());
      await page.waitForTimeout(SECONDS * 1000);
      const samples = await page.evaluate(() => window.__WEAK__.stop());
      const sorted = samples.slice().sort((a, b) => a - b);
      const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? NaN;
      const late = sorted.filter((d) => d > 16.7 * 1.5).length / (sorted.length || 1);
      report.rows.push({
        level,
        station,
        rate,
        settled,
        n: sorted.length,
        p50: p(0.5),
        p95: p(0.95),
        fps: 1000 / p(0.5),
        late,
        counters,
      });
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
}

console.log(heading('frame intervals through the game’s own loop, CPU throttled'));
console.log(
  `${PAD('level', 9)}${PAD('station', 10)}${'cpu'.padStart(5)}${'p50 ms'.padStart(9)}` +
    `${'p95 ms'.padStart(9)}${'fps'.padStart(8)}${'late'.padStart(8)}${'draws'.padStart(8)}${'tris'.padStart(9)}`
);
for (const r of report.rows) {
  console.log(
    PAD(r.level, 9) +
      PAD(r.station, 10) +
      `${r.rate}x`.padStart(5) +
      NUM(r.p50, 9) +
      NUM(r.p95, 9) +
      NUM(r.fps, 8, 1) +
      `${(r.late * 100).toFixed(0)}%`.padStart(8) +
      String(r.counters.calls).padStart(8) +
      `${(r.counters.triangles / 1e6).toFixed(2)}M`.padStart(9) +
      (r.settled ? '' : '  UNSETTLED')
  );
}
console.log(
  '\n  late     fraction of intervals over 1.5x a 60 Hz slot — the Auto governor’s\n' +
    '           own test, and the one that decides whether a player feels it.\n' +
    '  cpu      Emulation.setCPUThrottlingRate. 1x is this desktop; 4-8x is the\n' +
    '           range a Celeron/N-series Chromebook sits in against it.\n' +
    '  tris     exact and machine-independent. A part with a tenth of the geometry\n' +
    '           throughput is charged this, and no timer here can show that.'
);

writeJson(args.json, report);
console.log(`\n${args.json}`);
await browser.close();
