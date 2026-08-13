/**
 * WHAT THE IMPOSTOR BAND COSTS IN MILLISECONDS — A/B, INTERLEAVED, ONE SESSION.
 *
 *   node scripts/perf/impostor-cost.mjs [--rung=medium] [--rounds=3]
 *
 * WHY NOT JUST RUN `perf:stations` TWICE. Two reasons, and the first one is
 * recorded in this directory already: a previous change was credited with
 * +0.24 ms that turned out to be machine drift, because the whole baseline had
 * moved between the two runs — including at stations with no foliage in them.
 * A/B has to be interleaved inside one page session or it is measuring the
 * afternoon. Rounds go A B B A so a monotonic drift cancels out of the pair.
 *
 * The second reason is that `perf:stations` times whatever preset the governor
 * settled on, and the impostor band is EMPTY at `high` and `ultra`. Timing it
 * there would truthfully report zero and answer nothing. This pins a rung.
 *
 * ARM A is the bands as they shipped: `geometryReach: reach`, band off. ARM B
 * is the default: geometry ends at `leafReach` and quads run to 384 m.
 *
 * The timing rig — fixed internal resolution, one timer query over 24 frames,
 * the shadow map re-armed every frame, wall-clock settling — is lifted whole
 * from stations.mjs, and every one of those choices is a bug that script has
 * already paid for. See its comments.
 */
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const WIDTH = Number(args.width ?? 2560);
const HEIGHT = Number(args.height ?? 1440);
const ROUNDS = Number(args.rounds ?? 3);
const RUNGS = {
  medium: { lod: 120, reach: 250, leafReach: 150, alwaysNear: 82 },
  low: { lod: 90, reach: 180, leafReach: 110, alwaysNear: 0 },
  potato: { lod: 60, reach: 120, leafReach: 90, alwaysNear: 0 },
};
const RUNG = RUNGS[args.rung ?? 'medium'];

const STATIONS = {
  clearing: { x: 0, z: 8, yaw: 0, pitch: -0.03 },
  wood: { x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
  ridge: { x: 400, z: -96, yaw: -Math.PI / 2, pitch: -0.05 },
  // The canopy station has no long sightline in it at all and no impostor can
  // appear there. It is the control: if this row moves, the machine moved.
  canopy: { x: -34, z: -46, yaw: 1.1, pitch: 0.85 },
  glade: { x: 706, z: 212, yaw: Math.PI, pitch: 0.04 },
  // And the two the band exists for.
  above: { x: 0, z: 0, yaw: 0.7, pitch: -0.18, lift: 55 },
  'above-flat': { x: 400, z: -96, yaw: -Math.PI / 2, pitch: -0.06, lift: 70 },
};

// `--only=wood,canopy` narrows the run. On a contended machine the spread per
// station is what limits resolution, so more rounds over fewer stations resolves
// more than the reverse.
if (args.only) {
  const keep = new Set(args.only.split(','));
  for (const k of Object.keys(STATIONS)) if (!keep.has(k)) delete STATIONS[k];
}

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.routeWebSocket(/.*/, () => {});
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.waitForFunction(() => window.RR.forest.impostorStats().ready, { timeout: 30000 });
await page.click('#enter');
await page.waitForTimeout(2500);

const ok = await page.evaluate(
  ({ w, h }) => {
    const R = window.RR;
    if (!R.renderer.getContext().getExtension('EXT_disjoint_timer_query_webgl2')) return false;
    // Preset pinned, so render scale, MSAA, shadow size and fog are constant
    // and the bands are the only thing that moves between the two arms.
    window.RRSettings.setMode('high');
    R.renderer.setPixelRatio(1);
    R.renderer.setSize(w, h, false);
    R.camera.aspect = w / h;
    R.camera.updateProjectionMatrix();
    R.pipeline.setSize(w, h, 1);
    R.pipeline.trailEnabled = false;
    R.director.ground();
    return true;
  },
  { w: WIDTH, h: HEIGHT }
);
if (!ok) {
  console.error('EXT_disjoint_timer_query_webgl2 unavailable — software GL context?');
  await browser.close();
  process.exit(1);
}

/** Seat, settle on wall time, and hold the pose. Done once per station. */
async function seat(at) {
  return page.evaluate(async (s) => {
    const R = window.RR;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    R.controller.position.x = s.x;
    R.controller.position.z = s.z;
    R.controller.position.y = -1e4;
    R.controller.velocity.set(0, 0, 0);
    R.controller.yaw = s.yaw;
    R.controller.pitch = s.pitch;
    R.controller.applyToCamera();
    let prev = null;
    let quiet = 0;
    for (let t = 0; t < 50 && quiet < 4; t++) {
      await sleep(400);
      const pending = (R.forest?.field?.pending ?? 0) + (R.forest?.groundField?.pending ?? 0);
      const info = R.renderer.info;
      info.autoReset = false;
      info.reset();
      R.atmosphere.follow(R.camera);
      R.forest.cull(R.camera, true);
      R.renderer.shadowMap.needsUpdate = true;
      R.pipeline.render(1 / 60);
      const now = `${info.render.calls}/${info.render.triangles}`;
      info.autoReset = true;
      quiet = prev === now && pending === 0 ? quiet + 1 : 0;
      prev = now;
    }
    R.director.ground();
    R.controller.position.x = s.x;
    R.controller.position.z = s.z;
    R.controller.yaw = s.yaw;
    R.controller.pitch = s.pitch;
    R.controller.applyToCamera();
    return quiet >= 4;
  }, at);
}

/**
 * One timed arm. The lift is re-applied INSIDE the evaluate every time, because
 * the page's own rAF loop runs between two `page.evaluate` calls and
 * `applyToCamera` puts the camera back on the body's head — the same trap
 * reach-visible.mjs documents.
 */
async function timeArm(at, arm) {
  return page.evaluate(
    async ({ s, a }) => {
      const R = window.RR;
      const gl = R.renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

      R.forest.setImpostors(a.imp);
      R.forest.setReach(a.lod, a.reach, {
        leafReach: a.leafReach,
        alwaysNear: a.alwaysNear,
        geometryReach: a.geo,
      });

      const frame = () => {
        R.atmosphere.follow(R.camera);
        R.forest.cull(R.camera);
        if (s.lift) {
          R.camera.position.y += s.lift;
          R.camera.updateMatrixWorld(true);
        }
        R.renderer.shadowMap.needsUpdate = true;
        R.pipeline.render(1 / 60);
      };

      for (let i = 0; i < 12; i++) frame();
      gl.finish();

      const N = 24;
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      for (let i = 0; i < N; i++) frame();
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      gl.flush();
      for (let t = 0; t < 40; t++) {
        await sleep(80);
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      }
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      gl.deleteQuery(q);

      const info = R.renderer.info;
      info.autoReset = false;
      info.reset();
      frame();
      const calls = info.render.calls;
      const tris = info.render.triangles;
      info.autoReset = true;
      return { ms: ns / 1e6 / N, calls, tris, disjoint: !!disjoint };
    },
    { s: at, a: arm }
  );
}

const ARMS = {
  A: { tag: 'shipped', imp: false, geo: RUNG.reach, ...RUNG },
  B: { tag: 'impostor', imp: true, geo: RUNG.leafReach, ...RUNG },
};

console.log(
  `rung ${args.rung ?? 'medium'} (${RUNG.lod}/${RUNG.reach} leaf ${RUNG.leafReach}), ` +
    `${WIDTH}x${HEIGHT}, preset pinned high, ${ROUNDS} A-B-B-A rounds\n`
);
/**
 * THE MEDIAN OF PER-ROUND PAIRED DELTAS, NOT THE DIFFERENCE OF TWO MEANS.
 *
 * This machine is shared — a second agent's Playwright run competing for the GPU
 * moved a station's absolute time by 40% between two runs of this script, and at
 * 1365x768 it produced a LARGER frame than the same station at 2560x1440, which
 * is not a thing that can happen. A difference of means over the whole session
 * inherits every one of those excursions. Pairing inside a round (A B B A, so the
 * two arms are 1-3 timer queries apart) and then taking the median across rounds
 * throws away the round that was contended instead of averaging it in.
 *
 * `canopy` is printed as the CONTROL and is not decoration. It is a view
 * straight up into the crown with no sightline in it, where the impostor band
 * has no instances and cannot draw — so its delta is this run's noise floor. A
 * row is only worth reading if the control is small compared to it.
 */
const median = (xs) => {
  const s = [...xs].sort((p, q) => p - q);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

console.log('station      shipped ms   impostor ms    delta   spread     tris shipped -> impostor');
for (const [name, at] of Object.entries(STATIONS)) {
  const settled = await seat(at);
  const deltas = [];
  const aAll = [];
  const bAll = [];
  let last = null;
  for (let r = 0; r < ROUNDS; r++) {
    // A B B A per round: any monotonic drift within the round cancels in the pair.
    const round = { A: [], B: [] };
    for (const key of ['A', 'B', 'B', 'A']) {
      const res = await timeArm(at, ARMS[key]);
      if (res.disjoint) continue;
      round[key].push(res.ms);
      last = { ...last, [key]: res };
    }
    if (!round.A.length || !round.B.length) continue;
    const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
    aAll.push(mean(round.A));
    bAll.push(mean(round.B));
    deltas.push(mean(round.B) - mean(round.A));
  }
  const d = median(deltas);
  const spread = Math.max(...deltas) - Math.min(...deltas);
  console.log(
    `${name.padEnd(12)} ${median(aAll).toFixed(3).padStart(8)}    ${median(bAll).toFixed(3).padStart(8)}   ` +
      `${((d >= 0 ? '+' : '') + d.toFixed(3)).padStart(7)}  ${spread.toFixed(3).padStart(6)}   ` +
      `${String(last?.A?.tris ?? 0).padStart(9)} -> ${String(last?.B?.tris ?? 0).padStart(9)}` +
      (settled ? '' : '   UNSETTLED') +
      (name === 'canopy' ? '   <- CONTROL: no impostor can draw here' : '')
  );
}
await browser.close();
