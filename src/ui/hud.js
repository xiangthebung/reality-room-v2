/**
 * The HUD.
 *
 * Three elements and no more. Every pixel of persistent chrome is a piece of
 * perfectly stable, perfectly rectangular, unmistakably man-made geometry
 * anchored to the glass — which is exactly the reference frame a trip must not
 * hand the eye. The phase readout is the one exception, because being able to
 * find out where you are in something that lasts five minutes is worth it, and
 * it fades to nearly nothing at the peak.
 */

import { ESSENTIAL, keyCaps } from '../core/keys.js';

export class Hud {
  constructor() {
    this.promptEl = document.getElementById('prompt');
    this.phaseEl = document.getElementById('phase');
    this.phaseLabel = document.getElementById('phase-label');
    this.phaseBar = document.querySelector('#phase-bar i');
    this.toastEl = document.getElementById('toast');
    this.helpEl = document.getElementById('help');
    this._toastTimer = null;
    this._prompt = null;

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

  /** @param {{phase: object, time: number, total: number, active: boolean, level: number}} d */
  setTrip(d) {
    if (!d.active) {
      this.phaseEl.hidden = true;
      this.helpEl.style.opacity = '';
      return;
    }
    this.phaseEl.hidden = false;
    this.phaseLabel.textContent = d.phase.label;
    this.phaseBar.style.width = `${Math.min(100, (d.time / d.total) * 100).toFixed(1)}%`;
    // The readout recedes as the trip deepens. At the peak it is a suggestion.
    this.phaseEl.style.opacity = String(Math.max(0.12, 0.75 - d.level * 0.6));
    this.helpEl.style.opacity = String(Math.max(0, 0.3 - d.level * 0.4));
  }
}
