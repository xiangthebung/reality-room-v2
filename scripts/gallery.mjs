import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * THE GALLERY — every land, every place worth standing, at three hours.
 *
 *   node scripts/gallery.mjs --out=.shots/gallery/before
 *   node scripts/gallery.mjs --out=.shots/gallery/after --lands=taiga
 *   node scripts/gallery.mjs --hours=night --stations=cave,water
 *
 * WHY THIS EXISTS AND WHY IT IS NOT `shoot.mjs`. `shoot.mjs` photographs one
 * wood at one hour through the trip's envelope, which is the right instrument
 * for the trip and blind to everything else: it has never taken a picture of
 * the taiga, of the night, of a cave, of the water, or of a fire with people
 * round it. Half of this project's visible surface has therefore never been in
 * a regression shot, and the two defects that shipped anyway — a winter wood
 * whose snow reads as algae, and a night sky with four stars in it — were both
 * in that blind half.
 *
 * The output is deliberately a FLAT FOLDER OF `land-station-hour.png`, so a
 * before/after is a file manager side by side and needs no tooling at all.
 *
 * THE STATIONS ARE FOUND, NOT TYPED. `shoot.mjs`'s six are literal xz pairs
 * chosen against `grove-01` in August, and its `stream` station has had no
 * water in it since the terrain moved — a station that photographs the wrong
 * thing is worse than no station, because it goes on passing. So every station
 * below except `spawn` and `deep` asks the running world where the thing is:
 * the commons from `gathering.sites`, a jetty from the same, a cave mouth from
 * `caves.caves`, and the vista from whichever site is highest. A land with no
 * cave in range simply skips that row and says so.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const BASE = args.url ?? 'http://127.0.0.1:5180/';
const OUT = args.out ?? '.shots/gallery';
const WIDTH = Number(args.width ?? 1440);
const HEIGHT = Number(args.height ?? 810);

/** Seed prefix per land. A bare seed is the rainforest — see world/lands. */
const LANDS = {
  rainforest: 'grove-01',
  taiga: 'taiga:grove-01',
};

/** The hours. Same numbers day-check uses, so the two can be compared. */
const HOURS = {
  night: 0.03,
  morning: 0.3758,
  golden: 0.762,
};

const wantLands = args.lands ? String(args.lands).split(',') : Object.keys(LANDS);
const wantHours = args.hours ? String(args.hours).split(',') : Object.keys(HOURS);
const wantStations = args.stations ? String(args.stations).split(',') : null;

mkdirSync(OUT, { recursive: true });

const report = [];

for (const land of wantLands) {
  const seed = LANDS[land];
  if (!seed) {
    console.log(`no such land: ${land}`);
    continue;
  }
  console.log(`\n${land}  (seed ${seed})`);

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
  const noise = [];
  page.on('console', (m) => {
    if (m.type() === 'error') noise.push(m.text());
  });
  page.on('pageerror', (e) => noise.push('PAGEERROR ' + e.message));
  // Never let a capture run take the signalling server down. See day-check.
  await page.routeWebSocket(/.*/, () => {});

  await page.goto(`${BASE}?seed=${encodeURIComponent(seed)}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.RR !== undefined, { timeout: 60000 });
  // The first gesture is the only one a real click survives — see the note in
  // scripts/play-check.mjs about Playwright's actionability polling starving.
  await page.click('#enter');
  await page.waitForFunction(() => window.RR.forest?.settled, null, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(2500);

  // Hide the help strip and the prompt: they are chrome, they are already
  // tested elsewhere, and they sit across the bottom of every single frame.
  await page.addStyleTag({ content: '#help,#prompt,#toast,#phase{opacity:0 !important}' });

  /** Ask the world where its own furniture is. */
  const stations = await page.evaluate(async () => {
    const R = window.RR;
    /**
     * terrain.js, imported into the page rather than reached through `RR`.
     *
     * `caveAxisPoint` is the only honest way to get a cave's bearing — the
     * descriptor stores the ridge basis (`sa`, `ca`, `u0`, `v0`, `inSign`) and
     * not a yaw, and re-deriving the projection here would be the same
     * duplicated-maths drift the terrain worker's header warns about. This is
     * a capture script and a second module copy costs nothing: nothing here
     * reads mutable module state, only a pure function of the descriptor.
     */
    const terrain = await import('/src/world/terrain.js');
    const out = [];
    const yawTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z) + Math.PI;

    out.push({ name: 'spawn', x: 0, z: 5, yaw: 0.0, pitch: -0.02 });
    out.push({ name: 'deep', x: -34, z: -46, yaw: 1.1, pitch: 0.02 });
    out.push({ name: 'canopy', x: -30, z: -40, yaw: 0.8, pitch: 0.9 });

    const sites = R.gathering?.sites;
    if (sites?.commons) {
      const c = sites.commons;
      // Stand back from the fire so the ring of logs is in frame, not your feet.
      const a = 0.9;
      out.push({
        name: 'commons',
        x: c.x + Math.sin(a) * 11,
        z: c.z + Math.cos(a) * 11,
        yaw: yawTo({ x: c.x + Math.sin(a) * 11, z: c.z + Math.cos(a) * 11 }, c),
        pitch: -0.06,
      });
    }
    const jetty = sites?.jetties?.[0];
    if (jetty) {
      out.push({
        name: 'water',
        x: jetty.x,
        z: jetty.z,
        yaw: (jetty.yaw ?? 0) + Math.PI / 2,
        pitch: -0.16,
      });
    }

    /**
     * THE VISTA — the highest ground within half a kilometre, looking out over
     * the lowest quarter of the horizon.
     *
     * The one station that photographs DRAW DISTANCE and LANDMARKS, which every
     * other station in this file is structurally unable to see: at eye level in
     * a closed wood you cannot see 40 m, so a change that deletes the far world
     * is invisible from all five of them and catastrophic from this one. The
     * recorded finding is exactly that — cutting draw distance is invisible at
     * eye level and catastrophic from above.
     */
    {
      let best = { y: -Infinity, x: 0, z: 0 };
      for (let i = 0; i < 900; i++) {
        // A coarse spiral rather than a grid: 900 heightAt calls, no allocation.
        const t = i / 900;
        const r = 60 + t * 440;
        const a = t * Math.PI * 2 * 11;
        const x = Math.sin(a) * r;
        const z = Math.cos(a) * r;
        const y = terrain.heightAt(x, z);
        if (y > best.y) best = { y, x, z };
      }
      // Face whichever of eight bearings drops away fastest 120 m out.
      let bestYaw = 0;
      let drop = Infinity;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const h = terrain.heightAt(best.x + Math.sin(a) * 120, best.z + Math.cos(a) * 120);
        if (h < drop) {
          drop = h;
          bestYaw = a;
        }
      }
      out.push({ name: 'vista', x: best.x, z: best.z, yaw: bestYaw + Math.PI, pitch: -0.02 });
    }

    /**
     * A cave mouth, if one has been built within streaming range.
     *
     * `cave.c` is the descriptor and its `x`/`z` ARE the mouth — `buildCave`
     * sets them from `caveAxisPoint(c, c.aHold, 0)`. Stepping `a` outward by
     * 14 m gives a standing point on the approach, and looking back at the
     * mouth from there is looking into the doorway.
     */
    const caves = R.caves?.caves;
    if (caves && caves.size) {
      let best = null;
      for (const cave of caves.values()) {
        const c = cave.c;
        if (!c || typeof c.x !== 'number') continue;
        const d = Math.hypot(c.x, c.z);
        if (!best || d < best.d) best = { d, c };
      }
      if (best) {
        const c = best.c;
        const mouth = terrain.caveAxisPoint(c, c.aHold, 0, {});
        const stand = terrain.caveAxisPoint(c, c.aHold - 14, 0, {});
        out.push({
          name: 'cave',
          x: stand.x,
          z: stand.z,
          yaw: yawTo(stand, mouth),
          pitch: -0.03,
        });
      }
    }
    return out;
  });

  console.log(`  stations: ${stations.map((s) => s.name).join(', ')}`);

  // The parking harness, lifted verbatim from day-check.mjs — including the
  // 100 m detour that forces the sun anchor's 6 m hysteresis, without which
  // the first station's shadow map is a function of wherever rAF left you.
  await page.evaluate(() => {
    window.__grounded = () =>
      new Promise((resolve) => {
        const R = window.RR;
        let last = NaN;
        let still = 0;
        let n = 0;
        const poll = () => {
          const y = R.controller.position.y;
          still = Math.abs(y - last) < 1e-4 ? still + 1 : 0;
          last = y;
          if (still > 6 || ++n > 240) resolve();
          else requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      });
    window.__settle = () =>
      new Promise((resolve) => {
        const R = window.RR;
        let n = 0;
        const poll = () => {
          if ((R.forest?.settled && !R.forest?.pending) || ++n > 600) resolve();
          else requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      });
    window.__park = async (s, phase) => {
      const R = window.RR;
      R.atmosphere.day.set(phase);
      R.controller.velocity.set(0, 0, 0);
      R.controller.yaw = s.yaw;
      R.controller.pitch = s.pitch;
      R.controller.position.set(s.x + 100, R.controller.position.y, s.z);
      R.controller.applyToCamera();
      R.atmosphere.follow(R.camera, R.controller.position);
      R.controller.position.set(s.x, R.controller.position.y, s.z);
      R.controller.applyToCamera();
      R.atmosphere.follow(R.camera, R.controller.position);
      R.atmosphere.applyDay(phase);
      R.atmosphere.stepSun(phase);
      R.forest.cull(R.camera, true);
      await window.__grounded();
      await window.__settle();
      await new Promise((r) => setTimeout(r, 500));
      R.controller.velocity.set(0, 0, 0);
      R.controller.position.set(s.x, R.controller.position.y, s.z);
      R.controller.yaw = s.yaw;
      R.controller.pitch = s.pitch;
      R.controller.applyToCamera();
      R.atmosphere.applyDay(phase);
      R.forest.cull(R.camera, true);
    };
  });

  for (const s of stations) {
    if (wantStations && !wantStations.includes(s.name)) continue;
    for (const hour of wantHours) {
      const phase = HOURS[hour];
      if (phase === undefined) continue;
      await page.evaluate(([s, p]) => window.__park(s, p), [s, phase]);
      await page.waitForTimeout(350);
      const file = `${OUT}/${land}-${s.name}-${hour}.png`;
      await page.screenshot({ path: file });
      process.stdout.write(`  ${land}-${s.name}-${hour}\n`);
      report.push({ land, station: s.name, hour, file });
    }
  }

  if (noise.length) {
    console.log(`  ${noise.length} console problem(s):`);
    for (const n of [...new Set(noise)].slice(0, 6)) console.log(`    ${n.slice(0, 160)}`);
  }
  await browser.close();
}

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(`\n${report.length} frames -> ${OUT}`);
