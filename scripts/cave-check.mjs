import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cavesNear, heightAt, normalizeSeed, setWorldSeed, WATER_LEVEL } from '../src/world/terrain.js';

/**
 * Are the caves where they say they are, and is the ground they are cut into
 * still continuous?
 *
 * The spawn keep-out is gone — a mouth may now land as near the origin as the
 * ridge puts it — and with it went the radial cutoff in `heightAt` that used to
 * skip the notch inside 182 m. That cutoff was the only discontinuity this
 * feature could produce, and `terrain-survey.mjs` can no longer be the thing
 * that catches it: its reference hash was recaptured WITH the near notches in
 * it, so it now proves the near world has not changed since, not that the near
 * world is untouched. This asks the questions that survived, across a spread of
 * seeds:
 *
 *   THERE IS NO RING ROUND THE SPAWN. If anything ever reinstates a radius test
 *   in the carve, the ground steps by the depth of a gully along a circle at
 *   that radius. Straddling pairs 2 cm apart, on 1 440 bearings, at the radius
 *   the old cutoff used: natural ground moves by millimetres over 2 cm, a
 *   reinstated cutoff moves by metres.
 *
 *   AND NO STEP ANYWHERE ALONG A NOTCH. The straddle test only looks at one
 *   radius. This walks a ray from the origin out through each near mouth at
 *   5 cm and reports the largest single step on it, which covers the gully's
 *   own profile, its ends, and the saturating cut at the water line.
 *
 *   A MOUTH IS SOMEWHERE YOU COULD ACTUALLY STAND. Above the water plane, off
 *   the river, on ground that slopes, and with enough hillside above it that
 *   there is something to tunnel into. A cave whose mouth is in a bog or on a
 *   flat is not a bug that throws.
 *
 *   node scripts/cave-check.mjs [--seeds=24]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const SEEDS = Number(args.seeds ?? 24);

/**
 * The radius the old cutoff used, restated here so that reinstating it in
 * terrain.js — by any route, including a well-meant smoothstep — fails loudly.
 */
const BOUNDARY = 182;
/** Half the straddle, in metres. Small enough that real slope is negligible. */
const STRADDLE = 0.01;
/**
 * What a straddling pair is allowed to differ by.
 *
 * Measured worst over 64 seeds: 6.1 cm, which across a 2 cm straddle is a
 * gradient of 3 — a gully wall, and real ground. 30 cm leaves that five times
 * over while still being twenty to sixty times smaller than the depth of the
 * notch a reinstated cutoff would slice off, so the test is decisive without
 * being delicate.
 */
const SEAM_TOL = 0.3;
/**
 * Ray-walk sampling, and the largest single step it may find. Measured worst
 * over 64 seeds: 0.21 m in 5 cm, on the steepest gully wall of the set.
 */
const WALK_STEP = 0.05;
const WALK_TOL = 0.5;

const fails = [];
const rows = [];

/**
 * Is there a step in the ground at the radius the cutoff used to be at?
 *
 * A radial cutoff produces a very particular artefact — a circle centred on the
 * spawn along which the ground drops by however deep the notch was there — and
 * it is invisible in any statistic that averages, because it is one sample wide.
 * Straddling it directly is the only cheap test that cannot miss it: sample
 * either side of the radius, 2 cm apart, all the way round.
 */
function checkNoSeam(label) {
  let worst = 0;
  let at = 0;
  const N = 1440;
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    const cs = Math.cos(th);
    const sn = Math.sin(th);
    const a = heightAt((BOUNDARY - STRADDLE) * cs, (BOUNDARY - STRADDLE) * sn);
    const b = heightAt((BOUNDARY + STRADDLE) * cs, (BOUNDARY + STRADDLE) * sn);
    const step = Math.abs(b - a);
    if (step > worst) {
      worst = step;
      at = th;
    }
  }
  if (worst > SEAM_TOL) {
    fails.push(
      `${label}: the ground steps ${worst.toFixed(2)} m across r=${BOUNDARY} m ` +
        `at bearing ${((at * 180) / Math.PI).toFixed(0)}° — a radial cutoff is back in the carve`
    );
  }
  return worst;
}

/**
 * The same question asked along a line instead of around one.
 *
 * Out through the mouth rather than in any direction, because the gully is the
 * only thing in the near world that can have an edge: this crosses its far end,
 * its floor, both of its ends' smoothsteps and the mouth itself.
 */
function checkRay(label, c) {
  const len = Math.hypot(c.x, c.z) || 1;
  const ux = c.x / len;
  const uz = c.z / len;
  let worst = 0;
  let atR = 0;
  let prev = heightAt(ux * 20, uz * 20);
  for (let r = 20 + WALK_STEP; r <= len + 120; r += WALK_STEP) {
    const h = heightAt(ux * r, uz * r);
    const step = Math.abs(h - prev);
    if (step > worst) {
      worst = step;
      atR = r;
    }
    prev = h;
  }
  if (worst > WALK_TOL) {
    fails.push(
      `${label} k=${c.k}: a ${worst.toFixed(2)} m step in ${WALK_STEP} m at r=${atR.toFixed(1)} m ` +
        `on the ray through the mouth`
    );
  }
  return worst;
}

/**
 * Walk from one mouth to the next one along the ridge.
 *
 * This is the test for the single-slot lookup, and it is empirical rather than
 * arithmetic. `heightAt` asks ONE cave slot what it thinks of a sample — the
 * nearest — which is only sound while a cave's whole footprint stays inside its
 * own half of the 210 m spacing. The knoll made that footprint bigger; if it
 * ever grows past the halfway line, the far half of a knoll is simply not
 * carved and the hill ends in a wall along a line square to the crest.
 *
 * A line between two adjacent mouths crosses that halfway line at right angles
 * and passes through both knolls on the way, so it is the shortest walk that
 * can see the artefact at all.
 */
function checkBetween(label, c1, c2) {
  const dx = c2.x - c1.x;
  const dz = c2.z - c1.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  let worst = 0;
  let atT = 0;
  let prev = heightAt(c1.x, c1.z);
  for (let t = WALK_STEP; t <= len; t += WALK_STEP) {
    const h = heightAt(c1.x + ux * t, c1.z + uz * t);
    const step = Math.abs(h - prev);
    if (step > worst) {
      worst = step;
      atT = t;
    }
    prev = h;
  }
  if (worst > WALK_TOL) {
    fails.push(
      `${label}: a ${worst.toFixed(2)} m step in ${WALK_STEP} m, ${atT.toFixed(1)} m along the line ` +
        `from k=${c1.k} to k=${c2.k} — a knoll is reaching into the next slot`
    );
  }
  return worst;
}

/**
 * Is this a mouth a player could walk into?
 *
 * The gradient is measured across the gully's own axis at 6 m, well outside the
 * carve's flat floor, so it reports the HILLSIDE rather than the notch — a
 * notch cut into a flat plain would pass a naive slope test on the strength of
 * its own walls.
 */
function checkMouth(label, c) {
  const y = heightAt(c.x, c.z);
  const problems = [];
  if (y < WATER_LEVEL + 0.9) problems.push(`mouth at ${y.toFixed(1)} m is at or under the water plane`);
  if (c.depth < 4) problems.push(`gully only ${c.depth.toFixed(1)} m deep`);
  if (c.grade < 0.12) problems.push(`flank gradient ${c.grade.toFixed(3)} — that is not a hillside`);
  if (problems.length) fails.push(`${label} k=${c.k}: ${problems.join('; ')}`);
  return { y, problems: problems.length };
}

/**
 * NO BACKTICKS INSIDE A GLSL TEMPLATE LITERAL, and this is checked rather than
 * remembered.
 *
 * A backtick in a shader comment closes the JavaScript string it is embedded in,
 * and the parse error it produces names the next WORD rather than the quote —
 * "Unexpected identifier 'living'" for a comment reading `living.js`. Vite then
 * 500s the module, which takes the whole page down for every agent working in
 * the repo, not only the author. It happened twice inside caves.js while it was
 * being written and twice more elsewhere in the project on the same day, and it
 * costs the better part of an hour each time because the message points at
 * something innocent.
 *
 * The check is `node --check`, which is exact rather than heuristic: a stray
 * backtick inside a template literal IS a syntax error, so if the file parses
 * there is not one. Cheap enough to run over every file in the feature, and it
 * sits here rather than in its own script so that it runs in the same command
 * as everything else and reports the actual cause by name.
 */
const PARSE = [
  'src/world/caves.js',
  'src/world/terrain.js',
  'src/audio/cave.js',
  'src/audio/engine.js',
  'src/audio/impulse.js',
  'src/player/controller.js',
];
for (const file of PARSE) {
  const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
  const r = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  if (r.status !== 0) {
    const first = String(r.stderr).split('\n').find((l) => l.includes('Error')) ?? 'parse failed';
    fails.push(`${file} does not parse — ${first.trim()} (a backtick in a glsl comment?)`);
  }
}

const seeds = ['grove-01'];
for (let i = 1; i < SEEDS; i++) seeds.push(`check-${i}`);

for (const seed of seeds) {
  setWorldSeed(seed);
  const seam = checkNoSeam(seed);
  const near = cavesNear(0, 0, 1400);
  let bad = 0;
  let sumDepth = 0;
  let sumGrade = 0;
  let ray = 0;
  for (const c of near) {
    const r = checkMouth(seed, c);
    bad += r.problems;
    sumDepth += c.depth;
    sumGrade += c.grade;
  }
  // The ray walk on the two nearest mouths only: it is 8 000 `heightAt` calls
  // each and every mouth past the second is the same shape further away.
  for (const c of near.slice(0, 2)) ray = Math.max(ray, checkRay(seed, c));
  // …and the mouth-to-mouth walk on the two closest PAIRS, which is where two
  // knolls have the least room between them.
  for (let i = 0; i + 1 < Math.min(3, near.length); i++) {
    ray = Math.max(ray, checkBetween(seed, near[i], near[i + 1]));
  }
  const first = near.length ? Math.hypot(near[0].x, near[0].z) : NaN;
  rows.push({
    seed,
    n: near.length,
    nearest: first,
    seam,
    ray,
    depth: near.length ? sumDepth / near.length : 0,
    grade: near.length ? sumGrade / near.length : 0,
    bad,
  });
  if (!near.length) fails.push(`${seed}: no live cave within 1400 m of the origin`);
}

/**
 * The authored world is still the authored world, but it is no longer cave-free.
 *
 * `normalizeSeed('grove-01') === 0` is the identity this project pins its
 * reference images and its survey hash to, and that has not changed. What HAS
 * changed is that seed 0 now has notches inside the survey disc, so the survey's
 * reference was recaptured with them in it — see the keep-out block in
 * terrain.js. There is deliberately no assertion here that the disc is empty.
 */
setWorldSeed('grove-01');
if (normalizeSeed('grove-01') !== 0) fails.push('grove-01 no longer normalises to seed 0');

const pad = (s, n) => String(s).padEnd(n);
console.log(
  pad('seed', 12),
  pad('caves<1400', 11),
  pad('nearest', 10),
  pad('seam', 9),
  pad('ray step', 10),
  pad('gully', 8),
  pad('flank', 8),
  'bad'
);
for (const r of rows) {
  console.log(
    pad(r.seed, 12),
    pad(r.n, 11),
    pad(`${r.nearest.toFixed(0)} m`, 10),
    pad(`${(r.seam * 100).toFixed(1)} cm`, 9),
    pad(`${r.ray.toFixed(2)} m`, 10),
    pad(`${r.depth.toFixed(1)} m`, 8),
    pad(r.grade.toFixed(3), 8),
    r.bad
  );
}

const nearest = rows.map((r) => r.nearest).filter((v) => Number.isFinite(v));
console.log(
  `\nnearest mouth: ${Math.min(...nearest).toFixed(0)}–${Math.max(...nearest).toFixed(0)} m over ` +
    `${nearest.length} seeds (there is no keep-out; this is wherever the ridge put it)`
);

if (fails.length) {
  console.log(`\n${fails.length} PROBLEM(S):`);
  for (const f of fails.slice(0, 30)) console.log(' ', f);
  process.exitCode = 1;
} else {
  console.log('\nPASS: no step in the ground anywhere, every mouth is dry and on a slope');
}
