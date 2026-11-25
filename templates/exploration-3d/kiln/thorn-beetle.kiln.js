const meta = { name: 'Thorn beetle', role: 'prop' };

// The thorn beetle of Game Studio's Thornwood Ruins: about 1 m tall, 1.2 m wide and 2 m long with its
// mandibles. It faces +Z, as glTF characters do; the game turns it to walk forward. Colours match the
// game's built-in beetle: violet shell, dark underside, glowing yellow eyes and green thorns.
// Animations: Idle (breathing, antennae sway) and Walk (two tripods of legs, as insects walk), which
// the game plays by name. Each leg hangs from a hip pivot; the body, head and thorns ride a body pivot.
const SHELL_Y = 0.55;
const SHELL = { hx: 0.54, hy: 0.36, hz: 0.6, z: -0.08 };
const LEGS = [
  { name: 'Front', hipZ: 0.3, kneeZ: 0.44, footZ: 0.6 },
  { name: 'Middle', hipZ: 0.0, kneeZ: 0.0, footZ: 0.02 },
  { name: 'Back', hipZ: -0.3, kneeZ: -0.46, footZ: -0.64 },
];
const WALK = 0.6; // seconds per stride
const SWING = 18; // degrees a leg swings forward and back
const LIFT = 9; // degrees a swinging leg lifts

/** A point on the shell's surface above (x, z), sunk a little so a part sits into it. */
function shellPoint(x, z, sink) {
  const u = 1 - (x / SHELL.hx) ** 2 - ((z - SHELL.z) / SHELL.hz) ** 2;
  return [x, SHELL_Y + SHELL.hy * Math.sqrt(Math.max(u, 0)) - sink, z];
}

/** Direction of a cone rotated by [a, 0, c] degrees (its apex starts along +Y). */
function coneDirection(a, c) {
  const ar = (a * Math.PI) / 180;
  const cr = (c * Math.PI) / 180;
  return [-Math.sin(cr), Math.cos(cr) * Math.cos(ar), Math.cos(cr) * Math.sin(ar)];
}

/** A cone whose base sits at `base`, pointing along rotation [a, 0, c]. */
function spike(name, base, length, radius, a, c, material, parent) {
  const d = coneDirection(a, c);
  const centre = [base[0] + (d[0] * length) / 2, base[1] + (d[1] * length) / 2, base[2] + (d[2] * length) / 2];
  return createPart(name, coneGeo(radius, length, 8), material, { position: centre, rotation: [a, 0, c], parent });
}

const legName = (side, leg) => `${side < 0 ? 'Left' : 'Right'}${leg.name}`;
const hipOf = (side, leg) => [side * 0.36, 0.3, leg.hipZ];

function build() {
  const root = createRoot('ThornBeetle');
  const shell = gameMaterial(0x5b3d7a, { roughness: 0.42, metalness: 0.15, flatShading: false, name: 'Shell' });
  const dark = gameMaterial(0x2b2233, { roughness: 0.75, flatShading: false, name: 'Underside' });
  const legs = gameMaterial(0x2b2233, { roughness: 0.75, flatShading: false, name: 'Legs' });
  const thorn = gameMaterial(0x7bd36a, { roughness: 0.6, name: 'Thorn' });
  const eye = gameMaterial(0xffd23f, { emissive: 0xffd23f, emissiveIntensity: 2.5, roughness: 0.3, flatShading: false, name: 'Eye' });
  const bone = gameMaterial(0xd9c9a3, { roughness: 0.5, name: 'Mandible' });
  const seam = gameMaterial(0x3a2650, { roughness: 0.5, metalness: 0.1, flatShading: false, name: 'Seam' });

  // The body pivot: everything but the legs breathes and bobs with it.
  const body = createPivot('Body', [0, 0, 0], root);
  createPart('Shell', sphereGeo(0.5, 24, 16), shell, { position: [0, SHELL_Y, SHELL.z], scale: [SHELL.hx * 2, SHELL.hy * 2, SHELL.hz * 2], parent: body });
  // The seam between the two wing cases: a thin darker strip standing just proud of the shell.
  createPart('Seam', sphereGeo(0.5, 12, 16), seam, { position: [0, SHELL_Y, SHELL.z - 0.02], scale: [0.05, SHELL.hy * 2 + 0.03, SHELL.hz * 2 - 0.06], parent: body });
  createPart('Belly', sphereGeo(0.5, 20, 12), dark, { position: [0, 0.34, -0.04], scale: [0.92, 0.38, 1.12], parent: body });
  createPart('Shield', sphereGeo(0.5, 18, 12), shell, { position: [0, 0.5, 0.56], scale: [0.8, 0.5, 0.44], parent: body });

  // Head at the front (+Z), with eyes, mandibles and antennae on their own pivots so they can sway.
  createPart('Head', sphereGeo(0.24, 16, 12), dark, { position: [0, 0.42, 0.86], parent: body });
  for (const side of [-1, 1]) {
    const name = side < 0 ? 'Left' : 'Right';
    createPart(`Eye${name}`, sphereGeo(0.07, 12, 8), eye, { position: [side * 0.13, 0.5, 1.03], parent: body });
    spike(`Mandible${name}`, [side * 0.12, 0.3, 1.0], 0.32, 0.055, 90, side * 22, bone, body);
    const base = [side * 0.09, 0.6, 1.0];
    const antenna = createPivot(`Antenna${name}`, base, body);
    beamBetween(`AntennaStalk${name}`, [0, 0, 0], [side * 0.19, 0.32, 0.25], 0.015, dark, { parent: antenna, segments: 6 });
  }

  // Thorns: a ridge along the back pointing up and back, and two on each flank.
  [-0.45, -0.18, 0.1, 0.32].forEach((z, i) => {
    const length = [0.3, 0.36, 0.32, 0.24][i];
    spike(`Thorn${i + 1}`, shellPoint(0, z, 0.05), length, 0.08, -25, 0, thorn, body);
  });
  for (const side of [-1, 1]) {
    [-0.3, 0.06].forEach((z, i) => {
      spike(`Flank${side < 0 ? 'Left' : 'Right'}${i + 1}`, shellPoint(side * 0.42, z, 0.04), 0.22, 0.06, -25, -side * 45, thorn, body);
    });
  }

  // Six legs, each hanging from its hip pivot: a thigh out to a raised knee, a shin down to the ground.
  for (const side of [-1, 1]) {
    for (const leg of LEGS) {
      const hip = hipOf(side, leg);
      const pivot = createPivot(`Hip${legName(side, leg)}`, hip, root);
      const knee = [side * 0.55 - hip[0], 0.42 - hip[1], leg.kneeZ - hip[2]];
      const foot = [side * 0.57 - hip[0], 0.03 - hip[1], leg.footZ - hip[2]];
      beamBetween(`Thigh${legName(side, leg)}`, [0, 0, 0], knee, 0.04, legs, { parent: pivot, segments: 8 });
      beamBetween(`Shin${legName(side, leg)}`, knee, foot, 0.03, legs, { parent: pivot, segments: 8 });
    }
  }
  return root;
}

/**
 * A leg's turn at `phase` (0..1 of a stride): it swings forward with its foot lifted for the first half,
 * then sweeps back along the ground. Forward is +Z: about Y that is +swing on the left and -swing on the
 * right, and lifting the foot is a roll toward the body.
 */
function legPose(side, phase) {
  const p = ((phase % 1) + 1) % 1;
  const forward = p < 0.5 ? -SWING + (2 * SWING * p) / 0.5 : SWING - (2 * SWING * (p - 0.5)) / 0.5;
  const lift = p < 0.5 ? LIFT * Math.sin((p / 0.5) * Math.PI) : 0;
  return [0, side < 0 ? forward : -forward, side * lift];
}

function animate(root) {
  const steps = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
  const walk = [];
  for (const side of [-1, 1]) {
    LEGS.forEach((leg, i) => {
      // Two tripods: front and back on one side with the middle on the other, half a stride apart.
      const offset = (i === 1) === (side < 0) ? 0.5 : 0;
      walk.push(rotationTrack(`Joint_Hip${legName(side, leg)}`, steps.map((t) => ({ time: t * WALK, rotation: legPose(side, t + offset) }))));
    });
  }
  // The body bobs twice a stride, and the antennae nod.
  walk.push(positionTrack('Joint_Body', [0, 0.25, 0.5, 0.75, 1].map((t, i) => ({ time: t * WALK, position: [0, i % 2 === 0 ? 0 : 0.025, 0] }))));
  for (const side of [-1, 1]) {
    const name = side < 0 ? 'Left' : 'Right';
    walk.push(rotationTrack(`Joint_Antenna${name}`, [0, 0.5, 1].map((t, i) => ({ time: t * WALK, rotation: [i === 1 ? -10 : 6, 0, 0] }))));
  }
  const idle = [
    positionTrack('Joint_Body', [0, 1, 2].map((t, i) => ({ time: t, position: [0, i === 1 ? 0.015 : 0, 0] })), 'EASE_IN_OUT'),
  ];
  for (const side of [-1, 1]) {
    const name = side < 0 ? 'Left' : 'Right';
    idle.push(rotationTrack(`Joint_Antenna${name}`, [0, 0.7, 1.4, 2].map((t, i) => ({ time: t, rotation: [[0, -12, 4, 0][i], side * [0, 6, -4, 0][i], 0] })), 'EASE_IN_OUT'));
  }
  return [createClip('Idle', 2, idle, { loop: true }), createClip('Walk', WALK, walk, { loop: true })];
}
