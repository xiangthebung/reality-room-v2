import { boot, argv, heading, rule, PAD, NUM, DEV_URL, PERF_BUILD_URL, PERF_DIR, writeJson } from './harness.mjs';
import { median, bootstrapCI, decisive, NOISE_FLOOR_MS } from './stats.mjs';

/**
 * WHAT EACH QUALITY PRESET IS ACTUALLY WORTH — and what none of them can touch.
 *
 *   npm run perf:presets
 *   npm run perf:presets -- --stations=clearing,deep,canopy --level=sober
 *   npm run perf:presets -- --reps=2 --anatomy=deep
 *   npm run perf:presets -- --only=ladder      (skip the anatomy experiment)
 *
 * Two questions, and the second is the one worth running this for.
 *
 *   1. THE LADDER. Median GPU and CPU frame time at low/medium/high/ultra, at
 *      three fixed stations, with a scene / post / shadow split. This is the
 *      table a player's quality menu is implicitly promising.
 *
 *   2. THE ANATOMY OF LOW. Given that a machine is already on the cheapest
 *      preset in the game, what is the frame made of? Measured by removal, one
 *      subsystem at a time, plus a "preset floor" arm that drives every
 *      preset-controlled knob to its minimum at once. The residue is the part
 *      of the frame that no setting in the menu can reach, and on this machine
 *      it is most of it.
 *
 *
 * THREE THINGS THIS HAS TO GET RIGHT, ALL OF WHICH ARE EASY TO GET WRONG.
 *
 * THE RIG FIGHTS THE PRESET. `__RR_PERF__.engage()` puts the renderer into the
 * measurement configuration — 2560x1440, ratio 1, MSAA 2, bloom and trail on —
 * and FIVE of the eleven preset knobs write exactly those fields. Measure a
 * preset through the untouched rig and MSAA, bloom, trail, shadow cadence and
 * render scale are all silently pinned at High's values whatever the preset
 * says, so Low and High come out within noise of each other and the report
 * concludes the ladder does nothing. Worse, `renderScale`'s setter calls
 * main.js's `resize()`, which snaps the renderer to the WINDOW (1280x720 here)
 * and quietly changes the workload by a factor of four in the other direction.
 *
 * So the order is: engage, THEN setMode, THEN re-assert the geometry — and the
 * re-assertion deliberately writes only the size, the pixel ratio and the
 * dynamic-resolution pin, never `setSamples`/`bloomEnabled`/`trailEnabled`,
 * which are the preset's to own. The pixel ratio is the preset's own
 * `renderScale`, so the backbuffer really is 1664x936 on Low and 2560x1440 on
 * High: render scale is the biggest lever on the ladder and a rig that
 * normalised it away would be measuring the ladder with its best rung removed.
 *
 * A LEVEL CHANGE RECOMPILES THE WORLD. Turning shadows off marks every material
 * in the scene `needsUpdate`, which is ~22 programs rebuilt synchronously on the
 * next frame. Timing across that measures the compiler. Every block therefore
 * burns WARM_FRAMES after the switch and throws them away before anything is
 * arrived at, on top of the two warm batches the instrument already discards.
 *
 * THE SHADOW PASS IS NOT IN A STANDING FRAME. `shadowMap.autoUpdate` is false in
 * the shipping configuration, and at a station nothing invalidates the map — the
 * camera does not move and the sun is pinned — so the timed frames re-use it and
 * the shadow pass costs zero. That is honest for a player standing still and
 * useless for a player walking, which is when the map is re-rendered. Both are
 * measured: `total` is the cached frame, and `shadow` is the difference against
 * a frame that re-arms the map every time, i.e. what movement costs.
 */

const args = argv({
  stations: 'clearing,deep,canopy',
  level: 'sober',
  reps: '1',
  batch: '24',
  gpuReps: '4',
  cpuFrames: '24',
  anatomy: 'deep',
  only: 'all',
  json: `${PERF_DIR}/presets.json`,
});

const STATIONS = args.stations.split(',').filter(Boolean);
const TRIP = args.level;
const REPS = Number(args.reps);
const BATCH = Number(args.batch);
const GPU_REPS = Number(args.gpuReps);
const CPU_FRAMES = Number(args.cpuFrames);
const LEVELS = ['low', 'medium', 'high', 'ultra'];
const want = (s) => args.only === 'all' || args.only === s;

/**
 * The sweep order: forward then backward, so every level is measured once in
 * the first half of the run and once in the second.
 *
 * A single low-to-ultra sweep charges the whole of the run's thermal and
 * driver-clock drift to Ultra, which is the arm that already looks worst — the
 * error and the expected result point the same way, which is the one direction a
 * benchmark must never be wrong in. The palindrome makes each level's two
 * samples symmetric about the midpoint, so any drift that is linear in time
 * cancels in their mean. Same argument as `pairs` in the instrument, one level
 * up.
 */
const ORDER = [...LEVELS, ...[...LEVELS].reverse()];

const { browser, page, caps } = await boot({
  url: args.build === 'true' ? PERF_BUILD_URL : DEV_URL,
});

if (caps.hidden) {
  console.log(
    'WARNING: the page reports itself hidden. GPU timer queries under-report badly\n' +
      '         in that state — treat every number below as relative-only.\n'
  );
}

/* -------------------------------------------------------------------------- */
/* the in-page half                                                           */
/* -------------------------------------------------------------------------- */

await page.evaluate(() => {
  const R = window.RR;
  const P = window.__RR_PERF__;
  const Q = window.RRSettings;
  const { renderer, camera, scene, pipeline, atmosphere, controller, forest, probe } = R;

  /** The rig's logical size. Matches WIDTH/HEIGHT in src/dev/perf/probe.js. */
  const W = 2560;
  const H = 1440;
  /** Frames burned after a level change, to pay for the shader rebuild. */
  const WARM_FRAMES = 90;

  const gl = () => renderer.getContext();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

  /**
   * Re-assert the measurement geometry after a preset has moved it.
   *
   * Everything here is a property of the RIG (how big the picture is, whether
   * the resolution controller is allowed to move it). Nothing here is a property
   * of the PRESET — no `setSamples`, no `bloomEnabled`, no `trailEnabled`, no
   * shadow-map size — because those are the things being measured, and writing
   * them here is how a preset comparison comes out flat.
   *
   * `pixelRatio` IS the preset's render scale, on a fixed logical size, which is
   * exactly the shape main.js's `resize()` gives it: `BASE_PIXEL_RATIO *
   * renderScale` against a fixed window.
   */
  function rig(scale) {
    renderer.setPixelRatio(scale);
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    pipeline.setSize(W, H, scale);
    // The resolution controller reads a GPU timer of its own and would move the
    // viewport underneath the measurement.
    pipeline.setDynamicResolution(false, { measure: false });
    pipeline.pinScale(1);
    // The shipping cadence: the map is re-rendered on demand, not every frame.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    // Point sprites size themselves in pixels and have to be told the ratio moved.
    R.fauna?.setPixelRatio?.(scale);
    R.caves?.setPixelRatio?.(scale);
    R.gathering?.setPixelRatio?.(scale);
    if (atmosphere.motes?.material?.uniforms?.uPixelRatio) {
      atmosphere.motes.material.uniforms.uPixelRatio.value = scale;
    }
  }

  /** The frame the game draws while you walk. Mirrors `arrive`'s closure. */
  function makeFrame({ armed = false } = {}) {
    return () => {
      atmosphere.follow(camera, controller.position);
      forest.cull(camera);
      if (armed) renderer.shadowMap.needsUpdate = true;
      pipeline.render(1 / 60);
    };
  }

  /**
   * The world pass alone: everything that goes into the scene target, and none
   * of the bloom mips, the wake or the output quad.
   *
   * Subtracting this from the full frame is the only way to price the post chain
   * without editing pipeline.js. It is a slight UNDER-estimate of the scene and
   * therefore a slight over-estimate of post: the multisample resolve of the
   * scene target is deferred until something samples its texture, which is the
   * first post pass, so the resolve is charged to post here. With MSAA off —
   * which is Low and Medium — there is no resolve and the split is exact.
   */
  function makeSceneOnlyFrame() {
    return () => {
      atmosphere.follow(camera, controller.position);
      forest.cull(camera);
      renderer.setRenderTarget(pipeline.sceneTarget);
      renderer.render(scene, camera);
    };
  }

  /** One timer query around `n` frames, in ms per frame. Copy of the probe's. */
  async function batchMs(frame, n) {
    const c = gl();
    const ext = c.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) throw new Error('EXT_disjoint_timer_query_webgl2 unavailable');
    c.getParameter(ext.GPU_DISJOINT_EXT); // read to clear
    const q = c.createQuery();
    c.beginQuery(ext.TIME_ELAPSED_EXT, q);
    for (let i = 0; i < n; i++) frame();
    c.endQuery(ext.TIME_ELAPSED_EXT);
    c.flush();
    for (let t = 0; t < 60; t++) {
      await sleep(50);
      if (c.getQueryParameter(q, c.QUERY_RESULT_AVAILABLE)) break;
    }
    const available = c.getQueryParameter(q, c.QUERY_RESULT_AVAILABLE);
    const disjoint = c.getParameter(ext.GPU_DISJOINT_EXT);
    const ns = available ? c.getQueryParameter(q, c.QUERY_RESULT) : 0;
    c.deleteQuery(q);
    if (!available || disjoint) return NaN;
    return ns / 1e6 / n;
  }

  /**
   * MAIN-THREAD time for one frame, with the GPU queue empty.
   *
   * Timing frames back to back does not measure the CPU: after two or three
   * frames the driver's queue is full and every subsequent `render()` blocks
   * until a slot frees, so the wall clock converges on the GPU time and the
   * report claims the frame is CPU-bound when it is the opposite. `finish()`
   * before each sample drains the queue, so the one frame that follows measures
   * scene graph traversal, culling, the render-list build and driver submission
   * — and nothing it is waiting on.
   */
  function cpuMs(frame, n) {
    const c = gl();
    const out = [];
    for (let i = 0; i < n; i++) {
      c.finish();
      const t0 = performance.now();
      frame();
      out.push(performance.now() - t0);
    }
    c.finish();
    return out;
  }

  /** Hide a set of objects, remembering what they were, so it can be undone. */
  function hider() {
    const saved = [];
    return {
      hide(objects) {
        for (const o of objects) {
          if (!o) continue;
          saved.push([o, o.visible]);
          o.visible = false;
        }
        // A caster that just vanished leaves a stale shadow map behind.
        renderer.shadowMap.needsUpdate = true;
      },
      restore() {
        for (const [o, v] of saved) o.visible = v;
        saved.length = 0;
        renderer.shadowMap.needsUpdate = true;
      },
    };
  }

  const layerObjects = (names) => {
    const out = [];
    for (const n of names) {
      const fn = probe.layers[n];
      if (!fn) continue;
      for (const o of fn() ?? []) out.push(o);
    }
    return out;
  };

  /** Counters for one frame, with autoReset off so every pass is included. */
  function counters(frame) {
    const info = renderer.info;
    info.autoReset = false;
    info.reset();
    frame();
    const c = {
      calls: info.render.calls,
      triangles: info.render.triangles,
      points: info.render.points,
      sceneCalls: pipeline.sceneStats?.calls ?? 0,
      sceneTriangles: pipeline.sceneStats?.triangles ?? 0,
    };
    info.autoReset = true;
    return c;
  }

  window.__PRESETS__ = {
    W,
    H,

    /** Everything the instrument's rig needs, done once. */
    engage() {
      P.engage();
      return true;
    },

    /**
     * Move to a preset and put the geometry back, then burn the recompile.
     *
     * `setMode` is the same call the quality menu makes. Under `navigator.
     * webdriver` the Auto governor is off, so the level stays where it is put.
     */
    async setLevel(level) {
      Q.setMode(level);
      const scale = Q.get('renderScale');
      rig(scale);
      const frame = makeFrame({ armed: false });
      // Consume the ~22 programs the level change just invalidated. Rendering
      // is what compiles them; the yields let the browser breathe.
      for (let i = 0; i < WARM_FRAMES; i++) {
        frame();
        if (i % 15 === 14) await nextFrame();
      }
      gl().finish();
      return {
        level,
        scale,
        backbuffer: [renderer.domElement.width, renderer.domElement.height],
        samples: pipeline.sceneTarget.samples,
        bloom: !!pipeline.bloomEnabled,
        trail: !!pipeline.trailEnabled,
        shadows: !!renderer.shadowMap.enabled,
        shadowMap: atmosphere.sun.shadow.mapSize.width,
        knobs: Object.fromEntries(
          ['renderScale', 'msaa', 'shadows', 'shadowMapSize', 'shaftDensity', 'mistLayers',
            'bloom', 'trail', 'fogDistance', 'particleDensity', 'instanceDensity',
          ].map((k) => [k, Q.get(k)])
        ),
      };
    },

    /** Stand at a station and wait for the wood to finish arriving. */
    async arrive(station, level) {
      const r = await P.scenario({ station, level }, { reps: 0, batch: 8 });
      return { settle: r.settle, structural: r.structural };
    },

    /**
     * The full measurement at wherever we are standing.
     *
     * THE THREE FRAME KINDS ARE INTERLEAVED, NOT MEASURED IN SEQUENCE, and the
     * first version of this did the sequential thing and produced two impossible
     * results with it: a scene pass that cost MORE than the whole frame it is a
     * part of (2.86 against 2.58 ms), and a 0.45 ms shadow pass on a preset that
     * has no shadows at all. Neither was a bug in the split — both were the GPU's
     * clock and temperature moving under a run that charged every millisecond of
     * that movement to whichever arm happened to go last.
     *
     * Running them cached-scene-armed-armed-scene-cached puts each arm's two
     * samples symmetrically about the middle of the block, so drift that is
     * linear across the block cancels in their mean. It is the same palindrome
     * the level sweep uses, one level down, and for exactly the same reason.
     */
    async measure({ reps, batch, cpuFrames }) {
      const cached = makeFrame({ armed: false });
      const armed = makeFrame({ armed: true });
      const sceneOnly = makeSceneOnlyFrame();
      const c = counters(cached);

      // Warm all three: each has its own programs and its own first-touch cost.
      await batchMs(cached, batch);
      await batchMs(sceneOnly, batch);
      await batchMs(armed, batch);

      const gpuCached = [];
      const gpuScene = [];
      const gpuArmed = [];
      const take = (into, ms) => {
        if (Number.isFinite(ms)) into.push(ms);
      };
      for (let r = 0; r < reps; r++) {
        const c1 = await batchMs(cached, batch);
        const s1 = await batchMs(sceneOnly, batch);
        const a1 = await batchMs(armed, batch);
        const a2 = await batchMs(armed, batch);
        const s2 = await batchMs(sceneOnly, batch);
        const c2 = await batchMs(cached, batch);
        take(gpuCached, (c1 + c2) / 2);
        take(gpuScene, (s1 + s2) / 2);
        take(gpuArmed, (a1 + a2) / 2);
      }
      const cpu = cpuMs(cached, cpuFrames);
      // Leave the map valid: `armed` re-rendered it, `sceneOnly` did not.
      renderer.shadowMap.needsUpdate = true;
      cached();
      return { counters: c, gpuCached, gpuScene, gpuArmed, cpu };
    },

    /* ---- the anatomy experiment ---------------------------------------- */

    /**
     * What one subsystem is worth, as a paired A-B-B-A difference.
     *
     * A is the frame as it stands, B is the frame with that subsystem removed.
     * Never a single before/after: three runs of identical code on this project's
     * reference machine have come out at 3.84, 6.36 and 4.46 ms, so an unpaired
     * difference is dominated by whatever else was on the GPU at the time.
     */
    async removalPair(spec, { reps, batch }) {
      const h = hider();
      const full = makeFrame({ armed: false });
      const sceneOnly = makeSceneOnlyFrame();

      const armA = async () => {
        h.restore();
        if (spec.knobs) for (const [k, v] of Object.entries(spec.baseKnobs ?? {})) Q.set(k, v);
        const f = full;
        await batchMs(f, batch);
        return batchMs(f, batch);
      };
      const armB = async () => {
        h.restore();
        let f = full;
        if (spec.kind === 'post') {
          f = sceneOnly;
        } else if (spec.kind === 'knobs') {
          for (const [k, v] of Object.entries(spec.knobs)) Q.set(k, v);
        } else {
          h.hide(layerObjects(spec.layers));
          if (spec.objects) h.hide(spec.objects.map((path) => resolve(path)));
        }
        await batchMs(f, batch);
        return batchMs(f, batch);
      };

      const rows = [];
      for (let r = 0; r < reps; r++) {
        const a1 = await armA();
        const b1 = await armB();
        const b2 = await armB();
        const a2 = await armA();
        const a = (a1 + a2) / 2;
        const b = (b1 + b2) / 2;
        rows.push({ a, b, delta: b - a });
      }
      h.restore();
      if (spec.baseKnobs) for (const [k, v] of Object.entries(spec.baseKnobs)) Q.set(k, v);
      return rows;
    },

    /**
     * WHAT AN ARM ACTUALLY REMOVED FROM THE FRAME — the validity check without
     * which every "below the noise floor" row is ambiguous.
     *
     * A layer handle is a `filter` over `forest.group.children` by name, and a
     * name that no longer matches returns an empty list. Hiding nothing costs
     * nothing, so the timing comes back at zero with a tight interval and reads
     * as "this subsystem is free" — which is the same output as "this subsystem
     * was never switched off", and they are opposite conclusions. Draw calls and
     * triangles are exact and reproducible, so a row that removed 0 draws is
     * declaring itself broken rather than cheap.
     */
    removalCensus(spec) {
      const h = hider();
      const full = makeFrame({ armed: false });
      const sceneOnly = makeSceneOnlyFrame();
      const before = counters(full);
      let objects = 0;
      let after;
      if (spec.kind === 'post') {
        after = counters(sceneOnly);
      } else if (spec.kind === 'knobs') {
        for (const [k, v] of Object.entries(spec.knobs)) Q.set(k, v);
        full();
        after = counters(full);
        for (const [k, v] of Object.entries(spec.baseKnobs)) Q.set(k, v);
        full();
      } else {
        const objs = layerObjects(spec.layers);
        objects = objs.length;
        h.hide(objs);
        after = counters(full);
        h.restore();
      }
      full();
      return {
        objects,
        calls: before.calls - after.calls,
        triangles: before.triangles - after.triangles,
        points: before.points - after.points,
      };
    },

    /**
     * HOLD THE PRESET AND MOVE ONLY THE PIXELS.
     *
     * `rig` writes the size, the pixel ratio and nothing else — no knob, no
     * material, no density — so every arm here submits byte-for-byte the same
     * geometry to the same frustum and differs only in how many fragments come
     * out of it. That is the one experiment that separates a frame which is
     * expensive because of what it draws from one that is expensive because of
     * how big it is drawn, and it needs no model to interpret: if the frame does
     * not move when the fragment count falls by three quarters, the fragments
     * were never the cost.
     *
     * Palindromic for the same reason the level sweep is, and each arm is warmed
     * after `setSize` because changing the ratio reallocates the scene target and
     * every bloom mip, and the frame that pays for that must not be in a sample.
     */
    async scaleSweep(scales, { reps, batch }) {
      const out = {};
      for (const s of scales) out[s] = { ms: [], counters: null, backbuffer: null };
      const order = [...scales, ...[...scales].reverse()];
      for (const s of order) {
        rig(s);
        const frame = makeFrame({ armed: false });
        for (let i = 0; i < 40; i++) frame();
        gl().finish();
        await batchMs(frame, batch);
        for (let r = 0; r < reps; r++) {
          const ms = await batchMs(frame, batch);
          if (Number.isFinite(ms)) out[s].ms.push(ms);
        }
        out[s].counters = counters(frame);
        out[s].backbuffer = [renderer.domElement.width, renderer.domElement.height];
      }
      return out;
    },

    /**
     * THE REACH LEVER: move the tree LOD bands and price each setting.
     *
     * `forest.setReach` is the only caller allowed to move these bands, because
     * the near trunk's `max` and the far sweep's `min` have to be written as one
     * value — set them apart and every distant trunk is either drawn twice,
     * z-fighting with itself, or not at all. This just drives it.
     *
     * `cull(camera, true)` immediately afterwards is not optional. `setReach`
     * ends in `culler.invalidate()`, which forgets the camera pose so the next
     * update takes the full-repack path — but the culler still only repacks when
     * something asks it to, and a batch timed before that ask would measure the
     * PREVIOUS arm's instance buffer while reporting the new arm's bands. The
     * counters would agree with the bands and the milliseconds would not, which
     * is the hardest kind of wrong number to notice.
     */
    async reachSweep(arms, { reps, batch }) {
      const out = {};
      for (let i = 0; i < arms.length; i++) out[i] = { ms: [], counters: null, bands: null };
      const idx = arms.map((_, i) => i);
      for (const i of [...idx, ...[...idx].reverse()]) {
        const a = arms[i];
        forest.setReach(a.lod, a.reach, { leafReach: a.leafReach, alwaysNear: a.alwaysNear });
        forest.cull(camera, true);
        const frame = makeFrame({ armed: false });
        for (let k = 0; k < 40; k++) frame();
        gl().finish();
        await batchMs(frame, batch);
        for (let r = 0; r < reps; r++) {
          const ms = await batchMs(frame, batch);
          if (Number.isFinite(ms)) out[i].ms.push(ms);
        }
        out[i].counters = counters(frame);
        out[i].bands = forest.reachStats();
      }
      return out;
    },

    /** Put the wood back the way it ships, and prove it went back. */
    restoreReach() {
      forest.setReach(170, 384, { alwaysNear: 82 });
      forest.cull(camera, true);
      const frame = makeFrame({ armed: false });
      frame();
      return counters(frame);
    },

    counters,
  };

  function resolve(path) {
    let o = R;
    for (const part of path.split('.')) o = o?.[part];
    return o;
  }
});

/* -------------------------------------------------------------------------- */
/* 1. the ladder                                                              */
/* -------------------------------------------------------------------------- */

const report = { caps, spec: { stations: STATIONS, level: TRIP, reps: REPS, batch: BATCH }, ladder: {}, anatomy: null };

await page.evaluate(() => window.__PRESETS__.engage());

/** level -> station -> arrays of samples, one entry per visit. */
const acc = {};
for (const l of LEVELS) {
  acc[l] = { config: null, stations: {} };
  for (const s of STATIONS) acc[l].stations[s] = { gpuCached: [], gpuScene: [], gpuArmed: [], cpu: [], counters: null, settled: true };
}

if (want('ladder')) {
  console.log(
    `ladder: ${LEVELS.join('/')} at ${STATIONS.join(', ')}, trip=${TRIP}\n` +
      `order   ${ORDER.join(' ')}${REPS > 1 ? ` x${REPS}` : ''}   ` +
      `(palindromic, so drift cancels)\n` +
      `rig     2560x1440 logical, pixel ratio = the preset's own render scale\n`
  );

  for (let rep = 0; rep < REPS; rep++) {
    for (const level of ORDER) {
      const cfg = await page.evaluate((l) => window.__PRESETS__.setLevel(l), level);
      acc[level].config = cfg;
      process.stdout.write(
        `  ${PAD(level, 7)} ${String(cfg.backbuffer[0]).padStart(4)}x${cfg.backbuffer[1]}  ` +
          `msaa ${cfg.samples}  shadows ${cfg.shadows ? String(cfg.shadowMap).padEnd(4) : 'off '}  ` +
          `bloom ${cfg.bloom ? 'on ' : 'off'}  mist ${cfg.knobs.mistLayers}  ` +
          `shafts ${cfg.knobs.shaftDensity}  motes ${cfg.knobs.particleDensity}  ` +
          `undergrowth ${cfg.knobs.instanceDensity}\n`
      );
      for (const station of STATIONS) {
        const arrived = await page.evaluate(
          ([s, l]) => window.__PRESETS__.arrive(s, l),
          [station, TRIP]
        );
        const m = await page.evaluate(
          (o) => window.__PRESETS__.measure(o),
          { reps: GPU_REPS, batch: BATCH, cpuFrames: CPU_FRAMES }
        );
        const bin = acc[level].stations[station];
        bin.gpuCached.push(...m.gpuCached);
        bin.gpuScene.push(...m.gpuScene);
        bin.gpuArmed.push(...m.gpuArmed);
        bin.cpu.push(...m.cpu);
        bin.counters = m.counters;
        if (arrived.settle?.settled === false) bin.settled = false;
        process.stdout.write(
          `    ${PAD(station, 10)} gpu ${NUM(median(m.gpuCached), 6)}  cpu ${NUM(median(m.cpu), 6)}  ` +
            `draws ${String(m.counters.calls).padStart(4)}  ` +
            `tris ${(m.counters.triangles / 1e6).toFixed(2).padStart(6)}M` +
            `${arrived.settle?.settled === false ? '   NOT SETTLED' : ''}\n`
        );
      }
    }
  }

  /* ---- the table ------------------------------------------------------- */

  /**
   * `post` and `shadow` are PAIRED differences, not differences of medians.
   *
   * The three frame kinds are sampled inside one interleaved block per
   * repetition (see `measure`), so index i of each array is the same moment of
   * the same block and subtracting index-wise cancels the drift between blocks
   * as well as within them. Differencing two medians instead throws that pairing
   * away and leaves a number whose error is the sum of both arms' — which at
   * this rig's resolution is comfortably larger than the post chain itself on
   * the cheaper presets, and produces negative costs for passes that certainly
   * ran. Anything whose interval straddles zero prints as below the floor rather
   * than as a confident small number.
   */
  const paired = (xs, ys) => xs.map((x, i) => x - ys[i]).filter(Number.isFinite);
  const cell = (deltas, base) => {
    if (deltas.length < 2) return { ms: median(deltas), real: median(deltas) > NOISE_FLOOR_MS };
    const ci = bootstrapCI(deltas);
    return { ms: ci.median, real: decisive(ci, base, { floorMs: NOISE_FLOOR_MS }) };
  };

  console.log(heading('what each preset costs, per station'));
  console.log(
    `${PAD('station', 11)}${PAD('preset', 8)}${'gpu'.padStart(7)}${'cpu'.padStart(7)}` +
      `${'scene'.padStart(8)}${'post'.padStart(7)}${'shadow'.padStart(8)}` +
      `${'vs high'.padStart(9)}${'draws'.padStart(7)}${'tris'.padStart(9)}`
  );
  for (const station of STATIONS) {
    const high = median(acc.high.stations[station].gpuCached);
    for (const level of LEVELS) {
      const b = acc[level].stations[station];
      const gpu = median(b.gpuCached);
      const scene = median(b.gpuScene);
      const post = cell(paired(b.gpuCached, b.gpuScene), gpu);
      const shadow = cell(paired(b.gpuArmed, b.gpuCached), gpu);
      const rel = Number(((gpu / high - 1) * 100).toFixed(0));
      b.split = { gpu, scene, post, shadow, cpu: median(b.cpu) };
      console.log(
        PAD(station, 11) +
          PAD(level, 8) +
          NUM(gpu, 7) +
          NUM(median(b.cpu), 7) +
          NUM(scene, 8) +
          (post.real ? NUM(post.ms, 7) : '—'.padStart(7)) +
          (shadow.real ? NUM(shadow.ms, 8) : '—'.padStart(8)) +
          `${rel > 0 ? '+' : ''}${rel}%`.padStart(9) +
          String(b.counters?.calls ?? 0).padStart(7) +
          `${((b.counters?.triangles ?? 0) / 1e6).toFixed(2)}M`.padStart(9) +
          (b.settled ? '' : '  UNSETTLED')
      );
    }
    console.log('');
  }
  console.log(
    '  gpu      the frame as a standing player pays for it: shadow map cached.\n' +
      '  scene    the world pass into the scene target, no post at all.\n' +
      '  post     gpu - scene, paired. Includes the MSAA resolve, so it is a\n' +
      '           slight over-estimate on High/Ultra and exact on Low/Medium.\n' +
      '  shadow   what re-rendering the shadow map costs — the price of MOVING,\n' +
      '           and nothing at Low, which has no shadows at all.\n' +
      '  cpu      main thread per frame with the GPU queue drained.\n' +
      '  —        the interval straddles zero: smaller than this rig can resolve.'
  );

  console.log(heading('what the ladder is worth'));
  console.log(`${PAD('step', 22)}${'gpu saved'.padStart(11)}${'of the frame'.padStart(14)}`);
  for (const station of STATIONS) {
    console.log(`  ${station}`);
    for (let i = LEVELS.length - 1; i > 0; i--) {
      const hi = median(acc[LEVELS[i]].stations[station].gpuCached);
      const lo = median(acc[LEVELS[i - 1]].stations[station].gpuCached);
      console.log(
        PAD(`    ${LEVELS[i]} -> ${LEVELS[i - 1]}`, 22) +
          NUM(hi - lo, 11) +
          `${(((hi - lo) / hi) * 100).toFixed(0)}%`.padStart(14)
      );
    }
    const top = median(acc.ultra.stations[station].gpuCached);
    const bottom = median(acc.low.stations[station].gpuCached);
    console.log(
      PAD('    ultra -> low', 22) + NUM(top - bottom, 11) + `${(((top - bottom) / top) * 100).toFixed(0)}%`.padStart(14)
    );
  }

  report.ladder = acc;
}

/* -------------------------------------------------------------------------- */
/* 2. the anatomy of low                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The subsystems, and the one arm that is not a subsystem.
 *
 * `preset floor` drives every preset-controlled knob that still has travel below
 * Low to its minimum AT ONCE — MSAA, shadows, bloom and the wake are already off
 * at Low, so what is left is the four density knobs. Whatever survives that arm
 * is the frame the quality menu cannot reach, which is the whole question.
 */
const ARMS = [
  { name: 'canopy (leaves)', kind: 'layers', layers: ['leaves'] },
  {
    name: 'understorey',
    kind: 'layers',
    layers: ['grass', 'ferns', 'meadow', 'bramble', 'bushes', 'saplings', 'sticks', 'flowers', 'litter', 'reeds', 'stumps'],
  },
  { name: 'trunks', kind: 'layers', layers: ['trunks'] },
  { name: 'terrain (ground)', kind: 'layers', layers: ['ground'] },
  { name: 'fauna', kind: 'layers', layers: ['birds', 'butterflies', 'mammals', 'swarm', 'shoal'] },
  { name: 'air (mist/shafts/motes)', kind: 'layers', layers: ['mist', 'shafts', 'motes'] },
  { name: 'sky + water', kind: 'layers', layers: ['sky', 'water'] },
  { name: 'post chain (all of it)', kind: 'post' },
  {
    name: 'preset floor',
    kind: 'knobs',
    knobs: { shaftDensity: 0, mistLayers: 0, particleDensity: 0, instanceDensity: 0.25 },
    baseKnobs: { shaftDensity: 0.3, mistLayers: 1, particleDensity: 0.22, instanceDensity: 0.5 },
  },
];

if (want('anatomy')) {
  const station = args.anatomy;
  console.log(heading(`what LOW's frame is made of, at ${station}`));
  console.log(
    '  Each row is what REMOVING that thing saves, given everything else is\n' +
      '  present, as an A-B-B-A paired difference. They do not sum to the frame\n' +
      '  and are not meant to: a layer that writes depth early can be worth less\n' +
      '  than nothing to remove.\n'
  );

  const cfg = await page.evaluate((l) => window.__PRESETS__.setLevel(l), 'low');
  await page.evaluate(([s, l]) => window.__PRESETS__.arrive(s, l), [station, TRIP]);
  const base = await page.evaluate(
    (o) => window.__PRESETS__.measure(o),
    { reps: GPU_REPS, batch: BATCH, cpuFrames: CPU_FRAMES }
  );
  const total = median(base.gpuCached);
  console.log(
    `  low at ${station}: ${total.toFixed(2)} ms GPU, ${median(base.cpu).toFixed(2)} ms CPU, ` +
      `${cfg.backbuffer[0]}x${cfg.backbuffer[1]}, ${base.counters.calls} draws, ` +
      `${(base.counters.triangles / 1e6).toFixed(2)}M tris\n`
  );
  console.log(
    `${PAD('  removing', 26)}${'saves'.padStart(9)}${'of low'.padStart(8)}` +
      `${'draws'.padStart(8)}${'tris'.padStart(9)}   95% interval`
  );

  const rows = [];
  for (const arm of ARMS) {
    const census = await page.evaluate((a) => window.__PRESETS__.removalCensus(a), arm);
    const raw = await page.evaluate(
      ([a, o]) => window.__PRESETS__.removalPair(a, o),
      [arm, { reps: 3, batch: BATCH }]
    );
    const deltas = raw.map((r) => -r.delta); // flip: report what removal SAVES
    const b = median(raw.map((r) => r.a));
    const ci = bootstrapCI(deltas);
    const real = decisive(ci, b, { floorMs: NOISE_FLOOR_MS });
    rows.push({ name: arm.name, saves: ci.median, lo: ci.lo, hi: ci.hi, base: b, real, census });
    /**
     * A row that removed nothing from the frame is not a cheap subsystem, it is
     * a broken arm, and it says so instead of printing a confident zero.
     */
    const inert = census.calls === 0 && census.triangles === 0 && census.points === 0;
    console.log(
      PAD(`  ${arm.name}`, 26) +
        (real ? `${ci.median.toFixed(2)} ms`.padStart(9) : '—'.padStart(9)) +
        (real ? `${((ci.median / b) * 100).toFixed(0)}%`.padStart(8) : '—'.padStart(8)) +
        String(census.calls).padStart(8) +
        `${(census.triangles / 1e6).toFixed(2)}M`.padStart(9) +
        (inert
          ? '   REMOVED NOTHING — arm is broken, not free'
          : real
            ? `   [${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}]`
            : '   below the noise floor')
    );
  }

  const floor = rows.find((r) => r.name === 'preset floor');
  const untouchable = floor?.real ? total - floor.saves : total;
  console.log(
    `\n  Everything the quality menu can still remove below Low: ` +
      `${floor?.real ? floor.saves.toFixed(2) : '0.00'} ms.\n` +
      `  What is left after that: ${untouchable.toFixed(2)} ms of ${total.toFixed(2)} ` +
      `(${((untouchable / total) * 100).toFixed(0)}% of Low's frame),\n` +
      `  at Low's own render scale. NO PRESET IN THE GAME TOUCHES IT.`
  );

  report.anatomy = { station, total, cpu: median(base.cpu), counters: base.counters, config: cfg, rows, untouchable };
}

/* -------------------------------------------------------------------------- */
/* 3. pixels against geometry, at low                                         */
/* -------------------------------------------------------------------------- */

/**
 * THE ONE MEASUREMENT THAT DECIDES WHETHER THE QUALITY MENU CAN HELP AT ALL.
 *
 * Render scale is the largest lever the ladder has and the only one with travel
 * left below Low, so "turn the resolution down" is the advice a slow machine is
 * going to be given. This tests it rather than assuming it: the preset is pinned
 * at Low and the ONLY thing that moves is the pixel ratio, from 0.35 to 1.0.
 * Every arm submits identical geometry — same instances, same frustum, same
 * densities, same materials — so the whole difference between them is fragments.
 *
 * The fit is the same two-term model `why.mjs` uses (`cost = fixed + perPixel x
 * pixels`), but over five points by least squares rather than two, so the
 * residual is visible and a bad fit cannot masquerade as a confident split.
 */
const SCALES = [0.35, 0.5, 0.65, 0.8, 1];

if (want('split')) {
  const station = args.anatomy;
  console.log(heading(`pixels against geometry at LOW, ${station}`));
  console.log(
    '  Preset pinned at low. Only the pixel ratio moves — identical geometry in\n' +
      '  every row, so every millisecond of difference is fragment cost.\n'
  );

  await page.evaluate((l) => window.__PRESETS__.setLevel(l), 'low');
  await page.evaluate(([s, l]) => window.__PRESETS__.arrive(s, l), [station, TRIP]);
  const sweep = await page.evaluate(
    ([s, o]) => window.__PRESETS__.scaleSweep(s, o),
    [SCALES, { reps: GPU_REPS, batch: BATCH }]
  );

  console.log(
    `${PAD('  renderScale', 15)}${'backbuffer'.padStart(13)}${'Mpixels'.padStart(9)}` +
      `${'gpu ms'.padStart(9)}${'vs 0.65'.padStart(9)}${'draws'.padStart(8)}${'tris'.padStart(9)}`
  );
  const points = [];
  const at065 = median(sweep['0.65'].ms);
  for (const s of SCALES) {
    const row = sweep[String(s)];
    const ms = median(row.ms);
    const px = (row.backbuffer[0] * row.backbuffer[1]) / 1e6;
    points.push({ px, ms });
    console.log(
      PAD(`  ${s.toFixed(2)}${s === 0.65 ? ' (low)' : ''}`, 15) +
        `${row.backbuffer[0]}x${row.backbuffer[1]}`.padStart(13) +
        px.toFixed(2).padStart(9) +
        NUM(ms, 9) +
        `${ms - at065 >= 0 ? '+' : ''}${(ms - at065).toFixed(2)}`.padStart(9) +
        String(row.counters.calls).padStart(8) +
        `${(row.counters.triangles / 1e6).toFixed(2)}M`.padStart(9)
    );
  }

  // Least squares through (pixels, ms).
  const n = points.length;
  const sx = points.reduce((a, p) => a + p.px, 0);
  const sy = points.reduce((a, p) => a + p.ms, 0);
  const sxx = points.reduce((a, p) => a + p.px * p.px, 0);
  const sxy = points.reduce((a, p) => a + p.px * p.ms, 0);
  const perPixel = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const fixed = (sy - perPixel * sx) / n;
  const pxLow = (sweep['0.65'].backbuffer[0] * sweep['0.65'].backbuffer[1]) / 1e6;
  const fillAtLow = perPixel * pxLow;
  const resid = Math.sqrt(
    points.reduce((a, p) => a + (p.ms - (fixed + perPixel * p.px)) ** 2, 0) / n
  );

  console.log(
    `\n  cost = ${fixed.toFixed(2)} ms + ${perPixel.toFixed(3)} ms/Mpixel x pixels   ` +
      `(rms residual ${resid.toFixed(3)} ms)\n`
  );
  console.log(
    `  At low's own 0.65 (${pxLow.toFixed(2)} Mpixel):\n` +
      `    scales with pixels   ${fillAtLow.toFixed(2)} ms   ` +
      `${((fillAtLow / at065) * 100).toFixed(0)}% of the frame\n` +
      `    does not             ${fixed.toFixed(2)} ms   ` +
      `${((fixed / at065) * 100).toFixed(0)}% — vertex stage, submission, state`
  );
  const floorMs = median(sweep['0.35'].ms);
  const cutPct = (1 - (0.35 / 0.65) ** 2) * 100;
  console.log(
    `\n  Dropping render scale 0.65 -> 0.35 deletes ${cutPct.toFixed(0)}% of the fragments\n` +
      `  and buys ${(at065 - floorMs).toFixed(2)} ms ` +
      `(${(((at065 - floorMs) / at065) * 100).toFixed(0)}% of low's frame). ` +
      `The floor is ${floorMs.toFixed(2)} ms.`
  );
  report.split = { station, sweep, fit: { fixed, perPixel, resid }, at065, fillAtLow };
}

/* -------------------------------------------------------------------------- */
/* 4. the reach lever                                                         */
/* -------------------------------------------------------------------------- */

/**
 * WHAT SHORTENING THE WOOD IS WORTH — the potato-tier feasibility number.
 *
 * Section 3 establishes that at Low the frame is three quarters
 * resolution-independent and that the ladder never removes a triangle, so the
 * only lever with headroom left is geometric. `forest.setReach` is that lever.
 * Every arm here is measured with the preset pinned at Low and the pixel ratio
 * held at 0.65, so nothing moves but the tree bands.
 *
 *
 * REACH AND FOG DENSITY MUST MOVE TOGETHER, AND NOTHING IN THIS SCRIPT DOES IT.
 *
 * The arms below are a COST measurement and they are deliberately not a
 * shippable configuration. `TREE_REACH = 384` was chosen so that fog had already
 * deleted the trees before the reach did: sober `FogExp2` transmits
 * `exp(-(d·rho)^2)`, which at 384 m is 3.7e-6 — far under the 1/255 the
 * framebuffer can hold — so the wood is already gone by the time it stops being
 * drawn. Cut the reach at today's density and nothing fades: a hard-edged
 * circular hole opens at the new radius and follows the player around.
 *
 * Hiding a reach of `d` needs `rho >= sqrt(ln 255)/d = 2.354/d`. At 120 m that
 * is 0.0196 against a sober density of roughly 0.0092 — 2.1x thicker. So any
 * tier built on these numbers has to move `fogDistance` with the reach, and
 * `fogDistance` is the preset that was flattened to [1,1,1,1] precisely BECAUSE
 * nothing culled on fog. It becomes load-bearing the moment something does. The
 * milliseconds below are therefore an upper bound on what the lever is worth and
 * a lower bound on the work needed to spend it.
 */
const REACH_ARMS = [
  { name: 'today (170/384, near 82)', lod: 170, reach: 384, alwaysNear: 82 },
  { name: '170/384, near 0', lod: 170, reach: 384, alwaysNear: 0 },
  { name: '120/250, leaf 150', lod: 120, reach: 250, leafReach: 150, alwaysNear: 0 },
  { name: '90/180, leaf 110', lod: 90, reach: 180, leafReach: 110, alwaysNear: 0 },
  { name: '60/120, leaf 90', lod: 60, reach: 120, leafReach: 90, alwaysNear: 0 },
  { name: '60/120, leaf 60', lod: 60, reach: 120, leafReach: 60, alwaysNear: 0 },
];

if (want('reach')) {
  console.log(heading('what shortening the wood is worth, at LOW'));
  console.log(
    '  Preset pinned at low, pixel ratio held at 0.65. Only the tree LOD bands\n' +
      '  move. Arms are swept forward then backward, so each is sampled once in\n' +
      '  each half of the run and drift cancels.\n' +
      '  NOT A SHIPPABLE CONFIGURATION: see the fog note in this file. Cutting\n' +
      '  reach without thickening fog opens a hard-edged hole, it does not fade.\n'
  );

  report.reach = {};
  for (const station of STATIONS) {
    await page.evaluate((l) => window.__PRESETS__.setLevel(l), 'low');
    await page.evaluate(([s, l]) => window.__PRESETS__.arrive(s, l), [station, TRIP]);
    const sweep = await page.evaluate(
      ([a, o]) => window.__PRESETS__.reachSweep(a, o),
      [REACH_ARMS, { reps: GPU_REPS, batch: BATCH }]
    );
    const restored = await page.evaluate(() => window.__PRESETS__.restoreReach());

    console.log(`  ${station}`);
    console.log(
      `${PAD('    arm', 30)}${'gpu ms'.padStart(9)}${'vs today'.padStart(10)}` +
        `${'draws'.padStart(8)}${'tris'.padStart(10)}${'cut'.padStart(7)}`
    );
    const base = median(sweep[0].ms);
    const baseTris = sweep[0].counters.triangles;
    const pts = [];
    REACH_ARMS.forEach((arm, i) => {
      const ms = median(sweep[i].ms);
      const tris = sweep[i].counters.triangles;
      pts.push({ tris: tris / 1e6, ms });
      console.log(
        PAD(`    ${arm.name}`, 30) +
          NUM(ms, 9) +
          `${ms - base >= 0 ? '+' : ''}${(ms - base).toFixed(2)}`.padStart(10) +
          String(sweep[i].counters.calls).padStart(8) +
          `${(tris / 1e6).toFixed(2)}M`.padStart(10) +
          `${(((baseTris - tris) / baseTris) * 100).toFixed(0)}%`.padStart(7)
      );
    });

    /**
     * The restore is checked rather than assumed. Every arm after the first
     * inherits whatever the previous one left in the instance buffers, so a
     * `setReach` that did not fully take would show up here as a triangle count
     * that no longer matches the arm the sweep started from — and nowhere else.
     */
    const exact = restored.triangles === baseTris && restored.calls === sweep[0].counters.calls;
    console.log(
      `    restored to ${restored.calls} draws / ${restored.triangles.toLocaleString()} tris` +
        `${exact ? ' — exact' : `  MISMATCH against ${sweep[0].counters.calls}/${baseTris.toLocaleString()}`}`
    );

    // ms against triangles, least squares.
    const n = pts.length;
    const sx = pts.reduce((a, p) => a + p.tris, 0);
    const sy = pts.reduce((a, p) => a + p.ms, 0);
    const sxx = pts.reduce((a, p) => a + p.tris * p.tris, 0);
    const sxy = pts.reduce((a, p) => a + p.tris * p.ms, 0);
    const perM = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const intercept = (sy - perM * sx) / n;
    const resid = Math.sqrt(
      pts.reduce((a, p) => a + (p.ms - (intercept + perM * p.tris)) ** 2, 0) / n
    );
    console.log(
      `    fit: ms = ${intercept.toFixed(2)} + ${perM.toFixed(3)} x Mtri   ` +
        `(rms residual ${resid.toFixed(3)} ms)\n`
    );
    report.reach[station] = { sweep, arms: REACH_ARMS, fit: { intercept, perM, resid }, restored, exact };
  }

  /* ---- the alwaysNear question ----------------------------------------- */

  console.log(heading('is alwaysNear: 82 worth anything with shadows off?'));
  for (const station of STATIONS) {
    const s = report.reach[station].sweep;
    const a = median(s[0].ms);
    const b = median(s[1].ms);
    console.log(
      `  ${PAD(station, 10)} ${a.toFixed(2)} -> ${b.toFixed(2)} ms  ` +
        `(${b - a >= 0 ? '+' : ''}${(b - a).toFixed(2)}, ${(((b - a) / a) * 100).toFixed(0)}%)   ` +
        `draws ${s[0].counters.calls} -> ${s[1].counters.calls}   ` +
        `tris ${(s[0].counters.triangles / 1e6).toFixed(2)}M -> ${(s[1].counters.triangles / 1e6).toFixed(2)}M`
    );
  }
}

await browser.close();

if (args.json) {
  writeJson(args.json, report);
  console.log(`\n${rule()}\n${args.json}\n`);
}
