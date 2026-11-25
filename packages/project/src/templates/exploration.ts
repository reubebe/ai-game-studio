import { ruinsRules, sunCrystalValley, thornwoodRuins, valleyRules, type World } from "@gamestudio/explore";
import type { RuleGraph } from "@gamestudio/rules-core";
import fixtures from "../../../rules-core/src/conformance/fixtures.json?raw";
import { createStudioRegistry } from "../registry";
import { planEngineSync } from "../sync";
import { baseManifest, commonFiles, finalize, json, type GenerateOptions, type GeneratedFile, type GeneratedProject } from "./common";
import { EXPORTS_DIR, godotPresets } from "../export";

const GODOT_FILES = import.meta.glob("../../../../templates/exploration-3d/godot/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const RUNTIME_FILES = import.meta.glob("../../../../engine-addons/godot/gamestudio_runtime/**/*.gd", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
/** Models made with Kiln for Thornwood Ruins (sources in templates/exploration-3d/kiln/), only in the adventure. */
const ADVENTURE_ASSETS = import.meta.glob("../../../../templates/exploration-3d/adventure-assets/**/*.gltf", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** The adventure's models, at the Godot project's assets folder (the world refers to them as assets/...). */
function adventureAssetFiles(): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const [key, content] of Object.entries(ADVENTURE_ASSETS)) {
    const rel = key.split("/templates/exploration-3d/adventure-assets/")[1];
    if (rel) files.push({ path: `${GODOT_DIR}/assets/${rel}`, content });
  }
  return files;
}

export const GODOT_VERSION = "4.7.2";
export const GODOT_DIR = "godot";
export const GODOT_DATA_DIR = `${GODOT_DIR}/gamestudio_data`;

/** Escape a value for a quoted string in project.godot. */
export function godotString(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Files of the Godot template and the shared rules runtime, with the title filled in. */
export function godotTemplateFiles(title: string, description: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const [key, content] of Object.entries(GODOT_FILES)) {
    const rel = key.split("/templates/exploration-3d/godot/")[1];
    if (!rel) continue;
    const text = rel === "project.godot" ? content.replace("{{TITLE}}", godotString(title)).replace("{{DESCRIPTION}}", godotString(description)) : content;
    files.push({ path: `${GODOT_DIR}/${rel}`, content: text });
  }
  for (const [key, content] of Object.entries(RUNTIME_FILES)) {
    const rel = key.split("/engine-addons/godot/")[1];
    if (!rel) continue;
    files.push({ path: `${GODOT_DIR}/addons/${rel}`, content });
  }
  files.push({ path: `${GODOT_DIR}/addons/gamestudio_runtime/tests/fixtures.json`, content: fixtures });
  return files;
}

export function generateExploration(o: GenerateOptions): GeneratedProject {
  const graph = valleyRules();
  return generateWorldProject(o, {
    templateId: "exploration-3d",
    genre: ["adventure", "exploration", "3d"],
    world: sunCrystalValley(),
    graph,
    about: `A small 3D exploration game for Godot ${GODOT_VERSION}: walk the valley, talk to Elder Ama, collect
three sun crystals to open the shrine gate, then enter the shrine.`,
    rulesAbout: "objectives, dialogue, crystal counting and the gate",
    controls: "E interact",
    saved: "crystals, the gate, where you stand",
  });
}

/** Thornwood Ruins: the same Godot template with enemies, health, pushable blocks and a timer. */
export function generateAdventure(o: GenerateOptions): GeneratedProject {
  return generateWorldProject(o, {
    templateId: "adventure-3d",
    genre: ["adventure", "action", "3d"],
    world: thornwoodRuins(),
    graph: ruinsRules(),
    about: `A small 3D action adventure for Godot ${GODOT_VERSION}: defeat the thorn beetles roaming the ruins, push two
stone blocks onto the pressure plates to open the old gate, and light the beacon before the sunset timer runs out.
The healing spring restores your hearts.`,
    rulesAbout: "objectives, the beetle count, the plates and the gate, the sunset timer, healing and the beacon",
    controls: "E interact, F or a click swings your staff (walk into a block to push it)",
    saved: "hearts, defeated beetles, where the blocks stand, the gate, the timer, where you stand",
    files: adventureAssetFiles(),
    modelsNote: `
The thorn beetles, the stone blocks and the gate are models made with Kiln (MIT licence) in
\`godot/assets/models/kiln/\`, with a wooden crate for blocks you add. Pick another model, or None for the
built-in shapes, in the world editor's inspector.
`,
  });
}

interface WorldProjectSpec {
  templateId: string;
  genre: string[];
  world: World;
  graph: RuleGraph;
  about: string;
  rulesAbout: string;
  controls: string;
  saved: string;
  /** Extra files the template ships (the adventure's models). */
  files?: GeneratedFile[];
  /** A paragraph about them for the README. */
  modelsNote?: string;
}

function generateWorldProject(o: GenerateOptions, spec: WorldProjectSpec): GeneratedProject {
  const { world, graph } = spec;
  const manifest = baseManifest(o, {
    template: { id: spec.templateId, version: "1.0.0" },
    genre: spec.genre,
    engine: { id: "godot", version: GODOT_VERSION, projectDir: GODOT_DIR, mainScene: "res://scenes/main.tscn" },
    modules: ["core.rules", "game.exploration3d"],
    rules: [{ id: graph.id, path: `rules/${graph.id}.rules.json`, domain: "explore" }],
    data: [{ id: "world", path: "data/world.json", kind: "explore-world" }],
    portableFeatures: ["rules", "world-layout", "asset-index"],
  });
  const readme = `# ${manifest.title}

${spec.about}

- **World** (\`data/world.json\`): edit the layout in Game Studio's world editor (drag objects on the map).
- **Rules** (\`rules/${graph.id}.rules.json\`): ${spec.rulesAbout}.
- **Godot project** (\`godot/\`): open it in Godot ${GODOT_VERSION} to edit scenes and scripts directly.
  Game Studio writes compiled rules and the layout to \`godot/gamestudio_data/\` when you save.
- **Play here** (Play view): builds the game for the web in \`exports/web/\` and plays it inside Game Studio,
  which keeps the game's saves for it (Clear saves deletes them).
- **Export** (Play view): builds a standalone macOS app in \`exports/macos/\` and runs its self-test.
  Both need Godot's export templates (Engines view).

Controls: W A S D move, mouse look (click to capture, or drag where the mouse cannot be captured), Shift sprint,
Space jump, ${spec.controls}, Esc frees the mouse, F9 starts over.

The game saves your progress (${spec.saved}) in \`user://progress.json\` as you play and
carries on from there next time, unless the level or its rules have changed since (\`godot/scripts/progress.gd\`).
${spec.modelsNote ?? ""}`;
  const rulesPath = `rules/${graph.id}.rules.json`;
  // Engine data comes from the same sync the studio runs on save, so a fresh project never churns.
  const sync = planEngineSync(manifest, { [rulesPath]: graph, "data/world.json": world }, createStudioRegistry());
  if (!sync.ok) throw new Error(`Template engine data failed: ${JSON.stringify(sync.problems)}`);
  return finalize(manifest, [
    ...commonFiles(manifest, readme, [`${GODOT_DIR}/.godot/`, `${GODOT_DIR}/*.import`, `${EXPORTS_DIR}/`]),
    { path: rulesPath, content: json(graph) },
    { path: "data/world.json", content: json(world) },
    ...godotTemplateFiles(manifest.title, manifest.description),
    { path: `${GODOT_DIR}/export_presets.cfg`, content: godotPresets(manifest) },
    ...(spec.files ?? []),
    ...sync.writes,
  ]);
}
