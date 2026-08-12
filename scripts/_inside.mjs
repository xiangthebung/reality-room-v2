import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { caveAxisPoint, cavesNear, setWorldSeed } from '../src/world/terrain.js';

/** Stand inside a passage at the places its shape is doing something. */
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots/inside');
const SEED = args.seed ?? 'grove-01';
mkdirSync(OUT, { recursive: true });
setWorldSeed(SEED);
const near = cavesNear(0, 0, 900);

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
await page.evaluate(() => {
  for (const id of ['toast', 'help', 'stats']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
});

for (const c of near.slice(0, 2)) {
  const start = caveAxisPoint(c, c.aOpen - 6, 0);
  await page.evaluate(
    (s) => {
      const { controller, director } = window.RR;
      director.ground();
      controller.keys.clear();
      controller.fly = true;
      controller.position.set(s.x, 60, s.z);
      controller.velocity.set(0, 0, 0);
    },
    { x: start.x, z: start.z }
  );
  await page.waitForTimeout(3500);

  const plan = await page.evaluate((k) => {
    const cave = window.RR.caves.caves.get(k);
    if (!cave?.paths) return null;
    const out = [];
    /**
     * THE MOST CHARACTERISTIC RING OF EACH KIND, not the first one that passes a
     * threshold. The first version thresholded on half-width and picked ring 6
     * of every cave as its "room", because the MOUTH is 1.3 radii wide by
     * definition — so every shot was the doorway with the daylight in it.
     */
    const pick = (p, score) => {
      let best = -Infinity;
      let bi = -1;
      for (let i = 14; i < p.x.length - 10; i++) {
        const s = score(p, i);
        if (s > best) {
          best = s;
          bi = i;
        }
      }
      return { bi, best };
    };
    const KINDS = [
      ['room', (p, i) => p.r[i] * p.w[i]],
      ['canyon', (p, i) => (p.t[i] > 1.2 ? -p.w[i] : -99)],
      ['bedding', (p, i) => (p.t[i] < 0.75 ? p.w[i] : -99)],
      ['keyhole', (p, i) => p.key[i]],
      ['squeeze', (p, i) => -p.r[i] * Math.sqrt(p.w[i] * p.t[i])],
      ['water', (p, i) => p.wet[i] + p.pool[i]],
    ];
    for (let pi = 0; pi < cave.paths.length; pi++) {
      const p = cave.paths[pi];
      for (const [kind, score] of KINDS) {
        const { bi, best } = pick(p, score);
        if (bi < 0 || best <= -90) continue;
        out.push({ tag: pi === 0 ? kind : `branch-${kind}`, pi, i: bi });
      }
      if (pi > 0) out.push({ tag: 'junction', pi: 0, i: Math.max(2, p.base - 6) });
    }
    return {
      shots: out,
      blocks: cave.blocks.length,
      spires: cave.spires.length,
      water: cave.water.length,
      paths: cave.paths.length,
      tris: cave.mesh ? cave.mesh.geometry.index.count / 3 : 0,
      verts: cave.mesh ? cave.mesh.geometry.attributes.position.count : 0,
    };
  }, c.k);
  if (!plan) continue;
  console.log(
    `k=${c.k}  paths=${plan.paths}  blocks=${plan.blocks}  spires=${plan.spires}  waterRuns=${plan.water}  tris=${plan.tris}  verts=${plan.verts}`
  );

  for (const shot of plan.shots) {
    await page.evaluate(
      ({ k, pi, i }) => {
        const cave = window.RR.caves.caves.get(k);
        const p = cave.paths[pi];
        const con = window.RR.controller;
        const j = Math.min(p.x.length - 1, i + 8);
        con.fly = true;
        con.position.set(p.x[i], p.y[i] - p.r[i] * p.f[i] + 1.68, p.z[i]);
        con.velocity.set(0, 0, 0);
        con.yaw = Math.atan2(-(p.x[j] - p.x[i]), -(p.z[j] - p.z[i]));
        con.pitch = 0;
      },
      { k: c.k, pi: shot.pi, i: shot.i }
    );
    await page.waitForTimeout(1800);
    const state = await page.evaluate(() => {
      const R = window.RR;
      const con = R.controller;
      return {
        pos: [+con.position.x.toFixed(1), +con.position.y.toFixed(1), +con.position.z.toFixed(1)],
        inCave: +con.inCave.toFixed(2),
        depth: +con.caveDepth.toFixed(1),
        tight: +con.caveTight.toFixed(2),
        room: +con.caveRoom.toFixed(2),
        water: +con.caveWater.toFixed(2),
        waterVis: R.atmosphere?.water?.mesh?.visible,
        forestVis: R.forest?.group?.visible,
      };
    });
    console.log(`   ${shot.tag.padEnd(16)} ring=${String(shot.i).padStart(3)} ${JSON.stringify(state)}`);
    await page.screenshot({ path: `${OUT}/k${c.k}-${shot.tag}.png` });
  }
}

if (problems.length) console.log('CONSOLE:', problems.slice(0, 8));
else console.log('no console errors');
await browser.close();
