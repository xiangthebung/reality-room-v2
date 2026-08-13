import { boot } from './harness.mjs';

const { page } = await boot({ quiet: true });

const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
});

const sample = () =>
  page.evaluate(() => {
    const r = window.RR.renderer;
    let calls = 0;
    let tris = 0;
    const orig = r.render.bind(r);
    r.render = (s, c) => {
      orig(s, c);
      calls += r.info.render.calls;
      tris += r.info.render.triangles;
    };
    window.RR.forest.cull(window.RR.camera, true);
    window.RR.pipeline.render(0.016);
    r.render = orig;
    const q = window.RRSettings;
    const b = window.RR.forest.reachStats();
    const near = b.find((x) => x.id.startsWith('trunk:'));
    const far = b.find((x) => x.id.startsWith('trunk-far:'));
    const leaf = b.find((x) => x.id.startsWith('leaf:'));
    // The invariant, checked on every level rather than once.
    const bad = [];
    for (const t of b.filter((x) => x.id.startsWith('trunk:'))) {
      const f = b.find((x) => x.id === `trunk-far:${t.id.slice(6)}`);
      if (!f || f.minDistance !== t.maxDistance) bad.push(t.id);
    }
    return {
      calls,
      tris,
      reach: `${near.maxDistance}/${far.maxDistance} leaf ${leaf.maxDistance} near ${near.alwaysNear}`,
      scale: q.get('renderScale'),
      fog: q.get('fogDistance'),
      shadows: q.get('shadows'),
      density: q.get('instanceDensity'),
      bad,
    };
  });

console.log('level      tris        draws  reach                        scale  fog   shad  dens');
const rows = {};
for (const level of ['ultra', 'high', 'medium', 'low', 'potato']) {
  await page.evaluate((l) => window.RRSettings.setMode(l), level);
  await page.waitForTimeout(400);
  const s = await sample();
  rows[level] = s;
  console.log(
    `${level.padEnd(10)} ${String(s.tris).padStart(10)}  ${String(s.calls).padStart(5)}  ` +
      `${s.reach.padEnd(28)} ${String(s.scale).padEnd(6)} ${String(s.fog).padEnd(5)} ` +
      `${String(s.shadows).padEnd(5)} ${s.density}` +
      (s.bad.length ? `  BAND BREAK: ${s.bad.join(',')}` : '')
  );
}

// Back to ultra and confirm it is bit-for-bit what it was, i.e. the new rung
// costs the existing ladder nothing.
await page.evaluate(() => window.RRSettings.setMode('ultra'));
await page.waitForTimeout(400);
const again = await sample();
console.log(`\nultra restored: ${again.tris} tris (was ${rows.ultra.tris}) ${
  again.tris === rows.ultra.tris ? '— exact' : '— MISMATCH'
}`);

const cut = 1 - rows.potato.tris / rows.low.tris;
console.log(`potato vs low: ${(cut * 100).toFixed(1)}% fewer triangles`);
console.log(errs.length ? `\nERRORS:\n${errs.join('\n')}` : '\nno console errors');
process.exit(errs.length || again.tris !== rows.ultra.tris ? 1 : 0);
