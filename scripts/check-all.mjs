import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * EVERY GATE, AND EVERY FAILURE — NOT THE FIRST ONE.
 *
 * `npm run check` was twenty-three scripts joined by `&&`. `cave-gates.mjs`
 * opens with the argument against that shape and fixes it for the ten cave
 * gates; this is the same fix one level up, and the same three faults apply
 * with a wider blast radius:
 *
 *   IT STOPS AT THE FIRST FAILURE. Twenty-three gates measuring twenty-three
 *   different properties, and one broken property means you learn about exactly
 *   one of them. A change that moves several numbers at once by design — a new
 *   land, a re-cut of the light, anything that reseeds the scatter — turns into
 *   one red line at a time and one multi-minute round trip per line.
 *
 *   NO PIPES, AND THAT IS A RULE RATHER THAN A STYLE. A pipeline's exit status
 *   is the LAST command's, so a failing gate whose output was trimmed with
 *   `| tail` for readability reports success for as long as nobody looks. This
 *   project has already lost a gate that way. Every child here inherits stdio
 *   directly and its code is read from the process, never from its output.
 *
 *   AND WHAT IS NOT IN THE CHAIN IS NOT RUN. Five `check:*` targets existed in
 *   package.json and were in no aggregate at all — `check:menu` (and the main
 *   menu had just grown a land picker), `check:net`, `check:social`,
 *   `check:glwarn` and `check:day`. Three of those need a signalling server and
 *   are slow, which is the honest reason they were left out and is why the
 *   answer is NAMED GROUPS rather than one longer list.
 *
 *   node scripts/check-all.mjs                 everything except `net`
 *   node scripts/check-all.mjs --only=pure     the node-only gates, ~2 s
 *   node scripts/check-all.mjs --only=pure,world
 *   node scripts/check-all.mjs --group=net     the multiplayer gates
 *   node scripts/check-all.mjs --skip=perf
 *   node scripts/check-all.mjs -- --seed=grove-02      forwarded to every gate
 *
 * ORDERING IS CHEAPEST-AND-MOST-FUNDAMENTAL FIRST, so that when several things
 * are broken the first red line is usually the cause of the rest. It is NOT a
 * short-circuit order: every gate in the selected groups runs regardless.
 *
 * `net` IS EXCLUDED BY DEFAULT and that is not laziness. Those three gates need
 * `npm run server` up on 5181, and a stale server left running there tests old
 * code and fakes two dead-server failures — a recorded trap with a signature
 * that reads exactly like a netcode regression. Run them deliberately, after
 * restarting the server, with `--group=net`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Groups, and what each one is for.
 *
 *   pure    no browser, no GL, no dev server. Seconds. These are the gates that
 *           can run while somebody is editing, and the ones to run first.
 *   world   the real app in a real browser: does it boot, does every panel work,
 *           is the world still deterministic, do the caves hold together.
 *   audio   the master bus, measured. The harsh gate and the reverb tail.
 *   perf    frame timing against .perf/baseline.json, plus the covered-screen
 *           and instrument-stripping gates.
 *   net     two real pages against a real signalling server. Slow, and needs
 *           `npm run server` up first. Not in the default set.
 */
const GATES = [
  // ---- pure node -----------------------------------------------------------
  ['pure', 'glsl', 'glsl-backticks.mjs'],
  ['pure', 'keys', 'keys-check.mjs'],
  ['pure', 'terrain', 'terrain-survey.mjs'],
  ['pure', 'land', 'land-identity.mjs'],

  // ---- the world in a browser ---------------------------------------------
  ['world', 'slab', 'perf/slab-equiv.mjs'],
  ['world', 'debug', 'debug-check.mjs'],
  ['world', 'stats', 'stats-check.mjs'],
  ['world', 'settings', 'settings-check.mjs'],
  ['world', 'play', 'play-check.mjs'],
  ['world', 'fish', 'fish-check.mjs'],
  ['world', 'plants', 'check-plants.mjs'],
  ['world', 'cull', 'cull-check.mjs'],
  ['world', 'authored', 'authored-check.mjs'],
  ['world', 'endless', 'endless-check.mjs'],
  ['world', 'day', 'day-check.mjs'],
  ['world', 'caves', 'cave-gates.mjs'],
  ['world', 'fauna', 'fauna-wired.mjs'],
  ['world', 'birds', 'bird-check.mjs'],
  ['world', 'glwarn', 'gl-warn.mjs'],

  // ---- sound ---------------------------------------------------------------
  ['audio', 'spectrum', 'audio-probe.mjs'],
  ['audio', 'record', 'record-space.mjs'],
  ['audio', 'harmonics', 'bird-harmonics.mjs'],
  ['audio', 'fauna-audio', 'fauna-audio.mjs'],

  // ---- speed ---------------------------------------------------------------
  ['perf', 'frames', 'perf.mjs'],
  ['perf', 'bench', 'perf/bench.mjs'],
  ['perf', 'ceiling', 'perf/ceiling.mjs'],
  ['perf', 'covered', 'perf/gate.mjs'],
  ['perf', 'governor', 'perf/governor.mjs'],
  ['perf', 'strip', 'perf/strip-check.mjs'],

  // ---- other people --------------------------------------------------------
  ['net', 'two-player', '../server/test/two-player.mjs'],
  ['net', 'two-social', '../server/test/two-social.mjs'],
  ['net', 'menu', '../server/test/menu.mjs'],
];

/** Per-gate extra arguments, where a gate needs them to be the gate it is. */
const GATE_ARGS = {
  day: ['--only=identity'],
  governor: ['--swaps=2', '--width=1706', '--height=960'],
};

const DEFAULT_GROUPS = ['pure', 'world', 'audio', 'perf'];

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

/**
 * `--only` selects by GROUP or by GATE NAME, because both are things you want
 * at different moments: `--only=pure` while editing, `--only=land,terrain` when
 * you have just moved the scatter.
 */
const only = args.only ? new Set(String(args.only).split(',')) : null;
const groups = args.group ? new Set(String(args.group).split(',')) : null;
const skip = args.skip ? new Set(String(args.skip).split(',')) : new Set();

const wanted = GATES.filter(([group, name]) => {
  if (skip.has(group) || skip.has(name)) return false;
  if (only) return only.has(group) || only.has(name);
  if (groups) return groups.has(group);
  return DEFAULT_GROUPS.includes(group);
});

const run = (file, extra) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, file), ...extra, ...pass], {
      stdio: 'inherit',
    });
    /**
     * A gate killed by a signal has not passed. `code` is null in that case and
     * `null > 0` is false, which is the quiet way this would have gone green.
     */
    child.on('close', (code, signal) => resolve(signal ? `signal ${signal}` : (code ?? 1)));
    child.on('error', (e) => resolve(`could not start: ${e.message}`));
  });

if (!wanted.length) {
  console.log('No gate matched --only/--group/--skip. Nothing was run, which is a failure.');
  process.exit(1);
}

if (wanted.some(([g]) => g === 'net')) {
  console.log(
    '\nnote: the `net` group STARTS ITS OWN signalling server, and it must be allowed to.\n' +
      '      Each gate checks 5181 first and only spawns one if nothing answers — so a server\n' +
      '      you started by hand is adopted, and then `server?.kill()` is a no-op on a handle\n' +
      '      that is null. The last section of two-player.mjs kills the server on purpose to\n' +
      '      prove a client gives up quietly and keeps playing; with somebody else\'s server on\n' +
      '      the port that section can never pass, and it reports as a retry loop that is not\n' +
      '      there. A STALE server is worse still: it tests old code. Leave 5181 free.\n'
  );
}

const results = [];
const started = Date.now();
for (const [group, name, file] of wanted) {
  console.log(`\n${'='.repeat(72)}\n  ${group}: ${name}  (${file})\n${'='.repeat(72)}`);
  const t0 = Date.now();
  const code = await run(file, GATE_ARGS[name] ?? []);
  results.push({ group, name, code, ms: Date.now() - t0 });
}

console.log(
  `\n${'='.repeat(72)}\n  ${results.length} gates in ${((Date.now() - started) / 1000).toFixed(0)}s\n${'='.repeat(72)}`
);
const failed = results.filter((r) => r.code !== 0);
let lastGroup = null;
for (const r of results) {
  if (r.group !== lastGroup) {
    console.log(`  ${r.group}`);
    lastGroup = r.group;
  }
  const ok = r.code === 0;
  console.log(
    `    ${ok ? 'pass' : 'FAIL'}  ${r.name.padEnd(12)} ${String((r.ms / 1000).toFixed(0)).padStart(4)}s` +
      (ok ? '' : `   exit ${r.code}`)
  );
}
if (failed.length) {
  console.log(`\n${failed.length} of ${results.length} gates failed: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
console.log(`\nall ${results.length} gates passed`);
process.exit(0);
