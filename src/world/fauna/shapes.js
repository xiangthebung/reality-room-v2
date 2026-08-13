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
export function tapirGeometry() {
  const parts = [];
  /**
   * ==== THE TAPIR, WHICH IS THE DEER'S RIG AT DIFFERENT PROPORTIONS =========
   *
   * This used to be `deerGeometry` and it is the same skeleton, the same
   * channels and the same vertex budget. Only the control points moved, which
   * is the whole reason the largest mammal in the world could be swapped for
   * another one at no cost: the rig — head channel on the neck, trim channel on
   * the flicky bit, `legs()` for the four corners — was never about deer.
   *
   * WHAT ACTUALLY MAKES A TAPIR. It is the shape of a pig drawn by somebody
   * describing a horse, and three ratios carry all of it:
   *
   *   THE BACK SLOPES DOWN TO THE FRONT. A deer's spine is level and its head
   *   is carried high on a long neck. A tapir's highest point is its RUMP; the
   *   line falls away forward to a low shoulder and the head is carried below
   *   the withers. That is why `backY` is now sampled per control point rather
   *   than being flat, and it is the single most recognisable thing here.
   *
   *   IT IS ALL BARREL. The chest radius went 0.33 -> 0.42 and the rear 0.19 ->
   *   0.36, so the animal is a cylinder rather than a taper. A tapir has almost
   *   no waist.
   *
   *   THE LEGS ARE SHORT AND THE NECK IS SHORTER. The neck used to climb 0.74 m
   *   above the spine over 0.42 m of reach; it now climbs 0.20 over 0.30. The
   *   head is a heavy wedge sitting almost on the shoulders.
   *
   * AND THE ANTLERS ARE GONE — deleted, not folded. The spec drops `horn`, so
   * `uHorn.w` is 0 and the collapse branch in shading.js never runs; with no
   * geometry on the head-and-trim channel pair there is nothing for it to act
   * on either way. That also hands the full trim swing back to the ears, via
   * the `mix(1.0, aTone.x, rrHorn)` on `rrTrimSwing`, which is correct: a
   * tapir's ears flick constantly and it is the only part of it that moves
   * while it stands.
   */
  const backY = 1.0;
  /**
   * The barrel, and the y values are the sloping back described above: highest
   * at the rump (-0.9) and falling 0.16 m to the shoulder (+0.8).
   */
  parts.push(
    tube(
      [
        { p: V(0, backY + 0.04, -0.86), r: 0.28 },
        { p: V(0, backY + 0.08, -0.52), r: 0.38 },
        { p: V(0, backY + 0.04, -0.05), r: 0.42 },
        { p: V(0, backY - 0.04, 0.42), r: 0.4 },
        { p: V(0, backY - 0.12, 0.8), r: 0.28 },
      ],
      9
    )
  );
  // A short, thick, low-slung neck. headW still ramps 0 -> 1 along it so the
  // whole neck turns into the look; there is just far less of it to turn.
  const neckBase = V(0, backY - 0.08, 0.76);
  parts.push(
    tube(
      [
        { p: neckBase, r: 0.24, rig: [0, 0, 0, 0] },
        { p: V(0, backY - 0.02, 0.94), r: 0.19, rig: [0, 0, 0.45, 0] },
        { p: V(0, backY + 0.06, 1.06), r: 0.145, rig: [0, 0, 0.82, 0] },
        { p: V(0, backY + 0.1, 1.16), r: 0.115, rig: [0, 0, 1, 0] },
      ],
      7
    )
  );
  // The head: a long heavy wedge rather than a deer's neat blob.
  parts.push(blob([0.12, 0.13, 0.23], [0, backY + 0.11, 1.3], [0, 0, 1, 0], 8, 5));
  /**
   * THE PROBOSCIS, WHICH IS THE ANIMAL'S ONE UNMISTAKABLE FEATURE.
   *
   * A short prehensile trunk — not an elephant's, about 15 cm — hanging off the
   * front of the face and drooping below the jaw line. Two segments so it
   * curves down rather than sticking out straight, because a straight one reads
   * as a muzzle and the whole point of drawing it is that it does not.
   *
   * It is on the head channel at full weight, so it swings with the look. A
   * tapir casting about for a scent is mostly this thing moving.
   */
  parts.push(
    tube(
      [
        { p: V(0, backY + 0.07, 1.46), r: 0.075, rig: [0, 0, 1, 0] },
        { p: V(0, backY + 0.02, 1.58), r: 0.05, rig: [0, 0, 1, 0] },
        { p: V(0, backY - 0.05, 1.63), r: 0.032, rig: [0, 0, 1, 0] },
      ],
      6
    )
  );
  /**
   * Small round ears with pale rims, set well back and low. On the head channel
   * AND the trim channel (rig.w = 1) — which is exactly the pair that used to
   * mean "antler". It is safe now precisely because the antlers were deleted
   * and the spec dropped `horn`: with uHorn.w at 0 the headpiece branch is off,
   * so this pair simply means "moves with the head and flicks", which is what a
   * tapir's ears do.
   */
  for (const sx of [-1, 1]) {
    parts.push(
      tube(
        [
          { p: V(sx * 0.09, backY + 0.18, 1.22), r: 0.028, rig: [0, 0, 1, 1] },
          { p: V(sx * 0.15, backY + 0.27, 1.19), r: 0.05, rig: [0, 0, 1, 1] },
          { p: V(sx * 0.17, backY + 0.34, 1.17), r: 0.022, rig: [0, 0, 1, 1] },
        ],
        5
      )
    );
  }
  /**
   * A stub of a tail. A deer's was the point of the animal — the white flash of
   * a fleeing one — and a tapir's is a nub you can barely see, so it is short,
   * fat and pointed DOWN rather than raised. The coat shader still keys the
   * rump flash off something being at the back and low, and the spec's `flash`
   * has been moved and shrunk to suit: what a tapir has back there is a pale
   * rump edge, not a white banner.
   */
  parts.push(
    tube(
      [
        { p: V(0, backY + 0.02, -0.9), r: 0.05, rig: [0, 0, 0, 0.4] },
        { p: V(0, backY - 0.04, -1.0), r: 0.028, rig: [0, 0, 0, 1] },
      ],
      5
    )
  );
  /**
   * SHORT, THICK AND SET WELL UNDER THE BODY. A deer stands on 0.94 m of leg;
   * a tapir's is nearer 0.62, and thicker with it — this is a 250 kg animal on
   * columns, not a browser on stilts. Narrower apart in x too, because the
   * barrel above got much wider and legs at the old spacing come out of the
   * flanks instead of under them.
   */
  parts.push(...legs([[0.42, 0.62, 1], [-0.46, 0.6, -1]], 0.22, -0.04, 0.096));

  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  geo.computeBoundingSphere();
  return { geometry: geo, neck: neckBase.clone(), height: 1.12 };
}

/**
 * An agouti — the rabbit-shaped rodent that fills the rabbit's niche here.
 *
 * THE THREE CHANGES ARE ALL ABOUT THE BACK END, because that is where an
 * agouti and a rabbit differ and the front halves are genuinely almost the
 * same animal at this level of detail.
 *
 *   THE EARS COME OFF. A rabbit's ears are a third of its height and they are
 *   its entire silhouette; an agouti's are small, round and pressed to the
 *   skull. The tubes below went from 0.22 m of reach to 0.07, which is the
 *   single edit that stops this reading as a rabbit.
 *
 *   THE RUMP GOES UP. An agouti is built like a tiny deer at the back — high,
 *   rounded haunches and a body that slopes UP toward the tail, the opposite of
 *   the tapir above. The barrel's rear radius and height both rise.
 *
 *   THE SCUT GOES. A bolting rabbit is a white dot; an agouti has essentially
 *   no tail at all, so the blob shrinks to a nub and the spec's `flash` loses
 *   most of its radius. What you see instead is the coarse orange rump hair,
 *   which is a coat colour rather than a shape.
 *
 * The ears keep their trim weights, so they still twitch — that channel is what
 * makes a small mammal look alive when it is standing still, and it would be a
 * waste to delete it along with the length.
 */
export function agoutiGeometry() {
  const parts = [];
  const backY = 0.2;
  parts.push(
    tube(
      [
        { p: V(0, backY + 0.08, -0.21), r: 0.105 },
        { p: V(0, backY + 0.08, -0.04), r: 0.135 },
        { p: V(0, backY + 0.03, 0.12), r: 0.115 },
        { p: V(0, backY - 0.02, 0.24), r: 0.075 },
      ],
      8
    )
  );
  parts.push(blob([0.07, 0.07, 0.1], [0, backY + 0.06, 0.3], [0, 0, 1, 0], 7, 5));
  for (const sx of [-1, 1]) {
    parts.push(
      tube(
        [
          { p: V(sx * 0.035, backY + 0.11, 0.27), r: 0.016, rig: [0, 0, 1, 0.2] },
          { p: V(sx * 0.052, backY + 0.15, 0.255), r: 0.028, rig: [0, 0, 1, 0.7] },
          { p: V(sx * 0.058, backY + 0.18, 0.245), r: 0.009, rig: [0, 0, 1, 1] },
        ],
        5
      )
    );
  }
  // A nub, not a scut. See the block above.
  parts.push(blob([0.028, 0.028, 0.026], [0, backY + 0.06, -0.235], [0, 0, 0, 0.3], 6, 4));
  parts.push(...legs([[0.12, backY - 0.02, 1], [-0.115, backY + 0.03, -1]], 0.08, -0.02, 0.026));

  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  geo.computeBoundingSphere();
  return { geometry: geo, neck: new THREE.Vector3(0, backY + 0.06, 0.2), height: 0.4 };
}

/** A squirrel. Mostly tail, which is correct. */
/**
 * A capuchin — the small arboreal monkey that replaces the squirrel.
 *
 * THE LEAST-CHANGED OF THE THREE, AND DELIBERATELY SO. A squirrel and a
 * capuchin are, at the range you ever see one in this wood, the same
 * proposition: a small brown mammal the size of a cat, in a tree, whose
 * silhouette is dominated by a tail as long as its body. The tail block below
 * makes the argument for a squirrel and every word of it survives the rename.
 *
 * TWO EDITS, both about how the tail is CARRIED rather than how big it is. A
 * squirrel's plume arcs up over its own back and touches its shoulders; a
 * capuchin's hangs down and curls at the tip, and it is thinner and much
 * longer. So the arc is inverted — the control points go down and back instead
 * of up and forward — and the radius falls off toward the tip instead of
 * bulging in the middle. It keeps the whole trim channel either way, so the
 * same flick amplitude that twitches an agouti's ear still sweeps this through
 * a visible arc.
 *
 * The limbs go slightly longer and are set wider, because a monkey's arms are
 * long and it sits up on them. Everything else — the barrel, the head, the
 * ears — is the squirrel's, unchanged.
 */
export function capuchinGeometry() {
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
        { p: V(0, backY, -0.14), r: 0.038, rig: [0, 0, 0, 0.1] },
        { p: V(0, backY - 0.06, -0.28), r: 0.036, rig: [0, 0, 0, 0.35] },
        { p: V(0, backY - 0.18, -0.36), r: 0.032, rig: [0, 0, 0, 0.62] },
        { p: V(0, backY - 0.3, -0.33), r: 0.028, rig: [0, 0, 0, 0.85] },
        { p: V(0, backY - 0.36, -0.22), r: 0.019, rig: [0, 0, 0, 1] },
      ],
      7
    )
  );
  parts.push(...legs([[0.1, backY - 0.05, 1], [-0.095, backY - 0.02, -1]], 0.055, -0.01, 0.021));

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
 * cost. Calling it twelve more times to get a manakin and a toucan would
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
  // Wound to face UP, like the wings. See the winding note on the wings below:
  // the mirrored fork was facing down, so on a double-sided surface three lit
  // the top of every bird's tail as though it were the underside.
  index.push(tailRoot, forkM, forkL, tailRoot, forkR, forkM);

  // Wings: a swept quad each, hinged at the shoulder. `aWing.x` is signed and
  // runs to ±1 at the tip, which is the hinge weight for everything the shader
  // does to them.
  for (const s of [-1, 1]) {
    const root0 = push(s * body * 0.09, 0, body * 0.16, 0, 1, 0, s * 0.05, 0);
    const root1 = push(s * body * 0.08, 0, -body * 0.14, 0, 1, 0, s * 0.05, 1);
    const tip0 = push(s * span * 0.5, 0, body * 0.16 - span * sweep, 0, 1, 0, s, 0);
    const tip1 = push(s * span * 0.46, 0, -body * 0.18 - span * sweep, 0, 1, 0, s, 1);
    /**
     * THE TWO WINGS MUST WIND THE SAME WAY ROUND, and until Aug 2026 they did
     * not.
     *
     * One index order for both sides looks symmetric and is the opposite:
     * mirroring a triangle in x reverses its winding, so with a single
     * `(root0, tip0, root1)` the right wing faced up and the left wing faced
     * down. Nothing complained, because the material is DoubleSide — but three
     * flips the shading normal by `gl_FrontFacing` on a double-sided surface,
     * so the left wing was being lit by the sun as though its underside were
     * its top. Every bird in the wood has had one wing lit wrong since the
     * flyer was written; at sixty metres that is invisible, which is why it
     * survived.
     *
     * It stops being invisible the moment anything asks WHICH SIDE OF THE WING
     * IT IS LOOKING AT, which is exactly what a blue morpho is: blue on top,
     * dead brown underneath. With the old winding a morpho was blue on its
     * right wing and brown on its left, simultaneously, for ever.
     *
     * Reversing the left side's index order costs nothing and makes
     * `gl_FrontFacing` mean "you are looking at the top of this animal" on both
     * wings at once.
     */
    if (s > 0) index.push(root0, tip0, root1, root1, tip0, tip1);
    else index.push(root0, root1, tip0, root1, tip1, tip0);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(position), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normal), 3));
  geo.setAttribute('aWing', new THREE.BufferAttribute(new Float32Array(wing), 2));
  geo.setIndex(index);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * A BUTTERFLY, which is not a small bird.
 *
 * The butterflies used to be `flyerGeometry` called with a small span, and at
 * ninety metres that was completely fine — a flapping speck is a flapping
 * speck. It stops being fine at three metres, which is where a butterfly
 * actually is, and the reason is the wing OUTLINE. A bird's wing is a swept
 * quad: narrow, pointed, longer than it is deep. A butterfly's is two broad
 * overlapping paddles, deeper than they are long, and the ratio is the entire
 * difference between "butterfly" and "moth" or "small bird" at a glance. A blue
 * morpho is the extreme case: it is very nearly two rounded blue plates with an
 * insect between them, and the plates are what you remember.
 *
 * So: a forewing and a hindwing per side, five-sided fans both, plus a slim
 * three-ring body. TWENTY-EIGHT TRIANGLES, which is exactly what the bird
 * archetype it replaces cost — the tail fork and one body ring pay for both
 * extra wings and the rounded margins. It is not a cost, it is a reshuffle.
 *
 * FIVE POINTS PER WING AND NOT FOUR, which is worth the four triangles. With
 * four the outer edge is one straight cut and a butterfly at two metres reads
 * as a paper aeroplane — two flat plates with a corner. The fifth point puts a
 * break in the outer margin, so the forewing has an apex and a shoulder rather
 * than a diagonal, and the hindwing has a lobe. It is the difference between an
 * outline and a polygon.
 *
 * BOTH AXES ARE IN HALF-SPANS, not in body lengths, and that is the fix for
 * the proportion. A butterfly's wing is about as DEEP as it is long — a morpho
 * is very nearly two circles — so tying the chord to the abdomen makes the wing
 * a function of the wrong number and every species comes out a dart. The
 * forewing's trailing edge and the hindwing's leading edge deliberately overlap
 * at z ≈ -0.1, so the two read as one continuous rounded wing rather than as
 * two plates with a gap between them.
 *
 * SAME CONTRACT AS `flyerGeometry`, deliberately: position, normal and
 * `aWing` = (signed spanFrac, chordFrac), tip at |spanFrac| = 1 and the centre
 * line at 0. Every line of the shared flyer shader — the hinge, the
 * foreshortening, the species scale, the mark radius — is a function of those
 * two numbers and nothing else, so this drops in with no shader change at all
 * and keeps the butterflies in the one draw call they have always been.
 *
 * The wings are wound to face UP on both sides, for the reason spelled out in
 * `flyerGeometry`: `gl_FrontFacing` has to mean "the top of the wing" or the
 * morpho's blue lands on one wing and its drab underside on the other.
 *
 * `span` is the FULL wingspan in metres; the apex sits at span·0.5.
 */
export function flutterGeometry({ span = 0.12, body = 0.05, girth = 1 } = {}) {
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
   * A thin three-ring prism: head end, thorax, abdomen tip. Three rings and not
   * the flyer's four because a butterfly's body has no shape worth spending a
   * ring on — it is a stick, and every pixel of interest is on the wings.
   */
  const RINGS = [
    { z: 0.44, r: 0.055 },
    { z: 0.06, r: 0.1 },
    { z: -0.72, r: 0.022 },
  ];
  const SIDES = 4;
  const ring = [];
  for (let i = 0; i < RINGS.length; i++) {
    const t = i / (RINGS.length - 1);
    for (let j = 0; j < SIDES; j++) {
      const a = (j / SIDES) * TAU + Math.PI * 0.25;
      const nx = Math.cos(a);
      const ny = Math.sin(a);
      ring.push(
        push(
          nx * RINGS[i].r * body * girth,
          ny * RINGS[i].r * body * girth,
          RINGS[i].z * body,
          nx,
          ny,
          0.15,
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

  /**
   * The wings, as outlines in (spanFrac, chord) — x is a fraction of the half
   * span, z is in body lengths, and both are traced from a set morpho with its
   * wings open. The forewing's apex is out and slightly FORWARD of the
   * shoulder, the trailing edge cuts back in sharply, and the hindwing is a
   * shorter rounder lobe tucked behind and inboard of it. Those three facts are
   * the silhouette; everything else is decoration you cannot see at this size.
   *
   * `cf` is the chord fraction the shared shader wants: 0 on the leading edge,
   * 1 on the trailing one. It is what the mark gradient runs along, so the
   * numbers are the honest position on the wing and not just 0 and 1.
   */
  const W = span * 0.5;
  const FORE = [
    [0.05, 0.3, 0.0],
    [0.62, 0.44, 0.0],
    [1.0, 0.16, 0.25],
    [0.8, -0.26, 0.75],
    [0.12, -0.08, 1.0],
  ];
  const HIND = [
    [0.08, -0.06, 0.0],
    [0.72, -0.26, 0.15],
    [0.78, -0.62, 0.6],
    [0.42, -0.92, 1.0],
    [0.08, -0.6, 1.0],
  ];
  for (const s of [-1, 1]) {
    for (const poly of [FORE, HIND]) {
      const v = poly.map(([sf, cz, cf]) => push(s * sf * W, 0, cz * W, 0, 1, 0, s * sf, cf));
      // A fan from the root vertex: five points, three triangles, one rounded
      // margin. Wound so the +y side is the front face on BOTH wings — mirroring
      // in x reverses a triangle, so the left side gets the reversed order.
      for (let k = 1; k < v.length - 1; k++) {
        if (s > 0) index.push(v[0], v[k], v[k + 1]);
        else index.push(v[0], v[k + 1], v[k]);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(position), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normal), 3));
  geo.setAttribute('aWing', new THREE.BufferAttribute(new Float32Array(wing), 2));
  geo.setIndex(index);
  geo.computeBoundingSphere();
  return geo;
}
