import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Record the app's master output to a WAV file you can actually listen to.
 *
 * The spectrum probe answers "does it buzz" with a number. This answers "is it
 * any good" the only way that question can be answered. It drives the real app,
 * seeks the trip through its phases on a schedule, and captures the master bus
 * the whole way.
 *
 *   node scripts/record.mjs --seconds=90 --out=.shots
 *   node scripts/record.mjs --tracks --seconds=120
 *
 * The default schedule walks sober → come-up → onset → peak → ego death →
 * comedown, spending long enough in each to hear what it does.
 *
 * `--tracks` records the PLAYLIST instead, sober, an equal slice per record. The
 * trip schedule cannot audition the jukebox: it stays on whichever track loaded
 * and then buries it under three layers of drone. A spectrum says whether a track
 * buzzes; only this says whether it is a piece of music.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const URL = args.url ?? 'http://127.0.0.1:5180/';
const OUT = resolve(process.cwd(), args.out ?? '.shots');
const TRACKS_MODE = args.tracks === 'true';
const SECONDS = Number(args.seconds ?? (TRACKS_MODE ? 120 : 90));
const NAME = args.name ?? (TRACKS_MODE ? 'playlist' : 'session');
mkdirSync(OUT, { recursive: true });

/** Fractions of the recording at which to jump the trip clock. */
const SCHEDULE = [
  { at: 0.0, seek: null, note: 'sober, jukebox playing' },
  { at: 0.14, seek: 10, note: 'come-up' },
  { at: 0.32, seek: 70, note: 'onset' },
  { at: 0.5, seek: 150, note: 'peak' },
  { at: 0.72, seek: 212, note: 'ego death' },
  { at: 0.88, seek: 248, note: 'comedown' },
];

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

/**
 * DEAFEN THE PAGE TO HOT RELOADS BEFORE IT LOADS.
 *
 * A save landing mid-run reloads the page, which takes the ScriptProcessor and
 * the whole graph it was tapping with it. This records for a minute and a half
 * by default, so the window is enormous, and the failure is silent — a reloaded
 * page has no console problems, so the WAV would simply stop having anything in
 * it partway through and the file would still be written. Same guard as
 * play-check.mjs, which documents what it cost.
 */
await page.routeWebSocket(/.*/, () => {});

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
/**
 * The engine's own signal, not a guess at how long it takes to build.
 *
 * `ready` is set last in `AudioEngine.start()`, after `ctx`, so the conjunction
 * is what guarantees `engine.master` below is a real node. audio-probe.mjs had
 * the same fixed 2000 ms here and it went from a margin to a coin flip when the
 * boot got slower; this is the same bug in a script that would take a WAV of
 * the failure home with it.
 */
await page.waitForFunction(() => window.RR.audio?.ctx != null && window.RR.audio.ready === true, {
  timeout: 25000,
});
await page.waitForTimeout(1000);

/**
 * Capture with a ScriptProcessorNode.
 *
 * Deprecated, and the right tool anyway: an AudioWorklet would need a separate
 * module file served over HTTP, and this runs on the main thread inside a page
 * that is already being driven by a test harness. Dropouts would matter if this
 * were playback; it is a capture of a deterministic-ish synth graph, and any
 * glitch would show up as a click that is trivially distinguishable from the
 * musical content.
 */
await page.evaluate((tracksMode) => {
  const engine = window.RR.audio;
  const ctx = engine.ctx;
  /**
   * In playlist mode, tap the JUKEBOX rather than the master.
   *
   * The master carries wind, birds, the stream and a limiter. Auditioning a
   * record through all of that measures the forest as much as the music, and the
   * limiter actively lies: the busier the track, the harder it pulls everything
   * down, so a louder arrangement reads as having LESS treble than a sparse one.
   * That confound is bigger than most of the differences worth hearing.
   */
  const tap = tracksMode ? window.RR.music.output : engine.master;
  const node = ctx.createScriptProcessor(4096, 2, 2);
  const left = [];
  const right = [];
  node.onaudioprocess = (e) => {
    left.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    right.push(new Float32Array(e.inputBuffer.getChannelData(1)));
    // The node must reach a destination or some browsers never pull it, but it
    // must not be *audible* twice, so its output is silenced.
    const out = e.outputBuffer;
    out.getChannelData(0).fill(0);
    out.getChannelData(1).fill(0);
  };
  tap.connect(node);
  node.connect(ctx.destination);
  window.__rec = { node, left, right, sampleRate: ctx.sampleRate };
}, TRACKS_MODE);

/**
 * In playlist mode the schedule is the record shelf: stay sober, and step to the
 * next track at an even fraction of the running time.
 */
const schedule = TRACKS_MODE
  ? await page.evaluate(() => {
      window.RR.director.ground();
      const n = window.RR.music.trackCount;
      return Array.from({ length: n }, (_, i) => ({ at: i / n, track: i }));
    })
  : SCHEDULE;

console.log(`recording ${SECONDS}s…`);
const started = Date.now();
let next = 0;
while (Date.now() - started < SECONDS * 1000) {
  const t = (Date.now() - started) / (SECONDS * 1000);
  while (next < schedule.length && t >= schedule[next].at) {
    const step = schedule[next];
    const note = await page.evaluate((s) => {
      if (s.track !== undefined) {
        window.RR.music.setTrack(s.track);
        if (!window.RR.music.playing) window.RR.music.start();
        return window.RR.music.trackName;
      }
      if (s.seek === null) window.RR.director.ground();
      else window.RR.director.seek(s.seek);
      return null;
    }, step);
    console.log(`  ${(t * SECONDS).toFixed(0)}s  ${note ?? step.note}`);
    next++;
  }
  await page.waitForTimeout(250);
}

const { sampleRate, chunks, frames } = await page.evaluate(() => {
  const rec = window.__rec;
  rec.node.onaudioprocess = null;
  const total = rec.left.reduce((a, c) => a + c.length, 0);
  // Interleave and quantise to 16-bit in the page, so what crosses the bridge
  // is half the size and already in the file's format.
  const out = new Int16Array(total * 2);
  let o = 0;
  for (let c = 0; c < rec.left.length; c++) {
    const l = rec.left[c];
    const r = rec.right[c];
    for (let i = 0; i < l.length; i++) {
      out[o++] = Math.max(-32768, Math.min(32767, Math.round(l[i] * 32767)));
      out[o++] = Math.max(-32768, Math.min(32767, Math.round(r[i] * 32767)));
    }
  }
  return {
    sampleRate: rec.sampleRate,
    frames: total,
    chunks: Array.from(new Uint8Array(out.buffer)),
  };
});

const pcm = Buffer.from(chunks);
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(2, 22); // stereo
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * 4, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);

const path = `${OUT}/${NAME}.wav`;
writeFileSync(path, Buffer.concat([header, pcm]));
console.log(`\nwrote ${path}  (${(frames / sampleRate).toFixed(1)}s, ${sampleRate} Hz)`);

await browser.close();
