import { AUTHORED_PHASE } from '../../world/daylight.js';
import { STATIONS, LEVELS, LEVERS, LEVER_BASELINE } from './stations.js';
import { newbornWatch, drainNewborn } from './newborn.js';

/**
 * THE MEASURING INSTRUMENT.
 *
 * Everything in this directory is compiled out of the shipping build — see the
 * `__PERF__` block comment in vite.config.js for how, and `npm run
 * check:perfstrip` for the proof. It is written as if it were shipping code
 * anyway, because a measuring instrument that is wrong is worse than no
 * instrument: it does not fail, it lies, and every decision downstream of it
 * inherits the lie.
 *
 *
 * WHAT THIS IS FOR, IN ONE SENTENCE: to make a frame cost the same number twice.
 *
 * That is much harder than it sounds and it is the whole of the work here.
 * Three separate ways of getting it wrong have already cost this project real
 * time, all three are recorded in the audit notes, and all three are defended
 * against below by construction rather than by remembering:
 *
 *   1. VSYNC HIDES EVERYTHING. Wall-clock time between rAF callbacks is pinned
 *      to the display period as long as the app is fast enough to hit it, so it
 *      reports 16.7 ms for a frame that costs 3 ms and 16.7 ms for one that
 *      costs 15. It cannot see headroom, which is the only thing an
 *      optimisation moves. Answer: EXT_disjoint_timer_query_webgl2 around an
 *      explicit batch of frames — `sampleGpu` below.
 *
 *   2. THE ABSOLUTE NUMBER DRIFTS, ENORMOUSLY. Three runs of *identical* code
 *      on this machine gave 3.84, 6.36 and 4.46 ms. Any A/B where one arm
 *      always runs first is therefore worthless — a first attempt at attributing
 *      the frame reported −3.19 ms for a change that turned out to be worth
 *      approximately nothing, because another process was on the GPU for the
 *      first half of the run. Answer: `pairs` below never runs an arm in a
 *      fixed position. It runs A B B A per repetition and reports the
 *      distribution of the PAIRED difference, which cancels any drift slower
 *      than one pair.
 *
 *   3. A "FROZEN" WORLD IS USUALLY STILL MOVING. The wind runs on its own clock,
 *      the sun runs on the wall clock, and the trip envelope runs on a third —
 *      so two frames that were supposed to be identical differ everywhere, and
 *      the difference traces every edge in the picture no matter what was being
 *      tested. Answer: `arrive` freezes all three AND pins the sun to
 *      AUTHORED_PHASE, so the suite measures the same minute of the same day
 *      whatever time it is actually run at.
 *
 * A fourth, specific to this harness and specific to where it is often driven
 * from: GPU timer queries taken while the browser window is HIDDEN under-report
 * badly — around 22 ms for a frame that really costs 88 ms. The instrument
 * cannot detect that from inside, so it reports `hidden` in its capability
 * block and the Node side refuses to record a baseline from a hidden page.
 */

/** How many frames go inside one timer query. See `sampleGpu`. */
const BATCH = 24;
/** Batches thrown away before any are kept, so the GPU clock is up. */
const WARM_BATCHES = 2;
/** Simulation steps run to settle the eased trip level before timing. */
const SETTLE_STEPS = 30;
/** Fixed timestep for every simulation step the instrument runs. */
const DT = 1 / 60;

/**
 * The measurement resolution, fixed and independent of the window.
 *
 * Deliberately not the window size. The suite has to be comparable across
 * machines, across monitors and across changes to the pixel-ratio cap itself —
 * and a benchmark whose workload changes when you drag the window edge is not a
 * benchmark. 2560x1440 at ratio 1 is the resolution the audit numbers in the
 * project notes were taken at, so old figures remain comparable.
 */
const WIDTH = 2560;
const HEIGHT = 1440;

/**
 * Install the instrument and return the frame-loop hold predicate.
 *
 * The return value is the important half. `main.js` consults it at the top of
 * `frame()`, and while it is true the game's own rAF loop does nothing at all —
 * no simulation, no render, no DOM writes. Without that, every timed batch
 * would be interleaved with real frames that move the camera, advance the wind,
 * repack instances and re-render the shadow map, and the timer query would be
 * measuring a different workload on every batch. It is the difference between
 * a benchmark and an anecdote.
 */
export function installPerfProbe(RR) {
  let held = false;

  const { renderer, camera, scene, pipeline, director, forest, atmosphere, controller, probe } = RR;

  /**
   * The live rig configuration.
   *
   * Mutable, because the lever matrix is a series of departures from it and the
   * only honest way to un-do a departure is to re-apply the whole thing. See
   * LEVER_BASELINE in stations.js for why one restore path beats one undo per
   * lever.
   */
  const rig = { ...LEVER_BASELINE, width: WIDTH, height: HEIGHT };
  /** Set while measuring, so `arrive`'s settle steps do not fight the rig. */
  let engaged = false;
  /** What the last `settle` did — how many frames, and whether it got there. */
  let lastSettle = null;

  const gl = () => renderer.getContext();

  /* ---- capability and honesty ------------------------------------------- */

  function timerExt() {
    return gl().getExtension('EXT_disjoint_timer_query_webgl2') ?? null;
  }

  function caps() {
    const context = gl();
    const dbg = context.getExtension('WEBGL_debug_renderer_info');
    return {
      seed: RR.seed,
      timer: !!timerExt(),
      /**
       * Reported rather than acted on. A hidden page still produces beautifully
       * self-consistent numbers — they are simply the wrong ones, and every
       * relative comparison inside one hidden run still holds. So this is not a
       * refusal, it is a fact the Node side needs in order to decide whether it
       * is allowed to write a baseline from this run.
       */
      hidden: document.hidden || document.visibilityState !== 'visible',
      gpu: dbg ? context.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
      driver: context.getParameter(context.VERSION),
      devicePixelRatio: window.devicePixelRatio,
      webdriver: !!navigator.webdriver,
    };
  }

  /* ---- the rig ----------------------------------------------------------- */

  /**
   * Put the renderer into the measurement configuration.
   *
   * Idempotent and total: every field of `rig` is written every time, so this
   * doubles as the restore path between A/B arms. A partial version of this
   * function that only wrote what had changed was the first thing written here
   * and it was wrong within an hour — the arm that ran second inherited half
   * the arm that ran first.
   */
  function applyRig() {
    renderer.setPixelRatio(rig.ratio);
    renderer.setSize(rig.width, rig.height, false);
    camera.aspect = rig.width / rig.height;
    camera.updateProjectionMatrix();
    pipeline.setSize(rig.width, rig.height, rig.ratio);
    pipeline.setSamples(rig.samples);
    pipeline.bloomEnabled = rig.bloom;
    pipeline.trailEnabled = rig.trail;
    /**
     * The view breath, through the director's switch rather than by writing
     * uViewWarp — the director rewrites that uniform on every update() and
     * `arrive` runs SETTLE_STEPS of them, so a value poked in here would be
     * gone before the first timed frame and arm B would silently measure arm A.
     */
    director.switches.view = rig.viewBreath;
    /**
     * The resolution controller is switched off, not merely un-engaged.
     *
     * It reads a GPU timer of its own and moves the viewport underneath the
     * measurement — a benchmark whose subject quietly changes resolution
     * halfway through reports the average of two different workloads and calls
     * it one. `pinScale(1)` then makes the pinned state explicit rather than
     * relying on `setDynamicResolution(false)` happening to leave it at 1.
     */
    pipeline.setDynamicResolution(false, { measure: false });
    pipeline.pinScale(1);
    renderer.shadowMap.autoUpdate = rig.shadowEveryFrame;
    renderer.shadowMap.needsUpdate = true;
    /**
     * Point sprites size themselves in pixels, so they need to be told the
     * ratio changed — otherwise the motes, the midges and the embers are drawn
     * at the window's ratio while everything else is drawn at the rig's, and
     * the fill cost of three layers is silently wrong.
     */
    RR.fauna?.setPixelRatio?.(rig.ratio);
    RR.caves?.setPixelRatio?.(rig.ratio);
    RR.gathering?.setPixelRatio?.(rig.ratio);
    if (atmosphere.motes?.material?.uniforms?.uPixelRatio) {
      atmosphere.motes.material.uniforms.uPixelRatio.value = rig.ratio;
    }
  }

  /**
   * Everything that must be true for two runs of the same scenario to produce
   * the same picture. Called once, before the first scenario.
   */
  function engage() {
    if (engaged) return;
    engaged = true;
    held = true;
    /**
     * The bisection surface's freeze, which stops the trip clock, the wind AND
     * the sun. All three matter and the sun is the one that gets forgotten: it
     * moves at 0.3 deg/s, which is enough to re-render the shadow map
     * underneath a batch and enough to change the fog colour between two runs
     * an hour apart.
     */
    probe.reset();
    probe.freeze(true);
    /**
     * THE TWO TRIP EFFECTS THE SUITE DELIBERATELY TURNS OFF, AND WHY.
     *
     * Both are transients whose PHASE cannot be pinned, and a benchmark station
     * that lands on a different phase every visit is not a station.
     *
     *   THE SURGE is a crest that comes and goes on its own clock. Measured
     *   across four visits to the same station it read 0.31, 0.0001, 0.11 and
     *   0.96 — and it multiplies the glow, the swell, the melt and the fog. A
     *   "peak" scenario that includes it is measuring a random point between
     *   two quite different frames.
     *
     *   THE CAMERA EFFECTS — roll, sway, dolly zoom — move the camera and the
     *   FOV, which moves the FRUSTUM, which changes how many instances are
     *   submitted. That makes the workload itself a function of the phase, not
     *   just its cost.
     *
     * So the suite measures the trip's STEADY STATE: everything that is a
     * function of the level — melt, morph, glow, colour, swell, order, pulse —
     * is left exactly as it ships, and the two things that are a function of
     * the clock are set to zero. This is a stated limit of what the suite
     * covers rather than a claim that they are free; what they cost is a
     * question for the bottleneck report, where a transient can be measured
     * deliberately instead of stumbled into.
     */
    director.gain.surge = 0;
    director.gain.camera = 0;
    /**
     * …and then pin the sun to the AUTHORED phase rather than to whatever
     * `freeze` happened to catch.
     *
     * `probe.freeze` pins to the CURRENT phase, which is right for its own job
     * — freezing to look at something should not also teleport you to nine in
     * the morning — and wrong for this one. A regression suite run at dusk and
     * the same suite run at noon would otherwise be measuring different shadow
     * geometry, a different fog density and a different set of awake animals,
     * and would disagree by more than any change anyone is likely to make.
     */
    atmosphere.day.set(AUTHORED_PHASE);
    // The UI is not part of the frame under test, and its DOM writes land in
    // the same main thread as the batch loop.
    const ui = document.getElementById('ui');
    if (ui) ui.style.display = 'none';
    applyRig();
  }

  /**
   * Give the machine back. Called at the end of a run so an interactive session
   * that poked at `RR.perf` from the console is not left with a frozen world at
   * a resolution nobody asked for.
   */
  function release() {
    engaged = false;
    held = false;
    probe.reset();
    probe.freeze(false);
    atmosphere.day.set(null);
    pipeline.pinScale(null);
    const ui = document.getElementById('ui');
    if (ui) ui.style.display = '';
    window.dispatchEvent(new Event('resize'));
  }

  /* ---- arriving somewhere ------------------------------------------------ */

  /**
   * Stand at a station, at a trip level, and settle.
   *
   * THE SETTLE IS NOT POLITENESS, AND GETTING IT WRONG INVALIDATED THE FIRST
   * SET OF NUMBERS THIS FRAMEWORK EVER PRODUCED. Two independent things have to
   * come to rest and neither of them is fast:
   *
   *   THE TRIP ENVELOPE. `director.eased` moves toward its target over seconds,
   *   and the atmosphere follows it. A batch timed immediately after a seek
   *   measures a fade rather than a state — and because the fade is asymmetric
   *   (fast up, very slow down) how wrong it is depends on which scenario ran
   *   BEFORE it, which is the worst possible property for a benchmark to have.
   *   Thirty fixed steps put it within a thousandth of the target from either
   *   direction.
   *
   *   THE WORLD ITSELF. Teleporting invalidates the streamed set, and both
   *   rings — the forest and the ground — accept at most one sector per frame,
   *   from inside `forest.cull()`, with the actual geometry arriving from a
   *   worker some frames later. Measured on the first version of this file, the
   *   deep station reported 249 draw calls and 21.3 M triangles on the frame
   *   after arrival and 130 calls and 11.3 M triangles five frames later. Every
   *   number taken in between was real, reproducible, and about a forest that
   *   was still turning up.
   *
   * So this is async, and it waits. See `settle`.
   */
  async function arrive({ station, level, still = false }) {
    engage();
    const s = STATIONS[station];
    if (!s) throw new Error(`unknown station: ${station}`);
    if (!(level in LEVELS)) throw new Error(`unknown level: ${level}`);

    controller.position.x = s.x;
    controller.position.z = s.z;
    controller.velocity.set(0, 0, 0);
    controller.yaw = s.yaw;
    controller.pitch = s.pitch;
    controller.applyToCamera();

    const seconds = LEVELS[level];
    if (seconds === null) {
      director.ground();
      director.state.override = null;
      director.eased = 0;
    } else {
      director.seek(seconds);
      /**
       * Held at the level rather than left to run.
       *
       * The envelope is a five-minute curve with a surge riding on it, so
       * without an override a batch started at t=160 is at a different point of
       * the curve by the time it finishes — and the surge in particular is a
       * large, fast multiplier on the glow, the swell and the melt. Pinning
       * `override` and `eased` makes "peak" a place instead of a moment.
       */
      director.state.override = 1;
      director.eased = director.state.level;
    }
    /**
     * `applyToCamera` INSIDE THE LOOP, and it is not a tidiness point.
     *
     * The real frame loop seats the camera on the body and THEN lets the
     * director offset it, every frame, so the offset is applied to a fresh pose
     * each time. Written with the seat outside the loop — which is how this was
     * first written, and it looked perfectly reasonable — thirty director steps
     * apply thirty offsets to each other's output, and the camera walks away
     * from the body. Measured: with the body pinned at (-30, -40), the camera
     * arrived at (-10.4, -26.5, -25.5) on one visit and (-45.6, +24.6, -54.3)
     * on another, twenty-six metres in the air, with the FOV drifting from 73.9
     * to 59.0 as the dolly compounded.
     *
     * The damage that did is worth being explicit about, because none of it
     * looked like a bug: every scenario was measuring a real frame, from a
     * plausible place, perfectly repeatably within a batch. It just was not the
     * station it said it was, and it was a different one each visit — which
     * showed up only as a benchmark whose submitted instance count fell by 37%
     * over four laps for no reason anybody could name.
     */
    for (let i = 0; i < SETTLE_STEPS; i++) {
      controller.applyToCamera();
      director.update(DT, { camera, audioLevels: null });
    }
    atmosphere.follow(camera, controller.position);
    /**
     * Force a full repack and a shadow render NOW, so neither lands inside a
     * timed batch. Both are triggered by camera movement and both are
     * expensive; a teleport guarantees they are pending.
     *
     * With culling off, "un-culled" has to mean every instance genuinely
     * WRITTEN BACK, not merely `mesh.count` raised. The buffer holds only the
     * packed visible set, so raising the count alone would submit stale entries
     * from wherever the last repack left them and time a fiction — a frame
     * drawing the right NUMBER of trees in the wrong places, which costs about
     * the right amount and proves nothing.
     */
    if (rig.cullEnabled) forest.cull(camera, true);
    else forest.culler.restoreAll();
    renderer.shadowMap.needsUpdate = true;
    pipeline.clearHistory();

    /**
     * The frame closure the batch will run, built once per arrival.
     *
     * `still` is the standing-still frame: no `follow`, no `cull`, because a
     * camera that has not moved would fire neither. It is a scenario in its own
     * right rather than an optimisation of this function — it is the frame the
     * shadow cache exists for, and the only one that can show whether it works.
     */
    const frame = still
      ? () => pipeline.render(DT)
      : () => {
          atmosphere.follow(camera, controller.position);
          if (rig.cullEnabled) forest.cull(camera);
          if (rig.shadowEveryFrame) renderer.shadowMap.needsUpdate = true;
          pipeline.render(DT);
        };

    await settle(frame, still);
    return frame;
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

  /* ---- phase profiling --------------------------------------------------- */

  /**
   * TIME THE INSIDE OF THE GAME'S OWN FRAME, WITHOUT EDITING THE GAME.
   *
   * Long Animation Frames says a 320 ms frame was 100% script inside
   * `main.js frame()`, which rules out the GPU, the compositor and layout — and
   * then stops, because it only names the top-level entry point. The next
   * question is which of the twenty things `frame()` calls was responsible, and
   * the browser cannot answer that.
   *
   * The obvious way to find out is to sprinkle timers through main.js. This
   * does it by wrapping the methods on the objects `RR` already exposes
   * instead, which is better on every axis that matters: the frame loop keeps
   * exactly one dev-only foothold rather than twenty, the wrapping is set up
   * and torn down per measurement so nothing is paid when nobody is looking,
   * and a phase list that drifts out of step with the code shows up as a
   * missing key rather than as a silently mis-attributed millisecond.
   *
   * The cost of the wrapper itself is two `performance.now()` calls — tens of
   * nanoseconds against frames of several milliseconds — and it is paid equally
   * by every phase, so it cannot change their ranking.
   */
  const PHASES = [
    ['controller', () => controller, 'update'],
    ['ferry', () => RR.ferry, 'update'],
    ['seats', () => RR.seats, 'update'],
    ['sitting', () => RR.sitting, 'update'],
    ['director', () => director, 'update'],
    ['atmosphere.follow', () => atmosphere, 'follow'],
    ['atmosphere.tick', () => atmosphere, 'tick'],
    ['net', () => RR.net, 'update'],
    ['gathering', () => RR.gathering, 'update'],
    ['fishing', () => RR.fishing, 'update'],
    ['social', () => RR.social, 'update'],
    ['fauna', () => RR.fauna, 'update'],
    ['caves', () => RR.caves, 'update'],
    ['cull', () => forest, 'cull'],
    ['render', () => pipeline, 'render'],
    ['audio.listener', () => RR.audio, 'updateListener'],
    ['audio.levels', () => RR.audio, 'sampleLevels'],
  ];

  /** ms spent in each phase during the frame currently in flight. */
  const phaseAccum = Object.create(null);

  function installPhaseTimers() {
    const undo = [];
    for (const [name, owner, method] of PHASES) {
      const target = owner();
      if (!target || typeof target[method] !== 'function') continue;
      const original = target[method];
      target[method] = function timed(...a) {
        const t0 = performance.now();
        try {
          return original.apply(this, a);
        } finally {
          phaseAccum[name] = (phaseAccum[name] ?? 0) + (performance.now() - t0);
        }
      };
      undo.push(() => {
        target[method] = original;
      });
    }
    return () => {
      for (const f of undo) f();
    };
  }

  /**
   * Wait until this station renders the same frame twice running.
   *
   * WHY THAT DEFINITION AND NOT A TIMEOUT. "Settled" has to be checked, not
   * waited out — a fixed sleep is a guess that is too short on a cold machine
   * and wasted on a warm one, and it fails silently in the direction that
   * produces optimistic numbers. Draw calls and triangle count are exactly
   * reproducible for a fixed camera in a fixed world, so two consecutive frames
   * agreeing on both is direct evidence that nothing is still arriving,
   * evicting or repacking. It is the same property the regression gate depends
   * on, tested at the moment it starts being true.
   *
   * The pending-queue test is kept alongside it and is not redundant: a sector
   * whose worker has not answered yet contributes nothing to either counter, so
   * a world with work outstanding can look perfectly stable for several frames
   * and then change. Requiring both, for several consecutive frames, covers the
   * two ways this can lie in opposite directions. It is the same reasoning
   * main.js applies before it takes the gate down, and for the same reason.
   *
   * Bounded, and the bound is REPORTED rather than swallowed: a station that
   * will not settle is a finding about the streamer, and a benchmark that
   * quietly measured it anyway would bury that finding under a wide error bar.
   */
  async function settle(frame, still) {
    const info = renderer.info;
    info.autoReset = false;
    let quiet = 0;
    let last = null;
    let frames = 0;
    const started = performance.now();
    while (quiet < 3 && performance.now() - started < 10000) {
      // Forced, so the culler cannot decline to look: the camera has not moved
      // since the teleport, and the streamer only queues work from inside here.
      if (rig.cullEnabled) forest.cull(camera, true);
      info.reset();
      frame();
      frames++;
      const now = `${info.render.calls}/${info.render.triangles}`;
      const rings =
        (forest.field?.pending ?? 0) === 0 &&
        (forest.field?.built ?? 0) > 0 &&
        (forest.groundField?.pending ?? 0) === 0 &&
        (forest.groundField?.group?.children?.length ?? 0) > 0;
      quiet = rings && now === last ? quiet + 1 : 0;
      last = now;
      // Yield: the sectors are built in workers and their messages cannot be
      // delivered while this loop holds the main thread. A tight synchronous
      // loop here would spin for the whole ten seconds and settle nothing.
      await nextFrame();
    }
    info.autoReset = true;
    /**
     * WHERE THE CAMERA ACTUALLY ENDED UP, recorded with every scenario.
     *
     * A station is a claim about a viewpoint, and the most expensive hour spent
     * building this framework went on a bug where that claim was false — the
     * body was at the station and the camera was twenty-six metres above it,
     * somewhere else entirely, at a different FOV on every visit. Nothing in
     * the numbers looked wrong; they were simply about a different picture each
     * time. So the viewpoint is now part of the measurement, and the runner
     * compares it across passes. `drift` is what makes it readable at a glance:
     * on a suite that is behaving it is a couple of centimetres of eye height,
     * and anything else is this bug coming back.
     */
    const drift = Math.hypot(
      camera.position.x - controller.position.x,
      camera.position.z - controller.position.z
    );
    lastSettle = {
      frames,
      ms: performance.now() - started,
      settled: quiet >= 3,
      camera: {
        x: +camera.position.x.toFixed(3),
        y: +camera.position.y.toFixed(3),
        z: +camera.position.z.toFixed(3),
        fov: +camera.fov.toFixed(3),
        drift: +drift.toFixed(3),
      },
      /**
       * `still` scenarios do not call `cull` in their frame, so they inherit
       * whatever the forced cull above left. Recorded so a reader can tell the
       * two apart rather than wondering why one row settled in three frames.
       */
      still: !!still,
    };
    /**
     * The shadow map is re-armed AFTER settling and then consumed by one
     * un-timed frame. Otherwise the first frame of the first timed batch pays
     * for a whole shadow render — 3.2-4.5 ms on top of a 2.4 ms frame on this
     * machine — and one batch in every arrival is a third heavier than the
     * others for a reason that has nothing to do with what is being measured.
     */
    renderer.shadowMap.needsUpdate = true;
    frame();
    return lastSettle;
  }

  /* ---- timing ------------------------------------------------------------ */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * One batch of frames inside one timer query, in milliseconds per frame.
   *
   * WHY A BATCH AND NOT A FRAME. A single TIME_ELAPSED query has a fixed
   * overhead of its own and a resolution that is not much finer than the thing
   * being measured; twenty-four frames amortise both. The cost is that a batch
   * cannot show per-frame variance, which is why hitch detection is a separate
   * method (`walk`) driven by the real loop instead of being squeezed out of
   * this one.
   *
   * WHY THE DISJOINT CHECK. The extension is allowed to give you a number that
   * is simply wrong — a mode switch, a context loss, another process taking the
   * GPU, thermal throttling on some drivers — and it signals that by setting
   * GPU_DISJOINT_EXT rather than by failing. The existing one-off scripts in
   * this project never read it, which means every number they have ever printed
   * had a small chance of being fiction with no way to tell. Reading it clears
   * it, so it is read once to clear before the batch and once after to judge.
   */
  async function batchMs(frame, n) {
    const context = gl();
    const ext = timerExt();
    if (!ext) throw new Error('EXT_disjoint_timer_query_webgl2 unavailable');

    context.getParameter(ext.GPU_DISJOINT_EXT);
    const q = context.createQuery();
    context.beginQuery(ext.TIME_ELAPSED_EXT, q);
    for (let i = 0; i < n; i++) frame();
    context.endQuery(ext.TIME_ELAPSED_EXT);
    context.flush();

    for (let t = 0; t < 60; t++) {
      await sleep(50);
      if (context.getQueryParameter(q, context.QUERY_RESULT_AVAILABLE)) break;
    }
    const available = context.getQueryParameter(q, context.QUERY_RESULT_AVAILABLE);
    const disjoint = context.getParameter(ext.GPU_DISJOINT_EXT);
    const ns = available ? context.getQueryParameter(q, context.QUERY_RESULT) : 0;
    context.deleteQuery(q);
    if (!available) return { ms: NaN, disjoint: true };
    return { ms: ns / 1e6 / n, disjoint: !!disjoint };
  }

  /**
   * Repeated batches of one workload, plus the counters that describe it.
   *
   * Returns every kept batch rather than a summary. The Node side owns the
   * statistics, because deciding what the middle of a distribution is is a
   * judgement and judgements belong where they can be read, changed and
   * re-applied to a stored run without re-measuring.
   */
  async function sampleGpu(frame, { batch = BATCH, reps = 5 } = {}) {
    const context = gl();

    // Warm: shader programs, the shadow map, the glow accumulator's first
    // ping-pong, and the GPU's own clock ramp. Thrown away entirely.
    for (let w = 0; w < WARM_BATCHES; w++) await batchMs(frame, batch);
    context.finish();

    /**
     * Counters come from ONE frame with autoReset off, so they cover the shadow
     * pass, the scene pass and every post pass rather than whichever happened
     * to run last. This is the part of the measurement that is exactly
     * reproducible, and it is what the regression gate leans on hardest.
     */
    const info = renderer.info;
    info.autoReset = false;
    info.reset();
    frame();
    const counters = {
      calls: info.render.calls,
      triangles: info.render.triangles,
      points: info.render.points,
      lines: info.render.lines,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    };
    info.autoReset = true;

    const batches = [];
    let disjoints = 0;
    for (let r = 0; r < reps; r++) {
      const s = await batchMs(frame, batch);
      if (s.disjoint || !Number.isFinite(s.ms)) {
        disjoints++;
        /**
         * A disjoint batch is DISCARDED, not repaired and not averaged in. The
         * driver has told us the number is meaningless; the only wrong thing to
         * do with it is keep it. One retry, so a single interruption costs a
         * batch rather than a scenario.
         */
        const retry = await batchMs(frame, batch);
        if (retry.disjoint || !Number.isFinite(retry.ms)) continue;
        batches.push(retry.ms);
      } else {
        batches.push(s.ms);
      }
    }
    return { batches, counters, disjoints, frames: batch };
  }

  /* ---- paired A/B -------------------------------------------------------- */

  /**
   * THE ONLY COMPARISON IN HERE THAT IS ALLOWED TO CLAIM A DIFFERENCE.
   *
   * Two arms, run A B B A per repetition. The order reversal is the point: any
   * drift that is linear in time — a background process ramping up, the GPU
   * clocking, the driver warming — contributes equally to both arms of an ABBA
   * quadruple and cancels in the paired difference. Running A A A B B B instead
   * would attribute the entire drift to the arm that ran second, which is
   * precisely the failure recorded in the audit notes: a −3.19 ms result for a
   * change worth nothing.
   *
   * Each arm is set up from scratch through `setup`, never by un-doing the
   * other, so the two arms cannot leak into each other. Both arms of a pair are
   * measured with the SAME batch size and the same warm state, and the value
   * returned is a list of paired differences — one per repetition, in the order
   * they were taken, so the Node side can see drift if there is any rather than
   * being handed a mean that has already hidden it.
   */
  async function pairs(setup, { a, b, reps = 4, batch = BATCH } = {}) {
    const arm = async (cfg) => {
      const frame = await setup(cfg);
      // One throwaway batch per arm: the switch itself may have reallocated a
      // render target or recompiled a program, and the frame that pays for that
      // must not be in the sample.
      await batchMs(frame, batch);
      const s = await batchMs(frame, batch);
      if (s.disjoint || !Number.isFinite(s.ms)) {
        const retry = await batchMs(frame, batch);
        return retry.disjoint ? NaN : retry.ms;
      }
      return s.ms;
    };

    const rows = [];
    for (let r = 0; r < reps; r++) {
      const a1 = await arm(a);
      const b1 = await arm(b);
      const b2 = await arm(b);
      const a2 = await arm(a);
      const aMean = (a1 + a2) / 2;
      const bMean = (b1 + b2) / 2;
      rows.push({ a: aMean, b: bMean, delta: bMean - aMean, raw: [a1, b1, b2, a2] });
    }
    return rows;
  }

  /* ---- the public surface ------------------------------------------------ */

  /**
   * Snapshot the things that are exactly reproducible.
   *
   * These are the sharpest regression detector in the framework and the least
   * glamorous. A triangle count does not drift, does not care what else is
   * running on the machine and does not need eight repetitions to be believed —
   * so "the canopy scenario gained 900k triangles" is a hard failure on one
   * sample, while the timing that follows from it needs a confidence interval.
   * Most real performance regressions announce themselves here first.
   */
  function counters() {
    const info = renderer.info;
    /**
     * Two numbers per instanced layer and they answer different questions.
     * `submitted` is what this camera is being handed — a culling regression
     * moves it and nothing else. `resident` is what the streamer has actually
     * loaded — a scatter or streaming regression moves that one, and it can
     * move a long way while `submitted` stays put, which is a memory and
     * upload-bandwidth problem that no frame-time benchmark will ever see.
     */
    const instances = {};
    for (const packer of forest.culler?.packers ?? []) {
      const name = packer.mesh?.name || 'unnamed';
      const row = (instances[name] ??= { submitted: 0, resident: 0 });
      row.submitted += packer.mesh?.count ?? 0;
      row.resident += packer.instanceCount ?? 0;
    }
    let sceneObjects = 0;
    scene.traverse(() => sceneObjects++);
    return {
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      instances,
      sceneObjects,
      /**
       * How much of the wood has been streamed in. The forest and the ground
       * are two independent rings that fill at one sector per frame, so a
       * scenario timed before they have settled is measuring a smaller world
       * than the one it names — and it would report that as an improvement.
       * The Node side asserts these are non-zero before it believes a run.
       */
      sectors: {
        forest: forest.field?.built ?? 0,
        ground: forest.groundField?.group?.children?.length ?? 0,
        pending: (forest.field?.pending ?? 0) + (forest.groundField?.pending ?? 0),
      },
    };
  }

  const api = {
    caps,
    counters,
    engage,
    release,
    get held() {
      return held;
    },
    /** For the console: stop holding the loop without tearing the rig down. */
    resume() {
      held = false;
    },

    /**
     * Visit every station once, settling at each, and time nothing.
     *
     * THE STREAMER'S RESIDENT SET IS PATH-DEPENDENT, and this is the cheapest
     * honest answer to that. Sectors are fetched inside a radius and evicted
     * outside a larger one, so a sector loaded for the canopy station is still
     * resident when the camera reaches the clearing, and is drawn if it happens
     * to be in frustum. The consequence is that a station measured as the first
     * thing after boot is not measuring quite the same world as the same
     * station measured after a tour of the others: the first recorded pass came
     * out at 157 draw calls where every subsequent one agreed on 168.
     *
     * One lap round the suite puts the streamer into the cyclic state that
     * every later lap will also see, so the passes that get recorded are all
     * approached the same way. It does not make the resident set canonical —
     * nothing short of a full flush would, and there is no API for that — it
     * makes it REPEATABLE, which is the property the gate actually needs.
     */
    async tour(specs) {
      for (const spec of specs) await arrive(spec);
      return true;
    },

    /** One scenario, end to end. The unit the regression suite is built from. */
    async scenario(spec, opts = {}) {
      const frame = await arrive(spec);
      const r = await sampleGpu(frame, opts);
      return { ...spec, ...r, settle: lastSettle, structural: counters() };
    },

    /**
     * EXACTLY what each layer puts in the frame — no timing, no statistics.
     *
     * Hide it, read the counters, show it, read them again; the difference is
     * that layer's draw calls and triangles, to the triangle. It costs one
     * frame per layer and it is the other half of the marginal-cost table:
     * milliseconds alone say a layer is expensive, and cannot distinguish a
     * layer that is expensive because there is a great deal of it from one that
     * is expensive per triangle. Those two have completely different fixes —
     * the first is a scatter or LOD problem, the second is a shader problem —
     * and telling somebody to optimise the wrong one wastes a day.
     *
     * The shadow map is the trap here. `probe.show` invalidates it, so the very
     * next frame renders the whole depth pass again and the counters come back
     * roughly doubled. Each read therefore burns a frame to consume the pending
     * update before the one it actually measures.
     */
    async layerCensus(names, spec) {
      const frame = await arrive(spec);
      const info = renderer.info;
      info.autoReset = false;

      const read = () => {
        // Burn the shadow update that `show()` just armed, then measure a frame
        // that is only the scene and the post chain.
        frame();
        info.reset();
        frame();
        return {
          calls: info.render.calls,
          triangles: info.render.triangles,
        };
      };

      probe.all(true);
      const withAll = read();
      const out = {};
      for (const name of names) {
        if (!probe.layers[name]) {
          out[name] = { missing: true };
          continue;
        }
        probe.show(name, false);
        const without = read();
        probe.show(name, true);
        out[name] = {
          calls: withAll.calls - without.calls,
          triangles: withAll.triangles - without.triangles,
          instances: (probe.layers[name]() ?? []).reduce((n, o) => n + (o.count ?? 0), 0),
          objects: (probe.layers[name]() ?? []).length,
        };
      }
      probe.all(true);
      info.autoReset = true;
      return { total: withAll, layers: out };
    },

    /**
     * What one lever is worth at one station, as a paired difference.
     *
     * The A arm is always the shipping configuration and the B arm is the
     * shipping configuration with exactly that lever un-done. Both arms are
     * built by `applyRig` from a full `rig` object, so B cannot inherit
     * anything from A.
     */
    /**
     * The lever table, minus the functions, so the Node side can enumerate it.
     *
     * The definitions live in `stations.js` and are therefore shared between
     * this bundle and the runner, which imports the same file directly — one
     * list, no chance of the report naming a lever the instrument does not
     * have. Only the metadata crosses the bridge; `apply` stays here, because a
     * function cannot be serialised and a lever that had to be re-implemented
     * on the Node side would be a second definition of the same thing.
     */
    levers: LEVERS.map(({ name, b, hint, undoes, direction }) => ({
      name,
      b,
      hint,
      undoes,
      direction,
    })),

    async lever(name, spec, opts = {}) {
      const lever = LEVERS.find((l) => l.name === name);
      if (!lever) throw new Error(`unknown lever: ${name}`);
      engage();
      /**
       * The facade a lever is allowed to touch.
       *
       * Only keys that already exist in LEVER_BASELINE, so a lever cannot
       * invent a rig field that the restore path does not know how to put back
       * — which would leak from one arm into every arm after it, silently, for
       * the rest of the run.
       */
      const facade = {
        set(key, value) {
          if (!(key in LEVER_BASELINE)) throw new Error(`lever wrote unknown rig key: ${key}`);
          rig[key] = value;
        },
      };
      const setup = (cfg) => {
        Object.assign(rig, LEVER_BASELINE);
        if (cfg) cfg.apply(facade);
        applyRig();
        return arrive(spec);
      };
      const rows = await pairs(setup, { a: null, b: lever, ...opts });
      Object.assign(rig, LEVER_BASELINE);
      applyRig();
      return rows;
    },

    /**
     * A paired A/B between the shipping rig and an arbitrary set of rig fields.
     *
     * The general form of `lever`, for questions the lever table does not
     * contain — the one that matters is "how much of this frame moves with the
     * pixel count", which needs a resolution that has never shipped and
     * therefore has no business being a named lever. Keys are validated against
     * LEVER_BASELINE for the same reason the lever facade validates them: a rig
     * field the restore path does not know about leaks into every subsequent
     * arm.
     */
    /**
     * `base` is a departure BOTH arms share, and it exists because leaving it
     * out silently answers a different question.
     *
     * Asking what a fragment-stage term costs at 1.4x resolution by passing
     * `{ thing: false, ratio: 1.4 }` compares shipping-at-1.0 against
     * thing-off-at-1.4, so the difference is dominated by the two million extra
     * pixels and the term under test is a rounding error inside it. The rows
     * come back an order of magnitude too large, with tight intervals, and
     * nothing about them looks wrong. Put the resolution in `base` and both
     * arms carry it, so the difference is the term again.
     */
    async rigPair(spec, delta, opts = {}) {
      engage();
      const { base = null, ...rest } = opts;
      for (const key of [...Object.keys(delta), ...Object.keys(base ?? {})]) {
        if (!(key in LEVER_BASELINE)) throw new Error(`unknown rig key: ${key}`);
      }
      const setup = (on) => {
        Object.assign(rig, LEVER_BASELINE, base, on ? delta : null);
        applyRig();
        return arrive(spec);
      };
      opts = rest;
      const rows = await pairs(setup, { a: false, b: true, ...opts });
      Object.assign(rig, LEVER_BASELINE);
      applyRig();
      return rows;
    },

    /**
     * What one LAYER is worth at one station, as a paired difference.
     *
     * A is everything visible; B is everything except this layer. Note the
     * shadow map is invalidated by `probe.show` on both arms, so the cost of
     * re-rendering it is paid by both and cancels — without that, hiding a
     * caster would look cheaper than it is by the price of one shadow pass.
     */
    async layer(name, spec, opts = {}) {
      engage();
      if (!probe.layers[name]) throw new Error(`unknown layer: ${name}`);
      const setup = (hide) => {
        probe.all(true);
        if (hide) probe.show(name, false);
        return arrive(spec);
      };
      const rows = await pairs(setup, { a: false, b: true, ...opts });
      probe.all(true);
      return rows;
    },

    /**
     * FRAME-TIME STABILITY, measured with the real loop running.
     *
     * Everything above deliberately holds the world still, which makes the
     * numbers reproducible and makes them blind to the single most-reported
     * performance complaint this game has ever had: it hitches when you move.
     * That hitch is not a slow frame, it is a rare frame — the instance repack
     * and the shadow map, both triggered by movement — and a benchmark that
     * averages twenty-four static frames cannot see it by construction.
     *
     * So this one gives the machine back, walks the camera along a fixed path
     * at a fixed speed, and records the wall-clock interval of every frame. The
     * absolute values are vsync-quantised and nearly meaningless; the
     * distribution's TAIL is the entire point, and a hitch is defined as an
     * interval over twice the median rather than over any fixed millisecond
     * figure, so it means the same thing on a 60 Hz and a 144 Hz display.
     */
    async walk({ seconds = 8, station = 'deep', level = 'peak', profile = false } = {}) {
      await arrive({ station, level });
      probe.freeze(false);
      held = false;
      applyRig();
      const removeTimers = profile ? installPhaseTimers() : null;

      const s = STATIONS[station];
      const intervals = [];
      const repacks = [];
      /**
       * WHAT CHANGED DURING EACH FRAME, sampled once a frame alongside its cost.
       *
       * A hitch detector that only reports "there was a 211 ms frame" has told
       * you the one thing you already knew. Every quantity here is a counter the
       * engine keeps anyway, and the DELTA across one frame says what that frame
       * did that its neighbours did not:
       *
       *   programs   a shader compiled — synchronous, on the main thread, and
       *              the single most expensive thing a frame can be asked to do
       *   built      a streamed sector was accepted: a worker message
       *              deserialised, a geometry created and uploaded
       *   evicted    a sector was dropped, which forces a full repack
       *   geometries GPU geometry allocations, the upload side of the above
       *   uploaded   instances the culler re-copied into the instance buffer
       *   heap       used JS heap; a fall across a slow frame is a GC
       *
       * This callback runs AFTER the game's own frame callback — rAF fires in
       * registration order and the game registered first — so each sample is
       * the post-frame state, and the difference between consecutive samples is
       * exactly what that frame did.
       */
      const marks = [];
      const phases = [];
      const info = renderer.info;
      const mem = performance.memory;
      /**
       * WHICH program compiled, not merely that one did.
       *
       * "A shader compiled on the slow frame" is a diagnosis nobody can act on;
       * `three` names each program after the material that asked for it, so
       * naming the newcomer turns the finding into a file to open. Tracked by
       * `cacheKey` rather than by array position because the array is not
       * append-only — a program whose `usedTimes` falls to zero is released,
       * and an index-based diff would then report every program after it as
       * new.
       */
      const seenPrograms = new Set((info.programs ?? []).map((p) => p.cacheKey));
      /**
       * Seeded HERE rather than at install, so the walk's first frame is not
       * handed every geometry the arrival and the settle met. Same argument as
       * `seenPrograms` above and as `resnap` in freezes.js.
       */
      const newborn = newbornWatch(renderer).log;
      let newbornAt = newborn.length;
      const slabGrowths = () => {
        const g = RR.forest?.growths;
        if (!g) return 0;
        let n = 0;
        for (const key in g) n += g[key];
        return n;
      };

      /**
       * THE BROWSER'S OWN ACCOUNT OF WHAT BLOCKED THE FRAME.
       *
       * The counter deltas above can only attribute a slow frame to something
       * somebody thought to count, and the first run of this report left three
       * quarters of the slow frames unexplained — which is exactly the state in
       * which people start guessing. Long Animation Frames is the browser
       * telling you directly: for every frame over 50 ms it reports the script
       * entry points that ran, how long each took, where the source was, and
       * how much of the frame went on style and layout rather than script.
       *
       * `sourceFunctionName` and `sourceCharPosition` are the payoff — they
       * name a function and an offset in a file, which turns "something took
       * 152 ms" into a line to open. Nothing else available from inside the page
       * can do that.
       *
       * Wrapped in a try: it is Chrome-only and reasonably recent, and a
       * diagnostic that throws on a browser which lacks it would take the whole
       * walk with it. `supported` is reported so the absence of long-frame
       * entries can be read as "none happened" rather than "not measured",
       * which are opposite conclusions.
       */
      const loaf = [];
      let observer = null;
      try {
        observer = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            loaf.push({
              start: e.startTime,
              duration: e.duration,
              blocking: e.blockingDuration,
              /** Time from frame start to when rendering began: all script. */
              renderDelay: e.renderStart ? e.renderStart - e.startTime : 0,
              styleAndLayout: e.styleAndLayoutStart
                ? e.startTime + e.duration - e.styleAndLayoutStart
                : 0,
              scripts: (e.scripts ?? []).map((s) => ({
                invoker: s.invoker,
                type: s.invokerType,
                source: s.sourceURL,
                fn: s.sourceFunctionName,
                at: s.sourceCharPosition,
                duration: s.duration,
                forced: s.forcedStyleAndLayoutDuration,
              })),
            });
          }
        });
        observer.observe({ type: 'long-animation-frame', buffered: false });
      } catch {
        observer = null;
      }
      const started = performance.now();
      let last = started;
      await new Promise((resolve) => {
        const tick = () => {
          const now = performance.now();
          intervals.push(now - last);
          if (profile) {
            /**
             * Snapshot and clear. This callback runs AFTER the game's frame
             * callback — rAF fires in registration order and the game
             * registered first — so everything in the accumulator belongs to
             * the frame whose interval was just recorded.
             */
            phases.push({ ...phaseAccum });
            for (const k of Object.keys(phaseAccum)) delete phaseAccum[k];
          }
          const fresh = [];
          for (const p of info.programs ?? []) {
            if (seenPrograms.has(p.cacheKey)) continue;
            seenPrograms.add(p.cacheKey);
            fresh.push(p.name || 'unnamed');
          }
          /**
           * WHICH geometry, and how many bytes of it, not merely that the
           * count moved.
           *
           * `geometries` above is the strongest cause this report can
           * attribute and the least specific thing in it — see newborn.js. The
           * counter moves on the frame a geometry is first DRAWN rather than
           * the frame it was built, so it fires on a frame whose only visible
           * cause is that the player turned his head, and it covers everything
           * from a 24-vertex prop to a 1.8 MB cave mesh under one name.
           */
          const met = drainNewborn(newborn, newbornAt);
          newbornAt = met.cursor;
          marks.push({
            fresh,
            met: met.count,
            metBytes: met.bytes,
            metWhat: met.summary,
            grows: slabGrowths(),
            programs: info.programs?.length ?? 0,
            geometries: info.memory.geometries,
            textures: info.memory.textures,
            built: forest.field?.built ?? 0,
            evicted: forest.field?.evicted ?? 0,
            ground: forest.groundField?.group?.children?.length ?? 0,
            pending: (forest.field?.pending ?? 0) + (forest.groundField?.pending ?? 0),
            uploaded: forest.culler?.uploaded ?? 0,
            heap: mem ? mem.usedJSHeapSize : 0,
          });
          last = now;
          const t = (now - started) / 1000;
          /**
           * A circle rather than a straight line, and a yaw that turns with it.
           * Both matter: the culler's repack is triggered by 2.5 m of travel OR
           * ~3 degrees of turn, and a straight walk with a fixed heading
           * exercises only the first of those. A circle also returns to where
           * it started, so the walk cannot wander somewhere cheaper and report
           * that as an improvement.
           */
          controller.position.x = s.x + Math.cos(t * 0.6) * 9;
          controller.position.z = s.z + Math.sin(t * 0.6) * 9;
          controller.yaw = s.yaw + t * 0.35;
          repacks.push(forest.culler?.uploaded ?? 0);
          if (now - started > seconds * 1000) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      held = true;
      probe.freeze(true);
      atmosphere.day.set(AUTHORED_PHASE);
      /**
       * THE PROLOGUE IS SEPARATED, NOT DISCARDED.
       *
       * Handing the loop back is itself an event: the world resumes, the first
       * repack after a teleport moves every instance, and any material that was
       * hidden while the rig was measuring compiles its program on the frame it
       * reappears. Measured, that first half-second contains a 222 ms frame —
       * eighty times the median — and leaving it in makes "worst frame" a
       * property of the instrument rather than of the game.
       *
       * But silently dropping frames from a HITCH detector is exactly how a
       * hitch detector comes to report no hitches. So the prologue is returned
       * alongside the walk, and the report prints it: if the resume transient
       * ever grows into something the player would also see on their first
       * frame in a new part of the wood, it is on the page rather than on the
       * cutting-room floor.
       */
      const cut = intervals.findIndex((_, i) =>
        intervals.slice(0, i + 1).reduce((a, b) => a + b, 0) > 500
      );
      const at = cut < 0 ? 2 : cut;
      observer?.disconnect();
      removeTimers?.();
      return {
        prologue: intervals.slice(0, at),
        intervals: intervals.slice(at),
        marks: marks.slice(at),
        phases: phases.slice(at),
        loaf,
        /**
         * Both reported so that "no long frames" and "long frames were not
         * measurable" cannot be confused, and so that a GC row reading zero is
         * distinguishable from a browser that does not expose the heap.
         */
        loafSupported: !!observer,
        heapSupported: !!mem,
        walkStarted: started,
        /**
         * Sampled once a frame. NOT a count of repacks: the culler holds
         * `uploaded` until the next repack actually runs, so a frame that did
         * no work reports whatever the last one moved. It is "how much the
         * packer has most recently had to move", which is the number that
         * matters for whether a repack can hide inside a frame.
         */
        uploaded: repacks.slice(at),
      };
    },
  };

  window.RR.perf = api;
  /**
   * A second, stable name for the Node side to look for.
   *
   * `RR` is the console's handle and its shape is allowed to change; this is
   * the handshake the scripts in scripts/perf/ wait on, and it exists so that
   * "the instrument is not in this build" is distinguishable from "the page has
   * not finished booting" — which is the difference between a clear error and a
   * 45-second timeout.
   */
  window.__RR_PERF__ = api;

  return () => held;
}
