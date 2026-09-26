/**
 * The HUD.
 *
 * Three elements and no more. Every pixel of persistent chrome is a piece of
 * perfectly stable, perfectly rectangular, unmistakably man-made geometry
 * anchored to the glass — which is exactly the reference frame a trip must not
 * hand the eye. The phase readout is the one exception, and it is now a REMARK
 * rather than a readout: one label, once per phase, four seconds, gone. See
 * `setTrip`.
 *
 *
 * IT ALSO DRIVES THE ENTRY WAIT, WHICH IS NOT WHERE ANYBODY WOULD LOOK FIRST.
 *
 * `entering()` writes the gate's button and its progress track — chrome that
 * belongs to the main menu, on a panel this class otherwise has nothing to do
 * with. The alternative was for main.js to reach into menu.js, and that is the
 * one arrangement the menu's header rules out at length: the two halves meet
 * through module singletons and never refer to each other, because the menu is
 * loaded from index.html so it can paint before a forest exists. Hud is the one
 * module main.js already holds that owns document chrome by id, so the wait
 * lands here. It writes nothing after the gate has gone, and none of it is
 * persistent chrome, so the rule this file opens with is untouched.
 */

import { ESSENTIAL, keyCaps } from '../core/keys.js';

/**
 * How long a phase label stays up before it fades, in ms.
 *
 * Four seconds is about two unhurried readings of "The forest is breathing" —
 * long enough that it cannot be missed, short enough that it is not a caption
 * you learn to stop seeing. It is deliberately not tied to the phase's own
 * length: a label that lingered in proportion to the phase would be back to
 * describing a duration, which is the thing the progress bar was deleted for.
 */
const PHASE_HOLD_MS = 4000;
/** Matches the `transition: opacity` on `.phase` in style.css. Kept in step by hand. */
const PHASE_FADE_MS = 900;

export class Hud {
  constructor() {
    this.promptEl = document.getElementById('prompt');
    this.phaseEl = document.getElementById('phase');
    this.phaseLabel = document.getElementById('phase-label');
    this.toastEl = document.getElementById('toast');
    this.helpEl = document.getElementById('help');
    /** The gate's button and its track. Null once index.html has no gate. */
    this.enterButton = document.getElementById('enter');
    this.enterBar = document.querySelector('#entering-bar i');
    this._toastTimer = null;
    this._prompt = null;
    /**
     * The phase the label last announced, so the announcement is a one-shot.
     *
     * `setTrip` runs six times a second for five minutes; without this the
     * label would be written eighteen hundred times and held on the glass
     * throughout, which is a status field however faint it is.
     */
    this._phaseId = null;
    this._phaseTimer = null;

    /**
     * THE STRIP IS FIVE KEYS NOW, AND IT IS DRAWN FROM THE KEY LIST RATHER THAN
     * TYPED INTO index.html.
     *
     * It was fourteen items on one `white-space: nowrap` line, which is around
     * 1050 px of text — so on any window narrower than that it simply ran off
     * both edges of the screen, and the first thing it lost was `~ debug` at
     * the right and `W A S D move` at the left. It also listed the entire
     * social layer to somebody walking through a wood on their own, and it was
     * wrong: `~` is not the key, `` ` `` is.
     *
     * The rule this file opens with is why the answer is not "make it wrap".
     * Persistent chrome is a stable man-made rectangle welded to the glass, and
     * three lines of it is three times the reference frame one line is. So the
     * complete list moved to the Controls page of the settings menu, where a
     * player can read it at leisure and where it cannot be on screen during a
     * trip at all, and what is left here is the handful you need before you
     * have found that page: how to walk, how to touch something, how to stop,
     * and how to get to the rest.
     */
    if (this.helpEl) {
      this.helpEl.innerHTML = ESSENTIAL.map(
        (b) => `${keyCaps(b)} ${(b.short ?? b.label).toLowerCase()}`
      ).join(' · ');
    }
  }

  setPrompt(text) {
    if (text === this._prompt) return;
    this._prompt = text;
    if (!text) {
      this.promptEl.hidden = true;
      return;
    }
    this.promptEl.innerHTML = text;
    this.promptEl.hidden = false;
  }

  toast(text, ms = 3600) {
    this.toastEl.innerHTML = text;
    this.toastEl.hidden = false;
    this.toastEl.classList.remove('fading');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this.toastEl.classList.add('fading');
      setTimeout(() => {
        this.toastEl.hidden = true;
      }, 600);
    }, ms);
  }

  /**
   * The wait between the click and the forest, said out loud.
   *
   * @param {string|null} text what is happening now, on the button's own face,
   *   or null to leave the last thing it said standing
   * @param {number|null} progress 0..1 for the track, or null to leave it
   *
   * Two separate arguments rather than one object because the two move at
   * different rates: the settle stage has a real fraction and updates every
   * frame, while the label changes three times in the whole wait.
   */
  entering(text, progress = null) {
    if (this.enterButton) {
      this.enterButton.disabled = true;
      if (text !== null) this.enterButton.textContent = text;
    }
    if (this.enterBar && progress !== null) {
      const pct = Math.max(0, Math.min(1, progress)) * 100;
      this.enterBar.style.width = `${pct.toFixed(1)}%`;
    }
  }

  /**
   * @param {{phase: object, active: boolean, level: number}} d
   *
   * WHAT THIS IS GIVEN AND DELIBERATELY DOES NOT READ. `director.describe()`
   * also carries `time`, `total`, `dissolve`, `settle`, `after`, `surge` and
   * `doses` — every one of them a number that could be turned into a bar, a
   * countdown or a percentage, and that is the reason to write down that none
   * of them is read here rather than to quietly not read them. The debug panel
   * is where those belong. Nothing on this glass may tell a player how far
   * through they are: knowing there are ninety seconds left is the single most
   * reliable way to stop experiencing a thing and start waiting for it, and it
   * is what the progress bar was deleted for.
   *
   * The afterglow needs no line here either, and that is the point of it —
   * `active` is false the moment the envelope ends, so the phase element is
   * retired while the colour is still a little too deep. You are not told it is
   * happening, which is what makes it something you notice rather than read.
   */
  setTrip(d) {
    /**
     * The help strip still recedes continuously, because it is not an
     * announcement — it is a row of key caps whose job is to be findable and
     * then to get out of the way, and there is nothing about it that changes
     * at a phase boundary.
     */
    this.helpEl.style.opacity = d.active
      ? String(Math.max(0, 0.3 - d.level * 0.4))
      : '';

    if (!d.active) {
      /**
       * A TRIP THAT ENDS WHILE A REMARK IS STILL UP RETIRES IT, IT DOES NOT CUT
       * IT.
       *
       * This used to set `hidden` and `opacity` outright, which for the four
       * seconds either side of the end meant the label vanished on a frame
       * boundary — a hard cut, which is exactly the flash-like edit this whole
       * element was rebuilt to avoid, and which happens at the one moment a
       * player is most likely to be looking at it. Retiring it through the same
       * fade it would have used on its own costs one branch.
       *
       * `_phaseId` is the latch. `setTrip` runs six times a second, so without
       * it the fade would be restarted on every frame for the rest of the
       * session and the label would never actually go.
       */
      if (this._phaseId !== null) {
        this._phaseId = null;
        this._clearPhaseTimer();
        this._retirePhase();
      }
      return;
    }

    /**
     * ONE ANNOUNCEMENT PER PHASE, AND NOTHING AT ALL IN BETWEEN.
     *
     * `describe()` reports `sober` while nothing is happening and a real id
     * from `trip/state.js` otherwise, including the `resurge` pseudo-phase a
     * second dose produces — so keying on the id means a re-dose gets its own
     * remark rather than being swallowed as "still the same trip". The label
     * is the fallback key for anything that ever arrives without an id.
     */
    const id = d.phase?.id ?? d.phase?.label ?? '';
    if (id === this._phaseId) return;
    this._phaseId = id;

    this.phaseLabel.textContent = d.phase.label;
    this.phaseEl.hidden = false;
    /**
     * The come-up is the one place a player genuinely wants reassurance that
     * something is meant to be happening, so it arrives brightest; from there
     * the remark recedes as the trip deepens, exactly as the old readout did.
     * At the peak it is a suggestion.
     */
    const opacity = String(Math.max(0.22, 0.75 - d.level * 0.5));
    /**
     * A frame between `hidden = false` and the opacity write, or the browser
     * coalesces the two into one style recalc and the element simply appears
     * at full strength — a hard cut is precisely the flash-like edit this
     * whole change exists to avoid. See the `transition` on `.phase`.
     */
    requestAnimationFrame(() => {
      if (this._phaseId === id) this.phaseEl.style.opacity = opacity;
    });

    this._clearPhaseTimer();
    this._phaseTimer = setTimeout(() => this._retirePhase(), PHASE_HOLD_MS);
  }

  /** Fade the remark out and only then hide it, so the fade is visible at all. */
  _retirePhase() {
    this.phaseEl.style.opacity = '0';
    this._phaseTimer = setTimeout(() => {
      this._phaseTimer = null;
      this.phaseEl.hidden = true;
    }, PHASE_FADE_MS);
  }

  _clearPhaseTimer() {
    if (this._phaseTimer) clearTimeout(this._phaseTimer);
    this._phaseTimer = null;
  }
}
