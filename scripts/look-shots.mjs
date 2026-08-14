import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Photographs for LOOKING AT, as opposed to `world-shots.mjs`, which is a
 * regression instrument.
 *
 *   node scripts/look-shots.mjs [--out=.shots/look] [--only=canopy] [--seek=…]
 *   node scripts/look-shots.mjs --repeat=2 [--budget=0.5]   ← prove it still is
 *
 * The difference is the stations, not the machinery — the pinning below is
 * copied verbatim from world-shots because the reasons in its header all still
 * apply, and two runs of this have to be comparable to each other or an A/B on
 * the look is worthless. What changes is WHERE it stands: world-shots exists to
 * prove the endless world has no seam in it, so its cameras are at 400 m and
 * 2 km facing out along an axis. None of those is a picture of the forest a
 * player is standing in.
 *
 * These are. Eye level in the wood, looking up into the crowns, along a slope,
 * across the clearing, down at the floor — the five views that decide whether
 * this reads as a rainforest, plus the two the trip changes most.
 *
 *
 * "TWO RUNS OF THIS HAVE TO BE COMPARABLE" WAS A CLAIM, AND FOR A WHILE IT WAS
 * FALSE. `--repeat` IS WHY IT IS NOW CHECKED INSTEAD OF ASSERTED.
 *
 * Measured 2026-08-13, two runs against the same commit and the same server:
 * `glade` differed across 93% of the viewport with a mean channel error of 76,
 * `wood` across 33%, `stream` and `clearing` across 18% each. The frames were
 * not noisy — they were different, plausible pictures of the same place, one
 * open parkland and one dense jungle, which is precisely the shape of failure
 * the block comment on the settle loop below already cost this project a day
 * over. A reviewer putting two of those side by side does not see an unstable
 * harness; they see a change that moved the forest.
 *
 * Three causes, all of them outside this file and all now fixed:
 *
 *   THE PACKER THREW AWAY ITS OWN UPLOADS. See `flagUpload` in
 *   world/culling.js. Worth essentially all of the above: the cull runs every
 *   tick while the draw is throttled to 10 Hz behind the menu — which is the
 *   state this script lives in for its whole run, because it dismisses the gate
 *   by hand — so five of every six repacks' writes never reached the GPU, and
 *   WHICH five is a question about wall-clock timing.
 *
 *   THE FREEZE FROZE AT A DIFFERENT INSTANT EVERY RUN. `probe.freeze` pinned the
 *   world clock to "now", so the river, the clouds and the mist were a tenth of
 *   a second apart between runs. It now takes the instant to hold — see
 *   WORLD_T below.
 *
 *   THE FERRY WAS NEVER FROZEN AT ALL, and at 1.9 m/s a ten-second settle put
 *   it twenty metres down the river. See the freeze in main.js's frame loop.
 *
 * What is left is the animals: birds, butterflies and fish integrate for
 * however many frames it takes the page to reach `window.RR`, and there is no
 * way in from outside to rewind them. That is a few hundred pixels of moving
 * dots — see BUDGET — and it is the reason this check has a budget at all
 * rather than demanding equality.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots/look');
const ONLY = args.only ?? null;
const WIDTH = Number(args.width ?? 1440);
const HEIGHT = Number(args.height ?? 810);
/**
 * How many independent captures to take, and how far apart two of them may be.
 *
 * INDEPENDENT MEANS A NEW PAGE, and photographing the same station twice in one
 * page would be worthless: nothing between two renders of a settled world can
 * differ, so it would pass with the culler bug above still in place. Every one
 * of the three causes listed in the header is a property of how this run
 * ARRIVED at the station, so a self-check has to arrive again.
 *
 * The budget is per station, as a percentage of the viewport whose maximum
 * channel delta exceeds 2. 0.5% of 1440×810 is about six thousand pixels, which
 * comfortably holds the drifting fauna (measured at 0.05–2.4% before they were
 * the only thing left, and 0.02–0.35% after the clock and the ferry were
 * pinned) and is far below anything a look change worth photographing would
 * produce.
 */
const REPEAT = Math.max(1, Number(args.repeat ?? 1));
const BUDGET = Number(args.budget ?? 0.5);
/**
 * The instant on the room's clock the world is held at, in seconds.
 *
 * Any stated number would do; what matters is that it is stated. Ten minutes
 * in rather than zero because several surfaces cross at t=0 — the river's two
 * wave trains and the cloud scroll all start in phase — and a frame nobody
 * would ever otherwise see is a poor thing to judge a look by.
 *
 * The DAY is deliberately not pinned alongside it. Measured over four runs it
 * does not move (0.3757…, a few minutes past nine), because the hour comes from
 * the session's own origin and automation's is fixed; pinning it here would
 * override a per-session hour that may one day be deliberate. If it ever does
 * start to drift, `--repeat` is what will say so, and `probe.freeze` already
 * takes a `phase` for the fix.
 */
const WORLD_T = 600;
mkdirSync(OUT, { recursive: true });

// Yaw convention, from Controller.forward(): view is (-sin yaw, 0, -cos yaw).
const N = 0;
const S = Math.PI;
const W = Math.PI / 2;
const E = -Math.PI / 2;

const STATIONS = {
  /** The first frame anybody sees. */
  clearing: { x: 0, z: 8, yaw: N, pitch: -0.03 },
  /** Standing in the wood, eye level, the view that reported "bare poles". */
  wood: { x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
  /** The long sight line down the ridge — where a mid-storey shows or does not. */
  ridge: { x: 400, z: -96, yaw: E, pitch: -0.05 },
  /** Looking up. The canopy is the most expensive frame in the game. */
  canopy: { x: -34, z: -46, yaw: 1.1, pitch: 0.85 },
  /** Looking down at the floor from walking height. */
  floor: { x: -34, z: -46, yaw: 1.1, pitch: -0.62 },
  /** The stream: water, reeds, the damp biome. */
  stream: { x: 4, z: 20, yaw: 0.1, pitch: -0.12 },
  /** A glade a long way out, where the meadow and flower biomes commit. */
  glade: { x: 706, z: 212, yaw: S, pitch: 0.04 },
  /** Deep wood a long way out — the litter biome, i.e. the empty one. */
  far: { x: -812, z: 344, yaw: W, pitch: 0.05 },
};

const SEEK = args.seek === undefined ? null : Number(args.seek);

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
  ],
});

/**
 * One complete visit to every station, in its own page.
 *
 * A function rather than the body of the script because `--repeat` needs to do
 * it again from a standing start; see REPEAT.
 */
async function capture() {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  const problems = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') problems.push(`[${t}] ${m.text().slice(0, 240)}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });

  /**
   * THE FREEZE WARNINGS THIS SCRIPT PRINTS ARE ITS OWN FAULT. DO NOT CHASE THEM.
   *
   * The gate is dismissed by hand rather than clicked, so that audio never starts
   * (the jukebox's emissive follows the analyser, and a shot has to be the same
   * twice). The cost of that is that `#enter`'s handler never runs — and that
   * handler IS the shader pre-warm. Every run of this script therefore enters the
   * world with nothing compiled, and the freeze detector, which arms the moment
   * the gate goes, correctly reports several hundred milliseconds of
   * "compiled unnamed, unnamed, unnamed" at the first station.
   *
   * A player never sees any of it. Measured 2026-08-13 by clicking `#enter` for
   * real and then visiting six stations: the gate lifts with 109 programs built
   * and **zero** further programs compile for the rest of the session. The
   * warnings below are an artifact of how this harness gets into the world, not a
   * property of the world.
   *
   * The first-draw UPLOAD figures in the same warnings are real, however — those
   * are geometry buffers reaching the GPU and they happen to a player too, just
   * spread over the walk instead of bunched at a teleport.
   *
   * THE SECOND COST OF NOT CLICKING `#enter` IS INVISIBLE AND WAS NOT AN
   * ARTEFACT. `gateUp` stays true for the whole run, so main.js's frame loop
   * throttles the DRAW to 10 Hz while the CULL keeps running every tick — it has
   * to, it is what streams the world in. That is five or six repacks per drawn
   * frame, and until `flagUpload` existed the packer discarded all but the last
   * one's uploads. See the header.
   */
  await page.evaluate((worldT) => {
    document.getElementById('gate').classList.add('gone');
    document.getElementById('toast').style.display = 'none';
    document.getElementById('help').style.display = 'none';
    const R = window.RR;
    // `at` and not a bare freeze: see WORLD_T.
    R.probe.freeze(true, { at: worldT });
    R.pipeline.trailEnabled = false;
  }, WORLD_T);

  const shots = [];
  for (const [name, at] of Object.entries(STATIONS)) {
    if (ONLY && !name.includes(ONLY)) continue;
    const info = await page.evaluate(
      async ({ at: s, seek }) => {
        const R = window.RR;
        const raf = () => new Promise((r) => requestAnimationFrame(r));
        R.controller.position.x = s.x;
        R.controller.position.z = s.z;
        R.controller.position.y = -1e4;
        R.controller.velocity.set(0, 0, 0);
        R.controller.yaw = s.yaw;
        R.controller.pitch = s.pitch;
        R.controller.applyToCamera();
        /**
         * WAIT FOR THE WOOD, DO NOT COUNT FRAMES AT IT.
         *
         * This was a flat 150 frames, and 150 frames used to be enough. After a
         * pass that put 43-53% more triangles into every sector and added three
         * new streamed understorey layers, it stopped being enough — and the way
         * it failed is the reason this comment is long.
         *
         * It did not error, and it did not produce an obviously broken picture.
         * It produced a BEAUTIFUL, PLAUSIBLE, WRONG one: the far stations came
         * back as open parkland with a distant tree line, which reads exactly
         * like a design decision about biomes. Two separate agents reported the
         * wood at those stations as "deleted" or "no longer forest" on the
         * strength of it. It was not. Standing at the same spot with the queues
         * drained shows dense jungle with 257 trunks inside 60 m — MORE than the
         * deep-wood station has. The forest was always there; the camera was
         * simply photographing it before it arrived.
         *
         * A fixed frame count encodes an assumption about how much work a sector
         * is, which is precisely the quantity a content change moves. So settle on
         * the streamer's own queues instead: both rings empty, and the frame's
         * counters unchanged across several consecutive checks, so that a lull
         * between worker batches cannot be mistaken for arrival.
         *
         * AND IT NEEDS A FLOOR AS WELL AS A QUIET TEST, which the first version of
         * this fix did not have and which made it WORSE than the frame count it
         * replaced. `field.built` and the ground-chunk count both stop moving
         * while sectors are still being merged and uploaded, and both queues
         * drain to empty between worker batches — so a pure quiet test was
         * satisfied after about sixty frames and photographed even less of the
         * wood than the flat 150 did. The counters going quiet is necessary and
         * nowhere near sufficient. 600 frames is what was measured to be enough
         * at the furthest station; the quiet test then keeps it honest if a
         * future change makes even that too short.
         *
         * IT IS NOT, HOWEVER, WHAT MADE TWO RUNS DIFFER. That was measured
         * separately and it was the packer — see the header. The settle is sound:
         * with the world clock pinned and the uploads kept, every counter this
         * loop watches lands on the same number in every run.
         */
        let quiet = 0;
        let prev = null;
        for (let i = 0; i < 1500 && (i < 600 || quiet < 6); i++) {
          await raf();
          if (i % 10) continue;
          const pending =
            (R.forest?.field?.pending ?? 0) + (R.forest?.groundField?.pending ?? 0);
          const now = `${R.forest?.field?.built ?? 0}/${R.forest?.groundField?.group?.children?.length ?? 0}`;
          quiet = pending === 0 && prev === now ? quiet + 1 : 0;
          prev = now;
        }
        if (seek === null) R.director.ground();
        else R.director.seek(seek);
        for (let i = 0; i < 30; i++) {
          R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
        }
        R.tripUniforms.uWind.value.set(11.5, 17.4);
        for (const m of R.atmosphere.mist.mats) m.map.offset.x = 0;
        R.atmosphere.follow(R.camera);
        R.renderer.shadowMap.needsUpdate = true;
        R.forest.cull(R.camera, true);
        for (let i = 0; i < 3; i++) R.pipeline.render(1 / 60);
        const png = R.renderer.domElement.toDataURL('image/png');
        const info = R.renderer.info;
        info.autoReset = false;
        info.reset();
        R.pipeline.render(1 / 60);
        const calls = info.render.calls;
        const tris = info.render.triangles;
        info.autoReset = true;
        return {
          png,
          calls,
          tris,
          under: R.forest.understorey,
          y: Math.round(R.controller.position.y * 10) / 10,
        };
      },
      { at, seek: SEEK }
    );
    shots.push({ file: `${name}${SEEK === null ? '' : `-t${SEEK}`}`, ...info });
  }

  await page.close();
  return { shots, problems };
}

/**
 * Two frames, as a percentage of pixels whose worst channel moved by more than
 * a couple of levels.
 *
 * Decoded through `Image` in a page rather than with a PNG library, which is
 * both the least code and the only method this project has that is known to
 * work: reading the WebGL canvas back directly returns a blank or stale buffer
 * (no `preserveDrawingBuffer`), and a diff built on that once reported ZERO
 * changed pixels between two frames that were obviously different.
 *
 * The threshold of 2 is dither and rounding, not content — the pipeline's
 * output shader dithers to hide banding, so a bit-exact comparison would fail
 * on frames a person would call identical.
 *
 * Takes DATA URLS, as `toDataURL` produced them, and strips the prefix itself.
 */
async function diff(a, b) {
  const page = await browser.newPage();
  await page.goto('about:blank');
  const r = await page.evaluate(
    async ([x, y]) => {
      const load = (d) =>
        new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = rej;
          i.src = `data:image/png;base64,${d}`;
        });
      const [ia, ib] = await Promise.all([load(x), load(y)]);
      const grab = (img) => {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height).data;
      };
      const pa = grab(ia);
      const pb = grab(ib);
      let changed = 0;
      let sum = 0;
      for (let i = 0; i < pa.length; i += 4) {
        const d = Math.max(
          Math.abs(pa[i] - pb[i]),
          Math.abs(pa[i + 1] - pb[i + 1]),
          Math.abs(pa[i + 2] - pb[i + 2])
        );
        if (d > 2) changed++;
        sum += d;
      }
      const px = pa.length / 4;
      return { pct: (changed / px) * 100, mean: sum / px };
    },
    [a.split(',').pop(), b.split(',').pop()]
  );
  await page.close();
  return r;
}

const passes = [];
for (let i = 0; i < REPEAT; i++) {
  if (REPEAT > 1) console.log(`pass ${i + 1} of ${REPEAT}`);
  passes.push(await capture());
}

const { shots, problems } = passes[0];
for (const s of shots) {
  writeFileSync(`${OUT}/${s.file}.png`, Buffer.from(s.png.split(',')[1], 'base64'));
  console.log(
    `${s.file.padEnd(14)} eye ${String(s.y).padStart(6)} m  ` +
      `${String(s.calls).padStart(4)} draws  ${(s.tris / 1e6).toFixed(2)}M tris`
  );
}

/**
 * The self-check. It FAILS the process, because the whole point is that a run
 * whose frames cannot be trusted must not be quietly used to judge a change.
 */
let unstable = 0;
if (REPEAT > 1) {
  console.log(`\nreproducibility, ${REPEAT} independent passes, budget ${BUDGET}% of pixels:`);
  for (let s = 0; s < shots.length; s++) {
    let worst = { pct: 0, mean: 0 };
    let worstPass = 1;
    for (let i = 1; i < passes.length; i++) {
      const d = await diff(shots[s].png, passes[i].shots[s].png);
      if (d.pct > worst.pct) {
        worst = d;
        worstPass = i;
      }
    }
    const bad = worst.pct > BUDGET;
    if (bad) {
      unstable++;
      // The evidence, not just the verdict: a frame you can put next to the
      // first one is the difference between fixing this and arguing about it.
      writeFileSync(
        `${OUT}/${shots[s].file}.unstable.png`,
        Buffer.from(passes[worstPass].shots[s].png.split(',')[1], 'base64')
      );
    }
    console.log(
      `  ${shots[s].file.padEnd(14)} ${worst.pct.toFixed(3).padStart(7)}%  ` +
        `mean ${worst.mean.toFixed(2).padStart(5)}  ${bad ? 'UNSTABLE' : 'ok'}`
    );
  }
}

for (const s of shots) delete s.png;
writeFileSync(`${OUT}/report.json`, JSON.stringify({ shots, problems }, null, 2));
if (problems.length) {
  console.log(`\n${problems.length} console problem(s):`);
  for (const p of problems.slice(0, 20)) console.log(' ', p);
} else {
  console.log('\nno console problems');
}

await browser.close();

if (unstable) {
  console.error(
    `\n${unstable} station(s) are not reproducible: two runs against THIS SAME ` +
      `commit disagree by more than ${BUDGET}% of the frame.\n` +
      'These shots cannot be compared with anything — a change of that size ' +
      'would be indistinguishable from the noise, and a reviewer looking at two ' +
      'of them will read the difference as real. The second pass is written ' +
      'beside each one as *.unstable.png. See the header of this file for the ' +
      'three causes found on 2026-08-13 and where each was fixed.'
  );
  process.exitCode = 1;
}
