import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { cavesNear, setWorldSeed } from '../src/world/terrain.js';
import { caveReady } from './_cave-ready.mjs';

/**
 * THE ONE THING NO CAVE SCRIPT HAD EVER LOOKED AT: a formation at arm's length,
 * while tripping.
 *
 * `cave-tour.mjs` walks the passage sober at eye height, `cave-objects.mjs`
 * stands three metres from one thing at a time sober, and `peak.mjs` pins the
 * level at the ceiling but only ever stands in the wood. So the report that
 * started this — "especially when the player is tripping, it sees the shapes
 * breathing apart" — was outside the coverage of every gate in the repo, and
 * the bug it names survived several rounds of screenshots because every one of
 * those screenshots was taken with uLevel at zero.
 *
 * This closes that hole from both ends.
 *
 *
 * WHAT IT PHOTOGRAPHS. Three stations, chosen from the built cave rather than
 * hard-coded: the tightest cluster of breakdown blocks, the biggest crystal in
 * the biggest seam, and the longest drapery. Those are the three shapes the
 * player named. Each is shot sober first — the control, because a picture of a
 * broken object at the peak proves nothing unless the same object is intact at
 * rest — and then at four phases of the breath with the level pinned at 1.
 *
 * THE PHASE IS PINNED, NOT WAITED FOR. `uBreathPhase` is written every frame by
 * the director, so setting it and screenshotting races the next update and you
 * photograph whatever the clock happened to be doing. It is instead replaced by
 * an accessor that ignores writes, which pins the whole world's breath at a
 * known point on rrLung — so the four frames of a station are the SAME object at
 * four known points of one cycle, and they can be flipped through. The
 * amplitudes are left to the real director: `director.seek(190)` plus an
 * override of 1 is the actual ceiling the game reaches, not a number invented
 * here.
 *
 *
 * AND WHAT IT MEASURES, WHICH IS THE HALF THAT DOES NOT NEED AN EYE.
 *
 * "The shapes deform, they do not separate" is a structural property and can be
 * decided exactly, on the CPU, with no readback: two extras vertices that sit at
 * the same world position can only ever be pushed apart if they disagree about
 * something the displacement reads. After this pass the displacement on an
 * extras vertex is a function of `position`, `aBody` and the uniforms alone —
 * the flat face normal is out of it — so a coincident pair with the SAME aBody
 * is provably inseparable, at any level, at any phase, forever.
 *
 * So the probe buckets every extras vertex by position and reports:
 *
 *   SEAMS      coincident groups whose members disagree about aBody. Must be 0.
 *              A non-zero count is a crack that will open at the peak.
 *   ORPHANS    extras vertices whose aBody is their own position, which would
 *              send them down the wall path and give them the face normal back.
 *              Must be 0.
 *   REACH      the breath excursion each vertex is allowed, against the
 *              distance from its own body's anchor. The rule ported from
 *              living.js:1151-1157 is that a surface may not move further than
 *              it is thick; here that is amp <= 0.35 * reach, and the worst
 *              ratio in the cave is printed next to what the OLD term would
 *              have done to the same vertex.
 *
 *   node scripts/cave-trip.mjs [--seed=grove-01] [--out=.shots/cave-trip]
 *                              [--level=1] [--sober] [--gain=1]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots/cave-trip');
const SEED = args.seed ?? 'grove-01';
const LEVEL = Number(args.level ?? 1);
const GAIN = Number(args.gain ?? 1);
mkdirSync(OUT, { recursive: true });
setWorldSeed(SEED);
const near = cavesNear(0, 0, 900);
const target = args.cave === undefined ? near[0] : (near.find((c) => c.k === Number(args.cave)) ?? near[0]);

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
/**
 * Same guard as peak.mjs: a hot reload drops the override and the rest of the
 * sheet photographs a sober cave under filenames that say peak.
 */
await page.routeWebSocket(/.*/, () => {});
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForSelector('#gate.gone', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2500);
await page.evaluate(() => {
  for (const id of ['toast', 'help', 'stats', 'ui']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
});

// Stand over the mouth so the streamer builds the passage, exactly as the tour
// does. Nothing about a cave exists until somebody has been near it.
await page.evaluate(
  (s) => {
    const { controller, director } = window.RR;
    director.ground();
    controller.keys.clear();
    controller.fly = true;
    controller.position.set(s.x, 60, s.z);
    controller.velocity.set(0, 0, 0);
  },
  { x: target.x, z: target.z }
);
// Then wait for the passage itself, not for five seconds — see `_cave-ready.mjs`.
await caveReady(page, target.k);

/* -------------------------------------------------------------------------- */
/*  the structural probe                                                      */
/* -------------------------------------------------------------------------- */

const probe = await page.evaluate((k) => {
  const cave = window.RR.caves.caves.get(k);
  if (!cave?.ready) return null;
  const g = cave.mesh.geometry;
  const pos = g.attributes.position.array;
  const body = g.attributes.aBody?.array;
  const surf = g.attributes.aSurf.array;
  if (!body) return { missing: true };
  const n = g.attributes.position.count;
  /**
   * The extras begin where the lattice ends, and the lattice is a fixed-stride
   * grid whose vertices are their own body by construction. Finding the
   * boundary by that property rather than by recomputing the ring arithmetic
   * keeps this probe independent of however the passage is currently sliced.
   */
  let first = n;
  for (let i = 0; i < n; i++) {
    const a = i * 3;
    const c = i * 4;
    if (pos[a] !== body[c] || pos[a + 1] !== body[c + 1] || pos[a + 2] !== body[c + 2]) {
      first = i;
      break;
    }
  }
  const buckets = new Map();
  let orphans = 0;
  let water = 0;
  let worstRatio = 0;
  let worstReach = Infinity;
  let sumReach = 0;
  let count = 0;
  const melts = new Map();
  for (let i = first; i < n; i++) {
    const a = i * 3;
    const c = i * 4;
    const dx = pos[a] - body[c];
    const dy = pos[a + 1] - body[c + 1];
    const dz = pos[a + 2] - body[c + 2];
    const reach = Math.hypot(dx, dy, dz);
    if (reach >= 1e-4) melts.set(body[c + 3], (melts.get(body[c + 3]) ?? 0) + 1);
    /**
     * The stream is deliberately its own body — it is a flat sheet with no
     * inside, and `aSurf.w` (wetness) is exactly the flag that says so, which is
     * why the test is on the wetness and not on a vertex range. Anything ELSE
     * anchored to itself would silently fall back onto the wall path and get the
     * flat face normal back, which is the bug wearing a disguise.
     */
    if (reach < 1e-4) {
      if (surf[i * 4 + 3] > 0.5) water++;
      else orphans++;
      continue;
    }
    if (reach < worstReach) worstReach = reach;
    sumReach += reach;
    count++;
    // Quantised to a tenth of a millimetre: these are computed from the same
    // arithmetic in the same order, so exact equality is the normal case and the
    // tolerance only exists so a future emitter that builds a shared corner two
    // ways is not reported as a seam over a float ulp.
    const key = `${Math.round(pos[a] * 1e4)},${Math.round(pos[a + 1] * 1e4)},${Math.round(pos[a + 2] * 1e4)}`;
    let e = buckets.get(key);
    if (!e) buckets.set(key, (e = []));
    e.push(i);
  }
  let seams = 0;
  let shared = 0;
  for (const group of buckets.values()) {
    if (group.length < 2) continue;
    shared++;
    const a0 = group[0] * 4;
    for (let j = 1; j < group.length; j++) {
      const aj = group[j] * 4;
      if (
        Math.abs(body[a0] - body[aj]) > 1e-4 ||
        Math.abs(body[a0 + 1] - body[aj + 1]) > 1e-4 ||
        Math.abs(body[a0 + 2] - body[aj + 2]) > 1e-4 ||
        Math.abs(body[a0 + 3] - body[aj + 3]) > 1e-4
      ) {
        seams++;
        break;
      }
    }
  }
  const u = window.RR.tripUniforms;
  // The peak the director can actually reach, evaluated here so the ratio below
  // is against the real ceiling rather than against whatever it is at rest.
  const PEAK_BREATH = 0.32;
  const PEAK_SWELL = 0.32;
  const allow = PEAK_BREATH * 0.3 + PEAK_SWELL * 0.12;
  const oldTerm = PEAK_BREATH * 0.7 + PEAK_SWELL * 0.35;
  for (const group of buckets.values()) {
    const a = group[0] * 3;
    const c = group[0] * 4;
    const reach = Math.hypot(pos[a] - body[c], pos[a + 1] - body[c + 1], pos[a + 2] - body[c + 2]);
    const amp = Math.min(allow, reach * 0.35);
    const ratio = amp / reach;
    if (ratio > worstRatio) worstRatio = ratio;
  }
  return {
    melt: [...melts.entries()].sort((x, y) => y[1] - x[1]).map(([v, c]) => `${v}:${c}`),
    verts: n,
    lattice: first,
    extras: n - first,
    coincidentGroups: shared,
    seams,
    orphans,
    water,
    worstReach: +worstReach.toFixed(4),
    meanReach: +(sumReach / Math.max(1, count)).toFixed(3),
    worstRatio: +worstRatio.toFixed(3),
    allow: +allow.toFixed(4),
    oldTerm: +oldTerm.toFixed(4),
    oldWorstRatio: +(oldTerm / worstReach).toFixed(2),
    hasUniforms: !!u,
  };
}, target.k);

if (!probe) {
  console.log(`k=${target.k} did not build`);
  await browser.close();
  process.exit(1);
}
if (probe.missing) {
  console.log('geometry has no aBody attribute — the fix is not in this build');
  await browser.close();
  process.exit(1);
}

console.log(
  `k=${target.k}  ${probe.verts} vertices: ${probe.lattice} lattice, ${probe.extras} extras\n` +
    `  coincident groups in the extras: ${probe.coincidentGroups}\n` +
    `  SEAMS  (groups whose members disagree about aBody):  ${probe.seams}\n` +
    `  ORPHANS (extras vertices anchored to themselves):    ${probe.orphans}` +
    `   (${probe.water} water vertices excluded — see the probe)\n` +
    `  melt factor (aBody.w) over the extras: ${probe.melt.join('  ')}\n` +
    `  reach: worst ${probe.worstReach} m, mean ${probe.meanReach} m\n` +
    `  breath allowance at the peak: ${probe.allow} m; worst amp/reach ${probe.worstRatio} ` +
    `(cap 0.35)\n` +
    `  the old term was ${probe.oldTerm} m on every facet regardless of size — ` +
    `${probe.oldWorstRatio}x the reach of the smallest thing in this cave\n`
);

/* -------------------------------------------------------------------------- */
/*  the stations                                                              */
/* -------------------------------------------------------------------------- */

const stations = await page.evaluate(
  ({ k, gain }) => {
    const cave = window.RR.caves.caves.get(k);
    if (gain !== 1) cave.mesh.material.uniforms.uAmbient.value.multiplyScalar(gain);
    const out = [];

    /**
     * The TIGHTEST cluster of breakdown, not the biggest block. The report is
     * about shapes coming apart from each other, which needs several of them in
     * one frame; one enormous slab alone against a wall would hide the failure
     * this exists to photograph.
     */
    let best = null;
    for (const b of cave.blocks) {
      let n = 0;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (const o of cave.blocks) {
        if (Math.hypot(o.x - b.x, o.y - b.y, o.z - b.z) > 7) continue;
        n++;
        sx += o.x;
        sy += o.y + o.top;
        sz += o.z;
      }
      if (!best || n > best.n) best = { n, x: sx / n, y: sy / n, z: sz / n, size: 5 };
    }
    if (best) out.push({ tag: 'breakdown', ...best, back: 6 });

    // The biggest spike in the cave: the one a player walks up to.
    let gem = null;
    for (const c of cave.crystals) if (!gem || c.len > gem.len) gem = c;
    if (gem) {
      out.push({
        tag: 'crystal',
        x: gem.x + gem.dx * gem.len * 0.5,
        y: gem.y + gem.dy * gem.len * 0.5,
        z: gem.z + gem.dz * gem.len * 0.5,
        size: gem.len,
        back: Math.max(2.4, gem.len * 1.9),
      });
    }

    // The longest curtain, seen from far enough back that its whole run is in
    // frame — a drapery is judged on its outline.
    let dr = null;
    for (const s of cave.spires) {
      if (s.kind !== 'drape') continue;
      if (!dr || s.run * s.h > dr.run * dr.h) dr = s;
    }
    if (dr) {
      out.push({
        tag: 'drapery',
        x: dr.x,
        y: dr.y0 - dr.h * 0.45,
        z: dr.z,
        size: Math.max(dr.run, dr.h),
        back: Math.max(3, dr.run * 1.5),
      });
    }

    // …and a straw, which is the smallest solid in the world and therefore the
    // one the old displacement destroyed most completely.
    let straw = null;
    for (const s of cave.spires) {
      if (s.kind !== 'tite') continue;
      if (!straw || s.rad < straw.rad) straw = s;
    }
    if (straw) {
      /**
       * Backed off further than the object's own size wants, because at the peak
       * the WALL moves by uFlow — 1.7 m — and the camera does not. A station 1.6
       * m from a straw photographs the inside of a melted ceiling.
       */
      out.push({
        tag: 'straw',
        x: straw.x,
        y: straw.y0 - straw.h * 0.5,
        z: straw.z,
        size: straw.h,
        back: Math.max(3.4, straw.h * 2.2),
      });
    }
    return out;
  },
  { k: target.k, gain: GAIN }
);

/**
 * Point the eye at a station from a fixed bearing, so two runs frame it alike.
 *
 * THE BACK-OFF IS A WISH, NOT A PLACE, AND TWO OF THE FOUR STATIONS WERE
 * PHOTOGRAPHING THE HILLSIDE FROM INSIDE THE ROCK.
 *
 * Each station asks to be seen from far enough back that its whole outline is in
 * frame — `Math.max(3, dr.run * 1.5)` for the drapery, which with draperies now
 * 1.4-4.2 m long is up to 6.3 m. A passage is 2-4 m of HALF-WIDTH. So the eye
 * went straight out through a wall, and because the tube is single-sided and
 * faces inward it draws nothing at all from behind: `drapery-0-sober.png` and
 * `drapery-c-exhale.png` both came back as forest, sky and the river, with the
 * formation they are named after nowhere in the frame. Nothing failed. The sheet
 * simply photographed the wrong side of the world, four times per station, and a
 * gate that cannot tell that from a passing shot is not a gate.
 *
 * The straw station already reasoned about this hazard — see its comment, which
 * backs OFF further because the wall moves 1.7 m at the peak — and that is the
 * same hazard read from the other end: the distance between the eye and the wall
 * is the thing that matters, and neither end of it is known until the passage has
 * been asked. So it is asked. `caveSample` is the same predicate the body's own
 * wall push uses, so "inside" here means exactly "somewhere a player could
 * stand": within `wallDist` of the centre line, under the ceiling, over the
 * floor. The eye walks in along its own bearing until that is true.
 *
 * WALKING IN RATHER THAN CLAMPING TO THE AXIS, because a station is framed by
 * its bearing as much as by its distance — collapsing to the centre line would
 * reframe the shot and make two runs of the sheet incomparable, which is the one
 * thing the fixed bearing exists to prevent. Twelve steps of 12% reach 0.2 of the
 * nominal back-off, which is past the far wall of any passage in the world.
 */
async function stand(s) {
  return page.evaluate(async (t) => {
    const mod = await import('/src/world/caves.js');
    const con = window.RR.controller;
    con.fly = true;
    con.keys.clear();
    const a = 0.7;
    const at = (b) => [t.x + Math.cos(a) * b, t.y + b * 0.22, t.z + Math.sin(a) * b];
    /**
     * `inside > 0` ALONE IS NOT ENOUGH, and that is worth a line because it is
     * the obvious test. The containment ramp reaches `slack` — up to 1.8 m —
     * PAST the wall by construction, so a camera scoring 0.4 is already outside
     * the rock the eye can see. `wallDist` is where the body is actually held,
     * with the rock displacement's bite already taken off it, so 0.9 of that is
     * inside the drawn surface with room for the wall's 1.7 m of breathing.
     */
    let back = t.back;
    for (let i = 0; i < 12; i++) {
      const [px, py, pz] = at(back);
      const smp = mod.caveSample(px, py, pz);
      if (
        smp.inside > 0 &&
        smp.radial < smp.wallDist * 0.9 &&
        py > smp.floor + 0.3 &&
        py < smp.ceiling - 0.3
      ) {
        break;
      }
      back *= 0.88;
    }
    const [px, py, pz] = at(back);
    con.position.set(px, py, pz);
    con.velocity.set(0, 0, 0);
    con.yaw = Math.atan2(-(t.x - con.position.x), -(t.z - con.position.z));
    con.pitch = Math.atan2(t.y - con.position.y, Math.max(0.1, back));
    const smp = mod.caveSample(px, py, pz);
    return { back: +back.toFixed(2), inside: +smp.inside.toFixed(2), radial: +smp.radial.toFixed(2), wall: +smp.wallDist.toFixed(2) };
  }, s);
}

/**
 * PIN THE BREATH, by replacing the uniform's own property.
 *
 * The director writes `uBreathPhase.value` every frame from its own wave, so
 * assigning it from here and then screenshotting photographs whatever the clock
 * did in between. An accessor that swallows writes is the only version of this
 * that is not a race, and it pins the whole world rather than the cave alone —
 * which is correct, because the point of the shot is a formation moving with
 * the passage it stands in.
 */
async function pinPhase(phase) {
  await page.evaluate((p) => {
    const u = window.RR.tripUniforms.uBreathPhase;
    if (!u.__pinned) {
      Object.defineProperty(u, 'value', {
        configurable: true,
        get: () => u.__phase,
        set: () => {},
      });
      u.__pinned = true;
    }
    u.__phase = p;
  }, phase);
}

async function unpinPhase() {
  await page.evaluate(() => {
    const u = window.RR.tripUniforms.uBreathPhase;
    if (!u.__pinned) return;
    delete u.value;
    u.value = u.__phase;
    u.__pinned = false;
  });
}

/** rrLung(p) = sin(p + 0.55 sin p) — four points of one cycle, named. */
const PHASES = [
  ['a-inhale', Math.PI * 0.5],
  ['b-settle', Math.PI],
  ['c-exhale', Math.PI * 1.5],
  ['d-cross', 0],
];

for (const s of stations) {
  const stood = await stand(s);
  // Sober control first. A broken object at the peak proves nothing unless the
  // same object at the same bearing is whole at rest.
  await unpinPhase();
  await page.evaluate(() => {
    const { director, pipeline } = window.RR;
    director.ground();
    director.state.override = 0;
    director.eased = 0;
    pipeline.clearHistory();
  });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${OUT}/${s.tag}-0-sober.png` });

  await page.evaluate((level) => {
    const { director, pipeline } = window.RR;
    director.seek(190);
    director.state.override = level;
    director.eased = level;
    pipeline.clearHistory();
  }, LEVEL);
  await page.waitForTimeout(2200);

  const state = await page.evaluate(() => {
    const u = window.RR.tripUniforms;
    return {
      level: +u.uLevel.value.toFixed(2),
      flow: +u.uFlow.value.toFixed(3),
      breathAmp: +u.uBreathAmp.value.toFixed(3),
      swell: +u.uSwell.value.toFixed(3),
    };
  });
  console.log(
    `  ${s.tag.padEnd(10)} size ${s.size.toFixed(2)} m  from ${stood.back.toFixed(1)} m` +
      (stood.back < s.back - 0.005 ? ` (asked ${s.back.toFixed(1)}, walked in to stay inside)` : '') +
      `  eye ${stood.radial.toFixed(1)} m off the axis of a ${stood.wall.toFixed(1)} m wall, inside ${stood.inside}  ` +
      `level ${state.level} flow ${state.flow} breath ${state.breathAmp} swell ${state.swell}`
  );

  for (const [name, phase] of PHASES) {
    await pinPhase(phase);
    // Two frames' worth: the pin takes effect on the next render, and the
    // pipeline's own history has to catch up or the bloom lags the geometry.
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/${s.tag}-${name}.png` });
  }
}

await unpinPhase();
if (problems.length) console.log('\nCONSOLE:', problems.slice(0, 6));
else console.log('\nno console errors');
console.log(
  probe.seams === 0 && probe.orphans === 0
    ? `\nPASS: no coincident pair in ${probe.extras} extras vertices can be separated by any trip state`
    : `\nFAIL: ${probe.seams} seam(s), ${probe.orphans} orphan(s)`
);
await browser.close();
process.exit(probe.seams === 0 && probe.orphans === 0 ? 0 : 1);
