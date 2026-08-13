import { boot, argv, DEV_URL, PAD } from './perf/harness.mjs';
import { median, bootstrapCI } from './perf/stats.mjs';

/**
 * WHAT THE FRAME COSTS WHILE YOU ARE UNDERGROUND, AND WHAT EACH THING STILL
 * BEING SUBMITTED DOWN THERE IS WORTH.
 *
 * The suite in scripts/perf/ has four stations and every one of them is in the
 * open wood, which was reasonable while a cave was a dark tube nobody spent
 * long in. It is exactly wrong now: the premise of the cave work is that being
 * inside a mountain should be the CHEAPEST place in the world — the rock in
 * front of you occludes everything — and that the frame it gives back is what
 * pays for the detail on the rock. Neither half of that claim can be made
 * without a number, and there was no number.
 *
 * So this stands the body deep inside a passage, past the measured blind
 * distance where `occludeWorld` is allowed to act, and un-hides one system at a
 * time from the shipping configuration outward. Each row is a paired A-B-B-A
 * difference, the same discipline `perf:why` uses, because the differences here
 * are a millisecond or two on a frame whose run-to-run spread is a fifth of
 * that and a single before/after pair would report noise with confidence.
 *
 *   node scripts/cave-perf.mjs [--reps=5] [--frames=90]
 */

const args = argv({ reps: '4', frames: '90', cave: '-1', width: '2560', height: '1440' });
const REPS = Number(args.reps);
const FRAMES = Number(args.frames);

const { browser, page } = await boot({ url: DEV_URL });
/**
 * AT A REAL RESOLUTION, BECAUSE EVERY ROW HERE IS A FILL COST.
 *
 * The harness boots at 1280x720, which is right for the suite: those stations
 * are vertex-bound and a smaller viewport makes the run faster without changing
 * what it measures. Nothing in THIS script is vertex-bound. What is being priced
 * is a sky dome that covers the screen, an additive mote cloud that covers the
 * screen, and a rock shader that covers every pixel of it — so at a quarter of
 * the pixels every row comes back at a quarter of its size and several of them
 * disappear under the noise floor entirely. Measured: at 720p the sky and the
 * motes both read 0.00 ms; the only honest conclusion from that run was that the
 * run was at the wrong resolution.
 */
await page.setViewportSize({ width: Number(args.width), height: Number(args.height) });
await page.waitForTimeout(1200);

/**
 * WHERE "DEEP INSIDE A CAVE" IS, AND WHY IT IS FOUND RATHER THAN TYPED.
 *
 * A station elsewhere in this project is a literal coordinate, because the
 * world is a pure function of the seed and a coordinate is therefore a
 * repeatable picture. That breaks down here for one reason: a cave does not
 * exist until it has been streamed and built, and it builds a slice per frame
 * only once the streamer has noticed the camera. Typing a coordinate would give
 * a station that measures a hillside on the first run after any change to
 * BUILD_RANGE or to the ring budget. Asking the built passage where its own
 * deepest wide ring is costs one evaluate and cannot go stale.
 */
const spot = await page.evaluate(async (k) => {
  const R = window.RR;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const mod = await import('/src/world/terrain.js');
  const near = mod.cavesNear(0, 0, 900).find((c) => c.k === Number(k)) ?? mod.cavesNear(0, 0, 900)[0];
  R.director.ground();
  R.controller.keys.clear();
  R.controller.fly = true;
  R.controller.position.set(near.x, 60, near.z);
  R.controller.velocity.set(0, 0, 0);
  /**
   * WAIT FOR THE CAVE TO SAY IT IS FINISHED, NOT FOR A NUMBER OF FRAMES.
   *
   * This was 400 frames with a comment saying that was long enough for the
   * rescan plus the sliced build, and it was, for the build as it stood when it
   * was written. The build is now cut against a millisecond deadline rather than
   * a ring count, so the number of frames it takes is a property of the machine
   * and of how many mouths happen to be in range. Bounded, so a build that never
   * finishes says so instead of hanging.
   */
  for (let i = 0; i < 6000 && !R.caves.caves.get(near.k)?.ready; i++) await raf();
  const cave = R.caves.caves.get(near.k);
  if (!cave?.ready) return null;
  const p = cave.path;
  /**
   * The deepest ring that is both past the blind distance — so the occlusion is
   * allowed to fire at all — and reasonably open, because a squeeze is the
   * cheapest frame in the cave and would flatter every row below.
   */
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 10; i < p.x.length - 10; i++) {
    if (p.along[i] < (cave.blind ?? 0) + 20) continue;
    const score = p.r[i] * p.w[i];
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) return null;
  const j = Math.min(p.x.length - 1, best + 10);
  return {
    k: near.k,
    ring: best,
    along: p.along[best],
    blind: cave.blind,
    x: p.x[best],
    y: p.y[best] - p.r[best] * p.f[best] + 1.68,
    z: p.z[best],
    yaw: Math.atan2(-(p.x[j] - p.x[best]), -(p.z[j] - p.z[best])),
    span: bestScore,
  };
}, args.cave);

if (!spot) {
  console.log('no built passage with a measured blind distance — nothing to stand in');
  await browser.close();
  process.exit(1);
}
console.log(
  `k=${spot.k}  ring ${spot.ring}  ${spot.along.toFixed(0)} m in ` +
    `(blind at ${Number(spot.blind).toFixed(0)} m)  half-width ${spot.span.toFixed(1)} m\n`
);

/**
 * Stand still and time frames.
 *
 * Still, because the thing being measured is what is SUBMITTED, and walking
 * would fold the streamer's per-frame sector work into every row. The hitch
 * question is a different one and `perf:spikes` already owns it.
 */
async function timeFrames(unhide) {
  return page.evaluate(
    async ({ spot: s, frames, unhide: un }) => {
      const R = window.RR;
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      R.controller.fly = true;
      R.controller.position.set(s.x, s.y, s.z);
      R.controller.velocity.set(0, 0, 0);
      R.controller.yaw = s.yaw;
      R.controller.pitch = 0;
      R.controller.applyToCamera();
      /**
       * `caves.perfUnhide` is read once a frame by the cave block in main.js, AFTER
       * it has decided what to hide. Forcing visibility from here instead would
       * be overwritten within one frame — the same trap the fog density knob
       * and the day cycle both document.
       */
      window.RR.caves.perfUnhide = un;
      /**
       * LONG ENOUGH FOR `caveMix` TO GET THERE, WHICH UNCAPPED IS NOT THIRTY
       * FRAMES.
       *
       * The mix eases at dt * 3.2 per frame and the occlusion only acts past
       * 0.995, so it needs about a second and a half of WALL CLOCK. With vsync
       * off this page runs at fifteen hundred frames a second, and thirty of
       * those is twenty milliseconds — a mix of 0.06, nothing hidden, and every
       * row in the table reading zero because both arms were identical. The
       * first run of this script did exactly that and the base line it printed
       * still says `forest submitted: true` from the same cause.
       */
      const until = performance.now() + 1800;
      while (performance.now() < until) await raf();
      /**
       * NO DRAW OR TRIANGLE COUNTS HERE, AND THAT IS DELIBERATE.
       *
       * `renderer.info` resets at the start of every PASS, and this pipeline
       * renders the scene, a bright pass, six blur passes and an output pass —
       * so anything read from outside the loop reports the last of those. The
       * first version of this script printed "1 draw, 0.00 M triangles" for a
       * cave with thirty thousand triangles in it and was believed for a while.
       * The probe in src/dev/perf owns the counters; it turns autoReset off and
       * reads them at the right moment.
       */
      const dt = [];
      let last = performance.now();
      for (let i = 0; i < frames; i++) {
        await raf();
        const now = performance.now();
        dt.push(now - last);
        last = now;
      }
      window.RR.caves.perfUnhide = null;
      return { dt, forestVisible: R.forest.group.visible, mix: R.debug?.caveMix ?? null };
    },
    { spot, frames: FRAMES, unhide }
  );
}

/** A-B-B-A, so a slow drift across the run cancels instead of landing in one arm. */
async function pair(unhide) {
  const deltas = [];
  let baseAll = [];
  for (let r = 0; r < REPS; r++) {
    const order = r % 2 === 0 ? [null, unhide, unhide, null] : [unhide, null, null, unhide];
    const got = [];
    for (const u of order) got.push(await timeFrames(u));
    const a = order.map((u, i) => (u === null ? got[i] : null)).filter(Boolean);
    const b = order.map((u, i) => (u !== null ? got[i] : null)).filter(Boolean);
    const am = median(a.flatMap((x) => x.dt));
    const bm = median(b.flatMap((x) => x.dt));
    deltas.push(bm - am);
    baseAll = baseAll.concat(a.flatMap((x) => x.dt));
  }
  const ci = bootstrapCI(deltas);
  return { base: median(baseAll), delta: ci.median, lo: ci.lo, hi: ci.hi };
}

const base = await timeFrames(null);
console.log(
  `shipping, underground:  ${median(base.dt).toFixed(2)} ms/frame at ${args.width}x${args.height}` +
    `   (wood submitted: ${base.forestVisible})\n`
);
console.log('what each system costs if it is NOT hidden down here:\n');

/**
 * No row for the ground, and its absence is the useful fact: `groundField.group`
 * is a CHILD of `forest.group`, so the terrain has been going away with the wood
 * since the day `occludeWorld` was written. A separate row would have measured
 * zero and been read as "the ground is free".
 */
const ROWS = [
  ['the wood and ground', 'forest'],
  ['the sky dome', 'sky'],
  ['the motes', 'motes'],
  ['water, shafts and mist', 'weather'],
  ['the animals', 'fauna'],
  ['everything above', 'all'],
];
for (const [label, key] of ROWS) {
  const v = await pair(key);
  const sign = v.delta >= 0 ? '+' : '';
  console.log(
    PAD(label, 26) +
      `${sign}${v.delta.toFixed(2)} ms   ` +
      `[${v.lo.toFixed(2)}, ${v.hi.toFixed(2)}]   ` +
      `${((v.delta / v.base) * 100).toFixed(0)}% of a ${v.base.toFixed(2)} ms frame`
  );
}

await browser.close();
