import * as THREE from 'three';
import { clamp01, hashString, makeRng } from '../core/util.js';
import { WATER_LEVEL, streamPointNear, wetness } from '../world/terrain.js';
import { makeLiving } from '../trip/living.js';

/**
 * Fishing.
 *
 * A thing to do with your hands while you are talking to somebody, which is the
 * entire specification. There is no inventory, no upgrade, no rod that catches
 * better fish, nothing to unlock and no reason to do it — and every one of those
 * absences is deliberate, because the moment any of them exists the activity
 * stops being a thing you do while talking and becomes a thing you are doing
 * instead of talking.
 *
 * What it does have is a rhythm: cast, wait a while, notice, react. The waiting
 * is the feature. It is long enough (six to twenty-six seconds) that you look
 * away from the float, and the bite is sharp enough that you look back — which
 * is exactly the shape of attention a conversation wants sitting under it.
 *
 *
 * THE FISH ARE A PURE FUNCTION OF WHERE AND WHEN.
 *
 * Nothing about a catch travels over the network except the sentence announcing
 * it. Two people fishing off the same jetty are not drawing from a shared stock,
 * they are each rolling their own dice — because a shared stock would need a
 * server that owns it, a claim protocol, and an answer to what happens when two
 * people hook the same fish, all for an outcome nobody is counting. What IS
 * shared is the flavour: the species depend on the seed and on how far up the
 * river you are, so "there are pike up at the top landing" is a true thing one
 * friend can tell another about their world.
 */

/** You may fish where the water is at least this wet, within this far. */
const WATER_REACH = 14;
const MIN_WETNESS = 0.24;

/** How long the float sits there before anything happens. */
const WAIT_MIN_S = 6;
const WAIT_MAX_S = 26;

/**
 * How long you have to strike, in seconds.
 *
 * 1.6 is generous — the point is not to be a reaction test. It is long enough
 * that you can be mid-sentence, notice, and still get it; short enough that
 * pressing the key at random does not work, which is what makes getting it feel
 * like something. Missing it costs nothing but the wait.
 */
const STRIKE_WINDOW_S = 1.6;

/**
 * Everything that lives in this river.
 *
 * `depth` is how far up the reach the species prefers, 0 at one end and 1 at the
 * other, and `spread` how fussy it is about that. The result is that a river has
 * regions — minnows and gudgeon in the shallows, pike and eels in the deep
 * water — which is the whole of the "content" here and costs one table.
 */
const SPECIES = [
  { name: 'minnow', depth: 0.1, spread: 0.5, cm: [4, 9], weight: 1.4 },
  { name: 'gudgeon', depth: 0.2, spread: 0.5, cm: [7, 14], weight: 1.2 },
  { name: 'roach', depth: 0.4, spread: 0.7, cm: [12, 28], weight: 1.3 },
  { name: 'perch', depth: 0.5, spread: 0.6, cm: [14, 34], weight: 1.0 },
  { name: 'chub', depth: 0.6, spread: 0.6, cm: [20, 46], weight: 0.9 },
  { name: 'brown trout', depth: 0.7, spread: 0.45, cm: [18, 42], weight: 0.7 },
  { name: 'tench', depth: 0.8, spread: 0.4, cm: [26, 50], weight: 0.5 },
  { name: 'eel', depth: 0.85, spread: 0.5, cm: [34, 88], weight: 0.35 },
  { name: 'pike', depth: 0.95, spread: 0.4, cm: [40, 104], weight: 0.25 },
];

/**
 * The things that are not fish.
 *
 * One catch in nine, and they are the reason to keep casting. A boot is funnier
 * than a roach and a message in a bottle is the only place in this project where
 * anything resembling a story is told — one line, from nobody, addressed to
 * nobody. It costs four kilobytes of table and it is what people will describe
 * to each other afterwards.
 */
const CURIOSITIES = [
  'a boot, full of river',
  'a horseshoe, green with it',
  'a length of somebody else’s line',
  'a bottle with a note in it: <i>gone to the far bank, back by dark</i>',
  'a bottle with a note in it: <i>whoever finds this — it was worth it</i>',
  'a bottle with a note in it: <i>tell them I said the thing about the herons</i>',
  'a key, to nothing here',
  'a tin whistle, still playable',
  'a jam jar with three sticklebacks in it',
  'a coin, worn smooth on both faces',
];

const _v = new THREE.Vector3();

/**
 * The float, the line and the rod.
 *
 * One shared set of geometry built once, because the player has one rod and each
 * remote avatar has at most one — and the avatar's copy is built by `avatar.js`
 * from these same shapes so that the thing you are holding and the thing you can
 * see somebody else holding are provably the same object.
 */
export function rodGeometry() {
  return {
    /** Tapered, and long: a rod's silhouette is the whole tell at forty metres. */
    rod: new THREE.CylinderGeometry(0.008, 0.022, 2.5, 5),
    float: new THREE.CylinderGeometry(0.035, 0.035, 0.17, 7),
    tip: new THREE.ConeGeometry(0.04, 0.09, 7),
  };
}

export class Fishing {
  /**
   * @param {object} deps
   * @param {THREE.Scene} deps.scene
   * @param {import('./controller.js').Controller} deps.controller
   * @param {string} deps.seed
   * @param {(text: string, ms?: number) => void} deps.say
   * @param {(text: string) => void} [deps.announce] tell the room
   */
  constructor({ scene, controller, seed, say, announce = null }) {
    this.controller = controller;
    this.seed = seed;
    this.say = say;
    this.announce = announce;

    /** 'off' | 'ready' | 'waiting' | 'bite' | 'landing' */
    this.state = 'off';
    /** Everything you have caught this session, newest first. */
    this.book = [];
    this.casts = 0;

    this._timer = 0;
    this._catch = null;
    this._bobPhase = 0;

    const geo = rodGeometry();
    this._geo = geo;

    const woodMaterial = makeLiving(
      new THREE.MeshLambertMaterial({ color: 0x6a4a2c }),
      'prop'
    );
    this.group = new THREE.Group();
    this.group.name = 'fishing';
    this.group.visible = false;
    scene.add(this.group);

    /**
     * THE ROD IS IN THE WORLD, NOT ON THE GLASS.
     *
     * Every other game puts the held object in a separate near-plane camera so
     * it can never clip through anything. That is a screen-space overlay by
     * another name, and this project's whole visual argument — see the header of
     * `hud.js` — is that a stable rectangle welded to the viewport is the one
     * reference frame a trip must not be given. So the rod is a mesh standing at
     * world coordinates in front of the body, lit by the same sun, melted by the
     * same trip, and occasionally poking through a sapling. That last part is
     * the price and it is worth paying.
     */
    this.rod = new THREE.Mesh(geo.rod, woodMaterial);
    this.group.add(this.rod);

    this.float = new THREE.Mesh(
      geo.float,
      new THREE.MeshLambertMaterial({ color: 0xd94f36, emissive: 0x2a0d06 })
    );
    this.floatTip = new THREE.Mesh(
      geo.tip,
      new THREE.MeshLambertMaterial({ color: 0xf2f0e6 })
    );
    this.floatTip.position.y = 0.12;
    this.float.add(this.floatTip);
    this.group.add(this.float);

    /**
     * The line: two points and a `Line`, rebuilt in place every frame.
     *
     * A tube would be geometry for something a pixel wide. A `Line` is one draw
     * of two vertices, and at this thickness the difference between a correct
     * catenary and a straight segment is invisible — but the segment from the
     * rod tip to a float that is bobbing is what actually sells that the two
     * objects are connected, so it cannot simply be left out.
     */
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.line = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({ color: 0xdfe6e8, transparent: true, opacity: 0.55 })
    );
    this.group.add(this.line);

    this.woodMaterial = woodMaterial;
    this._target = new THREE.Vector3();
  }

  /** Is there water in front of the player right now? */
  get water() {
    const p = this.controller.position;
    const bank = streamPointNear(p.x, p.z);
    const distance = Math.hypot(bank.x - p.x, bank.z - p.z);
    return distance < WATER_REACH ? { bank, distance } : null;
  }

  /** Take the rod out, or put it away. */
  toggle() {
    if (this.state === 'off') {
      if (!this.water) {
        this.say('There is no water here.');
        return false;
      }
      this.state = 'ready';
      this.group.visible = true;
      this.say('A rod. <kbd>E</kbd> to cast.', 4200);
      return true;
    }
    this.stow();
    return false;
  }

  stow() {
    this.state = 'off';
    this.group.visible = false;
    this._catch = null;
  }

  /**
   * The one key. Cast, or strike, depending on what is happening — because
   * having two keys for "the thing you do next" is one more than a person who is
   * mid-conversation can hold in their head.
   */
  act() {
    switch (this.state) {
      case 'ready':
        return this._cast();
      case 'waiting':
        // Striking early: the float goes back in, no harm done, and the line
        // about it is the only feedback anybody needs.
        this.state = 'ready';
        this.say('You reel in an empty hook.');
        return false;
      case 'bite':
        return this._land();
      default:
        return false;
    }
  }

  _cast() {
    const water = this.water;
    if (!water) {
      this.say('There is no water here.');
      return false;
    }

    /**
     * Where the float lands: on the channel, in front of the player, but never
     * further out than the middle.
     *
     * Casting to `streamPointNear` alone would put every float on the centre
     * line regardless of which way anybody was facing, which reads as the game
     * placing it rather than as you throwing it. Blending the centre line with
     * the direction you are looking keeps it in the water and lets you aim.
     */
    const p = this.controller.position;
    const forward = this.controller.forward(_v);
    const aimed = {
      x: p.x + forward.x * 7.5,
      z: p.z + forward.z * 7.5,
    };
    const onWater = streamPointNear(aimed.x, aimed.z);
    this._target.set(
      onWater.x * 0.72 + aimed.x * 0.28,
      WATER_LEVEL,
      onWater.z * 0.72 + aimed.z * 0.28
    );

    this.casts += 1;
    this.state = 'waiting';

    /**
     * The wait, and the catch, decided NOW rather than when the fish arrives.
     *
     * Rolling the outcome at the moment of the bite would make the result depend
     * on when the player happened to press a key, which is the one input that
     * must not be able to fish for a better fish. Deciding it at the cast means
     * the river has already made up its mind and the only thing left is whether
     * you were paying attention.
     */
    const rng = makeRng(
      `${this.seed}:fish:${this.casts}:${Math.round(this._target.x)}:${Math.round(
        this._target.z
      )}:${Math.floor(Date.now() / 997)}`
    );
    this._timer = WAIT_MIN_S + rng() * (WAIT_MAX_S - WAIT_MIN_S);
    this._catch = this._roll(rng, this._target);
    return true;
  }

  /**
   * What is down there.
   *
   * `along` is a stable 0..1 coordinate up the river derived from the world
   * position, so the same stretch always holds the same kind of fish and two
   * people comparing notes are describing the same river.
   */
  _roll(rng, at) {
    if (rng() < 1 / 9) {
      const index = Math.floor(rng() * CURIOSITIES.length) % CURIOSITIES.length;
      return { kind: 'curiosity', text: CURIOSITIES[index] };
    }

    const along = clamp01(
      (Math.sin(at.x * 0.0031 + hashString(this.seed) * 1e-8) * 0.5 + 0.5) * 0.6 +
        (Math.sin(at.z * 0.0027) * 0.5 + 0.5) * 0.4
    );

    let total = 0;
    const weights = SPECIES.map((s) => {
      const fit = Math.exp(-(((along - s.depth) / s.spread) ** 2));
      const w = s.weight * fit;
      total += w;
      return w;
    });
    let roll = rng() * total;
    let picked = SPECIES[0];
    for (let i = 0; i < SPECIES.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        picked = SPECIES[i];
        break;
      }
    }

    /**
     * Size is the cube of a uniform roll, which is what makes a big one worth
     * mentioning. A flat distribution gives you a medium fish nearly every time
     * and nothing to say about any of them; cubing it means most are small,
     * some are decent, and once an evening somebody gets something they will
     * tell you about.
     */
    const t = rng() ** 3;
    const cm = Math.round(picked.cm[0] + (picked.cm[1] - picked.cm[0]) * t);
    return { kind: 'fish', name: picked.name, cm, notable: t > 0.72 };
  }

  _land() {
    const got = this._catch;
    this.state = 'ready';
    this._catch = null;
    if (!got) return false;

    this.book.unshift(got);
    if (this.book.length > 40) this.book.pop();

    if (got.kind === 'curiosity') {
      this.say(`You land ${got.text}.`, 6000);
      this.announce?.(`fished up ${got.text.replace(/<[^>]+>/g, '')}`);
      return true;
    }

    const line = got.notable
      ? `A ${got.name}. ${got.cm} cm — a good one.`
      : `A ${got.name}, ${got.cm} cm.`;
    this.say(line, 4600);
    this.announce?.(`landed a ${got.name}, ${got.cm} cm`);
    return true;
  }

  /** How many of what, for the roster panel. */
  tally() {
    const counts = new Map();
    for (const entry of this.book) {
      if (entry.kind !== 'fish') continue;
      counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]);
  }

  /** @param {number} dt */
  update(dt) {
    if (this.state === 'off') return;

    const c = this.controller;

    /**
     * The rod is held out to the right of the body at chest height and angled
     * up, positioned from the CONTROLLER rather than from the camera.
     *
     * The camera is up to 1.35 m of trip dolly away from the body and swings
     * around it as you turn — `main.js` says so where it explains why the sun's
     * shadow anchor moved off the camera. A rod pinned to the camera would
     * therefore slide away from its owner during a trip, and the tell would be
     * that the line stretches. Pinned to the body, it stays in the hand and the
     * camera drifts around it, which is what is actually happening to you.
     */
    const yaw = c.yaw;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = -fz;
    const rz = fx;
    const hand = {
      x: c.position.x + fx * 0.34 + rx * 0.36,
      y: c.position.y - 0.42,
      z: c.position.z + fz * 0.34 + rz * 0.36,
    };

    // A bend in the rod, from a bite or from the cast settling.
    const bend = this.state === 'bite' ? 0.5 + 0.22 * Math.sin(this._bobPhase * 19) : 0;
    this.rod.position.set(hand.x, hand.y, hand.z);
    this.rod.rotation.set(0, 0, 0);
    this.rod.rotateY(yaw);
    // Tilted up and out, so the tip is above and ahead of the hand.
    this.rod.rotateX(-1.02 - bend * 0.25 + c.pitch * 0.25);
    this.rod.rotateZ(0.34);

    const tip = _v.set(0, 1.25, 0).applyQuaternion(this.rod.quaternion).add(this.rod.position);

    this._bobPhase += dt;

    if (this.state === 'ready') {
      /**
       * Not cast: the float hangs off the tip, swinging. This is the only state
       * with no timer in it and it is the one people will spend the most time
       * in, because it is what "standing about holding a rod" looks like.
       */
      this.float.position.set(
        tip.x + Math.sin(this._bobPhase * 1.3) * 0.06,
        tip.y - 0.55 + Math.sin(this._bobPhase * 2.1) * 0.02,
        tip.z + Math.cos(this._bobPhase * 1.1) * 0.06
      );
      this.float.rotation.set(0, 0, Math.sin(this._bobPhase * 1.7) * 0.12);
    } else {
      /**
       * Cast: the float rides the surface. Two components — a slow swell that
       * every float in the river shares, and a fast tremble that only a fish
       * makes. Keeping them separate is what makes a bite legible: the moment
       * the second one starts, the float is doing something the water is not.
       */
      const swell = Math.sin(this._bobPhase * 1.9 + this._target.x) * 0.022;
      const bite =
        this.state === 'bite'
          ? Math.sin(this._bobPhase * 21) * 0.085 * (0.5 + 0.5 * Math.sin(this._bobPhase * 7))
          : 0;
      this.float.position.set(
        this._target.x,
        WATER_LEVEL + 0.06 + swell - Math.abs(bite),
        this._target.z
      );
      this.float.rotation.set(bite * 1.6, 0, swell * 4);
    }

    // The line, rod tip to float.
    const pos = this.line.geometry.attributes.position;
    pos.setXYZ(0, tip.x, tip.y, tip.z);
    pos.setXYZ(1, this.float.position.x, this.float.position.y + 0.09, this.float.position.z);
    pos.needsUpdate = true;
    this.line.geometry.computeBoundingSphere();

    // ---- the clock --------------------------------------------------------

    if (this.state === 'waiting') {
      this._timer -= dt;
      if (this._timer <= 0) {
        this.state = 'bite';
        this._timer = STRIKE_WINDOW_S;
        this.say('<b>—</b>', 1400);
      }
    } else if (this.state === 'bite') {
      this._timer -= dt;
      if (this._timer <= 0) {
        this.state = 'ready';
        this._catch = null;
        this.say('Whatever it was, it has gone.');
      }
    }
  }

  dispose() {
    for (const g of Object.values(this._geo)) g.dispose();
    this.woodMaterial.dispose();
    this.float.material.dispose();
    this.floatTip.material.dispose();
    this.line.geometry.dispose();
    this.line.material.dispose();
    this.group.removeFromParent();
  }
}
