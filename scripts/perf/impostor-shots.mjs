/**
 * The above-canopy stations, photographed, because a pixel count is not a look.
 *
 * `reach-visible.mjs` says how many pixels moved; it cannot say whether what
 * replaced them is a treeline or a smear. Four frames from ONE page session,
 * differing only in `forest.setReach` and `forest.setImpostors`, so anything
 * that differs between them is the band:
 *
 *   full      the reference — 384 m of real geometry
 *   cut       the shipped short reach with the band off
 *   impostor  the same short reach with the band on
 *   handover  the band brought in to `leafReach`, so that the ring of leafless
 *             trunks between `leafReach` and `reach` becomes impostors too
 *
 * Preset pinned at high throughout, for the same reason reach-visible pins it:
 * what is on trial is the band, not the render scale or the fog.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = 'http://127.0.0.1:5180/';
const OUT = '.perf/shots';
mkdirSync(OUT, { recursive: true });

const arm = process.argv.find((a) => a.startsWith('--arm='))?.slice(6) ?? 'potato';
const ARMS = {
  medium: { lod: 120, reach: 250, leafReach: 150 },
  low: { lod: 90, reach: 180, leafReach: 110 },
  potato: { lod: 60, reach: 120, leafReach: 90 },
};
const A = ARMS[arm];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.routeWebSocket(/.*/, () => {});
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.waitForFunction(() => window.RR.forest.impostorStats().ready, { timeout: 30000 });
await page.click('#enter');
await page.waitForTimeout(2500);

await page.evaluate(async () => {
  const R = window.RR;
  window.RRSettings.setMode('high');
  await new Promise((r) => setTimeout(r, 600));
  R.director.seek(160);
  for (let i = 0; i < 30; i++) R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
  R.pipeline.setTripParameters({ trail: 0 });
  R.probe.set('trail', false);
});

const STATIONS = [
  { name: 'above', x: 0, z: 0, yaw: 0.7, pitch: -0.18, lift: 55 },
  { name: 'above-flat', x: 400, z: -96, yaw: -Math.PI / 2, pitch: -0.06, lift: 70 },
];

const FRAMES = [
  { tag: 'full', lod: 170, reach: 384, leafReach: 384, imp: true },
  { tag: 'cut', lod: A.lod, reach: A.reach, leafReach: A.leafReach, imp: false },
  { tag: 'impostor', lod: A.lod, reach: A.reach, leafReach: A.leafReach, imp: true },
  { tag: 'handover', lod: A.lod, reach: A.leafReach, leafReach: A.leafReach, imp: true },
];

for (const s of STATIONS) {
  /**
   * SEAT AND SHOOT IN ONE `evaluate`, and this is the trap this file was
   * written around after the first run produced four identical eye-level
   * frames.
   *
   * `lift` moves the CAMERA and not the body - see the block in
   * reach-visible.mjs for why - and the page's own rAF loop runs between two
   * `page.evaluate` calls, where `controller.applyToCamera()` puts the camera
   * straight back on the body's head. Split the seating from the render and
   * every frame here is taken from the forest floor, which is the one place the
   * reach demonstrably does not matter.
   */
  const shots = await page.evaluate(
    async ({ st, frames }) => {
      const R = window.RR;
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      R.controller.position.x = st.x;
      R.controller.position.z = st.z;
      R.controller.position.y = -1e4;
      R.controller.velocity.set(0, 0, 0);
      R.controller.yaw = st.yaw;
      R.controller.pitch = st.pitch;
      R.controller.applyToCamera();
      R.director.ground();
      for (let i = 0; i < 400; i++) await raf();
      R.camera.position.y += st.lift;
      R.camera.updateMatrixWorld(true);
      R.pipeline.setTripParameters({ trail: 0 });
      R.probe.set('trail', false);

      const out = [];
      for (const fr of frames) {
        R.forest.setImpostors(fr.imp);
        R.forest.setReach(fr.lod, fr.reach, { leafReach: fr.leafReach, alwaysNear: 82 });
        R.forest.cull(R.camera, true);
        R.pipeline.render(1 / 60);
        R.pipeline.render(1 / 60);
        // `toDataURL` in the same synchronous task as the render, because the
        // drawing buffer is not preserved and a Playwright screenshot would be
        // composited from whatever the rAF loop drew next.
        out.push({ tag: fr.tag, url: R.renderer.domElement.toDataURL('image/png') });
      }
      R.forest.setImpostors(true);
      return out;
    },
    { st: s, frames: FRAMES }
  );

  for (const shot of shots) {
    const file = `${OUT}/imp-${s.name}-${arm}-${shot.tag}.png`;
    writeFileSync(file, Buffer.from(shot.url.split(',')[1], 'base64'));
    console.log(file);
  }
}

await browser.close();
