import { describe, expect, it } from "vitest";
import { createStudioRegistry, engineDataDir, generateProject, parseManifest, planEngineSync, UNITY_VERSION } from "./index";

const now = new Date("2026-11-18T09:00:00.000Z");
const make = (engineVersion?: string) => generateProject("exploration-unity", { title: "Valley in Unity", projectId: "valley-in-unity-0001", now, engineVersion });
const file = (p: ReturnType<typeof make>, path: string) => p.files.find((f) => f.path === path)?.content;

describe("Unity exploration template", () => {
  it("pins the installed editor and only built-in packages, so opening it downloads nothing", () => {
    const p = make("6000.6.9f1");
    expect(parseManifest(p.manifest).ok).toBe(true);
    expect(p.manifest.engine).toEqual({ id: "unity", version: "6000.6.9f1", projectDir: "unity" });
    expect(file(p, "unity/ProjectSettings/ProjectVersion.txt")).toBe("m_EditorVersion: 6000.6.9f1\n");
    const deps = Object.keys(JSON.parse(file(p, "unity/Packages/manifest.json")!).dependencies);
    expect(deps.every((d) => d.startsWith("com.unity.modules."))).toBe(true);
  });

  it("falls back to the tested release for missing or malformed versions", () => {
    expect(make().manifest.engine.version).toBe(UNITY_VERSION);
    expect(make("6000.6.9; rm -rf").manifest.engine.version).toBe(UNITY_VERSION);
  });

  it("ships the C# runtime, the build script and the synced level data", () => {
    const p = make();
    for (const path of ["Runtime/StudioData.cs", "Runtime/WorldBuilder.cs", "Runtime/StudioPlayer.cs", "Runtime/StudioGame.cs", "Runtime/StudioRules.cs", "Runtime/SmokeTest.cs", "Runtime/Rules/RulesVM.cs", "Runtime/Rules/StudioJson.cs", "Editor/StudioBuild.cs"]) {
      expect(file(p, `unity/Assets/GameStudio/${path}`), path).toBeDefined();
    }
    expect(engineDataDir(p.manifest)).toBe("unity/Assets/StreamingAssets/gamestudio_data");
    expect(JSON.parse(file(p, "unity/Assets/StreamingAssets/gamestudio_data/world.json")!).kind).toBe("explore-world");
    expect(file(p, "unity/Assets/StreamingAssets/gamestudio_data/rules_index.json")).toBeDefined();
    expect(file(p, "unity/Assets/GameStudio/Editor/StudioBuild.cs")).toContain("public static void BuildMac()");
  });

  it("ships the same rule runtime the conformance test checks", () => {
    const vm = file(make(), "unity/Assets/GameStudio/Runtime/Rules/RulesVM.cs")!;
    expect(vm).toContain("public const int IrVersion = 1;");
    expect(file(make(), "unity/Assets/GameStudio/Runtime/StudioGame.cs")).toContain('Rules.Fire("start"');
  });

  it("keeps Unity caches and builds out of snapshots", () => {
    const ignore = file(make(), ".gitignore")!.split("\n");
    for (const line of ["unity/Library/", "unity/Temp/", "unity/Logs/", "unity/UserSettings/", "exports/"]) expect(ignore).toContain(line);
  });

  it("syncs edited layouts into StreamingAssets", () => {
    const p = make();
    const world = JSON.parse(file(p, "data/world.json")!);
    world.objects.push({ id: "rock_9", type: "rock", x: 1, z: 2, rotation: 0, scale: 1 });
    const plan = planEngineSync(p.manifest, { "data/world.json": world, "rules/valley-rules.rules.json": JSON.parse(file(p, "rules/valley-rules.rules.json")!) }, createStudioRegistry());
    expect(plan.ok).toBe(true);
    expect(plan.writes.find((w) => w.path === "unity/Assets/StreamingAssets/gamestudio_data/world.json")!.content).toContain("rock_9");
  });
});
