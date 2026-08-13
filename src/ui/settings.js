import { KNOBS, LEVELS, quality } from '../core/quality.js';
import { BINDING_GROUPS, bindingsIn, keyCaps } from '../core/keys.js';

/**
 * The settings menu.
 *
 * The project's rule about chrome is that every pixel of persistent DOM is a
 * piece of perfectly stable, perfectly rectangular, unmistakably man-made
 * geometry anchored to the glass — which is the one reference frame a trip must
 * not hand the eye. This panel is allowed to be a proper full panel anyway,
 * because it is MODAL AND TRANSIENT: while it is up you are not looking at the
 * forest, and the instant it closes it is `hidden`, `display: none`, out of the
 * layout, out of the hit-testing, and gone. There is no persistent settings
 * button in a corner, and there will not be one.
 *
 * It reads and writes the registry in core/quality.js and knows nothing about
 * the renderer, the audio graph or the controller. A control whose knob nobody
 * has registered draws disabled with a note rather than throwing.
 *
 *
 * POINTER LOCK, WHICH IS THE ACTUAL HARD PART.
 *
 * Escape is not a key you can listen for while the pointer is locked. The
 * browser reserves it to break the lock itself, and in Chrome it never reaches
 * the page — you get a `pointerlockchange` and nothing else. So this listens
 * for BOTH, and treats them as two halves of one gesture:
 *
 *   - a pointer lock we did not ask to lose  ->  open the menu
 *   - an Escape keydown while the menu is up ->  close it and re-lock
 *
 * The "we did not ask to lose" clause matters: the debug panel and the chat
 * box (`social.js`'s `openInput`) both deliberately exit pointer lock when
 * they open, and without that guard pressing backtick or Enter/T would
 * silently open this menu underneath either of them.
 *
 * Re-locking on close is best-effort by necessity. `requestPointerLock()` needs
 * a user gesture and Chrome additionally refuses for about a second after the
 * user has broken a lock with Escape — which is exactly the interval this asks
 * in. The rejection arrives as a rejected promise on modern Chrome and as a
 * silent no-op elsewhere, so both are swallowed, and the fallback is the one
 * the game already had: the controller re-locks on the next canvas click, and
 * the crosshair being dark is the cue that it needs one.
 *
 * A refusal is not always a refusal, though, and that is the subtle half: inside
 * that cooldown Chrome sometimes GRANTS the lock and then breaks it again a
 * frame or two later. The break is an ordinary `pointerlockchange` with nothing
 * on it to say the engine caused it, so it reads exactly like the player
 * pressing Escape — the one signal this opens the menu on. Hence MIN_LOCK_MS.
 */

/** How often the live readout refreshes while the panel is open, in ms. */
const READOUT_PERIOD_MS = 250;

/**
 * The shortest gap between two Escapes that counts as two gestures.
 *
 * Deliberately generous. The thing being defended against is one long press
 * arriving as several events across two listeners and a `pointerlockchange`,
 * which happens inside a few milliseconds; nobody deliberately opens and closes
 * a settings menu five times a second, so a fifth of a second costs a real
 * user nothing and covers the whole race comfortably.
 */
const TOGGLE_COOLDOWN_MS = 200;

/**
 * How long a pointer lock has to survive before losing it counts as a gesture.
 *
 * THIS IS THE "CLOSES AND REOPENS IMMEDIATELY" FIX, and it is a different bug
 * from the one `_waitForEscapeRelease` handles even though they end the same
 * way. That one is about the key still being physically down when the relock
 * lands. This one happens with the key long since up: the relock lands inside
 * Chrome's post-Escape cooldown, Chrome grants it anyway, and then takes it
 * straight back. The take-back fires a `pointerlockchange` that is byte for
 * byte the one a player breaking a lock with Escape produces, and `_onLockChange`
 * did what it says it does — opened the menu.
 *
 * There is no flag on the event to tell the two apart, but there is a duration.
 * A lock the player was actually using has to have existed long enough for them
 * to notice the pointer vanish and decide to press Escape; a lock the engine
 * revoked dies in a frame or two. Anything under this threshold was never a
 * lock anybody looked at, so losing it is a failed relock — not a request for
 * this menu. A quarter of a second is far longer than the revoke (single-digit
 * milliseconds, measured) and far shorter than any human's lock-look-decide.
 */
const MIN_LOCK_MS = 250;

/**
 * THE PAGES, AND WHY THERE ARE FOUR OF THEM RATHER THAN ONE SCROLL.
 *
 * This was one column of five headings — Quality, Graphics, Sound, Comfort,
 * Stats — with nineteen controls on it at once, one of which was a heading with
 * a single toggle under it. Every game that has shipped an options screen has
 * converged on the same four rooms instead, and it is not fashion: a settings
 * menu is a place you arrive at with ONE thing you want to change, and the job
 * of the top of it is to answer "which of these four is my thing in" in about a
 * second. Graphics / Sound / Controls / Accessibility does that. Five headings
 * on a scroll does not, because "Comfort" answers it for nobody — the person
 * who wants the mouse slower and the person who is getting motion sick are two
 * people, and that heading was the only home either of them had.
 *
 * The tab strip is `role="tablist"` with the real keyboard behaviour — arrows
 * move, the page follows — because a modal panel you can only operate with a
 * mouse is a modal panel that has taken the mouse away from you.
 */
const PAGES = [
  { id: 'graphics', title: 'Graphics' },
  { id: 'audio', title: 'Sound' },
  { id: 'controls', title: 'Controls' },
  { id: 'accessibility', title: 'Accessibility' },
];

// "Potato" rather than "Lowest" or "Performance", because it is the word people
// already use for this and it sets the expectation the rung needs: it does not
// look like the game, and choosing it is not a compromise you should feel bad
// about. Every other label here is a degree; this one is a different thing.
const LEVEL_LABELS = {
  potato: 'Potato',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  ultra: 'Ultra',
};

export class SettingsMenu {
  constructor(settings = quality) {
    this.settings = settings;
    this.open = false;
    this._rows = new Map();
    this._selfExit = false;
    this._wasLocked = false;
    /** `performance.now()` of the last pointer lock we were granted. See MIN_LOCK_MS. */
    this._lockedAt = 0;
    this._readout = null;
    /** `performance.now()` of the last open or close. See TOGGLE_COOLDOWN_MS. */
    this._lastToggle = 0;
    /** Physical Escape key state, tracked independently of who handles the event. See `_waitForEscapeRelease`. */
    this._escapeDown = false;
    /**
     * Automation never gets the menu opened at it by surprise. play-check and
     * debug-check click through the gate and drive the world with the keyboard;
     * a modal panel appearing over the canvas because something touched pointer
     * lock would fail them in a way that looks like a rendering bug. A test that
     * wants to exercise this path sets the flag.
     */
    this.allowAutomationAutoOpen = false;

    this.el = document.createElement('div');
    this.el.id = 'settings';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-label', 'Settings');
    this.el.innerHTML = SHELL;
    document.body.appendChild(this.el);

    this._buildTabs();
    this._buildPresets();
    this._buildPages();
    this._buildControlsReference();
    this._bind();
    this.showPage(this._page);
    this._unsubscribe = this.settings.subscribe(() => this.refresh());
    this.refresh();
  }

  /* ---- construction ---------------------------------------------------- */

  _buildPresets() {
    const host = this.el.querySelector('#set-presets');
    this._presetButtons = new Map();
    for (const mode of ['auto', ...LEVELS]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'set-preset';
      b.dataset.mode = mode;
      b.textContent = mode === 'auto' ? 'Auto' : LEVEL_LABELS[mode];
      b.addEventListener('click', () => this.settings.setMode(mode));
      host.appendChild(b);
      this._presetButtons.set(mode, b);
    }
  }

  _buildTabs() {
    const host = this.el.querySelector('#set-tabs');
    this._tabButtons = new Map();
    for (const page of PAGES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'set-tab';
      b.dataset.page = page.id;
      b.setAttribute('role', 'tab');
      b.textContent = page.title;
      b.addEventListener('click', () => this.showPage(page.id));
      host.appendChild(b);
      this._tabButtons.set(page.id, b);
    }
    this._page = PAGES[0].id;
  }

  /**
   * Which page you are looking at.
   *
   * Kept across an open/close within a session on purpose: somebody tuning the
   * volume against a record playing opens this menu five times in a minute, and
   * being dropped back on Graphics every time is the whole cost of tabs with
   * none of the benefit.
   */
  showPage(id) {
    if (!this._tabButtons.has(id)) return;
    this._page = id;
    for (const [pageId, button] of this._tabButtons) {
      const on = pageId === id;
      button.classList.toggle('on', on);
      button.setAttribute('aria-selected', String(on));
      // Roving tabindex: Tab enters the strip once and lands on the selected
      // tab, arrows move within it. Four stops on the way into the panel is
      // what makes a tab strip worse than the scroll it replaced.
      button.tabIndex = on ? 0 : -1;
    }
    for (const section of this.el.querySelectorAll('.set-page')) {
      section.hidden = section.dataset.page !== id;
    }
    // A page you have scrolled and left comes back at the top, because you are
    // arriving at it rather than returning to it.
    const body = this.el.querySelector('.set-body');
    if (body) body.scrollTop = 0;
  }

  _buildPages() {
    for (const page of PAGES) {
      const basic = this.el.querySelector(`#set-${page.id}`);
      const advanced = this.el.querySelector(`#set-${page.id}-advanced`);
      let advancedCount = 0;
      for (const knob of KNOBS) {
        if (knob.group !== page.id) continue;
        const host = knob.advanced && advanced ? advanced : basic;
        if (knob.advanced && advanced) advancedCount++;
        host.appendChild(this._buildRow(knob));
      }
      // A disclosure with nothing behind it is a promise of more settings that
      // there are none of.
      const fold = advanced?.closest('.set-advanced');
      if (fold) fold.hidden = advancedCount === 0;
    }
  }

  /**
   * THE CONTROLS LIST, WHICH IS THE HALF OF THIS PANEL THAT DID NOT EXIST.
   *
   * There was nowhere in the game to find out what a key did. The only key
   * reference anywhere was one 11px line of hand-written HTML across the bottom
   * of the screen with `white-space: nowrap` on it and fourteen items in it, so
   * on any window narrower than about 1050 px it ran off both ends — and it had
   * drifted from the code it described: it named `~` for a panel that opens on
   * `` ` ``, and it never mentioned Space, Q, X, C, the scroll wheel or
   * dropping a file in.
   *
   * Every game with more than six verbs puts the list here instead, and this
   * one has twenty. It is rendered from src/core/keys.js rather than typed,
   * which is the only part of this that stops it going stale again.
   */
  _buildControlsReference() {
    const host = this.el.querySelector('#set-bindings');
    if (!host) return;
    for (const group of BINDING_GROUPS) {
      const rows = bindingsIn(group.id);
      if (!rows.length) continue;

      const heading = document.createElement('h4');
      heading.className = 'set-keys-head';
      heading.textContent = group.title;
      host.appendChild(heading);

      for (const binding of rows) {
        const row = document.createElement('div');
        row.className = 'set-keys-row';

        const keys = document.createElement('span');
        keys.className = 'set-keys';
        keys.innerHTML = keyCaps(binding);
        row.appendChild(keys);

        const what = document.createElement('span');
        what.className = 'set-keys-what';
        what.textContent = binding.label;
        if (binding.note) {
          const note = document.createElement('i');
          note.className = 'set-keys-note';
          note.textContent = binding.note;
          what.appendChild(note);
        }
        row.appendChild(what);

        host.appendChild(row);
      }
    }
  }

  _buildRow(knob) {
    const row = document.createElement('div');
    row.className = 'set-row';
    row.dataset.knob = knob.id;

    const label = document.createElement('label');
    label.className = 'set-label';
    label.textContent = knob.label;
    if (knob.hint) label.title = knob.hint;
    row.appendChild(label);

    const control = document.createElement('div');
    control.className = 'set-control';
    row.appendChild(control);

    const value = document.createElement('span');
    value.className = 'set-value';
    row.appendChild(value);

    const entry = { knob, row, control, value, inputs: [] };

    if (knob.kind === 'range') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(knob.min);
      input.max = String(knob.max);
      input.step = String(knob.step);
      // `input`, not `change`: a slider you have to let go of before anything
      // happens is a slider you cannot tune a picture with.
      input.addEventListener('input', () => this.settings.set(knob.id, Number(input.value)));
      control.appendChild(input);
      entry.inputs.push(input);
    } else if (knob.kind === 'toggle') {
      const input = document.createElement('button');
      input.type = 'button';
      input.className = 'set-toggle';
      input.addEventListener('click', () => this.settings.set(knob.id, !this.settings.get(knob.id)));
      control.appendChild(input);
      entry.inputs.push(input);
    } else if (knob.kind === 'enum') {
      control.classList.add('set-segment');
      for (const option of knob.options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.value = String(option.value);
        b.textContent = option.label;
        b.addEventListener('click', () => this.settings.set(knob.id, option.value));
        control.appendChild(b);
        entry.inputs.push(b);
      }
    }

    this._rows.set(knob.id, entry);
    return row;
  }

  /* ---- state ----------------------------------------------------------- */

  refresh() {
    const s = this.settings;
    for (const [mode, button] of this._presetButtons) {
      button.classList.toggle('on', s.mode === mode);
    }
    this.el.querySelector('#set-mode').classList.toggle('custom', s.mode === 'custom');

    for (const [id, entry] of this._rows) {
      const { knob } = entry;
      const value = s.get(id);
      const wired = s.has(id);

      /**
       * A GATED CONTROL IS DISABLED, NOT MERELY FADED.
       *
       * This used to set `.inert` — 42% opacity — and stop there, leaving the
       * control fully clickable underneath it. Both of the dependants here are
       * reachable that way and both do something the greying promises they
       * cannot:
       *
       *   Shadow detail, with Shadows off, still ran main.js's setter. That
       *   setter disposes the shadow map and sets `mapSize`, and with the
       *   shadow pass switched off nothing re-allocates it — so the click looks
       *   like it did nothing, and then the moment Shadows is switched back on
       *   the map comes back at whatever resolution the greyed-out control was
       *   nudged to. Setting 4096 through a dead-looking control and getting
       *   4096 several minutes later is exactly "the slider changed the wrong
       *   thing", and it is invisible at the moment of the click.
       *
       *   Luminous wake, with Bloom off, still flipped `pipeline.trailEnabled`.
       *   That one is harmless today only because the output pass zeroes the
       *   glow term whenever bloom is off — it is a dependant that happens not
       *   to have a stale-value path, not one that is protected from having one.
       *
       * So `disabled` now covers both reasons a control cannot matter: nobody
       * claimed the knob, or its dependency is off. The two keep separate
       * classes because they are different facts about the build and deserve
       * different explanations in the tooltip, but neither may be clicked.
       */
      const gated = knob.dependsOn ? !s.get(knob.dependsOn) : false;
      const live = wired && !gated;

      if (knob.kind === 'range') {
        const input = entry.inputs[0];
        if (document.activeElement !== input) input.value = String(value);
        input.disabled = !live;
      } else if (knob.kind === 'toggle') {
        const input = entry.inputs[0];
        input.textContent = value ? 'On' : 'Off';
        input.classList.toggle('on', Boolean(value));
        input.disabled = !live;
      } else if (knob.kind === 'enum') {
        for (const b of entry.inputs) {
          b.classList.toggle('on', String(value) === b.dataset.value);
          b.disabled = !live;
        }
      }

      entry.value.textContent = knob.format ? knob.format(value) : '';
      // A knob nobody claimed is shown, disabled, and says why. Hiding it would
      // make a half-wired build look like a build with fewer features, which is
      // the harder bug to notice.
      entry.row.classList.toggle('unwired', !wired);
      entry.row.classList.toggle('inert', gated);
      entry.row.title = !wired
        ? `${knob.label}: nothing has registered this knob yet.`
        : gated
          ? `${knob.label}: ${s.knob(knob.dependsOn)?.label ?? knob.dependsOn} is off, so this cannot matter.`
          : knob.hint ?? '';
    }

    this._paintStatus();
  }

  /**
   * TWO READOUTS, BECAUSE THERE ARE TWO AUDIENCES AND THEY WANTED OPPOSITE
   * THINGS FROM THE SAME LINE.
   *
   * It used to be one line under the preset row reading, in full,
   *
   *   60 fps · 16.7 ms p95 · 3.1% late · settling · last change: High at 4.2%
   *   late, p95 21.4 ms
   *
   * every quarter of a second, forever, directly under the buttons a player
   * came here to press. Every number in it is real and two of them are things
   * only this file's author has ever needed: `p95` and `% late` are the
   * governor's own decision variables, named after the statistics rather than
   * after anything you can see, and a player reading "3.1% late" learns that
   * something is wrong and nothing about what.
   *
   * So the top line stays and says the one thing the preset row cannot: WHICH
   * RUNG AUTO IS ACTUALLY STANDING ON, which is the whole failure mode of an
   * adaptive setting — a player who cannot tell whether the machine or their
   * last click is responsible for what they are looking at. The diagnostics
   * move down into the Advanced fold, unchanged and complete, next to the knobs
   * you would be reading them in order to move. Nothing was deleted; it is
   * filed with the audience that asks for it.
   */
  _paintStatus() {
    const s = this.settings.status();
    const mode = this.el.querySelector('#set-mode');
    const detail = this.el.querySelector('#set-detail');

    if (s.mode === 'auto') {
      mode.textContent = `Auto — currently ${LEVEL_LABELS[s.autoLevel]}`;
    } else if (s.mode === 'custom') {
      mode.textContent = `Custom — built on ${LEVEL_LABELS[s.autoLevel]}, Auto is off`;
    } else {
      mode.textContent = `${LEVEL_LABELS[s.mode]} — Auto is off`;
    }

    // Nothing below is painted while the fold is shut, which is also what stops
    // this doing layout four times a second for nobody.
    if (!detail || detail.closest('.set-advanced')?.open === false) return;

    const bits = [];
    if (s.samples > 0) {
      bits.push(`${s.fps.toFixed(0)} fps`);
      bits.push(`${(s.p95 * 1000).toFixed(1)} ms p95`);
      // The number Auto actually decides on, shown rather than hidden: if it
      // moves a setting the player can see the reading that made it.
      bits.push(`${(s.late * 100).toFixed(1)}% late`);
    }
    if (!s.running) bits.push('measurement off');
    else if (s.settling) bits.push('settling');
    else if (s.paused) bits.push('held while this menu is open');
    if (s.lastChange && s.mode === 'auto') {
      bits.push(`last change: ${LEVEL_LABELS[s.lastChange.level]} at ${s.lastChange.why}`);
    }
    detail.textContent = bits.join(' · ');
  }

  /* ---- opening and closing --------------------------------------------- */

  show(reason = 'manual') {
    if (this.open) return;
    this.open = true;
    this.el.hidden = false;
    document.body.classList.add('settings-open');
    /**
     * Measure but do not act while the panel is up.
     *
     * The readout has to stay live — "show clearly what Auto has currently
     * chosen" is worthless if it is frozen — but a quality change happening
     * under the player's cursor while they are reading the panel is exactly the
     * "Auto is fighting me" impression the whole design is trying to avoid.
     */
    this.settings.auto.paused = true;
    if (reason !== 'pointerlock' && document.pointerLockElement) {
      this._selfExit = true;
      document.exitPointerLock();
    }
    this._readout = window.setInterval(() => this._paintStatus(), READOUT_PERIOD_MS);
    this.refresh();
    // Focus the panel itself rather than a control: focusing a slider means the
    // first arrow key the player presses changes a setting they were not aiming
    // at, and focusing nothing leaves Escape to the window handler anyway.
    this.el.querySelector('.set-panel').focus({ preventScroll: true });
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.el.hidden = true;
    document.body.classList.remove('settings-open');
    this.settings.auto.paused = false;
    if (this._readout !== null) window.clearInterval(this._readout);
    this._readout = null;
    this._relock();
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }

  /** True once the entry gate has been dismissed. */
  _inWorld() {
    const gate = document.getElementById('gate');
    return !gate || gate.classList.contains('gone');
  }

  /** The debug panel exits pointer lock on purpose; that is not a menu request. */
  _debugOpen() {
    const debug = document.getElementById('debug');
    return Boolean(debug) && !debug.hidden;
  }

  /** So does opening chat (`social.js`'s `openInput`) — same non-request as the debug panel. */
  _chatOpen() {
    const form = document.getElementById('chat-form');
    return Boolean(form) && !form.hidden;
  }

  /** So does the jukebox's paste-a-link box (jukebox-input.js's open) - same non-request. */
  _jukeboxOpen() {
    const form = document.getElementById('jukebox-form');
    return Boolean(form) && !form.hidden;
  }

  /** Resolves once Escape is physically up — immediately if it already is. */
  _waitForEscapeRelease() {
    if (!this._escapeDown) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        window.removeEventListener('keyup', onKeyUp, true);
        window.removeEventListener('blur', done);
        clearTimeout(timer);
        resolve();
      };
      const onKeyUp = (e) => {
        if (e.code === 'Escape') done();
      };
      window.addEventListener('keyup', onKeyUp, true);
      // A keyup delivered to somebody else is a keyup we will never see, so
      // losing focus counts as released. Without this the wait below runs its
      // full two seconds and then relocks out of the blue, long after the
      // gesture that asked for it — which is its own small version of this
      // module's whole problem.
      window.addEventListener('blur', done);
      // Safety net: if the keyup never arrives — focus left the page mid-press,
      // the tab was backgrounded — don't leave the pointer unlocked forever.
      const timer = setTimeout(done, 2000);
    });
  }

  async _relock() {
    // main.js and controller.js both skip requestPointerLock under webdriver so
    // the Playwright harness can drive the page; this has to skip it for the
    // same reason, or `npm run check` starts failing on a permissions prompt.
    if (navigator.webdriver) return;
    if (!this._inWorld()) return;
    const canvas = document.getElementById('view');
    if (!canvas || document.pointerLockElement === canvas) return;
    /**
     * Closing the menu WITH Escape is the normal case, and the same physical
     * keypress that closed it is very often still down at this point — a tap
     * has a real, measurable duration, and this runs synchronously off the
     * keydown. Chrome watches the Escape key's physical state independently
     * of events: if it grants a pointer lock while Escape is still held, it
     * immediately breaks that lock again. That break fires `pointerlockchange`
     * indistinguishable from a genuine unrequested loss, and `_onLockChange`
     * would reopen the menu we just closed — the "closes and reopens
     * immediately" flicker. Waiting for the keyup here means the lock is
     * requested with the key already up, so Chrome has no reason to kill it.
     */
    await this._waitForEscapeRelease();
    // Whatever we were relocking for may no longer hold: the player could have
    // reopened this menu, or opened chat, in the time it took Escape to come
    // back up. Stealing the lock out from under either is the same mistake
    // `_onLockChange` guards against below, just approached from the other end.
    if (this.open || this._chatOpen() || document.pointerLockElement === canvas) return;
    try {
      const result = canvas.requestPointerLock();
      // Chrome returns a promise and rejects it when the request lands inside
      // the cooldown after a user-initiated Escape. Older engines return
      // undefined and fail silently. Neither may throw out of here.
      if (result && typeof result.then === 'function') await result;
    } catch {
      /* the controller's canvas click handler is the fallback, and it is enough */
    }
  }

  /* ---- wiring ---------------------------------------------------------- */

  _bind() {
    this.el.querySelector('#set-close').addEventListener('click', () => this.hide());
    this.el.querySelector('#set-reset').addEventListener('click', () => this.settings.reset());
    this.el.querySelector('.set-scrim').addEventListener('click', () => this.hide());

    /**
     * Physical Escape down/up, independent of open/close logic entirely.
     *
     * Capture phase, so this sees the key before the panel's bubble-phase
     * listener below can `stopPropagation()` it away. `_relock` reads
     * `_escapeDown` to avoid requesting pointer lock while the very key that
     * closed the menu is still physically pressed.
     */
    this._onEscapeDown = (e) => {
      if (e.code === 'Escape') this._escapeDown = true;
    };
    this._onEscapeUp = (e) => {
      if (e.code === 'Escape') this._escapeDown = false;
    };
    // Alt-tab away mid-press and the keyup lands in another window. The flag
    // would stay stuck down for the rest of the session, and every later close
    // would sit out the two-second safety net before relocking.
    this._onBlur = () => { this._escapeDown = false; };
    window.addEventListener('keydown', this._onEscapeDown, true);
    window.addEventListener('keyup', this._onEscapeUp, true);
    window.addEventListener('blur', this._onBlur);

    /**
     * Keys pressed inside the panel stop here.
     *
     * The controller and main.js both listen on `window` and both only ignore
     * events whose target is an `<input>` — a focused BUTTON would still feed
     * Space to the jump handler and `E` to the interact handler. Swallowing
     * everything at the panel keeps the world from reacting to somebody
     * tabbing through a settings dialog.
     */
    /**
     * Arrows move between tabs, and they only do it while a tab has focus.
     *
     * The ARIA tab pattern, and the reason it is worth the fifteen lines: this
     * panel is opened by a key, on a page where the mouse has just been taken
     * away from the player by pointer lock being broken. Reaching for the mouse
     * to change page is the exact gesture the keyboard shortcut existed to
     * avoid. Scoped to the tab strip rather than the panel because Left and
     * Right on a focused SLIDER are how you nudge it, and a stray arrow key
     * changing the page out from under a value somebody is tuning is worse
     * than no shortcut at all.
     */
    this.el.querySelector('#set-tabs').addEventListener('keydown', (e) => {
      const delta = e.code === 'ArrowRight' ? 1 : e.code === 'ArrowLeft' ? -1 : 0;
      if (!delta) return;
      e.preventDefault();
      const ids = PAGES.map((p) => p.id);
      const next = ids[(ids.indexOf(this._page) + delta + ids.length) % ids.length];
      this.showPage(next);
      this._tabButtons.get(next)?.focus({ preventScroll: true });
    });

    // Opening the fold has to paint the readout that lives in it. It is
    // refreshed on a timer that skips it while it is shut, so without this the
    // first quarter-second of an open shows the last values from the previous
    // time — or, on the first open of a session, nothing at all.
    this.el.querySelector('.set-advanced')?.addEventListener('toggle', () => this._paintStatus());

    this.el.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        // Auto-repeat is swallowed here as well as on window, and this is the
        // arm that actually produced the strobe. `show()` focuses the panel, so
        // once the menu is up every repeat targets it and is handled here; this
        // hides the panel, focus falls back to the body, the NEXT repeat misses
        // the panel and reaches the window handler, which opens it again. The
        // two listeners were passing one held key back and forth between them
        // at the OS repeat rate.
        if (e.repeat) {
          e.stopPropagation();
          return;
        }
        // Same cooldown as the window handler below, and for the same reason:
        // when `pointerlockchange` opens this panel it focuses it in the same
        // tick, so the very next keydown — the one genuinely still breaking
        // the lock, not a repeat — lands here instead of on window. Without
        // this check that "first" keydown closed the panel the lock-change
        // handler had just opened.
        const now = performance.now();
        if (now - this._lastToggle < TOGGLE_COOLDOWN_MS) {
          e.stopPropagation();
          return;
        }
        this._lastToggle = now;
        this.hide();
      }
      e.stopPropagation();
    });

    this._onKey = (e) => {
      if (e.code !== 'Escape') return;
      if (e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      /**
       * HOLDING ESCAPE USED TO STROBE THE MENU, AND THERE ARE TWO SEPARATE
       * CAUSES. Both need blocking; neither alone is enough.
       *
       * The first is key auto-repeat. Hold a key and the browser delivers
       * `keydown` at the OS repeat rate — around 30 a second once the initial
       * delay has passed — and every one of them was reaching `toggle()`. The
       * panel opened and closed thirty times a second for as long as the key
       * was down, which is what the player saw as a flash. `e.repeat` is the
       * exact fix for that one: it is true on every delivery after the first,
       * so the gesture becomes one press however long it is held.
       *
       * The second is that opening and closing are driven by two different
       * events. While the pointer is locked, Escape never reaches the page at
       * all — the browser eats it to break the lock, and the menu opens from
       * `pointerlockchange`. The *next* Escape does reach the page, because
       * there is no lock left to break. So a press-and-hold can arrive here as
       * a lock-change open followed immediately by a real keydown close, which
       * `e.repeat` cannot see because that keydown is genuinely the first one.
       * The cooldown covers that; 200 ms is far longer than the gap between
       * those two events and far shorter than a deliberate second press.
       */
      if (e.repeat) return;
      const now = performance.now();
      if (now - this._lastToggle < TOGGLE_COOLDOWN_MS) return;
      this._lastToggle = now;
      // Escape only reaches the page when the pointer is NOT locked — while it
      // is, the browser eats it to break the lock and we hear about that
      // through pointerlockchange instead. So this arm is "close", plus the
      // ordinary open for anyone playing without pointer lock at all.
      this.toggle();
    };
    window.addEventListener('keydown', this._onKey);

    this._onLockChange = () => {
      const locked = document.pointerLockElement !== null;
      if (locked) {
        this._wasLocked = true;
        this._lockedAt = performance.now();
        return;
      }
      const lost = this._wasLocked;
      const heldFor = performance.now() - this._lockedAt;
      this._wasLocked = false;
      if (!lost) return;
      if (this._selfExit) {
        this._selfExit = false;
        return;
      }
      // A lock that lasted a couple of frames is a relock the engine refused
      // after granting, not a player pressing Escape. Reopening on it is the
      // "menu closes and comes straight back" flicker. See MIN_LOCK_MS.
      if (heldFor < MIN_LOCK_MS) return;
      if (this.open) return;
      if (this._debugOpen()) return;
      if (this._chatOpen()) return;
      if (this._jukeboxOpen()) return;
      if (!this._inWorld()) return;
      if (navigator.webdriver && !this.allowAutomationAutoOpen) return;
      // Stamp the same clock the key handler reads. Holding Escape while the
      // pointer is locked lands here first and delivers a real, non-repeat
      // keydown a few milliseconds later, and without this the second half of
      // that one gesture would close the menu the first half just opened.
      this._lastToggle = performance.now();
      this.show('pointerlock');
    };
    document.addEventListener('pointerlockchange', this._onLockChange);
  }

  /**
   * Take the menu apart completely.
   *
   * Removing the element is not enough: a Vite HMR update re-evaluates this
   * module, and a stale instance still holding a `keydown` on window and a
   * `pointerlockchange` on document would keep answering Escape with a panel
   * that is no longer in the document. Every listener this thing added outside
   * its own subtree comes off here.
   */
  dispose() {
    this._unsubscribe?.();
    if (this._readout !== null) window.clearInterval(this._readout);
    this._readout = null;
    if (this._onKey) window.removeEventListener('keydown', this._onKey);
    if (this._onLockChange) document.removeEventListener('pointerlockchange', this._onLockChange);
    if (this._onEscapeDown) window.removeEventListener('keydown', this._onEscapeDown, true);
    if (this._onEscapeUp) window.removeEventListener('keyup', this._onEscapeUp, true);
    if (this._onBlur) window.removeEventListener('blur', this._onBlur);
    this.el.remove();
    document.body.classList.remove('settings-open');
  }
}

const SHELL = `
  <div class="set-scrim"></div>
  <div class="set-panel" tabindex="-1">
    <header class="set-head">
      <h2>Settings</h2>
      <button id="set-close" type="button" class="set-close" aria-label="Close">Close</button>
    </header>

    <div class="set-tabs" id="set-tabs" role="tablist" aria-label="Settings pages"></div>

    <div class="set-body">
      <section class="set-page" data-page="graphics" role="tabpanel" hidden>
        <div class="set-presets" id="set-presets"></div>
        <p class="set-mode" id="set-mode">Auto</p>
        <div id="set-graphics"></div>

        <details class="set-advanced">
          <summary>Advanced</summary>
          <div id="set-graphics-advanced"></div>
          <p class="set-detail" id="set-detail"></p>
        </details>
      </section>

      <section class="set-page" data-page="audio" role="tabpanel" hidden>
        <div id="set-audio"></div>
      </section>

      <section class="set-page" data-page="controls" role="tabpanel" hidden>
        <div id="set-controls"></div>
        <div class="set-keys-list" id="set-bindings"></div>
      </section>

      <section class="set-page" data-page="accessibility" role="tabpanel" hidden>
        <div id="set-accessibility"></div>
        <p class="set-note">
          Everything the mushrooms do lives in the surfaces of the forest rather than
          in a filter over the picture, so turning the camera motion down leaves the
          trip intact and stops the camera moving on its own.
          <kbd>N</kbd> ends one immediately, from anywhere.
        </p>
      </section>
    </div>

    <footer class="set-foot">
      <button id="set-reset" type="button">Reset to defaults</button>
      <span><kbd>Esc</kbd> back to the forest</span>
    </footer>
  </div>
`;

/* -------------------------------------------------------------------------- */

/**
 * Self-installing, because index.html loads this module directly.
 *
 * main.js is owned elsewhere and does not import this file; the two meet in
 * core/quality.js, which is a module singleton and therefore the same object in
 * both. That is the whole integration surface.
 */
function install() {
  // An HMR update re-runs this module. Without the sweep you get a second panel
  // stacked on the first, two pointerlockchange listeners, and an Escape that
  // opens one menu and closes the other.
  window.RRSettingsMenu?.dispose?.();
  document.getElementById('settings')?.remove();
  const menu = new SettingsMenu(quality);
  window.RRSettingsMenu = menu;
  return menu;
}

const menu = document.body ? install() : null;
if (!menu) document.addEventListener('DOMContentLoaded', install, { once: true });

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.RRSettingsMenu?.dispose?.();
  });
}

export { menu };
