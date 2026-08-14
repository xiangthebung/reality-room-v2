# Credits

Almost everything you hear and see in Reality Room is generated at runtime — the
forest, the animals, the birdsong, the weather, the music on the jukebox. This
file lists the parts that are not.

## Audio — the ambience beds

> **Sourced from Freesound's public preview transcodes, not the originals.**
> Freesound serves original uploads only to a logged-in session, and this
> project does not hold one and did not create one. All three beds were
> therefore built from the publicly served `-hq.mp3` preview (184–185 kbps), so
> the delivered Opus is a **second lossy generation**. The licences below cover
> the works themselves and apply to the previews identically; this note is about
> fidelity, not permission. It is recorded here, and per-bed in
> `manifest.json` under `beds[].source.note`, so that nobody later spends an
> afternoon wondering why a spectrogram tops out where it does.

The far chorus — the unresolvable wall of distant birds and insects that sits
under the synthesised forest — is streamed from field recordings. It is the one
layer in this project that could not be synthesised; the reasoning is in the
header of `src/audio/bed.js`.

Each recording is **trimmed** to a loop region, **distance-filtered**,
**loudness-normalised** to −23 LUFS by a linear gain (no compression or
limiting), **re-encoded** to Opus and AAC, and **looped** with a two-second
equal-power crossfade. The exact source timecodes, the filter and the gain
applied are recorded per bed in `public/audio/beds/manifest.json` under
`beds[].source`, so every change is reproducible from the artefact.

The loop regions were chosen by `scripts/audio-bed-scout.mjs`, which ranks every
candidate window in the source by how stationary it is, how free of near events,
and how well its two ends match across the crossfade — so the timecodes above
are a measurement rather than a preference.

**The distance filter is not an effect.** A field recordist stands in the
chorus; this layer is the chorus a few hundred metres off, which is the whole
reason it exists. Straight from the encoder the three recordings measured 6483,
9400 and 5786 Hz at the spectral centroid — night highest, because katydids
stridulate up there and the microphone was underneath them. They are therefore
filtered by ISO 9613-1 atmospheric absorption at 20 °C and 70% relative
humidity, at 700 m. Only air absorption is modelled; dense foliage scatters on
top of it in the same direction, so **700 m here does not claim the birds are
700 m away** — the figure is larger than the distance you would walk.

### Day

**"Amazon Jungle - Day"** by **RTB45**
Source: <https://freesound.org/s/473569/>
Licence: **CC BY 4.0** — <https://creativecommons.org/licenses/by/4.0/>
Modified: trimmed to 16s–106s, distance-filtered, loudness-normalised,
re-encoded and looped.

### Night

**"Amazon Jungle - Night"** by **RTB45**
Source: <https://freesound.org/s/473570/>
Licence: **CC BY 4.0** — <https://creativecommons.org/licenses/by/4.0/>
Modified: trimmed to 76s–166s, distance-filtered, loudness-normalised,
re-encoded and looped.

### Dawn

**"Sunrise in the Amazon Jungle"** by **maar_world**
Source: <https://freesound.org/s/546312/>
Licence: **CC0 1.0** — <https://creativecommons.org/publicdomain/zero/1.0/>
Modified: trimmed to 60s–150s, distance-filtered, loudness-normalised,
re-encoded and looped.

CC0 is a public-domain dedication and carries **no attribution requirement**.
It is listed anyway, because knowing where a file came from is worth more to
whoever maintains this next than the licence strictly demands.

### The obligation, stated plainly

The two RTB45 recordings are **CC BY 4.0**. That licence requires, wherever the
work is distributed, that the following be retained and reasonably visible:

- the **title** of the work,
- the **author**,
- a **link to the source**,
- a **link to the licence**, and
- an indication that the work was **modified**.

All five are present above for both files. The licence does not require the
credit to appear inside the running application, only that it accompany the
distribution in a manner reasonable to the medium.

> **This file now ships with the build.** `vite.config.js` carries an
> `rr-emit-credits` plugin that emits `CREDITS.md` into `dist/` at
> `generateBundle`, and fails the build if it is missing — silently shipping the
> audio without the attribution is the exact failure that guards against, so it
> does not degrade quietly.
>
> **Still open: where it is surfaced.** A file in `dist/` that nothing links to
> is defensible for a repository-shaped distribution and thin for a hosted one.
> The remaining options, in order of effort:
>
> 1. add a line of fine print to the gate screen in `index.html`, pointing at
>    `CREDITS.md`, which now definitely ships beside it;
> 2. add an About page to the settings panel — note that
>    `scripts/settings-check.mjs` asserts every settings page contains at least
>    one `.set-row` control, so a prose-only page would fail `npm run check`
>    until that assertion is relaxed.
>
> Neither has been done, because which one is right is a product decision rather
> than a technical one.

## Software

**three.js** — MIT licence. <https://threejs.org> ·
<https://github.com/mrdoob/three.js/blob/dev/LICENSE>

The renderer this whole thing is built on. MIT requires the copyright notice and
permission notice be retained in copies; the full text ships in
`node_modules/three/LICENSE`, and would need to accompany a distributed build for
the same reason the CC BY credits do.

Build and test tooling — Vite, Playwright, ws — is not redistributed and is not
listed here.

## Everything else

The terrain, the trees, the understorey, the water, the caves, the animals, the
birdsong, the insect wall, the weather, the reverb impulse responses and the six
jukebox tracks are all generated by code in this repository. Nothing in
`src/audio/music.js` is sampled; the tracks are synthesised from the definitions
in `TRACKS`. Audio pasted in by a player via the jukebox link box belongs to
whoever made it and is never redistributed by this project.
