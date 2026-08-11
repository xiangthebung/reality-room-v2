import { boot, argv } from './harness.mjs';
import { median, bootstrapCI, decisive, NOISE_FLOOR_MS } from './stats.mjs';

/**
 * What the view breath costs, at every station and at two resolutions.
 *
 * `perf:why` already carries it as a lever, but that report answers one station
 * and its job is to rank the frame's big levers — a term worth 1% of the frame
 * sits at the bottom of that table with a confidence interval wider than it is.
 * This asks the narrower question with enough repetitions to answer it, and it
 * asks it at 1.4x linear resolution as well, because a fragment-stage term is
 * the one kind whose cost the render-scale cap multiplies directly.
 *
 *   node scripts/perf/viewbreath.mjs [--reps=10] [--build]
 *
 * Every row is an A-B-B-A pair from `probe.rigPair`, so the driver-state and
 * clock drift that separate runs always have is differenced out rather than
 * averaged over. Sober rows are expected to read zero and are here on purpose:
 * the output shader's branch is not taken at uViewWarp = 0, and "the feature is
 * free when it is not running" is a claim that should be measured rather than
 * asserted from reading the source.
 */

const args = argv({ reps: '10' });
const REPS = Number(args.reps);

const SPECS = [
  { name: 'clearing.sober', station: 'clearing', level: 'sober' },
  { name: 'clearing.peak', station: 'clearing', level: 'peak' },
  { name: 'deep.peak', station: 'deep', level: 'peak' },
  { name: 'canopy.sober', station: 'canopy', level: 'sober' },
  { name: 'canopy.peak', station: 'canopy', level: 'peak' },
  { name: 'canopy.egodeath', station: 'canopy', level: 'egodeath' },
];

const { browser, page } = await boot({
  url: args.build ? 'http://127.0.0.1:5182/' : undefined,
});

/**
 * PROVE THE LEVER MOVES BEFORE BELIEVING ANY ROW BELOW IT.
 *
 * A lever that does not actually change the frame reports zero cost with a
 * tight interval, which is indistinguishable from a free feature and is the
 * most dangerous failure this rig has — nobody investigates good news. So each
 * arm is set up exactly as a measured arm is, and the uniform the shader
 * branches on is read back off the live page.
 *
 * The A arm must be non-zero at a tripping station or the measurement is of
 * nothing; the B arm must be exactly zero or the two arms are the same frame.
 */
async function verifyLever() {
  const state = await page.evaluate(async () => {
    const read = () => window.RR.tripUniforms.uViewWarp.value;
    const out = {};
    for (const [arm, on] of [
      ['on', true],
      ['off', false],
    ]) {
      await window.__RR_PERF__.rigPair(
        { name: 'probe', station: 'canopy', level: 'peak' },
        { viewBreath: !on },
        { reps: 1 }
      );
      // rigPair restores the shipping rig on the way out, so the value above is
      // whatever the LAST arm left. Set it directly instead and step the
      // director the way `arrive` does.
      window.RR.director.switches.view = on;
      for (let i = 0; i < 10; i++) {
        window.RR.director.update(1 / 60, { camera: window.RR.camera, audioLevels: null });
      }
      out[arm] = read();
    }
    out.level = window.RR.tripUniforms.uLevel.value;
    window.RR.director.switches.view = true;
    return out;
  });
  const ok = state.on > 0 && state.off === 0;
  console.log(
    `lever check: uLevel ${state.level.toFixed(3)}, ` +
      `uViewWarp on ${state.on.toFixed(5)} / off ${state.off.toFixed(5)}  ` +
      `${ok ? 'the arms differ' : 'THE ARMS DO NOT DIFFER — every row below is meaningless'}`
  );
  if (!ok) {
    await browser.close();
    process.exit(1);
  }
}

await verifyLever();

/**
 * Arm B is the feature OFF, so a positive delta is a saving. The sign is
 * flipped here once, so every number printed below is what the feature COSTS.
 */
function summarise(rows) {
  const deltas = rows.map((r) => -r.delta);
  const ci = bootstrapCI(deltas);
  const frame = median(rows.map((r) => r.a));
  return { ci, frame, real: decisive(ci, frame, { floorMs: NOISE_FLOOR_MS }) };
}

for (const ratio of [1, 1.4]) {
  console.log(`\nrender scale ${ratio} — ${Math.round(2560 * ratio)}x${Math.round(1440 * ratio)}`);
  console.log('  station               frame      view breath                 share');
  console.log('  ' + '─'.repeat(64));
  for (const spec of SPECS) {
    const rows = await page.evaluate(
      ([s, r, reps]) =>
        window.__RR_PERF__.rigPair(s, { viewBreath: false }, { reps, base: { ratio: r } }),
      [spec, ratio, REPS]
    );
    const { ci, frame, real } = summarise(rows);
    const cell = real
      ? `${ci.median >= 0 ? '+' : ''}${ci.median.toFixed(3)} ms  ` +
        `[${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]  ` +
        `${((ci.median / frame) * 100).toFixed(1).padStart(5)}%`
      : `— below the noise floor (${ci.median >= 0 ? '+' : ''}${ci.median.toFixed(3)} ms)`;
    console.log(`  ${spec.name.padEnd(20)} ${frame.toFixed(2).padStart(6)} ms  ${cell}`);
  }
}

await browser.close();
