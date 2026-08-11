/**
 * Which world you are standing in.
 *
 * One string, chosen once, before anything is built. Everything downstream —
 * the height field, the ridge, the stream, the scatter of every tree and blade
 * of grass — is a pure function of it, so this module is the only place that
 * decides what world a session gets.
 *
 *
 * WHY THIS IS NOT SIMPLY `Math.random()`.
 *
 * Three constituencies want different things from the same value and all three
 * are right:
 *
 *   A PLAYER wants a new wood every time. That is the whole point of the change
 *   — a world you have already walked through is a level, and this is supposed
 *   to be a place you have never been.
 *
 *   A SECOND PLAYER, arriving through an invite link, must get the SAME wood.
 *   Two people in one room standing in two different forests is not a
 *   multiplayer bug you can paper over — their avatars would walk through each
 *   other's trees and stand at different heights on the same coordinates.
 *
 *   EVERY SCRIPT IN scripts/ wants the world it had yesterday. Fifteen of them
 *   drive the real page and diff pixels or milliseconds against a stored
 *   expectation. A random world per load turns all of them into noise
 *   generators, and — worse — the failures would look like rendering bugs
 *   rather than like a seed that moved.
 *
 * So: an explicit `?seed=` wins over everything, automation gets the historical
 * fixed seed, and a human with a clean URL gets a new wood. The automation
 * clause follows the precedent already set in `core/quality.js`, where the Auto
 * governor refuses to run under `navigator.webdriver` for exactly this reason —
 * a subsystem that quietly varies between runs makes every visual test in the
 * repo untrustworthy, so the convention is that automation pins it.
 *
 *
 * THE MULTIPLAYER HALF IS NOT SYMMETRIC, AND THAT IS WHY THE SEED IS IN THE URL
 * RATHER THAN DERIVED FROM THE ROOM CODE.
 *
 * Deriving the seed from the room code is the obvious design and it cannot
 * work, because of WHEN a room code exists. Rooms are minted lazily: nothing
 * touches the network until somebody presses J, and by then the forest has been
 * built for several minutes. The host's world therefore predates their room
 * code, so a room-derived seed would be a world the host is not in.
 *
 * The invite link carries the host's ACTUAL seed instead — see `inviteUrl` in
 * net/index.js — which makes the guest's `?seed=` clause above the thing that
 * synchronises them. It also means the link is a complete description of where
 * you are: the room says who, the seed says where.
 */

import { hashString } from './util.js';

/** What the world was before it could be anything else. Every script assumes it. */
export const DEFAULT_SEED = 'grove-01';

/** Chosen once, on first ask, and then never again for the life of the page. */
let chosen = null;

function fromUrl() {
  try {
    const raw = new URLSearchParams(location.search).get('seed');
    if (!raw) return null;
    // Trimmed and length-capped, not validated: any string is a legal seed —
    // it goes through FNV-1a before anything numeric happens to it — so there
    // is nothing to reject, only something to bound. A megabyte of query string
    // hashing on the critical path is the only real failure mode here.
    const seed = raw.trim().slice(0, 64);
    return seed.length ? seed : null;
  } catch {
    // No `location`, or a document with an opaque origin. Not a reason to fail.
    return null;
  }
}

/**
 * A seed a person could read down a telephone.
 *
 * Two short words and a number rather than a hex blob, because this string ends
 * up in an invite link and in the chat log when somebody types `/seed`, and
 * "pale-thistle-4471" survives being retyped in a way that "0x8f3ac1e2" does
 * not. The vocabulary is
 * the same register as the invented player names in net/index.js; nothing in
 * this project is named by a person, so nor are the woods.
 */
const FIRST = ['ash', 'briar', 'fen', 'holt', 'marl', 'quill', 'sorrel', 'tarn', 'vale', 'yarrow'];
const SECOND = ['hollow', 'thicket', 'combe', 'reach', 'stand', 'copse', 'mire', 'brake', 'scarp', 'glade'];

/**
 * Another wood, named.
 *
 * Exported so the main menu can offer one without reaching for the private
 * generator or — worse — inventing its own naming scheme, which is how you end
 * up with two vocabularies for the same thing and a seed that reads like a
 * different kind of value depending on where it came from.
 *
 * Note that this does NOT change the wood you are standing in. Nothing can:
 * everything in the world is built from `worldSeed()` during module evaluation,
 * so a new seed is a new page, and the menu takes you there by navigating rather
 * than by trying to rebuild a forest around you.
 */
export function inventSeed() {
  const a = FIRST[Math.floor(Math.random() * FIRST.length)];
  const b = SECOND[Math.floor(Math.random() * SECOND.length)];
  return `${a}-${b}-${Math.floor(Math.random() * 9000) + 1000}`;
}

/**
 * The seed for this session. Idempotent — call it from anywhere, as often as
 * you like, and it is the same string every time.
 */
export function worldSeed() {
  if (chosen !== null) return chosen;
  const explicit = fromUrl();
  if (explicit) {
    chosen = explicit;
  } else if (typeof navigator !== 'undefined' && navigator.webdriver) {
    chosen = DEFAULT_SEED;
  } else {
    chosen = inventSeed();
  }
  return chosen;
}

/**
 * A 32-bit integer form, for the places that want a number rather than a
 * string — a noise domain offset, say. FNV-1a, so it is stable across machines,
 * which is the property that matters when two people are supposed to be
 * standing in the same wood.
 */
export function worldSeedNumber() {
  return hashString(worldSeed());
}
