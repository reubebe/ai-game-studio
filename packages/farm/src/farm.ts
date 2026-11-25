import { z } from "zod";

/**
 * Engine-neutral settings of a farm simulation. The Godot template's farm.gd reads this file (synced to
 * res://gamestudio_data/farm.json). The farm is a grid of tiles seen from above; the farmer walks it,
 * plants seeds on soil, waters them, harvests what has grown, sells at the market stall and sleeps in the
 * house to start the next day. Every crop is defined here, so a farm can grow anything.
 */
export const FARM_SCHEMA_VERSION = "1.0.0";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a #rrggbb colour");
const cropId = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/, "Use lowercase letters, digits and underscores");

/** Map tiles, one letter each in the map's rows. */
export const TILES = {
  g: "grass",
  s: "soil",
  p: "path",
  w: "water",
  t: "tree",
  f: "fence",
  h: "house",
  m: "market",
} as const;
export type TileLetter = keyof typeof TILES;
export type TileName = (typeof TILES)[TileLetter];
export const TILE_LETTERS = Object.keys(TILES) as TileLetter[];
/** Tiles the farmer cannot walk onto. */
export const BLOCKING: readonly TileLetter[] = ["w", "t", "f", "h", "m"];

export const cropSchema = z
  .object({
    id: cropId,
    name: z.string().trim().min(1).max(24),
    /** Coins for one seed (one tile). */
    seedCost: z.number().int().min(0).max(10000),
    /** Days of growth (watered days, when the crop needs water) before it can be harvested. */
    days: z.number().int().min(1).max(30),
    /** How many come off one tile at harvest. */
    yield: z.number().int().min(1).max(20),
    /** Coins the market pays for one. */
    price: z.number().int().min(0).max(10000),
    color: color,
    /** Grows only on days it was watered (or rained on). */
    needsWater: z.boolean(),
    /** Grows again after harvest in this many days (0: the tile is bare again). */
    regrow: z.number().int().min(0).max(30),
  })
  .strict();
export type Crop = z.infer<typeof cropSchema>;

export const farmSchema = z
  .object({
    schemaVersion: z.literal(FARM_SCHEMA_VERSION),
    kind: z.literal("farm-sim"),
    name: z.string().trim().min(1).max(80),
    farmer: z.object({ name: z.string().trim().min(1).max(24), shirt: color }).strict(),
    /** What the money is called on screen ("coins", "cedis" ...). */
    currency: z.string().trim().min(1).max(12),
    startMoney: z.number().int().min(0).max(1000000),
    /** Seconds of play in a day; sleeping in the house ends it early. */
    dayLength: z.number().min(20).max(900),
    /** The chance (0 to 1) that a new day brings rain, which waters every crop. */
    rainChance: z.number().min(0).max(1),
    crops: z.array(cropSchema).min(1).max(8),
    map: z
      .object({
        width: z.number().int().min(8).max(40),
        height: z.number().int().min(6).max(30),
        /** One string per row, top to bottom, one tile letter per column (see TILES). */
        rows: z.array(z.string()),
        /** Where the farmer wakes each morning (a tile). */
        spawn: z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }).strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((farm, ctx) => {
    const ids = new Set<string>();
    farm.crops.forEach((c, i) => {
      if (ids.has(c.id)) ctx.addIssue({ code: "custom", path: ["crops", i, "id"], message: `Crop id '${c.id}' is used twice` });
      ids.add(c.id);
    });
    const { width, height, rows, spawn } = farm.map;
    if (rows.length !== height) ctx.addIssue({ code: "custom", path: ["map", "rows"], message: `The map needs ${height} rows, not ${rows.length}` });
    rows.forEach((row, y) => {
      if (row.length !== width) ctx.addIssue({ code: "custom", path: ["map", "rows", y], message: `Row ${y + 1} needs ${width} tiles, not ${row.length}` });
      const bad = [...row].find((ch) => !(ch in TILES));
      if (bad !== undefined) ctx.addIssue({ code: "custom", path: ["map", "rows", y], message: `Row ${y + 1} has an unknown tile '${bad}'` });
    });
    const all = rows.join("");
    if (!all.includes("h")) ctx.addIssue({ code: "custom", path: ["map"], message: "The farm needs a house (to sleep and start the next day)" });
    if (!all.includes("m")) ctx.addIssue({ code: "custom", path: ["map"], message: "The farm needs a market stall (to sell the harvest)" });
    if (!all.includes("s")) ctx.addIssue({ code: "custom", path: ["map"], message: "The farm needs soil to plant on" });
    const at = rows[spawn.y]?.[spawn.x];
    if (at === undefined) ctx.addIssue({ code: "custom", path: ["map", "spawn"], message: "The farmer's start is outside the map" });
    else if (BLOCKING.includes(at as TileLetter)) ctx.addIssue({ code: "custom", path: ["map", "spawn"], message: `The farmer cannot start on ${TILES[at as TileLetter]}` });
  });
export type Farm = z.infer<typeof farmSchema>;

export function parseFarm(input: unknown): { ok: true; farm: Farm } | { ok: false; errors: string[] } {
  const r = farmSchema.safeParse(input);
  if (r.success) return { ok: true, farm: r.data };
  return { ok: false, errors: r.error.issues.slice(0, 30).map((i) => `${i.path.map(String).join(".") || "farm"}: ${i.message}`) };
}

/** The tile letter at a cell, or null outside the map. */
export function tileAt(farm: Farm, x: number, y: number): TileLetter | null {
  const ch = farm.map.rows[y]?.[x];
  return ch !== undefined && ch in TILES ? (ch as TileLetter) : null;
}

/** A copy of the map with one tile changed (the editor's paint brush). */
export function paintTile(farm: Farm, x: number, y: number, tile: TileLetter): Farm {
  const rows = farm.map.rows.map((row, ry) => (ry === y ? row.slice(0, x) + tile + row.slice(x + 1) : row));
  return { ...farm, map: { ...farm.map, rows } };
}

/** A copy of the map at a new size: kept tiles stay where they are, new ones are grass. */
export function resizeMap(farm: Farm, width: number, height: number): Farm {
  const rows = Array.from({ length: height }, (_, y) => {
    const old = farm.map.rows[y] ?? "";
    return (old + "g".repeat(width)).slice(0, width);
  });
  const spawn = { x: Math.min(farm.map.spawn.x, width - 1), y: Math.min(farm.map.spawn.y, height - 1) };
  return { ...farm, map: { width, height, rows, spawn } };
}

/** "Sunrise Acres": an original starter farm with four crops, a pond, the house and the market stall. */
export function sunriseAcres(): Farm {
  const rows = [
    "tttttttttttttttttttt",
    "tggggggggggggggggggt",
    "tghhgggggggggggmmggt",
    "tghhgppppppppppmmggt",
    "tggpppgggggggggpgggt",
    "tggpggssssssssgpgggt",
    "tggpggssssssssgpgwwt",
    "tggpggssssssssgpgwwt",
    "tggpggssssssssgpgggt",
    "tggppppppppppppppggt",
    "tgggggffffffffggggtt",
    "tttttttttttttttttttt",
  ];
  return {
    schemaVersion: FARM_SCHEMA_VERSION,
    kind: "farm-sim",
    name: "Sunrise Acres",
    farmer: { name: "Esi", shirt: "#e8833a" },
    currency: "coins",
    startMoney: 60,
    dayLength: 90,
    rainChance: 0.25,
    crops: [
      { id: "okra", name: "Okra", seedCost: 4, days: 2, yield: 2, price: 5, color: "#5aa832", needsWater: true, regrow: 0 },
      { id: "tomato", name: "Tomato", seedCost: 8, days: 3, yield: 3, price: 6, color: "#e5484d", needsWater: true, regrow: 2 },
      { id: "maize", name: "Maize", seedCost: 10, days: 4, yield: 4, price: 7, color: "#f2c94c", needsWater: true, regrow: 0 },
      { id: "cassava", name: "Cassava", seedCost: 15, days: 6, yield: 5, price: 12, color: "#b9875a", needsWater: false, regrow: 0 },
    ],
    map: { width: 20, height: 12, rows, spawn: { x: 4, y: 4 } },
  };
}
