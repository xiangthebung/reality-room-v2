import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { triage } from './known-noise.mjs';

/**
 * Drive the real app in a real browser and take pictures.
 *
 * The only way to know whether any of this works. A trip is a five-minute slow
 * envelope, so the script uses the debug panel's own seek — the same code path a
 * human uses — to jump the clock, which means these shots are of the real thing
 * rather than of a special screenshot mode.
 *
 *   node scripts/shoot.mjs [--url=…] [--out=.shots] [--wait=1200]
 *
 * Console errors and WebGL warnings are printed at the end; a shader that fails
 * to compile is otherwise completely silent from the outside.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots');
const SETTLE = Number(args.wait ?? 1400);

mkdirSync(OUT, { recursive: true });

/**
 * Camera stations. Each is a place in the forest worth looking at, and the
 * point of naming them is that the same station appears at several trip levels
 * so the shots can be compared side by side.
 */
const AT = {
  spawn: { x: 0, z: 5, yaw: 0.0, pitch: -0.02 },
  deep: { x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
  edge: { x: 18, z: 22, yaw: 2.4, pitch: 0.0 },
  stream: { x: 4, z: 20, yaw: 0.1, pitch: -0.12 },
  jukebox: { x: 2.6, z: -1.4, yaw: 0.42, pitch: -0.06 },
  up: { x: -30, z: -40, yaw: 0.8, pitch: 0.85 },
};

const SHOTS = [
  { name: '01-spawn', at: 'spawn', seek: null, note: 'spawn, sober' },
  { name: '02-deep', at: 'deep', seek: null, note: 'inside the wood, sober' },
  { name: '03-canopy', at: 'up', seek: null, note: 'looking up, sober' },
  { name: '04-jukebox', at: 'jukebox', seek: null, note: 'the machine' },
  { name: '05-stream', at: 'stream', seek: null, note: 'the water' },
  { name: '06-comeup', at: 'deep', seek: 38, note: 'come-up' },
  { name: '07-onset', at: 'deep', seek: 96, note: 'onset' },
  { name: '08-peak', at: 'deep', seek: 190, note: 'peak' },
  { name: '09-peak-spawn', at: 'spawn', seek: 190, note: 'peak, from the clearing' },
  { name: '10-peak-up', at: 'up', seek: 190, note: 'peak, canopy' },
  { name: '11-egodeath', at: 'deep', seek: 220, note: 'ego death' },
  { name: '12-comedown', at: 'deep', seek: 258, note: 'comedown' },
];

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
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });

const problems = [];
page.on('console', (msg) => {
  const type = msg.type();
  if (type === 'error' || type === 'warning') problems.push(`[${type}] ${msg.text()}`);
});
page.on('pageerror', (err) => problems.push(`[pageerror] ${err.message}\n${err.stack ?? ''}`));

/**
 * DEAFEN THE PAGE TO HOT RELOADS BEFORE IT LOADS.
 *
 * Vite pushes HMR updates over a websocket, and a save that lands mid-run
 * re-evaluates modules under a script that is halfway through positioning a
 * camera. The failure is silent and total: one run produced twelve screenshots
 * of the splash screen and reported "no console problems", because a reloaded
 * page has no console problems and the script never looked at what was in the
 * frame. Blocking the socket pins the page to the code it was served.
 *
 * Nothing here needs a websocket for any other reason — multiplayer is opt-in
 * on a key press and no shot takes one.
 */
await page.routeWebSocket(/.*/, () => {});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
/**
 * Wait for the gate to actually go, not for a guess at how long it takes.
 *
 * The entry handler waits on the ground ring settling and then on shader
 * compilation, both of which vary with the machine and with how much world has
 * been added since this number was picked. Falls back to the old fixed wait so
 * a gate that never lifts costs a bad screenshot rather than a hung script.
 */
await page
  .waitForSelector('#gate.gone', { timeout: 20000 })
  .catch(() => {});
await page.waitForTimeout(2500);
// The toast and the key hints sit on top of exactly the part of the frame worth
// looking at, and they are not what these shots are for.
await page.evaluate(() => {
  document.getElementById('toast').style.display = 'none';
  document.getElementById('help').style.display = 'none';
});

for (const shot of SHOTS) {
  await page.evaluate(
    ({ seek, station }) => {
      const { director, controller } = window.RR;
      if (seek === null || seek === undefined) director.ground();
      else director.seek(seek);
      controller.position.x = station.x;
      controller.position.z = station.z;
      controller.velocity.set(0, 0, 0);
      controller.yaw = station.yaw;
      controller.pitch = station.pitch;
    },
    { seek: shot.seek ?? null, station: AT[shot.at] }
  );
  await page.waitForTimeout(SETTLE);
  await page.screenshot({ path: `${OUT}/${shot.name}.png` });
  process.stdout.write(`${shot.name}  ${shot.note}\n`);
}

const stats = await page.evaluate(() => {
  const { pipeline, forest } = window.RR;
  return {
    trees: forest.treeCount,
    grass: forest.grassCount,
    size: [pipeline.size.x, pipeline.size.y],
  };
});

const { problems: real, suppressed } = triage(problems);
writeFileSync(`${OUT}/report.json`, JSON.stringify({ stats, problems: real, suppressed }, null, 2));
console.log('\nstats:', stats);
if (real.length) {
  console.log(`\n${real.length} console problem(s):`);
  for (const p of real.slice(0, 40)) console.log(' ', p);
} else {
  console.log('\nno console problems');
}
// Reported, not hidden: the expected figure is 43, and a run that suppresses
// far more than that has found something new wearing a familiar message.
if (suppressed) console.log(`(${suppressed} known-noise line(s) suppressed — see scripts/known-noise.mjs)`);

await browser.close();
