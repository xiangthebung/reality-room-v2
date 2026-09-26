/**
 * WHICH LAND YOU ARE STANDING IN — the registry, and the one place that turns a
 * seed string into a world.
 *
 * ==== THE WORD IS `land`, NOT `biome`, AND THAT IS NOT PEDANTRY ============
 *
 * `biome` is already taken. `scatter.js`'s `character()` calls its seven
 * seed-derived weights biome fields, and its offset hashes are literally
 * `biome:ax:${s}`; `terrain.js` has a `kBiomeX` lattice; forest.js's comments
 * use the word a dozen times. All of those mean SUB-REGIONS OF ONE WOOD — the
 * meadow, the thicket, the bald litter floor — which is a real and useful
 * distinction and is not what this module is about. A `land` is the whole
 * clothing of a world: which trees exist at all, which understorey layers are
 * built, what the ground is made of, what a "kind of place" even means here.
 * A snowfield's `character()` has no `meadow` weight and never will.
 *
 *
 * ==== A LAND RIDES THE SEED STRING AND COSTS NOTHING ON THE WIRE ===========
 *
 * This is the whole reason the change was affordable, and it is worth stating
 * before anything else in this file makes sense.
 *
 * World identity is ALREADY 100% implicit in the seed, and the seed already
 * travels on three rails that nobody has to touch: the URL's `?seed=`, the
 * WebSocket handshake's query parameter, and `GET /api/room/peek -> Room.seed`.
 * `server/rooms.js` stores whatever string the first player in the room brought
 * and never overwrites it while anybody is there; `menu.js` peeks it and says
 * "They are in another wood. Taking you there…" and navigates. So a seed of
 *
 *     taiga:fen-mire-3204
 *
 * carries a LAND as well as a wood, with no server change, no protocol change
 * and no `world` field anywhere. The alternative — a first-class field beside
 * the seed — was priced at eight edit sites across `net/` and `server/`, every
 * one of which is a place two players can end up disagreeing about where they
 * are. This has none, because there is only ever one string.
 *
 * THE FULL STRING IS STILL THE TERRAIN SEED, prefix included. `taiga:grove-01`
 * and `grove-01` are therefore DIFFERENT height fields rather than the same
 * hills wearing different clothes. That was a choice and the alternative was
 * tempting — one landform you could visit in two seasons is a nice idea — but
 * it makes the prefix silently load-bearing in `normalizeSeed`, and the thing
 * that decided it is that a bare seed must hash to exactly what it hashed to
 * yesterday. `grove-01` has no prefix, so it is untouched, and
 * `terrain-survey`'s 210 022-point identity hash cannot move. See `landOf`.
 *
 *
 * ==== EVERY REALM HAS TO BE TOLD, AND THIS IS THE RECORDED WAY TO GET IT
 *      WRONG ==================================================================
 *
 * `forest-worker.js` carries a long block about the day the streamed trees were
 * built against `grove-01` while the ground under them came from the session's
 * real seed: correct inside ~160 m, a mean of 9.5-12.1 m out past 170, and at
 * 2 km "a bank of trunks hanging in mid-air with their shadows on the ground
 * below them". A land id is exactly the same hazard with a louder symptom — a
 * worker that never heard about the taiga builds rainforest scatter rules
 * against boreal ground.
 *
 * So this module copies terrain.js's own defence verbatim: the id is PUBLISHED
 * ON THE REALM (`globalThis.RR_LAND`) rather than merely held in module state,
 * and the bottom of this file adopts it on evaluation. A page can hold more
 * than one copy of a module — Vite serves an HMR-versioned URL to a late
 * `import()`, which is how `endless-check.mjs` gets a second pristine
 * `terrain.js` — and every copy in a realm must agree. In a worker
 * `globalThis` is the worker's own, so the scope is per-realm, which is right.
 *
 * The three realms and who tells them:
 *
 *   main         `main.js`, beside `setWorldSeed(SEED)`.
 *   forest       `forest-worker.js`, from the `init` message's `land`.
 *   terrain      `terrain-worker.js`, from each chunk message's `land`.
 *
 * The terrain worker is the awkward one and it is worth knowing why: it is the
 * only realm that is handed the seed as a NUMBER (`ground.js` posts
 * `getWorldSeed()`), so it cannot re-derive the land from the string the way
 * everything else can. Hence a field. It is stamped per chunk rather than sent
 * once at spawn for the reason `ground.js` already gives about the seed: there
 * is no "once" — workers are respawned on error and a message can beat the
 * module's evaluation.
 */

import { RAINFOREST } from './rainforest.js';
import { TAIGA } from './taiga.js';

/**
 * Every land there is, keyed by the prefix that selects it.
 *
 * ORDER IS THE MENU'S ORDER. Nothing else reads it, and a land added here is a
 * land the picker offers — see `menu.js`, which builds its buttons from
 * `LAND_LIST` rather than from a hard-coded pair, so that adding a third is one
 * import and one row.
 */
const LANDS = {
  [RAINFOREST.id]: RAINFOREST,
  [TAIGA.id]: TAIGA,
};

/** In menu order. */
export const LAND_LIST = [RAINFOREST, TAIGA];

/**
 * The land a bare seed gets, and it must stay the rainforest forever.
 *
 * Every stored expectation in `scripts/` — `.perf/baseline.json`'s nine
 * scenarios, `terrain-survey`'s height hash, every reference frame in
 * `shoot.mjs`, `audio-probe`'s spectral centroid — was captured in this land on
 * `grove-01`. A default that moved would not fail those gates, it would make
 * them all wrong at once and blame the renderer.
 */
export const DEFAULT_LAND = RAINFOREST.id;

/**
 * Split a seed string into `{ land, seed }`.
 *
 * The rule is deliberately narrow: a prefix counts only if it is one of the ids
 * in `LANDS`, exactly, before the first colon. Anything else — a colon in a
 * lobby code, somebody's `ash-combe-1204:2`, a pasted URL fragment — is just
 * part of the seed, which is the behaviour a seed has always had (`world-seed.js`
 * takes any string at all and hashes it). So this cannot reject a seed that
 * used to work, and it cannot silently reinterpret one either.
 *
 * `seed` is the WHOLE original string, not the tail. See the header.
 */
export function landOf(seed) {
  const s = typeof seed === 'string' ? seed : '';
  const i = s.indexOf(':');
  if (i > 0) {
    const head = s.slice(0, i);
    if (Object.hasOwn(LANDS, head)) return head;
  }
  return DEFAULT_LAND;
}

/** `taiga:fen-mire-3204` -> `fen-mire-3204`. For display only; nothing hashes this. */
export function bareSeed(seed) {
  const s = typeof seed === 'string' ? seed : '';
  const i = s.indexOf(':');
  if (i > 0 && Object.hasOwn(LANDS, s.slice(0, i))) return s.slice(i + 1);
  return s;
}

/** Put a land id back onto a bare seed. Idempotent, and a no-op for the default. */
export function withLand(land, seed) {
  const bare = bareSeed(seed);
  return land && land !== DEFAULT_LAND ? `${land}:${bare}` : bare;
}

let _land = LANDS[DEFAULT_LAND];

/**
 * Tell this realm which land it is building. Call ONCE, before anything samples
 * the scatter or paints a ground vertex — the same contract, and for the same
 * reason, as `setWorldSeed`.
 *
 * An unknown id falls back to the default rather than throwing, because the id
 * arrives from a URL a player typed and the failure mode of throwing here is a
 * blank page. It is not silent: a land nobody registered is a seed nobody can
 * share, and `landOf` will already have refused to see it as a prefix.
 */
export function setLand(id) {
  _land = LANDS[id] ?? LANDS[DEFAULT_LAND];
  if (typeof globalThis !== 'undefined') globalThis.RR_LAND = _land.id;
  return _land;
}

/** Which land this realm is building. One property read; call it freely. */
export function currentLand() {
  return _land;
}

/** Convenience for the three realms that have a seed string and nothing else. */
export function setLandFromSeed(seed) {
  return setLand(landOf(seed));
}

/**
 * AT THE BOTTOM OF THE FILE ON PURPOSE, and copied from the identical block at
 * the end of terrain.js. A second copy of this module appearing in a realm that
 * has already chosen a land must adopt it rather than start in the rainforest,
 * and `setLand` cannot be called from above its own declaration — that is the
 * temporal-dead-zone trap terrain.js records paying for once already.
 */
if (typeof globalThis !== 'undefined' && globalThis.RR_LAND !== undefined) {
  setLand(globalThis.RR_LAND);
}
