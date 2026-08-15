/**
 * Settings: the registry, the preset ladder, and the Auto governor.
 *
 * WHY THIS IS A REGISTRY AND NOT A PILE OF IMPORTS.
 *
 * Every knob worth having lives in a file that already has an owner — the pixel
 * ratio is a module-private `let` in main.js, MSAA is a render target inside the
 * pipeline, the fog base is in atmosphere, mouse sensitivity is in the
 * controller. A settings module that reached into all of them would have to
 * import half the app and would break the moment any of those files moved a
 * field. So it does the opposite: it knows the NAMES of the knobs and nothing
 * else, and whoever owns the knob calls
 *
 *     quality.register('renderScale', (v) => { renderScale = v; resize(); });
 *
 * from inside their own module, where the private state actually is. Setting a
 * knob nobody registered is a no-op, not a crash, and the menu draws that
 * control disabled with a note saying so — a settings panel that throws because
 * a subsystem has not been wired yet is worse than one that admits it.
 *
 * A knob may have SEVERAL setters. `motionIntensity` is one slider that scales
 * both the head bob and the trip director's camera family, because to a person
 * who needs it turned down those are the same thing.
 *
 *
 * WHY AUTO IS SHAPED THE WAY IT IS.
 *
 * The naive version of this feature — measure fps, if it is low drop a level —
 * is measurably worse than a fixed setting, and every part of the design below
 * is a specific defence against a specific way that version fails. See the
 * AutoGovernor block comment.
 */

/* -------------------------------------------------------------------------- */
/* the knobs                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The quality ladder, worst to best. Auto walks this and nothing else.
 *
 * `high` is deliberately IDENTICAL to what the app shipped with before any of
 * this existed: render scale 1, MSAA 2, 2048² shadows, bloom and wake on, fog
 * as authored, full densities. That is not a coincidence and it is not
 * aesthetic — it is what makes every screenshot and perf script in scripts/
 * still reproducible. A fresh browser profile with nothing in localStorage and
 * `navigator.webdriver` set renders exactly the frame it rendered yesterday.
 */
/**
 * `potato` IS A DIFFERENT PICTURE, NOT A DIMMER ONE, AND THAT IS THE WHOLE
 * POINT OF IT.
 *
 * The four rungs above it were, for their entire history, a RESOLUTION ladder
 * wearing a quality ladder's clothes. Measured at the deep station
 * (`.perf/presets.json`): low submits 16.08 M triangles and ultra submits
 * 16.21 M — the triangle count moves by ONE PER CENT across the whole ladder,
 * and every millisecond of its 44% of travel is bought with pixels, MSAA and
 * shadow texels. Fitting frame time against resolution at low gives
 * `1.53 ms + 0.319 ms/Mpixel`, so three quarters of that frame does not care
 * how many pixels you ask for. Deleting 71% of every fragment in the picture
 * buys 0.37 ms; hiding the canopy alone buys 1.10 ms.
 *
 * So a machine at the bottom of the old ladder had already spent every lever
 * the menu owned and was still drawing the same wood. That is why the last rung
 * was worth the least — medium to low is 0.27 ms, the smallest step there is —
 * and why "turn the resolution down", the advice a struggling machine will
 * inevitably be given, is worth 0.22 ms.
 *
 * `potato` exists to remove GEOMETRY, which is the only thing left that costs
 * anything. It is allowed to look like a different game: the brief it was built
 * to is "for people with bad PCs that just need to talk", and a wood you can
 * stand in and hear at 200 fps beats a wood you cannot enter. Measured at deep,
 * it takes the frame from 2.01 ms to 0.72 ms — 78% of the triangles gone.
 *
 * AUTO IS ALLOWED TO REACH IT, deliberately, and this was argued both ways.
 * The case against is that a level change rebuilds ~22 shader programs and this
 * project has already shipped that hitch once from a different cause. The case
 * for is decisive: the people this rung exists for are exactly the people who
 * will never open a settings menu to find it. Potato introduces no recompile
 * class that `low` does not already trigger, so it costs one more of a hitch
 * that already exists, once, on a machine that is drowning. Revisit this if the
 * impostor canopy lands and brings a material swap with it.
 */
export const LEVELS = ['potato', 'low', 'medium', 'high', 'ultra'];
export const DEFAULT_LEVEL = 'high';

/**
 * Every setting, declared once.
 *
 * `presets` is indexed by LEVELS, and only exists for knobs Auto is allowed to
 * touch. Knobs without it (volumes, comfort) have a `default` instead and are
 * never moved by anything but the player.
 *
 *
 * `group` AND `advanced`, WHICH ARE ABOUT THE MENU AND NOT ABOUT THE ENGINE.
 *
 * `group` names the page of the settings panel a knob is drawn on, and the four
 * of them — graphics, audio, controls, accessibility — are the pages every game
 * that has ever shipped an options screen uses, in that order. They are a
 * presentation fact, so moving a knob between them changes nothing but where
 * you look for it: `fov` was filed under "comfort" and is a view setting,
 * mouse sensitivity was filed with it and is a control.
 *
 * `advanced` folds a knob into the disclosure at the bottom of its page. The
 * test for it is NOT "is this hard to understand" — it is **would a player who
 * has already chosen a quality preset ever need to move this one by hand?**
 * Anti-aliasing, shadow map size, bloom, the mote count and the undergrowth
 * density are all things the preset row exists to decide, and a panel that
 * offers all nine of them at the same weight as View distance is asking every
 * player to do the job Auto is already doing for them. Nothing is removed —
 * one click is not hiding — but the first thing you see is the six settings
 * somebody actually came here to change.
 */
export const KNOBS = [
  // ---- graphics ----------------------------------------------------------
  {
    id: 'renderScale',
    group: 'graphics',
    advanced: true,
    label: 'Render scale',
    kind: 'range',
    /**
     * 0.35 rather than 0.5, because 0.5 was the floor of a ladder that had no
     * rung below `low`. Measured at low against a fixed scene, the fit is
     * `1.53 ms + 0.319 ms/Mpixel` — so the travel from 0.5 to 0.35 is worth
     * about 0.15 ms on its own, which is not much and is not nothing on a
     * machine that needs all of it. It is genuinely ugly and it is meant to be
     * available anyway; see the potato note on LEVELS.
     */
    min: 0.35,
    max: 1,
    step: 0.05,
    /**
     * The biggest single lever there is: 56% of the frame, measured by undoing
     * it against the shipping config. It multiplies a pixel ratio that is
     * already capped at 1.4, so 1.0 here is not "native" — it is the cap, and
     * there is deliberately nothing above it. Supersampling past 1.4 was tried
     * and reverted for being invisible at arm's length and a third of the
     * budget; re-exposing it as an Ultra option would just be re-litigating
     * that with a slider.
     *
     * WHICH THE PANEL HAS TO ADMIT, AND USED NOT TO.
     *
     * It read "1.00×" at the top of the slider and said "Internal resolution"
     * underneath, and both of those mean "native" to anybody reading them —
     * they describe a control that is doing nothing at its default, on a
     * machine that is in fact rendering at min(devicePixelRatio, 1.4). On a
     * 2× display that is a quarter of the pixels the number promises. So the
     * top of the travel now says `Max`, which is the one word that is true
     * whatever the display is: it is the ceiling, and the ceiling is not the
     * panel's to raise. The exact figure stays out of the format string on
     * purpose — the cap lives in main.js, and a copy of it here would be a
     * second source of truth that nothing would ever check.
     */
    presets: [0.45, 0.65, 0.8, 1, 1],
    format: (v) => (v >= 1 ? 'Max' : `${v.toFixed(2)}×`),
    hint:
      'Internal resolution, as a fraction of the ceiling rather than of your display — ' +
      'the ceiling is 1.4× device pixels and Max is that, not native. ' +
      'The largest single cost in the frame.',
  },
  {
    id: 'msaa',
    group: 'graphics',
    advanced: true,
    label: 'Anti-aliasing',
    kind: 'enum',
    options: [
      { value: 0, label: 'Off' },
      { value: 2, label: '2×' },
      { value: 4, label: '4×' },
    ],
    /**
     * Worth ~20%. Off is genuinely ugly here rather than merely softer: a
     * forest is hundreds of thousands of alpha-tested leaf edges and without
     * multisampling the canopy fizzes, then the glow accumulator smears the
     * fizz. Low and Medium both have it off because a machine on either has
     * already lost that argument; it costs 0.2 of a luminance point at the
     * camera stations the level-consistency work measures, so it is one of the
     * few graphics knobs that changes the frame's cost without changing what
     * the frame is a picture of.
     */
    presets: [0, 0, 0, 2, 4],
    hint: 'Multisampling on the scene buffer. Off makes the canopy fizz.',
  },
  {
    id: 'shadows',
    group: 'graphics',
    advanced: true,
    label: 'Shadows',
    kind: 'toggle',
    presets: [false, false, true, true, true],
    hint: 'Sun shadows. Already only redrawn when the sun anchor steps.',
  },
  {
    id: 'shadowMapSize',
    group: 'graphics',
    advanced: true,
    label: 'Shadow detail',
    kind: 'enum',
    options: [
      { value: 1024, label: 'Low' },
      { value: 2048, label: 'Medium' },
      { value: 4096, label: 'High' },
    ],
    /**
     * ULTRA DROPPED FROM 4096 TO 2048 AND THE 2.78 ms WENT INTO THE AIR.
     *
     * Measured at the wood station, 2560x1440, paired A-B-B-A: the shadow pass
     * is 4.77 ms of an 8.28 ms armed frame, and 4.01 ms of that 4.77 is ALPHA-
     * TESTED LEAF CARDS being rasterised into the depth map. It is a fill cost
     * over the map's texels and nothing else — tightening the ortho box saves
     * 0.00, and the savings from halving the edge track the texel counts
     * (16.8M to 4.2M) almost exactly. So 4096 was charging 2.78 ms, more than
     * half of the whole frame's deficit against the 5 ms budget, for shadow
     * crispness in a rainforest.
     *
     * It was also one of only TWO knobs Ultra had — the other being MSAA — so
     * the top of the ladder was "the same picture, with sharper shadow edges
     * and less crawl". That is not a tier anybody can see. The 2.78 ms bought
     * god rays, five layers of mist and half again as many motes instead, and
     * Ultra now differs from High by things that are visible from across the
     * room. See `shaftDensity`, `mistLayers` and `particleDensity` below.
     *
     * LOW AND MEDIUM ARE UNCHANGED AND DELIBERATELY SO: they are already at
     * 1024, they are cheap, and they are the machines with the least light in
     * the frame to begin with, which is exactly where a shadow is doing the
     * most work.
     *
     * The long-term answer is two 2048 cascades, near and far — roughly double
     * today's near crispness for about half today's cost — and it is a bigger
     * change than this pass should carry.
     */
    presets: [1024, 1024, 1024, 2048, 2048],
    dependsOn: 'shadows',
    hint: 'Shadow map resolution across a 116 m box.',
  },
  {
    /**
     * How much of the sun-shaft lattice is drawn.
     *
     * The shafts are one InstancedMesh over a 9x9 lattice of 19 m cells, seated
     * NEAREST-FIRST, and this is a fraction of that prefix — so turning it down
     * removes the furthest shafts, which are the ones the reach fade had nearly
     * removed already, and never opens a hole around the player. See
     * `setDensity` in atmosphere.js.
     *
     * Cost is fill: an additive shell costs what it covers, and covering scales
     * with the count. It is a real Ultra lever, which is the point of it.
     */
    id: 'shaftDensity',
    group: 'graphics',
    advanced: true,
    label: 'Sun shafts',
    kind: 'range',
    min: 0,
    max: 1,
    step: 0.05,
    presets: [0, 0.3, 0.55, 0.75, 1],
    format: (v) => `${Math.round(v * 100)}%`,
    hint: 'Light in the air where the canopy has a hole in it. Fill-bound.',
  },
  {
    /**
     * How many world-mist sheets are drawn, out of five.
     *
     * The list is ordered by what each layer is worth — the first hollow sheet
     * and the first canopy band before any of the thickening layers — so a low
     * count is a thinner version of the same effect rather than half of it
     * missing. One draw call per layer, and the fill is bounded by the pooling
     * term, which is zero over flat ground.
     */
    id: 'mistLayers',
    group: 'graphics',
    advanced: true,
    label: 'Mist layers',
    kind: 'enum',
    options: [
      { value: 0, label: 'Off' },
      { value: 1, label: 'One' },
      { value: 2, label: 'Two' },
      { value: 3, label: 'Three' },
      { value: 5, label: 'Five' },
    ],
    presets: [0, 1, 2, 3, 5],
    hint: 'Mist pooling in hollows and hanging under the canopy.',
  },
  {
    id: 'bloom',
    group: 'graphics',
    advanced: true,
    label: 'Bloom',
    kind: 'toggle',
    presets: [false, false, true, true, true],
    hint: 'Glare. Also carries the luminous wake — off here turns both off.',
  },
  {
    id: 'trail',
    group: 'graphics',
    advanced: true,
    label: 'Luminous wake',
    kind: 'toggle',
    presets: [false, false, true, true, true],
    dependsOn: 'bloom',
    hint: 'Persistence on the blurriest bloom mip. Cheap; listed for taste.',
  },
  {
    id: 'fogDistance',
    group: 'graphics',
    label: 'View distance',
    kind: 'range',
    // 0.45 rather than 0.7, because `treeReach` now needs a density the old
    // floor could not express: hiding a 120 m reach wants ρ ≈ 0.0196 against a
    // sober ~0.0092, i.e. a multiplier near 0.47. See the treeReach block.
    min: 0.45,
    max: 1.3,
    step: 0.05,
    /**
     * A multiplier on how far you can see, applied as a DIVISOR on the sober
     * fog density — the director rebuilds the live density from that base every
     * frame, so this has to move the base or it is overwritten within one
     * frame. `camera.far` is deliberately left alone: the sky dome is a sphere
     * of radius WORLD_RADIUS × 3.4 = 646 m centred on the camera, so pulling
     * the far plane in to 0.7 × 900 = 630 m clips the sky and you get a black
     * hole over your head. Fog is the real draw distance in a forest anyway.
     *
     * THEY ARE FLAT FROM `low` UP, AND THE ONE EXCEPTION PROVES THE RULE.
     *
     * `potato` sets 0.47 and it is the only rung that moves this, because it is
     * the only rung that cuts `treeReach`. The argument below — that spreading
     * fog across the ladder is a straight loss, because nothing culls on fog
     * and so it repaints the depth of the wood for no frame time at all —
     * is still exactly right for every level that draws the wood to 384 m.
     * What changed is that one level no longer does. Fog is not buying time
     * here either; it is paying for the reach cut that buys the time, by making
     * a shortened wood end in haze instead of ending in an edge. The moment
     * something culls on distance, the density that hides that distance stops
     * being cosmetic.
     *
     *
     * They used to be [0.8, 0.9, 1, 1.15] — Low a quarter hazier than High,
     * Ultra an eighth clearer — and that was a straight loss. NOTHING IN THIS
     * RENDERER CULLS ON FOG: the tree, grass and fern reach are the fixed
     * TREE_LOD / TREE_REACH / maxDistance constants in forest.js, the ground
     * ring is a fixed radius, and the exponential term is the same handful of
     * instructions per fragment whatever the density is. So the spread bought
     * no frame time at all, and it cost a visibly different picture: measured
     * as the mean of the whole frame, Low's 1.25× density was worth +2.6
     * luminance at the spawn clearing and +1.6 at the wood's edge, and Ultra's
     * 0.87× took about a point off in the other direction. Two of the four
     * levels were being pushed away from High for nothing — fog colour IS the
     * colour of every distant surface, so moving the density repaints the
     * depth of the wood, which is the one thing the levels are supposed to
     * agree about.
     *
     * The knob keeps its full 0.7–1.3 travel, because how deep the haze is IS
     * a taste — some people want to see the fifth rank of trunks and some want
     * the wood to close in. It is just no longer something the quality ladder
     * has an opinion about.
     */
    /**
     * FLAT AGAIN, AND THE TWO ROWS THAT WERE NOT ARE A MISTAKE I MADE AND
     * MEASURED MY WAY BACK OUT OF.
     *
     * `potato` held 0.47 and `low` 0.70, on the arithmetic in the `treeReach`
     * block: fog transmits `exp(-(d·ρ)²)`, so a 120 m reach needs ρ ≈ 0.0196
     * against a sober 0.00921, or the shortened wood ends in a hard edge rather
     * than in haze. The arithmetic is correct and the conclusion was wrong,
     * because it assumed you can SEE to 120 m. In a rainforest at eye level you
     * cannot — the trees a short reach removes were already behind nearer trees.
     *
     * Measured with `npm run impostor:fog`, which gives each density its own
     * full-reach reference at that density, so what is compared is how far the
     * cut frame sits from the frame it is pretending to be:
     *
     *     station     cut @ fog 1.00   cut @ fog 0.47   the haze itself
     *     ridge        0.01% / 0.00     0.01% / 0.00    41.7% / 6.96
     *     wood         0.03% / 0.00     0.01% / 0.00    52.0% / 7.26
     *     clearing     0.04% / 0.01     0.04% / 0.00    71.7% / 16.08
     *     stream       0.00% / 0.00     0.00% / 0.00    56.9% / 15.45
     *
     * At every eye-level station the cut is invisible at BOTH densities — mean
     * error 0.00 to 0.01 of 255 either way. So the haze was hiding nothing, and
     * charging 42–72% of the frame repainted by 7–16 levels for it. In the
     * frames it washes the mid-storey to a pale grey-green and the wood loses
     * its interior and its darkness, which is a large and permanent price paid
     * where potato players actually stand.
     *
     * ABOVE THE CANOPY IT DID STILL WORK — 19.0% / mean 1.86 at sober density
     * against 3.5% / 0.48 at 0.47 — and that is the honest cost of this change.
     * It loses to the eye-level numbers on both counts: four times the mean
     * error over 2.7 times as many pixels, at a station a player is rarely at.
     * And the silhouette up there is now carried by the impostor band, which is
     * what fog was standing in for and was never good at: with the band off,
     * sober reads 31.4% and 0.47 reads 29.1%, so the haze was barely touching it.
     *
     * The original argument below therefore stands unamended, and this is one
     * more instance of it: nothing culls on fog, so moving the density buys no
     * frame time and repaints the wood. Adding something that DID cull on
     * distance looked like it had made fog load-bearing. It had not.
     */
    presets: [1, 1, 1, 1, 1],
    format: (v) => `${v.toFixed(2)}×`,
    hint: 'Haze depth. Fog is what actually bounds the view here, not the far plane.',
  },
  {
    /**
     * How far the wood is DRAWN. The first knob in this list that removes
     * geometry, and therefore the first one with real range.
     *
     * THE VALUE IS THE OUTER REACH, and the other two distances are derived
     * from it by the table in main.js rather than exposed separately. They are
     * not independent: a tree is two packers over one payload whose bands must
     * meet exactly, so `lod` is where the near trunk hands over to the far
     * sweep and `leafReach` is where the canopy stops, and offering three
     * sliders would be offering three ways to produce a wood that draws every
     * distant trunk twice. See `forest.setReach`.
     *
     * MEASURED, at the deep station, preset low, render scale held at 0.65
     * (`.perf/presets-reach.json`):
     *
     *     170/384 (today)    2.01 ms   16.08 M tri
     *     120/250 leaf 150   1.23 ms    6.73 M tri   58% fewer
     *      90/180 leaf 110   1.03 ms    5.14 M tri   68%
     *      60/120 leaf  90   0.72 ms    3.59 M tri   78%
     *      60/120 leaf  60   0.75 ms    3.44 M tri   79%
     *
     * `ms = 0.44 + 0.103 × Mtri`, rms residual 0.078. 120 is the KNEE and the
     * last row is why: taking the canopy in to 60 buys 0.03 ms and costs the
     * silhouette of every tree you can see. Below about 4 M triangles this
     * lever is spent, and what is left is the 0.44–0.88 ms intercept — terrain,
     * sky, post, and the vertex cost of the trees still standing. None of that
     * is fill, so render scale will not touch it either.
     *
     * WHERE IT PAYS LEAST IS WORTH KNOWING: looking straight up into the
     * canopy, the leaves filling the screen are the ones directly overhead,
     * which no reach setting removes. At that station a leafReach of 150 m
     * deletes 44% of the triangles and buys nothing measurable. Reach cuts pay
     * where the frame is vertex-bound and not where it is fill-bound, which is
     * the exact opposite of every other knob on this page.
     *
     * IT IS USELESS WITHOUT THE FOG, and that pairing is the reason
     * `fogDistance` stopped being flat. Fog transmits `exp(-(d·ρ)²)`, so hiding
     * a reach of `d` needs `ρ >= sqrt(ln 255)/d = 2.354/d` — 0.0061 at 384 m,
     * which sober density clears easily, and 0.0196 at 120 m, which is 2.1×
     * sober. Cut the reach without thickening the haze and you do not get a
     * fade, you get a hard-edged circular hole that follows the player.
     */
    id: 'treeReach',
    group: 'graphics',
    advanced: true,
    label: 'Tree distance',
    kind: 'enum',
    options: [
      { value: 120, label: 'Near' },
      { value: 180, label: 'Short' },
      { value: 250, label: 'Medium' },
      { value: 384, label: 'Full' },
    ],
    /**
     * THE LADDER IS PAIRED WITH `fogDistance` ROW FOR ROW, and the pairing is
     * arithmetic rather than taste. Sober density is ρ = 0.00921, and what a
     * reach of `d` needs to end in haze rather than in an edge is
     * `ρ >= sqrt(ln 255)/d`:
     *
     *     reach   transmits at the cut   in 1/255   ρ needed   fogDistance
     *       384              3.7e-06        0.00     0.00613          1.50
     *       250              5.0e-03        1.27     0.00942          0.98
     *       180              6.4e-02       16.35     0.01308          0.70
     *       120              3.0e-01       75.21     0.01962          0.47
     *
     * THAT TABLE IS ARITHMETIC, AND THE ARITHMETIC IS NOT THE ANSWER. It
     * assumes you can SEE to the reach, and `reach-visible.mjs` — which pins
     * the preset, fixes the camera and moves nothing but `forest.setReach` —
     * shows how rarely that is true:
     *
     *     station      250 m     180 m     120 m
     *     ridge        0.00%     0.01%     0.02%
     *     wood         0.00%     0.01%     0.04%
     *     canopy       0.00%     0.00%     0.00%
     *     clearing     0.00%     0.00%     0.05%
     *     stream       0.00%     0.00%     0.00%
     *     glade/far    0.00%     0.00%     0.00%
     *
     * A rainforest at head height does not contain a 120 m sightline. The trees
     * a reach cut removes were already behind other trees, so at every station
     * a player can actually stand in, this lever is very nearly invisible — not
     * because of the fog, but because of the wood. Fog is not what is hiding
     * this, and the table above the table would have had us believe it was.
     *
     * THE ONE PLACE IT BREAKS IS ABOVE THE CANOPY, and there it breaks badly:
     *
     *     camera +55 m    1.61%     3.64%     4.46%
     *     camera +70 m   14.66%    25.38%    31.27%
     *
     * With nothing in the way, every tree the reach removes is a tree you could
     * have seen. `.perf/shots/above-flat-*.png` is what that looks like: at
     * `medium` the canopy still reads as canopy fading into haze, and at
     * `potato` it is gone — bare heightfield to the horizon with the river
     * visible across it. Fog does not save it, because fog is hiding the
     * distance uniformly and what is missing is the SILHOUETTE.
     *
     * BOTH OF THOSE HOLES ARE NOW FILLED, and the two paragraphs that used to
     * stand here — "above the canopy potato stops looking like a forest, and an
     * impostor canopy is the specific thing that would fix it" and "the fog on
     * the two lowest rungs is kept anyway" — are superseded rather than merely
     * out of date.
     *
     * The impostor band landed: past `leafReach` each tree is one camera-facing
     * quad reading a hemi-octahedral atlas of itself, so the silhouette survives
     * at 2 triangles. Above the canopy at +70 m the reach cut went from 31.27%
     * of pixels to 18.42% at `potato` and from 14.69% to 4.64% at `medium`, with
     * mean error down 4–6×. See `src/render/impostor.js`.
     *
     * And the fog went with it, because once the band carried the silhouette the
     * haze was measured to be hiding nothing anywhere a player stands: the cut
     * reads 0.00–0.01 of 255 at every eye-level station at SOBER density, while
     * the haze itself repainted 42–72% of the frame by 7–16 levels. It was a
     * large permanent price for a hole that had stopped existing. See the
     * `fogDistance` block.
     *
     * WHY THE MIDDLE OF THE LADDER NEEDED THIS AT ALL. Before it, medium and
     * high submitted 16.63 M and 16.70 M triangles — four parts in a thousand
     * apart — so "medium" meant "high at 0.8 render scale with the
     * anti-aliasing off" and nothing else. Three of the five rungs were the same
     * scene. The knob existed by then; the rungs simply were not using it.
     */
    presets: [120, 180, 250, 384, 384],
    hint: 'How deep the wood is drawn. The only setting here that removes geometry rather than pixels.',
  },
  {
    /**
     * THE FIRST TWO KNOBS IN THIS LIST THAT ARE ABOUT DRAW CALLS RATHER THAN
     * ABOUT PIXELS OR TRIANGLES, and the reason they exist is a measurement this
     * project had never taken.
     *
     * Every instrument in scripts/perf measures GPU time on a desktop part, and
     * by that measure both of these are free — the five clutter layers are
     * 0.05 M triangles of a 2.24 M frame and vanish into the noise floor.
     * `npm run perf:weak` throttles the MAIN THREAD instead, which is the half of
     * the budget a Chromebook runs out of first, and the picture there is
     * completely different: at 8x throttle `potato` sits exactly on the 60 Hz
     * boundary, and removing any fourteen draw calls — it does not matter which
     * — takes the frame from 33.3 ms to 16.7. A draw is a scene-graph walk, a
     * render-list insert, a program select and a driver call, and a weak core
     * pays for all four whatever is in the buffer.
     *
     * So these two remove THINGS, not detail. Ground clutter is the sticks,
     * fallen leaves, wildflowers, bramble and reeds — five layers that are
     * texture on the floor you are walking over, chosen by the test on the
     * `understoreyLayers` table in forest.js: would the wood be a different
     * place without it? The bushes, saplings, palms, bromeliads and giant leaves
     * are not in that list, because they are shape you walk around.
     */
    id: 'groundClutter',
    group: 'graphics',
    advanced: true,
    label: 'Ground clutter',
    kind: 'toggle',
    presets: [false, true, true, true, true],
    hint: 'Sticks, fallen leaves, wildflowers, bramble and reeds on the forest floor.',
  },
  {
    /**
     * The midges, the fireflies and the butterflies — two point clouds and seven
     * cards, which is two draws and, more to the point, `followSwarm` and
     * `followFlutters` recycling 1340 points and 7 quads against the camera on
     * every single frame.
     *
     * THE BIRDS AND THE MAMMALS ARE NOT IN HERE and that is a deliberate line.
     * They are what somebody standing still in this wood is looking at, and they
     * are simulated host-authoritatively — one client runs the herd and the rest
     * derive it — so thinning them on the weakest machine in the room would
     * change the world for everybody else in it. What is left here is the
     * scenery of the air.
     */
    id: 'smallLife',
    group: 'graphics',
    advanced: true,
    label: 'Insects',
    kind: 'toggle',
    presets: [false, true, true, true, true],
    hint: 'Midges, fireflies and butterflies. Birds and animals are not affected.',
  },
  {
    id: 'particleDensity',
    group: 'graphics',
    advanced: true,
    label: 'Motes',
    kind: 'range',
    min: 0,
    max: 1,
    step: 0.05,
    /**
     * THE CLOUD GOT BIGGER AND HIGH KEPT THE SAME NUMBER OF MOTES.
     *
     * The buffer went from 2600 to 3800 points, and the presets were re-fitted
     * against the new total so that High still draws 2660 — within 2% of what
     * it drew before, i.e. the frame High is defined as is unchanged — while
     * Ultra draws all 3800 and Low and Medium land close to where they were.
     * Anything else would have been a silent free upgrade for every tier, which
     * is not a thing a quality ladder is allowed to do to a measured baseline.
     *
     * A draw range, not a rebuild: see the note in main.js. Motes are one draw
     * call whatever this says, and the cost is the point sprites' fill.
     */
    presets: [0, 0.22, 0.42, 0.7, 1],
    format: (v) => `${Math.round(v * 100)}%`,
    hint: 'Airborne motes. They are what make still air look like air.',
  },
  {
    id: 'instanceDensity',
    group: 'graphics',
    advanced: true,
    label: 'Undergrowth',
    kind: 'range',
    min: 0.25,
    max: 1,
    step: 0.05,
    presets: [0.35, 0.5, 0.75, 1, 1],
    format: (v) => `${Math.round(v * 100)}%`,
    hint: 'Grass and fern instances drawn per bucket.',
  },
  {
    id: 'fpsLimit',
    group: 'graphics',
    label: 'Frame rate limit',
    kind: 'range',
    min: 30,
    max: 145,
    step: 1,
    /**
     * The top of the travel IS the sentinel, the same trick renderScale plays
     * with `Max` — see FPS_LIMIT_UNCAPPED in main.js, which this has to be
     * kept in sync with by hand. 145 rather than a round 144 so the display's
     * own 144 Hz is still a selectable, distinct cap one step below the
     * ceiling rather than colliding with "no cap at all".
     *
     * No `presets` — this is not a quality-ladder rung, it is a personal or
     * hardware preference (heat, battery, a monitor that only does 60 Hz
     * anyway), and Auto's whole job is to find the best picture this machine
     * can sustain at whatever rate it is actually running. Let Auto see a
     * self-imposed cap as "headroom" and it would climb quality forever
     * chasing a ceiling the player put there on purpose.
     */
    default: 145,
    format: (v) => (v >= 145 ? 'Unlimited' : `${v} fps`),
    hint: 'Caps how often the game simulates and renders a frame. All the way up is Unlimited, which leaves only the display refresh rate as the ceiling.',
  },

  // ---- audio -------------------------------------------------------------
  {
    id: 'volume.master',
    group: 'audio',
    label: 'Master',
    kind: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    format: pct,
  },
  {
    id: 'volume.music',
    group: 'audio',
    label: 'Music',
    kind: 'range',
    min: 0,
    // 1 is the tuned mix, not the ceiling — see VOLUME_BOOST_MAX in audio/engine.js,
    // which this must be kept in sync with by hand.
    max: 1.5,
    step: 0.01,
    default: 1,
    format: pct,
  },
  {
    id: 'volume.world',
    group: 'audio',
    label: 'World',
    kind: 'range',
    min: 0,
    max: 1.5,
    step: 0.01,
    default: 1,
    format: pct,
    hint: 'Wind, birds, the stream, your own footsteps.',
  },
  {
    id: 'volume.sfx',
    group: 'audio',
    label: 'Events',
    kind: 'range',
    min: 0,
    max: 1.5,
    step: 0.01,
    default: 1,
    format: pct,
    /**
     * THIS SLIDER'S OWN HINT WAS THE STALEST THING IN THE PANEL.
     *
     * It read "Nothing is routed here yet, so this does nothing", which was
     * true when it was written and had since become the exact bug it was
     * written to avoid: a control whose label misdescribes it. `sfxBus` now
     * carries the fish surfacing and the jetty creaking (ambience.js), and the
     * guan's wing drum, the deer's bolt and bark, hooves and the squirrel's
     * scold (wildlife.js) — all of them routed here by the explicit "would a
     * player point at it and say *that*" test in wildlife.js's header. Every
     * one of those goes through `createSpatial({ bus: engine.sfxBus })` and
     * every one of them is under this slider.
     *
     * So a player who turned it down to check found the wood went quiet in a
     * way the caption said it could not. Being honest about a dead control is
     * right; leaving that honesty in place after wiring the control is not.
     * "Interactions" went with it — none of these are things you do.
     */
    hint: 'One-off sounds: a fish surfacing, a bird bolting from a bush, a jetty creaking.',
  },
  {
    id: 'volume.voice',
    group: 'audio',
    label: 'Voices',
    kind: 'range',
    min: 0,
    max: 1.5,
    step: 0.01,
    default: 1,
    format: pct,
    // Was "nothing feeds this bus yet", and that had stopped being a caveat and
    // become a bug: peer voices were going to worldBus, so this slider was dead
    // and the World slider was turning people's speech up and down. See the
    // block comment on the createSpatial call in net/voice.js.
    hint: 'Other players, when there are any.',
  },
  {
    id: 'hearOwnShare',
    group: 'audio',
    label: 'Hear your own screen',
    kind: 'toggle',
    /**
     * OFF BY DEFAULT, AND THE DEFAULT IS THE ONLY PART OF THIS THAT IS AN
     * OPINION.
     *
     * Capturing a tab does not silence it. The thing you are showing carries on
     * playing out of your own speakers the entire time, so routing the captured
     * track back through a PannerNode standing at your screen arrives at your
     * ears twice: once flat and immediate from the operating system, once late
     * by the audio graph plus a convolution and later in one ear than the other,
     * because that is precisely what an HRTF is for. It does not read as a
     * doubled sound, it reads as an echo off to one side — which is why the net
     * layer refused to do it at all.
     *
     * That refusal was right about the sound and wrong about whose call it is.
     * Muting the tab at source deletes the flat copy, and what is left is the
     * one coming from the object standing in the clearing — the same copy
     * everybody else is hearing, quieter as you walk away from it. The app
     * cannot mute your tab for you and cannot detect that you have, so it
     * cannot make that choice; it can only stop making the opposite one.
     *
     * NOTHING HERE IS ABOUT A DROPPED FILM. A film's element is muted at source
     * by construction (see `startFile` in net/share.js), so the world is already
     * the only place its sound exists and there is no second copy for this
     * switch to be about. It stays audible whichever way this is set.
     */
    default: false,
    hint:
      'Play a shared screen or tab back through the world, from the screen you stood up. ' +
      'Mute the tab at source first: your speakers are still playing it, and the second copy reads as an echo. ' +
      'Films you drop in are always audible this way regardless.',
  },

  {
    /**
     * A view setting rather than a control, so it sits with the picture and not
     * with the mouse. It was filed under "comfort" alongside mouse sensitivity,
     * which put the one graphics slider most people go looking for on a page
     * they had no reason to open.
     */
    id: 'fov',
    group: 'graphics',
    label: 'Field of view',
    kind: 'range',
    min: 55,
    max: 100,
    step: 1,
    default: 66,
    format: (v) => `${v.toFixed(0)}°`,
    hint: 'The base the trip’s dolly zoom departs from, not an absolute.',
  },
  {
    /**
     * The one knob whose home is genuinely arguable. It draws nothing into the
     * scene it measures — it is not a quality setting and Auto never touches it
     * — but it is a thing you switch on to find out why the picture is slow,
     * which is what the rest of the Advanced block is for.
     */
    id: 'showStats',
    group: 'graphics',
    advanced: true,
    label: 'Performance stats',
    kind: 'toggle',
    default: false,
    hint: 'An FPS counter and a scrolling frame-rate graph, top right of the screen.',
  },

  // ---- controls ----------------------------------------------------------
  {
    id: 'mouseSensitivity',
    group: 'controls',
    label: 'Mouse sensitivity',
    kind: 'range',
    min: 0.25,
    max: 3,
    step: 0.05,
    default: 1,
    format: (v) => `${v.toFixed(2)}×`,
  },
  { id: 'invertY', group: 'controls', label: 'Invert look', kind: 'toggle', default: false },

  // ---- accessibility -----------------------------------------------------
  {
    id: 'motionIntensity',
    group: 'accessibility',
    label: 'Camera motion',
    kind: 'range',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    format: pct,
    /**
     * One slider for the head bob, the trip's camera family AND the view
     * breath, because to somebody who needs it turned down they are the same
     * complaint. At 0 the camera is rigidly attached to the body — no bob, no
     * roll, no drift, no dolly zoom — and the picture itself stops swelling.
     * That loses a real part of the trip and it is supposed to; an
     * accessibility control that only half works is not one.
     *
     * The view breath joined the list when it was added, rather than after
     * somebody complained. It is the only effect that moves the whole image,
     * which makes it the strongest candidate in the project for provoking
     * motion sickness, and a comfort control that omits the worst offender is
     * the exact failure this comment already warns about.
     *
     * It has a page to itself now, and the page is called Accessibility rather
     * than Comfort. "Comfort" is what a settings menu calls this when it would
     * rather not say what it is for; somebody who gets motion sick from a head
     * bob is looking for the word that means them.
     */
    hint: 'Head bob, camera drift, the dolly zoom, and the swelling of the picture itself. 0 pins the camera to the body and holds the image still.',
  },
];

function pct(v) {
  return `${Math.round(v * 100)}%`;
}

const KNOB_BY_ID = new Map(KNOBS.map((k) => [k.id, k]));
export const AUTO_KNOBS = KNOBS.filter((k) => k.presets);

/** The value a knob takes at a named level, or its plain default. */
export function valueAt(knob, level) {
  if (!knob.presets) return knob.default;
  const i = Math.max(0, LEVELS.indexOf(level));
  return knob.presets[i];
}

/* -------------------------------------------------------------------------- */
/* persistence                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One key, versioned, and a hard discard on a version mismatch.
 *
 * Migrating settings is not worth writing for a project whose knob list is
 * still moving: a half-migrated blob that silently pins render scale to a value
 * the current build no longer means is a bug report nobody can reproduce.
 * Bumping STORAGE_VERSION throws the old blob away and puts everyone back on
 * Auto, which is the correct behaviour when the meaning of the settings has
 * changed underneath them.
 */
const STORAGE_KEY = 'reality-room:settings';
const STORAGE_VERSION = 1;

function readStore() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== STORAGE_VERSION) return null;
    return parsed;
  } catch {
    // Private browsing, a disabled storage partition, or corrupt JSON. All of
    // them mean the same thing here: start from defaults, say nothing.
    return null;
  }
}

function writeStore(payload) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* quota or no storage — settings simply do not survive the tab */
  }
}

/* -------------------------------------------------------------------------- */
/* the capability seed                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A cheap guess at where to start, so a fast machine does not spend its first
 * half-minute climbing out of Low.
 *
 * This is a GUESS and it is treated as one — the governor will move off it
 * within a few seconds if it is wrong, and a level that was actually measured
 * on this machine in a previous session always beats it. The string matching
 * below is a list of families rather than a scoring model on purpose: a
 * scoring model over GPU names is a thing that looks principled, is wrong in
 * ways nobody can debug, and needs updating every generation. Three buckets and
 * a default is all the accuracy this is entitled to.
 */
const GPU_BUCKETS = [
  // Software rasterisers. SwiftShader is what Playwright runs, and it is also
  // what a machine with a blocklisted driver falls back to.
  { level: 'low', re: /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|virgl/i },
  // Discrete parts from roughly the last four generations, plus Apple silicon,
  // which comfortably outruns the integrated bucket it would otherwise land in.
  {
    level: 'ultra',
    re: /rtx\s*[2-9]\d{3}|geforce\s*(gtx\s*1[6-9]|rtx)|radeon\s*rx\s*[5-9]\d{3}|radeon\s*pro|arc\s*[ab]\d{3}|apple\s*m[1-9]/i,
  },
  // Integrated and mobile. Capable, but not of Ultra.
  { level: 'medium', re: /intel|uhd|iris|hd graphics|adreno|mali|powervr|vivante/i },
];

export function probeLevel(renderer) {
  let level = DEFAULT_LEVEL;
  let description = 'unknown';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    description =
      (ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || 'unknown';
    for (const bucket of GPU_BUCKETS) {
      if (bucket.re.test(description)) {
        level = bucket.level;
        break;
      }
    }
    // Capability floors. A context without WebGL2 or with a small maximum
    // texture is not a machine that is going to hold 4× MSAA at full scale,
    // whatever its name says.
    const caps = renderer.capabilities;
    if (caps && caps.isWebGL2 === false) level = 'low';
    if (caps && caps.maxTextureSize && caps.maxTextureSize < 8192) level = clampLevel(level, 'medium');
  } catch {
    /* no context, no probe — DEFAULT_LEVEL stands */
  }
  // Host floors. A four-thread machine is not going to be GPU-bound first.
  if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) {
    level = clampLevel(level, 'medium');
  }
  if (navigator.deviceMemory && navigator.deviceMemory <= 4) level = clampLevel(level, 'medium');
  return { level, description };
}

/** The lower of two levels. */
function clampLevel(level, ceiling) {
  return LEVELS.indexOf(level) > LEVELS.indexOf(ceiling) ? ceiling : level;
}

/* -------------------------------------------------------------------------- */
/* the Auto governor                                                          */
/* -------------------------------------------------------------------------- */

/** Rolling window of frame intervals, in seconds. */
const WINDOW_SECONDS = 4;
/** Below this many samples in the window there is nothing to judge. */
const MIN_SAMPLES = 90;
/** How often the governor is allowed to look at the window. */
const EVAL_PERIOD = 0.5;
/** Dead frames after load: shader compilation, texture upload, the first GC. */
const WARMUP_SECONDS = 5;
/** Dead frames after anything that reallocates a buffer or recompiles. */
const SETTLE_SECONDS = 1.5;
/** How long a good reading must persist before Auto climbs. */
const DWELL_UP = 8;
/** …and before it drops. Asymmetric: bad news deserves a faster answer. */
const DWELL_DOWN = 2.5;
/**
 * THE HYSTERESIS BAND, AND WHY HALF OF IT IS NOT MEASURED IN MILLISECONDS.
 *
 * The obvious design is "climb if p95 is below X × the frame period, drop if it
 * is above Y ×", with a wide gap between X and Y. Simulating that against a
 * vsync-locked timeline showed the gap is partly a fiction: with vsync on —
 * which is every real player — a frame interval is either one period or two,
 * never anything between, so p95 is either 1.00 × or 2.00 × and it lands inside
 * a 1.1-to-1.6 band exactly never. Judged only on p95, the whole band collapses
 * to one threshold at "5% of frames doubled".
 *
 * So the primary test lives where the signal actually is — in the FRACTION of
 * the window that missed its slot. Climb when fewer than 2% of frames were
 * late, drop when more than 6% were, and between 2% and 6% do nothing. That is
 * a band with real daylight in it under vsync, and it is one sentence to a
 * player: "more than one frame in sixteen is arriving late".
 *
 * The p95 ratio survives as a second, weaker test in both directions, because
 * it is what catches the case vsync hides: a machine rendering uncapped at a
 * uniform 1.4 × the period has NO late frames by the fraction test — every
 * frame is equally slow — and must neither be told it has headroom nor, at 1.4,
 * be dropped for it.
 *
 * WHAT NONE OF THIS BUYS is a guarantee against oscillation, and it is worth
 * being honest about that, because a wider band is the intuitive fix and it is
 * the wrong one. A level whose true cost sits at 16.4 ms on a 16.6 ms display
 * is genuinely unstable: it misses slots, gets dropped, and the level below it
 * genuinely does hold — so on the next reading the machine looks fine and every
 * threshold in the world says climb. No band drawn on a single frame-time
 * statistic can distinguish that from a machine that has simply finished
 * loading. The thing that fixes it is DWELL plus BACKOFF below: the level that
 * failed is put on probation and the wait doubles each time. See the
 * closed-loop numbers in the report.
 */
const LATE_FACTOR = 1.5;
const UP_LATE = 0.02;
const DOWN_LATE = 0.06;
const UP_RATIO = 1.1;
const DOWN_RATIO = 1.6;
/**
 * The fastest cadence Auto is willing to believe the display has.
 *
 * The period is estimated from the fastest frames actually observed, which is
 * right on a 144 Hz panel and catastrophically wrong on a machine that is
 * simply never fast: if a potato only ever manages 30 fps, its fastest frame is
 * 33 ms, every frame matches it, and a naive ratio says "holding perfectly,
 * climb". Refusing to believe in anything slower than ~58 Hz turns that into
 * a ratio of 2 and a drop, which is the correct answer.
 */
const SLOWEST_BELIEVABLE_PERIOD = 1 / 58;
/**
 * THE FASTEST FRAME RATE THIS GAME IS WILLING TO CHASE, AND THE REASON IT IS A
 * CEILING RATHER THAN THE DISPLAY'S OWN RATE.
 *
 * This was 1/300 — a pure sanity clamp — and on a high-refresh display it was
 * the bug. The period above is estimated from the fastest frames actually
 * observed, so on a 240 Hz panel Auto concluded the budget was 4.2 ms and then
 * judged the game against it. An ordinary 6.9 ms frame is not merely late
 * against that budget, it is late on essentially every frame, so `late` sits
 * near 100% and the ladder has no choice but to walk all the way down.
 *
 * Measured on a Radeon RX 9070 XT at 2560x1440 on a ~213 Hz display, with both
 * controllers live: dynamic resolution ran to its 0.60 floor in 2.5 s, and Auto
 * then went ultra -> high -> medium -> low inside ten seconds. The top graphics
 * card of its generation was put on the lowest preset in the game because the
 * MONITOR was fast. Nothing was wrong with the frame; the target was wrong.
 *
 * A refresh rate is what the display can show, not what the renderer owes it.
 * Past roughly 120 fps the difference between one frame and the next is not
 * something this game — a wood you walk through — can spend quality on and come
 * out ahead; a player offered "ultra at 110 fps" or "low at 210 fps" is not
 * choosing the second one. So the budget is the SLOWER of the display's period
 * and this, and on a 60 Hz panel nothing changes at all.
 *
 * It is deliberately NOT the `fpsLimit` knob. That one is the player's own cap
 * and Auto must keep ignoring it, for the reason set out on the knob: a cap
 * somebody imposed on purpose must never read as headroom. This is the
 * opposite direction — a floor under the budget, not a ceiling on the work.
 */
const MAX_USEFUL_FPS = 120;
export const FASTEST_USEFUL_PERIOD = 1 / MAX_USEFUL_FPS;
/** Anything longer than this was not a frame. A tab switch, an alt-tab, a GC pause. */
const STALL_SECONDS = 0.25;
/**
 * Exponential backoff on a climb that did not stick.
 *
 * This is the property that keeps a machine sitting exactly on a boundary from
 * flickering between two settings forever, and no threshold can do it — see the
 * band comment above. If Auto climbs to a level and gets pushed back off it,
 * that level goes on probation and the wait before trying it again doubles
 * every time it fails. The number of visible quality changes is therefore
 * LOGARITHMIC in session length rather than linear in it: a closed-loop
 * simulation of a machine whose best level costs 15.9 ms on a 16.6 ms display
 * — the worst case there is — settles one rung below it and re-probes at 45 s,
 * 90 s, 180 s, 360 s, each probe lasting the 2.6 s it takes to be sure.
 *
 * 45 s to the first retry, not 20. At 20 the retries in the first two minutes
 * were close enough together to read as instability rather than as the machine
 * checking; the cost of being slow about it is that a player who closes a
 * background application waits three quarters of a minute for the quality to
 * come back, which nobody has ever noticed happening.
 *
 * The backoff never decays. A machine that got permanently faster mid-session
 * is a real case and it is handled badly on purpose: after enough failures the
 * retry interval reaches a quarter of an hour and effectively stops. The
 * alternative is a decay rule with its own time constant, which is a second
 * controller wrapped around the first one, and the player has a Ultra button.
 */
const BACKOFF_START = 45;
const BACKOFF_FACTOR = 2;
const BACKOFF_MAX = 900;

class AutoGovernor {
  constructor(settings) {
    this.settings = settings;
    /** Frame intervals with their timestamps, oldest first. */
    this._samples = [];
    this._times = [];
    this._last = 0;
    this._period = 1 / 60;
    this._elapsed = 0;
    this._deadUntil = WARMUP_SECONDS;
    this._nextEval = 0;
    this._sinceChange = 0;
    /** level index -> earliest elapsed time we may try it again. */
    /**
     * How much of the resolution the FAST inner loop is currently paying with,
     * 1 when it is idle. Set by whoever owns that loop — see the dynamic
     * resolution block in render/pipeline.js.
     *
     * Without it the two controllers are stacked the wrong way round. This one
     * reads a frame time that dynamic resolution has already rescued, concludes
     * the machine has headroom, and climbs a preset the machine can only afford
     * at reduced resolution — then DRS drops further to pay for the preset, and
     * the two of them ratchet each other down while reporting success.
     *
     * Features are only worth adding once every pixel that was ASKED for is
     * actually being rendered. The two never write the same knob — one moves
     * pixels, the other moves features — so this is the only coupling needed,
     * and it is one-directional on purpose.
     */
    this.headroomScale = () => 1;
    /**
     * "Is the world actually being drawn right now?" Set by whoever owns the
     * frame loop — see the gate throttle in main.js.
     *
     * Same shape and the same one-directional coupling as `headroomScale`
     * above, and for a closely related reason: this samples rAF intervals from
     * its OWN loop, which measures how busy the main thread is, not how
     * expensive the frame is. Those are the same number only while every tick
     * is drawing a frame. Behind the main menu they are not — the loop skips
     * nineteen draws in twenty — and a governor left to read that would see a
     * machine with vast headroom, spend the length of a title screen climbing
     * to a preset nothing has paid for, and then discover the truth on the
     * first real frame. The correction costs a level change, and a level change
     * rebuilds twenty-two shader programs; this project has already had that
     * exact hitch once, from a different cause, and it reads as the game
     * freezing the moment you look around.
     *
     * A hold rather than `paused`, which is a single boolean that the settings
     * menu already owns — two writers of one flag is a bug waiting for the
     * player who opens Settings from the main menu and closes it again. And it
     * throws the window away rather than merely declining to act on it, so a
     * frame drawn behind a menu can never be averaged in with a real one.
     */
    this.drawing = () => true;
    this._probation = new Map();
    /** level index -> how long the next probation for it lasts. */
    this._backoff = new Map();
    this._running = false;
    this._paused = false;
    this._raf = null;
    this.p95 = 0;
    this.fps = 0;
    /** Fraction of the window's frames that missed their slot, 0..1. */
    this.late = 0;
    this.lastChange = null;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now() / 1000;
    const step = (now) => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(step);
      this._sample(now / 1000);
    };
    this._raf = requestAnimationFrame(step);
    document.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('resize', this._onDisturbance);
  }

  stop() {
    this._running = false;
    if (this._raf !== null) cancelAnimationFrame(this._raf);
    this._raf = null;
    document.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('resize', this._onDisturbance);
  }

  _onVisibility = () => {
    // rAF is throttled to a crawl in a hidden tab, and every one of those
    // intervals looks like a catastrophic frame. Throw the window away.
    this.disturb();
  };

  _onDisturbance = () => this.disturb();

  /**
   * "Whatever is in the window is meaningless now."
   *
   * Called on resize, on tab visibility changes and on every quality change
   * Auto or the player makes — all of which reallocate render targets and
   * recompile shaders, so the frames either side of them measure the change
   * rather than the setting.
   */
  disturb() {
    this._samples.length = 0;
    this._times.length = 0;
    this._deadUntil = this._elapsed + SETTLE_SECONDS;
  }

  /** Measure but do not act — used while the settings menu is open. */
  set paused(v) {
    this._paused = v;
    if (!v) this._sinceChange = 0;
  }

  get paused() {
    return this._paused;
  }

  _sample(now) {
    const dt = now - this._last;
    this._last = now;
    if (dt <= 0) return;
    this._elapsed += Math.min(dt, STALL_SECONDS);
    this._sinceChange += Math.min(dt, STALL_SECONDS);

    if (document.hidden || !this.drawing() || dt > STALL_SECONDS) {
      this.disturb();
      return;
    }

    this._samples.push(dt);
    this._times.push(this._elapsed);
    while (this._times.length && this._elapsed - this._times[0] > WINDOW_SECONDS) {
      this._times.shift();
      this._samples.shift();
    }

    if (this._elapsed < this._nextEval) return;
    this._nextEval = this._elapsed + EVAL_PERIOD;
    this._evaluate();
  }

  _evaluate() {
    if (this._samples.length < MIN_SAMPLES) return;
    const sorted = this._samples.slice().sort((a, b) => a - b);
    const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

    /**
     * p95, not the mean, and not the worst.
     *
     * The mean is dominated by the frames the player does not notice; the
     * maximum is dominated by the one frame that was a garbage collection. p95
     * over a four-second window is roughly "the judder you can feel", and it
     * has a useful structural property here: at 60 Hz the window holds ~240
     * samples, so p95 is the twelfth-worst frame. Moving it at all takes
     * thirteen bad frames inside four seconds. A single spike — the sort the
     * intermittent-stutter work is chasing right now — cannot shift it by a
     * microsecond, which is exactly the guarantee this needs.
     */
    this.p95 = p(0.95);
    this.fps = 1 / p(0.5);

    // The display's own cadence, from the fastest tenth of the window. See
    // SLOWEST_BELIEVABLE_PERIOD for why this is clamped rather than trusted.
    const observed = p(0.1);
    this._period = Math.min(
      SLOWEST_BELIEVABLE_PERIOD,
      Math.max(FASTEST_USEFUL_PERIOD, observed)
    );

    // How much of the window missed its slot. See the LATE_FACTOR block.
    const lateThreshold = this._period * LATE_FACTOR;
    let missed = 0;
    for (const dt of sorted) if (dt > lateThreshold) missed++;
    this.late = missed / sorted.length;

    if (this._paused || this._elapsed < this._deadUntil) return;
    if (this.settings.mode !== 'auto') return;

    const ratio = this.p95 / this._period;
    const index = LEVELS.indexOf(this.settings.autoLevel);
    const why = `${(this.late * 100).toFixed(1)}% late, p95 ${(this.p95 * 1000).toFixed(1)} ms`;

    if ((this.late > DOWN_LATE || ratio > DOWN_RATIO) && index > 0 && this._sinceChange >= DWELL_DOWN) {
      // ONE level. Never two, however bad the reading is. A double drop is
      // indistinguishable from a bug to the player, and if the machine really
      // is two levels short the next evaluation will say so again in 2.5 s.
      this._punish(index);
      this._move(index - 1, why);
      return;
    }

    if (
      this.late < UP_LATE &&
      ratio < UP_RATIO &&
      // See headroomScale: do not buy features with pixels the fast loop has
      // already sold.
      this.headroomScale() >= 0.999 &&
      index < LEVELS.length - 1 &&
      this._sinceChange >= DWELL_UP
    ) {
      const target = index + 1;
      const heldBack = this._probation.get(target) ?? 0;
      if (this._elapsed < heldBack) return;
      this._move(target, why);
    }
  }

  /**
   * The level we are dropping FROM has just proved it does not hold on this
   * machine, so put it on probation before Auto is allowed to try it again.
   */
  _punish(index) {
    const wait = Math.min(BACKOFF_MAX, this._backoff.get(index) ?? BACKOFF_START);
    this._probation.set(index, this._elapsed + wait);
    this._backoff.set(index, Math.min(BACKOFF_MAX, wait * BACKOFF_FACTOR));
  }

  _move(index, why) {
    const level = LEVELS[index];
    this.lastChange = { level, why, at: this._elapsed };
    this._sinceChange = 0;
    this.settings._setAutoLevel(level);
    this.disturb();
  }

  /** For the panel readout and for tests. */
  describe() {
    return {
      p95: this.p95,
      fps: this.fps,
      late: this.late,
      period: this._period,
      ratio: this.p95 > 0 ? this.p95 / this._period : 0,
      samples: this._samples.length,
      settling: this._elapsed < this._deadUntil,
      elapsed: this._elapsed,
      dwell: this._sinceChange,
      paused: this._paused,
      lastChange: this.lastChange,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* the registry                                                               */
/* -------------------------------------------------------------------------- */

export class Settings {
  constructor() {
    /** knob id -> array of setters. Several consumers may want the same knob. */
    this._setters = new Map();
    /** knob id -> current resolved value. */
    this.values = new Map();
    /** knob id -> value the player pinned by hand, overriding the preset. */
    this.overrides = new Map();
    this._listeners = new Set();
    this._seeded = false;
    this.gpu = 'unknown';

    const stored = readStore();
    this.mode = stored?.mode ?? 'auto';
    this.autoLevel = LEVELS.includes(stored?.autoLevel) ? stored.autoLevel : DEFAULT_LEVEL;
    if (stored?.overrides) {
      for (const [id, v] of Object.entries(stored.overrides)) {
        if (KNOB_BY_ID.has(id)) this.overrides.set(id, v);
      }
    }
    /**
     * A stored auto level is EVIDENCE, not a preference — it is the level this
     * exact machine settled at last time, which beats any amount of guessing
     * from a GPU string. So it counts as already-seeded and the capability
     * probe is skipped.
     */
    if (this.mode === 'auto' && LEVELS.includes(stored?.autoLevel)) this._seeded = true;

    for (const knob of KNOBS) this.values.set(knob.id, this._resolve(knob));

    this.auto = new AutoGovernor(this);
    /**
     * Auto does not run under automation unless a test asks for it.
     *
     * Every script in scripts/ drives the real page and compares pixels or
     * milliseconds against expectations. A governor quietly changing the render
     * scale halfway through `shoot.mjs` would make every one of them
     * non-reproducible, and the failure would look like a rendering bug rather
     * than like a settings bug. Under webdriver the level stays wherever it was
     * seeded and nothing moves it.
     */
    this.automated = Boolean(navigator.webdriver);
  }

  /* ---- values --------------------------------------------------------- */

  /**
   * What a knob should read right now.
   *
   * A hand-set value always wins. Otherwise a graphics knob takes its value
   * from the current rung — which under both `auto` and `custom` is
   * `autoLevel`, because "custom" means "that rung, plus the things I changed".
   */
  _resolve(knob) {
    if (this.overrides.has(knob.id)) return this.overrides.get(knob.id);
    if (!knob.presets) return knob.default;
    const base = this.mode === 'auto' || this.mode === 'custom' ? this.autoLevel : this.mode;
    return valueAt(knob, base);
  }

  get(id) {
    return this.values.get(id);
  }

  knob(id) {
    return KNOB_BY_ID.get(id);
  }

  /** True once somebody has claimed this knob. The UI disables the rest. */
  has(id) {
    return (this._setters.get(id)?.length ?? 0) > 0;
  }

  /**
   * Claim a knob.
   *
   * Applies the current value immediately, so a consumer that registers late —
   * audio, which cannot exist until the first gesture — picks up whatever the
   * player already chose without anyone having to remember to replay it.
   */
  register(id, setter) {
    if (!KNOB_BY_ID.has(id)) {
      console.warn(`[settings] register("${id}"): no such knob`);
      return () => {};
    }
    const list = this._setters.get(id) ?? [];
    list.push(setter);
    this._setters.set(id, list);
    this._push(id, this.values.get(id));
    this._emit();
    return () => {
      const current = this._setters.get(id) ?? [];
      const at = current.indexOf(setter);
      if (at >= 0) current.splice(at, 1);
      this._emit();
    };
  }

  _push(id, value) {
    for (const setter of this._setters.get(id) ?? []) {
      try {
        setter(value);
      } catch (err) {
        // One broken consumer must not stop the other eight from being set.
        console.warn(`[settings] "${id}" setter threw`, err);
      }
    }
  }

  /**
   * Set one knob by hand.
   *
   * THE MOMENT THE PLAYER TOUCHES A GRAPHICS CONTROL, AUTO IS OFF. Not
   * "suspended", not "off until the next drop" — off, and it stays off until
   * they choose Auto again. A governor that keeps its opinion after being
   * overruled is a governor that will eventually undo the player's choice
   * while they are looking at something else, and that is the single worst
   * thing this feature could do.
   */
  set(id, value, { user = true } = {}) {
    const knob = KNOB_BY_ID.get(id);
    if (!knob) return;
    if (user && knob.presets && this.mode !== 'custom') {
      // Remember the rung we were standing on before going custom, so the
      // knobs the player did NOT touch keep the values they could see when
      // they touched the one they did.
      if (this.mode !== 'auto') this.autoLevel = this.mode;
      this.mode = 'custom';
    }
    this.overrides.set(id, value);
    this.values.set(id, value);
    this._push(id, value);
    if (knob.presets) this.auto.disturb();
    this._save();
    this._emit();
  }

  /** `auto`, or one of LEVELS. Clears every hand-set graphics override. */
  setMode(mode) {
    if (mode !== 'auto' && !LEVELS.includes(mode)) return;
    this.mode = mode;
    for (const knob of AUTO_KNOBS) this.overrides.delete(knob.id);
    if (mode !== 'auto') this.autoLevel = mode;
    this._applyGraphics();
    this.auto.disturb();
    this._save();
    this._emit();
  }

  /** Called only by the governor. */
  _setAutoLevel(level) {
    this.autoLevel = level;
    if (this.mode !== 'auto') return;
    this._applyGraphics();
    this._save();
    this._emit();
  }

  _applyGraphics() {
    for (const knob of AUTO_KNOBS) {
      const v = this._resolve(knob);
      if (this.values.get(knob.id) === v) continue;
      this.values.set(knob.id, v);
      this._push(knob.id, v);
    }
  }

  /** Back to factory: Auto, no overrides, comfort and volumes at default. */
  reset() {
    this.overrides.clear();
    this.mode = 'auto';
    for (const knob of KNOBS) {
      const v = this._resolve(knob);
      this.values.set(knob.id, v);
      this._push(knob.id, v);
    }
    this.auto.disturb();
    this._save();
    this._emit();
  }

  /* ---- lifecycle ------------------------------------------------------ */

  /**
   * Hand the registry a renderer so it can guess a starting level.
   *
   * Idempotent, and it never overrules a level restored from storage — that one
   * was measured on this machine rather than inferred from a string.
   */
  seedFrom(renderer) {
    const probe = probeLevel(renderer);
    this.gpu = probe.description;
    if (!this._seeded) {
      this._seeded = true;
      if (this.mode === 'auto') {
        this.autoLevel = probe.level;
        this._applyGraphics();
        this._save();
      }
    }
    this._emit();
    if (!this.automated) this.auto.start();
    return probe;
  }

  /** Let a test opt in to the governor that automation otherwise switches off. */
  startAuto() {
    this.automated = false;
    this.auto.start();
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) {
      try {
        fn(this);
      } catch (err) {
        console.warn('[settings] listener threw', err);
      }
    }
  }

  _save() {
    writeStore({
      v: STORAGE_VERSION,
      mode: this.mode,
      autoLevel: this.autoLevel,
      overrides: Object.fromEntries(this.overrides),
    });
  }

  /** Everything the panel's status line needs, in one call. */
  status() {
    const a = this.auto.describe();
    return {
      mode: this.mode,
      autoLevel: this.autoLevel,
      effective: this.mode === 'auto' || this.mode === 'custom' ? this.autoLevel : this.mode,
      gpu: this.gpu,
      running: this.auto._running && !this.automated,
      ...a,
    };
  }
}

export const quality = new Settings();

// A console handle, in the same spirit as window.RR. Test scripts drive the
// governor through this rather than reaching into module scope, because after
// an HMR update a dynamic import would get a second, pristine copy of this
// module whose registry is empty — see the note on window.RR.tripUniforms.
if (typeof window !== 'undefined') window.RRSettings = quality;
