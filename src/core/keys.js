/**
 * Every key this game listens for, declared once.
 *
 * WHY THIS FILE EXISTS.
 *
 * The bindings live in the modules that own the behaviour — `E` is in main.js
 * next to `interact()`, `V` is in net/index.js next to the microphone, `WASD`
 * is in the controller — and that is right, because a key handler that is not
 * next to the thing it does drifts away from it. What is NOT right is what that
 * left behind: the only place a player could read the key list was a hand-typed
 * strip of HTML in index.html, which was a sixth copy of facts that lived in
 * five other files and had already gone wrong in three separate ways. It said
 * `~` for a panel opened by `` ` ``, it never mentioned Space, Q, X, C or the
 * scroll wheel, and it listed the whole social layer to somebody walking alone.
 *
 * So the HANDLERS stay where they are and the DOCUMENTATION comes here. This
 * module does nothing at runtime — no listeners, no state, no imports. It is
 * the answer to "what are the controls", and both the on-screen strip and the
 * settings menu's Controls page are rendered from it, so neither can drift from
 * the other again.
 *
 * Keeping it in sync with the handlers is still a human job. It is a much
 * smaller one than keeping five prose copies in sync was, and there is exactly
 * one place to look.
 */

/**
 * The order the groups are drawn in.
 *
 * Movement first because it is what a player needs in the first five seconds,
 * and panels last because you are already looking at one when you read this.
 * The middle is ordered by how soon you meet the thing: the forest, then the
 * jukebox in the clearing, then the mushrooms, then other people.
 */
export const BINDING_GROUPS = [
  { id: 'movement', title: 'Moving about' },
  { id: 'world', title: 'The forest' },
  { id: 'music', title: 'The jukebox' },
  { id: 'trip', title: 'Mushrooms' },
  { id: 'together', title: 'Other people' },
  { id: 'screens', title: 'Screens and films' },
  { id: 'panels', title: 'Panels' },
];

/**
 * One binding.
 *
 * `keys`   what to draw in the key caps. Several caps means "any of these"
 *          unless `all` is set, which means "these together" (`W A S D`).
 * `label`  what it does, in the imperative, lower case, no full stop.
 * `note`   the caveat a player would otherwise have to discover by failing.
 * `essential` shows in the on-screen strip. Keep this list very short: the
 *          strip is persistent chrome, and persistent chrome is the one thing
 *          the trip must not be given (see the header of src/ui/hud.js).
 * `short`  what the strip calls it when the full label is too long for a line
 *          that has to stay on one line.
 */
export const BINDINGS = [
  // ---- moving about --------------------------------------------------------
  {
    group: 'movement',
    keys: ['W', 'A', 'S', 'D'],
    all: true,
    label: 'Move',
    // One row, not two. The arrow keys are the same verb by another name, and
    // a reference list whose first two entries are both called "Move" reads as
    // a mistake before it reads as an alternative.
    note: 'Or the arrow keys',
    essential: true,
  },
  { group: 'movement', keys: ['Shift'], label: 'Run', essential: true },
  { group: 'movement', keys: ['Space'], label: 'Jump' },
  {
    group: 'movement',
    keys: ['Mouse'],
    label: 'Look around',
    note: 'Click the forest to take the pointer',
  },

  // ---- the forest ----------------------------------------------------------
  {
    group: 'world',
    keys: ['E'],
    label: 'Interact',
    note: 'Sit, stand up, board the ferry, cast, reel in',
    essential: true,
  },
  { group: 'world', keys: ['F'], label: 'Take out a rod, or put it away' },

  // ---- the jukebox ---------------------------------------------------------
  { group: 'music', keys: ['E'], label: 'Start or stop it', note: 'Standing at a speaker' },
  { group: 'music', keys: ['Q'], label: 'Next track' },
  {
    group: 'music',
    keys: ['U'],
    label: 'Paste a YouTube link',
    note: 'Standing at a speaker',
  },
  {
    group: 'music',
    keys: ['G'],
    label: 'Stand a speaker where you are looking',
    // The alternation is the whole interface and it is invisible from the key
    // cap, so it goes in the note rather than being something you work out by
    // pressing it twice.
    note: 'Left first, then right, then left again. From anywhere',
  },

  // ---- mushrooms -----------------------------------------------------------
  { group: 'trip', keys: ['E'], label: 'Eat one', note: 'Standing over a mushroom' },
  {
    group: 'trip',
    keys: ['N'],
    label: 'Ground yourself',
    note: 'Ends a trip immediately, from anywhere',
    essential: true,
  },

  // ---- other people --------------------------------------------------------
  { group: 'together', keys: ['J'], label: 'Open a room, and copy the invite link' },
  { group: 'together', keys: ['Enter', 'T'], label: 'Say something' },
  { group: 'together', keys: ['Tab'], label: 'See who is here', note: 'Hold' },
  { group: 'together', keys: ['V'], label: 'Talk', note: 'Hold, or force an open mic through' },
  { group: 'together', keys: ['X'], label: 'Mute yourself' },
  { group: 'together', keys: ['C'], label: 'Switch between open mic and push-to-talk' },

  // ---- screens -------------------------------------------------------------
  { group: 'screens', keys: ['P'], label: 'Put a screen up, or take it away' },
  { group: 'screens', keys: ['O'], label: 'Move it to where you are looking' },
  { group: 'screens', keys: ['Scroll'], label: 'Resize it', note: '1.2 m to 16 m' },
  {
    group: 'screens',
    keys: ['Drag'],
    label: 'Put a film on',
    note: 'Drop a video file anywhere on the window',
  },

  // ---- panels --------------------------------------------------------------
  {
    group: 'panels',
    keys: ['Esc'],
    label: 'Settings, and back again',
    short: 'Settings',
    essential: true,
  },
  {
    group: 'panels',
    keys: ['`'],
    label: 'The debug panel',
    note: 'Backtick, top left of the keyboard. Then 1–5 pick a page, [ and ] step phases, K pauses the trip where it is, \\ holds the level',
  },
];

/** The handful drawn on screen while you play. See `essential` above. */
export const ESSENTIAL = BINDINGS.filter((b) => b.essential);

/** Bindings in one group, in declaration order. */
export function bindingsIn(group) {
  return BINDINGS.filter((b) => b.group === group);
}

/**
 * One binding as `<kbd>` caps plus a separator.
 *
 * Alternatives are joined with a thin "or" and combinations with nothing at
 * all, because `W A S D` is one gesture and `Enter` / `T` is two ways to make
 * the same one — drawing both the same way is what made the old strip read as
 * a list of fourteen unrelated letters.
 */
export function keyCaps(binding) {
  const caps = binding.keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`);
  return caps.join(binding.all ? ' ' : '<i class="key-or">or</i>');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

/* -------------------------------------------------------------------------- */
/* the one piece of behaviour in here                                         */
/* -------------------------------------------------------------------------- */

/**
 * Should a world key handler act on this keydown?
 *
 * There are five `window` keydown listeners in this app — the controller, the
 * interact/jukebox switch in main.js, the room and microphone keys in
 * net/index.js, chat and the roster in social.js, and the debug panel — and
 * each of them grew its own guard clause independently. They did not agree,
 * and every place they disagreed was a bug:
 *
 * A BROWSER CHORD IS NOT A GAME SHORTCUT. Only social.js checked the modifier
 * keys, so `Ctrl+P` opened the print dialog AND started a screen share,
 * `Ctrl+F` opened find AND put a fishing rod away, `Ctrl+J` opened the
 * downloads list AND opened a room and wrote an invite link to the clipboard,
 * and `Ctrl+U` viewed source AND opened the paste-a-link box. Four of the six
 * most-used chords in a browser did two things at once. On macOS this is worse
 * than untidy: a key pressed as part of a Cmd chord never delivers its `keyup`
 * at all, so `Cmd+W` used to leave `KeyW` in the controller's held set and walk
 * you into a tree for the rest of the session.
 *
 * HOLDING A KEY IS ONE PRESS. net/index.js checked `repeat` and main.js did
 * not, so leaning on `Q` cycled the record at the OS repeat rate — around
 * thirty tracks a second, each one announcing itself in the toast — and holding
 * `E` re-cast a fishing line every 33 ms. Push-to-talk is the one genuine
 * exception, hence `allowRepeat`.
 *
 * A MODAL PANEL OWNS THE KEYBOARD. The settings menu stops keys that are aimed
 * at it, which covers the normal case because it focuses itself when it opens.
 * It does not cover focus being somewhere else — a click on the scrim, a
 * window that was alt-tabbed away from and come back to — and there the world
 * was still listening underneath the dialog: `W` walked, `E` sat you down on a
 * log you could not see, `P` started sharing your screen. `body.settings-open`
 * is set by the menu and read here, which keeps the dependency pointing the
 * right way: settings.js still knows nothing about the world.
 *
 * `keyup` handlers must NOT use this. A release has to be heard whatever was
 * true when the key went down, or it sticks.
 */
export function worldHearsKey(event, { allowRepeat = false } = {}) {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.repeat && !allowRepeat) return false;
  if (modalHasKeyboard()) return false;
  return true;
}

/** True while the settings menu is up. See `worldHearsKey`. */
export function modalHasKeyboard() {
  return document.body.classList.contains('settings-open');
}
