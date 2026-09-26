import { boot, argv, DEV_URL } from './harness.mjs';

/**
 * WHAT IT WOULD COST TO PUT ULTRA UNDER 4.166 ms — priced before anything is cut.
 *
 *   node scripts/perf/ultracut.mjs
 *   node scripts/perf/ultracut.mjs --stations=deep --arms=leaf200,map1024
 *
 * WHY THIS EXISTS AND WHY IT IS NOT `presets.mjs`. The ladder measures rungs
 * that already exist. This measures rungs that do not: it pins the preset at
 * `ultra`, engages the same 2560x1440 / ratio 1 / MSAA 2 rig, and then moves
 * ONE knob at a time that no preset currently moves — the canopy's own reach,
 * the shadow map's edge, the caster set — so the decision about what Ultra has
 * to lose is made on a number rather than on instinct.
 *
 * THE METRIC IS THE ARMED FRAME, NOT THE CACHED ONE, and that is the whole
 * point. `presets.mjs` reports `gpu` with the shadow map cached, which is what
 * a player STANDING STILL pays. A 240 Hz display drops a frame if any single
 * frame misses 4.166 ms, and the frame in which the sun's anchor steps pays
 * `scene + post + shadow`. So every row here is timed with
 * `shadowMap.needsUpdate = true` set every frame, and `armed` is the number the
 * requirement is about. `cached` is carried beside it only to show where a
 * saving landed.
 *
 * A-B-B-A, FOR THE REASON `shadowcost.mjs` GIVES. Two arms measured minutes
 * apart measure the GPU's clock and temperature as much as the change; the
 * baseline ladder in this repo drifts 0.3 ms across one six-minute run. Each
 * arm is timed base-lever-lever-base inside one block and reported as the mean
 * of the two differences.
 *
 * AND EVERY ARM PROVES IT MOVED. A lever that silently fails reports zero cost,
 * which is indistinguishable from a free feature, and nobody investigates good
 * news. `set(on)` returns a state string read back off the live page; a row
 * whose readback does not change prints INERT instead of a number.
 */

const args = argv({
  url: DEV_URL,
  stations: 'deep,clearing,canopy',
  level: 'ultra',
  reps: '2',
  batch: '20',
  arms: 'all',
});

const STATIONS = args.stations.split(',').filter(Boolean);
const REPS = Number(args.reps);
const BATCH = Number(args.batch);
const WANT = args.arms === 'all' ? null : new Set(args.arms.split(',').filter(Boolean));

/* -------------------------------------------------------------------------- */
/* the arms                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Each entry is a source string for `(on) => stateString`.
 *
 * They are strings rather than functions because they are evaluated in the
 * page, and they return a readback rather than nothing for the INERT test above.
 */
const ARMS = {
  /* ---- the canopy's own reach ------------------------------------------- */
  /**
   * Ultra's REACH_TABLE row is `{ lod: 170, leafReach: 384 }` — the only row on
   * the ladder where the canopy reaches as far as the trunks do, which also
   * makes the impostor band `(384, 384]` and therefore empty. So Ultra is the
   * one rung that draws full canopy geometry to the edge of the world and has
   * no silhouette band at all. These arms ask what the other three rungs'
   * asymmetry would be worth up here.
   */
  leaf250: `(on) => { const R = window.RR;
    R.forest.setReach(170, 384, { leafReach: on ? 250 : 384, alwaysNear: 82 });
    R.renderer.shadowMap.needsUpdate = true;
    return String(on ? 250 : 384); }`,
  leaf200: `(on) => { const R = window.RR;
    R.forest.setReach(170, 384, { leafReach: on ? 200 : 384, alwaysNear: 82 });
    R.renderer.shadowMap.needsUpdate = true;
    return String(on ? 200 : 384); }`,
  leaf150: `(on) => { const R = window.RR;
    R.forest.setReach(170, 384, { leafReach: on ? 150 : 384, alwaysNear: 82 });
    R.renderer.shadowMap.needsUpdate = true;
    return String(on ? 150 : 384); }`,
  leaf110: `(on) => { const R = window.RR;
    R.forest.setReach(170, 384, { leafReach: on ? 110 : 384, alwaysNear: 82 });
    R.renderer.shadowMap.needsUpdate = true;
    return String(on ? 110 : 384); }`,
  /** The medium row entire — lod as well as leafReach. */
  reach250: `(on) => { const R = window.RR;
    if (on) R.forest.setReach(120, 250, { leafReach: 150, alwaysNear: 82 });
    else R.forest.setReach(170, 384, { leafReach: 384, alwaysNear: 82 });
    R.renderer.shadowMap.needsUpdate = true;
    return String(on ? 250 : 384); }`,

  /* ---- the shadow map's edge -------------------------------------------- */
  map1536: `(on) => { const R = window.RR, s = R.atmosphere.sun.shadow;
    const n = on ? 1536 : 2048; s.mapSize.set(n, n);
    if (s.map) { s.map.dispose(); s.map = null; }
    R.renderer.shadowMap.needsUpdate = true; return String(s.mapSize.x); }`,
  map1024: `(on) => { const R = window.RR, s = R.atmosphere.sun.shadow;
    const n = on ? 1024 : 2048; s.mapSize.set(n, n);
    if (s.map) { s.map.dispose(); s.map = null; }
    R.renderer.shadowMap.needsUpdate = true; return String(s.mapSize.x); }`,

  /* ---- the caster set ---------------------------------------------------- */
  /**
   * The ceiling on any caster-side change: what the shadow pass would cost if
   * the canopy stopped casting entirely. Nothing will ship this — it deletes
   * the dapple, which is what the wood is made of — but every partial version
   * of it is bounded above by this row.
   */
  /**
   * `window.__CUT__.cast` TOGGLES ONLY MESHES THAT ALREADY CAST, and restores
   * each one to the value it had at engage time rather than to `true`.
   *
   * `mesh.name` is the LAYER KIND, not the layer id — `addStreamed(id, name,
   * ...)` — so `trunk` and `trunk-far` are both named `trunk` and only the first
   * of them casts. A naive `o.castShadow = !on` restore therefore switches the
   * far trunk sweep ON, silently adding 200-384 m of casters to every arm that
   * ran after it. That is exactly the kind of instrument bug this repo keeps
   * finding after the fact, so the snapshot is taken once and never recomputed.
   */
  noLeafCast: `(on) => window.__CUT__.cast('leaf', on)`,
  noUnderCast: `(on) => window.__CUT__.cast('bushes|saplings|stumps|rocks|logs', on)`,
  noTrunkCast: `(on) => window.__CUT__.cast('trunk', on)`,
  /**
   * The near/far caster split, priced without building it — `shadowcost.mjs`
   * has the same arm and the same caveat. Box and map move TOGETHER so metres
   * per texel is held fixed (30/58 of the edge against 1024/2048 of the map is
   * 58.6 mm against the shipping 56.6, so this row is 3.5% pessimistic). What
   * comes out is the pass with 27% of today's casting area at today's
   * sharpness, which is what a 30 m caster band would buy. It is a PRICE, not a
   * patch: shipping this arm halves the near dapple's resolution.
   */
  casters30: `(on) => { const R = window.RR, sh = R.atmosphere.sun.shadow, c = sh.camera;
    const s = on ? 30 : 58, n = on ? 1024 : 2048;
    c.left = -s; c.right = s; c.top = s; c.bottom = -s; c.updateProjectionMatrix();
    sh.mapSize.set(n, n); if (sh.map) { sh.map.dispose(); sh.map = null; }
    R.renderer.shadowMap.needsUpdate = true; return c.right + ':' + sh.mapSize.x; }`,

  /* ---- the understorey --------------------------------------------------- */
  dens75: `(on) => { const R = window.RR; R.forest.culler.setDensity(on ? 0.75 : 1);
    R.renderer.shadowMap.needsUpdate = true; return String(on ? 0.75 : 1); }`,
  dens60: `(on) => { const R = window.RR; R.forest.culler.setDensity(on ? 0.6 : 1);
    R.renderer.shadowMap.needsUpdate = true; return String(on ? 0.6 : 1); }`,

  /* ---- the packages that could actually ship ----------------------------- */
  /**
   * The candidates, each one a whole shipping configuration rather than a lever.
   * Measured as units because the levers are not additive: `reach250` removes
   * canopy geometry that the shadow arms would otherwise have been rasterising
   * too, so summing two rows over-counts the overlap.
   */
  pkgReach: `(on) => { const R = window.RR;
    if (on) R.forest.setReach(120, 250, { leafReach: 150, alwaysNear: 82 });
    else R.forest.setReach(170, 384, { leafReach: 384, alwaysNear: 82 });
    R.renderer.shadowMap.needsUpdate = true; return String(on ? 'r250' : 'r384'); }`,
  pkgReachMap1536: `(on) => { const R = window.RR, s = R.atmosphere.sun.shadow;
    if (on) R.forest.setReach(120, 250, { leafReach: 150, alwaysNear: 82 });
    else R.forest.setReach(170, 384, { leafReach: 384, alwaysNear: 82 });
    const n = on ? 1536 : 2048; s.mapSize.set(n, n);
    if (s.map) { s.map.dispose(); s.map = null; }
    R.renderer.shadowMap.needsUpdate = true; return (on ? 'r250' : 'r384') + ':' + s.mapSize.x; }`,
  pkgLeaf150Map1536: `(on) => { const R = window.RR, s = R.atmosphere.sun.shadow;
    R.forest.setReach(170, 384, { leafReach: on ? 150 : 384, alwaysNear: 82 });
    const n = on ? 1536 : 2048; s.mapSize.set(n, n);
    if (s.map) { s.map.dispose(); s.map = null; }
    R.renderer.shadowMap.needsUpdate = true; return (on ? 150 : 384) + ':' + s.mapSize.x; }`,
  pkgLeaf150Map1024: `(on) => { const R = window.RR, s = R.atmosphere.sun.shadow;
    R.forest.setReach(170, 384, { leafReach: on ? 150 : 384, alwaysNear: 82 });
    const n = on ? 1024 : 2048; s.mapSize.set(n, n);
    if (s.map) { s.map.dispose(); s.map = null; }
    R.renderer.shadowMap.needsUpdate = true; return (on ? 150 : 384) + ':' + s.mapSize.x; }`,
  pkgReachMap1024: `(on) => { const R = window.RR, s = R.atmosphere.sun.shadow;
    if (on) R.forest.setReach(120, 250, { leafReach: 150, alwaysNear: 82 });
    else R.forest.setReach(170, 384, { leafReach: 384, alwaysNear: 82 });
    const n = on ? 1024 : 2048; s.mapSize.set(n, n);
    if (s.map) { s.map.dispose(); s.map = null; }
    R.renderer.shadowMap.needsUpdate = true; return (on ? 'r250' : 'r384') + ':' + s.mapSize.x; }`,

  /**
   * THE FOUR SHIPPING CANDIDATES, after `shadow-visible.mjs` re-framed the
   * shadow half of the problem.
   *
   * That instrument's finding is the reason these look the way they do: the
   * shadow pass costs `ρ·N²` and the BOX CANCELS, so once the map edge is
   * chosen the box is free — and moving both together buys back the dapple
   * sharpness that halving the map alone throws away. Measured against the
   * shipping 2048/58 over four ground stations, mean Δ out of 255:
   *
   *     1024 / box 58   0.22    half as sharp everywhere, 58 m of range
   *     1024 / box 40   0.14    1.38x coarser, 40 m of range   <- chosen
   *     1024 / box 29   0.09    today's sharpness, 29 m of range
   *     1536 / box 44   0.11
   *
   * `box 29` has the lowest mean and the WORST single station (0.58% of the
   * stream frame moved by more than 24/255, against 0.12% for box 40), because
   * what it does is delete whole shadows rather than resample them. 40 is the
   * row that is never the worst on either metric.
   *
   * `alwaysNear` moves with the box, because it is `box + ANCHOR_HOLD + canopy
   * lean` and nothing else — see the block on it in main.js.
   */
  shadowOnly: `(on) => { const R = window.RR;
    R.forest.setReach(170, 384, { leafReach: 384, alwaysNear: on ? 61 : 82 });
    return 'S' + window.__CUT__.shadow(on ? 1024 : 2048, on ? 40 : 58); }`,
  candA: `(on) => { const R = window.RR;
    R.forest.setReach(170, 384, { leafReach: on ? 170 : 384, alwaysNear: on ? 61 : 82 });
    return 'A' + window.__CUT__.shadow(on ? 1024 : 2048, on ? 40 : 58); }`,
  candB: `(on) => { const R = window.RR;
    if (on) R.forest.setReach(120, 384, { leafReach: 150, alwaysNear: 61 });
    else R.forest.setReach(170, 384, { leafReach: 384, alwaysNear: 82 });
    return 'B' + window.__CUT__.shadow(on ? 1024 : 2048, on ? 40 : 58); }`,
  candC: `(on) => { const R = window.RR;
    R.forest.setReach(170, 384, { leafReach: on ? 170 : 384, alwaysNear: on ? 65 : 82 });
    return 'C' + window.__CUT__.shadow(on ? 1536 : 2048, on ? 44 : 58); }`,
  /** Reach only, at the shipping shadow — how much of a candidate is the wood. */
  reachOnly170: `(on) => { const R = window.RR;
    R.forest.setReach(170, 384, { leafReach: on ? 170 : 384, alwaysNear: on ? 61 : 82 });
    return String(on ? 170 : 384); }`,
  reachOnly120: `(on) => { const R = window.RR;
    if (on) R.forest.setReach(120, 384, { leafReach: 150, alwaysNear: 61 });
    else R.forest.setReach(170, 384, { leafReach: 384, alwaysNear: 82 });
    return String(on ? 120 : 384); }`,

  /**
   * WHAT A NEAR-ONLY CASTER BAND WOULD BE WORTH, priced before it is built.
   *
   * The shadow pass did NOT fall to a quarter when the map did — 1.82 -> 1.08 at
   * `deep`, which is 0.56x against the 0.25x the texel counts predict. The
   * residue is a FLOOR: a second scene traversal, a render-list build and ~110
   * draw calls, none of which the map's edge can touch. Most of those draws are
   * vertex-processing instances that will be clipped, because three culls the
   * shadow pass per MESH and a streamed slab's sphere covers the whole ring —
   * so every leaf instance the CAMERA culler kept, out to `leafReach`, is
   * transformed into a 40 m box and thrown away.
   *
   * `leafCast46` sets the canopy's band to the shadow box plus the anchor trail
   * and reads the `shadow` column, which is the only column that means anything
   * here: the scene half of this arm is nonsense (it deletes the wood past
   * 46 m), and the point is what the depth pass costs when it is handed only
   * the casters that can reach the box. The real change is a `mirrorOf` split of
   * the leaf layer, on the shape `trunk`/`trunk-far` already uses — one payload,
   * two complementary bands, the near one casting and the far one not.
   */
  leafCast46: `(on) => { const R = window.RR;
    R.forest.setReach(170, 384, { leafReach: on ? 46 : 170, alwaysNear: 61 });
    R.renderer.shadowMap.needsUpdate = true; return String(on ? 46 : 170); }`,
  /**
   * The band a shipped caster split would use: `alwaysNear`, which is already
   * `shadow box + anchor trail + canopy lean` and is therefore already the
   * radius outside which forest.js is willing to let a tree be culled. Reading
   * the SHADOW column of this arm — not the armed one, whose scene half is
   * nonsense — is what says whether building the split is worth fifteen draw
   * calls.
   */
  leafCast61: `(on) => { const R = window.RR;
    R.forest.setReach(170, 384, { leafReach: on ? 61 : 170, alwaysNear: 61 });
    R.renderer.shadowMap.needsUpdate = true; return String(on ? 61 : 170); }`,
  leaf130: `(on) => { const R = window.RR;
    R.forest.setReach(170, 384, { leafReach: on ? 130 : 170, alwaysNear: 61 });
    R.renderer.shadowMap.needsUpdate = true; return String(on ? 130 : 170); }`,
  lod120: `(on) => { const R = window.RR;
    if (on) R.forest.setReach(120, 384, { leafReach: 150, alwaysNear: 61 });
    else R.forest.setReach(170, 384, { leafReach: 170, alwaysNear: 61 });
    R.renderer.shadowMap.needsUpdate = true; return String(on ? 120 : 170); }`,
  scale95: `(on) => { const R = window.RR; const s = on ? 0.95 : 1;
    R.renderer.setPixelRatio(s); R.renderer.setSize(2560, 1440, false);
    R.pipeline.setSize(2560, 1440, s); R.pipeline.pinScale(1);
    return String(R.renderer.domElement.width); }`,

  /* ---- the pixels -------------------------------------------------------- */
  /**
   * The control arms. MSAA is known to be worth ~20% and is known to be ugly
   * off; it is here so every other row can be read against something whose size
   * is already agreed.
   */
  msaa0: `(on) => { const R = window.RR; R.pipeline.setSamples(on ? 0 : 2);
    R.renderer.shadowMap.needsUpdate = true; return String(R.pipeline.sceneTarget.samples); }`,
};

/* -------------------------------------------------------------------------- */

const { browser, page, caps } = await boot({ url: args.url });
if (caps.hidden) console.log('WARNING: page reports itself hidden — numbers are relative only.\n');

await page.evaluate(async (level) => {
  const R = window.RR;
  const P = window.__RR_PERF__;
  const Q = window.RRSettings;
  const { renderer, camera, scene, pipeline, atmosphere, controller, forest } = R;
  const W = 2560, H = 1440;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

  P.engage();
  Q.setMode(level);
  const scale = Q.get('renderScale');
  renderer.setPixelRatio(scale);
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  pipeline.setSize(W, H, scale);
  pipeline.setDynamicResolution(false, { measure: false });
  pipeline.pinScale(1);
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  R.fauna?.setPixelRatio?.(scale);
  R.caves?.setPixelRatio?.(scale);
  R.gathering?.setPixelRatio?.(scale);
  if (atmosphere.motes?.material?.uniforms?.uPixelRatio) {
    atmosphere.motes.material.uniforms.uPixelRatio.value = scale;
  }

  /** Every mesh that casts a shadow in the shipping build, and whether it did. */
  const casters = [];
  scene.traverse((o) => { if (o.isInstancedMesh && o.castShadow) casters.push([o, o.castShadow]); });

  const frame = (armed) => {
    atmosphere.follow(camera, controller.position);
    forest.cull(camera);
    if (armed) renderer.shadowMap.needsUpdate = true;
    pipeline.render(1 / 60);
  };
  // Pay for the ~22 programs `setMode` just invalidated, here rather than
  // inside a timed block.
  for (let i = 0; i < 90; i++) { frame(false); if (i % 15 === 14) await nextFrame(); }
  renderer.getContext().finish();

  window.__CUT__ = {
    /**
     * `level: 'sober'` is the TRIP level, not the quality preset — `scenario`
     * takes the director's state and `probe.js` throws `unknown level: ultra`
     * if you hand it the preset name, which is how this was first written.
     */
    async arrive(station) {
      const r = await P.scenario({ station, level: 'sober' }, { reps: 0, batch: 8 });
      return { settle: r.settle };
    },
    async batchMs(armed, n) {
      const c = renderer.getContext();
      const ext = c.getExtension('EXT_disjoint_timer_query_webgl2');
      c.getParameter(ext.GPU_DISJOINT_EXT);
      const q = c.createQuery();
      c.beginQuery(ext.TIME_ELAPSED_EXT, q);
      for (let i = 0; i < n; i++) frame(armed);
      c.endQuery(ext.TIME_ELAPSED_EXT);
      c.flush();
      for (let t = 0; t < 60; t++) {
        await sleep(50);
        if (c.getQueryParameter(q, c.QUERY_RESULT_AVAILABLE)) break;
      }
      const ok = c.getQueryParameter(q, c.QUERY_RESULT_AVAILABLE);
      const disjoint = c.getParameter(ext.GPU_DISJOINT_EXT);
      const ns = ok ? c.getQueryParameter(q, c.QUERY_RESULT) : 0;
      c.deleteQuery(q);
      return !ok || disjoint ? NaN : ns / 1e6 / n;
    },
    warm(n) { for (let i = 0; i < n; i++) frame(false); renderer.getContext().finish(); },
    /**
     * ARMED AND CACHED IN ONE ROUND TRIP, WHICH IS THE ONLY WAY THE SHADOW PASS
     * IS MEASURABLE AT ALL.
     *
     * `armed - cached` is a difference of two numbers each of which moves by
     * more than the difference does. Taken as two `batchMs` calls it carries a
     * 50 ms poll and a page round trip between them, and this instrument's first
     * shadow column was pure drift: it reported 0.46 ms at `deep` in the same
     * session that its own per-arm samples read 0.91 to 1.44, and `presets.mjs`
     * said 1.09. Two queries begun and ended back to back inside one evaluate,
     * polled only afterwards, see the same clock.
     *
     * WebGL2 allows one TIME_ELAPSED query in flight, so they are SEQUENTIAL —
     * begin, end, begin, end, then poll both. That is still a single unbroken
     * run of frames on the GPU.
     */
    async pairMs(n) {
      const c = renderer.getContext();
      const ext = c.getExtension('EXT_disjoint_timer_query_webgl2');
      c.getParameter(ext.GPU_DISJOINT_EXT);
      for (let i = 0; i < 8; i++) frame(true);
      const qa = c.createQuery();
      c.beginQuery(ext.TIME_ELAPSED_EXT, qa);
      for (let i = 0; i < n; i++) frame(true);
      c.endQuery(ext.TIME_ELAPSED_EXT);
      const qc = c.createQuery();
      c.beginQuery(ext.TIME_ELAPSED_EXT, qc);
      for (let i = 0; i < n; i++) frame(false);
      c.endQuery(ext.TIME_ELAPSED_EXT);
      c.flush();
      for (let t = 0; t < 60; t++) {
        await sleep(40);
        if (c.getQueryParameter(qc, c.QUERY_RESULT_AVAILABLE)) break;
      }
      const ok = c.getQueryParameter(qa, c.QUERY_RESULT_AVAILABLE)
        && c.getQueryParameter(qc, c.QUERY_RESULT_AVAILABLE);
      const disjoint = c.getParameter(ext.GPU_DISJOINT_EXT);
      const av = ok ? c.getQueryParameter(qa, c.QUERY_RESULT) : 0;
      const cv = ok ? c.getQueryParameter(qc, c.QUERY_RESULT) : 0;
      c.deleteQuery(qa); c.deleteQuery(qc);
      if (!ok || disjoint) return { armed: NaN, cached: NaN };
      return { armed: av / 1e6 / n, cached: cv / 1e6 / n };
    },
    /**
     * Map edge and box half-extent together, plus the `alwaysNear` that follows
     * the box. Disposing the map is what makes a size change take — `mapSize`
     * on its own is inert after the depth texture is allocated, which is the
     * failure mode that reads as "the lever is free".
     */
    shadow(map, box) {
      const sh = atmosphere.sun.shadow;
      sh.mapSize.set(map, map);
      sh.camera.left = -box; sh.camera.right = box;
      sh.camera.top = box; sh.camera.bottom = -box;
      sh.camera.updateProjectionMatrix();
      if (sh.map) { sh.map.dispose(); sh.map = null; }
      renderer.shadowMap.needsUpdate = true;
      return ':' + map + ':' + box;
    },
    cast(pattern, off) {
      const re = new RegExp('^(' + pattern + ')$');
      let n = 0;
      for (const [o, was] of casters) {
        if (!re.test(o.name || '')) continue;
        o.castShadow = off ? false : was;
        n++;
      }
      renderer.shadowMap.needsUpdate = true;
      return n + ':' + String(!off);
    },
    counters() {
      const info = renderer.info;
      info.autoReset = false; info.reset();
      frame(true);
      const c = { calls: info.render.calls, triangles: info.render.triangles };
      info.autoReset = true;
      return c;
    },
  };
}, args.level);

const set = (src, on) => page.evaluate(`(${src})(${on})`);
const time = (armed) => page.evaluate(({ a, n }) => window.__CUT__.batchMs(a, n), { a: armed, n: BATCH });
const pair = () => page.evaluate((n) => window.__CUT__.pairMs(n), BATCH);

const names = Object.keys(ARMS).filter((k) => !WANT || WANT.has(k));

console.log(
  `ultracut: preset ${args.level}, rig 2560x1440 ratio=renderScale, ${BATCH}-frame batches, ${REPS} reps\n` +
    `metric  ARMED = scene + post + shadow, the frame the sun's anchor step lands on.\n` +
    `budget  4.166 ms = 240 fps.\n`
);

for (const station of STATIONS) {
  await page.evaluate((s) => window.__CUT__.arrive(s), station);
  await page.evaluate(() => window.__CUT__.warm(30));

  const armed0 = await time(true);
  const cached0 = await time(false);
  /**
   * The counters are here as a CROSS-CHECK against `presets.mjs`, not as a
   * result. If the draw and triangle counts match that instrument's ladder row
   * and the milliseconds do not, the difference is the rig or the machine's
   * mood, not the world — which is the first thing to establish before believing
   * any absolute number here. Both passes are counted (`autoReset = false`), so
   * these include the shadow render's draws.
   */
  const c0 = await page.evaluate(() => window.__CUT__.counters());
  console.log(`── ${station} ────────────────────────────────`);
  console.log(
    `   baseline   armed ${armed0.toFixed(2)}   cached ${cached0.toFixed(2)}   shadow ${(armed0 - cached0).toFixed(2)}` +
      `   [both passes: ${c0.calls} draws, ${(c0.triangles / 1e6).toFixed(2)}M tris]`
  );
  console.log(`   arm                saves    armed    fits?  shadow      note`);

  for (const name of names) {
    const src = ARMS[name];
    const offState = await set(src, false);
    const onState = await set(src, true);
    await set(src, false);
    const deltas = [];
    /**
     * THE CACHED FRAME IS TIMED IN THE SAME BLOCK, not in a second pass, and
     * that is what makes the `shadow` column below readable at all.
     *
     * The shadow pass is `armed - cached`, a difference of two numbers each of
     * which drifts by more than the difference does. Measured minutes apart the
     * subtraction is dominated by the drift — the first run of this instrument
     * reported a 1.08 ms shadow pass at `deep` where `presets.mjs` says 1.82,
     * purely because the armed sample and the cached sample were taken at
     * different points on the GPU's clock ramp. Interleaved inside the A-B-B-A
     * they see the same machine.
     */
    const shadows = [];
    for (let r = 0; r < REPS; r++) {
      await set(src, false);
      const p1 = await pair();
      await set(src, true);
      const p2 = await pair();
      const b2 = await time(true);
      await set(src, false);
      const a2 = await time(true);
      deltas.push((p1.armed + a2) / 2 - (p2.armed + b2) / 2);
      shadows.push([p1.armed - p1.cached, p2.armed - p2.cached]);
    }
    // Leave the page exactly as this arm found it. `setReach` arms restore the
    // ultra row, so an arm that ran earlier cannot bias the one that runs next.
    await set(src, false);
    const saved = deltas.reduce((s, d) => s + d, 0) / deltas.length;
    const spread = Math.max(...deltas) - Math.min(...deltas);
    const after = armed0 - saved;
    const inert = onState === offState;
    const shBase = shadows.reduce((s, p) => s + p[0], 0) / shadows.length;
    const shArm = shadows.reduce((s, p) => s + p[1], 0) / shadows.length;
    console.log(
      `   ${name.padEnd(16)} ${inert ? '   INERT' : ((saved >= 0 ? '+' : '') + saved.toFixed(2)).padStart(8)}` +
        `${inert ? '        ' : after.toFixed(2).padStart(9)}` +
        `   ${inert ? '  —  ' : after <= 4.166 ? ' YES ' : ' no  '}` +
        `  ${shBase.toFixed(2)}->${shArm.toFixed(2)}` +
        `   ${inert ? `readback stuck at ${offState} — NOT MEASURED` : `±${spread.toFixed(2)} over ${REPS} reps`}`
    );
  }
  console.log('');
}

await browser.close();
