import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(process.argv[2] ?? '.fishshots');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.routeWebSocket(/.*/, () => {});
await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 60000 });
await page.click('#enter');
await page.waitForTimeout(3500);

const shot = async (name) => {
  const buf = await page.screenshot();
  writeFileSync(resolve(OUT, `${name}.png`), buf);
  console.log(`  ${name}.png`);
};

// Find the river and stand on the bank.
const bank = await page.evaluate(() => {
  const { fishing, controller } = window.RR;
  const at = (x, z) => {
    controller.position.x = x;
    controller.position.z = z;
    return fishing.water;
  };
  for (let r = 6; r <= 140; r += 6) {
    for (let a = 0; a < 64; a++) {
      const t = (a / 64) * Math.PI * 2;
      const w = at(Math.cos(t) * r, Math.sin(t) * r);
      if (w) return { x: w.bank.x, z: w.bank.z, angle: w.bank.angle };
    }
  }
  return null;
});
console.log('bank', bank);

const stand = (out, pitch) =>
  page.evaluate(
    ([bx, bz, ang, dist, p]) => {
      const { controller } = window.RR;
      const px = bx + Math.cos(ang + Math.PI / 2) * dist;
      const pz = bz + Math.sin(ang + Math.PI / 2) * dist;
      controller.position.x = px;
      controller.position.z = pz;
      controller.yaw = Math.atan2(-(bx - px), -(bz - pz));
      controller.pitch = p;
    },
    [bank.x, bank.z, bank.angle, out, pitch]
  );

// Noon, so the water is legible.
await page.evaluate(() => window.RR.atmosphere?.day?.setHour?.(13));
await page.waitForTimeout(400);

console.log('\n1. the shoal, from the bank looking down');
await stand(3.5, -0.42);
await page.waitForTimeout(3000);
await shot('01-shoal-close');

await stand(6, -0.28);
await page.waitForTimeout(2500);
await shot('02-shoal-wide');

console.log('\n2. the rod out, nothing cast');
await stand(6, -0.05);
await page.evaluate(() => {
  const f = window.RR.fishing;
  if (f.state === 'off') f.toggle();
});
await page.waitForTimeout(1200);
await shot('03-rod-ready');

console.log('\n3. loading a cast');
await page.evaluate(() => {
  const f = window.RR.fishing;
  f.hold();
});
await page.waitForTimeout(1100);
await shot('04-loading');

console.log('\n4. the tackle in the air');
await page.evaluate(() => {
  const f = window.RR.fishing;
  f.release();
});
await page.waitForTimeout(260);
await shot('05-flight');
await page.waitForTimeout(1600);
await shot('06-landed-float');

console.log('\n5. a fish on, and the line under load');
await page.evaluate(
  ([bx, bz]) => {
    const f = window.RR.fishing;
    if (f.state !== 'waiting') {
      if (f.state !== 'ready') {
        f.stow();
        f.toggle();
      }
      f._settle(bx, bz);
      f._lineOut = 9;
    }
    f._catch = { kind: 'fish', name: 'pike', cm: 96, notable: true, power: 0.9, hue: 0x556138 };
    f._elapsed = 99;
    f._timer = 0.001;
    f.state = 'waiting';
    f.update(0.02);
    f.act();
    f._tension = 0.85;
    f._fish.stamina = 0.12;
    f._fish.running = true;
  },
  [bank.x, bank.z]
);
await page.waitForTimeout(600);
await shot('07-fish-on');

console.log('\n6. the fish on the bank');
await page.evaluate(() => {
  const f = window.RR.fishing;
  const c = window.RR.controller;
  for (let i = 0; i < 1800 && f.state === 'playing'; i++) {
    c.keys.add('KeyE');
    f._fish.stamina = 0;
    f.update(1 / 60);
  }
  c.keys.delete('KeyE');
  window.RR.controller.pitch = -0.55;
  return f.state;
});
await page.waitForTimeout(500);
await shot('08-on-the-grass');
await page.waitForTimeout(900);
await shot('09-on-the-grass-later');

if (errors.length) {
  console.log('\npage errors:');
  for (const e of errors.slice(0, 8)) console.log('  ' + e);
}
await browser.close();
