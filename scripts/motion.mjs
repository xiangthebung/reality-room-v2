import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * Frames over time, with the world still moving.
 *
 * THE CLOCK MUST NOT BE FROZEN. Every other capture in this project pins
 * `debug.speed = 0` so successive stills are comparable, and that also freezes
 * `uTime` — which stops the melt field, stops the flow, and therefore stops the
 * trail from having anything to smear. A frozen still is structurally incapable
 * of showing a temporal artefact, and using one would have exonerated the trail
 * by construction.
 *
 * So the intensity is pinned with the envelope override instead, which holds the
 * trip at a fixed level while leaving every clock running.
 */
const OUT = '.shots/motion';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2000);
await page.evaluate(() => { document.getElementById('ui').style.display = 'none'; });

const CROP = { x: 260, y: 300, width: 760, height: 400 };

const setup = (yaw, trail) => page.evaluate(([y, t]) => {
  const { controller, director, pipeline } = window.RR;
  director.seek(190);
  director.state.override = 1;      // hold intensity, clocks keep running
  director.eased = 1;
  window.RR.debug.speed = 1;
  pipeline.trailEnabled = t;
  pipeline.clearHistory();
  controller.position.x = -34; controller.position.z = -46;
  controller.velocity.set(0, 0, 0);
  controller.yaw = y; controller.pitch = -0.16;
}, [yaw, trail]);

async function series(tag, trail) {
  await setup(1.1, trail);
  let elapsed = 0;
  for (const ms of [120, 1000, 4000, 12000]) {
    await page.waitForTimeout(ms - elapsed);
    elapsed = ms;
    await page.screenshot({ path: `${OUT}/${tag}-${String(ms).padStart(5, '0')}.png`, clip: CROP });
  }
  console.log(`${tag}: 4 frames`);
}

await series('trail-on', true);
await series('trail-off', false);

// Does the artefact travel with the view, or stay on the world?
await setup(1.1, true);
await page.waitForTimeout(9000);
for (let i = 0; i < 3; i++) {
  await page.evaluate((y) => { window.RR.controller.yaw = y; }, 1.1 + i * 0.05);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/turn-${i}.png`, clip: CROP });
}
console.log('turn: 3 frames');

await browser.close();
