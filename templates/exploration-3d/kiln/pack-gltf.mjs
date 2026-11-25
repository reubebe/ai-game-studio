// Packs a Kiln GLB for Game Studio: optionally merges meshes that share a material (fewer draw calls in
// the game), then writes one .gltf text file with its binary data embedded, which a template can carry.
//   node tools/pack-gltf.mjs IN.glb OUT.gltf [--keep "Name,Name"] [--no-join]
// Nodes whose names contain a --keep word stay separate from the merge (a gate's door, for example).
import { readFileSync, writeFileSync } from "node:fs";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, flatten, join, prune } from "@gltf-transform/functions";

const [input, output, ...rest] = process.argv.slice(2);
if (!input || !output || !output.endsWith(".gltf")) throw new Error("usage: pack-gltf.mjs IN.glb OUT.gltf [--keep Names] [--no-join]");
const keep = (rest.includes("--keep") ? rest[rest.indexOf("--keep") + 1] ?? "" : "").split(",").map((s) => s.trim()).filter(Boolean);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.readBinary(new Uint8Array(readFileSync(input)));
const before = doc.getRoot().listMeshes().reduce((n, m) => n + m.listPrimitives().length, 0);
if (!rest.includes("--no-join")) {
  // Kept nodes are moved out of reach of join() by giving their meshes a marker it will not cross.
  const kept = doc.getRoot().listNodes().filter((n) => keep.some((k) => n.getName().includes(k)));
  for (const n of kept) n.setExtras({ ...n.getExtras(), gsKeep: true });
  // An animated model keeps its hierarchy (its pivots move their children), so only parts hanging from the
  // same pivot are merged, and nothing an animation moves is merged away.
  const animated = new Set(doc.getRoot().listAnimations().flatMap((a) => a.listChannels().map((c) => c.getTargetNode())).filter(Boolean));
  const steps = animated.size > 0 ? [dedup()] : [dedup(), flatten()];
  await doc.transform(...steps, join({ keepNamed: false, filter: (node) => !node.getExtras()?.gsKeep && !animated.has(node) }), prune({ keepLeaves: animated.size > 0 }));
}
const after = doc.getRoot().listMeshes().reduce((n, m) => n + m.listPrimitives().length, 0);
const { json, resources } = await io.writeJSON(doc, { format: "gltf" });
for (const buffer of json.buffers ?? []) {
  const bytes = resources[buffer.uri];
  if (!bytes) throw new Error(`missing buffer ${buffer.uri}`);
  buffer.uri = `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;
}
json.asset = { ...json.asset, generator: `${json.asset?.generator ?? "Kiln"}; packed for Game Studio (glTF-Transform)` };
writeFileSync(output, JSON.stringify(json));
console.log(JSON.stringify({ output, primitivesBefore: before, primitivesAfter: after, nodes: (json.nodes ?? []).map((n) => n.name), animations: (json.animations ?? []).map((a) => `${a.name} (${a.channels.length} tracks)`), bytes: JSON.stringify(json).length }));
