import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * Does the view breath do what it claims, and does it look like a filter?
 *
 * Two questions, and they need two different pictures.
 *
 *   IS IT THERE. One station, camera pinned, every other family switched off,
 *   the same frame taken several seconds apart. If those frames are identical
 *   the effect does not exist however good any one of them looks — this is the
 *   same test morph.mjs applies to the surface families, and it is the only one
 *   that can tell a still distortion from a moving one.
 *
 *   IS IT STUCK TO THE GLASS. The same world instant shot with the head at
 *   several yaws. A field anchored to the SCREEN puts its features in the same
 *   part of the frame whichever way you face; a field anchored to the world
 *   moves them off the edge as you turn. That is the one property that decides
 *   whether this reads as the room breathing or as something on the monitor,
 *   and no single frame can show it.
 *
 *   node scripts/view-shots.mjs [--gain=1] [--gap=2600]
 *
 * `--gain` multiplies director.gain.view, so `--gain=4` shoots an exaggerated
 * version. Useful: at the shipping amplitude the displacement is 1.6% of the
 * frame, which is the right amount to feel and an awkward amount to SEE in a
 * pair of stills.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const GAIN = Number(args.gain ?? 1);
const GAP = Number(args.gap ?? 2600);
const OUT = '.shots/view';
mkdirSync(OUT, { recursive: true });

/**
 * The clearing, because the view breath is the one family whose subject is the
 * WHOLE frame — a station pressed against bark tests the skin of one thing and
 * this effect has no opinion about any single thing. Trunks at several depths
 * with sky behind them is what shows a swell crossing the picture.
 */
const STATION = { x: 0, z: 5, pitch: -0.02 };

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.routeWebSocket(/.*/, () => {});
await page.goto('http://127.0.0.1:5180/?seed=grove-01', { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(3000);

/**
 * ISOLATE, THEN PIN.
 *
 * Every other family off, including the camera: the dolly and the fov drift
 * move every pixel in the frame by themselves, which is enough to make any two
 * shots differ and therefore enough to hide the answer. With those off, a pixel
 * that changed between two frames changed because of this effect.
 *
 * The daylight phase is pinned for the same reason it is pinned everywhere else
 * in scripts/: the sun is a function of the wall clock, so two shots a few
 * seconds apart are lit differently and every difference reads as attributable.
 */
async function isolate(gain) {
  await page.evaluate(
    ([g, s]) => {
      const R = window.RR;
      R.director.state.override = 1;
      for (const k of Object.keys(R.director.switches)) R.director.switches[k] = false;
      R.director.switches.world = true;
      R.director.switches.view = true;
      R.director.gain.view = g;
      R.controller.position.set(s.x, R.controller.position.y, s.z);
      R.controller.pitch = s.pitch;
    },
    [gain, STATION]
  );
}

const face = (yaw) =>
  page.evaluate((y) => {
    window.RR.controller.yaw = y;
  }, yaw);

const shoot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

await isolate(GAIN);
await face(0);
await page.waitForTimeout(2500);

// 1. Does it move? Same everything, three moments.
for (let i = 0; i < 3; i++) {
  await shoot(`moves-${i}`);
  if (i < 2) await page.waitForTimeout(GAP);
}

// 2. On against off, at one instant. The director's clock keeps running between
//    these two, so they are not a pixel diff — they are the pair a person would
//    flip between to see whether the effect is visible at all.
await page.evaluate(() => {
  window.RR.director.gain.view = 0;
});
await page.waitForTimeout(400);
await shoot('off');
await page.evaluate((g) => {
  window.RR.director.gain.view = g;
}, GAIN);
await page.waitForTimeout(400);
await shoot('on');

// 3. Is it stuck to the glass? Four yaws, same wood.
for (const [i, yaw] of [0, 0.45, 0.9, 1.35].entries()) {
  await face(yaw);
  await page.waitForTimeout(900);
  await shoot(`yaw-${i}`);
}

/* -------------------------------------------------------------------------- */
/* the two claims a screenshot cannot make                                     */
/* -------------------------------------------------------------------------- */

/**
 * Both of these are pixel counts off the real framebuffer, taken inside ONE
 * process with nothing between the two frames but the thing being tested. A
 * screenshot pair proves neither: two stills taken seconds apart differ for a
 * dozen reasons, and two that look the same may still differ in a way that
 * matters.
 *
 *   IT MOVES. The frame at one moment against the frame a breath later, with
 *   every other family off and the camera pinned. Any pixel that changed
 *   changed because of this effect.
 *
 *   SOBER IS UNTOUCHED, TO THE BIT. Not "looks the same" — the same. The
 *   output shader takes a uniform branch on uViewWarp and at zero the read
 *   coordinate is the literal vUv it was before this existed, so the correct
 *   answer here is 0 differing pixels and anything else is a bug in the
 *   branch. This is the standing rule for every optional term in the pipeline
 *   and it is worth a hard number rather than a reading of the source.
 */
const pixels = await page.evaluate(async (gain) => {
  const R = window.RR;
  const gl = R.renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const a = new Uint8Array(w * h * 4);
  const b = new Uint8Array(w * h * 4);
  const shoot = (buf) => {
    R.pipeline.render(1 / 60);
    R.pipeline.render(1 / 60);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  };
  const differing = () => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
    }
    return n;
  };
  const step = (seconds) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
    }
  };

  // 1. does it move — a third of a breath apart at full amplitude
  R.director.gain.view = gain;
  step(0.5);
  shoot(a);
  step(3.2);
  shoot(b);
  const moved = differing();

  /**
   * 2. sober, with the switch on and off. `override = 0` rather than clearing
   * it: the envelope has to be pinned or `eased` drifts between the two frames
   * and the diff measures the come-down instead of the branch.
   */
  R.director.state.override = 0;
  step(6);
  R.director.switches.view = true;
  shoot(a);
  R.director.switches.view = false;
  shoot(b);
  const sober = differing();

  R.director.state.override = 1;
  R.director.switches.view = true;
  return { moved, sober, total: w * h, w, h };
}, GAIN);

/**
 * WALKING STANDS IT DOWN, and a teleport does not.
 *
 * The second half is the one worth a gate. Every `arrive` in the perf harness
 * and every debug seek moves the camera tens of metres between two updates, and
 * read as a velocity that is a stand-down that lasts about a second — so the
 * perf rig would time a damped effect and report the feature as cheaper than it
 * is, and a player would find the wood stopped breathing whenever the world
 * recentred. Neither failure looks like a bug from the outside.
 */
const walking = await page.evaluate(() => {
  const R = window.RR;
  /**
   * Returns the STILLNESS FACTOR, not uViewWarp.
   *
   * uViewWarp is that factor times the level curve times the surge, and the
   * surge is a 19-second carrier — so two readings 2.5 s apart differ by more
   * than the thing being tested, and the settled arm came back at 112% of the
   * still arm for reasons that had nothing to do with standing still. The
   * factor is the quantity under test and it is bounded 0..1 by construction.
   */
  const step = (n, move) => {
    for (let i = 0; i < n; i++) {
      // Drive the body the way the loop does: seat, then let the director see
      // where it ended up. `move` is metres along +x per frame.
      R.controller.position.x += move;
      R.controller.applyToCamera();
      R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
    }
    return R.director._stillness;
  };
  R.director.state.override = 1;
  /**
   * Let the ENVELOPE converge before the first reading, not just the stillness.
   *
   * `override` pins the target; `eased` damps toward it over seconds, so a
   * reading taken too early is against a trip that is still coming up, and
   * every later row then looks larger than it is. The first version of this
   * reported the settled arm at 115% of the still arm — which reads as the
   * stand-down overshooting and was in fact uLevel climbing 0.88 to 1.0
   * underneath it.
   */
  step(400, 0);
  const still = step(150, 0);
  // 4.4 m/s is WALK in player/controller.js.
  const walk = step(150, 4.4 / 60);
  const settled = step(150, 0);
  // A jump of 40 m in one frame, then held still.
  R.controller.position.x += 40;
  R.controller.applyToCamera();
  R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
  const afterJump = step(20, 0);
  R.director.state.override = null;
  return { still, walk, settled, afterJump };
});
const stillPct = (v) => `${(v * 100).toFixed(0)}%`;
const standsDown = walking.walk < 0.1 && walking.settled > 0.9;
const jumpOk = walking.afterJump > 0.9;
console.log(
  `\nwalking: stillness  standing ${stillPct(walking.still)} → walking at 4.4 m/s ` +
    `${stillPct(walking.walk)} → standing again ${stillPct(walking.settled)}  ` +
    `${standsDown ? '— stands down and comes back' : 'DOES NOT STAND DOWN'}`
);
console.log(
  `         after a 40 m jump in one frame: ${stillPct(walking.afterJump)}  ` +
    `${jumpOk ? '— a teleport is not a speed' : 'TELEPORT READ AS MOTION'}`
);

/**
 * THE CLAIM THE WHOLE DESIGN RESTS ON: THE FIELD IS ANCHORED TO THE WORLD.
 *
 * If a piece of the wood keeps its place in the field as it crosses the frame,
 * the swell belongs to the world. If it does not, the field is dragged along
 * with the head and the effect is a filter on the glass — which is what a
 * player notices within about two seconds of turning, and what no still frame
 * can show, because every still is one orientation.
 *
 * So: take a fixed WORLD DIRECTION, work out which pixel it lands on at each of
 * several head angles, and put that pixel back through the domain map. A
 * world-anchored map returns the same domain position every time.
 *
 * The map is reimplemented here from the two lines of `rayDomain`, against the
 * uniforms read off the live page — so it tests the real camera basis, and it
 * would not notice the shader being changed underneath it. That is an accepted
 * limit: this catches the class of bug it was written for (a domain that is not
 * rotation-invariant), which is a property of the FORMULA, and the formula is
 * short enough to keep in step by eye.
 */
const anchor = await page.evaluate((broken) => {
  const R = window.RR;
  window.__RR_BROKEN_DOMAIN = broken;
  const ARC = 3.1;
  const SHELL = 120.0;
  /**
   * The test direction is DERIVED from where the camera is already looking,
   * not written down as a world constant. A constant only works if the station
   * happens to face it, and this station does not face -Z — the first version
   * of this test was simply off screen at every yaw and reported that instead
   * of an answer.
   *
   * Taken 0.3 rad off the current heading and tilted up slightly, so it starts
   * well inside the frame and lands somewhere DIFFERENT in it at each yaw
   * below. A direction that stays near the middle would pass this test on the
   * broken map too, because the error is proportional to angle off the axis.
   */
  const d = (() => {
    const e0 = R.tripUniforms.uViewRot.value.elements;
    const fwd = [-e0[6], -e0[7], -e0[8]];
    const c = Math.cos(0.3);
    const s = Math.sin(0.3);
    const v = [fwd[0] * c + fwd[2] * s, fwd[1] + 0.14, -fwd[0] * s + fwd[2] * c];
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  })();

  const sample = (yaw) => {
    R.controller.yaw = yaw;
    R.controller.applyToCamera();
    for (let i = 0; i < 4; i++) R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
    const e = R.tripUniforms.uViewRot.value.elements;
    const t = R.tripUniforms.uViewTan.value;
    const eye = R.tripUniforms.uEye.value;
    // camera-space vector for d is R' d — the columns of R dotted with d.
    const c = [0, 1, 2].map((i) => e[i * 3] * d[0] + e[i * 3 + 1] * d[1] + e[i * 3 + 2] * d[2]);
    if (c[2] >= -0.05) return null; // behind, or too near the horizon to project
    const uv = [0.5 + c[0] / -c[2] / (2 * t.x), 0.5 + c[1] / -c[2] / (2 * t.y)];
    if (uv.some((u) => u < 0 || u > 1)) return null; // off the frame at this yaw
    // …and now the two lines of rayDomain, verbatim.
    const cam = [(uv[0] - 0.5) * 2 * t.x, (uv[1] - 0.5) * 2 * t.y, -1];
    const w = [0, 1, 2].map((r) => e[r] * cam[0] + e[3 + r] * cam[1] + e[6 + r] * cam[2]);
    /**
     * `broken` is the map as it was before the fix: the unnormalised ray,
     * scaled. It is here so this check can be shown to FAIL — a test that has
     * only ever passed is a test that has not been tested, and this one is
     * asserting the property the entire design rests on.
     */
    if (window.__RR_BROKEN_DOMAIN) return w.map((x) => x * 2.2);
    const n = Math.hypot(...w);
    const eyeArr = [eye.x, eye.y, eye.z];
    return w.map((x, i) => (x / n + eyeArr[i] / SHELL) * ARC);
  };

  const yaw0 = R.controller.yaw;
  const seen = [];
  for (const dy of [-0.34, -0.17, 0, 0.17, 0.34]) {
    const p = sample(yaw0 + dy);
    if (p) seen.push({ dy, p, uvSpread: true });
  }
  R.controller.yaw = yaw0;
  R.controller.applyToCamera();
  if (seen.length < 3) return { error: 'the test direction was not on screen at enough yaws' };
  // How far the domain position of one fixed piece of world wandered.
  let worst = 0;
  for (const a of seen) {
    for (const b of seen) {
      worst = Math.max(worst, Math.hypot(...a.p.map((x, i) => x - b.p[i])));
    }
  }
  return { yaws: seen.length, worst };
}, args.broken === 'true');
if (anchor.error) {
  console.log(`\nanchor: ${anchor.error}`);
} else {
  /**
   * The bar is a fiftieth of a lattice cell. The unnormalised map failed this
   * by more than a whole cell across the same sweep — the field slid a full
   * feature while the head turned 39 degrees.
   */
  const ok = anchor.worst < 0.02;
  console.log(
    `\nanchor: one world direction, ${anchor.yaws} head angles — its domain ` +
      `position wandered ${anchor.worst.toFixed(4)} of a lattice cell  ` +
      `${ok ? '— world-anchored' : 'THE FIELD IS DRAGGED BY THE HEAD'}`
  );
}

/**
 * THE THIRD CLAIM: THE COMFORT SLIDER REACHES IT.
 *
 * This is the one most likely to rot. `motionIntensity` writes three fields
 * now, and nothing about `director.gain.view` going stale would be visible —
 * the trip would simply keep swelling the picture for somebody who had asked it
 * not to, and the only person who would find out is the person the control
 * exists for. So it is asserted here rather than remembered.
 *
 * Driven through the settings menu's own DOM, deliberately. Importing
 * `/src/core/quality.js` from inside the page gets a SECOND instance of the
 * registry whenever Vite has stamped the app's copy with an HMR query, so `set`
 * lands on an empty setter table and every knob silently does nothing — which
 * reads exactly like the broken wiring this is meant to detect. Going through
 * the DOM uses the app's instance by construction.
 */
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const comfort = await page.evaluate(() => {
  const R = window.RR;
  const input = document.querySelector('[data-knob="motionIntensity"] input');
  if (!input) return { error: 'no Camera motion row in the settings menu' };
  const set = (v) => {
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    for (let i = 0; i < 40; i++) {
      R.director.update(1 / 60, { camera: R.camera, audioLevels: null });
    }
    return { warp: R.tripUniforms.uViewWarp.value, level: R.tripUniforms.uLevel.value };
  };
  R.director.state.override = 1;
  set(1);
  const full = set(1);
  const off = set(0);
  set(1);
  R.director.state.override = null;
  return { full, off };
});
if (comfort.error) {
  console.log(`\ncomfort: ${comfort.error}`);
} else {
  const held = comfort.off.warp === 0 && comfort.off.level > 0.5;
  console.log(
    `\ncomfort: Camera motion 1 → uViewWarp ${comfort.full.warp.toFixed(5)}, ` +
      `0 → ${comfort.off.warp.toFixed(5)} at uLevel ${comfort.off.level.toFixed(2)}  ` +
      `${held ? '— held still while the trip runs' : 'ACCESSIBILITY CONTROL DOES NOT REACH IT'}`
  );
}
await page.keyboard.press('Escape');

/**
 * The one number no screenshot can carry: how far the picture actually moved.
 *
 * uViewWarp is the exact bound on the displacement — the limiter in viewBreath
 * makes it so — which means this is not an estimate. Printed in pixels because
 * that is the unit the question is asked in.
 */
const report = await page.evaluate(() => ({
  level: window.RR.tripUniforms.uLevel.value,
  warp: window.RR.tripUniforms.uViewWarp.value,
  fov: window.RR.camera.fov,
}));
const pct = (n) => ((n / pixels.total) * 100).toFixed(1);
console.log(
  `\nmoves:  ${pixels.moved} of ${pixels.total} px changed over 3.2 s ` +
    `(${pct(pixels.moved)}%) — the camera did not move` +
    `${pixels.moved < pixels.total * 0.05 ? '   TOO FEW: the effect is barely running' : ''}`
);
console.log(
  `sober:  ${pixels.sober} px differ with the switch on vs off ` +
    `${pixels.sober === 0 ? '— bit-identical, as it must be' : '   NOT FREE WHEN SOBER'}`
);
console.log(
  `uLevel ${report.level.toFixed(3)}  uViewWarp ${report.warp.toFixed(5)}  ` +
    `= at most ${(report.warp * 1280).toFixed(1)} px of 1280, ` +
    `${(report.warp * 100).toFixed(2)}% of the frame`
);
console.log(`shots in ${OUT}`);

await browser.close();
