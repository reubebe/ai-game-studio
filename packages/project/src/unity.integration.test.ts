import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateProject } from "./index";

/**
 * Builds the generated Unity project with a real editor and runs the built game's self-test.
 * Skipped unless UNITY_BIN points to a Unity 6 editor executable, for example:
 *   UNITY_BIN=/Applications/Unity/Hub/Editor/6000.6.9f1/Unity.app/Contents/MacOS/Unity npx vitest run packages/project/src/unity.integration.test.ts
 * Needs an activated Unity licence (Unity Hub sign-in) and the Mac Build Support module.
 */
const UNITY = process.env["UNITY_BIN"];
const version = UNITY?.match(/Editor\/([^/]+)\/Unity\.app/)?.[1];

function run(program: string, args: string[], timeout: number): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(program, args, { encoding: "utf8", timeout, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
}

describe.skipIf(!UNITY)("Unity integration (real editor)", () => {
  // Written in beforeAll: describe bodies run even when the suite is skipped.
  let root = "";
  let app = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "gamestudio-unity-"));
    for (const f of generateProject("exploration-unity", { title: "Integration Valley", projectId: "integration-valley-0001", engineVersion: version }).files) {
      const path = join(root, f.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, f.content);
    }
    app = join(root, "exports/unity-macos/Integration Valley.app");
  });

  it("builds a macOS app in batch mode without touching the package list", () => {
    mkdirSync(dirname(app), { recursive: true });
    const manifestBefore = readFileSync(join(root, "unity/Packages/manifest.json"), "utf8");
    const r = run(UNITY!, ["-batchmode", "-nographics", "-quit", "-projectPath", join(root, "unity"), "-executeMethod", "GameStudio.EditorTools.StudioBuild.BuildMac", "-studioOutput", app, "-studioProduct", "Integration Valley", "-studioBundleId", "com.gamestudio.integration-valley-0001", "-logFile", "-"], 900000);
    expect(r.out).not.toMatch(/error CS\d+/);
    expect(r.out).toMatch(/GSTUDIO_BUILD \{"result":"Succeeded"/);
    expect(r.code).toBe(0);
    expect(readFileSync(join(root, "unity/Packages/manifest.json"), "utf8")).toBe(manifestBefore);
    expect(existsSync(join(root, "unity/Assets/GameStudio/Scenes/Main.unity"))).toBe(true);
  }, 960000);

  it("runs the built game headlessly: level, ground, walking, talking, collecting and the rules", () => {
    const exe = join(app, "Contents/MacOS/Integration Valley");
    expect(existsSync(exe)).toBe(true);
    const r = run(exe, ["-batchmode", "-nographics", "-logFile", "-", "--studio-smoke"], 120000);
    const line = r.out.split("\n").find((l) => l.startsWith("GSTUDIO_SMOKE "));
    expect(line, r.out.slice(-3000)).toBeDefined();
    const report = JSON.parse(line!.slice("GSTUDIO_SMOKE ".length));
    expect(report.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    expect(report.observations.collected).toBe(3);
    // The valley rules ran in C#: objective, Elder Ama's first line, the gate after three crystals, the win.
    expect(report.checks.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(["rule programs load", "start rules set an objective", "talking to someone runs the interact rules", "rules run without errors"]));
    expect(report.observations.messages).toEqual(expect.arrayContaining([expect.stringMatching(/^Elder Ama: .Three sun crystals/), "Sun crystal 3 of 3"]));
    expect(report.observations.gatesOpen).toEqual({ gate_main: true });
    expect(report.observations.objective).toMatch(/gate is open/);
    expect(report.observations.won).toBe(true);
    expect(report.observations.sounds).toEqual(expect.arrayContaining(["chime", "gate", "success"]));
    expect(r.code).toBe(0);
  }, 150000);

  it("cleans up", () => {
    rmSync(root, { recursive: true, force: true });
  });
});
