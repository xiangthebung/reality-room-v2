import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = 'http://127.0.0.1:5180/';
mkdirSync('.perf/shots', { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.routeWebSocket(/.*/, () => {});
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2500);

// The ridge is the station that would expose a reach cut worst: the deepest
// sightline in the world with nothing near the eye to hide behind. `wood` is
// the ordinary case. Coordinates and the yaw convention are lifted from
// stations.mjs so these frames are comparable with every other measurement.
const STATIONS = {
  ridge: { x: 400, z: -96, yaw: -Math.PI / 2, pitch: -0.05 },
  wood: { x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
  /**
   * ABOVE THE CANOPY, WHICH IS THE ONLY PLACE THE REACH CUT IS VISIBLE AT ALL.
   *
   * `reach-visible.mjs` pixel-diffs the reach in isolation and finds it moves
   * 0.00–0.05% of pixels at every eye-level station in the world, including the
   * clearing and the long ridge view — a rainforest at head height simply does
   * not have a 120 m sightline in it, so the trees a reach cut removes were
   * already behind other trees. Lift the camera 70 m and that collapses: 14.7%
   * of pixels move at 250 m and 31.3% at 120 m.
   *
   * So this is the station that decides whether the paired fog is doing its
   * job. Everywhere else the question does not arise.
   */
  'above-flat': { x: 400, z: -96, yaw: -Math.PI / 2, pitch: -0.06, lift: 70 },
};

for (const [name, s] of Object.entries(STATIONS)) {
  for (const level of ['high', 'medium', 'low', 'potato']) {
    await page.evaluate((l) => window.RRSettings.setMode(l), level);
    await page.evaluate(async (st) => {
      const R = window.RR;
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      // Put the real one back before every station: the lift below replaces it
      // with a no-op, and a later station left holding that would seat its
      // camera nowhere and photograph whatever was on screen.
      if (!R.__origApply) R.__origApply = R.controller.applyToCamera.bind(R.controller);
      R.controller.applyToCamera = R.__origApply;
      R.controller.position.x = st.x;
      R.controller.position.z = st.z;
      R.controller.position.y = -1e4; // fall onto the ground wherever it is
      R.controller.velocity.set(0, 0, 0);
      R.controller.yaw = st.yaw;
      R.controller.pitch = st.pitch;
      R.controller.applyToCamera();
      R.director.ground();
      // Settle on the streamer, through the page's own rAF loop: both rings
      // accept one sector per FRAME and the workers need turns of the event
      // loop to reply. A fixed frame count photographs a half-arrived world.
      for (let i = 0; i < 400; i++) await raf();
      // The lift goes on after the settle: the streamer seats sectors around
      // the BODY, so raising it first just makes the ground clamp fight it for
      // the whole settle. Moving the camera alone leaves the ring built on the
      // ground below, which is the vantage wanted.
      if (st.lift) {
        /**
         * Neutering `applyToCamera` is what makes the lift survive to the
         * screenshot, and it took a wasted run to notice.
         *
         * The page's own rAF loop calls it every frame to seat the camera on
         * the body, so raising `camera.position.y` and then awaiting anything
         * at all — a timeout, a screenshot round-trip — hands back a frame
         * taken from the ground with the lift silently undone. It looks like a
         * correct eye-level shot, which is exactly why it is worth a comment:
         * nothing about the output says the vantage was ignored.
         *
         * `reach-visible.mjs` does not need this because it renders and reads
         * pixels synchronously inside one evaluate, with no frame in between.
         */
        R.controller.applyToCamera = () => {};
        R.camera.position.y += st.lift;
        R.camera.updateMatrixWorld(true);
        for (let i = 0; i < 4; i++) await raf();
      }
    }, s);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `.perf/shots/${name}-${level}.png` });
    console.log(`.perf/shots/${name}-${level}.png`);
  }
}
await browser.close();
