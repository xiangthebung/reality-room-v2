/**
 * Is a shortened reach VISIBLE? — a pixel diff, not an opinion.
 *
 * `treeReach` claims 250 m is free at sober fog density, because the furthest
 * tree it removes was transmitting 1.27 parts in 255 and the framebuffer cannot
 * hold that. This checks the claim the only way it can be checked: render the
 * same frame twice, change nothing but the reach, and count the pixels that
 * moved.
 *
 * IT PINS THE PRESET AND MOVES ONLY `forest.setReach`, deliberately. Diffing
 * the `medium` and `high` RUNGS would conflate the reach with render scale and
 * MSAA and answer a different, obvious question. What is on trial is the reach.
 *
 * The freezes below are lifted wholesale from cull-check.mjs and they are not
 * optional — without them this measures the wind and the glow accumulator's
 * decay rather than the trees. See the block comments there.
 */
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5180/';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
// A hot reload landing mid-test re-evaluates modules underneath it and the diff
// silently compares two different builds. Same guard as cull-check.
await page.routeWebSocket(/.*/, () => {});
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2500);

const results = await page.evaluate(async () => {
  const R = window.RR;
  const gl = R.renderer.getContext();
  const raf = () => new Promise((r) => requestAnimationFrame(r));

  // High everywhere, so resolution, MSAA, shadows and fog are constant and the
  // reach is the only thing that moves.
  window.RRSettings.setMode('high');
  await new Promise((r) => setTimeout(r, 600));

  R.director.seek(160);
  for (let i = 0; i < 30; i++) R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
  R.pipeline.setTripParameters({ trail: 0 });
  R.probe.set('trail', false);

  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const a = new Uint8Array(w * h * 4);
  const b = new Uint8Array(w * h * 4);

  /**
   * CHOSEN ADVERSARIALLY, because the first run of this test was too kind.
   *
   * Four enclosed stations reported that even a 120 m reach moves 0.02% of the
   * pixels, which is not fog doing the work — it is the wood occluding itself.
   * A rainforest at eye level rarely has a 120 m sightline in it. So the honest
   * test is the places that DO: the spawn clearing, the stream corridor, and
   * above all a camera raised well above the canopy where nothing is in the way
   * and every tree removed is a tree you could have seen.
   */
  const STATIONS = [
    { name: 'ridge', x: 400, z: -96, yaw: -Math.PI / 2, pitch: -0.05 },
    { name: 'wood', x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
    { name: 'canopy', x: -34, z: -46, yaw: 1.1, pitch: 0.85 },
    { name: 'glade', x: 706, z: 212, yaw: Math.PI, pitch: 0.04 },
    { name: 'clearing', x: 0, z: 8, yaw: 0, pitch: -0.03 },
    { name: 'stream', x: 4, z: 20, yaw: 0.1, pitch: -0.12 },
    { name: 'far', x: -812, z: 344, yaw: -Math.PI / 2, pitch: 0.05 },
    // The worst case there is: above the canopy, looking down the longest
    // sightline the world has. `lift` is metres added after the ground clamp.
    { name: 'above', x: 0, z: 0, yaw: 0.7, pitch: -0.18, lift: 55 },
    { name: 'above-flat', x: 400, z: -96, yaw: -Math.PI / 2, pitch: -0.06, lift: 70 },
  ];
  const ARMS = [
    { name: '250 (medium)', lod: 120, reach: 250, leafReach: 150 },
    { name: '180 (low)', lod: 90, reach: 180, leafReach: 110 },
    { name: '120 (potato)', lod: 60, reach: 120, leafReach: 90 },
  ];

  const seat = async (s) => {
    R.controller.position.x = s.x;
    R.controller.position.z = s.z;
    R.controller.position.y = -1e4; // fall onto the ground wherever it is
    R.controller.velocity.set(0, 0, 0);
    R.controller.yaw = s.yaw;
    R.controller.pitch = s.pitch;
    R.controller.applyToCamera();
    R.director.ground();
    // Settle through the page's own rAF loop: both rings take one sector per
    // FRAME and the workers need turns of the event loop to reply.
    for (let i = 0; i < 400; i++) await raf();
    /**
     * The lift goes on AFTER the settle, not before it.
     *
     * The streamer seats sectors around the BODY, and the body is what the
     * ground clamp owns — raise it first and the clamp spends the whole settle
     * pulling it back down, so the frame is taken from a camera that is not
     * where the test asked for. Moving the camera alone afterwards leaves the
     * ring seated on the ground beneath, which is exactly the vantage wanted:
     * looking out over a wood that is fully built.
     */
    if (s.lift) {
      R.camera.position.y += s.lift;
      R.camera.updateMatrixWorld(true);
    }
    R.pipeline.setTripParameters({ trail: 0 });
    R.probe.set('trail', false);
  };

  const shoot = (buf) => {
    R.forest.cull(R.camera, true);
    R.pipeline.render(1 / 60);
    R.pipeline.render(1 / 60);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  };

  const out = [];
  for (const s of STATIONS) {
    await seat(s);
    R.forest.setReach(170, 384, { leafReach: 384, alwaysNear: 82 });
    shoot(a);
    for (const arm of ARMS) {
      R.forest.setReach(arm.lod, arm.reach, { leafReach: arm.leafReach, alwaysNear: 82 });
      shoot(b);
      let differing = 0;
      let worst = 0;
      let sum = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(
          Math.abs(a[i] - b[i]),
          Math.abs(a[i + 1] - b[i + 1]),
          Math.abs(a[i + 2] - b[i + 2])
        );
        if (d > 1) differing++;
        if (d > worst) worst = d;
        sum += d;
      }
      out.push({
        station: s.name,
        arm: arm.name,
        reach: arm.reach,
        differing,
        pixels: a.length / 4,
        worst,
        mean: sum / (a.length / 4),
      });
    }
  }
  return out;
});

console.log('Reach isolated: preset pinned at high, camera fixed, only forest.setReach moves.\n');
console.log('station   arm                differing px      worst Δ   mean Δ');
let worst250 = 0;
for (const r of results) {
  const pct = (r.differing / r.pixels) * 100;
  if (r.reach === 250) worst250 = Math.max(worst250, pct);
  console.log(
    `${r.station.padEnd(9)} ${r.arm.padEnd(15)} ${String(r.differing).padStart(9)} ` +
      `(${pct.toFixed(2)}%)  ${String(r.worst).padStart(4)}/255  ${r.mean.toFixed(2)}`
  );
}
console.log(
  `\n250 m worst case: ${worst250.toFixed(2)}% of pixels moved — ` +
    (worst250 < 1 ? 'free, as claimed.' : 'NOT free; the medium preset is changing the picture.')
);
await browser.close();
