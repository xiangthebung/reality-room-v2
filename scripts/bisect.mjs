import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Capture one frame with an arbitrary set of layers and effects switched off.
 *
 * The point is attribution. "There are straight lines in the picture" is not
 * actionable; "the straight lines survive with the trail off and vanish with the
 * leaves hidden" is. Everything is driven through `window.RR.probe`, so no
 * source file has to be edited and the world keeps running between captures.
 *
 *   node scripts/bisect.mjs --name=trail-off --off=trail --at=deep --seek=190
 *   node scripts/bisect.mjs --name=leaves-only --only=leaves,sky --seek=190
 *   node scripts/bisect.mjs --name=still --seek=190 --freeze --crop=600,300,500,400
 *
 * --off      comma-separated effects: trail, melt, bloom, world, audio
 * --hide     comma-separated layers to hide
 * --only     comma-separated layers to keep (hides everything else)
 * --gain     e.g. glow=0,colour=0.5
 * --at       camera station: spawn | deep | up | jukebox | stream | edge
 * --seek     trip seconds, or omit for sober
 * --freeze   stop the trip clock so successive shots are comparable
 * --scale    device pixel ratio (default 1)
 * --crop     x,y,w,h to save a detail crop alongside the full frame
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots/bisect');
const NAME = args.name ?? 'frame';
const WIDTH = Number(args.width ?? 1440);
const HEIGHT = Number(args.height ?? 810);
mkdirSync(OUT, { recursive: true });

const AT = {
  spawn: { x: 0, z: 5, yaw: 0.0, pitch: -0.02 },
  deep: { x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
  edge: { x: 18, z: 22, yaw: 2.4, pitch: 0.0 },
  stream: { x: 4, z: 20, yaw: 0.1, pitch: -0.12 },
  jukebox: { x: 2.6, z: -1.4, yaw: 0.42, pitch: -0.06 },
  up: { x: -30, z: -40, yaw: 0.8, pitch: 0.85 },
  ground: { x: -34, z: -46, yaw: 1.1, pitch: -0.55 },
};

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: Number(args.scale ?? 1),
});
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(m.text());
});

/**
 * DEAFEN THE PAGE TO HOT RELOADS BEFORE IT LOADS.
 *
 * The header above promises that no source file has to be edited and the world
 * keeps running between captures — a reload breaks the second half of that,
 * silently, by putting every `probe` setting back to its default just before
 * the shutter. The frame then shows a full-strength world under a filename
 * saying the layer is off, which is the one thing a bisect must never do.
 * Same guard as shoot.mjs.
 */
await page.routeWebSocket(/.*/, () => {});

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2200);
await page.evaluate(() => {
  document.getElementById('ui').style.display = 'none';
});

await page.evaluate(
  ({ off, hide, only, gain, station, seek, freeze }) => {
    const { probe, director, controller, debug } = window.RR;
    probe.reset();
    if (only.length) probe.only(...only);
    for (const layer of hide) probe.show(layer, false);
    for (const key of off) probe.set(key, false);
    for (const pair of gain) {
      const [k, v] = pair.split('=');
      probe.set(k, Number(v));
    }
    if (seek === null) director.ground();
    else director.seek(seek);
    controller.position.x = station.x;
    controller.position.z = station.z;
    controller.velocity.set(0, 0, 0);
    controller.yaw = station.yaw;
    controller.pitch = station.pitch;
    if (freeze) debug.speed = 0;
  },
  {
    off: (args.off ?? '').split(',').filter(Boolean),
    hide: (args.hide ?? '').split(',').filter(Boolean),
    only: (args.only ?? '').split(',').filter(Boolean),
    gain: (args.gain ?? '').split(',').filter(Boolean),
    station: AT[args.at ?? 'deep'],
    seek: args.seek === undefined ? null : Number(args.seek),
    freeze: args.freeze === 'true',
  }
);

// Long enough for the trail buffer to reach steady state, which is the whole
// point when the artefact under investigation is an accumulation.
await page.waitForTimeout(Number(args.wait ?? 2600));
await page.screenshot({ path: `${OUT}/${NAME}.png` });

if (args.crop) {
  const [x, y, w, h] = args.crop.split(',').map(Number);
  await page.screenshot({ path: `${OUT}/${NAME}-crop.png`, clip: { x, y, width: w, height: h } });
}

console.log(`${OUT}/${NAME}.png`);
if (problems.length) console.log('problems:', problems.slice(0, 5));
await browser.close();
