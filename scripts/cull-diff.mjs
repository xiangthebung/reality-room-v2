import { chromium } from 'playwright';

/**
 * WHICH mesh does the culled frame disagree with the restored frame about?
 *
 * `cull-check` proves a difference exists and says nothing about where. This
 * stands at the failing station, packs for the camera, records every instanced
 * mesh's count and visibility, then calls `restoreAll` and records them again.
 * Any mesh whose count goes UP under restoreAll is one the frustum test
 * rejected buckets from; if the frame changed, one of those buckets was on
 * screen after all.
 *
 *   node scripts/cull-diff.mjs [--x=707] [--z=707] [--yaw=0.6]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const X = Number(args.x ?? 707);
const Z = Number(args.z ?? 707);
const YAW = Number(args.yaw ?? 0.6);

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2500);

const report = await page.evaluate(
  async ({ x, z, yaw }) => {
    const R = window.RR;
    const frame = () => new Promise((r) => requestAnimationFrame(r));

    R.director.seek(160);
    for (let i = 0; i < 30; i++) R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
    R.pipeline.setTripParameters({ trail: 0 });

    // Walk there so the streamer keeps up, exactly as cull-check does.
    const x0 = R.controller.position.x;
    const z0 = R.controller.position.z;
    const steps = Math.max(1, Math.ceil(Math.hypot(x - x0, z - z0) / 90));
    for (let i = 1; i <= steps; i++) {
      R.controller.position.x = x0 + ((x - x0) * i) / steps;
      R.controller.position.z = z0 + ((z - z0) * i) / steps;
      R.controller.velocity.set(0, 0, 0);
      await frame();
      await frame();
    }
    for (let i = 0; i < 260; i++) await frame();

    R.controller.position.set(x, R.controller.position.y, z);
    R.controller.velocity.set(0, 0, 0);
    R.controller.yaw = yaw;
    R.controller.pitch = 0;
    R.controller.applyToCamera();
    R.camera.position.y = R.controller.position.y;
    R.atmosphere.follow(R.camera);
    R.forest.cull(R.camera, true);

    const snapshot = () => {
      const rows = new Map();
      R.scene.traverse((o) => {
        if (!o.isInstancedMesh) return;
        const key = `${o.name}#${o.id}`;
        rows.set(key, { count: o.count, visible: o.visible });
      });
      return rows;
    };

    /**
     * Which layer's restored instances actually put pixels on the screen?
     *
     * Counts alone cannot answer it — restoreAll adds eighty thousand
     * instances and almost all of them are behind the camera or past the fog,
     * contributing nothing. So render the pair again with one layer visible at
     * a time. The layer whose pair differs is the one the frustum test was
     * wrong about; every other layer's extra instances are genuinely invisible
     * and their agreement proves it.
     */
    const gl2 = R.renderer.getContext();
    const w = gl2.drawingBufferWidth;
    const h = gl2.drawingBufferHeight;
    const bufA = new Uint8Array(w * h * 4);
    const bufB = new Uint8Array(w * h * 4);
    const shoot = (buf) => {
      R.pipeline.render(1 / 60);
      R.pipeline.render(1 / 60);
      gl2.readPixels(0, 0, w, h, gl2.RGBA, gl2.UNSIGNED_BYTE, buf);
    };
    const compare = () => {
      let n = 0;
      let worst = 0;
      for (let i = 0; i < bufA.length; i += 4) {
        const d =
          Math.abs(bufA[i] - bufB[i]) +
          Math.abs(bufA[i + 1] - bufB[i + 1]) +
          Math.abs(bufA[i + 2] - bufB[i + 2]);
        if (d > 0) {
          n++;
          if (d > worst) worst = d;
        }
      }
      return { n, worst };
    };

    const perLayer = [];
    for (const layer of Object.keys(R.probe.layers)) {
      R.probe.only(layer);
      R.forest.cull(R.camera, true);
      shoot(bufA);
      R.forest.culler.restoreAll();
      shoot(bufB);
      const { n, worst } = compare();
      if (n > 0) perLayer.push({ layer, differing: n, worst });
    }
    R.probe.reset();
    R.forest.cull(R.camera, true);

    // Ask every slab packer where it thinks its buckets fall, with the same
    // eye the cull just used.
    const bands = R.forest.culler.packers
      .filter((p) => typeof p.bandStats === 'function')
      .map((p) => p.bandStats(R.camera.position))
      .filter((s) => s.name === 'trunk');

    const culled = snapshot();
    R.forest.culler.restoreAll();
    const restored = snapshot();

    const diffs = [];
    for (const [key, c] of culled) {
      const r = restored.get(key);
      if (!r) continue;
      if (r.count !== c.count || r.visible !== c.visible) {
        diffs.push({
          mesh: key,
          culled: c.count,
          restored: r.count,
          added: r.count - c.count,
          visibleCulled: c.visible,
          visibleRestored: r.visible,
        });
      }
    }
    diffs.sort((a, b) => b.added - a.added);
    return {
      bands,
      perLayer,
      total: diffs.length,
      addedTotal: diffs.reduce((s, d) => s + d.added, 0),
      visibilityFlips: diffs.filter((d) => d.visibleCulled !== d.visibleRestored).length,
      top: diffs.slice(0, 18),
    };
  },
  { x: X, z: Z, yaw: YAW }
);

console.log(`\nat (${X}, ${Z}) yaw ${YAW}`);
console.log('\nlayers whose culled and restored frames differ, drawn alone:');
if (!report.perLayer.length) console.log('  none — every layer agrees with itself in isolation');
for (const l of report.perLayer) {
  console.log(`  ${l.layer.padEnd(16)}${String(l.differing).padStart(8)} px   worst ${l.worst}/765`);
}
console.log('\ntrunk packers (near band ends at minDistance, far band begins there):');
console.log('  id    buckets  eyeSeen  min      max      inBand(now)  inBand(stored)');
for (const b of report.bands) {
  console.log(
    `  ${String(b.id).padEnd(6)}${String(b.buckets).padEnd(9)}${String(b.eyeSeen).padEnd(9)}${String(b.minDistance).padEnd(9)}${String(b.maxDistance).padEnd(9)}${String(b.inBandNow).padEnd(13)}${b.inBandStored}`
  );
}
const blind = report.bands.filter((b) => !b.eyeSeen && b.buckets > 0);
if (blind.length) {
  console.log(
    `\n>>> ${blind.length} trunk packer(s) hold buckets but never recorded an eye — restoreAll submits ALL of them`
  );
}
console.log('');
console.log(`meshes that differ: ${report.total}`);
console.log(`instances added by restoreAll: ${report.addedTotal}`);
console.log(`meshes whose .visible flipped: ${report.visibilityFlips}`);
console.log('\nmesh                                   culled  restored   added  vis c->r');
console.log('-'.repeat(78));
for (const d of report.top) {
  console.log(
    `${d.mesh.padEnd(38)}${String(d.culled).padEnd(8)}${String(d.restored).padEnd(10)}${String(
      d.added
    ).padEnd(7)}${d.visibleCulled}->${d.visibleRestored}`
  );
}

await browser.close();
