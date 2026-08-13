import { boot, argv, DEV_URL } from './harness.mjs';

/**
 * What a sector event costs the culler, measured on the frames it happens.
 *
 * The circling walk in `perf:spikes` barely streams — five sector accepts in
 * 2341 frames — so it cannot see this at all. This walks in a straight line
 * fast enough to keep the one-sector-per-frame budget saturated and times
 * `forest.cull` around every frame.
 */
const args = argv({ seconds: '25', speed: '1.2' });
const { browser, page } = await boot({ url: DEV_URL, vsync: true, headed: true });

const out = await page.evaluate(
  async ([seconds, speed]) => {
    const RR = window.RR;
    const orig = RR.forest.cull.bind(RR.forest);
    let cullMs = 0;
    RR.forest.cull = (c, f) => {
      const t = performance.now();
      const r = orig(c, f);
      cullMs += performance.now() - t;
      return r;
    };
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < 60; i++) await frame();

    const rows = [];
    let built = RR.forest.field.built;
    let evicted = RR.forest.field.evicted;
    let last = performance.now();
    const t0 = last;
    while (performance.now() - t0 < seconds * 1000) {
      cullMs = 0;
      RR.controller.position.x += speed;
      RR.controller.position.z += speed * 0.6;
      RR.controller.velocity.set(0, 0, 0);
      await frame();
      const now = performance.now();
      const b = RR.forest.field.built;
      const e = RR.forest.field.evicted;
      rows.push({
        ms: now - last,
        cull: cullMs,
        events: b - built + (e - evicted),
        uploaded: RR.forest.culler.uploaded,
      });
      last = now;
      built = b;
      evicted = e;
    }
    RR.forest.cull = orig;
    return {
      rows,
      travelled: Math.hypot(RR.controller.position.x, RR.controller.position.z),
      growths: RR.forest.growths,
    };
  },
  [Number(args.seconds), Number(args.speed)]
);
await browser.close();

const q = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0;
};
const ev = out.rows.filter((r) => r.events > 0);
const no = out.rows.filter((r) => r.events === 0);
const F = (n) => n.toFixed(2).padStart(7);

console.log(`\nframes ${out.rows.length}, travelled ${out.travelled.toFixed(0)} m`);
console.log(`sector-event frames ${ev.length} (${((ev.length / out.rows.length) * 100).toFixed(1)}%)`);
console.log(`\n                       median      p95      p99     worst`);
for (const [label, set, key] of [
  ['cull, sector event ', ev, 'cull'],
  ['cull, quiet frame  ', no, 'cull'],
  ['frame, sector event', ev, 'ms'],
  ['frame, quiet frame ', no, 'ms'],
]) {
  const a = set.map((r) => r[key]);
  console.log(
    `  ${label} ${F(q(a, 0.5))} ${F(q(a, 0.95))} ${F(q(a, 0.99))} ${F(Math.max(0, ...a))}  ms`
  );
}
const up = ev.map((r) => r.uploaded);
console.log(
  `\ninstances repacked on a sector-event frame: median ${q(up, 0.5)}, p95 ${q(up, 0.95)}, worst ${Math.max(0, ...up)}`
);
console.log(`slab growths: ${JSON.stringify(out.growths)}`);
