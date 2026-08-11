import { chromium } from 'playwright';

/**
 * Hunt the hitch.
 *
 *   node scripts/stutter.mjs [--url=…] [--width=1600] [--height=900] [--headless]
 *
 * The complaint this exists for is "frame stutters, sometimes the screen
 * freezes when I move" — which is a SPIKE problem, and every other timing tool
 * in this repo measures throughput. `perf.mjs` reports a median between rAF
 * callbacks, which vsync pins to 16.7 ms and which a single 400 ms frame in a
 * thousand cannot move at all. `gpu-perf.mjs` reports the steady-state GPU cost
 * of a frame it renders itself, in a loop, with the camera parked — which is
 * exactly the condition under which none of the suspects here ever fire.
 *
 * So this one walks. It drives the real controller with real key events, turns
 * the head while it does, and records every frame individually along with the
 * things that only happen when you move:
 *
 *   - did the shadow map re-render this frame (atmosphere.follow steps its
 *     anchor every 8 m and arms `shadowMap.needsUpdate`)
 *   - did the instance culler repack, and how many instance matrices did it
 *     re-upload
 *   - did `renderer.info.programs` grow — direct evidence of a lazy shader
 *     compile, which is a synchronous multi-hundred-millisecond stall
 *   - did the JS heap shrink (a GC pause, near enough)
 *   - did the music scheduler run
 *   - where was the player standing
 *
 * TWO MEASUREMENT TRAPS, both of which have already produced a confidently
 * wrong answer in this project.
 *
 * 1. GPU timer queries in a HIDDEN page under-report catastrophically —
 *    ~22 ms reported for a frame that really cost ~88 ms. So this runs HEADED
 *    by default. `--headless` exists only for CI and its GPU numbers are not
 *    to be believed.
 * 2. With vsync on, the frame delta is quantized to the refresh interval, so a
 *    3 ms overrun and a 15 ms overrun both read as "33 ms". Every sample here
 *    therefore carries a second number: the main thread's own cost, measured
 *    from the first statement of the app's frame() to the last. Frame delta is
 *    what the player feels; CPU cost is what says whether the main thread or
 *    the GPU caused it.
 *
 * The two A/B segments at the end are the actual proof. Neutralising ONE
 * suspect and re-walking the same path is the only thing that separates
 * correlation from cause, and both neutralisations are non-destructive: the
 * shadow one leaves the map stale, the cull one leaves the packed set stale.
 * Both look wrong on screen and neither changes what is being timed.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const URL = args.url ?? 'http://127.0.0.1:5180/';
const WIDTH = Number(args.width ?? 1600);
const HEIGHT = Number(args.height ?? 900);
const HEADLESS = args.headless === 'true';
const WORST = Number(args.worst ?? 14);
/**
 * Internal render resolution, independent of the window.
 *
 * This matters more than it looks. A spike is only felt as a spike if the GPU
 * has no headroom to absorb it: in a 1600×900 window this machine runs the
 * whole game at 240 fps, and a repack that costs the GPU an extra 15 ms is
 * hidden inside a queue that was three frames deep anyway. The complaint came
 * from a 2560×1440 screen, so measure there — `setSize(w, h, false)` raises
 * the drawing buffer while leaving the CSS size alone, which is the same trick
 * gpu-perf.mjs uses and keeps the window visible (see the hidden-pane trap).
 */
const RENDER = String(args.render ?? '2560x1440')
  .split('x')
  .map(Number);

const browser = await chromium.launch({
  headless: HEADLESS,
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

/**
 * Watch for Vite touching the page mid-run.
 *
 * An HMR update re-executes a module and can rebuild half the world, which is
 * a several-hundred-millisecond stall that has nothing whatever to do with the
 * game. On a repo with more than one person (or agent) editing it, that will
 * happen in the middle of a two-minute measurement and be indistinguishable
 * from the bug — so it is recorded and printed rather than left to be
 * misattributed.
 */
const hmr = [];
const started = Date.now();
/**
 * True from the moment the gate is dismissed and the walk begins.
 *
 * Now that `/@vite/client` is left to run for real (see the routeWebSocket
 * block below), its very first line logs `[vite] connecting...`
 * unconditionally, seconds before the gate is even clicked — that is expected
 * boilerplate, not contamination, and counting it would print "VITE TOUCHED
 * THE PAGE MID-RUN" on every single run for no reason. A REAL reload during
 * the walk still logs its own fresh `connecting...`, which this does not
 * mask, because it only happens once `walkStarted` has flipped.
 */
let walkStarted = false;
page.on('console', (m) => {
  const t = m.text();
  if (walkStarted && t.includes('[vite]')) hmr.push({ t: Date.now() - started, text: t.slice(0, 120) });
});

/**
 * And then stop it happening at all.
 *
 * The obvious way to do this is routing `/@vite/client` through
 * `route.abort()` — and on this project that is a trap. It silently corrupts
 * `define` substitution for EVERY OTHER module: `__PERF__` stops being
 * replaced with `true` anywhere in main.js's served source, so every frame
 * throws `ReferenceError: __PERF__ is not defined` and the probe records zero
 * frames with no explanation (see the perf-audit notes' "fourth measurement
 * trap"). `route.fulfill()` with an empty module is not a fix either — same
 * corruption, plus a second error from settings.js's `import.meta.hot`
 * finding `/@vite/client` no longer exports `createHotContext`. Bisected with
 * a minimal harness: what actually matters is whether `/@vite/client`'s OWN
 * SCRIPT fetches and evaluates successfully — abort and empty-fulfill both
 * prevent that and both corrupt __PERF__ identically, even though nothing in
 * main.js's own graph ever references `/@vite/client`. Whether its websocket
 * then completes a real handshake turns out not to matter at all.
 *
 * So: let the script run for real, and mock only the HMR websocket it opens,
 * identifiable by its `?token=` query (this project's own multiplayer socket
 * lives at `/ws` and never carries that param). Not calling
 * `connectToServer()` inside the handler means Playwright fakes a successful
 * open and never talks to the real dev server, so no `full-reload` (or any
 * other) message can ever arrive — the page cannot be reloaded or patched out
 * from under a two-minute measurement — while `/@vite/client` itself is
 * textually and behaviourally untouched. Pass --hmr to skip this too, if you
 * actually want to watch an edit land.
 */
if (args.hmr !== 'true') {
  await page.routeWebSocket(
    (url) => url.searchParams.has('token'),
    (ws) => {} // never connectToServer() — a silent, permanent mock.
  );
}

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });

/**
 * Instrumented BEFORE the gate is dismissed.
 *
 * The gate is the last moment at which a warm-up would be free, so it is also
 * the moment a lazy compile is most likely to be sitting just after. Installing
 * the probe first means the very first walked frames are in the record.
 */
const installProbe = () =>
  page.evaluate(() => {
  const R = window.RR;
  // Re-entry guard. framenavigated can fire for reasons that did not throw the
  // context away, and installing the wrappers twice would double-count every
  // number in the report.
  if (window.__ST && window.__ST.installed) return null;
  const S = {
    installed: true,
    frames: [],
    longtasks: [],
    phase: 'boot',
    yawRate: 0,
    // Per-frame scratch, filled by the wrappers, drained by the end-of-frame hook.
    cullMs: 0,
    cullRepacked: 0,
    cullUploaded: 0,
    shadowMs: 0,
    shadowDid: 0,
    renderMs: 0,
    sceneMs: 0,
    /** Draw calls in the scene pass. See where it is written for why not at frame end. */
    sceneCalls: 0,
    audioMs: 0,
    glCompileMs: 0,
    glCompileN: 0,
    glTexMs: 0,
    glTexN: 0,
    glBufMs: 0,
    glBufN: 0,
    glSyncMs: 0,
    glDrawMax: 0,
    frameStart: 0,
    lastEnd: 0,
    lastHeap: 0,
    lastPrograms: 0,
    // Experiment switches, flipped from the driver.
    suppressShadowUpdate: false,
    suppressCull: false,
    forceShadowUpdate: false,
    forceCull: false,
    /**
     * Radians of yaw thrown in per frame, at random.
     *
     * A constant yaw rate is not how anyone looks around. A human flick is
     * 500–2000°/s, which crosses the culler's 3° repack threshold several
     * times over in a single frame — so a smooth pan measures the culler in
     * its best case and mouse-look measures it in its worst. Since pointer
     * lock is refused under webdriver, the yaw is written directly.
     */
    flick: 0,
  };
  window.__ST = S;

  // Instanced meshes, gathered once: the per-frame cost of a scene traverse
  // would land in the very measurement it is there to explain.
  const instanced = [];
  R.scene.traverse((o) => {
    if (o.isInstancedMesh) instanced.push(o);
  });

  /**
   * Wrap the GL calls that can block, at the prototype.
   *
   * `renderer.info.programs.length` is NOT a sufficient compile detector: when
   * a material recompiles, three releases the old program and acquires a new
   * one, so the array length is unchanged and a hundred recompiles read as
   * zero. Counting `linkProgram` and, more to the point, the
   * `getProgramParameter(LINK_STATUS)` that forces the driver to finish the
   * link, is the only way to see it. On ANGLE/D3D11 that call is where the
   * HLSL compile actually lands, and it is synchronous.
   *
   * Texture and buffer uploads are wrapped for the same reason — a first-visit
   * stall that is not a compile is almost always an upload.
   */
  const wrap = (proto, names, bucketMs, bucketN) => {
    for (const name of names) {
      const orig = proto[name];
      if (typeof orig !== 'function') continue;
      proto[name] = function (...a) {
        const t0 = performance.now();
        const r = orig.apply(this, a);
        S[bucketMs] += performance.now() - t0;
        if (bucketN) S[bucketN]++;
        return r;
      };
    }
  };
  const ctxProto = window.WebGL2RenderingContext
    ? window.WebGL2RenderingContext.prototype
    : window.WebGLRenderingContext.prototype;
  wrap(
    ctxProto,
    ['compileShader', 'linkProgram', 'getShaderParameter', 'getProgramParameter',
     'getProgramInfoLog', 'getShaderInfoLog', 'getUniformLocation', 'getAttribLocation'],
    'glCompileMs',
    'glCompileN'
  );
  wrap(
    ctxProto,
    ['texImage2D', 'texImage3D', 'texSubImage2D', 'texSubImage3D', 'texStorage2D',
     'texStorage3D', 'compressedTexImage2D', 'generateMipmap'],
    'glTexMs',
    'glTexN'
  );
  wrap(ctxProto, ['bufferData', 'bufferSubData'], 'glBufMs', 'glBufN');
  wrap(ctxProto, ['finish', 'readPixels', 'clientWaitSync', 'getError'], 'glSyncMs', null);

  /**
   * The single slowest draw call of the frame.
   *
   * On ANGLE the D3D shader compile does not land in `linkProgram` — Chrome
   * has KHR_parallel_shader_compile, so the link returns immediately and the
   * driver finishes the translation on a worker. The stall, when there is one,
   * lands on the first DRAW that uses the program. So a compile that the link
   * counters cannot see shows up here as one enormous drawElements.
   */
  for (const name of ['drawElements', 'drawElementsInstanced', 'drawArrays', 'drawArraysInstanced']) {
    const orig = ctxProto[name];
    if (typeof orig !== 'function') continue;
    ctxProto[name] = function (...a) {
      const t0 = performance.now();
      const r = orig.apply(this, a);
      const ms = performance.now() - t0;
      if (ms > S.glDrawMax) S.glDrawMax = ms;
      return r;
    };
  }

  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      S.longtasks.push({ t: e.startTime, ms: e.duration, phase: S.phase });
    }
  }).observe({ entryTypes: ['longtask'] });

  // ---- frame start -------------------------------------------------------
  const origController = R.controller.update.bind(R.controller);
  R.controller.update = function (dt) {
    S.frameStart = performance.now();
    if (S.yawRate) R.controller.yaw += S.yawRate * Math.min(dt, 0.05);
    if (S.flick) R.controller.yaw += (Math.random() * 2 - 1) * S.flick;
    if (S.forceShadowUpdate) R.renderer.shadowMap.needsUpdate = true;
    return origController(dt);
  };

  // ---- the shadow pass ---------------------------------------------------
  const sm = R.renderer.shadowMap;
  const origShadow = sm.render.bind(sm);
  sm.render = function (lights, scene, camera) {
    const willRender = sm.enabled && (sm.autoUpdate || sm.needsUpdate) && lights.length > 0;
    if (willRender && S.suppressShadowUpdate) {
      sm.needsUpdate = false;
      return;
    }
    const t0 = performance.now();
    origShadow(lights, scene, camera);
    if (willRender) {
      S.shadowMs = performance.now() - t0;
      S.shadowDid = 1;
    }
  };

  // ---- the culler --------------------------------------------------------
  const origCull = R.forest.cull;
  R.forest.cull = function (camera, force) {
    if (S.suppressCull && !force) return false;
    const t0 = performance.now();
    const repacked = origCull(camera, force || S.forceCull);
    S.cullMs = performance.now() - t0;
    if (repacked) {
      S.cullRepacked = 1;
      // The culler's own count of instances it actually re-copied. Falling back
      // to the drawn total is what an older culler deserves: it re-copied all
      // of them, every time.
      if (R.forest.culler && R.forest.culler.uploaded !== undefined) {
        S.cullUploaded = R.forest.culler.uploaded;
      } else {
        let n = 0;
        for (const m of instanced) n += m.count;
        S.cullUploaded = n;
      }
    }
    return repacked;
  };

  // ---- the render --------------------------------------------------------
  // Split scene from post: they fail for completely different reasons, and a
  // single "render took 200 ms" number cannot tell you which one did.
  let renderCall = 0;
  const origThreeRender = R.renderer.render.bind(R.renderer);
  R.renderer.render = function (scene, camera) {
    const t0 = performance.now();
    origThreeRender(scene, camera);
    if (renderCall++ === 0) {
      S.sceneMs = performance.now() - t0;
      /**
       * READ HERE, INSIDE THE FIRST RENDER, AND NOT AT THE END OF THE FRAME.
       *
       * `renderer.info` resets itself at the top of every `renderer.render()`,
       * and a frame is several of those — the world, a bright pass, a bloom
       * chain, the output pass. The end-of-frame read this column used to do
       * therefore reported the fullscreen output quad and printed a constant
       * `1` in every row of every run. Taken from immediately after the FIRST
       * render instead, it is exactly the scene pass's draw count, which is the
       * number anybody reading a stutter trace actually wants.
       */
      S.sceneCalls = R.renderer.info.render.calls;
    }
  };
  const origRender = R.pipeline.render.bind(R.pipeline);
  R.pipeline.render = function (dt) {
    renderCall = 0;
    const t0 = performance.now();
    origRender(dt);
    S.renderMs = performance.now() - t0;
  };

  // ---- frame end ---------------------------------------------------------
  // debug.update is the last statement of main.js's frame(), which makes it an
  // exact end-of-frame hook and avoids a second rAF whose ordering against the
  // app's own would be one frame ambiguous.
  const origDebug = R.debug.update.bind(R.debug);
  R.debug.update = function (dt, renderer) {
    origDebug(dt, renderer);
    const now = performance.now();
    const heap = performance.memory ? performance.memory.usedJSHeapSize : 0;
    const programs = R.renderer.info.programs ? R.renderer.info.programs.length : 0;
    S.frames.push({
      t: now,
      phase: S.phase,
      dt: S.lastEnd ? now - S.lastEnd : 0,
      cpu: now - S.frameStart,
      cull: S.cullMs,
      repack: S.cullRepacked,
      up: S.cullUploaded,
      shadow: S.shadowMs,
      sdid: S.shadowDid,
      render: S.renderMs,
      scene: S.sceneMs,
      audio: S.audioMs,
      compile: S.glCompileMs,
      compileN: S.glCompileN,
      tex: S.glTexMs,
      texN: S.glTexN,
      buf: S.glBufMs,
      bufN: S.glBufN,
      sync: S.glSyncMs,
      draw: S.glDrawMax,
      dprog: S.lastPrograms ? programs - S.lastPrograms : 0,
      prog: programs,
      // A shrinking heap is the only cheap signal a major GC left behind.
      gc: S.lastHeap && heap < S.lastHeap - 1e6 ? Math.round((S.lastHeap - heap) / 1e6) : 0,
      x: Math.round(R.controller.position.x * 10) / 10,
      z: Math.round(R.controller.position.z * 10) / 10,
      calls: S.sceneCalls,
    });
    S.lastEnd = now;
    S.lastHeap = heap;
    S.lastPrograms = programs;
    S.cullMs = 0;
    S.cullRepacked = 0;
    S.cullUploaded = 0;
    S.shadowMs = 0;
    S.shadowDid = 0;
    S.renderMs = 0;
    S.sceneMs = 0;
    S.audioMs = 0;
    S.glCompileMs = 0;
    S.glCompileN = 0;
    S.glTexMs = 0;
    S.glTexN = 0;
    S.glBufMs = 0;
    S.glBufN = 0;
    S.glSyncMs = 0;
    S.glDrawMax = 0;
  };

  const gl = R.renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
    programs: R.renderer.info.programs ? R.renderer.info.programs.length : 0,
    instanced: instanced.length,
  };
  });

/**
 * Survive a reload rather than half-dying in it.
 *
 * If HMR is left on and another editor saves a file, Vite reloads the page and
 * `window.__ST` goes with it — after which every wrapper is gone, the frame
 * record is empty and the harness keeps running and reporting nothing. That is
 * the worst failure mode this investigation could have, so a navigation
 * re-installs the probe and the run is marked contaminated in the output
 * instead of quietly producing a clean-looking table of nothing.
 */
let reinstalls = 0;
async function install() {
  await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
  const info = await installProbe();
  if (!info) return false;
  console.log(`gl        ${info.renderer}`);
  console.log(`programs  ${info.programs} compiled before the gate`);
  console.log(`instanced ${info.instanced} meshes\n`);
  return true;
}
await install();
page.on('framenavigated', async (frame) => {
  if (frame !== page.mainFrame()) return;
  try {
    // The gate is up again and the render size is back to the window's, so the
    // rest of the run measures something else entirely. Re-installing keeps the
    // harness alive to say so; it does not make the numbers mean anything.
    if (await install()) {
      reinstalls++;
      console.error(
        `\n!! the page reloaded (#${reinstalls}) — probe re-installed, but every ` +
          `number below is contaminated. Run without --hmr.\n`
      );
      await page.click('#enter').catch(() => {});
    }
  } catch {
    /* the run is already lost; the abort path below reports it */
  }
});

await page.click('#enter');
walkStarted = true;
await page.waitForTimeout(1200);

if (RENDER[0] > 0 && RENDER[1] > 0) {
  await page.evaluate(
    ([w, h]) => {
      const R = window.RR;
      R.renderer.setPixelRatio(1);
      R.renderer.setSize(w, h, false);
      R.camera.aspect = w / h;
      R.camera.updateProjectionMatrix();
      R.pipeline.setSize(w, h, 1);
      R.atmosphere.motes.material.uniforms.uPixelRatio.value = 1;
    },
    RENDER
  );
  console.log(`rendering internally at ${RENDER[0]}×${RENDER[1]}\n`);
}

// The jukebox's scheduler is a setInterval on the main thread, so a bar
// boundary is a main-thread spike that has nothing to do with walking. Wrapped
// after the gate because the Jukebox does not exist until then.
await page.evaluate(() => {
  const S = window.__ST;
  const m = window.RR.music;
  if (!m) return;
  const orig = m._schedule.bind(m);
  m._schedule = function () {
    const t0 = performance.now();
    orig();
    S.audioMs += performance.now() - t0;
  };
});

// ---------------------------------------------------------------------------
// the walk
// ---------------------------------------------------------------------------

/**
 * Segments are chosen to separate the suspects by what they respond to.
 *
 * The shadow anchor is a function of POSITION only, and steps every 8 m. The
 * culler repacks on 2.5 m of travel OR 3° of turn. So standing still and
 * spinning fires the culler hard and the shadow map never — which is the one
 * observation that tells the two apart without touching the code.
 */
async function segment(name, ms, { keys = [], yawRate = 0, flick = 0 } = {}) {
  const alive = await page.evaluate(
    ([n, y, f]) => {
      // A Vite full reload wipes the probe. Say so plainly rather than dying
      // with "cannot set property of undefined" three files deep.
      if (!window.__ST) return false;
      window.__ST.phase = n;
      window.__ST.yawRate = y;
      window.__ST.flick = f;
      return true;
    },
    [name, yawRate, flick]
  );
  if (!alive) throw new Error('the page reloaded mid-run — see the vite log below');
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(ms);
  for (const k of keys) await page.keyboard.up(k);
  await page.evaluate(() => {
    if (window.__ST) {
      window.__ST.yawRate = 0;
      window.__ST.flick = 0;
    }
  });
}

const seek = (s) =>
  page.evaluate((v) => (v === null ? window.RR.director.ground() : window.RR.director.seek(v)), s);

const flip = (what, on) =>
  page.evaluate(([w, v]) => {
    if (window.__ST) window.__ST[w] = v;
  }, [what, on]);

const home = () =>
  page.evaluate(() => {
    window.RR.controller.position.set(0, window.RR.controller.position.y, 5);
    window.RR.controller.velocity.set(0, 0, 0);
    window.RR.controller.yaw = 0;
    window.RR.controller.pitch = -0.05;
  });

const WALK = { keys: ['KeyW', 'ShiftLeft'], yawRate: 0.16 };
const LEG = Number(args.leg ?? 8000);

let data = { frames: [], longtasks: [] };
try {
  await segment('settle', 2500);
  await segment('still', 3000);
  // First walk of the session, sober. If anything compiles lazily this is where.
  await segment('walk-first', 10000, { keys: ['KeyW'], yawRate: 0.11 });
  // Standing still and turning fires the culler hard and the shadow anchor
  // never — the observation that tells the two apart without touching code.
  await segment('spin', 5000, { yawRate: 1.5 });

  await home();
  await seek(160);
  await page.waitForTimeout(1500);
  await segment('peak-still', 3000);

  /**
   * The A/B, run TWICE and interleaved.
   *
   * Every leg starts from home with the same keys and the same yaw schedule,
   * so all six cover the same ground. Interleaving matters because this
   * machine's load is not constant — anything that drifts over the two
   * minutes (another process, the GPU clocking down) lands on all three arms
   * roughly equally instead of on whichever one happened to run last.
   */
  for (const round of [1, 2]) {
    for (const arm of ['base', 'noshadow', 'nocull']) {
      await home();
      await flip('suppressShadowUpdate', arm === 'noshadow');
      await flip('suppressCull', arm === 'nocull');
      await page.waitForTimeout(500);
      await segment(`peak-${arm}-${round}`, LEG, WALK);
    }
  }
  await flip('suppressShadowUpdate', false);
  await flip('suppressCull', false);

  /**
   * And the other direction: make each suspect fire on EVERY frame.
   *
   * The A/B above removes one event per few dozen frames, which is a small
   * signal buried in noise. Forcing the same event every frame turns the same
   * question into a difference in the median, where a hundred samples per
   * second beat down the noise instead of feeding it. The per-event cost is
   * (median of the stressed leg − median of the base leg).
   */
  await home();
  await page.waitForTimeout(500);
  await segment('stress-none', LEG, WALK);
  await home();
  await flip('forceShadowUpdate', true);
  await page.waitForTimeout(500);
  await segment('stress-shadow', LEG, WALK);
  await flip('forceShadowUpdate', false);
  await home();
  await flip('forceCull', true);
  await page.waitForTimeout(500);
  await segment('stress-cull', LEG, WALK);
  await flip('forceCull', false);

  // And what a human's mouse hand actually does.
  await home();
  await page.waitForTimeout(500);
  await segment('mouse-look', LEG, { keys: ['KeyW'], flick: 0.09 });
} catch (e) {
  console.error(`\nRUN ABORTED: ${e.message}\n`);
}

/**
 * What one of each event actually costs the GPU.
 *
 * The walk above gives correlation. This gives the number: render N frames
 * with the event forced on every frame, N with it never firing, and take the
 * difference. A timer query around a batch of frames is immune to the
 * one-second bursts of contention that another agent's browser puts on this
 * GPU, which the walk's outliers are full of — a batch either lands in a quiet
 * window or it does not, and it is obvious from the spread which happened.
 *
 * Headed, per the hidden-pane trap: this same query in a hidden page reported
 * 22 ms for a frame that cost 88.
 */
const cost = await page
  .evaluate(async () => {
    const R = window.RR;
    const S = window.__ST;
    if (!S) return null;
    const gl = R.renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return null;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    S.phase = 'gpu-cost';
    S.forceShadowUpdate = false;
    S.forceCull = false;

    const batch = async (before) => {
      const N = 40;
      for (let i = 0; i < 8; i++) {
        before();
        R.pipeline.render(1 / 60);
      }
      gl.finish();
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      for (let i = 0; i < N; i++) {
        before();
        R.pipeline.render(1 / 60);
      }
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

    const nothing = () => {};
    const out = {};
    // Interleaved and repeated: contention on this box arrives in bursts, so
    // A B A B and take the minimum of each rather than one run of each.
    const base = [];
    const shadow = [];
    const cull = [];
    for (let r = 0; r < 3; r++) {
      base.push(await batch(nothing));
      shadow.push(await batch(() => (R.renderer.shadowMap.needsUpdate = true)));
      cull.push(await batch(() => R.forest.cull(R.camera, true)));
    }
    out.base = Math.min(...base);
    out.shadow = Math.min(...shadow);
    out.cull = Math.min(...cull);

    /**
     * How big is the shadow pass as a function of its resolution?
     *
     * If halving the map halves the cost it is fill-bound and the map size is
     * the lever; if it barely moves, the cost is the casting geometry and a
     * smaller map would buy nothing but softer shadows. The CURRENT size is
     * re-measured inside this same loop rather than reusing the number from
     * above — the batches above ran minutes earlier and this GPU is shared
     * with other work, so comparing across that gap is how you conclude that
     * 2048² is three times 1536² when it is not.
     */
    const light = R.atmosphere.sun;
    const was = light.shadow.mapSize.clone();
    for (const size of [2048, 1536, 1024, 2048]) {
      light.shadow.mapSize.set(size, size);
      if (light.shadow.map) {
        light.shadow.map.dispose();
        light.shadow.map = null;
      }
      const runs = [];
      const bases = [];
      for (let r = 0; r < 3; r++) {
        bases.push(await batch(nothing));
        runs.push(await batch(() => (R.renderer.shadowMap.needsUpdate = true)));
      }
      // Named `2048b` on the repeat so a drift between the first and last
      // measurement of the same size is visible rather than averaged away.
      const key = `sweep${size}${out[`sweep${size}`] ? 'b' : ''}`;
      out[key] = Math.min(...runs) - Math.min(...bases);
    }
    light.shadow.mapSize.copy(was);
    if (light.shadow.map) {
      light.shadow.map.dispose();
      light.shadow.map = null;
    }

    /**
     * Is the shadow pass worth a casting set of its own?
     *
     * The map size sweep says the pass is geometry-bound, not fill-bound, so
     * the lever is how many instances are submitted to it — and a good number
     * of them cannot possibly contribute. The culler keeps every tree within
     * 82 m of the EYE so that shadows behind you still land in front of you,
     * but the shadow camera is a 58 m box around the ANCHOR, so the corners of
     * that disc are drawn and clipped; and anything the view frustum kept
     * beyond the box is drawn and clipped too.
     *
     * Building a second, shadow-specific packing is real work, so measure the
     * ceiling first: halve every instance count for the duration of the shadow
     * render and see whether the pass halves with it. If it does not move, the
     * cost is per-draw-call overhead and a smaller instance set buys nothing.
     */
    const meshes = [];
    R.scene.traverse((o) => {
      if (o.isInstancedMesh) meshes.push(o);
    });
    for (const m of meshes) {
      let held = 0;
      m.onBeforeShadow = () => {
        held = m.count;
        m.count = held >> 1;
      };
      m.onAfterShadow = () => {
        m.count = held;
      };
    }
    const halved = [];
    const halvedBase = [];
    for (let r = 0; r < 3; r++) {
      halvedBase.push(await batch(nothing));
      halved.push(await batch(() => (R.renderer.shadowMap.needsUpdate = true)));
    }
    out.shadowHalfSet = Math.min(...halved) - Math.min(...halvedBase);
    for (const m of meshes) {
      m.onBeforeShadow = () => {};
      m.onAfterShadow = () => {};
    }
    if (light.shadow.map) {
      light.shadow.map.dispose();
      light.shadow.map = null;
    }
    R.renderer.shadowMap.needsUpdate = true;
    return out;
  })
  .catch(() => null);

data = await page.evaluate(() =>
  window.__ST ? { frames: window.__ST.frames, longtasks: window.__ST.longtasks } : { frames: [], longtasks: [] }
);

await browser.close();

if (!data.frames.length) {
  if (hmr.length) for (const h of hmr) console.log(`  t≈${(h.t / 1000).toFixed(1)}s  ${h.text}`);
  console.log('no frames captured');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// the report
// ---------------------------------------------------------------------------

const frames = data.frames.filter((f) => f.phase !== 'boot' && f.phase !== 'settle' && f.dt > 0);
const at = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const q = (arr, p) => at(arr.slice().sort((a, b) => a - b), p);
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

const order = [];
for (const f of frames) if (!order.includes(f.phase)) order.push(f.phase);

console.log('frame delta (what the player feels) and main-thread cost, ms\n');
console.log(
  `${'segment'.padEnd(20)} ${'n'.padStart(5)} ${'p50'.padStart(6)} ${'p90'.padStart(6)} ` +
    `${'p99'.padStart(7)} ${'max'.padStart(8)}   ${'cpu50'.padStart(6)} ${'cpu99'.padStart(7)} ` +
    `${'cpumax'.padStart(8)}   ${'shdw'.padStart(5)} ${'repack'.padStart(6)}`
);
for (const phase of order) {
  const f = frames.filter((x) => x.phase === phase);
  const d = f.map((x) => x.dt);
  const c = f.map((x) => x.cpu);
  console.log(
    `${phase.padEnd(20)} ${String(f.length).padStart(5)} ` +
      `${q(d, 0.5).toFixed(1).padStart(6)} ${q(d, 0.9).toFixed(1).padStart(6)} ` +
      `${q(d, 0.99).toFixed(1).padStart(7)} ${Math.max(...d).toFixed(1).padStart(8)}   ` +
      `${q(c, 0.5).toFixed(1).padStart(6)} ${q(c, 0.99).toFixed(1).padStart(7)} ` +
      `${Math.max(...c).toFixed(1).padStart(8)}   ` +
      `${String(f.filter((x) => x.sdid).length).padStart(5)} ${String(f.filter((x) => x.repack).length).padStart(6)}`
  );
}

const BUCKETS = [8, 12, 16.7, 20, 25, 33, 50, 100, 250, Infinity];
console.log('\nframe delta histogram, all walking segments');
const walking = frames.filter((f) => !f.phase.includes('still') && f.phase !== 'spin');
let lo = 0;
for (const hi of BUCKETS) {
  const n = walking.filter((f) => f.dt > lo && f.dt <= hi).length;
  const pct = (n / walking.length) * 100;
  const label = hi === Infinity ? `>${lo}` : `${lo}–${hi}`;
  console.log(
    `  ${label.padStart(11)} ms  ${String(n).padStart(6)}  ${pct.toFixed(2).padStart(6)}%  ` +
      '#'.repeat(Math.round(pct / 2))
  );
  lo = hi;
}

console.log(`\nworst ${WORST} frames`);
const worst = frames.slice().sort((a, b) => b.dt - a.dt).slice(0, WORST);
for (const f of worst) {
  console.log(
    `  t=${(f.t / 1000).toFixed(1).padStart(6)}s ${f.phase.padEnd(19)} ` +
      `dt ${f.dt.toFixed(1).padStart(7)}  cpu ${f.cpu.toFixed(1).padStart(7)}  ` +
      `scene ${f.scene.toFixed(1).padStart(6)}  post ${(f.render - f.scene).toFixed(1).padStart(5)}  ` +
      `link ${f.compile.toFixed(1).padStart(6)}(${String(f.compileN).padStart(3)})  ` +
      `tex ${f.tex.toFixed(1).padStart(5)}(${String(f.texN).padStart(2)})  ` +
      `buf ${f.buf.toFixed(1).padStart(5)}  shadow ${f.shadow.toFixed(1).padStart(5)}  ` +
      `cull ${f.cull.toFixed(2).padStart(5)}  ` +
      `${f.sdid ? 'SHADOW ' : '       '}${f.repack ? 'REPACK ' : '       '}` +
      `${f.dprog ? `PROG+${f.dprog} ` : '       '}${f.gc ? `GC-${f.gc}MB ` : '        '}` +
      `@(${f.x}, ${f.z})`
  );
}

function compare(label, hits, misses) {
  if (!hits.length) {
    console.log(`  ${label.padEnd(28)} never fired`);
    return;
  }
  const h = hits.map((f) => f.dt);
  const m = misses.map((f) => f.dt);
  console.log(
    `  ${label.padEnd(28)} ${String(hits.length).padStart(5)} frames   ` +
      `mean dt ${mean(h).toFixed(1)} ms vs ${mean(m).toFixed(1)} ms   ` +
      `p99 ${q(h, 0.99).toFixed(1)} vs ${q(m, 0.99).toFixed(1)}   max ${Math.max(...h).toFixed(1)}`
  );
}

// ---- the A/B, pooled across rounds ----------------------------------------
const arms = ['base', 'noshadow', 'nocull'].map((a) => ({
  name: a,
  f: frames.filter((x) => x.phase.startsWith(`peak-${a}-`)),
}));
if (arms.every((a) => a.f.length)) {
  console.log('\nthe same walk with one suspect neutralised (both rounds pooled)');
  console.log(
    `  ${'arm'.padEnd(10)} ${'n'.padStart(5)} ${'p50'.padStart(6)} ${'p90'.padStart(6)} ` +
      `${'p99'.padStart(7)} ${'p99.9'.padStart(8)} ${'max'.padStart(8)}  ${'>12ms'.padStart(7)}`
  );
  for (const a of arms) {
    const d = a.f.map((x) => x.dt);
    const slow = d.filter((x) => x > 12).length;
    console.log(
      `  ${a.name.padEnd(10)} ${String(d.length).padStart(5)} ` +
        `${q(d, 0.5).toFixed(1).padStart(6)} ${q(d, 0.9).toFixed(1).padStart(6)} ` +
        `${q(d, 0.99).toFixed(1).padStart(7)} ${q(d, 0.999).toFixed(1).padStart(8)} ` +
        `${Math.max(...d).toFixed(1).padStart(8)}  ${String(slow).padStart(4)} ` +
        `(${((slow / d.length) * 100).toFixed(2)}%)`
    );
  }
}

/**
 * PERIODIC AND EPISODIC ARE TWO DIFFERENT BUGS.
 *
 * A cost that fires every 8 m is a steady tax you can feel as a rhythm; a
 * 200 ms event that happens twice in two minutes is what somebody means by
 * "the screen freezes". Pooling them into one p99 hides both. So: the floor is
 * the distribution over frames where NOTHING fired, and everything above the
 * floor's own p99.9 that also had no marker is listed as unexplained, because
 * that residue is the only place a fifth cause could still be hiding.
 */
const quiet = walking.filter((f) => !f.sdid && !f.repack && !f.dprog && !f.gc && f.audio <= 0.2);
const floor99 = q(quiet.map((x) => x.dt), 0.999);
console.log('\nperiodic vs episodic');
console.log(
  `  floor (no event fired)      ${String(quiet.length).padStart(6)} frames  ` +
    `p50 ${q(quiet.map((x) => x.dt), 0.5).toFixed(1)}  p99 ${q(quiet.map((x) => x.dt), 0.99).toFixed(1)}  ` +
    `p99.9 ${floor99.toFixed(1)}  max ${Math.max(...quiet.map((x) => x.dt)).toFixed(1)} ms`
);
const unexplained = quiet.filter((f) => f.dt > Math.max(floor99, 16));
console.log(
  `  unexplained over ${Math.max(floor99, 16).toFixed(1)} ms      ${String(unexplained.length).padStart(6)} frames  ` +
    (unexplained.length
      ? `worst ${Math.max(...unexplained.map((f) => f.dt)).toFixed(1)} ms — ` +
        `${unexplained.filter((f) => f.cpu > f.dt * 0.5).length} of them main-thread-bound`
      : '— nothing above the floor is unaccounted for')
);

console.log('\ncorrelates, over the walking segments');
compare(
  'shadow map re-rendered',
  walking.filter((f) => f.sdid),
  walking.filter((f) => !f.sdid)
);
compare(
  'culler repacked',
  walking.filter((f) => f.repack),
  walking.filter((f) => !f.repack)
);
compare(
  'a program was compiled',
  frames.filter((f) => f.dprog > 0),
  frames.filter((f) => f.dprog === 0)
);
compare(
  'heap shrank (GC)',
  walking.filter((f) => f.gc),
  walking.filter((f) => !f.gc)
);
compare(
  'music scheduler ran',
  walking.filter((f) => f.audio > 0.2),
  walking.filter((f) => f.audio <= 0.2)
);

const shadowFrames = walking.filter((f) => f.sdid);
if (shadowFrames.length) {
  const s = shadowFrames.map((f) => f.shadow);
  console.log(
    `\n  shadow pass CPU: p50 ${q(s, 0.5).toFixed(2)} ms  p99 ${q(s, 0.99).toFixed(2)} ms  ` +
      `max ${Math.max(...s).toFixed(2)} ms  (one every ${(walking.length / shadowFrames.length).toFixed(0)} frames)`
  );
}
const repacks = walking.filter((f) => f.repack);
if (repacks.length) {
  const c = repacks.map((f) => f.cull);
  const u = repacks.map((f) => f.up);
  const moved = repacks.filter((f) => f.up > 0);
  console.log(
    `  cull repack CPU: p50 ${q(c, 0.5).toFixed(2)} ms  p99 ${q(c, 0.99).toFixed(2)} ms  ` +
      `max ${Math.max(...c).toFixed(2)} ms  (one every ${(walking.length / repacks.length).toFixed(1)} frames; ` +
      `${moved.length} of ${repacks.length} moved any bytes at all, mean ` +
      `${(mean(u) / 1000).toFixed(1)}k instances = ${((mean(u) * 64) / 1e6).toFixed(2)} MB per repack)`
  );
}

const first = frames[0];
const last = frames[frames.length - 1];
console.log(
  `\n  programs: ${first.prog} at the first walked frame, ${last.prog} at the last ` +
    `(${last.prog - first.prog} net change — see the link column, which counts recompiles too)`
);
const linkTotal = frames.reduce((a, f) => a + f.compile, 0);
const texTotal = frames.reduce((a, f) => a + f.tex, 0);
const bufTotal = frames.reduce((a, f) => a + f.buf, 0);
const syncTotal = frames.reduce((a, f) => a + f.sync, 0);
const linkFrames = frames.filter((f) => f.compile > 1);
console.log(
  `  gl totals over ${frames.length} frames: link/query ${linkTotal.toFixed(0)} ms in ` +
    `${linkFrames.length} frames over 1 ms (worst ${Math.max(0, ...frames.map((f) => f.compile)).toFixed(0)} ms), ` +
    `texture upload ${texTotal.toFixed(0)} ms, buffer upload ${bufTotal.toFixed(0)} ms, ` +
    `sync ${syncTotal.toFixed(0)} ms`
);

if (cost) {
  console.log('\nGPU cost of one event, timer query, batches of 40 frames, best of 3');
  console.log(`  frame with nothing happening        ${cost.base.toFixed(2).padStart(6)} ms`);
  console.log(
    `  + shadow map re-render every frame   ${cost.shadow.toFixed(2).padStart(6)} ms   ` +
      `→ one shadow update costs ${(cost.shadow - cost.base).toFixed(2)} ms`
  );
  console.log(
    `  + full cull repack every frame       ${cost.cull.toFixed(2).padStart(6)} ms   ` +
      `→ one repack costs ${(cost.cull - cost.base).toFixed(2)} ms`
  );
  if (cost.shadowHalfSet !== undefined) {
    console.log(
      `  same update with half the instances submitted → ${cost.shadowHalfSet.toFixed(2)} ms ` +
        `(a shadow-specific casting set is worth building only if this is well under the full one)`
    );
  }
  const sweep = Object.keys(cost).filter((k) => k.startsWith('sweep'));
  if (sweep.length) {
    console.log('  cost of one shadow update by map size, each against its own base:');
    for (const k of sweep) {
      console.log(`    ${k.replace('sweep', '').padEnd(6)}²  ${cost[k].toFixed(2).padStart(6)} ms`);
    }
  }
}

console.log(`\nlong tasks (>50 ms on the main thread): ${data.longtasks.length}`);
for (const l of data.longtasks.slice().sort((a, b) => b.ms - a.ms).slice(0, 10)) {
  console.log(`  t=${(l.t / 1000).toFixed(1).padStart(6)}s ${l.phase.padEnd(19)} ${l.ms.toFixed(0)} ms`);
}

if (hmr.length) {
  console.log(`\nVITE TOUCHED THE PAGE MID-RUN — treat spikes near these with suspicion:`);
  for (const h of hmr) console.log(`  t≈${(h.t / 1000).toFixed(1)}s  ${h.text}`);
}
if (reinstalls) {
  console.log(
    `\nCONTAMINATED: the page reloaded ${reinstalls} time(s) during the run. ` +
      `Re-run without --hmr before believing any of the above.`
  );
}

if (pageErrors.length) console.log(`\nPAGE ERRORS:\n  ${pageErrors.join('\n  ')}`);
