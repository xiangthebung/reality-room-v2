import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { cavesNear, setWorldSeed } from '../src/world/terrain.js';
import { caveReady } from './_cave-ready.mjs';

/**
 * Stand in front of ONE of each thing and look at it.
 *
 * The wide shots from `_inside.mjs` are how the cave is judged and they are
 * useless for saying which emitter is wrong: a passage lit at a tenth of a stop
 * shows a broken boulder, a broken drapery and a broken stalagmite as the same
 * pale triangle. This puts the camera three metres from a named object of each
 * class, at its own height, and turns the exposure up — so a shape that is
 * inside-out, degenerate or the wrong size says so immediately.
 *
 *   node scripts/cave-objects.mjs [--seed=grove-01] [--gain=6]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots/objects');
const SEED = args.seed ?? 'grove-01';
const GAIN = Number(args.gain ?? 6);
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
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
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

const c = near[0];
await page.evaluate(
  (s) => {
    const { controller, director } = window.RR;
    director.ground();
    controller.keys.clear();
    controller.fly = true;
    controller.position.set(s.x, 60, s.z);
    controller.velocity.set(0, 0, 0);
  },
  { x: c.x, z: c.z }
);
// Wait for the passage itself, not for four seconds — see `_cave-ready.mjs`.
// Every object this photographs is hung off `cave`, so looking early does not
// take a worse picture, it takes none at all.
await caveReady(page, c.k);

/**
 * The exposure lift is a uniform on the shared material, not a post effect.
 * Turning the whole pipeline up would also turn up the bloom and the tone
 * curve, and then a blown highlight in the picture might be either the object
 * or the grading — which is exactly the ambiguity this script exists to remove.
 */
const targets = await page.evaluate(
  ({ k, gain }) => {
    const cave = window.RR.caves.caves.get(k);
    if (!cave?.ready) return null;
    const mat = cave.mesh.material;
    mat.uniforms.uDayGain.value = 1;
    mat.uniforms.uAmbient.value.multiplyScalar(gain);
    const pick = (list, n) => {
      const out = [];
      if (!list?.length) return out;
      for (let i = 0; i < n; i++) out.push(list[Math.floor(((i + 0.5) / n) * list.length)]);
      return out;
    };
    const shots = [];
    for (const [i, b] of pick(cave.blocks, 2).entries()) {
      shots.push({ tag: `block-${i}`, x: b.x, y: b.y + b.top * 0.4, z: b.z, size: Math.max(b.rad, b.top) });
    }
    for (const kind of ['mite', 'tite', 'column', 'drape']) {
      const of = cave.spires.filter((s) => s.kind === kind);
      for (const [i, s] of pick(of, 1).entries()) {
        const y = s.kind === 'column' ? (s.y0 + s.y1) * 0.5 : s.y0 + (s.kind === 'mite' ? s.h * 0.5 : -s.h * 0.5);
        shots.push({ tag: `${kind}-${i}`, x: s.x, y, z: s.z, size: Math.max(s.h ?? 1, s.rad ?? 0.3, 1) });
      }
    }
    for (const [i, cr] of pick(cave.crystals, 2).entries()) {
      shots.push({
        tag: `crystal-${i}`,
        x: cr.x + cr.dx * cr.len * 0.5,
        y: cr.y + cr.dy * cr.len * 0.5,
        z: cr.z + cr.dz * cr.len * 0.5,
        size: cr.len,
      });
    }
    return {
      shots,
      counts: {
        blocks: cave.blocks.length,
        spires: cave.spires.length,
        crystals: cave.crystals.length,
        lights: cave.lights.length,
      },
    };
  },
  { k: c.k, gain: GAIN }
);
if (!targets) {
  console.log('cave not built');
  await browser.close();
  process.exit(1);
}
console.log(`k=${c.k}`, JSON.stringify(targets.counts));

for (const s of targets.shots) {
  const back = Math.max(2.2, s.size * 2.6);
  await page.evaluate(
    (t) => {
      const con = window.RR.controller;
      con.fly = true;
      // Backed off along a fixed bearing, so two runs frame the same object the
      // same way and a diff between them is the geometry and not the camera.
      const a = 0.7;
      con.position.set(t.x + Math.cos(a) * t.back, t.y + t.back * 0.28, t.z + Math.sin(a) * t.back);
      con.velocity.set(0, 0, 0);
      con.yaw = Math.atan2(-(t.x - con.position.x), -(t.z - con.position.z));
      con.pitch = Math.atan2(t.y - con.position.y, t.back);
    },
    { ...s, back }
  );
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${s.tag}.png` });
  console.log(`  ${s.tag.padEnd(12)} size ${s.size.toFixed(2)} m, from ${back.toFixed(1)} m`);
}

if (problems.length) console.log('CONSOLE:', problems.slice(0, 6));
await browser.close();
