import { boot, argv } from './perf/harness.mjs';

/**
 * How far away is the thing you are looking at?
 *
 * This exists to set ONE constant: RR_VIEW_SHELL, the distance the view
 * breath's field sits at. That constant decides how the swell flows when you
 * walk, and it decides it exactly — the field is sampled at `eye + dir*SHELL`,
 * so its screen-space motion under translation is, by construction, the optical
 * flow of a world feature at SHELL metres. Set it to the depth of what fills
 * the frame and the swell streams past with the wood; set it too far and the
 * swell holds still against a world that is streaming, which is the single most
 * reliable way to make anything look stuck to the glass.
 *
 * So the number is not a taste call and should not be guessed. It is a property
 * of this forest, measured here by raycasting a grid of view directions into
 * the real scene at the real stations.
 *
 *   node scripts/view-depth.mjs
 *
 * Rays that hit nothing are counted, not dropped. A frame that is 40% sky has a
 * median depth that depends entirely on how you treat that 40%, and silently
 * dropping it would report the wood while showing the sky.
 */

const args = argv({});
const { browser, page } = await boot({ url: args.build ? 'http://127.0.0.1:5182/' : undefined });

const STATIONS = ['clearing', 'deep', 'canopy', 'ridge'];

const report = await page.evaluate(async (stations) => {
  const R = window.RR;
  /**
   * Bare 'three' does not resolve inside an evaluate — the page has no import
   * map, and Vite's rewriting happens at transform time to modules it serves,
   * not to a string handed to the debugger. The dev server's own optimised
   * dependency URL is what the app itself imports, so ask for that.
   */
  const THREE = R.THREE ?? (await import('/node_modules/three/build/three.module.js'));
  const out = [];
  for (const station of stations) {
    // `arrive` puts the camera where the perf suite puts it, so these depths
    // describe the same views every other measurement in the project uses.
    await window.__RR_PERF__.scenario({ name: station, station, level: 'sober' }, { reps: 1 });
    const cam = R.camera;
    cam.updateMatrixWorld();
    const ray = new THREE.Raycaster();
    ray.far = 400;
    /** Walking forward is the camera's forward, flattened — you cannot fly. */
    const walk = new THREE.Vector3();
    cam.getWorldDirection(walk);
    walk.y = 0;
    walk.normalize();
    const hits = [];
    const samples = [];
    let sky = 0;
    // A 9x5 grid across the frame, skipping the very edge.
    for (let i = 0; i < 9; i++) {
      for (let j = 0; j < 5; j++) {
        const ndc = new THREE.Vector2((i / 8) * 1.8 - 0.9, (j / 4) * 1.8 - 0.9);
        ray.setFromCamera(ndc, cam);
        const found = ray.intersectObject(R.scene, true);
        const solid = found.find((h) => h.distance > 0.1);
        if (solid) {
          hits.push(solid.distance);
          /**
           * sin of the angle between this ray and the direction of travel.
           *
           * It is the weight, because only the part of the flow PERPENDICULAR
           * to the view ray reads as the pattern sliding across the picture.
           * Straight ahead (sin 0) nothing slides however wrong the shell is —
           * which is why a shell can be badly wrong and still look fine when
           * you are staring at the horizon, and obvious at the edges of the
           * frame where the ground streams past.
           */
          samples.push({ z: solid.distance, w: Math.sin(ray.ray.direction.angleTo(walk)) ** 2 });
        } else sky++;
      }
    }
    hits.sort((a, b) => a - b);
    const q = (p) => (hits.length ? hits[Math.min(hits.length - 1, Math.floor(hits.length * p))] : NaN);
    out.push({
      station,
      rays: 45,
      sky,
      median: q(0.5),
      p25: q(0.25),
      p75: q(0.75),
      /**
       * The HARMONIC mean, and it is the one that matters rather than the
       * median. Optical flow goes as 1/z, so what a single shell has to match
       * is the average RATE, and the average of 1/z is the harmonic mean — it
       * is pulled toward the near things, which is correct, because near things
       * are what visibly stream past when you walk.
       */
      harmonic: hits.length ? hits.length / hits.reduce((s, d) => s + 1 / d, 0) : NaN,
      samples,
    });
  }
  return out;
}, STATIONS);

/**
 * SOLVE for the shell rather than eyeballing it off the table.
 *
 * The field is sampled at `eye + dir*SHELL`, so under a step of one metre the
 * pattern slides across a world feature at depth z by
 *
 *     ARC * sin(theta) * (1/SHELL - 1/z)     domain units
 *
 * — theta being the angle between that ray and the direction of travel. The
 * term is exactly zero at z = SHELL, which is the whole reason this constant
 * exists. Minimising the weighted square of it over the depths actually on
 * screen is a least-squares fit in 1/SHELL, and the answer is therefore the
 * sin²-weighted HARMONIC mean of z — not the median, and not the arithmetic
 * mean, both of which are dragged upward by a few distant rays that contribute
 * almost no flow.
 */
const ARC = 3.1;
const FRAME_UNITS = 5.2; // domain units across the frame; see RR_VIEW_ARC
const all = report.flatMap((r) => r.samples);
const wSum = all.reduce((s, p) => s + p.w, 0);
const wOverZ = all.reduce((s, p) => s + p.w / p.z, 0);
const best = wSum / wOverZ;
/** RMS slide across the wood, in frame widths per metre walked. */
const slideFor = (shell) =>
  Math.sqrt(
    all.reduce((s, p) => s + p.w * (ARC * (1 / shell - 1 / p.z)) ** 2, 0) / wSum
  ) / FRAME_UNITS;

console.log('\n  station     sky/45   p25      median   p75      harmonic mean');
console.log('  ' + '─'.repeat(60));
for (const r of report) {
  const f = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}m`.padStart(7) : '      —');
  console.log(
    `  ${r.station.padEnd(11)} ${String(r.sky).padStart(2)}    ` +
      `${f(r.p25)}  ${f(r.median)}  ${f(r.p75)}  ${f(r.harmonic)}`
  );
}
console.log(`\n  ${all.length} rays hit something across ${report.length} stations.`);
console.log('\n  how much the swell slides across the wood, per metre walked');
console.log('  ' + '─'.repeat(60));
for (const shell of [8, 12, 17, 24, 40, 120, Infinity]) {
  const s = slideFor(shell);
  const label = shell === Infinity ? 'infinity' : `${shell} m`;
  console.log(
    `  shell ${label.padEnd(9)} ${(s * 100).toFixed(2).padStart(6)}% of the frame` +
      `${shell === 120 ? '   <- what shipped' : ''}`
  );
}
console.log(
  `\n  best fit: RR_VIEW_SHELL = ${best.toFixed(1)} m ` +
    `(${(slideFor(best) * 100).toFixed(2)}% per metre, against ` +
    `${(slideFor(120) * 100).toFixed(2)}% at 120 m).`
);
console.log(
  '  At 120 m the field barely moved while the wood streamed past it, which is\n' +
    '  what a pattern stuck to the screen looks like. The residual never reaches\n' +
    '  zero because one shell cannot match every depth at once — without a depth\n' +
    '  buffer this is the best a single number can do, and the depth buffer is\n' +
    '  what draws seams at silhouettes.'
);

await browser.close();
