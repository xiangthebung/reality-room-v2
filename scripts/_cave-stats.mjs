import { chromium } from 'playwright';
import { caveAxisPoint, cavesNear, setWorldSeed } from '../src/world/terrain.js';

/**
 * WHAT SHAPE IS THE SYSTEM, IN NUMBERS RATHER THAN IN PICTURES.
 *
 * Every other cave script in here either photographs a passage or asserts one
 * property of it. Neither answers the questions you ask when you are changing
 * the WALK — how much does it turn, how many ways on are there, how big is the
 * biggest space and is any of it out of the light — because those are
 * distributions over the whole system rather than facts about one ring.
 *
 * Reported per seed and summarised across them:
 *
 *   TURNING. Total heading change per 100 m of passage, and the count of
 *   corners over 45 degrees. A worm and a joint walk have the same length and
 *   very different numbers here, and "more twists and turns" is exactly this.
 *
 *   SUBSYSTEMS. Passages per cave, metres of branch against metres of trunk,
 *   and how many junctions a walker actually passes.
 *
 *   SCALE. The tallest floor-to-ceiling anywhere, the widest span, and how many
 *   metres of passage stand over 15 m tall — one enormous ring is a statistic,
 *   a run of them is a chamber.
 *
 *   node scripts/_cave-stats.mjs [--seeds=grove-01,grove-02] [--caves=2]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const SEEDS = (args.seeds ?? 'grove-01,grove-02,grove-03,grove-04').split(',');
const CAVES = Number(args.caves ?? 2);

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
  ],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const problems = [];
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
await page.routeWebSocket(/.*/, () => {});

const all = [];
for (const seed of SEEDS) {
  setWorldSeed(seed);
  const near = cavesNear(0, 0, 900).slice(0, CAVES);
  if (!near.length) continue;
  await page.goto(`${URL}?seed=${seed}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
  await page.click('#enter');
  await page.waitForSelector('#gate.gone', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  for (const c of near) {
    const start = caveAxisPoint(c, c.aOpen - 6, 0);
    await page.evaluate(
      (s) => {
        const { controller, director } = window.RR;
        director.ground();
        controller.keys.clear();
        controller.fly = true;
        controller.position.set(s.x, 60, s.z);
        controller.velocity.set(0, 0, 0);
      },
      { x: start.x, z: start.z }
    );
    /**
     * SETTLE ON THE CAVE BEING BUILT, NOT ON A FRAME COUNT. `prepare` is a
     * sliced generator over several frames and a fixed wait photographs
     * whatever stage it happened to reach — see the note in `_inside.mjs`'s
     * sibling scripts about half-arrived worlds.
     */
    await page
      .waitForFunction((k) => window.RR.caves.caves.get(k)?.ready === true, c.k, {
        timeout: 60000,
        polling: 250,
      })
      .catch(() => {});

    const r = await page.evaluate((k) => {
      const cave = window.RR.caves.caves.get(k);
      if (!cave?.paths) return null;
      const TAU = Math.PI * 2;
      const stat = { paths: cave.paths.length, per: [] };
      for (let pi = 0; pi < cave.paths.length; pi++) {
        const p = cave.paths[pi];
        const n = p.x.length;
        let len = 0;
        let turn = 0;
        let corners = 0;
        let prevH = null;
        /**
         * Heading sampled every 4 m rather than every ring. At 0.72 m the ring
         * step is finer than the displacement on the centre line, so a per-ring
         * sum measures the resample's own wobble and reports a straight tube as
         * turning 300 degrees per 100 m.
         */
        const STRIDE = Math.max(1, Math.round(4 / 0.72));
        let run = 0;
        for (let i = 1; i < n; i++) {
          len += Math.hypot(p.x[i] - p.x[i - 1], p.y[i] - p.y[i - 1], p.z[i] - p.z[i - 1]);
          if (i % STRIDE) continue;
          const a = i - STRIDE;
          const h = Math.atan2(p.z[i] - p.z[a], p.x[i] - p.x[a]);
          if (prevH !== null) {
            const d = Math.abs(((h - prevH + Math.PI) % TAU + TAU) % TAU - Math.PI);
            turn += d;
            run += d;
            // A corner is turning accumulated over a short distance, not one
            // sample: a 90-degree joint change is spread over the spline's own
            // 8-14 m and never appears as one big step.
            if (run > 0.785) {
              corners++;
              run = 0;
            }
          } else run = 0;
          prevH = h;
        }
        let tall = 0;
        let wide = 0;
        let tallM = 0;
        let vastM = 0;
        for (let i = 1; i < n; i++) {
          const step = Math.hypot(p.x[i] - p.x[i - 1], p.y[i] - p.y[i - 1], p.z[i] - p.z[i - 1]);
          const h = p.r[i] * (p.t[i] + p.f[i]);
          const w = 2 * p.r[i] * p.w[i];
          if (h > tall) tall = h;
          if (w > wide) wide = w;
          if (h > 15) tallM += step;
          if (h > 25) vastM += step;
        }
        stat.per.push({
          pi,
          len,
          turnPer100: len > 1 ? (turn * 180) / Math.PI / (len / 100) : 0,
          corners,
          tall,
          wide,
          tallM,
          vastM,
        });
      }
      /**
       * DOES THE PASSAGE COME BACK ON ITSELF, AND HOW BADLY.
       *
       * Two different questions, and only one of them is a bug. OVERLAP is two
       * rings whose sections share volume — a hole in the wall with the back of
       * another wall behind it, which is what the walk's clash test exists to
       * reject. STACKING is two rings that are far apart in Y and near in PLAN,
       * which is a multi-level system and is what real caves do; it is only a
       * hazard because several things in this project find geometry by
       * horizontal distance alone.
       */
      /**
       * ALONG THE LINE, NOT IN RING INDEX, AND THAT IS NOT A DETAIL.
       *
       * The first version of this counted any pair forty rings apart whose
       * sections shared volume, and it reported a chamber as a fault. A hall is
       * 35 m of half-width; forty rings is 29 m of line; so the passage walking
       * out of its own chamber is inside the chamber's footprint by
       * construction, and the metric scored the seeds with the biggest halls
       * worst. It read as an overlap regression caused by making the chambers
       * bigger, which is exactly backwards.
       *
       * A crossing is two parts of the line that are near in SPACE and far along
       * the LINE, and "far" has to be measured against how big they are — twice
       * the two half-widths plus twenty metres. Below that they are the same
       * space seen twice.
       */
      let overlap = 0;
      let stacked = 0;
      let worst = null;
      for (let pi = 0; pi < cave.paths.length; pi++) {
        const p = cave.paths[pi];
        const n = p.x.length;
        const al = p.along;
        if (!al) continue;
        for (let i = 0; i < n; i += 4) {
          for (let j = i + 20; j < n; j += 4) {
            const dx = p.x[i] - p.x[j];
            const dy = p.y[i] - p.y[j];
            const dz = p.z[i] - p.z[j];
            const reach = p.r[i] * p.w[i] + p.r[j] * p.w[j];
            if (al[j] - al[i] < reach * 2 + 20) continue;
            if (dx * dx + dy * dy + dz * dz < reach * reach) {
              overlap++;
              const d = Math.hypot(dx, dy, dz);
              if (worst === null || reach - d > worst.by) {
                worst = {
                  pi,
                  i,
                  j,
                  by: reach - d,
                  d: +d.toFixed(1),
                  reach: +reach.toFixed(1),
                  along: +(al[j] - al[i]).toFixed(0),
                  dy: +dy.toFixed(1),
                };
              }
            }
            if (dx * dx + dz * dz < reach * reach && Math.abs(dy) > 6) stacked++;
          }
        }
      }
      /**
       * THE GRAPH, WHICH IS THE ONE THING THIS FILE COULD NEVER SEE.
       *
       * Every number above is about METRES — how long, how twisty, how tall —
       * and the room's complaint was never about metres. "It looks like one
       * continuous tunnel rather than having cave-like subsystems" is a
       * statement about TOPOLOGY, and until loop closure existed the topology
       * of every cave in this world was a tree, so nothing was tempted to
       * measure it.
       *
       * The vertices are the mouth, every junction, and every dead end. The
       * edges are the stretches of passage between them. In a tree E = V - 1
       * exactly, so the cyclomatic number `alpha = E - V + 1` is zero for every
       * cave this project has ever built; each closure adds one edge without
       * adding a passage end, so it adds exactly one to alpha.
       *
       * WHAT THE NUMBERS SHOULD BE, and they are surveyed rather than chosen.
       * Collon et al. 2017 (34 systems) and Jouves et al. 2017 (26 systems,
       * 621 km) both put real caves' mean vertex degree between 1.8 and 2.6,
       * and junctions of degree four or more are scarce in nature. So: alpha
       * just above zero, k near 2, one to three closures a cave. A run where
       * alpha climbs past 4 or k past 2.6 is not a better cave, it is a maze —
       * Paris et al. 2021 report their own generator overshooting exactly that
       * way, and this is the number that would have told them.
       *
       * A closure's own weld ring is counted into `len` twice over, once here
       * and once in the passage it welds into. That is at most the LOOP_COLLAR
       * of rings — under four metres per closure — so it moves `totalLen` by
       * a fraction of a per cent and cannot move `tallM` or `vastM` at all,
       * because a weld is bounded to 0.85 of the bore it enters and no bore in
       * this world is 30 m across.
       */
      /**
       * CAN YOU GET OUT, AND HOW FAR IS THE WALK — WHICH IS THE ONE PROPERTY
       * "EASY TO GET LOST IN" IS ALLOWED TO COST NOTHING.
       *
       * `toExit` is the shortest route to daylight from every ring, through the
       * passages, relaxed over the junctions and the loop welds — see the block
       * in `prepare`. Two numbers come out of it and they answer different
       * questions. `sealed` is rings with no route at all, and it is the one that
       * must be zero: a single one of those is a player who cannot leave, which
       * in a social hangout is somebody quitting. `far` is the longest walk out
       * anybody can be facing, and it is allowed to be large — being a long way
       * from the door is the feature, being unable to reach it is the failure.
       */
      let far = 0;
      let sealed = 0;
      for (const p of cave.paths) {
        if (!p.toExit) {
          sealed = -1;
          break;
        }
        for (let i = 0; i < p.toExit.length; i++) {
          if (!Number.isFinite(p.toExit[i])) sealed++;
          else if (p.toExit[i] > far) far = p.toExit[i];
        }
      }

      const closures = [];
      for (let pi = 1; pi < cave.paths.length; pi++) {
        const q = cave.paths[pi];
        if (q.loopEnd && q.loopToIndex >= 0) {
          closures.push({ from: pi, to: q.loopToIndex, ring: q.loopRing });
        }
      }
      const deg = new Map();
      const bump = (key, by) => deg.set(key, (deg.get(key) ?? 0) + by);
      // The mouth, one end of the trunk.
      bump('mouth', 1);
      let edges = 1;
      for (let pi = 0; pi < cave.paths.length; pi++) {
        const q = cave.paths[pi];
        // A passage's far end is a vertex of degree 1 unless it welds into one.
        if (!q.loopEnd) bump(`end${pi}`, 1);
      }
      for (let pi = 1; pi < cave.paths.length; pi++) {
        const q = cave.paths[pi];
        // A junction: the host's line continues through it and the lead leaves.
        bump(`j${pi}`, 3);
        edges += 2;
      }
      for (const cl of closures) {
        bump(`c${cl.from}`, 3);
        edges += 2;
      }
      let vsum = 0;
      for (const v of deg.values()) vsum += v;
      const V = deg.size;
      const E = edges;
      const trunk = stat.per[0];
      const branchLen = stat.per.slice(1).reduce((s, x) => s + x.len, 0);
      /**
       * THE BRANCHES' OWN TURNING, WEIGHTED BY LENGTH.
       *
       * Reported separately because the two are tuned against completely
       * different budgets and averaging them hides both. On the trunk a corner
       * is paid for in metres, and metres are depth, and depth is the chambers
       * — measured at a quarter of the tall passage for a ninth more turning.
       * A branch has no depth envelope and no chamber to lose, so a corner
       * there costs a refusal and nothing else. A change that raises this
       * number and leaves the trunk's alone is the trade that was wanted.
       */
      const branchTurn =
        branchLen > 1
          ? stat.per.slice(1).reduce((s, x) => s + x.turnPer100 * x.len, 0) / branchLen
          : 0;
      return {
        paths: stat.paths,
        closures: closures.length,
        alpha: E - V + 1,
        kbar: V ? vsum / V : 0,
        loops: closures.map((cl) => `p${cl.from}->p${cl.to}@${cl.ring}`),
        trunkLen: trunk.len,
        branchLen,
        totalLen: trunk.len + branchLen,
        turnPer100: trunk.turnPer100,
        branchTurn,
        corners: trunk.corners,
        tall: Math.max(...stat.per.map((x) => x.tall)),
        wide: Math.max(...stat.per.map((x) => x.wide)),
        tallM: stat.per.reduce((s, x) => s + x.tallM, 0),
        vastM: stat.per.reduce((s, x) => s + x.vastM, 0),
        blocks: cave.blocks.length,
        tris: cave.mesh ? cave.mesh.geometry.index.count / 3 : 0,
        overlap,
        stacked,
        worst,
        far,
        sealed,
        /**
         * THE BUILD'S OWN ACCOUNT OF ITSELF, WHICH IS NOT DERIVABLE FROM HERE.
         *
         * Everything above is measured off the drawn rings, and there are two
         * questions about the walk that the rings cannot answer at all.
         *
         * The first is how many junctions were PLANNED. A branch that
         * `buildBranch` refused leaves no trace in the geometry — the cursor
         * moves on and the passage looks exactly like a passage that never
         * asked. So a cave that wanted eight and built three is indistinguishable
         * here from a cave that wanted three, and the room's "it lacks cave-like
         * subsystems" lived in that gap for as long as the gap was invisible.
         * `branchStats` is the ledger; see the block over it in caves.js.
         *
         * The second is the hold probability the walk actually realised. The
         * turning measured above is after the resample has splined the joints
         * and after the burial has deleted whole stretches, so it cannot be
         * compared against the constant in the file. `walkStats.holdSum /
         * holdN` can, and it is the number that must not fall when the hold rule
         * is touched — because every hundredth off it comes out of the length,
         * and the length is the chambers.
         */
        branch: cave.branchStats ?? null,
        walk: cave.walkStats ?? null,
      };
    }, c.k);
    if (!r) {
      console.log(`${seed} k=${c.k}  NOT BUILT`);
      continue;
    }
    all.push(r);
    console.log(
      `${seed} k=${String(c.k).padStart(2)}  ${r.paths} passages  ` +
        `${r.totalLen.toFixed(0)} m (${r.branchLen.toFixed(0)} branch)  ` +
        `turn ${r.turnPer100.toFixed(0)}/${r.branchTurn.toFixed(0)} deg/100m  ${r.corners} corners  ` +
        `tallest ${r.tall.toFixed(1)} m  widest ${r.wide.toFixed(1)} m  ` +
        `${r.tallM.toFixed(0)} m over 15 m tall, ${r.vastM.toFixed(0)} m over 25  ` +
        `${r.tris} tris  overlap ${r.overlap} stacked ${r.stacked}` +
        (r.worst ? `
    worst: p${r.worst.pi} rings ${r.worst.i}-${r.worst.j}  ${r.worst.along} m apart along the line, ${r.worst.d} m apart in space against ${r.worst.reach} m of section (dy ${r.worst.dy})` : '')
    );
    if (r.branch) {
      const b = r.branch;
      console.log(
        `    junctions: wanted ${b.want}, tried ${b.tried}, built ${b.built}` +
          `  (${b.tried ? ((100 * b.built) / b.tried).toFixed(0) : '—'}% of tried, ` +
          `${b.want ? ((100 * b.built) / b.want).toFixed(0) : '—'}% of wanted)` +
          `  refused: ${b.wall} no wall / ${b.short} too few nodes / ${b.buried} buried` +
          `  |  subs: wanted ${b.subWant} tried ${b.subTried} built ${b.subBuilt}` +
          ` (${b.subWall}/${b.subShort}/${b.subBuried})` +
          /**
           * `looped` IS A SUBSET OF `built`, NOT A FOURTH REFUSAL, and the
           * ledger's own invariant is unchanged by it:
           *   tried = built + wall + short + buried
           * A lead whose closure search finds nothing is a lead, and it is
           * counted as built like any other. What `loopWant - looped` measures
           * is closures asked for and not found, which is a fact about the rock.
           */
          `  |  loops: wanted ${b.loopWant ?? 0}, closed ${(b.looped ?? 0) + (b.subLooped ?? 0)}` +
          ` (${b.looped ?? 0} off the trunk, ${b.subLooped ?? 0} off a lead)`
      );
      /**
       * THE BIG ROOMS, AND HOW MANY WAYS ON THEY HAVE.
       *
       * "In big rooms there should be 3-4 cave subsystems so it's hard to tell
       * where you came from" is the room's request, and it is not derivable from
       * anything above: a junction and a chamber are both visible in the ring
       * arrays and whether they are the SAME PLACE is not. `atChamber` is
       * junctions whose base ring is inside a chamber run; `extra` is the ways
       * on those chambers were given beyond the first.
       *
       * The degree of a chamber that got its full allowance is four: the passage
       * in, the passage on, its own junction, and one extra. Two extras is five,
       * which is the top of the range asked for. This line is where a change
       * that quietly stopped finding chambers would show up as a zero.
       */
      console.log(
        `    chambers: ${b.atChamber ?? 0} junction(s) inside a chamber, ` +
          `${b.chambers ?? 0} of them given extra ways on ` +
          `(${b.extra ?? 0} built of ${b.extraTried ?? 0} tried of ${b.extraWant ?? 0} wanted)`
      );
    }
    /**
     * WHICH CONSTRAINT IS BINDING, WHICH IS NOT THE SAME QUESTION AS "HOW MANY
     * CLOSED".
     *
     * `closed 0` says the search failed and says nothing about why, and there
     * are seven places it can. The counters partition the rings examined in the
     * order the tests run, so the largest one is the answer — and the two
     * numbers that are not counters are the ones that say what to do about it.
     * `nearest` is the closest any lead's head ever came to another passage,
     * whatever else was wrong: if that is over LOOP_FAR then no bar is binding
     * and these branches simply do not reach, which is a fact about the mountain
     * and not a constant to move. `bestCirc` is the largest circuit available at
     * a legal distance, so `bestCirc` under the bar means the bar is the answer
     * and `bestCirc` well over it means something later is.
     */
    if (r.branch?.loopWhy?.offers) {
      const w = r.branch.loopWhy;
      console.log(
        `    loop search: ${w.offers} lead(s) offered, ${w.scan} rings scanned, ` +
          `${w.pass} shortlisted, ${w.ok} closed` +
          `
      refused: ${w.base} at the base doorway / ${w.far} out of the ` +
          `10-42 m band / ${w.dive} too steep / ${w.span} circuit too short / ` +
          `${w.wall} no wall / ${w.skew} arriving side-on` +
          `
      paid:    ${w.bore} bore too small / ${w.reach} connector length / ` +
          `${w.roof} no rock over the connector / ${w.clash} clashed` +
          `
      best available: nearest passage ${Number.isFinite(w.nearest) ? w.nearest.toFixed(0) : '—'} m, ` +
          `enclosure ${w.bestSpan.toFixed(0)} m, circuit ${w.bestCirc.toFixed(0)} m (bar is 90)`
      );
    }
    console.log(
      `    graph: alpha ${r.alpha}, mean degree ${r.kbar.toFixed(2)}, ` +
        `${r.closures} closure(s)${r.loops.length ? ` — ${r.loops.join(', ')}` : ''}` +
        `  (real systems: alpha just over 0, degree 1.8-2.6)` +
        `  |  way out: longest walk to daylight ${r.far.toFixed(0)} m, ` +
        `${r.sealed === 0 ? 'no sealed rings' : `${r.sealed} SEALED RINGS`}`
    );
    if (r.walk) {
      const w = r.walk;
      console.log(
        `    walk: ${w.nodes} nodes, ${w.corners} corners (${w.nodes ? ((100 * w.corners) / w.nodes).toFixed(0) : '—'}%), ` +
          `${w.escapes} by the escape hatch;  mean hold ${w.holdN ? (w.holdSum / w.holdN).toFixed(3) : '—'}` +
          `  mean rockGen ${w.rockN ? (w.genSum / w.rockN).toFixed(3) : '—'}` +
          `  mean overburden ${w.rockN ? (w.rockSum / w.rockN).toFixed(1) : '—'} m` +
          `  |  ${w.corners ? (r.trunkLen / w.corners).toFixed(1) : '—'} m of trunk per corner`
      );
    }
  }
}

const mean = (f) => (all.length ? all.reduce((s, x) => s + f(x), 0) / all.length : 0);
console.log(
  `\n${all.length} caves:  ` +
    `${mean((x) => x.paths).toFixed(1)} passages  ` +
    `${mean((x) => x.totalLen).toFixed(0)} m  ` +
    `turn ${mean((x) => x.turnPer100).toFixed(0)} trunk / ${mean((x) => x.branchTurn).toFixed(0)} branch deg/100m  ` +
    `${mean((x) => x.corners).toFixed(1)} corners  ` +
    `tallest ${mean((x) => x.tall).toFixed(1)} m (max ${Math.max(...all.map((x) => x.tall)).toFixed(1)})  ` +
    `${mean((x) => x.tallM).toFixed(0)} m over 15 m tall  ` +
    `${mean((x) => x.vastM).toFixed(0)} m over 25  ` +
    `overlap ${mean((x) => x.overlap).toFixed(1)}  stacked ${mean((x) => x.stacked).toFixed(1)}`
);

/**
 * THE BRANCH YIELD, POOLED RATHER THAN AVERAGED.
 *
 * A per-cave mean of a percentage weights a cave that planned one junction the
 * same as one that planned ten, and the short caves are exactly the ones whose
 * junctions fail. Summing the numerators and denominators across the world is
 * the only honest form of "what fraction of the junctions this design asked for
 * actually exist".
 */
const sum = (f) => all.reduce((s, x) => s + f(x), 0);
const withBranch = all.filter((x) => x.branch);
if (withBranch.length) {
  const g = (k) => withBranch.reduce((s, x) => s + x.branch[k], 0);
  console.log(
    `branch yield:  ${g('built')} built of ${g('tried')} tried of ${g('want')} wanted  ` +
      `= ${g('want') ? ((100 * g('built')) / g('want')).toFixed(0) : '—'}% of the design  ` +
      `|  refused ${g('wall')} no wall, ${g('short')} too few nodes, ${g('buried')} buried, ` +
      `${g('want') - g('tried')} never reached (passage ran out)  ` +
      `|  subs ${g('subBuilt')}/${g('subTried')}/${g('subWant')}`
  );
  console.log(
    `chamber junctions: ${g('atChamber')} of ${g('built')} built junctions are in a chamber; ` +
      `${g('chambers')} chamber(s) given extra ways on, ` +
      `${g('extra')} extra exit(s) built of ${g('extraTried')} tried of ${g('extraWant')} wanted`
  );
}
const withWalk = all.filter((x) => x.walk);
if (withWalk.length) {
  const nodes = withWalk.reduce((s, x) => s + x.walk.nodes, 0);
  const corners = withWalk.reduce((s, x) => s + x.walk.corners, 0);
  const holdSum = withWalk.reduce((s, x) => s + x.walk.holdSum, 0);
  const holdN = withWalk.reduce((s, x) => s + x.walk.holdN, 0);
  const trunk = withWalk.reduce((s, x) => s + x.trunkLen, 0);
  console.log(
    `walk:  ${(nodes / withWalk.length).toFixed(1)} nodes/cave, ` +
      `${nodes ? ((100 * corners) / nodes).toFixed(0) : '—'}% of them corners, ` +
      `realised mean hold ${holdN ? (holdSum / holdN).toFixed(3) : '—'} ` +
      `(the constant is 0.62; under 0.58 means chambers are being spent), ` +
      `${corners ? (trunk / corners).toFixed(1) : '—'} m of trunk per corner`
  );
}
if (all.length) {
  console.log(
    `tall metres pooled: ${sum((x) => x.tallM).toFixed(0)} m over 15 m, ` +
      `${sum((x) => x.vastM).toFixed(0)} m over 25 m — NEITHER OF THESE MAY FALL`
  );
  const cl = sum((x) => x.closures ?? 0);
  const al = sum((x) => x.alpha ?? 0);
  const kb = all.reduce((s, x) => s + (x.kbar ?? 0), 0) / all.length;
  console.log(
    `topology pooled: ${cl} closure(s) over ${all.length} caves ` +
      `(${(cl / all.length).toFixed(2)} a cave, want 1-3), ` +
      `mean alpha ${(al / all.length).toFixed(2)} (want just over 0), ` +
      `mean degree ${kb.toFixed(2)} (want 1.8-2.6, near 2) — ` +
      `MORE IS NOT BETTER HERE; past 2.6 is a maze`
  );
  const sealed = sum((x) => Math.max(0, x.sealed ?? 0));
  console.log(
    `way out pooled: ${sealed} sealed ring(s) over ${all.length} caves — THIS MUST BE ZERO; ` +
      `longest walk to daylight ${Math.max(...all.map((x) => x.far ?? 0)).toFixed(0)} m worst, ` +
      `${mean((x) => x.far ?? 0).toFixed(0)} m mean`
  );
}
if (problems.length) console.log(`\npage errors:\n  ${problems.join('\n  ')}`);
await browser.close();
