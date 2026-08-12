import * as THREE from 'three';
import { tripUniforms, NOISE3 } from '../trip/living.js';
import { FASTEST_USEFUL_PERIOD } from '../core/quality.js';

/**
 * The render pipeline.
 *
 *   1. scene  → sceneTarget    HDR colour
 *   2. bloom  → three mips     bright-pass, downsample, separable blur
 *   2b. glow  → accumulator    persistence, on the blurriest mip only
 *   3. output → the canvas     view breath, add bloom and wake, tone map,
 *                              sRGB, vignette
 *
 * THE RULE IS THAT NOTHING HERE MAY DRAW A BORDER. It is not, any longer, that
 * nothing here moves a pixel sideways — and the difference between those two
 * statements is the entire history of this file, so it is worth setting out.
 *
 * A displacing post-process lived here for most of the project's life: the
 * melt. It was as world-anchored as such a thing can be — reconstruct each
 * pixel's world position from depth, offset it by a divergence-free noise field
 * in world space, reproject, resample at the difference. It survived a long
 * time because that reasoning is correct as far as it goes, and it still had to
 * come out, because a BOUNDED screen-space resample is optically a sheet of
 * glass. Where the offset is locally constant the image is translated rigidly;
 * where it stops, there is a hard border with a displaced picture on one side
 * and the true one on the other. Panes, around every trunk. The silhouette
 * guard that kept it from smearing across depth edges only added more borders.
 *
 * The conclusion drawn at the time was "no displacement in post", and this
 * comment said so for months. That was the wrong lesson, and the right one is
 * narrower: the seam was the artefact, and the seam came from the offset being
 * bounded — which came from reading depth. The melt still displaces vertices
 * instead (see uFlow in trip/living.js), because a trunk that bends through the
 * field beats one that slides behind it and occlusion falls out of the depth
 * buffer for free. But the general prohibition it was filed under is gone.
 *
 * THE VIEW BREATH, in the output pass, is what replaced it. It reads no depth,
 * has no guard and is continuous across the whole frame, so there is nowhere
 * for a seam to be; the offset is bounded by construction and the read
 * rectangle is inset by exactly that bound, so it cannot clamp at the frame
 * edge either. It is the one thing in this file that reads the frame somewhere
 * other than where it writes, and the test any successor has to pass is not
 * "does it displace" but "can a person point at a line where the effect stops".
 *
 * Bloom and the glow accumulator are the other two exceptions to the older,
 * simpler rule, and they were always allowed: glare genuinely is a property of
 * the eye rather than of the world, and neither can move an edge — they can
 * only spread light that was already at that pixel.
 */

/**
 * DYNAMIC RESOLUTION, BY VIEWPORT.
 *
 * `renderScale` has existed as a menu control for a long time and it is the
 * biggest lever in the frame — 56% of it, measured. It has never been able to
 * respond to anything, because the path it takes is
 * `renderer.setPixelRatio` -> `pipeline.setSize` -> `sceneTarget.setSize`,
 * which REALLOCATES a multisampled half-float target. That is a hitch, so it
 * can only ever be a thing the player sets once, and the AutoGovernor driving
 * it works on a four-second window with a 2.5–8 s dwell. That controller
 * answers "this machine is too slow". It cannot answer "this FRAME is too
 * expensive", and a frame drop is precisely the second question.
 *
 * The per-frame version needs no reallocation at all. `sceneTarget` and the
 * three bloom mips stay at full size for ever; each frame the world is drawn
 * into the bottom-left sW x sH corner of the scene target with a matching
 * scissor, every post pass reads its source at `uv * s` and writes into its own
 * corner, and the output quad expands the corner back over the whole canvas.
 * `camera.aspect` never changes, because both axes scale together — so there is
 * no projection change, no reprojection and nothing pops.
 *
 * THE STALE-TEXEL TRAP, WHICH IS THE ONLY REAL HAZARD HERE. Everything outside
 * the corner still holds whatever was last rendered there, at some other scale.
 * A bilinear tap at the corner's edge reaches one texel past it, and the bloom
 * blur reaches 3.23 texels past it — so without a guard the frame would drag a
 * bright smear of the previous, larger frame in along its right and top edges.
 * Every pass therefore clamps its source coordinate to `(vw - 0.5) / w`, which
 * is the last valid texel centre. At s = 1 that clamp is EXACTLY what
 * CLAMP_TO_EDGE already does, so it is a no-op and the frame is bit-identical
 * to the one before this existed — checked per pass, and it matters, because
 * this machine will sit at s = 1 permanently.
 *
 * THE BLOOM RADIUS IS HELD IN SCREEN SPACE, NOT IN TEXELS. `uTexel` is scaled
 * by s, so the five-tap kernel spans the same fraction of the PICTURE at every
 * resolution. Left alone it would have spanned the same number of texels, and
 * at s = 0.6 that is a bloom 67% wider than the one that was tuned — a glare
 * that visibly swells as the controller works is exactly the "you can see it
 * happening" failure this has to avoid.
 *
 * THE GLOW ACCUMULATOR PING-PONGS ACROSS A SCALE CHANGE, so it is given its own
 * pair of read coordinates: `tCurrent` at this frame's scale and `tPrev` at the
 * one the buffer was written at. The wake therefore stays put in screen space
 * while the resolution moves under it, instead of jumping.
 *
 *
 * HOW THIS COEXISTS WITH THE AutoGovernor IN core/quality.js — worth spelling
 * out, because two controllers on one frame time is how you get a machine that
 * hunts for ever.
 *
 *   DIFFERENT SIGNAL. The governor reads wall-clock rAF intervals, which vsync
 *   quantises to exactly one period or exactly two — its own block comment
 *   explains at length that this is why its primary test is the FRACTION of
 *   late frames rather than a millisecond threshold. This reads GPU time from
 *   EXT_disjoint_timer_query_webgl2, which is continuous and is the thing being
 *   controlled. Neither is a proxy for the other.
 *
 *   DIFFERENT TIMESCALE, AND THE FAST ONE FINISHES FIRST. This evaluates every
 *   0.25 s and moves at most 0.05 up or 0.08 down, so its full travel takes
 *   about 1.3 s — comfortably inside the governor's 4 s window. By the time the
 *   governor has an opinion, this has already finished reacting, so the window
 *   the governor judges is the SETTLED post-adaptation state, which is the
 *   correct input for "should this machine be on a lower preset".
 *
 *   DIFFERENT AUTHORITY, AND THEY NEVER WRITE THE SAME KNOB. This moves pixels;
 *   the governor moves features (MSAA, shadow size, densities) and the
 *   `renderScale` CAP. `_applyScale` multiplies whatever the cap left it, so
 *   turning render scale down in the menu still does what it says.
 *
 *   WHAT THE COUPLING COSTS, HONESTLY. Because the governor sees a frame this
 *   has already rescued, it will read headroom on a machine that only has
 *   headroom at reduced resolution, and climb a preset. That settles rather
 *   than running away — each preset step costs more than the scale range left
 *   to pay for it — and if the top preset genuinely does not hold, the
 *   governor's existing exponential backoff is the mechanism for exactly that
 *   case; its comment describes it. The end state is "highest preset that fits
 *   at reduced resolution" rather than "highest preset that fits at full
 *   resolution", which is a real trade and not obviously the wrong one. The
 *   clean fix is one line in quality.js — only climb while the scale has been
 *   pinned at 1 — and that file is not this one's to edit.
 *
 * WHAT IS DELIBERATELY NOT DONE: going ABOVE 1. The research argues for it and
 * it is right in principle — sober frames have ~11 ms of headroom at 60 Hz and
 * the 1.4 pixel-ratio cap is a worst-case number applied to every frame. But
 * the target would have to be allocated larger than the cap, which is 56% more
 * memory on a multisampled HDR buffer, and it would mean the SOBER frame no
 * longer renders at the resolution it renders at today. The brief for this
 * change was that sober must be pixel-identical. The ceiling stays at 1.
 *
 * OFF UNDER AUTOMATION, for the same reason `quality.js` refuses to run the
 * governor there: every script in scripts/ compares pixels or milliseconds
 * against expectations, and a controller quietly changing the resolution
 * halfway through `shoot.mjs` makes all fifteen of them non-reproducible, with
 * a failure that looks like a rendering bug. Tests opt in explicitly.
 */
/** Never below this fraction of full resolution. 0.6 is 36% of the pixels. */
const DRS_MIN = 0.6;
/** Seconds between decisions. */
const DRS_EVAL = 0.25;
/** Largest single move, per decision. Down is faster than up on purpose. */
const DRS_STEP_UP = 0.05;
const DRS_STEP_DOWN = 0.08;
/**
 * The band, as a fraction of the display period.
 *
 * Shrink above 0.75, grow below 0.60, hold between. The width is not taste: one
 * step of 0.05 in scale moves the resolution-dependent part of the frame by
 * about 10%, so a band 25% wide is guaranteed to be wider than a single step
 * and the controller therefore cannot step from one edge of it to the other.
 * That is what makes it settle instead of breathing, and it is a stronger
 * guarantee than any amount of smoothing.
 */
const DRS_UPPER = 0.75;
const DRS_LOWER = 0.6;
/** Consecutive good windows before climbing. Bad news is answered in one. */
const DRS_UP_DWELL = 3;
/**
 * The smallest move worth making, and it is not a micro-optimisation — it is
 * what turns convergence into a STOP.
 *
 * The correction below is `sqrt(budget / measured)`, which is exact for a frame
 * that is pure fill and under-corrects for one that is not. This frame is very
 * much not: measured on this build, looking up into the canopy at the peak at
 * 2560x1440, about 3 ms of a 5 ms frame does not move with resolution at all
 * (the vertex stage, which is the whole point of the rest of this session's
 * work). So near the target the sqrt asks for half a per cent, gets it, asks
 * for half a per cent again, and the scale grinds slowly downward for ever
 * instead of arriving — a creep of a few per cent a second, which is exactly
 * the "the picture breathes" failure in slow motion.
 *
 * Refusing to move for less than 1% of scale — 2% of the pixels, well under
 * anything an eye resolves — makes the controller stop within about 2% of its
 * budget and stay there. Solving for the fixed cost online would converge
 * faster and was rejected: a two-point fit of A + B s2 from a moving scene is a
 * second estimator with its own failure modes, and overshoot is the one thing
 * this must never do.
 */
const DRS_MIN_STEP = 0.01;
/**
 * Viewport widths are multiples of this.
 *
 * The three bloom mips are the scene target halved, quartered and eighthed, and
 * every pass reads its source at that source's own exact scale. Keeping the
 * scene's sub-rect a multiple of 8 makes all four scales agree to the texel
 * instead of to within a rounding error, which costs nothing and removes a
 * whole class of half-texel drift from the bloom chain.
 */
const DRS_QUANTUM = 8;
/**
 * The display's cadence, estimated from the fastest tenth of recent intervals
 * and clamped — the same trick and the same two constants as the AutoGovernor,
 * for the same reason. A machine that only ever manages 30 fps has a fastest
 * frame of 33 ms, and believing that is its refresh rate would tell this
 * controller it has all the headroom in the world.
 */
const SLOWEST_BELIEVABLE_PERIOD = 1 / 58;
/**
 * The floor under the budget is IMPORTED rather than restated here, and that is
 * the point of it being a shared constant: the governor and this controller
 * both estimate the display's cadence the same way and both used to clamp it at
 * 1/300, and on a 240 Hz panel that made a healthy 6.9 ms frame overspend a
 * 3.1 ms budget on every single frame. This one answered first — it ran to its
 * 0.60 floor in two and a half seconds — and the governor then spent the
 * quality ladder on the same phantom. Two controllers reading one wrong number
 * is exactly the case for one definition of it. See the block on
 * MAX_USEFUL_FPS in core/quality.js for the measurement.
 */

const QUAD = new THREE.PlaneGeometry(2, 2);

class Quad {
  constructor(material) {
    this.mesh = new THREE.Mesh(QUAD, material);
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  set material(m) {
    this.mesh.material = m;
  }

  get material() {
    return this.mesh.material;
  }

  render(renderer, target) {
    renderer.setRenderTarget(target ?? null);
    renderer.clear();
    renderer.render(this.scene, this.camera);
  }
}

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export class Pipeline {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.size = new THREE.Vector2(1, 1);
    this.bloomEnabled = true;
    /** The luminous wake has its own switch. Debug only. */
    this.trailEnabled = true;

    const targetOptions = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    };

    /**
     * Two samples of MSAA on the scene target.
     *
     * A forest is hundreds of thousands of alpha-tested leaf edges, and an
     * alpha-tested edge without multisampling crawls — every frame a different
     * set of pixels passes the test, so the canopy fizzes. That fizz is then
     * fed to the glow accumulator, which smears it. Resolving here fixes both,
     * and it is the cheapest quality win available in this whole pipeline.
     *
     * Two samples, not four: this is an HDR half-float target at full render
     * resolution, so each extra sample is real bandwidth on every one of the
     * frame's most expensive pixels. 2× keeps the edge stability that stops the
     * fizz; the remaining stair-step is softened by the glow and by the render
     * resolution itself. 4× measured several ms at peak for a difference that
     * needed a magnifier to find.
     *
     * No depth texture any more: the melt was the only thing that sampled depth,
     * and attaching a depth texture to a multisampled target costs a resolve
     * every frame. A plain depth BUFFER is still needed to draw the scene.
     *
     *
     * REJECTED: `reversedDepthBuffer: true` ON THE RENDERER.
     *
     * EXT_clip_control is present on this GPU and three 0.185 implements the
     * whole path, so it is genuinely a one-line change in main.js, and the case
     * for it is good in the abstract: float depth distributed the right way
     * round means tighter Hi-Z tiles, and a frame leaning this hard on early-Z
     * is the kind that benefits. It also kills distant z-fighting at a 900 m far
     * plane. Nothing here samples depth, so it looked free.
     *
     * IT IS NOT PIXEL-NEUTRAL. Measured with a single clean transition in a
     * fresh process per station, against an A/A control:
     *
     *   long view   A/A 0 px          normal -> reversed  5.23% of pixels, worst 100/765
     *   deep wood   A/A 0 px          normal -> reversed  0.006%,          worst  43/765
     *   peak        A/A 0.38% (w 3)   normal -> reversed  4.58%,           worst  64/765
     *
     * The two frames are indistinguishable side by side and the changed pixels
     * are distant fogged foliage, so this may well be the z-fighting FIX rather
     * than a regression — but the brief for this pass allowed exactly one
     * visible change and it was spent elsewhere, and the measured win is 0 to
     * -0.15 ms on a machine too contaminated today to resolve either end of
     * that range. Not worth spending a picture on.
     *
     * TWO TRAPS FOR WHOEVER PICKS THIS UP, both found the hard way:
     *
     *   `WebGLRenderer.render` sets `camera._reversedDepth = true` the first time
     *   it sees the flag and NEVER clears it. Toggling the state back off leaves
     *   the camera holding a reversed projection matrix against a normal depth
     *   test, which is a wholly broken frame. Only a problem for a runtime
     *   toggle; the constructor flag never toggles.
     *
     *   `WebGLShadowMap` sets `depthTexture.compareFunction` to GreaterEqual
     *   only where it CREATES the map. An existing map keeps LessEqual, so every
     *   shadow in the scene inverts — which reads as a lighting bug, not a depth
     *   one, and cost most of the time spent on this item.
     */
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      ...targetOptions,
      depthBuffer: true,
      samples: 2,
    });

    this.bloomMips = [];
    for (let i = 0; i < 3; i++) {
      this.bloomMips.push({
        a: new THREE.WebGLRenderTarget(1, 1, targetOptions),
        b: new THREE.WebGLRenderTarget(1, 1, targetOptions),
        div: 2 << i,
      });
    }

    /**
     * The glow accumulator: persistence that cannot draw a line.
     *
     * This is where trails live now. It ping-pongs at the coarsest bloom mip's
     * resolution and only ever sees ALREADY-BLURRED light, which is the whole
     * point — a buffer whose input has no high frequencies cannot reproduce an
     * edge, so it can leave a wake behind a bright moving thing but can never
     * trace the outline of a trunk. Every image-space trail that fed on the
     * sharp frame ended up doing exactly that, and it read as double vision.
     */
    this.glowA = new THREE.WebGLRenderTarget(1, 1, targetOptions);
    this.glowB = new THREE.WebGLRenderTarget(1, 1, targetOptions);
    this._glowPrimed = false;

    this.brightMaterial = this._brightMaterial();
    this.blurMaterial = this._blurMaterial();
    this.downMaterial = this._copyMaterial();
    this.glowMaterial = this._glowMaterial();
    this.outputMaterial = this._outputMaterial();
    this.quad = new Quad(this.outputMaterial);

    /**
     * The dynamic-resolution state. See the block comment at the top.
     *
     * `budgetMs` at 0 means "derive it from the display period"; a test that
     * wants to see the controller work on a machine with three times the
     * headroom it needs sets it by hand through `setFrameBudget`.
     */
    const auto = typeof navigator !== 'undefined' && !navigator.webdriver;
    this.drs = {
      /** May this move the scale? */
      enabled: auto,
      /**
       * Is the GPU clock running?
       *
       * Separate from `enabled` for the same reason `AutoGovernor` has a
       * `paused` that measures without acting: the only honest way to show what
       * a controller is worth is to run the identical frame past the identical
       * clock with the controller's hands tied. It is also what a debug readout
       * wants — GPU milliseconds are useful whether or not anything is
       * responding to them.
       */
      measure: auto,
      scale: 1,
      min: DRS_MIN,
      budgetMs: 0,
      /**
       * A hand-set scale that overrides the controller, or null.
       *
       * For looking at a low resolution deliberately — which is the only way to
       * check the corner clamps, because the controller will never sit at 0.6
       * on a machine that does not need it, and a smear along the right edge of
       * the frame is not something a millisecond figure can tell you about.
       */
      pin: null,
      /** Telemetry, all read-only from outside. */
      gpuMs: 0,
      period: 1 / 60,
      frames: 0,
      engagedFrames: 0,
      changes: 0,
      /** The last few hundred raw per-frame GPU times, for the test rig. */
      recent: [],
    };
    /**
     * What the scene pass alone submitted, sampled inside `render`. See the
     * block there — this is the only place in the frame where the renderer's
     * own counters still describe the world rather than the output quad.
     */
    this.sceneStats = { calls: 0, triangles: 0 };
    /** GPU times in ms, one per completed timer query, cleared each decision. */
    this._gpuSamples = [];
    /** rAF intervals, for the display-cadence estimate. */
    this._dtSamples = [];
    this._drsClock = 0;
    this._goodWindows = 0;
    this._timerExt = undefined;
    this._queryPool = [];
    this._queryPending = [];
    this._activeQuery = null;
    /** target -> { sx, sy, maxU, maxV }, recomputed whenever the scale moves. */
    this._rects = new Map();
    /** The glow buffer was written at THIS scale; the next frame reads it there. */
    this._glowRect = new THREE.Vector4(1, 1, 1, 1);
    this._appliedScale = -1;
  }

  /**
   * One step of the glow accumulator.
   *
   * A peak-hold against an exponentially decaying history, so a bright thing
   * that moves leaves a wake that fades rather than a grey smudge that
   * accumulates. `uDecay` is computed from the frame time, so the wake lasts the
   * same number of SECONDS at 30 fps as at 144.
   */
  _glowMaterial() {
    return new THREE.ShaderMaterial({
      name: 'glow-accumulate',
      uniforms: {
        tCurrent: { value: null },
        tPrev: { value: null },
        uDecay: { value: 0.9 },
        uSrc: { value: new THREE.Vector4(1, 1, 1, 1) },
        /**
         * The scale the history buffer was WRITTEN at, which need not be the
         * one being written now. Sampling it at its own scale is what keeps
         * the wake sitting still in screen space while the resolution moves.
         */
        uPrev: { value: new THREE.Vector4(1, 1, 1, 1) },
      },
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
        uniform sampler2D tCurrent;
        uniform sampler2D tPrev;
        uniform float uDecay;
        uniform vec4 uSrc;
        uniform vec4 uPrev;
        varying vec2 vUv;
        void main() {
          vec3 cur = texture2D(tCurrent, min(vUv * uSrc.xy, uSrc.zw)).rgb;
          // Capped on the way in. Without a ceiling the peak-hold is a growth
          // loop and a four-minute trip ends as a white screen.
          vec3 prev = min(texture2D(tPrev, min(vUv * uPrev.xy, uPrev.zw)).rgb, vec3(4.0)) * uDecay;
          gl_FragColor = vec4(max(cur, prev), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
  }

  _copyMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uSrc: { value: new THREE.Vector4(1, 1, 1, 1) } },
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform vec4 uSrc;
        varying vec2 vUv;
        void main() { gl_FragColor = texture2D(tDiffuse, min(vUv * uSrc.xy, uSrc.zw)); }
      `,
      depthTest: false,
      depthWrite: false,
    });
  }

  _brightMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uThreshold: { value: 0.85 },
        uKnee: { value: 0.55 },
        uSrc: { value: new THREE.Vector4(1, 1, 1, 1) },
      },
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uThreshold;
        uniform float uKnee;
        uniform vec4 uSrc;
        varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tDiffuse, min(vUv * uSrc.xy, uSrc.zw)).rgb;
          float l = max(c.r, max(c.g, c.b));
          // Soft knee, so the bloom fades in around the threshold instead of
          // switching on at it — a hard threshold makes bright edges crawl.
          float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
          soft = soft * soft / (4.0 * uKnee + 1e-4);
          float contribution = max(soft, l - uThreshold) / max(l, 1e-4);
          gl_FragColor = vec4(c * contribution, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
  }

  _blurMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uDirection: { value: new THREE.Vector2(1, 0) },
        /**
         * One texel of the SOURCE, times the current scale — so the kernel
         * spans a constant fraction of the picture rather than a constant
         * number of texels. See the block comment at the top of the file.
         */
        uTexel: { value: new THREE.Vector2(1, 1) },
        uSrc: { value: new THREE.Vector4(1, 1, 1, 1) },
      },
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform vec2 uDirection;
        uniform vec2 uTexel;
        uniform vec4 uSrc;
        varying vec2 vUv;
        void main() {
          // Nine-tap gaussian collapsed to five bilinear fetches.
          vec2 uv = vUv * uSrc.xy;
          vec2 o1 = uDirection * uTexel * 1.3846153846;
          vec2 o2 = uDirection * uTexel * 3.2307692308;
          // The clamp is the one that actually matters: these taps reach 3.23
          // texels past the rendered corner, and what is out there is the last
          // frame drawn at some other scale. At s = 1 it is exactly what
          // CLAMP_TO_EDGE was already doing.
          vec3 c = texture2D(tDiffuse, min(uv, uSrc.zw)).rgb * 0.2270270270;
          c += texture2D(tDiffuse, min(uv + o1, uSrc.zw)).rgb * 0.3162162162;
          c += texture2D(tDiffuse, min(uv - o1, uSrc.zw)).rgb * 0.3162162162;
          c += texture2D(tDiffuse, min(uv + o2, uSrc.zw)).rgb * 0.0702702703;
          c += texture2D(tDiffuse, min(uv - o2, uSrc.zw)).rgb * 0.0702702703;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
  }

  _outputMaterial() {
    return new THREE.ShaderMaterial({
      name: 'output',
      uniforms: {
        tDiffuse: { value: null },
        tBloom0: { value: null },
        tBloom1: { value: null },
        tBloom2: { value: null },
        tGlow: { value: null },
        uGlow: { value: 0 },
        uGlowAmount: { value: 0 },
        uBloom: { value: 0.42 },
        uExposure: { value: 1.05 },
        uVignette: { value: 0.34 },
        uLevel: tripUniforms.uLevel,
        uDissolve: tripUniforms.uDissolve,
        /**
         * THE VIEW BREATH. Shared objects, not copies, so the director writes
         * one number and the world and the picture cannot disagree about it.
         * See the long note on uViewWarp in trip/living.js for why the one
         * displacing term in this file is allowed to be here at all.
         */
        uNoiseTex: tripUniforms.uNoiseTex,
        uTime: tripUniforms.uTime,
        uEye: tripUniforms.uEye,
        uBreathPhase: tripUniforms.uBreathPhase,
        uViewWarp: tripUniforms.uViewWarp,
        uViewRot: tripUniforms.uViewRot,
        uViewTan: tripUniforms.uViewTan,
        /**
         * Where each source's rendered corner is: (scaleX, scaleY, maxU, maxV).
         * Five of them rather than one, because the four sources are four
         * different sizes and each rounds its corner to its own texel grid.
         * DRS_QUANTUM keeps them agreeing, but agreeing by construction is
         * cheaper to believe than agreeing by arithmetic.
         */
        uSrcScene: { value: new THREE.Vector4(1, 1, 1, 1) },
        uSrcBloom0: { value: new THREE.Vector4(1, 1, 1, 1) },
        uSrcBloom1: { value: new THREE.Vector4(1, 1, 1, 1) },
        uSrcBloom2: { value: new THREE.Vector4(1, 1, 1, 1) },
        uSrcGlow: { value: new THREE.Vector4(1, 1, 1, 1) },
      },
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
        ${NOISE3}
        uniform sampler2D tDiffuse;
        uniform sampler2D tBloom0;
        uniform sampler2D tBloom1;
        uniform sampler2D tBloom2;
        uniform sampler2D tGlow;
        uniform float uGlowAmount;
        uniform float uBloom;
        uniform float uExposure;
        uniform float uVignette;
        uniform float uLevel;
        uniform float uDissolve;
        uniform float uTime;
        uniform float uBreathPhase;
        uniform float uViewWarp;
        uniform mat3 uViewRot;
        uniform vec2 uViewTan;
        uniform vec3 uEye;
        uniform vec4 uSrcScene;
        uniform vec4 uSrcBloom0;
        uniform vec4 uSrcBloom1;
        uniform vec4 uSrcBloom2;
        uniform vec4 uSrcGlow;
        varying vec2 vUv;

        /**
         * The world direction this pixel looks along, as a domain position.
         *
         * NO ORIGIN, AND THAT IS THE WHOLE DESIGN. Nothing here takes a length
         * or an angle from the frame's centre. A radial term would put a fixed
         * point under the crosshair, and a fixed point under the crosshair is
         * how every previous attempt at this in this project ended up being
         * described as a filter on the screen.
         *
         * NORMALISED, AND THE VERSION THAT WAS NOT IS WHY THIS READ AS A FILTER
         * WHEN THE HEAD MOVED. Worth setting out, because the wrong version has
         * an argument for it that sounds better than the right one.
         *
         * That argument was: an unnormalised ray is the tangent plane at the
         * view direction, so features keep their size across the frame, whereas
         * normalising makes the field shrink toward the edges of a wide frustum
         * like a lens distortion. Both halves are wrong. A world-anchored
         * pattern genuinely DOES change size across a rectilinear frame — the
         * projection is x = tan(theta), so a fixed angular feature covers more
         * pixels at the edge, and that is what a wide lens does to real things.
         *
         * And the tangent plane is not rotation-invariant, which is fatal. Work
         * it through: a world direction d appears at the uv whose camera-space
         * vector is R'd, and feeding that uv back through gives d / -(R'd).z —
         * that is, d scaled by 1/cos of its angle off the view axis. So the
         * domain position of a FIXED piece of world slides radially outward, by
         * up to 50% at the corner of this frustum, purely because you turned
         * your head. The field is dragged along with the frame at roughly half
         * the rate you turn, and being dragged at half rate looks worse than
         * not compensating at all: it is exactly the "stuck to the glass"
         * percept, arriving through a mechanism that was supposed to prevent it.
         *
         * normalize() makes the map depend only on the DIRECTION, so a piece of
         * world keeps its domain position no matter where in the frame it sits.
         * One inversesqrt.
         *
         * THE EYE TERM IS THE OTHER HALF OF THE SAME COMPLAINT. Direction alone
         * is anchored to the head's ORIENTATION and not to the world: turn and
         * the field holds still, but walk and it comes with you, which is the
         * same percept arriving on the other axis. Adding the eye position in
         * units of the shell radius puts the field on a sphere RR_VIEW_SHELL
         * metres out instead of at infinity, so walking moves through it. The
         * shell is far enough that a step does not shift it — one lattice cell
         * per 39 m, about ten seconds at a walk — and near enough that moving
         * around the wood is not moving under a fixed lid.
         */
        /**
         * Metres out the field sits, and it is MEASURED — see
         * scripts/view-depth.mjs, which raycasts a grid of view directions into
         * the real wood at the perf stations and solves for it.
         *
         * The field is sampled at eye + dir*SHELL, so under a step of one metre
         * the pattern slides across a world feature at depth z by
         * ARC * sin(theta) * (1/SHELL - 1/z) — zero exactly at z = SHELL. The
         * least-squares fit over the depths this forest actually presents is
         * 13.2 m. It was 120 m, which is three times further than you can see
         * here at all: the field sat effectively at infinity and barely moved
         * while the wood streamed past it, which is what a pattern stuck to the
         * screen looks like.
         *
         * WHAT THIS CONSTANT CANNOT DO, and the reason it is not the whole fix.
         * The residual only falls from 6.0% of the frame per metre to 4.5%,
         * because the wood spans 4 m to 90 m and one shell can match one depth.
         * Matching every depth needs the depth buffer, and reading depth is what
         * puts a seam at every silhouette — the melt, exactly. So the remaining
         * mismatch is paid for in the director instead, by standing the effect
         * down while you move: see VIEW_MOVING_FLOOR there.
         */
        const float RR_VIEW_SHELL = 13.2;
        /**
         * Domain units across one radian of view, near enough. Set so the
         * frame spans the same 5.2 units it did before normalising — the
         * feature size that was tuned, kept across the fix.
         */
        const float RR_VIEW_ARC = 3.1;

        vec3 rayDomain(vec2 uv) {
          vec3 dir = normalize(uViewRot * vec3((uv - 0.5) * 2.0 * uViewTan, -1.0));
          return (dir + uEye * (1.0 / RR_VIEW_SHELL)) * RR_VIEW_ARC;
        }

        /**
         * THE VIEW BREATH: how far from where it looks this pixel actually
         * reads, as a fraction of the frame, bounded at 1.
         *
         * Three fetches, and they buy TWO decorrelated gradient fields, because
         * rrNoise3 returns three independent hashes of the same lattice cell.
         * Channel r becomes the swell and channel g the drift, so the two
         * motions cost the same as one.
         *
         * Both are gradients, and that is the design rather than the
         * arithmetic. A gradient field is curl-free — pure dilation, with no
         * rotation anywhere in it — and rotation is what an oil slick looks
         * like, which is the one thing a term that moves the image must never
         * resemble. The drift is then the PERPENDICULAR of a gradient, which is
         * the complementary property: divergence-free, so it can carry the
         * picture sideways but can neither concentrate nor spread it.
         */
        vec2 viewBreath(vec2 uv) {
          /**
           * THE DOMAIN TRAVELS A CLOSED CIRCLE.
           *
           * The field has to evolve or it is a static distortion, and the
           * obvious way — drift the domain along a fixed axis — makes features
           * arrive from one side and leave by the other, which reads as the
           * picture being panned. A small closed loop instead turns the field
           * over in place: nothing has a direction of travel, and no octave can
           * settle into holding one pose.
           */
          float ph = uTime * 0.043 * 6.2831853;
          vec3 orbit = vec3(cos(ph), sin(ph), 0.35 * sin(ph * 0.7)) * 0.8;
          vec3 p = rayDomain(uv) + orbit;
          /**
           * The gradient, by forward difference along the two SCREEN axes.
           * Screen axes because the thing being displaced is a screen position;
           * the two axes mapped into the domain are just the first two columns
           * of the rotation, so they cost nothing to obtain.
           *
           * THE STEP SIZE IS SET BY QUANTISATION, NOT BY ACCURACY, and this is
           * the whole reason it is a large number rather than a small one.
           *
           * The lattice is an 8-bit texture, so a sample carries a quantum of
           * 2/255 = 0.0078, and the hardware's subtexel filtering precision is
           * of the same order. A difference divided by a SMALL step multiplies
           * that quantum by 1/step — so the displacement comes out in stairs of
           * (0.0078/step) x weight x uViewWarp of the frame. At the step this
           * was first written with, 0.11 domain units, that is 2.7 px of stair
           * at 1280 wide: the picture moves in visible blocks, and it looks
           * exactly like the low-resolution warp field this project has
           * rejected before. At 0.55 it is a fifth of a pixel at the shipping
           * amplitude and stays sub-pixel at four times it.
           *
           * What a step this size costs is that the result is the gradient of a
           * SMOOTHED field rather than of this one. For a displacement whose
           * whole design is to be low-frequency that is not a cost worth
           * avoiding — and the alternative, an ALU noise with an exact
           * derivative, is eight hashes per sample against one fetch.
           */
          const float e = 0.55;
          vec3 n0 = rrNoise3(p);
          vec3 nx = rrNoise3(p + uViewRot[0] * e);
          vec3 ny = rrNoise3(p + uViewRot[1] * e);
          vec2 swell = vec2(nx.x - n0.x, ny.x - n0.x) / e;
          vec2 drift = vec2(nx.y - n0.y, ny.y - n0.y) / e;

          /**
           * A PHASE FIELD, NOT AN AMPLITUDE ON A GLOBAL SINE.
           *
           * The same construction as the world's breath, for the same reason:
           * multiplying one clock by a spatial field makes every region reach
           * its extreme on the same tick, which is two groups in antiphase and
           * not a wave. Offsetting the PHASE by the field makes the swell
           * travel across the frame, and rrLung skews it so the settle outlasts
           * the swell. uBreathPhase is the clock the trunks inhale on, so the
           * picture and the wood are one event.
           */
          float lung = rrLung(uBreathPhase + n0.z * 2.6);
          /**
           * The two weights are the only tuned numbers in here, and they are a
           * RATIO rather than a size — the overall amount is uViewWarp, set by
           * the director. Swell dominates because the swell is the reported
           * thing; the drift is there so the picture is never perfectly still
           * at the moment the lung crosses zero, which is when a pure swell
           * would otherwise stop dead twice a cycle.
           */
          vec2 off = swell * lung * 0.42 + vec2(drift.y, -drift.x) * 0.16;

          /**
           * BOUNDED BY CONSTRUCTION, NOT ON AVERAGE.
           *
           * The gradient of a noise field has tails, and this one's magnitude
           * runs to about three times its typical value. Left alone the rare
           * sample is the one that reaches past the frame's edge and clamps,
           * and a clamp in a displacement field is a smeared border — the exact
           * artefact this design exists to avoid. rrBend is the same smooth
           * saturating limiter the hue rotations use: slope 1 at the origin so
           * ordinary samples pass through untouched, asymptote at 1 so no
           * sample anywhere can exceed it. A hard clamp instead would draw a
           * crease across the picture wherever the field crossed the limit.
           *
           * The unit here is what makes the guard in main() exact: after this,
           * the displacement is at most uViewWarp, full stop.
           */
          float m = length(off);
          return m > 1e-5 ? off * (rrBend(m, 1.0) / m) : off;
        }

        /** ACES, fitted. Rolls highlights off instead of clipping them flat. */
        vec3 aces(vec3 x) {
          const float a = 2.51;
          const float b = 0.03;
          const float c = 2.43;
          const float d = 0.59;
          const float e = 0.14;
          return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
        }

        void main() {
          /**
           * Where this pixel reads from. vUv is the SCREEN and stays the
           * screen — the vignette below is still a property of the periphery
           * and must not move — while suv is where the light came from.
           *
           * NO BACKTICKS ANYWHERE IN THIS SHADER. It is inside a template
           * literal, and one in a comment ends the string and throws a syntax
           * error pointing at the next word. The same warning is on three
           * blocks in trip/living.js, and this one has now been caught by it.
           *
           * A UNIFORM BRANCH, so a sober frame does not pay for this. Every
           * pixel takes the same side of it, so there is no divergence, and the
           * three lattice fetches simply do not happen when uViewWarp is zero.
           * The sober frame is then bit-identical to the one before this
           * existed rather than merely indistinguishable from it, which is the
           * standing rule for every optional term in this pipeline.
           *
           * THE INWARD BIAS is what removes the border. The displacement is
           * bounded at exactly uViewWarp by the limiter in viewBreath, so
           * shrinking the read rectangle by that much on every side guarantees
           * the sample never leaves the rendered image and therefore never
           * clamps. It is a fixed zoom of one or two per cent that arrives over
           * the come-up's tens of seconds — far below the rate at which a scale
           * change is perceptible as motion — and it is the price of not having
           * a smeared frame edge, which is a thousand times more visible.
           */
          vec2 suv = vUv;
          if (uViewWarp > 0.0) {
            suv = (vUv - 0.5) * (1.0 - 2.0 * uViewWarp) + 0.5 + viewBreath(vUv) * uViewWarp;
          }

          // Each source is read where its own corner is; the warp is applied in
          // SCREEN fractions first, so it means the same thing at every scale.
          vec3 col = texture2D(tDiffuse, min(suv * uSrcScene.xy, uSrcScene.zw)).rgb;

          /**
           * The glare follows the picture. Bloom is light that spread from a
           * bright thing, so leaving it behind while the thing itself moved
           * would put a halo a per cent of the screen away from its source —
           * which reads as a second, blurred copy of the world, and a second
           * copy of the world is the double vision this project has rejected
           * from the start.
           */
          vec3 bloom = texture2D(tBloom0, min(suv * uSrcBloom0.xy, uSrcBloom0.zw)).rgb * 0.5
                     + texture2D(tBloom1, min(suv * uSrcBloom1.xy, uSrcBloom1.zw)).rgb * 0.32
                     + texture2D(tBloom2, min(suv * uSrcBloom2.xy, uSrcBloom2.zw)).rgb * 0.18;
          // Bloom rises during a trip. It is the one screen-space term that is
          // allowed to, because glare genuinely IS a property of the eye rather
          // than of the world — light bleeding around bright edges is what an
          // over-dilated pupil actually does, so it belongs on the glass.
          col += bloom * (uBloom + uLevel * 0.34);

          /**
           * THE LUMINOUS WAKE.
           *
           * The accumulated glow buffer, added on top. Everything bright that
           * moves — a mushroom cap, a mote, the jukebox, a patch of sun through
           * the canopy — drags a soft comet tail behind it, and nothing has an
           * outline, because the buffer is an eighth-resolution blur of a blur.
           * This is what replaced the image-space trail.
           */
          col += texture2D(tGlow, min(suv * uSrcGlow.xy, uSrcGlow.zw)).rgb * uGlowAmount * 1.5;

          /**
           * Exposure closes as the trip deepens, but only just.
           *
           * The reasoning for closing it is sound — the glow and the bloom add
           * light to a frame that was already exposed for daylight, and without
           * some compensation the peak reads as brighter rather than as
           * differently lit. At 0.14 it overshot: combined with a fog density
           * that nearly doubled over the same curve, the peak was a full stop
           * down on sober and everything the trip drew was landing on a darker,
           * flatter image than the one it was tuned against. A stop of headroom
           * is worth more than a stop of restraint here — ACES rolls the
           * highlights off perfectly well on its own.
           */
          col = aces(col * uExposure * (1.0 - uLevel * 0.05));

          /**
           * A fixed vignette, present when sober and never animated.
           *
           * That is the point: a vignette that appears when the trip starts is
           * an effect being switched on, and the eye reads it as a frame around
           * the picture. One that is always there is simply how this world is
           * photographed, and it stops being visible within a minute.
           */
          float r = length(vUv - 0.5) * 1.42;
          col *= 1.0 - uVignette * smoothstep(0.55, 1.25, r);

          // Linear to sRGB.
          col = mix(col * 12.92, 1.055 * pow(max(col, 1e-5), vec3(1.0 / 2.4)) - 0.055,
                    step(0.0031308, col));

          gl_FragColor = vec4(col, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
  }

  setSize(width, height, pixelRatio) {
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));
    this.size.set(w, h);
    /**
     * The view breath needs no size of its own: its domain comes from the
     * camera's frustum half-angles, which carry the aspect ratio already and
     * are written by the director every frame. Deriving a second aspect here
     * would be a second source of truth for one number, and the two would
     * disagree on the frames between a resize and the next director tick.
     */
    this.sceneTarget.setSize(w, h);
    for (const mip of this.bloomMips) {
      mip.a.setSize(Math.max(1, Math.floor(w / mip.div)), Math.max(1, Math.floor(h / mip.div)));
      mip.b.setSize(Math.max(1, Math.floor(w / mip.div)), Math.max(1, Math.floor(h / mip.div)));
    }
    const last = this.bloomMips[this.bloomMips.length - 1].a;
    this.glowA.setSize(last.width, last.height);
    this.glowB.setSize(last.width, last.height);
    this._glowPrimed = false;
    /**
     * `setSize` on a render target resets its viewport and scissor to full and
     * leaves `scissorTest` alone, so the sub-rects have to be re-derived — and
     * the frames either side of a reallocation measure the reallocation, so the
     * timing window goes with them. Same reasoning as the governor's
     * `disturb()`. The SCALE is kept: a resize is not evidence that the machine
     * got faster, and snapping back to 1 would be a visible jump every time the
     * player drags the window edge.
     */
    this._appliedScale = -1;
    this._drsDisturb();
    this._applyScale();
  }

  /* ---- dynamic resolution ------------------------------------------------ */

  /**
   * On or off. Off pins the scale at 1 and restores full viewports.
   *
   * `measure` defaults to following `enabled`; pass it explicitly to keep the
   * GPU clock running with the controller's hands tied, which is the control
   * arm of any honest measurement of what this is worth.
   */
  setDynamicResolution(on, { measure = on } = {}) {
    this.drs.enabled = !!on;
    this.drs.measure = !!measure || !!on;
    if (!on) this.drs.scale = 1;
    this._drsDisturb();
    this._applyScale();
  }

  /**
   * Override the GPU-time budget, in milliseconds. 0 goes back to deriving it
   * from the observed display cadence.
   *
   * This exists for the test rig. A machine with three times the headroom it
   * needs will sit at scale 1 for ever and prove nothing, and "it never
   * engaged" is indistinguishable from "it does not work".
   */
  setFrameBudget(ms) {
    this.drs.budgetMs = Math.max(0, ms || 0);
    this._drsDisturb();
  }

  /** Hold the scale at a value, or `null` to hand it back to the controller. */
  pinScale(v) {
    this.drs.pin = v === null || v === undefined ? null : Math.max(0.1, Math.min(1, v));
    this._drsDisturb();
  }

  /** Everything a test or a debug readout needs, in one call. */
  drsReport() {
    const d = this.drs;
    const rect = this._rects.get(this.sceneTarget);
    return {
      enabled: d.enabled,
      scale: d.scale,
      gpuMs: d.gpuMs,
      periodMs: d.period * 1000,
      budgetMs: d.budgetMs > 0 ? d.budgetMs : d.period * 1000 * DRS_UPPER,
      frames: d.frames,
      engagedFrames: d.engagedFrames,
      changes: d.changes,
      viewport: rect ? [rect.vw, rect.vh] : [this.size.x, this.size.y],
      full: [this.size.x, this.size.y],
    };
  }

  /**
   * The same thing, for an owner of the frame loop who knows something this
   * controller cannot see.
   *
   * The one caller is the `#enter` handler in main.js. Behind the main menu the
   * loop draws ten frames a second rather than every tick, so both windows in
   * here describe a heartbeat: the GPU samples are real but sparse, and the
   * cadence estimate — a tenth percentile of `dt` — is taken over intervals that
   * are a throttle rather than a display. Left alone it would settle, because
   * the dt window holds 150 samples and a real one refills it inside a second;
   * a second of a brand-new session judged against a fabricated frame budget is
   * still exactly the wrong second to get wrong, and this is one line.
   *
   * Public and named for the situation rather than for the mechanism, because
   * the alternative — reaching into `_drsDisturb` from another module — is a
   * private field becoming an interface without anyone deciding it should.
   */
  disturb() {
    this._drsDisturb();
  }

  /** "Whatever is in the window measured something else." */
  _drsDisturb() {
    this._gpuSamples.length = 0;
    this._dtSamples.length = 0;
    this._drsClock = 0;
    this._goodWindows = 0;
  }

  /**
   * Write the current scale into every target's viewport and scissor, and cache
   * the read coordinates each pass needs for its source.
   *
   * At scale 1 this restores the exact state the pipeline had before dynamic
   * resolution existed — full viewport, scissor test OFF — so the frame is
   * bit-identical rather than merely similar.
   */
  _applyScale() {
    const s = this.drs.scale;
    if (s === this._appliedScale) return;
    this._appliedScale = s;

    const w = this.size.x;
    const h = this.size.y;
    let sx = 1;
    let sy = 1;
    if (s < 1) {
      const q = (n) =>
        Math.min(n, Math.max(DRS_QUANTUM, Math.round((n * s) / DRS_QUANTUM) * DRS_QUANTUM));
      sx = q(w) / w;
      sy = q(h) / h;
    }

    const targets = [this.sceneTarget, this.glowA, this.glowB];
    for (const mip of this.bloomMips) targets.push(mip.a, mip.b);
    for (const t of targets) {
      const vw = Math.min(t.width, Math.max(1, Math.round(t.width * sx)));
      const vh = Math.min(t.height, Math.max(1, Math.round(t.height * sy)));
      t.viewport.set(0, 0, vw, vh);
      t.scissor.set(0, 0, vw, vh);
      t.scissorTest = vw < t.width || vh < t.height;
      let rect = this._rects.get(t);
      if (!rect) {
        rect = { vw, vh, sx: 1, sy: 1, uv: new THREE.Vector4(1, 1, 1, 1) };
        this._rects.set(t, rect);
      }
      rect.vw = vw;
      rect.vh = vh;
      rect.sx = vw / t.width;
      rect.sy = vh / t.height;
      // (scaleX, scaleY, last valid texel centre in u, the same in v)
      rect.uv.set(rect.sx, rect.sy, (vw - 0.5) / t.width, (vh - 0.5) / t.height);
    }
  }

  /**
   * One decision, from the last window of GPU times.
   *
   * p75 rather than the mean or the max. The mean is dominated by the frames
   * nobody notices; the max is dominated by the one frame that carried a shadow
   * map re-render, which costs 3.2–4.5 ms and which no amount of resolution can
   * help — reacting to it would drop the whole picture for a one-frame event
   * that happens about once every ninety frames of walking. p75 over a
   * quarter-second is "what a normal bad frame costs".
   */
  _decide() {
    const d = this.drs;
    const sorted = this._gpuSamples.slice().sort((a, b) => a - b);
    this._gpuSamples.length = 0;
    const p75 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
    d.gpuMs = p75;

    if (!d.enabled || d.pin !== null) return;

    const upper = d.budgetMs > 0 ? d.budgetMs : d.period * 1000 * DRS_UPPER;
    const lower = upper * (DRS_LOWER / DRS_UPPER);

    let next = d.scale;
    if (p75 > upper) {
      this._goodWindows = 0;
      /**
       * sqrt, because pixel cost goes as the square of the scale — and it
       * deliberately UNDER-corrects, because part of the frame (the whole
       * vertex stage, which on this build is most of the trip's cost) does not
       * scale with pixels at all. A controller that assumed the frame was pure
       * fill would overshoot on every step and then have to climb back, which
       * is the oscillation this must not have. Converging from above is slower
       * and monotone.
       */
      next = Math.max(d.scale - DRS_STEP_DOWN, d.scale * Math.sqrt(upper / p75));
    } else if (p75 < lower && d.scale < 1) {
      this._goodWindows++;
      if (this._goodWindows >= DRS_UP_DWELL) {
        next = Math.min(d.scale + DRS_STEP_UP, d.scale * Math.sqrt(lower / p75));
      }
    } else {
      this._goodWindows = 0;
    }

    next = Math.max(d.min, Math.min(1, next));
    // Climbing back to exactly 1 is always worth doing however small the step,
    // because 1 is the only value at which the frame is bit-identical to the
    // one this feature does not exist in.
    const atLimit = next === 1 || next === d.min;
    if (Math.abs(next - d.scale) >= (atLimit ? 1e-4 : DRS_MIN_STEP)) {
      d.scale = next;
      d.changes++;
    }
  }

  _drsUpdate(dt) {
    const d = this.drs;
    d.frames++;
    this._gpuPoll();

    if (d.pin !== null) d.scale = d.pin;
    else if (!d.enabled && d.scale !== 1) d.scale = 1;
    if (!d.measure) {
      this._applyScale();
      return;
    }

    /**
     * `Clock.tick` in core/util.js clamps dt to 0.05 s, so a dropped frame
     * reports 20 fps rather than its true interval. That is harmless here and
     * worth knowing why: the cadence estimate below takes the tenth percentile
     * — the FASTEST frames — which the clamp cannot touch. It only means the
     * quarter-second evaluation clock runs slightly slow on a stalling machine,
     * i.e. fewer decisions when frames are long, which is the safe direction.
     */
    if (dt > 0 && dt < 0.25) {
      this._dtSamples.push(dt);
      if (this._dtSamples.length > 150) this._dtSamples.shift();
    }
    if (this._dtSamples.length >= 24) {
      const sorted = this._dtSamples.slice().sort((a, b) => a - b);
      d.period = Math.min(
        SLOWEST_BELIEVABLE_PERIOD,
        Math.max(FASTEST_USEFUL_PERIOD, sorted[Math.floor(sorted.length * 0.1)])
      );
    }

    this._drsClock += dt;
    if (this._drsClock >= DRS_EVAL) {
      this._drsClock = 0;
      // Four is enough to have a p75 that means anything; fewer than that and
      // the window is still filling after a disturbance.
      if (this._gpuSamples.length >= 4) this._decide();
    }
    if (d.scale < 1) d.engagedFrames++;
    this._applyScale();
  }

  /* ---- the GPU clock ----------------------------------------------------- */

  _gpuBegin() {
    if (!this.drs.measure) return;
    const gl = this.renderer.getContext();
    if (this._timerExt === undefined) {
      this._timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2') ?? null;
    }
    const ext = this._timerExt;
    if (!ext) return;
    /**
     * NEVER NEST. `scripts/gpu-perf.mjs` and friends wrap whole batches of
     * `pipeline.render()` in a TIME_ELAPSED query of their own, and a second
     * one inside it is INVALID_OPERATION — which would fill the console with
     * driver errors and make the measurement rig report nothing. Asking GL who
     * currently owns the target is one client-side call and settles it.
     */
    if (gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) return;
    const q = this._queryPool.pop() ?? gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    this._activeQuery = q;
  }

  _gpuEnd() {
    if (!this._activeQuery) return;
    const gl = this.renderer.getContext();
    gl.endQuery(this._timerExt.TIME_ELAPSED_EXT);
    this._queryPending.push(this._activeQuery);
    this._activeQuery = null;
  }

  _gpuPoll() {
    const ext = this._timerExt;
    if (!ext || this._queryPending.length === 0) return;
    const gl = this.renderer.getContext();
    // A disjoint means the GPU was interrupted — a mode switch, another context
    // taking over — and every outstanding result is meaningless, not merely
    // late. Throw the window away rather than adapting to a lie.
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      for (const q of this._queryPending) gl.deleteQuery(q);
      this._queryPending.length = 0;
      this._gpuSamples.length = 0;
      return;
    }
    while (this._queryPending.length) {
      const q = this._queryPending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this._queryPending.shift();
      const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      this._gpuSamples.push(ms);
      this.drs.recent.push(ms);
      if (this.drs.recent.length > 900) this.drs.recent.shift();
      if (this._queryPool.length < 8) this._queryPool.push(q);
      else gl.deleteQuery(q);
    }
    // Bounded, so a driver that stops answering leaks nothing.
    while (this._queryPending.length > 8) gl.deleteQuery(this._queryPending.shift());
    if (this._gpuSamples.length > 240) this._gpuSamples.splice(0, this._gpuSamples.length - 240);
  }

  /**
   * How much luminous wake bright things leave.
   *
   * `trail` no longer means "how much of the previous frame survives" — it is
   * the strength of the glow accumulator, which is a different thing entirely
   * and cannot ghost an edge. The name is kept because the director's intent is
   * unchanged: this is the persistence knob.
   */
  setTripParameters({ trail = 0, bloomLift = 0 }) {
    this.glowAmount = this.trailEnabled ? trail : 0;
    /**
     * How far the bright-pass reaches down into the frame.
     *
     * The pupil, in other words: what counts as a light source. Raising the
     * bloom AMOUNT makes the picture glarier and is the obvious lever; dropping
     * the THRESHOLD is the one that produces the reported thing, because it
     * changes which parts of the world start to glare in the first place. A
     * highlight on a wet leaf that was a single white pixel acquires a size; a
     * gap of sky in the canopy stops having an edge. The knee comes down with
     * it so the transition stays soft and bright edges do not crawl.
     */
    this.bloomLift = bloomLift;
  }

  render(dt = 1 / 60) {
    const renderer = this.renderer;
    const camera = this.camera;

    /**
     * The scale is picked once, before anything is drawn, and every pass in the
     * frame then agrees about it. Picking it anywhere else would mean a frame
     * whose bloom was computed for a different corner from the one the world
     * was rendered into.
     */
    this._drsUpdate(dt);
    const rect = (t) => this._rects.get(t).uv;
    this._gpuBegin();

    // ---- 1. the world ------------------------------------------------------
    renderer.setRenderTarget(this.sceneTarget);
    renderer.clear();
    renderer.render(this.scene, camera);
    /**
     * WHAT THE WORLD COST, CAPTURED HERE BECAUSE NOWHERE ELSE CAN.
     *
     * `renderer.info.render` is reset at the start of every `render()` call and
     * this pipeline makes seven or eight of them a frame, so anything reading
     * those counters after the frame is describing the OUTPUT QUAD: one draw
     * call and two triangles, every frame, whatever the forest is doing. Five
     * scripts in this project have reported exactly that number and believed it.
     *
     * Two shallow field reads on the one line in the frame where the answer is
     * still true, and every readout that wants "how big is the world" reads this
     * instead. The bloom and output passes are a fixed handful of draws and are
     * not what anybody is asking about.
     */
    this.sceneStats.calls = renderer.info.render.calls;
    this.sceneStats.triangles = renderer.info.render.triangles;

    const lit = this.sceneTarget;

    // ---- 2. bloom ----------------------------------------------------------
    if (this.bloomEnabled) {
      const lift = this.bloomLift ?? 0;
      this.brightMaterial.uniforms.uThreshold.value = 0.85 - lift;
      this.brightMaterial.uniforms.uKnee.value = 0.55 - lift * 0.55;
      this.brightMaterial.uniforms.tDiffuse.value = lit.texture;
      this.brightMaterial.uniforms.uSrc.value.copy(rect(lit));
      this.quad.material = this.brightMaterial;
      this.quad.render(renderer, this.bloomMips[0].a);

      for (let i = 0; i < this.bloomMips.length; i++) {
        const mip = this.bloomMips[i];
        if (i > 0) {
          this.downMaterial.uniforms.tDiffuse.value = this.bloomMips[i - 1].a.texture;
          this.downMaterial.uniforms.uSrc.value.copy(rect(this.bloomMips[i - 1].a));
          this.quad.material = this.downMaterial;
          this.quad.render(renderer, mip.a);
        }
        const w = mip.a.width;
        const h = mip.a.height;
        const r = rect(mip.a);
        // r.x/r.y are this mip's scale: the kernel is a constant fraction of
        // the picture, not a constant number of texels.
        this.blurMaterial.uniforms.uTexel.value.set(r.x / w, r.y / h);
        this.blurMaterial.uniforms.uSrc.value.copy(r);
        this.blurMaterial.uniforms.tDiffuse.value = mip.a.texture;
        this.blurMaterial.uniforms.uDirection.value.set(1, 0);
        this.quad.material = this.blurMaterial;
        this.quad.render(renderer, mip.b);
        this.blurMaterial.uniforms.tDiffuse.value = mip.b.texture;
        this.blurMaterial.uniforms.uDirection.value.set(0, 1);
        this.quad.render(renderer, mip.a);
      }
    }

    // ---- 2b. the luminous wake --------------------------------------------
    /**
     * Accumulated on the COARSEST mip, which is an eighth of the screen in each
     * axis. Even if the peak-hold were somehow given a sharp input, an eighth-
     * resolution buffer upsampled bilinearly cannot draw a hard line — the
     * artefact is impossible by construction rather than merely tuned away.
     *
     * The decay is expressed as a time constant so the wake lasts the same
     * fraction of a second regardless of frame rate.
     */
    const glowSource = this.bloomMips[this.bloomMips.length - 1].a;
    const tau = 0.55;
    this.glowMaterial.uniforms.uDecay.value = Math.exp(-Math.max(dt, 1e-4) / tau);
    this.glowMaterial.uniforms.tCurrent.value = glowSource.texture;
    this.glowMaterial.uniforms.uSrc.value.copy(rect(glowSource));
    if (!this._glowPrimed) {
      // Prime from the current frame, so switching on does not flash.
      this.glowMaterial.uniforms.tPrev.value = glowSource.texture;
      this.glowMaterial.uniforms.uPrev.value.copy(rect(glowSource));
      this._glowPrimed = true;
    } else {
      this.glowMaterial.uniforms.tPrev.value = this.glowA.texture;
      this.glowMaterial.uniforms.uPrev.value.copy(this._glowRect);
    }
    this.quad.material = this.glowMaterial;
    this.quad.render(renderer, this.glowB);
    // What glowB was just written at, for the next frame to read it back with.
    this._glowRect.copy(rect(this.glowB));
    const spentGlow = this.glowA;
    this.glowA = this.glowB;
    this.glowB = spentGlow;

    // ---- 3. out ------------------------------------------------------------
    const out = this.outputMaterial.uniforms;
    out.tDiffuse.value = lit.texture;
    // Always bound, even when bloom is off: a null sampler is a driver-defined
    // texture, and `uBloom = 0` is a cheaper and more predictable off switch.
    out.tBloom0.value = this.bloomMips[0].a.texture;
    out.tBloom1.value = this.bloomMips[1].a.texture;
    out.tBloom2.value = this.bloomMips[2].a.texture;
    out.tGlow.value = this.glowA.texture;
    out.uSrcScene.value.copy(rect(lit));
    out.uSrcBloom0.value.copy(rect(this.bloomMips[0].a));
    out.uSrcBloom1.value.copy(rect(this.bloomMips[1].a));
    out.uSrcBloom2.value.copy(rect(this.bloomMips[2].a));
    out.uSrcGlow.value.copy(this._glowRect);
    out.uGlowAmount.value = this.bloomEnabled ? (this.glowAmount ?? 0) : 0;
    out.uBloom.value = this.bloomEnabled ? 0.42 : 0;
    this.quad.material = this.outputMaterial;
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(this.quad.scene, this.quad.camera);

    this._gpuEnd();
  }

  clearHistory() {
    this._glowPrimed = false;
  }

  /**
   * Change the scene target's multisample count.
   *
   * three only reads `samples` when it allocates the framebuffer, so assigning
   * it is invisible until the target is torn down — `dispose()` drops the GL
   * objects and the next `setRenderTarget` rebuilds them at the new count. The
   * glow accumulator is primed from whatever was in the old buffer, so it has
   * to be told the history is gone or the first frame after the change flashes.
   */
  setSamples(samples) {
    const n = Math.max(0, Math.floor(samples));
    if (n === this.sceneTarget.samples) return;
    this.sceneTarget.samples = n;
    this.sceneTarget.dispose();
    this.clearHistory();
    // The frames either side of a reallocation measure the reallocation. Same
    // reasoning as the governor's disturb() and as setSize above.
    this._drsDisturb();
  }

  dispose() {
    const gl = this.renderer.getContext();
    for (const q of this._queryPending) gl.deleteQuery(q);
    for (const q of this._queryPool) gl.deleteQuery(q);
    this._queryPending.length = 0;
    this._queryPool.length = 0;
    this.sceneTarget.dispose();
    this.glowA.dispose();
    this.glowB.dispose();
    for (const mip of this.bloomMips) {
      mip.a.dispose();
      mip.b.dispose();
    }
    for (const m of [
      this.brightMaterial,
      this.blurMaterial,
      this.downMaterial,
      this.glowMaterial,
      this.outputMaterial,
    ]) {
      m.dispose();
    }
  }
}
