import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 900, height: 560 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(process.argv[2] ?? 'http://127.0.0.1:5180/', { waitUntil: 'load' });
await p.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await p.evaluate(() => { const g=document.getElementById('gate'); if(g&&!g.classList.contains('gone')) document.getElementById('enter')?.click(); });
await p.waitForFunction(() => window.RR.audio?.ready === true, { timeout: 25000 });
await p.waitForTimeout(1500);
const r = await p.evaluate(async () => {
  const w = window.RR.fauna.__wildlife;
  let max = 0, sum = 0, n = 0, hush = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 60000) {
    if (w.voices > max) max = w.voices;
    sum += w.voices; n++;
    if (w._hush > 0) hush++;
    await new Promise((r) => setTimeout(r, 25));
  }
  return { max, mean: sum / n, hushFraction: hush / n, ceiling: 58, budget: w._songBudget };
});
console.log(`live audio voices  max ${r.max} / ceiling ${r.ceiling},  mean ${r.mean.toFixed(1)}`);
console.log(`chorus hushed for ${(r.hushFraction * 100).toFixed(1)}% of the minute`);
console.log(`song bucket left: ${r.budget.toFixed(2)}`);
await b.close();
