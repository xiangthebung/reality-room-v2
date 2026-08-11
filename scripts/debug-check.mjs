import { chromium } from 'playwright';

/**
 * Exercise the debug panel the way a person would: open it with the backtick,
 * click each phase button, drag the hold slider, flip each effect toggle, and
 * confirm the world actually reacts. A debug panel that silently stopped
 * driving the director would be the most expensive possible bug, because every
 * subsequent tuning decision would be made against a lie.
 */
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

/**
 * Deafen the page to hot reloads before it loads.
 *
 * Vite pushes HMR updates over a websocket, and a save landing mid-run
 * re-evaluates modules under a script that is halfway through a measurement.
 * The failure is silent and total: a reloaded page has no console problems, so
 * a check can screenshot the splash screen twelve times and report success.
 * This cost several runs during the multi-agent work of 2026-08-09, including
 * one false negative on this very file. Nothing here needs a websocket for any
 * other reason — multiplayer is opt-in on a key press.
 */
await page.routeWebSocket(/.*/, () => {});

await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(1500);

const read = () => page.evaluate(() => {
  const d = window.RR.director;
  return {
    phase: d.state.phase.id,
    level: Number(d.eased.toFixed(3)),
    uLevel: Number(window.RR.tripUniforms.uLevel.value.toFixed(3)),
    melt: Number(window.RR.tripUniforms.uFlow.value.toFixed(3)),
    visible: window.RR.debug.visible,
  };
});

console.log('closed at start:', !(await read()).visible);
await page.keyboard.press('Backquote');
await page.waitForTimeout(200);
console.log('opens with backtick:', (await read()).visible);

for (const id of ['comeup', 'onset', 'peak', 'egodeath', 'comedown', 'sober']) {
  const btn = page.locator('#dbg-phases button', { hasText: new RegExp(`^${id}$`) });
  await btn.click();
  await page.waitForTimeout(700);
  const s = await read();
  console.log(`  ${id.padEnd(9)} -> phase ${s.phase.padEnd(9)} level ${s.level}  melt ${s.melt}`);
}

// Bracket keys step phases.
await page.evaluate(() => window.RR.director.seek(80));
await page.keyboard.press('BracketRight');
await page.waitForTimeout(400);
console.log('] steps to:', (await read()).phase);
await page.keyboard.press('BracketLeft');
await page.waitForTimeout(400);
console.log('[ steps to:', (await read()).phase);

// Hold pins the envelope.
await page.evaluate(() => {
  const el = document.querySelector('#dbg-hold');
  el.value = '0.65';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(1200);
const held = await read();
console.log('hold 0.65 ->', held.level, '(override', await page.evaluate(() => window.RR.director.state.override), ')');

// Toggles.
for (const label of ['world', 'melt', 'morph', 'view', 'camera', 'colour', 'audio', 'bloom']) {
  await page.locator('#dbg-toggles button', { hasText: new RegExp(`^${label}$`) }).click();
}
await page.waitForTimeout(600);
const off = await page.evaluate(() => ({
  ...window.RR.director.switches,
  bloom: window.RR.pipeline.bloomEnabled,
  uFlow: window.RR.tripUniforms.uFlow.value,
  uLevel: window.RR.tripUniforms.uLevel.value,
}));
console.log('all off ->', JSON.stringify(off));
for (const label of ['world', 'melt', 'morph', 'view', 'camera', 'colour', 'audio', 'bloom']) {
  await page.locator('#dbg-toggles button', { hasText: new RegExp(`^${label}$`) }).click();
}
await page.waitForTimeout(400);

// Speed multiplier freezes / accelerates the trip clock only.
await page.evaluate(() => {
  const el = document.querySelector('#dbg-speed');
  el.value = '0';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  window.RR.director.state.override = null;
  window.RR.director.seek(120);
});
const t0 = await page.evaluate(() => window.RR.director.state.time);
await page.waitForTimeout(1500);
const t1 = await page.evaluate(() => window.RR.director.state.time);
console.log(`speed 0 freezes clock: ${t0.toFixed(1)} -> ${t1.toFixed(1)}`);

/* -------------------------------------------------------------------------- */
/* the other four pages                                                        */
/* -------------------------------------------------------------------------- */

/**
 * THE HALF OF THIS PANEL THAT IS NOT THE TRIP.
 *
 * Everything above drives the director, which is what the panel was for when it
 * had one page. It now has five, and the three properties worth a gate are the
 * ones that have already gone wrong once each in this project:
 *
 *   A CONTROL WITH TWO FACES MUST NOT DISAGREE. The render scale is owned by the
 *   quality registry and the settings menu draws it too; the version of this
 *   slider that wrote main.js's private variable left the menu reading 1.00×
 *   while the renderer was at 0.60, and every perf number taken afterwards was
 *   against an unknown resolution.
 *
 *   A CONTROL THAT CANNOT MATTER MUST SAY SO. Nearly every number in the panel is
 *   a ceiling multiplied by the trip level, so at level 0 dragging one changes
 *   nothing — which taught people the knobs were broken. The captions are the
 *   feature; a caption that stopped appearing would be invisible.
 *
 *   A COUNTER MUST DESCRIBE WHAT IT NAMES. `renderer.info` is reset on every
 *   `render()` call and the pipeline makes eight, so anything reading it after
 *   the frame reports the output quad: 1 draw, 2 triangles, forever. Five
 *   scripts in this repository have printed that number and believed it.
 */
const fails = [];
const check = (label, ok, detail = '') => {
  if (!ok) fails.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail && !ok ? ` (${detail})` : ''}`);
};
/**
 * Reach a row by its schema id rather than by its label — a label is the one
 * part of a control that is allowed to be reworded, and this file should not
 * fail because somebody improved a caption.
 */
const rowState = (id) =>
  page.evaluate((rowId) => {
    const el = [...document.querySelectorAll('.dbg-row')].find((r) => r.dataset.id === rowId);
    if (!el) return null;
    return {
      dead: el.classList.contains('dead'),
      disabled: Boolean(el.querySelector('input, button')?.disabled),
      why: el.querySelector('.dbg-why')?.textContent ?? '',
      value: el.querySelector('input')?.value ?? el.querySelector('.dbg-val')?.textContent ?? '',
    };
  }, id);
/** Drag a row's slider, the way the panel's own `input` listener hears it. */
const setRow = (id, value) =>
  page.evaluate(
    ([rowId, v]) => {
      const el = [...document.querySelectorAll('.dbg-row')].find((r) => r.dataset.id === rowId);
      const input = el?.querySelector('input');
      if (!input) return false;
      input.value = String(v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    [id, value]
  );
/** Click a row's only button — the toggles are one button per row. */
const pressRow = (id) =>
  page.evaluate((rowId) => {
    const el = [...document.querySelectorAll('.dbg-row')].find((r) => r.dataset.id === rowId);
    const button = el?.querySelector('button');
    button?.click();
    return Boolean(button);
  }, id);
const showTab = (n) => page.evaluate((i) => document.querySelectorAll('#dbg-tabs button')[i].click(), n);

// The panel is still open from the block above, and it has to stay open: it
// re-reads its rows on a timer and skips the work entirely while hidden, so
// every assertion below about what a row SAYS needs it on screen.
console.log('\nevery page has something on it:');
for (let i = 0; i < 5; i++) {
  await showTab(i);
  await page.waitForTimeout(250);
  const seen = await page.evaluate(() => ({
    tab: document.querySelectorAll('#dbg-tabs button.on')[0]?.textContent,
    rows: document.querySelectorAll('.dbg-section:not([hidden]) .dbg-row').length,
    buttons: document.querySelectorAll('.dbg-section:not([hidden]) .dbg-grid button').length,
  }));
  check(`${seen.tab} draws controls`, seen.rows > 0 && seen.rows + seen.buttons > 3, JSON.stringify(seen));
}

console.log('\na control that cannot matter says why:');
await showTab(0);
await page.evaluate(() => {
  // The speed slider is still at 0 from the block above, and the eased level is
  // integrated with the trip's own dt — so a frozen clock means `ground()`
  // leaves the world exactly where it was, for ever. Correct behaviour, and the
  // reason this line exists.
  window.RR.debug.speed = 1;
  window.RR.director.state.override = null;
  window.RR.director.ground();
});
await page.waitForTimeout(1400);
const sober = await rowState('gain.glow');
check('a trip gain is dead while sober', sober.dead && sober.disabled, JSON.stringify(sober));
check('…and says so', /sober/.test(sober.why), sober.why);
await page.evaluate(() => {
  window.RR.director.seek(240);
  window.RR.director.state.override = 1;
});
await page.waitForTimeout(900);
check('and comes back at full intensity', (await rowState('gain.glow')).dead === false);

console.log('\nthe shared controls have one face:');
await showTab(1);
await page.waitForTimeout(250);
await page.evaluate(() => {
  const el = document.querySelector('#dbg-scale');
  el.value = '0.7';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(300);
check(
  'render scale goes through the registry',
  (await page.evaluate(() => window.RRSettings.get('renderScale'))) === 0.7
);
await page.evaluate(() => window.RRSettings.setMode('high'));
await page.waitForTimeout(300);
check(
  '…and a preset click moves the slider back',
  (await page.evaluate(() => document.querySelector('#dbg-scale').value)) === '1'
);

const scene = await page.evaluate(() => ({
  pass: window.RR.pipeline.sceneStats.calls,
  afterFrame: window.RR.renderer.info.render.calls,
}));
check(
  'the frame readout counts the world, not the output quad',
  scene.pass > 10 && scene.pass !== scene.afterFrame,
  JSON.stringify(scene)
);

console.log('\nthe world page drives the world:');
await showTab(2);
await page.waitForTimeout(250);
const windFrom = await page.evaluate(() => window.RR.tripUniforms.uWind.value.x);
await setRow('w.wind', 0);
await page.waitForTimeout(700);
const windTo = await page.evaluate(() => window.RR.tripUniforms.uWind.value.x);
check('wind rate 0 holds the wind clock', Math.abs(windTo - windFrom) < 0.02, `${windFrom} -> ${windTo}`);
await setRow('w.wind', 1);

const wasAt = await page.evaluate(() => window.RR.controller.position.y);
await pressRow('b.fly');
await page.evaluate(() => window.RR.controller.keys.add('Space'));
await page.waitForTimeout(700);
await page.evaluate(() => window.RR.controller.keys.delete('Space'));
const flewTo = await page.evaluate(() => window.RR.controller.position.y);
check('fly leaves the ground', flewTo - wasAt > 2, `${wasAt.toFixed(1)} -> ${flewTo.toFixed(1)}`);
await page.waitForTimeout(500);
check(
  '…and the camera clamp does not drag it back',
  (await page.evaluate(() => window.RR.camera.position.y)) > flewTo - 1
);
await pressRow('b.fly');
await page.waitForTimeout(1000);
check(
  'and switching it off drops you',
  (await page.evaluate(() => window.RR.controller.position.y)) < flewTo - 1
);

console.log('\nthe layer grid is the probe:');
await showTab(4);
await page.waitForTimeout(300);
/**
 * Click a layer button and read the answer in the SAME evaluation.
 *
 * Not a wait, deliberately. The culler repacks the instanced layers every frame
 * and writes `visible` as it goes, so a slab hidden by hand is shown again as
 * soon as the camera moves — which is true of `RR.probe.show` from the console
 * too, and is why bisecting a layer is something you do standing still. Reading
 * before the next frame tests the button rather than the culler.
 */
const clickLayer = (label, shift = false) =>
  page.evaluate(
    ([text, withShift]) => {
      const grid = [...document.querySelectorAll('.dbg-row')].find((r) => r.dataset.id === 'l.grid');
      const b = [...(grid?.querySelectorAll('button') ?? [])].find((x) => x.textContent === text);
      if (!b) return null;
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: withShift }));
      const state = (name) => window.RR.probe.layers[name]().map((o) => o.visible);
      return { leaves: state('leaves'), trunks: state('trunks'), grass: state('grass') };
    },
    [label, shift]
  );
const hidden = await clickLayer('leaves');
check('the grid was built', hidden !== null);
check('a layer button hides its layer', hidden?.leaves.every((v) => v === false), JSON.stringify(hidden?.leaves));
const soloed = await clickLayer('trunks', true);
check(
  'shift-click solos one',
  soloed?.trunks.some((v) => v) && soloed?.grass.every((v) => v === false)
);
await page.evaluate(() => window.RR.probe.reset());
await page.waitForTimeout(200);

/* -------------------------------------------------------------------------- */
/* pause, and the sound presets                                                */
/* -------------------------------------------------------------------------- */

/**
 * WHAT PAUSE HAS TO STOP, AND WHAT IT MUST NOT.
 *
 * `time` is where in the five minutes you are; `clock` is the free-running one
 * every generator in the trip rides on. Stopping both is what the speed slider
 * at 0 already does, and it makes a trip that is not worth listening to: no
 * surges arrive, the breath holds still, the audio's sparks never fire. So this
 * asserts the pair — one frozen, the other running — rather than "the trip
 * stopped", which both behaviours satisfy.
 *
 * The third assertion is the reason the feature exists. Held at ego death with
 * the clock running, `time` walks out of the phase and off the end, `end()`
 * clears the override on the way past, and a tuning session that was standing at
 * full intensity is standing in a sober wood a few minutes later.
 */
console.log('\npause stops the trip and nothing else:');
await showTab(0);
await page.evaluate(() => {
  window.RR.debug.speed = 1;
  window.RR.director.state.override = null;
  window.RR.director.seek(220); // the middle of ego death
  window.RR.director.pause(true);
});
const p0 = await page.evaluate(() => ({
  time: window.RR.director.state.time,
  clock: window.RR.director.state.clock,
  dissolve: window.RR.director.state.dissolve,
}));
await page.waitForTimeout(1600);
const p1 = await page.evaluate(() => ({
  time: window.RR.director.state.time,
  clock: window.RR.director.state.clock,
  dissolve: window.RR.director.state.dissolve,
  phase: window.RR.director.state.phase.id,
  level: window.RR.director.eased,
}));
check('the trip clock is frozen', Math.abs(p1.time - p0.time) < 0.05, `${p0.time.toFixed(2)} -> ${p1.time.toFixed(2)}`);
check(
  '…and the free-running clock is not',
  p1.clock - p0.clock > 0.9,
  `${p0.clock.toFixed(2)} -> ${p1.clock.toFixed(2)}`
);
check('…so the phase and the dissolve hold', p1.phase === 'egodeath' && Math.abs(p1.dissolve - p0.dissolve) < 0.02,
  `${p1.phase} dissolve ${p0.dissolve.toFixed(3)} -> ${p1.dissolve.toFixed(3)}`);
check('…and the level stays at the peak', p1.level > 0.9, String(p1.level.toFixed(3)));
// The K key is the same switch, and the footer says so.
await page.keyboard.press('KeyK');
await page.waitForTimeout(250);
check('K releases it', (await page.evaluate(() => window.RR.director.paused)) === false);
await page.keyboard.press('KeyK');
await page.waitForTimeout(250);
check('…and takes it again', (await page.evaluate(() => window.RR.director.paused)) === true);
check(
  'the footer says the trip is not moving',
  /paused/.test(await page.evaluate(() => document.getElementById('dbg-foot').textContent))
);
// A trip that has ended cannot be paused — the button would otherwise claim to
// be holding something that is not running.
await page.evaluate(() => window.RR.director.ground());
await page.waitForTimeout(300);
check('grounding releases it', (await page.evaluate(() => window.RR.director.paused)) === false);
check('and it cannot be taken while sober', (await page.evaluate(() => window.RR.director.pause(true))) === false);

/**
 * THE PRESETS, AND THE ONE PROPERTY THAT MAKES THEM WORTH HAVING.
 *
 * A preset sets every knob in its bank, including the ones it does not name, so
 * that two clicks in a row compare two presets rather than one preset with the
 * sediment of the other. That is asserted here by moving a knob the second
 * preset does not mention and checking it goes home.
 *
 * The banks must also be independent: clicking through the trip presets while
 * judging the bass would be worthless if it moved the bass.
 */
console.log('\nthe sound presets:');
await showTab(3);
await page.waitForTimeout(250);
const soundState = () => page.evaluate(() => ({
  tuning: window.RR.tuning.toJSON(),
  active: window.RR.presets.activeIds(),
}));
const clickPreset = (bank, label) =>
  page.evaluate(
    ([b, text]) => {
      const grid = [...document.querySelectorAll('.dbg-row')].find((r) => r.dataset.id === `p.${b}`);
      const button = [...(grid?.querySelectorAll('button') ?? [])].find((x) => x.textContent === text);
      button?.click();
      return Boolean(button);
    },
    [bank, label]
  );

check('the banks cover every knob', (await page.evaluate(() => window.RR.presets.UNBANKED)).length === 0,
  (await page.evaluate(() => window.RR.presets.UNBANKED)).join(', '));
check('a preset button exists', await clickPreset('record', 'heavy'));
await page.waitForTimeout(200);
const heavy = await soundState();
check('clicking it moves the knobs', heavy.tuning.lowMax > 3, `lowMax ${heavy.tuning.lowMax}`);
check('…and the button knows it is on', heavy.active.record === 'heavy', JSON.stringify(heavy.active));
check(
  '…which the panel draws',
  await page.evaluate(() => {
    const grid = [...document.querySelectorAll('.dbg-row')].find((r) => r.dataset.id === 'p.record');
    return [...grid.querySelectorAll('button.on')].map((b) => b.textContent).join(',') === 'heavy';
  })
);
// A knob `flat` does not name, moved by hand, must still go home when it is
// clicked — the whole point of a bank being set as a whole.
await page.evaluate(() => window.RR.tuning.set('harmDrive', 3.4));
check('one slider leaves the preset', (await soundState()).active.record === null);
await clickPreset('record', 'flat');
await page.waitForTimeout(200);
const flat = await soundState();
check('the next preset sets the knobs it does not name', flat.tuning.harmDrive === 1.65, `harmDrive ${flat.tuning.harmDrive}`);
check('…and lights up', flat.active.record === 'flat', JSON.stringify(flat.active));

const beforeTrip = (await soundState()).tuning;
await clickPreset('trip', 'microscope');
await page.waitForTimeout(200);
const withTrip = await soundState();
check('the trip bank moves its own knobs', withTrip.tuning.scopeMax > 1, `scopeMax ${withTrip.tuning.scopeMax}`);
check(
  '…and leaves the record bank alone',
  ['lowMax', 'subMax', 'harmMax', 'harmDrive', 'hallMax', 'dryMix', 'wetMix'].every(
    (id) => withTrip.tuning[id] === beforeTrip[id]
  ),
  JSON.stringify({ was: beforeTrip.lowMax, now: withTrip.tuning.lowMax })
);
check('both banks are named together', withTrip.active.record === 'flat' && withTrip.active.trip === 'microscope',
  JSON.stringify(withTrip.active));
check(
  'the panel reports the pair',
  /flat/.test((await rowState('a.preset')).value) && /microscope/.test((await rowState('a.preset')).value),
  (await rowState('a.preset')).value
);
await page.evaluate(() => window.RR.tuning.reset());
await page.waitForTimeout(200);
check('reset puts both back on the shipping sound',
  (await soundState()).active.record === 'shipping' && (await soundState()).active.trip === 'shipping');

/**
 * THE SEARCH, WHICH IS THE PART A PERSON WILL ACTUALLY USE.
 *
 * Fourteen presets cannot cover a twenty-dimensional space, so the panel offers
 * five neighbours of wherever you are and narrows the neighbourhood each time
 * you keep one. Four things have to hold or it is a random number generator with
 * a nice label:
 *
 *   the five are genuinely different from the centre and from each other;
 *   `current` gets you back to the reference, or there is no A/B;
 *   `keep` re-centres on WHAT YOU HEARD and narrows;
 *   nothing inaudible moves — the cabinet knobs with no pasted link playing.
 */
console.log('\nthe search:');
await showTab(3);
await page.waitForTimeout(250);
const explore = (label) =>
  page.evaluate((text) => {
    const grid = [...document.querySelectorAll('.dbg-row')].find((r) => r.dataset.id === 'e.actions');
    const b = [...(grid?.querySelectorAll('button') ?? [])].find((x) => x.textContent === text);
    b?.click();
    return Boolean(b);
  }, label);
const candidate = (n) =>
  page.evaluate((i) => {
    const grid = [...document.querySelectorAll('.dbg-row')].find((r) => r.dataset.id === 'e.candidates');
    const b = grid?.querySelectorAll('button')[i];
    b?.click();
    return b?.textContent ?? null;
  }, n);
const searchState = () =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('.dbg-row')].find((r) => r.dataset.id === 'e.state');
    return el?.querySelector('.dbg-val')?.textContent ?? '';
  });

await page.evaluate(() => {
  window.RR.tuning.reset();
  document.querySelectorAll('[data-id="e.bank"] button').forEach((b) => {
    if (b.textContent === 'trip') b.click();
  });
});
check('explore starts', await explore('explore'));
await page.waitForTimeout(250);
const round1 = await searchState();
check('…and says where it is', /round 1/.test(round1), round1);

const centre = await page.evaluate(() => window.RR.tuning.toJSON());
const heard = [];
for (let i = 1; i <= 5; i++) {
  const label = await candidate(i);
  await page.waitForTimeout(120);
  heard.push({ label, values: await page.evaluate(() => window.RR.tuning.toJSON()) });
}
check('all five have a name', heard.every((h) => h.label && h.label !== '–'), heard.map((h) => h.label).join(' | '));
check(
  '…and no two share it',
  new Set(heard.map((h) => h.label)).size === 5,
  heard.map((h) => h.label).join(' | ')
);
check(
  'each one is audibly different from the centre',
  heard.every((h) => Object.keys(centre).some((id) => h.values[id] !== centre[id]))
);
/**
 * The knobs that only exist for a pasted link. Nothing is streaming in this run,
 * so the search must leave all seven exactly where they are — a candidate you
 * provably cannot hear is worse than a bad one, because a bad one at least tells
 * you something.
 */
const linkOnly = await page.evaluate(() => window.RR.presets.LINK_ONLY);
check(
  'nothing inaudible moved',
  heard.every((h) => linkOnly.every((id) => h.values[id] === centre[id])),
  linkOnly.join(', ')
);
check(
  'the search stays inside its own bank',
  heard.every((h) =>
    ['lowMax', 'subMax', 'harmMax', 'hallMax', 'lowCorner'].every((id) => h.values[id] === centre[id])
  )
);

await candidate(0); // `current`
await page.waitForTimeout(200);
check(
  'current goes back to the reference',
  await page.evaluate((c) => {
    const now = window.RR.tuning.toJSON();
    return Object.keys(c).every((id) => now[id] === c[id]);
  }, centre)
);

// Keep the last one heard: the centre must become THAT, and the search narrow.
const wanted = heard[4].values;
await candidate(5);
await page.waitForTimeout(150);
await explore('keep');
await page.waitForTimeout(250);
const round2 = await searchState();
check('keep moves to round 2', /round 2/.test(round2), round2);
check(
  '…narrowing the neighbourhood',
  Number(round1.match(/spread (\d+)%/)[1]) > Number(round2.match(/spread (\d+)%/)[1]),
  `${round1} -> ${round2}`
);
check(
  '…centred on what you were listening to',
  await page.evaluate((w) => {
    const now = window.RR.tuning.toJSON();
    return Object.keys(w).every((id) => now[id] === w[id]);
  }, wanted)
);
await explore('undo');
await page.waitForTimeout(250);
check('undo walks it back', /round 1/.test(await searchState()));
check(
  '…and puts the knobs back with it',
  await page.evaluate((c) => {
    const now = window.RR.tuning.toJSON();
    return Object.keys(c).every((id) => now[id] === c[id]);
  }, centre)
);
// A centre taken from the other bank is meaningless, so switching abandons it.
await page.evaluate(() =>
  document.querySelectorAll('[data-id="e.bank"] button').forEach((b) => {
    if (b.textContent === 'record') b.click();
  })
);
await page.waitForTimeout(250);
check('changing bank abandons the search', /not started/.test(await searchState()), await searchState());
await page.evaluate(() => window.RR.tuning.reset());

console.log('\nsearch reaches the pages you are not on:');
await showTab(0);
await page.evaluate(() => {
  const f = document.getElementById('dbg-filter');
  f.value = 'shadow';
  f.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(250);
const hits = await page.evaluate(() =>
  [...document.querySelectorAll('.dbg-section:not([hidden]) .dbg-row:not([hidden])')].map(
    (r) => r.dataset.id ?? r.querySelector('label')?.textContent
  )
);
check('a Render knob is findable from Trip', hits.some((h) => /shadow/i.test(h ?? '')), hits.join(', '));
await page.evaluate(() => {
  const f = document.getElementById('dbg-filter');
  f.value = '';
  f.dispatchEvent(new Event('input', { bubbles: true }));
});

await page.keyboard.press('Backquote');
await page.waitForTimeout(200);
console.log('\ncloses with backtick:', !(await read()).visible);

console.log(errors.length ? `\nERRORS:\n  ${errors.join('\n  ')}` : '\nno errors');
console.log(fails.length ? `\nFAILED (${fails.length})\n  ${fails.join('\n  ')}` : '\nPASS');
await browser.close();
process.exit(fails.length ? 1 : 0);
