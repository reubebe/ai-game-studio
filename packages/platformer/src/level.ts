import { z } from "zod";
import { PLATFORMER_SOUNDS } from "./domain";

/**
 * Engine-neutral layout of a 2D platformer level. The Godot template's level_builder.gd reads this file
 * (synced to res://gamestudio_data/level.json) and builds the scene. Units are tiles (32 pixels in the
 * game): x to the right from the level's left edge, y upwards from the bottom. A platform's (x, y) is
 * its bottom-left corner; every other object stands on the point (x, y).
 */
export const LEVEL_SCHEMA_VERSION = "1.0.0";
export const TILE_PIXELS = 32;

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a #rrggbb colour");
const objectId = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, "Use lowercase letters, digits and underscores");
const coord = z.number().finite();

export const LEVEL_OBJECT_TYPES = ["platform", "coin", "spike", "checkpoint", "goal", "enemy", "door", "sign"] as const;
export type LevelObjectType = (typeof LEVEL_OBJECT_TYPES)[number];
export const PLATFORM_STYLES = ["grass", "stone", "wood"] as const;

const base = { id: objectId, x: coord, y: coord };

/** A picture in the Godot project's assets folder (res://assets/...): relative, no "..". */
const spriteAsset = z
  .string()
  .max(200)
  .regex(/^assets\/(?:[A-Za-z0-9_][A-Za-z0-9_ .-]*\/)*[A-Za-z0-9_][A-Za-z0-9_ .-]*\.(?:png|webp)$/i, "Choose a .png or .webp sprite sheet in the project's assets folder")
  .refine((p) => !p.split("/").some((part) => part === "." || part === ".."), "Paths cannot contain . or ..");
const frameList = z.array(z.number().int().min(0).max(4095)).max(64);
export const SPRITE_STATES = ["idle", "run", "jump"] as const;

const audioAsset = z
  .string()
  .max(200)
  .regex(/^assets\/(?:[A-Za-z0-9_][A-Za-z0-9_ .-]*\/)*[A-Za-z0-9_][A-Za-z0-9_ .-]*\.(?:ogg|wav|mp3)$/i, "Choose a .ogg, .wav or .mp3 file in the project's assets folder")
  .refine((p) => !p.split("/").some((part) => part === "." || part === ".."), "Paths cannot contain . or ..");
/** Background music and imported files that replace the template's sounds by name (Godot plays them). */
export const levelAudioSchema = z
  .object({
    music: z.object({ asset: audioAsset, volume: z.number().min(0).max(1).default(0.6) }).strict().optional(),
    sounds: z.partialRecord(z.enum(PLATFORMER_SOUNDS), audioAsset).optional(),
  })
  .strict();

/**
 * The player drawn from a sprite sheet: a grid of equal frames (`columns` x `rows`, numbered left to
 * right, top to bottom from 0) with a list of frames for standing, running and jumping. The sprite is
 * scaled to `height` tiles; `facing` is the way the frames look, so running the other way flips them.
 */
export const spriteSchema = z
  .object({
    asset: spriteAsset,
    columns: z.number().int().min(1).max(64).default(4),
    rows: z.number().int().min(1).max(64).default(1),
    idle: frameList.default([0]),
    run: frameList.default([]),
    jump: frameList.default([]),
    fps: z.number().min(1).max(30).default(10),
    height: z.number().min(0.5).max(8).default(1.5),
    facing: z.enum(["right", "left"]).default("right"),
    pixelArt: z.boolean().default(true),
  })
  .strict()
  .superRefine((sp, ctx) => {
    const count = sp.columns * sp.rows;
    for (const state of SPRITE_STATES) {
      const bad = sp[state].filter((f) => f >= count);
      if (bad.length) ctx.addIssue({ code: "custom", path: [state], message: `Frame ${bad[0]} is outside the ${sp.columns} x ${sp.rows} sheet (frames 0 to ${count - 1})` });
    }
    if (sp.idle.length === 0) ctx.addIssue({ code: "custom", path: ["idle"], message: "Give the standing pose at least one frame" });
  });
export type Sprite = z.infer<typeof spriteSchema>;

/** A picture tiled over a platform (png, jpg or webp in the assets folder). */
const platformTexture = z
  .string()
  .max(200)
  .regex(/^assets\/(?:[A-Za-z0-9_][A-Za-z0-9_ .-]*\/)*[A-Za-z0-9_][A-Za-z0-9_ .-]*\.(?:png|jpe?g|webp)$/i, "Choose a .png, .jpg or .webp picture in the project's assets folder")
  .refine((p) => !p.split("/").some((part) => part === "." || part === ".."), "Paths cannot contain . or ..");

export const levelObjectSchema = z.discriminatedUnion("type", [
  // With a texture, the picture is repeated every `tile` tiles from the platform's top left; the style still decides whether it can be jumped through.
  z.object({ ...base, type: z.literal("platform"), width: z.number().min(1).max(400), height: z.number().min(0.5).max(60), style: z.enum(PLATFORM_STYLES).default("grass"), texture: platformTexture.optional(), tile: z.number().min(0.25).max(16).optional() }).strict(),
  z.object({ ...base, type: z.literal("coin"), kind: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).default("coin"), label: z.string().max(60).default("Coin") }).strict(),
  z.object({ ...base, type: z.literal("spike"), width: z.number().min(1).max(40).default(2) }).strict(),
  z.object({ ...base, type: z.literal("checkpoint"), label: z.string().max(60).default("Checkpoint") }).strict(),
  z.object({ ...base, type: z.literal("goal"), label: z.string().max(60).default("Goal") }).strict(),
  z.object({ ...base, type: z.literal("enemy"), range: z.number().min(0).max(60).default(4), speed: z.number().min(0.5).max(10).default(2) }).strict(),
  z.object({ ...base, type: z.literal("door"), height: z.number().min(1).max(12).default(3) }).strict(),
  z.object({ ...base, type: z.literal("sign"), text: z.string().min(1).max(200) }).strict(),
]);
export type LevelObject = z.infer<typeof levelObjectSchema>;

export const levelSchema = z
  .object({
    schemaVersion: z.literal(LEVEL_SCHEMA_VERSION),
    kind: z.literal("platformer-level"),
    name: z.string().trim().min(1).max(80),
    size: z.object({ width: z.number().min(20).max(1000), height: z.number().min(10).max(120) }).strict(),
    background: z.object({ skyTop: color, skyBottom: color, hills: color }).strict(),
    audio: levelAudioSchema.optional(),
    player: z
      .object({
        spawn: z.object({ x: coord, y: coord }).strict(),
        /** Running speed in tiles per second. */
        speed: z.number().min(2).max(30),
        /** Highest jump in tiles (holding the jump key). */
        jumpHeight: z.number().min(1).max(12),
        /** Downward acceleration in tiles per second squared. */
        gravity: z.number().min(10).max(200),
        /** Optional sprite sheet for the player; without it the player is the drawn runner. */
        sprite: spriteSchema.optional(),
      })
      .strict(),
    objects: z.array(levelObjectSchema).max(2000),
  })
  .strict()
  .superRefine((level, ctx) => {
    const ids = new Set<string>();
    level.objects.forEach((o, i) => {
      if (ids.has(o.id)) ctx.addIssue({ code: "custom", path: ["objects", i, "id"], message: `Object id '${o.id}' is used twice` });
      ids.add(o.id);
      if (o.x < 0 || o.x > level.size.width || o.y < 0 || o.y > level.size.height) ctx.addIssue({ code: "custom", path: ["objects", i], message: `'${o.id}' is outside the level` });
    });
    const s = level.player.spawn;
    if (s.x < 0 || s.x > level.size.width || s.y < 0 || s.y > level.size.height) ctx.addIssue({ code: "custom", path: ["player", "spawn"], message: "The player start is outside the level" });
    if (!level.objects.some((o) => o.type === "goal")) ctx.addIssue({ code: "custom", path: ["objects"], message: "Add a goal flag: without one the level cannot be finished" });
  });

export type Level = z.infer<typeof levelSchema>;

export function parseLevel(input: unknown): { ok: true; level: Level } | { ok: false; errors: string[] } {
  const r = levelSchema.safeParse(input);
  if (r.success) return { ok: true, level: r.data };
  return { ok: false, errors: r.error.issues.slice(0, 30).map((i) => `${i.path.map(String).join(".") || "level"}: ${i.message}`) };
}

export function nextLevelObjectId(level: Level, prefix: string): string {
  const used = new Set(level.objects.map((o) => o.id));
  for (let i = 1; i < 100000; i++) {
    const id = `${prefix}_${i}`;
    if (!used.has(id)) return id;
  }
  throw new Error("Too many objects");
}

export const LEVEL_OBJECT_DEFAULTS: Record<LevelObjectType, (id: string, x: number, y: number) => LevelObject> = {
  platform: (id, x, y) => ({ id, type: "platform", x, y, width: 4, height: 1, style: "grass" }),
  coin: (id, x, y) => ({ id, type: "coin", x, y, kind: "coin", label: "Coin" }),
  spike: (id, x, y) => ({ id, type: "spike", x, y, width: 2 }),
  checkpoint: (id, x, y) => ({ id, type: "checkpoint", x, y, label: "Checkpoint" }),
  goal: (id, x, y) => ({ id, type: "goal", x, y, label: "Goal" }),
  enemy: (id, x, y) => ({ id, type: "enemy", x, y, range: 4, speed: 2 }),
  door: (id, x, y) => ({ id, type: "door", x, y, height: 3 }),
  sign: (id, x, y) => ({ id, type: "sign", x, y, text: "Hello!" }),
};

/** Width and height in tiles an object covers, from its (x, y): used by editors and hit tests. */
export function objectBox(o: LevelObject): { x: number; y: number; width: number; height: number } {
  switch (o.type) {
    case "platform":
      return { x: o.x, y: o.y, width: o.width, height: o.height };
    case "spike":
      return { x: o.x, y: o.y, width: o.width, height: 0.6 };
    case "door":
      return { x: o.x - 0.5, y: o.y, width: 1, height: o.height };
    case "enemy":
      return { x: o.x - 0.5, y: o.y, width: 1, height: 1 };
    case "checkpoint":
    case "goal":
      return { x: o.x - 0.5, y: o.y, width: 1, height: 3 };
    case "sign":
      return { x: o.x - 0.5, y: o.y, width: 1, height: 1.4 };
    case "coin":
      return { x: o.x - 0.4, y: o.y - 0.4, width: 0.8, height: 0.8 };
  }
}

/** "Sunset Cliffs": an original starter level with gaps, a checkpoint, a patrolling beetle and a coin-locked gate. */
export function sunsetCliffs(): Level {
  const p = (id: string, x: number, y: number, width: number, height: number, style: "grass" | "stone" | "wood" = "grass"): LevelObject => ({ id, type: "platform", x, y, width, height, style });
  const coin = (id: string, x: number, y: number): LevelObject => ({ id, type: "coin", x, y, kind: "coin", label: "Sun coin" });
  return {
    schemaVersion: LEVEL_SCHEMA_VERSION,
    kind: "platformer-level",
    name: "Sunset Cliffs",
    size: { width: 140, height: 24 },
    background: { skyTop: "#2b3a78", skyBottom: "#f4a261", hills: "#6d4c7d" },
    player: { spawn: { x: 3, y: 3 }, speed: 8, jumpHeight: 4, gravity: 60 },
    objects: [
      // Ground tops are at y = 3. A full jump rises 4 tiles, so every step up below is 3 tiles or less.
      p("ground_1", 0, 0, 30, 3),
      p("ground_2", 34, 0, 22, 3),
      p("ground_3", 60, 0, 18, 3),
      p("ground_4", 84, 0, 56, 3),
      p("ledge_1", 14, 5, 6, 1, "wood"),
      p("ledge_2", 23, 8, 4, 1, "wood"),
      p("step_1", 44, 3, 4, 2, "stone"),
      p("step_2", 48, 3, 4, 4, "stone"),
      p("ledge_3", 64, 5, 5, 1, "wood"),
      p("ledge_4", 71, 8, 5, 1, "wood"),
      p("bridge", 78, 4, 6, 1, "wood"),
      p("tower_step", 98, 3, 3, 3, "stone"),
      p("tower", 101, 3, 4, 6, "stone"),
      coin("coin_1", 16, 7),
      coin("coin_2", 18, 7),
      coin("coin_3", 25, 10),
      coin("coin_4", 32, 5.5),
      coin("coin_5", 50, 8),
      coin("coin_6", 66.5, 7),
      coin("coin_7", 73.5, 10),
      coin("coin_8", 103, 10),
      { id: "spikes_1", type: "spike", x: 38, y: 3, width: 3 },
      { id: "spikes_2", type: "spike", x: 90, y: 3, width: 4 },
      { id: "beetle_1", type: "enemy", x: 64, y: 3, range: 10, speed: 2.5 },
      { id: "beetle_2", type: "enemy", x: 108, y: 3, range: 10, speed: 3 },
      { id: "checkpoint_1", type: "checkpoint", x: 61, y: 3, label: "Halfway rock" },
      { id: "sign_start", type: "sign", x: 6, y: 3, text: "Collect every sun coin to open the gate at the end of the cliffs." },
      { id: "door_goal", type: "door", x: 124, y: 3, height: 6 },
      { id: "goal", type: "goal", x: 132, y: 3, label: "Sunset flag" },
    ],
  };
}

/**
 * Things the player probably cannot reach: coins, flags and signs standing higher above the surface
 * under them than a full jump, and objects with nothing under them at all. A quick check for levels
 * written by hand or by an assistant; it does not simulate the player, so treat its answers as warnings.
 */
export function reachWarnings(level: Level): string[] {
  const jump = level.player.jumpHeight;
  const surfaces = level.objects.filter((o): o is Extract<LevelObject, { type: "platform" }> => o.type === "platform");
  const out: string[] = [];
  for (const o of level.objects) {
    if (o.type === "platform" || o.type === "enemy" || o.type === "door" || o.type === "spike") continue;
    // Coins over a gap are collected mid-jump, so for them a surface up to 4 tiles to either side counts.
    const reach = o.type === "coin" ? 4 : 0.5;
    const under = surfaces.filter((p) => o.x >= p.x - reach && o.x <= p.x + p.width + reach && p.y + p.height <= o.y + 0.25).map((p) => p.y + p.height);
    if (under.length === 0) {
      out.push(o.type === "coin" && o.y > jump + 0.5 ? `'${o.id}' floats ${fmt(o.y)} tiles up with no platform near it` : `'${o.id}' has no platform under it`);
      continue;
    }
    const rise = o.y - Math.max(...under);
    // Coins are collected by touching them, so one may hang up to a jump (plus the player's height) above a surface.
    const limit = o.type === "coin" ? jump + 1 : 0.6;
    if (rise > limit) out.push(`'${o.id}' is ${fmt(rise)} tiles above the platform under it (the player jumps ${fmt(jump)})`);
  }
  // A step up from one platform to the next nearby one higher than a jump cannot be climbed.
  const tops = surfaces.map((p) => ({ id: p.id, x0: p.x, x1: p.x + p.width, top: p.y + p.height }));
  for (const p of tops) {
    if (p.top <= jump + 0.5) continue;
    const from = tops.filter((q) => q !== p && q.top < p.top && q.x1 >= p.x0 - 6 && q.x0 <= p.x1 + 6);
    if (from.length > 0 && Math.min(...from.map((q) => p.top - q.top)) > jump && !tops.some((q) => q !== p && q.top >= p.top && q.x1 >= p.x0 - 6 && q.x0 <= p.x1 + 6)) {
      out.push(`'${p.id}' is ${fmt(Math.min(...from.map((q) => p.top - q.top)))} tiles above the nearest lower platform (the player jumps ${fmt(jump)})`);
    }
  }
  return out;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
