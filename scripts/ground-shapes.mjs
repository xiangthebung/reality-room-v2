import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * Photograph the four solid shapes on the forest floor, close up, at four
 * phases of the breath.
 *
 * THE COMPLAINT THIS EXISTS FOR: "a lot of shapes on the ground are visually
 * messed up — I can see through some of them, and when I'm tripping they
 * breathe apart." Both halves of that are invisible to every other instrument
 * in `scripts/`. `check-plants.mjs` only looks at geometries carrying `aScale`,
 * which is the plant layers — a stick, a stump, a log and a mushroom are all
 * `prop` materials with no such attribute, so not one of them has ever been
 * measured by anything. `morph.mjs` stands at head height five metres back,
 * where a 15 cm mushroom cap is nine pixels and a hole in it is none.
 *
 * So the two things this does that nothing else does are: stand the eye
 * CENTIMETRES from the object, and stand it BELOW the object as well as above
 * it. A missing face on a `FrontSide` body is invisible from the side it faces
 * and total from the other, so a single camera height cannot see the bug — the
 * mushroom cap in particular is a shell with no underside, which from above is
 * a perfect mushroom and from below is nothing at all.
 *
 * THE BREATH PHASE IS PINNED, NOT WAITED FOR. `morph.mjs` takes four frames
 * seconds apart and lets the wave land where it lands, which is right for "does
 * anything move at all" and useless here: the failure is at the two EXTREMES of
 * `rrLung`, the phases at which a surface is furthest along its own normal, and
 * a free-running clock visits those for a few frames out of every cycle. The
 * uniform's `value` is replaced by an accessor whose setter is a no-op, so the
 * director keeps running — the colour, the melt, the wind and the camera all
 * live — while this one number holds still. Freezing the whole clock instead
 * would also freeze the thing being photographed.
 *
 * Phases 0 and π are the neutral crossings, π/2 is full inflation and 3π/2 is
 * full contraction. Contraction is the one that matters most: that is where a
 * surface pushed inward by more than its own thickness passes through its own
 * axis, reverses its winding and is culled — see the thickness-gauge note in
 * living.js.
 *
 * Run with the dev server up:
 *   node scripts/ground-shapes.mjs --tag=before
 *   node scripts/ground-shapes.mjs --tag=after
 * then flip between `.shots/ground/before/*` and `.shots/ground/after/*`.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const TAG = args.tag ?? 'now';
const OUT = `.shots/ground/${TAG}`;
mkdirSync(OUT, { recursive: true });

/**
 * The four subjects, and the angle each one hides its bug from.
 *
 * `axis` frames the object along its own local X. A stick and a log are
 * cylinders laid along X and given a yaw by the instance, so the one view that
 * looks INTO an open end is the one down that axis — and an open end is exactly
 * what a `CylinderGeometry` with `openEnded: true` has. Hunting for that view
 * by hand at a hand-picked coordinate would go stale the first time the seed
 * moved; taking the direction out of the instance matrix cannot.
 *
 * `low` is the eye height at which the object is seen from underneath. It is
 * below the top of every subject on purpose: that is where a shell with no
 * floor stops existing.
 */
/**
 * `gap` IS CLEARANCE PAST THE OBJECT'S OWN END, NOT A DISTANCE FROM ITS ORIGIN,
 * and the first draft of this script had it the other way round. A stick's
 * geometry is 1.7 m long and its instance stretches that by 0.35–1.8×, so a
 * camera parked 0.55 m from the origin is INSIDE the stick — and inside a
 * `FrontSide` body every face points away from you, so the frame comes back
 * showing a clean coloured wedge that looks exactly like the see-through bug
 * being hunted. Two of the four subjects photographed their own interiors.
 * The reach is therefore taken from the geometry's bounding box times the
 * instance's own scale, which is a number that cannot go stale.
 */
const SUBJECTS = [
  { name: 'shroom-cap', mesh: 'shroom-cap', gap: 0.34, high: 0.85, low: 0.06, aim: 0.28 },
  { name: 'stick', mesh: 'sticks', gap: 0.3, high: 0.32, low: 0.05, aim: 0.04, axis: true },
  { name: 'log', mesh: 'logs', gap: 1.5, high: 1.5, low: 0.16, aim: 0.4, axis: true },
  { name: 'stump', mesh: 'stumps', gap: 0.9, high: 1.55, low: 0.16, aim: 0.5 },
];

const PHASES = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });

const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(m.text());
});
page.on('pageerror', (e) => problems.push(e.message));

// See the note in check-plants.mjs: a hot reload landing mid-run re-evaluates
// the world under a script that is halfway through photographing it.
await page.routeWebSocket(/.*/, () => {});

/**
 * A THROW ANYWHERE IN THE FRAME FUNCTION FREEZES THE PICTURE WITHOUT STOPPING
 * THE APP, and that is the failure this guard exists for.
 *
 * `main.js` schedules the next frame before it does the work, so an exception
 * raised part-way through one leaves the loop alive — the clock keeps running,
 * the director keeps easing, the console fills up at sixty errors a second —
 * and `renderer.render()` is simply never reached. Every screenshot after that
 * point is the same stale back buffer, byte for byte, and the script reports a
 * clean run over forty identical files. It cost a full before-pass to notice:
 * `renderer.info.render.frame` was pinned at 1829 while `worldClock()` advanced
 * three seconds.
 *
 * The specific throw was an audio bed feeding a non-finite value to
 * `setTargetAtTime`, in a system this script has no interest in and no business
 * fixing. Rather than depend on the audio graph being healthy, the Web Audio
 * scheduling calls drop a non-finite value instead of raising — and the count
 * is printed at the end, so a shielded run never looks like a clean one.
 */
await page.addInitScript(() => {
  window.__rrAudioNaN = 0;
  for (const fn of ['setTargetAtTime', 'setValueAtTime', 'linearRampToValueAtTime']) {
    const original = AudioParam.prototype[fn];
    AudioParam.prototype[fn] = function guarded(...a) {
      if (a.some((v) => typeof v === 'number' && !Number.isFinite(v))) {
        window.__rrAudioNaN++;
        return this;
      }
      return original.apply(this, a);
    };
  }
});

await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2500);

await page.evaluate(() => {
  for (const id of ['toast', 'help', 'hud']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  const { director, controller, tripUniforms } = window.RR;
  // The camera family moves every pixel in the frame by itself, which is enough
  // to make two phases of one subject look different for a reason that has
  // nothing to do with the geometry. Same argument as morph.mjs's `--still`.
  director.switches.camera = false;
  // 35° rather than the default: these subjects are 4 cm to 70 cm across and
  // the frame is meant to be nearly full of one of them.
  director._baseFov = 35;
  // Flight replaces the whole vertical branch of the body — no gravity, no
  // floor, no collider push — which is the only way to put the eye 6 cm off the
  // ground and have it stay there.
  controller.fly = true;

  /**
   * Replace the uniform's `value` with an accessor the director cannot write.
   * The getter is what three's uniform upload reads, so the pinned number is
   * genuinely what the GPU sees; the setter swallows the director's write once
   * a frame instead of fighting it with a race.
   */
  const pin = (u, initial) => {
    let held = initial;
    Object.defineProperty(u, 'value', {
      configurable: true,
      get: () => held,
      set: () => {},
    });
    return (v) => {
      held = v;
    };
  };
  window.__rrPin = {
    phase: pin(tripUniforms.uBreathPhase, 0),
    amp: pin(tripUniforms.uBreathAmp, 0),
  };
});

/** Stand the eye at `dist` from the subject, at `eye` above it, looking at `aim`. */
async function frame(subject, at, eye) {
  return page.evaluate(
    ({ s, station, eyeY }) => {
      const { controller } = window.RR;
      const p = station;
      /**
       * The bearing to stand on. Down the object's own long axis when it has
       * one, and otherwise a fixed compass direction — fixed rather than random
       * so that `before` and `after` are the same photograph.
       */
      const dx = s.axis ? p.ax : 0.77;
      const dz = s.axis ? p.az : 0.64;
      const len = Math.hypot(dx, dz) || 1;
      const dist = p.reach + s.gap;
      const cx = p.x + (dx / len) * dist;
      const cz = p.z + (dz / len) * dist;
      controller.position.set(cx, p.y + eyeY, cz);
      controller.velocity.set(0, 0, 0);
      // The controller's yaw convention, copied from morph.mjs.
      controller.yaw = Math.atan2(p.x - cx, p.z - cz) + Math.PI;
      controller.pitch = Math.atan2(s.aim - eyeY, dist);
    },
    { s: subject, station: at, eyeY: eye }
  );
}

/**
 * The nearest loaded instance of a named layer: where it is, which way its own
 * X axis points, and how far its surface reaches from its origin along the
 * bearing the camera will stand on.
 */
async function findNearest(mesh, axis) {
  return page.evaluate(
    ({ name, alongAxis }) => {
      const { scene, controller } = window.RR;
      let best = null;
      scene.traverse((o) => {
        if (o.name !== name || !o.instanceMatrix) return;
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox;
        const m = o.instanceMatrix.array;
        for (let i = 0; i < o.count; i++) {
          const b = i * 16;
          const x = m[b + 12];
          const y = m[b + 13];
          const z = m[b + 14];
          const d = Math.hypot(x - controller.position.x, z - controller.position.z);
          if (best && d >= best.d) continue;
          // Column lengths of the upper 3x3 are the instance's own scale.
          const sx = Math.hypot(m[b + 0], m[b + 1], m[b + 2]);
          const sz = Math.hypot(m[b + 8], m[b + 9], m[b + 10]);
          const reach = alongAxis
            ? Math.max(Math.abs(bb.max.x), Math.abs(bb.min.x)) * sx
            : Math.max(Math.abs(bb.max.x) * sx, Math.abs(bb.max.z) * sz);
          best = { x, y, z, d, reach, ax: m[b + 0], az: m[b + 2] };
        }
      });
      return best;
    },
    { name: mesh, alongAxis: !!axis }
  );
}

for (const mode of ['sober', 'trip']) {
  await page.evaluate((m) => {
    const { director } = window.RR;
    if (m === 'trip') {
      director.seek(190);
      director.state.override = 1;
      director.eased = 1;
      window.__rrPin.amp(0.32);
    } else {
      director.state.override = 0;
      director.eased = 0;
      window.__rrPin.amp(0);
    }
  }, mode);
  await page.waitForTimeout(1400);

  for (const s of SUBJECTS) {
    const at = await findNearest(s.mesh, s.axis);
    if (!at) {
      process.stdout.write(`${mode}/${s.name}: NO INSTANCE LOADED\n`);
      continue;
    }
    for (const [view, eye] of [
      ['high', s.high],
      ['low', s.low],
    ]) {
      await frame(s, at, eye);
      // Long enough for the streamer to have the sector this eye is now in and
      // for the bucket packer to have submitted it. See `settling by frame
      // count lies` — this waits on wall-clock, not on a frame count.
      await page.waitForTimeout(900);
      const phases = mode === 'trip' ? PHASES : [0];
      for (let i = 0; i < phases.length; i++) {
        await page.evaluate((p) => window.__rrPin.phase(p), phases[i]);
        await page.waitForTimeout(220);
        await page.screenshot({ path: `${OUT}/${mode}-${s.name}-${view}-p${i}.png` });
      }
    }
    process.stdout.write(
      `${mode}/${s.name}: ${mode === 'trip' ? 8 : 2} frames at ` +
        `(${at.x.toFixed(1)}, ${at.z.toFixed(1)}) reach ${at.reach.toFixed(2)} m\n`
    );
  }
}

const frames = await page.evaluate(() => ({
  drawn: window.RR.renderer.info.render.frame,
  audioNaN: window.__rrAudioNaN,
}));
console.log(`\n${frames.drawn} frames rendered`);
if (frames.audioNaN) {
  console.log(
    `WARNING: ${frames.audioNaN} non-finite Web Audio parameter writes were swallowed. ` +
      `Something in src/audio is broken; the pictures are still good.`
  );
}

if (problems.length) {
  console.log(`\n${problems.length} console problem(s):`);
  for (const p of problems.slice(0, 12)) console.log(' ', p);
} else {
  console.log('\nno console problems');
}
console.log(`shots in ${OUT}`);

await browser.close();
