import * as THREE from 'three';
import { TAU, damp, makeRng, rngRange } from '../core/util.js';
import { NOISE3, makeLiving, tripUniforms } from '../trip/living.js';

/**
 * Fires.
 *
 * A campfire is the oldest piece of social architecture there is: it gives a
 * group a centre, a reason to face inward, and something to look at that is not
 * each other, which is what lets a conversation have gaps in it without the gaps
 * being awkward. Everything about how these are built follows from wanting
 * several of them scattered through the world rather than one.
 *
 *
 * FOUR DRAW CALLS FOR EVERY FIRE IN THE WORLD, AND THAT IS THE WHOLE DESIGN.
 *
 * The obvious build is a Group per fire containing stones, logs, flame cards and
 * embers. Twelve fires is then something like sixty draws and sixty matrix
 * updates for a feature that is mostly a few hundred triangles. Fires never
 * move, so instead every fire's geometry is baked into world space once and
 * merged: one InstancedMesh for all the stones, one for all the logs, ONE
 * geometry holding every flame card in the world, and one Points for every
 * ember. A per-vertex `aSeed` gives each fire its own flicker phase so they do
 * not burn in lockstep. Adding the thirteenth fire costs nothing.
 *
 *
 * ONE LIGHT, WHICH MOVES.
 *
 * The tempting thing is a PointLight per fire. In three, the number of lights is
 * compiled into every material's program — so twelve fires is `NUM_POINT_LIGHTS
 * 12`, which is twelve light evaluations per fragment on every lit surface in a
 * forest that is already fill-bound, to light up eleven fires nobody is standing
 * at. So there is exactly one, and it migrates to whichever fire is nearest the
 * camera, fading out and in across the handover. Two fires close enough for the
 * swap to be visible would have to be within a few metres of each other, and
 * `gathering.js` does not place them like that.
 *
 * The light does not cast shadows. A shadow-casting point light is six shadow
 * renders, and this project spent an entire optimisation pass getting the count
 * of shadow renders down from every frame to seven a minute.
 */

/** Cards per fire. Three at 60° reads as volume from every angle; two does not. */
const CARDS = 3;
/** Embers per fire. */
const EMBERS = 14;

/**
 * ==== COMPANY: THE FIRE KNOWS HOW MANY PEOPLE ARE SITTING AT IT ============
 *
 * The whole of gathering.js exists to give people somewhere to be, and until
 * now the fire burnt at exactly the same height whether one person or five were
 * on its logs. That is the one thing a fire is for. A fire that grows when the
 * room fills up is the cheapest social signal in the project: from thirty
 * metres through the trees you can see that there is somebody there.
 *
 * NOTHING NEW GOES ON THE WIRE, and that is what made it affordable. Positions
 * and a sitting flag are already in every 18 Hz pose row, so every client can
 * count the seated bodies inside a hearth's ring and arrive at the same number
 * independently — the same zero-byte trick gathering.js already uses to put two
 * people at the same fire without either of them saying where it is. See
 * `setCompany` and the block above it in gathering.js.
 *
 * IT DOES NOT TOUCH THE BAKED GEOMETRY, which is the constraint that shaped
 * everything below. Every flame card in the world is merged into ONE world-space
 * buffer on purpose (see the four-draw-calls block above), so "make the fire
 * bigger" must not mean "move a vertex" — rewriting positions would mean
 * uploading the whole buffer whenever anybody stood up. The flame's height and
 * width are already shader quantities, so the growth is a uniform.
 *
 * A PER-VERTEX SITE INDEX AND A SMALL UNIFORM ARRAY. `aSite` is baked once and
 * never changes; `uCompany[]` is one float per fire, updated on the CPU at
 * whatever rate the caller likes. Dynamic indexing of a uniform array in a
 * shader is a WebGL2/GLSL ES 3.00 facility and three has been WebGL2-only since
 * r163, so it is available; on the old ESSL 1.00 path it would have been
 * illegal and this would have had to be a per-vertex attribute updated every
 * frame instead.
 *
 * THE CARDS ARE BAKED AT FULL SIZE AND THE SHADER SHRINKS THEM BACK. A card is
 * a fixed quad, so a flame cannot grow past its own geometry; so the quad is
 * built `TALL`× higher and `WIDE`× broader than the sober flame needs and the
 * fragment shader divides both back out. At `uCompany = 0` the arithmetic is
 * exactly the identity — the same flame in the same world-space place, to the
 * float — and the only cost is that the top 35% of a lonely fire's card
 * discards on the first line. That is a few hundred pixels.
 */
const FLAME_TALL = 1.55;
const FLAME_WIDE = 1.32;
/**
 * The same two as GLSL float literals, and this is not decoration: `1.55`
 * interpolates fine but a future `2` would emit `2`, which is an INT in GLSL,
 * and `2 - 1.0` does not compile. `toFixed` makes the shader immune to what
 * somebody types above.
 */
const FLAME_TALL_F = FLAME_TALL.toFixed(4);
const FLAME_WIDE_F = FLAME_WIDE.toFixed(4);
/**
 * How many seated bodies is "full".
 *
 * A hearth's ring is five logs of two seats, and the commons has fourteen; but
 * the curve wanted here is not "what fraction of the seats are taken", it is
 * "is this a fire somebody is at". One person should already be visible from
 * the tree line, so the first body is worth a quarter of the whole effect and
 * the fourth finishes it. Past four it saturates rather than continuing, which
 * is right: a crowded fire is not a bonfire.
 */
const COMPANY_FULL = 4;
/**
 * Fraction of the way still to go after one second — `damp`'s convention.
 *
 * 0.6 arrives 95% of the way in six seconds, which is the number the brief
 * asked for and is chosen against a specific failure: somebody standing up to
 * fetch something must not snuff the fire. Six seconds is longer than any
 * shuffle and shorter than a departure.
 *
 * It is also what keeps this legal under the flicker rule. The trip's law is
 * that nothing may modulate luminance above 3 Hz; a six-second ease is 0.16 Hz
 * at its very fastest, three orders of magnitude clear, and the flame's own
 * flicker is unchanged.
 */
const COMPANY_SMOOTH = 0.6;

const _v = new THREE.Vector3();

/**
 * The flame.
 *
 * Additive, unlit, depth-tested but not depth-writing, and drawn late — the
 * standard recipe for something that is light rather than surface. The shape
 * lives entirely in the fragment shader as a function of the card's own uv, so
 * the geometry is a quad and the silhouette can flicker without touching a
 * vertex buffer.
 */
function flameMaterial(company) {
  return new THREE.ShaderMaterial({
    name: 'campfire-flame',
    uniforms: {
      uTime: tripUniforms.uTime,
      uLevel: tripUniforms.uLevel,
      uNoiseTex: tripUniforms.uNoiseTex,
      /** Day 0 .. night 1. A fire in sunlight is embers and a heat shimmer. */
      uNight: { value: 1 },
      /** One eased 0..1 per fire. See the COMPANY block at the top. */
      uCompany: { value: company },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      attribute float aSite;
      uniform float uCompany[${company.length}];
      varying vec2 vP;
      varying float vSeed;
      varying float vComp;
      void main() {
        vP = uv;
        vSeed = aSeed;
        // Looked up here rather than in the fragment stage: it is constant over
        // a card, so this is one indexed fetch per vertex instead of one per
        // pixel of an additive quad that is mostly overdraw.
        vComp = uCompany[int(aSite)];
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE3}
      uniform float uTime;
      uniform float uLevel;
      uniform float uNight;
      varying vec2 vP;
      varying float vSeed;
      varying float vComp;

      void main() {
        /**
         * COMPANY, and the identity at zero.
         *
         * The card is baked ${FLAME_TALL} times taller and ${FLAME_WIDE} times
         * wider than the sober flame needs (see the COMPANY block in
         * campfire.js), so the whole of the growth is these two divisions. At
         * vComp = 0, grow and spread are 1 and h and x come out as exactly
         * uv.y * TALL and (uv.x - 0.5) * WIDE — which is the same WORLD
         * position for a given h and x as the smaller card gave, because the
         * quad grew by the same factors. Everything below is untouched.
         */
        float grow = 1.0 + vComp * (${FLAME_TALL_F} - 1.0);
        float spread = 1.0 + vComp * (${FLAME_WIDE_F} - 1.0);
        // uv.y runs 0 at the fuel to 1 at the tip of the flame — NOT of the card.
        float h = vP.y * (${FLAME_TALL_F} / grow);
        // Above the flame's own tip there is nothing, and this is a real early
        // out rather than a tidiness: the envelope below is a polynomial in h
        // that is not guaranteed to be negative past 1, so it must not be
        // evaluated there.
        if (h > 1.0) discard;
        float x = (vP.x - 0.5) * (${FLAME_WIDE_F} / spread);

        /**
         * The lick.
         *
         * Two noise fields at different rates, one slow and wide (the whole
         * flame leaning) and one fast and narrow (the tips tearing off). Both
         * are scaled by height, because a flame is pinned at the bottom — a
         * uniform displacement would slide the entire fire sideways off its own
         * fuel, which is the single most common way this effect goes wrong.
         */
        float t = uTime * 1.9 + vSeed * 37.0;
        float lean = rrFbm2(vec3(vSeed * 11.0, h * 1.6 - t * 0.55, 0.0)) * 0.34;
        float tear = rrNoise(vec3(vSeed * 5.0, h * 7.0 - t * 2.4, t * 0.3)) * 0.20;
        x -= (lean + tear) * h * h;

        /**
         * The envelope: a teardrop. Wide at the base, pinched to nothing at the
         * top, with the waist controlled by height so the shape is a flame
         * rather than a triangle.
         */
        float width = 0.30 * (1.0 - h) * (0.45 + 0.55 * (1.0 - h * h));
        float core = 1.0 - smoothstep(width * 0.35, width, abs(x));
        float body = 1.0 - smoothstep(width * 0.8, width * 1.9, abs(x));

        // Flames come and go. Each card has its own respiration.
        float breath = 0.72 + 0.28 * rrFbm2(vec3(vSeed * 3.0, t * 0.42, 7.0));
        float top = 1.0 - smoothstep(0.55 * breath, 1.0 * breath, h);

        float a = body * top;
        if (a < 0.004) discard;

        /**
         * Colour by temperature, not by a gradient texture. The centre of a wood
         * fire is around 1100 °C and its tips are half that, and the eye reads
         * the white-through-amber-through-blood ramp as heat rather than as
         * paint. The blue at the very base is the volatiles burning, and it is
         * the detail that stops the whole thing looking like orange smoke.
         */
        vec3 hot   = vec3(1.00, 0.86, 0.52);
        vec3 mid   = vec3(1.00, 0.44, 0.09);
        vec3 cool  = vec3(0.62, 0.10, 0.02);
        vec3 col = mix(mid, cool, smoothstep(0.25, 0.95, h));
        col = mix(col, hot, core * (1.0 - h * 0.7));
        col = mix(col, vec3(0.24, 0.42, 0.95), core * smoothstep(0.16, 0.0, h) * 0.55);

        /**
         * Brighter at night, and not merely for realism: this is an HDR buffer
         * with a bloom chain on it, and a fire at full strength under a midday
         * sky blooms into a white blob that reads as a bug. Daylight leaves the
         * embers and takes the glow.
         */
        float energy = (0.42 + 0.58 * uNight) * (0.8 + 0.5 * core);

        // The trip pushes the fire around the hue wheel with everything else.
        col = rrHueRotate(col, uLevel * rrFbm2(vec3(vP * 1.7, uTime * 0.14)) * 1.9);

        gl_FragColor = vec4(col * energy * a, a);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    // Additive blending is commutative, so three's BackSide/FrontSide split
    // buys nothing here but a second draw call and a uniform re-upload every
    // frame. See the shaft material in atmosphere.js for the full reasoning.
    forceSinglePass: true,
    toneMapped: false,
  });
}

/**
 * Embers, as one Points cloud for the whole world.
 *
 * Position is computed in the vertex shader from the point's own seed and the
 * clock, so the CPU never touches the buffer: an ember rises, drifts, cools and
 * loops on a period of its own, and the whole system is a hundred and sixty
 * points and no per-frame work at all.
 */
function emberMaterial(company) {
  return new THREE.ShaderMaterial({
    name: 'campfire-embers',
    uniforms: {
      uTime: tripUniforms.uTime,
      uNoiseTex: tripUniforms.uNoiseTex,
      uNight: { value: 1 },
      uPixelRatio: { value: 1 },
      /** The same array object the flame material holds. See `buildHearths`. */
      uCompany: { value: company },
    },
    vertexShader: /* glsl */ `
      ${NOISE3}
      attribute float aSeed;
      attribute float aSite;
      uniform float uTime;
      uniform float uCompany[${company.length}];
      varying float vLife;
      varying float vSeed;
      void main() {
        vSeed = aSeed;
        // Each ember has its own rise time, between 2.6 and 5.4 seconds.
        float span = 2.6 + fract(aSeed * 17.13) * 2.8;
        float life = fract(uTime / span + fract(aSeed * 91.7));
        vLife = life;

        /**
         * The embers take the same pair as the flame, and they have to: a fire
         * that has doubled in height with its spark column unchanged reads as a
         * flame card that has been scaled rather than as a bigger fire. There
         * is no baked-size trick needed here — an ember's whole trajectory is
         * computed in this shader, so the two factors go straight on it.
         */
        float comp = uCompany[int(aSite)];
        float grow = 1.0 + comp * (${FLAME_TALL_F} - 1.0);
        float spread = 1.0 + comp * (${FLAME_WIDE_F} - 1.0);

        vec3 p = position;
        // Up, decelerating: an ember is buoyant and loses heat as it climbs.
        p.y += life * (1.15 + fract(aSeed * 3.7) * 1.5) * (1.0 - life * 0.35) * grow;
        // …and out, because the column spreads.
        float a = aSeed * 6.2831;
        float drift = life * life * (0.30 + fract(aSeed * 5.1) * 0.5) * spread;
        p.x += cos(a) * drift + rrNoise(vec3(aSeed * 9.0, uTime * 0.7, 0.0)) * life * 0.3;
        p.z += sin(a) * drift + rrNoise(vec3(aSeed * 9.0, uTime * 0.7, 4.0)) * life * 0.3;

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        // Perspective-correct, and small: an ember is a spark, not a firefly.
        gl_PointSize = (5.5 + fract(aSeed * 23.0) * 4.0) / max(0.6, -mv.z) * 14.0;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uNight;
      varying float vLife;
      varying float vSeed;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = dot(d, d);
        if (r > 0.25) discard;
        // Bright at once, gone slowly, with a hard cut at the top of the life
        // so an ember dies rather than fading to a permanent ghost.
        float a = smoothstep(0.25, 0.0, r) * (1.0 - vLife) * smoothstep(0.0, 0.08, vLife);
        vec3 col = mix(vec3(1.0, 0.72, 0.28), vec3(0.75, 0.16, 0.03), vLife);
        gl_FragColor = vec4(col * (0.5 + 0.5 * uNight) * a, a);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
}

/**
 * Build every fire in the world in one pass.
 *
 * @param {THREE.Object3D} parent
 * @param {{x: number, y: number, z: number, radius?: number}[]} sites
 * @param {string} seed
 */
export function buildHearths(parent, sites, seed = 'grove-01') {
  const group = new THREE.Group();
  group.name = 'hearths';
  parent.add(group);

  const rng = makeRng(`${seed}:hearth`);

  // ---- stones and logs, instanced across every fire -----------------------
  const stoneGeo = new THREE.DodecahedronGeometry(0.26, 0);
  const stoneMat = makeLiving(new THREE.MeshLambertMaterial({ color: 0x6a6560 }), 'prop');
  const logGeo = new THREE.CylinderGeometry(0.085, 0.11, 1.15, 6);
  const logMat = makeLiving(new THREE.MeshLambertMaterial({ color: 0x3a2a1c }), 'prop');

  const stonesPerFire = 9;
  const logsPerFire = 4;
  const stones = new THREE.InstancedMesh(stoneGeo, stoneMat, sites.length * stonesPerFire);
  const logs = new THREE.InstancedMesh(logGeo, logMat, sites.length * logsPerFire);
  stones.name = 'hearth-stones';
  logs.name = 'hearth-logs';
  stones.castShadow = true;
  stones.receiveShadow = true;
  logs.castShadow = true;
  logs.receiveShadow = true;
  /**
   * Static, and told so. Without this three re-uploads the whole instance matrix
   * buffer whenever `instanceMatrix.needsUpdate` is set, and more importantly it
   * is a claim in the source that nothing here moves — which is the assumption
   * the merged flame geometry below is built on.
   */
  stones.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  logs.instanceMatrix.setUsage(THREE.StaticDrawUsage);

  // ---- flames: every card in the world in one buffer -----------------------
  const cardCount = sites.length * CARDS;
  const positions = new Float32Array(cardCount * 4 * 3);
  const uvs = new Float32Array(cardCount * 4 * 2);
  const seeds = new Float32Array(cardCount * 4);
  /**
   * Which fire each vertex belongs to. Baked once; never touched again.
   *
   * THE INVARIANT THAT MAKES THAT SAFE, WRITTEN DOWN BECAUSE IT IS NOWHERE
   * ELSE. `aSite` is an index into `sites`, and `uCompany[]` is declared in both
   * shaders with `sites.length` elements — so the buffer, the uniform array and
   * the `Int32Array` gathering.js counts into are three descriptions of one list
   * that must never disagree. They cannot today: `buildHearths` is called
   * exactly once, from `buildGathering`, which main.js calls once at module
   * scope, and no code path anywhere adds or removes a fire afterwards.
   *
   * ADDING A FIRE AT RUNTIME WOULD BREAK ALL THREE AT ONCE — a stale
   * `uCompany[]` length is a shader recompile, a stale `aSite` is a fire reading
   * somebody else's company, and a longer `counts` is silently ignored. If that
   * is ever wanted, the answer is to rebuild this whole object (it is four draw
   * calls and a few hundred triangles), not to patch the buffer.
   *
   * Baked as a float rather than as an integer attribute because `int(aSite)` in
   * the vertex shader wants one anyway, and every value here is a small exact
   * integer, so the truncation is exact.
   */
  const cardSites = new Float32Array(cardCount * 4);
  const indices = new Uint16Array(cardCount * 6);

  const emberPositions = new Float32Array(sites.length * EMBERS * 3);
  const emberSeeds = new Float32Array(sites.length * EMBERS);
  const emberSites = new Float32Array(sites.length * EMBERS);

  /**
   * How busy each fire is, 0..1, and the target it is easing toward.
   *
   * `company` IS the uniform's value array — both materials hold a reference to
   * this exact Float32Array, so `update` mutates one thing and two shaders see
   * it. `Math.max(1, …)` because `uniform float uCompany[0]` does not compile,
   * and a world with no fires at all is a legitimate outcome for a seed whose
   * site search found nowhere.
   */
  const company = new Float32Array(Math.max(1, sites.length));
  const companyWant = new Float32Array(company.length);

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  let card = 0;
  let ember = 0;

  sites.forEach((site, index) => {
    const radius = site.radius ?? 0.78;

    // Ring of stones.
    for (let i = 0; i < stonesPerFire; i++) {
      const a = (i / stonesPerFire) * TAU + rngRange(rng, -0.14, 0.14);
      const r = radius * rngRange(rng, 0.94, 1.08);
      const s = rngRange(rng, 0.72, 1.25);
      _v.set(site.x + Math.cos(a) * r, site.y + 0.06 * s, site.z + Math.sin(a) * r);
      quat.setFromEuler(new THREE.Euler(rng() * TAU, rng() * TAU, rng() * TAU));
      scale.set(s, s * 0.78, s);
      stones.setMatrixAt(index * stonesPerFire + i, matrix.compose(_v, quat, scale));
    }

    // Fuel: logs leaning into the middle, which is how anybody actually builds
    // one and reads instantly as "somebody made this".
    for (let i = 0; i < logsPerFire; i++) {
      const a = (i / logsPerFire) * TAU + rngRange(rng, -0.3, 0.3);
      const lean = rngRange(rng, 0.62, 0.86);
      _v.set(
        site.x + Math.cos(a) * radius * 0.42,
        site.y + 0.26,
        site.z + Math.sin(a) * radius * 0.42
      );
      quat.setFromEuler(new THREE.Euler(Math.cos(a) * lean, -a, Math.sin(a) * lean, 'ZXY'));
      scale.setScalar(rngRange(rng, 0.85, 1.15));
      logs.setMatrixAt(index * logsPerFire + i, matrix.compose(_v, quat, scale));
    }

    // Flame cards, in world space, standing on the fuel. Baked at the FULL
    // company size; the shader divides it back out. See the COMPANY block.
    const height = radius * 1.75 * FLAME_TALL;
    const half = radius * 0.86 * FLAME_WIDE;
    for (let c = 0; c < CARDS; c++) {
      const a = (c / CARDS) * Math.PI + index * 0.31;
      const dx = Math.cos(a) * half;
      const dz = Math.sin(a) * half;
      const base = card * 4;
      const y0 = site.y + 0.1;
      const y1 = y0 + height;
      // bottom-left, bottom-right, top-right, top-left
      const corners = [
        [site.x - dx, y0, site.z - dz, 0, 0],
        [site.x + dx, y0, site.z + dz, 1, 0],
        [site.x + dx, y1, site.z + dz, 1, 1],
        [site.x - dx, y1, site.z - dz, 0, 1],
      ];
      const cardSeed = index * 0.618 + c * 0.257;
      for (let k = 0; k < 4; k++) {
        positions[(base + k) * 3] = corners[k][0];
        positions[(base + k) * 3 + 1] = corners[k][1];
        positions[(base + k) * 3 + 2] = corners[k][2];
        uvs[(base + k) * 2] = corners[k][3];
        uvs[(base + k) * 2 + 1] = corners[k][4];
        seeds[base + k] = cardSeed;
        cardSites[base + k] = index;
      }
      const io = card * 6;
      indices[io] = base;
      indices[io + 1] = base + 1;
      indices[io + 2] = base + 2;
      indices[io + 3] = base;
      indices[io + 4] = base + 2;
      indices[io + 5] = base + 3;
      card += 1;
    }

    for (let e = 0; e < EMBERS; e++) {
      const a = rng() * TAU;
      const r = rng() * radius * 0.6;
      emberPositions[ember * 3] = site.x + Math.cos(a) * r;
      emberPositions[ember * 3 + 1] = site.y + 0.22;
      emberPositions[ember * 3 + 2] = site.z + Math.sin(a) * r;
      emberSeeds[ember] = rng();
      emberSites[ember] = index;
      ember += 1;
    }
  });

  stones.instanceMatrix.needsUpdate = true;
  logs.instanceMatrix.needsUpdate = true;
  group.add(stones, logs);

  const flameGeo = new THREE.BufferGeometry();
  flameGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  flameGeo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  flameGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  flameGeo.setAttribute('aSite', new THREE.BufferAttribute(cardSites, 1));
  flameGeo.setIndex(new THREE.BufferAttribute(indices, 1));
  flameGeo.computeBoundingSphere();
  const flames = new THREE.Mesh(flameGeo, flameMaterial(company));
  flames.name = 'hearth-flames';
  /**
   * Late, and after the leaves.
   *
   * `perf-audit-2026-08` records the explicit opaque draw order this project
   * uses to keep the ground working as an early-Z occluder. Additive
   * transparency has to come after all of it, or the fire is blended against
   * whatever happens to have been drawn so far and a trunk drawn afterwards
   * punches a hole in it.
   */
  flames.renderOrder = 2;
  flames.frustumCulled = true;
  group.add(flames);

  const emberGeo = new THREE.BufferGeometry();
  emberGeo.setAttribute('position', new THREE.BufferAttribute(emberPositions, 3));
  emberGeo.setAttribute('aSeed', new THREE.BufferAttribute(emberSeeds, 1));
  emberGeo.setAttribute('aSite', new THREE.BufferAttribute(emberSites, 1));
  emberGeo.computeBoundingSphere();
  /**
   * The bounding sphere is computed from the SPAWN points, and the shader lofts
   * every ember a long way above them. Without this the cloud is culled the
   * moment the fire's base leaves the frustum, so looking up at the sparks over
   * a fire makes them vanish. Growing the radius is cheaper than the alternative
   * of disabling frustum culling on a Points that is usually off screen.
   *
   * THE ARITHMETIC, WHICH WAS WRONG IN THE FIRST VERSION OF THIS COMMENT and is
   * worth writing out because the sphere it defends is invisible when it fails.
   * The vertex shader's rise is
   *
   *     life * (1.15 + fract(aSeed * 3.7) * 1.5) * (1.0 - life * 0.35) * grow
   *
   * and `life * (1 - 0.35 * life)` has its derivative `1 - 0.7 * life` still
   * positive at life = 1, so the maximum over the ember's whole life is at the
   * top of it: 0.65. With the amplitude at its ceiling of 2.65 that is 1.72 m
   * sober, not the 2.6 m this comment used to claim, and 2.67 m at full company.
   * Sideways it is `life² * 0.8 * spread` plus two `rrNoise` terms of ±0.3, so
   * at most 1.06 + 0.42 = 1.48 m. The worst displacement of any ember from its
   * spawn point is therefore hypot(2.67, 1.48) = 3.05 m.
   *
   * 3.2 + 2.6 * 0.55 = 4.63 m, which clears that by 1.58 m. The old number was
   * generous and the new one is more generous still; both are correct, and the
   * point of writing the measurement down is that the NEXT person to change
   * `FLAME_TALL` or the rise curve can check it in ten seconds instead of
   * discovering that the sparks over the busiest fire in the world pop out at
   * one particular camera angle. That is the same class of mistake as forgetting
   * the wider culling sphere on a leaning tree, and it only shows when somebody
   * sits down.
   */
  emberGeo.boundingSphere.radius += 3.2 + 2.6 * (FLAME_TALL - 1);
  const embers = new THREE.Points(emberGeo, emberMaterial(company));
  embers.name = 'hearth-embers';
  embers.renderOrder = 3;
  group.add(embers);

  // ---- the one light ------------------------------------------------------
  /**
   * Range 11 m, decay 1.6. Physically a fire falls off as the square, but the
   * inverse-square from a source this bright either blows out the first two
   * metres or lights nothing at four. 1.6 is the exponent at which a ring of
   * people around a fire are all lit and the trunks behind them are not.
   */
  const light = new THREE.PointLight(0xff9a4a, 0, 11, 1.6);
  light.name = 'hearth-light';
  light.castShadow = false;
  group.add(light);

  let lit = -1;
  let flicker = 0;

  return {
    group,
    flames,
    embers,
    stones,
    logs,
    light,
    sites,

    setPixelRatio(r) {
      embers.material.uniforms.uPixelRatio.value = r;
    },

    /**
     * How many seated bodies are at each fire, in `sites` order.
     *
     * A COUNT, NOT A FRACTION, because the caller is counting people and the
     * curve from people to flame height is this file's business — see
     * `COMPANY_FULL`. Short arrays are legal and mean "nobody at the rest",
     * which is what a caller who has only looked at the near fires should be
     * able to say without lying about the far ones.
     *
     * This is a TARGET. Nothing here is drawn until `update` has eased toward
     * it, which is what stops somebody standing up from snuffing a fire.
     */
    setCompany(counts) {
      for (let i = 0; i < companyWant.length; i++) {
        const n = counts && i < counts.length ? counts[i] : 0;
        companyWant[i] = n > 0 ? Math.min(1, n / COMPANY_FULL) : 0;
      }
    },

    /** 0 by day, 1 at night. Both materials and the light ride on it. */
    setNight(n) {
      flames.material.uniforms.uNight.value = n;
      embers.material.uniforms.uNight.value = n;
      this._night = n;
    },

    /**
     * @param {number} dt
     * @param {THREE.Camera} camera
     */
    update(dt, camera) {
      if (sites.length === 0) return;

      /**
       * Ease the company toward its target.
       *
       * A loop over a dozen floats once a frame, which is nothing, and it is
       * deliberately not gated on "has anything changed": the whole value of
       * the six-second constant is that the fire is still moving on the frames
       * when the count is not, and a dirty flag would make it jump.
       */
      for (let i = 0; i < company.length; i++) {
        company[i] = damp(company[i], companyWant[i], COMPANY_SMOOTH, dt);
      }

      /**
       * Find the nearest fire and put the light on it.
       *
       * A linear scan over a dozen sites once a frame, which is nothing, and it
       * is deliberately not cached against the camera's cell: the whole point is
       * that it is correct on the frame you walk past a fire, and a cache would
       * make correctness depend on a threshold nobody would ever tune.
       */
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < sites.length; i++) {
        const s = sites[i];
        const d = (s.x - camera.position.x) ** 2 + (s.z - camera.position.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }

      /**
       * Only move the light when it is dark enough not to matter.
       *
       * Snapping a point light between two positions is visible if it is lighting
       * anything, so the handover waits until the intensity has fallen to almost
       * nothing — which happens naturally, because the intensity falls off with
       * distance and the nearest fire only changes at the midpoint between two of
       * them. Beyond 26 m the light is off entirely and the move is free.
       */
      const distance = Math.sqrt(bestD);
      if (best !== lit && (light.intensity < 0.08 || distance > 26)) {
        lit = best;
        light.position.set(sites[best].x, sites[best].y + 0.7, sites[best].z);
      }

      /**
       * Flicker: two sines beating against each other, which is a much better
       * fire than a random walk. A random flicker reads as a bad bulb; a fire's
       * light has a slow surge under a fast tremble, and the beat between two
       * irrational-ish frequencies produces exactly that without any state.
       */
      flicker += dt;
      const wobble =
        0.82 + 0.13 * Math.sin(flicker * 8.3) + 0.09 * Math.sin(flicker * 3.1 + 1.7);
      const night = this._night ?? 1;
      const reach = Math.max(0, 1 - distance / 26);
      /**
       * …and a fire with people at it throws more light.
       *
       * Free — this is the one PointLight in the world and its intensity is
       * already recomputed every frame. `lit` rather than `best`, because the
       * light is standing at the fire it was last handed over to and it should
       * be as bright as THAT fire, not as the one it is about to move to.
       * Half again at full company is the same proportion as the flame's own
       * height, so the light and the thing making it agree.
       */
      const crowd = lit >= 0 && lit < company.length ? company[lit] : 0;
      light.intensity = 2.7 * wobble * reach * (0.28 + 0.72 * night) * (1 + 0.5 * crowd);
    },

    dispose() {
      stoneGeo.dispose();
      logGeo.dispose();
      stoneMat.dispose();
      logMat.dispose();
      flameGeo.dispose();
      flames.material.dispose();
      emberGeo.dispose();
      embers.material.dispose();
      group.removeFromParent();
    },
  };
}
