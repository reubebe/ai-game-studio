const meta = { name: 'Shrine gate', role: 'building' };

// The shrine gate of Game Studio's 3D templates, for a 6 m doorway: stone pillars on plinths, a lintel
// with a keystone, and a plank door with bronze bands and a glowing sun. The front faces +Z, like the
// game's built-in gate. Every part of the door is named Door... and uses only the door's materials, so
// the game can sink the door (4 m tall) into the ground while the frame stays.
const W = 6;
const PILLAR = 0.9;
const PILLAR_H = 4.4;
const LINTEL_H = 0.7;
const DOOR_H = 4.0;
const DOOR_T = 0.35;
const PX = W / 2 + PILLAR / 2; // pillar centres

async function build() {
  const root = createRoot('ShrineGate');
  const stone = gameMaterial(0xb9a27a, { roughness: 0.9, name: 'Stone' });
  const carving = gameMaterial(0x9c8763, { roughness: 0.92, name: 'Carving' });
  const wood = gameMaterial(0x6b4a2a, { roughness: 0.8, name: 'DoorWood' });
  const backing = gameMaterial(0x4a3220, { roughness: 0.85, name: 'DoorBacking' });
  const bronze = gameMaterial(0x8c6a3a, { roughness: 0.4, metalness: 0.7, flatShading: false, name: 'DoorBronze' });
  const gold = gameMaterial(0xf2b84b, { emissive: 0xf2b84b, emissiveIntensity: 1.2, roughness: 0.3, metalness: 0.4, flatShading: false, name: 'DoorSun' });

  // Frame: plinth, pillar and capital on each side, then the lintel and keystone across the top.
  for (const side of [-1, 1]) {
    const x = side * PX;
    const name = side < 0 ? 'Left' : 'Right';
    createPart(`Plinth${name}`, await roundedBoxGeo(1.1, 0.4, 1.1, 0.04, { style: 'chamfer' }), stone, { position: [x, 0.2, 0], parent: root });
    createPart(`Pillar${name}`, await roundedBoxGeo(PILLAR, PILLAR_H - 0.7, PILLAR, 0.05, { style: 'chamfer' }), stone, { position: [x, 0.4 + (PILLAR_H - 0.7) / 2, 0], parent: root });
    createPart(`Capital${name}`, await roundedBoxGeo(1.05, 0.3, 1.05, 0.04, { style: 'chamfer' }), stone, { position: [x, PILLAR_H - 0.15, 0], parent: root });
    // Two carved grooves down the front of each pillar.
    for (const dx of [-0.2, 0.2]) createPart(`Groove${name}${dx < 0 ? 'A' : 'B'}`, boxGeo(0.08, PILLAR_H - 1.1, 0.03), carving, { position: [x + dx, 0.4 + (PILLAR_H - 0.7) / 2, PILLAR / 2 + 0.005], parent: root });
  }
  createPart('Lintel', await roundedBoxGeo(W + 2 * PILLAR, LINTEL_H, 1.0, 0.05, { style: 'chamfer' }), stone, { position: [0, PILLAR_H + LINTEL_H / 2, 0], parent: root });
  createPart('LintelBand', boxGeo(W + 2 * PILLAR - 0.4, 0.1, 0.03), carving, { position: [0, PILLAR_H + LINTEL_H / 2, 0.51], parent: root });
  createPart('Keystone', await roundedBoxGeo(1.0, 1.0, 1.16, 0.05, { style: 'chamfer' }), stone, { position: [0, PILLAR_H + 0.45, 0], parent: root });
  createPart('KeystoneSun', cylinderGeo(0.28, 0.28, 0.03, 20), carving, { position: [0, PILLAR_H + 0.45, 0.59], rotation: [90, 0, 0], parent: root });

  // Door: a dark backing with eight planks in front, two bronze bands with studs, and the sun.
  createPart('DoorBacking', boxGeo(W - 0.02, DOOR_H - 0.02, 0.2), backing, { position: [0, DOOR_H / 2, -0.075], parent: root });
  const plank = (W - 0.02 - 7 * 0.025) / 8;
  for (let i = 0; i < 8; i++) {
    const x = -W / 2 + 0.01 + plank / 2 + i * (plank + 0.025);
    createPart(`DoorPlank${i + 1}`, boxGeo(plank, DOOR_H - 0.06, 0.15), wood, { position: [x, DOOR_H / 2, 0.1], parent: root });
  }
  for (const [band, y] of [['Low', 1.0], ['High', 3.55]]) {
    createPart(`DoorBand${band}`, boxGeo(W - 0.1, 0.2, 0.04), bronze, { position: [0, y, 0.195], parent: root });
    for (let i = 0; i < 8; i++) {
      const x = -W / 2 + 0.4 + (i * (W - 0.8)) / 7;
      createPart(`DoorStud${band}${i + 1}`, sphereGeo(0.045, 10, 8), bronze, { position: [x, y, 0.225], parent: root });
    }
  }
  const sunY = 2.4;
  createPart('DoorSun', cylinderGeo(0.6, 0.6, 0.06, 32), gold, { position: [0, sunY, 0.21], rotation: [90, 0, 0], parent: root });
  for (let i = 0; i < 12; i++) {
    const angle = (i * Math.PI) / 6;
    const ray = createPart(`DoorRay${i + 1}`, coneGeo(0.09, 0.32, 4), gold, { position: [Math.sin(angle) * 0.8, sunY + Math.cos(angle) * 0.8, 0.2], parent: root });
    // Point each ray outward from the sun's centre (cones point +Y; turn about Z).
    ray.rotation.set(0, 0, -angle);
  }
  return root;
}
