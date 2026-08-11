import { chromium } from 'playwright';

/**
 * The settings menu's pointer-lock handshake, driven the way the browser drives
 * it rather than the way the code hopes it does.
 *
 * Everything this file checks is one question: WHICH LOST POINTER LOCKS MEAN
 * "the player pressed Escape"? The menu has no other way to hear that key while
 * the pointer is locked — Chrome eats it — so it opens on `pointerlockchange`
 * instead, and every lock that dies for some other reason is a chance to open a
 * modal panel over the forest at a moment nobody asked for one.
 *
 * The reason this deserves its own check is the failure it is guarding: closing
 * the menu with Escape asks for the lock straight back, that request lands
 * inside Chrome's post-Escape cooldown, and Chrome sometimes grants it and then
 * revokes it a frame or two later. The revocation is a `pointerlockchange` with
 * nothing on it to distinguish it from a player's Escape, so the menu reopened
 * itself the instant it closed. It is intermittent by nature — it depends on
 * how far into the cooldown the relock falls — which makes it exactly the kind
 * of bug that comes back and is argued about rather than reproduced.
 *
 * The harness cannot summon Chrome's cooldown on demand, and `_relock` skips
 * `requestPointerLock` under webdriver anyway so the Playwright run can drive
 * the page at all. What it CAN do is stage the event sequence that cooldown
 * produces — lock granted, lock gone two frames later — and hold the menu to
 * the rule that makes it harmless: a lock nobody had time to look at was never
 * a lock the player broke.
 *
 * Run: node scripts/settings-check.mjs   (needs `npm run dev` on 5180)
 */

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// Deafen the page to HMR: a save landing mid-run reloads the world under a
// script that is halfway through a sequence, and the reload looks like a pass.
// See the same guard in debug-check.mjs.
await page.routeWebSocket(/.*/, () => {});

await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
/**
 * Wait for the gate to actually be gone, not for a plausible number of
 * milliseconds. It sits over the whole viewport until the shader warm-up
 * finishes, and it only stops hit-testing once it has `.gone` — so a click aimed
 * at the canvas before that lands on the ENTER button instead. Silently: no
 * error, no pointer lock, and a check that reports the browser cannot lock at
 * all when what actually happened is that it was never asked.
 */
await page.waitForFunction(() => document.getElementById('gate')?.classList.contains('gone'), { timeout: 60000 });
await page.waitForTimeout(600);

const failures = [];
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures.push(`${label}: expected ${expected}, got ${actual}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` (expected ${expected}, got ${actual})`}`);
  return ok;
}

const isOpen = () => page.evaluate(() => {
  const menu = window.RRSettingsMenu;
  const el = document.getElementById('settings');
  // Both, because they are two different lies: a menu that thinks it is closed
  // while its panel is still painted over the forest is as broken as the
  // reverse, and only one of them is visible in a screenshot.
  return menu.open && !el.hidden;
});

/**
 * Pointer lock, on purpose, from a real click.
 *
 * `requestPointerLock` needs a user gesture, which `page.evaluate` is not, so
 * the request lives in a click handler and Playwright sends a real click. The
 * hold time then decides which of the two sequences under test this is:
 *
 *   0   lock granted and dropped in the same turn — Chrome's revoke, staged
 *   N   lock held N ms and then dropped — a player pressing Escape
 */
await page.evaluate(() => {
  const canvas = document.getElementById('view');
  window.__hold = -1;
  window.__lockErr = null;
  canvas.addEventListener('click', () => {
    try {
      const r = canvas.requestPointerLock();
      if (r && typeof r.then === 'function') r.catch((e) => { window.__lockErr = String(e); });
    } catch (e) {
      window.__lockErr = String(e);
    }
  });
  // Registered after the menu's own listener, so the menu sees every change
  // first — the same order it sees in a real session.
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement || window.__hold < 0) return;
    if (window.__hold === 0) document.exitPointerLock();
    else setTimeout(() => document.exitPointerLock(), window.__hold);
  });
});

// The menu refuses to auto-open under webdriver so play-check and debug-check
// never get a modal panel dropped on them. This is the test that wants it.
await page.evaluate(() => { window.RRSettingsMenu.allowAutomationAutoOpen = true; });

const lockAndRelease = async (holdMs) => {
  await page.evaluate((ms) => { window.__hold = ms; }, holdMs);
  await page.mouse.click(640, 400);
  await page.waitForTimeout(holdMs + 400);
};

const canLock = await (async () => {
  await page.evaluate(() => { window.__hold = -1; });
  await page.mouse.click(640, 400);
  await page.waitForTimeout(300);
  return page.evaluate(() => document.pointerLockElement !== null);
})();

if (!canLock) {
  const why = await page.evaluate(() => window.__lockErr);
  console.log('\nthis browser would not grant a pointer lock, so none of this can be checked');
  console.log(`  ${why ?? 'no error reported'}`);
  await browser.close();
  process.exit(1);
}
await page.evaluate(() => document.exitPointerLock());
await page.waitForTimeout(400);
await page.evaluate(() => window.RRSettingsMenu.hide());
await page.waitForTimeout(300);

console.log('\na lock the player was using:');
await lockAndRelease(700);
check('losing it opens the menu', await isOpen(), true);

await page.evaluate(() => window.RRSettingsMenu.hide());
await page.waitForTimeout(400);

console.log('\na lock granted and revoked in the same breath:');
await lockAndRelease(0);
check('losing it leaves the menu shut', await isOpen(), false);

/**
 * And the reported symptom end to end: menu up, Escape, and the relock that
 * follows is refused after being granted.
 *
 * `_relock` is a no-op under webdriver, so the lock/revoke pair is staged here
 * in its place. Everything else is the real path — the real keypress, the real
 * close, the real listener deciding what the lock change meant.
 */
console.log('\nEscape with the relock refused after the fact:');
await lockAndRelease(700);
check('menu is up to begin with', await isOpen(), true);
await page.keyboard.press('Escape');
await page.waitForTimeout(120);
check('Escape closes it', await isOpen(), false);
await lockAndRelease(0);
check('and it stays closed', await isOpen(), false);

// Nothing above may have cost the menu its ordinary job.
console.log('\nthe menu still works:');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Escape opens it with no lock in play', await isOpen(), true);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Escape closes it again', await isOpen(), false);

/**
 * THE SHAPE OF THE PANEL, WHICH IS THE OTHER HALF OF "THE MENU WORKS".
 *
 * Everything above this line is about whether the panel appears at the right
 * moment. None of it would notice the panel appearing EMPTY — and it can,
 * because the pages are built by querying ids out of a template string, so a
 * page renamed in one of those two places and not the other produces a
 * `querySelector` that returns null, a section with nothing in it, and no error
 * anybody sees. It happened during the rewrite that added these tabs.
 *
 * So: every tab shows exactly one page, every page has controls on it, the
 * Advanced fold starts shut, and the controls reference is not empty. The
 * counts are floors rather than exact numbers on purpose — this must not fail
 * because somebody added a setting, only because a page stopped working.
 */
console.log('\nthe panel is not empty:');
await page.evaluate(() => window.RRSettingsMenu.show());
await page.waitForTimeout(150);

const shape = await page.evaluate(() => {
  const menu = window.RRSettingsMenu;
  const pages = [...document.querySelectorAll('.set-page')].map((p) => p.dataset.page);
  const perPage = {};
  for (const id of pages) {
    menu.showPage(id);
    const section = document.querySelector(`.set-page[data-page="${id}"]`);
    perPage[id] = {
      shown: !section.hidden,
      others: [...document.querySelectorAll('.set-page')].filter((p) => !p.hidden).length,
      controls: section.querySelectorAll('.set-row').length,
    };
  }
  return {
    tabs: document.querySelectorAll('.set-tab').length,
    pages,
    perPage,
    advancedShut: document.querySelector('.set-advanced')?.open === false,
    bindings: document.querySelectorAll('.set-keys-row').length,
    bindingGroups: document.querySelectorAll('.set-keys-head').length,
  };
});

check('there is a tab for every page', shape.tabs, shape.pages.length);
for (const [id, p] of Object.entries(shape.perPage)) {
  check(`${id} shows, and alone`, p.shown && p.others === 1, true);
  check(`${id} has controls on it`, p.controls > 0, true);
}
check('Advanced starts shut', shape.advancedShut, true);
check('the controls reference is populated', shape.bindings >= 15, true);
check('…and grouped', shape.bindingGroups >= 5, true);

/**
 * AND THE WORLD IS DEAF WHILE IT IS UP.
 *
 * The menu stops keys aimed at itself, which covers the case where it has
 * focus — and it focuses itself when it opens, so that is nearly always. What
 * it cannot cover is focus being somewhere else, and there the world was still
 * listening from underneath the dialog: `W` walked you off into trees you
 * could not see, `E` sat you on a log, `P` started sharing your screen. The
 * fix is `worldHearsKey` reading `body.settings-open`, and this is the test
 * that it is actually wired — dispatched at `document.body` on purpose,
 * because a key aimed at the panel proves nothing.
 */
const deaf = await page.evaluate(() => {
  const before = window.RR.controller.position.clone();
  document.body.focus();
  for (const code of ['KeyW', 'KeyE', 'KeyP']) {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
  }
  return {
    held: [...window.RR.controller.keys].length,
    moved: window.RR.controller.position.distanceTo(before),
  };
});
console.log('\nthe world does not hear keys through the panel:');
check('nothing is held down', deaf.held, 0);
check('and the body has not moved', deaf.moved < 0.01, true);
await page.evaluate(() => window.RRSettingsMenu.hide());

const noise = errors.filter((e) => !/pointer lock|pointerlock/i.test(e));
console.log(noise.length ? `\nERRORS:\n  ${noise.join('\n  ')}` : '\nno errors');
console.log(failures.length ? `\nFAILED (${failures.length})` : '\nPASS');
await browser.close();
process.exit(failures.length || noise.length ? 1 : 0);
