import { chromium } from 'playwright';

/**
 * Prove the culler never removes anything you could have seen.
 *
 * The test is a pixel comparison against ground truth: render a station with
 * the bucket culler active, then render the identical station with every
 * instance restored, and diff the two framebuffers. A correct culler is
 * INVISIBLE — the only instances it drops are ones that contribute no pixels,
 * so the images must match exactly.
 *
 * Stations are sampled mid-motion as well as at rest. That is the case that
 * matters: the repack only runs after ~2.5 m of travel or ~3° of turn, so
 * between repacks the visible set is stale by design and the packer's margin
 * is what covers the gap. Walking and turning a fraction under the threshold
 * is precisely where an inadequate margin shows up as popping.
 *
 *   node scripts/cull-check.mjs [--url=…]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';

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
/**
 * DEAFEN THE PAGE TO HOT RELOADS BEFORE IT LOADS.
 *
 * Vite pushes HMR updates over a websocket, and this run walks two kilometres
 * and renders twenty-two frames over the best part of a minute — a save landing
 * anywhere in that window re-evaluates modules underneath it. The failure is
 * silent: a reloaded page has no console problems, so the diff simply compares
 * one build's culled render against another build's un-culled one and reports
 * thousands of differing pixels as a culling bug. Same guard as shoot.mjs,
 * which lost a whole run of twelve screenshots of the splash screen to this.
 */
await page.routeWebSocket(/.*/, () => {});
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2500);

const results = await page.evaluate(async () => {
  const R = window.RR;
  const gl = R.renderer.getContext();

  // The trip's own clock must not advance between the two renders of a pair,
  // or the diff would measure the wind and the melt rather than the culling.
  R.director.seek(160);
  for (let i = 0; i < 30; i++) R.director.update(1 / 60, { camera: R.camera, audioLevels: null });

  /**
   * Silence the luminous wake for the duration of the test.
   *
   * The glow accumulator is a ping-pong buffer that carries state from one
   * render to the next, so two renders of an identical scene are NOT identical
   * — the second has one more step of decay in it. That showed up as a ±1 per
   * channel haze over every station and would mask exactly the small
   * differences this test exists to catch. Zeroing its contribution makes the
   * frame a pure function of the scene.
   */
  R.pipeline.setTripParameters({ trail: 0 });
  /**
   * …and turn it off at the switch as well, because zeroing the parameter is
   * not enough once a station has to WALK to get there.
   *
   * The nine original stations teleport, so nothing runs between the line above
   * and the renders and the accumulator stays at zero. The streamed stations
   * have to be walked to, hop by hop, awaiting hundreds of animation frames —
   * and every one of those frames calls `director.update`, which rewrites the
   * trip parameters from the current trip level and puts the wake straight
   * back. It showed up as a full-frame difference of one level per channel over
   * 4% of the pixels at the far stations and zero at the near ones, which is
   * exactly the signature the comment above describes and exactly what a
   * layer-by-layer bisection could not localise, because it was not in a layer.
   */
  R.probe.set('trail', false);

  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const a = new Uint8Array(w * h * 4);
  const b = new Uint8Array(w * h * 4);

  // Two renders, then read: the first settles anything one frame deep, so the
  // pair being compared are both in the same steady state.
  const shoot = (buf) => {
    R.pipeline.render(1 / 60);
    R.pipeline.render(1 / 60);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  };

  const STATIONS = [
    { name: 'spawn', x: 0, z: 5, yaw: 0, pitch: -0.02 },
    { name: 'spawn+turned', x: 0, z: 5, yaw: 2.6, pitch: 0.1 },
    { name: 'deep wood', x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
    { name: 'looking up', x: -30, z: -40, yaw: 0.8, pitch: 0.85 },
    { name: 'looking down', x: -30, z: -40, yaw: 0.8, pitch: -0.9 },
    { name: 'ridge, long view', x: 0, z: -70, yaw: Math.PI, pitch: 0.05 },
    { name: 'stream', x: 4, z: 20, yaw: 0.1, pitch: -0.12 },
    // Drifted from the last repack: just under the movement and turn
    // thresholds, which is where a too-small margin would show.
    { name: 'drifted 2.4 m', x: 0, z: 5, yaw: 0, pitch: -0.02, driftZ: 2.4 },
    { name: 'drifted 2.9°', x: -34, z: -46, yaw: 1.1, pitch: 0.02, driftYaw: 0.05 },
    /**
     * A KILOMETRE OUT, IN A SECTOR THAT DID NOT EXIST WHEN THE PAGE LOADED.
     *
     * The nine above stand in ground that arrived during the first fill and has
     * not moved since, which exercises the packer's steady state and nothing
     * else. The interesting failures are all in the machinery that runs while
     * the player walks: spans allocated out of a slab, the bucket list rebuilt
     * every time a sector arrives or is evicted, the incremental path thrown
     * away on each of those, and every tree split between a near mesh and a
     * reduced far one by distance band. Those are a completely different set of
     * ways to end up with a buffer that looks plausible and draws the wrong
     * trees, and only a station reached by walking exercises any of them.
     *
     * Two of them: one at rest, one turned, because the near/far split is a
     * function of distance from the eye and turning re-selects which side of it
     * every bucket in the frame falls on.
     */
    { name: 'streamed 1 km', x: 707, z: 707, yaw: 0.6, pitch: 0.0, stream: true },
    { name: 'streamed, turned', x: 707, z: 707, yaw: 3.4, pitch: 0.12, stream: true },
  ];

  /** Walk there in hops, giving the streamer frames to keep up. */
  const walkTo = async (x, z) => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const x0 = R.controller.position.x;
    const z0 = R.controller.position.z;
    const steps = Math.max(1, Math.ceil(Math.hypot(x - x0, z - z0) / 90));
    for (let i = 1; i <= steps; i++) {
      R.controller.position.x = x0 + ((x - x0) * i) / steps;
      R.controller.position.z = z0 + ((z - z0) * i) / steps;
      R.controller.velocity.set(0, 0, 0);
      await frame();
      await frame();
    }
    // The field takes at most one sector per frame on purpose, so the ring
    // needs frames rather than time. Long enough for both grids to settle.
    for (let i = 0; i < 260; i++) await frame();
  };

  const out = [];
  for (const s of STATIONS) {
    if (s.stream) await walkTo(s.x, s.z);
    R.controller.position.set(s.x, R.controller.position.y, s.z);
    R.controller.velocity.set(0, 0, 0);
    R.controller.yaw = s.yaw;
    R.controller.pitch = s.pitch;
    R.controller.applyToCamera();
    R.camera.position.y = R.controller.position.y;
    R.atmosphere.follow(R.camera);

    // Repack for THIS camera, then optionally drift the camera without
    // repacking — exactly what happens between frames in play.
    R.forest.cull(R.camera, true);
    if (s.driftZ || s.driftYaw) {
      R.controller.position.z += s.driftZ ?? 0;
      R.controller.yaw += s.driftYaw ?? 0;
      R.controller.applyToCamera();
      R.forest.cull(R.camera); // below threshold: should be a no-op
    }
    shoot(a);

    // Counted here, while the culled set is still the live one.
    let kept = 0;
    let capacity = 0;
    R.scene.traverse((o) => {
      if (o.isInstancedMesh) {
        kept += o.count;
        capacity += o.instanceMatrix.count;
      }
    });

    // Ground truth: same camera, every instance submitted.
    R.forest.culler.restoreAll();
    shoot(b);

    let differing = 0;
    let worst = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d =
        Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d > 0) {
        differing++;
        if (d > worst) worst = d;
      }
    }
    out.push({
      name: s.name,
      differing,
      pixels: w * h,
      worst,
      culledTo: Math.round((kept / capacity) * 100),
    });
  }
  return out;
});

let bad = 0;
console.log('Culled render vs every-instance render, pixel diff\n');
for (const r of results) {
  const pct = ((r.differing / r.pixels) * 100).toFixed(4);
  // A handful of pixels differing by 1-2/255 is float noise in the blend, not
  // a missing object; a dropped tree shows as thousands of pixels or a large
  // per-channel delta.
  const ok = r.differing === 0 || (r.differing / r.pixels < 0.0005 && r.worst <= 6);
  if (!ok) bad++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(16)} ` +
      `${String(r.differing).padStart(7)} px differ (${pct}%)  ` +
      `worst Δ ${String(r.worst).padStart(3)}/765   ` +
      `drawing ${r.culledTo}% of instances`
  );
}
console.log(bad === 0 ? '\nPASS: culling is invisible' : `\nFAIL: ${bad} station(s) lost geometry`);

await browser.close();
process.exit(bad === 0 ? 0 : 1);
