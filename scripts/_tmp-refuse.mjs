import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 900, height: 560 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(process.argv[2] ?? 'http://127.0.0.1:5180/', { waitUntil: 'load' });
await p.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await p.evaluate(() => { const g=document.getElementById('gate'); if(g&&!g.classList.contains('gone')) document.getElementById('enter')?.click(); });
await p.waitForFunction(() => window.RR.audio?.ready === true, { timeout: 25000 });
await p.waitForTimeout(1200);
const r = await p.evaluate(async () => {
  const w = window.RR.fauna.__wildlife;
  window.RR.music?.stop?.();
  const CEIL = 58;
  let phraseTried = 0, phraseRefusedNodes = 0, songTried = 0, songRefusedBucket = 0, noteRefused = 0;
  const ph = w._phrase.bind(w);
  w._phrase = (...a) => { phraseTried++; if (w.voices > CEIL * 0.7) phraseRefusedNodes++; return ph(...a); };
  const sg = w.song.bind(w);
  w.song = (...a) => { songTried++; const before = w._songBudget; const r = sg(...a); if (before < 1) songRefusedBucket++; return r; };
  const nt = w._note.bind(w);
  w._note = (...a) => { if (w.voices > CEIL) noteRefused++; return nt(...a); };
  let over40 = 0, over50 = 0, n = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 60000) {
    if (w.voices > CEIL * 0.7) over40++;
    if (w.voices > 50) over50++;
    n++;
    await new Promise((r) => setTimeout(r, 25));
  }
  return { phraseTried, phraseRefusedNodes, songTried, songRefusedBucket, noteRefused, over40: over40/n, over50: over50/n };
});
console.log(`song() calls: ${r.songTried}, refused by the bucket: ${r.songRefusedBucket}`);
console.log(`_phrase() calls: ${r.phraseTried}, refused for node pressure: ${r.phraseRefusedNodes}`);
console.log(`_note() refused at the ceiling: ${r.noteRefused}`);
console.log(`time above 70% of ceiling: ${(r.over40*100).toFixed(1)}%   above 50 voices: ${(r.over50*100).toFixed(1)}%`);
await b.close();
