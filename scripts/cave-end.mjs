import { chromium } from 'playwright';
import { cavesNear, setWorldSeed } from '../src/world/terrain.js';

/**
 * WHAT HAPPENS WHEN YOU GET TO THE END.
 *
 * Every other cave check measures the way in. `cave-walk` presses W at the mouth
 * and asks whether the passage is enterable; `cave-floor` asks whether the ground
 * is where your feet are; `cave-seal` asks whether the mountain is between you
 * and the weather. Not one of them has ever been to the far end of a passage,
 * and the far end is where the feature was broken for its whole life:
 *
 *   "I don't like how the caves end in this little cone shape, which you walk
 *    through and get teleported."
 *
 * Both halves of that came from the same two lines of geometry. The close ran a
 * full-size ring to a 5 cm point over two ring steps, and 5 cm is smaller than a
 * person — so `caveSample`'s fit, which measures the body in units of the
 * section it is standing in, exploded, no ring claimed the point, and
 * `caveFloorUnder` fell through to `groundUnder`. Under a mountain that is the
 * summit. The floor clamp then fires the body up onto the hillside and
 * `occludeWorld` re-submits the forest on the same frame, which is why a
 * collision failure presents as a teleport.
 *
 * So this script walks INTO the terminus at running speed and asserts four
 * things, one for each way that could still go wrong:
 *
 *   (a) `inCave` never reaches 0 while the body is inside. That is the
 *       containment failure itself, before any of its consequences.
 *   (b) the body's height never jumps. A fall through to `groundUnder` is tens
 *       of metres in a single frame; nothing a walking body does is more than a
 *       few centimetres.
 *   (c) the body is STOPPED before it passes the last ring with standing room in
 *       it. The mesh is single-sided and faces inward, so an end you can walk
 *       through is also an end you can see straight out of.
 *   (d) the terminus is bigger than the passage that feeds it. Without this the
 *       other three pass on a cave that ends in a stub, which is the exact
 *       regression this file's sizing rules exist to prevent — and it reports as
 *       "0 light sources, 1 formation", never as a failure.
 *
 * THE WHOLE DRIVE HAPPENS INSIDE ONE `evaluate`. The game loop runs between
 * `evaluate` calls, so anything sampled by polling from node is a photograph of
 * whatever the frame after the last one left behind — this project has twice had
 * an instrument conclude a world had been deleted that way. The loop below steps
 * the real frames with `requestAnimationFrame` and reads the body in the same
 * turn, so every number is from a frame that actually happened.
 *
 *   node scripts/cave-end.mjs [--seeds=grove-01,check-3] [--seconds=14]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const SEEDS = (args.seeds ?? 'grove-01,check-3').split(',');
/**
 * How long the drive gets, in seconds.
 *
 * The run-up is twenty-two metres and RUN is about five metres a second, so four
 * and a half would do it on a clear floor — and a terminal chamber's floor is
 * BREAKDOWN, which is the whole point of it. The body climbs blocks and goes
 * round pillars, and at ten seconds one cave in nine arrived a few metres short
 * and reported itself as unreachable. That is a false alarm with the same
 * signature as a real one, which is the worst kind of gate: twenty seconds is
 * four times the clear-floor time, so anything that still fails to arrive is
 * genuinely blocked.
 */
const SECONDS = Number(args.seconds ?? 20);
/** How many caves per seed. Three is every live one within reach on these seeds. */
const CAVES = Number(args.caves ?? 3);

/** The most a walking body's eye may move vertically in one frame, in metres. */
const JUMP_LIMIT = 1.5;
/** How far past the last ring with standing room the body may end up, in metres. */
const OVERRUN_LIMIT = 0.6;
/**
 * How much wider the terminus must be than the passage feeding it.
 *
 * A RATIO AND NOT A SIZE, because how big a chamber the mountain will carry is a
 * property of the mountain — `terminusFit` asks `roofRoom` and takes what it is
 * given, and on a passage that has walked out from under its own ridge the
 * honest answer is nothing at all. What can be asserted is that the end is not a
 * TAPER: 1.15 is barely perceptible as an opening and is comfortably below what
 * a chamber measures, so this fires on a passage that pinched shut and not on
 * one that merely found a modest room.
 */
const OPEN_RATIO = 1.15;

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const problems = [];
const rows = [];

for (const seed of SEEDS) {
  setWorldSeed(seed);
  const near = cavesNear(0, 0, 1200).slice(0, CAVES);
  if (!near.length) {
    console.log(`${seed}: no live cave within 1200 m`);
    continue;
  }
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${seed}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${seed}: [pageerror] ${e.message}`));
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`${URL}?seed=${seed}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
  await page.click('#enter');
  await page.waitForSelector('#gate.gone', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    for (const id of ['toast', 'help', 'stats']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
  });

  for (const c of near) {
    /**
     * Stand ON the passage to make it build, not at the mouth.
     *
     * The streamer arms a build for caves within BUILD_RANGE of the body, and
     * the terminus is two hundred metres further in than the mouth is — so
     * approaching from the gully and waiting is both slower and, on a long
     * passage, not guaranteed. Flying to the cave's own centre puts the whole
     * thing inside range at once.
     */
    await page.evaluate(
      (p) => {
        const { controller, director } = window.RR;
        director.ground();
        controller.keys.clear();
        controller.fly = true;
        controller.position.set(p.x, 80, p.z);
        controller.velocity.set(0, 0, 0);
      },
      { x: c.x, z: c.z }
    );
    /**
     * WAIT FOR THIS CAVE TO SAY IT IS BUILT, NOT FOR FIVE SECONDS.
     *
     * Five seconds was enough while the build was cut into rings; it is not now
     * that it is cut against a millisecond deadline, because how many frames
     * that comes to depends on the machine and on how many other mouths are in
     * range being built first. What a short wait produces here is
     * `check-3 k=-3: not built`, which reads as a passage that failed to
     * generate and is really a script that looked too early — the exact failure
     * this suite has recorded four instruments making in one day. Bounded, so a
     * cave that genuinely never builds still reports `not built`.
     */
    await page
      .waitForFunction((k) => window.RR.caves.caves.get(k)?.ready === true, c.k, {
        timeout: 60000,
      })
      .catch(() => {});

    const r = await page.evaluate(
      async ({ k, seconds, jumpLimit }) => {
        const R = window.RR;
        const raf = () => new Promise((res) => requestAnimationFrame(res));
        const con = R.controller;
        const cave = R.caves.caves.get(k);
        if (!cave?.ready) return { built: false };
        const terrain = await import('/src/world/terrain.js');
        const p = cave.path;
        const n = p.x.length;
        const end = p.endRing ?? n - 1;

        /**
         * How big the terminus is against the passage that feeds it.
         *
         * The feed is the MEDIAN half-width over everything before the last
         * forty rings, not the mean and not the ring next door: a passage that
         * happens to have a room in it two thirds of the way along would drag a
         * mean up, and the ring immediately before the terminus is already part
         * of the opening. The median is what the passage has mostly been.
         */
        const half = [];
        for (let i = 0; i < n; i++) half.push(p.r[i] * p.w[i]);
        const feed = half.slice(4, Math.max(5, n - 40)).sort((a, b) => a - b);
        const med = feed[Math.floor(feed.length / 2)] ?? 0;
        let termHalf = 0;
        let termAt = end;
        for (let i = Math.max(0, n - 70); i <= end; i++) {
          if (half[i] > termHalf) {
            termHalf = half[i];
            termAt = i;
          }
        }
        const termTall = p.r[termAt] * (p.t[termAt] + p.f[termAt]);

        /**
         * Start a run-up short of the terminus and steer along the centre line.
         *
         * Twenty-two metres is three seconds at RUN, which is long enough to be
         * at full speed on arrival — the whole question is what a body moving at
         * walking pace does when the passage stops, and a body teleported into
         * position and nudged forward would answer a different one.
         */
        let from = end;
        let run = 0;
        while (from > 2 && run < 22) {
          run += Math.hypot(p.x[from] - p.x[from - 1], p.y[from] - p.y[from - 1], p.z[from] - p.z[from - 1]);
          from--;
        }
        con.fly = false;
        con.keys.clear();
        con.position.set(p.x[from], p.y[from] - p.r[from] * p.f[from] + 1.68, p.z[from]);
        con.velocity.set(0, 0, 0);
        con.pitch = 0;
        // Two frames to let `caveSample` claim the body before anything is read:
        // the first sample after a teleport is the widen case, by design.
        await raf();
        await raf();

        /** Signed metres past the plane of the last ring with standing room. */
        const overrunAt = (x, z) => {
          const a = Math.max(0, end - 1);
          const b = Math.min(n - 1, end + 1);
          let tx = p.x[b] - p.x[a];
          let tz = p.z[b] - p.z[a];
          const tl = Math.hypot(tx, tz) || 1;
          tx /= tl;
          tz /= tl;
          return (x - p.x[end]) * tx + (z - p.z[end]) * tz;
        };

        const nearest = (x, z) => {
          let bd = Infinity;
          let bi = 0;
          for (let i = 0; i < n; i++) {
            const d = (p.x[i] - x) ** 2 + (p.z[i] - z) ** 2;
            if (d < bd) {
              bd = d;
              bi = i;
            }
          }
          return bi;
        };

        let minInside = 1;
        let worstJump = 0;
        let worstOverrun = -Infinity;
        let closest = Infinity;
        let onGroundFrames = 0;
        let frames = 0;
        let lastY = con.position.y;
        const trace = [];
        /**
         * GO ROUND THE BOULDER, BECAUSE A PLAYER DOES.
         *
         * A terminal chamber's floor is breakdown — that is what a chamber IS —
         * and a block over STEP_UP is a wall the body slides along. Steering
         * straight at the far end every frame holds it against that wall for
         * ever: check-17's k=-1 sat pinned 15.5 m short for twelve hundred
         * frames, on the ground 99% of the time, and reported an unreachable
         * terminus. That is a steering failure in this script with exactly the
         * signature of a real one, which is the trap `cave-walk` records three
         * separate versions of.
         *
         * NEARLY A RIGHT ANGLE, because a smaller one does not escape. The step
         * rule gives back the WHOLE horizontal move whenever the floor at the new
         * position is more than STEP_UP above the old, so any heading with a
         * forward component still lands on the block and is still reverted —
         * veering 0.8 rad was measured doing nothing at all for twelve hundred
         * frames. 1.45 rad is walking along the face of it, which is what gets
         * you round. The offset alternates side so a body that picks the wrong
         * way tries the other.
         */
        let stuck = 0;
        let veer = 0;
        let side = 1;
        let lastX = con.position.x;
        let lastZ = con.position.z;
        con.keys.add('KeyW');
        const t0 = performance.now();
        while (performance.now() - t0 < seconds * 1000) {
          const bi = nearest(con.position.x, con.position.z);
          /**
           * STEER AT THE FURTHEST RING YOU CAN STILL SEE, NOT AT A FIXED FIVE.
           *
           * Five rings is 3.6 m, which is inside the body's own stopping
           * distance and well inside a corner. On a passage that runs straight
           * that costs nothing — the ring 3.6 m ahead is on the same bearing as
           * the one 20 m ahead — and on a passage that bends it aims at a point
           * the body cannot travel to in a straight line, so the wall push takes
           * the whole of the component that would have got there and the body
           * slides along the rock at full speed. It never triggers the veer
           * escape below either, because it IS moving; it is just not moving
           * forward. Measured: pinned 6.3 m short of the terminus for the whole
           * twelve seconds, at v 4.3, with two and a half metres of passage
           * across.
           *
           * `cave-walk` has this fix already and its block records the three
           * versions it took to get there. This is the same test — the furthest
           * ring whose straight line from HERE stays inside the passage — and it
           * is what a person does: you steer at the last thing you can see down
           * the passage, and at a corner that is the corner.
           */
          const lo = Math.max(bi + 3, from + 2);
          const fits = (t) => {
            const dx = p.x[t] - con.position.x;
            const dz = p.z[t] - con.position.z;
            const len2 = dx * dx + dz * dz;
            if (len2 < 1e-6) return false;
            for (let m = bi + 1; m < t; m++) {
              const ex = p.x[m] - con.position.x;
              const ez = p.z[m] - con.position.z;
              const u = Math.max(0, Math.min(1, (ex * dx + ez * dz) / len2));
              const ox = ex - dx * u;
              const oz = ez - dz * u;
              const fit = p.r[m] * Math.min(p.w[m], p.t[m]) * 0.62;
              if (ox * ox + oz * oz > fit * fit) return false;
            }
            return true;
          };
          let j = Math.min(end, lo);
          for (let t = j + 1; t <= Math.min(end, bi + 24); t++) {
            if (!fits(t)) break;
            j = t;
          }
          const moved = Math.hypot(con.position.x - lastX, con.position.z - lastZ);
          lastX = con.position.x;
          lastZ = con.position.z;
          stuck = moved < 0.02 ? stuck + 1 : 0;
          if (veer > 0) veer--;
          else if (stuck > 20) {
            veer = 45;
            side = -side;
            stuck = 0;
          }
          con.yaw =
            Math.atan2(-(p.x[j] - con.position.x), -(p.z[j] - con.position.z)) +
            (veer > 0 ? side * 1.45 : 0);
          await raf();
          frames++;
          const y = con.position.y;
          const jump = Math.abs(y - lastY);
          lastY = y;
          const over = overrunAt(con.position.x, con.position.z);
          const g = terrain.groundUnder(con.position.x, con.position.z);
          if (jump > worstJump) worstJump = jump;
          if (over > worstOverrun) worstOverrun = over;
          if (con.inCave < minInside) minInside = con.inCave;
          if (Math.abs(over) < closest) closest = Math.abs(over);
          if (con.onGround) onGroundFrames++;
          if (trace.length < 60 && frames % 12 === 0) {
            trace.push({
              t: +((performance.now() - t0) / 1000).toFixed(1),
              ring: bi,
              inCave: +con.inCave.toFixed(2),
              over: +over.toFixed(2),
              y: +y.toFixed(1),
              // How far the body is off the terrain surface. Underground this is
              // tens of metres; a fall through to `groundUnder` makes it zero.
              underRock: +(g - y).toFixed(1),
              jump: +jump.toFixed(3),
              /**
               * The three numbers that say WHICH constraint stopped the body.
               *
               * Every stall this feature has produced looks identical from
               * outside — full velocity, no displacement — and the controller
               * publishes these precisely so the first hour is not spent working
               * out which push is doing it. They are free here: it already reads
               * five other fields off the same object.
               */
              off: +con.caveRadial.toFixed(1),
              wall: +con.caveWall.toFixed(1),
              post: +con.cavePost.toFixed(1),
              v: +Math.hypot(con.velocity.x, con.velocity.z).toFixed(2),
            });
          }
        }
        con.keys.delete('KeyW');
        return {
          built: true,
          n,
          end,
          length: +cave.length.toFixed(0),
          lights: cave.lights.length,
          spires: cave.spires.length,
          blocks: cave.blocks.length,
          paths: cave.paths.length,
          med: +med.toFixed(2),
          termHalf: +termHalf.toFixed(2),
          termTall: +termTall.toFixed(1),
          termAt,
          ratio: +(termHalf / Math.max(med, 0.01)).toFixed(2),
          minInside: +minInside.toFixed(3),
          worstJump: +worstJump.toFixed(3),
          worstOverrun: +worstOverrun.toFixed(2),
          closest: +closest.toFixed(2),
          onGround: +(onGroundFrames / Math.max(1, frames)).toFixed(2),
          frames,
          trace,
          jumpLimit,
        };
      },
      { k: c.k, seconds: SECONDS, jumpLimit: JUMP_LIMIT }
    );

    if (!r.built) {
      console.log(`${seed} k=${c.k}  did not build`);
      rows.push({ seed, k: c.k, built: false, fails: ['not built'] });
      continue;
    }

    const fails = [];
    if (r.minInside <= 0) fails.push(`inCave reached ${r.minInside} inside the passage`);
    if (r.worstJump > JUMP_LIMIT) fails.push(`the body jumped ${r.worstJump} m in one frame`);
    if (r.worstOverrun > OVERRUN_LIMIT) fails.push(`walked ${r.worstOverrun} m past the end`);
    // A test that never arrives asserts nothing. Two and a half metres is inside
    // the terminus with the end wall in reach.
    if (r.closest > 2.5) fails.push(`never reached the terminus (closest ${r.closest} m)`);
    if (r.ratio < OPEN_RATIO) fails.push(`terminus ${r.ratio}x the feed — it tapers, it does not open`);
    rows.push({ seed, k: c.k, built: true, fails, ...r });

    console.log(
      `${seed} k=${String(c.k).padEnd(3)} ${r.length} m, ${r.n} rings, end at ${r.end}, ` +
        `${r.paths} passage(s), ${r.lights} lights, ${r.spires} formations, ${r.blocks} blocks`
    );
    console.log(
      `    terminus  half-width ${r.termHalf} m vs ${r.med} m feed (${r.ratio}x), ` +
        `${r.termTall} m floor to ceiling, at ring ${r.termAt}`
    );
    console.log(
      `    drive     ${r.frames} frames, inCave low ${r.minInside}, worst frame rise ${r.worstJump} m, ` +
        `stopped ${r.worstOverrun} m past the end plane, on the ground ${(r.onGround * 100).toFixed(0)}%`
    );
    for (const s of r.trace) {
      console.log(
        `      ${String(s.t).padStart(5)}s  ring ${String(s.ring).padStart(3)}  in ${String(s.inCave).padStart(4)}` +
          `  past-end ${String(s.over).padStart(6)}  y ${String(s.y).padStart(7)}  rock over ${String(s.underRock).padStart(6)}` +
          `  rise ${s.jump}  off ${s.off}/${s.wall}  post ${s.post}  v ${s.v}`
      );
    }
    if (fails.length) for (const f of fails) console.log(`    FAIL: ${f}`);
    console.log('');
  }
  await page.close();
}

await browser.close();

const bad = rows.filter((r) => r.fails.length);
if (bad.length) {
  console.log(`FAIL: ${bad.length} of ${rows.length} termini`);
  for (const b of bad) console.log(`  ${b.seed} k=${b.k}: ${b.fails.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log(
    `PASS: ${rows.length} termini walked into at running speed — never left containment, ` +
      `never teleported, stopped at the end wall, and every one opens out`
  );
}
if (problems.length) {
  console.log(`\n${problems.length} console error(s):`);
  for (const p of problems.slice(0, 8)) console.log(' ', p);
}
