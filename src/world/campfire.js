import * as THREE from 'three';
import { TAU, makeRng, rngRange } from '../core/util.js';
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
function flameMaterial() {
  return new THREE.ShaderMaterial({
    name: 'campfire-flame',
    uniforms: {
      uTime: tripUniforms.uTime,
      uLevel: tripUniforms.uLevel,
      uNoiseTex: tripUniforms.uNoiseTex,
      /** Day 0 .. night 1. A fire in sunlight is embers and a heat shimmer. */
      uNight: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      varying vec2 vP;
      varying float vSeed;
      void main() {
        vP = uv;
        vSeed = aSeed;
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

      void main() {
        // uv.y runs 0 at the fuel to 1 at the tip.
        float h = vP.y;
        float x = vP.x - 0.5;

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
function emberMaterial() {
  return new THREE.ShaderMaterial({
    name: 'campfire-embers',
    uniforms: {
      uTime: tripUniforms.uTime,
      uNoiseTex: tripUniforms.uNoiseTex,
      uNight: { value: 1 },
      uPixelRatio: { value: 1 },
    },
    vertexShader: /* glsl */ `
      ${NOISE3}
      attribute float aSeed;
      uniform float uTime;
      varying float vLife;
      varying float vSeed;
      void main() {
        vSeed = aSeed;
        // Each ember has its own rise time, between 2.6 and 5.4 seconds.
        float span = 2.6 + fract(aSeed * 17.13) * 2.8;
        float life = fract(uTime / span + fract(aSeed * 91.7));
        vLife = life;

        vec3 p = position;
        // Up, decelerating: an ember is buoyant and loses heat as it climbs.
        p.y += life * (1.15 + fract(aSeed * 3.7) * 1.5) * (1.0 - life * 0.35);
        // …and out, because the column spreads.
        float a = aSeed * 6.2831;
        float drift = life * life * (0.30 + fract(aSeed * 5.1) * 0.5);
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
  const indices = new Uint16Array(cardCount * 6);

  const emberPositions = new Float32Array(sites.length * EMBERS * 3);
  const emberSeeds = new Float32Array(sites.length * EMBERS);

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

    // Flame cards, in world space, standing on the fuel.
    const height = radius * 1.75;
    const half = radius * 0.86;
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
  flameGeo.setIndex(new THREE.BufferAttribute(indices, 1));
  flameGeo.computeBoundingSphere();
  const flames = new THREE.Mesh(flameGeo, flameMaterial());
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
  emberGeo.computeBoundingSphere();
  /**
   * The bounding sphere is computed from the SPAWN points, and the shader lofts
   * every ember up to 2.6 m above them. Without this the cloud is culled the
   * moment the fire's base leaves the frustum, so looking up at the sparks over
   * a fire makes them vanish. Growing the radius is cheaper than the alternative
   * of disabling frustum culling on a Points that is usually off screen.
   */
  emberGeo.boundingSphere.radius += 3.2;
  const embers = new THREE.Points(emberGeo, emberMaterial());
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
      light.intensity = 2.7 * wobble * reach * (0.28 + 0.72 * night);
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
