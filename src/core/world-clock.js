/**
 * THE CLOCK THE WORLD IS ANIMATED BY.
 *
 * Every moving surface in this game reads one number: the river's two crossed
 * wave trains, the cloud and aurora scroll, the campfire flicker, the mist, and
 * — through `uWind` — every trunk, frond and blade of grass. Until this file
 * existed that number was `TripState.clock`, a `+= dt` accumulator starting at
 * zero the moment the tab loaded.
 *
 * IN ONE SESSION THAT IS INVISIBLE AND CORRECT. In two it is the difference
 * between one wood and two pictures of a wood: two people standing on the same
 * jetty watched different water, and every tree between them swayed to its own
 * private wind. Nothing errors, nothing logs, and it does not look like a bug —
 * it looks like the forest, because each half of it is individually right.
 *
 * THREE PROPERTIES, AND THE SECOND IS THE ONE THAT IS EASY TO MISS.
 *
 * 1. IT IS DERIVED, NOT ACCUMULATED. `(now - origin)`, never `+= dt`. An
 *    accumulator is a function of how many frames this tab has drawn, so two
 *    machines agree only if they agree about frame count — and they never do.
 *    A backgrounded tab is the sharp version: rAF stops, `dt` stops arriving,
 *    and that client's world is permanently behind by however long somebody
 *    looked at their email. Derived, it simply catches up, which is what a
 *    clock is.
 *
 * 2. IT IS ROOM-RELATIVE, AND THAT IS A PRECISION REQUIREMENT RATHER THAN A
 *    STYLE. Shader uniforms are float32: 24 bits of mantissa. At a raw Unix
 *    epoch of ~1.75e9 the gap between representable seconds is 2^(30-23) = 128
 *    SECONDS, so every animation in the game would sit stone dead between
 *    two-minute jumps. Measured against the room's own start the value stays
 *    small — a rounding step of about 2 ms after eight hours, 8 ms after a
 *    continuous day — and a step under one frame is a step nobody can see.
 *
 *    The bound is on CONTINUOUS OCCUPANCY, not on the room code's lifetime:
 *    `Room.clockOrigin` is cleared with the seed when the last person leaves,
 *    for exactly this reason. A room somebody has been standing in without a
 *    break for a week would reach a 60 ms step and start to judder; if that ever
 *    becomes a real session rather than a thought experiment, the answer is to
 *    re-broadcast a fresh origin, not to widen the type.
 *
 * 3. SOLO IS UNTOUCHED. With no room, the origin is this tab's load time and
 *    the value is what `state.clock` always was, to the millisecond. Nothing on
 *    this path touches the network, allocates, or costs a frame anything: the
 *    whole per-frame expense is one `Date.now()` in `tickWorldClock`.
 *
 * WHY NOT KEEP IT ON `TripState`. Because the wind blows when nobody is
 * tripping, and `state.clock` was two clocks wearing one name — a world clock
 * that must be shared and a trip generator clock that must not be. The trip's
 * breath phase, its surges, its drone and its fog drift are all still on
 * `state.clock` and still local, because a trip is one person's.
 */

/**
 * Milliseconds, epoch. Null until a room says otherwise, in which case the
 * fallback below is this tab's own load.
 */
let origin = null;

/**
 * Set once at module evaluation so a solo session's clock starts at zero, the
 * way it always did. Not `0`, which would put us back in the float32 hole
 * described above.
 */
const loadedAt = Date.now();

/** Seconds. Sampled once a frame by `tickWorldClock` — see `worldClock`. */
let now = 0;

/**
 * Set by the debug panel's freeze. Seconds, or null for "run".
 *
 * `atmosphere.day.set` already had to exist for the same reason and this is its
 * twin: a clock read off the wall does not stop because a frame loop stopped
 * being given `dt`, so a "frozen" world still had water moving in it, and a
 * script differencing two frames to isolate one post-process term got an image
 * tracing every edge in the frame. See `probe.freeze` in main.js.
 *
 * Resuming JUMPS to wherever the room has got to rather than resuming where it
 * paused, and that is the right way round: the freeze is a debugging pause on
 * one machine, not an event the other seven agreed to.
 */
let pinned = null;

/**
 * Adopt the room's clock, given how long it has been running.
 *
 * Called from the `welcome` handler in `net/index.js`. AN AGE RATHER THAN AN
 * INSTANT, and the conversion to an origin happens here against THIS machine's
 * `Date.now()` — which is the entire point of sending an age. Two clients whose
 * system clocks are three minutes apart both end up with an origin three
 * minutes apart in absolute terms, and therefore with the same `worldClock()`,
 * which is the number that has to match. See the note on `clockElapsedMs` in
 * server/signaling.js.
 *
 * The residual error is the one-way latency of the welcome message. Tens of
 * milliseconds against wave trains whose periods are seconds; if that ever
 * needs tightening, the `ping`/`pong` pair already in the protocol is the
 * standard way to estimate and subtract it.
 *
 * Idempotent and safe to call repeatedly, which matters because a reconnect
 * delivers a second `welcome`. It deliberately RE-ANCHORS on each one rather
 * than keeping the first: a reconnect is exactly the moment this client may
 * have been suspended, and the server's age is the authority on how long.
 *
 * @param {number|null} ageMs how long the room's clock has been running
 * @param {number} [atMs] when the message carrying it arrived, epoch ms.
 *   Defaults to now, which is right for every caller except the one that
 *   matters: `welcome` is handled while the page is still building its forest,
 *   and "now" can be a fifth of a second after the packet landed. That delay
 *   would go straight into the origin and stay there. See `_at` in socket.js.
 */
export function adoptWorldAge(ageMs, atMs = Date.now()) {
  const arrived = Number.isFinite(atMs) ? atMs : Date.now();
  origin = Number.isFinite(ageMs) ? arrived - ageMs : null;
  tickWorldClock();
  return origin;
}

/**
 * THERE IS DELIBERATELY NO WAY BACK. Leaving a room keeps the room's origin,
 * because the alternative is a discontinuity for no gain: every wave train and
 * gust phase in the world would step to a new value on the frame the socket
 * closed, and nothing about a solo walk is improved by counting from this tab's
 * load instead of from a clearing you were standing in a minute ago. The
 * precision bound is unchanged either way — it is a function of elapsed time,
 * not of which instant is being counted from.
 */

/** Epoch milliseconds this clock counts from. */
export function worldOrigin() {
  return origin ?? loadedAt;
}

/**
 * Sample the wall clock. Called exactly once per frame, at the top of the loop.
 *
 * ONE SAMPLE PER FRAME IS A CORRECTNESS REQUIREMENT, not a micro-optimisation.
 * `uTime` and `uWind` are read by different call sites a few hundred
 * microseconds apart; letting each call `Date.now()` for itself would put the
 * water and the leaves on two clocks that disagree by a sub-millisecond amount
 * that varies every frame — which is precisely the kind of jitter that is
 * invisible in a still and shows up as a shimmer in motion.
 */
export function tickWorldClock() {
  now = (Date.now() - worldOrigin()) / 1000;
  return worldClock();
}

/** Seconds since the room's clock started. The number every animation reads. */
export function worldClock() {
  return pinned ?? now;
}

/**
 * Stop the world clock where it is, or let it go again.
 *
 * @param {boolean} on
 */
export function pinWorldClock(on) {
  pinned = on ? worldClock() : null;
  return pinned;
}

/** True while the debug freeze is holding this clock. Read by the debug panel. */
export function worldClockPinned() {
  return pinned !== null;
}
