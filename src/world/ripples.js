import * as THREE from 'three';
import { WATER_LEVEL } from './terrain.js';
import { tripUniforms } from '../trip/living.js';

/**
 * Rings on the water.
 *
 * WHY THIS EXISTS. Because until it did, nothing that touched the river left a
 * mark on it. A fish rose to the film and dropped back and the surface did not
 * notice; a float landed on it and `splash` played a sound and the water stayed
 * exactly as it was. That is the same class of error as an object with no
 * shadow: the thing is rendered, the world it is in does not agree that it
 * happened, and the eye reads the mismatch long before it can name it.
 *
 *
 * THE REAL RISK HERE IS THAT IT LOOKS CHEAP, and it is worth being explicit
 * about, because a hard-edged expanding circle is the single most placeholder
 * thing water can do — everybody's first particle system has one and everybody
 * recognises it. Four decisions are all about that and nothing else:
 *
 *   THREE RINGS, NOT ONE, at different speeds and starting at different times.
 *   A disturbance on water makes a wave TRAIN. One ring is a shockwave in a
 *   cartoon; three that spread apart as they go is a splash.
 *
 *   CREST AND TROUGH, NOT JUST CREST. Each ring is drawn from a SIGNED profile
 *   — pale on the outside of the crest where it catches the sky, dark on the
 *   inside where it is tipped away from it. A ring that only ever brightens is
 *   a decal; a ring with a dark side is a shape in the surface. This is the one
 *   thing here that costs anything and it is by far the best value.
 *
 *   PEAK ALPHA UNDER 0.25. Water rings are a modulation of a reflection, not
 *   paint. Anything you can see clearly on a still frame is far too strong.
 *
 *   IT NEVER REACHES ITS OWN QUAD'S EDGE. The alpha is multiplied by a radial
 *   fade that has reached zero well before the corner. Skipping this is how the
 *   mist sheets in atmosphere.js ended up showing a straight rectangular seam
 *   across a golden-hour photograph, and a translucent rectangle drawn on a
 *   river would be worse, because there is nothing else out there to hide it.
 *
 *
 * WHAT IT COSTS, AND WHY IT IS A FIXED POOL.
 *
 * One draw call, twenty-four instances of two triangles, and NO per-frame CPU
 * at all — there is no update(). Every instance's whole animation is a function
 * of `uTime - aBorn`, so a ring that is spawned is finished with as far as the
 * main thread is concerned. Spawning is a ring-buffer write of one matrix and
 * two floats with an update range on each, which is the smallest upload three
 * will do.
 *
 * A DEAD INSTANCE COSTS NOTHING BUT ITS VERTEX SHADER. Out of its life window
 * the vertex stage throws the quad off-screen rather than scaling it to zero:
 * a degenerate triangle still gets set up and can still rasterise a pixel on
 * some hardware, and this is four vertices and a guaranteed nothing.
 *
 * TWENTY-FOUR because the pool only ever has to cover what is audible: the
 * shoal is 36 fish over a hundred metres of river with rises seconds apart, and
 * a float lands once a cast. If it ever does overflow, the oldest ring is
 * overwritten mid-life, which is a ring that vanishes — visible only if you
 * were looking at that exact spot. Growing the pool is one constant and one
 * more kilobyte; it has not been needed.
 *
 * NOT USED FOR RAIN. Rain on the water is already drawn, per pixel, by the ring
 * lattice inside the water shader itself — see the uRain block in `buildWater`.
 * That is thousands of rings for the cost of some arithmetic on fragments that
 * were being shaded anyway, and feeding a downpour through a 24-slot pool of
 * quads would be both worse-looking and vastly more expensive.
 */

/** Slots in the ring buffer. See the note above on why twenty-four. */
const MAX = 24;

/**
 * How far above the waterline the quads sit.
 *
 * The water writes no depth (see `buildWater`), so this is not fighting the
 * river — it is clearing the BED, which is opaque and can come up to within a
 * few centimetres of the surface in the margins. Two centimetres is under the
 * bed noise's own amplitude, so a ring in the shallows still sinks into the
 * gravel where the gravel is genuinely higher, which is correct.
 */
const LIFT = 0.02;

let _rig = null;

/**
 * @param {THREE.Scene} scene
 */
export function buildRipples(scene) {
  /**
   * A unit quad lying flat, scaled per instance.
   *
   * PlaneGeometry then rotateX, exactly as the water plane does it, so the two
   * agree about which way up is without anybody having to think about it. The
   * quad is one metre and the instance matrix carries the real size, which is
   * what lets a fish's rise and a float's splash be the same geometry.
   */
  const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
  geo.rotateX(-Math.PI / 2);

  const aBorn = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
  const aStrength = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
  aBorn.setUsage(THREE.DynamicDrawUsage);
  aStrength.setUsage(THREE.DynamicDrawUsage);
  // Born a long time in the past, so every slot starts dead rather than
  // starting at age zero and firing a ring at the origin on the first frame.
  aBorn.array.fill(-1000);
  geo.setAttribute('aBorn', aBorn);
  geo.setAttribute('aStrength', aStrength);

  const material = new THREE.ShaderMaterial({
    name: 'ripple',
    transparent: true,
    // Transparent, over a surface that is itself transparent and also does not
    // write depth. Nothing may write depth in this stack or the next thing in
    // the queue loses to it — the same trap documented at length on the water.
    depthWrite: false,
    // Depth TEST stays on, which is what keeps a ring behind a reed or under
    // the ferry's hull where it belongs.
    depthTest: true,
    uniforms: {
      // Shared with everything else in the world, so a ring cannot drift out of
      // step with the surface it is on. It is also why there is no update():
      // this uniform is already being written every frame by somebody else.
      uTime: tripUniforms.uTime,
      /** The lit side of a crest. Pale, and biased toward the sky, not white. */
      uCrest: { value: new THREE.Color(0.82, 0.90, 0.94) },
      /** The far side of the same crest, tipped away from the sky. */
      uTrough: { value: new THREE.Color(0.06, 0.13, 0.12) },
    },
    vertexShader: /* glsl */ `
      attribute float aBorn;
      attribute float aStrength;
      uniform float uTime;
      varying vec2 vLocal;
      varying float vAge;
      varying float vStr;
      void main() {
        // A bigger disturbance rings for longer as well as further. 1.5 s for a
        // minnow dimpling the film, 2.4 s for a float landing; beyond about
        // three seconds a ripple on a moving stream has been carried away and
        // this has no advection, so long lives would read as a stationary
        // pattern on running water.
        float life = mix(1.5, 2.4, aStrength);
        float t = (uTime - aBorn) / life;
        vAge = t;
        vStr = aStrength;
        // The unit quad's corners are at +/-0.5, so this is +/-1 across it.
        vLocal = position.xz * 2.0;
        if (t < 0.0 || t > 1.0) {
          // Dead. Thrown outside the clip volume rather than scaled to zero —
          // see the note on dead instances in the header.
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix
                    * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uCrest;
      uniform vec3 uTrough;
      varying vec2 vLocal;
      varying float vAge;
      varying float vStr;

      void main() {
        float r = length(vLocal);
        // The quad is square and the ripple is round; the corners are 41% of
        // the quad's area and none of its picture.
        if (r > 1.0) discard;

        float t = vAge;

        /**
         * THREE RINGS, SPREADING APART.
         *
         * The leading ring runs at full speed; the two behind it are slower AND
         * launched late, so the gaps between them open as the train goes out.
         * Equal speeds would keep three concentric circles rigidly spaced,
         * which is a target, not a splash.
         *
         * The widths grow with radius because a real crest flattens as its
         * energy is spread around a longer circumference — and it is also what
         * stops the outermost ring from aliasing into a wire as it thins.
         */
        float mag = 0.0;
        float tone = 0.0;
        for (int i = 0; i < 3; i++) {
          float k = float(i);
          float speed = 1.0 - k * 0.27;
          float delay = k * 0.09;
          float weight = 1.0 - k * 0.31;
          float rad = (t - delay) * speed;
          if (rad <= 0.0) continue;
          float w = 0.055 + rad * 0.20;
          float e = (r - rad) / w;
          float m = (1.0 - min(abs(e), 1.0)) * weight;
          // SIGNED: +1 just inside the crest, -1 just outside. This is the
          // whole of the difference between a ring in the water and a ring
          // painted on it — see the header.
          mag += m;
          tone += m * clamp(-e, -1.0, 1.0);
        }
        if (mag <= 0.0001) discard;

        /**
         * The envelope. In fast — the disturbance is instantaneous — and out on
         * a curve steeper than linear, because the last third of a ripple's
         * life is the part nobody watches and a linear fade leaves a visible
         * faint ring hanging about for half a second.
         */
        float env = smoothstep(0.0, 0.08, t) * pow(1.0 - t, 1.6);

        /**
         * AND IT NEVER REACHES THE EDGE OF ITS OWN QUAD. Zero by r = 1 with
         * room to spare. This is the line that stops this being a translucent
         * rectangle lying on a river; see the header on the mist sheets.
         */
        float inside = 1.0 - smoothstep(0.62, 0.96, r);

        // Peak alpha: 0.10 for the smallest disturbance, 0.24 for the largest.
        // Both are under the 0.25 the header commits to.
        float alpha = mag * env * inside * (0.10 + 0.14 * vStr);
        if (alpha < 0.004) discard;

        vec3 col = mix(uTrough, uCrest, clamp(tone / max(mag, 0.0001), -1.0, 1.0) * 0.5 + 0.5);
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const mesh = new THREE.InstancedMesh(geo, material, MAX);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  /**
   * ABOVE THE WATER AND ABOVE THE FISH IN THE QUEUE.
   *
   * The water is renderOrder 2 and the shoal is 3, and none of the three writes
   * depth — so within the transparent pass the only thing deciding which lands
   * on top is this number. 4 rather than 3: sharing the shoal's order would
   * leave the two to three's back-to-front distance sort, which happens to give
   * the right answer for a fish under a ring and the wrong one for a fish that
   * has just jumped through it, and a ring on the water is on top of everything
   * in the water by definition.
   */
  mesh.renderOrder = 4;
  /**
   * Twenty-four quads whose instance matrices move all over the world, against
   * a bounding sphere three computes once. There is nothing to cull here that
   * is worth the risk of culling it wrongly.
   */
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  scene.add(mesh);

  const _m = new THREE.Matrix4();
  let next = 0;

  /**
   * @param {number} x world x
   * @param {number} z world z
   * @param {number} strength 0 a fish dimpling the film, 1 a float landing hard
   */
  function spawn(x, z, strength = 0.5) {
    const s = Math.min(1, Math.max(0, strength));
    const i = next;
    next = (next + 1) % MAX;
    // The quad's world size. 0.55 m across for the smallest, 1.9 m for the
    // largest — which, with the envelope above, is a ring fully gone before it
    // has travelled a metre from where it started. Two metres was the ceiling
    // this was designed against and nothing here reaches it.
    const span = 0.55 + 1.35 * s;
    _m.makeScale(span, 1, span);
    _m.setPosition(x, WATER_LEVEL + LIFT, z);
    mesh.setMatrixAt(i, _m);
    aBorn.array[i] = tripUniforms.uTime.value;
    aStrength.array[i] = s;
    // One instance's worth of each, rather than three whole buffers. The
    // matrix is sixteen floats at offset i*16; the other two are one each.
    mesh.instanceMatrix.addUpdateRange(i * 16, 16);
    mesh.instanceMatrix.needsUpdate = true;
    aBorn.addUpdateRange(i, 1);
    aBorn.needsUpdate = true;
    aStrength.addUpdateRange(i, 1);
    aStrength.needsUpdate = true;
  }

  _rig = { mesh, material, spawn };
  return {
    mesh,
    material,
    ripple: spawn,
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      material.dispose();
      if (_rig && _rig.mesh === mesh) _rig = null;
    },
  };
}

/**
 * Put a ring on the water at (x, z).
 *
 * A FREE FUNCTION OVER A MODULE SINGLETON, deliberately, and it is the only
 * place in this file where that shape is worth it. The things that disturb
 * water are scattered across shoal.js, fishing.js and main.js and none of them
 * has any other reason to know this system exists; threading a handle through
 * three modules so that a fish can make a ring would put the plumbing in three
 * files that would then have to keep it. A no-op before `buildRipples` has run
 * is the correct behaviour for every one of those callers.
 *
 * Silently does nothing if the ripples were never built, which is what a
 * headless or cut-down build should get.
 *
 * @param {number} x
 * @param {number} z
 * @param {number} [strength] 0..1 — see `spawn`
 */
export function ripple(x, z, strength = 0.5) {
  if (_rig) _rig.spawn(x, z, strength);
}
