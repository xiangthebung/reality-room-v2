import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/**
 * Two people in one clearing, doing the things people came here to do.
 *
 * `two-player.mjs` proves the transport: that two pages find each other, that
 * one walking moves the other's copy, that a real Opus stream forms. This proves
 * the ROOM — chat, a shared screen, a pose that survives the wire, and a ferry
 * that two machines agree about without being told.
 *
 * It drives the app's own multiplayer rather than attaching a second instance,
 * because the things being tested here are wired in `main.js` — the seat
 * registry, the chat log, the daylight the screens are painted by — and a bare
 * `attachMultiplayer` would be testing a different program.
 *
 * THE KEYS ARE PRESSED RATHER THAN THE FUNCTIONS CALLED. Moving and resizing a
 * screen both go through dispatched `keydown` and `wheel` events, because the
 * interesting code is in the handlers — the terrain march that finds the ground,
 * the `deltaMode` normalisation, the clamp, the trailing announce — and none of
 * it is reachable from the module's public surface. A test that called
 * `share.place` with a spot it computed itself would prove that `place` can
 * store five numbers.
 *
 * THE SCREEN SHARE IS A REAL VIDEO TRACK. `getDisplayMedia` cannot be answered
 * by a headless browser, so the stream comes from a canvas's `captureStream()`
 * and is handed to `Share.adopt` — the same seam `startScreen` uses. Everything
 * after that point is the shipping path: a real transceiver, a real Opus/VP8
 * negotiation, a real `<video>` element and a real texture upload.
 *
 *   node server/test/two-social.mjs
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

/**
 * Overridable, because 5180 is not always this project's.
 *
 * The dev server is not spawned by this file — it has to already be up, so that
 * a run does not pay Vite's cold start and so HMR keeps working while you edit
 * between runs. That makes the port an assumption about the machine rather than
 * about the code, and the failure when the assumption is wrong is very bad: a
 * stranger's Vite on 5180 serves this project's files perfectly well while
 * proxying `/ws` somewhere else entirely, so both pages come up, both build the
 * world, both report the room in their URL, and neither ever sees the other.
 * That reads exactly like broken netcode.
 *
 *   DEV_URL=http://127.0.0.1:5184 node server/test/two-social.mjs
 */
const DEV_URL = process.env.DEV_URL || 'http://127.0.0.1:5180';
/** `SIGNALLING_PORT`, matching server/index.js and vite.config.js. See the note there. */
const SERVER_PORT = Number(process.env.SIGNALLING_PORT) || Number(process.env.PORT) || 5181;
/**
 * A VALID invite code, and the constraint is not decorative.
 *
 * `server/rooms.js` mints codes from an alphabet with no `i`, `l`, `o`, `0` or
 * `1` in it, because a code's job is to survive being read out over a voice call
 * — and it REJECTS anything else, with a `denied` and a policy close. The first
 * version of this file used `mno-pqr-stu`, whose `o` is not in the alphabet, and
 * spent a while looking like a broken transport when it was a working one
 * correctly turning us away.
 */
const ROOM = 'mnp-qrs-tuv';
const SEED = 'grove-01';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

async function healthy() {
  try {
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/healthz`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`  (timed out waiting for ${label})`);
  return false;
}

// --------------------------------------------------------------------- server

let server = null;
if (await healthy()) {
  console.log(`signalling server already up on ${SERVER_PORT}`);
} else {
  server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root,
    env: { ...process.env, SIGNALLING_PORT: String(SERVER_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`  [net] ${d}`));
  server.stderr.on('data', (d) => process.stdout.write(`  [net!] ${d}`));
  if (!(await waitFor(healthy, 10_000, 'the signalling server'))) {
    console.error('signalling server never came up');
    server.kill();
    process.exit(1);
  }
}

if (!(await fetch(`${DEV_URL}/`).then((r) => r.ok).catch(() => false))) {
  console.error(`the Vite dev server is not running at ${DEV_URL} — start it with npm run dev`);
  server?.kill();
  process.exit(1);
}

// -------------------------------------------------------------------- browser

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
});
const context = await browser.newContext({
  viewport: { width: 820, height: 500 },
  permissions: ['microphone'],
});

const errors = [];

async function cleanup() {
  try {
    await browser.close();
  } catch {
    /* already gone */
  }
  server?.kill();
}

/** See the note in two-player.mjs: Vite will reload the page out from under us. */
async function ev(page, fn, arg) {
  try {
    return await page.evaluate(fn, arg);
  } catch (err) {
    const message = String(err?.message ?? err);
    if (message.includes('Execution context was destroyed') || message.includes("reading 'net'")) {
      console.error('\n  the page reloaded mid-test — Vite picked up an edit under src/.\n');
      await cleanup();
      process.exit(2);
    }
    throw err;
  }
}

async function openPlayer(label) {
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${label}: ${m.text()}`);
  });
  /**
   * The seed is in the URL beside the room, exactly as `inviteUrl` builds it.
   * Two people in one room standing in two different forests is the failure
   * `core/world-seed.js` exists to prevent, and pinning it here means the seat
   * indices and site coordinates below mean the same thing on both pages.
   */
  await page.goto(`${DEV_URL}/?room=${ROOM}&seed=${SEED}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.RR !== undefined, { timeout: 60_000 });
  await page.click('#enter');
  await page.waitForFunction(() => window.RR.audio.ready, { timeout: 25_000 });
  return page;
}

console.log(`\nopening two pages on ?room=${ROOM}&seed=${SEED}\n`);
const a = await openPlayer('A');
const b = await openPlayer('B');

const met = await waitFor(
  async () =>
    (await ev(a, () => window.RR.net.peers.length)) >= 1 &&
    (await ev(b, () => window.RR.net.peers.length)) >= 1,
  20_000,
  'the two pages to see each other'
);

console.log('membership');
check('they can see each other', met);
if (!met) {
  await cleanup();
  process.exit(1);
}

// ------------------------------------------------------------------ 1. chat

console.log('\nchat');
await ev(a, () => window.RR.net.say('is this thing on'));
const heard = await waitFor(
  async () =>
    (await ev(b, () => [...document.querySelectorAll('#chat-log .chat-line')].some((el) =>
      el.textContent.includes('is this thing on')
    ))),
  6000,
  "B's chat log"
);
check("B saw what A said", heard);

/**
 * The name is coloured by `hueFromId`, which is the only thing tying a line of
 * text to a body — `avatar.js` refuses nameplates. A line with no colour on it
 * is a regression in the one affordance that makes chat legible in a wood.
 */
const coloured = await ev(b, () => {
  const el = [...document.querySelectorAll('#chat-log .chat-line')].find((n) =>
    n.textContent.includes('is this thing on')
  );
  return el?.querySelector('b')?.style.color ?? '';
});
/**
 * Read back as `rgb(...)`, not as the `hsl(...)` that was written — every engine
 * normalises a computed colour into rgb, so asserting on the literal syntax
 * tests the browser rather than the app. What matters is that a colour was set
 * at all and that it is not the inherited ink, since an uncoloured name is the
 * regression: it would leave a line of text with nothing tying it to a body.
 */
check(
  'the speaker’s name is drawn in their own hue',
  /^rgba?\(/.test(coloured) && coloured !== 'rgb(242, 236, 224)',
  coloured
);

/** Echoed to the sender too, so both logs are the same log. See server/signaling.js. */
const ownEcho = await waitFor(
  async () =>
    await ev(a, () =>
      [...document.querySelectorAll('#chat-log .chat-line')].some((el) =>
        el.textContent.includes('is this thing on')
      )
    ),
  4000,
  "A's own line coming back"
);
check('A sees their own line, ordered by the server', ownEcho);

/** A note — what fishing announces — arrives on the same channel, set differently. */
await ev(a, () => window.RR.net.note('landed a chub, 41 cm'));
const noteSeen = await waitFor(
  async () =>
    await ev(b, () =>
      [...document.querySelectorAll('#chat-log .chat-note')].some((el) =>
        el.textContent.includes('landed a chub')
      )
    ),
  6000,
  'the note'
);
check('a note reaches the room and is set as a note', noteSeen);

// ----------------------------------------------------------------- 2. sitting

console.log('\npose');
const seated = await ev(a, () => {
  const { seats, sitting, controller, gathering } = window.RR;
  // Sit on the nearest seat to the commons, which both pages agree exists.
  const c = gathering.sites.commons;
  let best = null;
  let bestD = Infinity;
  for (const s of seats.seats) {
    const d = Math.hypot(s.position.x - c.x, s.position.z - c.z);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  controller.position.x = best.position.x;
  controller.position.z = best.position.z;
  sitting.sit(best);
  return { x: best.position.x, z: best.position.z, seated: sitting.seated };
});
check('A sat down', seated.seated);

const FLAG_SITTING = 1 << 4;
const sawSit = await waitFor(
  async () => ((await ev(b, () => window.RR.net.peers[0]?.flags ?? 0)) & FLAG_SITTING) !== 0,
  6000,
  'the sitting flag'
);
check("B's copy of A is sitting", sawSit);

/**
 * The pose has to reach the BODY, not just the flag word. `_sit` is the eased
 * value the limbs are actually posed from, so a non-zero reading here is the
 * difference between "the bit arrived" and "the avatar sat down".
 */
const posed = await waitFor(
  async () =>
    (await ev(b, () => {
      const id = window.RR.net.peers[0]?.id;
      const g = window.RR.scene.getObjectByName(`avatar:${id}`);
      return g ? (g.children[0]?.parent?.position.y ?? 0) : 0;
    })) < -0.2,
  6000,
  'the seated pose'
);
check('the avatar visibly lowered onto the seat', posed);

await ev(a, () => window.RR.sitting.stand());

// ------------------------------------------------------ 3. a screen, standing

console.log('\nputting a screen up');

/**
 * ONE ACT. Sharing IS placing — there is no second key, and the assertion below
 * is that there is no second key.
 *
 * `adopt` is handed no placement, which is the whole point: it asks the net
 * layer's `where()` for itself, so the terrain march in `aimGround`, the ground
 * clamp and the yaw theorem all run here exactly as they do behind
 * `getDisplayMedia`. A test that computed a spot in node and called
 * `share.place` would prove that `place` stores five numbers, which was never in
 * doubt; what is worth proving is that pressing one key puts a screen on the
 * floor in front of you.
 */
const placedAt = await ev(a, () => {
  /**
   * A canvas that actually changes every frame.
   *
   * A static canvas is a legitimate capture that produces exactly one frame and
   * then nothing, and the encoder is entitled to send nothing after it — which
   * looks identical to a broken share from the far end. Animating it means the
   * bytes-received assertion below is measuring a live stream.
   */
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 270;
  const ctx = canvas.getContext('2d');
  setInterval(() => {
    ctx.fillStyle = `hsl(${(Date.now() / 12) % 360} 85% 50%)`;
    ctx.fillRect(0, 0, 480, 270);
    ctx.fillStyle = '#000';
    ctx.fillRect(40, 40, 400, 190);
  }, 40);
  // Look down a little, so there is a crossing for the march to find rather
  // than the sky-fallback distance.
  window.RR.controller.pitch = -0.35;
  window.RR.net.share.adopt(canvas.captureStream(15), 'screen', 'test-pattern');
  const s = window.RR.net.share.spot;
  const p = window.RR.controller.position;
  return s ? { ...s, eyeX: p.x, eyeY: p.y, eyeZ: p.z } : null;
});
check('sharing stands a screen up, with no second key', Boolean(placedAt));

/**
 * It landed in FRONT of them and ON something. The height check is the one that
 * catches a broken march: a screen whose ground sample came back wrong sits at
 * the eye's own altitude, which reads as "floating" and is exactly what a march
 * that never found a crossing would produce.
 */
if (placedAt) {
  const reach = Math.hypot(placedAt.x - placedAt.eyeX, placedAt.z - placedAt.eyeZ);
  check('within arm-and-a-bit of where they were looking', reach > 2 && reach < 16, `${reach.toFixed(1)} m`);
  check('and standing on the ground, not at eye height', placedAt.y < placedAt.eyeY - 0.8, `${(placedAt.eyeY - placedAt.y).toFixed(2)} m below the eye`);
}

const announced = await waitFor(
  async () => Boolean(await ev(b, () => window.RR.net.peers[0]?.present)),
  8000,
  'the placement announcement'
);
check('B was told where it is', announced);

/**
 * THE COORDINATES SURVIVED THE WIRE, to the server's own two decimal places.
 *
 * This is the assertion the old single-string protocol could not have: two
 * people looking at the same screen now depends on six numbers crossing a
 * socket, being sanitised, and being replayed — and a placement that arrived
 * subtly wrong would put B's copy in a different part of the same forest, which
 * looks exactly like everything working until somebody walks over to it.
 */
if (placedAt) {
  const theirs = await ev(b, () => window.RR.net.peers[0]?.present);
  const drift = Math.hypot(theirs.x - placedAt.x, theirs.y - placedAt.y, theirs.z - placedAt.z);
  check('both machines put the screen in the same spot', drift < 0.02, `${(drift * 100).toFixed(1)} cm apart`);
  check('and agree on how wide it is', Math.abs(theirs.w - placedAt.w) < 0.02, `${theirs.w} m`);
}

const arrived = await waitFor(
  async () => await ev(b, () => Boolean(window.RR.net.peers[0]?.picture)),
  20_000,
  'the video track'
);
check('a real video track reached B', arrived);

const showing = await waitFor(
  async () => await ev(b, () => window.RR.net.screenFor(window.RR.net.peers[0].id)?.live === true),
  25_000,
  'the screen to light up'
);
check("B's copy of A's screen is showing a picture", showing);

const dims = await ev(b, () => {
  const s = window.RR.net.screenFor(window.RR.net.peers[0].id);
  return {
    w: s.video.videoWidth,
    h: s.video.videoHeight,
    owner: s.owner,
    fit: s.material.uniforms.uFit.value,
    live: s.material.uniforms.uLive.value,
    /** Legs are the visible difference between standing and floating. */
    legs: s.legs.filter((l) => l.visible && l.scale.y > 0.1).length,
  };
});
check('it is standing on two legs', dims.legs === 2, `${dims.legs} down`);
check('the picture has real dimensions', dims.w > 0 && dims.h > 0, `${dims.w}×${dims.h}`);
check('the surface knows whose it is', Boolean(dims.owner), String(dims.owner));

/**
 * The fade completes, rather than the fade being caught at a particular value.
 *
 * A first version asserted `uLive` was somewhere in the middle at the instant
 * `live` turned true, which is a race against a 4.5/s exponential and duly
 * reported 0.46 on one run and 0.14 on the next. What is actually worth
 * asserting is that the ramp arrives — a screen that faded in and stopped at
 * 0.6 would be a permanently half-transparent picture, and that is a bug the
 * eye would notice and this would catch.
 */
const faded = await waitFor(
  async () =>
    (await ev(
      b,
      () =>
        window.RR.net.screenFor(window.RR.net.peers[0].id).material.uniforms.uLive.value
    )) > 0.9,
  6000,
  'the crossfade to finish'
);
check('the picture faded up to full', faded, `first seen at ${dims.live.toFixed(2)}`);

/**
 * A LETTERBOX, NOT A STRETCH. The canvas is 16:9 and so is the screen, so a
 * correct fit is 1.0 — but the assertion that matters is that the number was
 * computed from the arriving video at all rather than left at its default,
 * which is also 1. Re-checked after switching the source to a 4:3 canvas.
 */
await ev(a, () => {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext('2d');
  setInterval(() => {
    ctx.fillStyle = `hsl(${(Date.now() / 9) % 360} 80% 55%)`;
    ctx.fillRect(0, 0, 320, 240);
  }, 40);
  /**
   * Re-adopted AT THE SPOT IT IS ALREADY AT, so the aspect change is the only
   * variable. `adopt`'s fourth argument exists for exactly this: replacing the
   * source without also re-aiming, and then having to work out which of the two
   * an assertion is actually about.
   */
  window.RR.net.share.adopt(canvas.captureStream(15), 'screen', 'four-three', {
    ...window.RR.net.share.spot,
  });
});
const refit = await waitFor(
  async () =>
    (await ev(
      b,
      () => window.RR.net.screenFor(window.RR.net.peers[0].id).material.uniforms.uFit.value
    )) < 0.95,
  20_000,
  'the aspect to change'
);
check('a 4:3 source letterboxes instead of stretching', refit);

// -------------------------------------------------------- 4. resizing, moving

console.log('\nresizing it, and moving it');

/**
 * A REAL WHEEL EVENT, for the same reason section 3 leaves the placement to the
 * aim. The handler's `deltaMode` normalisation, the exponential step, the clamp
 * and the trailing announce are the things worth testing, and none of them are
 * reachable by calling `share.resize` directly.
 *
 * DISPATCHED ON THE CANVAS AND ALLOWED TO BUBBLE, not fired at `window`. The
 * handler asks what the wheel was over — a wheel over the settings menu or the
 * debug panel must scroll them rather than resize a screen behind them — and an
 * event dispatched straight at `window` has `window` as its target, which is a
 * thing no real wheel ever is. Firing it at the canvas is both more honest and
 * the only way this covers that test.
 */
const grew = await ev(a, () => {
  const view = document.getElementById('view');
  const before = window.RR.net.sharing.width;
  for (let i = 0; i < 8; i++) {
    view.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -120, deltaMode: 0, bubbles: true, cancelable: true })
    );
  }
  return { before, after: window.RR.net.sharing.width };
});
check('scrolling up makes it bigger', grew.after > grew.before + 0.5, `${grew.before.toFixed(1)} → ${grew.after.toFixed(1)} m`);

/**
 * The far end has to end up at the new size, and the trailing timer means it
 * does not have to have seen every step on the way — which is the entire point
 * of the timer, so asserting on the endpoint is asserting on the contract.
 */
const resized = await waitFor(
  async () =>
    Math.abs((await ev(b, () => window.RR.net.peers[0]?.present?.w ?? 0)) - grew.after) < 0.05,
  8000,
  'the resize to reach B'
);
check("B's copy grew to match", resized);

const scaled = await ev(
  b,
  () => window.RR.net.screenFor(window.RR.net.peers[0].id).panel.scale.x
);
check('and the picture itself is that many metres wide', Math.abs(scaled - grew.after) < 0.05, `${scaled.toFixed(2)} m`);

/** The clamp. Sixteen metres is the ceiling; a hundred notches must not pass it. */
const clamped = await ev(a, () => {
  const view = document.getElementById('view');
  for (let i = 0; i < 100; i++) {
    view.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
  }
  return window.RR.net.sharing.width;
});
check('and stops at sixteen metres however hard you scroll', clamped <= 16.001, `${clamped.toFixed(2)} m`);

/**
 * AND A WHEEL OVER A MENU SCROLLS THE MENU. The settings body and the debug
 * panel both scroll and both take pointer events; a share being up used to make
 * them unscrollable, because this handler swallowed the wheel and resized a
 * screen the person was not even looking at.
 */
const overChrome = await ev(a, () => {
  const before = window.RR.net.sharing.width;
  const panel = document.getElementById('roster') ?? document.getElementById('help');
  const event = new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true });
  panel.dispatchEvent(event);
  return { before, after: window.RR.net.sharing.width, consumed: event.defaultPrevented };
});
check(
  'a wheel over a panel is left alone',
  overChrome.after === overChrome.before && !overChrome.consumed
);

/**
 * MOVING IT, which is the only thing `O` does now.
 *
 * A screen does not follow anybody any more — it is written once, when its owner
 * moves it — so the test is: walk somewhere else, press the key, and the screen
 * is somewhere else on the other machine. The pause after the teleport is for
 * the body to settle onto the ground, because `aimGround` casts from the eye and
 * an eye still falling through a hillside aims at a different patch of it.
 */
const wasAt = await ev(b, () => {
  const p = window.RR.net.screenFor(window.RR.net.peers[0].id).group.position;
  return { x: p.x, z: p.z };
});
await ev(a, () => {
  window.RR.controller.position.x += 14;
  window.RR.controller.position.z -= 9;
});
await new Promise((r) => setTimeout(r, 900));
const movedTo = await ev(a, () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO' }));
  const p = window.RR.controller.position;
  return { ...window.RR.net.share.spot, eyeX: p.x, eyeY: p.y, eyeZ: p.z };
});
check(
  'O aims the new spot at their feet, not at the old one',
  Math.hypot(movedTo.x - movedTo.eyeX, movedTo.z - movedTo.eyeZ) < 16,
  `${Math.hypot(movedTo.x - movedTo.eyeX, movedTo.z - movedTo.eyeZ).toFixed(1)} m from the eye`
);
check(
  'and it kept the size it was resized to',
  Math.abs(movedTo.w - clamped) < 0.02,
  `${movedTo.w.toFixed(2)} m`
);

const travelled = await waitFor(
  async () => {
    const p = await ev(b, () => {
      const at = window.RR.net.screenFor(window.RR.net.peers[0].id).group.position;
      return { x: at.x, z: at.z };
    });
    return Math.hypot(p.x - wasAt.x, p.z - wasAt.z) > 8;
  },
  8000,
  'the move to reach B'
);
check("B's copy moved with it", travelled);

/**
 * AND THE PICTURE NEVER WENT OUT. A move is a transform on one surviving object
 * precisely so that shifting a screen mid-film does not tear down a decoder and
 * build another one — if this ever reads false, that has quietly stopped being
 * true and everybody watching saw a black frame.
 */
const afterMove = await ev(b, () => {
  const s = window.RR.net.screenFor(window.RR.net.peers[0].id);
  return { legs: s.legs.filter((l) => l.visible && l.scale.y > 0.1).length, live: s.live };
});
check('it is still standing on two legs', afterMove.legs === 2, `${afterMove.legs} down`);
check('and the picture never blinked', afterMove.live === true);

await ev(a, () => window.RR.net.share.stop());
const stopped = await waitFor(
  async () =>
    await ev(b, () => {
      const s = window.RR.net.screenFor(window.RR.net.peers[0].id);
      return !s || s.group.visible === false;
    }),
  8000,
  'the share to stop'
);
check('stopping takes the screen away', stopped);

// -------------------------------------------------------------- 5. the ferry

console.log('\nthe world both of them are in');
const ferries = await Promise.all(
  [a, b].map((p) =>
    ev(p, () => {
      const f = window.RR.ferry;
      return f
        ? { x: f.group.position.x, z: f.group.position.z, period: f.schedule.period }
        : null;
    })
  )
);
if (ferries[0] && ferries[1]) {
  const apart = Math.hypot(ferries[0].x - ferries[1].x, ferries[0].z - ferries[1].z);
  /**
   * Nothing about the ferry travels over the wire — its position is a pure
   * function of the Unix epoch. Two metres of tolerance is the sampling gap
   * between the two `evaluate` calls at 2.3 m/s, not slop in the agreement.
   */
  check('both machines put the raft in the same place, with no message', apart < 2.5, `${apart.toFixed(2)} m apart`);
  check('and agree on its timetable', ferries[0].period === ferries[1].period);
} else {
  console.log('  (this seed has no navigable water, so there is no ferry to check)');
}

const sites = await Promise.all(
  [a, b].map((p) =>
    ev(p, () => {
      const s = window.RR.gathering.sites;
      return [s.commons.x, s.commons.z, ...s.hearths.flatMap((h) => [h.x, h.z])].map((n) =>
        Math.round(n * 100)
      );
    })
  )
);
check(
  'both measured their commons and their fires to the same places',
  JSON.stringify(sites[0]) === JSON.stringify(sites[1])
);

// --------------------------------------------------------------------- report

const real = errors.filter(
  (e) => !/pointer lock|Mismatch between texture format/i.test(e)
);
console.log('');
if (real.length) {
  console.log(`${real.length} console problem(s):`);
  for (const e of real.slice(0, 12)) console.log('  ', e);
  failures += 1;
}

await cleanup();
console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
