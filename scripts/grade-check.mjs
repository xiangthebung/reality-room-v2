import { chromium } from 'playwright';

/**
 * Does the colour grade widen the picture or narrow it?
 *
 *   node scripts/grade-check.mjs [--only=wood,floor]
 *
 * THE INSTRUMENT THAT SETTLED THE GRADE. A grade is the one stage that touches
 * every pixel, so it is also the one that can quietly delete somebody else's
 * work — a saturation gain that flattens the gamut deletes a scarlet bromeliad
 * at the last stage of the pipeline, and nobody editing scatter.js can see it
 * happen. The rule this checks is that every operator in the grade must
 * INCREASE the spread of the frame and none of them may move its mean.
 *
 * It caught two versions that failed it: a green cast that raised satMean and
 * cut local separation, and an S-curve applied in linear light that cut `local`
 * by up to 31%.
 *
 * Renders each station twice — uGrade 0 and uGrade 1, nothing else touched —
 * reads the framebuffer both times and reports:
 *
 *   lumaSd    spread of brightness across the frame. Higher is more depth.
 *   satMean   mean HSV saturation.
 *   satSd     spread of saturation. This is the one that dies under a cast.
 *   hueSd     circular spread of hue over the coloured pixels. A single-hue
 *             frame scores near zero however saturated it is.
 *   local     mean |a - b| over pixel pairs 10 px apart. This is the direct
 *             "can you still tell a fern from the ground behind it" number.
 *   cells     occupied cells of a 16x16x16 RGB histogram: how much of the
 *             colour cube the frame actually uses.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const STATIONS = {
  clearing: { x: 0, z: 8, yaw: 0, pitch: -0.03 },
  wood: { x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
  floor: { x: -34, z: -46, yaw: 1.1, pitch: -0.62 },
  glade: { x: 706, z: 212, yaw: Math.PI, pitch: 0.04 },
};
const ONLY = args.only ? args.only.split(',') : null;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(args.url ?? 'http://127.0.0.1:5180/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.evaluate(() => {
  document.getElementById('gate').classList.add('gone');
  document.getElementById('toast').style.display = 'none';
  document.getElementById('help').style.display = 'none';
  window.RR.probe.freeze(true);
  window.RR.pipeline.trailEnabled = false;
  window.__stats = (grade) => {
    const R = window.RR;
    R.pipeline.outputMaterial.uniforms.uGrade.value = grade;
    for (let i = 0; i < 3; i++) R.pipeline.render(1 / 60);
    const src = R.renderer.domElement;
    const w = 640;
    const h = Math.round((src.height / src.width) * w);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    let lsum = 0;
    let lsq = 0;
    let ssum = 0;
    let ssq = 0;
    let hx = 0;
    let hy = 0;
    let hn = 0;
    let local = 0;
    let ln = 0;
    const cells = new Set();
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const r = d[i * 4] / 255;
      const gg = d[i * 4 + 1] / 255;
      const b = d[i * 4 + 2] / 255;
      const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      const mx = Math.max(r, gg, b);
      const mn = Math.min(r, gg, b);
      const sat = mx > 1e-4 ? (mx - mn) / mx : 0;
      lsum += l;
      lsq += l * l;
      ssum += sat;
      ssq += sat * sat;
      if (sat > 0.12) {
        let hue;
        const c2 = mx - mn;
        if (mx === r) hue = ((gg - b) / c2 + 6) % 6;
        else if (mx === gg) hue = (b - r) / c2 + 2;
        else hue = (r - gg) / c2 + 4;
        const a = (hue / 6) * Math.PI * 2;
        hx += Math.cos(a);
        hy += Math.sin(a);
        hn++;
      }
      cells.add(((d[i * 4] >> 4) << 8) | ((d[i * 4 + 1] >> 4) << 4) | (d[i * 4 + 2] >> 4));
      const x = i % w;
      if (x + 10 < w) {
        const j = i + 10;
        local +=
          Math.abs(d[i * 4] - d[j * 4]) +
          Math.abs(d[i * 4 + 1] - d[j * 4 + 1]) +
          Math.abs(d[i * 4 + 2] - d[j * 4 + 2]);
        ln++;
      }
    }
    const lm = lsum / n;
    const sm = ssum / n;
    const R2 = hn ? Math.sqrt(hx * hx + hy * hy) / hn : 1;
    return {
      lumaMean: +lm.toFixed(4),
      lumaSd: +Math.sqrt(Math.max(0, lsq / n - lm * lm)).toFixed(4),
      satMean: +sm.toFixed(4),
      satSd: +Math.sqrt(Math.max(0, ssq / n - sm * sm)).toFixed(4),
      // 1 - R is the circular spread: 0 = every coloured pixel the same hue.
      hueSd: +(1 - R2).toFixed(4),
      local: +(local / ln / 3).toFixed(3),
      cells: cells.size,
    };
  };
});

const rows = [];
for (const [name, s] of Object.entries(STATIONS)) {
  if (ONLY && !ONLY.includes(name)) continue;
  const out = await page.evaluate(
    async (st) => {
      const R = window.RR;
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      R.controller.position.x = st.x;
      R.controller.position.z = st.z;
      R.controller.position.y = -1e4;
      R.controller.velocity.set(0, 0, 0);
      R.controller.yaw = st.yaw;
      R.controller.pitch = st.pitch;
      R.controller.applyToCamera();
      for (let i = 0; i < 150; i++) await raf();
      R.director.ground();
      for (let i = 0; i < 30; i++) R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
      R.tripUniforms.uWind.value.set(11.5, 17.4);
      R.atmosphere.follow(R.camera);
      R.renderer.shadowMap.needsUpdate = true;
      R.forest.cull(R.camera, true);
      // Whatever the grade currently ships as. Nothing is overridden here — a
      // check that pins its own values stops checking the build the moment
      // somebody re-tunes one of them.
      const off = window.__stats(0);
      const on = window.__stats(1);
      R.pipeline.outputMaterial.uniforms.uGrade.value = 1;
      return { off, on };
    },
    s
  );
  rows.push({ name, ...out });
}

const keys = ['lumaMean', 'lumaSd', 'satMean', 'satSd', 'hueSd', 'local', 'cells'];
console.log('\nGRADE OFF vs ON — higher is wider except lumaMean/satMean, which should barely move\n');
console.log('station   metric         off |  graded');
const VARIANTS = ['on'];
for (const r of rows) {
  for (const k of keys) {
    const a = r.off[k];
    const cells = VARIANTS.map((v) => {
      const b = r[v][k];
      const pct = a === 0 ? 0 : ((b - a) / a) * 100;
      return `${String(b).padStart(8)} ${((pct >= 0 ? '+' : '') + pct.toFixed(1) + '%').padStart(7)}`;
    });
    console.log(`${r.name.padEnd(9)} ${k.padEnd(9)} ${String(a).padStart(8)} | ${cells.join(' | ')}`);
  }
  console.log('');
}
await browser.close();
