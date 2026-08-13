/**
 * The performance stats overlay.
 *
 * Off by default, turned on from Settings → Stats. It is the one other piece
 * of chrome in this project allowed to sit on screen for the length of a
 * session — see the block comment atop hud.js about persistent chrome being a
 * fixed reference frame a trip must not hand the eye. The exception holds
 * here for the same reason it holds for the debug panel: a player who has
 * deliberately opted into a corner readout has already decided they want one.
 *
 * SIX NUMBERS AND A LINE GRAPH.
 *
 * fps/ms are the instantaneous readout — fps smoothed over a half-second
 * window because a number that changes every 16 ms is not readable, ms raw
 * and un-smoothed because catching the one stuttered frame between two smooth
 * ones is worth more than a stable-looking number. avg/max/1%-low/.1%-low are
 * computed from a rolling window of real frame times (RING_CAPACITY samples —
 * several minutes at typical rates). Max and the two lows exist specifically
 * to answer "did a freeze actually happen and how bad was it", which nothing
 * else here can: a single bad frame is invisible inside any average.
 *
 * WHY THIS DOES NOT TRUST THE `dt` IT IS HANDED.
 *
 * main.js's frame loop runs on `Clock`, and `Clock.tick()` deliberately clamps
 * its dt to 50 ms so the simulation cannot leap forward after a stall — see
 * core/util.js. That is correct for physics and wrong for a readout whose
 * entire purpose is to show how long a frame actually took: fed that dt, a
 * 300 ms freeze arrives here reporting exactly 50 ms, indistinguishable from a
 * fine frame, and the other 250 ms is simply gone. THIS, not a threshold in
 * this file, is the reason a graph built from that number cannot show a
 * freeze no matter how badly the game hitches. An earlier version of this
 * file also had a `dt > 250 ms` guard, on the theory that anything slower was
 * a tab switch rather than a frame worth plotting — removed, because the
 * clamp upstream meant dt could never even reach 250 ms to trigger it. It was
 * never the cause of anything; it was dead code that looked like an answer.
 *
 * So this file ignores the `dt` argument for timing and measures its own,
 * from `performance.now()` deltas between consecutive calls — the true
 * wall-clock interval the player actually experienced, immune to whatever the
 * simulation clamps.
 *
 * A raw wall clock needs its own exclusion for the interval that is not a
 * frame at all: the tab was backgrounded. `visibilitychange` marks the next
 * interval to be thrown away entirely — not plotted, not folded into any
 * average — the same fix as the Auto governor's own PerfWindow in quality.js,
 * for the same reason ("every one of those intervals looks like a
 * catastrophic frame"). Callers who know something this cannot see say so
 * explicitly through `discard()`: the gate lifting, and the dev perf console
 * releasing the renderer it was holding via `RR.perf`.
 *
 * AN EXCLUSION BY DURATION IS THE THIRD TIME THIS FILE HID A STALL.
 *
 * The rule above used to have a fourth clause — `realMs > MAX_PLOTTABLE_MS`,
 * 2 seconds — defended in this header as "headroom, not a threshold anything
 * real should ever cross". It was crossed. Driving the live panel with a
 * 2500 ms freeze produced an unbroken 60 fps line, an unmoved `max ms`, and a
 * `0.1% low` that never heard about it: the sample was not clamped or
 * flattened, it was dropped, so the panel reported a perfectly healthy machine
 * across a two-and-a-half second stop. That is the SAME failure as the
 * `dt > 250 ms` guard the paragraph above records — a duration filter deciding
 * on its own that the worst frame of the session cannot have been a frame —
 * and this engine had already been measured stalling 1.7 s during its own load,
 * so the number was never the headroom it claimed to be either.
 *
 * There is now no duration above which a frame is quietly assumed not to have
 * happened. NOT_A_FRAME_MS survives only as a sanity backstop for the one case
 * no signal covers — a debugger sitting on a breakpoint, an OS suspend that
 * fires no visibility event — and it sits an order of magnitude clear of
 * anything this engine has ever produced, because everything below it is now
 * plotted, counted, and named. What a very long frame no longer gets to do is
 * scroll the whole window away: one frame may commit at most
 * MAX_FREEZE_COLUMNS of them, so half the graph always survives to show what
 * the framerate was before the stop.
 *
 * AND A FREEZE IS NOT LEFT TO A TWO-PIXEL NOTCH.
 *
 * The graph scrolls at PX_PER_SECOND, so a 100 ms freeze — the shortest hitch
 * a player actually feels as one — owes barely two columns. Drawn as nothing
 * but a dip in a 40 px line it is real, honest, and still missable at a glance,
 * which is the same complaint as a hidden stall with a different mechanism. So
 * a frame at or over FREEZE_MS is marked rather than merely plotted: every
 * column it owes gets a full-height red band behind the trace, the trace over
 * it is drawn in alarm red at double width, and the panel prints the freeze in
 * words under the graph — `FROZE 247 ms` while the dip is still inside the
 * visible window, then a running session tally after it scrolls off. Nothing
 * about a stall now depends on the eye catching two pixels.
 *
 * THE GRAPH SCROLLS BY WALL-CLOCK TIME, NOT BY FRAME.
 *
 * The first version shifted the graph one column per rendered frame, which
 * means its visible window was however many seconds of history fit in
 * GRAPH_W frames — under two seconds at 100+ fps, too fast to read anything
 * off. It now advances a fixed PX_PER_SECOND regardless of how often frames
 * are actually arriving, so the window is always SECONDS_VISIBLE seconds wide
 * whether the game is at 30 fps or 300. Frames that land between two
 * committed columns — the common case at anything above roughly
 * GRAPH_W / SECONDS_VISIBLE fps — are not simply discarded: the WORST fps
 * seen since the last committed column is what gets plotted, so a single
 * stuttered frame between two smooth ones still shows up as a dip instead of
 * being averaged away. A freeze spanning several columns' worth of wall-clock
 * time now correctly draws as a wide dip — width tracking duration — rather
 * than a single point, once it is not being thrown away before it gets here.
 *
 * That sentence was written before it was true. The scroll loop reset its
 * bucket once per COLUMN, so every column a long frame owed after the first was
 * plotted as `Infinity` — the top of the graph, in green — and a freeze drew as
 * a burst of perfect framerate. See the block on the loop in `update()`: it is
 * the second time this file has hidden a stall from the person watching it, and
 * `scripts/stats-check.mjs` now drives a real 400 ms frame through the panel and
 * looks at the pixels rather than at the counters, because in both bugs the
 * counters were right.
 *
 * IT IS A LINE, NOT FILLED BARS.
 *
 * Each committed sample draws one short segment from the previous point to
 * the new one, so the trace reads as a continuous line the way a line graph
 * should — a solid fill down to the baseline read as a static bar chart.
 *
 * THE CANVAS STILL NEVER REDRAWS ITS HISTORY.
 *
 * Each committed column copies the canvas one device pixel to the left and
 * draws one new segment at the right edge — the same trick mrdoob's Stats.js
 * uses for its bars, just applied to a stroke instead of a fill.
 */

const GRAPH_W = 180;
const GRAPH_H = 40;
/** How many seconds of history the graph's width represents, regardless of fps. */
const SECONDS_VISIBLE = 8;
/** CSS pixels of scroll per second, derived so the graph always spans SECONDS_VISIBLE. */
const PX_PER_SECOND = GRAPH_W / SECONDS_VISIBLE;
/**
 * The graph's vertical ceiling, in fps. Fixed rather than adaptive: this is a
 * corner readout, not a measurement instrument, and a constant is one line
 * instead of a second small controller guessing the display's refresh rate —
 * see SLOWEST_BELIEVABLE_PERIOD in core/quality.js for what that guess costs
 * when it has to be right. 120 puts the 60 fps reference line at exact
 * half-height, which is the split that reads fastest at a glance: healthy is
 * "the top half", trouble is "the bottom half". A 144 Hz+ display simply pins
 * the top on a good frame.
 */
const MAX_FPS = 120;
const REFERENCE_FPS = 60;
/** How often the big numbers redraw, and the cadence the rolling stats recompute on. Twice a second is readable; every frame is a blur. */
const READOUT_SECONDS = 0.5;
/**
 * Real frame times kept for avg/max/1%-low/.1%-low, a fixed-capacity ring
 * buffer of milliseconds. 16384 samples is several minutes at typical rates —
 * long enough for a .1% low to mean something (16+ samples in its own tail at
 * full capacity) — and ages out on its own with no explicit reset needed.
 * Sorting a buffer this size twice a second is comfortably sub-millisecond,
 * not worth a streaming percentile structure for an opt-in overlay.
 */
const RING_CAPACITY = 16384;
/**
 * The last resort, and NOT a freeze filter — see the header. Nothing this
 * engine can do to a frame comes near it: its worst measured stall is 1.7 s
 * during load, and the 2 s version of this constant silently swallowed real
 * multi-second freezes for as long as it existed. What is left above this line
 * is a debugger parked on a breakpoint or a machine coming back from suspend
 * without a visibility event, where the interval is not a frame in any sense
 * and would poison the 0.1% low for minutes.
 */
const NOT_A_FRAME_MS = 30000;
/**
 * A frame at or over this is a FREEZE: banded, coloured and named rather than
 * left as a dip. 100 ms is roughly where a hitch stops being a dropped frame
 * and becomes something a player would describe as the game stopping.
 */
const FREEZE_MS = 100;
/**
 * Most columns one frame may scroll the graph by. Without it a single
 * multi-second stall scrolls every healthy sample off the canvas and the panel
 * shows nothing but the freeze — the "before" is the half of the picture that
 * makes a freeze legible. Half the width is 4 s at PX_PER_SECOND, so every
 * freeze short of that still has width tracking duration exactly; past it the
 * band saturates and the readout under the graph carries the real number.
 */
const MAX_FREEZE_COLUMNS = Math.floor(GRAPH_W / 2);
const BG = '#0c0f0e';
/** The trace over a freeze, and the band behind it. Nothing else in the panel is this colour. */
const FREEZE_INK = '#ff4438';
const FREEZE_BAND = 'rgba(255, 68, 56, 0.45)';

function colorFor(fps) {
  if (fps >= 55) return '#7fd8a0';
  if (fps >= 30) return '#e0c060';
  return '#e0796a';
}

export class StatsPanel {
  constructor() {
    this.visible = false;
    this._frames = 0;
    this._accum = 0;
    this._fps = 0;
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);
    /** Fractional CSS pixels the graph owes itself; see update(). */
    this._scrollAccum = 0;
    /** Worst (lowest) fps seen since the last committed column. */
    this._bucketWorst = Infinity;
    /** y of the last committed point, device px, so the next one can draw a line to it. */
    this._lastY = null;

    /** performance.now() at the last processed frame, ms; null until the first call establishes it. */
    this._lastReal = null;
    /** Set by a visibilitychange event, consumed (and cleared) by the next update() — see the file header. */
    this._discardNext = false;
    document.addEventListener('visibilitychange', () => {
      this._discardNext = true;
    });

    /** Rolling window of real frame times, ms — see RING_CAPACITY. */
    this._ring = new Float32Array(RING_CAPACITY);
    this._ringHead = 0;
    this._ringCount = 0;
    /** Reused every recompute so sorting does not allocate. */
    this._sortScratch = new Float32Array(RING_CAPACITY);
    this._avgFps = 0;
    this._maxMs = 0;
    this._low1Fps = 0;
    this._low01Fps = 0;

    /**
     * The freeze tally, kept for the session rather than for the graph's
     * window: "it froze three times since I turned this on" is the sentence a
     * player is trying to arrive at, and the graph can only hold the last
     * SECONDS_VISIBLE seconds of it. Deliberately NOT reset by `_clearGraph`.
     */
    this._freezeCount = 0;
    this._lastFreezeMs = 0;
    this._worstFreezeMs = 0;
    /** performance.now() of the last freeze, so the badge knows when its dip has scrolled off. */
    this._lastFreezeAt = -Infinity;
    /** Last string written to the badge, so the common case touches no DOM. */
    this._freezeText = '';

    const el = document.createElement('div');
    el.id = 'stats';
    el.hidden = true;
    el.innerHTML = `
      <div class="stats-row">
        <b id="stats-fps">–</b><span>fps</span>
        <b id="stats-ms">–</b><span>ms</span>
      </div>
      <div class="stats-row">
        <b id="stats-avg">–</b><span>avg</span>
        <b id="stats-max">–</b><span>max ms</span>
      </div>
      <div class="stats-row">
        <b id="stats-low1">–</b><span>1% low</span>
        <b id="stats-low01">–</b><span>0.1% low</span>
      </div>
      <canvas id="stats-graph"></canvas>
      <div id="stats-freeze" hidden></div>
    `;
    document.body.appendChild(el);
    this.el = el;
    this._fpsEl = el.querySelector('#stats-fps');
    this._msEl = el.querySelector('#stats-ms');
    this._avgEl = el.querySelector('#stats-avg');
    this._maxEl = el.querySelector('#stats-max');
    this._low1El = el.querySelector('#stats-low1');
    this._low01El = el.querySelector('#stats-low01');
    this._freezeEl = el.querySelector('#stats-freeze');

    const canvas = el.querySelector('#stats-graph');
    canvas.width = GRAPH_W * this._dpr;
    canvas.height = GRAPH_H * this._dpr;
    canvas.style.width = `${GRAPH_W}px`;
    canvas.style.height = `${GRAPH_H}px`;
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');
    this._clearGraph();
  }

  /** Wipe the graph back to blank. Called on construction and every re-show — see setVisible. */
  _clearGraph() {
    this._ctx.fillStyle = BG;
    this._ctx.fillRect(0, 0, this._canvas.width, this._canvas.height);
    this._scrollAccum = 0;
    this._bucketWorst = Infinity;
    this._lastY = null;
  }

  setVisible(on) {
    on = !!on;
    /**
     * A graph that resumes mid-scroll from whenever it was last hidden reads
     * as a discontinuity — old history from ten minutes ago sitting right next
     * to this second's data. Starting clean each time the player turns it on
     * is both simpler and the more honest picture: this is what is happening
     * now, not a resumed recording. The rolling stats (avg/max/lows) are left
     * running regardless — same reasoning as keeping the fps accumulator warm
     * below — because unlike the graph's timeline they are a trailing summary
     * by construction, and RING_CAPACITY already bounds how stale they can be.
     */
    if (on && !this.visible) {
      this._clearGraph();
      // The percentiles are only recomputed while visible (see `update`), so
      // catch them up once here rather than showing the reader whatever was
      // last computed the previous time the panel was open.
      this._recomputeStats();
    }
    this.visible = on;
    this.el.hidden = !on;
  }

  /**
   * "The next interval is not a frame time." Same door the visibilitychange
   * handler above uses, opened to callers who know something this cannot see.
   *
   * The one caller is the `#enter` handler in main.js. While the main menu is
   * up the loop draws ten frames a second and does not report any of them here
   * — so the first interval after it lifts spans up to a tenth of a second of
   * throttle, and would be plotted as the session's opening stutter. It is the
   * gap between two frames rather than the cost of one, which is precisely what
   * the visibility case already exists to throw away.
   */
  discard() {
    this._discardNext = true;
  }

  /**
   * Called once per rendered frame, visible or not — the accumulators below
   * are cheap arithmetic on a couple of numbers, so it costs nothing to keep
   * them warm while hidden, and it means the instant the player turns this on
   * the big numbers are already settled instead of reading 0 for half a
   * second. `dt` is accepted but ignored for timing — see the file header for
   * why the caller's clock cannot show a freeze.
   */
  update(_dt) {
    const now = performance.now();
    if (this._lastReal === null) {
      this._lastReal = now;
      return;
    }
    const realMs = now - this._lastReal;
    this._lastReal = now;

    if (this._discardNext || document.hidden) {
      this._discardNext = false;
      return;
    }
    /**
     * The only two intervals thrown away are the ones nobody claims were
     * frames. A long one is not among them — see the header: the clause that
     * used to drop everything over 2 s is what made a 2500 ms freeze read as a
     * flawless 60 fps.
     */
    if (realMs <= 0 || realMs > NOT_A_FRAME_MS) return;

    this._frames += 1;
    this._accum += realMs / 1000;

    this._ring[this._ringHead] = realMs;
    this._ringHead = (this._ringHead + 1) % RING_CAPACITY;
    if (this._ringCount < RING_CAPACITY) this._ringCount++;

    if (this._accum >= READOUT_SECONDS) {
      this._fps = this._frames / this._accum;
      this._frames = 0;
      this._accum = 0;
      /**
       * ONLY WHEN SOMEBODY IS LOOKING.
       *
       * The accumulators above must keep running with the panel hidden — that
       * is the header's argument and it is right, a freeze during the ten
       * minutes the overlay was off still happened. `_recomputeStats` is not
       * one of them. It copies the 16 384-entry ring into a scratch buffer and
       * SORTS it, to produce percentiles that are read by nothing until the
       * panel is drawn, and it was running twice a second in every session
       * forever because it sat above the `visible` guard.
       *
       * That is a periodic 64 KB copy and an n log n sort landing on the frame
       * thread — which on a 240 Hz panel is more than a whole frame, twice a
       * second, manufactured by the instrument that exists to report the 1%
       * low. `setVisible` recomputes on the way in, so the first painted frame
       * is still correct rather than showing the previous half-second.
       */
      if (this.visible) this._recomputeStats();
    }

    /**
     * Counted here rather than in the drawing code below, so the tally is the
     * session's and not the overlay's: a freeze during the ten minutes somebody
     * had the panel switched off still happened, and `FROZE` appearing the
     * moment they switch it on is the honest reading.
     */
    if (realMs >= FREEZE_MS) {
      this._freezeCount += 1;
      this._lastFreezeMs = realMs;
      this._lastFreezeAt = now;
      if (realMs > this._worstFreezeMs) this._worstFreezeMs = realMs;
    }

    if (!this.visible) return;

    this._fpsEl.textContent = this._fps.toFixed(0);
    this._msEl.textContent = realMs.toFixed(1);
    this._avgEl.textContent = this._avgFps.toFixed(0);
    this._maxEl.textContent = this._maxMs.toFixed(0);
    this._low1El.textContent = this._low1Fps.toFixed(0);
    this._low01El.textContent = this._low01Fps.toFixed(0);
    this._avgEl.style.color = colorFor(this._avgFps);
    this._maxEl.style.color = colorFor(1000 / this._maxMs);
    this._low1El.style.color = colorFor(this._low1Fps);
    this._low01El.style.color = colorFor(this._low01Fps);
    this._paintFreezeBadge(now);

    const fps = 1000 / realMs;
    if (fps < this._bucketWorst) this._bucketWorst = fps;

    /**
     * Advance the graph by wall-clock time, not by frame count — see the file
     * header. Each call only banks PX_PER_SECOND * dt CSS pixels of "scroll
     * debt", and a column commits once a whole pixel is owed, so the scroll
     * rate is pinned to PX_PER_SECOND no matter how often update() is called.
     */
    this._scrollAccum += PX_PER_SECOND * (realMs / 1000);
    /**
     * THE BUCKET IS RESET ONCE PER CALL, NOT ONCE PER COLUMN — and that one
     * line is the difference between this graph showing a freeze and hiding it.
     *
     * A frame long enough to owe several columns IS the frame this thing exists
     * to draw, and it arrives as one call carrying one sample. Resetting inside
     * the loop gave the first column that sample and every column after it
     * `Infinity`, which `_plot` maps through `min(1, fps / MAX_FPS)` to the very
     * TOP of the graph and `colorFor` paints in the green reserved for a frame
     * that beat 55 fps. So a 400 ms freeze drew a one-pixel notch followed by
     * nine pixels of flawless framerate, and the longer the freeze the wider the
     * reassuring green plateau it painted over itself.
     *
     * That is the exact shape of a "the graph never drops" report, and it is the
     * SECOND time this file has hidden a stall from the person watching it — the
     * header records the first, a `dt > 250 ms` guard that threw the sample away
     * before it ever reached here. Both had the same tell: the numbers beside the
     * graph (`max ms` especially) knew perfectly well what had happened.
     *
     * Every column this call owes now plots the same reading, so the dip's WIDTH
     * tracks the freeze's DURATION — which is what the header has claimed all
     * along and what the reset made impossible.
     */
    if (this._scrollAccum >= 1) {
      const worst = this._bucketWorst;
      const owed = Math.floor(this._scrollAccum);
      this._scrollAccum -= owed;
      /**
       * The debt is paid down in full above and only DRAWN up to the cap, which
       * is the whole difference between "the graph stopped scrolling for a
       * while" and "the graph is a solid red wall with no history left in it".
       * See MAX_FREEZE_COLUMNS.
       */
      const columns = Math.min(owed, MAX_FREEZE_COLUMNS);
      for (let i = 0; i < columns; i++) this._plot(worst);
      this._bucketWorst = Infinity;
    }
  }

  /**
   * The freeze called out in words, under the graph.
   *
   * Two states, because they answer two different questions. While the dip is
   * still inside the graph's own window the badge names the frame the player
   * just felt — `FROZE 247 ms`, lit, sitting directly beneath the band that
   * drew it. Once that has scrolled off it becomes the session's tally, dimmed:
   * how many times, and how bad the worst one was. Hidden entirely until the
   * first freeze, so a clean session carries no alarm furniture at all.
   */
  _paintFreezeBadge(now) {
    const el = this._freezeEl;
    if (!this._freezeCount) return;
    const hot = now - this._lastFreezeAt < SECONDS_VISIBLE * 1000;
    const text = hot
      ? `FROZE ${this._lastFreezeMs.toFixed(0)} ms`
      : `${this._freezeCount} freeze${this._freezeCount === 1 ? '' : 's'} · worst ${this._worstFreezeMs.toFixed(0)} ms`;
    if (text !== this._freezeText) {
      this._freezeText = text;
      el.textContent = text;
    }
    if (el.hidden) el.hidden = false;
    // `hot` also drives the panel's own border — a freeze should be visible in
    // peripheral vision, not only to somebody already reading the numbers.
    el.classList.toggle('hot', hot);
    this.el.classList.toggle('froze', hot);
  }

  /**
   * avg/max/1%-low/.1%-low over the ring buffer. "N% low" here means the
   * conventional benchmark metric — the MEAN of the slowest N% of samples —
   * not the single value at that percentile; it is a steadier, more honest
   * measure of "how bad do the worst moments actually get" than one point
   * sample.
   */
  _recomputeStats() {
    const n = this._ringCount;
    if (n === 0) return;
    const sorted = this._sortScratch.subarray(0, n);
    sorted.set(this._ring.subarray(0, n));
    // Numeric ascending by default for a typed array — unlike Array.prototype.sort,
    // which would need an explicit comparator to avoid lexicographic order.
    sorted.sort();

    let sum = 0;
    for (let i = 0; i < n; i++) sum += sorted[i];
    this._avgFps = 1000 / (sum / n);
    this._maxMs = sorted[n - 1];
    this._low1Fps = 1000 / this._tailMeanMs(sorted, n, Math.max(1, Math.round(n * 0.01)));
    this._low01Fps = 1000 / this._tailMeanMs(sorted, n, Math.max(1, Math.round(n * 0.001)));
  }

  /** Mean of the slowest `count` entries in an ascending-sorted array. */
  _tailMeanMs(sorted, n, count) {
    let sum = 0;
    for (let i = n - count; i < n; i++) sum += sorted[i];
    return sum / count;
  }

  _plot(fps) {
    const ctx = this._ctx;
    const canvas = this._canvas;
    const w = canvas.width;
    const h = canvas.height;
    const step = this._dpr;

    // Shift everything one device pixel left, dropping the oldest sliver.
    ctx.drawImage(canvas, step, 0, w - step, h, 0, 0, w - step, h);

    // Clear the vacated strip, then the 60 fps reference tick, then the line
    // segment on top — in that order, so a segment that beats 60 fps draws
    // over the tick and one that misses it leaves the tick showing through.
    ctx.fillStyle = BG;
    ctx.fillRect(w - step, 0, step, h);

    /**
     * A freeze gets the whole column, not just its own end of it. At
     * PX_PER_SECOND a 100 ms frame is two pixels wide, and two pixels of dip at
     * the bottom of a dark box is exactly the kind of thing an eye slides over
     * — a full-height band in a colour used for nothing else does not slide,
     * and it scrolls left with the trace as one object because the shift above
     * carries it. Drawn before the reference tick and the line so both still
     * read on top of it.
     */
    const freeze = 1000 / fps >= FREEZE_MS;
    if (freeze) {
      ctx.fillStyle = FREEZE_BAND;
      ctx.fillRect(w - step, 0, step, h);
    }

    const refY = h - (REFERENCE_FPS / MAX_FPS) * h;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.fillRect(w - step, refY, step, Math.max(1, step * 0.6));

    const y = h - Math.min(1, fps / MAX_FPS) * h;
    const fromY = this._lastY === null ? y : this._lastY;
    ctx.strokeStyle = freeze ? FREEZE_INK : colorFor(fps);
    ctx.lineWidth = Math.max(1, step * (freeze ? 2 : 1));
    /**
     * The doubled width is emphasis, and emphasis must not spill. A stroke that
     * wide reaches a device pixel past each end of its path, so it would paint
     * the column to its left — which belongs to an earlier frame that may have
     * been perfectly healthy — in the one colour this panel reserves for a
     * freeze. Clipped to the strip this call owns.
     */
    if (freeze) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(w - step, 0, step, h);
      ctx.clip();
    }
    ctx.beginPath();
    ctx.moveTo(w - step, fromY);
    ctx.lineTo(w, y);
    ctx.stroke();
    if (freeze) ctx.restore();
    this._lastY = y;
  }
}
