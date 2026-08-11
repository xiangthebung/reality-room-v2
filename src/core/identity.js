import { SUNRISE_PHASE, SUNSET_PHASE } from '../world/daylight.js';

/**
 * Who you are, and where you meant to arrive.
 *
 * The main menu writes this and the game reads it. Neither one imports the
 * other: the menu is loaded from index.html so it can paint before the world is
 * built, and main.js must not depend on a panel that may not exist. They meet
 * here, in a module singleton, which is exactly the arrangement `core/quality.js`
 * already uses to let the settings panel move knobs it knows nothing about.
 *
 *
 * THREE DIFFERENT LIFETIMES LIVE IN THIS FILE AND THEY ARE NOT INTERCHANGEABLE.
 *
 *   NAME and DYE are yours. They persist, because being asked to reinvent
 *   yourself every time you open a page is how a name stops meaning anything to
 *   the people you walk with.
 *
 *   ARRIVAL is a preference about this session's sky. It persists too, but it is
 *   applied exactly once, on the way in — see `arrivalOrigin`.
 *
 *   LOBBY is an intent, and it deliberately does NOT persist. A room code is a
 *   thing somebody read to you five minutes ago; remembering it across a reload
 *   would silently put you back in last night's room, which is the one piece of
 *   state here that can surprise another person rather than just you.
 *
 * Everything is stored under `rr.*` keys rather than in the settings registry's
 * one blob, because `quality.js` is about what the machine can afford and this is
 * about who is playing. Resetting your graphics should not rename you.
 */

/** The name key `net/index.js` has always used. Kept, so nobody is renamed by this change. */
const KEY_NAME = 'rr.name';
const KEY_HUE = 'rr.hue';
const KEY_ARRIVAL = 'rr.arrival';

/**
 * Nothing in this project is named by a person, so nor are the people.
 *
 * Moved here from `net/index.js`, which invented a name at module-evaluation
 * time and could therefore never see one the menu had just been given. The lists
 * are unchanged, so a returning player keeps the name they already had.
 */
const FIRST = ['quiet', 'green', 'far', 'low', 'slow', 'pale', 'deep', 'north', 'soft', 'lost'];
const SECOND = ['fern', 'moss', 'birch', 'alder', 'shale', 'thistle', 'heron', 'willow', 'ash', 'wren'];

/** Mirrors `sanitizeName` in server/rooms.js, which enforces its own copy. */
export const NAME_MAX_CHARS = 20;

/**
 * The dye chart.
 *
 * ONE NUMBER, NOT A PALETTE, AND THAT IS WHY THIS IS A LIST OF HUES RATHER THAN A
 * LIST OF COLOURS. `avatar.js` derives four colours from a single hue — body at
 * 34% saturation, limbs darker, hood down at 11% lightness so the silhouette
 * reads, aura bright and additive — and every one of those choices is defended at
 * length over there. Letting the menu hand over a finished colour would mean two
 * files with an opinion about what a person is made of, and the hood would be the
 * first thing to stop working.
 *
 * So the menu chooses a hue and the body is still dyed by the rules the body
 * already had. The names are the same register as the seed words and the invented
 * names: landscape and plants, nothing branded, nothing a person is called.
 */
export const DYES = [
  { id: 'rust', label: 'Rust', hue: 0.028 },
  { id: 'ochre', label: 'Ochre', hue: 0.097 },
  { id: 'straw', label: 'Straw', hue: 0.14 },
  { id: 'bracken', label: 'Bracken', hue: 0.19 },
  { id: 'fern', label: 'Fern', hue: 0.28 },
  { id: 'lichen', label: 'Lichen', hue: 0.42 },
  { id: 'teal', label: 'Teal', hue: 0.5 },
  { id: 'woad', label: 'Woad', hue: 0.58 },
  { id: 'slate', label: 'Slate', hue: 0.63 },
  { id: 'heather', label: 'Heather', hue: 0.73 },
  { id: 'thistle', label: 'Thistle', hue: 0.81 },
  { id: 'briar', label: 'Briar', hue: 0.95 },
];

/**
 * When to arrive, as a phase of the day — 0 is midnight and 0.5 is noon.
 *
 * Derived from `daylight.js`'s own sunrise and sunset rather than written as
 * literals, because that module's arc is a rotation of the authored sun about a
 * celestial pole and both boundaries fall out of the geometry: they are 0.213 and
 * 0.787 today, and an edit to the pole would move them. Literals here would drift
 * into "dusk" landing in broad daylight with nothing to say it had.
 *
 * The offsets are chosen against what you can SEE rather than against the
 * definition. Dusk is a little before the sun goes, because the interesting part
 * of a sunset is the last of the light coming through the trunks rather than the
 * moment the disc clears the horizon. Night is well clear of both boundaries, so
 * `whenever` is the only option that can put you at a horizon by accident.
 */
export const ARRIVALS = [
  { id: 'whenever', label: 'Whenever', phase: null, hint: 'Arrive at whatever hour the wood is having.' },
  { id: 'morning', label: 'Morning', phase: SUNRISE_PHASE + 0.075, hint: 'Early, with the light coming in low through the trunks.' },
  { id: 'midday', label: 'Midday', phase: 0.5, hint: 'The sun overhead and the shadows short.' },
  { id: 'dusk', label: 'Dusk', phase: SUNSET_PHASE - 0.02, hint: 'The last of the light. The fires are worth finding.' },
  { id: 'night', label: 'Night', phase: 0.94, hint: 'Full dark, a full moon, and fireflies.' },
];

/* -------------------------------------------------------------------------- */

/**
 * Private browsing, a disabled storage quota, a file:// origin — every one of
 * these throws rather than returning null, and none of them is a reason to
 * refuse to start a game. A session that cannot remember its name is a session
 * with a fresh name, which is the state every first-time player is in anyway.
 */
function read(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* see read() */
  }
}

/** A name, invented. Exported because the menu's dice button offers another one. */
export function inventName() {
  const first = FIRST[(Math.random() * FIRST.length) | 0];
  const second = SECOND[(Math.random() * SECOND.length) | 0];
  return `${first} ${second}`;
}

/**
 * A dye, at random.
 *
 * From the chart rather than from the whole circle, so that somebody who never
 * opens the menu still gets a colour that has a name — which matters the moment
 * they do open it and find the swatch they are already wearing lit up, rather
 * than a row of twelve unfamiliar colours and no indication of where they fit.
 */
export function inventHue() {
  return DYES[(Math.random() * DYES.length) | 0].hue;
}

/**
 * Names are cosmetic and never rendered as HTML, but they are rendered *to other
 * people*, so this is the client's half of `sanitizeName` in server/rooms.js.
 *
 * ADVISORY, LIKE EVERY CLIENT-SIDE SANITISER IN THIS PROJECT. The server keeps
 * its own copy because this one is a suggestion to anybody with devtools open.
 * What it buys is that the field cannot hold something the room will silently
 * refuse — a name that came back truncated or emptied would look like a bug in
 * the menu rather than like a rule.
 */
export function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    if (code >= 0x200b && code <= 0x200f) continue;
    if (code >= 0x2028 && code <= 0x202e) continue;
    if (code === 0xfeff) continue;
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX_CHARS);
}

/** A hue, wrapped into 0..1, or null if it was never a number. A phase is a circle. */
export function cleanHue(raw) {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(n)) return null;
  return ((n % 1) + 1) % 1;
}

/* -------------------------------------------------------------------------- */

/**
 * Chosen once per page, then held.
 *
 * The same discipline as `core/world-seed.js`: whatever a session decides about
 * itself, it decides at the first ask and never again, so that two callers can
 * never disagree about who is playing. Unlike the seed these are settable — the
 * menu is allowed to change your mind for you — but only through `setName` and
 * `setHue`, which write storage in the same breath.
 */
let name = null;
let hue = null;
let arrival = null;
/** The room the menu is about to put you in. Not persisted — see the header. */
let lobby = null;

export function playerName() {
  if (name === null) {
    name = cleanName(read(KEY_NAME));
    if (!name) {
      name = inventName();
      write(KEY_NAME, name);
    }
  }
  return name;
}

export function setPlayerName(raw) {
  const cleaned = cleanName(raw);
  if (!cleaned) return playerName();
  name = cleaned;
  write(KEY_NAME, cleaned);
  return cleaned;
}

export function playerHue() {
  if (hue === null) {
    hue = cleanHue(read(KEY_HUE));
    if (hue === null) {
      hue = inventHue();
      write(KEY_HUE, String(hue));
    }
  }
  return hue;
}

export function setPlayerHue(raw) {
  const cleaned = cleanHue(raw);
  if (cleaned === null) return playerHue();
  hue = cleaned;
  write(KEY_HUE, String(cleaned));
  return cleaned;
}

/** The nearest dye on the chart to a hue, so the menu can light the right swatch. */
export function dyeFor(h = playerHue()) {
  let best = DYES[0];
  let bestGap = Infinity;
  for (const dye of DYES) {
    // Round the circle the short way, or 0.98 and 0.02 look like opposite ends.
    const raw = Math.abs(dye.hue - h) % 1;
    const gap = Math.min(raw, 1 - raw);
    if (gap < bestGap) {
      bestGap = gap;
      best = dye;
    }
  }
  return best;
}

export function arrivalId() {
  if (arrival === null) {
    const stored = read(KEY_ARRIVAL);
    arrival = ARRIVALS.some((a) => a.id === stored) ? stored : 'whenever';
  }
  return arrival;
}

export function setArrivalId(id) {
  if (!ARRIVALS.some((a) => a.id === id)) return arrivalId();
  arrival = id;
  write(KEY_ARRIVAL, id);
  return id;
}

/**
 * The epoch shift that puts the chosen hour on the clock right now, or null for
 * "whenever".
 *
 * SHIFTS THE CYCLE RATHER THAN PINNING IT, and the difference is the whole
 * feature. `setDayPhase` freezes the sun where it is put, which is what a
 * screenshot script wants and the opposite of what a player asking for dusk
 * wants: they want to watch the light go, not to stand in a photograph of it.
 * `setDayOrigin` moves the epoch instead, so the day carries on turning at its
 * usual twenty minutes from wherever it has been set down.
 *
 * Derived from `daylight.js`'s own formula rather than duplicating it —
 * `phase = ((now - origin)/1000 * scale / CYCLE) mod 1` — solved for the origin
 * that makes `phase(now)` the number asked for. `scale` is 1 in every build that
 * ships and is read back through `dayScale()` so this is still right if the debug
 * panel has been playing with it.
 *
 * @param {number} nowMs the same clock `dayPhase` reads
 * @param {number} scale the day's speed multiplier, from `dayScale()`
 */
export function arrivalOrigin(nowMs, scale, cycleSeconds) {
  const entry = ARRIVALS.find((a) => a.id === arrivalId());
  if (!entry || entry.phase === null) return null;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return nowMs - (entry.phase * cycleSeconds * 1000) / scale;
}

/**
 * Where the menu is sending you: a normalised room code, or null for a walk on
 * your own.
 *
 * Read once by main.js on the way through the gate. Deliberately not consumed —
 * a second read must give the same answer, because `attachMultiplayer` and the
 * console both have reason to ask what room this session was aiming for.
 */
export function lobbyCode() {
  return lobby;
}

export function setLobbyCode(code) {
  lobby = typeof code === 'string' && code ? code : null;
  return lobby;
}
