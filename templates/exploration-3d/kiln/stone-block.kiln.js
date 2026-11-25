const meta = { name: 'Stone block', role: 'prop' };

// The pushable stone block of Game Studio's Thornwood Ruins: a 1.2 m cube standing on the ground, with
// chamfered edges, a carved band round its middle (as the game's built-in block has) and a sun boss on
// each side. Everything stays inside the 1.2 m cube the game pushes. Colours match the game's stone block.
const SIZE = 1.2;
const BODY = 1.14; // the block itself
const BAND = 1.17; // the band stands 15 mm proud of it
const HALF = SIZE / 2;

async function build() {
  const root = createRoot('StoneBlock');
  const stone = gameMaterial(0x8d8a80, { roughness: 0.92, name: 'Stone' });
  const band = gameMaterial(0x6f6c63, { roughness: 0.95, name: 'CarvedBand' });
  const sun = gameMaterial(0xa8a395, { roughness: 0.85, name: 'SunBoss' });

  createPart('Body', await roundedBoxGeo(BODY, SIZE, BODY, 0.05, { style: 'chamfer' }), stone, { position: [0, HALF, 0], parent: root });
  createPart('Band', await roundedBoxGeo(BAND, 0.22, BAND, 0.02, { style: 'chamfer' }), band, { position: [0, HALF, 0], parent: root });

  // A sun boss on each side: a disc from the block's face out past the band, a raised centre and eight rays.
  const sides = [
    { name: 'Front', n: [0, 0, 1], rotation: [90, 0, 0] },
    { name: 'Back', n: [0, 0, -1], rotation: [-90, 0, 0] },
    { name: 'Right', n: [1, 0, 0], rotation: [0, 0, -90] },
    { name: 'Left', n: [-1, 0, 0], rotation: [0, 0, 90] },
  ];
  const at = (n, depth) => [n[0] * depth, HALF, n[2] * depth];
  for (const s of sides) {
    // Disc: from the block face (0.57) to 0.59, beyond the band (0.585).
    createPart(`Disc${s.name}`, cylinderGeo(0.16, 0.16, 0.02, 24), sun, { position: at(s.n, 0.58), rotation: s.rotation, parent: root });
    // Centre: 0.59 to 0.6, the cube's face.
    createPart(`Centre${s.name}`, cylinderGeo(0.07, 0.08, 0.01, 16), sun, { position: at(s.n, 0.595), rotation: s.rotation, parent: root });
    // Rays on the block face above and below the band, 0.57 to 0.58.
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      const r = 0.22;
      const along = [Math.cos(angle) * r, Math.sin(angle) * r];
      const position = s.n[2] !== 0 ? [along[0], HALF + along[1], s.n[2] * 0.575] : [s.n[0] * 0.575, HALF + along[1], along[0]];
      const spin = s.n[2] !== 0 ? [0, 0, (angle * 180) / Math.PI] : [(-angle * 180) / Math.PI * s.n[0], 0, 0];
      const geo = s.n[2] !== 0 ? boxGeo(0.09, 0.035, 0.01) : boxGeo(0.01, 0.035, 0.09);
      const ray = createPart(`Ray${s.name}${i + 1}`, geo, sun, { position, parent: root });
      ray.rotation.set((spin[0] * Math.PI) / 180, 0, (spin[2] * Math.PI) / 180);
    }
  }
  return root;
}
