import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { caveAxisPoint, cavesNear, setWorldSeed } from '../src/world/terrain.js';
import { caveReady } from './_cave-ready.mjs';

/**
 * Can you actually walk into one?
 *
 * Every other check in this feature measures the world from outside it:
 * `cave-check` asks whether the ground is continuous and whether a mouth is dry,
 * `cave-shots` photographs the rock. Neither of them would notice the failure
 * that matters most — a passage you cannot get into, because the terrain stands
 * a step in the doorway, or the tube's floor is below the gully's, or the wall
 * push holds you out. A cave you can only look at is a ravine.
 *
 * So this presses W.
 *
 * IT DRIVES THE REAL INPUT PATH, and that is the whole point of it. The
 * controller's key set is what the browser's keydown listener writes into, so
 * adding `KeyW` to it walks the body through gravity, the slope scaling, the
 * trunk push, the cave wall push and `caveFloorUnder` exactly as a player does.
 * Nudging `position` per frame — which is how `world-walk.mjs` covers ground,
 * and correctly, because it is measuring the streamer — would tunnel straight
 * through anything blocking the entrance and report success.
 *
 *   node scripts/cave-walk.mjs [--seed=grove-01] [--seconds=40]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots/walk');
const SEED = args.seed ?? 'grove-01';
const SECONDS = Number(args.seconds ?? 40);
/** How deep counts as "inside", in metres along the passage. */
const DEEP = 18;
mkdirSync(OUT, { recursive: true });

setWorldSeed(SEED);
const near = cavesNear(0, 0, 900);
if (!near.length) {
  console.log(`no live cave within 900 m on ${SEED}`);
  process.exit(1);
}

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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(m.text());
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
await page.routeWebSocket(/.*/, () => {});
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForSelector('#gate.gone', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2500);
await page.evaluate(() => {
  document.getElementById('toast').style.display = 'none';
  document.getElementById('help').style.display = 'none';
});

const rows = [];
for (const c of near.slice(0, 3)) {
  /**
   * Start OUTSIDE the notch, not in it.
   *
   * `aOpen` is where the gully begins; eight metres below that is open hillside,
   * so the walk covers the approach, the gully and the mouth in one go. Starting
   * at the mouth would skip the two places a player can actually get stuck.
   */
  const start = caveAxisPoint(c, c.aOpen - 8, 0);
  await page.evaluate(
    (s) => {
      const { controller, director } = window.RR;
      director.ground();
      controller.keys.clear();
      controller.fly = false;
      controller.position.set(s.x, 60, s.z);
      controller.velocity.set(0, 0, 0);
      controller.yaw = s.yaw;
      controller.pitch = 0;
    },
    { x: start.x, z: start.z, yaw: Math.atan2(-(c.x - start.x), -(c.z - start.z)) }
  );
  /**
   * The passage first, then the ground.
   *
   * The single 3 s wait this replaces was doing two jobs, and only one of them
   * has a fixed cost. The build has none — see `_cave-ready.mjs` — and when it
   * overran, `path` came back null, the walk ran with nothing to steer at, and
   * the cave was written off. The fall is the other job: the body was dropped
   * from 60 m with `fly` off, so it still needs its chunks to arrive and its
   * feet to land, and that is what the three seconds are kept for.
   */
  await caveReady(page, c.k);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/k${c.k}-0-start.png` });

  const walk = await page.evaluate(
    async ({ seconds, k }) => {
      const R = window.RR;
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      const con = R.controller;
      const cave = R.caves.caves.get(k);
      const path = cave?.path ?? null;
      const ring = path ? { x: path.x[0], y: path.y[0], z: path.z[0] } : null;
      /**
       * Steer at a point AHEAD ON THE CENTRE LINE, not at the mouth.
       *
       * Aiming at ring zero is what the first version did and it parks the body
       * in the doorway: the moment you arrive, the vector to the target is zero
       * and the heading jitters, so the walk stops on the threshold and reports
       * the cave unenterable when it may be nothing of the kind. A player aims
       * at where they are going. Twelve rings is about fourteen metres ahead —
       * far enough to round a bend, near enough to stay on the floor.
       */
      const aimAhead = (px, pz) => {
        if (!path) return null;
        const n = path.x.length;
        let best = Infinity;
        let bi = 0;
        for (let i = 0; i < n; i++) {
          const d = (path.x[i] - px) ** 2 + (path.z[i] - pz) ** 2;
          if (d < best) {
            best = d;
            bi = i;
          }
        }
        /**
         * LOOK AHEAD BY WHAT THE PASSAGE CAN AFFORD, NOT BY A FIXED TWELVE.
         *
         * Twelve rings is fourteen metres, which was right when every passage
         * was the same 6 m wide tube. It is wrong the moment a vadose canyon
         * exists: three metres across and meandering, a target fourteen metres
         * along points diagonally into the wall, the push cancels the component
         * that would have got you there, and the walk stands against the rock at
         * full speed for ever. That is a steering failure in this script and it
         * looked exactly like an unwalkable cave — one mouth of three, stalled
         * at 31 m, with a metre and a half of clearance on the reported side.
         *
         * Scaling the lookahead by the local half-width is what a person does
         * without thinking: you read further ahead in a hall than in a slot.
         */
        /**
         * AS FAR AS YOU CAN SEE, WHICH IS NOT AS FAR AS THE PASSAGE IS WIDE.
         *
         * Scaling the lookahead by the local half-width was the previous
         * version's answer, and it fixed the canyon and left the CORNER. These
         * passages are cut on joints: they run straight for thirty metres and
         * then take something close to a right angle (see the joint block in
         * caves.js), and eight rings ahead of a corner is a point on the far
         * side of the rock. The body then walks into the wall beside the corner
         * at full speed, for ever — one mouth of three, pinned at 12.5 m with
         * three metres of clear passage to its left, and no stall to show for it
         * because it was sliding along the face the whole time.
         *
         * So the target is the furthest ring whose straight line from HERE stays
         * inside the passage: exactly the test `blindAlong` runs, from the body
         * instead of from ring zero. It is also what a person does — you steer
         * at the last thing you can see down the passage, and at a corner that
         * is the corner.
         */
        const fits = (j) => {
          const dx = path.x[j] - px;
          const dz = path.z[j] - pz;
          const len2 = dx * dx + dz * dz;
          if (len2 < 1e-6) return false;
          for (let m = bi + 1; m < j; m++) {
            const ex = path.x[m] - px;
            const ez = path.z[m] - pz;
            const t = Math.max(0, Math.min(1, (ex * dx + ez * dz) / len2));
            const ox = ex - dx * t;
            const oz = ez - dz * t;
            const fit = path.r[m] * Math.min(path.w[m], path.t[m]) * 0.62;
            if (ox * ox + oz * oz > fit * fit) return false;
          }
          return true;
        };
        let j = Math.min(n - 1, bi + 3);
        for (let c = j + 1; c <= Math.min(n - 1, bi + 14); c++) {
          if (!fits(c)) break;
          j = c;
        }
        return { x: path.x[j], z: path.z[j], ring: bi };
      };
      const samples = [];
      let best = 0;
      let bestAt = 0;
      let stuckFor = 0;
      let worstStuck = 0;
      let last = { x: con.position.x, z: con.position.z };
      let lastAim = -1;
      let entered = false;
      let lastYaw = con.yaw;
      const t0 = performance.now();
      con.keys.add('KeyW');
      while (performance.now() - t0 < seconds * 1000) {
        await raf();
        /**
         * Re-aim every frame — at the mouth until we are near it, then along
         * the passage. A player steers; a script holding one heading walks into
         * the wall of the gully on the first bend. Yaw only: nothing here
         * touches the position, the height or the velocity.
         */
        /**
         * ONCE IN, ALWAYS FOLLOW THE PASSAGE — the latch is not a detail.
         *
         * The switch from "aim at the mouth" to "aim along the tube" was on
         * distance to ring zero, which is a circle the body sits exactly on
         * twelve metres in: it aimed inward on one frame and back out at the
         * doorway on the next, the damped velocity cancelled itself, and the
         * walk stopped dead. All three mouths reported the identical depth,
         * which is the signature of a threshold in the SCRIPT rather than
         * anything in the world — no two caves agree to a decimetre about
         * anything real.
         */
        if (con.inCave > 0.2) entered = true;
        const aim = entered ? aimAhead(con.position.x, con.position.z) : ring;
        if (aim) con.yaw = Math.atan2(-(aim.x - con.position.x), -(aim.z - con.position.z));
        lastAim = aim && aim.ring !== undefined ? aim.ring : -1;
        lastYaw = con.yaw;
        const moved = Math.hypot(con.position.x - last.x, con.position.z - last.z);
        last = { x: con.position.x, z: con.position.z };
        stuckFor = moved < 0.004 ? stuckFor + 1 : 0;
        worstStuck = Math.max(worstStuck, stuckFor);
        const t = (performance.now() - t0) / 1000;
        if (con.caveDepth > best) {
          best = con.caveDepth;
          bestAt = t;
        }
        if (samples.length < 200 && (samples.length === 0 || t - samples[samples.length - 1].t >= 0.5)) {
          samples.push({
            t: Number(t.toFixed(1)),
            y: Number(con.position.y.toFixed(1)),
            inCave: Number(con.inCave.toFixed(2)),
            depth: Number(con.caveDepth.toFixed(1)),
            ground: Number(con.onGround ? 1 : 0),
            // Where the body is RELATIVE TO THE DOORWAY, which is the only way
            // to tell "blocked at the mouth" from "never got there".
            d0: ring
              ? Number(Math.hypot(ring.x - con.position.x, ring.z - con.position.z).toFixed(1))
              : -1,
            dy: ring ? Number((con.position.y - ring.y).toFixed(1)) : -1,
            /**
             * The passage's own geometry where the body is, so a stall can be
             * read rather than guessed: how far off the centre line it is
             * against how wide the tube is there, and how much headroom is left.
             */
            ...(() => {
              if (!path) return {};
              const n = path.x.length;
              let bd = Infinity;
              let bi = 0;
              for (let i = 0; i < n; i++) {
                const d =
                  (path.x[i] - con.position.x) ** 2 +
                  (path.y[i] - con.position.y) ** 2 +
                  (path.z[i] - con.position.z) ** 2;
                if (d < bd) {
                  bd = d;
                  bi = i;
                }
              }
              const r = path.r[bi];
              return {
                ring: bi,
                off: Number(
                  Math.hypot(path.x[bi] - con.position.x, path.z[bi] - con.position.z).toFixed(1)
                ),
                wall: Number((r * 1.3).toFixed(1)),
                head: Number((path.y[bi] + r * 0.98 - con.position.y).toFixed(1)),
                floor: Number((con.position.y - (path.y[bi] - r * 0.52)).toFixed(1)),
              };
            })(),
            speed: Number(con.speed.toFixed(2)),
            v: Number(Math.hypot(con.velocity.x, con.velocity.z).toFixed(2)),
            keys: [...con.keys].join('+') || '-',
            scale: Number((con.speedScale ?? 1).toFixed(2)),
            aim: lastAim,
            yaw: Number(lastYaw.toFixed(2)),
            vdir: Number(Math.atan2(-con.velocity.x, -con.velocity.z).toFixed(2)),
          });
        }
      }
      con.keys.delete('KeyW');
      return { samples, best, bestAt, worstStuck, streamed: R.caves.caves.size, built: !!cave?.ready };
    },
    { seconds: SECONDS, k: c.k }
  );

  await page.screenshot({ path: `${OUT}/k${c.k}-1-end.png` });
  const deep = walk.samples.filter((s) => s.depth >= DEEP).length;
  rows.push({ k: c.k, ...walk, deep });
  console.log(
    `k=${String(c.k).padEnd(3)} built=${walk.built}  deepest ${walk.best.toFixed(1)} m at ` +
      `${walk.bestAt.toFixed(0)} s  ${deep} of ${walk.samples.length} samples past ${DEEP} m  ` +
      `longest stall ${walk.worstStuck} frames`
  );
  for (const s of walk.samples.filter((_, i) => i % 4 === 0)) {
    console.log(
      `      ${String(s.t).padStart(5)}s  depth ${String(s.depth).padStart(5)}  in ${String(s.inCave).padStart(4)}` +
        `  ring ${String(s.ring ?? -1).padStart(3)}  off ${String(s.off ?? -1).padStart(4)}/${s.wall ?? -1}` +
        `  head ${String(s.head ?? -1).padStart(5)}  overfloor ${String(s.floor ?? -1).padStart(5)}` +
        `  speed ${String(s.speed).padStart(5)}/${String(s.v).padStart(5)} x${s.scale}  aim ${s.aim}  yaw ${s.yaw}/${s.vdir}  ${s.ground ? "ground" : "air"}`
    );
  }
}

const failed = rows.filter((r) => r.best < DEEP);
if (failed.length) {
  console.log(
    `\nFAIL: ${failed.length} of ${rows.length} mouths were not walkable — ` +
      `never got ${DEEP} m in: ${failed.map((f) => `k=${f.k} (${f.best.toFixed(1)} m)`).join(', ')}`
  );
  process.exitCode = 1;
} else {
  console.log(`\nPASS: every mouth walked into, past ${DEEP} m, holding W`);
}
if (problems.length) {
  console.log(`\n${problems.length} console error(s):`);
  for (const p of problems.slice(0, 8)) console.log(' ', p);
}
await browser.close();
