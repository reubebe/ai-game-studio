import { z } from "zod";
import { SOUNDS } from "./domain";

/**
 * Engine-neutral layout of an exploration level. The Godot template's world_builder.gd
 * reads this file (synced to res://gamestudio_data/world.json) and builds the scene.
 * Coordinates are metres on the ground plane: x to the right (east), z towards the
 * viewer (south), with the origin at the centre of the map.
 */
export const WORLD_SCHEMA_VERSION = "1.0.0";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a #rrggbb colour");
const objectId = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, "Use lowercase letters, digits and underscores");

export const OBJECT_TYPES = ["tree", "rock", "collectible", "npc", "enemy", "crate", "gate", "zone", "water", "sign", "torch", "model"] as const;
export type WorldObjectType = (typeof OBJECT_TYPES)[number];
/**
 * Objects only the Godot game builds (the Unity and Unreal valleys skip them): imported models, and
 * the adventure pieces (enemies that fight back and blocks the player pushes).
 */
export const GODOT_ONLY_TYPES = ["enemy", "crate", "model"] as const satisfies readonly WorldObjectType[];
/** Environment settings only the Godot game draws (its sky shader, ground shader and grass); Unity and Unreal games leave them out. */
export const GODOT_ONLY_ENVIRONMENT = ["clouds", "groundVariation", "grass", "style", "skyImage", "skyBrightness"] as const;

const base = {
  id: objectId,
  x: z.number().finite(),
  z: z.number().finite(),
  rotation: z.number().finite().min(-360).max(360).default(0),
  scale: z.number().finite().min(0.2).max(5).default(1),
};

/**
 * A file in the engine project's assets folder (res://assets/... in Godot). Relative, forward
 * slashes, no "..", so a layout can never point outside the project.
 */
/** glTF models, and VRM characters (glTF with a humanoid skeleton and toon materials, as VRoid Studio makes them). */
export const MODEL_EXTENSIONS = ["glb", "gltf", "vrm"] as const;
export const TEXTURE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;
const assetPath = (extensions: readonly string[]) =>
  z
    .string()
    .max(200)
    .regex(new RegExp(`^assets/(?:[A-Za-z0-9_][A-Za-z0-9_ .-]*/)*[A-Za-z0-9_][A-Za-z0-9_ .-]*\\.(?:${extensions.join("|")})$`, "i"), `Choose a .${extensions.join(", .")} file in the project's assets folder`)
    .refine((p) => !p.split("/").some((part) => part === "." || part === ".."), "Paths cannot contain . or ..");
export const modelAssetPath = assetPath(MODEL_EXTENSIONS);
export const textureAssetPath = assetPath(TEXTURE_EXTENSIONS);
export const AUDIO_EXTENSIONS = ["ogg", "wav", "mp3"] as const;
export const audioAssetPath = assetPath(AUDIO_EXTENSIONS);
/** A photographed sky: a Radiance .hdr panorama (the free library's Skies). */
export const SKY_EXTENSIONS = ["hdr"] as const;
export const skyAssetPath = assetPath(SKY_EXTENSIONS);

/**
 * A level's sound: background music (looping, at `volume`) and imported files that replace the
 * template's built-in sounds by name (rules keep naming the built-in sounds, so they still work in
 * every engine). Godot plays these; Unity and Unreal keep their generated sounds.
 */
export function levelAudioSchema<const T extends readonly [string, ...string[]]>(sounds: T) {
  return z
    .object({
      music: z.object({ asset: audioAssetPath, volume: z.number().min(0).max(1).default(0.6) }).strict().optional(),
      sounds: z.partialRecord(z.enum(sounds), audioAssetPath).optional(),
    })
    .strict();
}
export const worldAudioSchema = levelAudioSchema(SOUNDS);

/**
 * A texture set on a built-in object: a colour map with optional normal and roughness maps,
 * projected from the three axes in world space and repeated every `tile` metres, so it fits any
 * shape. With `tint`, each part keeps its own colour multiplied over the texture.
 */
export const objectMaterialSchema = z
  .object({
    albedo: textureAssetPath,
    normal: textureAssetPath.optional(),
    roughness: textureAssetPath.optional(),
    tile: z.number().min(0.1).max(20).default(1),
    tint: z.boolean().default(false),
  })
  .strict();
export type ObjectMaterial = z.infer<typeof objectMaterialSchema>;
/** Built-in objects that can take a texture set (their glowing parts keep their colour). */
export const TEXTURED_TYPES = ["tree", "rock", "crate", "gate", "sign", "torch"] as const;

/**
 * Picks the normal and roughness maps that come with a colour texture, by the naming the free
 * library (and most texture sets) use: name_diff_1k.jpg, name_nor_gl_1k.jpg, name_rough_1k.jpg.
 */
export function matchingMaps(albedo: string, textures: readonly string[]): { normal?: string; roughness?: string } {
  const m = /^(.*?)(?:_diff|_diffuse|_albedo|_basecolor|_color|_col)(_\d+k)?\.[a-z]+$/i.exec(albedo);
  const find = (words: string[]) => (m ? textures.find((t) => t !== albedo && t.startsWith(m[1]!) && words.some((w) => new RegExp(`_${w}(_\\d+k)?\\.[a-z]+$`, "i").test(t))) : undefined);
  const normal = find(["nor_gl", "normal_gl", "normal", "nor"]);
  const roughness = find(["rough", "roughness"]);
  return { ...(normal ? { normal } : {}), ...(roughness ? { roughness } : {}) };
}
/** The name of an animation inside a model file. */
const clipName = z.string().trim().min(1).max(100);
const characterHeight = z.number().finite().min(0.3).max(10);

/**
 * An imported, usually animated, character model for the player. It is scaled to `height` metres,
 * turned by `turn` degrees (glTF characters face +Z; the player faces -Z, hence 180), and plays the
 * named animations while standing, walking, running (sprinting) and in the air.
 */
export const characterSchema = z
  .object({
    asset: modelAssetPath,
    height: characterHeight.default(1.8),
    turn: z.number().finite().min(-360).max(360).default(180),
    idle: clipName.optional(),
    walk: clipName.optional(),
    run: clipName.optional(),
    jump: clipName.optional(),
  })
  .strict();
export type Character = z.infer<typeof characterSchema>;
export const CHARACTER_STATES = ["idle", "walk", "run", "jump"] as const;
export type CharacterState = (typeof CHARACTER_STATES)[number];

/**
 * A villager who answers what players type, using AI, while the game plays inside Game Studio (Play
 * here): who they are and how they talk (persona), and what they know. Exported games have no AI, so
 * the villager says its written lines (the interact rules) there.
 */
export const villagerAiSchema = z
  .object({
    persona: z.string().trim().max(600),
    knows: z.string().trim().max(1200),
  })
  .strict();
export type VillagerAi = z.infer<typeof villagerAiSchema>;

export const worldObjectSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("tree"), variant: z.enum(["round", "tall", "baobab"]).default("round"), material: objectMaterialSchema.optional() }).strict(),
  z.object({ ...base, type: z.literal("rock"), material: objectMaterialSchema.optional() }).strict(),
  z.object({ ...base, type: z.literal("collectible"), kind: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).default("crystal"), label: z.string().max(60).default("Sun crystal") }).strict(),
  // With a model, the character is drawn from that file (scaled to height, facing south at rotation 0) and loops its animation.
  z.object({ ...base, type: z.literal("npc"), name: z.string().min(1).max(60), color: color.default("#c8873a"), model: modelAssetPath.optional(), animation: clipName.optional(), height: characterHeight.optional(), ai: villagerAiSchema.optional() }).strict(),
  // A creature that wanders near its spot, chases the player within `sight` metres and costs `damage`
  // hearts on touch. The player's attack takes one of its `health` points. With a model, the creature is
  // drawn from that file (scaled to height) and walks or stands with the animations it has.
  z
    .object({
      ...base,
      type: z.literal("enemy"),
      name: z.string().min(1).max(60).default("Thorn beetle"),
      kind: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).default("beetle"),
      health: z.number().int().min(1).max(20).default(2),
      damage: z.number().int().min(1).max(10).default(1),
      speed: z.number().min(0).max(12).default(3),
      sight: z.number().min(0).max(40).default(8),
      roam: z.number().min(0).max(30).default(4),
      color: color.default("#5b3d7a"),
      model: modelAssetPath.optional(),
      height: characterHeight.optional(),
    })
    .strict(),
  // A block the player pushes by walking into it (1.2 m across at scale 1). Rules hear when one is pushed into a zone.
  // `model`: an imported model drawn in its place, fitted to the block (Godot only; the block still pushes as a box).
  z.object({ ...base, type: z.literal("crate"), variant: z.enum(["wood", "stone"]).default("wood"), material: objectMaterialSchema.optional(), model: modelAssetPath.optional() }).strict(),
  // `model`: an imported gate drawn in its place (Godot only), scaled so its door (nodes named ...Door...) is `width` wide;
  // the door sinks when the gate opens. Without a door it is scaled to `width` + 1.8 m, the built-in gate's size.
  z.object({ ...base, type: z.literal("gate"), width: z.number().min(2).max(12).default(5), material: objectMaterialSchema.optional(), model: modelAssetPath.optional() }).strict(),
  z.object({ ...base, type: z.literal("zone"), radius: z.number().min(0.5).max(30).default(3), label: z.string().max(60).default("Zone"), visible: z.boolean().default(true) }).strict(),
  z.object({ ...base, type: z.literal("water"), radius: z.number().min(1).max(40).default(6) }).strict(),
  z.object({ ...base, type: z.literal("sign"), text: z.string().min(1).max(200), material: objectMaterialSchema.optional() }).strict(),
  z.object({ ...base, type: z.literal("torch"), material: objectMaterialSchema.optional() }).strict(),
  // An imported 3D model. Models come in any unit, so their scale range is wider than the built-in objects'.
  z.object({ ...base, scale: z.number().finite().min(0.01).max(100).default(1), type: z.literal("model"), asset: modelAssetPath, collide: z.boolean().default(true), animation: clipName.optional() }).strict(),
]);
export type WorldObject = z.infer<typeof worldObjectSchema>;

export const worldSchema = z
  .object({
    schemaVersion: z.literal(WORLD_SCHEMA_VERSION),
    kind: z.literal("explore-world"),
    name: z.string().trim().min(1).max(80),
    size: z.object({ width: z.number().min(20).max(400), depth: z.number().min(20).max(400) }).strict(),
    environment: z
      .object({
        skyTop: color,
        skyHorizon: color,
        ground: color,
        sunElevation: z.number().min(5).max(90),
        sunHeading: z.number().min(0).max(360),
        fogDensity: z.number().min(0).max(0.1),
        /** The sunlight's colour (white when left out). */
        sunColor: color.optional(),
        /** Clouds in the sky, from 0 (clear) to 1 (overcast). Godot builds only (GODOT_ONLY_ENVIRONMENT). */
        clouds: z.number().min(0).max(1).optional(),
        /** Patches of drier and lusher ground, from 0 (one even colour) to 1. Godot builds only. */
        groundVariation: z.number().min(0).max(1).optional(),
        /** Tufts of grass over the ground, from 0 (none) to 1 (thick). Godot builds only. */
        grass: z.number().min(0).max(1).optional(),
        /** How everything is drawn: "standard", "anime" (toon shading, ink outlines, crisp clouds) or "realistic" (detailed trees and rocks, a filmic tone curve without the colour boost; on the desktop, light that bounces, reflections and soft shadows). Godot builds only. */
        style: z.enum(["standard", "anime", "realistic"]).optional(),
        /** A photographed sky (a .hdr panorama) that lights the level and fills the background, in place of the sky colours and clouds. Godot builds only. */
        skyImage: skyAssetPath.optional(),
        /** How bright the photographed sky is, 1 as it was photographed. */
        skyBrightness: z.number().min(0.1).max(4).optional(),
        /** "high" turns on ambient occlusion, glow, soft shadows and anti-aliasing in desktop builds (Forward+). Web builds ignore it. */
        quality: z.enum(["standard", "high"]).optional(),
        /** A tiled ground texture (colour, plus optional normal and roughness maps), repeated every `tile` metres. */
        groundMaterial: z
          .object({ albedo: textureAssetPath, normal: textureAssetPath.optional(), roughness: textureAssetPath.optional(), tile: z.number().min(0.5).max(50).default(4) })
          .strict()
          .optional(),
      })
      .strict(),
    player: z
      .object({
        spawn: z.object({ x: z.number().finite(), z: z.number().finite() }).strict(),
        speed: z.number().min(1).max(20),
        sprintMultiplier: z.number().min(1).max(3),
        jumpVelocity: z.number().min(0).max(20),
        cameraDistance: z.number().min(2).max(20),
        /** Hearts the player starts with (3 when left out). Enemies and the Hurt Player rule take them; at none the player starts again at the spawn point. */
        health: z.number().int().min(1).max(20).optional(),
        character: characterSchema.optional(),
      })
      .strict(),
    objects: z.array(worldObjectSchema).max(500),
    audio: worldAudioSchema.optional(),
  })
  .strict()
  .superRefine((world, ctx) => {
    const ids = new Set<string>();
    world.objects.forEach((o, i) => {
      if (ids.has(o.id)) ctx.addIssue({ code: "custom", path: ["objects", i, "id"], message: `Object id '${o.id}' is used twice` });
      ids.add(o.id);
      const hx = world.size.width / 2;
      const hz = world.size.depth / 2;
      if (Math.abs(o.x) > hx || Math.abs(o.z) > hz) ctx.addIssue({ code: "custom", path: ["objects", i], message: `'${o.id}' is outside the map` });
    });
    if (Math.abs(world.player.spawn.x) > world.size.width / 2 || Math.abs(world.player.spawn.z) > world.size.depth / 2) {
      ctx.addIssue({ code: "custom", path: ["player", "spawn"], message: "The player spawn point is outside the map" });
    }
  });

export type World = z.infer<typeof worldSchema>;

export function parseWorld(input: unknown): { ok: true; world: World } | { ok: false; errors: string[] } {
  const r = worldSchema.safeParse(input);
  if (r.success) return { ok: true, world: r.data };
  return { ok: false, errors: r.error.issues.slice(0, 30).map((i) => `${i.path.map(String).join(".") || "world"}: ${i.message}`) };
}

const CLIP_HINTS: Record<CharacterState, RegExp[]> = {
  idle: [/^idle$/i, /idle/i, /stand/i, /breath/i, /survey/i, /wait/i, /rest/i],
  walk: [/^walk(ing)?$/i, /walk/i, /move/i, /stroll/i],
  run: [/^run(ning)?$/i, /run/i, /sprint/i, /jog/i, /gallop/i],
  jump: [/^jump(ing)?$/i, /jump/i, /fall/i, /air/i, /leap/i],
};

/**
 * Picks the animation for each state from a model's animation names: an exact name first, then a
 * name containing the word ("Armature|Walk_Cycle" is a walk). Each name is used for one state only,
 * so "WalkJump" does not become the walk when "Walking" exists.
 */
export function guessClips(names: readonly string[]): Partial<Record<CharacterState, string>> {
  const out: Partial<Record<CharacterState, string>> = {};
  const used = new Set<string>();
  for (const state of CHARACTER_STATES) {
    for (const re of CLIP_HINTS[state]) {
      const hit = names.find((n) => !used.has(n) && re.test(n) && !(state !== "jump" && /jump/i.test(n)));
      if (hit) {
        out[state] = hit;
        used.add(hit);
        break;
      }
    }
  }
  return out;
}

/** A unique id for a new object of a type: tree_4, crystal_2 ... */
export function nextObjectId(world: World, prefix: string): string {
  const used = new Set(world.objects.map((o) => o.id));
  for (let i = 1; i < 10000; i++) {
    const id = `${prefix}_${i}`;
    if (!used.has(id)) return id;
  }
  throw new Error("Too many objects");
}

export const OBJECT_DEFAULTS: Record<WorldObjectType, (id: string, x: number, z: number) => WorldObject> = {
  tree: (id, x, z) => ({ id, type: "tree", x, z, rotation: 0, scale: 1, variant: "round" }),
  rock: (id, x, z) => ({ id, type: "rock", x, z, rotation: 0, scale: 1 }),
  collectible: (id, x, z) => ({ id, type: "collectible", x, z, rotation: 0, scale: 1, kind: "crystal", label: "Sun crystal" }),
  npc: (id, x, z) => ({ id, type: "npc", x, z, rotation: 0, scale: 1, name: "Villager", color: "#c8873a" }),
  enemy: (id, x, z) => ({ id, type: "enemy", x, z, rotation: 0, scale: 1, name: "Thorn beetle", kind: "beetle", health: 2, damage: 1, speed: 3, sight: 8, roam: 4, color: "#5b3d7a" }),
  crate: (id, x, z) => ({ id, type: "crate", x, z, rotation: 0, scale: 1, variant: "wood" }),
  gate: (id, x, z) => ({ id, type: "gate", x, z, rotation: 0, scale: 1, width: 5 }),
  zone: (id, x, z) => ({ id, type: "zone", x, z, rotation: 0, scale: 1, radius: 3, label: "Zone", visible: true }),
  water: (id, x, z) => ({ id, type: "water", x, z, rotation: 0, scale: 1, radius: 6 }),
  sign: (id, x, z) => ({ id, type: "sign", x, z, rotation: 0, scale: 1, text: "Hello, traveller" }),
  torch: (id, x, z) => ({ id, type: "torch", x, z, rotation: 0, scale: 1 }),
  // The asset is chosen when the model is placed; an empty path does not validate.
  model: (id, x, z) => ({ id, type: "model", x, z, rotation: 0, scale: 1, asset: "", collide: true }),
};

/** "Sun Crystal Valley": an original, West African-inspired starter level. */
export function sunCrystalValley(): World {
  return {
    schemaVersion: WORLD_SCHEMA_VERSION,
    kind: "explore-world",
    name: "Sun Crystal Valley",
    size: { width: 90, depth: 90 },
    environment: { skyTop: "#2f63a8", skyHorizon: "#b8d4ec", ground: "#5a7d3c", sunElevation: 48, sunHeading: 35, fogDensity: 0.008, sunColor: "#fff2dc", clouds: 0.45, groundVariation: 0.7, grass: 0.75 },
    player: { spawn: { x: 0, z: 30 }, speed: 6, sprintMultiplier: 1.7, jumpVelocity: 5.5, cameraDistance: 6 },
    objects: [
      {
        id: "elder",
        type: "npc",
        x: 4,
        z: 24,
        rotation: 200,
        scale: 1,
        name: "Elder Ama",
        color: "#c8873a",
        ai: {
          persona: "The oldest woman in Sun Crystal Valley: warm, patient and fond of proverbs. She has watched over the valley all her life and speaks softly, calling the player 'traveller'.",
          knows: "Three sun crystals are hidden in the valley: one by the lake to the west, one among the stones to the south and one under the great baobab to the east. When all three are found, the shrine gate to the north opens, and entering the sun shrine brings the valley's light back. The traveller walks with W A S D, runs with Shift, jumps with Space and talks with E.",
        },
      },
      { id: "sign_path", type: "sign", x: -3, z: 18, rotation: 0, scale: 1, text: "North: the sun shrine. Its gate opens for the three sun crystals." },
      { id: "crystal_1", type: "collectible", x: -24, z: 6, rotation: 0, scale: 1, kind: "crystal", label: "Sun crystal" },
      { id: "crystal_2", type: "collectible", x: 22, z: -4, rotation: 0, scale: 1, kind: "crystal", label: "Sun crystal" },
      { id: "crystal_3", type: "collectible", x: -6, z: -20, rotation: 0, scale: 1, kind: "crystal", label: "Sun crystal" },
      { id: "lake", type: "water", x: -24, z: 14, rotation: 0, scale: 1, radius: 7 },
      { id: "baobab_1", type: "tree", x: 22, z: 4, rotation: 0, scale: 1.6, variant: "baobab" },
      { id: "tree_1", type: "tree", x: -12, z: 22, rotation: 0, scale: 1.1, variant: "round" },
      { id: "tree_2", type: "tree", x: 14, z: 16, rotation: 0, scale: 1.3, variant: "tall" },
      { id: "tree_3", type: "tree", x: -30, z: -12, rotation: 0, scale: 1.2, variant: "round" },
      { id: "tree_4", type: "tree", x: 30, z: -18, rotation: 0, scale: 1.4, variant: "tall" },
      { id: "tree_5", type: "tree", x: -16, z: -6, rotation: 0, scale: 0.9, variant: "round" },
      { id: "rock_1", type: "rock", x: -8, z: -22, rotation: 30, scale: 1.8 },
      { id: "rock_2", type: "rock", x: 10, z: -14, rotation: 0, scale: 1.2 },
      { id: "rock_3", type: "rock", x: 28, z: 24, rotation: 70, scale: 1.5 },
      { id: "torch_1", type: "torch", x: -4, z: -28, rotation: 0, scale: 1 },
      { id: "torch_2", type: "torch", x: 4, z: -28, rotation: 0, scale: 1 },
      { id: "gate_main", type: "gate", x: 0, z: -30, rotation: 0, scale: 1, width: 6 },
      { id: "shrine", type: "zone", x: 0, z: -38, rotation: 0, scale: 1, radius: 4, label: "Sun shrine", visible: true },
    ],
  };
}

/**
 * Models made with Kiln for Thornwood Ruins (sources in templates/exploration-3d/kiln/), shipped with the
 * adventure template in the Godot project's assets. The wooden crate is there for blocks a person adds.
 */
export const RUINS_MODELS = {
  beetle: "assets/models/kiln/thorn-beetle.gltf",
  block: "assets/models/kiln/stone-block.gltf",
  crate: "assets/models/kiln/wood-crate.gltf",
  gate: "assets/models/kiln/shrine-gate.gltf",
} as const;

/**
 * "Thornwood Ruins": an original adventure level for the same Godot template. Thorn beetles roam the
 * ruins; two stone blocks pushed onto the plates open the old gate, and the beacon beyond it should be
 * lit before the sunset timer runs out. The plates come first in the list (the game's self-test pushes
 * blocks into zones in list order), then the spring and the beacon.
 */
export function thornwoodRuins(): World {
  const enemy = (id: string, x: number, z: number): WorldObject => ({ id, type: "enemy", x, z, rotation: 0, scale: 1, name: "Thorn beetle", kind: "beetle", health: 2, damage: 1, speed: 3, sight: 8, roam: 4, color: "#5b3d7a", model: RUINS_MODELS.beetle, height: 1.1 });
  const rock = (id: string, x: number, z: number, scale: number, rotation = 0): WorldObject => ({ id, type: "rock", x, z, rotation, scale });
  return {
    schemaVersion: WORLD_SCHEMA_VERSION,
    kind: "explore-world",
    name: "Thornwood Ruins",
    size: { width: 80, depth: 80 },
    environment: { skyTop: "#34508f", skyHorizon: "#f0b48c", ground: "#5d6b3a", sunElevation: 24, sunHeading: 250, fogDensity: 0.009, sunColor: "#ffd2a0", clouds: 0.35, groundVariation: 0.8, grass: 0.5 },
    player: { spawn: { x: 0, z: 30 }, speed: 6, sprintMultiplier: 1.7, jumpVelocity: 5.5, cameraDistance: 6, health: 5 },
    objects: [
      { id: "plate_1", type: "zone", x: -6, z: -18, rotation: 0, scale: 1, radius: 1.6, label: "Pressure plate", visible: true },
      { id: "plate_2", type: "zone", x: 6, z: -18, rotation: 0, scale: 1, radius: 1.6, label: "Pressure plate", visible: true },
      {
        id: "ranger",
        type: "npc",
        x: 4,
        z: 25,
        rotation: 200,
        scale: 1,
        name: "Ranger Kofi",
        color: "#3f7d5a",
        ai: {
          persona: "The ranger who keeps watch over Thornwood: brave, practical and a little gruff, but kind to newcomers. He talks in short, plain sentences.",
          knows: "Thorn beetles have taken the old ruins north of the camp. Two hits from a staff (F or a click) beat one, and a beetle's touch costs a heart. The healing spring west of the camp restores hearts. The two stone blocks south of the old gate must be pushed north onto the glowing plates to open it. Beyond the gate, the beacon should be lit before sunset; after the gate opens the sun goes down in a minute and a half.",
        },
      },
      { id: "sign_camp", type: "sign", x: -3, z: 22, rotation: 0, scale: 1, text: "F or a click swings your staff. Walk into a stone block to push it." },
      { id: "torch_camp_1", type: "torch", x: -5, z: 28, rotation: 0, scale: 1 },
      { id: "torch_camp_2", type: "torch", x: 5, z: 28, rotation: 0, scale: 1 },
      { id: "spring_pool", type: "water", x: -22, z: 22, rotation: 0, scale: 1, radius: 4.5 },
      { id: "spring", type: "zone", x: -22, z: 22, rotation: 0, scale: 1, radius: 3.5, label: "Healing spring", visible: true },
      enemy("beetle_1", -16, 6),
      enemy("beetle_2", 16, 4),
      enemy("beetle_3", -4, -2),
      enemy("beetle_4", 10, -6),
      { id: "block_1", type: "crate", x: -6, z: -9, rotation: 0, scale: 1, variant: "stone", model: RUINS_MODELS.block },
      { id: "block_2", type: "crate", x: 6, z: -9, rotation: 0, scale: 1, variant: "stone", model: RUINS_MODELS.block },
      { id: "gate_ruins", type: "gate", x: 0, z: -26, rotation: 0, scale: 1, width: 6, model: RUINS_MODELS.gate },
      rock("wall_1", -6, -26, 2.2),
      rock("wall_2", -9.5, -26.5, 2.4, 40),
      rock("wall_3", -13, -26, 2.2, 75),
      rock("wall_4", 6, -26, 2.2, 20),
      rock("wall_5", 9.5, -25.5, 2.4, 60),
      rock("wall_6", 13, -26, 2.2),
      { id: "beacon", type: "zone", x: 0, z: -34, rotation: 0, scale: 1, radius: 2.5, label: "Beacon", visible: true },
      { id: "torch_beacon_1", type: "torch", x: -2.5, z: -36, rotation: 0, scale: 1 },
      { id: "torch_beacon_2", type: "torch", x: 2.5, z: -36, rotation: 0, scale: 1 },
      { id: "tree_1", type: "tree", x: -24, z: -4, rotation: 0, scale: 1.4, variant: "baobab" },
      { id: "tree_2", type: "tree", x: 24, z: -2, rotation: 0, scale: 1.3, variant: "tall" },
      { id: "tree_3", type: "tree", x: -28, z: 12, rotation: 0, scale: 1.1, variant: "round" },
      { id: "tree_4", type: "tree", x: 26, z: 18, rotation: 0, scale: 1.2, variant: "round" },
      { id: "tree_5", type: "tree", x: -18, z: -20, rotation: 0, scale: 1.2, variant: "tall" },
      { id: "tree_6", type: "tree", x: 20, z: -20, rotation: 0, scale: 1, variant: "round" },
      { id: "tree_7", type: "tree", x: 14, z: 26, rotation: 0, scale: 1.1, variant: "tall" },
      { id: "tree_8", type: "tree", x: -12, z: 31, rotation: 0, scale: 1, variant: "round" },
      rock("rock_1", -12, 12, 1.3, 30),
      rock("rock_2", 14, 14, 1.1),
      rock("rock_3", 2, 6, 0.9, 50),
    ],
  };
}
