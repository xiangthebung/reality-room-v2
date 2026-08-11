import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The acceptance test, which is a person looking at pictures.
 *
 * Everything else about the endless forest can be measured — no holes, no
 * leaks, the culler is invisible, the frame is inside budget, the authored
 * region is bit-identical. None of that answers the only question that
 * matters, which is whether the far world reads as a forest that goes on for
 * ever or as wallpaper. So this walks out and takes pictures, and somebody
 * looks at them.
 *
 * Three distances because the failure modes are different at each. At 400 m
 * you are just outside the authored disc and the question is whether the seam
 * shows. At 1 km you are entirely in generated country and the question is
 * whether it has any character. At 2 km the question is whether it is the same
 * country you saw at 1 km with the noise reseeded, which is what wallpaper
 * means.
 *
 * Two headings at each, because a forest that looks convincing along one
 * bearing and repeats along another is the classic tell, and one shot from head
 * height plus one looking up — the canopy is half of what makes a wood a wood
 * and it is the half a ground-level screenshot never shows.
 *
 *   node scripts/far-shots.mjs [--url=…] [--out=.shots/far]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots/far');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2500);
await page.evaluate(() => {
  document.getElementById('toast').style.display = 'none';
  document.getElementById('help').style.display = 'none';
});

/**
 * Walk, do not teleport.
 *
 * Both fields take at most one sector per frame on purpose, so arriving
 * somewhere in one jump lands in ground the rings have not reached and
 * photographs a hole a real player walking there would never have seen. Hops of
 * 90 m are under the 128 m tree sector pitch, so the ring is never surprised.
 */
async function walkTo(x, z) {
  await page.evaluate(
    async ({ x, z }) => {
      const { controller } = window.RR;
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const x0 = controller.position.x;
      const z0 = controller.position.z;
      const steps = Math.max(1, Math.ceil(Math.hypot(x - x0, z - z0) / 90));
      for (let i = 1; i <= steps; i++) {
        controller.position.x = x0 + ((x - x0) * i) / steps;
        controller.position.z = z0 + ((z - z0) * i) / steps;
        controller.velocity.set(0, 0, 0);
        await frame();
        await frame();
      }
      for (let i = 0; i < 300; i++) await frame();
    },
    { x, z }
  );
}

const STOPS = [
  { d: 400, bearing: Math.PI * 0.25 },
  { d: 1000, bearing: Math.PI * 0.25 },
  { d: 2000, bearing: Math.PI * 0.25 },
  // A different bearing entirely, so the far world is sampled somewhere the
  // walk out did not pass through.
  { d: 1400, bearing: -Math.PI * 0.7, tag: 'sw' },
];

for (const stop of STOPS) {
  const x = Math.cos(stop.bearing) * stop.d;
  const z = Math.sin(stop.bearing) * stop.d;
  await walkTo(x, z);
  const tag = stop.tag ? `${stop.d}m-${stop.tag}` : `${stop.d}m`;
  for (const view of [
    { name: 'level', yaw: stop.bearing + Math.PI * 0.5, pitch: -0.02 },
    { name: 'back', yaw: stop.bearing + Math.PI, pitch: 0.05 },
    { name: 'up', yaw: stop.bearing, pitch: 0.8 },
  ]) {
    await page.evaluate(
      ({ yaw, pitch }) => {
        window.RR.controller.yaw = yaw;
        window.RR.controller.pitch = pitch;
      },
      view
    );
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/${tag}-${view.name}.png` });
    process.stdout.write(`${tag}-${view.name}\n`);
  }
}

// And once at the peak, because the fog thins through the dissolve and the far
// treeline is exactly what that reveals — the frame a ring too short would
// announce itself on.
await page.evaluate(() => {
  window.RR.director.seek(220);
  window.RR.controller.pitch = 0.06;
});
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/1400m-egodeath.png` });
process.stdout.write('1400m-egodeath\n');

const stats = await page.evaluate(() => {
  const R = window.RR;
  let trunks = 0;
  let leaves = 0;
  R.scene.traverse((o) => {
    if (!o.isInstancedMesh || !o.visible) return;
    if (o.name === 'trunk') trunks += o.count;
    if (o.name === 'leaf') leaves += o.count;
  });
  return {
    sectors: R.forest.field.sectors,
    built: R.forest.field.built,
    evicted: R.forest.field.evicted,
    shadowArms: R.forest.field.shadowArms,
    growths: R.forest.growths,
    patches: R.forest.patches.length,
    trunks,
    leaves,
  };
});
console.log('\n', JSON.stringify(stats));

await browser.close();
