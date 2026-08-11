import { chromium } from 'playwright';

/**
 * Play the game the way a person would, without the debug panel: walk to the
 * jukebox, press E, walk to the nearest mushroom patch, press E, and confirm a
 * trip starts and that N ends it.
 */
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

/**
 * Deafen the page to hot reloads before it loads.
 *
 * Vite pushes HMR updates over a websocket, and a save landing mid-run
 * re-evaluates modules under a script that is halfway through a measurement.
 * The failure is silent and total: a reloaded page has no console problems, so
 * a check can screenshot the splash screen twelve times and report success.
 * This cost several runs during the multi-agent work of 2026-08-09, including
 * one false negative on this very file. Nothing here needs a websocket for any
 * other reason — multiplayer is opt-in on a key press.
 */
await page.routeWebSocket(/.*/, () => {});

await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2500);

const state = () => page.evaluate(() => ({
  prompt: document.getElementById('prompt').hidden ? null : document.getElementById('prompt').textContent.trim(),
  playing: window.RR.music?.playing ?? null,
  track: window.RR.music?.trackName ?? null,
  active: window.RR.director.state.active,
  phase: window.RR.director.state.phase.id,
  level: Number(window.RR.director.eased.toFixed(3)),
}));

const teleport = (x, z) => page.evaluate(([px, pz]) => {
  window.RR.controller.position.x = px;
  window.RR.controller.position.z = pz;
}, [x, z]);

console.log('after entering:', JSON.stringify(await state()));

// The midpoint between the two speakers, which is 2.8 m from each of them and
// therefore inside `NEAR_SPEAKER` — the interact test measures to the NEARER
// box now, not to this point. See main.js.
const jb = await page.evaluate(() => ({ x: window.RR.speakers.position.x, z: window.RR.speakers.position.z }));
await teleport(jb.x + 1.6, jb.z + 1.6);
await page.waitForTimeout(600);
console.log('at the speakers:', JSON.stringify(await state()));
await page.keyboard.press('KeyE');
await page.waitForTimeout(500);
console.log('after E:      ', JSON.stringify(await state()));
await page.keyboard.press('KeyQ');
await page.waitForTimeout(500);
console.log('after Q:      ', JSON.stringify(await state()));

const patch = await page.evaluate(() => {
  const ps = window.RR.forest.patches
    .map((p) => ({ ...p, d: Math.hypot(p.x, p.z) }))
    .sort((a, b) => a.d - b.d);
  return ps[0];
});
console.log(`nearest patch is ${patch.d.toFixed(1)} m from spawn`);
await teleport(patch.x + 0.8, patch.z + 0.8);
await page.waitForTimeout(600);
console.log('at mushrooms: ', JSON.stringify(await state()));
await page.keyboard.press('KeyE');
await page.waitForTimeout(1200);
console.log('after eating: ', JSON.stringify(await state()));

const stillOnTheGround = await page.evaluate(
  (id) => window.RR.forest.patches.some((p) => p.id === id),
  patch.id
);
console.log(`eaten patch still on the ground: ${stillOnTheGround} (must be false)`);

// Let it come up a little, then eat again from the next-nearest patch — the
// one just eaten is gone, so a redose has to come from a different patch now.
await page.evaluate(() => window.RR.director.seek(200));
await page.waitForTimeout(400);
const patch2 = await page.evaluate(() => {
  const ps = window.RR.forest.patches
    .map((p) => ({ ...p, d: Math.hypot(p.x, p.z) }))
    .sort((a, b) => a.d - b.d);
  return ps[0];
});
await teleport(patch2.x + 0.8, patch2.z + 0.8);
await page.waitForTimeout(300);
const before = await state();
await page.keyboard.press('KeyE');
await page.waitForTimeout(400);
const after = await state();
console.log(`redose at peak: level ${before.level} -> ${after.level} (must not jump)`);

await page.keyboard.press('KeyN');
await page.waitForTimeout(2500);
console.log('after N:      ', JSON.stringify(await state()));

console.log(errors.length ? `\nERRORS:\n  ${errors.join('\n  ')}` : '\nno errors');
await browser.close();
