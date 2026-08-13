import { chromium } from 'playwright';

/**
 * GPU frame cost AT EACH STATION — the budget instrument for a look change.
 *
 *   node scripts/perf/stations.mjs [--width=2560] [--height=1440] [--only=canopy]
 *                                  [--json=.perf/stations.json] [--vs=.perf/stations.json]
 *
 * WHY THIS EXISTS WHEN gpu-perf.mjs ALREADY TIMES THE GPU.
 *
 * `gpu-perf.mjs` answers "how expensive is the trip" and never leaves spawn, so
 * every number it prints is the clearing. That is the CHEAPEST frame in the
 * game. A look change that adds mid-storey geometry, or fills a bare slope, is
 * invisible there by construction — the thing it changed is somewhere else.
 * This stands at the eight stations `look-shots.mjs` photographs, so a picture
 * and a millisecond figure exist for the same view.
 *
 * The timing rig is lifted from gpu-perf.mjs and the reasons are its reasons:
 * a fixed internal resolution so runs compare across machines, one
 * EXT_disjoint_timer_query spanning N frames rather than N queries (a query per
 * frame measures the queue as much as the work), and `setPixelRatio(1)` +
 * `pipeline.setSize` together, because resizing the renderer alone leaves the
 * post chain's targets at the old size and quietly measures a different frame
 * than the one on screen.
 *
 * TWO TRAPS THIS DEFENDS AGAINST, both of which produce confident wrong rows:
 *
 *   - THE WORLD HAS NOT ARRIVED. Teleporting invalidates the streamed set and
 *     both rings build one sector per frame. Timing straight after a seat reads
 *     whatever fraction of the wood happened to exist. `settle()` waits until
 *     two consecutive frames agree on draw calls AND triangles, and gives up
 *     loudly rather than silently timing a half-built forest.
 *   - THE CAMERA DRIFTS. The real loop runs `director.update()` every frame,
 *     which compounds the trip's dolly and sway. The director is grounded and
 *     the pose is re-asserted after settling, then verified: the printed row
 *     carries the eye position, and a station whose eye moved is not a station.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const URL = args.url ?? 'http://127.0.0.1:5180/';
const WIDTH = Number(args.width ?? 2560);
const HEIGHT = Number(args.height ?? 1440);
const ONLY = args.only ?? null;

// Yaw convention, from Controller.forward(): view is (-sin yaw, 0, -cos yaw).
const N = 0;
const S = Math.PI;
const W = Math.PI / 2;

/** The same eight views look-shots.mjs photographs, so a picture exists per row. */
const STATIONS = {
  clearing: { x: 0, z: 8, yaw: N, pitch: -0.03 },
  wood: { x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
  ridge: { x: 400, z: -96, yaw: -Math.PI / 2, pitch: -0.05 },
  canopy: { x: -34, z: -46, yaw: 1.1, pitch: 0.85 },
  floor: { x: -34, z: -46, yaw: 1.1, pitch: -0.62 },
  stream: { x: 4, z: 20, yaw: 0.1, pitch: -0.12 },
  glade: { x: 706, z: 212, yaw: S, pitch: 0.04 },
  far: { x: -812, z: 344, yaw: W, pitch: 0.05 },
};

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
// A hot reload landing inside a timer query orphans it on a dead context, which
// surfaces as an absurd time rather than an error. Same guard as gpu-perf.mjs.
await page.routeWebSocket(/.*/, () => {});
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2500);

const ok = await page.evaluate(
  ({ w, h }) => {
    const R = window.RR;
    if (!R.renderer.getContext().getExtension('EXT_disjoint_timer_query_webgl2')) return false;
    R.renderer.setPixelRatio(1);
    R.renderer.setSize(w, h, false);
    R.camera.aspect = w / h;
    R.camera.updateProjectionMatrix();
    R.pipeline.setSize(w, h, 1);
    R.pipeline.trailEnabled = false;
    R.director.ground();
    return true;
  },
  { w: WIDTH, h: HEIGHT }
);
if (!ok) {
  console.error('EXT_disjoint_timer_query_webgl2 unavailable — software GL context?');
  await browser.close();
  process.exit(1);
}

async function station(name, at) {
  return page.evaluate(async (s) => {
    const R = window.RR;
    const gl = R.renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const raf = () => new Promise((r) => requestAnimationFrame(r));

    const seat = () => {
      R.controller.position.x = s.x;
      R.controller.position.z = s.z;
      R.controller.position.y = -1e4; // fall onto the ground wherever it is
      R.controller.velocity.set(0, 0, 0);
      R.controller.yaw = s.yaw;
      R.controller.pitch = s.pitch;
      R.controller.applyToCamera();
    };
    seat();

    // Let the streamer build. rAF (not a bare loop) because both rings do one
    // sector per FRAME, and the workers need turns of the event loop to reply —
    // and the page's own frame() must keep running, which is why the probe is
    // NOT frozen here. Freezing it halts the streamer, and the station then
    // times a half-built wood that looks perfectly settled: 5.0 M triangles
    // where the recorded baseline for the same view is 11.96 M.
    /**
     * TWO AGREEING SAMPLES IS NOT SETTLED, AND THAT COST THIS SCRIPT ITS
     * CREDIBILITY ONCE ALREADY.
     *
     * The first version required one repeat of the counter pair plus an empty
     * queue. Both conditions are satisfiable in the middle of streaming: the
     * queue drains to zero between worker batches, and two samples four frames
     * apart agree whenever the streamer happens to pause. It settled early and
     * reported a station at 163 draws / 14.3 M triangles which, left running
     * another fifty frames, climbs to 249 / 31.9 M and STAYS there. Every
     * millisecond it printed was therefore the cost of a partly-arrived world,
     * reported with no indication that anything was missing — and the failure
     * is silent, repeatable and always in the flattering direction.
     *
     * So: eight consecutive agreements, an empty queue at every one of them,
     * and a floor of 150 frames before any of it counts. `agree` resets to zero
     * on any disagreement, so a late-arriving sector restarts the whole count
     * rather than being averaged away. The station reports UNSETTLED rather
     * than guessing if it never gets there.
     */
    /**
     * SETTLE ON WALL TIME, NOT ON FRAMES — the streamer does not run on the
     * frames this script draws.
     *
     * Two earlier versions of this settle were wrong in the same direction and
     * both looked convincing. The first took two agreeing samples four frames
     * apart plus an empty queue; the second took eight. Both still exited
     * early, and the station then timed a world that kept growing underneath
     * it: 14.3 M triangles at the moment of the reading, 31.9 M by the time the
     * batch finished. Every row was the cost of a half-arrived wood, and the
     * error is silent, repeatable, and always flattering.
     *
     * The reason frame-counting cannot work here: this script drives
     * `pipeline.render` directly in a tight loop with no yield, so the page's
     * own `frame()` — which is what advances the streamer — does not run during
     * the timed batch at all. It runs during the AWAITS. And the biggest await
     * in the whole function is the timer-query poll, which sleeps up to 3.2 s
     * waiting for the GPU to hand back a result. So the world arrives precisely
     * where nothing was watching for it.
     *
     * Sampling on a wall-clock interval measures the thing that actually
     * governs arrival. Four consecutive quiet samples 400 ms apart means the
     * wood has not changed for 1.6 s of real time with the queues empty, which
     * is the same claim the counters make in `.perf/baseline.json`.
     */
    let settled = false;
    let prev = null;
    let quiet = 0;
    for (let t = 0; t < 50 && !settled; t++) {
      await sleep(400);
      const pending =
        (R.forest?.field?.pending ?? 0) + (R.forest?.groundField?.pending ?? 0);
      const info = R.renderer.info;
      info.autoReset = false;
      info.reset();
      R.atmosphere.follow(R.camera);
      R.forest?.cull?.(R.camera, true);
      R.renderer.shadowMap.needsUpdate = true;
      R.pipeline.render(1 / 60);
      const now = `${info.render.calls}/${info.render.triangles}`;
      info.autoReset = true;
      // Both halves matter: an idle queue with a moving counter is a sector
      // still being merged, and a stable counter with a full queue is a wood
      // that has not arrived yet.
      quiet = prev === now && pending === 0 ? quiet + 1 : 0;
      if (quiet >= 4) settled = true;
      prev = now;
    }

    // Re-assert the pose: 400 frames of the real loop have moved the camera.
    R.director.ground();
    seat();
    R.atmosphere.follow(R.camera);
    R.forest?.cull?.(R.camera, true);

    /**
     * THE SHADOW MAP MUST BE RE-ARMED EVERY FRAME OR THIS MEASURES A DIFFERENT
     * GAME. The shadow pass is a second traversal of the whole scene, so it is
     * roughly half of both counters. It only runs when `needsUpdate` is set,
     * and the engine sets it from `atmosphere.follow` when the body has moved
     * or the sun has stepped — neither of which happens at a station, because
     * the whole point of a station is that the camera does not move.
     *
     * Timing N renders back to back therefore prices ONE shadow pass and N-1
     * cached frames, and the row comes out at 82 draws / 5.00 M triangles for a
     * view the recorded baseline puts at 174 / 11.96 M. Not noise — a
     * different frame, reported with total confidence. Re-arming per frame
     * measures the walking case, which is the one that has to hold 200 fps.
     */
    const frame = () => {
      R.atmosphere.follow(R.camera);
      R.forest?.cull?.(R.camera);
      R.renderer.shadowMap.needsUpdate = true;
      R.pipeline.render(1 / 60);
    };

    for (let i = 0; i < 12; i++) frame();
    gl.finish();

    const info = R.renderer.info;
    info.autoReset = false;
    info.reset();
    frame();
    const calls = info.render.calls;
    const tris = info.render.triangles;
    info.autoReset = true;

    // One query over N frames: a query per frame prices the driver queue too.
    const N = 24;
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    for (let i = 0; i < N; i++) frame();
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    gl.flush();
    for (let t = 0; t < 40; t++) {
      await sleep(80);
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
    }
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
    gl.deleteQuery(q);

    /**
     * AND THE COUNTERS ARE READ AGAIN AFTERWARDS, because a settle test can
     * only ever prove that the world had stopped arriving BEFORE the batch. If
     * it starts again during the 24 timed frames the timing is of a world that
     * no longer exists by the time the row is printed, and nothing else here
     * would notice. Cheap, and it turns a silent wrong number into a loud one.
     */
    info.autoReset = false;
    info.reset();
    frame();
    const calls2 = info.render.calls;
    const tris2 = info.render.triangles;
    info.autoReset = true;

    /**
     * THE REPORTED COUNTERS ARE THE ONES TAKEN BESIDE THE TIMING, NOT THE ONES
     * TAKEN BESIDE THE SETTLE.
     *
     * These two reads disagree by more than a factor of two — 141 draws /
     * 14.3 M triangles at the settle against 227 / 31.9 M immediately after the
     * batch — and the settle read is the wrong one. The settle samples a single
     * render that follows a 400 ms sleep, during which the page's own frame
     * loop has been running and has left the renderer in a state this script
     * does not control (the shadow map in particular is deferred by a frame by
     * main.js, so a lone render after a yield can miss the shadow pass that
     * every frame of the timed batch pays for).
     *
     * The batch is what the milliseconds describe, so the batch is what the
     * counters must describe too, or the row invites exactly the arithmetic —
     * cost per triangle, cost per draw — that it would then get wrong. `settleCalls`
     * is kept so the disagreement stays visible rather than being quietly resolved.
     */
    const eye = R.camera.position;
    return {
      ms: ns / 1e6 / N,
      calls: calls2,
      tris: tris2,
      settled,
      drifted: calls2 !== calls || tris2 !== tris,
      settleCalls: [calls, tris],
      disjoint: !!disjoint,
      eye: [eye.x, eye.y, eye.z].map((v) => Math.round(v * 10) / 10),
    };
  }, at);
}

console.log(`GPU frame cost by station at ${WIDTH}×${HEIGHT}, all passes\n`);
console.log('station      ms/frame     fps   draws      tris   eye');

const rows = {};
for (const [name, at] of Object.entries(STATIONS)) {
  if (ONLY && !name.includes(ONLY)) continue;
  const r = await station(name, at);
  rows[name] = r;
  const flags = [
    r.settled ? '' : ' UNSETTLED',
    r.drifted ? ` (settle read ${r.settleCalls[0]}/${(r.settleCalls[1] / 1e6).toFixed(2)}M)` : '',
    r.disjoint ? ' DISJOINT' : '',
    // The seat drops the body from 10 km up; a station that never landed is a
    // camera in the sky and its cost means nothing.
    r.eye[1] > 60 || r.eye[1] < -5 ? ' OFF-GROUND' : '',
  ].join('');
  console.log(
    `${name.padEnd(10)} ${r.ms.toFixed(2).padStart(7)} ${String(Math.round(1000 / r.ms)).padStart(6)}  ` +
      `${String(r.calls).padStart(5)}  ${(r.tris / 1e6).toFixed(2).padStart(6)}M  ` +
      `(${r.eye.join(', ')})${flags}`
  );
}

const worst = Object.entries(rows).sort((a, b) => b[1].ms - a[1].ms)[0];
if (worst) {
  console.log(
    `\nworst: ${worst[0]} at ${worst[1].ms.toFixed(2)} ms ` +
      `(${Math.round(1000 / worst[1].ms)} fps). Budget for 200 fps is 5.00 ms.`
  );
}

if (args.vs) {
  const { readFileSync } = await import('node:fs');
  const before = JSON.parse(readFileSync(args.vs, 'utf8'));
  console.log('\nvs baseline:');
  for (const [name, r] of Object.entries(rows)) {
    const b = before[name];
    if (!b) continue;
    const d = ((r.ms / b.ms - 1) * 100).toFixed(1);
    console.log(
      `${name.padEnd(10)} ${b.ms.toFixed(2)} → ${r.ms.toFixed(2)} ms  ${d > 0 ? '+' : ''}${d}%   ` +
        `draws ${b.calls} → ${r.calls}   tris ${(b.tris / 1e6).toFixed(2)}M → ${(r.tris / 1e6).toFixed(2)}M`
    );
  }
}

if (args.json) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(args.json), { recursive: true });
  writeFileSync(args.json, JSON.stringify(rows, null, 2));
  console.log(`\nwrote ${args.json}`);
}

await browser.close();
