import { nodeRunsOn, type NodeRegistry, type RuleGraph } from "@gamestudio/rules-core";
import type { ProjectDocs } from "./apply";
import type { OperationKind } from "./operations";
import { skill } from "./skills";

export interface AgentDef {
  id: string;
  name: string;
  role: string;
  boundary: string;
  skills: string[];
  /** Whether the agent can work on this project at all. */
  available: (docs: ProjectDocs) => boolean;
  context: (docs: ProjectDocs, registry: NodeRegistry) => string;
}

export function allowedOperations(agent: AgentDef): OperationKind[] {
  return [...new Set(agent.skills.flatMap((s) => skill(s).toolsAllowed))];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function worldContext(docs: ProjectDocs): string {
  if (!docs.world) return "No world layout.";
  const w = docs.world.world;
  const objects = w.objects.map((o) => {
    const extra = Object.entries(o)
      .filter(([k]) => !["id", "type", "x", "z", "rotation", "scale"].includes(k))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    return `- ${o.id} ${o.type} at (${o.x}, ${o.z})${o.rotation ? ` rot=${o.rotation}` : ""}${o.scale !== 1 ? ` scale=${o.scale}` : ""}${extra ? ` ${extra}` : ""}`;
  });
  const clips = docs.assets?.clips ?? {};
  const assets = docs.assets
    ? [
        `Imported model files (use as a model's asset, a villager's model or the player's character): ${docs.assets.models.map((m) => (clips[m] ? `${m} (animations: ${clips[m]!.join(", ") || "none"})` : m)).join(", ") || "none yet (the user can import some, or add characters from the free library, in Assets)"}`,
        `Texture files (for groundTexture): ${docs.assets.textures.join(", ") || "none yet"}`,
        `Sound files (for world.audio): ${(docs.assets.audio ?? []).join(", ") || "none yet"}`,
        `Photographed sky files (for skyImage): ${(docs.assets.skies ?? []).join(", ") || "none yet (the user can get one in Assets, Free library, Skies)"}`,
      ]
    : ["Imported models and characters: not available for this engine (Godot projects only)."];
  return [
    ...assets,
    `World "${w.name}" (${docs.world.path}): ${w.size.width} m wide (x from ${-w.size.width / 2} to ${w.size.width / 2}), ${w.size.depth} m deep (z from ${-w.size.depth / 2} to ${w.size.depth / 2}).`,
    `Environment: ${JSON.stringify(w.environment)}`,
    `Player: ${JSON.stringify(w.player)}`,
    `Objects (${w.objects.length}):`,
    ...objects,
  ].join("\n");
}

export function levelContext(docs: ProjectDocs): string {
  if (!docs.level) return "No platformer level.";
  const l = docs.level.level;
  const objects = l.objects.map((o) => {
    const extra = Object.entries(o)
      .filter(([k]) => !["id", "type", "x", "y"].includes(k))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    return `- ${o.id} ${o.type} at (${o.x}, ${o.y})${extra ? ` ${extra}` : ""}`;
  });
  return [
    `Level "${l.name}" (${docs.level.path}): ${l.size.width} tiles wide, ${l.size.height} tall. x from 0 (left) to ${l.size.width}; y from 0 (bottom) up.`,
    `Background: ${JSON.stringify(l.background)}`,
    `Player: ${JSON.stringify(l.player)} (speed in tiles per second, jumpHeight in tiles)`,
    `Sprite sheets in the project (for level.sprite): ${docs.assets?.textures.filter((t) => /\.(png|webp)$/i.test(t)).join(", ") || "none yet"}`,
    `Sound files (for level.audio): ${(docs.assets?.audio ?? []).join(", ") || "none yet"}`,
    `Objects (${l.objects.length}):`,
    ...objects,
  ].join("\n");
}

function graphSummary(id: string, path: string, g: RuleGraph, registry: NodeRegistry): string {
  const nodes = g.nodes.map((n) => `- ${n.id}: ${n.type} (${registry.get(n.type)?.title ?? "unknown"}) at (${Math.round(n.position.x)}, ${Math.round(n.position.y)})${Object.keys(n.params).length ? ` params=${JSON.stringify(n.params)}` : ""}`);
  const edges = g.edges.map((e) => `- ${e.source}.${e.sourceHandle} -> ${e.target}.${e.targetHandle}`);
  return [`Graph "${id}" (${path}), domain ${g.domain}: ${g.name}`, `Variables: ${JSON.stringify(g.variables)}`, "Nodes:", ...nodes, "Connections:", ...edges].join("\n");
}

/** The nodes a graph of `domain` can use, for the prompt; with an engine, only nodes that engine's game runs. */
export function paletteContext(domain: string, registry: NodeRegistry, engine?: string): string {
  return registry
    .forGraphDomain(domain)
    .filter((s) => !engine || nodeRunsOn(s, engine))
    .map((s) => {
      const pins = (list: typeof s.inputs) => list.map((p) => `${p.kind}:${p.id}${p.kind === "data" ? `<${p.type}>` : ""}`).join(", ") || "none";
      const params = s.params.map((p) => `${p.id}:${p.kind}=${JSON.stringify(p.default)}`).join(", ");
      return `- ${s.type} "${s.title}": ${clip(s.description, 140)} | in: ${pins(s.inputs)} | out: ${pins(s.outputs)}${params ? ` | settings: ${params}` : ""}`;
    })
    .join("\n");
}

export function rulesContext(docs: ProjectDocs, registry: NodeRegistry): string {
  const graphs = Object.entries(docs.rules);
  if (graphs.length === 0) return "No rule graphs.";
  const domains = [...new Set(graphs.map(([, g]) => g.graph.domain))];
  return [...graphs.map(([id, g]) => graphSummary(id, g.path, g.graph, registry)), ...domains.map((d) => `Node palette for domain ${d}:\n${paletteContext(d, registry, docs.manifest.engine.id)}`)].join("\n\n");
}

export const AGENTS: AgentDef[] = [
  {
    id: "world-builder",
    name: "World Builder",
    role: "Places, moves and configures objects in the 3D exploration layout, and tunes the player and environment.",
    boundary: "Changes only the world layout. Cannot edit rules or files.",
    skills: ["edit_world_layout"],
    available: (d) => Boolean(d.world),
    context: (d) => worldContext(d),
  },
  {
    id: "level-designer",
    name: "Level Designer",
    role: "Lays out 2D platformer levels: platforms, coins, hazards, enemies, checkpoints and the goal, plus the player's movement and the level's colours.",
    boundary: "Changes only the platformer level. Cannot edit rules or files.",
    skills: ["edit_platformer_level"],
    available: (d) => Boolean(d.level),
    context: (d) => levelContext(d),
  },
  {
    id: "farm-designer",
    name: "Farm Designer",
    role: "Shapes farm simulations: the map (soil, paths, water, the house and the stall), the crops and their economy, the farmer, the days and the rain.",
    boundary: "Changes only the farm's settings and map. Cannot edit rules or files.",
    skills: ["edit_farm"],
    available: (d) => Boolean(d.farm),
    context: (d) => {
      if (!d.farm) return "No farm.";
      const { map, ...settings } = d.farm.farm;
      const rows = map.rows.map((r, y) => `${String(y).padStart(2, " ")} ${r}`).join("\n");
      return [
        `Farm settings (${d.farm.path}):\n${JSON.stringify(settings, null, 1)}`,
        `Map: ${map.width} wide (x 0 to ${map.width - 1}), ${map.height} tall (y 0 to ${map.height - 1}); the farmer starts at (${map.spawn.x}, ${map.spawn.y}). Letters: g grass, s soil, p path, w water, t tree, f fence, h house, m market stall. Rows top to bottom, each prefixed by its y:`,
        rows,
      ].join("\n");
    },
  },
  {
    id: "match-designer",
    name: "Match Designer",
    role: "Sets up football matches: the teams' names and colours, players a side, the length, the computer's skill and the pitch.",
    boundary: "Changes only the match settings. Cannot edit rules or files.",
    skills: ["edit_match_settings"],
    available: (d) => Boolean(d.match),
    context: (d) => (d.match ? `Match settings (${d.match.path}):\n${JSON.stringify(d.match.match, null, 1)}` : "No match settings."),
  },
  {
    id: "rules-engineer",
    name: "Rules Engineer",
    role: "Implements game rules, events and house rules as changes to the visual rule graphs.",
    boundary: "Changes only rule graphs, which must still validate. Cannot invent cultural provenance.",
    skills: ["edit_rule_graph"],
    available: (d) => Object.keys(d.rules).length > 0,
    context: (d, r) => [rulesContext(d, r), d.world ? `\nFor reference, ${worldContext(d)}` : "", d.level ? `\nFor reference, ${levelContext(d)}` : ""].join("\n"),
  },
  {
    id: "creature-designer",
    name: "Creature Designer",
    role: "Proposes original creatures and balanced stats for the creature catalog.",
    boundary: "Original designs only. Changes only the creature catalog.",
    skills: ["design_original_creatures"],
    available: (d) => Boolean(d.catalog),
    context: (d) => (d.catalog ? `Creature catalog (${d.catalog.path}):\n${JSON.stringify(d.catalog.catalog, null, 1)}` : "No catalog."),
  },
  {
    id: "lesson-designer",
    name: "Educational Design",
    role: "Connects learning objectives to quiz questions and feedback.",
    boundary: "Cannot claim scientific validation. Changes only lessons.",
    skills: ["write_lesson_questions"],
    available: (d) => Object.keys(d.lessons).length > 0,
    context: (d) => Object.entries(d.lessons).map(([id, l]) => `Lesson "${id}" (${l.path}):\n${JSON.stringify(l.lesson, null, 1)}`).join("\n\n"),
  },
  {
    id: "rules-reviewer",
    name: "Rule & Cultural Reviewer",
    role: "Reviews rule variants, terminology and sources, and reports what is documented and what is not.",
    boundary: "Read-only. Proposes no changes and never invents provenance.",
    skills: ["review_ruleset_provenance"],
    available: (d) => Object.keys(d.rules).length > 0,
    context: (d, r) => [rulesContext(d, r), ...Object.values(d.rules).map((g) => `Provenance for ${g.graph.id}: ${JSON.stringify(g.graph.provenance ?? "none recorded")}`)].join("\n\n"),
  },
];

export function agentById(id: string): AgentDef {
  const a = AGENTS.find((x) => x.id === id);
  if (!a) throw new Error(`Unknown agent '${id}'`);
  return a;
}

/**
 * The Producer role: a deterministic router (no model call) that picks one specialist for a
 * request, following the blueprint's "choose one primary agent" rule.
 */
export function routeRequest(text: string, docs: ProjectDocs): { agent: AgentDef; reason: string } {
  const t = text.toLowerCase();
  const has = (words: string[]) => words.some((w) => new RegExp(`\\b${w}`).test(t));
  const candidates: [string, string[], string][] = [
    ["rules-reviewer", ["review", "check the rules", "sources?", "provenance", "cultur", "authentic", "document"], "asks for a review of rules or sources"],
    ["creature-designer", ["creature", "monster", "companion", "stat", "element"], "mentions creatures"],
    ["lesson-designer", ["lesson", "quiz", "question", "objective", "learner", "student"], "mentions lessons or quizzes"],
    ["rules-engineer", ["rule", "node", "graph", "capture", "sow", "seed", "pit", "turn", "score", "when ", "if ", "event", "objective text", "message", "dialogue", "gate open", "timer", "countdown", "heal", "hurt"], "mentions rules or game logic"],
    ["farm-designer", ["crop", "seed", "soil", "field", "plant", "pond", "fence", "farmer", "farm", "map", "layout", "bigger", "smaller", "rain", "day length", "starting money", "currency", "harvest"], "mentions the farm's settings or map"],
    ["match-designer", ["team", "kit", "shirt", "colour", "color", "pitch", "minute", "difficulty", "harder", "easier", "a side", "players", "club", "stadium", "goal width", "name"], "mentions the match settings"],
    ["level-designer", ["level", "platform", "ledge", "coin", "spike", "beetle", "enemy", "checkpoint", "flag", "jump", "gap", "door", "sky", "hill", "harder", "easier", "player", "speed", "gravity", "sign"], "mentions the level layout"],
    ["world-builder", ["world", "place", "move", "model", "texture", "quality", "graphics", "tree", "rock", "crystal", "npc", "villager", "gate", "sky", "fog", "sun", "speed", "jump", "player", "map", "torch", "water", "lake", "sign", "zone", "enem", "beetle", "block", "crate", "plate", "health", "hearts", "harder", "easier"], "mentions the world layout"],
  ];
  for (const [id, words, reason] of candidates) {
    const agent = agentById(id);
    if (has(words) && agent.available(docs)) return { agent, reason: `The request ${reason}.` };
  }
  const fallback = AGENTS.find((a) => a.available(docs) && a.id !== "rules-reviewer") ?? AGENTS[0]!;
  return { agent: fallback, reason: "Default specialist for this project." };
}
