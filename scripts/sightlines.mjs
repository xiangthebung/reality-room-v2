import { chromium } from 'playwright';

/**
 * HOW FAR CAN YOU SEE, AT EACH HEIGHT.
 *
 *   node scripts/sightlines.mjs [--station=wood] [--rays=96] [--json=.perf/sight.json]
 *                               [--vs=.perf/sight-before.json]
 *
 * WHY THIS EXISTS. "The forest looks empty" and "the mid-storey is missing" are
 * the two complaints this world keeps getting, and both have been argued about
 * from screenshots. A screenshot cannot settle it, because the thing being
 * claimed is a statement about a VOLUME — how much stuff stands between 2 and
 * 12 m off the ground — and a picture of it is one projection through that
 * volume, taken at whatever moment the streamer happened to be in.
 *
 * A colonnade and a jungle are distinguishable by one number: how far you can
 * see horizontally before something stops you, sampled at several heights. In a
 * plantation the sight line at 6 m is enormous and the sight line at 0.5 m is
 * short, because all the material is on the floor and in the roof with nothing
 * in between. In a rainforest the curve is flat — you are stopped at every
 * height. That ratio, not the absolute distance, is the thing to steer on: a
 * world can be dense and still read as a colonnade.
 *
 * Rays are cast against the live scene graph, so this counts exactly what the
 * renderer would draw, including instanced streamed geometry, and it is immune
 * to the framing and time-of-day that make screenshots incomparable.
 *
 * THREE TRAPS THIS DEFENDS AGAINST:
 *
 *   - THE WOOD HAS NOT ARRIVED. Both rings build one sector per frame, so
 *     raycasting straight after a teleport measures whatever fraction exists.
 *     It settles on the streamer's own queues before casting, and says so.
 *   - INSTANCED MESHES ARE NOT FRUSTUM-CULLED HERE, THEY ARE COUNT-CULLED. The
 *     culler drops `mesh.count` to the visible buckets and packs those to the
 *     front of the buffer. A raycast therefore only sees what the culler last
 *     wrote, which is the set visible from the CAMERA — not from a ray facing
 *     the other way. So the camera is spun to face each ray batch and the
 *     culler is re-run, rather than casting 360 degrees from one packing.
 *   - AND THE CACHED BOUNDING SPHERE HAS TO BE THROWN AWAY WITH IT, which this
 *     script did not do and which silently deleted an entire class of layer
 *     from every number it has ever printed. `InstancedMesh.raycast` rejects on
 *     `this.boundingSphere` before it touches a single instance, and that
 *     sphere is computed ONCE, lazily, on the first cast — from whatever the
 *     slab happened to hold at that moment. Nothing invalidates it, because
 *     nothing else reads it: `packSlab` sets `frustumCulled = false`, so the
 *     renderer never consults it and the world draws correctly regardless.
 *     The consequence for THIS script was total and looked like a result: the
 *     tree layers survived because their sphere is a 384 m ring that contains
 *     wherever you teleported to, and every streamed understorey layer — all
 *     nine of the original ones plus the mid-storey — was rejected outright at
 *     every station. That is why the `under` column of every table this script
 *     has printed reads 0%, at every height, in every world, including at 0.6 m
 *     standing in waist-high grass. It is not that undergrowth stops no rays;
 *     it is that undergrowth was never in the target set.
 *     Measured on the palms layer alone at the wood station: 0 hits of 48 rays
 *     at 10 m with the stale sphere, 11 of 48 after one `computeBoundingSphere`.
 *   - A RAY THAT HITS NOTHING IS NOT A MISSING NUMBER. Unbounded rays are
 *     recorded at the cap and counted separately, because a median that
 *     silently drops them reports a dense wood when half the rays flew to the
 *     horizon.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const URL = args.url ?? 'http://127.0.0.1:5180/';
const RAYS = Number(args.rays ?? 96);
const CAP = Number(args.cap ?? 120);

const STATIONS = {
  clearing: { x: 0, z: 8 },
  wood: { x: -34, z: -46 },
  ridge: { x: 400, z: -96 },
  glade: { x: 706, z: 212 },
  far: { x: -812, z: 344 },
};
const ONLY = args.station ?? null;

/** The bands the complaint is about. Floor and roof are the controls. */
const HEIGHTS = [0.6, 2, 4, 6, 8, 12, 18];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.routeWebSocket(/.*/, () => {});
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2500);

async function measure(at) {
  return page.evaluate(
    async ({ at: s, rays, cap, heights }) => {
      const R = window.RR;
      const THREE = R.THREE;
      const raf = () => new Promise((r) => requestAnimationFrame(r));

      R.controller.position.x = s.x;
      R.controller.position.z = s.z;
      R.controller.position.y = -1e4;
      R.controller.velocity.set(0, 0, 0);
      R.controller.applyToCamera();

      let settled = false;
      for (let i = 0; i < 500; i++) {
        await raf();
        const pending = (R.forest?.field?.pending ?? 0) + (R.forest?.groundField?.pending ?? 0);
        if (i > 120 && pending === 0) {
          settled = true;
          break;
        }
      }

      const foot = R.controller.position.y;
      const rc = new THREE.Raycaster();
      rc.far = cap;
      // The ground is deliberately in the target set: a ray at 2 m over a
      // downhill slope SHOULD be stopped by the hillside, and pretending
      // otherwise would report open sight lines across a valley as forest.
      const targets = [];
      if (R.forest?.group) targets.push(R.forest.group);
      if (R.forest?.groundField?.group) targets.push(R.forest.groundField.group);

      const out = {};
      const origin = new THREE.Vector3();
      const dir = new THREE.Vector3();

      /**
       * WHAT STOPPED THE RAY MATTERS MORE THAN WHETHER ONE DID.
       *
       * The first version of this reported that the wood is already blocked at
       * every height — 77% of rays stopped within 25 m at 0.6 m and 69% at 6 m,
       * a mid-storey "openness" of 1.1x the floor — while the screenshots
       * plainly showed bare poles with nothing between them. Both were right.
       * A ray is stopped by a TRUNK, and a trunk is a thin vertical line that
       * the eye sees straight past: it occludes a ray and almost none of the
       * visual field. Counting hits therefore answered a question nobody asked.
       *
       * The complaint is about MATERIAL, not occlusion — the band is full of
       * wood and empty of leaf. So each hit is classified by the layer it
       * landed on, and the number to steer on is the foliage share at 2-12 m.
       */
      const classify = (o) => {
        for (let n = o; n; n = n.parent) {
          const id = n.name || '';
          if (/leaf|frond|palm|bromel|vine|liana|epi/i.test(id)) return 'foliage';
          if (/trunk/i.test(id)) return 'trunk';
          if (/grass|fern|bramble|meadow|bush|sapling|reed|flower|litter/i.test(id)) return 'under';
          if (/ground|terrain|chunk/i.test(id)) return 'ground';
        }
        return 'other';
      };

      for (const h of heights) {
        const hits = [];
        const kind = { foliage: 0, trunk: 0, under: 0, ground: 0, other: 0 };
        let escaped = 0;
        for (let i = 0; i < rays; i++) {
          const a = (i / rays) * Math.PI * 2;
          // Face the ray and re-pack: the culler writes the set visible from
          // the CAMERA, so a ray cast behind the camera would find an empty
          // buffer and report open sky.
          R.controller.yaw = -a;
          R.controller.pitch = 0;
          R.controller.applyToCamera();
          R.forest?.cull?.(R.camera, true);
          // The repack just moved every instance in every slab. Drop the
          // cached spheres so `InstancedMesh.raycast` recomputes them from what
          // is actually in the buffer now — see the third trap in the header.
          for (const t of targets) {
            t.traverse((o) => {
              if (o.isInstancedMesh) o.boundingSphere = null;
            });
          }

          origin.set(s.x, foot + h, s.z);
          dir.set(-Math.sin(a), 0, -Math.cos(a));
          rc.set(origin, dir);
          const hit = rc.intersectObjects(targets, true);
          if (hit.length) {
            hits.push(hit[0].distance);
            kind[classify(hit[0].object)]++;
          } else {
            hits.push(cap);
            escaped++;
          }
        }
        hits.sort((x, y) => x - y);
        const landed = hits.length - escaped;
        out[h] = {
          median: hits[Math.floor(hits.length / 2)],
          p25: hits[Math.floor(hits.length * 0.25)],
          // "Blocked within 25 m" is the honest reading of "you cannot see out".
          blocked25: hits.filter((d) => d < 25).length / hits.length,
          escaped: escaped / hits.length,
          kind,
          // The steering number: of the rays that hit anything, how many were
          // stopped by something with leaves on it rather than by a bare pole.
          foliage: landed ? kind.foliage / landed : 0,
        };
      }
      return { settled, foot, bands: out };
    },
    { at, rays: RAYS, cap: CAP, heights: HEIGHTS }
  );
}

const all = {};
console.log(`Horizontal sight lines, ${RAYS} rays per height, capped at ${CAP} m\n`);
for (const [name, at] of Object.entries(STATIONS)) {
  if (ONLY && !name.includes(ONLY)) continue;
  const r = await measure(at);
  all[name] = r;
  console.log(`${name}${r.settled ? '' : '  (UNSETTLED — numbers not trustworthy)'}`);
  console.log('  height   median   p25   blocked<25m   escaped   foliage   trunk   under');
  for (const h of HEIGHTS) {
    const b = r.bands[h];
    const landed = Object.values(b.kind).reduce((s, v) => s + v, 0);
    const pct = (n) => `${((n / Math.max(1, landed)) * 100).toFixed(0)}%`.padStart(7);
    console.log(
      `  ${String(h).padStart(5)} m ${b.median.toFixed(1).padStart(7)} ${b.p25.toFixed(1).padStart(6)}` +
        `   ${(b.blocked25 * 100).toFixed(0).padStart(9)}%   ${(b.escaped * 100).toFixed(0).padStart(6)}%` +
        `  ${pct(b.kind.foliage)} ${pct(b.kind.trunk)} ${pct(b.kind.under)}`
    );
  }
  /**
   * THE VERDICT LINE. Not openness — the first version of this script steered
   * on the sight-line ratio and it said the wood was fine while the pictures
   * said it was a colonnade, because a bare pole stops a ray and not an eye.
   * What separates a plantation from a jungle is the FOLIAGE SHARE in the
   * 2-12 m band: the fraction of rays stopped by something with leaves on it
   * rather than by wood.
   */
  const bandFoliage =
    [2, 4, 6, 8, 12].reduce((s, h) => s + r.bands[h].foliage, 0) / 5;
  console.log(`  mid-storey foliage share (2-12 m): ${(bandFoliage * 100).toFixed(0)}%\n`);
}

if (args.vs) {
  const { readFileSync } = await import('node:fs');
  const before = JSON.parse(readFileSync(args.vs, 'utf8'));
  console.log('vs baseline (median sight line, metres):');
  console.log('station     ' + HEIGHTS.map((h) => `${h}m`.padStart(7)).join(''));
  for (const [name, r] of Object.entries(all)) {
    const b = before[name];
    if (!b) continue;
    const row = HEIGHTS.map((h) => {
      const d = r.bands[h].median - b.bands[h].median;
      return `${d >= 0 ? '+' : ''}${d.toFixed(0)}`.padStart(7);
    }).join('');
    console.log(name.padEnd(12) + row);
  }
}

if (args.json) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(args.json), { recursive: true });
  writeFileSync(args.json, JSON.stringify(all, null, 2));
  console.log(`\nwrote ${args.json}`);
}

await browser.close();
