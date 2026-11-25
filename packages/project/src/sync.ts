import { compileGraph, engineDiagnostics, type Diagnostic, type NodeRegistry, type RuleGraph } from "@gamestudio/rules-core";
import { parseWorld } from "@gamestudio/explore";
import { parseLevel } from "@gamestudio/platformer";
import { parseMatch } from "@gamestudio/football";
import { parseFarm } from "@gamestudio/farm";
import type { ProjectManifest } from "./manifest";
import type { GeneratedFile } from "./templates/common";

export interface SyncProblem {
  source: string;
  messages: string[];
}

export interface SyncPlan {
  /** True when every rule graph compiled and every engine data file validated. */
  ok: boolean;
  writes: GeneratedFile[];
  problems: SyncProblem[];
}

/** Where an engine project reads the studio's data: res://gamestudio_data in Godot, StreamingAssets in Unity, Content/GameStudioData in Unreal. */
export function engineDataDir(manifest: ProjectManifest): string | null {
  if (manifest.engine.id === "godot") return `${manifest.engine.projectDir}/gamestudio_data`;
  if (manifest.engine.id === "unity") return `${manifest.engine.projectDir}/Assets/StreamingAssets/gamestudio_data`;
  if (manifest.engine.id === "unreal") return `${manifest.engine.projectDir}/Content/GameStudioData`;
  return null;
}

/**
 * Engine data for Godot and Unity projects: compiled rules and the validated layout, in engineDataDir.
 * Rules are written only when every graph compiles, so the game never runs a half-updated rule set.
 */
export function planEngineSync(manifest: ProjectManifest, documents: Record<string, unknown>, registry: NodeRegistry): SyncPlan {
  const problems: SyncProblem[] = [];
  const writes: GeneratedFile[] = [];
  const dataDir = engineDataDir(manifest);
  if (!dataDir) return { ok: true, writes, problems };

  const programs: { id: string; path: string; json: string; hash: string }[] = [];
  for (const entry of manifest.rules) {
    const doc = documents[entry.path];
    if (doc === undefined) {
      problems.push({ source: entry.path, messages: ["The rule graph file is missing."] });
      continue;
    }
    const result = compileGraph(doc, registry);
    if (!result.ok || !result.program) {
      problems.push({ source: entry.path, messages: result.diagnostics.filter((d: Diagnostic) => d.severity === "error").map((d) => d.message) });
      continue;
    }
    // A graph that compiles may still use nodes this engine's game cannot run (enemies and timers are Godot's).
    const limits = engineDiagnostics(doc as RuleGraph, registry, manifest.engine.id);
    if (limits.length > 0) {
      problems.push({ source: entry.path, messages: limits.map((d) => d.message) });
      continue;
    }
    programs.push({ id: entry.id, path: entry.path, json: JSON.stringify(result.program, null, 2) + "\n", hash: result.program.sourceHash });
  }
  if (problems.length === 0) {
    for (const p of programs) writes.push({ path: `${dataDir}/rules/${p.id}.ir.json`, content: p.json });
    writes.push({
      path: `${dataDir}/rules_index.json`,
      content: JSON.stringify({ programs: programs.map((p) => `${p.id}.ir.json`), sources: Object.fromEntries(programs.map((p) => [p.id, { path: p.path, hash: p.hash }])) }, null, 2) + "\n",
    });
  }

  for (const entry of manifest.data) {
    if (entry.kind === "platformer-level") {
      const level = parseLevel(documents[entry.path]);
      if (!level.ok) problems.push({ source: entry.path, messages: level.errors });
      else writes.push({ path: `${dataDir}/level.json`, content: JSON.stringify(level.level, null, 2) + "\n" });
      continue;
    }
    if (entry.kind === "football-match") {
      const match = parseMatch(documents[entry.path]);
      if (!match.ok) problems.push({ source: entry.path, messages: match.errors });
      else writes.push({ path: `${dataDir}/match.json`, content: JSON.stringify(match.match, null, 2) + "\n" });
      continue;
    }
    if (entry.kind === "farm-sim") {
      const farm = parseFarm(documents[entry.path]);
      if (!farm.ok) problems.push({ source: entry.path, messages: farm.errors });
      else writes.push({ path: `${dataDir}/farm.json`, content: JSON.stringify(farm.farm, null, 2) + "\n" });
      continue;
    }
    if (entry.kind !== "explore-world") continue;
    const parsed = parseWorld(documents[entry.path]);
    if (!parsed.ok) {
      problems.push({ source: entry.path, messages: parsed.errors });
      continue;
    }
    writes.push({ path: `${dataDir}/world.json`, content: JSON.stringify(parsed.world, null, 2) + "\n" });
  }
  return { ok: problems.length === 0, writes, problems };
}
