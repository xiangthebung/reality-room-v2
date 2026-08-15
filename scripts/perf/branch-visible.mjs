/**
 * WHAT A TRUNK'S BRANCHES COST THE PICTURE — a pixel diff, not an opinion.
 *
 *   npm run check:branches
 *   npm run check:branches -- --level=low --arm="lod 20"
 *
 * A near trunk is 4350 triangles on average and 7766 at the worst; the reduced
 * sweep the far wood is drawn from is 206. Where the handover between them sits
 * is therefore the single largest number in `potato`'s frame, larger than every
 * other setting in the menu put together, and the whole question is how far in
 * it can be pulled before the wood stops looking like a wood.
 *
 * The arms sweep that handover and the last one abandons it: `coarse` points the
 * near mesh at the far geometry so that no tree at any distance keeps its
 * branches. That arm is the reason this script exists and it is REJECTED — see
 * the `coarseTrunks` block in forest.js and `.perf/shots/branch-stream-*.png`.
 *
 * THE ONLY HONEST WAY TO ASK IS INSIDE ONE PAGE SESSION. The first attempt at
 * this compared `.perf/shots/wood-potato.png` from two runs of `potato-shots`
 * an hour apart, and the two frames differ in the SUN — that script does not pin
 * the day — so the diff was dominated by an hour of light and the branches were
 * invisible inside it. Everything below is therefore rendered from one camera,
 * one minute of one day, with one thing moved between the two reads.
 *
 * The freezes are lifted from `reach-visible.mjs` and are not optional: the wind
 * runs on its own clock and the glow accumulator decays, so two "identical"
 * frames differ along every edge in the picture whatever is being tested. See
 * the block comments there.
 *
 * WHAT THE NUMBERS MEAN. `differing` is pixels that moved by more than 1/255 in
 * any channel, which is a strict test and will always be large for a change that
 * moves geometry — a branch is a hard edge and moving it lights up both sides.
 * `mean` is the average absolute move over the WHOLE frame and is the one to
 * read: it is what the difference is worth as brightness, and it is directly
 * comparable with the tables in `treeReach` and `impostor.js`, which are the two
 * cuts this one has to be judged against.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { argv, PERF_DIR } from './harness.mjs';

const args = argv({ level: 'potato', url: 'http://127.0.0.1:5180/', write: 'false', arm: 'lod 12' });
const WRITE = args.write === 'true';
if (WRITE) mkdirSync(`${PERF_DIR}/shots`, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.routeWebSocket(/.*/, () => {});
await page.goto(args.url, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page
  .waitForFunction(() => document.getElementById('gate')?.classList.contains('gone'), null, { timeout: 90000 })
  .catch(() => {});

const results = await page.evaluate(async (level) => {
  const R = window.RR;
  const gl = R.renderer.getContext();
  const raf = () => new Promise((r) => requestAnimationFrame(r));

  window.RRSettings.setMode(level);
  await new Promise((r) => setTimeout(r, 800));

  /**
   * Pin the day and kill the accumulator. `seek(160)` is the sober plateau every
   * other pixel test in this directory uses, so these frames are comparable with
   * theirs.
   */
  R.director.seek(160);
  for (let i = 0; i < 30; i++) R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
  R.pipeline.setTripParameters({ trail: 0 });
  R.probe.set('trail', false);

  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const a = new Uint8Array(w * h * 4);
  const b = new Uint8Array(w * h * 4);

  /**
   * Eye level everywhere but `above-flat`, and both halves of that matter.
   *
   * A reach cut is invisible at eye level and catastrophic from above, because
   * what it removes is distance. A BRANCH cut is the other way round: the
   * branches that vanish are the ones on the trees you are standing among, and
   * from 70 m up every tree is its canopy and nothing else. So the stations that
   * decide this are the enclosed ones, and `above-flat` is carried as the
   * control that should read near zero.
   */
  const STATIONS = [
    { name: 'wood', x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
    { name: 'clearing', x: 0, z: 8, yaw: 0, pitch: -0.03 },
    { name: 'ridge', x: 400, z: -96, yaw: -Math.PI / 2, pitch: -0.05 },
    { name: 'stream', x: 4, z: 20, yaw: 0.1, pitch: -0.12 },
    // Straight up into the crown: the one view whose whole subject is the
    // structure inside a canopy, i.e. the worst case for this cut.
    { name: 'canopy', x: -34, z: -46, yaw: 1.1, pitch: 0.85 },
    { name: 'above-flat', x: 400, z: -96, yaw: -Math.PI / 2, pitch: -0.06, lift: 70 },
  ];

  const seat = async (s) => {
    R.controller.position.x = s.x;
    R.controller.position.z = s.z;
    R.controller.position.y = -1e4;
    R.controller.velocity.set(0, 0, 0);
    R.controller.yaw = s.yaw;
    R.controller.pitch = s.pitch;
    R.controller.applyToCamera();
    R.director.ground();
    // Both rings take one sector per FRAME and the workers need turns of the
    // event loop to reply. See the same wait in reach-visible.mjs.
    for (let i = 0; i < 400; i++) await raf();
    if (s.lift) {
      R.camera.position.y += s.lift;
      R.camera.updateMatrixWorld(true);
    }
    R.pipeline.setTripParameters({ trail: 0 });
    R.probe.set('trail', false);
  };

  const shoot = (buf) => {
    R.forest.cull(R.camera, true);
    R.pipeline.render(1 / 60);
    R.pipeline.render(1 / 60);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const info = R.renderer.info;
    info.autoReset = false;
    info.reset();
    R.forest.cull(R.camera, true);
    R.pipeline.render(1 / 60);
    const c = { calls: info.render.calls, triangles: info.render.triangles };
    info.autoReset = true;
    return c;
  };

  /**
   * THE ARMS ARE A HANDOVER SWEEP, NOT AN ON/OFF, and finding out why is most of
   * what this script is for.
   *
   * The reduced sweep is already in the world — `trunk-far` has drawn it past
   * `lod` since the forest went endless — so "coarse trunks" is not a new mesh,
   * it is the existing handover moved in to zero. That makes the real question a
   * distance rather than a switch, and the distance has a FLOOR nothing here can
   * get under: the handover is tested per bucket against the bucket's nearest
   * point, `TREE_BUCKET` is 44 m, so the sphere is ~41 m of radius and no `lod`
   * below about 20 m removes another tree. `coarse: true` is the one arm that
   * escapes it, by pointing the near mesh at the far geometry so that the band
   * stops mattering.
   *
   * Everything is diffed against POTATO AS IT SHIPS, not against a full-reach
   * reference, because the question is what a change costs the people who are
   * already on this rung.
   */
  const ARMS = [
    { name: 'lod 60 (was)', lod: 60 },
    { name: 'lod 30', lod: 30 },
    { name: 'lod 20', lod: 20 },
    { name: 'lod 12', lod: 12 },
    { name: 'coarse (lod 0)', coarse: true },
  ];
  /**
   * THE REFERENCE IS READ OFF THE LIVE PRESET, NOT WRITTEN DOWN HERE.
   *
   * It started as a literal `{ lod: 60, leafReach: 90 }` — potato as it shipped
   * at the time — and went stale the same afternoon, when the row it was copied
   * from moved to 12. A reference that is a second copy of a preset is a slow
   * lie: every arm keeps reporting a plausible number and every one of them is
   * measured against a rung nobody is on. `reachStats` is the packers' own
   * answer, so the reference cannot disagree with the game.
   */
  const bands = R.forest.reachStats();
  const REFERENCE = {
    lod: bands.find((b) => b.id.startsWith('trunk:')).maxDistance,
    leafReach: bands.find((b) => b.id.startsWith('leaf:')).maxDistance,
  };
  const setArm = (arm) => {
    R.forest.setTrunkDetail(!!arm.coarse);
    R.forest.setReach(arm.lod ?? REFERENCE.lod, 120, {
      leafReach: arm.leafReach ?? REFERENCE.leafReach,
      alwaysNear: 0,
    });
  };

  const out = [];
  for (const s of STATIONS) {
    await seat(s);
    setArm(REFERENCE);
    const ref = shoot(a);
    for (const arm of ARMS) {
      setArm(arm);
      const cut = shoot(b);
      let differing = 0;
      let worst = 0;
      let sum = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(
          Math.abs(a[i] - b[i]),
          Math.abs(a[i + 1] - b[i + 1]),
          Math.abs(a[i + 2] - b[i + 2])
        );
        if (d > 1) differing++;
        if (d > worst) worst = d;
        sum += d;
      }
      out.push({
        station: s.name,
        arm: arm.name,
        differing,
        pixels: a.length / 4,
        worst,
        mean: sum / (a.length / 4),
        full: ref,
        coarse: cut,
      });
    }
  }
  setArm(REFERENCE);
  R.forest.setTrunkDetail(false);
  return out;
}, args.level);

console.log(
  `Branch detail isolated at ${args.level}: one page session, one camera, one minute of\n` +
    'one day, and nothing moving but forest.setTrunkDetail.\n'
);
console.log(
  `${'station'.padEnd(11)}${'arm'.padEnd(16)}${'differing px'.padStart(19)}` +
    `${'worst'.padStart(9)}${'mean'.padStart(8)}   tris          draws`
);
/** arm -> worst eye-level mean, and the triangle cut it bought. */
const byArm = new Map();
for (const r of results) {
  const pct = (r.differing / r.pixels) * 100;
  const e = byArm.get(r.arm) ?? { mean: 0, cut: 0, station: '' };
  // `canopy` is excluded from the worst-case: a view straight up into a crown is
  // the one place this cut is the subject rather than the background.
  if (r.station !== 'canopy' && r.mean > e.mean) {
    e.mean = r.mean;
    e.station = r.station;
  }
  // Signed and averaged, not a max: an arm ABOVE the shipped handover costs
  // triangles rather than saving them, and a max would print that as zero.
  e.cut = (e.cut * (e.n ?? 0) + (1 - r.coarse.triangles / r.full.triangles)) / ((e.n ?? 0) + 1);
  e.n = (e.n ?? 0) + 1;
  byArm.set(r.arm, e);
  console.log(
    `${r.station.padEnd(11)}${r.arm.padEnd(16)}${String(r.differing).padStart(9)} ` +
      `(${pct.toFixed(2).padStart(5)}%) ${String(r.worst).padStart(4)}/255 ${r.mean.toFixed(2).padStart(7)}   ` +
      `${(r.full.triangles / 1e6).toFixed(2)}M -> ${(r.coarse.triangles / 1e6).toFixed(2)}M ` +
      `${`(${(((r.coarse.triangles / r.full.triangles) - 1) * 100).toFixed(0)}%)`.padStart(7)}` +
      `   ${r.full.calls} -> ${r.coarse.calls}`
  );
}

console.log(`\n${'arm'.padEnd(16)}${'mean tri change'.padStart(16)}${'worst eye-level mean'.padStart(22)}`);
for (const [arm, e] of byArm) {
  console.log(
    `${arm.padEnd(16)}${`${e.cut > 0 ? '-' : '+'}${Math.abs(e.cut * 100).toFixed(0)}%`.padStart(16)}` +
      `${`${e.mean.toFixed(2)} (${e.station || 'none'})`.padStart(22)}`
  );
}

/**
 * A THRESHOLD, BECAUSE A REPORT NOBODY READS IS NOT A GATE — and it is applied
 * to the arm the game actually ships, not to the sweep.
 *
 * 4.0 of 255 is set against the two cuts this one has to be judged beside: the
 * impostor band's own table calls 1.64 acceptable at a station a player is
 * rarely at, and the fog change that was REVERTED was repainting the frame by
 * 7-16. A cut to the trunks the player is standing among lands between them by
 * construction, so the bar is "closer to the impostor band than to the thing
 * that was reverted".
 */
const LIMIT = 4.0;
const shipped = byArm.get(args.arm);
const failed = !shipped || shipped.mean > LIMIT;
console.log(
  failed
    ? `\nFAIL: the shipped arm reads ${shipped?.mean.toFixed(2) ?? '—'} > ${LIMIT} — this is changing the wood, not its branches.`
    : `\nok: the shipped arm is ${shipped.mean.toFixed(2)}, under the ${LIMIT}/255 bar at every eye-level station.`
);
writeFileSync(`${PERF_DIR}/branch-visible.json`, `${JSON.stringify({ level: args.level, results }, null, 2)}\n`);
await browser.close();
process.exit(failed ? 1 : 0);
