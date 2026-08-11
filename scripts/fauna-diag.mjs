import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 640, height: 400 } });
p.on('pageerror', e => console.log('PAGEERROR', e.message));
p.on('console', m => { if (m.type()==='error') console.log('CONSOLE-ERR', m.text().slice(0,300)); });
await p.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
try { await p.waitForFunction(() => window.RR !== undefined, { timeout: 15000 }); console.log('RR ok'); }
catch { console.log('RR NEVER APPEARED'); }
await b.close();
