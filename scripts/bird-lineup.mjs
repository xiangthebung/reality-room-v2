import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every species of bird, side by side, close enough to see.
 *
 * WHY THIS EXISTS AND `fauna-pose.mjs` DOES NOT COVER IT. That script pins ONE
 * percher eleven metres off and photographs it where it lives, which is the
 * honest shot and useless for judging a colour: at eleven metres in this
 * undergrowth a bird is nine pixels behind a blade of grass. Whether a robin's
 * front is actually orange and whether a great tit is distinguishable from a
 * yellowhammer are questions you can only answer with the birds in a row, lit
 * the same, at a size where the mark is legible.
 *
 * THE TWO THINGS THAT MAKE IT WORK, both of which are about not disturbing the
 * thing being measured:
 *
 *   A LONG LENS, NOT A CLOSE CAMERA. A percher flushes inside nine metres — see
 *   `startle` in fauna.js — so walking up to one photographs an empty branch.
 *   The birds stay at sixteen metres where they are calm and the FOV drops to
 *   twelve degrees, which fills the frame without ever entering the radius.
 *   The alternative the pose script uses for its close-up is a peak trip level,
 *   which suppresses the flush and also hue-rotates the entire palette — fine
 *   for a silhouette and worthless for checking plumage.
 *
 *   ABOVE THE GRASS. Three metres up. The grass in this wood reaches most of
 *   two and the birds are the size of a fist.
 *
 *   node scripts/bird-lineup.mjs [--url=…] [--out=.shots/bird-lineup]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots/bird-lineup');
mkdirSync(OUT, { recursive: true });

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
  const t = m.type();
  if (t === 'error' || t === 'warning') problems.push(`[${t}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2000);
await page.evaluate(() => {
  for (const id of ['toast', 'help', 'social', 'stats']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
});

const names = await page.evaluate(async () => {
  const { buildFauna } = await import('/src/world/fauna.js');
  const { heightAt } = await import('/src/world/terrain.js');
  const wildlife = await import('/src/audio/wildlife.js');
  const fauna = buildFauna({ scene: window.RR.scene, seed: 'grove-01' });
  fauna.setPixelRatio(window.RR.renderer.getPixelRatio());
  window.__fauna = fauna;
  window.__row = null;
  window.__tod = 0.42;

  // One percher per voice. The roster is dealt so that all sixteen are present;
  // this just finds where each one landed.
  const bySpecies = new Map();
  fauna.__perchers.forEach((p, i) => {
    if (!bySpecies.has(p.voice)) bySpecies.set(p.voice, i);
  });
  window.__bySpecies = bySpecies;

  let last = performance.now();
  const step = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const row = window.__row;
    if (row) {
      // Everything not in the row goes far away so it cannot drift into shot.
      fauna.__perchers.forEach((p) => {
        p.pos.set(700, heightAt(700, 700), 700);
        p.home.copy(p.pos);
        p.state = 'perch';
        p.timer = 99;
      });
      row.slots.forEach((slot, n) => {
        const p = fauna.__perchers[slot];
        if (!p) return;
        const x = row.x0 + n * row.step;
        const z = row.z;
        p.pos.set(x, heightAt(x, z) + row.up, z);
        p.home.copy(p.pos);
        /**
         * A three-quarter view, and the sign matters. A creature's yaw 0 faces
         * POSITIVE z while the controller's yaw 0 looks down negative z — the
         * two conventions are opposite, which `fauna-pose.mjs` also warns
         * about. The camera stands at +z, so a bird facing it is near yaw 0 and
         * the PI this started with photographed eight birds from behind.
         *
         * Slightly off-axis rather than square on, because the mark is anchored
         * on the breast and a bird head-on is mostly bill: at 0.6 you get the
         * front patch and the flank in the same frame.
         */
        p.yaw = 0.6;
        p.state = 'perch';
        p.timer = 99;
        p.open = 0.04;
      });
    }
    fauna.update(dt, {
      camera: window.RR.camera,
      tripLevel: window.RR.director.level,
      timeOfDay: window.__tod,
    });
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return wildlife.VOICE_NAMES;
});

/**
 * The numbers behind the pictures.
 *
 * A bird in this wood is sixty pixels of dart seen through canopy shadow, and
 * "is the yellowhammer's head actually yellow" is not a question a picture that
 * size answers reliably — the shot tells you a bird is visible and legible,
 * this tells you the colour it was actually given. Base times tint, in the 0-255
 * anybody can read, which is what PLUMAGE's multipliers are so easy to get
 * wrong about.
 */
const swatches = await page.evaluate(async () => {
  const w = await import('/src/audio/wildlife.js');
  const mesh = window.__fauna.birds;
  const tint = mesh.geometry.getAttribute('aTint');
  const mark = mesh.geometry.getAttribute('aMark');
  const base = mesh.material.color;
  /**
   * BACK TO sRGB BEFORE PRINTING, and this is not a cosmetic detail.
   *
   * `material.color` holds LINEAR components — three converts on assignment
   * under colour management — so scaling them straight to 0-255 reports a robin
   * at (64,59,41), which reads as "still far too dark" and is simply the wrong
   * space. The same colour displayed is (140,124,89). Printing the linear
   * number would send you off darkening a table that was already right.
   */
  const px = (c) => {
    const v = Math.min(1, Math.max(0, c));
    const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(s * 255);
  };
  const rows = [];
  const seen = new Set();
  window.__fauna.__perchers.forEach((p) => {
    if (seen.has(p.voice)) return;
    seen.add(p.voice);
    const s = p.slot;
    rows.push({
      name: w.VOICE_NAMES[p.voice] ?? `voice${p.voice}`,
      hen: !!p.hen,
      coat: [px(base.r * tint.getX(s)), px(base.g * tint.getY(s)), px(base.b * tint.getZ(s))],
      mark: [px(base.r * mark.getX(s)), px(base.g * mark.getY(s)), px(base.b * mark.getZ(s))],
      reach: +mark.getW(s).toFixed(3),
    });
  });
  return rows.sort((a, b) => a.name.localeCompare(b.name));
});
console.log('species         sex   coat rgb         mark rgb          reach');
for (const r of swatches) {
  console.log(
    ` ${r.name.padEnd(14)} ${(r.hen ? 'hen' : 'cock').padEnd(5)} ` +
      `${`(${r.coat.join(',')})`.padEnd(17)} ${`(${r.mark.join(',')})`.padEnd(17)} ${r.reach}`
  );
}
console.log('');

const CAM = { x: 0, z: 4 };
const DIST = 16;
/**
 * Four at a time, not eight. A PERCHED bird folds its wings to 13% of its span
 * — see the shader — so the thing being photographed is a body a third of a
 * metre long and not a wingspan. Eight of them across a frame put each one at
 * about thirty pixels, which is enough to see that a bird is there and not
 * enough to judge a colour, which is the entire purpose.
 */
const PER_SHOT = 4;
const STEP = 0.45;
const FOV = 6;

for (let shot = 0; shot * PER_SHOT < names.length; shot++) {
  const slice = [];
  for (let i = 0; i < PER_SHOT; i++) {
    const v = shot * PER_SHOT + i;
    if (v < names.length) slice.push(v);
  }
  await page.evaluate(
    ({ cam, dist, step, voices, up, fov }) => {
      const { director, controller } = window.RR;
      director.ground();
      controller.position.x = cam.x;
      controller.position.z = cam.z;
      controller.velocity.set(0, 0, 0);
      controller.yaw = 0;
      // Tuned against the 12 degree lens and the three metre perch, not by eye:
      // at the default pitch the row sits at 0.8 of the way up the frame.
      controller.pitch = 0.112;
      /**
       * A long lens. See the header: this is what keeps the camera outside the
       * startle radius while still filling the frame.
       *
       * ON THE DIRECTOR, NOT ON THE CAMERA, and main.js says why where it
       * registers the quality setting: the dolly zoom rewrites `camera.fov`
       * every frame from `_baseFov`, so a value written to the camera survives
       * exactly one frame and is then replaced. Written straight to the camera
       * this shot came out at the default sixty degrees with eight birds three
       * pixels wide in the middle of it.
       */
      director._baseFov = fov;
      director._fov = fov;
      window.RR.camera.fov = fov;
      window.RR.camera.updateProjectionMatrix();
      window.__row = {
        slots: voices.map((v) => window.__bySpecies.get(v)),
        x0: cam.x - ((voices.length - 1) * step) / 2,
        step,
        z: cam.z - dist,
        up,
      };
    },
    { cam: CAM, dist: DIST, step: STEP, voices: slice, up: 3, fov: FOV }
  );
  await page.waitForTimeout(1400);
  const where = await page.evaluate(() => {
    const cam = window.RR.camera;
    const row = window.__row;
    return row.slots.map((slot) => {
      const p = window.__fauna.__perchers[slot];
      if (!p) return 'MISSING';
      const v = p.pos.clone().project(cam);
      return `${p.state} w(${p.pos.x.toFixed(1)},${p.pos.y.toFixed(1)},${p.pos.z.toFixed(1)}) s(${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)})`;
    });
  });
  console.log(where.join('\n'));
  const label = slice.map((v) => names[v]).join('-');
  await page.screenshot({ path: resolve(OUT, `${shot + 1}-${label}.png`) });
  console.log(`${shot + 1}: ${slice.map((v) => names[v]).join(', ')}`);
}

console.log(problems.length ? `\n${problems.join('\n')}` : '\nno console problems');
await browser.close();
