import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The regression test for the buzz, applied to the animals.
 *
 * `audio-probe.mjs` measures the master bus at each stage of a trip and fails if
 * anything drifts back toward bright-and-dense. It cannot see the wildlife,
 * because main.js does not build it yet — so this does the same measurement with
 * the wildlife injected and, crucially, with its events FORCED rather than waited
 * for. A birdsong every four seconds is invisible in a six-second average; the
 * point of this file is to hold the exact voices under the analyser and see what
 * they are made of.
 *
 * The thresholds are audio-probe's, with one addition: each voice is measured
 * ALONE against the sober forest as a baseline, and a voice that raises the
 * spectral centroid or the 2–6 kHz fraction is named. Birdsong is high by nature,
 * so the number that matters is not the absolute centroid but PEAKINESS: a buzz
 * is a narrow band ringing, and a sine sweep is not.
 *
 *   node scripts/fauna-audio.mjs
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
const problems = [];
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`[error] ${m.text()}`);
});

/**
 * Get the page into a measurable state, from scratch if necessary.
 *
 * Four agents are editing this repo at once and Vite reloads the page whenever
 * any of them saves, which destroys the execution context mid-run. Rather than
 * fail on it, every measurement checks the probe is still there and rebuilds it
 * if it is not — the alternative is a script that only completes when nobody
 * else is working.
 */
async function ready(attempt = 0) {
  try {
    // `__at` and not `__probe`, because `__probe` is the FIRST thing the block
    // below assigns and this is the guard a retry lands on. An evaluate that
    // died halfway — a reload between the probe and the import — would leave
    // `__probe` set, short-circuit every retry, and hand the measurements a
    // half-built world with no roster in it. `__at` is the last thing set.
    if (await page.evaluate(() => !!window.__at)) return;
  } catch {
    /* context died between calls; fall through and rebuild */
  }
  await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
  await page.evaluate(() => {
    const gate = document.getElementById('gate');
    if (gate && !gate.classList.contains('gone')) document.getElementById('enter').click();
  }).catch(() => {});
  await page.waitForFunction(() => window.RR.audio?.ctx != null && window.RR.audio.ready === true, {
    timeout: 25000,
  });
  await page.waitForTimeout(1500);
  try {
  await page.evaluate(async () => {
    const engine = window.RR.audio;
    const ctx = engine.ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    engine.master.connect(analyser);
    window.__probe = {
      ctx,
      analyser,
      freq: new Float32Array(analyser.frequencyBinCount),
      time: new Float32Array(analyser.fftSize),
    };

    const { Wildlife, VOICE_COUNT, VOICE_NAMES } = await import('/src/audio/wildlife.js');
    // Taken from the module, never written down here. This harness had the
    // roster size as a literal 12 and the table grew to 16 without it noticing.
    // The NAMES come across for the same reason: the species list below is
    // generated from this, so there is no second roster to go stale.
    window.__voices = VOICE_COUNT;
    window.__voiceNames = VOICE_NAMES;
    const { makeRng } = await import('/src/core/util.js');
    /**
     * PUT THE VOICE'S RNG BACK WHERE IT STARTED, for A/B rows only.
     *
     * Every call in here draws from one shared stream, so two rows that differ
     * by one argument are also standing at different points in that stream and
     * differ by every `rngRange` inside the call as well. For most of this
     * table that does not matter — the question is "does this species buzz",
     * and a fresh realisation each time is if anything the better test. It
     * matters completely for the rows that exist to compare a parameter
     * against itself: without this, a bark's formant scaling is measured
     * against three different sets of random formants, and the result is noise
     * with a hypothesis written on it.
     */
    const w = new Wildlife(engine);
    window.__reseed = (s) => {
      w.rng = makeRng(s);
    };
    w.build();
    w.setMusic(window.RR.music);
    window.__w = w;
    /**
     * The listener is at the camera; every event below is placed a few metres
     * in front of it, which is the loudest case and therefore the one to
     * measure.
     *
     * The second argument is HEIGHT, and it exists for one voice. The buzzard
     * is placed 55–110 m above the listener by `update`, five times higher than
     * anything else in the file, and its `_place` is built with a 45 m
     * reference distance and a 500 m rolloff to match. Measured at head height
     * it would be a different spatial node from the one the wood actually
     * makes, and the row would be reporting a bird that does not exist.
     */
    window.__at = (d = 6, up = 0) => ({
      x: window.RR.camera.position.x,
      y: window.RR.camera.position.y + up,
      z: window.RR.camera.position.z - d,
    });
    window.RR.music.stop();
    window.RR.director.ground();
  });
  } catch (e) {
    if (attempt > 4) throw e;
    await page.waitForTimeout(1500);
    return ready(attempt + 1);
  }
  await page.waitForTimeout(1200);
}

/** Re-run a measurement if the page reloaded underneath it. */
async function resilient(fn, attempt = 0) {
  try {
    return await fn();
  } catch (e) {
    if (attempt > 3) throw e;
    await page.waitForTimeout(2000);
    await ready();
    return resilient(fn, attempt + 1);
  }
}

await page.goto(URL, { waitUntil: 'load' });
await ready();

async function measure(label, ms, drive) {
  await ready();
  if (drive) await page.evaluate(drive);
  const result = await resilient(() => page.evaluate(
    async ({ duration, driver }) => {
      const { ctx, analyser, freq, time } = window.__probe;
      const bins = analyser.frequencyBinCount;
      const acc = new Float64Array(bins);
      let frames = 0;
      let peak = 0;
      let sumSq = 0;
      let samples = 0;
      let clipped = 0;
      let maxVoices = 0;
      const fire = driver ? new Function(`return ${driver}`)() : null;
      const started = performance.now();
      let next = 0;
      while (performance.now() - started < duration) {
        if (fire && performance.now() - started > next) {
          fire();
          next += 400;
        }
        analyser.getFloatFrequencyData(freq);
        analyser.getFloatTimeDomainData(time);
        for (let i = 0; i < bins; i++) acc[i] += Math.pow(10, freq[i] / 20);
        for (let i = 0; i < time.length; i++) {
          const v = Math.abs(time[i]);
          if (v > peak) peak = v;
          if (v >= 0.999) clipped++;
          sumSq += time[i] * time[i];
          samples++;
        }
        maxVoices = Math.max(maxVoices, window.__w.voices);
        frames++;
        await new Promise((r) => setTimeout(r, 35));
      }
      const nyquist = ctx.sampleRate / 2;
      const binHz = nyquist / bins;
      let total = 0;
      let weighted = 0;
      let harsh = 0;
      let maxBin = 0;
      let logSum = 0;
      for (let i = 1; i < bins; i++) {
        const m = acc[i] / Math.max(1, frames);
        total += m;
        weighted += m * i * binHz;
        const hz = i * binHz;
        if (hz >= 2000 && hz <= 6000) harsh += m;
        if (m > maxBin) maxBin = m;
        logSum += Math.log(m + 1e-12);
      }
      const mean = total / (bins - 1);
      const geo = Math.exp(logSum / (bins - 1));
      return {
        rms: Math.sqrt(sumSq / Math.max(1, samples)),
        peak,
        clipped,
        centroid: total > 0 ? weighted / total : 0,
        harsh: total > 0 ? harsh / total : 0,
        peakiness: mean > 0 ? maxBin / mean : 0,
        flatness: mean > 0 ? geo / mean : 0,
        maxVoices,
      };
    },
    { duration: ms, driver: drive === undefined ? null : null }
  ));
  return { label, ...result };
}

/**
 * Run one voice on a loop for `ms` and measure only that.
 *
 * `every` is the gap between fires. Pass `Infinity` to fire it ONCE, which is
 * what a voice longer than a couple of seconds needs — see the skylark. There
 * is no branch for it: `next += Infinity` is `Infinity`, and the fire condition
 * is never true again.
 */
async function voice(label, body, ms = 5000, every = 700) {
  await ready();
  const result = await resilient(() => page.evaluate(
    async ({ duration, src, gap }) => {
      const { ctx, analyser, freq, time } = window.__probe;
      const fire = new Function('w', 'at', src);
      const bins = analyser.frequencyBinCount;
      const acc = new Float64Array(bins);
      let frames = 0;
      let peak = 0;
      let sumSq = 0;
      let samples = 0;
      let clipped = 0;
      let maxVoices = 0;
      const started = performance.now();
      let next = 0;
      while (performance.now() - started < duration) {
        const t = performance.now() - started;
        if (t >= next) {
          fire(window.__w, window.__at);
          next += gap;
        }
        analyser.getFloatFrequencyData(freq);
        analyser.getFloatTimeDomainData(time);
        for (let i = 0; i < bins; i++) acc[i] += Math.pow(10, freq[i] / 20);
        for (let i = 0; i < time.length; i++) {
          const v = Math.abs(time[i]);
          if (v > peak) peak = v;
          if (v >= 0.999) clipped++;
          sumSq += time[i] * time[i];
          samples++;
        }
        maxVoices = Math.max(maxVoices, window.__w.voices);
        frames++;
        await new Promise((r) => setTimeout(r, 35));
      }
      const nyquist = ctx.sampleRate / 2;
      const binHz = nyquist / bins;
      let total = 0;
      let weighted = 0;
      let harsh = 0;
      let maxBin = 0;
      let logSum = 0;
      for (let i = 1; i < bins; i++) {
        const m = acc[i] / Math.max(1, frames);
        total += m;
        weighted += m * i * binHz;
        const hz = i * binHz;
        if (hz >= 2000 && hz <= 6000) harsh += m;
        if (m > maxBin) maxBin = m;
        logSum += Math.log(m + 1e-12);
      }
      const mean = total / (bins - 1);
      const geo = Math.exp(logSum / (bins - 1));
      return {
        rms: Math.sqrt(sumSq / Math.max(1, samples)),
        peak,
        clipped,
        centroid: total > 0 ? weighted / total : 0,
        harsh: total > 0 ? harsh / total : 0,
        peakiness: mean > 0 ? maxBin / mean : 0,
        flatness: mean > 0 ? geo / mean : 0,
        maxVoices,
      };
    },
    { duration: ms, src: body, gap: every }
  ));
  return { label, ...result };
}

/**
 * `--only=music`: MEASURE THE COMPOSITE AND ITS REFERENCES, AND NOTHING ELSE.
 *
 * DEBUG ONLY, and it announces itself in the output for exactly that reason —
 * it skips the ~50 voice rows and with them the 0.12 wildlife ceiling, which is
 * the check in this file with the most teeth. `npm run check:fauna-audio` does
 * not pass it and nothing in package.json does.
 *
 * It exists because the composite check is a RATIO of two windows a few seconds
 * apart, and calibrating a ratio needs many samples of it, while a full run
 * spends five minutes on fifty rows that cannot affect it. This turns a
 * five-minute sample into a thirty-second one, which is the difference between
 * six samples and thirty when working out how much of the lift is drift.
 *
 * What it cannot answer: whether the lift is the same at the END of a full run
 * as it is thirty seconds in. Calibrate the exploration here, then confirm the
 * margin on full runs — that is what was done, and the two distributions are
 * recorded together beside MARGIN_DB.
 */
const MUSIC_ONLY = args.only === 'music';
if (MUSIC_ONLY) console.log('[--only=music] voice rows SKIPPED — this is not a gate run\n');

const rows = [];
rows.push(await measure('baseline (no music)', 5000));

/**
 * `w._songBudget = 5` in front of every song.
 *
 * `song` is rate-limited by a leaky bucket now — see SONG_REFILL in
 * wildlife.js, which exists because the perchers were producing seventy-two
 * phrases a minute. This file fires a voice every seven hundred milliseconds on
 * purpose (the skylark excepted — see its row), which is far above any rate the
 * wood will actually allow, so without
 * topping the bucket up the later fires in each window are dropped and the
 * measurement becomes "how much of it got through" rather than "what does it
 * sound like". Refilling is the honest thing here: the point of this harness is
 * to hold one voice under the analyser, not to test the limiter.
 */
const sing = (i) => `w._songBudget = 5; w.song(at(9), ${i})`;

/**
 * THE ROSTER COMES FROM THE MODULE. THERE IS NO SPECIES LIST IN THIS FILE.
 *
 * This was twelve hand-written labels against twelve hand-written indices, and
 * that is the entire reason the section is written the way it is now. The table
 * grew to sixteen and the harness went on measuring the first twelve, silently,
 * for as long as it took somebody to notice — so the four NEWEST voices, which
 * are by a distance the four most likely to be wrong, were the only ones in the
 * wood nobody was listening to. A regression test that quietly stops covering
 * the new work is worse than no regression test, because it still prints "no
 * problems".
 *
 * `fauna.js` had the identical bug from the identical cause and took the
 * identical fix. Anything that needs the roster takes it from `wildlife.js`,
 * where the roster is defined by what the thing sounds like, and keeps no copy.
 */
const { count: VOICE_COUNT, names: VOICE_NAMES } = await page.evaluate(() => ({
  count: window.__voices,
  names: window.__voiceNames,
}));

/**
 * The two species that cannot be measured on the default settings.
 *
 * Keyed by the module's own name and not by index, because an index is exactly
 * the thing that goes stale when a row is inserted above it — and goes stale
 * without saying so, which would leave the nightingale's `dark` on somebody
 * else's row and the nightingale itself measured at the bottom of its range.
 * The check below turns a name that stops existing into a failure instead.
 */
const SPECIAL = {
  // The two voices in the table with a FLOOR on their window. At `dark` 0 they
  // are singing at the bottom of their range, which is not what they are for.
  potoo: { before: 'w.dark = 0.8; ', ms: 9000 },
  // And a long window, for the reason the bellbird has one below: five whistles
  // a second apart do not fit in five seconds.
  tinamou: { before: 'w.dark = 0.7; ', ms: 9000 },
  /**
   * The one row that is about DURATION rather than timbre, and it needs both
   * of these to be measured as itself.
   *
   * A LONGER WINDOW, because it streams for seven to twenty seconds unbroken
   * and the default 5 s would score the opening of it and call that the bird.
   * Nine and not twenty, though: the window has to stay inside the SHORTEST
   * stream the row can produce, because a short wren measured over twenty
   * seconds is a few seconds of song averaged with a lot of empty forest, and
   * the row would report a quieter, duller bird than the one that sang.
   *
   * FIRED ONCE, because `STREAM_MAX` is 1 — a second wren on top of a running
   * one is refused by the module, by design. Firing every 700 ms would measure
   * one song and twelve rejections, and read as a voice being throttled.
   */
  musicianwren: { ms: 9000, every: Infinity },
  /**
   * The enormously spaced rows, which the default window cannot see whole.
   *
   * A bellbird is one clang, most of a second of nothing, and then a long
   * whistle; a tinamou is five whistles a second apart; a potoo is six notes
   * spread over five. Measured over 5 s the bellbird reports as a transient in
   * silence. Nine seconds is the shortest window that contains these phrases.
   */
  bellbird: { ms: 9000 },
};
for (const name of Object.keys(SPECIAL)) {
  if (!VOICE_NAMES.includes(name)) {
    problems.push(`[harness] no voice named "${name}" — its special case is dead`);
  }
}

for (let i = 0; i < VOICE_COUNT && !MUSIC_ONLY; i++) {
  const name = VOICE_NAMES[i];
  const { before = '', ms = 5000, every = 700 } = SPECIAL[name] ?? {};
  rows.push(await voice(name, `${before}${sing(i)}`, ms, every));
}

/**
 * The voice index the four call rows use.
 *
 * By name for the reason `SPECIAL` is by name. A trogon because its `call` row
 * is two notes rather than one, so `contact` — the only kind that takes its
 * count from the table instead of overriding it — has something to show.
 */
const CALLER = Math.max(0, VOICE_NAMES.indexOf('trogon'));

// The optional third element is the capture window, for a voice that would
// otherwise outlast it.
for (const [name, body, ms] of [
  ['flush', 'w.flush(at(4), 1, 0)'],
  ['bolt (deer)', 'w.bolt(at(5), "deer", 1)'],
  ['bolt (rabbit)', 'w.bolt(at(4), "rabbit", 1)'],
  ['bolt (squirrel)', 'w.bolt(at(5), "squirrel", 1)'],
  ['hooves', 'for (let i=0;i<5;i++) setTimeout(() => w.hoof(at(6), "deer", 1), i*120)'],
  ['woodpecker', 'w.woodpecker(at(24))'],
  ['macaw pair', 'w.macaw(at(30))'],
  /**
   * THE THREE THAT ARE NOT IN THE TABLE AND NOT IN THE CHORUS.
   *
   * `wildlife.js` groups these together and so does this, because they share
   * the property that makes them worth measuring separately: each is the only
   * thing of its kind, none of them goes through `song`, and so not one of them
   * is touched by the sixteen rows above no matter how the roster grows.
   *
   * The PARROT MOB is the one to watch of the three. It is deliberately the harshest
   * voice in the file — a tear rather than a screech, three overlapping puffs laid
   * across a throat to rough up an envelope whose spectrum never moves — and
   * "roughness that is not a buzz" is precisely the distinction peakiness is
   * here to police. If any voice in this wood is going to ring, it is this one.
   *
   * The HAWK-EAGLE is placed HIGH, which is not decoration: `at(90, 70)` is 90 m
   * out and 70 m up, inside the 55–110 m band `update` actually uses, and its
   * spatial node is built for that range. It is also nearly a pure tone, so a
   * peaky reading is expected of it in the way the owl's is.
   */
  ['parrot mob', 'w.parrots(at(50), 0.8)'],
  ['guan', 'w.guan(at(60))'],
  ['hawk-eagle', 'w.eagle(at(90, 70))'],
  /**
   * The four call kinds, which are one function and six numbers apart.
   *
   * Same voice and same seed across all four — the bark rows' reasoning, and
   * for once these rows really are a parameter compared against itself, since
   * `kind` is the only thing that differs. Without the reseed each row would
   * also be standing at a different point in the shared rng stream and the
   * spread between them would be draws, not kinds.
   *
   * `alarm` is the one with a reason to ring: it is the only call shape that
   * deliberately flattens its glide, to 0.12, and a note that will not move is
   * the closest thing in this file to a parked resonance.
   */
  ...['contact', 'alarm', 'flight', 'beg'].map((kind) => [
    `call (${kind})`,
    `window.__reseed("ab"); w.call(at(11), ${CALLER}, "${kind}")`,
  ]),
  ['deer bark', 'w._bark(at(12), w.ctx.currentTime + 0.04, 1)'],
  /**
   * THE SAME BARK AT THREE BODY SIZES — and note the `__reseed` in front of
   * each one, which is the difference between a measurement and a guess.
   *
   * `mass` is `scale^1.6`, and the three values are the wood's actual extremes
   * rather than round numbers: a deer is `[0.86, 1.15]` times its sex's size
   * (stag 1.14, doe 0.94) times 0.6 if it is a juvenile, so the biggest stag
   * this forest can produce is mass 1.54 and the smallest fawn is 0.31. Test
   * outside that and you are measuring an animal that cannot walk out of the
   * trees.
   *
   * Every row is reseeded to the same value, so the formant draws, the rates
   * and the inter-bark gaps are IDENTICAL across the three and mass is the
   * only thing that differs. The first version of these rows did not do that
   * and reported the fawn as the DEEPEST of the three, which is backwards —
   * three independent realisations of a randomised call differ by more than a
   * 36% formant scaling does, so that spread was rng and nothing else.
   *
   * WHAT THESE ROWS TEST, AND — MORE USEFULLY — WHAT THEY CANNOT.
   *
   *   PEAKINESS is the one that matters and the reason the rows are here. It
   *   fails at 900 and sits in the thirties across all three. A stag's
   *   formants are the lowest anything in this file produces, and the real
   *   risk of scaling them down is that two land close enough together to
   *   ring. If this column ever climbs with mass, that is what happened.
   *
   *   HARSH must stay at or under the silent forest's own baseline (0.330).
   *   Measured 0.291 / 0.276 / 0.265 for stag / doe / fawn.
   *
   *   CENTROID DOES NOT MEASURE THE PITCH LAW, and it is worth writing down
   *   why, because the column is right there and it is the obvious thing to
   *   read. Reseeding fixed the rng confound and the direction did not change:
   *   stag 1725, doe 1692, fawn 1581, i.e. the SMALLEST animal still reports
   *   the lowest centroid while its formants are provably the highest. Three
   *   things in this harness swamp the effect and none is a defect in the
   *   bark. The body is fired on a loop every ~700 ms while a bark schedules
   *   up to four events 0.9–1.7 s apart, so successive fires overlap. Mass
   *   deliberately changes the NUMBER of barks, so the rows do not contain
   *   equal energy. And `_bark` early-returns above 85% of the voice ceiling,
   *   so the stag — which asks for the most — is the one getting dropped: it
   *   reports the fewest nodes of the three (19 against 26) despite scheduling
   *   the most. A five-second window of mostly forest with a short, throttled,
   *   overlapping event inside it cannot resolve a 37% formant shift.
   *
   * So the pitch law is verified by construction instead, which for once is
   * the stronger check rather than the lazy one. Over the real mass range,
   * `clamp(mass^(-1/3), 0.86, 1.18)` gives 0.8655 for the biggest stag and
   * 1.18 for the smallest fawn — the fawn's formants exactly 1.36x above the
   * stag's. That is arithmetic, not an inference from a spectrum.
   *
   * Note which end of that clamp is load-bearing, because it is not the one it
   * looks like: the LOWER bound never fires. The biggest animal the wood can
   * make lands at 0.8655, six thousandths above the floor — close enough to
   * document, far enough that the bound is doing nothing today. It is a guard
   * against somebody widening the deer's scale range later, not a limit that
   * currently shapes the sound. The UPPER bound does fire, and hard: a small
   * fawn's raw value is 1.47, and 1.18 is where it stops being a roe.
   *
   * The `doe` row must match `deer bark` above to within run-to-run noise,
   * because mass = 1 is defined to leave the original untouched. Measured
   * 1692 vs 1560 Hz centroid, 40 vs 33 peakiness — the gap is the reseed, not
   * the mass, and it is inside the spread two identical rows show here.
   */
  ['bark (stag, m=1.54)', 'window.__reseed("ab"); w._bark(at(12), w.ctx.currentTime + 0.04, 1, null, 1.54)'],
  ['bark (doe, m=1.0)', 'window.__reseed("ab"); w._bark(at(12), w.ctx.currentTime + 0.04, 1, null, 1.0)'],
  ['bark (fawn, m=0.31)', 'window.__reseed("ab"); w._bark(at(12), w.ctx.currentTime + 0.04, 1, null, 0.31)'],
  ['bolt (stag, m=1.54)', 'window.__reseed("ab"); w.bolt(at(5), "deer", 1, 1.54)'],
  ['bolt (doe, m=1.0)', 'window.__reseed("ab"); w.bolt(at(5), "deer", 1, 1.0)'],
  ['bolt (fawn, m=0.31)', 'window.__reseed("ab"); w.bolt(at(5), "deer", 1, 0.31)'],
  ['hooves (stag)', 'window.__reseed("ab"); for (let i=0;i<5;i++) setTimeout(() => w.hoof(at(6), "deer", 1, 1.54), i*120)'],
  ['hooves (fawn)', 'window.__reseed("ab"); for (let i=0;i<5;i++) setTimeout(() => w.hoof(at(6), "deer", 1, 0.31), i*120)'],
  ['squirrel scold', 'w._chitter(at(8), w.ctx.currentTime + 0.04, 1)'],
  ['acorn falling', 'w.fall(at(6))'],
  ['fly', 'w.fly(at(4))'],
  ['owl', 'w.nightGain = 0.3; w.owl(at(50))'],
  ['insects', 'w.nightGain = 0.3; w.stridulate(at(7))'],
]) {
  if (MUSIC_ONLY) break;
  rows.push(await voice(name, body, ms ?? 5000));
}

/**
 * THE COMPOSITE, AND THE THREE WINDOWS IT TAKES TO MEASURE IT HONESTLY.
 *
 * Everything at once, with the jukebox running and the trip at its peak: the
 * worst case for both level and node count. The row is the only one in the file
 * that deliberately plays the record, and that is what made it impossible to
 * judge against an absolute number — see the comment on MARGIN_DB below.
 *
 * So it is measured against a REFERENCE captured in the same run, on the same
 * analyser, over the same window length, with the record and the trip in the
 * same place and ZERO wildlife events fired. Two of them, one either side of
 * the composite:
 *
 *   - The record is a step sequencer, not a loop of audio. Its own level moves
 *     bar to bar, and the trip's level moves with `state.time`, which advances
 *     in real seconds while a window is open. A single reference taken before
 *     the composite is therefore taken at a different point in both. Bracketing
 *     measures that drift instead of inheriting it: the composite sits midway
 *     between the two, so the mean of them removes the linear part of whatever
 *     is moving. The gap between them is printed on every run and gated
 *     separately — see SPREAD_MAX_DB — because a bracket wide enough to be
 *     hiding something should void the run rather than pass it.
 *
 * `stage()` runs before every one of the three windows and not once before all
 * three, for the same reason. Pinning `step16` puts every window at the same
 * bars of the same record; re-seeking the director puts every window at the
 * same trip level. Both are free, and between them they delete the largest
 * within-run term in the ratio.
 */
const REF_MS = 7000;

const stage = async () => {
  await page.evaluate(() => {
    const m = window.RR.music;
    if (!m.playing) m.start();
    // The sequencer's position. The track loops every `bars * 16` steps, so
    // zeroing it hands every window the same bars in the same order.
    m.step16 = 0;
    window.RR.director.seek(190);
  });
  // Long enough for `startAt`'s gain ramp (setTargetAtTime, tau 0.4) to be
  // inaudibly short of 1 — six time constants. It is spent before every window
  // and not just the first, because the point of `stage` is that the three
  // windows are preceded by IDENTICAL conditioning, not merely sufficient
  // conditioning.
  await page.waitForTimeout(2500);
};

/**
 * The reference body FIRES NOTHING, and it goes through `voice()` rather than
 * `measure()` on purpose: identical code path, identical loop, identical
 * accumulation, identical window, right down to the no-op function being called
 * on the same 700 ms cadence. The only difference between this row and the
 * composite is what that function does — here, nothing at all.
 *
 * `w.tripLevel = 1` is set anyway. It is a wildlife field and with no events it
 * changes nothing, but a reference that differs from the composite in any state
 * at all is a reference that has to be argued about later.
 */
const REF_BODY = 'w.tripLevel = 1;';
const COMPOSITE_BODY =
  // The roster size comes from the module (`window.__voices`), not from a
  // literal 12 — which is what this was, and what silently stopped
  // exercising the newest rows the moment they landed. The bolt and the
  // hooves are a big stag, because the worst case for level and node count
  // is the biggest animal in the wood leaving at speed.
  'w.tripLevel = 1; w._songBudget = 5; w.song(at(8), Math.floor(Math.random()*window.__voices), {answer:true}); w.flush(at(5),1,1); w.bolt(at(6),"deer",1,1.54); w.hoof(at(5),"deer",1,1.54);';

/**
 * STAGE, MEASURE, THEN CHECK THE STAGING SURVIVED THE WINDOW.
 *
 * `voice()` calls `ready()`, and `ready()` rebuilds the world if the page has
 * reloaded underneath it — which it does, because four agents are editing this
 * repo and Vite reloads on every save. A rebuild ends with `music.stop()` and
 * `director.ground()`. So a reload landing between `stage()` and the window it
 * staged leaves that window measuring a SOBER, SILENT forest under a label
 * saying it played the record.
 *
 * That is not a hypothetical rounding error, it inverts the answer. A destaged
 * reference reads around 0.02 against a composite near 0.13 and invents a lift
 * of +16 dB; a destaged COMPOSITE is worse, because it reads far too quiet, the
 * lift goes hugely negative, and the run PASSES. A silent failure that passes is
 * the only kind this file cannot afford.
 *
 * So the state is read back after every window and the window is retaken if it
 * was not what it claimed. `__at` catches the reload itself — it is the last
 * thing `ready()` assigns and therefore the honest witness that the probe
 * standing now is the one that was standing then.
 */
async function stagedVoice(label, body, attempt = 0) {
  await stage();
  const row = await voice(label, body, REF_MS);
  const intact = await page
    .evaluate(() => ({
      probe: !!window.__at,
      playing: window.RR.music?.playing === true,
      // `active` is false once `time` runs past `total`, which is the other way
      // a window can quietly become a sober one. TRIP_SECONDS is 290 and the
      // seek is 190, so this can only be a reload, but it costs nothing to say
      // which of the two happened.
      trip: window.RR.director?.state?.active === true,
    }))
    .catch(() => ({ probe: false, playing: false, trip: false }));
  if (intact.probe && intact.playing && intact.trip) return { ...row, music: true };
  if (attempt >= 2) {
    problems.push(
      `[harness] ${label}: window was not staged (probe ${intact.probe}, playing ${intact.playing}, trip ${intact.trip}) after ${attempt + 1} attempts`
    );
    return { ...row, music: true };
  }
  await ready();
  return stagedVoice(label, body, attempt + 1);
}

const refA = await stagedVoice('ref: music+peak, no fauna', REF_BODY);
const composite = await stagedVoice('all + music + peak', COMPOSITE_BODY);
const refB = await stagedVoice('ref: music+peak, no fauna (2)', REF_BODY);
rows.push(refA, composite, refB);

const pad = (s, n) => String(s).padEnd(n);
// 30 and not 22: the reference rows have the longest labels in the file and a
// truncated one would print as an unrecognisable stub in the row it matters
// most to read.
const LABEL_W = 30;
console.log(
  pad('voice', LABEL_W),
  pad('rms', 8),
  pad('peak', 8),
  pad('centroid', 10),
  pad('harsh', 8),
  pad('peaky', 8),
  pad('flat', 8),
  pad('clip', 6),
  'nodes'
);
for (const r of rows) {
  console.log(
    pad(r.label, LABEL_W),
    pad(r.rms.toFixed(4), 8),
    pad(r.peak.toFixed(3), 8),
    pad(`${r.centroid.toFixed(0)} Hz`, 10),
    pad(r.harsh.toFixed(3), 8),
    pad(r.peakiness.toFixed(0), 8),
    pad(r.flatness.toFixed(3), 8),
    pad(r.clipped, 6),
    r.maxVoices
  );
}

/**
 * PEAKINESS IS THE ONE THAT MATTERS HERE.
 *
 * Birdsong is legitimately bright — a wren lives at 4 kHz — so the centroid and
 * the harsh fraction cannot be held to the master bus's limits for a voice
 * measured alone. What a buzz IS, though, is a narrow band ringing, and that is
 * what peakiness measures. A swept sine spreads its energy across the sweep, so
 * a bird averaged over five seconds is not peaky; a resonant filter parked on a
 * band is. The ceiling is generous because a pure held tone (the owl) is
 * legitimately peaky and is also unmistakably not a buzz.
 */
const fails = [];
for (const r of rows) {
  if (r.clipped > 0) fails.push(`${r.label}: ${r.clipped} clipped samples`);
  if (r.peak > 0.999) fails.push(`${r.label}: peak at full scale`);
  if (r.peakiness > 900) fails.push(`${r.label}: peakiness ${r.peakiness.toFixed(0)} — something is ringing`);
  // The ceiling in wildlife.js is 58 and it is enforced per node, so a handful
  // over is a burst that started under the limit and finished just past it.
  if (r.maxVoices > 68) fails.push(`${r.label}: ${r.maxVoices} concurrent nodes — scheduling burst`);
  /**
   * NOTHING IN THIS FILE MAY BE AS LOUD AS THE RECORD ON THE JUKEBOX — except
   * the three rows that are deliberately playing the record.
   *
   * `r.music` IS A FLAG ON THE ROW, NOT A TEST ON ITS LABEL, and that is a
   * deliberate correction rather than a tidy-up. This was `/\+ music/` against
   * the label, and before that it was very nearly `/music/`, which would have
   * quietly exempted `baseline (no music)` — the QUIETEST row in the file — from
   * the ceiling it exists to enforce. A rule that decides what a measurement
   * means by pattern-matching its display name will keep doing that every time
   * somebody adds a row or rewords one. The rows that play the record are
   * constructed a few lines apart from each other; they can say so.
   */
  if (!r.music && r.rms > 0.12) {
    fails.push(`${r.label}: rms ${r.rms.toFixed(3)} — louder than the music`);
  }
}

/**
 * THE COMPOSITE IS JUDGED AGAINST THE RECORD, NOT AGAINST A NUMBER.
 *
 * `all + music + peak` starts the jukebox and seeks the trip to its peak on
 * purpose, so holding it to a ceiling defined as "quieter than the record"
 * asked it to be quieter than itself. It failed for that reason and for no
 * other, for two commits.
 *
 * WHY THE FLAT NUMBER THAT REPLACED IT WAS ALSO WRONG. Twelve full runs, six of
 * a clean tree at HEAD against six of the working tree, strictly alternated on
 * isolated worktrees on separate ports:
 *
 *     clean HEAD   0.1105 0.1212 0.1350 0.1357 0.1357 0.1365   fails 5/6 at 0.12
 *     working tree 0.0946 0.1146 0.1171 0.1342 0.1345 0.1362   fails 3/6 at 0.12
 *
 * A 3.2 dB swing on IDENTICAL CODE — and the clean tree is the one that fails
 * more often. The metric is load-sensitive on top of that: slower runs read
 * quieter, so a busy machine passes a build a quiet one rejects. Any fixed
 * ceiling has to clear that 3.2 dB before it starts having an opinion about the
 * animals, and a 0.20 ceiling clears it by about 1.3 dB — which is to say it
 * would have failed randomly, which is the exact thing it was written to stop.
 *
 * Layer attribution settled what is actually in the number. A window firing the
 * record and the trip peak with ZERO wildlife events reads 0.127–0.165, over
 * the old 0.12 ceiling by itself; across a full run all 49 wildlife-only rows
 * sit at 0.019–0.045, never within a factor of 2.6 of it. Measured composite
 * peaks are 0.45–0.66 against a limiter at −5 dBFS, ratio 18. The row was
 * reporting the master limiter's output level and nothing whatsoever about the
 * animals, and it will go on doing that however the threshold is set.
 *
 * So the composite is compared to a reference captured in the SAME RUN, on the
 * same analyser, over the same window, with the record and the trip staged
 * identically and no wildlife fired — which is what the original rule meant all
 * along. Not "is it quiet", which it cannot be, but "does the wildlife add more
 * than MARGIN_DB on top of the record". Every term the twelve runs above were
 * swinging on — machine load, the state of the tree, the bed, the limiter's
 * operating point — is in the reference as much as it is in the composite, and
 * divides out.
 *
 * WHAT THIS WAS CALIBRATED AGAINST, because it is the first thing that will
 * change. There was NO AMBIENCE BED IN THE TREE when the numbers below were
 * taken: `public/audio/beds/manifest.json` was renamed to `.off` and
 * `AmbienceBed.load` returns null, the stock bed-free state the repo ships. A
 * placeholder bed at gain 0.3 had briefly been live and put roughly 1.5 dB of
 * pink noise into every window; those readings were discarded rather than
 * averaged in. A real bed is coming and will raise every window again. The
 * PREDICTION — and it is a prediction, not something measured here — is that a
 * music-relative ceiling absorbs it, because the bed lands in the reference and
 * the composite alike and cancels in the ratio. That is the entire reason this
 * check is relative. If the bed lands and this line starts arguing, check that
 * prediction first: re-measure the lift with and without the bed before touching
 * MARGIN_DB.
 */
/**
 * HOW MUCH THE WILDLIFE MAY ADD ON TOP OF THE RECORD, IN dB.
 *
 * MEASURED, NOT CHOSEN. Twelve full runs of this file on a quiet machine, bed
 * off, nothing else on the GPU — refA / composite / refB / lift dB / spread dB.
 * The first seven set the margin; the last five were run afterwards, unchanged,
 * to confirm it:
 *
 *     0.1303 0.1353 0.1111   +1.00   1.39
 *     0.1343 0.1376 0.1115   +0.98   1.62
 *     0.1274 0.1343 0.1051   +1.26   1.67
 *     0.1281 0.1305 0.1117   +0.74   1.19
 *     0.1247 0.1328 0.1074   +1.17   1.30
 *     0.1271 0.1343 0.1114   +1.04   1.15
 *     0.1282 0.1406 0.1104   +1.43   1.30
 *     ---- margin fixed at 2.5 here, nothing below it fed the choice ----
 *     0.1110 0.1321 0.1141   +1.40   0.24
 *     0.1276 0.1318 0.1105   +0.88   1.25
 *     0.1289 0.1345 0.1118   +0.97   1.23
 *     0.1278 0.1346 0.1145   +0.92   0.95
 *     0.1239 0.1337 0.1076   +1.26   1.22
 *
 *     lift       0.739 … 1.430   mean 1.09, sd 0.22, peak-to-peak 0.69 dB
 *     reference  0.1125 … 0.1229                     peak-to-peak 0.77 dB
 *     spread     0.238 … 1.672
 *
 * 2.5 dB is 1.07 dB above the worst of those twelve, which is about six
 * standard deviations, and 1.5x the widest peak-to-peak swing the lift has ever
 * shown here. Compare what it replaced: a flat 0.20 sat about 1.3 dB above the
 * loudest of the twelve runs quoted above, against a metric that swings 3.2 dB
 * — 0.4x its own noise, i.e. a coin toss.
 *
 * WHAT IT TAKES TO TRIP IT, measured, because a gate nobody has seen fail is a
 * gate nobody should trust. The composite body's wildlife was scaled up by
 * multiplying `songGain` and `bodyGain` together, full runs, everything else
 * untouched:
 *
 *     1x   (shipped)   lift +1.09 mean of twelve      pass
 *     3x   (+9.5 dB)   lift +1.87                     PASS — still under
 *     16x  (+24.1 dB)  lift +4.29                     fail, and the only fail
 *
 * Interpolating the upper leg, the margin trips at about 4.6x — call it +13 dB
 * on the wildlife layer. THAT IS BLUNT, AND THE BLUNTNESS IS THE LIMITER, NOT
 * THE MARGIN: 24 dB of extra animal bought 3.2 dB of extra composite, roughly
 * 7:1 compression, because the master limiter is already pinned by the record
 * before the first bird opens its mouth. No threshold on this row can be sharp,
 * whatever number it is set to, and tightening the margin toward the noise
 * would buy a little sharpness at the price of the random failures this change
 * exists to stop. The sharp instrument for wildlife level is the 0.12 per-row
 * ceiling above, which measures the animals with no record playing at all and
 * is nowhere near its limit (49 rows, 0.019–0.045). This row is the coarse
 * backstop behind it. Read it that way.
 *
 * THE EVIDENCE THAT THE RATIO ACTUALLY CANCELS THE SWING, which is the whole
 * claim and is not demonstrated by the seven runs above — that machine was too
 * quiet, its absolute composite moved only 0.65 dB all day. Fourteen
 * `--only=music` samples caught the metric in two distinct absolute states, a
 * quiet cluster around reference 0.104 and a loud one around 0.129:
 *
 *     reference  0.1034 … 0.1297   =  1.97 dB of common-mode swing
 *     composite  0.1331 … 0.1666   =  1.95 dB, i.e. it moved with it
 *     lift        1.887 … 2.679    =  0.79 dB
 *
 * A 2 dB shift in what the master bus was doing produced 0.79 dB of movement in
 * the lift. That is the common-mode term dividing out, measured rather than
 * asserted. It is not perfect and the residual has a direction worth knowing:
 * the loud cluster read ~0.33 dB LOWER lift than the quiet one, which is what a
 * limiter should do — the deeper it is in, the harder it squashes whatever the
 * animals add on top.
 *
 * Those fourteen samples sit ~1.2 dB hotter than a gate run and their lift is
 * NOT comparable to it. `--only=music` skips the voice rows, and the voice rows
 * leave `w.dark` and `w.nightGain` mutated (the potoo, tinamou, owl and insect
 * rows each set them and nothing puts them back), so the composite in a full
 * run fires a quieter set of animals than the composite in a fast one. A fast
 * sample can therefore exceed this margin without meaning anything, which is
 * one more reason it prints that it is not a gate run.
 *
 * `--margin=` overrides it. That exists so the gate's teeth can be demonstrated
 * without editing the file — `--margin=-3` on a healthy tree must fail — and it
 * is a debug knob, not a way to get a red build to go green. Nothing in
 * package.json passes it.
 */
const MARGIN_DB = Number(args.margin ?? 2.5);

/**
 * WHEN THE BRACKET IS TOO WIDE TO INTERPOLATE ACROSS.
 *
 * Its own constant and not MARGIN_DB, because the two numbers measure different
 * things and tying them together was wrong. `refSpread` is the SLOPE of the
 * drift across ~26 s, not the error in the mean: the composite sits midway
 * between the two references, so the mean already removes the linear part of
 * whatever is drifting, and only the curvature survives into the lift. That is
 * why a spread of 1.1–1.7 dB coexists with a lift that repeats to a fifth of a
 * dB.
 *
 * The drift is real and nearly always in the same direction — refA is the
 * louder end in eleven of the twelve runs recorded above, by 0.24–1.67 dB, the
 * twelfth being the one that came in at 0.24 and leaned the other way. It is
 * NOT the animals: `maxVoices` reads 0 in the first reference row against 48–59
 * in the composite, so nothing of the wildlife is sounding before it.
 *
 * The SECOND reference is not always quite as clean — it has been seen with
 * `maxVoices` 3, which is the composite's own tail still ringing 2.5 s later,
 * against 59 at its peak. That biases refB up, the reference up, and therefore
 * the lift DOWN, so it makes the gate slightly more forgiving and never more
 * severe. It was left alone rather than fixed with a longer settle: widening
 * the gap between the brackets to chase three nodes would have traded a known
 * conservative bias for more of the drift above, and it would have invalidated
 * the twelve-run distribution the margin is built on. If it ever grows past a
 * handful of nodes, that trade is worth revisiting.
 *
 * The
 * leading suspicion is the trip ducking the world back down after `ready()`
 * grounded it, plus the drone's own gain LFOs, which run at 0.017–0.085 Hz —
 * periods of 12 to 59 s, against a bracket 26 s wide. That is a hypothesis and
 * nobody has measured it; do not repeat it as fact.
 *
 * So 3.0 dB is not a tolerance on the drift, it is a floor under GROSS failure:
 * a window that lost the record entirely reads around 0.02 against 0.13 and
 * shows up here as ~16 dB. It is 1.8x the worst honest spread seen and an order
 * of magnitude under the thing it is looking for.
 */
const SPREAD_MAX_DB = 3.0;

const dbRatio = (a, b) => 20 * Math.log10(a / Math.max(b, 1e-9));
const reference = (refA.rms + refB.rms) / 2;
const lift = dbRatio(composite.rms, reference);
/**
 * How far the two reference windows — identical conditioning, their centres
 * about 26 s apart, one composite between them — disagree with each other.
 *
 * Printed on every run rather than assumed, because it is the number that says
 * how much drift the bracket had to absorb before the lift meant anything. It
 * is measured at 1.15–1.67 dB and is a SLOPE, not an error bar; see
 * SPREAD_MAX_DB for why those are not the same thing.
 */
const refSpread = Math.abs(dbRatio(refB.rms, refA.rms));
// Sign carried rather than a hardcoded '+', which printed the debug knob's own
// limit as "+-3.00 dB" — the one line whose whole job is to be read carefully.
const signed = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
console.log(
  `\nmusic-relative: composite ${composite.rms.toFixed(4)} vs reference ${reference.toFixed(4)} ` +
    `(${refA.rms.toFixed(4)} / ${refB.rms.toFixed(4)}, spread ${refSpread.toFixed(2)}/${SPREAD_MAX_DB.toFixed(2)} dB)` +
    `\n                lift ${signed(lift)} dB, limit ${signed(MARGIN_DB)} dB`
);
if (lift > MARGIN_DB) {
  fails.push(
    `all + music + peak: wildlife adds ${signed(lift)} dB over the record ` +
      `(rms ${composite.rms.toFixed(4)} vs reference ${reference.toFixed(4)}, limit ${signed(MARGIN_DB)} dB)`
  );
}
/**
 * A REFERENCE THAT DISAGREES WITH ITSELF CANNOT JUDGE ANYTHING.
 *
 * If the two halves of the bracket are further apart than SPREAD_MAX_DB, the
 * run did not hold the record and the trip still enough for the lift to be a
 * measurement of the wildlife, and the correct answer is "this run is void",
 * not a pass. Failing is right rather than warning: a gate that prints a caveat
 * and exits 0 is a gate nobody reads.
 */
if (refSpread > SPREAD_MAX_DB) {
  fails.push(
    `reference disagrees with itself by ${refSpread.toFixed(2)} dB ` +
      `(${refA.rms.toFixed(4)} vs ${refB.rms.toFixed(4)}, limit ${SPREAD_MAX_DB.toFixed(2)} dB) ` +
      `— the run cannot judge the composite`
  );
}
if (problems.length) fails.push(...problems);

writeFileSync(
  `${OUT}/fauna-audio.json`,
  JSON.stringify(
    {
      rows,
      // The music-relative verdict, broken out so a run can be compared with
      // another run without re-deriving it from the row list.
      music: {
        refA: refA.rms,
        refB: refB.rms,
        reference,
        composite: composite.rms,
        liftDb: lift,
        refSpreadDb: refSpread,
        marginDb: MARGIN_DB,
      },
      fails,
    },
    null,
    2
  )
);
console.log(fails.length ? `\nPROBLEMS:\n  ${fails.join('\n  ')}` : '\nno problems');
await browser.close();
process.exitCode = fails.length ? 1 : 0;
