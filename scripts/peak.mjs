import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Peak-only contact sheet.
 *
 * `shoot.mjs` covers the whole envelope; this one pins the level at the top and
 * looks at the same six places, because the only question it exists to answer is
 * "is the peak actually doing anything". Held with `override = 1` rather than by
 * seeking, so it is the real ceiling and not wherever the surge wave happens to
 * be at t=190.
 *
 *   node scripts/peak.mjs [--out=.shots/peak] [--wait=2500] [--tag=before]
 *                        [--level=1] [--surge=high|low]
 *
 * `--surge` waits for the director's own surge channel to reach a crest or a
 * trough before firing the shutter, rather than pinning it: a surge is supposed
 * to be an event you wait for, and a screenshot taken at whatever phase the
 * clock happened to be in cannot tell you whether the peak has any.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const OUT = resolve(process.cwd(), args.out ?? '.shots/peak');
const SETTLE = Number(args.wait ?? 2500);
const TAG = args.tag ? `${args.tag}-` : '';
const LEVEL = Number(args.level ?? 1);

mkdirSync(OUT, { recursive: true });

const AT = {
  spawn: { x: 0, z: 5, yaw: 0.0, pitch: -0.02 },
  deep: { x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
  near: { x: -34, z: -46, yaw: 1.1, pitch: -0.25 },
  up: { x: -30, z: -40, yaw: 0.8, pitch: 0.85 },
  stream: { x: 4, z: 20, yaw: 0.1, pitch: -0.12 },
  edge: { x: 18, z: 22, yaw: 2.4, pitch: 0.0 },
};

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

/**
 * DEAFEN THE PAGE TO HOT RELOADS BEFORE IT LOADS.
 *
 * A reload drops `override` back to nothing, so the remaining stations
 * photograph a sober forest under filenames that say peak — and this sheet gets
 * read side by side with a `--tag=before` run, where "the peak stopped doing
 * anything" is precisely the conclusion it invites. Same guard as shoot.mjs,
 * which lost a whole run of twelve screenshots of the splash screen to this.
 */
await page.routeWebSocket(/.*/, () => {});

await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2200);
await page.evaluate(() => {
  document.getElementById('ui').style.display = 'none';
});

for (const [name, station] of Object.entries(AT)) {
  await page.evaluate(
    ({ s, level }) => {
      const { director, controller, pipeline } = window.RR;
      director.seek(190);
      director.state.override = level;
      director.eased = level;
      pipeline.clearHistory();
      controller.position.x = s.x;
      controller.position.z = s.z;
      controller.velocity.set(0, 0, 0);
      controller.yaw = s.yaw;
      controller.pitch = s.pitch;
    },
    { s: station, level: LEVEL }
  );
  await page.waitForTimeout(SETTLE);
  // `arg` before `options`, and both are positional — passing the options object
  // second makes it the ARGUMENT and leaves the default 30 s timeout in place.
  if (args.surge === 'high') {
    await page.waitForFunction(() => window.RR.director.surge > 0.7, null, { timeout: 90000 });
  } else if (args.surge === 'low') {
    await page.waitForFunction(() => window.RR.director.surge < 0.05, null, { timeout: 90000 });
  }
  const surge = await page.evaluate(() => window.RR.director.surge);
  await page.screenshot({ path: `${OUT}/${TAG}${name}.png` });
  process.stdout.write(`${TAG}${name}  surge=${surge.toFixed(2)}\n`);
}

if (problems.length) {
  console.log(`\n${problems.length} console problem(s):`);
  for (const p of problems.slice(0, 25)) console.log(' ', p);
} else {
  console.log('\nno console problems');
}

await browser.close();
