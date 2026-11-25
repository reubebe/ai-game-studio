import { acreRules, sunriseAcres } from "@gamestudio/farm";
import fixtures from "../../../rules-core/src/conformance/fixtures.json?raw";
import { createStudioRegistry } from "../registry";
import { planEngineSync } from "../sync";
import { EXPORTS_DIR, godotPresets } from "../export";
import { baseManifest, commonFiles, finalize, json, type GenerateOptions, type GeneratedFile, type GeneratedProject } from "./common";
import { GODOT_DIR, GODOT_VERSION, godotString } from "./exploration";

const FARM_FILES = import.meta.glob("../../../../templates/farm/godot/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const RUNTIME_FILES = import.meta.glob("../../../../engine-addons/godot/gamestudio_runtime/**/*.gd", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Files of the farm template's Godot project and the shared rules runtime, with the title filled in. */
export function farmTemplateFiles(title: string, description: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const [key, content] of Object.entries(FARM_FILES)) {
    const rel = key.split("/templates/farm/godot/")[1];
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

export function generateFarm(o: GenerateOptions): GeneratedProject {
  const farm = sunriseAcres();
  const graph = acreRules();
  const manifest = baseManifest(o, {
    template: { id: "farm-sim", version: "1.0.0" },
    genre: ["simulation", "farming", "2d"],
    engine: { id: "godot", version: GODOT_VERSION, projectDir: GODOT_DIR, mainScene: "res://scenes/main.tscn" },
    modules: ["core.rules", "game.farm"],
    rules: [{ id: graph.id, path: `rules/${graph.id}.rules.json`, domain: "farm" }],
    data: [{ id: "farm", path: "data/farm.json", kind: "farm-sim" }],
    portableFeatures: ["rules", "farm-settings", "asset-index"],
  });
  const readme = `# ${manifest.title}

A small farming simulation for Godot ${GODOT_VERSION}: plant seeds on the soil, water them every day, harvest what
has grown, sell it at the market stall and sleep in the house to start the next morning. Crops grow only on days
they were watered (rain waters them all). Make 300 coins by the morning of day 8; day 4 is market day.

- **Farm** (\`data/farm.json\`): edit it in Game Studio's farm editor: paint the map (soil, paths, water, trees,
  fences, the house and the stall), define the crops (name, seed cost, days to grow, yield, price, colour, whether
  it needs water, whether it grows again), and set the farmer's name, the money, the day length and the rain.
- **Rules** (\`rules/${graph.id}.rules.json\`): the goal, market day, harvest and sale messages, and the end of the season.
- **Godot project** (\`godot/\`): open it in Godot ${GODOT_VERSION} to change scripts directly. Game Studio writes the
  farm and compiled rules to \`godot/gamestudio_data/\` when you save.
- **Play here** (Play view): builds the game for the web in \`exports/web/\` and plays it inside Game Studio.
- **Export** (Play view): builds a standalone macOS app in \`exports/macos/\` and runs its self-test.

Controls: W A S D (or the arrow keys) walk, E (or Space) works the tile in front of you (plant, water, harvest,
sell at the stall, sleep in the house), Q picks the next seed, F9 starts the season over.

The game saves the season (money, the day, what grows where, the basket, prices) in \`user://progress.json\` every
morning and when it closes, and carries on from there next time, unless the farm or its rules have changed since.
`;
  const rulesPath = `rules/${graph.id}.rules.json`;
  const sync = planEngineSync(manifest, { [rulesPath]: graph, "data/farm.json": farm }, createStudioRegistry());
  if (!sync.ok) throw new Error(`Template engine data failed: ${JSON.stringify(sync.problems)}`);
  return finalize(manifest, [
    ...commonFiles(manifest, readme, [`${GODOT_DIR}/.godot/`, `${GODOT_DIR}/*.import`, `${EXPORTS_DIR}/`]),
    { path: rulesPath, content: json(graph) },
    { path: "data/farm.json", content: json(farm) },
    ...farmTemplateFiles(manifest.title, manifest.description),
    { path: `${GODOT_DIR}/export_presets.cfg`, content: godotPresets(manifest) },
    ...sync.writes,
  ]);
}
