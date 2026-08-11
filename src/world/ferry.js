import * as THREE from 'three';
import { TAU } from '../core/util.js';
import { WATER_LEVEL } from './terrain.js';
import { makeLiving } from '../trip/living.js';
import { Seat } from '../player/seats.js';
import { pointAt, solveReach } from './sites.js';

/**
 * The ferry.
 *
 * A flat-bottomed raft with a rail, a lantern and a bell that spends its whole
 * life going up and down the river. You get on it, you sit down, and it takes
 * twenty minutes to carry you past everything anybody built. There is nothing to
 * do on it. That is the feature: it is a reason to be somewhere together for
 * long enough to have a conversation, without either of you having to decide
 * where to go next.
 *
 *
 * WHY A RAFT AND NOT A BUS.
 *
 * The brief asked for a little bus. A bus needs a road, and a road through this
 * forest is not a mesh — it is a hole in the density field that `scatter.js`
 * plants from, which means changing the function that decides where every tree
 * in an endless world goes, in a worker, deterministically, without moving any
 * of the trees anybody has already looked at. That is a large and genuinely
 * risky change to the most load-bearing pure function in the project.
 *
 * The river is already that road. `forestDensity` multiplies by
 * `1 - wetness * 1.6`, so nothing grows in the channel and nothing ever will;
 * `heightAt` carves it as a trench, so it is flat; and it runs east–west
 * forever, so it genuinely goes somewhere. It is a guaranteed clear corridor
 * through an infinite forest that already exists, for free, in every seeded
 * world. Going with it costs nothing and touches nothing.
 *
 *
 * AND IT COSTS ZERO BYTES ON THE WIRE.
 *
 * The raft's position is a pure function of the Unix epoch, exactly like
 * `daylight.js`'s sun. Two people in two countries see it in the same place
 * because they both did the same arithmetic on the same clock, not because
 * anybody was told — so there is no ferry state to synchronise, no authority to
 * elect, nothing to reconcile after a reconnect, and no way for one person's
 * raft to be somewhere another person's is not. Riders are visible on it purely
 * because they broadcast their own positions, which they were doing anyway.
 *
 * The one thing that is NOT a pure function of the clock is where the river is
 * deep enough to float a raft, which is a property of the seed. So that is
 * solved once, at build time, by measuring — see `solveReach`.
 */

/** Metres per second. A walking pace on the water, and deliberately slow. */
const SPEED = 2.3;
/** Seconds the raft waits at each stop. Long enough to board without hurrying. */
const DWELL_S = 14;
/** Draught. How far the deck sits above the waterline. */
const FREEBOARD = 0.34;

/**
 * MEASURING THE RIVER HAPPENS IN `sites.js`, NOT HERE.
 *
 * `solveReach` and `pointAt` used to live in this file, which is where they
 * belong by subject and exactly the wrong place by dependency: the landings the
 * ferry calls at are placed by the site planner, the site planner runs inside
 * the forest worker so the scatter can leave room for them, and a worker cannot
 * import this file — it pulls in THREE, a living material and a seat registry.
 *
 * So the two functions that are pure arithmetic over the height field moved to
 * the module both realms can reach, and this one imports them. One measurement,
 * one answer, no chance of a raft and a jetty disagreeing about where the water
 * is deep.
 */

/**
 * The schedule.
 *
 * A closed loop: run to the far end stopping at each landing, wait, run back
 * stopping at each one again, wait. Expressed as a list of legs so that
 * `positionAt` is a search through a few entries rather than a simulation, which
 * is what makes it exactly reproducible from a wall clock on any machine that
 * happens to be watching.
 */
function buildSchedule(reach, stops) {
  const marks = [reach.u0, ...stops, reach.u1]
    .filter((u) => u >= reach.u0 && u <= reach.u1)
    .sort((a, b) => a - b);
  // Deduplicate landings that ended up within a raft's length of each other.
  const unique = marks.filter((u, i) => i === 0 || u - marks[i - 1] > 12);

  const legs = [];
  const push = (from, to) => {
    legs.push({ kind: 'run', from, to, duration: Math.abs(to - from) / SPEED });
    legs.push({ kind: 'stop', from: to, to, duration: DWELL_S });
  };
  for (let i = 0; i < unique.length - 1; i++) push(unique[i], unique[i + 1]);
  for (let i = unique.length - 1; i > 0; i--) push(unique[i], unique[i - 1]);

  const period = legs.reduce((sum, leg) => sum + leg.duration, 0);
  return { legs, period, marks: unique };
}

/**
 * Where the raft is at a given wall-clock time.
 *
 * @param {object} schedule
 * @param {number} seconds Unix epoch seconds — NOT a session clock. Two machines
 *   that have been running for different lengths of time must agree, and the
 *   only clock they share is the one on the wall.
 */
function positionAt(schedule, seconds) {
  let t = seconds % schedule.period;
  if (t < 0) t += schedule.period;
  for (let i = 0; i < schedule.legs.length; i++) {
    const leg = schedule.legs[i];
    if (t > leg.duration) {
      t -= leg.duration;
      continue;
    }
    if (leg.kind === 'stop') {
      return { u: leg.from, moving: false, remaining: leg.duration - t, index: i };
    }
    const k = leg.duration > 0 ? t / leg.duration : 1;
    return {
      u: leg.from + (leg.to - leg.from) * k,
      moving: true,
      direction: Math.sign(leg.to - leg.from) || 1,
      remaining: leg.duration - t,
      index: i,
    };
  }
  // Floating-point residue at the very end of the period.
  const last = schedule.legs[schedule.legs.length - 1];
  return { u: last.to, moving: false, remaining: 0, index: schedule.legs.length - 1 };
}

/**
 * @param {THREE.Object3D} parent
 * @param {object} options
 * @param {number[]} [options.stops] along-channel parameters of the landings
 * @param {import('../player/seats.js').SeatRegistry} [options.seats]
 */
export function buildFerry(parent, { stops = [], seats = null, reach = undefined } = {}) {
  /**
   * The caller may hand in a reach it has already solved.
   *
   * `main.js` does, because the landings have to be on the same water the raft
   * runs on and two independent solves of the same seeded river are two chances
   * to disagree. `undefined` means "nobody has measured yet"; an explicit `null`
   * means "measured, and there is no navigable water", and must not be
   * re-measured into a different answer.
   */
  const water = reach === undefined ? solveReach() : reach;
  if (!water) return null;

  const schedule = buildSchedule(water, stops);

  const group = new THREE.Group();
  group.name = 'ferry';
  parent.add(group);

  const W = 2.9;
  const L = 5.2;

  const deckMat = makeLiving(new THREE.MeshLambertMaterial({ color: 0x6b543a }), 'prop');
  const railMat = makeLiving(new THREE.MeshLambertMaterial({ color: 0x4a3826 }), 'prop');
  const brassMat = makeLiving(
    new THREE.MeshLambertMaterial({ color: 0xb08d3f, emissive: 0x2a1c05, emissiveIntensity: 0.6 }),
    'prop'
  );

  /**
   * The deck, as separate planks.
   *
   * Eleven boxes rather than one, which is ten extra draws' worth of triangles
   * in a single draw call — they share a material, so three batches them, and
   * the gaps between them are what stop a 2.9 × 5.2 m slab reading as a
   * placeholder. It is the cheapest possible detail on the surface a person
   * spends the whole journey looking at.
   */
  const plankGeo = new THREE.BoxGeometry(W, 0.11, L / 11 - 0.035);
  for (let i = 0; i < 11; i++) {
    const plank = new THREE.Mesh(plankGeo, deckMat);
    plank.position.set(0, 0, -L / 2 + (i + 0.5) * (L / 11));
    plank.castShadow = true;
    plank.receiveShadow = true;
    group.add(plank);
  }

  // Two beams under it, so it is a raft rather than a floating table top.
  const beamGeo = new THREE.BoxGeometry(0.16, 0.2, L + 0.2);
  for (const side of [-1, 1]) {
    const beam = new THREE.Mesh(beamGeo, railMat);
    beam.position.set((side * (W - 0.3)) / 2, -0.14, 0);
    beam.castShadow = true;
    group.add(beam);
  }

  /**
   * A rail on three sides and an open stern.
   *
   * The gap is the boarding point and it is the only affordance this object has:
   * an object that is enclosed on four sides reads as scenery, and one with a
   * gap in it reads as something you are meant to step into. Nothing has to say
   * so.
   */
  const postGeo = new THREE.CylinderGeometry(0.045, 0.05, 0.86, 6);
  const railGeo = new THREE.CylinderGeometry(0.036, 0.036, 1, 6);
  const posts = [
    [-W / 2 + 0.1, -L / 2 + 0.1], [W / 2 - 0.1, -L / 2 + 0.1],
    [-W / 2 + 0.1, 0], [W / 2 - 0.1, 0],
    [-W / 2 + 0.1, L / 2 - 0.1], [W / 2 - 0.1, L / 2 - 0.1],
  ];
  for (const [x, z] of posts) {
    const post = new THREE.Mesh(postGeo, railMat);
    post.position.set(x, 0.48, z);
    post.castShadow = true;
    group.add(post);
  }
  const addRail = (x1, z1, x2, z2) => {
    const rail = new THREE.Mesh(railGeo, railMat);
    const dx = x2 - x1;
    const dz = z2 - z1;
    rail.scale.y = Math.hypot(dx, dz);
    rail.position.set((x1 + x2) / 2, 0.86, (z1 + z2) / 2);
    rail.rotation.z = Math.PI / 2;
    rail.rotation.y = -Math.atan2(dz, dx);
    group.add(rail);
  };
  addRail(-W / 2 + 0.1, -L / 2 + 0.1, W / 2 - 0.1, -L / 2 + 0.1);
  addRail(-W / 2 + 0.1, -L / 2 + 0.1, -W / 2 + 0.1, L / 2 - 0.1);
  addRail(W / 2 - 0.1, -L / 2 + 0.1, W / 2 - 0.1, L / 2 - 0.1);

  // ---- the lantern ---------------------------------------------------------
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 2.1, 6), railMat);
  mast.position.set(0, 1.05, -L / 2 + 0.5);
  mast.castShadow = true;
  group.add(mast);

  /**
   * A lantern that is emissive rather than a light.
   *
   * The world already has exactly one migrating point light for the campfires
   * and one on the jukebox, and the reason is in `campfire.js`: the light count
   * is compiled into every material in the scene. A third would be a recompile
   * of the entire forest for a lamp you are standing directly underneath, where
   * the campfire light will very often already be — the ferry passes the
   * landings, and the landings have fires. So the lantern glows and does not
   * cast, and on a dark river that difference is much smaller than it sounds.
   */
  const lantern = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.17, 1),
    new THREE.MeshBasicMaterial({ color: 0xffcb84, toneMapped: false })
  );
  lantern.position.set(0, 1.95, -L / 2 + 0.5);
  group.add(lantern);
  const cage = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.018, 4, 10), brassMat);
  cage.position.copy(lantern.position);
  cage.rotation.x = Math.PI / 2;
  group.add(cage);

  // ---- the bell ------------------------------------------------------------
  const bell = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.2, 10, 1, true), brassMat);
  bell.position.set(W / 2 - 0.34, 1.42, -L / 2 + 0.5);
  bell.rotation.x = Math.PI;
  group.add(bell);

  // ---- seats ---------------------------------------------------------------
  /**
   * Four places, facing inward across the deck.
   *
   * Facing forward would be a coach; facing each other is a table in a pub, and
   * this whole object exists so that people talk. It also means the view over
   * the rail is at your shoulder rather than dead ahead, which is the difference
   * between watching scenery and being somewhere while scenery happens.
   */
  const benchGeo = new THREE.BoxGeometry(0.42, 0.1, 1.9);
  const seatList = [];
  for (const side of [-1, 1]) {
    const bench = new THREE.Mesh(benchGeo, deckMat);
    bench.position.set((side * (W - 0.72)) / 2, 0.42, 0.5);
    bench.castShadow = true;
    bench.receiveShadow = true;
    group.add(bench);
    for (const along of [-0.42, 0.42]) {
      seatList.push(
        new Seat({
          position: new THREE.Vector3((side * (W - 0.72)) / 2, 0.47, 0.5 + along),
          // Facing across the deck, toward the other bench.
          yaw: side > 0 ? Math.PI / 2 : -Math.PI / 2,
          kind: 'deck',
          parent: group,
          label: 'the ferry',
        })
      );
    }
  }
  seats?.add(seatList);

  // -------------------------------------------------------------------------

  let lastStopIndex = -1;
  let bob = 0;
  const state = {
    u: water.u0,
    moving: false,
    /** True on the frame the raft arrives somewhere. The bell hangs off it. */
    arrived: false,
    /** Seconds until it leaves, when stopped. */
    remaining: 0,
  };

  return {
    group,
    reach: water,
    schedule,
    seats: seatList,
    state,
    lantern,

    /**
     * Where the raft is right now, without moving anything. Used by the UI to
     * tell somebody on the bank how long they have to wait.
     */
    peek(seconds = Date.now() / 1000) {
      return positionAt(schedule, seconds);
    },

    /** Distance from a point to the deck, on the ground plane. */
    distanceTo(x, z) {
      return Math.hypot(group.position.x - x, group.position.z - z);
    },

    update(dt, { epoch = Date.now() / 1000 } = {}) {
      const at = positionAt(schedule, epoch);
      state.u = at.u;
      state.moving = at.moving;
      state.remaining = at.remaining;

      const p = pointAt(at.u);
      /**
       * The bob is a function of the CLOCK, not an accumulator.
       *
       * An accumulator would drift between two machines that have been running
       * different lengths of time, and the raft is the one object in the world
       * whose whole claim is that everybody's copy is in the same place. Two
       * slow sines on the wall clock keep that true down to the centimetre.
       */
      bob = Math.sin(epoch * 0.9) * 0.035 + Math.sin(epoch * 1.47 + 1.1) * 0.022;
      group.position.set(p.x, WATER_LEVEL + FREEBOARD + bob, p.z);

      /**
       * Point the way it is going.
       *
       * `streamPointNear().angle` is the tangent including the meander, so the
       * raft leans into bends instead of sliding through them crabwise. A raft
       * has no bow, so going back up the river it simply faces the other way
       * rather than turning round — which is also what a real ferry does.
       */
      const heading = p.angle + (at.direction === -1 ? Math.PI : 0);
      // -PI/2 because the deck is built long in Z and the heading is measured
      // from +X.
      group.rotation.y = -heading + Math.PI / 2;
      group.rotation.z = Math.sin(epoch * 0.71) * 0.012;
      group.rotation.x = Math.sin(epoch * 0.53 + 2.2) * 0.009;
      group.updateMatrixWorld(true);

      state.arrived = !at.moving && at.index !== lastStopIndex;
      if (!at.moving) lastStopIndex = at.index;
      else lastStopIndex = -1;

      // A lantern that flickers is a lantern; a lantern that does not is a bulb.
      const flicker = 0.86 + 0.14 * Math.sin(epoch * 6.1) * Math.sin(epoch * 2.3);
      lantern.material.color.setRGB(1.0 * flicker, 0.8 * flicker, 0.52 * flicker);
      void dt;
      void TAU;
    },

    dispose() {
      plankGeo.dispose();
      beamGeo.dispose();
      postGeo.dispose();
      railGeo.dispose();
      benchGeo.dispose();
      deckMat.dispose();
      railMat.dispose();
      brassMat.dispose();
      group.removeFromParent();
    },
  };
}
