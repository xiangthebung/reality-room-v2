import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(process.argv[2] ?? '.fishshots');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
await page.routeWebSocket(/.*/, () => {});
await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 60000 });
await page.click('#enter');
await page.waitForTimeout(3500);

const shot = async (name) => {
  writeFileSync(resolve(OUT, `${name}.png`), await page.screenshot());
  console.log(`  ${name}.png`);
};

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

await page.evaluate(
  ([bx, bz, ang]) => {
    const { controller } = window.RR;
    const px = bx + Math.cos(ang + Math.PI / 2) * 5;
    const pz = bz + Math.sin(ang + Math.PI / 2) * 5;
    controller.position.x = px;
    controller.position.z = pz;
    controller.yaw = Math.atan2(-(bx - px), -(bz - pz));
    controller.pitch = -0.4;
  },
  [bank.x, bank.z, bank.angle]
);
await page.waitForTimeout(3000);

const report = await page.evaluate(() => {
  const { shoal, camera, controller } = window.RR;
  const m = shoal.mesh.instanceMatrix.array;
  const fwdx = -Math.sin(controller.yaw);
  const fwdz = -Math.cos(controller.yaw);
  const rows = [];
  for (let i = 0; i < shoal.count; i++) {
    const x = m[i * 16 + 12];
    const y = m[i * 16 + 13];
    const z = m[i * 16 + 14];
    const dx = x - camera.position.x;
    const dz = z - camera.position.z;
    const ahead = dx * fwdx + dz * fwdz;
    const d = Math.hypot(dx, dz);
    const sc = Math.hypot(m[i * 16], m[i * 16 + 1], m[i * 16 + 2]);
    rows.push({ i, d: +d.toFixed(1), ahead: +ahead.toFixed(1), under: +(-3.4 - y).toFixed(3), cm: Math.round(sc * 100) });
  }
  rows.sort((a, b) => a.d - b.d);
  return {
    visible: shoal.mesh.visible,
    within12: rows.filter((r) => r.d < 12).length,
    inFrontWithin20: rows.filter((r) => r.ahead > 1 && r.d < 20).length,
    nearest: rows.slice(0, 8),
  };
});
console.log(JSON.stringify(report, null, 1));
await shot('F1-shoal-now');
// Decisive: lift the whole shoal two metres into the air. If it does not
// appear there, it is not being drawn at all.
await page.evaluate(() => { window.RR.shoal.mesh.position.y = 2.2; });
await page.waitForTimeout(500);
await shot('F2-lifted');
await page.evaluate(() => { window.RR.shoal.mesh.position.y = 0; });
console.log(await page.evaluate(() => {
  const m = window.RR.shoal.mesh;
  return JSON.stringify({
    visible: m.visible, count: m.count, frustumCulled: m.frustumCulled,
    bs: m.boundingSphere && { c: m.boundingSphere.center.toArray().map(v=>+v.toFixed(1)), r: m.boundingSphere.radius },
    parentVisible: m.parent?.visible, inScene: !!m.parent,
    matVisible: m.material.visible, transparent: m.material.transparent, op: m.material.opacity,
    layers: m.layers.mask, camLayers: window.RR.camera.layers.mask,
  });
}));

await browser.close();
