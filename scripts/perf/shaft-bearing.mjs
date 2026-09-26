/**
 * DOES THE AXIAL FALLOFF ONLY BITE DOWN THE BARREL? — measured per bearing.
 *
 *   node scripts/perf/shaft-bearing.mjs
 *
 * The shaft shader multiplies `radial` by `1 - axial²`, where `axial` is
 * |beam · eye|. By construction that is 1.0 when the view is perpendicular to
 * the beam and 0.0 when it is down the beam, so the near-axial panel artifact
 * goes and the across-the-bearing look is untouched. "By construction" is not a
 * measurement, and the readback path a previous agent tried on this returned
 * zeros — a known blind instrument in this repo — so this measures it.
 *
 * WHAT IT MEASURES. The shafts' own contribution to the frame, as the mean
 * pixel delta between the frame with the layer visible and the same frame with
 * it hidden, at eight bearings around the compass. The bearing where the sun
 * is has to lose contribution — that is the fix. Every other bearing has to
 * keep it, and the two bearings at 90 degrees are the ones the patch promises
 * are exactly unchanged.
 *
 * A CONTRIBUTION OF ZERO AT EVERY BEARING MEANS THE INSTRUMENT IS BLIND, not
 * that the shafts are invisible, so the run prints the raw hidden/visible
 * luminance as well and says so.
 */
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5180/';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.routeWebSocket(/.*/, () => {});
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2500);

const out = await page.evaluate(async () => {
  const R = window.RR;
  const gl = R.renderer.getContext();
  const raf = () => new Promise((r) => requestAnimationFrame(r));

  window.RRSettings.setMode('ultra');
  await new Promise((r) => setTimeout(r, 600));

  // The bug only shows with the trip driving uStrength above 2; sober is 1.0.
  R.director.seek(160);
  for (let i = 0; i < 40; i++) R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
  R.pipeline.setTripParameters({ trail: 0 });
  R.probe.set('trail', false);

  /**
   * The layer registry, not a name match. `probe.layers.shafts` is the same
   * accessor every other instrument in this directory hides the layer with, so
   * a rename cannot make this quietly measure nothing — and measuring nothing
   * here would read as "the patch is harmless", which is the wrong way for an
   * instrument to fail.
   */
  const uniq = [...new Set(R.probe.layers.shafts?.() ?? [])];

  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const a = new Uint8Array(w * h * 4);
  const b = new Uint8Array(w * h * 4);

  R.controller.position.x = 0;
  R.controller.position.z = 8;
  R.controller.position.y = -1e4;
  R.controller.velocity.set(0, 0, 0);
  R.controller.pitch = 0.08;
  R.controller.applyToCamera();
  R.director.ground();
  for (let i = 0; i < 400; i++) await raf();
  R.director.seek(160);
  for (let i = 0; i < 40; i++) R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
  R.pipeline.setTripParameters({ trail: 0 });
  R.probe.set('trail', false);

  const shoot = (buf) => {
    R.forest.cull(R.camera, true);
    R.pipeline.render(1 / 60);
    R.pipeline.render(1 / 60);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  };
  const luma = (buf) => {
    let s = 0;
    for (let i = 0; i < buf.length; i += 4) s += 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
    return s / (buf.length / 4);
  };

  // Where the sun actually is, in the same yaw convention the controller uses.
  const sun = R.atmosphere.sun.position.clone().normalize();
  const sunYaw = Math.atan2(sun.x, sun.z);

  const rows = [];
  for (let k = 0; k < 8; k++) {
    const rel = (k * Math.PI) / 4;
    R.controller.yaw = sunYaw + rel;
    R.controller.applyToCamera();
    for (const o of uniq) o.visible = true;
    shoot(a);
    for (const o of uniq) o.visible = false;
    shoot(b);
    for (const o of uniq) o.visible = true;
    let sum = 0;
    let moved = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(
        Math.abs(a[i] - b[i]),
        Math.abs(a[i + 1] - b[i + 1]),
        Math.abs(a[i + 2] - b[i + 2])
      );
      sum += d;
      if (d > 1) moved++;
    }
    rows.push({
      deg: Math.round((rel * 180) / Math.PI),
      contribution: sum / (a.length / 4),
      moved: (moved / (a.length / 4)) * 100,
      lumaOn: luma(a),
      lumaOff: luma(b),
    });
  }
  return { meshes: uniq.length, rows };
});

console.log(`Shaft contribution by bearing, ultra, trip peak, authored hour. ${out.meshes} shaft object(s).`);
console.log('0 deg is looking AT the sun — the near-axial view the panel artifact lived in.\n');
console.log('bearing   contribution   pixels moved     luma on / off');
for (const r of out.rows) {
  console.log(
    `${String(r.deg).padStart(5)}°   ${r.contribution.toFixed(3).padStart(12)}   ${r.moved.toFixed(2).padStart(9)}%   ` +
      `${r.lumaOn.toFixed(2)} / ${r.lumaOff.toFixed(2)}`
  );
}
const perp = out.rows.filter((r) => r.deg === 90 || r.deg === 270);
const axial = out.rows.find((r) => r.deg === 0);
console.log(
  `\nacross the bearing (90/270): ${perp.map((r) => r.contribution.toFixed(3)).join(', ')}` +
    `   down the barrel (0): ${axial.contribution.toFixed(3)}`
);
if (out.rows.every((r) => r.contribution < 0.001)) {
  console.log('EVERY bearing reads zero — this instrument is blind, not the shafts invisible.');
}
await browser.close();
