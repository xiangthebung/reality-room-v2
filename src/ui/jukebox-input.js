/**
 * The jukebox's "paste a link" box.
 *
 * Same shape as social.js's chat input, for the same reason: pointer lock has
 * to go while you're typing (see that file's header on why — the mouse turns
 * the player while it's locked, and a text field that steals the keyboard but
 * leaves the mouse driving is a way to type a sentence and end up facing a
 * different tree), and the box exists on screen only while it's in use, per
 * hud.js's rule that nothing here is persistent chrome.
 *
 * This module only owns the box. It hands the submitted text to `onSubmit`
 * and knows nothing about fetching, resolving, or playing anything — that
 * logic lives in main.js, next to `music`/`externalTrack`/the audio engine
 * it actually has to touch.
 */
export class JukeboxInput {
  /**
   * @param {object} deps
   * @param {import('../player/controller.js').Controller} deps.controller
   * @param {(url: string) => void} deps.onSubmit
   */
  constructor({ controller, onSubmit }) {
    this.controller = controller;
    this.onSubmit = onSubmit;

    this.formEl = document.getElementById('jukebox-form');
    this.inputEl = document.getElementById('jukebox-input');
    this._typing = false;

    this.formEl.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.inputEl.value.trim();
      this.inputEl.value = '';
      this.close();
      if (text) this.onSubmit(text);
    });

    this.inputEl.addEventListener('keydown', (event) => {
      // Stop every key reaching the world while typing — see social.js's
      // identical guard for why (typing "was" would otherwise walk you
      // forward and back).
      event.stopPropagation();
      if (event.key === 'Escape') {
        this.inputEl.value = '';
        this.close();
      }
    });
    this.inputEl.addEventListener('keyup', (event) => event.stopPropagation());
    this.inputEl.addEventListener('blur', () => this.close());
  }

  get typing() {
    return this._typing;
  }

  open() {
    if (this._typing) return;
    this._typing = true;
    this.formEl.hidden = false;
    if (document.pointerLockElement) document.exitPointerLock();
    this.controller.keys.clear();
    this.inputEl.focus();
  }

  close() {
    if (!this._typing) return;
    this._typing = false;
    this.formEl.hidden = true;
    this.inputEl.blur();
  }
}
