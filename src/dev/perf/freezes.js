/**
 * THE FREEZE LOG: what the frame that just stopped the game was doing.
 *
 * Dev-only — imported from the same `if (__PERF__)` block as `probe.js` and
 * deleted from the shipping bundle by the same mechanism (see the block above
 * that import in main.js, and `npm run check:perfstrip`).
 *
 *
 * WHY THIS EXISTS ALONGSIDE `perf:spikes`, WHICH ALREADY DOES ATTRIBUTION.
 *
 * `perf:spikes` can only attribute a hitch it can PROVOKE, and everything it
 * knows how to provoke it provokes under `navigator.webdriver` — which pins the
 * world seed to `grove-01`, pins the clock to AUTHORED_PHASE, and switches off
 * both adaptive controllers. Three of the freezes this project has shipped were
 * invisible to it for exactly that reason, and each one was found only after
 * somebody played the game and said "it froze".
 *
 * This is the other half of that loop. It runs in the session a person is
 * actually in — their seed, their hour, their monitor, their governor — and when
 * a frame takes far longer than its neighbours it writes down what changed
 * during it. It cannot prove causation and does not claim to; it is the same
 * co-occurrence argument `spikes.mjs` sets out at its top, taken in the one
 * place a probe cannot go.
 *
 *
 * WHAT IT COSTS. One rAF callback that reads a dozen numbers off counters the
 * engine keeps anyway, and allocates nothing per frame — the sample is written
 * into a preallocated slot and only turned into an object on the frames that
 * qualify, which are by construction rare. The median it compares against is a
 * fixed-capacity ring, sorted once every REPORT_SECONDS rather than per frame.
 *
 *
 * THE THRESHOLD IS RELATIVE WITH AN ABSOLUTE FLOOR, and both halves matter.
 * Purely relative (`3x the median`) on a 5 ms frame flags everything over 15 ms,
 * which on a 213 Hz panel is a real dropped frame but not a freeze anybody would
 * report. Purely absolute misses a machine whose ordinary frame is 30 ms. The
 * floor is what makes the log readable; the ratio is what keeps it meaningful on
 * a slow machine.
 */

import { newbornWatch, drainNewborn, kb } from './newborn.js';

/** Frames kept for the running median. A few seconds at any plausible rate. */
const RING = 512;
/** No frame under this is a freeze, whatever the median says. */
const FLOOR_MS = 45;
/** …nor is anything under this multiple of the median. */
const RATIO = 3;
/**
 * An interval this long was not a frame at all — a debugger, an OS suspend that
 * fired no visibility event. Same reasoning and the same number as
 * NOT_A_FRAME_MS in ui/stats.js, INCLUDING why it is 30 s and not the 2 s it
 * used to be: at 2 s a log that exists to write down freezes was discarding the
 * worst ones in the session as impossible, which is the bug that file's header
 * now spends a section on. A tab switch and a perf-probe hold are excluded by
 * their own explicit signals above, not by being slow.
 */
const NOT_A_FRAME_MS = 30000;
/** How many freezes to keep. Older ones drop off the front. */
const KEEP = 200;

const DEG = 180 / Math.PI;

export function installFreezeLog(RR) {
  const { renderer, camera, atmosphere, forest, director, pipeline } = RR;
  const info = renderer.info;
  const mem = performance.memory;
  const settings = window.RRSettings;

  const log = [];
  const ring = new Float32Array(RING);
  let ringCount = 0;
  let ringHead = 0;

  /**
   * WHAT THE RENDERER MET FOR THE FIRST TIME, which is what `geometries` above
   * has always been counting without being able to say so. See newborn.js: the
   * counter moves on the frame a geometry is first DRAWN, not the frame it was
   * built, so a ground chunk that landed quietly eight seconds ago bills its
   * 416 KB upload to the frame the player turned to face it — and that frame
   * has no other counter of its own. This is the single largest source of the
   * "no counter this watches moved" verdict that used to cover most of the log.
   */
  const newborn = newbornWatch(renderer).log;
  let newbornAt = 0;

  /**
   * HOW OFTEN A SLAB HAS DOUBLED, summed over every streamed layer.
   *
   * The one hazard in `packSlab` that is expensive by construction and was
   * invisible here. A growth replaces the mesh's instance attribute, so the
   * next render pays a full `bufferData` of the NEW capacity — up to 8 MB for
   * the sward — and it also orphans the old GL buffer, because three keys its
   * buffers on the attribute object and offers no way to release one. forest.js
   * sizes the initial capacities so this stays at zero in ordinary play and
   * says outright that "a 146 ms frame during the first walk out was one"; a
   * detector that cannot see the difference between that frame and any other is
   * missing the cause it would most want to be told about, especially with a
   * content pass landing that moves every resident peak.
   */
  const slabGrowths = () => {
    const g = forest.growths;
    if (!g) return 0;
    let n = 0;
    for (const key in g) n += g[key];
    return n;
  };

  /**
   * The previous frame's readings. Every field here is a counter that only ever
   * moves when something happened, so the difference across one frame is that
   * frame's answer to "what did you do that your neighbours did not".
   */
  const prev = { programs: new Set() };
  /**
   * Re-read every counter and forget the deltas.
   *
   * Called twice: once now, and again the moment the gate lifts. The second call
   * is not optional — the pre-warm compiles some fifty programs while the gate is
   * still up, and a `prev` snapshotted before it would hand all fifty to the
   * first frame a player ever sees, which is the exact false accusation this
   * whole file exists to avoid making.
   */
  const resnap = () => {
    prev.programs = new Set((info.programs ?? []).map((p) => p.cacheKey));
    prev.built = forest.field?.built ?? 0;
    prev.evicted = forest.field?.evicted ?? 0;
    prev.ground = forest.groundField?.group?.children?.length ?? 0;
    prev.geometries = info.memory.geometries;
    prev.textures = info.memory.textures;
    prev.uploaded = forest.culler?.uploaded ?? 0;
    prev.heap = mem ? mem.usedJSHeapSize : 0;
    prev.sunSteps = atmosphere.sunSteps ?? 0;
    prev.anchorX = atmosphere._anchorX;
    prev.level = settings?.autoLevel;
    prev.scale = pipeline.drs?.scale ?? 1;
    /**
     * The pre-warm meets several hundred geometries behind the gate, for the
     * same reason it compiles fifty programs there. Forgetting them here is the
     * same non-negotiable as forgetting the programs — see `resnap`'s header.
     */
    newbornAt = newborn.length;
    prev.grows = slabGrowths();
  };
  resnap();

  /** Thrown away rather than recorded — see NOT_A_FRAME_MS. */
  let discardNext = false;
  document.addEventListener('visibilitychange', () => {
    discardNext = true;
  });

  const started = performance.now();
  let last = started;
  let announced = 0;
  /**
   * Scratch for the view direction, allocated once. Cloned off `camera.up`
   * rather than imported from three, so this dev module keeps its dependency on
   * the engine down to the `RR` handle it is passed — the same reason `probe.js`
   * wraps methods on `RR` instead of reaching into main.js.
   */
  const scratch = camera.up.clone();

  /**
   * NOTHING IS RECORDED UNTIL THE GATE IS DOWN, and that is a statement about
   * what this log is for rather than a convenience.
   *
   * The pre-warm in main.js deliberately compiles every program the quality
   * ladder can ask for while the start screen is still up, which is a single
   * synchronous 1.8-second stall on a cold driver cache — measured, expected,
   * and the entire reason the gate exists. Recording it would put a 1802 ms
   * entry at the top of every session's log and announce it in the console, and
   * a log whose worst entry is always the same known non-event is a log people
   * learn to ignore. This one only ever contains frames a player was in a
   * position to feel.
   */
  const gate = document.getElementById('gate');
  let armed = !gate || gate.classList.contains('gone');

  /**
   * Registered AFTER the game's own frame callback — rAF fires in registration
   * order and main.js registered at module scope, long before this file is
   * dynamically imported. So each reading is the post-frame state and the
   * difference between two readings is exactly one frame's work. The same
   * property `probe.js` relies on for its `marks`.
   */
  const tick = () => {
    requestAnimationFrame(tick);
    const now = performance.now();
    if (!armed) {
      // `last` is re-based on the arming frame so the first interval measured is
      // a frame rather than however long the player left the start screen up.
      if (gate.classList.contains('gone')) {
        armed = true;
        last = now;
        resnap();
      }
      return;
    }
    const ms = now - last;
    last = now;

    if (discardNext || document.hidden || ms > NOT_A_FRAME_MS) {
      discardNext = false;
      return;
    }

    /**
     * The median is taken over frames INCLUDING this one, which is deliberate:
     * a freeze is one sample in five hundred and cannot move a median, and
     * leaving it out would mean the first freeze of a session is compared
     * against a window that has not been established yet.
     */
    ring[ringHead] = ms;
    ringHead = (ringHead + 1) % RING;
    if (ringCount < RING) ringCount++;

    const fresh = [];
    for (const p of info.programs ?? []) {
      if (prev.programs.has(p.cacheKey)) continue;
      prev.programs.add(p.cacheKey);
      fresh.push(p.name || 'unnamed');
    }

    const built = (forest.field?.built ?? 0) - prev.built;
    const evicted = (forest.field?.evicted ?? 0) - prev.evicted;
    const ground = (forest.groundField?.group?.children?.length ?? 0) - prev.ground;
    const geometries = info.memory.geometries - prev.geometries;
    const textures = info.memory.textures - prev.textures;
    const uploadedNow = (forest.culler?.uploaded ?? 0) !== prev.uploaded ? forest.culler?.uploaded ?? 0 : 0;
    const heap = (mem ? mem.usedJSHeapSize : 0) - prev.heap;
    const sunCommits = (atmosphere.sunSteps ?? 0) - prev.sunSteps;
    /**
     * The two independent reasons the shadow map re-renders, kept apart because
     * they have different fixes: the clock stepping the sun (`atmosphere.tick`)
     * and the player walking far enough to move the anchor (`atmosphere.follow`).
     * NaN on the very first frame fails the comparison, which is the answer we
     * want.
     */
    const anchorMoved = atmosphere._anchorX !== prev.anchorX;
    /**
     * Drained every frame rather than only on the frames that qualify, because
     * the cursor has to move whether or not anybody reads it — otherwise the
     * first freeze of a session would be handed every geometry met since the
     * gate lifted. `drainNewborn` allocates nothing when the cursor is current,
     * which is all but a handful of frames.
     */
    const met = drainNewborn(newborn, newbornAt);
    newbornAt = met.cursor;
    const grows = slabGrowths() - prev.grows;
    const level = settings?.autoLevel;
    const scale = pipeline.drs?.scale ?? 1;
    const rungChanged = level !== prev.level;
    const scaleChanged = Math.abs(scale - prev.scale) > 1e-6;

    prev.built += built;
    prev.evicted += evicted;
    prev.ground += ground;
    prev.geometries += geometries;
    prev.textures += textures;
    if (uploadedNow) prev.uploaded = uploadedNow;
    prev.heap += heap;
    prev.sunSteps += sunCommits;
    prev.anchorX = atmosphere._anchorX;
    prev.level = level;
    prev.scale = scale;
    prev.grows += grows;

    if (ringCount < 30) return;
    const med = medianOf(ring, ringCount);
    if (ms < FLOOR_MS || ms < med * RATIO) return;

    /**
     * WHERE THE SUN WAS, RELATIVE TO WHERE YOU WERE LOOKING.
     *
     * Written down because it is the one question a counter delta can never
     * answer and the one a player's description always contains — "it freezes
     * when the sun comes through the trees" is a claim about a view direction
     * and an hour, and neither is anywhere in `renderer.info`. 0 deg is looking
     * straight into the sun; 180 is with it directly behind you. If a log full
     * of freezes all sits under 30 deg, the report was right and the cause is in
     * something only drawn when the sun is in frame; if they are scattered
     * uniformly, the sun was a coincidence of when the player happened to notice.
     */
    const fwd = camera.getWorldDirection(scratch);
    const L = atmosphere.lightDirection;
    const toSun = Math.acos(Math.max(-1, Math.min(1, fwd.x * L.x + fwd.y * L.y + fwd.z * L.z))) * DEG;
    const day = atmosphere.day.info();

    const entry = {
      t: +((now - started) / 1000).toFixed(1),
      ms: +ms.toFixed(1),
      x: med ? +(ms / med).toFixed(0) : 0,
      clock: day.hhmm,
      phase: +day.phase.toFixed(4),
      sunDeg: +toSun.toFixed(0),
      sunElev: +day.sunElevation.toFixed(0),
      trip: +(director.level ?? 0).toFixed(2),
      compiled: fresh,
      built,
      evicted,
      ground,
      geometries,
      textures,
      /** First-drawn this frame, and what the driver had to upload for them. */
      firstDrawn: met.count ? met.summary : '',
      uploadKB: met.bytes ? Math.round(met.bytes / 1024) : 0,
      slabGrowths: grows,
      instances: uploadedNow,
      heapMB: +(heap / 1e6).toFixed(1),
      shadow: sunCommits ? 'sun step' : anchorMoved ? 'anchor moved' : '',
      rung: rungChanged ? `-> ${level}` : '',
      drs: scaleChanged ? +scale.toFixed(3) : '',
    };
    log.push(entry);
    if (log.length > KEEP) log.shift();

    /**
     * Announced, not merely recorded. A log nobody knows to look in is a log
     * nobody looks in, and the whole point is that the person who felt the
     * freeze is sitting in front of this. Rate-limited to one line every few
     * seconds so a genuinely broken frame loop cannot flood the console and
     * become the thing making it slow.
     */
    if (now - announced > 3000) {
      announced = now;
      const why =
        (fresh.length ? `compiled ${fresh.join(', ')}; ` : '') +
        (grows ? `${grows} slab${grows > 1 ? 's' : ''} doubled; ` : '') +
        (met.count ? `first draw of ${met.summary} (${kb(met.bytes)} uploaded); ` : '') +
        (built ? `${built} sectors built; ` : '') +
        (evicted ? `${evicted} sectors evicted; ` : '') +
        // Only when the newborn log did not already say what they were: the two
        // count the same event and naming it twice reads as two events.
        (geometries && !met.count ? `${geometries > 0 ? '+' : ''}${geometries} geometries; ` : '') +
        (textures ? `${textures > 0 ? '+' : ''}${textures} textures; ` : '') +
        (entry.rung ? `quality ${entry.rung}; ` : '') +
        (entry.shadow ? `shadow map (${entry.shadow}); ` : '');
      console.warn(
        `[freeze] ${entry.ms} ms (x${entry.x}) at ${entry.clock}, ` +
          `sun ${entry.sunDeg}deg off centre, ${entry.sunElev}deg up — ` +
          `${why || 'no counter this watches moved'}  ·  RR.freezes.table()`
      );
    }
  };

  requestAnimationFrame(tick);

  return {
    /** Every freeze so far, oldest first. */
    list: () => log.slice(),
    /** The same thing, readable. */
    table() {
      if (!log.length) {
        console.log('No freezes recorded. (Anything over %d ms, or %dx the running median.)', FLOOR_MS, RATIO);
        return;
      }
      console.table(log);
    },
    /**
     * Is the sun actually implicated? The question the report asked, answered
     * over however many freezes have been seen rather than over the one the
     * player happened to be looking at the sun during.
     */
    sun() {
      if (!log.length) return console.log('No freezes recorded yet.');
      const near = log.filter((e) => e.sunDeg < 45).length;
      console.log(
        `${log.length} freezes; ${near} of them (${((near / log.length) * 100).toFixed(0)}%) ` +
          'with the sun inside 45 deg of the view centre.\n' +
          'A frustum is about 60 deg tall, so roughly 15-20% is what "no relationship" looks like.'
      );
      const hours = {};
      for (const e of log) hours[e.clock.slice(0, 2)] = (hours[e.clock.slice(0, 2)] ?? 0) + 1;
      console.log('by hour:', hours);
    },
    clear() {
      log.length = 0;
    },
  };
}

function medianOf(ring, n) {
  const a = Array.prototype.slice.call(ring.subarray(0, n));
  a.sort((x, y) => x - y);
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}
