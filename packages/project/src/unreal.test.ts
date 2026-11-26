import { describe, expect, it } from "vitest";
import { createStudioRegistry, engineDataDir, generateProject, iniOverlay, parseManifest, planEngineSync, UNREAL_VERSION } from "./index";

const now = new Date("2026-11-18T09:00:00.000Z");
const make = (title = "Valley in Unreal", engineVersion?: string) => generateProject("exploration-unreal", { title, projectId: "valley-in-unreal-0001", now, engineVersion });
const file = (p: ReturnType<typeof make>, path: string) => p.files.find((f) => f.path === path)?.content;

describe("Unreal exploration template", () => {
  it("writes a C++ project pinned to the installed engine", () => {
    const p = make("Valley in Unreal", "5.8");
    expect(parseManifest(p.manifest).ok).toBe(true);
    expect(p.manifest.engine).toEqual({ id: "unreal", version: "5.8", projectDir: "unreal" });
    const uproject = JSON.parse(file(p, "unreal/StudioValley.uproject")!);
    expect(uproject.EngineAssociation).toBe("5.8");
    expect(uproject.Modules).toEqual([{ Name: "StudioValley", Type: "Runtime", LoadingPhase: "Default" }]);
    for (const path of ["Source/StudioValley.Target.cs", "Source/StudioValleyEditor.Target.cs", "Source/StudioValley/StudioValley.Build.cs", "Source/StudioValley/StudioGameMode.cpp", "Source/StudioValley/StudioCharacter.cpp", "Source/StudioValley/StudioWorld.cpp", "Source/StudioValley/StudioHUD.cpp", "Source/StudioValley/StudioRules.cpp", "Source/StudioValley/StudioRulesVM.h"]) {
      expect(file(p, `unreal/${path}`), path).toBeDefined();
    }
  });

  it("starts on the engine's Entry map with the studio game mode and stages the level data", () => {
    const p = make();
    expect(file(p, "unreal/Config/DefaultEngine.ini")).toContain("GlobalDefaultGameMode=/Script/StudioValley.StudioGameMode");
    expect(file(p, "unreal/Config/DefaultEngine.ini")).toContain("BundleIdentifier=com.gamestudio.valley-in-unreal-0001");
    expect(file(p, "unreal/Config/DefaultEngine.ini")).toContain("+TargetedRHIs=SF_METAL_SM5");
    // The pointer stays free: Unreal's default locks it inside the game window (the game also shows it).
    expect(file(p, "unreal/Config/DefaultInput.ini")).toContain("DefaultViewportMouseLockMode=DoNotLock");
    const game = file(p, "unreal/Config/DefaultGame.ini")!;
    expect(game).toContain('+DirectoriesToAlwaysStageAsNonUFS=(Path="GameStudioData")');
    expect(game).toContain("ProjectName=Valley in Unreal");
    expect(engineDataDir(p.manifest)).toBe("unreal/Content/GameStudioData");
    expect(JSON.parse(file(p, "unreal/Content/GameStudioData/world.json")!).kind).toBe("explore-world");
  });

  it("keeps ini-breaking characters out of the project name and falls back to the tested release", () => {
    const p = make('Line\nBreak = "quoted" [section]', "6.0");
    expect(file(p, "unreal/Config/DefaultGame.ini")).toContain("ProjectName=Line Break quoted section");
    expect(p.manifest.engine.version).toBe(UNREAL_VERSION);
  });

  it("keeps Unreal's generated folders and builds out of snapshots", () => {
    const ignore = file(make(), ".gitignore")!.split("\n");
    for (const line of ["unreal/Binaries/", "unreal/Intermediate/", "unreal/Saved/", "unreal/DerivedDataCache/", "exports/"]) expect(ignore).toContain(line);
  });

  it("syncs edited layouts into Content/GameStudioData", () => {
    const p = make();
    const world = JSON.parse(file(p, "data/world.json")!);
    world.objects.push({ id: "rock_9", type: "rock", x: 1, z: 2, rotation: 0, scale: 1 });
    const plan = planEngineSync(p.manifest, { "data/world.json": world, "rules/valley-rules.rules.json": JSON.parse(file(p, "rules/valley-rules.rules.json")!) }, createStudioRegistry());
    expect(plan.writes.find((w) => w.path === "unreal/Content/GameStudioData/world.json")!.content).toContain("rock_9");
  });
});

// A cut-down copy of the Game Animation Sample's settings (Epic's real files are on the user's computer only).
const SAMPLE: { config: Record<string, string>; uproject: string } = {
  config: {
    "DefaultEngine.ini": [
      "[/Script/Engine.RendererSettings]",
      "r.DynamicGlobalIlluminationMethod=1",
      "r.ReflectionMethod=1",
      "",
      "[/Script/EngineSettings.GameMapsSettings]",
      "EditorStartupMap=/Game/Levels/DefaultLevel.DefaultLevel",
      "GameDefaultMap=/Game/Levels/DefaultLevel.DefaultLevel",
      "",
      "[/Script/Engine.DataDrivenConsoleVariableSettings]",
      '+CVarsArray=(Type=CVarInt,Name="DDCvar.PawnClass",ToolTip="",DefaultValueFloat=0.000000,DefaultValueInt=-1,DefaultValueBool=False)',
      '+CVarsArray=(Type=CVarInt,Name="DDCvar.VisualOverride",ToolTip="",DefaultValueFloat=0.000000,DefaultValueInt=-1,DefaultValueBool=False)',
      "",
    ].join("\n"),
    "DefaultGame.ini": ["[/Script/EngineSettings.GeneralProjectSettings]", "ProjectID=0C1887B6FE4D015877DF14BF836AE18D", "", "[/Script/Engine.AssetManagerSettings]", "bOnlyCookProductionAssets=False", "", "[/Script/UnrealEd.ProjectPackagingSettings]", '+MapsToCook=(FilePath="/Game/Levels/DefaultLevel")', ""].join("\n"),
    "DefaultInput.ini": ["[/Script/Engine.InputSettings]", "DefaultViewportMouseLockMode=LockOnCapture", "DefaultPlayerInputClass=/Script/EnhancedInput.EnhancedPlayerInput", ""].join("\n"),
    "DefaultGameplayTags.ini": ["[/Script/GameplayTags.GameplayTagsSettings]", "ImportTagsFromConfig=True", ""].join("\n"),
  },
  uproject: JSON.stringify({ FileVersion: 3, EngineAssociation: "5.8", Plugins: [{ Name: "PoseSearch", Enabled: true }, { Name: "ModelingToolsEditorMode", Enabled: true, TargetAllowList: ["Editor"], MarketplaceURL: "x" }, { Name: "Unused", Enabled: false }, { Name: "../Odd", Enabled: true }, { Name: "Odd", Enabled: true, TargetAllowList: ["../x"] }] }),
};
const realistic = (sample: typeof SAMPLE | undefined = SAMPLE) =>
  generateProject("exploration-unreal-realistic", { title: "Real Valley", projectId: "real-valley-0001", now, engineVersion: "5.8", unrealSample: sample });

describe("Unreal exploration template with realistic people", () => {
  it("needs Epic's Game Animation Sample and says how to get it", () => {
    expect(() => generateProject("exploration-unreal-realistic", { title: "Real Valley", now })).toThrow(/Game Animation Sample.*fab\.com.*Create Project/s);
    expect(realistic().manifest.template.id).toBe("exploration-unreal-realistic");
  });

  it("refuses a sample made for another Unreal release (its assets would not open)", () => {
    const old = { ...SAMPLE, uproject: JSON.stringify({ FileVersion: 3, EngineAssociation: "5.7" }) };
    expect(() => realistic(old)).toThrow(/for Unreal Engine 5\.7, but this project would use Unreal Engine 5\.8/);
    expect(() => realistic({ ...SAMPLE, uproject: "not json" })).toThrow(/could not be read/);
  });

  it("keeps the sample's light and puts the game's start map, game mode and Mac settings on top", () => {
    const engine = file(realistic(), "unreal/Config/DefaultEngine.ini")!;
    expect(engine).toContain("r.DynamicGlobalIlluminationMethod=1");
    expect(engine).toContain("GameDefaultMap=/Engine/Maps/Entry");
    expect(engine).not.toContain("GameDefaultMap=/Game/Levels/DefaultLevel");
    expect(engine).toContain("GlobalDefaultGameMode=/Script/StudioValley.StudioGameMode");
    expect(engine).toContain("BundleIdentifier=com.gamestudio.real-valley-0001");
    expect(engine).toContain("+TargetedRHIs=SF_METAL_SM5");
    // The sample's own switches: its standard character and MetaHuman Kellan.
    expect(engine).toMatch(/Name="DDCvar\.PawnClass",[^)]*DefaultValueInt=0,/);
    expect(engine).toMatch(/Name="DDCvar\.VisualOverride",[^)]*DefaultValueInt=2,/);
  });

  it("makes the sample's character, controls and MetaHuman the player, and cooks only the game's map", () => {
    const game = file(realistic(), "unreal/Config/DefaultGame.ini")!;
    expect(game).toContain("ProjectName=Real Valley");
    expect(game).not.toContain("ProjectID=");
    expect(game).toContain("bOnlyCookProductionAssets=False");
    expect(game).not.toContain("/Game/Levels/DefaultLevel");
    expect(game).toContain('+MapsToCook=(FilePath="/Engine/Maps/Entry")');
    expect(game).toContain('+DirectoriesToAlwaysCook=(Path="/Game/MetaHumans/Kellan")');
    expect(game).toContain('+DirectoriesToAlwaysStageAsNonUFS=(Path="GameStudioData")');
    expect(game).toMatch(/\[\/Script\/StudioValley\.StudioGameMode\][^[]*PlayerPawn=\/Game\/Blueprints\/SandboxCharacter_CMC\.SandboxCharacter_CMC_C/);
    expect(game).toContain("PlayerLook=/Game/MetaHumans/Kellan/BP_Kellan.BP_Kellan_C");
    expect(game).toContain("bShowPointer=False");
  });

  it("keeps the sample's input (it looks around with the mouse) and its other settings files", () => {
    const p = realistic();
    expect(file(p, "unreal/Config/DefaultInput.ini")).toContain("DefaultPlayerInputClass=/Script/EnhancedInput.EnhancedPlayerInput");
    expect(file(p, "unreal/Config/DefaultInput.ini")).not.toContain("DoNotLock");
    expect(file(p, "unreal/Config/DefaultGameplayTags.ini")).toContain("ImportTagsFromConfig=True");
    expect(() => realistic({ ...SAMPLE, config: { ...SAMPLE.config, "../Evil.ini": "" } })).toThrow(/Unexpected sample settings file/);
  });

  it("enables the sample's plugins next to the game's module", () => {
    const uproject = JSON.parse(file(realistic(), "unreal/StudioValley.uproject")!);
    expect(uproject.Modules).toEqual([{ Name: "StudioValley", Type: "Runtime", LoadingPhase: "Default" }]);
    // Editor-only tools stay editor-only; odd names and limits are left out.
    // Plus the editor's Python and Geometry Script, which import Game Studio's trees and people, also editor-only.
    expect(uproject.Plugins).toEqual([
      { Name: "PoseSearch", Enabled: true },
      { Name: "ModelingToolsEditorMode", Enabled: true, TargetAllowList: ["Editor"] },
      { Name: "Odd", Enabled: true },
      { Name: "PythonScriptPlugin", Enabled: true, TargetAllowList: ["Editor"] },
      { Name: "EditorScriptingUtilities", Enabled: true, TargetAllowList: ["Editor"] },
      { Name: "GeometryScripting", Enabled: true, TargetAllowList: ["Editor"] },
    ]);
  });

  it("cooks Game Studio's trees and people, which the game names in code only", () => {
    expect(file(realistic(), "unreal/Config/DefaultGame.ini")).toContain('+DirectoriesToAlwaysCook=(Path="/Game/GameStudioNature")');
    expect(file(make(), "unreal/Config/DefaultGame.ini")).not.toContain("GameStudioNature");
  });

  it("keeps the sample's 7 GB of content out of snapshots, but not Game Studio's own data", () => {
    const ignore = file(realistic(), ".gitignore")!;
    expect(ignore).toContain("unreal/Content/*");
    expect(ignore).toContain("!unreal/Content/GameStudioData/");
    expect(file(make(), ".gitignore")).not.toContain("unreal/Content/*");
  });
});

describe("iniOverlay", () => {
  it("replaces plain keys, adds array lines after the base's and adds missing sections", () => {
    const base = "[A]\nKey=1\n+List=a\nOther=x\n\n[B]\nB=1\n";
    const top = "; top comment\n[A]\nKey=2\n+List=b\n\n[C]\nC=3\n";
    expect(iniOverlay(base, top)).toBe("; top comment\n\n[A]\n+List=a\nOther=x\nKey=2\n+List=b\n\n[B]\nB=1\n\n[C]\nC=3\n");
  });

  it("leaves array lines with the same key alone when a plain key is set", () => {
    expect(iniOverlay("[A]\n+Maps=a\n", "[A]\nMaps=b\n")).toBe("[A]\n+Maps=a\nMaps=b\n");
  });
});
