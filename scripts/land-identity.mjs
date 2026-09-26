/**
 * THE LAND LAYER'S REGRESSION GATE, AND IT NEEDS NO BROWSER AT ALL.
 *
 * `src/world/lands/` moved roughly eight hundred lines of placement rules out of
 * `scatter.js` and into a per-land descriptor. That is the largest purely
 * mechanical edit this project has taken, and the failure mode of getting one
 * character wrong in it is not an error — it is a forest that is subtly not the
 * forest, in a way no screenshot taken from one station would show and every
 * stored expectation in `scripts/` would blame on the renderer.
 *
 * So: hash the scatter. Nine 128 m tree sectors and twenty-five 64 m understorey
 * sectors around the origin, digesting every instance matrix, every tint, every
 * bounding sphere and every collider, in layer order. That covers ~640 m of tree
 * grid and ~320 m of undergrowth grid — every layer, every species, the stream,
 * the clearing and the gathering places.
 *
 *
 * ==== WHY THIS IS A DIFFERENT INSTRUMENT FROM authored-check ===============
 *
 * `authored-check.mjs` drives the real page and compares two SEEDS to prove the
 * world varies. This proves the opposite thing about one seed: that the world
 * did not move. It also runs in about two hundred milliseconds of pure node with
 * no dev server, no GL context and no browser, which matters because it is the
 * gate you want to run after every single edit to a land file rather than once
 * before a commit.
 *
 * IT IS NOT A SUBSTITUTE FOR THE PIXEL GATES. It hashes what the scatter
 * decided, not what was drawn — geometry, materials, textures, culling and the
 * whole render path are invisible to it. `cull-check` and `shoot` still own
 * those.
 *
 *
 * ==== THE BOUNDS ARE FAKE AND THAT IS SOUND ================================
 *
 * A real `bounds` table comes from geometry measured on the main thread, which
 * needs a canvas. Every bound here is a unit sphere instead, and the reason that
 * is legitimate rather than a shortcut is that the scatter only ever multiplies
 * a bound by a scale it has already drawn — it never branches on one. So a fake
 * bound changes the radii in the digest by a constant factor and cannot change a
 * single draw, a single acceptance or a single position. The one thing it DOES
 * exercise, and the thing that matters most here, is which layer ids exist: a
 * land drops a layer by not having a `bounds` entry for it, so the table is
 * built from `land.layers` exactly the way forest.js builds the real one.
 *
 * Usage:
 *   node scripts/land-identity.mjs            check every land against its pin
 *   node scripts/land-identity.mjs --record   re-pin (only when a change is
 *                                             intended, and say so in the diff)
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// `fileURLToPath`, not a hand-rolled strip: this repo lives under a path with a
// space in it, and a URL pathname is percent-encoded. Rolling it by hand gives
// `bing%20bong` and a module-not-found that names the right file.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const u = (p) => pathToFileURL(path.join(ROOT, p)).href;

const { treeSector, underSector, character } = await import(u('src/world/scatter.js'));
const { setWorldSeed } = await import(u('src/world/terrain.js'));
const { currentLand, LAND_LIST } = await import(u('src/world/lands/index.js'));
/**
 * THE REAL SPECIES LIST, IMPORTED RATHER THAN RESTATED.
 *
 * This used to be `const AVAILABLE = ['palm','cecropia','kapok','fig',
 * 'brownea']` with a comment saying the taiga's conifers were "a pending patch
 * to trees.js". They landed; the comment did not move; and for as long as it
 * did not, this gate was hashing a taiga made of palm trees. `grown` came out
 * empty, the fallback below used the rainforest's five, `treeSector`'s
 * substitution guard folded spruce, fir and larch all onto `palm` — so three of
 * the taiga's five species merged into one layer and a change to the
 * spruce/fir threshold produced a bit-identical hash. The gate said "ok" about
 * a world nobody could visit.
 *
 * `src/world/species-names.js` is a leaf module of strings with no imports and
 * no side effects, extracted for exactly this: `trees.js` cannot be imported
 * here because it pulls in `textures.js` and a `<canvas>` node does not have.
 */
const { SPECIES_NAMES } = await import(u('src/world/species-names.js'));

const PIN = path.join(ROOT, '.perf', 'land-identity.json');
const record = process.argv.includes('--record');

/**
 * One seed per land, and the rainforest's is `grove-01` on purpose.
 *
 * That string normalises to seed 0, which is the identity world every stored
 * reference in this repo was captured in — see `normalizeSeed`. A land layer
 * that moved the rainforest by a bit would move `.perf/baseline.json`'s nine
 * scenarios, `terrain-survey`'s height hash and every frame in `shoot.mjs` at
 * once, and none of them would say why.
 */
const CASES = LAND_LIST.map((l) => ({
  land: l.id,
  seed: l.id === 'rainforest' ? 'grove-01' : `${l.id}:grove-01`,
}));

function run(seed) {
  setWorldSeed(seed);
  const land = currentLand();

  const bounds = {};
  for (const id of land.layers) {
    if (id === 'rocks') for (let g = 0; g < 4; g++) bounds[`rocks:${g}`] = { cy: 0.5, r: 1 };
    else bounds[id] = { cy: 0.5, r: 1 };
  }
  /**
   * The same two lines `forest.js` runs, deliberately character for character —
   * `land.roster.filter(n => SPECIES_NAMES.includes(n))` and a fallback to the
   * whole table when a land's roster and `SPECIES` do not overlap at all. If
   * these two ever disagree the gate is hashing a wood the app does not build,
   * which is the failure this file just spent a release in.
   */
  const grown = land.roster.filter((n) => SPECIES_NAMES.includes(n));
  const use = grown.length ? grown : SPECIES_NAMES;
  const tints = {};
  for (const n of use) {
    tints[n] = [[0x336633], [0x224422], [0x445533]];
    for (let a = 0; a < 3; a++) {
      bounds[`trunk:${n}:${a}`] = { cy: 8, r: 9 };
      bounds[`leaf:${n}:${a}`] = { cy: 8, r: 9 };
    }
  }

  const h = createHash('md5');
  const counts = {};
  const arr = (a) => Buffer.from(new Float64Array(a).buffer);
  const feed = (b) => {
    for (const k of [...b.layers.keys()].sort()) {
      const L = b.layers.get(k);
      h.update(k);
      h.update(arr(L.matrix));
      h.update(arr(L.color));
      h.update(arr(L.cx));
      h.update(arr(L.cy));
      h.update(arr(L.cz));
      h.update(arr(L.r));
      counts[k] = (counts[k] || 0) + L.length;
    }
    h.update(arr(b.collide));
    h.update(arr(b.rustle));
    h.update(arr(b.patches));
    h.update(arr(b.glow));
  };

  for (let sx = -1; sx <= 1; sx++)
    for (let sz = -1; sz <= 1; sz++)
      feed(treeSector({ seed, sx, sz, size: 128, archetypes: 3, bounds, tints }));
  for (let sx = -2; sx <= 2; sx++)
    for (let sz = -2; sz <= 2; sz++)
      feed(underSector({ seed, sx, sz, size: 64, bounds, rockSizes: 4 }));

  /**
   * And the biome coverage, because a hash cannot tell you that a weight is
   * broken — only that it is the same as it was. Two weights in this project's
   * history have operated on under a tenth of the ground and nothing reported
   * either of them: a biome that rare is a biome nobody has ever seen, and the
   * layer keyed to it looks exactly like a layer that works.
   */
  const cover = {};
  for (const k of land.weights) cover[k] = 0;
  let n = 0;
  let canopy = 0;
  for (let x = -1500; x < 1500; x += 24)
    for (let z = -1500; z < 1500; z += 24) {
      const c = character(x, z);
      for (const k of land.weights) if (c[k] > 0.25) cover[k]++;
      canopy += c.canopy;
      n++;
    }

  return {
    hash: h.digest('hex').slice(0, 12),
    instances: Object.values(counts).reduce((a, b) => a + b, 0),
    layers: Object.keys(counts).length,
    canopy: +(canopy / n).toFixed(4),
    cover: Object.fromEntries(land.weights.map((k) => [k, +((cover[k] / n) * 100).toFixed(1)])),
    counts,
  };
}

const now = {};
for (const c of CASES) now[c.land] = run(c.seed);

const pin = existsSync(PIN) ? JSON.parse(readFileSync(PIN, 'utf8')) : null;

console.log('land identity — scatter digests, no browser\n');
let fail = false;
for (const c of CASES) {
  const r = now[c.land];
  const was = pin?.[c.land];
  const same = was && was.hash === r.hash;
  const mark = !was ? 'NEW ' : same ? 'ok  ' : 'MOVED';
  console.log(
    `${mark} ${c.land.padEnd(11)} seed ${c.seed.padEnd(18)} ${r.hash}` +
      (was && !same ? `  (was ${was.hash})` : '')
  );
  console.log(
    `     ${r.instances} instances over ${r.layers} layers, mean canopy ${r.canopy}`
  );
  console.log(
    '     ' + Object.entries(r.cover).map(([k, v]) => `${k} ${v}%`).join('  ')
  );
  /**
   * A WEIGHT UNDER 5% IS A WARNING RATHER THAN A FAILURE, because `damp` and
   * `wet` are legitimately ribbons — `wetness()` is the distance to the stream
   * channel and returns 0 over 99% of the world, which is a correct answer to
   * "may a tree grow here". Everything else on that list is meant to be a place.
   */
  for (const [k, v] of Object.entries(r.cover)) {
    if (v < 5 && k !== 'damp' && k !== 'wet') {
      console.log(`     WARN: \`${k}\` reaches ${v}% of the ground. See the litter block in rainforest.js.`);
    }
  }
  /**
   * `--layers` PRINTS THE PER-LAYER COUNTS, and it exists because of the one
   * question this gate could not answer about its own failure.
   *
   * When a land moves, the header line says the hash changed and the line under
   * it says the layer count went 52 to 50 — and there was no way to find out
   * WHICH TWO, short of editing the script. Two layers vanishing is either a
   * species that no longer places anywhere (a real regression, and a silent
   * one, since the world simply has less in it) or a species that merged into
   * another (which is what the stale `AVAILABLE` list was doing to the taiga's
   * conifers for a day). Those two want opposite responses and the summary
   * cannot tell them apart.
   *
   * Diagnostic, not a gate: it changes no exit code and prints nothing unless
   * asked. Run it on the tree and on a copy of the last-pinned tree, and diff.
   */
  if (process.argv.includes('--layers')) {
    const keys = Object.keys(r.counts).sort();
    console.log(`     ${keys.length} layers:`);
    for (const k of keys) console.log(`       ${k.padEnd(28)} ${String(r.counts[k]).padStart(7)}`);
  }
  if (was && !same) fail = true;
  console.log('');
}

if (record) {
  const out = {};
  for (const c of CASES) {
    const { counts, ...rest } = now[c.land];
    out[c.land] = { seed: c.seed, ...rest };
  }
  writeFileSync(PIN, JSON.stringify(out, null, 2) + '\n');
  console.log(`recorded ${PIN}`);
  process.exit(0);
}

if (!pin) {
  console.log('No pin on file. Run with --record once the world is where you want it.');
  process.exit(0);
}
if (fail) {
  console.log('FAIL: a land moved. If that was intended, re-record and say so in the diff.');
  process.exit(1);
}
console.log('PASS: every land is where it was pinned.');
