import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
page.on('console', m => console.log('[console]', m.type(), m.text().slice(0, 300)));
page.on('pageerror', e => console.log('[pageerror]', e.message, '\n', (e.stack||'').split('\n').slice(0,5).join('\n')));
await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
await page.waitForTimeout(7000);
console.log('RR present:', await page.evaluate(() => typeof window.RR));
await browser.close();
