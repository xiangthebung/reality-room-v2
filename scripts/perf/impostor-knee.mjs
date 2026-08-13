/**
 * WHERE IS THE KNEE OF `impostorReach`?
 *
 *   node scripts/perf/impostor-knee.mjs [--rounds=6] [--rungs=potato,low]
 *
 * The impostor band ships at (leafReach, 384] on every rung, and that is not
 * obviously right at the bottom of the ladder. At `potato` it is (90, 384] —
 * nearly three hundred metres of quads, and from inside the wood almost all of
 * them are behind trees, while `reach-visible.mjs` puts the picture difference
 * down there at 0.02-0.04% of the pixels. Potato exists for people on weak
 * machines standing in the wood; a fifth of their frame spent on something they
 * cannot see from where they stand would be the wrong trade.
 *
 * THE ANSWER TURNED OUT TO BE "NO CUT", and the first thing this script found
 * was that the premise was half wrong. `impostor-cost.mjs` had priced the band
 * at +0.563 ms at the wood station and +0.505 at the ridge; with a noise CONTROL
 * in the table the ridge figure is 0.00 and always was — those runs were taken
 * while another process was driving the same GPU, and their control moved by
 * 0.19-0.42 ms. The honest cost is one station. See the IMPOSTOR_REACH block in
 * forest.js for the table this produced and the decision it supports.
 *
 * So this asks both halves of the question about the same values of
 * `impostorReach`, in one page session, so the answer is a curve rather than
 * two unrelated tables:
 *
 *   TREELINE  the pixel difference against a FULL-REACH frame at the two
 *             above-canopy stations. This is what the band is worth. Method,
 *             freezes and reference are reach-visible.mjs's, so the numbers
 *             drop straight into its table.
 *   COST      GPU milliseconds at the two eye-level stations with a long
 *             sightline, interleaved A-B-B-...-A within a round and reduced by
 *             the median of the per-round paired deltas. `canopy` is carried as
 *             the noise CONTROL: it is a view straight up into the crown where
 *             the band has no instances and cannot draw, so its delta is this
 *             run's noise floor and a row is only readable if the control is
 *             small beside it.
 *
 * The two phases run at different resolutions on purpose. The treeline phase
 * uses the page's own 1280x720 so its numbers are comparable with
 * reach-visible; the cost phase uses each rung's real INTERNAL resolution —
 * potato renders at 0.45 of the frame and low at 0.65, and a fill cost measured
 * at the wrong resolution is the wrong number.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const ROUNDS = Number(args.rounds ?? 6);
// `--shots` writes one PNG per arm at the above-canopy stations. A percentage is
// not a picture and this decision is about whether there is still a treeline.
const SHOTS = !!args.shots;
/**
 * How many frames one timer query spans.
 *
 * A query per frame prices the driver queue as much as the work, which is why
 * every timing script here spans a batch. The batch length also decides how well
 * a contended machine averages out: this repo's measurements are being taken on
 * a box that other agents are also driving Chromium on, and a run whose CONTROL
 * station moves by 0.1 ms is a run whose rows cannot be read. 48 frames is about
 * a tenth of a second of GPU per sample.
 */
const FRAMES = Number(args.frames ?? 48);

/**
 * The rungs worth asking about, with the internal resolution each one actually
 * renders at on a 2560x1440 panel. `high` and `ultra` are absent because their
 * band is empty by construction — `leafReach` is 384 there and so is the
 * impostor reach, so there is no sweep to run.
 */
const RUNGS = {
  potato: { lod: 60, reach: 120, leafReach: 90, alwaysNear: 0, w: 1152, h: 648 },
  low: { lod: 90, reach: 180, leafReach: 110, alwaysNear: 0, w: 1664, h: 936 },
};
const WANT = (args.rungs ?? 'potato,low').split(',');
/**
 * TWO EDGES, AND THE FIRST SWEEP PROVED IT IS THE WRONG ONE THAT IS USUALLY
 * ASKED ABOUT.
 *
 * `--sweep` moves the band's OUTER edge, which is the obvious knob: fewer
 * metres of band, fewer quads. Measured at potato with a clean control, 16
 * rounds: 5426 quads costs +0.534 ms at the wood station, 3551 costs +0.420 and
 * 2105 costs +0.545. Flat. The outer edge is not where the money is.
 *
 * It should not be surprising. A quad's screen area falls as 1/d² while the
 * number of quads in a shell grows as d, so the fill from `d` to `D` goes as
 * `ln(D/d)` — EQUAL COST PER OCTAVE. At potato the band is (90, 384], which is
 * 2.1 octaves; cutting the outer edge to 240 removes 0.47 of them and cutting
 * it to 300 removes 0.25. The near end is where the fragments are, and the near
 * end is also where every one of them is behind a tree.
 *
 * `--inner` moves that end instead, by handing the stretch back to the far
 * trunk sweep: `geometryReach` is where the geometry stops and therefore where
 * the band begins. It costs triangles — 216-594 a tree against the quad's two —
 * and this project's own fit puts a million of those at about 0.10 ms, against
 * the half-millisecond of fill at stake.
 */
const SWEEP = (args.sweep ?? '384,300,240,180').split(',').map(Number);
const INNER = args.inner ? args.inner.split(',').map(Number) : null;

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
await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.waitForFunction(() => window.RR.forest.impostorStats().ready, { timeout: 30000 });
await page.click('#enter');
await page.waitForTimeout(2500);

/**
 * The freezes, and they are not optional — same set as cull-check and
 * reach-visible. Without them this measures the wind and the glow accumulator's
 * decay rather than the band.
 */
await page.evaluate(async () => {
  const R = window.RR;
  // Pinned at `high` throughout BOTH phases, so render scale, MSAA, shadows and
  // fog are constant and `forest.setReach` is the only thing that moves. The
  // rung is expressed as its BANDS, not as its preset.
  window.RRSettings.setMode('high');
  await new Promise((r) => setTimeout(r, 600));
  R.director.seek(160);
  for (let i = 0; i < 30; i++) R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
  R.pipeline.setTripParameters({ trail: 0 });
  R.probe.set('trail', false);
});

// ---- phase one: what the treeline is worth ---------------------------------

const ABOVE = [
  { name: 'above', x: 0, z: 0, yaw: 0.7, pitch: -0.18, lift: 55 },
  { name: 'above-flat', x: 400, z: -96, yaw: -Math.PI / 2, pitch: -0.06, lift: 70 },
];

const treeline = await page.evaluate(
  async ({ stations, rungs, want, sweep, inner, shots }) => {
    const R = window.RR;
    const gl = R.renderer.getContext();
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const a = new Uint8Array(w * h * 4);
    const b = new Uint8Array(w * h * 4);

    const shoot = (buf) => {
      R.forest.cull(R.camera, true);
      R.pipeline.render(1 / 60);
      R.pipeline.render(1 / 60);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    };
    const diff = () => {
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
      return { pct: (differing / (a.length / 4)) * 100, worst, mean: sum / (a.length / 4) };
    };

    const out = [];
    for (const s of stations) {
      // Seat and shoot inside ONE evaluate: `lift` moves the camera and not the
      // body, and the page's own rAF loop puts the camera back on the body's
      // head between two `page.evaluate` calls.
      R.controller.position.x = s.x;
      R.controller.position.z = s.z;
      R.controller.position.y = -1e4;
      R.controller.velocity.set(0, 0, 0);
      R.controller.yaw = s.yaw;
      R.controller.pitch = s.pitch;
      R.controller.applyToCamera();
      R.director.ground();
      for (let i = 0; i < 400; i++) await raf();
      R.camera.position.y += s.lift;
      R.camera.updateMatrixWorld(true);
      R.pipeline.setTripParameters({ trail: 0 });
      R.probe.set('trail', false);

      // The reference is FULL REACH with the band empty, exactly as in
      // reach-visible: 170/384 leaf 384. Saying so explicitly is what stops this
      // grading the impostors against themselves.
      R.forest.setImpostors(false);
      R.forest.setReach(170, 384, { leafReach: 384, alwaysNear: 82 });
      shoot(a);

      for (const name of want) {
        const rung = rungs[name];
        const arms = [{ tag: 'no band', imp: false, geo: rung.reach, reach: null }].concat(
          inner
            ? inner.map((v) => ({ tag: `from ${v}`, imp: true, geo: v, reach: 384 }))
            : sweep.map((v) => ({ tag: `imp ${v}`, imp: true, geo: null, reach: v }))
        );
        for (const arm of arms) {
          R.forest.setImpostors(arm.imp);
          R.forest.setReach(rung.lod, rung.reach, {
            leafReach: rung.leafReach,
            alwaysNear: 82,
            ...(arm.geo === null ? {} : { geometryReach: arm.geo }),
            ...(arm.reach === null ? {} : { impostorReach: arm.reach }),
          });
          shoot(b);
          let quads = 0;
          for (const m of R.forest.group.children) {
            if (m.name === 'impostor' && m.visible) quads += m.count;
          }
          out.push({
            station: s.name,
            rung: name,
            arm: arm.tag,
            quads,
            ...diff(),
            /**
             * A percentage is not a picture, and this decision is about whether
             * there is still a treeline. `toDataURL` in the same synchronous
             * task as the render, because the drawing buffer is not preserved
             * and a Playwright screenshot would composite whatever the rAF loop
             * drew next.
             */
            png: shots ? R.renderer.domElement.toDataURL('image/png') : null,
          });
        }
      }
    }
    R.forest.setImpostors(true);
    return out;
  },
  { stations: ABOVE, rungs: RUNGS, want: WANT, sweep: SWEEP, inner: INNER, shots: SHOTS }
);

console.log('TREELINE — pixel difference against a full-reach frame (170/384 leaf 384).');
console.log('Preset pinned at high, camera fixed, only forest.setReach moves.\n');
console.log('station    rung     arm         quads   differing px   worst   mean');
let lastKey = '';
for (const r of treeline) {
  const key = `${r.station}|${r.rung}`;
  if (lastKey && lastKey !== key) console.log('');
  lastKey = key;
  console.log(
    `${r.station.padEnd(10)} ${r.rung.padEnd(8)} ${r.arm.padEnd(10)} ${String(r.quads).padStart(6)}  ` +
      `${r.pct.toFixed(2).padStart(8)}%   ${String(r.worst).padStart(3)}/255  ${r.mean.toFixed(2).padStart(5)}`
  );
}

if (SHOTS) {
  mkdirSync('.perf/shots', { recursive: true });
  console.log('');
  for (const r of treeline) {
    if (!r.png) continue;
    const file = `.perf/shots/knee-${r.station}-${r.rung}-${r.arm.replace(/\s+/g, '')}.png`;
    writeFileSync(file, Buffer.from(r.png.split(',')[1], 'base64'));
    console.log(file);
  }
}

// ---- phase two: what it costs ----------------------------------------------

/**
 * FOUR EYE-LEVEL STATIONS AND ONE CONTROL, because the first clean run said the
 * cost lives at exactly one of them.
 *
 * `wood` is a dense interior view; `ridge` and `glade` are the long sightlines;
 * `clearing` is the spawn. A band that costs half a millisecond at one station
 * and nothing at the other three is a very different thing from one that costs
 * half a millisecond everywhere, and the first version of this script only
 * carried `wood` and `ridge` — with `ridge` contended by another process, which
 * is how a 0.00 ms row got reported as +0.505.
 */
const EYE = [
  { name: 'wood', x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
  { name: 'ridge', x: 400, z: -96, yaw: -Math.PI / 2, pitch: -0.05 },
  { name: 'clearing', x: 0, z: 8, yaw: 0, pitch: -0.03 },
  { name: 'glade', x: 706, z: 212, yaw: Math.PI, pitch: 0.04 },
  { name: 'canopy', x: -34, z: -46, yaw: 1.1, pitch: 0.85 },
];

const median = (xs) => {
  const s = [...xs].sort((p, q) => p - q);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

console.log('\n\nCOST — GPU ms, interleaved inside a round, median of the per-round paired deltas.');
for (const name of WANT) {
  const rung = RUNGS[name];
  await page.evaluate(
    ({ w, h }) => {
      const R = window.RR;
      R.renderer.setPixelRatio(1);
      R.renderer.setSize(w, h, false);
      R.camera.aspect = w / h;
      R.camera.updateProjectionMatrix();
      R.pipeline.setSize(w, h, 1);
      R.pipeline.trailEnabled = false;
      R.director.ground();
    },
    { w: rung.w, h: rung.h }
  );

  console.log(
    `\n  ${name}: bands ${rung.lod}/${rung.reach} leaf ${rung.leafReach}, ` +
      `internal ${rung.w}x${rung.h}, ${ROUNDS} rounds`
  );
  const ARMS = INNER
    ? INNER.map((v) => ({ label: `from ${v}`, imp: true, geo: v, reach: 384 }))
    : SWEEP.map((v) => ({ label: `imp ${v}`, imp: true, geo: null, reach: v }));
  console.log('  station    base ms   ' + ARMS.map((x) => x.label.padStart(9)).join('  '));

  for (const at of EYE) {
    const settled = await page.evaluate(async (s) => {
      const R = window.RR;
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      const seat = () => {
        R.controller.position.x = s.x;
        R.controller.position.z = s.z;
        R.controller.position.y = -1e4;
        R.controller.velocity.set(0, 0, 0);
        R.controller.yaw = s.yaw;
        R.controller.pitch = s.pitch;
        R.controller.applyToCamera();
      };
      seat();
      // Wall-clock settling, not frames: this script drives pipeline.render in a
      // tight loop with no yield, so the page's own frame() — which is what
      // advances the streamer — only runs during the awaits. See stations.mjs.
      let prev = null;
      let quiet = 0;
      for (let t = 0; t < 50 && quiet < 4; t++) {
        await sleep(400);
        const pending = (R.forest.field.pending ?? 0) + (R.forest.groundField.pending ?? 0);
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
      seat();
      return quiet >= 4;
    }, at);

    const timeArm = (arm) =>
      page.evaluate(
        async ({ a, r, f }) => {
          const R = window.RR;
          const gl = R.renderer.getContext();
          const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
          const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
          R.forest.setImpostors(a.imp);
          R.forest.setReach(r.lod, r.reach, {
            leafReach: r.leafReach,
            alwaysNear: r.alwaysNear,
            ...(a.geo === null ? {} : { geometryReach: a.geo }),
            ...(a.reach === null ? {} : { impostorReach: a.reach }),
          });
          const frame = () => {
            R.atmosphere.follow(R.camera);
            R.forest.cull(R.camera);
            // Re-armed every frame or this prices one shadow pass and N-1 cached
            // frames, which is a different game. See stations.mjs.
            R.renderer.shadowMap.needsUpdate = true;
            R.pipeline.render(1 / 60);
          };
          for (let i = 0; i < 12; i++) frame();
          gl.finish();
          const N = f;
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
          return { ms: ns / 1e6 / N, disjoint: !!disjoint };
        },
        { a: arm, r: rung, f: FRAMES }
      );

    const deltas = new Map(ARMS.map((x) => [x.label, []]));
    const bases = [];
    const BASE = { imp: false, geo: rung.reach, reach: null };
    for (let round = 0; round < ROUNDS; round++) {
      // A at both ends of the round, so a drift across the round cancels in the
      // pair rather than landing on whichever arm ran last.
      const a0 = await timeArm(BASE);
      const mid = [];
      for (const x of ARMS) mid.push([x.label, await timeArm(x)]);
      const a1 = await timeArm(BASE);
      if (a0.disjoint || a1.disjoint) continue;
      const base = (a0.ms + a1.ms) / 2;
      bases.push(base);
      for (const [label, res] of mid) if (!res.disjoint) deltas.get(label).push(res.ms - base);
    }
    console.log(
      `  ${at.name.padEnd(10)} ${median(bases).toFixed(3).padStart(7)}   ` +
        ARMS.map((x) => {
          const d = median(deltas.get(x.label));
          return ((d >= 0 ? '+' : '') + d.toFixed(3)).padStart(9);
        }).join('  ') +
        (at.name === 'canopy' ? '   <- CONTROL' : '') +
        (settled ? '' : '   UNSETTLED')
    );
  }
}

await browser.close();
