import { z } from "zod";

/**
 * Creature catalog for the creature-collection foundation. Every bundled creature, name,
 * element and formula is original to this project; user catalogs record provenance so
 * licensed or third-party designs can be tracked explicitly.
 */
export const CATALOG_SCHEMA_VERSION = "1.0.0";

export const elementSchema = z.enum(["plain", "sun", "river", "forest"]);
export type Element = z.infer<typeof elementSchema>;

const key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Use lowercase letters, digits and underscores");

export const moveSchema = z
  .object({
    id: key,
    name: z.string().trim().min(1).max(40),
    element: elementSchema,
    power: z.number().int().min(10).max(120),
    description: z.string().max(300),
  })
  .strict();

export const creatureSchema = z
  .object({
    id: key,
    name: z.string().trim().min(1).max(40),
    element: elementSchema,
    description: z.string().max(600),
    stats: z
      .object({
        hp: z.number().int().min(1).max(255),
        attack: z.number().int().min(1).max(255),
        defense: z.number().int().min(1).max(255),
        speed: z.number().int().min(1).max(255),
      })
      .strict(),
    moves: z.array(moveSchema).min(1).max(4),
    provenance: z
      .object({
        origin: z.enum(["original", "licensed", "third-party"]),
        author: z.string().max(120),
        license: z.string().max(120),
        notes: z.string().max(600),
      })
      .strict(),
  })
  .strict();

export type Move = z.infer<typeof moveSchema>;
export type Creature = z.infer<typeof creatureSchema>;

export const catalogSchema = z
  .object({
    schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
    kind: z.literal("creature-catalog"),
    /** Multiplier when an attacking element meets a defending element; missing pairs are 1. */
    effectiveness: z.record(z.string(), z.record(z.string(), z.number().min(0).max(4))),
    creatures: z.array(creatureSchema).max(500),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const ids = new Set<string>();
    catalog.creatures.forEach((c, i) => {
      if (ids.has(c.id)) ctx.addIssue({ code: "custom", path: ["creatures", i, "id"], message: `Creature id '${c.id}' is used twice` });
      ids.add(c.id);
      const moveIds = new Set<string>();
      c.moves.forEach((m, j) => {
        if (moveIds.has(m.id)) ctx.addIssue({ code: "custom", path: ["creatures", i, "moves", j, "id"], message: `Move id '${m.id}' is used twice in ${c.name}` });
        moveIds.add(m.id);
      });
    });
    for (const [attacker, row] of Object.entries(catalog.effectiveness)) {
      if (!elementSchema.safeParse(attacker).success) ctx.addIssue({ code: "custom", path: ["effectiveness", attacker], message: `Unknown element '${attacker}'` });
      for (const defender of Object.keys(row)) {
        if (!elementSchema.safeParse(defender).success) ctx.addIssue({ code: "custom", path: ["effectiveness", attacker, defender], message: `Unknown element '${defender}'` });
      }
    }
  });

export type Catalog = z.infer<typeof catalogSchema>;

export function parseCatalog(input: unknown): { ok: true; catalog: Catalog } | { ok: false; errors: string[] } {
  const r = catalogSchema.safeParse(input);
  if (r.success) return { ok: true, catalog: r.data };
  return { ok: false, errors: r.error.issues.slice(0, 30).map((i) => `${i.path.map(String).join(".") || "catalog"}: ${i.message}`) };
}

const ORIGINAL = { origin: "original" as const, author: "Universal AI Game Studio sample", license: "Project sample content", notes: "Original design created for this studio's starter template." };

/** Three original starter creatures for "Forest Quest"-style projects. */
export function starterCatalog(): Catalog {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    kind: "creature-catalog",
    effectiveness: {
      sun: { forest: 1.5, river: 0.75 },
      river: { sun: 1.5, forest: 0.75 },
      forest: { river: 1.5, sun: 0.75 },
    },
    creatures: [
      {
        id: "emberpip",
        name: "Emberpip",
        element: "sun",
        description: "A sparrow-sized bird whose tail feathers glow like coals at dusk.",
        stats: { hp: 52, attack: 58, defense: 40, speed: 70 },
        moves: [
          { id: "peck", name: "Peck", element: "plain", power: 35, description: "A quick jab with the beak." },
          { id: "cinder_flick", name: "Cinder Flick", element: "sun", power: 50, description: "Flicks warm sparks from its tail." },
        ],
        provenance: ORIGINAL,
      },
      {
        id: "ripplet",
        name: "Ripplet",
        element: "river",
        description: "A sleek otter pup that hums to find fish under the reeds.",
        stats: { hp: 60, attack: 50, defense: 52, speed: 55 },
        moves: [
          { id: "nip", name: "Nip", element: "plain", power: 30, description: "A playful but sharp bite." },
          { id: "splash_tail", name: "Splash Tail", element: "river", power: 48, description: "Slaps the water to send a heavy wave." },
        ],
        provenance: ORIGINAL,
      },
      {
        id: "mossback",
        name: "Mossback",
        element: "forest",
        description: "A slow tortoise carrying a garden of moss and tiny flowers on its shell.",
        stats: { hp: 75, attack: 44, defense: 68, speed: 30 },
        moves: [
          { id: "shell_bump", name: "Shell Bump", element: "plain", power: 32, description: "Rolls forward into the opponent." },
          { id: "vine_snap", name: "Vine Snap", element: "forest", power: 46, description: "Whips a vine from the shell garden." },
        ],
        provenance: ORIGINAL,
      },
    ],
  };
}
