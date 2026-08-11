import { chromium } from 'playwright';

/**
 * Does the load-time "Mismatch between texture format and sampler type" warning
 * come from the streamed ground, or from something else that landed in this
 * repo at the same time?
 *
 * The A/B is done by REWRITING ground.js in flight, so the page under test is
 * byte-identical apart from one method: `_accept`, which is the only place a
 * chunk ever reaches the scene or arms the shadow map. Nothing else about the
 * app changes, and the repo is not touched.
 *
 * The offending call is `glDrawElementsInstanced`, which in this scene can only
 * be a tree, a fern, a blade of grass or an animal — ground chunks are plain
 * indexed meshes and draw through `glDrawElements`.
 */
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist'],
});

async function run(label, { stubGround = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.route('**/@vite/client', (r) => r.abort());
  if (stubGround) {
    await page.route('**/src/world/ground.js*', async (route) => {
      const res = await route.fetch();
      let body = await res.text();
      // `_accept()` is the ONLY place a chunk mesh is added to the scene and
      // the only place this file arms the shadow map.
      body = body.replace('_accept() {', '_accept() {\n    if (true) { this.done.length = 0; return; }');
      await route.fulfill({ response: res, body });
    });
  }
  const warn = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' && m.text().includes('sampler type')) warn.push(m.text());
  });
  await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
  const info = await page.evaluate(async () => {
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < 160; i++) await raf();
    const R = window.RR;
    let instanced = 0;
    R.scene.traverse((o) => {
      if (o.isInstancedMesh && o.count > 0) instanced++;
    });
    return { chunks: R.forest.groundField.chunks.size, instanced };
  });
  await page.waitForTimeout(800);
  console.log(
    `${label.padEnd(38)} ${String(warn.length).padStart(4)} warnings   ` +
      `${String(info.chunks).padStart(3)} chunks, ${info.instanced} instanced meshes drawing`
  );
  await page.close();
  return warn.length;
}

const withGround = await run('ground field as written');
const withoutGround = await run('ground field stubbed out', { stubGround: true });
console.log(
  `\n${withoutGround > 0 ? 'the warning survives without the ground field — not caused by it' : 'the warning disappears without the ground field'}`
);

await browser.close();
