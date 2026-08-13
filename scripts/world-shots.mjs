import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Screenshots that are the same twice.
 *
 *   node scripts/world-shots.mjs [--out=.shots/world] [--url=…] [--only=far]
 *
 * WHY THIS EXISTS WHEN shoot.mjs ALREADY DOES THIS.
 *
 * It does not. Two consecutive runs of `shoot.mjs` against IDENTICAL code differ
 * in 100% of pixels, with a mean per-pixel delta of 80 out of 765 — measured,
 * not assumed. Three things carry state across the whole session and none of
 * them are reset by seeking the trip clock:
 *
 *   - `uWind` is integrated by `updateWind` on a clock that starts at page load
 *     and never stops, so every plant's phase depends on how long the browser
 *     took to get to the shot.
 *   - the pipeline's luminous wake is a persistence accumulator, so frame N is
 *     a function of frames N-1, N-2, … back to load.
 *   - the mist layers scroll their texture offset on real time.
 *
 * That makes `shoot.mjs` a fine way to LOOK at the game and useless as a
 * regression instrument — which matters, because "the ground changed only where
 * it was supposed to" is exactly the claim a terrain change has to support. So
 * this pins all three, drives the frame itself, and is reproducible to the
 * pixel. Audio is never started (the gate is dismissed by hand rather than
 * clicked) because the jukebox's emissive follows the analyser.
 *
 * The stations go well outside the old 155.8 m confine, which is the point:
 * there is no way to photograph the end of the world from inside it.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots/world');
const ONLY = args.only ?? null;
mkdirSync(OUT, { recursive: true });

/**
 * Yaw convention, from Controller.forward(): the view direction is
 * (-sin yaw, 0, -cos yaw). So yaw 0 looks toward -z (north, at the ridge),
 * yaw π/2 looks toward -x, yaw π toward +z (south, at the stream), and
 * yaw -π/2 toward +x.
 */
const N = 0;
const S = Math.PI;
const W = Math.PI / 2;
const E = -Math.PI / 2;

const STATIONS = {
  // Inside the authored region — these must not have changed.
  spawn: { x: 0, z: 5, yaw: N, pitch: -0.02 },
  deep: { x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
  stream: { x: 4, z: 20, yaw: 0.1, pitch: -0.12 },
  // At the old confine limit, facing out along the +x axis — the direction the
  // ground used to ramp up into a rim and then stop 34 m ahead of you, below
  // your eye, with open sky beyond it. This is the view the whole change is for.
  limit: { x: 150, z: 0, yaw: E, pitch: -0.03 },
  // 400 m out, which is past everything the old world contained.
  'far-back': { x: 400, z: 0, yaw: W, pitch: 0.0 },
  'far-out': { x: 400, z: 0, yaw: E, pitch: 0.0 },
  'far-north': { x: 400, z: 0, yaw: N, pitch: 0.03 },
  'far-south': { x: 400, z: 0, yaw: S, pitch: -0.02 },
  // On the ridge crest, looking down the length of the valley. The longest
  // sightline the world has, and where a short ring would show first.
  'ridge-east': { x: 400, z: -96, yaw: E, pitch: -0.05 },
  'ridge-south': { x: 400, z: -96, yaw: S, pitch: -0.08 },
  // Two kilometres out.
  'k2-out': { x: 2000, z: 0, yaw: E, pitch: 0.0 },
  'k2-north': { x: 2000, z: 0, yaw: N, pitch: 0.03 },
};

/**
 * Sober and ego death.
 *
 * t = 220 s is not an arbitrary "late" sample: it is where the director has
 * thinned the fog to 0.00585, its lowest, which takes the visible distance from
 * 256 m to 402 m. Any ring that is too small is at its most visible on exactly
 * that frame.
 */
const LEVELS = [
  { tag: '', seek: null },
  { tag: '-ego', seek: 220 },
];

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const problems = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') problems.push(`[${t}] ${m.text().slice(0, 200)}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });

// Dismiss the gate WITHOUT starting audio, and stop everything that integrates.
await page.evaluate(() => {
  document.getElementById('gate').classList.add('gone');
  document.getElementById('toast').style.display = 'none';
  document.getElementById('help').style.display = 'none';
  const R = window.RR;
  R.probe.freeze(true);
  // trailEnabled, not setTripParameters({trail:0}): the director rewrites the
  // trail amount every frame, and this is the switch it cannot overwrite.
  R.pipeline.trailEnabled = false;
});

const shots = [];
for (const [name, at] of Object.entries(STATIONS)) {
  if (ONLY && !name.includes(ONLY)) continue;
  for (const level of LEVELS) {
    const info = await page.evaluate(
      async ({ at: s, seek, rain }) => {
        const R = window.RR;
        const raf = () => new Promise((r) => requestAnimationFrame(r));

        R.controller.position.x = s.x;
        R.controller.position.z = s.z;
        /**
         * Drop the body from below the world so it snaps to the floor.
         *
         * Teleporting in x and z only leaves the eye at the PREVIOUS station's
         * height, and the controller then walks it down under gravity over
         * however many frames the ring happens to take to settle. That made
         * three shots taken at the identical spot come out at 10.6 m, 6.1 m and
         * 5.8 m, and it is why the first version of this script was no more
         * reproducible than shoot.mjs. `update()` clamps y up to
         * `groundUnder + EYE` whenever it is below the floor, so starting a long
         * way under the ground lands exactly on it in one frame, with no
         * dependence on how long anything took.
         */
        R.controller.position.y = -1e4;
        R.controller.velocity.set(0, 0, 0);
        R.controller.yaw = s.yaw;
        R.controller.pitch = s.pitch;
        R.controller.applyToCamera();

        /**
         * Let the ring catch up before photographing it.
         *
         * A teleport is the one thing the streaming budget is NOT designed for
         * — one chunk a frame is sized for walking — so a shot taken
         * immediately after one would be a picture of the loading, not of the
         * world. Everything here waits for `pending` to reach zero, and reports
         * how many frames that took so a regression in the budget is visible in
         * the log rather than only in the image.
         */
        /**
         * A FIXED number of frames, not "until the ring is idle".
         *
         * Early-exiting on `pending === 0` took between 5 and 55 frames
         * depending on how the worker round trips landed, and the head-bob
         * damping, the mist scroll and the ground ring all advance per frame —
         * so two runs photographed the same station from very slightly
         * different states. On ground this aliased (see world-grain.mjs) a
         * sub-millimetre camera difference changes every pixel, which is how a
         * 1 mm discrepancy showed up as 99% of pixels differing. 150 frames is
         * comfortably more than the ~55 the worst teleport needed.
         */
        const frames = 150;
        for (let i = 0; i < frames; i++) await raf();

        if (seek === null) R.director.ground();
        else R.director.seek(seek);
        // A fixed number of fixed-size steps, so the eased values land in the
        // same place every run. The trip clock is the ONLY clock allowed to
        // advance in this script, and it advances by exactly 0.5 s here.
        for (let i = 0; i < 30; i++) {
          R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
        }
        // Pinned after the settle: the wind integrator has been running since
        // page load and its phase is otherwise a function of wall-clock.
        R.tripUniforms.uWind.value.set(11.5, 17.4);
        for (const m of R.atmosphere.mist.mats) {
          m.map.offset.x = 0;
        }
        /**
         * FORCE THE WEATHER, IF ASKED. `--rain=0.8`.
         *
         * The weather is a pure function of the world clock (see the block in
         * atmosphere.js), which makes it reproducible but also means a shot of
         * rain cannot be taken by waiting — the clock would have to land inside
         * a burst. Overriding the uniform after the settle and before the
         * render is the only way to photograph it on demand, and it is safe
         * here for the same reason the wind pin above is: this script is the
         * one place allowed to reach past the simulation.
         */
        if (rain !== null) {
          R.atmosphere.rain.material.uniforms.uRain.value = rain;
          R.atmosphere.rain.points.visible = rain > 0.02;
        }
        R.atmosphere.follow(R.camera);
        R.renderer.shadowMap.needsUpdate = true;
        R.forest.cull(R.camera, true);
        for (let i = 0; i < 3; i++) R.pipeline.render(1 / 60);

        /**
         * Read the canvas back HERE, in the same task as the draw.
         *
         * `page.screenshot()` composites whatever is on screen when Playwright
         * gets round to it, which is several of the app's own rAF frames later —
         * and those frames run with a real `dt`, advance the mist, and re-render
         * with whatever the pipeline's temporal state has become. That was worth
         * a mean per-pixel delta of 27 between two runs of identical code.
         * `toDataURL` in the same task as the last `render()` captures exactly
         * the frame this script composed; the context has no
         * preserveDrawingBuffer, which is precisely why it has to be this task
         * and not the next one.
         */
        const png = R.renderer.domElement.toDataURL('image/png');

        const G = R.forest.groundField;
        /**
         * COUNTED WITH `autoReset` OFF AROUND ONE HAND-DRIVEN FRAME.
         *
         * `renderer.info` resets at the top of every `renderer.render()` and a
         * frame here is several — world, bright pass, bloom chain, glow
         * accumulator, output pass. Read at the end of a frame, as these two
         * lines used to be, it reports the fullscreen output quad: a flat
         * `1 call, 2 triangles` in every row of every run, in a table whose
         * whole job is comparing worlds. Same treatment as scripts/perf.mjs and
         * src/dev/perf/probe.js.
         */
        const info = R.renderer.info;
        info.autoReset = false;
        info.reset();
        R.pipeline.render(1 / 60);
        const calls = info.render.calls;
        const tris = info.render.triangles;
        info.autoReset = true;

        return {
          png,
          frames,
          chunks: G ? G.chunks.size : -1,
          fog: R.atmosphere.fog.density,
          calls,
          tris,
          y: Math.round(R.controller.position.y * 10) / 10,
        };
      },
      { at, seek: level.seek, rain: args.rain === undefined ? null : Number(args.rain) }
    );
    const file = `${name}${level.tag}`;
    writeFileSync(`${OUT}/${file}.png`, Buffer.from(info.png.split(',')[1], 'base64'));
    delete info.png;
    shots.push({ file, ...info });
    console.log(
      `${file.padEnd(16)} eye ${String(info.y).padStart(6)} m  fog ${info.fog.toFixed(5)}  ` +
        `${String(info.chunks).padStart(3)} chunks  ${String(info.calls).padStart(4)} draws  ` +
        `${(info.tris / 1e6).toFixed(2)}M tris  (settled in ${info.frames} frames)`
    );
  }
}

writeFileSync(`${OUT}/report.json`, JSON.stringify({ shots, problems }, null, 2));
if (problems.length) {
  console.log(`\n${problems.length} console problem(s):`);
  for (const p of problems.slice(0, 20)) console.log(' ', p);
} else {
  console.log('\nno console problems');
}

await browser.close();
