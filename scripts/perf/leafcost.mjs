import { boot, argv, heading, PAD, NUM } from './harness.mjs';
import { median } from './stats.mjs';

/**
 * WHAT MAKES THE CANOPY THE MOST EXPENSIVE LAYER IN THE FRAME.
 *
 *   npm run perf:leaf
 *   npm run perf:leaf -- --station=canopy --reps=6
 *
 * `perf:why` says the leaf layer is 2.9 ms of a 5.6 ms deep frame — 52%, and
 * five times the cost per triangle of anything else. That is the WHAT. It does
 * not say whether those milliseconds are the texture sampler, the alpha test,
 * or simply the number of cards stacked over each pixel, and those three have
 * nothing in common as fixes.
 *
 * Each arm below removes ONE property of the canopy and leaves everything else
 * standing, paired A-B-B-A against the shipping configuration in the same
 * session so driver state and GPU clocks cannot drift between the arms. None of
 * them is a shippable change — several are visually destructive on purpose. The
 * point is to find out which lever the milliseconds are actually on before
 * anybody spends risk on one.
 */

const args = argv({ station: 'deep', level: 'peak', reps: '4', batch: '24' });
const REPS = Number(args.reps);

const { browser, page, caps } = await boot({ quiet: true });

heading('what the canopy is actually spending');
console.log(`gpu    ${caps.gpu}`);
console.log(`seed   ${caps.seed}`);
console.log(`station ${args.station}, ${args.level} — ${REPS} A-B-B-A repetitions\n`);

/**
 * Collect the canopy materials once, by the mesh NAME the layer table uses,
 * rather than by guessing at module internals. `probe.layers` already proves
 * 'leaf' is the name the rest of the rig means by "leaves".
 */
await page.evaluate(() => {
  const scene = window.RR.scene;
  const mats = new Set();
  const maps = new Set();
  const meshes = [];
  scene.traverse((o) => {
    if (o.isMesh && o.name === 'leaf' && o.material) {
      meshes.push(o);
      mats.add(o.material);
      if (o.material.map) maps.add(o.material.map);
    }
  });
  window.__leaf = {
    meshes,
    mats: [...mats],
    maps: [...maps],
    saved: [...mats].map((m) => ({ alphaTest: m.alphaTest, side: m.side })),
    savedAniso: [...maps].map((t) => t.anisotropy),
  };
});

const found = await page.evaluate(() => ({
  mats: window.__leaf.mats.length,
  maps: window.__leaf.maps.length,
  aniso: window.__leaf.savedAniso,
}));
console.log(`  ${found.mats} canopy materials, ${found.maps} canvases, anisotropy ${found.aniso.join('/')}\n`);

/** Each arm: a function body applied to the page, and its undo. */
const ARMS = [
  {
    name: 'anisotropy 8 -> 1',
    why: 'up to 8 taps per fragment on the biggest fill layer',
    apply: `for (const t of window.__leaf.maps) { t.anisotropy = 1; t.needsUpdate = true; }`,
    undo: `window.__leaf.maps.forEach((t, i) => { t.anisotropy = window.__leaf.savedAniso[i]; t.needsUpdate = true; });`,
  },
  {
    name: 'DoubleSide -> FrontSide',
    why: 'halves the rasterised fragments if the cards are two-sided by need',
    apply: `for (const m of window.__leaf.mats) { m.side = 0; m.needsUpdate = true; }`,
    undo: `window.__leaf.mats.forEach((m, i) => { m.side = window.__leaf.saved[i].side; m.needsUpdate = true; });`,
  },
  {
    name: 'alphaTest 0.42 -> 0.9',
    why: 'discards far more fragments; isolates overdraw from shading',
    apply: `for (const m of window.__leaf.mats) { m.alphaTest = 0.9; m.needsUpdate = true; }`,
    undo: `window.__leaf.mats.forEach((m, i) => { m.alphaTest = window.__leaf.saved[i].alphaTest; m.needsUpdate = true; });`,
  },
  {
    name: 'alphaTest off (fully opaque cards)',
    why: 'restores early-Z; the whole card becomes an occluder',
    apply: `for (const m of window.__leaf.mats) { m.alphaTest = 0; m.needsUpdate = true; }`,
    undo: `window.__leaf.mats.forEach((m, i) => { m.alphaTest = window.__leaf.saved[i].alphaTest; m.needsUpdate = true; });`,
  },
  /**
   * THE ONE ARM THAT IS A CANDIDATE FOR SHIPPING.
   *
   * The three arms above establish that the canopy's cost is leaf-on-leaf
   * overdraw: raising the alpha test discards far more fragments and makes the
   * frame very slightly SLOWER, while removing the discard entirely — which is
   * the only arm that restores early-Z depth WRITE — takes a quarter of the
   * frame off. A fragment that is going to be hidden behind another leaf is
   * being fully shaded before anything finds out.
   *
   * A depth prepass is the textbook answer and it keeps the picture: draw the
   * same instances depth-only first, with the same alpha test, then let the
   * colour pass early-reject against that depth instead of writing its own.
   * `colorWrite: false` and a shared `instanceMatrix` make the prepass almost
   * free on the vertex side, which is the side this frame has spare — the deep
   * station already carries 12 M triangles of trunk for 0.36 ms.
   *
   * The count sync is a measurement shortcut, valid only because a station
   * holds the camera still: in the real thing the culler owns `count` and the
   * prepass mesh would have to be given it every frame.
   */
  {
    name: 'depth prepass on the canopy',
    why: 'CANDIDATE — same picture, early-Z restored for the colour pass',
    apply: `(() => {
      const T = window.RR.THREE, S = window.RR.scene;
      if (!window.__leaf.pre) {
        window.__leaf.pre = window.__leaf.meshes.map((m) => {
          const mat = new T.MeshBasicMaterial({
            map: m.material.map, alphaTest: m.material.alphaTest,
            side: m.material.side, colorWrite: false,
          });
          const p = new T.InstancedMesh(m.geometry, mat, 1);
          p.instanceMatrix = m.instanceMatrix;
          p.frustumCulled = false;
          p.renderOrder = (m.renderOrder ?? 0) - 0.5;
          p.matrixAutoUpdate = false;
          p.matrix.copy(m.matrixWorld);
          p.matrixWorld.copy(m.matrixWorld);
          S.add(p);
          return p;
        });
      }
      window.__leaf.pre.forEach((p, i) => {
        p.visible = window.__leaf.meshes[i].visible;
        p.count = window.__leaf.meshes[i].count;
      });
      for (const m of window.__leaf.mats) { m.depthWrite = false; m.needsUpdate = true; }
    })()`,
    undo: `(() => {
      if (window.__leaf.pre) for (const p of window.__leaf.pre) p.visible = false;
      for (const m of window.__leaf.mats) { m.depthWrite = true; m.needsUpdate = true; }
    })()`,
  },
];

const spec = { station: args.station, level: args.level };
const opts = { batch: Number(args.batch), reps: 1 };

async function armMs(code) {
  await page.evaluate(code);
  // Re-arriving re-settles and burns the upload the material edit just armed,
  // so the first timed batch is not paying for a texture re-upload.
  const r = await page.evaluate(
    async ([s, o]) => {
      const res = await window.__RR_PERF__.scenario(s, o);
      return res.batches;
    },
    [spec, opts]
  );
  return median(r);
}

console.log(`  ${'arm'.padEnd(34)}${'shipping'.padStart(10)}${'arm'.padStart(10)}${'delta'.padStart(10)}`);
console.log(`  ${'-'.repeat(64)}`);

for (const arm of ARMS) {
  const a = [];
  const b = [];
  for (let r = 0; r < REPS; r++) {
    // A-B-B-A: the ordering that cancels a linear drift in GPU clocks.
    a.push(await armMs(arm.undo));
    b.push(await armMs(arm.apply));
    b.push(await armMs(arm.apply));
    a.push(await armMs(arm.undo));
  }
  const ship = median(a);
  const got = median(b);
  const d = got - ship;
  const sign = d < 0 ? '' : '+';
  console.log(
    `  ${arm.name.padEnd(34)}${ship.toFixed(2).padStart(10)}${got.toFixed(2).padStart(10)}${(sign + d.toFixed(2)).padStart(10)}`
  );
  console.log(`  ${''.padEnd(34)}${arm.why}`);
}

await page.evaluate(`window.__leaf.mats.forEach((m, i) => { m.alphaTest = window.__leaf.saved[i].alphaTest; m.side = window.__leaf.saved[i].side; m.needsUpdate = true; });`);
await browser.close();
console.log('\n  negative delta = the arm was FASTER, i.e. that property is what costs.');
