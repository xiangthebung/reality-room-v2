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
 *   - the voice is one sine carrier, FM'd by another sine at a low CONSTANT
 *     index. It cannot buzz; there is nothing in it to buzz with.
 *   - the character is in the PITCH CONTOUR, at two scales. Between notes: an
 *     antbird is an accelerating rising cascade that tightens into a rattle; a
 *     trogon is nine identical hollow notes at a metronomic 4 Hz; a woodcreeper
 *     is twenty notes falling downhill and slowing all the way. And WITHIN one
 *     note: see `arc`. Play those contours on the same sine and they are
 *     instantly different birds. Play a beautiful timbre on a flat contour and
 *     it is a synthesiser.
 *
 * THE TWO WAYS THAT WENT WRONG ANYWAY, both fixed, both worth keeping written
 * down because the file argued itself into them while believing the paragraph
 * above.
 *
 *   IT SOUNDED LIKE A XYLOPHONE. The original note was a spectral flash that
 *   collapsed to a sine over the first two thirds of its length, on a six
 *   millisecond attack, with no plateau. That is not a description of a
 *   whistle, it is the standard recipe for a struck wooden bar, and it was
 *   arrived at by reasoning about what a bird is NOT — not a rasp, not a filter
 *   sweep — until what was left was a mallet. "The modulation index reaches
 *   zero" is a true sentence about a marimba. See `_note`, which now holds the
 *   index roughly still and puts the movement in the pitch instead.
 *
 *   IT WAS AN OCTAVE AND A HALF TOO LOW. Every root in the table was set by ear
 *   against the two rows that happen to be genuinely low-pitched birds — the
 *   cuckoo at 600 Hz and the wood pigeon at 500 — so the whole roster ended up
 *   in the middle of a piano. Real songbirds live between about 1.8 and 8 kHz:
 *   blackbird song motifs peak at 1.8-1.9 kHz against the old 523, and robin
 *   song has its mean maximum at 3738 Hz against the old 1047. Being in the
 *   wrong octave is most of what made them read as an instrument, because that
 *   register is where instruments are and birds are not.
 *
 *   THE RAINFOREST ROSTER GOES BACK DOWN THERE ON PURPOSE, WHICH IS NOT THE
 *   SAME MISTAKE. Six of the twenty rows below sit under 1 kHz because the
 *   birds do — a motmot hoots at 392 Hz, a toucan croaks at 587 — and they
 *   survive it the way the wood pigeon always did: a near-zero modulation index
 *   and a long decay, so the note is a hoot instead of a strike. The thing to
 *   watch for is not a low row, it is a low row with a bright index on it.
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
 *   trip closes the canopy over you the honeycreepers and the tanagers drop out
 *   and the motmots, the solitaires and — eventually — a tinamou, a potoo and
 *   an owl take over. Nothing is switched on or off; the roster leans. It is the single
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
 * The voices that are NOT whistles follow the same rule — nothing rings. A
 * macaw, a parrot flock and a barking deer are noise bursts through two static
 * wide band-passes whose envelopes cross-fade, which is a formant moving
 * without a single filter parameter ever being automated; a squirrel's scold is
 * a train of 2 kHz ticks; a fruit coming down out of the canopy is four ticks
 * and a knock with the panner falling.
 *
 * THAT SPLIT IS ALSO WHERE THE RAINFOREST'S HARSH BIRDS LIVE, and it is why the
 * table below contains no macaw. A macaw screech, a parrot mob and a guan's
 * cackle are broadband noise, and running them through the FM path would mean
 * an index high enough to make sidebands — which is the one sound this file
 * exists to refuse. They are `_throat` and `_puff` voices, further down.
 *
 * WHICH BUS, AND WHERE THE LINE IS.
 *
 * `engine.js` describes `worldBus` as the continuous properties of the place
 * and `sfxBus` as discrete events, and the split here follows one test: WOULD A
 * PLAYER TURNING THIS DOWN BE TRYING TO QUIETEN THE WOOD, OR TO STOP BEING
 * INTERRUPTED?
 *
 *   worldBus — song, the distant chorus, the macaws, the owl, the insects.
 *   These are voices carrying from somewhere else, they are not addressed to
 *   you, and they are what "the sound of the forest" means. The macaw pair is
 *   on this side despite being the least melodic thing in the file, because it
 *   is a bird calling at a distance on the chorus's own schedule, not an impact.
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
 * than mood: a motmot and a solitaire are calling in the dark, the pihas and the
 * oropendolas come in around sunrise, the toucans and aracaris start up in the
 * canopy after that, and the small understorey birds do not trouble themselves
 * until it is properly light. It multiplies into `_pick` scaled by `dawn`, so it
 * is exactly 1 at the pinned automation hour and moves nothing any stored
 * expectation ever measured.
 *
 * AND THEN THE WHOLE ROSTER MOVED CONTINENTS, which is the pass this file is in
 * now. Twenty temperate voices became twenty Neotropical ones — see the block
 * above `VOICES` for what that does to the register, the repetition and the
 * carry — and the four set-piece voices that are not in the table moved with
 * them: the crow became a pair of macaws, the jay a mob of parrots, the
 * pheasant a guan, the buzzard a hawk-eagle. Nothing about the machinery
 * changed, which is the useful part of the exercise: every field in the table
 * turned out to describe a bird rather than a British bird.
 */

/**
 * THE ROSTER IS A RAINFOREST, AND THAT CHANGES WHERE THE NUMBERS SIT.
 *
 * This table was twenty birds out of a British wood — warblers, finches and
 * thrushes, which is a roster of small high whistlers living between about 1.8
 * and 8 kHz. A lowland rainforest is not that. It is louder, lower, slower and
 * far more varied: the loudest birds on earth are in it, so are some of the
 * lowest-pitched, and the thing that identifies most of them is a single
 * repeated shape rather than a tumbling phrase.
 *
 * Three consequences, and all three are visible in the columns.
 *
 *   THE REGISTER SPREADS DOWNWARD AND THE OLD WARNING STILL APPLIES. Half this
 *   roster genuinely lives below 1 kHz — a motmot hoots at 400 Hz, a toucan
 *   croaks at 590, a trogon calls at 700 — which is exactly the register the
 *   retune moved everything OUT of, because it is where instruments are. The
 *   difference is that these rows are down there for a measured reason rather
 *   than by ear, and they carry the two things that stop a low note being a
 *   struck bar: a near-zero modulation index and a long decay with a hold in
 *   it. That is the wood pigeon's recipe, and the wood pigeon was always one of
 *   the two rows the old table had right. What must NOT happen is a small bird
 *   drifting down here; the tanagers, the honeycreeper and the hermit are at
 *   101 to 107 and belong there.
 *
 *   REPETITION IS THE SPECIES, far more than in a temperate wood. A screaming
 *   piha, a bellbird, a trogon and a potoo are each ONE idea repeated with
 *   enormous spaces in it, and the field that carries that is `unit` — six rows
 *   here refuse to be cut at all, against two in the old table.
 *
 *   NOTHING RASPS, STILL. A macaw, a toucan's croak and a guan's cackle are all
 *   genuinely noisy sounds and not one of them is in this table: they are built
 *   out of `_throat` and `_puff` further down the file, which is where noise
 *   belongs. What is here is whistles, hoots and bells, and the roughness the
 *   croakers need arrives as a fast shallow warble — the wren's old rattle
 *   trick — rather than as modulation index.
 *
 * `root` is where the voice sits, in MIDI. `notes` are semitone offsets from
 * it, `gaps` the seconds between them; both are cycled if one runs out, which
 * is what lets a woodcreeper be forty notes described by eight numbers.
 *
 * THE THREE THAT SHAPE A NOTE FROM THE INSIDE. Between them they are the
 * difference between a bird and a tune played on something, and they matter
 * more than any other field here.
 *
 * `arc` is the pitch contour WITHIN one note, as semitone offsets spread evenly
 * across its length. This is the important one: a piha's scream leaps most of
 * an octave and falls off a cliff inside a single note, a tinamou's whistle
 * swells and sags, a motmot's hoot barely moves. A note that holds still for
 * its whole duration is a tuned bar however good its envelope is.
 *
 * `glide` is where the note ENDS UP relative to where it started, in semitones,
 * added on top of the arc.
 *
 * `lead` is the onset: how far below pitch the note starts before snapping up,
 * in semitones. A syrinx coming under tension does this and it is what
 * articulates a note now that there is no percussive flash at the front. High
 * for the shouted voices — a kiskadee, an aracari's shriek — and low for the
 * ones that arrive on their note rather than hitting it, which is the motmot,
 * the potoo and the tinamou. Defaults to 1.4.
 *
 * `warble` and `warbleDepth` are vibrato, in hertz and semitones. Shallow
 * everywhere: at these depths it is a warble on a whistle, and deep or fast it
 * would be sidebands, which is the rasp this file exists to avoid. The two
 * exceptions are deliberate and they are the two croakers — the toucan's 17 Hz
 * and the manakin's 21 Hz sit at the edge where a wobble becomes a roughness,
 * because that roughness IS those species.
 *
 * `index` is the FM modulation depth, and it is roughly CONSTANT across a note
 * rather than collapsing — a timbre instead of a strike. Everything is under
 * 2.2: past about three an FM pair starts producing sidebands dense enough to
 * read as a rasp.
 *
 * THE FOUR NUMBERS THAT SHAPE A PHRASE RATHER THAN A NOTE, all optional and all
 * defaulting to the value that means "do nothing".
 *
 * `fade` is the gain the last note reaches relative to the first, interpolated
 * geometrically. A potoo at 0.3 is a series that dies away into the dark, which
 * is the entire bird; a piha at 2.6 is an explosion, and geometric
 * interpolation is the right kind because it back-loads.
 *
 * `pure` is the same idea applied to `index`: the modulation depth at the last
 * note relative to the first.
 *
 * `hold` multiplies the decay of the FINAL note, and the glide of that note by
 * its square root so a long note also falls further. It is the oropendola's
 * final whoop and the antshrike's growl.
 *
 * `tail` is how many notes at the end are the ENDING. See `_phrase`: a
 * shortened rendition drops notes out of the middle and keeps these. It also
 * doubles as the flag for whether a phrase may be run LONG, since a phrase with
 * an ending cannot be, and for whether a note may be dropped from it.
 *
 * `unit` is the size of the repeating group, for the rows that have one, and it
 * is the other half of making the length vary safely. A trogon is a series and
 * may be any length; a kiskadee is three syllables and is `unit: 3`, which is
 * this field's way of saying you never hear "kis-ka".
 *
 * `stream` is a length in SECONDS rather than a count of notes, and it is the
 * musician wren and only the musician wren. A row that has it is not a phrase,
 * it is a stretch of time full of notes, and it is scheduled a little at a time
 * instead of all at once. See STREAM_AHEAD and `_phrase`.
 *
 * THE FIVE FIELDS THAT ARE NOT ABOUT THE SOUND.
 *
 * `active` is the window of `dark` — 0 full daylight, 1 night — inside which
 * this one is singing, and it fades over 0.18 either side rather than
 * switching. A rainforest uses more of this range than a wood does: it has a
 * ferocious dawn, a genuine midday lull nothing here models yet, a second peak
 * at dusk, and then a night shift that is a different set of animals rather
 * than an absence. The potoo and the tinamou are the two with a FLOOR, and
 * between them they are why the floor exists.
 *
 * `carry` is how far the voice is worth hearing, in metres. It is not a volume —
 * it biases the chorus's choice by distance, so a call scheduled at 200 m is a
 * piha or a bellbird and never a honeycreeper. The numbers here run much higher
 * than the old table's because the birds do: a three-wattled bellbird is the
 * loudest bird ever measured and a screaming piha is not far behind it.
 *
 * `rare` is the thumb on the scale. A bellbird at 0.45 turns up about half as
 * often as a kiskadee, because a bellbird every thirty seconds stops being an
 * event within two minutes.
 *
 * `early` is the dawn running order, and it is the one field here that is pure
 * observation. A rainforest does not simply get louder at first light, it fills
 * up in a SEQUENCE: tinamous and motmots hooting in what is still the dark, the
 * pihas and the oropendolas as it comes up, the toucans and aracaris after
 * that, and the small canopy birds not until it is properly light.
 *
 * `call` is what the bird says when it is NOT singing, as semitone offsets from
 * the same root. It is one to three numbers and it is the second most
 * recognisable thing about most of these species. `call` also seeds the alarm,
 * the flight call and the juvenile, which are the same note moved and
 * re-rhythmed; see `call()`.
 *
 * `size` is body length in centimetres and makes no sound at all. It is here
 * because something has to draw these birds and the only place the roster is
 * written down is this table — see `voiceInfo`. It matters more than it used
 * to: this roster averages 27 cm against the old one's 17, and the thing a
 * player actually reported about the old wood is that they could hear birds
 * and never spot one.
 */
const VOICES = [
  {
    /**
     * A screaming piha, which is the sound people mean when they say
     * "rainforest" and do not know it. Two small introductory notes and then an
     * explosion: a leap of most of an octave, held for a fraction of a second,
     * and dropped off a cliff. It is the loudest thing in this table and one of
     * the loudest birds alive.
     *
     * `arc` is doing nearly all of it. Up two semitones, up three more, then
     * down six and a half INSIDE ONE NOTE — that swoop is the whole species,
     * and without it this row is four notes anybody could have produced. The
     * `fade` of 2.6 is the other half: the first two notes are a fifth of the
     * volume of the third, which is why the third one makes you jump.
     */
    name: 'piha',
    // Measured piha calls put their energy around 2.5-3 kHz with the peak of
    // the scream just under 3. 99 is 2489 Hz and the arc takes the top of it
    // to about 4.5 kHz, which is the bird.
    root: 99,
    ratio: 1.0,
    index: 0.55,
    decay: 0.19,
    notes: [-7, -3, 12, 5],
    gaps: [0.27, 0.34, 0.17],
    glide: -1.2,
    arc: [2.2, 3.4, -6.5],
    lead: 1.5,
    fade: 2.6,
    hold: 1.4,
    // The scream and the note it falls onto. Everything before them is a
    // preamble, and a piha that got cut short would be the preamble.
    tail: 2,
    unit: 2,
    // 0.45 and not 1.0, which is the level this row was written at. It is the
    // loudest bird in the forest and it also carries `fade: 2.6`, so a level of
    // one produced a note two and a half times louder than anything the old
    // table could make and put the combined row over the jukebox. See
    // `fauna-audio.mjs`. What you hear is level x fade, and that is now 1.17.
    level: 0.45,
    active: [0, 0.55],
    // Two hundred and sixty metres is not a guess. A piha is audible most of a
    // kilometre through closed forest and this is the number that keeps it in
    // the distant chorus at every radius the chorus uses.
    carry: 260,
    // The commonest sound in the wood, and the one row above 1.
    rare: 1.3,
    early: 1.4,
    call: [0],
    size: 25,
  },
  {
    /**
     * A three-wattled bellbird: a single metallic BONK, and then — from the
     * same bird, a beat later — a thin whistle that slides away underneath it.
     * Nothing else in this table is two such different sounds in one phrase.
     *
     * THIS IS THE ONE ROW THAT IS ALLOWED TO RING, and the exception needs
     * stating because the rest of the file exists to stop exactly that. A
     * bellbird is not a metaphor: it is a hammered, clanging, almost
     * electronic noise, and the reason it does not come out as a marimba is the
     * envelope rather than the spectrum. The decay is 0.09 with a hard 2.4
     * lead, so it is a CLANG — an onset and nothing after it — where a mallet
     * is an onset and a long ringing tail. The tail here belongs to the second
     * note, which is a whistle, which is a different sound and is the point.
     */
    name: 'bellbird',
    // Around 5 kHz. It is the highest-pitched loud voice in the wood and that
    // combination is what makes it carry through leaves.
    root: 111,
    ratio: 1.0,
    index: 0.9,
    decay: 0.09,
    notes: [0, -15],
    gaps: [0.86],
    glide: -0.8,
    arc: [0.4, -1.3],
    lead: 2.4,
    // The whistle. Three times the length of the clang and it falls a fifth
    // further for it, which is what `hold` does to the glide.
    hold: 3.0,
    unit: 2,
    level: 0.8,
    active: [0, 0.5],
    // The loudest bird ever measured. This is the longest carry in the table
    // and it is still an underestimate.
    carry: 300,
    rare: 0.45,
    early: 0.8,
    call: [0],
    size: 30,
  },
  {
    /**
     * A Montezuma oropendola, and the best argument in this table for `hold`
     * and `glide` existing at all.
     *
     * The song is a liquid gurgle that accelerates, climbs most of two octaves,
     * and ends in a long upward whoop that sounds like water going down a drain
     * backwards. It is the single most improbable noise in a Neotropical
     * forest and it is four numbers: a rising `notes` line, gaps that get
     * LONGER rather than shorter, a `fade` that crescendos into the whoop, and
     * a `hold` of 3.2 on the last note — which by way of the square-root rule
     * also drags that note's glide up nearly six semitones on its own.
     */
    name: 'oropendola',
    // The gurgle starts around 700 Hz and the whoop finishes above 3 kHz.
    root: 78,
    ratio: 1.0,
    index: 0.7,
    decay: 0.15,
    notes: [0, 0, 2, 5, 9, 14, 21],
    gaps: [0.13, 0.15, 0.19, 0.24, 0.31, 0.4],
    glide: 3.2,
    arc: [1.4, 3.2],
    // Liquid. This is the warble doing what the nightingale's used to.
    warble: 7,
    warbleDepth: 0.22,
    lead: 0.8,
    fade: 2.2,
    hold: 3.2,
    tail: 1,
    level: 0.5,
    active: [0, 0.45],
    carry: 200,
    rare: 0.75,
    early: 1.5,
    call: [-7],
    size: 47,
  },
  {
    /**
     * A resplendent quetzal. Soft, mellow, slurred pairs — "keow, ko-week" —
     * and after the piha and the bellbird it is a shock how quiet the most
     * famous bird in the forest actually is.
     *
     * A low index and a long decay make it mellow; the arc makes it slurred.
     * Every note bends up two and a half semitones and then sags three, which
     * is a whimper, and it is the only voice here that sounds uncertain.
     */
    name: 'quetzal',
    // Around 1 kHz, which for a bird this size is about right and is well
    // below the small-bird band this file usually defends.
    root: 84,
    ratio: 1.0,
    index: 0.3,
    decay: 0.3,
    notes: [0, 5, 0, 7],
    gaps: [0.33, 0.62, 0.33],
    glide: -1.4,
    arc: [2.5, -1.5, -3.0],
    warble: 5.5,
    warbleDepth: 0.18,
    lead: 0.7,
    level: 0.6,
    active: [0, 0.5],
    carry: 120,
    rare: 0.7,
    unit: 2,
    early: 1.2,
    call: [-5],
    size: 40,
  },
  {
    /**
     * A turquoise-browed motmot: a low, hollow, owl-like double hoot from deep
     * shade, and the lowest voice in the table by a fourth.
     *
     * IT IS DOWN HERE ON PURPOSE AND IT IS THE ROW MOST LIKELY TO BE "FIXED" BY
     * SOMEBODY WHO HAS READ THE HEADER AND NOT THIS. A motmot really does call
     * at about 400 Hz — it is the wood pigeon of this roster — and it survives
     * being there for the wood pigeon's two reasons: an index of 0.14, which is
     * very nearly a pure sine, and a decay of 0.4, which is long enough that
     * the note is a hoot rather than a strike. Raise the index and this becomes
     * a marimba immediately.
     */
    name: 'motmot',
    // 392 Hz.
    root: 67,
    ratio: 1.0,
    index: 0.2,
    decay: 0.4,
    notes: [0, 0],
    gaps: [0.21],
    glide: -0.5,
    arc: [0.6, 0.2, -0.6],
    warble: 5,
    warbleDepth: 0.1,
    lead: 0.5,
    level: 0.75,
    // Hooting in the half dark at both ends of the day, and it is one of the
    // last things still going after the canopy birds have stopped.
    active: [0, 0.68],
    // Two low pure tones carry absurdly far through trees, which is the entire
    // reason the bird sings them.
    carry: 170,
    rare: 0.6,
    unit: 2,
    early: 2.2,
    call: [0],
    size: 34,
  },
  {
    /**
     * A great tinamou, and the reason dusk in this wood is worth standing still
     * for. Three to five enormously long, pure, quavering whistles, each one a
     * little higher than the last, with a second of silence between them. It is
     * a ground bird you will essentially never see and the voice is the only
     * evidence it exists.
     *
     * The tremolo is the species. 9 Hz at a third of a semitone is the deepest
     * vibrato in the table, and on a note this long it is the whole character —
     * the notes themselves barely move.
     */
    name: 'tinamou',
    // A shade under 1 kHz.
    root: 82,
    ratio: 1.0,
    index: 0.2,
    decay: 0.6,
    notes: [0, 0, 2, 2, 4],
    gaps: [0.92, 1.0, 1.06, 1.12],
    glide: 0.8,
    arc: [0.3, 0.8, 0.4],
    warble: 9,
    warbleDepth: 0.3,
    lead: 0.4,
    level: 0.65,
    // A FLOOR, like the potoo. A tinamou starts as the light goes and is the
    // voice that hands the wood over to the night.
    active: [0.28, 1],
    carry: 220,
    rare: 0.7,
    tail: 2,
    early: 0.35,
    call: [0],
    size: 44,
  },
  {
    /**
     * A black-throated trogon: eight to a dozen absolutely even hollow notes,
     * slowing very slightly and sagging a semitone at the end. It is the
     * metronome of this roster, and against nineteen rows that all move it
     * reads as the deliberate, patient thing it is.
     *
     * It sits still on its branch for minutes at a time doing this, which is
     * also why it is one of the two or three species here you can genuinely
     * walk up to and find.
     */
    name: 'trogon',
    // About 700 Hz.
    root: 77,
    ratio: 1.0,
    index: 0.25,
    decay: 0.2,
    notes: [0, 0, 0, 0, 0, 0, 0, -1, -1],
    gaps: [0.22, 0.225, 0.23, 0.24, 0.25, 0.26, 0.275, 0.29],
    glide: -0.6,
    arc: [0.2, -0.8],
    lead: 0.9,
    fade: 0.8,
    level: 0.7,
    active: [0, 0.5],
    carry: 130,
    rare: 0.9,
    early: 1.0,
    call: [0, 0],
    size: 28,
  },
  {
    /**
     * A common potoo, which is what the dark sounds like here.
     *
     * Five or six notes, each a minor third below the one before, each quieter,
     * spaced most of a second apart — a descending series that falls away into
     * nothing and is unmistakably sad. It is the nightingale's slot in the old
     * roster and it does the job better, because it does not sound like a
     * beautiful bird singing. It sounds like something a long way off giving
     * up.
     *
     * `fade` at 0.3 and a `notes` line that falls fifteen semitones are the
     * same idea said twice, on purpose: the phrase gets lower AND quieter, and
     * either alone reads as a mistake rather than as a shape.
     */
    name: 'potoo',
    // Starting around 1 kHz and ending near 400.
    root: 83,
    ratio: 1.0,
    index: 0.18,
    decay: 0.45,
    notes: [0, -3, -6, -9, -12, -15],
    gaps: [0.76, 0.82, 0.86, 0.92, 0.98],
    glide: -1.2,
    arc: [0.3, -1.6],
    warble: 4,
    warbleDepth: 0.15,
    lead: 0.5,
    fade: 0.3,
    level: 0.75,
    // The deepest floor in the table. A potoo does not start until the light
    // has properly gone, which during play means somewhere past the middle of
    // a trip.
    active: [0.38, 1],
    carry: 200,
    rare: 0.85,
    unit: 3,
    early: 0.3,
    call: [-8],
    size: 38,
  },
  {
    /**
     * A great kiskadee, which says its own name and is the one bird on this
     * roster a player will learn by the end of an afternoon. Three shouted
     * syllables, rising, the last one longest and highest: "kis-ka-DEE".
     *
     * `unit: 3` is why you never hear "kis-ka". A two-thirds kiskadee is the
     * exact equivalent of the cuckoo's broken third and would be noticed by
     * everybody.
     *
     * A hard `lead` of 2.1 is the shout. Every other loud row here arrives on
     * its note; a kiskadee hits it.
     */
    name: 'kiskadee',
    // 2.1 kHz, rising through the phrase to about 3.5.
    root: 96,
    ratio: 1.0,
    index: 0.9,
    decay: 0.12,
    notes: [0, 4, 9],
    gaps: [0.13, 0.17],
    glide: 1.2,
    arc: [1.2, -0.8],
    lead: 2.1,
    fade: 1.8,
    hold: 1.7,
    tail: 1,
    unit: 3,
    level: 0.6,
    active: [0, 0.55],
    carry: 140,
    // The most conspicuous bird in the Neotropics — it sits in the open, near
    // water, near people, and shouts.
    rare: 1.15,
    early: 1.1,
    call: [4, 4],
    size: 22,
  },
  {
    /**
     * A musician wren, and the only voice in the table that is about DURATION.
     *
     * Everything else here is a phrase — a shape with a beginning and an end,
     * two seconds long, and then silence you can hear. A musician wren has no
     * phrase boundaries. It produces an unbroken wandering line of pure
     * whistled intervals for twenty seconds or a minute, and the effect of that
     * on a wood full of two-second phrases is not "another bird". It is one
     * bird that will not stop, which is a completely different experience and
     * the reason the streaming machinery in `_phrase` exists for this one row.
     *
     * SEVENTEEN NOTES AGAINST SEVEN GAPS, which is deliberate and is the whole
     * trick: the two cycles are coprime, so the melodic pattern does not come
     * round for a hundred and nineteen notes — and by then the per-note detune
     * and the glide jitter have moved it anyway. A wren that loops is worse
     * than no wren.
     *
     * The intervals are wide and consonant on purpose. This is the bird people
     * claim sings in perfect fifths and octaves; it does not quite, but it
     * comes closer than anything else alive and the row is written to it.
     */
    name: 'musicianwren',
    // 1.6 kHz. Pure, flute-like, and much lower than a temperate wren.
    root: 91,
    ratio: 1.0,
    index: 0.35,
    decay: 0.16,
    notes: [0, 7, 12, 5, 0, 9, 4, 12, 7, 2, 11, 5, 14, 7, 0, 9, 3],
    gaps: [0.29, 0.34, 0.26, 0.41, 0.31, 0.24, 0.37],
    glide: -0.5,
    arc: [0.5, -0.4],
    warble: 6,
    warbleDepth: 0.12,
    lead: 0.9,
    // Seconds, not notes.
    stream: [7, 20],
    level: 0.5,
    active: [0, 0.4],
    // A small bird in the understorey. It does not throw.
    carry: 70,
    // Low, and it has to be. This is not an event that can happen twice in a
    // minute — it is an event that occupies a minute.
    rare: 0.4,
    early: 0.8,
    call: [0, 0],
    size: 12,
  },
  {
    /**
     * A warbling antbird: a short accelerating series that climbs, tightens
     * into a rattle and stops dead. It is the chaffinch's structure — a run
     * that trips over itself — running UPHILL instead of down, which is a
     * completely different sound and worth having for exactly that reason.
     *
     * The gaps shrink by about a seventh each note. That acceleration is the
     * species; the pitches are almost incidental.
     */
    name: 'antbird',
    root: 95,
    ratio: 1.0,
    index: 0.85,
    decay: 0.075,
    notes: [0, 2, 3, 5, 6, 8, 9, 11, 12, 12],
    gaps: [0.155, 0.14, 0.126, 0.114, 0.103, 0.094, 0.086, 0.08, 0.076],
    glide: 0.9,
    arc: [-0.6, 1.2],
    lead: 1.7,
    fade: 1.5,
    tail: 2,
    level: 0.55,
    active: [0, 0.45],
    // The understorey, in deep shade, and it never leaves it.
    carry: 60,
    rare: 1.0,
    early: 0.6,
    call: [2],
    size: 14,
  },
  {
    /**
     * A golden-headed manakin, which is the second of the two rows allowed to
     * be rough, and the roughness is entirely in the warble.
     *
     * The display call is a buzzy descending "prrreet" — a sound with an
     * obvious grain to it — and the honest way to get grain out of this
     * synthesiser is a vibrato fast enough to stop being heard as pitch. 21 Hz
     * at a fifth of a semitone is right at that edge. Push the depth and it
     * becomes sidebands, which is the thing this file refuses; push the rate
     * and it becomes a tremolo.
     *
     * It is also the smallest bird on the roster and by some distance the most
     * ridiculous — a nine-centimetre black bird with a fluorescent yellow head
     * that spends its day snapping its wings at other birds on a lek.
     */
    name: 'manakin',
    root: 99,
    ratio: 1.0,
    index: 0.75,
    decay: 0.13,
    notes: [0, -2, -5],
    gaps: [0.09, 0.11],
    glide: -3.4,
    arc: [0.4, -1.8],
    warble: 21,
    warbleDepth: 0.2,
    lead: 1.4,
    level: 0.45,
    active: [0, 0.4],
    carry: 45,
    rare: 0.8,
    unit: 3,
    early: 0.5,
    call: [0],
    size: 10,
  },
  {
    /**
     * A paradise tanager: thin, high, unmusical little "tsip"s with a longer
     * one on the end. The voice is nothing and the bird is the most absurdly
     * coloured thing in the wood — apple-green head, turquoise breast, scarlet
     * rump — which is a real and useful asymmetry, because it means the way you
     * find one is by looking rather than by listening.
     */
    name: 'tanager',
    root: 102,
    ratio: 1.0,
    index: 0.6,
    decay: 0.055,
    notes: [0, 0, 2, 0, 5],
    gaps: [0.11, 0.13, 0.1, 0.16],
    glide: 1.1,
    arc: [0.6, -0.5],
    lead: 1.8,
    hold: 1.9,
    tail: 1,
    level: 0.42,
    active: [0, 0.4],
    carry: 50,
    rare: 0.9,
    early: 0.5,
    call: [0],
    size: 14,
  },
  {
    /**
     * A red-legged honeycreeper. The highest small voice here and very nearly
     * the thinnest sound this synthesiser can make: a lisping descending
     * "tseee" with almost nothing in it.
     *
     * It is on the roster for the goldcrest's reason. A wood needs a voice at
     * the top of its range that you can only hear when you are close, so that
     * being close to something means something.
     */
    name: 'honeycreeper',
    root: 105,
    ratio: 1.0,
    index: 0.4,
    decay: 0.06,
    notes: [0, -1, -3],
    gaps: [0.13, 0.15],
    glide: -2.2,
    arc: [0.3, -1.4],
    lead: 1.1,
    fade: 0.6,
    level: 0.34,
    active: [0, 0.35],
    // Forty metres. Past that it is not a quiet bird, it is no bird.
    carry: 40,
    rare: 0.7,
    early: 0.45,
    call: [-1],
    size: 12,
  },
  {
    /**
     * A long-billed hermit — a hummingbird, singing at a lek, which is a
     * sentence most people do not expect to be true. The song is a high,
     * squeaky, monotonous chip repeated every second or so, for hours, from the
     * same twig.
     *
     * The highest root in the table, and the shortest carry: a hermit twenty
     * metres away is inaudible, so hearing one means it is more or less in
     * front of you.
     */
    name: 'hermit',
    root: 107,
    ratio: 1.0,
    index: 0.7,
    decay: 0.05,
    notes: [0, 0, 1],
    gaps: [0.62, 0.66],
    glide: 0.8,
    arc: [-0.4, 0.9],
    lead: 2.0,
    level: 0.3,
    active: [0, 0.4],
    carry: 30,
    rare: 0.6,
    early: 0.4,
    call: [0],
    size: 13,
  },
  {
    /**
     * A barred woodcreeper: a descending whinnying laugh, fifteen or twenty
     * notes, slowing and falling and quietening the whole way down. It is the
     * willow warbler's dying fall with a rainforest's lungs behind it, and it
     * is the one phrase here that genuinely sounds like laughter.
     *
     * `fade` at 0.35 with gaps that grow and a `notes` line that falls is three
     * statements of the same idea, which is what a dying fall needs — take any
     * one of them out and it is a descending scale.
     */
    name: 'woodcreeper',
    root: 90,
    ratio: 1.0,
    index: 0.7,
    decay: 0.1,
    notes: [12, 11, 9, 8, 6, 5, 3, 2, 0, -1, -3, -4],
    gaps: [0.075, 0.08, 0.086, 0.093, 0.1, 0.108, 0.117, 0.127, 0.138, 0.15, 0.163],
    glide: -1.1,
    arc: [0.25, -1.2],
    lead: 1.3,
    fade: 0.35,
    pure: 0.45,
    level: 0.55,
    active: [0, 0.5],
    carry: 110,
    rare: 0.8,
    early: 0.9,
    call: [-4],
    size: 25,
  },
  {
    /**
     * A barred antshrike, which is the accelerando in this table and the only
     * phrase that ends in something ugly.
     *
     * Fifteen or so nasal notes that speed up until they run together, and then
     * one long, down-bent, snarling note on the end that is a different animal
     * from the fourteen before it. `hold` at 2.6 makes that last note two and a
     * half times the length of the others and — through the square-root rule —
     * bends it a fourth and a half further down. Without it the row is a
     * rattle that stops.
     */
    name: 'antshrike',
    root: 88,
    ratio: 1.0,
    index: 1.0,
    decay: 0.085,
    notes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
    gaps: [0.2, 0.185, 0.17, 0.155, 0.142, 0.13, 0.12, 0.11, 0.1, 0.092, 0.085, 0.08],
    glide: -1.4,
    arc: [0.5, -1.0],
    warble: 11,
    warbleDepth: 0.16,
    lead: 1.6,
    hold: 2.6,
    tail: 1,
    level: 0.55,
    active: [0, 0.45],
    carry: 90,
    rare: 0.85,
    early: 0.7,
    call: [0, 0],
    size: 17,
  },
  {
    /**
     * A collared aracari — a small toucan, and nothing about the voice says so.
     * It is a high, thin, penetrating shriek repeated four or five times, the
     * sound of a rusty hinge, and it comes out of a bird with a scarlet rump
     * and a bill half its own length.
     *
     * The asymmetry is the point again: this row's job on the roster is to be
     * heard at a distance and then found, because when you do find it there is
     * no mistaking what it is.
     */
    name: 'aracari',
    root: 100,
    ratio: 1.0,
    index: 1.1,
    decay: 0.11,
    notes: [0, 0, 0, -1],
    gaps: [0.31, 0.33, 0.36],
    glide: -1.8,
    arc: [1.0, -1.6],
    lead: 2.2,
    fade: 0.75,
    level: 0.6,
    active: [0, 0.5],
    carry: 150,
    rare: 0.8,
    early: 1.3,
    call: [0],
    size: 41,
  },
  {
    /**
     * A black-faced solitaire, which is the most beautiful voice in this file
     * and is not a competition it wins narrowly. Pure, hollow, flute-like notes
     * with enormous intervals between them and enormous silences around them —
     * the thing people describe as a rusty gate that turned out to be musical.
     *
     * The lowest `index` of any voice above 90, so it is very nearly a sine at
     * a pitch where a sine is a whistle. The wide leaps and the long gaps are
     * what stop that being boring: it is a bird that will not tell you where
     * the phrase is going.
     */
    name: 'solitaire',
    root: 98,
    ratio: 1.0,
    index: 0.22,
    decay: 0.26,
    notes: [0, 7, -5, 5, 0, 9, -3],
    gaps: [0.52, 0.66, 0.48, 0.74, 0.56, 0.62],
    glide: -0.9,
    arc: [0.5, 0.2, -0.8],
    warble: 6.5,
    warbleDepth: 0.14,
    lead: 0.6,
    level: 0.6,
    // The widest window of any small bird here. A solitaire sings in the mist
    // before dawn and is still at it when everything else has stopped.
    active: [0, 0.75],
    carry: 160,
    rare: 0.75,
    early: 1.7,
    call: [-5],
    size: 17,
  },
  {
    /**
     * A keel-billed toucan, and the third and last row with grain in it.
     *
     * The call is not a squawk — that is a macaw, and it lives further down
     * this file where the noise generators are. A toucan CROAKS: a dry,
     * monotone, frog-like "creek ... creek ... creek", pitched low, repeated
     * for a minute at a time from the top of a dead tree. The rhythm is
     * absolutely even and the pitch never moves, which between them are the
     * whole species.
     *
     * 17 Hz of warble at a quarter of a semitone is the croak. It is the wren's
     * old rattle trick used for texture rather than for speed, and it is the
     * reason this row does not need the noise path: the grain is in the pitch,
     * so the spectrum stays as thin as a whistle and the harshness meter never
     * sees it.
     */
    name: 'toucan',
    // 587 Hz. Low, dry and hollow, and it holds still there.
    root: 74,
    ratio: 1.0,
    index: 0.32,
    decay: 0.14,
    notes: [0, 0, 0, 0],
    gaps: [0.33, 0.34, 0.33],
    glide: -0.4,
    arc: [0.2, -0.3],
    warble: 17,
    warbleDepth: 0.25,
    lead: 1.2,
    level: 0.7,
    active: [0, 0.5],
    carry: 180,
    rare: 0.95,
    // The bird you hear first from the canopy as it gets light, and the one
    // most people are actually hoping to see.
    early: 1.6,
    call: [0],
    size: 50,
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
 * silently, with a hermit wearing a toucan.
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

/** One semitone as a frequency ratio. Contours are written in semitones. */
const SEMI = 2 ** (1 / 12);

/**
 * The default contour: none. A row with no `arc` gets its `glide` and nothing
 * else, which is exactly what every row used to get.
 */
const _straightArc = [0];

/**
 * Walk an AudioParam through a pitch contour, in semitones, over `dur`.
 *
 * Used for the carrier and — critically — for the modulator as well, at the
 * same shape, so that an FM pair sweeping an octave arrives with the same ratio
 * it left with. See `_note`.
 *
 * `lead` is the onset: how many semitones flat the note starts before snapping
 * up to pitch. This is a real thing a syrinx does as it comes under tension and
 * it is what articulates a note now that there is no spectral flash at the
 * front doing it. Ramps are exponential in frequency, which is linear in pitch,
 * so a contour written in semitones is heard as the interval it says.
 */
function sweep(param, base, when, dur, arc, glide, bend, lead) {
  const steps = arc.length;
  // Short enough to be an articulation rather than a slur, and always inside
  // the first contour leg so the ramp times stay in order.
  const leadT = Math.min(0.012, dur * 0.12, dur / (steps + 1));
  /**
   * CLAMPED, because `bend` is not always near one. `call()` hands in ±2.4 for
   * a flight call and 0.12 for an alarm, which are deliberate statements about
   * the CONTOUR — a flight call falls away, an alarm refuses to move — and a
   * scoop of three and a half semitones onto the front of a note is neither. It
   * is a swoop, and on a one-note call it is the whole sound. The sign still
   * follows `bend`, so an inverted contour still gets an inverted onset.
   */
  const leadS = clamp(-lead * bend, -2, 2);
  param.setValueAtTime(Math.max(40, base * SEMI ** leadS), when);
  param.exponentialRampToValueAtTime(Math.max(40, base), when + leadT);
  for (let s = 0; s < steps; s++) {
    const k = (s + 1) / steps;
    const semis = (arc[s] + glide * k) * bend;
    param.exponentialRampToValueAtTime(Math.max(40, base * SEMI ** semis), when + dur * k);
  }
}

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
/**
 * 0.45, up from 0.3, AND THE ARGUMENT IS THE ONE THIS COMMENT ALREADY MAKES.
 *
 * Everything above is about a bucket that had to refuse most of its demand
 * because the demand was seventy-two phrases a minute from twenty-six birds, of
 * which the player could hear a handful. `fauna.js` has since moved the perching
 * roster from a 26–95 m band to 12–58 m — see PERCH_NEAR there — and that
 * changes what refusing means. The same throttle now throws away song from birds
 * in the trees around you: measured in the running game, forty-one attempts a
 * minute and SEVEN getting through, with the node ceiling untouched at the other
 * end (no note was ever refused, and the count sat above 70% of the ceiling for
 * five per cent of the minute).
 *
 * A rate limiter that is discarding five sixths of an audible signal while the
 * resource it protects is idle is mis-calibrated, not conservative. 0.45 takes
 * it to about one song every two and a bit seconds at full tilt, which is what a
 * wood with a dozen birds inside forty metres actually does; the ceiling and the
 * chorus wave still shape it, and `_afford`'s `hour` factor still means midnight
 * is a fifth of that.
 *
 * IT IS NOT A LEVEL CHANGE. The measured in-band peak of one song over the bed
 * is +19 dB at 8 m, +13 at 25 and +9 at 40, and it was that before this line
 * moved — which is exactly why the fix was rate and distance rather than gain.
 */
const SONG_REFILL = 0.45;
const SONG_BUDGET = 5;

/**
 * HOW A SONG LONGER THAN THE NODE BUDGET GETS SUNG.
 *
 * Every other phrase in this file is scheduled in one go: twenty `_note` calls,
 * forty oscillators, all created inside a single JS turn and all counted
 * against `this.voices` the instant they exist, because `onended` cannot fire
 * for something that has not started yet. Twenty is fine. A musician wren is two
 * to four HUNDRED notes, and scheduling one that way would take the counter past
 * the ceiling on the first bird, drop most of its own song, and then refuse
 * every other event in the wood for the twenty seconds it took to drain.
 *
 * So the musician wren is pumped instead. `_phrase` schedules only the notes that
 * start within the next `STREAM_AHEAD` seconds and sets a timer for
 * `STREAM_STEP` to come back for more. Measured in the running app, that holds
 * between fifteen and twenty-seven notes in flight at any moment — about a
 * warbler's footprint, sustained for twenty seconds instead of two, against a
 * ceiling of fifty-eight. The lookahead is far longer than the step on purpose:
 * a late timer eats into the margin instead of leaving a hole in the song, and
 * the notes are still scheduled against `ctx.currentTime`, so they are
 * sample-accurate even when the timer that queued them was not.
 *
 * ONE AT A TIME, and that is what `_streams` is for. Two overlapping wrens
 * is not a richer understorey, it is twice the node footprint for a sound nobody can
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
    this._nextMacaw = rngRange(this.rng, 25, 80);
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
    this._nextParrots = rngRange(this.rng, 40, 150);
    this._nextGuan = rngRange(this.rng, 60, 200);
    this._nextEagle = rngRange(this.rng, 50, 240);
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
   * pick spent a third of its events on honeycreepers and hermits at ninety
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
   * ARRIVES IN ORDER. At dawn 1 a motmot is weighted 2.2 times its daytime
   * share and a tanager half of its, so the first minutes are motmots and
   * solitaires hooting in the dark, the pihas and the oropendolas come in as it
   * gets light, the toucans start up in the canopy after that, and the
   * understorey birds turn up last — which is the actual sequence, and is
   * audible as the forest assembling itself rather than fading up.
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
   * trogon in that fig is always a shade flat and always slightly hurried;
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
   *   which against a potoo's carry is one bird at a time.
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
   * One note of birdsong: a whistle that MOVES for its whole length.
   *
   * WHAT THIS USED TO BE, AND WHY IT WAS WRONG. The first version was a sine
   * carrier, a sine modulator whose index collapsed to nothing in the first
   * two thirds of the note, and a six-millisecond attack onto a bare
   * exponential decay. Every one of those three choices is, individually, the
   * textbook recipe for a struck wooden bar: a spectral flash at the onset that
   * dies away to a pure tone IS a mallet hitting something, the amplitude shape
   * of a bar is exactly an instant attack with no plateau, and a pitch that
   * holds still for its whole length is a tuned bar and not an animal. Put
   * together they did not sound like sixteen species of bird, they sounded like
   * sixteen tunes played on a xylophone, which is what was reported.
   *
   * The header above is right that a syrinx is very nearly a pure tone. What it
   * missed is the other half of the same sentence: it is a pure tone whose
   * PITCH IS NEVER STILL. Frequency modulation in the literal sense — the note
   * sliding around inside its own duration — is the single acoustic feature
   * that separates birdsong from every instrument a human plays, and birds
   * discriminate each other on the fine detail of it. So the note is now:
   *
   *   A CONTOUR, not a glide. `arc` is a handful of semitone offsets spread
   *   across the note and the pitch is walked through them. A tinamou's whistle
   *   swells up and sags; a potoo's note falls all the way through; a piha's
   *   scream leaps most of an octave and drops off a cliff. That shape happens INSIDE one note and
   *   it is most of what makes a species recognisable close up.
   *
   *   AN ONSET THAT IS PITCH, NOT TIMBRE. Notes still need articulation or a
   *   phrase turns to porridge, but the old spectral flash was the mallet. A
   *   real syrinx starts flat and snaps up as it comes under tension, so the
   *   note now leads in from a little below. It articulates just as hard and
   *   there is nothing percussive in it.
   *
   *   A PLATEAU. Attack, hold, release. A whistle sustains and a struck bar
   *   cannot, and this is the difference between a bird and a marimba even with
   *   everything else held equal.
   *
   *   A MODULATOR THAT TRACKS THE CARRIER. It is swept through the same contour
   *   so the ratio holds, which keeps the spectrum harmonic while the note
   *   moves. A fixed modulator under a sweeping carrier is a ratio that drifts,
   *   which is inharmonic, which is a bell — the old code got away with it only
   *   because nothing moved far enough to notice.
   *
   *   AND THE INDEX STAYS PUT. It tapers gently rather than collapsing, so it
   *   is a timbre for the whole note instead of a strike at the front of one.
   *
   * The anti-buzz doctrine is untouched and is in fact easier to hold now:
   * every one of these is an oscillator frequency or a gain, there is still not
   * a filter parameter automated anywhere in the file, and the index ceiling is
   * still 2.2. A sine sliding around cannot rasp; there is nothing in it to
   * rasp with.
   */
  _note(dest, when, midi, voice, gain, shape = _flatShape) {
    if (this.voices > VOICE_CEILING) return;
    const ctx = this.ctx;
    const dur = Math.max(0.012, voice.decay * (shape.decay ?? 1));
    const f = midiToFreq(midi);
    const bend = shape.glide ?? 1;
    const arc = voice.arc ?? _straightArc;
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
    sweep(carrier.frequency, f, when, dur, arc, voice.glide, bend, voice.lead ?? 1.4);

    const mod = ctx.createOscillator();
    mod.type = 'sine';
    sweep(mod.frequency, f * voice.ratio, when, dur, arc, voice.glide, bend, voice.lead ?? 1.4);
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(f * index, when);
    // A taper, not a collapse. The old line went to f * 0.005 in 0.7 of the
    // note, which is the mallet. This is the same tone at the end as at the
    // start, only slightly softer, which is a voice.
    modGain.gain.linearRampToValueAtTime(f * index * 0.6, when + dur);
    mod.connect(modGain).connect(carrier.frequency);

    /**
     * The vibrato, for the rows that have one.
     *
     * Real syringeal FM sits somewhere between four and thirty hertz depending
     * on the species and it is a big part of why an oropendola sounds liquid
     * and a toucan sounds like a croak. Kept shallow on purpose: at these depths
     * it is heard as a warble on a whistle. Deep and fast it would be sidebands,
     * which is the rasp this file exists to avoid, so `warbleDepth` is small
     * everywhere it is set at all.
     */
    let lfo = null;
    let lfoDepth = null;
    if (voice.warble && dur > 0.05) {
      lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = voice.warble;
      lfoDepth = ctx.createGain();
      lfoDepth.gain.value = f * (SEMI ** (voice.warbleDepth ?? 0.18) - 1);
      lfo.connect(lfoDepth).connect(carrier.frequency);
      lfo.start(when);
      lfo.stop(when + dur + 0.04);
    }

    /**
     * Attack, HOLD, release. The hold is the whole point — see the block above.
     * Clamped at both ends so that a tanager's fifty-five millisecond note still
     * gets an onset and a tinamou's six-tenths of a second does not spend it all
     * fading.
     */
    const atk = clamp(dur * 0.2, 0.005, 0.04);
    const rel = clamp(dur * 0.5, 0.015, 0.4);
    const hold = Math.max(atk + 0.001, dur - rel);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(gain, when + atk);
    env.gain.setValueAtTime(gain, when + hold);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);

    carrier.connect(env).connect(dest);
    carrier.start(when);
    mod.start(when);
    carrier.stop(when + dur + 0.04);
    mod.stop(when + dur + 0.04);
    this.voices++;
    carrier.onended = () => {
      this._release(carrier);
      try {
        env.disconnect();
        mod.disconnect();
        modGain.disconnect();
        lfo?.disconnect();
        lfoDepth?.disconnect();
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
   *   because a piha that stops before its scream is not a short piha, it is
   *   a broken one.
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
    /** How far this particular bird's notes swing. See the note loop. */
    const swing = 0.8 + whoLength * 0.45;

    /**
     * How much of the phrase this one gets.
     *
     * `tail` is both the protected ending and the flag for whether the body may
     * be run long: a phrase with an ending cannot be, because the only way to
     * extend it is to cycle back through notes it has already sung and then say
     * the ending twice. Voices with no ending are cycles by construction —
     * trogons, toucans, antshrikes — and running those long is precisely what
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
     * one that is a repeated unit, and the table contains both. A trogon
     * cut anywhere is a trogon that hooted eight times instead of eleven
     * times, which is what trogons do. A KISKADEE CUT SHORT IS "kis-ka" — the
     * most recognisable sound in this project, broken, in the one way everybody
     * would notice. So `unit` is the size of
     * the repeating group and the count is a multiple of it, which for the wood
     * kiskadee's three-syllable idiom means it is simply never cut at all.
     */
    const unit = voice.unit ?? 1;
    let count = Math.max(unit, Math.round((body * frac) / unit) * unit) + tail;
    // Long cyclic songs only. A kiskadee with a note missing is not a variation,
    // it is a fault, and the phrases short enough to notice are exactly the
    // ones whose shape is the whole species.
    const mayDrop = tail === 0 && n >= 9;

    /**
     * A STREAMING VOICE IS MEASURED IN SECONDS, NOT IN NOTES, which is the
     * whole distinction the field exists to draw. Every other row is a phrase
     * and its length is however long its notes take; a musician wren is a stretch of
     * time that happens to be full of notes, so `stream` is `[min, max]`
     * seconds and the count falls out of the tempo. An individual carries its
     * own stamina on top — some wrens go on much longer than others, and it is
     * the same bird every time you stand under it.
     */
    /**
     * HOW LONG THIS PHRASE WILL LAST, IN SECONDS, AND WHO NEEDS TO KNOW.
     *
     * `fauna.js` does. A bird that sings and does not move while it sings is a
     * loudspeaker in a tree, and the whole reported problem with this wood is
     * that you can hear birds and never find one — so the percher now performs
     * for exactly as long as the sound it is making, which means it has to be
     * told. Falling out of the scheduler is the only honest source for it: the
     * phrase length is a per-rendition roll here and nothing outside this
     * method can predict it.
     *
     * For a streamed voice it is the planned seconds rather than what has been
     * scheduled so far, because `t` at the point of return is only the first
     * lookahead window. For everything else the loop below runs to completion
     * before the return, so `t - t0` plus the last note's decay is exact.
     */
    let planned = 0;
    if (streaming) {
      let mean = 0;
      for (const g of voice.gaps) mean += g;
      mean = (mean / voice.gaps.length) * pace;
      const seconds =
        rngRange(rng, voice.stream[0], voice.stream[1]) *
        (0.75 + whoLength * 0.5) *
        (1 - short * 0.45);
      count = Math.max(12, Math.round(seconds / Math.max(0.01, mean)));
      planned = seconds;
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
     * next wren, it silently allows two. A counter guarding a limit must not
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
     * come back for more. For every voice but the musician wren the horizon is
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
       * the piece that was missed instead. A wren heard through a tab switch
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
          /**
           * The individual's own contour depth, on top of the per-note roll.
           *
           * `shape.glide` scales the whole pitch shape — arc and glide together
           * — so this is how far a given bird's notes swing. It is a fixed
           * property of the individual like its key and its tempo, which means
           * one trogon in the wood is consistently flatter and more clipped
           * than the one answering it, and still is ten minutes later. Before
           * this the only per-bird differences were pitch and pace, so two
           * individuals were the same performance transposed; contour is the
           * dimension a listener actually hears as a different animal.
           */
          _shape.glide =
            swing * rngRange(rng, 0.78, 1.22) * (last && hold > 1 ? Math.sqrt(hold) : 1);
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
    return {
      at: t0,
      notes: count,
      voice: voiceIndex,
      // See `planned`. Delay included, because the caller wants to know when
      // the sound stops and not how long it lasts once it starts.
      dur: (streaming ? planned : t - t0 + voice.decay * hold) + delay,
    };
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
  /**
   * RETURNS THE PHRASE, OR NULL, AND THAT RETURN IS LOAD-BEARING NOW.
   *
   * It used to return nothing, because nothing needed to know. What needs to
   * know is `fauna.js`: the percher that asked to sing has to PERFORM while the
   * sound is happening — a bird that holds still through its own song is the
   * single reason a player can hear this wood and never find anything in it —
   * and it can only do that if it is told two things this method knows and the
   * caller cannot possibly work out. Whether the song happened at all, because
   * the leaky bucket refuses most of them and a bird miming to a refused token
   * is worse than one standing still; and how long it lasts, because the
   * rendition length is rolled per performance in `_phrase`.
   *
   * `{ at, notes, voice, dur }` or null. The answer and the contact note that
   * follow are deliberately NOT included in `dur` — they come from somewhere
   * else in the wood, and the bird in front of you should stop when it stops.
   */
  song(position, voiceIndex, { answer = false, gain = 1, throttle = true } = {}) {
    if (!this.built) return null;
    // The density limiter. `throttle: false` is the distant chorus, which is
    // rate-limited by its own scheduler — see SONG_REFILL.
    if (throttle && !this._afford()) return null;
    const rng = this.rng;
    const snap = clamp01((this.tripLevel - 0.15) / 0.6);
    /**
     * A bird out of its hour still sings, but half-heartedly.
     *
     * This path is what `fauna.js` calls for a percher you have walked up to,
     * and the species is that individual's identity — it cannot be re-picked
     * here without the bird in the tree in front of you changing what it is.
     * So the window arrives as a level instead: at the wrong end of the day a
     * tanager drops to about half, which is a bird having one more go rather
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
    if (!answer) return sung;
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
      return sung;
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
    if (roll > 0.7) return sung;
    this._phrase(_answerAt, this._pick(r, this.dark), {
      gain: gain * 0.7,
      snap,
      delay: rngRange(rng, 0.9, 2.4),
    });
    return sung;
  }

  /**
   * EVERYTHING A BIRD SAYS THAT IS NOT A SONG, which is almost everything.
   *
   * A songbird sings for a few minutes a day. It makes noise for all of it, and
   * a recording of a real wood is nine parts small utterance to one part
   * set-piece — a tick from a tanager, two notes from a trogon crossing a gap,
   * an antshrike swearing at a snake, a fledgling that will not stop.
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
   * way as the macaws for the same reason: a bird forty metres off shouting about
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
     * an antbird's notes rise and a potoo's fall — so two of these four have to
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
   * WINGS, AND NOTHING ELSE — the sound of a bird simply going somewhere.
   *
   * WINGBEATS ARE THE SOUND OF AIR MOVING, so they are low and dull — around
   * 260 Hz, wide, 45 ms each — and they ACCELERATE and then thin out, which is
   * what a small bird's departure actually is: five or six beats to get clear of
   * the branch and then a glide. Playing them evenly spaced sounds like a
   * helicopter.
   *
   * WHY THIS IS SPLIT OUT OF `flush` RATHER THAN BEING IT. A flush is a bird
   * being FRIGHTENED, and three of the four things it does say so: the sub-200 Hz
   * whump of a panic launch, the alarm note, and `_startle`, which stops the
   * whole wood for four seconds. Those are exactly right when you have walked
   * into a thicket and exactly wrong when a tanager has decided the next tree
   * looks better — and `_startle` is the one that cannot simply be turned down,
   * because a wood that goes quiet every time any bird moves is a wood that is
   * silent. So the wings are the shared half and the panic is `flush`'s own.
   *
   * `travel` is where it is going, as a displacement from `position`, and it is
   * the reason this is worth a panner ramp at all: wings that stay put are a
   * sound effect played at a coordinate, and wings that cross you are a bird.
   * `flush` passes a vector pointing away from the listener; a bird flying to a
   * perch passes the perch.
   */
  wingbeats(position, { nearness = 1, gain = 1, travel = null, spatial = null } = {}) {
    if (!this.built) return null;
    /**
     * THE FIRST THING TO GO WHEN THE WOOD IS FULL, and the same 0.55 guard
     * `call` uses, for the same reason.
     *
     * A train of wingbeats is nine nodes and it is the least missed sound in the
     * file: it carries no pitch, no species and no information beyond "something
     * moved over there", and at dawn there are twenty other things making that
     * point. Song is what the ceiling exists to protect, so wings stand aside
     * for it — measured at a full dawn chorus this is the difference between
     * sitting one voice under the cap and having room.
     *
     * `flush` passes its own `spatial`, and a flush is a bird you frightened
     * three metres away: that one is never declined, because the guard is about
     * the wood's background traffic and a flush is an event about you.
     */
    if (!spatial && this.voices > VOICE_CEILING * 0.55) return null;
    const rng = this.rng;
    const t0 = this.ctx.currentTime + 0.01;
    const own =
      spatial ??
      this._place(position, {
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
        gain: 0.3 * gain * fade * (0.4 + nearness * 0.8),
        rate: rngRange(rng, 0.7, 1.1),
        spatial: own,
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
      gain: 0.09 * gain * nearness,
      rate: 1.5,
      spatial: own,
    });

    /**
     * AND IT GOES SOMEWHERE. The panner is ramped over the length of the
     * wingbeat train.
     *
     * `createSpatial` exposes the PannerNode and its position is an AudioParam,
     * so this is three `linearRampToValueAtTime` calls on a node that already
     * exists — no per-frame work, no timer, nothing to tear down.
     */
    const arrive = t0 + beats * 0.09 + 0.5;
    if (travel && own.panner.positionX) {
      own.panner.positionX.linearRampToValueAtTime(position.x + travel.x, arrive);
      own.panner.positionY.linearRampToValueAtTime(position.y + travel.y, arrive);
      own.panner.positionZ.linearRampToValueAtTime(position.z + travel.z, arrive);
    }
    // Only the owner tears down. `flush` keeps the source alive for its alarm.
    if (!spatial) {
      setTimeout(
        () => {
          try {
            own.dispose();
          } catch {
            /* already gone */
          }
        },
        (t - t0 + 1.4) * 1000
      );
    }
    return own;
  }

  /**
   * A bird leaving IN A HURRY: the wings above, plus the three things that make
   * it a fright rather than a journey.
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

    /**
     * The bearing is away from the listener because that is where a frightened
     * one goes, and the eight metres of travel is about what a trogon covers
     * before it is behind the next trunk.
     */
    const away = Math.atan2(position.x - this.lx, position.z - this.lz);
    const travel = 6 + nearness * 5;
    this.wingbeats(position, {
      nearness,
      spatial,
      travel: {
        x: Math.sin(away) * travel,
        y: 3.2 + nearness * 2,
        z: Math.cos(away) * travel,
      },
    });
    /**
     * The whump. One puff, an octave and a half below the wingbeats, on the
     * first downstroke only.
     *
     * A bird leaving a branch displaces a surprising slug of air and you feel
     * that more than you hear it — the beats are at 260 Hz because that is where
     * wings live, but the thing that makes a flush startling is the sub-200 Hz
     * thud underneath the first one. Three nodes, and it is the difference
     * between a rustle and something LEAVING.
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
    /**
     * 2.4 s, a constant rather than the end of the wing train.
     *
     * The train is `wingbeats`' business now and its length is a roll it makes
     * privately; eight beats of an accelerating gap is 0.75 s at the very most,
     * the alarm above finishes inside 0.4 s, and the panner ramp lands well
     * before either. Re-deriving the train's length here to save a second of a
     * disconnected node would be two copies of the same loop that have to agree
     * forever, which is the trade `_release` and `giveBack` both refuse.
     */
    setTimeout(() => {
      try {
        spatial.dispose();
      } catch {
        /* already gone */
      }
    }, 2400);
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
  bolt(position, kind = 'tapir', nearness = 1, mass = 1) {
    if (!this.built) return;
    const ctx = this.ctx;
    const rng = this.rng;
    const t0 = ctx.currentTime + 0.01;
    const heavy = kind === 'tapir';
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
     * the three species in this wood are enormously different about it. An
     * AGOUTI says nothing at all — it is the silent one, and leaving it silent
     * is what makes the other two mean anything. A CAPUCHIN does not run away
     * quietly, it gets somewhere safe and then swears at you for half a minute,
     * and a troop will keep it up for as long as you stand there. A TAPIR gives
     * a single thin whistle, which is the most surprising noise in this wood:
     * a quarter-tonne animal that sounds like a small bird.
     *
     * THESE THREE CLAUSES ARE THE SAME THREE THEY ALWAYS WERE. The rename from
     * deer/rabbit/squirrel changed which animal fills each role and not the
     * roles themselves — silent, scolding, and one voice — because that split
     * is about how an ENCOUNTER should read, not about zoology.
     *
     * Both are scheduled AFTER the leaves rather than under them: the animal
     * has to get clear before it complains, and the half-second of gap is what
     * makes the scold read as coming from a different place than the rustle.
     */
    if (kind === 'capuchin' && rng() < 0.75) {
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
   * A voiced noise burst — the macaw, the deer bark, and anything else in this
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
    // Up an octave-ish with the rest of the file — a squirrel's reedy note sits
    // with the ticks around it at one to two kilohertz, not down among the
    // motmots — and given an arc so it sags rather than sliding flat.
    const reed = {
      decay: 0.13,
      index: 1.4,
      glide: -3.2,
      ratio: 1.0,
      arc: [0.4, -1.0],
      lead: 2.2,
    };
    for (let i = 0; i < 2; i++) {
      this._note(bus, when + 0.12 + i * rngRange(rng, 0.22, 0.4), rngRange(rng, 87, 93), reed, 0.26);
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
   * A PAIR OF MACAWS, crossing high and a long way off.
   *
   * Two to four screeches with uneven gaps. Built out of `_throat`, so it is
   * pure noise through two fixed wide band-passes — a macaw really is almost
   * entirely broadband, and the reason it sounds harsh is the attack and the
   * formant pair rather than any kind of ringing. That is also the whole reason
   * it is here rather than in `VOICES`: putting a screech through the FM path
   * would need an index up where sidebands start, which is the sound this file
   * exists to refuse.
   *
   * It exists because it is the only voice here that is not beautiful. Twenty
   * species of whistling bird plus a woodpecker is a nature documentary; a
   * forest also contains something enormous and disagreeable shouting as it
   * goes over, and the chorus is more convincing for having one member that is
   * clearly not part of it.
   *
   * A PAIR, AND NOT ONE BIRD, WHICH IS THE ONE THING THIS VOICE HAS THAT THE
   * CROW IT REPLACED DID NOT. Macaws fly mated pairs and they call to each
   * other while they do it, so the second bird is offset a few metres sideways
   * and answers between the first one's screeches — a beat behind, a little
   * quieter, and with its own formant draw so it is unmistakably a second
   * animal. Two spatial nodes a couple of minutes apart is nothing, and the
   * effect is that the sound has a DIRECTION OF TRAVEL and a size, which is
   * exactly the impression a macaw pair leaves.
   *
   * Longer, lower and louder than the crow: the screech tail runs to half a
   * second against the crow's 0.3, the low formant sits at 380-500 Hz, and the
   * spatial source reaches 300 m rather than 220. A scarlet macaw is audible
   * across a valley.
   */
  macaw(position) {
    if (!this.built || this.voices > VOICE_CEILING * 0.65) return;
    const rng = this.rng;
    const t0 = this.ctx.currentTime + 0.02;
    const spatial = this._place(position, { refDistance: 18, rolloff: 0.95, maxDistance: 300 });
    // The mate, off to one side and a touch further away. Its own node, so the
    // two arrive from different bearings and the pair reads as two birds.
    _macawAt.x = position.x + rngRange(rng, -9, 9);
    _macawAt.y = position.y + rngRange(rng, -3, 3);
    _macawAt.z = position.z + rngRange(rng, -9, 9);
    const mate = this._place(_macawAt, { refDistance: 18, rolloff: 0.95, maxDistance: 300 });
    const screeches = 2 + Math.floor(rng() * 3);
    let t = t0;
    for (let i = 0; i < screeches; i++) {
      this._throat(position, t, spatial, {
        high: rngRange(rng, 1500, 2100),
        low: rngRange(rng, 380, 500),
        snap: 0.09,
        tail: rngRange(rng, 0.3, 0.5),
        gain: 0.5 * (i === 1 ? 1 : rngRange(rng, 0.7, 0.92)),
        rate: rngRange(rng, 0.85, 1.15),
      });
      // The answer, in the gap rather than on top of it. A macaw pair
      // alternates; two birds screeching together is a flock, which is the
      // parrot mob below and a different event.
      if (rng() < 0.7) {
        this._throat(_macawAt, t + rngRange(rng, 0.22, 0.36), mate, {
          high: rngRange(rng, 1400, 2000),
          low: rngRange(rng, 360, 480),
          snap: 0.09,
          tail: rngRange(rng, 0.26, 0.44),
          gain: 0.36 * rngRange(rng, 0.8, 1.0),
          rate: rngRange(rng, 0.82, 1.1),
        });
      }
      t += rngRange(rng, 0.5, 0.9);
    }
    setTimeout(() => {
      for (const s of [spatial, mate]) {
        try {
          s.dispose();
        } catch {
          /* already gone */
        }
      }
    }, (t - t0 + 1.8) * 1000);
  }

  /**
   * A FLOCK OF PARROTS GOING UP, and the forest's opinion of you.
   *
   * There is already a macaw pair and it is described as the voice here that is
   * not beautiful, so a second harsh bird needs a better argument than "more
   * ugly". It has one, and it is not about the timbre. A MACAW PAIR IS TALKING
   * TO EACH OTHER AND A PARROT MOB IS TALKING ABOUT YOU. A dozen amazons coming
   * out of one tree at once is what a rainforest does when something walks
   * underneath it; everything else within two hundred metres shuts up, and the
   * fact that you can hear them getting further away tells you they had been
   * watching you for a while.
   *
   * The sound is the difference too. A macaw screech is two formants and a
   * clean attack, one bird at a time, with space around it. THIS IS A CROWD:
   * three to eight squawks from four bearings, overlapping, densest at the
   * front and thinning out as the flock gets away. Each one is a
   * `_throat` with three short overlapping puffs laid across it at jittered
   * levels and rates — the tear that was the jay's whole trick, and it is kept
   * because it does exactly the same job here: raggedness in the amplitude of a
   * sound whose spectrum never moves, which reads as a voice under strain
   * without one filter parameter being automated anywhere.
   *
   * SEVERAL BEARINGS IS THE POINT AND IT IS WHAT MAKES IT A FLOCK. The jay was
   * one source shouting several times, which is a bird. Panning short events
   * around you from different directions over a second and a half is a flock,
   * and there is no other way to get that: level and density cannot say "these
   * came from different places".
   *
   * FOUR BEARINGS, NOT ONE PER BIRD, AND THE FIRST VERSION DID IT PER BIRD.
   * Every `_place` is an HRTF PannerNode, which is a convolution and the most
   * expensive node this project creates — a nine-bird flock was nine of them,
   * on top of the ~45 nodes the throats and tears already cost, and it took the
   * peak concurrent voice count to 49 of 58. That is not a failure but it is
   * most of the headroom a flush spike needs.
   *
   * The cap is four because the ear cannot do better. Localisation blur for a
   * broadband transient is a good ten degrees, the whole burst is over in two
   * seconds, and the events overlap — nobody has ever resolved nine
   * simultaneous bearings and four is already more than a listener will count.
   * Birds are assigned round-robin, so consecutive squawks always come from
   * different directions, which is the part that actually reads.
   *
   * Levels stay well down per bird, because eleven of them sum. A loud
   * unpleasant thing every ninety seconds is a reason to turn the forest off.
   *
   * `worldBus`, on the macaw's precedent: distant birds on the chorus's own
   * schedule, not an impact.
   */
  parrots(position, nearness = 0.6) {
    if (!this.built || this.voices > VOICE_CEILING * 0.5) return;
    const rng = this.rng;
    const t0 = this.ctx.currentTime + 0.02;
    /**
     * How many birds go up, against how much room there is to put them.
     *
     * Eleven birds is about forty nodes, which is most of the ceiling on its
     * own, so the count is trimmed by what is already sounding rather than
     * being refused outright at the door. A thin flock is a flock; a flock that
     * does not happen because a deer was running is a silence in the one place
     * a silence reads as a bug.
     */
    const room = clamp01((VOICE_CEILING * 0.72 - this.voices) / 30);
    const birds = 3 + Math.floor(rng() * 4 * room + 2 * room);
    /**
     * The bearings, built once. See the block above the method — four panners
     * for up to eight birds, assigned round-robin so consecutive squawks never
     * share a direction.
     *
     * Spread grows with the index rather than with the bird, so the bearings a
     * straggler uses are the wide ones: the flock is scattering, and the last
     * thing you hear is the furthest out.
     */
    const BEARINGS = 4;
    const nodes = [];
    for (let b = 0; b < Math.min(BEARINGS, birds); b++) {
      const spread = 4 + (b / BEARINGS) * 16;
      const a = rng() * Math.PI * 2;
      _mobAt.x = position.x + Math.cos(a) * spread * rngRange(rng, 0.4, 1);
      _mobAt.y = position.y + rngRange(rng, -2, 5);
      _mobAt.z = position.z + Math.sin(a) * spread * rngRange(rng, 0.4, 1);
      nodes.push({
        spatial: this._place(_mobAt, { refDistance: 14, rolloff: 1.05, maxDistance: 220 }),
        at: { x: _mobAt.x, y: _mobAt.y, z: _mobAt.z },
      });
    }
    let last = t0;
    for (let i = 0; i < birds; i++) {
      const { spatial, at } = nodes[i % nodes.length];
      /**
       * The front of the burst is where the birds are, and the tail of it is
       * where they went. `i / birds` squared piles the first few almost on top
       * of each other and then lets the stragglers string out, which is the
       * shape a flock leaving a tree actually has.
       */
      const t = t0 + Math.pow(i / birds, 1.5) * rngRange(rng, 1.3, 2.2);
      last = Math.max(last, t);
      const level = 0.22 * (0.55 + nearness * 0.6) * rngRange(rng, 0.7, 1.1) * (1 - (i / birds) * 0.45);
      const length = rngRange(rng, 0.2, 0.36);
      this._throat(at, t, spatial, {
        high: rngRange(rng, 1400, 2000),
        low: rngRange(rng, 620, 820),
        snap: 0.08,
        tail: length,
        gain: level,
        rate: rngRange(rng, 0.86, 1.12),
      });
      /**
       * THE TEAR THINS OUT DOWN THE FLOCK, and it is a node budget rather than
       * a sound design.
       *
       * Every bird is five nodes with a three-puff tear on it and up to nine of
       * them go at once — measured, that put the peak concurrent voice count at
       * 49 of 58, which is not a failure but is most of the headroom the flush
       * spike needs. The front three birds keep the full tear because that is
       * the part of the burst anybody hears as texture; the stragglers get one
       * puff, which at their level and against two seconds of everything else
       * is inaudible as a difference and is two thirds of the cost.
       */
      const tears = i < 3 ? 3 : 1;
      for (let k = 0; k < tears; k++) {
        this._puff(at, t + 0.05 + k * rngRange(rng, 0.05, 0.1), {
          freq: rngRange(rng, 1000, 1700),
          q: 1.1,
          decay: rngRange(rng, 0.03, 0.055),
          gain: level * rngRange(rng, 0.3, 0.6),
          rate: rngRange(rng, 0.8, 1.25),
          spatial,
        });
      }
    }
    setTimeout(() => {
      for (const n of nodes) {
        try {
          n.spatial.dispose();
        } catch {
          /* already gone */
        }
      }
    }, (last - t0 + 2) * 1000);
  }

  /**
   * A crested guan, which is two sounds and the second one is the good one.
   *
   * The call is a hard honking double bark — "keh-LEEP", the second louder and
   * a beat behind — and on its own it is a `_throat` with low formants and
   * nothing remarkable about it. What makes a guan a guan is what follows about
   * half a second later: the WING DRUM, a burst of ten or a dozen hard mechanical
   * beats that accelerate into a rattle and die out. It is the only sound in
   * this forest that is percussion produced deliberately by an animal, and it
   * is the reason this bird is here rather than a third screecher — the file
   * has whistles, throats and impacts, and this is the one voice that is a
   * throat and an impact in the same breath.
   *
   * IT INHERITED THE PHEASANT'S MACHINERY AND IT FITS BETTER THAN IT DID
   * THERE. A pheasant claps its wings standing still, which is why the old
   * version had "no acceleration and no glide out, because a pheasant is not
   * going anywhere". A guan's drumming is done in flight, on a shallow dive
   * between two trees, and it speeds up as it goes — so the gap now shrinks
   * about six per cent a beat and the whole burst is a thing that moves. Same
   * eight lines; one of the numbers became a ramp.
   *
   * The beats are the flush's wingbeats an octave down and much harder: 130 Hz,
   * 28 ms, at a body size nothing else here has.
   */
  guan(position) {
    if (!this.built || this.voices > VOICE_CEILING * 0.6) return;
    const rng = this.rng;
    const t0 = this.ctx.currentTime + 0.02;
    const spatial = this._place(position, { refDistance: 13, rolloff: 1.15, maxDistance: 200 });
    for (let i = 0; i < 2; i++) {
      this._throat(position, t0 + i * rngRange(rng, 0.17, 0.24), spatial, {
        high: rngRange(rng, 940, 1220),
        low: rngRange(rng, 300, 400),
        snap: 0.05,
        tail: i ? 0.19 : 0.11,
        gain: 0.34 * (i ? 1.2 : 0.75),
        rate: rngRange(rng, 0.9, 1.08),
      });
    }
    if (rng() < 0.75) {
      const beats = 9 + Math.floor(rng() * 6);
      let t = t0 + rngRange(rng, 0.48, 0.72);
      let gap = rngRange(rng, 0.072, 0.086);
      for (let i = 0; i < beats; i++) {
        this._puff(position, t, {
          freq: rngRange(rng, 105, 160),
          q: 0.5,
          decay: 0.028,
          // Swells into the middle of the dive and then goes away with it,
          // rather than starting loud: the bird is coming past, not stopping.
          gain: 0.26 * Math.sin((Math.PI * (i + 0.7)) / (beats + 1.4)),
          rate: 0.5,
          spatial,
        });
        t += gap;
        gap *= 0.94;
      }
    }
    setTimeout(() => {
      try {
        spatial.dispose();
      } catch {
        /* already gone */
      }
    }, 3200);
  }

  /**
   * An ornate hawk-eagle, and the only voice in this file that comes from the
   * sky.
   *
   * Every other sound here happens somewhere in or under the canopy: the macaws
   * are twenty metres up, the woodpecker is on a trunk, the owl is in a tree a
   * hundred metres off. A hawk-eagle is four hundred feet above all of it, out
   * over the river or a treefall gap, circling — so it is placed at a height
   * nothing else in the file uses and the effect of that alone is worth the
   * twelve nodes. You look UP, which no other event in this forest has ever
   * made anyone do.
   *
   * WHAT CHANGED WHEN THE BUZZARD BECAME THIS, and it is one number and a loop.
   * A buzzard's mew is one long plaintive cry, so the old version fired one or
   * two of them several seconds apart. A hawk-eagle's call is a SERIES —
   * "whee-whee-whee-whee-WHEEP", four to seven loud whistles that accelerate
   * slightly and climb a couple of semitones as they go, the last one the
   * highest and the most emphatic. So the cries are now a short train with a
   * shrinking gap and a rising root, which is the same twelve nodes arranged
   * into the shape of a different animal.
   *
   * The note itself is nearly unchanged and did not need to be. A raptor's cry
   * is a hard rise onto pitch and then a long sag — `arc` says up 4.5 semitones,
   * hold, down 3.9 — and that shape is common to both birds. `index` stays at
   * 0.3, like the motmot and the potoo and for the same reason: this is very
   * nearly a pure tone with a catch at the front of it, and any real brightness
   * turns a raptor into a kazoo.
   */
  eagle(position) {
    if (!this.built || this.voices > VOICE_CEILING * 0.7) return;
    const rng = this.rng;
    const t0 = this.ctx.currentTime + 0.05;
    const spatial = this._place(position, { refDistance: 45, rolloff: 0.8, maxDistance: 500 });
    const bus = this.ctx.createGain();
    bus.gain.value = this.songGain * 1.5;
    bus.connect(spatial.input);
    const cry = {
      decay: 0.5,
      index: 0.3,
      glide: 0,
      ratio: 1.0,
      arc: [4.5, 1.0, -3.9],
      lead: 2.4,
    };
    const cries = 4 + Math.floor(rng() * 4);
    // The whole train fits inside about three seconds, against the buzzard's
    // seven. It is one bird saying one thing, not two cries with a wait in
    // between, and the wait was most of what made the buzzard read as lazy.
    let gap = rngRange(rng, 0.62, 0.78);
    const step = rngRange(rng, 0.4, 0.75);
    const base = rngRange(rng, 93, 95);
    let t = t0;
    for (let i = 0; i < cries; i++) {
      _shape.glide = rngRange(rng, 0.85, 1.15);
      // The last one is held and is the one you hear from the ground.
      _shape.decay = rngRange(rng, 0.9, 1.2) * (i === cries - 1 ? 1.7 : 1);
      _shape.index = 1;
      this._note(
        bus,
        t,
        base + i * step,
        cry,
        0.24 * (0.8 + (i / cries) * 0.35),
        _shape
      );
      t += gap;
      gap *= 0.93;
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
   * A fig, a seed pod, a bit of dead twig, whatever a monkey has just dropped.
   * Three
   * or four bright ticks getting lower and further apart as it hits fewer
   * leaves on the way down, and then one dull knock on the litter.
   *
   * TEN NODES, and it is arguably the best value in the file. A wood is mostly
   * silence and the thing that makes silence read as an outdoor place rather
   * than as an audio gap is that it keeps getting interrupted by small physical
   * events that are obviously not addressed to you. A bird call is a
   * performance; a fruit falling is the world carrying on.
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
    // in the world and a fruit hitting it does not ring at all.
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
   * A mottled owl, a long way off.
   *
   * THE SPECIES CHANGED AND THE SYNTHESIS DID NOT, WHICH IS THE POINT WORTH
   * WRITING DOWN. This was a tawny owl and everything below was measured off
   * one — and a mottled owl, which is the owl of a Neotropical lowland forest,
   * gives a deep quavering hoot in the same 400-700 Hz band with the same long
   * hesitation in the middle of it. It also duets, so the female answer a fifth
   * up that this method already had turns out to be MORE true of the new bird
   * than the old. Nothing here needed retuning; the comment needed a new name.
   *
   * Three sines an octave apart with a slow scoop up and back down, a very soft
   * attack, and the classic hesitation. The quaver is a 7 Hz amplitude wobble —
   * on the GAIN, not on a filter, because a wobble on a filter cutoff is a
   * resonant sweep and we are not doing that.
   *
   * MEASURED, AND IT MOVED TWO THINGS. A study of male Strix aluco territorial
   * hoots puts note one between 320 and 805 Hz with its maximum at 592, and the
   * root here was 47 to 51 — a hundred and twenty to a hundred and fifty hertz,
   * an octave and a half under the real animal. That is the same error the
   * songbird table had and it had it for the same reason: an owl is the low one
   * in the wood, so it got written at the bottom of a piano.
   *
   * The other thing the measurements gave is THE SHAPE, which is better than
   * what was here. The real call is not two hoots four fifths of a second
   * apart. It is a long note, then very nearly FOUR SECONDS of nothing, then a
   * short grunt, then half a second, then the long quavering one — 0.72 s,
   * 3.87, 0.09, 0.58, 1.38. That enormous middle silence is the whole character
   * of the call and it is why an owl is the most atmospheric sound in any
   * forest: you have stopped waiting by the time the rest of it arrives.
   */
  owl(position) {
    if (!this.built) return;
    const ctx = this.ctx;
    const rng = this.rng;
    const t0 = ctx.currentTime + 0.05;
    const root = rngRange(rng, 65, 68);
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
      // Down from 0.42 with the retune: the same amplitude an octave and a half
      // higher is a good deal louder to a human ear, which is most sensitive
      // exactly where this voice has just moved to.
      const peak = 0.3 * level;
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
     * all — it is two owls a ridge apart, which is a genuinely nicer fact
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
      // Up with the male, and for the same reason. `arc` gives the shriek its
      // kink — it tears upward and then keeps going, rather than sliding.
      const shriek = {
        decay: 0.19,
        index: 0.85,
        glide: 9.5,
        ratio: 1.0,
        arc: [3.5, 1.2],
        lead: 2.6,
      };
      _shape.glide = rngRange(rng, 0.85, 1.15);
      _shape.decay = rngRange(rng, 0.9, 1.15);
      _shape.index = 1;
      this._note(bus, when, rngRange(rng, 76, 80), shriek, 0.5, _shape);
      this._puff(_owlAt, when, {
        freq: rngRange(rng, 1500, 2100),
        q: 0.9,
        decay: 0.03,
        gain: 0.28 * level,
        rate: 1.3,
        spatial: her,
      });
      /**
       * MEASURED FROM `when`, NOT FROM NOW, and this is a fix rather than a
       * tidy-up: she was inaudible.
       *
       * `when` is an absolute context time and this timer is wall clock from
       * the synchronous call, so a fixed 2600 only worked if she answered
       * within 2.6 seconds. She was scheduled at `t0 + 2.9` to `t0 + 4.4` — so
       * in the one-in-three case where the female answers at all, her
       * bus was disconnected between a third of a second and nearly two seconds
       * BEFORE her note sounded, every time, since the voice was written. The
       * male covered for it: you heard an owl either way and nothing about the
       * call sounded broken, it was simply always one bird.
       *
       * Same class of bug as the phrase teardown in `_phrase`, which carries
       * the same warning, and it wants the same shape: the only quantity that
       * is ever correct here is the distance from now to the end of the sound.
       */
      setTimeout(
        () => {
          try {
            bus.disconnect();
            her.dispose();
          } catch {
            /* already gone */
          }
        },
        (when - ctx.currentTime + 2.6) * 1000
      );
    };

    /**
     * The real running order, from the measurements in the docblock: long note,
     * the big silence, the little grunt, a beat, then the quavering one.
     *
     * The gap is jittered rather than fixed at the published 3.87 because the
     * one thing worse than a four second pause is the SAME four second pause,
     * and it is shortened a little because a bird that has been going all night
     * does too.
     */
    const restA = rngRange(rng, 2.7, 3.9);
    const restB = rngRange(rng, 0.5, 0.7);
    const grunt = t0 + 0.72 + restA;
    const last = grunt + 0.09 + restB;
    hoot(t0, rngRange(rng, 0.62, 0.8), false);
    hoot(grunt, 0.09, false);
    hoot(last, rngRange(rng, 1.2, 1.5), true);
    const done = last + 1.5;
    // A third of the time she is out there, and once in a while she goes first.
    const reply = rng();
    if (reply < 0.34) kewick(done + rngRange(rng, 0.6, 2.1));
    else if (reply > 0.9) kewick(t0 - 0.02);
    setTimeout(
      () => {
        try {
          spatial.dispose();
        } catch {
          /* already gone */
        }
      },
      // Follows the call instead of being a constant, which the old 4200 was —
      // and which the new arrangement would have torn down mid-hoot.
      (done - ctx.currentTime + 3.2) * 1000
    );
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
     * fruit keeps falling, the wind and the stream never noticed — because a
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
         * roster's own windows mean what is left is motmots, then a solitaire,
         * then a tinamou, a potoo and an owl. A forest going quiet is a better
         * use of dusk than a second chorus.
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
       * The macaw pair. Far, high, and only while there is light — parrots are
       * at the roost before the owl starts, so the two never overlap, which is
       * worth more than either of them alone: the moment you notice the macaws
       * have stopped is the moment the forest has actually changed.
       */
      if (dark < 0.62) {
        this._nextMacaw -= dt;
        if (this._nextMacaw <= 0) {
          const a = rng() * Math.PI * 2;
          const r = 45 + rng() * 85;
          _distantAt.x = listener.x + Math.cos(a) * r;
          _distantAt.y = listener.y + rngRange(rng, 8, 22);
          _distantAt.z = listener.z + Math.sin(a) * r;
          this.macaw(_distantAt);
          this._nextMacaw = rngRange(rng, 55, 165) * spacing;
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
       * The parrot mob, the guan and the hawk-eagle, which share a block
       * because they share a job: they are the three voices that are not part
       * of the chorus and do not sound like it.
       *
       * All three are rare on purpose and all three are rarer than they feel,
       * because each is the only thing of its kind. A flock going up every
       * ninety seconds is not a forest with parrots in it, it is a forest with
       * a parrot problem.
       *
       *   The PARROTS thin out toward dark but do not stop where the macaws do,
       *   because a roosting flock will blast off at an owl at dusk and that is
       *   arguably the most characteristic thing they do.
       *
       *   The GUAN is a dawn and dusk bird almost exclusively, so its interval
       *   is divided by both — the one voice here that is commoner in the last
       *   hour of light than in the middle of the day.
       *
       *   The HAWK-EAGLE needs thermals, which means it needs sun, so it is
       *   daylight only and it is placed higher than anything else in the file
       *   by a factor of five.
       */
      if (dark < 0.78) {
        this._nextParrots -= dt;
        if (this._nextParrots <= 0) {
          const a = rng() * Math.PI * 2;
          const r = 35 + rng() * 90;
          _distantAt.x = listener.x + Math.cos(a) * r;
          _distantAt.y = listener.y + rngRange(rng, 3, 14);
          _distantAt.z = listener.z + Math.sin(a) * r;
          this.parrots(_distantAt, clamp01(1 - r / 140));
          this._nextParrots = rngRange(rng, 70, 210) * spacing * (1 + dark);
        }
      }

      this._nextGuan -= dt;
      if (this._nextGuan <= 0) {
        const a = rng() * Math.PI * 2;
        const r = 40 + rng() * 80;
        _distantAt.x = listener.x + Math.cos(a) * r;
        _distantAt.y = listener.y - 1.2;
        _distantAt.z = listener.z + Math.sin(a) * r;
        this.guan(_distantAt);
        // Loudest at the two ends of the day. `dusk` peaks where `dark` is
        // halfway, which is the hour a guan goes up to roost shouting.
        const dusk = 1 - Math.abs(dark - 0.5) * 2;
        this._nextGuan = (rngRange(rng, 100, 280) * spacing) / (1 + this.dawn * 1.5 + dusk);
      }

      if (dark < 0.35) {
        this._nextEagle -= dt;
        if (this._nextEagle <= 0) {
          const a = rng() * Math.PI * 2;
          const r = 50 + rng() * 130;
          _distantAt.x = listener.x + Math.cos(a) * r;
          _distantAt.y = listener.y + rngRange(rng, 55, 110);
          _distantAt.z = listener.z + Math.sin(a) * r;
          this.eagle(_distantAt);
          this._nextEagle = rngRange(rng, 130, 340) * spacing;
        }
      }
    }

    /**
     * Something falling out of the canopy, close enough to make you look up.
     *
     * Deliberately NOT on the chorus wave's schedule and deliberately not
     * suppressed by anything: gravity does not care whether the birds are
     * singing, and a fruit landing in the middle of a lull is the best
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
     * read one and refuse the first wren of the new wood for no reason
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
/** The second macaw of the pair, which needs its own bearing. See `macaw`. */
const _macawAt = { x: 0, y: 0, z: 0 };
/** One bird of the parrot mob, rewritten per bird. See `parrots`. */
const _mobAt = { x: 0, y: 0, z: 0 };

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
