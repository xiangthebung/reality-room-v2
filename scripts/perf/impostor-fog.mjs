/**
 * IS `potato`'s fogDistance 0.47 STILL BUYING ANYTHING?
 *
 *   node scripts/perf/impostor-fog.mjs [--rung=potato] [--shots]
 *
 * That preset exists for one reason, stated in the `treeReach` block in
 * quality.js: a shortened reach without matching haze does not fade out, it
 * opens a hard-edged circular hole that follows the player, and hiding a reach
 * of `d` needs a fog density of `2.354/d` — 0.0196 at 120 m against a sober
 * 0.00921, i.e. a multiplier of 0.47. It is haze bought to hide an EDGE.
 *
 * The impostor band fills that edge with trees out to 384 m, which is where
 * sober density already hides everything on its own. So the premise may be
 * spent — and thicker haze is not free in the way a disabled feature is free.
 * It repaints the whole depth of the wood: the same quality.js block measures a
 * 1.25x density as +2.6 luminance across the frame at the spawn clearing.
 *
 * THE QUESTION, PUT PROPERLY. "Does the picture change when I move the fog" is
 * the wrong test — of course it does, that is what fog is. The right test is
 * whether the fog is still hiding a CUT. So each density gets its own
 * full-reach reference at the same density, and what is compared is how far the
 * short-reach frame sits from the frame it is pretending to be:
 *
 *     A   full reach @ rho          vs   potato bands + band @ rho
 *
 * If that distance is the same at 1.00 as at 0.47, the haze is hiding nothing
 * the band is not already hiding, and it is pure cost.
 *
 * The third row is what the haze itself does — full reach at 0.47 against full
 * reach at 1.00 — so the price of keeping it is on the same page as the reason.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const SHOTS = !!args.shots;
const RUNGS = {
  potato: { lod: 60, reach: 120, leafReach: 90, fog: 0.47 },
  low: { lod: 90, reach: 180, leafReach: 110, fog: 0.7 },
};
const RUNG = RUNGS[args.rung ?? 'potato'];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.routeWebSocket(/.*/, () => {});
await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.waitForFunction(() => window.RR.forest.impostorStats().ready, { timeout: 30000 });
await page.click('#enter');
await page.waitForTimeout(2500);

const STATIONS = [
  { name: 'ridge', x: 400, z: -96, yaw: -Math.PI / 2, pitch: -0.05 },
  { name: 'wood', x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
  { name: 'clearing', x: 0, z: 8, yaw: 0, pitch: -0.03 },
  { name: 'stream', x: 4, z: 20, yaw: 0.1, pitch: -0.12 },
  { name: 'above-flat', x: 400, z: -96, yaw: -Math.PI / 2, pitch: -0.06, lift: 70 },
];

const out = await page.evaluate(
  async ({ stations, rung, shots }) => {
    const R = window.RR;
    const gl = R.renderer.getContext();
    const raf = () => new Promise((r) => requestAnimationFrame(r));

    /**
     * `high` for everything EXCEPT the fog, which is the variable.
     *
     * Pinning the preset and then moving one knob is the same method
     * reach-visible uses: diffing the potato RUNG against the high rung would
     * conflate render scale, MSAA, shadows and undergrowth density with the one
     * thing on trial.
     */
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
    /**
     * The fog knob has to be written through the settings registry.
     *
     * The live density is composed by `atmosphere._recompose` from four
     * opinions — authored x hour x knob x cave depth — and rebuilt whenever any
     * of them moves. A density written straight onto `scene.fog.density` is
     * therefore overwritten within a frame; only the knob is durable. That trap
     * is documented on `fogDistance` itself and has caught other scripts here.
     */
    const setFog = (v) => window.RRSettings.set('fogDistance', v);
    const full = () => {
      R.forest.setImpostors(false);
      R.forest.setReach(170, 384, { leafReach: 384, alwaysNear: 82 });
    };
    const cut = (band) => {
      R.forest.setImpostors(band);
      R.forest.setReach(rung.lod, rung.reach, {
        leafReach: rung.leafReach,
        alwaysNear: 82,
        ...(band ? {} : { geometryReach: rung.reach }),
      });
    };

    const rows = [];
    for (const s of stations) {
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

      // How far the short-reach frame sits from full reach, at each density.
      for (const rho of [1.0, rung.fog]) {
        setFog(rho);
        full();
        shoot(a);
        cut(true);
        shoot(b);
        rows.push({ station: s.name, kind: `cut vs full @ fog ${rho.toFixed(2)}`, ...diff() });
      }
      // And the same thing with the band OFF, so the row above has something to
      // be better than — this is the pairing the 0.47 was originally chosen for.
      for (const rho of [1.0, rung.fog]) {
        setFog(rho);
        full();
        shoot(a);
        cut(false);
        shoot(b);
        rows.push({ station: s.name, kind: `no band vs full @ fog ${rho.toFixed(2)}`, ...diff() });
      }
      // What the haze itself costs: same wood, two densities.
      setFog(1.0);
      cut(true);
      shoot(a);
      const png = shots ? R.renderer.domElement.toDataURL('image/png') : null;
      setFog(rung.fog);
      cut(true);
      shoot(b);
      rows.push({ station: s.name, kind: `the haze itself (${rung.fog} vs 1.00)`, ...diff() });
      rows.push({
        station: s.name,
        kind: '__png',
        pct: 0,
        worst: 0,
        mean: 0,
        pngA: png,
        pngB: shots ? R.renderer.domElement.toDataURL('image/png') : null,
      });
    }
    setFog(1.0);
    R.forest.setImpostors(true);
    return rows;
  },
  { stations: STATIONS, rung: RUNG, shots: SHOTS }
);

console.log(
  `Preset pinned at high; only fogDistance and forest.setReach move.\n` +
    `Bands ${RUNG.lod}/${RUNG.reach} leaf ${RUNG.leafReach}; the rung's own fog is ${RUNG.fog}.\n`
);
console.log('station     comparison                        differing px   worst   mean');
let lastStation = '';
for (const r of out) {
  if (r.kind === '__png') continue;
  if (lastStation && lastStation !== r.station) console.log('');
  lastStation = r.station;
  console.log(
    `${r.station.padEnd(11)} ${r.kind.padEnd(33)} ${r.pct.toFixed(2).padStart(7)}%   ` +
      `${String(r.worst).padStart(3)}/255  ${r.mean.toFixed(2).padStart(5)}`
  );
}

if (SHOTS) {
  mkdirSync('.perf/shots', { recursive: true });
  console.log('');
  for (const r of out) {
    if (r.kind !== '__png' || !r.pngA) continue;
    for (const [tag, url] of [['fog100', r.pngA], [`fog${String(RUNG.fog).replace('.', '')}`, r.pngB]]) {
      const file = `.perf/shots/fog-${r.station}-${tag}.png`;
      writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
      console.log(file);
    }
  }
}
await browser.close();
