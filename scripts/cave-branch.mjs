import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { cavesNear, setWorldSeed } from '../src/world/terrain.js';
import { caveReady } from './_cave-ready.mjs';

/**
 * CAN YOU GET INTO THE SIDE PASSAGES — the question `cave-walk` never asks.
 *
 * `cave-walk` presses W at a MOUTH and reports how far down the main line the
 * body gets. `_cave-stats` counts the branches and measures their length. Both
 * pass while the entire branch system is unreachable, because neither of them
 * ever stands at a junction and turns.
 *
 * The report from the room was "only the main tunnels I can enter; the
 * subsystems I cannot see", which is two claims that need separating and can
 * only be separated by measurement:
 *
 *   THE APERTURE. A junction is a hole cut in the main tube's lattice, sized in
 *   `buildBranch` from the branch's ring-zero ellipse. If that hole is smaller
 *   than a person the branch is a window rather than a doorway, and from the
 *   main passage it reads as a dark patch on the wall. `holeH`/`holeW` below
 *   are that hole in metres, printed beside the bore behind it.
 *
 *   THE PINCH. `burySkylights` shrinks a branch's radius wherever the hillside
 *   is thin, and it runs from ring 1 — so the narrowest section of a branch is
 *   very often in its first few metres, right behind the opening. `minH` is the
 *   worst floor-to-ceiling anywhere before `endRing`, with the ring it is at.
 *
 *   THE WALK. Everything above is geometry, and geometry has been wrong about
 *   this before. So the body is seated on the main axis at the junction ring and
 *   holds W with the yaw steered down the BRANCH, exactly as `cave-walk` steers
 *   down the main line, and what is reported is how many metres of branch it
 *   covered before it stopped.
 *
 *   node scripts/cave-branch.mjs [--seeds=grove-01,grove-02] [--caves=2] [--seconds=14]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const SEEDS = (args.seeds ?? 'grove-01,grove-02').split(',');
const CAVES = Number(args.caves ?? 2);
const SECONDS = Number(args.seconds ?? 14);
const SHOTS = args.shots === 'true';
const OUT = resolve(process.cwd(), args.out ?? '.shots/branch');
/**
 * How far in counts as entered. Deliberately not a fraction of the branch: a
 * blind lead is allowed to be twelve metres long and a player who walks all
 * twelve has entered it. What is being caught is a branch you bounce off.
 */
const IN = 12;
if (SHOTS) mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
await page.routeWebSocket(/.*/, () => {});

const rows = [];
for (const seed of SEEDS) {
  setWorldSeed(seed);
  const near = cavesNear(0, 0, 900).slice(0, CAVES);
  if (!near.length) continue;
  await page.goto(`${URL}?seed=${seed}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
  await page.click('#enter');
  await page.waitForSelector('#gate.gone', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const t = document.getElementById('toast');
    const h = document.getElementById('help');
    if (t) t.style.display = 'none';
    if (h) h.style.display = 'none';
  });

  for (const c of near) {
    /**
     * The cave has to be built before the body is put in it, and it will not
     * build until something is near enough to ask. Flying to the mouth is the
     * cheapest way to ask; `caveReady` then waits on the build itself rather
     * than on a frame count. See the note in `_cave-stats.mjs`.
     */
    await page.evaluate(
      (s) => {
        const { controller, director } = window.RR;
        director.ground();
        controller.keys.clear();
        controller.fly = true;
        controller.position.set(s.x, 80, s.z);
        controller.velocity.set(0, 0, 0);
      },
      { x: c.x, z: c.z }
    );
    await caveReady(page, c.k);

    const out = await page.evaluate(
      async ({ k, seconds }) => {
        const R = window.RR;
        const raf = () => new Promise((r) => requestAnimationFrame(r));
        const con = R.controller;
        const cave = R.caves.caves.get(k);
        if (!cave?.paths) return null;
        const paths = cave.paths;
        const main = paths[0];
        /** The ring step, read off the geometry rather than imported. */
        const STEP = Math.hypot(main.x[1] - main.x[0], main.y[1] - main.y[0], main.z[1] - main.z[0]);

        /** Nearest ring on a path, in three dimensions. */
        const nearest = (p, x, y, z, hi) => {
          let best = Infinity;
          let bi = 0;
          const n = Math.min(p.x.length, hi ?? p.x.length);
          for (let i = 0; i < n; i++) {
            const d = (p.x[i] - x) ** 2 + (p.y[i] - y) ** 2 + (p.z[i] - z) ** 2;
            if (d < best) {
              best = d;
              bi = i;
            }
          }
          return bi;
        };

        const res = [];
        for (let pi = 1; pi < paths.length; pi++) {
          const br = paths[pi];
          const end = Math.min(br.endRing ?? br.x.length - 1, br.x.length - 1);
          const base = br.base;
          /**
           * THE PARENT, WHICH IS NOT ALWAYS THE MAIN LINE.
           *
           * `base` is a ring index into whatever passage this one leaves
           * through, and since leads got leads of their own that can be another
           * branch. Reading it against `paths[0]` seats the body at the same
           * ring number on the trunk — somewhere else in the mountain entirely
           * — and every sub-branch then reports as sealed. Four of twenty-two
           * did, which is exactly the count of sub-branches in the sample.
           */
          const parent = paths[br.parent ?? 0];
          const r0 = parent.r[base];

          /**
           * The aperture, in metres, against the bore immediately behind it.
           *
           * MEASURED AT THE ANGLE THE HOLE IS ACTUALLY AT. The window is centred
           * on `holePhi`, which is only zero for a branch leaving at the axis —
           * so the vertical extent is the outline's height at the top of the
           * window less its height at the bottom, not a chord about the equator.
           * The first version of this read every off-axis junction as a slot.
           */
          const wallY = (phi) => {
            const p = side0 > 0 ? phi : Math.PI - phi;
            return Math.max(-parent.f[base], parent.t[base] * Math.sin(p)) * r0;
          };
          const side0 = br.side ?? 1;
          const phiC = side0 > 0 ? br.holePhi : Math.PI - br.holePhi;
          const holeH = wallY(phiC + br.holeSpan) - wallY(phiC - br.holeSpan);
          const holeW = 2 * br.holeRings * STEP;
          const boreH = br.r[0] * (br.t[0] + br.f[0]);
          const boreW = 2 * br.r[0] * br.w[0];

          /**
           * THE STEP AT THE THRESHOLD.
           *
           * `buildBranch` welds ring zero to the main tube's AXIS height and
           * then solves `f` so the two floors meet — but `f` is clamped, so a
           * branch leaving a chamber far bigger than itself cannot reach down to
           * the chamber's floor and starts part way up the wall. That is a ledge
           * in the dark, and a ledge is indistinguishable from a sealed wall.
           */
          const mainFloor = parent.y[base] - parent.r[base] * parent.f[base];
          const brFloor = br.y[0] - br.r[0] * br.f[0];

          // The worst section anywhere a body is allowed to be, and where.
          let minH = Infinity;
          let minHAt = 0;
          let minW = Infinity;
          for (let i = 0; i <= end; i++) {
            const h = br.r[i] * (br.t[i] + br.f[i]);
            const w = 2 * br.r[i] * br.w[i];
            if (h < minH) {
              minH = h;
              minHAt = i;
            }
            if (w < minW) minW = w;
          }

          /**
           * SEAT ON THE MAIN AXIS AT THE JUNCTION, NOT IN THE BRANCH.
           *
           * Starting inside the branch would answer a different and much easier
           * question — "is there room in there" — and the complaint is about
           * getting in. So the body starts where a player meets the junction:
           * on the main line, at the junction ring, facing the hole.
           */
          con.keys.clear();
          con.fly = false;
          con.position.set(parent.x[base], parent.y[base] + 0.2, parent.z[base]);
          con.velocity.set(0, 0, 0);
          con.yaw = Math.atan2(-(br.x[2] - parent.x[base]), -(br.z[2] - parent.z[base]));
          con.pitch = 0;
          for (let i = 0; i < 45; i++) await raf();

          const seated = {
            inCave: con.inCave,
            y: con.position.y,
            onBranch: nearest(br, con.position.x, con.position.y, con.position.z, end + 1),
          };

          /**
           * Steer at the furthest ring of the BRANCH whose straight line from
           * here stays inside the passage — the same rule `cave-walk` uses on
           * the main line, and for the same reason: these passages take joint
           * corners, and a fixed lookahead points into the rock beside one.
           */
          const aim = (px, pz) => {
            const bi = (() => {
              let best = Infinity;
              let b = 0;
              for (let i = 0; i <= end; i++) {
                const d = (br.x[i] - px) ** 2 + (br.z[i] - pz) ** 2;
                if (d < best) {
                  best = d;
                  b = i;
                }
              }
              return b;
            })();
            const fits = (j) => {
              const dx = br.x[j] - px;
              const dz = br.z[j] - pz;
              const len2 = dx * dx + dz * dz;
              if (len2 < 1e-6) return false;
              for (let m = bi + 1; m < j; m++) {
                const ex = br.x[m] - px;
                const ez = br.z[m] - pz;
                const t = Math.max(0, Math.min(1, (ex * dx + ez * dz) / len2));
                const ox = ex - dx * t;
                const oz = ez - dz * t;
                const fit = br.r[m] * Math.min(br.w[m], br.t[m]) * 0.62;
                if (ox * ox + oz * oz > fit * fit) return false;
              }
              return true;
            };
            /**
             * WALK TO THE DOORWAY FIRST, THEN DOWN THE PASSAGE.
             *
             * The look-ahead below is `cave-walk`'s rule and it is the right one
             * once you are IN a passage — but a junction is met from the side,
             * and a target chosen down the branch from outside it points through
             * several metres of rock. The wall push then cancels the inward part
             * of the heading and the body slides along the parent's wall for
             * ever, three metres from an opening it never turns toward. That is
             * a steering failure in this script and it reads exactly like a
             * sealed junction, which is the one thing this script exists to tell
             * apart. So while the body is outside the bore, it aims AT the bore.
             *
             * Dropped the moment it is inside, because a target you are standing
             * on is a heading that jitters — see the same trap, from the other
             * side, in `cave-walk`.
             */
            const d0 = Math.hypot(br.x[0] - px, br.z[0] - pz);
            if (bi <= 1 && d0 > br.r[0] * br.w[0] * 0.6 + 0.8) {
              return { x: br.x[0], z: br.z[0], ring: bi };
            }
            let j = Math.min(end, bi + 3);
            for (let q = j + 1; q <= Math.min(end, bi + 16); q++) {
              if (!fits(q)) break;
              j = q;
            }
            return { x: br.x[j], z: br.z[j], ring: bi };
          };

          let deepest = 0;
          let stuck = 0;
          let worstStuck = 0;
          let last = { x: con.position.x, z: con.position.z };
          const trail = [];
          const t0 = performance.now();
          con.keys.add('KeyW');
          while (performance.now() - t0 < seconds * 1000) {
            await raf();
            const a = aim(con.position.x, con.position.z);
            const aimAt = a;
            con.yaw = Math.atan2(-(a.x - con.position.x), -(a.z - con.position.z));
            const bi = nearest(br, con.position.x, con.position.y, con.position.z, end + 1);
            const along = br.along ? br.along[bi] : bi * STEP;
            /**
             * Only counted while the body is actually NEAR the branch's line.
             * A body shoved back into the main passage is still nearest to SOME
             * branch ring, and without this the metric would report the walk as
             * having gone deep when it went nowhere.
             */
            const off = Math.hypot(br.x[bi] - con.position.x, br.z[bi] - con.position.z);
            if (off < br.r[bi] * br.w[bi] + 1.5 && along > deepest) deepest = along;
            const moved = Math.hypot(con.position.x - last.x, con.position.z - last.z);
            const prev = last;
            last = { x: con.position.x, z: con.position.z };
            stuck = moved < 0.004 ? stuck + 1 : 0;
            worstStuck = Math.max(worstStuck, stuck);
            const t = (performance.now() - t0) / 1000;
            if (trail.length === 0 || t - trail[trail.length - 1].t >= 1) {
              trail.push({
                t: Number(t.toFixed(1)),
                ring: bi,
                along: Number(along.toFixed(1)),
                off: Number(off.toFixed(1)),
                half: Number((br.r[bi] * br.w[bi]).toFixed(1)),
                inCave: Number(con.inCave.toFixed(2)),
                v: Number(Math.hypot(con.velocity.x, con.velocity.z).toFixed(2)),
                /**
                 * The three numbers `_resolveCave` publishes for exactly this.
                 * Every stall this feature has produced looks identical from
                 * outside — full velocity, no displacement — and these say
                 * which of the wall, the pillar or the floor is doing it.
                 */
                // -1 is the main line; anything else names the junction ring of
                // the branch that is governing the body.
                gov: con.cavePathBase ?? -9,
                govRing: con.caveRing ?? -1,
                wall: Number((con.caveWall ?? -1).toFixed(1)),
                radial: Number((con.caveRadial ?? -1).toFixed(1)),
                post: Number((con.cavePost ?? -1).toFixed(1)),
                step: Number((con.caveStep ?? 0).toFixed(1)),
                y: Number(con.position.y.toFixed(1)),
                floor: Number((con.caveFloor ?? 0).toFixed(1)),
                /**
                 * Where the body is trying to go against where it went. A wall
                 * push is perpendicular by construction, so a heading with any
                 * tangential component in it must produce movement; if these two
                 * disagree the thing holding the body is not the wall.
                 */
                want: Number(Math.atan2(-(aimAt.x - con.position.x), -(aimAt.z - con.position.z)).toFixed(2)),
                went: Number(Math.atan2(-(con.position.x - prev.x), -(con.position.z - prev.z)).toFixed(2)),
                moved: Number((moved * 60).toFixed(2)),
                d3: Number(
                  Math.hypot(
                    br.x[0] - con.position.x,
                    br.y[0] - con.position.y,
                    br.z[0] - con.position.z
                  ).toFixed(1)
                ),
                dy0: Number((br.y[0] - con.position.y).toFixed(1)),
                onGround: con.onGround ? 1 : 0,
              });
            }
          }
          con.keys.delete('KeyW');

          // How much light there is in there, since "cannot see" is half the report.
          let lit = 0;
          for (const l of cave.lights ?? []) {
            const bi = nearest(br, l.x, l.y, l.z, end + 1);
            const d = Math.hypot(br.x[bi] - l.x, br.y[bi] - l.y, br.z[bi] - l.z);
            if (d < br.r[bi] * br.w[bi] + 2) lit++;
          }

          res.push({
            pi,
            parent: br.parent ?? 0,
            base,
            len: br.along ? br.along[end] : end * STEP,
            rings: end,
            holeH,
            holeW,
            boreH,
            boreW,
            minH,
            minHAt,
            minW,
            step: brFloor - mainFloor,
            mainR: parent.r[base],
            brR: br.r[0],
            brF: br.f[0],
            deepest,
            worstStuck,
            seated,
            lit,
            trail,
          });
        }
        return { res, mainLen: main.along ? main.along[main.endRing ?? main.x.length - 1] : 0 };
      },
      { k: c.k, seconds: SECONDS }
    );

    if (!out) {
      console.log(`${seed} k=${c.k}  NOT BUILT`);
      continue;
    }
    console.log(
      `\n${seed} k=${c.k}  main ${out.mainLen.toFixed(0)} m, ${out.res.length} branches`
    );
    console.log(
      `  ${'br'.padEnd(6)}${'at'.padStart(5)}${'len'.padStart(7)}${'hole HxW'.padStart(13)}` +
        `${'bore HxW'.padStart(13)}${'minH'.padStart(7)}${'minW'.padStart(7)}${'step'.padStart(7)}` +
        `${'mainR'.padStart(7)}${'lights'.padStart(8)}${'walked'.padStart(9)}${'stall'.padStart(7)}`
    );
    for (const r of out.res) {
      rows.push({ seed, k: c.k, ...r });
      console.log(
        `  ${`${r.pi}${r.parent ? `<${r.parent}` : ''}`.padEnd(6)}${String(r.base).padStart(5)}${r.len.toFixed(0).padStart(6)}m` +
          `${`${r.holeH.toFixed(1)}x${r.holeW.toFixed(1)}`.padStart(13)}` +
          `${`${r.boreH.toFixed(1)}x${r.boreW.toFixed(1)}`.padStart(13)}` +
          `${r.minH.toFixed(1).padStart(7)}${r.minW.toFixed(1).padStart(7)}` +
          `${(r.step >= 0 ? '+' : '') + r.step.toFixed(1)}`.padStart(7) +
          `${r.mainR.toFixed(1).padStart(7)}` +
          `${String(r.lit).padStart(8)}${r.deepest.toFixed(0).padStart(8)}m${String(r.worstStuck).padStart(7)}`
      );
      if (r.deepest < IN) {
        console.log(
          `        stopped: ` +
            r.trail
              .filter((_, i) => i % 2 === 0)
              .map(
                (s) =>
                  `${s.t}s r${s.ring}@${s.along}m off ${s.off}/${s.half} in ${s.inCave} v${s.v}` +
                  `  gov ${s.gov === -1 ? 'main' : `br@${s.gov}`}:${s.govRing}` +
                  `  radial ${s.radial}/wall ${s.wall} post ${s.post}  y ${s.y} floor ${s.floor}` +
                  `  d3 ${s.d3} dy0 ${s.dy0}  want ${s.want} went ${s.went} moved ${s.moved} ${s.onGround ? 'ground' : 'air'}`
              )
              .join('\n                 ')
        );
      }
    }
    if (SHOTS) await page.screenshot({ path: `${OUT}/${seed}-k${c.k}.png` });
  }
}

const blocked = rows.filter((r) => r.deepest < IN);
console.log(
  `\n${rows.length} branches over ${SEEDS.length} seeds: ` +
    `${rows.length - blocked.length} entered, ${blocked.length} not.  ` +
    `mean walked ${(rows.reduce((s, r) => s + r.deepest, 0) / Math.max(1, rows.length)).toFixed(1)} m ` +
    `of ${(rows.reduce((s, r) => s + r.len, 0) / Math.max(1, rows.length)).toFixed(0)} m mean length.  ` +
    `mean aperture ${(rows.reduce((s, r) => s + r.holeH, 0) / Math.max(1, rows.length)).toFixed(1)} m tall, ` +
    `mean lights ${(rows.reduce((s, r) => s + r.lit, 0) / Math.max(1, rows.length)).toFixed(1)}`
);
if (blocked.length) {
  console.log(
    `FAIL: ${blocked.length} branch(es) not enterable: ` +
      blocked.map((b) => `${b.seed} k=${b.k} br${b.pi} (${b.deepest.toFixed(0)} m of ${b.len.toFixed(0)})`).join(', ')
  );
  process.exitCode = 1;
}
if (problems.length) console.log(`\npage errors:\n  ${problems.join('\n  ')}`);
await browser.close();
