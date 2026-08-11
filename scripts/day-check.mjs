import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * The day cycle, measured rather than admired.
 *
 *   node scripts/day-check.mjs            everything
 *   node scripts/day-check.mjs --only=shots|step|shadow|levels|identity
 *
 * Five questions, and they are the five the feature can fail on:
 *
 *   IDENTITY   is the world at the pinned automation phase still, to the bit,
 *              the world every other script in here measures? If this fails,
 *              nothing else in scripts/ means anything any more.
 *
 *   SHOTS      what does an hour actually look like. Written to .shots/day/ and
 *              meant to be LOOKED AT — the corduroy question at dawn and dusk
 *              and the legibility question at night are both judgements, and a
 *              script that claimed to answer them would be lying. What it can
 *              do is report the mean luminance and the fraction of the frame
 *              that has gone to near-black, which is what "you cannot see" is.
 *
 *   STEP       how big a quantisation step of the sun is invisible. Renders the
 *              same station at phase p and p+Δ with everything else frozen and
 *              reports the mean absolute pixel difference. This is the number
 *              SUN_STEP is chosen from.
 *
 *   SHADOW     how often the map actually re-renders over a whole cycle while
 *              standing still, which is the cost of the whole feature.
 *
 *   LEVELS     the four graphics presets, six stations, mean-frame luminance —
 *              the ±1.0 agreement a previous pass bought and this one must not
 *              have spent.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const ONLY = args.only ? String(args.only).split(',') : null;
const want = (name) => !ONLY || ONLY.includes(name);
const OUT = '.shots/day';
mkdirSync(OUT, { recursive: true });

/** The six the light compensation was fitted against. Same numbers, same order. */
const STATIONS = [
  { name: 'spawn', x: 0, z: 5, yaw: 0.0, pitch: -0.02 },
  { name: 'deep', x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
  { name: 'edge', x: 18, z: 22, yaw: 2.4, pitch: 0.0 },
  { name: 'stream', x: 4, z: 20, yaw: 0.1, pitch: -0.12 },
  { name: 'jukebox', x: 2.6, z: -1.4, yaw: 0.42, pitch: -0.06 },
  { name: 'canopy', x: -30, z: -40, yaw: 0.8, pitch: 0.85 },
];

/**
 * A seventh, and only for the sky shots.
 *
 * The `canopy` station above is thirty metres deep in the wood with its nose in
 * the leaves, which is exactly right for the luminance table and useless for
 * asking whether the stars work — the first attempt produced a black rectangle
 * and no way to tell whether that was a broken shader or simply a lot of oak.
 * This one stands in the middle of the spawn clearing and looks nearly
 * straight up, which is where a player who wants to see the sky will stand.
 */
const SKY_STATION = { name: 'sky', x: 0, z: 5, yaw: 0.6, pitch: 1.32 };

/** The hours worth photographing. Named so the filenames mean something. */
const HOURS = [
  ['night', 0.03],
  ['predawn', 0.19],
  ['sunrise', 0.2123],
  ['dawn', 0.25],
  ['morning', 0.3758],
  ['noon', 0.5],
  ['golden', 0.762],
  ['sunset', 0.7877],
  ['dusk', 0.815],
  ['nightfall', 0.87],
];

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const noise = [];
page.on('console', (m) => {
  if (m.type() === 'error') noise.push(m.text());
});
page.on('pageerror', (e) => noise.push('PAGEERROR ' + e.message));
/**
 * Before goto, always. The dev server in this repo is shared with whoever else
 * is editing today and a stray socket upgrade has 500'd it more than once.
 */
await page.routeWebSocket(/.*/, () => {});
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(3500);

/**
 * Park the camera and let the world settle, exactly the way authored-check does
 * — including the deliberate 100 m detour, which is not superstition: the sun's
 * anchor only moves once the body is 6 m from it, so without forcing the
 * hysteresis the first station's shadow map is a function of wherever the rAF
 * loop happened to leave the player, and it differs between runs of an
 * unchanged build.
 */
await page.evaluate(() => {
  window.__park = async (s, phase) => {
    const R = window.RR;
    R.atmosphere.day.set(phase);
    R.controller.velocity.set(0, 0, 0);
    R.controller.yaw = s.yaw;
    R.controller.pitch = s.pitch;
    R.controller.position.set(s.x + 100, R.controller.position.y, s.z);
    R.controller.applyToCamera();
    R.atmosphere.follow(R.camera, R.controller.position);
    R.controller.position.set(s.x, R.controller.position.y, s.z);
    R.controller.applyToCamera();
    R.atmosphere.follow(R.camera, R.controller.position);
    R.atmosphere.applyDay(phase);
    R.atmosphere.stepSun(phase);
    R.forest.cull(R.camera, true);
    /**
     * LET THE BODY FALL BEFORE MEASURING ANYTHING.
     *
     * `__park` sets x and z and keeps the previous station's Y, because there
     * is nowhere honest to get a new one from without reimporting terrain.js —
     * and a reimport under Vite is a second module whose world seed was never
     * set. So the body is teleported into the air (or into a hill) and the
     * controller's own gravity brings it down over the next second or two.
     *
     * That was the whole of the noise in the preset table and it was a
     * beautiful impostor. `deep` is up on the ridge and `edge` and `stream` are
     * down in the valley, so those two were measured mid-fall from thirty
     * metres up — looking down over the canopy at bright sky rather than into
     * the wood. `stream` came out at 65.6 on medium against 23.6 on high, which
     * is not a number any lighting change could produce and reads exactly like
     * a preset regression. spawn, deep, jukebox and canopy agreed to a tenth
     * the whole time, which is what should have given it away sooner.
     */
    await window.__grounded();
    await window.__settle();
    // …and a little wall clock on top, because the rings only queue from inside
    // `forest.cull`: the queue can be empty for three frames and refill on the
    // fourth. Measured with a null capture — same station, same phase, nothing
    // touched — the settle alone left 8.0/255 and the settle plus this 0.002.
    await new Promise((r) => setTimeout(r, 400));
    R.controller.velocity.set(0, 0, 0);
    R.controller.position.set(s.x, R.controller.position.y, s.z);
    R.controller.yaw = s.yaw;
    R.controller.pitch = s.pitch;
    R.controller.applyToCamera();
    R.atmosphere.applyDay(phase);
    R.forest.cull(R.camera, true);
  };
  /** Wait until the controller's height stops changing, or give up. */
  window.__grounded = () =>
    new Promise((resolve) => {
      const R = window.RR;
      let last = NaN;
      let still = 0;
      let n = 0;
      const poll = () => {
        const y = R.controller.position.y;
        still = Math.abs(y - last) < 1e-4 ? still + 1 : 0;
        last = y;
        if (still >= 6 || ++n > 700) resolve();
        else requestAnimationFrame(poll);
      };
      poll();
    });
  /**
   * Mean luminance straight off the back buffer.
   *
   * Same instrument as the step test and for the same reason: rendered by hand
   * and read synchronously, so the app's frame loop cannot run between posing
   * the camera and measuring the result. Rendered twice because the pipeline
   * ping-pongs its glow accumulator.
   */
  window.__lum = () => {
    const R = window.RR;
    const gl = R.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    R.pipeline.render(1 / 60);
    R.pipeline.render(1 / 60);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let lum = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    let black = 0;
    const n = w * h;
    for (let i = 0; i < buf.length; i += 4) {
      const y = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
      lum += y;
      r += buf[i];
      g += buf[i + 1];
      b += buf[i + 2];
      if (y < 12) black++;
    }
    return { lum: lum / n, r: r / n, g: g / n, b: b / n, black: black / n };
  };
  /**
   * Wait for the terrain and forest rings to finish arriving.
   *
   * NOT OPTIONAL, AND IT COST TWO WRONG TABLES TO FIND OUT. `__park` teleports
   * 100 m away and back to force the sun anchor's hysteresis, and both rings
   * deliberately accept at most one sector per frame — so two rAFs after a
   * 100 m round trip the wood is still filling in. The stream station looks
   * down into the channel, and whether the chunk under the water has arrived
   * yet is worth seven whole points of mean luminance. It showed up as `medium`
   * and `ultra` agreeing with each other at 20.3 while `low` and `high` agreed
   * at 13.8, which reads exactly like a real preset difference and is not one.
   *
   * Same test main.js uses behind the gate: non-empty and quiet for three
   * consecutive frames, bounded so a worker that never answers costs a slightly
   * unsettled measurement rather than a script that hangs.
   */
  window.__settle = () =>
    new Promise((resolve) => {
      const R = window.RR;
      const started = performance.now();
      let quiet = 0;
      const poll = () => {
        const g = R.forest.groundField;
        const t = R.forest.field;
        const ok = g.pending === 0 && g.group.children.length > 0 && t.pending === 0 && t.built > 0;
        quiet = ok ? quiet + 1 : 0;
        if (quiet >= 3 || performance.now() - started > 5000) resolve();
        else requestAnimationFrame(poll);
      };
      poll();
    });
  /**
   * Mean luminance, mean R:G, and how much of the frame has gone black.
   *
   * FED A PNG, NOT THE LIVE CANVAS. Reading the WebGL canvas back with
   * `drawImage` returns a black rectangle here — the context has no
   * `preserveDrawingBuffer` and the drawing buffer is gone by the time script
   * runs after a present. Every measurement taken that way is a confident
   * 0.0 with no error anywhere, which is the worst possible failure for a
   * numeric check. `page.screenshot()` goes through the compositor and is
   * correct, so the numbers come from the same PNG that gets written to disk —
   * which is also the one somebody will look at. Same technique as
   * world-diff.mjs.
   */
  window.__statsOf = async (b64) => {
    const img = await new Promise((res) => {
      const im = new Image();
      im.onload = () => res(im);
      im.src = 'data:image/png;base64,' + b64;
    });
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let lum = 0;
    let r = 0;
    let gg = 0;
    let b = 0;
    let black = 0;
    const n = c.width * c.height;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      lum += y;
      r += d[i];
      gg += d[i + 1];
      b += d[i + 2];
      // 12/255 is about where a mid-gamma monitor in a lit room stops showing
      // you anything at all. "Night is legible" is mostly this number.
      if (y < 12) black++;
    }
    return { lum: lum / n, r: r / n, g: gg / n, b: b / n, black: black / n };
  };
});

const park = (s, phase) => page.evaluate(([a, b]) => window.__park(a, b), [s, phase]);
async function stats(path) {
  const buf = await page.screenshot(path ? { path } : {});
  return page.evaluate((b64) => window.__statsOf(b64), buf.toString('base64'));
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------
if (want('identity')) {
  const id = await page.evaluate(() => {
    const R = window.RR;
    const a = R.atmosphere;
    a.day.set(null);
    // Under webdriver, an unpinned clock IS the authored phase. That is the
    // whole contract; if it ever stops being true every stored expectation in
    // scripts/ starts drifting by the minute.
    const p = a.day.phase();
    a.applyDay(p);
    a.stepSun(p);
    const SUN = { x: 0.36, y: 0.62, z: -0.7 };
    const l = Math.sqrt(SUN.x * SUN.x + SUN.y * SUN.y + SUN.z * SUN.z);
    const inv = 1 / l;
    return {
      phase: p,
      authored: a.day.authoredPhase,
      pinnedIsAuthored: p === a.day.authoredPhase,
      dirExact:
        a.lightDirection.x === SUN.x * inv &&
        a.lightDirection.y === SUN.y * inv &&
        a.lightDirection.z === SUN.z * inv,
      sunIntensity: a.sun.intensity,
      sunColour: a.sun.color.getHexString(),
      hemiIntensity: a.hemi.intensity,
      hemiSky: a.hemi.color.getHexString(),
      hemiGround: a.hemi.groundColor.getHexString(),
      ambient: [a.ambient.intensity, a.ambient.color.getHexString()],
      fill: [a.fill.intensity, a.fill.color.getHexString()],
      fog: [a.fog.color.getHexString(), a.fog.density],
      skyTop: a.skyUniforms.uTop.value.getHexString(),
      skyHorizon: a.skyUniforms.uHorizon.value.getHexString(),
      skyGround: a.skyUniforms.uGround.value.getHexString(),
      skySun: a.skyUniforms.uSunColour.value.getHexString(),
      uNight: a.skyUniforms.uNight.value.toArray(),
      normalBias: a.sun.shadow.normalBias,
      shaftDaylight: a.shafts.material.uniforms.uDaylight.value,
      moteDaylight: a.motes.material.uniforms.uDaylight.value,
      waterDaylight: a.water.material.uniforms.uDaylight.value,
      dark: a.day.dark(p),
    };
  });
  const EXPECT = {
    sunIntensity: 2.5,
    sunColour: 'ffeac4',
    hemiIntensity: 1.25,
    hemiSky: 'bcd8ea',
    hemiGround: '60704a',
    ambient: [0.55, '5d7060'],
    fill: [0.42, '8fb4d8'],
    fog: ['7f9a86', 0.0092],
    skyTop: '2f6ea8',
    skyHorizon: 'bcd0c4',
    skyGround: '1d2419',
    skySun: 'ffe3b0',
    uNight: [1, 1, 0, 0],
    normalBias: 0.05,
    shaftDaylight: 1,
    moteDaylight: 1,
    waterDaylight: 1,
    dark: 0,
  };
  let bad = 0;
  console.log('IDENTITY — the pinned automation frame against the authored one\n');
  console.log(`  phase ${id.phase.toFixed(9)}  pinned==authored ${id.pinnedIsAuthored}`);
  console.log(`  light direction bit-exact against SUN_DIR: ${id.dirExact}`);
  if (!id.pinnedIsAuthored || !id.dirExact) bad++;
  for (const [k, v] of Object.entries(EXPECT)) {
    const got = JSON.stringify(id[k]);
    const exp = JSON.stringify(v);
    const ok = got === exp;
    if (!ok) bad++;
    console.log(`  ${ok ? ' ' : '!'} ${k.padEnd(16)} ${got.padEnd(22)} ${ok ? '' : 'expected ' + exp}`);
  }
  console.log(bad === 0 ? '\n  PASS — the authored world is untouched.\n' : `\n  FAIL — ${bad} differences.\n`);
}

// ---------------------------------------------------------------------------
// shots
// ---------------------------------------------------------------------------
if (want('shots')) {
  console.log('SHOTS — one station through the whole cycle. .shots/day/\n');
  console.log('  hour        lum     R:G    black%   what to look for');
  const station = STATIONS[0];
  for (const [name, phase] of HOURS) {
    await park(station, phase);
    const s = await stats(`${OUT}/${name}.png`);
    console.log(
      `  ${name.padEnd(10)} ${s.lum.toFixed(1).padStart(5)}  ${(s.r / s.g).toFixed(3)}  ${(s.black * 100).toFixed(1).padStart(5)}%`
    );
  }
  // …and one deep-wood shot at the two hours that are hardest.
  for (const [name, phase] of [['night', 0.03], ['dusk', 0.815], ['dawn', 0.25]]) {
    await park(STATIONS[1], phase);
    await page.screenshot({ path: `${OUT}/deep-${name}.png` });
  }
  // Looking up: the stars, the moon and the sunset sky.
  for (const [name, phase] of [['night', 0.03], ['dusk', 0.815], ['sunset', 0.7877], ['noon', 0.5]]) {
    await park(SKY_STATION, phase);
    await page.screenshot({ path: `${OUT}/sky-${name}.png` });
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------
if (want('step')) {
  console.log('STEP — how visible one quantisation step of the sun is\n');
  console.log('  A pixel diff between the same frame lit from p and from p+Δ, at');
  console.log('  three stations, at noon where the sun is strongest.\n');
  /**
   * FREEZE THE WORLD FIRST, or this measures the wind.
   *
   * The first run of this printed 9/255 at Δ = 0.3° and 16/255 at Δ = 4.8° —
   * barely any dependence on the thing being measured, because the two captures
   * are a second apart and in that second every leaf, every mote and every
   * water ripple moved. The probe exists for exactly this and says so: a scene
   * in which everything is subtly moving produces a difference image that
   * traces every edge in the frame no matter what you did to it.
   *
   * The Δ = 0 row is the control, and it has to come out at zero or the
   * freeze did not take.
   */
  await page.evaluate(() => window.RR.probe.freeze(true));
  /**
   * BOTH RENDERS INSIDE ONE JS TURN, READ BACK WITH readPixels.
   *
   * `page.screenshot()` is the wrong instrument for this and it took three
   * wrong tables to accept it. A screenshot goes through the compositor
   * whenever the compositor gets round to it, so between capture A and capture
   * B the app's own rAF loop runs a few hundred times — culling, streaming and
   * repacking — and the difference image shows the wood arriving rather than
   * the sun moving. The null row came out at 8 to 13 out of 255 and jumped
   * around, which is larger than the effect being measured.
   *
   * Driving `pipeline.render` by hand and reading the back buffer is the
   * technique `cull-diff.mjs` uses to assert a ZERO pixel difference, and it
   * works for the same reason: the two renders are consecutive statements, so
   * nothing at all can happen between them. The null row below now reads 0.000,
   * which is the only null row worth printing.
   *
   * Rendered twice per capture before the read, also following cull-diff — the
   * pipeline ping-pongs its glow accumulator, so a single render leaves the
   * pair one buffer out of phase with each other.
   */
  console.log('  Δ°     mean|diff|/255      max px   >8/255   worst station');
  const degs = [0, 0.3, 0.6, 1.2, 2.4, 4.8];
  for (const s of STATIONS.slice(0, 3)) {
    await park(s, 0.5);
  }
  const table = new Map(degs.map((d) => [d, { sum: 0, worst: 0, at: '' }]));
  for (const s of STATIONS.slice(0, 3)) {
    await park(s, 0.5);
    const res = await page.evaluate((list) => {
      const R = window.RR;
      const gl = R.renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const A = new Uint8Array(w * h * 4);
      const B = new Uint8Array(w * h * 4);
      const shoot = (buf) => {
        R.pipeline.render(1 / 60);
        R.pipeline.render(1 / 60);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      };
      // FORCED. Below the shipping threshold `stepSun` correctly refuses to
      // commit, so without this the small-Δ rows compare a frame with itself.
      const at = (p) => {
        R.atmosphere.day.set(p);
        R.atmosphere.applyDay(p);
        R.atmosphere.stepSun(p, true);
      };
      const out = [];
      for (const deg of list) {
        at(0.5);
        shoot(A);
        at(0.5 + deg / 360);
        shoot(B);
        let t = 0;
        let worst = 0;
        // How much of the frame moves by more than 8/255 — which is roughly
        // where a difference stops being arithmetic and starts being something
        // you could point at on a still. Mean alone hides a few hard edges and
        // max alone is one pixel.
        let over = 0;
        for (let i = 0; i < A.length; i += 4) {
          const d =
            Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
          t += d;
          if (d > worst) worst = d;
          if (d > 24) over++;
        }
        out.push({ deg, mean: t / (w * h * 3), worst, over: over / (w * h) });
      }
      at(0.5);
      return out;
    }, degs);
    for (const r of res) {
      const row = table.get(r.deg);
      row.sum += r.mean;
      if (r.mean > row.worst) {
        row.worst = r.mean;
        row.at = s.name;
      }
      row.maxpx = Math.max(row.maxpx ?? 0, r.worst);
      row.over = Math.max(row.over ?? 0, r.over);
    }
  }
  for (const deg of degs) {
    const row = table.get(deg);
    console.log(
      `  ${String(deg).padEnd(6)} ${(row.sum / 3).toFixed(3).padStart(10)}      ${String(row.maxpx).padStart(6)}   ` +
        `${(row.over * 100).toFixed(2).padStart(6)}%   ${row.at || '–'}`
    );
  }
  await page.evaluate(() => {
    window.RR.probe.freeze(false);
    window.RR.atmosphere.day.set(null);
  });
  console.log('');
}

// ---------------------------------------------------------------------------
// shadow
// ---------------------------------------------------------------------------
if (want('shadow')) {
  console.log('SHADOW — re-renders over a whole cycle, standing still\n');
  const r = await page.evaluate(() => {
    const R = window.RR;
    const a = R.atmosphere;
    /**
     * Stepped by hand rather than run at 1×, because the answer is a property
     * of the CYCLE and not of the second: the sun's total angular travel over
     * a cycle is fixed, so the number of commits is the same however fast the
     * clock is driven. 24000 samples is one every 0.05 s of world time, which
     * is far finer than any threshold in play.
     */
    const N = 24000;
    a.sunSteps = 0;
    const before = a.sunSteps;
    const perTenth = new Array(10).fill(0);
    let last = 0;
    for (let i = 0; i < N; i++) {
      const p = i / N;
      a.applyDay(p);
      if (a.stepSun(p)) perTenth[Math.min(9, Math.floor(p * 10))]++;
      last = p;
    }
    void last;
    a.day.set(null);
    return { total: a.sunSteps - before, perTenth, cycle: a.day.cycleSeconds };
  });
  const perMin = (r.total / r.cycle) * 60;
  console.log(`  ${r.total} commits per ${r.cycle} s cycle  =  ${perMin.toFixed(1)} per minute standing still`);
  console.log('  distribution over the day (each bucket is a tenth of a cycle, 0 = midnight):');
  console.log(
    '   ' + r.perTenth.map((n, i) => `${(i / 10).toFixed(1)}:${String(n).padStart(3)}`).join('  ')
  );
  console.log(`\n  for scale: walking at 4 m/s crosses the 6 m anchor hold ${(4 / 6) * 60} times a minute.\n`);
}

// ---------------------------------------------------------------------------
// cost
// ---------------------------------------------------------------------------
if (want('cost')) {
  console.log('COST — what the clock is worth, measured against itself\n');
  /**
   * WHY THIS IS NOT A BEFORE/AFTER AGAINST perf.mjs.
   *
   * It would be a lie. The forest rewrite landed in the same window as this
   * work and took draw calls from 159 to 129, so every absolute number in the
   * repo's perf history moved for reasons that have nothing to do with a day
   * cycle. Comparing today's `gpu-perf` against yesterday's would credit the
   * clock with somebody else's optimisation, or blame it for their regression.
   *
   * So everything here is an A/B inside ONE session, one lever at a time,
   * which is the same argument `gpu-compare.mjs` opens with.
   */
  const r = await page.evaluate(async () => {
    const R = window.RR;
    const gl = R.renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    R.renderer.setPixelRatio(1);
    R.renderer.setSize(2560, 1440, false);
    R.camera.aspect = 2560 / 1440;
    R.camera.updateProjectionMatrix();
    R.pipeline.setSize(2560, 1440, 1);

    // ---- CPU: what applyDay + stepSun cost per frame ----------------------
    const cpu = (fn, n) => {
      for (let i = 0; i < 200; i++) fn(i);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) fn(i);
      return ((performance.now() - t0) / n) * 1000; // microseconds
    };
    const applyOnly = cpu((i) => R.atmosphere.applyDay(0.3 + (i % 1000) / 20000), 20000);
    const bothOfThem = cpu((i) => {
      const p = 0.3 + (i % 1000) / 20000;
      R.atmosphere.applyDay(p);
      R.atmosphere.stepSun(p);
    }, 20000);

    // ---- GPU: the star and moon branch, on against off --------------------
    const timed = async (setup) => {
      setup();
      const frame = () => R.pipeline.render(1 / 60);
      for (let i = 0; i < 12; i++) frame();
      gl.finish();
      const N = 24;
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      for (let i = 0; i < N; i++) frame();
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      gl.flush();
      for (let t = 0; t < 40; t++) {
        await sleep(60);
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      }
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      gl.deleteQuery(q);
      return ns / 1e6 / N;
    };
    const night = R.atmosphere.skyUniforms.uNight.value;
    // Nose in the air from the clearing, which is the most sky a frame ever
    // has and therefore the worst case for a per-sky-pixel branch.
    R.controller.position.set(0, R.controller.position.y, 5);
    R.controller.yaw = 0.6;
    R.controller.pitch = 1.32;
    R.controller.applyToCamera();
    R.atmosphere.follow(R.camera, R.controller.position);
    R.atmosphere.applyDay(0.03);
    R.forest.cull(R.camera, true);
    /**
     * FIVE INTERLEAVED ROUNDS AND A MEDIAN, not one A and one B.
     *
     * The GPU clock on this machine drifts by more than a millisecond between
     * separate runs — the note on the sky's renderOrder in atmosphere.js was
     * measured this way for exactly that reason, and a README entry was wrong
     * for a while because it had not been. A single A/B here gave −0.074 ms for
     * a branch that cannot possibly be negative, which is the measurement
     * telling you its own error bar.
     */
    const onRuns = [];
    const offRuns = [];
    for (let i = 0; i < 5; i++) {
      onRuns.push(await timed(() => night.set(0, 0, 1, 1)));
      offRuns.push(await timed(() => night.set(0, 0, 0, 0)));
    }
    const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const starsOn = med(onRuns);
    const starsOff = med(offRuns);
    const spread = Math.max(...onRuns) - Math.min(...onRuns);
    R.atmosphere.applyDay(0.5);
    const noonSky = await timed(() => {});

    // ---- the shadow spike, timed on its own -------------------------------
    R.atmosphere.applyDay(0.5);
    const plain = await timed(() => {});
    const withShadow = await timed(() => {
      R.renderer.shadowMap.autoUpdate = true;
    });
    R.renderer.shadowMap.autoUpdate = false;
    R.atmosphere.day.set(null);
    return { applyOnly, bothOfThem, starsOn, starsOff, spread, noonSky, plain, withShadow };
  });
  console.log('  CPU, per frame, at 2560×1440 (microseconds)');
  console.log(`    applyDay alone                  ${r.applyOnly.toFixed(2)} µs`);
  console.log(`    applyDay + stepSun              ${r.bothOfThem.toFixed(2)} µs   = ${(r.bothOfThem / 1000).toFixed(4)} ms/frame\n`);
  console.log('  GPU, nose in the air from the clearing — the most sky a frame gets');
  console.log(`    stars and moon OFF              ${r.starsOff.toFixed(3)} ms   (median of 5)`);
  console.log(`    stars and moon ON               ${r.starsOn.toFixed(3)} ms   (median of 5)`);
  console.log(
    `    the night sky branch costs      ${(r.starsOn - r.starsOff).toFixed(3)} ms   ` +
      `run-to-run spread ±${(r.spread / 2).toFixed(3)}\n`
  );
  console.log('  GPU, the shadow spike this is all arranged around');
  console.log(`    shadow map cached               ${r.plain.toFixed(3)} ms`);
  console.log(`    shadow map every frame          ${r.withShadow.toFixed(3)} ms`);
  console.log(`    one re-render                   ${(r.withShadow - r.plain).toFixed(3)} ms`);
  console.log(
    `    at 7.8 a minute, amortised      ${((((r.withShadow - r.plain) * 7.8) / 60 / 1000) * 1000).toFixed(4)} ms per second of play\n`
  );
}

// ---------------------------------------------------------------------------
// levels
// ---------------------------------------------------------------------------
if (want('levels')) {
  console.log('LEVELS — the four presets must still agree about what the wood looks like\n');
  const rows = [];
  for (const [hourName, phase] of [['morning', 0.3758], ['noon', 0.5], ['dusk', 0.815], ['night', 0.03]]) {
    const byLevel = {};
    for (const level of ['low', 'medium', 'high', 'ultra']) {
      await page.evaluate((l) => window.RR.debug && window.__setLevel(l), level).catch(() => {});
      await page.evaluate(async (l) => {
        const { quality } = await import('/src/core/quality.js');
        quality.setMode(l);
      }, level);
      await page.waitForTimeout(400);
      const per = [];
      for (const s of STATIONS) {
        await park(s, phase);
        const st = await page.evaluate(() => window.__lum());
        per.push(st);
      }
      byLevel[level] = per;
    }
    rows.push([hourName, byLevel]);
  }
  await page.evaluate(async () => {
    const { quality } = await import('/src/core/quality.js');
    quality.setMode('high');
  });
  for (const [hourName, byLevel] of rows) {
    console.log(`  ${hourName}`);
    console.log(
      '    level    ' +
        STATIONS.map((s) => s.name.padStart(8)).join('') +
        '   worst |Δ| lum   worst |Δ| R:G'
    );
    for (const level of ['low', 'medium', 'high', 'ultra']) {
      const dl = byLevel[level].map((v, i) => v.lum - byLevel.high[i].lum);
      /**
       * R:G as well as luminance, because the block on NO_SHADOW_SUN_COLOUR is
       * emphatically about HUE and not about brightness: with no shadow map the
       * sun reaches the dry khaki end of the terrain blend instead of the mossy
       * shaded one, and the fix was a hue rotation at constant luminance. That
       * fit was made against one sun; the clock now has a hundred and forty of
       * them, so the number that has to be checked at the new hours is this one.
       */
      const dr = byLevel[level].map((v, i) => v.r / v.g - byLevel.high[i].r / byLevel.high[i].g);
      console.log(
        `    ${level.padEnd(8)} ` +
          byLevel[level].map((v) => v.lum.toFixed(1).padStart(8)).join('') +
          `   ${Math.max(...dl.map(Math.abs)).toFixed(2).padStart(11)}   ${Math.max(...dr.map(Math.abs))
            .toFixed(3)
            .padStart(12)}`
      );
    }
    console.log('');
  }
}

const real = noise.filter((n) => !/Mismatch between texture format and sampler type/.test(n));
if (real.length) {
  console.log('console errors:');
  for (const n of new Set(real.map((x) => x.slice(0, 120)))) console.log('  -', n);
}
writeFileSync(`${OUT}/.ran`, new Date().toISOString());
await browser.close();
