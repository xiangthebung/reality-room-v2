import * as THREE from 'three';

/**
 * OCTAHEDRAL IMPOSTORS — the fourth distance band, and the only one that is
 * not made of the tree.
 *
 * WHAT THIS IS FOR, MEASURED BEFORE IT WAS BUILT.
 *
 * `treeReach` became a runtime knob and `reach-visible.mjs` was written to ask
 * whether shortening it is visible. At eye level the answer is no, emphatically:
 * a rainforest occludes itself, and cutting the reach from 384 m to 120 m moves
 * 0.02-0.05% of the pixels at every station a player can stand in. Above the
 * canopy the answer is the opposite, and the numbers are not close:
 *
 *     station        250 m     180 m     120 m     (preset pinned at high)
 *     above (+55 m)   1.60%     3.64%     4.47%
 *     above-flat      14.69%    25.39%    31.27%
 *       (+70 m)
 *
 * `.perf/shots/above-flat-potato.png` is what 31% looks like: a bare, hazy
 * heightfield running to the horizon with no treeline on it at all, against
 * `above-flat-high.png` which is canopy all the way out.
 *
 * FOG CANNOT FIX THAT, AND THE REASON IS WORTH WRITING DOWN because the
 * `treeReach` block in quality.js very nearly argues the opposite. Fog mixes a
 * SURFACE toward `fogColor`; it does not put a surface where there is none. A
 * tree at 300 m under sober density transmits 0.05% of its own colour, so it is
 * fogColor — but fogColor against the sky just above the horizon is a different
 * colour from the sky, and that difference is the treeline. Delete the tree and
 * you do not get a faded tree, you get sky. What a reach cut removes above the
 * canopy is the SILHOUETTE, and no density hides the absence of one.
 *
 *
 * WHAT AN OCTAHEDRAL IMPOSTOR IS.
 *
 * One camera-facing quad — four vertices, two triangles — textured from an
 * atlas of the same tree pre-rendered from 64 directions spread over the upper
 * hemisphere. The directions are laid out by a hemi-octahedral parameterisation:
 * the unit hemisphere is folded flat onto a square, so a regular grid on that
 * square is a near-uniform spread of view directions, and the mapping from "what
 * direction am I looking from" to "which cell of the atlas" is four instructions
 * with no branching and no search.
 *
 * The fragment shader then blends the THREE nearest cells barycentrically,
 * each one sampled through a ray-plane intersection against its own baked view
 * plane. That is the part that makes it an impostor rather than a billboard:
 * the silhouette parallaxes as you move, because the three sprites being
 * blended disagree about where the crown is and the disagreement is exactly the
 * parallax. A single-sprite billboard rotates to face you and reads as a
 * cardboard cut-out; this does not.
 *
 * The technique is Ryan Brucks's (shaderbits.com/blog/octahedral-impostors);
 * the hemisphere-rather-than-sphere choice and the "30 000 vertices becomes 12"
 * headline are from the Godot reference implementation. This file is a minimal
 * version written for this repo rather than a vendored one — see WHY NOT THE
 * LIBRARY below.
 *
 *
 * WHY NOT THE LIBRARY (agargaro/octahedral-impostor).
 *
 * It was read and evaluated first, and it is good. It bakes at runtime into a
 * WebGLRenderTarget, which is the right shape for a per-session procedural
 * world; it composes with MeshLambertMaterial through onBeforeCompile; it
 * supports USE_INSTANCING. Three things decided against it here:
 *
 *   1. It extends `Mesh<PlaneGeometry>` and owns its own object. Every tree in
 *      this world is a span inside a shared slab owned by `packSlab`, inserted
 *      by a worker payload, and mirrored into a second mesh by `mirrorOf`. An
 *      impostor here has to be an ordinary `InstancedMesh` that the existing
 *      packer can drive — 15 more `addStreamed` calls and nothing else. That is
 *      a material and a bake, not a mesh class.
 *
 *   2. Its atlas defaults (2048 px, 16 sprites a side, albedo + normal) are
 *      250 MB across our 15 archetypes. The knobs are exposed, so this is not
 *      an objection to the library so much as to using it unexamined — but once
 *      the atlas is 1024/8 and there is no normal map because the impostors are
 *      never lit, most of what the library does is gone.
 *
 *   3. It would be a dependency added to a repo with two, for about 200 lines
 *      of shader that has to be modified anyway to reach this project's fog,
 *      instance tint and slab conventions.
 *
 * The debt of that decision is real and is recorded here: the maths below is
 * the library's maths and Brucks's before it, and if this ever needs a normal
 * map, a full sphere, or a depth-parallax term, vendoring it is the better
 * second move than growing this file.
 *
 *
 * WHAT IT COSTS. Measured — see the report at the bottom of this comment block
 * and the numbers in `forest.js`'s IMPOSTOR_REACH block.
 */

/**
 * The renderer, handed over by the pipeline, because the forest never sees one.
 *
 * `buildForest(scene, seed)` takes no renderer and is called at main.js:182,
 * before `new Pipeline(renderer, scene, camera)` at 288. The bake needs a
 * renderer and a live GL context, so it cannot happen during the build.
 *
 * THE ALTERNATIVES WERE WORSE. A hook in main.js is the obvious answer and is
 * not this agent's file to write; `onBeforeRender` on the impostor mesh would
 * hand us a renderer but only from INSIDE a render pass, and re-entering
 * `renderer.render` there means clobbering the render target, the render list
 * and `renderer.info` of the frame that called us. So the pipeline — which is
 * this module's own neighbour and already owns the renderer — publishes it
 * here, and `forest.cull()` picks it up on a later frame.
 *
 * Deliberately a module-level single value and not a registry: there is exactly
 * one WebGLRenderer in this application, and a second one would mean a second
 * GL context, which could not share this texture anyway.
 */
let bakeRenderer = null;

/** Called once by the Pipeline constructor. See the block above. */
export function provideRenderer(renderer) {
  bakeRenderer = renderer;
}

/** The renderer, or null if the pipeline has not been built yet. */
export function bakeRendererReady() {
  return bakeRenderer;
}

/**
 * Atlas geometry. Both of these are in the fragment shader as uniforms rather
 * than as defines, so changing them here changes everything without a recompile.
 *
 * 1024 / 8 GIVES 128 px SPRITES, AND THAT IS SIZED AGAINST THE SCREEN rather
 * than picked. The impostor band starts where the canopy geometry stops, which
 * is `leafReach`: 384 m at high and ultra (so the band is empty and they are
 * untouched), 150 m at medium, 110 at low, 90 at potato. A 25 m tree — the
 * tallest archetype — at 150 m on a 720p frame with this camera's 66° vertical
 * fov is 25/150 × (720 / (2·tan 33°)) = 96 px tall, and the sprite has to cover
 * the whole bounding box, not just the tree, so 128 is very slightly generous
 * and 64 would be half the resolution the nearest impostor in the band wants.
 *
 * 64 VIEWS, NOT 256. The blend is barycentric over three neighbours, so what
 * the count buys is how far the silhouette has to be interpolated, not whether
 * it is. At 8 a side the grid step is about 16° of view direction; the trees
 * this is drawn for are 40-100 px tall and behind 85-99% fog. 16 a side is four
 * times the memory to interpolate 8° instead of 16° on a shape that is a
 * hundred pixels of haze.
 */
const TEXTURE_SIZE = 1024;
const SPRITES_PER_SIDE = 8;

/**
 * How much empty room is left around the tree inside each sprite.
 *
 * NOT COSMETIC — it is what makes the clamp in `sampleCell` safe. A ray-plane
 * intersection for a neighbouring cell routinely lands outside that cell's own
 * box, and the shader clamps the sprite-local uv into [0,1] rather than
 * branching. With no margin the clamp would smear the tree's edge texels
 * outward along the whole border of the sprite; with 8% of transparent frame,
 * the clamp lands in the frame and the sample is empty, which is the right
 * answer. The bake's orthographic half-extent is the bounding radius times
 * this, so the tree can never reach the frame.
 */
const SPRITE_MARGIN = 1.08;

/**
 * WHERE A BLENDED TEXEL BECOMES A PIXEL.
 *
 * Lower than the canopy's own 0.42 on purpose. The atlas is rendered into a
 * 4× multisampled target, so its alpha channel is COVERAGE — a resolved 0.4 at
 * the edge of a crown means 40% of that texel is leaf — and then three samples
 * of it are blended barycentrically, which lowers it again wherever the three
 * baked views disagree about the silhouette. Test at 0.42 and the outline of
 * every impostor is eaten by exactly the pixels the multisampling was for.
 *
 * IT IS STILL A `discard`, and that is worth being honest about given that the
 * canopy's discard is the thing this band exists to remove. The difference is
 * how much of the screen it covers: the leaf cards are 3.50 M triangles filling
 * the frame from a metre away, and these are two triangles per tree at 40-100
 * px on trees that are mostly behind other trees. The alternative — sorted
 * alpha blending — cannot be done at all with unsorted instances in one slab.
 */
const ALPHA_TEST = 0.3;

/**
 * A flat multiplier on the baked colour.
 *
 * The atlas is baked under a fixed hemisphere-plus-key rig and is never lit
 * again, so this is the one place the band's overall brightness could be matched
 * to the geometry it takes over from.
 *
 * IT IS 1.0 BECAUSE THE DIAL IS FLAT, WHICH IS A RESULT AND NOT A DEFAULT.
 * `impostor-ab.mjs --shade=0.8,0.9,1.0,1.12,1.25` sweeps it against a full-reach
 * reference at both above-canopy stations. Over that whole range — a 56% swing
 * in the band's brightness — the mean pixel difference at `above-flat` moves by
 * 0.01 of 255 at medium and by nothing at all at potato, and the differing-pixel
 * count moves by half a per cent of itself:
 *
 *     medium  0.42 0.42 0.42 0.42 0.42      potato  1.49 1.49 1.49 1.49 1.50
 *
 * The reason is the fog, and it is the same reason the band works. Everything in
 * it is past `leafReach`, where sober density has already taken 85% of a
 * surface's own colour and by 250 m has taken 99.5% — so what is on screen is
 * fogColor in the shape of a tree, and how bright the tree WAS does not survive
 * to the framebuffer. What is missing from a cut frame is the shape, not the
 * shade. Left as a uniform rather than deleted because it is the first thing
 * anyone will reach for if the band ever reads wrong, and it should be easy to
 * prove innocent a second time.
 */
const SHADE = 1.0;

/**
 * The hemi-octahedral fold, in JS, so the bake and the shader cannot disagree.
 *
 * `f` is a point of the unit square [-1,1]²; the return is the unit direction it
 * names, in the upper hemisphere. This is the exact inverse of the encode in
 * IMPOSTOR_FRAGMENT — encode does `f = vec2(o.x + o.z, o.z - o.x)` after
 * dividing by the L1 norm, so decode solves that pair back and reconstructs y
 * from `|x| + |y| + |z| = 1`.
 */
function octaDecode(fx, fy) {
  const x = (fx - fy) * 0.5;
  const z = (fx + fy) * 0.5;
  const y = 1 - Math.abs(x) - Math.abs(z);
  return new THREE.Vector3(x, y, z).normalize();
}

/**
 * The bake camera's basis for one view direction — and the shader's, again, so
 * that the two cannot drift.
 *
 * `Object3D.lookAt` with the default up gives a camera whose +Z is `d`, whose X
 * is `normalize(cross(up, d))` and whose Y is `cross(d, X)`. `sampleCell` in the
 * fragment shader builds exactly those two vectors to project a point into the
 * sprite. Get this wrong and the impostor is subtly sheared in a way that reads
 * as the tree wobbling as you walk past.
 *
 * The `abs(d.y) > 0.999` fallback is dead code at 8 sprites a side — the
 * closest a grid point comes to straight up is 9.6° — but it is in the shader
 * for a grid that is odd-numbered a side, and it is here so the two match.
 */
const _upRef = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
function viewBasis(d) {
  _upRef.set(0, 1, 0);
  if (Math.abs(d.y) > 0.999) _upRef.set(0, 0, 1);
  _right.crossVectors(_upRef, d).normalize();
  _up.crossVectors(d, _right);
  return { right: _right.clone(), up: _up.clone() };
}

/**
 * Bake one tree into one atlas.
 *
 * `parts` is a list of `{ geometry, material }` in the tree's own local frame —
 * for us, the near trunk and the canopy, with the same matrices they are
 * instanced with, which is why they line up. The materials are NOT the world's:
 * see `impostorBakeMaterials` in forest.js for why a fresh, plain pair is
 * cheaper AND more correct than the ones the wood is drawn with.
 *
 * @returns {{ texture: THREE.Texture, radius: number, centre: THREE.Vector3,
 *             bytes: number, ms: number }}
 */
export function bakeImpostor(renderer, parts, { seed = 0 } = {}) {
  const t0 = performance.now();

  /**
   * THREE RADII, NOT ONE, AND THE DIFFERENCE BETWEEN THEM IS HALF THE FILL.
   *
   * The SPRITE has to be square — the tree turns inside it as the view direction
   * moves around the hemisphere, so a rectangular sprite would clip in some
   * views and waste texels in others. So the sprite's half-extent is `radius`,
   * the true bounding-sphere radius, measured vertex by vertex from the box
   * centre rather than taken from `Box3.getBoundingSphere`, which returns the
   * radius through the box's CORNERS and is up to 73% too big on a shape this
   * elongated.
   *
   * THE QUAD DOES NOT HAVE TO BE SQUARE, and this band is fill-bound, so its
   * area is worth an argument. `impostor-cost.mjs` put the band at a few tenths
   * of a millisecond at the eye-level stations while REMOVING triangles, and at
   * 0.00 above the canopy — the shape of a result that is overdraw. At eye level
   * every quad is behind the wood and contributes nothing, so anything that is
   * guaranteed-empty is a fragment rasterised for no reason.
   *
   * HOW MUCH IT ACTUALLY BUYS HERE: 9%, and that is a fact about rainforest
   * trees rather than about the technique. `impostorStats().quadFill` measures
   * the tight quad at 91% of the square one across the fifteen archetypes,
   * because a kapok or a cecropia has a crown nearly as wide as the tree is
   * tall. On a temperate roster of spires it would be worth two or three times
   * more. Kept because it is exact and costs one uniform.
   *
   * A view-aligned quad's X axis is the camera's right, and this camera's right
   * is horizontal to within `MAX_ROLL` = 0.07 rad (director.js) — so the quad's
   * half-width only has to hold the tree's horizontal radius plus what the roll
   * tips into it. Its half-height has to hold `radius`, because looking straight
   * down turns the screen's up axis into a horizontal one and the worst case
   * over all elevations is `sqrt(vert² + horiz²)`, which is the sphere again.
   *
   * `horizontal` is measured as the max of `hypot(dx, dz)` over the vertices and
   * not from the AABB, because every instance carries a random yaw and an AABB
   * half-extent is only rotation-proof after being multiplied by root two.
   */
  const box = new THREE.Box3();
  for (const p of parts) {
    p.geometry.computeBoundingBox();
    box.union(p.geometry.boundingBox);
  }
  const centre = box.getCenter(new THREE.Vector3());
  let r2 = 0;
  let h2 = 0;
  let vert = 0;
  for (const p of parts) {
    const pos = p.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) - centre.x;
      const dy = pos.getY(i) - centre.y;
      const dz = pos.getZ(i) - centre.z;
      const flat = dx * dx + dz * dz;
      if (flat > h2) h2 = flat;
      if (flat + dy * dy > r2) r2 = flat + dy * dy;
      if (Math.abs(dy) > vert) vert = Math.abs(dy);
    }
  }
  const radius = Math.sqrt(r2);
  const horizontal = Math.sqrt(h2);
  /**
   * The quad, in units of `radius`, with the roll allowance and 4% of slack.
   *
   * The slack is for the multisampled edge of the atlas: the silhouette in the
   * sprite is a texel or two wider than the geometry that made it, and a quad
   * cut exactly to the geometry would shave that edge off.
   */
  const MAX_ROLL = 0.07;
  const halfX = (horizontal * Math.cos(MAX_ROLL) + radius * Math.sin(MAX_ROLL)) * 1.04;
  const halfY = radius * 1.04;
  const half = new THREE.Vector2(halfX, halfY);

  const scene = new THREE.Scene();
  /**
   * A FIXED RIG, because the impostor is baked once and the sun is not fixed.
   *
   * The day cycle moves the key light through 180° and this band cannot follow
   * it — re-baking 5 atlases on every sun step is not a thing that can happen in
   * a frame. What saves it is the range: the nearest impostor in the band is at
   * `leafReach`, where sober fog has already taken 85% of its colour, and by
   * 250 m it has taken 99.5%. So the choice is not "which light is right" but
   * "which light is closest to the average", and a hemisphere fill with a weak,
   * high key is the average of a day.
   *
   * The colours are the sober sky and ground the atmosphere settles at; they
   * are duplicated rather than imported because atmosphere.js rebuilds them
   * every frame from the director and there is nothing stable to import.
   */
  const hemi = new THREE.HemisphereLight(0xbcd3e0, 0x4a4433, 2.1);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff2dc, 1.35);
  key.position.set(0.45, 1.0, 0.3);
  scene.add(key);

  /**
   * SIXTY-FOUR COPIES OF THE TREE IN A GRID, NOT SIXTY-FOUR CAMERA POSITIONS.
   *
   * The obvious bake is a loop: move an orthographic camera to each view
   * direction, scissor a sprite-sized viewport, render. That is what this did
   * first and it cost 47 ms an archetype, 700 ms for the wood — and the cost is
   * not the tree. The target is 4x multisampled, and three RESOLVES the whole
   * multisample buffer at the end of every `render()` call, so the loop was 64
   * full-atlas 1024² MSAA resolves per archetype and 960 for the session. It
   * showed up as fifteen 47 ms frames at load, which is enough to push the
   * streamer's first fill past `check:potato`'s 400 ms settle and make that test
   * report a half-arrived world.
   *
   * Rotating the OBJECT is exactly equivalent to rotating the camera and needs
   * only one render, so there is one resolve. For a view direction `d` with the
   * bake basis `(right, up)`, the transform that puts the tree in front of a
   * fixed camera looking down -Z is the matrix whose ROWS are `right`, `up`, `d`
   * — it sends a point `p` to `(dot(p,right), dot(p,up), dot(p,d))`, which is
   * the sprite's own coordinate with depth increasing toward the camera. Drop
   * that into cell (i, j) of a grid and one orthographic camera covering the
   * whole grid draws the entire atlas.
   *
   * The sprites cannot bleed into each other because each cell is its own
   * disjoint box in the camera's XY and the tree is inside its own box by
   * `SPRITE_MARGIN` — the same margin the shader's clamp relies on.
   */
  const E = radius * SPRITE_MARGIN;
  const last = SPRITES_PER_SIDE - 1;
  const meshes = [];
  const _m = new THREE.Matrix4();
  for (let j = 0; j < SPRITES_PER_SIDE; j++) {
    for (let i = 0; i < SPRITES_PER_SIDE; i++) {
      const d = octaDecode((i / last) * 2 - 1, (j / last) * 2 - 1);
      const { right, up } = viewBasis(d);
      // Rows are the basis, so this is the transpose of the camera's rotation —
      // which is what "look at the tree from `d`" means for the tree.
      _m.set(
        right.x, right.y, right.z, 0,
        up.x, up.y, up.z, 0,
        d.x, d.y, d.z, 0,
        0, 0, 0, 1
      );
      const view = new THREE.Group();
      view.matrixAutoUpdate = false;
      view.matrix
        .makeTranslation((i * 2 + 1) * E, (j * 2 + 1) * E, 0)
        .multiply(_m)
        .multiply(new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z));
      view.matrixWorldNeedsUpdate = true;
      for (const p of parts) {
        const m = new THREE.Mesh(p.geometry, p.material);
        m.frustumCulled = false;
        view.add(m);
        meshes.push(m);
      }
      scene.add(view);
    }
  }

  /**
   * `samples: 4`, and it is the difference between an impostor and a stencil.
   *
   * Everything in `parts` is alpha-tested, so without multisampling every texel
   * of this atlas is alpha 0 or alpha 255 and the crown's outline is a hard
   * staircase which the barycentric blend then smears into three staircases. At
   * 4 samples the resolved alpha is COVERAGE, the outline has real partial
   * texels in it, and the three-way blend has something continuous to
   * interpolate. It costs nothing at draw time — the target is resolved once,
   * at bake, and never bound again.
   */
  const rt = new THREE.WebGLRenderTarget(TEXTURE_SIZE, TEXTURE_SIZE, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 4,
  });
  rt.texture.name = `impostor-${seed}`;
  /**
   * NO MIPMAPS, and this is a trade rather than an oversight.
   *
   * A mip chain over an 8×8 atlas bleeds across sprite boundaries from level 4
   * down — 8 px sprites at level 4 — and the bleed is a neighbouring view of the
   * same tree, so it arrives as a halo that grows as the tree recedes. The
   * alternative is minification aliasing, and the range says which is worse: the
   * sprite is 128 px and the tree is 96 px on screen at the near end of the
   * band, so the minification ratio over the useful part of the band is 1.3-3×,
   * and the frame is already 2× multisampled. It also saves a third of the VRAM.
   */
  rt.texture.generateMipmaps = false;

  /**
   * One camera over the whole grid, looking down -Z from beyond the deepest
   * tree. `near` is negative rather than a positive plane in front of the eye,
   * because the transform above leaves half of every tree BEHIND the grid plane
   * and an orthographic near plane is allowed to sit behind the camera.
   */
  const span = SPRITES_PER_SIDE * 2 * E;
  const cam = new THREE.OrthographicCamera(0, span, span, 0, -radius * 4, radius * 4);
  cam.position.set(0, 0, 0);
  cam.updateMatrixWorld(true);

  const prevTarget = renderer.getRenderTarget();
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  const prevAutoClear = renderer.autoClear;
  const prevShadow = renderer.shadowMap.enabled;

  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = true;
  /**
   * Shadows off for the duration, and not only because impostors do not cast.
   *
   * With the shadow map enabled the renderer walks the shadow-casting objects
   * of every scene it is handed, and `renderer.shadowMap.needsUpdate` bookkeeping
   * from a foreign scene is a well-known way to spend a frame re-rendering the
   * world's real shadow map 320 times. There is nothing in the bake scene that
   * casts and nothing that receives.
   */
  renderer.shadowMap.enabled = false;

  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);

  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.autoClear = prevAutoClear;
  renderer.shadowMap.enabled = prevShadow;

  // The scene goes; the GEOMETRIES stay, because those are `arch.grown.trunk`
  // and `arch.grown.leaf`, the live buffers the whole wood is instanced from.
  // Nothing here is disposed for the same reason — see `pumpImpostors`, which
  // disposes the two throwaway bake materials and nothing else.
  scene.clear();
  hemi.dispose();
  key.dispose();

  return {
    texture: rt.texture,
    target: rt,
    radius,
    half,
    centre,
    // For the report: how much of a square quad the tight one is.
    fill: (halfX * halfY) / (radius * radius),
    // RGBA8, no mip chain. The multisampled attachment is transient — three
    // resolves it into the texture and the renderbuffer is not part of the
    // steady-state footprint, so this is what the atlas costs once baked.
    bytes: TEXTURE_SIZE * TEXTURE_SIZE * 4,
    ms: performance.now() - t0,
  };
}

/**
 * THE VERTEX SHADER: a view-aligned quad, and the two vectors the fragment
 * shader needs expressed in the tree's own frame.
 *
 * VIEW-ALIGNED AND NOT Y-LOCKED. A Y-locked billboard (world up, right =
 * cross(up, toCamera)) keeps trees vertical and is what a single-sprite
 * billboard has to do, but it degenerates to a zero-area quad when you look
 * straight down at it — and looking down at the wood from above is the entire
 * station this band was built for. A view-aligned quad never degenerates, and
 * the octahedral lookup does not care how the quad is oriented: the sprite is
 * chosen from the direction to the eye in the tree's frame, which is
 * independent of the billboard's own basis.
 *
 * THE INSTANCE'S YAW IS WHY EVERYTHING IS DONE IN LOCAL SPACE. Every tree in
 * the wood is placed with a random Y rotation (`yawMatrix` in scatter.js,
 * uniform scale). Rotating the eye direction into the instance's frame before
 * the octahedral encode is what makes that yaw show a DIFFERENT sprite — which
 * is where the variety in this band comes from, and why the three archetypes of
 * a species do not read as three copies of one tree.
 *
 * THE WHOLE OCTAHEDRAL LOOKUP HAPPENS HERE, FOUR TIMES A TREE, NOT ONCE A
 * FRAGMENT. It was in the fragment shader first, and moving it roughly halved
 * the band's cost at the eye-level stations — where the band moves 0.02% of the
 * pixels and every fragment of it is behind a tree. (The absolute before-figure
 * this block used to quote was taken on a contended GPU; the honest costs are
 * in the `IMPOSTOR_REACH` block in forest.js, measured against a noise control.)
 * Two things make the move exact rather than approximate:
 *
 *   - THE CELL CHOICE USES THE DIRECTION TO THE QUAD'S CENTRE, so all four
 *     vertices agree and the varying interpolates a constant. The direction to
 *     the eye varies by about 3° across a 26 m quad at 250 m against a grid step
 *     of 16°, so per-fragment selection was buying a hundredth of a cell.
 *   - THE SPRITE COORDINATE IS A HOMOGRAPHY OF THE QUAD, and perspective-correct
 *     varying interpolation reproduces a homography exactly. Computing the
 *     ray-plane intersection at the four corners and letting the rasteriser
 *     interpolate is not an approximation of the per-fragment version; it is the
 *     same function, evaluated four times instead of ten thousand.
 *
 * `transpose()` is spelled out as three dot products because it is GLSL ES 3.00
 * only, and this project has no guarantee about which version three compiles to.
 */
const IMPOSTOR_VERTEX = /* glsl */ `
	mat4 rrModel = modelMatrix * instanceMatrix;
	vec3 rrScale = vec3(length(rrModel[0].xyz), length(rrModel[1].xyz), length(rrModel[2].xyz));
	vec3 rrAxisX = rrModel[0].xyz / rrScale.x;
	vec3 rrAxisY = rrModel[1].xyz / rrScale.y;
	vec3 rrAxisZ = rrModel[2].xyz / rrScale.z;
	vec3 rrCentre = (rrModel * vec4(uImpostorCentre, 1.0)).xyz;
	float rrRadius = uImpostorRadius * rrScale.x;

	vec3 rrRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
	vec3 rrUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
	vec3 rrOffset =
		(rrRight * (position.x * uImpostorHalf.x) + rrUp * (position.y * uImpostorHalf.y)) *
		rrScale.x;

	vec4 mvPosition = viewMatrix * vec4(rrCentre + rrOffset, 1.0);
	gl_Position = projectionMatrix * mvPosition;

	// Both in the tree's own frame and in units of the bounding radius, which is
	// the frame the atlas was baked in.
	vec3 rrEyeWorld = cameraPosition - rrCentre;
	vec3 rrPos =
		vec3(dot(rrOffset, rrAxisX), dot(rrOffset, rrAxisY), dot(rrOffset, rrAxisZ)) / rrRadius;
	vec3 rrEyeL =
		vec3(dot(rrEyeWorld, rrAxisX), dot(rrEyeWorld, rrAxisY), dot(rrEyeWorld, rrAxisZ)) / rrRadius;

	// Folded into the upper hemisphere. Nothing in this world looks at a tree
	// from below the ground plane, and the 0.001 keeps the L1 normalise from
	// dividing by a direction sitting exactly on the equator.
	vec3 rrDir = normalize(rrEyeL);
	rrDir.y = max(rrDir.y, 0.001);
	rrDir = normalize(rrDir);

	vec3 rrOct = rrDir / (abs(rrDir.x) + abs(rrDir.y) + abs(rrDir.z));
	vec2 rrF = vec2(rrOct.x + rrOct.z, rrOct.z - rrOct.x);

	float rrLast = uImpostorGrid - 1.0;
	vec2 rrG = (rrF * 0.5 + 0.5) * rrLast;
	vec2 rrBase = clamp(floor(rrG), vec2(0.0), vec2(rrLast - 1.0));
	vec2 rrFrac = rrG - rrBase;

	// Which half of the cell the direction fell in decides which three of the
	// four corners are blended. Splitting the square into two triangles is what
	// makes the weights barycentric, and therefore what makes them sum to one
	// across the seam between the two halves.
	if (rrFrac.x + rrFrac.y > 1.0) {
		vImpostorC0 = rrBase + vec2(1.0, 1.0);
		vImpostorC1 = rrBase + vec2(1.0, 0.0);
		vImpostorC2 = rrBase + vec2(0.0, 1.0);
		vImpostorW = vec3(rrFrac.x + rrFrac.y - 1.0, 1.0 - rrFrac.y, 1.0 - rrFrac.x);
	} else {
		vImpostorC0 = rrBase;
		vImpostorC1 = rrBase + vec2(1.0, 0.0);
		vImpostorC2 = rrBase + vec2(0.0, 1.0);
		vImpostorW = vec3(1.0 - rrFrac.x - rrFrac.y, rrFrac.x, rrFrac.y);
	}

	vImpostorUv0 = rrImpostorProject(vImpostorC0, rrLast, rrEyeL, rrPos);
	vImpostorUv1 = rrImpostorProject(vImpostorC1, rrLast, rrEyeL, rrPos);
	vImpostorUv2 = rrImpostorProject(vImpostorC2, rrLast, rrEyeL, rrPos);
`;

/**
 * WHERE DOES THE RAY THROUGH THIS CORNER CROSS THAT SPRITE'S PLANE.
 *
 * Sampling all three cells at the same quad-local coordinate would blend three
 * views that each think the crown is somewhere else, and the result is a triple
 * exposure. Each baked sprite is an orthographic projection onto a plane through
 * the tree's centre with normal `d`, so the honest question is where the eye ray
 * meets THAT plane — one dot product and one divide, and it turns the triple
 * exposure into parallax. This is the part that makes it an impostor rather than
 * a billboard.
 *
 * The basis must match `viewBasis` in JS exactly, because that is the basis the
 * bake camera used. A mismatch shears every sprite, which reads as the tree
 * wobbling as you walk past rather than as anything obviously wrong.
 */
const IMPOSTOR_PROJECT = /* glsl */ `
	vec2 rrImpostorProject(vec2 cellIndex, float last, vec3 ro, vec3 target) {
		vec2 f = cellIndex / last * 2.0 - 1.0;
		vec3 d;
		d.x = (f.x - f.y) * 0.5;
		d.z = (f.x + f.y) * 0.5;
		d.y = 1.0 - abs(d.x) - abs(d.z);
		d = normalize(d);

		vec3 upRef = abs(d.y) > 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
		vec3 right = normalize(cross(upRef, d));
		vec3 up = cross(d, right);

		vec3 rd = normalize(target - ro);
		// The eye is on the +d side of the plane by construction, so the ray runs
		// into it and this is negative. Clamped away from zero because a grazing
		// cell at the edge of the barycentric triangle would otherwise send the
		// hit point to infinity and NaN the whole blend.
		float denom = min(dot(rd, d), -1e-3);
		vec3 hit = ro + rd * (-dot(ro, d) / denom);
		return vec2(dot(hit, right), dot(hit, up)) * (0.5 / uImpostorExtent) + 0.5;
	}
`;

/**
 * THE FRAGMENT SHADER: three clamped fetches and a coverage-weighted blend, and
 * nothing else.
 *
 * PREMULTIPLIED, and it has to be. Blending three RGBA samples channel by
 * channel mixes the colour of a texel that is 3% covered into the result at the
 * same weight as one that is fully covered, which puts a bright halo of the
 * sprite's background around every crown — the classic impostor fringe. Summing
 * `rgb * a` and dividing by the summed `a` is a coverage-weighted average of
 * the colours that are actually there.
 *
 * THE CLAMP IS WHY THE SPRITE HAS A MARGIN. A ray-plane intersection for a
 * neighbouring cell routinely lands outside that cell's own box; clamping into
 * the transparent frame `SPRITE_MARGIN` leaves around the tree gives an empty
 * sample, which is the right answer, and costs no branch.
 *
 * NOTE FOR ANYONE EDITING THIS: run `node scripts/glsl-backticks.mjs`
 * afterwards. A backtick anywhere in here, comment included, terminates the
 * template literal and the app stops booting with an error naming an unrelated
 * identifier in another file.
 */
const IMPOSTOR_FRAGMENT = /* glsl */ `
	vec4 rrS0 = rrImpostorFetch(vImpostorC0, vImpostorUv0);
	vec4 rrS1 = rrImpostorFetch(vImpostorC1, vImpostorUv1);
	vec4 rrS2 = rrImpostorFetch(vImpostorC2, vImpostorUv2);

	vec3 rrWa = vec3(rrS0.a, rrS1.a, rrS2.a) * vImpostorW;
	float rrA = rrWa.x + rrWa.y + rrWa.z;
	vec3 rrRgb = rrS0.rgb * rrWa.x + rrS1.rgb * rrWa.y + rrS2.rgb * rrWa.z;
	rrRgb /= max(rrA, 1e-4);

	diffuseColor *= vec4(rrRgb * uImpostorShade, rrA);
`;

/** What both stages have to agree about, declared into both. */
const IMPOSTOR_HELPERS = /* glsl */ `
	uniform float uImpostorGrid;
	uniform float uImpostorExtent;
	varying vec2 vImpostorC0;
	varying vec2 vImpostorC1;
	varying vec2 vImpostorC2;
	varying vec2 vImpostorUv0;
	varying vec2 vImpostorUv1;
	varying vec2 vImpostorUv2;
	varying vec3 vImpostorW;
`;

/** The fragment stage's own half: the atlas, and how to read one cell of it. */
const IMPOSTOR_FETCH = /* glsl */ `
	uniform sampler2D uImpostorAtlas;
	uniform float uImpostorInset;
	uniform float uImpostorShade;

	vec4 rrImpostorFetch(vec2 cellIndex, vec2 uv) {
		return texture2D(
			uImpostorAtlas,
			(cellIndex + clamp(uv, uImpostorInset, 1.0 - uImpostorInset)) / uImpostorGrid
		);
	}
`;

/**
 * The material for one impostor layer.
 *
 * `MeshBasicMaterial` and not Lambert, because the atlas already has the light
 * in it — see the rig in `bakeImpostor`. What Basic still brings, and what
 * writing a `ShaderMaterial` would have thrown away, is three's own fog chunk
 * (this band lives or dies by the fog), the `USE_INSTANCING_COLOR` path (the
 * per-instance trunk tint, which arrives free through `mirrorOf`), the alpha
 * test uniform, and whatever the renderer decides about output colour space.
 *
 * `map` is deliberately NOT set. Setting it would make three emit a uv
 * attribute, a uv varying and a uv transform matrix for a coordinate this
 * shader never uses, on a mesh whose whole point is that it is four vertices.
 * The atlas arrives as an ordinary uniform instead and `map_fragment` — which
 * is in the source whether or not USE_MAP is defined, because onBeforeCompile
 * runs before the includes are resolved — is where it is read.
 */
export function impostorMaterial(atlas, baked) {
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    alphaTest: ALPHA_TEST,
    transparent: false,
    side: THREE.FrontSide,
    fog: true,
  });
  material.name = 'impostor';
  const uniforms = {
    uImpostorAtlas: { value: atlas },
    uImpostorGrid: { value: SPRITES_PER_SIDE },
    uImpostorExtent: { value: SPRITE_MARGIN },
    uImpostorInset: { value: (0.5 * SPRITES_PER_SIDE) / TEXTURE_SIZE },
    uImpostorShade: { value: SHADE },
    uImpostorRadius: { value: baked.radius },
    uImpostorHalf: { value: baked.half.clone() },
    uImpostorCentre: { value: baked.centre.clone() },
  };
  material.userData.impostor = uniforms;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform float uImpostorRadius;',
          'uniform vec2 uImpostorHalf;',
          'uniform vec3 uImpostorCentre;',
          IMPOSTOR_HELPERS,
          IMPOSTOR_PROJECT,
        ].join('\n')
      )
      // Replaces the chunk outright: three's version applies instanceMatrix and
      // modelViewMatrix to `transformed`, which for this geometry is a corner of
      // a unit plane and means nothing. `mvPosition` is redeclared because
      // `fog_vertex` downstream reads it.
      .replace('#include <project_vertex>', IMPOSTOR_VERTEX);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        ['#include <common>', IMPOSTOR_HELPERS, IMPOSTOR_FETCH].join('\n')
      )
      .replace('#include <map_fragment>', IMPOSTOR_FRAGMENT);
  };
  /**
   * DELIBERATELY NO `customProgramCacheKey`, so all fifteen layers share ONE
   * program.
   *
   * Three keys the program cache on `onBeforeCompile.toString()` among other
   * things, and this function is the same source for every archetype — so the
   * fifteen materials compile once between them and differ only in their
   * uniform values, which three re-uploads whenever the bound material changes.
   * Giving each one a distinct key would be fifteen identical programs, and this
   * repo has a recorded incident about a quality change that rebuilt 22 shaders
   * and read to the player as the game freezing.
   *
   * The consequence to know about: at `high` and `ultra` the impostor band is
   * empty, nothing in it ever draws, and so that one program is not compiled
   * until somebody moves the tree-distance knob down. That is one compile, on
   * one knob, and the alternative — warming it behind the gate — needs a fake
   * InstancedMesh carrying the scene's fog and shadow defines, which is more
   * machinery than a single program is worth.
   */
  return material;
}

/** The geometry every impostor layer shares: four vertices, two triangles. */
export function impostorGeometry() {
  const geo = new THREE.PlaneGeometry(2, 2);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  /**
   * A bounding sphere the culler will not shrink to nothing.
   *
   * `packSlab` does not use this — the bucket spheres come from the worker — but
   * `InstancedMesh.raycast` and any future frustum test would, and a plane's
   * own sphere describes a 2 m disc rather than the tree the shader draws.
   */
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
  return geo;
}

export const IMPOSTOR_ATLAS_BYTES = TEXTURE_SIZE * TEXTURE_SIZE * 4;
export const IMPOSTOR_TEXTURE_SIZE = TEXTURE_SIZE;
export const IMPOSTOR_SPRITES_PER_SIDE = SPRITES_PER_SIDE;
export const IMPOSTOR_SPRITE_MARGIN = SPRITE_MARGIN;
