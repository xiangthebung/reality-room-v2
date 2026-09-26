import * as THREE from 'three';
import { TAU } from '../core/util.js';
import { WATER_LEVEL, heightAt } from './terrain.js';
import { makeLiving } from '../trip/living.js';
import { colliders } from './forest.js';
import { Seat } from '../player/seats.js';
import { buildHearths } from './campfire.js';
import { siteName, sitePlan } from './sites.js';

/**
 * The places people meet.
 *
 * Everything in this file exists to answer one question the world could not
 * previously answer: *where would we go?* A forest with no furniture in it is a
 * place you walk through, and a group walking through a forest never settles
 * into a conversation — somebody drifts, somebody follows, and the evening is
 * spent reforming. A ring of logs round a fire, a bench looking at a valley and
 * a jetty over a river are all the same mechanic: a reason to stop, and a
 * direction to face.
 *
 * ONE PIECE OF FURNITURE IS CONSPICUOUSLY ABSENT and used to be the largest
 * thing here: a fourteen-metre screen with three arcs of seating in front of it,
 * standing in the commons. It is gone because a shared screen is no longer a
 * fixture — it is an object its owner carries and puts down where the evening is
 * actually happening, at whatever size suits the clearing. See `ShareScreen` in
 * video-surface.js. The commons kept its clearing and got a fire.
 *
 *
 * THE SITES ARE MEASURED, NOT PLACED.
 *
 * Every session gets its own terrain, so there are no coordinates that mean
 * anything across two worlds. A hand-placed clearing would be halfway up a cliff
 * in the next seed. So this scans the height field the way a person choosing a
 * campsite would — flat ground, dry ground, not on a slope, spread out, in
 * walking distance of where you arrive — scores what it finds and takes the
 * best. It is a pure function of the seed, which is what lets two people in one
 * room walk to the same fire without a byte crossing the network to say where
 * it is.
 *
 * The scan is ~14 000 height samples at load, which is around a tenth of what
 * `scripts/terrain-survey.mjs` does in node in a second, and it happens once,
 * before the first frame, on the same critical path that is already waiting for
 * two streaming rings to settle.
 *
 *
 * WHY THE SEATING FACES INWARD.
 *
 * A fire gets a ring, because the thing worth looking at is each other and the
 * fire is the excuse. That used to be stated as one half of a contrast — a
 * screen got an ARC, because there the thing worth looking at is the screen and
 * the people are beside you — and the contrast is still true; it is just no
 * longer this file's problem. A ring of people round a fire with somebody's
 * screen stood up at the edge of it is both, and it is arranged by whoever put
 * the screen there rather than by a site plan written before anybody arrived.
 */

/**
 * THE PLAN ITSELF LIVES IN `sites.js`, NOT HERE.
 *
 * It has to, because `scatter.js` needs the same answer in order to leave room
 * for these places — and `scatter.js` runs inside a worker that cannot import
 * THREE. So the measuring is over there, this file reads the result through
 * `sitePlan()`, and the hole in the tree field cannot drift out of register with
 * the thing standing in it.
 *
 * See the header of sites.js for what the first build looked like without that:
 * a fourteen-metre screen, three rows of benches and four fires, every one of
 * them planted over. The site chooser prefers the flattest ground for a hundred
 * metres, and in a forest the flattest ground is where the forest most wants to
 * be.
 */

/* -------------------------------------------------------------------------- */
/* the things themselves                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A log to sit on.
 *
 * Sawn flat on top and left round underneath, which is a cylinder with a box cut
 * out of it — except that boolean geometry is not worth linking a library for,
 * so it is a cylinder with a plank laid on it. Two draws' worth of triangles in
 * a shared material, and from a metre away nobody has ever noticed.
 */
function logBench(group, materials, { x, y, z, yaw, length = 2.4, seats = null, label = null }) {
  const bench = new THREE.Group();
  /**
   * SET THE THREE COMPONENTS SEPARATELY, and the reason is a real bug that stood
   * in the spawn clearing for months.
   *
   * `Vector3.set(x, y, z)` has a compatibility guard in three — `if (z ===
   * undefined) z = this.z` — so a caller that forgets `z` does not get NaN and
   * does not get an error. It gets ZERO, silently, and the bench is built
   * perfectly at the wrong place. `fireRing` forgot it, so all twenty-nine ring
   * benches were laid out along the line z = 0 at the HEIGHT of the ground where
   * they should have been: the near hearth is 57 m up the z axis, and its five
   * logs hung two and a half metres in the air five metres in front of where
   * everybody arrives, as a black bar across the top of the first frame anyone
   * ever sees. Assigning the fields directly means a missing `z` is NaN and the
   * object vanishes, which is a bug that reports itself.
   */
  bench.position.x = x;
  bench.position.y = y;
  bench.position.z = z;
  bench.rotation.y = yaw;
  group.add(bench);

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.24, 0.26, length, 8),
    materials.log
  );
  trunk.rotation.z = Math.PI / 2;
  trunk.position.y = 0.24;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  bench.add(trunk);

  const top = new THREE.Mesh(new THREE.BoxGeometry(length, 0.06, 0.42), materials.plank);
  top.position.y = 0.45;
  top.castShadow = true;
  top.receiveShadow = true;
  bench.add(top);

  if (seats) {
    /**
     * One seat per 0.8 m of bench, which is the width of a person plus the
     * elbow room that stops a row of avatars reading as a shelf of ornaments.
     */
    const count = Math.max(1, Math.round(length / 0.8));
    const list = [];
    for (let i = 0; i < count; i++) {
      const along = (i - (count - 1) / 2) * (length / count);
      list.push(
        new Seat({
          position: new THREE.Vector3(
            x + Math.cos(yaw) * along,
            y + 0.48,
            z - Math.sin(yaw) * along
          ),
          // The bench is built long in local X, so a sitter faces along -Z of it.
          yaw,
          kind: 'bench',
          label,
        })
      );
    }
    seats.add(list);
  }
  return bench;
}

/**
 * A ring of benches round a fire, at whatever radius suits the fire.
 *
 * ODD COUNTS ONLY, and it is the one rule in here worth stating. An odd number
 * means nobody is sitting directly opposite anybody, which sounds like nothing
 * and is the difference between a conversation and an interview.
 */
function fireRing(
  group,
  materials,
  site,
  seats,
  /**
   * `label` is what the world calls this place — see `siteName` in sites.js,
   * which is where all nine names now come from. The default is a FALLBACK and
   * not the name of anything: it is what a seat gets if a caller builds a ring
   * round something that is not in the site plan, so that `Seat.label` is never
   * null for a fire.
   */
  { radius = 2.45, length = 1.7, count = 5, label = 'the fire' } = {}
) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + 0.31;
    const x = site.x + Math.cos(a) * radius;
    const z = site.z + Math.sin(a) * radius;
    logBench(group, materials, {
      x,
      y: heightAt(x, z),
      z,
      // Facing the fire: `forward(yaw)` must point from the seat to the flame,
      // and `forward` is (-sin, -cos), so the arguments are negated.
      yaw: Math.atan2(x - site.x, z - site.z),
      length,
      seats,
      label,
    });
  }
}

/**
 * A jetty: planks out over the water, on piles, with a bench facing across.
 *
 * It is three things at once and that is the point of it — the ferry calls here,
 * the fish are here, and it is the only place in the world where you can sit
 * with your feet over moving water. Stacking uses on one object is how a place
 * acquires the quality of being somewhere rather than being a feature.
 *
 * `label` is this landing's name in this world — 'the upper landing', 'the
 * landing', 'the lower landing', ordered downstream. See `siteName` in sites.js.
 */
function buildJetty(group, materials, site, seats, label) {
  const jetty = new THREE.Group();
  jetty.position.set(site.x, 0, site.z);
  jetty.rotation.y = site.yaw;
  group.add(jetty);

  const LENGTH = 5.4;
  const WIDTH = 2.2;
  /**
   * The deck is level with the bank at the shore end and stays level as it goes
   * out, which means it is a platform rather than a ramp — the ground under it
   * falls away into the channel and the piles get longer. That is how a jetty is
   * built and it is also the only way to get a flat surface over a slope without
   * either digging or a hinge.
   */
  const deckY = Math.max(site.y, WATER_LEVEL + 0.75);

  for (let i = 0; i < 9; i++) {
    const plank = new THREE.Mesh(
      new THREE.BoxGeometry(WIDTH, 0.08, LENGTH / 9 - 0.03),
      materials.plank
    );
    plank.position.set(0, deckY, -(i + 0.5) * (LENGTH / 9));
    plank.castShadow = true;
    plank.receiveShadow = true;
    jetty.add(plank);
  }

  const pileGeo = new THREE.CylinderGeometry(0.11, 0.13, 1, 6);
  for (let i = 0; i < 3; i++) {
    const along = -(0.6 + i * ((LENGTH - 1.2) / 2));
    for (const side of [-1, 1]) {
      const wx = site.x - Math.sin(site.yaw) * along + Math.cos(site.yaw) * side * (WIDTH / 2 - 0.2);
      const wz = site.z - Math.cos(site.yaw) * along - Math.sin(site.yaw) * side * (WIDTH / 2 - 0.2);
      const bed = Math.min(heightAt(wx, wz), deckY - 0.3);
      const pile = new THREE.Mesh(pileGeo, materials.log);
      pile.scale.y = deckY - bed + 0.3;
      pile.position.set(
        Math.cos(site.yaw) * side * (WIDTH / 2 - 0.2),
        (deckY + bed) / 2,
        along
      );
      pile.castShadow = true;
      jetty.add(pile);
    }
  }

  /**
   * A bench at the shore end facing OUT along the jetty, not across it.
   *
   * Facing out means you are looking down the planks at the water and the far
   * bank, which is the view; facing across means you are looking at the side of
   * your own jetty. It also means two people on it are shoulder to shoulder
   * watching the same thing, which is a different and better kind of
   * conversation from two people facing each other.
   */
  {
    // A metre back from the waterline, on the bank's own ground rather than on
    // the deck: the deck is levelled to clear the water and the bank is not, so
    // a bench pinned to `deckY` floats at one end on any but a flat shore.
    const bx = site.x + Math.sin(site.yaw) * 1.0;
    const bz = site.z + Math.cos(site.yaw) * 1.0;
    logBench(group, materials, {
      x: bx,
      y: heightAt(bx, bz),
      z: bz,
      yaw: site.yaw,
      length: 1.9,
      seats,
      label,
    });
  }

  return { group: jetty, deckY, site };
}

/**
 * Build everything.
 *
 * @param {THREE.Scene} scene
 * @param {object} deps
 * @param {string} deps.seed only for the campfires' own scatter rng
 * @param {import('../player/seats.js').SeatRegistry} deps.seats
 */
export function buildGathering(scene, { seed, seats }) {
  /**
   * Asked for, not computed. `sitePlan()` memoises on the world seed and the
   * forest worker has already asked it the same question in its own realm — see
   * the note at the top of this file about why both have to get the same answer.
   */
  const sites = sitePlan();

  const group = new THREE.Group();
  group.name = 'gathering';
  scene.add(group);

  const materials = {
    log: makeLiving(new THREE.MeshLambertMaterial({ color: 0x574026 }), 'prop'),
    plank: makeLiving(new THREE.MeshLambertMaterial({ color: 0x6d5537 }), 'prop'),
  };

  /* ---- the commons ------------------------------------------------------ */

  /**
   * THE COMMONS USED TO BE BUILT ROUND A FOURTEEN-METRE SCREEN, and there is no
   * screen in the world any more.
   *
   * A share is a screen its owner carries and puts down where they like (see
   * `ShareScreen` in video-surface.js), which means the one place you could show
   * anybody anything is now anywhere — and a permanent screen bolted to one
   * clearing had become the only place you were NOT allowed to move it from.
   * Three arcs of benches facing a blank rectangle went with it.
   *
   * The clearing itself stays, and stays reserved in `sites.js`: it is the
   * flattest, driest ground within walking distance of where you arrive, the
   * forest leaves a hole for it, and taking that away would re-lay-out every
   * seeded world for the sake of deleting a thing that is no longer here. It
   * gets what it should probably always have had — a big fire, in the middle,
   * with a ring to sit on — which is the same mechanic the screen was: a reason
   * to stop, and a direction to face. If somebody wants a cinema in it they can
   * put a screen up, at whatever size the evening calls for, which is the whole
   * point of the change.
   */
  const commonsFire = {
    x: sites.commons.x,
    y: sites.commons.y,
    z: sites.commons.z,
    // Larger than a hearth out in the wood: this is the fire the whole room
    // gathers round rather than the one four people found.
    radius: 1.15,
    /**
     * How far out somebody still counts as being AT this fire. See
     * `setCompany` below.
     *
     * The commons has two rings — five logs at 3.9 m and nine at 9.2 — so 10.5
     * covers the outer row and the metre of bench behind it. Read off the
     * `fireRing` calls below rather than guessed, and it is the reason this
     * number lives here beside them instead of in campfire.js: the radius of a
     * ring of seats is a fact about the furniture.
     */
    ring: 10.5,
  };

  /* ---- fires out in the wood -------------------------------------------- */

  const fireSites = [commonsFire];
  /**
   * TWO RINGS, WHICH IS WHAT MAKES THIS READ AS THE COMMONS RATHER THAN AS A
   * BIGGER CAMPFIRE.
   *
   * The first version was one ring of five at 3.6 m, which is a hearth with the
   * numbers nudged — and photographed as one: a fire in long grass with a couple
   * of logs beside it, in the clearing that used to hold the largest built thing
   * in the world. A place has to be legible from the tree line before you have
   * decided to walk into it, and one ring at conversational radius simply is not
   * from thirty metres away.
   *
   * So: an inner ring of five to sit at, and an outer ring of nine, far enough
   * back to be the boundary of a room rather than a second row of seats. The
   * outer one is where you end up when the inner one is full, where you put a
   * screen up behind everybody, and — the part that actually matters — what
   * tells you from a distance that somebody built this.
   */
  /**
   * THE LABEL IS ASKED FOR RATHER THAN TYPED, and this is the whole of the
   * change that made `Seat.label` mean something.
   *
   * It read `label: 'the commons'` here, in two places, and 'the fire' / 'the
   * view' / 'the landing' in four more — six string literals describing nine
   * places, none of which were ever read by anything. `siteName()` in sites.js
   * now names all nine off the plan, so what a seat is called and what the world
   * announces when you walk into it are one string with one author. A label that
   * disagreed with the toast would be worse than no label at all: it would make
   * two people at the same fire call it two different things.
   */
  const commonsName = siteName(sites.commons);
  fireRing(group, materials, commonsFire, seats, {
    radius: 3.9,
    length: 2.6,
    label: commonsName,
  });
  fireRing(group, materials, commonsFire, seats, {
    radius: 9.2,
    length: 2.9,
    count: 9,
    label: commonsName,
  });

  for (const site of sites.hearths) {
    // `ring` 3.6 against `fireRing`'s default radius of 2.45 plus half a
    // 1.7 m log: a body on the seat is inside, a body walking past is not.
    fireSites.push({ x: site.x, y: site.y, z: site.z, radius: 0.82, ring: 3.6 });
    /**
     * A ring of five logs at two and a half metres. Close enough that the fire
     * lights everyone's face, far enough that nobody is cooking.
     */
    fireRing(group, materials, site, seats, { label: siteName(site) });
  }

  for (const fire of fireSites) {
    // You may not stand in a fire. See the note on the 0.82 m floor above.
    colliders.push({ x: fire.x, z: fire.z, r: 0.95 });
  }
  const hearths = buildHearths(group, fireSites, seed);

  /* ---- viewpoints -------------------------------------------------------- */

  for (const site of sites.viewpoints) {
    /**
     * Face the way the ground falls.
     *
     * Sampled as a gradient over twenty metres rather than two: at two metres
     * the answer is the local bump the bench is standing on, and the bench ends
     * up pointing at a tussock. Twenty metres is the scale of the landform,
     * which is the thing worth looking at.
     */
    let bestYaw = 0;
    let bestDrop = -Infinity;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      const drop = site.y - heightAt(site.x + Math.sin(a) * 20, site.z + Math.cos(a) * 20);
      if (drop > bestDrop) {
        bestDrop = drop;
        bestYaw = a;
      }
    }
    logBench(group, materials, {
      x: site.x,
      y: site.y,
      z: site.z,
      yaw: bestYaw,
      length: 2.1,
      seats,
      label: siteName(site),
    });
  }

  /* ---- landings ---------------------------------------------------------- */

  const jetties = sites.jetties.map((site) =>
    buildJetty(group, materials, site, seats, siteName(site))
  );

  /**
   * Scratch for `setCompany`, allocated once. That function runs a few times a
   * second for the whole life of the session and a fresh array each time would
   * be pure garbage for a dozen integers.
   */
  const _counts = new Int32Array(fireSites.length);

  return {
    group,
    sites,
    hearths,
    fires: fireSites,
    jetties,
    materials,

    /**
     * The nearest fire to a point, for the audio and for the prompt. Linear over
     * a handful of sites, called once a frame, and not worth indexing.
     */
    nearestFire(x, z) {
      let best = null;
      let bestD = Infinity;
      for (const fire of fireSites) {
        const d = Math.hypot(fire.x - x, fire.z - z);
        if (d < bestD) {
          bestD = d;
          best = fire;
        }
      }
      return best ? { fire: best, distance: bestD } : null;
    },

    /** Somewhere to stand on a jetty and cast from, or null. */
    nearestJetty(x, z) {
      let best = null;
      let bestD = Infinity;
      for (const jetty of jetties) {
        const d = Math.hypot(jetty.site.x - x, jetty.site.z - z);
        if (d < bestD) {
          bestD = d;
          best = jetty;
        }
      }
      return best ? { jetty: best, distance: bestD } : null;
    },

    /**
     * WHO IS SITTING AT WHICH FIRE, and the reason this counting step is here
     * rather than in campfire.js or in main.js.
     *
     * main.js is the only place that knows WHO is seated — it composes the pose
     * flags for the local body and reads `net.peers` for everybody else — so it
     * supplies the bodies. campfire.js is the only place that knows what a
     * flame does with a number. This function is the piece in between, and it
     * belongs here because the thing it uses is `ring`, which is a fact about
     * the furniture two functions up: a hearth's ring of logs is at 2.45 m and
     * the commons' outer ring is at 9.2, and no other file should have to know
     * that.
     *
     * NOTHING GOES ON THE WIRE FOR THIS. Positions and a sitting flag are
     * already in every 18 Hz pose row, so each client runs this same loop over
     * the same interpolated positions and arrives at the same number — the same
     * zero-byte trick that puts two people at the same fire without either of
     * them saying which fire it is. It is not perfectly synchronised, and it
     * does not have to be: the six-second ease in campfire.js is two hundred
     * pose ticks long, so a client that is one body behind for a tick shows a
     * flame height that differs by well under a per cent.
     *
     * NEAREST FIRE WINS AND A BODY IS COUNTED ONCE. Two fires cannot both claim
     * the same person even where their rings overlap, which they can in
     * principle — `SITE_SPACING` is 52 m so in practice they never do, but a
     * body counted twice would be a bug that only appears on one seed.
     *
     * @param {{x: number, z: number}[]} bodies everybody currently seated,
     *   local player included.
     */
    setCompany(bodies) {
      _counts.fill(0);
      for (const b of bodies) {
        let best = -1;
        let bestD = Infinity;
        for (let i = 0; i < fireSites.length; i++) {
          const f = fireSites[i];
          const d = (f.x - b.x) * (f.x - b.x) + (f.z - b.z) * (f.z - b.z);
          const ring = f.ring ?? 3.6;
          if (d < bestD && d <= ring * ring) {
            bestD = d;
            best = i;
          }
        }
        if (best >= 0) _counts[best] += 1;
      }
      hearths.setCompany(_counts);
    },

    update(dt, camera) {
      hearths.update(dt, camera);
    },

    /** @param {number} n 0 in full daylight, 1 at night — `daylight.js`'s `dark`. */
    setNight(n) {
      hearths.setNight(n);
    },

    setPixelRatio(r) {
      hearths.setPixelRatio(r);
    },

    dispose() {
      hearths.dispose();
      materials.log.dispose();
      materials.plank.dispose();
      group.removeFromParent();
    },
  };
}
