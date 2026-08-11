import { WebSocketServer } from 'ws';
import {
  MAX_EATEN,
  sanitizeChat,
  sanitizeDayAge,
  sanitizeHue,
  sanitizeMusic,
  sanitizeName,
  sanitizePatchId,
  sanitizePresent,
  sanitizeSeed,
  sanitizeSpeakers,
  samePresent,
  sameMusic,
  sameSpeakers,
} from './rooms.js';

/**
 * The control channel. Three jobs and no more.
 *
 *  1. Membership — who is standing in which forest.
 *  2. WebRTC signalling relay — SDP and ICE candidates pass through byte for
 *     byte. This server never sees, decodes or touches a single audio sample;
 *     voice goes peer to peer. That is not a performance decision, it is what
 *     makes proximity voice possible at all: spatialising a voice requires it to
 *     arrive as its own stream, and any server that mixes has already thrown the
 *     separation away.
 *  3. Transforms — where everybody is, on a fixed tick.
 *
 * WHY THE FAN-OUT IS A FIXED TICK AND NOT A FORWARD-ON-ARRIVAL.
 *
 * The obvious implementation echoes each client's transform to the room the
 * moment it lands. Its outbound bandwidth is then a function of how chatty the
 * chattiest client is — one peer running at 240 Hz makes the server send 240
 * messages a second to everybody else, and nothing in the protocol says it may
 * not. Batching on a fixed tick bounds the whole thing at TICK_HZ × roomSize
 * messages regardless of what arrives, and it hands every client a predictable
 * cadence to interpolate against, which is what `avatar.js` needs to replay
 * motion smoothly instead of chasing the newest packet.
 */

/**
 * Eighteen hertz.
 *
 * A person walks at 4.4 m/s and runs at 8.2, so a tick covers at most 46 cm —
 * comfortably less than the avatar is wide, which is the threshold at which
 * interpolation between two samples is indistinguishable from continuous
 * motion. Going faster costs bandwidth quadratically in room size and buys
 * nothing the eye can resolve; going slower starts to show as a slight
 * looseness in someone's stride before it shows as anything you could name.
 */
const TICK_HZ = 18;
const TICK_MS = 1000 / TICK_HZ;

const HEARTBEAT_MS = 15_000;

/**
 * A client's own transforms run at the same 18 Hz, so 220 messages a second is
 * an order of magnitude of headroom — the slack is for ICE, which arrives as a
 * burst of dozens of candidates in the first second of every new peer. The
 * limit exists to stop a runaway loop in a modified client, not to police
 * anything a real one does.
 */
const RATE_WINDOW_MS = 1000;
const RATE_MAX_MESSAGES = 220;

/** An SDP offer with a lot of codecs is a few kB. 64 is generous and finite. */
const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * @param {import('node:http').Server} httpServer
 * @param {import('./rooms.js').RoomRegistry} registry
 * @param {object} options
 * @param {(playerId: string) => object[]} options.getIceServers
 * @param {boolean} [options.exclusive] true when this process is the only thing
 *   that wants WebSocket upgrades on this port.
 *
 *   THIS FLAG IS SCAR TISSUE AND IT IS WORTH KEEPING. `ws` given a `server` and
 *   a `path` installs its own upgrade handler and answers **400 to every
 *   upgrade whose path does not match**. Put that on a port a Vite dev server is
 *   also using and it eats Vite's HMR socket: the client sees its connection
 *   rejected, decides the dev server has died, and reloads the whole page every
 *   few seconds — while the actual error is a 400 on a request nobody is
 *   looking at. The previous project lost an evening to it.
 *
 *   v2 does not currently share a port with anything — Vite runs as its own
 *   process on 5180 and proxies `/ws` here — so this is always exclusive today.
 *   The manual upgrade path is kept anyway because the cost is eight lines and
 *   the failure it prevents is invisible.
 */
export function attachSignaling(httpServer, registry, { getIceServers, exclusive = true } = {}) {
  const wss = new WebSocketServer({
    noServer: true,
    // Deflate costs a compression context per socket and latency per message,
    // for payloads that are mostly nine-element arrays of small numbers.
    perMessageDeflate: false,
    maxPayload: MAX_PAYLOAD_BYTES,
  });

  httpServer.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      // Not ours. When we are the only listener nobody else will ever answer
      // this, so say so and close; when we are not, stay silent and let the
      // other handler have it.
      if (exclusive) socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request, url));
  });

  wss.on('connection', (socket, request, url) => {
    const player = registry.newPlayer(socket);
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    request.socket.setNoDelay?.(true);

    /**
     * The room is in the URL, not in a `join` message.
     *
     * One fewer round trip and, more usefully, one fewer state: there is no such
     * thing as a connected-but-unjoined socket here, so nothing downstream has
     * to handle a signal arriving from somebody who is not in a room yet.
     * Reconnecting is re-opening the same URL, which means the retry logic on
     * the client is a plain `new WebSocket(sameUrl)` with no replay.
     */
    const room = registry.getOrCreate(url.searchParams.get('room'));
    if (!room) {
      player.send({ t: 'denied', why: 'That invite code is not a valid one.' });
      socket.close(1008, 'bad room');
      return;
    }
    if (room.isFull) {
      player.send({
        t: 'denied',
        why: `That clearing is full (${room.maxSize}). Voice runs peer to peer, so rooms stay small.`,
      });
      socket.close(1008, 'full');
      return;
    }

    player.name = sanitizeName(url.searchParams.get('name')) || 'Someone';
    player.hue = sanitizeHue(url.searchParams.get('hue'));
    /**
     * The first person into a room teaches it which forest it is.
     *
     * BEFORE `room.add`, so that "am I the first" is a question about the room
     * as it was when this socket arrived rather than one this socket has already
     * changed the answer to. Everyone after that is told what the room is, and
     * nobody overwrites it — see the note on `Room.seed` for why the host's wood
     * has to win however the second person got here.
     */
    if (room.size === 0) {
      room.seed = sanitizeSeed(url.searchParams.get('seed'));
      /**
       * The same "first one in teaches the room" rule, for the two other things
       * a world is: when its clock started, and what time of day it is.
       *
       * `Date.now()` rather than anything the client sent. The seed has to come
       * off the query string because a forest is already built by the time this
       * socket opens and only the client knows which one; the clock does not —
       * it is being STARTED here, and starting it from the arriving client's
       * clock would import that machine's skew into everybody else's water. A
       * host whose system clock is four minutes fast would hand the room an
       * origin four minutes in the past, and every guest's `uTime` would begin
       * four minutes ahead of the host's own.
       *
       * The hour is the opposite case and does come from the client, because it
       * is a CHOICE somebody made in the menu rather than a fact about now. See
       * `Room.dayOrigin`.
       */
      const startedAt = Date.now();
      room.clockOrigin = startedAt;
      const dayAge = sanitizeDayAge(url.searchParams.get('day'));
      room.dayOrigin = dayAge === null ? null : startedAt - dayAge;
    }
    room.add(player);

    player.send({
      t: 'welcome',
      id: player.id,
      room: room.code,
      tickHz: TICK_HZ,
      /**
       * Which wood the room is in, so a client can notice it is in the wrong
       * one. It cannot be fixed from here — a forest is built during module
       * evaluation, long before this message — so this is not a correction, it
       * is the only way the client can find out it needs to reload. The menu
       * asks `/api/room/peek` beforehand precisely so that this never fires; it
       * is the backstop for the J key, which mints a room without asking.
       */
      seed: room.seed,
      /**
       * HOW LONG THIS ROOM'S WORLD HAS BEEN RUNNING, in milliseconds.
       *
       * Not the instant it started. An instant is only meaningful inside one
       * clock domain, and there are as many domains here as there are players:
       * a client whose system clock is two minutes fast would subtract this
       * server's timestamp from its own `Date.now()` and put its water two
       * minutes ahead of everybody else's, with nothing to say so. An age is
       * re-expressed by each client against its own clock, and the residual
       * error is the one-way latency of this message — tens of milliseconds,
       * against wave trains with periods of seconds.
       *
       * See `core/world-clock.js` for what the client does with it, and
       * `Room.clockOrigin` for why the origin is reset when a room empties.
       */
      clockElapsedMs: room.clockOrigin === null ? 0 : Date.now() - room.clockOrigin,
      /**
       * What time of day the room is having, as the age of its day-origin, or
       * null for the true wall clock. Same clock-domain argument as above; see
       * `sanitizeDayAge` and `Room.dayOrigin`.
       */
      dayAgeMs: room.dayOrigin === null ? null : Date.now() - room.dayOrigin,
      /**
       * Where the speakers are, if anybody has moved them. Omitted rather than
       * sent as null in the overwhelmingly common case that nobody has, because
       * the default pair is a constant every client already has.
       */
      ...(room.speakers ? { speakers: room.speakers } : null),
      /** What is on the jukebox, if anything. Omitted for silence. */
      ...(room.music ? { music: room.music } : null),
      /**
       * Which mushrooms have been eaten. Omitted while none have, which is every
       * room for its first few minutes.
       *
       * The only cumulative thing in this payload, and the only one sent as a
       * list. See `Room.eaten` for why it grows rather than being replaced, and
       * `MAX_EATEN` for the size this can reach.
       */
      ...(room.eaten.size ? { eaten: [...room.eaten] } : null),
      // Minted server-side and handed over here. See ice.js for why the token
      // that produced these never appears in this payload.
      iceServers: getIceServers(player.id),
      peers: room.roster(player.id),
    });
    room.broadcast({ t: 'join', peer: player.snapshot() }, player.id);

    socket.on('message', (raw, isBinary) => {
      if (isBinary) return;
      if (!allow(player)) {
        socket.close(1008, 'rate limit');
        return;
      }
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;
      try {
        handle(player, msg);
      } catch (err) {
        console.error(`[ws] ${msg.t} threw:`, err?.message);
      }
    });

    socket.on('close', () => {
      if (player.room) {
        player.room.remove(player.id);
        player.room.broadcast({ t: 'leave', id: player.id });
      }
      registry.release(player);
    });

    socket.on('error', () => {
      try {
        socket.terminate();
      } catch {
        /* already gone */
      }
    });
  });

  /**
   * Half-open sockets are the norm on mobile and behind NAT: the peer vanishes
   * without a FIN and the socket sits in a perfectly healthy-looking OPEN state
   * forever. Without this, that player's avatar stands motionless in the
   * clearing until the room is reaped.
   */
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {
        /* the close handler will clean up */
      }
    }
  }, HEARTBEAT_MS);

  const tick = setInterval(() => {
    for (const room of registry.rooms.values()) {
      // Nobody to tell. A room of one is the overwhelmingly common case for a
      // hobby server and this keeps it free.
      if (room.size < 2) continue;
      const rows = [];
      for (const p of room.players.values()) rows.push(p.row());
      /**
       * Everyone gets every row, including their own.
       *
       * Filtering each recipient's own row out would mean a distinct payload per
       * player — roomSize stringifies per tick instead of one — to save nine
       * numbers, and the client discards its own id in a single comparison. It
       * is also a useful loop-back: a client can see the transform the server
       * actually holds for it, which is how you find out that your clamp fired.
       */
      room.broadcast({ t: 'S', d: rows });
    }
  }, TICK_MS);

  wss.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(tick);
  });

  return wss;
}

function allow(player) {
  const now = Date.now();
  if (now - player.windowStart > RATE_WINDOW_MS) {
    player.windowStart = now;
    player.messagesInWindow = 0;
  }
  player.messagesInWindow += 1;
  return player.messagesInWindow <= RATE_MAX_MESSAGES;
}

function handle(player, msg) {
  switch (msg.t) {
    case 's':
      player.applyState(msg.d);
      return;

    /**
     * Signalling relay.
     *
     * `msg.data` is forwarded untouched and unread. It is an SDP blob or an ICE
     * candidate and the server has no business understanding either — every
     * feature that would require parsing it (transcoding, recording, an SFU)
     * is a feature this project does not have and does not want. The only
     * checks are that the recipient exists and is in the sender's own room,
     * which is what stops the relay being used to reach strangers.
     */
    case 'signal': {
      if (typeof msg.to !== 'string') return;
      const target = player.room?.players.get(msg.to);
      if (!target || target === player) return;
      target.send({ t: 'signal', from: player.id, data: msg.data });
      return;
    }

    /**
     * A change of appearance: a new name, a new dye, or both.
     *
     * ONE MESSAGE FOR BOTH, because to everybody else they are one fact — who
     * that is over there. The colour and the name are the entire identity this
     * game has (`avatar.js` refuses nameplates, so the log is the only place a
     * name appears and the aura is the only thing tying it to a body), and
     * shipping them apart would mean a window in which the log and the wood
     * disagree about who somebody is.
     *
     * Both fields are optional and a message that changes nothing is dropped.
     * The dye is deliberately allowed to be set to null — that is a person going
     * back to being coloured by their id, which is a real thing to want and is
     * indistinguishable from "unset" everywhere downstream.
     */
    case 'look': {
      const name = sanitizeName(msg.name) || player.name;
      const hue = sanitizeHue(msg.hue);
      if (name === player.name && hue === player.hue) return;
      player.name = name;
      player.hue = hue;
      player.room?.broadcast({ t: 'look', id: player.id, name, hue });
      return;
    }

    /**
     * Somebody said something.
     *
     * Echoed back to the sender as well as forwarded, deliberately. The
     * alternative — the client prints its own line optimistically and the
     * server only tells everyone else — means your copy of the conversation is
     * assembled from two sources with different latencies, so your own line can
     * appear above a reply that was actually written before it. Letting the
     * server order every line, including your own, makes the log the same log
     * on all eight screens for one round trip's worth of delay, which on a
     * conversation is nothing.
     */
    case 'chat': {
      const text = sanitizeChat(msg.text);
      if (!text) return;
      if (!player.mayChat()) return;
      player.room?.broadcast({ t: 'chat', id: player.id, name: player.name, text });
      return;
    }

    /**
     * A thing that happened rather than a thing that was said.
     *
     * "…landed a chub" is generated by the client that caught it, so a modified
     * client can claim any fish it likes. That is fine and is the same trust
     * model as the rest of this server: there is no scoreboard, nothing is
     * scarce, and the worst available outcome is that a friend lies to you about
     * a fish. It shares chat's budget so it cannot be used to route around it.
     */
    case 'note': {
      const text = sanitizeChat(msg.text);
      if (!text) return;
      if (!player.mayChat()) return;
      player.room?.broadcast({ t: 'note', id: player.id, name: player.name, text });
      return;
    }

    /**
     * Where this player's shared screen is, or that it has stopped.
     *
     * The pixels are not here — they are a WebRTC video track that went straight
     * from one machine to another without touching this process. All this does
     * is carry a spot, and remember the answer for whoever walks in next.
     *
     * `samePresent` rather than `===` because this is now an object and two
     * objects that mean the same thing are not the same object. Without it the
     * dedupe silently stopped working, and a resize — which the client sends on
     * a trailing timer while somebody spins a scroll wheel — fanned every
     * intermediate width out to the whole room.
     */
    case 'present': {
      const at = sanitizePresent(msg.at);
      if (samePresent(at, player.present)) return;
      player.present = at;
      player.room?.broadcast({ t: 'present', id: player.id, at });
      return;
    }

    /**
     * Where the two speaker cabinets are standing.
     *
     * Room furniture rather than one person's possession, so it is stored on
     * the room and survives whoever moved it leaving. See `sanitizeSpeakers`.
     *
     * Deduped with `sameSpeakers` for the same reason `present` is: a client
     * re-announcing an unchanged placement — which every reconnect does — must
     * not fan a redundant move out to seven other machines, each of which would
     * rebuild two collider sectors and ask for a shadow re-render to arrive
     * back exactly where it already was.
     */
    case 'speakers': {
      const at = sanitizeSpeakers(msg.at);
      if (!at || !player.room) return;
      if (sameSpeakers(at, player.room.speakers)) return;
      player.room.speakers = at;
      player.room.broadcast({ t: 'speakers', at }, player.id);
      return;
    }

    /**
     * What is on the jukebox. Six bytes that make eight machines play the same
     * record — see `sanitizeMusic`.
     *
     * Null is a legal value here and means silence, so this deliberately does
     * NOT bail on a falsy payload the way `speakers` does: "nothing is playing"
     * is a thing somebody just did by pressing E, and it has to travel.
     */
    case 'music': {
      if (!player.room) return;
      const state = sanitizeMusic(msg.state);
      if (state === null && msg.state !== null) return; // malformed, not silence
      if (sameMusic(state, player.room.music)) return;
      player.room.music = state;
      player.room.broadcast({ t: 'music', state }, player.id);
      return;
    }

    /**
     * Somebody ate a mushroom, and it does not grow back for anybody.
     *
     * THE SMALLEST MESSAGE IN THE PROTOCOL, and the only one whose effect is
     * cumulative — see `Room.eaten`. It is also the only piece of shared world
     * state a player can create rather than move: the speakers and the jukebox
     * existed before anybody touched them, and this is a thing that happened.
     *
     * The Set does the dedupe that `sameSpeakers` and `sameMusic` do elsewhere,
     * and it is doing real work rather than saving a broadcast. Two people
     * standing over one patch and pressing E in the same second must produce one
     * mushroom eaten, not a message that goes round the room twice — and the
     * client's `eatPatch` refuses a repeat for the same reason at its own end,
     * so an echo that got this far would stop there too.
     */
    case 'eat': {
      const id = sanitizePatchId(msg.id);
      if (!id || !player.room) return;
      if (player.room.eaten.has(id)) return;
      // Past the cap the room stops remembering. Deliberately still relayed:
      // everybody currently standing here watched it happen, and a mushroom
      // that vanishes for seven people and not the eighth is worse than one
      // that comes back for somebody who arrives later. See `MAX_EATEN`.
      if (player.room.eaten.size < MAX_EATEN) player.room.eaten.add(id);
      player.room.broadcast({ t: 'eat', id }, player.id);
      return;
    }

    // Round-trip time, measured by the client against its own clock so the two
    // machines never have to agree on what time it is.
    case 'ping':
      /**
       * The room's age rides on the pong, and this is how the world clock
       * actually gets accurate.
       *
       * `welcome` carries the same number, but a client cannot use it well: it
       * is processed while that page is building a forest, so `Date.now()` in
       * the handler can be a second or more after the packet was sent, and the
       * whole of that delay lands in the client's origin with no way to see it
       * from the inside. Measured on this project's own machine: one client
       * 1024 ms out from another, both convinced they were right.
       *
       * A round trip is the only thing that can recover it, because only a
       * round trip is measured entirely in one clock. By the time the ping
       * timer has fired once the page has settled, the RTT is honest, and the
       * client re-anchors off the lowest one it has seen. See `_dispatch`.
       */
      player.send({
        t: 'pong',
        ts: msg.ts,
        elapsed: player.room?.clockOrigin == null ? null : Date.now() - player.room.clockOrigin,
      });
      return;

    default:
      return;
  }
}
