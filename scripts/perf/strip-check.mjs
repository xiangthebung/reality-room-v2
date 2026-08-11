import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

/**
 * PROVE THE INSTRUMENT IS NOT IN THE BUILD THAT SHIPS.
 *
 *   npm run check:perfstrip              build both, then check
 *   npm run check:perfstrip -- --no-build  check whatever is already on disk
 *
 * A comment saying "this is compiled out" is a claim, and a claim about dead
 * code elimination is exactly the kind that rots silently: change the dynamic
 * import to a static one, add a re-export somewhere, reference the module from
 * a file that is not behind the flag, and the code comes back into the bundle
 * with nothing failing and nobody noticing. So it is asserted, on the actual
 * emitted bytes, every time `npm run check` runs.
 *
 *
 * THE HALF THAT MAKES IT A TEST RATHER THAN A RITUAL.
 *
 * Checking only that the shipping bundle lacks the fingerprints is a test that
 * passes when the fingerprints are wrong, when the build silently failed, when
 * `dist/` is empty, and when somebody renames a string. It would sit there
 * green for ever while proving nothing.
 *
 * So every fingerprint must be ABSENT from dist/ and PRESENT in dist-perf/. The
 * second half is what gives the first half meaning: it establishes that these
 * strings are real, that they survive minification, and that a build which does
 * contain the instrument looks different from one that does not.
 */

const args = process.argv.slice(2);
const BUILD = !args.includes('--no-build');

/**
 * Strings that exist ONLY in src/dev/perf/, chosen to survive minification.
 *
 * All of them are string literals or property names that cross a boundary a
 * minifier will not rename: `__RR_PERF__` is written onto `window`, the station
 * and level names are object keys read by name from the Node side, and the
 * error messages are literals. Identifiers of local functions are deliberately
 * NOT used — esbuild renames those, so `installPerfProbe` would be absent from
 * a bundle that contains the whole module and the check would pass while
 * shipping every byte of it.
 */
/**
 * They must also be unique to it, which is a sharper requirement than it looks.
 * `egodeath` was in this list first: it is one of the suite's level names, it
 * looked distinctive, and it is also a trip phase id in `src/trip/state.js`
 * that the shipping build has every right to contain. The check duly failed on
 * its first run and reported that the instrument had not been stripped, which
 * was false — the fingerprint was simply not a fingerprint. A word that appears
 * in the game is evidence of nothing.
 */
const FINGERPRINTS = [
  '__RR_PERF__',
  'unknown station',
  'lever wrote unknown rig key',
  'glow accumulator off',
  'EXT_disjoint_timer_query_webgl2 unavailable',
];

function bundleFiles(dir) {
  if (!existsSync(dir)) return null;
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      // Source maps are not shipped to a browser unless asked for and they
      // contain the original source of everything, including code that was
      // eliminated — scanning them would fail this check for the wrong reason.
      else if (entry.endsWith('.js') || entry.endsWith('.html')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function scan(dir) {
  const files = bundleFiles(dir);
  if (!files) return null;
  const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const found = {};
  for (const fp of FINGERPRINTS) found[fp] = text.includes(fp);
  return {
    files: files.length,
    bytes: files.reduce((n, f) => n + statSync(f).size, 0),
    found,
    /**
     * The build-time flag itself must have been substituted. A literal
     * `__PERF__` surviving into the output means the `define` did not apply —
     * at which point the identifier is undefined at runtime and the game throws
     * on the first frame, so this is a real failure mode and not a nicety.
     */
    flagLeaked: text.includes('__PERF__'),
  };
}

if (BUILD) {
  console.log('building dist/ (shipping) …');
  const ship = spawnSync('npx vite build', {
    env: { ...process.env, RR_PERF: '' },
    stdio: 'inherit',
    shell: true,
  });
  if (ship.status !== 0) process.exit(ship.status ?? 1);

  console.log('\nbuilding dist-perf/ (instrumented) …');
  const perf = spawnSync('npx vite build', {
    env: { ...process.env, RR_PERF: '1' },
    stdio: 'inherit',
    shell: true,
  });
  if (perf.status !== 0) process.exit(perf.status ?? 1);
}

const ship = scan('dist');
const perf = scan('dist-perf');

const problems = [];
if (!ship) problems.push('dist/ does not exist — run without --no-build.');
if (!perf) problems.push('dist-perf/ does not exist — run without --no-build.');

if (ship && perf) {
  console.log(`\n${'fingerprint'.padEnd(42)}${'dist'.padEnd(10)}dist-perf`);
  console.log('─'.repeat(64));
  for (const fp of FINGERPRINTS) {
    const inShip = ship.found[fp];
    const inPerf = perf.found[fp];
    const ok = !inShip && inPerf;
    console.log(
      `${fp.slice(0, 40).padEnd(42)}${(inShip ? 'PRESENT' : 'absent').padEnd(10)}${
        inPerf ? 'present' : 'MISSING'
      }${ok ? '' : '   ✗'}`
    );
    if (inShip) problems.push(`"${fp}" is in the shipping bundle — the instrument was not stripped.`);
    if (!inPerf) {
      problems.push(
        `"${fp}" is missing from the instrumented bundle — the fingerprint is stale, ` +
          'so its absence from dist/ proves nothing.'
      );
    }
  }
  if (ship.flagLeaked) problems.push('`__PERF__` survived into dist/ — the define did not apply.');
  if (perf.flagLeaked) problems.push('`__PERF__` survived into dist-perf/ — the define did not apply.');

  const saved = perf.bytes - ship.bytes;
  console.log(
    `\ndist        ${ship.files} files, ${(ship.bytes / 1024).toFixed(1)} KiB\n` +
      `dist-perf   ${perf.files} files, ${(perf.bytes / 1024).toFixed(1)} KiB\n` +
      `the instrument costs a player   ${(saved / 1024).toFixed(1)} KiB — and does not pay it`
  );
  /**
   * A size difference is not required to pass — it is possible in principle for
   * a stripped build to be no smaller — but a difference of zero alongside all
   * the fingerprints in the right places would be strange enough to say out
   * loud rather than swallow.
   */
  if (saved <= 0) {
    console.log(
      '\nNOTE: the instrumented build is no larger than the shipping one, which is\n' +
        'unexpected. The fingerprints agree, so this is reported rather than failed.'
    );
  }
}

/* ---- and does it still run ---------------------------------------------- */

/**
 * "STRIPPED" IS HALF A CLAIM. THE OTHER HALF IS "AND STILL WORKS".
 *
 * Everything above proves the instrument's bytes are gone. It cannot prove the
 * game survived their removal, and the removal is not passive — it deletes a
 * branch from the frame loop and a top-level await from the entry module. Get
 * the `define` wrong and `__PERF__` is an undefined identifier that throws on
 * the first frame; get the import shape wrong and Rollup keeps a reference to a
 * chunk it did not emit. Both produce a bundle that passes every test above and
 * a black screen for the player.
 *
 * So the shipping bundle is served and booted for real: through the gate, into
 * the world, with the assertion being that it draws triangles. That is the
 * cheapest possible statement of "the game is on the screen" and it is the one
 * thing the rest of this file cannot substitute for.
 */
async function bootsAndDraws(dir, port) {
  const server = spawn(`npx vite preview --outDir ${dir} --port ${port}`, {
    env: { ...process.env, RR_PERF: '' },
    stdio: 'ignore',
    shell: true,
  });
  const browser = await chromium.launch({
    args: [
      '--use-gl=angle',
      '--use-angle=default',
      '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const thrown = [];
    page.on('pageerror', (e) => thrown.push(String(e)));
    // The server needs a moment; retry rather than sleep a fixed amount.
    for (let i = 0; i < 30; i++) {
      try {
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 2000 });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
    await page.click('#enter');
    await page
      .waitForFunction(() => document.getElementById('gate')?.classList.contains('gone'), null, {
        timeout: 90000,
      })
      .catch(() => {});
    await page.waitForTimeout(1500);
    /**
     * `autoReset` OFF around exactly one frame.
     *
     * three resets `renderer.info` at the top of every `renderer.render()`
     * call, and this pipeline makes several per frame — a scene pass then a
     * chain of fullscreen quads. Read straight, the counter therefore reports
     * the LAST of those: one draw call and two triangles, on a frame that drew
     * the entire forest. The first version of this check asserted `triangles >
     * 0` and passed on that quad, which is a test that would have gone on
     * passing if the world had stopped rendering entirely.
     */
    const state = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const info = window.RR.renderer.info;
          info.autoReset = false;
          info.reset();
          // Two frames: one to be counted, the next to observe from, so the
          // read cannot land halfway through the frame being measured.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const out = {
                triangles: info.render.triangles,
                calls: info.render.calls,
                programs: info.programs.length,
                instrument: typeof window.__RR_PERF__,
              };
              info.autoReset = true;
              resolve(out);
            })
          );
        })
    );
    return { ...state, thrown };
  } finally {
    await browser.close();
    server.kill();
  }
}

if (!problems.length && !args.includes('--no-boot')) {
  console.log('\nbooting the shipping bundle…');
  const live = await bootsAndDraws('dist', 5184);
  console.log(
    `  drew ${live.calls} calls, ${(live.triangles / 1e6).toFixed(2)}M triangles, ` +
      `${live.programs} programs compiled, window.__RR_PERF__ is ${live.instrument}`
  );
  if (live.thrown.length) {
    problems.push(`the shipping bundle threw: ${live.thrown[0]}`);
  }
  /**
   * A million is not a round number chosen for looking sensible: the suite
   * measures this world at nine to thirteen million triangles a frame, and the
   * failure this is guarding against — a bundle that boots but renders nothing
   * — bottoms out at the two triangles of a fullscreen quad. A floor three
   * orders of magnitude above that and one below the real frame cannot be
   * reached by accident from either side.
   */
  if (live.triangles < 1e6) {
    problems.push(
      `the shipping bundle booted but drew only ${live.triangles} triangles — ` +
        'stripping the instrument broke the render.'
    );
  }
  if (live.instrument !== 'undefined') {
    problems.push('window.__RR_PERF__ exists at runtime in the shipping bundle.');
  }
}

if (problems.length) {
  console.error('\nFAILED');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('\nthe shipping bundle contains no performance instrument, and still runs.\n');
