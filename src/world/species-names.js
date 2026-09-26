/**
 * EVERY TREE SPECIES THERE IS, AS A LIST OF STRINGS AND NOTHING ELSE.
 *
 * ==== WHY THIS IS A FILE AND NOT A LINE IN trees.js ========================
 *
 * `trees.js` has always exported `SPECIES_NAMES = Object.keys(SPECIES)`, which
 * is the right place for it and is still where you should import it from inside
 * the app. The problem is that `trees.js` imports `textures.js`, which draws on
 * a `<canvas>` at module scope, and a bare `node` process has no canvas. So the
 * one consumer that most needs this list — `scripts/land-identity.mjs`, the
 * two-hundred-millisecond pure-node gate you are meant to run after every edit
 * to a land file — could not import it.
 *
 * It coped by hard-coding `const AVAILABLE = ['palm','cecropia','kapok','fig',
 * 'brownea']` with a comment saying the conifers were "a pending patch to
 * trees.js". They stopped being pending; the comment did not. What that cost is
 * worth writing down because it is the exact failure mode this repo keeps
 * paying for — an instrument that is confidently measuring the wrong world:
 *
 *   the taiga's roster is five conifers, none of which were in `AVAILABLE`, so
 *   `grown` came out EMPTY and the gate fell through to its `AVAILABLE`
 *   fallback and hashed a taiga made of palms;
 *
 *   `treeSector`'s substitution guard folded spruce, fir AND larch all onto
 *   `palm`, so three of the five species merged into one layer — which means a
 *   change to the spruce/fir altitude threshold produced a BIT-IDENTICAL hash
 *   and the gate reported "ok" on a world that had moved;
 *
 *   and the pinned taiga entry in `.perf/land-identity.json` described a world
 *   no player could ever visit.
 *
 * A leaf module fixes it permanently: strings only, no imports, no side
 * effects, importable from node, the browser, a worker or a script.
 *
 *
 * ==== THE ORDER IS LOAD-BEARING ============================================
 *
 * `forest.js` builds its archetypes by iterating `land.roster` filtered through
 * this list, and `treeSector`'s `grown0` fallback is the first surviving entry.
 * Neither of those changes if you APPEND. Both change if you reorder or insert,
 * so append.
 *
 * This must stay `Object.keys(SPECIES)` exactly — trees.js asserts it on
 * evaluation, see the re-export there — because a row added to `SPECIES` and
 * not to this list is a species `forest.js` never grows and no gate ever sees,
 * which is the same shape of silent nothing the block above describes.
 */
export const SPECIES_NAMES = [
  // The rainforest's five.
  'palm',
  'cecropia',
  'kapok',
  'fig',
  'brownea',
  // The taiga's five. See lands/taiga.js for what each one is for.
  'spruce',
  'fir',
  'birch',
  'larch',
  'juniper',
];
