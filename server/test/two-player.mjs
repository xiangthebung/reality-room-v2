import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/**
 * Two people in one forest, driven for real.
 *
 * Everything up to here can be true while multiplayer is still broken, because
 * every part of it is testable in isolation and none of the interesting failures
 * are. So this starts the actual signalling server, opens two actual browser
 * pages against the actual dev server, joins them to one room, and then asks the
 * only questions that matter:
 *
 *   - does each page see the other person at all
 *   - when one of them walks, does the other one's copy of them move
 *   - did a peer connection form, and did audio bytes actually arrive over it
 *   - does the speaking indicator light up from received audio
 *   - and, last, does killing the server leave a working single-player game
 *
 * The pages are wired through the published contract — `attachMultiplayer` is
 * imported and called here exactly as main.js calls it — so this also proves the
 * integration snippet, without this script needing to own main.js.
 *
 * Chromium's fake media device is a repeating tone, which is loud enough to open
 * the noise gate. That is the point: it means the voice assertions below are
 * measuring a real Opus stream over a real RTCPeerConnection, not a mock.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

/**
 * Overridable, because 5180 is not always this project's. See the longer note in
 * two-social.mjs: a stranger's Vite on this port serves these files perfectly
 * well while proxying `/ws` somewhere else, and the result reads as broken
 * netcode rather than as a wrong address.
 *
 *   DEV_URL=http://127.0.0.1:5184 node server/test/two-player.mjs
 */
const DEV_URL = process.env.DEV_URL || 'http://127.0.0.1:5180';
/** `SIGNALLING_PORT`, matching server/index.js and vite.config.js. See the note there. */
const SERVER_PORT = Number(process.env.SIGNALLING_PORT) || Number(process.env.PORT) || 5181;
const ROOM = 'abc-def-ghj';

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
    // A repeating tone on the microphone and no permission dialog.
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
});
const context = await browser.newContext({
  viewport: { width: 760, height: 460 },
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

/**
 * Every page.evaluate goes through here.
 *
 * Not defensiveness for its own sake: this test holds live state on the page
 * (`window.RR.net` and a frame loop) for a couple of minutes, and Vite will
 * reload the page out from under it the moment anything in `src/` is saved.
 * Without this the run dies on a `Cannot read properties of undefined` twenty
 * lines from the actual cause, which is a genuinely confusing way to be told
 * "you edited a file while the test was running".
 */
async function ev(page, fn, arg) {
  try {
    return await page.evaluate(fn, arg);
  } catch (err) {
    const message = String(err?.message ?? err);
    if (message.includes("reading 'net'") || message.includes('Execution context was destroyed')) {
      console.error(
        '\n  the page reloaded mid-test — Vite picked up an edit under src/.' +
          '\n  Re-run with the working tree quiet.\n'
      );
      await cleanup();
      process.exit(2);
    }
    throw err;
  }
}

/**
 * Bring one page up and use THE APP'S OWN multiplayer.
 *
 * This used to import `attachMultiplayer` and build a second instance beside
 * main.js's, on the reasoning that testing the published entry point is better
 * than testing the app's private wiring. It is — except that the URL under test
 * carries `?room=`, and `attachMultiplayer` auto-joins when it sees one. So each
 * page opened TWO sockets and the room held four players for two browsers.
 *
 * The failures that produced were a masterclass in misleading: membership said
 * "3 people are already out there", both pages reported the same peer id as
 * their first entry (each was looking at the other page's *main.js* instance),
 * the speaking indicator never lit because the audio was arriving at the other
 * instance's avatars, and closing a page did not remove an avatar because its
 * other socket was still there. Every one of those looks like a netcode bug.
 *
 * Using `window.RR.net` also tests more, not less: it is the instance main.js
 * built, with the big screen wired into it, driven by main.js's own frame loop.
 */
async function openPlayer(label, url) {
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${label}: ${m.text()}`);
  });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.RR !== undefined, { timeout: 60_000 });

  /**
   * Watch the HUD rather than injecting a fake one.
   *
   * The give-up assertion at the end needs the list of lines the net layer said,
   * and main.js gave it a real `Hud`. `#toast` is where a toast lands, so the
   * observer reads what a player would have read — which is a better thing to
   * assert on than a stub's call log. Installed before `#enter` because the
   * first line arrives within a second of the gate lifting.
   */
  await ev(page, () => {
    window.RRTOASTS = [];
    const el = document.getElementById('toast');
    new MutationObserver(() => {
      const text = el.textContent.trim();
      if (text && window.RRTOASTS[window.RRTOASTS.length - 1] !== text) {
        window.RRTOASTS.push(text);
      }
    }).observe(el, { childList: true, characterData: true, subtree: true });
  });

  // Synthetically, via `enter` below — `page.click` starts silently missing
  // once a few WebGL contexts are live, and the third page opened by this file
  // is well past that point. See the note on `enter`.
  await enter(page);
  await page.waitForFunction(() => window.RR.audio.ready, { timeout: 20_000 });
  return page;
}

/**
 * Click through the gate, synthetically.
 *
 * `page.click` does the right thing for the first page or two and then starts
 * losing them: Playwright's actionability checks and the real input queue both
 * go through a compositor that four live WebGL contexts have already saturated,
 * and the click is silently dropped rather than erroring. What that looks like
 * from here is a page that loaded fine and never entered the forest, i.e. the
 * `single-player is untouched and the gate opened` check failing for reasons
 * that have nothing to do with single player.
 *
 * Dispatching the event directly skips the queue entirely. It is a weaker test
 * of the button — it would not catch one covered by an invisible overlay — and
 * that is an acceptable trade for the pages this file opens late in a run,
 * because the gate is covered properly by `server/test/menu.mjs`.
 */
async function enter(page) {
  await page.waitForFunction(() => document.getElementById('enter') !== null, { timeout: 30_000 });
  await ev(page, () => {
    document.getElementById('enter').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForFunction(
    () => document.getElementById('gate')?.classList.contains('gone'),
    { timeout: 30_000 }
  );
}

const state = (page) =>
  ev(page, () => ({
    status: window.RR.net.status,
    room: window.RR.net.room,
    peers: window.RR.net.peers.map((p) => ({
      id: p.id,
      x: Number(p.position.x.toFixed(2)),
      z: Number(p.position.z.toFixed(2)),
      speaking: p.speaking,
      voice: p.voice,
      trip: p.trip,
      state: p.connection?.state ?? null,
      bytes: p.connection?.bytes ?? 0,
    })),
    toasts: window.RRTOASTS.slice(),
  }));

console.log(`\nopening two pages on ?room=${ROOM}\n`);
const a = await openPlayer('A', `${DEV_URL}/?room=${ROOM}`);
const b = await openPlayer('B', `${DEV_URL}/?room=${ROOM}`);

// --------------------------------------------------------------- 1. they meet

const met = await waitFor(
  async () =>
    (await ev(a, () => window.RR.net.peers.length)) === 1 &&
    (await ev(b, () => window.RR.net.peers.length)) === 1,
  15_000,
  'the two pages to see each other'
);

console.log('membership');
check('A sees exactly one other person', met);
const sa = await state(a);
const sb = await state(b);
check('B sees exactly one other person', sb.peers.length === 1);
check('both are in the room named in the URL', sa.room === ROOM && sb.room === ROOM, sa.room);
check(
  'each sees the other, not itself',
  sa.peers[0]?.id !== sb.peers[0]?.id,
  `${sa.peers[0]?.id} / ${sb.peers[0]?.id}`
);

// ------------------------------------------------------- 2. an avatar in scene

const inScene = await ev(b, () => {
  const id = window.RR.net.peers[0]?.id;
  const object = window.RR.scene.getObjectByName(`avatar:${id}`);
  return { found: Boolean(object), children: object?.children.length ?? 0 };
});
check('B has a real avatar object in the scene graph', inScene.found, `${inScene.children} parts`);

// -------------------------------------------------------------- 3. A walks

console.log('\nmovement');
const before = (await state(b)).peers[0];
await ev(a, () => {
  window.RR.controller.position.x = 24;
  window.RR.controller.position.z = -18;
});
await new Promise((r) => setTimeout(r, 1500));
const after = (await state(b)).peers[0];
const travelled = Math.hypot(after.x - before.x, after.z - before.z);
check(
  "B's copy of A followed A's move",
  travelled > 5,
  `(${before.x}, ${before.z}) -> (${after.x}, ${after.z}), ${travelled.toFixed(1)} m`
);
check(
  "B's copy of A landed near where A actually is",
  Math.hypot(after.x - 24, after.z + 18) < 2.5,
  `off by ${Math.hypot(after.x - 24, after.z + 18).toFixed(2)} m`
);

/**
 * Interpolation, not snapping.
 *
 * Sampled every 16 ms while A walks steadily. If the avatar were being written
 * straight from the packets it would sit still for 55 ms and then jump, so the
 * per-sample distances would be a run of zeros punctuated by large steps. A
 * true interpolation moves a little on *every* frame, so the fraction of
 * samples that moved at all is the measurement.
 */
await ev(a, () => {
  window.RR.controller.position.x = 0;
  window.RR.controller.position.z = 0;
});
await new Promise((r) => setTimeout(r, 800));
const smoothness = await ev(b, async () => {
  const id = window.RR.net.peers[0]?.id;
  const object = window.RR.scene.getObjectByName(`avatar:${id}`);
  const samples = [];
  for (let i = 0; i < 90; i++) {
    samples.push(object.position.clone());
    await new Promise((r) => requestAnimationFrame(r));
  }
  let moved = 0;
  let total = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].distanceTo(samples[i - 1]);
    total += d;
    if (d > 1e-4) moved += 1;
  }
  return { moved, of: samples.length - 1, total };
});
// Started by asking A to walk in a straight line for the duration of the sample.
const walked = ev(a, async () => {
  for (let i = 0; i < 100; i++) {
    window.RR.controller.position.x += 0.06;
    await new Promise((r) => requestAnimationFrame(r));
  }
});
const smooth2 = await ev(b, async () => {
  const id = window.RR.net.peers[0]?.id;
  const object = window.RR.scene.getObjectByName(`avatar:${id}`);
  const samples = [];
  for (let i = 0; i < 100; i++) {
    samples.push(object.position.x);
    await new Promise((r) => requestAnimationFrame(r));
  }
  let moved = 0;
  for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i] - samples[i - 1]) > 1e-4) moved += 1;
  return { moved, of: samples.length - 1, span: samples[samples.length - 1] - samples[0] };
});
await walked;
check(
  'the remote avatar moves on most frames, not once per packet',
  smooth2.span > 1 && smooth2.moved / smooth2.of > 0.6,
  `${smooth2.moved}/${smooth2.of} frames moved over ${smooth2.span.toFixed(2)} m`
);
void smoothness;

// ------------------------------------------------------------------ 4. voice

console.log('\nvoice');
const voiced = await waitFor(
  async () => {
    const s = await state(a);
    return (s.peers[0]?.bytes ?? 0) > 2000;
  },
  25_000,
  'audio to flow over the peer connection'
);
const va = (await state(a)).peers[0];
const vb = (await state(b)).peers[0];
check('a peer connection reached "connected"', va.state === 'connected', String(va.state));
check('audio bytes actually arrived at A', voiced && va.bytes > 2000, `${va.bytes} bytes`);
check('audio bytes actually arrived at B', vb.bytes > 2000, `${vb.bytes} bytes`);
check('A has a spatialised source for B', va.voice === true);

const speaking = await waitFor(
  async () => (await ev(a, () => window.RR.net.peers[0]?.speaking)) === true,
  12_000,
  'the speaking indicator'
);
check('the speaking indicator lit from received audio', speaking);

const glow = await ev(a, () => {
  const id = window.RR.net.peers[0]?.id;
  const object = window.RR.scene.getObjectByName(`avatar:${id}`);
  let value = -1;
  object.traverse((o) => {
    if (o.material?.uniforms?.uVoice) value = o.material.uniforms.uVoice.value;
  });
  return value;
});
check('the avatar glow uniform is being driven', glow > 0.05, `uVoice = ${glow.toFixed(3)}`);

/**
 * Polled rather than sampled once. Chromium's fake microphone is a *beep* — a
 * tone that pulses on and off — so a single reading of `speaking` lands in a
 * gap about as often as not, and asserting on one is a coin flip.
 */
const micOpen = await waitFor(
  async () => (await ev(a, () => window.RR.net.microphone?.speaking)) === true,
  10_000,
  'the local noise gate to open'
);
const micState = await ev(a, () => ({
  available: window.RR.net.microphone?.available ?? false,
  mode: window.RR.net.microphone?.mode ?? null,
}));
check(
  'the local microphone opened and its gate passed audio',
  micState.available && micOpen,
  JSON.stringify(micState)
);

// --------------------------------------------------- 5. mute, push-to-talk

await ev(a, () => {
  window.RR.net.microphone.muted = true;
});
await new Promise((r) => setTimeout(r, 1200));
const mutedEnvelope = await ev(a, () => window.RR.net.microphone.update(0.016));
check('muting zeroes the broadcast envelope', mutedEnvelope === 0);
await ev(a, () => {
  window.RR.net.microphone.muted = false;
  window.RR.net.microphone.mode = 'ptt';
  window.RR.net.microphone.talking = false;
});
// Peak over a second, for the same beep-gap reason as above.
const peak = () =>
  ev(a, async () => {
    let max = 0;
    for (let i = 0; i < 60; i++) {
      max = Math.max(max, window.RR.net.microphone.update(0.016));
      await new Promise((r) => requestAnimationFrame(r));
    }
    return max;
  });
const pttSilent = await peak();
await ev(a, () => {
  window.RR.net.microphone.talking = true;
});
const pttTalking = await peak();
check(
  'push-to-talk transmits only while the key is held',
  pttSilent === 0 && pttTalking > 0,
  `released ${pttSilent}, held ${pttTalking.toFixed(3)}`
);

// ------------------------------------------------------- 6. one world, not two

/**
 * THE ASSERTIONS THAT ARE INVISIBLE IN A SINGLE-PLAYER SESSION.
 *
 * Everything above this point is about people: where they are, whether you can
 * hear them, whether their body moved. This section is about the WORLD they are
 * standing in, and it exists because every failure in this category looks
 * exactly like the forest working.
 *
 * The river's waves, the cloud scroll, the campfire flicker and every tree's
 * sway are pure functions of one number — `worldClock()` — and that number used
 * to count from whenever each tab happened to load. Two people on one jetty
 * therefore watched different water, and nothing errored, nothing logged, and
 * each half of it was individually correct. There is no way to notice that
 * without two pages side by side, which is why the check lives here.
 *
 * TOLERANCES ARE IN THE UNITS THAT MATTER, not in significant figures. The
 * clock is adopted from an age carried in the `welcome` message, so the
 * residual error is the one-way latency of that message plus however far apart
 * the two `Date.now()` reads below land. A quarter of a second is generous
 * against both and still two orders of magnitude tighter than the failure being
 * caught, which was unbounded and grew with the age of the older tab.
 */
console.log('\none world');

/**
 * EVERY FIELD IS READ IN ONE EVALUATE PER PAGE, and the ones compared across
 * pages are all read-time independent. That is not tidiness — the first version
 * of this compared `worldClock()` between the two pages and failed
 * intermittently at 419 ms while passing at 178 ms, because a page whose
 * renderer is busy answers a devtools evaluate later than an idle one and the
 * delay lands in the reading indistinguishably from real drift. A test that
 * fails a quarter of the time on timing noise is worse than no test: it teaches
 * you to re-run it.
 */
const snap = (page) =>
  ev(page, () => ({
    seed: window.RR.seed,
    origin: window.RR.worldOrigin(),
    clock: window.RR.worldClock(),
    phase: window.RR.atmosphere.day.phase(),
    track: window.RR.music?.trackIndex ?? null,
    playing: Boolean(window.RR.music?.playing),
    /**
     * Which sixteenth of the record the sequencer is on. The unit the jukebox
     * actually counts in, so comparing it compares the thing that has to match
     * — two clients on the same step are generating the same notes.
     */
    step: window.RR.music?.step16 ?? null,
    speakerL: window.RR.speakers.cabinets[0].spot(),
    speakerR: window.RR.speakers.cabinets[1].spot(),
    /**
     * The wind's LOCAL part, with the shared baseline subtracted off inside the
     * page so both terms come from the same instant. Zero for anybody who is
     * not tripping and has not touched the debug panel; see `updateWind`.
     */
    windSkew: window.RR.tripUniforms.uWind.value.x - window.RR.worldClock() * 0.55,
  }));
const [worldA, worldB] = await Promise.all([snap(a), snap(b)]);

check('both pages built the same wood', worldA.seed === worldB.seed, worldA.seed);

/**
 * The origins, not the clocks. Both pages share one `Date.now()` here — they
 * are two tabs in one browser — so their origins are directly comparable and
 * do not move between the two reads. The residual is the one-way latency of
 * whichever `welcome` arrived second.
 */
/**
 * FIFTY MILLISECONDS, AGAINST A MEASURED ONE. The slack is for a loaded CI box,
 * not for the failure this is guarding.
 *
 * The number to keep in mind is what this looked like before the `pong`
 * refinement existed: 948 ms, because each page adopted the clock off `welcome`
 * while its own main thread was blocked building a forest, and a one-way
 * message cannot tell you how late it is. Anything that breaks the round-trip
 * correction lands back around a second, twenty times outside this bound. A
 * tolerance of 250 would have passed some of those runs.
 */
const originGap = Math.abs(worldA.origin - worldB.origin);
check(
  'both pages are on the same world clock',
  originGap < 50,
  `origins ${originGap.toFixed(0)} ms apart (clocks read ${worldA.clock.toFixed(2)}s / ${worldB.clock.toFixed(2)}s)`
);
check(
  'the world clock is actually running',
  worldA.clock > 0.5,
  `${worldA.clock.toFixed(2)}s since the room started`
);

/**
 * And that neither page has a private offset on top of it. The baseline is
 * provably identical once the origins match — same formula, same input — so
 * what is left to get wrong is the skew, and a sober client's skew must be
 * exactly nothing. This is the term a leaked gust boost or a stuck debug
 * multiplier would show up in.
 */
check(
  'every tree is swaying to the same wind',
  Math.abs(worldA.windSkew) < 0.01 && Math.abs(worldB.windSkew) < 0.01,
  `local offsets ${worldA.windSkew.toFixed(4)} and ${worldB.windSkew.toFixed(4)} rad`
);

/**
 * And the sky. `dayPhase` is a pure function of `(now - origin)`, so this only
 * passes if both pages adopted the room's `dayAgeMs` — a guest who kept their
 * own arrival hour would be a whole phase away, not a fraction of one.
 *
 * Wrapped, because a phase is a circle and 0.999 vs 0.001 is two milliseconds
 * apart rather than a whole day.
 */
/**
 * THE SAME RECORD, AT THE SAME POINT IN IT.
 *
 * The jukebox never touched the network at all before this: everybody heard
 * their own record, in their own key, starting whenever their tab loaded. Two
 * people sitting at the same fire could not talk about the music, which for a
 * thing built so a group of friends can be somewhere together is close to the
 * whole point of having music in it.
 *
 * No audio crosses the wire to make this true. The synthesised tracks are a
 * pure function of (bar, step), so an index and a start time are enough for
 * every machine to generate the same notes independently — see `startAt` in
 * audio/music.js. What is being asserted here is that the description
 * travelled and that both sequencers landed on the same step of it.
 *
 * EIGHT STEPS OF SLACK, which is half a bar. Both clients derive the step from
 * the shared world clock, so in practice they are exact; the tolerance is for
 * the case where one page's `startAt` rounded down across a step boundary the
 * other rounded up. At 96 bpm a whole step is 156 ms, and nobody hears anybody
 * else's audio anyway — the requirement is the same bar, not the same sample.
 */
check(
  'both pages are playing',
  worldA.playing && worldB.playing,
  `A ${worldA.playing} / B ${worldB.playing}`
);
check(
  'both pages are playing the same record',
  worldA.track === worldB.track,
  `track ${worldA.track} vs ${worldB.track}`
);
check(
  'both pages are at the same point in it',
  Math.abs(worldA.step - worldB.step) <= 8,
  `step ${worldA.step} vs ${worldB.step}`
);

/**
 * And the cabinets the music is coming out of. Rounded to 2 dp on the wire, so
 * a centimetre is the tightest this can honestly be.
 */
const cabGap = Math.max(
  Math.hypot(worldA.speakerL.x - worldB.speakerL.x, worldA.speakerL.z - worldB.speakerL.z),
  Math.hypot(worldA.speakerR.x - worldB.speakerR.x, worldA.speakerR.z - worldB.speakerR.z)
);
check(
  'the speakers are standing in the same place',
  cabGap < 0.05,
  `${cabGap.toFixed(3)} m apart`
);

const rawPhaseGap = Math.abs(worldA.phase - worldB.phase);
const phaseGap = Math.min(rawPhaseGap, 1 - rawPhaseGap);
check(
  'both pages agree what time of day it is',
  phaseGap < 0.001,
  `${worldA.phase.toFixed(4)} vs ${worldB.phase.toFixed(4)}`
);

// --------------------------------------------------------------- 7. the trip

/**
 * DELIBERATELY AFTER THE SECTION ABOVE, because a trip is the one thing a
 * player can do that is ALLOWED to pull their world out of step with the room —
 * the gust boost is a function of a level only they have. Measuring the shared
 * baseline first and the divergence second is the only order in which either
 * number means anything.
 */
console.log('\ntrip state');
/**
 * `WIND_RATE_X` from src/trip/living.js. Duplicated rather than imported
 * because this file drives a browser from node and shares no module graph with
 * the app — the same reason `src/net/protocol.js` and `server/rooms.js` keep
 * two copies of the wire format. If it ever changes, the `a trip gusts harder`
 * check below goes soft rather than failing loudly, so it is worth a grep.
 */
const WIND_RATE_X = 0.55;

const windBeforeTrip = await ev(a, () => window.RR.tripUniforms.uWind.value.x);
await ev(a, () => window.RR.director.seek(180));
await new Promise((r) => setTimeout(r, 1200));
const tripSeen = (await state(b)).peers[0]?.trip ?? 0;
check('B can see that A is tripping', tripSeen > 0.2, `level ${tripSeen.toFixed(2)}`);

/**
 * The trip pushed A's wind ahead of the room's. That is the intended effect and
 * this is the assertion that it actually happens — without it, the drain below
 * would pass trivially on a boost that was never applied.
 *
 * The baseline every client shares is subtracted off, so what is left is the
 * skew alone. Both pages advanced 1.2 s of world clock during the wait and only
 * A had a gust boost on top of it.
 */
const windDuringTrip = await ev(a, () => window.RR.tripUniforms.uWind.value.x);
const lead = windDuringTrip - windBeforeTrip - WIND_RATE_X * 1.2;
check('a trip gusts harder than the room', lead > 0.1, `${lead.toFixed(2)} rad ahead`);

await a.keyboard.press('KeyN');

/**
 * AND THE DIVERGENCE HAS TO BE AS TEMPORARY AS THE TRIP WAS.
 *
 * The skew that a trip adds used to be a ratchet — it accumulated for five
 * minutes and then stayed, leaving that client's trees permanently out of step
 * with everybody else's. `WIND_SKEW_RETURN` drains it at six percent a second,
 * which is slow enough to be invisible and therefore slow enough that this
 * check cannot wait for it to finish. So it asserts the DIRECTION rather than
 * the arrival: the gap must be smaller than it was, which is only true if the
 * drain exists at all.
 */
const gapAfterTrip = async () => {
  const [wa, wb] = await Promise.all([
    ev(a, () => window.RR.tripUniforms.uWind.value.x),
    ev(b, () => window.RR.tripUniforms.uWind.value.x),
  ]);
  return Math.abs(wa - wb);
};
/**
 * WAIT FOR THE TRIP TO ACTUALLY BE OVER FIRST, which `N` does not make true
 * immediately: `director.level` is an eased value and it takes several seconds
 * to reach zero. The drain is deliberately gated on there being no drive at all
 * (see `updateWind`), so sampling while the level is still 0.3 measures a gust
 * boost that is still winning — the gap GROWS, and the check fails while the
 * code is doing exactly what it should.
 *
 * This is the difference between "the trip ended" and "the trip has finished
 * ending", and only the second one is the precondition being tested.
 */
const faded = await waitFor(
  async () => (await ev(a, () => window.RR.director.level)) < 0.01,
  20_000,
  'the trip to finish fading'
);
check('grounding actually ends the trip', faded);

const gapAtGround = await gapAfterTrip();
await new Promise((r) => setTimeout(r, 6000));
const gapLater = await gapAfterTrip();
check(
  "a trip's wind gives itself back",
  gapLater < gapAtGround - 0.05,
  `${gapAtGround.toFixed(2)} rad -> ${gapLater.toFixed(2)} rad`
);

// ------------------------------------------------------------- 8. mushrooms

/**
 * THE ONE PIECE OF SHARED WORLD STATE A PLAYER CREATES RATHER THAN MOVES.
 *
 * The speakers and the jukebox were both already there; this is a thing that
 * happens, and it is the only change to the forest itself that one person can
 * make. Before it travelled, eating a mushroom removed it from your world and
 * left it standing in everybody else's — a divergence that is permanent, that
 * nothing reports, and that two people walking together to the same patch
 * discover by one of them reaching for a key that does nothing.
 *
 * DELIBERATELY AFTER THE TRIP SECTION, and not for tidiness: eating one starts
 * a real dose on A. Section 6 asserts A's wind skew is exactly nothing and
 * section 7 waits for a trip to finish fading, and both of those would be
 * measuring this mushroom instead. Nothing below here cares that A is high.
 */
console.log('\nmushrooms');

/**
 * Somewhere neither the fire ring nor the speakers can reach.
 *
 * `E` means six things and the nearest wins, so a patch beside the commons is a
 * patch where this test sits the player down on a log instead — which is the
 * game working correctly and the check failing. A hundred and forty metres out
 * there is nothing to compete with, and both pages stand inside one 80 m
 * undergrowth ring so both have the same sectors streamed.
 */
await Promise.all([
  ev(a, () => {
    window.RR.controller.position.x = 140;
    window.RR.controller.position.z = -90;
  }),
  ev(b, () => {
    window.RR.controller.position.x = 146;
    window.RR.controller.position.z = -90;
  }),
]);

/** A patch BOTH pages have streamed in, so B can watch it go. */
const patchOf = (page) =>
  ev(page, () =>
    window.RR.forest.patches.map((p) => ({
      id: p.id,
      x: p.x,
      z: p.z,
      d: Math.hypot(p.x - window.RR.controller.position.x, p.z - window.RR.controller.position.z),
    }))
  );

let victim = null;
const found = await waitFor(async () => {
  const [pa, pb] = await Promise.all([patchOf(a), patchOf(b)]);
  const mine = new Set(pb.map((p) => p.id));
  victim = pa.filter((p) => mine.has(p.id)).sort((p, q) => p.d - q.d)[0] ?? null;
  return victim !== null;
}, 20_000, 'a mushroom patch both pages can see');
check('there is a patch both pages can see', found, victim?.id ?? 'none in range');

if (victim) {
  /**
   * Eaten with the actual key, from the actual place.
   *
   * The alternative was calling `eatPatch` and `sendEat` from here, which is
   * two lines copied out of `interact()` — and a refactor that dropped the
   * announcement would leave this passing. Standing on the patch and striking
   * `E` tests the ranking in `findInteractable` too, which is the part that
   * decides a mushroom beats whatever else is within reach.
   */
  await ev(a, (p) => {
    window.RR.controller.position.x = p.x;
    window.RR.controller.position.z = p.z;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
  }, victim);

  const gone = await ev(a, (id) => ({
    eaten: window.RR.forest.field.eaten.has(id),
    standing: window.RR.forest.patches.some((p) => p.id === id),
  }), victim.id);
  check('E over a patch eats it', gone.eaten && !gone.standing, victim.id);

  const spread = await waitFor(
    async () => await ev(b, (id) => window.RR.forest.field.eaten.has(id), victim.id),
    8000,
    "B to hear about A's mushroom"
  );
  check("the mushroom A ate is gone from B's forest too", spread);
  check(
    'and B cannot walk over and eat it again',
    !(await ev(b, (id) => window.RR.forest.patches.some((p) => p.id === id), victim.id))
  );

  /**
   * AND IT STAYS EATEN THROUGH A SECTOR RELOAD, which is the half of this that
   * has nothing to do with the network.
   *
   * Undergrowth evicts at 120 m and comes back rebuilt from the worker, which
   * has never heard of anybody eating anything — so before `_accept` learned to
   * check, walking away and back regrew it, locally, in single player, and had
   * done since the day patches were streamed. Sharing the eat would have made
   * that worse rather than better: the room would remember and every client
   * would quietly disagree with it the moment somebody walked a lap.
   *
   * The counters are asserted alongside, because a "still gone" that never
   * reloaded the sector proves nothing at all.
   */
  const beforeTrip = await ev(b, () => window.RR.forest.field.evicted);
  await ev(b, () => {
    window.RR.controller.position.x = 900;
    window.RR.controller.position.z = 900;
  });
  const evicted = await waitFor(
    async () => (await ev(b, () => window.RR.forest.field.evicted)) > beforeTrip + 10,
    20_000,
    'B to walk far enough out to drop those sectors'
  );
  check('the ground B was standing on unloaded behind them', evicted);

  await ev(b, (p) => {
    window.RR.controller.position.x = p.x;
    window.RR.controller.position.z = p.z;
  }, victim);
  const back = await waitFor(
    async () => (await ev(b, () => window.RR.forest.patches.length)) > 0,
    20_000,
    'the undergrowth to stream back in around B'
  );
  check('and streamed back in when they returned', back);
  check(
    'the eaten mushroom did not grow back',
    !(await ev(b, (id) => window.RR.forest.patches.some((p) => p.id === id), victim.id)),
    victim.id
  );

  /**
   * A THIRD PERSON, ARRIVING LATE, HAVING EATEN ON THE WAY IN.
   *
   * Two paths in one page, because they are two halves of the same rule and
   * each is invisible without the other:
   *
   *   the welcome replay   C never saw A eat anything, so the only way it can
   *                        know is `room.eaten` arriving in the welcome. This is
   *                        the difference between a shared world and a world
   *                        that is shared only with whoever was watching.
   *   teaching the room    C ate one before it had a room to tell — a solitary
   *                        walk, then `J`. The forest it was walking in becomes
   *                        the room's forest, seed and all, so those patches are
   *                        real and have to travel on arrival. Same rule the
   *                        speakers follow, and the same rule the seed follows:
   *                        the first thing a client does on being told the room
   *                        has no opinion is supply one.
   *
   * Opened with A's seed spelled out rather than left to the default, because
   * everything below turns on the three pages being in one wood and a patch id
   * means nothing at all across two.
   */
  const late = await openPlayer('C', `${DEV_URL}/?seed=${worldA.seed}`);
  check(
    'a page with no room joins no room',
    (await ev(late, () => window.RR.net.status)) === 'off'
  );

  await ev(late, (p) => {
    window.RR.controller.position.x = p.x;
    window.RR.controller.position.z = p.z;
  }, victim);
  let second = null;
  const alsoFound = await waitFor(async () => {
    const list = await patchOf(late);
    // Not the one A ate: C has never been told about that, so its forest still
    // has it standing and eating it again would prove nothing.
    second = list.filter((p) => p.id !== victim.id).sort((p, q) => p.d - q.d)[0] ?? null;
    return second !== null && second.d < 400;
  }, 20_000, 'a second patch for C to eat');
  check('C found a patch of its own', alsoFound, second?.id ?? 'none');

  if (second) {
    await ev(late, (p) => {
      window.RR.controller.position.x = p.x;
      window.RR.controller.position.z = p.z;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
    }, second);
    check(
      'C ate one while still on their own',
      await ev(late, (id) => window.RR.forest.field.eaten.has(id), second.id),
      second.id
    );

    await ev(late, (room) => window.RR.net.joinRoom(room), ROOM);
    const arrived = await waitFor(
      async () => (await ev(late, () => window.RR.net.status)) === 'live',
      15_000,
      'C to join the room'
    );
    check('C joined the room', arrived);

    check(
      "C was told about the mushroom A ate before C arrived",
      await waitFor(
        async () => await ev(late, (id) => window.RR.forest.field.eaten.has(id), victim.id),
        8000,
        "C to be caught up on the room's mushrooms"
      ),
      victim.id
    );
    check(
      'and the room was told about the one C ate on the way',
      await waitFor(
        async () => await ev(a, (id) => window.RR.forest.field.eaten.has(id), second.id),
        8000,
        "A to hear about C's mushroom"
      ),
      second.id
    );
  }

  /**
   * And out again BEFORE the section below, which closes B and waits for A to
   * be alone. A third socket still in the room makes that wait time out, and
   * what it would report is "leaving removes the avatar" failing.
   */
  await late.close();
  await waitFor(
    async () => (await ev(a, () => window.RR.net.peers.length)) === 1,
    8000,
    'A to notice C left'
  );
}

// ------------------------------------------------- 9. leaving, and no server

console.log('\nfailure modes');
await b.close();
const alone = await waitFor(
  async () => (await ev(a, () => window.RR.net.peers.length)) === 0,
  8000,
  "A to notice B left"
);
check('leaving removes the avatar', alone);

server?.kill();
await new Promise((r) => setTimeout(r, 700));

// A page with no ?room at all must not touch the network.
const solo = await context.newPage();
const soloErrors = [];
solo.on('pageerror', (e) => soloErrors.push(e.message));
const soloRequests = [];
// Vite's own HMR socket is a `websocket` event too, so match our path exactly.
solo.on('request', (r) => {
  if (r.url().includes('/api/')) soloRequests.push(r.url());
});
solo.on('websocket', (ws) => {
  if (ws.url().includes('/ws?')) soloRequests.push(ws.url());
});
await solo.goto(`${DEV_URL}/`, { waitUntil: 'load' });
await solo.waitForFunction(() => window.RR !== undefined, { timeout: 60_000 });
await enter(solo);
await ev(solo, async () => {
  const { attachMultiplayer } = await import('/src/net/index.js');
  window.RR.net = attachMultiplayer({
    scene: window.RR.scene,
    camera: window.RR.camera,
    controller: window.RR.controller,
    audio: window.RR.audio,
    hud: { toast: () => {} },
  });
  let last = performance.now();
  const step = () => {
    window.RR.net.update(Math.min(0.05, (performance.now() - last) / 1000));
    last = performance.now();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
});
await new Promise((r) => setTimeout(r, 2500));
const soloState = await ev(solo, () => ({
  status: window.RR.net.status,
  peers: window.RR.net.peers.length,
  running: window.RR.director.state !== undefined,
  gateGone: document.getElementById('gate').classList.contains('gone'),
}));
check('no ?room means no network traffic at all', soloRequests.length === 0, soloRequests.join(' '));
check('single-player is untouched and the gate opened', soloState.gateGone && soloState.running);
check('single-player throws nothing', soloErrors.length === 0, soloErrors.join(' | '));

// A page WITH a room but no server must fail quietly and keep playing.
const orphan = await context.newPage();
const orphanErrors = [];
orphan.on('pageerror', (e) => orphanErrors.push(e.message));
await orphan.goto(`${DEV_URL}/?room=${ROOM}`, { waitUntil: 'load' });
await orphan.waitForFunction(() => window.RR !== undefined, { timeout: 60_000 });
await enter(orphan);
await ev(orphan, async () => {
  const { attachMultiplayer } = await import('/src/net/index.js');
  window.RRTOASTS = [];
  window.RR.net = attachMultiplayer({
    scene: window.RR.scene,
    camera: window.RR.camera,
    controller: window.RR.controller,
    audio: window.RR.audio,
    hud: { toast: (t) => window.RRTOASTS.push(String(t)) },
  });
  let last = performance.now();
  const step = () => {
    window.RR.net.update(Math.min(0.05, (performance.now() - last) / 1000));
    last = performance.now();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
});
const gaveUp = await waitFor(
  async () => (await ev(orphan, () => window.RR.net.status)) === 'alone',
  25_000,
  'the client to give up on a dead server'
);
const orphanState = await ev(orphan, () => ({
  status: window.RR.net.status,
  toasts: window.RRTOASTS,
  frames: window.RR.director.state !== undefined,
  moved: window.RR.camera.position.y,
}));
check('a dead server ends in "alone", not a retry loop', gaveUp && orphanState.status === 'alone');
check('it says so exactly once, quietly', orphanState.toasts.length === 1, JSON.stringify(orphanState.toasts));
check('the game kept running the whole time', orphanState.frames && orphanErrors.length === 0, orphanErrors.join(' | '));

// ------------------------------------------------------------------- results

console.log('');
if (errors.length) {
  console.log(`console/page errors during the run (${errors.length}):`);
  for (const e of [...new Set(errors)]) console.log(`  ${e}`);
}
console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);

await browser.close();
server?.kill();
process.exit(failures === 0 ? 0 : 1);
