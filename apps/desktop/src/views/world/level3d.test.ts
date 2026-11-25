import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Box3, Color, DataTexture, Euler, FogExp2, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, Ray, Raycaster, ShaderChunk, ShaderMaterial, Vector3, type Object3D } from "three";
import { OBJECT_DEFAULTS, OBJECT_TYPES, RUINS_MODELS, sunCrystalValley, type World, type WorldObject } from "@gamestudio/explore";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { LevelModel, MAX_LIGHTS, MODEL_BOUNDS, RING_Y, SPAWN_ID, SUN_INTENSITY, bearing, doorParts, intersectObject, lightOf, normalizeRotation, pickClip, pickProxy, ringRadius, siblingAsset, suggestedHeight, sunDirection } from "./level3d";
import { boxGlb, characterGlb } from "../../../../../packages/project/src/test-assets";
import { grassCellSize, grassKeepOut, hash01, natureMeshes, patches, placeTufts, skyFog, turnOf, variantOf } from "@gamestudio/explore";
import { LEAF_ATLAS_URL, toLinear } from "./nature";

const DEG = Math.PI / 180;
const down = (x: number, z: number) => new Ray(new Vector3(x, 50, z), new Vector3(0, -1, 0));
/** The box around an object's meshes. */
const bounds = (m: LevelModel, id: string) => {
  const g = m.group(id)!;
  g.updateMatrixWorld(true);
  const box = new Box3();
  g.traverse((o) => {
    if (o instanceof Mesh) box.union(new Box3().setFromObject(o));
  });
  return box;
};
/** A .gltf with one embedded buffer as a GLB, so GLTFLoader parses it without loading anything (Node has no ProgressEvent). */
function gltfToGlb(text: string): ArrayBuffer {
  const json = JSON.parse(text) as { buffers: { uri?: string }[] };
  const uri = json.buffers[0]!.uri!;
  const bin = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
  delete json.buffers[0]!.uri;
  const pad = (n: number) => (4 - (n % 4)) % 4;
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(pad(jsonBytes.length), 0x20)]);
  const binChunk = Buffer.concat([bin, Buffer.alloc(pad(bin.length), 0)]);
  const out = Buffer.alloc(12 + 8 + jsonChunk.length + 8 + binChunk.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(out, 20);
  const at = 20 + jsonChunk.length;
  out.writeUInt32LE(binChunk.length, at);
  out.writeUInt32LE(0x004e4942, at + 4);
  binChunk.copy(out, at + 8);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

function level(objects: WorldObject[], spawn = { x: 0, z: 30 }): World {
  return { ...sunCrystalValley(), objects, player: { ...sunCrystalValley().player, spawn } };
}
function camera(at: Vector3, look = new Vector3()) {
  const c = new PerspectiveCamera(50, 16 / 9, 0.1, 5000);
  c.position.copy(at);
  c.lookAt(look);
  c.updateMatrixWorld();
  return c;
}

describe("3D level view", () => {
  it("draws an imported model from its file and clicks it by its real size", async () => {
    const glb = boxGlb(2, 1.5, 3);
    const gltf = await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, "");
    const m = new LevelModel();
    const crate: WorldObject = { id: "crate", type: "model", x: 10, z: 5, rotation: 0, scale: 2, asset: "assets/models/test_crate.glb", collide: true };
    MODEL_BOUNDS.delete(crate.asset);
    m.sync(level([crate]), null);
    // No way to read files here (as in the browser preview): a placeholder box stands in, with the reason.
    expect(m.modelErrors.get(crate.asset)).toMatch(/desktop app/);
    expect(bounds(m, "crate").max.y).toBeCloseTo(2, 5);
    m.addLoadedModel(crate.asset, gltf.scene);
    const b = bounds(m, "crate");
    expect(b.max.y).toBeCloseTo(3, 5);
    expect(b.max.x - b.min.x).toBeCloseTo(4, 5);
    expect(pickProxy(crate)).toEqual({ kind: "box", halfX: 1, halfZ: 1.5, height: 1.5 });
    expect(m.pick(down(10, 7.5))).toMatchObject({ kind: "object", id: "crate" });
    expect(m.pick(down(10, 9))?.kind).not.toBe("object");
    m.dispose();
  });

  it("draws the ruins' Kiln models like the game: a beetle at its height, a block filling its 1.2 m and a gate scaled to its door", async () => {
    const kiln = (asset: string) => readFileSync(fileURLToPath(new URL(`../../../../../templates/exploration-3d/adventure-assets/${asset.replace(/^assets\//, "")}`, import.meta.url)), "utf8");
    const m = new LevelModel();
    const beetle: WorldObject = { id: "beetle", type: "enemy", x: 0, z: 0, rotation: 0, scale: 1, name: "Thorn beetle", kind: "beetle", health: 2, damage: 1, speed: 3, sight: 8, roam: 4, color: "#5b3d7a", model: RUINS_MODELS.beetle, height: 1.1 };
    const block: WorldObject = { id: "block", type: "crate", x: 20, z: 0, rotation: 0, scale: 1, variant: "stone", model: RUINS_MODELS.block };
    const gate: WorldObject = { id: "gate", type: "gate", x: 0, z: -30, rotation: 0, scale: 1, width: 6, model: RUINS_MODELS.gate };
    for (const o of [beetle, block, gate]) MODEL_BOUNDS.delete((o as { model: string }).model);
    m.sync(level([beetle, block, gate]), null);
    // Until the files load (always, in the browser preview): the built-in shapes.
    expect(bounds(m, "block").max.y).toBeCloseTo(1.2, 5);
    for (const asset of [RUINS_MODELS.beetle, RUINS_MODELS.block, RUINS_MODELS.gate]) {
      const gltf = await new GLTFLoader().parseAsync(gltfToGlb(kiln(asset)), "");
      m.addLoadedModel(asset, gltf.scene, gltf.animations);
    }
    // The beetle brings its own Idle and Walk; the view plays Idle, as the game does when it stands.
    expect(m.clipNames(RUINS_MODELS.beetle)).toEqual(["Idle", "Walk"]);
    expect(m.playing()).toEqual({ beetle: "Idle" });
    const b = bounds(m, "beetle");
    expect(b.max.y - b.min.y).toBeCloseTo(1.1, 3);
    expect(b.min.y).toBeCloseTo(0, 3);
    // Turned to walk north (-Z): its mandibles point north.
    expect(-b.min.z).toBeGreaterThan(b.max.z);
    const k = bounds(m, "block");
    expect([k.max.x - k.min.x, k.max.y - k.min.y, k.max.z - k.min.z].map((v) => Math.round(v * 1000) / 1000)).toEqual([1.2, 1.2, 1.2]);
    expect(k.min.y).toBeCloseTo(0, 5);
    // The gate's door is as wide as the gate, and its door parts are the ones the game sinks.
    m.group("gate")!.updateMatrixWorld(true);
    const doors = doorParts(m.group("gate")!);
    expect(doors.map((d) => d.name).sort()).toEqual(["Mesh_DoorBacking", "Mesh_DoorBandLow", "Mesh_DoorPlank1", "Mesh_DoorSun"]);
    const door = new Box3();
    for (const d of doors) door.union(new Box3().setFromObject(d));
    expect(door.max.x - door.min.x).toBeCloseTo(6, 3);
    expect(bounds(m, "gate").min.y).toBeCloseTo(0, 5);
    // Each one stands inside the shape used for clicking it.
    for (const o of [beetle, block, gate]) {
      const box = bounds(m, o.id);
      const p = pickProxy(o);
      if (p.kind === "box") {
        expect(Math.max(box.max.x - o.x, o.x - box.min.x), o.id).toBeLessThanOrEqual(p.halfX + 1e-6);
        expect(Math.max(box.max.z - o.z, o.z - box.min.z), o.id).toBeLessThanOrEqual(p.halfZ + 1e-6);
      } else if (p.kind === "cylinder") {
        expect(Math.max(box.max.x - o.x, o.x - box.min.x, box.max.z - o.z, o.z - box.min.z), o.id).toBeLessThanOrEqual(p.radius + 1e-6);
      }
      if (p.kind !== "disc") expect(box.max.y, o.id).toBeLessThanOrEqual(p.height + 1e-6);
    }
    m.dispose();
  });

  it("draws the player's character and villagers from a model, each animating its own skeleton", async () => {
    const glb = characterGlb();
    const gltf = await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, "");
    const asset = "assets/characters/tester.glb";
    const m = new LevelModel();
    const world = level([
      { id: "elder", type: "npc", x: 4, z: 24, rotation: 0, scale: 1, name: "Elder", color: "#c8873a", model: asset, height: 1.2 },
      { id: "dancer", type: "model", x: 10, z: 12, rotation: 0, scale: 1, asset, collide: false, animation: "walk" },
    ]);
    world.player = { ...world.player, character: { asset, height: 2.4, turn: 180 } };
    m.sync(world, null);
    // Before the file is available: the capsule stands at the start and villagers keep their figure.
    expect(m.playing()).toEqual({});
    m.addLoadedModel(asset, gltf.scene, gltf.animations);
    expect(m.playing()).toEqual({ [SPAWN_ID]: "Idle", elder: "Idle", dancer: "Walk" });
    expect(m.clipNames(asset)).toEqual(["Idle", "Walk", "Run", "Jump"]);
    // Fitted to their heights, standing on the ground.
    const spawnBox = new Box3().setFromObject(m.group(SPAWN_ID)!.getObjectByName("body")!);
    expect(spawnBox.max.y).toBeCloseTo(2.4, 1);
    expect(spawnBox.min.y).toBeCloseTo(0, 2);
    expect(bounds(m, "elder").max.y).toBeCloseTo(1.2, 1);
    expect(pickProxy(world.objects[0]!)).toEqual({ kind: "cylinder", radius: 0.45, height: 1.3 });
    // Each copy has its own bones: playing moves the copies' chests, never the loaded original's.
    m.tick(0.5);
    const chest = (root: Object3D | null | undefined) => root?.getObjectByName("Chest")?.quaternion.x ?? 0;
    expect(chest(m.group("dancer"))).toBeGreaterThan(0.1);
    expect(chest(m.group(SPAWN_ID))).toBeGreaterThan(0.03);
    expect(chest(gltf.scene)).toBe(0);
    // Changing the animation or removing the villager updates what plays.
    m.sync({ ...world, objects: [{ ...world.objects[1]!, animation: "Run" } as WorldObject] }, null);
    expect(m.playing()).toEqual({ [SPAWN_ID]: "Idle", dancer: "Run" });
    m.dispose();
  });

  it("puts a texture set on an object's plain parts, keeping glowing parts and tinting when asked", async () => {
    const m = new LevelModel();
    m.modelUrl = (a) => `test://${a}`;
    const loads: string[] = [];
    m.textureLoader = async (url) => {
      loads.push(url);
      return new DataTexture(new Uint8Array([200, 150, 100, 255]), 1, 1);
    };
    const gate: WorldObject = { id: "gate_main", type: "gate", x: 0, z: 0, rotation: 0, scale: 1, width: 6, material: { albedo: "assets/textures/wood_diff_1k.jpg", tile: 1, tint: true } };
    const rock: WorldObject = { id: "rock_1", type: "rock", x: 5, z: 0, rotation: 0, scale: 1, material: { albedo: "assets/textures/wood_diff_1k.jpg", tile: 0.5, tint: false } };
    m.sync(level([gate, rock]), null);
    await new Promise((r) => setTimeout(r, 0));
    expect(loads).toEqual(["test://assets/textures/wood_diff_1k.jpg"]); // loaded once, shared
    expect(Object.fromEntries(m.textured)).toEqual({ gate_main: 4, rock_1: 1 });
    const parts: { map: boolean; color: string; glow: boolean }[] = [];
    m.group("gate_main")!.traverse((o) => {
      if (o instanceof Mesh) {
        const mat = o.material as MeshStandardMaterial;
        parts.push({ map: Boolean(mat.map), color: `#${mat.color.getHexString()}`, glow: mat.emissiveIntensity > 0 && mat.emissive.getHex() > 0 });
      }
    });
    // Pillars and lintel keep the stone colour over the texture, the door its wood; the brass disc still glows untextured.
    expect(parts.filter((p) => p.map).map((p) => p.color).sort()).toEqual(["#6b4a2a", "#b9a27a", "#b9a27a", "#b9a27a"]);
    expect(parts.filter((p) => !p.map)).toEqual([{ map: false, color: "#f2b84b", glow: true }]);
    // Untinted, the rock shows the texture's own colours; both use the world-space projection.
    let rockMat: MeshStandardMaterial | null = null;
    m.group("rock_1")!.traverse((o) => {
      if (o instanceof Mesh) rockMat = o.material as MeshStandardMaterial;
    });
    expect(`#${rockMat!.color.getHexString()}`).toBe("#ffffff");
    expect(rockMat!.customProgramCacheKey()).toBe("triplanar|2");
    m.dispose();
  });

  it("rebuilds a model in a new view even when an earlier view already measured it", async () => {
    const glb = boxGlb();
    const gltf = await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, "");
    const crate: WorldObject = { id: "crate", type: "model", x: 0, z: 0, rotation: 0, scale: 1, asset: "assets/models/again.glb", collide: true };
    const first = new LevelModel();
    first.sync(level([crate]), null);
    first.addLoadedModel(crate.asset, gltf.scene);
    first.dispose();
    const second = new LevelModel();
    second.sync(level([crate]), null);
    const materials = () => {
      const out: string[] = [];
      second.group("crate")!.traverse((o) => o instanceof Mesh && out.push((o.material as { type: string }).type));
      return out;
    };
    expect(materials()).toEqual(["MeshBasicMaterial"]); // the placeholder, sized from the earlier measurement
    second.addLoadedModel(crate.asset, gltf.scene);
    expect(materials()).toEqual(["MeshStandardMaterial"]); // the model itself
    second.dispose();
  });

  it("matches animation names and suggests character heights like the game", () => {
    const names = ["Dance", "Idle", "Walking", "Running", "Jump", "WalkJump"];
    expect(pickClip(names, "walking")).toBe("Walking");
    expect(pickClip(["Armature|Idle"], "Idle")).toBe("Armature|Idle");
    expect(pickClip(names, undefined, "run")).toBe("Running");
    expect(pickClip(names, "Swim")).toBeUndefined();
    expect(suggestedHeight(1.75)).toBe(1.75);
    expect(suggestedHeight(79.03)).toBe(0.79);
    expect(suggestedHeight(5.08)).toBe(1.8);
  });

  it("finds a model's own files next to it and never outside the assets folder", () => {
    expect(siblingAsset("assets/models/Chair/Chair_1k.gltf", "Chair.bin")).toBe("assets/models/Chair/Chair.bin");
    expect(siblingAsset("assets/models/Chair/Chair_1k.gltf", "textures/Chair%20diff_1k.jpg")).toBe("assets/models/Chair/textures/Chair diff_1k.jpg");
    expect(siblingAsset("assets/models/Chair/Chair_1k.gltf", "../shared/wood.jpg")).toBe("assets/models/shared/wood.jpg");
    expect(siblingAsset("assets/models/Chair/Chair_1k.gltf", "../../../secret.txt")).toBeNull();
    expect(siblingAsset("assets/models/a.gltf", "/etc/passwd")).toBeNull();
    expect(siblingAsset("assets/models/a.gltf", "https://example.com/x.png")).toBeNull();
    expect(siblingAsset("assets/models/a.gltf", "%E0%A4%A")).toBeNull();
  });

  it("lights the level from the same direction as the Godot sun", () => {
    // Godot: Sun.rotation_degrees = (-elevation, heading, 0), Euler order YXZ, light travelling along its -Z.
    for (const [elev, head] of [[48, 35], [10, 200], [90, 0]] as const) {
      const travel = new Vector3(0, 0, -1).applyEuler(new Euler(-elev * DEG, head * DEG, 0, "YXZ"));
      const towardsSun = sunDirection(elev, head);
      expect(towardsSun.distanceTo(travel.negate())).toBeLessThan(1e-9);
    }
  });

  it("turns objects clockwise seen from above, like the map and the game", () => {
    expect(bearing(0, 0, 0, -5)).toBeCloseTo(0);
    expect(bearing(0, 0, 5, 0)).toBeCloseTo(90);
    expect(bearing(0, 0, 0, 5)).toBeCloseTo(180);
    expect(normalizeRotation(bearing(0, 0, -5, 0))).toBe(270);
    expect(normalizeRotation(370)).toBe(10);
    expect(normalizeRotation(-15)).toBe(345);
    expect(normalizeRotation(359.999)).toBe(0);

    const m = new LevelModel();
    m.sync(level([{ id: "gate_a", type: "gate", x: 4, z: -2, rotation: 90, scale: 2, width: 5 }]), null);
    const g = m.group("gate_a")!;
    expect(g.position.toArray()).toEqual([4, 0, -2]);
    expect(g.rotation.y).toBeCloseTo(-Math.PI / 2);
    expect(g.scale.x).toBe(2);
    // Turned 90° clockwise, a gate that spans east-west now spans north-south.
    const b = bounds(m, "gate_a");
    expect(b.max.z - b.min.z).toBeCloseTo((5 + 1.8) * 2, 5);
    expect(b.max.x - b.min.x).toBeCloseTo(1.0 * 2, 5);
  });

  it("builds every object at Godot's sizes, inside the shape used for clicking", () => {
    const m = new LevelModel();
    const objects: WorldObject[] = OBJECT_TYPES.filter((t) => t !== "model").map((t, i) => OBJECT_DEFAULTS[t](`${t}_1`, i * 20 - 80, 0));
    objects.push({ id: "tall_1", type: "tree", x: 0, z: 20, rotation: 0, scale: 1, variant: "tall" }, { id: "baobab_1", type: "tree", x: 20, z: 20, rotation: 0, scale: 1, variant: "baobab" });
    m.sync(level(objects), null);
    const heights: Record<string, number> = { tree_1: 4.6, tall_1: 5.8, baobab_1: 4.9, rock_1: 1.05, npc_1: 2.01, gate_1: 5.1, sign_1: 1.925, torch_1: 2.13, enemy_1: 1.031, crate_1: 1.2 };
    for (const o of objects) {
      const b = bounds(m, o.id);
      const p = pickProxy(o);
      const reach = Math.max(b.max.x - o.x, o.x - b.min.x, b.max.z - o.z, o.z - b.min.z);
      if (p.kind === "box") {
        expect(b.max.x - o.x, o.id).toBeLessThanOrEqual(p.halfX + 1e-6);
        expect(b.max.z - o.z, o.id).toBeLessThanOrEqual(p.halfZ + 1e-6);
      } else {
        expect(reach, o.id).toBeLessThanOrEqual(p.radius + 1e-6);
      }
      if (p.kind !== "disc") expect(b.max.y, o.id).toBeLessThanOrEqual(p.height + 1e-6);
      if (heights[o.id] !== undefined) expect(b.max.y, o.id).toBeCloseTo(heights[o.id]!, 2);
    }
  });

  it("rebuilds an object only when its shape changes, and drops removed objects", () => {
    const m = new LevelModel();
    const w = sunCrystalValley();
    m.sync(w, null);
    const tree = m.group("tree_1");
    expect(tree).not.toBeNull();
    const moved = { ...w, objects: w.objects.map((o) => (o.id === "tree_1" ? { ...o, x: 5 } : o)) };
    m.sync(moved, null);
    expect(m.group("tree_1")).toBe(tree);
    expect(m.group("tree_1")!.position.x).toBe(5);
    const reshaped = { ...moved, objects: moved.objects.map((o): WorldObject => (o.id === "tree_1" && o.type === "tree" ? { ...o, variant: "tall" as const } : o)) };
    m.sync(reshaped, null);
    expect(m.group("tree_1")).not.toBe(tree);
    m.sync({ ...reshaped, objects: reshaped.objects.filter((o) => o.id !== "tree_1") }, null);
    expect(m.group("tree_1")).toBeNull();
    expect(m.scene.getObjectByName("objects")!.children).toHaveLength(w.objects.length - 1);
  });

  it("picks the nearest thing under the pointer", () => {
    const m = new LevelModel();
    const rock: WorldObject = { id: "rock_a", type: "rock", x: 0, z: 0, rotation: 0, scale: 1 };
    const lake: WorldObject = { id: "lake", type: "water", x: 10, z: 0, rotation: 0, scale: 1, radius: 6 };
    const tree: WorldObject = { id: "tree_a", type: "tree", x: 10, z: 2, rotation: 0, scale: 1, variant: "round" };
    m.sync(level([rock, lake, tree], { x: -10, z: 0 }), null);
    expect(m.pick(down(0.5, 0.5))).toMatchObject({ kind: "object", id: "rock_a" });
    expect(m.pick(down(5, 0))).toMatchObject({ kind: "object", id: "lake" });
    expect(m.pick(down(10, 2))).toMatchObject({ kind: "object", id: "tree_a" }); // the tree stands in the lake
    expect(m.pick(down(-10, 0.3))).toMatchObject({ kind: "spawn" });
    expect(m.pick(down(-30, -30))).toBeNull();
    // From an angle: the tree's canopy hides the lake behind it.
    const ray = new Ray(new Vector3(10, 4, 30), new Vector3(0, -0.02, -1).normalize());
    expect(m.pick(ray)).toMatchObject({ kind: "object", id: "tree_a" });
  });

  it("offers the selected object's ring for turning, unless something stands in front of it", () => {
    const m = new LevelModel();
    const npc: WorldObject = { id: "elder", type: "npc", x: 10, z: 0, rotation: 0, scale: 1, name: "Elder", color: "#c8873a" };
    m.sync(level([npc]), "elder");
    const r = ringRadius(npc);
    expect(m.pick(down(10 + r, 0))).toMatchObject({ kind: "ring", id: "elder" });
    expect(m.pick(down(10 + r + 1, 0))).toBeNull();
    // A ray through the elder's chest whose ground point lies on the ring takes the elder, which is in front.
    const chest = new Vector3(10, 1.2, 0);
    const behind = new Vector3(10, RING_Y, -r);
    const dir = behind.clone().sub(chest).normalize();
    expect(m.pick(new Ray(chest.clone().addScaledVector(dir, -20), dir))).toMatchObject({ kind: "object", id: "elder" });
    m.sync(level([npc]), null);
    expect(m.pick(down(10 + r, 0))).toBeNull();
  });

  it("clicks a turned gate where it is drawn, not where its mirror image would be", () => {
    const m = new LevelModel();
    const gate: WorldObject = { id: "gate_a", type: "gate", x: 0, z: 0, rotation: 45, scale: 1, width: 5 };
    m.sync(level([gate]), null);
    const s = 3 * Math.SQRT1_2;
    const meshes: Mesh[] = [];
    m.group("gate_a")!.traverse((o) => o instanceof Mesh && meshes.push(o));
    m.group("gate_a")!.updateMatrixWorld(true);
    for (const [x, z, hit] of [[s, s, true], [s, -s, false], [-s, -s, true]] as const) {
      expect(intersectObject(down(x, z), gate) !== null, `${x},${z}`).toBe(hit);
      const rc = new Raycaster(new Vector3(x, 50, z), new Vector3(0, -1, 0));
      expect(rc.intersectObjects(meshes).length > 0, `mesh ${x},${z}`).toBe(hit);
    }
  });

  it("frames the whole level, keeps the angle when focusing and limits zoom", () => {
    const m = new LevelModel(camera(new Vector3(0, 10, 10)));
    const w = sunCrystalValley();
    m.sync(w, null);
    m.fit();
    m.camera.updateMatrixWorld();
    for (const [x, z] of [[-45, -45], [45, -45], [-45, 45], [45, 45]]) {
      const p = new Vector3(x, 0, z).project(m.camera);
      expect(Math.abs(p.x), `${x},${z}`).toBeLessThanOrEqual(1);
      expect(Math.abs(p.y), `${x},${z}`).toBeLessThanOrEqual(1);
    }
    // Close enough to work with: the 90 m valley fills most of the view.
    const fitted = m.camera.position.distanceTo(m.target);
    expect(fitted).toBeGreaterThan(60);
    expect(fitted).toBeLessThan(160);
    const offset = m.camera.position.clone().sub(m.target);
    m.focus(10, -5);
    expect(m.target.toArray()).toEqual([10, 0, -5]);
    expect(m.camera.position.clone().sub(m.target).distanceTo(offset)).toBeLessThan(1e-9);
    m.zoom(0.001);
    expect(m.camera.position.distanceTo(m.target)).toBeCloseTo(2);
    m.zoom(1e6, 2, 300);
    expect(m.camera.position.distanceTo(m.target)).toBeCloseTo(300);
  });

  it("previews fog the way Godot draws it, over the sky as much as it is thick, only when asked", () => {
    // Godot: fog = 1 - exp(-density * distance). three.js would square the exponent.
    expect(ShaderChunk.fog_fragment).toContain("1.0 - exp( - fogDensity * vFogDepth )");
    expect(ShaderChunk.fog_fragment).not.toContain("fogDensity * fogDensity");
    const m = new LevelModel();
    const w = sunCrystalValley();
    m.sync(w, null);
    const sky = (m.scene.getObjectByName("sky") as Mesh).material as ShaderMaterial;
    expect(m.scene.fog).toBeNull();
    expect(sky.uniforms["fogAmount"]!.value).toBe(0);
    m.setOptions({ grid: true, fog: true });
    expect(m.scene.fog).toBeInstanceOf(FogExp2);
    expect((m.scene.fog as FogExp2).density).toBe(w.environment.fogDensity);
    // world_builder.gd: fog_sky_affect = density * 12 (0.096 for the valley's 0.008), not Godot's default 1.
    expect(sky.uniforms["fogAmount"]!.value).toBeCloseTo(skyFog(w.environment.fogDensity), 6);
    expect(skyFog(0.008)).toBeCloseTo(0.096, 6);
    expect(skyFog(0.1)).toBe(1);
    m.sync({ ...w, environment: { ...w.environment, fogDensity: 0 } }, null);
    expect(m.scene.fog).toBeNull();
    expect(sky.uniforms["fogAmount"]!.value).toBe(0);
  });

  it("draws the game's sky (clouds, sunlight colour), ground patches and grass from the level's settings", () => {
    const m = new LevelModel();
    const w = sunCrystalValley();
    m.sync(w, null);
    const sky = (m.scene.getObjectByName("sky") as Mesh).material as ShaderMaterial;
    expect(sky.uniforms["clouds"]!.value).toBe(0.45);
    expect(`#${(sky.uniforms["sunColor"]!.value as Color).getHexString()}`).toBe("#fff2dc");
    expect(`#${m.sun.color.getHexString()}`).toBe("#fff2dc");
    // The grass is the game's: the same tufts in the same places (grass.gd, place_tufts).
    const tufts = placeTufts(w.size.width, w.size.depth, 0.75, 0.7, grassKeepOut(w));
    expect(tufts.length).toBeGreaterThan(5000);
    expect(m.grassCount()).toBe(tufts.length);
    const grass = m.scene.getObjectByName("grass") as InstancedMesh;
    const at = new Matrix4();
    grass.getMatrixAt(0, at);
    const p = new Vector3().setFromMatrixPosition(at);
    expect(p.x).toBeCloseTo(tufts[0]![0], 5);
    expect(p.z).toBeCloseTo(tufts[0]![1], 5);
    // None in the lake or the visible zone; none at the very edge.
    for (const [kx, kz, r] of grassKeepOut(w)) expect(tufts.some(([x, z]) => Math.hypot(x - kx, z - kz) < r)).toBe(false);
    expect(tufts.every(([x, z]) => Math.abs(x) <= w.size.width / 2 - 0.5 && Math.abs(z) <= w.size.depth / 2 - 0.5)).toBe(true);
    // Moving the lake moves the clear patch; no grass setting, no grass.
    const lake = w.objects.find((o) => o.type === "water")!;
    m.sync({ ...w, objects: w.objects.map((o) => (o.id === lake.id ? { ...o, x: o.x + 10 } : o)) }, null);
    expect(m.grassCount()).not.toBe(tufts.length);
    const { grass: _g, ...bare } = w.environment;
    m.sync({ ...w, environment: bare }, null);
    expect(m.grassCount()).toBe(0);
    expect(m.scene.getObjectByName("grass")).toBeUndefined();
  });

  it("draws the anime style with toon materials outlined for the plain parts only, and puts the standard ones back", () => {
    const m = new LevelModel();
    const torch: WorldObject = { id: "torch_a", type: "torch", x: 5, z: 0, rotation: 0, scale: 1 };
    const pool: WorldObject = { id: "pool_a", type: "water", x: -8, z: 0, rotation: 0, scale: 1, radius: 3 };
    const w = level([OBJECT_DEFAULTS.tree("tree_a", 0, 0), torch, pool]);
    const kinds = () => {
      const out: Record<string, string[]> = {};
      for (const id of ["tree_a", "torch_a", "pool_a"]) {
        const g = m.scene.getObjectByName(id)!;
        const list: string[] = [];
        g.traverse((o) => {
          const mesh = o as Mesh;
          if (mesh.isMesh && (mesh.material as MeshStandardMaterial).visible !== false) list.push((mesh.material as MeshStandardMaterial).type);
        });
        out[id] = [...new Set(list)].sort();
      }
      return out;
    };
    m.sync({ ...w, environment: { ...w.environment, style: "anime" } }, null);
    m.beforeRender();
    const anime = kinds();
    // The tree's trunk and crown are toon materials; the torch's flame keeps its glow; the water stays see-through.
    expect(anime["tree_a"]).toEqual(["MeshToonMaterial"]);
    expect(anime["torch_a"]).toContain("MeshToonMaterial");
    expect(anime["torch_a"]).toContain("MeshStandardMaterial");
    expect(anime["pool_a"]).not.toContain("MeshToonMaterial");
    const sky = (m.scene.getObjectByName("sky") as Mesh).material as ShaderMaterial;
    expect(sky.uniforms["anime"]!.value).toBe(1);
    expect(m.anime()).toBe(true);
    m.sync(w, null);
    m.beforeRender();
    expect(kinds()["tree_a"]).toEqual(["MeshStandardMaterial"]);
    expect(sky.uniforms["anime"]!.value).toBe(0);
  });

  it("draws trees and rocks in detail in the realistic style, as the game's nature.gd builds them, and simply otherwise", async () => {
    const m = new LevelModel();
    m.modelUrl = (a) => `test://${a}`;
    const loads: string[] = [];
    m.textureLoader = async (url) => {
      loads.push(url.slice(0, 22));
      return new DataTexture(new Uint8Array([60, 120, 50, 255]), 1, 1);
    };
    const pine = { ...OBJECT_DEFAULTS.tree("pine_a", 4, 0), variant: "tall" } as WorldObject;
    const rock = { ...OBJECT_DEFAULTS.rock("rock_a", -4, 0), material: { albedo: "assets/textures/wood_diff_1k.jpg", tile: 1, tint: true } } as WorldObject;
    const w = level([OBJECT_DEFAULTS.tree("tree_a", 0, 0), pine, rock]);
    m.sync({ ...w, environment: { ...w.environment, style: "realistic" } }, null);
    await new Promise((r) => setTimeout(r, 0));
    for (const [id, kind] of [["tree_a", "round"], ["pine_a", "tall"], ["rock_a", "rock"]] as const) {
      const holder = m.group(id)!.getObjectByName("Nature")!;
      expect(holder.rotation.y).toBeCloseTo(turnOf(id), 10);
      const meshes = holder.children as Mesh[];
      const want = natureMeshes(kind, variantOf(id));
      expect(meshes.map((x) => x.name)).toEqual(kind === "rock" ? ["Rock"] : ["Bark", "Leaves"]);
      meshes.forEach((mesh, k) => {
        const position = mesh.geometry.getAttribute("position");
        expect(position.count).toBe(want[k]!.positions.length / 3);
        expect(position.getY(7)).toBeCloseTo(want[k]!.positions[7 * 3 + 1]!, 5);
        // The shapes carry screen colours; three.js gets them in linear light.
        expect(mesh.geometry.getAttribute("color").getX(7)).toBeCloseTo(toLinear(want[k]!.colors[7 * 3]!), 5);
        expect(mesh.castShadow).toBe(true);
      });
    }
    // The leaves show the picture in leaf_atlas.gd once it loads, cut out where it is clear, read top row first as Godot does.
    expect(loads.filter((u) => u === "data:image/png;base64,")).toHaveLength(1);
    const leaves = (m.group("tree_a")!.getObjectByName("Leaves") as Mesh).material as MeshStandardMaterial;
    expect(leaves.visible).toBe(true);
    expect(leaves.map).not.toBeNull();
    expect(leaves.map!.flipY).toBe(false);
    expect(leaves.alphaTest).toBe(0.4);
    // A tinted texture set goes on the rock's stone and keeps its colours.
    expect(m.textured.get("rock_a")).toBe(1);
    const stone = (m.group("rock_a")!.getObjectByName("Rock") as Mesh).material as MeshStandardMaterial;
    expect(stone.map).not.toBeNull();
    expect(stone.vertexColors).toBe(true);
    // Back to the standard style: the simple shapes again.
    m.sync(w, null);
    expect(m.group("tree_a")!.getObjectByName("Nature")).toBeUndefined();
    expect(m.group("rock_a")!.getObjectByName("Nature")).toBeUndefined();
    m.dispose();
  });

  it("reads the leaf picture from the template's leaf_atlas.gd: a 512 by 256 PNG", () => {
    const png = Buffer.from(LEAF_ATLAS_URL.slice("data:image/png;base64,".length), "base64");
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([512, 256]);
  });

  it("places grass the same way every time, thicker where the ground is lush, and never more than 40,000 cells' worth", () => {
    expect(hash01(0, 0, 1)).toBe(hash01(0, 0, 1));
    expect(hash01(3, 7, 2)).not.toBe(hash01(7, 3, 2));
    for (const [i, j, s] of [[0, 0, 0], [12, 99, 5], [-4, 17, 3], [400, 400, 4]] as const) {
      const h = hash01(i, j, s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
    expect(patches(10, -20)).toBe(patches(10, -20));
    expect(grassCellSize(1, 90, 90)).toBeCloseTo(0.55, 6);
    expect(grassCellSize(0, 90, 90)).toBeCloseTo(1.6, 6);
    expect(grassCellSize(1, 400, 400)).toBeCloseTo(2, 6);
    const a = placeTufts(60, 60, 0.8, 1, []);
    expect(placeTufts(60, 60, 0.8, 1, [])).toEqual(a);
    expect(placeTufts(60, 60, 0, 1, [])).toEqual([]);
    // Dry patches (patches near 1) keep fewer tufts than lush ones.
    const dry = a.filter(([x, z]) => patches(x, z) > 0.65).length / Math.max(1, a.length);
    const lush = a.filter(([x, z]) => patches(x, z) < 0.35).length / Math.max(1, a.length);
    const cellsDry = placeTufts(60, 60, 0.8, 0, []).filter(([x, z]) => patches(x, z) > 0.65).length;
    expect(dry * a.length).toBeLessThan(cellsDry);
    expect(lush).toBeGreaterThan(0);
  });

  it("lights torches and crystals with point lights set up like the game's OmniLight3D", () => {
    const torch: WorldObject = { id: "torch_a", type: "torch", x: 5, z: 0, rotation: 0, scale: 1 };
    const crystal: WorldObject = { ...OBJECT_DEFAULTS.collectible("crystal_a", -3, 4), scale: 2 };
    const m = new LevelModel();
    m.sync(level([torch, crystal, OBJECT_DEFAULTS.tree("tree_a", 0, 0)]), null);
    const lights = m.activeLights();
    expect(lights).toHaveLength(2);
    const t = lights.find((l) => l.x === 5)!;
    // world_builder.gd _torch: OmniLight3D at 2 m, #ffb46b, energy 1.4, range 7, default attenuation 1.
    expect([t.x, t.y, t.z]).toEqual([5, 2, 0]);
    expect(t.color).toBe(`#${new Color("#ffb46b").getHexString()}`);
    expect(t.intensity).toBeCloseTo(1.4 * SUN_INTENSITY);
    expect([t.distance, t.decay]).toEqual([7, 1]);
    // _collectible: the light sits in the crystal at 1.1 m, so it rises with the object's scale; range stays.
    const c = lights.find((l) => l.x === -3)!;
    expect([c.x, c.y, c.z]).toEqual([-3, 2.2, 4]);
    expect(c.intensity).toBeCloseTo(0.8 * SUN_INTENSITY);
    expect(c.distance).toBe(3.5);
    expect(lightOf(OBJECT_DEFAULTS.tree("x", 0, 0))).toBeNull();
    // Spare lights stay dark so the shader count changes only in steps of 8.
    expect(m.lightPoolSize()).toBe(8);
    // three.js falls off like Godot's get_omni_attenuation: (1 - (d/range)^4)^2 / d^attenuation.
    expect(ShaderChunk.lights_pars_begin).toContain("pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) )");
    expect(ShaderChunk.lights_pars_begin).toContain("1.0 / max( pow( lightDistance, decayExponent ), 0.01 )");

    // A dragged torch takes its light along before the drag is committed.
    m.preview("torch_a", { x: 9, z: 1 });
    m.beforeRender();
    expect(m.activeLights().some((l) => l.x === 9 && l.z === 1 && l.y === 2)).toBe(true);

    // More emitters than lights: the ones nearest the camera's focus are lit.
    const row = Array.from({ length: 40 }, (_, i): WorldObject => ({ id: `torch_${i}`, type: "torch", x: -95 + i * 5, z: 0, rotation: 0, scale: 1 }));
    m.sync(level(row), null);
    expect(m.lightPoolSize()).toBe(MAX_LIGHTS);
    m.focus(-95, 0);
    m.beforeRender();
    const lit = m.activeLights().map((l) => l.x);
    expect(lit).toHaveLength(MAX_LIGHTS);
    expect(Math.max(...lit)).toBe(-95 + 31 * 5);
    m.sync(level([]), null);
    expect(m.lightPoolSize()).toBe(0);
  });

  it("frees its geometry and materials", () => {
    const m = new LevelModel();
    m.sync(sunCrystalValley(), "elder");
    let disposed = 0;
    m.scene.traverse((o) => {
      if (o instanceof Mesh) o.geometry.addEventListener("dispose", () => disposed++);
    });
    m.dispose();
    expect(disposed).toBeGreaterThan(10);
  });
});
