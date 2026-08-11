import { chromium } from 'playwright';

/**
 * Which layer is provoking a GL warning?
 *
 * A driver warning names the draw call and nothing else, so the only way to
 * attribute it is to draw less and see when it stops. This walks the probe's
 * own layer switches — the same ones a human uses from the console — turning
 * each layer off on its own and then leaving only one on, and counts warnings
 * per configuration.
 *
 *   node scripts/gl-warn.mjs [--url=…]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });

let warnings = [];
page.on('console', (m) => {
  if (m.type() === 'warning' && m.text().includes('Mismatch between texture format')) {
    warnings.push(m.text());
  }
});

/**
 * DEAFEN THE PAGE TO HOT RELOADS BEFORE IT LOADS.
 *
 * This counts warnings per layer configuration, and a reload both resets the
 * layers and re-runs the whole first-frame shader compile — which is where a
 * driver emits its warnings anyway. The count then lands on whichever
 * configuration happened to be current, and the script names the wrong layer
 * with total confidence. Same guard as play-check.mjs.
 */
await page.routeWebSocket(/.*/, () => {});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(1500);

const layers = await page.evaluate(() => Object.keys(window.RR.probe.layers));

/** Render for a bit under a named configuration and count what the driver said. */
async function measure(label, setup) {
  await page.evaluate(setup);
  // Warnings already in flight from the previous configuration would otherwise
  // be charged to this one.
  await page.waitForTimeout(400);
  warnings = [];
  await page.waitForTimeout(1100);
  const n = warnings.length;
  process.stdout.write(`${label.padEnd(26)}${n}\n`);
  return n;
}

console.log('\nconfiguration              warnings');
console.log('-'.repeat(36));

const base = await measure('everything on', () => window.RR.probe.reset());

console.log('\n— one layer off at a time —');
const suspects = [];
for (const name of layers) {
  const n = await measure(`without ${name}`, `(() => {
    window.RR.probe.all(true);
    window.RR.probe.show(${JSON.stringify(name)}, false);
  })()`);
  if (base > 0 && n === 0) suspects.push(name);
}

console.log('\n— only one layer on —');
const solo = [];
for (const name of layers) {
  const n = await measure(`only ${name}`, `window.RR.probe.only(${JSON.stringify(name)})`);
  if (n > 0) solo.push(name);
}

console.log('\n— shadows —');
await page.evaluate(() => window.RR.probe.reset());
await measure('shadows off', () => window.RR.probe.shadows(false));
await measure('shadows back on', () => window.RR.probe.shadows(true));

console.log(`\nbaseline: ${base} warning(s) per second of rendering`);
if (suspects.length) console.log(`silenced by hiding: ${suspects.join(', ')}`);
if (solo.length) console.log(`warns on its own:   ${solo.join(', ')}`);
if (!suspects.length && !solo.length && base > 0) {
  console.log('no single layer accounts for it — suspect a render-target or state change');
}

await browser.close();
