/**
 * Showing people something.
 *
 * Two sources, one path out. A screen — a window, a tab, a whole display —
 * comes from `getDisplayMedia`; a film comes from a file the player dropped on
 * the window, played into a hidden `<video>` and captured off it. Both end up as
 * the same pair of MediaStreamTracks handed to `mesh.setShareTracks`, and
 * everything downstream of that point is identical.
 *
 * WHY A LOCAL FILE IS NOT A SPECIAL CASE. The obvious way to watch a film
 * together is to synchronise two copies of it — everybody opens the same file
 * and the room agrees on a playback position. It is also the way that does not
 * work: it needs everybody to have the file, it needs a synchronisation protocol
 * with drift correction, and the first person to seek breaks it. Capturing the
 * playback and sending the pixels means one person has the file, everybody sees
 * the same frame by construction, and pausing is a thing that happens to a
 * picture rather than a message somebody might miss. It costs upstream
 * bandwidth, which is the thing this project already decided to spend on screen
 * sharing, so it is free in the only currency that was scarce.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: build a surface, or know where the
 * ground is. It owns WHERE the picture is — a spot and a size — and nothing
 * about what that looks like or how the spot was arrived at. `video-surface.js`
 * has the quad, the texture and the legs; `net/index.js` has the terrain march
 * that answers `where()`; this has five numbers and the rules for changing them.
 *
 * That separation is why the surface could be swapped out from under it twice.
 * This file used to say `'near'` or `'wall'` and the world owned one panel and
 * one fourteen-metre screen; then it said held-or-a-spot; now it says a spot.
 * Not one line of the capture path below changed either time.
 */

/**
 * The width bounds and the default live in `protocol.js` rather than here,
 * because the server enforces its own copy of them and the two halves have to be
 * talking about the same numbers. See the note there for why sixteen metres is
 * the ceiling.
 */
import { SHARE_DEFAULT_W, SHARE_MAX_W, SHARE_MIN_W } from './protocol.js';

/**
 * Two thousand pixels across is the point of diminishing returns and it is a
 * fact about the destination rather than about the encoder.
 *
 * The picture ends up on a quad in a forest. The largest a screen may be is
 * sixteen metres wide, and you stand at least a few metres from it, so it
 * occupies at most about a third of a 2560-wide window — call it 850 pixels.
 * Sending 3840 into that is paying to encode and transmit detail that the
 * texture sampler averages away before anybody sees it, seven times over.
 *
 * NOTE THAT RESIZING DOES NOT TOUCH THIS. A screen scaled from 1.2 m to 16 m is
 * the same texture on a bigger quad — more fill, not one byte more upload — so
 * the encoder never learns that anything happened and the cap does not have to
 * chase the widest screen anybody might make.
 *
 * A cap rather than a target: `getDisplayMedia` scales down to fit and will not
 * scale a 1366-wide laptop up.
 */
const MAX_SHARE_WIDTH = 1920;
const MAX_SHARE_HEIGHT = 1080;

/**
 * Fifteen frames a second for a screen, thirty for a film.
 *
 * Everything about a shared *screen* is text, and text does not move: a code
 * editor or a slide deck at 15 fps is indistinguishable from 60 and costs less
 * than half as much, because inter-frame compression is already doing almost all
 * of the work and the residual is where the money goes. A film is the opposite
 * case and gets the full thirty — 24 fps content in a 30 fps envelope has no
 * judder, and pulling it down to 15 would.
 */
const SCREEN_FPS = 15;
const FILM_FPS = 30;

export class Share {
  /**
   * @param {object} deps
   * @param {(video: MediaStreamTrack|null, audio: MediaStreamTrack|null) => void} deps.publish
   *   called with both tracks whenever they change, and with two nulls on stop
   * @param {(at: import('./protocol.js').Placement|null) => void} deps.announce
   *   tells the room where the screen is
   * @param {() => {x:number,y:number,z:number,yaw:number}} deps.where
   *   the patch of ground a screen should land on right now. Asked for at the
   *   moment a stream arrives rather than at the moment it was requested, which
   *   matters entirely: `getDisplayMedia` puts a picker in front of somebody for
   *   several seconds, and where they were facing when they reached for the key
   *   is not where they are facing when they finish choosing a window.
   * @param {(text: string, ms?: number) => void} deps.say one line of HUD text
   */
  constructor({ publish, announce, where, say }) {
    this._publish = publish;
    this._announce = announce;
    this._where = where;
    this._say = say ?? (() => {});

    /**
     * Where it stands, or null when nothing is being shared. `{x, y, z, yaw, w}`
     * in world metres; `y` is the GROUND under it rather than the middle of the
     * picture, because the ground is the thing both machines can independently
     * agree about and the middle of the picture moves when you resize it.
     *
     * THIS IS THE WHOLE STATE MACHINE NOW. There used to be a `mode` beside it —
     * `null | 'held' | 'placed'` — because a share began in your hands and
     * became a spot when you put it down. The user asked for the first stage to
     * go, and with it went the only reason for a share to be somewhere the
     * coordinates could not say. Sharing and being somewhere are the same fact,
     * so they are the same field.
     */
    this.spot = null;
    /**
     * How wide the screen is, remembered across moves and across stops.
     *
     * Kept here rather than only inside `spot` because `spot` is replaced
     * wholesale every time the screen moves, and the size a person chose is a
     * property of THEM rather than of the patch of ground. Moving a screen and
     * finding it back at the default was the thing that made the resize feel
     * like something the world kept undoing.
     */
    this.width = SHARE_DEFAULT_W;
    /** 'screen' | 'film' | null — what it is, which only affects the labels. */
    this.kind = null;
    /** The name of the file, when it is one. Shown in the roster. */
    this.title = null;

    this._stream = null;
    this._element = null;
    this._objectUrl = null;
  }

  get active() {
    return this.spot !== null;
  }

  /**
   * The placement as it goes on the wire, or null. See `protocol.js`.
   *
   * A COPY, not `this.spot` itself. The surface stores whatever it is handed and
   * reads it back later — `ShareScreen.placement` is what `_standLegs` and the
   * upload gate consult — so returning the live object would mean a scroll wheel
   * silently rewriting a placement the screen already thought it had applied,
   * and legs that never moved to match a width that had.
   */
  get placement() {
    return this.spot ? { ...this.spot } : null;
  }

  /** The local picture, for the surface that shows you your own share. */
  get videoTrack() {
    return this._stream?.getVideoTracks()[0] ?? null;
  }

  get audioTrack() {
    return this._stream?.getAudioTracks()[0] ?? null;
  }

  /**
   * Share a screen, a window or a tab.
   *
   * IT GOES STRAIGHT ON THE GROUND, in front of whoever pressed the key, at the
   * moment the picker closes. It used to arrive in your hands and wait for a
   * second key, on the reasoning that somebody still choosing a window has not
   * yet decided where the thing goes — which was true and beside the point. The
   * first thing anybody did with a held screen was put it down, so the state
   * existed to be left, and a stage every user passes through without ever
   * meaning to stop there is not a stage.
   *
   * There is nothing to decide in advance because the aim IS the decision:
   * `where()` is asked here, after the await, so it reads the direction they are
   * facing now rather than the one they were facing when they reached for the
   * key. Moving it afterwards is one press of the same key that would have been
   * needed to put it down.
   */
  async startScreen() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this._say('This browser will not share a screen.', 5000);
      return false;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { max: MAX_SHARE_WIDTH },
          height: { max: MAX_SHARE_HEIGHT },
          frameRate: { max: SCREEN_FPS },
          /**
           * Do not draw the mouse pointer into the stream.
           *
           * A cursor is a small, perfectly crisp, perfectly stable arrow that
           * moves independently of everything around it — which is precisely the
           * reference frame this whole project avoids handing the eye, and it is
           * worse on a screen inside a world than it would be on the glass,
           * because it does not belong to either. People pointing at things can
           * point at them with their body, which they are already standing in.
           */
          cursor: 'never',
        },
        /**
         * Ask for sound. On Chromium this is what puts the "share tab audio"
         * checkbox in the picker, and it is the difference between showing
         * somebody a video and watching one together. Firefox and Safari ignore
         * it and return video only, which is handled: the audio track is simply
         * absent and everything else works.
         */
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      // Cancelling the picker is by far the most common outcome and is not an
      // error worth a line of HUD text.
      if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
        this._say('That screen could not be shared.', 4500);
      }
      return false;
    }

    this.adopt(stream, 'screen', null);
    /**
     * `detail` tells the encoder that this is a screen rather than a camera: it
     * biases toward spatial sharpness over temporal smoothness, which is exactly
     * the right trade for text and exactly the wrong one for a face.
     */
    const video = stream.getVideoTracks()[0];
    if (video) video.contentHint = 'detail';
    return true;
  }

  /**
   * Play a file and share the playback. Stood up in front of you, like a screen.
   *
   * @param {File} file
   */
  async startFile(file) {
    const element = document.createElement('video');
    element.src = URL.createObjectURL(file);
    element.loop = false;
    element.playsInline = true;
    /**
     * MUTED HERE AND HEARD THROUGH THE WORLD.
     *
     * The element is the source of the audio track, not a way of listening to
     * it. If it played out loud as well, the person sharing would hear the film
     * twice: once flat from their speakers and once from a PannerNode standing
     * at the screen, a few milliseconds apart, which is a comb filter rather
     * than a soundtrack. They hear it the same way everyone else does — from the
     * screen, quieter as they walk away — and that is the point of putting it in
     * a world at all.
     *
     * Muted playback also needs no gesture, which matters because this can be
     * triggered by a drop rather than by a click.
     */
    element.muted = true;

    try {
      await element.play();
    } catch {
      URL.revokeObjectURL(element.src);
      this._say('That file will not play here.', 4500);
      return false;
    }

    /**
     * `captureStream` is what makes this cheap: the browser hands over the
     * decoded frames it is already producing, so a film is decoded once and
     * encoded once regardless of how many people are watching it. There is no
     * canvas, no readback and no second decode.
     */
    const capture = element.captureStream?.() ?? element.mozCaptureStream?.();
    if (!capture) {
      element.pause();
      URL.revokeObjectURL(element.src);
      this._say('This browser will not share a file.', 4500);
      return false;
    }

    this.adopt(capture, 'film', file.name);
    this._element = element;
    this._objectUrl = element.src;

    const video = capture.getVideoTracks()[0];
    // `motion` is the opposite bias to a shared screen: keep the frame rate,
    // spend the bits on movement, let a still frame be slightly soft.
    if (video) video.contentHint = 'motion';
    const settings = video?.getSettings?.();
    if (settings && settings.frameRate > FILM_FPS) {
      video.applyConstraints?.({ frameRate: { max: FILM_FPS } }).catch(() => {});
    }

    // The film ending is a stop, and nobody should have to notice and press a
    // key to clear an empty screen out of the clearing.
    element.addEventListener('ended', () => this.stop());
    return true;
  }

  /**
   * Stand the screen on a patch of ground — the first time, or somewhere else.
   *
   * MOVING AND PLACING ARE THE SAME OPERATION, which is what deleting the held
   * stage bought. A screen that could be carried needed three verbs (put down,
   * pick up, put down again) and a state to be in between the second and third;
   * a screen that is always somewhere needs one, applied to wherever you are
   * standing now. Nothing has to be true for this to be legal except that there
   * is something to move.
   *
   * @param {{x:number,y:number,z:number,yaw:number}} spot ground point and facing
   * @returns {boolean} false when there was nothing to put anywhere
   */
  place({ x, y, z, yaw }) {
    if (!this.active) return false;
    this.spot = { x, y, z, yaw, w: this.width };
    this._announce(this.placement);
    return true;
  }

  /**
   * Make it bigger or smaller.
   *
   * MULTIPLICATIVE, not additive. A screen's apparent size is its width over
   * your distance from it, so the step that feels right at 1.2 m is a tenth of
   * the step that feels right at 12 m — an additive step is either glacial at
   * the top of the range or uncontrollable at the bottom. A ratio is the same
   * gesture everywhere, which is why every zoom control ever built is one.
   *
   * @param {number} factor >1 grows, <1 shrinks
   * @returns {boolean} true if the width actually changed — the caller uses this
   *   to decide whether the room needs telling, and at the clamps it does not
   */
  resize(factor) {
    if (!this.active) return false;
    const next = Math.min(SHARE_MAX_W, Math.max(SHARE_MIN_W, this.width * factor));
    if (Math.abs(next - this.width) < 1e-4) return false;
    this.width = next;
    this.spot.w = next;
    return true;
  }

  /**
   * Say the current placement again.
   *
   * Separate from `resize` because resizing a placed screen changes it sixty
   * times a second while a wheel is spinning and the room needs telling roughly
   * twice. The rate limiting is the caller's business — see `net/index.js` —
   * and this is the seam it announces through.
   */
  reannounce() {
    if (this.active) this._announce(this.placement);
  }

  /** Pause or resume a film. Does nothing to a live screen, which has no clock. */
  togglePlay() {
    if (!this._element) return null;
    if (this._element.paused) {
      this._element.play().catch(() => {});
      return true;
    }
    this._element.pause();
    return false;
  }

  /** Seconds. Only a film has these; a screen returns nulls. */
  get position() {
    return this._element ? { time: this._element.currentTime, total: this._element.duration } : null;
  }

  seek(seconds) {
    if (!this._element || !Number.isFinite(this._element.duration)) return;
    this._element.currentTime = Math.max(
      0,
      Math.min(this._element.duration - 0.1, this._element.currentTime + seconds)
    );
  }

  stop() {
    if (!this._stream) return;
    for (const track of this._stream.getTracks()) track.stop();
    this._stream = null;
    if (this._element) {
      this._element.pause();
      this._element.removeAttribute('src');
      this._element.load();
      this._element = null;
    }
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = null;
    }
    this.spot = null;
    this.kind = null;
    this.title = null;
    /**
     * `width` deliberately survives a stop. It is a preference — how big this
     * person likes their screen — rather than a property of the stream that just
     * ended, and resetting it meant everybody who liked a big screen resized one
     * every single time they shared.
     */
    this._publish(null, null);
    this._announce(null);
  }

  /**
   * Start sharing an arbitrary MediaStream.
   *
   * The seam both public entry points funnel through, and public rather than
   * private on purpose: it is the only way to drive this feature from a test.
   * `getDisplayMedia` cannot be answered by a headless browser — there is no
   * picker and no screen — so `server/test/two-social.mjs` hands in a canvas's
   * `captureStream()` instead and everything downstream of this line is the code
   * that runs for real. A test that stubbed the transport instead would prove
   * only that the stub works.
   *
   * @param {MediaStream} stream
   * @param {'screen'|'film'} kind
   * @param {string|null} title
   * @param {{x:number,y:number,z:number,yaw:number,w?:number}} [at] where it
   *   lands. Defaults to whatever `where()` says you are looking at, which is
   *   what both public entry points want; passed explicitly by scripts that
   *   teleport a camera about and are never "looking at" anywhere, and by tests
   *   swapping the source under a screen that must not move while they do it.
   */
  adopt(stream, kind, title, at = this._where()) {
    // Starting a second share replaces the first rather than stacking: the
    // upstream cost is the reason rooms are capped at eight, and two of them is
    // not a thing anybody meant to do.
    if (this._stream) this.stop();
    this._stream = stream;
    this.width = at.w ?? this.width;
    this.spot = { x: at.x, y: at.y, z: at.z, yaw: at.yaw, w: this.width };
    this.kind = kind;
    this.title = title;

    /**
     * The browser's own "Stop sharing" bar is not a thing this app can draw over
     * or intercept, so the only way to notice it is the track ending. Without
     * this, pressing that button leaves everyone else staring at a frozen last
     * frame of your desktop for the rest of the evening.
     */
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => {
        if (this._stream === stream) this.stop();
      });
    }

    this._publish(stream.getVideoTracks()[0] ?? null, stream.getAudioTracks()[0] ?? null);
    this._announce(this.placement);
  }
}
