/**
 * The wire, in one place.
 *
 * Everything in here has a twin in `server/rooms.js`. They are not shared by an
 * import because the server has no build step and this is browser code with a
 * `.js` extension that Vite resolves — the two halves of the project genuinely
 * do not share a module graph. So the rule is: nothing goes in this file that
 * is not also written down over there, and both sides say so.
 */

/** The player is walking. Purely cosmetic — the avatar's own speed drives its legs. */
export const FLAG_MOVING = 1 << 0;
/** Feet on the ground. Lets a remote avatar stop its walk cycle mid-jump. */
export const FLAG_GROUNDED = 1 << 1;
/** Microphone hard-muted. The server zeroes the voice envelope when it sees this. */
export const FLAG_MUTED = 1 << 2;
/** The noise gate is open right now. */
export const FLAG_SPEAKING = 1 << 3;

/**
 * WHAT SOMEBODY IS DOING, AND WHY IT IS FOUR BITS RATHER THAN A FIELD.
 *
 * The row is sent roomSize² times a second forever, so the cheapest place to put
 * anything is a bit in a number that is already there. All four of these are
 * about POSE — they change how a remote body is drawn and nothing else — and a
 * pose is exactly the kind of thing that is allowed to be one frame late or, in
 * the worst case, wrong for one tick. Nothing downstream of them is a decision.
 *
 * They are deliberately not mutually exclusive. You can sit on the raft with a
 * rod out, and a state machine that made those two states would have to invent
 * a third for the combination.
 */
/** Sitting on something: a bench, a log, the deck of the ferry. */
export const FLAG_SITTING = 1 << 4;
/** A rod is out. Draws the rod and the ready stance. */
export const FLAG_FISHING = 1 << 5;
/** Something is on the line right this second. The rod bends and the arms lift. */
export const FLAG_BITE = 1 << 6;
/** This person has a screen standing somewhere in the world. */
export const FLAG_PRESENTING = 1 << 7;

/**
 * The server's fan-out rate, and therefore ours.
 *
 * Sending our own transform faster than the server will forward it does nothing
 * except burn upstream: the extra packets land between ticks and are overwritten
 * by the next one before anybody is told. Matching the tick exactly is the
 * cheapest way to be exactly as current as the protocol allows.
 */
export const TICK_HZ = 18;
export const TICK_MS = 1000 / TICK_HZ;

/**
 * How far behind live we replay other people, in milliseconds.
 *
 * Two ticks. Every frame is then a true interpolation between two samples that
 * have both already arrived, which is the difference between smooth motion and
 * the rubber-banding you get from easing toward the newest packet. One tick
 * would leave no slack at all: the instant a packet is 1 ms late the buffer is
 * empty and the avatar holds still until it arrives, which is a stutter. Two
 * ticks tolerates a whole dropped packet.
 *
 * The cost is seeing other people 110 ms in the past. That is under the latency
 * of the voice path they are talking to you over, so nothing is out of step
 * with anything you can perceive.
 */
export const INTERP_DELAY_MS = 2 * TICK_MS;

/**
 * HOW OFTEN THE HOST TELLS THE ROOM WHERE THE ANIMALS ARE.
 *
 * A third of the body rate, and the ratio is the argument. A person is the thing
 * you are talking to and standing next to, usually within a few metres, and a
 * tick they miss shows as a hitch in somebody's stride. An animal is a thing you
 * glimpse at twenty to a hundred metres and then it is behind a tree — at that
 * distance a sixth of a second of interpolation is under a pixel of error for
 * everything except a deer at a flat gallop, and a deer at a flat gallop is
 * leaving anyway.
 *
 * Six is also what makes the whole feature affordable: twenty-three animals at
 * eighteen would cost more than every player transform in the room put together,
 * for creatures nobody is looking at most of the time.
 */
export const FAUNA_HZ = 6;
export const FAUNA_MS = 1000 / FAUNA_HZ;

/**
 * The SHAPE of an animal row is deliberately not here — see `snapshot` in
 * world/fauna.js, which owns both ends of it.
 *
 * This file is the contract between the client and the server, and the animals
 * are not part of that contract: the server relays the array without knowing
 * what a single number in it means, exactly as it relays an SDP offer. Putting
 * the field list here would make `src/world/` import `src/net/` to read it, and
 * a world module that depends on the network is one you cannot open a forest
 * without. The cadence above is genuinely protocol — it is the rate at which the
 * wire is used — and it is the only half that belongs on this side.
 */

/**
 * The longest thing anybody may say, mirrored in `server/rooms.js`.
 *
 * Enforced on BOTH sides, which is not belt and braces. The client's copy exists
 * so the input box stops accepting characters rather than silently sending
 * something that will come back truncated; the server's exists because the
 * client's is advisory to anybody with a console open.
 */
export const CHAT_MAX_CHARS = 240;

/**
 * What may travel about a presentation, and how little that is.
 *
 * There used to be exactly two surfaces in the world — a panel that followed you
 * about and one fourteen-metre screen in the commons — so this was a single
 * string naming which. It bought a "who has the big screen" arbitration problem
 * (a monotonic claim counter, a displacement rule, an answer for the owner whose
 * connection dropped) in exchange for a screen that was only ever in one place,
 * and made the commons the only room in a wood 380 metres across where you could
 * show anybody anything.
 *
 * A share is now a THING WITH COORDINATES, which is both more capable and
 * simpler: there is nothing to arbitrate, because two screens in one clearing is
 * the same situation as two people standing in one clearing and the world has
 * always allowed that.
 *
 *   null            not sharing
 *   {x,y,z,yaw,w}   standing in the world, w metres wide, `y` the GROUND under it
 *
 * TWO CASES, AND THERE USED TO BE THREE. The middle one was `{mode:'held'}` — a
 * screen in your hands, which is where a share began before you put it down. It
 * is gone at the user's request and the deletion went further than the state:
 * with only one thing a placement can be, there is no discriminator left to
 * carry, so the message IS the spot. A screen is somewhere or it is nowhere.
 *
 * That also removed the last thing on this wire whose position was implicit.
 * `held` was the one placement with no coordinates in it — the receiver had to
 * derive the screen's position from the owner's avatar, every frame, from an
 * interpolated transform two ticks behind live. Everything about a share is now
 * either explicit here or not sent at all.
 *
 * Still only sent on CHANGE, not on the tick. Putting a screen up, moving it and
 * resizing it are things a person does a handful of times an evening; the 18 Hz
 * row in `decodeRow` is for things that change every frame, and a screen bolted
 * to a patch of ground is the opposite of that.
 *
 * The pixels are not in here. They are a WebRTC video track that went peer to
 * peer without touching the server; this only says where to hang them.
 */

/**
 * How wide a placed screen may be, in metres.
 *
 * The floor is a thing you can still read from where you put it. The ceiling was
 * the commons screen — 13.4 m was chosen as "a village hall's screen, so it
 * reads as an event rather than a television somebody dragged outside", and
 * there is no reason to allow more: past about sixteen metres a screen stops
 * being furniture and starts being weather, and it is the one dimension of this
 * feature somebody could use to ruin an evening for seven other people.
 *
 * It costs nothing to allow the whole range. The texture is 1080p at both ends —
 * a bigger quad is more fill and not one byte more upload — so this is a bound
 * on taste and courtesy rather than on the budget.
 */
export const SHARE_MIN_W = 1.2;
export const SHARE_MAX_W = 16;
/**
 * Where a screen is standing. `y` is the GROUND under it, not the middle of the
 * picture — the ground is the thing two machines can independently agree about,
 * and the middle of the picture moves when somebody turns a scroll wheel.
 *
 * @typedef {{x:number,y:number,z:number,yaw:number,w:number}} Placement
 */
/** What a screen is when you first put it up: big enough to watch, small enough to move. */
export const SHARE_DEFAULT_W = 4.2;

/**
 * Read a placement off the wire, or off a console.
 *
 * Mirrored in `server/rooms.js`, which enforces its own copy because this one is
 * advisory to anybody with devtools open. Returns null for anything it does not
 * completely recognise: a half-understood placement would put somebody's screen
 * at NaN, and a NaN in a matrix propagates into the projection and takes the
 * whole frame black.
 *
 * ALL FIVE NUMBERS OR NOTHING, which is the whole of the shape check now that
 * there is no `mode` to switch on. A partial placement is exactly the thing that
 * cannot be allowed through — `{x, z}` with no `y` would put a screen at NaN
 * metres of altitude, and the `Number.isFinite` sweep below is what makes a
 * missing key indistinguishable from a hostile one.
 */
export function sanitizePlacement(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { x, y, z, yaw, w } = raw;
  for (const n of [x, y, z, yaw, w]) if (!Number.isFinite(n)) return null;
  if (Math.abs(x) > 600 || Math.abs(y) > 600 || Math.abs(z) > 600) return null;
  return {
    x,
    y,
    z,
    yaw,
    w: Math.min(SHARE_MAX_W, Math.max(SHARE_MIN_W, w)),
  };
}

/**
 * Invite codes, and the alphabet they are drawn from.
 *
 * Mirrored from `server/rooms.js`, which mints them and is the authority. This
 * copy exists so the main menu can tell a finished code from a half-typed one
 * without asking the server — a code is nine characters in three groups, so
 * "ask when it is complete" is a question only the client can answer as somebody
 * types, and asking on every keystroke would be nine requests for one code.
 *
 * No `i`, `l`, `o`, `0` or `1`. A code's job is to survive being read out over a
 * voice call and typed by somebody else, and those five are the pairs that get
 * misheard and mistyped.
 */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_GROUPS = 3;
const CODE_GROUP_LEN = 3;

/**
 * A typed code, tidied into the form the server uses, or null.
 *
 * Deliberately forgiving about everything except the alphabet: case, spaces and
 * missing dashes are all things a person does when copying nine characters off
 * another screen, and none of them is a different code. A letter that is not in
 * the alphabet is, so it is refused rather than repaired — a dropped character
 * would silently address somebody else's room.
 */
export function normalizeRoomCode(raw) {
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

/** Decoded row of the `S` batch. Positional on the wire; named from here on. */
export function decodeRow(row) {
  return {
    id: row[0],
    x: row[1],
    y: row[2],
    z: row[3],
    yaw: row[4],
    pitch: row[5],
    voice: (row[6] ?? 0) / 100,
    flags: row[7] | 0,
    trip: (row[8] ?? 0) / 100,
  };
}

/**
 * A stable hue for a player, from their id alone.
 *
 * Deliberately not assigned by the server. A colour that is a pure function of
 * the id means every client independently agrees on it with no message, no
 * conflict resolution and nothing to re-send when somebody reconnects — and if
 * two people do collide, the world is 380 metres across and they will rarely be
 * in the same glance.
 *
 * FNV-1a rather than a sum of char codes, because ids are eight characters from
 * a 31-letter alphabet and a sum of those clusters hard in the middle of the
 * range: half the room would come out the same green.
 *
 * STILL THE ANSWER FOR EVERYBODY WHO HAS NOT CHOSEN ONE. It is no longer the
 * only answer — the main menu lets a person pick their dye and sends it — but a
 * chosen hue is one optional field on a join, and this is what a missing field
 * falls back to. See `hueOf`. Nothing anywhere may end up with no colour at all:
 * the hue is what ties a line of chat to a body, and `avatar.js` refuses
 * nameplates precisely so that it has to.
 */
export function hueFromId(id) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 360) / 360;
}

/**
 * A hue off the wire, wrapped into 0..1, or null if there wasn't one.
 *
 * Mirrored in `server/rooms.js`, which enforces its own copy because this one is
 * advisory to anybody with a console open. Wrapped rather than clamped for the
 * same reason `?tod=` is: 1.25 and −0.75 are both the same colour, because a hue
 * is a circle, and clamping would quietly turn every out-of-range value into red.
 */
export function sanitizeHue(raw) {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(n)) return null;
  return ((n % 1) + 1) % 1;
}

/**
 * What colour somebody is: what they chose, or what their id says.
 *
 * ONE FUNCTION SO THAT THE BODY AND THE CHAT LOG CANNOT DISAGREE. Those two are
 * the whole of the affordance — the log is the only place a name appears, and
 * the aura is the only thing tying that name to a body — so a peer whose chosen
 * hue reached one of them and not the other would be worse than a peer with no
 * chosen hue at all.
 *
 * @param {string} id
 * @param {number|null|undefined} chosen
 */
export function hueOf(id, chosen) {
  const clean = sanitizeHue(chosen);
  return clean === null ? hueFromId(id) : clean;
}
