/**
 * Console output that is known, understood, and not worth reporting.
 *
 * A capture script that prints forty lines of driver noise on every run trains
 * whoever reads it to skip the console, and the next real error goes with it.
 * So each entry here has to be *diagnosed*, not merely tolerated — if you can't
 * write the paragraph, it does not belong in this file.
 *
 * Currently one entry.
 *
 * THE SHADER PRE-WARM'S WARM-UP DRAWS.
 *
 * `renderer.compileAsync(scene, camera)` runs behind the gate to build all 52
 * of the world's programs up front instead of compiling fifteen of them
 * synchronously on whichever frame first brings their material into view (see
 * the long comment at the call site in main.js). On ANGLE/D3D11 its warm-up
 * draws bind shadow samplers before those programs have been through a shadow
 * pass, and the driver refuses each one with
 *
 *   GL_INVALID_OPERATION: glDrawElements*: Mismatch between texture format and
 *   sampler type (signed/unsigned/float/shadow)
 *
 * exactly 43 times per session.
 *
 * What it is not: it is not a rendering fault. Steady-state rendering emits
 * zero of these — `scripts/gl-warn.mjs` walks every layer switch, alone and in
 * combination, and finds none — and `npm run check:cull` is a zero pixel diff
 * against a fully restored render at all nine stations. The warm-up draws go
 * nowhere; nothing on screen is affected.
 *
 * What was tried and did not work, so nobody repeats it: passing the scene as
 * `compileAsync`'s third `targetScene` argument; forcing a shadow render
 * immediately before the call; a synchronous `compile()`; disabling shadows
 * across the call (this one does silence it, but compiles 74 programs instead
 * of 52 — every material twice, the second copy a shadowless variant that is
 * never drawn). Two of those appeared to work on first measurement and inverted
 * on repeat, because the ground streamer was still filling the ring on the
 * early runs and the scene being compiled was not the same scene twice. Any
 * future attempt must be measured with at least three repetitions and the gate
 * clicked immediately, which is the worst case.
 *
 * Waiting for the ground ring to settle before compiling is in main.js and is
 * worth keeping regardless — it is what makes the program count reproducible —
 * but it does not remove these.
 */
export const KNOWN_NOISE = [
  /Mismatch between texture format and sampler type/,
];

/** True when a console line is known noise and should not be reported. */
export function isKnownNoise(text) {
  return KNOWN_NOISE.some((re) => re.test(text));
}

/**
 * Partition captured console lines into things worth showing and a tally of
 * what was suppressed. Returning the count rather than dropping it silently is
 * the point: a run that suppresses 4300 lines instead of 43 has a new problem.
 */
export function triage(lines) {
  const problems = [];
  let suppressed = 0;
  for (const line of lines) {
    if (isKnownNoise(line)) suppressed++;
    else problems.push(line);
  }
  return { problems, suppressed };
}
