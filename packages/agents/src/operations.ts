import { z } from "zod";
import { OBJECT_TYPES, SOUNDS } from "@gamestudio/explore";
import { LEVEL_OBJECT_TYPES, PLATFORMER_SOUNDS } from "@gamestudio/platformer";

/**
 * The only changes an assistant can propose. Each operation is small, typed and validated;
 * none of them can touch files directly, run commands or reach the network.
 *
 * The JSON Schema below is the contract sent to model providers. It stays inside the subset
 * every supported provider accepts for structured output: no numeric or length constraints,
 * no recursion, and `additionalProperties: false` on every object.
 */
const scalar = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.array(z.number().finite()).max(48)]);
const attribute = z.object({ name: z.string().max(60), value: scalar }).strict();
const id = z.string().min(1).max(64);

export const WORLD_FIELDS = ["rotation", "scale", "label", "name", "text", "kind", "variant", "radius", "width", "color", "visible", "asset", "collide", "model", "animation", "height", "texture", "textureTile", "tint", "health", "damage", "speed", "sight", "roam", "persona", "knows"] as const;
export const CHARACTER_FIELDS = ["asset", "height", "turn", "idle", "walk", "run", "jump"] as const;
export const ENVIRONMENT_FIELDS = ["skyTop", "skyHorizon", "ground", "sunElevation", "sunHeading", "fogDensity", "sunColor", "clouds", "groundVariation", "grass", "style", "skyImage", "skyBrightness", "quality", "groundTexture"] as const;
export const LEVEL_FIELDS = ["width", "height", "style", "kind", "label", "text", "range", "speed", "texture", "tile"] as const;
export const WORLD_AUDIO_FIELDS = ["music", "musicVolume", ...SOUNDS] as const;
export const LEVEL_AUDIO_FIELDS = ["music", "musicVolume", ...PLATFORMER_SOUNDS] as const;
export const SPRITE_FIELDS = ["asset", "columns", "rows", "idle", "run", "jump", "fps", "height", "facing"] as const;
export const LEVEL_SETTINGS = ["name", "width", "height", "speed", "jumpHeight", "gravity", "spawnX", "spawnY", "skyTop", "skyBottom", "hills"] as const;
export const PLAYER_FIELDS = ["speed", "sprintMultiplier", "jumpVelocity", "cameraDistance", "spawnX", "spawnZ", "health"] as const;
export const CREATURE_FIELDS = ["name", "description", "element", "hp", "attack", "defense", "speed"] as const;
/** Football match settings (match.set) and each team's (match.team). */
export const MATCH_FIELDS = ["name", "teamSize", "minutes", "difficulty", "control", "pitchLength", "pitchWidth", "goalWidth", "grass", "lines", "stripes"] as const;
export const TEAM_FIELDS = ["name", "short", "shirt", "shorts", "keeper"] as const;
/** Farm settings (farm.set), a crop's (farm.crop) and the map tiles farm.fill paints. */
export const FARM_FIELDS = ["name", "farmerName", "shirt", "currency", "startMoney", "dayLength", "rainChance", "spawnX", "spawnY", "width", "height"] as const;
export const CROP_FIELDS = ["name", "seedCost", "days", "yield", "price", "color", "needsWater", "regrow"] as const;
export const FARM_TILE_NAMES = ["grass", "soil", "path", "water", "tree", "fence", "house", "market"] as const;
/** A squad member's settings (match.player); slot 1 is the goalkeeper. */
export const PLAYER_FIELDS_MATCH = ["name", "number", "pace", "shooting", "tackling"] as const;

export const operationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("world.add"), objectType: z.enum(OBJECT_TYPES), id, x: z.number().finite(), z: z.number().finite(), attributes: z.array(attribute).max(12) }).strict(),
  z.object({ op: z.literal("world.move"), id, x: z.number().finite(), z: z.number().finite() }).strict(),
  z.object({ op: z.literal("world.remove"), id }).strict(),
  z.object({ op: z.literal("world.set"), id, name: z.enum(WORLD_FIELDS), value: scalar }).strict(),
  z.object({ op: z.literal("world.environment"), name: z.enum(ENVIRONMENT_FIELDS), value: scalar }).strict(),
  z.object({ op: z.literal("world.player"), name: z.enum(PLAYER_FIELDS), value: z.number().finite() }).strict(),
  z.object({ op: z.literal("world.character"), name: z.enum(CHARACTER_FIELDS), value: scalar }).strict(),
  z.object({ op: z.literal("world.audio"), name: z.enum(WORLD_AUDIO_FIELDS), value: scalar }).strict(),
  z.object({ op: z.literal("level.add"), objectType: z.enum(LEVEL_OBJECT_TYPES), id, x: z.number().finite(), y: z.number().finite(), attributes: z.array(attribute).max(12) }).strict(),
  z.object({ op: z.literal("level.move"), id, x: z.number().finite(), y: z.number().finite() }).strict(),
  z.object({ op: z.literal("level.remove"), id }).strict(),
  z.object({ op: z.literal("level.set"), id, name: z.enum(LEVEL_FIELDS), value: scalar }).strict(),
  z.object({ op: z.literal("level.settings"), name: z.enum(LEVEL_SETTINGS), value: scalar }).strict(),
  z.object({ op: z.literal("level.sprite"), name: z.enum(SPRITE_FIELDS), value: scalar }).strict(),
  z.object({ op: z.literal("level.audio"), name: z.enum(LEVEL_AUDIO_FIELDS), value: scalar }).strict(),
  z.object({ op: z.literal("farm.set"), name: z.enum(FARM_FIELDS), value: scalar }).strict(),
  z.object({ op: z.literal("farm.crop"), crop: id, name: z.enum(CROP_FIELDS), value: scalar }).strict(),
  z.object({ op: z.literal("farm.addCrop"), crop: id, name: z.string().max(24) }).strict(),
  z.object({ op: z.literal("farm.removeCrop"), crop: id }).strict(),
  z.object({ op: z.literal("farm.fill"), x: z.number().int(), y: z.number().int(), width: z.number().int(), height: z.number().int(), tile: z.enum(FARM_TILE_NAMES) }).strict(),
  z.object({ op: z.literal("match.set"), name: z.enum(MATCH_FIELDS), value: scalar }).strict(),
  z.object({ op: z.literal("match.team"), team: z.enum(["home", "away"]), name: z.enum(TEAM_FIELDS), value: z.string().max(60) }).strict(),
  z.object({ op: z.literal("match.player"), team: z.enum(["home", "away"]), slot: z.number().int(), name: z.enum(PLAYER_FIELDS_MATCH), value: z.union([z.string().max(60), z.number().finite()]) }).strict(),
  z.object({ op: z.literal("rules.addNode"), graph: id, id, type: z.string().max(120), x: z.number().finite(), y: z.number().finite(), params: z.array(attribute).max(16) }).strict(),
  z.object({ op: z.literal("rules.removeNode"), graph: id, id }).strict(),
  z.object({ op: z.literal("rules.setParam"), graph: id, node: id, name: z.string().max(60), value: scalar }).strict(),
  z.object({ op: z.literal("rules.connect"), graph: id, from: id, fromPin: z.string().max(80), to: id, toPin: z.string().max(80) }).strict(),
  z.object({ op: z.literal("rules.disconnect"), graph: id, from: id, fromPin: z.string().max(80), to: id, toPin: z.string().max(80) }).strict(),
  z.object({ op: z.literal("rules.addVariable"), graph: id, name: z.string().max(64), type: z.enum(["number", "boolean", "text"]), initial: z.union([z.string().max(2000), z.number().finite(), z.boolean()]) }).strict(),
  z
    .object({
      op: z.literal("creatures.add"),
      id,
      name: z.string().max(40),
      element: z.enum(["plain", "sun", "river", "forest"]),
      description: z.string().max(600),
      hp: z.number(),
      attack: z.number(),
      defense: z.number(),
      speed: z.number(),
      moves: z.array(z.object({ id, name: z.string().max(40), element: z.enum(["plain", "sun", "river", "forest"]), power: z.number(), description: z.string().max(300) }).strict()).max(4),
    })
    .strict(),
  z.object({ op: z.literal("creatures.set"), id, name: z.enum(CREATURE_FIELDS), value: scalar }).strict(),
  z
    .object({
      op: z.literal("lesson.addQuestion"),
      lesson: id,
      id,
      kind: z.enum(["single", "numeric"]),
      prompt: z.string().max(600),
      options: z.array(z.string().max(200)).max(8),
      answer: z.number().finite(),
      tolerance: z.number().finite(),
      unit: z.string().max(20),
      explanation: z.string().max(1200),
    })
    .strict(),
  z.object({ op: z.literal("project.describe"), description: z.string().max(2000) }).strict(),
]);

export type Operation = z.infer<typeof operationSchema>;
export type OperationKind = Operation["op"];
export const OPERATION_KINDS = operationSchema.options.map((o) => o.shape.op.value) as OperationKind[];

export const proposalSchema = z
  .object({
    summary: z.string().max(4000),
    operations: z.array(operationSchema).max(80),
  })
  .strict();
export type Proposal = z.infer<typeof proposalSchema>;

const S = { type: "string" } as const;
const N = { type: "number" } as const;
const SCALAR = { anyOf: [S, N, { type: "boolean" }, { type: "array", items: N }] };
const ATTRS = { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "value"], properties: { name: S, value: SCALAR } } };

function obj(op: OperationKind, properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", additionalProperties: false, required: ["op", ...Object.keys(properties)], properties: { op: { type: "string", enum: [op] }, ...properties } };
}

const OPERATION_JSON: Record<OperationKind, Record<string, unknown>> = {
  "world.add": obj("world.add", { objectType: { type: "string", enum: [...OBJECT_TYPES] }, id: S, x: N, z: N, attributes: ATTRS }),
  "world.move": obj("world.move", { id: S, x: N, z: N }),
  "world.remove": obj("world.remove", { id: S }),
  "world.set": obj("world.set", { id: S, name: { type: "string", enum: [...WORLD_FIELDS] }, value: SCALAR }),
  "world.environment": obj("world.environment", { name: { type: "string", enum: [...ENVIRONMENT_FIELDS] }, value: SCALAR }),
  "world.player": obj("world.player", { name: { type: "string", enum: [...PLAYER_FIELDS] }, value: N }),
  "world.character": obj("world.character", { name: { type: "string", enum: [...CHARACTER_FIELDS] }, value: SCALAR }),
  "world.audio": obj("world.audio", { name: { type: "string", enum: [...WORLD_AUDIO_FIELDS] }, value: SCALAR }),
  "level.add": obj("level.add", { objectType: { type: "string", enum: [...LEVEL_OBJECT_TYPES] }, id: S, x: N, y: N, attributes: ATTRS }),
  "level.move": obj("level.move", { id: S, x: N, y: N }),
  "level.remove": obj("level.remove", { id: S }),
  "level.set": obj("level.set", { id: S, name: { type: "string", enum: [...LEVEL_FIELDS] }, value: SCALAR }),
  "level.settings": obj("level.settings", { name: { type: "string", enum: [...LEVEL_SETTINGS] }, value: SCALAR }),
  "level.sprite": obj("level.sprite", { name: { type: "string", enum: [...SPRITE_FIELDS] }, value: SCALAR }),
  "level.audio": obj("level.audio", { name: { type: "string", enum: [...LEVEL_AUDIO_FIELDS] }, value: SCALAR }),
  "farm.set": obj("farm.set", { name: { type: "string", enum: [...FARM_FIELDS] }, value: SCALAR }),
  "farm.crop": obj("farm.crop", { crop: S, name: { type: "string", enum: [...CROP_FIELDS] }, value: SCALAR }),
  "farm.addCrop": obj("farm.addCrop", { crop: S, name: S }),
  "farm.removeCrop": obj("farm.removeCrop", { crop: S }),
  "farm.fill": obj("farm.fill", { x: N, y: N, width: N, height: N, tile: { type: "string", enum: [...FARM_TILE_NAMES] } }),
  "match.set": obj("match.set", { name: { type: "string", enum: [...MATCH_FIELDS] }, value: SCALAR }),
  "match.team": obj("match.team", { team: { type: "string", enum: ["home", "away"] }, name: { type: "string", enum: [...TEAM_FIELDS] }, value: S }),
  "match.player": obj("match.player", { team: { type: "string", enum: ["home", "away"] }, slot: N, name: { type: "string", enum: [...PLAYER_FIELDS_MATCH] }, value: { anyOf: [S, N] } }),
  "rules.addNode": obj("rules.addNode", { graph: S, id: S, type: S, x: N, y: N, params: ATTRS }),
  "rules.removeNode": obj("rules.removeNode", { graph: S, id: S }),
  "rules.setParam": obj("rules.setParam", { graph: S, node: S, name: S, value: SCALAR }),
  "rules.connect": obj("rules.connect", { graph: S, from: S, fromPin: S, to: S, toPin: S }),
  "rules.disconnect": obj("rules.disconnect", { graph: S, from: S, fromPin: S, to: S, toPin: S }),
  "rules.addVariable": obj("rules.addVariable", { graph: S, name: S, type: { type: "string", enum: ["number", "boolean", "text"] }, initial: { anyOf: [S, N, { type: "boolean" }] } }),
  "creatures.add": obj("creatures.add", {
    id: S,
    name: S,
    element: { type: "string", enum: ["plain", "sun", "river", "forest"] },
    description: S,
    hp: N,
    attack: N,
    defense: N,
    speed: N,
    moves: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "name", "element", "power", "description"], properties: { id: S, name: S, element: { type: "string", enum: ["plain", "sun", "river", "forest"] }, power: N, description: S } } },
  }),
  "creatures.set": obj("creatures.set", { id: S, name: { type: "string", enum: [...CREATURE_FIELDS] }, value: SCALAR }),
  "lesson.addQuestion": obj("lesson.addQuestion", { lesson: S, id: S, kind: { type: "string", enum: ["single", "numeric"] }, prompt: S, options: { type: "array", items: S }, answer: N, tolerance: N, unit: S, explanation: S }),
  "project.describe": obj("project.describe", { description: S }),
};

/** JSON Schema for a proposal limited to the operation kinds an agent is allowed to use. */
export function proposalJsonSchema(allowed: OperationKind[]): Record<string, unknown> {
  const items = allowed.map((k) => OPERATION_JSON[k]);
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "operations"],
    properties: {
      summary: { type: "string", description: "Plain-language description of the proposed change, or an explanation of why no change is proposed." },
      operations: { type: "array", items: items.length > 0 ? { anyOf: items } : { type: "object", additionalProperties: false, properties: {}, required: [] } },
    },
  };
}
