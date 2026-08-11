import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * Measure the trail's actual contribution, as a difference image.
 *
 * "Does the trail leave a visible second image" is answerable by subtraction:
 * render the identical frame with the trail on and off and look at what the
 * trail added. A soft, diffuse difference is persistence — a psychedelic glow.
 * A difference concentrated into thin high-contrast structures is a ghost of the
 * picture, i.e. double vision, which is the thing the user does not want.
 *
 * The diff is computed inside the page by loading both PNGs back into a 2D
 * canvas, because that is far less code than decoding PNG in Node.
 */
const OUT = '.shots/ghost';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2000);
await page.evaluate(() => { document.getElementById('ui').style.display = 'none'; });

/**
 * A PAIRED capture, one frame apart.
 *
 * The first version of this took the trail-on and trail-off frames seven
 * seconds apart, which meant the difference image was dominated by the colour
 * field drifting and the wind moving — it measured time passing, not the trail,
 * and reported a 12% mean difference for an effect that is mathematically
 * incapable of altering a settled frame by more than about 1%.
 *
 * So: let the trail reach steady state, screenshot, then switch the trail off
 * and screenshot again immediately. Between the two, the world advances by a
 * couple of frames — negligible next to several seconds of accumulated smear —
 * so what is left in the difference is the trail and almost nothing else.
 */
async function pair(station, wait = 9000) {
  await page.evaluate((s) => {
    const { controller, director, pipeline, probe } = window.RR;
    probe.freeze(false);
    director.seek(190);
    director.state.override = 1;
    director.eased = 1;
    pipeline.trailEnabled = true;
    pipeline.clearHistory();
    controller.position.x = s.x; controller.position.z = s.z;
    controller.velocity.set(0, 0, 0);
    controller.yaw = s.yaw; controller.pitch = s.pitch;
  }, station);
  // Let the wake build with the world moving...
  await page.waitForTimeout(wait);
  // ...then stop the world dead, so the only thing that can differ between the
  // next two frames is the term being measured. Without this the difference
  // image is dominated by a few frames of wind and melt, which traces every
  // edge in the picture and looks exactly like the artefact being hunted.
  await page.evaluate(() => window.RR.probe.freeze(true));
  await page.waitForTimeout(900);
  const on = (await page.screenshot()).toString('base64');
  await page.evaluate(() => { window.RR.pipeline.trailEnabled = false; });
  await page.waitForTimeout(300);
  const off = (await page.screenshot()).toString('base64');
  await page.evaluate(() => window.RR.probe.freeze(false));
  return [on, off];
}

const STATIONS = {
  clearing: { x: 0, z: 5, yaw: 0.0, pitch: -0.02 },
  deep: { x: -34, z: -46, yaw: 1.1, pitch: -0.16 },
};

for (const [name, station] of Object.entries(STATIONS)) {
  const [on, off] = await pair(station);
  const stats = await page.evaluate(async ([a, b]) => {
    const load = (d) => new Promise((res) => {
      const img = new Image();
      img.onload = () => res(img);
      img.src = 'data:image/png;base64,' + d;
    });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const c = document.createElement('canvas');
    c.width = ia.width; c.height = ia.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(ia, 0, 0);
    const da = g.getImageData(0, 0, c.width, c.height).data;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(ib, 0, 0);
    const db = g.getImageData(0, 0, c.width, c.height).data;

    const n = c.width * c.height;
    const diff = new Float32Array(n);
    let sum = 0, max = 0;
    for (let i = 0; i < n; i++) {
      const d = (Math.abs(da[i * 4] - db[i * 4]) +
                 Math.abs(da[i * 4 + 1] - db[i * 4 + 1]) +
                 Math.abs(da[i * 4 + 2] - db[i * 4 + 2])) / 3 / 255;
      diff[i] = d; sum += d; if (d > max) max = d;
    }
    const mean = sum / n;
    // How concentrated is the difference? A ghost of the picture is sparse and
    // strong; a diffuse glow is broad and weak. Report the share of total
    // difference living in the brightest 2% of pixels.
    const sorted = Float32Array.from(diff).sort();
    const top2 = sorted.subarray(Math.floor(n * 0.98));
    let topSum = 0;
    for (const v of top2) topSum += v;
    const strong = diff.reduce((acc, v) => acc + (v > 0.06 ? 1 : 0), 0) / n;

    // Paint the difference, amplified, so it can be looked at.
    const out = g.createImageData(c.width, c.height);
    for (let i = 0; i < n; i++) {
      const v = Math.min(255, diff[i] * 255 * 6);
      out.data[i * 4] = v; out.data[i * 4 + 1] = v; out.data[i * 4 + 2] = v; out.data[i * 4 + 3] = 255;
    }
    g.putImageData(out, 0, 0);
    return {
      mean, max,
      concentration: sum > 0 ? topSum / sum : 0,
      strongShare: strong,
      png: c.toDataURL('image/png').split(',')[1],
    };
  }, [on, off]);

  writeFileSync(`${OUT}/${name}-diff.png`, Buffer.from(stats.png, 'base64'));
  writeFileSync(`${OUT}/${name}-trail-on.png`, Buffer.from(on, 'base64'));
  console.log(
    `${name.padEnd(10)} mean ${stats.mean.toFixed(4)}  max ${stats.max.toFixed(3)}  ` +
    `top2%-share ${(stats.concentration * 100).toFixed(0)}%  pixels>6% ${(stats.strongShare * 100).toFixed(2)}%`
  );
}
await browser.close();
