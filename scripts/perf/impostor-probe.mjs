/**
 * Does the impostor band exist, and what did it cost to make?
 *
 * The smallest question first: the atlases have to bake without an error, the
 * bands have to meet, and the memory has to be what the header of impostor.js
 * claims. Everything else this change is judged on — `reach-visible.mjs`, the
 * screenshots, `perf:stations` — is downstream of this passing.
 *
 * It also reports WHEN the bake happened, in frames, because the whole timing
 * argument is that it happens behind the gate. `#enter` is clicked after the
 * report is taken, so this is a measurement of the menu and not of the world.
 */
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5180/';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.routeWebSocket(/.*/, () => {});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
});
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });

// Still behind the gate. Wait for the bake to finish there and count how long
// it took in wall-clock — the gate is up for far longer than this in practice.
const t0 = Date.now();
await page.waitForFunction(() => window.RR.forest.impostorStats().ready, { timeout: 30000 });
const gateMs = Date.now() - t0;

const stats = await page.evaluate(() => window.RR.forest.impostorStats());
console.log('ATLAS');
console.log(`  ${stats.atlases} atlases, ${stats.textureSize}px, ${stats.spritesPerSide} sprites/side = ${stats.views} views`);
console.log(`  sprite ${stats.textureSize / stats.spritesPerSide}px square`);
console.log(`  VRAM ${(stats.bytes / 1048576).toFixed(1)} MB (${(stats.bytesEach / 1048576).toFixed(1)} MB each, RGBA8, no mip chain)`);
console.log(`  quad ${(stats.quadFill * 100).toFixed(0)}% the area of a square one (see the three-radii block)`);
console.log(`  bake ${stats.bakeMs.toFixed(0)} ms of GPU+JS work, spread over ${stats.atlases} frames`);
console.log(`  ready ${gateMs} ms after RR appeared, all of it behind the gate\n`);

await page.click('#enter');
await page.waitForTimeout(2500);

console.log('BANDS  (trunk.max must equal trunkFar.min, trunkFar.max must equal impostor.min)');
for (const level of ['ultra', 'high', 'medium', 'low', 'potato']) {
  const row = await page.evaluate(async (l) => {
    window.RRSettings.setMode(l);
    await new Promise((r) => setTimeout(r, 300));
    const b = window.RR.forest.reachStats();
    const bad = [];
    for (const t of b.filter((x) => x.id.startsWith('trunk:'))) {
      const key = t.id.slice(6);
      const f = b.find((x) => x.id === `trunk-far:${key}`);
      const i = b.find((x) => x.id === `impostor:${key}`);
      if (!f || f.minDistance !== t.maxDistance) bad.push(`${t.id} trunk/far`);
      if (!i || i.minDistance !== f.maxDistance) bad.push(`${t.id} far/impostor`);
    }
    const one = (p) => b.find((x) => x.id.startsWith(p));
    const imp = one('impostor:');
    // How many impostor instances are actually submitted at the spawn point.
    let drawn = 0;
    window.RR.forest.cull(window.RR.camera, true);
    for (const m of window.RR.forest.group.children) {
      if (m.name === 'impostor' && m.visible) drawn += m.count;
    }
    return {
      lod: one('trunk:').maxDistance,
      far: one('trunk-far:').maxDistance,
      leaf: one('leaf:').maxDistance,
      imp: `${imp.minDistance}-${imp.maxDistance}`,
      drawn,
      bad,
    };
  }, level);
  console.log(
    `  ${level.padEnd(7)} trunk<=${String(row.lod).padStart(3)}  far<=${String(row.far).padStart(3)}  ` +
      `leaf<=${String(row.leaf).padStart(3)}  impostor ${row.imp.padEnd(9)}  ` +
      `${String(row.drawn).padStart(5)} quads at spawn` +
      (row.bad.length ? `   BAND BREAK: ${row.bad.join(', ')}` : '')
  );
}

/**
 * WHAT THE BAND COSTS IN GEOMETRY, both ways, from one page session.
 *
 * The impostor band adds two triangles a tree where there were none, and takes
 * the far sweep's 216-594 away between `leafReach` and `reach` — so which way
 * the total moves is not obvious and is not the same on every rung. Measured
 * against the bands as they shipped (`geometryReach: reach`, band off), with the
 * camera and the streamed ring held still so the only difference is the bands.
 */
console.log('\nGEOMETRY  (spawn point, preset pinned at high, only the bands move)');
console.log('  rung       shipped bands      with impostors     quads   delta');
const rows = await page.evaluate(async () => {
  const R = window.RR;
  window.RRSettings.setMode('high');
  await new Promise((r) => setTimeout(r, 500));
  const count = () => {
    const r = R.renderer;
    let tris = 0;
    const orig = r.render.bind(r);
    r.render = (s, c) => {
      orig(s, c);
      tris += r.info.render.triangles;
    };
    R.forest.cull(R.camera, true);
    R.pipeline.render(0.016);
    r.render = orig;
    let quads = 0;
    for (const m of R.forest.group.children) {
      if (m.name === 'impostor' && m.visible) quads += m.count;
    }
    return { tris, quads };
  };
  const out = [];
  for (const rung of [
    { name: '250 medium', lod: 120, reach: 250, leafReach: 150 },
    { name: '180 low', lod: 90, reach: 180, leafReach: 110 },
    { name: '120 potato', lod: 60, reach: 120, leafReach: 90 },
  ]) {
    R.forest.setImpostors(false);
    R.forest.setReach(rung.lod, rung.reach, {
      leafReach: rung.leafReach,
      alwaysNear: 82,
      geometryReach: rung.reach,
    });
    const before = count();
    R.forest.setImpostors(true);
    R.forest.setReach(rung.lod, rung.reach, { leafReach: rung.leafReach, alwaysNear: 82 });
    const after = count();
    out.push({ name: rung.name, before: before.tris, after: after.tris, quads: after.quads });
  }
  return out;
});
for (const r of rows) {
  const d = ((r.after / r.before - 1) * 100).toFixed(1);
  console.log(
    `  ${r.name.padEnd(11)}${String(r.before).padStart(11)}  ${String(r.after).padStart(16)}` +
      `${String(r.quads).padStart(9)}  ${(d > 0 ? '+' : '') + d}%`
  );
}

console.log(errs.length ? `\nERRORS:\n${errs.join('\n')}` : '\nno console errors');
await browser.close();
/**
 * The audio errors this repo currently throws from `src/audio` are another
 * change's and are not counted here. Only errors that mention this module's own
 * files decide the exit code.
 */
const mine = errs.filter((e) => /impostor|forest\.js|pipeline\.js|culling\.js/i.test(e));
process.exit(mine.length ? 1 : 0);
