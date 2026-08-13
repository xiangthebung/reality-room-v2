import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * CAN YOU PUT A SCREEN AND A SPEAKER DOWN UNDER A MOUNTAIN?
 *
 * All four placement gestures used to refuse underground and the refusals were
 * correct: `aimGround` marched against `heightAt`, which inside a hillside is
 * the SUMMIT and is already behind you before the first sample, so the object
 * went onto the mountainside thirty metres overhead — in daylight, audible and
 * unreachable. The march is cave-aware now. This is the gate that stops it
 * quietly going back, and it pins four things, each of which broke independently
 * while the fix was being written:
 *
 *   THE MARCH ITSELF. The placement's `y` must be the passage floor at its own
 *   xz, and the surface must be far above it. Both halves matter: "it is not on
 *   the summit" passes for an object at the bottom of the sea, and "it is on the
 *   cave floor" is only interesting if there is a mountain over it to have got
 *   it wrong with.
 *
 *   THE LEGS. `video-surface.js` samples the ground UNDER EACH LEG, separately
 *   from the placement, so a screen can stand in a passage with its two feet
 *   reaching for the hillside — the placement is right and the object is still
 *   broken. The leg bottoms are computed from the live transforms here rather
 *   than trusted.
 *
 *   THE ROOF. A share screen at its default width stands 3.12 m tall and at
 *   sixteen metres it stands nine. `aimGround` reports the clear height and the
 *   callers refuse rather than burying the picture in the ceiling, so this asks
 *   for the biggest screen the app allows and requires a refusal.
 *
 *   THE REACH. `findInteractable` used to return null outright whenever there
 *   was rock overhead, which made the cabinet you had just stood two metres away
 *   un-interactable. That guard is now a per-candidate vertical gap, so the HUD
 *   has to offer the jukebox to somebody standing next to a speaker on a cave
 *   floor. `cave-seal.mjs` owns the other half of that change — that the
 *   mushroom in the sunlight overhead is still out of reach — and both have to
 *   pass or the reach test is either useless or has broken the seal.
 *
 * IT PRESSES THE REAL KEYS. `KeyG` and `KeyP` are dispatched on `window`, so
 * they go through `worldHearsKey`, `placeSpeaker` and `toggleShare` exactly as a
 * player's do. `getDisplayMedia` cannot be answered by a headless browser — no
 * picker, no screen — so it is replaced before the app loads by one that hands
 * back a canvas's `captureStream()`. That is the ONLY stub: everything from the
 * key down to the transform on the quad is the shipping path, and it is the same
 * seam `server/test/two-social.mjs` uses for the same reason.
 *
 * EVERY MEASUREMENT IS TAKEN INSIDE ONE `evaluate`, stepping the frame loop by
 * hand with `requestAnimationFrame`. The game loop runs between evaluates, so a
 * script that teleports in one call and reads in the next is reading a world
 * that has had a hundred milliseconds of physics, streaming and settling applied
 * to it since the thing it is asking about.
 *
 *   node scripts/cave-present.mjs [--seed=grove-01]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const SEED = args.seed ?? 'grove-01';
const URL = args.url ?? `http://127.0.0.1:5180/?seed=${SEED}`;
const OUT = resolve(process.cwd(), args.out ?? '.shots/cave-present');

/**
 * How far from a floor a thing may be and still count as standing on it.
 *
 * Five centimetres. This is not a tolerance for the arithmetic — the placement
 * and the check call the same function — it is there because the two ask at
 * slightly different xz: the object is at the middle and a leg is most of a
 * metre to the side. The failure this guards against is not a few centimetres,
 * it is thirty metres, so the number only has to be small enough to be a claim.
 */
const ON_THE_FLOOR_M = 0.05;

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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(m.text());
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
await page.routeWebSocket(/.*/, () => {});

/**
 * The one stub, installed before any of the app's own script runs.
 *
 * A test pattern rather than a blank canvas, and animated, because the frame is
 * a photograph as well as an assertion: a black rectangle in a dark cave proves
 * nothing to a person looking at the shot, and a still one would not prove the
 * video path is running at all.
 */
await page.addInitScript(() => {
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
    const bars = ['#c8c8c8', '#c8c800', '#00c8c8', '#00c800', '#c800c8', '#c80000', '#0000c8'];
    bars.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(80 + i * 160, 90, 150, 260);
    });
    ctx.fillStyle = '#f2ece0';
    ctx.font = '600 74px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('underground', 80, 500);
    ctx.font = '400 40px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(242,236,224,0.7)';
    ctx.fillText(`presenting from a cave · ${t.toFixed(1)}s`, 80, 570);
    requestAnimationFrame(draw);
  };
  draw();
  navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(30);
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForSelector('#gate.gone', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2500);

/**
 * Somewhere deep AND tall enough, found rather than typed.
 *
 * A cave does not exist until it has been streamed and built, so a literal
 * coordinate would measure a hillside on the first run after any change to the
 * ring budget — the same evaluate, and the same reasoning, as `cave-seal.mjs`.
 * The extra term here is the ceiling: this script requires a screen to go up,
 * a screen is over three metres tall, and picking the WIDEST ring — which is
 * what the seal does — would sooner or later pick a bedding plane that is eleven
 * metres across and two high, where the correct behaviour is the refusal and the
 * script would read it as the bug.
 */
const spot = await page.evaluate(async () => {
  const R = window.RR;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const mod = await import('/src/world/terrain.js');
  const near = mod.cavesNear(0, 0, 900);
  if (!near.length) return null;
  const c0 = near[0];
  R.controller.keys.clear();
  R.controller.fly = true;
  R.controller.position.set(c0.x, 60, c0.z);
  R.controller.velocity.set(0, 0, 0);
  /**
   * WAITED FOR RATHER THAN COUNTED OUT.
   *
   * The sibling scripts spend a fixed four hundred frames here, which is
   * comfortably enough on a warm machine and is not enough on a cold one or on
   * one where a module has just been hot-replaced and every cave in range is
   * rebuilding — and the failure it produces is "no built passage within 900 m",
   * which reads as a claim about the world rather than as a claim about the
   * clock. Both of the first two runs of this script on a busy machine failed
   * that way. The budget is generous because it costs nothing to be: the loop
   * exits the frame the answer arrives.
   */
  let cave = null;
  for (let i = 0; i < 1500; i++) {
    cave = R.caves.caves.get(c0.k);
    if (cave?.ready) break;
    await raf();
  }
  if (!cave?.ready) return null;
  const p = cave.path;
  /**
   * TWO RINGS, BECAUSE THE SCRIPT ASKS TWO OPPOSITE QUESTIONS.
   *
   * The roomiest section past 40 m is where the screen has to go UP — the same
   * choice `cave-seal.mjs` makes, and for its reason as well as ours: it is open
   * enough that the body is not wedged against a wall while it settles.
   *
   * The narrowest is where the screen has to be REFUSED. A section's height
   * scales with its radius (see `ceiling` in caves.js), so the thinnest ring in
   * the passage is the surest place in the world to find a roof, and `caveSample`
   * guarantees 2.15 m of head under any of them — which is why the same spot can
   * still take a small screen and is asked to.
   */
  /**
   * FORTY METRES FROM BOTH ENDS, not just from the one you came in by.
   *
   * `cave-seal.mjs` only has to be somewhere deep and takes the first condition.
   * This script needs somewhere with a ROOF over the spot the ray lands on,
   * which is several metres in front of the body — and near the far mouth the
   * body is still `roofed` while the aim is already out in the daylight. The
   * placement there is correct and the measurement is meaningless, which is the
   * worst combination a check script can have: it reported the shape of one end
   * of the passage as a pass.
   */
  const total = p.along[p.along.length - 1];
  let wide = -1;
  let narrow = -1;
  for (let i = 10; i < p.x.length - 10; i++) {
    if (p.along[i] < 40 || total - p.along[i] < 40) continue;
    if (wide < 0 || p.r[i] > p.r[wide]) wide = i;
    // 1.2 m of radius is the floor on this one: below that the body is wedged
    // and what gets measured is the wall push rather than the roof.
    if (p.r[i] >= 1.2 && (narrow < 0 || p.r[i] < p.r[narrow])) narrow = i;
  }
  if (wide < 0 || narrow < 0) return null;
  const at = (i) => ({ along: p.along[i], x: p.x[i], y: p.y[i] + 0.5, z: p.z[i], r: p.r[i] });
  return { k: c0.k, wide: at(wide), narrow: at(narrow) };
});

if (!spot) {
  console.log(`no built passage within 900 m on ${SEED} — nothing to stand in`);
  await browser.close();
  process.exit(1);
}
console.log(
  `passage k=${spot.k}\n` +
    `  roomy   ${spot.wide.along.toFixed(0)} m in, r ${spot.wide.r.toFixed(1)} m,` +
    ` at (${spot.wide.x.toFixed(1)}, ${spot.wide.z.toFixed(1)})\n` +
    `  narrow  ${spot.narrow.along.toFixed(0)} m in, r ${spot.narrow.r.toFixed(1)} m,` +
    ` at (${spot.narrow.x.toFixed(1)}, ${spot.narrow.z.toFixed(1)})\n`
);

const out = await page.evaluate(async (s) => {
  const R = window.RR;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const settle = async (n) => {
    for (let i = 0; i < n; i++) await raf();
  };
  const terrain = await import('/src/world/terrain.js');
  const aim = await import('/src/world/aim.js');
  const promptEl = document.getElementById('prompt');
  const readPrompt = () => (promptEl.hidden ? null : promptEl.textContent.trim());
  const press = (code) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));

  /**
   * Fly to a point, then fall the last half metre onto whatever floor is there.
   * Flying publishes the cave state but pushes the body nowhere, so the landing
   * is what proves the body is really standing in the passage — and `roofed`,
   * which every gesture below branches on, is written by that landing.
   */
  const standAt = async (x, y, z, yaw = 0, pitch = -0.12) => {
    R.controller.keys.clear();
    R.controller.fly = true;
    R.controller.position.set(x, y, z);
    R.controller.velocity.set(0, 0, 0);
    R.controller.yaw = yaw;
    R.controller.pitch = pitch;
    await settle(30);
    R.controller.fly = false;
    await settle(90);
  };

  /** Both halves of "it is standing on the cave floor and not on the hill". */
  const floorReport = (x, y, z) => ({
    offFloor: Number((y - aim.standingFloor(x, z, y + aim.STAND_PROBE_M)).toFixed(3)),
    rockOverhead: Number((terrain.groundUnder(x, z) - y).toFixed(1)),
  });

  const result = {};

  // ---- a speaker, on the passage floor -------------------------------------
  await standAt(s.wide.x, s.wide.y, s.wide.z);
  result.body = {
    roofed: R.controller.roofed,
    depth: Math.round(R.controller.caveDepth),
    caveFloor: Number(R.controller.caveFloor.toFixed(2)),
    headroom: Number(aim.aimGround(R.controller).headroom.toFixed(2)),
  };

  // Which cabinet `G` is about to move, asked before pressing: the pair
  // alternates, and reading the other one would report a box nobody touched.
  const moving = R.speakers.next;
  press('KeyG');
  await settle(6);
  const cab = R.speakers.cabinets[moving].spot();
  result.speaker = {
    ...floorReport(cab.x, cab.y, cab.z),
    fromBody: Number(Math.hypot(cab.x - R.controller.position.x, cab.z - R.controller.position.z).toFixed(1)),
  };

  /**
   * …and the cabinet you just put down is a thing you can use.
   *
   * Stood beside it rather than teleported on top of it, and the prompt is read
   * from the HUD rather than from any internal — `findInteractable` is not
   * exported, and what a player gets told is the thing that was broken.
   */
  await standAt(cab.x + 1.4, cab.y + 2.2, cab.z, 0, 0);
  result.speaker.roofedHere = R.controller.roofed;
  result.speaker.prompt = readPrompt();

  // ---- a screen, through the picker ----------------------------------------
  await standAt(s.wide.x, s.wide.y, s.wide.z);
  press('KeyP');
  // `toggleShare` is async: a picker, an adopt, a publish and a placement.
  await settle(60);
  const share = R.net.share.placement;
  result.screen = share
    ? { w: Number(share.w.toFixed(1)), ...floorReport(share.x, share.y, share.z) }
    : null;

  /**
   * THE LEGS, computed from the live transforms rather than from the placement.
   *
   * The group sits at `y + base + h/2` and each leg is a unit box scaled to
   * `drop` and hung below the picture, so the bottom of one is the group's
   * height less half the picture less the whole leg. If the legs were still
   * sampling the height field, `drop` would have collapsed to its 12 cm minimum
   * and these would be most of a metre in the air above a floor they never
   * reached.
   */
  const screen = R.net.screenFor('');
  if (screen && share) {
    const h = share.w * (9 / 16);
    const v = new R.THREE.Vector3();
    result.legs = screen.legs.map((leg) => {
      leg.getWorldPosition(v);
      const bottom = screen.group.position.y - h / 2 - leg.scale.y;
      return {
        gap: Number((bottom - aim.standingFloor(v.x, v.z, bottom + aim.STAND_PROBE_M)).toFixed(3)),
        visible: leg.visible,
      };
    });
  }

  // ---- and the roof says no to a nine-metre picture -------------------------
  /**
   * WALK SOMEWHERE ELSE FIRST, which is not scene-setting — it is what makes the
   * refusal falsifiable.
   *
   * `O` stands the screen where you are looking, so pressing it without moving
   * puts it back exactly where it already is and "did it move" answers no
   * whatever the code does. The narrow ring is a few hundred metres away, so a
   * placement that went through is unmissable and a refusal leaves the picture
   * standing in the chamber it is already in.
   */
  await standAt(s.narrow.x, s.narrow.y, s.narrow.z);
  /**
   * Grown to the app's own maximum through `resize`, which clamps — so this is
   * the largest screen a player can ask for rather than a number invented here,
   * and if that cap ever moves this moves with it.
   */
  R.net.share.resize(1000);
  await settle(4);
  const before = R.net.share.placement;
  press('KeyO');
  await settle(10);
  const after = R.net.share.placement;
  result.tooTall = {
    w: Number(R.net.share.width.toFixed(1)),
    headroom: Number(aim.aimGround(R.controller).headroom.toFixed(2)),
    roofedHere: R.controller.roofed,
    moved: Math.hypot(after.x - before.x, after.z - before.z) > 0.05,
  };

  /**
   * …AND THE SAME SPOT TAKES A SMALL ONE, which is the control. Without it a
   * gate that refused everything underground would pass the paragraph above,
   * which is precisely the behaviour this whole change exists to delete.
   */
  R.net.share.resize(0.001);
  await settle(4);
  press('KeyO');
  await settle(10);
  const small = R.net.share.placement;
  result.small = {
    w: Number(small.w.toFixed(1)),
    ...floorReport(small.x, small.y, small.z),
    moved: Math.hypot(small.x - before.x, small.z - before.z) > 0.05,
  };

  // Back up to something worth photographing, in the room that can take it.
  await standAt(s.wide.x, s.wide.y, s.wide.z);
  R.net.share.resize(4.2 / R.net.share.width);
  await settle(4);
  press('KeyO');
  await settle(10);
  const shot = R.net.share.placement;
  result.shot = { w: Number(shot.w.toFixed(1)), x: shot.x, y: shot.y, z: shot.z, yaw: shot.yaw };
  return result;
}, spot);

console.log(JSON.stringify(out, null, 2));

/**
 * Stand where the screen can be seen.
 *
 * THE CAMERA'S YAW IS THE SCREEN'S OWN YAW, which reads like a bug twice over —
 * surely you turn to face a thing — and is the theorem `aimGround` proves in its
 * return comment. A screen faces the person who put it up, so it carries their
 * yaw; standing anywhere along that same forward line and looking down it is
 * therefore looking at the front of the picture. Adding π, which is the obvious
 * thing to write, photographs the wall behind the photographer: the first run of
 * this shot came back as an empty chamber with a faint glow a hundred metres off
 * that turned out to be the screen, seen edge-on over the camera's shoulder.
 *
 * Backed off along that line rather than orbited, because the body that placed
 * it is the one position from which the frame is guaranteed unobstructed — the
 * march put it there precisely because nothing was in the way.
 */
await page.evaluate(async (shot) => {
  const R = window.RR;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const back = Math.max(7, shot.w * 1.7);
  R.controller.keys.clear();
  R.controller.fly = true;
  R.controller.position.set(
    shot.x + Math.sin(shot.yaw) * back,
    shot.y + 2.2,
    shot.z + Math.cos(shot.yaw) * back
  );
  R.controller.velocity.set(0, 0, 0);
  R.controller.yaw = shot.yaw;
  R.controller.pitch = -0.05;
  for (let i = 0; i < 120; i++) await raf();
}, out.shot);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/01-screen-in-a-cave.png` });
console.log(`\n01-screen-in-a-cave.png  a ${out.shot.w} m screen standing underground`);

const fails = [];
if (!out.body.roofed) fails.push('the body never got under any rock — nothing below was tested');
if (Math.abs(out.speaker.offFloor) > ON_THE_FLOOR_M) {
  fails.push(`speaker is ${out.speaker.offFloor} m off the passage floor`);
}
if (!(out.speaker.rockOverhead > 2.4)) {
  fails.push(`speaker has only ${out.speaker.rockOverhead} m of rock over it — it is on the surface`);
}
if (!out.speaker.roofedHere) fails.push('standing at the speaker is not underground');
if (!out.speaker.prompt) {
  fails.push('no prompt at a speaker on a cave floor — the reach test is still a blanket guard');
}
if (!out.screen) fails.push('no screen went up at all');
else {
  if (Math.abs(out.screen.offFloor) > ON_THE_FLOOR_M) {
    fails.push(`screen is ${out.screen.offFloor} m off the passage floor`);
  }
  if (!(out.screen.rockOverhead > 2.4)) {
    fails.push(`screen has only ${out.screen.rockOverhead} m of rock over it — it is on the surface`);
  }
}
if (!out.legs || out.legs.length !== 2) fails.push('the screen grew no legs');
else {
  for (const leg of out.legs) {
    if (!leg.visible) fails.push('a leg is hidden');
    if (Math.abs(leg.gap) > ON_THE_FLOOR_M) fails.push(`a leg ends ${leg.gap} m off the floor`);
  }
}
/**
 * The refusal is only asserted where a refusal is actually correct. On a seed
 * whose narrowest ring past 40 m still has nine metres of air over it there is
 * nothing to refuse, and a script that failed there would be reporting the
 * shape of the cave rather than the state of the code — so it says so and moves
 * on. `check:present` is a gate on the placement, not on the geology.
 */
const TALLEST = 2.4 + 16 * (9 / 16);
if (!out.tooTall.roofedHere) fails.push('the narrow ring is not underground — the roof test is void');
else if (out.tooTall.headroom >= TALLEST) {
  console.log(
    `note: the narrowest ring has ${out.tooTall.headroom} m of headroom, which fits a ` +
      `${TALLEST.toFixed(1)} m screen — the refusal is untested on this seed`
  );
} else if (out.tooTall.moved) {
  fails.push(`a ${out.tooTall.w} m screen was placed under ${out.tooTall.headroom} m of headroom`);
}
if (!out.small.moved) fails.push(`a ${out.small.w} m screen was refused as well — the gate is a blanket`);
else if (Math.abs(out.small.offFloor) > ON_THE_FLOOR_M) {
  fails.push(`the small screen is ${out.small.offFloor} m off the passage floor`);
} else if (!(out.small.rockOverhead > 2.4)) {
  /**
   * The narrow ring's own version of the summit test, and it is the one that
   * found the last bug. A body wedged in a 2.3 m passage is looking at a wall
   * closer than the march's own near bound, which is the one case where nothing
   * along the ray was ever proved to be inside the rock — and the placement
   * went out onto the hillside fifty metres up while every other number in this
   * report stayed green.
   */
  fails.push(`the small screen has ${out.small.rockOverhead} m of rock over it — it went outside`);
}

console.log('');
if (problems.length) console.log(`page errors:\n  ${problems.join('\n  ')}\n`);
console.log(fails.length ? `FAIL\n  ${fails.join('\n  ')}` : 'PASS');
await browser.close();
process.exit(fails.length || problems.length ? 1 : 0);
