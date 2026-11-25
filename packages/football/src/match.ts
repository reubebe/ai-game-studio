import { z } from "zod";

/**
 * Engine-neutral settings of a football match. The Godot template's match.gd reads this file (synced to
 * res://gamestudio_data/match.json). The pitch is walled, as in indoor five-a-side, so the ball never
 * goes out of play: only goals stop it. Lengths are metres; the home team attacks the goal on the right
 * of the screen. The player controls the side named by `control`; the computer plays the rest.
 */
export const MATCH_SCHEMA_VERSION = "1.0.0";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a #rrggbb colour");

export const TEAM_SIDES = ["home", "away"] as const;
export type TeamSide = (typeof TEAM_SIDES)[number];
export const DIFFICULTIES = ["easy", "normal", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
/** Who the player controls: the home team, the away team, or nobody (watch the computer play both sides). */
export const CONTROLS = ["home", "away", "none"] as const;
export type Control = (typeof CONTROLS)[number];

/** A skill from 1 (weak) to 10 (excellent); 5 plays as the template's standard footballer. */
const skill = z.number().int().min(1).max(10);
export const PLAYER_SKILLS = ["pace", "shooting", "tackling"] as const;
export type PlayerSkill = (typeof PLAYER_SKILLS)[number];

/**
 * One footballer in a squad: a name, a shirt number and three skills. Pace sets running speed, shooting
 * the power and aim of shots, tackling how often a tackle wins the ball. The first in the squad keeps goal.
 */
export const playerSchema = z
  .object({
    name: z.string().trim().min(1).max(24),
    number: z.number().int().min(1).max(99),
    pace: skill,
    shooting: skill,
    tackling: skill,
  })
  .strict();
export type Player = z.infer<typeof playerSchema>;
/** Every squad lists five players (the most a side can field); a smaller side plays the first ones. */
export const SQUAD_SIZE = 5;

export const teamSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    /** Two to four capital letters or digits, shown on the scoreboard. */
    short: z.string().regex(/^[A-Z0-9]{2,4}$/, "Use 2 to 4 capital letters or digits"),
    shirt: color,
    shorts: color,
    /** The goalkeeper's shirt. */
    keeper: color,
    players: z.array(playerSchema).length(SQUAD_SIZE, `List ${SQUAD_SIZE} players; a smaller side plays the first ones`),
  })
  .strict()
  .superRefine((t, ctx) => {
    const seen = new Set<number>();
    t.players.forEach((p, i) => {
      if (seen.has(p.number)) ctx.addIssue({ code: "custom", path: ["players", i, "number"], message: `Shirt number ${p.number} is used twice` });
      seen.add(p.number);
    });
  });
export type Team = z.infer<typeof teamSchema>;

export const matchSchema = z
  .object({
    schemaVersion: z.literal(MATCH_SCHEMA_VERSION),
    kind: z.literal("football-match"),
    name: z.string().trim().min(1).max(80),
    /** Players on each side, the goalkeeper included. */
    teamSize: z.number().int().min(2).max(5),
    /** Minutes of play; the clock stops for goals and kick-offs. */
    minutes: z.number().min(1).max(20),
    /** How quick, sharp and accurate the computer's players are. */
    difficulty: z.enum(DIFFICULTIES),
    /** The side the player controls ("none" to watch the computer play both). */
    control: z.enum(CONTROLS).default("home"),
    home: teamSchema,
    away: teamSchema,
    pitch: z
      .object({
        length: z.number().min(24).max(70),
        width: z.number().min(14).max(45),
        goalWidth: z.number().min(2).max(7.5),
        grass: color,
        lines: color,
        stripes: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.pitch.goalWidth > m.pitch.width - 6) ctx.addIssue({ code: "custom", path: ["pitch", "goalWidth"], message: "The goals must be at least 6 m narrower than the pitch" });
    if (m.home.short === m.away.short) ctx.addIssue({ code: "custom", path: ["away", "short"], message: "The two teams need different short names" });
  });

export type Match = z.infer<typeof matchSchema>;

export function parseMatch(input: unknown): { ok: true; match: Match } | { ok: false; errors: string[] } {
  const r = matchSchema.safeParse(input);
  if (r.success) return { ok: true, match: r.data };
  return { ok: false, errors: r.error.issues.slice(0, 30).map((i) => `${i.path.map(String).join(".") || "match"}: ${i.message}`) };
}

/**
 * Where each player starts a kick-off, as fractions of the team's half: x from its own goal line (0) to
 * the halfway line (1), z across the pitch from -1 to 1. The first is the goalkeeper. The Godot game uses
 * the same table (match.gd, FORMATIONS); keep them together.
 */
export const FORMATIONS: Record<number, { x: number; z: number }[]> = {
  2: [{ x: 0.04, z: 0 }, { x: 0.8, z: 0 }],
  3: [{ x: 0.04, z: 0 }, { x: 0.45, z: -0.35 }, { x: 0.8, z: 0.35 }],
  4: [{ x: 0.04, z: 0 }, { x: 0.4, z: -0.45 }, { x: 0.4, z: 0.45 }, { x: 0.85, z: 0 }],
  5: [{ x: 0.04, z: 0 }, { x: 0.35, z: -0.45 }, { x: 0.35, z: 0.45 }, { x: 0.75, z: -0.35 }, { x: 0.85, z: 0.35 }],
};

/** "Harbour Cup Final": an original five-a-side final against the computer. */
export function harbourCup(): Match {
  return {
    schemaVersion: MATCH_SCHEMA_VERSION,
    kind: "football-match",
    name: "Harbour Cup Final",
    teamSize: 5,
    minutes: 4,
    difficulty: "normal",
    control: "home",
    home: {
      name: "Harbour Lions",
      short: "HAR",
      shirt: "#e5484d",
      shorts: "#ffffff",
      keeper: "#f2b84b",
      players: [
        { name: "Kwame Ofori", number: 1, pace: 5, shooting: 3, tackling: 5 },
        { name: "Ines Laurent", number: 4, pace: 6, shooting: 4, tackling: 7 },
        { name: "Tunde Adebayo", number: 5, pace: 5, shooting: 5, tackling: 7 },
        { name: "Mei Hayashi", number: 8, pace: 7, shooting: 6, tackling: 5 },
        { name: "Kofi Antwi", number: 9, pace: 8, shooting: 8, tackling: 3 },
      ],
    },
    away: {
      name: "Hilltop Rovers",
      short: "HIL",
      shirt: "#3b82f6",
      shorts: "#1e293b",
      keeper: "#22c55e",
      players: [
        { name: "Lars Brekke", number: 1, pace: 5, shooting: 3, tackling: 5 },
        { name: "Ama Sarpong", number: 3, pace: 6, shooting: 4, tackling: 7 },
        { name: "Diego Varela", number: 6, pace: 5, shooting: 5, tackling: 6 },
        { name: "Yaw Ansah", number: 7, pace: 7, shooting: 6, tackling: 5 },
        { name: "Nina Kovac", number: 10, pace: 7, shooting: 8, tackling: 4 },
      ],
    },
    pitch: { length: 40, width: 24, goalWidth: 4, grass: "#3f8f3a", lines: "#f5f5f0", stripes: true },
  };
}
