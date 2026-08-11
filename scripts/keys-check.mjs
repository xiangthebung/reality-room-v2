import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { BINDINGS, BINDING_GROUPS } from '../src/core/keys.js';

/**
 * Does the key list still describe the keys the code listens for?
 *
 * THE BUG THIS EXISTS TO CATCH ALREADY HAPPENED, TWICE, AND SILENTLY BOTH
 * TIMES. The only key reference in the game was a hand-typed strip of HTML in
 * index.html — a sixth copy of facts that live in five other modules — and it
 * had drifted from all of them: it told players to press `~` for a panel that
 * opens on `` ` ``, and it never mentioned Space, Q, X, C, the scroll wheel or
 * dropping a video file in. Nothing failed. Nothing could fail, because a
 * paragraph of prose and a `switch` statement have no relationship a machine
 * can check.
 *
 * `src/core/keys.js` gives them one: the list is now data, the on-screen strip
 * and the settings menu's Controls page are both rendered from it, and this
 * script closes the loop in both directions —
 *
 *   every key the list DOCUMENTS is a key some handler actually reads, and
 *   every key a handler READS is a key the list documents.
 *
 * It is static: no browser, no dev server, no world. That is deliberate, so it
 * costs a second and can run on every change rather than only in `npm run
 * check`. The README tables are checked too, for the same reason they exist —
 * somebody reads the repository before they ever run it.
 *
 * Run: node scripts/keys-check.mjs
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const failures = [];
function check(label, ok, detail = '') {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : ` (${detail})`}`);
}

/* -------------------------------------------------------------------------- */
/* what a cap on screen means to a `KeyboardEvent`                            */
/* -------------------------------------------------------------------------- */

/**
 * Caps that are not keys. A mouse, a wheel and a dragged file all belong in the
 * controls list — they are things you do with your hands to make the game do
 * something, which is the only definition of "control" that helps anybody — and
 * none of them has a `KeyboardEvent.code` to look for.
 */
const NOT_A_KEY = new Set(['Mouse', 'Scroll', 'Drag']);

const NAMED = {
  Esc: ['Escape'],
  Space: ['Space'],
  Shift: ['ShiftLeft', 'ShiftRight'],
  Tab: ['Tab'],
  Enter: ['Enter'],
  '`': ['Backquote'],
  '↑': ['ArrowUp'],
  '↓': ['ArrowDown'],
  '←': ['ArrowLeft'],
  '→': ['ArrowRight'],
};

function codesFor(cap) {
  if (NOT_A_KEY.has(cap)) return [];
  if (NAMED[cap]) return NAMED[cap];
  if (/^[A-Z]$/.test(cap)) return [`Key${cap}`];
  return null; // a cap this script does not know how to check
}

/* -------------------------------------------------------------------------- */
/* every key code the source actually mentions                                */
/* -------------------------------------------------------------------------- */

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith('.js')) out.push(path);
  }
  return out;
}

const CODE_RE = /'(Key[A-Z]|Digit\d|Arrow(?:Up|Down|Left|Right)|Escape|Space|Tab|Enter|Backquote|Backslash|Bracket(?:Left|Right)|Shift(?:Left|Right))'/g;

/** code -> the files that name it. */
const inSource = new Map();
for (const file of sourceFiles(join(ROOT, 'src'))) {
  // keys.js is the documentation, not a handler. Counting it would make this
  // script assert that the list agrees with itself.
  if (file.endsWith(join('core', 'keys.js'))) continue;
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(CODE_RE)) {
    const list = inSource.get(m[1]) ?? [];
    list.push(relative(ROOT, file).replace(/\\/g, '/'));
    inSource.set(m[1], list);
  }
}

/**
 * Codes a handler reads that the list is allowed not to have a row for, each
 * with the reason. An allowlist rather than a loose pattern, so adding a key
 * and forgetting to document it still fails: the only way past this check is to
 * write down why.
 */
const UNLISTED = {
  ArrowUp: 'an alias for W, carried in the Move row’s note rather than four rows of its own',
  ArrowDown: 'an alias for S — see ArrowUp',
  ArrowLeft: 'an alias for A — see ArrowUp',
  ArrowRight: 'an alias for D — see ArrowUp',
  BracketLeft: 'inside the debug panel, named in the note on the backtick row',
  BracketRight: 'inside the debug panel, named in the note on the backtick row',
  Backslash: 'inside the debug panel, named in the note on the backtick row',
  KeyK: 'pauses the trip, inside the debug panel, named in the note on the backtick row',
  KeyM: 'eats a mushroom from anywhere, and only while the debug panel is open',
  ShiftRight: 'the other Shift; the row says Shift',
};

/* -------------------------------------------------------------------------- */

console.log('\nthe list describes keys that exist:');

const documented = new Set();
for (const b of BINDINGS) {
  for (const cap of b.keys) {
    const codes = codesFor(cap);
    check(
      `"${cap}" is a cap this check understands`,
      codes !== null,
      codes === null ? `add it to NAMED in ${relative(ROOT, fileURLToPath(import.meta.url))}` : ''
    );
    if (!codes) continue;
    for (const code of codes) documented.add(code);
    if (!codes.length) continue;
    check(
      `${b.label} (${cap}) is read somewhere in src/`,
      codes.some((c) => inSource.has(c)),
      `nothing listens for ${codes.join(' or ')}`
    );
  }
}

console.log('\nand every key the code reads is in the list:');
for (const [code, files] of [...inSource].sort()) {
  if (documented.has(code) || UNLISTED[code]) continue;
  check(`${code} is documented`, false, `read in ${[...new Set(files)].join(', ')}`);
}
if (!failures.length) console.log('  ok    no undocumented keys');

console.log('\nevery world keydown listener is guarded:');
/**
 * The guard is `worldHearsKey`, and the three things it stops are a browser
 * chord firing a game action (`Ctrl+P` printed AND started a screen share),
 * auto-repeat turning one press into thirty, and the world listening from
 * underneath an open dialog. Four of the five listeners had grown their own
 * partial version of it and no two agreed.
 */
for (const file of sourceFiles(join(ROOT, 'src'))) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (!/window\.addEventListener\('keydown'/.test(text)) continue;
  // social.js and settings.js own their own gates: chat swallows every key
  // while you are typing, and the settings panel IS the modal the guard asks
  // about, so it cannot ask.
  if (/ui\/(social|settings)\.js$/.test(rel)) {
    check(`${rel} is exempt, and says so`, /metaKey|Escape/.test(text));
    continue;
  }
  check(`${rel} calls worldHearsKey`, text.includes('worldHearsKey'));
}

console.log('\nthe README tables agree with the list:');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
for (const b of BINDINGS) {
  const caps = b.keys.filter((k) => !NOT_A_KEY.has(k));
  if (!caps.length) continue;
  // A cap group pressed together is usually written as one span — `W A S D` —
  // and a backtick has to be written `` ` `` in a markdown table, so both
  // spellings count.
  const span = (t) => readme.includes(`\`${t}\``) || readme.includes(`\`\` ${t} \`\``);
  const found = span(caps.join(' ')) || caps.every(span);
  check(`${caps.join(' ')} appears in the README`, found);
}

console.log(
  failures.length ? `\nFAILED (${failures.length})\n  ${failures.join('\n  ')}` : '\nPASS'
);
console.log(`\n${BINDINGS.length} bindings in ${BINDING_GROUPS.length} groups`);
process.exit(failures.length ? 1 : 0);
