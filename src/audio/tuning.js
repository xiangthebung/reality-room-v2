/**
 * The numbers the music's trip treatment is tuned on, as knobs rather than
 * constants.
 *
 * Every value in here was arrived at by running `npm run audio:record`, reading
 * a table, changing a `const`, and running it again — about four minutes a
 * round, and no way at all to hear the change while it was happening. That is a
 * fine way to satisfy a threshold and a terrible way to decide how something
 * should sound, because the two questions this file answers are "does the
 * limiter stay still" and "is there enough bass", and only the first one is
 * measurable. The second is somebody standing in the clearing with a record on.
 *
 * So the numbers live here, mutable, with a schema next to them, and the debug
 * panel builds sliders from that schema. Turn them with the music playing and a
 * trip running; export when it sounds right.
 *
 * WHAT `export` IS FOR, AND WHY IT IS NOT A SAVE BUTTON. There is deliberately
 * no persistence: reload and every knob is back to the value in `DEFAULTS`,
 * exactly as the visual gain sliders in the same panel already behave. A tuning
 * quietly restored from localStorage three weeks later is a build that does not
 * match its own source, and the first symptom is a measuring script disagreeing
 * with a person about what the game sounds like. Export produces the block to
 * paste INTO `DEFAULTS`, so the source stays the only description of the sound.
 *
 * `RR.tuning` is the same object from the console — `RR.tuning.set('lowMax', 3)`,
 * `RR.tuning.load({...})` to put an exported blob back, `RR.tuning.reset()`.
 */

/**
 * THE SHIPPING VALUES. Everything the sliders do is relative to this block, and
 * pasting an exported one over it is the whole workflow.
 *
 * The reasoning behind each of these lives next to the node it drives, in
 * `trip-audio.js` and `external-track.js`, because that is where it is
 * checkable. What follows is only what a person turning the knob needs to know.
 */
export const DEFAULTS = Object.freeze({
  lowMax: 2.05,
  subMax: 0.25,
  harmMax: 1.05,
  harmDrive: 1.65,
  harmLow: 110,
  harmHigh: 330,
  bassCeiling: 1.7,
  harmCeiling: 3,
  lowCorner: 150,
  hallMax: 0.95,
  hallLow: 2725,
  /**
   * BOTH AT 1, WHICH IS TWICE THE LEVEL THE REST OF THIS FILE WAS MEASURED
   * AGAINST, AND IS A CHOSEN SETTING RATHER THAN AN OVERSIGHT.
   *
   * These two are the same recording twice — see `external-track.js` — so for
   * the correlated middle of a mix they sum by amplitude to 2.0 where the tuned
   * pair summed to 1.0. The record therefore arrives about six decibels hotter
   * at a limiter sitting at -5 dBFS, and the limiter gives those six decibels
   * back by turning everything down, including every layer the trip is adding.
   * See the measurement in the block comment below.
   *
   * It is left where it was set because it was set deliberately and it is the
   * loudest, brightest the record can be. What it costs is the trip's audibility
   * on music, which is the complaint that came with it.
   */
  dryMix: 1,
  wetMix: 1,

  /**
   * ---- THE TRIP'S MIX AUTOMATION -------------------------------------------
   *
   * EVERY KNOB BELOW IS ITS VALUE AT FULL INTENSITY, and that convention is the
   * whole reason they can be tuned at all. `trip-audio.js` interpolates each one
   * from its sober value to the number here as `intensity` goes 0..1, so what a
   * slider shows is what you get standing at the top of a trip and nowhere else.
   * Tune at ego death, where `intensity` is pinned at 1 and the reading is
   * literal; the shape of the approach is code, not a knob.
   *
   * WHY THIS BLOCK EXISTS AT ALL. Until it did, the trip was purely ADDITIVE —
   * every layer a send into the limiter, nothing anywhere turning anything down.
   * A mix that can only get fuller, in front of a limiter sitting at -5 dBFS,
   * cannot sound like anything but itself with the limiter working harder. That
   * is the "it sounds the same as sober" report, and no amount of new layers
   * fixes it, because the limiter takes back exactly what they add. Something
   * has to get quieter first. These are the things that get quieter.
   */

  /**
   * ---- the world steps back ------------------------------------------------
   *
   * NOT A FADE-OUT. `worldDuck` alone would be one, and a wood that simply gets
   * quieter reads as a broken volume control. The other three are what make it
   * read as DISTANCE, which is a thing the engine already has a vocabulary for:
   * `createSpatial` codes distance as treble loss, so a low-pass on the whole
   * world is the same sentence in the same language, spoken about everything at
   * once.
   *
   * `worldCarve` is the one doing the work for the music. It is a mid-band cut,
   * and the band is chosen to be where the record's detail wants to live —
   * scooping the wood there is what makes room for the thing arriving in your
   * head, rather than just making the wood smaller.
   *
   * `worldWet` compensates on the OTHER side of the same send. The dry world
   * drops, the cosmos tail it is already feeding does not — so the ratio moves,
   * and a source whose dry falls while its reverb holds is the oldest "it went
   * further away" cue there is. Past about 2 the wood stops having a location.
   */
  worldDuck: 0.5,
  worldFar: 1500,
  worldCarve: 5,
  worldCarveAt: 1250,
  worldWet: 1.7,

  /**
   * ---- the record comes into your head -------------------------------------
   *
   * `external-track.js` argues at length that head-locked stereo is wrong, and
   * SOBER IT IS. Two descriptions of one clearing, one of them welded to the
   * skull, and the ear believes the wrong one. At the top of a trip that
   * argument inverts: there is no clearing left to describe — see `worldDuck`
   * above, which is busy deleting it — so there is only one description and
   * nothing for it to contradict.
   *
   * `headWet` IS THE INTERESTING ONE AND IT DOES THREE JOBS WITH ONE NUMBER. The
   * HRTF path carries localisation and costs the treble: an HRIR is a filter
   * with deep notches at 4-10 kHz, differently placed per channel, which is the
   * "underwater" quality that file was written to explain. Turning it down at
   * the peak therefore (a) unwelds the record from the cabinets, (b) hands back
   * the top end, so the record is at its highest fidelity of the session exactly
   * when you are paying most attention to it, and (c) recovers headroom, because
   * dry and wet are the same recording twice and sum by amplitude.
   *
   * That third one is the point. At the shipping 1/1 the record arrives about
   * six decibels hot and the limiter gives them back by turning down everything
   * the trip is adding. `headWet` at 0.15 against `headDry` at 1.3 sums to 1.45
   * where sober sums to 2.0 — most of three decibels of room, appearing exactly
   * as the layers that need it arrive.
   *
   * 0.15 RATHER THAN 0 IS A CHOICE ABOUT WHETHER THE CLEARING STILL EXISTS. At
   * zero the cabinets stop having a position and the wood is nowhere; a trace
   * keeps them faintly findable. It is the one number here that is a question
   * about the design rather than about the sound, so it is a slider.
   *
   * `headNear` removes the distance model from the record — at 1 it no longer
   * fades as you walk away, because a thing inside your head does not. This is
   * the knob that quietly costs the most: following the bass line home is a real
   * navigational aid in a forest that is the same in all directions.
   */
  headLock: 1,
  headWidth: 0.85,
  headWet: 0.15,
  headDry: 1.3,
  headNear: 0.8,

  /**
   * ---- what the existing layers are worth ----------------------------------
   *
   * These five were hard-coded, and every one of them was set by ear against a
   * QUIET WOOD — a bird, a footstep, a stick. Against a mastered record they are
   * twenty-odd decibels down and effectively do not exist. Now that the two
   * blocks above make room, they are the first thing to push into it, and they
   * are sliders because the right answer is different for a forest and for a
   * record and there is no measurement that knows which one you are standing in.
   */
  droneMax: 0.26,
  breathMax: 0.06,
  sparkMax: 0.05,
  voiceMax: 0.5,
  pulseMax: 0.26,

  /**
   * ---- detail that is not there when you are sober -------------------------
   *
   * Processing alone cannot answer "more detailed"; detail is new information.
   * Three sources of it, cheapest first, all in `trip-audio.js`.
   *
   * `scopeMax` is the spectral microscope: four parallel bands on the record,
   * each swimming forward and back on its own slow cycle, never all up at once.
   * The auditory twin of `state.surge`, and the layer that most reliably reads
   * as "there is more in here than I noticed". `scopeRate` is the base period —
   * the four bands are multiples of it that do not divide into each other, so
   * the pattern never lands on itself.
   *
   * `murmurMusic` feeds the record into the resonant bandpasses that already
   * exist for the wind, so the record starts growing voices. Auditory
   * misinterpretation is reported about music far more often than about wind,
   * and the machinery was already built — this is three connections.
   *
   * `shimmerMax` is a feedback-free high-band tap delay, cross-panned. NOT MORE
   * REVERB: this project has already learned twice over what more reverb does to
   * a record. Two taps, no recursion, nothing below 1.8 kHz — it can add air and
   * it cannot add fog.
   */
  scopeMax: 0.6,
  scopeRate: 0.055,
  murmurMusic: 0.35,
  shimmerMax: 0.3,
  shimmerTime: 105,
});

/**
 * The schema the panel draws from.
 *
 * `hint` is written for somebody turning the knob and hearing the result, not
 * for somebody reading the graph. Where a knob has a known failure mode at one
 * end, the hint says which end — that is the part that is expensive to
 * rediscover.
 *
 * RANGES GO COMFORTABLY PAST WHAT IS SENSIBLE, on purpose. A slider that stops
 * at the last good value cannot answer "is this too much?", and the fastest way
 * to find the edge of a setting is to go over it once.
 */
export const KNOBS = [
  {
    group: 'Weight',
    id: 'lowMax',
    label: 'shelf',
    min: 0,
    max: 5,
    step: 0.05,
    hint: '30-150 Hz summed back. Makes what is already there louder. The most expensive knob here in limiter terms — bass sets the peak.',
  },
  {
    group: 'Weight',
    id: 'subMax',
    label: 'sub',
    min: 0,
    max: 2.5,
    step: 0.05,
    hint: 'The synthesised octave beneath the bass. Felt rather than heard; the first thing to trade away if the mix starts pumping.',
  },
  {
    group: 'Weight',
    id: 'harmMax',
    label: 'harmonics',
    min: 0,
    max: 5,
    step: 0.05,
    hint: 'Overtones ABOVE the bass, where a small speaker can find them. The cheap knob: more apparent bass per decibel of gain reduction.',
  },
  {
    group: 'Weight',
    id: 'harmDrive',
    label: 'drive',
    min: 0.2,
    max: 4,
    step: 0.05,
    hint: 'How hard the harmonic generator is pushed. Past about 2 the intermodulation between kick and bass starts reading as clangour rather than weight.',
  },
  {
    group: 'Weight',
    id: 'harmLow',
    label: 'harm from',
    min: 80,
    max: 400,
    step: 5,
    unit: 'Hz',
    hint: 'Everything below this is thrown away after the shaper. Drop it far and this stops being an exciter and becomes a second bass shelf.',
  },
  {
    group: 'Weight',
    id: 'harmHigh',
    label: 'harm to',
    min: 300,
    max: 1600,
    step: 10,
    unit: 'Hz',
    hint: 'Above here the overtones stop belonging to the bass and start sitting on the vocal.',
  },
  {
    group: 'Weight',
    id: 'bassCeiling',
    label: 'bass ceil',
    min: 1,
    max: 8,
    step: 0.1,
    hint: 'Soft ceiling on shelf + sub. HIGHER IS A LOWER CEILING. Past about 3 it makes pumping worse, not better — it squares the waveform and raises the sustain.',
  },
  {
    group: 'Weight',
    id: 'harmCeiling',
    label: 'harm ceil',
    min: 1,
    max: 10,
    step: 0.1,
    hint: 'The same, on the harmonics. Leaving this open is what let a band-passed kick ring at crest 3.2 straight into the limiter.',
  },
  {
    group: 'Weight',
    id: 'lowCorner',
    label: 'shelf top',
    min: 80,
    max: 260,
    step: 5,
    unit: 'Hz',
    hint: 'Top of the shelf band. Above ~180 it starts lifting the low mids, which is where a mix is muddy rather than heavy.',
  },
  {
    group: 'Space',
    id: 'hallMax',
    label: 'hall',
    min: 0,
    max: 4,
    step: 0.05,
    hint: 'The record’s own reverb send. This is the knob that turned a pasted track into white noise when it was fed the whole spectrum.',
  },
  {
    group: 'Space',
    id: 'hallLow',
    label: 'hall from',
    min: 300,
    max: 3000,
    step: 25,
    unit: 'Hz',
    hint: 'Only the record above this gets a tail. Lowering it puts the mids back into the reverb, which is exactly the roar that started all this.',
  },
  {
    group: 'Cabinet',
    id: 'dryMix',
    label: 'direct',
    min: 0,
    max: 1,
    step: 0.01,
    hint: 'The unfiltered, amplitude-panned path. Carries the treble; keep it and the wet roughly summing to 1, since they are the same recording twice and add by amplitude.',
  },
  {
    group: 'Cabinet',
    id: 'wetMix',
    label: 'HRTF',
    min: 0,
    max: 1,
    step: 0.01,
    hint: 'The head-related path. Carries the localisation and costs the top end — this is the half that made pasted links sound underwater when it was the only one.',
  },

  /**
   * Everything below is a FULL-INTENSITY value — see the block comment in
   * DEFAULTS. Turn these with a record playing and a trip seeked to ego death,
   * where the interpolation is at 1 and the slider means literally what it says.
   */
  {
    group: 'Trip · world',
    id: 'worldDuck',
    label: 'duck',
    min: 0,
    max: 1,
    step: 0.01,
    hint: 'How far the dry world drops at the peak. On its own this is a fade-out and reads as a broken volume control — it needs the three below to become distance.',
  },
  {
    group: 'Trip · world',
    id: 'worldFar',
    label: 'distance',
    min: 300,
    max: 20000,
    step: 50,
    unit: 'Hz',
    hint: 'Low-pass on the whole world at the peak. This is the engine’s own distance cue applied to everything at once. Below ~700 the wood is underwater rather than far away.',
  },
  {
    group: 'Trip · world',
    id: 'worldCarve',
    label: 'carve',
    min: 0,
    max: 18,
    step: 0.5,
    unit: 'dB',
    hint: 'Mid-band cut in the world, where the record’s detail wants to live. The knob that makes ROOM rather than quiet. Past ~10 the forest is hollow.',
  },
  {
    group: 'Trip · world',
    id: 'worldCarveAt',
    label: 'carve at',
    min: 400,
    max: 4000,
    step: 25,
    unit: 'Hz',
    hint: 'Centre of that cut. Low puts it in the wind and the stream, high puts it in birdsong and leaf detail.',
  },
  {
    group: 'Trip · world',
    id: 'worldWet',
    label: 'wet lift',
    min: 0.5,
    max: 3,
    step: 0.05,
    hint: 'The cosmos tail, against a dry world that is now falling. Dry down + wet held is the oldest “it went further away” cue there is. Past ~2 the wood has no location at all.',
  },

  {
    group: 'Trip · cabinet',
    id: 'headLock',
    label: 'head-lock',
    min: 0,
    max: 1,
    step: 0.01,
    hint: 'How far the record detaches from the cabinets and follows your head. At 0 it stays in the clearing; at 1 turning around no longer moves it.',
  },
  {
    group: 'Trip · cabinet',
    id: 'headWidth',
    label: 'width',
    min: 0,
    max: 1,
    step: 0.01,
    hint: 'The fixed stereo image once head-locked. This is amplitude panning, so it cannot collapse to mono — but at 1 the middle of the record thins out.',
  },
  {
    group: 'Trip · cabinet',
    id: 'headWet',
    label: 'HRTF at peak',
    min: 0,
    max: 1,
    step: 0.01,
    hint: 'Multiplies the HRTF path at the peak. DOWN buys three things at once: no comb filtering (detail), no fixed position (in your head), and ~3 dB of headroom. At 0 the clearing stops existing.',
  },
  {
    group: 'Trip · cabinet',
    id: 'headDry',
    label: 'direct at peak',
    min: 0.5,
    max: 2.5,
    step: 0.05,
    hint: 'Multiplies the direct path at the peak. Raise to replace what HRTF took; raise too far and you hand the headroom straight back to the limiter.',
  },
  {
    group: 'Trip · cabinet',
    id: 'headNear',
    label: 'draw near',
    min: 0,
    max: 1,
    step: 0.01,
    hint: 'How much of the distance model is removed. At 1 the record no longer fades as you walk away — which also deletes following the bass line home.',
  },

  {
    group: 'Trip · layers',
    id: 'droneMax',
    label: 'drone',
    min: 0,
    max: 1.5,
    step: 0.01,
    hint: 'The just-intonation bed. Tuned against a quiet wood at 0.26; against a record that is inaudible.',
  },
  {
    group: 'Trip · layers',
    id: 'breathMax',
    label: 'breath',
    min: 0,
    max: 0.5,
    step: 0.005,
    hint: 'The audible half of the room breathing. Filtered dark, so it goes further than the number suggests.',
  },
  {
    group: 'Trip · layers',
    id: 'sparkMax',
    label: 'sparks',
    min: 0,
    max: 0.4,
    step: 0.005,
    hint: 'Peak level of one FM bell. These are sparse on purpose — the gaps are what make them feel like they are happening to you.',
  },
  {
    group: 'Trip · layers',
    id: 'voiceMax',
    label: 'voices',
    min: 0,
    max: 2.5,
    step: 0.05,
    hint: 'The resonant bandpasses on the wind. Arrives at 0.45 intensity and not before.',
  },
  {
    group: 'Trip · layers',
    id: 'pulseMax',
    label: 'pulse',
    min: 0,
    max: 1,
    step: 0.01,
    hint: 'The sub-50 Hz ego-death body sensation. Measured at a quarter of the limiter swing at ego death — that is designed, not a fault to tune away.',
  },

  {
    group: 'Trip · detail',
    id: 'scopeMax',
    label: 'microscope',
    min: 0,
    max: 2,
    step: 0.05,
    hint: 'Four bands of the record swimming forward and back on incommensurate cycles. The layer that reads as “there is more in here than I noticed”.',
  },
  {
    group: 'Trip · detail',
    id: 'scopeRate',
    label: 'swim',
    min: 0.01,
    max: 0.3,
    step: 0.005,
    unit: 'Hz',
    hint: 'Base rate of that swimming. Past ~0.15 it stops being attention wandering and starts being a phaser.',
  },
  {
    group: 'Trip · detail',
    id: 'murmurMusic',
    label: 'record voices',
    min: 0,
    max: 1.5,
    step: 0.05,
    hint: 'Feeds the record into the wind’s resonators, so the music starts growing voices. Q is 26 — on tonal material this whistles if pushed.',
  },
  {
    group: 'Trip · detail',
    id: 'shimmerMax',
    label: 'shimmer',
    min: 0,
    max: 1.5,
    step: 0.05,
    hint: 'Cross-panned high-band taps. No feedback and nothing below 1.8 kHz, so it can add air and cannot add fog.',
  },
  {
    group: 'Trip · detail',
    id: 'shimmerTime',
    label: 'tap',
    min: 20,
    max: 400,
    step: 5,
    unit: 'ms',
    hint: 'First tap; the second is 1.6× it. Under ~30 this is comb filtering rather than a delay, and the record’s top end goes metallic.',
  },
];

/** The live values. Read directly and often; written through `set`. */
export const TUNING = { ...DEFAULTS };

const listeners = new Set();

/**
 * Called after any change, with no argument.
 *
 * Deliberately not per-knob: the two consumers both re-apply everything they own
 * in a handful of parameter writes, and a subscriber that has to know which knob
 * moved is a subscriber that silently misses the one nobody remembered to name.
 * Returns its own unsubscribe.
 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce() {
  for (const fn of listeners) fn();
}

/** The write itself, without telling anybody. See `setMany`. */
function write(id, value) {
  if (!(id in DEFAULTS)) return false;
  const knob = KNOBS.find((k) => k.id === id);
  const v = Number(value);
  if (!Number.isFinite(v)) return false;
  // Clamped to the schema rather than trusted. `load` takes whatever an exported
  // file says, and a hand-edited one is the likeliest source of a number that
  // would put a filter corner past Nyquist or a gain somewhere a limiter cannot
  // save.
  TUNING[id] = knob ? Math.min(knob.max, Math.max(knob.min, v)) : v;
  return true;
}

export function set(id, value) {
  if (!write(id, value)) return false;
  announce();
  return true;
}

/**
 * Several knobs, and ONE announcement.
 *
 * A preset is twenty knobs at once, and `set` per knob would be twenty rounds of
 * the whole downstream re-apply — `trip-audio.js` rewrites about fifteen audio
 * parameters and rebuilds up to two waveshaper curves every time it hears — plus
 * twenty full re-reads of a debug panel with a hundred and forty rows in it, all
 * inside one frame. Nothing about that is wrong, and all of it happens at the
 * moment a person is listening for a change. Returns how many were taken.
 */
export function setMany(values) {
  if (!values || typeof values !== 'object') return 0;
  let n = 0;
  for (const [id, v] of Object.entries(values)) {
    if (write(id, v)) n++;
  }
  if (n) announce();
  return n;
}

export function reset() {
  Object.assign(TUNING, DEFAULTS);
  announce();
}

/** Which knobs are away from the shipping value, and by how much. */
export function modified() {
  return Object.keys(DEFAULTS).filter((id) => TUNING[id] !== DEFAULTS[id]);
}

/**
 * Put an exported blob back. Unknown keys are ignored rather than thrown on —
 * which is also what carries the `_preset` field the panel's export writes
 * alongside the values, so an exported file can say where it came from without
 * this having to know what a preset is.
 */
export function load(obj) {
  return setMany(obj);
}

export function toJSON() {
  return { ...TUNING };
}

/**
 * The current values as the source block they would replace.
 *
 * This is the actual deliverable of a tuning session — not the JSON, which is
 * for handing to another browser, but something that can be pasted over
 * `DEFAULTS` above so the file and the sound agree again.
 */
export function toSource() {
  const width = Math.max(...Object.keys(DEFAULTS).map((k) => k.length));
  const lines = Object.keys(DEFAULTS).map((id) => {
    const v = TUNING[id];
    const changed = v !== DEFAULTS[id] ? `  // was ${DEFAULTS[id]}` : '';
    return `  ${id}:${' '.repeat(width - id.length)} ${v},${changed}`;
  });
  return `export const DEFAULTS = Object.freeze({\n${lines.join('\n')}\n});`;
}
