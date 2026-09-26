import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * EVERY CAVE GATE, AND EVERY FAILURE — NOT THE FIRST ONE.
 *
 * `check:cave` was nine scripts joined by `&&`, which has three faults and the
 * third is the one that hid the other two.
 *
 *   IT STOPS AT THE FIRST FAILURE. Nine gates measuring nine different
 *   properties of the same geometry, and one broken property means you learn
 *   about exactly one of them. Change the walk — which reseeds every cave on
 *   every seed, so several numbers move at once by design — and you get a single
 *   red line, fix it, run again, get the next one. That is nine round trips of
 *   several minutes each to learn something one run already knew.
 *
 *   A GATE WITH NO EXIT CODE IS INVISIBLE IN IT. `cave-floor.mjs` sat fifth in
 *   the chain and contained no `process.exit` at all: it printed the worst
 *   hover, printed "the body stands in mid-air here", and returned 0. Being in
 *   an `&&` chain is what made that unnoticeable, because the chain's own green
 *   tick is indistinguishable from the script's.
 *
 *   AND WHAT IS NOT IN THE CHAIN IS NOT RUN. `cave-junction.mjs` — the only ray
 *   sweep in the suite, and the only thing that can find a junction showing
 *   daylight — was wired as `shot:cave-junction`, filed with the screenshot
 *   scripts because it happens to save an image, and was in nothing. It is in
 *   the list below.
 *
 * NO PIPES, AND THAT IS A RULE RATHER THAN A STYLE. This project has already
 * lost a gate to `| tail`: a pipeline's exit status is the LAST command's, so a
 * failing script whose output was trimmed for readability reported success for
 * as long as nobody looked. Every child here inherits stdio directly and its
 * code is read from the process, never from its output.
 *
 * Sequential rather than parallel on purpose. They all drive one browser
 * against one dev server on 5180, several of them fly the camera around, and
 * two of them measure frame times.
 *
 *   node scripts/cave-gates.mjs [--only=floor,seal] [--skip=trip]
 *                               [-- any args forwarded to every gate]
 *
 * Anything after a bare `--` is passed through to each gate, so
 * `node scripts/cave-gates.mjs -- --seed=grove-02` runs the whole suite on
 * another seed.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The order is cheapest-and-most-fundamental first, so that when several things
 * are broken the first line of output is usually the cause of the rest. It is
 * NOT a short-circuit order — every one of them runs regardless.
 *
 *   check      does a cave exist, is it walkable, does it have the parts
 *   normals    is the surface wound the right way round
 *   roof       is there rock over every ring
 *   mouth      is the doorway clear, and is the mountain still solid round it
 *   floor      does the floor you stand on match the floor you can see
 *   walk       can a body get from the mouth to the end
 *   branch     can a body get through a junction into the passage behind it
 *   junction   does any junction show daylight (ray sweep)
 *   seal       does any seam show daylight (raster)
 *   end        does the passage arrive somewhere rather than stopping
 */
const GATES = [
  ['check', 'cave-check.mjs'],
  ['normals', 'cave-normals.mjs'],
  ['roof', 'cave-roof.mjs'],
  ['mouth', 'cave-mouth.mjs'],
  ['floor', 'cave-floor.mjs'],
  ['walk', 'cave-walk.mjs'],
  ['branch', 'cave-branch.mjs'],
  ['junction', 'cave-junction.mjs'],
  ['seal', 'cave-seal.mjs'],
  ['end', 'cave-end.mjs'],
];

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep === -1 ? argv : argv.slice(0, sep);
const pass = sep === -1 ? [] : argv.slice(sep + 1);
const args = Object.fromEntries(
  own.map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const only = args.only ? new Set(args.only.split(',')) : null;
const skip = args.skip ? new Set(args.skip.split(',')) : new Set();

const run = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, file), ...pass], {
      stdio: 'inherit',
    });
    // A gate killed by a signal has not passed. `code` is null in that case and
    // `null > 0` is false, which is the quiet way this would have gone green.
    child.on('close', (code, signal) => resolve(signal ? `signal ${signal}` : (code ?? 1)));
    child.on('error', (e) => resolve(`could not start: ${e.message}`));
  });

const results = [];
const started = Date.now();
for (const [name, file] of GATES) {
  if (only && !only.has(name)) continue;
  if (skip.has(name)) continue;
  console.log(`\n${'='.repeat(72)}\n  cave gate: ${name}  (${file})\n${'='.repeat(72)}`);
  const t0 = Date.now();
  const code = await run(file);
  results.push({ name, file, code, ms: Date.now() - t0 });
}

if (!results.length) {
  console.log('\nNo cave gate matched --only/--skip. Nothing was run, which is a failure.');
  process.exit(1);
}

console.log(`\n${'='.repeat(72)}\n  CAVE GATES — ${results.length} run in ${((Date.now() - started) / 1000).toFixed(0)}s\n${'='.repeat(72)}`);
const failed = results.filter((r) => r.code !== 0);
for (const r of results) {
  const ok = r.code === 0;
  console.log(
    `  ${ok ? 'pass' : 'FAIL'}  ${r.name.padEnd(10)} ${String((r.ms / 1000).toFixed(0)).padStart(4)}s` +
      (ok ? '' : `   exit ${r.code}`)
  );
}
if (failed.length) {
  console.log(`\n${failed.length} of ${results.length} cave gates failed: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
console.log(`\nall ${results.length} cave gates passed`);
process.exit(0);
