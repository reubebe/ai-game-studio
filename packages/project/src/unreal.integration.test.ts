import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { generateProject } from "./index";

/**
 * Compiles, packages and self-tests the generated Unreal project with a real engine. Skipped unless
 * UNREAL_ROOT points to an Unreal Engine 5 install, for example:
 *   UNREAL_ROOT="/Users/Shared/Epic Games/UE_5.8" npx vitest run packages/project/src/unreal.integration.test.ts
 * Needs Xcode selected with xcode-select and its Metal toolchain. The first package compiles shaders.
 */
const ROOT = process.env["UNREAL_ROOT"] ? resolve(process.env["UNREAL_ROOT"]) : undefined;

function run(program: string, args: string[], cwd: string, timeout: number): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(program, args, { cwd, encoding: "utf8", timeout, maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
}

describe.skipIf(!ROOT)("Unreal integration (real engine)", () => {
  // Real path: macOS temp folders sit behind the /var -> /private/var symlink, and Unreal's build
  // accelerator then writes precompiled headers where the compiler does not look for them.
  // Written in beforeAll: describe bodies run even when the suite is skipped.
  let root = "";
  let work = "";
  let uproject = "";
  let out = "";
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "gamestudio-unreal-")));
    for (const f of generateProject("exploration-unreal", { title: "Integration Valley", projectId: "integration-valley-0001" }).files) {
      const path = join(root, f.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, f.content);
    }
    work = join(root, "unreal");
    uproject = join(work, "StudioValley.uproject");
    out = join(root, "exports/unreal-macos");
  });

  it("compiles the C++ module", () => {
    const r = run(join(ROOT!, "Engine/Build/BatchFiles/Mac/Build.sh"), ["StudioValleyEditor", "Mac", "Development", `-project=${uproject}`, "-waitmutex"], work, 1200000);
    expect(r.out, r.out.slice(-3000)).toMatch(/Result: Succeeded/);
    expect(r.out).not.toMatch(/warning: /);
  }, 1260000);

  it("packages a macOS app", () => {
    const r = run(join(ROOT!, "Engine/Build/BatchFiles/RunUAT.sh"), ["BuildCookRun", `-project=${uproject}`, "-noP4", "-platform=Mac", "-clientconfig=Development", "-build", "-cook", "-stage", "-pak", "-package", "-archive", `-archivedirectory=${out}`, "-unattended", "-utf8output"], work, 3600000);
    expect(r.out, r.out.slice(-3000)).toMatch(/BUILD SUCCESSFUL/);
    expect(existsSync(join(out, "Mac/StudioValley.app/Contents/MacOS/StudioValley"))).toBe(true);
  }, 3660000);

  it("runs the packaged game headlessly: level, ground, walking, talking, collecting and the rules", () => {
    // -LLM as in the studio's run plan: without it Unreal 5.8 can crash on a first launch (FLLMTracker::PopTag).
    const r = run(join(out, "Mac/StudioValley.app/Contents/MacOS/StudioValley"), ["-nullrhi", "-unattended", "-nosound", "-studio-smoke", "-LLM"], out, 300000);
    const line = r.out.split("\n").find((l) => l.startsWith("GSTUDIO_SMOKE "));
    expect(line, r.out.slice(-3000)).toBeDefined();
    const report = JSON.parse(line!.slice("GSTUDIO_SMOKE ".length));
    expect(report.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    expect(report.checks.map((c: { name: string }) => c.name)).toContain("player starts at the spawn point");
    expect(report.observations.collected).toBe(3);
    // The valley rules ran in C++: objective, Elder Ama's first line, the gate after three crystals, the win.
    expect(report.checks.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(["rule programs load", "start rules set an objective", "talking to someone runs the interact rules", "rules run without errors", "the pointer stays visible and is not locked inside the game window"]));
    expect(report.observations.messages).toEqual(expect.arrayContaining([expect.stringMatching(/^Elder Ama: .Three sun crystals/), "Sun crystal 3 of 3"]));
    expect(report.observations.gatesOpen).toEqual({ gate_main: true });
    expect(report.observations.objective).toMatch(/gate is open/);
    expect(report.observations.won).toBe(true);
    expect(report.observations.sounds).toEqual(expect.arrayContaining(["chime", "gate", "success"]));
    expect(r.code).toBe(0);
  }, 360000);

  it("cleans up", () => {
    rmSync(root, { recursive: true, force: true });
  });
});

/**
 * The realistic template with Epic's Game Animation Sample. Skipped unless UNREAL_ROOT is set and
 * UNREAL_SAMPLE points to the sample the Epic Games Launcher created, for example:
 *   UNREAL_ROOT="/Users/Shared/Epic Games/UE_5.8" UNREAL_SAMPLE="$HOME/Documents/Unreal Projects/GameAnimationSample" \
 *     npx vitest run packages/project/src/unreal.integration.test.ts -t realistic
 * The content is cloned (cp -c, as the app's backend does with std::fs::copy), so it takes no extra space on APFS.
 * Packaging cooks the sample's animations and its MetaHuman: the first time takes a long while.
 */
const SAMPLE_ROOT = process.env["UNREAL_SAMPLE"] ? resolve(process.env["UNREAL_SAMPLE"]) : undefined;

describe.skipIf(!ROOT || !SAMPLE_ROOT)("Unreal integration, realistic people (real engine and Epic's sample)", () => {
  let root = "";
  let work = "";
  let uproject = "";
  let out = "";
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "gamestudio-unreal-realistic-")));
    const config: Record<string, string> = {};
    for (const name of readdirSync(join(SAMPLE_ROOT!, "Config"))) if (name.endsWith(".ini")) config[name] = readFileSync(join(SAMPLE_ROOT!, "Config", name), "utf8");
    const unrealSample = { config, uproject: readFileSync(join(SAMPLE_ROOT!, "GameAnimationSample.uproject"), "utf8") };
    for (const f of generateProject("exploration-unreal-realistic", { title: "Realistic Check", projectId: "realistic-check-0001", engineVersion: "5.8", unrealSample }).files) {
      const path = join(root, f.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, f.content);
    }
    work = join(root, "unreal");
    uproject = join(work, "StudioValley.uproject");
    out = join(root, "exports/unreal-macos");
    for (const name of readdirSync(join(SAMPLE_ROOT!, "Content"))) {
      if (name !== "GameStudioData" && !name.startsWith(".")) execFileSync("/bin/cp", ["-cR", join(SAMPLE_ROOT!, "Content", name), join(work, "Content", name)]);
    }
    mkdirSync(join(work, "DerivedDataCache"), { recursive: true });
    execFileSync("/bin/cp", ["-c", join(SAMPLE_ROOT!, "DerivedDataCache/Compressed.ddp"), join(work, "DerivedDataCache/Compressed.ddp")]);
  });

  it("compiles the C++ module with the sample's plugins", () => {
    const r = run(join(ROOT!, "Engine/Build/BatchFiles/Mac/Build.sh"), ["StudioValleyEditor", "Mac", "Development", `-project=${uproject}`, "-waitmutex"], work, 1200000);
    expect(r.out, r.out.slice(-3000)).toMatch(/Result: Succeeded/);
    expect(r.out).not.toMatch(/warning: /);
  }, 1260000);

  const checkReport = (output: string, code: number) => {
    const line = output.split("\n").find((l) => l.startsWith("GSTUDIO_SMOKE "));
    expect(line, output.slice(-3000)).toBeDefined();
    const report = JSON.parse(line!.slice("GSTUDIO_SMOKE ".length));
    expect(report.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    const names = report.checks.map((c: { name: string }) => c.name);
    expect(names).toEqual(expect.arrayContaining(["the player has the chosen look", "the pointer is hidden for looking around with the mouse", "player walks forward", "talking to someone runs the interact rules", "no errors logged"]));
    expect(report.checks.find((c: { name: string }) => c.name === "the player has the chosen look").detail).toBe("BP_Kellan_C on SandboxCharacter_CMC_C");
    expect(report.observations.collected).toBe(3);
    expect(report.observations.won).toBe(true);
    expect(code).toBe(0);
  };

  it("plays the valley in the editor's game mode as the sample's character wearing MetaHuman Kellan", () => {
    const r = run(join(ROOT!, "Engine/Binaries/Mac/UnrealEditor-Cmd"), [uproject, "-game", "-nullrhi", "-unattended", "-nosound", "-studio-smoke", "-stdout", "-NoLogTimes"], work, 1500000);
    checkReport(r.out, r.code);
  }, 1560000);

  it("packages a macOS app and its headless self-test passes", () => {
    const pack = run(join(ROOT!, "Engine/Build/BatchFiles/RunUAT.sh"), ["BuildCookRun", `-project=${uproject}`, "-noP4", "-platform=Mac", "-clientconfig=Development", "-build", "-cook", "-stage", "-pak", "-package", "-archive", `-archivedirectory=${out}`, "-unattended", "-utf8output"], work, 10800000);
    expect(pack.out, pack.out.slice(-3000)).toMatch(/BUILD SUCCESSFUL/);
    const game = join(out, "Mac/StudioValley.app/Contents/MacOS/StudioValley");
    expect(existsSync(game)).toBe(true);
    const r = run(game, ["-nullrhi", "-unattended", "-nosound", "-studio-smoke", "-LLM"], out, 600000);
    checkReport(r.out, r.code);
  }, 11500000);

  it("cleans up", () => {
    rmSync(root, { recursive: true, force: true });
  });
});
