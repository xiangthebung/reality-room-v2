import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TAU } from '../../core/util.js';

/**
 * The bodies.
 *
 * Every animal in this file is a handful of swept tubes and squashed spheres,
 * and that is not a compromise — at the distance you actually see a deer in this
 * wood, a silhouette with the right proportions and the right *gait* is
 * indistinguishable from a modelled one, and the gait is where all the work
 * should go. A beautifully modelled deer that slides along the ground is a prop;
 * a nine-hundred-triangle one whose legs swing about its shoulders is an animal.
 *
 * THE RIG IS FOUR FLOATS PER VERTEX, and everything moves in the vertex shader.
 *
 *   aRig.x  legDrop  — metres this vertex sits BELOW its own hip joint.
 *   aRig.y  legSign  — -1 or +1, the diagonal pair this leg belongs to. 0 = body.
 *   aRig.z  headW    — 0 at the neck's root, 1 at the nose.
 *   aRig.w  trimW    — the one "wobble" channel: antlers, ears or tail plume.
 *
 * WHY legDrop IS METRES AND NOT A 0..1 PARAMETER. A leg swinging about its hip
 * is a rotation in the YZ plane about a pivot, and a rotation needs to know how
 * far the point is from the pivot. Storing the distance directly means the
 * shader can do the rotation without ever being told where the pivot IS — which
 * matters, because the four hips are at four different heights and there is only
 * one attribute. `z += sin(a)*d; y += (1-cos(a))*d` is the exact rotation, so the
 * leg keeps its length instead of stretching, which is the difference between a
 * stride and a rubber band.
 *
 * ONE CHANNEL FOR TRIM, THREE MEANINGS. A deer's antlers, a rabbit's ears and a
 * squirrel's tail are all "the bit that flicks", and they are never on the same
 * animal, so they share `aRig.w` and the per-species amplitude uniform decides
 * what the same angular wobble reads as. A rabbit's ears are small, so it is a
 * twitch; a squirrel's tail is half the animal, so it is a plume flick.
 *
 * THE PAIR (headW, trimW) IS ALSO WHAT IDENTIFIES AN ANTLER, and that is worth
 * knowing before anything here is re-rigged. On a deer the two channels are
 * disjoint everywhere except the antler beam — the ears are head-only and the
 * tail is trim-only — so `aRig.z > 0.5 && aRig.w > 0` picks the rack and
 * nothing else, which is how shading.js folds a doe's antlers into her skull
 * without a second geometry. A rabbit's ears are head AND trim, so that test is
 * wrong for a rabbit and the shader gates it on a per-species uniform; see
 * `uHorn`. Moving a deer's ears onto the trim channel would silently give every
 * doe in the wood a pair of stumps where her ears should be.
 *
 * There are no UVs anywhere here. Nothing in this file is textured — the coat
 * comes out of the fragment shader as a function of the body's own local
 * coordinates (see shading.js), the same way the bark and the forest floor do.
 * Adding a `uv` attribute would also break the merge, because mergeGeometries
 * requires every part to carry exactly the same set.
 */

/** The attribute set every part must carry, so the parts can be merged. */
const RIG_ZERO = [0, 0, 0, 0];

/**
 * A tapered tube along a polyline.
 *
 * Normals are the analytic radial direction rather than `computeVertexNormals`,
 * which matters at these vertex counts: an averaged normal at the end cap of a
 * five-sided leg points somewhere nobody chose, and a leg lit by a normal that
 * disagrees with its own surface flickers as the animal turns.
 */
function tube(path, radial = 7) {
  const rings = path.length;
  const count = rings * radial;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const rig = new Float32Array(count * 4);
  const index = [];

  const dir = new THREE.Vector3();
  const up = new THREE.Vector3();
  const side = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  for (let i = 0; i < rings; i++) {
    const a = path[Math.max(0, i - 1)].p;
    const b = path[Math.min(rings - 1, i + 1)].p;
    dir.copy(b).sub(a);
    if (dir.lengthSq() < 1e-10) dir.set(0, 1, 0);
    dir.normalize();
    // Any up will do as long as it is not parallel to the run of the tube; a
    // leg is nearly vertical, so the usual +Y choice degenerates on exactly the
    // part that has the most of them.
    up.set(0, 1, 0);
    if (Math.abs(dir.y) > 0.94) up.set(1, 0, 0);
    side.crossVectors(dir, up).normalize();
    up.crossVectors(side, dir).normalize();

    for (let j = 0; j < radial; j++) {
      const t = (j / radial) * TAU;
      nrm.copy(side).multiplyScalar(Math.cos(t)).addScaledVector(up, Math.sin(t));
      const k = i * radial + j;
      position[k * 3] = path[i].p.x + nrm.x * path[i].r;
      position[k * 3 + 1] = path[i].p.y + nrm.y * path[i].r;
      position[k * 3 + 2] = path[i].p.z + nrm.z * path[i].r;
      normal[k * 3] = nrm.x;
      normal[k * 3 + 1] = nrm.y;
      normal[k * 3 + 2] = nrm.z;
      rig.set(path[i].rig ?? RIG_ZERO, k * 4);
    }
  }

  // (a, c, b) rather than (a, b, c): the frame (side, up, dir) is left-handed,
  // so the naive winding faces inward and every animal renders inside out.
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      index.push(a, a + radial, b, b, a + radial, b + radial);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('aRig', new THREE.BufferAttribute(rig, 4));
  geo.setIndex(index);
  return geo;
}

/** A squashed sphere at a point. Heads, rumps, tail bobs. */
function blob(radii, at, rig = RIG_ZERO, seg = 8, ring = 5) {
  const geo = new THREE.SphereGeometry(1, seg, ring);
  geo.deleteAttribute('uv');
  geo.scale(radii[0], radii[1], radii[2]);
  geo.translate(at[0], at[1], at[2]);
  // Indexed, so this smooths across the whole ball rather than faceting it —
  // and it is needed at all because a non-uniform scale does not carry normals.
  geo.computeVertexNormals();
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) arr.set(rig, i * 4);
  geo.setAttribute('aRig', new THREE.BufferAttribute(arr, 4));
  return geo;
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/**
 * Four legs, laid out on a body.
 *
 * `pairs` is [[z, hipY], …] — the fore and hind attachment points. The diagonal
 * sign alternates across the pair, which is what makes it a walk: a quadruped
 * moves diagonal limbs together, and getting that wrong produces a rocking-horse
 * that nobody can name as wrong but everybody can see.
 */
function legs(pairs, spread, foot, thickness) {
  const parts = [];
  for (const [pz, hipY, sign] of pairs) {
    for (const sx of [-1, 1]) {
      // Legs are not vertical. A hind leg angles back and a fore leg forward,
      // which is most of what stops a quadruped reading as a table.
      const knee = V(sx * spread * 0.94, hipY * 0.52, pz + foot * 0.35);
      const hoof = V(sx * spread * 0.86, 0.02, pz + foot);
      const hip = V(sx * spread, hipY, pz);
      const s = sign * sx;
      parts.push(
        tube(
          [
            { p: hip, r: thickness * 1.25, rig: [0, s, 0, 0] },
            { p: knee, r: thickness * 0.72, rig: [hipY - knee.y, s, 0, 0] },
            {
              p: hoof,
              r: thickness * 0.42,
              rig: [hipY - hoof.y, s, 0, 0],
            },
          ],
          5
        )
      );
    }
  }
  return parts;
}

/**
 * A deer.
 *
 * Shoulder height ~1.3 m, which is a red deer rather than a roe — the bigger
 * animal is the one worth glimpsing, and at forty metres through trunks the
 * smaller one is a brown smudge.
 *
 * The antlers are on the SAME geometry as the does, collapsed to a point by a
 * per-instance scale. Two archetypes would be two draw calls for a difference
 * that is one attribute wide.
 */
export function deerGeometry() {
  const parts = [];
  /**
   * `backY` is the SPINE, not the withers, and the first version got that
   * wrong: at 1.3 the barrel's underside sat at 0.97 m with 1.16 m of leg below
   * it, which is not a deer, it is a deer on stilts. A red deer stands about
   * 1.35 m at the shoulder with a 0.5 m deep chest, so the belly is at 0.75 and
   * the leg is 0.9 — the animal is mostly body, and the leg is shorter than the
   * body is long. Getting that ratio wrong is what makes a quadruped read as a
   * table with a head on it.
   */
  const backY = 1.06;
  // The barrel: deepest at the chest, tapering both ways. A cylinder of one
  // radius is a barrel; a taper is an animal.
  parts.push(
    tube(
      [
        { p: V(0, backY - 0.05, -0.92), r: 0.19 },
        { p: V(0, backY + 0.01, -0.55), r: 0.3 },
        { p: V(0, backY + 0.02, -0.05), r: 0.31 },
        { p: V(0, backY, 0.45), r: 0.33 },
        { p: V(0, backY - 0.07, 0.86), r: 0.21 },
      ],
      9
    )
  );
  // Neck and head. headW ramps from 0 at the withers to 1 at the muzzle, so the
  // whole neck bends into the look instead of the head swivelling on a stick.
  const neckBase = V(0, backY + 0.04, 0.82);
  parts.push(
    tube(
      [
        { p: neckBase, r: 0.16, rig: [0, 0, 0, 0] },
        { p: V(0, backY + 0.38, 1.02), r: 0.125, rig: [0, 0, 0.42, 0] },
        { p: V(0, backY + 0.62, 1.15), r: 0.1, rig: [0, 0, 0.8, 0] },
        { p: V(0, backY + 0.74, 1.24), r: 0.085, rig: [0, 0, 1, 0] },
      ],
      7
    )
  );
  parts.push(blob([0.1, 0.115, 0.19], [0, backY + 0.76, 1.36], [0, 0, 1, 0], 8, 5));
  parts.push(blob([0.055, 0.062, 0.09], [0, backY + 0.69, 1.55], [0, 0, 1, 0], 7, 4));
  // Ears, on the head channel rather than the trim channel — the trim channel
  // is spoken for by the antlers, and a deer's ears mostly go with its head.
  for (const sx of [-1, 1]) {
    parts.push(
      tube(
        [
          { p: V(sx * 0.07, backY + 0.84, 1.34), r: 0.03, rig: [0, 0, 1, 0] },
          { p: V(sx * 0.17, backY + 0.96, 1.29), r: 0.045, rig: [0, 0, 1, 0] },
          { p: V(sx * 0.22, backY + 1.04, 1.25), r: 0.012, rig: [0, 0, 1, 0] },
        ],
        5
      )
    );
  }
  /**
   * Antlers: a beam with two tines, mirrored. They ride the head channel AND
   * the trim channel — the head so they turn when he looks at you, the trim so a
   * doe's copy of this geometry can pull them into the skull and vanish them.
   *
   * That last clause was aspirational for a long time. The shader read `aTone.x`
   * as an amplitude on the antler WOBBLE and never as a scale on the antler, so
   * every deer in this wood wore a full rack and the only difference between a
   * stag and a doe was whether it twitched. It is real now — `uHorn` in
   * shading.js is the point inside the skull the beam collapses to — and
   * because a collapse to a point is just a mix, the same twenty vertices also
   * give a young stag a small rack and an old one a heavy one.
   */
  for (const sx of [-1, 1]) {
    parts.push(
      tube(
        [
          { p: V(sx * 0.06, backY + 0.86, 1.3), r: 0.028, rig: [0, 0, 1, 1] },
          { p: V(sx * 0.17, backY + 1.08, 1.24), r: 0.023, rig: [0, 0, 1, 1] },
          { p: V(sx * 0.27, backY + 1.32, 1.12), r: 0.018, rig: [0, 0, 1, 1] },
          { p: V(sx * 0.31, backY + 1.52, 0.96), r: 0.009, rig: [0, 0, 1, 1] },
        ],
        5
      )
    );
    for (const [t, ty, tz, len] of [
      [0.23, 1.14, 1.16, 0.2],
      [0.31, 1.36, 1.04, 0.25],
    ]) {
      parts.push(
        tube(
          [
            { p: V(sx * t, backY + ty, tz), r: 0.014, rig: [0, 0, 1, 1] },
            { p: V(sx * (t + 0.06), backY + ty + len, tz + 0.05), r: 0.006, rig: [0, 0, 1, 1] },
          ],
          4
        )
      );
    }
  }
  // A short raised tail. The white flash of a fleeing deer is the whole point of
  // it, and the coat shader keys the flash off this being at the back and low.
  parts.push(
    tube(
      [
        { p: V(0, backY + 0.03, -0.93), r: 0.055, rig: [0, 0, 0, 0.4] },
        { p: V(0, backY + 0.06, -1.1), r: 0.035, rig: [0, 0, 0, 1] },
      ],
      5
    )
  );
  // Wider apart and thicker than they look right on paper: at fifteen metres a
  // 6 cm leg is under a pixel and the animal appears to float.
  parts.push(...legs([[0.5, 0.94, 1], [-0.54, 0.92, -1]], 0.25, -0.04, 0.072));

  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  geo.computeBoundingSphere();
  return { geometry: geo, neck: neckBase.clone(), height: 1.4 };
}

/** A rabbit. Ears on the trim channel: they are the thing that twitches. */
export function rabbitGeometry() {
  const parts = [];
  const backY = 0.2;
  parts.push(
    tube(
      [
        { p: V(0, backY + 0.02, -0.2), r: 0.09 },
        { p: V(0, backY + 0.06, -0.04), r: 0.13 },
        { p: V(0, backY + 0.04, 0.12), r: 0.12 },
        { p: V(0, backY, 0.24), r: 0.08 },
      ],
      8
    )
  );
  parts.push(blob([0.075, 0.075, 0.095], [0, backY + 0.09, 0.29], [0, 0, 1, 0], 7, 5));
  for (const sx of [-1, 1]) {
    parts.push(
      tube(
        [
          { p: V(sx * 0.035, backY + 0.14, 0.27), r: 0.018, rig: [0, 0, 1, 0.2] },
          { p: V(sx * 0.05, backY + 0.26, 0.24), r: 0.026, rig: [0, 0, 1, 0.7] },
          { p: V(sx * 0.06, backY + 0.36, 0.21), r: 0.008, rig: [0, 0, 1, 1] },
        ],
        5
      )
    );
  }
  // The scut. Low, round, and the coat shader paints it white — a bolting rabbit
  // is a white dot bouncing away through the ferns and almost nothing else.
  parts.push(blob([0.045, 0.045, 0.04], [0, backY + 0.03, -0.23], [0, 0, 0, 0.3], 6, 4));
  parts.push(...legs([[0.13, backY - 0.02, 1], [-0.12, backY + 0.01, -1]], 0.075, -0.02, 0.028));

  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  geo.computeBoundingSphere();
  return { geometry: geo, neck: new THREE.Vector3(0, backY + 0.06, 0.2), height: 0.4 };
}

/** A squirrel. Mostly tail, which is correct. */
export function squirrelGeometry() {
  const parts = [];
  const backY = 0.13;
  parts.push(
    tube(
      [
        { p: V(0, backY, -0.13), r: 0.05 },
        { p: V(0, backY + 0.03, -0.02), r: 0.075 },
        { p: V(0, backY + 0.02, 0.09), r: 0.068 },
        { p: V(0, backY - 0.01, 0.17), r: 0.045 },
      ],
      7
    )
  );
  parts.push(blob([0.05, 0.05, 0.058], [0, backY + 0.05, 0.2], [0, 0, 1, 0], 7, 4));
  for (const sx of [-1, 1]) {
    parts.push(blob([0.016, 0.026, 0.01], [sx * 0.032, backY + 0.11, 0.19], [0, 0, 1, 0], 5, 3));
  }
  /**
   * The tail: a fat curved plume that arcs up over the back. It carries the
   * whole trim channel, so the same flick amplitude that twitches a rabbit's ear
   * sweeps this through a visible arc — which is the point of one channel with a
   * per-species amplitude.
   */
  /**
   * FAT. The first version gave it a 6 cm tail and it came out looking like a
   * weasel — which is fair, because a thin tail on a small brown quadruped IS a
   * weasel. A squirrel's tail is as thick as its body and nearly as long, and it
   * is the entire silhouette: at any distance where you can tell what the animal
   * is, the tail is what told you.
   */
  parts.push(
    tube(
      [
        { p: V(0, backY, -0.14), r: 0.04, rig: [0, 0, 0, 0.1] },
        { p: V(0, backY + 0.06, -0.25), r: 0.095, rig: [0, 0, 0, 0.35] },
        { p: V(0, backY + 0.21, -0.29), r: 0.115, rig: [0, 0, 0, 0.65] },
        { p: V(0, backY + 0.34, -0.21), r: 0.095, rig: [0, 0, 0, 0.88] },
        { p: V(0, backY + 0.41, -0.07), r: 0.045, rig: [0, 0, 0, 1] },
      ],
      7
    )
  );
  parts.push(...legs([[0.09, backY - 0.03, 1], [-0.08, backY - 0.01, -1]], 0.05, -0.01, 0.022));

  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  geo.computeBoundingSphere();
  return { geometry: geo, neck: new THREE.Vector3(0, backY + 0.03, 0.12), height: 0.3 };
}

/**
 * A flying thing: a body spindle and two wings, in the XZ plane, nose at +Z.
 *
 * `aWing` is (spanFrac, chordFrac): spanFrac is signed and runs -1..1 across the
 * wings with 0 down the body's centre line, chordFrac is 0 at the leading edge.
 * Everything the wing does in the shader is a function of |spanFrac| — the hinge
 * is at the shoulder, so the tip travels furthest and the body does not move at
 * all, which is what a wingbeat is.
 *
 * Twelve vertices. A bird at sixty metres is four pixels across; the entire
 * reason a flock reads as birds rather than as dots is the flap and the wheel,
 * and both of those are free in the vertex shader.
 *
 * THE PARAMETERS HERE ARE THE KIND, NOT THE SPECIES, and the distinction is a
 * draw call wide. `span`, `body`, `sweep` and `girth` are baked at build time,
 * so calling this twice gives a bird and a butterfly — two meshes, two
 * materials, two draws, which is what they cost today and what they should
 * cost. Calling it twelve more times to get a goldcrest and a wood pigeon would
 * cost twelve more, for a difference that is three numbers wide. So the species
 * a percher happens to be rides `aBuild` instead, an instanced non-uniform
 * scale on this one geometry; see `flyerMaterial`. What is built here is the
 * archetype every one of them is a stretched copy of, which is why the numbers
 * below are deliberately middling.
 */
export function flyerGeometry({ span = 1, body = 1, sweep = 0.25, girth = 1 } = {}) {
  const position = [];
  const normal = [];
  const wing = [];
  const index = [];

  const push = (x, y, z, nx, ny, nz, sf, cf) => {
    position.push(x, y, z);
    normal.push(nx, ny, nz);
    wing.push(sf, cf);
    return position.length / 3 - 1;
  };

  /**
   * THE BODY IS A SOLID, AND IT HAS TO BE.
   *
   * The first version was a flat diamond in the same plane as the wings, which
   * is exactly right for a bird ninety metres up — a silhouette against the sky
   * has no volume to show. Then a percher landed three metres from the camera
   * and it was a paper aeroplane: a flat card seen from the side is a line, and
   * a line with two flat wings on it is not any kind of animal.
   *
   * A four-sided tapered prism costs twenty-four triangles and fixes it from
   * every angle at once. Twenty-four triangles times a hundred and twenty birds
   * is under three thousand, which is less than one tree.
   */
  const RINGS = [
    { z: 0.52, r: 0.03 },
    { z: 0.18, r: 0.115 },
    { z: -0.2, r: 0.09 },
    { z: -0.56, r: 0.025 },
  ];
  const SIDES = 4;
  const ring = [];
  for (let i = 0; i < RINGS.length; i++) {
    const t = i / (RINGS.length - 1);
    for (let j = 0; j < SIDES; j++) {
      // Rotated an eighth of a turn so the prism has a back, a belly and two
      // flanks rather than an edge running down its spine.
      const a = (j / SIDES) * TAU + Math.PI * 0.25;
      const nx = Math.cos(a);
      const ny = Math.sin(a);
      ring.push(
        push(
          nx * RINGS[i].r * body * girth,
          ny * RINGS[i].r * body * girth * 0.82,
          RINGS[i].z * body,
          nx,
          ny * 0.82,
          0.18,
          0,
          t
        )
      );
    }
  }
  for (let i = 0; i < RINGS.length - 1; i++) {
    for (let j = 0; j < SIDES; j++) {
      const a = ring[i * SIDES + j];
      const b = ring[i * SIDES + ((j + 1) % SIDES)];
      const c = ring[(i + 1) * SIDES + j];
      const d = ring[(i + 1) * SIDES + ((j + 1) % SIDES)];
      index.push(a, c, b, b, c, d);
    }
  }

  // A forked tail, flat, in the wings' plane. Two triangles, and it is what
  // makes the silhouette read as bird rather than as dart.
  const tailRoot = push(0, 0, -body * 0.5, 0, 1, 0, 0, 1);
  const forkL = push(-body * 0.13, 0, -body * 0.78, 0, 1, 0, -0.05, 1);
  const forkR = push(body * 0.13, 0, -body * 0.78, 0, 1, 0, 0.05, 1);
  const forkM = push(0, 0, -body * 0.68, 0, 1, 0, 0, 1);
  index.push(tailRoot, forkL, forkM, tailRoot, forkM, forkR);

  // Wings: a swept quad each, hinged at the shoulder. `aWing.x` is signed and
  // runs to ±1 at the tip, which is the hinge weight for everything the shader
  // does to them.
  for (const s of [-1, 1]) {
    const root0 = push(s * body * 0.09, 0, body * 0.16, 0, 1, 0, s * 0.05, 0);
    const root1 = push(s * body * 0.08, 0, -body * 0.14, 0, 1, 0, s * 0.05, 1);
    const tip0 = push(s * span * 0.5, 0, body * 0.16 - span * sweep, 0, 1, 0, s, 0);
    const tip1 = push(s * span * 0.46, 0, -body * 0.18 - span * sweep, 0, 1, 0, s, 1);
    index.push(root0, tip0, root1, root1, tip0, tip1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(position), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normal), 3));
  geo.setAttribute('aWing', new THREE.BufferAttribute(new Float32Array(wing), 2));
  geo.setIndex(index);
  geo.computeBoundingSphere();
  return geo;
}
