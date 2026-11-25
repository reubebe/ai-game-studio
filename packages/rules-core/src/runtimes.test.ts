import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs the shared conformance fixtures against the C# (Unity) and C++ (Unreal) rule runtimes, built
 * outside the engines. Each part runs when its compiler is found: clang++ (CXX_BIN, or Xcode's at
 * /usr/bin/clang++) and the .NET SDK (DOTNET_BIN, or dotnet in its standard places).
 * The GDScript runtime is checked by packages/project/src/godot.integration.test.ts (GODOT_BIN).
 */
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = join(repo, "packages/rules-core/src/conformance/fixtures.json");
const firstExisting = (...paths: (string | undefined)[]) => paths.find((p): p is string => Boolean(p) && existsSync(p!));
const CXX = firstExisting(process.env["CXX_BIN"], "/usr/bin/clang++");
const DOTNET = firstExisting(process.env["DOTNET_BIN"], "/usr/local/share/dotnet/dotnet", "/opt/homebrew/bin/dotnet");

const work = mkdtempSync(join(tmpdir(), "gamestudio-runtimes-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function run(program: string, args: string[], cwd = work, env: NodeJS.ProcessEnv = process.env): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(program, args, { cwd, env, encoding: "utf8", timeout: 240000, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
}

describe.skipIf(!CXX)("C++ rule runtime (Unreal)", () => {
  it("builds without warnings, exceptions or RTTI and matches every conformance step", () => {
    const exe = join(work, "conformance-cpp");
    // Close to Unreal's flags: no exceptions, no RTTI, shadowing and narrowing reported, warnings as errors.
    const build = run(CXX!, ["-std=c++20", "-O2", "-Wall", "-Wextra", "-Wshadow", "-Wconversion", "-Wshorten-64-to-32", "-Wsign-conversion", "-Werror", "-fno-exceptions", "-fno-rtti", "-o", exe, join(repo, "engine-addons/unreal/tests/conformance.cpp")]);
    expect(build.code, build.out).toBe(0);
    const r = run(exe, [fixtures]);
    expect(r.out).toMatch(/GSTUDIO_CONFORMANCE PASS 22 steps/);
    expect(r.code).toBe(0);
  }, 120000);
});

describe.skipIf(!DOTNET)("C# rule runtime (Unity)", () => {
  it("builds as C# 9 without warnings and matches every conformance step", () => {
    const dir = join(work, "cs");
    const addon = join(repo, "engine-addons/unity");
    rmSync(dir, { recursive: true, force: true });
    execFileSync("mkdir", ["-p", dir]);
    // C# 9 is what Unity 6 compiles; the runtime must not use anything newer.
    writeFileSync(
      join(dir, "conformance.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><LangVersion>9.0</LangVersion><Nullable>disable</Nullable><ImplicitUsings>disable</ImplicitUsings><EnableDefaultCompileItems>false</EnableDefaultCompileItems><TreatWarningsAsErrors>true</TreatWarningsAsErrors></PropertyGroup>
  <ItemGroup><Compile Include="${addon}/GameStudioRules/*.cs" /><Compile Include="${addon}/tests/Conformance.cs" /></ItemGroup>
</Project>
`,
    );
    const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1" };
    const r = run(DOTNET!, ["run", "--project", join(dir, "conformance.csproj"), "--", fixtures], dir, env);
    expect(r.out, r.out.slice(-3000)).toMatch(/GSTUDIO_CONFORMANCE PASS 22 steps/);
    expect(r.code).toBe(0);
  }, 240000);
});
