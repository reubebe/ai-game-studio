import { GODOT_ONLY_ENVIRONMENT, sunCrystalValley, valleyRules } from "@gamestudio/explore";
import { createStudioRegistry } from "../registry";
import { planEngineSync } from "../sync";
import { EXPORTS_DIR } from "../export";
import { baseManifest, commonFiles, finalize, json, type GenerateOptions, type GeneratedFile, type GeneratedProject } from "./common";

const UNITY_FILES = import.meta.glob("../../../../templates/exploration-unity/unity/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
/** The C# rule runtime (engine-addons/unity), shipped into every Unity project next to the game scripts. */
const RULES_FILES = import.meta.glob("../../../../engine-addons/unity/GameStudioRules/*.cs", { query: "?raw", import: "default", eager: true }) as Record<string, string>;


/** The Unity release this template was built and tested with. */
export const UNITY_VERSION = "6000.6.9f1";
export const UNITY_DIR = "unity";
export const UNITY_RULES_DIR = `${UNITY_DIR}/Assets/GameStudio/Runtime/Rules`;
export const UNITY_EXPORT_DIR = `${EXPORTS_DIR}/unity-macos`;
const UNITY_VERSION_RE = /^\d{4}\.\d+\.\d+[abfpc]\d+$/;

/**
 * Built-in modules only. With ProjectVersion.txt present Unity keeps this list as written; without
 * it Unity treats the folder as a new project and installs its default packages from the registry.
 */
export const UNITY_PACKAGES = {
  dependencies: {
    "com.unity.modules.audio": "1.0.0",
    "com.unity.modules.imgui": "1.0.0",
    "com.unity.modules.jsonserialize": "1.0.0",
    "com.unity.modules.physics": "1.0.0",
  },
};

export function unityTemplateFiles(version: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const [key, content] of Object.entries(UNITY_FILES)) {
    const rel = key.split("/templates/exploration-unity/unity/")[1];
    if (rel) files.push({ path: `${UNITY_DIR}/${rel}`, content });
  }
  for (const [key, content] of Object.entries(RULES_FILES)) {
    const name = key.split("/").pop();
    if (name) files.push({ path: `${UNITY_RULES_DIR}/${name}`, content });
  }
  files.push({ path: `${UNITY_DIR}/Packages/manifest.json`, content: json(UNITY_PACKAGES) });
  files.push({ path: `${UNITY_DIR}/ProjectSettings/ProjectVersion.txt`, content: `m_EditorVersion: ${version}\n` });
  return files;
}

export function generateUnityExploration(o: GenerateOptions): GeneratedProject {
  const version = o.engineVersion && UNITY_VERSION_RE.test(o.engineVersion) ? o.engineVersion : UNITY_VERSION;
  const world = sunCrystalValley();
  // The Godot game's clouds, ground patches and grass are not drawn by this engine's game.
  for (const k of GODOT_ONLY_ENVIRONMENT) delete world.environment[k];
  const graph = valleyRules();
  const manifest = baseManifest(o, {
    template: { id: "exploration-unity", version: "1.0.0" },
    genre: ["adventure", "exploration", "3d"],
    engine: { id: "unity", version, projectDir: UNITY_DIR },
    modules: ["core.rules", "game.exploration3d"],
    rules: [{ id: graph.id, path: `rules/${graph.id}.rules.json`, domain: "explore" }],
    data: [{ id: "world", path: "data/world.json", kind: "explore-world" }],
    portableFeatures: ["rules", "world-layout", "asset-index"],
  });
  const readme = `# ${manifest.title}

The Sun Crystal Valley level as a Unity ${version} project.

- **World** (\`data/world.json\`): edit it in Game Studio's world editor. Saving copies it to
  \`unity/Assets/StreamingAssets/gamestudio_data/\`, where the game reads it at startup.
- **Rules** (\`rules/${graph.id}.rules.json\`): objectives, Elder Ama's dialogue and the shrine gate. Saving
  compiles them into the same folder, and the C# rule runtime in \`Assets/GameStudio/Runtime/Rules/\`
  runs them, as the Godot version and the studio's simulator do.
- **Unity project** (\`unity/\`): C# scripts in \`Assets/GameStudio/\` build the level from primitives,
  move the player and connect the rules to the level. Open it from Game Studio's Play view, or in Unity Hub.
- **Build** (Play view): builds an Apple silicon macOS app in \`exports/unity-macos/\` and can run its
  headless self-test.

Controls: W A S D or arrows move, Shift sprints, Space jumps, hold the right mouse button to look around,
E talks to people and reads signs.
`;
  const rulesPath = `rules/${graph.id}.rules.json`;
  const sync = planEngineSync(manifest, { [rulesPath]: graph, "data/world.json": world }, createStudioRegistry());
  if (!sync.ok) throw new Error(`Template engine data failed: ${JSON.stringify(sync.problems)}`);
  const unityIgnores = ["Library/", "Temp/", "Logs/", "obj/", "UserSettings/", "*.csproj", "*.sln", "*.slnx"].map((p) => `${UNITY_DIR}/${p}`);
  return finalize(manifest, [
    ...commonFiles(manifest, readme, [...unityIgnores, `${EXPORTS_DIR}/`]),
    { path: rulesPath, content: json(graph) },
    { path: "data/world.json", content: json(world) },
    ...unityTemplateFiles(version),
    ...sync.writes,
  ]);
}
