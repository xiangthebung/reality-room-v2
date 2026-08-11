import { CHAT_MAX_CHARS, hueOf } from '../net/protocol.js';

/**
 * The chat, the roster, and the one bar of controls.
 *
 * THE CONSTRAINT THIS FILE INHERITS. `hud.js` opens by explaining that every
 * pixel of persistent chrome is a piece of perfectly stable, perfectly
 * rectangular, unmistakably man-made geometry anchored to the glass — which is
 * exactly the reference frame a trip must not hand the eye — and that the
 * project therefore has three HUD elements and no more.
 *
 * A Discord-shaped feature is, on the face of it, a direct assault on that: a
 * message list, a member list, a control bar. So none of them are persistent.
 * Chat appears when somebody speaks and fades out on its own. The roster exists
 * only while a key is held. The share bar is drawn only inside a room and hides
 * itself when nothing is happening. Nothing here is on screen while you are
 * walking through a wood on your own, which is the state the original rule was
 * written to protect — and everything here fades further as a trip deepens, on
 * the same curve `hud.js` fades the phase readout.
 *
 * TEXT IS SET WITH `textContent`. Names and messages come off a socket from
 * another person; the server strips control characters and bidi overrides
 * because those are invisible, but it does not and should not attempt to
 * sanitise markup. Nothing in this file ever assigns `innerHTML` from network
 * data. The two places that do use `innerHTML` are building markup from
 * constants in this file, and both are marked.
 */

/** How long a line stays before it starts to go. */
const LINE_LIFE_MS = 22_000;
const LINE_FADE_MS = 2_400;
/** The most lines that can be on screen at once. */
const MAX_LINES = 9;

export class Social {
  /**
   * @param {object} deps
   * @param {import('../net/index.js').Multiplayer} deps.net
   * @param {import('./hud.js').Hud} deps.hud
   * @param {import('../player/controller.js').Controller} deps.controller
   */
  constructor({ net, hud, controller, seed }) {
    this.net = net;
    this.hud = hud;
    this.controller = controller;
    this.seed = seed;

    this.root = document.getElementById('social');
    this.logEl = document.getElementById('chat-log');
    this.formEl = document.getElementById('chat-form');
    this.inputEl = document.getElementById('chat-input');
    this.rosterEl = document.getElementById('roster');
    this.rosterBodyEl = document.getElementById('roster-body');
    this.barEl = document.getElementById('share-bar');

    this.inputEl.maxLength = CHAT_MAX_CHARS;

    /** @type {{el: HTMLElement, at: number}[]} */
    this._lines = [];
    this._rosterOpen = false;
    this._typing = false;
    /** Set by main.js each frame; fades the whole layer as the trip deepens. */
    this.tripLevel = 0;

    this._bind();
  }

  get typing() {
    return this._typing;
  }

  /**
   * What colour to draw somebody's name.
   *
   * Goes through the net layer so that a chosen dye and the wool on the actual
   * body cannot come apart — see the long note at the colour's use site. The
   * fallback covers the cases the net layer has never heard of: a line in your
   * own log from before you joined anything, and the system lines that have a
   * name but no id. Both used to be all this function did.
   */
  _hue(id) {
    const asked = this.net?.hueFor?.(id);
    return Number.isFinite(asked) ? asked : hueOf(String(id ?? ''), null);
  }

  _bind() {
    this.formEl.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.inputEl.value.trim();
      this.inputEl.value = '';
      this.closeInput();
      if (!text) return;
      /**
       * `/seed`, Minecraft-style: a local-only line, never sent to anyone else.
       * This used to be a toast fired automatically on arrival; now the wood's
       * name is something you ask for instead of something shouted at you.
       */
      if (text === '/seed') {
        this.push({ kind: 'system', text: `This wood is ${this.seed}.` });
        return;
      }
      /**
       * A line typed with nobody to hear it is not an error and must not be
       * swallowed either. It goes in your own log, greyed, so that the act of
       * typing always produces something — a text box that eats what you wrote
       * is the fastest way to make somebody stop trusting it.
       */
      if (!this.net.say(text)) {
        this.push({ kind: 'system', text: 'Nobody is here to hear that. Press J.' });
      }
    });

    this.inputEl.addEventListener('keydown', (event) => {
      // Stop every key reaching the world while somebody is typing. Without
      // this, writing "was" walks you forward and "s" walks you back.
      event.stopPropagation();
      if (event.key === 'Escape') {
        this.inputEl.value = '';
        this.closeInput();
      }
    });
    this.inputEl.addEventListener('keyup', (event) => event.stopPropagation());
    this.inputEl.addEventListener('blur', () => this.closeInput());

    window.addEventListener('keydown', (event) => {
      if (this._typing) return;
      if (event.target instanceof HTMLInputElement) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.code) {
        case 'Enter':
        case 'KeyT':
          event.preventDefault();
          this.openInput();
          break;
        case 'Tab':
          // Tab would otherwise walk the browser's focus ring through a page
          // that has exactly one focusable element in it, and hide the pointer
          // lock behind a focus change.
          event.preventDefault();
          this.setRoster(true);
          break;
        default:
          break;
      }
    });

    window.addEventListener('keyup', (event) => {
      if (event.code === 'Tab') this.setRoster(false);
    });
    // Alt-tabbing away with the roster up would otherwise leave it up for ever.
    window.addEventListener('blur', () => this.setRoster(false));
  }

  // ------------------------------------------------------------------ input

  openInput() {
    if (this._typing) return;
    this._typing = true;
    this.formEl.hidden = false;
    /**
     * Pointer lock has to go, and this is the whole reason the chat box is a
     * real `<input>` rather than a key-capture overlay.
     *
     * While the pointer is locked the mouse turns the player, and a text field
     * that steals the keyboard but leaves the mouse driving is a way to type a
     * sentence and find yourself facing a different tree. Releasing the lock
     * also gives the browser back its own text-editing behaviour — selection,
     * the clipboard, an IME for anybody not typing in English — none of which is
     * worth reimplementing and all of which people expect.
     */
    if (document.pointerLockElement) document.exitPointerLock();
    this.controller.keys.clear();
    this.inputEl.focus();
  }

  closeInput() {
    if (!this._typing) return;
    this._typing = false;
    this.formEl.hidden = true;
    this.inputEl.blur();
  }

  setRoster(open) {
    if (open === this._rosterOpen) return;
    this._rosterOpen = open;
    this.rosterEl.hidden = !open;
    if (open) this._drawRoster();
  }

  // -------------------------------------------------------------------- log

  /**
   * @param {object} line
   * @param {'chat'|'note'|'system'} line.kind
   * @param {string} [line.name]
   * @param {string} [line.id] used for the colour, never displayed
   * @param {string} line.text
   */
  push(line) {
    const el = document.createElement('div');
    el.className = `chat-line chat-${line.kind}`;

    if (line.name) {
      const who = document.createElement('b');
      who.textContent = line.kind === 'note' ? line.name : `${line.name}`;
      /**
       * The name is drawn in the same hue as that person's clothes.
       *
       * `avatar.js` refuses to give anybody a nameplate, for good reasons it
       * sets out at length — so the log is the only place a name appears at all,
       * and this is what connects the name to the body. "The green one said
       * that" is a sentence that works without anything having been labelled.
       *
       * ASKED OF THE NET LAYER RATHER THAN COMPUTED HERE, since the menu let
       * people choose. It used to be a direct call to `hueFromId`, which was the
       * same pure function the wool was dyed with and therefore could not
       * disagree with it — and the moment a dye could be chosen, it could. A
       * chosen colour that reached the body and not the log would cut the one
       * thread this line exists to hold, for exactly the people who cared enough
       * to pick. `hueFor` falls back to `hueFromId` for anybody it does not know.
       */
      who.style.color = `hsl(${Math.round(this._hue(line.id ?? line.name) * 360)}deg 52% 68%)`;
      el.append(who);
      el.append(document.createTextNode(line.kind === 'note' ? ' ' : ': '));
    }

    const body = document.createElement('span');
    /**
     * `textContent`, always. This string came off a socket from another person.
     * The one exception in this file is the fishing curiosity table, which is a
     * constant in `fishing.js` and arrives as a note the local client generated
     * — and it is still set as text here rather than parsed, so its `<i>` shows
     * up as characters rather than as italics. That is the right trade: one
     * cosmetic loss, no path from a peer's keyboard to this page's DOM.
     */
    body.textContent = line.text;
    el.append(body);

    this.logEl.append(el);
    this._lines.push({ el, at: performance.now() });
    while (this._lines.length > MAX_LINES) this._lines.shift().el.remove();
  }

  /** Called once a frame by main.js. Cheap: it usually does nothing at all. */
  update(dt) {
    void dt;
    const now = performance.now();
    for (let i = this._lines.length - 1; i >= 0; i--) {
      const line = this._lines[i];
      const age = now - line.at;
      if (age < LINE_LIFE_MS) continue;
      if (age > LINE_LIFE_MS + LINE_FADE_MS) {
        line.el.remove();
        this._lines.splice(i, 1);
        continue;
      }
      line.el.style.opacity = String(1 - (age - LINE_LIFE_MS) / LINE_FADE_MS);
    }

    /**
     * The whole layer recedes as a trip deepens, on the same curve `hud.js`
     * uses for the phase readout. It never goes entirely — being unable to read
     * what a friend is saying to you because you ate a mushroom would be a
     * genuinely bad outcome, and the one thing this layer is for is the people.
     */
    const dim = Math.max(0.35, 1 - this.tripLevel * 0.55);
    if (this.root.style.opacity !== String(dim)) this.root.style.opacity = String(dim);

    if (this._rosterOpen) this._drawRoster();
  }

  // ----------------------------------------------------------------- roster

  _drawRoster() {
    const rows = [];
    const you = {
      name: 'you',
      // Your own dye explicitly, because you have no player id until a socket
      // has said welcome — and on a solitary walk there is never going to be
      // one. Without this your dot is coloured by hashing the word "you", which
      // is stable, arbitrary, and not the colour you are actually wearing.
      hue: this.net.me?.hue,
      distance: 0,
      speaking: this.net.microphone?.speaking ?? false,
      muted: this.net.microphone?.muted ?? false,
      present: this.net.share?.placement ?? null,
      self: true,
    };
    rows.push(you);
    for (const peer of this.net.peers) {
      rows.push({
        name: peer.name,
        id: peer.id,
        hue: peer.hue,
        distance: peer.distance,
        speaking: peer.speaking,
        voice: peer.voice,
        present: peer.present,
        rtt: peer.connection?.rtt ?? 0,
      });
    }

    this.rosterBodyEl.replaceChildren();
    for (const row of rows) {
      const el = document.createElement('div');
      el.className = `roster-row${row.self ? ' roster-self' : ''}`;

      const dot = document.createElement('i');
      dot.className = 'roster-dot';
      const hue = Number.isFinite(row.hue) ? row.hue : this._hue(row.id ?? row.name);
      dot.style.background = `hsl(${Math.round(hue * 360)}deg 44% 52%)`;
      if (row.speaking) dot.classList.add('speaking');
      el.append(dot);

      const name = document.createElement('span');
      name.className = 'roster-name';
      name.textContent = row.name;
      el.append(name);

      const state = document.createElement('span');
      state.className = 'roster-state';
      /**
       * What is worth knowing about a person here, in order: are they sharing
       * something, can they talk, and how far away are they. Distance is the one
       * a player will actually use — "who is near the fire" is the question this
       * panel exists to answer, and it is the one a normal member list cannot.
       */
      const bits = [];
      /**
       * The SIZE, because it is the only part of a placement worth a row in a
       * list. Where a screen is, is a thing you find by walking — and now that
       * every share is standing somewhere, "sharing" on its own would be a word
       * that told you nothing the distance column does not.
       */
      if (row.present) bits.push(`screen up · ${row.present.w.toFixed(1)} m`);
      if (row.muted) bits.push('muted');
      else if (!row.self && row.voice === false) bits.push('no voice');
      if (!row.self) bits.push(`${Math.round(row.distance)} m`);
      state.textContent = bits.join(' · ');
      el.append(state);

      this.rosterBodyEl.append(el);
    }

    const head = this.rosterEl.querySelector('#roster-head');
    const room = this.net.room;
    head.textContent = room
      ? `${rows.length} in ${room}${this.net.latency ? ` · ${Math.round(this.net.latency)} ms` : ''}`
      : 'You are on your own. Press J to open a room.';
  }

  // ------------------------------------------------------------------- bar

  /**
   * The share bar: a line of text, not buttons.
   *
   * Buttons would need a cursor, and a cursor needs the pointer lock released,
   * which means every share control would first make you stop being able to
   * look around. Keys do not. So this is a readout of what is available and
   * what is happening, and the keys are in it — which is also how the rest of
   * this game's affordances work.
   */
  setBar(html) {
    if (!html) {
      this.barEl.hidden = true;
      return;
    }
    if (this.barEl.dataset.text === html) return;
    this.barEl.dataset.text = html;
    // Built from constants in main.js, never from network data. See the header.
    this.barEl.innerHTML = html;
    this.barEl.hidden = false;
  }
}
