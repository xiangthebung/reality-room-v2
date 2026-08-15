import { chromium } from 'playwright';

/**
 * HOW WIDE IS THE FLOOR, AS OPPOSED TO THE PASSAGE?
 *
 * An instrument rather than a gate — the question it answers is "what does this
 * shape feel like to walk down", and that has no pass mark. It exists because
 * the answer was invisible to everything else in this directory: `cave-walk`
 * proves you can get in, `cave-floor` proves the ground is where it is drawn,
 * `cave-end` proves you can reach the terminus, and a player walked a keyhole
 * and said they did not like the feeling of it. None of the three can see that,
 * because none of them looks SIDEWAYS.
 *
 * At every ring, step out from the centre line in 5 cm increments asking
 * `caveSample` — the same answer the body's feet get, not the mesh — how far the
 * ground has risen, and report the lateral room before it has climbed an ankle
 * (0.20 m), a shin (0.45 m) and a knee (0.90 m), against the width of the
 * passage at chest height. Grouped by section kind, which each ring names by the
 * nearest entry in the SHAPES table.
 *
 * The number to read is the LAST TWO COLUMNS TOGETHER. Every shape in this cave
 * has a floor about as wide as the space over it — a tube is 7 m and 7.5 m, a
 * canyon 2.9 m and 2.6 m — except the keyhole, which was 1.65 m of floor under
 * 6.1 m of passage. Four times wider at the chest than at the feet is not a
 * narrow passage, it is a gutter with a hall over it, and it is what the report
 * "I don't like the feeling of walking in it" was about. See FLOOR_HALF.
 *
 *   node scripts/_cave-floorwidth.mjs [--seeds=grove-01,grove-03]
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const SEEDS = (args.seeds ?? 'grove-01').split(',');

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=default',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

for (const SEED of SEEDS) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`http://127.0.0.1:5180/?seed=${SEED}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
  await page.click('#enter');
  await page.waitForSelector('#gate.gone', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const out = await page.evaluate(async () => {
    const R = window.RR;
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const terrain = await import('/src/world/terrain.js');
    const caves = await import('/src/world/caves.js');
    for (const c of terrain.cavesNear(0, 0, 900).slice(0, 2)) {
      R.controller.keys.clear();
      R.controller.fly = true;
      R.controller.position.set(c.x, 60, c.z);
      R.controller.velocity.set(0, 0, 0);
      for (let i = 0; i < 9000 && !R.caves.caves.get(c.k)?.ready; i++) await raf();
    }

    /** Nearest entry in the shape table, so a ring can name itself. */
    const NAMES = {
      tube: [1.16, 1.02, 0.46, 0],
      canyon: [0.6, 1.62, 0.74, 0],
      keyhole: [1.1, 1.1, 0.96, 1],
      bedding: [1.95, 0.44, 0.3, 0],
      room: [1.42, 1.5, 0.62, 0],
      hall: [1.35, 3.0, 0.55, 0],
    };
    const nameOf = (w, t, f, key) => {
      let best = '?';
      let bd = Infinity;
      for (const [n, v] of Object.entries(NAMES)) {
        const d =
          (w - v[0]) ** 2 + (t - v[1]) ** 2 + (f - v[2]) ** 2 + ((key - v[3]) * 2) ** 2;
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
      return best;
    };

    const rows = [];
    for (const [k, cave] of R.caves.caves) {
      if (!cave.ready || !cave.paths) continue;
      const byKind = {};
      for (const p of cave.paths) {
        for (let i = 4; i < p.x.length - 4; i++) {
          const j = Math.min(p.x.length - 1, i + 1);
          const tx = p.x[j] - p.x[i];
          const tz = p.z[j] - p.z[i];
          const tl = Math.hypot(tx, tz) || 1;
          const nx = -tz / tl;
          const nz = tx / tl;
          const kind = nameOf(p.w[i], p.t[i], p.f[i], p.key[i]);
          const probe = (t) =>
            caves.caveSample(p.x[i] + nx * t, p.y[i], p.z[i] + nz * t);
          const mid = probe(0);
          if (mid.inside <= 0.5) continue;
          const base = mid.floor;
          const rise = (t) => {
            const s = probe(t);
            return s.inside <= 0.02 ? Infinity : s.floor - base;
          };
          // Lateral room before the ground climbs each threshold, both sides.
          const room = (limit) => {
            let a = 0;
            for (let t = 0.05; t <= 12; t += 0.05) {
              if (rise(t) > limit) break;
              a = t;
            }
            let b = 0;
            for (let t = 0.05; t <= 12; t += 0.05) {
              if (rise(-t) > limit) break;
              b = t;
            }
            return a + b;
          };
          const chest = 2 * (mid.wallDist ?? 0);
          const e = (byKind[kind] ??= { n: 0, ankle: [], shin: [], knee: [], chest: [] });
          e.n++;
          e.ankle.push(room(0.2));
          e.shin.push(room(0.45));
          e.knee.push(room(0.9));
          e.chest.push(chest);
        }
      }
      const q = (a, f) => {
        const s = a.slice().sort((x, y) => x - y);
        return s.length ? +s[Math.floor((s.length - 1) * f)].toFixed(2) : 0;
      };
      rows.push({
        k,
        kinds: Object.entries(byKind)
          .map(([kind, e]) => ({
            kind,
            rings: e.n,
            ankleP50: q(e.ankle, 0.5),
            shinP50: q(e.shin, 0.5),
            kneeP50: q(e.knee, 0.5),
            chestP50: q(e.chest, 0.5),
          }))
          .sort((a, b) => b.rings - a.rings),
      });
    }
    return rows;
  });

  console.log(`\n=== ${SEED} ===`);
  console.log(
    '  kind      rings   floor width (m) at ankle / shin / knee   width at chest'
  );
  for (const r of out) {
    console.log(`  cave k=${r.k}`);
    for (const e of r.kinds)
      console.log(
        `    ${e.kind.padEnd(9)} ${String(e.rings).padStart(5)}   ` +
          `${String(e.ankleP50).padStart(6)} ${String(e.shinP50).padStart(6)} ${String(e.kneeP50).padStart(6)}      ` +
          `${String(e.chestP50).padStart(6)}`
      );
  }
  await page.close();
}
await browser.close();
