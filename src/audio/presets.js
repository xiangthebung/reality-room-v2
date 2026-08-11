import { DEFAULTS, KNOBS, TUNING, setMany } from './tuning.js';
import { makeRng } from '../core/util.js';

/**
 * Named settings of the sound knobs, in two banks that do not touch each other.
 *
 *
 * WHY TWO BANKS AND NOT ONE LIST.
 *
 * `tuning.js` holds thirty-three knobs answering two completely different
 * questions, and a session spent listening only ever asks one of them at a time:
 *
 *   THE RECORD — Weight, Space and Cabinet. How a record sounds whenever it is
 *   playing, sober or not. Judged in a quiet clearing with music on, and every
 *   answer is about bass, fidelity and where the cabinets are.
 *
 *   THE TRIP — the four `Trip ·` groups. What is done to that sound at full
 *   intensity, and nothing else. Judged standing at ego death, and every answer
 *   is about how far the wood goes away and what arrives in its place.
 *
 * One combined list would need six times as many entries to cover the same
 * ground, because every heavy-bass answer would have to be written out again
 * against every trip answer. Two banks compose instead: pick `heavy` and
 * `microscope`, and what you are listening to is that pair. It also means
 * clicking through the trip presets cannot quietly move the bass under you,
 * which is the thing that makes an A/B worthless.
 *
 *
 * A PRESET SETS EVERY KNOB IN ITS BANK, INCLUDING THE ONES IT DOES NOT NAME.
 *
 * Anything left out of `values` is taken from `DEFAULTS`, not from wherever the
 * previous preset happened to leave it. This is the property the whole feature
 * rests on: two clicks in a row must be a comparison of two presets and not a
 * comparison of one preset with the sediment of the other. It is also why the
 * entries below are written as differences from the shipping sound — the short
 * ones are short because they genuinely change three things.
 *
 * Nothing here is persisted, for the reason the header of `tuning.js` gives:
 * reload and you are back on the shipping sound. Export is what leaves the
 * browser, and it names the presets it was taken under.
 */

/**
 * The banks, defined by which `KNOBS` groups they own.
 *
 * By group rather than by a list of ids, so a knob added to `tuning.js` lands in
 * a bank automatically and gets set by every preset in it. A knob in a group no
 * bank claims would silently never be set by any preset — see `UNBANKED`, which
 * is why that cannot happen quietly.
 */
export const BANKS = [
  {
    id: 'record',
    label: 'Record',
    groups: ['Weight', 'Space', 'Cabinet'],
    note: 'How music sounds whenever it plays, sober or not. Judge in the clearing with a record on. Its two cabinet knobs need a pasted link — U at a speaker.',
  },
  {
    id: 'trip',
    label: 'Trip',
    groups: ['Trip · world', 'Trip · cabinet', 'Trip · layers', 'Trip · detail'],
    note: 'What the trip does to it AT FULL INTENSITY. Judge at ego death, paused, where the numbers mean what they say. Its five cabinet knobs need a pasted link.',
  },
];

/**
 * The knobs that only touch a PASTED LINK.
 *
 * Both cabinet groups live in `external-track.js`, which handles a streamed
 * track and nothing else — the synthesised jukebox never goes through them. So
 * with no link playing these seven are provably inaudible, and the search holds
 * them still rather than spending candidates on them. Named here because it is
 * the same fact the bank notes above carry, and two copies of it would drift.
 */
export const LINK_ONLY = KNOBS.filter((k) => k.group === 'Cabinet' || k.group === 'Trip · cabinet').map(
  (k) => k.id
);

/** Which knob ids a bank owns, in schema order. */
export function keysIn(bankId) {
  const bank = BANKS.find((b) => b.id === bankId);
  if (!bank) return [];
  return KNOBS.filter((k) => bank.groups.includes(k.group)).map((k) => k.id);
}

/**
 * Knobs no bank claims.
 *
 * Empty, and a check script asserts it. A group renamed in `tuning.js` or a new
 * one added without a line above would otherwise leave those knobs untouched by
 * every preset — which looks exactly like a preset that does not work, from the
 * one place where you are least able to tell the difference.
 */
export const UNBANKED = KNOBS.filter((k) => !BANKS.some((b) => b.groups.includes(k.group))).map(
  (k) => k.id
);

/* -------------------------------------------------------------------------- */
/* the record                                                                  */
/* -------------------------------------------------------------------------- */

const RECORD = [
  {
    id: 'shipping',
    label: 'shipping',
    note: 'The values in the source. Everything else on this row is a difference from it, and it is the one to come back to before deciding anything is an improvement.',
    values: {},
  },
  {
    id: 'flat',
    label: 'flat',
    note: 'Nothing added: no shelf, no sub, no overtones, no tail, and no HRTF. The reference — what a record sounds like before this project touches it, and the highest fidelity available here. The cabinets stop having a position, which is the price.',
    values: { lowMax: 0, subMax: 0, harmMax: 0, hallMax: 0, dryMix: 1, wetMix: 0 },
  },
  {
    id: 'heavy',
    label: 'heavy',
    note: 'A big room with big speakers in it. The most limiter-expensive setting here — bass sets the peak, so if this starts pumping take the sub down before anything else.',
    values: {
      lowMax: 3.2,
      subMax: 0.65,
      harmMax: 1.8,
      harmDrive: 2,
      bassCeiling: 2.1,
      harmCeiling: 3.4,
      lowCorner: 165,
      hallMax: 0.8,
    },
  },
  {
    id: 'laptop',
    label: 'small speakers',
    note: 'Weight built out of overtones instead of the fundamental, for anything with no bottom octave — the apparent bass survives a speaker that cannot reproduce 40 Hz. On a big system this reads as honk rather than as weight.',
    values: {
      lowMax: 1.1,
      subMax: 0.05,
      harmMax: 2.8,
      harmDrive: 2.2,
      harmLow: 95,
      harmHigh: 430,
      harmCeiling: 3.6,
      lowCorner: 140,
    },
  },
  {
    id: 'clean',
    label: 'clean',
    note: 'Fidelity first: barely any processing, a short tail high up, and the HRTF path at half — which hands back both the top end it costs and about three decibels of headroom, since dry and wet are the same recording twice. The answer to "the pasted link sounds compressed".',
    values: {
      lowMax: 1.3,
      subMax: 0.1,
      harmMax: 0.55,
      harmDrive: 1.3,
      hallMax: 0.35,
      hallLow: 3000,
      dryMix: 1,
      wetMix: 0.45,
    },
  },
  {
    id: 'clearing',
    label: 'the clearing',
    note: 'The record belongs to the wood rather than to you: full HRTF, a long tail from 2.2 kHz up, the bass left roughly alone. Costs the top end — that is the trade the head-related path always makes, and the reason `clean` exists.',
    values: { dryMix: 0.8, wetMix: 1, hallMax: 1.7, hallLow: 2200, lowMax: 2.2, subMax: 0.3 },
  },
];

/* -------------------------------------------------------------------------- */
/* the trip                                                                    */
/* -------------------------------------------------------------------------- */

const TRIP = [
  {
    id: 'shipping',
    label: 'shipping',
    note: 'The values in the source.',
    values: {},
  },
  {
    id: 'none',
    label: 'none',
    note: 'The trip stops touching the sound at all: no duck, no carve, nothing head-locked, no layers, no detail. THE REFERENCE. Pause at ego death, listen, switch to any other preset without moving your feet, and the difference is exactly what the trip is worth.',
    values: {
      worldDuck: 0,
      worldFar: 20000,
      worldCarve: 0,
      worldWet: 1,
      headLock: 0,
      headWet: 1,
      headDry: 1,
      headNear: 0,
      droneMax: 0,
      breathMax: 0,
      sparkMax: 0,
      voiceMax: 0,
      pulseMax: 0,
      scopeMax: 0,
      murmurMusic: 0,
      shimmerMax: 0,
    },
  },
  {
    id: 'inside',
    label: 'in your head',
    note: 'The record detaches from the cabinets completely and the wood shuts down around it — near-total duck, low-passed to 800 Hz, HRTF almost gone so the top end comes back. The strongest version of the thing the shipping values are a cautious take on.',
    values: {
      worldDuck: 0.8,
      worldFar: 800,
      worldCarve: 8,
      worldCarveAt: 1150,
      worldWet: 2.1,
      headLock: 1,
      headWidth: 0.8,
      headWet: 0.05,
      headDry: 1.5,
      headNear: 1,
      droneMax: 0.3,
      breathMax: 0.07,
      sparkMax: 0.06,
      voiceMax: 0.55,
      pulseMax: 0.3,
      scopeMax: 0.7,
      murmurMusic: 0.4,
      shimmerMax: 0.35,
    },
  },
  {
    id: 'recedes',
    label: 'wood recedes',
    note: 'The other way round: everything except the record goes far away, and the record stays in the clearing where you left it. Keeps the one navigational aid this forest has — you can still walk toward the bass line — which `in your head` deletes.',
    values: {
      worldDuck: 0.85,
      worldFar: 650,
      worldCarve: 10,
      worldCarveAt: 1050,
      worldWet: 2.4,
      headLock: 0.25,
      headWet: 0.55,
      headDry: 1.1,
      headNear: 0.2,
      droneMax: 0.35,
      breathMax: 0.08,
      sparkMax: 0.06,
      voiceMax: 0.7,
      pulseMax: 0.28,
      scopeMax: 0.5,
      murmurMusic: 0.3,
      shimmerMax: 0.25,
    },
  },
  {
    id: 'choir',
    label: 'choir',
    note: 'The layers the trip adds are the event, rather than a treatment of the record. Every one of them was set by ear against a QUIET wood — a bird, a stick, a footstep — where a mastered record buries them by twenty-odd decibels. This is what they are worth with room made for them.',
    values: {
      worldDuck: 0.6,
      worldCarve: 6,
      worldWet: 1.9,
      headWet: 0.12,
      headDry: 1.35,
      droneMax: 0.75,
      breathMax: 0.16,
      sparkMax: 0.14,
      voiceMax: 1.4,
      pulseMax: 0.55,
      murmurMusic: 0.7,
      scopeMax: 0.5,
      shimmerMax: 0.3,
    },
  },
  {
    id: 'microscope',
    label: 'microscope',
    note: '"There is more in this record than I noticed." All three sources of new detail at once — the four swimming bands, the record growing voices, and the high taps — with the HRTF path out of the way so the top end survives to be examined.',
    values: {
      worldDuck: 0.7,
      worldCarve: 7,
      worldWet: 1.8,
      headWet: 0.05,
      headDry: 1.45,
      headNear: 0.8,
      droneMax: 0.2,
      breathMax: 0.05,
      sparkMax: 0.04,
      voiceMax: 0.35,
      pulseMax: 0.22,
      scopeMax: 1.3,
      scopeRate: 0.085,
      murmurMusic: 0.75,
      shimmerMax: 0.75,
      shimmerTime: 135,
    },
  },
  {
    id: 'gentle',
    label: 'gentle',
    note: 'About half of the shipping sound, everywhere. For a long session, and for the question the peak is worst at answering from the inside: is the shipping value simply too much?',
    values: {
      worldDuck: 0.3,
      worldFar: 4000,
      worldCarve: 2.5,
      worldWet: 1.3,
      headLock: 0.5,
      headWet: 0.5,
      headDry: 1.1,
      headNear: 0.35,
      droneMax: 0.16,
      breathMax: 0.035,
      sparkMax: 0.03,
      voiceMax: 0.3,
      pulseMax: 0.14,
      scopeMax: 0.3,
      scopeRate: 0.045,
      murmurMusic: 0.18,
      shimmerMax: 0.16,
    },
  },
  {
    id: 'toomuch',
    label: 'too much',
    note: 'Over the edge on purpose. The fastest way to find where a setting stops working is to go past it once, and every number here is near the top of its slider. Expect the limiter to pump, the wood to have no location at all, and the resonators to whistle on anything tonal.',
    values: {
      worldDuck: 1,
      worldFar: 400,
      worldCarve: 14,
      worldWet: 2.8,
      headLock: 1,
      headWidth: 1,
      headWet: 0,
      headDry: 2.2,
      headNear: 1,
      droneMax: 1.1,
      breathMax: 0.3,
      sparkMax: 0.25,
      voiceMax: 2,
      pulseMax: 0.8,
      scopeMax: 1.7,
      scopeRate: 0.14,
      murmurMusic: 1.2,
      shimmerMax: 1.2,
      shimmerTime: 60,
    },
  },
];

/** bank id -> its presets, in the order they are drawn. */
export const PRESETS = { record: RECORD, trip: TRIP };

export function presetsIn(bankId) {
  return PRESETS[bankId] ?? [];
}

export function find(bankId, presetId) {
  return presetsIn(bankId).find((p) => p.id === presetId) ?? null;
}

/**
 * Every value a preset stands for, including the ones it does not name.
 *
 * The whole bank, always — see the block at the top of this file. Exported
 * because both `apply` and `active` need it and they must agree to the last
 * digit, or a preset would set a state it then failed to recognise as its own.
 */
export function valuesOf(bankId, presetId) {
  const preset = find(bankId, presetId);
  if (!preset) return null;
  const out = {};
  for (const id of keysIn(bankId)) {
    // Through the SAME clamp `tuning.set` applies, so `apply` and `active` can
    // never disagree. A preset value typed past the end of its slider would
    // otherwise be stored clamped and looked up raw, and the preset would light
    // up nowhere — a button that works and reports that it did not.
    const knob = KNOBS.find((k) => k.id === id);
    const v = preset.values[id] ?? DEFAULTS[id];
    out[id] = knob ? Math.min(knob.max, Math.max(knob.min, v)) : v;
  }
  return out;
}

/** Apply one. Returns how many knobs it wrote, or 0 for a name that is not one. */
export function apply(bankId, presetId) {
  const values = valuesOf(bankId, presetId);
  return values ? setMany(values) : 0;
}

/**
 * Which preset a bank is sitting on, or null if the knobs are somewhere between.
 *
 * Compared against the live values rather than remembered from the last click,
 * for the reason the debug panel's header gives about owning state: the sliders,
 * the console and `RR.tuning.load` can all move these, and a remembered name
 * would keep claiming `heavy` while somebody dragged the shelf across the room.
 * Null is the honest answer to "which of these am I on" after one slider moves.
 */
export function active(bankId) {
  for (const preset of presetsIn(bankId)) {
    const values = valuesOf(bankId, preset.id);
    if (Object.entries(values).every(([id, v]) => TUNING[id] === v)) return preset.id;
  }
  return null;
}

/** `record:heavy trip:edited`, for an export header and a bug report. */
export function describe() {
  return BANKS.map((b) => `${b.id}:${active(b.id) ?? 'edited'}`).join(' ');
}

/** Both banks at once, as the object the export carries. */
export function activeIds() {
  return Object.fromEntries(BANKS.map((b) => [b.id, active(b.id)]));
}

/* -------------------------------------------------------------------------- */
/* the search                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * VARIATIONS ON WHAT YOU ALREADY HAVE, because fourteen presets cannot cover
 * this and a hundred and forty would be worse.
 *
 * A bank is a thirteen- or twenty-dimensional space and the presets are fourteen
 * points in it, chosen because each one answers a question somebody actually
 * asked. What they cannot do is find the place BETWEEN two of them that is
 * better than either — and that place is where every one of these numbers
 * originally came from, arrived at by moving one knob at a time over about four
 * minutes a round.
 *
 * So: take where you are, make five neighbours, listen, keep the one you like,
 * and make five neighbours of THAT. Each round the neighbourhood gets smaller,
 * so the first few rounds are about which direction and the last few are about
 * how far. It is the same thing a person does with a slider, done with an ear
 * instead of an eye, and without having to guess which of twenty knobs to touch.
 *
 * THREE CHOICES MAKE THIS WORK RATHER THAN BEING A RANDOM NUMBER GENERATOR:
 *
 *   FEW KNOBS PER CANDIDATE. Perturbing all twenty gives five candidates that
 *   are all "different" and none of which you can attribute — you would be
 *   choosing between five strangers. Each one here moves a handful, so it has a
 *   character you can name, and the name is on the button.
 *
 *   THE STEP GRID. Every value is snapped to the knob's own step, so what you
 *   end up with is a number a person could have dialled and the export is
 *   legible. A tuning full of 0.30000000000000004 is a tuning nobody will paste
 *   into the source.
 *
 *   NOTHING INAUDIBLE MOVES. `hold` takes the knobs that cannot be heard right
 *   now — the cabinet pair with no pasted link playing — and leaves them where
 *   they are. Spending one of five candidates on a change you provably cannot
 *   hear is worse than spending it on a bad one, because a bad one at least
 *   tells you something.
 */

/** The knob's own step grid, and the float error taken back off. */
function quantise(knob, v) {
  const clamped = Math.min(knob.max, Math.max(knob.min, v));
  const step = knob.step || 0.01;
  const snapped = Math.round(clamped / step) * step;
  const dp = String(step).includes('.') ? String(step).split('.')[1].length : 0;
  return Number(Math.min(knob.max, Math.max(knob.min, snapped)).toFixed(dp));
}

/** How many knobs one candidate moves. Wide searches move more of them. */
function mutationCount(spread, available) {
  return Math.max(1, Math.min(available, Math.round(1.5 + spread * 12)));
}

/**
 * `count` neighbours of `center`, as `{ values, changes, label }`.
 *
 * Deterministic in `seed`: the same round re-rendered is the same five sounds,
 * which matters because the panel re-reads its rows four times a second and a
 * candidate that quietly became a different candidate between two listens would
 * make the whole exercise a lie.
 */
export function variations(bankId, { center = null, spread = 0.25, count = 5, seed = 'a', hold = [] } = {}) {
  const ids = keysIn(bankId);
  if (!ids.length) return [];
  const base = center ?? Object.fromEntries(ids.map((id) => [id, TUNING[id]]));
  const held = new Set(hold);
  const movable = ids.filter((id) => !held.has(id));
  const out = [];

  for (let i = 0; i < count; i++) {
    const rng = makeRng(`${bankId}:${seed}:${i}`);
    const values = { ...base };
    const changes = [];
    // Shuffled rather than sampled with replacement, so a candidate that is
    // meant to move four knobs moves four and not two of them twice. Fisher-
    // Yates rather than `sort(() => rng() - 0.5)`, which is not a valid
    // comparator and skews hard toward leaving the first elements where they
    // are — here that would mean the same two or three knobs being the ones
    // that move, round after round, in a tool whose whole job is to try
    // directions you would not have thought of.
    const pool = [...movable];
    for (let j = pool.length - 1; j > 0; j--) {
      const k = Math.floor(rng() * (j + 1));
      [pool[j], pool[k]] = [pool[k], pool[j]];
    }
    for (const id of pool.slice(0, mutationCount(spread, movable.length))) {
      const knob = KNOBS.find((k) => k.id === id);
      if (!knob) continue;
      const range = knob.max - knob.min;
      const from = base[id];
      let to = quantise(knob, from + (rng() * 2 - 1) * spread * range);
      // A candidate that landed back on the value it started from is a wasted
      // button. Push it off by one step, in whichever direction there is room.
      if (to === from) {
        to = quantise(knob, from + (from + knob.step <= knob.max ? knob.step : -knob.step));
      }
      if (to === from) continue;
      values[id] = to;
      changes.push({ id, label: knob.label, from, to, size: Math.abs(to - from) / range });
    }
    changes.sort((a, b) => b.size - a.size);
    out.push({ values, changes, label: '' });
  }
  return nameAll(out);
}

/**
 * Give each candidate a headline no other candidate in the round is using.
 *
 * Two buttons both reading "record voices ↓" is a row you cannot choose from —
 * they are different sounds and the panel is claiming they are the same one. So
 * a candidate whose biggest change is already spoken for takes its SECOND
 * biggest instead, and so on down its own list. The headline stops being "the
 * largest thing that moved" and becomes "a true thing about this one that
 * distinguishes it", which is what the row is actually for; the full diff is on
 * the tooltip either way.
 */
function nameAll(candidates) {
  const taken = new Set();
  for (const candidate of candidates) {
    const pick = candidate.changes.find((c) => !taken.has(c.id)) ?? candidate.changes[0];
    if (pick) taken.add(pick.id);
    candidate.label = labelFor(candidate.changes, pick);
  }
  return candidates;
}

/**
 * What to write on the button.
 *
 * One named change with its size as arrows, and a count of the rest — because
 * the question you are answering while clicking is "which of these do I want to
 * hear next", and "shelf ↑↑ +3" answers it where "candidate 3" does not. Which
 * change gets named is decided by `nameAll`; by default it is the biggest.
 */
function labelFor(changes, pick = changes[0]) {
  if (!changes.length || !pick) return 'unchanged';
  const arrow = pick.to > pick.from ? '↑' : '↓';
  const more = changes.length > 1 ? ` +${changes.length - 1}` : '';
  return `${pick.label} ${pick.size > 0.12 ? arrow + arrow : arrow}${more}`;
}

/** The full diff of a candidate, for its tooltip. */
export function describeChanges(changes) {
  if (!changes?.length) return 'nothing moved';
  return changes.map((c) => `${c.label} ${c.from} → ${c.to}`).join(' · ');
}

/** A bank's live values, as the centre of a new search. */
export function snapshotOf(bankId) {
  return Object.fromEntries(keysIn(bankId).map((id) => [id, TUNING[id]]));
}

/** Which knobs a set of values has moved away from the shipping sound. */
export function movedFrom(bankId, values) {
  return keysIn(bankId).filter((id) => values[id] !== DEFAULTS[id]);
}

/**
 * The list, printed. `RR.presets.log()` from the console.
 *
 * The panel's buttons carry these same notes as tooltips, which is the right
 * place for them while you are clicking — and the wrong place for reading all
 * fourteen of them before deciding where to start.
 */
export function log() {
  for (const bank of BANKS) {
    const on = active(bank.id);
    console.log(`%c${bank.label}%c  ${bank.note}`, 'font-weight:bold', 'color:#888');
    for (const p of presetsIn(bank.id)) {
      const named = Object.keys(p.values).length;
      console.log(
        `  ${p.id === on ? '●' : '○'} ${p.label.padEnd(16)} ${named ? `${named} knobs` : 'the defaults'}\n     ${p.note}`
      );
    }
    if (!on) console.log('  ● (edited — the knobs are not on any of these)');
  }
  console.log('RR.presets.apply("trip", "microscope") · RR.tuning.reset() · export from the panel');
}
