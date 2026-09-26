import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * IS THE SNOW WHITE, AND DOES IT CLIP? — a number for a complaint about a hue.
 *
 *   node scripts/_snow-probe.mjs [--seed=taiga:grove-01] [--out=.shots/snow]
 *
 * The winter wood's floor was reported as reading "like algae and mud" and then,
 * after a palette pass, "like a turquoise lagoon". Both are judgements about
 * SATURATION on a surface that should be nearly achromatic, and both were made
 * by eye off a screenshot — which is exactly the way this project has recorded
 * getting a colour wrong twice, because a warm sun on a neutral albedo and a
 * yellow albedo look identical in a still.
 *
 * So this reports, over the ground band of the frame only (the bottom third,
 * where the floor is and the sky is not), four things per station and hour:
 *
 *   mean       the average sRGB triple, which says whether it is bright
 *   sat        (max-min)/max averaged per pixel, which says whether it is white
 *   hue        the mean hue in degrees of the pixels with any saturation at all,
 *              which says WHICH WAY it is wrong — 60 is the yellow-green
 *              complaint, 180 the turquoise one
 *   clip       the fraction of pixels at 250+ in all three channels, which is
 *              the thing a brighter albedo can break and nobody measured
 *
 * A leading underscore because this is a probe for one question and not a gate.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const SEED = args.seed ?? 'taiga:grove-01';
const OUT = args.out ?? '.shots/snow';
mkdirSync(OUT, { recursive: true });

const HOURS = { morning: 0.3758, noon: 0.5, golden: 0.762 };
const STATIONS = [
  { name: 'spawn', x: 0, z: 5, yaw: 0.0, pitch: -0.22 },
  { name: 'deep', x: -34, z: -46, yaw: 1.1, pitch: -0.18 },
];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.routeWebSocket(/.*/, () => {});
await page.goto(`http://127.0.0.1:5180/?seed=${encodeURIComponent(SEED)}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 60000 });
await page.click('#enter');
await page.waitForFunction(() => window.RR.forest?.settled, null, { timeout: 90000 }).catch(() => {});
await page.waitForTimeout(2500);
await page.addStyleTag({ content: '#help,#prompt,#toast,#phase{opacity:0 !important}' });

await page.evaluate(() => {
  window.__park = async (s, phase) => {
    const R = window.RR;
    R.atmosphere.day.set(phase);
    R.controller.velocity.set(0, 0, 0);
    R.controller.yaw = s.yaw;
    R.controller.pitch = s.pitch;
    R.controller.position.set(s.x, R.controller.position.y, s.z);
    R.controller.applyToCamera();
    R.atmosphere.follow(R.camera, R.controller.position);
    R.atmosphere.applyDay(phase);
    R.atmosphere.stepSun(phase);
    R.forest.cull(R.camera, true);
    await new Promise((r) => setTimeout(r, 1400));
    R.controller.position.set(s.x, R.controller.position.y, s.z);
    R.controller.applyToCamera();
    R.atmosphere.applyDay(phase);
    R.forest.cull(R.camera, true);
  };
});

/**
 * FED A PNG, NOT THE LIVE CANVAS, and the first version of this probe was the
 * recorded mistake: `gl.readPixels` on the default framebuffer returns nothing
 * usable here, because the context has no `preserveDrawingBuffer` and the
 * drawing buffer is gone by the time script runs after a present. It reported
 * NaN for every station with no error anywhere. `page.screenshot()` goes
 * through the compositor and is correct — and it is the same PNG that gets
 * written to disk, so the number and the picture cannot disagree. Same
 * technique as `day-check.mjs`, whose header records the identical trap.
 */
await page.evaluate(() => {
  window.__bandOf = async (b64) => {
    const img = await new Promise((res) => {
      const im = new Image();
      im.onload = () => res(im);
      im.src = 'data:image/png;base64,' + b64;
    });
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const y0 = Math.floor(c.height * 0.66);
    const px = g.getImageData(0, y0, c.width, c.height - y0).data;
    let r = 0, g2 = 0, b = 0, sat = 0, n = 0, clip = 0;
    let hx = 0, hy = 0, hn = 0;
    for (let i = 0; i < px.length; i += 4) {
      const R = px[i], G = px[i + 1], B = px[i + 2];
      if (R + G + B < 24) continue; // black is not a colour judgement
      r += R; g2 += G; b += B; n++;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      const s = mx === 0 ? 0 : (mx - mn) / mx;
      sat += s;
      if (R > 249 && G > 249 && B > 249) clip++;
      if (s > 0.06) {
        let hdeg;
        const d = mx - mn;
        if (mx === R) hdeg = 60 * (((G - B) / d) % 6);
        else if (mx === G) hdeg = 60 * ((B - R) / d + 2);
        else hdeg = 60 * ((R - G) / d + 4);
        const rad = (hdeg * Math.PI) / 180;
        hx += Math.cos(rad); hy += Math.sin(rad); hn++;
      }
    }
    const hue = hn ? ((Math.atan2(hy, hx) * 180) / Math.PI + 360) % 360 : NaN;
    return {
      mean: [Math.round(r / n), Math.round(g2 / n), Math.round(b / n)],
      sat: +(sat / n).toFixed(3),
      hue: +hue.toFixed(0),
      clip: +(clip / n).toFixed(4),
    };
  };
});

const measure = async (file) => {
  const buf = await page.screenshot({ path: file });
  return page.evaluate((b64) => window.__bandOf(b64), buf.toString('base64'));
};

const rows = [];
for (const s of STATIONS) {
  for (const [hour, phase] of Object.entries(HOURS)) {
    await page.evaluate(([s, p]) => window.__park(s, p), [s, phase]);
    await page.waitForTimeout(300);
    const m = await measure(`${OUT}/${s.name}-${hour}.png`);
    rows.push({ station: s.name, hour, ...m });
  }
}
await browser.close();

console.log(`\nground band (bottom third), seed ${SEED}`);
console.log('  station  hour      mean RGB        sat    hue   clip');
for (const r of rows) {
  console.log(
    `  ${r.station.padEnd(8)} ${r.hour.padEnd(8)} ` +
      `(${String(r.mean[0]).padStart(3)},${String(r.mean[1]).padStart(3)},${String(r.mean[2]).padStart(3)})   ` +
      `${r.sat.toFixed(3)}  ${String(r.hue).padStart(4)}  ${(r.clip * 100).toFixed(2)}%`
  );
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(rows, null, 2));
console.log(
  '\nsnow should be bright and nearly colourless: sat under ~0.10, no strong hue,\n' +
    'and clip well under 1%. hue near 60 is the yellow-green complaint, near 180 the\n' +
    'turquoise one, near 30 is warm sunlight on white and is correct.'
);
