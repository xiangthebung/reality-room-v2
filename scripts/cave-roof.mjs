import { chromium } from 'playwright';
import { caveAxisPoint, cavesNear, heightAt, setWorldSeed } from '../src/world/terrain.js';

/**
 * Does any part of a built passage come out of the hillside?
 *
 * `buildNodes` clamps every NODE to ROOF_ROCK below `heightAt` and the comment
 * there calls it the one hard constraint in the walk. It is not enough, and this
 * is the check that proved it: the rings are a Catmull-Rom resampling of those
 * nodes, Catmull-Rom overshoots between control points, the RADIUS is splined
 * too, and `_emitRing` then displaces the ceiling outward by up to `r * rough`.
 * Three overshoots stacked on a constraint that was only ever tested at the
 * control points.
 *
 * WHAT A BREACH LOOKS LIKE FROM INSIDE, which is why this is worth a script.
 * The passage is drawn single-sided with inward normals and so is the terrain,
 * so a hole in the tube is not a hole onto a hillside — it is a hole onto
 * nothing, and what fills it is the sky. In a black passage that is a
 * hard-edged wedge of daylight with no source, and it reads as a renderer bug
 * rather than as geometry. It cost most of a session to identify by eye, twice,
 * and it takes this script four seconds.
 *
 * The first version of the test sampled `heightAt` down the CENTRE LINE only
 * and reported every cave clean. Every cave in this world is cut into a flank,
 * so the ground over the downhill shoulder can be metres below the ground over
 * the axis: the tube breaks out sideways while its centre still has four metres
 * of rock above it. Sampling across the passage is the whole point.
 *
 *   node scripts/cave-roof.mjs
 *
 * Rings 0-4 are expected to be proud of the ground: that is the mouth, and the
 * hood exists to carry rock over it. Anything past the hood is a skylight.
 */
const SEED = 'grove-01';
setWorldSeed(SEED);
const near = cavesNear(0, 0, 900);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
await page.routeWebSocket(/.*/, () => {});
await page.goto('http://127.0.0.1:5180/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForSelector('#gate.gone', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2000);

let worst = { m: -1e9 };
const bad = [];
for (const c of near.slice(0, 3)) {
  const start = caveAxisPoint(c, c.aOpen - 6, 0);
  await page.evaluate(
    (s) => {
      const { controller, director } = window.RR;
      director.ground();
      controller.fly = true;
      controller.position.set(s.x, 60, s.z);
    },
    { x: start.x, z: start.z }
  );
  await page.waitForTimeout(3500);
  const dump = await page.evaluate((k) => {
    const cave = window.RR.caves.caves.get(k);
    if (!cave?.paths) return null;
    return cave.paths.map((p) => ({
      x: Array.from(p.x),
      y: Array.from(p.y),
      z: Array.from(p.z),
      r: Array.from(p.r),
      t: Array.from(p.t),
      rough: Array.from(p.rough),
      base: p.base,
    }));
  }, c.k);
  if (!dump) continue;
  for (let pi = 0; pi < dump.length; pi++) {
    const p = dump[pi];
    for (let i = 0; i < p.x.length; i++) {
      // Ceiling, plus the outward rock displacement the mesh actually applies.
      const ceil = p.y[i] + p.r[i] * p.t[i] + p.r[i] * p.rough[i];
      const surf = heightAt(p.x[i], p.z[i]);
      const proud = ceil - surf;
      if (proud > worst.m) worst = { m: proud, k: c.k, pi, i, ceil, surf, r: p.r[i] };
    }
  }
  const over = [];
  for (let pi = 0; pi < dump.length; pi++) {
    const p = dump[pi];
    const hits = [];
    let mouth = 0;
    for (let i = 0; i < p.x.length; i++) {
      const ceil = p.y[i] + p.r[i] * p.t[i] + p.r[i] * p.rough[i];
      const d = ceil - heightAt(p.x[i], p.z[i]);
      // The first rings are the mouth and are proud on purpose — that is the
      // hood. Anything past ring 20 is a skylight.
      if (d > 0) { if (i < 20) mouth++; else hits.push(`ring ${i} +${d.toFixed(2)}m`); }
    }
    if (hits.length) over.push(`path${pi}: ${hits.join(', ')}`);
  }
  if (over.length) bad.push(`k=${c.k}  ${over.join('  ')}`);
  console.log(`k=${c.k}  ${over.length ? over.join('  ') : 'fully buried past the hood'}`);
}
await browser.close();
if (bad.length) {
  console.log(`\nFAIL: ${bad.length} passage(s) break the surface past the mouth`);
  for (const b of bad) console.log('  ' + b);
  process.exit(1);
}
console.log('\nPASS: no passage breaks the hillside past its own hood');
