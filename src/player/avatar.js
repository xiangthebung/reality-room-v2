import * as THREE from 'three';
import { clamp01, damp, lerp, wrapAngle } from '../core/util.js';
import {
  FLAG_BITE,
  FLAG_FISHING,
  FLAG_SITTING,
  INTERP_DELAY_MS,
  hueOf,
} from '../net/protocol.js';
import { makeLiving, tripUniforms } from '../trip/living.js';

/**
 * Another person, as seen from here.
 *
 * Built from primitives at runtime, like everything else in this repository —
 * there are no binary assets and a rigged character model would be by far the
 * largest thing in the project. Primitives also put the joints where the
 * animation wants them rather than wherever an exported skeleton happened to
 * leave them.
 *
 * WHAT AN AVATAR IS NOT. There is no nameplate, no health bar, no floating
 * label and no DOM overlay. A nameplate is a small, perfectly rectangular,
 * unmistakably man-made object that follows a person around the screen, which
 * is precisely the stable reference frame this project spends its entire render
 * pipeline avoiding handing to the eye. Everything you need to know about
 * somebody — where they are, which way they are looking, whether they are
 * talking, whether they are all right — is expressed by the body itself.
 *
 * THE BODY IS MADE OF THE SAME STUFF AS THE FOREST. Its materials go through
 * `makeLiving`, so during a trip a person standing in front of you takes the
 * regional colour field, the surface warp and the melt exactly like a boulder
 * or a trunk does. That is not a shortcut. Other people being subject to the
 * same weather as the wood is the entire difference between hallucinating and
 * watching a hallucination happen to somebody else.
 */

/**
 * Replay delay and how the buffer is used are in protocol.js; the short version
 * is that this avatar is always showing you two ticks ago, and every frame is a
 * true interpolation between two samples that have already arrived rather than
 * a chase toward the newest one. Chasing is what produces the rubber-banding
 * and the slide that everybody recognises as "netcode".
 */
const BUFFER_LIMIT = 24;

/** Where the parts sit, in metres above the feet. */
const HIP_Y = 0.86;
const SHOULDER_Y = 1.4;
const HEAD_Y = 1.58;

/**
 * The walk cycle is driven by *measured* speed, not by a flag from the network.
 *
 * The sender does say whether it thinks it is moving, but the interpolator is
 * the thing that knows how fast the avatar is actually travelling on this
 * screen — including while it is catching up after a dropped packet. Driving the
 * legs from anything else produces the classic ice-skate: feet still, body
 * sliding.
 */
const WALK_THRESHOLD = 0.4;
/** Metres per stride. A person's is about 0.8; running lengthens it. */
const STRIDE_M = 0.84;

let shared = null;

function geometry() {
  if (shared) return shared;
  shared = {
    torso: new THREE.CapsuleGeometry(0.185, 0.36, 5, 10),
    head: new THREE.SphereGeometry(0.145, 16, 12),
    glow: new THREE.SphereGeometry(0.145, 20, 14),
    /**
     * THE HOOD, AND IT IS NOT DECORATION.
     *
     * The first build had a bare sphere for a head, and a bare sphere has no
     * front. Look direction was being transmitted, interpolated and applied
     * perfectly, and it was *completely invisible*: from any angle a silent
     * person was a featureless capsule that could equally have been facing you
     * or away. Faces were the obvious fix and the wrong one — eyes and a mouth
     * on a 29 cm head are unreadable past about four metres and uncanny inside
     * it, and nothing else in this forest has a face.
     *
     * A hood works at every distance, because it is a *silhouette* cue rather
     * than a detail one: an azimuthal wedge cut out of a shell, so the head is
     * open on one side and closed on the other, and which side is which is
     * legible at thirty metres in fog. It also suits a person out walking in a
     * wood, which nothing about a floating name would.
     *
     * The arithmetic: three's sphere puts phi = 3π/2 at -Z, which is the
     * direction the avatar faces, so the 2.1 rad opening is centred there and
     * the shell keeps the remaining 4.18 rad.
     */
    hood: new THREE.SphereGeometry(0.17, 16, 10, 3 * Math.PI / 2 + 1.05, Math.PI * 2 - 2.1, 0, 1.95),
    arm: new THREE.CapsuleGeometry(0.062, 0.4, 3, 7),
    leg: new THREE.CapsuleGeometry(0.092, 0.56, 3, 7),
    neck: new THREE.CylinderGeometry(0.055, 0.07, 0.1, 8),
    contact: new THREE.CircleGeometry(0.36, 18),
    /**
     * The rod, and it is the same tapered cylinder the player's own is made of.
     *
     * Built here rather than imported from `fishing.js` so that this module has
     * no dependency on an activity — an avatar is a body, and it should be able
     * to hold a rod without knowing what fishing is. The proportions are copied
     * deliberately: the thing you are holding and the thing you can see somebody
     * else holding have to be the same object, and 2.5 m of taper is what reads
     * as a rod at forty metres through fog.
     */
    rod: new THREE.CylinderGeometry(0.008, 0.022, 2.5, 5),
  };
  return shared;
}

/**
 * The speech aura.
 *
 * A shell around the head, additive, with a fresnel falloff so it is brightest
 * at the silhouette and invisible through the middle — which is what makes it
 * read as light leaving a head rather than as a ball painted over one. It is
 * biased toward the face, so at close range you can see which way somebody is
 * turned even in the dark.
 *
 * Written as a shader rather than as a sprite for one reason: a sprite is a
 * screen-aligned quad, which means it is stuck to the glass, which is the thing
 * this project will not do. A shell is geometry standing in the world at a
 * position, and it turns with the head because it *is* the head.
 */
function glowMaterial(colour) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: colour },
      /** Speech envelope, measured from the audio that actually arrived. */
      uVoice: { value: 0 },
      /** This person's trip level, 0..1 — see the fragment shader. */
      uTrip: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec3 vLocal;
      void main() {
        vLocal = normal;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uVoice;
      uniform float uTrip;
      uniform float uTime;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec3 vLocal;

      void main() {
        // Fresnel: nothing where the shell faces you, everything at its rim.
        // The exponent was 2.2 and the band it left was a thread — too thin to
        // survive the bloom downsample, so a speaking person twenty metres away
        // showed nothing at all. 1.6 is a band you can see across a clearing.
        float rim = 1.0 - abs(dot(normalize(vNormalW), normalize(vViewDir)));
        rim = pow(clamp(rim, 0.0, 1.0), 1.6);

        // -Z is the way the head is looking, in its own space. Front-biased so
        // the aura is a face rather than a halo.
        float facing = clamp(-vLocal.z * 0.5 + 0.62, 0.0, 1.0);

        /**
         * The two states are deliberately different in KIND, not in amount.
         *
         * Speech is fast, bright and follows the words. A trip is slow, dim and
         * breathes at about seven cycles a minute — the same rate as the
         * forest's own breathing, so somebody who is tripping is visibly in step
         * with the wood while you are not. Making the second one a brighter
         * version of the first would have read as "that person is shouting".
         */
        float breath = sin(uTime * 0.73) * 0.5 + 0.5;
        float trip = uTrip * (0.3 + 0.7 * breath);
        float amount = uVoice * 1.7 + trip;

        vec3 tint = mix(uColor, uColor.brg, uTrip * 0.55);
        gl_FragColor = vec4(tint * rim * facing * amount, 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // The pipeline renders into a linear HDR buffer and tone maps at the end,
    // so this must not be graded twice.
    toneMapped: false,
  });
}

export class Avatar {
  /**
   * @param {object} who
   * @param {string} who.id
   * @param {string} [who.name]
   * @param {number|null} [who.hue] the dye this person chose in the main menu,
   *   0..1. Null — the ordinary case — means colour them by their id, which is
   *   what everybody was before the menu existed. See `hueOf`.
   */
  constructor({ id, name = 'Someone', hue = null }) {
    this.id = id;
    this.name = name;
    this.hue = hueOf(id, hue);

    this.group = new THREE.Group();
    this.group.name = `avatar:${id}`;

    /** Interpolated feet position, in world metres. */
    this.position = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    /** Broadcast speech envelope. Only used until real audio arrives. */
    this.voice = 0;
    this.trip = 0;
    this.flags = 0;

    this._buffer = [];
    this._seeded = false;
    this._bodyYaw = 0;
    this._headPitch = 0;
    this._speed = 0;
    this._stride = 0;
    this._walkPhase = 0;
    this._glowLevel = 0;
    this._last = new THREE.Vector3();
    this._head = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    /**
     * Sitting is eased rather than switched, and the eased value is what the
     * pose reads. A flag arriving on one tick and the legs folding on the next
     * is a body snapping between two states; a fifth of a second of travel is a
     * person sitting down. It also means a dropped packet cannot produce a
     * visible pop, because the target moved rather than the pose.
     */
    this._sit = 0;
    /** Same, for having a rod out. */
    this._rodOut = 0;
    /** A short flash on the aura when this person types something. */
    this._pulse = 0;
    /** @type {THREE.Mesh|null} built only if this person ever fishes. */
    this.rod = null;

    this._build();
  }

  /**
   * This person said something in chat.
   *
   * The aura flashes in their own colour. It is the only in-world signal a text
   * message produces, and it exists because `avatar.js` refuses nameplates — see
   * the header — so without it a line in the log has no body attached to it.
   * Deliberately the SPEECH channel rather than a new one: to anybody watching,
   * "that person just produced something" is the same fact whether it arrived as
   * a sound or as a sentence.
   */
  pulse() {
    this._pulse = 1;
  }

  _build() {
    const g = geometry();

    /**
     * Two materials per avatar rather than one shared set, because the hue is
     * per person. They still compile to one program: `makeLiving` returns the
     * same `customProgramCacheKey` for every prop, which is exactly what that
     * key is for.
     *
     * Built colourless and dyed a moment later by `_dye`, which is also what a
     * change of clothes calls. Constructing them with the right colour and then
     * having a second copy of the recipe for the live path is how the hood and
     * the body end up disagreeing about what "this person" looks like.
     */
    this.bodyMaterial = makeLiving(
      new THREE.MeshLambertMaterial({ emissive: 0x000000 }),
      'prop'
    );
    this.limbMaterial = makeLiving(new THREE.MeshLambertMaterial(), 'prop');
    /**
     * The hood is much darker than the body, and that is the whole cue.
     *
     * The first attempt reused the limb colour, and on a pale hue the hood and
     * the head were within a few per cent of each other — so the shape was
     * there and the *contrast* was not, and from four metres you still could
     * not tell a front from a back. Taking it down to 0.11 lightness makes the
     * front a light face inside a dark opening and the back a solid dark cap,
     * which is a value difference rather than a hue one and therefore survives
     * distance, fog and the trip's colour field.
     *
     * DoubleSide because a hood is an open shell and you see the inside of it.
     */
    this.hoodMaterial = makeLiving(
      new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }),
      'prop'
    );

    this.root = new THREE.Group();
    this.group.add(this.root);

    /**
     * A painted contact shadow, not a real one.
     *
     * `renderer.shadowMap.autoUpdate` is false in main.js — the map is only
     * re-rendered when the sun's quantised anchor moves — so a moving caster
     * would leave its shadow behind on the ground and the forest would fill up
     * with dark discs where people used to be standing. A cheap disc under the
     * feet does the one job a shadow does here, which is stop the avatar looking
     * like it is hovering a hand's width off the floor.
     */
    this.contact = new THREE.Mesh(
      g.contact,
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.26,
        depthWrite: false,
      })
    );
    this.contact.rotation.x = -Math.PI / 2;
    this.contact.position.y = 0.03;
    this.contact.renderOrder = -1;
    this.root.add(this.contact);

    this.torso = new THREE.Mesh(g.torso, this.bodyMaterial);
    this.torso.position.y = 1.12;
    this.root.add(this.torso);

    const neck = new THREE.Mesh(g.neck, this.limbMaterial);
    neck.position.y = 1.45;
    this.root.add(neck);

    // The head is its own pivot so it can look around without turning the body,
    // which is most of what makes a remote player read as awake.
    this.headPivot = new THREE.Group();
    this.headPivot.position.y = HEAD_Y;
    this.root.add(this.headPivot);

    this.head = new THREE.Mesh(g.head, this.bodyMaterial);
    this.head.scale.set(1, 1.06, 0.94);
    this.headPivot.add(this.head);

    this.hood = new THREE.Mesh(g.hood, this.hoodMaterial);
    this.headPivot.add(this.hood);

    // Colour written by `_dye` at the end of construction, like the three
    // surfaces above.
    this.glowMaterial = glowMaterial(new THREE.Color());
    this.glow = new THREE.Mesh(g.glow, this.glowMaterial);
    // Just outside the hood, so the aura is around the head rather than inside
    // the one solid thing that would occlude it.
    this.glow.scale.setScalar(1.32);
    this.headPivot.add(this.glow);

    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.23, SHOULDER_Y, 0);
      const limb = new THREE.Mesh(g.arm, this.limbMaterial);
      limb.position.y = -0.26;
      pivot.add(limb);
      this.root.add(pivot);
      this.arms.push({ pivot, side });
    }

    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.1, HIP_Y, 0);
      const limb = new THREE.Mesh(g.leg, this.limbMaterial);
      limb.position.y = -0.37;
      pivot.add(limb);
      this.root.add(pivot);
      this.legs.push({ pivot, side });
    }

    this._dye();
  }

  /**
   * Put this person in their own colour. The one place the recipe lives.
   *
   * Dyed wool, not plastic. The forest is greens and browns at low saturation,
   * and a person has to be findable in it without looking like a game piece
   * dropped into a photograph — so the hue is whatever they chose (or whatever
   * their id says), and the saturation is turned down until it reads as cloth.
   *
   * THE COLOUR SPACE ARGUMENT IS LOAD-BEARING. `Color.setHSL` defaults to the
   * *working* space, which is linear, so writing a lightness of 0.25 there
   * produces something that displays at about 0.54 — every avatar came out pale
   * and chalky, and the hood, which is supposed to be a near-black silhouette
   * cue at 0.11, rendered as mid slate and did not read at all. These three
   * numbers are perceptual lightnesses, so they are declared in the space
   * perceptual lightness means something in.
   *
   * ONE NUMBER IN, FOUR COLOURS OUT, and that is why the main menu chooses a hue
   * rather than a colour. The relationship between the body, the limbs, the hood
   * and the aura is the thing that makes a person read as a person at thirty
   * metres in fog; a menu that handed over finished colours would be a second
   * file with an opinion about it, and the hood would be the first casualty.
   *
   * WRITING COLOURS RATHER THAN REBUILDING MATERIALS. `needsUpdate` is not set
   * and must not be: a colour is a uniform, so re-dyeing somebody mid-session
   * costs three `setHSL` calls and no shader work at all. Rebuilding the
   * materials instead would recompile the living program on the frame somebody
   * across the clearing changed their coat.
   */
  _dye() {
    this.bodyMaterial.color.setHSL(this.hue, 0.34, 0.42, THREE.SRGBColorSpace);
    this.limbMaterial.color.setHSL(this.hue, 0.42, 0.25, THREE.SRGBColorSpace);
    this.hoodMaterial.color.setHSL(this.hue, 0.3, 0.11, THREE.SRGBColorSpace);
    // Left in the working (linear) space, unlike the three surfaces above: this
    // one is a quantity of light added to an HDR buffer, not a reflectance, and
    // light is linear.
    this.glowMaterial.uniforms.uColor.value.setHSL(this.hue, 0.75, 0.62);
  }

  // ----------------------------------------------------------------- network

  /** A transform straight off the wire. */
  push(sample) {
    const now = performance.now();
    const last = this._buffer[this._buffer.length - 1];
    // Arrival order is not guaranteed. A sample from the past would drag the
    // interpolator backwards and show as a twitch.
    if (last && now < last.t) return;
    this._buffer.push({ t: now, x: sample.x, y: sample.y, z: sample.z, yaw: sample.yaw, pitch: sample.pitch });
    if (this._buffer.length > BUFFER_LIMIT) this._buffer.shift();

    this.voice = sample.voice;
    this.trip = sample.trip;
    this.flags = sample.flags;
  }

  _interpolate() {
    const buffer = this._buffer;
    if (buffer.length === 0) return;
    if (buffer.length === 1) {
      this.position.set(buffer[0].x, buffer[0].y, buffer[0].z);
      this.yaw = buffer[0].yaw;
      this.pitch = buffer[0].pitch;
      return;
    }

    const renderTime = performance.now() - INTERP_DELAY_MS;
    // Retire samples the cursor is fully past. Two are always kept so there is
    // something to interpolate between even when the network goes quiet.
    while (buffer.length > 2 && buffer[1].t < renderTime) buffer.shift();

    const a = buffer[0];
    const b = buffer[1];
    if (renderTime <= a.t) {
      this.position.set(a.x, a.y, a.z);
      this.yaw = a.yaw;
      this.pitch = a.pitch;
      return;
    }
    if (renderTime >= b.t) {
      /**
       * Past the newest sample: hold, do not extrapolate.
       *
       * Extrapolating from a velocity estimate is the standard trick and it is
       * wrong for a person on foot, because people change direction instantly.
       * Every extrapolated metre has to be taken back when the real sample
       * arrives, which is the overshoot-and-snap that makes remote players look
       * like they are being dragged on elastic. Holding still for 55 ms is
       * invisible; snapping back is not.
       */
      const newest = buffer[buffer.length - 1];
      this.position.set(newest.x, newest.y, newest.z);
      this.yaw = newest.yaw;
      this.pitch = newest.pitch;
      return;
    }

    const span = b.t - a.t;
    const t = span > 0 ? clamp01((renderTime - a.t) / span) : 1;
    this.position.set(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));
    // Through the short way round, or a player crossing north spins 350°.
    this.yaw = a.yaw + wrapAngle(b.yaw - a.yaw) * t;
    this.pitch = lerp(a.pitch, b.pitch, t);
  }

  // ------------------------------------------------------------------ update

  /**
   * @param {number} dt
   * @param {number} audible 0..1 — the envelope of what this peer's voice
   *   actually sounds like here. Falls back to the broadcast number only while
   *   the peer connection has not formed.
   */
  update(dt, audible = null) {
    this._interpolate();

    /**
     * Seed the motion history from the first real sample.
     *
     * Everything starts at the origin, so without this the first frame after
     * someone joins measures a jump of however far their spawn is from (0,0,0).
     * That spikes the speed estimate, which throws the legs into a full sprint
     * for a second and spins the body from north to wherever they are actually
     * facing — a visible pop, every single time anybody arrives.
     */
    if (!this._seeded) {
      this._seeded = true;
      this._last.copy(this.position);
      this._bodyYaw = this.yaw;
      this._headPitch = this.pitch;
    }

    const moved = Math.hypot(this.position.x - this._last.x, this.position.z - this._last.z);
    this._speed = dt > 0 ? damp(this._speed, moved / dt, 0.05, dt) : this._speed;
    this._last.copy(this.position);

    this.group.position.copy(this.position);

    // The body follows the head but lags it, so looking around does not swing
    // the torso. 0.09 is about a sixth of a second to catch up.
    this._bodyYaw = this._bodyYaw + wrapAngle(this.yaw - this._bodyYaw) * (1 - Math.exp(Math.log(0.09) * dt));
    this._headPitch = damp(this._headPitch, this.pitch, 0.05, dt);
    this.root.rotation.y = this._bodyYaw;
    this.headPivot.rotation.set(this._headPitch * 0.8, wrapAngle(this.yaw - this._bodyYaw), 0, 'YXZ');

    this._animate(dt);

    const level = audible === null ? this.voice : audible;
    this._glowLevel = damp(this._glowLevel, clamp01(level), 0.03, dt);
    /**
     * The chat flash decays on its own clock, fast, and is ADDED to the speech
     * level rather than replacing it.
     *
     * Added, because a person who types while somebody is talking should not
     * make their own aura dimmer; and fast, because a message is an instant and
     * a held glow would read as a person who has started speaking and not
     * stopped. Half a second is long enough to catch out of the corner of an eye
     * across a clearing.
     */
    this._pulse = damp(this._pulse, 0, 0.004, dt);
    this.glowMaterial.uniforms.uVoice.value = this._glowLevel + this._pulse * 0.85;
    this.glowMaterial.uniforms.uTrip.value = this.trip;
    // Borrowed from the shared block so a peer's aura breathes on the same
    // clock as everything else in the wood, whether or not you are tripping.
    this.glowMaterial.uniforms.uTime.value = tripUniforms.uTime.value;

    /**
     * Somebody else's trip, on their body.
     *
     * A dim emissive lift and nothing more. It cannot be a colour change,
     * because the trip's own regional colour field is already recolouring
     * everything in view and a second hue signal would be lost inside it; it
     * cannot be motion, because they are already being melted by `uFlow` like
     * every other prop. Light coming out of a person is the one channel the
     * world is not already using, and it reads instantly at any distance: they
     * are lit from inside and you are not.
     */
    const inner = this.trip * (0.19 + 0.11 * Math.sin(tripUniforms.uTime.value * 0.73));
    this.bodyMaterial.emissive.setHSL(this.hue, 0.6, inner);
    this.limbMaterial.emissive.setHSL(this.hue, 0.6, inner * 0.6);
  }

  _animate(dt) {
    /**
     * The two poses, blended in over the walk cycle rather than replacing it.
     *
     * Everything below still runs — the stride still advances, the arms still
     * swing — and the pose is mixed on top by `lerp`. That is what makes the
     * transitions free: standing up from a bench while already walking is a
     * blend from one valid pose to another, and there is no state in which the
     * legs are half in one system and half in the other.
     */
    const sitting = (this.flags & FLAG_SITTING) !== 0;
    const fishing = (this.flags & FLAG_FISHING) !== 0;
    this._sit = damp(this._sit, sitting ? 1 : 0, 0.02, dt);
    this._rodOut = damp(this._rodOut, fishing ? 1 : 0, 0.05, dt);

    const walking = this._speed > WALK_THRESHOLD && this._sit < 0.5;
    if (walking) {
      // Phase advances with distance covered, not with time, so the feet stay
      // planted at every speed instead of scrubbing.
      this._stride += (this._speed * dt) / STRIDE_M;
      this._walkPhase = this._stride * Math.PI * 2;
    } else {
      this._walkPhase = damp(this._walkPhase % (Math.PI * 2), 0, 0.1, dt);
      this._stride = this._walkPhase / (Math.PI * 2);
    }

    // Amplitude tops out at a run (8.2 m/s in controller.js).
    const amplitude = clamp01(this._speed / 5) * 0.62;
    const swing = Math.sin(this._walkPhase) * amplitude;

    const sit = this._sit;
    /**
     * Sitting: thighs forward, knees down, torso lowered.
     *
     * The legs are single capsules with one pivot at the hip, so there is no
     * knee to bend — the thigh goes forward and the whole limb follows, which
     * from any distance reads correctly because the silhouette of a seated
     * person is dominated by the horizontal thigh and the dropped hip, not by
     * the shin. Faking the knee by shortening the limb was tried and looks like
     * an amputee; leaving it straight looks like somebody sitting on a low log,
     * which is what they are doing.
     */
    this.legs[0].pivot.rotation.x = lerp(swing, -1.42, sit);
    this.legs[1].pivot.rotation.x = lerp(-swing, -1.42, sit);
    this.legs[0].pivot.rotation.z = lerp(0, -0.13, sit);
    this.legs[1].pivot.rotation.z = lerp(0, 0.13, sit);

    /**
     * Arms: swinging, or resting on the knees, or holding a rod.
     *
     * The rod wins over both, because it is the most specific. Two hands at
     * different heights on the same imaginary shaft is what makes a rod look
     * held rather than glued to a wrist — the leading arm is nearly straight out
     * and the trailing one is tucked in at the hip.
     */
    const rod = this._rodOut;
    const bite = (this.flags & FLAG_BITE) !== 0 ? 1 : 0;
    const jerk = bite ? Math.sin(tripUniforms.uTime.value * 17) * 0.18 : 0;
    const armX = lerp(lerp(-swing * 0.75, -0.62, sit), -1.15 + jerk, rod);
    const armX2 = lerp(lerp(swing * 0.75, -0.62, sit), -0.62 + jerk * 0.6, rod);
    this.arms[0].pivot.rotation.x = armX;
    this.arms[1].pivot.rotation.x = armX2;
    this.arms[0].pivot.rotation.z = lerp(-0.11, -0.42, rod);
    this.arms[1].pivot.rotation.z = lerp(0.11, 0.26, rod);

    // A small vertical bob on the stride, so walking has weight. Twice the
    // stride frequency because both feet land per cycle.
    const bob = walking ? Math.abs(Math.sin(this._walkPhase)) * amplitude * 0.055 : 0;
    /**
     * -0.44 m of hip drop, which is the difference between eye height standing
     * (1.68 in controller.js) and seated (seat + 0.86 in seats.js) for a log
     * bench 0.48 off the ground. The two numbers were derived independently and
     * agree to a centimetre, which is the only reason a seated avatar's head
     * ends up where a seated player's camera is.
     */
    this.root.position.y = lerp(bob, -0.44, sit);
    this.contact.position.y = 0.03 - this.root.position.y;

    if (this.rod) {
      /**
       * The rod, angled up and out from the right hand.
       *
       * Parented to the ROOT rather than to the arm, and that is not laziness:
       * the arm is a capsule with a pivot at the shoulder and no hand on the end
       * of it, so a rod attached to it would rotate about the shoulder and swing
       * its butt through the avatar's chest. Hanging it off the body at the
       * position the hand happens to reach is both simpler and correct.
       */
      this.rod.visible = rod > 0.02;
      this.rod.position.set(0.3, 1.16, -0.24);
      this.rod.rotation.set(0, 0, 0);
      this.rod.rotateX(-1.0 - jerk * 0.4 - (1 - rod) * 0.9);
      this.rod.rotateZ(0.3);
      this.rod.scale.setScalar(0.35 + rod * 0.65);
    } else if (rod > 0.02) {
      this._buildRod();
    }

    // Idle breathing, so a person standing still is not a statue. Slow enough
    // to be felt rather than seen.
    if (!walking) {
      const breath = Math.sin(performance.now() * 0.0015) * 0.007;
      this.torso.scale.set(1 + breath, 1 - breath * 0.5, 1 + breath);
    } else {
      this.torso.scale.set(1, 1, 1);
    }
    // Leaning forward a little when seated, which is most of what stops a seated
    // figure reading as a mannequin dropped onto a bench.
    this.torso.rotation.x = lerp(0, 0.18, sit);
  }

  /**
   * Built on demand, the first time this person picks up a rod.
   *
   * Most people never fish, and a mesh plus a material per avatar for a thing
   * that is usually absent is a cost paid by the whole room for one person's
   * hobby. The geometry is shared; only the Mesh is new.
   */
  _buildRod() {
    this.rod = new THREE.Mesh(geometry().rod, this.limbMaterial);
    this.rod.name = 'rod';
    this.root.add(this.rod);
  }

  // ------------------------------------------------------------------ queries

  /** Where this person's mouth is, for the PannerNode. */
  headWorldPosition(out = this._head) {
    return out.set(this.position.x, this.position.y + HEAD_Y + this.root.position.y, this.position.z);
  }

  /** Which way the head is pointing, for the directivity cone. */
  headForward(out = this._forward) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  get speaking() {
    return this._glowLevel > 0.06;
  }

  setName(name) {
    this.name = name;
  }

  /**
   * Somebody changed their mind about who they are.
   *
   * Both halves in one call because to anybody watching they are one fact. The
   * hue goes back through `hueOf`, so clearing a chosen dye returns this person
   * to the colour their id gives them rather than leaving them at whatever they
   * last picked — which is the difference between "I have gone back to normal"
   * and "the message did nothing".
   *
   * @param {string} [name]
   * @param {number|null} [hue]
   */
  setLook(name, hue) {
    if (typeof name === 'string' && name) this.name = name;
    const dyed = hueOf(this.id, hue);
    if (dyed === this.hue) return;
    this.hue = dyed;
    this._dye();
  }

  dispose() {
    this.bodyMaterial.dispose();
    this.limbMaterial.dispose();
    this.hoodMaterial.dispose();
    this.glowMaterial.dispose();
    this.contact.material.dispose();
    this.group.removeFromParent();
  }
}
