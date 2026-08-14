import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { caveAxisPoint, cavesNear, setWorldSeed } from '../src/world/terrain.js';
import { caveReady } from './_cave-ready.mjs';

/**
 * ANY POSE IN ONE CAVE, WHICH `cave-tour` DELIBERATELY CANNOT GIVE YOU.
 *
 * The tour walks the centre line at even intervals looking down the passage,
 * because a cave is a sequence and that is the honest way to judge one. It is
 * the wrong instrument for a question about ONE ROOM: "can you see how big the
 * terminal chamber is" depends entirely on which way you are facing in it, and
 * the tour's stop 13 faces the end wall of a fifty-metre hall with its back to
 * the only beam in it. Two frames taken from the same ring, one looking in and
 * one looking back, said more about the lighting than the whole twelve-stop
 * sheet did.
 *
 * Same idiom as `_inside.mjs` — a diagnostic, not a gate. It also dumps the
 * cave's own plan (beams, lights, water runs, the widest ring of every passage)
 * to `info.json` beside the shots, which is how the beam count and the still
 * pool's ring span were measured for the light pass.
 *
 * A pose is {name, ring, lookRing|yaw, pitch, dx, dy, dz, path, fly, clip}.
 * `clip` is a rectangle in screen pixels, for looking closely at one surface.
 *
 *   node scripts/_aim.mjs --out=.shots/x \
 *     --poses='[{"name":"hall-back","ring":903,"lookRing":868}]'
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots/aim');
const SEED = args.seed ?? 'grove-01';
const W = Number(args.width ?? 1600);
const H = Number(args.height ?? 900);
const poses = JSON.parse(args.poses ?? '[]');
mkdirSync(OUT, { recursive: true });
setWorldSeed(SEED);
const near = cavesNear(0, 0, 900);
const target = near[0];

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
const page = await browser.newPage({ viewport: { width: W, height: H } });
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
// For the passage, not for five seconds — see `_cave-ready.mjs`. This one is
// hand-driven rather than a gate, but every pose below is a ring index into a
// path that does not exist yet if this looks early.
await caveReady(page, target.k);

const info = await page.evaluate((k) => {
  const c = window.RR.caves.caves.get(k);
  if (!c?.ready) return null;
  const out = { paths: [], shafts: c.shafts?.length ?? 0, lights: c.lights.length, water: c.water.length };
  for (let p = 0; p < c.paths.length; p++) {
    const path = c.paths[p];
    let best = 0;
    let bi = 0;
    for (let i = 0; i < path.x.length; i++) {
      const half = path.r[i] * path.w[i];
      if (half > best) { best = half; bi = i; }
    }
    out.paths.push({
      p, n: path.x.length, endRing: path.endRing,
      maxHalf: +best.toFixed(1), at: bi,
      headAtMax: +(path.r[bi] * (path.f[bi] + path.t[bi])).toFixed(1),
    });
  }
  out.shaftList = (c.shafts ?? []).map((s) => ({
    x: +s.x.toFixed(1), y: +s.y.toFixed(1), z: +s.z.toFixed(1),
    h: +s.h.toFixed(1), rad: +s.rad.toFixed(1), gain: +s.gain.toFixed(2),
  }));
  out.waterList = c.water.map((w) => ({ path: w.path, i0: w.i0, i1: w.i1, still: !!w.still }));
  return out;
}, target.k);
console.log(JSON.stringify(info, null, 1));
writeFileSync(`${OUT}/info.json`, JSON.stringify(info, null, 1));

for (const pose of poses) {
  await page.evaluate(
    ({ k, pose }) => {
      const R = window.RR;
      const c = R.caves.caves.get(k);
      const p = c.paths[pose.path ?? 0];
      const i = Math.max(2, Math.min(p.x.length - 2, pose.ring | 0));
      const con = R.controller;
      con.fly = !!pose.fly;
      con.position.set(
        p.x[i] + (pose.dx ?? 0),
        p.y[i] - p.r[i] * p.f[i] + 1.68 + (pose.dy ?? 0),
        p.z[i] + (pose.dz ?? 0)
      );
      con.velocity.set(0, 0, 0);
      if (pose.lookRing !== undefined) {
        const j = Math.max(0, Math.min(p.x.length - 1, pose.lookRing | 0));
        con.yaw = Math.atan2(-(p.x[j] - p.x[i]), -(p.z[j] - p.z[i]));
      } else con.yaw = pose.yaw ?? 0;
      con.pitch = pose.pitch ?? 0;
    },
    { k: target.k, pose }
  );
  await page.waitForTimeout(1700);
  await page.screenshot({ path: `${OUT}/${pose.name}.png`, clip: pose.clip });
  console.log(`  ${pose.name}`);
}

if (problems.length) console.log('\nCONSOLE:', problems.slice(0, 6));
else console.log('\nno console errors');
await browser.close();
