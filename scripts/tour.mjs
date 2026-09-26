import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * THE TOUR — a photograph of every thing in this world that nothing has ever
 * photographed.
 *
 *   node scripts/tour.mjs
 *   node scripts/tour.mjs --only=storm,cave-roost-hang --out=.shots/tour2
 *   node scripts/tour.mjs --list
 *
 * WHY THIS EXISTS AND WHY IT IS NOT `shoot.mjs` OR `gallery.mjs`. Those two
 * photograph PLACES: one wood through the trip's envelope, and every land at
 * every station at three hours. Neither can photograph a THING THAT HAPPENS —
 * a storm, a flush of bats, a meteor, snow falling, a wave of colour crossing a
 * clearing — because every one of those is a moment rather than a viewpoint,
 * and most of them are unreachable by an instrument that only knows how to park
 * a camera:
 *
 *   THE WEATHER IS PINNED OFF UNDER AUTOMATION. `rainAtTime` returns 0 when
 *   `navigator.webdriver` is set, so that thirty pixel-diffing scripts see one
 *   fixed world. Every storm, every flash and every flake is therefore
 *   INVISIBLE TO EVERY EXISTING SCRIPT, by construction. `forceWeather` is the
 *   door that was added for this, and this is what walks through it.
 *
 *   A ROOST IS THIRTY METRES INSIDE A MOUNTAIN and only exists once the cave
 *   containing it has finished building, which is tens of seconds after the
 *   forest says it has settled — a cave is the third streaming ring and
 *   `forest.settled` has never known about it.
 *
 *   AND SOME OF IT IS A PAIR. "Does the surge travel" cannot be answered by one
 *   frame; the answer is two frames a few seconds apart with the world clock
 *   running, which is the same argument `morph.mjs` makes about the melt.
 *
 * IT IS NOT A GATE AND IT ASSERTS NOTHING. Every question it exists to answer —
 * does the snow look like snow, do the bats read as stalactites, is the night
 * sky worth lying under — is a judgement, and a script that claimed to answer
 * one would be lying. What it does is make the judgement CHEAP: one command,
 * one folder, twenty-one pictures of the twenty-one things that were built
 * blind.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const BASE = args.url ?? 'http://127.0.0.1:5180/';
const OUT = args.out ?? '.shots/tour';
const WIDTH = Number(args.width ?? 1440);
const HEIGHT = Number(args.height ?? 810);

/** The hours, by the same numbers day-check and gallery use. */
const H = { night: 0.03, dawn: 0.25, morning: 0.3758, noon: 0.5, golden: 0.762, sunset: 0.7877, nightfall: 0.87 };

/**
 * A scene is a land, an hour, a way of finding somewhere to stand, and a
 * `setup` that runs IN THE PAGE with the world already parked.
 *
 * `find` is separate from `setup` because most of these have to ask the running
 * world where something is — a cave with a roost in it, a snag, a jetty — and
 * that answer decides where the camera goes. Returning null skips the scene and
 * says so, which is the right behaviour for "this seed has no cave in range"
 * and the wrong behaviour for a silent black frame.
 */
const SCENES = [
  // ---- weather, none of which any other script can see ---------------------
  {
    name: 'storm-sky',
    land: 'rainforest',
    hour: H.noon,
    note: 'the deck closed over, from the clearing, looking up',
    find: () => ({ x: 0, z: 5, yaw: 0.6, pitch: 1.1 }),
    weather: { cover: 1, precip: 0.85, wet: 0.7 },
  },
  {
    name: 'storm-wood',
    land: 'rainforest',
    hour: H.noon,
    note: 'the same storm at eye level — is the light flat and grey',
    find: () => ({ x: -34, z: -46, yaw: 1.1, pitch: 0.02 }),
    weather: { cover: 1, precip: 0.85, wet: 0.7 },
  },
  {
    name: 'storm-flash',
    land: 'rainforest',
    hour: H.noon,
    note: 'a strike held at full — the sky whitens toward the bearing',
    find: () => ({ x: 0, z: 5, yaw: 1.1, pitch: 0.55 }),
    weather: { cover: 1, precip: 0.9, wet: 0.75, lightning: 1, bearing: 1.1 },
  },
  {
    name: 'storm-dry',
    land: 'rainforest',
    hour: H.noon,
    note: 'the same frame with the weather handed back to the clock',
    find: () => ({ x: 0, z: 5, yaw: 0.6, pitch: 1.1 }),
    weather: null,
  },
  {
    name: 'rain-water',
    land: 'rainforest',
    hour: H.golden,
    note: 'rain landing on the river — rings in the surface, no coherent glint',
    find: (w) => w.jetty && { x: w.jetty.x, z: w.jetty.z, yaw: w.jetty.yaw + Math.PI / 2, pitch: -0.3 },
    weather: { cover: 0.9, precip: 0.95, wet: 0.9 },
  },
  {
    name: 'snow-near',
    land: 'taiga',
    hour: H.morning,
    note: 'one flake against a dark trunk — does it drift and turn',
    find: () => ({ x: -34, z: -46, yaw: 1.1, pitch: 0.06 }),
    weather: { precip: 1 },
  },
  {
    name: 'snow-wide',
    land: 'taiga',
    hour: H.morning,
    note: 'the winter wood in a shower',
    find: () => ({ x: 0, z: 5, yaw: 0, pitch: -0.02 }),
    weather: { precip: 1 },
  },

  // ---- the sky -------------------------------------------------------------
  {
    name: 'night-zenith',
    land: 'rainforest',
    hour: H.night,
    note: 'midnight, straight up from the clearing — the Milky Way as POINTS',
    find: () => ({ x: 0, z: 5, yaw: 0.6, pitch: 1.32 }),
  },
  {
    name: 'twilight-stars',
    land: 'rainforest',
    hour: 0.85,
    note: 'the bright stars out first, the faint ones not yet',
    find: () => ({ x: 0, z: 5, yaw: 0.6, pitch: 1.2 }),
  },
  {
    name: 'sunset-toward',
    land: 'rainforest',
    hour: H.sunset,
    note: 'facing the sun at sunset',
    find: (w) => ({ x: w.ridge.x, z: w.ridge.z, yaw: w.sunYaw, pitch: 0.18 }),
  },
  {
    name: 'sunset-away',
    land: 'rainforest',
    hour: H.sunset,
    note: 'the ANTI-solar half — cold violet and the Belt of Venus, or nothing',
    find: (w) => ({ x: w.ridge.x, z: w.ridge.z, yaw: w.sunYaw + Math.PI, pitch: 0.18 }),
  },

  // ---- the water -----------------------------------------------------------
  {
    name: 'water-down',
    land: 'rainforest',
    hour: H.noon,
    note: 'straight down from the bank — the bed, the gravel, the fish',
    find: (w) => w.jetty && { x: w.jetty.x, z: w.jetty.z, yaw: w.jetty.yaw + Math.PI / 2, pitch: -1.1 },
  },
  {
    name: 'water-along',
    land: 'rainforest',
    hour: H.noon,
    note: 'along the channel — the grazing view that was a pale sheet',
    find: (w) => w.jetty && { x: w.jetty.x, z: w.jetty.z, yaw: w.jetty.yaw, pitch: -0.06 },
  },

  // ---- underground ---------------------------------------------------------
  {
    name: 'cave-roost-hang',
    land: 'rainforest',
    hour: H.noon,
    note: 'the ceiling from outside the flush radius — they must read as stalactites',
    find: (w) => w.roost && { x: w.roost.x, y: w.roost.y - 11, z: w.roost.z, yaw: 0, pitch: 1.1, teleport: true },
  },
  {
    name: 'cave-roost-flush',
    land: 'rainforest',
    hour: H.noon,
    note: 'and the same ceiling a second after crossing 13 m',
    find: (w) => w.roost && { x: w.roost.x, y: w.roost.y - 9, z: w.roost.z, yaw: 0, pitch: 1.0, teleport: true, hold: 1600 },
  },
  {
    name: 'cave-shaft',
    land: 'rainforest',
    hour: H.noon,
    note: 'up the beam — a ragged hole at the top of it, not a porthole',
    find: (w) => w.shaft && { x: w.shaft.x, y: w.shaft.y, z: w.shaft.z, yaw: 0, pitch: 1.15, teleport: true },
  },
  {
    name: 'cave-mouth-adapted',
    land: 'rainforest',
    hour: H.noon,
    note: 'inside looking out, after five seconds of standing still — the eye has opened',
    find: (w) => w.mouth && { x: w.mouth.inx, y: w.mouth.iny, z: w.mouth.inz, yaw: w.mouth.outYaw, pitch: -0.02, teleport: true, hold: 6000 },
  },

  // ---- the wood ------------------------------------------------------------
  {
    name: 'path-air',
    land: 'rainforest',
    hour: H.noon,
    note: 'the spawn corridor and the links from 70 m up',
    find: () => ({ x: 0, y: 210, z: 5, yaw: 0, pitch: -1.35, fly: true }),
  },
  {
    name: 'path-eye',
    land: 'rainforest',
    hour: H.morning,
    note: 'the way out of the clearing, from where you land',
    find: (w) => ({ x: 0, z: 5, yaw: w.spawnYaw, pitch: -0.22 }),
  },
  {
    name: 'snag',
    land: 'rainforest',
    hour: H.morning,
    note: 'a dead tree against the sky — the one place you can see a bird',
    find: (w) => w.snag && { x: w.snag.x + 14, z: w.snag.z + 6, yaw: Math.atan2(-14, -6), pitch: 0.35 },
  },
  {
    name: 'commons',
    land: 'rainforest',
    hour: H.golden,
    note: 'the fire and its ring of logs',
    find: (w) => ({ x: w.commons.x + 10, z: w.commons.z + 5, yaw: Math.atan2(-10, -5), pitch: -0.08 }),
  },
  {
    name: 'body-down',
    land: 'rainforest',
    hour: H.morning,
    note: 'the first angle the body is visible at — just past the gate',
    find: () => ({ x: 0, z: 5, yaw: 0, pitch: -0.7 }),
  },
  {
    name: 'body-sitting',
    land: 'rainforest',
    hour: H.golden,
    note: 'sitting at the commons, looking down at your own legs',
    find: (w) => ({ x: w.commons.x, z: w.commons.z, yaw: 0, pitch: -0.62, sit: true }),
  },
  {
    name: 'body-steep',
    land: 'rainforest',
    hour: H.morning,
    note: 'and straight down, which is the worst case for a capsule cap',
    find: () => ({ x: 0, z: 5, yaw: 0, pitch: -0.92 }),
  },

  // ---- the trip ------------------------------------------------------------
  {
    name: 'surge-a',
    land: 'rainforest',
    hour: H.morning,
    note: 'the peak in the open, frame one',
    find: () => ({ x: 0, z: 5, yaw: 0, pitch: -0.02 }),
    seek: 190,
  },
  {
    name: 'surge-b',
    land: 'rainforest',
    hour: H.morning,
    note: 'the same view 3 s later — the wave should have MOVED, not just breathed',
    find: () => ({ x: 0, z: 5, yaw: 0, pitch: -0.02 }),
    seek: 190,
    hold: 3000,
  },
  {
    name: 'afterglow',
    land: 'rainforest',
    hour: H.morning,
    note: 'the wood a minute after a trip ended on its own',
    find: () => ({ x: -34, z: -46, yaw: 1.1, pitch: 0.02 }),
    seek: 297,
    hold: 4000,
  },
];

if (args.list === 'true') {
  for (const s of SCENES) console.log(`${s.name.padEnd(20)} ${s.land.padEnd(11)} ${s.note}`);
  process.exit(0);
}

const only = args.only ? new Set(String(args.only).split(',')) : null;
const wanted = SCENES.filter((s) => !only || only.has(s.name));
if (!wanted.length) {
  console.log('no scene matched --only. Nothing was shot.');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const LANDS = { rainforest: 'grove-01', taiga: 'taiga:grove-01' };
const byLand = new Map();
for (const s of wanted) {
  if (!byLand.has(s.land)) byLand.set(s.land, []);
  byLand.get(s.land).push(s);
}

const report = [];
const noise = [];

for (const [land, scenes] of byLand) {
  console.log(`\n${land}`);
  const browser = await chromium.launch({
    args: [
      '--use-gl=angle',
      '--use-angle=default',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  page.on('console', (m) => {
    if (m.type() === 'error') noise.push(`${land}: ${m.text().slice(0, 150)}`);
  });
  page.on('pageerror', (e) => noise.push(`${land}: PAGEERROR ${e.message.slice(0, 150)}`));
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`${BASE}?seed=${encodeURIComponent(LANDS[land])}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.RR !== undefined, { timeout: 60000 });
  await page.click('#enter');
  await page.waitForSelector('#gate.gone', { timeout: 40000 }).catch(() => {});
  await page.waitForFunction(() => window.RR.forest?.settled, null, { timeout: 90000 }).catch(() => {});
  await page.addStyleTag({ content: '#help,#prompt,#toast,#phase{opacity:0 !important}' });

  /**
   * THE CAVE IS THE THIRD STREAMING RING AND `forest.settled` DOES NOT KNOW
   * ABOUT IT.
   *
   * A cave builds at about 0.6 ms a frame, so the nearest one takes tens of
   * seconds — and an instrument that waits for the forest and then photographs
   * a chamber gets a world with no cave in it. `caves.settled` answers for that
   * ring; `caves.size === 0` is settled and not unsettled, so this also
   * terminates on a seed with no mouth in range.
   */
  const wantsCave = scenes.some((s) => s.name.startsWith('cave-'));
  if (wantsCave) {
    process.stdout.write('  waiting for a cave to build');
    await page.evaluate(() => {
      // Stand at the nearest mouth so the field builds THAT one first.
      const R = window.RR;
      const near = [...(R.caves?.caves?.values() ?? [])].map((c) => c.c).filter(Boolean);
      if (!near.length) return;
      const best = near.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
      R.controller.position.set(best.x, R.controller.position.y, best.z);
      R.controller.applyToCamera();
    });
    await page
      .waitForFunction(() => window.RR.caves?.settled && window.RR.caves.caves.size > 0, null, { timeout: 180000 })
      .catch(() => {});
    process.stdout.write('\n');
  }

  /** Everything the scenes below ask the running world for, gathered once. */
  const world = await page.evaluate(async () => {
    const R = window.RR;
    const terrain = await import('/src/world/terrain.js');
    const out = {};
    const sites = R.gathering?.sites;
    out.commons = sites?.commons ? { x: sites.commons.x, z: sites.commons.z } : { x: 0, z: 0 };
    const j = sites?.jetties?.[0];
    out.jetty = j ? { x: j.x, z: j.z, yaw: j.yaw ?? 0 } : null;

    // The highest ground within 500 m, for the two sunset frames.
    let best = { y: -Infinity, x: 0, z: 0 };
    for (let i = 0; i < 700; i++) {
      const t = i / 700;
      const r = 80 + t * 420;
      const a = t * Math.PI * 2 * 9;
      const x = Math.sin(a) * r;
      const z = Math.cos(a) * r;
      const y = terrain.heightAt(x, z);
      if (y > best.y) best = { y, x, z };
    }
    out.ridge = { x: best.x, z: best.z };

    // Which way is the sun, right now, in the controller's yaw convention.
    const s = R.atmosphere?.sun?.position;
    // `sun.position` is where the light comes FROM, and a THREE directional
    // light's position is its direction rather than a place — so facing the
    // sun is facing the position, and the controller's forward is
    // (-sin yaw, -cos yaw). Verified by photograph rather than by algebra: the
    // first version of this line put the sunset behind the camera in both
    // frames, which is a mistake that looks exactly like the feature not
    // working.
    out.sunYaw = s ? Math.atan2(s.x, s.z) : 0;

    // The spawn corridor's bearing, if sites publishes one.
    try {
      const m = await import('/src/world/sites.js');
      const look = m.spawnLook?.();
      out.spawnYaw = typeof look === 'number' ? look : (look?.yaw ?? 0);
    } catch {
      out.spawnYaw = 0;
    }

    // A snag: the fauna work exports a grid of them from forest.js.
    try {
      const f = await import('/src/world/forest.js');
      const g = f.snagZones;
      const list = g?.near ? g.near(R.controller.position.x, R.controller.position.z) : null;
      const one = list && list.length ? list[0] : null;
      out.snag = one ? { x: one.x, z: one.z } : null;
    } catch {
      out.snag = null;
    }

    // A roost, a shaft and a mouth, from whichever cave is built.
    out.roost = null;
    out.shaft = null;
    out.mouth = null;
    for (const cave of R.caves?.caves?.values() ?? []) {
      if (!out.roost && cave.roosts?.length) {
        const r = cave.roosts[0];
        out.roost = { x: r.cx ?? r.x, y: r.cy ?? r.y, z: r.cz ?? r.z };
      }
      if (!out.shaft && cave.shafts?.length) {
        const s2 = cave.shafts[0];
        out.shaft = { x: s2.x, y: (s2.y ?? 0) - 4, z: s2.z };
      }
      if (!out.mouth && cave.c) {
        const c = cave.c;
        const inn = terrain.caveAxisPoint(c, c.aHold + 26, 0, {});
        const at = terrain.caveAxisPoint(c, c.aHold, 0, {});
        out.mouth = {
          inx: inn.x,
          iny: (R.caves.floorAt?.(inn.x, inn.z) ?? terrain.heightAt(inn.x, inn.z)) + 1.7,
          inz: inn.z,
          outYaw: Math.atan2(at.x - inn.x, at.z - inn.z) + Math.PI,
        };
      }
    }
    return out;
  });

  await page.evaluate(() => {
    window.__tour = async (s) => {
      const R = window.RR;
      const { controller, camera, atmosphere, forest, director } = R;
      if (s.seek === null || s.seek === undefined) director.ground();
      else director.seek(s.seek);
      atmosphere.day.set(s.hour);
      controller.fly = !!s.fly;
      if (s.sit) {
        const seat = R.seats?.nearest?.(controller.position);
        if (seat) R.sitting.sit(seat);
      } else if (R.sitting?.seated) {
        R.sitting.stand?.();
      }
      controller.velocity.set(0, 0, 0);
      controller.yaw = s.yaw;
      controller.pitch = s.pitch;
      if (s.y !== undefined && s.y !== null) controller.position.set(s.x, s.y, s.z);
      else controller.position.set(s.x, controller.position.y, s.z);
      controller.applyToCamera();
      atmosphere.follow(camera, controller.position);
      atmosphere.applyDay(s.hour);
      atmosphere.stepSun(s.hour);
      /**
       * ALWAYS WRITTEN, NEVER INHERITED. The first version only called this
       * when a scene named `weather`, on the reasoning that undefined means
       * 'do not touch' — which is true of the API and wrong for a tour: the
       * scene after a storm then photographed the storm. `path-air` came out
       * as a rainy canopy and `water-down` as a rained-on river, and both
       * read as the feature misbehaving rather than as the harness leaking.
       */
      atmosphere.forceWeather?.(s.weather ?? null);
      forest.cull(camera, true);
      /**
       * A TELEPORT INTO A CHAMBER MUST NOT BE FOLLOWED BY GRAVITY, and a
       * teleport onto the surface must. Underground the y IS the answer — it
       * came from the cave's own floor — and letting the body fall from it is
       * how a camera ends up under the floor of a passage. Above ground the y is
       * a guess and the fall is what makes it right.
       */
      if (!s.teleport && !s.fly) {
        await new Promise((resolve) => {
          let last = NaN;
          let still = 0;
          let n = 0;
          const poll = () => {
            const y = controller.position.y;
            still = Math.abs(y - last) < 1e-4 ? still + 1 : 0;
            last = y;
            if (still > 5 || ++n > 200) resolve();
            else requestAnimationFrame(poll);
          };
          requestAnimationFrame(poll);
        });
      }
      await new Promise((r) => setTimeout(r, 400));
      controller.velocity.set(0, 0, 0);
      if (s.y !== undefined && s.y !== null) controller.position.set(s.x, s.y, s.z);
      controller.yaw = s.yaw;
      controller.pitch = s.pitch;
      controller.applyToCamera();
      atmosphere.applyDay(s.hour);
      forest.cull(camera, true);
      return { y: controller.position.y, roofed: controller.roofed, inCave: controller.inCave };
    };
  });

  for (const s of scenes) {
    const where = s.find(world);
    if (!where) {
      console.log(`  ${s.name.padEnd(20)} SKIPPED — the world has no such thing here`);
      report.push({ name: s.name, land, skipped: true, note: s.note });
      continue;
    }
    const at = await page.evaluate(
      (spec) => window.__tour(spec),
      { ...where, hour: s.hour, seek: s.seek ?? null, weather: s.weather }
    );
    if (s.hold) await page.waitForTimeout(s.hold);
    else await page.waitForTimeout(350);
    const file = `${OUT}/${s.name}.png`;
    await page.screenshot({ path: file });
    console.log(`  ${s.name.padEnd(20)} ${s.note}`);
    report.push({ name: s.name, land, file, note: s.note, at });
  }

  // Hand the weather back, so nothing leaks into the next land's page.
  await page.evaluate(() => window.RR.atmosphere.forceWeather?.(null)).catch(() => {});
  await browser.close();
}

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(`\n${report.filter((r) => !r.skipped).length} frames -> ${OUT}`);
if (noise.length) {
  console.log(`\n${noise.length} console problem(s):`);
  for (const n of [...new Set(noise)].slice(0, 8)) console.log(`  ${n}`);
}
