import { cupRules, harbourCup } from "@gamestudio/football";
import fixtures from "../../../rules-core/src/conformance/fixtures.json?raw";
import { createStudioRegistry } from "../registry";
import { planEngineSync } from "../sync";
import { EXPORTS_DIR, godotPresets } from "../export";
import { baseManifest, commonFiles, finalize, json, type GenerateOptions, type GeneratedFile, type GeneratedProject } from "./common";
import { GODOT_DIR, GODOT_VERSION, godotString } from "./exploration";

const FOOTBALL_FILES = import.meta.glob("../../../../templates/football/godot/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const RUNTIME_FILES = import.meta.glob("../../../../engine-addons/godot/gamestudio_runtime/**/*.gd", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Files of the football template's Godot project and the shared rules runtime, with the title filled in. */
export function footballTemplateFiles(title: string, description: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const [key, content] of Object.entries(FOOTBALL_FILES)) {
    const rel = key.split("/templates/football/godot/")[1];
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

export function generateFootball(o: GenerateOptions): GeneratedProject {
  const match = harbourCup();
  const graph = cupRules();
  const manifest = baseManifest(o, {
    template: { id: "football", version: "1.0.0" },
    genre: ["sports", "football", "3d"],
    engine: { id: "godot", version: GODOT_VERSION, projectDir: GODOT_DIR, mainScene: "res://scenes/main.tscn" },
    modules: ["core.rules", "game.football"],
    rules: [{ id: graph.id, path: `rules/${graph.id}.rules.json`, domain: "football" }],
    data: [{ id: "match", path: "data/match.json", kind: "football-match" }],
    portableFeatures: ["rules", "match-settings", "asset-index"],
  });
  const readme = `# ${manifest.title}

A five-a-side football match for Godot ${GODOT_VERSION}: your team in red against the computer's in blue, on a walled
pitch where the ball never goes out (only goals stop play). Score more goals before the clock runs out; if it is level
at full time, the rules play a golden-goal minute.

- **Match** (\`data/match.json\`): edit it in Game Studio's match editor: team names, short names and colours,
  players a side (2 to 5, the keeper included), minutes, the computer's skill, and the pitch.
- **Rules** (\`rules/${graph.id}.rules.json\`): the kick-off, goal announcements with the score, the last-minute
  warning, and full time with the golden goal.
- **Godot project** (\`godot/\`): open it in Godot ${GODOT_VERSION} to change scripts directly (the computer's
  players are in \`scripts/main.gd\`). Game Studio writes the match and compiled rules to \`godot/gamestudio_data/\`
  when you save.
- **Play here** (Play view): builds the game for the web in \`exports/web/\` and plays it inside Game Studio.
- **Export** (Play view): builds a standalone macOS app in \`exports/macos/\` and runs its self-test.

Controls: W A S D (or the arrow keys) run, Shift sprints, Space shoots (hold W or S to aim at that corner), E passes
(or tackles an opponent who has the ball), Q switches to the team-mate nearest the ball, F9 plays the match again.
`;
  const rulesPath = `rules/${graph.id}.rules.json`;
  const sync = planEngineSync(manifest, { [rulesPath]: graph, "data/match.json": match }, createStudioRegistry());
  if (!sync.ok) throw new Error(`Template engine data failed: ${JSON.stringify(sync.problems)}`);
  return finalize(manifest, [
    ...commonFiles(manifest, readme, [`${GODOT_DIR}/.godot/`, `${GODOT_DIR}/*.import`, `${EXPORTS_DIR}/`]),
    { path: rulesPath, content: json(graph) },
    { path: "data/match.json", content: json(match) },
    ...footballTemplateFiles(manifest.title, manifest.description),
    { path: `${GODOT_DIR}/export_presets.cfg`, content: godotPresets(manifest) },
    ...sync.writes,
  ]);
}
