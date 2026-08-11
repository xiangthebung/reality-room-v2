/**
 * What time it is.
 *
 * One module, no three.js, no scene: the day is a pure function of the wall
 * clock, and everything that wants to know about it — the lights and the sky in
 * `atmosphere.js`, the fireflies in `fauna.js`, the owl and the crickets through
 * `wildlife.js`, the frogs in `ambience.js` — asks here rather than being handed
 * a number down a chain of update calls. That is deliberate and it is the whole
 * reason this file exists separately from the atmosphere: a value threaded
 * through six `update(dt, {...})` signatures is a value that four of the six
 * will eventually stop passing.
 *
 *
 * IT IS A PURE FUNCTION OF THE CLOCK, WHICH IS WHAT MAKES IT SHAREABLE.
 *
 *     phase(now) = ((now - ORIGIN) / 1000 * SCALE / CYCLE_SECONDS) mod 1
 *
 * `ORIGIN` is the Unix epoch. Nothing accumulates, nothing is integrated from
 * dt, and there is no state to synchronise — so TWO PEOPLE IN ONE ROOM ARE
 * ALREADY LOOKING AT THE SAME SKY WITHOUT A SINGLE BYTE ON THE WIRE, in exactly
 * the way two people in one room are already standing in the same wood because
 * the seed is in the URL. Their machine clocks have to agree, and machine clocks
 * agree to well under a second these days; a second is 0.08% of a cycle, which
 * is about a fifth of a degree of sun.
 *
 * `setDayOrigin` exists so a room can deliberately be shifted — a host who wants
 * to show somebody a sunset can ship an origin over the wire and both clients
 * evaluate the same pure function against it. Nothing does that today. The
 * default costs nothing and is already correct.
 *
 *
 * WHY TWENTY MINUTES.
 *
 * The two numbers this has to sit between are a player's session and the trip's
 * five minutes, and the failure modes at each end are different.
 *
 * Too long — an hour, or a real 24 — and a session sees nothing. The sun would
 * cross at 0.004°/s, which under a twelve-metre canopy is 0.9 mm of shadow
 * travel a second: you could stare at the forest floor for the whole session and
 * be unable to say whether the clock was running. A day cycle nobody can observe
 * is dead code with a shadow-map bill attached.
 *
 * Too short — the brief's 90 seconds — and it is a strobe. The same sun would
 * cross at 4°/s and drag 80 cm of shadow a second across the floor. Worse, it
 * would make the world's own lighting the fastest-moving thing in the frame,
 * which is precisely backwards: the wind, the water and the animals are supposed
 * to be what moves, and the light is supposed to be what they move IN.
 *
 * 1200 s puts the sun at 0.3°/s, which is ~6 cm of shadow travel a second under
 * a 12 m canopy. Over a second that is invisible. Over the half-minute you spend
 * looking at one thing, it is 2 m and unmistakable. That is the band the whole
 * feature has to live in and it is not very wide.
 *
 * Three more things fall out of the number and all three are good:
 *
 *   THE TRIP IS 290 s, so a trip is 24% of a day. You go under in the afternoon
 *   and come back at dusk. That relation feels right — the trip is an event
 *   inside a day rather than something longer than one — and it is the reason
 *   not to pick 300 s or 600 s: 1200/290 is 4.14, an ugly ratio on purpose, so
 *   consecutive trips land at different hours instead of replaying the same one.
 *
 *   DAYLIGHT IS 690 s AND NIGHT IS 510 s. Someone who arrives at the worst
 *   possible moment waits 8.5 minutes for sunrise, which is inside a session
 *   rather than beyond one.
 *
 *   A CYCLE IS LONGER THAN THE PATIENCE OF ANYONE WATCHING FOR THE SEAM. At 20
 *   minutes nobody sits through two midnights to check whether they matched.
 *
 *
 * THE SUN'S PATH IS A ROTATION OF THE AUTHORED SUN, NOT A REPLACEMENT FOR IT.
 *
 * `atmosphere.js` opens with a paragraph defending one specific direction —
 * mid-morning, about 38° up — against the low sun that turns a forest floor into
 * corduroy. That paragraph is still right, so the day is built around that
 * direction instead of over the top of it: the whole arc is
 *
 *     dir(p) = rotate(SUN_DIR, AXIS, (p - AUTHORED_PHASE) * 2π)
 *
 * and at `p = AUTHORED_PHASE` the rotation angle is exactly zero, so the
 * expression returns SUN_DIR bit for bit. The authored world is a MOMENT ON THE
 * ARC rather than a special case bolted beside it, which is what lets the
 * automation pin below be genuinely the same frame the scripts measured
 * yesterday instead of merely a similar one.
 *
 * The axis is the celestial pole. It has two degrees of freedom and both were
 * used: it is 48° above the horizon on a bearing of 146°, which is the choice
 * that puts the authored sun at declination 11.9° — a plausible late-spring sun,
 * matching the season the bird table in `wildlife.js` describes, with its
 * chiffchaffs and its cuckoo. What that buys, measured off the resulting arc:
 *
 *     noon elevation        53.9°     (higher than authored, so shorter shadows)
 *     midnight elevation   -30.1°     (a real night, not a permanent twilight)
 *     day fraction          57.5%     (a long spring day)
 *     authored moment       28% through the day — mid-morning, as documented
 *
 * That last line is the reason to believe the model rather than merely to accept
 * it: nobody chose "mid-morning", it is where the authored vector lands once you
 * ask what circle it is on. The bearing of 146° does put the celestial pole in
 * the south, so this wood is in the southern hemisphere and the sun tracks
 * through the north. Nothing in the game has a compass in it, and the
 * alternative was to move the authored sun.
 *
 * The moon is the same arc half a cycle later, which is what a full moon is: it
 * rises as the sun sets, transits at 53.9° at midnight, and sets at dawn. One
 * line, and it means the night has a light source with a real direction in it.
 */

/** Seconds in one full day. Defended at length above. */
export const CYCLE_SECONDS = 1200;

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The authored sun, as the three literals `atmosphere.js` normalises.
 *
 * Duplicated here rather than imported, because this module must not depend on
 * three or on the scene — and `atmosphere.js` keeps its own `SUN_DIR` export
 * untouched for anyone who wants it. The two are checked against each other at
 * runtime by `scripts/day-check.mjs`, which is the honest way to hold a
 * duplicated constant: not by promising nobody will edit one of them, but by
 * failing loudly when somebody does.
 */
const SUN_X = 0.36;
const SUN_Y = 0.62;
const SUN_Z = -0.7;

/**
 * Normalised the way `THREE.Vector3.normalize()` normalises — `divideScalar(l)`
 * is `multiplyScalar(1/l)`, so it is a reciprocal and a multiply and NOT a
 * divide. Written the same way here so the two agree to the last bit rather
 * than to fourteen digits; see the note on AUTHORED_PHASE about why that
 * matters.
 */
const SUN_LEN = Math.sqrt(SUN_X * SUN_X + SUN_Y * SUN_Y + SUN_Z * SUN_Z);
const SUN_INV = 1 / SUN_LEN;
const S = { x: SUN_X * SUN_INV, y: SUN_Y * SUN_INV, z: SUN_Z * SUN_INV };

/** The celestial pole. See the header for how the two angles were chosen. */
const AXIS_ELEVATION = 48 * DEG;
const AXIS_BEARING = 146 * DEG;
const A = {
  x: Math.cos(AXIS_ELEVATION) * Math.sin(AXIS_BEARING),
  y: Math.sin(AXIS_ELEVATION),
  z: -Math.cos(AXIS_ELEVATION) * Math.cos(AXIS_BEARING),
};

/**
 * The arc, solved once rather than sampled.
 *
 * Rotating S about A by θ gives a height
 *
 *     y(θ) = R0 + P·cos θ + Q·sin θ
 *
 * with R0 = Ay(A·S), P = Sy − R0 and Q = (A×S)y. Everything anyone wants to know
 * about the day is in those three numbers: noon is at atan2(Q, P), the extremes
 * are R0 ± √(P²+Q²), and sunrise is where the whole thing is zero. Deriving them
 * beats sampling because the answers are then exact, which is what the automation
 * pin needs.
 */
const AS = A.x * S.x + A.y * S.y + A.z * S.z;
const R0 = A.y * AS;
const P = S.y - R0;
const Q = A.z * S.x - A.x * S.z;
const AMP = Math.hypot(P, Q);
/** Rotation from the authored moment to solar noon, in turns. */
const NOON_TURNS = Math.atan2(Q, P) / TAU;

/**
 * The phase at which this is the world `atmosphere.js` was authored as.
 *
 * `phase - AUTHORED_PHASE` is exactly 0 here, Rodrigues' formula with a zero
 * angle is `v·1 + (a×v)·0 + a(a·v)·0`, and every one of those three terms is
 * exact in floating point — so the sun direction at this phase is SUN_DIR to the
 * last bit and not merely to within a rounding error. That is load-bearing:
 * automation pins the clock here, so the fifteen pixel-diffing scripts in
 * `scripts/` see the frame they saw before this file existed. Same trick, same
 * reason, as `grove-01` in `core/world-seed.js`.
 */
export const AUTHORED_PHASE = ((0.5 - NOON_TURNS) % 1 + 1) % 1;

/** Sunrise and sunset, as phases. Reported by the debug surface. */
const HALF_DAY_TURNS = Math.acos(Math.max(-1, Math.min(1, -R0 / AMP))) / TAU;
export const SUNRISE_PHASE = 0.5 - HALF_DAY_TURNS;
export const SUNSET_PHASE = 0.5 + HALF_DAY_TURNS;

/**
 * How low the DIRECT light is ever allowed to come, and why it is not zero.
 *
 * This is the answer to the corduroy paragraph at the top of `atmosphere.js`,
 * and it is the single most important number in this file after the cycle
 * length. A sun at 5° elevation in a wood does not produce dramatic light, it
 * produces a hundred metres of parallel trunk shadows lying along the ground
 * like ploughing — the exact artefact that got the low sun rejected when the
 * world had only one.
 *
 * So the light's ELEVATION stops descending at 30° while its AZIMUTH carries on
 * rotating, and the sun's intensity is taken to zero across that same band. By
 * the time the true sun reaches the horizon the directional has been off for a
 * while, so the pinned elevation is never seen at a brightness that could stripe
 * anything. What you get instead of raking light is the azimuth swinging round —
 * which is the part of a day cycle a player can actually read — plus colour,
 * plus the dawn and dusk fog, which is doing at least as much work as this is.
 *
 * IT IS ALSO NOT REALLY A LIE. The horizon in a forest is not the horizon; it is
 * the far treeline and the ridge. The last direct sun in a wood comes over the
 * tops of the trees and then stops, tens of minutes before the astronomical
 * sunset. 30° is roughly where a wood on a slope loses the sun, and the SKY's
 * sun disc still goes all the way down on the true arc so you can watch it set.
 *
 * The moon gets a lower floor because a 0.16-intensity light cannot stripe
 * anything, and because a moon that hugs the treetops is worth having.
 */
const SUN_FLOOR = Math.sin(30 * DEG);
const MOON_FLOOR = Math.sin(22 * DEG);

// ---------------------------------------------------------------------------
// the clock
// ---------------------------------------------------------------------------

/**
 * A phase pinned by hand, or null to follow the wall clock.
 *
 * Set by the debug panel, by `?tod=`, and by every script that wants a
 * reproducible sky. Automation gets one of these for free — see `dayPhase`.
 */
let pinned = null;
let origin = 0;
let scale = 1;

/**
 * True when we are being driven by a robot.
 *
 * The precedent is `core/world-seed.js`, which pins the seed under
 * `navigator.webdriver` so that fifteen pixel-diffing scripts keep meaning
 * something, and `core/quality.js`, which refuses to run the Auto governor for
 * the same reason. A clock is a far worse offender than either: a world seed at
 * least stays put for the length of a run, whereas an unpinned day would change
 * the exposure of the frame BETWEEN the two screenshots a diff is made of.
 */
function automated() {
  return typeof navigator !== 'undefined' && !!navigator.webdriver;
}

/** `?tod=0.78` — a deliberate hour, for a script or for a screenshot. */
function fromUrl() {
  try {
    const raw = new URLSearchParams(location.search).get('tod');
    if (raw === null) return null;
    const v = Number(raw);
    if (!Number.isFinite(v)) return null;
    // Wrapped rather than rejected: 1.25 and −0.75 are both quarter past
    // midnight, and a phase is a circle.
    return ((v % 1) + 1) % 1;
  } catch {
    return null;
  }
}

let urlPhase;

/**
 * What time it is, 0 = midnight, 0.5 = noon.
 *
 * Pure, given the pin, the origin and the scale. Takes the clock reading as an
 * argument so a caller that already has one does not take a second, and so the
 * whole thing can be evaluated for a time that is not now.
 */
export function dayPhase(nowMs = Date.now()) {
  if (pinned !== null) return pinned;
  if (urlPhase === undefined) urlPhase = fromUrl();
  if (urlPhase !== null) return urlPhase;
  if (automated()) return AUTHORED_PHASE;
  const turns = ((nowMs - origin) / 1000) * scale / CYCLE_SECONDS;
  return turns - Math.floor(turns);
}

/**
 * Pin the clock, or hand it back to the wall.
 *
 * `setDayPhase(null)` releases — and under automation that means going back to
 * AUTHORED_PHASE rather than back to the wall clock, which is the behaviour a
 * script wants after it has finished photographing midnight.
 */
export function setDayPhase(p) {
  pinned = p === null || p === undefined ? null : ((p % 1) + 1) % 1;
  return pinned;
}

/** The pin, or null. */
export function dayPinned() {
  return pinned;
}

/**
 * Shift the whole cycle. Milliseconds, added to the epoch.
 *
 * The hook for "everyone in this room should be watching a sunset": one number,
 * shipped once, and both clients keep evaluating the same pure function. The
 * net layer sends it now — see `Room.dayOrigin` in server/rooms.js.
 *
 * ZERO IS THE DEFAULT AND IT IS NOT AN ARBITRARY ONE: with `origin = 0` the
 * phase is a pure function of the Unix epoch, so two people who never touched
 * the menu already agree about what time it is with nothing on the wire. That
 * is why "whenever" is transmitted as null and applied as `setDayOrigin(0)`
 * rather than left alone — a guest who chose dusk last night and joins a
 * whenever-room this evening has to be put back on the shared default.
 */
export function setDayOrigin(ms) {
  origin = Number(ms) || 0;
}

/**
 * The shift currently in force, in epoch milliseconds. Zero means the cycle is
 * running against the raw epoch, which is the shared default described above.
 *
 * Exists so the net layer can express the hour as an AGE (`Date.now() - origin`)
 * without keeping its own copy of a number this module owns. A duplicate would
 * be a number that could disagree, and the disagreement would be a sky.
 */
export function dayOrigin() {
  return origin;
}

/**
 * Run the day faster. Automation and tuning only.
 *
 * A cycle is twenty minutes, and measuring a property of a whole cycle at one
 * times real speed costs twenty minutes per measurement. Anything that is a
 * property of the CYCLE rather than of the second — how many times the shadow
 * map re-renders, whether the handover from sun to moon is visible — is
 * scale-invariant and can be measured at 30×. Anything that is a property of the
 * second — frame time — cannot, and must be measured at 1.
 */
export function setDayScale(k) {
  scale = Number(k) || 1;
}

export function dayScale() {
  return scale;
}

// ---------------------------------------------------------------------------
// where the sun is
// ---------------------------------------------------------------------------

/**
 * Rodrigues, on plain objects.
 *
 * `out` is required and is never allocated here: this runs every frame and the
 * answer is dead before the next frame asks the question, which is the same
 * reasoning as the scratch vectors in `main.js` and `atmosphere.js`.
 */
function rotateAboutAxis(v, angle, out) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = A.x * v.x + A.y * v.y + A.z * v.z;
  const cx = A.y * v.z - A.z * v.y;
  const cy = A.z * v.x - A.x * v.z;
  const cz = A.x * v.y - A.y * v.x;
  const k = d * (1 - c);
  out.x = v.x * c + cx * s + A.x * k;
  out.y = v.y * c + cy * s + A.y * k;
  out.z = v.z * c + cz * s + A.z * k;
  return out;
}

/**
 * The true direction of the sun at this phase — where the disc is drawn.
 *
 * Not the direction the light comes from; see `lightVector`. This one goes all
 * the way below the horizon, because the sky is allowed to show a sunset and the
 * shadow map is not.
 */
export function sunVector(phase, out = { x: 0, y: 0, z: 0 }) {
  return rotateAboutAxis(S, (phase - AUTHORED_PHASE) * TAU, out);
}

/** The moon: the same arc, half a cycle behind. A full moon, and it always is. */
export function moonVector(phase, out = { x: 0, y: 0, z: 0 }) {
  return sunVector(phase + 0.5, out);
}

/**
 * sin(elevation) of the sun, without building a vector.
 *
 * y(θ) = R0 + P·cos θ + Q·sin θ is R0 + AMP·cos(θ − θ*), and θ* is by
 * construction the rotation from the authored moment to noon — so θ − θ* is
 * simply (phase − 0.5) turns, and the whole arc collapses to one cosine.
 */
export function sunHeight(phase) {
  return R0 + AMP * Math.cos((phase - 0.5) * TAU);
}

/**
 * Apply the elevation floor to a direction, in place.
 *
 * Tilts the vector up toward the zenith about the horizontal axis
 * perpendicular to its own bearing, which keeps the azimuth exactly where it
 * was — the azimuth is the half of the sun's motion that is worth keeping at
 * dusk, and the elevation is the half that stripes the floor.
 */
function raiseTo(v, minSin) {
  if (v.y >= minSin) return v;
  const horiz = Math.hypot(v.x, v.z);
  if (horiz < 1e-6) {
    v.y = v.y < 0 ? -1 : 1;
    return v;
  }
  const wantHoriz = Math.sqrt(Math.max(0, 1 - minSin * minSin));
  const k = wantHoriz / horiz;
  v.x *= k;
  v.y = minSin;
  v.z *= k;
  return v;
}

/**
 * The direction the DIRECT light comes from — sun by day, moon by night.
 *
 * One light, and the swap happens where its intensity is zero. See the palette
 * in `atmosphere.js`: the `dir` channel is authored to reach exactly 0 at the
 * two handover keyframes, so on the frame this function's answer jumps a
 * hundred and something degrees the directional is contributing nothing and the
 * shadow map it casts is multiplied by nothing. A second directional light with
 * its own shadow map would have cost a second shadow render, which is the most
 * expensive thing in the app.
 */
export function lightVector(phase, out = { x: 0, y: 0, z: 0 }) {
  if (isNight(phase)) {
    moonVector(phase, out);
    return raiseTo(out, MOON_FLOOR);
  }
  sunVector(phase, out);
  return raiseTo(out, SUN_FLOOR);
}

/**
 * Which body is carrying the light. The two handovers are a shade inside the
 * geometric night, so the sun is always the one lighting the sky it is in.
 */
const NIGHT_FROM = 0.815;
const NIGHT_TO = 0.185;
export function isNight(phase) {
  return phase >= NIGHT_FROM || phase < NIGHT_TO;
}

// ---------------------------------------------------------------------------
// how dark it is
// ---------------------------------------------------------------------------

/**
 * The curve every living thing in the wood is listening to.
 *
 * `wildlife.js` was built for this and has been unreachable since it was
 * written: every one of its twelve species carries an `active` window over
 * `dark`, the crow stops above 0.62, the owl starts above 0.25, the nightingale
 * has a floor at 0.22 and the crickets scale their rate by it. All of that was
 * driven by `tripLevel * 0.65` alone, so a nightingale required a drug and a
 * crow never went to roost.
 *
 * It is a table rather than a function of the sun's elevation because the two
 * are not the same shape and the useful one is not the geometric one. Half an
 * hour after sunset a wood is dark; the geometry says the sun is 6° down and the
 * sky is still bright. And the roster wants specific things to happen at
 * specific moments — the crows to fall silent while there is still light, the
 * owl to start before you have noticed it is evening — which is a matter of
 * taste and belongs in numbers you can move.
 *
 * Checked against the roster it drives, at the keyframes below:
 *
 *     phase  dark   what is awake
 *     0.500  0.00   everything; goldcrest and nuthatch at full weight
 *     0.720  0.06   the first chiffchaffs dropping out
 *     0.762  0.22   the nightingale's floor — it can now be picked
 *     0.788  0.50   sunset; nuthatch and goldcrest gone, blackbird loudest
 *     0.800  0.62   THE CROWS STOP. The single most legible moment in the day
 *     0.815  0.78   owl, crickets rising, robin and wren still going
 *     0.870  0.97   nightingale and owl only, plus the six per cent floor
 */
const DARK_KEYS = [
  [0.0, 1.0],
  [0.13, 1.0],
  [0.185, 0.95],
  [0.2123, 0.78],
  [0.245, 0.45],
  [0.3, 0.12],
  [0.3754, 0.0],
  [0.64, 0.0],
  [0.72, 0.06],
  [0.762, 0.22],
  [0.7877, 0.5],
  [0.815, 0.78],
  [0.87, 0.97],
  [1.0, 1.0],
];

/**
 * How much of a daytime insect's world this is. Drives the midge columns.
 *
 * Not `1 - dark`: midges are out through the whole day and then some, and they
 * are at their most visible in the last hour when the light is coming in
 * sideways through them. So this holds at 1 well past the point where `dark`
 * has started to climb, and the two curves overlap through dusk — which is
 * correct, and is the window in which you can see both a midge column and the
 * first fireflies.
 */
const LIGHT_KEYS = [
  [0.0, 0.0],
  [0.185, 0.0],
  [0.2123, 0.35],
  [0.245, 0.8],
  [0.3, 1.0],
  [0.72, 1.0],
  [0.762, 0.98],
  [0.7877, 0.72],
  [0.815, 0.3],
  [0.87, 0.05],
  [1.0, 0.0],
];

/**
 * How much of a dawn chorus this hour deserves.
 *
 * `dark` cannot express this, and that is the whole reason it exists: dark
 * passes through 0.5 twice a day and the two are not the same event at all. An
 * hour after sunrise is the noisiest a temperate wood ever gets — every male
 * with a territory singing at once, for about ninety minutes, and then it stops
 * — and an hour after sunset is the quietest thing short of midnight. Reading
 * only `dark`, `wildlife.js` would have given dawn and dusk identical chorus
 * rates, which is the one thing about a wood that everybody who has been in one
 * at five in the morning knows is wrong.
 *
 * It reaches exactly 0 at AUTHORED_PHASE, which is not cosmetic: automation
 * pins the clock there, and `scripts/audio-probe.mjs` counts events. A dawn
 * multiplier that was 0.45 at the pinned hour would have quietly changed every
 * audio measurement in the repo into a different measurement.
 */
const DAWN_KEYS = [
  [0.0, 0.0],
  [0.195, 0.0],
  [0.2123, 0.7],
  [0.245, 1.0],
  [0.29, 0.6],
  [AUTHORED_PHASE, 0.0],
  [1.0, 0.0],
];

function sampleKeys(keys, phase) {
  const p = phase - Math.floor(phase);
  for (let i = 1; i < keys.length; i++) {
    if (p <= keys[i][0]) {
      const a = keys[i - 1];
      const b = keys[i];
      const span = b[0] - a[0];
      // `t === 0` when p lands exactly on a keyframe, and `a + (b-a)*0` is
      // exactly `a`. That is what keeps AUTHORED_PHASE bit-exact through here
      // as well as through the rotation.
      const t = span <= 0 ? 0 : (p - a[0]) / span;
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return keys[keys.length - 1][1];
}

/** 0 in full daylight, 1 at night. The roster parameter. */
export function darkAt(phase = dayPhase()) {
  return clamp01(sampleKeys(DARK_KEYS, phase));
}

/** 1 in full daylight, 0 at night. The midge parameter. */
export function daylightAt(phase = dayPhase()) {
  return clamp01(sampleKeys(LIGHT_KEYS, phase));
}

/** 0 all day, 1 for the ninety minutes after sunrise. See DAWN_KEYS. */
export function dawnAt(phase = dayPhase()) {
  return clamp01(sampleKeys(DAWN_KEYS, phase));
}

/**
 * Everything a readout wants, in one object. Allocates — for the debug panel
 * and for scripts, never for the frame loop.
 */
export function dayInfo(phase = dayPhase()) {
  const sun = sunVector(phase);
  const moon = moonVector(phase);
  return {
    phase,
    /** A clock face, for people. 0.5 -> "12:00". */
    hhmm: `${String(Math.floor(phase * 24)).padStart(2, '0')}:${String(
      Math.floor(((phase * 24) % 1) * 60)
    ).padStart(2, '0')}`,
    sunElevation: (Math.asin(Math.max(-1, Math.min(1, sun.y))) * 180) / Math.PI,
    moonElevation: (Math.asin(Math.max(-1, Math.min(1, moon.y))) * 180) / Math.PI,
    dark: darkAt(phase),
    daylight: daylightAt(phase),
    night: isNight(phase),
    pinned,
    scale,
    sunrise: SUNRISE_PHASE,
    sunset: SUNSET_PHASE,
    authored: AUTHORED_PHASE,
  };
}
