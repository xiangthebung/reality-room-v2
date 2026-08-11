/**
 * WHAT THE SUITE MEASURES, AND WHY THESE ONES.
 *
 * A performance suite is only as good as its worst-case scenario, and the
 * temptation is always to measure the spawn clearing at rest because it is the
 * easiest place to stand. That frame is not the one that drops. This file is
 * the list of frames that are allowed to represent the game, kept apart from
 * the machinery that times them so that adding a scenario is a data change.
 *
 * Every station is a fixed body position, yaw and pitch in the `grove-01`
 * world, which is the seed automation is pinned to (see core/world-seed.js) —
 * so a station is a repeatable picture, not a place that happens to have trees
 * today. Change the seed and every number here becomes incomparable with every
 * number recorded before, which is why the runner records the seed and the
 * regression gate refuses to compare across a change of it.
 */

/**
 * Where the camera stands. Chosen to span the ways this frame can be expensive
 * rather than to be a tour of the nice bits.
 */
export const STATIONS = {
  /**
   * The clearing you arrive in. Middling depth, the jukebox in frame, a lot of
   * ground visible. This is the closest thing to "the common case" and it is
   * the reference workload the whole run is normalised against.
   */
  clearing: { x: 0, z: 5, yaw: 0.0, pitch: -0.02 },
  /**
   * Deep wood at eye level: the densest instance count in the suite, and the
   * frame where the culler either works or does not.
   */
  deep: { x: -34, z: -46, yaw: 1.1, pitch: 0.02 },
  /**
   * Looking up into the canopy. THE WORST FRAME IN THE GAME and the reason the
   * suite exists: leaf cards fill the screen and the canopy is half the scene's
   * vertices, so this is the frame that is simultaneously fill-bound and
   * vertex-bound. If a change hurts anywhere it hurts here first.
   */
  canopy: { x: -30, z: -40, yaw: 0.8, pitch: 0.85 },
  /**
   * From the ridge, looking out over everything. Long view, no early-Z help
   * from a near floor, and the largest number of distinct materials in one
   * frustum — the draw-call scenario.
   */
  ridge: { x: 96, z: -104, yaw: -2.1, pitch: -0.06 },
};

/**
 * How far into the trip. `null` is sober — `director.ground()` rather than a
 * seek to zero, because those are different states: sober means the envelope is
 * not running at all.
 *
 * The four are not evenly spaced in time because they are not evenly spaced in
 * cost. Everything expensive happens between onset and peak.
 */
export const LEVELS = {
  sober: null,
  onset: 80,
  peak: 160,
  egodeath: 220,
};

/**
 * The suite, as (station, level) pairs.
 *
 * Deliberately NOT the full 4x4 cross product. Sixteen scenarios at eight
 * batches each is four minutes of GPU time to say the same thing four times,
 * and a regression gate nobody waits for is a regression gate nobody runs. Each
 * station appears at the level where it is most informative, plus a sober and a
 * peak reading of the canopy so the fill/vertex split stays visible — that
 * split is the single most useful diagnostic number in the run and it needs
 * both ends to exist.
 *
 * There is deliberately no "reference" scenario among them. Every scenario is
 * expressed as a multiple of the median of all of them, because a single
 * nominated reference puts its own noise into every other row — see `normalise`
 * in scripts/perf/stats.mjs, which records what that cost when it was tried.
 * The consequence for this list is that it should stay BALANCED: adding six
 * more canopy variants would let the canopy define the level and quietly turn
 * every other row into a comparison against the canopy.
 */
export const SCENARIOS = [
  { name: 'clearing.sober', station: 'clearing', level: 'sober' },
  { name: 'clearing.peak', station: 'clearing', level: 'peak' },
  { name: 'deep.sober', station: 'deep', level: 'sober' },
  { name: 'deep.peak', station: 'deep', level: 'peak' },
  { name: 'canopy.sober', station: 'canopy', level: 'sober' },
  { name: 'canopy.peak', station: 'canopy', level: 'peak' },
  { name: 'canopy.egodeath', station: 'canopy', level: 'egodeath' },
  { name: 'ridge.onset', station: 'ridge', level: 'onset' },
  /**
   * The standing-still frame, which is the shadow cache's entire justification
   * and the only scenario that skips `follow` and `cull`. A regression here and
   * nowhere else means somebody made the frame do work it used to be able to
   * skip — the most easily-missed class of performance bug there is, because
   * every moving benchmark still passes.
   */
  { name: 'canopy.peak.still', station: 'canopy', level: 'peak', still: true },
];

/**
 * THE SHIPPING CONFIGURATION, as the rig sees it. The A arm of every lever pair.
 *
 * `ratio: 1` is not the shipping pixel-ratio cap of 1.4 — the rig renders at a
 * fixed 2560x1440 internal resolution at ratio 1 so that runs are comparable
 * across windows and machines (see WIDTH/HEIGHT in probe.js). The render-scale
 * lever below therefore measures "1.4x the linear resolution", which is exactly
 * the ratio the cap moved, on a base the rig controls.
 */
export const LEVER_BASELINE = {
  shadowEveryFrame: false,
  cullEnabled: true,
  samples: 2,
  ratio: 1,
  bloom: true,
  trail: true,
  viewBreath: true,
};

/**
 * THE LEVERS: settings that can be moved live, on one build, in one session.
 *
 * This is the bottleneck report's vocabulary. Each entry is a named departure
 * from LEVER_BASELINE, applied and reverted at runtime, so the comparison is
 * free of the driver-state and GPU-clock drift that separate runs always have.
 * A lever that cannot be moved without editing source does not belong here —
 * its worth has to be measured by building twice, and pretending otherwise
 * produces a confident number for a thing that was never toggled. (The baked
 * noise lattice and the vertex-side colour field are the two live examples: both
 * are real optimisations, neither can appear in this table, and a table that
 * quietly omitted that fact would read as though they did not exist.)
 *
 * `apply` receives a rig-writing facade and NOTHING ELSE. It deliberately
 * cannot reach the renderer directly, because anything written straight onto
 * the renderer would survive the restore between arms — the rig is re-applied
 * wholesale from this object, and only fields it knows about come back.
 *
 * `direction` is what the B arm is expected to do to the frame, and it is
 * checked rather than assumed: a lever that moves the frame the wrong way is
 * either a broken measurement or a finding, and both are worth being told
 * about. `undoes` marks the levers whose B arm is "this optimisation was never
 * made" as against "this feature is switched off", because those two read very
 * differently in a report.
 */
export const LEVERS = [
  {
    name: 'shadow cache',
    b: 'shadow map every frame',
    hint: 'renderer.shadowMap.autoUpdate',
    undoes: true,
    direction: 'slower',
    apply: (rig) => rig.set('shadowEveryFrame', true),
  },
  {
    name: 'instance culling',
    b: 'every instance submitted',
    hint: 'world/culling.js',
    undoes: true,
    direction: 'slower',
    apply: (rig) => rig.set('cullEnabled', false),
  },
  {
    name: 'MSAA 2',
    b: 'MSAA 4',
    hint: 'pipeline scene target samples',
    undoes: true,
    direction: 'slower',
    apply: (rig) => rig.set('samples', 4),
  },
  {
    name: 'render scale',
    b: '1.4x linear resolution',
    hint: 'pixel-ratio cap — 1.96x the pixels',
    undoes: true,
    direction: 'slower',
    apply: (rig) => rig.set('ratio', 1.4),
  },
  {
    name: 'bloom',
    b: 'bloom off',
    hint: 'pipeline.bloomEnabled',
    direction: 'faster',
    apply: (rig) => rig.set('bloom', false),
  },
  {
    name: 'trail',
    b: 'glow accumulator off',
    hint: 'pipeline.trailEnabled',
    direction: 'faster',
    apply: (rig) => rig.set('trail', false),
  },
  /**
   * The one lever here that costs nothing when sober.
   *
   * Its arm B is worth reading with that in mind: the sober rows will report a
   * delta of zero because the output shader's uniform branch is not taken at
   * uViewWarp = 0, and a zero there is the feature working rather than the
   * lever failing to move. The peak rows are the measurement.
   */
  {
    name: 'view breath',
    b: 'view breath off',
    hint: 'director.switches.view — the warp in the output pass',
    direction: 'faster',
    apply: (rig) => rig.set('viewBreath', false),
  },
];

/**
 * The layers whose marginal cost is worth knowing, in the order they are worth
 * looking at.
 *
 * Names are keys into the existing `RR.probe.layers` bisection surface in
 * main.js, so this list cannot invent a layer that does not exist — and a
 * missing key is reported as missing rather than silently measuring nothing,
 * which is what a `?.() ?? []` would do.
 *
 * MARGINAL, NOT SHARE. Hiding one layer and taking the difference measures what
 * REMOVING it is worth given everything else is present, and those do not add
 * up to the frame — occlusion means they cannot. That is not a defect of the
 * method, it is the actual shape of the problem, and the ground layer is the
 * proof: hiding the floor makes this frame SLOWER, because it is the best
 * early-Z occluder in the wood. A report that forced these to sum to 100%
 * would have to hide that fact to do it.
 */
export const LAYERS = [
  'leaves',
  'trunks',
  'ground',
  'grass',
  'ferns',
  'sky',
  'mist',
  'shafts',
  'motes',
  'water',
  'speakers',
  'birds',
  'butterflies',
  'mammals',
];
