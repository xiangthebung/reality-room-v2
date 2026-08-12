import { PHASES, TRIP_SECONDS } from '../trip/state.js';
import { EGO_DEFAULT } from '../trip/director.js';
import { LEVELS, quality } from '../core/quality.js';
import { worldHearsKey } from '../core/keys.js';
import { AUTHORED_PHASE, dayInfo, dayScale, setDayPhase, setDayScale } from '../world/daylight.js';
import { tripUniforms } from '../trip/living.js';
import { caveAxisPoint, cavesNear, groundUnder } from '../world/terrain.js';
import * as tuning from '../audio/tuning.js';
import * as presets from '../audio/presets.js';

/**
 * The debug panel.
 *
 * Opened with the backtick key, closed the same way, and it starts closed — the
 * ordinary experience never sees it.
 *
 *
 * WHAT THIS IS FOR, AND THE ONE RULE THAT SHAPES ALL OF IT.
 *
 * Everything in this project is a slow envelope over something that is only
 * visible while you are walking around inside it, so almost nothing here can be
 * judged from a still frame or a unit test. This panel exists to make those
 * envelopes seizable: the trip clock, the hour of day, every effect family, the
 * whole quality ladder, the render pipeline, the audio tuning and the visibility
 * of every layer that can put a pixel on the screen.
 *
 * The rule is EVERY CONTROL MUST SAY WHEN IT CANNOT MATTER.
 *
 * This panel used to be a single column of ~60 sliders, and the reported problem
 * with it was not that it was long — it was that most of those sliders do
 * nothing most of the time, and nothing about them said so. Nearly every number
 * in here is a CEILING that gets multiplied by the trip level, so at level 0 a
 * slider you drag from one end to the other changes precisely nothing; the sound
 * knobs additionally need audio to exist, a record to be playing, and (for the
 * `Trip ·` groups) the trip to be at full intensity before they mean what they
 * say; two of them only touch a pasted link. Dragging one of those and hearing
 * no difference teaches you something false about the knob.
 *
 * So every row carries a `dead()` that returns the REASON it is inert right now,
 * or null. A row that cannot matter is disabled, greyed and captioned with the
 * reason and, where there is one, the thing to do about it ("press E at a
 * speaker"). This is the same posture the settings menu takes toward an
 * unregistered knob, for the same reason: a control that lies about whether it
 * is connected is worse than one that is missing.
 *
 *
 * THE SECOND RULE: NOTHING HERE OWNS ANY STATE.
 *
 * Every row reads its value back from whoever actually owns it — the registry in
 * core/quality.js, the tuning module, the director's own gain object, the
 * pipeline's uniforms, the probe's layer list — and re-reads it on a timer. So
 * the console, the settings menu, a test script and this panel can all move the
 * same thing and none of them can end up describing a state the app is not in.
 * The two-faced controls that motivated the rule are the render scale (the
 * settings menu owns it) and the bloom toggle (ditto); the trip gains joined
 * them the moment `motionIntensity` started writing `director.gain.camera`.
 *
 *
 * WHAT IT DEPENDS ON. Everything is optional. A dependency that was not passed
 * makes the rows that need it dead with "not wired into this build" rather than
 * throwing, which is what lets a stripped build or a test construct the panel.
 */

/** The pages. Their order is the order you meet them in a debugging session. */
const TABS = [
  { id: 'trip', title: 'Trip' },
  { id: 'render', title: 'Render' },
  { id: 'world', title: 'World' },
  { id: 'sound', title: 'Sound' },
  { id: 'layers', title: 'Layers' },
];

/**
 * The five hours worth jumping to, and the way back to the wall clock.
 *
 * THE BOUNDARY IS NEVER THE INTERESTING MOMENT. Geometric sunset is 0.7877 and
 * looks like late afternoon; 0.815 is where the light has actually gone and the
 * owl has started, which is what somebody clicking "dusk" is asking to see.
 * `morning` is AUTHORED_PHASE exactly, because that is the frame every
 * screenshot in scripts/ is compared against and being able to get back to it by
 * hand is worth a button.
 */
const HOURS = [
  ['night', 0.03],
  ['dawn', 0.25],
  ['morning', AUTHORED_PHASE],
  ['noon', 0.5],
  ['dusk', 0.815],
  ['live', null],
];

/** The effect families, in the order the director applies them. */
const FAMILIES = [
  ['world', 'the master gate: uLevel and uDissolve go to 0, which skips every shader effect'],
  ['melt', 'world-space flow and the luminous wake'],
  ['morph', 'swell, creep, emergent detail, organising, canopy pulse'],
  ['view', 'the view breath: the whole picture swelling. The only screen-space term there is'],
  ['camera', 'fov drift, dolly, roll and lateral sway'],
  ['colour', 'warmth, saturation, rim light — and it gates the glow'],
  ['audio', 'every trip layer, the world ducking, and the record’s treatment'],
  ['bloom', 'the bright pass. Shared with Settings → Graphics → Bloom'],
];

/**
 * The debug multipliers on the director's ceilings, with what each one is
 * actually attached to.
 *
 * `key` is the name in `director.gain`, which is also what `RR.probe.set(name, v)`
 * takes — the label is allowed to be more descriptive than the key, but the key
 * is in the hint so the panel and the console stay one vocabulary.
 */
const GAINS = [
  {
    key: 'glow',
    label: 'glow',
    max: 2,
    needs: ['world'],
    switches: ['colour'],
    hint: 'uGlow — the self-luminous light: moss patches, the canopy pulse, the cave veins, a deer’s coat. The colour switch gates it outright, so that has to be on as well.',
  },
  {
    key: 'colour',
    label: 'colour',
    max: 2,
    needs: ['world'],
    switches: ['colour'],
    hint: 'uWarmth, uSat and uRim together, plus the light and fog hue offsets in the atmosphere.',
  },
  {
    key: 'motion',
    label: 'motion',
    max: 2,
    needs: ['world'],
    hint: 'uBreathAmp, uSway, uHills, uLean — the family that moves whole objects.',
  },
  {
    key: 'melt',
    label: 'melt',
    max: 2,
    needs: ['world'],
    switches: ['melt'],
    hint: 'uFlow, and the wake’s share of the glow accumulator.',
  },
  {
    key: 'morph',
    label: 'morph',
    max: 3,
    needs: ['world'],
    switches: ['morph'],
    hint: 'uSwell, uCreep, uDetail, uPulse — the surface moving while the object stays put.',
  },
  {
    key: 'view',
    label: 'view breath',
    max: 3,
    needs: ['world'],
    switches: ['view'],
    hint: 'uViewWarp — the whole picture swelling in the output pass. The one term in the project that moves the image rather than the world, so it is also the one to turn off first when something looks like a filter. Settings → Accessibility → Camera motion writes this same field, so it can move under you.',
  },
  {
    key: 'camera',
    label: 'camera',
    max: 2,
    switches: ['camera'],
    hint: 'fov drift, dolly, roll, sway. Settings → Accessibility → Camera motion writes this same field, so it can move under you.',
  },
  {
    key: 'surge',
    label: 'surge',
    max: 3,
    needs: ['world'],
    hint: 'The wave arriving. uSurge is level^2.6, so below about 0.4 there is almost nothing here to scale.',
  },
];

/**
 * THE FOUR CANDIDATE EGO-DEATH TREATMENTS.
 *
 * The surface term ego death used to have was a dither hashed off a quantised
 * world position, and it was deleted on 2026-08-11 because a cell of uniform
 * size on screen is a lattice on screen — it was read back as a mosaic of
 * see-through blocks. Nothing has replaced it yet; these are the four proposals,
 * they combine, and they all default to zero.
 *
 * `key` is the name in `director.ego`, which is also what
 * `RR.probe.set('ego.<key>', v)` takes. The hints say what the term DOES and
 * what it costs, because the choice between them is going to be made by looking
 * rather than by reading, and the cheap one winning is a real possible outcome.
 */
const EGO = {
  fade: {
    label: 'fade into the air',
    hint: 'The near world takes the colour of the fog in it, keyed by rrSolid so the far wood — which is mostly air already — barely moves. Boundaries fail and local contrast collapses: the wood stops being things standing in space. One lerp on a colour already in a register.',
  },
  unedge: {
    label: 'lose the outlines',
    hint: 'Fades uRim out as the dissolve rises, so objects stop having silhouettes and the wood reads as one surface. The only one that works by subtraction, the only one that costs literally nothing, and the only one that makes the phase read as a change of kind rather than as more peak.',
  },
  unlight: {
    label: 'un-light the surface',
    hint: 'Pushes every pixel toward one luminance while keeping its hue, so a trunk stops having a sunny side and a shaded side. KNOWN COST: it beiges the wood. Lifting a dark saturated colour into the ACES knee pulls its channels together, so greens and reds both converge on a warm grey — measured, inherent to the treatment, not a bug in it.',
  },
  swarm: {
    label: 'swarm (soft)',
    hint: 'The direct replacement for the dither: keep the bright, drop the rest — but thresholding a CONTINUOUS fbm rather than a quantised hash, so what survives is feathered blobs at every size and there is no cell anywhere. Near field only, drifting at about 0.9 Hz rather than reseeding at 2.',
  },
};
const EGO_KEYS = ['fade', 'unedge', 'unlight', 'swarm'];

/**
 * Which of the sound knobs can be heard when.
 *
 * Keyed on the group in `audio/tuning.js`. This is the expensive knowledge in
 * the file: `Cabinet` is two knobs that live in `external-track.js` and are
 * therefore silent unless a pasted link is playing, and everything under
 * `Trip ·` is documented as ITS VALUE AT FULL INTENSITY — the panel showing 0.5
 * while the trip sits at 0.1 means the graph is somewhere near a tenth of that,
 * which is not what the number says and is why turning these while sober taught
 * people the knobs were broken.
 */
const SOUND_NEEDS = {
  Weight: ['audio', 'music', 'trip'],
  Space: ['audio', 'music', 'trip'],
  Cabinet: ['audio', 'link'],
  'Trip · world': ['audio', 'tripswitch', 'trip'],
  'Trip · cabinet': ['audio', 'link', 'trip'],
  'Trip · layers': ['audio', 'tripswitch', 'trip'],
  'Trip · detail': ['audio', 'tripswitch', 'music', 'trip'],
};

/**
 * How far a candidate may move one knob at the start of a search, as a fraction
 * of that knob's own slider.
 *
 * A QUARTER IS LARGE, AND THE FIRST ROUND IS SUPPOSED TO BE. The first question
 * is which direction, and neighbours that all sound like the thing you already
 * have answer it with silence — you cannot pick between five sounds you cannot
 * tell apart, so the search stalls at round one and reads as broken. It closes
 * fast: 0.62 per accepted round is a quarter of the range down to a twentieth in
 * five rounds, which is roughly the point where a knob's own step takes over.
 */
const EXPLORE_SPREAD = 0.25;
/** Past this a candidate is a different preset rather than a neighbour. */
const EXPLORE_CEILING = 0.6;
/** …and under this the five candidates are inaudibly different from each other. */
const EXPLORE_FLOOR = 0.015;

/** How often the visible rows are re-read and re-judged, in seconds. */
const SYNC_PERIOD = 0.25;
/** …and the footer, which is numbers rather than layout. */
const FOOT_PERIOD = 1 / 6;

const fmt = (dp) => (v) => Number(v).toFixed(dp);
const pct = (v) => `${Math.round(v * 100)}%`;

export class DebugPanel {
  constructor({
    director,
    pipeline,
    renderer = null,
    camera = null,
    controller = null,
    forest = null,
    atmosphere = null,
    speakers = null,
    gathering = null,
    net = null,
    audio = null,
    seed = null,
    /**
     * A THUNK, not the object. main.js builds this panel near the top of the
     * file and defines `probe` near the bottom, so the reference cannot exist
     * yet at construction — and reaching for it lazily is also what lets the
     * panel and the console share one layer list rather than growing a second.
     */
    probe = null,
    getMusic = null,
    getExternalTrack = null,
    onRenderScale = null,
  }) {
    this.director = director;
    this.pipeline = pipeline;
    this.renderer = renderer;
    this.camera = camera;
    this.controller = controller;
    this.forest = forest;
    this.atmosphere = atmosphere ?? director?.atmosphere ?? null;
    this.speakers = speakers;
    this.gathering = gathering;
    this.net = net;
    this.audio = audio;
    this.seed = seed;
    this.onRenderScale = onRenderScale;
    this._probe = typeof probe === 'function' ? probe : () => probe;
    this._music = getMusic ?? (() => null);
    this._external = getExternalTrack ?? (() => null);

    this.visible = false;
    /** Multiplier on the trip clock. 0 freezes it. Read by main.js. */
    this.speed = 1;
    /**
     * Multiplier on the WIND clock, read by main.js the same way.
     *
     * Separate from `speed` because they answer opposite questions. The trip
     * clock is a five-minute envelope you want to seek through; the wind is the
     * thing that never stops, and the two useful settings for it are 0 (hold
     * every plant still so two frames can be differenced) and 3 or 4 (find out
     * what a gust does without standing in the wood for a minute waiting for
     * one). `probe.freeze()` still zeroes it outright, and that stays the
     * blunt instrument.
     */
    this.windScale = 1;

    this._frames = 0;
    this._fpsAccum = 0;
    this._fps = 0;
    this._msAccum = 0;
    this._msFrames = 0;
    this._ms = 0;
    this._scrubbing = false;
    this._syncAccum = SYNC_PERIOD;
    this._footAccum = FOOT_PERIOD;
    this._tab = TABS[0].id;
    this._filter = '';
    /**
     * The sound search. See `_exploreRows`.
     *
     * The one piece of genuine state this panel owns, and it is allowed to
     * because it is not a copy of anything: the knobs stay owned by `tuning.js`
     * and are read back from it every round. What lives here is where the search
     * has been and how wide it is looking — questions no other module has an
     * answer to.
     */
    this._explore = {
      bank: presets.BANKS[0].id,
      center: null,
      spread: EXPLORE_SPREAD,
      round: 0,
      seed: 0,
      from: '',
      /** The candidate currently applied, or -1 for the centre. */
      lit: -1,
      candidates: [],
      history: [],
    };
    /** id -> the built row record. */
    this._rows = new Map();
    this._layersBuilt = false;

    const el = document.createElement('div');
    el.id = 'debug';
    el.hidden = true;
    el.innerHTML = SHELL;
    document.body.appendChild(el);
    this.el = el;

    this._build();
    this._bindKeys();

    /**
     * Rebuilt from the values rather than from the events, so `RR.tuning.set`,
     * a preset click in the settings menu and the Auto governor all move this
     * panel too. A panel that only agrees with itself is the same bug as the
     * debug bloom toggle that used to disagree with the settings menu.
     */
    this._unsubscribeQuality = quality.subscribe(() => this.sync());
    this._unsubscribeTuning = tuning.subscribe(() => this.sync());
    this.showTab(this._tab);
    this.sync();
  }

  /**
   * Where in each phase a jump should land.
   *
   * NOT the phase boundary. `level` is interpolated from the previous phase's
   * value with a smoothstep, so the first instant of "peak" is by definition
   * still the end of the onset — clicking `peak` used to leave you at 0.58, and
   * every judgement made from that button was about the wrong intensity.
   *
   * These are the fraction through each phase at which it is most itself: near
   * the end for the phases that ramp, and the middle of ego death, where the
   * dissolve curve is at its maximum.
   */
  static AT = { comeup: 0.8, onset: 0.8, peak: 0.85, egodeath: 0.5, comedown: 0.4 };

  static seekFor(phase) {
    const k = DebugPanel.AT[phase.id] ?? 0.5;
    return phase.from + (phase.to - phase.from) * k;
  }

  /* ------------------------------------------------------------------ */
  /* the reasons a control cannot matter                                 */
  /* ------------------------------------------------------------------ */

  /** The first non-null reason, or null. */
  static _first(...tests) {
    return () => {
      for (const t of tests) {
        const r = t();
        if (r) return r;
      }
      return null;
    };
  }

  _needs(what) {
    const d = this.director;
    switch (what) {
      case 'world':
        return d.switches.world ? null : 'the world switch is off — uLevel is pinned at 0';
      case 'trip':
        return d.eased > 0.01
          ? null
          : `sober — every amount here is multiplied by the trip level (${d.eased.toFixed(2)})`;
      case 'tripswitch':
        return d.switches.audio ? null : 'the audio switch is off — nothing reaches the trip’s graph';
      case 'audio':
        return this.audio?.ready ? null : 'no audio yet — click into the forest first';
      case 'music':
        return this._playing() ? null : 'nothing is playing — press E at a speaker';
      case 'link':
        return this._external()?.playing
          ? null
          : 'only a pasted link runs through this — press U at a speaker';
      /**
       * The fifth gate, and the narrowest: the ego-death curve is zero in every
       * phase but one. `hold` cannot fake it either — the curve is a function of
       * the clock, not of the level — so the only way to see these is to be in
       * the phase, which is one click on the grid at the top of this page.
       */
      case 'dissolve':
        return tripUniforms.uDissolve.value > 0.001
          ? null
          : `the dissolve curve is ${tripUniforms.uDissolve.value.toFixed(2)} — these only exist during ego death, so click egodeath in Clock above`;
      default:
        return null;
    }
  }

  _needsAll(list) {
    return () => {
      for (const what of list) {
        const r = this._needs(what);
        if (r) return r;
      }
      return null;
    };
  }

  _playing() {
    return Boolean(this._music()?.playing || this._external()?.playing);
  }

  /**
   * What the scene pass submitted, as a sentence.
   *
   * From `pipeline.sceneStats` rather than from `renderer.info`, for the reason
   * that block gives: after the frame, three's counters describe the output
   * quad and nothing else.
   */
  _sceneStats() {
    const s = this.pipeline?.sceneStats;
    if (!s) return '–';
    return `${s.calls} draws · ${(s.triangles / 1000).toFixed(0)}k tris`;
  }

  /* ------------------------------------------------------------------ */
  /* the schema                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * One row from a knob in the quality registry.
   *
   * The registry already carries the label, the range, the formatter and the
   * hint, and it already knows whether anybody has claimed the knob — so this is
   * an adapter rather than a second declaration of the same settings. It also
   * means the panel and Settings → Graphics are two faces of one control by
   * construction, which is the property the render-scale slider had to be
   * rewritten to get.
   */
  _qualityRow(id, extra = {}) {
    const knob = quality.knob(id);
    if (!knob) return null;
    const dead = () => {
      if (!quality.has(id)) return 'nothing has registered this knob in this build';
      if (knob.dependsOn && !quality.get(knob.dependsOn)) {
        return `${quality.knob(knob.dependsOn)?.label ?? knob.dependsOn} is off, so this cannot matter`;
      }
      return null;
    };
    return {
      kind: knob.kind,
      id: `q.${id}`,
      label: knob.label.toLowerCase(),
      hint: knob.hint,
      min: knob.min,
      max: knob.max,
      step: knob.step,
      options: knob.options,
      format: knob.format ?? (knob.kind === 'range' ? fmt(2) : null),
      get: () => quality.get(id),
      set: (v) => quality.set(id, v),
      dead,
      ...extra,
    };
  }

  _sections() {
    const d = this.director;
    const pipe = this.pipeline;
    const post = () => pipe?.outputMaterial?.uniforms ?? null;
    const missing = (thing, what) => () => (thing() ? null : `${what} is not wired into this build`);
    const u = tripUniforms;

    /* ---- trip ------------------------------------------------------- */

    const trip = [
      {
        tab: 'trip',
        title: 'Clock',
        rows: [
          {
            kind: 'grid',
            id: 'phases',
            containerId: 'dbg-phases',
            columns: 3,
            buttons: [{ id: 'sober', label: 'sober', from: -1 }, ...PHASES].map((phase) => ({
              label: phase.id === 'sober' ? 'sober' : phase.id,
              title: phase.label ?? 'end the trip and let everything retire',
              on: () => d.state.active && d.state.phase.id === phase.id,
              run: () => {
                if (phase.from < 0) d.ground();
                else d.seek(DebugPanel.seekFor(phase));
              },
            })),
          },
          {
            kind: 'range',
            id: 'time',
            inputId: 'dbg-time',
            label: 'time',
            hint: 'Seek the trip clock. The eased level SNAPS rather than ramping, because a debug seek that takes ten seconds to arrive is not a seek.',
            min: 0,
            max: TRIP_SECONDS,
            step: 0.5,
            live: () => !this._scrubbing,
            get: () => Math.max(0, d.state.time),
            set: (v) => d.seek(v),
            format: (v) => (d.describe().active ? `${Math.round(v)}s` : '–'),
          },
          {
            kind: 'range',
            id: 'speed',
            inputId: 'dbg-speed',
            label: 'speed',
            hint: 'Multiplier on the trip clock ONLY. The wind, the music and your legs stay at real time, which is what makes a 20× seek useful rather than a comedy.',
            min: 0,
            max: 20,
            step: 0.5,
            get: () => this.speed,
            set: (v) => (this.speed = v),
            format: (v) => `${v}×`,
          },
          {
            kind: 'range',
            id: 'hold',
            inputId: 'dbg-hold',
            label: 'hold',
            hint: 'Pin the envelope at a value and stop the clock advancing past it. Standing at exactly 0.6 and turning around slowly is how you find out whether something reads as a filter.',
            min: 0,
            max: 1,
            step: 0.01,
            get: () => (d.state.override ?? d.eased),
            set: (v) => {
              d.state.override = v;
              d.eased = v;
              if (!d.state.active) d.seek(120);
            },
            format: (v) => (d.state.override === null ? `(${v.toFixed(2)})` : v.toFixed(2)),
          },
          {
            kind: 'grid',
            id: 'clock-actions',
            columns: 2,
            caption: () =>
              d.state.active
                ? null
                : 'nothing is running — pause has nothing to stop until you eat or click a phase',
            buttons: [
              {
                label: 'pause',
                title:
                  'stop the trip where it is — the K key does the same. The phase, the level and the ego-death curve hold still; the wind, the surges, the breath and every audio layer carry on, and the trip stops expiring. Not the same as speed 0, which stops those too',
                on: () => d.paused,
                run: () => {
                  d.pause(!d.paused);
                  this.sync();
                },
              },
              {
                label: 'hold',
                title: 'pin the envelope where it is now — the \\ key does the same',
                on: () => d.state.override !== null,
                run: () => {
                  d.state.override = d.state.override === null ? d.eased : null;
                  this.sync();
                },
              },
              {
                label: 'eat',
                title: 'start a trip, or redose one — the M key does the same',
                run: () => d.eat(`debug:${Math.floor(Date.now() / 1000)}`),
              },
              {
                label: 'ground',
                title: 'end it and let every effect retire — the N key does the same',
                run: () => {
                  d.state.override = null;
                  d.ground();
                },
              },
            ],
          },
          {
            kind: 'note',
            text: '` panel · 1–5 pages · [ ] step phases · K pause · \\ hold · M eat · N ground',
          },
        ],
      },
      {
        tab: 'trip',
        title: 'Effect families',
        note: 'When something looks wrong the only useful question is which layer is drawing it, and the fastest way to answer that is to switch the others off.',
        rows: [
          {
            kind: 'grid',
            id: 'families',
            containerId: 'dbg-toggles',
            columns: 2,
            buttons: FAMILIES.map(([key, hint]) => ({
              label: key,
              title: hint,
              on: () => (key === 'bloom' ? Boolean(pipe?.bloomEnabled) : d.switches[key]),
              run: () => {
                if (key === 'bloom') {
                  /**
                   * Through the registry, not straight at the pipeline: this
                   * and the settings menu's Bloom toggle are two controls for
                   * one piece of state, and whichever of them writes it
                   * directly is the one that makes the other lie.
                   */
                  if (quality.has('bloom')) quality.set('bloom', !quality.get('bloom'));
                  else if (pipe) pipe.bloomEnabled = !pipe.bloomEnabled;
                  return;
                }
                d.switches[key] = !d.switches[key];
              },
            })),
          },
        ],
      },
      {
        tab: 'trip',
        title: 'Gains',
        note: 'Multipliers on the director’s ceilings. The useful question during tuning is almost never “is this on” but “is this too much”.',
        rows: GAINS.map((gain) => ({
          kind: 'range',
          id: `gain.${gain.key}`,
          label: gain.label,
          hint: `${gain.hint}  ·  RR.probe.set('${gain.key}', v)`,
          min: 0,
          max: gain.max,
          step: 0.05,
          get: () => d.gain[gain.key],
          set: (v) => (d.gain[gain.key] = v),
          format: fmt(2),
          dead: DebugPanel._first(
            this._needsAll(gain.needs ?? []),
            () => {
              for (const name of gain.switches ?? []) {
                if (!d.switches[name]) return `the ${name} switch is off`;
              }
              return null;
            },
            () => this._needs('trip')
          ),
        })),
      },
      {
        tab: 'trip',
        title: 'Ego death',
        note: 'What the phase does to a surface. `shipped` is unedge 0.5 + swarm 1, chosen after shooting all four; the rest are the candidates it was chosen over, kept because the choice is worth being able to re-take. Walk about — the question each of them answers is “does this read as the world dissolving, or as something wrong with the picture”.',
        rows: [
          {
            kind: 'grid',
            id: 'ego.presets',
            containerId: 'dbg-ego',
            columns: 3,
            /**
             * ONE CLICK PER CANDIDATE, because the comparison is the point.
             *
             * Four sliders alone would make an A/B a four-drag operation, and
             * by the fourth drag the surge has moved, the sun has moved and the
             * thing being compared is not the thing that was set. Each button
             * sets all four numbers, so every candidate is exactly one click
             * from every other — including one click back to what ships, which
             * is the click that matters most once a choice has been made.
             *
             * `shipped` is FIRST and is EGO_DEFAULT itself rather than a copy of
             * its numbers. Two literals for one decision is how a panel starts
             * lying about the build it is attached to, and this one has already
             * been the place people judge the trip from.
             *
             * The rest are the candidates `shipped` was chosen over. They stay
             * because the choice was made by looking, which means it can be
             * unmade by looking, and re-taking it needs the alternatives to hand
             * rather than in a commit message. Their strengths are the ones they
             * were judged at.
             */
            buttons: [
              { label: 'shipped', set: EGO_DEFAULT },
              { label: 'off', set: { fade: 0, unedge: 0, unlight: 0, swarm: 0 } },
              { label: 'fade', set: { fade: 0.55, unedge: 0, unlight: 0, swarm: 0 } },
              { label: 'unedge', set: { fade: 0, unedge: 1, unlight: 0, swarm: 0 } },
              { label: 'unlight', set: { fade: 0, unedge: 0, unlight: 0.7, swarm: 0 } },
              { label: 'swarm', set: { fade: 0, unedge: 0, unlight: 0, swarm: 0.85 } },
            ].map(({ label, set }) => ({
              label,
              title:
                {
                  shipped:
                    'what ego death actually does in this build: half the outline loss, all of the swarm. Chosen after shooting all four side by side',
                  off: 'no surface treatment at all — where this stood between the dither being deleted and the swarm replacing it',
                }[label] ?? EGO[label]?.hint ?? label,
              on: () => EGO_KEYS.every((k) => Math.abs(d.ego[k] - (set[k] ?? 0)) < 0.001),
              run: () => {
                Object.assign(d.ego, { fade: 0, unedge: 0, unlight: 0, swarm: 0 }, set);
                this.sync();
              },
            })),
          },
          ...EGO_KEYS.map((key) => ({
            kind: 'range',
            id: `ego.${key}`,
            label: EGO[key].label,
            hint: `${EGO[key].hint}  ·  RR.probe.set('ego.${key}', v)`,
            min: 0,
            max: 1,
            step: 0.05,
            get: () => d.ego[key],
            set: (v) => (d.ego[key] = v),
            format: fmt(2),
            dead: DebugPanel._first(this._needsAll(['world', 'dissolve'])),
          })),
          {
            kind: 'readout',
            id: 'ego.report',
            label: 'in effect',
            get: () => {
              const e = u.uEgo.value;
              const rim = 1 - Math.min(1, Math.max(0, d.ego.unedge * u.uDissolve.value));
              return `dissolve ${u.uDissolve.value.toFixed(2)} · fade ${e.x.toFixed(2)} · unlight ${e.y.toFixed(2)} · swarm ${e.z.toFixed(2)} · rim ×${rim.toFixed(2)}`;
            },
          },
        ],
      },
      {
        tab: 'trip',
        title: 'Readout',
        rows: [
          { kind: 'meter', id: 'r.level', label: 'level', get: () => d.eased, text: () => d.eased.toFixed(3) },
          {
            kind: 'meter',
            id: 'r.dissolve',
            label: 'dissolve',
            get: () => d.describe().dissolve,
            text: () => d.describe().dissolve.toFixed(3),
          },
          { kind: 'meter', id: 'r.surge', label: 'surge', get: () => d.surge ?? 0, text: () => (d.surge ?? 0).toFixed(3) },
          {
            kind: 'meter',
            id: 'r.dwell',
            label: 'stare',
            hint: 'uDwell — how long the gaze has been held on one piece of the world. Charges over ~3.4 s, collapses in ~0.45.',
            get: () => u.uDwell.value,
            text: () => u.uDwell.value.toFixed(3),
          },
          {
            kind: 'readout',
            id: 'r.phase',
            label: 'phase',
            get: () => {
              const s = d.describe();
              const held = s.override === null ? '' : ' · held';
              const stopped = s.paused ? ' · paused' : '';
              return `${s.phase.id}${held}${stopped} · ${s.active ? `${s.time.toFixed(0)}/${s.total.toFixed(0)}s` : 'inactive'} · ${s.doses} dose${s.doses === 1 ? '' : 's'}`;
            },
          },
          {
            kind: 'fold',
            id: 'r.uniforms',
            title: 'uniforms',
            rows: [
              ['uGlow', () => u.uGlow.value],
              ['uSat', () => u.uSat.value],
              ['uWarmth', () => u.uWarmth.value],
              ['uRim', () => u.uRim.value],
              ['uFlow', () => u.uFlow.value],
              ['uSwell', () => u.uSwell.value],
              ['uCreep', () => u.uCreep.value],
              ['uDetail', () => u.uDetail.value],
              ['uPulse', () => u.uPulse.value],
              ['uBreathAmp', () => u.uBreathAmp.value],
              ['uSway', () => u.uSway.value],
              ['uHills', () => u.uHills.value],
              ['uLean', () => u.uLean.value],
            ].map(([name, get]) => ({
              kind: 'readout',
              id: `u.${name}`,
              label: name,
              get: () => get().toFixed(3),
            })),
          },
        ],
      },
    ];

    /* ---- render ----------------------------------------------------- */

    const render = [
      {
        tab: 'render',
        title: 'Quality',
        rows: [
          {
            kind: 'grid',
            id: 'presets',
            columns: 5,
            buttons: ['auto', ...LEVELS].map((mode) => ({
              label: mode === 'auto' ? 'auto' : mode,
              title:
                mode === 'auto'
                  ? 'hand the ladder back to the governor'
                  : `pin every preset knob at ${mode}`,
              on: () => quality.mode === mode,
              run: () => quality.setMode(mode),
            })),
          },
          {
            kind: 'readout',
            id: 'q.mode',
            label: 'mode',
            get: () => {
              const s = quality.status();
              const where = s.mode === 'auto' ? `auto, on ${s.autoLevel}` : s.mode === 'custom' ? `custom on ${s.autoLevel}` : s.mode;
              return `${where}${s.running ? '' : ' · measurement off'}`;
            },
          },
          {
            kind: 'readout',
            id: 'q.governor',
            label: 'governor',
            hint: 'The two numbers Auto actually decides on. It climbs under 2% late and drops over 6%.',
            get: () => {
              const s = quality.status();
              if (!s.samples) return 'no window yet';
              return `${s.fps.toFixed(0)} fps · p95 ${(s.p95 * 1000).toFixed(1)} ms · ${(s.late * 100).toFixed(1)}% late${s.settling ? ' · settling' : ''}`;
            },
          },
          { kind: 'readout', id: 'q.gpu', label: 'gpu', get: () => quality.status().gpu },
        ],
      },
      {
        tab: 'render',
        title: 'Knobs',
        note: 'The same registry the settings menu writes. Touching any of them turns Auto off, exactly as if the menu had been used.',
        rows: [
          this._qualityRow('renderScale', {
            inputId: 'dbg-scale',
            /**
             * IT GOES THROUGH THE REGISTRY, BECAUSE THERE ARE TWO CONTROLS FOR
             * IT. This slider predates the settings menu and used to write
             * main.js's private `renderScale` directly, after which the menu
             * still read 1.00× while the renderer was at 0.60 — and the next
             * preset click anywhere in settings decided nothing had changed.
             * Every perf number taken after that was against an unknown
             * resolution, which is the worst thing a profiling control can do.
             * `onRenderScale` survives below as the fallback for a build where
             * nobody has claimed the knob.
             */
            set: (v) => {
              if (quality.has('renderScale')) quality.set('renderScale', v);
              else this.onRenderScale?.(v);
            },
            dead: () =>
              quality.has('renderScale') || this.onRenderScale
                ? null
                : 'nothing has registered this knob in this build',
          }),
          this._qualityRow('msaa'),
          this._qualityRow('shadows'),
          this._qualityRow('shadowMapSize'),
          this._qualityRow('bloom'),
          this._qualityRow('trail'),
          this._qualityRow('particleDensity'),
          this._qualityRow('instanceDensity'),
          this._qualityRow('fogDistance'),
          this._qualityRow('fov'),
          this._qualityRow('fpsLimit'),
          this._qualityRow('showStats', { label: 'stats overlay' }),
        ].filter(Boolean),
      },
      {
        tab: 'render',
        title: 'Output pass',
        note: 'Straight at the output shader’s uniforms. Not persisted and not part of the quality ladder — a reload puts them back.',
        rows: [
          {
            kind: 'range',
            id: 'post.bloom',
            label: 'bloom amount',
            hint: 'How much of the three blurred mips is added back. The trip lowers the THRESHOLD rather than raising this, which is the difference between a glarier picture and a pupil that will not close.',
            min: 0,
            max: 2,
            step: 0.01,
            get: () => post()?.uBloom.value ?? 0,
            set: (v) => post() && (post().uBloom.value = v),
            format: fmt(2),
            dead: DebugPanel._first(missing(post, 'the pipeline'), () =>
              pipe?.bloomEnabled ? null : 'bloom is off, so there is nothing to add back'
            ),
          },
          {
            kind: 'range',
            id: 'post.exposure',
            label: 'exposure',
            hint: 'Linear gain before the ACES curve. 1.05 is the authored value; every screenshot in scripts/ is against it.',
            min: 0.3,
            max: 2,
            step: 0.01,
            get: () => post()?.uExposure.value ?? 0,
            set: (v) => post() && (post().uExposure.value = v),
            format: fmt(2),
            dead: missing(post, 'the pipeline'),
          },
          {
            kind: 'range',
            id: 'post.vignette',
            label: 'vignette',
            hint: 'Corner darkening. This one IS on the glass, which is why it is small and why it is worth being able to turn off while judging anything else.',
            min: 0,
            max: 1,
            step: 0.01,
            get: () => post()?.uVignette.value ?? 0,
            set: (v) => post() && (post().uVignette.value = v),
            format: fmt(2),
            dead: missing(post, 'the pipeline'),
          },
          {
            kind: 'grid',
            id: 'post.reset',
            columns: 1,
            buttons: [
              {
                label: 'back to the authored pass',
                title: 'bloom 0.42, exposure 1.05, vignette 0.34',
                run: () => {
                  const p = post();
                  if (!p) return;
                  p.uBloom.value = 0.42;
                  p.uExposure.value = 1.05;
                  p.uVignette.value = 0.34;
                  this.sync();
                },
              },
            ],
          },
        ],
      },
      {
        tab: 'render',
        title: 'Dynamic resolution',
        note: 'The fast controller: a per-frame GPU timer moving the internal scale. The slow one is Auto above, and they never write the same knob.',
        rows: [
          {
            kind: 'toggle',
            id: 'drs.enabled',
            label: 'enabled',
            hint: 'Off pins the scale at 1 and restores full viewports. The GPU clock keeps running either way.',
            get: () => Boolean(pipe?.drs.enabled),
            set: (v) => pipe?.setDynamicResolution(v, { measure: true }),
            dead: missing(() => pipe, 'the pipeline'),
          },
          {
            kind: 'toggle',
            id: 'drs.pinned',
            label: 'pin the scale',
            hint: 'Hold the scale by hand. The only way to check the corner clamps: the controller will never sit at 0.6 on a machine that does not need it, and a smear along the right edge is not something a millisecond figure can tell you about.',
            get: () => pipe?.drs.pin !== null && pipe?.drs.pin !== undefined,
            set: (v) => pipe?.pinScale(v ? pipe.drs.scale : null),
            dead: missing(() => pipe, 'the pipeline'),
          },
          {
            kind: 'range',
            id: 'drs.pin',
            label: 'pinned at',
            min: 0.4,
            max: 1,
            step: 0.02,
            get: () => pipe?.drs.pin ?? pipe?.drs.scale ?? 1,
            set: (v) => pipe?.pinScale(v),
            format: fmt(2),
            dead: DebugPanel._first(missing(() => pipe, 'the pipeline'), () =>
              pipe && pipe.drs.pin !== null ? null : 'the scale is not pinned — the controller owns it'
            ),
          },
          {
            kind: 'range',
            id: 'drs.budget',
            label: 'budget',
            hint: 'GPU milliseconds per frame the controller aims under. 0 derives it from the observed display cadence; set it by hand to make the controller engage on a machine with headroom to spare.',
            min: 0,
            max: 20,
            step: 0.5,
            get: () => pipe?.drs.budgetMs ?? 0,
            set: (v) => pipe?.setFrameBudget(v),
            format: (v) => (v > 0 ? `${v.toFixed(1)} ms` : 'auto'),
            dead: missing(() => pipe, 'the pipeline'),
          },
          {
            kind: 'readout',
            id: 'drs.report',
            label: 'state',
            get: () => {
              if (!pipe) return '–';
              const r = pipe.drsReport();
              const engaged = r.frames ? (r.engagedFrames / r.frames) * 100 : 0;
              return `${r.scale.toFixed(2)}× · ${r.gpuMs.toFixed(2)} ms gpu / ${r.budgetMs.toFixed(1)} · engaged ${engaged.toFixed(0)}% · ${r.changes} moves`;
            },
          },
          {
            kind: 'readout',
            id: 'drs.viewport',
            label: 'viewport',
            get: () => {
              if (!pipe) return '–';
              const r = pipe.drsReport();
              return `${Math.round(r.viewport[0])}×${Math.round(r.viewport[1])} of ${Math.round(r.full[0])}×${Math.round(r.full[1])}`;
            },
          },
        ],
      },
      {
        tab: 'render',
        title: 'Frame',
        rows: [
          {
            kind: 'readout',
            id: 'f.rate',
            label: 'rate',
            get: () => `${this._fps.toFixed(0)} fps · ${this._ms.toFixed(2)} ms`,
          },
          {
            kind: 'readout',
            id: 'f.draws',
            label: 'the world',
            hint: 'The SCENE pass, captured inside the pipeline. Reading renderer.info after the frame instead would report the output quad — one draw and two triangles, forever — because three resets those counters on every render call and this pipeline makes eight.',
            get: () => this._sceneStats(),
          },
          {
            kind: 'readout',
            id: 'f.memory',
            label: 'resident',
            get: () => {
              const info = this.renderer?.info;
              if (!info) return '–';
              return `${info.programs?.length ?? 0} programs · ${info.memory.geometries} geo · ${info.memory.textures} tex`;
            },
          },
          {
            kind: 'readout',
            id: 'f.ratio',
            label: 'pixels',
            hint: 'The drawing buffer, which is the window times the pixel-ratio cap times the render-scale knob times whatever dynamic resolution is currently spending.',
            get: () => {
              const r = this.renderer;
              if (!r) return '–';
              const c = r.domElement;
              return `${c.width}×${c.height} · ${r.getPixelRatio().toFixed(2)}× dpr`;
            },
          },
        ],
      },
    ];

    /* ---- world ------------------------------------------------------ */

    const atmos = () => this.atmosphere;
    const ctrl = () => this.controller;

    const world = [
      {
        tab: 'world',
        title: 'Hour',
        rows: [
          {
            kind: 'grid',
            id: 'hours',
            containerId: 'dbg-hours',
            columns: 3,
            buttons: HOURS.map(([label, phase]) => ({
              label,
              title: phase === null ? 'follow the wall clock again' : dayInfo(phase).hhmm,
              on: () => {
                const pinned = dayInfo().pinned;
                if (phase === null) return pinned === null;
                return pinned !== null && Math.abs(pinned - phase) < 1e-6;
              },
              run: () => this._setHour(phase),
            })),
          },
          {
            kind: 'range',
            id: 'tod',
            inputId: 'dbg-tod',
            label: 'hour',
            hint: 'Dragging this PINS the sky, exactly as dragging the trip time seeks the trip. `live` is the release — a day you have hold of is a day that has stopped.',
            min: 0,
            max: 0.999,
            step: 0.001,
            live: () => true,
            get: () => dayInfo().phase,
            set: (v) => this._setHour(v),
            format: (v) => dayInfo(v).hhmm,
          },
          {
            kind: 'range',
            id: 'dayscale',
            label: 'day speed',
            hint: 'Multiplier on the twenty-minute cycle. 8× walks a whole day past in two and a half minutes, which is the only sane way to look at the light. Automation pins the hour regardless of this.',
            min: 0,
            max: 20,
            step: 0.5,
            get: () => dayScale(),
            set: (v) => setDayScale(v),
            format: (v) => `${v}×`,
          },
          {
            kind: 'readout',
            id: 'w.sky',
            label: 'sky',
            get: () => {
              const day = dayInfo();
              return `${day.hhmm}${day.pinned === null ? '' : ' (held)'} · dark ${day.dark.toFixed(2)} · sun ${day.sunElevation.toFixed(0)}°`;
            },
          },
          {
            kind: 'readout',
            id: 'w.key',
            label: 'palette',
            get: () => {
              const a = atmos();
              if (!a) return '–';
              return `${a.day.key()} · ${a.sunSteps} sun steps`;
            },
          },
        ],
      },
      {
        tab: 'world',
        title: 'Air and motion',
        rows: [
          {
            kind: 'toggle',
            id: 'w.freeze',
            label: 'freeze the world',
            hint: 'Trip clock, wind AND the sky, all at once. Setting the trip speed to 0 is not enough on its own: every plant keeps moving and the sun keeps crossing, and a difference image of a world that is still quietly moving traces every edge in the frame no matter what you were testing.',
            get: () => Boolean(this._probe()?.frozen),
            set: (v) => {
              this._probe()?.freeze(v);
              this.sync();
            },
            dead: missing(() => this._probe(), 'the bisection probe'),
          },
          {
            kind: 'range',
            id: 'w.wind',
            label: 'wind rate',
            hint: 'Multiplier on the wind clock alone. 0 holds every plant still without stopping the trip; 3 or 4 finds out what a gust does without waiting in the wood for one.',
            min: 0,
            max: 4,
            step: 0.1,
            get: () => this.windScale,
            set: (v) => (this.windScale = v),
            format: (v) => `${v.toFixed(1)}×`,
            dead: () =>
              this._probe()?.frozen ? 'the world is frozen, which zeroes the wind outright' : null,
          },
          {
            kind: 'readout',
            id: 'w.windphase',
            label: 'wind',
            get: () => `${u.uWind.value.x.toFixed(1)}, ${u.uWind.value.y.toFixed(1)}`,
          },
          {
            kind: 'readout',
            id: 'w.fog',
            label: 'fog',
            hint: 'The live density, which is the authored one times the hour, the view-distance knob, how far underground you are, and the trip’s own breathing wave.',
            get: () => {
              const a = atmos();
              if (!a?.fog) return '–';
              return `${a.fog.density.toFixed(4)} · base ${a.base.fogDensity.toFixed(4)}`;
            },
          },
        ],
      },
      {
        tab: 'world',
        title: 'Body',
        rows: [
          {
            kind: 'toggle',
            id: 'b.fly',
            label: 'fly',
            hint: 'Gravity, trunks, cave walls and the ground clamp all off. Space rises, Shift descends, and the world bounds still hold. Nothing else in the app knows you are flying — the audio listener, the culler and the streamer all follow you as usual.',
            get: () => Boolean(ctrl()?.fly),
            set: (v) => ctrl() && (ctrl().fly = v),
            dead: missing(ctrl, 'the controller'),
          },
          {
            kind: 'range',
            id: 'b.speed',
            label: 'speed',
            hint: 'Multiplier on walking and running. Flight is already faster than this on its own.',
            min: 0.25,
            max: 8,
            step: 0.25,
            get: () => ctrl()?.speedScale ?? 1,
            set: (v) => ctrl() && (ctrl().speedScale = v),
            format: (v) => `${v.toFixed(2)}×`,
            dead: missing(ctrl, 'the controller'),
          },
          {
            kind: 'grid',
            id: 'b.go',
            columns: 3,
            buttons: [
              { label: 'spawn', title: 'the clearing you arrive in', at: () => ({ x: 0, z: 5 }) },
              {
                label: 'commons',
                title: 'the big clearing the plan puts a screen in',
                at: () => this.gathering?.sites?.commons,
              },
              {
                label: 'fire',
                title: 'the first hearth in the plan',
                at: () => this.gathering?.sites?.hearths?.[0],
              },
              {
                label: 'jetty',
                title: 'the first landing on the river',
                at: () => this.gathering?.jetties?.[0]?.site,
              },
              {
                label: 'view',
                title: 'the first viewpoint in the plan',
                at: () => this.gathering?.sites?.viewpoints?.[0],
              },
              {
                /**
                 * The one landmark you cannot navigate to by knowing the plan.
                 *
                 * Every other button here goes to something `gathering.js`
                 * chose and can therefore be looked up by name. A cave belongs
                 * to the ridge and the seed, so the only way to answer "where is
                 * the nearest one" has always been to fly along the mountain
                 * until you saw a gully — which is exactly the complaint this
                 * exists to answer.
                 *
                 * It lands you in the gully rather than at the mouth: fourteen
                 * metres down the approach, looking up it, because arriving
                 * inside the doorway skips the part that tells you it is a cave.
                 */
                label: 'cave',
                title: 'the approach to the nearest cave mouth on this seed',
                at: () => {
                  const c = ctrl();
                  const from = c ? c.position : { x: 0, z: 0 };
                  const near = cavesNear(from.x, from.z, 1600);
                  if (!near.length) return null;
                  return caveAxisPoint(near[0], near[0].aHold - 14, 0);
                },
              },
              {
                label: '+40 m',
                title: 'straight up, for a look at the canopy',
                run: () => {
                  const c = ctrl();
                  if (!c) return;
                  c.fly = true;
                  c.position.y += 40;
                },
              },
            ].map((b) =>
              b.run
                ? b
                : {
                    label: b.label,
                    title: b.title,
                    run: () => this._teleport(b.at()),
                  }
            ),
          },
          {
            kind: 'readout',
            id: 'b.where',
            label: 'at',
            get: () => {
              const c = ctrl();
              if (!c) return '–';
              return `${c.position.x.toFixed(1)}, ${c.position.y.toFixed(1)}, ${c.position.z.toFixed(1)}`;
            },
          },
          {
            /**
             * Which way the nearest cave is, and how far.
             *
             * A compass point rather than a bearing in degrees, because the
             * question this answers is "which way do I walk" and nobody holds a
             * protractor. The distance is to the MOUTH — the head of the gully —
             * so it counts down to zero at the place the arch is, not at the
             * place the notch starts.
             */
            kind: 'readout',
            id: 'b.cave',
            label: 'nearest cave',
            get: () => {
              const c = ctrl();
              if (!c) return '–';
              const near = cavesNear(c.position.x, c.position.z, 1600);
              if (!near.length) return 'none within 1.6 km';
              const cave = near[0];
              const dx = cave.x - c.position.x;
              const dz = cave.z - c.position.z;
              const d = Math.hypot(dx, dz);
              // Screen north is -z, and the compass runs clockwise from it.
              const brg = (Math.atan2(dx, -dz) * 180) / Math.PI;
              const point = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][
                Math.round(((brg + 360) % 360) / 45) % 8
              ];
              return `${d.toFixed(0)} m ${point} · ${cave.x.toFixed(0)}, ${cave.z.toFixed(0)}`;
            },
          },
          {
            kind: 'readout',
            id: 'b.state',
            label: 'moving',
            get: () => {
              const c = ctrl();
              if (!c) return '–';
              const cave = c.inCave > 0 ? ` · cave ${c.inCave.toFixed(2)} at ${c.caveDepth.toFixed(0)} m` : '';
              return `${c.speed.toFixed(1)} m/s · ${c.fly ? 'flying' : c.onGround ? 'on the ground' : 'in the air'}${cave}`;
            },
          },
        ],
      },
      {
        tab: 'world',
        title: 'Streaming',
        rows: [
          {
            kind: 'readout',
            id: 's.trees',
            label: 'forest',
            hint: 'Both rings take at most one sector per frame, so "pending" falling to zero is what "the world has finished arriving" means.',
            get: () => {
              const f = this.forest;
              if (!f) return '–';
              return `${f.field.built} built · ${f.field.pending} pending`;
            },
          },
          {
            kind: 'readout',
            id: 's.ground',
            label: 'ground',
            get: () => {
              const f = this.forest;
              if (!f) return '–';
              return `${f.groundField.group.children.length} chunks · ${f.groundField.pending} pending`;
            },
          },
          {
            kind: 'readout',
            id: 's.cull',
            label: 'culler',
            hint: 'Instances re-uploaded on the last repack. Since the packer became incremental most repacks move no bytes at all.',
            get: () => {
              const c = this.forest?.culler;
              if (!c) return '–';
              return `${c.uploaded} uploaded · ${c.packers?.length ?? 0} layers`;
            },
          },
          {
            kind: 'grid',
            id: 's.actions',
            columns: 2,
            buttons: [
              {
                label: 'repack now',
                title: 'force one cull pass against the current camera',
                run: () => this.camera && this.forest?.culler?.update(this.camera, true),
              },
              {
                label: 'unhide all',
                title: 'restore every instance the culler has packed away',
                run: () => this.forest?.culler?.restoreAll(),
              },
            ],
          },
        ],
      },
      {
        tab: 'world',
        title: 'Session',
        rows: [
          { kind: 'readout', id: 'x.seed', label: 'seed', get: () => this.seed ?? '–' },
          {
            kind: 'readout',
            id: 'x.net',
            label: 'room',
            get: () => {
              const n = this.net;
              if (!n) return '–';
              const peers = n.peers?.length ?? 0;
              return `${n.status}${peers ? ` · ${peers} peer${peers === 1 ? '' : 's'}` : ''}`;
            },
          },
          {
            kind: 'grid',
            id: 'x.actions',
            columns: 2,
            buttons: [
              {
                label: 'copy this world',
                title: 'a ?seed= link that rebuilds this exact wood',
                run: () => this._copy(`${location.origin}${location.pathname}?seed=${encodeURIComponent(this.seed ?? '')}`),
              },
              {
                label: 'copy state',
                title: 'everything this panel can see, as JSON, for a bug report',
                run: () => this._copy(JSON.stringify(this.snapshot(), null, 2), true),
              },
            ],
          },
        ],
      },
    ];

    /* ---- sound ------------------------------------------------------ */

    const sound = [
      {
        tab: 'sound',
        title: 'Transport',
        note: 'Every knob below this is a treatment OF something. With nothing playing they are all silent, which is what they say.',
        rows: [
          {
            kind: 'grid',
            id: 'a.transport',
            columns: 3,
            buttons: [
              {
                label: 'play',
                title: 'start or stop the synthesised record',
                on: () => Boolean(this._music()?.playing),
                run: () => {
                  const m = this._music();
                  if (!m) return;
                  this.speakers?.setPlaying(m.toggle());
                  this.sync();
                },
              },
              {
                label: 'next',
                title: 'the next track in the jukebox',
                run: () => {
                  const m = this._music();
                  if (!m) return;
                  m.next();
                  if (!m.playing) m.start();
                  this.speakers?.setPlaying(true);
                  this.sync();
                },
              },
              {
                label: 'trip audio',
                title: 'the same switch as the Trip tab’s audio family',
                on: () => d.switches.audio,
                run: () => (d.switches.audio = !d.switches.audio),
              },
            ],
          },
          /**
           * The trip transport, on the SOUND page.
           *
           * A duplicate of four controls that already exist one tab away, and it
           * earns the duplication: the `Trip ·` knobs are documented as their
           * value at full intensity, so the instruction for every one of them is
           * "seek to ego death and turn it there". Making that a trip to another
           * page and back, once per knob, is how a tuning session ends up being
           * conducted at whatever intensity happened to be left over.
           */
          {
            kind: 'grid',
            id: 'a.trip',
            columns: 4,
            caption: () =>
              d.paused
                ? null
                : 'the trip is running — it will walk out of this phase while you listen, and end in a few minutes',
            buttons: [
              {
                label: 'sober',
                title: 'end it — the Trip · knobs go dead and the record is heard raw',
                on: () => !d.describe().active,
                run: () => {
                  d.state.override = null;
                  d.ground();
                },
              },
              {
                label: 'peak',
                title: 'the plateau, where most of a trip is actually spent',
                on: () => d.state.active && d.state.phase.id === 'peak',
                run: () => d.seek(DebugPanel.seekFor(PHASES[2])),
              },
              {
                label: 'ego death',
                title:
                  'the middle of the dissolve, where intensity is pinned at 1 — the one place a Trip · slider means literally what it says',
                on: () => d.state.active && d.state.phase.id === 'egodeath',
                run: () => d.seek(DebugPanel.seekFor(PHASES[3])),
              },
              {
                label: 'pause',
                title:
                  'hold it there. The layers, surges and breath keep running; only the position in the five minutes stops, so the trip cannot walk off the phase you are tuning',
                on: () => d.paused,
                run: () => {
                  d.pause(!d.paused);
                  this.sync();
                },
              },
            ],
          },
          {
            kind: 'readout',
            id: 'a.playing',
            label: 'playing',
            get: () => {
              const ext = this._external();
              if (ext?.playing) return `link: ${ext.title ?? 'untitled'}`;
              const m = this._music();
              if (m?.playing) return `record: ${m.trackName}`;
              return 'nothing';
            },
          },
          {
            kind: 'readout',
            id: 'a.ctx',
            label: 'context',
            get: () => {
              const a = this.audio;
              if (!a?.ctx) return 'not created yet';
              return `${a.ctx.state} · ${(a.ctx.sampleRate / 1000).toFixed(1)} kHz`;
            },
          },
          {
            kind: 'meter',
            id: 'a.bass',
            label: 'bass',
            get: () => this.audio?.levels?.x ?? 0,
            text: () => (this.audio?.levels?.x ?? 0).toFixed(2),
            dead: this._needsAll(['audio']),
          },
          {
            kind: 'meter',
            id: 'a.mid',
            label: 'mid',
            get: () => this.audio?.levels?.y ?? 0,
            text: () => (this.audio?.levels?.y ?? 0).toFixed(2),
            dead: this._needsAll(['audio']),
          },
          {
            kind: 'meter',
            id: 'a.high',
            label: 'high',
            get: () => this.audio?.levels?.z ?? 0,
            text: () => (this.audio?.levels?.z ?? 0).toFixed(2),
            dead: this._needsAll(['audio']),
          },
        ],
      },
      {
        tab: 'sound',
        title: 'Presets',
        note: 'Two banks that do not touch each other, so what you hear is the pair. A preset sets EVERY knob in its bank, including the ones it does not change — so two clicks in a row compare two presets, never one preset with the leftovers of the other.',
        rows: this._presetRows(),
      },
      {
        tab: 'sound',
        title: 'Explore',
        note: 'Five neighbours of the sound you have now. Keep the one you like best and the next five are neighbours of THAT, closer in each time — a search conducted by ear, rather than by guessing which of twenty knobs to touch. Each button says the biggest thing it changes; hover for the rest.',
        rows: this._exploreRows(),
      },
      {
        tab: 'sound',
        title: 'Buses',
        rows: ['volume.master', 'volume.music', 'volume.world', 'volume.sfx', 'volume.voice']
          .map((id) => this._qualityRow(id, { format: pct }))
          .filter(Boolean),
      },
      ...this._soundFolds(),
      {
        tab: 'sound',
        title: 'Tuning',
        rows: [
          {
            kind: 'grid',
            id: 'a.tuning',
            columns: 2,
            buttons: [
              { label: 'export', title: 'the source block, the clipboard and a file', run: () => void this._exportSound() },
              { label: 'reset', title: 'back to the values in tuning.js — both banks', run: () => tuning.reset() },
            ],
          },
          {
            kind: 'readout',
            id: 'a.preset',
            label: 'preset',
            hint: 'What the export will be labelled with. “edited” means the knobs in that bank are not on any preset — which is the normal state five minutes into a session, and exactly what export is for.',
            get: () =>
              presets.BANKS.map((b) => `${b.id}: ${presets.active(b.id) ?? 'edited'}`).join(' · '),
          },
          {
            kind: 'readout',
            id: 'a.changed',
            label: 'changed',
            get: () => {
              const changed = tuning.modified();
              return changed.length ? `${changed.length} — ${changed.join(', ')}` : 'none, this is the shipping sound';
            },
          },
          {
            kind: 'note',
            text: 'Nothing here is persisted, on purpose: reload and every knob is back to the value in the source. Export produces the block to paste over DEFAULTS, plus a JSON file carrying the preset names.',
          },
        ],
      },
    ];

    /* ---- layers ----------------------------------------------------- */

    const layers = [
      {
        tab: 'layers',
        title: 'Everything that can draw',
        note: 'Click to hide or show. Shift-click to solo — everything else goes off. This is the bisection surface `RR.probe` exposes to the console, so the two can never disagree.',
        rows: [
          {
            kind: 'grid',
            id: 'l.all',
            columns: 3,
            buttons: [
              { label: 'all on', run: () => this._probe()?.all(true) },
              { label: 'all off', run: () => this._probe()?.all(false) },
              {
                label: 'reset',
                title: 'every layer back, every gain to 1, every switch on',
                run: () => {
                  this._probe()?.reset();
                  this.sync();
                },
              },
            ],
          },
          { kind: 'layers', id: 'l.grid' },
        ],
      },
    ];

    return [...trip, ...render, ...world, ...sound, ...layers];
  }

  /**
   * The search: a bank picker, six audition buttons and four answers.
   *
   * THE THREE ANSWERS A ROUND CAN HAVE, and each is a button, because a search
   * that only understands "this one" gets stuck the first time none of the five
   * is an improvement:
   *
   *   THIS ONE          `keep`   — becomes the centre, and the next five are
   *                                closer in.
   *   NONE, LOOK CLOSER `keep`   with nothing auditioned — the centre stays and
   *                                the neighbourhood narrows anyway.
   *   NONE, LOOK WIDER  `wider`  — same centre, a bigger neighbourhood. The
   *                                answer when all five sound like each other.
   *
   * `again` is the fourth thing you need, which is not an answer but a re-deal:
   * five different neighbours at the same distance, for when the five you got
   * happened to move the wrong knobs. `undo` walks the whole thing back a round,
   * because by round five you can be somewhere worse than round three and no
   * amount of listening will tell you that from the inside.
   *
   * `keep` ACCEPTS WHEREVER THE KNOBS ARE, not the candidate the panel thinks is
   * lit. So dragging a slider mid-search is not a thing that confuses it — it is
   * just another way to move, and `keep` folds it in. That also keeps this
   * honest about the panel's second rule: the knobs are still owned by
   * `tuning.js`, and the only state here is the search itself.
   */
  _exploreRows() {
    const x = this._explore;
    const running = () => x.round > 0 && Boolean(x.center);
    const idle = () => !running();
    return [
      {
        kind: 'enum',
        id: 'e.bank',
        label: 'bank',
        hint: 'Which half to search. Changing it abandons the search in progress — a centre taken from the other bank would be meaningless, and silently carrying one over is how you end up tuning the thing you are not listening to.',
        options: presets.BANKS.map((b) => ({ value: b.id, label: b.label.toLowerCase() })),
        get: () => x.bank,
        set: (v) => {
          if (v === x.bank) return;
          x.bank = v;
          this._exploreClear();
        },
      },
      {
        kind: 'grid',
        id: 'e.candidates',
        // TWO, WHERE EVERY OTHER GRID IN THE PANEL IS THREE. These are the only
        // buttons here whose text is written at runtime, and "record voices ↓↓
        // +2" in a third of the panel's width ellipsises into "record voic…",
        // which loses both the direction and the count — the two things the
        // label exists to carry.
        columns: 2,
        caption: () => this._exploreCaption(),
        buttons: [
          {
            label: 'current',
            title: 'back to the centre of this round — the thing the five are variations of. The A of every A/B here',
            dim: idle,
            on: () => running() && x.lit < 0,
            run: () => running() && this._exploreAudition(-1),
          },
          ...Array.from({ length: 5 }, (_, i) => ({
            label: `–`,
            text: () => x.candidates[i]?.label ?? '–',
            tip: () =>
              x.candidates[i]
                ? `${presets.describeChanges(x.candidates[i].changes)}  ·  click to hear it, then keep`
                : 'press explore',
            dim: () => !x.candidates[i],
            on: () => x.lit === i,
            run: () => x.candidates[i] && this._exploreAudition(i),
          })),
        ],
      },
      {
        kind: 'grid',
        id: 'e.actions',
        columns: 3,
        buttons: [
          {
            label: 'explore',
            title: 'start a search centred on the sound you have right now — a preset you just clicked, or wherever the sliders are',
            run: () => this._exploreStart(),
          },
          {
            label: 'keep',
            title: 'make whatever you can hear right now the new centre, and narrow the search. With nothing auditioned this means “none of these, look closer to home”',
            dim: idle,
            run: () => running() && this._exploreKeep(),
          },
          {
            label: 'wider',
            title: 'same centre, a bigger neighbourhood. For when all five sound like each other',
            dim: idle,
            run: () => running() && this._exploreWider(),
          },
          {
            label: 'again',
            title: 'five different neighbours at the same distance, for when this five moved the wrong knobs',
            dim: idle,
            run: () => running() && this._exploreAgain(),
          },
          {
            label: 'undo',
            title: 'back to the previous round’s centre and neighbourhood',
            dim: () => !x.history.length,
            run: () => this._exploreUndo(),
          },
          {
            label: 'stop',
            title: 'leave the knobs exactly where they are and forget the search. Export is how you keep the result',
            dim: idle,
            run: () => this._exploreClear(),
          },
        ],
      },
      {
        kind: 'readout',
        id: 'e.state',
        label: 'search',
        hint: 'Spread is how far a candidate may move one knob, as a fraction of that knob’s own slider. It halves-ish each time you keep one, so early rounds are about direction and late ones about how far.',
        // How far from the source this has wandered is deliberately NOT here:
        // the Tuning section below counts that already, and the same number in
        // two places is the beginning of two numbers that disagree.
        get: () =>
          running()
            ? `round ${x.round} · spread ${Math.round(x.spread * 100)}% · from ${x.from}`
            : 'not started — press explore',
      },
    ];
  }

  /** What the candidate row has to admit to right now. */
  _exploreCaption() {
    const x = this._explore;
    const need = this._needsAll(
      x.bank === 'trip' ? ['audio', 'tripswitch', 'trip', 'music'] : ['audio', 'music']
    )();
    if (need) return need;
    if (x.round > 0 && this._exploreHold().length) {
      return `${this._exploreHold().length} cabinet knob${this._exploreHold().length === 1 ? '' : 's'} held still — they only touch a pasted link, and a candidate you cannot hear is a wasted one`;
    }
    return null;
  }

  /**
   * The knobs the search must not move, because they cannot be heard.
   *
   * INTERSECTED WITH THE BANK, and the caption is why. `LINK_ONLY` is seven
   * knobs across both banks; the record bank contains two of them. Reporting
   * "7 cabinet knobs held" while searching a bank that owns two is precisely the
   * kind of confidently wrong number this panel exists to not print.
   */
  _exploreHold() {
    if (this._external()?.playing) return [];
    const mine = new Set(presets.keysIn(this._explore.bank));
    return presets.LINK_ONLY.filter((id) => mine.has(id));
  }

  _exploreClear() {
    const x = this._explore;
    x.center = null;
    x.round = 0;
    x.candidates = [];
    x.history = [];
    x.lit = -1;
    this.sync();
  }

  _exploreStart() {
    const x = this._explore;
    x.center = presets.snapshotOf(x.bank);
    // What it was called when you started, so six rounds later the readout can
    // still say where this came from. `active` is the honest answer and it is
    // usually null by round two, which is the whole reason to capture it now.
    x.from = presets.active(x.bank) ?? 'here';
    x.spread = EXPLORE_SPREAD;
    x.round = 1;
    x.history = [];
    x.lit = -1;
    this._exploreRoll();
  }

  _exploreRoll() {
    const x = this._explore;
    x.seed += 1;
    x.candidates = presets.variations(x.bank, {
      center: x.center,
      spread: x.spread,
      count: 5,
      seed: `${x.round}.${x.seed}`,
      hold: this._exploreHold(),
    });
    this.sync();
  }

  _exploreAudition(i) {
    const x = this._explore;
    const values = i < 0 ? x.center : x.candidates[i]?.values;
    if (!values) return;
    tuning.setMany(values);
    x.lit = i;
    this._say(i < 0 ? 'the centre' : x.candidates[i].label);
  }

  _exploreKeep() {
    const x = this._explore;
    x.history.push({ center: x.center, spread: x.spread, round: x.round });
    if (x.history.length > 24) x.history.shift();
    // Wherever the knobs are, not what the panel thinks is lit. See the header.
    x.center = presets.snapshotOf(x.bank);
    x.spread = Math.max(EXPLORE_FLOOR, x.spread * 0.62);
    x.round += 1;
    x.lit = -1;
    this._exploreRoll();
  }

  _exploreAgain() {
    // Back to the centre first: a re-deal you hear from inside the last
    // candidate is a re-deal you cannot judge, because the reference moved.
    this._exploreAudition(-1);
    this._exploreRoll();
  }

  _exploreWider() {
    const x = this._explore;
    x.spread = Math.min(EXPLORE_CEILING, x.spread * 1.8);
    this._exploreAudition(-1);
    this._exploreRoll();
  }

  _exploreUndo() {
    const x = this._explore;
    const back = x.history.pop();
    if (!back) return;
    x.center = back.center;
    x.spread = back.spread;
    x.round = back.round;
    x.lit = -1;
    tuning.setMany(x.center);
    this._exploreRoll();
  }

  /**
   * The two preset banks, built from `presets.js` the same way the sliders below
   * are built from `tuning.js` — one grid per bank, in the module's own order.
   *
   * WHAT EACH BANK NEEDS BEFORE IT CAN BE HEARD IS DIFFERENT, and the captions
   * say which. The record bank is the treatment of a playing record and is
   * silent with nothing playing. The trip bank is silent with nothing playing
   * AND while sober AND with the audio family switched off — but three of its
   * layers (drone, sparks, voices) are not treatments of anything and will play
   * to an empty wood, so its caption asks for the trip first and the record
   * second.
   *
   * THE BUTTONS STAY LIVE WHEN THEY CANNOT BE HEARD, which is the one place this
   * page departs from the panel's rule about dead controls. A slider you cannot
   * hear teaches you something false when you drag it; a preset you cannot hear
   * yet is the ordinary way to set up before eating, and disabling it would mean
   * the only way to arrange a comparison was to arrange it mid-trip. So the
   * caption tells you what is missing and the button still works.
   */
  _presetRows() {
    const rows = [];
    for (const bank of presets.BANKS) {
      const list = presets.presetsIn(bank.id);
      rows.push({ kind: 'note', text: `${bank.label} — ${bank.note}` });
      rows.push({
        kind: 'grid',
        id: `p.${bank.id}`,
        columns: 3,
        // Not rendered — grids draw buttons and nothing else — but it is what
        // the search box matches on, so typing "microscope" finds the bank that
        // has one rather than nothing at all.
        hint: list.map((p) => p.label).join(' '),
        // `_needsAll` is the same test that kills a slider; used as a caption it
        // only reports, and the buttons stay live. See above.
        caption: this._needsAll(
          bank.id === 'trip' ? ['audio', 'tripswitch', 'trip', 'music'] : ['audio', 'music']
        ),
        buttons: list.map((preset) => ({
          label: preset.label,
          title: preset.note,
          on: () => presets.active(bank.id) === preset.id,
          run: () => {
            presets.apply(bank.id, preset.id);
            this._say(`${bank.label.toLowerCase()}: ${preset.label}`);
          },
        })),
      });
    }
    if (presets.UNBANKED.length) {
      rows.push({
        kind: 'note',
        text: `NOT IN ANY BANK, so no preset sets them: ${presets.UNBANKED.join(', ')}. A group was renamed in tuning.js or added without a line in presets.js.`,
      });
    }
    return rows;
  }

  /**
   * The sound knobs, built from `tuning.js`'s own schema rather than written out
   * as markup like the trip gains.
   *
   * Those seven have never changed and probably never will. The sound ones are
   * the live surface of a thing that took a dozen four-minute measuring runs to
   * set, and the whole point of putting them here is that the next round of
   * tuning happens by ear — so the panel has to grow a row the moment somebody
   * adds a knob, without anybody remembering to edit two files. The `hint` is the
   * schema's own, which is where the expensive knowledge is: which end of each
   * slider is the one that has already gone wrong once.
   *
   * One fold per group, shut by default. Thirty-three sliders in a column is the
   * thing this panel was rebuilt to stop being.
   */
  _soundFolds() {
    const groups = [];
    for (const knob of tuning.KNOBS) {
      let group = groups.find((g) => g.title === knob.group);
      if (!group) {
        group = { tab: 'sound', title: knob.group, fold: true, rows: [] };
        groups.push(group);
      }
      group.rows.push({
        kind: 'range',
        id: `t.${knob.id}`,
        label: knob.label,
        hint: knob.hint,
        min: knob.min,
        max: knob.max,
        step: knob.step,
        get: () => tuning.TUNING[knob.id],
        set: (v) => tuning.set(knob.id, v),
        format: (v) => {
          const dp = knob.step >= 1 ? 0 : String(knob.step).split('.')[1].length;
          return `${v.toFixed(dp)}${knob.unit ?? ''}`;
        },
        changed: () => tuning.TUNING[knob.id] !== tuning.DEFAULTS[knob.id],
        dead: this._needsAll(SOUND_NEEDS[knob.group] ?? []),
      });
    }
    return groups;
  }

  /* ------------------------------------------------------------------ */
  /* building the DOM                                                    */
  /* ------------------------------------------------------------------ */

  _build() {
    const tabs = this.el.querySelector('#dbg-tabs');
    this._tabButtons = new Map();
    for (const tab of TABS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = tab.title;
      b.addEventListener('click', () => this.showTab(tab.id));
      tabs.appendChild(b);
      this._tabButtons.set(tab.id, b);
    }

    const body = this.el.querySelector('#dbg-body');
    this._sectionEls = [];
    for (const section of this._sections()) {
      const el = document.createElement(section.fold ? 'details' : 'section');
      el.className = 'dbg-section';
      el.dataset.tab = section.tab;
      const head = document.createElement(section.fold ? 'summary' : 'h3');
      head.textContent = section.title;
      el.appendChild(head);
      if (section.note) {
        const note = document.createElement('p');
        note.className = 'dbg-note';
        note.textContent = section.note;
        el.appendChild(note);
      }
      for (const row of section.rows) el.appendChild(this._buildRow(row));
      body.appendChild(el);
      this._sectionEls.push(el);
    }

    // A fold that has just been opened has to paint immediately — otherwise the
    // first quarter-second of it shows whatever was true the last time it was
    // open, which on the first open of a session is nothing at all. `toggle`
    // does not bubble, so every fold is listened to individually.
    for (const fold of this.el.querySelectorAll('details')) {
      fold.addEventListener('toggle', () => this.sync());
    }

    const filter = this.el.querySelector('#dbg-filter');
    filter.addEventListener('input', () => {
      this._filter = filter.value.trim().toLowerCase();
      this._applyFilter();
    });
    // A panel you opened to change one thing should not eat the key that closes
    // it, and the world must not hear anything typed into the box.
    filter.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' || e.code === 'Backquote') {
        e.preventDefault();
        filter.blur();
        if (e.code === 'Backquote') this.toggle(false);
      }
      e.stopPropagation();
    });
  }

  _buildRow(row) {
    const el = document.createElement('div');
    el.className = `dbg-row dbg-${row.kind}`;
    // The row's schema id, on the element. Not decoration: it is how a test
    // reaches a control without matching on its label, and a label is the one
    // thing about a control that is allowed to be reworded.
    if (row.id) el.dataset.id = row.id;
    el.dataset.search = `${row.label ?? ''} ${row.title ?? ''} ${row.id ?? ''} ${row.hint ?? ''}`.toLowerCase();
    const record = { row, el, inputs: [] };

    if (row.kind === 'grid' || row.kind === 'layers') {
      el.classList.add('dbg-grid');
      if (row.containerId) el.id = row.containerId;
      el.style.setProperty('--cols', String(row.columns ?? 3));
      const buttons = row.kind === 'layers' ? [] : row.buttons;
      record.buttons = [];
      for (const spec of buttons) record.buttons.push(this._buildButton(el, spec));
      if (row.kind === 'layers') record.lazyLayers = true;
      /**
       * A caption under a row of buttons, and it goes INSIDE the grid.
       *
       * The buttons are direct children of the grid container, so a sibling
       * paragraph would sit outside the row and lose its alignment; a child
       * spanning every column (see the CSS) keeps it under the buttons it is
       * about. It is built last so `_ensureLayers`, which appends its buttons to
       * this same element long afterwards, cannot put them after the caption.
       */
      if (row.caption) {
        const why = document.createElement('p');
        why.className = 'dbg-why';
        el.appendChild(why);
        record.why = why;
      }
    } else if (row.kind === 'note') {
      el.classList.add('dbg-note');
      el.textContent = row.text;
    } else if (row.kind === 'fold') {
      const fold = document.createElement('details');
      fold.className = 'dbg-subfold';
      const summary = document.createElement('summary');
      summary.textContent = row.title;
      fold.appendChild(summary);
      for (const sub of row.rows) fold.appendChild(this._buildRow(sub));
      el.appendChild(fold);
    } else {
      const label = document.createElement('label');
      label.textContent = row.label;
      if (row.hint) label.title = row.hint;
      el.appendChild(label);

      if (row.kind === 'range') {
        const input = document.createElement('input');
        input.type = 'range';
        if (row.inputId) input.id = row.inputId;
        input.min = String(row.min);
        input.max = String(row.max);
        input.step = String(row.step);
        input.addEventListener('input', () => {
          row.set(Number(input.value));
          this._paintRow(record);
        });
        input.addEventListener('pointerdown', () => (this._scrubbing = true));
        el.appendChild(input);
        record.inputs.push(input);
      } else if (row.kind === 'toggle') {
        const input = document.createElement('button');
        input.type = 'button';
        input.className = 'dbg-toggle';
        input.addEventListener('click', () => {
          row.set(!row.get());
          this._paintRow(record);
        });
        el.appendChild(input);
        record.inputs.push(input);
      } else if (row.kind === 'enum') {
        const seg = document.createElement('div');
        seg.className = 'dbg-segment';
        for (const option of row.options ?? []) {
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.value = String(option.value);
          b.textContent = option.label;
          b.addEventListener('click', () => {
            row.set(option.value);
            this._paintRow(record);
          });
          seg.appendChild(b);
          record.inputs.push(b);
        }
        el.appendChild(seg);
      } else if (row.kind === 'meter') {
        const bar = document.createElement('div');
        bar.className = 'dbg-bar';
        const fill = document.createElement('i');
        bar.appendChild(fill);
        el.appendChild(bar);
        record.fill = fill;
      }

      if (row.kind !== 'toggle' && row.kind !== 'enum') {
        const value = document.createElement('span');
        value.className = 'dbg-val';
        el.appendChild(value);
        record.value = value;
      }

      if (row.dead) {
        const why = document.createElement('p');
        why.className = 'dbg-why';
        el.appendChild(why);
        record.why = why;
      }
    }

    /**
     * A DUPLICATE ID IS A SILENT SWAP, AND IT HAS ALREADY HAPPENED ONCE.
     *
     * `this._rows` is keyed on the id and `debug-check.mjs` reaches a control by
     * `data-id`, because a label is the one part of a control that is allowed to
     * be reworded. Both take the LAST or the FIRST of a duplicate pair and
     * neither says so: the search's `x.actions` collided with the World page's
     * Session buttons, so every click a test aimed at `explore` landed on `copy
     * this world`, the search never started, and nothing anywhere reported a
     * problem — the panel drew perfectly and the test read "not started" six
     * times in a row.
     *
     * A warning rather than a throw. This is a debug panel; refusing to build
     * over a naming clash would take the whole tool away at the moment you most
     * need it, and the console line is enough to save the hour.
     */
    if (row.id) {
      if (this._rows.has(row.id)) {
        console.warn(`debug panel: two rows are called "${row.id}" — a test or a sync will hit the wrong one`);
      }
      this._rows.set(row.id, record);
    }
    return el;
  }

  _buildButton(host, spec) {
    const b = document.createElement('button');
    b.type = 'button';
    // `label` and `title` are what a button IS; `text()` and `tip()` are for the
    // handful whose meaning is discovered at runtime — the search's candidates,
    // which are five different sounds every round and have to say which.
    b.textContent = spec.text ? spec.text() : spec.label;
    if (spec.title) b.title = spec.title;
    b.addEventListener('click', (e) => {
      spec.run?.(e);
      this.sync();
    });
    host.appendChild(b);
    return { spec, el: b };
  }

  /**
   * The layer grid, built the first time it is looked at.
   *
   * `probe` does not exist when this panel is constructed — see the note on the
   * constructor argument — and the list is its property rather than this file's,
   * because the same list is what the console bisects with.
   */
  _ensureLayers() {
    if (this._layersBuilt) return;
    const record = this._rows.get('l.grid');
    const probe = this._probe();
    if (!record || !probe?.layers) return;
    this._layersBuilt = true;
    record.el.style.setProperty('--cols', '3');
    record.buttons = [];
    for (const name of Object.keys(probe.layers)) {
      const objects = () => probe.layers[name]?.() ?? [];
      record.buttons.push(
        this._buildButton(record.el, {
          label: name,
          title: 'click to hide or show · shift-click to solo',
          /**
           * `some`, not `every`, and the difference is the culler.
           *
           * Half the layers here are instanced slabs that the culler hides and
           * shows as you walk, so `every` reported trunks as OFF while you were
           * looking at a wood full of them — which is a bisection tool lying
           * about the state of the thing being bisected. The question this
           * button answers is "is any of this layer being drawn", which is what
           * `show(name, on)` sets and therefore what it can honestly report.
           */
          on: () => objects().some((o) => o.visible),
          /**
           * …and a layer with nothing in it is neither on nor off. Shared
           * screens exist only while somebody is sharing and the rod only while
           * one is out; drawing those as plain "off" invites ten minutes of
           * wondering why turning them on does nothing.
           */
          dim: () => objects().length === 0,
          run: (e) => {
            if (e?.shiftKey) probe.only(name);
            else probe.show(name, !objects().some((o) => o.visible));
          },
        })
      );
    }
    this._applyFilter();
  }

  /* ------------------------------------------------------------------ */
  /* state                                                               */
  /* ------------------------------------------------------------------ */

  showTab(id) {
    if (!this._tabButtons.has(id)) return;
    this._tab = id;
    for (const [tab, button] of this._tabButtons) button.classList.toggle('on', tab === id);
    if (id === 'layers') this._ensureLayers();
    this._applyFilter();
    const body = this.el.querySelector('#dbg-body');
    if (body) body.scrollTop = 0;
    this.sync();
  }

  /**
   * The filter searches EVERY tab, not the one you are on.
   *
   * A panel with a hundred and forty controls in it has exactly one question a
   * newcomer asks — "where is the thing that does X" — and answering it with
   * "not on this page" five times is the whole cost of tabs. While the box has
   * anything in it the tab strip stops applying and every section is a candidate.
   */
  _applyFilter() {
    const q = this._filter;
    let matches = 0;
    for (const el of this._sectionEls) {
      const onTab = el.dataset.tab === this._tab;
      if (!q) {
        el.hidden = !onTab;
        for (const row of el.querySelectorAll('.dbg-row')) row.hidden = false;
        continue;
      }
      let any = false;
      for (const row of el.querySelectorAll('.dbg-row')) {
        // A grid is one row of many buttons, so it matches on its own label and
        // on the section's — filtering the buttons individually would leave a
        // phase strip with one button in it, which is not a control.
        const hit =
          (row.dataset.search ?? '').includes(q) || el.querySelector('h3, summary')?.textContent.toLowerCase().includes(q);
        row.hidden = !hit;
        any = any || hit;
        if (hit) matches++;
      }
      el.hidden = !any;
      if (el.tagName === 'DETAILS' && any) el.open = true;
    }
    this.el.querySelector('#dbg-tabs').classList.toggle('searching', Boolean(q));
    // A search that matches nothing leaves an empty panel, which reads as the
    // panel having broken rather than as the word not being in it.
    const empty = this.el.querySelector('#dbg-empty');
    if (empty) {
      empty.hidden = !q || matches > 0;
      if (!empty.hidden) setText(empty, `nothing on any page matches “${q}”`);
    }
  }

  /**
   * Re-read every visible row from whoever owns it, and re-judge it.
   *
   * THE REASON IS PRINTED ONCE PER RUN OF ROWS THAT SHARE IT. Eight sliders in a
   * column each captioned "sober — every amount here is multiplied by the trip
   * level" is a wall of the same sentence, and a wall of the same sentence is
   * read as decoration rather than as an explanation. The rows are still all
   * dimmed and all disabled, which is the part that says WHICH controls are
   * inert; the caption only has to say why, and it only has to say it once.
   */
  sync() {
    if (!this.visible) return;
    let prevSection = null;
    let prevWhy = null;
    for (const record of this._rows.values()) {
      if (record.el.hidden) continue;
      // A row inside a shut fold is not on screen, and there are fifty of them.
      // `closest` walks to the first match, so this covers the section itself
      // when the section is one of the folds.
      const fold = record.el.closest('details');
      if (fold && !fold.open) continue;
      const section = record.el.closest('.dbg-section');
      if (section?.hidden) continue;
      const why = this._paintRow(record);
      if (why && why === prevWhy && section === prevSection && record.why) setText(record.why, '');
      prevWhy = why;
      prevSection = section;
    }
  }

  /** Paint one row, and hand back the reason it is dead, if it is. */
  _paintRow(record) {
    const { row, el } = record;

    if (record.buttons) {
      for (const { spec, el: button } of record.buttons) {
        if (spec.on) button.classList.toggle('on', Boolean(spec.on()));
        if (spec.dim) button.classList.toggle('dim', Boolean(spec.dim()));
        if (spec.text) setText(button, spec.text());
        if (spec.tip) button.title = spec.tip();
      }
      // A caption, not a death: the buttons stay live. Returned so `sync` can
      // fold two identical ones in a section into one printed sentence, the
      // same way it does for the sliders.
      const note = row.caption ? row.caption() : null;
      if (record.why) setText(record.why, note ?? '');
      return note;
    }
    if (row.kind === 'note' || row.kind === 'fold') return null;

    const why = row.dead ? row.dead() : null;
    const dead = Boolean(why);
    el.classList.toggle('dead', dead);
    if (record.why) setText(record.why, why ?? '');

    if (row.kind === 'range') {
      const input = record.inputs[0];
      const v = row.get();
      // A control you have hold of must never be written to underneath your
      // finger — the same rule the settings menu's sliders follow.
      if (document.activeElement !== input && (row.live ? row.live() : true)) {
        const s = String(v);
        if (input.value !== s) input.value = s;
      }
      input.disabled = dead;
      setText(record.value, row.format ? row.format(v) : String(v));
      if (record.value) record.value.classList.toggle('changed', Boolean(row.changed?.()));
    } else if (row.kind === 'toggle') {
      const on = Boolean(row.get());
      const input = record.inputs[0];
      setText(input, on ? 'on' : 'off');
      input.classList.toggle('on', on);
      input.disabled = dead;
    } else if (row.kind === 'enum') {
      const v = String(row.get());
      for (const b of record.inputs) {
        b.classList.toggle('on', b.dataset.value === v);
        b.disabled = dead;
      }
    } else if (row.kind === 'meter') {
      const v = Math.max(0, Math.min(1, row.get()));
      record.fill.style.width = `${(v * 100).toFixed(1)}%`;
      setText(record.value, row.text ? row.text() : v.toFixed(2));
    } else if (row.kind === 'readout') {
      setText(record.value, String(row.get()));
    }
    return why;
  }

  /**
   * Pin the sky, or let go of it.
   *
   * `null` releases — and under automation that releases to the AUTHORED hour
   * rather than to the wall clock, which is what a script wants after it has
   * finished photographing midnight.
   */
  _setHour(phase) {
    setDayPhase(phase);
    this.sync();
  }

  _teleport(site) {
    const c = this.controller;
    if (!c || !site || typeof site.x !== 'number') return;
    c.position.x = site.x;
    c.position.z = site.z;
    c.position.y = groundUnder(site.x, site.z) + c.eyeHeight + 0.2;
    c.velocity.set(0, 0, 0);
  }

  async _copy(text, alsoLog = false) {
    if (alsoLog) console.log(text);
    try {
      await navigator.clipboard.writeText(text);
      this._say('copied');
    } catch {
      console.log(text);
      this._say('no clipboard here — written to the console');
    }
  }

  _say(text) {
    const el = this.el.querySelector('#dbg-said');
    if (!el) return;
    setText(el, text);
    window.clearTimeout(this._sayTimer);
    this._sayTimer = window.setTimeout(() => setText(el, ''), 2600);
  }

  /**
   * Take the tuning out of the browser.
   *
   * THREE FORMATS, BECAUSE THEY ANSWER DIFFERENT QUESTIONS. The console gets the
   * source block, which is the one that ends a tuning session — it is pasted
   * over `DEFAULTS` and the file describes the sound again. The clipboard gets
   * JSON, because that is what goes into `RR.tuning.load(...)` in a second
   * browser or a bug report. The download is the same JSON kept, since a
   * clipboard survives exactly one copy of anything else.
   */
  async _exportSound() {
    /**
     * `_preset` RIDES ALONG INSIDE THE VALUES, and it is not decoration.
     *
     * An export is a set of forty numbers, and forty numbers do not say what
     * question was being asked when they were taken — whereas "record:clean
     * trip:microscope, then eight knobs moved" says it in a line, which is what
     * whoever receives this needs before they can decide anything. `load`
     * ignores keys that are not knobs, so this still goes straight back in
     * through `RR.tuning.load(...)` unchanged.
     */
    const ids = presets.activeIds();
    const x = this._explore;
    // Where a hand-tuned sound came from. By the time an export is worth taking,
    // both banks usually read "edited" — which is true and says nothing. This is
    // the sentence that makes the file legible six weeks later.
    if (x.round > 0) {
      ids.explored = `${x.bank}: ${x.round} round${x.round === 1 ? '' : 's'} from ${x.from}, spread ${Math.round(x.spread * 100)}%`;
    }
    const blob = { ...tuning.toJSON(), _preset: ids };
    const json = JSON.stringify(blob, null, 2);
    const changed = tuning.modified();
    const named = presets.BANKS.map((b) => `${b.id}:${ids[b.id] ?? 'edited'}`).join(' ');

    console.log(`%c-- ${named} · ${changed.length} knob${changed.length === 1 ? '' : 's'} away from the source --`, 'font-weight:bold');
    console.log('%c-- paste over DEFAULTS in src/audio/tuning.js --', 'font-weight:bold');
    console.log(tuning.toSource());
    // The short form, for pasting into a message. The full block above is for
    // pasting into the file, and a person reading a chat window wants the six
    // lines that moved rather than the forty that did not.
    if (changed.length) {
      console.log(
        '-- only what moved --\n' +
          changed.map((id) => `  ${id}: ${tuning.TUNING[id]},  // was ${tuning.DEFAULTS[id]}`).join('\n')
      );
    }
    console.log('-- or RR.tuning.load(...) with --\n' + json);
    try {
      await navigator.clipboard.writeText(json);
    } catch {
      /* no clipboard here; the console copy is the fallback */
    }
    const stamp = presets.BANKS.map((b) => ids[b.id] ?? 'edited').join('-');
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `reality-room-sound-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this._say(`exported ${named} — the source block is in the console`);
  }

  /** Everything this panel can see, for a bug report. */
  snapshot() {
    const day = dayInfo();
    const t = this.director.describe();
    return {
      seed: this.seed,
      trip: {
        phase: t.phase.id,
        time: Number(t.time.toFixed(1)),
        level: Number(t.level.toFixed(3)),
        dissolve: Number(t.dissolve.toFixed(3)),
        surge: Number((t.surge ?? 0).toFixed(3)),
        override: t.override,
        paused: t.paused,
        switches: { ...this.director.switches },
        gain: { ...this.director.gain },
        speed: this.speed,
      },
      day: { hhmm: day.hhmm, phase: Number(day.phase.toFixed(4)), pinned: day.pinned, scale: dayScale() },
      quality: {
        ...quality.status(),
        overrides: Object.fromEntries(quality.overrides),
      },
      drs: this.pipeline?.drsReport?.() ?? null,
      frame: {
        fps: Number(this._fps.toFixed(1)),
        ms: Number(this._ms.toFixed(2)),
        scene: { ...(this.pipeline?.sceneStats ?? {}) },
      },
      sound: {
        preset: presets.activeIds(),
        changed: tuning.modified(),
        tuning: tuning.toJSON(),
        playing: this._playing(),
      },
      world: {
        wind: this.windScale,
        frozen: Boolean(this._probe()?.frozen),
        position: this.controller
          ? [this.controller.position.x, this.controller.position.y, this.controller.position.z].map((n) =>
              Number(n.toFixed(2))
            )
          : null,
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* keys, visibility, the frame                                         */
  /* ------------------------------------------------------------------ */

  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      // The same three guards every other world listener uses. The one that
      // matters here is the modal check: this panel is not inside `#ui`, so
      // opening it from under the settings menu used to paint it straight
      // through the scrim.
      if (!worldHearsKey(e)) return;
      if (e.code === 'Backquote') {
        e.preventDefault();
        this.toggle();
        return;
      }
      if (!this.visible) return;
      if (e.code === 'BracketRight') this._stepPhase(1);
      if (e.code === 'BracketLeft') this._stepPhase(-1);
      /**
       * K stops the trip where it is. Panel-open only, like the brackets.
       *
       * The transport letter from every editing program there has ever been, and
       * the reason it is worth a key at all rather than only a button: the thing
       * you pause for is usually something you are in the middle of listening
       * to, and crossing the panel with the mouse to reach a button is several
       * seconds of the trip walking on.
       */
      if (e.code === 'KeyK') {
        this.director.pause(!this.director.paused);
        this.sync();
      }
      if (e.code === 'Backslash') {
        const d = this.director;
        d.state.override = d.state.override === null ? d.eased : null;
        this.sync();
      }
      // Digits pick a tab, which is the one shortcut a panel with pages owes
      // somebody whose other hand is on the mouse.
      const digit = Number(e.code.startsWith('Digit') ? e.code.slice(5) : NaN);
      if (digit >= 1 && digit <= TABS.length) this.showTab(TABS[digit - 1].id);
    });
    window.addEventListener('pointerup', () => (this._scrubbing = false));
  }

  _stepPhase(direction) {
    const t = this.director.state.time;
    let index = PHASES.findIndex((p) => t < p.to);
    if (index < 0) index = PHASES.length - 1;
    const next = index + direction;
    if (next < 0 || next >= PHASES.length) {
      this.director.ground();
      return;
    }
    this.director.seek(DebugPanel.seekFor(PHASES[next]));
  }

  toggle(force) {
    this.visible = force ?? !this.visible;
    this.el.hidden = !this.visible;
    if (this.visible) {
      if (document.pointerLockElement) document.exitPointerLock();
      if (this._tab === 'layers') this._ensureLayers();
      this.sync();
    }
  }

  /**
   * Called every frame from main.js, with the renderer, so the frame readouts
   * describe the frame that was actually just drawn.
   *
   * The fps counter runs whether or not the panel is open — it is the one number
   * you want to already have when you open it — and everything else is throttled
   * and skipped entirely while hidden.
   */
  update(dt, renderer) {
    if (renderer) this.renderer = renderer;
    this._frames += 1;
    this._fpsAccum += dt;
    this._msAccum += dt * 1000;
    this._msFrames += 1;
    if (this._fpsAccum >= 0.5) {
      this._fps = this._frames / this._fpsAccum;
      this._ms = this._msAccum / Math.max(1, this._msFrames);
      this._frames = 0;
      this._fpsAccum = 0;
      this._msAccum = 0;
      this._msFrames = 0;
    }
    if (!this.visible) return;

    this._syncAccum += dt;
    if (this._syncAccum >= SYNC_PERIOD) {
      this._syncAccum = 0;
      this.sync();
    }

    this._footAccum += dt;
    if (this._footAccum >= FOOT_PERIOD) {
      this._footAccum = 0;
      const day = dayInfo();
      setText(
        this.el.querySelector('#dbg-foot'),
        `${this._fps.toFixed(0)} fps · ${this._ms.toFixed(1)} ms · ${this._sceneStats()} · ` +
          // The pause is the one debug state that outlives your memory of
          // setting it — nothing on screen moves differently, the trip simply
          // stops going anywhere — so it is worth a word on the always-visible
          // line rather than only on the page that owns the button.
          `lvl ${this.director.eased.toFixed(2)}${this.director.paused ? ' paused' : ''} · ${day.hhmm}`
      );
    }
  }

  /**
   * Let go of the registry.
   *
   * Nothing calls this today — main.js builds one panel for the life of the page
   * and a change to this file triggers a full reload rather than an HMR swap. It
   * exists so that the subscriptions above have an owner: a listener on a module
   * singleton with no way to remove it is the shape of leak that only shows up
   * later, when somebody does make this panel disposable.
   */
  dispose() {
    this._unsubscribeQuality?.();
    this._unsubscribeQuality = null;
    this._unsubscribeTuning?.();
    this._unsubscribeTuning = null;
    window.clearTimeout(this._sayTimer);
  }
}

/* -------------------------------------------------------------------------- */

/** A DOM write that early-outs when nothing changed. This runs on the frame path. */
function setText(el, text) {
  if (!el) return;
  if (el.textContent !== text) el.textContent = text;
}

const SHELL = `
  <header class="dbg-head">
    <h2>debug</h2>
    <input id="dbg-filter" type="search" placeholder="search every page…" spellcheck="false" />
  </header>
  <nav class="dbg-tabs" id="dbg-tabs"></nav>
  <div class="dbg-body" id="dbg-body"><p class="dbg-note" id="dbg-empty" hidden></p></div>
  <footer class="dbg-foot"><span id="dbg-foot">–</span><em id="dbg-said"></em></footer>
`;
