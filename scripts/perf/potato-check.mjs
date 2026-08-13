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

/**
 * SAMPLE UNTIL THE WORLD STOPS CHANGING, NOT UNTIL A STOPWATCH SAYS SO.
 *
 * This waited 400 ms after each `setMode` and it was wrong for the reason this
 * repo has now been caught by five separate times: a fixed wait photographs a
 * half-arrived world, and the numbers it prints look entirely reasonable. The
 * symptom here was an ultra restore that missed by **110 632 triangles and one
 * draw call** — which is exactly one 128 m ground chunk, and is how the ground
 * ring was identified as the straggler rather than the tree field, whose
 * `pending` is already 0 by the time the gate drops.
 *
 * It got worse when the impostor bake landed, because that adds fifteen more
 * slabs and an atlas bake to the queue, and 400 ms stopped covering it. But the
 * bake did not CAUSE it — disabling the bake entirely still failed two runs in
 * three. A longer timeout would only move the failure rate, not remove it.
 *
 * So this polls instead: take a reading, take another, and only accept when two
 * consecutive readings agree on both the triangle count and the draw count. That
 * is self-calibrating — it does not need to know which subsystem is still
 * arriving, which matters because the answer has already changed once — and it
 * fails loudly rather than silently if the world never settles.
 */
const STABLE_TRIES = 80;
async function settled(label) {
  let prev = null;
  for (let i = 0; i < STABLE_TRIES; i++) {
    // The world's OWN signal first — both streaming rings drained and every
    // impostor atlas baked. Polling for two equal readings was not enough on
    // its own: the ground ring takes one chunk per frame, and two samples 250 ms
    // apart can agree while a chunk is still inbound. That is the difference
    // between "not changing right now" and "finished", and it cost this test
    // two rounds of a mismatch that was always exactly one ground chunk.
    if (await page.evaluate(() => window.RR.forest.settled)) {
      const s = await sample();
      if (prev && s.tris === prev.tris && s.calls === prev.calls) return s;
      prev = s;
    }
    await page.waitForTimeout(250);
  }
  console.log(`  (${label}: never settled in ${STABLE_TRIES} tries — reporting last reading)`);
  return prev;
}

console.log('level      tris        draws  reach                        scale  fog   shad  dens');
const rows = {};
for (const level of ['ultra', 'high', 'medium', 'low', 'potato']) {
  await page.evaluate((l) => window.RRSettings.setMode(l), level);
  const s = await settled(level);
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
const again = await settled('ultra restore');
console.log(`\nultra restored: ${again.tris} tris (was ${rows.ultra.tris}) ${
  again.tris === rows.ultra.tris ? '— exact' : '— MISMATCH'
}`);

const cut = 1 - rows.potato.tris / rows.low.tris;
console.log(`potato vs low: ${(cut * 100).toFixed(1)}% fewer triangles`);
console.log(errs.length ? `\nERRORS:\n${errs.join('\n')}` : '\nno console errors');
process.exit(errs.length || again.tris !== rows.ultra.tris ? 1 : 0);
