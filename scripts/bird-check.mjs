import { chromium } from 'playwright';

/**
 * ARE THERE BIRDS IN THIS WOOD, WHERE THE PLAYER IS STANDING?
 *
 * WHY THIS EXISTS WHEN `fauna-audio.mjs` AND `fauna-wired.mjs` ALREADY DO.
 *
 * They answer different questions, and between them they left the only question
 * a player ever asks unanswered.
 *
 *   `fauna-audio.mjs` asks DOES THIS SPECIES BUZZ. It constructs its own
 *   `Wildlife`, forces each voice in the table under an analyser, and fails if
 *   anything drifts back toward the bright-and-dense sound the project exists to
 *   avoid. To do that it must bypass the wood entirely — its birds are placed by
 *   hand six metres in front of the camera, one at a time, on demand.
 *
 *   `fauna-wired.mjs` asks ARE THE ANIMALS IN THE SCENE AND MOVING. It counts
 *   instances, checks the buffers are being written and the flyers animate.
 *
 * Both passed, continuously, through a period in which the wood was functionally
 * birdless: ninety-six per cent of the perching roster was seeded in the grass
 * because the collider grid is empty on the frame `buildFauna` runs, the rest
 * sat in a 26–95 m band in a forest that hides everything past forty, and the
 * player's report was "I don't hear bird sounds" and "birds should sometimes
 * land on trees". Every component was correct. The composition was not, and
 * nothing measured the composition.
 *
 * So this measures the wood as it is played: the real `Wildlife` the perchers
 * are competing for tokens in, at the real distances, with the real streamed
 * forest under it. It fails on the four things that were actually wrong.
 *
 *   IN THE TREES. What fraction of perched birds are in a bough rather than on
 *   the floor. `pickPerch` intends about four in five; the bug produced one in
 *   twenty-five and was invisible from every other angle.
 *
 *   WITHIN EARSHOT. How many are near enough to see and hear at all. The forest
 *   canopy hides everything past roughly forty metres, so a bird beyond that is
 *   a rumour whatever it is doing.
 *
 *   MOVING. Voluntary hops that complete. A bird that never crosses a gap is
 *   scenery, and a bird that gets stuck mid-air or lands by teleporting is worse
 *   than one that never moves.
 *
 *   ABOVE GROUND. Flushed birds are ballistic, and for a long time they finished
 *   their arcs twenty to forty metres underground. Nobody saw it because a flush
 *   always went away from you and the recycle was hidden.
 *
 * It deliberately does NOT assert a song rate. That is `wildlife.js`'s leaky
 * bucket, the chorus wave and the hour of the day, all three of which are meant
 * to move; pinning a number here would fail every time somebody tuned one. What
 * it asserts is that song is HAPPENING NEAR THE PLAYER, which is the property
 * that was lost.
 *
 *   node scripts/bird-check.mjs [--url=...] [--seconds=60]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const SECONDS = Number(args.seconds ?? 60);

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

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.evaluate(() => {
  const gate = document.getElementById('gate');
  if (gate && !gate.classList.contains('gone')) document.getElementById('enter')?.click();
});
await page.waitForFunction(() => window.RR.audio?.ctx != null && window.RR.audio.ready === true, {
  timeout: 25000,
});
// Long enough for the ring to stream and the roster to take its seats.
await page.waitForTimeout(4000);

/**
 * Every bird event the wood actually emits, tagged with how far away it was.
 *
 * `createSpatial` is the one place every located sound in this project passes
 * through, and in a dev build the stack above it names the `wildlife.js` method
 * that asked. That is the whole instrument: no hooks in the audio file, nothing
 * to leave switched on in a shipping build, and it cannot miss a voice somebody
 * adds later.
 */
await page.evaluate(() => {
  const engine = window.RR.audio;
  // The record is louder than the wood and is not what is being measured.
  window.RR.music?.stop?.();
  window.__ev = [];
  const inner = engine.createSpatial.bind(engine);
  engine.createSpatial = (pos, opts) => {
    const stack = (new Error().stack || '').split('\n').slice(2, 9).join('|');
    if (/Wildlife/.test(stack)) {
      const m = stack.match(/at ([A-Za-z_$][\w$.]*)/g) || [];
      const c = window.RR.camera.position;
      window.__ev.push({
        who: m.slice(1, 3).join('<').replace(/at |Wildlife\./g, ''),
        d: Math.hypot(pos.x - c.x, pos.y - c.y, pos.z - c.z),
      });
    }
    return inner(pos, opts);
  };
});

const out = await page.evaluate(async (secs) => {
  const { heightAt } = await import('/src/world/terrain.js');
  const ps = window.RR.fauna.__perchers;
  const w = window.RR.fauna.__wildlife;

  const state = new Map(ps.map((p) => [p, p.state]));
  const r = {
    perchSamples: 0,
    inTree: 0,
    within40: 0,
    within20: 0,
    hops: 0,
    landed: 0,
    stuckAtGuard: 0,
    deepest: 0,
    airborneSamples: 0,
    samples: 0,
    maxVoices: 0,
    ceiling: 58,
    species: new Set(),
  };
  const airborneSince = new Map();

  const t0 = performance.now();
  while (performance.now() - t0 < secs * 1000) {
    const now = performance.now();
    const c = window.RR.camera.position;
    r.samples++;
    for (const p of ps) {
      const dh = p.pos.y - heightAt(p.pos.x, p.pos.z);
      if (dh < r.deepest) r.deepest = dh;
      const flat = Math.hypot(p.pos.x - c.x, p.pos.z - c.z);
      if (p.state === 'perch') {
        r.perchSamples++;
        if (dh > 2) r.inTree++;
        if (flat < 40) r.within40++;
        if (flat < 20) r.within20++;
      } else {
        r.airborneSamples++;
      }
      const was = state.get(p);
      if (was !== p.state) {
        if (p.state === 'land' && was === 'perch') {
          r.hops++;
          airborneSince.set(p, now);
        } else if (p.state === 'perch' && was === 'land') {
          r.landed++;
          if ((now - (airborneSince.get(p) ?? now)) / 1000 > 6.9) r.stuckAtGuard++;
        }
        state.set(p, p.state);
      }
    }
    if (w && w.voices > r.maxVoices) r.maxVoices = w.voices;
    await new Promise((res) => setTimeout(res, 30));
  }
  for (const p of ps) r.species.add(p.voice);
  r.speciesOnShow = r.species.size;
  r.stillAirborne = ps.filter((p) => p.state !== 'perch').length;
  delete r.species;
  r.events = window.__ev;
  r.roster = ps.length;
  return r;
}, SECONDS);

const perMin = (n) => (n / SECONDS) * 60;
const pct = (a, b) => (b ? (a / b) * 100 : 0);
const inTree = pct(out.inTree, out.perchSamples);
const near40 = out.within40 / out.samples;
const near20 = out.within20 / out.samples;
const nearEvents = out.events.filter((e) => e.d < 30).length;
const songs = out.events.filter((e) => e.who.includes('_phrase')).length;

console.log(`\nthe wood, from where the player is standing — ${SECONDS}s, music off\n`);
console.log(`  perchers in a bough rather than on the floor : ${inTree.toFixed(0)}%`);
console.log(`  perchers within 40 m (the range you can see) : ${near40.toFixed(1)} of ${out.roster}`);
console.log(`  perchers within 20 m                         : ${near20.toFixed(1)}`);
console.log(`  species with a bird you could walk up to     : ${out.speciesOnShow}`);
console.log('');
console.log(`  bird sounds per minute                       : ${perMin(out.events.length).toFixed(0)}`);
console.log(`  ...of them within 30 m                       : ${perMin(nearEvents).toFixed(0)}`);
console.log(`  song phrases per minute                      : ${perMin(songs).toFixed(0)}`);
console.log('');
console.log(`  voluntary hops started / landings completed  : ${out.hops} / ${out.landed}`);
console.log(`  landings that timed out instead of arriving  : ${out.stuckAtGuard}`);
console.log(`  a bird is in the air                         : ${pct(out.airborneSamples, out.samples * out.roster).toFixed(1)}% of bird-frames`);
console.log(`  deepest any bird went below the terrain      : ${out.deepest.toFixed(1)} m`);
console.log(`  peak concurrent wildlife voices              : ${out.maxVoices} of ${out.ceiling}`);

const bins = [10, 20, 30, 45, 65, 100, 1e9];
const labels = ['<10m', '10-20', '20-30', '30-45', '45-65', '65-100', '100m+'];
const hist = new Array(bins.length).fill(0);
for (const e of out.events) hist[bins.findIndex((b) => e.d < b)]++;
console.log('\n  how far away every bird sound was:');
for (let i = 0; i < hist.length; i++) {
  if (!hist[i]) continue;
  console.log(`    ${labels[i].padEnd(7)} ${'#'.repeat(Math.min(60, hist[i]))} ${hist[i]}`);
}

const fail = [];
if (inTree < 55) fail.push(`only ${inTree.toFixed(0)}% of perched birds are in a tree (want >55%)`);
if (near40 < 6) fail.push(`only ${near40.toFixed(1)} birds within 40 m (want >6)`);
if (perMin(nearEvents) < 5) {
  fail.push(`only ${perMin(nearEvents).toFixed(0)} bird sounds a minute within 30 m (want >5)`);
}
if (songs === 0) fail.push('no song phrases at all');
if (out.hops === 0) fail.push('no bird ever crossed to another branch');
if (out.stuckAtGuard > 0) fail.push(`${out.stuckAtGuard} landings timed out instead of arriving`);
if (out.stillAirborne > 3) fail.push(`${out.stillAirborne} birds still airborne at the end`);
if (out.deepest < -3) fail.push(`a bird reached ${out.deepest.toFixed(1)} m below the terrain`);
if (out.maxVoices >= out.ceiling) fail.push(`voices hit the ceiling (${out.maxVoices}/${out.ceiling})`);
for (const p of problems) fail.push(p);

console.log('');
if (fail.length) {
  for (const f of fail) console.log(`FAIL: ${f}`);
  process.exitCode = 1;
} else {
  console.log('PASS: there are birds in the trees around you, and they are singing and moving.');
}

await browser.close();
