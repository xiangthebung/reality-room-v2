import { randomBytes } from 'node:crypto';

/**
 * Who is in which forest.
 *
 * The registry is in-process and deliberately tiny. It holds membership and the
 * last transform each client reported, and nothing else — no physics, no
 * authority over where anybody is, no world state.
 *
 * WHY THE SERVER DOES NOT SIMULATE. Every interesting thing in this project is a
 * pure function of a seed and a clock evaluated on the GPU, so there is nothing
 * for a server to be authoritative *about*: the terrain is identical on every
 * machine because `terrain.js` says so, not because anyone was told. That leaves
 * exactly one thing that genuinely has to travel — where people are — and for a
 * walk in the woods with friends, trusting the client with its own position is
 * both correct and the only way to get motion that is perfectly smooth. There is
 * nothing here worth cheating at.
 *
 * The one thing the server does clamp is magnitude, because a client that sends
 * 1e30 does not cheat anybody, it makes everyone else's interpolator produce NaN
 * and their PannerNodes throw.
 */

/**
 * Invite codes.
 *
 * The alphabet has no `i`, `l`, `o`, `0` or `1` in it, because an invite code's
 * job is to survive being read out over a voice call and typed by somebody else.
 * Grouping into threes is the same argument: a nine-character run of random
 * letters is unreadable aloud, `pxk-mwe-q7t` is three chunks of three.
 */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_GROUPS = 3;
const CODE_GROUP_LEN = 3;

/** Empty rooms are forgotten after this. An invite link outlives it — see getOrCreate. */
const ROOM_IDLE_MS = 30 * 60_000;

/**
 * Bit flags on the wire. Mirrored in `src/net/protocol.js`, which the server
 * cannot import because it is client code and this file has no build step.
 */
export const FLAG_MOVING = 1 << 0;
export const FLAG_GROUNDED = 1 << 1;
export const FLAG_MUTED = 1 << 2;
export const FLAG_SPEAKING = 1 << 3;
/** Pose bits. The server never reads these; they ride along in `flags`. */
export const FLAG_SITTING = 1 << 4;
export const FLAG_FISHING = 1 << 5;
export const FLAG_BITE = 1 << 6;
export const FLAG_PRESENTING = 1 << 7;

/** Mirrored in `src/net/protocol.js`. Enforced here because that copy is advisory. */
export const CHAT_MAX_CHARS = 240;
/** Mirrored in `src/net/protocol.js`. How wide a placed screen may be, in metres. */
const SHARE_MIN_W = 1.2;
const SHARE_MAX_W = 16;

/**
 * Chat's own budget, separate from and far below the message rate limit.
 *
 * The 220/s ceiling in signaling.js is sized for ICE bursts and an 18 Hz
 * transform stream, which means it is no limit at all on something a human
 * types: a script could push two hundred lines a second through it and stay
 * inside the rule. Speech has a completely different natural rate from
 * telemetry, so it gets a completely different budget — eight lines in ten
 * seconds is faster than anyone talks and slower than anyone floods.
 *
 * Over budget is a DROP, not a disconnect. Being cut off from your friends for
 * typing quickly is a much worse outcome than a line going missing, and the
 * transform stream on the same socket is innocent either way.
 */
const CHAT_WINDOW_MS = 10_000;
const CHAT_MAX_IN_WINDOW = 8;

/** Sane world bounds. The forest is 190 m in radius; this is generous slack. */
const MAX_ABS_XZ = 600;
const MAX_ABS_Y = 600;

export function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (cleaned.length !== CODE_GROUPS * CODE_GROUP_LEN) return null;
  for (const ch of cleaned) if (!CODE_ALPHABET.includes(ch)) return null;
  const groups = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    groups.push(cleaned.slice(g * CODE_GROUP_LEN, (g + 1) * CODE_GROUP_LEN));
  }
  return groups.join('-');
}

export function randomCode() {
  const bytes = randomBytes(CODE_GROUPS * CODE_GROUP_LEN);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0 && i % CODE_GROUP_LEN === 0) out += '-';
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/**
 * Names are cosmetic and never rendered as DOM, but they are rendered *to other
 * people*, so the control characters and bidi overrides that let one player
 * scramble another player's screen come out here.
 */
export function sanitizeName(raw) {
  return stripControls(raw).trim().slice(0, 20);
}

/**
 * A player's chosen dye, 0..1, or null for "colour me by my id".
 *
 * Mirrors `sanitizeHue` in `src/net/protocol.js`. Wrapped rather than clamped
 * because a hue is a circle: 1.25 and −0.75 are the same colour, and clamping
 * would turn every out-of-range value into the same red.
 *
 * Null is a real answer and is not an error. Everybody had one of these before
 * the menu existed — `hueFromId` is a pure function of the player id that every
 * client computes independently — so a client that sends nothing is not broken,
 * it is a client whose player never opened the menu.
 */
export function sanitizeHue(raw) {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(n)) return null;
  return r3(((n % 1) + 1) % 1);
}

/**
 * The wood a room is standing in. See `Room.seed`.
 *
 * Length-capped and stripped, not validated: any string is a legal seed —
 * `core/world-seed.js` runs it through FNV-1a before anything numeric happens to
 * it — so there is nothing to reject here, only something to bound. This value is
 * handed back out through `/api/room/peek` and ends up in somebody's address bar,
 * which is the whole reason the control characters come out.
 */
export function sanitizeSeed(raw) {
  const cleaned = stripControls(raw).trim().slice(0, 64);
  return cleaned || null;
}

/**
 * The longest a shared day-origin may be in the past, in milliseconds.
 *
 * Two hours, against an honest maximum of twenty minutes. `arrivalOrigin`
 * subtracts `phase * CYCLE_SECONDS` from now, the cycle is twenty minutes and
 * the phase is under 1, so every value a real client can produce is inside
 * 1.2e6 ms. The margin is for a debug session that has slowed the day down with
 * `dayScale`, which divides by the scale and can legitimately stretch it.
 *
 * WHAT THE BOUND IS PROTECTING. The client turns this into a phase by dividing
 * by the cycle length, and it lands in a float32 uniform whose precision decays
 * with magnitude exactly as described on `Room.clockOrigin`. A hostile age of
 * 1e15 does not error anywhere — it quantises the sun into visible steps and
 * reads as a rendering bug in the sky, on everybody else's screen but not on
 * the sender's.
 */
const DAY_AGE_MAX_MS = 2 * 60 * 60 * 1000;

/**
 * The room's hour — as an AGE rather than as an instant. See `Room.dayOrigin`.
 *
 * MILLISECONDS AGO, NOT EPOCH MILLISECONDS, AND THAT IS THE WHOLE CARE IN THIS
 * FUNCTION. The receiving client computes its day phase from
 * `(itsOwnDateNow - origin)`, so an absolute epoch value only means the same
 * thing on two machines whose clocks agree — and consumer clocks are routinely
 * seconds apart, occasionally minutes. Sending "this started 412000 ms ago"
 * lets every client re-express the origin in ITS OWN clock domain, and the only
 * error left is the one-way network latency of the message carrying it: tens of
 * milliseconds against a twenty-minute cycle, which is about a thousandth of a
 * degree of sun. The same reasoning governs `clockElapsedMs` in the welcome.
 *
 * NULL IS A VALUE HERE AND NOT A REJECTION — it means "run on the real wall
 * clock", which is what the `whenever` arrival asks for and what every session
 * that never opened the menu gets. The caller distinguishes "no first player
 * yet" by asking the room's size, not by asking this.
 */
export function sanitizeDayAge(raw) {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > DAY_AGE_MAX_MS) return null;
  return n;
}

/**
 * The same treatment for a line of chat, and the same reasoning at ten times the
 * length.
 *
 * Chat is rendered as TEXT, never as HTML — `textContent`, in `src/ui/social.js`
 * — so this is not an XSS filter and must not be mistaken for one. It exists
 * because the characters below are invisible: a right-to-left override in the
 * middle of a sentence reverses everything after it on somebody else's screen,
 * and a run of zero-width spaces is a message that appears to be blank. Both are
 * things one person can do to another person's window, which is the only
 * category of hostile input a room of eight friends actually has.
 *
 * Runs of whitespace collapse for the same reason names are trimmed: forty
 * newlines is a way to make one line of chat occupy the whole log.
 */
export function sanitizeChat(raw) {
  return stripControls(raw).replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_CHARS);
}

function stripControls(raw) {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue; // C0 / C1 controls
    if (code >= 0x200b && code <= 0x200f) continue; // zero-width and bidi marks
    if (code >= 0x2028 && code <= 0x202e) continue; // separators and bidi overrides
    if (code === 0xfeff) continue; // byte-order mark used as an invisible space
    out += ch;
  }
  return out;
}

/**
 * Where somebody's shared screen is, or null. Mirrors `sanitizePlacement` in
 * `src/net/protocol.js`; see that file for the vocabulary and why it has
 * coordinates in it now.
 *
 * Rejecting outright rather than repairing is the point. A placement this
 * function half-understood would arrive at seven other machines as a screen at
 * NaN, and a NaN reaching a matrix propagates into the projection and takes the
 * whole frame black — for everybody except the person who sent it.
 */
/**
 * One cabinet's standing place, or null. The building block of
 * `sanitizeSpeakers`.
 */
function sanitizeSpot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { x, y, z, yaw } = raw;
  for (const n of [x, y, z, yaw]) if (!Number.isFinite(n)) return null;
  if (Math.abs(x) > MAX_ABS_XZ || Math.abs(z) > MAX_ABS_XZ || Math.abs(y) > MAX_ABS_Y) return null;
  return { x: r2(x), y: r2(y), z: r2(z), yaw: r3(yaw) };
}

/**
 * WHERE THE TWO SPEAKER CABINETS ARE STANDING.
 *
 * ROOM STATE, NOT PLAYER STATE, and that is the one interesting thing about it.
 * A shared screen belongs to whoever put it up: it arrives with them, leaves
 * with them, and two people presenting is two screens. The speakers are the
 * opposite — there is exactly one pair in the world, anybody may move either
 * box, and the pair does not belong to the person who last touched it. So this
 * lives on the `Room` beside `seed` rather than on the `Player` beside
 * `present`, and the difference shows up the moment somebody leaves: their
 * screen goes with them and the speakers stay where they put them, which is
 * what both of those things are for.
 *
 * LAST WRITE WINS, WITH NO ARBITRATION, for the same reason the screens gave up
 * their claim counter: two people moving speakers is the same situation as two
 * people moving furniture in a room, and the answer a real room gives is that
 * the last one to touch it decides. Nothing here can end in a state where a box
 * is unusable because a machine somewhere thinks somebody else has it.
 *
 * `next` is carried because it cannot be derived. It is whose turn the
 * alternation is on, and a receiver that kept its own copy would send the next
 * `G` to a different cabinet than the sender expected — so two people taking
 * turns would shuffle one box back and forth and never touch the other.
 */
export function sanitizeSpeakers(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const l = sanitizeSpot(raw.l);
  const r = sanitizeSpot(raw.r);
  if (!l || !r) return null;
  return { l, r, next: raw.next === 1 ? 1 : 0 };
}

/** True if two speaker placements say the same thing. See `samePresent`. */
export function sameSpeakers(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.next !== b.next) return false;
  for (const side of ['l', 'r']) {
    for (const k of ['x', 'y', 'z', 'yaw']) {
      if (a[side][k] !== b[side][k]) return false;
    }
  }
  return true;
}

/**
 * WHAT THE JUKEBOX IS PLAYING, AND WHEN IT STARTED.
 *
 * Room state, like the speakers and for the same reason: there is one machine
 * in the clearing and it does not belong to whoever last pressed a key on it.
 *
 * TWO KINDS, BECAUSE THE JUKEBOX HAS ALWAYS HAD TWO AND THEY SYNCHRONISE BY
 * COMPLETELY DIFFERENT MEANS.
 *
 *   {kind:'record', track, at}   one of the synthesised records. `track` is an
 *                                index into TRACKS; the sequencer is a pure
 *                                function of (bar, step), so an index and a
 *                                start time are enough for every client to
 *                                generate the same notes independently. NO
 *                                AUDIO CROSSES THE NETWORK — this is six bytes
 *                                describing a performance that happens eight
 *                                times over.
 *   {kind:'link', id, title, at} a pasted YouTube link. Here each client really
 *                                does fetch the same stream from this server
 *                                and seeks to `now - at`.
 *
 * `at` IS IN WORLD-CLOCK SECONDS, not epoch milliseconds, and that is the one
 * subtle thing in here. The room already maintains a clock that every client
 * has agreed to within about a millisecond (see `Room.clockOrigin`), so
 * expressing the start against THAT needs no conversion at either end and
 * cannot be knocked out by a machine whose system clock is wrong. It is also
 * why this needs no `Date.now()` anywhere in this function.
 *
 * The URL is not stored — only the video id, which is what `/api/youtube/audio`
 * takes. A full URL would be a string of somebody's choosing rebroadcast to
 * seven other machines, and there is no reason to carry one.
 */
export function sanitizeMusic(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at < 0) return null;
  if (raw.kind === 'record') {
    const track = Number(raw.track);
    if (!Number.isInteger(track) || track < 0 || track > 63) return null;
    return { kind: 'record', track, at: r2(at) };
  }
  if (raw.kind === 'link') {
    // YouTube ids are 11 characters of [A-Za-z0-9_-]. Anything else is not one,
    // and this string is pasted straight into a URL by seven other clients.
    if (typeof raw.id !== 'string' || !/^[\w-]{11}$/.test(raw.id)) return null;
    const title = stripControls(raw.title).replace(/\s+/g, ' ').trim().slice(0, 120);
    return { kind: 'link', id: raw.id, title, at: r2(at) };
  }
  return null;
}

/** True if two jukebox states say the same thing. See `samePresent`. */
export function sameMusic(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind || a.at !== b.at) return false;
  return a.kind === 'record' ? a.track === b.track : a.id === b.id;
}

/**
 * How many eaten mushrooms a room will remember.
 *
 * A number chosen against the welcome payload rather than against memory. The
 * whole set is replayed to every arrival, so the cost of this cap is 512 ids of
 * about twenty characters — some ten kilobytes, once, to a client that is at
 * that moment building a forest. Reaching it means a room has eaten five
 * hundred mushrooms, at one per 32 m undergrowth sector; past it the room stops
 * remembering and the five hundred and first grows back for the next arrival,
 * which is a strictly better failure than an unbounded set fed by a client that
 * has decided to send ids all day.
 */
export const MAX_EATEN = 512;

/**
 * ONE MUSHROOM PATCH, NAMED THE SAME WAY ON EVERY MACHINE.
 *
 * `under:sx,sz:i` — the undergrowth sector it grew in, and its index within
 * that sector. Not an identifier this server assigns or a client invents: the
 * grid is a function of the sector size and the index a function of the scatter,
 * and both of those are functions of the room's seed. So a client that has never
 * exchanged a byte about mushrooms already knows every id in its world, and
 * eating one costs exactly this string.
 *
 * That is also why the format is checked rather than the string merely trimmed.
 * It is stored, replayed to every future arrival, and looked up in a Set on
 * seven other machines; a client with something else in mind gets to put twenty
 * characters matching this pattern into that Set and nothing else. The bounded
 * digit counts are the point — `sx` at ±999999 is a sector 32000 km out, well
 * past anywhere the world is finite enough to walk to.
 */
const PATCH_ID = /^under:-?\d{1,6},-?\d{1,6}:\d{1,3}$/;

export function sanitizePatchId(raw) {
  if (typeof raw !== 'string') return null;
  return PATCH_ID.test(raw) ? raw : null;
}

/**
 * A ROW OF NUMBERS THE SERVER DELIBERATELY CANNOT READ.
 *
 * `world/fauna.js` owns what an animal snapshot means at both ends; this checks
 * that it is an array of finite numbers and that there are not too many of them,
 * and forwards it. That is the same relationship this process has with an SDP
 * offer, and it is on purpose: the server has never known what a forest is (it
 * imports nothing from `src/` and not even `three`), and animals are not the
 * thing to change that for. A schema here would be a second copy of the wire
 * format to keep in step, on the one side that gains nothing from knowing it.
 *
 * The bound is a memory bound, not a validation. 23 animals × 8 fields is 184
 * and the coats are 18 more; 512 leaves room for the population to grow without
 * this needing a thought, and stops a modified client posting a megabyte of
 * numbers six times a second for the room to fan out.
 */
const MAX_FAUNA_NUMBERS = 512;

export function sanitizeNumbers(raw, limit = MAX_FAUNA_NUMBERS) {
  if (!Array.isArray(raw) || raw.length > limit) return null;
  for (const n of raw) if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return raw;
}

export function sanitizePresent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { x, y, z, yaw, w } = raw;
  for (const n of [x, y, z, yaw, w]) if (!Number.isFinite(n)) return null;
  if (Math.abs(x) > MAX_ABS_XZ || Math.abs(z) > MAX_ABS_XZ || Math.abs(y) > MAX_ABS_Y) return null;
  return {
    x: r2(x),
    y: r2(y),
    z: r2(z),
    yaw: r3(yaw),
    w: r2(Math.min(SHARE_MAX_W, Math.max(SHARE_MIN_W, w))),
  };
}

/**
 * Two placements that mean the same thing. Cheaper than broadcasting a no-op.
 *
 * WORTH HAVING BECAUSE OF THE SCROLL WHEEL. Resizing sends a burst of objects
 * that are structurally distinct and often numerically identical — the client
 * rate-limits to one announcement every 160 ms and the sanitiser above rounds to
 * a centimetre, so a slow turn of a wheel genuinely does produce the same five
 * numbers twice. `===` on two fresh objects is always false; this is the test
 * that was meant.
 */
export function samePresent(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.z === b.z && a.yaw === b.yaw && a.w === b.w;
}

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
const clamp01 = (n) => (Number.isFinite(n) ? clamp(n, 0, 1) : 0);
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

export class Player {
  constructor(id, socket) {
    this.id = id;
    this.socket = socket;
    this.room = null;
    this.name = 'Someone';
    /**
     * The dye this player chose in the main menu, 0..1, or null.
     *
     * Null is the ordinary case and not a missing value: before the menu existed
     * every avatar was coloured by `hueFromId`, a pure function of the id that
     * each client works out for itself, and that is still what a null means. So
     * this field is only ever the exception — somebody who opened the menu and
     * picked — which is why it is omitted from the snapshot when unset rather
     * than sent as null to eight people.
     */
    this.hue = null;
    this.joinedAt = Date.now();

    this.px = 0;
    this.py = 0;
    this.pz = 0;
    this.yaw = 0;
    this.pitch = 0;
    /** Speech envelope, 0..1. Drives the glow on this player's avatar elsewhere. */
    this.voice = 0;
    /** Trip level, 0..1. Purely so other people can see that you are not all right. */
    this.trip = 0;
    this.flags = 0;
    /**
     * Where this player's shared screen is. See `sanitizePresent`.
     *
     * THE ONE PIECE OF STATE THIS SERVER KEEPS ON PURPOSE, and it is worth
     * saying why given the file's opening claim that it keeps none.
     *
     * Everything else here is either membership or a transform that will be
     * replaced 55 ms from now, so a client that misses a packet is corrected by
     * the next one. A presentation is not like that: it is announced once, when
     * somebody puts a screen down, and then stays true for twenty minutes.
     * Somebody walking in halfway through would otherwise see a peer with a
     * video track and no idea what to do with it — or, worse, walk past a blank
     * rectangle in a clearing with four people sitting in front of it. So the
     * announcement is remembered and replayed in the roster.
     *
     * IT GREW COORDINATES AND IT IS STILL NOT A SIMULATION. This used to be one
     * short string naming one of two fixed surfaces; it is now five numbers
     * naming a spot. That is more bytes and exactly the same amount of STATE —
     * one value per player, written when they act, replayed to arrivals, dropped
     * when they leave. Nothing here integrates, decays, or has to be reconciled
     * against anybody else's copy, which is the property that mattered.
     */
    this.present = null;

    this.windowStart = 0;
    this.messagesInWindow = 0;
    this.chatWindowStart = 0;
    this.chatInWindow = 0;
  }

  /** What someone already in the room is told when this player walks in. */
  snapshot() {
    return {
      id: this.id,
      name: this.name,
      p: [r2(this.px), r2(this.py), r2(this.pz)],
      r: [r3(this.yaw), r3(this.pitch)],
      f: this.flags,
      // Omitted when nobody chose one, for the same reason `present` is: a
      // roster of eight would otherwise carry eight nulls to say that eight
      // people are using the colour their client already knows how to compute.
      ...(this.hue === null ? null : { h: this.hue }),
      // Omitted rather than sent as null, because the overwhelmingly common
      // case is that nobody is presenting and a roster of eight would otherwise
      // carry eight nulls to say so.
      ...(this.present ? { present: this.present } : null),
    };
  }

  /** True if this player may say something right now. See CHAT_MAX_IN_WINDOW. */
  mayChat(now = Date.now()) {
    if (now - this.chatWindowStart > CHAT_WINDOW_MS) {
      this.chatWindowStart = now;
      this.chatInWindow = 0;
    }
    this.chatInWindow += 1;
    return this.chatInWindow <= CHAT_MAX_IN_WINDOW;
  }

  /**
   * One row of the fixed-tick fan-out.
   *
   * Positional, not an object with keys. This array is repeated once per player
   * per tick, eighteen times a second, forever — `{"id":"abc","x":1.2,...}` is
   * about three times the bytes of `["abc",1.2,...]` and every one of those
   * bytes is a key the receiver already knows the order of.
   *
   * Coordinates are rounded to a centimetre and angles to a milliradian. Below
   * that the numbers are describing jitter in a floating-point accumulator, not
   * anything a person could see; at 190 m the angular resolution of a
   * milliradian is 19 cm, which is smaller than the avatar.
   */
  row() {
    return [
      this.id,
      r2(this.px),
      r2(this.py),
      r2(this.pz),
      r3(this.yaw),
      r3(this.pitch),
      Math.round(this.voice * 100),
      this.flags,
      Math.round(this.trip * 100),
    ];
  }

  /** Apply a reported transform. Everything here is hostile input. */
  applyState(d) {
    if (!Array.isArray(d) || d.length < 7) return;
    for (let i = 0; i < 7; i++) if (!Number.isFinite(d[i])) return;
    this.px = clamp(d[0], -MAX_ABS_XZ, MAX_ABS_XZ);
    this.py = clamp(d[1], -MAX_ABS_Y, MAX_ABS_Y);
    this.pz = clamp(d[2], -MAX_ABS_XZ, MAX_ABS_XZ);
    this.yaw = clamp(d[3], -Math.PI * 4, Math.PI * 4);
    this.pitch = clamp(d[4], -Math.PI, Math.PI);
    this.voice = clamp01(d[5]);
    this.flags = d[6] | 0;
    this.trip = Number.isFinite(d[7]) ? clamp01(d[7]) : 0;
    // A muted client that keeps sending a live envelope would light its own
    // avatar up while producing no sound, which reads as a bug in the voice
    // chain rather than as a lie. Cheaper to make it impossible here.
    if (this.flags & FLAG_MUTED) this.voice = 0;
  }

  send(payload) {
    if (this.socket.readyState !== 1) return;
    try {
      this.socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    } catch {
      /* the socket is going away; its close handler does the cleanup */
    }
  }
}

export class Room {
  constructor(code, maxSize) {
    this.code = code;
    this.maxSize = maxSize;
    this.players = new Map();
    this.createdAt = Date.now();
    this.emptySince = Date.now();
    /**
     * WHICH WOOD THIS ROOM IS IN, AND WHY A SERVER THAT SIMULATES NOTHING KEEPS
     * IT.
     *
     * Every session generates its own forest from a seed string, and everything
     * about that forest — the height field, the ridge, the stream, the scatter
     * of every tree — is a pure function of it. Two people in one room with two
     * different seeds is not a subtle bug: their avatars walk through trees that
     * are not there and stand at different heights on identical coordinates, and
     * nothing anywhere throws. It just looks like the netcode is broken.
     *
     * An invite LINK never had this problem, because it carries `?seed=` next to
     * `?room=` and the guest builds the host's wood before opening a socket. A
     * typed CODE has nothing to carry it — the whole point of a code is that it
     * survives being read down a telephone — so the code has to be enough on its
     * own, and the only thing both people can ask is this process.
     *
     * FIRST ONE IN SETS IT, and it is never overwritten while anybody is here.
     * That makes the host's world the room's world no matter how the second
     * person arrives, which is the behaviour an invite link already had. It is
     * cleared when the room empties rather than kept, because a code outlives its
     * room by design (see `getOrCreate`) and a wood nobody is standing in is not
     * a wood anybody should be sent to a week later.
     *
     * This is a CACHE OF SOMETHING THE CLIENTS ALREADY AGREE ABOUT, not state the
     * server is authoritative over. Nothing here integrates it, reconciles it or
     * corrects anybody with it; a client that ignores what it is told simply ends
     * up in the wrong wood, exactly as it would today.
     */
    this.seed = null;

    /**
     * WHEN THIS ROOM'S WORLD CLOCK STARTED. Epoch milliseconds, or null.
     *
     * Everything that moves without being told to — the river's waves, the
     * clouds, the campfire, the wind through every tree — is a function of one
     * number, and that number used to be "seconds since this tab loaded". Two
     * tabs load at different times, so two people on the same jetty watched
     * different water. See `core/world-clock.js` for the whole argument.
     *
     * SET WITH THE SEED AND CLEARED WITH IT, and both halves of that matter.
     * Set together, because a room's world is its forest AND its clock and
     * neither is meaningful without the other. Cleared together, because the
     * client's copy is a float32 shader uniform whose precision decays as the
     * number grows — about 2 ms of rounding after eight hours, 60 ms after a
     * week — and letting an origin persist across an empty room would age it
     * with the CODE rather than with the session. `createdAt` above is not a
     * substitute for the same reason: it is the age of the room, and this is
     * the age of the gathering.
     *
     * Not `createdAt` for one more reason: rooms are minted by `getOrCreate`
     * the instant somebody peeks at a code, so `createdAt` can predate the
     * first arrival by however long the menu sat open.
     */
    this.clockOrigin = null;

    /**
     * THE HOUR, AS AN ORIGIN RATHER THAN AS AN HOUR. Epoch milliseconds, or
     * null for "whatever time it really is".
     *
     * The menu offers five arrivals — whenever, morning, midday, dusk, night —
     * and `identity.arrivalOrigin` turns the chosen one into the epoch shift
     * that puts that phase on the clock *now*. The shift is what travels, not
     * the choice, and the difference is the whole reason this is a number:
     *
     *   Somebody opens a room at dusk. Forty minutes later a friend joins. Send
     *   the CHOICE and the friend arrives at dusk while the host is in full
     *   dark — two people in one wood at two times of day, which is a strictly
     *   worse failure than the one this fixes, because now the sky disagrees
     *   AND the shadows do. Send the ORIGIN and the friend's sun is exactly
     *   where the host's sun is, forever after, with nothing further sent.
     *
     * Null is a real value and not a missing one: it means the room is running
     * on the true wall clock, which is what everybody gets when nobody picked
     * an hour. It is therefore stored and forwarded distinctly from "the first
     * player has not arrived yet" — see the `size === 0` guard in signaling.js.
     *
     * HELD IN THIS PROCESS'S CLOCK DOMAIN, sent in nobody's. It arrives as an
     * age, is immediately re-expressed against this server's `Date.now()`, and
     * is turned back into an age on the way out to each client. The server is
     * the only participant that talks to everybody, which makes it the only
     * place a single clock domain is available to convert through — see
     * `sanitizeDayAge` for why an absolute instant on the wire is wrong.
     */
    this.dayOrigin = null;

    /**
     * Where the two speaker cabinets are standing, or null while nobody has
     * moved them. See `sanitizeSpeakers` for why this is room state rather than
     * player state.
     *
     * Null is meaningful and is not "unknown": it means the pair is wherever
     * `buildSpeakers` puts it, which every client works out from the same
     * constant without being told. Sending nothing is therefore the correct
     * description of a room where nobody has touched them, and it keeps the
     * welcome empty in the common case — the same reason `present` and `hue`
     * are omitted rather than sent as nulls.
     */
    this.speakers = null;

    /**
     * What the jukebox is playing, or null for silence. See `sanitizeMusic`.
     *
     * Null is the ordinary state and is sent as an omission, the same as
     * `speakers`: a room where nobody has put a record on is most rooms, and
     * the welcome should not carry a field to say so.
     */
    this.music = null;

    /**
     * Every mushroom patch anybody in this room has eaten. See
     * `sanitizePatchId`.
     *
     * CUMULATIVE, WHICH MAKES IT THE ODD ONE OUT. The speakers and the jukebox
     * are each a single current value that the last write replaces; this only
     * ever grows, because eating a mushroom is not a state the room is in, it is
     * something that happened. So it is relayed as a single id rather than a
     * whole set — the smallest message in the protocol — and the accumulated set
     * is sent exactly once, on the welcome.
     *
     * A Set and not an array so the dedupe that every other case does with a
     * `sameX` helper is the membership test itself. Bounded by `MAX_EATEN`.
     */
    this.eaten = new Set();
  }

  get size() {
    return this.players.size;
  }

  /**
   * WHO SIMULATES THE ANIMALS: whoever has been here longest, or null.
   *
   * A `Map` iterates in insertion order and `add` appends, so the first key is
   * the earliest arrival and this needs no bookkeeping, no timestamps and no
   * tie-break. It is derived rather than stored for the same reason the seed is
   * not recomputed: there is nothing to keep in step with anything.
   *
   * LONGEST-SERVING RATHER THAN BEST-CONNECTED, and that is a deliberate trade
   * of quality for stability. Picking the lowest latency or the fastest machine
   * would give better animals on average and would also mean the job moves
   * whenever the measurement wobbles — and every move is a visible snap for
   * everyone, because two woods that have been simulating separately do not
   * agree about where a deer is. This changes exactly once per host departure,
   * which is the least often it can possibly change.
   */
  get hostId() {
    for (const id of this.players.keys()) return id;
    return null;
  }

  get isFull() {
    return this.players.size >= this.maxSize;
  }

  add(player) {
    this.players.set(player.id, player);
    player.room = this;
    this.emptySince = null;
  }

  remove(id) {
    if (!this.players.delete(id)) return;
    if (this.players.size === 0) {
      this.emptySince = Date.now();
      // The wood goes with the last person out. See the note on `seed`: a code
      // outlives its room, and an empty room's forest is a place nobody is.
      // The clock and the hour go with it — all three describe one gathering,
      // and the clock in particular must not be allowed to age with the code
      // (see `clockOrigin` for what an old origin costs in float32).
      this.seed = null;
      this.clockOrigin = null;
      this.dayOrigin = null;
      // And the furniture goes back where it was built. A pair of speakers
      // standing in a clearing nobody is in describes an evening that ended.
      this.speakers = null;
      /**
       * The record comes off with it, and this one is load-bearing rather than
       * tidy: `music.at` is a position on a world clock that is ALSO being
       * cleared on this line. Keeping the record while resetting the clock it
       * is timed against would hand the next arrival a start time in a
       * timebase that no longer exists — a track that began some arbitrary
       * distance in the future or the past.
       */
      this.music = null;
      /**
       * And the mushrooms grow back, for the same reason as the line above and
       * with more force: these ids name patches in a forest that is being
       * forgotten on the `seed = null` line. Keeping them would hand the next
       * room to use this code a list of bare patches in a wood where those
       * sectors hold something else entirely.
       */
      this.eaten.clear();
    }
  }

  broadcast(payload, exceptId = null) {
    // Encoded once for the whole room rather than once per recipient. At 18 Hz
    // with a dozen people that is the difference between one JSON.stringify a
    // tick and twelve of them.
    const encoded = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const player of this.players.values()) {
      if (player.id === exceptId) continue;
      player.send(encoded);
    }
  }

  roster(exceptId = null) {
    const out = [];
    for (const player of this.players.values()) {
      if (player.id === exceptId) continue;
      out.push(player.snapshot());
    }
    return out;
  }

  isIdle(now) {
    return this.emptySince !== null && now - this.emptySince > ROOM_IDLE_MS;
  }
}

export class RoomRegistry {
  constructor({ maxRoomSize = 8 } = {}) {
    this.maxRoomSize = maxRoomSize;
    this.rooms = new Map();
    this.liveIds = new Set();
    this._reaper = setInterval(() => this.reap(), 60_000);
    this._reaper.unref?.();
  }

  create() {
    let code = randomCode();
    let guard = 0;
    while (this.rooms.has(code) && guard++ < 50) code = randomCode();
    const room = new Room(code, this.maxRoomSize);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    const normalized = normalizeCode(code);
    return normalized ? (this.rooms.get(normalized) ?? null) : null;
  }

  /**
   * Rooms are created on demand.
   *
   * An invite link is a thing people paste into a chat and click on again three
   * days later. If the code only worked while the room object happened to exist,
   * the room emptying out for half an hour would silently invalidate every link
   * anyone had shared. Instead the code *is* the room: whoever arrives first
   * brings it back into being, and the rest of the link's life is unchanged.
   */
  getOrCreate(code) {
    const normalized = normalizeCode(code);
    if (!normalized) return null;
    let room = this.rooms.get(normalized);
    if (!room) {
      room = new Room(normalized, this.maxRoomSize);
      this.rooms.set(normalized, room);
    }
    return room;
  }

  /**
   * Player ids are eight characters, not a UUID.
   *
   * The id is the first element of every row of every transform batch, so it
   * goes out roomSize² times a second for the whole session. Thirty-six
   * characters of UUID would be about three quarters of the fan-out's bytes
   * spent on identifiers. Uniqueness is checked against live connections rather
   * than trusted to entropy, which is both stronger and cheaper at this size.
   */
  newPlayer(socket) {
    let id;
    do {
      const bytes = randomBytes(8);
      id = '';
      for (let i = 0; i < 8; i++) id += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    } while (this.liveIds.has(id));
    this.liveIds.add(id);
    return new Player(id, socket);
  }

  release(player) {
    this.liveIds.delete(player.id);
  }

  reap() {
    const now = Date.now();
    for (const [code, room] of this.rooms) if (room.isIdle(now)) this.rooms.delete(code);
  }

  stats() {
    let players = 0;
    for (const room of this.rooms.values()) players += room.size;
    return { rooms: this.rooms.size, players };
  }

  stop() {
    clearInterval(this._reaper);
  }
}
