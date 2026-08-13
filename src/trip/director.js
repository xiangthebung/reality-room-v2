import * as THREE from 'three';
import { clamp01, damp } from '../core/util.js';
import { worldClock } from '../core/world-clock.js';
import { TripState } from './state.js';
import { tripUniforms } from './living.js';

/**
 * The director.
 *
 * One place where "how far into the trip am I" becomes every number the rest of
 * the app needs. Nothing downstream knows about phases: the materials get a
 * glow amount, the pipeline gets a displacement in metres, the audio gets an
 * intensity, and the camera gets an offset.
 *
 * THE CEILINGS BELOW ARE THE DESIGN. Each is the point past which the effect
 * stops reading as altered perception and starts reading as a broken renderer,
 * and they were set by walking across the clearing at each value rather than by
 * looking at a still frame. A peak that makes a still image impressive and the
 * forest unnavigable is the wrong peak — people on mushrooms walk around, look
 * at things and point them out to each other.
 */

/**
 * Self-luminous light in the surfaces: the moss patches on the forest floor,
 * the canopy pulse, the mineral veins in the caves, the glow along a deer's
 * coat. Every one of them is BROAD — a patch, a wave, a region — which is what
 * is left after the filament network came out on 2026-08-11.
 *
 * DOWN FROM 0.95, AND THAT WAS THE FIRST HALF OF THE ANSWER TO "I don't like
 * the oil contours". Every iteration of that complaint came back to the same
 * element: bright curved lines, in a colour the surface is not, drawn densely
 * on something with curvature. Deleting the contour rings, warm-capping the
 * colour, narrowing the threshold and elongating the network along the grain
 * each helped and none was the whole answer; dropping the ceiling to 0.6 helped
 * most, because at 0.95 a filament reached the top of the exposure on a surface
 * sitting at a tenth of it. The second half of the answer was that the lines
 * themselves had to go.
 *
 * The ceiling STAYS at 0.6 after that removal rather than being given back. The
 * terms it still feeds were each tuned as accents against this number, and
 * raising it now would not restore anything — it would just make the moss and
 * the canopy louder than they were ever asked to be.
 */
const MAX_GLOW = 0.6;
/** White balance shift. Past a third, greens go khaki and the world reads sepia. */
const MAX_WARMTH = 0.26;
/**
 * UP, BECAUSE THE SATURATION BECAME A VIBRANCE AND A VIBRANCE ROLLS OFF.
 *
 * `living.js` divides this by (1 + chroma² · 2.6) per pixel, so on the muted
 * greens and browns that are most of this world — chroma around a third — about
 * three quarters of it survives, and on anything already near the edge of the
 * gamut about a third does. 0.9 therefore lands where 0.7 used to on the
 * surfaces that should deepen, and well below it on the ones that used to clip
 * into electric lilac. Depth is the reported effect and clipping was the
 * artefact; this raises the first while removing the second.
 */
const MAX_SAT = 0.9;
/**
 * The luminous contour on the silhouette of things. See the rim block in
 * `living.js` — this is a Fresnel band on the surface, not an outline found in
 * the frame, which is why it is allowed to be as strong as it is.
 */
const MAX_RIM = 0.34;
/**
 * Vertical exaggeration of distant terrain. "The hills got bigger."
 *
 * DOWN FROM 0.42 on the play-test that reported trees disappearing. The
 * mechanism was this term and the structural fix is in living.js — the lift is
 * measured from your own feet now and soft-limited to 2.5 m, so it cannot bury
 * anything whatever this number is. This is the taste half of the same report:
 * "it also needs to be slightly dampened".
 */
const MAX_HILLS = 0.3;
/**
 * Metres of surface breathing along the normal.
 *
 * DOUBLED, AND THE MOTION IT BUYS IS MORE THAN DOUBLE, because the breath
 * became a travelling phase rather than a signed amplitude on a global sine —
 * see the breath block in living.js. The old form's typical excursion was 0.18
 * of this number and its worst case was 0.66 of it; the new one is 0.71 typical
 * and exactly 1.0 worst. So the number you actually see went up by a factor of
 * eight, and the number check-plants.mjs polices went up by three.
 *
 * That is affordable only because the lean stopped being applied to grass,
 * which freed 41% of the tightest budget in the project. The two changes are a
 * pair; putting this number back without that one fails the check.
 *
 * PULLED BACK FROM 0.5 AFTER PLAY-TEST. At 0.5 the report was that trees were
 * disappearing, and they were — see the thickness taper in living.js, which is
 * the real fix. This is the belt to its braces: the taper stops a branch
 * inverting, and a smaller ceiling means the thick wood that is still allowed
 * the full amount swells by a quarter of a metre rather than a third, which is
 * a tree breathing rather than a tree inflating. The typical motion is
 * unaffected by either change, because the factor of four that made this
 * visible at all came from the wave form, not from the ceiling.
 */
const MAX_BREATH = 0.32;

/**
 * THE MORPH GROUP — the surface moving while the object stays put.
 *
 * These are the ceilings on the things people describe first and most
 * consistently, and which this project had almost none of: not the world being
 * distorted, but the world's SKIN being alive. They are separate from the melt
 * because they are the opposite kind of effect. The melt moves geometry, so its
 * ceiling is set by how far a trunk can move before the renderer looks broken.
 * These move nothing at all, so they can arrive early, run all the way through,
 * and be pushed much harder without ever costing the world its solidity.
 */

/**
 * Metres the detail domain swells and relaxes.
 *
 * Reads as amplitude divided by feature size, so the same number is a dramatic
 * swelling of the bark fibre and a barely perceptible one of the hillside — the
 * fine structure heaves while the shape of the world holds still, which is
 * exactly the reported asymmetry.
 */
/**
 * RAISED, AND IT IS THE CHEAPEST MOTION IN THE PROJECT.
 *
 * This one moves no geometry at all — it warps the domain the surface detail is
 * evaluated in — so it is invisible to check-plants.mjs, cannot push a leaf
 * card past its own feathered border, and cannot make a trunk intersect
 * anything. It is also the effect the reports describe FIRST: the wall stays
 * where it is and its texture swells.
 *
 * It was being held back by something other than risk. Multiplied by `uBreath`,
 * one number for the world, the whole visible surface of the forest swelled and
 * relaxed on one clock — and a global pulse at any amplitude reads as the image
 * being scaled rather than as ten thousand surfaces each alive. It reads as a
 * far larger effect on the travelling phase at the same amplitude, which is
 * what let this go up rather than down.
 */
const MAX_SWELL = 0.32;
/** Metres of steady domain drift: grain flowing through the wood. */
const MAX_CREEP = 0.15;
/**
 * Emergent detail, 0..1. Pushes the distance at which fine structure survives.
 *
 * The cheapest big effect in the file. Nothing is added to the world; the world
 * simply stops being compressed, which is what people are reporting when they
 * say the carpet turned into grass turned into forests.
 */
const MAX_DETAIL = 1;
/**
 * MAX_ORDER / uOrder WAS HERE AND IS GONE — 2026-08-11.
 *
 * It drove how densely the surface's filament network branched: first contour
 * rings, then a third filament family built from the difference of the two
 * vein fields. The whole network was removed for reading as unrealistic, and
 * this was its only consumer, so it went with it. See the tombstone in
 * FRAGMENT_BODY in trip/living.js.
 *
 * What still makes a surface acquire structure as the trip deepens is uDetail —
 * the emergent-detail term above, which pushes the distance at which the wood's
 * OWN grain, fissures and relief survive. That is the version of "it organises
 * itself" that survived, and it was always the better one: nothing is added to
 * the surface, the surface simply stops being compressed.
 */
/**
 * WHAT A SURGE ADDS ON TOP OF THE PLATEAU.
 *
 * The plateau ceilings above are the answer to "how far can this run for two
 * minutes without the forest becoming unnavigable". That is the right question
 * for a plateau and the wrong one for an event: the reports are emphatic that
 * the strong material arrives in waves a few seconds long, and something you
 * only have to live inside for four seconds can go a great deal further than
 * something you have to walk through for two minutes.
 *
 * So each of these is added to its ceiling at the crest of a surge and is gone
 * again by the trough. They are fractions of the corresponding MAX_ above, and
 * several of them take the total past 1 deliberately — that is the point.
 */
const SURGE_GLOW = 0.6;
const SURGE_SWELL = 1.3;
const SURGE_SAT = 0.3;
const SURGE_RIM = 0.75;
const SURGE_PULSE = 1.0;
const SURGE_FLOW = 0.35;

/**
 * WHAT EGO DEATH DOES TO A SURFACE — chosen 2026-08-11 after shooting all four
 * candidates side by side, and the reason for each number is the reason it is
 * not one of the other three.
 *
 * `swarm` at FULL, because it is the effect: the wood comes apart into the
 * light that was lighting it, thresholded on a continuous fbm so there is no
 * cell anywhere. It is the direct replacement for the deleted dither and the
 * only candidate that does what the dither was for. At 1 rather than at the
 * 0.85 the panel's preset used, because the thing that made the dither read as
 * a mosaic was its lattice and not its strength — with the lattice gone there
 * is no reason to hold the amplitude back, and holding it back only makes the
 * phase's one surface effect tentative.
 *
 * `unedge` at HALF, and half is the whole point of the number. At 1 the rim
 * goes to nothing and objects stop having silhouettes entirely, which reads as
 * flat rather than as dissolving — the peak's signature effect simply switched
 * off, and an effect that switches off announces that it was an effect. At 0.5
 * the outlines are still there and no longer reliable, which is the percept:
 * edges you can find if you look for them and that stop doing the work of
 * telling one tree from the next. It also leaves the surge's own contribution
 * to the rim intact, so an arriving wave still momentarily restores the edges
 * it is dissolving.
 *
 * `fade` and `unlight` at ZERO, and both are deliberate omissions rather than
 * defaults nobody got to. fade is the quiet reading and it is genuinely good,
 * but stacked under a full swarm it takes the contrast the swarm needs to be
 * legible — the two are alternatives, not layers. unlight is out for the
 * measured reason in living.js: the output pass's ACES pulls anything lifted
 * toward grey, so it beiges the wood, and no tuning inside the block reaches a
 * tone curve applied after it.
 *
 * `probe.reset()` restores this rather than zeroing, for the same reason it
 * restores gains to 1 and not to 0: reset means the shipping look.
 */
export const EGO_DEFAULT = { fade: 0, unedge: 0.5, unlight: 0, swarm: 1 };
/** Metres the canopy inflates as a pulse of light crosses it. */
const MAX_PULSE = 0.42;
/** Wind amplification. 1 is the sober forest. */
const MAX_SWAY = 2.15;
/**
 * How far the canopy bows toward you, as a multiple of the plant's own reach.
 *
 * Dimensionless, not metres. It used to be metres, which meant the number tuned
 * against a fifteen-metre oak was also applied to a fifty-centimetre tuft of
 * grass — and 0.85 m of lean on a 0.5 m blade is not a lean, it is a spike
 * pointing at the camera. See `setPlantScale` in living.js.
 */
const MAX_LEAN = 0.95;
/**
 * Metres of world-space flow: the melt.
 *
 * This used to be a displacement in a depth-buffer post-process. It is now a
 * displacement of the actual vertices — see uFlow in living.js — because a
 * bounded screen-space resample reads as a pane of glass in front of whatever
 * it displaces, and people saw panes around the trunks. The number is larger
 * than the old one because a metre of geometry moving is a great deal less
 * violent than a metre of image sliding.
 *
 * UP BY 19%, out of the same slack the lean gate freed. The ceiling on this is
 * not taste, it is the grass: the melt is the third-largest term in the tightest
 * displacement budget in the project, and every metre of it costs 0.45 of aScale
 * on every plant in the world. See check-plants.mjs for what the four terms
 * actually add up to now.
 *
 * 1.45 first, then 1.25 on the play-test that pulled the breath down, then 1.7
 * on the one that asked for more melt — the second report separated the two
 * families, which the first had not: the MOTION family (breath, sway, lean,
 * hills) moves objects and was what made trees disappear, and the melt bends
 * the world without ever removing any of it. So they now go in opposite
 * directions. Unlike the breath this one cannot make anything vanish — it
 * translates a whole neighbourhood rather than pushing a surface along its own
 * normal — so what a too-large value costs is legibility rather than geometry:
 * past about here a trunk stops reading as a trunk that is moving and starts
 * reading as a trunk that is the wrong shape.
 */
const MAX_FLOW = 1.7;
/**
 * How much of the smeared history survives.
 *
 * Low, and it has to be. Trails are the effect that most readily turns into a
 * second image of the world, and a second image of the world is double vision —
 * which is both the thing people say they *don't* experience and the thing that
 * most reliably makes an effect read as a broken renderer.
 */
const MAX_TRAIL = 0.26;
/**
 * THE VIEW BREATH, as a fraction of the frame. See uViewWarp in living.js.
 *
 * 1.6% of the frame is about 23 px at 1440p, against a field whose features are
 * half a screen across — so it is a swell you can watch cross the picture, not
 * a shimmer. The ceiling is low for a reason that is not performance: this is
 * the only term in the project that moves the IMAGE, and a coherent expansion
 * of the whole visual field is the most nausea-capable thing here. Past about
 * 3% it also stops reading as the room breathing and starts reading as a lens,
 * because the displacement becomes comparable to the parallax between near and
 * far things and the eye notices that the two are moving together.
 *
 * It is also the number that sets the inward crop in the output shader —
 * exactly twice this, so 3.2% of the frame's width is never shown at the peak.
 */
const MAX_VIEW_WARP = 0.016;
/** What a surge adds on top, as a fraction of the ceiling. */
const SURGE_VIEW = 0.45;

/**
 * THE VIEW BREATH STANDS DOWN WHILE YOU MOVE, and this is a design statement
 * rather than a mitigation.
 *
 * WHY IT HAS TO. Every other family here is attached to geometry, so it survives
 * any camera motion for free: a trunk that is bending is bending wherever you
 * stand. The view breath is attached to the IMAGE, and an image-space field can
 * only stay with the world if it knows how far away every pixel is. Rotation is
 * fine without that — a turn is a pure angular remap and the field's domain is
 * angular, so it comes out exact. Translation is not, and cannot be: the field
 * sits at one distance (RR_VIEW_SHELL, fitted to this wood) and everything
 * nearer or further slides against it. Measured at 4.5% of the frame per metre
 * walked, which at a walking pace is a fifth of the picture a second. That is
 * seen, and it was: reported as noticing the effect when moving forward in a
 * straight line while turning had stopped showing it.
 *
 * The only way to make it hold under translation is a depth buffer, and a
 * depth-keyed offset is bounded, and a bounded offset draws a seam at every
 * silhouette. That is the melt, and the melt is why this file's whole approach
 * exists. So the mismatch is not fixable; it is avoidable.
 *
 * WHY IT SHOULD ANYWAY. The reports this effect comes from are of a room
 * breathing while somebody looks at it. Standing the picture down when the
 * picture is streaming past costs nothing anybody described, and it puts the
 * view breath on the same principle as the stare — the world gives you more
 * when you hold still, which this project already does with uDwell.
 */
/** At or below this the picture counts as held still. m/s. */
const VIEW_STILL = 0.5;
/** At or above this the view breath is at its floor. Half a walk (WALK = 4.4). */
const VIEW_MOVING = 2.2;
/**
 * What survives at a walk. Not zero: an effect that switches off announces that
 * it was an effect, and at 15% of 1.6% of the frame this is three pixels at
 * 1280 — present enough to keep the transition from being an edge, far below
 * anything that can be read as a pattern sliding over the wood.
 */
const VIEW_MOVING_FLOOR = 0.15;
/** Seconds to fade either way. Slow enough that a footstep cannot flicker it. */
const VIEW_SETTLE = 0.9;
/**
 * Further than this in one frame is a TELEPORT, not a speed.
 *
 * Spawning, a debug seek, and every `arrive` in the perf harness move the camera
 * tens of metres between two updates. Read as a velocity that is thousands of
 * metres a second, which would stand the effect down for a second afterwards —
 * so the perf rig would measure a damped effect and report it as cheap, and a
 * player would find the wood stopped breathing every time the world recentred.
 */
const VIEW_TELEPORT = 3;

/**
 * How far into the frame the bright-pass reaches, in threshold units.
 *
 * Lowering the bloom threshold rather than raising the bloom AMOUNT is the
 * difference between "the picture is glarier" and the reported thing: a
 * highlight on a wet leaf that was a white dot flares into something with a
 * size, and a gap of sky in the canopy stops having an edge. What changes is
 * which parts of the world count as a light source, which is a property of a
 * pupil that will not close, and pupils are the one thing in this project that
 * genuinely do live on the glass.
 */
const MAX_BLOOM_LIFT = 0.2;

/** Camera. All small, and all slower than a second. */
const MAX_FOV_DRIFT = 8.5; // degrees
const MAX_ROLL = 0.07; // radians
const MAX_SWAY_M = 0.11; // metres, lateral
/**
 * Metres the camera slides along its own view axis.
 *
 * Field of view and camera translation are both depth cues, and normally they
 * agree. Change one and the brain reads a zoom — a property of the lens. Change
 * them together, in opposition, and it reads the room itself as changing shape,
 * because no rigid room can produce that pair of signals at once. That is the
 * dolly zoom, and it is the technique film uses for exactly the sensation being
 * described when people say mushrooms wreck their depth perception.
 *
 * The camera moves without the body, so collision and interaction range are
 * untouched. The amplitude is bounded by how far the camera may stray from the
 * collision capsule before it can poke through a trunk the body is standing
 * against.
 */
const MAX_DOLLY = 1.35;

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _gaze = new THREE.Vector3();

/**
 * HOW LONG A GAZE HAS TO BE HELD BEFORE THE WORLD ANSWERS, in seconds.
 *
 * Slow on purpose. The reports are not about glancing — they are about having
 * been looking at something for a while and noticing it has been getting more
 * detailed for some time before you registered it. Anything under a couple of
 * seconds reads as a cursor.
 */
const DWELL_RISE = 3.4;
/**
 * And how fast it collapses when you look elsewhere. Much faster than it
 * charges, which is the asymmetry the effect lives on: the reports are
 * unanimous that it goes the moment attention breaks.
 */
const DWELL_FALL = 0.45;
/**
 * How far the head may drift and still count as the same gaze.
 *
 * GAZE_TURN IS A DOT-PRODUCT SLACK AND NOT AN ANGLE, and the difference is a
 * factor of five. The test is dot > 1 - slack, so the half-angle it admits is
 * acos(1 - slack) — for small angles slack ≈ θ²/2, not θ. 0.06 was written as
 * "about three and a half degrees" and is in fact TWENTY, which is most of a
 * viewport: the charge never collapsed because scanning the wood never left the
 * cone. Measured directly, swinging the head ±17° for four seconds, and uDwell
 * climbed monotonically to 0.98 throughout.
 *
 * 0.003 is 4.4°, which is about the width of the fovea and comfortably outside
 * the sub-degree jitter of a hand on a mouse.
 */
const GAZE_MOVE = 0.55; // metres
const GAZE_TURN = 0.003; // dot slack — 4.4 degrees, see above

export class Director {
  constructor({ pipeline, atmosphere, audio, jukebox, camera }) {
    this.state = new TripState();
    this.pipeline = pipeline;
    this.atmosphere = atmosphere;
    this.audio = audio;
    this.jukebox = jukebox;
    this.camera = camera;

    /** Eased trip level, so nothing snaps when the debug panel seeks. */
    this.eased = 0;
    /** Decays after a trip ends, so effects retire instead of vanishing. */
    this.fade = 0;
    /** The surge, after the level curve and the debug gain. For the panel. */
    this.surge = 0;
    this._fov = camera.fov;
    this._baseFov = camera.fov;
    this._roll = 0;
    this._dolly = 0;
    this._sway = new THREE.Vector3();
    this._wobblePhase = 0;
    /** The frozen gaze ray and how long it has been held. See _updateGaze. */
    this._gazeFrom = new THREE.Vector3();
    this._gazeDir = new THREE.Vector3(0, 0, -1);
    this._dwell = 0;
    /**
     * How still the picture is, 0..1, and where it was last frame. Drives the
     * view breath only — see the VIEW_STILL block above.
     */
    this._lastEye = new THREE.Vector3();
    this._eyeSeen = false;
    this._stillness = 1;

    /** Debug switches. Each disables one family of effects. */
    this.switches = {
      world: true,
      melt: true,
      morph: true,
      view: true,
      camera: true,
      colour: true,
      audio: true,
    };

    /**
     * Debug multipliers on the ceilings above.
     *
     * Separate from the switches because the useful question during tuning is
     * almost never "is this effect on" but "is this effect too much" — and the
     * only honest way to answer it is to walk around with the number in your
     * hand.
     */
    this.gain = { glow: 1, colour: 1, motion: 1, melt: 1, morph: 1, view: 1, camera: 1, surge: 1 };

    /**
     * WHAT EGO DEATH DOES TO A SURFACE, and why it is not in `gain`.
     *
     * A gain is a multiplier on a ceiling that already exists: at 1 you get the
     * designed effect and the number is there so you can ask whether it is too
     * much. These are not that. They are four independent TREATMENTS sharing
     * one slot — the slot the quantised dither left when it was deleted on
     * 2026-08-11 for reading as a lattice of blocks — and what ships is a
     * chosen combination of them rather than all of them at some amplitude.
     * That is also why they get their own object: `probe.reset()` walks `gain`
     * setting every key to 1, which here would switch all four on at once.
     *
     *   fade     the near world takes the colour of the air in it: boundaries
     *            fail, local contrast collapses, the wood stops being a set of
     *            things standing in space. Cheapest of the four.
     *   unedge   uRim fades out as the dissolve rises, so objects lose their
     *            outlines. Free — it is a multiply on a uniform written below —
     *            and it is the only one that works by SUBTRACTION.
     *   unlight  every pixel is pushed toward one luminance, keeping its hue,
     *            so surfaces stop having lit and shaded sides.
     *   swarm    the direct replacement for the dither: keep the bright, drop
     *            the rest, but thresholding a continuous field instead of a
     *            quantised one so there is no cell to see.
     *
     * CHOSEN, AFTER SHOOTING ALL FOUR: half the outline loss, all of the swarm.
     * See EGO_DEFAULT below for what that pair is doing and what it leaves out.
     */
    this.ego = { ...EGO_DEFAULT };

    // `_fogColour` and `_tmp` lived here to serve the fog hue offset in
    // `_applyColour`, which computed a colour every frame and assigned it to
    // nothing. Both went with it; see the note there for why the tint was
    // deleted rather than wired up.
  }

  get level() {
    return this.eased;
  }

  get phase() {
    return this.state.phase;
  }

  eat(seed) {
    if (this.state.active) this.state.redose();
    else this.state.begin(seed ?? `trip-${Math.floor(Math.random() * 1e9)}`);
    this.audio?.begin(this.state.seed);
    return this.state.phase;
  }

  ground() {
    if (!this.state.active && this.state.override === null) return false;
    this.state.end();
    this.audio?.end();
    return true;
  }

  get paused() {
    return this.state.paused;
  }

  /**
   * Debug: stop the trip where it is and leave everything else running.
   *
   * See the field in `state.js` for what does and does not stop. Pausing while
   * nothing is running is a no-op rather than an implied `eat`: the panel's
   * button says so instead, because a debug control that quietly starts a trip
   * is a control that has changed the thing you were about to measure.
   */
  pause(on = true) {
    this.state.paused = Boolean(on) && this.state.active;
    return this.state.paused;
  }

  /** Debug: jump to a phase boundary or an arbitrary time. */
  seek(seconds) {
    const wasActive = this.state.active;
    this.state.seek(seconds);
    if (!wasActive) this.audio?.begin(this.state.seed);
    // Skipping forward should land you *at* that intensity rather than easing
    // toward it over ten seconds, which is the whole point of a debug seek.
    this.eased = this.state.level;
    this.fade = 1;
    return this.state.phase;
  }

  update(dt, { camera, audioLevels }) {
    const state = this.state;
    state.update(dt);

    /**
     * THE WORLD'S CLOCK, WHICH IS NOT THIS TRIP'S CLOCK.
     *
     * `uTime` reaches every material in the game through the injected block in
     * living.js: the river's wave trains, the cloud and aurora scroll, the
     * campfire flicker, the mist. None of that is a trip effect — it runs for a
     * sober player in an empty wood — and all of it has to agree between two
     * people standing in the same clearing, which `state.clock` could not
     * deliver because it counts from whenever this tab happened to load.
     *
     * `state.clock` is still right here for everything that IS this trip: the
     * breath phase below, the surges, the drone, the fog drift and the camera
     * dolly. Those are one person's, and a second player must not be able to
     * shift them. See core/world-clock.js.
     */
    tripUniforms.uTime.value = worldClock();
    tripUniforms.uEye.value.copy(camera.position);
    if (audioLevels) tripUniforms.uAudio.value.copy(audioLevels);
    /**
     * Measured HERE, at the top, and that is what makes it the body's speed
     * rather than the trip's.
     *
     * The real loop seats the camera on the body and only then lets
     * `_updateCamera` offset it, so at this point in the frame `camera.position`
     * is the clean body pose with none of the dolly, roll or sway on it. Reading
     * it after would fold the trip's own camera family into the number, and the
     * view breath would then stand itself down in response to a motion the trip
     * had just invented — a feedback loop between two effects that have no
     * business knowing about each other.
     */
    this._updateStillness(dt, camera);

    /**
     * The level is eased on the way up and the way down, but with very
     * different constants. Coming up is slow — that is what a come-up is.
     * Coming down after `N` is fast but not instant: an effect that vanishes on
     * a frame boundary announces that it was an effect.
     */
    const target = state.active || state.override !== null ? state.level : 0;
    const rising = target > this.eased;
    this.eased = damp(this.eased, target, rising ? 0.35 : 0.02, dt);
    this.fade = damp(this.fade, target > 0.001 ? 1 : 0, 0.05, dt);
    const L = clamp01(this.eased);
    const dissolve = clamp01(state.dissolve) * this.fade;

    tripUniforms.uLevel.value = this.switches.world ? L : 0;
    tripUniforms.uDissolve.value = this.switches.world ? dissolve : 0;

    /**
     * The three ego-death treatments that live in the fragment shader, each
     * already multiplied by the dissolve curve so the shader has nothing to
     * decide. The fourth, `unedge`, is applied to uRim where that is written.
     *
     * Gated on the world switch through `dissolve` above, so turning the world
     * off takes these with it — the panel's `world` button is documented as the
     * one that zeroes uLevel and uDissolve and skips every shader effect, and a
     * term that survived it would make that caption a lie.
     */
    const ego = tripUniforms.uDissolve.value;
    tripUniforms.uEgo.value.set(
      this.ego.fade * ego,
      this.ego.unlight * ego,
      this.ego.swarm * ego
    );

    /**
     * ---- the surge ---------------------------------------------------------
     *
     * `L^2.6` and not `L`, so this is a peak phenomenon and nothing else. At
     * half intensity it contributes a tenth of itself, which is right: the
     * come-up is the world stopping being still, and the plateau is where waves
     * start arriving. It also means the ceilings raised above are what a person
     * walking around at 0.5 experiences, and none of the surge amplitudes have
     * any bearing on whether the middle of the trip is navigable.
     */
    const surge = this.switches.world
      ? clamp01(state.surge) * Math.pow(L, 2.6) * this.gain.surge
      : 0;
    this.surge = surge;
    tripUniforms.uSurge.value = surge;

    // ---- the world ---------------------------------------------------------
    // Breathing is driven by the state's own slow wave rather than by a second
    // oscillator, so the surfaces, the audio's breath layer and the camera all
    // inhale together. Three systems on one clock reads as one event.
    const motion = this.gain.motion;
    tripUniforms.uBreath.value = state.breath;
    tripUniforms.uBreathPhase.value = state.breathPhase;
    tripUniforms.uBreathAmp.value =
      MAX_BREATH * L * (0.55 + 0.45 * Math.abs(state.wave)) * motion;
    tripUniforms.uSway.value = 1 + (MAX_SWAY - 1) * L * motion;
    tripUniforms.uHills.value = MAX_HILLS * L * (0.65 + 0.35 * state.breath) * motion;
    tripUniforms.uLean.value = MAX_LEAN * L * motion;

    /**
     * ---- the morph -------------------------------------------------------
     *
     * ORDERED THE OPPOSITE WAY ROUND FROM THE MELT, DELIBERATELY.
     *
     * The melt is held back until 20% because geometry distortion with nothing
     * else going on reads as a bug. These are the effects that make the *rest*
     * of it legible, so they have to be there first: at 10% intensity the only
     * thing happening in the world should be that surfaces have stopped holding
     * perfectly still, which is what the come-up is. Swell therefore starts at
     * zero intensity on a curve that is steep at the bottom, and the flow and
     * the organising follow it in.
     */
    const morph = (this.switches.morph ? 1 : 0) * this.gain.morph;
    tripUniforms.uSwell.value = MAX_SWELL * (Math.pow(L, 0.7) + SURGE_SWELL * surge) * morph;
    tripUniforms.uCreep.value = MAX_CREEP * clamp01((L - 0.1) / 0.9) * morph;
    tripUniforms.uDetail.value = MAX_DETAIL * Math.pow(L, 0.8) * morph;
    // The canopy pulse rides the breath, so the wave crossing the wood and the
    // trunks swelling underneath it are one event rather than two.
    tripUniforms.uPulse.value =
      MAX_PULSE *
      (clamp01((L - 0.08) / 0.92) * (0.6 + 0.4 * state.breath) + SURGE_PULSE * surge) *
      morph;

    const colour = (this.switches.colour ? 1 : 0) * this.gain.colour;
    tripUniforms.uGlow.value =
      MAX_GLOW * (Math.pow(L, 1.35) + SURGE_GLOW * surge) * this.gain.glow * (colour > 0 ? 1 : 0);
    tripUniforms.uWarmth.value = MAX_WARMTH * L * colour;
    tripUniforms.uSat.value = MAX_SAT * (L + SURGE_SAT * surge) * colour;
    /**
     * The contour arrives with the rest of the peak rather than with the
     * come-up. An outline on everything at 20% is the effect that most readily
     * reads as a rendering mode being switched on, because at that intensity
     * nothing else in the frame is strange enough to explain it.
     */
    /**
     * …AND THEN EGO DEATH TAKES IT AWAY AGAIN, if `ego.unedge` is up.
     *
     * The fourth candidate treatment, and the only one that is a subtraction.
     * The rim is what makes an object's silhouette a thing in its own right;
     * fading it out as the dissolve rises is objects losing their outlines, so
     * the wood stops separating into things and becomes one surface. It is the
     * cheapest of the four by a distance — this multiply, and nothing else —
     * and it is the one that makes the phase read as a CHANGE rather than as
     * more of the peak, because it runs the peak's own signature effect
     * backwards.
     *
     * Applied after the curve rather than folded into `colour`, so switching
     * the colour family off still switches the rim off outright and this cannot
     * resurrect it.
     */
    tripUniforms.uRim.value =
      MAX_RIM *
      (Math.pow(clamp01((L - 0.25) / 0.75), 1.5) + SURGE_RIM * surge) *
      colour *
      (1 - clamp01(this.ego.unedge * ego));

    /**
     * Melt arrives late and the wake later still.
     *
     * The come-up should be almost entirely about colour, light and the world
     * moving — the things people describe first. Geometry distortion at 20%
     * intensity just looks like a bug in the renderer, because there is not
     * enough of anything else happening to explain it.
     */
    const meltCurve = clamp01((L - 0.2) / 0.8);
    tripUniforms.uFlow.value = this.switches.melt
      ? MAX_FLOW * (Math.pow(meltCurve, 1.4) + SURGE_FLOW * surge) * this.gain.melt
      : 0;

    /**
     * ---- the view breath ---------------------------------------------------
     *
     * ARRIVES WITH THE MELT, NOT WITH THE SWELL, and later than either.
     *
     * The morph group is first because surfaces that have stopped holding still
     * is what the come-up is. This one is last because it is the only effect
     * that moves the PICTURE, and a picture that moves before anything in the
     * world does is unattributable — there is nothing on screen strange enough
     * to explain it, so it reads as the display being wrong. By 35% the trunks
     * are already bending and the grain is already flowing, and the whole view
     * joining in is then the same event getting larger, which is what it should
     * feel like.
     *
     * The basis this field is evaluated in is written further down, AFTER
     * _updateCamera — see the note there.
     */
    const view = (this.switches.view ? 1 : 0) * this.gain.view;
    /**
     * The stillness factor multiplies LAST, after the switch and the gain, so
     * that turning the debug gain up to look at the effect does not also
     * override the stand-down and hand you the artefact it exists to prevent.
     */
    tripUniforms.uViewWarp.value =
      MAX_VIEW_WARP *
      (Math.pow(clamp01((L - 0.35) / 0.65), 1.3) + SURGE_VIEW * surge) *
      view *
      (VIEW_MOVING_FLOOR + (1 - VIEW_MOVING_FLOOR) * this._stillness);

    // ---- the pass ----------------------------------------------------------
    this.pipeline.setTripParameters({
      trail: this.switches.melt
        ? MAX_TRAIL * clamp01((L - 0.45) / 0.55) * (1 + 0.7 * surge) * this.gain.melt
        : 0,
      bloomLift: MAX_BLOOM_LIFT * (Math.pow(L, 1.2) + 0.5 * surge) * (colour > 0 ? 1 : 0),
    });

    // ---- attention ---------------------------------------------------------
    this._updateGaze(dt, camera, L * morph);

    // ---- light and air -----------------------------------------------------
    this._updateAtmosphere(dt, L, dissolve, surge);

    // ---- the camera --------------------------------------------------------
    if (this.switches.camera) this._updateCamera(dt, camera, L, dissolve, state);
    else {
      camera.fov = this._baseFov;
      camera.updateProjectionMatrix();
    }

    /**
     * The view breath's basis, and it has to be read HERE.
     *
     * The field is a function of the world direction each pixel looks along, so
     * it needs the camera's rotation and the half-angles of its frustum — and
     * it needs the ones this frame will actually be DRAWN with. _updateCamera
     * just moved both: it drifts the fov and adds the wobble to the rotation.
     * Reading them before it would key the field to last frame's frustum, and
     * the field would then slide by a fraction of a degree every frame in time
     * with the fov drift, which is a slow crawl across the whole picture from a
     * cause nobody would think to look for.
     */
    if (tripUniforms.uViewWarp.value > 0) {
      camera.updateMatrixWorld();
      tripUniforms.uViewRot.value.setFromMatrix4(camera.matrixWorld);
      const t = Math.tan((camera.fov * Math.PI) / 360);
      tripUniforms.uViewTan.value.set(t * camera.aspect, t);
    }

    // ---- audio -------------------------------------------------------------
    if (this.audio && this.switches.audio) {
      this.audio.update(dt, {
        intensity: L,
        dissolve,
        breath: state.breath,
        phase: state.phase.id,
        /**
         * The same attack detector the shaders read for their flicker — see
         * `sampleLevels` in audio/engine.js. Passing it here is what lets the
         * reverb bloom answer the SOUND that caused it rather than a clock of
         * its own, so the tail swelling and the light lifting are one event.
         */
        transient: tripUniforms.uAudio.value.w,
      });
    } else if (this.audio) {
      /**
       * THE SWITCH OFF IS AN UPDATE AT ZERO, NOT A SKIPPED UPDATE.
       *
       * This branch used to not exist, and while the trip was purely additive
       * that was survivable: flicking the switch mid-trip simply froze the drone
       * and the reverb wherever they happened to be, which is wrong but is
       * audibly wrong and goes away at the end of the trip.
       *
       * It stopped being survivable when the trip started turning things DOWN.
       * `trip-audio.js` now ducks and low-passes the whole world through the
       * engine's `recede` insert, and those nodes belong to the engine and
       * outlive any trip. Skipping the call would leave the wood permanently
       * dark with the audio switch reading OFF — an effect that is not running,
       * still running.
       *
       * Driving it at zero instead retires every layer through the same ramps
       * the comedown uses, which is also what a debug switch should have done
       * from the start.
       */
      this.audio.update(dt, { intensity: 0, dissolve: 0, breath: state.breath, phase: '', transient: 0 });
    }

    /**
     * The record drags.
     *
     * Tempo down and tuning flat, both proportional to level. This is the most
     * recognisable audio symptom there is and it is only available because the
     * jukebox synthesises its notes — a streamed file could be slowed, but not
     * without also dropping its pitch by the same amount, which sounds like a
     * broken tape rather than like time behaving strangely.
     */
    if (this.jukebox && this.switches.audio) {
      this.jukebox.tempoScale = 1 - 0.13 * L - 0.06 * dissolve;
      this.jukebox.detune = -14 * L + Math.sin(state.clock * 0.11) * 9 * L;
    } else if (this.jukebox) {
      this.jukebox.tempoScale = 1;
      this.jukebox.detune = 0;
    }
  }

  /**
   * THE STARE.
   *
   * "Add extra texture to the object you're looking at if you stare at it" is
   * an attention effect, and attention is the one axis nothing in this project
   * was a function of. The reports are consistent and specific: drifting,
   * texture repetition, emergent detail and pareidolia all intensify while the
   * gaze is held on a particular object and reset the moment it refocuses.
   *
   * WHY A FROZEN RAY AND NOT THE LIVE ONE. The obvious implementation is to key
   * detail to the current view direction, and that is a screen-space vignette:
   * a smudge of extra texture permanently in the middle of the frame, which is
   * stuck to the glass and reads as such within seconds. Freezing the ray at
   * the moment the head settles makes it a property of a PLACE — the detail
   * grows on that piece of bark, stays on it while you keep looking, is still
   * on it if you glance away and back inside half a second, and decays where it
   * is rather than following your eye.
   *
   * WHY NO RAYCAST. Finding what is actually under the crosshair means testing
   * against a hundred thousand instanced trunks and cards every frame, and it
   * buys nothing: the shader tests a CONE about the ray, whose radius grows
   * with distance, so whatever the ray passes near is included at the depth it
   * happens to sit at. A hit point would only narrow that, and narrowing it is
   * the wrong direction — attention is not a point.
   *
   * The whole thing is four vector operations a frame and one uniform write.
   */
  /**
   * How still the picture is, 0..1. See the VIEW_STILL block at the top.
   *
   * Speed from the eye's own displacement rather than from the controller,
   * because the director is not given the controller and should not be: this is
   * a question about the CAMERA, and a flying camera, a cutscene or a test rig
   * driving the camera directly all answer it correctly this way.
   */
  _updateStillness(dt, camera) {
    const moved = this._eyeSeen ? camera.position.distanceTo(this._lastEye) : 0;
    this._lastEye.copy(camera.position);
    this._eyeSeen = true;
    // A jump is not a velocity. See VIEW_TELEPORT.
    if (moved > VIEW_TELEPORT || dt <= 1e-4) return;
    const speed = moved / dt;
    const target = 1 - clamp01((speed - VIEW_STILL) / (VIEW_MOVING - VIEW_STILL));
    this._stillness = damp(this._stillness, target, 0.05, dt / VIEW_SETTLE);
  }

  _updateGaze(dt, camera, amount) {
    camera.getWorldDirection(_gaze);
    const held =
      this._gazeDir.dot(_gaze) > 1 - GAZE_TURN &&
      this._gazeFrom.distanceToSquared(camera.position) < GAZE_MOVE * GAZE_MOVE;

    if (held) {
      this._dwell = damp(this._dwell, 1, 0.05, dt / DWELL_RISE);
    } else {
      /**
       * Re-anchor and collapse. The anchor moves in one step rather than
       * easing, because a sliding anchor would drag the enhanced patch across
       * the world behind your gaze — which is the screen-space failure this is
       * built to avoid, arriving by the back door.
       */
      this._gazeFrom.copy(camera.position);
      this._gazeDir.copy(_gaze);
      this._dwell = damp(this._dwell, 0, 0.05, dt / DWELL_FALL);
    }

    tripUniforms.uGazeFrom.value.copy(this._gazeFrom);
    tripUniforms.uGazeDir.value.copy(this._gazeDir);
    // Scaled by the trip, so a sober forest does not quietly sharpen up
    // wherever you happen to be looking.
    tripUniforms.uDwell.value = clamp01(this._dwell) * clamp01(amount);
  }

  _updateAtmosphere(dt, L, dissolve, surge = 0) {
    const atmos = this.atmosphere;
    if (!atmos) return;
    const base = atmos.base;
    const colour = this.switches.colour ? L : 0;
    const clock = this.state.clock;

    /**
     * Fog is the strongest colour lever in a forest, because the fog colour IS
     * the colour of every distant surface. Shifting its hue repaints the whole
     * depth of the wood at once, which is why this is worth doing here rather
     * than leaving it to the per-material tint.
     *
     * THE SATURATION CAME OFF ALL FIVE OF THESE AND THE HUE MOSTLY STAYED, and
     * that is the whole distinction between light and a gel.
     *
     * `offsetHSL` adds to saturation ABSOLUTELY, in 0..1. The fog was taking
     * +0.42 of it — a haze that started at a quarter saturated arrived at two
     * thirds, which is not weather, it is a coloured filter across the far half
     * of every view. Multiply that by the hemisphere at +0.30, the ground
     * bounce at +0.36 and the sky at +0.30, and the LIGHTING was already doing
     * most of what the surfaces were being blamed for: a green leaf lit by
     * strongly saturated magenta skylight comes out magenta whatever arc its
     * own hue rotation is capped to. Capping the surfaces without this would
     * have moved the problem one level up and left it there.
     *
     * The hue offsets survive nearly intact, because a hue offset on a LIGHT is
     * the most naturalistic colour lever there is — every sunset, every storm,
     * every hour before dark is exactly this, and the eye has a lifetime of
     * evidence that light does this and no evidence at all that leaves do. The
     * fog's own is the one that came down much: at 0.16 it swung 58° and the
     * far wood went through violet, and the far wood is where fog IS the image.
     */
    const hue = Math.sin(clock * 0.021) * 0.5 + Math.sin(clock * 0.0083 + 2.1) * 0.5;
    /**
     * THE FOG'S OWN HUE OFFSET IS GONE, AND IT WAS NEVER ON.
     *
     * Three lines here used to compute `this._fogColour` from `base.fogColour`
     * and a hue offset, every frame, and then assign it to nothing at all. The
     * trip's fog TINT has therefore never once reached the screen — only its
     * density ever did, a little further down. Nobody noticed because the fog
     * does visibly change during a trip, so the feature looked like it worked.
     *
     * It is deleted rather than wired up, and that is deliberate, because the
     * thing it would have written to now has an owner. `atmosphere.tick()`
     * writes `scene.fog.color` every frame for aerial perspective — the haze
     * warms and brightens toward the sun and cools away from it, which is the
     * single strongest depth cue in the wood. It runs AFTER this function. So
     * reviving these lines as-is would either do nothing (overwritten a moment
     * later) or, if someone moved them later to "fix" that, silently delete
     * aerial perspective and be very hard to attribute.
     *
     * If the trip should tint the fog, the tint belongs in atmosphere.js
     * COMPOSED WITH the sun-facing scatter, not written over it from here.
     * `base.fogColour` stays what it is: the pure colour of the hour, which is
     * the correct thing for both of them to read.
     */
    atmos.hemi.color.copy(base.hemiSky);
    atmos.sun.color.copy(base.sunColour);
    if (colour > 0.001) {
      atmos.hemi.color.offsetHSL(hue * 0.1 * colour, 0.12 * colour, 0.03 * colour);
      atmos.sun.color.offsetHSL(-hue * 0.08 * colour, 0.09 * colour, 0.02 * colour);
      atmos.hemi.groundColor.copy(base.hemiGround).offsetHSL(hue * 0.13 * colour, 0.14 * colour, 0.05 * colour);
    } else {
      atmos.hemi.groundColor.copy(base.hemiGround);
    }
    atmos.sun.intensity = base.sunIntensity * (1 + 0.28 * L + 0.55 * surge);
    atmos.hemi.intensity = base.hemiIntensity * (1 + 0.22 * L + 0.4 * surge);

    /**
     * The wood gets deeper as you come up: density rises in waves, so distance
     * itself becomes unstable. Dropping it during ego death opens the world out.
     *
     * THE STANDING TERM CAME DOWN, AND THE WAVE WENT UP.
     *
     * At 0.55 + 0.55·breathe the peak was permanently between one and a half
     * and twice as hazy as sober, and haze is contrast. So every effect that
     * had just been made stronger was being handed a flatter, dimmer image to
     * work on, and the net was a peak that looked *less* eventful than the
     * sober forest — which is precisely the complaint. The instability is worth
     * keeping and the fug is not, so almost all of the amplitude now lives in
     * the wave.
     *
     * A surge thins it further. That is the direction that reads as an event
     * rather than as weather: the wave arrives, the air goes out of the wood,
     * the far trees resolve and the light reaches further into it, and then it
     * closes again. Opening the depth of a forest is the largest single change
     * available to this function.
     */
    const breathe = Math.sin(clock * 0.14) * 0.5 + 0.5;
    const density =
      base.fogDensity *
      (1 + L * (0.12 + breathe * 0.62)) *
      (1 - surge * 0.32) *
      (1 - dissolve * 0.55);
    if (atmos.fog) atmos.fog.density = density;

    atmos.skyUniforms.uTop.value.copy(base.skyTop);
    atmos.skyUniforms.uHorizon.value.copy(base.skyHorizon);
    if (colour > 0.001) {
      // Same rebalance as the fog and the lamps above: the hue keeps most of
      // its swing, the saturation loses most of its add. A sky may be any
      // colour and is never a flat gel.
      atmos.skyUniforms.uTop.value.offsetHSL(hue * 0.17 * colour, 0.13 * colour, 0.02 * colour);
      atmos.skyUniforms.uHorizon.value.offsetHSL(-hue * 0.12 * colour, 0.15 * colour, 0.04 * colour);
    }

    /**
     * "Sunlight coming through blinds can look almost solid."
     *
     * The shafts are the only thing in the world that is made of light rather
     * than lit by it, so they are where that report has to land.
     *
     * THE HEADROOM IS SMALLER THAN IT LOOKS. The shader's own note explains
     * that a shell reaching about 1.0 additive becomes a flat white slab with a
     * clipped edge, and the coefficient there turns this number into roughly a
     * fifth of itself — so 4.1, which is what a full surge at 1.7 produced,
     * lands a single shell at 0.79 and puts overlapping ones straight through
     * the bright-pass. A gap in the canopy came out as a pale slab. 2.7 is the
     * most that stays a volume, and it is still half again what the peak used
     * to reach.
     */
    atmos.shafts.material.uniforms.uStrength.value = 1 + L * 1.0 + surge * 0.7;
    for (const mat of atmos.mist.mats) {
      mat.opacity = mat.userData.base ?? (mat.userData.base = mat.opacity);
      mat.opacity *= 1 + L * 1.4;
    }
    void dt;
  }

  _updateCamera(dt, camera, level, dissolve, state) {
    const clock = state.clock;
    const L = level * this.gain.camera;

    /**
     * Field of view and the dolly move in OPPOSITION.
     *
     * Together they are a partial dolly zoom: the world stops agreeing with
     * itself about how far away things are. Both are driven by the same slow
     * oscillator so the mismatch is coherent rather than two independent
     * wobbles, and the period is long — about half a minute — because a fast
     * vertical or depth oscillation is the most reliable way to make somebody
     * motion sick.
     */
    const slow = Math.sin(clock * 0.031 * Math.PI * 2);
    const slower = Math.sin(clock * 0.011 * Math.PI * 2 + 1.3);

    /**
     * `dissolve * 4` used to sit OUTSIDE the `L` product, and it was therefore
     * the one camera term the Motion slider could not switch off.
     *
     * Measured at ego death with `motionIntensity = 0`: sway and dolly were
     * correctly pinned at 0 m and roll at 0 rad, exactly as the slider's own
     * documentation promises — and the FOV was still being pushed to 69.5–69.9
     * against a base of 66, a 3.9° dolly zoom, at the most intense moment the
     * app has. An accessibility control that removes three of the four things
     * moving the camera is not an accessibility control.
     *
     * `gain.camera` rather than `L`, so the fix is minimal by construction:
     * identical output at gain 1 (the shipping path, and every screenshot in
     * scripts/), and exactly `_baseFov` at gain 0.
     */
    const fovTarget = this._baseFov + slow * MAX_FOV_DRIFT * L + dissolve * 4 * this.gain.camera;
    this._fov = damp(this._fov, fovTarget, 0.02, dt);
    if (Math.abs(camera.fov - this._fov) > 0.001) {
      camera.fov = this._fov;
      camera.updateProjectionMatrix();
    }

    this._dolly = damp(this._dolly, -slow * MAX_DOLLY * L, 0.02, dt);

    // A slow roll. Small: a horizon that is never quite level is unsettling in
    // the right way, and one that is visibly tilted is a broken camera.
    const rollTarget = (slower * 0.7 + Math.sin(clock * 0.047) * 0.3) * MAX_ROLL * L;
    this._roll = damp(this._roll, rollTarget, 0.03, dt);

    // Lateral drift, in the camera's own frame, so it reads as your head not
    // being quite where you left it.
    this._wobblePhase += dt * 0.29;
    const swayX = Math.sin(this._wobblePhase) * MAX_SWAY_M * L;
    const swayY = Math.sin(this._wobblePhase * 0.61 + 2.2) * MAX_SWAY_M * 0.7 * L;

    camera.getWorldDirection(_forward);
    _right.crossVectors(_forward, camera.up).normalize();

    this._sway.set(0, 0, 0);
    this._sway.addScaledVector(_right, swayX);
    this._sway.y += swayY;
    this._sway.addScaledVector(_forward, this._dolly);
    camera.position.add(this._sway);
    camera.rotateZ(this._roll);
  }

  /** For the HUD and the debug panel. */
  describe() {
    const s = this.state;
    return {
      phase: s.phase,
      time: s.time,
      total: s.total,
      level: this.eased,
      raw: s.level,
      dissolve: s.dissolve,
      surge: this.surge ?? 0,
      doses: s.doses,
      active: s.active || s.override !== null,
      override: s.override,
      paused: s.paused,
    };
  }
}
