import { chromium } from 'playwright';

/**
 * Does fishing actually work?
 *
 * Every other check in this directory tests a thing you can see in one frame —
 * where the plants are, what the culler kept, whether the day is the same day.
 * Fishing is the first mechanic here with a state machine that can END BADLY,
 * and the interesting failures are all temporal: a bite that never arrives, a
 * fight that cannot be won, a fight that cannot be lost, a knock that is
 * indistinguishable from a take. None of those show up in a screenshot and all
 * of them are the difference between the activity being fun and being a slot
 * machine with extra steps.
 *
 * So this drives the whole loop, at speed, without a person:
 *
 *   THE READ   — that depth genuinely decides the species, by rolling four
 *                hundred fish in six inches of water and four hundred in the
 *                trench and printing both. If those two histograms are the same,
 *                the aim is decoration.
 *   THE CAST   — that the tackle is a projectile with a flight time, that how
 *                long you held the button is what sets the range, and therefore
 *                that a cast can be got WRONG: short of the channel, or in the
 *                grass on the other side.
 *   THE KNOCK  — that a false bite exists, and that striking one costs the fish.
 *   THE FIGHT  — all three endings. Won by winding and leaning, lost to a snap
 *                by winding through the runs, lost to slack by admiring it. And
 *                the gradient: that a middling fish forgives what a big one does
 *                not, because most of what comes out of this river is middling.
 *   THE FEET   — that the line is only so long. Backing slowly up the bank is
 *                allowed and running away parts it, which is the one rule in
 *                here about the player's body rather than their hands.
 *   THE CATCH  — that what you land comes out onto the grass at its real size
 *                and goes back on its own.
 *   THE SHOAL  — that there are fish in the river without a rod: only near the
 *                water, only in the channel, near enough the surface to be seen
 *                through it, and they scatter when something lands among them.
 *   THE NOISE  — that all eight one-shots fire through the wiring main.js
 *                actually hands the rod, and that every voice comes back.
 *   THE COST   — microseconds per frame inside `Fishing.update` with a fish on,
 *                because the whole thing was built under a promise that it would
 *                not show up in a frame budget.
 *
 * INPUTS ARE SYNTHETIC ON PURPOSE. Winding is `E` held, and the counter-steer is
 * a mouse that keeps moving for seconds at a time — neither survives being
 * driven through Playwright's real input queue (see `prefer synthetic clicks` in
 * the notes on this project). `controller.keys` is a Set and `controller.yaw` is
 * a number, so the honest way to hold a key for four seconds is to put the code
 * in the Set, which is precisely what the browser would have done.
 */

const URL_BASE = process.env.RR_URL ?? 'http://127.0.0.1:5180/';

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

// Deafen the page to hot reloads: a save landing mid-run re-evaluates modules
// under a script that is halfway through a measurement, and the failure is
// silent. Same reason play-check.mjs does it.
await page.routeWebSocket(/.*/, () => {});

await page.goto(URL_BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.RR !== undefined, { timeout: 45000 });
await page.click('#enter');
await page.waitForTimeout(2500);

const fails = [];
const ok = (cond, label, detail = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`);
  if (!cond) fails.push(label);
};

/* ---------------------------------------------------------------- the bank */

/**
 * Stand on the bank, facing the water.
 *
 * The river is somewhere between 24 and 62 m from the origin on a bearing this
 * world picked for itself, so it is found rather than assumed: sample a coarse
 * grid until `fishing.water` answers, then read the channel's own centre point
 * out of it and step back a chosen distance along the perpendicular.
 */
const bank = await page.evaluate(() => {
  const { fishing, controller } = window.RR;
  const at = (x, z) => {
    controller.position.x = x;
    controller.position.z = z;
    return fishing.water;
  };
  for (let r = 6; r <= 140; r += 6) {
    for (let a = 0; a < 64; a++) {
      const t = (a / 64) * Math.PI * 2;
      const w = at(Math.cos(t) * r, Math.sin(t) * r);
      if (w) return { x: w.bank.x, z: w.bank.z, angle: w.bank.angle };
    }
  }
  return null;
});
if (!bank) {
  console.error('no river found within 140 m of spawn');
  process.exit(1);
}

/**
 * Put the player `out` metres from the centre line, on the perpendicular, and
 * turn them to face it. Returns the distance from the eye to the centre so the
 * casts below can be aimed in metres rather than in radians.
 */
const stand = (out) =>
  page.evaluate(
    ([bx, bz, ang, dist]) => {
      const { controller } = window.RR;
      // Across the channel is the bearing rotated a quarter turn.
      const px = bx + Math.cos(ang + Math.PI / 2) * dist;
      const pz = bz + Math.sin(ang + Math.PI / 2) * dist;
      controller.position.x = px;
      controller.position.z = pz;
      // forward is (-sin yaw, -cos yaw); point it at the centre line.
      controller.yaw = Math.atan2(-(bx - px), -(bz - pz));
      return Math.hypot(bx - px, bz - pz);
    },
    [bank.x, bank.z, bank.angle, out]
  );

/** Point the head. Elevation is pitch + a fixed offset; see CAST_ELEVATION. */
const look = (pitch) =>
  page.evaluate((p) => {
    window.RR.controller.pitch = p;
    return p;
  }, pitch);

const peek = () =>
  page.evaluate(() => {
    const f = window.RR.fishing;
    return {
      state: f.state,
      dry: f._dry,
      knocks: f._knocks.length,
      catch: f._catch ? (f._catch.kind === 'fish' ? `${f._catch.name} ${f._catch.cm}cm` : 'curio') : null,
      power: f._catch?.power ?? null,
      tension: Number((f._tension ?? 0).toFixed(2)),
      stamina: Number(f._fish.stamina.toFixed(2)),
      lean: f.lean,
      lost: f.lost,
      book: f.book.length,
      lineOut: Number((f._lineOut ?? 0).toFixed(2)),
    };
  });

const rodOut = () => page.evaluate(() => window.RR.fishing.toggle());

/**
 * THROW IT, AND OWN THE CLOCK WHILE IT IS IN THE AIR.
 *
 * The cast is a real projectile now — a second or so of flight before anything
 * is decided — so a test that threw and then read the state would be reading a
 * tackle that is still eight metres up, and one that slept for a second would be
 * at the mercy of whatever frame rate swiftshader felt like. Same rule the fight
 * harness below spells out: the game's own loop lies about every result, so this
 * steps the simulation itself, at a fixed 1/60, inside one evaluate.
 *
 * Returns where it ended up and how long it was up there, both of which are the
 * point of the mechanic.
 */
const cast = (power = 0.55) =>
  page.evaluate((p) => {
    const f = window.RR.fishing;
    if (f.state === 'landed') f.act();
    if (f.state === 'loading' || f.state === 'flight' || f.state === 'playing') {
      f.stow();
      f.toggle();
    }
    if (f.state === 'waiting' || f.state === 'bite') f.act();
    if (f.state !== 'ready') return { thrown: false, state: f.state };
    const from = { x: f.controller.position.x, z: f.controller.position.z };
    if (!f._throw(p)) return { thrown: false, state: f.state };
    let steps = 0;
    while (f.state === 'flight' && steps < 900) {
      f.update(1 / 60);
      steps++;
    }
    return {
      thrown: true,
      steps,
      seconds: Number((steps / 60).toFixed(2)),
      state: f.state,
      dry: f._dry,
      distance: Number(Math.hypot(f._target.x - from.x, f._target.z - from.z).toFixed(2)),
      lineOut: Number(f._lineOut.toFixed(2)),
      catch: f._catch ? (f._catch.kind === 'fish' ? f._catch.name : 'curio') : null,
    };
  }, power);

/** Wind the whole thing back in and stand ready. */
const reelIn = () =>
  page.evaluate(() => {
    const f = window.RR.fishing;
    if (f.state === 'landed' || f.state === 'waiting' || f.state === 'bite') f.act();
    if (f.state !== 'ready' && f.state !== 'off') {
      f.stow();
      f.toggle();
    }
    return f.state;
  });

/* ------------------------------------------------------------- 1. the read */

console.log('\n— the read: does depth decide the species —');
const hist = await page.evaluate(
  ([bx, bz]) => {
    const f = window.RR.fishing;
    const roll = (depth) => {
      const counts = {};
      let curios = 0;
      for (let i = 0; i < 400; i++) {
        const got = f._roll(Math.random, { x: bx, z: bz }, depth);
        if (got.kind === 'curiosity') curios++;
        else counts[got.name] = (counts[got.name] ?? 0) + 1;
      }
      return { counts, curios };
    };
    return { margin: roll(0.2), trench: roll(1.3) };
  },
  [bank.x, bank.z]
);
const top = (h) =>
  Object.entries(h.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
console.log(`  0.2 m of water: ${top(hist.margin)}   (${hist.margin.curios} curiosities)`);
console.log(`  1.3 m of water: ${top(hist.trench)}   (${hist.trench.curios} curiosities)`);
const marginTop = Object.entries(hist.margin.counts).sort((a, b) => b[1] - a[1])[0][0];
const trenchTop = Object.entries(hist.trench.counts).sort((a, b) => b[1] - a[1])[0][0];
ok(marginTop !== trenchTop, 'shallow and deep water hold different fish', `${marginTop} vs ${trenchTop}`);
ok(
  (hist.trench.counts.pike ?? 0) > 0 && (hist.margin.counts.pike ?? 0) === 0,
  'pike are only in the trench',
  `trench ${hist.trench.counts.pike ?? 0}, margin ${hist.margin.counts.pike ?? 0}`
);
ok(
  hist.margin.curios > hist.trench.curios,
  'more junk in the margins than in the trench',
  `${hist.margin.curios} vs ${hist.trench.curios}`
);

/* ------------------------------------------------------------- 2. the cast */

/**
 * THE CAST IS A THROW, and these are the four things that has to mean.
 *
 * It is not "does a float appear in the water" — the old instant cast passed
 * that trivially, because it computed the landing point and put the float
 * there. What is being asserted here is that the tackle is a projectile with a
 * flight time, that the power in your hand is what sets the range, and that
 * consequently a cast can be got WRONG: too soft is short of the channel and the
 * wrong way round is in the grass. If the third row ever goes green while the
 * second goes red, the throw has quietly become a menu again.
 */
console.log('\n— the cast: a throw, with a flight and a distance you chose —');
const eyeToCentre = await stand(7.5);
await page.waitForTimeout(300);
await rodOut();
ok((await peek()).state === 'ready', 'rod comes out on the bank');

await look(0.05);
const soft = await cast(0.05);
await reelIn();
const hard = await cast(1);
ok(soft.thrown && hard.thrown, 'the rod throws');
ok(
  soft.steps > 12 && hard.steps > 12,
  'the tackle is actually in the air for a while',
  `${soft.seconds} s soft, ${hard.seconds} s hard`
);
ok(
  hard.distance > soft.distance + 2,
  'holding the button longer throws it further',
  `${soft.distance} m vs ${hard.distance} m`
);
await reelIn();

await look(0.05);
let s2 = await cast(0.35);
ok(!s2.dry && s2.state === 'waiting', 'a middling cast at the channel is wet', `${s2.distance} m — ${s2.catch}`);
ok(
  s2.lineOut > s2.distance * 0.8 && s2.lineOut < s2.distance + 3,
  'and the line off the reel matches how far it went',
  `${s2.lineOut} m of line for ${s2.distance} m`
);

// Turn round and throw it at the trees.
await reelIn();
await page.evaluate(() => {
  window.RR.controller.yaw += Math.PI;
});
const away = await cast(1);
ok(away.dry === true, 'a cast at the far bank lands dry', `${away.distance} m`);
await reelIn();

/* ------------------------------------------------------- 3. knock vs. bite */

console.log('\n— the knock: a false bite that costs you the fish —');
await stand(7.5);
await look(0.05);
/**
 * Cast until one comes back with knocks scheduled. They are a coin toss per
 * cast (zero to three), so a handful of attempts is plenty and a loop that
 * never terminates is a real failure worth reporting.
 */
let knocked = null;
for (let i = 0; i < 30 && !knocked; i++) {
  const thrown = await cast(0.35);
  if (thrown.state === 'waiting' && !thrown.dry) {
    const st = await peek();
    if (st.knocks > 0) knocked = st;
  }
  if (!knocked) await reelIn();
}
ok(knocked !== null, 'some casts come with knocks on them', knocked ? `${knocked.knocks} of them` : '');

if (knocked) {
  // Run the clock to the first knock, then strike into it.
  const struck = await page.evaluate(async () => {
    const f = window.RR.fishing;
    const wanted = f._knocks[0];
    const before = f._catch ? 1 : 0;
    // Advance to a hair past the knock's start without touching the real clock:
    // `_elapsed` is the only thing the knock window is measured against.
    f._elapsed = wanted + 0.05;
    f._knockUntil = f._knocks.shift() + 0.42;
    f.act();
    return { before, state: f.state, held: f._catch ? 1 : 0 };
  });
  ok(struck.before === 1 && struck.held === 0, 'striking a knock throws the fish away');
  ok(struck.state === 'ready', 'and puts you back to ready, not into a fight');
}

/* ------------------------------------------------------------ 4. the fight */

console.log('\n— the fight: three endings —');

/**
 * Hook a fish of a chosen strength and fight it to a conclusion, in ONE
 * uninterruptible block. Repeated `bouts` times.
 *
 * BOTH HALVES HAVE TO BE IN THE SAME `evaluate`, and finding out why cost the
 * first two runs of this file. The game's own loop is calling `Fishing.update`
 * as well, under swiftshader at a handful of frames a second — so between a
 * `hook()` evaluate and a `play()` evaluate the fight advanced by two or three
 * THIRD-OF-A-SECOND steps with no inputs applied at all, and every fish was
 * most of the way to throwing the hook before the test had pressed anything.
 * Fights were ending in under a second and the reason had nothing to do with
 * the fight. A synchronous `while` loop cannot be interleaved with the render
 * loop, so this owns the clock outright: fixed 1/60 steps, inputs applied
 * between them, and the same answer on any machine.
 *
 * The bite is forced rather than waited for: the roll happens at the cast and
 * the wait is up to twenty-two seconds, so a test that sat through it would take
 * ten minutes to cover four endings and would still be testing the dice.
 *
 * The policies:
 *   `idle`    — stand there admiring it.
 *   `wind`    — hold `E`, always, through everything.
 *   `play`    — what the prompt actually tells you to do: wind while it is
 *               resting, lean while it runs, never both. If this cannot land a
 *               fish then the game is unwinnable by somebody following its own
 *               instructions, which is the most important line in this file.
 *
 * The counter-steer is driven off the public `lean` field rather than off the
 * fish's heading, deliberately: a prompt that disagrees with the physics fails
 * this test, and that is a bug you would otherwise only find by losing fish and
 * not knowing why.
 */
const fight = (power, policy, seconds, bouts = 1, walk = 0) =>
  page.evaluate(
    ([p, mode, secs, count, bx, bz, walkSpeed]) => {
      const { fishing: f, controller: c } = window.RR;
      const step = 1 / 60;
      const limit = Math.round(secs / step);
      const out = { landed: 0, lost: 0, timedOut: 0, hooked: 0, frames: 0, micros: 0, longest: 0 };
      let spent = 0;

      for (let b = 0; b < count; b++) {
        /**
         * ---- hook it
         *
         * The float is PUT in the middle of the channel rather than thrown
         * there, and `_settle` is the real function that does it — the throw is
         * tested above, this block is about the fight, and flying sixty frames of
         * parabola before every one of forty bouts is a minute of nothing.
         *
         * `_lineOut` has to be set with it. It is a real quantity now and
         * `_settle` does not touch it, so a bout that inherited the 0.7 m the
         * spool is reset to would start with the float tethered under the rod
         * tip, get dragged onto the gravel by its own tether and lose the catch
         * before the strike — which is exactly what happened, and read as an
         * intermittent "2/3 hooked".
         */
        if (f.state === 'off') f.toggle();
        if (f.state === 'landed') f.act();
        if (f.state !== 'ready') {
          f.stow();
          f.toggle();
        }
        f._settle(bx, bz);
        f._lineOut = Math.max(6, Math.hypot(bx - c.position.x, bz - c.position.z) + 1.5);
        f._dry = false;
        f._knocks.length = 0;
        f._knockUntil = -1;
        f._elapsed = 99;
        f._catch = { kind: 'fish', name: 'pike', cm: 96, notable: true, power: p, hue: 0x556138 };
        f._timer = 0.001;
        f.state = 'waiting';
        f.update(0.02); // trips the clock into `bite`
        f.act(); // strike, inside the window
        if (f.state !== 'playing') continue;
        out.hooked++;

        // ---- fight it
        const book0 = f.book.length;
        const stood = { x: c.position.x, z: c.position.z };
        let frames = 0;
        const t0 = performance.now();
        while (f.state === 'playing' && frames < limit) {
          // `surge`, not `lean !== 0` — the two are not the same and confusing
          // them is what the prompt itself used to do. See fishing.js.
          const running = f.surge;
          const wind = mode === 'wind' || (mode === 'play' && !running);
          const turn = mode === 'play' && running && f.lean !== 0;
          if (wind) c.keys.add('KeyE');
          else c.keys.delete('KeyE');
          // `lean` is -1 for "sweep left", and increasing yaw IS left; see the
          // sign note in fishing.js.
          if (turn) c.yaw += f.lean < 0 ? 0.035 : -0.035;
          /**
           * And the feet, for the one policy that has any: straight back from
           * the water at a given speed. This is how the drag rule is measured —
           * `controller.update` is not run, so this is a body being teleported
           * exactly as it would be carried, which is all the rod can see.
           */
          if (walkSpeed) {
            const dx = c.position.x - bx;
            const dz = c.position.z - bz;
            const d = Math.hypot(dx, dz) || 1;
            c.position.x += (dx / d) * walkSpeed * step;
            c.position.z += (dz / d) * walkSpeed * step;
          }
          f.update(step);
          frames++;
        }
        spent += performance.now() - t0;
        c.keys.delete('KeyE');
        out.walked = Number(Math.hypot(c.position.x - stood.x, c.position.z - stood.z).toFixed(1));
        c.position.x = stood.x;
        c.position.z = stood.z;

        out.frames += frames;
        out.longest = Math.max(out.longest, frames * step);
        if (f.state === 'playing') {
          out.timedOut++;
          f.stow();
          f.toggle();
        } else if (f.book.length > book0) out.landed++;
        else {
          out.lost++;
          out[f.lastLoss] = (out[f.lastLoss] ?? 0) + 1;
          (out.why ??= []).push({
            how: f.lastLoss,
            at: Number((frames * step).toFixed(1)),
            stamina: Number(f._fish.stamina.toFixed(2)),
          });
        }
      }

      // Averaged over the whole batch, so the browser's deliberately coarse
      // `performance.now` quantisation washes out instead of dominating.
      out.micros = (spent * 1000) / Math.max(1, out.frames);
      out.seconds = (out.frames * step) / Math.max(1, out.hooked);
      return out;
    },
    [power, policy, seconds, bouts, bank.x, bank.z, walk]
  );

// (a) A fish you ignore throws the hook.
const idle = await fight(0.9, 'idle', 10, 3);
ok(idle.hooked === 3, 'striking a take starts a fight', `${idle.hooked}/3 hooked`);
ok(
  idle.lost === 3,
  'a fish you do nothing about gets off, every time',
  `${idle.lost} lost, ${idle.landed} landed, ${idle.timedOut} still on`
);

// (b) Winding straight through the runs breaks the line.
const greedy = await fight(0.95, 'wind', 25, 5);
ok(
  greedy.lost >= 4,
  'winding through a big fish’s runs loses it',
  `${greedy.lost}/5 lost, mean ${greedy.seconds.toFixed(1)} s`
);

/**
 * (c) Play it the way the prompt says and it comes in — five times out of five,
 * because one fight is one roll of the run clock and a policy that only works on
 * a lucky sequence is not a policy.
 *
 * The LENGTH is asserted too, and it is the specification rather than a feel:
 * fishing exists to be a thing you do WHILE talking, so a fight long enough to
 * stop the conversation has broken the activity even though every mechanic in it
 * is working perfectly.
 */
const proper = await fight(0.95, 'play', 60, 10);
ok(
  proper.landed >= 10,
  'playing it properly lands a 96 cm pike, every time',
  `${proper.landed}/10 — ${proper.snap ?? 0} snapped, ${proper.slack ?? 0} went slack`
);
/**
 * Printed only when something got away, and it is the first thing to read when
 * this row goes red: HOW a correctly-played fish was lost narrows the cause to
 * one half of the model immediately. Every tuning decision below the strike was
 * made by reading this line.
 */
if (proper.why) console.log(`  losses: ${JSON.stringify(proper.why)}`);
ok(proper.longest < 30, 'and no fight runs past half a minute', `longest ${proper.longest.toFixed(1)} s`);
console.log(`  (a big pike takes ${proper.seconds.toFixed(1)} s on average)`);

// (d) A small fish is not a fight. This is the one that protects the
//     specification: if a minnow takes twenty seconds, the activity has stopped
//     being a thing you do while talking to somebody.
const small = await fight(0.05, 'wind', 20, 4);
ok(small.landed === 4, 'a small fish comes straight in, with no leaning at all', `${small.landed}/4`);
ok(small.longest < 8, 'and takes under eight seconds', `longest ${small.longest.toFixed(1)} s`);

/**
 * (e) THE GRADIENT, which is the assertion that stops the fight from becoming a
 * skill gate on the whole activity.
 *
 * A middling fish — a decent perch, a chub — has to be landable by somebody who
 * is holding `E` and paying no attention whatsoever, because most of what comes
 * out of this river is middling and most of the time the player is talking to
 * somebody. If this row ever goes red at the same time as (b) stays green, the
 * discipline has stopped applying only to the fish that are worth it and has
 * started applying to all of them.
 */
const middling = await fight(0.35, 'wind', 30, 5);
ok(middling.landed >= 4, 'a middling fish forgives winding through its runs', `${middling.landed}/5`);
ok(middling.longest < 12, 'and is over inside twelve seconds', `longest ${middling.longest.toFixed(1)} s`);

/* --------------------------------------------------- 4b. the feet, and the
 * line that is between them and the fish                                    */

/**
 * WALKING AWAY IS NOW A THING YOU CAN DO WRONG, and this is the pair of rows
 * that says so.
 *
 * It is the one assertion in this file about the PLAYER'S BODY rather than about
 * the tackle, and it exists because the answer used to be "nothing happens". A
 * hooked pike and a player who turned round and jogged into the trees was not a
 * lost fish, a broken line or even a loaded rod — the two ends simply got
 * further apart on a line that stretched to fit.
 *
 * Both directions have to hold or the rule is not a rule. Backing up slowly is a
 * real angling move and has to stay free-ish; running is a snapped line. If the
 * first row goes red the price is too high and the bank has become a cage, and
 * if the second goes green the price is too low and it never existed.
 */
console.log('\n— the feet: the line is only so long —');
const stepBack = await fight(0.35, 'play', 30, 4, 0.9);
ok(
  stepBack.landed >= 3,
  'backing slowly up the bank while playing it is allowed',
  `${stepBack.landed}/4 landed, ${stepBack.lost} lost (${stepBack.snap ?? 0} snap, ${
    stepBack.slack ?? 0
  } slack), ${stepBack.timedOut} still on`
);
const bolted = await fight(0.95, 'play', 30, 4, 8.2);
ok(
  bolted.lost >= 3 && (bolted.snap ?? 0) >= 3,
  'running away from a big fish parts the line',
  `${bolted.lost}/4 lost, ${bolted.snap ?? 0} snapped`
);

/* ----------------------------------------------- 4c. the fish on the grass */

/**
 * The payoff, asserted as a physical fact rather than as a toast.
 *
 * A landed fish has to BE somewhere — on the ground, out of the water, at the
 * size the roll gave it, in front of the player — and it has to go back on its
 * own. The failure this catches is the one the feature was written to fix, and
 * it is completely invisible in a log: the mesh being switched off on the frame
 * the catch is announced, which is the exact moment it could first be seen.
 */
console.log('\n— the catch: it comes out onto the bank —');
const beach = await page.evaluate(([bx, bz]) => {
  const { fishing: f, controller: c } = window.RR;
  if (f.state === 'off') f.toggle();
  if (f.state !== 'ready') {
    f.stow();
    f.toggle();
  }
  f._settle(bx, bz);
  f._lineOut = 9;
  f._catch = { kind: 'fish', name: 'pike', cm: 96, notable: true, power: 0.4, hue: 0x556138 };
  f._elapsed = 99;
  f._timer = 0.001;
  f.state = 'waiting';
  f.update(0.02);
  f.act();
  // Beat it, then bring it the last two metres.
  for (let i = 0; i < 3600 && f.state === 'playing'; i++) {
    c.keys.add('KeyE');
    f._fish.stamina = 0;
    f.update(1 / 60);
  }
  c.keys.delete('KeyE');
  if (f.state !== 'landed') return { state: f.state };
  const at = { x: f.fish.position.x, y: f.fish.position.y, z: f.fish.position.z };
  const size = f.fish.scale.x;
  const ahead =
    (at.x - c.position.x) * -Math.sin(c.yaw) + (at.z - c.position.z) * -Math.cos(c.yaw);
  // Run the clock out and watch it go back.
  let held = 0;
  while (f.state === 'landed' && held < 900) {
    f.update(1 / 60);
    held++;
  }
  return {
    state: 'landed',
    visible: true,
    at,
    size,
    ahead: Number(ahead.toFixed(2)),
    aboveWater: Number((at.y - -3.4).toFixed(2)),
    heldFor: Number((held / 60).toFixed(1)),
    after: f.state,
    stillDrawn: f.fish.visible,
  };
}, [bank.x, bank.z]);
if (beach.state !== 'landed') {
  ok(false, 'a beaten fish is landed onto the bank', `ended in ${beach.state}`);
} else {
  ok(true, 'a beaten fish is landed onto the bank');
  ok(beach.aboveWater > 0, 'it is out of the water', `${beach.aboveWater} m above the surface`);
  ok(beach.ahead > 0.6, 'it is in front of you, where you could look at it', `${beach.ahead} m ahead`);
  ok(
    Math.abs(beach.size - 0.96) < 0.01,
    'and it is drawn at the length the toast claims',
    `${(beach.size * 100).toFixed(0)} cm`
  );
  ok(
    beach.heldFor > 3 && beach.heldFor < 9,
    'it lies there for a few seconds and then goes back',
    `${beach.heldFor} s`
  );
  ok(beach.after === 'ready' && !beach.stillDrawn, 'and the rod is ready again');
}

/* ------------------------------------------------ 4d. the fish in the river */

/**
 * THE SHOAL, which is the other half of "there are fish here".
 *
 * Four properties, and they are the four that make it a river rather than a
 * particle system: it is only alive near the water, every fish is IN the
 * channel, they are near enough to the surface to be seen through it, and they
 * react to something landing among them. The third is the one that decides
 * whether any of this was worth building — the water is a 0.9-alpha sheet, so a
 * shoal that settles half a metre down is a shoal nobody will ever see.
 */
console.log('\n— the shoal: fish you can see without a rod —');
const shoal = await page.evaluate(([bx, bz]) => {
  const { shoal: s, controller: c } = window.RR;
  const back = { x: c.position.x, z: c.position.z };
  // Stand well away from any water and let it settle.
  c.position.x = bx + 400;
  c.position.z = bz + 400;
  for (let i = 0; i < 5; i++) s.update(1 / 60, c.position);
  const asleep = { awake: s.active, visible: s.mesh.visible };

  c.position.x = back.x;
  c.position.z = back.z;
  for (let i = 0; i < 120; i++) s.update(1 / 60, c.position);

  const m = s.mesh.instanceMatrix.array;
  const near = [];
  for (let i = 0; i < s.count; i++) {
    near.push({ x: m[i * 16 + 12], y: m[i * 16 + 13], z: m[i * 16 + 14] });
  }
  const depths = near.map((p) => -3.4 - p.y);
  const shallow = depths.filter((d) => d < 0.5).length;
  const surfacing = depths.filter((d) => d < 0.12).length;
  const inWater = near.filter((p) => Math.hypot(p.x - bx, p.z - bz) < 400).length;

  // And a splash among them.
  const target = near.reduce((a, p) =>
    Math.hypot(p.x - c.position.x, p.z - c.position.z) <
    Math.hypot(a.x - c.position.x, a.z - c.position.z)
      ? p
      : a
  );
  const before = { x: target.x, z: target.z };
  s.startle(target.x, target.z, 6, 1);
  for (let i = 0; i < 60; i++) s.update(1 / 60, c.position);
  let moved = 0;
  const after = s.mesh.instanceMatrix.array;
  for (let i = 0; i < s.count; i++) {
    const d = Math.hypot(after[i * 16 + 12] - near[i].x, after[i * 16 + 14] - near[i].z);
    const from = Math.hypot(near[i].x - before.x, near[i].z - before.z);
    if (from < 6 && d > 0.6) moved++;
  }
  const bolted = near.filter((p) => Math.hypot(p.x - before.x, p.z - before.z) < 6).length;
  return { asleep, count: s.count, shallow, surfacing, inWater, moved, bolted };
}, [bank.x, bank.z]);
ok(
  !shoal.asleep.awake && !shoal.asleep.visible,
  'four hundred metres from the river there is no shoal at all',
  'and no loop running either'
);
ok(shoal.inWater === shoal.count, 'every fish is in the channel', `${shoal.inWater}/${shoal.count}`);
ok(
  shoal.shallow >= shoal.count * 0.7,
  'and near enough the surface to be seen through it',
  `${shoal.shallow}/${shoal.count} in the top half-metre, ${shoal.surfacing} breaking it`
);
ok(
  shoal.bolted === 0 || shoal.moved >= Math.ceil(shoal.bolted * 0.6),
  'a splash among them scatters them',
  `${shoal.moved}/${shoal.bolted} within six metres bolted`
);

/* ------------------------------------------------------------ 5. the noise */

/**
 * Every one of the rod's one-shots, fired through the real wiring, and then the
 * voice counter checked back to where it started.
 *
 * `audio-probe.mjs` cannot do this. It measures the master bus across a stage,
 * and eight events that each leak one oscillator are completely inaudible in a
 * spectrum and completely fatal by the four hundredth cast — the ceiling in
 * `ambience.js` fills up and the forest goes quiet, with nothing in any log to
 * say why. So this goes through `fishing.sound`, the callback main.js actually
 * hands the rod, rather than through the module directly: a sound that works
 * but is not plumbed in is the same bug to a player.
 */
console.log('\n— the noise —');
const noise = await page.evaluate(async () => {
  const { fishing: f, ambience: a } = window.RR;
  if (!a?.built) return { skipped: true };
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  /**
   * WAIT FOR A QUIET MOMENT FIRST, and this is not politeness.
   *
   * `ambience` gates every event on its own voice ceiling, so firing into a
   * forest that happens to have a frog, a gust and four birds in the air is
   * firing into a closed door — the first run of this reported "the rod makes
   * no sound" because the counter was sitting at 35 against a ceiling of 34,
   * which is the layer working correctly and the test measuring the wrong
   * second.
   */
  for (let i = 0; i < 40 && a.voices > 8; i++) await nap(120);
  const at = { x: f._target.x, y: -3.4, z: f._target.z };
  const before = a.voices;
  const kinds = ['cast', 'knock', 'bite', 'strike', 'reel', 'strain', 'snap', 'splash'];
  let peak = before;
  for (const k of kinds) {
    for (let i = 0; i < 2; i++) f.sound(k, at, 0.3 + i * 0.5);
    peak = Math.max(peak, a.voices);
  }
  // Longer than the longest of them, which is `splash` at 0.7 s of life.
  await nap(1800);
  return { skipped: false, before, peak, after: a.voices, kinds: kinds.length };
});
if (noise.skipped) {
  console.log('  (no audio context in this run — the gate was never opened)');
} else {
  console.log(`  16 one-shots across ${noise.kinds} kinds: ${noise.before} voices -> ${noise.peak} -> ${noise.after}`);
  ok(noise.peak > noise.before, 'the rod actually makes a sound', `peaked at ${noise.peak}`);
  ok(noise.after <= noise.before + 1, 'and gives every voice back', `${noise.before} -> ${noise.after}`);
}

/* ------------------------------------------------------------- 6. the cost */

console.log('\n— the cost —');
/**
 * Measured over thousands of steps rather than one fight, and re-hooking
 * whenever a fish is landed or lost, for two reasons. The browser's
 * `performance.now` is deliberately coarse — quantised to about a tenth of a
 * millisecond — so timing a hundred individual `update` calls measures the clock
 * rather than the code. And a single fight is a single path through the run
 * clock; this walks a few dozen of them.
 */
const cost = await fight(0.95, 'play', 60, 10);
const perFrame = cost.micros;
console.log(`  Fishing.update with a fish on: ${perFrame.toFixed(1)} µs a frame over ${cost.frames} steps`);
/**
 * 60 µs is a third of a percent of a 16.6 ms frame and roughly ten times what
 * this arithmetic should cost, so it is a ceiling that catches an ACCIDENT — a
 * stray allocation, a `heightAt` finding its way into the frame loop — rather
 * than a tuning threshold anybody has to maintain. It is also measured under
 * swiftshader, which is slower than any real machine this will run on.
 */
ok(perFrame < 60, 'the fight costs under 60 µs a frame', `${perFrame.toFixed(1)} µs`);

/**
 * And the shoal, which is the one part of this feature that runs whether or not
 * anybody is fishing — so it is the one with a claim to defend on every frame of
 * every session spent anywhere near the river.
 *
 * Both numbers matter and they are different questions. AWAKE is what a player
 * stood on the bank pays. ASLEEP is what everybody else pays, everywhere else in
 * a world 768 m across, and it had better be a rounding error: one
 * `streamPointNear` and a compare, which is the whole of the distance gate at
 * the top of `Shoal.update`.
 */
const shoalCost = await page.evaluate(([bx, bz]) => {
  const { shoal: s, controller: c } = window.RR;
  const run = (n) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) s.update(1 / 60, c.position);
    return ((performance.now() - t0) * 1000) / n;
  };
  const back = { x: c.position.x, z: c.position.z };
  run(200); // wake and settle before the clock starts
  const awake = run(3000);
  c.position.x = bx + 500;
  c.position.z = bz + 500;
  run(20);
  const asleep = run(3000);
  c.position.x = back.x;
  c.position.z = back.z;
  return { awake, asleep };
}, [bank.x, bank.z]);
console.log(
  `  Shoal.update: ${shoalCost.awake.toFixed(1)} µs a frame at the river, ` +
    `${shoalCost.asleep.toFixed(2)} µs everywhere else`
);
ok(shoalCost.awake < 60, 'the shoal costs under 60 µs a frame at the water', `${shoalCost.awake.toFixed(1)} µs`);
ok(
  shoalCost.asleep < 2,
  'and effectively nothing away from it',
  `${shoalCost.asleep.toFixed(2)} µs`
);

await page.evaluate(() => window.RR.fishing.stow());

/* ------------------------------------------------------------------ report */

if (errors.length) {
  console.log('\npage errors:');
  for (const e of errors.slice(0, 10)) console.log(`  ${e}`);
}
console.log('');
if (fails.length || errors.length) {
  console.error(`FAILED: ${[...fails, ...errors.slice(0, 3)].join(' | ')}`);
  await browser.close();
  process.exit(1);
}
console.log('fishing: all good');
await browser.close();
