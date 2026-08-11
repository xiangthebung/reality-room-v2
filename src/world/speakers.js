import * as THREE from 'three';
import { groundUnder } from './terrain.js';
import { makeLiving, NOISE3, tripUniforms } from '../trip/living.js';
import { colliderGrid } from './forest.js';

/**
 * A pair of speakers, standing wherever you put them.
 *
 * This was two jukeboxes and a subwoofer between them. It is now two floor-
 * standing cabinets you can pick a spot for, one at a time, and that is a
 * smaller object doing more.
 *
 * WHY THEY STOPPED BEING JUKEBOXES.
 *
 * A jukebox is a machine you walk up to: the lit arch, the turning record and
 * the paste-a-link box are all about the moment you arrive at it. But there were
 * two of them, three and a half metres apart, because a stereo record needs two
 * positions — and two identical music machines in a clearing is not a thing that
 * exists. It read as one object duplicated by a bug. A stereo PAIR is the thing
 * the geometry was already describing, so the geometry now says so, and once it
 * did the obvious next question was why you could not move them.
 *
 * WHY TWO, WHICH IS A SOUND PROBLEM WITH AN ARCHITECTURAL ANSWER — the original
 * argument, unchanged, because the pair is the part that was right.
 *
 * A pasted YouTube link is stereo and a `PannerNode` models one point in space,
 * so it cannot carry a stereo image: feeding one two channels gives a single
 * position with the width folded in. The answer before this was two invisible
 * anchors 1.1 m apart inside a single cabinet, plus an unfiltered path that put
 * the left channel in the left ear and the right in the right — which is
 * HEAD-LOCKED. Turn around and left is still left; walk behind the machine and
 * the record is still playing inside your skull rather than out of the thing in
 * front of you.
 *
 * Two cabinets several metres apart are far enough that the separation stops
 * being a trick played on the ear and becomes a fact about the clearing: stand
 * between them and the mix opens up, stand beside one and you mostly hear that
 * one, walk behind them and the image turns around with you because it was never
 * attached to your head. `external-track.js` no longer needs the head-locked
 * path at all — see its own header for what replaced it.
 *
 * WHERE THE SUBWOOFER WENT.
 *
 * There was a third box in the middle, taking everything below 110 Hz off a
 * Linkwitz-Riley crossover. It is gone at the player's request, and the
 * crossover went with it, because nothing else in the app ever wanted one.
 *
 * IT IS NOT QUITE LEVEL-NEUTRAL, AND THE FIRST VERSION OF THIS PARAGRAPH SAID
 * IT WAS. The crossover MOVED a band rather than copying it — a limiter five
 * decibels from the top does not want a bass boost nobody asked for — and the
 * sub's gain was matched to the two-box path for exactly that reason, so the
 * arithmetic says taking it out puts the same total back. Measured, it does not:
 * a mono 60 Hz tone through both graphs, at `trims.music`, upstream of the
 * limiter, came back **1.55 dB hotter without the sub**. The match was made at
 * the shipping 0.5/0.5 cabinet mix and the knobs are at 1/1 now, and
 * `dryMix + wetMix` no longer lands on it. So the sub had been costing a decibel
 * and a half of bass, and deleting it gives that back rather than adding it.
 *
 * WHAT THAT COSTS, WHICH IS THE ONLY PART THAT MATTERS: nothing. Measured on the
 * synthetic master `record-space.mjs` uses, sober, with the world muted so the
 * record is the only thing the limiter can see — the deletion moves the swing
 * from 3.45 dB to 3.38 dB and the mean reduction from -2.71 to -3.23 dB. Half a
 * decibel of steady reduction is a volume control and is inaudible; the swing,
 * which is what a listener calls pumping, does not move. The 3.4 dB of sober
 * swing is real and is not this: it is the cabinet mix summing to 2, which
 * `record-space.mjs` names itself and which was there with the sub too.
 *
 * What the subwoofer was actually FOR, visually, survives it. It earned its
 * place because its cone moved: everything else in the clearing responds to the
 * music by changing colour, and a speaker cone is the one thing in the world
 * that responds by changing SHAPE. That cone is now the woofer in each of these
 * two cabinets, which is where a moving cone belongs anyway.
 *
 * PLACING THEM IS THE SAME GESTURE AS PUTTING UP A SCREEN, deliberately. One
 * key, aimed at a patch of ground, and the thing stands there facing you — see
 * `world/aim.js`, which both features now share. It alternates: left, then
 * right, then left again, so arranging a pair is four keystrokes and there is no
 * mode to be in and no selection to lose track of.
 *
 * They start toed in, the way a pair of speakers is aimed at a listening
 * position rather than pointed straight down the room. Once you have moved one
 * it faces wherever you were standing, which is the same rule and a better one:
 * you aimed it by standing where you wanted to listen from.
 */

/**
 * How far apart they start, and which way they face.
 *
 * 5.6 m is chosen against `refDistance` 4.5 in the audio, not by eye. Much
 * closer and the two panners are at nearly the same angle from any listener
 * standing back from them, which is the failure the single cabinet had; much
 * further and there is a hole in the middle, because you have to be quite close
 * to one of them before either is at a useful level. It also leaves several
 * metres of gap between the two colliders, which is a walkable doorway rather
 * than a wall — being able to stand *between* them is most of the point.
 *
 * None of this is enforced once the player starts moving them. Somebody who
 * wants both speakers in a heap at the edge of the wood has said something about
 * how they want it to sound, and the sound will tell them.
 */
const SPACING = 5.6;
const FACING = 0.22;
const TOE_IN = 0.18;

/** The cabinet, in metres. A floorstander: tall, narrow, deeper than it is wide. */
const W = 0.86;
const H = 1.72;
const D = 0.62;
/** The plinth it stands on, which is also how far the group sits off the ground. */
const PLINTH = 0.07;

/** Where each driver sits on the baffle. */
const WOOFER_Y = 0.98;
const WOOFER_R = 0.3;
const TWEETER_Y = 1.44;
/** The lit grille, as a box in local space: x is centred, y is bottom to top. */
const PANEL_W = W - 0.16;
const PANEL_Y0 = 0.14;
const PANEL_Y1 = 0.7;

/**
 * The two loose colliders, by name.
 *
 * `ColliderGrid.addSector` / `removeSector` rather than the `colliders` inbox in
 * forest.js, and the id is a string of our own rather than a sector key. The
 * inbox is write-once — the campfires use it and never move — and a speaker has
 * to be able to leave the cell it was in. Re-registering is a remove and an add
 * of one entry, which is two Map lookups, on a keypress.
 */
const COLLIDER_ID = ['speaker:left', 'speaker:right'];
/** Half a cabinet's diagonal, near enough. You cannot walk through one. */
const COLLIDER_R = 0.62;

const _local = new THREE.Vector3();

/**
 * One cabinet.
 *
 * @param {THREE.Scene} scene
 * @param {number} index 0 is the left channel, 1 the right
 */
function buildCabinet(scene, index, position, rotationY) {
  const group = new THREE.Group();
  group.name = 'speaker';
  scene.add(group);

  const woodMat = makeLiving(new THREE.MeshLambertMaterial({ color: 0x4a2c1a }), 'prop');
  const brassMat = makeLiving(
    new THREE.MeshLambertMaterial({ color: 0xb08d3f, emissive: 0x2a1c05, emissiveIntensity: 0.6 }),
    'prop'
  );
  const coneMat = makeLiving(
    new THREE.MeshLambertMaterial({ color: 0x2b2320, side: THREE.DoubleSide }),
    'prop'
  );
  const blackMat = makeLiving(new THREE.MeshLambertMaterial({ color: 0x1a1512 }), 'prop');

  // ---- the box ------------------------------------------------------------
  const shell = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), woodMat);
  shell.position.y = H / 2;
  shell.castShadow = true;
  shell.receiveShadow = true;
  group.add(shell);

  /**
   * A plinth rather than four feet.
   *
   * The subwoofer and the arches both stood on four little brass cylinders,
   * which is eight meshes for a detail nobody can see from standing height and
   * which leaves a gap the ground shows through on a slope. One slab, slightly
   * wider than the cabinet, reads as a plinth from every angle and hides the
   * seam where the box meets a hillside.
   */
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(W + 0.12, PLINTH, D + 0.12), brassMat);
  plinth.position.y = -PLINTH / 2;
  plinth.receiveShadow = true;
  group.add(plinth);

  // ---- the woofer, which is the one thing in the world that MOVES ---------
  /**
   * A surround ring that stays put and a cone that travels.
   *
   * Two meshes rather than one deforming geometry, because the motion is a rigid
   * translation of the cone along its own axis and nothing about the rubber
   * surround should move with it.
   *
   * IN FRONT OF THE BAFFLE, NOT SUNK INTO IT, AND THAT IS NOT A STYLE CHOICE.
   *
   * A real driver is recessed: the chassis is bolted behind a cutout and the
   * cone sits inside the box. There is no cutout here and there is not going to
   * be one — punching a hole in a `BoxGeometry` means a CSG shape or a hand-
   * authored baffle, for a detail that is 30 cm across. Built the recessed way
   * anyway, the whole driver was BEHIND the front face of an opaque box: the
   * cabinet's own front panel is nearer the camera than everything inside it, so
   * from any angle the woofer was a flat disc of wood with a ring drawn round
   * it. It is exactly the mistake the old jukebox panel made — see the note that
   * used to be there about a display sitting inside its own cabinet — and it
   * takes the same shape twice because bevels and box faces are both a couple of
   * centimetres of depth nobody counts.
   *
   * So the assembly stands proud, the way a driver bolted to the front of a
   * monitor does. The wide end of the cone is at the FRONT, at the surround; it
   * tapers back to the voice coil, with the dust cap bulging forward out of the
   * middle. Getting that round the wrong way is easy: a `CylinderGeometry`'s
   * `radiusTop` is at +Y and `rotation.x = -PI/2` maps +Y to -Z, which builds a
   * horn pointing at the listener. `+PI/2` is the right way round.
   */
  const coneDepth = 0.13;
  const coneBack = D / 2 + 0.004;
  const cone = new THREE.Mesh(
    new THREE.CylinderGeometry(WOOFER_R, 0.07, coneDepth, 20, 1, true),
    coneMat
  );
  cone.rotation.x = Math.PI / 2;
  const coneRest = coneBack + coneDepth / 2;
  cone.position.set(0, WOOFER_Y, coneRest);
  group.add(cone);

  /**
   * The surround, at the cone's mouth — and it is the one part of the driver
   * that does NOT travel. That is the whole reason the cone is its own mesh: the
   * rubber ring is attached to the chassis and only the paper moves.
   */
  const surround = new THREE.Mesh(new THREE.TorusGeometry(WOOFER_R + 0.02, 0.045, 8, 22), blackMat);
  surround.position.set(0, WOOFER_Y, coneBack + coneDepth);
  group.add(surround);

  /**
   * The back of the cone, closing the voice-coil hole.
   *
   * An open-ended cylinder has an open end, and behind this one is a brightly
   * lit wooden baffle — a bead of cabinet in the dead centre of the driver,
   * which reads as a hole rather than as a speaker. It travels with the cone,
   * because it is part of it.
   */
  const basket = new THREE.Mesh(new THREE.CircleGeometry(0.082, 16), blackMat);
  const basketRest = coneBack + 0.002;
  basket.position.set(0, WOOFER_Y, basketRest);
  group.add(basket);

  const capRest = coneBack + 0.03;
  const dustCap = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), brassMat);
  dustCap.position.set(0, WOOFER_Y, capRest);
  group.add(dustCap);

  // ---- the tweeter --------------------------------------------------------
  // Proud of the baffle by more than its own tube radius, for the same reason
  // the woofer is: half a torus sunk into an opaque box is a semicircle.
  const tweeterRing = new THREE.Mesh(new THREE.TorusGeometry(0.082, 0.022, 6, 16), blackMat);
  tweeterRing.position.set(0, TWEETER_Y, D / 2 + 0.024);
  group.add(tweeterRing);

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(0.062, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5),
    brassMat
  );
  dome.rotation.x = Math.PI / 2;
  dome.position.set(0, TWEETER_Y, D / 2 + 0.012);
  group.add(dome);

  // ---- the lit grille -----------------------------------------------------
  /**
   * The one screen in the world, and it is still not text.
   *
   * A shader panel rather than a texture, because it has to *respond*: the meter
   * moves with the music's own analyser output and during a trip the whole thing
   * melts. It carries three jobs the rest of the cabinet cannot — whether the
   * music is on, which record it is, and where the pair is from forty metres
   * away through fog. On the jukebox that job belonged to a lit arch. On a
   * speaker it belongs to the grille cloth, lit from behind.
   */
  const panelMat = new THREE.ShaderMaterial({
    name: 'speaker-grille',
    transparent: true,
    uniforms: {
      uTime: tripUniforms.uTime,
      uLevel: tripUniforms.uLevel,
      uAudio: tripUniforms.uAudio,
      uNoiseTex: tripUniforms.uNoiseTex,
      uPlaying: { value: 0 },
      uHue: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() {
        vP = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE3}
      uniform float uTime;
      uniform float uLevel;
      uniform float uPlaying;
      uniform float uHue;
      uniform vec4 uAudio;
      varying vec2 vP;

      void main() {
        vec2 p = vP;
        // Melt the panel's own coordinates during a trip. This IS a filter on a
        // screen, and that is fine — it is a screen inside the world, and being
        // the one surface allowed to behave like a screen is the joke.
        p += vec2(
          rrFbm2(vec3(p * 3.0, uTime * 0.2)),
          rrFbm2(vec3(p * 3.0 + 11.0, uTime * 0.17))
        ) * 0.08 * uLevel;

        vec3 col = vec3(0.0);
        float bass = uAudio.x;
        float mid = uAudio.y;
        float high = uAudio.z;

        /**
         * THE CLOTH. A woven grille over a lit cavity: fine slats both ways,
         * because a single direction reads as a shutter rather than as fabric,
         * and the cavity behind it brightens with the low end so the whole panel
         * breathes on the beat.
         */
        float weave = (0.5 + 0.5 * sin(p.y * 190.0)) * (0.62 + 0.38 * sin(p.x * 150.0));
        float cavity = 0.3 + bass * 1.45 + mid * 0.45;
        vec3 warm = vec3(1.0, 0.45, 0.14);
        col += warm * cavity * weave * (0.06 + uPlaying * 0.22);
        col += vec3(1.0, 0.9, 0.7) * high * 0.18
             * smoothstep(0.6, 1.0, sin(p.x * 40.0 + uTime * 6.0) * 0.5 + 0.5) * uPlaying;

        /**
         * THE METER, across the top third: eleven segments, lit from the left,
         * hue-rotated per record.
         *
         * The jukebox's turning record was the cue that told you from across the
         * clearing whether the machine was on. A meter is the same cue in the
         * vocabulary of a speaker — it only moves when something is playing, and
         * unlike the record it also says how HARD, which is the thing the low
         * end can no longer say now that there is no box in the middle whose
         * only job was to be seen working.
         *
         * DIM, AND THE FIRST VERSION WAS NOT.
         *
         * A lit segment at 1.05 on top of the cloth underneath it, through a
         * bloom pass and a tone map, is white — eleven white blocks with no
         * colour left in them, which is a fluorescent tube rather than a meter,
         * and the only thing in the wood that looked like a user interface. The
         * unlit floor came down too: a meter reads as a meter because the dark
         * segments are visible next to the lit ones, and at 0.06 they were not
         * there at all until the music turned them on.
         */
        if (p.y > 0.62 && p.y < 0.84) {
          float seg = floor(p.x * 11.0);
          float gap = fract(p.x * 11.0);
          float level = clamp(bass * 0.9 + mid * 1.5 + high * 0.7, 0.0, 1.0) * uPlaying;
          float lit = step(seg, level * 11.0 - 0.5);
          // The last three segments run hot, the way every meter ever built does.
          vec3 tint = mix(vec3(0.35, 1.0, 0.5), vec3(1.0, 0.3, 0.12), smoothstep(6.0, 10.0, seg));
          tint = rrHueRotate(tint, uHue);
          float body = smoothstep(0.08, 0.18, gap) * smoothstep(0.92, 0.82, gap);
          col += tint * body * (0.1 + lit * 0.42);
        }

        /**
         * THE PORT, bottom left, and the LAMP, bottom right. Neither is
         * geometry: a dark disc with a rim and a single dot are two lines of
         * shader each and would be nine hundred triangles apiece as meshes.
         */
        float port = length((p - vec2(0.22, 0.28)) * vec2(1.0, 0.62));
        col *= smoothstep(0.05, 0.075, port);
        col += vec3(0.9, 0.55, 0.3) * smoothstep(0.086, 0.072, port) * smoothstep(0.06, 0.075, port) * 0.5;

        float lamp = length((p - vec2(0.8, 0.28)) * vec2(1.0, 0.62));
        col += mix(vec3(0.5, 0.06, 0.03), vec3(1.0, 0.72, 0.3), uPlaying)
             * smoothstep(0.022, 0.006, lamp) * (0.35 + uPlaying * 0.75);

        col = rrHueRotate(col, uLevel * rrFbm2(vec3(p * 2.0, uTime * 0.1)) * 2.4);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const panelH = PANEL_Y1 - PANEL_Y0;
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, panelH), panelMat);
  panel.position.set(0, (PANEL_Y0 + PANEL_Y1) / 2, D / 2 + 0.006);
  group.add(panel);

  /**
   * Where the sound comes from: the front baffle, between the drivers.
   *
   * Mutated in place when the cabinet moves rather than replaced, because
   * `external-track.js` holds these two vectors for the whole life of a track
   * and reads them every frame to aim its dry path. A new object here would
   * leave that file aiming at where the speakers used to be, silently, for as
   * long as the record lasted.
   */
  const speaker = new THREE.Vector3();
  /**
   * Where the lamp would go if this cabinet had one to itself. It does not —
   * see the note on the single light in `buildSpeakers` — but the lamp slides
   * between the two of these, so each has to know its own.
   */
  const lampAnchor = new THREE.Vector3();

  const cabinet = {
    group,
    panelMat,
    speaker,
    lampAnchor,
    /** Excursion state for the cone. See `tick`. */
    _x: 0,

    /**
     * Stand it on a patch of ground, facing a direction.
     *
     * @param {{x:number, y?:number, z:number, yaw:number}} spot `y` is the
     *   ground, and is asked of the terrain when it is not supplied — which is
     *   the case at construction, where the caller knows an x and a z and
     *   nothing about the hillside.
     */
    place({ x, y, z, yaw }) {
      const ground = y ?? groundUnder(x, z);
      group.position.set(x, ground + PLINTH, z);
      group.rotation.y = yaw;
      group.updateMatrixWorld(true);

      speaker.copy(group.localToWorld(_local.set(0, (WOOFER_Y + TWEETER_Y) / 2, D / 2)));
      lampAnchor.copy(group.localToWorld(_local.set(0, 1.35, D / 2 + 0.55)));

      /**
       * Move the collider with it, as one remove and one add.
       *
       * Mutating the entry's `x`/`z` in place would be cheaper and would be
       * wrong: `ColliderGrid` files entries into 16 m cells by the position they
       * had when they were added, and the body only ever gathers the nine cells
       * around itself. A speaker carried across a cell boundary would keep
       * blocking the clearing it left and let you walk through the one it is
       * standing in.
       */
      colliderGrid.removeSector(COLLIDER_ID[index]);
      colliderGrid.addSector(COLLIDER_ID[index], new Float32Array([x, z, COLLIDER_R]));
    },

    /**
     * Where this cabinet is standing, as `place` would want it back.
     *
     * The GROUND, not the base of the box — `place` adds the plinth itself, so
     * a round trip through this has to take it off or every hop through the
     * network would lift the speakers another 12 cm into the air.
     */
    spot() {
      return {
        x: group.position.x,
        y: group.position.y - PLINTH,
        z: group.position.z,
        yaw: group.rotation.y,
      };
    },

    /**
     * Close enough to be the same placement, in metres and radians.
     *
     * Exists so an echo of our own placement is a no-op rather than a second
     * identical move: `place` is not free — it rebuilds a collider sector and
     * asks for a shadow re-render — and running it on every rebroadcast would
     * make a room of eight pay for one person's keypress eight times.
     *
     * A centimetre and a hundredth of a radian, which is far below what a
     * placement gesture can resolve and far above float round-tripping through
     * JSON.
     */
    sameSpot(other) {
      const here = this.spot();
      return (
        Math.abs(here.x - other.x) < 0.01 &&
        Math.abs(here.z - other.z) < 0.01 &&
        Math.abs(here.yaw - other.yaw) < 0.01
      );
    },

    setPlaying(on) {
      panelMat.uniforms.uPlaying.value = on ? 1 : 0;
    },

    setHue(h) {
      panelMat.uniforms.uHue.value = h;
    },

    /**
     * @param {number} dt
     * @param {number} bass 0..1 from the analyser
     * @param {number} weight how hard the trip is driving the low end, 0..1
     */
    tick(dt, bass, weight) {
      /**
       * Excursion, and why it is not simply `bass`.
       *
       * A cone that tracked the analyser directly would sit at a nearly constant
       * offset, because the bass band of a mastered record is nearly always
       * present — which reads as a broken speaker rather than a working one. The
       * rest position has to be the resting place, so this is smoothed hard on
       * the way back and barely at all on the way out: the cone LEAPS and
       * settles, which is what a real driver looks like on a kick drum.
       *
       * The trip's own low-end weight adds to the travel, so during a trip the
       * driver visibly works harder for the same record. That is the one place
       * the manufactured low end becomes visible, since it is otherwise
       * positionless — see the note in main.js about why it stays that way.
       */
      const target = Math.min(1, bass * 1.35 + weight * 0.45);
      const k = target > this._x ? Math.min(1, dt * 22) : Math.min(1, dt * 7);
      this._x += (target - this._x) * k;
      const travel = this._x * 0.055;
      cone.position.z = coneRest + travel;
      basket.position.z = basketRest + travel;
      dustCap.position.z = capRest + travel;
    },
  };

  cabinet.place({ x: position.x, z: position.z, yaw: rotationY });
  return cabinet;
}

/**
 * The pair, and one object to treat them as a rig.
 *
 * Everything outside this file — the interaction test, the HUD prompt, the
 * director, the perf harness — wants to talk about "the speakers" as one thing,
 * and none of it should have to know which one the player happens to be
 * standing next to. So `position` is the midpoint, `distanceTo` answers about
 * the NEARER of the two, and `placeNext` hands back which one it moved.
 */
export function buildSpeakers(scene, centre = new THREE.Vector3(6.5, 0, -5.5)) {
  /**
   * The axis the pair is spread along: the cabinets' own local +X, which under
   * a Y rotation of `FACING` points along (cos, 0, -sin). Taken from the facing
   * angle rather than hard-coded so the pair starts square to whatever direction
   * the cabinets are turned — a spread along world X with them facing anywhere
   * else would put one of them in front of the other.
   */
  const ax = Math.cos(FACING);
  const az = -Math.sin(FACING);
  const half = SPACING / 2;
  const at = (s) => new THREE.Vector3(centre.x + ax * half * s, 0, centre.z + az * half * s);

  // Toed IN: the left cabinet turns towards +X and the right towards -X, so
  // both point at somebody standing in front of the midpoint.
  const left = buildCabinet(scene, 0, at(-1), FACING + TOE_IN);
  const right = buildCabinet(scene, 1, at(1), FACING - TOE_IN);
  const cabinets = [left, right];

  /**
   * ONE LAMP FOR THE PAIR, AND IT SLIDES.
   *
   * A point light so the speakers light the ground and the nearest trunks —
   * what makes them feel like they are *in* the clearing rather than composited
   * into it. The obvious build is one per cabinet, and it is a real and
   * permanent cost: three compiles `NUM_POINT_LIGHTS` into every material's
   * program, so one more light is one more evaluation per fragment on every lit
   * surface in a forest that is already fill-bound. `campfire.js` shares a
   * single migrating light across twelve fires for exactly this reason and its
   * header is worth reading.
   *
   * It used to sit at the midpoint, which was fine while the two were bolted
   * 5.6 m apart and is not fine now that one of them can be at the far side of
   * the clearing: the midpoint of a wide pair is a patch of grass with nothing
   * on it, and both speakers would stand in the dark.
   *
   * So it slides to the point on the line between them nearest the player,
   * clamped to the segment. Continuous, which is the part that matters —
   * `campfire.js` has to WAIT for the light to fade before it jumps to another
   * fire, because a point light snapping between two positions is visible if it
   * is lighting anything, and between two speakers is exactly where a listener
   * stands. There is nothing to fade here: stand in front of a close pair and it
   * sits between them as it always did, walk up to one of a wide pair and it
   * arrives with you.
   */
  const lampGroup = new THREE.Group();
  lampGroup.name = 'speaker-lamp';
  scene.add(lampGroup);
  const lamp = new THREE.PointLight(0xffb26a, 0, 9, 1.7);
  lampGroup.add(lamp);

  const _seg = new THREE.Vector3();
  const _to = new THREE.Vector3();

  const rig = {
    cabinets,
    left,
    right,
    lamp,
    /**
     * The two boxes, for the bisection switch — and NOT the lamp.
     *
     * `probe.show` sets `.visible` on everything in here, and three collects its
     * lights by walking the visible scene: hiding a group with a light in it
     * changes `NUM_POINT_LIGHTS` and recompiles the program of every material in
     * the world. A switch meant to answer "what do these two boxes cost" would
     * instead measure a couple of hundred milliseconds of shader compilation.
     * `video-surface.js` learned this first and names its glow so it falls
     * outside the screens prefix; this is the same rule stated as a list.
     */
    groups: cabinets.map((c) => c.group),

    /**
     * The midpoint, live. It is what "the music is over there" means, it is
     * where the HUD measures from, and it is what the measuring scripts stand in
     * front of. Rewritten by `placeNext`; never replaced, because callers hold
     * on to it.
     */
    position: new THREE.Vector3(),

    /** 0 or 1 — which cabinet the next placement moves. Left first. */
    next: 0,

    /**
     * Has anybody stood these anywhere, or are they where they were built?
     *
     * Set by the local gesture and NOT by `applyPlacement`, which is the whole
     * point of the distinction: it answers "do I know something about the
     * speakers that the room might not", and a placement that came from the
     * room is by definition not that. Read on `welcome` — see the null case in
     * `net.onSpeakers`.
     */
    moved: false,

    /** The audio layer's two anchors. Mutated in place; see `buildCabinet`. */
    speakerL: left.speaker,
    speakerR: right.speaker,

    /**
     * Stand the next cabinet on a patch of ground, and hand back which one it
     * was so the caller can move that source's panner and say so.
     *
     * ALTERNATING RATHER THAN SELECTED. The alternative is a held selection —
     * press a key to pick a speaker, another to put it down — which is a mode,
     * and a mode you can be in without meaning to be. Left, right, left, right
     * is stateless from the player's side: whatever you press, the thing that
     * moves is the one that has not moved most recently, and the HUD says which
     * is coming next before you press it again.
     *
     * @param {{x:number, y:number, z:number, yaw:number}} spot from `aimGround`
     * @returns {0|1} the cabinet that moved
     */
    placeNext(spot) {
      const index = this.next;
      this.placeAt(index, spot);
      this.next = index === 0 ? 1 : 0;
      this.moved = true;
      return index;
    },

    /**
     * Stand a NAMED cabinet somewhere. The same work, with the choice made by
     * the caller instead of by the alternation.
     *
     * This exists because a placement now arrives from two directions. Locally
     * it is a gesture — aim, press `G`, and which box moves is whichever has
     * not moved most recently. Over the network it is a FACT: the message says
     * where both cabinets are, and a receiver that ran them through the
     * alternation would end up with a mirrored pair the moment two people
     * pressed `G` in an order the receiver did not share.
     *
     * @param {0|1} index which cabinet
     * @param {{x:number, y?:number, z:number, yaw:number}} spot
     */
    placeAt(index, spot) {
      cabinets[index].place(spot);
      this._recentre();
    },

    /**
     * Where both cabinets are standing, in the form the wire uses.
     *
     * `group.position.y` minus the plinth, so what travels is the GROUND under
     * the box rather than the base of the box. Same choice `Placement` makes
     * for a screen and for the same reason: the ground is the thing two
     * machines can independently agree about, and it is what `place` wants back.
     */
    placement() {
      return {
        l: cabinets[0].spot(),
        r: cabinets[1].spot(),
        next: this.next,
      };
    },

    /**
     * Put both cabinets exactly where a message says, and adopt whose turn it
     * is next.
     *
     * `next` travels with the pair because it is the only part of this state a
     * receiver cannot derive. Without it, a guest's next `G` moves whichever
     * box their own local alternation happened to be pointing at, so two people
     * taking turns would fight over one cabinet and leave the other where it
     * was.
     *
     * @returns {boolean} whether anything actually moved
     */
    applyPlacement(at) {
      if (!at) return false;
      let moved = false;
      for (const [index, spot] of [[0, at.l], [1, at.r]]) {
        if (!spot) continue;
        if (cabinets[index].sameSpot(spot)) continue;
        this.placeAt(index, spot);
        moved = true;
      }
      if (at.next === 0 || at.next === 1) this.next = at.next;
      return moved;
    },

    /** How far the player is from the NEARER of the two, on the flat. */
    distanceTo(x, z) {
      const a = Math.hypot(left.speaker.x - x, left.speaker.z - z);
      const b = Math.hypot(right.speaker.x - x, right.speaker.z - z);
      return Math.min(a, b);
    },

    setPlaying(on) {
      for (const c of cabinets) c.setPlaying(on);
    },

    setHue(h) {
      for (const c of cabinets) c.setHue(h);
    },

    /**
     * @param {THREE.Camera} camera where the lamp slides to
     * @param {number} weight how hard the trip is driving the low end, 0..1 —
     *   the only way the manufactured bass becomes visible, since it reaches the
     *   mix without a position of its own. See main.js.
     */
    tick(dt, camera, audio, weight = 0) {
      const on = left.panelMat.uniforms.uPlaying.value > 0.5;
      const target = on ? 1.7 + audio.x * 2.6 : 0.35;
      lamp.intensity += (target - lamp.intensity) * Math.min(1, dt * 6);

      /**
       * The closest point on the segment between the two lamp anchors.
       *
       * `t` is the projection of the camera onto that segment, clamped — so a
       * player standing off to one end gets the light at that end rather than
       * extrapolated past it. Degenerate when both speakers are in the same
       * place, which is why the length is tested rather than divided by.
       */
      _seg.subVectors(right.lampAnchor, left.lampAnchor);
      const len2 = _seg.lengthSq();
      let t = 0.5;
      if (len2 > 1e-4) {
        _to.subVectors(camera.position, left.lampAnchor);
        t = Math.max(0, Math.min(1, _to.dot(_seg) / len2));
      }
      lampGroup.position.copy(left.lampAnchor).addScaledVector(_seg, t);

      for (const c of cabinets) c.tick(dt, on ? audio.x : 0, on ? weight : 0);
    },

    _recentre() {
      this.position
        .copy(left.speaker)
        .add(right.speaker)
        .multiplyScalar(0.5);
    },
  };

  rig._recentre();
  lampGroup.position.copy(left.lampAnchor).lerp(right.lampAnchor, 0.5);
  return rig;
}
