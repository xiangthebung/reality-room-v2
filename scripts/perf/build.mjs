import { spawn, spawnSync } from 'node:child_process';

/**
 * Build (and optionally serve) the INSTRUMENTED production bundle.
 *
 *   node scripts/perf/build.mjs            build dist-perf/
 *   node scripts/perf/build.mjs --serve    build it and preview on :5182
 *
 * Exists as a script rather than as `RR_PERF=1 vite build` in package.json
 * because that line is not portable: npm runs scripts through cmd.exe on
 * Windows, where `VAR=value cmd` is not a thing, and a build script that only
 * works on one of the two platforms this is developed on is a build script that
 * will be quietly broken half the time.
 *
 *
 * WHY MEASURE A PRODUCTION BUILD AT ALL, WHEN THE DEV SERVER IS RIGHT THERE.
 *
 * Because they are not the same program. The dev server serves every module
 * separately and unminified, with Vite's HMR client attached and no bundling —
 * which changes how much JavaScript the main thread parses, how the garbage
 * collector behaves under it, and how long the first frames take. None of that
 * touches the GPU time of a settled frame, which is why the dev server is a
 * perfectly good place to measure sections 1-3 of the bottleneck report and is
 * the default there.
 *
 * It is NOT good enough for the frame-time stability half, which is CPU-side
 * and main-thread-bound, and it is not good enough for anything anybody wants
 * to quote as "what a player gets". Hence a third build mode that is production
 * in every respect except that the instrument is still in it. Being able to
 * measure the shipping code path is worth more than the purity of never
 * compiling the instrument into an optimised bundle — and `check:perfstrip`
 * proves the bundle that actually ships is a different one.
 */

const serve = process.argv.includes('--serve');
const env = { ...process.env, RR_PERF: '1' };

console.log('building dist-perf/ with the instrument compiled in…');
const build = spawnSync('npx vite build', { env, stdio: 'inherit', shell: true });
if (build.status !== 0) process.exit(build.status ?? 1);

if (!serve) {
  console.log('\ndist-perf/ ready.  node scripts/perf/build.mjs --serve  to preview it.');
  process.exit(0);
}

console.log('\npreviewing dist-perf/ on http://127.0.0.1:5182/ — ctrl-c to stop');
const preview = spawn('npx vite preview', { env, stdio: 'inherit', shell: true });
process.on('SIGINT', () => preview.kill('SIGINT'));
preview.on('exit', (code) => process.exit(code ?? 0));
