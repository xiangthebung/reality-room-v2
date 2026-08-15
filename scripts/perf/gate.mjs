import { boot, argv, heading, rule, NUM, PAD } from './harness.mjs';

/**
 * WHAT DOES THE MACHINE DO WHILE NOBODY IS LOOKING AT IT?
 *
 * Every other script in this directory measures the world. This one measures
 * the screens where the world is *covered up* — the main menu and the settings
 * panel — because those are the states where effort is hardest to notice and
 * therefore easiest to spend for ever.
 *
 * The menu is the one that mattered. It is the first thing anybody sees, it is
 * up for as long as somebody takes to type a name and pick a colour, and `#gate`
 * is opaque: its last background layer is a solid colour, so not one pixel of
 * what is behind it reaches the screen. Underneath it the frame loop was drawing
 * the whole forest at whatever rate the display would accept — 159 draw calls
 * and 12.6M triangles per frame, 100% of what the world costs while 0% of it is
 * visible. A player who opens the game and goes to make tea gets a GPU at full
 * tilt and a fan, and no other symptom.
 *
 * THE METRIC IS WORLD FRAMES DRAWN PER SECOND, NOT FRAME RATE, and the
 * difference is the whole reason this script needed a second draft. Once the
 * draw is throttled the browser stops producing compositor frames as fast as it
 * can and paces rAF back to the display's own rate, so the loop's interval
 * lengthens — a measurement of idleness that reads exactly like a measurement of
 * cost, and reads it backwards. Counting calls into `pipeline.render` cannot be
 * fooled that way: each one is a full forest, in either state.
 *
 * Reported as a ratio against the world for the same reason every number in this
 * directory is. The absolute figures belong to this machine and this window.
 *
 *   npm run perf:gate
 *   npm run perf:gate -- --seconds=4
 */

const args = argv({ seconds: '3', headed: 'false', linger: '3' });
const SECONDS = Number(args.seconds);
/**
 * How long to sit on the menu before clicking, in seconds.
 *
 * `--linger=0` is the case the draw throttle has to be judged against, and it is
 * the one that would be easy to miss. Slowing the loop down means the terrain
 * streamer — which takes one chunk per frame — gets fewer frames, so a player
 * who clicks the instant the page loads has done none of their streaming in
 * advance and pays for all of it at the click. Everyone else pays less, and the
 * average is not the thing to protect: the impatient click is.
 */
const LINGER = Number(args.linger);

/**
 * Count real renders over a wall-clock window, and the loop's cadence with it.
 *
 * The wrapper is installed and removed inside one evaluate so a thrown error
 * cannot leave the page running through a monkey-patch for the rest of the run.
 */
async function draws(page, seconds) {
  return page.evaluate(
    (secs) =>
      new Promise((resolve) => {
        const pipeline = window.RR.pipeline;
        const original = pipeline.render;
        let rendered = 0;
        pipeline.render = function (...a) {
          rendered++;
          return original.apply(this, a);
        };

        const dts = [];
        let last = performance.now();
        const started = last;
        const until = last + secs * 1000;
        const step = (now) => {
          dts.push(now - last);
          last = now;
          if (now < until) return void requestAnimationFrame(step);
          pipeline.render = original;
          dts.sort((a, b) => a - b);
          const elapsed = (now - started) / 1000;
          resolve({
            drawsPerSec: rendered / elapsed,
            ticksPerSec: dts.length / elapsed,
            p50: dts[Math.floor(dts.length * 0.5)],
          });
        };
        requestAnimationFrame(step);
      }),
    seconds
  );
}

/**
 * What the renderer submits on one drawn frame.
 *
 * `info.autoReset` is turned OFF for the read and back on afterwards, because
 * three resets the counters at the top of every render pass and this pipeline
 * runs several — read naively, the numbers describe the last post-processing
 * blit and nothing else. That mistake once had five scripts in this repo
 * confidently reporting one draw call and two triangles.
 *
 * It waits on `pipeline.render` rather than on rAF, which matters only on the
 * menu: there, nineteen ticks in twenty draw nothing, and a reset armed on one
 * tick and read on the next would usually read a frame that never happened.
 */
async function submitted(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const pipeline = window.RR.pipeline;
        const info = window.RR.renderer.info;
        const original = pipeline.render;
        info.autoReset = false;
        let seen = 0;
        pipeline.render = function (...a) {
          seen++;
          if (seen === 1) info.reset();
          const out = original.apply(this, a);
          if (seen === 1) {
            pipeline.render = original;
            const read = { calls: info.render.calls, triangles: info.render.triangles };
            info.autoReset = true;
            resolve(read);
          }
          return out;
        };
      })
  );
}

const rows = [];
const { browser, page } = await boot({ headed: args.headed === 'true', enter: false });

try {
  // ---- 1. the menu, exactly as a player meets it -------------------------
  // A moment first: the terrain streamer takes one chunk per frame and the
  // early frames are a world still arriving, which is a fair thing to pay for
  // and not what this is asking about.
  await page.waitForTimeout(LINGER * 1000);
  /**
   * AND THEN WAIT FOR THE CAVES, WHICH IS WHAT MADE THE ASSERTION AT THE BOTTOM
   * OF THIS FILE RED.
   *
   * `menu.calls !== world.calls` is not a cost check — it is "the menu is
   * drawing a DIFFERENT scene from the world", and it was reporting 139 against
   * 143 with 16.62 M triangles against 16.90 M. That difference is exactly the
   * cave: `cave`, `cave-shafts` and `cave-fungi`, 277 964 triangles and four
   * draw calls, which arrive some tens of seconds into the session because a
   * cave is built at 0.6 ms a frame. The two readings really were of two
   * different scenes, and the gate was right; what it was catching was its own
   * schedule, not a throttle warming the wrong shaders.
   *
   * A LINGER LONG ENOUGH WOULD ALSO HAVE DONE IT and is the wrong fix, for the
   * reason this repo has now recorded six times under
   * `settling-by-frame-count-lies`: a stopwatch is a guess about somebody else's
   * subsystem, and the guess goes stale the next time that subsystem changes.
   * `CaveField.settled` is the cave field's own answer. Bounded, because a
   * machine that never finishes should say so rather than hang, and permissive
   * on timeout because the assertion below is what reports the consequence.
   */
  await page
    .waitForFunction(() => window.RR?.caves?.settled === true, null, { timeout: 120000 })
    .catch(() => console.log('  (caves never settled behind the menu — the draw-call check below will say so)'));
  if (LINGER > 0) {
    rows.push({
      name: 'menu (gate up)',
      ...(await draws(page, SECONDS)),
      ...(await submitted(page)),
    });
  }

  // ---- 2. the world ------------------------------------------------------
  /**
   * Timed, because the cheap way to make a menu cost nothing is to throttle the
   * whole frame body — and the terrain streamer lives in that body. That version
   * costs nothing on the menu and hands the bill straight to the click, which is
   * the one wait in the session the project has spent real effort keeping short.
   * If this number grows, the throttle went too deep.
   */
  const clickedAt = Date.now();
  await page.click('#enter');
  await page
    .waitForFunction(() => document.getElementById('gate')?.classList.contains('gone'), null, {
      timeout: 90000,
    })
    .catch(() => {});
  const liftMs = Date.now() - clickedAt;
  await page.waitForTimeout(2000);
  rows.push({ name: 'world (playing)', ...(await draws(page, SECONDS)), ...(await submitted(page)) });

  // ---- 3. the settings panel ---------------------------------------------
  // Expected to cost full price and NOT a finding. Its scrim is deliberately
  // translucent with a backdrop blur — the wood stays dimly legible behind it,
  // which is what makes it read as a pause rather than a second screen — and it
  // is where the graphics knobs are, so a frame rate held down here would lie
  // about what the setting being dragged is worth. Measured anyway, so that the
  // day somebody makes it opaque this notices.
  await page.evaluate(() => window.RRSettingsMenu?.show());
  await page.waitForTimeout(600);
  rows.push({ name: 'settings open', ...(await draws(page, SECONDS)), ...(await submitted(page)) });
  await page.evaluate(() => window.RRSettingsMenu?.hide());

  // ---- report ------------------------------------------------------------
  console.log(heading('the covered screens'));
  console.log(`${PAD('', 18)}${PAD('drawn/s', 10)}${PAD('ticks/s', 10)}${PAD('draws', 8)}tris`);
  console.log(rule('─', 58));
  for (const r of rows) {
    console.log(
      PAD(r.name, 18) +
        PAD(NUM(r.drawsPerSec, 0, 1), 10) +
        PAD(NUM(r.ticksPerSec, 0, 1), 10) +
        PAD(r.calls, 8) +
        `${(r.triangles / 1e6).toFixed(2)}M`
    );
  }

  const world = rows.find((r) => r.name.startsWith('world'));
  const menu = rows.find((r) => r.name.startsWith('menu'));
  const share = menu ? menu.drawsPerSec / world.drawsPerSec : null;
  console.log(
    (menu
      ? `\nmenu draws ${(share * 100).toFixed(0)}% as many forests per second as the world does`
      : '\nclicked without lingering') +
      `\ngate lifted ${(liftMs / 1000).toFixed(1)}s after the click (lingered ${LINGER}s first)`
  );

  const fail = [];
  // 25%: a heartbeat that keeps arriving terrain uploaded, and nothing more. Ten
  // a second against a 60 Hz floor is 17%; the headroom is for a slow display.
  if (menu && share > 0.25) {
    fail.push(`the menu is drawing ${(share * 100).toFixed(0)}% of a played frame`);
  }
  // The number to beat is the one this had before the throttle existed, which
  // was ~6.6 s on the machine this was written on. Generous, because it is a
  // guard against a whole-body throttle, not a benchmark of the streamer.
  if (liftMs > 20000) fail.push(`the gate took ${(liftMs / 1000).toFixed(1)}s to lift`);
  if (menu && menu.calls !== world.calls) {
    // Not a cost check. If these ever disagree the menu is drawing a DIFFERENT
    // scene from the world, which would mean the heartbeat is warming the wrong
    // shaders and the first real frame pays for the rest.
    fail.push(`menu submits ${menu.calls} draw calls, world submits ${world.calls}`);
  }

  if (fail.length) {
    console.log(`FAIL — ${fail.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log('PASS');
  }
} finally {
  await browser.close();
}
