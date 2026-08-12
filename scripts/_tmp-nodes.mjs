import { chromium } from 'playwright';
const URL = process.argv[2] ?? 'http://127.0.0.1:5180/';
const LABEL = process.argv[3] ?? URL;
const b = await chromium.launch({ args: ['--use-gl=angle','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 900, height: 560 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
// Count live scheduled sources before any app code runs.
await p.addInitScript(() => {
  window.__live = 0; window.__peak = 0; window.__started = 0;
  const wrap = (proto, name) => {
    const make = proto[name];
    if (!make) return;
    proto[name] = function (...a) {
      const node = make.apply(this, a);
      const start = node.start?.bind(node);
      if (start) {
        node.start = (...s) => {
          window.__live++; window.__started++;
          if (window.__live > window.__peak) window.__peak = window.__live;
          node.addEventListener('ended', () => { window.__live--; }, { once: true });
          return start(...s);
        };
      }
      return node;
    };
  };
  wrap(AudioContext.prototype, 'createOscillator');
  wrap(AudioContext.prototype, 'createBufferSource');
});
await p.goto(URL, { waitUntil: 'load' });
await p.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await p.evaluate(() => { const g=document.getElementById('gate'); if(g&&!g.classList.contains('gone')) document.getElementById('enter')?.click(); });
await p.waitForFunction(() => window.RR.audio?.ready === true, { timeout: 25000 });
await p.evaluate(() => { window.RR.music?.stop?.(); window.__peak = 0; window.__started = 0; });
const r = await p.evaluate(async () => {
  let sum = 0, n = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 60000) { sum += window.__live; n++; await new Promise((r) => setTimeout(r, 25)); }
  return { peak: window.__peak, mean: sum / n, started: window.__started };
});
console.log(`${LABEL}: peak live sources ${r.peak}, mean ${r.mean.toFixed(1)}, started ${r.started} in 60 s`);
await b.close();
