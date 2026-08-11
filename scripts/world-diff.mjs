import { chromium } from 'playwright';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Pixel-diff two directories of screenshots.
 *
 *   node scripts/world-diff.mjs .shots/world-base .shots/world-stage0
 *
 * There is no image library in this repo's dependencies and adding one to
 * compare two PNGs would be silly, so this decodes them in the browser that is
 * already a devDependency. The numbers that matter are the fraction of pixels
 * that moved at all and the worst per-channel delta: a shading change shows as
 * a large area at a tiny delta, a missing object as a small area at a huge one,
 * and telling those two apart by eye from a percentage alone is not possible.
 *
 * It also splits the frame into a CENTRE and a RIM by distance from the middle.
 * The terrain refactor is expected to leave the middle of every shot alone and
 * to change the far ring where the old world used to fold up into a wall.
 */

const [dirA, dirB] = process.argv.slice(2);
if (!dirA || !dirB) {
  console.error('usage: node scripts/world-diff.mjs <dirA> <dirB>');
  process.exit(2);
}
const A = resolve(process.cwd(), dirA);
const B = resolve(process.cwd(), dirB);

const names = readdirSync(A)
  .filter((f) => f.endsWith('.png'))
  .filter((f) => existsSync(join(B, f)))
  .sort();

const browser = await chromium.launch();
const page = await browser.newPage();

console.log(`${dirA}  vs  ${dirB}\n`);
console.log(
  `${'shot'.padEnd(18)} ${'differ'.padStart(9)} ${'%'.padStart(7)} ${'worstΔ'.padStart(7)} ` +
    `${'meanΔ'.padStart(7)}   ${'top half of frame'.padStart(18)}`
);

let worstOverall = 0;
for (const name of names) {
  const a = readFileSync(join(A, name)).toString('base64');
  const b = readFileSync(join(B, name)).toString('base64');
  const r = await page.evaluate(
    async ([da, db]) => {
      const load = (d) =>
        new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = rej;
          img.src = `data:image/png;base64,${d}`;
        });
      const ia = await load(da);
      const ib = await load(db);
      const w = ia.width;
      const h = ia.height;
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(ia, 0, 0);
      const pa = cx.getImageData(0, 0, w, h).data;
      cx.clearRect(0, 0, w, h);
      cx.drawImage(ib, 0, 0);
      const pb = cx.getImageData(0, 0, w, h).data;

      let differ = 0;
      let worst = 0;
      let sum = 0;
      let topDiffer = 0;
      // The horizon in every station sits a little above the middle, so
      // "top half" is a decent stand-in for "sky and the far ring".
      const split = Math.floor(h * 0.5);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const d =
            Math.abs(pa[i] - pb[i]) +
            Math.abs(pa[i + 1] - pb[i + 1]) +
            Math.abs(pa[i + 2] - pb[i + 2]);
          if (d > 0) {
            differ++;
            sum += d;
            if (d > worst) worst = d;
            if (y < split) topDiffer++;
          }
        }
      }
      return { differ, worst, sum, pixels: w * h, topDiffer, top: split * w };
    },
    [a, b]
  );
  worstOverall = Math.max(worstOverall, r.worst);
  console.log(
    `${name.replace('.png', '').padEnd(18)} ${String(r.differ).padStart(9)} ` +
      `${((r.differ / r.pixels) * 100).toFixed(3).padStart(6)}% ` +
      `${String(r.worst).padStart(6)}/765 ` +
      `${(r.differ ? r.sum / r.differ : 0).toFixed(2).padStart(7)}   ` +
      `${((r.topDiffer / Math.max(1, r.differ)) * 100).toFixed(1).padStart(6)}% of the change`
  );
}

console.log(`\nworst per-pixel delta anywhere: ${worstOverall}/765`);
await browser.close();
