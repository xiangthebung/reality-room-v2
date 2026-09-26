/**
 * WHAT A CHEAPER SHADOW MAP LOOKS LIKE — a pixel diff, not an opinion.
 *
 *   node scripts/perf/shadow-visible.mjs
 *
 * WHY THE BOX IS IN HERE WITH THE MAP, WHICH IS THE WHOLE POINT.
 *
 * The shadow pass's cost is `leaf area inside the frustum / texel area`. Write
 * the box half-extent as `s` and the map edge as `N`: the area is `ρ·(2s)²` and
 * a texel is `(2s/N)²`, so the fill is `ρ·N²` — the box CANCELS OUT COMPLETELY
 * and the cost depends on the map edge alone. `shadowcost.mjs` measured that as
 * `box 58 → 38` saving nothing, and this instrument is the other half of it:
 * once the map is chosen, the box is FREE, and what it buys is a straight trade
 * between how sharp the dapple is and how far the shadows reach.
 *
 *     map    box    mm/texel   shadows reach   cost
 *     2048    58        56.6            58 m   1.00x   (shipping)
 *     1024    58       113.3            58 m   0.25x   same range, half as sharp
 *     1024    40        78.1            40 m   0.25x   split the difference
 *     1024    29        56.6            29 m   0.25x   same sharpness, half the range
 *     1536    58        75.5            58 m   0.56x
 *     1536    44        57.3            44 m   0.56x
 *
 * Every row below 2048 costs a quarter or a half of the shipping pass. Which
 * one to ship is a question about the PICTURE, and the picture is what this
 * counts. Ranked by mean Δ over stations where the ground is actually visible.
 *
 * IT PINS THE PRESET AND MOVES NOTHING BUT THE SHADOW, on the pattern
 * `reach-visible.mjs` established: diffing the rungs would conflate this with
 * render scale, MSAA and the reach.
 *
 * THE FREEZES ARE NOT OPTIONAL. Without them this measures the wind and the
 * glow accumulator's decay rather than the shadows — see cull-check.mjs.
 */
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5180/';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.routeWebSocket(/.*/, () => {});
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2500);

const results = await page.evaluate(async () => {
  const R = window.RR;
  const gl = R.renderer.getContext();
  const raf = () => new Promise((r) => requestAnimationFrame(r));

  window.RRSettings.setMode('high');
  await new Promise((r) => setTimeout(r, 600));

  // Sober, and with the wake off: a decaying accumulator makes every frame
  // differ from the one before it whatever the shadow map is doing.
  R.director.ground();
  for (let i = 0; i < 30; i++) R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
  R.pipeline.setTripParameters({ trail: 0 });
  R.probe.set('trail', false);

  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const a = new Uint8Array(w * h * 4);
  const b = new Uint8Array(w * h * 4);

  /**
   * STATIONS WHERE THE GROUND IS IN FRAME, because a shadow you cannot see the
   * receiver of cannot move a pixel. `canopy` — looking straight up — is
   * carried as the CONTROL: it should report ~0.00% for every arm, and an arm
   * that moves pixels there is moving something other than the shadow.
   */
  const STATIONS = [
    { name: 'clearing', x: 0, z: 8, yaw: 0, pitch: -0.15 },
    { name: 'deep', x: -34, z: -46, yaw: 1.1, pitch: -0.12 },
    { name: 'stream', x: 4, z: 20, yaw: 0.1, pitch: -0.12 },
    { name: 'glade', x: 706, z: 212, yaw: Math.PI, pitch: -0.1 },
    { name: 'canopy', x: -30, z: -40, yaw: 0.8, pitch: 0.85 },
  ];

  const ARMS = [
    { name: '1024 / box 58', map: 1024, box: 58 },
    { name: '1024 / box 40', map: 1024, box: 40 },
    { name: '1024 / box 29', map: 1024, box: 29 },
    { name: '1536 / box 58', map: 1536, box: 58 },
    { name: '1536 / box 44', map: 1536, box: 44 },
  ];

  /**
   * Write one shadow configuration and force the map to be rebuilt.
   *
   * Disposing the map is what makes a size change take: three allocates the
   * depth texture once and `mapSize` afterwards is inert without it — which is
   * the failure mode that reads as "the lever is free".
   */
  const setShadow = (map, box) => {
    const sh = R.atmosphere.sun.shadow;
    sh.mapSize.set(map, map);
    sh.camera.left = -box;
    sh.camera.right = box;
    sh.camera.top = box;
    sh.camera.bottom = -box;
    sh.camera.updateProjectionMatrix();
    if (sh.map) {
      sh.map.dispose();
      sh.map = null;
    }
    R.renderer.shadowMap.needsUpdate = true;
  };

  const seat = async (s) => {
    R.controller.position.x = s.x;
    R.controller.position.z = s.z;
    R.controller.position.y = -1e4;
    R.controller.velocity.set(0, 0, 0);
    R.controller.yaw = s.yaw;
    R.controller.pitch = s.pitch;
    R.controller.applyToCamera();
    R.director.ground();
    for (let i = 0; i < 400; i++) await raf();
    R.pipeline.setTripParameters({ trail: 0 });
    R.probe.set('trail', false);
  };

  const shoot = (buf) => {
    R.forest.cull(R.camera, true);
    R.renderer.shadowMap.needsUpdate = true;
    R.pipeline.render(1 / 60);
    R.pipeline.render(1 / 60);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  };

  const out = [];
  for (const s of STATIONS) {
    await seat(s);
    setShadow(2048, 58);
    shoot(a);
    for (const arm of ARMS) {
      setShadow(arm.map, arm.box);
      shoot(b);
      let differing = 0;
      let heavy = 0;
      let worst = 0;
      let sum = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(
          Math.abs(a[i] - b[i]),
          Math.abs(a[i + 1] - b[i + 1]),
          Math.abs(a[i + 2] - b[i + 2])
        );
        if (d > 1) differing++;
        // A dapple edge that has moved by a texel changes a pixel by a lot; a
        // whole shadow that has vanished changes a REGION by a lot. `heavy`
        // separates "the same picture, resampled" from "a different picture".
        if (d > 24) heavy++;
        if (d > worst) worst = d;
        sum += d;
      }
      out.push({
        station: s.name,
        arm: arm.name,
        differing,
        heavy,
        pixels: a.length / 4,
        worst,
        mean: sum / (a.length / 4),
      });
    }
    setShadow(2048, 58);
  }
  return out;
});

console.log('Shadow map isolated: preset pinned at high, camera fixed, only sun.shadow moves.');
console.log('Reference is the shipping 2048 / box 58. `canopy` is the control and should read ~0.\n');
console.log('station   arm              differing px       >24/255      worst   mean Δ');
for (const r of results) {
  const pct = (r.differing / r.pixels) * 100;
  const hpct = (r.heavy / r.pixels) * 100;
  console.log(
    `${r.station.padEnd(9)} ${r.arm.padEnd(15)} ${String(r.differing).padStart(9)} ` +
      `(${pct.toFixed(2)}%)  ${hpct.toFixed(2)}%   ${String(r.worst).padStart(4)}/255   ${r.mean.toFixed(2)}`
  );
}
await browser.close();
