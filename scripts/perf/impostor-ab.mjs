/**
 * The impostor band on trial, against the frame it is trying to reproduce.
 *
 * `reach-visible.mjs` answers "is the shipped reach visible"; this answers the
 * two questions that only exist once there is something to put in the gap:
 *
 *   1. WHERE SHOULD THE BAND START? At `reach`, where the trunks stop, or at
 *      `leafReach`, where the CANOPY stops? The second is the aggressive
 *      reading — it deletes the ring of leafless far-trunks between the two and
 *      draws whole trees there instead — and since an impostor is two triangles
 *      against the far sweep's 216-594, it is also the cheaper of the two.
 *
 *   2. HOW BRIGHT SHOULD IT BE? The atlas is baked under a fixed rig and never
 *      lit again, so `uImpostorShade` is the one dial that matches the band's
 *      level to the geometry it takes over from. `--shade=a,b,c` sweeps it.
 *
 * Method is lifted from reach-visible.mjs and the freezes are not optional: the
 * reference and the arm are rendered from one page session, one camera and one
 * settled ring, with the trip clock and the glow accumulator pinned, so the only
 * thing that differs between two readbacks is the band.
 *
 * THE REFERENCE IS FULL REACH WITH THE BAND OFF, not full reach with it on. At
 * 384 m the band is empty either way, but saying so explicitly is what stops
 * this quietly grading the impostors against themselves.
 */
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5180/';
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('='))
);
const SHADES = (args.shade ?? '').split(',').filter(Boolean).map(Number);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.routeWebSocket(/.*/, () => {});
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.waitForFunction(() => window.RR.forest.impostorStats().ready, { timeout: 30000 });
await page.click('#enter');
await page.waitForTimeout(2500);

const results = await page.evaluate(async (shades) => {
  const R = window.RR;
  const gl = R.renderer.getContext();
  const raf = () => new Promise((r) => requestAnimationFrame(r));

  window.RRSettings.setMode('high');
  await new Promise((r) => setTimeout(r, 600));
  R.director.seek(160);
  for (let i = 0; i < 30; i++) R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
  R.pipeline.setTripParameters({ trail: 0 });
  R.probe.set('trail', false);

  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const a = new Uint8Array(w * h * 4);
  const b = new Uint8Array(w * h * 4);

  const STATIONS = [
    { name: 'above', x: 0, z: 0, yaw: 0.7, pitch: -0.18, lift: 55 },
    { name: 'above-flat', x: 400, z: -96, yaw: -Math.PI / 2, pitch: -0.06, lift: 70 },
    // One eye-level station as a control: whatever this change does above the
    // canopy, it must not move the picture inside the wood.
    { name: 'ridge', x: 400, z: -96, yaw: -Math.PI / 2, pitch: -0.05 },
  ];
  const RUNGS = [
    { name: '250 medium', lod: 120, reach: 250, leafReach: 150 },
    { name: '180 low', lod: 90, reach: 180, leafReach: 110 },
    { name: '120 potato', lod: 60, reach: 120, leafReach: 90 },
  ];

  /** Every impostor material shares one uniform object per layer. */
  const setShade = (v) => {
    for (const m of R.forest.group.children) {
      const u = m.material?.userData?.impostor;
      if (u) u.uImpostorShade.value = v;
    }
  };

  const seat = async (s) => {
    R.controller.position.x = s.x;
    R.controller.position.z = s.z;
    R.controller.position.y = -1e4;
    R.controller.velocity.set(0, 0, 0);
    R.controller.yaw = s.yaw;
    R.controller.pitch = s.pitch;
    R.controller.applyToCamera();
    R.director.ground();
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
  for (const s of STATIONS) {
    await seat(s);
    R.forest.setImpostors(false);
    R.forest.setReach(170, 384, { leafReach: 384, alwaysNear: 82 });
    shoot(a);

    for (const rung of RUNGS) {
      const arms = [
        // `geometryReach: reach` puts the pre-impostor handover back, so "cut"
        // really is the shipped picture and "@reach" really is the conservative
        // reading of the band rather than the default one wearing a label.
        { tag: 'cut (today)', imp: false, geo: rung.reach },
        { tag: 'impostor @reach', imp: true, geo: rung.reach },
        { tag: 'impostor @leaf', imp: true, geo: rung.leafReach },
      ];
      for (const arm of arms) {
        for (const shade of shades.length && arm.imp ? shades : [null]) {
          if (shade !== null) setShade(shade);
          R.forest.setImpostors(arm.imp);
          R.forest.setReach(rung.lod, rung.reach, {
            leafReach: rung.leafReach,
            alwaysNear: 82,
            geometryReach: arm.geo,
          });
          shoot(b);
          out.push({
            station: s.name,
            rung: rung.name,
            arm: arm.tag + (shade === null ? '' : ` shade ${shade}`),
            ...diff(),
          });
        }
        setShade(1.0);
      }
    }
  }
  R.forest.setImpostors(true);
  return out;
}, SHADES);

console.log('Reference: 170/384 leaf 384, impostors off. Preset pinned at high, camera fixed.\n');
console.log('station    rung        arm                        differing px   worst   mean');
let last = '';
for (const r of results) {
  const key = `${r.station}|${r.rung}`;
  if (last && last !== key) console.log('');
  last = key;
  console.log(
    `${r.station.padEnd(10)} ${r.rung.padEnd(11)} ${r.arm.padEnd(26)} ` +
      `${r.pct.toFixed(2).padStart(7)}%  ${String(r.worst).padStart(4)}/255  ${r.mean.toFixed(2).padStart(5)}`
  );
}
await browser.close();
