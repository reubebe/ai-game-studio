import { cliffRules, sunsetCliffs } from "@gamestudio/platformer";
import fixtures from "../../../rules-core/src/conformance/fixtures.json?raw";
import { createStudioRegistry } from "../registry";
import { planEngineSync } from "../sync";
import { EXPORTS_DIR, godotPresets } from "../export";
import { baseManifest, commonFiles, finalize, json, type GenerateOptions, type GeneratedFile, type GeneratedProject } from "./common";
import { GODOT_DIR, GODOT_VERSION, godotString } from "./exploration";

const PLATFORMER_FILES = import.meta.glob("../../../../templates/platformer-2d/godot/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const RUNTIME_FILES = import.meta.glob("../../../../engine-addons/godot/gamestudio_runtime/**/*.gd", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Files of the 2D platformer's Godot project and the shared rules runtime, with the title filled in. */
export function platformerTemplateFiles(title: string, description: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const [key, content] of Object.entries(PLATFORMER_FILES)) {
    const rel = key.split("/templates/platformer-2d/godot/")[1];
    if (!rel) continue;
    const text = rel === "project.godot" ? content.replace("{{TITLE}}", godotString(title)).replace("{{DESCRIPTION}}", godotString(description)) : content;
    files.push({ path: `${GODOT_DIR}/${rel}`, content: text });
  }
  for (const [key, content] of Object.entries(RUNTIME_FILES)) {
    const rel = key.split("/engine-addons/godot/")[1];
    if (rel) files.push({ path: `${GODOT_DIR}/addons/${rel}`, content });
  }
  files.push({ path: `${GODOT_DIR}/addons/gamestudio_runtime/tests/fixtures.json`, content: fixtures });
  return files;
}

export function generatePlatformer(o: GenerateOptions): GeneratedProject {
  const level = sunsetCliffs();
  const graph = cliffRules();
  const manifest = baseManifest(o, {
    template: { id: "platformer-2d", version: "1.0.0" },
    genre: ["platformer", "action", "2d"],
    engine: { id: "godot", version: GODOT_VERSION, projectDir: GODOT_DIR, mainScene: "res://scenes/main.tscn" },
    modules: ["core.rules", "game.platformer2d"],
    rules: [{ id: graph.id, path: `rules/${graph.id}.rules.json`, domain: "platformer" }],
    data: [{ id: "level", path: "data/level.json", kind: "platformer-level" }],
    portableFeatures: ["rules", "level-layout", "asset-index"],
  });
  const readme = `# ${manifest.title}

A side-scrolling 2D platformer for Godot ${GODOT_VERSION}: run along the Sunset Cliffs, collect every sun coin
to open the gate, mind the spikes and beetles, and reach the flag. A checkpoint halfway brings you back if you
fall or get hurt.

- **Level** (\`data/level.json\`): edit it in Game Studio's level editor (drag platforms, coins, hazards and
  flags in a side view). Units are tiles; one tile is 32 pixels in the game.
- **Rules** (\`rules/${graph.id}.rules.json\`): the objective, coin counting, the gate, checkpoints and the win.
- **Godot project** (\`godot/\`): open it in Godot ${GODOT_VERSION} to change scripts directly. Game Studio writes
  the level and compiled rules to \`godot/gamestudio_data/\` when you save.
- **Play here** (Play view): builds the game for the web in \`exports/web/\` and plays it inside Game Studio.
- **Export** (Play view): builds a standalone macOS app in \`exports/macos/\` and runs its self-test.

Controls: A and D or the arrow keys run, Space (or W or Up) jumps, holding it jumps higher; wooden ledges can be
jumped through from below; F9 starts over.

The game saves your progress (coins, checkpoints, the gate, where you stand) in \`user://progress.json\` and
carries on from there next time, unless the level or its rules have changed since.
`;
  const rulesPath = `rules/${graph.id}.rules.json`;
  const sync = planEngineSync(manifest, { [rulesPath]: graph, "data/level.json": level }, createStudioRegistry());
  if (!sync.ok) throw new Error(`Template engine data failed: ${JSON.stringify(sync.problems)}`);
  return finalize(manifest, [
    ...commonFiles(manifest, readme, [`${GODOT_DIR}/.godot/`, `${GODOT_DIR}/*.import`, `${EXPORTS_DIR}/`]),
    { path: rulesPath, content: json(graph) },
    { path: "data/level.json", content: json(level) },
    ...platformerTemplateFiles(manifest.title, manifest.description),
    { path: `${GODOT_DIR}/export_presets.cfg`, content: godotPresets(manifest) },
    ...sync.writes,
  ]);
}
