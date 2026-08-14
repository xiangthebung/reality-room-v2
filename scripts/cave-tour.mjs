import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { caveAxisPoint, cavesNear, setWorldSeed } from '../src/world/terrain.js';
import { caveReady } from './_cave-ready.mjs';

/**
 * WALK IN, AT THE RESOLUTION SOMEBODY ACTUALLY PLAYS AT.
 *
 * `_inside.mjs` is the diagnostic: it teleports to the most characteristic ring
 * of each SHAPE, at 1280x720, because what it is for is answering "is the
 * bedding plane doing what a bedding plane should". It is a bad way to judge
 * whether a cave is any good, for the same reason a contact sheet of six
 * close-ups is a bad way to judge a room — a cave is a sequence, and the whole
 * argument for the crystals is about approach and arrival.
 *
 * So this walks the centre line from the gully to the far end at even
 * intervals, looking where you would be going, at 2560x1440.
 *
 *   node scripts/cave-tour.mjs [--seed=grove-01] [--stops=10] [--cave=-1]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots/tour');
const SEED = args.seed ?? 'grove-01';
const STOPS = Number(args.stops ?? 10);
mkdirSync(OUT, { recursive: true });
setWorldSeed(SEED);
const near = cavesNear(0, 0, 900);
const target = args.cave === undefined ? near[0] : near.find((c) => c.k === Number(args.cave)) ?? near[0];

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
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
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
await page.evaluate(() => {
  for (const id of ['toast', 'help', 'stats']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
});

// Stand in the gully first, purely so the streamer notices and builds it.
const approach = caveAxisPoint(target, target.aOpen - 6, 0);
await page.evaluate(
  (s) => {
    const { controller, director } = window.RR;
    director.ground();
    controller.keys.clear();
    controller.fly = true;
    controller.position.set(s.x, 60, s.z);
    controller.velocity.set(0, 0, 0);
  },
  { x: approach.x, z: approach.z }
);
// Then wait for the passage itself, not for five seconds — see `_cave-ready.mjs`.
// The `null` below aborts the whole tour, so a build this looked past is not one
// missing shot, it is an empty run that says the cave was never there.
await caveReady(page, target.k);

const plan = await page.evaluate((k) => {
  const cave = window.RR.caves.caves.get(k);
  if (!cave?.ready) return null;
  return {
    rings: cave.path.x.length,
    length: cave.length,
    blocks: cave.blocks.length,
    spires: cave.spires.length,
    crystals: cave.crystals.length,
    spores: cave.spores.length,
    lights: cave.lights.length,
    paths: cave.paths.length,
    tris: cave.mesh.geometry.index.count / 3,
    verts: cave.mesh.geometry.attributes.position.count,
  };
}, target.k);
if (!plan) {
  console.log(`k=${target.k} did not build`);
  await browser.close();
  process.exit(1);
}
console.log(
  `k=${target.k}  ${plan.length.toFixed(0)} m, ${plan.paths} passage(s), ${plan.rings} rings\n` +
    `  ${plan.tris} triangles, ${plan.verts} vertices, one draw\n` +
    `  ${plan.blocks} blocks, ${plan.spires} formations, ${plan.crystals} crystals, ` +
    `${plan.spores} spores, ${plan.lights} light sources\n`
);

for (let s = 0; s < STOPS; s++) {
  const t = s / (STOPS - 1);
  const info = await page.evaluate(
    ({ k, t: frac }) => {
      const R = window.RR;
      const p = R.caves.caves.get(k).path;
      // From ring 6, not ring 0: the first rings sit ON the gully floor by
      // construction, so teleporting the eye to "tube floor + 1.68" there puts
      // it inside the hillside. A player never gets that pose — at the mouth
      // caveFloorUnder blends to the terrain — but this script does not walk.
      const i = Math.max(6, Math.min(p.x.length - 14, Math.round(6 + frac * (p.x.length - 22))));
      const j = Math.min(p.x.length - 1, i + 12);
      const con = R.controller;
      // On the floor and on the axis: the pose a player walking through has.
      con.fly = false;
      con.position.set(p.x[i], p.y[i] - p.r[i] * p.f[i] + 1.68, p.z[i]);
      con.velocity.set(0, 0, 0);
      con.yaw = Math.atan2(-(p.x[j] - p.x[i]), -(p.z[j] - p.z[i]));
      con.pitch = 0;
      return { i, along: +p.along[i].toFixed(0), half: +(p.r[i] * p.w[i]).toFixed(1) };
    },
    { k: target.k, t }
  );
  await page.waitForTimeout(1600);
  const state = await page.evaluate(async () => {
    const con = window.RR.controller;
    const t = await import('/src/world/terrain.js');
    return {
      standing: +(con.position.y - con.caveFloor).toFixed(2),
      onGround: con.onGround,
      inCave: +con.inCave.toFixed(2),
      // Where the body ENDED UP against where it was put. A body that was
      // reported outside the cave gets clamped to the hillside, which is the
      // one failure this walk exists to catch.
      y: +con.position.y.toFixed(2),
      ground: +t.groundUnder(con.position.x, con.position.z).toFixed(2),
      wood: window.RR.forest.group.visible,
    };
  });
  const name = `${String(s).padStart(2, '0')}-${String(info.along).padStart(3, '0')}m`;
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(
    `  ${name}  ring ${String(info.i).padStart(3)}  half-width ${String(info.half).padStart(5)} m  ` +
      `eye ${state.standing} m over the floor  y=${state.y} ground=${state.ground}  inCave=${state.inCave}  wood=${state.wood}`
  );
}

if (problems.length) console.log('\nCONSOLE:', problems.slice(0, 6));
else console.log('\nno console errors');
await browser.close();
