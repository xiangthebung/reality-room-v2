import * as THREE from 'three';
import { clamp01, makeRng, wrapAngle } from '../core/util.js';
import { WATER_LEVEL, heightAt, streamPointNear } from './terrain.js';
import { daylightAt } from './daylight.js';
import { makeLiving } from '../trip/living.js';

/**
 * The fish that are already in the river.
 *
 * WHY THIS EXISTS AT ALL, WHEN THERE WAS ALREADY A FISHING ROD.
 *
 * Because the river was empty. `fishing.js` rolls a species out of a table at
 * the moment of the cast and shows you a mesh for the last three seconds of the
 * fight — which is the correct design for the CATCH and is a terrible one for
 * the PLACE. A stretch of water with nothing visible in it is a texture, and
 * the whole read the rod is built on ("minnows in the margin, pike in the
 * trench") was a fact the player could only ever learn from a toast. Now it is
 * a fact they can lean over the bank and SEE, which is the same information
 * arriving through the window everything else in this project arrives through.
 *
 * It is also the cheapest possible way to make the river worth standing next to
 * when you are not fishing, which is most of the time.
 *
 *
 * THE HARD PART IS NOT THE FISH, IT IS THE WATER ON TOP OF THEM.
 *
 * The surface is `vec4(col, 0.9)` with a fresnel blend to sky (see `buildWater`
 * in atmosphere.js), so a fish half a metre down is showing you one part in ten
 * of itself through a sheet that is mostly reflected sky — that is not "dimly
 * visible", it is invisible, and it is the exact trap the caught fish's own
 * depth numbers were written to avoid. Three things answer it, and none of them
 * touches the water shader:
 *
 *   SHALLOW. The shoal lives in the top 40 cm, not the middle of the channel.
 *   Looking down into water from a bank is the one angle where the fresnel term
 *   collapses and the surface goes clear, so a fish near the top is legible from
 *   exactly the posture somebody stood on a bank is already in.
 *
 *   RISES. A fish that comes up to the film, holds there with its back out for a
 *   second and slides down again is unmistakable — it is a moving edge in a
 *   surface that has none. That single behaviour does more for "there are fish
 *   here" than doubling the count would.
 *
 *   JUMPS. Rare, loud, and entirely out of the water, so nothing is in front of
 *   them at all. One every ten seconds or so somewhere in earshot.
 *
 *
 * WHAT IT COSTS.
 *
 * One draw call and 36 instances of a 30-triangle fish — about eleven hundred
 * triangles, next to nothing, and both are skipped entirely by the distance gate
 * in `update`: more than SLEEP_M from the channel and the mesh is invisible and
 * the loop does not run, which is true of everywhere in this world except a
 * strip about a hundred metres wide.
 *
 * No allocation per frame, no `heightAt` per frame — the bed is sampled once
 * when a fish is RECYCLED, which happens when the player has walked far enough
 * to leave one behind, and never from the frame loop.
 */

/**
 * A fish, one metre long, pointing down +x.
 *
 * MOVED HERE FROM fishing.js, WHICH IS NOW A CONSUMER RATHER THAN THE OWNER.
 * Two features draw the same animal and only one of them is an activity; a
 * player who never picks up a rod should not be depending on the rod's module
 * for the fish in the river. The geometry is unchanged.
 *
 * BUILT BY HAND RATHER THAN TAKEN FROM A PRIMITIVE, because the one thing it has
 * to do is not look like a capsule. Four stations down the body and four radial
 * spokes at each — the cross-section is a diamond that is TALLER THAN IT IS
 * WIDE, which is the single cue that separates a fish from a sausage when it is
 * a dark shape under sixty centimetres of moving water. A sphere scaled flat
 * gets the silhouette and loses the ridge along the back; this keeps both for
 * twenty-six triangles.
 *
 * THE TAIL IS BACKED WITH TWO MORE TRIANGLES RATHER THAN WITH `DoubleSide`.
 *
 * It is a flat fin and it is seen from both sides, so it needs a back either
 * way. Doing it with a material flag would have been one line — and would have
 * given the fish a program cache key of its own, which means the first fish of
 * the session compiles a shader while it is moving, i.e. a hitch at the exact
 * moment it is meant to be noticed. Backed in geometry, the material is
 * bit-for-bit the rod's and reuses its program. The four extra vertices are
 * duplicates rather than a reversed winding through the same ones, because
 * `computeVertexNormals` averages by index and shared vertices between two
 * opposed faces average to nothing at all.
 */
export function fishGeometry() {
  // x from nose to wrist, with the half-height and half-width there.
  const stations = [
    { x: 0.5, h: 0, w: 0 },
    { x: 0.24, h: 0.15, w: 0.085 },
    { x: -0.08, h: 0.13, w: 0.07 },
    { x: -0.34, h: 0.045, w: 0.025 },
  ];
  const pos = [];
  // Nose, then three rings of four: up, right, down, left.
  pos.push(stations[0].x, 0, 0);
  for (let s = 1; s < stations.length; s++) {
    const st = stations[s];
    pos.push(st.x, st.h, 0, st.x, 0, st.w, st.x, -st.h, 0, st.x, 0, -st.w);
  }
  const wrist = pos.length / 3;
  pos.push(-0.4, 0, 0);

  const idx = [];
  const ring = (s) => 1 + (s - 1) * 4;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    idx.push(0, ring(1) + i, ring(1) + j);
    for (let s = 1; s < 3; s++) {
      const a = ring(s);
      const b = ring(s + 1);
      idx.push(a + i, b + i, b + j, a + i, b + j, a + j);
    }
    idx.push(ring(3) + j, ring(3) + i, wrist);
  }

  /**
   * A flat fin, backed. Points must be given in the order that winds the front
   * face; the duplicates are pushed separately and wound the other way, because
   * `computeVertexNormals` averages by index and two opposed faces sharing
   * vertices average to nothing at all.
   */
  const fin = (...points) => {
    const front = pos.length / 3;
    for (const p of points) pos.push(p[0], p[1], p[2]);
    const back = pos.length / 3;
    for (const p of points) pos.push(p[0], p[1], p[2]);
    for (let i = 1; i < points.length - 1; i++) {
      idx.push(front, front + i, front + i + 1);
      idx.push(back, back + i + 1, back + i);
    }
  };

  /**
   * THE TAIL AND THE DORSAL ARE THE WHOLE SILHOUETTE, and the first version had
   * neither worth the name — a small unforked tail and no dorsal at all, which
   * came out as a pale lozenge that could as easily have been a leaf. A fish
   * seen half out of dark water is read from two cues and only two: the forked
   * tail and the ridge along the back. Six triangles, and it stops being a
   * shape and starts being an animal.
   */
  fin([-0.38, 0, 0], [-0.55, 0.24, 0], [-0.45, 0, 0], [-0.55, -0.24, 0]);
  fin([0.04, 0.13, 0], [-0.07, 0.29, 0], [-0.18, 0.12, 0]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * How many, and how far the shoal reaches.
 *
 * 36 is set by what one glance holds rather than by a budget — the channel is
 * ten metres across and you can see forty of them along it, so three dozen is a
 * fish every couple of metres of visible water, which is a river with fish in
 * it rather than an aquarium. It is one draw call at any count; the reason not
 * to double it is that a crowd reads as farmed.
 */
const COUNT = 36;
/** Beyond this from the player a fish is recycled to the water ahead. */
const KEEP_M = 54;
/**
 * Where a recycled fish is put back, along the channel from the player.
 *
 * THE NEAR NUMBER WAS 16 AND THAT WAS THE WHOLE FEATURE, BROKEN. Nothing was
 * ever placed within sixteen metres and a fish swims at about half a metre a
 * second, so in practice the nearest one to a player stood on the bank was
 * eighteen metres away — where a nine-centimetre fish is two pixels through a
 * hazy surface. The shoal was working perfectly and was, from the only place
 * anybody stands, invisible. Three metres is close enough to be looking down at
 * them.
 */
const PLACE_MIN_M = 3;
const PLACE_MAX_M = 42;
/** Further than this from the channel and the whole thing switches off. */
const SLEEP_M = 66;
/** A fish stays inside this much of the centre line. Matches the fight's. */
const CHANNEL_HALF_M = 4.4;
/** Shallower than this under a candidate spot and nothing is put there. */
const MIN_DEPTH_M = 0.3;

/**
 * The top of the water column, in metres under the surface.
 *
 * NOT the depth band the SPECIES want — that is `fishing.js`'s table and it is
 * about where a hook has to be. This is about WHAT CAN BE SEEN, and the band was
 * measured rather than chosen. A rank of fish was frozen in front of the camera
 * at six known depths and photographed through the real surface: at 0.4 m and
 * 0.25 m there is nothing there at all, at 0.15 m there is a suggestion you
 * would not notice, and at 0.08 m and above they are unmistakable. The water is
 * `vec4(col, 0.9)` with a fresnel blend to sky, so a fish is showing one part in
 * ten of itself through a sheet that is mostly reflected cloud — the falloff is
 * brutal and it is not a thing to fight, because the alternative is editing the
 * look of the water for the sake of a fish.
 *
 * So the shoal lives in the top eighteen centimetres. That is a stylisation and
 * it is worth being honest about: a real river's fish are at every depth and
 * you cannot see most of them. What you CAN see from a bank is the ones near the
 * film, so those are the ones that are here. Depth as a fact about the river is
 * not lost — it is still what decides what is on your hook, which is the place
 * the player can act on it.
 */
const SHELF_MIN = -0.01;
const SHELF_MAX = 0.18;

/** Mean seconds between one fish somewhere in the shoal clearing the water. */
const JUMP_EVERY_S = 11;
/** Only jump where it can be seen, and only into water deep enough to land in. */
const JUMP_NEAR_M = 34;

const _bank = { x: 0, y: 0, z: 0, angle: 0 };
const _spot = { x: 0, y: 0, z: 0, angle: 0 };
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _spin = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _tint = new THREE.Color();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);
const _at = { x: 0, y: 0, z: 0 };

/**
 * What swims here.
 *
 * A deliberately shorter table than the rod's nine species, and the reason is
 * that this one is about SILHOUETTE AND COLOUR at ten metres through moving
 * water, where a tench and an eel are the same dark shape. `cm` is the range,
 * `w` how common, `hue` what it flashes when it turns, and `shelf` how happily
 * it sits near the surface — the last one is what keeps the pike off the top and
 * puts the minnows there, which is the same statement the rod's depth table
 * makes, seen from the bank instead of from the hook.
 */
const KINDS = [
  { cm: [8, 16], w: 2.6, hue: 0x9aa08c, shelf: 0.15, dash: 1.5 },
  { cm: [12, 24], w: 2.4, hue: 0xb9bdc2, shelf: 0.25, dash: 1.2 },
  { cm: [18, 34], w: 1.8, hue: 0x8f9a5e, shelf: 0.45, dash: 1.0 },
  { cm: [24, 48], w: 1.0, hue: 0xa9a794, shelf: 0.6, dash: 0.85 },
  { cm: [32, 68], w: 0.4, hue: 0x7d6437, shelf: 0.75, dash: 0.7 },
];
const KIND_TOTAL = KINDS.reduce((s, k) => s + k.w, 0);

function pickKind(rng) {
  let roll = rng() * KIND_TOTAL;
  for (const k of KINDS) {
    roll -= k.w;
    if (roll <= 0) return k;
  }
  return KINDS[0];
}

/**
 * @param {object} deps
 * @param {THREE.Scene} deps.scene
 * @param {string} [deps.seed]
 * @param {(kind: string, at: {x:number,y:number,z:number}, strength?: number) => void}
 *   [deps.sound] one-shots, wired to `Ambience.fishing`. Optional on purpose —
 *   the river has fish in it before the audio context has been unlocked, and the
 *   perf scripts run with no audio at all.
 */
export function buildShoal({ scene, seed = 'grove-01', sound = null } = {}) {
  const rng = makeRng(`${seed}:shoal`);
  const geometry = fishGeometry();
  /**
   * `makeLiving` for the same reason every other prop in the world has it: a
   * river whose fish hold still while the wood breathes reads as two worlds
   * superimposed. `'prop'` is the same category the caught fish is on, so this
   * shares its program and adds no variant.
   *
   * PALE, AND THAT WAS TESTED BOTH WAYS. The instinct is countershading — a
   * fish near the top of a river is dark from above — and photographed through
   * the real surface it is invisible, because most of the water most of the time
   * is a dark blue-grey and a dark fish is showing one part in ten of a
   * difference that is already nearly nothing. Pale reads against the water
   * everywhere except inside the sun's own glint path, and losing them in the
   * glare is not a bug; it is what happens when you look at a river.
   *
   * A little emissive as well, so that at dusk they do not become black shapes
   * on a black river, which is the same failure from the other end.
   */
  const material = makeLiving(
    new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x0b1010 }),
    'prop'
  );
  const mesh = new THREE.InstancedMesh(geometry, material, COUNT);
  mesh.name = 'shoal';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  /**
   * No shadows, in either direction. They live under a surface that is drawn
   * after the shadow pass and over a bed nobody can see, so a caster is a second
   * pass over eleven hundred triangles to darken pixels that do not exist.
   */
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  /**
   * The bounding sphere is rewritten every frame around the player (see
   * `update`), so three's own frustum test stays useful — the alternative,
   * `frustumCulled = false`, would draw the shoal while you are facing away
   * from the river you happen to be standing next to.
   */
  mesh.frustumCulled = true;
  mesh.visible = false;
  scene.add(mesh);

  const fish = [];
  for (let i = 0; i < COUNT; i++) {
    const kind = pickKind(rng);
    /**
     * SQUARED, not cubed, and that is a visibility decision rather than an
     * ecological one.
     *
     * The rod's own size roll is `rng() ** 3`, which is right there: most of
     * what comes out of a river is small and a big one is worth mentioning. Here
     * the same curve put most of the shoal at the bottom of every range, where
     * a fish is four centimetres of dark shape ten metres away through a hazy
     * surface — present in the scene graph and absent from the screen. Squared
     * keeps the shape of the claim and moves the mass up enough to see.
     */
    const t = rng() ** 2;
    fish.push({
      kind,
      x: 0,
      z: 0,
      y: WATER_LEVEL - 0.2,
      angle: rng() * Math.PI * 2,
      cm: kind.cm[0] + (kind.cm[1] - kind.cm[0]) * t,
      /** Cruising speed. Small fish are quick for their size and slow overall. */
      cruise: 0.35 + rng() * 0.5,
      phase: rng() * 100,
      /** Where in the shelf it likes to sit, and how far it wanders from there. */
      rest: SHELF_MIN + (SHELF_MAX - SHELF_MIN) * (0.25 + kind.shelf * 0.75) * (0.4 + rng() * 0.9),
      swim: 0.5 + rng() * 0.7,
      /** > 0 while bolting from something. */
      spooked: 0,
      /** > 0 while up at the film with its back showing. */
      rising: 0,
      /** > 0 while airborne. `jumpV` is what is left of the launch. */
      jump: 0,
      jumpV: 0,
      placed: false,
    });
    _tint.setHex(kind.hue);
    // A little variation per individual, so a shoal of the same species is not
    // thirty copies of one colour.
    const v = 0.85 + rng() * 0.3;
    mesh.setColorAt(i, _tint.multiplyScalar(v));
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  /**
   * Put one fish somewhere plausible in the channel near (px, pz).
   *
   * The only place `heightAt` is called, and it is called on a recycle rather
   * than from the frame loop — a fish is recycled when the player has walked
   * away from it, which at a walking pace is a handful of calls a second across
   * the whole shoal.
   *
   * Six attempts and then give up and take the last one: the margin of a bend
   * can be dry for most of its width, and a loop that insisted on deep water
   * could spin. A fish in six inches of water for one recycle is a fish in the
   * shallows, which is a real thing and is invisible anyway.
   */
  const place = (f, px, pz, ahead = 0) => {
    streamPointNear(px, pz, _bank);
    for (let attempt = 0; attempt < 6; attempt++) {
      const along =
        (PLACE_MIN_M + rng() * (PLACE_MAX_M - PLACE_MIN_M)) *
        (ahead !== 0 ? ahead : rng() < 0.5 ? -1 : 1);
      streamPointNear(
        _bank.x + Math.cos(_bank.angle) * along,
        _bank.z + Math.sin(_bank.angle) * along,
        _spot
      );
      const lat = (rng() * 2 - 1) * CHANNEL_HALF_M * 0.85;
      const nx = Math.cos(_spot.angle + Math.PI / 2);
      const nz = Math.sin(_spot.angle + Math.PI / 2);
      const x = _spot.x + nx * lat;
      const z = _spot.z + nz * lat;
      const depth = WATER_LEVEL - heightAt(x, z);
      if (depth < MIN_DEPTH_M && attempt < 5) continue;
      f.x = x;
      f.z = z;
      f.angle = _spot.angle + (rng() < 0.5 ? 0 : Math.PI);
      f.y = WATER_LEVEL - f.rest;
      f.spooked = 0;
      f.rising = 0;
      f.jump = 0;
      f.placed = true;
      return;
    }
  };

  let jumpClock = JUMP_EVERY_S;
  let awake = false;

  return {
    mesh,
    /** For the debug panel's layer grid, and for anything asking after a fish. */
    get active() {
      return awake;
    },
    count: COUNT,

    /**
     * Something landed in the water, or something got hooked.
     *
     * The whole reason this is a public method rather than a private reaction to
     * the rod is that a float hitting the water and a fish bolting from it are
     * the same event seen twice, and only one module can see both. `fishing.js`
     * calls it; nothing else has to know the shoal exists.
     */
    startle(x, z, radius = 5, strength = 1) {
      if (!awake) return;
      const r2 = radius * radius;
      for (const f of fish) {
        const dx = f.x - x;
        const dz = f.z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2 || f.jump > 0) continue;
        // Straight away from it, and DOWN — a startled fish goes deep, which is
        // also what makes the reaction legible: the shoal you were looking at
        // simply is not there any more.
        f.angle = Math.atan2(dz, dx);
        f.spooked = Math.max(f.spooked, (0.9 + strength * 1.6) * clamp01(1 - Math.sqrt(d2) / radius));
      }
    },

    /**
     * @param {number} dt
     * @param {{x:number,y:number,z:number}} player where the body is
     */
    update(dt, player) {
      /**
       * THE GATE, and it is the whole performance story.
       *
       * One `streamPointNear` a frame decides whether any of the rest of this
       * runs. The river is a ten-metre channel through a world 768 m across, so
       * for almost everywhere anybody ever stands the answer is no and the cost
       * of this module is four trig calls and a compare.
       */
      streamPointNear(player.x, player.z, _bank);
      const toRiver = Math.hypot(_bank.x - player.x, _bank.z - player.z);
      if (toRiver > SLEEP_M) {
        if (awake) {
          awake = false;
          mesh.visible = false;
        }
        return;
      }
      if (!awake) {
        awake = true;
        mesh.visible = true;
        // Everything that was left behind is put back where the water is now.
        for (const f of fish) if (!f.placed) place(f, player.x, player.z);
      }

      /**
       * One jump, somewhere, on a Poisson-ish clock.
       *
       * Scheduled for the SHOAL rather than rolled per fish per frame: a
       * per-fish probability is thirty-six rolls a frame to produce an event
       * that happens once every ten seconds, and it makes the rate depend on
       * how many fish happen to be loaded.
       *
       * Dusk doubles it, which is both true and the one time of day this world
       * is already at its best — and it is the same term the rod's bite rate
       * uses, so a river that is jumping is a river that is feeding.
       */
      const dusk = 1 - Math.abs(daylightAt() * 2 - 1);
      jumpClock -= dt * (0.6 + dusk * 1.1);
      let wantJump = false;
      if (jumpClock <= 0) {
        jumpClock = JUMP_EVERY_S * (0.5 + rng());
        wantJump = true;
      }

      for (let i = 0; i < COUNT; i++) {
        const f = fish[i];
        const dxp = f.x - player.x;
        const dzp = f.z - player.z;
        const toPlayer = Math.hypot(dxp, dzp);
        if (toPlayer > KEEP_M) {
          place(f, player.x, player.z);
          continue;
        }

        f.phase += dt;

        if (f.jump > 0) {
          /**
           * Airborne, and this is plain ballistics because it is the one moment
           * a fish is a projectile. Nothing else in the loop applies: it is not
           * in the water, so it is not holding a depth, not turning and not
           * being pushed back into the channel.
           */
          f.jump -= dt;
          f.jumpV -= 9.5 * dt;
          f.y += f.jumpV * dt;
          f.x += Math.cos(f.angle) * f.cruise * 2.4 * dt;
          f.z += Math.sin(f.angle) * f.cruise * 2.4 * dt;
          if (f.y <= WATER_LEVEL && f.jumpV < 0) {
            f.y = WATER_LEVEL - 0.02;
            f.jump = 0;
            // Going back in is louder than coming out, and it is the half of the
            // event people turn their heads for.
            _at.x = f.x;
            _at.y = WATER_LEVEL;
            _at.z = f.z;
            sound?.('splash', _at, 0.25 + clamp01(f.cm / 70) * 0.5);
            f.spooked = 0.6;
          }
        } else {
          /* --- swimming ------------------------------------------------- */

          if (f.spooked > 0) f.spooked = Math.max(0, f.spooked - dt);

          /**
           * Heading: hold the channel, meander, and turn back at the margin.
           *
           * The margin push is the fight's own trick from `fishing.js` — put the
           * fish back on the band and turn it along the water rather than
           * clamping the position, so a fish that finds the bank reads as one
           * that turned instead of one grinding along an invisible wall.
           */
          streamPointNear(f.x, f.z, _spot);
          const ox = f.x - _spot.x;
          const oz = f.z - _spot.z;
          const off = Math.hypot(ox, oz);
          if (off > CHANNEL_HALF_M) {
            const k = CHANNEL_HALF_M / off;
            f.x = _spot.x + ox * k;
            f.z = _spot.z + oz * k;
            f.angle = _spot.angle + (Math.cos(f.angle - _spot.angle) < 0 ? Math.PI : 0);
          } else if (f.spooked <= 0) {
            /**
             * Left alone, a fish points along the current — up or down it, but
             * along it — and wanders a few degrees either side. Turning toward
             * the channel's own bearing rather than picking random headings is
             * what stops thirty-six of them reading as a particle system.
             */
            const want =
              _spot.angle + (Math.abs(wrapAngle(f.angle - _spot.angle)) > Math.PI / 2 ? Math.PI : 0);
            f.angle += wrapAngle(want - f.angle) * Math.min(1, dt * 0.7);
            f.angle += Math.sin(f.phase * 0.7 + i) * dt * 0.5;
          }

          const bolt = f.spooked > 0 ? 1 + f.spooked * 2.2 : 1;
          const speed = f.cruise * f.kind.dash * bolt;
          f.x += Math.cos(f.angle) * speed * dt;
          f.z += Math.sin(f.angle) * speed * dt;

          /**
           * The depth, and this is the line that decides whether any of this is
           * visible at all.
           *
           * `rest` is where it sits, the sine is its slow wander up and down the
           * shelf, `rising` lifts it to the film, and being spooked drives it
           * down. Bounded below at 3 cm rather than at 0 so a rising fish shows
           * its back without ever ending up standing on the surface.
           */
          if (f.rising > 0) f.rising = Math.max(0, f.rising - dt);
          else if (f.spooked <= 0 && rng() < dt * (0.05 + dusk * 0.14)) {
            f.rising = 0.7 + rng() * 1.4;
          }
          /**
           * A rise puts the back OUT, not merely nearer. `-0.035` is above the
           * surface, so the dorsal ridge and the top of the tail are in air and
           * drawn by the opaque pass with nothing in front of them — which is
           * the difference between a shape you might have imagined and a fish.
           */
          const wander = Math.sin(f.phase * 0.5 + i * 1.7) * 0.05 * f.swim;
          const under = Math.max(
            -0.035,
            f.rest + wander - f.rising * 0.2 + f.spooked * 0.28
          );
          f.y += (WATER_LEVEL - under - f.y) * Math.min(1, dt * 2.4);

          /**
           * And, once in a while, one of them leaves.
           *
           * Taken by the first fish the loop reaches that is near enough to be
           * seen and not already busy, which biases jumps toward low instance
           * indices and is completely undetectable — they are shuffled through
           * the water anyway.
           */
          if (wantJump && toPlayer < JUMP_NEAR_M && f.spooked <= 0) {
            wantJump = false;
            f.jump = 1.2;
            f.jumpV = 2.2 + rng() * 1.1;
            f.rising = 0;
            _at.x = f.x;
            _at.y = WATER_LEVEL;
            _at.z = f.z;
            sound?.('splash', _at, 0.2 + clamp01(f.cm / 70) * 0.35);
          }
        }

        /* --- the pose ---------------------------------------------------- */

        /**
         * Yaw with the tail waggle folded into it, then pitch in the fish's own
         * frame. Composed as two quaternions rather than as an Euler because the
         * pitch has to be about the BODY's side axis — an Euler in any fixed
         * order pitches about a world axis and a fish heading north-east climbs
         * sideways.
         *
         * The waggle IS the swimming animation. The geometry is rigid and has no
         * bones, so the whole body swings a few degrees about its own centre at
         * a rate set by how fast it is going — which at the size these are on
         * screen is indistinguishable from a tail beat and costs one sine.
         */
        const rate = 5 + f.cruise * 6 + f.spooked * 9;
        const waggle = Math.sin(f.phase * rate) * (0.11 + f.spooked * 0.08);
        _q.setFromAxisAngle(_yAxis, -(f.angle + waggle));
        const pitch =
          f.jump > 0
            ? Math.atan2(f.jumpV, Math.max(0.4, f.cruise * 2.4))
            : f.rising > 0
              ? 0.22
              : Math.sin(f.phase * 0.9 + i) * 0.05;
        _spin.setFromAxisAngle(_zAxis, pitch);
        _q.multiply(_spin);
        _pos.set(f.x, f.y, f.z);
        _scale.setScalar(f.cm / 100);
        _m.compose(_pos, _q, _scale);
        mesh.setMatrixAt(i, _m);
      }

      mesh.instanceMatrix.needsUpdate = true;
      /**
       * The bounding sphere, rewritten rather than recomputed.
       *
       * `computeBoundingSphere` on an InstancedMesh walks every instance matrix
       * and every vertex behind it; the shoal is by construction inside KEEP_M
       * of the player, so the answer is already known and costs two writes.
       */
      if (!mesh.boundingSphere) mesh.boundingSphere = new THREE.Sphere();
      mesh.boundingSphere.center.set(player.x, WATER_LEVEL, player.z);
      mesh.boundingSphere.radius = KEEP_M;
    },

    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.removeFromParent();
      mesh.dispose();
    },
  };
}
