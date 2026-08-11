import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
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

async function shot(name, cfg) {
  await page.evaluate((c) => {
    const { controller, director, pipeline, probe } = window.RR;
    probe.reset();
    director.seek(190);
    director.state.override = 1;
    director.eased = 1;
    window.RR.debug.speed = 1;
    pipeline.trailEnabled = c.trail !== false;
    window.RR.director.switches.melt = c.melt !== false;
    director.switches.melt = c.melt !== false;
    for (const [k, v] of Object.entries(c.gain ?? {})) director.gain[k] = v;
    for (const h of c.hide ?? []) probe.show(h, false);
    pipeline.clearHistory();
    controller.position.x = -34; controller.position.z = -46;
    controller.velocity.set(0, 0, 0);
    controller.yaw = 1.1; controller.pitch = -0.16;
  }, cfg);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: CROP });
  console.log(name);
}

await shot('x-all-on', {});
await shot('x-motion0', { gain: { motion: 0 } });
await shot('x-motion0-notrail-nomelt', { gain: { motion: 0 }, trail: false, melt: false });
await shot('x-nomelt', { melt: false });
await shot('x-lean-only-zero', { gain: { motion: 1 } });
await browser.close();
