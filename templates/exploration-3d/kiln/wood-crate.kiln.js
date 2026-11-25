const meta = { name: 'Wooden crate', role: 'prop' };

// A pushable wooden crate for Game Studio's 3D adventure: a 1.2 m cube standing on the ground, with a
// dark frame along every edge, a cross brace on each side and a plank round its middle (as the game's
// built-in wooden block has). Colours match the game's wooden block.
const SIZE = 1.2;
const T = 0.1; // frame timber thickness

async function build() {
  const root = createRoot('WoodCrate');
  const boards = gameMaterial(0x9a6b3c, { roughness: 0.85, name: 'Boards' });
  const timber = gameMaterial(0x6b4a2a, { roughness: 0.8, name: 'Frame' });

  createPart('Body', await roundedBoxGeo(SIZE - 0.04, SIZE - 0.04, SIZE - 0.04, 0.02, { style: 'chamfer' }), boards, { position: [0, SIZE / 2, 0], parent: root });

  // Frame: the twelve edges.
  const h = SIZE / 2 - T / 2;
  for (const y of [T / 2, SIZE - T / 2]) {
    for (const z of [-h, h]) createPart(`RailX${y < 0.5 ? 'Low' : 'High'}${z < 0 ? 'Back' : 'Front'}`, boxGeo(SIZE, T, T), timber, { position: [0, y, z], parent: root });
    for (const x of [-h, h]) createPart(`RailZ${y < 0.5 ? 'Low' : 'High'}${x < 0 ? 'Left' : 'Right'}`, boxGeo(T, T, SIZE - 2 * T), timber, { position: [x, y, 0], parent: root });
  }
  for (const x of [-h, h]) for (const z of [-h, h]) createPart(`Post${x < 0 ? 'L' : 'R'}${z < 0 ? 'B' : 'F'}`, boxGeo(T, SIZE - 2 * T, T), timber, { position: [x, SIZE / 2, z], parent: root });

  // A diagonal brace across each side, and a plank round the middle.
  const span = SIZE - 2 * T;
  const diag = Math.hypot(span, span) - 0.06;
  const sides = [
    { name: 'Front', position: [0, SIZE / 2, SIZE / 2 - 0.035], rotation: [0, 0, 45] },
    { name: 'Back', position: [0, SIZE / 2, -SIZE / 2 + 0.035], rotation: [0, 0, -45] },
    { name: 'Right', position: [SIZE / 2 - 0.035, SIZE / 2, 0], rotation: [45, 0, 0] },
    { name: 'Left', position: [-SIZE / 2 + 0.035, SIZE / 2, 0], rotation: [-45, 0, 0] },
  ];
  for (const s of sides) {
    const geo = s.name === 'Front' || s.name === 'Back' ? boxGeo(diag, 0.12, 0.05) : boxGeo(0.05, 0.12, diag);
    createPart(`Brace${s.name}`, geo, timber, { position: s.position, rotation: s.rotation, parent: root });
  }
  createPart('MiddlePlank', boxGeo(SIZE, 0.16, SIZE), timber, { position: [0, SIZE / 2, 0], parent: root });
  return root;
}
