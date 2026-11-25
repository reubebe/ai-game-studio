# Thornwood Ruins models (made with Kiln)

The 3D adventure template's thorn beetle, stone block, wooden crate and shrine gate were made with
[Kiln](https://github.com/instruktlabs/kiln) 1.9.0 (MIT licence), Instrukt Labs' tool for building 3D
models from code. The `.kiln.js` files here are their editable sources. The game reads the packed copies in
`../adventure-assets/models/kiln/`, which the template puts in each new project's `godot/assets/models/kiln/`.

To change one: edit its source, render it with Kiln, look at the views it writes, and pack the result.

```sh
# In a Kiln asset workspace (npx kiln-init), with this folder's files copied into it:
node kiln.mjs render thorn-beetle.kiln.js --out thorn-beetle.glb --views thorn-beetle.png
# From the Kiln installation (it has glTF-Transform):
node pack-gltf.mjs thorn-beetle.glb thorn-beetle.gltf
```

`pack-gltf.mjs` merges the meshes that share a material (fewer draw calls in the game) and writes one
`.gltf` text file with its data embedded, which a template can carry. An animated model keeps its hierarchy:
only parts hanging from the same pivot merge, and nothing an animation moves is merged away. The conventions
the game relies on:

- Metres, y up, standing on y = 0. Characters (the beetle) face +Z, as glTF characters do, and name their
  clips so the game finds them: Idle and Walk (any name containing idle or walk).
- Blocks are fitted to the 1.2 m block, so any size works; keep them within a cube.
- Gates face +Z, and every part of the door has `Door` in its name and uses only the door's materials, so
  merging keeps the door apart from the frame and the game can sink it. The game scales a gate so its door
  is the gate's width (these are made for a 6 m doorway).
