import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The ego-death candidates, side by side, at one dissolve and one sun.
 *
 * The surface treatment ego death used to have was a quantised dither, deleted
 * on 2026-08-11 for reading as a lattice of see-through blocks. Four candidates
 * share that slot — see `director.ego` — and `shipped` (unedge 0.5 + swarm 1)
 * is the combination chosen from this contact sheet. The rejected three are
 * still shot, because a choice made by looking is re-taken by looking and that
 * needs the alternatives next to each other rather than in a commit message.
 *
 *   node scripts/ego-shots.mjs [--out=.shots/ego] [--at=221] [--wait=1400]
 *
 * WHY IT PINS THE SURGE TO ZERO, and this is the one thing in here that is not
 * obvious. Every amount in the director rides `state.surge`, a ~19 s carrier —
 * so two shots taken forty seconds apart are at different amplitudes of
 * everything, and the difference reads as attributable to the term under test.
 * `gain.surge = 0` removes the wave, which makes six frames comparable. The
 * daylight cycle is the same trap on a slower clock and is why this shoots
 * every candidate inside ONE page load; see the note in
 * trip-visuals-must-not-be-screen-filters about cross-run screenshots being
 * worthless here.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const OUT = resolve(process.cwd(), args.out ?? '.shots/ego');
const AT_SECONDS = Number(args.at ?? 221);
const SETTLE = Number(args.wait ?? 1400);
mkdirSync(OUT, { recursive: true });

/**
 * Two stations, chosen for what they expose rather than for the view. `near` is
 * a trunk at arm's length under a crown, which is where every near-field key in
 * these terms is at full strength and where the deleted dither was loudest.
 * `floor` looks down at the grass, which is the surface that foreshortens — the
 * one that turned filaments into caustics and would turn any surviving cell
 * structure into rows.
 */
const AT = {
  near: { x: -34, z: -46, yaw: 1.1, pitch: -0.25 },
  floor: { x: 0, z: 5, yaw: 0.0, pitch: -0.5 },
};

/** Must stay in step with the preset grid in ui/debug.js. */
const SETS = {
  shipped: { fade: 0, unedge: 0.5, unlight: 0, swarm: 1 },
  off: { fade: 0, unedge: 0, unlight: 0, swarm: 0 },
  fade: { fade: 0.55, unedge: 0, unlight: 0, swarm: 0 },
  unedge: { fade: 0, unedge: 1, unlight: 0, swarm: 0 },
  unlight: { fade: 0, unedge: 0, unlight: 0.7, swarm: 0 },
  swarm: { fade: 0, unedge: 0, unlight: 0, swarm: 0.85 },
};

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
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
// A hot reload mid-run drops `override` and photographs a sober forest under a
// filename that says ego death. Same guard as peak.mjs, which lost a whole run.
await page.routeWebSocket(/.*/, () => {});

await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2200);
await page.evaluate(() => {
  document.getElementById('ui').style.display = 'none';
  window.RR.director.gain.surge = 0;
});

for (const [station, s] of Object.entries(AT)) {
  for (const [name, set] of Object.entries(SETS)) {
    await page.evaluate(
      ({ st, ego, at }) => {
        const { director, controller, pipeline } = window.RR;
        director.seek(at);
        director.state.override = 1;
        director.eased = 1;
        Object.assign(director.ego, ego);
        pipeline.clearHistory();
        controller.position.x = st.x;
        controller.position.z = st.z;
        controller.velocity.set(0, 0, 0);
        controller.yaw = st.yaw;
        controller.pitch = st.pitch;
      },
      { st: s, ego: set, at: AT_SECONDS }
    );
    await page.waitForTimeout(SETTLE);
    const u = await page.evaluate(() => {
      const t = window.RR.tripUniforms;
      return { d: t.uDissolve.value, e: t.uEgo.value.toArray(), rim: t.uRim.value };
    });
    await page.screenshot({ path: `${OUT}/${station}-${name}.png` });
    process.stdout.write(
      `${station}-${name.padEnd(8)} uDissolve ${u.d.toFixed(2)}  uEgo ${u.e
        .map((v) => v.toFixed(2))
        .join(' ')}  uRim ${u.rim.toFixed(3)}\n`
    );
  }
}

console.log(
  problems.length
    ? `\n${problems.length} problem(s):\n  ${problems.slice(0, 20).join('\n  ')}`
    : '\nno console problems'
);
console.log(OUT);
await browser.close();
