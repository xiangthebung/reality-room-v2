import * as THREE from 'three';
import { clamp, clamp01, damp, hashString, makeRng, wrapAngle } from '../core/util.js';
import { modalHasKeyboard } from '../core/keys.js';
import { WATER_LEVEL, groundUnder, heightAt, streamPointNear } from '../world/terrain.js';
import { daylightAt } from '../world/daylight.js';
import { fishGeometry } from '../world/shoal.js';
import { makeLiving } from '../trip/living.js';

/**
 * Fishing.
 *
 * A thing to do with your hands while you are talking to somebody, which is
 * still the entire specification. There is no inventory, no upgrade, no rod that
 * catches better fish, nothing to unlock and no reason to do it — and every one
 * of those absences is deliberate, because the moment any of them exists the
 * activity stops being a thing you do while talking and becomes a thing you are
 * doing instead of talking.
 *
 *
 * WHAT WAS WRONG WITH IT, AND WHY THE FIX IS NOT AN INVENTORY.
 *
 * The first version was cast, wait, press. The whole outcome was decided at the
 * cast and the only input afterwards was a 1.6 second reaction test, so a 104 cm
 * pike and a 4 cm minnow were the same three keystrokes and neither of them
 * could be lost. That is a random number generator with a doorbell on it.
 *
 * Adding tackle, bait tables and a shop would have fixed the shallowness by
 * deleting the specification. So the depth went into the two steps a real angler
 * spends their attention on and a game almost never models — the READ before the
 * cast and the FIGHT after the strike — both of which are short, neither of
 * which is a menu, and neither of which asks the player to remember anything
 * between sessions.
 *
 *   THE READ. Where the float lands is now a real decision, because the fish
 *   are a function of the DEPTH OF WATER UNDER IT. `heightAt` already carves a
 *   channel roughly ten metres across and a metre and a half deep in the middle
 *   (see the stream block at the bottom of `heightAt`), so the river has a
 *   shallow gravel margin and a deep centre — and you can SEE which is which,
 *   because deep water is darker. Minnows live on the inside of the bend, pike
 *   live in the trench. Nothing had to be built for this: the geography was
 *   already there and was simply never asked.
 *
 *   THE FIGHT. A hooked fish now runs, and the line can break, and the hook can
 *   fall out. Two inputs, both already in the player's hands: hold `E` to wind,
 *   and turn against the run to put the rod's side strain on it. Reel into a
 *   surge and you snap; stand there admiring it and the line goes slack and it
 *   throws the hook. Everything you need to read is on the rod and the line —
 *   see THE READOUT IS THE TACKLE below.
 *
 * The rhythm is unchanged and the waiting is still the feature: cast, wait a
 * while, notice, react. What is new is that the last beat now has a middle, and
 * that the middle is exactly as long as the fish is worth — a minnow comes
 * straight in, and something big takes twenty seconds of your attention and may
 * still get off.
 *
 *
 * THE FISH ARE A PURE FUNCTION OF WHERE AND WHEN.
 *
 * Nothing about a catch travels over the network except the sentence announcing
 * it. Two people fishing off the same jetty are not drawing from a shared stock,
 * they are each rolling their own dice — because a shared stock would need a
 * server that owns it, a claim protocol, and an answer to what happens when two
 * people hook the same fish, all for an outcome nobody is counting. What IS
 * shared is the flavour: the species depend on the seed, on how far up the river
 * you are and on how deep you cast, so "there are pike in the trench below the
 * top landing" is a true thing one friend can tell another about their world —
 * and, now, a thing they can point at.
 *
 *
 * WHAT THIS COSTS PER FRAME, WHICH IS THE OTHER HALF OF THE BRIEF.
 *
 * Nothing that scales, and `scripts/fish-check.mjs` measures it: 1.5 µs a frame
 * inside `update` with a fish on, under swiftshader, which is a hundredth of a
 * percent of a frame.
 *
 * The fight is scalar arithmetic — about forty multiplies — plus nine floats
 * written into a `Line`'s position attribute that was already being rewritten
 * every frame. `heightAt` is called ONCE PER CAST and never from the frame loop;
 * `streamPointNear` is called once a frame only while a fish is actually on, and
 * into a reused output object. There is no allocation anywhere in `update`, no
 * new material and no new shader variant — both meshes added here are on
 * materials that already existed, deliberately (see `fishGeometry`).
 *
 * Two draw calls were added and neither is paid by anybody who is not fishing.
 * The rod's top section (see `rodGeometry`) draws whenever the rod is out, which
 * is the price of a rod that can bend and is the best-spent draw call in the
 * file. The fish is 30 triangles and spends its whole life with `visible=false`
 * except during a fight.
 *
 * And nothing at all changed for a player who never presses `F`: `update`
 * returns on its first line while the state is `off`.
 *
 *
 * THE SECOND PASS: THE HAND, THE THROW, AND THE LINE ITSELF.
 *
 * Everything above is about what is at the END of the line. Nothing in it was
 * about the line, and that was the hole: the float TELEPORTED to a point
 * computed from head pitch, it was joined to the rod by three vertices with a
 * cosmetic droop, and the length between them was not a quantity the game held
 * an opinion about — so you could walk backwards up the bank with a pike on and
 * the only thing that happened was that the two ends got further apart. Three
 * fixes, and they are one fix:
 *
 *   THE CAST IS A THROW. Hold the left mouse button and the rod loads back;
 *   release and the tackle leaves at a speed you chose, on an elevation your
 *   head chose, and flies a parabola with drag on it until it hits something.
 *   Where it lands is where it lands. The mouse is the right instrument for
 *   this and a key never was — casting is an analogue action with a wind-up, and
 *   a keypress has neither an amount nor a moment of release.
 *
 *   THE LINE IS A ROPE. Ten nodes of position Verlet, inextensible but freely
 *   slack, pinned to the rod tip at one end and to whatever is on the hook at
 *   the other. The sag, the swing, the way it goes bar-tight and lifts clear of
 *   the water when something pulls — none of that is animated any more, it is
 *   what a hanging chain does. See `Rope`.
 *
 *   THE LENGTH IS REAL. There are metres of line off the reel; the cast pays
 *   them out, winding takes them back, and the rope cannot exceed them. That one
 *   quantity is what makes the bank a place rather than a backdrop: walk away
 *   from your own float and you drag it, walk away from a hooked fish and you
 *   are pulling on it with your whole body — which loads the rod exactly as
 *   fast as you are walking, and snaps the line if you run.
 *
 * The cost of all three is in `_rope.step`: ten nodes, three constraint passes,
 * no allocation and no `heightAt`. `scripts/fish-check.mjs` measures it.
 */

/** You may fish where the channel is at least this close. */
const WATER_REACH = 14;

/**
 * THE THROW.
 *
 * Two inputs, and they are the two a real cast has. HOW HARD is how long you
 * held the button, and WHERE is where you are looking — so distance is not a
 * function of pitch any more, it is a function of both, exactly as a thrown
 * object's range is. Looking up and flicking it gently drops it in front of you;
 * looking up and winding all the way back puts it on the far side.
 *
 * `LOAD_S` is a second of hold to full power, which is long enough to be a
 * decision and short enough that nobody is waiting on it. Past full it stays
 * full: a charge meter that punishes overholding is a reaction test, and the
 * whole specification of this activity is that it must survive you being
 * mid-sentence.
 *
 * The speeds are the range: at the launch elevation below, 4.5 m/s puts it about
 * four metres out and 12 puts it about fifteen, which are deliberately the two
 * numbers the old pitch-driven cast clamped between. What is new is that
 * everything in between is now yours rather than the head-tracker's.
 *
 * THEY LOOK TOO SLOW, AND THAT IS THE LAUNCH HEIGHT. The tackle leaves the rod
 * TIP, which is about three metres above the bank, and the bank is about a metre
 * above the water — so every cast has four metres of drop in it and is in the
 * air for well over a second whatever it left at. Fitted with the speeds an
 * arithmetic range formula suggests, a gentle flick cleared the far bank: the
 * first pass measured 11.9 m at a power of 0.05 and 17.2 at full, against a
 * channel whose far edge is twelve metres from where you stand.
 */
const LOAD_S = 1.0;
const CAST_SPEED_MIN = 4.5;
const CAST_SPEED_MAX = 12;
/**
 * Added to head pitch to get the launch elevation, and clamped after.
 *
 * A cast leaves a rod tip going UP even when you are looking level at the water
 * — the rod's top third is doing the throwing and it is pointing at the sky at
 * the moment of release. Without the offset, casting at what you want to hit
 * put the tackle in the margin at your feet, because a flat launch from 1.9 m
 * lands in half a second.
 */
const CAST_ELEVATION = 0.34;
const CAST_ELEV_MIN = 0.1;
const CAST_ELEV_MAX = 0.95;
/**
 * What `E` throws, for a player who never touches the mouse.
 *
 * A comfortable middle-distance cast — about nine metres, which from anywhere on
 * a bank puts the float in the channel rather than across it. Deliberately NOT
 * the middle of the range: a default that reached the far side would mean the
 * keyboard player's every cast landed in the grass on the other bank, which is
 * the one outcome the throw made possible and the default must not make routine.
 */
const DEFAULT_POWER = 0.35;
/** Air, per second of flight. Small; the tackle is dense and the flight is short. */
const AIR_DRAG = 0.22;
const GRAVITY = 9.81;

/** Below this much water under the float, you have cast onto the bank. */
const MIN_DEPTH_M = 0.14;

/* ---- the line ----------------------------------------------------------- */

/**
 * How many nodes the rope is, and why it is not two and not fifty.
 *
 * Ten is the fewest that can hold a curve you would call a curve at the fifteen
 * metres a long cast lands at — at six the sag is a visible dogleg, and above
 * about twelve nothing on screen changes because the whole thing is a pixel
 * wide. It is also, and this matters more, the number that keeps the segment
 * rest length above about 15 cm on a normal cast, which is what stops the
 * constraint solver needing more than three passes to look inextensible.
 */
const ROPE_NODES = 10;
const ROPE_PASSES = 3;
/** Metres of line hanging off the tip with the rod out and nothing cast. */
const REST_LINE_M = 0.7;
/** The spool. A cast that wants more than this gets stopped in the air. */
const MAX_LINE_M = 21;
/** Metres a second the reel takes back, winding with nothing on. */
const RETRIEVE_M_S = 3.4;
/**
 * How fast the river moves the float.
 *
 * Slow — a fifth of a metre a second is a couple of metres across a twenty
 * second wait — and it is doing two jobs. It makes the water look like it is
 * going somewhere, from the one object on it that can show that. And it means a
 * cast has a LIFE: the float swings down and across on the tether until it is
 * out of the good water, at which point you wind in and throw it again, which is
 * what fishing a swim actually consists of and is a rhythm the game previously
 * had no way to express.
 */
const CURRENT_M_S = 0.2;
/**
 * How hard being dragged loads the rod, per metre a second of drag.
 *
 * This is the number that answers "you can just move wherever". Backing up the
 * bank is a real and correct way to help a fish along, so it is not forbidden —
 * it is priced, at a rate that makes a slow step free and a run fatal. Walking
 * is 4.4 m/s and running is 8.2, so a walk away from a fish that already has the
 * rod at working tension puts it over the top in about a second and a half, and
 * a run parts the line more or less at once.
 */
const DRAG_TENSION = 0.19;

/**
 * Seconds a landed fish lies on the bank before it goes back.
 *
 * Long enough to look at it, turn round and show somebody, and read the length
 * off the toast; short enough that it is a beat in the rhythm rather than a
 * screen you have to dismiss. Any input ends it early. See `_land`.
 */
const BEACH_S = 5.5;

/** How long the float sits there before anything happens. */
const WAIT_MIN_S = 5;
const WAIT_MAX_S = 22;

/**
 * How long you have to strike, in seconds.
 *
 * 1.6 is generous — the point is not to be a reaction test. It is long enough
 * that you can be mid-sentence, notice, and still get it; short enough that
 * pressing the key at random does not work, which is what makes getting it feel
 * like something. Missing it costs nothing but the wait.
 */
const STRIKE_WINDOW_S = 1.6;

/**
 * A KNOCK IS NOT A BITE, AND THIS IS THE CHEAPEST THING IN THE FILE.
 *
 * Up to three of them arrive during the wait: a single shallow dip, over in
 * four tenths of a second, made by something too small to be worth striking at.
 * They cost eleven lines and they change what the waiting IS — before them the
 * float had two states and the correct strategy was to ignore it until the
 * screen said `now`, which is not watching, it is waiting for a cue. With them
 * the float is worth looking at, because the difference between a knock and a
 * take is a thing your eye can learn and your reflexes cannot: a knock dips, a
 * take goes UNDER and stays under.
 *
 * Striking one costs you the fish that was coming. That is the right price —
 * it is the wait again, never a lost catch, and it is what makes the judgement
 * a judgement rather than a free guess.
 */
const KNOCK_S = 0.42;
const KNOCK_MAX = 3;

/* ---- the fight ---------------------------------------------------------- */

/**
 * Metres of line you can recover per second with nothing pulling back, and how
 * fast a fish at full strength swims away from you.
 *
 * THESE TWO NUMBERS ARE THE LENGTH OF THE FIGHT and they were both wrong first
 * time. A reel that recovers less than a run gains means the standoff at full
 * stamina is a losing one — the fish is further away after every cycle no matter
 * how well you play — so the whole fight becomes a wait for the stamina term,
 * and the biggest fish in the river took the best part of a minute. That is a
 * boss, not a thing you do while talking to somebody.
 *
 * At 2.4 against 2.3 a fresh pike is very slightly winning and everything below
 * it is losing, which is the shape wanted: the big one holds you level until it
 * tires, and a perch simply comes in. `scripts/fish-check.mjs` asserts both ends
 * of that — a 96 cm pike lands, and a small one is over in under eight seconds.
 */
const REEL_M_S = 2.4;
const RUN_M_S = 2.3;
/** Rod tip to fish, at which it is in your hand. */
const LANDING_M = 1.4;
/**
 * SIDE STRAIN IS AN ANGLE, NOT A RATE, and this was the one thing the fight got
 * wrong on the first pass.
 *
 * It measured how fast you were TURNING against the run, which is intuitive for
 * about a second and then falls apart: holding a rate means turning for ever, so
 * a long run had the player rotating through a hundred and twenty degrees and
 * ending up with their back to the fish, at which point the counter reads zero
 * and the line parts. The correct play was literally unsustainable and
 * `fish-check.mjs` caught it as two lost fish in five with a policy that was
 * following the game's own prompt.
 *
 * What an angler actually does is hold the rod OUT TO ONE SIDE of the fish — the
 * side it is running toward — so the pull is across its body rather than along
 * it. That is a position, it can be held indefinitely, and it still demands
 * constant attention because the fish keeps moving and changes direction. So the
 * quantity is `rel`, the angle from where you are looking to where the fish is,
 * and full side strain is about thirty degrees of it on the correct side.
 *
 * `COUNTER_ARC` is unchanged in meaning: past a hundred degrees you have turned
 * away from it and there is no strain on anything.
 */
const COUNTER_IDEAL = 0.55;
const COUNTER_ARC = 1.75;
/** How close to the ideal offset counts as holding it, for the prompt's arrow. */
const COUNTER_DEAD = 0.14;
/** Seconds over the limit before the line actually parts. */
const SNAP_GRACE_S = 0.9;
/**
 * Seconds of doing NOTHING before the hook works loose.
 *
 * Keyed off the inputs rather than off the tension, after the check found a fish
 * that an idle player held for ten seconds: a fish that alternates runs and
 * rests alternately loads and unloads the line all by itself, so a slack timer
 * that reset whenever the tension came back up could be kept alive indefinitely
 * by the fish's own behaviour. Neither winding nor leaning is the thing that
 * loses a fish, so neither winding nor leaning is what the timer counts.
 */
const SLACK_GRACE_S = 2.2;
/** Below this the line is hanging rather than holding. Drives the sag, not the loss. */
const SLACK_AT = 0.12;
/** The channel is about ten metres across; a hooked fish stays in it. */
const CHANNEL_HALF_M = 4.4;

/**
 * Everything that lives in this river.
 *
 * `deep` is the depth of water in METRES the species wants under it and `spread`
 * how fussy it is about that — real numbers against the real bed, not an
 * abstract 0..1, so the table can be read against the channel profile in
 * `terrain.js` and checked. The bed runs from nothing at the gravel edge to
 * about 1.4 m in the trench, which is what puts minnows in the margin and pike
 * in the middle and makes where you cast the first decision of the activity.
 *
 * `fight` is how hard it pulls for its size, and it is the field that makes two
 * fish of the same length different events. A trout is all muscle and runs
 * across the current; an eel is nearly the same weight and simply sulks. Getting
 * that from one number per row is the whole reason the fight has a species term
 * at all.
 *
 * `hue` is what you see coming up through the water in the last two metres.
 */
const SPECIES = [
  { name: 'minnow', deep: 0.15, spread: 0.3, cm: [4, 9], weight: 1.4, fight: 0.15, hue: 0x8a8f7a },
  { name: 'gudgeon', deep: 0.25, spread: 0.3, cm: [7, 14], weight: 1.2, fight: 0.2, hue: 0x9a8b6c },
  { name: 'roach', deep: 0.5, spread: 0.4, cm: [12, 28], weight: 1.3, fight: 0.4, hue: 0xb8bcc0 },
  { name: 'perch', deep: 0.65, spread: 0.38, cm: [14, 34], weight: 1.0, fight: 0.6, hue: 0x6f7a3e },
  { name: 'chub', deep: 0.8, spread: 0.4, cm: [20, 46], weight: 0.9, fight: 0.7, hue: 0xa9a794 },
  { name: 'brown trout', deep: 0.9, spread: 0.3, cm: [18, 42], weight: 0.7, fight: 1.0, hue: 0x7d6437 },
  { name: 'tench', deep: 1.05, spread: 0.28, cm: [26, 50], weight: 0.5, fight: 0.75, hue: 0x4c5230 },
  { name: 'eel', deep: 1.15, spread: 0.35, cm: [34, 88], weight: 0.35, fight: 0.55, hue: 0x3f4436 },
  { name: 'pike', deep: 1.25, spread: 0.3, cm: [40, 104], weight: 0.25, fight: 0.95, hue: 0x556138 },
];

/**
 * The things that are not fish.
 *
 * They are the reason to keep casting. A boot is funnier than a roach and a
 * message in a bottle is the only place in this project where anything
 * resembling a story is told — one line, from nobody, addressed to nobody. It
 * costs four kilobytes of table and it is what people will describe to each
 * other afterwards.
 *
 * More of them turn up in the shallows than in the trench, which is both true of
 * rivers and the one consolation for a bad cast.
 */
const CURIOSITIES = [
  'a boot, full of river',
  'a horseshoe, green with it',
  'a length of somebody else’s line',
  'a bottle with a note in it: <i>gone to the far bank, back by dark</i>',
  'a bottle with a note in it: <i>whoever finds this — it was worth it</i>',
  'a bottle with a note in it: <i>tell them I said the thing about the herons</i>',
  'a key, to nothing here',
  'a tin whistle, still playable',
  'a jam jar with three sticklebacks in it',
  'a coin, worn smooth on both faces',
];

const _v = new THREE.Vector3();
/** The float's own axis, for pointing it down a line it is hanging from. */
const _up = new THREE.Vector3(0, 1, 0);
/** Reused, because the channel is asked for every frame while a fish is on. */
const _bank = { x: 0, y: 0, z: 0, angle: 0 };
/** Reused by the `water` getter, which main.js polls once a frame for the prompt. */
const _reach = { bank: _bank, distance: 0 };
/** Where the tackle is, handed to the sound layer. Reused; callers must not keep it. */
const _where = { x: 0, y: 0, z: 0 };

/**
 * THE LINE, AS A PIECE OF STRING RATHER THAN AS A DRAWING OF ONE.
 *
 * Position Verlet: each node remembers where it was, and the difference between
 * that and where it is IS its velocity, so there is no second array to keep in
 * step and no way for the two to disagree. Gravity goes on as an acceleration,
 * the length is enforced by moving the nodes rather than by pushing on them, and
 * the whole thing is a hundred and twenty floats that never reallocate.
 *
 * TWO PROPERTIES ARE THE ENTIRE REASON THIS IS A ROPE AND NOT A SPRING.
 *
 * It is INEXTENSIBLE — a segment longer than its rest length is shortened, and
 * three passes of that from both ends is indistinguishable from rigid at this
 * scale. And it is FREELY SLACK — a segment SHORTER than rest is left alone,
 * because string does not push. That asymmetry is one `if`, and it is what
 * produces every visible behaviour worth having: the catenary when there is
 * nothing on it, the way the belly lifts out of the water as the load comes on,
 * and the snap straight when a fish surges. A spring model gets none of them and
 * needs a stiffness constant nobody can tune.
 *
 * The ends are PINNED rather than forced. The rod tip is wherever the rod put
 * it and a hooked fish is wherever the fight put it — both are authoritative,
 * both are decided elsewhere, and a rope that argued with either would be a
 * rope that could stretch the rod. So the solver moves only the nodes it owns,
 * which is also what keeps the fight's arithmetic exactly as tuned and tested.
 */
class Rope {
  constructor(n) {
    this.n = n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    /** Last frame's step, for the time-corrected integration below. */
    this.dtPrev = 1 / 60;
  }

  /** Lay it out straight between two points, at rest. */
  reset(ax, ay, az, bx, by, bz) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      this.x[i] = this.px[i] = ax + (bx - ax) * t;
      this.y[i] = this.py[i] = ay + (by - ay) * t;
      this.z[i] = this.pz[i] = az + (bz - az) * t;
    }
    this.dtPrev = 1 / 60;
  }

  /** Where the far end is, which is where the float is. */
  endX() {
    return this.x[this.n - 1];
  }
  endY() {
    return this.y[this.n - 1];
  }
  endZ() {
    return this.z[this.n - 1];
  }

  /**
   * TOMBSTONE: there was a `launch(vx, vy, vz)` here, which gave the far node a
   * velocity by moving where it remembered coming from — the natural way to
   * throw a Verlet chain, and it does not throw. See the note at `_fly` in the
   * constructor for the measurement and for what replaced it.
   */

  /**
   * One step.
   *
   * @param {number} dt
   * @param {THREE.Vector3} tip where the rod tip is now — node 0, always pinned
   * @param {number} length metres of line off the reel
   * @param {number} floorY nothing goes below this. See the note at the call site
   * @param {?{x:number,y:number,z:number}} end pin the far end here, or null to
   *   let it fly. This is the difference between a hooked fish, which owns its
   *   own position, and a thrown float, which does not.
   * @param {number} drag air resistance on the far end, per second
   */
  step(dt, tip, length, floorY, end = null, drag = 0) {
    const n = this.n;
    const last = n - 1;
    /**
     * Time-corrected Verlet, because dt is a real frame and not a constant.
     * Plain `x += x - px` assumes a fixed step and injects energy the moment the
     * frame rate changes — which on this project is every time the governor
     * moves a quality knob, and it showed up as a line that started whipping.
     * Capped at 3 so one long frame cannot fire the whole rope off the map.
     */
    const ratio = Math.min(3, dt / (this.dtPrev || dt || 1 / 60));
    const g = -GRAVITY * dt * dt;
    /**
     * Damping is per node and it is not uniform: the far end carries the float,
     * which is a lump of cork in moving water, and the middle of the line is
     * mostly air. A single constant either left the float ringing or made the
     * line look like it was hanging in treacle.
     */
    for (let i = 1; i < n; i++) {
      const isEnd = i === last;
      const damp = isEnd ? Math.max(0, 1 - drag * dt) * 0.99 : 0.985;
      const vx = (this.x[i] - this.px[i]) * ratio * damp;
      const vy = (this.y[i] - this.py[i]) * ratio * damp;
      const vz = (this.z[i] - this.pz[i]) * ratio * damp;
      this.px[i] = this.x[i];
      this.py[i] = this.y[i];
      this.pz[i] = this.z[i];
      this.x[i] += vx;
      this.y[i] += vy + g;
      this.z[i] += vz;
    }

    /**
     * The floor, as ONE NUMBER for the whole rope rather than as a height field
     * query per node.
     *
     * `heightAt` is the most expensive thing this file could put in a frame loop
     * and the header promises it is not there — ten calls a frame to stop a line
     * sinking into a river bed nobody can see would be the whole budget. The
     * surface of the water, or the ground at a dry cast's landing point, is
     * flat and known at the moment of the cast, so the caller passes it in.
     */
    for (let i = 1; i < n; i++) {
      if (this.y[i] < floorY) {
        this.y[i] = floorY;
        // Lying on something takes the horizontal speed out of it, which is what
        // keeps a line on the water from sliding about like it is on ice.
        this.px[i] += (this.x[i] - this.px[i]) * 0.4;
        this.pz[i] += (this.z[i] - this.pz[i]) * 0.4;
      }
    }

    this.x[0] = tip.x;
    this.y[0] = tip.y;
    this.z[0] = tip.z;
    if (end) {
      this.x[last] = end.x;
      this.y[last] = end.y;
      this.z[last] = end.z;
    }

    const rest = Math.max(0.02, length / (n - 1));
    for (let pass = 0; pass < ROPE_PASSES; pass++) {
      for (let i = 0; i < last; i++) {
        const j = i + 1;
        const dx = this.x[j] - this.x[i];
        const dy = this.y[j] - this.y[i];
        const dz = this.z[j] - this.z[i];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // String does not push. See the header.
        if (d <= rest || d < 1e-6) continue;
        const k = (d - rest) / d;
        // A pinned end cannot move, so its neighbour takes the whole correction.
        const aFixed = i === 0;
        const bFixed = j === last && end !== null;
        const wa = aFixed ? 0 : bFixed ? 1 : 0.5;
        const wb = bFixed ? 0 : aFixed ? 1 : 0.5;
        this.x[i] += dx * k * wa;
        this.y[i] += dy * k * wa;
        this.z[i] += dz * k * wa;
        this.x[j] -= dx * k * wb;
        this.y[j] -= dy * k * wb;
        this.z[j] -= dz * k * wb;
      }
    }
    this.dtPrev = dt;
  }
}

/**
 * The float, the line and the rod.
 *
 * THE ROD IS TWO PIECES, AND THAT IS THE FIGHT'S MAIN INSTRUMENT.
 *
 * It was one 2.5 m cylinder, and the load was shown by rotating the whole thing
 * forward. That does not read as a rod bending, it reads as somebody lowering a
 * stick — and at full tension it went past horizontal, which is the posture of a
 * person giving up rather than of one hanging onto something. A rigid rod cannot
 * hoop, so it was split at the point a real one bends from: a stiff butt that
 * stays where the hand puts it, and a soft top third hinged at the ferrule that
 * curves right over. Load is now a shape rather than an angle, which is what a
 * rod actually is and what makes it legible from any viewpoint.
 *
 * ONE EXTRA MESH, ON THE SAME MATERIAL, and only while the rod is out. The
 * lengths add up to the 2.55 m the single piece was, so nothing about the
 * silhouette at distance changed.
 *
 * `avatar.js` still builds a remote person's rod as one cylinder of its own —
 * see the note there about not depending on an activity. That is now a real
 * divergence rather than a copy, and it is the right one: a hoop is a couple of
 * pixels at the forty metres a rod is recognised across, and the alternative is
 * teaching the avatar layer what line tension is.
 */
export function rodGeometry() {
  return {
    /** Tapered, and long: a rod's silhouette is the whole tell at forty metres. */
    butt: new THREE.CylinderGeometry(0.013, 0.022, 1.7, 5),
    top: new THREE.CylinderGeometry(0.008, 0.013, 0.85, 5),
    float: new THREE.CylinderGeometry(0.035, 0.035, 0.17, 7),
    tip: new THREE.ConeGeometry(0.04, 0.09, 7),
  };
}

/** Where the butt ends and the soft top begins, and how long that top is. */
const FERRULE_M = 0.85;
const TOP_M = 0.85;

/**
 * THE FISH MESH IS BUILT ELSEWHERE NOW.
 *
 * `fishGeometry` lived here for as long as the only fish in the world was one
 * you had just caught. There are fish in the river now (see world/shoal.js) and
 * they are the same animal, so the shape moved to the module that owns the
 * animal and this one imports it — a player who never picks up a rod should not
 * be depending on the rod for the fish they can see swimming past.
 */

export class Fishing {
  /**
   * @param {object} deps
   * @param {THREE.Scene} deps.scene
   * @param {import('./controller.js').Controller} deps.controller
   * @param {string} deps.seed
   * @param {(text: string, ms?: number) => void} deps.say
   * @param {(text: string) => void} [deps.announce] tell the room
   * @param {(kind: string, at: {x:number,y:number,z:number}, strength?: number) => void}
   *   [deps.sound] one-shots, wired to `Ambience.fishing`. Optional on purpose:
   *   the rod has to work before the audio context has been unlocked, and the
   *   perf scripts run it with no audio at all.
   * @param {(x: number, z: number, radius: number, strength: number) => void}
   *   [deps.disturb] something hit the water here. Wired to the shoal, which
   *   scatters — the rod is the only module that knows a float has just landed
   *   and the shoal is the only one that can react to it, so the two are joined
   *   by one callback rather than by either importing the other.
   */
  constructor({
    scene,
    controller,
    seed,
    say,
    announce = null,
    sound = null,
    disturb = null,
  }) {
    this.controller = controller;
    this.seed = seed;
    this.say = say;
    this.announce = announce;
    this.sound = sound;
    this.disturb = disturb;

    /**
     * 'off' | 'ready' | 'loading' | 'flight' | 'waiting' | 'bite' | 'playing'
     * | 'landed'
     *
     * Three of those are new and each of them is a moment that used to be
     * skipped over: winding the rod back, the tackle in the air, and the fish
     * lying on the grass in front of you.
     */
    this.state = 'off';
    /** Everything you have caught this session, newest first. */
    this.book = [];
    this.casts = 0;
    /** The ones that got away. A number worth having; see `_lose`. */
    this.lost = 0;
    /** 'snap' | 'slack' | 'stowed', for the check script and the debug panel. */
    this.lastLoss = null;
    /**
     * Which way to sweep the rod right now: -1 left, +1 right, 0 nothing doing.
     * Read by main.js — with `surge` — to pick one of four hoisted prompt
     * strings, which is how the fight teaches its own rule without a tutorial
     * or an allocation.
     */
    this.lean = 0;
    /** Is the fish running right now? See where this is set, in `_play`. */
    this.surge = false;

    this._timer = 0;
    this._catch = null;
    this._bobPhase = 0;
    /** Cast landed on dry ground. Reel in; nothing is coming. */
    this._dry = false;

    /* ---- the hand, the throw and the line --------------------------------- */

    /** 0..1 while `loading`; how far the rod is wound back. */
    this.power = 0;
    /** Held: left button loads the cast, right button winds. See `_bindMouse`. */
    this._holding = false;
    this._winding = false;
    /**
     * The rod's own swing, in radians, on top of everything the pose block does.
     * Negative is back over the shoulder. Driven as a spring so the release is a
     * whip rather than a cut.
     */
    this._swing = 0;
    this._swingVel = 0;
    /** Metres of line off the reel. The quantity the whole second pass is about. */
    this._lineOut = REST_LINE_M;
    this._rope = new Rope(ROPE_NODES);
    /**
     * What the rope may not sink through: the water while the float is on it,
     * the ground at a dry cast. One number, sampled at the cast — see the note
     * in `Rope.step` about why this is not a height field query.
     */
    this._floorY = WATER_LEVEL;
    /** Where the float was when the bed under it was last sampled. */
    this._sampledX = 0;
    this._sampledZ = 0;
    /** Seconds the catch lies on the bank before it goes back. See `_land`. */
    this._beached = 0;
    this._beachPhase = 0;
    this._beachX = 0;
    this._beachY = 0;
    this._beachZ = 0;
    this._beachYaw = 0;
    /** Tension owed to the player walking away from their own line. See `_play`. */
    this._dragLoad = 0;
    /** Seconds the tackle has been in the air, so a bad throw cannot hang. */
    this._flightFor = 0;
    /**
     * THE TACKLE IN THE AIR IS ITS OWN PARTICLE, AND THAT IS NOT A SHORTCUT.
     *
     * The obvious build was to let the rope's own far node be the projectile —
     * one integrator, one object, nothing to keep in step. It does not fly. A
     * Verlet chain launched from a point is nine nodes at rest and one moving,
     * the constraint pass propagates one segment per iteration, and three
     * iterations means the moving end is effectively tethered to a node that has
     * not heard about the throw yet. Measured: a full-power cast travelled 2.1 m
     * in 1.6 seconds of flight, which is not a cast, it is a rope being dragged
     * along the ground.
     *
     * The physics is also on this side of the argument. Line coming off a spool
     * is not a chain being towed — it is new line, arriving from the reel at
     * whatever rate the tackle needs, and it exerts almost nothing on the thing
     * pulling it. So the tackle flies as a particle, `_lineOut` follows it, and
     * the rope is pinned to it and drawn. The one thing the line does do — stop
     * the cast dead when the spool runs out — is `MAX_LINE_M`, right there in
     * the integration where it can take the velocity with it.
     */
    this._fly = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    /** Elapsed seconds since the cast, against which the knocks are scheduled. */
    this._elapsed = 0;
    this._knocks = [];
    this._knockUntil = -1;
    this._rng = makeRng(seed);
    /** The one sentence of tuition, shown once a session. See `_strike`. */
    this._taught = false;

    /** The fight. All of it, and it allocates once. */
    this._fish = {
      x: 0,
      z: 0,
      angle: 0,
      power: 0,
      stamina: 1,
      running: false,
      runTimer: 0,
      speed: 0,
      elapsed: 0,
      lastRun: false,
    };
    this._tension = 0;
    this._overFor = 0;
    this._slackFor = 0;
    this._reelClick = 0;
    this._strainClock = 0;

    const geo = rodGeometry();
    this._geo = geo;
    this._fishGeo = fishGeometry();

    const woodMaterial = makeLiving(
      new THREE.MeshLambertMaterial({ color: 0x6a4a2c }),
      'prop'
    );
    this.group = new THREE.Group();
    this.group.name = 'fishing';
    this.group.visible = false;
    scene.add(this.group);

    /**
     * THE ROD IS IN THE WORLD, NOT ON THE GLASS.
     *
     * Every other game puts the held object in a separate near-plane camera so
     * it can never clip through anything. That is a screen-space overlay by
     * another name, and this project's whole visual argument — see the header of
     * `hud.js` — is that a stable rectangle welded to the viewport is the one
     * reference frame a trip must not be given. So the rod is a mesh standing at
     * world coordinates in front of the body, lit by the same sun, melted by the
     * same trip, and occasionally poking through a sapling. That last part is
     * the price and it is worth paying.
     *
     * It is also the reason the fight could be built at all. A tension meter is
     * a rectangle; a rod that hoops over is the same information arriving
     * through the same window as everything else in the world.
     */
    this.rod = new THREE.Mesh(geo.butt, woodMaterial);
    this.group.add(this.rod);
    /**
     * The top third, hinged at the ferrule and carried as a child of the butt —
     * so it inherits the whole hand-and-yaw transform for free and the only
     * thing ever written to it is one rotation. See `rodGeometry`.
     */
    this.ferrule = new THREE.Group();
    this.ferrule.position.y = FERRULE_M;
    this.rod.add(this.ferrule);
    this.rodTop = new THREE.Mesh(geo.top, woodMaterial);
    this.rodTop.position.y = TOP_M * 0.5;
    this.ferrule.add(this.rodTop);

    this.float = new THREE.Mesh(
      geo.float,
      new THREE.MeshLambertMaterial({ color: 0xd94f36, emissive: 0x2a0d06 })
    );
    this.floatTip = new THREE.Mesh(
      geo.tip,
      new THREE.MeshLambertMaterial({ color: 0xf2f0e6 })
    );
    this.floatTip.position.y = 0.12;
    this.float.add(this.floatTip);
    this.group.add(this.float);

    /**
     * The fish itself, and it is the only new object in this rewrite.
     *
     * `visible` is false except while one is on, so the whole of its cost to
     * anybody not fishing is a Mesh sitting in a Group that is itself hidden —
     * no draw, no shadow, no sort. Shadows are off even when it IS visible: it
     * is underwater, the shadow would land on the river bed nobody can see, and
     * a shadow caster is a second pass over the same 26 triangles for nothing.
     */
    this.fish = new THREE.Mesh(
      this._fishGeo,
      makeLiving(new THREE.MeshLambertMaterial({ color: 0x6f7a3e }), 'prop')
    );
    this.fish.castShadow = false;
    this.fish.receiveShadow = false;
    this.fish.visible = false;
    /**
     * 'YXZ', for exactly one pose.
     *
     * Three's default 'XYZ' applies the X term LAST, so it is a rotation about
     * the WORLD's X axis rather than about the fish's own length. Every angle in
     * the swimming pose is a few degrees and the difference is unmeasurable
     * there; laying a fish on the bank is a quarter turn, and a quarter turn
     * about the wrong axis is the difference between on its side and on its
     * nose. With 'YXZ' the yaw is applied last, so the X term rolls the body
     * about the axis it is long on — which is what "on its side" means, and is
     * what the check verifies when it measures the catch's height above the
     * water.
     */
    this.fish.rotation.order = 'YXZ';
    this.group.add(this.fish);

    /**
     * The line: TEN points, and not one of them is drawn where it is by hand.
     *
     * It was two, then three with the middle one lowered by a sag term computed
     * from the tension — a drawing of a rope rather than a rope, and it could
     * only ever say one thing at a time. Ten nodes of `Rope` say all of them at
     * once and for free, because they are all the same fact: SAG IS THE TENSION.
     * A line that droops in a lazy curve when you stop winding, lifts its belly
     * out of the water as the load comes on, goes bar-straight when a fish
     * surges and swings downstream on the current is not four animations, it is
     * one piece of string being pulled on by four different things.
     *
     * Seven extra vertices. Not one extra draw.
     */
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(ROPE_NODES * 3), 3)
    );
    this.line = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({ color: 0xdfe6e8, transparent: true, opacity: 0.55 })
    );
    this.group.add(this.line);

    this.woodMaterial = woodMaterial;
    this._target = new THREE.Vector3();
    this._tip = new THREE.Vector3();
    this._end = { x: 0, y: 0, z: 0 };
    this._bindMouse();
  }

  /**
   * THE ROD IS THE ONE THING IN THIS WORLD THAT IS HELD IN A HAND.
   *
   * Everything else you do here is a fact about where you are standing — a
   * mushroom is eaten, a seat is sat on, a record is started — and `E` is
   * exactly right for all of them, because they have no amount and no moment.
   * A cast has both. It is the only action in the game with a wind-up, a
   * decision about how hard, and a release you can be early or late on, and a
   * keyboard cannot express any of the three: `E` was a button that meant "a
   * cast happens now, at a distance derived from your neck angle".
   *
   * So the mouse takes it. Left button down loads, up throws, and the amount is
   * how long you held it — which is the actual gesture, done with the actual
   * hand, and needs no meter drawn on the glass to be legible because the rod
   * itself is winding back while you do it.
   *
   * WHAT THE GUARDS ARE FOR, all four of them:
   *
   *   The rod has to be out. Otherwise clicking to look around casts a line.
   *
   *   The pointer has to be LOCKED. The first click on the canvas is the one
   *   that takes the pointer — see `Controller._bind` — and a player who alt-
   *   tabbed away and clicked back in must not have that click throw their
   *   tackle across the river.
   *
   *   A modal must not have the keyboard. Same rule the key handlers go through
   *   in `core/keys.js`, for the same reason: a click that lands on the settings
   *   dialog belongs to the settings dialog.
   *
   *   `mouseup` is heard on the WINDOW and is not guarded on any of that, which
   *   is the same asymmetry `keyup` has in the controller. A button released
   *   after a menu opened, or outside the canvas, still has to be released — or
   *   the rod stays wound back for the rest of the session.
   */
  _bindMouse() {
    const canvas = this.controller.dom;
    if (!canvas?.addEventListener) return;

    const live = () =>
      this.state !== 'off' &&
      this.controller.enabled &&
      this.controller.locked &&
      !modalHasKeyboard();

    canvas.addEventListener('mousedown', (e) => {
      if (!live()) return;
      if (e.button === 0) {
        e.preventDefault();
        this.hold();
      } else if (e.button === 2) {
        e.preventDefault();
        this._winding = true;
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.release();
      else if (e.button === 2) this._winding = false;
    });
    /**
     * The right button is the reel, so the browser's own menu on it has to go —
     * and only on the canvas, so a right-click on the settings panel or the
     * link box still behaves like a right-click on a web page.
     */
    canvas.addEventListener('contextmenu', (e) => {
      if (this.state !== 'off') e.preventDefault();
    });
    window.addEventListener('blur', () => {
      this._holding = false;
      this._winding = false;
    });
  }

  /**
   * Is the reel turning?
   *
   * BOTH HANDS COUNT, and that is not indecision. The right button is the reel
   * because the left one is the cast and a reel is a thing you hold; `E` stays
   * because the fight was built, tuned and tested around holding `E`, because
   * `fish-check.mjs` drives it that way, and because a player who has just
   * learnt that `E` does everything else should not discover that the one moment
   * it matters most is the exception.
   */
  get reeling() {
    const c = this.controller;
    return this._winding || (c.enabled && c.keys.has('KeyE'));
  }

  /**
   * Is there water in front of the player right now?
   *
   * Returns a shared object rather than a fresh one. main.js polls this every
   * frame to decide whether to offer the rod prompt, and `streamPointNear`
   * allocates its own result unless handed somewhere to put it — so the old
   * version made two objects per frame for a string comparison that usually
   * failed. Callers must not keep it.
   */
  get water() {
    const p = this.controller.position;
    streamPointNear(p.x, p.z, _bank);
    const distance = Math.hypot(_bank.x - p.x, _bank.z - p.z);
    if (distance >= WATER_REACH) return null;
    _reach.distance = distance;
    return _reach;
  }

  /** Take the rod out, or put it away. */
  toggle() {
    if (this.state === 'off') {
      if (!this.water) {
        this.say('There is no water here.');
        return false;
      }
      this.state = 'ready';
      this.group.visible = true;
      this.power = 0;
      this._holding = false;
      this._winding = false;
      this._lineOut = REST_LINE_M;
      this._floorY = WATER_LEVEL;
      const tip = this._poseRod(0, 0);
      this._rope.reset(tip.x, tip.y, tip.z, tip.x, tip.y - REST_LINE_M, tip.z);
      this.say('A rod. Hold the <b>left mouse button</b> to load a cast, let go to throw.', 5600);
      return true;
    }
    this.stow();
    return false;
  }

  stow() {
    /**
     * Putting the rod away with a fish on is losing it, and it says so.
     *
     * The alternative is that `F` is a free escape from a fight you are about to
     * lose, which would make the failure states decorative.
     */
    if (this.state === 'playing') this._lose('You put the rod down. It goes with it.', 'stowed');
    this.state = 'off';
    this.group.visible = false;
    this.fish.visible = false;
    this._catch = null;
    this.lean = 0;
    this.surge = false;
    this.power = 0;
    this._holding = false;
    this._winding = false;
    this._beached = 0;
    this._swing = 0;
    this._swingVel = 0;
    this._lineOut = REST_LINE_M;
  }

  /**
   * The left button going down: start winding the rod back.
   *
   * It also stands in for `E` at the two moments a hand on the mouse should not
   * have to find a key — striking a bite, and putting a landed fish back — for
   * the same reason `act` covers everything: the player is holding a rod, and
   * the thing to do next should never be a question about which input does it.
   */
  hold() {
    switch (this.state) {
      case 'ready':
        this._holding = true;
        this.state = 'loading';
        this.power = 0;
        return true;
      case 'bite':
        return this._strike();
      case 'landed':
        this._slipBack();
        return false;
      case 'waiting':
        // Not a cast — you already have one out. This is the strike you make
        // when you think you saw something, and it costs what it always did.
        return this.act();
      default:
        return false;
    }
  }

  /** The left button coming up: throw whatever has been wound in. */
  release() {
    this._holding = false;
    if (this.state !== 'loading') return false;
    return this._throw(this.power);
  }

  /**
   * The one key, still. Cast, or strike, depending on what is happening —
   * because having two keys for "the thing you do next" is one more than a
   * person who is mid-conversation can hold in their head.
   *
   * It throws at `DEFAULT_POWER` rather than opening the load, because a key
   * press has no duration to read and pretending otherwise (tap to start, tap to
   * finish) would be a worse version of the gesture the mouse already does
   * properly. So `E` is the comfortable middle-distance cast and the mouse is
   * the one you aimed.
   *
   * During the fight it deliberately does NOTHING, because the press is the
   * start of a hold: winding is `E` held down, read through `reeling`.
   */
  act() {
    switch (this.state) {
      case 'ready':
        return this._throw(DEFAULT_POWER);
      case 'loading':
        return this.release();
      case 'landed':
        this._slipBack();
        return false;
      case 'flight':
        // It is in the air. Nothing anybody does now changes where it lands,
        // which is the whole point of it being a throw.
        return false;
      case 'waiting':
        if (this._dry) {
          this.state = 'ready';
          this.say('You reel it back out of the grass.');
          return false;
        }
        if (this._elapsed < this._knockUntil) {
          /**
           * Struck at a knock. The cost is the fish that was on its way, which
           * is the wait over again — never a catch, because a mistake that can
           * take a fish off you before you have felt it is a mistake you cannot
           * learn from.
           */
          this.state = 'ready';
          this._catch = null;
          this.say('You strike at nothing. Whatever it was, it was not a fish.');
          return false;
        }
        // Striking early: the float goes back in, no harm done, and the line
        // about it is the only feedback anybody needs.
        this.state = 'ready';
        this._catch = null;
        this.say('You reel in an empty hook.');
        return false;
      case 'bite':
        return this._strike();
      default:
        return false;
    }
  }

  /**
   * THE THROW ITSELF, which is now the only way the tackle gets anywhere.
   *
   * The old `_cast` picked a landing point — pitch mapped to a distance, a
   * point that far along your heading, and the float was simply there on the
   * next frame. Everything wrong with the feel of this activity was in that one
   * decision. There was no flight, so there was no moment of watching; the
   * distance came from your NECK, so a cast was something your head did; and
   * because the answer was computed before anything moved, the water could not
   * be missed, the far bank could not be overshot and a low branch could not be
   * hit. A cast that cannot go wrong is not a skill, it is a menu.
   *
   * Now the tackle leaves the rod tip with a velocity and the world decides the
   * rest. `power` is how long you held the button and pitch is the elevation,
   * so the two inputs are the two a throw has, and the range is whatever those
   * two produce against gravity and a little drag.
   *
   * NOTHING IS ROLLED HERE. The species, the wait and the knocks are all decided
   * at SPLASHDOWN, in `_settle`, because they are a function of the water it
   * actually landed in — which is a fact this function does not know yet and is
   * the entire reason the read is worth making.
   */
  _throw(power) {
    if (!this.water) {
      this.say('There is no water here.');
      this.state = 'ready';
      return false;
    }

    const c = this.controller;
    const tip = this._poseRod(0, 0);
    const forward = c.forward(_v);
    /**
     * Elevation, and the clamps are the honest version of the old pitch band.
     *
     * Looking at your boots still throws it somewhere useful rather than into
     * the ground at your feet, and looking at the sky is a high lob rather than
     * a broken cast. In between, the angle is yours.
     */
    const elev = clamp(c.pitch + CAST_ELEVATION, CAST_ELEV_MIN, CAST_ELEV_MAX);
    const speed = CAST_SPEED_MIN + (CAST_SPEED_MAX - CAST_SPEED_MIN) * clamp01(power);
    const horizontal = Math.cos(elev) * speed;

    this.casts += 1;
    this._dry = false;
    this._catch = null;
    this._elapsed = 0;
    this._knockUntil = -1;
    this._knocks.length = 0;
    this._timer = 0;
    /** The flight's own clock, so a throw off a cliff cannot last for ever. */
    this._flightFor = 0;
    this.state = 'flight';

    /**
     * The whole rope starts AT THE TIP and is paid out by the flight, because
     * that is where the line is at the moment of release — on the spool.
     */
    this._lineOut = REST_LINE_M;
    this._floorY = WATER_LEVEL;
    this._rope.reset(tip.x, tip.y, tip.z, tip.x, tip.y - 0.05, tip.z);
    const fly = this._fly;
    fly.x = tip.x;
    fly.y = tip.y;
    fly.z = tip.z;
    fly.vx = forward.x * horizontal;
    fly.vy = Math.sin(elev) * speed;
    fly.vz = forward.z * horizontal;

    // The rod whips forward, hard, in proportion to what went into it.
    this._swingVel = 7 + power * 9;
    this.power = 0;
    _where.x = tip.x;
    _where.y = tip.y;
    _where.z = tip.z;
    this.sound?.('cast', _where, 0.5 + clamp01(power) * 0.5);
    return true;
  }

  /**
   * It has arrived. Work out what it arrived IN, and hand over to the wait.
   *
   * This is where the old `_cast`'s second half lives, unchanged in everything
   * that matters — one `heightAt`, the depth under the float, and every roll
   * made from it. What changed is only WHEN: the read is now against the water
   * the throw found rather than against the water the throw was aimed at, so a
   * cast that fell short of the trench gets what is in the margin, which is the
   * entire point of there being a trench.
   */
  _settle(x, z) {
    /**
     * THE ONE HEIGHT SAMPLE, AND IT IS THE WHOLE READ.
     *
     * `heightAt` is the river bed. The water is a flat plane at WATER_LEVEL, so
     * the difference is the depth under the float in metres, and the depth under
     * the float is what decides what is down there.
     */
    const bed = heightAt(x, z);
    const depth = WATER_LEVEL - bed;
    this.state = 'waiting';
    this._elapsed = 0;
    this._knockUntil = -1;
    this._knocks.length = 0;
    this._sampledX = x;
    this._sampledZ = z;

    if (depth < MIN_DEPTH_M) {
      /**
       * Dry, or as near as makes no difference. The float rests on the ground
       * where it fell and nothing will ever happen to it — which is the honest
       * outcome and takes about two casts to learn from.
       */
      this._dry = true;
      this._target.set(x, bed + 0.06, z);
      /**
       * THE FLOOR IS THE WATER EVEN FOR A CAST THAT MISSED IT, and that is not
       * a fudge — it is what the single-number floor means.
       *
       * `_floorY` only ever applies to the rope's MIDDLE; both ends are pinned
       * (the tip by the rod, the float by `_target` at the height of the ground
       * it is actually lying on). A cast that clears the river lands on the far
       * bank, which is above the water — and the line between here and there
       * hangs over the CHANNEL, so a floor at the far bank's height jacked the
       * whole middle of the line up above the river and drew a tent instead of a
       * line. The lower of the two is the surface most of the rope is over.
       */
      this._floorY = Math.min(bed + 0.04, WATER_LEVEL);
      this._catch = null;
      this.say(depth > -0.4 ? 'It lands in the shallows, barely wet.' : 'It lands in the grass.');
      this.sound?.('cast', this._target, 0.4);
      return true;
    }

    this._dry = false;
    this._target.set(x, WATER_LEVEL, z);
    this._floorY = WATER_LEVEL;
    /**
     * Everything with fins for five metres knows something just hit the water.
     *
     * Two seconds later they are back, which is the behaviour worth having: cast
     * badly on top of a shoal you were watching and you have put them down, and
     * you can see that you have.
     */
    this.disturb?.(x, z, 5.5, 1);
    this.sound?.('splash', this._target, 0.45);

    /**
     * The wait, and the catch, decided NOW rather than when the fish arrives.
     *
     * Rolling the outcome at the moment of the bite would make the result depend
     * on when the player happened to press a key, which is the one input that
     * must not be able to fish for a better fish. Deciding it at the cast means
     * the river has already made up its mind and the only thing left is whether
     * you were paying attention.
     */
    const rng = makeRng(
      `${this.seed}:fish:${this.casts}:${Math.round(this._target.x)}:${Math.round(
        this._target.z
      )}:${Math.floor(Date.now() / 997)}`
    );
    this._rng = rng;

    /**
     * DEEP WATER IS BETTER AND SLOWER, WHICH IS THE TRADE THE READ IS MADE OF.
     *
     * A read that only ever said "the middle is better" would not be a decision,
     * it would be an instruction. The margin gives you a small fish quickly and
     * the trench makes you wait for a big one, so where to cast depends on
     * whether you are settling in or filling thirty seconds — which is exactly
     * the axis this activity is supposed to sit on.
     *
     * And the light: `daylightAt` is 1 at noon and 0 at midnight, so the term
     * below peaks halfway between, at dusk and again at dawn. Fish feed in the
     * failing light, everybody knows it, nobody has to be told it here, and it
     * gives the day cycle a consequence at the one hour of it that is already
     * the best to be standing outside in.
     */
    const dusk = 1 - Math.abs(daylightAt() * 2 - 1);
    const wait =
      (WAIT_MIN_S + rng() * (WAIT_MAX_S - WAIT_MIN_S)) *
      (0.72 + clamp01(depth / 1.4) * 0.55) *
      (1 - dusk * 0.3);
    this._timer = wait;
    this._catch = this._roll(rng, this._target, depth);

    /**
     * Knocks, scheduled into the wait rather than rolled per frame.
     *
     * Deciding them up front means the whole cast is one draw from one seeded
     * generator and `update` stays a clock — no randomness on the frame loop,
     * nothing that can behave differently at a different frame rate, and a cast
     * that replays identically given the same seed and the same second.
     */
    const knocks = Math.floor(rng() * (KNOCK_MAX + 1));
    for (let i = 0; i < knocks; i++) {
      const at = 1.2 + rng() * Math.max(0.1, wait - 2.6);
      if (at < wait - 1.2) this._knocks.push(at);
    }
    this._knocks.sort((a, b) => a - b);
    return true;
  }

  /**
   * What is down there.
   *
   * TWO TERMS, AND THEY DO DIFFERENT JOBS. `depth` is local and actionable — it
   * is the metre of water you chose to put the float over, and it dominates,
   * because a read the player cannot act on is not a read. `along` is regional
   * and mild: a stable coordinate up the river derived from the world position
   * and the seed, worth at most about a third either way, which is enough to
   * make one stretch of one world the place for pike without ever overruling the
   * fact that you have cast into six inches of gravel.
   */
  _roll(rng, at, depth) {
    /**
     * More junk in the margins than in the trench, which is true of rivers and
     * is also the consolation prize for a lazy cast: the shallow water gives up
     * fewer good fish and more boots, and a boot is a better thing to be handed
     * than a minnow.
     */
    const shallow = 1 - clamp01(depth / 1.1);
    if (rng() < 0.1 + shallow * 0.12) {
      const index = Math.floor(rng() * CURIOSITIES.length) % CURIOSITIES.length;
      return { kind: 'curiosity', text: CURIOSITIES[index] };
    }

    const along = clamp01(
      (Math.sin(at.x * 0.0031 + hashString(this.seed) * 1e-8) * 0.5 + 0.5) * 0.6 +
        (Math.sin(at.z * 0.0027) * 0.5 + 0.5) * 0.4
    );

    let total = 0;
    const weights = SPECIES.map((s) => {
      const fit = Math.exp(-(((depth - s.deep) / s.spread) ** 2));
      // The regional term, deliberately weak. `s.deep / 1.3` reuses the depth
      // preference as a position up the reach so the table stays one row per
      // fish: the species that want deep water are also the ones that are
      // commoner downstream, which is the same statement twice and true.
      const region = 1 + (1 - Math.abs(along - s.deep / 1.3)) * 0.35;
      const w = s.weight * fit * region;
      total += w;
      return w;
    });
    let roll = rng() * total;
    let picked = SPECIES[0];
    for (let i = 0; i < SPECIES.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        picked = SPECIES[i];
        break;
      }
    }

    /**
     * Size is the cube of a uniform roll, which is what makes a big one worth
     * mentioning. A flat distribution gives you a medium fish nearly every time
     * and nothing to say about any of them; cubing it means most are small,
     * some are decent, and once an evening somebody gets something they will
     * tell you about.
     */
    const t = rng() ** 3;
    const cm = Math.round(picked.cm[0] + (picked.cm[1] - picked.cm[0]) * t);
    /**
     * How hard it pulls, folded down to one number here so the fight never has
     * to look at the table again.
     *
     * Both terms are needed and they are not the same. `t` is how big it is FOR
     * ITS KIND — a 9 cm minnow is a monster minnow — and the absolute length is
     * how much water it has to move. Without the second, a big minnow would
     * fight like a small pike; with only the second, every species of a given
     * length would feel identical and `fight` would do nothing.
     */
    const power = clamp01(picked.fight * (0.3 + 0.7 * t) * (0.35 + cm / 90));
    return { kind: 'fish', name: picked.name, cm, notable: t > 0.72, power, hue: picked.hue };
  }

  /* ---- the strike, the fight, and the two ways to lose ------------------- */

  _strike() {
    const got = this._catch;
    if (!got) {
      this.state = 'ready';
      return false;
    }

    this.sound?.('strike', this.float.position, 1);

    /**
     * A BOOT DOES NOT FIGHT, and that is worth a branch.
     *
     * Sending a horseshoe through the same run-and-tire machinery a trout goes
     * through would be the most obviously mechanical moment in the file — the
     * player would be leaning on a rod against a length of somebody else's line.
     * It comes up dead, immediately, and the change of rhythm is itself part of
     * why the curiosities are funny.
     */
    if (got.kind === 'curiosity') {
      this._land(got);
      return true;
    }

    const f = this._fish;
    f.x = this._target.x;
    f.z = this._target.z;
    f.power = got.power;
    f.stamina = 1;
    /**
     * A THIRD OF A SECOND OF SOLID WEIGHT BEFORE IT GOES.
     *
     * It used to bolt on the frame it was hooked, which is wrong twice. As a
     * beat it is worse — every angler knows the pause, the rod bending into
     * something that has not decided what to do yet, and it is the best moment
     * in the whole activity. And mechanically it was a trap: the strike is a key
     * press, a player whose finger is still on that key is winding, and winding
     * into a run at full stamina snaps the line. The first fish of the session
     * was punishing you for the press that caught it.
     */
    f.running = false;
    f.speed = 0;
    f.elapsed = 0;
    f.lastRun = false;
    f.runTimer = 0.35;
    // Straight away from you, which is what a hooked fish does and what makes
    // the first second of every fight the same recognisable event.
    f.angle = Math.atan2(f.z - this.controller.position.z, f.x - this.controller.position.x);

    this._tension = 0.45;
    this._overFor = 0;
    this._slackFor = 0;
    this._strainClock = 0;
    this._reelClick = 0;

    this.fish.material.color.setHex(got.hue);
    this.fish.scale.setScalar(got.cm / 100);
    this.fish.visible = true;
    this.state = 'playing';

    /**
     * The only line of tuition in the activity, and it is one sentence shown
     * once per session on the first fish that is actually capable of pulling
     * back. Anything smaller comes straight in and would teach the lesson with
     * no evidence for it.
     */
    if (!this._taught && got.power > 0.25) {
      this._taught = true;
      this.say('It runs. Hold <kbd>E</kbd> to wind, and turn against it.', 5000);
    } else {
      this.say(got.power > 0.55 ? 'Something heavy.' : 'On.', 1800);
    }
    return true;
  }

  /**
   * A RUN IS NEVER STRAIGHT ALONG THE LINE, and this one small function is what
   * makes the fight winnable at all.
   *
   * Side strain is measured from the angle the fish is being held off to, which
   * means it can only exist if the fish has some lateral motion. A run pointed
   * directly away from the rod has none — the bearing to it does not change, so
   * there is no side to lean on, so `counter` is zero no matter what the player
   * does, so the tension goes over and the line parts. Correct play was
   * IMPOSSIBLE in that geometry, and it was not a rare geometry: the forced run
   * at the net was hard-coded to go straight off, so the same fish that had been
   * played perfectly for eleven seconds broke off in the last two metres. That
   * is the worst possible bug for this feature to have — it punishes exactly the
   * player who was doing it right, at exactly the moment they were about to be
   * rewarded — and `fish-check.mjs` found it as an intermittent 3-in-5.
   *
   * The fix is also the truth: a hooked fish runs ACROSS the pull, not along it.
   * Anything within about 34° of the line, either toward you or away, is pushed
   * out to that angle. Nothing else about the heading changes.
   *
   * @param {number} angle the heading the run clock wanted
   * @param {number} line bearing from the rod to the fish
   */
  _across(angle, line) {
    const MIN_OFF = 0.6;
    const off = wrapAngle(angle - line);
    const sign = off < 0 ? -1 : 1;
    if (Math.abs(off) < MIN_OFF) return line + MIN_OFF * sign;
    if (Math.abs(off) > Math.PI - MIN_OFF) return line + (Math.PI - MIN_OFF) * sign;
    return angle;
  }

  /**
   * The fight, once per frame.
   *
   * Kept in one function and out of `update`'s pose block because it is the only
   * part of this file with state that can end badly, and because everything it
   * touches — tension, stamina, distance — is coupled: reading them in a
   * different order changes the outcome, and the order below is the order the
   * physical thing happens in.
   */
  _play(dt, tip) {
    const f = this._fish;
    const c = this.controller;
    const reeling = this.reeling;

    f.elapsed += dt;

    /* --- where it is, and which way that looks from here ------------------ */

    let dx = f.x - tip.x;
    let dz = f.z - tip.z;
    let distance = Math.hypot(dx, dz) || 1e-4;

    /**
     * THE LINE IS ONLY SO LONG, AND THIS IS THE ANSWER TO "YOU CAN JUST MOVE
     * WHEREVER".
     *
     * Everything else in the fight is about what the fish does. This is the one
     * paragraph about what YOU do with your feet, and until it existed the feet
     * were free: a player could walk backwards away from a hooked pike, or turn
     * round and jog into the trees, and the only consequence was that the two
     * ends of a stretchy white line got further apart.
     *
     * WHY THE EXCESS CAN ONLY BE THE PLAYER'S FAULT, which is what makes this
     * three lines instead of a bookkeeping problem. The fish's own movement is
     * paid for at the bottom of this function — whatever it takes, the reel gives
     * it, and `_lineOut` is brought up to the new distance on the same frame. So
     * by the time control gets back here, the only thing that can have moved
     * since is the rod tip, and the only thing that moves the rod tip is the
     * body carrying it.
     *
     * The fish is then dragged in by exactly the excess, which is a real and
     * legitimate way to help a fish along — anglers back up a bank all the time —
     * and it is priced at DRAG_TENSION per metre a second, so a careful step is
     * nearly free and a run is a snapped line. Nobody has to be told this rule.
     * You feel the rod load as you walk and you stop walking.
     */
    const over = distance - this._lineOut;
    if (over > 0) {
      const k = (distance - over) / distance;
      f.x = tip.x + dx * k;
      f.z = tip.z + dz * k;
      dx = f.x - tip.x;
      dz = f.z - tip.z;
      distance = Math.hypot(dx, dz) || 1e-4;
      this._dragLoad = (over / Math.max(dt, 1e-3)) * DRAG_TENSION;
    } else {
      this._dragLoad = damp(this._dragLoad ?? 0, 0, 0.02, dt);
    }

    const bearing = Math.atan2(dz, dx);

    /**
     * How fast the fish is crossing your view, as the rate the bearing to it is
     * turning. This is the quantity the counter-steer is measured against, and
     * it is a rate rather than a heading for one reason: WALKING COUNTS. Step
     * back up the bank and you have changed the angle without the fish doing
     * anything, and the rod feels it, exactly as it would.
     */
    const vx = f.running ? Math.cos(f.angle) * f.speed : 0;
    const vz = f.running ? Math.sin(f.angle) * f.speed : 0;
    const swing = (dx * vz - dz * vx) / (distance * distance);

    /**
     * Where the fish is relative to where you are looking, and the sign of it.
     *
     * Spelled out because getting it backwards is invisible in code and
     * infuriating in play. `forward` is (-sin y, -cos y), so the bearing you are
     * facing is exactly -yaw - π/2; a fish at a LARGER bearing than that is off
     * to your right. Increasing yaw swings the body toward -x, which with
     * right = +x is turning LEFT — and turning left leaves the fish further to
     * your right, so `rel` and `yaw` move together. No minus signs anywhere
     * below, and that is not luck, it is these two facts cancelling.
     */
    const rel = wrapAngle(bearing - (-c.yaw - Math.PI / 2));
    const side = Math.sign(swing) || 1;
    /**
     * Full strain when the fish is held a COUNTER_IDEAL angle off to the side it
     * is running toward, none when it is dead ahead or off the wrong side, and
     * none once it has gone past your shoulder.
     */
    const counter =
      f.running && Math.abs(rel) < COUNTER_ARC ? clamp01((rel * side) / COUNTER_IDEAL) : 0;
    /**
     * And the arrow, which is simply "which way to the right place". It goes
     * OUT when you are there, which is the part that makes it teach rather than
     * nag: the prompt stops talking the moment you have the rod where it should
     * be, so what you learn is the position and not the instruction.
     */
    const want = f.running ? side * COUNTER_IDEAL : 0;
    this.lean = !f.running || Math.abs(rel - want) < COUNTER_DEAD ? 0 : rel < want ? -1 : 1;
    /**
     * IS IT RUNNING, published separately from `lean`, and this is not tidiness.
     *
     * `lean` alone was ambiguous in the worst possible way: zero meant BOTH "the
     * fish is resting, go ahead and wind" and "the fish is running and you have
     * the rod exactly where it should be". Those are opposite instructions, and
     * the prompt was drawn from `lean` alone — so the moment a player got the
     * lean right, the screen told them to start winding, which is the one thing
     * that breaks the line. A player following the game's own advice perfectly
     * lost half the big fish they hooked, and it took a trace of the tension to
     * see it: full side strain, a rod at 1.05, and the prompt saying `wind`.
     *
     * With this the prompt has four states instead of three and the fourth one,
     * `hold it`, is the one that was missing.
     */
    this.surge = f.running;
    /**
     * Published, because it is the number the whole fight turns on and there is
     * no way to see it from outside otherwise — the rod's hoop shows the
     * TENSION, which is the consequence, and two different mistakes produce the
     * same hoop. `fish-check.mjs` reads it to work out which of them happened.
     */
    this.counter = counter;

    /* --- the run clock ---------------------------------------------------- */

    const rng = this._rng;
    f.runTimer -= dt;
    if (f.runTimer <= 0) {
      f.running = !f.running;
      if (f.running) {
        /**
         * A new heading, mostly along the channel.
         *
         * A fish that bolts across a ten-metre river is aground in two seconds,
         * and one that picks a uniformly random direction reads as a particle
         * rather than an animal. Up or down the current with a bias away from
         * whoever is holding it is both what actually happens and what keeps it
         * in the water without a clamp doing the work.
         */
        streamPointNear(f.x, f.z, _bank);
        const away = Math.atan2(f.z - this.controller.position.z, f.x - this.controller.position.x);
        const downstream = _bank.angle + (rng() < 0.5 ? 0 : Math.PI);
        f.angle = this._across(
          downstream + wrapAngle(away - downstream) * 0.35 + (rng() - 0.5) * 0.5,
          away
        );
        f.runTimer = (0.5 + rng() * 1.3) * (0.35 + f.stamina * 0.8);
      } else {
        /**
         * Rests get LONGER as it tires and runs get shorter, which is the whole
         * arc of a fight in two lines and is why nothing else has to script one.
         * The constants matter as much as the reel rate above: a fresh fish that
         * rests for half a second gives you no window to take line back in, and
         * the fight has no rhythm to read.
         */
        f.runTimer = (0.6 + rng() * 1.2) * (1.25 - f.stamina * 0.4);
      }
    }

    /**
     * THE LAST RUN AT THE NET, and it is the only scripted moment in the fight.
     *
     * A fish with anything left in it does not come quietly the first time it
     * sees the bank — and mechanically, without this, the end of every fight is
     * the safest part of it, because you have wound in most of the line and
     * nothing can happen in the last metre. One forced surge inside two metres
     * puts the danger where the reward is.
     */
    if (!f.lastRun && distance < 2.1 && f.stamina > 0.3) {
      f.lastRun = true;
      f.running = true;
      f.runTimer = 0.7 + rng() * 0.7;
      // Up or down the channel, NOT straight off — a fish at the bank turns.
      // It used to bolt radially, which was the single most reliable way to lose
      // a pike you were playing correctly; see `_across`.
      streamPointNear(f.x, f.z, _bank);
      f.angle = this._across(_bank.angle + (rng() < 0.5 ? 0 : Math.PI), bearing);
      this.sound?.('splash', this.float.position, 0.5 + f.power * 0.5);
    }

    f.speed = f.running ? RUN_M_S * f.power * (0.35 + 0.65 * f.stamina) : 0;
    const strain = f.running ? f.power * (0.35 + 0.65 * f.stamina) * (1 - 0.55 * counter) : 0;

    /* --- the line --------------------------------------------------------- */

    /**
     * Tension seeks a target rather than integrating a force, which is both
     * cheaper and the only version that is tunable by reading it.
     *
     * Every number below can be checked against a case by hand:
     *
     *   nothing happening, not winding      0.06  slack, and the hook works loose
     *   winding, no run                     0.40  the working tension, all day
     *   a big fish running, no counter      1.21  snapping in half a second
     *   the same run, countered             0.58  held
     *   the same run, countered AND wound   1.23  snapped anyway
     *
     * That last row is the whole rule of the fight and it falls out of the
     * arithmetic instead of being a special case: you may hold a run or you may
     * take line back, never both.
     */
    const target =
      0.06 + strain * 1.15 + (reeling ? 0.34 + strain * 0.55 : 0) + (this._dragLoad ?? 0);
    /**
     * 0.06 smoothing is about a third of a second to load the rod up, and the
     * number is a WARNING BUDGET rather than a feel. The line starts singing at
     * 0.8 and parts at 1.0 after SNAP_GRACE, so the interval between "you can
     * hear this going wrong" and "it has gone" is what this constant sets. At
     * the 0.02 it was first written with, a rod went from working tension to
     * snapped in a tenth of a second plus the grace — technically a warning, and
     * in practice a coin toss.
     */
    this._tension = damp(this._tension, target, 0.06, dt);

    if (this._tension > 1) {
      this._overFor += dt;
      if (this._overFor > SNAP_GRACE_S) {
        this.sound?.('snap', this.float.position, 1);
        this._lose('The line parts with a crack.', 'snap');
        return;
      }
    } else {
      this._overFor = Math.max(0, this._overFor - dt * 1.2);
    }

    /**
     * Doing neither thing is the way to lose a fish you had.
     *
     * Note what does NOT appear here: the tension. See SLACK_GRACE_S — a fish
     * loads and unloads the line all by itself as it runs and rests, so a timer
     * keyed on the tension could be kept alive for ever by the fish's own
     * behaviour while the player did nothing at all, which is exactly the bug
     * `fish-check.mjs` found. Winding or leaning is what keeps a hook in;
     * neither of them is what lets it out.
     */
    if (!reeling) {
      /**
       * Side strain slows this to a third but does not stop it, and that
       * asymmetry is the whole rule: leaning on a fish is how you survive a run,
       * winding is how you actually get it in, and a player who only ever does
       * the first eventually loses it. Without the asymmetry there was a
       * soft-lock — a fish running across you loads the rod sideways whether or
       * not you did anything about it, so somebody who simply stood still could
       * be held at twenty metres indefinitely, tiring a fish they were never
       * going to land. The check caught it as "1 still on" after ten seconds.
       *
       * The rates are set against the run clock rather than by feel: the longest
       * run a fresh fish can make is 2.07 s, which banks 0.72 s here, and the
       * shortest rest it can then take is 0.51 s, which pays back 0.77 s at the
       * recovery rate below. So correct play is always in credit, by
       * construction, and never by luck.
       */
      this._slackFor += dt * (f.running || counter > 0.3 ? 0.35 : 1);
      if (this._slackFor > SLACK_GRACE_S && f.stamina > 0.12) {
        this._lose('The line goes slack. The hook comes back empty.', 'slack');
        return;
      }
    } else {
      this._slackFor = Math.max(0, this._slackFor - dt * 1.5);
    }

    /* --- movement, and getting it in -------------------------------------- */

    if (f.running) {
      f.x += Math.cos(f.angle) * f.speed * dt;
      f.z += Math.sin(f.angle) * f.speed * dt;
      /**
       * Keep it in the channel by pushing it back onto the band and turning it
       * along the water, rather than by clamping the position — a clamp leaves
       * the fish grinding along an invisible wall, and this simply becomes a
       * fish that has found the bank and turned.
       */
      streamPointNear(f.x, f.z, _bank);
      const ox = f.x - _bank.x;
      const oz = f.z - _bank.z;
      const off = Math.hypot(ox, oz);
      if (off > CHANNEL_HALF_M) {
        const k = CHANNEL_HALF_M / off;
        f.x = _bank.x + ox * k;
        f.z = _bank.z + oz * k;
        f.angle = _bank.angle + (Math.cos(f.angle - _bank.angle) < 0 ? Math.PI : 0);
      }
    }

    if (reeling) {
      // Line comes back fast against nothing and barely at all against a surge,
      // which is the reason winding through a run is a losing move even when it
      // does not break anything.
      const gain = REEL_M_S * (1 - 0.78 * clamp01(strain)) * dt;
      dx = f.x - tip.x;
      dz = f.z - tip.z;
      distance = Math.hypot(dx, dz) || 1e-4;
      const k = Math.max(0, distance - gain) / distance;
      f.x = tip.x + dx * k;
      f.z = tip.z + dz * k;

      this._reelClick -= dt;
      if (this._reelClick <= 0) {
        this.sound?.('reel', this.float.position, 0.4 + this._tension * 0.6);
        // Clicks slow down when the fish is winning, which is a second, cheaper
        // readout of the same fact the rod is already showing.
        this._reelClick = 0.075 + clamp01(strain) * 0.16;
      }
    }

    /**
     * WHERE THE METRES GO, and these four lines are what keep the fight's tuning
     * bit-for-bit what it was while making the line a real quantity.
     *
     * The fish is authoritative about where it is: it swims where the run clock
     * sends it, the reel pulls it in at exactly the rate `REEL_M_S` always did,
     * and neither of those consults the spool. So the spool agrees with the
     * outcome — it pays out to cover whatever the fish took, and it comes in to
     * match whatever the reel gained. A drag that could CHECK a run would be the
     * more physical model and it would also be a new force in an equation that
     * took two rewrites and a check script to balance; the same clutch is
     * expressed in the sound and the rod's hoop, where it costs nothing.
     *
     * THE CAP IS NOT TIDINESS, IT IS A BUG THAT TOOK A WHOLE TEST ROW TO FIND.
     *
     * "Whatever the fish took" has to mean whatever the fish SWAM, and one thing
     * in this function moves a fish without swimming it: the channel clamp above
     * teleports it back onto the band. Walk twenty metres up the bank with one
     * on and every run ends with the clamp putting the fish back in the river —
     * a jump of many metres, which an uncapped spool paid out in full. So the
     * line grew without bound, the fish could never be brought in, and the fight
     * ran until the harness gave up: four bouts, thirty seconds each, "still on".
     *
     * Capped at the fish's own speed, the clamp can turn it and cannot lengthen
     * the line, and the excess is taken back by pulling the fish onto the
     * tether. That also restores the invariant the drag rule at the top of this
     * function depends on: when control arrives there, distance is exactly
     * `_lineOut`, so any excess can only be the rod tip having moved.
     */
    dx = f.x - tip.x;
    dz = f.z - tip.z;
    distance = Math.hypot(dx, dz) || 1e-4;
    const maxOut = this._lineOut + f.speed * dt + 1e-3;
    if (distance > maxOut) {
      const k = maxOut / distance;
      f.x = tip.x + dx * k;
      f.z = tip.z + dz * k;
      distance = maxOut;
    }
    this._lineOut = distance;

    /**
     * Stamina, and the two things that spend it.
     *
     * Side strain is worth five times what merely holding on is, which is the
     * mechanical statement of why the counter-steer exists — a player who only
     * winds will still land it eventually, and a player who leans on it will
     * land it in a third of the time. The `elapsed` term is a guarantee rather
     * than a feel: it makes the drain accelerate slowly so no combination of
     * inputs can produce a fight that never ends.
     */
    const denom = 0.3 + f.power * 0.9;
    f.stamina = Math.max(
      0,
      f.stamina -
        (dt * (0.014 + 0.06 * counter * (f.running ? 1 : 0) + (reeling ? 0.025 : 0) + f.elapsed * 0.0022)) /
          denom
    );

    dx = f.x - tip.x;
    dz = f.z - tip.z;
    distance = Math.hypot(dx, dz);
    /**
     * How beaten it has to be before you can lift it out, and it scales with how
     * big it is rather than being a constant.
     *
     * A constant was a real bug in feel rather than in logic: at a flat 0.35 a
     * perch had to be played to exhaustion exactly like a pike, which made every
     * fish the same ten seconds and threw away the size roll all over again — the
     * thing this rewrite exists to fix. Something small comes in green, because
     * something small can simply be lifted; a big one has to be finished. The
     * measured result is a minnow in two seconds and a 96 cm pike in thirteen.
     */
    if (distance < LANDING_M && f.stamina < 0.3 + (1 - f.power) * 0.5) {
      this._land(this._catch);
      return;
    }

    /**
     * The line singing. Sparse ticks that climb in pitch and rate with the load,
     * rather than a held tone — a continuous voice would need to be started and
     * stopped across the module boundary and would be one more thing that can be
     * left running when a tab is hidden. Above 0.8 you can hear it going.
     */
    if (this._tension > 0.8) {
      this._strainClock -= dt;
      if (this._strainClock <= 0) {
        this.sound?.('strain', this.float.position, clamp01((this._tension - 0.8) / 0.25));
        this._strainClock = 0.24 - clamp01(this._tension - 0.8) * 0.5;
      }
    }
  }

  /**
   * Off. Both ways of losing come through here, because the interesting part is
   * the same in both cases and it is not the failure — it is that the room hears
   * about it. A snapped line is a better thing to tell somebody than a roach.
   */
  _lose(line, why = 'off') {
    const got = this._catch;
    this.lost += 1;
    /**
     * Which way it went, as a tag rather than as the sentence.
     *
     * `fish-check.mjs` reads it to report the distribution of failures, and that
     * is not a testing convenience — the balance of this fight is entirely a
     * question of whether the two ways to lose are BOTH reachable and neither is
     * dominant, and a run that says "five lost" tells you nothing while a run
     * that says "five snapped, none slack" tells you the slack rule is dead
     * code. Every tuning decision below the strike was made by reading this.
     */
    this.lastLoss = why;
    this.state = 'ready';
    this._catch = null;
    this.fish.visible = false;
    this.lean = 0;
    this.surge = false;
    this._tension = 0;
    this._dragLoad = 0;
    /**
     * The line comes back with nothing on it, and it comes back SHORT — a parted
     * line is a parted line, and the rig is somewhere in the river. Mechanically
     * this is what puts the float back at the tip on the next frame rather than
     * leaving it fifteen metres out on a line attached to nothing.
     */
    this._lineOut = REST_LINE_M;
    this.say(line, 4600);
    if (got?.kind === 'fish' && got.power > 0.45) {
      this.announce?.(`lost something big — it was on for ${Math.round(this._fish.elapsed)}s`);
    }
  }

  /**
   * IT COMES OUT OF THE WATER AND LIES ON THE GRASS, and this is the payoff the
   * whole activity was missing.
   *
   * Until now the last frame of a fight was the fish vanishing and a line of
   * text appearing that said what it had been. Every part of the catch that a
   * player actually cares about — how big it turned out to be, what colour it
   * is, the fact that it is a real object and not a number — was in a mesh that
   * had spent the fight thirty centimetres under an opaque surface and was
   * switched off at the exact moment it could finally be seen.
   *
   * So it is unhooked onto the bank at your feet, at its real length, and it
   * lies there kicking for a few seconds before it goes back. Nothing about the
   * mechanics changed: the same book entry, the same toast, the same
   * announcement. `BEACH_S` later, or on any input, it is slipped back in and
   * the rod is `ready` again.
   *
   * WHY IT GOES BACK ON ITS OWN. Because the alternative is an inventory, and
   * the header of this file is one long argument that an inventory would delete
   * the specification. A fish you keep is a fish you have to be able to look at
   * later, count, and eventually do something with.
   */
  _land(got) {
    this._catch = null;
    this.lean = 0;
    this.surge = false;
    this._tension = 0;
    this._dragLoad = 0;
    this._lineOut = REST_LINE_M;
    if (!got) {
      this.state = 'ready';
      this.fish.visible = false;
      return false;
    }

    this.book.unshift(got);
    if (this.book.length > 40) this.book.pop();

    if (got.kind === 'curiosity') {
      /**
       * A boot does not flop about, and there is no mesh for one. It is a line
       * of text and the change of rhythm is the joke — see the branch in
       * `_strike` that sends it straight here without a fight.
       */
      this.state = 'ready';
      this.fish.visible = false;
      this.say(`You land ${got.text}.`, 6000);
      this.announce?.(`fished up ${got.text.replace(/<[^>]+>/g, '')}`);
      this.sound?.('splash', this.float.position, 0.5);
      return true;
    }

    this.sound?.('splash', this.float.position, 0.4 + got.power * 0.8);

    /**
     * On the ground, a metre and a half in front of the body and slightly to the
     * rod side, which is where a landed fish ends up because that is where the
     * hand that unhooked it was.
     *
     * ONE `heightAt`, on the frame a fish is landed. The bank is not flat and a
     * fish lying at WATER_LEVEL on a metre-high bank would be buried to its
     * dorsal; the alternative — the ground mesh — is not authoritative here (see
     * terrain.js on the body walking the analytic field rather than the mesh).
     */
    const c = this.controller;
    const fwd = c.forward(_v);
    /**
     * 1.9 m, and the number is the neck rather than the arm. At the metre and a
     * half a person actually unhooks a fish at, looking at it from an eye 1.68 m
     * up means pitching down about 48° — past the bottom of a 60° frame, so the
     * catch was on the ground behind the player's own chin. Two metres brings it
     * into an ordinary downward glance.
     */
    const bx = c.position.x + fwd.x * 1.9 - fwd.z * 0.35;
    const bz = c.position.z + fwd.z * 1.9 + fwd.x * 0.35;
    this._beachX = bx;
    this._beachZ = bz;
    /**
     * `groundUnder`, not `heightAt`, and then half a fish's width on top.
     *
     * Two mistakes were in the one line this replaces and the first photograph
     * of a landed pike had both. `heightAt` is a point sample of a field the
     * rendered ground only approximates on a grid, so on any slope the mesh in
     * front of you is above it — `groundUnder` is the same average the body's
     * own feet stand on, which is by definition the surface you can see.
     *
     * And the fish is lying on its SIDE (see the roll in `update`), so what has
     * to clear the ground is its half-WIDTH, which the geometry puts at 0.085 of
     * its length. At 4 cm a 96 cm pike was buried to its lateral line and read
     * as a leaf.
     */
    this._beachY = groundUnder(bx, bz) + 0.09 * (got.cm / 100) + 0.02;
    this._beachYaw = Math.atan2(fwd.z, fwd.x) + Math.PI / 2;
    this._beached = BEACH_S;
    this._beachPhase = 0;
    this.state = 'landed';
    this.fish.visible = true;

    const line = got.notable
      ? `A ${got.name}. ${got.cm} cm — a good one.`
      : `A ${got.name}, ${got.cm} cm.`;
    this.say(line, 4600);
    this.announce?.(`landed a ${got.name}, ${got.cm} cm`);
    return true;
  }

  /**
   * Back it goes.
   *
   * Called by the clock in `update`, or early by any input — because a player
   * who has looked at it and is ready to cast again should not have to wait for
   * a fish to finish being admired.
   */
  _slipBack() {
    if (this.state !== 'landed') return false;
    this.state = 'ready';
    this.fish.visible = false;
    this._beached = 0;
    _where.x = this._beachX;
    _where.y = WATER_LEVEL;
    _where.z = this._beachZ;
    this.sound?.('splash', _where, 0.35);
    // And the shoal knows about it, which is the last thing a fish going back in
    // does: everything nearby leaves.
    this.disturb?.(this._beachX, this._beachZ, 4, 0.6);
    return true;
  }

  /** How many of what, for the roster panel. */
  tally() {
    const counts = new Map();
    for (const entry of this.book) {
      if (entry.kind !== 'fish') continue;
      counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]);
  }

  /**
   * Put the rod where the hand is, bend it, and work out where the tip ended up.
   *
   * PULLED OUT OF `update` BECAUSE THE THROW NEEDS IT TOO, and needs it on a
   * frame that has not run yet. The tackle leaves from the ROD TIP, which is a
   * point that depends on the yaw, the pitch, the bend and the swing — so a
   * `_throw` that used last frame's tip would launch from wherever the rod was
   * before the whip started, and one called before the first `update` of a
   * session (which is exactly what `fish-check.mjs` does, and what any script
   * driving the rod does) would launch from the world origin.
   *
   * @param {number} bend 0..1, the hoop
   * @param {number} lean radians the rod is swung toward the fish
   * @returns {THREE.Vector3} the tip, in `this._tip`. Reused; do not keep it.
   */
  _poseRod(bend, lean) {
    const c = this.controller;
    /**
     * The rod is held out to the right of the body at chest height and angled
     * up, positioned from the CONTROLLER rather than from the camera.
     *
     * The camera is up to 1.35 m of trip dolly away from the body and swings
     * around it as you turn — `main.js` says so where it explains why the sun's
     * shadow anchor moved off the camera. A rod pinned to the camera would
     * therefore slide away from its owner during a trip, and the tell would be
     * that the line stretches. Pinned to the body, it stays in the hand and the
     * camera drifts around it, which is what is actually happening to you.
     */
    const yaw = c.yaw;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = -fz;
    const rz = fx;

    this.rod.position.set(
      c.position.x + fx * 0.34 + rx * 0.36,
      c.position.y - 0.42,
      c.position.z + fz * 0.34 + rz * 0.36
    );
    this.rod.rotation.set(0, 0, 0);
    this.rod.rotateY(yaw);
    /**
     * The BUTT barely moves — a fifth of a radian across the whole range —
     * because a person playing a fish plants the rod's handle and holds it
     * there. All the drama is in the top section below. Getting this the other
     * way round was what made a loaded rod look like a dropped one.
     *
     * `_swing` is the exception and it is the only one: winding up for a cast is
     * the one moment the whole rod goes somewhere, back over the shoulder and
     * then through. Positive is back, negative is the follow-through — see the
     * spring in `update`.
     */
    this.rod.rotateX(-1.02 - bend * 0.2 + c.pitch * 0.25 + this._swing);
    this.rod.rotateZ(0.34 - lean);
    // And the hoop: most of a right angle at breaking strain.
    const hoop = bend * 1.15;
    this.ferrule.rotation.x = -hoop;

    /**
     * The tip, in the butt's own frame, worked out rather than read back.
     *
     * `ferrule.matrixWorld` would be the obvious source and it is a frame stale
     * — Three updates world matrices at render time, which is after this runs,
     * so the line would trail the rod by 16 ms during exactly the moments it is
     * moving fastest. Rotating (0,1,0) about X by -hoop gives (0, cos, -sin),
     * which is two trig calls and is exact on the frame it is wanted.
     */
    return this._tip
      .set(0, FERRULE_M + TOP_M * Math.cos(hoop), -TOP_M * Math.sin(hoop))
      .applyQuaternion(this.rod.quaternion)
      .add(this.rod.position);
  }

  /** @param {number} dt */
  update(dt) {
    if (this.state === 'off') return;

    const c = this.controller;
    const playing = this.state === 'playing';
    const loading = this.state === 'loading';

    this._bobPhase += dt;

    /**
     * THE WIND-UP AND THE WHIP, as a spring rather than as a curve.
     *
     * Loading damps the rod back over the shoulder — a position, held for as
     * long as you hold the button, so the amount of it IS the readout for how
     * far this cast is going to go and there is nothing to draw on the glass.
     * Releasing kicks the spring the other way and lets it ring down, which is
     * a follow-through: the rod goes past straight, comes back, and settles.
     *
     * `dt` is clamped for the integration and only for it. The spring is stiff
     * enough (ω ≈ 13 rad/s) that a 100 ms frame — which swiftshader produces all
     * day — would step past the stable region and throw the rod off its own
     * hinge. Clamping the step makes a slow machine's whip slightly slower in
     * wall-clock, which nobody can see, instead of unstable, which everybody
     * can.
     */
    const sdt = Math.min(dt, 1 / 30);
    if (loading) {
      this.power = Math.min(1, this.power + dt / LOAD_S);
      this._swing = damp(this._swing, 0.16 + this.power * 0.92, 0.02, dt);
      this._swingVel = 0;
    } else if (this._swing !== 0 || this._swingVel !== 0) {
      this._swingVel += (-180 * this._swing - 16 * this._swingVel) * sdt;
      this._swing += this._swingVel * sdt;
      if (Math.abs(this._swing) < 1e-3 && Math.abs(this._swingVel) < 1e-3) {
        this._swing = 0;
        this._swingVel = 0;
      }
    }

    /**
     * THE READOUT IS THE TACKLE.
     *
     * There is no meter, no bar and no arrow, because this project's rule about
     * the glass (see `hud.js`) forbids one and because a rod is a better
     * instrument than a rectangle anyway — it is calibrated in the only unit the
     * player cares about, which is "how close is this to going wrong".
     *
     *   THE HOOP. `bend` is the tension, straight through. At the working
     *   tension the rod has a pleasant curve in it; at 1.0 it is bent double and
     *   you can see that from any angle, in any light, without reading anything.
     *
     *   THE LEAN. The rod also swings toward the fish, so it points where the
     *   trouble is. That is what makes "turn against the run" legible as a
     *   physical act rather than a key: you are watching the rod come across
     *   your view and you are pulling it back.
     */
    const bend = playing
      ? this._tension
      : this.state === 'bite'
        ? 0.32 + 0.16 * Math.sin(this._bobPhase * 19)
        : loading
          ? this.power * 0.28
          : 0;
    let lean = 0;
    if (playing) {
      const bearing = Math.atan2(this._fish.z - c.position.z, this._fish.x - c.position.x);
      lean = clamp(wrapAngle(bearing - (-c.yaw - Math.PI / 2)), -1.1, 1.1) * this._tension * 0.5;
    }
    const tip = this._poseRod(bend, lean);

    /* ---- the clock, before the float is placed, so a state change shows on
     * the same frame it happens rather than one late. ---------------------- */

    if (this.state === 'flight') {
      /**
       * IN THE AIR: ballistics, air, and the end of the spool.
       *
       * Drag is applied to the velocity rather than as a force, which for a
       * flight this short is the same curve and cannot go unstable at any frame
       * time — a 100 ms step on swiftshader through an acceleration-based drag
       * term would reverse the tackle mid-air.
       */
      this._flightFor += dt;
      const fly = this._fly;
      fly.vy -= GRAVITY * dt;
      const keep = Math.max(0, 1 - AIR_DRAG * dt);
      fly.vx *= keep;
      fly.vy *= keep;
      fly.vz *= keep;
      fly.x += fly.vx * dt;
      fly.y += fly.vy * dt;
      fly.z += fly.vz * dt;

      /**
       * THE SPOOL RUNNING OUT, which is the one thing the line does to a cast in
       * the air and is the reason a rod cannot throw for ever. Past MAX_LINE_M
       * the tackle is on the end of its tether: the position is pulled back onto
       * the sphere and the OUTWARD part of its velocity is taken away with it,
       * so it stops going and starts falling, which is exactly what an overrun
       * looks like from the bank.
       */
      let dx = fly.x - tip.x;
      let dy = fly.y - tip.y;
      let dz = fly.z - tip.z;
      let reach = Math.hypot(dx, dy, dz) || 1e-4;
      if (reach > MAX_LINE_M) {
        const k = MAX_LINE_M / reach;
        fly.x = tip.x + dx * k;
        fly.y = tip.y + dy * k;
        fly.z = tip.z + dz * k;
        dx *= k;
        dy *= k;
        dz *= k;
        reach = MAX_LINE_M;
        const radial = (fly.vx * dx + fly.vy * dy + fly.vz * dz) / reach;
        if (radial > 0) {
          fly.vx -= (radial * dx) / reach;
          fly.vy -= (radial * dy) / reach;
          fly.vz -= (radial * dz) / reach;
        }
      }
      /**
       * A little more line than the straight distance, so the drawn rope carries
       * a trailing belly instead of being a taut wire. That belly is the tell
       * that this is line coming off a reel rather than a rod firing a dart.
       */
      this._lineOut = Math.min(MAX_LINE_M, Math.max(REST_LINE_M, reach * 1.05));

      /**
       * And has it arrived. This is the only `heightAt` in a frame loop in this
       * file: bounded by the length of a throw, sixty or seventy calls, once per
       * cast. There is no cheaper answer that is not wrong — the tackle has to
       * know when it has landed, the bank is not flat, and the water is only the
       * answer where there IS water, so `max(WATER_LEVEL, bed)` is one query
       * that covers both and gets the far bank right where a plane test does
       * not.
       *
       * Four seconds is not a hedge, it is the answer to a throw that leaves the
       * world: lobbed off a ridge over a gully, the tackle can be falling for a
       * long time, and a rod stuck in `flight` would need `F` to recover.
       */
      const surface = Math.max(WATER_LEVEL, heightAt(fly.x, fly.z));
      if (fly.y <= surface || this._flightFor > 4) {
        // The belly the arc paid out, wound back to something like a fished
        // line: everything above a cast's length came off the spool going up.
        this._lineOut = Math.min(this._lineOut, reach * 1.1 + 0.4);
        this._settle(fly.x, fly.z);
      }
    } else if (this.state === 'waiting' && !this._dry) {
      this._elapsed += dt;
      // The next scheduled knock, if its moment has arrived. One comparison a
      // frame against a list that is never longer than three.
      if (this._knocks.length > 0 && this._elapsed >= this._knocks[0]) {
        this._knockUntil = this._knocks.shift() + KNOCK_S;
        this.sound?.('knock', this._target, 0.5);
      }
      this._timer -= dt;
      if (this._timer <= 0) {
        this.state = 'bite';
        this._timer = STRIKE_WINDOW_S;
        this.say('<b>—</b>', 1400);
        this.sound?.('bite', this._target, 1);
      }
    } else if (this.state === 'bite') {
      this._timer -= dt;
      if (this._timer <= 0) {
        this.state = 'ready';
        this._catch = null;
        this.say('Whatever it was, it has gone.');
      }
    } else if (playing) {
      this._play(dt, tip);
    } else if (this.state === 'landed') {
      this._beached -= dt;
      this._beachPhase += dt;
      if (this._beached <= 0) this._slipBack();
    }

    /* ---- what is on the end of the line, and where the line goes -------- */

    const knocking = this._elapsed < this._knockUntil;
    /**
     * `end` is the difference between a thing the world is carrying and a thing
     * the rope is. Null means the far node is free and gravity owns it — the
     * float dangling off the tip, and the tackle in the air. Anything else is a
     * position somebody more authoritative has already decided: a float sat on
     * the water, or a fish being fought. See `Rope.step`.
     */
    let end = null;
    let floor = -1e9;
    /**
     * Is the float sitting on water — which is the only state in which it stands
     * upright. Everything else it is hanging off a line or flying through the
     * air, and it points along that line. A bobber nose-up in mid-flight was the
     * one thing that gave away that the old cast was a slide rather than a
     * throw.
     */
    const onWater = playing || this.state === 'waiting' || this.state === 'bite';

    if (this.state === 'flight') {
      // Pinned to the particle. `_lineOut` was set alongside it in the clock
      // block above, so the chain is very slightly longer than the span and
      // hangs the trailing belly a cast has.
      this._end.x = this._fly.x;
      this._end.y = this._fly.y;
      this._end.z = this._fly.z;
      end = this._end;
    } else if (playing) {
      const f = this._fish;
      const surge = f.running ? Math.sin(this._bobPhase * 13) * 0.03 * f.power : 0;
      /**
       * On: the float is wherever the fish has dragged it, and how far UNDER the
       * surface it is riding is the tension again. Nothing about the fight is
       * shown in only one place — the rod, the line's sag and the float's depth
       * all say the same thing, so whichever one you happen to be looking at is
       * the one that tells you.
       *
       * 0.16 rather than 0.3, and the float is 0.17 tall — so at breaking strain
       * its top sits a centimetre under and at the working tension a third of it
       * is showing. Pulled fully under it simply vanished into an opaque
       * surface, which turns a readout into an absence: the line went into the
       * water and there was nothing at the end of it.
       */
      this._end.x = f.x;
      this._end.y = WATER_LEVEL + 0.06 - this._tension * 0.16 + surge;
      this._end.z = f.z;
      end = this._end;
      floor = WATER_LEVEL;
      this.float.rotation.set(this._tension * 1.1, 0, surge * 6);
    } else if (this.state === 'waiting' || this.state === 'bite') {
      /**
       * Cast, and waiting. Two components — a slow swell that every float in the
       * river shares, and a fast tremble that only a fish makes. Keeping them
       * separate is what makes a bite legible: the moment the second one starts,
       * the float is doing something the water is not.
       *
       * The knock is deliberately built from the SWELL and not from the tremble.
       * It is one shallow push, it never inverts the float, and it is over
       * before the eye has finished arriving — which is exactly the shape of the
       * thing that should not be struck at, and is nothing at all like the take
       * below it, which pulls the float under and holds it there.
       */
      const dry = this._dry;
      const swell = dry ? 0 : Math.sin(this._bobPhase * 1.9 + this._target.x) * 0.022;
      let dip = 0;
      let shake = 0;
      if (knocking) {
        const k = clamp01((this._knockUntil - this._elapsed) / KNOCK_S);
        dip = Math.sin(k * Math.PI) * 0.055;
      } else if (this.state === 'bite') {
        dip = 0.12 + Math.sin(this._bobPhase * 21) * 0.03;
        shake = Math.sin(this._bobPhase * 17) * 0.5;
      }
      if (!dry) this._drift(dt, tip);
      this._end.x = this._target.x;
      this._end.y = (dry ? this._target.y : WATER_LEVEL + 0.06) + swell - dip;
      this._end.z = this._target.z;
      end = this._end;
      floor = this._floorY;
      this.float.rotation.set(shake * 0.7, 0, dry ? 1.4 : swell * 4 + shake * 0.4);
    } else {
      /**
       * Nothing out: the float hangs off the tip and swings, and it swings
       * because the rope is being dragged about by a rod on the end of a walking
       * body rather than because anything here animated it. This is the state
       * people spend the most time in, it is what "standing about holding a rod"
       * looks like, and it used to be two sine waves.
       */
      this._lineOut = damp(this._lineOut, REST_LINE_M, 0.001, dt);
    }

    this._rope.step(dt, tip, this._lineOut, floor, end, 0);

    /**
     * The float IS the last node, in every state, which is the simplification
     * the rope bought: there is no longer a float position and a line drawn to
     * it that could disagree.
     */
    const ex = this._rope.endX();
    const ey = this._rope.endY();
    const ez = this._rope.endZ();
    this.float.position.set(ex, ey, ez);
    if (!onWater) {
      const i = ROPE_NODES - 1;
      _v.set(this._rope.x[i - 1] - ex, this._rope.y[i - 1] - ey, this._rope.z[i - 1] - ez);
      if (_v.lengthSq() > 1e-8) this.float.quaternion.setFromUnitVectors(_up, _v.normalize());
    }

    if (this.state === 'landed') {
      /**
       * ON THE GRASS, ON ITS SIDE, KICKING.
       *
       * Rolled a quarter turn about its own length so it is lying rather than
       * standing — a fish out of water that is still the right way up reads as a
       * fish swimming through a field. The kicks are a decaying beat: hard and
       * frequent for the first second, down to the odd twitch by the last. It is
       * three sines and a falling envelope, and it is the difference between an
       * animal and a prop.
       */
      const t = 1 - clamp01(this._beached / BEACH_S);
      const life = (1 - t) ** 1.6;
      const beat = Math.sin(this._beachPhase * 13) * Math.sin(this._beachPhase * 2.3);
      const kick = beat * life;
      this.fish.position.set(
        this._beachX,
        this._beachY + Math.abs(kick) * 0.07,
        this._beachZ
      );
      this.fish.rotation.set(
        Math.PI / 2 + kick * 0.5,
        this._beachYaw + kick * 0.35,
        Math.sin(this._beachPhase * 5) * 0.06 * life
      );
    } else if (playing) {
      /**
       * The fish, just under the surface, nose-first along its own heading.
       *
       * It rides deeper while it is fresh and comes up as it tires, so the last
       * few seconds of a good fight are the first sight of what you have — which
       * is the actual reward and the reason this mesh exists.
       *
       * THE NUMBERS ARE SET SO THAT IT ACTUALLY BREAKS THE SURFACE, and the
       * first pass did not. The water is a `transparent` shader but from a bank
       * it is nearly all sky reflection — which is exactly what water looks like
       * at a grazing angle and is not a thing to fight — so a fish riding twenty
       * centimetres down is not "dimly visible", it is invisible. At 0.05 plus a
       * fifth of the stamina, a beaten fish's back is out of the water: half a
       * metre of pike rolling on the surface in the last three seconds, which is
       * the shot this mesh exists for, and nothing at all before then. Which is
       * also how it goes.
       */
      const f = this._fish;
      const under = 0.05 + f.stamina * 0.2 - (f.running ? 0.03 : 0);
      this.fish.position.set(f.x, WATER_LEVEL - under, f.z);
      this.fish.rotation.set(
        f.running ? Math.sin(this._bobPhase * 9) * 0.12 : Math.sin(this._bobPhase * 2.2) * 0.05,
        -f.angle,
        Math.sin(this._bobPhase * (f.running ? 11 : 3)) * (0.16 + f.power * 0.2)
      );
    }

    /* ---- the line, which is now simply the rope, drawn ------------------- */

    const pos = this.line.geometry.attributes.position;
    for (let i = 0; i < ROPE_NODES; i++) {
      pos.setXYZ(i, this._rope.x[i], this._rope.y[i], this._rope.z[i]);
    }
    pos.needsUpdate = true;
    this.line.geometry.computeBoundingSphere();
    // A tight line catches the light. Free, and it is the readout that survives
    // being looked at from directly along the line, where the sag is edge-on.
    this.line.material.opacity = playing ? 0.45 + clamp01(this._tension) * 0.45 : 0.55;
  }

  /**
   * THE SWING, which is what a float on a river actually does and what this
   * activity had no way to express.
   *
   * A float is not a marker on a map. It is on moving water, tethered to a fixed
   * point, so it goes downstream until the line comes tight and then arcs across
   * the current toward your own bank — and after half a minute of that it is out
   * of the water you chose and you wind in and throw it again. That loop is what
   * fishing a swim IS, and the whole of it falls out of two forces: the current
   * pushing, and `_lineOut` refusing to lengthen.
   *
   * It also quietly answers the thing that made standing on a bank feel like
   * standing in a photograph: walk away from your own float now and you drag it,
   * because the same tether is between you and it.
   *
   * The bed is re-sampled only when the float has moved most of a metre from
   * wherever it was last looked at — the swing can take it out of the channel
   * onto the gravel, and a float lying in six inches of water is a dry cast that
   * has to say so.
   */
  _drift(dt, tip) {
    const t = this._target;
    streamPointNear(t.x, t.z, _bank);
    t.x += Math.cos(_bank.angle) * CURRENT_M_S * dt;
    t.z += Math.sin(_bank.angle) * CURRENT_M_S * dt;

    // Winding in, on the right button. `E` is not read here: its press already
    // means "reel in, now" in this state — see `act` — and a key that both
    // finishes the cast instantly and retrieves it gradually is a key that does
    // neither.
    if (this._winding) {
      this._lineOut = Math.max(REST_LINE_M, this._lineOut - RETRIEVE_M_S * dt);
      this._reelClick -= dt;
      if (this._reelClick <= 0) {
        this.sound?.('reel', this.float.position, 0.3);
        this._reelClick = 0.11;
      }
    }

    const dx = t.x - tip.x;
    const dz = t.z - tip.z;
    const flat = Math.hypot(dx, dz);
    /**
     * The tether. `_lineOut` is a length in three dimensions and this is a pull
     * in two, so the vertical drop from the tip is taken out of the budget first
     * — otherwise a float directly below a rod tip two metres up would be held
     * two metres away from the bank by a line that is not tight at all.
     */
    const drop = Math.max(0, tip.y - t.y);
    const room = Math.sqrt(Math.max(0.04, this._lineOut * this._lineOut - drop * drop));
    if (flat > room) {
      const k = room / flat;
      t.x = tip.x + dx * k;
      t.z = tip.z + dz * k;
    }

    if (this._winding && flat < 1.1 && this._lineOut <= REST_LINE_M + 0.05) {
      this.state = 'ready';
      this._catch = null;
      this.say('You wind it back in.');
      return;
    }

    if (Math.hypot(t.x - this._sampledX, t.z - this._sampledZ) > 0.9) {
      this._sampledX = t.x;
      this._sampledZ = t.z;
      const bed = heightAt(t.x, t.z);
      if (WATER_LEVEL - bed < MIN_DEPTH_M) {
        this._dry = true;
        this._catch = null;
        // Same reasoning as in `_settle`: the floor is for the middle of the
        // rope, which is over the channel however shallow the far end has got.
        this._floorY = Math.min(bed + 0.04, WATER_LEVEL);
        t.y = bed + 0.06;
        this.say('The float swings in and grounds in the shallows.');
      }
    }
  }

  dispose() {
    for (const g of Object.values(this._geo)) g.dispose();
    this._fishGeo.dispose();
    this.woodMaterial.dispose();
    this.fish.material.dispose();
    this.float.material.dispose();
    this.floatTip.material.dispose();
    this.line.geometry.dispose();
    this.line.material.dispose();
    this.group.removeFromParent();
  }
}
