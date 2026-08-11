import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { caveAxisPoint, cavesNear, setWorldSeed } from '../src/world/terrain.js';

/**
 * Look at a cave mouth from outside it.
 *
 * Every other cave picture in this repo was taken from inside one, which is the
 * half that was easy to be confident about: a passage either encloses you or it
 * does not. The crag — the rock the hood is now allowed to stand proud of the
 * hillside with, see the block at HOOD_PROUD in caves.js — only exists to be
 * seen from outside and at a distance, so it needs a station further out than a
 * gully and a script that puts the camera there deliberately.
 *
 * The stations are computed from the descriptor rather than typed in, because a
 * cave's position is a property of the seed: `caveAxisPoint(c, aHold - back, 0)`
 * is "stand `back` metres down the gully's own axis from the mouth", which is
 * the same place on every seed and on every slot.
 *
 *   node scripts/cave-shots.mjs [--out=.shots/crag] [--seed=grove-01]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots/crag');
const SEED = args.seed ?? 'grove-01';
mkdirSync(OUT, { recursive: true });

setWorldSeed(SEED);
const near = cavesNear(0, 0, 900);
if (near.length < 2) {
  console.log(`only ${near.length} live mouth(s) within 900 m of the origin on ${SEED}`);
}
console.log(`live mouths near the origin on ${SEED}:`);
for (const c of near.slice(0, 4)) {
  console.log(`  k=${c.k}  (${c.x.toFixed(0)}, ${c.z.toFixed(0)})  ${Math.hypot(c.x, c.z).toFixed(0)} m out`);
}

/**
 * WHERE THE MOUTH IS IS A QUESTION FOR THE BUILT CAVE, NOT FOR THE DESCRIPTOR.
 *
 * `c.x, c.z` is the NOTCH's mouth — where the gully reaches full depth — and the
 * tube deliberately does not start there. `buildNodes` walks the gully floor
 * inward looking for the first metre the hillside could roof, which on a normal
 * flank is another ten to twenty metres up the slope, and it is a function of
 * the real height field rather than of the descriptor. Framing on the descriptor
 * points the camera at a patch of gully floor with the actual entrance out of
 * shot above it, which is how the first run of this script managed to photograph
 * a hillside from six stations.
 *
 * So the stations are computed in the page, from ring 0 of the streamed passage.
 * Ring 8 gives the axis to back away along: about 9 m in, far enough that the
 * direction is the passage's and not one ring's worth of noise.
 */
const BACKS = [
  { name: '1-far', back: 130, note: '130 m out' },
  { name: '2-approach', back: 60, note: '60 m out' },
  // Aimed high, because the tor's shoulder is twenty-odd metres over the
  // doorway and a station framed on the doorway crops the landmark out.
  { name: '3-glade', back: 38, aim: 16, note: '38 m out, framed on the tor' },
  { name: '4-mouth', back: 16, note: '16 m out' },
  { name: '5-under', back: 4, note: 'under the lip' },
];

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
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(m.text());
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
// See shoot.mjs: a hot reload mid-run silently reloads the page and every shot
// after it is of the splash screen.
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

/** Put the camera somewhere and let the world catch up with it. */
async function goto(x, z, yaw, pitch) {
  await page.evaluate(
    (s) => {
      const { director, controller } = window.RR;
      director.ground();
      controller.position.x = s.x;
      controller.position.z = s.z;
      controller.velocity.set(0, 0, 0);
      controller.yaw = s.yaw;
      controller.pitch = s.pitch;
    },
    { x, z, yaw, pitch }
  );
  /**
   * Long enough for the ground AND the passage.
   *
   * A teleport lands in a world whose chunks are still arriving, and the cave
   * on top of that builds at one ring batch per frame — five or six frames for
   * the mesh, but only after the streamer's half-second rescan has noticed the
   * camera moved. Anything under two seconds photographs a hillside.
   */
  await page.waitForTimeout(2600);
}

for (const [i, c] of near.slice(0, 2).entries()) {
  const tag = i === 0 ? 'a' : 'b';
  // Stand at the notch's mouth first, purely to make the field stream this one.
  await goto(c.x, c.z, 0, 0);
  const ring = await page.evaluate((k) => {
    const cave = window.RR.caves.caves.get(k);
    if (!cave?.path) return null;
    const p = cave.path;
    const j = Math.min(8, p.x.length - 1);
    return { x: p.x[0], y: p.y[0], z: p.z[0], ax: p.x[0] - p.x[j], az: p.z[0] - p.z[j] };
  }, c.k);
  if (!ring) {
    console.log(`k=${c.k}: no passage streamed at the mouth — skipped`);
    continue;
  }
  const al = Math.hypot(ring.ax, ring.az) || 1;
  const ox = ring.ax / al;
  const oz = ring.az / al;

  for (const s of BACKS) {
    const side = s.side ?? 0;
    // Out along the passage's own axis, then across it for the oblique station.
    const x = ring.x + ox * s.back - oz * side;
    const z = ring.z + oz * s.back + ox * side;
    const yaw = Math.atan2(-(ring.x - x), -(ring.z - z));
    await goto(x, z, yaw, 0);
    /**
     * The pitch has to be measured, not guessed: the eye ends up wherever the
     * ground is, the mouth is up a hillside, and the difference between them is
     * the whole reason a station 130 m out sees anything at all.
     */
    const pitch = await page.evaluate(
      (t) => {
        const { controller } = window.RR;
        const dist = Math.hypot(t.x - controller.position.x, t.z - controller.position.z);
        const p = Math.atan2(t.y + t.aim - controller.position.y, Math.max(1, dist));
        controller.pitch = p;
        return p;
      },
      { x: ring.x, y: ring.y, z: ring.z, aim: s.aim ?? 2.2 }
    );
    await page.waitForTimeout(700);
    const name = `${tag}${s.name}`;
    await page.screenshot({ path: `${OUT}/${name}.png` });
    const state = await page.evaluate(() => ({
      streamed: window.RR.caves.caves.size,
      built: window.RR.caves.built,
      y: window.RR.controller.position.y,
    }));
    console.log(
      `${name.padEnd(14)} k=${String(c.k).padEnd(3)} ${s.note.padEnd(20)} ` +
        `pitch=${pitch.toFixed(2)} streamed=${state.streamed} built=${state.built} eye=${state.y.toFixed(1)} m`
    );
  }
}

/**
 * And one from the air, which is the only station that shows the SHAPE.
 *
 * Everything above is at eye height in a closed wood, where the answer to "what
 * does this feature look like" is mostly "trunks". Flying is a debug mode and
 * not a place a player ever stands, so this is a diagnostic rather than a
 * picture of the game — it is here because a tor that reads as a boulder from
 * above is one worth knowing about before somebody walks up to it.
 */
for (const [i, c] of near.slice(0, 2).entries()) {
  const tag = i === 0 ? 'a' : 'b';
  await goto(c.x, c.z, 0, 0);
  const ring = await page.evaluate((k) => {
    const cave = window.RR.caves.caves.get(k);
    if (!cave?.path) return null;
    const p = cave.path;
    const j = Math.min(8, p.x.length - 1);
    return { x: p.x[0], y: p.y[0], z: p.z[0], ax: p.x[0] - p.x[j], az: p.z[0] - p.z[j] };
  }, c.k);
  if (!ring) continue;
  const al = Math.hypot(ring.ax, ring.az) || 1;
  for (const [name, back, up] of [
    [`${tag}6-air-near`, 60, 34],
    [`${tag}7-air-far`, 120, 52],
  ]) {
    const x = ring.x + (ring.ax / al) * back;
    const z = ring.z + (ring.az / al) * back;
    await page.evaluate(
      (s) => {
        const { controller } = window.RR;
        controller.fly = true;
        controller.position.set(s.x, s.y, s.z);
        controller.velocity.set(0, 0, 0);
        controller.yaw = s.yaw;
        controller.pitch = s.pitch;
      },
      {
        x,
        y: ring.y + up,
        z,
        yaw: Math.atan2(-(ring.x - x), -(ring.z - z)),
        pitch: Math.atan2(ring.y + 4 - (ring.y + up), back),
      }
    );
    await page.waitForTimeout(2200);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(`${name.padEnd(14)} k=${String(c.k).padEnd(3)} ${back} m out, ${up} m up`);
  }
}
await page.evaluate(() => {
  window.RR.controller.fly = false;
});

// And the clearing, facing whatever the nearest mouth is.
await goto(0, 4, Math.atan2(-near[0].x, -near[0].z), 0.03);
await page.screenshot({ path: `${OUT}/spawn-look.png` });
console.log(`spawn-look     from the spawn, facing k=${near[0].k} at ${Math.hypot(near[0].x, near[0].z).toFixed(0)} m`);

if (problems.length) {
  console.log(`\n${problems.length} console error(s):`);
  for (const p of problems.slice(0, 10)) console.log(' ', p);
} else {
  console.log('\nno console errors');
}
await browser.close();
