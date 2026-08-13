import { chromium } from 'playwright';

/**
 * WHAT THE SHADOW PASS COSTS, BROKEN DOWN.
 *
 *   node scripts/perf/shadowcost.mjs [--station=canopy] [--width=2560] [--height=1440]
 *
 * WHY. Timing the same station twice — once letting the shadow map stay cached
 * and once re-arming `needsUpdate` every frame — puts the shadow pass at ~4 ms
 * of a ~5 ms frame. That makes it, by a wide margin, the most expensive single
 * thing in this game, and every millisecond a look change wants to spend has to
 * come from somewhere. This prices the four levers that could give it back,
 * so the choice is made on numbers rather than on instinct.
 *
 *   map size      the SHIPPING size, halved and quartered — read off the live
 *                 page, never hardcoded; see the lever block for why
 *   box extent    the 116 m ortho volume, tightened
 *   leaf casters  alpha-tested cards are the expensive fragment in any depth
 *                 pass; this asks what the canopy specifically costs to cast
 *   trunk casters the control — 73% of the triangles, and expected to be cheap
 *
 * A-B-B-A PAIRING, AND WHY IT IS NOT OPTIONAL. Two census runs taken minutes
 * apart measure the machine's mood as much as the change; this project has
 * already been burned by exactly that, reporting 0.56 ms for something worth
 * 1.90. Every lever here is measured as base-lever-lever-base within one
 * session and reported as the mean of the two differences.
 *
 * PROVE THE LEVER MOVED. A lever that silently fails reports zero cost with a
 * tight interval, which is indistinguishable from a free feature — and nobody
 * investigates good news. Each lever reads its own state back off the live page
 * after setting it, and a row whose readback did not change is printed as
 * INERT rather than as a number.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const URL = args.url ?? 'http://127.0.0.1:5180/';
const WIDTH = Number(args.width ?? 2560);
const HEIGHT = Number(args.height ?? 1440);
const REPS = Number(args.reps ?? 2);

const STATIONS = {
  clearing: { x: 0, z: 8, yaw: 0, pitch: -0.03 },
  wood: { x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
  canopy: { x: -34, z: -46, yaw: 1.1, pitch: 0.85 },
  glade: { x: 706, z: 212, yaw: Math.PI, pitch: 0.04 },
};
const AT = STATIONS[args.station ?? 'wood'];

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
await page.click('#enter');
await page.waitForTimeout(2500);

await page.evaluate(
  async ({ w, h, at }) => {
    const R = window.RR;
    R.renderer.setPixelRatio(1);
    R.renderer.setSize(w, h, false);
    R.camera.aspect = w / h;
    R.camera.updateProjectionMatrix();
    R.pipeline.setSize(w, h, 1);
    R.pipeline.trailEnabled = false;
    R.director.ground();

    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const seat = () => {
      R.controller.position.x = at.x;
      R.controller.position.z = at.z;
      R.controller.position.y = -1e4;
      R.controller.velocity.set(0, 0, 0);
      R.controller.yaw = at.yaw;
      R.controller.pitch = at.pitch;
      R.controller.applyToCamera();
    };
    seat();
    // Let the streamer finish. The probe is NOT frozen: freezing it halts the
    // main loop, and with it the one-sector-per-frame streamer, which times a
    // half-built wood that looks perfectly settled.
    for (let i = 0; i < 400; i++) {
      await raf();
      const pending = (R.forest?.field?.pending ?? 0) + (R.forest?.groundField?.pending ?? 0);
      if (i > 120 && pending === 0) break;
    }
    R.director.ground();
    seat();
  },
  { w: WIDTH, h: HEIGHT, at: AT }
);

/** One timed batch. `arm` re-renders the shadow map every frame when true. */
async function time(arm) {
  return page.evaluate(async (armed) => {
    const R = window.RR;
    const gl = R.renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const frame = () => {
      if (armed) R.renderer.shadowMap.needsUpdate = true;
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
    const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
    gl.deleteQuery(q);
    return ns / 1e6 / N;
  }, arm);
}

/**
 * What this build actually renders its shadow map at, asked of the page rather
 * than assumed. See the block on the two map levers below for what assuming it
 * cost.
 */
const SHIPPING_MAP = await page.evaluate(() => window.RR.atmosphere.sun.shadow.mapSize.x);

/**
 * Levers. `set(on)` returns a STATE STRING read back off the live page — the
 * row is only believed if the string differs between on and off.
 */
const LEVERS = {
  /**
   * THE OFF ARM IS THE LIVE MAP SIZE, NOT A CONSTANT, and that is a bug fix.
   *
   * These two levers used to restore 4096 as their baseline and the header
   * above still called 4096 "(Ultra)". That stopped being true when Ultra
   * dropped to 2048 — `presets: [1024, 1024, 2048, 2048]` in core/quality.js —
   * and the script was never told. So it spent every run inflating the map to a
   * size nothing ships, measuring the 2.78 ms that decision ALREADY GAVE BACK,
   * and reporting it as an available saving. The shadow pass looked like 2.50 ms
   * of head-room that had in fact been banked months ago.
   *
   * Reading `mapSize` off the page makes the baseline whatever the build
   * actually runs, so the row can never drift from the presets again — and the
   * label is built from it for the same reason.
   */
  [`map ${SHIPPING_MAP} → ${SHIPPING_MAP / 2}`]: `(on) => {
    const R = window.RR, s = R.atmosphere.sun.shadow;
    const n = on ? ${SHIPPING_MAP / 2} : ${SHIPPING_MAP};
    s.mapSize.set(n, n);
    if (s.map) { s.map.dispose(); s.map = null; }
    R.renderer.shadowMap.needsUpdate = true;
    return String(s.mapSize.x);
  }`,
  [`map ${SHIPPING_MAP} → ${SHIPPING_MAP / 4}`]: `(on) => {
    const R = window.RR, s = R.atmosphere.sun.shadow;
    const n = on ? ${SHIPPING_MAP / 4} : ${SHIPPING_MAP};
    s.mapSize.set(n, n);
    if (s.map) { s.map.dispose(); s.map = null; }
    R.renderer.shadowMap.needsUpdate = true;
    return String(s.mapSize.x);
  }`,
  'box 58 → 38': `(on) => {
    const R = window.RR, c = R.atmosphere.sun.shadow.camera;
    const s = on ? 38 : 58;
    c.left = -s; c.right = s; c.top = s; c.bottom = -s;
    c.updateProjectionMatrix();
    R.renderer.shadowMap.needsUpdate = true;
    return String(c.right);
  }`,
  'leaves stop casting': `(on) => {
    const R = window.RR; let n = 0;
    R.scene.traverse((o) => {
      if (o.isInstancedMesh && /leaf/.test(o.name || '')) { o.castShadow = !on; n++; }
    });
    R.renderer.shadowMap.needsUpdate = true;
    return n + ':' + String(!on);
  }`,
  'trunks stop casting': `(on) => {
    const R = window.RR; let n = 0;
    R.scene.traverse((o) => {
      if (o.isInstancedMesh && /trunk/.test(o.name || '')) { o.castShadow = !on; n++; }
    });
    R.renderer.shadowMap.needsUpdate = true;
    return n + ':' + String(!on);
  }`,
  'undergrowth stops casting': `(on) => {
    const R = window.RR; let n = 0;
    R.scene.traverse((o) => {
      if (o.isInstancedMesh && /grass|fern|bramble|meadow|bush|sapling|reed/.test(o.name || '')) {
        o.castShadow = !on; n++;
      }
    });
    R.renderer.shadowMap.needsUpdate = true;
    return n + ':' + String(!on);
  }`,
};

const set = (src, on) => page.evaluate(`(${src})(${on})`);

console.log(`Shadow-pass levers at station "${args.station ?? 'wood'}", ${WIDTH}×${HEIGHT}\n`);

// The frame with and without the shadow pass at all — the size of the prize.
const armed = await time(true);
const cached = await time(false);
console.log(`shadow map re-armed every frame   ${armed.toFixed(2)} ms`);
console.log(`shadow map cached (standing)      ${cached.toFixed(2)} ms`);
console.log(`=> the shadow pass itself         ${(armed - cached).toFixed(2)} ms\n`);

console.log('lever                        saves    remaining   note');
for (const [name, src] of Object.entries(LEVERS)) {
  const offState = await set(src, false);
  const deltas = [];
  // Capture the ON readback ONCE, before the timing loop, and never let the
  // loop's trailing `set(src, false)` overwrite it — doing exactly that made
  // every row read INERT on the first run of this script, because the state
  // compared against `offState` was itself an off-state.
  const onState = await set(src, true);
  await set(src, false);
  for (let r = 0; r < REPS; r++) {
    // A-B-B-A within the rep pair: base, lever, lever, base.
    await set(src, false);
    const a1 = await time(true);
    await set(src, true);
    const b1 = await time(true);
    const b2 = await time(true);
    await set(src, false);
    const a2 = await time(true);
    deltas.push((a1 + a2) / 2 - (b1 + b2) / 2);
  }
  await set(src, false);
  const saved = deltas.reduce((s, d) => s + d, 0) / deltas.length;
  const spread = Math.max(...deltas) - Math.min(...deltas);
  const inert = onState === offState;
  console.log(
    `${name.padEnd(28)} ${inert ? '  INERT' : (saved >= 0 ? '+' : '') + saved.toFixed(2) + ' ms'}` +
      `   ${inert ? '' : (armed - saved).toFixed(2) + ' ms'}` +
      `   ${inert ? `readback did not move (${offState}) — NOT MEASURED` : `±${spread.toFixed(2)} across ${REPS} reps`}`
  );
}

await browser.close();
