/**
 * WAIT FOR THE CAVE TO SAY IT IS BUILT, NOT FOR A NUMBER OF SECONDS.
 *
 * Every script in this suite makes a cave exist the same way: put the body over
 * it so the streamer arms a build, then read the cave out of `RR.caves.caves`.
 * The wait between those two steps used to be a fixed `waitForTimeout` — 2.6 s,
 * 3 s, 3.5 s, 4 s, 5 s, a different guess per file — and every one of those
 * guesses was made about a build that no longer exists. `Cave.step` meters the
 * sweep out against a per-frame deadline, so how long a passage takes is a
 * property of the passage, of the machine, and of how many other mouths are in
 * range being built ahead of it. The passages went from ~300 m to ~650 m and
 * took the answer with them: measured on this tree, grove-01's k=-1 and
 * check-3's k=-3 both pass `ready` at about 6.4 s, roughly 390 frames.
 *
 * WHAT A SHORT WAIT PRODUCES IS NOT A TIMEOUT. It is `k=-3 did not build`, or
 * `not built`, or a `continue` past a cave that is perfectly fine — a claim
 * about the world made by a script that looked too early. The dangerous part is
 * the arithmetic underneath: a gate that silently skips its largest subject and
 * still prints a total reports a smaller number of failures than it did last
 * week, and a smaller number reads as an improvement. The biggest passages are
 * exactly the ones most likely to be skipped and most likely to be broken.
 *
 * Bounded, so a cave that genuinely never builds still reports `not built`
 * rather than hanging the run; and swallowed, so the caller's own "did it
 * build?" branch is the single place that failure is decided. Polling `ready`
 * costs nothing when the cave is already up, which it is for every cave this
 * suite has ever measured except the biggest.
 *
 * ON A TIMER RATHER THAN ON `raf`, which is Playwright's default. A headless
 * page that is not visible can have its animation frames throttled, and the one
 * clock this must not depend on is the one the thing being waited for runs on.
 *
 * The mirror of this rule inside the page — for scripts that do their whole
 * drive in one `evaluate`, because the game loop runs between `evaluate` calls
 * and lies about every result — is the bounded `for (…) await raf()` loop in
 * `cave-seal`, `cave-perf` and `cave-present`. Same rule, other side of the
 * bridge: wait for the flag, never for a count.
 */

/** Milliseconds. Four times the slowest build measured on this tree, twice. */
const BUILD_LIMIT = 60000;

/**
 * Resolve once cave `k` has published its mesh, or after `timeout` either way.
 *
 * `ready` is set in `_prime`, the frame after the last vertex buffer is
 * attached — so it is strictly later than `path`, `paths` and `mesh` becoming
 * readable, and a caller that waits on it may then read any of them.
 */
export function caveReady(page, k, timeout = BUILD_LIMIT) {
  return page
    .waitForFunction((key) => window.RR?.caves?.caves?.get(key)?.ready === true, k, {
      timeout,
      polling: 250,
    })
    .catch(() => {});
}
