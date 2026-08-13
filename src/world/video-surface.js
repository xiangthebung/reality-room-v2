import * as THREE from 'three';
import { NOISE3, makeLiving, tripUniforms } from '../trip/living.js';
import { STAND_PROBE_M, standingFloor } from './aim.js';

/**
 * A screen, standing in a forest.
 *
 * One class, and it used to serve two fixed surfaces — a fourteen-metre screen
 * bolted to the commons and a small panel that floated in front of whoever was
 * sharing. There are no fixed surfaces any more, and there is no panel either. A
 * share is a screen its owner stands wherever they like at whatever size suits
 * the clearing, and `ShareScreen` at the bottom of this file is the only kind
 * there is: two legs, a spot, and a width somebody chose.
 *
 *
 * THE DIFFICULT PART IS NOT DRAWING IT, IT IS DECIDING NOT TO.
 *
 * A 1080p video texture is 8.3 MB per upload. `THREE.VideoTexture` uploads on
 * every render in which the element has a new frame, and it does that whether or
 * not the quad is on screen, whether or not you are three hundred metres away
 * with your back to it, and — the expensive one — once per render PASS. This
 * pipeline renders the scene, a shadow map, and a bloom chain; a naive video
 * texture in a world with two of these is a couple of hundred megabytes a second
 * of PCIe traffic to show nobody anything.
 *
 * So the texture is a plain `THREE.Texture` whose `needsUpdate` this file owns,
 * and the rule is: upload when the element genuinely has a new frame, AND the
 * surface is facing the camera, AND it is close enough to occupy more than a
 * handful of pixels. That last test is not an optimisation of the usual "you
 * cannot see it anyway" kind — a screen you cannot read is exactly as legible at
 * 2 fps as at 30, so the frame rate is scaled by distance rather than switched
 * off, which keeps the thing alive in your peripheral vision for a twentieth of
 * the cost. Walk up to it and it comes to full rate before you can notice it was
 * not at it.
 *
 *
 * WHY THE PICTURE GETS A SHADER RATHER THAN MeshBasicMaterial.
 *
 * Three reasons, and the first is the only one that is not taste. A video's
 * aspect ratio is not known until the first frame arrives and changes when
 * somebody shares a different window, and the alternatives to letterboxing in
 * the shader are rebuilding geometry at runtime or stretching faces sideways.
 * Second, this is a lit rectangle in a dark wood and it should behave like one —
 * a little bloom-catching brightness in the emitted light, a faint grain, a
 * visible standby state when it is empty. Third, when the world melts, so does
 * this: it is a screen inside a hallucination, and the one surface in the
 * project allowed to behave like a screen while everything else refuses to.
 *
 *
 * IT HAS NO BACK, AND THAT IS A DECISION ABOUT WHERE PEOPLE STAND.
 *
 * There used to be a plank board behind the picture, on the argument that a
 * screen is not a window and from behind you should see timber rather than the
 * film in mirror image. True of a screen, and wrong about this object: a share
 * is stood up in a clearing by one person and watched by everybody, and the
 * board meant half of every circle was looking at the back of a rectangle. So
 * the board is gone, the picture is `DoubleSide`, and the fragment shader
 * mirrors `p.x` on the back face so the picture READS from behind rather than
 * being a reversed copy of itself — a screen you can walk round, which no real
 * one is, and the only thing here anybody would actually want.
 *
 * The timber surround stays, and moved to straddle the picture plane rather
 * than sit behind it, so a screen has a frame from either side.
 *
 * What that costs is the upload gate's best test. See `_maybeUpload`.
 *
 *
 * AND ONE LIGHT FOR EVERY SCREEN IN THE WORLD. See `ScreenGlow` below.
 */

/**
 * Distance in metres at which the picture stops being re-uploaded every frame.
 *
 * Chosen from the largest screen anybody may make: sixteen metres wide at sixty
 * metres away is about a seventh of a 2560-wide window, which is still perfectly
 * watchable — so full rate has to reach at least that far. Past it the interval
 * grows with the square of the distance, because that is how the on-screen AREA
 * shrinks, and area is what an upload buys.
 *
 * A FIXED DISTANCE FOR A SCREEN WHOSE SIZE IS NOW A VARIABLE, and that is a
 * deliberate refusal rather than an oversight. Scaling this by width would be
 * more correct — a 1.2 m screen really is unreadable at sixty metres — and it
 * would mean a screen's frame rate changed while somebody was resizing it, in
 * the exact moment they are looking straight at it. Sizing the threshold for the
 * biggest case costs a few uploads a second on small screens nobody is near, and
 * that is a cheaper thing to be wrong about.
 */
const FULL_RATE_M = 60;
/** Beyond this it is a lit rectangle in the trees and one frame a second is plenty. */
const MIN_RATE_HZ = 1;

/** Pixels of dark border around the picture, in UV units. Reads as a bezel. */
const BEZEL = 0.012;

/* -------------------------------------------------------------------------- */
/* reading the picture back, for the light it throws                          */
/* -------------------------------------------------------------------------- */

/** The grid `meanColour` averages over. See there for why it is not 1×1. */
const SAMPLE_W = 8;
const SAMPLE_H = 5;

/**
 * ONE CANVAS FOR THE WHOLE APPLICATION, built on first use.
 *
 * There is exactly one screen being sampled at any moment — the one the single
 * light is standing at — so a canvas per surface would be seven idle allocations
 * in a full room, and a canvas built at module scope would be one in every
 * session that never shares anything. It is also never in the document; a 2D
 * context does not need to be laid out to be drawn into.
 */
let _sampleContext = null;
function sampleContext() {
  if (_sampleContext) return _sampleContext;
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_W;
  canvas.height = SAMPLE_H;
  /**
   * `willReadFrequently` is the whole performance argument — see `meanColour`.
   * `alpha: false` because a video frame has none and an opaque context skips
   * the un-premultiply on the way out.
   */
  _sampleContext = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  return _sampleContext;
}

/**
 * sRGB byte to linear float, the same decode the fragment shader does by hand.
 *
 * A table rather than a `pow` per channel: 256 entries computed once against
 * 120 transcendentals per sample, and the input is a byte, so the table is
 * exact rather than an approximation of anything.
 */
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const _worldPos = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _viewProjection = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

/**
 * A video texture that uploads WHEN IT IS TOLD TO, and not once a frame.
 *
 * Both halves of this are necessary and neither is obvious.
 *
 * IT HAS TO BE A `VideoTexture`, not a plain `Texture` with a video element in
 * it. `WebGLTextures` branches on `isVideoTexture` in two places that matter:
 * `useTexStorage = (texture.isVideoTexture !== true)`, and the colour-space
 * verification that would otherwise try to resize the source through a canvas. A
 * plain texture therefore takes the immutable path — `texStorage2D` with
 * `image.width` and `image.height`, which on an `HTMLVideoElement` are the
 * layout attributes and are ZERO for an element that was never in the document.
 * It allocates a 0×0 texture and every subsequent upload fails with
 * `glCopySubTextureCHROMIUM: The destination level of the destination texture
 * must be defined`. Hundreds of them, in a warning stream nobody reads, with a
 * screen that stays blank.
 *
 * AND ITS OWN CALLBACK HAS TO GO. `VideoTexture`'s constructor registers a
 * `requestVideoFrameCallback` that sets `needsUpdate` on every decoded frame —
 * which is the whole thing this file exists to avoid. Thirty uploads a second of
 * an 8 MB texture, whether or not the quad is on screen, whether or not anybody
 * is facing it, once per render pass. Cancelling it and neutering `update()`
 * leaves three's correct upload path with this file's own gate in front of it.
 */
class GatedVideoTexture extends THREE.VideoTexture {
  constructor(video) {
    super(video);
    if (this._requestVideoFrameCallbackId) {
      video.cancelVideoFrameCallback(this._requestVideoFrameCallbackId);
      this._requestVideoFrameCallbackId = 0;
    }
  }

  /** Called by the renderer every time this texture is bound. Deliberately nothing. */
  update() {}
}

/**
 * An object carrying the picture material, for the shader pre-warm.
 *
 * Same problem as the caves and the same fix: a share screen does not exist
 * until somebody shares one, so `compileAsync` over the scene cannot warm it,
 * and `video-surface` compiles synchronously on the frame a picture first
 * appears — which is the frame everyone in the room is looking at.
 *
 * A throwaway material rather than a shared singleton, because unlike the caves
 * every surface here owns its own: the program cache is keyed on the shader
 * source, so warming this one warms all of them.
 */
export function videoWarmupObjects() {
  const geometry = new THREE.PlaneGeometry(1, 1);
  return [new THREE.Mesh(geometry, screenMaterial())];
}

function screenMaterial() {
  return new THREE.ShaderMaterial({
    name: 'video-surface',
    uniforms: {
      uMap: { value: null },
      /** Video aspect over quad aspect. 1 fills; anything else letterboxes. */
      uFit: { value: 1 },
      /** 0 standby, 1 showing a picture. Crossfaded, so a share does not pop. */
      uLive: { value: 0 },
      /** Brightness. The big screen is dimmer by day so it is not a white hole. */
      uGain: { value: 1 },
      /**
       * How much daylight there is, 0..1, fed from `daylight.js`'s own curve.
       *
       * The material is unlit — it has to be, because a picture is emitted light
       * and not a reflectance — so nothing else in the scene tells it whether it
       * is noon or midnight. Without this the empty screen is the same brightness
       * at both, which by day is a dark hole in a bright clearing and by night is
       * a glowing slab. One uniform buys a surface that behaves like paint when
       * there is nothing on it and like a lamp when there is.
       */
      uDay: { value: 1 },
      uTime: tripUniforms.uTime,
      uLevel: tripUniforms.uLevel,
      uNoiseTex: tripUniforms.uNoiseTex,
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
      uniform sampler2D uMap;
      uniform float uFit;
      uniform float uLive;
      uniform float uGain;
      uniform float uDay;
      uniform float uTime;
      uniform float uLevel;
      varying vec2 vP;

      /**
       * sRGB EOTF, decode half. \`texture.colorSpace = THREE.SRGBColorSpace\`
       * reads like it asks three for this, and for an ordinary image texture
       * it would: WebGLTextures uploads it into an SRGB8_ALPHA8 internal
       * format and the GPU decodes it on every sample for free. It does not
       * for a VideoTexture — \`getInternalFormat\` is called with
       * \`forceLinearTransfer = texture.isVideoTexture\`, which pins the
       * upload to plain RGBA8 regardless of \`colorSpace\`. So what
       * \`texture2D(uMap, ...)\` hands back is still the raw, gamma-encoded
       * byte out of the video frame, and this pipeline's output pass (see
       * pipeline.js) encodes to sRGB exactly once, at the very end, on the
       * assumption that everything feeding the scene target is already
       * linear. Skip this and an already-encoded value gets encoded a second
       * time — shadows lift, contrast flattens, the picture looks washed out
       * next to the real screen it came from. The decode has to happen by
       * hand, here, once per sample.
       */
      vec3 srgbToLinear(vec3 c) {
        return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
      }

      void main() {
        vec2 p = vP;

        /**
         * THE BACK OF THE SCREEN IS THE FRONT OF IT, MIRRORED BACK.
         *
         * A DoubleSide quad seen from behind shows its uv space reversed, which
         * is what a sheet of glass would do and is useless: text is the thing
         * people share most and mirrored text cannot be read at all. Flipping x
         * on the back face costs one instruction and makes the far side of the
         * clearing a seat rather than a wall.
         *
         * It is done HERE, before the warp and the letterbox, so everything
         * downstream — the swim, the fit, the bezel, the grain — is computed in
         * one consistent space and the two faces are exact mirrors of each
         * other rather than two slightly different pictures.
         *
         * Physically this is nonsense. A screen is one-sided and a projection
         * screen seen from the back is reversed. It is also the only reading of
         * "seen on both sides" that means anything, and this is a wood you
         * hallucinate in.
         */
        if (!gl_FrontFacing) p.x = 1.0 - p.x;

        /**
         * The trip reaches the screen, softly.
         *
         * Not the full melt the world gets — a picture that is unreadable is
         * not a picture, and the whole point of this object is that people are
         * watching something together. A slow swim of a couple of per cent says
         * "you are not all right" without taking the film away.
         */
        p += vec2(
          rrFbm2(vec3(p * 2.2, uTime * 0.13)),
          rrFbm2(vec3(p * 2.2 + 31.0, uTime * 0.11))
        ) * 0.035 * uLevel;

        // Letterbox. uFit > 1 means the source is wider than the quad, so the
        // picture keeps the width and loses height, and vice versa.
        vec2 q = p - 0.5;
        if (uFit > 1.0) q.y *= uFit; else q.x /= uFit;
        q += 0.5;

        vec3 col;
        float inside = step(BEZEL_LO, q.x) * step(q.x, BEZEL_HI)
                     * step(BEZEL_LO, q.y) * step(q.y, BEZEL_HI);

        if (inside > 0.5) {
          /**
           * SAMPLED STRAIGHT, with no flip.
           *
           * A video frame does arrive top-down while a quad's uv origin is at
           * the bottom left, so the instinct is to sample 1.0 - q.y — and doing
           * that puts the picture upside down, because three has already
           * corrected it. Texture.flipY defaults to true and WebGLTextures sets
           * UNPACK_FLIP_Y_WEBGL from it on every upload, so what is in memory is
           * already the right way up and a second flip undoes the first. Caught
           * by a screenshot of a test pattern with words on it, which is exactly
           * why the test pattern has words on it.
           *
           * (No backticks in this comment, and that is not a style choice: it
           * lives inside a JS template literal, and a backtick here ends the
           * shader. Twice now.)
           */
          col = srgbToLinear(texture2D(uMap, q).rgb) * uGain;
          /**
           * A grain and a scanline, both very slight.
           *
           * This is the difference between "a video is being drawn on that
           * rectangle" and "there is a screen over there". Neither is visible at
           * a glance; both are visible in the corner of your eye, which is where
           * the object spends most of its life.
           */
          float line = 0.97 + 0.03 * sin(q.y * 900.0);
          col *= line;
          col += (rrHash(vec3(q * 900.0, floor(uTime * 24.0))) - 0.5) * 0.012;
        } else {
          col = vec3(0.0);
        }

        /**
         * STANDBY IS PAINTED CANVAS, NOT A SWITCHED-OFF TELEVISION.
         *
         * The first version made the empty screen a near-black wash on the
         * reasoning that a screen with nothing on it is off. In daylight that is
         * a thirteen-metre black rectangle standing in a bright green clearing,
         * and it reads unmistakably as a missing texture — the photographs were
         * embarrassing. It is also just wrong about the object: every outdoor
         * screen ever built is painted white, because the picture is projected
         * onto it rather than emitted by it, and by day the thing you see is the
         * paint.
         *
         * So the idle state is weathered off-white, and uDay does the work
         * that a lit material would have done — bright and slightly grey-blue at
         * noon, nearly nothing at midnight, at which point the fire in the
         * clearing and the moon are the only things picking it out. The mottling
         * is canvas grain and a little damp, on a very low frequency so it reads
         * as a fabric surface rather than as noise.
         */
        float grain = 0.82 + 0.18 * rrFbm2(vec3(p * 2.6, 0.0));
        float damp = 1.0 - 0.16 * rrFbm2(vec3(p * 0.9 + 4.0, 0.0));
        vec3 idle = vec3(0.46, 0.45, 0.43) * grain * damp
          * (0.045 + 0.955 * uDay)
          * inside;
        col = mix(idle, col, uLive);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
    defines: {
      BEZEL_LO: BEZEL.toFixed(4),
      BEZEL_HI: (1 - BEZEL).toFixed(4),
    },
    /**
     * Both sides, and there is nothing behind it any more. See the header.
     *
     * This does NOT double the fill: a quad is either front-facing or
     * back-facing at any pixel, never both, so the only thing turning culling
     * off costs is the pixels the back of a screen covers — which used to be
     * covered by the plank board this replaces, at the same price.
     */
    side: THREE.DoubleSide,
    // The pipeline renders into a linear HDR buffer and tone maps at the end.
    toneMapped: false,
  });
}

export class VideoSurface {
  /**
   * @param {object} options
   * @param {number} options.width metres
   * @param {number} options.height metres
   * @param {string} [options.name]
   * @param {boolean} [options.frame] build a timber surround
   * @param {number} [options.gain] brightness multiplier
   * @param {number} [options.audioRef] PannerNode reference distance
   * @param {number} [options.audioMax] PannerNode maximum distance
   * @param {number} [options.frameT] timber thickness, in the same units as width
   */
  constructor({
    width,
    height,
    name = 'screen',
    frame = true,
    gain = 1,
    audioRef = 6,
    audioMax = 120,
    frameT = null,
  }) {
    this.width = width;
    this.height = height;
    this.audioRef = audioRef;
    this.audioMax = audioMax;

    this.group = new THREE.Group();
    this.group.name = name;

    /**
     * THE PICTURE AND ITS TIMBER, UNDER ONE TRANSFORM OF THEIR OWN.
     *
     * One extra level of scene graph, and it exists so that a screen can be
     * RESIZED by a number instead of by rebuilding geometry. `ShareScreen` sets
     * `panel.scale` to the width in metres and everything in here — the quad,
     * the four bars, the backing board — grows together and in proportion, which
     * is what a bigger screen actually looks like.
     *
     * The alternative was disposing and re-allocating a PlaneGeometry and five
     * BoxGeometries on every wheel event, sixty times a second while somebody
     * spins a scroll wheel, and handing the GPU a fresh set of buffers each
     * time. This is one matrix.
     *
     * The legs are NOT in here, and that is the whole reason the split is at
     * this level rather than one higher: a leg has to reach the ground, and the
     * ground is where it is regardless of how big the screen got.
     */
    this.panel = new THREE.Group();
    this.panel.name = `${name}:panel`;
    this.group.add(this.panel);

    this.material = screenMaterial();
    this.material.uniforms.uGain.value = gain;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), this.material);
    this.mesh.name = `${name}:picture`;
    this.panel.add(this.mesh);

    if (frame) this._buildFrame(frameT);

    /**
     * ONE ELEMENT PER SURFACE, CREATED ONCE AND NEVER REPLACED.
     *
     * A `<video>` is expensive to construct and expensive to tear down — it
     * allocates a decoder — and a person toggling their share on and off would
     * otherwise do both several times a minute. Swapping `srcObject` on a
     * surviving element is what every media pipeline does for the same reason.
     *
     * It is never in the document. An element does not need to be laid out to
     * decode, and putting it in the page would either be visible or need styling
     * to stop it being visible.
     */
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.disablePictureInPicture = true;

    this.texture = new GatedVideoTexture(this.video);
    /**
     * A video frame is already display-referred, and the pipeline wants
     * linear — but setting this does NOT get that conversion done. It is set
     * for correctness of intent and left here so a reader doesn't go looking
     * for a decode that this alone would seem to promise. WebGLTextures
     * forces video textures onto a linear-transfer internal format regardless
     * of colorSpace (`forceLinearTransfer = texture.isVideoTexture`), so the
     * hardware never decodes on sample. The actual decode is the
     * `srgbToLinear` in the shader below, on the sampled value, by hand.
     */
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    /**
     * No mipmaps. `VideoTexture` already defaults this to false — restated
     * because it is a real decision rather than an inherited one: generating
     * them is a per-upload cost on the whole chain of a 1080p texture, which is
     * most of the price of the upload again, and this surface is never seen at a
     * grazing enough angle for aliasing to matter. It is a flat panel you stand
     * in front of, not a road going to the horizon.
     */
    this.texture.generateMipmaps = false;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.material.uniforms.uMap.value = this.texture;

    /** Whose picture this is, or null. Set by the layer that assigns tracks. */
    this.owner = null;
    this.live = false;

    this._videoTrack = null;
    this._audioTrack = null;
    this._audioNode = null;
    this._audioElement = null;
    this._source = null;
    this._engine = null;
    this._uploadAccum = 0;
    this._pendingFrame = false;
    this._frameCallback = null;
    this._fit = 1;
    /** Set once if `meanColour` ever throws. See there. */
    this._unreadable = false;
  }

  /**
   * How wide the picture actually is, in world metres.
   *
   * `width` is the geometry's width, which for everything descended from
   * `ShareScreen` is 1 — the panel is built at unit width and sized by a scale
   * (see the note on `this.panel`). Everything outside this class that wants to
   * reason about a screen's size in the world — how far its sound carries, how
   * far its light reaches — wants this number rather than that one.
   */
  get metreWidth() {
    return this.width * this.panel.scale.x;
  }

  /** Half the panel's diagonal, in world metres. The upload gate's sphere. */
  get boundingRadius() {
    return 0.5 * Math.hypot(this.width, this.height) * this.panel.scale.x;
  }

  _buildFrame(thickness = null) {
    /**
     * A timber surround, which is most of what makes this read as a thing
     * somebody built rather than as a rectangle floating in a wood.
     *
     * `makeLiving(..., 'prop')` so the frame melts with the forest during a trip
     * while the picture inside it only swims. That contrast is deliberate: the
     * world going soft around a screen that is still showing you a film is much
     * stranger than both going at once.
     */
    const wood = makeLiving(new THREE.MeshLambertMaterial({ color: 0x4b3524 }), 'prop');
    this.frameMaterial = wood;
    /**
     * The floor of 0.09 is right for a surface built at its true size and wrong
     * for one built at unit width and scaled up afterwards — there the floor is
     * 0.09 WIDTHS, which at four metres is a foot of timber round a picture.
     * `ShareScreen` passes its own proportional thickness for exactly that
     * reason; everything with real metres in its constructor gets the old rule.
     */
    const t = thickness ?? Math.max(0.09, this.width * 0.022);
    const w = this.width + t * 2;
    const h = this.height + t * 2;
    this.frameT = t;

    /**
     * Kept, so `dispose` can free them.
     *
     * Five BoxGeometries per surface, and until this array existed not one of
     * them was ever released: `dispose` freed the picture's PlaneGeometry, the
     * material, the texture and the panner, and silently leaked the timber. A
     * screen is disposed every time somebody leaves the room, so an evening of
     * people coming and going leaked a set per departure — invisible in a
     * profile, permanent in the GL context, and exactly the kind of thing that
     * only shows up as "the tab is using two gigabytes" hours later.
     */
    this._frameGeo = [];
    const bar = (sx, sy, x, y) => {
      const geometry = new THREE.BoxGeometry(sx, sy, t);
      this._frameGeo.push(geometry);
      const mesh = new THREE.Mesh(geometry, wood);
      /**
       * CENTRED ON THE PICTURE PLANE, not set back behind it.
       *
       * These sat at `z = -t/2` — flush with the front of the picture and
       * sticking a whole thickness out of the back — which was right when there
       * was a plank board behind them and the back of a screen was never meant
       * to be looked at. It is now, so the timber straddles the glass and a
       * screen has the same frame from either side. The bars are outside the
       * picture in x and y, so nothing z-fights.
       */
      mesh.position.set(x, y, 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.panel.add(mesh);
      return mesh;
    };
    bar(w, t, 0, (this.height + t) / 2);
    bar(w, t, 0, -(this.height + t) / 2);
    bar(t, h, -(this.width + t) / 2, 0);
    bar(t, h, (this.width + t) / 2, 0);

    /**
     * THE PICTURE CASTS THE SHADOW THE BACKING BOARD USED TO.
     *
     * Deleting the board deleted a caster as well as a surface, and without
     * this a screen in afternoon sun threw four thin bars of shade and nothing
     * in between — a frame lying on the grass with a hole in it, which reads as
     * a missing object rather than as a transparent one.
     *
     * It is nearly free: the shadow map here is redrawn when the sun anchor
     * steps, about seven times a minute, not per frame. `MeshDepthMaterial` is
     * substituted for the picture shader in that pass, so none of the video
     * path is touched — and the quad is opaque, so the silhouette is right
     * without an alpha test.
     */
    this.mesh.castShadow = true;
  }

  /**
   * Give this surface an audio graph.
   *
   * Separate from construction because the AudioContext does not exist until
   * somebody clicks through the gate, and the screens are built with the world.
   *
   * @param {import('../audio/engine.js').AudioEngine} engine
   */
  attachAudio(engine) {
    if (this._engine || !engine?.ready) return;
    this._engine = engine;
    this.group.getWorldPosition(_worldPos);
    /**
     * ON THE MUSIC BUS, WITH THE ROOM SEND, AND NEITHER IS ARBITRARY.
     *
     * The music bus because a film's soundtrack is the same *kind* of thing as
     * the jukebox — something playing in the world that a person might
     * reasonably want quieter than the wind and louder than their friends, and
     * a mix has exactly one slider for that idea. Putting it on the voice bus
     * would mean turning your friends down to turn the film down.
     *
     * The room send stays, unlike voice, and that is the interesting half:
     * `engine.js` keeps speech deliberately dry because a voice arrives at your
     * ear directly rather than being a sound happening in the wood. A film on a
     * fourteen-metre screen in a clearing is the opposite — it IS a sound
     * happening in the wood, and it should ring off the trees like the jukebox
     * does. That difference is most of why watching something here does not feel
     * like watching it in a browser tab.
     */
    this._source = engine.createSpatial(_worldPos, {
      refDistance: this.audioRef,
      rolloff: 1.15,
      maxDistance: this.audioMax,
      bus: engine.musicBus,
    });
    if (this._audioTrack) this._bindAudio(this._audioTrack);
    this.setAudioRange(this.audioRef, this.audioMax);
  }

  /**
   * How far a soundtrack carries, changed after the fact.
   *
   * A screen's audible range is a property of how big it is, and how big it is
   * is now something a person changes with a scroll wheel. A 1.2 m screen you
   * can hear from ninety metres away is a haunting; a 16 m one that goes silent
   * at twenty-six is a drive-in with the sound off. The panner is mutable and
   * these two numbers are the whole of it, so a resize just writes them.
   *
   * Ramping is not needed and would be wrong: `refDistance` and `maxDistance`
   * are curve PARAMETERS rather than gains, so changing them moves the whole
   * distance response at once rather than stepping the current sample, and there
   * is no discontinuity to smooth.
   */
  setAudioRange(refDistance, maxDistance) {
    this.audioRef = refDistance;
    this.audioMax = maxDistance;
    const panner = this._source?.panner;
    if (!panner) return;
    panner.refDistance = refDistance;
    panner.maxDistance = maxDistance;
  }

  /**
   * Show these tracks, or nothing.
   *
   * @param {MediaStreamTrack|null} video
   * @param {MediaStreamTrack|null} audio
   * @param {string|null} owner id of whoever this belongs to, for the UI
   */
  setTracks(video, audio, owner = null) {
    this.owner = video ? owner : null;
    if (video !== this._videoTrack) {
      this._videoTrack = video ?? null;
      this._bindVideo(video);
    }
    if (audio !== this._audioTrack) {
      this._audioTrack = audio ?? null;
      this._bindAudio(audio);
    }
  }

  _bindVideo(track) {
    if (this._frameCallback && this.video.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this._frameCallback);
      this._frameCallback = null;
    }
    if (!track) {
      this.video.srcObject = null;
      this._pendingFrame = false;
      return;
    }
    this.video.srcObject = new MediaStream([track]);
    this.video.play().catch(() => {
      /* muted playback needs no gesture; a rejection here is harmless */
    });

    /**
     * `requestVideoFrameCallback` is the difference between uploading when there
     * is something new and uploading hopefully.
     *
     * A shared screen delivers frames when the screen changes, which for a slide
     * left on a desk is *never*. Polling `currentTime` would re-upload an
     * identical image thirty times a second for the whole talk. Where the API is
     * missing (Firefox at the time of writing) the fallback below throttles on a
     * timer instead, which is worse and still bounded.
     */
    if (this.video.requestVideoFrameCallback) {
      const onFrame = () => {
        this._pendingFrame = true;
        if (this._videoTrack === track) {
          this._frameCallback = this.video.requestVideoFrameCallback(onFrame);
        }
      };
      this._frameCallback = this.video.requestVideoFrameCallback(onFrame);
    }
  }

  _bindAudio(track) {
    try {
      this._audioNode?.disconnect();
    } catch {
      /* ignore */
    }
    this._audioNode = null;
    if (this._audioElement) {
      this._audioElement.srcObject = null;
      this._audioElement = null;
    }
    if (!track || !this._engine?.ready) return;

    const stream = new MediaStream([track]);
    /**
     * The same Chromium quirk `voice.js` documents: a remote MediaStream that is
     * only wired into Web Audio never starts flowing. It needs a media element
     * to exist, muted, doing nothing.
     */
    const element = new Audio();
    element.srcObject = stream;
    element.muted = true;
    element.autoplay = true;
    element.volume = 0;
    element.play().catch(() => {});
    this._audioElement = element;

    this._audioNode = this._engine.ctx.createMediaStreamSource(stream);
    this._audioNode.connect(this._source.input);
  }

  /**
   * Where the picture is in the world, and how far the camera is from it.
   * Called once a frame by whoever owns the surface.
   *
   * @param {number} dt
   * @param {THREE.Camera} camera
   */
  update(dt, camera) {
    const material = this.material;

    /**
     * A screen is static between placements, so this is one flush per frame for
     * a group of eight objects rather than the per-frame necessity it was when
     * a panel followed a walking body. It is still not optional: `setPlacement`
     * writes `group.position` outside the render loop, and every world-space
     * question below — where is the sound coming from, which way is this facing
     * — would otherwise be answered about the previous spot on the frame
     * somebody moved it. One frame of a panner left in the old clearing is
     * audible, because the old clearing may be forty metres away.
     */
    this.group.updateMatrixWorld(true);

    const ready = Boolean(
      this._videoTrack &&
        !this._videoTrack.muted &&
        this.video.readyState >= 2 &&
        this.video.videoWidth > 0
    );

    // Crossfade rather than switch, so a share starting is a screen coming on
    // rather than a rectangle changing colour between two frames.
    const target = ready ? 1 : 0;
    const u = material.uniforms.uLive;
    u.value += (target - u.value) * Math.min(1, dt * 4.5);
    this.live = ready;

    /**
     * WHERE THE SOUND IS DOES NOT DEPEND ON WHETHER THE PICTURE HAS ARRIVED.
     *
     * This block used to sit below the `ready` gate, and `ready` is a question
     * about the VIDEO track — is there one, is it unmuted, has it decoded a
     * frame with a width. Audio is a separate track that starts flowing on its
     * own schedule, so every moment where audio was live and video was not left
     * the PannerNode parked whereever it last was.
     *
     * On a screen standing in a clearing that is survivable, because it does not
     * move. On a HELD one it is not: the panner is built by `attachAudio` at
     * construction, which is BEFORE `follow()` has ever run, so its coordinates
     * are the group's — the world origin. A person whose share audio opened
     * ahead of their first decoded frame was audible from the middle of the map
     * until the picture caught up.
     *
     * `updateMatrixWorld` ran at the top of this method, so the transform is
     * this frame's rather than last frame's.
     */
    if (this._source) {
      this.mesh.getWorldPosition(_worldPos);
      this._source.setPosition(_worldPos);
      this._source.setDistance(camera.position.distanceTo(_worldPos));
    }

    if (!ready) return;

    const fit = this.video.videoWidth / this.video.videoHeight / (this.width / this.height);
    if (Math.abs(fit - this._fit) > 1e-3) {
      this._fit = fit;
      material.uniforms.uFit.value = fit;
    }

    this._maybeUpload(dt, camera);
  }

  /**
   * The whole point of the file. See the header.
   *
   * Three gates, cheapest first: is the mesh drawn at all, is any of it on
   * screen, and has enough time passed for the distance it is at.
   */
  _maybeUpload(dt, camera) {
    if (!this.mesh.visible || !this.group.visible) return;

    this.mesh.getWorldPosition(_worldPos);
    const distance = camera.position.distanceTo(_worldPos);

    /**
     * A FRUSTUM TEST, WHERE THE BACKFACE TEST USED TO BE.
     *
     * The old gate asked "is the camera behind the plane", and it was the test
     * that saved the most: a screen faces one way and the clearing it stands in
     * is somewhere people walk through, so half of every pass through was free.
     * Both faces show a picture now, so that question has no answer worth
     * having and the saving had to be found somewhere else.
     *
     * Somewhere else is strictly better, as it happens. "Is any part of it on
     * screen" subsumes the case the old test caught — a screen you have your
     * back to is behind the camera — and adds every screen that is off to the
     * side or behind a hill, which the old one uploaded happily. The bounding
     * sphere is the panel's full diagonal, so the timber and the legs are
     * inside it too and a screen entering the view from the edge is already
     * uploading before its picture is visible.
     *
     * `camera.matrixWorldInverse` is ONE FRAME OLD here: three writes it during
     * `render`, and this runs in the update half of the frame. That is a
     * deliberate non-fix — correcting it means an `updateMatrixWorld` and an
     * inversion per surface per frame to buy a 16 ms difference in when a
     * screen at the very edge of the frame starts uploading, and the sphere's
     * margin is worth several frames of turning.
     */
    _viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_viewProjection);
    _sphere.center.copy(_worldPos);
    _sphere.radius = this.boundingRadius;
    if (!_frustum.intersectsSphere(_sphere)) return;

    const interval =
      distance <= FULL_RATE_M
        ? 0
        : Math.min(1 / MIN_RATE_HZ, ((distance / FULL_RATE_M) ** 2 - 1) / 30);

    this._uploadAccum += dt;
    if (this._uploadAccum < interval) return;
    this._uploadAccum = 0;

    // With rVFC there is a definite answer to "is there anything new"; without
    // it, assume yes and let the interval do the limiting.
    if (this.video.requestVideoFrameCallback && !this._pendingFrame) return;
    this._pendingFrame = false;
    this.texture.needsUpdate = true;
  }

  /** Hide the whole surface — used when nobody is sharing to it. */
  setVisible(on) {
    this.group.visible = on;
  }

  /** 1 in full daylight, 0 at night. See `uDay`. */
  setDaylight(v) {
    this.material.uniforms.uDay.value = v;
  }

  /**
   * The average colour of whatever is on the picture, in LINEAR space.
   *
   * What `ScreenGlow` needs and the only thing in this file that reads a video
   * frame back to the CPU. Called at most a handful of times a second, for at
   * most one screen in the world — see the caller, which owns the whole budget.
   *
   *
   * WHY A CANVAS AND NOT THE GPU.
   *
   * The colour of the light a screen throws is the average of the picture, and
   * the GPU is holding the picture already: the textbook answer is to generate
   * mipmaps and read the 1×1 level, or to run a reduction pass. Both are wrong
   * here for the same reason. Mipmaps are explicitly refused a few lines up —
   * generating them is most of the price of the upload again, on EVERY upload,
   * to serve a reader that wants six samples a second. A reduction pass is a
   * render target, a program and a `readPixels`, and `readPixels` is a pipeline
   * stall measured in whole frames.
   *
   * Drawing the `<video>` into an eight-by-five canvas asks the browser for the
   * one thing it is already extremely good at — scaling a decoded frame — and
   * the read that follows is forty pixels off a canvas the GPU never touched.
   * `willReadFrequently` is what keeps it that way: without it the 2D context
   * lives in video memory and every `getImageData` is a readback with a flush
   * behind it, which is the cost this whole approach exists to avoid.
   *
   * EIGHT BY FIVE rather than 1×1, because scaling to a single pixel is not
   * meaningfully cheaper — the source is the same 1080p frame either way — and
   * a handful of cells is what stops a letterboxed film reporting "mostly
   * black" quite as flatly.
   *
   * @param {THREE.Color} out written in linear-sRGB, the renderer's working space
   * @returns {boolean} false when there was nothing to read
   */
  meanColour(out) {
    if (this._unreadable) return false;
    if (this.video.readyState < 2 || this.video.videoWidth === 0) return false;

    const ctx = sampleContext();
    if (!ctx) return false;

    try {
      ctx.drawImage(this.video, 0, 0, SAMPLE_W, SAMPLE_H);
      const { data } = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
      let r = 0;
      let g = 0;
      let b = 0;
      /**
       * Averaged in LINEAR light, through the same decode the shader does by
       * hand. Averaging the bytes instead and decoding once at the end is a
       * whole stop out on any picture with contrast in it — a frame that is
       * half black and half white averages to mid-grey, which decodes to 0.21
       * rather than the 0.5 that is actually leaving the screen — and it is
       * exactly the frame (a letterboxed film, a slide) this is asked about.
       */
      for (let i = 0; i < data.length; i += 4) {
        r += SRGB_TO_LINEAR[data[i]];
        g += SRGB_TO_LINEAR[data[i + 1]];
        b += SRGB_TO_LINEAR[data[i + 2]];
      }
      const n = SAMPLE_W * SAMPLE_H;
      out.setRGB(r / n, g / n, b / n);
      return true;
    } catch {
      /**
       * A tainted canvas, or a decoder that will not hand over a frame.
       * Neither is recoverable and neither is worth retrying six times a
       * second for the rest of the evening, so this surface simply stops being
       * asked and its glow stays at whatever colour it last had.
       */
      this._unreadable = true;
      return false;
    }
  }

  dispose() {
    this.setTracks(null, null);
    /**
     * The element as well as the tracks. `setTracks(null, null)` clears
     * `srcObject`, which is enough for the renderer and not enough for the
     * decoder: an element that has had a stream in it holds its buffers until it
     * is told to reload, and a surface being disposed is by definition never
     * going to be told anything again.
     */
    this.video.srcObject = null;
    this.video.removeAttribute('src');
    this.video.load();
    this.texture.dispose();
    this.material.dispose();
    this.frameMaterial?.dispose();
    this.mesh.geometry.dispose();
    for (const geometry of this._frameGeo ?? []) geometry.dispose();
    this._source?.dispose();
    this.group.removeFromParent();
  }
}

/* -------------------------------------------------------------------------- */
/* a share, which is a screen standing where somebody put it                    */
/* -------------------------------------------------------------------------- */

/**
 * The bottom edge of a placed screen, in metres above the ground under it.
 *
 * Proportional, and it is the drive-in's rule: the four people who sat at the
 * front must not block it for the six who arrived later. A 1.2 m screen is a
 * thing on a stand at chest height and nobody sits in front of it; a sixteen
 * metre one wants its bottom edge clear over a standing head. Both ends of that
 * fall out of `w * 0.18` clamped, and the top of the clamp is 2.4 m because that
 * is what the fourteen-metre screen this feature replaces was built at.
 */
const baseFor = (w) => Math.min(2.4, Math.max(0.35, w * 0.18));

/**
 * How tall a screen of this width stands, ground to top edge, in metres.
 *
 * EXPORTED BECAUSE SOMEWHERE HAS A ROOF ON IT. Every caller that stands a screen
 * up now has to ask whether it fits before it does — `aimGround` hands back the
 * clear height of the passage you are aiming into and this is the number to
 * compare it against. Derived from `baseFor` and the 16:9 rather than written
 * down again, because the two would drift the first time either was tuned and
 * the symptom would be a screen refused in a chamber it fits in.
 *
 * It is a surprisingly big number. The 4.2 m default stands 3.12 m tall, which
 * is more than a squeeze in rock has; that is a property of screens rather than
 * a problem with this, and it is exactly why the question is asked.
 */
export const screenStandHeight = (w) => baseFor(w) + w * (9 / 16);

/** Legs, as a fraction of half the width. Inboard of the corners, like an easel. */
const LEG_SPAN = 0.82;


/**
 * Brightness, and why it is not 1.
 *
 * 0.88 is what the fourteen-metre commons screen was built at, for the reason
 * that file gave: this is an unlit emissive rectangle in a scene with a bloom
 * chain on it, and at unity a white frame reads as a hole cut in the world with
 * the bloom smearing it across the trees.
 */
const SCREEN_GAIN = 0.88;

/**
 * Somebody's shared screen, standing where they put it.
 *
 * ONE OBJECT ACROSS EVERY MOVE AND RESIZE, AND THE REASON IS THE `<video>`
 * ELEMENT. The base constructor's own note says an element is expensive to build
 * and expensive to tear down because it allocates a decoder, which is why
 * `srcObject` is swapped on a survivor rather than the element being replaced.
 * Moving a screen across a clearing is exactly that kind of event — somebody
 * does it several times an evening, mid-film — so `setPlacement` is a transform
 * and a scale and touches no media at all. The alternative, rebuilding the
 * surface wherever the screen went, is a black frame for everybody watching
 * every time the owner takes a step and decides the view was better over there.
 */
export class ShareScreen extends VideoSurface {
  constructor(options = {}) {
    super({
      /**
       * BUILT AT UNIT WIDTH. Every dimension in here is a fraction of the
       * screen's width, and `panel.scale` turns that into metres. See the note
       * on `this.panel` in the base constructor for why resizing is a matrix
       * rather than a rebuild.
       */
      width: 1,
      height: 9 / 16,
      name: 'share-screen',
      frame: true,
      frameT: 0.025,
      gain: SCREEN_GAIN,
      audioRef: 3.4,
      audioMax: 26,
      ...options,
    });

    /** @type {null | import('../net/protocol.js').Placement} */
    this.placement = null;

    /**
     * Two legs, built once and never rebuilt.
     *
     * A unit cylinder scaled in Y, so a leg reaching for uneven ground is a
     * number rather than a new buffer — the same argument the panel's scale
     * makes, applied to the one part of this object that cannot be scaled with
     * the picture because it has to touch something that is not moving.
     */
    this._legGeo = new THREE.CylinderGeometry(1, 1, 1, 6);
    this.legs = [-1, 1].map((side) => {
      const leg = new THREE.Mesh(this._legGeo, this.frameMaterial);
      leg.name = 'share-screen:leg';
      leg.castShadow = true;
      leg.receiveShadow = true;
      leg.userData.side = side;
      leg.visible = false;
      this.group.add(leg);
      return leg;
    });

    /**
     * BORN HIDDEN, and this is the one line of the constructor with a history.
     *
     * It used to call `setPlacement({mode:'held'})`, because a share began in
     * somebody's hands and a screen therefore had a sensible default place to
     * be. There is no such place any more — a screen exists at a spot or it does
     * not exist — and a surface built visible would stand at the world origin,
     * at unit width, for however many frames pass between `routeShares` creating
     * it and the placement it was created in response to being applied.
     */
    this.setVisible(false);
  }

  /**
   * Stand it somewhere, or take it away.
   *
   * @param {null | import('../net/protocol.js').Placement} at
   */
  setPlacement(at) {
    this.placement = at;
    if (!at) {
      this.setVisible(false);
      return;
    }
    this.setVisible(true);

    const w = at.w;
    this.panel.scale.setScalar(w);
    /**
     * Audible range follows size, and the coefficients are back-derived from the
     * screen this replaced: 13.4 m wide was tuned to `refDistance` 9 and
     * `maxDistance` 90, which is "you can hear it from most of the clearing and
     * not from the next one". The floors stop the smallest screen anybody can
     * make from being one you have to stand on top of to hear — 1.2 m would
     * otherwise come out at a refDistance of 0.8, which is inside your own head.
     */
    this.setAudioRange(Math.max(3.4, w * 0.68), Math.max(26, w * 6.8));

    const h = w * (9 / 16);
    const base = baseFor(w);
    this.group.position.set(at.x, at.y + base + h / 2, at.z);
    this.group.rotation.set(0, at.yaw, 0);
    this._standLegs(at, w, h, base);
  }

  /**
   * Reach each leg down to whatever is under it.
   *
   * Sampled per leg rather than once at the middle, because the ground a screen
   * is standing on is a height FIELD and not a plane: on any slope worth the
   * name a pair of equal legs leaves one of them buried and the other hanging in
   * the air, and the hanging one is the tell that this is a decal rather than an
   * object. Two samples buy an easel that sits on a hill.
   */
  _standLegs(at, w, h, base) {
    const off = (w / 2) * LEG_SPAN;
    const cos = Math.cos(at.yaw);
    const sin = Math.sin(at.yaw);
    const r = Math.max(0.035, w * 0.016);
    /** The bottom edge of the timber, in world metres. Where a leg starts. */
    const topY = at.y + base;

    for (const leg of this.legs) {
      const side = leg.userData.side;
      const lx = at.x + cos * side * off;
      const lz = at.z - sin * side * off;
      /**
       * THE SAME FLOOR THE SCREEN ITSELF WAS STOOD ON, asked the same way.
       *
       * This was `Math.max(heightAt(lx, lz), WATER_LEVEL)` — clamped to the
       * waterline for the same reason the jetty's deck is: on a riverbed
       * `heightAt` keeps going down under the water, so a screen put down at the
       * edge of the stream grew a pair of two-metre stilts disappearing into it.
       * `standingFloor` still does exactly that on the surface, and the clamp is
       * still the reason it does.
       *
       * What it adds is the other floor. A screen standing in a passage is at
       * `at.y`, which came out of a march against the CAVE floor, while the legs
       * sampled the height field and reached for the hillside thirty metres
       * overhead — so `topY - groundY` went hugely negative, `drop` collapsed to
       * its 12 cm minimum, and a screen underground stood on two stubs with a
       * gap under them. Fixing the placement alone would have left exactly that,
       * which is why the two questions are now one function.
       *
       * `at.y + STAND_PROBE_M` and not `at.y`: the answer depends on the height
       * it is asked from as well as the xz, and a point exactly ON a floor is
       * the one height that does not say. The constant is imported rather than
       * written as a 1 because `aimGround` resolved the placement from the same
       * height — if the two ever disagreed, the legs would end on a different
       * ring's floor from the picture they hold up. See `STAND_PROBE_M`.
       */
      const groundY = standingFloor(lx, lz, at.y + STAND_PROBE_M);
      /**
       * ONE NUMBER, USED FOR BOTH THE LENGTH AND THE POSITION.
       *
       * These were two expressions — `max(0.12, topY - groundY)` for the scale
       * and the raw `topY - groundY` for the offset — which agree everywhere
       * except where the clamp bites, and where it bites they disagree by
       * exactly half the shortfall. Ground that rises to within 12 cm of the
       * timber (a bank the screen is backed against, or a 1.2 m screen whose
       * `baseFor` floor is only 35 cm off the deck) gave a leg of the minimum
       * length hanging in the air above where it was told to reach. Rare, silent,
       * and precisely the "one leg not touching" tell the per-leg sampling three
       * lines up exists to avoid.
       */
      const drop = Math.max(0.12, topY - groundY);
      leg.visible = true;
      leg.scale.set(r, drop, r);
      /**
       * Positioned in the group's own frame, which is unrotated-and-unscaled
       * local space — the panel's scale is on a sibling, so these are metres.
       * The group origin sits at the middle of the picture, hence the -h/2.
       */
      leg.position.set(side * off, -h / 2 - drop / 2, 0);
    }
  }

  /**
   * NOTHING FOLLOWS ANYBODY, AND THAT IS THE WHOLE OF THE PER-FRAME COST NOW.
   *
   * There was a `follow(feet, yaw)` here that ran once a frame for every held
   * screen in the room: it read an interpolated network avatar's transform,
   * placed the panel off the owner's left shoulder, angled it in, and added two
   * sines of drift so it read as carried rather than welded. All of it is gone
   * with the held state, and what went with it is a class of bug rather than a
   * few instructions — a screen positioned from a body two ticks behind live is
   * a screen whose PannerNode, backface test and upload gate are all answering
   * questions about where it was, which is the reason `update()` still opens
   * with a `updateMatrixWorld` it now barely needs.
   *
   * A screen is written once, when somebody moves it, and is a static mesh in a
   * forest until they move it again.
   */

  dispose() {
    super.dispose();
    this._legGeo.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/* the light a screen throws                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Past this the glow is off entirely, and it is also the longest a light is
 * allowed to reach. Chosen from the biggest screen anybody may make: a sixteen
 * metre picture at night genuinely does light a clearing that size, and a small
 * one never gets near the clamp.
 */
const GLOW_REACH_M = 34;
/** Metres of reach per metre of screen. A 4 m screen lights about 10 m of wood. */
const GLOW_REACH_PER_M = 2.4;
/** The closest a screen's light may fall off, so a 1.2 m panel still spills. */
const GLOW_REACH_MIN_M = 7;
/**
 * Falloff exponent. Physically 2, and 1.5 for the same reason `campfire.js`
 * uses 1.6: an inverse square from a source this bright either scorches the
 * first two metres or reaches nothing at eight.
 */
const GLOW_DECAY = 1.5;
/**
 * Overall brightness, and the one number to turn if the glow is too much.
 *
 * CALIBRATED AGAINST THE FIRE, because there is one other light in this world
 * and "as bright as that, from further away" is the only scale anybody can
 * check. A hearth peaks at 2.7 with decay 1.6 over 11 m, which puts ~0.46 of
 * irradiance on the ground three metres out — the reading at which a fire
 * visibly lights the people around it. A seven-metre screen showing an ordinary
 * picture lands within about 20% of that at NINE metres, which is roughly the
 * relationship the two things have in a real clearing.
 *
 * The first value here was 5.0, arrived at by reasoning about it, and it was
 * wrong by a factor of four: differenced against the same frame with the light
 * pinned off, it moved the mean luminance by 0.3 of a level out of 255 and
 * moved NO pixel by as much as 2%. A light that survives a pixel diff only as a
 * rounding error is not a light, whatever the numbers in the debug readout say.
 */
const GLOW_GAIN = 26;
/** How the light scales with the screen. Linear in width, clamped both ends. */
const GLOW_SIZE_BASE = 0.45;
const GLOW_SIZE_PER_M = 0.16;
const GLOW_SIZE_MAX = 2.2;
/**
 * …and no brighter than this whatever the picture is doing.
 *
 * The ceiling binds on exactly one case and it is the case that would look
 * broken: the largest screen anybody may make, showing a white slide, at night.
 * Uncapped that is four times this, which in an HDR buffer with a bloom chain on
 * it is not "a bright clearing" but a white clearing with the trees smeared
 * into it. At 12 a sixteen-metre screen lays about a fire's worth of light on
 * the ground TEN metres away rather than three, which is what a drive-in
 * actually does and is already the most dramatic thing in the world.
 */
const GLOW_MAX_INTENSITY = 12;
/** What is left of the glow at noon. A screen in sunlight barely lights a thing. */
const GLOW_DAY_FLOOR = 0.15;
/**
 * What is left of it when the picture is black. Not nothing: a screen is on.
 *
 * The surface itself is never truly dark even when its content is — there is a
 * grain and a scanline in the fragment shader, and the standby canvas underneath
 * the crossfade — so a light that went out entirely on a fade to black would
 * disagree with the thing it is supposed to be coming from.
 *
 * 0.04 rather than the 0.1 this started at, and the difference is the whole
 * reason it is a named constant. Measured with a screen showing solid #0a0a0a
 * at midnight, 0.1 put the clearing under an intensity of 2.96 — BRIGHTER THAN
 * THE CAMPFIRE, from a black rectangle. Every letterboxed film has long dark
 * stretches and every one of them would have lit the wood like a bonfire.
 */
const GLOW_DARK_FLOOR = 0.04;
/** How fast the light follows a cut. 1/6 s to most of the way there. */
const GLOW_RESPONSE = 6;
/** Colour samples a second. See `meanColour` for what one costs. */
const GLOW_SAMPLE_HZ = 6;
/** Below this much light there is no point reading the picture back at all. */
const GLOW_SAMPLE_FLOOR = 0.02;
/** The light may only move to another screen once it is this close to out. */
const GLOW_HANDOVER = 0.06;

const _glowPos = new THREE.Vector3();
const _glowSample = new THREE.Color();

/**
 * The light every screen in the world casts, which is one light.
 *
 *
 * WHY THERE IS ONE OF THESE AND NOT ONE PER SCREEN.
 *
 * The same argument `campfire.js` makes at length, and it is the reason this
 * class exists rather than a `PointLight` in the `ShareScreen` constructor. In
 * three the light COUNT is compiled into every material's program: the ground,
 * every trunk, every blade of grass, every avatar. A light per share is
 * `NUM_POINT_LIGHTS 2` in an empty room and 10 in a full one — ten light
 * evaluations per fragment across a forest that is already fill-bound, to light
 * up eight screens seven of which are somewhere else — AND a recompile of every
 * program in the world each time somebody starts or stops sharing, which is a
 * hitch of a couple of hundred milliseconds at the exact moment the room turns
 * to look at something.
 *
 * So there is exactly one, and it stands at whichever screen is nearest,
 * handing over only while it is dark enough that the move cannot be seen.
 *
 *
 * AND WHY IT IS IN THE SCENE BEFORE ANYBODY HAS SHARED ANYTHING.
 *
 * `net/index.js` builds this at attach time, long before the first share, and
 * it sits at zero intensity until there is something to light. That looks like
 * waste and is the entire point: the light count is part of a program's
 * identity, so a light that ARRIVES mid-session invalidates the compiled
 * program of every material in the world at once. Being present from the start
 * means the pre-warm in main.js compiles against the lighting the real draw
 * will use.
 *
 * BOTH HALVES OF THAT TRADE WERE MEASURED, because the resident light is not
 * free and the argument is worthless without the two numbers side by side.
 *
 *   What it costs to keep. A-B-B-A over three stations, adding and removing the
 *   light between arms on one session, nothing being shared so the light is at
 *   zero the whole time:
 *
 *     clearing.peak   +0.14 ms   3.2%
 *     canopy.peak     +0.19 ms   3.9%
 *     deep.peak       +0.24 ms   4.3%
 *
 *   About what MSAA 2→4 costs. Every session pays it, including the ones where
 *   nobody ever shares anything.
 *
 *   What it costs to add one later. 1.3 to 1.5 SECONDS on the frame the light
 *   count changes — a cold recompile of all 57 programs in the world, timed
 *   with a `finish()` so the driver could not defer it, and reproducible across
 *   runs. (Every toggle after the first is ~1.3 ms, because ANGLE's program
 *   cache now holds both permutations. Which is a trap: measure this by
 *   flipping it twice and it looks free.)
 *
 * Four per cent of every frame against a one-and-a-half second freeze at the
 * exact moment the room turns to look at a picture. It is not close.
 *
 * IT IS ALSO WHY THERE IS NO SETTING FOR THIS, which is the obvious next
 * thought and is wrong for the same reason: a quality knob that removed the
 * light would spend 1.4 s to save 0.2 ms, and Auto walks the ladder on its own
 * several times a session. And why nothing here ever sets
 * `light.visible = false` — the renderer skips invisible objects before it
 * counts lights, so hiding one costs exactly what deleting it costs. (Which is
 * also why the isolate switch in main.js does not pick this up with the
 * screens — see `screens` there.)
 *
 *
 * THE COLOUR COMES FROM THE PICTURE, six times a second, for one screen. That
 * is the only per-frame CPU cost in here beyond a walk over at most eight
 * surfaces, and it is skipped entirely in daylight, at a distance, and while
 * every screen in the room is blank.
 */
export class ScreenGlow {
  constructor() {
    const light = new THREE.PointLight(0xffffff, 0, GLOW_REACH_MIN_M, GLOW_DECAY);
    light.name = 'screen-glow';
    /**
     * No shadows, for the reason the hearth gives: a shadow-casting point light
     * is six shadow renders, and this project spent a whole optimisation pass
     * getting the number of shadow renders down to seven a minute.
     */
    light.castShadow = false;
    this.light = light;

    /** The surface the light is currently standing at, or null. */
    this._lit = null;
    /** Smoothed, and what the light actually reads. */
    this._colour = new THREE.Color(1, 1, 1);
    /** Where the smoothing is going: the last sample, normalised to its peak. */
    this._target = new THREE.Color(1, 1, 1);
    this._intensity = 0;
    /** Linear luminance of the last sample. Carries the brightness half. */
    this._luma = 0.25;
    this._sampleAccum = 0;
  }

  /**
   * @param {number} dt
   * @param {THREE.Camera} camera
   * @param {VideoSurface[]} surfaces every screen currently drawn, in any order
   */
  update(dt, camera, surfaces) {
    /**
     * The nearest screen with a picture on it.
     *
     * `uLive` rather than `live`, so the light fades in with the crossfade
     * rather than snapping on a frame before it — and so a screen whose share
     * has just stopped stops being a candidate as its picture goes, instead of
     * holding the light at full while fading to blank canvas.
     */
    let best = null;
    let bestD = Infinity;
    for (const surface of surfaces) {
      if (surface.material.uniforms.uLive.value < 0.02) continue;
      surface.mesh.getWorldPosition(_glowPos);
      const d = camera.position.distanceTo(_glowPos);
      if (d < bestD) {
        bestD = d;
        best = surface;
      }
    }

    /**
     * Hand over only in the dark, or when there is nothing to hand over from.
     *
     * Same rule as the hearth's: moving a point light that is lighting anything
     * is visible as a jump, and it does not need to be fast — the nearest
     * screen only changes at the midpoint between two of them, where both are
     * far enough away to be dim. `gone` is the case that rule does not cover:
     * a screen whose owner left is disposed and out of `surfaces`, so there is
     * no fade to wait for and nothing at the old position to explain the light.
     */
    const gone = this._lit !== null && !surfaces.includes(this._lit);
    if (this._lit !== best && (gone || this._intensity < GLOW_HANDOVER)) this._lit = best;

    let target = 0;
    const lit = this._lit;
    if (lit) {
      lit.mesh.getWorldPosition(_glowPos);
      this.light.position.copy(_glowPos);

      const w = lit.metreWidth;
      this.light.distance = Math.min(
        GLOW_REACH_M,
        Math.max(GLOW_REACH_MIN_M, w * GLOW_REACH_PER_M)
      );

      /**
       * Everything about how much light there is EXCEPT what is on the picture:
       * how big the screen is, how far in the crossfade it is, how far away you
       * are, and what time it is. Kept separate from the colour term because it
       * is also the test for whether reading the picture back is worth doing —
       * a screen that is going to contribute nothing does not get sampled.
       *
       * The daylight term is the one the fires taught: this is an HDR buffer
       * with a bloom chain on it, and a light source at full strength under a
       * midday sky blooms into a white blob that reads as a bug.
       */
      const live = lit.material.uniforms.uLive.value;
      const night = 1 - lit.material.uniforms.uDay.value;
      /**
       * MEASURED TO THE SCREEN THE LIGHT IS ACTUALLY AT, not to the nearest one.
       *
       * This read `bestD` — the distance to the CANDIDATE — and the two are the
       * same number except in precisely the situation the handover guard above
       * exists to create. Walk from one screen to another and the guard keeps
       * the light on the first while the second is already nearest; the falloff
       * would then be computed from the near screen and applied to the far one,
       * so the light it is waiting to see fade would instead get BRIGHTER as
       * you approached its replacement. The guard would never open and the
       * light would stay behind you, at the wrong screen, for as long as you
       * stood there.
       */
      const reach = Math.max(0, 1 - camera.position.distanceTo(_glowPos) / GLOW_REACH_M);
      const size = Math.min(GLOW_SIZE_MAX, GLOW_SIZE_BASE + w * GLOW_SIZE_PER_M);
      const envelope = size * live * reach * (GLOW_DAY_FLOOR + (1 - GLOW_DAY_FLOOR) * night);

      if (envelope > GLOW_SAMPLE_FLOOR) {
        this._sampleAccum += dt;
        if (this._sampleAccum >= 1 / GLOW_SAMPLE_HZ) {
          this._sampleAccum = 0;
          if (lit.meanColour(_glowSample)) this._absorb(_glowSample);
        }
        target = Math.min(
          GLOW_MAX_INTENSITY,
          GLOW_GAIN * envelope * (GLOW_DARK_FLOOR + (1 - GLOW_DARK_FLOOR) * this._luma)
        );
      }
    }

    /**
     * Smoothed, and both halves at the same rate.
     *
     * A screen's light really does change as fast as its content does, and
     * following it exactly is wrong twice over: a cut to white is a strobe, and
     * a film at 24 fps sampled at 6 Hz would beat against itself. A sixth of a
     * second to most of the way there is fast enough that a scene change is
     * legible on the trees and slow enough that nothing flashes.
     */
    const k = Math.min(1, dt * GLOW_RESPONSE);
    this._intensity += (target - this._intensity) * k;
    this._colour.lerp(this._target, k);
    this.light.intensity = this._intensity;
    this.light.color.copy(this._colour);
  }

  /**
   * Split a sample into a hue and a brightness.
   *
   * The light's colour is normalised to its brightest channel and the magnitude
   * goes into the intensity instead, because putting both into `light.color`
   * double-counts: three multiplies colour by intensity, so a dark blue frame
   * would arrive as a dark blue that is then dimmed again, and by the time a
   * night scene is dim enough it has also lost its colour. Normalised, a moonlit
   * frame is properly blue and properly faint, which is what it looks like on a
   * wall.
   */
  _absorb(sample) {
    this._luma = 0.2126 * sample.r + 0.7152 * sample.g + 0.0722 * sample.b;
    const peak = Math.max(sample.r, sample.g, sample.b);
    // A frame of pure black has no hue to take. Leave the last one standing;
    // the intensity term has already taken it to nothing anyway.
    if (peak > 1e-4) this._target.copy(sample).multiplyScalar(1 / peak);
  }

  dispose() {
    this._lit = null;
    this.light.removeFromParent();
  }
}

