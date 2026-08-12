import { chromium } from 'playwright';

/** Do perchers actually fly to a branch and land on it, in view, and finish? */
const URL = process.argv[2] ?? 'http://127.0.0.1:5180/';
const SECONDS = Number(process.argv[3] ?? 70);

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.evaluate(() => {
  const g = document.getElementById('gate');
  if (g && !g.classList.contains('gone')) document.getElementById('enter')?.click();
});
await page.waitForTimeout(2500);

const out = await page.evaluate(async (secs) => {
  const ps = window.RR.fauna.__perchers;
  const prev = new Map();
  const log = { hops: 0, flushes: 0, landed: 0, timedOut: 0, teleports: 0, maxAir: 0, air: [] };
  const start = new Map();
  const at = new Map();
  for (const p of ps) prev.set(p, p.state);

  const t0 = performance.now();
  while (performance.now() - t0 < secs * 1000) {
    const now = performance.now();
    for (const p of ps) {
      const was = prev.get(p);
      if (was === p.state) continue;
      if (p.state === 'land' && was === 'perch') {
        log.hops++;
        start.set(p, now);
        at.set(p, { x: p.pos.x, y: p.pos.y, z: p.pos.z });
      } else if (p.state === 'flee') {
        log.flushes++;
      } else if (p.state === 'perch' && was === 'land') {
        const t = (now - (start.get(p) ?? now)) / 1000;
        log.landed++;
        log.air.push(+t.toFixed(2));
        if (t > 6.9) log.timedOut++;
        if (t > log.maxAir) log.maxAir = t;
      } else if (p.state === 'perch' && was === 'flee') {
        log.teleports++;
      }
      prev.set(p, p.state);
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  log.stuck = ps.filter((p) => p.state === 'land').length;
  log.states = ps.reduce((a, p) => ((a[p.state] = (a[p.state] || 0) + 1), a), {});
  return log;
}, SECONDS);

console.log(`\nover ${SECONDS}s:`);
console.log(`  voluntary hops started : ${out.hops}`);
console.log(`  flushes (you scared it): ${out.flushes}`);
console.log(`  landings completed     : ${out.landed}`);
console.log(`  ...of which hit the 7 s guard instead of arriving: ${out.timedOut}`);
console.log(`  teleported home unseen after a flush: ${out.teleports}`);
console.log(`  time in the air, s: ${out.air.slice(0, 14).join(', ')}`);
console.log(`  longest flight: ${out.maxAir.toFixed(2)} s`);
console.log(`  still airborne at the end: ${out.stuck}`);
console.log(`  final states: ${JSON.stringify(out.states)}`);

const ok = out.hops > 0 && out.landed > 0 && out.timedOut === 0;
console.log(`\n${ok ? 'PASS' : 'FAIL'}: birds fly to branches and settle on them.`);
await browser.close();
