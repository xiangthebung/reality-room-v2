import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { triage } from './known-noise.mjs';

/**
 * Photograph the places people meet.
 *
 * The gathering places are not at fixed coordinates — they are chosen by
 * measuring the seeded terrain — so unlike `shoot.mjs` this cannot list camera
 * stations. It asks the running page where everything ended up and frames each
 * one from the answer, which means it works on any seed and is also the only
 * check that the site chooser produced somewhere you would actually want to
 * stand.
 *
 *   node scripts/social-shots.mjs [--url=…] [--out=.shots/social] [--seed=…]
 *
 * It also reports the frame's draw calls and triangle count with the new props
 * in view, because "a screen and four fires" is exactly the kind of addition
 * that quietly doubles a draw count. That number is taken with `info.autoReset`
 * off around one hand-driven frame — see the note where it is measured, and be
 * suspicious of any version of this script that just reads `renderer.info`.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const SEED = args.seed ?? 'grove-01';
const URL = `${args.url ?? 'http://127.0.0.1:5180/'}?seed=${encodeURIComponent(SEED)}`;
const OUT = resolve(process.cwd(), args.out ?? '.shots/social');
const SETTLE = Number(args.wait ?? 1200);

mkdirSync(OUT, { recursive: true });

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
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });

const problems = [];
page.on('console', (msg) => {
  const type = msg.type();
  if (type === 'error' || type === 'warning') problems.push(`[${type}] ${msg.text()}`);
});
page.on('pageerror', (err) => problems.push(`[pageerror] ${err.message}\n${err.stack ?? ''}`));

// See the block comment in shoot.mjs: an HMR reload mid-run is silent and total.
await page.routeWebSocket(/.*/, () => {});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForSelector('#gate.gone', { timeout: 25000 }).catch(() => {});
await page.waitForTimeout(2600);
await page.evaluate(() => {
  document.getElementById('toast').style.display = 'none';
  document.getElementById('help').style.display = 'none';
});

/**
 * Ask the page where its own furniture is.
 *
 * Every station below is derived from this, so a seed whose commons landed in a
 * different quarter of the world is photographed correctly with no edit here.
 */
const places = await page.evaluate(() => {
  const { gathering, ferry } = window.RR;
  const s = gathering.sites;
  return {
    commons: { x: s.commons.x, y: s.commons.y, z: s.commons.z },
    hearths: s.hearths.map((h) => ({ x: h.x, y: h.y, z: h.z })),
    viewpoints: s.viewpoints.map((h) => ({ x: h.x, y: h.y, z: h.z })),
    jetties: s.jetties.map((j) => ({ x: j.x, y: j.y, z: j.z, yaw: j.yaw })),
    ferry: ferry ? { u0: ferry.reach.u0, u1: ferry.reach.u1, period: ferry.schedule.period } : null,
  };
});

/**
 * Stand `back` metres from a point along a bearing, and look at it.
 *
 * `bearing` is the direction FROM the target TO the camera, so the camera is at
 * `target + (sin b, cos b)·back` and the yaw that looks back at the target is
 * exactly `b`: `Controller.forward` is `(-sin yaw, -cos yaw)`, which is the
 * negation of the offset, which is what pointing back at something means. The
 * first run of this script used `b + π` and produced seven photographs of
 * undisturbed forest.
 */
function facing(target, back, bearing, pitch = 0) {
  return {
    x: target.x + Math.sin(bearing) * back,
    z: target.z + Math.cos(bearing) * back,
    // Set explicitly rather than left to the floor clamp: teleporting the body
    // 35 m below a hilltop and waiting for gravity to sort it out photographs
    // the inside of a grass blade.
    y: (target.y ?? 0) + 1.8,
    yaw: bearing,
    pitch,
  };
}

/** Which way the commons is from the origin. */
const commonsBearing = Math.atan2(places.commons.x, places.commons.z);
/**
 * THE SCREEN THIS SCRIPT PUTS UP FACES THE ORIGIN, so the audience stands
 * between the origin and the commons — the opposite side from every other
 * station here. The two have to agree: this bearing and the `yaw` handed to
 * `share.place` further down are the same decision written twice.
 *
 * Getting it wrong used to cost three consecutive runs of photographs of a
 * plank rectangle with no picture on it, because a screen had a back and the
 * back had almost exactly the same silhouette as the front. It no longer does —
 * both faces show the picture (see video-surface.js) — so the failure mode this
 * warning is about is now a subtler one: the same shot, correctly exposed, with
 * the timber and the legs in front of the picture instead of behind it, and the
 * light the screen throws falling away from the camera rather than towards it.
 */
const audience = commonsBearing + Math.PI;

const SHOTS = [
  { name: '01-commons-approach', at: facing(places.commons, 34, audience, 0.04), note: 'walking into the commons' },
  { name: '02-commons-seats', at: facing(places.commons, 15, audience + 0.5, 0.02), note: 'the ring round the big fire' },
  { name: '03-commons-close', at: facing(places.commons, 9, audience, -0.06), note: 'in the commons' },
  { name: '04-hearth', at: facing(places.hearths[0] ?? places.commons, 4.4, 0.9, -0.12), note: 'a fire' },
  { name: '05-hearth-wide', at: facing(places.hearths[0] ?? places.commons, 12, 2.4, 0.0), note: 'a fire, from the trees' },
  // The jetty runs out over the water along `forward(yaw)`, so standing at
  // `+(sin, cos)` from it is standing on the bank looking down the planks.
  { name: '06-jetty', at: facing(places.jetties[0] ?? places.commons, 7, (places.jetties[0]?.yaw ?? 0), -0.08), note: 'a landing' },
  { name: '07-view', at: facing(places.viewpoints[0] ?? places.commons, 5, 0.7, 0.0), note: 'a bench with a view' },
];

for (const shot of SHOTS) {
  await page.evaluate((station) => {
    const { controller } = window.RR;
    controller.position.x = station.x;
    controller.position.y = station.y;
    controller.position.z = station.z;
    controller.velocity.set(0, 0, 0);
    controller.yaw = station.yaw;
    controller.pitch = station.pitch;
  }, shot.at);
  await page.waitForTimeout(SETTLE);
  await page.screenshot({ path: `${OUT}/${shot.name}.png` });
  process.stdout.write(`${shot.name}  ${shot.note}\n`);
}

/**
 * Night, at the same fire.
 *
 * The whole point of a campfire is what it looks like when it is dark, and the
 * day cycle is 1200 s of wall clock — so this pins the phase rather than waiting
 * ten minutes for it.
 */
await page.evaluate(() => window.RR.atmosphere.day.set(0.02));
for (const shot of [
  { name: '08-hearth-night', at: facing(places.hearths[0] ?? places.commons, 4.4, 0.9, -0.12) },
  { name: '09-commons-night', at: facing(places.commons, 22, audience, 0.04) },
]) {
  await page.evaluate((station) => {
    const { controller } = window.RR;
    controller.position.x = station.x;
    controller.position.y = station.y;
    controller.position.z = station.z;
    controller.yaw = station.yaw;
    controller.pitch = station.pitch;
  }, shot.at);
  await page.waitForTimeout(SETTLE);
  await page.screenshot({ path: `${OUT}/${shot.name}.png` });
  process.stdout.write(`${shot.name}  after dark\n`);
}
await page.evaluate(() => window.RR.atmosphere.day.set(null));

/**
 * The ferry, wherever it happens to be — its position is a pure function of the
 * wall clock, so the script cannot choose. It asks, walks to the bank beside it,
 * and looks.
 */
if (places.ferry) {
  const boat = await page.evaluate(() => {
    const { ferry, controller } = window.RR;
    const p = ferry.group.position;
    controller.position.x = p.x + 9;
    controller.position.z = p.z + 9;
    controller.yaw = Math.atan2(-(-9), -(-9));
    controller.pitch = -0.04;
    return { x: p.x, y: p.y, z: p.z, moving: ferry.state.moving };
  });
  await page.waitForTimeout(SETTLE);
  await page.screenshot({ path: `${OUT}/10-ferry.png` });
  process.stdout.write(`10-ferry  at ${boat.x.toFixed(0)}, ${boat.z.toFixed(0)}\n`);
}

/**
 * Something actually on a screen.
 *
 * A test pattern rather than a film, because the point of the picture is to
 * prove the whole path — capture, transceiver, `<video>`, texture, letterbox,
 * bloom — puts pixels on a quad in a forest. It goes through `Share.adopt`, the
 * same seam `getDisplayMedia` funnels into, standing the screen in the commons
 * with no network at all: where your own screen is, is a local decision, and the
 * announcement to the room is what would have gone out if there were one.
 *
 * TWELVE METRES, WHICH IS THE PICTURE THIS SCRIPT USED TO PHOTOGRAPH BY DEFAULT.
 * The commons had a fixed 13.4 m screen in it; there is no fixture any more, so
 * the shot has to ask for one, and asking for roughly the old size keeps these
 * two frames comparable with every previous run of this script.
 */
await page.evaluate(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  const draw = () => {
    const t = performance.now() / 1000;
    const g = ctx.createLinearGradient(0, 0, 1280, 720);
    g.addColorStop(0, '#12233a');
    g.addColorStop(1, '#3a1220');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1280, 720);
    // Colour bars, so the letterboxing and the colour space are both legible.
    const bars = ['#c8c8c8', '#c8c800', '#00c8c8', '#00c800', '#c800c8', '#c80000', '#0000c8'];
    bars.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(80 + i * 160, 90, 150, 260);
    });
    ctx.fillStyle = '#f2ece0';
    ctx.font = '600 74px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('reality room', 80, 500);
    ctx.font = '400 40px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(242,236,224,0.7)';
    ctx.fillText(`something is on tonight  ·  ${t.toFixed(1)}s`, 80, 570);
    requestAnimationFrame(draw);
  };
  draw();
  const { net, gathering } = window.RR;
  const site = gathering.sites.commons;
  /**
   * The spot is handed to `adopt` rather than left to the aim, because this
   * script teleports its camera between stations and there is no moment at which
   * it is "looking at" the commons — `where()` would answer about wherever the
   * last shot was framed from. `yaw` faces the origin, which is where the
   * audience stations below stand: see `audience`, and the note in
   * video-surface.js about a PlaneGeometry facing `(sin yaw, cos yaw)`.
   *
   * OFFSET ONTO THE FAR EDGE OF THE OUTER RING RATHER THAN THE MIDDLE OF THE
   * CLEARING, because the middle of the clearing is where the fire is and the
   * first run of this stood a twelve-metre screen directly on top of it. Nine
   * metres beyond the fire, on the side away from the camera, is where a person
   * would actually put one — everybody sits between the two — and it happens to
   * be the drive-in composition the old fixed screen was photographed in.
   *
   * `site.y` for all of it rather than a per-point ground sample: the commons is
   * the flattest ground within a hundred metres by construction, so nine metres
   * out is a few centimetres, and the legs sample their own ground anyway.
   *
   * TWELVE METRES ASKED FOR UP FRONT. `w` in the placement is the width, so
   * there is no resize-then-reannounce dance and no frame at the default 4.2 m
   * for the crossfade to start against.
   */
  const yaw = Math.atan2(-site.x, -site.z);
  net.share.adopt(canvas.captureStream(30), 'screen', 'test-pattern', {
    x: site.x - Math.sin(yaw) * 9,
    y: site.y,
    z: site.z - Math.cos(yaw) * 9,
    yaw,
    w: 12,
  });
});
// The element has to buffer a frame and the crossfade takes a moment.
await page.waitForTimeout(2600);

for (const shot of [
  { name: '11-showing-day', at: facing(places.commons, 21, audience, 0.05), night: false },
  { name: '12-showing-night', at: facing(places.commons, 21, audience, 0.05), night: true },
]) {
  await page.evaluate((night) => window.RR.atmosphere.day.set(night ? 0.02 : 0.5), shot.night);
  await page.evaluate((station) => {
    const { controller } = window.RR;
    controller.position.x = station.x;
    controller.position.y = station.y;
    controller.position.z = station.z;
    controller.yaw = station.yaw;
    controller.pitch = station.pitch;
  }, shot.at);
  await page.waitForTimeout(SETTLE);
  await page.screenshot({ path: `${OUT}/${shot.name}.png` });
  process.stdout.write(`${shot.name}  a screen standing in the commons\n`);
}
await page.evaluate(() => {
  window.RR.atmosphere.day.set(null);
  window.RR.net.share.stop();
});

/**
 * Cost, measured with the busiest thing in the world filling the frame.
 *
 * `perf-audit-2026-08` is explicit that absolute GPU numbers taken from a hidden
 * browser pane are worthless, so this reports DRAW CALLS and TRIANGLES, which
 * are exact counts rather than timings and are the numbers that would show a
 * regression from adding props.
 */
await page.evaluate((station) => {
  const { controller } = window.RR;
  controller.position.x = station.x;
  controller.position.z = station.z;
  controller.yaw = station.yaw;
  controller.pitch = station.pitch;
}, facing(places.commons, 20, audience, 0.03));
await page.waitForTimeout(SETTLE);

const stats = await page.evaluate(() => {
  const { renderer, pipeline, seats, gathering, ferry, forest } = window.RR;
  /**
   * `autoReset = false` AROUND ONE DELIBERATE FRAME, and without it these
   * numbers were fiction.
   *
   * `renderer.info` resets itself at the top of every `renderer.render()`, and
   * `pipeline.render()` makes several of those — the world, a bright pass, a
   * bloom chain, a glow accumulator, the output pass. Reading `info.render`
   * after a frame therefore reports whichever pass ran LAST, which is the
   * fullscreen output quad: this printed `calls: 1, triangles: 2` no matter what
   * was in shot, and printed it in a section whose stated purpose is catching
   * "a fourteen-metre screen and four fires quietly doubling the draw count".
   *
   * Turning the reset off and driving one frame by hand is the same thing
   * `src/dev/perf/probe.js` does for its regression gate, for the same reason
   * and with the same caveat: this is a count across every pass in a frame, not
   * across the scene pass alone.
   */
  const info = renderer.info;
  info.autoReset = false;
  info.reset();
  pipeline.render(1 / 60);
  const out = {
    calls: info.render.calls,
    triangles: info.render.triangles,
    programs: info.programs?.length ?? 0,
    seats: seats.seats.length,
    fires: gathering.fires.length,
    ferryPeriodS: ferry ? Math.round(ferry.schedule.period) : null,
    trees: forest.treeCount,
  };
  info.autoReset = true;
  return out;
});

const { problems: real, suppressed } = triage(problems);
writeFileSync(
  `${OUT}/report.json`,
  JSON.stringify({ seed: SEED, places, stats, problems: real, suppressed }, null, 2)
);
console.log('\nstats:', stats);
if (real.length) {
  console.log(`\n${real.length} console problem(s):`);
  for (const p of real.slice(0, 40)) console.log(' ', p);
} else {
  console.log('\nno console problems');
}
if (suppressed) console.log(`(${suppressed} known-noise line(s) suppressed)`);

await browser.close();
