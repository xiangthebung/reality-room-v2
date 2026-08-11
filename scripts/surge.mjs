import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * One surge, sampled and photographed.
 *
 * A crest and a trough side by side say how far the wave goes. They say nothing
 * about whether it reads as an EVENT, which is the entire justification for the
 * amplitude — and an event is a shape in time. So this logs the channel for a
 * full cycle and takes a frame every second and a half through it, from one
 * fixed camera, so the strip can be read as a sequence.
 *
 *   node scripts/surge.mjs [--at=deep] [--frames=10] [--every=1500]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const OUT = '.shots/surge';
mkdirSync(OUT, { recursive: true });

const AT = {
  deep: { x: -34, z: -46, yaw: 1.1, pitch: -0.1 },
  spawn: { x: 0, z: 5, yaw: 0.0, pitch: -0.02 },
};
const station = AT[args.at ?? 'deep'];
const FRAMES = Number(args.frames ?? 10);
const EVERY = Number(args.every ?? 1500);

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
/**
 * DEAFEN THE PAGE TO HOT RELOADS BEFORE IT LOADS.
 *
 * This logs one continuous cycle and photographs through it, and the strip is
 * only readable as a sequence because every frame comes from the same unbroken
 * run. A reload restarts the wave from zero halfway along, which does not look
 * like an error — it looks like a surge with a shape nobody designed. Same
 * guard as shoot.mjs.
 */
await page.routeWebSocket(/.*/, () => {});

await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2000);
await page.evaluate((s) => {
  const { director, controller } = window.RR;
  director.seek(190);
  director.state.override = 1;
  director.eased = 1;
  controller.position.x = s.x;
  controller.position.z = s.z;
  controller.velocity.set(0, 0, 0);
  controller.yaw = s.yaw;
  controller.pitch = s.pitch;
  document.getElementById('ui').style.display = 'none';
}, station);

// Start at a trough so the strip covers a rise and a fall rather than landing
// mid-wave.
await page.waitForFunction(() => window.RR.director.surge < 0.06, null, { timeout: 90000 });

for (let i = 0; i < FRAMES; i++) {
  const u = await page.evaluate(() => {
    const t = window.RR.tripUniforms;
    return {
      surge: window.RR.director.surge,
      glow: t.uGlow.value,
      detail: t.uDetail.value,
      swell: t.uSwell.value,
      rim: t.uRim.value,
      sat: t.uSat.value,
      flow: t.uFlow.value,
    };
  });
  await page.screenshot({ path: `${OUT}/${String(i).padStart(2, '0')}.png` });
  console.log(
    `${String(i).padStart(2)}  surge ${u.surge.toFixed(2)}  glow ${u.glow.toFixed(2)}  ` +
      `detail ${u.detail.toFixed(2)}  swell ${u.swell.toFixed(3)}  rim ${u.rim.toFixed(2)}  ` +
      `sat ${u.sat.toFixed(2)}  flow ${u.flow.toFixed(2)}`
  );
  await page.waitForTimeout(EVERY);
}

await browser.close();
