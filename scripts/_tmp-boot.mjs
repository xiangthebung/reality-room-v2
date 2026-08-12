import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
p.on('console', (m) => { if (m.type()==='error') console.log('[console]', m.text()); });
await p.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
await p.waitForTimeout(8000);
console.log('RR present:', await p.evaluate(() => typeof window.RR));
await b.close();
