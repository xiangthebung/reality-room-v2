import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * One station, one surge crest, several configurations.
 *
 * The question this exists to answer is always the same one — WHICH LAYER is
 * drawing the thing I do not like — and the only way to answer it is to hold
 * everything else identical. So every shot here waits for the same surge
 * threshold and differs by exactly one probe setting.
 *
 *   node scripts/attribute.mjs [--at=spawn] [--out=.shots/attr]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const OUT = args.out ?? '.shots/attr';
mkdirSync(OUT, { recursive: true });

const AT = {
  spawn: { x: 0, z: 5, yaw: 0.0, pitch: -0.02 },
  deep: { x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
};
const station = AT[args.at ?? 'spawn'];

const CASES = [
  ['all', {}],
  ['no-melt', { melt: 0 }],
  ['no-morph', { morph: 0 }],
  ['no-glow', { glow: 0 }],
  ['no-colour', { colour: 0 }],
  ['no-trail', { trail: 0 }],
  ['no-surge', { surge: 0 }],
];

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
/**
 * DEAFEN THE PAGE TO HOT RELOADS BEFORE IT LOADS.
 *
 * This file's one job is holding everything identical but a single probe
 * setting. A reload resets every probe setting to its default, so the shots
 * after it differ from the shots before it by the reload as well — and the
 * whole method silently stops attributing anything. Same guard as shoot.mjs.
 */
await page.routeWebSocket(/.*/, () => {});

await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2000);
await page.evaluate(() => {
  document.getElementById('ui').style.display = 'none';
});

for (const [name, cfg] of CASES) {
  await page.evaluate(
    ({ c, s }) => {
      const { director, controller, pipeline, probe } = window.RR;
      probe.reset();
      director.seek(190);
      director.state.override = 1;
      director.eased = 1;
      for (const [k, v] of Object.entries(c)) {
        if (k === 'trail') pipeline.trailEnabled = !!v;
        else probe.set(k, v);
      }
      pipeline.clearHistory();
      controller.position.x = s.x;
      controller.position.z = s.z;
      controller.velocity.set(0, 0, 0);
      controller.yaw = s.yaw;
      controller.pitch = s.pitch;
    },
    { c: cfg, s: station }
  );
  await page.waitForTimeout(1500);
  // The surge is off in the no-surge case, so only wait for a crest when there
  // is one to wait for.
  if (!('surge' in cfg)) {
    await page.waitForFunction(() => window.RR.director.surge > 0.7, null, { timeout: 90000 });
  }
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(name);
}

await browser.close();
