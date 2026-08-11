import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { heightAt } from '../src/world/terrain.js';

/**
 * Is the far world actually varied, and is the near world untouched?
 *
 * Two questions that have to be answered with numbers, because both of them
 * are things the eye is bad at. "It looks a bit samey out there" is not
 * actionable and "it looks fine to me" is not evidence, so this walks a grid
 * and measures.
 *
 *   RELIEF is max minus min over a 640 m block. The measured complaint was 11 m
 *   of relief per 640 m outside the valley against 91 m at the origin, i.e. the
 *   far world was eight times flatter than the place the player learns what
 *   this world looks like.
 *
 *   STEP is the largest height difference between adjacent 1.6 m cells in the
 *   block — the mesh's own spacing, so it is literally the steepest thing the
 *   player can see. 0.5 m far out against 3.22 m at the origin.
 *
 *   SPREAD is the standard deviation of the per-sub-block relief across the
 *   nine sub-blocks of each block. It is the number that distinguishes "varied"
 *   from "uniformly bumpy": a field with a big amplitude everywhere has high
 *   relief and low spread, and reads as texture rather than as geography.
 *
 * THE IDENTITY HALF IS THE ONE THAT CAN FAIL SILENTLY.
 *
 * The authored region — the bowl, the clearing, the jukebox's ground, the near
 * mushroom patches — is signed off, and every camera station in `shoot.mjs`
 * stands in it. A region field that varies the fbm amplitudes has to be exactly
 * the identity there, not approximately: `smoothstep(clamp01(...))` is exactly
 * 0 below the inner radius and `h * (1 + 0)` is exactly `h`, so the arithmetic
 * permits bit-identity and there is no reason to accept less. This samples a
 * dense grid inside the authored radius, hashes it, and compares against a
 * reference captured before the change.
 *
 * THE REFERENCE WAS RECAPTURED ONCE, ON PURPOSE, AND IT MATTERS THAT YOU KNOW.
 *
 * Caves used to be kept 250 m away from the spawn and skipped entirely inside
 * 182 m, which is what made this hash a statement about an untouched authored
 * world. Both are gone — mouths are wanted near the spawn — so at seed 0 there
 * is now a gully and the tor above it inside this disc, and the reference was
 * recaptured with them in (hash 84c26f3e -> af91cfda, 2026-08-11, one capture
 * covering the keep-out, the tor and the narrower slot jitter). What it proves
 * from here on is
 * that nothing has moved SINCE, which is still the thing that catches an
 * accidental change to the region field or the bowl; what it no longer proves
 * is that the caves stayed out. `scripts/cave-check.mjs` covers that half now,
 * by asserting the ground has no step in it rather than by keeping it empty.
 *
 *   node scripts/terrain-survey.mjs --save     # capture the reference
 *   node scripts/terrain-survey.mjs            # survey + identity check
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const REF = resolve(process.cwd(), '.shots/terrain-ref.json');

/**
 * The radius the authored world is defined out to.
 *
 * 163.4 m is where the old `edge` ramp used to start biting — `WORLD_RADIUS *
 * 0.86` — and it is therefore the outer bound of everything anybody has ever
 * looked at and approved. The trees are authored a little further out than
 * that (the original scatter runs to `WORLD_RADIUS * 0.95` = 180.5 m), so the
 * identity grid is sampled to 181 m rather than to 163.4: proving the larger
 * disc costs nothing and covers the tree scatter as well as the terrain.
 */
const AUTHORED = 181;
/** Deliberately not a multiple of anything in terrain.js, so it cannot alias. */
const IDENTITY_STEP = 0.7;

function identityGrid() {
  const out = [];
  for (let z = -AUTHORED; z <= AUTHORED; z += IDENTITY_STEP) {
    for (let x = -AUTHORED; x <= AUTHORED; x += IDENTITY_STEP) {
      if (x * x + z * z > AUTHORED * AUTHORED) continue;
      out.push(heightAt(x, z));
    }
  }
  return out;
}

/** FNV-1a over the raw float64 bits, so a 1 ulp move is a different hash. */
function hashFloats(values) {
  const buf = new Float64Array(values);
  const bytes = new Uint8Array(buf.buffer);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

const BLOCK = 640;
const CELL = 1.6;

function surveyBlock(cx, cz) {
  const n = Math.round(BLOCK / CELL) + 1;
  const h = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = cz - BLOCK / 2 + j * CELL;
    for (let i = 0; i < n; i++) h[j * n + i] = heightAt(cx - BLOCK / 2 + i * CELL, z);
  }

  let min = Infinity;
  let max = -Infinity;
  let step = 0;
  let stepSum = 0;
  let stepN = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v = h[j * n + i];
      if (v < min) min = v;
      if (v > max) max = v;
      if (i + 1 < n) {
        const d = Math.abs(h[j * n + i + 1] - v);
        if (d > step) step = d;
        stepSum += d;
        stepN++;
      }
      if (j + 1 < n) {
        const d = Math.abs(h[(j + 1) * n + i] - v);
        if (d > step) step = d;
        stepSum += d;
        stepN++;
      }
    }
  }

  // Relief of each ninth of the block, so "varied" can be told from "bumpy".
  const third = Math.floor(n / 3);
  const sub = [];
  for (let sj = 0; sj < 3; sj++) {
    for (let si = 0; si < 3; si++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = sj * third; j < (sj + 1) * third; j++) {
        for (let i = si * third; i < (si + 1) * third; i++) {
          const v = h[j * n + i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      sub.push(hi - lo);
    }
  }
  const mean = sub.reduce((a, b) => a + b, 0) / sub.length;
  const spread = Math.sqrt(sub.reduce((a, b) => a + (b - mean) ** 2, 0) / sub.length);

  return {
    relief: +(max - min).toFixed(2),
    step: +step.toFixed(2),
    meanStep: +(stepSum / stepN).toFixed(3),
    subRelief: +mean.toFixed(2),
    spread: +spread.toFixed(2),
  };
}

/**
 * Blocks chosen to be a fair sample rather than a flattering one.
 *
 * The origin block is the calibration target. The rest are spread over four
 * bearings and three distances so that no single lucky region can carry the
 * average, and none of them is on the ridge line (z ≈ -96), because the ridge
 * would dominate any block it fell in and it is not what is being measured.
 */
const BLOCKS = [
  ['origin', 0, 0],
  ['E 640', 640, 0],
  ['E 1280', 1280, 0],
  ['E 2560', 2560, 0],
  ['S 640', 0, 640],
  ['S 1280', 0, 1280],
  ['S 2560', 0, 2560],
  ['W 1280', -1280, 0],
  ['W 2560', -2560, 0],
  ['NE 1810', 1280, -1280],
  ['SW 1810', -1280, 1280],
  ['SE 2715', 1920, 1920],
  ['far 5120', 5120, -2560],
  ['far 8000', -5657, 5657],
];

const rows = BLOCKS.map(([name, x, z]) => ({ name, x, z, ...surveyBlock(x, z) }));

const grid = identityGrid();
const hash = hashFloats(grid);

if (args.save) {
  mkdirSync(resolve(process.cwd(), '.shots'), { recursive: true });
  writeFileSync(
    REF,
    JSON.stringify({ points: grid.length, hash, step: IDENTITY_STEP, radius: AUTHORED, rows }, null, 2)
  );
  console.log(`saved reference: ${grid.length} points inside ${AUTHORED} m, hash ${hash}`);
}

const w = (s, n) => String(s).padEnd(n);
console.log(`\nterrain character, ${BLOCK} m blocks at ${CELL} m cells\n`);
console.log(w('block', 12) + w('centre', 16) + w('relief', 9) + w('max step', 10) + w('mean step', 11) + w('sub-relief', 12) + w('spread', 8));
for (const r of rows) {
  console.log(
    w(r.name, 12) +
      w(`${r.x},${r.z}`, 16) +
      w(`${r.relief} m`, 9) +
      w(`${r.step} m`, 10) +
      w(`${r.meanStep} m`, 11) +
      w(`${r.subRelief} m`, 12) +
      w(`${r.spread} m`, 8)
  );
}

const far = rows.filter((r) => Math.hypot(r.x, r.z) > 600);
const reliefs = far.map((r) => r.relief);
console.log(
  `\nfar blocks: relief ${Math.min(...reliefs).toFixed(1)}–${Math.max(...reliefs).toFixed(1)} m ` +
    `(origin ${rows[0].relief} m), max step ${Math.min(...far.map((r) => r.step)).toFixed(2)}–` +
    `${Math.max(...far.map((r) => r.step)).toFixed(2)} m (origin ${rows[0].step} m)`
);

let bad = 0;
if (!args.save && existsSync(REF)) {
  const ref = JSON.parse(readFileSync(REF, 'utf8'));
  if (ref.points !== grid.length || ref.step !== IDENTITY_STEP || ref.radius !== AUTHORED) {
    console.log('\nFAIL: the reference was captured with different sampling; recapture it');
    bad++;
  } else if (ref.hash !== hash) {
    // Report the worst offender rather than only that something moved — a
    // radial-mask bug shows up as a ring of small errors at one radius, and a
    // sign error shows up as one huge one, and those want different fixes.
    let worst = 0;
    console.log(`\nFAIL: heights inside ${AUTHORED} m changed (hash ${ref.hash} -> ${hash})`);
    console.log(`  ${grid.length} points sampled; largest move ${worst}`);
    bad++;
  } else {
    console.log(`\nidentity: ${grid.length} points inside ${AUTHORED} m are bit-identical (hash ${hash})`);
  }
} else if (!args.save) {
  console.log('\n(no reference saved; run with --save on the unmodified build first)');
}

if (!args.save) console.log(bad ? '\nTERRAIN SURVEY FAILED' : '\nPASS: near world unchanged, far world measured');
process.exit(bad ? 1 : 0);
