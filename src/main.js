import * as THREE from 'three';
import { Clock, clamp01 } from './core/util.js';
import { buildForest } from './world/forest.js';
import { buildAtmosphere } from './world/atmosphere.js';
import { buildSpeakers } from './world/speakers.js';
import { aimGround } from './world/aim.js';
import { buildFauna } from './world/fauna.js';
import { buildShoal } from './world/shoal.js';
import { groundUnder, setWorldSeed, streamPointNear, wetness } from './world/terrain.js';
import { buildCaves, caveFloorUnder, caveWarmupObjects } from './world/caves.js';
import { videoWarmupObjects } from './world/video-surface.js';
import { CaveAudio, pinkBuffer as caveNoise } from './audio/cave.js';
import { buildGathering } from './world/gathering.js';
import { buildFerry } from './world/ferry.js';
import { SeatRegistry, Sitting } from './player/seats.js';
import { Fishing } from './player/fishing.js';
import { Social } from './ui/social.js';
import { FAUNA_MS, FLAG_BITE, FLAG_FISHING, FLAG_SITTING } from './net/protocol.js';
import { Controller } from './player/controller.js';
import { Pipeline } from './render/pipeline.js';
import { Director, EGO_DEFAULT } from './trip/director.js';
import { tripUniforms, updateWind } from './trip/living.js';
import { AudioEngine } from './audio/engine.js';
import { createImpulseResponse } from './audio/impulse.js';
import { Jukebox, pinkBuffer as musicNoise } from './audio/music.js';
import { ExternalTrack, canPlayOpus } from './audio/external-track.js';
import * as tuning from './audio/tuning.js';
import * as presets from './audio/presets.js';
import { Ambience, pinkBuffer as ambienceNoise } from './audio/ambience.js';
import { pinkBuffer as wildlifeNoise } from './audio/wildlife.js';
import { TripAudio } from './audio/trip-audio.js';
import { Hud } from './ui/hud.js';
import { JukeboxInput } from './ui/jukebox-input.js';
import { DebugPanel } from './ui/debug.js';
import { StatsPanel } from './ui/stats.js';
import { quality } from './core/quality.js';
import { worldHearsKey } from './core/keys.js';
import { worldSeed } from './core/world-seed.js';
import { pinWorldClock, tickWorldClock, worldClock, worldOrigin } from './core/world-clock.js';
/**
 * What the main menu decided. See `src/core/identity.js` — the two files meet
 * there and nowhere else, the same arrangement the settings panel has with
 * `core/quality.js`.
 */
import { arrivalOrigin, lobbyCode } from './core/identity.js';
/**
 * The clock itself, for the one thing the menu can ask of it. Imported directly
 * rather than through `atmosphere.day`, which exists for test scripts driving
 * the page from outside — see the note on that handle for why they cannot import
 * this module and this file can.
 */
import { CYCLE_SECONDS, dayScale, setDayOrigin } from './world/daylight.js';
import { attachMultiplayer } from './net/index.js';

/**
 * Reality Room — milestone one.
 *
 * A forest, a jukebox and the experience of losing your grip on both.
 *
 * The wiring order below is not arbitrary: the world is built first because the
 * jukebox needs to know where the ground is, audio is built on the first gesture
 * because browsers require it, and the trip director is last because it holds a
 * reference to everything it modulates.
 */

/**
 * A different wood every time you arrive.
 *
 * Chosen before anything is built, because everything below is a pure function
 * of it — the height field, the ridge, the stream and the scatter of every tree
 * all derive from this one string. The choosing itself lives in
 * `core/world-seed.js`, which explains why a human gets a fresh world, an
 * invited guest gets the host's, and automation gets `grove-01` so that the
 * fifteen pixel-diffing scripts in scripts/ keep meaning something.
 */
const SEED = worldSeed();
/**
 * BEFORE ANYTHING IS BUILT, AND THAT ORDERING IS LOAD-BEARING.
 *
 * `terrain.js` holds the seed in module state and every height query reads it,
 * so this has to run before the first call to `heightAt` — which means before
 * `buildForest`, `buildAtmosphere` and `buildFauna` below, all three of which
 * ask the ground where it is during construction. Set it late and the world
 * would be built against one height field and walked on against another: trees
 * hanging in the air, a stream in the wrong valley, and nothing anywhere that
 * throws.
 *
 * `grove-01` normalises to the identity case, so automation still gets the
 * authored world bit for bit. See core/world-seed.js.
 */
setWorldSeed(SEED);

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  powerPreference: 'high-performance',
  stencil: false,
});
/**
 * 1.4, down from 1.75. This game is fill-bound: at 1.75 a 1440p window is an
 * 11-megapixel HDR target and every one of those pixels runs the living
 * shaders. MSAA on the scene target smooths the leaf edges that supersampling
 * was paying for, and the difference between 1.4 and 1.75 is invisible at
 * arm's length from a monitor while being ~35% of the frame budget.
 */
const BASE_PIXEL_RATIO = Math.min(window.devicePixelRatio, 1.4);
/** Multiplier on top, 0.5..1, settable from the debug panel's `scale` slider. */
let renderScale = 1;
/**
 * The frame-rate cap, as a real fps figure. `quality.register` below applies
 * the stored value immediately on registration, before `frame()` is ever
 * defined, so this has to exist up here rather than next to the loop that
 * reads it. 0 until seeded is harmless — see FPS_LIMIT_UNCAPPED below.
 */
let fpsLimit = 0;
/**
 * The `fpsLimit` knob's own ceiling doubles as "no cap" — see its `format()`
 * in core/quality.js, which this has to be kept in sync with by hand. Kept as
 * a named constant rather than a bare `145` in the throttle below so the two
 * places agree on what the number MEANS, not just its current value.
 */
const FPS_LIMIT_UNCAPPED = 145;
/**
 * IS THE MENU STILL COVERING THE WORLD? See the draw throttle in frame().
 *
 * `#gate` is an opaque full-page panel — its last background layer is a solid
 * colour, so nothing behind it reaches the screen — and it stays up for as long
 * as somebody takes to read a title, type a name and pick a dye. Underneath it,
 * this loop was drawing the entire forest at whatever rate the display would
 * accept: measured at 159 draw calls and 12.6M triangles per frame, which is
 * 100% of what the world costs while 0% of it is visible. A player who opens the
 * game and goes to make tea gets a GPU at full tilt and a fan, and the only
 * clue is the noise.
 *
 * Cleared inside the `#enter` handler rather than when the gate finishes fading,
 * because everything between those two moments — the terrain settle, the
 * thirty-nine shader compiles, the handful of deliberately drawn frames — is
 * warm-up that WANTS real frames, and is the one part of the session where the
 * player has already been told to expect a wait.
 */
let gateUp = true;
renderer.setPixelRatio(BASE_PIXEL_RATIO);
renderer.setSize(window.innerWidth, window.innerHeight);
/**
 * Tone mapping and colour conversion happen in the pipeline's output shader,
 * not here. Doing it in both places double-corrects, and the pipeline needs a
 * linear HDR buffer to melt and bloom before anything is rolled off.
 */
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
// PCFSoftShadowMap is deprecated in this version of three and silently falls
// back to PCF anyway; asking for it only produced a console warning.
renderer.shadowMap.type = THREE.PCFShadowMap;
/**
 * The shadow map re-renders on demand, not per frame. The depth pass ignores
 * the living displacement, so the map only changes when the sun's anchor moves
 * — atmosphere.follow() holds that anchor until the BODY is 6 m from it, then
 * moves it, and sets needsUpdate. Anything else that invalidates shadows
 * (toggling them in the probe, hiding a layer) must set
 * `renderer.shadowMap.needsUpdate = true` itself.
 *
 * It is worth knowing what that frame costs, because everything about how the
 * anchor moves is chosen around it: measured with a GPU timer query at
 * 2560×1440 on an RX 9070 XT, one shadow update is 3.2–4.5 ms on top of a
 * 2.2–2.8 ms frame. It roughly triples the frame it lands on, which is the
 * "frame stutters when I move" the player reported. Almost none of that is
 * resolution (1024² saves only 0.6 ms of it) and almost none is the number of
 * instances submitted (halving the casting set saves 5%), so it is close to a
 * fixed price for doing a shadow render at all on this driver, and the only
 * lever anyone has is how seldom it happens.
 */
renderer.shadowMap.autoUpdate = false;
// The first frame has no map at all yet. follow() would arm this anyway on its
// first call, but relying on that makes correctness depend on call order.
renderer.shadowMap.needsUpdate = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(66, window.innerWidth / window.innerHeight, 0.1, 900);

const forest = buildForest(scene, SEED);
const atmosphere = buildAtmosphere(scene, renderer, SEED);
/**
 * The stereo pair, standing where the machine used to.
 *
 * This is only where they START. The player arranges them with `G` from here on
 * — see `placeSpeaker` — and the opening position is chosen for the same reason
 * anything else in the clearing is: it is what you see when you arrive, and
 * arriving to a rig already set up is a better first thirty seconds than
 * arriving to two boxes in a heap.
 */
const speakers = buildSpeakers(scene, new THREE.Vector3(1.2, 0, -6.0));
/**
 * Everything that is alive but is not a plant.
 *
 * Built after the forest because the perching birds need real branches to sit
 * on, and without audio because the AudioContext does not exist until somebody
 * clicks through the gate — `attachAudio` below closes that gap.
 */
const fauna = buildFauna({ scene, seed: SEED });
/**
 * The fish in the river, which are not fauna and are deliberately not built by
 * `buildFauna`.
 *
 * Every animal in that module walks or flies on the height field and is placed
 * against the trunk grid; a fish is placed against the CHANNEL, is only ever
 * within a hundred metres of one line through the world, and switches itself off
 * completely everywhere else. Folding it in would have meant teaching the fauna
 * placement about water for one species, and the shoal is thirty-six instances
 * that need none of the herding, morphs, plumage or voices that file exists for.
 *
 * `sound` is the same optional-chain-into-`ambience` the rod gets, and for the
 * same reason: fish jump before anybody has clicked through the audio gate.
 */
const shoal = buildShoal({
  scene,
  seed: SEED,
  sound: (kind, at, strength) => ambience?.fishing(kind, at, strength),
});
/**
 * The caves.
 *
 * Built after the forest and the fauna because it needs neither — it hangs off
 * the ridge, which is a property of the seeded terrain — but it is placed here
 * so the whole world is constructed in one block. Nothing streams until the
 * player is near a mouth.
 */
const caves = buildCaves(scene);
/** @type {CaveAudio|null} */
let caveAudio = null;
/** 0 outside, 1 deep underground. Eased, because fog and reverb ride on it. */
let caveMix = 0;
/**
 * Scratch for the daylight handed to the cave material each frame.
 *
 * The rock at a mouth now stands out of the hillside and is therefore in the
 * weather; `caves.setDaylight` lights that part with one lambert and a
 * hemisphere rather than with the scene's lights, so these carry the sun's
 * direction and the three colours already multiplied by their intensities.
 * Allocated once, for the reason everything else in this loop is.
 */
const _caveSunDir = new THREE.Vector3();
const _caveSun = new THREE.Color();
const _caveSky = new THREE.Color();
const _caveGround = new THREE.Color();

/**
 * Somewhere to sit down.
 *
 * Every prop that has a seat on it registers here as it is built, and one query
 * a frame answers "is there anything to sit on within arm's reach". Declared
 * before the props rather than after them because it is an inbox they write
 * into, exactly like `forest.colliders`.
 */
const seats = new SeatRegistry();

/**
 * THE PLACES PEOPLE MEET.
 *
 * `sitePlan()` has already run by the time this line executes — `scatter.js`
 * asks it where these places are so the forest can leave room for them, in the
 * worker's realm and in this one — so `buildGathering` is reading a plan rather
 * than making one. See `src/world/sites.js`.
 *
 * The ferry comes after, because the landings it calls at are part of that plan,
 * and it is handed the same `reach` the landings were placed along rather than
 * measuring the river a second time. A world whose stream runs too high gets no
 * reach, no landings and no ferry, and everything else about it is unchanged —
 * the same posture `caves.js` takes toward a ridge that does not suit it.
 */
const gathering = buildGathering(scene, { seed: SEED, seats });
const ferry = buildFerry(scene, {
  reach: gathering.sites.reach,
  stops: gathering.sites.jetties.map((j) => j.u),
  seats,
});

const controller = new Controller(camera, canvas);
const pipeline = new Pipeline(renderer, scene, camera);
const hud = new Hud();

const audio = new AudioEngine();

/**
 * Other people, when there are any.
 *
 * Attached here rather than after the gate because it must be able to come up
 * without audio: the AudioContext does not exist until somebody clicks "Enter
 * the forest", so the socket, the avatars and the interpolator all start
 * without it and the voice half joins itself on the first frame audio.ready
 * turns true. With no `?room=` in the URL this touches the network not at all.
 */
/**
 * NO SCREEN IS HANDED OVER ANY MORE, and that is the shape of the change.
 *
 * This used to pass `gathering.screen` — the fourteen-metre one in the commons —
 * so the net layer had somewhere to put a share. A share now BRINGS its screen:
 * it is an object its owner carries and stands up wherever the evening is,
 * built and owned by the net layer, which needs nothing from the world to do it
 * but the height field. See `ShareScreen` in world/video-surface.js.
 */
const net = attachMultiplayer({ scene, camera, controller, audio, hud });

/**
 * Sitting down, and the rod.
 *
 * Both are built after the net layer because both talk to it: a seated body
 * broadcasts a pose bit, and a caught fish is announced to the room. Neither is
 * given the socket — they are given `hud.toast` and `net.note`, which is the
 * whole of what they need and none of what they could break.
 */
const sitting = new Sitting(controller, seats);
const fishing = new Fishing({
  scene,
  controller,
  seed: SEED,
  say: (text, ms) => hud.toast(text, ms),
  announce: (text) => net.note(text),
  /**
   * The rod's noises, forwarded to the module that already owns every other
   * sound made at a point on the water. `ambience` is null until the audio gate
   * has been clicked through and is declared below this line — both are fine,
   * because this closure is not called during module evaluation and the optional
   * chain is what lets a rod work in silence before the context exists at all,
   * which is the state the perf scripts run the whole world in.
   */
  sound: (kind, at, strength) => ambience?.fishing(kind, at, strength),
  /**
   * A float hitting the water, and a fish going back into it, are things the
   * shoal has an opinion about. One callback rather than an import in either
   * direction: the rod does not know what a shoal is, and the shoal does not
   * know anybody is fishing.
   */
  disturb: (x, z, radius, strength) => shoal.startle(x, z, radius, strength),
});

/**
 * The chat, the roster and the share readout.
 *
 * Loaded here rather than in index.html alongside the settings menu, because
 * unlike the settings menu it is not an independent panel that meets the game
 * through a registry — it needs the live net object, and it needs to be updated
 * on the frame loop.
 */
const social = new Social({ net, hud, controller, seed: SEED });
net.onMessage((line) => social.push(line));

// `onSubmit` is `submitJukeboxUrl`, a function declaration defined below —
// hoisted, so the forward reference is safe; see that function's header.
const jukeboxInput = new JukeboxInput({ controller, onSubmit: (url) => submitJukeboxUrl(url) });

/** @type {Jukebox|null} */
let music = null;
/**
 * A pasted YouTube link, playing — deliberately never what `music` gets
 * reassigned to. `director.jukebox` and `fauna`'s wildlife reference are both
 * bound to the one real `Jukebox` instance once, at startup, and never
 * re-read (see below); pointing `music` at this instead would leave the
 * trip's tempo/detune bending and the birds' key-following silently
 * modulating an instance nobody can hear, while doing nothing to whatever is
 * actually playing. See audio/external-track.js's header.
 * @type {ExternalTrack|null}
 */
let externalTrack = null;
/** @type {Ambience|null} */
let ambience = null;
/** @type {TripAudio|null} */
let tripAudio = null;
/**
 * The synthesised jukebox's spatial sources — one per speaker, because there
 * are two speakers and a record coming out of only one of them would read as a
 * broken rig rather than as a stereo pair.
 *
 * Indexed to match `speakers.cabinets`, which is what lets `placeSpeaker` move
 * exactly one panner when exactly one box has been picked up. @type {Array<object>}
 */
let jukeboxSources = [];

const director = new Director({
  pipeline,
  atmosphere,
  audio: null,
  jukebox: null,
  camera,
});

/**
 * The debug panel gets a view of nearly the whole app, and every part of it is
 * optional — a dependency that is not passed makes the rows that need it draw
 * dead with a reason rather than throwing. See the header of src/ui/debug.js.
 *
 * `probe` is a THUNK because it is declared at the bottom of this file, and the
 * getters are thunks because `music` and `externalTrack` are reassigned: handing
 * the panel the value would leave it describing whatever was playing when the
 * page loaded, which is nothing.
 */
const debug = new DebugPanel({
  director,
  pipeline,
  renderer,
  camera,
  controller,
  forest,
  atmosphere,
  speakers,
  gathering,
  net,
  audio,
  seed: SEED,
  probe: () => probe,
  getMusic: () => music,
  getExternalTrack: () => externalTrack,
  onRenderScale(s) {
    renderScale = s;
    resize();
  },
});
const stats = new StatsPanel();

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/**
 * Claim the quality knobs.
 *
 * The registry in core/quality.js knows the NAMES of these and nothing else.
 * The state they move is module-private in here, in the pipeline and in
 * atmosphere, which is exactly why the settings menu asks rather than reaches.
 * A knob nobody claims draws disabled in the menu instead of throwing, so this
 * list is allowed to be incomplete — but every setter in it must be idempotent,
 * because `register` applies the current value immediately and on a fresh
 * profile that value is already the one in effect. Without the guards, loading
 * the page would resize the renderer, reallocate the MSAA buffer and recompile
 * every material in the scene for no reason, on the busiest frames there are.
 */
quality.register('renderScale', (v) => {
  if (Math.abs(v - renderScale) < 1e-4) return;
  renderScale = v;
  resize();
});

quality.register('msaa', (n) => pipeline.setSamples(n));

quality.register('shadows', (on) => {
  /**
   * THE LIGHT REBALANCE GOES FIRST, AND OUTSIDE THE EARLY-OUT BELOW.
   *
   * Switching the shadow map off is the largest change any quality setting
   * makes to what the frame is a PICTURE of, and it used to be completely
   * uncompensated. Measured at six camera stations, sober, as the mean of the
   * whole frame, Low's luminance sat between +1.0 and +18.2 above High's, and
   * almost all of that was this one knob — and it was a hue shift as much as a
   * brightening, because with no shadow map the sun reaches the dry khaki end
   * of the terrain blend instead of the mossy shaded one. atmosphere pulls the
   * sun down and trims the sky bounce so the floor lands near its shadowed
   * average; see the block comment on NO_SHADOW_SUN for the fit, the residual,
   * and what it deliberately does not try to fix.
   *
   * It is idempotent, and it is called BEFORE the `enabled` test rather than
   * after it because `probe.shadows()` writes `renderer.shadowMap.enabled`
   * straight from the console — after which the flag already agrees with the
   * knob, this early-out fires, and the lights would be left describing the
   * other state for the rest of the session.
   */
  atmosphere.setShadowsEnabled(on);
  if (renderer.shadowMap.enabled === on) return;
  renderer.shadowMap.enabled = on;
  renderer.shadowMap.needsUpdate = true;
  // Whether a material samples the shadow map is compiled into its program.
  scene.traverse((o) => {
    if (o.material) o.material.needsUpdate = true;
  });
});

quality.register('shadowMapSize', (n) => {
  const shadow = atmosphere.sun.shadow;
  if (shadow.mapSize.width === n) return;
  shadow.mapSize.set(n, n);
  // three will not resize a shadow map in place; the old one has to go.
  shadow.map?.dispose();
  shadow.map = null;
  renderer.shadowMap.needsUpdate = true;
});

quality.register('bloom', (on) => (pipeline.bloomEnabled = !!on));
quality.register('trail', (on) => (pipeline.trailEnabled = !!on));

/**
 * View distance moves the fog BASE, not `scene.fog.density` — the director
 * rebuilds the live density from `atmosphere.base.fogDensity` every frame, so
 * anything written to the fog itself survives one frame. `camera.far` is
 * deliberately left alone: the sky dome is a sphere of radius
 * WORLD_RADIUS * 3.4 = 646 m centred on the camera, and 0.7 * 900 = 630 m
 * clips it, which puts a hole in the sky. Fog is the real draw distance here.
 */
/**
 * View distance is now one of FOUR multipliers on the fog — the authored
 * density, the hour of day, this knob, and how far underground you are — so it
 * can no longer assign. `atmosphere` composes them in a single place.
 *
 * Same lesson as `setShadowsEnabled`: with two opinions you can get away with
 * assigning, with three you cannot, because an assignment from any one of them
 * silently discards the others. Left as an assignment, this slider did nothing
 * at all — the clock rebuilt the density from its own product on the very next
 * frame.
 *
 * `camera.far` is still deliberately left alone: the sky dome is a sphere of
 * radius WORLD_RADIUS * 3.4 = 646 m centred on the camera, and 0.7 * 900 = 630 m
 * clips it, which puts a hole in the sky. Fog is the real draw distance here.
 */
quality.register('fogDistance', (v) => atmosphere.setFogScale(v));

/**
 * Motes, by draw range rather than by rebuilding the buffer. They were
 * scattered by one rng in one loop, so their order in the array has nothing to
 * do with where they are — cutting the tail off thins the cloud evenly instead
 * of emptying one part of the wood. Measured: the mean radius of the first
 * quarter is 64.23 m against 64.25 m for all 2600.
 */
const MOTE_COUNT = atmosphere.motes.points.geometry.attributes.position.count;
quality.register('particleDensity', (v) => {
  atmosphere.motes.points.geometry.setDrawRange(0, Math.round(MOTE_COUNT * v));
});

/**
 * Undergrowth density goes through the culler rather than through forest.js,
 * because the culler already owns the instance buffers and thinning is a
 * property of how they are packed, not of how they were scattered. It refuses
 * to thin the trees whatever this asks — see packSlab.
 */
quality.register('instanceDensity', (v) => forest.culler.setDensity(v));

/**
 * `plantVeins` LIVED HERE — a define flip on the grass and fern materials that
 * skipped the vein block, worth 0.11 ms at the clearing at peak and 0.28 ms in
 * the canopy. The filaments themselves were removed on 2026-08-11, so every
 * material now gets that saving unconditionally and there is nothing left to
 * switch. See the tombstone in trip/living.js.
 *
 * The pre-warm below lost a pass with it: the shadow-map flip is now the only
 * program-identity knob the Auto governor can reach.
 */

for (const bus of ['master', 'music', 'world', 'sfx', 'voice']) {
  quality.register(`volume.${bus}`, (v) => audio.setBusVolume(bus, v));
}

/**
 * FOV is set on the director, not on the camera: the dolly zoom writes
 * `camera.fov` every frame from `_baseFov`, so a value written to the camera
 * lasts exactly one frame and is then replaced by one derived from the old base.
 */
quality.register('fov', (v) => (director._baseFov = v));
quality.register('mouseSensitivity', (v) => (controller.lookSensitivity = v));
quality.register('invertY', (v) => (controller.invertLook = !!v));
/**
 * One slider, three consumers — to somebody who needs the camera calmed down,
 * the head bob and the trip's roll/sway/dolly are the same complaint.
 *
 * THE VIEW BREATH IS THE THIRD, and it belongs here more than either of the
 * others. It is the only term in the project that moves the whole IMAGE, and a
 * coherent expansion of the entire visual field is the most nausea-capable
 * thing this renderer can do — more so than a camera motion, because a camera
 * motion is at least the kind of thing a head does. Leaving it out would make
 * this slider a control that half works, and the note on the knob itself
 * already says why that is not one.
 */
quality.register('motionIntensity', (v) => {
  controller.bobScale = v;
  director.gain.camera = v;
  director.gain.view = v;
});

/**
 * The corner FPS graph. Not a graphics knob — it draws nothing into the
 * scene it measures — so it has no `presets` and Auto will never touch it.
 */
quality.register('showStats', (on) => stats.setVisible(on));

// A target frames/sec ceiling, 0 for unlimited. See the throttle at the top
// of frame() for how this is enforced without touching the governor.
quality.register('fpsLimit', (v) => (fpsLimit = v));

// Guess a starting level from the GPU string so a fast machine does not spend
// its first half-minute climbing out of Low, and start the governor. This also
// starts frame-time measurement, which is skipped entirely under webdriver.
// Tell the slow controller what the fast one is already spending. pipeline.js
// runs a per-frame resolution loop off a GPU timer query; the governor runs a
// four-second window off rAF intervals. They never write the same knob — one
// moves pixels, the other moves features — but the governor would otherwise
// read a frame time the fast loop has already rescued and climb a preset the
// machine cannot actually afford. See the coexistence note in pipeline.js.
quality.auto.headroomScale = () => pipeline.drs.scale;
// And tell it when the frame loop is only pretending to draw. Behind the main
// menu nineteen ticks in twenty skip the render, and a controller that reads
// main-thread idleness as headroom would climb the ladder while the title card
// is up and pay for it on the first real frame. See `drawing` in quality.js.
quality.auto.drawing = () => !gateUp;

quality.seedFrom(renderer);

// ---------------------------------------------------------------------------
// interaction
// ---------------------------------------------------------------------------

/**
 * How close you have to be to A SPEAKER, not to the pair's midpoint.
 *
 * It was the midpoint, which was the same thing while the two were bolted 5.6 m
 * apart facing the same way. It stopped being the same thing the moment they
 * could be arranged: the midpoint of a pair standing either side of the clearing
 * is a patch of grass with nothing on it, and reaching for `E` at a speaker you
 * are standing right next to would have done nothing at all.
 *
 * The number is unchanged, and standing between a default pair still finds them
 * — 2.8 m from each, comfortably inside this.
 */
const NEAR_SPEAKER = 3.4;
const NEAR_PATCH = 2.6;
/** You may step aboard from anywhere along the deck plus a stride. */
const NEAR_FERRY = 4.2;

/**
 * Reused rather than allocated.
 *
 * The frame loop asks this question every frame and throws the answer away
 * before the next one, so there is no version of this object that outlives its
 * call and nothing to be gained by making a new one 240 times a second. Same
 * reasoning as the `_streamPoint` vector below.
 */
const _target = { kind: null, distance: 0, patch: null, seat: null };

/**
 * The nearest thing you could press E at, or null.
 *
 * ONE KEY FOR EVERYTHING, AND THE ORDER IS THE DESIGN. There are now six things
 * E can mean, and a player mid-conversation will not read a prompt carefully —
 * so the candidates are ranked by distance within a kind, and the kinds are
 * ordered by how specific they are. Fishing beats a seat, because somebody
 * standing on a jetty with a rod out and a fish on the line means the fish; a
 * seat beats the jukebox, because you have to walk past the machine to reach the
 * bench behind it.
 */
function findInteractable() {
  const p = controller.position;
  _target.kind = null;
  _target.patch = null;
  _target.seat = null;

  /**
   * A rod in your hands takes the key completely.
   *
   * Not a ranking — an override. Everything else within reach is still there
   * when you put the rod away, and having the key you are about to strike with
   * turn out to eat a mushroom because you drifted a metre is the single worst
   * thing this ordering could do.
   */
  if (fishing.state !== 'off') {
    _target.kind = 'fish';
    _target.distance = 0;
    return _target;
  }

  if (sitting.seated) {
    // Nothing to offer: standing up is any movement key, which is what a person
    // does anyway. See `Sitting.update`.
    return null;
  }

  const seat = seats.nearest(p.x, p.z);
  if (seat) {
    _target.kind = 'sit';
    _target.seat = seat;
    _target.distance = Math.hypot(seat.position.x - p.x, seat.position.z - p.z);
  }

  if (ferry && !seat) {
    const d = ferry.distanceTo(p.x, p.z);
    if (d < NEAR_FERRY) {
      _target.kind = 'ferry';
      _target.distance = d;
    }
  }

  // The NEARER of the two boxes — see `NEAR_SPEAKER`, and `distanceTo` in
  // speakers.js. Either one is the whole rig as far as `E` is concerned.
  const dj = speakers.distanceTo(p.x, p.z);
  if (dj < NEAR_SPEAKER && (_target.kind === null || dj < _target.distance)) {
    _target.kind = 'speakers';
    _target.distance = dj;
  }

  for (const patch of forest.patches) {
    const d = Math.hypot(p.x - patch.x, p.z - patch.z);
    if (d < NEAR_PATCH && (_target.kind === null || d < _target.distance)) {
      _target.kind = 'mushroom';
      _target.distance = d;
      _target.patch = patch;
    }
  }
  return _target.kind === null ? null : _target;
}

function interact() {
  const target = findInteractable();
  if (!target) return;
  switch (target.kind) {
    case 'fish':
      fishing.act();
      return;
    case 'sit':
      sitting.sit(target.seat);
      return;
    case 'ferry': {
      /**
       * Boarding is sitting on the nearest free deck seat, not walking onto a
       * moving platform. The controller stands on a height field and a raft is
       * not on it, so a body that walked aboard would fall through to the
       * riverbed — and solving that properly means giving the world a second
       * kind of floor for one object. A seat is the affordance the deck already
       * has, and stepping off is any movement key, which is a person deciding to
       * get out rather than a mechanic.
       */
      const deck = ferry.seats.find((s) => s !== seats.occupied);
      if (deck) {
        sitting.sit(deck);
        hud.toast('Aboard. Any movement key steps off.', 4200);
      }
      return;
    }
    case 'speakers': {
      if (externalTrack?.playing) {
        stopExternalTrack();
        music?.start();
        musicAt = worldClock();
        speakers.setPlaying(Boolean(music?.playing));
        announceMusic();
        hud.toast('Back to the record.');
        return;
      }
      if (!music) return;
      const playing = music.toggle();
      // Only a start sets the mark. Stopping does not need one, and moving it
      // would make a stop-then-start read as a record that never paused.
      if (playing) musicAt = worldClock();
      speakers.setPlaying(playing);
      announceMusic();
      hud.toast(playing ? `♪ ${music.trackName}` : 'The speakers fall quiet.');
      return;
    }
    default: {
      const phase = director.eat(`${SEED}:${target.patch.id}:${Math.floor(Date.now() / 1000)}`);
      hud.toast(
        director.state.doses > 1
          ? 'You eat another. It is going to be a while.'
          : 'Earthy, bitter, faintly sweet. Nothing happens.',
        5000
      );
      void phase;
      // Eating it does not leave it standing — see `eatPatch` in forest-field.js.
      if (forest.field.eatPatch(target.patch.id)) eatenByMe.add(target.patch.id);
      /**
       * And it does not leave it standing for anybody else either.
       *
       * THE DOSE DOES NOT TRAVEL AND THE MUSHROOM DOES, which is the whole
       * division of labour here. `director.eat` above is about the person who
       * ate it and belongs to this machine; what the world looks like afterwards
       * is a fact about the world. Seven other people watching a patch you just
       * cleared stay standing is the same class of wrong as seven people hearing
       * different records.
       *
       * A no-op on a solitary walk — see `net.sendEat` — so the gesture costs a
       * property read more than it did before anybody else existed.
       */
      net.sendEat(target.patch.id);
    }
  }
}

/**
 * The patches THIS player ate, as distinct from the ones they have been told
 * about.
 *
 * `forest.field.eaten` merges both and is the right set for deciding what to
 * draw. This one exists for the other question — what to teach a room on
 * arrival — and the two have to be kept apart or a reconnect would replay every
 * id the room itself sent us straight back at it. That is not merely wasteful:
 * the server rate-limits per player, and a few hundred redundant messages in a
 * burst is a socket closed with 1008 during a reconnect, which is the single
 * worst moment for one.
 */
const eatenByMe = new Set();

/**
 * Somebody else ate one, or we are catching up on a room that has been going a
 * while.
 *
 * No dose and no toast: `director.eat` is about the person who swallowed it.
 * This is only the mushroom leaving the world, which is why the whole handler
 * is the one call the local path makes second.
 */
net.onEat((id) => {
  if (id !== null) {
    forest.field.eatPatch(id);
    return;
  }
  // The room has finished telling us. Anything left is ours to teach it — see
  // `onEat` in net/index.js for the walk-then-press-J case this is for.
  for (const mine of eatenByMe) net.sendEat(mine);
});

/**
 * THE ANIMALS: one machine decides, everybody watches.
 *
 * The three lines below are the whole of it here, because both halves of the
 * problem live somewhere better. `world/fauna.js` owns the simulation and the
 * wire format; `src/net/` owns who is entitled to send it. What is left for
 * main.js is the translation between them, which is the same job it does for
 * the speakers and the jukebox and for the same reason: neither of those files
 * should have to know the other exists.
 */
net.onHost((mine) => fauna.setHosting(mine));
net.onFauna((msg) => fauna.applyRemote(msg));

/**
 * Everybody else's eyes, as four numbers each, rebuilt per frame.
 *
 * Not the peer objects themselves — `fauna.setObservers` takes plain positions
 * and yaws so that nothing in `src/world/` ever holds a reference to a peer.
 * Allocating a small array a frame is the cost of that boundary and is under a
 * microsecond at eight people; the alternative is a world module that cannot be
 * loaded without a net layer, which is what `scripts/fauna-wired.mjs` and every
 * capture script depend on not being true.
 *
 * Empty for the whole of single player, where every path that reads it is
 * skipped entirely.
 */
function faunaObservers() {
  const peers = net.peers;
  if (peers.length === 0) return EMPTY_OBSERVERS;
  return peers.map((p) => ({ x: p.position.x, y: p.position.y, z: p.position.z, yaw: p.yaw }));
}
const EMPTY_OBSERVERS = [];

/**
 * The host's six-a-second send, paced off the world clock.
 *
 * `FAUNA_MS` and not a frame count, because frames are not a unit of time: a
 * machine at 240 fps would be sending four times as often as one at 60 and
 * paying for it in somebody else's downstream. Falling behind is not caught up
 * on — a missed send is a sample nobody wants any more by the time it would go,
 * which is why this sets the mark to `now` rather than advancing it by a step.
 *
 * Costs a `performance.now()` and a compare on the frames it does not send.
 */
let faunaSentAt = 0;
function announceFauna() {
  if (!net.isHost) return;
  const now = performance.now();
  if (now - faunaSentAt < FAUNA_MS) return;
  faunaSentAt = now;
  const snapshot = fauna.snapshot();
  if (snapshot) net.sendFauna(snapshot);
}

/**
 * WHEN WHAT IS PLAYING STARTED, on the world clock.
 *
 * The world clock and not `Date.now()`, and not the AudioContext's clock
 * either. It is the one timebase every machine in the room has already agreed
 * on to about a millisecond (see core/world-clock.js), so a start time
 * expressed against it needs no conversion at either end and cannot be thrown
 * off by somebody whose system clock is wrong. `at` on the wire is this number.
 */
let musicAt = 0;

/**
 * True while a remote change is being applied, so the apply path cannot echo.
 *
 * Without it, `applyMusic` runs the same code the key handlers do, that code
 * announces, and the announcement comes back — the server's `sameMusic` dedupe
 * would stop the loop after one lap, but the lap itself is a second record
 * change on seven machines for no reason.
 */
let applyingMusic = false;

/**
 * What the jukebox is playing, in the form the room understands. Null for
 * silence. See `sanitizeMusic` in server/rooms.js for the vocabulary.
 */
function musicState() {
  if (externalTrack?.playing) {
    return { kind: 'link', id: externalTrack.id, title: externalTrack.title, at: musicAt };
  }
  if (music?.playing) return { kind: 'record', track: music.trackIndex, at: musicAt };
  return null;
}

/** Tell the room what is on, unless we are here because the room told us. */
function announceMusic() {
  if (applyingMusic) return;
  net.sendMusic(musicState());
}

/**
 * Make this machine play what the room says it is playing.
 *
 * THE OFFSET IS THE WHOLE MECHANISM. Everything else here is bookkeeping: the
 * room says which record and when it started, this works out how far in that
 * is by now, and both halves of the jukebox can be positioned. A guest who
 * walks in twenty minutes late hears bar 340 of the same record, not bar one.
 *
 * A RECORD NEEDS NO NETWORK AND A LINK NEEDS ALMOST NONE. The synthesised
 * tracks are a pure function of (bar, step), so an index and a start time
 * produce the same notes on every machine with nothing streamed at all. A
 * pasted link does stream — but only the id travels between clients, and each
 * fetches it from this project's own server, so there is still no audio on the
 * peer mesh and the person who pasted it is not uploading anything.
 */
/**
 * A room's record, arrived before this machine could play it.
 *
 * `welcome` lands during module evaluation; the AudioContext does not exist
 * until somebody clicks through the gate, because no browser will start one
 * without a gesture. So the overwhelmingly common case for a player joining
 * from an invite link is that the room tells them what is playing several
 * seconds before there is anything to play it with.
 *
 * Dropping it would be a silent, permanent divergence of exactly the kind this
 * whole change is about: everybody else has a record on, you walk in, and your
 * clearing is quiet until somebody presses a key. So the last thing the room
 * said is kept and applied the moment the jukebox exists — see `startAudio`.
 *
 * THREE STATES, NOT TWO, and the distinction is load-bearing:
 *
 *   undefined   no room has said anything. Start the default record.
 *   null        a room said it is silent. Start nothing.
 *   {...}       a room said what is on. Start that, at the right offset.
 *
 * Collapsing the first two is the bug where joining a room somebody had
 * deliberately turned the music off in starts it up again for everybody.
 */
let pendingMusic;

function applyMusic(state) {
  /**
   * Held rather than dropped when there is nothing to play it with yet. Note
   * this stores the state INCLUDING its start time, so the offset is computed
   * when it is finally applied and is correct however long the wait was.
   */
  if (!audio.ready || (!music && state?.kind === 'record')) {
    pendingMusic = state;
    return;
  }
  /**
   * The room has no opinion — nobody has touched the jukebox since it opened.
   *
   * Not silence, and the difference matters in both directions: there is
   * nothing here to apply, and if we ARE playing something then we are the
   * authority and the room should be told. That is the same rule the seed and
   * the speakers follow — the first one in teaches the room the world they are
   * already standing in.
   */
  if (state === undefined) {
    if (musicState()) announceMusic();
    return;
  }
  applyingMusic = true;
  try {
    if (!state) {
      stopExternalTrack();
      music?.stop();
      speakers.setPlaying(false);
      return;
    }
    musicAt = state.at;
    const offset = Math.max(0, worldClock() - state.at);

    if (state.kind === 'record') {
      stopExternalTrack();
      if (!music) return;
      music.stop();
      music.setTrack(state.track);
      music.startAt(offset);
      speakers.setPlaying(true);
      speakers.setHue(state.track * 1.7);
      return;
    }

    if (state.kind === 'link') {
      // Already the right link and already playing: a re-announce or a
      // reconnect, not a change. Re-seeking would be an audible skip for a
      // message that said nothing new.
      if (externalTrack?.id === state.id && externalTrack.playing) return;
      if (!audio.ready) return;
      stopExternalTrack();
      music?.stop();
      externalTrack = new ExternalTrack(
        audio.ctx,
        audio,
        { id: state.id, title: state.title },
        speakers.speakerL,
        speakers.speakerR
      );
      externalTrack.onEnded = onExternalTrackEnded;
      externalTrack.play(offset).catch(() => {
        // A link the sender could play and we cannot — a codec they have and we
        // do not, most likely. Silence rather than a toast: it is not this
        // player's action and there is nothing for them to do about it.
        stopExternalTrack();
      });
      speakers.setPlaying(true);
    }
  } finally {
    applyingMusic = false;
  }
}

net.onMusic(applyMusic);

/**
 * What happens when a pasted link runs out: back to the record.
 *
 * Hoisted out of `submitJukeboxUrl` because `applyMusic` needs the same
 * behaviour, and a link that ended on one machine but not on another would
 * otherwise leave the room disagreeing about what is playing.
 */
function onExternalTrackEnded() {
  stopExternalTrack();
  music?.start();
  musicAt = worldClock();
  speakers.setPlaying(Boolean(music?.playing));
  announceMusic();
}

/** Tears down the currently playing pasted link, if any. Safe to call when there isn't one. */
function stopExternalTrack() {
  if (!externalTrack) return;
  externalTrack.dispose();
  externalTrack = null;
}

/**
 * `jukeboxInput`'s submit callback. Validated cheaply before ever touching the
 * network, resolved through the server (server/youtube.js), then swapped in —
 * replacing whatever the jukebox was doing, never stacking with it, matching
 * the synth's own one-track-at-a-time model. `music` is stopped, never
 * reassigned — see the comment on the `externalTrack` declaration above.
 */
async function submitJukeboxUrl(rawUrl) {
  if (!/^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i.test(rawUrl)) {
    hud.toast("That doesn't look like a YouTube link.");
    return;
  }
  if (!audio.ready) {
    hud.toast('Audio is not ready yet.');
    return;
  }

  hud.toast('Loading…', 10_000);
  let result;
  try {
    // The server cannot know which containers this browser can decode and must
    // not guess from a User-Agent, so it is told. See server/youtube.js's
    // AUDIO_FORMATS comment for what it does with the answer.
    const codecs = canPlayOpus() ? 'opus' : 'm4a';
    const res = await fetch(
      `/api/youtube/resolve?url=${encodeURIComponent(rawUrl)}&codecs=${codecs}`,
      { cache: 'no-store' }
    );
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      hud.toast(body?.error || "Couldn't load that link.");
      return;
    }
    result = body;
  } catch {
    hud.toast("Couldn't reach the server.");
    return;
  }

  stopExternalTrack();
  music?.stop();
  externalTrack = new ExternalTrack(audio.ctx, audio, result, speakers.speakerL, speakers.speakerR);
  externalTrack.onEnded = onExternalTrackEnded;

  try {
    await externalTrack.play();
  } catch {
    hud.toast("Couldn't play that link.");
    stopExternalTrack();
    music?.start();
    musicAt = worldClock();
    speakers.setPlaying(Boolean(music?.playing));
    announceMusic();
    return;
  }
  /**
   * Marked AFTER the await, not before it.
   *
   * `resolve` can take a couple of seconds — it is a `yt-dlp` process on the
   * server — and the element then has to buffer. Timing the start from before
   * all that would tell the room the track began several seconds earlier than
   * it did, and every other machine would open it already that far in.
   */
  musicAt = worldClock();
  announceMusic();
  speakers.setPlaying(true);
  hud.toast(`♪ ${externalTrack.title}`);
}

/**
 * Stand the next speaker on the patch of ground you are looking at.
 *
 * THE SAME GESTURE AS PUTTING UP A SCREEN, down to the same march — `aimGround`
 * in world/aim.js, which the net layer used to own privately. Aim, press, it is
 * there, facing you. Left first, then right, then left again.
 *
 * MOVING A SPEAKER MOVES FOUR THINGS AND THIS IS ALL OF THEM.
 *
 * The box, its collider and its position vector are `speakers.placeNext`'s
 * business. The audio is this function's, because the sources are built here:
 * the synthesised jukebox's panner for that one cabinet, and — if a pasted link
 * happens to be playing — the same panner inside `ExternalTrack`. Both are
 * `PannerNode` coordinates, written once when the graph was built, and both
 * would otherwise go on radiating from wherever the box used to stand for as
 * long as the track lasted.
 *
 * ONLY THE ONE THAT MOVED. Rewriting both is one more parameter write and would
 * hide a real class of bug: if the indices ever stopped lining up between
 * `speakers.cabinets` and `jukeboxSources`, moving the left box would silently
 * move the right channel and nothing would ever say so.
 *
 * The shadow map is asked for by hand. It re-renders on demand rather than every
 * frame (see `shadowPending`), and a two-metre box that has just moved across
 * the clearing leaving its own shadow behind is the single most visible thing
 * that omission could produce.
 */
/**
 * The three things that follow a cabinet, wherever the move came from.
 *
 * Split out of `placeSpeaker` because a placement now arrives from two
 * directions and only one of them is a gesture. Everything below is true of
 * both; the toast, the aim and the announcement are true only of yours.
 *
 * @param {0|1} index which cabinet moved, or -1 for "both, from the network"
 */
function speakerMoved(index) {
  if (index >= 0) {
    jukeboxSources[index]?.setPosition(speakers.cabinets[index].speaker);
  } else {
    for (let i = 0; i < speakers.cabinets.length; i++) {
      jukeboxSources[i]?.setPosition(speakers.cabinets[i].speaker);
    }
  }
  externalTrack?.speakersMoved();
  renderer.shadowMap.needsUpdate = true;
}

function placeSpeaker() {
  const index = speakers.placeNext(aimGround(controller));
  speakerMoved(index);
  /**
   * Tell the room. On a solitary walk this is a no-op that costs a property
   * read — see `net.sendSpeakers` — so the gesture is exactly what it was
   * before anybody else existed.
   */
  net.sendSpeakers(speakers.placement());
  hud.toast(
    index === 0
      ? 'Left speaker here. <kbd>G</kbd> stands the right one.'
      : 'Right speaker here. <kbd>G</kbd> moves the left one again.',
    4600
  );
}

/**
 * SOMEBODY ELSE MOVED THEM, or we have just walked into a room where they were
 * already moved.
 *
 * No toast. A line of HUD text is for something you did — the four that a
 * placement produces would otherwise arrive unprompted while you are looking
 * the other way, and seven of them would arrive at once for anybody joining a
 * room mid-evening.
 *
 * `applyPlacement` returns whether anything actually moved, which is what stops
 * an echo of our own placement paying for two collider rebuilds and a shadow
 * re-render to arrive where it already was.
 */
net.onSpeakers((at) => {
  /**
   * Null is the room saying it has no opinion, which happens exactly once — on
   * the `welcome` of a room nobody has moved the speakers in. If we moved ours
   * before getting here, that makes us the authority; if we did not, both
   * answers are the built-in pair and there is nothing to say.
   */
  if (at === null) {
    if (speakers.moved) net.sendSpeakers(speakers.placement());
    return;
  }
  if (speakers.applyPlacement(at)) speakerMoved(-1);
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  // Browser chords, auto-repeat and "a dialog has the keyboard", all in one
  // place — see worldHearsKey in core/keys.js for what each of them was
  // costing here. `Q` was the worst of them: held down, it cycled the record
  // thirty times a second.
  if (!worldHearsKey(e)) return;
  switch (e.code) {
    case 'KeyE':
      interact();
      break;
    case 'KeyF':
      fishing.toggle();
      break;
    case 'KeyQ':
      if (externalTrack?.playing) {
        hud.toast('A link is playing — press E to stop it.');
        break;
      }
      if (music) {
        const track = music.next();
        if (!music.playing) music.start();
        // A new record starts at its beginning, for everybody.
        musicAt = worldClock();
        speakers.setPlaying(true);
        speakers.setHue(music.trackIndex * 1.7);
        announceMusic();
        hud.toast(`♪ ${track.name}`);
      }
      break;
    case 'KeyU':
      // preventDefault: opening the box focuses its input synchronously,
      // still inside this keydown. Without this, the browser's own
      // character-insertion for "u" lands right after — on the field that
      // just became focused — so the link starts with a stray "u".
      if (findInteractable()?.kind === 'speakers') {
        e.preventDefault();
        jukeboxInput.open();
      }
      break;
    /**
     * FROM ANYWHERE, not only while standing at the rig.
     *
     * The whole point is to be able to put a speaker somewhere else, and the
     * somewhere else is by definition not where you are standing next to one.
     * `P` and `O` work the same way for the same reason.
     */
    case 'KeyG':
      placeSpeaker();
      break;
    case 'KeyN':
      if (director.ground()) hud.toast('You take a breath. The forest settles.');
      break;
    case 'KeyM':
      // Debug convenience: eat from anywhere.
      if (debug.visible) {
        director.eat(`${SEED}:debug:${Math.floor(Date.now() / 1000)}`);
        hud.toast('…');
      }
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

const gate = document.getElementById('gate');
/**
 * Generate every noise buffer and impulse response the audio graph needs,
 * spread across idle time instead of in one block.
 *
 * Called the moment the context exists, before the shader/ground wait below
 * rather than after it, because that wait is several seconds of the main
 * thread mostly idle — polling once a frame — and every buffer here used to
 * be generated back-to-back on the exact tick `audio.start()` first produced
 * sound: the forest and cave reverb tails, the cosmos tail the trip uses, and
 * the separate noise beds ambience, wildlife and the cave layer each keep.
 * None of it needs the context to be running, only to exist, so none of it
 * has to wait for the gate to drop. By the time `attachAudio`'s own build()
 * calls run, every one of these is a cache hit — see each module's own
 * `pinkBuffer` and `impulse.js`'s `createImpulseResponse`.
 */
function warmAudioBuffers(ctx) {
  const idle = (fn) => {
    if (window.requestIdleCallback) window.requestIdleCallback(fn, { timeout: 500 });
    else setTimeout(fn, 0);
  };
  const tasks = [
    () => createImpulseResponse(ctx, 'forest'),
    () => createImpulseResponse(ctx, 'cave'),
    () => createImpulseResponse(ctx, 'cosmos'),
    () => ambienceNoise(ctx),
    () => wildlifeNoise(ctx),
    () => caveNoise(ctx),
    () => musicNoise(ctx),
  ];
  const step = () => {
    const task = tasks.shift();
    if (task) {
      task();
      idle(step);
    }
  };
  idle(step);
}

document.getElementById('enter').addEventListener('click', async () => {
  // Before anything that awaits, while the click's transient activation is
  // still live.
  if (!navigator.webdriver) {
    canvas.requestPointerLock();
  }

  /**
   * FULL RATE FROM HERE, WHICH IS EARLIER THAN THE GATE ACTUALLY LIFTS.
   *
   * Everything below this line — the terrain settle, the shader pre-warm, the
   * frames deliberately drawn while the panel is still up — is warm-up that
   * wants real frames and is the one moment in a session where a player has
   * already been told to wait. Waiting for `gone` instead would make the
   * warm-up warm the throttle. See `gateUp` and `GATE_DRAW_HZ`.
   *
   * Both adaptive controllers are then told the last few seconds were not a
   * measurement of anything: the slow one has been throwing its window away all
   * along (see `quality.auto.drawing`), and the fast one is handed the same
   * courtesy explicitly, because its window holds GPU times from ten-a-second
   * heartbeat frames and its idea of the display's cadence is derived from
   * them.
   */
  gateUp = false;
  quality.auto.disturb();
  pipeline.disturb();
  stats.discard();

  /**
   * THE TWO ANSWERS FROM THE MAIN MENU THAT THIS FILE HAS TO ACT ON.
   *
   * The other two do not come through here at all: the name and the dye are read
   * out of `core/identity.js` by the net layer at the moment it opens a socket,
   * and the wood was settled by a page load long before anybody clicked. These
   * two are the ones that are properties of a running session, so they are
   * applied on the way in — inside the click, while it is still a user gesture,
   * because opening a room writes the clipboard.
   *
   * Both are no-ops on a bare click, which is what keeps the thirty scripts in
   * scripts/ that click `#enter` on a fresh profile measuring exactly what they
   * measured before: nothing has chosen an hour, and nothing has chosen a room.
   */
  {
    /**
     * The hour, by shifting the epoch rather than pinning the clock.
     *
     * `setDayPhase` would freeze the sun where it was put — right for a
     * screenshot script and precisely wrong for a person who asked for dusk,
     * because what they want is to watch the light go rather than to stand in a
     * photograph of it. The day carries on turning at its usual twenty minutes
     * from wherever this sets it down. See `arrivalOrigin`.
     *
     * Under automation this is dead anyway: `dayPhase` returns the authored
     * phase whenever `navigator.webdriver` is set, whatever the origin says.
     *
     * Applied HERE rather than at module evaluation, and it costs nothing to
     * wait: the frame loop has been running since the page loaded and keeps
     * running behind the gate, so by the time it lifts — the terrain settles and
     * thirty-nine shader programs compile first — `atmosphere.tick` has stepped
     * the sun and eased the sky hundreds of times. The first frame anybody sees
     * is already the hour they asked for.
     */
    const origin = arrivalOrigin(Date.now(), dayScale(), CYCLE_SECONDS);
    if (origin !== null) setDayOrigin(origin);

    /**
     * The room, if one was chosen and the URL did not already deal with it.
     *
     * `lobbyCode()` is null for an invite link on purpose: `attachMultiplayer`
     * autojoined on `?room=` during module evaluation, and asking it to open a
     * room it is already in would be a second socket. See `_commit` in menu.js.
     */
    const lobby = lobbyCode();
    if (lobby) net.openRoom(lobby);
  }

  // Get the AudioContext existing now, not after the shader/ground wait
  // below, so its sample rate can drive the noise/impulse generation while
  // that wait gives the main thread room to do it without a hitch. See
  // `warmAudioBuffers`.
  const audioCtx = audio.createContext();
  if (audioCtx) warmAudioBuffers(audioCtx);

  /**
   * Warm every shader program BEFORE the gate comes down.
   *
   * three compiles a program the first time a material is actually drawn, so
   * the first frame only pays for what the spawn clearing happens to contain.
   * Measured, that is 24 programs; the scene holds 39. The other fifteen are
   * waiting for the first time you walk far enough for one of their materials
   * to enter the frame, and they will be built synchronously on that frame,
   * wherever it falls.
   *
   * It does not show up as much on a warm machine — a full instrumented walk
   * compiled one or two programs for a few milliseconds — and that is exactly
   * why it is worth pre-empting rather than dismissing. The driver keeps a
   * compiled-program cache keyed on the source, and every edit to living.js
   * invalidates the lot, so the cold case is not an unusual first run, it is
   * every run during development and every run after a patch. Cold, a program
   * that includes the whole living block is not a few milliseconds.
   *
   * The ordering is the point. `gate.classList.add('gone')` runs a fade, and a
   * stall *during* the fade is a visible hitch on the first thing the player
   * ever sees. Compiling first means the gate simply stays up a moment longer,
   * which is what a start button is for. Raced against a timeout because
   * three's compileAsync polls the driver's ready flag on a timer — a driver
   * that never reports ready would leave the gate up for ever, and a slightly
   * unwarmed forest is enormously better than a game that will not start.
   */
  /**
   * LET THE GROUND FINISH ARRIVING FIRST.
   *
   * The pre-warm and the terrain streamer were built independently and they
   * race. GroundField deliberately accepts at most one chunk per frame, so for
   * the first second or so of a session the scene is gaining meshes; compiling
   * across that produced 43 rounds of `GL_INVALID_OPERATION: Mismatch between
   * texture format and sampler type` from the driver, once per warm-up draw
   * that touched a chunk which had not been through a shadow pass yet.
   *
   * It cost an afternoon to attribute, because it is invisible in every steady
   * state — hiding layers one at a time finds nothing, and provoking every
   * quality knob by hand in a settled world reproduces nothing. It is purely a
   * property of when the call happens. Two candidate fixes appeared to work and
   * did not: both were measured against a scene that had happened to finish
   * streaming, and inverted on re-run.
   *
   * Waiting is also simply correct on its own terms. Warming the programs
   * before the ground exists cannot warm the ground's program, which is the one
   * material guaranteed to be on screen.
   */
  await new Promise((resolve) => {
    const started = performance.now();
    /**
     * `pending === 0` on its own is not "settled", it is also "not started".
     *
     * The streamer only queues work from inside `forest.cull()`, so before the
     * first frame the queue is legitimately empty and a naive test passes
     * instantly — which is exactly the state this is trying to avoid. It also
     * empties briefly between a batch completing and the next rescan, so a
     * single idle sample is not evidence either. Requiring the ring to be
     * non-empty and quiet for three consecutive frames covers both.
     */
    let quiet = 0;
    const poll = () => {
      const ground = forest.groundField;
      const trees = forest.field;
      /**
       * The forest ring as well as the ground ring. Both take at most one
       * sector per frame on purpose, so "settled" is a number of frames rather
       * than a duration, and `built > 0` is the same guard as the ground's
       * non-empty test — before the first `cull()` both queues are legitimately
       * empty and a naive check passes instantly, which is the state this is
       * trying to avoid rather than the one it is waiting for.
       */
      const settled =
        ground.pending === 0 &&
        ground.group.children.length > 0 &&
        trees.pending === 0 &&
        trees.built > 0;
      quiet = settled ? quiet + 1 : 0;
      // Bounded for the same reason the compile below is: a worker that never
      // answers must cost a colder forest, not a game that will not start.
      // 6 s rather than 4 — the first fill is ~76 sectors across two grids.
      if (quiet >= 3 || performance.now() - started > 6000) resolve();
      else requestAnimationFrame(poll);
    };
    poll();
  });

  /**
   * WARM THEM AGAINST THE TARGET THEY ARE ACTUALLY DRAWN INTO.
   *
   * This is the difference between the pre-warm working and the pre-warm being
   * a no-op that costs a second of gate time, and it is one line.
   *
   * A program's identity in three includes the OUTPUT COLOUR SPACE of whatever
   * is currently bound. `compileAsync` with nothing bound compiles for the
   * default framebuffer, which is `srgb`; this pipeline never draws the scene
   * there. It draws into `sceneTarget`, a linear HDR buffer, so every material
   * needs the `srgb-linear` variant, and the `srgb` ones the pre-warm was
   * building are thrown away unused.
   *
   * The consequence was the exact hitch this block exists to prevent, and it
   * survived here for as long as it did because the symptom looks like the
   * pre-warm merely being incomplete rather than aimed at the wrong target.
   * Measured with `npm run perf:spikes`: walking the wood compiled
   * `campfire-flame` and `campfire-embers` on first sight of a fire, at 176 ms
   * and 134 ms — by a wide margin the worst frames in the session, and the only
   * ones a player would see drop. Compiling against the default framebuffer
   * first reported nothing left to do; binding the scene target and asking
   * again immediately compiled five more programs, after which a thirty-second
   * walk compiled nothing at all.
   *
   * The bind is restored before the gate lifts, because `pipeline.render` sets
   * its own targets and would not care, but leaving a render target bound from
   * a helper is the kind of state nobody expects to inherit.
   */
  /**
   * …AND THE MATERIALS THAT ARE NOT IN THE SCENE YET.
   *
   * `compileAsync` can only warm what it can traverse to, and two things here
   * are built lazily by design: a cave passage streams in when the player comes
   * near a mouth, and a share screen does not exist until somebody shares one.
   * Both therefore compiled on the frame they first appeared — 100-180 ms, at
   * the moment of walking into somewhere dark, or the moment everyone in the
   * room turns to look at a picture.
   *
   * They are warmed in a scene of their own, with `scene` passed as the
   * lighting reference so the programs are built against the same lights the
   * real draw will use. The objects are thrown away immediately; what survives
   * is three's compiled-program cache, which is keyed on the shader source
   * rather than on the material instance.
   */
  const warm = new THREE.Scene();
  for (const o of [...caveWarmupObjects(), ...videoWarmupObjects()]) warm.add(o);

  renderer.setRenderTarget(pipeline.sceneTarget);
  await Promise.race([
    Promise.all([
      renderer.compileAsync(scene, camera),
      renderer.compileAsync(warm, camera, scene),
    ]).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  /**
   * …AND THE VARIANT THE QUALITY LADDER CAN ASK FOR LATER.
   *
   * Everything above warms the programs for the rung the game is STARTING on.
   * The Auto governor is allowed to move to three other rungs, and exactly one
   * of the knobs it moves is compiled into the program rather than uniform:
   * whether a material samples the shadow map. Cross a rung that changes it and
   * three rebuilds every affected program the next time those materials are
   * drawn — synchronously, on the main thread, on one frame.
   *
   * IT USED TO BE TWO KNOBS. `plantVeins` flipped RR_NO_VEINS on the grass and
   * fern materials and had a pass of its own here; the filaments it switched
   * were removed on 2026-08-11 and the pass went with them. The measurements
   * below are kept anyway, because they are what says this block has to exist.
   *
   * Measured on a Radeon RX 9070 XT with a cold driver cache, by flipping one
   * knob at a time and counting new `cacheKey`s: turning the shadow map off
   * built 22 programs and stopped the game for 1383 ms; turning the veins off
   * built 1 and cost 63 ms. Every later crossing of the same boundary was 12 to
   * 20 ms, because by then the variants were in the cache. So this is a
   * once-per-session cliff that lands on whichever frame the governor happens to
   * change its mind on — and the governor changes its mind when frames are
   * already struggling, which is the worst possible moment to stop for a second
   * and a half. The knob that mattered is the one that is left.
   *
   * The shadow flip is a RENDERER flag, so it cannot be faked with a throwaway
   * scene the way the cave and screen materials are — the only way to build
   * those programs is to be in that state while compiling. Which is why this
   * sits here, behind a gate that is still up: the handful of frames drawn
   * without shadows during the compile are frames nobody can see. After the
   * gate it would be a visible flicker, and before the settle above it would
   * race the terrain streamer for the reasons that block already describes.
   *
   * `atmosphere.setShadowsEnabled` is deliberately NOT called. It rebalances the
   * lights so the un-shadowed picture lands at the right luminance, which is a
   * change to what the frame is a picture of and not to any program's identity —
   * warming does not need it, and invoking it here would leave the compensation
   * to be undone again on a path where nothing was ever displayed.
   */
  const shadowsWere = renderer.shadowMap.enabled;
  const touchEveryMaterial = () =>
    scene.traverse((o) => {
      if (o.material) o.material.needsUpdate = true;
    });
  /**
   * Put the renderer into one rung's state, build that rung's programs, and
   * hand back the promise that resolves when the driver has linked them. The
   * state is NOT restored here — the caller restores after the pass has been
   * awaited, for the deletion reason set out below.
   */
  const renderThroughVariant = (enter) => {
    enter();
    return renderer.compileAsync(scene, camera).catch(() => {});
  };
  /**
   * THE AWAIT IS NOT OPTIONAL — which took a wrong version to establish, so it
   * is written down.
   *
   * `compileAsync` splits in two: `compile()` runs INLINE and is what reads
   * `shadowMap.enabled` and builds the programs, and only the wait for the
   * driver to link is deferred to the promise. Measured here: 57 ms and 33 ms
   * inline against 388 ms and 1710 ms of linking. That makes it tempting to
   * flip, start the compile, restore immediately and never await — the gate then
   * costs nothing and the flipped state is never observable, because no rAF
   * callback can land inside a synchronous run.
   *
   * It does not work, and the reason is worth knowing. Restoring re-points every
   * material at its original program, which drops the variant's `usedTimes` to
   * zero, and three deletes a program the moment nothing references it. Deleting
   * one that is still linking throws the link away. Measured, that version put
   * the stall straight back: 1361 ms on the first drop to `low`, against 16 ms
   * for this one. What makes this work is that the links COMPLETE before the
   * restore deletes them, after which re-linking the same source is a hit in the
   * browser's own program cache — verified on a cold profile, which is what
   * every run of the harness uses.
   *
   * THE LOOP IS KEPT FOR ITS ONE ENTRY, and so is this paragraph, because the
   * rule it records is the one a second variant would break: passes run IN
   * SEQUENCE, never together. Starting two and awaiting them as a pair links
   * them in parallel and looks like a free 400 ms — but the second pass rebuilds
   * every material, which releases the first pass's programs while they are
   * still linking, and deletes exactly what it was there to build. Measured back
   * when there were two: `low` came out warm at 13.7 ms and `medium` went back
   * to 67 ms with one program compiled on the frame, which is the variant pass
   * one had built and pass two had thrown away.
   */
  for (const enterVariant of [
    () => {
      renderer.shadowMap.enabled = false;
      touchEveryMaterial();
    },
  ]) {
    await Promise.race([
      renderThroughVariant(enterVariant),
      // A driver that never reports ready must cost a colder ladder, not a game
      // that will not start. Same discipline as the pass above.
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }

  renderer.shadowMap.enabled = shadowsWere;
  touchEveryMaterial();
  /**
   * The restore rebuilds every material one more time — and costs nothing,
   * because the programs it asks for are the ones the first pre-warm already
   * built and `getProgram` matches on `cacheKey`, not on the material. The
   * shadow map is re-armed because it was switched off while it was being
   * warmed and the first visible frame must not inherit that.
   */
  renderer.shadowMap.needsUpdate = true;

  renderer.setRenderTarget(null);
  for (const o of warm.children) o.geometry?.dispose();

  gate.classList.add('gone');

  const ok = await audio.start();
  if (!ok) {
    hud.toast('No audio available in this browser.');
    return;
  }

  music = new Jukebox(audio.ctx, null);
  /**
   * If the room told us what was playing while we were still behind the gate,
   * play it now. Deferred to the end of `startAudio` rather than run here,
   * because the spatial sources the jukebox comes out of are built further down
   * this same function and `applyMusic` positions them.
   */
  const roomMusic = pendingMusic;
  pendingMusic = undefined;
  /**
   * ON THE MUSIC BUS. It was on the world bus, and that is why two volume
   * sliders were wrong at once.
   *
   * `createSpatial` defaults to `worldBus` — correct for everything else that
   * calls it, and wrong for the one source in the app that is music. Nothing
   * else fed `musicBus`, so the effect was that the **Music slider did nothing
   * at all** while the **World slider turned the jukebox up and down** along
   * with the wind and the birds. Reported by a player in exactly those words.
   *
   * The room send taps the trims, so the reverb follows the music trim now
   * rather than the world one — which is the behaviour `engine.js` describes
   * when it explains why the send is downstream of the trim.
   */
  /**
   * OUT OF BOTH SPEAKERS, AT HALF EACH, AND THE HALF IS NOT 0.707.
   *
   * `Jukebox` sums to mono, so what reaches the two panners is literally the
   * same signal twice — correlated, and correlated signals add by amplitude.
   * The equal-power pair that is right for crossfading two different things
   * would come back 3 dB hot here, and 3 dB is enough to move the synth
   * jukebox's balance against the wind and the birds, which is a mix decision
   * that was made deliberately and lives in `engine.js`. `external-track.js`
   * has the long version of this argument.
   *
   * `createSpatial` returns its input node, which is already a GainNode, so
   * the trim needs no node of its own.
   *
   * `cabinet.speaker` is a vector the speaker MUTATES rather than replaces when
   * the player stands it somewhere else, but a `PannerNode` reads its position
   * once — so the panner is re-pointed by hand on the keypress. See
   * `placeSpeaker`.
   */
  jukeboxSources = speakers.cabinets.map((cabinet) => {
    const source = audio.createSpatial(cabinet.speaker, {
      refDistance: 4.5,
      rolloff: 1.25,
      maxDistance: 150,
      bus: audio.musicBus,
    });
    source.input.gain.value = 0.5;
    return source;
  });

  /**
   * FULL RANGE INTO BOTH, WHICH IS WHAT IT WAS BEFORE THERE WAS A THIRD BOX AND
   * IS WHAT IT IS AGAIN.
   *
   * There was a fourth-order Linkwitz-Riley crossover here, sending everything
   * below 110 Hz to a subwoofer standing between the two cabinets. It is gone at
   * the player's request, and the deletion took the crossover with it because
   * nothing else in the app ever wanted one.
   *
   * FOR THE SYNTH IT IS EXACTLY LEVEL-NEUTRAL, and that is not luck — it is the
   * property the crossover was built to have, read backwards. The low end was
   * MOVED rather than copied, precisely because this mix has a limiter five
   * decibels from the top and a documented history of pumping the moment
   * anything is added down there; the sub was matched to the pair's own distance
   * model for the same reason, after a first attempt at giving it a longer reach
   * was measured costing four and a half decibels of extra low end into
   * `trims.music`, where `trip-audio.js` taps. `Jukebox` sums to mono, so the two
   * sources at 0.5 each are correlated and sum by amplitude to exactly the 1.0
   * the sub was being fed.
   *
   * A PASTED RECORD IS THE CASE WHERE IT IS NOT, by 1.55 dB, because its low band
   * takes two paths rather than one and the sub's gain was fitted to those two
   * paths at a cabinet mix nobody uses any more. Measured, and measured again at
   * the limiter, where it turns out to cost nothing — `external-track.js` and
   * `world/speakers.js` have the numbers. That is the file to suspect if the low
   * end ever sounds different, not these two lines.
   */
  for (const source of jukeboxSources) music.output.connect(source.input);

  ambience = new Ambience(audio);
  // Where the river is in THIS world, not where it was in the authored one.
  // The player is at the origin when this runs, so the nearest point of the
  // channel to them is the right place to hang the stream's first position.
  {
    const bank = streamPointNear(controller.position.x, controller.position.z);
    ambience.build(new THREE.Vector3(bank.x, bank.y, bank.z));
  }
  controller.onStep = (strength) =>
    ambience.step(strength, wetness(controller.position.x, controller.position.z));
  controller.onBrush = (position, strength) => ambience.brush(position, strength);

  // Rock underfoot rings where leaf litter thuds, and `captureStep` wraps the
  // controller's own callback rather than replacing it — the forest footsteps
  // above must keep working outside.
  caveAudio = new CaveAudio(audio);
  caveAudio.build();
  caveAudio.captureStep(controller);

  tripAudio = new TripAudio(audio);
  tripAudio.build();

  // Handing the jukebox over as well is what lets the birdsong find its key
  // during a trip; without it the birds sing in their own tuning.
  fauna.attachAudio(audio, music);

  /**
   * Nothing to wire up for the screens here.
   *
   * A film's soundtrack still arrives through a PannerNode standing at the
   * screen, so it gets quieter and duller as you walk away — exactly the way the
   * jukebox does, and for exactly the reason `jukebox.js` gives: being able to
   * hear where something is happening from the far side of the wood is a real
   * navigational aid, and it is the entire difference between watching something
   * here and watching it in a browser tab. But the screens are built by the net
   * layer, when somebody shares, which can be long after this line — so it
   * attaches its own audio and retries until the context exists. See the
   * `audio?.ready` block in `net/index.js`.
   */

  director.audio = tripAudio;
  director.jukebox = music;

  /**
   * THE ROOM'S RECORD WINS OVER THE DEFAULT ONE.
   *
   * Arriving to a forest that already has something playing in it is a much
   * better first thirty seconds than arriving to silence, which is why the
   * jukebox starts itself. In a room, "what is already playing" is a real
   * question with a real answer rather than a default — and starting track 0
   * from bar 1 and then correcting to track 3 at bar 340 would be an audible
   * stumble in the first second anybody hears.
   *
   * `pendingMusic` was captured at the top of this function and covers three
   * cases at once: a room playing a record, a room playing a pasted link, and
   * a room deliberately silent — that last one is why it is a null CHECK
   * rather than a truthiness check, because `null` here means somebody turned
   * the music off and we must not start it again.
   */
  if (roomMusic !== undefined && net.status === 'live') {
    applyMusic(roomMusic);
    if (roomMusic) hud.toast('Somewhere in the trees, a jukebox is playing.', 5200);
  } else {
    music.start();
    musicAt = worldClock();
    speakers.setPlaying(true);
    announceMusic();
    hud.toast('Somewhere in the trees, a jukebox is playing.', 5200);
  }

});

// ---------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------

const clock = new Clock();
const _streamPoint = new THREE.Vector3();

const PROMPT_JUKEBOX_PLAYING = `<kbd>E</kbd> stop · <kbd>Q</kbd> next track · <kbd>U</kbd> paste a link`;
const PROMPT_JUKEBOX_STOPPED = `<kbd>E</kbd> play the music · <kbd>U</kbd> paste a link`;
const PROMPT_JUKEBOX_EXTERNAL = `<kbd>E</kbd> stop and go back to the record`;
const PROMPT_EAT = `<kbd>E</kbd> eat`;
const PROMPT_SIT = `<kbd>E</kbd> sit down`;
const PROMPT_FERRY = `<kbd>E</kbd> step aboard`;
const PROMPT_ROD = `<kbd>F</kbd> take out a rod`;
/**
 * Keyed by the rod's own state, so the prompt is a readout rather than a menu.
 *
 * The bite line is deliberately the shortest and loudest of the four. A person
 * who has been talking for twenty seconds and glances back at the screen has to
 * be able to read it in the time the window is open, which is 1.6 seconds.
 */
const PROMPT_FISH = {
  ready: `hold <b>left mouse</b> to load a cast · <kbd>F</kbd> put it away`,
  loading: `let go to throw`,
  // No entry for `flight`, and that is the point: the tackle is in the air and
  // there is nothing anybody can do about it. `?? null` at the call site hides
  // the prompt entirely for the second it takes to land.
  waiting: `<b>right mouse</b> to wind · <kbd>E</kbd> reel in`,
  bite: `<b>click</b> — <b>now</b>`,
  landed: `<b>click</b> to slip it back`,
};
/**
 * The fight, and this is where it is taught.
 *
 * FOUR STRINGS, AND THE FOURTH ONE IS LOAD-BEARING. They are keyed off two
 * fields — `fishing.surge`, is it running, and `fishing.lean`, which way to
 * sweep the rod — because keying them off `lean` alone was a real bug rather
 * than an untidiness. Zero meant both "it is resting, wind away" and "it is
 * running and you have the rod exactly right", which are opposite instructions,
 * so the screen told players to wind at the precise moment they had got the
 * lean correct — and winding through a big fish's run is what breaks the line.
 * Somebody following this prompt perfectly lost half the pike they hooked. See
 * the note at `surge` in fishing.js.
 *
 * The rule of the fight is not obvious from first principles and a tutorial for
 * a thing you do while talking to somebody is out of the question, so the prompt
 * says the next thing to do and nothing else. Two or three fish and nobody reads
 * it any more, because by then the rod is doing the telling.
 *
 * Hoisted like the rest for the reason the comment at the call site gives: this
 * is fed to `setPrompt` every frame, and building the string there would be four
 * allocations a frame to hand it something it discards.
 */
const PROMPT_PLAY = `hold <b>right mouse</b> to wind it in`;
const PROMPT_PLAY_LEFT = `it runs — lean <b>←</b>`;
const PROMPT_PLAY_RIGHT = `it runs — lean <b>→</b>`;
const PROMPT_PLAY_HOLD = `hold it there`;

/** Seconds between trip-readout redraws. See the call site. */
const HUD_INTERVAL = 1 / 6;
let hudAccum = HUD_INTERVAL;

/**
 * A shadow map re-render that has been held back by one frame.
 *
 * The two things that cost anything when you move — the instance repack and
 * the shadow map — are triggered by the same event, so they land on the same
 * frame and their costs add: ~1.7 ms and ~3.2 ms on top of a 2.4 ms frame is
 * one frame at three and a half times the budget. Held apart they are two
 * frames at roughly twice it, which is the difference between a hitch and a
 * ripple. The delay is bounded at exactly one frame, so the map is at worst
 * one frame's walking — under 4 cm — staler than it would have been.
 */
let shadowPending = false;

/**
 * THE PERFORMANCE INSTRUMENT'S ONE FOOTHOLD IN THE FRAME LOOP.
 *
 * Null in every build that ships. `src/dev/perf/` sets it, and while it returns
 * true this loop does nothing at all — the instrument is driving `pipeline.render`
 * itself, in batches, inside GPU timer queries, and a real frame landing in the
 * middle of a batch would move the camera, advance the wind, repack instances
 * and re-render the shadow map underneath the measurement.
 *
 * It is a function rather than a boolean so that the flag lives in the module
 * that owns it and this file cannot be left holding a stale copy of it.
 *
 * `__PERF__` is a build-time literal (see vite.config.js). In the shipping
 * build it folds to `false`, the `&&` short-circuit becomes unreachable, and
 * esbuild deletes both this test and the import block at the bottom of the file
 * — so the cost of this to a player is zero bytes, not one comparison a frame.
 */
let perfHold = null;

/**
 * The one line under the chat log that says what is showing and how to change it.
 *
 * Recomputed every frame and thrown away when it has not changed —
 * `social.setBar` compares against what it drew last and returns immediately,
 * which is the same early-out `hud.setPrompt` uses and for the same reason: this
 * is a DOM write on the frame path.
 *
 * Only drawn when there is something to say. On a solitary walk with nothing
 * shared it is hidden entirely, which is the rule the whole social layer obeys —
 * see the header of `src/ui/social.js`.
 */
function updateShareBar() {
  const mine = net.sharing;
  if (mine) {
    const what = mine.kind === 'film' ? 'Playing' : 'Sharing';
    /**
     * The bar is a READOUT of the state you are in plus the ways out of it, and
     * there is only one state to be in now. It used to branch on held versus
     * placed; a screen is always placed, so the line is always the same three
     * things — how wide it is, and the two keys that change that.
     *
     * The width is the live number and it earns its place: it is what a wheel is
     * changing while somebody watches this line, and it is the only part of a
     * placement that is not obvious from looking at the thing itself.
     */
    social.setBar(
      `${what}, ${mine.width.toFixed(1)} m · scroll to resize · <kbd>O</kbd> move · <kbd>P</kbd> stop`
    );
    return;
  }
  const others = net.peers.filter((p) => p.present).length;
  if (others) {
    social.setBar(others === 1 ? 'Someone is showing something' : `${others} screens are up`);
    return;
  }
  if (net.status === 'live') {
    social.setBar('<kbd>P</kbd> share a screen · drop a film in');
    return;
  }
  social.setBar(null);
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(BASE_PIXEL_RATIO * renderScale);
  renderer.setSize(w, h);
  pipeline.setSize(w, h, renderer.getPixelRatio());
  atmosphere.motes.material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  // The midges and fireflies are point sprites too, and size in pixels means
  // nothing until you know how many of them there are per CSS pixel.
  fauna.setPixelRatio(renderer.getPixelRatio());
  caves.setPixelRatio(renderer.getPixelRatio());
  // Embers are point sprites for the same reason and with the same problem.
  gathering.setPixelRatio(renderer.getPixelRatio());
}
window.addEventListener('resize', resize);
resize();

/**
 * performance.now() of the last frame whose body actually ran — see the
 * throttle at the top of frame(). Unused while uncapped.
 */
let lastFrameAt = 0;

/**
 * How often the world is DRAWN while the main menu is covering it, and the
 * clock that enforces it. See `gateUp`.
 *
 * A heartbeat rather than nothing at all, and the number is not arbitrary. The
 * terrain streamer accepts one chunk per frame and its buffers are uploaded to
 * the GPU the first time something draws them, so a gate that never drew would
 * bank every upload in the session and hand the whole pile to the first frame
 * after the fade — trading a fan for a hitch on the first thing anybody sees.
 * Ten a second keeps each arriving chunk under a tenth of a second from its
 * upload while costing a twentieth of what this used to on a 200 Hz display.
 *
 * Deliberately NOT the `fpsLimit` throttle above, which skips the whole frame
 * body. Streaming, the sun and the wind all live in that body, and slowing them
 * to 10 Hz would mean a player who lingers on the menu arrives at a world that
 * has not finished arriving — moving the cost from a place nobody minds it to
 * the one place the project has spent real effort keeping clear.
 */
const GATE_DRAW_HZ = 10;
let lastGateDraw = 0;

function frame() {
  requestAnimationFrame(frame);

  // Held while the performance instrument owns the renderer. See `perfHold`.
  if (__PERF__ && perfHold?.()) return;

  /**
   * The frame-rate cap. rAF itself cannot be slowed — the browser calls every
   * registered callback on every vsync tick regardless of what any of them
   * do — so this still re-registers every tick and instead skips the actual
   * work (simulation, audio, render) until enough wall-clock time has passed.
   * That also means the Auto governor's OWN independent rAF loop in
   * core/quality.js is never touched by this: it keeps sampling the display's
   * true tick rate and correctly judging headroom no matter what cap the
   * player has chosen here, which is deliberate — see the comment on the
   * `fpsLimit` knob for why a self-imposed cap must never read as "this
   * machine has headroom" to Auto.
   *
   * The 1 ms slack matters at a cap equal to the display's own rate: without
   * it, jitter in when rAF actually fires means a tick can land a fraction of
   * a millisecond short of the target interval, get skipped, and the NEXT
   * tick then arrives ~2 intervals late — alternately skipping and firing,
   * i.e. capping a 60 Hz display to 60 fps silently halves it to 30.
   *
   * `fpsLimit > 0` is a defensive floor, not a real state the slider can
   * reach — its own minimum is 30 — but the module-level default is 0 for the
   * brief window before `quality.register` applies the stored or default
   * value, and 0 has to mean "don't throttle" rather than "divide by zero and
   * freeze the game".
   */
  if (fpsLimit > 0 && fpsLimit < FPS_LIMIT_UNCAPPED) {
    const now = performance.now();
    if (now - lastFrameAt < 1000 / fpsLimit - 1) return;
    lastFrameAt = now;
  }

  const dt = clock.tick();

  /**
   * Sample the world's clock once, here, before anything reads it.
   *
   * ONCE PER FRAME IS A CORRECTNESS REQUIREMENT. `uTime` and `uWind` are
   * written from two different call sites a few hundred microseconds apart; if
   * each took its own `Date.now()` the water and the leaves would sit on clocks
   * that disagree by a sub-millisecond amount that changes every frame, which
   * is invisible in a still and reads as a shimmer in motion. See
   * core/world-clock.js.
   *
   * Above `controller.update` because everything downstream of this line is
   * entitled to assume the clock has been read for this frame.
   */
  tickWorldClock();

  controller.update(dt);

  /**
   * THE FERRY MOVES BEFORE ANYBODY SITTING ON IT DOES.
   *
   * Its seats are children of the raft, so they are wherever the raft is — and
   * a body eased toward a seat that has not been moved yet is a body chasing
   * last frame's raft, which at 1.9 m/s is 3 cm of lag every frame and reads as
   * the passenger sliding backwards along the deck. `seats.update()` then
   * re-resolves the moving seats into world space so that
   * `sitting`, `findInteractable` and the prompt all ask the same question of
   * the same frame.
   */
  ferry?.update(dt);
  seats.update();

  /**
   * …and sitting overrides the controller AFTER it has run and BEFORE the camera
   * is written.
   *
   * Same relationship the cave walls have with the height field: the more
   * specific constraint runs last and wins. Doing it by disabling the controller
   * instead would need a special case on the frame you stand up, because the
   * body has to resume from somewhere.
   */
  sitting.update(dt);
  controller.applyToCamera();

  // Wind runs on its own clock and never stops, so the forest is alive when
  // sober and a trip amplifies something that was already there.
  //
  // `debug.windScale` is the debug panel's own multiplier on that clock, and it
  // is deliberately a separate number from `debug.speed`: the trip clock is a
  // five-minute envelope you seek through, and the wind is the thing that never
  // stops, whose two useful debug settings are 0 (hold every plant still so two
  // frames can be differenced) and 3 or 4 (see what a gust does without standing
  // in the wood waiting for one). `probe.freeze` still stops it outright.
  //
  // The SCALE now goes in as its own argument rather than pre-multiplied into
  // `dt`, because the baseline it modifies is no longer integrated: the wind's
  // shared component is read off the room's clock and only the deviations —
  // this knob and the trip's gust — accumulate. Passing `dt * windScale` would
  // scale the deviations and silently leave the baseline at 1x, which looks
  // like the knob half working. See `updateWind`.
  updateWind(probe.frozen ? 0 : dt, director.level, debug.windScale);

  const levels = audio.ready ? audio.sampleLevels(dt) : null;

  // The debug panel's speed control multiplies the trip's clock only. The
  // world's wind, the music and the walking all stay at real time, which is
  // what makes a 20x seek useful rather than a comedy.
  director.update(dt * (debug.speed || 0), { camera, audioLevels: levels });

  // The sky rides on the camera; the shadow volume rides on the BODY. The
  // camera is up to 1.35 m of trip dolly away from the body and swings around
  // it as you turn, and every time that crossed an anchor boundary the whole
  // shadow map re-rendered — while standing still. See atmosphere.follow.
  atmosphere.follow(camera, controller.position);
  atmosphere.tick(dt);

  if (audio.ready) {
    audio.updateListener(camera, dt);
    if (jukeboxSources.length || externalTrack) {
      /**
       * PER SPEAKER, NOT TO A SHARED MIDPOINT.
       *
       * This measured one distance — to the middle of the single machine — and
       * handed it to everything, which was right when there was one machine and
       * two speaker anchors 1.1 m apart. With the boxes metres apart, walking up
       * to one of them has to make that one brighter and closer while the other
       * stays where it is; a shared distance would damp both by the average and
       * delete the thing the second cabinet was added for. That was true when
       * the separation was fixed at 5.6 m and it is more so now that a player can
       * put forty metres between them.
       *
       * `cabinets[i].speaker` is re-read every frame rather than captured,
       * which is the whole of what this loop needs to know about the speakers
       * being movable: the vector is mutated in place when one is stood
       * somewhere else.
       *
       * Both the synth and a pasted link are updated, and only one of them is
       * ever audible (see `submitJukeboxUrl`) — the idle one costs two writes to
       * a parameter nothing is listening to.
       */
      for (let i = 0; i < jukeboxSources.length; i++) {
        jukeboxSources[i].setDistance(camera.position.distanceTo(speakers.cabinets[i].speaker));
      }
      // Distance AND bearing: a stereo record has to know which way the player
      // is facing, not just how far away they are. See external-track.js.
      //
      // And how far into the trip it is, which is what decides how much that
      // bearing still counts for — the record leaves the cabinets and arrives
      // in your head as the level climbs. Before `setListener`, so a frame's
      // aiming already knows this frame's trip rather than the last one's.
      // Gated on the same debug switch the rest of the trip's audio is, so
      // turning it off puts the record back on the cabinets along with
      // everything else. Without that, the one trip effect living outside
      // `trip-audio.js` would be the one the switch could not reach.
      externalTrack?.setTrip(director.switches.audio ? director.level : 0);
      externalTrack?.setListener(camera);
    }
    if (ambience) {
      /**
       * Follow the stream: the nearest point of the channel to the player, so
       * the water is a line source rather than a point somewhere behind you.
       *
       * This used to be the literal `26 + sin(x * 0.022) * 22`, which is a
       * transcription of the AUTHORED river. Now that every session gets its
       * own world, that literal put the sound of running water three hundred
       * metres from any water — audible, convincing, and nowhere near the
       * stream you can see. `streamPointNear` asks the terrain where its river
       * actually is, so the two can no longer disagree.
       */
      const bank = streamPointNear(controller.position.x, controller.position.z);
      _streamPoint.set(bank.x, bank.y, bank.z);
      ambience.setStreamPosition(_streamPoint);
      ambience.setListenerDistanceToStream(camera.position.distanceTo(_streamPoint));
      ambience.update(dt, {
        gust: clamp01(0.35 + 0.4 * Math.sin(tripUniforms.uWind.value.x * 0.35)),
        canopy: 0.6,
        tripLevel: director.level,
      });
    }
    // The camera as well as the clock: the pair's one lamp slides along the line
    // between the two boxes to whichever end the player is at. See speakers.js.
    speakers.tick(dt, camera, audio.levels, tripAudio?.weight ?? 0);
  }

  /**
   * What everybody else can see you doing.
   *
   * Set before `net.update`, which is the tick that sends it, and composed here
   * rather than inside the net layer because these are facts about a seat
   * registry and a fishing rod that `attachMultiplayer` is deliberately not
   * given — the same reason it reads the trip level out of the shared uniform
   * block instead of being handed the director.
   */
  net.setPose(
    (sitting.seated ? FLAG_SITTING : 0) |
      (fishing.state !== 'off' ? FLAG_FISHING : 0) |
      /**
       * The bite bit covers the fight too, and no new bit was needed: the flag
       * is documented in `protocol.js` as "something is on the line right this
       * second", which is true for both the strike window and the twenty
       * seconds after it. So a remote avatar's rod bends and its arms lift for
       * the whole of somebody else's fight, which is the part worth seeing from
       * across the river, and the byte is unchanged.
       */
      (fishing.state === 'bite' || fishing.state === 'playing' ? FLAG_BITE : 0)
  );

  // After the audio block so the WebAudio listener is already at this frame's
  // camera when the per-peer panners are moved against it.
  net.update(dt);

  /**
   * The social world: fires, the raft's lantern, the rod, the log.
   *
   * After `net.update` because a shared screen's audio panner has to be moved
   * against a listener that is already at this frame's camera — the same
   * ordering constraint the per-peer voices have, for the same reason — and
   * because a screen somebody is carrying is positioned from an avatar the net
   * layer has only just interpolated.
   */
  gathering.update(probe.frozen ? 0 : dt, camera);
  gathering.setNight(atmosphere.day.dark());
  /**
   * The shared screens want the same curve the fires do, from the other end.
   *
   * An empty screen is painted canvas rather than a switched-off television (see
   * video-surface.js), so it has to know what time it is or a screen somebody
   * has put up and not yet filled is a white slab glowing in a dark clearing.
   * Driven off `day.dark()` like everything else, so a fire cannot be at
   * midnight while a canvas is at noon.
   */
  net.setDaylight(1 - atmosphere.day.dark());
  fishing.update(dt);
  social.tripLevel = director.level;
  social.update(dt);

  /**
   * The bell, on arrival.
   *
   * `ferry.state.arrived` is true for exactly one frame — the raft's position is
   * a pure function of the clock, so "has it just docked" has to be derived by
   * comparing this frame's leg against last frame's rather than by an event
   * nobody fires. Only announced when you are near enough to have heard it.
   */
  if (ferry?.state.arrived && ferry.distanceTo(controller.position.x, controller.position.z) < 46) {
    hud.toast('The ferry comes alongside.', 3200);
  }

  // Frozen by the same switch as the wind, so `isolate.mjs` can hold a deer
  // still to photograph it. The trip level reaches the animals as well as the
  // plants — a forest whose trees breathe while its birds fly on rails reads
  // as two worlds superimposed.
  fauna.setObservers(faunaObservers());
  fauna.update(probe.frozen ? 0 : dt, { camera, tripLevel: director.level });
  /**
   * The river's own fish, after the rod so a cast that has just landed has
   * already told them about it, and frozen by the same switch as the rest of the
   * world so `isolate.mjs` can photograph one.
   *
   * Driven from the BODY rather than the camera. The camera is up to 1.35 m of
   * trip dolly away from where the player actually is, and everything this reads
   * the position for — which fish to recycle, whether the shoal is awake at all
   * — is a question about the person, not the viewpoint.
   */
  shoal.update(probe.frozen ? 0 : dt, controller.position);
  announceFauna();

  /**
   * The trip readout does not need to be redrawn 240 times a second.
   *
   * setTrip writes four DOM properties — two inline opacities, a text node and
   * a bar width — and every one of them is a style invalidation that the
   * browser has to reconcile against the compositor before the frame goes out.
   * It is describing a five-minute envelope on a bar a few hundred pixels
   * wide, so a sixth of a second between updates is under one pixel of travel
   * and nobody can see the difference. `describe()` also allocates, which at
   * frame rate is a steady drip into the nursery for no reason.
   */
  hudAccum += dt;
  if (hudAccum >= HUD_INTERVAL) {
    hudAccum = 0;
    hud.setTrip(director.describe());
  }

  const target = findInteractable();
  // The strings are constants, hoisted, because building them per frame is
  // three allocations to hand setPrompt something it will usually discard —
  // it already early-returns when the prompt has not changed.
  if (target?.kind === 'fish') {
    hud.setPrompt(
      fishing.state === 'playing'
        ? !fishing.surge
          ? PROMPT_PLAY
          : fishing.lean < 0
            ? PROMPT_PLAY_LEFT
            : fishing.lean > 0
              ? PROMPT_PLAY_RIGHT
              : PROMPT_PLAY_HOLD
        : (PROMPT_FISH[fishing.state] ?? null)
    );
  } else if (target?.kind === 'sit') {
    hud.setPrompt(PROMPT_SIT);
  } else if (target?.kind === 'ferry') {
    hud.setPrompt(PROMPT_FERRY);
  } else if (target?.kind === 'speakers') {
    hud.setPrompt(
      externalTrack?.playing
        ? PROMPT_JUKEBOX_EXTERNAL
        : music?.playing
          ? PROMPT_JUKEBOX_PLAYING
          : PROMPT_JUKEBOX_STOPPED
    );
  } else if (target?.kind === 'mushroom') {
    hud.setPrompt(PROMPT_EAT);
  } else if (!sitting.seated && fishing.water && fishing.state === 'off') {
    hud.setPrompt(PROMPT_ROD);
  } else {
    hud.setPrompt(null);
  }

  updateShareBar();

  // Keep the player above ground even if a trip effect nudged the camera into
  // a slope: the body is authoritative, the camera is decoration.
  /**
   * THE FLOOR IS NOT ALWAYS THE GROUND ANY MORE.
   *
   * This clamp exists so a trip effect cannot nudge the camera into a slope —
   * the body is authoritative, the camera is decoration. Underground it was
   * exactly wrong: `groundUnder` returns the HILLSIDE, so walking into a cave
   * shoved the camera up through ten metres of rock and out onto the mountain.
   *
   * `caveFloorUnder` is `groundUnder` bit for bit when no cave is live — one
   * array-length test — and the `y` argument is load-bearing rather than
   * defensive: standing on the hillside directly above a shallow passage must
   * give you the hillside, and only the camera's own height can distinguish
   * those two cases.
   */
  /**
   * …and it is skipped entirely while the debug panel is flying the body.
   *
   * The clamp is the last word on where the camera may be, so without this a
   * flying camera is shoved back up to the hillside the instant it goes under
   * it — which makes "fly" a control that works in one direction only. The
   * controller's own floor clamp is skipped for the same reason and in the same
   * breath; see `fly` in player/controller.js.
   */
  const floor =
    caveFloorUnder(camera.position.x, camera.position.z, camera.position.y) + 0.35;
  if (!controller.fly && camera.position.y < floor) camera.position.y = floor;

  /**
   * Crossing the mouth.
   *
   * `caveMix` is eased rather than stepped because three expensive things ride
   * on it — the fog, the reverb crossfade and whether the wood is submitted at
   * all — and a step in any of them is a visible or audible click. The depth
   * term means a shallow alcove never goes fully dark.
   *
   * `occludeWorld` is the one that matters for the frame: underground the
   * forest is all around you and the frame is vertex-bound, so drawing rock in
   * front of it wins the fragment battle and does nothing about fourteen
   * million vertices behind it. Not submitting the wood took 6.57 ms to
   * 0.66 ms at 138 m in. It is gated on a per-cave MEASURED blind distance —
   * the bend that actually hides the entrance — not on a guessed depth, and a
   * straight passage reports Infinity and is never hidden.
   */
  caves.update(camera, dt);
  {
    /**
     * THE CONTAINMENT TERM IS SATURATED, AND IT HAS TO BE NOW THAT ROOMS EXIST.
     *
     * `inCave` is a ramp across the passage, so it reads about 0.5-0.6 in the
     * middle of a wide chamber — which is correct for what it was built for (a
     * squeeze IS more enclosed than a hall, and the reverb should say so) and
     * catastrophic as a proxy for "am I underground". Everything below keys off
     * `caveMix`: the fog, whether the wood is submitted, and `buried`, which
     * hides the world's water plane, its sun shafts and its mist.
     *
     * At 0.5 the old expression never reached the 0.55 `buried` threshold, so
     * standing in a breakdown chamber sixty metres inside a mountain drew the
     * river's surface across the whole screen — from underneath. Dividing by
     * 0.55 first means anything meaningfully inside the passage counts as
     * inside, and DEPTH is left as the only thing that decides how far in you
     * are, which is what it was always the honest measure of.
     */
    const enclosed = clamp01(controller.inCave / 0.55);
    const target =
      controller.inCave > 0
        ? clamp01(enclosed * (0.25 + 0.75 * Math.min(1, controller.caveDepth / 26)))
        : 0;
    caveMix += (target - caveMix) * Math.min(1, dt * 3.2);
    // Composed inside atmosphere's `_recompose` alongside the hour and the
    // view-distance knob, because all three write the same fog and none of them
    // may assign it. Verified to return bit-exact to the authored density at
    // caveT = 0, and to multiply with the knob rather than clobber it.
    atmosphere.setCave(caveMix);
    caves.setFog(atmosphere.fog.color, atmosphere.fog.density);
    /**
     * …and the hour, for the rock standing outside the mouth.
     *
     * The sun is anchored to the player and its target moves with them, so the
     * DIRECTION is position minus target and not the position: at a hundred
     * metres from the anchor those differ by enough to light the crag from the
     * wrong side. The 0.45 and 0.3 are the same scaling the standard materials
     * get from three's own lighting — matched by eye against the terrain the
     * crag comes out of, which is the only surface it is ever seen against.
     */
    _caveSunDir.copy(atmosphere.sun.position).sub(atmosphere.sun.target.position).normalize();
    _caveSun.copy(atmosphere.sun.color).multiplyScalar(atmosphere.sun.intensity * 0.45);
    _caveSky.copy(atmosphere.hemi.color).multiplyScalar(atmosphere.hemi.intensity * 0.3);
    _caveGround.copy(atmosphere.hemi.groundColor).multiplyScalar(atmosphere.hemi.intensity * 0.3);
    caves.setDaylight(_caveSunDir, _caveSun, _caveSky, _caveGround);
    const buried = caveMix > 0.55;
    atmosphere.water.mesh.visible = !buried;
    atmosphere.shafts.group.visible = !buried;
    atmosphere.mist.layers.visible = !buried;
    if (caves.occludeWorld(forest, caveMix, controller.caveDepth)) {
      renderer.shadowMap.needsUpdate = true;
    }
    /**
     * …and what the passage is like where the body is standing.
     *
     * The reverb size, the draught and the stream all come from the same
     * `caveSample` the movement already ran this frame — see the block in
     * `controller._resolveCave`. Passing them rather than re-sampling here is
     * what keeps the sound and the geometry describing the same place: a second
     * scan a few lines later would be a frame behind on the one transition
     * (walking into a squeeze) the whole thing exists to make audible.
     */
    caveAudio?.update(
      dt,
      caveMix,
      controller.caveDepth,
      controller.caveTight,
      controller.caveRoom,
      controller.caveWater
    );
  }

  // Last, once the camera is final for this frame: repack the instanced
  // layers so the GPU is only handed what this camera can see.
  // `?? 1` so that a culler without the counter degrades to the old, more
  // conservative behaviour rather than silently never deferring.
  const uploaded = forest.cull(camera) && (forest.culler?.uploaded ?? 1) > 0;
  /**
   * …and then keep the frame that did the repacking from also carrying the
   * shadow map. See `shadowPending`.
   *
   * The pending case is tested FIRST, and unconditionally, which is what makes
   * the delay exactly one frame rather than "until a frame turns up that did
   * no uploading". Written the other way round, a fast mouse flick — which
   * repacks on every frame — would defer the shadow map for as long as the
   * flick lasted, and stale shadows are a correctness bug where one late frame
   * is not.
   *
   * The condition is on instances actually re-uploaded rather than on the
   * culler's threshold firing: since the packer became incremental most
   * repacks move no bytes at all, and there is nothing to hold apart from.
   */
  if (shadowPending) {
    renderer.shadowMap.needsUpdate = true;
    shadowPending = false;
  } else if (uploaded && renderer.shadowMap.needsUpdate) {
    renderer.shadowMap.needsUpdate = false;
    shadowPending = true;
  }

  /**
   * …and finally the frame itself — ten a second while the menu is on top of
   * it, every tick once somebody has committed. See `gateUp`.
   */
  if (gateUp) {
    const now = performance.now();
    if (now - lastGateDraw < 1000 / GATE_DRAW_HZ) return;
    lastGateDraw = now;
    /**
     * AND THE TWO READOUTS ARE NOT TOLD ABOUT IT.
     *
     * Both describe frames a player is looking at. `stats.update` is documented
     * as "once per rendered frame", plots wall-clock intervals, and keeps a
     * 16384-sample ring that the 1% and 0.1% low figures are computed from —
     * so a heartbeat frame is a 100 ms sample, well inside the 2 s it is
     * willing to plot, and thirty seconds spent choosing a name would bank
     * three hundred of them. The graph would open on a wall of 10 fps and the
     * low-percentile figures would read as a stuttering machine for as long as
     * it took to flush. This overlay has hidden a real stall twice already; it
     * is not going to be taught to invent one.
     */
    pipeline.render(dt);
    return;
  }

  pipeline.render(dt);
  debug.update(dt, renderer);
  stats.update(dt);
}

requestAnimationFrame(frame);

/**
 * A bisection surface.
 *
 * When something in the frame looks wrong, the only question worth asking is
 * *which layer is drawing it*, and the only reliable way to answer that is to
 * turn the others off and look. Doing that by editing source and reloading loses
 * the camera position and the trip state every time, which is exactly when a
 * subtle artefact stops being reproducible.
 *
 * So every layer that can put pixels on the screen has a switch here, settable
 * from the console or from a script, with the world left running.
 */
const probe = {
  /**
   * Stop the world completely — trip clock AND wind.
   *
   * Setting the debug panel's speed to zero is not enough on its own: it
   * freezes the trip clock, but the wind runs on its own clock so every plant
   * keeps moving. That matters when
   * differencing two frames to isolate a post-process term, because a scene in
   * which everything is subtly moving produces a difference image that traces
   * every edge in the frame no matter what the post-process does — which is
   * indistinguishable from the artefact being looked for.
   */
  frozen: false,
  freeze(on = true) {
    this.frozen = on;
    debug.speed = on ? 0 : 1;
    /**
     * …AND THE SKY, WHICH IS A CLOCK NOW.
     *
     * `atmosphere.tick` reads the wall clock every frame, so a "frozen" world
     * still had a sun crossing it at 0.3 deg/s and a shadow map re-rendering
     * underneath whatever was being differenced. That is the same class of bug
     * this switch was built to kill: a measurement script differencing two
     * frames of a world that is quietly still moving gets an image that traces
     * every edge in the frame no matter what it was testing. It cost the
     * daylight work a whole measurement pass — a step-visibility table that
     * showed no dependence on its own variable, because a second of sun had
     * passed between the two captures.
     *
     * Pinned to the CURRENT phase rather than a fixed one, so freezing does not
     * also teleport you to nine in the morning.
     */
    atmosphere.day.set(on ? atmosphere.day.phase() : null);
    /**
     * …AND THE WORLD CLOCK, WHICH IS THE SAME BUG A THIRD TIME.
     *
     * `uTime` and `uWind` are read off the wall now rather than accumulated
     * from `dt`, so zeroing `dt` no longer stops them: the river would keep
     * running and every gust would keep travelling under a "frozen" world,
     * which is exactly the state that cost the daylight work a measurement
     * pass. Pinning is the same answer `atmosphere.day.set` above is.
     *
     * Releasing JUMPS to wherever the room has got to rather than resuming
     * where it paused, and that is the right way round: this is one machine's
     * debugging pause, not an event the other seven agreed to.
     */
    pinWorldClock(on);
    return on;
  },
  /** Name -> the objects that draw it. */
  layers: {
    trunks: () => forest.group.children.filter((c) => c.name === 'trunk'),
    leaves: () => forest.group.children.filter((c) => c.name === 'leaf'),
    grass: () => forest.group.children.filter((c) => c.name === 'grass'),
    ferns: () => forest.group.children.filter((c) => c.name === 'ferns'),
    ground: () => [forest.ground],
    rocks: () => forest.group.children.filter((c) => c.name === 'rocks'),
    logs: () => forest.group.children.filter((c) => c.name === 'logs'),
    mushrooms: () => forest.group.children.filter((c) => c.name?.startsWith('shroom')),
    /**
     * The understorey, one entry per layer rather than one umbrella.
     *
     * The whole point of these nine is that they differ from each other, so
     * "which of the nine is drawing that black blob" is exactly the question
     * this surface exists to answer — and it was hiding them one at a time that
     * found the bushes presenting a flat black rosette to a downward-looking
     * camera, after litter had been wrongly blamed for it twice.
     */
    meadow: () => forest.group.children.filter((c) => c.name === 'meadow'),
    bramble: () => forest.group.children.filter((c) => c.name === 'bramble'),
    bushes: () => forest.group.children.filter((c) => c.name === 'bushes'),
    saplings: () => forest.group.children.filter((c) => c.name === 'saplings'),
    sticks: () => forest.group.children.filter((c) => c.name === 'sticks'),
    flowers: () => forest.group.children.filter((c) => c.name === 'flowers'),
    litter: () => forest.group.children.filter((c) => c.name === 'litter'),
    reeds: () => forest.group.children.filter((c) => c.name === 'reeds'),
    stumps: () => forest.group.children.filter((c) => c.name === 'stumps'),
    /**
     * The social world, one switch per thing that can put pixels on the screen.
     *
     * Same rule as the fauna entries below and for the same reason: no umbrella
     * over `gathering.group`, because `only(name)` turns every other layer off
     * and a visible child of an invisible parent draws nothing — which reports
     * every one of these as empty and is indistinguishable from them being
     * broken. The fires are split from the furniture because "which of these is
     * the orange blob" is exactly the question this surface exists to answer,
     * and additive flame cards are the likeliest thing in here to be wrong.
     */
    fires: () => [gathering.hearths.flames, gathering.hearths.embers],
    hearths: () => [gathering.hearths.stones, gathering.hearths.logs],
    /** Benches and jetties — everything built. */
    furniture: () => gathering.group.children.filter((c) => c !== gathering.hearths.group),
    /**
     * Shared screens, which belong to the net layer rather than to the world
     * and exist only while somebody is sharing. Empty on a solitary walk, and
     * that is the honest answer rather than a broken one.
     *
     * NOT the light they throw, which is why `screen-glow` is named so it falls
     * outside this prefix. Hiding a light removes it from `NUM_POINT_LIGHTS`
     * and recompiles the program of every material in the world — so a switch
     * meant to answer "which layer is drawing this" would instead drop a couple
     * of hundred milliseconds on the frame it was flipped, and measure the
     * recompile. Its intensity is readable through `RR.net.screenGlow`.
     */
    screens: () => scene.children.filter((c) => c.name?.startsWith('share-screen')),
    ferry: () => (ferry ? [ferry.group] : []),
    rod: () => [fishing.group],
    /**
     * The fish in the river. Its own switch rather than a line in `fauna`,
     * because the question this surface answers is "which layer is drawing
     * that", and a shape moving under the water is the single most likely thing
     * in this world to be mistaken for something else.
     */
    shoal: () => [shoal.mesh],
    shafts: () => [atmosphere.shafts.group],
    mist: () => [atmosphere.mist.layers],
    motes: () => [atmosphere.motes.points],
    water: () => [atmosphere.water.mesh],
    sky: () => [atmosphere.sky.sky],
    /**
     * The two boxes — and NOT the lamp that lights them, which is why
     * `speakers.groups` is a hand-written list rather than everything the module
     * added to the scene. Hiding a group with a light in it changes
     * `NUM_POINT_LIGHTS` and recompiles every material in the world, so this
     * switch would measure a shader compile instead of two cabinets. Same rule
     * `screen-glow` is named for.
     */
    speakers: () => speakers.groups,
    /**
     * The animals, one layer per KIND and deliberately no umbrella `fauna`
     * switch over `fauna.group`.
     *
     * `only(name)` turns every other layer off, so an umbrella over the parent
     * group would set `fauna.group.visible = false` and then set the one child
     * true — and a visible child of an invisible parent draws nothing. The
     * result is a bisection tool that reports every animal layer as empty, which
     * is indistinguishable from the animals being broken, and cost an hour.
     * Toggling them individually keeps the group visible and the children honest.
     * For a blanket switch there is already `RR.fauna.group.visible`.
     */
    birds: () => [fauna.birds],
    butterflies: () => [fauna.butterflies],
    // One entry for all the mammals: a herd walks together, so the question is
    // "is a mammal drawing this", not "is it that particular squirrel".
    mammals: () => fauna.herds.map((h) => h.mesh ?? h.group).filter(Boolean),
    swarm: () => [fauna.swarm],
  },
  show(name, on = true) {
    for (const o of this.layers[name]?.() ?? []) o.visible = on;
    // The shadow map is rendered on demand, so a caster that just vanished
    // would otherwise keep shadowing the ground until the player walks 8 m.
    renderer.shadowMap.needsUpdate = true;
    return on;
  },
  only(...names) {
    for (const key of Object.keys(this.layers)) this.show(key, names.includes(key));
  },
  all(on = true) {
    for (const key of Object.keys(this.layers)) this.show(key, on);
  },
  shadows(on) {
    renderer.shadowMap.enabled = on;
    renderer.shadowMap.needsUpdate = true;
    // The same rebalance the quality knob applies. Without it, bisecting with
    // the probe and bisecting with the settings menu give two different
    // pictures of "shadows off", and only one of them is the shipping one.
    atmosphere.setShadowsEnabled(on);
    scene.traverse((o) => {
      if (o.material) o.material.needsUpdate = true;
    });
  },
  /** Every post and world-material effect, by name, 0..1 or on/off. */
  set(what, value) {
    switch (what) {
      case 'trail':
        pipeline.trailEnabled = !!value;
        break;
      case 'melt':
        director.switches.melt = !!value;
        break;
      case 'bloom':
        pipeline.bloomEnabled = !!value;
        break;
      case 'vignette':
        pipeline.outputMaterial.uniforms.uVignette.value = Number(value);
        break;
      case 'glow':
      case 'colour':
      case 'motion':
      case 'camera':
      case 'morph':
      case 'surge':
        director.gain[what] = Number(value);
        break;
      /**
       * The ego-death candidates, namespaced because they are not gains — see
       * the note on `director.ego`. `ego.fade`, `ego.unedge`, `ego.unlight`,
       * `ego.swarm`, each 0..1, and they combine.
       */
      case 'ego.fade':
      case 'ego.unedge':
      case 'ego.unlight':
      case 'ego.swarm':
        director.ego[what.slice(4)] = Number(value);
        break;
      case 'world':
      case 'audio':
        director.switches[what] = !!value;
        break;
      default:
        throw new Error(`unknown probe target: ${what}`);
    }
    return value;
  },
  reset() {
    this.all(true);
    pipeline.trailEnabled = true;
    pipeline.bloomEnabled = true;
    for (const k of Object.keys(director.gain)) director.gain[k] = 1;
    // EGO_DEFAULT, not 1 and not 0. These are four treatments sharing one slot
    // and what ships is a chosen combination of them, so "reset" means that
    // combination — setting them all to 1 the way the gains are reset would
    // switch on the three that were rejected.
    Object.assign(director.ego, EGO_DEFAULT);
    for (const k of Object.keys(director.switches)) director.switches[k] = true;
  },
};

// Expose a handle for poking at from the console during development.
window.RR = {
  /**
   * Which wood this is. Read by the scripts in scripts/ so a run can report the
   * world it measured, and by anyone who liked where they ended up and wants to
   * come back — `?seed=<this>` returns you to it exactly.
   */
  seed: SEED,
  /**
   * The clock every animated surface in the world reads, in seconds.
   *
   * A FUNCTION, not a number: it is sampled once a frame and a snapshot taken
   * at module-evaluation time would report zero forever. Exposed because it is
   * the one value `server/test/two-player.mjs` can compare between two pages to
   * prove they are in the same weather — the water, the wind and the clouds are
   * all pure functions of it, and two clients that agree here cannot disagree
   * about any of them. See core/world-clock.js.
   */
  worldClock,
  /**
   * The epoch instant `worldClock` counts from, in this tab's own clock domain.
   *
   * Exposed alongside it because comparing two pages' `worldClock()` readings
   * measures WHEN THE TWO READS LANDED as much as it measures the clocks: a
   * page whose renderer is mid-trip answers a devtools evaluate a few hundred
   * milliseconds later than an idle one, and the difference lands in the number
   * indistinguishably from real drift. Two origins can be compared with no such
   * term, because an origin does not move.
   *
   * Only comparable across pages that share a `Date.now()` — two tabs on one
   * machine, which is what `server/test/two-player.mjs` is. Across real
   * machines the origins differ BY the clock skew between them, which is
   * precisely what the age-based handshake is designed to absorb; there, the
   * thing to compare is `worldClock()` itself. See core/world-clock.js.
   */
  worldOrigin,
  scene,
  camera,
  renderer,
  controller,
  director,
  pipeline,
  forest,
  atmosphere,
  debug,
  stats,
  audio,
  speakers,
  probe,
  net,
  fauna,
  shoal,
  caves,
  /**
   * The social half, exposed for the console and for `server/test/two-player.mjs`
   * — which drives two real pages against a real server and needs to be able to
   * ask where the fires are, whether a picture actually arrived on the screen,
   * and whether sitting on the raft moves the body.
   */
  gathering,
  ferry,
  seats,
  sitting,
  fishing,
  social,
  get caveAudio() {
    return caveAudio;
  },
  /**
   * The forest's own sound layer, on a getter for the same reason `caveAudio`
   * is: neither exists until the audio gate has been clicked through, so a
   * plain property would freeze `null` into the object at module-evaluation
   * time and every reader would get it for ever.
   *
   * Exposed for `scripts/fish-check.mjs`, which fires all eight of the rod's
   * one-shots and then asserts the voice counter came back to where it started.
   * That is not something `audio-probe.mjs` can see — the probe measures the
   * master bus over a stage, and eight events that each leak one oscillator are
   * inaudible in a spectrum and fatal by the four hundredth cast.
   */
  get ambience() {
    return ambience;
  },
  /**
   * The live uniform block.
   *
   * Exposed rather than re-imported by test scripts: after an HMR update Vite
   * serves the module from a versioned URL, so a script that does
   * import('/src/trip/living.js') gets a SECOND, pristine copy whose uniforms
   * are all at their defaults. A test reading those measures nothing and passes
   * regardless, which is the worst possible failure mode for a regression test.
   */
  tripUniforms,
  get music() {
    return music;
  },
  get externalTrack() {
    return externalTrack;
  },
  get ambience() {
    return ambience;
  },
  get tripAudio() {
    return tripAudio;
  },
  /** The two music sources, one per speaker, in `speakers.cabinets` order. */
  get jukeboxSources() {
    return jukeboxSources;
  },
  /**
   * The sound knobs — `RR.tuning.set('lowMax', 3)`, `.reset()`, `.toSource()`,
   * `.load({...})` with an exported blob. The same object the backtick panel's
   * Sound sliders write, so the two can never drift apart.
   */
  tuning,
  /**
   * The named settings of those knobs, in two banks — `RR.presets.log()` prints
   * the list with what each one is for, `RR.presets.apply('trip', 'microscope')`
   * puts one on, `RR.presets.describe()` says where you are. The same buttons
   * the panel's Sound page draws.
   */
  presets,
};

/**
 * The performance instrument, if this build has one.
 *
 * DYNAMIC import, and that is the whole mechanism rather than a stylistic
 * choice. `__PERF__` is replaced with the literal `false` by the shipping
 * build, esbuild drops the unreachable block, and Rollup — now holding no
 * reachable reference to `./dev/perf/probe.js` — never emits the chunk. A
 * static import would put the module in the bundle and merely tree-shake its
 * unused exports, which for a module whose entire purpose is a side effect is
 * no reduction at all. `npm run check:perfstrip` asserts the difference rather
 * than trusting this comment.
 *
 * It goes AFTER `window.RR` is assigned because it hangs itself off it, and
 * after everything else because it is the last thing in the file that could
 * possibly matter to a running game.
 */
if (__PERF__) {
  const { installPerfProbe } = await import('./dev/perf/probe.js');
  perfHold = installPerfProbe(window.RR);
  /**
   * …and the watcher for the freezes no probe can provoke.
   *
   * Separate module and separate install because the two are opposites in every
   * respect that matters: the probe SEIZES the machine to make a measurement
   * repeatable, and this one touches nothing and waits for the session a person
   * is really in — their seed, their hour, their governor, none of which
   * `navigator.webdriver` allows a script to reproduce. Three of the freezes
   * this project has shipped were only ever found that way round.
   */
  const { installFreezeLog } = await import('./dev/perf/freezes.js');
  window.RR.freezes = installFreezeLog(window.RR);
}
