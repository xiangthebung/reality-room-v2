import { chromium } from 'playwright';

/**
 * IS THE MOUNTAIN ACTUALLY BETWEEN YOU AND THE WORLD?
 *
 * Every other cave check measures the rock — that the ground is continuous,
 * that a mouth is dry, that you can walk in, that the floor is where your feet
 * are. This one measures the two things the rock is supposed to CUT OFF, both
 * of which shipped broken because both are decided by code that has no idea
 * caves exist:
 *
 *   THE RAIN fell in a 46 m box centred on the eye, through the ceiling, through
 *   the player and into the floor. Every other piece of weather — the water
 *   plane, the sun shafts, the mist, the sky dome — is hidden by the latch in
 *   main.js; the rain was not, because `points.visible` is written every frame
 *   by atmosphere's own weather block and a latch could not survive it.
 *
 *   THE INTERACTIONS were all found by HORIZONTAL distance. `seats.nearest`,
 *   `ferry.distanceTo`, `speakers.distanceTo` and the mushroom loop take (x, z)
 *   and nothing else, which was exactly right while the world had one surface.
 *   Sixty metres under a hillside it meant "Press E to sit" in the dark, and a
 *   mushroom growing in the sunlight overhead was yours to eat.
 *
 * BOTH ARE DRIVEN THROUGH THE REAL PATHS. The body is stood on the passage
 * floor and the frame loop is left to run, so `roofed` comes from the same
 * `caveSample` the movement uses; the key is a real `keydown` on `window`, so it
 * goes through `worldHearsKey` and `interact()` exactly as a player's does.
 * Reading the flags without pressing anything would not have caught either bug,
 * because neither was in the flags.
 *
 * THE CONTROL MATTERS AS MUCH AS THE TEST. A guard that returns null everywhere
 * passes half of this file, so the same mushroom is planted at the body's feet
 * in the clearing and the prompt has to appear — that is what stops the fix
 * being "you can no longer interact with anything".
 *
 * The weather is pinned dry under automation on purpose (see the block in
 * atmosphere.js), so this is the one script allowed to un-pin it: it walks the
 * world clock forward until this seed's own weather function says it is raining,
 * then asks the question in the open and underground without moving the clock
 * between the two.
 *
 *   node scripts/cave-seal.mjs [--seed=grove-01]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const SEED = args.seed ?? 'grove-01';
const URL = args.url ?? `http://127.0.0.1:5180/?seed=${SEED}`;

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
  if (m.type() === 'error') problems.push(m.text());
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
await page.routeWebSocket(/.*/, () => {});
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForSelector('#gate.gone', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2500);

/**
 * Somewhere deep, found rather than typed — a cave does not exist until it has
 * been streamed and built, so a literal coordinate would measure a hillside on
 * the first run after any change to the ring budget. Same reasoning, and the
 * same evaluate, as `cave-perf.mjs`.
 */
const spot = await page.evaluate(async () => {
  const R = window.RR;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const mod = await import('/src/world/terrain.js');
  const near = mod.cavesNear(0, 0, 900);
  if (!near.length) return null;
  const c0 = near[0];
  R.controller.keys.clear();
  R.controller.fly = true;
  R.controller.position.set(c0.x, 60, c0.z);
  R.controller.velocity.set(0, 0, 0);
  // Long enough for the rescan (twice a second) plus the sliced build.
  for (let i = 0; i < 400; i++) await raf();
  const cave = R.caves.caves.get(c0.k);
  if (!cave?.ready) return null;
  const p = cave.path;
  // The widest ring past 40 m in: well beyond any mouth, and open enough that
  // the body is not wedged against a wall while it settles.
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 10; i < p.x.length - 10; i++) {
    if (p.along[i] < 40) continue;
    const score = p.r[i] * p.w[i];
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) return null;
  return { k: c0.k, along: p.along[best], x: p.x[best], y: p.y[best] + 0.5, z: p.z[best] };
});

if (!spot) {
  console.log(`no built passage within 900 m on ${SEED} — nothing to stand in`);
  await browser.close();
  process.exit(1);
}
console.log(
  `passage k=${spot.k}, ${spot.along.toFixed(0)} m in at (${spot.x.toFixed(1)}, ${spot.z.toFixed(1)})\n`
);

const out = await page.evaluate(async (s) => {
  const R = window.RR;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const settle = async (n) => {
    for (let i = 0; i < n; i++) await raf();
  };
  const terrain = await import('/src/world/terrain.js');
  const clock = await import('/src/core/world-clock.js');
  const promptEl = document.getElementById('prompt');
  const readPrompt = () => (promptEl.hidden ? null : promptEl.textContent.trim());

  /**
   * Fly to a point, then fall the last half metre onto whatever floor is there.
   * Flying publishes the cave state but pushes the body nowhere, so the landing
   * is what proves the body is really standing in the passage.
   */
  const standAt = async (x, y, z) => {
    R.controller.keys.clear();
    R.controller.fly = true;
    R.controller.position.set(x, y, z);
    R.controller.velocity.set(0, 0, 0);
    await settle(30);
    R.controller.fly = false;
    await settle(90);
  };

  /** A mushroom exactly where the body is standing, at the SURFACE height. */
  const plant = (id) => {
    const p = R.controller.position;
    const patch = { id, sector: 'probe', x: p.x, y: terrain.groundUnder(p.x, p.z), z: p.z };
    R.forest.patches.push(patch);
    return patch;
  };
  const unplant = (patch) => {
    const i = R.forest.patches.indexOf(patch);
    if (i >= 0) R.forest.patches.splice(i, 1);
  };
  const pressE = () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));

  const result = {};

  // ---- deep underground ----------------------------------------------------
  await standAt(s.x, s.y, s.z);
  const doses0 = R.director.state.doses;
  const patch = plant('probe:0');
  await settle(10);
  result.cave = {
    inCave: Number(R.controller.inCave.toFixed(3)),
    depth: Math.round(R.controller.caveDepth),
    roofed: R.controller.roofed,
    rockOverhead: Number(
      (
        terrain.groundUnder(R.controller.position.x, R.controller.position.z) -
        R.controller.caveFloor
      ).toFixed(1)
    ),
    prompt: readPrompt(),
  };
  pressE();
  await settle(10);
  result.cave.patchStillThere = R.forest.patches.includes(patch);
  result.cave.dosesUnchanged = R.director.state.doses === doses0;
  unplant(patch);

  // ---- the same body and the same mushroom, in the clearing ----------------
  await standAt(0, terrain.groundUnder(0, 0) + 30, 0);
  const patch2 = plant('probe:1');
  await settle(10);
  result.surface = {
    inCave: R.controller.inCave,
    roofed: R.controller.roofed,
    prompt: readPrompt(),
  };
  unplant(patch2);
  await settle(5);

  // ---- rain, in the open and under the mountain ----------------------------
  Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
  let wetAge = null;
  for (let sec = 0; sec < 6000; sec += 12) {
    clock.adoptWorldAge(sec * 1000);
    await raf();
    if ((R.atmosphere.rainLevel ?? 0) > 0.35) {
      wetAge = sec;
      break;
    }
  }
  result.rain = { wetAge };
  if (wetAge !== null) {
    await settle(5);
    result.rain.surfaceLevel = Number(R.atmosphere.rainLevel.toFixed(2));
    result.rain.surfaceVisible = R.atmosphere.rain.points.visible;

    await standAt(s.x, s.y, s.z);
    // Put the clock back where it was: `standAt` spends two seconds of real
    // time and the weather would otherwise have moved on between the two reads.
    clock.adoptWorldAge(wetAge * 1000);
    await settle(5);
    result.rain.caveLevel = Number(R.atmosphere.rainLevel.toFixed(2));
    result.rain.caveVisible = R.atmosphere.rain.points.visible;
    result.rain.caveDepth = Math.round(R.controller.caveDepth);
    result.rain.caveRoofed = R.controller.roofed;
  }
  return result;
}, spot);

console.log(JSON.stringify(out, null, 2));

const fails = [];
if (!out.cave.roofed) fails.push('underground: `roofed` is false');
if (out.cave.prompt !== null) fails.push(`underground: the HUD offered "${out.cave.prompt}"`);
if (!out.cave.patchStillThere) fails.push('underground: E ate a mushroom on the surface overhead');
if (!out.cave.dosesUnchanged) fails.push('underground: E dosed the player');
if (out.surface.roofed) fails.push('clearing: `roofed` is true');
if (!out.surface.prompt) {
  fails.push('clearing: no prompt for a mushroom at your feet — the guard is too wide');
}
if (out.rain.wetAge === null) {
  fails.push('no rainy world-clock age inside 6000 s on this seed — rain untested');
} else {
  if (!out.rain.surfaceVisible) fails.push('clearing: rain not drawn while it is raining');
  if (!(out.rain.caveLevel > 0.02)) fails.push('underground: the shower ended; the read proves nothing');
  else if (out.rain.caveVisible) fails.push('underground: rain drawn inside the mountain');
}

console.log('');
if (problems.length) console.log(`page errors:\n  ${problems.join('\n  ')}\n`);
console.log(fails.length ? `FAIL\n  ${fails.join('\n  ')}` : 'PASS');
await browser.close();
process.exit(fails.length || problems.length ? 1 : 0);
