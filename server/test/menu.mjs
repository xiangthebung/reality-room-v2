import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/**
 * The main menu, end to end.
 *
 * Lives under `server/test/` rather than `scripts/` because half of what it
 * checks is a wire and a room registry — a lobby code has to carry a forest
 * across two browsers — and it therefore needs a signalling server, which is the
 * same reason `two-player.mjs` and `two-social.mjs` live here.
 *
 *
 * WHAT IS ACTUALLY WORTH GATING HERE, IN ORDER OF WHAT IT WOULD COST TO GET
 * WRONG.
 *
 *   1. `#enter` still works on a bare click. Some thirty scripts in scripts/
 *      click it and diff pixels against a stored expectation. A menu that
 *      inserted anything into that path would fail all of them at once, in a way
 *      that looks like a rendering regression rather than like a new panel.
 *
 *   2. A typed code carries the wood. Two people in one room with two different
 *      seeds is the quietest bad state this project has: nothing errors, and the
 *      avatars walk through trees that are not there. The last check in here
 *      samples the height field on both machines, because that — not a message
 *      arriving — is the thing that has to be true.
 *
 *   3. A chosen dye reaches the wire, the body AND the chat log. `avatar.js`
 *      refuses nameplates, so the colour of a name in the log is the only thread
 *      tying a sentence to a person in a clearing. It used to be impossible for
 *      those two to disagree, because both computed `hueFromId` from the same id;
 *      the moment a dye could be chosen, it became possible.
 *
 *   4. The arrival hour stays inert under automation, for the same reason
 *      `core/world-seed.js` pins the seed and `core/quality.js` refuses the Auto
 *      governor: a subsystem that quietly varies between runs makes every visual
 *      test in the repo untrustworthy.
 *
 *
 * DRIVEN WITH SYNTHETIC CLICKS, AND THAT IS NOT A SHORTCUT. A few seconds after
 * load this page saturates its own main thread — the terrain streamer and the
 * frame loop — and Playwright's actionability polling starves, so a real
 * `page.click` starts taking seconds and then times out. Every script in
 * scripts/ works around it by clicking `#enter` in the first moment; a menu is
 * used for longer than that, so it dispatches its own events, exactly as
 * `scripts/fauna-audio.mjs` does.
 *
 * THE LAST SECTION MASKS `navigator.webdriver`, deliberately and only there. The
 * menu refuses to navigate under automation, so the two choices that can only
 * happen by loading the page again — changing woods, and being pulled into
 * somebody else's — are unreachable to a normal Playwright run. They are also
 * the two most valuable things on the panel, so that section launches a second
 * browser with automation control masked and asserts `navigator.webdriver` is
 * genuinely false before believing a word of what follows.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

/** Overridable for the same reason the other two are — see two-player.mjs. */
const DEV_URL = process.env.DEV_URL || 'http://127.0.0.1:5180';
const SERVER_PORT = Number(process.env.SIGNALLING_PORT) || Number(process.env.PORT) || 5181;

/** Explicit woods, so "did the code carry the forest" is a question with an answer. */
const HOST_WOOD = 'menu-check-host';
const GUEST_WOOD = 'menu-check-guest';

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

const GPU = ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
             '--autoplay-policy=no-user-gesture-required'];

const browser = await chromium.launch({ args: GPU });
const errors = [];

/**
 * A fresh CONTEXT per player, not a fresh page.
 *
 * The name and the dye live in localStorage and localStorage is per origin, so
 * two pages in one context are one person wearing two hats — which is exactly
 * the thing this file is trying to tell apart.
 */
async function open(where, url) {
  const context = await where.newContext({ viewport: { width: 900, height: 600 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${e}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.RRMainMenu) && window.RR !== undefined, null, {
    timeout: 60_000,
  });
  return page;
}

const click = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
const type = (page, sel, v) =>
  page.evaluate(
    ([s, val]) => {
      const el = document.querySelector(s);
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    [sel, v]
  );
const at = (page, sel, prop) =>
  page.evaluate(([s, p]) => document.querySelector(s)?.[p] ?? null, [sel, prop]);
const attr = (page, sel, a) =>
  page.evaluate(([s, k]) => document.querySelector(s)?.getAttribute(k), [sel, a]);

/** Wait for the code box to hold a real nine-character code. */
const CODE_RE = /^[a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3}$/;
const waitForCode = (page) =>
  page.waitForFunction(
    () => /^[a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3}$/.test(document.getElementById('menu-code').value),
    null,
    { timeout: 15_000 }
  );

async function enter(page) {
  await page.evaluate(() => document.getElementById('enter').click());
  await page.waitForSelector('#gate.gone', { timeout: 90_000 });
}

// ------------------------------------------------------------------ the panel

console.log('\nthe panel');
const solo = await open(browser, `${DEV_URL}/`);
check('the gate is up and #enter is still on it',
  await at(solo, '#enter', 'isConnected'));
const dyes = await solo.evaluate(() => document.querySelectorAll('#menu-dyes .menu-dye').length);
check('the dye chart is drawn', dyes === 12, `${dyes} swatches`);
const arrivals = await solo.evaluate(() => document.querySelectorAll('#menu-arrivals button').length);
check('the hours are drawn', arrivals === 5, `${arrivals} options`);
const lit = await solo.evaluate(() => document.querySelectorAll('#menu-dyes .menu-dye.on').length);
check('exactly one dye is lit, before anybody has chosen', lit === 1, String(lit));
check('a name is already in the box', (await at(solo, '#menu-name', 'value')).length > 0,
  await at(solo, '#menu-name', 'value'));
check('the wood box is this wood',
  (await at(solo, '#menu-seed', 'value')) === (await solo.evaluate(() => window.RR.seed)),
  await at(solo, '#menu-seed', 'value'));
check('no code is asked for while walking alone', await at(solo, '#menu-code-field', 'hidden'));

console.log('\nchoosing');
await type(solo, '#menu-name', 'lichen walker');
await click(solo, '#menu-dyes .menu-dye[data-dye="briar"]');
await click(solo, '#menu-arrivals button[data-arrival="dusk"]');
const stored = await solo.evaluate(() => ({
  name: localStorage.getItem('rr.name'),
  hue: localStorage.getItem('rr.hue'),
  arrival: localStorage.getItem('rr.arrival'),
}));
check('the name is remembered', stored.name === 'lichen walker', stored.name);
check('the dye is remembered', Math.abs(Number(stored.hue) - 0.95) < 1e-6, stored.hue);
check('the hour is remembered', stored.arrival === 'dusk', stored.arrival);
/**
 * The drawn figure has to follow the same recipe the wool does — see `_dye` in
 * avatar.js. A preview that showed one colour while the body wore another would
 * be worse than no preview, because the whole reason it exists is to answer
 * "what will they see".
 */
check('the drawn body took the dye', (await attr(solo, '#mav-torso', 'fill')) === 'hsl(342deg 34% 42%)',
  await attr(solo, '#mav-torso', 'fill'));
check('…and the hood is still the dark silhouette cue',
  (await attr(solo, '#mav-hood', 'fill')) === 'hsl(342deg 30% 11%)',
  await attr(solo, '#mav-hood', 'fill'));

console.log('\ngoing in');
await enter(solo);
check('a bare click still opens the gate', true);
const me = await solo.evaluate(() => window.RR.net.me);
check('the game knows who that was', me.name === 'lichen walker' && Math.abs(me.hue - 0.95) < 1e-6,
  JSON.stringify(me));
check('and nobody was dragged into a room they did not ask for',
  (await solo.evaluate(() => window.RR.net.status)) === 'off',
  await solo.evaluate(() => window.RR.net.status));
/**
 * Dusk was chosen and the sun must have ignored it, because this is a robot.
 * See the header, point 4.
 */
const phase = await solo.evaluate(() => window.RR.atmosphere.day.phase());
const authored = await solo.evaluate(() => window.RR.atmosphere.day.authoredPhase);
check('automation still gets the authored hour, whatever was chosen',
  Math.abs(phase - authored) < 1e-6, `${phase.toFixed(4)} vs ${authored.toFixed(4)}`);

// ------------------------------------------------------------------ two people

console.log('\na lobby, across two woods');
const host = await open(browser, `${DEV_URL}/?seed=${HOST_WOOD}`);
await type(host, '#menu-name', 'the host');
await click(host, '#menu-dyes .menu-dye[data-dye="rust"]');
await click(host, '#menu-company button[data-mode="host"]');
await waitForCode(host).catch(() => {});
const code = await at(host, '#menu-code', 'value');
check('a code was minted to give out', CODE_RE.test(code), code);
check('and it is shown, not editable', (await attr(host, '#menu-code', 'readonly')) !== null);
await enter(host);
await host.waitForFunction(() => window.RR.net.status === 'live', null, { timeout: 25_000 });
check('the URL became the invitation',
  host.url().includes(`room=${code}`) && host.url().includes(`seed=${HOST_WOOD}`), host.url());

const peek = await host.evaluate(
  async (c) => (await fetch(`/api/room/peek?room=${c}`, { cache: 'no-store' })).json(), code);
check('the room remembers which wood it is in', peek.seed === HOST_WOOD, JSON.stringify(peek));
check('and how many are standing in it', peek.here === 1, String(peek.here));

const guest = await open(browser, `${DEV_URL}/?room=${code}&seed=${peek.seed}`);
check('an invitation fills the menu in for you',
  (await guest.evaluate(() => window.RRMainMenu.mode)) === 'join');
await type(guest, '#menu-name', 'the guest');
await click(guest, '#menu-dyes .menu-dye[data-dye="teal"]');
await enter(guest);
await guest.waitForFunction(() => window.RR.net.peers.length > 0, null, { timeout: 25_000 });

const hostSees = (await host.evaluate(() => window.RR.net.peers))[0];
const guestSees = (await guest.evaluate(() => window.RR.net.peers))[0];
check('the host sees the guest by the name they typed', hostSees?.name === 'the guest', hostSees?.name);
check('and in the colour they picked', Math.abs((hostSees?.hue ?? 0) - 0.5) < 1e-6, String(hostSees?.hue));
check('the guest sees the host the same way',
  guestSees?.name === 'the host' && Math.abs((guestSees?.hue ?? 0) - 0.028) < 1e-6,
  `${guestSees?.name} / ${guestSees?.hue}`);

/**
 * Not the roster's opinion — the wool. Every colour worn by that body, one of
 * which has to be the host's rust. The first mesh in an avatar group is the
 * painted contact shadow and is flat black by construction, so "the first Mesh"
 * is the wrong question to ask.
 */
const worn = await guest.evaluate((id) => {
  const out = [];
  window.RR.scene.getObjectByName(`avatar:${id}`)?.traverse((o) => {
    if (o.material?.color?.getHexString) out.push(o.material.color.getHexString());
  });
  return out;
}, guestSees.id);
const rust = await guest.evaluate(() =>
  window.RR.atmosphere.fog.color.clone().setHSL(0.028, 0.34, 0.42, 'srgb').getHexString());
check('the body in the clearing is actually wearing it', worn.includes(rust),
  `${worn.join(' ')} — want ${rust}`);

console.log('\nchanging your mind while people are watching');
await host.evaluate(() => window.RR.net.identify({ name: 'renamed', hue: 0.63 }));
const followed = await guest
  .waitForFunction(() => {
    const p = window.RR.net.peers[0];
    return p && p.name === 'renamed' && Math.abs(p.hue - 0.63) < 1e-6;
  }, null, { timeout: 10_000 })
  .then(() => true)
  .catch(() => false);
check('the room was told', followed,
  JSON.stringify((await guest.evaluate(() => window.RR.net.peers))[0]?.name));

await host.evaluate(() => window.RR.net.say('over here'));
await guest
  .waitForFunction(
    () => [...document.querySelectorAll('#chat-log .chat-line')].some((n) =>
      n.textContent.includes('over here')),
    null, { timeout: 10_000 })
  .catch(() => {});
const inked = await guest.evaluate(() => {
  const el = [...document.querySelectorAll('#chat-log .chat-line')].find((n) =>
    n.textContent.includes('over here'));
  return el?.querySelector('b')?.style.color ?? '';
});
const wanted = await guest.evaluate(() => {
  const probe = document.createElement('span');
  probe.style.color = `hsl(${Math.round(0.63 * 360)}deg 52% 68%)`;
  document.body.append(probe);
  const v = getComputedStyle(probe).color;
  probe.remove();
  return v;
});
const flat = (c) => String(c).replace(/\s+/g, '');
check('the name in the log is drawn in the dye, not in a hash of the id',
  Boolean(inked) && flat(inked) === flat(wanted), `${inked} vs ${wanted}`);

await browser.close();

// ------------------------------------------------- the two page loads

/**
 * A second browser, with automation control masked, for the only two things the
 * menu does that a normal Playwright run cannot reach. See the header.
 */
console.log('\nthe choices that are a page load');
const free = await chromium.launch({ args: [...GPU, '--disable-blink-features=AutomationControlled'] });
const wanderer = await open(free, `${DEV_URL}/`);
const masked = (await wanderer.evaluate(() => navigator.webdriver)) === false;
check('automation is masked, so the menu is allowed to navigate', masked);

if (masked) {
  await wanderer.evaluate((wood) => {
    const el = document.getElementById('menu-seed');
    el.value = wood;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }, HOST_WOOD);
  const wentThere = await wanderer
    .waitForFunction((w) => location.search.includes(`seed=${w}`), HOST_WOOD, { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  check('naming a wood takes you to it', wentThere, wanderer.url());
  await wanderer.waitForFunction(() => window.RR !== undefined, null, { timeout: 60_000 });
  check('and the forest that gets built is that one',
    (await wanderer.evaluate(() => window.RR.seed)) === HOST_WOOD,
    await wanderer.evaluate(() => window.RR.seed));

  await wanderer.evaluate(() => document.querySelector('#menu-company button[data-mode="host"]').click());
  await waitForCode(wanderer).catch(() => {});
  const theirCode = await at(wanderer, '#menu-code', 'value');
  await enter(wanderer);
  await wanderer.waitForFunction(() => window.RR.net.status === 'live', null, { timeout: 25_000 });

  /**
   * The whole reason `Room.seed` and `/api/room/peek`'s seed field exist: a
   * person somewhere else entirely types nine characters and ends up on the same
   * ground. Nothing about this failure is loud, which is why it is checked by
   * sampling the height field rather than by watching a message arrive.
   */
  const stranger = await open(free, `${DEV_URL}/?seed=${GUEST_WOOD}`);
  check('the stranger starts somewhere else',
    (await stranger.evaluate(() => window.RR.seed)) === GUEST_WOOD,
    await stranger.evaluate(() => window.RR.seed));
  await stranger.evaluate(() => document.querySelector('#menu-company button[data-mode="join"]').click());
  await type(stranger, '#menu-code', theirCode);
  const carried = await stranger
    .waitForFunction((c) => location.search.includes(`room=${c}`), theirCode, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false);
  check('typing the code carries them to the host’s wood', carried, stranger.url());
  await stranger.waitForFunction(() => window.RR !== undefined, null, { timeout: 60_000 });
  check('they are standing in the host’s forest now',
    (await stranger.evaluate(() => window.RR.seed)) === HOST_WOOD,
    await stranger.evaluate(() => window.RR.seed));
  check('and the invitation joined them up with no second act of consent',
    (await stranger.evaluate(() => window.RR.net.room)) === theirCode,
    String(await stranger.evaluate(() => window.RR.net.room)));

  const ground = await Promise.all([wanderer, stranger].map((p) =>
    p.evaluate(async () => {
      const { heightAt } = await import('/src/world/terrain.js');
      return [heightAt(11, -23), heightAt(-40, 60), heightAt(77, 5)].map((n) => Math.round(n * 1000));
    })));
  check('and it is the same ground under both of them',
    JSON.stringify(ground[0]) === JSON.stringify(ground[1]),
    `${ground[0]} vs ${ground[1]}`);
}

await free.close();
server?.kill();

// -------------------------------------------------------------------- verdict

const real = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
check('nothing threw on any page', real.length === 0, real.slice(0, 3).join(' | '));

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : '\nPASS\n');
process.exit(failures ? 1 : 0);
