import { chromium } from 'playwright';
const URL = 'http://127.0.0.1:5180/?seed=taiga:grove-01';
const OUT = '.shots/taiga';
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-angle=d3d11', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(URL, { waitUntil: 'load' });
// dismiss the gate with a synthetic click (real clicks starve; see notes)
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const b = document.querySelector('#enter');
  if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
// wait on the real settle signal, not a frame count
await page.waitForFunction(() => window.RR && window.RR.forest && window.RR.forest.settled, null, { timeout: 90000 }).catch(() => {});
await page.waitForTimeout(1500);
const seats = {
  'a-spawn':  [0, 8, 0, -0.03],
  'b-deep':   [-34, -46, 1.1, 0.02],
  'c-canopy': [-34, -46, 1.1, 0.85],
  'd-ridge':  [400, -96, -Math.PI / 2, -0.05],
};
for (const [name, s] of Object.entries(seats)) {
  await page.evaluate((s) => {
    const R = window.RR;
    R.controller.position.x = s[0]; R.controller.position.z = s[1];
    R.controller.position.y = -1e4; R.controller.velocity.set(0, 0, 0);
    R.controller.yaw = s[2]; R.controller.pitch = s[3];
    R.controller.applyToCamera(); R.director.ground();
  }, s);
  await page.waitForFunction(() => window.RR.forest.settled, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('shot', name);
}
const stats = await page.evaluate(() => ({
  tris: window.RR.renderer.info.render.triangles,
  draws: window.RR.renderer.info.render.calls,
  settled: window.RR.forest.settled,
}));
console.log('stats', JSON.stringify(stats));
console.log('pageerrors', errs.length, errs.slice(0, 3).join(' | '));
await browser.close();
