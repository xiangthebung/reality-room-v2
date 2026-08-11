import { clamp, clamp01, makeRng, rngRange } from '../core/util.js';
import { dawnAt } from '../world/daylight.js';

/**
 * The sound of things that are alive.
 *
 * `ambience.js` already owns the wind, the stream and your feet. This owns the
 * animals: song, alarm, wingbeats, hooves, a woodpecker, an owl, and the rise of
 * insects when the light goes.
 *
 * THE HARD CONSTRAINT, AND WHY BIRDSONG IS THE PLACE IT NEARLY BREAKS.
 *
 * There is no sawtooth in this project and no resonant filter, because a
 * detuned saw behind a ringing filter is the recipe for the buzz that got the
 * previous version's audio rejected. Birdsong is the one thing in a forest that
 * genuinely tempts you back toward it — the obvious way to make a warble is a
 * fast LFO on a filter cutoff, which is a resonant sweep, which is a buzz with a
 * bird-shaped envelope on it.
 *
 * The right answer is that a bird is not a filtered oscillator, it is a whistle
 * with almost no harmonics at all. A syrinx produces something extremely close
 * to a pure tone that MOVES — and what makes one species distinguishable from
 * another is the shape of that movement and its rhythm, not its timbre. So:
 *
 *   - the voice is one sine carrier, FM'd by another sine at a low index. At
 *     the end of every envelope the modulation index is zero, so the last thing
 *     you hear is literally a sine wave. It cannot buzz; there is nothing in it
 *     to buzz with.
 *   - the character is in the PITCH CONTOUR. A chaffinch is an accelerating
 *     descending cascade with a flourish on the end; a great tit is a two-note
 *     couplet repeated four times at a metronomic 3 Hz; a wren is fifty notes in
 *     two seconds. Play those contours on the same sine and they are instantly
 *     different birds. Play a beautiful timbre on a flat contour and it is a
 *     synthesiser.
 *   - percussive things — a woodpecker's drum, a twig snapping, wingbeats, a
 *     hoof — are pink noise through WIDE band-passes. Pink noise through a wide
 *     band-pass is a brush; white noise through a narrow one is a whistle, and a
 *     regular train of whistles is a pitch, which is the buzz an octave up.
 *
 * CALL AND ANSWER IS THE CHEAPEST BIG IDEA IN THE FILE. One bird sings; a second
 * of the same species answers from a different bearing a second and a half
 * later, quieter, dulled and usually transposed. It costs one scheduled event
 * and it is the difference between "there is a bird sound effect" and "there are
 * birds in this wood, and they are talking to each other".
 *
 * WHAT WAS ADDED AFTERWARDS, AND WHY IT IS MOSTLY NOT MORE SPECIES.
 *
 * The table below went from six voices to twelve, which is the obvious half of
 * it and the smaller half. Six species firing at one call every six seconds is
 * already enough variety that you cannot predict the next call; what was
 * actually missing was everything ABOUT a call other than which bird made it.
 * So the four things that came with the new rows matter more than the rows:
 *
 *   WHO IS AWAKE. Every voice carries the window of `dark` it sings in and how
 *   far it throws. The chorus picks by weight rather than uniformly, so as a
 *   trip closes the canopy over you the goldcrests and the chiffchaffs drop out
 *   and the blackbirds, robins and — eventually — a nightingale and an owl take
 *   over. Nothing is switched on or off; the roster leans. It is the single
 *   biggest thing in this file per line of code and it costs one weighted pick
 *   every several seconds.
 *
 *   WAVES. A real wood does not produce one call every six seconds, it produces
 *   four calls in eight seconds and then forty seconds of wind. Two slow sines
 *   at incommensurate periods drive the interval, and a fired call has a one in
 *   three chance of pulling a second, different bird in behind it. Same mean
 *   rate, completely different feeling — the lulls are what make the calls land.
 *
 *   GOING QUIET. Frighten something within a few metres and the chorus stops
 *   for four or five seconds, then ONE bird starts again. This is free — the
 *   flush and the bolt already know how near they were — and it buys more
 *   apparent intelligence than any amount of extra synthesis, because the
 *   silence is unmistakably about you.
 *
 *   DISTANCE HAS A THIRD CUE. Level and brightness were already handled by the
 *   engine's spatial source. The missing one is that a far sound is WETTER: the
 *   direct path falls off with distance and the scattered path does not. See
 *   `_buildFarTail`.
 *
 * The non-bird voices follow the same rule as the birds — nothing rings. A crow
 * and a barking deer are noise bursts through two static wide band-passes whose
 * envelopes cross-fade, which is a formant moving without a single filter
 * parameter ever being automated; a squirrel's scold is a train of 2 kHz ticks;
 * an acorn coming down is four ticks and a knock with the panner falling.
 *
 * WHICH BUS, AND WHERE THE LINE IS.
 *
 * `engine.js` describes `worldBus` as the continuous properties of the place
 * and `sfxBus` as discrete events, and the split here follows one test: WOULD A
 * PLAYER TURNING THIS DOWN BE TRYING TO QUIETEN THE WOOD, OR TO STOP BEING
 * INTERRUPTED?
 *
 *   worldBus — song, the distant chorus, the crow, the owl, the crickets. These
 *   are voices carrying from somewhere else, they are not addressed to you, and
 *   they are what "the sound of the wood" means. A crow is on this side despite
 *   being the least melodic thing in the file, because it is a bird calling at
 *   a distance on the chorus's own schedule, not an impact.
 *
 *   sfxBus — the flush, the bolt, hooves, the deer bark, the squirrel's scold,
 *   the woodpecker's drum, the acorn, the fly. Every one of these is either a
 *   physical impact or a direct reaction to where you are standing, and every
 *   one of them is something a player might reasonably want to keep while
 *   turning the ambience down, or lose while keeping it.
 *
 * The two startle voices are the interesting case and they went to sfx on
 * purpose: a squirrel swearing at you because you walked past is an event about
 * you in a way that the same animal's idle chatter would not have been.
 *
 * AND WHAT THE THIRD PASS ADDED, WHICH IS AGAIN MOSTLY NOT MORE SPECIES.
 *
 * Twelve rows became sixteen and that is the least interesting sentence here.
 * The complaint this pass answers is not "there are not enough birds", it is
 * IT IS THE SAME BIRD EVERY TIME: twelve rows played literally note for note,
 * forever, so the fourth chaffinch of a walk was bit-identical to the first and
 * the wood collapsed back into a sample library somewhere around ninety
 * seconds. Three things fixed that and not one of them is a row.
 *
 *   INDIVIDUALS. A bird is now a PLACE as well as a species. `_individual`
 *   hashes the quantised position together with the voice index, so the
 *   chaffinch in that oak is always a shade flat and always slightly hurried,
 *   and it still is when you walk back ten minutes later — while the one
 *   answering from behind you is unmistakably a different individual of the
 *   same species. Nothing is stored anywhere: the hash IS the memory, and it
 *   costs four multiplies per phrase.
 *
 *   RENDITIONS. On top of that fixed identity, no bird sings the same phrase
 *   twice. The key moves a little, the tempo moves a little, the notes are
 *   fractionally out of tune with each other, a long cyclic song drops the odd
 *   note — and, the one that carries most of it, the PHRASE LENGTH changes.
 *   `tail` says how many notes at the end are the ending, so a shortened song
 *   loses notes out of the MIDDLE and never the flourish, which is how a real
 *   bird abbreviates. A phrase that has an ending is never extended either,
 *   because you cannot say the ending twice.
 *
 *   THE OTHER NINETY-FIVE PER CENT. A bird sings for a few minutes a day and
 *   makes noise for all of it. `call` is each row's contact note and every
 *   other utterance is derived from it: an alarm is that note a fifth up and
 *   hammered flat, a flight call is that note falling away as the bird goes
 *   over, a begging juvenile is that note an octave up, ten times, accelerating
 *   and never answered. One to three notes at a third of a song's level every
 *   few seconds. They cost almost nothing and they are most of what a wood
 *   actually sounds like — the set-piece songs are the exception, and the calls
 *   are what make room for them.
 *
 * THE DAWN CHORUS GOT A RUNNING ORDER. `_afford` and the distant chorus already
 * knew about `dawn`; what they did not have is that first light is not simply
 * more birds, it is DIFFERENT birds in a fixed sequence. `early` is how much a
 * species belongs to the half hour before sunrise, and it is observation rather
 * than mood: a robin and a blackbird are singing in the dark, the song thrush
 * and the wren come in around sunrise, and the warblers do not trouble
 * themselves until it is properly light. It multiplies into `_pick` scaled by
 * `dawn`, so it is exactly 1 at the pinned automation hour and moves nothing
 * any stored expectation ever measured.
 */

/**
 * The species.
 *
 * `notes` are semitone offsets from the voice's own root, `gaps` the seconds
 * between them; both are cycled if one runs out, which is what lets a wren be
 * fifty notes described by six numbers. `glide` is how far each note sweeps
 * during its own decay, in semitones — the single most important number in the
 * table, because a note that does not move is a beep.
 *
 * `index` is the FM modulation depth at the attack. Everything is under 2.2:
 * past about three an FM pair starts producing sidebands dense enough to read as
 * a rasp, and a rasp is the thing that must not be here.
 *
 * THE FOUR NUMBERS THAT SHAPE A PHRASE RATHER THAN A NOTE, all optional and all
 * defaulting to the value that means "do nothing". They exist because four of
 * the sixteen species cannot be described by a contour alone — what identifies
 * them is something that happens ACROSS the phrase — and because once they
 * exist every other row can use them for free.
 *
 * `fade` is the gain the last note reaches relative to the first, interpolated
 * geometrically. A willow warbler at 0.18 is a descending scale that dies away
 * to nothing, which is the entire bird; a blackcap at 2.6 is a crescendo, and
 * geometric interpolation is the right kind because it back-loads — half way
 * through a 2.6 the bird is only 1.6 up, so the opening still arrives.
 *
 * `pure` is the same idea applied to `index`: the modulation depth at the last
 * note relative to the first. A blackcap starts scratchy and ends fluted, which
 * is a change of TIMBRE across one phrase and the only one in the table. It is
 * safe in the direction that matters — every value here is below one, so the
 * sidebands only ever thin out.
 *
 * `hold` multiplies the decay of the FINAL note, and the glide of that note by
 * its square root so a long note also falls further. It is the yellowhammer,
 * and nothing else in the table ends on a held note at all.
 *
 * `tail` is how many notes at the end are the ENDING. See `_phrase`: a
 * shortened rendition drops notes out of the middle and keeps these, so a
 * chaffinch that runs out of enthusiasm still trips over its flourish. It also
 * doubles as the flag for whether a phrase may be run LONG, since a phrase with
 * an ending cannot be, and for whether a note may be dropped from it.
 *
 * `unit` is the size of the repeating group, for the rows that have one, and it
 * is the other half of making the length vary safely. A cuckoo is threes and
 * twos: `unit: 2` is why you never hear "cuck-oo, cuck-oo, cuck". A wood pigeon
 * is a single five-note idiom, so it is `unit: 5`, which is this field's way of
 * saying the phrase is not to be cut at all.
 *
 * `stream` is a length in SECONDS rather than a count of notes, and it is the
 * skylark and only the skylark. A row that has it is not a phrase, it is a
 * stretch of time full of notes, and it is scheduled a little at a time instead
 * of all at once. See STREAM_AHEAD and `_phrase`.
 *
 * THE FIVE FIELDS THAT ARE NOT ABOUT THE SOUND.
 *
 * `active` is the window of `dark` — 0 full daylight, 1 night — inside which
 * this one is singing, and it fades over 0.18 either side rather than switching,
 * so the roster leans instead of flipping. Almost everything starts at 0 because
 * almost every bird in a British wood sings in the morning; what distinguishes
 * them is how far into the evening they are still at it, which is exactly what
 * the upper bound says. The nightingale is the only one with a floor, and it is
 * the reason the floor exists at all.
 *
 * `carry` is how far the voice is worth hearing, in metres. It is not a volume —
 * it biases the chorus's choice by distance, so a call scheduled at 110 m is a
 * song thrush or a cuckoo and never a goldcrest. Without it a third of the
 * distant chorus was events spent on birds that are inaudible past forty metres,
 * which is not a quiet bird, it is a missing one.
 *
 * `rare` is the thumb on the scale. A cuckoo at 0.3 turns up about a third as
 * often as a chaffinch, because a cuckoo every thirty seconds stops being a
 * cuckoo within two minutes.
 *
 * `early` is the dawn running order, and it is the one field here that is pure
 * observation. A wood does not simply get louder at first light, it fills up in
 * a SEQUENCE: robin and blackbird half an hour before sunrise in what is still
 * the dark, song thrush and wren as it comes up, the tits and finches after
 * that, and the warblers not until it is properly light. So a robin is 2.5, a
 * blackcap 0.45, and the multiplier is scaled by `dawn` — which means it is
 * exactly 1 the rest of the day and the roster only reorders itself at the one
 * hour the reordering is a real thing.
 *
 * `call` is what the bird says when it is NOT singing, as semitone offsets from
 * the same root. It is one to three numbers and it is the second most
 * recognisable thing about most of these species — a robin's ticking, a
 * blackbird's low chook, a chaffinch's single hard "pink". `call` also seeds
 * the alarm, the flight call and the juvenile, which are the same note moved
 * and re-rhythmed; see `call()`.
 *
 * `size` is body length in centimetres and makes no sound at all. It is here
 * because something has to draw these birds and the only place the roster is
 * written down is this table — see `voiceInfo`.
 */
const VOICES = [
  {
    /**
     * A chaffinch. An accelerating descending run that trips over itself and
     * ends in a completely different flourish — instantly recognisable, and the
     * acceleration is what does it: the gaps shrink by a fifth each note.
     */
    name: 'chaffinch',
    root: 79,
    ratio: 1.0,
    index: 1.1,
    decay: 0.075,
    notes: [12, 12, 10, 10, 8, 8, 7, 5, 3, 14, 9],
    gaps: [0.115, 0.105, 0.098, 0.09, 0.084, 0.078, 0.073, 0.07, 0.15, 0.09],
    glide: -1.6,
    level: 1,
    active: [0, 0.5],
    carry: 95,
    rare: 1,
    // The last two notes ARE the chaffinch. Everything before them is a
    // descending run that four other species could have produced.
    tail: 2,
    early: 0.9,
    // "Pink." One hard note, and it is the sound a chaffinch makes for the
    // other twenty-three hours.
    call: [9],
    size: 15,
  },
  {
    /**
     * A great tit. Two notes, a fourth apart, repeated — "tea-cher, tea-cher".
     * Almost metronomic, which is unusual enough among birds to be a signature
     * all by itself.
     */
    name: 'greattit',
    root: 84,
    ratio: 2.01,
    index: 1.6,
    decay: 0.12,
    notes: [7, 0, 7, 0, 7, 0, 7, 0],
    gaps: [0.16, 0.2],
    glide: -0.5,
    level: 0.95,
    active: [0, 0.55],
    carry: 100,
    rare: 1,
    // 'Tea-cher' is the unit, not 'tea'.
    unit: 2,
    early: 1.1,
    // A thin high "tsee-tsee", nothing like the song. A great tit has the
    // largest vocabulary of any bird here and this is the least of it.
    call: [12, 12],
    size: 14,
  },
  {
    /**
     * A wren. Enormously loud for its size and essentially a machine gun: forty
     * notes in two seconds ending in a hard trill. The gaps are so short that
     * the ear stops hearing notes and starts hearing a texture, which is exactly
     * what a real one does to you at three metres.
     */
    name: 'wren',
    root: 88,
    ratio: 1.0,
    index: 0.8,
    decay: 0.035,
    notes: [0, 4, 0, 5, 0, 4, 2, 7, 2, 7, 2, 9, 5, 9, 5, 12, 7, 12, 7, 12],
    gaps: [0.052, 0.046, 0.058, 0.044],
    glide: 0.9,
    level: 0.8,
    // Still going long after everything else has packed up, which is why the
    // window runs so much further into the dark than its neighbours'.
    active: [0, 0.7],
    carry: 80,
    rare: 0.85,
    early: 1.3,
    // The scolding rattle. Three of them on one pitch, and a wren does this at
    // anything that moves.
    call: [0, 0, 0],
    size: 10,
  },
  {
    /**
     * A blackbird. Slow, low, fluted, wandering — the phrase never repeats and
     * always ends thinner and higher than it began. Long decays and wide
     * intervals; this is the one that sounds like music rather than like signal.
     */
    name: 'blackbird',
    root: 72,
    ratio: 1.0,
    index: 0.55,
    decay: 0.3,
    notes: [0, 7, 5, 9, 4, 12, 11, 16],
    gaps: [0.26, 0.21, 0.3, 0.24, 0.28, 0.16, 0.14],
    glide: 1.1,
    level: 1.05,
    // The last bird of the day and the loudest thing in a suburban dusk. It
    // gets the widest window and the longest carry of any of the six originals.
    active: [0, 0.95],
    carry: 130,
    rare: 1.1,
    // A blackbird phrase always ends thinner and higher, so the last two notes
    // are the ending in the same sense the chaffinch's flourish is.
    tail: 2,
    // First light and last light both belong to this bird. Second only to the
    // robin, and only because a robin will sing at three in the morning.
    early: 2.4,
    // The low "chook chook" it makes going to roost, which is the other half of
    // what a suburban dusk sounds like.
    call: [-2, -2, 0],
    size: 25,
  },
  {
    /**
     * A wood pigeon. Five notes, low, breathy, on a rhythm nobody can hear
     * without hearing the phrase "my TOE bleeds, Bet-ty". The near-zero
     * modulation index is the point: it is almost a pure sine, which is what
     * gives it the hooting, hollow quality.
     */
    name: 'pigeon',
    root: 60,
    ratio: 1.0,
    index: 0.18,
    decay: 0.34,
    notes: [0, 5, 5, 0, 0],
    gaps: [0.26, 0.42, 0.5, 0.36],
    glide: -0.4,
    level: 1.1,
    active: [0, 0.45],
    // Low and hooting, so it survives the distance low-pass better than
    // anything else here — a pigeon two hundred metres off is still a pigeon.
    carry: 140,
    rare: 0.9,
    // Five notes or none. There is no such thing as most of it.
    unit: 5,
    // The last bird in the wood to get up, and it does not care about dawn.
    early: 0.6,
    call: [0],
    size: 41,
  },
  {
    /**
     * A chiffchaff. Two pitches a tone apart in no particular order, over and
     * over, for as long as you can stand it. The least musical bird in the wood
     * and one of the most characteristic.
     */
    name: 'chiffchaff',
    root: 86,
    ratio: 1.0,
    index: 1.3,
    decay: 0.08,
    notes: [0, 2, 0, 0, 2, 0, 2, 2, 0],
    gaps: [0.19, 0.17, 0.21],
    glide: -0.8,
    level: 0.85,
    active: [0, 0.5],
    carry: 70,
    // Deliberately under one. It is the most repetitive phrase in the table and
    // the first one a listener starts to recognise as a loop.
    rare: 0.8,
    // A warbler, so it is nearly the last thing to join in. The dawn chorus is
    // half over before a chiffchaff says anything.
    early: 0.5,
    // "Hweet." A rising monosyllable, and the only way to tell a chiffchaff
    // from a willow warbler when neither of them is singing — which is to say,
    // no way at all, because they share it.
    call: [3],
    size: 11,
  },
  /* ---- the second six. Everything below here was added later. ---- */
  {
    /**
     * A robin. Thin, silvery and completely unpredictable: a run of high notes
     * that wanders, stops dead, and then trickles downward in an accelerating
     * scatter. The low modulation index is doing the work — a robin is the
     * purest whistle in the wood and it is what makes it sound like glass
     * rather than like a bird.
     *
     * The widest window in the table. A robin will sing under a streetlight at
     * two in the morning, which is why it is the voice that survives furthest
     * into a trip's darkness alongside the blackbird.
     */
    name: 'robin',
    root: 84,
    ratio: 1.0,
    index: 0.7,
    decay: 0.1,
    notes: [12, 7, 10, 5, 12, 14, 12, 9, 7, 5, 4, 2],
    gaps: [0.13, 0.1, 0.24, 0.12, 0.085, 0.075, 0.068, 0.062, 0.056, 0.052, 0.05],
    glide: -1.2,
    level: 0.85,
    active: [0, 1],
    carry: 70,
    rare: 1,
    // The highest `early` in the table, and it belongs to the smallest voice in
    // it. A robin is singing while it is still properly dark and the wood is
    // otherwise empty, which is the whole reason the dawn order is worth
    // modelling: for a few minutes there is exactly one species in it.
    early: 2.5,
    // The ticking. A robin follows you round a garden doing this and it is
    // considerably more familiar than the song.
    call: [7, 7, 7],
    size: 14,
  },
  {
    /**
     * A song thrush, which is the one species in this table you can identify
     * from a single structural rule: IT SAYS EVERYTHING TWICE, and usually
     * three times. Every motif repeats, then a beat of silence, then a
     * different motif repeats.
     *
     * That rule is encoded entirely in the gaps — the long value after each
     * triple is the whole species. It is also the only bird here whose phrase
     * has punctuation in it, which is why it reads as loud and deliberate next
     * to the chaffinch's tumble.
     */
    name: 'songthrush',
    root: 76,
    ratio: 1.0,
    index: 1.4,
    decay: 0.13,
    notes: [0, 0, 0, 7, 7, 7, 4, 4, 12, 12, 12],
    gaps: [0.17, 0.17, 0.44, 0.16, 0.16, 0.42, 0.2, 0.46, 0.14, 0.14],
    glide: -0.9,
    level: 1.1,
    active: [0, 0.85],
    // The loudest songbird in a European wood by a distance. This is the voice
    // the far end of the chorus is mostly made of.
    carry: 150,
    rare: 0.9,
    early: 2,
    // A hard "tchuck", usually as it flies off. Nothing like the song, which is
    // the point of a call.
    call: [12],
    size: 23,
  },
  {
    /**
     * A nuthatch. Six or seven identical loud piping whistles on one pitch, at
     * a steady five a second, each one falling slightly.
     *
     * It is here because it is the only voice in the table with NO melodic
     * information at all, and a wood needs one of those. Everything else is a
     * shape; this is a signal, and among eleven shapes a signal is instantly
     * the thing you notice.
     */
    name: 'nuthatch',
    root: 81,
    ratio: 1.0,
    index: 1.9,
    decay: 0.16,
    notes: [0, 0, 0, 0, 0, 0, 0],
    gaps: [0.2, 0.19, 0.21],
    glide: -1.4,
    level: 1,
    active: [0, 0.4],
    carry: 110,
    rare: 0.7,
    early: 1,
    // Two loud "twits", which is very nearly the song with the repeats taken
    // out — the one species here whose call and song are the same material.
    call: [0, 0],
    size: 14,
  },
  {
    /**
     * A goldcrest. Britain's smallest bird and very nearly its highest voice: a
     * cycling three-note figure up at four kilohertz, so thin that half the
     * people in a wood cannot hear it at all.
     *
     * The low level and the short carry are the point rather than a limitation.
     * This is the voice that only exists when you are close and everything else
     * has stopped, and hearing it is a reward for standing still.
     */
    name: 'goldcrest',
    root: 96,
    ratio: 1.0,
    index: 0.5,
    decay: 0.06,
    notes: [0, 4, 0, 0, 4, 0, 0, 4, 0, 7, 4, 0],
    gaps: [0.09, 0.085, 0.17],
    glide: 0.8,
    level: 0.5,
    active: [0, 0.35],
    carry: 45,
    rare: 0.55,
    // The little rising flourish it signs off with. Protecting it also stops
    // the cycling figure being run long, which would turn the smallest bird in
    // Britain into a loop pedal.
    tail: 3,
    unit: 3,
    early: 0.7,
    call: [0, 0, 0],
    size: 9,
  },
  {
    /**
     * A cuckoo. Two notes, a falling minor third, twice or three times with a
     * long gap between. Eight numbers, and it is probably the most instantly
     * recognisable sound in this entire project.
     *
     * Nearly zero modulation index, like the wood pigeon, for the same reason:
     * it is a hollow, hooting, almost pure tone and any brightness at the
     * attack turns it into a flute. `rare` is very low — a cuckoo is an event,
     * and an event that happens every half minute is a metronome.
     */
    name: 'cuckoo',
    root: 74,
    ratio: 1.0,
    index: 0.22,
    decay: 0.26,
    notes: [0, -3, 0, -3, 0, -3],
    gaps: [0.29, 0.66, 0.29, 0.66, 0.29],
    glide: -0.3,
    level: 1,
    active: [0, 0.55],
    // Two low pure tones carry absurdly far through trees, which is the entire
    // reason the bird sings them.
    carry: 200,
    rare: 0.3,
    // The falling third is the bird. Half of it is a wood pigeon with a cough.
    unit: 2,
    early: 1.2,
    call: [0],
    size: 33,
  },
  {
    /**
     * A nightingale, and the only voice in the table with a FLOOR on its
     * window — it does not appear until the light has properly gone, which
     * during play means somewhere past the middle of a trip.
     *
     * It earns that because of what it does structurally: four or five slow,
     * pure, widely spaced whistles that give no hint of where the phrase is
     * going, and then a hard accelerating tumble. Nothing else here has that
     * much silence inside a single phrase, so when it arrives in a wood that
     * has already gone quiet it does not sound like another bird being added.
     * It sounds like something starting.
     */
    name: 'nightingale',
    root: 79,
    ratio: 1.0,
    index: 0.6,
    decay: 0.22,
    notes: [0, 0, 0, 0, 12, 12, 12, 12, 7, 14, 12, 9, 5],
    gaps: [0.46, 0.44, 0.48, 0.62, 0.13, 0.12, 0.115, 0.3, 0.1, 0.09, 0.085, 0.08],
    glide: -0.7,
    level: 1.15,
    active: [0.22, 1],
    carry: 120,
    rare: 0.9,
    // The tumble. It is the reason the four slow whistles work, so it is the
    // half that can never be cut.
    tail: 5,
    unit: 4,
    // It has been at it all night and it stops when the others start.
    early: 0.4,
    // A low croak. Barely a note, and it is a shock coming from that bird.
    call: [-5],
    size: 16,
  },
  /* ---- the third pass. Four contours the wood did not have. ---- */
  {
    /**
     * A willow warbler, which is in the table for one reason: it is the
     * CHAFFINCH RUNNING BACKWARDS. Both are twelve notes falling most of an
     * octave, and after that they have nothing in common. A chaffinch speeds up
     * into a flourish and finishes louder than it started; a willow warbler
     * slows down, gets quieter and purer as it goes, and stops without ever
     * arriving anywhere. It is the sound of something giving up, and it is
     * unmistakable next to its own mirror image.
     *
     * `fade` at 0.18 is the bird. The last note is a fifth of the volume of the
     * first, and by then `pure` has taken the modulation index down to a third
     * of what it started at, so the phrase does not just fade — it thins, which
     * is what a dying fall actually is. Take those two numbers out and this row
     * is a descending scale, which is not a species.
     */
    name: 'willowwarbler',
    root: 83,
    ratio: 1.0,
    index: 0.75,
    decay: 0.11,
    notes: [12, 11, 9, 9, 7, 7, 5, 4, 4, 2, 0, 0],
    gaps: [0.12, 0.115, 0.13, 0.125, 0.14, 0.135, 0.15, 0.145, 0.16, 0.17, 0.19],
    glide: -0.6,
    fade: 0.18,
    pure: 0.35,
    level: 0.85,
    active: [0, 0.4],
    // A soft bird in the understorey. It does not throw, and a willow warbler
    // at eighty metres is a rumour.
    carry: 60,
    rare: 0.95,
    early: 0.5,
    call: [7],
    size: 11,
  },
  {
    /**
     * A skylark, and the only voice in the table that is about DURATION.
     *
     * Everything else here is a phrase — a shape with a beginning and an end,
     * two seconds long, and then silence you can hear. A skylark has no phrase
     * boundaries at all. It goes up, and it produces an unbroken stream of
     * notes for twenty seconds or a minute without a single gap you could point
     * at, and the effect of that on a wood full of two-second phrases is not
     * "another bird". It is one bird that will not stop, which is a completely
     * different experience and the reason the streaming machinery in `_phrase`
     * exists for this one row.
     *
     * NINETEEN NOTES AGAINST SEVEN GAPS, which is deliberate and is the whole
     * trick: the two cycles are coprime, so the melodic pattern does not come
     * round for a hundred and thirty-three notes — something over seven seconds
     * — and by then the per-note detune and the glide jitter have moved it
     * anyway. A skylark that loops is worse than no skylark.
     *
     * IT IS NOT A WOODLAND BIRD and it is not pretending to be. It sings from a
     * hundred feet up over open ground, so its `carry` is the second longest in
     * the table and its `active` window is the narrowest — it belongs to the
     * clearings and the field edge in full daylight, heard from inside the
     * trees, which is exactly where a walk in a wood does hear one.
     */
    name: 'skylark',
    root: 88,
    ratio: 1.0,
    index: 1.0,
    decay: 0.05,
    notes: [0, 4, 2, 7, 5, 9, 7, 12, 9, 5, 11, 7, 14, 10, 12, 5, 9, 2, 7],
    gaps: [0.05, 0.046, 0.058, 0.043, 0.052, 0.061, 0.047],
    glide: 0.7,
    // Seconds, not notes. Seven is already four times the longest phrase in the
    // table and twenty is a bird that is still going when you have walked out
    // from under it, which is the point of the row.
    stream: [7, 20],
    // Quiet per note, and there are three hundred of them. The sum is what you
    // hear and it is easily the loudest thing in the table if this is wrong.
    level: 0.55,
    active: [0, 0.3],
    carry: 170,
    // Low, and it has to be. A skylark is not an event that can happen twice in
    // a minute — it is an event that occupies a minute.
    rare: 0.35,
    early: 1.6,
    call: [0, 0, 0],
    size: 18,
  },
  {
    /**
     * A blackcap, which is the only voice here with a GEAR CHANGE in it.
     *
     * The first half is a scratchy, hurried, low mutter that goes nowhere —
     * small intervals, all within a tone or two of each other, quiet enough
     * that at forty metres you are not sure you heard it. Then it stops for a
     * quarter of a second and the same bird opens into six loud, wide, pure
     * fluted notes and finishes on a held one. Nothing else in this table
     * changes what kind of sound it is halfway through a phrase.
     *
     * THREE NUMBERS DO IT AND NONE OF THEM IS IN THE CONTOUR. `fade` at 2.6
     * crescendos into the flourish; `pure` at 0.22 takes the modulation index
     * from 1.7 down to 0.37, so the mutter is chiffy and the flourish is very
     * nearly a flute; and `hold` stretches the last note. The contour supplies
     * the pause — `gaps[9]` is the only long value in the row and it is the
     * hinge the whole thing turns on.
     *
     * `tail: 6` is not decoration. A blackcap that got truncated in the middle
     * of the mutter would be a bird making an unpleasant noise and stopping,
     * which is a fair description of the first half on its own.
     */
    name: 'blackcap',
    root: 78,
    ratio: 1.0,
    index: 1.7,
    decay: 0.09,
    notes: [0, 2, 1, 3, 0, 2, 4, 1, 3, 2, 12, 9, 14, 12, 16, 14],
    gaps: [
      0.075, 0.068, 0.082, 0.07, 0.078, 0.065, 0.085, 0.072, 0.08, 0.26, 0.17, 0.2, 0.155, 0.185,
      0.16, 0.19,
    ],
    glide: -0.9,
    fade: 2.6,
    pure: 0.22,
    hold: 2.2,
    // Held down against the crescendo. `fade` multiplies the last notes by
    // 2.6, so a level of 1 here would make the flourish the loudest thing in
    // the wood by a factor of two.
    level: 0.62,
    active: [0, 0.55],
    carry: 90,
    rare: 0.9,
    tail: 6,
    early: 0.45,
    // "Tak. Tak." Two hard stones knocked together, and completely unlike
    // either half of the song.
    call: [-3, -3],
    size: 14,
  },
  {
    /**
     * A yellowhammer: "a little bit of bread and no CHEEEEESE". Seven identical
     * fast notes and then, after the only real pause in the phrase, one long
     * drawn-out wheeze a fourth below that lasts as long as all seven together.
     *
     * IT IS THE ONLY THING HERE THAT ENDS ON A HELD NOTE. Sixteen species and
     * every one of them is built out of notes between forty and three hundred
     * milliseconds; this one finishes on a note of nearly seven tenths of a
     * second that sags a tone and a half while it goes. That is `hold: 9`, and
     * `hold` also takes the glide out by its square root, so the long note is
     * not merely long — it subsides. A held note that stays put would be an
     * organ, which is the failure mode this bird was worth risking.
     *
     * Like the skylark it is a field-edge bird rather than a woodland one, with
     * the short daylight window and the long carry that go with singing from an
     * exposed perch in the open. `tail: 1` is the cheese, and there is no
     * version of this species without it.
     */
    name: 'yellowhammer',
    root: 82,
    ratio: 1.0,
    index: 1.5,
    decay: 0.075,
    notes: [0, 0, 0, 0, 0, 0, 0, -5],
    gaps: [0.135, 0.128, 0.14, 0.13, 0.136, 0.125, 0.42],
    glide: -0.5,
    hold: 9,
    pure: 0.6,
    fade: 1.15,
    level: 0.8,
    active: [0, 0.35],
    carry: 120,
    rare: 0.5,
    tail: 1,
    early: 1.4,
    call: [3],
    size: 16,
  },
];

/**
 * How many species the table holds.
 *
 * Exported because `fauna.js` gives each percher a fixed voice index and had
 * the count written into it as a literal six, which quietly capped the birds
 * you can walk up to at the original roster while the distant chorus sang all
 * twelve. Anything picking a voice should pick from here.
 */
export const VOICE_COUNT = VOICES.length;

/**
 * The roster, by name, index-aligned with the voice index everything else uses.
 *
 * The species list lives in exactly one place and it lives here, because it is
 * defined by what the thing sounds like. Anything that wants to DRAW one of
 * these birds needs the same list and must not keep its own copy of it — a
 * second roster is a roster that goes out of date the next time a row is added,
 * silently, with a nuthatch wearing a wood pigeon.
 */
export const VOICE_NAMES = VOICES.map((v) => v.name);

/**
 * Everything about a voice that is not audio, for whatever is drawing it.
 *
 * A deliberately small, copied, frozen object rather than the row itself: the
 * row is mutable state this file schedules from, and handing it out would make
 * the bird table part of somebody else's API by accident. `size` is body length
 * in centimetres; `active` and `carry` are here because when and how far a bird
 * sings are also facts about where you would see it.
 */
export function voiceInfo(index) {
  const v = VOICES[((index % VOICES.length) + VOICES.length) % VOICES.length];
  return Object.freeze({
    index: VOICES.indexOf(v),
    name: v.name,
    size: v.size,
    /** Rough pitch of the voice in MIDI — a proxy for how small the bird is. */
    root: v.root,
    active: [v.active[0], v.active[1]],
    carry: v.carry,
  });
}

const midiToFreq = (midi) => 440 * 2 ** ((midi - 69) / 12);

/**
 * The most nodes the wildlife may have alive at once.
 *
 * Sized against the worst real case: walking into a thicket flushes three or
 * four perchers within a second, and a flush is about thirty nodes. Sixty
 * leaves room for that plus a song and a set of hooves, and it is far below the
 * point where creating them costs a frame.
 */
const VOICE_CEILING = 58;

/**
 * The chorus wave: two sines with no common period.
 *
 * A wood is not a Poisson process. It goes through minutes where four birds are
 * answering each other and minutes where there is nothing but wind, and the ear
 * notices that structure far more than it notices the average. Two periods that
 * do not divide into each other never repeat the same combined shape, so there
 * is no pattern to learn; 97 and 233 seconds put a broad peak every couple of
 * minutes with an occasional deep one.
 *
 * This is a MULTIPLIER ON THE INTERVAL, not on the volume — the point is that
 * the quiet parts contain nothing rather than quiet somethings. A trough runs
 * about forty seconds with maybe one call in it, which is long enough to start
 * hearing the trees again.
 */
const WAVE_FAST = (Math.PI * 2) / 97;
const WAVE_SLOW = (Math.PI * 2) / 233;

/**
 * The scattered path, for the distance model.
 *
 * Four taps, no feedback, dark. See `_buildFarTail` — the spacings are chosen
 * not to share factors so that four of them do not stack into a comb, and they
 * are all short because this is not a room, it is the first hundred metres of
 * trunks between you and a bird.
 */
const FAR_TAPS = [0.037, 0.059, 0.089, 0.131];
const FAR_LEVELS = [0.5, 0.36, 0.25, 0.17];

/**
 * HOW MUCH SONG THE WOOD WILL ACCEPT FROM THE BIRDS YOU CAN SEE.
 *
 * This is the single most important number added in this pass and it is here
 * because of a measurement, not a taste. Instrumenting `engine.createSpatial`
 * in the running app — the only way to see it, since fauna.js keeps its
 * Wildlife in a closure — showed SEVENTY-TWO located bird phrases a minute
 * while standing still. One every eight hundred milliseconds. That is a dawn
 * chorus, in a world whose sun is fixed at mid-morning, and no amount of new
 * species improves it; twelve voices at that rate is a busier wall of birds
 * than six was.
 *
 * Nearly all of it comes from the perchers. `fauna.js` gives each of its
 * twenty-six a sing timer of five to twenty-six seconds and calls `song` when
 * it expires, so demand is about a hundred songs a minute of which everything
 * within earshot plays. That file is not ours to change, and even if it were,
 * a rate that lives in the caller cannot be balanced against the rate that
 * lives here.
 *
 * THE "PERMANENT MID-MORNING" IN THAT PARAGRAPH IS NO LONGER TRUE, AND THE
 * NUMBER SURVIVED IT. There is a clock now (`world/daylight.js`), so the wood
 * has a dawn and a dusk and a night — but the measurement that set this was
 * seventy-two located phrases a minute against a demand of about a hundred, and
 * neither of those figures came from the hour. They came from `fauna.js` giving
 * twenty-six perchers a five-to-twenty-six-second sing timer, which is the same
 * whatever the sky is doing. What the clock changed is that the bucket is now
 * ALLOWED to fill faster at dawn (see `_afford`), which is the one time of day
 * a wall of birds is the correct answer.
 *
 * So the limit lives where the sound does. A leaky bucket: songs cost a token,
 * tokens refill at `SONG_REFILL` a second, and the bucket holds five. The
 * capacity is deliberate rather than incidental — a sudden burst of four or
 * five birds all going at once still gets through, which is a real thing that
 * happens when something walks into a thicket, and only the SUSTAINED rate is
 * held down. It also means a test harness firing a voice repeatedly still hears
 * the first few, which a hard refractory would have silently swallowed.
 *
 * Refilled from `ctx.currentTime` rather than from `update`'s dt so that it is
 * correct for a Wildlife nobody is ticking, which is exactly the state the
 * audio harnesses build one in.
 *
 * The distant chorus is NOT throttled by this. Its own scheduler is already a
 * rate limit, it is the layer that makes the wood feel like it has an outside,
 * and letting twenty-six nearby birds starve it of tokens would have shrunk
 * the wood to a thirty-metre bubble — which is the opposite of the point.
 */
const SONG_REFILL = 0.3;
const SONG_BUDGET = 5;

/**
 * HOW A SONG LONGER THAN THE NODE BUDGET GETS SUNG.
 *
 * Every other phrase in this file is scheduled in one go: twenty `_note` calls,
 * forty oscillators, all created inside a single JS turn and all counted
 * against `this.voices` the instant they exist, because `onended` cannot fire
 * for something that has not started yet. Twenty is fine. A skylark is two to
 * four HUNDRED notes, and scheduling one that way would take the counter past
 * the ceiling on the first bird, drop most of its own song, and then refuse
 * every other event in the wood for the twenty seconds it took to drain.
 *
 * So the skylark is pumped instead. `_phrase` schedules only the notes that
 * start within the next `STREAM_AHEAD` seconds and sets a timer for
 * `STREAM_STEP` to come back for more. Measured in the running app, that holds
 * between fifteen and twenty-seven notes in flight at any moment — about a
 * wren's footprint, sustained for twenty seconds instead of two, against a
 * ceiling of fifty-eight. The lookahead is far longer than the step on purpose:
 * a late timer eats into the margin instead of leaving a hole in the song, and
 * the notes are still scheduled against `ctx.currentTime`, so they are
 * sample-accurate even when the timer that queued them was not.
 *
 * ONE AT A TIME, and that is what `_streams` is for. Two overlapping skylarks
 * is not a richer sky, it is twice the node footprint for a sound nobody can
 * separate, and three is the flush spike this file already has a ceiling to
 * prevent — arriving slowly enough that the ceiling never sees it coming.
 */
const STREAM_AHEAD = 0.6;
const STREAM_STEP = 0.35;
const STREAM_MAX = 1;

let cachedNoise = null;
/**
 * Pink noise, the only noise source in this file. See the header.
 *
 * Cached by sample rate and exported so `main.js` can warm it during the
 * shader wait — see `ambience.js`'s copy of this same comment.
 */
export function pinkBuffer(ctx, seconds = 3) {
  if (cachedNoise && cachedNoise.sampleRate === ctx.sampleRate) return cachedNoise;
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      d[i] = (b0 + b1 + b2 + white * 0.1848) * 0.26;
    }
  }
  cachedNoise = buf;
  return buf;
}

export class Wildlife {
  constructor(engine) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.rng = makeRng('wildlife');
    this.built = false;
    this.music = null;
    this.tripLevel = 0;
    this.dark = 0;
    /**
     * 0 all day, 1 for the ninety minutes after sunrise.
     *
     * A separate number from `dark` rather than derived from it, because `dark`
     * passes through the same value twice a day and dawn and dusk are opposite
     * events: one is the loudest ninety minutes a wood has and the other is the
     * quietest short of midnight. See `dawnAt` in world/daylight.js.
     */
    this.dawn = 0;

    /**
     * A budget, and it exists because of the one failure mode this design has.
     *
     * Every event here builds its nodes at the moment it fires. That is fine at
     * one event a second and it is not fine if a flock of perchers all flush
     * within a frame of each other, which is exactly what happens when you walk
     * into a thicket. A hard ceiling on concurrent voices costs one integer and
     * turns a possible scheduling spike into a slightly thinner chorus, which
     * nobody can hear.
     *
     * THE CEILING IS ENFORCED PER NODE, NOT PER EVENT, and that is the whole
     * point of where it sits. A guard at the top of `bolt` lets one bolt through
     * and then builds all forty-five of its nodes regardless; a guard inside
     * `_puff` stops the same burst part-way, which is a shorter rustle rather
     * than a missing one. Measured with fauna-audio.mjs firing every voice in
     * the file four times a second, which is roughly twenty times what play can
     * produce: it caps instead of climbing.
     */
    this.voices = 0;

    /**
     * THE "BUSES" ARE NUMBERS, NOT NODES, AND THAT IS FORCED BY THE GEOMETRY.
     *
     * `engine.createSpatial` returns a chain that is ALREADY connected to the
     * world bus through its own panner. Hanging a shared gain node off the same
     * input would add a second, dry, unpanned copy of every sound — a bird would
     * be both in a tree and inside your head at once. And a shared gain UPSTREAM
     * of the panners is worse: everything would sum into it and then fan out to
     * every panner, so each event would arrive from every location in the wood.
     *
     * Since every sound here is a discrete short event rather than a continuous
     * bed, the level it should have is simply the level at the moment it is
     * scheduled — so these are plain multipliers applied at schedule time. Three
     * fewer nodes and no routing to get wrong.
     *
     * `song` is anything with a pitch, `body` anything percussive — wings, feet,
     * twigs — and `night` the insects and the owl, which come up from zero. Song
     * and body are separate because the trip thins the chorus while leaving the
     * close physical sounds alone: something moving in the undergrowth two
     * metres away when the birds have all stopped is considerably stranger than
     * either on its own.
     */
    this.songGain = 0.26;
    this.bodyGain = 0.5;
    this.nightGain = 0;

    /** Where the ears are, for the per-event distance damping. */
    this.lx = 0;
    this.ly = 0;
    this.lz = 0;

    this._nextDistant = 3;
    this._nextWoodpecker = rngRange(this.rng, 20, 60);
    this._nextOwl = 20;
    this._nextInsect = 6;
    this._nextCrow = rngRange(this.rng, 25, 80);
    this._nextFall = rngRange(this.rng, 18, 55);
    this._nextFly = rngRange(this.rng, 45, 120);
    /**
     * The chatter, and it is by a long way the shortest interval in here.
     *
     * Everything above is an EVENT — something worth turning your head for,
     * every twenty seconds to every two minutes. This is the other thing, the
     * one a recording of a wood is nine-tenths made of: a tick, a hweet, two
     * notes from a bird that is not singing. Measured through the live frame
     * loop it comes out at eight to eighteen a minute depending on where the
     * chorus wave is, against twenty-odd song phrases — so in COUNT it is a
     * third of the wood and in NODES it is about a seventh, which is the right
     * way round for something that is one to three notes at a third of a song's
     * level. It starts within a second or two of the wood existing, because a
     * wood that takes eight seconds to say anything has already told you it is
     * a sound effect.
     */
    this._nextCall = rngRange(this.rng, 0.8, 3);
    this._nextJay = rngRange(this.rng, 40, 150);
    this._nextPheasant = rngRange(this.rng, 60, 200);
    this._nextBuzzard = rngRange(this.rng, 50, 240);
    /** How many long songs are being pumped right now. See STREAM_MAX. */
    this._streams = 0;

    /**
     * Seconds of accumulated world time, for the chorus wave.
     *
     * Its own accumulator rather than `ctx.currentTime`, because the context
     * clock starts when the user clicks through the gate and this wants to
     * start at a phase that is not always the same one. Seeded from the rng so
     * two sessions do not open on the same point of the wave.
     */
    this.clock = rngRange(this.rng, 0, 400);

    /**
     * Seconds of enforced silence left after something bolted near you.
     *
     * See `_startle`. It gates the chorus and nothing else — insects, the
     * stream and the wind carry on, which is what makes the gap read as the
     * BIRDS stopping rather than as the audio dropping out.
     */
    this._hush = 0;

    /** The song bucket, and the clock reading it was last refilled at. */
    this._songBudget = SONG_BUDGET;
    this._budgetAt = 0;
    /**
     * The chorus wave's current interval multiplier, kept on the instance
     * because `song` needs it and `update` is where it is computed. One, not
     * zero, so a Wildlife nobody is ticking — every audio harness builds one —
     * refills its bucket at the nominal rate instead of instantly or never.
     */
    this._spacing = 1;
  }

  build() {
    if (this.built) return;
    this.noise = pinkBuffer(this.ctx);
    this._buildFarTail();
    this.built = true;
  }

  /**
   * The scattered path: why a bird at sixty metres is not just a quiet bird.
   *
   * `createSpatial` already gives level and brightness — an inverse rolloff and
   * a low-pass that closes with distance — and those two together are most of
   * the way there. What they cannot produce is the third cue, which is that the
   * DIRECT sound falls off with distance and the scattered sound very nearly
   * does not. Everything that reaches you from a hundred metres of woodland has
   * been round several dozen trunks, so a far call is mostly reverb with a
   * little direct in it and a near one is the other way round. Get that wrong
   * and a distant bird reads as a nearby bird someone turned down, which is
   * exactly what it sounded like before this existed.
   *
   * The engine's room convolver cannot do it: it hangs off the world TRIM, so
   * every source in the wood shares one wet/dry ratio by construction. This is
   * a second, private send that only distant events feed, and the amount they
   * feed it falls much more slowly with distance than the panner's own gain —
   * which is the entire trick.
   *
   * FOUR DELAYS AND NO FEEDBACK, not a convolver. A second 1.9 s stereo
   * convolution for a cue this subtle is not worth the CPU, and the property
   * that made a convolver the right call in `impulse.js` — that an FIR cannot
   * accumulate, self-oscillate or click — is equally true of four taps with
   * nothing feeding back into them. Alternating the pans keeps it out of the
   * middle of your head; the low-pass at 1.4 kHz is the air and the leaves.
   *
   * It ends at `engine.worldBus`, deliberately and not at `roomSend`: worldBus
   * runs through `trims.world`, so the world volume slider controls this like
   * it controls everything else. Tapping the send directly would have produced
   * a reverb you cannot turn down.
   */
  _buildFarTail() {
    const ctx = this.ctx;
    this.farBus = ctx.createGain();
    this.farBus.gain.value = 1;

    const dark = ctx.createBiquadFilter();
    dark.type = 'lowpass';
    dark.frequency.value = 1400;
    // 0.4. This is the one filter in the file that everything passes through,
    // so it is the one that absolutely must not have a corner on it.
    dark.Q.value = 0.4;

    const out = ctx.createGain();
    /**
     * Modest on purpose. With the per-event send at its maximum this puts the
     * wet at roughly the level of the direct sound at sixty metres and well
     * under it at twenty, which is the crossover a wood actually has. Louder
     * and the far chorus turns into a cathedral, which is a different and much
     * worse place.
     */
    out.gain.value = 0.55;

    this.farParts = [this.farBus, dark, out];
    for (let i = 0; i < FAR_TAPS.length; i++) {
      const delay = ctx.createDelay(0.25);
      delay.delayTime.value = FAR_TAPS[i];
      const gain = ctx.createGain();
      gain.gain.value = FAR_LEVELS[i];
      const pan = ctx.createStereoPanner();
      pan.pan.value = i % 2 ? 0.72 : -0.72;
      this.farBus.connect(delay).connect(gain).connect(pan).connect(dark);
      this.farParts.push(delay, gain, pan);
    }
    dark.connect(out).connect(this.engine.worldBus);
  }

  /**
   * A spatial source, with the distance damping applied once.
   *
   * `setDistance` exists on the engine's spatial source and nothing calls it for
   * one-shots, so without this every bird in the wood would be equally bright
   * and only differ in level — which is exactly the cue that makes a distant
   * sound read as a quiet near one instead of as a far one. It is set once at
   * schedule time rather than per frame because these live for a second.
   */
  _place(position, options = {}) {
    const spatial = this.engine.createSpatial(position, options);
    const d = Math.hypot(position.x - this.lx, position.y - this.ly, position.z - this.lz);
    spatial.setDistance(d);
    /**
     * ONE extra gain node, and only past eighteen metres.
     *
     * Everything closer than that is dry, which is both correct — you are
     * inside the direct field of a bird three metres away — and the reason this
     * costs nothing in the case that happens most often, which is a footfall or
     * a percher at your elbow. `1 / (1 + d/45)` falls off far more gently than
     * the panner's inverse law, so the wet/dry ratio climbs steadily with
     * distance: about 0.5 at twenty metres, about 1 at sixty, and past that the
     * call is mostly the wood rather than the bird. Which is what a wood is.
     *
     * The dispose is CHAINED rather than replaced. Every caller in this file
     * ends by calling `spatial.dispose()` on a timer, and a wet send that is
     * not torn down there is a gain node per distant event for the rest of the
     * session — the exact leak the rest of the file is careful about.
     */
    /**
     * WORLD-BUS SOURCES ONLY, and that is a routing constraint rather than a
     * preference.
     *
     * The tail is one delay network with one output, and that output has to
     * terminate on exactly one bus for exactly one volume slider to control it.
     * It terminates on `worldBus`, so anything routed to `sfxBus` must not feed
     * it — otherwise turning the world down would silence the reverb of a
     * woodpecker whose dry signal is on the effects slider, which is the same
     * class of half-connected control that made three of the five sliders dead
     * in the first place.
     *
     * Nothing is lost. Every sfx voice still gets the engine's forest
     * convolver, because `trims.sfx` feeds `roomSend` like `trims.world` does;
     * what it does not get is the extra distance-dependent wetness, and the
     * events on that bus are overwhelmingly things happening within a few
     * metres of you, where the correct amount of extra wetness is none.
     */
    if (this.farBus && d > 18 && !options.bus) {
      const wet = this.ctx.createGain();
      wet.gain.value = 0.3 / (1 + d / 45);
      spatial.input.connect(wet).connect(this.farBus);
      const inner = spatial.dispose;
      spatial.dispose = () => {
        try {
          wet.disconnect();
        } catch {
          /* already gone */
        }
        inner();
      };
    }
    return spatial;
  }

  /** The jukebox, so the birds can find its key. Optional. */
  setMusic(music) {
    this.music = music;
  }

  /**
   * How much this species belongs to the current light, 0.06 to 1.
   *
   * A window with soft edges rather than a test, and it never reaches zero.
   * Both of those are deliberate. A hard boundary means that at some exact
   * value of `dark` half the wood stops, which during a trip — where `dark`
   * ramps smoothly — would be audible as a moment when the birds changed, and
   * the whole point is that you cannot catch it happening. And the floor is
   * there because a real wood always contains one bird doing the wrong thing at
   * the wrong hour; six per cent means it happens about once every twenty
   * calls, which is a curiosity rather than a bug.
   */
  _window(voice, dark) {
    const rise = clamp01((dark - voice.active[0]) / 0.18 + 1);
    const fall = clamp01((voice.active[1] - dark) / 0.18 + 1);
    return 0.06 + 0.94 * Math.min(rise, fall);
  }

  /**
   * Choose a species for a call about to be made at `distance` metres.
   *
   * Weighted by three things: whether it is awake, how rare it is meant to be,
   * and whether it throws far enough to be worth the nodes. That last term is
   * the one that changed the character of the distant chorus most — a uniform
   * pick spent a third of its events on goldcrests and chiffchaffs at ninety
   * metres, which does not sound like a small bird a long way off, it sounds
   * like nothing at all and a wood that is emptier than the event rate says.
   */
  _pick(distance, dark) {
    let total = 0;
    for (const v of VOICES) total += this._weight(v, distance, dark);
    let r = this.rng() * total;
    for (let i = 0; i < VOICES.length; i++) {
      r -= this._weight(VOICES[i], distance, dark);
      if (r <= 0) return i;
    }
    return VOICES.length - 1;
  }

  /**
   * One species' share of the next call, and the fourth term is the new one.
   *
   * `1 + (early - 1) × dawn` is the dawn running order. It is EXACTLY ONE for
   * the other twenty-two and a half hours, which is not a nicety: it means the
   * pinned automation hour weights the roster to the same numbers it always
   * did, so nothing stored by `audio-probe.mjs` or `fauna-audio.mjs` moves
   * because this term exists.
   *
   * What it buys at first light is that the chorus does not merely thicken, it
   * ARRIVES IN ORDER. At dawn 1 a robin is weighted two and a half times its
   * daytime share and a blackcap under half of its, so the first minutes are
   * robins and blackbirds and song thrushes and the warblers turn up late —
   * which is the actual sequence, and is audible as the wood assembling itself
   * rather than fading up.
   */
  _weight(voice, distance, dark) {
    const early = 1 + (voice.early - 1) * this.dawn;
    return (
      this._window(voice, dark) *
      voice.rare *
      early *
      Math.min(1, voice.carry / Math.max(1, distance))
    );
  }

  /**
   * WHICH bird of that species this is, as a number from 0 to 1.
   *
   * The wood's memory, and it does not have one. There is no per-bird state
   * anywhere in this file or in `fauna.js`'s perchers beyond a species index,
   * and adding some would mean the distant chorus — which invents a coordinate
   * every time it fires — either allocating an identity per call and throwing
   * it away, or having none.
   *
   * So identity is derived from the one thing a bird already has, which is
   * WHERE IT IS. Quantise the position into five-metre cells, hash it with the
   * species, and the answer is stable for as long as the bird stays in its
   * tree and different for the one answering from forty metres away. The
   * chaffinch in that oak is always a shade flat and always slightly hurried;
   * walk away, come back, and it still is. Nothing is stored, nothing leaks,
   * and two Wildlifes built over the same wood agree.
   *
   * EIGHT METRES, AND THE HONEST VERSION OF WHY. It has to be much larger than
   * a percher's hop, because `fauna.js` moves one about a metre around its home
   * and a bird that changes pitch when it shuffles along the branch is worse
   * than a bird with no identity at all. It has to be much smaller than the
   * thirty metres an answer is placed at, or a conversation is one bird again.
   * Eight satisfies both with room: measured over forty thousand placements it
   * leaves six hundred distinct identities inside the hundred and twenty metres
   * anything is ever audible from, and an answer shares its caller's identity
   * once in ten thousand times.
   *
   * What it does not do is eliminate the boundary. A percher whose home sits
   * within a hop of a cell edge — measured at one in eight, against one in five
   * at the five metres this started on — will cross it now and then and come
   * back a semitone off, and there is no fix for
   * that short of per-bird state in a file that deliberately has none. It is
   * the mildest possible failure: the bird sounds like a slightly different
   * bird, which is what every other layer in `_phrase` is deliberately doing
   * anyway. Worth knowing about; not worth a Map keyed on something that has no
   * identity to key on.
   *
   * The second and third values are a cheap decorrelation of the first rather
   * than more hashing — pitch, tempo and stamina want to be independent, and a
   * multiply and a modulo is enough for that when none of them is doing
   * anything subtle.
   */
  _individual(position, voiceIndex) {
    const x = Math.round(position.x / 8);
    const z = Math.round(position.z / 8);
    let h = Math.imul(x, 73856093) ^ Math.imul(z, 19349663) ^ Math.imul(voiceIndex + 1, 83492791);
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    const a = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    return [a, (a * 7919) % 1, (a * 104729) % 1];
  }

  /**
   * Everything stops.
   *
   * Called by `flush` and `bolt` when whatever left did so from close enough
   * that you certainly noticed. It is four or five seconds of nothing followed
   * by exactly one bird, and it is the highest ratio of perceived intelligence
   * to code in the file — the wood appears to have reacted to you, and all that
   * actually happened is that a countdown got set by an event that was already
   * firing for other reasons.
   *
   * Scaled by nearness so that something bolting at the edge of earshot barely
   * dents it. Never extended past its current value, because two flushes in a
   * row should not produce ten seconds of dead air.
   */
  _startle(nearness) {
    const s = 2.2 + nearness * 3.4;
    if (s > this._hush) this._hush = s;
  }

  /**
   * Give a voice back, and only ever once per node.
   *
   * Every increment of `this.voices` in this file is unconditional and sits one
   * line above the `onended` that decrements it, so the two cannot get out of
   * step by inspection — and per-call testing agrees: firing each of twenty
   * call paths in isolation and waiting nine seconds returns the counter to
   * exactly zero every time, and the node census balances exactly.
   *
   * Under a stress harness running twelve simulated minutes at eight times
   * speed it nonetheless finished fifteen BELOW zero out of roughly six
   * thousand events. Compression is the difference: whole trains of forty
   * grains get built in one JS turn, so the later scheduling times land in the
   * past, and that is the one regime where a source's `ended` delivery is not
   * something to have opinions about.
   *
   * The direction is what makes it worth a fix rather than a note. A counter
   * that drifts DOWN makes the ceiling more permissive, not less, so it fails
   * silently and gets worse the longer the session runs — after an hour the
   * limit that exists to stop a thicket-flush spike would be at twice its
   * intended value. One boolean per node, set on a node that is already dead,
   * turns the count into something that cannot drift.
   */
  _release(node) {
    if (node.__rrReleased) return;
    node.__rrReleased = true;
    this.voices--;
  }

  /**
   * Take a token from the song bucket, or refuse. See SONG_REFILL.
   *
   * Divided by the chorus wave's spacing, so the bucket fills three times
   * faster at a peak than in a trough and the perchers breathe with the distant
   * chorus instead of filling in its silences — which they would otherwise do
   * perfectly, cancelling the wave out entirely.
   *
   * AND MULTIPLIED BY THE HOUR, IN BOTH DIRECTIONS.
   *
   * The throttle exists because seventy-two bird phrases a minute is a dawn
   * chorus in a world that has no dawn. Now that there is one, the rate has to
   * go both ways, and the second half turned out to matter more than the first.
   *
   *   DAWN. `1 + 2 × dawn` triples the refill for the ninety minutes after
   *   sunrise, which is the one time of day a wall of birds is the right
   *   answer. Measured through the live frame loop: 46.5 located phrases a
   *   minute at noon against 78 at dawn.
   *
   *   NIGHT. `1 − 0.6 × dark` is the fix for something the clock exposed rather
   *   than caused. The distant chorus already thins itself — its interval is
   *   multiplied by `1 + 2.5 × dark`, so it is three and a half times sparser
   *   at midnight — but the perchers are not on that schedule at all: `fauna.js`
   *   gives each of its twenty-six a five-to-twenty-six-second timer and calls
   *   `song` when it expires, whatever the sky is doing. So the first honest
   *   measurement of a night came back at FORTY BIRD PHRASES A MINUTE AT
   *   MIDNIGHT, correctly chosen from the nocturnal end of the table and at
   *   half gain, and still completely wrong — a wood at two in the morning is
   *   not a quieter dawn, it is an empty one with two things in it.
   *
   *   That is the same argument the file opens this constant with: a rate that
   *   lives in the caller cannot be balanced against the rate that lives here,
   *   so it is balanced here. It takes midnight to about fifteen a minute,
   *   which against a nightingale's carry is one bird at a time.
   *
   * Both factors are exactly 1 at `dark = dawn = 0`, which is the pinned
   * automation hour — so `scripts/audio-probe.mjs` and every other stored
   * audio expectation measure precisely what they measured before.
   */
  _afford() {
    const now = this.ctx.currentTime;
    const elapsed = Math.max(0, now - this._budgetAt);
    this._budgetAt = now;
    const hour = (1 + 2 * this.dawn) * (1 - 0.6 * this.dark);
    this._songBudget = Math.min(
      SONG_BUDGET,
      this._songBudget + (elapsed * SONG_REFILL * hour) / Math.max(0.3, this._spacing)
    );
    if (this._songBudget < 1) return false;
    this._songBudget -= 1;
    return true;
  }

  /**
   * A pitch class the current record would agree with.
   *
   * WHY THIS EXISTS. "Birdsong that starts landing on the jukebox's key" is one
   * of the truest small things about the experience being modelled: unrelated
   * sounds stop being unrelated. Making it happen is only possible because
   * nothing in this project is a recording — the track carries its own scale as
   * an array of MIDI notes, so a bird can be told to sing in it.
   *
   * It arrives GRADUALLY, as a probability rather than a switch. At a quarter
   * intensity roughly a quarter of the notes land in the scale, which is the
   * stage where you keep half-noticing and losing it again; at the peak they all
   * do and the wood is unmistakably singing along with the machine. A hard
   * quantise from the first second would be a feature announcing itself.
   */
  _snap(midi, strength) {
    const track = this.music?.track;
    if (!track?.scale?.length || strength <= 0) return midi;
    if (this.rng() > strength) return midi;
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    let best = pc;
    let bestD = 99;
    for (const n of track.scale) {
      const s = ((n % 12) + 12) % 12;
      // Nearest scale degree by pitch class, so the contour survives — a bird
      // snapped to the nearest note of the key is still doing its own shape.
      const d = Math.min(Math.abs(s - pc), 12 - Math.abs(s - pc));
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    let shift = best - pc;
    if (shift > 6) shift -= 12;
    if (shift < -6) shift += 12;
    return midi + shift;
  }

  /**
   * One note of birdsong: a sine carrier with a sine modulator, a short
   * exponential envelope on both, and a glide.
   *
   * The modulation envelope is what makes it a voice — it decays much faster
   * than the amplitude, so the note has a bright chiff at the front and is a
   * pure tone by the time it ends. That is the shape of every whistled sound
   * there has ever been and it is two `exponentialRampToValueAtTime` calls.
   */
  _note(dest, when, midi, voice, gain, shape = _flatShape) {
    if (this.voices > VOICE_CEILING) return;
    const ctx = this.ctx;
    const f = midiToFreq(midi);
    const to = midiToFreq(midi + voice.glide * (shape.glide ?? 1));
    const decay = voice.decay * (shape.decay ?? 1);
    /**
     * Scaled, never raised past the table's own ceiling.
     *
     * `shape.index` is how the phrase-level `pure` reaches an individual note
     * and every value of it in the table is below one, so this clamp has never
     * fired. It is here because the one way this file can produce the sound it
     * exists to avoid is an index above three, and a multiplier is exactly the
     * kind of thing that gets set to 2 by somebody who has not read the header.
     */
    const index = clamp(voice.index * (shape.index ?? 1), 0.02, 2.2);

    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.setValueAtTime(f, when);
    carrier.frequency.exponentialRampToValueAtTime(Math.max(40, to), when + decay);

    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = f * voice.ratio;
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(f * index, when);
    modGain.gain.exponentialRampToValueAtTime(f * 0.005, when + decay * 0.7);
    mod.connect(modGain).connect(carrier.frequency);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    // 6 ms attack. Shorter is a click, longer and the note loses the chirp.
    env.gain.exponentialRampToValueAtTime(gain, when + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, when + decay);

    carrier.connect(env).connect(dest);
    carrier.start(when);
    mod.start(when);
    carrier.stop(when + decay + 0.04);
    mod.stop(when + decay + 0.04);
    this.voices++;
    carrier.onended = () => {
      this._release(carrier);
      try {
        env.disconnect();
        mod.disconnect();
        modGain.disconnect();
      } catch {
        /* already gone */
      }
    };
  }

  /**
   * A whole phrase, at a place in the world, sung by a particular bird.
   *
   * Placed with a spatial source rather than a stereo pan, because the whole
   * point of a bird in a tree is that it is IN a tree — you can turn your head
   * and lose it, walk toward it and have it get closer, and then it is not
   * there. `engine.createSpatial` gives an HRTF panner and a distance low-pass
   * for the cost of three nodes, and the source is torn down when the phrase
   * ends so nothing accumulates.
   *
   * THE OTHER THING THIS DOES IS MAKE SURE YOU NEVER HEAR IT TWICE, which used
   * to be two lines and is now most of the function. It is worth the space: the
   * fault a listener actually reported was never "there are only twelve birds",
   * it was that the same twelve arrangements of the same notes came round and
   * round until the wood stopped being a place. Four layers, in order of how
   * much they buy:
   *
   *   THE INDIVIDUAL. `_individual` turns the position into a fixed identity —
   *   a root offset of about a semitone either way and a standing tempo bias —
   *   so the bird in that tree has a voice of its own and keeps it. This is
   *   the layer that makes a call and its answer sound like two birds rather
   *   than one bird played twice.
   *
   *   THE LENGTH. A rendition uses somewhere between half and all of the body
   *   of the phrase, and a cyclic one may run half again as long. Cuts come out
   *   of the MIDDLE — `tail` notes at the end are the ending and always play —
   *   because a chaffinch that stops before its flourish is not a short
   *   chaffinch, it is a broken one.
   *
   *   THE RENDITION. A little transposition and a little tempo on top of the
   *   individual's own, per performance, plus a note dropped now and then out
   *   of the long cyclic songs where a real bird drops one.
   *
   *   THE NOTE. A tenth of a semitone of detune on each one, independently. A
   *   bird is not a sequencer and the notes of a real phrase are not in tune
   *   with each other; this is well under the threshold where anyone hears a
   *   wrong note and comfortably over the one where a phrase sounds quantised.
   *
   * `fade`, `pure` and `hold` are applied here too rather than in `_note`,
   * because all three are positions within a phrase and `_note` does not know
   * there is one.
   */
  _phrase(position, voiceIndex, { gain = 1, transpose = 0, snap = 0, delay = 0, short = 0 } = {}) {
    if (!this.built || this.voices > VOICE_CEILING * 0.7) return null;
    const ctx = this.ctx;
    const rng = this.rng;
    const voice = VOICES[voiceIndex % VOICES.length];
    const streaming = Array.isArray(voice.stream);
    if (streaming && this._streams >= STREAM_MAX) return null;
    const spatial = this._place(position, {
      refDistance: 7,
      rolloff: 1.35,
      maxDistance: 120,
    });
    const bus = ctx.createGain();
    bus.gain.value = voice.level * gain * this.songGain;
    bus.connect(spatial.input);

    const [whoPitch, whoPace, whoLength] = this._individual(position, voiceIndex);
    // The individual, then this performance. Roughly the range the single
    // per-phrase roll used to have, split so that most of it stays put.
    const shift = transpose + (whoPitch - 0.5) * 2.2 + rngRange(rng, -0.45, 0.45);
    const pace = (0.92 + whoPace * 0.18) * rngRange(rng, 0.95, 1.06);

    /**
     * How much of the phrase this one gets.
     *
     * `tail` is both the protected ending and the flag for whether the body may
     * be run long: a phrase with an ending cannot be, because the only way to
     * extend it is to cycle back through notes it has already sung and then say
     * the ending twice. Voices with no ending are cycles by construction —
     * chiffchaffs, nuthatches, wrens — and running those long is precisely what
     * a real one does.
     */
    const n = voice.notes.length;
    const tail = Math.min(voice.tail ?? 0, n - 1);
    const body = n - tail;
    const ceiling = tail > 0 ? 1 : 1.45;
    const frac = clamp(
      (0.58 + whoLength * 0.42 + rngRange(rng, -0.16, 0.28)) * (1 - short * 0.3),
      0.42,
      ceiling
    );
    /**
     * ROUNDED TO WHOLE MOTIFS, and this is the guard that stopped the whole
     * idea being a net loss.
     *
     * Varying the length is right for a phrase that is a shape and wrong for
     * one that is a repeated unit, and the table contains both. A song thrush
     * cut anywhere is a song thrush that said something twice instead of three
     * times, which is what song thrushes do. A CUCKOO CUT AT AN ODD NUMBER IS
     * "cuck-oo, cuck-oo, cuck" — the most recognisable sound in this project,
     * broken, in the one way everybody would notice. So `unit` is the size of
     * the repeating group and the count is a multiple of it, which for the wood
     * pigeon's five-note idiom means it is simply never cut at all.
     */
    const unit = voice.unit ?? 1;
    let count = Math.max(unit, Math.round((body * frac) / unit) * unit) + tail;
    // Long cyclic songs only. A cuckoo with a note missing is not a variation,
    // it is a fault, and the phrases short enough to notice are exactly the
    // ones whose shape is the whole species.
    const mayDrop = tail === 0 && n >= 9;

    /**
     * A STREAMING VOICE IS MEASURED IN SECONDS, NOT IN NOTES, which is the
     * whole distinction the field exists to draw. Every other row is a phrase
     * and its length is however long its notes take; a skylark is a stretch of
     * time that happens to be full of notes, so `stream` is `[min, max]`
     * seconds and the count falls out of the tempo. An individual carries its
     * own stamina on top — some larks go on much longer than others, and it is
     * the same bird every time you stand under it.
     */
    if (streaming) {
      let mean = 0;
      for (const g of voice.gaps) mean += g;
      mean = (mean / voice.gaps.length) * pace;
      const seconds =
        rngRange(rng, voice.stream[0], voice.stream[1]) *
        (0.75 + whoLength * 0.5) *
        (1 - short * 0.45);
      count = Math.max(12, Math.round(seconds / Math.max(0.01, mean)));
    }

    const streamAhead = streaming ? STREAM_AHEAD : Infinity;
    const t0 = ctx.currentTime + 0.02 + delay;
    const span = Math.max(1, count - 1);
    const fade = voice.fade ?? 1;
    const pure = voice.pure ?? 1;
    const hold = voice.hold ?? 1;
    let i = 0;
    let t = t0;
    let torn = false;
    /**
     * Give the stream slot back, and only ever once. Same argument as
     * `_release` and the same failure it prevents: a stream that decremented
     * twice — which `dispose` clearing the counter under a pump in flight would
     * cause — leaves it NEGATIVE, and a negative counter does not refuse the
     * next skylark, it silently allows two. A counter guarding a limit must not
     * be able to drift in the permissive direction.
     */
    let holding = streaming;
    const giveBack = () => {
      if (!holding) return;
      holding = false;
      this._streams--;
    };

    const teardown = (after) => {
      setTimeout(() => {
        torn = true;
        try {
          bus.disconnect();
          spatial.dispose();
        } catch {
          /* already gone */
        }
      }, after * 1000);
    };

    /**
     * Schedule everything that starts before the horizon, then either finish or
     * come back for more. For every voice but the skylark the horizon is
     * infinite and this runs exactly once, which is the same straight loop it
     * has always been.
     */
    const pump = () => {
      if (torn) return;
      if (!this.built) {
        giveBack();
        teardown(0);
        return;
      }
      /**
       * A BACKGROUNDED TAB THROTTLES `setTimeout` TO A SECOND OR MORE, and the
       * only voice that can notice is the one being pumped by one. Without this
       * the loop below would find `t` a long way behind the clock and schedule
       * the whole missed stretch into the past, which Web Audio renders as
       * everything at once — twenty notes in a frame, which is a click. Skip
       * the piece that was missed instead. A skylark heard through a tab switch
       * has a hole in it, which is the truthful outcome and the quiet one.
       */
      if (t < ctx.currentTime) t = ctx.currentTime + 0.02;
      const horizon = ctx.currentTime + streamAhead;
      while (i < count && t < horizon) {
        const src = i < count - tail ? i % body : body + (i - (count - tail));
        const k = i / span;
        const last = i === count - 1;
        if (!(mayDrop && i > 0 && !last && rng() < 0.05)) {
          const midi = this._snap(
            voice.root + voice.notes[src] + shift + rngRange(rng, -0.1, 0.1),
            snap
          );
          _shape.glide = rngRange(rng, 0.7, 1.3) * (last && hold > 1 ? Math.sqrt(hold) : 1);
          _shape.decay = last ? hold : 1;
          _shape.index = Math.pow(pure, k);
          this._note(
            bus,
            t,
            midi,
            voice,
            0.5 * rngRange(rng, 0.8, 1.1) * Math.pow(fade, k),
            _shape
          );
        }
        t += voice.gaps[src % voice.gaps.length] * pace;
        i++;
      }
      if (i < count) {
        setTimeout(pump, STREAM_STEP * 1000);
        return;
      }
      giveBack();
      /**
       * One timer per phrase, firing after the last node has stopped. Tearing
       * the panner down matters: a PannerNode left connected keeps its HRTF
       * convolution running for as long as the context lives.
       *
       * MEASURED FROM `ctx.currentTime`, not from `t0`, and that is what makes
       * the same line correct for a phrase scheduled all at once and for one
       * that has been pumped in for twenty seconds. It also fixes the older
       * form's bug by construction rather than by remembering to add `delay`:
       * `t` is an absolute context time in both cases, so the distance from now
       * to the end of the last note is the only quantity there is.
       */
      teardown(Math.max(0.2, t - ctx.currentTime + voice.decay * hold + 0.6));
    };

    if (streaming) this._streams++;
    pump();
    return { at: t0, notes: count, voice: voiceIndex };
  }

  /**
   * Sing, and maybe get an answer.
   *
   * The answer comes from a DIFFERENT PLACE. It is the same species, quieter,
   * transposed a little, one to three seconds later, from somewhere else in the
   * wood — which is all it takes, because two of the same call at two bearings
   * is the definition of a conversation and the brain does the rest.
   *
   * THE ANSWER IS NOW A DIFFERENT BIRD RATHER THAN A DIFFERENT PITCH, and the
   * explicit transposition came DOWN when that happened, from three semitones
   * to one and a half. It had been carrying the whole job: at ±3 on top of the
   * old ±1.5 per-phrase roll the reply could land four and a half semitones off
   * the call, which is far enough that it stops reading as the same species and
   * starts reading as the same phrase played through a pitch shifter. Now the
   * reply is placed somewhere else in the wood, so `_individual` hands it its
   * own standing pitch and tempo and its own phrase length, and it differs the
   * way a second bird differs. The transposition is left in at half strength
   * because a real answer does tend to sit slightly above or below the call,
   * and it is now the smallest of the three things making them distinguishable
   * rather than the only one.
   */
  song(position, voiceIndex, { answer = false, gain = 1, throttle = true } = {}) {
    if (!this.built) return;
    // The density limiter. `throttle: false` is the distant chorus, which is
    // rate-limited by its own scheduler — see SONG_REFILL.
    if (throttle && !this._afford()) return;
    const rng = this.rng;
    const snap = clamp01((this.tripLevel - 0.15) / 0.6);
    /**
     * A bird out of its hour still sings, but half-heartedly.
     *
     * This path is what `fauna.js` calls for a percher you have walked up to,
     * and the species is that individual's identity — it cannot be re-picked
     * here without the bird in the tree in front of you changing what it is.
     * So the window arrives as a level instead: at the wrong end of the day a
     * great tit drops to about half, which is a bird having one more go rather
     * than a bird that has been switched off. Floored well above zero for the
     * same reason the window itself is: silence here would read as broken.
     */
    const hour = 0.5 + 0.5 * this._window(VOICES[voiceIndex % VOICES.length], this.dark);
    const sung = this._phrase(position, voiceIndex, { gain: gain * hour, snap });
    /**
     * AND THEN IT SAYS SOMETHING, which is the cheapest line in this method.
     *
     * A bird that finishes a song and then goes silent for twenty seconds is a
     * loudspeaker in a tree. A real one sings, and then a second or two later
     * makes the small unremarkable noise it makes all day — and hearing those
     * two from the same bearing is what tells you they came from the same
     * animal. One roll in six, three notes, no token, and it does more for the
     * percher three metres from you than any row in the table.
     */
    if (sung && rng() < 0.17) {
      this.call(position, voiceIndex, 'contact', {
        gain: 0.7,
        delay: rngRange(rng, 1.4, 3.2),
      });
    }
    if (!answer) return;
    /**
     * The reply is placed by hand rather than by picking another percher,
     * because it must come from beyond the trees — a bird you can see is not
     * mysterious. Thirty to seventy metres, at a bearing that is not the
     * caller's, and dulled by the distance model on the way.
     */
    const a = rng() * Math.PI * 2;
    const r = 30 + rng() * 42;
    _answerAt.x = position.x + Math.cos(a) * r;
    _answerAt.y = position.y + rngRange(rng, -1, 4);
    _answerAt.z = position.z + Math.sin(a) * r;
    const roll = rng();
    if (roll < 0.45) {
      this._phrase(_answerAt, voiceIndex, {
        gain: gain * 0.75 * hour,
        transpose: rngRange(rng, -1.5, 1.5),
        snap,
        delay: rngRange(rng, 1.1, 2.8),
        // An answer is an abbreviation. It is the same song with less
        // conviction in it, which is what answering something is.
        short: 1,
      });
      return;
    }
    /**
     * A DIFFERENT BIRD ANSWERS, which is not a conversation and is arguably
     * better than one.
     *
     * A real bird singing sets off the ones around it, and they are not its own
     * species — what you hear is one voice and then the wood picking up. It was
     * also, for a while, the only route by which the second six species reached
     * a listener standing next to a percher at all, because `fauna.js` handed
     * out voice indices from a roster with the number six written into it; that
     * is fixed at the other end now and it reads `VOICE_COUNT`, which is
     * exported for exactly that reason. The roll stays because it was never
     * really a workaround — it is the difference between "that bird is
     * repeating itself" and "there are several of them out there".
     */
    if (roll > 0.7) return;
    this._phrase(_answerAt, this._pick(r, this.dark), {
      gain: gain * 0.7,
      snap,
      delay: rngRange(rng, 0.9, 2.4),
    });
  }

  /**
   * EVERYTHING A BIRD SAYS THAT IS NOT A SONG, which is almost everything.
   *
   * A songbird sings for a few minutes a day. It makes noise for all of it, and
   * a recording of a real wood is nine parts small utterance to one part
   * set-piece — a tick from a robin, two notes from a great tit crossing a ride,
   * a wren swearing at a cat four gardens away, a fledgling that will not stop.
   * The table had none of it, and the effect was not that the wood was quiet.
   * The effect was that every single sound in it was a PERFORMANCE, delivered
   * from a fixed position, complete, and then over — which is why the silences
   * between them read as gaps in a soundtrack rather than as a wood.
   *
   * ALL FOUR KINDS COME OUT OF THE ROW'S `call` FIELD and none of them needed a
   * new table. That is not economy for its own sake: it is why they sound like
   * the same species. A bird's calls really are one small piece of material
   * moved about, and the four things done to it here are the four things a bird
   * does to it.
   *
   *   CONTACT is the note itself, once or twice, at a third of a song's level.
   *   "I am here." It is the most common sound in a wood by a wide margin and
   *   the only one on this list that means nothing at all.
   *
   *   ALARM is the same note a fifth up, hammered four to six times with the
   *   glide taken out and the decay halved. Flattening the glide is what does
   *   it: every song note in this file MOVES, and a note that refuses to is
   *   instantly wrong in a way the ear reads as urgency. Real alarm calls are
   *   built to be hard to locate and this is the cheap version of that.
   *
   *   FLIGHT is the note falling away, once or twice, while the panner carries
   *   it across you and up. Birds call as they go over and you almost never see
   *   them; it is the one voice in the file that is DEFINITELY not in a tree.
   *
   *   BEG is a juvenile: the note an octave up, eight to twelve times,
   *   accelerating, rising, thin, insistent and never answered. It is the sound
   *   of a wood in June and it is faintly unbearable, which is correct.
   *
   * On `worldBus`, all four, by the file's own test — these are voices carrying
   * from elsewhere and not addressed to you, and a player turning them down is
   * turning the wood down. The alarm is the arguable one and it goes the same
   * way as the crow for the same reason: a bird forty metres off shouting about
   * a sparrowhawk is the wood having an alarm system, not an event about you.
   * The two calls that ARE about you already exist, they are the squirrel and
   * the roe deer, and they are both on sfx.
   */
  call(position, voiceIndex, kind = 'contact', { gain = 1, delay = 0 } = {}) {
    if (!this.built || this.voices > VOICE_CEILING * 0.55) return null;
    const ctx = this.ctx;
    const rng = this.rng;
    const voice = VOICES[voiceIndex % VOICES.length];
    const notes = voice.call ?? [0];
    const [whoPitch] = this._individual(position, voiceIndex);
    const shift = (whoPitch - 0.5) * 2.2 + rngRange(rng, -0.35, 0.35);

    /**
     * Per kind: how many, how far apart, how much of the row's own decay and
     * glide survive, where the note sits, and how loud. Six numbers, and they
     * are the whole difference between the four.
     *
     * `shape.glide` is a MULTIPLIER on the row's own glide, which is signed —
     * a wren's notes rise and a robin's fall — so two of these four have to
     * assert a direction rather than a depth. A flight call falls, always,
     * because it is a bird receding; a juvenile rises, always, because that is
     * what makes begging sound like begging rather than like sighing. `down`
     * and `up` flip the multiplier for the rows that would otherwise come out
     * backwards, and it is the difference between a fledgling and a wheeze.
     */
    const down = voice.glide > 0 ? -1 : 1;
    const up = -down;
    let count = notes.length;
    let step = rngRange(rng, 0.16, 0.28);
    let lift = 0;
    let level = 0.34;
    const shape = { glide: 1, decay: 1, index: 1 };
    if (kind === 'alarm') {
      count = 4 + Math.floor(rng() * 3);
      step = rngRange(rng, 0.075, 0.105);
      lift = 7;
      level = 0.5;
      // Nearly flat, and that is the signal. Every song note in this file
      // moves; a note that will not is heard as urgency before it is heard as
      // anything else.
      shape.glide = 0.12;
      shape.decay = 0.5;
      shape.index = 1.2;
    } else if (kind === 'flight') {
      count = 1 + Math.floor(rng() * 2);
      step = rngRange(rng, 0.19, 0.3);
      lift = 5;
      level = 0.3;
      shape.glide = 2.4 * down;
      shape.decay = 1.3;
      shape.index = 0.7;
    } else if (kind === 'beg') {
      count = 8 + Math.floor(rng() * 5);
      step = rngRange(rng, 0.15, 0.2);
      lift = 12;
      level = 0.26;
      shape.glide = 0.9 * up;
      shape.decay = 1.5;
      shape.index = 1.25;
    }

    const spatial = this._place(position, {
      refDistance: 7,
      rolloff: 1.4,
      maxDistance: 110,
    });
    const bus = ctx.createGain();
    bus.gain.value = voice.level * gain * level * this.songGain;
    bus.connect(spatial.input);

    const t0 = ctx.currentTime + 0.02 + delay;
    let t = t0;
    for (let i = 0; i < count; i++) {
      const midi = voice.root + notes[i % notes.length] + lift + shift + rngRange(rng, -0.12, 0.12);
      _shape.glide = shape.glide * rngRange(rng, 0.8, 1.2);
      _shape.decay = shape.decay;
      _shape.index = shape.index;
      this._note(bus, t, midi, voice, 0.5 * rngRange(rng, 0.85, 1.1), _shape);
      t += step;
      // A begging juvenile speeds up and does not stop. Everything else keeps
      // its own loose time.
      step *= kind === 'beg' ? 0.94 : rngRange(rng, 0.9, 1.14);
    }

    /**
     * The flight call goes past. Two ramps on a panner that already exists —
     * the same three lines the flush uses, and the reason this one is worth
     * having is that nothing else in the file passes OVER you. Every other
     * event in this wood happens at a point; a bird going over is the only one
     * with a direction.
     */
    if (kind === 'flight' && spatial.panner.positionX) {
      const heading = rng() * Math.PI * 2;
      const at = t0 + (t - t0) + 1.6;
      spatial.panner.positionX.linearRampToValueAtTime(
        position.x + Math.cos(heading) * 30,
        Math.max(at, t0 + 0.4)
      );
      spatial.panner.positionY.linearRampToValueAtTime(
        position.y + rngRange(rng, 4, 10),
        Math.max(at, t0 + 0.4)
      );
      spatial.panner.positionZ.linearRampToValueAtTime(
        position.z + Math.sin(heading) * 30,
        Math.max(at, t0 + 0.4)
      );
    }

    setTimeout(
      () => {
        try {
          bus.disconnect();
          spatial.dispose();
        } catch {
          /* already gone */
        }
      },
      (t - ctx.currentTime + voice.decay * 2 + 1.4) * 1000
    );
    return { at: t0, notes: count, voice: voiceIndex, kind };
  }

  /**
   * A burst of pink noise through a wide band-pass, at a place.
   *
   * This is the whole percussion section: wings, hooves, twigs, leaves, a
   * woodpecker. The only things that change are the centre frequency, the width,
   * the decay and how many of them there are — which is a stronger statement
   * than it sounds, because it means nothing in here can ring.
   *
   * `bus` only does anything when this builds its own spatial source, which is
   * the `hoof` case and nothing else — every other caller hands in a shared one
   * that already knows which bus it belongs to.
   */
  _puff(
    position,
    when,
    { freq, q = 0.7, decay = 0.08, gain = 0.2, rate = 1, spatial = null, bus = null }
  ) {
    if (!this.built || this.voices > VOICE_CEILING) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = rate;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    // Never above 1.2. A band-pass at Q 4 on noise is a pitch, and a train of
    // them is the buzz this project exists downstream of.
    bp.Q.value = Math.min(q, 1.2);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.linearRampToValueAtTime(gain * this.bodyGain, when + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, when + decay);

    const own =
      spatial ?? this._place(position, { refDistance: 5, rolloff: 1.5, maxDistance: 70, bus });
    src.connect(bp).connect(env).connect(own.input);
    src.start(when, this.rng() * 2);
    src.stop(when + decay + 0.03);
    this.voices++;
    src.onended = () => {
      this._release(src);
      try {
        bp.disconnect();
        env.disconnect();
        if (!spatial) own.dispose();
      } catch {
        /* already gone */
      }
    };
    return own;
  }

  /**
   * A bird leaving: wingbeats, and an alarm note if it is close enough to have
   * really been startled.
   *
   * WINGBEATS ARE THE SOUND OF AIR MOVING, so they are low and dull — around
   * 260 Hz, wide, 45 ms each — and they ACCELERATE and then thin out, which is
   * what a small bird's escape actually is: five or six frantic beats to get
   * clear of the branch and then a glide. Playing them evenly spaced sounds like
   * a helicopter.
   */
  flush(position, nearness = 1, voiceIndex = 0) {
    if (!this.built) return;
    const ctx = this.ctx;
    const rng = this.rng;
    const t0 = ctx.currentTime + 0.01;
    const spatial = this._place(position, {
      refDistance: 4,
      rolloff: 1.4,
      maxDistance: 60,
      bus: this.engine.sfxBus,
    });

    let t = t0;
    let gap = 0.115;
    const beats = 5 + Math.floor(rng() * 4);
    for (let i = 0; i < beats; i++) {
      const fade = 1 - i / (beats + 2);
      this._puff(position, t, {
        freq: rngRange(rng, 210, 330),
        q: 0.55,
        decay: 0.05,
        gain: 0.3 * fade * (0.4 + nearness * 0.8),
        rate: rngRange(rng, 0.7, 1.1),
        spatial,
      });
      t += gap;
      // Accelerating, then settling: the gap shrinks toward a steady beat.
      gap = Math.max(0.062, gap * 0.87);
    }
    // A leaf shiver off the branch it just left.
    this._puff(position, t0, {
      freq: 2600,
      q: 0.5,
      decay: 0.22,
      gain: 0.09 * nearness,
      rate: 1.5,
      spatial,
    });
    /**
     * The whump. One puff, an octave and a half below the wingbeats, on the
     * first downstroke only.
     *
     * A bird leaving a branch displaces a surprising slug of air and you feel
     * that more than you hear it — the beats above are at 260 Hz because that
     * is where wings live, but the thing that makes a flush startling is the
     * sub-200 Hz thud underneath the first one. Three nodes, and it is the
     * difference between a rustle and something LEAVING.
     */
    this._puff(position, t0, {
      freq: rngRange(rng, 88, 132),
      q: 0.5,
      decay: 0.11,
      gain: 0.34 * nearness,
      rate: 0.55,
      spatial,
    });
    /**
     * AND IT GOES SOMEWHERE. The panner is ramped up and away over the length
     * of the wingbeat train.
     *
     * `createSpatial` exposes the PannerNode and its position is an AudioParam,
     * so this is three `linearRampToValueAtTime` calls on a node that already
     * exists — no per-frame work, no timer, nothing to tear down. It matters
     * far more than it should: a flush that stays put is a sound effect played
     * at a coordinate, and a flush that recedes and lifts is a bird. The
     * bearing is away from the listener because that is where a frightened one
     * goes, and the eight metres of travel is about what a blackbird covers
     * before it is behind the next trunk.
     */
    const away = Math.atan2(position.x - this.lx, position.z - this.lz);
    const travel = 6 + nearness * 5;
    const arrive = t0 + beats * 0.09 + 0.5;
    if (spatial.panner.positionX) {
      spatial.panner.positionX.linearRampToValueAtTime(
        position.x + Math.sin(away) * travel,
        arrive
      );
      spatial.panner.positionY.linearRampToValueAtTime(position.y + 3.2 + nearness * 2, arrive);
      spatial.panner.positionZ.linearRampToValueAtTime(
        position.z + Math.cos(away) * travel,
        arrive
      );
    }
    /**
     * The alarm call: two or three of the species' HIGHEST note, hammered, with
     * no glide. Real alarm calls are deliberately hard to locate — thin, high
     * and abrupt — and the contrast with the same bird's song thirty seconds
     * earlier is the thing that tells you it is frightened rather than singing.
     */
    if (nearness > 0.35) {
      const voice = VOICES[voiceIndex % VOICES.length];
      const bus = ctx.createGain();
      bus.gain.value = this.songGain * 1.6;
      bus.connect(spatial.input);
      const alarm = { ...voice, decay: 0.05, index: 0.9, glide: -0.3 };
      for (let i = 0; i < 3; i++) {
        this._note(bus, t0 + i * 0.085, voice.root + 14 + rngRange(rng, -1, 1), alarm, 0.42);
      }
      setTimeout(() => {
        try {
          bus.disconnect();
        } catch {
          /* already gone */
        }
      }, 1200);
    }
    setTimeout(() => {
      try {
        spatial.dispose();
      } catch {
        /* already gone */
      }
    }, (t - t0 + 1.4) * 1000);
    this._startle(nearness);
  }

  /**
   * Something bolting through the undergrowth.
   *
   * A twig, then leaves. The twig is the important half: a single very short
   * crack is what makes you turn your head, and it is a 6 ms band-passed puff at
   * about 1.4 kHz — the shortest event in this whole project. The leaves are a
   * scatter of grains over half a second, thinning out, which is the sound of
   * something getting further away rather than of something stopping.
   */
  /**
   * `mass` IS NOT A LOUDNESS, AND SEPARATING THE TWO IS THE POINT OF IT.
   *
   * Before there was a parameter for it, the only way for `fauna.js` to say
   * "this one is big" was to fold mass into `nearness` — which works, in that a
   * fawn does come out quieter, but it says the wrong thing: a quiet bolt is a
   * bolt that happened FURTHER AWAY, so a fawn at five metres read as an adult
   * at thirty rather than as a small animal next to you. Every other cue —
   * where the panner puts it, how much the wood goes quiet afterwards — agreed
   * with the lie.
   *
   * So the two are separate arguments now. `nearness` is distance and only
   * distance; `mass` is the body, and it moves the things a body actually
   * moves: the pitch of the throat, how long the crashing goes on, and how
   * much of a hush it leaves behind. Both call sites in `fauna.js` were passing
   * the product and now pass them apart.
   */
  bolt(position, kind = 'deer', nearness = 1, mass = 1) {
    if (!this.built) return;
    const ctx = this.ctx;
    const rng = this.rng;
    const t0 = ctx.currentTime + 0.01;
    const heavy = kind === 'deer';
    const spatial = this._place(position, {
      refDistance: 6,
      rolloff: 1.3,
      maxDistance: 90,
      bus: this.engine.sfxBus,
    });

    if (rng() < (heavy ? 0.8 : 0.45)) {
      this._puff(position, t0, {
        freq: rngRange(rng, 900, 1900),
        q: 1.1,
        decay: 0.012,
        gain: 0.42 * (0.4 + nearness * 0.7),
        rate: 1,
        spatial,
      });
    }
    /**
     * A heavier animal breaks more sticks on its way out, and it takes longer
     * about it. Both are the same fact and both are cheap: the grain count is
     * what the rustle IS, and stretching the window is what turns a fawn's
     * half-second scuffle into a stag going away through undergrowth.
     */
    const grains = Math.round((heavy ? 14 : 9) * clamp(Math.pow(mass, 0.5), 0.7, 1.35));
    const span = (heavy ? 0.85 : 0.5) * clamp(Math.pow(mass, 0.4), 0.78, 1.25);
    for (let i = 0; i < grains; i++) {
      const k = i / grains;
      this._puff(position, t0 + 0.02 + k * span + rng() * 0.03, {
        freq: rngRange(rng, 1600, 4200) * clamp(Math.pow(mass, -0.22), 0.88, 1.12),
        q: 0.5,
        decay: 0.06,
        gain: 0.16 * (1 - k * 0.75) * (0.4 + nearness * 0.8) * Math.pow(mass, 0.3),
        rate: rngRange(rng, 1.1, 1.9),
        spatial,
      });
    }
    /**
     * WHAT THE ANIMAL SAYS ABOUT IT, which is the half that was missing.
     *
     * The leaves above tell you something ran; they do not tell you what, and
     * the three species in this wood are enormously different about it. A
     * rabbit says nothing at all — it is the silent one, and leaving it silent
     * is what makes the other two mean anything. A squirrel does not run away
     * quietly, it gets somewhere safe and then swears at you for half a minute.
     * A roe deer barks, once or twice, and a roe bark at thirty metres in a
     * wood is genuinely alarming the first time you hear one because it sounds
     * like a dog that should not be there.
     *
     * Both are scheduled AFTER the leaves rather than under them: the animal
     * has to get clear before it complains, and the half-second of gap is what
     * makes the scold read as coming from a different place than the rustle.
     */
    if (kind === 'squirrel' && rng() < 0.75) {
      this._chitter(position, t0 + rngRange(rng, 0.45, 0.9), nearness);
    } else if (heavy && rng() < 0.5) {
      /**
       * Its OWN spatial source, not the bolt's. Three barks a second and a half
       * apart run to four and a half seconds, and this event's panner is torn
       * down at 2.6 — sharing it silently dropped the last two barks, which is
       * the worst kind of bug because the sound that remains is still plausible.
       * A roe also carries much further than a rustle does, so it wants a
       * gentler rolloff than the leaves it is standing in.
       */
      this._bark(position, t0 + rngRange(rng, 0.3, 1.1), nearness, null, mass);
    }
    setTimeout(() => {
      try {
        spatial.dispose();
      } catch {
        /* already gone */
      }
    }, 2600);
    /**
     * The hush scales with the body too, and this is the cue that does the most
     * work for the least code. What stops a wood singing is not how close the
     * thing was, it is how alarming it was — so a stag crashing out at twenty
     * metres silences more of the chorus than a rabbit does at five, and the
     * player never consciously notices the rule, only that the big ones matter.
     */
    this._startle(nearness * 0.8 * clamp(Math.pow(mass, 0.45), 0.72, 1.3));
  }

  /**
   * A voiced noise burst — the crow, the deer bark, and anything else in this
   * wood with a throat rather than a whistle.
   *
   * THIS IS THE ONE PLACE THE HEADER'S RULE LOOKS LIKE IT IS BEING BROKEN, so
   * it is worth being exact about why it is not. A caw is a formant that moves:
   * the mouth opens and the resonance falls, and the obvious way to build that
   * is to sweep a band-pass, which is a resonant sweep, which is the forbidden
   * sound. So no filter parameter is automated here AT ALL. There are two
   * band-passes at fixed frequencies, wide, and the movement is a CROSS-FADE
   * between their two envelopes — the high one is short and at the front, the
   * low one is longer and slightly behind it. The perceived formant slides
   * downward; the spectrum contains nothing that is being swept, because
   * `_puff` is the only thing making sound and `_puff` cannot sweep.
   *
   * It is also why the two calls that use it sound like animals and not like
   * someone saying "shh": what identifies a voice is a pair of resonances in a
   * fixed relationship, and two is enough.
   */
  _throat(position, when, spatial, { high, low, snap = 0.06, tail = 0.2, gain = 0.3, rate = 1 }) {
    this._puff(position, when, {
      freq: high,
      q: 1.0,
      decay: snap,
      gain,
      rate,
      spatial,
    });
    this._puff(position, when + snap * 0.3, {
      freq: low,
      q: 1.1,
      decay: tail,
      gain: gain * 0.85,
      rate: rate * 0.8,
      spatial,
    });
  }

  /**
   * A roe deer's bark.
   *
   * One to three of them, a second or so apart, getting quieter — it is barking
   * as it goes. Low formants and a hard short envelope, plus a 70 ms sine at
   * about 105 Hz under the first one for the chest, which is the difference
   * between a bark and a cough.
   *
   * The long, irregular gap is the whole character. A dog barks in a rhythm; a
   * roe leaves a second and a half of silence between each one, from further
   * away each time, and that silence is what makes you stand still and listen
   * for the next.
   */
  _bark(position, when, nearness = 1, spatial = null, mass = 1) {
    if (!this.built || this.voices > VOICE_CEILING * 0.85) return;
    const ctx = this.ctx;
    const rng = this.rng;
    const own =
      spatial ??
      this._place(position, {
        refDistance: 9,
        rolloff: 1.2,
        maxDistance: 140,
        bus: this.engine.sfxBus,
      });
    /**
     * WHAT MAKES A STAG SOUND LIKE A STAG, AND WHY IT IS ONE NUMBER.
     *
     * A resonance sits at the inverse of the length of the tube making it, and
     * a body's linear size goes as the cube root of its mass, so every formant
     * in this call scales as mass^(-1/3). That is not a stylisation, it is the
     * actual reason a big animal sounds deep, and taking it from real geometry
     * rather than from taste is what keeps a doe and a stag sounding like two
     * sizes of the SAME animal instead of two different species.
     *
     * The exponent is the honest one; the CLAMP is the concession, and only
     * one end of it is doing any work. Mass is `scale^1.6`, and a deer is
     * `[0.86, 1.15]` times its sex's size times 0.6 if it is a juvenile — so
     * the wood runs from a 0.31 fawn to a 1.54 stag. At the top that is 0.8655,
     * six thousandths clear of the floor, which never fires and is there for
     * whoever widens the scale range next. At the BOTTOM the raw value is 1.47,
     * most of a fifth above an adult, which stops sounding like a deer and
     * starts sounding like a dog toy; 1.18 is where it is still a roe.
     *
     * At mass = 1 this is exactly 1 and every number below is the tuned value
     * that was here before, unchanged. That is deliberate: the average animal
     * must sound like it always did, or this stopped being a variation and
     * became a retune.
     */
    const voice = clamp(Math.pow(mass, -1 / 3), 0.86, 1.18);
    /**
     * A big one is not only deeper, it is more insistent — a roe that has
     * decided to tell you about yourself does it three times, and a nervous
     * small one gets out first and barks once from cover. Same rng draw, so a
     * given encounter keeps its character; the mass only shifts the ceiling.
     */
    const barks = 1 + Math.floor(rng() * (mass > 1.08 ? 3.6 : mass < 0.8 ? 2.2 : 3));
    let t = when;
    for (let i = 0; i < barks; i++) {
      const fade = Math.pow(0.72, i);
      this._throat(position, t, own, {
        high: rngRange(rng, 760, 1050) * voice,
        low: rngRange(rng, 280, 380) * voice,
        snap: 0.045,
        tail: 0.14,
        // Mass carries loudness too, but at a third of the pitch exponent: a
        // stag is louder than a doe and nothing like as much louder as it is
        // deeper, and overdoing this was what made the first attempt read as
        // "the deer is closer" rather than "the deer is bigger".
        gain: 0.4 * fade * (0.45 + nearness * 0.75) * Math.pow(mass, 0.33),
        rate: rngRange(rng, 0.85, 1.15),
      });
      if (i === 0) {
        const chest = ctx.createOscillator();
        chest.type = 'sine';
        // The chest tone is the one place the scaling is taken straight, with
        // no clamp: it is a cavity resonance and it is the cue that survives
        // distance, so it is where the size actually lands for a listener.
        chest.frequency.setValueAtTime(rngRange(rng, 112, 138) * Math.pow(mass, -1 / 3), t);
        chest.frequency.exponentialRampToValueAtTime(78 * Math.pow(mass, -1 / 3), t + 0.09);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t);
        env.gain.exponentialRampToValueAtTime(0.22 * this.bodyGain * nearness, t + 0.008);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
        chest.connect(env).connect(own.input);
        chest.start(t);
        chest.stop(t + 0.13);
        this.voices++;
        chest.onended = () => {
          this._release(chest);
          try {
            env.disconnect();
          } catch {
            /* already gone */
          }
        };
      }
      t += rngRange(rng, 0.9, 1.7);
    }
    if (!spatial) {
      const life = (t - ctx.currentTime + 1.2) * 1000;
      setTimeout(() => {
        try {
          own.dispose();
        } catch {
          /* already gone */
        }
      }, life);
    }
  }

  /**
   * A squirrel scolding you from behind a trunk.
   *
   * A fast, ragged train of two-kilohertz ticks with a couple of thin falling
   * whistles laid across it. The RAGGEDNESS is the species: the gaps jitter by
   * nearly a factor of two and the level lurches, so it never settles into a
   * rate — a regular train of ticks at this speed would be a pitch, which is
   * the buzz, and it also would not sound angry. Nothing in nature that is
   * furious about something is metronomic.
   *
   * It fires half a second after the animal has bolted, from where it bolted
   * from, which is the small lie that sells it: the squirrel is already round
   * the back of the tree and the sound is coming from a place you cannot see.
   */
  _chitter(position, when, nearness = 1) {
    if (!this.built || this.voices > VOICE_CEILING * 0.6) return;
    const rng = this.rng;
    const spatial = this._place(position, {
      refDistance: 6,
      rolloff: 1.4,
      maxDistance: 80,
      bus: this.engine.sfxBus,
    });
    const ticks = 9 + Math.floor(rng() * 5);
    let t = when;
    for (let i = 0; i < ticks; i++) {
      this._puff(position, t, {
        freq: rngRange(rng, 1500, 2700),
        q: 1.1,
        decay: 0.022,
        gain: 0.26 * rngRange(rng, 0.5, 1.15) * (0.4 + nearness * 0.8),
        rate: rngRange(rng, 1.2, 1.7),
        spatial,
      });
      t += rngRange(rng, 0.042, 0.088);
    }
    // Two thin descending whistles through the middle of it. A squirrel's
    // scold is not only clicks; there is a reedy note in there and it is what
    // stops the train reading as a woodpecker.
    const bus = this.ctx.createGain();
    bus.gain.value = this.songGain * 1.3 * (0.4 + nearness * 0.8);
    bus.connect(spatial.input);
    const reed = { decay: 0.13, index: 1.4, glide: -3.2, ratio: 1.0 };
    for (let i = 0; i < 2; i++) {
      this._note(bus, when + 0.12 + i * rngRange(rng, 0.22, 0.4), rngRange(rng, 79, 85), reed, 0.3);
    }
    const life = (t - this.ctx.currentTime + 1.4) * 1000;
    setTimeout(() => {
      try {
        bus.disconnect();
        spatial.dispose();
      } catch {
        /* already gone */
      }
    }, life);
  }

  /**
   * A crow, a long way off and above.
   *
   * Two to four caws with uneven gaps, the second usually the loudest. Built
   * out of `_throat`, so it is pure noise through two fixed wide band-passes —
   * a crow really is almost entirely broadband and the reason it sounds harsh
   * is the attack and the formant pair, not any kind of ringing.
   *
   * It exists because it is the only voice here that is not beautiful. Eleven
   * species of whistling songbird plus a woodpecker is a nature documentary; a
   * wood also contains something disagreeable shouting at a distance, and the
   * chorus is more convincing for having one member that is clearly not part
   * of it.
   */
  caw(position) {
    if (!this.built || this.voices > VOICE_CEILING * 0.7) return;
    const rng = this.rng;
    const t0 = this.ctx.currentTime + 0.02;
    const spatial = this._place(position, { refDistance: 16, rolloff: 1.0, maxDistance: 220 });
    const caws = 2 + Math.floor(rng() * 3);
    let t = t0;
    for (let i = 0; i < caws; i++) {
      this._throat(position, t, spatial, {
        high: rngRange(rng, 1250, 1650),
        low: rngRange(rng, 430, 560),
        snap: 0.07,
        tail: rngRange(rng, 0.18, 0.3),
        gain: 0.46 * (i === 1 ? 1 : rngRange(rng, 0.72, 0.92)),
        rate: rngRange(rng, 0.9, 1.2),
      });
      t += rngRange(rng, 0.38, 0.72);
    }
    setTimeout(() => {
      try {
        spatial.dispose();
      } catch {
        /* already gone */
      }
    }, (t - t0 + 1.6) * 1000);
  }

  /**
   * A jay, and the wood's opinion of you.
   *
   * There is already a crow and it is described as the voice here that is not
   * beautiful, so a second harsh bird needs a better argument than "more ugly".
   * It has one, and it is not about the timbre. A CROW IS TALKING TO OTHER
   * CROWS AND A JAY IS TALKING ABOUT YOU. A jay is the alarm system of a
   * European wood — it screams at anything it does not like, everything else
   * within two hundred metres shuts up, and the fact that you can hear one
   * getting further away tells you it has been watching you for a while. That
   * is a completely different piece of information from a rook going home.
   *
   * The sound is the difference too. A caw is two formants and a clean attack;
   * this is a TEAR — twice the length, and built from a `_throat` with three
   * short overlapping puffs laid across it at jittered levels and rates. Those
   * three are the whole trick: they put raggedness into the amplitude of a
   * sound whose spectrum never moves, which reads as a voice under strain
   * without one filter parameter being automated anywhere. Formants sit low, at
   * about 1.4 kHz and 620 Hz, and it stays well down in level, because a jay is
   * genuinely unpleasant and a loud unpleasant thing every ninety seconds is a
   * reason to turn the wood off.
   *
   * `worldBus`, on the crow's precedent: a distant bird on the chorus's own
   * schedule, not an impact.
   */
  jay(position, nearness = 0.6) {
    if (!this.built || this.voices > VOICE_CEILING * 0.65) return;
    const rng = this.rng;
    const t0 = this.ctx.currentTime + 0.02;
    const spatial = this._place(position, { refDistance: 14, rolloff: 1.05, maxDistance: 200 });
    const screams = 2 + Math.floor(rng() * 3);
    let t = t0;
    for (let i = 0; i < screams; i++) {
      const level = 0.3 * (0.55 + nearness * 0.6) * Math.pow(rngRange(rng, 0.82, 1.04), i);
      const length = rngRange(rng, 0.34, 0.52);
      this._throat(position, t, spatial, {
        high: rngRange(rng, 1300, 1560),
        low: rngRange(rng, 560, 690),
        snap: 0.1,
        tail: length,
        gain: level,
        rate: rngRange(rng, 0.86, 1.06),
      });
      // The tear. Three short bursts inside the scream at the same two
      // frequencies, so nothing new appears in the spectrum and the envelope
      // stops being smooth — which is all "harsh" has ever meant here.
      for (let k = 0; k < 3; k++) {
        this._puff(position, t + 0.06 + k * rngRange(rng, 0.06, 0.11), {
          freq: rngRange(rng, 900, 1500),
          q: 1.1,
          decay: rngRange(rng, 0.035, 0.06),
          gain: level * rngRange(rng, 0.3, 0.6),
          rate: rngRange(rng, 0.8, 1.25),
          spatial,
        });
      }
      t += length + rngRange(rng, 0.16, 0.42);
    }
    setTimeout(() => {
      try {
        spatial.dispose();
      } catch {
        /* already gone */
      }
    }, (t - t0 + 1.8) * 1000);
  }

  /**
   * A cock pheasant, which is two sounds and the second one is the good one.
   *
   * The call is a hard double bark — "korrk-KOK", the second louder and a beat
   * behind — and on its own it is a `_throat` with low formants and nothing
   * remarkable about it. What makes a pheasant a pheasant is what follows about
   * a third of a second later: a burst of WING CLAPS, eight or ten of them,
   * fast and mechanical and dying out. It is the only sound in this wood that
   * is percussion produced deliberately by an animal, and it is the reason this
   * bird is here rather than a second corvid — the file has whistles, throats
   * and impacts, and this is the one voice that is a throat and an impact in
   * the same breath.
   *
   * The claps are the flush's wingbeats an octave down and much harder: 130 Hz,
   * 25 ms, no acceleration and no glide out, because a pheasant is not going
   * anywhere. It is standing still, making a noise, and hitting itself.
   */
  pheasant(position) {
    if (!this.built || this.voices > VOICE_CEILING * 0.6) return;
    const rng = this.rng;
    const t0 = this.ctx.currentTime + 0.02;
    const spatial = this._place(position, { refDistance: 12, rolloff: 1.2, maxDistance: 170 });
    for (let i = 0; i < 2; i++) {
      this._throat(position, t0 + i * rngRange(rng, 0.15, 0.21), spatial, {
        high: rngRange(rng, 880, 1120),
        low: rngRange(rng, 330, 430),
        snap: 0.04,
        tail: 0.11,
        gain: 0.34 * (i ? 1.15 : 0.8),
        rate: rngRange(rng, 0.92, 1.1),
      });
    }
    if (rng() < 0.7) {
      const claps = 7 + Math.floor(rng() * 5);
      let t = t0 + rngRange(rng, 0.42, 0.62);
      for (let i = 0; i < claps; i++) {
        this._puff(position, t, {
          freq: rngRange(rng, 110, 165),
          q: 0.5,
          decay: 0.028,
          gain: 0.26 * (1 - i / (claps + 3)),
          rate: 0.5,
          spatial,
        });
        t += rngRange(rng, 0.052, 0.068);
      }
    }
    setTimeout(() => {
      try {
        spatial.dispose();
      } catch {
        /* already gone */
      }
    }, 3000);
  }

  /**
   * A buzzard, and the only voice in this file that comes from the sky.
   *
   * Every other sound here happens somewhere in or under the canopy: the crow
   * is twenty metres up, the woodpecker is on a trunk, the owl is in a tree a
   * hundred metres off. A buzzard is four hundred feet above all of it, out
   * over the open ground, circling — so it is placed at a height nothing else
   * in the file uses and the effect of that alone is worth the twelve nodes.
   * You look UP, which no other event in this wood has ever made anyone do.
   *
   * It is also the simplest voice here: one long plaintive descending cry, two
   * of them a few seconds apart, and a cry is a single note. Six semitones down
   * over most of a second with a soft attack — `_note` with an ad-hoc voice
   * object, the same trick the squirrel's reed uses. There is no phrase, no
   * rhythm and no contour beyond the fall, which is exactly right: a buzzard
   * mew carries for a mile because there is nothing in it.
   */
  mew(position) {
    if (!this.built || this.voices > VOICE_CEILING * 0.7) return;
    const rng = this.rng;
    const t0 = this.ctx.currentTime + 0.05;
    const spatial = this._place(position, { refDistance: 45, rolloff: 0.8, maxDistance: 500 });
    const bus = this.ctx.createGain();
    bus.gain.value = this.songGain * 1.5;
    bus.connect(spatial.input);
    /**
     * `index` 0.3 and falling to nothing, like the cuckoo and the wood pigeon
     * and for the same reason: this is very nearly a pure tone with a catch at
     * the front of it, and any real brightness turns a raptor into a kazoo.
     */
    const cry = { decay: 0.78, index: 0.3, glide: -6, ratio: 1.0 };
    const cries = 1 + Math.floor(rng() * 2);
    let t = t0;
    for (let i = 0; i < cries; i++) {
      _shape.glide = rngRange(rng, 0.85, 1.15);
      _shape.decay = rngRange(rng, 0.9, 1.25);
      _shape.index = 1;
      this._note(bus, t, rngRange(rng, 76, 80), cry, 0.34 * (i ? 0.85 : 1), _shape);
      t += rngRange(rng, 1.9, 3.4);
    }
    setTimeout(() => {
      try {
        bus.disconnect();
        spatial.dispose();
      } catch {
        /* already gone */
      }
    }, (t - t0 + 2.6) * 1000);
  }

  /**
   * Something small coming down through the canopy.
   *
   * An acorn, a bit of dead twig, whatever a squirrel has just dropped. Three
   * or four bright ticks getting lower and further apart as it hits fewer
   * leaves on the way down, and then one dull knock on the litter.
   *
   * TEN NODES, and it is arguably the best value in the file. A wood is mostly
   * silence and the thing that makes silence read as an outdoor place rather
   * than as an audio gap is that it keeps getting interrupted by small physical
   * events that are obviously not addressed to you. A bird call is a
   * performance; an acorn falling is the world carrying on.
   *
   * The panner's Y is ramped down over the descent, so it genuinely arrives
   * from above and lands at your feet. Two AudioParam ramps.
   */
  fall(position) {
    if (!this.built || this.voices > VOICE_CEILING * 0.7) return;
    const rng = this.rng;
    const t0 = this.ctx.currentTime + 0.02;
    const top = position.y + rngRange(rng, 6, 11);
    _fallAt.x = position.x;
    _fallAt.y = top;
    _fallAt.z = position.z;
    const spatial = this._place(_fallAt, {
      refDistance: 5,
      rolloff: 1.5,
      maxDistance: 70,
      bus: this.engine.sfxBus,
    });
    const ticks = 3 + Math.floor(rng() * 3);
    let t = t0;
    let gap = rngRange(rng, 0.07, 0.11);
    for (let i = 0; i < ticks; i++) {
      this._puff(_fallAt, t, {
        freq: rngRange(rng, 1900, 3400) * Math.pow(0.86, i),
        q: 0.6,
        decay: 0.035,
        gain: 0.13 * Math.pow(0.88, i),
        rate: rngRange(rng, 1.3, 1.9),
        spatial,
      });
      t += gap;
      // Further apart on the way down: fewer branches left to hit.
      gap *= rngRange(rng, 1.25, 1.7);
    }
    // The landing. Dull and low, because leaf litter is the deadest surface
    // in the world and an acorn hitting it does not ring at all.
    this._puff(_fallAt, t, {
      freq: rngRange(rng, 190, 330),
      q: 0.7,
      decay: 0.055,
      gain: 0.2,
      rate: 0.7,
      spatial,
    });
    if (spatial.panner.positionY) {
      spatial.panner.positionY.linearRampToValueAtTime(position.y, t);
    }
    setTimeout(() => {
      try {
        spatial.dispose();
      } catch {
        /* already gone */
      }
    }, (t - t0 + 1.2) * 1000);
  }

  /**
   * A fly, going past your ear.
   *
   * A 200 Hz sine with a quiet octave, a shallow FM, and a pitch that will not
   * sit still — and yes, that is a tone in the low two hundreds, which is
   * exactly the register the header spends four paragraphs avoiding. The
   * difference is that here the buzz is the CORRECT ANSWER: a blowfly's wings
   * beat at about two hundred a second and the sound of one is a wandering,
   * unsteady, slightly rough tone. It is not a resonant filter pretending to be
   * an insect. It is an insect.
   *
   * It is kept honest by three things. It is quiet. It lasts under two seconds.
   * And it MOVES — the panner is ramped from six metres out, to about arm's
   * length, and away again, which is why it reads as a fly rather than as a
   * hum: nothing in a mix that arrives, passes and leaves in 1.8 s can be
   * mistaken for a drone. One every couple of minutes at most; two in a row
   * would be a reason to stop playing.
   */
  fly(position) {
    if (!this.built || this.voices > VOICE_CEILING * 0.7) return;
    const ctx = this.ctx;
    const rng = this.rng;
    const t0 = ctx.currentTime + 0.02;
    const length = rngRange(rng, 1.3, 2.1);
    const spatial = this._place(position, {
      refDistance: 1.4,
      rolloff: 1.6,
      maxDistance: 30,
      bus: this.engine.sfxBus,
    });

    const f = rngRange(rng, 178, 245);
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.setValueAtTime(f, t0);
    /**
     * Six pitch waypoints over the pass. A fly's tone jumps when it turns, and
     * a steady one is a mains hum — this is the single parameter that decides
     * whether the whole thing works.
     */
    for (let i = 1; i <= 6; i++) {
      carrier.frequency.linearRampToValueAtTime(
        f * rngRange(rng, 0.84, 1.22),
        t0 + (length * i) / 6
      );
    }
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = f * 2.03;
    const modGain = ctx.createGain();
    modGain.gain.value = f * 0.5;
    mod.connect(modGain).connect(carrier.frequency);

    const env = ctx.createGain();
    // Under the wind, always. A fly you can hear over everything else is a
    // synthesiser note.
    const peak = 0.05 * this.bodyGain;
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(peak, t0 + length * 0.42);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + length);
    carrier.connect(env).connect(spatial.input);

    // In, past, and away. The closest approach is deliberately off to one side
    // rather than at the head, because a fly that flies through you is a bug.
    const side = rng() < 0.5 ? -1 : 1;
    if (spatial.panner.positionX) {
      spatial.panner.positionX.linearRampToValueAtTime(
        this.lx + side * rngRange(rng, 0.5, 1.1),
        t0 + length * 0.45
      );
      spatial.panner.positionZ.linearRampToValueAtTime(this.lz, t0 + length * 0.45);
      spatial.panner.positionY.linearRampToValueAtTime(this.ly, t0 + length * 0.45);
      spatial.panner.positionX.linearRampToValueAtTime(
        this.lx + side * rngRange(rng, 5, 9),
        t0 + length
      );
      spatial.panner.positionZ.linearRampToValueAtTime(
        this.lz + rngRange(rng, -7, 7),
        t0 + length
      );
    }

    carrier.start(t0);
    mod.start(t0);
    carrier.stop(t0 + length + 0.05);
    mod.stop(t0 + length + 0.05);
    this.voices++;
    carrier.onended = () => {
      this._release(carrier);
      try {
        env.disconnect();
        mod.disconnect();
        modGain.disconnect();
        spatial.dispose();
      } catch {
        /* already gone */
      }
    };
  }

  /**
   * One footfall. Dull, short, and quiet — this fires once per half stride for
   * anything running within twenty-six metres, so it has to be cheap and it has
   * to sit under everything else. A deer at a gallop is four of these a second
   * and they are what turn "an animal moved" into "an animal is running".
   */
  hoof(position, kind, speed, mass = 1) {
    if (!this.built || this.voices > VOICE_CEILING * 0.8) return;
    const heavy = kind === 'deer';
    /**
     * A footfall is an impact, not a voice, so it does NOT take the cube-root
     * law above — what sets its pitch is the ground and the foot, and a heavier
     * foot drives the same ground lower and holds it longer. Gentler exponent,
     * tighter clamp, and the decay stretches: measured by ear against the
     * fawn, the pitch alone was not enough and the length is what reads as
     * weight when four of them land in a second.
     */
    const heft = clamp(Math.pow(mass, -0.28), 0.85, 1.2);
    this._puff(position, this.ctx.currentTime + 0.005, {
      freq: (heavy ? rngRange(this.rng, 130, 240) : rngRange(this.rng, 380, 700)) * heft,
      q: 0.8,
      decay: (heavy ? 0.09 : 0.045) * clamp(Math.pow(mass, 0.35), 0.82, 1.22),
      gain: (heavy ? 0.16 : 0.055) * (0.4 + speed * 0.7),
      rate: rngRange(this.rng, 0.8, 1.25),
      bus: this.engine.sfxBus,
    });
  }

  /**
   * A woodpecker's drum.
   *
   * Eighteen strikes in six-tenths of a second, slowing very slightly and dying
   * away. Each strike is two things at once: a wide noise burst for the impact
   * and a 190 Hz sine with a 25 ms decay for the resonance of a hollow trunk.
   * Neither is a filter ringing — the pitch is an oscillator that somebody put
   * there, which is the rule this project runs on.
   *
   * It is worth its complexity because it is the most LOCATABLE sound in a real
   * wood: a drum roll carries three hundred metres and tells you there is a
   * specific tree, in a specific direction, with something on it.
   */
  woodpecker(position) {
    if (!this.built) return;
    const ctx = this.ctx;
    const rng = this.rng;
    const t0 = ctx.currentTime + 0.02;
    const spatial = this._place(position, {
      refDistance: 12,
      rolloff: 1.1,
      maxDistance: 200,
      bus: this.engine.sfxBus,
    });
    const strikes = 15 + Math.floor(rng() * 6);
    let t = t0;
    let gap = 0.031;
    for (let i = 0; i < strikes; i++) {
      const fade = Math.pow(1 - i / strikes, 0.6);
      this._puff(position, t, {
        freq: 2400,
        q: 0.6,
        decay: 0.02,
        gain: 0.2 * fade,
        rate: 1.6,
        spatial,
      });
      const body = ctx.createOscillator();
      body.type = 'sine';
      body.frequency.setValueAtTime(rngRange(rng, 175, 215), t);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.16 * fade * this.bodyGain, t + 0.003);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.028);
      body.connect(env).connect(spatial.input);
      body.start(t);
      body.stop(t + 0.05);
      body.onended = () => {
        try {
          env.disconnect();
        } catch {
          /* already gone */
        }
      };
      t += gap;
      gap *= 1.012;
    }
    setTimeout(() => {
      try {
        spatial.dispose();
      } catch {
        /* already gone */
      }
    }, (t - t0 + 1.6) * 1000);
  }

  /**
   * A tawny owl, a long way off.
   *
   * Two sines an octave apart with a slow scoop up and back down, a very soft
   * attack, and the classic hesitation: a short first hoot, four fifths of a
   * second of nothing, then the long quavering one. The quaver is a 7 Hz
   * amplitude wobble — on the GAIN, not on a filter, because a wobble on a
   * filter cutoff is a resonant sweep and we are not doing that.
   */
  owl(position) {
    if (!this.built) return;
    const ctx = this.ctx;
    const rng = this.rng;
    const t0 = ctx.currentTime + 0.05;
    const root = rngRange(rng, 47, 51);
    const level = this.nightGain;
    if (level < 0.01) return;
    const spatial = this._place(position, { refDistance: 22, rolloff: 0.9, maxDistance: 240 });

    const hoot = (when, length, quaver) => {
      const f = midiToFreq(root);
      const nodes = [];
      // Two partials: the fundamental and a quiet octave. That is genuinely all
      // an owl is — it is nearly a sine, which is why it carries so far.
      for (const [mult, level] of [[1, 1], [2, 0.16], [3, 0.05]]) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f * mult * 0.94, when);
        osc.frequency.linearRampToValueAtTime(f * mult, when + length * 0.3);
        osc.frequency.linearRampToValueAtTime(f * mult * 0.9, when + length);
        const g = ctx.createGain();
        g.gain.value = level;
        osc.connect(g);
        nodes.push({ osc, g });
      }
      // Three partials summing to about 1.2, so this is not the amplitude you
      // hear — it measured at half full scale before the panner at 0.9, which
      // for something that is supposed to be a hundred metres away in the dark
      // is not distant, it is in the room.
      const peak = 0.42 * level;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, when);
      env.gain.exponentialRampToValueAtTime(peak, when + 0.09);
      env.gain.setValueAtTime(peak, when + length * 0.55);
      env.gain.exponentialRampToValueAtTime(0.0001, when + length);
      for (const n of nodes) n.g.connect(env);
      env.connect(spatial.input);

      let wobble = null;
      /**
       * Hoisted out of the `if` so the teardown below can see it.
       *
       * It could not, and the depth gain was the one node in this file that
       * never got disconnected — one per quavering hoot, for the life of the
       * context. Found by counting `createGain` against `disconnect` per call:
       * every other voice balanced at zero and the owl came back with one.
       */
      let depth = null;
      if (quaver) {
        wobble = ctx.createOscillator();
        wobble.type = 'sine';
        wobble.frequency.value = 7.2;
        depth = ctx.createGain();
        depth.gain.value = peak * 0.38;
        wobble.connect(depth).connect(env.gain);
        wobble.start(when + length * 0.3);
        wobble.stop(when + length);
      }
      for (const n of nodes) {
        n.osc.start(when);
        n.osc.stop(when + length + 0.05);
      }
      nodes[0].osc.onended = () => {
        try {
          env.disconnect();
          wobble?.disconnect();
          depth?.disconnect();
          for (const n of nodes) n.g.disconnect();
        } catch {
          /* already gone */
        }
      };
    };

    /**
     * "KEWICK", AND IT IS A SECOND BIRD.
     *
     * The hoot above is the male. The sharp rising shriek everyone thinks is
     * the same owl is the female answering, and "twit-twoo" is not one call at
     * all — it is two tawny owls a field apart, which is a genuinely nicer fact
     * than most of the ones this file gets to use. So it is scheduled as a
     * reply, from its own bearing, a second or two after his: the call-and-
     * answer idea the songbirds already run on, applied to the one voice in the
     * file where the answer is a different sound rather than the same one.
     *
     * A rising glide of nearly an octave over a tenth of a second, with a wide
     * noise puff on the front for the consonant. That puff is the whole
     * character — a kewick has a hard edge on it that a sine cannot produce,
     * and it is thirty milliseconds of pink noise through a band-pass at Q 0.9,
     * which is a brush and not a resonance.
     */
    const kewick = (when) => {
      const a = rng() * Math.PI * 2;
      const r = rngRange(rng, 25, 70);
      _owlAt.x = position.x + Math.cos(a) * r;
      _owlAt.y = position.y + rngRange(rng, -4, 4);
      _owlAt.z = position.z + Math.sin(a) * r;
      const her = this._place(_owlAt, { refDistance: 20, rolloff: 0.95, maxDistance: 240 });
      const bus = ctx.createGain();
      bus.gain.value = level * 0.95;
      bus.connect(her.input);
      const shriek = { decay: 0.19, index: 0.85, glide: 9.5, ratio: 1.0 };
      _shape.glide = rngRange(rng, 0.85, 1.15);
      _shape.decay = rngRange(rng, 0.9, 1.15);
      _shape.index = 1;
      this._note(bus, when, rngRange(rng, 69, 73), shriek, 0.5, _shape);
      this._puff(_owlAt, when, {
        freq: rngRange(rng, 1500, 2100),
        q: 0.9,
        decay: 0.03,
        gain: 0.28 * level,
        rate: 1.3,
        spatial: her,
      });
      setTimeout(() => {
        try {
          bus.disconnect();
          her.dispose();
        } catch {
          /* already gone */
        }
      }, 2600);
    };

    hoot(t0, 0.42, false);
    hoot(t0 + 1.15, 1.15, true);
    // A third of the time she is out there, and once in a while she goes first.
    const reply = rng();
    if (reply < 0.34) kewick(t0 + rngRange(rng, 2.9, 4.4));
    else if (reply > 0.9) kewick(t0 - 0.02);
    setTimeout(() => {
      try {
        spatial.dispose();
      } catch {
        /* already gone */
      }
    }, 4200);
  }

  /**
   * Insects, as the light goes.
   *
   * NOT A TONE. A cricket is very nearly a pure pitch amplitude-modulated at
   * thirty a second, and thirty a second is a buzz by any definition — building
   * it honestly would put the exact artefact this project removed straight back
   * into the mix, and worse, into a continuous bed.
   *
   * So this is a grasshopper instead: six pink-noise grains eight milliseconds
   * apart, brushed, up around 5 kHz. The ear hears a stridulation; the spectrum
   * has no peak in it anywhere. Bursts arrive from random bearings a couple of
   * seconds apart, so what you get is a field of them rather than one insect,
   * which is also what evenings sound like.
   */
  stridulate(position) {
    if (!this.built || this.nightGain < 0.01) return;
    const rng = this.rng;
    const t0 = this.ctx.currentTime + 0.01;
    const spatial = this._place(position, { refDistance: 8, rolloff: 1.6, maxDistance: 60 });
    const grains = 5 + Math.floor(rng() * 4);
    for (let i = 0; i < grains; i++) {
      this._puff(position, t0 + i * rngRange(rng, 0.007, 0.011), {
        freq: rngRange(rng, 4200, 6200),
        q: 1.0,
        decay: 0.012,
        // Divided back out of the body multiplier: this one rides the night
        // curve instead, and it is the only percussive thing here that does.
        // Low, because eight grains land inside eighty milliseconds and it is
        // their sum you hear.
        gain: (0.16 * this.nightGain) / Math.max(this.bodyGain, 1e-3),
        rate: 1.8,
        spatial,
      });
    }
    setTimeout(() => {
      try {
        spatial.dispose();
      } catch {
        /* already gone */
      }
    }, 900);
  }

  /**
   * @param {number} dt
   * @param {object} p
   * @param {number} p.tripLevel 0..1
   * @param {number} p.dark      0..1, how far into the evening it is
   * @param {{x:number,y:number,z:number}} p.listener
   */
  update(dt, { tripLevel = 0, dark = 0, dawn = null, listener } = {}) {
    if (!this.built || !listener) return;
    const rng = this.rng;
    this.tripLevel = tripLevel;
    this.dark = dark;
    // Defaulted from the clock rather than required, so a caller that knows
    // about `dark` and not about `dawn` — every audio harness in scripts/ —
    // still gets the right one instead of a permanent zero.
    this.dawn = dawn === null ? dawnAt() : clamp01(dawn);
    this.lx = listener.x;
    this.ly = listener.y;
    this.lz = listener.z;

    /**
     * THE WOOD GOES QUIET AROUND YOU. `ambience.js` already thins its own chirps
     * as the trip deepens and the reason it gives is the right one — it is a
     * real and slightly eerie thing, and it clears space for the trip's own
     * layers. Song follows the same curve so the two agree, and body
     * deliberately does NOT: close physical sounds carry on at full level while
     * the chorus recedes, which is a stranger combination than either alone.
     */
    this.songGain = 0.26 * (1 - tripLevel * 0.45);
    this.nightGain = 0.3 * dark;

    /**
     * The chorus wave. See WAVE_FAST — this is the multiplier on every interval
     * below except the insects', which are a bed rather than an event and
     * should not breathe with the birds.
     *
     * 0.62 to 2.4. The top end is what buys the silences: at a trough the
     * chorus interval is most of half a minute and a walk through the wood has
     * a stretch in it with nothing but wind and your own feet, which is what
     * makes the next call worth hearing. Tuned by walking around for ten
     * minutes and noticing when it stopped feeling like a soundtrack.
     */
    this.clock += dt;
    const wave = clamp01(
      0.5 + 0.34 * Math.sin(this.clock * WAVE_FAST) + 0.22 * Math.sin(this.clock * WAVE_SLOW + 1.7)
    );
    const spacing = 2.4 - wave * 1.78;
    this._spacing = spacing;

    /**
     * THE SILENCE AFTER A STARTLE.
     *
     * `_hush` is set by `flush` and `bolt`, which already know how close the
     * thing that left was. While it runs, no chorus event is scheduled AND no
     * chorus timer is decremented — the second half matters, because a
     * countdown that kept running would dump three suppressed calls into the
     * same frame the moment it lifted, which is the opposite of the intended
     * effect. When it expires, exactly one bird is scheduled within a second or
     * two: the wood restarting is a stronger moment than the wood stopping was.
     *
     * It covers the SINGERS and nothing else. The insects keep going, the
     * acorns keep falling, the wind and the stream never noticed — because a
     * hush that silenced everything would read as the audio dropping out, and
     * what it has to read as is the birds having seen something.
     */
    if (this._hush > 0) {
      this._hush -= dt;
      if (this._hush <= 0) {
        this._nextDistant = rngRange(rng, 0.6, 2);
        this._nextCall = rngRange(rng, 0.3, 1.4);
      }
      /**
       * ONE ALARM CHIP INSIDE THE SILENCE, occasionally, and it makes the
       * silence better rather than spoiling it.
       *
       * The hush exists so the wood appears to have noticed you, and the
       * temptation is to keep it perfectly empty. But a wood that has just been
       * frightened is not silent — it is a wood with nothing singing in it and
       * something ticking, once, from a direction you did not expect, which is
       * a considerably more alarming state than nothing at all. Rare enough
       * that it happens in maybe one hush in three, short enough that the
       * silence closes over it, and it is the only thing this file schedules
       * DURING the hush rather than after it.
       */
      this._nextCall -= dt;
      if (this._nextCall <= 0) {
        const a = rng() * Math.PI * 2;
        const r = 14 + rng() * 34;
        _callAt.x = listener.x + Math.cos(a) * r;
        _callAt.y = listener.y + rngRange(rng, 1, 8);
        _callAt.z = listener.z + Math.sin(a) * r;
        if (rng() < 0.5) this.call(_callAt, this._pick(r, dark), 'alarm', { gain: 0.75 });
        this._nextCall = rngRange(rng, 3.5, 9);
      }
    } else {
      /**
       * The distant chorus: birds you never see, at the edge of hearing, from
       * every direction. This is the layer that makes the wood feel big — a
       * forest whose only birds are the ones within thirty metres has an edge
       * to it, and you can hear the edge.
       */
      this._nextDistant -= dt;
      if (this._nextDistant <= 0) {
        const a = rng() * Math.PI * 2;
        const r = 45 + rng() * 75;
        _distantAt.x = listener.x + Math.cos(a) * r;
        _distantAt.y = listener.y + rngRange(rng, 2, 12);
        _distantAt.z = listener.z + Math.sin(a) * r;
        // Weighted by the hour and by whether the species throws this far,
        // rather than uniformly over the table. See `_pick`.
        this.song(_distantAt, this._pick(r, dark), {
          answer: rng() < 0.5,
          gain: 0.8,
          throttle: false,
        });
        /**
         * A SECOND CALLER, HALF A SECOND BEHIND, A THIRD OF THE TIME.
         *
         * Not an answer — a different species, from a different bearing, that
         * happens to go off because the first one did. This is where the waves
         * actually come from: the slow envelope decides how often a wave
         * arrives and this decides that a wave is two or three birds rather
         * than one. It goes through `_phrase` and not `song` on purpose, so it
         * cannot pull an answer of its own and start an avalanche.
         */
        if (rng() < 0.34) {
          const b = a + rngRange(rng, 1.1, 5.2);
          const r2 = 40 + rng() * 80;
          _burstAt.x = listener.x + Math.cos(b) * r2;
          _burstAt.y = listener.y + rngRange(rng, 2, 12);
          _burstAt.z = listener.z + Math.sin(b) * r2;
          this._phrase(_burstAt, this._pick(r2, dark), {
            gain: 0.7,
            snap: clamp01((tripLevel - 0.15) / 0.6),
            delay: rngRange(rng, 0.35, 1.6),
          });
        }
        /**
         * Sparse, and sparser during a trip. A continuous dawn chorus reads as
         * a stock sound effect within about fifteen seconds.
         *
         * EXCEPT AT DAWN, WHICH IS THE HOUR THAT SENTENCE WAS WRITTEN WITHOUT.
         * The interval is divided by up to 3.2 for the ninety minutes after
         * sunrise, so the wood goes from a call every eight seconds to a call
         * every two and a half — and then, over about four minutes of world
         * time, back. Getting up early and hearing the difference is the single
         * best thing the clock buys the audio, and it is one divisor.
         *
         * The dusk end deliberately does NOT get the same treatment. `dark`
         * multiplies the interval by up to 3.5, so evening thins out, and the
         * roster's own windows mean what is left is blackbirds, then a robin,
         * then a nightingale and an owl. A wood going quiet is a better use of
         * dusk than a second chorus.
         */
        this._nextDistant =
          (rngRange(rng, 3.4, 11) * spacing * (1 + tripLevel * 1.4) * (1 + dark * 2.5)) /
          (1 + this.dawn * 2.2);
      }

      this._nextWoodpecker -= dt;
      if (this._nextWoodpecker <= 0) {
        const a = rng() * Math.PI * 2;
        const r = 30 + rng() * 90;
        _distantAt.x = listener.x + Math.cos(a) * r;
        _distantAt.y = listener.y + rngRange(rng, 4, 11);
        _distantAt.z = listener.z + Math.sin(a) * r;
        this.woodpecker(_distantAt);
        this._nextWoodpecker = rngRange(rng, 26, 85) * (1 + dark * 3);
      }

      /**
       * The crow. Far, high, and only while there is light — corvids are at the
       * roost before the owl starts, so the two never overlap, which is worth
       * more than either of them alone: the moment you notice the crows have
       * stopped is the moment the wood has actually changed.
       */
      if (dark < 0.62) {
        this._nextCrow -= dt;
        if (this._nextCrow <= 0) {
          const a = rng() * Math.PI * 2;
          const r = 45 + rng() * 85;
          _distantAt.x = listener.x + Math.cos(a) * r;
          _distantAt.y = listener.y + rngRange(rng, 8, 22);
          _distantAt.z = listener.z + Math.sin(a) * r;
          this.caw(_distantAt);
          this._nextCrow = rngRange(rng, 55, 165) * spacing;
        }
      }

      /**
       * THE CHATTER, and it is the only timer in this block measured in
       * seconds rather than in minutes.
       *
       * Everything above is an event. This is the connective tissue: two notes
       * from a bird that is not singing, three or four times a minute, from ten
       * to sixty metres out. It is deliberately NOT held to the chorus wave the
       * way a song is — `Math.sqrt(spacing)` means the troughs get somewhat
       * fewer of these and never none, because the wave is about SONG. A lull
       * with two ticks in it is still unmistakably a lull; a lull with nothing
       * whatsoever in it for forty seconds is where the listener starts
       * wondering whether the audio has stopped, and the whole reason the wave
       * can be as deep as it is now is that these keep the floor alive.
       *
       * The kind is rolled rather than chosen. Contact is most of it because
       * contact is most of a wood; the juvenile is rare and clustered to
       * daylight because a fledgling begging at ten at night is a different and
       * much sadder sound than the one intended.
       */
      this._nextCall -= dt;
      if (this._nextCall <= 0) {
        const a = rng() * Math.PI * 2;
        const r = 10 + rng() * 52;
        _callAt.x = listener.x + Math.cos(a) * r;
        _callAt.y = listener.y + rngRange(rng, 0.5, 9);
        _callAt.z = listener.z + Math.sin(a) * r;
        const roll = rng();
        let kind = 'contact';
        if (roll > 0.93) kind = 'alarm';
        else if (roll > 0.82) kind = 'flight';
        else if (roll > 0.76 && dark < 0.4) kind = 'beg';
        this.call(_callAt, this._pick(r, dark), kind, { gain: 0.9 });
        this._nextCall =
          (rngRange(rng, 2.2, 7) * Math.sqrt(spacing) * (1 + dark * 2.2)) / (1 + this.dawn * 1.6);
      }

      /**
       * The jay, the pheasant and the buzzard, which share a block because they
       * share a job: they are the three voices that are not part of the chorus
       * and do not sound like it.
       *
       * All three are rare on purpose and all three are rarer than they feel,
       * because each is the only thing of its kind. A jay every ninety seconds
       * is not a wood with jays in it, it is a wood with a jay problem.
       *
       *   The JAY thins out toward dark but does not stop where the crow does,
       *   because a jay will scream at a tawny owl at dusk and that is arguably
       *   the most characteristic thing it does.
       *
       *   The PHEASANT is a dawn and dusk bird almost exclusively, so its
       *   interval is divided by both — the one voice here that is commoner in
       *   the last hour of light than in the middle of the day.
       *
       *   The BUZZARD needs thermals, which means it needs sun, so it is
       *   daylight only and it is placed higher than anything else in the file
       *   by a factor of five.
       */
      if (dark < 0.78) {
        this._nextJay -= dt;
        if (this._nextJay <= 0) {
          const a = rng() * Math.PI * 2;
          const r = 35 + rng() * 90;
          _distantAt.x = listener.x + Math.cos(a) * r;
          _distantAt.y = listener.y + rngRange(rng, 3, 14);
          _distantAt.z = listener.z + Math.sin(a) * r;
          this.jay(_distantAt, clamp01(1 - r / 140));
          this._nextJay = rngRange(rng, 70, 210) * spacing * (1 + dark);
        }
      }

      this._nextPheasant -= dt;
      if (this._nextPheasant <= 0) {
        const a = rng() * Math.PI * 2;
        const r = 40 + rng() * 80;
        _distantAt.x = listener.x + Math.cos(a) * r;
        _distantAt.y = listener.y - 1.2;
        _distantAt.z = listener.z + Math.sin(a) * r;
        this.pheasant(_distantAt);
        // Loudest at the two ends of the day. `dusk` peaks where `dark` is
        // halfway, which is the hour a pheasant goes up to roost shouting.
        const dusk = 1 - Math.abs(dark - 0.5) * 2;
        this._nextPheasant = (rngRange(rng, 100, 280) * spacing) / (1 + this.dawn * 1.5 + dusk);
      }

      if (dark < 0.35) {
        this._nextBuzzard -= dt;
        if (this._nextBuzzard <= 0) {
          const a = rng() * Math.PI * 2;
          const r = 50 + rng() * 130;
          _distantAt.x = listener.x + Math.cos(a) * r;
          _distantAt.y = listener.y + rngRange(rng, 55, 110);
          _distantAt.z = listener.z + Math.sin(a) * r;
          this.mew(_distantAt);
          this._nextBuzzard = rngRange(rng, 130, 340) * spacing;
        }
      }
    }

    /**
     * Something falling out of the canopy, close enough to make you look up.
     *
     * Deliberately NOT on the chorus wave's schedule and deliberately not
     * suppressed by anything: gravity does not care whether the birds are
     * singing, and an acorn landing in the middle of a lull is the best
     * possible use of that lull.
     */
    this._nextFall -= dt;
    if (this._nextFall <= 0) {
      const a = rng() * Math.PI * 2;
      const r = 4 + rng() * 16;
      _distantAt.x = listener.x + Math.cos(a) * r;
      _distantAt.y = listener.y - 1.5;
      _distantAt.z = listener.z + Math.sin(a) * r;
      this.fall(_distantAt);
      this._nextFall = rngRange(rng, 26, 88);
    }

    /**
     * A fly. Daylight only, sober only, and rare.
     *
     * The trip gate is not squeamishness about the tone — it is that a fly
     * around your head while everything else has gone strange is a
     * fingers-on-skin sensation the rest of the design is not trying to
     * produce, and it competes directly with the trip's own close layers.
     */
    if (dark < 0.45 && tripLevel < 0.7) {
      this._nextFly -= dt;
      if (this._nextFly <= 0) {
        const a = rng() * Math.PI * 2;
        _distantAt.x = listener.x + Math.cos(a) * 6;
        _distantAt.y = listener.y + rngRange(rng, -0.4, 0.4);
        _distantAt.z = listener.z + Math.sin(a) * 6;
        this.fly(_distantAt);
        this._nextFly = rngRange(rng, 75, 200);
      }
    }

    if (dark > 0.25) {
      this._nextOwl -= dt;
      if (this._nextOwl <= 0) {
        const a = rng() * Math.PI * 2;
        const r = 70 + rng() * 90;
        _distantAt.x = listener.x + Math.cos(a) * r;
        _distantAt.y = listener.y + rngRange(rng, 6, 16);
        _distantAt.z = listener.z + Math.sin(a) * r;
        this.owl(_distantAt);
        this._nextOwl = rngRange(rng, 22, 70);
      }
      this._nextInsect -= dt;
      if (this._nextInsect <= 0) {
        const a = rng() * Math.PI * 2;
        const r = 5 + rng() * 30;
        _distantAt.x = listener.x + Math.cos(a) * r;
        _distantAt.y = listener.y - 1.2;
        _distantAt.z = listener.z + Math.sin(a) * r;
        this.stridulate(_distantAt);
        this._nextInsect = rngRange(rng, 0.5, 2.6) / clamp(dark, 0.2, 1);
      }
    }
  }

  /**
   * Almost nothing persistent to tear down — every node that makes a sound in
   * this file belongs to one event and disconnects itself when that event's
   * source ends. The flag is what stops new ones being scheduled.
   *
   * The exception is the far tail, which is fifteen static nodes with a delay
   * line in them. Left connected they would go on running for the life of the
   * context, which matters here more than it looks: `dispose` is what a level
   * teardown calls, and a second Wildlife built afterwards would add fifteen
   * more and feed both.
   */
  dispose() {
    this.built = false;
    /**
     * A pump in flight will see `built` false on its next tick and give its
     * stream back on its own, so this is not a leak — but `build()` can be
     * called again on the same instance, and between the two the counter would
     * read one and refuse the first skylark of the new wood for no reason
     * anybody could ever have diagnosed. One line, and the state is exactly
     * what a fresh instance's is.
     */
    this._streams = 0;
    for (const n of this.farParts ?? []) {
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.farParts = null;
    this.farBus = null;
  }
}

/**
 * Hoisted. These are handed straight to `createSpatial`, which copies the
 * numbers out into AudioParams and does not keep the object — so one shared
 * scratch per purpose is safe and the scheduler allocates nothing per event.
 *
 * One per PURPOSE and not one shared: `_burstAt` exists because the second
 * caller in a chorus wave is chosen inside the block that has just written
 * `_distantAt`, and a single scratch there would have placed both birds at the
 * same coordinate — which is precisely the effect the second caller exists to
 * avoid.
 */
const _answerAt = { x: 0, y: 0, z: 0 };
const _distantAt = { x: 0, y: 0, z: 0 };
const _burstAt = { x: 0, y: 0, z: 0 };
const _fallAt = { x: 0, y: 0, z: 0 };
const _callAt = { x: 0, y: 0, z: 0 };
const _owlAt = { x: 0, y: 0, z: 0 };

/**
 * The per-note scale factors, and the do-nothing one.
 *
 * Same argument as the coordinates above, with one extra condition that has to
 * hold: `_note` reads all three fields in its first four lines and never looks
 * at the object again, so a single scratch is safe however many notes are
 * scheduled in a turn. If anything in `_note` ever defers a read of `shape`
 * past the first `await` or callback it does not currently have, this becomes
 * the worst kind of bug — every note in the phrase silently taking the LAST
 * note's timbre.
 *
 * `_flatShape` is frozen because it is the default parameter for every caller
 * that does not care, and a default parameter that can be written through is a
 * global variable with extra steps.
 */
const _shape = { glide: 1, decay: 1, index: 1 };
const _flatShape = Object.freeze({ glide: 1, decay: 1, index: 1 });
