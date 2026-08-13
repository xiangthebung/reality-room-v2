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
};

for (const [name, s] of Object.entries(STATIONS)) {
  for (const level of ['high', 'potato']) {
    await page.evaluate((l) => window.RRSettings.setMode(l), level);
    await page.evaluate(async (st) => {
      const R = window.RR;
      const raf = () => new Promise((r) => requestAnimationFrame(r));
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
    }, s);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `.perf/shots/${name}-${level}.png` });
    console.log(`.perf/shots/${name}-${level}.png`);
  }
}
await browser.close();
