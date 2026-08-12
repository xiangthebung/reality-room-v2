# Reality Room

A procedural forest you can walk around in, a jukebox that plays music nobody
recorded, and the experience of slowly losing your grip on both.

Everything in here is generated at runtime — the terrain, the trees, the leaf
textures, the bark, the music, the birds, the water. There are no binary assets
in the repository at all.

```
npm install
npm run dev          # http://127.0.0.1:5180
```

---

## Milestone one

This build is the vertical slice: **one world, one jukebox, one trip, and a
debug panel to inspect the trip with.** No networking, no other players, no
second map. The point is to get the *feel* of the visuals and the audio right
before building anything on top of them.

### Controls

**`Esc` opens the settings, and the Controls page in there is the full list.**
It is rendered from `src/core/keys.js`, which is the single declaration of every
binding in the game — the handlers stay in the modules that own the behaviour,
and the documentation lives in one place so it cannot drift from them again. The
strip along the bottom of the screen is drawn from the same file and is
deliberately five keys long; persistent chrome is a stable man-made rectangle
welded to the glass, which is the one reference frame a trip must not be given.

The tables below are a copy for people reading the repository, and
`scripts/keys-check.mjs` fails if they disagree with `keys.js`.

| | |
|---|---|
| `W A S D` | move (or the arrow keys) |
| `Shift` | run |
| `Space` | jump |
| mouse | look (click to capture the pointer) |
| `E` | interact — sit down, board the ferry, cast, play the jukebox, eat a mushroom |
| `F` | take out a fishing rod, or put it away |
| left mouse | with a rod out: hold to load a cast, let go to throw |
| right mouse | with a rod out: wind the reel |
| `Q` | next track |
| `U` | paste a YouTube link at the jukebox |
| `G` | stand a speaker where you are looking — left first, then right |
| `N` | ground yourself; ends a trip immediately |
| `Esc` | settings, and back again |
| `` ` `` | open the debug panel |

Being with other people:

| | |
|---|---|
| `J` | open a room, and copy the invite link |
| `V` | hold to talk (or, on an open mic, force the gate open) |
| `X` | mute · `C` switch between open mic and push-to-talk |
| `Enter` or `T` | say something |
| `Tab` | hold to see who is here and how far away they are |
| `P` | put a screen up where you are looking, or take it away |
| `O` | move it to where you are looking now |
| scroll wheel | resize it, 1.2 m to 16 m |
| drag a video file onto the window | put a film on |

A shared screen is an object rather than a fixture. It stands up in front of you
the moment you share, moves to wherever you are looking, and is as big as you
make it — so a film happens at whichever fire people are already sitting at, and
not in the one clearing that had a screen in it.

Any movement key stands you up again. There is no "leave the seat" key,
because pushing forward is what a person does when they want to leave.

There is a patch of mushrooms about twenty metres from the clearing, and
fourteen more scattered through the wood. They glow faintly. Eating one starts a
five-minute trip; eating another during one extends it, with diminishing
returns.

## The room

The thing this is for is a group of friends who would otherwise be sitting in a
voice call: somewhere to be together and talk, with something to look at that
is not each other. Everything below follows from that, and from one constraint —
**nothing here may make it worse to be here alone.** With no `?room=` in the URL
and no key pressed, none of it touches the network at all.

**Voice is positional.** One `RTCPeerConnection` per person carrying one Opus
stream, spatialised through an HRTF panner at that person's head with a
directivity cone, so you can hear somebody turn away from you mid-sentence.
There is no mixing server, because mixing is the one operation that cannot be
undone. Rooms are capped at eight for that reason: your voice goes out N−1
times.

**Chat is transient.** Lines fade after twenty seconds and the log is empty on a
solitary walk. A speaker's name is drawn in the same hue their clothes are dyed
— `hueFromId`, a pure function of their id — because avatars deliberately have
no nameplates, and that colour is the only thing tying a sentence to a body.
Their aura flashes when they type.

**Screens.** `P` shares your screen, and it stands up on the ground you are
looking at, on two legs that reach for whatever is under them — one key, and you
are showing somebody something. `O` moves it to wherever you are looking now.
The scroll wheel makes it anything from a metre across to sixteen. Dropping a
video file onto the window puts a film up the same way, with no keys at all.

There is no fixture, and that is the point. The world used to have exactly one
fourteen-metre screen, in one clearing, which meant watching something together
happened where the screen was rather than where everybody already was — and
meant the code carried a claim counter to decide which of eight people got it.
A screen is now an object, so there is nothing to arbitrate: two screens in a
clearing is the same situation as two people in a clearing.

There was briefly a stage before the ground: a share began as a panel floating
beside you and `O` put it down. It went because nobody ever meant to stop there.
Every session did the same two keystrokes in the same order, which is the shape
of a default pretending to be a choice — and deleting it took with it the whole
notion of a screen whose position had to be derived from a body rather than
stated. A screen is somewhere, always, and the wire says where in five numbers.

The sound comes out of the screen through a panner, with a range that grows
with its size, so you can walk away from a film and hear it recede into the
trees. The picture is a real WebRTC video track over the same mesh, capped at
2.2 Mbit/s and 30 fps and given lower network priority than speech, because when
an uplink runs out the thing that must survive is the conversation. Resizing
sends none of it again: a bigger screen is the same texture on a bigger quad.

**Furniture, which is the actual mechanic.** A group that is all still walking
never settles into a conversation. So the world measures its own terrain and
puts a commons — a big fire with two rings of logs round it — plus three more
fires with rings of seats, two benches at viewpoints and three jetties over the
river into it, deterministically, from the seed, so two people in one room walk
to the same fire without a byte crossing the network to say where it is.
`scatter.js` is told about all of them so the forest leaves room; without that,
the site chooser picks the flattest ground for a hundred metres, which is
exactly where the forest most wants to be, and you get a gathering place in a
thicket.

Nothing in that list is a screen, and nothing in it used to not be: the commons
was built round a permanent fourteen-metre one. A place to sit and a direction
to face is the part that had to be authored; what you look at is now something
somebody brings.

**Two things to do with your hands.** Fishing: read the water, cast, wait,
notice, strike, and then play the thing. The waiting is still the feature — it is
long enough that you look away and sharp enough that you look back, which is the
shape of attention a conversation wants underneath it. What sits either side of
it are the two steps a real angler spends their attention on and a game almost
never models:

- **The read.** What is down there is a function of the depth of water under the
  float, and the channel is a metre and a half deep in the middle and nothing at
  the gravel edge. Minnows in the margin, pike in the trench — and you can see
  which is which, because there are fish in the river whether or not you are
  fishing for them. Three dozen of them work the top forty centimetres of the
  channel wherever you are stood next to it, rising to the surface, scattering
  from a badly placed cast, and now and then one clears the water altogether.
- **The cast.** Hold the left mouse button and the rod winds back; let go and the
  tackle leaves the tip at a speed you chose, on an elevation your head chose,
  and flies a real parabola until it hits something. It can fall short, overshoot
  into the far bank, or land in the grass. Where it lands is what you get.
- **The line.** Ten nodes of rope physics between the rod tip and the hook,
  inextensible and freely slack, so the sag is not drawn — it is what a hanging
  chain does. There are metres of it off the reel: the cast pays them out,
  winding takes them back, and it cannot be longer than it is. That last fact is
  what makes the bank a place. Your float drifts down and swings across on the
  current until it is out of the good water; walk away from it and you drag it;
  walk away from a hooked fish and you are pulling with your whole body, which
  loads the rod as fast as you are walking and parts the line if you run.
- **The fight.** A hooked fish runs, the line can break, and the hook can fall
  out. Hold the right mouse button (or `E`) to wind, and lean the rod against the
  run to put side strain on it — you may do one or the other, never both, which
  is the whole rule. A minnow comes straight in; a big pike is a dozen seconds of
  your attention and may still get off. The readout is the tackle, not a meter on
  the glass: the rod hoops, the line's sag goes out of it, the float rides under,
  and the line starts to sing before it parts. What you land comes out onto the
  grass at your feet, at its real length, and lies there kicking for a few
  seconds before it goes back in.

There is no inventory, no tackle to buy and nothing to unlock, and there never
will be — the moment any of those exists it stops being a thing you do while
talking and becomes a thing you are doing instead of talking. `npm run
check:fish` drives the whole loop, asserts that all three endings are reachable,
that the game is winnable by somebody following its own prompt, and that a fight
costs under 60 µs a frame.

And the ferry, a raft that spends its whole life going up and down the river,
calling at the landings. Its position is a pure function of the Unix epoch, like
the sun, so every client agrees about where it is with zero bytes on the wire.

The brief asked for a bus. A bus needs a road, and a road here is a hole in the
density field that plants every tree in an endless world. The river is already
that road — nothing grows in the channel and never will — so the tour goes by
water. `src/world/ferry.js` explains the trade at length.

### The debug panel

Press `` ` ``. Five pages — `1`–`5` pick one, and the search box at the top
searches all of them at once, because the one question anybody has is "where is
the thing that does X" and answering it with "not on this page" is the whole
cost of tabs.

**Every control says when it cannot matter.** This is the feature the panel is
built around. Nearly every number in here is a *ceiling multiplied by the trip
level*, so at level 0 dragging one changes precisely nothing; the sound knobs
additionally need audio to exist, a record to be playing, and — for the `Trip ·`
groups — the trip to be at full intensity before they mean what they say, and
two of them only touch a pasted link. A control that cannot matter right now is
disabled, dimmed, and captioned with the reason and what to do about it. Nothing
is hidden and nothing lies about being connected.

- **Trip** — phase buttons that jump to where each phase is *most itself*
  (not to the boundary, where the envelope has not arrived yet); **time**;
  **hold**, which pins the envelope so you can stand at exactly 0.6 and turn
  around slowly; **speed**, which multiplies the trip clock only, so the wind,
  the music and your legs stay at real time and a 20× seek is useful rather than
  comic; the family switches; the **gain sliders**, which multiply each family
  against its designed ceiling — anything above 1 is past what the design
  intends, and that is the point of being able to go there.
- **Render** — the whole quality registry the settings menu writes, plus the
  governor's own decision numbers, the output pass (bloom, exposure, vignette),
  dynamic resolution with a hand pin for looking at a low scale deliberately,
  and what the scene pass actually submitted.
- **World** — the hour, the day's speed, the wind's own clock, freeze,
  streaming counters, and a body you can make faster or fly.
- **Sound** — transport, **presets**, buses, live band meters, and every knob in
  `audio/tuning.js` grouped and folded, with an export that writes the source
  block to paste back over `DEFAULTS`. The presets are two banks that do not
  touch each other — the **record** (how music sounds whenever it plays) and the
  **trip** (what is done to it at full intensity) — so a pick from each composes,
  and clicking through one cannot move the other under you. A preset sets every
  knob in its bank, including the ones it does not change, so two clicks in a row
  are a comparison of two presets rather than of one preset with the leftovers of
  the other. `RR.presets.log()` prints the list with what each is for.

  Under them is **Explore**, which is what you use when none of the fourteen is
  quite it. It takes the sound you have now and offers five *neighbours* of it;
  you keep the one you like best, and the next five are neighbours of that, from
  a neighbourhood that closes in each round — a quarter of each slider's range at
  round one, a twentieth by round five. Each button names the biggest thing it
  changes (`shelf ↑↑ +3`) and the tooltip has the rest, so a pick is a decision
  rather than a coin toss. `keep` accepts *whatever you can currently hear*, so
  dragging a slider mid-search just folds in; `wider` is the answer when all five
  sound alike, `again` re-deals at the same distance, and `undo` walks back a
  round, because by round five you can be somewhere worse than round three and
  no amount of listening tells you that from the inside. Knobs that provably
  cannot be heard — the cabinet pair with no pasted link playing — are held
  still, since a candidate you can't hear is worse than a bad one.
- **Layers** — every object in the world that can put a pixel on the screen.
  Click to hide, shift-click to solo. It is the same list `RR.probe` bisects
  with from the console, so the two can never disagree.
- `[` and `]` step phases, `K` pauses, `\` toggles hold, `M` eats from anywhere.

**Pause is not the speed slider at 0.** `K` stops only *where in the five
minutes you are*: the phase, the level and the ego-death curve hold still, the
trip stops expiring, and the wind, the surges, the breath and every audio layer
carry on as normal. Speed 0 stops the trip's free-running clock as well, which
freezes the things you were listening for — no surges arrive, the sparks never
fire and the drone stops moving. Seek to ego death, press `K`, and the `Trip ·`
sound knobs mean literally what they say for as long as you want them to.

---

## What the trip actually does

The design constraint that shaped everything: **a trip must not look like a
filter on the screen.** A post-process effect is a function of screen
coordinates, so it is stuck to the glass, and the eye works that out in about
two seconds — turn your head and the pattern comes with you.

So almost all of it lives in the shaders of the actual objects, and every field
it evaluates is a function of **world position**.

### In the materials (`src/trip/living.js`)

One shared uniform block is injected into every world material via
`onBeforeCompile`.

- ~~**Veins of light**~~ — **removed 2026-08-11.** Narrow, branching,
  self-luminous filaments sampled from ridged 3D noise at world position, and
  for most of this project's life its signature effect. They were world-anchored,
  warm-capped, elongated along the grain and held to a tenth of each surface, and
  they still read as unrealistic every time they were looked at, because the
  problem was never how the lines were drawn — it was that they were lines, and a
  wood has none. What is left in their place is the light that was always broad:
  the moss glow, the edge contour, the canopy pulse, and the surface's own grain
  and fissures arriving with `uDetail`.
- **Regional colour** — a slow three-dimensional field at three scales, so one
  stand of trees goes violet while the ferns twenty metres away go gold, and the
  colour changes over the distance of a few paces rather than all at once.
- **Split toning** — shadows and highlights rotate in *opposite* directions.
  This is the term that most stops it reading as a tint, because a tint moves
  every pixel of a surface together.
- **Breathing** — per-surface displacement along the normal, driven by the same
  world field, so neighbouring trunks breathe out of phase.
- **The trees lean in** — canopies bow a little toward you, flex-weighted so the
  trunk bases stay planted. "Trees seem inviting" is a perceptual report, not a
  metaphor.
- **The hills get bigger** — the terrain's vertical scale is exaggerated as a
  function of *distance from the eye*, so the far ridge swells while the ground
  under your feet stays put. Near depth cues stay honest and far ones lie, which
  is the reported experience.
- **Ego death** — the surface term is **`unedge` 0.5 + `swarm` 1**, chosen
  2026-08-11 after shooting four candidates side by side. What was there was a
  luminance-keyed
  dither hashed off `floor(worldPos * cells)`, world-seeded so the swarm held
  still when you turned your head, and sized to about four pixels on screen at
  any distance so it would read as a swarm rather than as blocks. That last part
  is what killed it: a cell of uniform screen size everywhere is a *lattice*
  everywhere, and it was read back as "thousands of slightly see-through tetris
  blocks". A quantised domain is legible as quantisation whenever its cells are
  near-uniform on screen — the fix is a field with no cell at all, not a smaller
  one.

  The four live in `director.ego`, combine, and are on **Trip → Ego death** in
  the debug panel with one click per candidate — including one back to
  `shipped`, which reads `EGO_DEFAULT` itself rather than a second copy of its
  numbers. `npm run shot:ego` shoots all of them at two stations with the surge
  pinned to zero, which is the only way to compare them honestly: every amount
  in the director rides a ~19 s carrier, so two shots a minute apart are at
  different amplitudes of everything.

  **What ships, and why the other three do not.** `swarm` at full because it is
  the effect — it is the only candidate that does what the dither was for, and
  with the lattice gone there is no reason to hold its amplitude back. `unedge`
  at *half*, because at 1 the rim goes to nothing and objects stop having
  silhouettes entirely, which reads as flat rather than as dissolving; at 0.5
  the outlines are there and no longer reliable, and a surge still momentarily
  restores the edges it is dissolving. `fade` is a genuinely good quiet reading
  and is an *alternative* to the swarm rather than a layer under it — it takes
  the contrast the swarm needs to be legible. `unlight` is out for the measured
  reason below.

  | | what it does | cost |
  |---|---|---|
  | `fade` | the near world takes the colour of the air in it, keyed by `rrSolid`, so boundaries fail and local contrast collapses | one lerp |
  | `unedge` | fades `uRim` out as the dissolve rises: objects lose their outlines and the wood stops separating into things | one multiply |
  | `unlight` | pushes every pixel toward one luminance keeping its hue, so a trunk stops having a sunny and a shaded side | three instructions — but it *beiges the wood*, see below |
  | `swarm` | the dither's intent with none of its mechanism: `smoothstep` on a continuous fbm rather than `step` on a quantised hash | one fbm |

  `unlight`'s cost is worth stating because it is not a bug and cannot be tuned
  away: the output pass runs a fitted ACES, which compresses the largest channel
  hardest, so lifting a dark saturated colour into its knee pulls the channels
  together. Measured, the near canopy goes 20.8/33.8/12.1 → 63.7/52.0/22.4
  (green-dominant to red-dominant) and a shaded trunk goes 25.7/16.9/12.4 →
  54.0/53.1/14.3 — opposite directions, both toward grey. Flattening luminance
  in linear space does not survive a tone curve applied afterwards.

  `uDissolve` itself was never the problem and still drives the rest of the
  phase: the fov opening out, the fog thinning, the dolly, and the sub-50 Hz
  pulse in the audio.

#### The morph group — the surface moves, the object does not

Everything above displaces geometry: the trunk goes somewhere it was not. The
reports are the other way round, and very consistent about it — *the wall does
not come toward you; its texture swells while the wall stays where it is.* That
is not expressible by moving vertices, because moving vertices moves the wall.
It is only expressible by moving the **domain** the surface detail is evaluated
in, which is what `rrSurf` is: world position plus a slow warp that every
procedural field in the fragment shader reads instead of reading the raw
position. Change the warp and the bark grain, the ground litter and the moss
glow all move together, while the forest stays exactly where it was.

The warp is the **gradient** of a noise field, not three independent noises.
Same four taps, and a gradient field is curl-free — displacing along it spreads
the texture apart around the field's minima and gathers it in around its maxima.
Pure dilation and contraction, which is precisely "the distance between the
motifs seems to be changing". A field with curl in it would rotate the texture
instead, and rotating texture is what an oil slick does.

- **Swell** (`uSwell`) is multiplied by the breath, so it passes through zero
  twice a cycle: the surface inhales and exhales *in place*, no wave travelling
  anywhere, the whole image participating at once. Its effect scales as
  amplitude over feature size, so the same number heaves the bark fibre visibly
  and moves the hillside imperceptibly — the fine structure is alive and the
  shape of the world is not, which is the reported asymmetry.
- **Creep** (`uCreep`) does not change sign, so it is a steady drift: grain
  flowing through the wood and curling around its knots. The drawn maps go with
  it — bark and canopy cards are sampled at an offset UV so the picture and the
  procedural fields breathe as one skin. **The ground gets the breath and not the
  drift**: detail that flows steadily in one direction on a large smooth surface
  is a liquid, which is rule 5 all over again.
- **Detail** (`uDetail`) pushes the distance at which fine structure survives,
  and its amplitude near the camera. Nothing is added to the world; there is
  simply suddenly too much of it. Only a little distance, though — the first
  attempt pushed the fade to forty-eight metres and turned the hillside into
  leopard print, which at a grazing angle foreshortens into diagonal streaks.
- ~~**Order** (`uOrder`)~~ **is gone as of 2026-08-11**, with the vein filaments
  it organised. It drew contour rings first and then a third, finer filament
  family; both were versions of the same thing, which is a bright line lying
  along a noise contour, and a wood has no referent for that. `uDetail` above is
  what still makes a surface acquire structure as the trip deepens, and it was
  always the better mechanism — nothing is added to the surface, the surface
  simply stops being compressed.
- **The canopy pulse** (`uPulse`) is two plane waves crossing the forest. Every
  leaf card evaluates the same function of its own world position, so a thousand
  independently placed quads with no knowledge of each other inflate and brighten
  in step, and you can watch the crest travel across the wood. The swell is along
  the card's own normal — which points out from its cluster's centre, not off the
  face of the quad — so foliage inflates as a volume instead of sliding about.
  It is the term that makes a tree read as one organism.

#### And the melt has to actually change

All three octaves of `uFlow` used to share one domain and one clock, and the
dominant one was fifty metres across drifting at half a metre a second, so a
given tree sat in the same part of the field for a minute and a half. That
passes a screenshot and fails the experience: the forest was *bent*, permanently,
rather than moving — and a deformation that never changes is not a deformation,
it is a differently shaped forest. Each octave now has its own domain, weight and
clock, tilted toward the smaller and faster ones, and each is offset by a vector
travelling a **closed circle** rather than a straight line. A domain that orbits
comes back to where it started, so the field churns in place instead of sliding
past, and no part of the wood is ever left holding a pose.

### In the pipeline (`src/render/pipeline.js`)

**Nothing in the pipeline moves a pixel sideways.** Every pass is a function of
the pixel's own value — brightness, blur, accumulation, exposure, vignette. None
of them reads the frame at a different place from where it writes, and that
restriction is why the file is short.

- **Persistence is on the bloom chain, not the image.** Trails live in a glow
  accumulator that runs at an eighth resolution on already-blurred light, so
  bright things leave a soft wake and nothing can trace an outline. Two earlier
  image-space trails both failed the same way — see below.
- **No chromatic aberration anywhere.** It is the classic "trippy" effect and it
  is a lens defect, not a perceptual one.
- The vignette is **fixed and always on**, sober or not. A vignette that appears
  when the trip starts is an effect being switched on.

A displacing post-process lived here for most of the project's life — the melt.
It reconstructed each pixel's world position from the depth buffer, offset it
along a divergence-free curl of noise **in world space**, projected it back and
resampled at the difference, so the distortion was a property of the point in
the forest rather than of the pixel. It even carried a depth-gradient silhouette
guard to stop it sampling across occlusions. It still had to come out, and the
reason is rule 4 below.

### Six rules that exist because breaking them made artefacts

Play-testing produced two reports — "I'm noticing some lines during the trip, I
don't want to see any non-natural artifacts", and then "the trees look like
there's glass around them, and the ground looks like oil on water". Bisecting
them turned up several independent causes. Each is now a rule rather than a
tuning value.

1. **Plant motion is measured in the plant's own reach, never in metres.**
   Wind, breathing and the lean-toward-you term were authored against
   fifteen-metre trees. The same numbers reached knee-high grass, where they
   threw each blade's tip nearly three times its own height toward the camera —
   twenty thousand tufts stretched into spikes, which read as somebody having
   combed the ground. Every plant geometry now carries `aScale`, the metres it
   is allowed to travel, and every displacement multiplies by it.
   `npm run check:plants` fails the build if any plant can move more than 55% of
   its own height.

2. **A texture may not draw past its own canvas.** Leaf clusters, grass blades
   and fern fronds all overran their canvases — worst case 296 px on a 256 px
   canvas — so the alpha silhouette ended in a dead straight line, repeated on
   every card on every tree. Feathering the alpha afterwards does *not* fix it:
   thresholding a gradient over opaque content still gives a straight contour.
   The scatter is bounded so the shapes fit in the first place.

3. **Feedback that sees a sharp image will reproduce its edges.** The first
   trail offset the history by the whole melt displacement and peak-held it — a
   second copy of the picture eighty pixels away. The second advected a
   normalised direction field a fraction of a percent per frame, which is line
   integral convolution: iterate it for a few hundred frames and it draws the
   field's streamlines as fine parallel hairs. Measured by differencing a
   trailed frame against an untrailed one, the entire contribution was a
   hard-edged tracing of every trunk, blade and leaf in view. Persistence now
   only ever sees an eighth-resolution blur, where the artefact is impossible
   rather than merely tuned away.

4. **A bounded screen-space resample is a pane of glass.** This is what killed
   the melt, and no amount of guarding reached it. Over any patch where the UV
   offset is locally constant the pass translates the image rigidly; at the
   patch's border the offset stops, so there is a hard edge with a displaced
   picture on one side and the true one on the other. That is the optical
   definition of a sheet of glass lying in front of the scene, and it is what
   people saw: panes around the trunks. The silhouette guard made it worse,
   because a guard threshold is another border.

   The melt is now a **vertex** displacement — `uFlow` in `living.js`, the same
   world-space field applied to the geometry itself. There is no resampling, so
   no second copy of anything; occlusion falls out of the depth buffer for free,
   so there is no silhouette problem to guard against; and a trunk with nine
   rings up its length bends *through* the field instead of sliding behind it.

5. **The ground is the surface you judge everything else against.** A tree that
   has gone violet is a tree seen strangely; ground that has gone violet is not
   ground any more. The floor is also the one surface always in view, at a
   grazing angle, filling half the frame — so every effect applied to it is
   applied at maximum area. Two things were wrong at once: the hue rotation ran
   to 120°, which takes moss to magenta, and the vein network — right on bark,
   right on a rock — is foreshortened by a grazing floor into long sinuous bands
   of light on a smooth surface, which is a caustic. Between them the forest
   floor read as oil on water.

   Terrain now takes the same fields at a fraction of the amplitude: about 55°
   of hue, the width of the arc that still reads as earth. The veins were
   replaced with broad soft moss glow that has no filament to foreshorten — and
   four passes later that argument was applied to every other surface too, which
   is how the network came to be deleted outright. And
   the ground has real **relief** — a directional derivative of world-space
   noise, two scales, faded with distance — so it is made of something before
   the trip touches it. A smooth gradient cannot be made to look like earth in
   any colour.

6. **And neither can bark.** The next report was that the trees looked oily. It
   was never the veins or the colour: a trunk is a nine-sided tube carrying a
   256-pixel texture whose fissures are drawn at about eight per cent lightness
   contrast, so past a couple of metres the tile averages to nothing and what is
   left on screen is a smooth cylinder with one broad soft highlight down it. The
   eye reads a broad unbroken highlight as specular, and specular on wood means
   varnish. Put a warm colour wash and some added light on top and you have
   described a wet surface exactly.

   Rule 5's cure, applied to wood. Trunks now carry procedural fissures and fibre
   in the shader — a directional derivative of world-space noise squashed hard in
   Y, because fissures run *up* a trunk — plus a small additive lift on the raised
   side, because a multiplier does nothing to black and pine bark in shade is very
   nearly black. Two more things fall out of it. The grain is faded along `aFlex`,
   so deep bark is on the trunk, shallow bark on the boughs and none on the whips:
   the anisotropy is in world Y, and a horizontal branch crossing the squashed
   axis was coming out banded like bamboo. The vein filaments were also squashed
   by the same factor on bark so they ran *with* the grain — a smooth sinuous
   band of shifting colour looping around a curved trunk is not like an oil film,
   it is optically what one is. That bought them another few passes; it did not
   save them.

   The glow colour also stopped rotating on `uTime`, and that fix outlived the
   filaments it was written for. A coloured sheen that slides through the
   spectrum on a fixed surface has exactly one referent in the physical world. It
   takes its hue from the regional colour field instead, so the patch of bark you
   are staring at holds its colour and the change arrives as weather moving
   through the wood.

Plus two that were simply bugs. Pine "needles" were drawn with the broadleaf
routine, which made each one a metre long and fourteen centimetres wide; forty
radiating from a point is a starburst of straight black slashes against the sky.
They are now short needles combed along a bowed shoot, jittered — an even comb
on a straight shoot draws a **herringbone**, which is the same failure at a
smaller scale. And the sun shafts faded their silhouette on the
cylinder's **azimuth UV** — a coordinate fixed to the mesh's seam — so the fade
stayed on the same side of the shaft as you walked round it and the actual
outline kept full alpha to the last pixel. They rendered as knife-edged
seven-sided wedges. The fade is now `|N·V|`, which is both view-relative and the
physically right answer for a shell standing in for a volume.

### In the camera (`src/trip/director.js`)

A partial **dolly zoom**: field of view and camera translation move in
opposition, so the two cues the brain uses to judge distance disagree with each
other. No rigid room can produce that pair of signals, so it reads as the world
changing shape rather than as a lens. Plus a slow roll and a lateral drift, all
under a tenth of a metre and slower than a second.

The camera moves without the body, so collision and interaction range are
untouched.

---

## The audio

The complaint about the previous version was a **buzz**, and a buzz has a
specific cause: detuned sawtooth stacks behind resonant low-pass filters. A saw
has every harmonic at 1/n whether you wanted them or not, and a resonant filter
picks a band of them out and rings on it.

**There is no sawtooth anywhere in this project.** The replacement vocabulary:

- **Additive pads** — a handful of sine partials at chosen amplitudes. Every
  harmonic present is one somebody put there.
- **FM for anything struck** — bells, marimbas, plucks. Two sines and an
  envelope on the modulation index. It cannot buzz, because at the end of the
  envelope it is literally a sine wave.
- **Pink noise for percussion**, through wide band-passes. White noise through a
  high-Q filter is a whistle; pink noise through a wide band-pass is a brush.
- **Convolution reverb, never a feedback delay network.** An FIR has no
  recursion, so it cannot accumulate, self-oscillate or click however long it
  runs — which is the failure mode a cross-fed delay eventually finds.
- Every per-frame parameter write is a `setTargetAtTime` ramp. A direct
  assignment to an audio parameter is a click, and a click every frame is a buzz
  at the frame rate.

### The jukebox

Six tracks, sequenced against the AudioContext clock with a lookahead
scheduler, played through a `PannerNode` per speaker — so the music genuinely
muffles as you walk into the trees, and following the bass line back to the
clearing is a real thing you can do.

**It comes out of two speakers you can arrange.** There were two jukebox
cabinets, because a stereo record needs two positions and a `PannerNode` models
one point in space; two identical music machines in a clearing read as one object
duplicated by a bug, so they are a stereo pair now and say so. `G` stands one on
the patch of ground you are looking at — left first, then right, then left again
— using the same terrain march that puts a shared screen down (`world/aim.js`).
Moving one moves its collider, its panner, and the pasted record's own panner if
one is playing; the pair's single point light slides along the line between them
to whichever end you are standing at, because a light per speaker is a light per
fragment on every lit surface in the wood.

There was also a subwoofer between them, taking everything under 110 Hz off a
fourth-order Linkwitz-Riley crossover. It is gone, along with the crossover,
which existed for nothing else. The crossover MOVED a band rather than copying
it — this mix has a limiter five decibels from the top and a history of pumping
when anything is added down there — so on the synthesised jukebox, whose two
mono sources sum by amplitude to exactly what the sub was fed, the removal is
level-neutral. **On a pasted record it is not, by 1.55 dB**: its low band takes
two paths rather than one, and the sub's gain was fitted to those two paths at a
cabinet mix that has since moved, so the box had been quietly costing bass rather
than adding it. Measured at the limiter, giving that back costs nothing — swing
3.45 → 3.38 dB, mean reduction −2.71 → −3.23 dB, and half a decibel of steady
reduction is a volume control. The one visual thing the sub was for survives it:
the cone that moves with the bass is now the woofer in each speaker, which is
where a moving cone belongs.

Four of them are the wood's own voice. The last two — **Midnight Lounge** and
**Neon Drive** — are the records the machine came with, carried over from the
previous project's jukebox, because four variations on "unhurried and green" is a
shorter playlist than it looks and a lounge groove is what makes the jukebox feel
like an object somebody hauled into the clearing rather than a feature of the
landscape. Their arrangements are the originals to the note. Their *sounds* could
not be: the old pad was a detuned sawtooth stack behind a filter sweeping at
Q 1.1, which is not merely similar to the buzz that got the previous version's
audio rejected, it is the recipe for it. They are rebuilt from the additive / FM /
pink-noise kit, plus the two instruments the forest tracks never needed —

- a **snare**, because `brush` is deliberately not one and a lounge groove with
  no two and no four has no groove; two parallel filters off one noise source,
  because a single high-Q band at snare frequencies is a *pitch*, which is the
  buzz an octave up;
- a **hat**, whose corner sits at 4 kHz and not the 8 the original used. Built
  the obvious way it measured as producing exactly as much energy above 6 kHz as
  a track with no hats in it at all — pink noise has lost 3 dB/octave by the time
  it gets up there, and the bus tilt is low-passing at 5200, so it was squeezed
  from both sides. Fighting the tilt would have been the wrong fix: the tilt *is*
  the record's tone, and a lo-fi track played on a jukebox in a forest is
  supposed to be dark. Real hats on a dark record are dull.

Midnight Lounge also gets **surface noise** — one 8 ms impulse at about a fifth
of a step, scheduled between the beats rather than on them, because anything
periodic gets heard as percussion however quiet it is. It is the strongest single
cue that you are hearing a record being played in a clearing rather than music
piped into your head.

`audio-probe` now measures every track individually. It did not before, and once
the playlist stopped being four variations on one ambient patch that was a real
hole: the trip stages all run on whichever record happens to be loaded, so a
bright track could have sat there indefinitely without any threshold noticing.

Because the notes are synthesised rather than streamed, the trip can bend the
music itself: **tempo drags to about 87% and tuning goes ~14 cents flat at the
peak.** A streamed file could be slowed, but not without dropping its pitch by
the same amount, which sounds like a broken tape rather than like time behaving
strangely.

**The one documented exception** is `U`, which pastes a YouTube link at the
jukebox (`server/youtube.js`, `src/audio/external-track.js`). It is deliberately
kept as a second, separate thing rather than folded into the six tracks above:
`director.js` holds one reference to the synthesised `Jukebox`, captured once at
startup, so a pasted link is never bent by the trip and the birds never take its
key — the tempo/detune trick above only makes sense on notes being generated in
real time, and a slowed-down streamed file just sounds broken rather than
strange. What it gets instead is genuine stereo: the two channels are split and
each becomes its own spatial source, standing left and right of the cabinet,
rather than the mono `PannerNode` the six tracks share. This is a private/local
feature — the server resolves and streams audio via `yt-dlp`, which is against
YouTube's terms of service, an accepted trade-off for a project that isn't
publicly deployed. `yt-dlp` is a separate system dependency, not an npm
package; see `.env.example`.

### What the trip adds

A ten-second convolution space that opens early and closes last; a slow
non-resonant filter sweep on the send; a five-voice drone of sines and triangles
on a just-intonation scale seeded from the trip; soft noise swells synchronised
with the *visual* breathing; sparse FM bells thrown deep into the reverb; and a
sub-40 Hz pulse during ego death, which is below anything else in the app and so
arrives as a body sensation rather than as a sound.

---

## Verifying it

Four scripts drive the real app in a real browser. The dev server must be
running.

```
node scripts/shoot.mjs          # screenshots at every phase, from fixed stations
node scripts/audio-probe.mjs    # spectrum analysis of the master bus
node scripts/record.mjs         # records a WAV you can actually listen to
node scripts/perf.mjs           # frame timing at each phase
node scripts/debug-check.mjs    # drives the debug panel and asserts it works
node scripts/play-check.mjs     # plays through jukebox + mushrooms, no debug panel
node scripts/fish-check.mjs     # the whole fishing loop: read, cast, knock, fight, cost
node scripts/check-plants.mjs   # asserts no plant can stretch into a streak
node scripts/bisect.mjs ...     # one frame with any layer or effect switched off
node scripts/isolate.mjs melt   # how much one effect contributes, world frozen
node scripts/motion.mjs         # frames over time, for temporal artefacts
node scripts/morph.mjs --still  # does the surface actually move? see below
```

`morph.mjs` answers the one question a still cannot: whether anything is
happening. It parks the camera against a trunk, on the floor, under a canopy and
out in the clearing, holds the intensity with the envelope override so every
clock keeps running, and takes the same frame four times a couple of seconds
apart. Flip between them. If the pixels are the same, the effect does not exist
however good the single frame looks — which is exactly the state the melt was in
before its octaves were given separate clocks. `--still` switches the camera
family off, because the dolly and the fov drift move every pixel by themselves
and are therefore enough to hide the answer.

`bisect` is the one to reach for when something looks wrong. It drives
`window.RR.probe`, which can hide any world layer (`--hide=leaves`), keep only
some (`--only=ground,sky`), switch off any effect (`--off=melt,trail,bloom`) or
scale one (`--gain=glow=0`) — all without editing a file or losing the camera.

**Two traps, both of which produced confidently wrong conclusions before they
were understood.** `--freeze` stops `uTime`, which also stops the melt field and
the flow, so a frozen still is structurally incapable of showing a temporal
artefact and will exonerate a trail by construction. And any two frames taken a
moment apart in a forest where the wind is blowing differ along every edge in
the picture, which looks exactly like the artefact you are hunting —
`isolate.mjs` freezes the trip clock *and* the wind before differencing, which
is the only way the number means anything.

`audio-probe` is the regression test for the buzz. It reports spectral centroid,
the fraction of energy in 2–6 kHz, peakiness and flatness at each phase, and
fails if anything drifts back toward bright-and-dense. Current state:

```
stage                 rms      peak     centroid   harsh   peaky  flat   clip
sober + music         0.0381   0.192    2551 Hz    0.297   81     0.184  0
♪ Understory          0.0340   0.180    2597 Hz    0.278   54     0.195  0
♪ Sun Through Leaves  0.0496   0.200    1956 Hz    0.262   110    0.115  0
♪ Deep Green          0.0297   0.104    1645 Hz    0.249   126    0.071  0
♪ Nightjar            0.0336   0.185    1892 Hz    0.288   86     0.087  0
♪ Midnight Lounge     0.0401   0.228    2254 Hz    0.270   50     0.154  0
♪ Neon Drive          0.0442   0.245    2507 Hz    0.273   58     0.188  0
onset                 0.0490   0.214    1556 Hz    0.236   123    0.066  0
peak                  0.0929   0.360    1502 Hz    0.170   170    0.102  0
egodeath              0.1524   0.540    1217 Hz    0.146   206    0.078  0
```

The centre of mass falls as the trip deepens — the room gets bigger and darker,
not brighter and harsher — and nothing clips. The two imported tracks are the
loudest and the second brightest on the machine and still sit inside every
threshold; Midnight Lounge has the *lowest* peakiness of all six, which is the
number that would have caught the old saw-and-resonance pad.

`record.mjs --tracks` records the playlist instead of the trip, sober, an equal
slice per record — and taps the jukebox rather than the master, because the
master carries wind, birds, a stream and a limiter. That confound is not
academic: measured through the master, a hat change that turned out to be a 4×
difference at the source registered as 0.00002, and the limiter made the busiest
arrangement read as having the *least* treble.

---

## Performance: the regression gate and the bottleneck report

The scripts above answer "does it still look right". These answer "is it still
fast, and if not, what is eating it" — repeatably, automatically, and from an
instrument that is **compiled out of the build that ships**.

```
npm run perf:baseline        record what fast means, on this machine, today
npm run perf:bench           measure and compare — exits non-zero on a regression
npm run perf:why             why is this frame slow: fill vs vertex, levers, layers, hitches
npm run perf:spikes          what caused that 200 ms frame — per-phase, with the world running
npm run check:perfstrip      prove none of the instrument reaches a player
npm run perf:serve           build and serve an instrumented PRODUCTION bundle on :5182
npm run perf:bench -- --build   …and measure that instead of the dev server
```

`perf:bench` gates on two different kinds of number, because they fail in
completely different ways.

**Draw calls and triangles are all but exact.** They do not care what else is
running on the machine, so they can be believed on one sample — which makes
them roughly ten times sharper than any timing. Most real regressions trip this
half first, and it tells you *which layer*. The "all but" is the streamer: which
sectors are resident depends on where the camera came from, so the gate uses a
tight tolerance measured from the baseline passes rather than a zero.

**Timings drift ±40% between runs of identical code.** So no absolute is ever
gated. Each scenario is expressed as a ratio to the *run level* — the median
scenario of the same session — which divides the machine's mood out. The
tolerance per scenario is three times the spread that scenario actually showed
while the baseline was being recorded, so the expensive stations end up with
±8% gates and the cheap noisy ones with ±36%, automatically.

The blind spot is stated rather than hidden: a change that makes *everything*
slower by the same factor moves no ratio and trips nothing. The absolutes are
printed on every run for exactly that reason.

### Four things it does that a naive harness does not

**It waits for the world to arrive.** Teleporting invalidates the streamed set,
and both rings accept one sector per frame. The first version of this measured
the deep station at 249 draw calls and 21.3 M triangles on the frame after
arrival, and 130 calls and 11.3 M triangles five frames later. A station is not
ready until two consecutive frames agree on both counters *and* both queues are
empty.

**It seats the camera on the body every simulation step.** The real loop does
`applyToCamera()` then `director.update()`, every frame. Run thirty director
steps after a single seat and the trip's dolly and sway compound thirty times:
with the body pinned at (−30, −40) the camera arrived at (−10.4, −26.5, −25.5)
on one visit and (−45.6, **+24.6**, −54.3) on another, twenty-six metres in the
air, with the FOV drifting 73.9° → 59.0°. Every number was real, repeatable
within a batch, and about a different picture each time. The camera pose is now
recorded with every scenario and printed as `eye 0.00m`.

**It never runs an arm in a fixed position.** Every comparison in `perf:why` is
A-B-B-A, so drift that is linear in time cancels in the paired difference, with
a bootstrap interval over the pairs. Anything whose interval straddles zero, or
that is smaller than the rig can resolve, prints as *below the noise floor*
instead of as four decimal places.

**It turns off the two trip effects whose phase cannot be pinned** — the surge
and the camera family. The surge read 0.31, 0.0001, 0.11 and 0.96 across four
visits to one station, and it multiplies the glow, swell, melt and fog. The
suite therefore measures the trip's *steady state*; that is a stated limit of
what it covers, not a claim they are free.

### What it found

**The frame spikes were the pre-warm aiming at the wrong render target.** A
program's identity in three includes the output colour space of whatever is
bound. `compileAsync` with nothing bound compiles for the default framebuffer
(`srgb`); this pipeline never draws the scene there — it draws into
`sceneTarget`, a linear HDR buffer needing the `srgb-linear` variant. So the
pre-warm built variants that were thrown away unused, and the materials it was
meant to cover compiled synchronously on first sight, mid-walk: `campfire-flame`
at 176 ms and `campfire-embers` at 134 ms, the only frames in a 15,000-frame
session a player would have seen drop. Binding the scene target first fixes it —
and drops startup from 63 compiled programs to 39, because two dozen of them
were the wasted `srgb` copies.

Two further materials were compiling on first sight for a different reason —
caves stream in near a mouth and a share screen does not exist until somebody
shares one, so `compileAsync` over the scene could not reach either. Both are
now warmed from throwaway stand-ins (`caveWarmupObjects`, `videoWarmupObjects`),
and the stand-in has to match the real object attribute for attribute: a bare
triangle warmed a program the real indexed cave mesh did not use. A 25-second
walk now compiles nothing, and dropped frames are down to 3 in 13,123 — one
every 73 seconds, none of them a shader.

**Nothing else in `frame()` is close.** Timing every phase (`perf:spikes`
wraps them from the probe, so no engine code is touched): on the worst frame of
a run, `render` was 236.9 ms of 242.4 ms — 98%. Every other phase — cull, fauna,
net, audio, social, gathering, caves — has a p99 under 1 ms. Instance repacking
in particular is *not* a hitch cause: frames where the culler moved over 5,000
instances rendered in 3.60 ms against 4.10 ms for frames where it moved nothing.

**The frame is fill-bound looking up and vertex-bound looking out.** At the
clearing, sober, 74% of the frame does not scale with pixels; in the canopy at
peak it is 50/50. There is no single answer to "should we drop the resolution" —
it depends where you are standing, which is why the suite has four stations.

**Trunks are 73% of the triangles and 8% of the cost.** The per-layer census
(exact draw calls and triangles by toggling visibility, next to marginal ms):

```
layer      draws  triangles  instances  cost      ms/Mtri
trunks     25     6.90M      3622       0.37 ms   0.05
leaves     14     1.77M      3863       1.90 ms   1.07
grass      1      413766     22987      0.54 ms   1.32
ground     21     268800     0          0.08 ms   0.30
```

Leaves cost 21× more per triangle than trunks, and grass 26× — they are
alpha-tested cards paying per pixel, not per vertex. Reducing trunk geometry is
close to worthless; the money is in leaf and grass overdraw. At the clearing,
grass is the single most expensive layer in the frame off 3% of its triangles,
and **hiding the ground makes the frame slower** (−0.27 ms) because it is the
best early-Z occluder in the wood — measured automatically, with a confidence
interval, rather than remembered.

The one lever taken from that: the vein filaments on grass and ferns were the
costliest fragments in the wood per unit of effect, so they became a quality
knob (`plantVeins`, off below High). Paired A-B-B-A put them at 0.11 ms at the
clearing at peak and 0.28 ms in the canopy, and nothing at all when sober.

**The filaments were removed outright on 2026-08-11** — not for cost, for looks;
they were read back as unrealistic once too often, and no amount of tuning how a
bright line is drawn fixes the fact that a wood has no bright lines in it. Every
surface now gets that saving unconditionally and the knob is gone with them. See
the tombstone in `src/trip/living.js`.

The measurement is also a warning. The first estimate was 0.56 ms, from differencing
two census runs taken minutes apart — which measures the machine's mood as much
as the change. Only the paired design inside one session survives here, and the
framework's own statistics are what caught it.

### Compiled out, and proved so

`__PERF__` is a build-time literal (`vite.config.js`). In the shipping build it
folds to `false`, the branch in `main.js` dies, and the dynamic import behind it
leaves Rollup with no reachable reference — so the chunk is never emitted. A
*static* import would not do this.

`check:perfstrip` builds both bundles and asserts every fingerprint is absent
from `dist/` **and present in `dist-perf/`**. The second half is what makes it a
test: without it, the check passes when the fingerprints are stale. It caught
exactly that on its first run — `egodeath` looked distinctive and is also a trip
phase id in `src/trip/state.js`, so it reported a strip failure that had not
happened. It then boots the shipping bundle for real and requires it to draw
over a million triangles, because "stripped" and "still works" are two claims
and only the second one matters to a player.

```
dist        4 files, 1123.0 KiB
dist-perf   6 files, 1132.5 KiB
the instrument costs a player   9.5 KiB — and does not pay it
```

---

## Layout

```
src/
  core/util.js          maths, RNG, value noise, frame clock
  world/
    terrain.js          the height function; single source of truth for "ground"
    forest.js           trees, undergrowth, rocks, logs, mushrooms
    trees.js            the branch grower and the species table
    textures.js         every texture, drawn on a canvas at load
    atmosphere.js       sky, sun, shafts, mist, motes, water
    speakers.js         a stereo pair, standing wherever you put them
    aim.js              the patch of ground you are looking at, shared by
                        anything you can stand somewhere
    sites.js            where people meet — measured from the seed, and the
                        one module the forest worker can also import, so the
                        scatter can leave room for it
    gathering.js        the commons, the benches, the jetties
    campfire.js         every fire in the world, in four draw calls
    video-surface.js    a screen, standing where somebody put it
    ferry.js            the raft, on the epoch clock
    shoal.js            fish in the river, and the fish shape everything uses
  player/
    controller.js       the body
    seats.js            somewhere to sit down
    fishing.js          throw it, watch it land, wait, strike, and play it out
  net/
    index.js            other people, and where their pictures hang
    socket.js           membership, signalling, 18 Hz transforms
    mesh.js             one peer connection each: voice, screen, screen sound
    voice.js            the microphone chain and a panner per person
    share.js            getDisplayMedia, and films dropped on the window
    protocol.js         the wire, in one place
  render/pipeline.js    scene → bloom → glow → tone map
  trip/
    living.js           the shared material injection. The important one.
    state.js            the clock and the envelope
    director.js         intensity → every number the rest of the app needs
  audio/
    engine.js           the graph, buses, limiter, spatial sources
    music.js            the jukebox's four tracks and its instruments
    ambience.js         wind, birds, stream, footsteps
    trip-audio.js       space, drone, breath, sparks, pulse
    impulse.js          generated impulse responses
  ui/
    hud.js              three elements, and no more
    debug.js            the panel
```

## Safety

Nothing in here modulates luminance above 3 Hz — the ego-death dither reseeded at
2 Hz and the `swarm` candidate that may replace it drifts at about 0.9 Hz, the
breathing runs at about seven cycles a minute, and there is no node anywhere
that can produce a full-field flash. **Any new ego-death treatment has to clear
that bar**: for a drifting noise field the number to check is the domain speed
times the finest octave's spatial frequency, not the speed on its own. `N` ends a trip immediately from
any state.
