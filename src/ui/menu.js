import {
  ARRIVALS,
  DYES,
  arrivalId,
  cleanName,
  dyeFor,
  inventName,
  playerHue,
  playerName,
  setArrivalId,
  setLobbyCode,
  setPlayerHue,
  setPlayerName,
} from '../core/identity.js';
import { inventSeed, worldSeed } from '../core/world-seed.js';
import { normalizeRoomCode } from '../net/protocol.js';

/**
 * The main menu.
 *
 * Four questions, asked once, before anything starts: what to call you, what
 * colour you are, whether anybody is coming, and which wood at what hour. The
 * markup is in index.html rather than built here — see the long comment beside
 * it — so this file is wiring and nothing else.
 *
 *
 * IT IS THE SAME ELEMENT THE ENTRY GATE ALWAYS WAS, AND THAT IS NOT LAZINESS.
 *
 * `#gate` and `#enter` keep their ids, their classes and their behaviour: click
 * the button, the gate gets `.gone`, the world starts. About thirty scripts in
 * scripts/ do exactly that and then diff pixels or milliseconds against a stored
 * expectation — a menu that inserted itself in front of that path would fail all
 * of them at once, in a way that looks like a rendering regression rather than
 * like a new panel. So every default here is chosen so that a bare click means
 * precisely what it meant before: your saved name, no room, this world, whatever
 * hour it happens to be.
 *
 *
 * NOTHING HERE INTERCEPTS THE ENTER CLICK, AND THAT IS A DESIGN CONSTRAINT
 * RATHER THAN AN OBSERVATION.
 *
 * Two of the choices on this panel cannot be applied to a running page at all: a
 * forest is built from its seed during main.js's module evaluation, and an
 * invite link is read at the same moment. Changing either means a new page.
 *
 * The tempting shape is to collect everything and navigate when the player
 * presses Enter — and it is wrong twice over. It puts a `stopImmediatePropagation`
 * in front of the one click every script in the repo depends on; and the player
 * presses "Enter the forest", gets a page load, and is looking at this menu
 * again, with the audio gesture they just spent thrown away (a browser will not
 * start an AudioContext without one, and a reload is not one).
 *
 * So navigation happens at the moment of the CHOICE, while the player is still
 * in the menu and a reload costs nothing: the panel comes straight back with
 * every value where it was, because names and dyes are in storage and the wood
 * and the room are in the URL. Enter is then always just Enter.
 *
 *
 * WHAT REACHES THE GAME, AND HOW.
 *
 * Not through `window.RR`, which is a console handle. Through
 * `core/identity.js`, a module singleton both halves import — the same
 * arrangement `settings.js` has with `core/quality.js`. This file writes; main.js
 * reads on the way through the gate. The two never refer to each other.
 */

/** How long after the last keystroke to ask the server about a code. */
const PEEK_DEBOUNCE_MS = 350;

/** How long after the last keystroke to tell a room you have changed your name. */
const LOOK_DEBOUNCE_MS = 400;

/** How long "Copied" stays on the button before it goes back to saying Copy. */
const COPIED_MS = 1600;

const $ = (id) => document.getElementById(id);

class MainMenu {
  constructor() {
    this.gate = $('gate');
    if (!this.gate) return;

    this.nameInput = $('menu-name');
    this.nameRoll = $('menu-name-roll');
    this.dyeHost = $('menu-dyes');
    this.dyeNote = $('menu-dye-note');
    this.companyHost = $('menu-company');
    this.companyNote = $('menu-company-note');
    this.codeField = $('menu-code-field');
    this.codeLabel = $('menu-code-label');
    this.codeInput = $('menu-code');
    this.codeCopy = $('menu-code-copy');
    this.seedInput = $('menu-seed');
    this.seedRoll = $('menu-seed-roll');
    this.seedNote = $('menu-seed-note');
    this.arrivalHost = $('menu-arrivals');
    this.arrivalNote = $('menu-arrival-note');
    this.settingsButton = $('menu-settings');

    /** 'alone' | 'host' | 'join' */
    this.mode = 'alone';
    /** The code we minted for hosting, kept so re-picking `host` does not mint a second. */
    this.hosting = null;
    this._peekTimer = 0;
    /**
     * The code the last peek was about.
     *
     * Answers arrive out of order — two requests a third of a second apart can
     * come back the other way round — and an answer about a code that is no
     * longer in the box would otherwise overwrite the note with a stale count,
     * or worse, navigate to a wood nobody asked for.
     */
    this._peekingFor = null;
    this._copiedTimer = 0;
    this._lookTimer = 0;
    /**
     * Whether the wood box holds something the player typed.
     *
     * `refresh` rewrites the box from `worldSeed()`, and without this a
     * half-typed seed would be silently thrown away by an unrelated click on a
     * dye. An uncommitted seed is not a state the game is in, but it IS a state
     * the player is in, and losing it under their hands is the kind of small
     * rudeness nobody reports and everybody notices.
     */
    this._seedTouched = false;
    /**
     * Every listener this thing adds, revoked in one call.
     *
     * The panel's elements live in index.html rather than being built here, so
     * they SURVIVE an HMR update while this module does not — an old instance
     * would keep its handlers on the very inputs the new one is also listening
     * to, and every keystroke would be handled twice. An AbortController is the
     * one mechanism that cannot get this wrong by forgetting a line.
     */
    this._listeners = new AbortController();

    this._buildDyes();
    this._buildArrivals();
    this._bind();
    this._seedFromUrl();
    this.refresh();
  }

  /* ---- construction ---------------------------------------------------- */

  _buildDyes() {
    this.dyeButtons = [];
    for (const dye of DYES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'menu-dye';
      b.dataset.dye = dye.id;
      b.title = dye.label;
      b.setAttribute('aria-label', dye.label);
      // The body's own colour, by the body's own recipe. See `_paintFigure`.
      b.style.background = cloth(dye.hue);
      b.addEventListener('click', () => {
        setPlayerHue(dye.hue);
        this._pushLook();
        this.refresh();
      });
      this.dyeHost.appendChild(b);
      this.dyeButtons.push({ dye, el: b });
    }
  }

  _buildArrivals() {
    this.arrivalButtons = [];
    for (const arrival of ARRIVALS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.arrival = arrival.id;
      b.textContent = arrival.label;
      b.addEventListener('click', () => {
        setArrivalId(arrival.id);
        this.refresh();
      });
      this.arrivalHost.appendChild(b);
      this.arrivalButtons.push({ arrival, el: b });
    }
  }

  /* ---- the URL is the starting state ------------------------------------ */

  /**
   * An invite link arrives with its answers already filled in.
   *
   * `?room=` means somebody sent you here and `attachMultiplayer` has already
   * joined on it — that autojoin happens during main.js's module evaluation, on
   * the grounds that opening a link IS the consent. So the menu is describing a
   * decision that has been taken, not offering one, and it says so.
   */
  _seedFromUrl() {
    this.invited = null;
    try {
      this.invited = normalizeRoomCode(new URLSearchParams(location.search).get('room'));
    } catch {
      /* an opaque origin; there is no invitation to read */
    }
    if (this.invited) {
      this.mode = 'join';
      this.codeInput.value = this.invited;
      this._peek(this.invited);
    }
  }

  /* ---- painting --------------------------------------------------------- */

  refresh() {
    if (document.activeElement !== this.nameInput) this.nameInput.value = playerName();
    // Only while it still says what the game says. Once somebody has typed in
    // it, it is theirs until they commit it or clear it. See `_seedTouched`.
    if (!this._seedTouched) this.seedInput.value = worldSeed();

    const hue = playerHue();
    for (const { dye, el } of this.dyeButtons) el.classList.toggle('on', dyeFor(hue) === dye);
    this.dyeNote.textContent = dyeFor(hue).label;
    this._paintFigure(hue);

    for (const b of this.companyHost.querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.mode === this.mode);
    }
    this.codeField.hidden = this.mode === 'alone';
    this.codeInput.readOnly = this.mode === 'host';
    this.codeCopy.hidden = this.mode !== 'host';
    this.codeLabel.textContent = this.mode === 'host' ? 'Your lobby code' : 'Lobby code';

    for (const { arrival, el } of this.arrivalButtons) {
      el.classList.toggle('on', arrival.id === arrivalId());
    }
    this.arrivalNote.textContent = ARRIVALS.find((a) => a.id === arrivalId())?.hint ?? '';

    this._paintSeedNote();
    this._commit();
  }

  /**
   * The body, in the colour the room will actually see.
   *
   * DRAWN, NOT RENDERED, and the reason is the frame this panel is sitting on.
   * A live three.js preview would mean a second WebGL context, its own copy of
   * every program it touches, and its own compile hitches — on the one screen
   * whose entire job is to hold still while the real renderer compiles thirty-
   * nine programs behind it (see the pre-warm in main.js). An SVG is four fills
   * and costs nothing at any moment.
   *
   * The four colours are `avatar.js`'s own recipe, and the duplication is
   * deliberate and bounded: the alternative is importing three and the whole
   * living-material chain into a title card. What must not drift is the ONE
   * NUMBER — the hue — which is why the menu chooses a hue and never a colour.
   * If the recipe changes, this preview is flattering rather than wrong, and it
   * is the only place in the project where that trade is worth making.
   */
  _paintFigure(hue) {
    const fill = (id, colour) => $(id)?.setAttribute('fill', colour);
    fill('mav-torso', cloth(hue));
    fill('mav-head', cloth(hue));
    fill('mav-arm-l', accent(hue));
    fill('mav-arm-r', accent(hue));
    fill('mav-leg-l', accent(hue));
    fill('mav-leg-r', accent(hue));
    fill('mav-hood', hood(hue));
    fill('mav-shadow', 'rgba(0, 0, 0, 0.34)');
    // The aura is a gradient rather than a fill, so it is the stops that take
    // the colour. See the `<defs>` in index.html.
    for (const id of ['mav-aura-in', 'mav-aura-mid', 'mav-aura-out']) {
      $(id)?.setAttribute('stop-color', aura(hue));
    }
  }

  _paintSeedNote() {
    const typed = this.seedInput.value.trim();
    if (typed && typed !== worldSeed()) {
      this.seedNote.textContent = 'Press Enter to go to that wood.';
      return;
    }
    this.seedNote.textContent = this.invited
      ? 'The wood you were invited to. Everyone in a lobby has to be in the same one.'
      : 'The name of this forest. Keep it to come back; change it to go somewhere else.';
  }

  /**
   * Tell the game what was chosen.
   *
   * Only the lobby, because it is the only one of the four that main.js has to
   * be told: the name and the dye are read straight out of `identity.js` by the
   * net layer when it joins, and the arrival is read by main.js from the same
   * place. An invitation is excluded — the URL has already dealt with it, and
   * setting it here would ask `attachMultiplayer` to join a room it is already
   * in.
   */
  _commit() {
    if (this.invited) {
      setLobbyCode(null);
      return;
    }
    if (this.mode === 'host') {
      setLobbyCode(this.hosting);
      return;
    }
    if (this.mode === 'join') {
      setLobbyCode(normalizeRoomCode(this.codeInput.value));
      return;
    }
    setLobbyCode(null);
  }

  /**
   * A change of name or colour, to a room we may already be standing in.
   *
   * Only ever true for somebody who arrived through an invite link, since that
   * is the one path that joins before the gate lifts. `window.RR` may not exist
   * yet — main.js is very likely still building a forest — and that is fine:
   * `identity.js` has already stored the change, and `join()` reads it there.
   * This is the live path, not the only path.
   */
  _pushLook() {
    /**
     * Trailing, because this is on the keystroke path.
     *
     * Every character of a twenty-character name is a change, and each one would
     * otherwise be a message the server fans out to everybody in the room — a
     * paragraph of renaming to say one name. The room needs to end up with the
     * right answer, not to watch it being typed, which is the same argument the
     * share resize makes in `net/index.js` and settles on the same shape.
     */
    if (this._lookTimer) clearTimeout(this._lookTimer);
    this._lookTimer = window.setTimeout(() => {
      this._lookTimer = 0;
      try {
        window.RR?.net?.identify?.({ name: playerName(), hue: playerHue() });
      } catch {
        /* the game is not up yet, or is up and did not like it; neither is fatal */
      }
    }, LOOK_DEBOUNCE_MS);
  }

  /* ---- going somewhere else --------------------------------------------- */

  /**
   * Open this page again with different answers in the query string.
   *
   * The only way to change which forest you are in. See the header for why this
   * happens at the moment of choosing rather than on the way through the gate.
   *
   * NEVER UNDER AUTOMATION. A reload in the middle of a Playwright script does
   * not fail the script, it makes it measure a page that is not the one it set
   * up — the same reasoning that pins the seed in `core/world-seed.js` and
   * refuses the Auto governor in `core/quality.js`. No script types a lobby code
   * or a seed, so this is a guard against a future one rather than a live
   * condition.
   */
  _goTo({ room, seed }) {
    if (navigator.webdriver) return false;
    const url = new URL(location.href);
    if (seed) url.searchParams.set('seed', seed);
    if (room) url.searchParams.set('room', room);
    else url.searchParams.delete('room');
    url.hash = '';
    if (url.toString() === location.href) return false;
    location.href = url.toString();
    return true;
  }

  /* ---- the lobby -------------------------------------------------------- */

  async _setMode(mode) {
    if (mode === this.mode) return;

    /**
     * Leaving an invitation is a page load, because arriving on one was.
     *
     * The join already happened during module evaluation, so there is nothing
     * here to cancel — and a menu that said "on your own" while a socket was
     * open would be lying about the one thing this panel is for. Dropping
     * `?room=` and reloading is the honest version, and it is a deliberate
     * enough act to be worth a reload.
     */
    if (this.invited && mode === 'alone') {
      if (this._goTo({ room: null, seed: worldSeed() })) return;
      /**
       * Refused, which today means automation. Do NOT fall through and light the
       * button anyway: the socket is still open, so a panel reading "on your
       * own" would be describing a state this page is not in — and the one thing
       * this section of the menu is for is saying who is with you.
       */
      this.companyNote.textContent = 'Already in that lobby. Open the page without the link to leave it.';
      return;
    }

    this.mode = mode;
    this.companyNote.textContent = '';
    if (mode === 'host') await this._mint();
    if (mode === 'join' && !this.invited) this.codeInput.value = '';
    this.refresh();
    if (mode === 'join') this.codeInput.focus();
  }

  /**
   * Ask the server for a code to give out.
   *
   * Minted server-side rather than rolled here so both halves agree on the
   * alphabet, exactly as `net/index.js` does it — and for the same second
   * reason: this doubles as the liveness probe. If it does not come back there
   * is no point offering to host, and the player gets one line instead of a
   * lobby that silently never works.
   */
  async _mint() {
    if (this.hosting) {
      this.codeInput.value = this.hosting;
      return;
    }
    this.codeInput.value = '';
    this.companyNote.textContent = 'Asking for a code…';
    let code = null;
    try {
      const response = await fetch('/api/room', { cache: 'no-store' });
      if (response.ok) {
        const body = await response.json();
        if (typeof body?.room === 'string') code = body.room;
      }
    } catch {
      /* no server; handled below, the same way every other failure here is */
    }
    // A slow answer to a question the player has moved on from. Writing the code
    // into a box that is now somebody else's lobby code would be worse than
    // saying nothing.
    if (this.mode !== 'host') return;
    if (!code) {
      this.mode = 'alone';
      this.companyNote.textContent = 'Nobody answers. The wood is yours alone.';
      this.refresh();
      return;
    }
    this.hosting = code;
    this.codeInput.value = code;
    this.companyNote.textContent =
      'Read this out to whoever you want with you. They pick “Join a lobby”.';
  }

  _onCodeInput() {
    const code = normalizeRoomCode(this.codeInput.value);
    this._commit();
    if (!code) {
      this.companyNote.textContent = this.codeInput.value.trim()
        ? 'Nine letters and numbers, in three groups.'
        : '';
      return;
    }
    if (this._peekTimer) clearTimeout(this._peekTimer);
    this._peekTimer = window.setTimeout(() => {
      this._peekTimer = 0;
      this._peek(code);
    }, PEEK_DEBOUNCE_MS);
  }

  /**
   * What is behind a code, before committing to it.
   *
   * THE SEED IS THE POINT, and it is the thing that makes a typed code work at
   * all. An invite LINK carries `?seed=` beside `?room=`, so a guest builds the
   * host's forest before opening a socket. Nine characters read down a telephone
   * carry nothing, and two people in one room in two different woods is the
   * quietest bad state this project has: the avatars walk through trees that are
   * not there and stand at different heights on the same coordinates, nothing
   * errors anywhere, and it reads as broken netcode. So the room remembers which
   * wood it is (see `Room.seed` in server/rooms.js) and this fetches it.
   *
   * A room with no seed is a room nobody is in yet, in which case there is
   * nothing to match and the joiner's own wood becomes the room's.
   */
  async _peek(code) {
    this._peekingFor = code;
    let body = null;
    try {
      const response = await fetch(`/api/room/peek?room=${encodeURIComponent(code)}`, {
        cache: 'no-store',
      });
      if (response.ok) body = await response.json();
    } catch {
      /* handled below */
    }
    // An answer about a code that is no longer in the box. See `_peekingFor`.
    if (this._peekingFor !== code) return;
    if (!body) {
      this.companyNote.textContent = 'Nobody answers. The wood may be yours alone.';
      return;
    }

    if (body.seed && body.seed !== worldSeed()) {
      this.companyNote.textContent = 'They are in another wood. Taking you there…';
      // Their forest, their room, one page load. Everything else on this panel
      // is in storage and comes back untouched.
      if (this._goTo({ room: code, seed: body.seed })) return;
    }

    if (body.full) {
      this.companyNote.textContent = `That clearing is full (${body.maxSize}). Voice runs peer to peer, so lobbies stay small.`;
      return;
    }
    if (body.here === 0) {
      this.companyNote.textContent = this.invited
        ? 'Nobody there yet. You will be the first.'
        : 'Nobody is using that code yet. Enter and it is yours.';
      return;
    }
    const others = body.here;
    this.companyNote.textContent =
      others === 1
        ? `Someone is already there. Room for ${body.maxSize - others} more.`
        : `${others} people are already there. Room for ${body.maxSize - others} more.`;
  }

  /* ---- wiring ----------------------------------------------------------- */

  _bind() {
    // Every listener below is revoked together by `dispose`. See `_listeners`.
    const on = (el, event, fn) =>
      el.addEventListener(event, fn, { signal: this._listeners.signal });

    /**
     * Written on every keystroke rather than on blur.
     *
     * The player can leave this panel by clicking one button, and a name that
     * only committed on `change` would be dropped by exactly the person who
     * typed it and pressed Enter straight away. Storage writes are cheap and
     * `setPlayerName` refuses empties, so the field is allowed to be
     * momentarily blank on its way to something.
     */
    on(this.nameInput, 'input', () => {
      setPlayerName(this.nameInput.value);
      this._pushLook();
    });
    on(this.nameInput, 'blur', () => this.refresh());
    on(this.nameRoll, 'click', () => {
      setPlayerName(inventName());
      this.nameInput.value = playerName();
      this._pushLook();
    });

    for (const b of this.companyHost.querySelectorAll('button')) {
      on(b, 'click', () => this._setMode(b.dataset.mode));
    }

    on(this.codeInput, 'input', () => this._onCodeInput());
    on(this.codeCopy, 'click', () => this._copyInvite());

    on(this.seedRoll, 'click', () => {
      this.seedInput.value = inventSeed();
      this._seedTouched = true;
      this._paintSeedNote();
      this.seedInput.focus();
    });
    on(this.seedInput, 'input', () => {
      this._seedTouched = true;
      this._paintSeedNote();
    });

    /**
     * Enter commits a field instead of doing nothing.
     *
     * None of these inputs is in a form, so the key has no default meaning here
     * — and the wood field genuinely needs a commit gesture, because typing a
     * seed is asking to be taken somewhere and the menu must not act on every
     * half-typed name along the way.
     */
    on(this.gate, 'keydown', (event) => {
      if (event.key !== 'Enter') return;
      if (!(event.target instanceof HTMLInputElement)) return;
      event.preventDefault();
      if (event.target === this.seedInput) this._commitSeed();
      else event.target.blur();
    });

    on(this.settingsButton, 'click', () => {
      // Built by src/ui/settings.js, which loads after this file. It is present
      // by the time anybody can click, and a guard costs nothing if it is not.
      window.RRSettingsMenu?.show?.();
    });
  }

  /**
   * Take the panel's wiring apart.
   *
   * The elements themselves are index.html's and stay where they are — this only
   * gives up the handlers, which is exactly what an HMR update needs: the new
   * instance binds the same inputs, and without this every keystroke would be
   * handled by both.
   */
  dispose() {
    this._listeners?.abort();
    for (const timer of [this._peekTimer, this._copiedTimer, this._lookTimer]) {
      if (timer) clearTimeout(timer);
    }
    this._peekTimer = 0;
    this._copiedTimer = 0;
    this._lookTimer = 0;
    // A peek still in flight must not write into a panel that has been replaced.
    this._peekingFor = null;
  }

  _commitSeed() {
    const typed = this.seedInput.value.trim().slice(0, 64);
    if (!typed || typed === worldSeed()) {
      this.seedInput.value = worldSeed();
      this._seedTouched = false;
      this._paintSeedNote();
      return;
    }
    /**
     * A new wood is a new page, and it drops any lobby with it.
     *
     * Deliberate: the room you were in is in a forest you have just chosen to
     * leave, and carrying the code across would put you in it from the wrong
     * side — which is the exact failure `_peek` exists to prevent, arrived at
     * from the other direction.
     */
    this.seedNote.textContent = 'Going there…';
    this._goTo({ room: null, seed: typed });
  }

  /**
   * The invitation, which has to carry the WORLD as well as the room.
   *
   * The same link `net/index.js` builds when somebody presses J, and for the
   * same reason: a code alone cannot say which forest, so the seed rides with
   * it. `_peek` means a bare code now works too — but a link is one click at the
   * far end and no typing, so it is what the copy button offers.
   */
  _copyInvite() {
    if (!this.hosting) return;
    const url = new URL(location.href);
    url.searchParams.set('room', this.hosting);
    url.searchParams.set('seed', worldSeed());
    url.hash = '';
    const link = url.toString();
    // A click is a user gesture, so this is allowed. If the browser or the
    // permission says no, the code is still legible in the box next to it.
    navigator.clipboard?.writeText?.(link).catch(() => {});
    this.codeCopy.textContent = 'Copied';
    if (this._copiedTimer) clearTimeout(this._copiedTimer);
    this._copiedTimer = window.setTimeout(() => {
      this._copiedTimer = 0;
      this.codeCopy.textContent = 'Copy';
    }, COPIED_MS);
    this.companyNote.textContent = 'Link copied. It carries this wood as well as the code.';
  }
}

/* ---- the dye recipe, mirrored from avatar.js ------------------------------ */

const wheel = (hue) => Math.round(((hue % 1) + 1) % 1 * 360);
/** Body and head: dyed wool at low saturation, so it reads as cloth. */
const cloth = (hue) => `hsl(${wheel(hue)}deg 34% 42%)`;
/** Limbs, darker. */
const accent = (hue) => `hsl(${wheel(hue)}deg 42% 25%)`;
/** The hood, near black — a value cue rather than a hue one, so it survives fog. */
const hood = (hue) => `hsl(${wheel(hue)}deg 30% 11%)`;
/** The speech aura, which is light rather than cloth and is therefore bright. */
const aura = (hue) => `hsl(${wheel(hue)}deg 75% 62%)`;

/* -------------------------------------------------------------------------- */

/**
 * Self-installing, because index.html loads this module directly — the same
 * arrangement `settings.js` has, for a related but distinct reason. That one is
 * kept off the critical path to a first frame; this one is put IN FRONT of it,
 * so that the panel is wired while main.js is still building a forest.
 */
function install() {
  // An HMR update re-runs this module. Without the sweep the old instance keeps
  // its listeners on inputs the new one is also listening to, so every keystroke
  // is handled twice and the dye row grows a second set of swatches.
  window.RRMainMenu?.dispose?.();
  document.getElementById('menu-dyes')?.replaceChildren();
  document.getElementById('menu-arrivals')?.replaceChildren();
  const menu = new MainMenu();
  window.RRMainMenu = menu;
  return menu;
}

const menu = document.getElementById('gate') ? install() : null;
if (!menu) document.addEventListener('DOMContentLoaded', install, { once: true });

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.RRMainMenu?.dispose?.();
  });
}

export { menu };
