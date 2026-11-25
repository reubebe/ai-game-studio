import { z } from "zod";

/**
 * Plugins describe what a module contributes. In this milestone only built-in plugins ship code;
 * external plugin manifests can be validated and listed but never executed (see ARCHITECTURE.md).
 */
export const PLUGIN_API = 1;

export const pluginManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, "Use a dotted id such as game.oware"),
    name: z.string().min(1).max(80),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().max(600),
    author: z.string().max(120),
    license: z.string().max(60),
    studioApi: z.literal(PLUGIN_API),
    status: z.enum(["stable", "foundation", "planned"]),
    kind: z.enum(["core", "genre", "education", "engine-target", "xr"]),
    contributes: z
      .object({
        ruleDomains: z.array(z.string()).default([]),
        templates: z.array(z.string()).default([]),
        dataKinds: z.array(z.string()).default([]),
        editors: z.array(z.string()).default([]),
        agentSkills: z.array(z.string()).default([]),
        engines: z.array(z.string()).default([]),
      })
      .strict(),
    requires: z.array(z.string()).default([]),
    limitations: z.array(z.string()).default([]),
    executesCode: z.boolean(),
  })
  .strict();

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

const builtin = (m: Omit<PluginManifest, "studioApi" | "author" | "license" | "executesCode"> & Partial<Pick<PluginManifest, "license">>): PluginManifest =>
  pluginManifestSchema.parse({ author: "Universal AI Game Studio", license: "Project license", studioApi: PLUGIN_API, executesCode: true, ...m });

export const BUILTIN_PLUGINS: PluginManifest[] = [
  builtin({
    id: "core.rules",
    name: "Visual rules",
    version: "1.0.0",
    description: "Engine-neutral rule graphs: events, flow, variables, math and logic; validation, compilation to IR and deterministic runtimes in TypeScript and GDScript.",
    status: "stable",
    kind: "core",
    contributes: { ruleDomains: ["core"], templates: ["logic-sandbox"], dataKinds: [], editors: ["rule-graph"], agentSkills: ["edit_rule_graph", "review_ruleset_provenance"], engines: ["studio-board", "godot"] },
    requires: [],
    limitations: ["No random-number node yet; rules are fully deterministic."],
  }),
  builtin({
    id: "game.oware",
    name: "Oware (Abapa)",
    version: "1.0.0",
    description: "Sourced Abapa ruleset as an editable graph, reference engine, computer opponent and board player.",
    status: "stable",
    kind: "genre",
    contributes: { ruleDomains: ["oware"], templates: ["oware-abapa", "oware-namnam"], dataKinds: [], editors: ["oware-board"], agentSkills: [], engines: ["studio-board"] },
    requires: ["core.rules"],
    limitations: ["Other mancala games (Ayò and regional variants) need their own documented rulesets."],
  }),
  builtin({
    id: "game.exploration3d",
    name: "3D exploration and adventure",
    version: "1.1.0",
    description: "Godot 4.7 template with a data-driven world layout, drag-and-drop world editor, collectibles, characters, gates, zones and rule-driven objectives; enemies with a melee attack, hearts and healing, pushable blocks and timers; imported models, characters, textures and sounds.",
    status: "stable",
    kind: "genre",
    contributes: { ruleDomains: ["explore"], templates: ["exploration-3d", "adventure-3d"], dataKinds: ["explore-world"], editors: ["world-map"], agentSkills: ["edit_world_layout"], engines: ["godot"] },
    requires: ["core.rules"],
    limitations: [
      "Enemies, hearts, pushable blocks, timers, imported models and textures work in Godot projects; the Unity and Unreal valleys keep collectibles, characters, gates and zones.",
      "Enemies fight in close combat only: no ranged attacks, and blocks can be pushed but not picked up or thrown.",
    ],
  }),
  builtin({
    id: "game.platformer2d",
    name: "2D platformer",
    version: "1.0.0",
    description: "Godot 4.7 side-scrolling template with a side-view level editor, coins, hazards, patrolling enemies, checkpoints, a coin-locked gate, sprite-sheet players and rule-driven objectives.",
    status: "stable",
    kind: "genre",
    contributes: { ruleDomains: ["platformer"], templates: ["platformer-2d"], dataKinds: ["platformer-level"], editors: ["level-side-view"], agentSkills: ["edit_platformer_level"], engines: ["godot"] },
    requires: ["core.rules"],
    limitations: ["One level per project.", "Godot projects only."],
  }),
  builtin({
    id: "game.ludo",
    name: "Ludo",
    version: "1.0.0",
    description: "Classic Ludo for 2 to 4 players, people or computer, with seeded dice that replay exactly and every house rule as a setting of the editable rule graph.",
    status: "stable",
    kind: "genre",
    contributes: { ruleDomains: ["ludo"], templates: ["ludo"], dataKinds: [], editors: ["ludo-board"], agentSkills: [], engines: ["studio-board"] },
    requires: ["core.rules"],
    limitations: ["Played inside the studio; no engine export and no online play."],
  }),
  builtin({
    id: "game.football",
    name: "Football",
    version: "1.0.0",
    description: "Godot 4.7 template for 2- to 5-a-side football against the computer on a walled pitch: passing, shooting, tackling, keepers, a match clock and rule-driven goals, full time and extra time; teams, colours, pitch and difficulty are match settings.",
    status: "stable",
    kind: "genre",
    contributes: { ruleDomains: ["football"], templates: ["football"], dataKinds: ["football-match"], editors: ["match-settings"], agentSkills: ["edit_match_settings"], engines: ["godot"] },
    requires: ["core.rules"],
    limitations: ["A walled pitch: no throw-ins, corners, offside or fouls.", "You play the home team against the computer; no second player or online play.", "Godot projects only."],
  }),
  builtin({
    id: "game.farm",
    name: "Farm simulation",
    version: "1.0.0",
    description: "Godot 4.7 top-down farming template: a painted tile map, crops defined as data (seed cost, growing days, yield, price, colour, watering, regrowth), days with rain, a market with rule-set prices, money and saved seasons.",
    status: "stable",
    kind: "genre",
    contributes: { ruleDomains: ["farm"], templates: ["farm-sim"], dataKinds: ["farm-sim"], editors: ["farm-map"], agentSkills: ["edit_farm"], engines: ["godot"] },
    requires: ["core.rules"],
    limitations: ["One farmer and one farm map; no animals, tools to upgrade or seasons beyond the rules' own.", "Godot projects only."],
  }),
  builtin({
    id: "rpg.creatures",
    name: "Creature collection",
    version: "0.1.0",
    description: "Original creature catalog with provenance, editable element chart and a deterministic encounter simulator.",
    status: "foundation",
    kind: "genre",
    contributes: { ruleDomains: [], templates: ["creature-collection"], dataKinds: ["creature-catalog"], editors: ["creature-catalog", "encounter"], agentSkills: ["design_original_creatures"], engines: ["studio-board"] },
    requires: [],
    limitations: ["No overworld, catching, quests or Godot runtime yet."],
  }),
  builtin({
    id: "edu.lessons",
    name: "Lessons and quizzes",
    version: "0.1.0",
    description: "Learning objectives, concepts, graded quizzes and evidence labels that separate illustrative from validated content.",
    status: "foundation",
    kind: "education",
    contributes: { ruleDomains: [], templates: ["science-lesson"], dataKinds: ["lesson"], editors: ["lesson", "quiz"], agentSkills: ["write_lesson_questions"], engines: ["studio-board"] },
    requires: [],
    limitations: ["Quizzes run in the studio; no simulation scenes or engine export yet."],
  }),
  builtin({
    id: "xr.openxr",
    name: "XR (OpenXR)",
    version: "0.1.0",
    description: "OpenXR project settings, an XR entry scene with stick locomotion and snap turning, and a hardware checklist.",
    status: "foundation",
    kind: "xr",
    contributes: { ruleDomains: [], templates: ["xr-foundation"], dataKinds: [], editors: [], agentSkills: [], engines: ["godot"] },
    requires: ["game.exploration3d"],
    limitations: ["Not verified on a headset.", "Godot XR Tools is not installed.", "Rules and collecting run only in desktop mode."],
  }),
  builtin({
    id: "engine.cpp-sfml",
    name: "C++ / SFML",
    version: "0.1.0",
    description: "CMake-based C++17 projects using SFML 3, built, tested and run from the studio.",
    status: "foundation",
    kind: "engine-target",
    contributes: { ruleDomains: [], templates: ["cpp-sfml-arcade"], dataKinds: [], editors: [], agentSkills: [], engines: ["cpp-sfml"] },
    requires: [],
    limitations: ["Studio rule graphs do not drive this template (the Unreal template has the C++ rule runtime); game settings come from a simple key=value file."],
  }),
];

export function pluginById(id: string): PluginManifest | undefined {
  return BUILTIN_PLUGINS.find((p) => p.id === id);
}

/** Validate an external plugin manifest. External plugins may only be declarative. */
export function checkExternalPlugin(input: unknown): { ok: true; plugin: PluginManifest } | { ok: false; errors: string[] } {
  const r = pluginManifestSchema.safeParse(input);
  if (!r.success) return { ok: false, errors: r.error.issues.map((i) => `${i.path.map(String).join(".") || "plugin"}: ${i.message}`) };
  const errors: string[] = [];
  if (r.data.executesCode) errors.push("External plugins cannot run code in this version of Game Studio.");
  if (BUILTIN_PLUGINS.some((p) => p.id === r.data.id)) errors.push(`'${r.data.id}' is reserved by a built-in plugin.`);
  for (const dep of r.data.requires) if (!pluginById(dep)) errors.push(`Requires unknown plugin '${dep}'.`);
  return errors.length ? { ok: false, errors } : { ok: true, plugin: r.data };
}

/** Dependency check for the modules a project enables. */
export function checkModules(modules: string[]): string[] {
  const problems: string[] = [];
  for (const m of modules) {
    const p = pluginById(m);
    if (!p) {
      problems.push(`Unknown module '${m}'.`);
      continue;
    }
    for (const dep of p.requires) if (!modules.includes(dep)) problems.push(`${p.name} needs ${pluginById(dep)?.name ?? dep}.`);
  }
  return problems;
}
