import { chromium } from 'playwright';

/**
 * Assert that no plant can be displaced further than a plant plausibly bends.
 *
 * This is the regression test for the artefact that produced the complaint about
 * straight lines. Wind, breathing and the lean-toward-you term were authored in
 * absolute metres against fifteen-metre trees, and the same numbers were applied
 * to fifty-centimetre grass — so at the peak every tuft in the forest had its
 * tip thrown nearly three times its own height toward the camera, and twenty
 * thousand of them read as somebody having combed the ground.
 *
 * The bug is invisible in a still with the clock frozen and invisible in code
 * review, because each individual term looks reasonable. What it is NOT
 * invisible to is the ratio below: total peak displacement over the plant's own
 * height. Grass sits near 0.4, ferns near 0.3, trees near 0.1. The old code put
 * grass at 2.9.
 *
 * Run with the dev server up:  node scripts/check-plants.mjs
 */

const CEILING = 0.55;
const FLOOR = 0.02;

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

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
await page.waitForTimeout(1500);

const report = await page.evaluate(async () => {
  const { scene, director } = window.RR;
  // Drive the trip to its most displacing moment and let the eased level land.
  director.seek(190);
  director.state.override = 1;
  director.eased = 1;
  await new Promise((r) => setTimeout(r, 1200));

  const u = window.RR.tripUniforms;
  const uLean = u.uLean.value;
  const uSway = u.uSway.value;
  const uBreathAmp = u.uBreathAmp.value;
  const uFlow = u.uFlow.value;
  const uPulse = u.uPulse.value;

  const rows = [];
  const seen = new Set();
  scene.traverse((o) => {
    const geo = o.geometry;
    if (!geo?.attributes?.aScale) return;
    if (seen.has(geo.uuid)) return;
    seen.add(geo.uuid);
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const height = bb.max.y - bb.min.y;
    const scale = geo.attributes.aScale.array[0];

    // The three displacement terms, at their worst: full flex, full gust, full
    // breath. Mirrors the vertex shader in living.js.
    /**
     * The lean is gated to trees in the shader — see the lean block in
     * living.js — and this line has to carry the same gate or the check
     * reports a budget nobody is spending. `smoothstep(0.25, 0.45, aScale)`,
     * verbatim: trees 1, saplings and below nothing, meadow a seventh.
     */
    const t = Math.min(1, Math.max(0, (scale - 0.25) / 0.2));
    const leanGate = t * t * (3 - 2 * t);
    const lean = uLean * scale * leanGate;
    const wind = (0.16 + 0.25 * uSway) * scale;
    const breath = uBreathAmp * scale * 1.7;
    // The melt, which is geometry now. Peaks at the tip, where aFlex is 1.
    const flow = uFlow * scale * 0.45;
    /**
     * The canopy pulse, which only foliage gets. rrCanopy sums two sines of
     * amplitude 1 and 0.5, so its worst case is 1.5 — and unlike the terms
     * above it does not vanish at the root, because a leaf card is displaced
     * along its own outward normal wherever it hangs. It has to be in this
     * budget for the same reason the others are: a term that looks reasonable
     * on a fifteen-metre pine is what wrecked the grass last time.
     */
    const pulse = o.name === 'leaf' ? uPulse * scale * 1.5 : 0;
    const total = lean + wind + breath + flow + pulse;

    rows.push({
      name: o.name || o.type,
      height: Number(height.toFixed(2)),
      scale: Number(scale.toFixed(3)),
      lean: Number(lean.toFixed(3)),
      wind: Number(wind.toFixed(3)),
      breath: Number(breath.toFixed(3)),
      flow: Number(flow.toFixed(3)),
      pulse: Number(pulse.toFixed(3)),
      total: Number(total.toFixed(3)),
      ratio: Number((total / Math.max(height, 1e-3)).toFixed(3)),
    });
  });
  return { uLean, uSway, uBreathAmp, uFlow, uPulse, rows };
});

const pad = (s, n) => String(s).padEnd(n);
console.log(
  `uniforms at peak: uLean=${report.uLean.toFixed(2)} uSway=${report.uSway.toFixed(2)} ` +
    `uBreathAmp=${report.uBreathAmp.toFixed(3)} uPulse=${report.uPulse.toFixed(3)}\n`
);
console.log(
  pad('geometry', 10),
  pad('height', 8),
  pad('aScale', 8),
  pad('lean', 8),
  pad('wind', 8),
  pad('breath', 8),
  pad('flow', 8),
  pad('pulse', 8),
  pad('total', 8),
  'total/height'
);

const fails = [];
// Collapse the twelve tree archetypes into one line each per name.
const byName = new Map();
for (const r of report.rows) {
  const list = byName.get(r.name) ?? [];
  list.push(r);
  byName.set(r.name, list);
}
for (const [name, list] of byName) {
  const worst = list.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  console.log(
    pad(`${name} (${list.length})`, 10),
    pad(worst.height, 8),
    pad(worst.scale, 8),
    pad(worst.lean, 8),
    pad(worst.wind, 8),
    pad(worst.breath, 8),
    pad(worst.flow, 8),
    pad(worst.pulse, 8),
    pad(worst.total, 8),
    worst.ratio
  );
  if (worst.ratio > CEILING) {
    fails.push(
      `${name}: peak displacement is ${(worst.ratio * 100).toFixed(0)}% of its own height ` +
        `(${worst.total} m on a ${worst.height} m plant) — it will stretch into a streak`
    );
  }
  if (worst.ratio < FLOOR) {
    fails.push(`${name}: peak displacement is only ${(worst.ratio * 100).toFixed(1)}% — it will look dead`);
  }
}

if (!report.rows.length) fails.push('no geometry carries an aScale attribute — the fix is not wired up');
fails.push(...errors);

console.log(
  `\nceiling ${CEILING} (a plant may not move more than ${CEILING * 100}% of its own height)`
);
if (fails.length) {
  console.log('\nFAIL:');
  for (const f of fails) console.log('  ' + f);
  process.exitCode = 1;
} else {
  console.log('\nPASS: every plant moves like a plant');
}

await browser.close();
