/**
 * The control socket.
 *
 * Carries membership, signalling and transforms. Never carries a single audio
 * sample — those go peer to peer, and if this socket dies mid-conversation the
 * conversation keeps going, it just stops being able to see anybody move.
 *
 * THE MOST IMPORTANT PROPERTY OF THIS FILE IS THAT IT CAN FAIL. Reality Room is
 * a single-player game that has other people in it when it can. There is no
 * lobby, no login and no "connecting…" screen, because every one of those turns
 * a walk in the woods into something that can be *blocked* by a machine being
 * off. So every failure path here ends in exactly the same place: no peers, no
 * error, and one quiet line of HUD text.
 */

const BASE_RETRY_MS = 700;
const MAX_RETRY_MS = 12_000;
const PING_MS = 4000;

/**
 * How many times to try before concluding that there is no server.
 *
 * ONLY APPLIES BEFORE THE FIRST SUCCESSFUL CONNECTION, and the asymmetry is the
 * whole point. Never having connected means the far end is very likely not
 * running at all — retrying forever would be a background process quietly
 * failing every twelve seconds for the length of a five-minute trip, for
 * nothing. Having connected once and then dropped means the opposite: something
 * that was there went away, which is a restarted server or a lift, and the right
 * behaviour is to keep trying until it comes back.
 */
const COLD_ATTEMPTS = 3;

class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(event, fn) {
    let set = this._handlers.get(event);
    if (!set) this._handlers.set(event, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  emit(event, ...args) {
    for (const fn of this._handlers.get(event) ?? []) {
      // One misbehaving listener must not stop the others, and must never
      // propagate into the socket's own message loop.
      try {
        fn(...args);
      } catch (err) {
        console.warn(`[net] ${event} listener threw`, err);
      }
    }
  }

  clearListeners() {
    this._handlers.clear();
  }
}

export class RoomSocket extends Emitter {
  /**
   * @param {object} options
   * @param {string} options.room the invite code
   * @param {string} options.name what to call you
   * @param {number|null} [options.hue] your dye, 0..1, or null to be coloured by
   *   your id the way everybody was before the menu existed
   * @param {string} [options.seed] the wood this page is standing in. Sent so the
   *   room can remember which forest it is; see `url()`.
   * @param {() => (number|null)} [options.dayAge] how long ago this session's day
   *   began, in milliseconds, or null for the true wall clock. A THUNK because
   *   the answer moves: it is read at the instant the URL is built, and a
   *   reconnect twenty minutes into an evening must send twenty minutes more
   *   than the first attempt did or the sky steps backwards on the way back in.
   */
  constructor({ room, name, hue = null, seed = null, dayAge = () => null }) {
    super();
    this.room = room;
    this.name = name;
    this.hue = hue;
    this.seed = seed;
    this.dayAge = dayAge;
    this.ws = null;
    this.selfId = null;
    this.iceServers = [];
    this.latency = 0;
    this.everConnected = false;
    this.givenUp = false;
    this.deniedReason = null;
    this._attempt = 0;
    this._closedByUs = false;
    this._pingTimer = null;
    this._retryTimer = null;
    /**
     * The lowest round trip seen on this socket, in ms. Gates the world-clock
     * re-anchor in `_dispatch` — see the note there for why the minimum is the
     * right statistic and an average is the wrong one.
     *
     * Reset on reconnect rather than kept, because a reconnect means the
     * network changed and yesterday's best sample is no longer evidence about
     * today's path.
     */
    this._bestRtt = Infinity;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Same origin, always.
   *
   * In development Vite proxies `/ws` through to the node process (see
   * vite.config.js); in production the same process serves the page. Either way
   * the client has no host to configure, which means an invite link is the
   * entire configuration and there is no way to paste a URL that half works.
   */
  /**
   * IDENTITY TRAVELS ON THE HANDSHAKE, NOT IN A FIRST MESSAGE. That is what makes
   * the roster complete the moment it arrives: `welcome` carries everybody who is
   * already here, and if a name or a dye needed a round trip of its own then
   * every arrival would begin as a grey stranger called Someone and be corrected
   * a moment later. Reconnecting is re-opening this URL, so a name changed
   * mid-session survives a dropped socket for free — see `sendLook`, which keeps
   * the fields up to date for exactly that reason.
   *
   * The SEED is here for a different job: it is how a room finds out which forest
   * it is. The first person into a room teaches the server their world, and
   * `/api/room/peek` hands it to whoever types the code next, so a lobby code is
   * enough to reach the same wood as the person who read it to you. Without it a
   * typed code puts two people in one room and two different forests — no error
   * anywhere, avatars walking through trees that are not there. See
   * `core/world-seed.js` for why the seed is a property of the session rather
   * than something derivable from the code.
   *
   * The DAY rides along for the same reason as the seed and is used the same
   * way: first one into a room teaches it what time of day it is, everybody
   * after that is told. It is sent as an AGE — how long ago this session's day
   * began — rather than as the instant it began, because the receiving end is a
   * different machine with a different idea of what time it is. See
   * `sanitizeDayAge` in server/rooms.js.
   */
  url() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams({ room: this.room, name: this.name });
    if (this.hue !== null && this.hue !== undefined) params.set('hue', String(this.hue));
    if (this.seed) params.set('seed', this.seed);
    const age = this.dayAge?.();
    if (Number.isFinite(age)) params.set('day', String(Math.round(age)));
    return `${scheme}://${location.host}/ws?${params}`;
  }

  connect() {
    this._closedByUs = false;
    this.givenUp = false;
    this._open();
  }

  _open() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    let ws;
    try {
      ws = new WebSocket(this.url());
    } catch {
      // Malformed URL, blocked scheme, an extension refusing the connection.
      this._retry();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this._attempt = 0;
      this.everConnected = true;
      // See the field's own note: a new socket is a new path, so the old best
      // round trip stops being evidence about this one.
      this._bestRtt = Infinity;
      this._startPing();
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      /**
       * WHEN THIS ACTUALLY LANDED, as opposed to when we got round to it.
       *
       * `event.timeStamp` is set by the browser at delivery; `Date.now()` in
       * this handler is whenever the main thread next had a moment. Those are
       * usually the same instant and are emphatically not during a join, which
       * is the one moment this matters: `welcome` arrives while the page is
       * building a forest — a terrain field, a scatter pass and thirty-nine
       * shader compiles — and the handler can be a fifth of a second late, on a
       * slow machine considerably more.
       *
       * Only `welcome` reads it, to anchor the world clock (see
       * `adoptWorldAge`). Without it every client's clock is offset by however
       * long its own load happened to block, which is unbounded, invisible, and
       * different for everybody. Measured on this machine it was 202 ms.
       *
       * `timeOrigin + timeStamp` converts a page-relative high-resolution stamp
       * into the same epoch domain as `Date.now()`, which is what the age
       * arithmetic is done in.
       */
      msg._at = performance.timeOrigin + event.timeStamp;
      this._dispatch(msg);
    });

    ws.addEventListener('close', (event) => {
      this._stopPing();
      this.ws = null;
      this.emit('down');
      if (this._closedByUs) return;
      /**
       * 1008 is our own policy close — a full room, a bad code, or the rate
       * limiter. Reconnecting would produce exactly the same answer, so this is
       * the one case that gives up immediately and says why.
       */
      if (event.code === 1008) {
        this.givenUp = true;
        this.emit('gave-up', this.deniedReason ?? 'The server turned us away.');
        return;
      }
      this._retry();
    });

    // The close handler owns every recovery path; an error handler that also
    // retried would double every backoff.
    ws.addEventListener('error', () => {});
  }

  _dispatch(msg) {
    switch (msg.t) {
      case 'welcome':
        this.selfId = msg.id;
        this.iceServers = Array.isArray(msg.iceServers) ? msg.iceServers : [];
        this.emit('welcome', msg);
        return;
      case 'denied':
        // Arrives just before a 1008 close. Stashed rather than emitted, so the
        // reason and the give-up are one event to the layer above.
        this.deniedReason = msg.why;
        return;
      case 'pong': {
        if (!Number.isFinite(msg.ts)) return;
        const rtt = performance.now() - msg.ts;
        this.latency = this.latency ? this.latency * 0.8 + rtt * 0.2 : rtt;
        /**
         * RE-ANCHOR THE WORLD CLOCK, BUT ONLY ON THE BEST ROUND TRIP SO FAR.
         *
         * A one-way message cannot tell you how late it is. A round trip can,
         * because both ends of it are timed by the same clock — so the room's
         * age plus half the RTT is the age *now*, and that is a number this
         * client can convert into its own domain exactly.
         *
         * BEST-SO-FAR RATHER THAN LATEST, AND RATHER THAN AN AVERAGE. The half-
         * RTT correction assumes the two legs are symmetric, and the thing that
         * breaks that assumption is this client being busy — a page mid-load, a
         * shader compile, a GC pause — all of which inflate the return leg
         * only. Those samples are not noise to be averaged out, they are biased
         * in one direction, and the smallest RTT is by construction the one
         * least contaminated by them. It is also self-improving and stable: the
         * clock stops moving once a good sample has been seen, instead of
         * jittering with every pong for the rest of the session.
         *
         * The first ping fires four seconds after the socket opens, by which
         * time the forest is built and the main thread is idle, so in practice
         * the very first sample is a good one and the correction happens once.
         */
        if (Number.isFinite(msg.elapsed) && rtt < this._bestRtt) {
          this._bestRtt = rtt;
          this.emit('clock', { elapsed: msg.elapsed + rtt / 2 });
        }
        return;
      }
      default:
        this.emit(msg.t, msg);
    }
  }

  _retry() {
    if (this._retryTimer || this.givenUp) return;
    this._attempt += 1;
    if (!this.everConnected && this._attempt > COLD_ATTEMPTS) {
      this.givenUp = true;
      this.emit('gave-up', null);
      return;
    }
    // Jitter so a server coming back up is not hit by every client at once.
    const delay =
      Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** (this._attempt - 1)) + Math.random() * 300;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._open();
    }, delay);
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => this.send({ t: 'ping', ts: performance.now() }), PING_MS);
  }

  _stopPing() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  /**
   * Fire and forget. Nothing this socket carries is worth queueing: a transform
   * is stale in 55 ms, and an ICE candidate that missed its window is replaced
   * by an ICE restart rather than by a replay.
   */
  send(payload) {
    if (!this.connected) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  sendState(x, y, z, yaw, pitch, voice, flags, trip) {
    return this.send({ t: 's', d: [x, y, z, yaw, pitch, voice, flags, trip] });
  }

  signal(to, data) {
    return this.send({ t: 'signal', to, data });
  }

  /**
   * The three messages a person generates on purpose.
   *
   * Unlike `sendState` these are not replaced by the next tick, so a dropped one
   * is genuinely lost — and they are still fire and forget, because the socket
   * only reports a failure when it is already closed, and a closed socket means
   * there is nobody to have said it to. The caller sees `false` and can say so.
   */
  sendChat(text) {
    return this.send({ t: 'chat', text });
  }

  sendNote(text) {
    return this.send({ t: 'note', text });
  }

  /**
   * A new name, a new dye, or both — for somebody who changed their mind after
   * the socket was already open.
   *
   * The stored fields are updated whether or not the send lands, and that order
   * is the point: `url()` reads them, so a change made while the connection is
   * down still reaches the room on the next reconnect. A failed send here costs
   * the room a few seconds of stale appearance, which is the correct amount of
   * ceremony for a colour.
   */
  sendLook(name, hue) {
    if (typeof name === 'string' && name) this.name = name;
    if (Number.isFinite(hue)) this.hue = hue;
    return this.send({ t: 'look', name: this.name, hue: this.hue });
  }

  /** @param {null|import('./protocol.js').Placement} at where your screen is standing */
  sendPresent(at) {
    return this.send({ t: 'present', at });
  }

  /**
   * Where the two speaker cabinets are now standing.
   *
   * Room furniture rather than a possession — unlike `sendPresent`, this is not
   * a statement about the sender, and the server files it on the room. See
   * `sanitizeSpeakers` in server/rooms.js.
   */
  sendSpeakers(at) {
    return this.send({ t: 'speakers', at });
  }

  /**
   * What the jukebox is playing, or null for silence. Room state, like the
   * speakers. See `sanitizeMusic` in server/rooms.js.
   */
  sendMusic(state) {
    return this.send({ t: 'music', state });
  }

  /**
   * One mushroom, eaten. `id` is a patch id — `under:sx,sz:i`, derived from the
   * seed, so it names the same patch in everybody's forest. See
   * `sanitizePatchId` in server/rooms.js.
   */
  sendEat(id) {
    return this.send({ t: 'eat', id });
  }

  /**
   * Where all the animals are. Sent only by the room's host, six times a second.
   *
   * The server checks that this came from the host and that the arrays hold
   * nothing but numbers, and forwards them without knowing what a single one
   * means — the shape belongs to `snapshot` in world/fauna.js at both ends. It
   * is the only message in this file whose contents this layer cannot read.
   */
  sendFauna(data) {
    return this.send({ t: 'fauna', a: data.a, c: data.c });
  }

  close() {
    this._closedByUs = true;
    this._stopPing();
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._retryTimer = null;
    try {
      this.ws?.close(1000, 'bye');
    } catch {
      /* already gone */
    }
    this.ws = null;
  }
}
