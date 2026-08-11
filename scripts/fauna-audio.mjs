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
  // The one voice in the table with a FLOOR on its window. At `dark` 0 it is
  // singing at the bottom of its range, which is not what it is for.
  nightingale: { before: 'w.dark = 0.8; ' },
  /**
   * The one row that is about DURATION rather than timbre, and it needs both
   * of these to be measured as itself.
   *
   * A LONGER WINDOW, because it streams for seven to twenty seconds unbroken
   * and the default 5 s would score the opening of it and call that the bird.
   * Nine and not twenty, though: the window has to stay inside the SHORTEST
   * stream the row can produce, because a short lark measured over twenty
   * seconds is a few seconds of song averaged with a lot of empty forest, and
   * the row would report a quieter, duller bird than the one that sang.
   *
   * FIRED ONCE, because `STREAM_MAX` is 1 — a second lark on top of a running
   * one is refused by the module, by design. Firing every 700 ms would measure
   * one song and twelve rejections, and read as a voice being throttled.
   */
  skylark: { ms: 9000, every: Infinity },
};
for (const name of Object.keys(SPECIAL)) {
  if (!VOICE_NAMES.includes(name)) {
    problems.push(`[harness] no voice named "${name}" — its special case is dead`);
  }
}

for (let i = 0; i < VOICE_COUNT; i++) {
  const name = VOICE_NAMES[i];
  const { before = '', ms = 5000, every = 700 } = SPECIAL[name] ?? {};
  rows.push(await voice(name, `${before}${sing(i)}`, ms, every));
}

/**
 * The voice index the four call rows use.
 *
 * By name for the reason `SPECIAL` is by name. A blackbird because its `call`
 * row is three notes rather than one, so `contact` — the only kind that takes
 * its count from the table instead of overriding it — has something to show.
 */
const CALLER = Math.max(0, VOICE_NAMES.indexOf('blackbird'));

// The optional third element is the capture window, for a voice that would
// otherwise outlast it.
for (const [name, body, ms] of [
  ['flush', 'w.flush(at(4), 1, 0)'],
  ['bolt (deer)', 'w.bolt(at(5), "deer", 1)'],
  ['bolt (rabbit)', 'w.bolt(at(4), "rabbit", 1)'],
  ['bolt (squirrel)', 'w.bolt(at(5), "squirrel", 1)'],
  ['hooves', 'for (let i=0;i<5;i++) setTimeout(() => w.hoof(at(6), "deer", 1), i*120)'],
  ['woodpecker', 'w.woodpecker(at(24))'],
  ['crow', 'w.caw(at(30))'],
  /**
   * THE THREE THAT ARE NOT IN THE TABLE AND NOT IN THE CHORUS.
   *
   * `wildlife.js` groups these together and so does this, because they share
   * the property that makes them worth measuring separately: each is the only
   * thing of its kind, none of them goes through `song`, and so not one of them
   * is touched by the sixteen rows above no matter how the roster grows.
   *
   * The JAY is the one to watch of the three. It is deliberately the harshest
   * voice in the file — a tear rather than a caw, three overlapping puffs laid
   * across a throat to rough up an envelope whose spectrum never moves — and
   * "roughness that is not a buzz" is precisely the distinction peakiness is
   * here to police. If any voice in this wood is going to ring, it is this one.
   *
   * The BUZZARD is placed HIGH, which is not decoration: `at(90, 70)` is 90 m
   * out and 70 m up, inside the 55–110 m band `update` actually uses, and its
   * spatial node is built for that range. It is also nearly a pure tone, so a
   * peaky reading is expected of it in the way the owl's is.
   */
  ['jay', 'w.jay(at(50), 0.8)'],
  ['pheasant', 'w.pheasant(at(60))'],
  ['buzzard', 'w.mew(at(90, 70))'],
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
  rows.push(await voice(name, body, ms ?? 5000));
}

// Everything at once, with the jukebox running and the trip at its peak: the
// worst case for both level and node count.
await page.evaluate(() => {
  window.RR.music.start();
  window.RR.director.seek(190);
});
await page.waitForTimeout(2500);
rows.push(
  await voice(
    'all + music + peak',
    // The roster size comes from the module (`window.__voices`), not from a
    // literal 12 — which is what this was, and what silently stopped
    // exercising the newest rows the moment they landed. The bolt and the
    // hooves are a big stag, because the worst case for level and node count
    // is the biggest animal in the wood leaving at speed.
    'w.tripLevel = 1; w._songBudget = 5; w.song(at(8), Math.floor(Math.random()*window.__voices), {answer:true}); w.flush(at(5),1,1); w.bolt(at(6),"deer",1,1.54); w.hoof(at(5),"deer",1,1.54);',
    7000
  )
);

const pad = (s, n) => String(s).padEnd(n);
console.log(
  pad('voice', 22),
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
    pad(r.label, 22),
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
  // Nothing in this file may be as loud as the record on the jukebox.
  if (r.rms > 0.12) fails.push(`${r.label}: rms ${r.rms.toFixed(3)} — louder than the music`);
}
if (problems.length) fails.push(...problems);

writeFileSync(`${OUT}/fauna-audio.json`, JSON.stringify({ rows, fails }, null, 2));
console.log(fails.length ? `\nPROBLEMS:\n  ${fails.join('\n  ')}` : '\nno problems');
await browser.close();
process.exitCode = fails.length ? 1 : 0;
