import { chromium } from 'playwright';

/**
 * IS THE WORLD A PURE FUNCTION OF ITS SEED?
 *
 * That is the whole claim now, and it is a different claim from the one this
 * file used to make. It is worth spelling out what changed and why the new
 * question is the better one, because the old test passed for two years and
 * this one will outlive it.
 *
 *
 * WHAT IT USED TO ASSERT, AND WHY THAT STOPPED BEING WORTH ASSERTING.
 *
 * There were two forests: an eager global scatter covering a disc around the
 * origin, and a streamed field forbidden to place anything inside 163.4 m of
 * it. This script defended the disc. It hashed 32 369 instances over their raw
 * matrix and colour bytes against a reference captured on a particular build,
 * and it rendered nine stations behind a per-station fog wall with the streamed
 * meshes switched on and off, demanding not one differing pixel inside the
 * radius.
 *
 * Both halves were sound and both are now meaningless:
 *
 *   The stored hash asserted EQUALITY WITH A PARTICULAR 2026-08-08 LAYOUT. The
 *   world became per-session seeded, so that layout is one world out of
 *   billions and there is nothing special about it. Worse, the hash was a
 *   ratchet on the wrong axis: it made "the near trees did not move" a
 *   pass condition, which is exactly the constraint that was keeping a bald
 *   annulus in the ground.
 *
 *   The fog-wall A/B asserted that the streamed field did not intrude inside
 *   163.4 m. There is no inside now. One sampler covers r = 0 outward, and the
 *   thing the test was policing is the thing that got deleted.
 *
 *
 * WHAT IT ASSERTS INSTEAD. Three properties, none of which needs a reference
 * file, and all of which survive the world changing again.
 *
 *   1. DETERMINISM. Load a seed, settle the streaming ring, hash every instance
 *      in the world. Load the SAME seed in a fresh page and hash again. The two
 *      must be identical. This is what `?seed=` promises and what the
 *      multiplayer invite link depends on — two people in one room must get the
 *      same wood, and nothing about the world travels over the wire, so they
 *      only agree if the generator is a function.
 *
 *   2. VARIATION. Load a DIFFERENT seed and hash again. It must differ. A
 *      determinism test alone is passed perfectly by a generator that ignores
 *      its seed, which is the failure this exists to exclude — and it is not
 *      hypothetical: the grove and biome lattice offsets were fixed constants
 *      until recently, so every world had different hills with the same wood
 *      draped over them.
 *
 *   3. NO BALD RING. Ground-cover instances per square metre, in 20 m bands out
 *      from the camera. No band inside 100 m may fall below 40% of the median
 *      band, which is the shape a ring has and the shape a sparse biome does
 *      not: a needle-litter floor lowers every band together, an annulus
 *      punches one out. This is the user-visible property the protected disc
 *      broke, and a test is the only thing that stops it coming back.
 *
 *
 * THE HASH IS ORDER-INDEPENDENT, AND IT HAS TO BE.
 *
 * The old hash walked the instance buffers in buffer order, which was fine when
 * they were filled once by a single-threaded scatter. Every instance now
 * arrives in a slab span allocated when its sector lands, and sectors land in
 * whatever order two workers finish them — so buffer order is genuinely
 * nondeterministic and hashing it would fail at random. Each instance is hashed
 * on its own bytes and the results are combined with XOR and addition, both
 * commutative; two accumulators rather than one because XOR alone cannot see a
 * duplicated instance and addition alone is weak against transpositions.
 *
 * Layers are keyed by their index in `forest.streamedMeshes`, which is
 * registration order and therefore fixed, rather than by `mesh.name` — twelve
 * meshes are called `trunk`, and lumping them would stop the hash noticing a
 * tree assigned to the wrong archetype.
 *
 *
 * …AND IT ONLY LOOKS AT INSTANCES THAT ARE GUARANTEED TO BE RESIDENT.
 *
 * This is the subtlety that made the first version of the test fail, and it is
 * worth recording because the failure looked exactly like the bug the test is
 * for. At a station reached by WALKING, the two loads reported 55 120 grass
 * against 53 673 — not different grass, a different AMOUNT of it — and the same
 * 1–3% discrepancy in ferns, rocks and mushroom patches.
 *
 * Nothing was nondeterministic. Residency is deliberately hysteretic: a sector
 * is wanted inside the ring and evicted only past 1.5× the ring, so the band
 * between the two holds whatever the player happened to drag along behind him,
 * and whether a particular sector was accepted before or after the camera moved
 * on depends on which of two workers finished first. That band is path- and
 * timing-dependent BY DESIGN and asserting on it would be asserting on the
 * scheduler.
 *
 * Inside the ring there is no such freedom. An instance `d` metres from the
 * camera lies in a sector whose nearest point is at most `d`, so if `d` is
 * inside the ring that sector is wanted, and a settled field holds everything
 * it wants. So the hash is taken over instances within the RING for their grid,
 * with a small margin: 370 m for the two tree layers (384 m ring) and 76 m for
 * everything else (80 m ring). Tens of thousands of instances at every station,
 * every one of them provably obliged to be there.
 *
 *   node scripts/authored-check.mjs [--url=…] [--seed=…] [--other=…]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
/** The identity world, and the one every other pixel-diffing script stands in. */
const SEED = args.seed ?? 'grove-01';
/** Anything else. Named rather than random so a failure is reproducible. */
const OTHER = args.other ?? 'briar-mire-8813';

/**
 * Where the camera stands while the world is hashed.
 *
 * Two of them, and the second is the one that matters. Everything at the spawn
 * point is in the first fill, which is a single code path; a station 300 m out
 * has been reached by walking, so its sectors were queued, built, accepted and
 * some of the first fill's were evicted behind it. A generator that is a
 * function of the seed but not of the seed ALONE — one that let a sector see
 * the order it was built in — would pass at spawn and fail here.
 */
const STATIONS = [
  { name: 'spawn', x: 0, z: 5 },
  { name: 'walked-300m', x: 212, z: -212 },
];

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

/**
 * One load, walked to each station, hashed there.
 *
 * A fresh page per call rather than a `?seed=` swap on a live one, because the
 * seed is read once at module scope and half a dozen modules cache things off
 * it — a swap in place would measure the cache, not the generator.
 */
async function survey(seed) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  /**
   * DEAFEN THE PAGE TO HOT RELOADS BEFORE IT LOADS.
   *
   * Vite pushes HMR updates over a websocket, and a save that lands mid-run
   * re-evaluates modules under a script that is halfway through hashing a
   * world. The failure is silent and total — a reloaded page has no console
   * problems and this script would happily hash whatever came back, then report
   * the two loads as differing and send somebody hunting a determinism bug that
   * is really somebody else's keystroke.
   */
  await page.routeWebSocket(/.*/, () => {});
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${URL}?seed=${encodeURIComponent(seed)}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.RR !== undefined, { timeout: 60000 });
  await page.click('#enter');
  await page.waitForSelector('#gate.gone', { timeout: 40000 }).catch(() => {});

  const out = await page.evaluate(async (stations) => {
    const R = window.RR;
    const frame = () => new Promise((r) => requestAnimationFrame(r));

    /** Both rings quiet for five consecutive frames, or give up and say so. */
    const settle = async (limit = 900) => {
      let quiet = 0;
      for (let i = 0; i < limit && quiet < 5; i++) {
        await frame();
        quiet =
          R.forest.field.pending === 0 && R.forest.groundField.pending === 0 ? quiet + 1 : 0;
      }
      return quiet >= 5;
    };

    /**
     * Walked in hops rather than teleported.
     *
     * Both rings take at most one sector per frame on purpose, so a single jump
     * of 300 m arrives somewhere the ring has never scanned and settles into a
     * DIFFERENT resident set from the one a player walking there would have —
     * which is a real difference between two runs and nothing to do with the
     * generator.
     */
    const walkTo = async (x, z) => {
      const x0 = R.controller.position.x;
      const z0 = R.controller.position.z;
      const steps = Math.max(1, Math.ceil(Math.hypot(x - x0, z - z0) / 60));
      for (let i = 1; i <= steps; i++) {
        R.controller.position.x = x0 + ((x - x0) * i) / steps;
        R.controller.position.z = z0 + ((z - z0) * i) / steps;
        R.controller.velocity.set(0, 0, 0);
        await frame();
        await frame();
      }
      R.controller.position.set(x, R.controller.position.y, z);
      R.controller.velocity.set(0, 0, 0);
      await frame();
      return settle();
    };

    // FNV-1a over the raw IEEE bytes of a float, so two runs that differ by one
    // ulp differ in the hash. `Math.imul` keeps it in int32.
    const scratch = new Float32Array(1);
    const asInt = new Int32Array(scratch.buffer);
    const feed = (a, v) => {
      scratch[0] = v;
      const bits = asInt[0];
      a = Math.imul(a ^ (bits & 255), 16777619);
      a = Math.imul(a ^ ((bits >>> 8) & 255), 16777619);
      a = Math.imul(a ^ ((bits >>> 16) & 255), 16777619);
      return Math.imul(a ^ ((bits >>> 24) & 255), 16777619);
    };

    /** Layers that put something on the GROUND, for the baldness bands. */
    const COVER = new Set([
      'grass', 'ferns', 'meadow', 'bramble', 'bushes', 'saplings',
      'sticks', 'flowers', 'litter', 'reeds', 'stumps',
    ]);
    const BANDS = [0, 20, 40, 60, 80, 100];
    /**
     * How far out an instance is guaranteed to be resident, per grid. See the
     * header: this is each grid's ring less a small margin, and hashing beyond
     * it would be hashing the eviction hysteresis.
     */
    const guaranteed = (name) => (name === 'trunk' || name === 'leaf' ? 370 : 76);

    const measure = (name) => {
      /**
       * Every instance, not the culled set.
       *
       * The buffers otherwise hold whichever buckets faced the camera on the
       * last repack, which is a function of the yaw the walk happened to end
       * on. `restoreAll` puts the whole resident set back, honouring the
       * distance bands so a far trunk is not counted at both resolutions.
       */
      R.forest.culler.restoreAll();
      const px = R.camera.position.x;
      const pz = R.camera.position.z;

      const layers = {};
      let instances = 0;
      const cover = new Array(BANDS.length - 1).fill(0);

      R.forest.streamedMeshes.forEach((mesh, index) => {
        let x1 = 0;
        let x2 = 0;
        let n = 0;
        const m = mesh.instanceMatrix.array;
        const c = mesh.instanceColor ? mesh.instanceColor.array : null;
        const isCover = COVER.has(mesh.name);
        const reach = guaranteed(mesh.name);
        for (let i = 0; i < mesh.count; i++) {
          const d = Math.hypot(m[i * 16 + 12] - px, m[i * 16 + 14] - pz);
          if (isCover) {
            const b = Math.floor(d / 20);
            if (b < cover.length) cover[b]++;
          }
          if (d > reach) continue;
          let a = 2166136261 >>> 0;
          for (let k = 0; k < 16; k++) a = feed(a, m[i * 16 + k]);
          if (c) for (let k = 0; k < 3; k++) a = feed(a, c[i * 3 + k]);
          a >>>= 0;
          // Commutative both ways: order of arrival cannot be seen.
          x1 ^= a;
          x2 = (x2 + a) >>> 0;
          n++;
        }
        if (n === 0) return;
        instances += n;
        layers[`${index}:${mesh.name}`] = `${n}/${(x1 >>> 0).toString(16)}/${x2.toString(16)}`;
      });

      /**
       * The collision world, which no picture can see.
       *
       * A trunk you can walk through looks exactly like a trunk, and the grid is
       * now rebuilt continuously as sectors come and go rather than built once.
       * Hashed the same commutative way, over the same guaranteed-resident
       * radius as the geometry: 76 m, which is the tighter of the two grids and
       * therefore safe for the trunks that come from the wider one.
       */
      let c1 = 0;
      let c2 = 0;
      let colliders = 0;
      for (const cell of R.forest.colliderGrid.cells.values()) {
        for (const o of cell) {
          if (Math.hypot(o.x - px, o.z - pz) > 76) continue;
          let a = 2166136261 >>> 0;
          a = feed(feed(feed(a, o.x), o.z), o.r) >>> 0;
          c1 ^= a;
          c2 = (c2 + a) >>> 0;
          colliders++;
        }
      }

      const area = (b) => Math.PI * (BANDS[b + 1] ** 2 - BANDS[b] ** 2);
      return {
        name,
        at: [+px.toFixed(1), +pz.toFixed(1)],
        instances,
        layers,
        colliders,
        colliderHash: `${(c1 >>> 0).toString(16)}/${c2.toString(16)}`,
        // Patches inside the guaranteed radius, for the same reason: one in
        // the hysteresis band is a coin toss on worker timing.
        patches: R.forest.patches.filter((p) => Math.hypot(p.x - px, p.z - pz) <= 76).length,
        allPatches: R.forest.patches.length,
        nearestPatch: R.forest.patches.length
          ? +Math.min(
              ...R.forest.patches.map((p) => Math.hypot(p.x - px, p.z - pz))
            ).toFixed(1)
          : null,
        bands: BANDS,
        coverPerM2: cover.map((n, b) => +(n / area(b)).toFixed(4)),
        growths: JSON.parse(JSON.stringify(R.forest.growths)),
      };
    };

    const settled = await settle();
    const results = [];
    for (const s of stations) {
      const ok = s.x === 0 && s.z === 5 ? true : await walkTo(s.x, s.z);
      if (s.x === 0 && s.z === 5) {
        R.controller.position.set(s.x, R.controller.position.y, s.z);
        R.controller.velocity.set(0, 0, 0);
        await frame();
      }
      R.forest.cull(R.camera, true);
      results.push({ ...measure(s.name), settled: ok });
    }
    return { firstFillSettled: settled, stations: results, seed: R.seed ?? null };
  }, STATIONS);

  await page.close();
  return { ...out, errors };
}

const a = await survey(SEED);
const b = await survey(SEED);
const c = await survey(OTHER);
await browser.close();

let bad = 0;
const fail = (msg) => {
  bad++;
  console.log(`FAIL: ${msg}`);
};

console.log(`\nseed "${SEED}" loaded twice, seed "${OTHER}" once\n`);
for (const run of [a, b, c]) {
  if (run.errors.length) fail(`page errors: ${run.errors.slice(0, 3).join(' | ')}`);
  if (!run.firstFillSettled) fail('the first fill never settled inside 900 frames');
}

for (let i = 0; i < STATIONS.length; i++) {
  const A = a.stations[i];
  const B = b.stations[i];
  const C = c.stations[i];
  console.log(
    `${A.name.padEnd(13)} @(${A.at[0]}, ${A.at[1]})  ` +
      `${String(A.instances).padStart(7)} guaranteed-resident instances  ` +
      `${String(A.colliders).padStart(5)} colliders  ` +
      `${A.allPatches} shroom patches in the ring (nearest ${A.nearestPatch} m)`
  );

  // ---- 1. determinism -----------------------------------------------------
  const layerKeys = [...new Set([...Object.keys(A.layers), ...Object.keys(B.layers)])].sort();
  const moved = layerKeys.filter((k) => A.layers[k] !== B.layers[k]);
  if (moved.length) {
    fail(
      `${A.name}: ${moved.length} layer(s) differ between two loads of "${SEED}" — ` +
        moved
          .slice(0, 4)
          .map((k) => `${k} ${A.layers[k] ?? '(absent)'} vs ${B.layers[k] ?? '(absent)'}`)
          .join('; ')
    );
  } else {
    console.log(`  ok   identical across two loads: ${layerKeys.length} layers, ${A.instances} instances`);
  }
  if (A.colliderHash !== B.colliderHash) {
    fail(`${A.name}: the collision world differs between two loads (${A.colliders} vs ${B.colliders} entries)`);
  } else {
    console.log(`  ok   collision world identical: ${A.colliders} entries, hash ${A.colliderHash}`);
  }
  if (A.patches !== B.patches) {
    fail(`${A.name}: ${A.patches} mushroom patches inside 76 m vs ${B.patches}`);
  }
  if (A.allPatches === 0) fail(`${A.name}: no mushroom patches anywhere in the ring`);

  // ---- 2. variation -------------------------------------------------------
  const same = layerKeys.filter((k) => A.layers[k] && A.layers[k] === C.layers[k]);
  if (same.length) {
    fail(
      `${A.name}: ${same.length} layer(s) are IDENTICAL under seed "${OTHER}" — ` +
        `the generator is ignoring part of its seed (${same.slice(0, 4).join(', ')})`
    );
  } else {
    console.log(`  ok   seed "${OTHER}" produces a different world at every layer`);
  }

  // ---- 3. no bald ring ----------------------------------------------------
  /**
   * A ring is one band far below its neighbours; a sparse biome is every band
   * low together. So the test is relative to the station's own median, with an
   * absolute floor underneath it to catch a station that has nothing anywhere.
   */
  const bandsLine = A.coverPerM2
    .map((v, k) => `${A.bands[k]}-${A.bands[k + 1]}:${v.toFixed(2)}`)
    .join('  ');
  const sorted = [...A.coverPerM2].sort((p, q) => p - q);
  const median = sorted[sorted.length >> 1];
  const worst = Math.min(...A.coverPerM2);
  const worstBand = A.coverPerM2.indexOf(worst);
  console.log(`  cover/m² ${bandsLine}`);
  if (worst < 0.15) {
    fail(
      `${A.name}: ${A.bands[worstBand]}-${A.bands[worstBand + 1]} m holds ` +
        `${worst.toFixed(3)} ground-cover instances per m² — that band is bare`
    );
  } else if (worst < median * 0.4) {
    fail(
      `${A.name}: ${A.bands[worstBand]}-${A.bands[worstBand + 1]} m is ` +
        `${(worst / median).toFixed(2)}× the median band (${median.toFixed(2)}/m²) — that is a ring`
    );
  } else {
    console.log(`  ok   no band inside 100 m below 40% of the median (${median.toFixed(2)}/m²)`);
  }

  for (const [layer, n] of Object.entries(A.growths)) {
    fail(`${A.name}: slab "${layer}" reallocated ${n}× — its capacity in forest.js is too small`);
  }
  if (!A.settled) fail(`${A.name}: the ring never settled after walking there`);
}

console.log(
  bad
    ? `\nDETERMINISM CHECK FAILED (${bad} problem${bad === 1 ? '' : 's'})`
    : '\nPASS: same seed, same wood; different seed, different wood; no bald band'
);
process.exit(bad ? 1 : 0);
