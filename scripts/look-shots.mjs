import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Photographs for LOOKING AT, as opposed to `world-shots.mjs`, which is a
 * regression instrument.
 *
 *   node scripts/look-shots.mjs [--out=.shots/look] [--only=canopy] [--seek=…]
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

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
  ],
});
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
 */
await page.evaluate(() => {
  document.getElementById('gate').classList.add('gone');
  document.getElementById('toast').style.display = 'none';
  document.getElementById('help').style.display = 'none';
  const R = window.RR;
  R.probe.freeze(true);
  R.pipeline.trailEnabled = false;
});

const SEEK = args.seek === undefined ? null : Number(args.seek);
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
  const file = `${name}${SEEK === null ? '' : `-t${SEEK}`}`;
  writeFileSync(`${OUT}/${file}.png`, Buffer.from(info.png.split(',')[1], 'base64'));
  delete info.png;
  shots.push({ file, ...info });
  console.log(
    `${file.padEnd(14)} eye ${String(info.y).padStart(6)} m  ` +
      `${String(info.calls).padStart(4)} draws  ${(info.tris / 1e6).toFixed(2)}M tris`
  );
}

writeFileSync(`${OUT}/report.json`, JSON.stringify({ shots, problems }, null, 2));
if (problems.length) {
  console.log(`\n${problems.length} console problem(s):`);
  for (const p of problems.slice(0, 20)) console.log(' ', p);
} else {
  console.log('\nno console problems');
}

await browser.close();
