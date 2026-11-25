import { describe, expect, it } from "vitest";
import { bundleIdFor, desktopExportPath, enableEtc2Astc, etc2AstcEnabled, exportAppName, generateProject, isSafeRelativePath, macExportPath, parseGodotPresets, planGodotDesktopExport, planGodotExport, planGodotWebExport, webExportPath, type ProjectManifest } from "./index";

const now = new Date("2026-11-18T09:00:00.000Z");
const valley = generateProject("exploration-3d", { title: 'Valley "Quest" / 2', projectId: "valley-quest-2-0001", now });
const file = (path: string) => valley.files.find((f) => f.path === path)?.content ?? null;
const manifest: ProjectManifest = valley.manifest;

describe("macOS export names", () => {
  it("makes safe app names and bundle identifiers", () => {
    expect(exportAppName("Sun Crystal Valley")).toBe("Sun Crystal Valley");
    expect(exportAppName('Valley "Quest" / 2')).toBe("Valley Quest 2");
    expect(exportAppName("Ọ̀wàrẹ́: Evening")).toBe("Oware Evening");
    expect(exportAppName("  ...  ")).toBe("Game");
    for (const t of ["Sun Crystal Valley", "!!x", "a".repeat(200), "../../etc"]) expect(isSafeRelativePath(`exports/macos/${exportAppName(t)}.app`), t).toBe(true);
    expect(bundleIdFor("sun-crystal-valley-3fa2c1")).toBe("com.gamestudio.sun-crystal-valley-3fa2c1");
    expect(bundleIdFor("3d-game-0001")).toBe("com.gamestudio.game-3d-game-0001");
  });

  it("points the preset at exports/macos relative to the Godot folder", () => {
    expect(macExportPath(manifest)).toBe("../exports/macos/Valley Quest 2.app");
  });
});

describe("export presets", () => {
  it("ships new Godot projects ready to export and to play here", () => {
    const presets = parseGodotPresets(file("godot/export_presets.cfg")!);
    expect(presets).toEqual([
      { name: "macOS", platform: "macOS", exportPath: "../exports/macos/Valley Quest 2.app" },
      { name: "Web", platform: "Web", exportPath: "../exports/web/index.html" },
      { name: "Windows", platform: "Windows Desktop", exportPath: "../exports/windows/Valley Quest 2.exe" },
      { name: "Linux", platform: "Linux", exportPath: "../exports/linux/Valley Quest 2.x86_64" },
    ]);
    // Windows and Linux: 64-bit x86, the game's data in a .pck beside the program.
    expect(file("godot/export_presets.cfg")).toContain('[preset.2.options]\n\nbinary_format/architecture="x86_64"\nbinary_format/embed_pck=false\n');
    expect(file("godot/export_presets.cfg")).toContain('[preset.3.options]\n\nbinary_format/architecture="x86_64"\nbinary_format/embed_pck=false\n');
    expect(planGodotDesktopExport({ manifest, target: "windows", presets: file("godot/export_presets.cfg"), gitignore: file(".gitignore") })).toEqual({ writes: [], changes: [], buildPath: "exports/windows/Valley Quest 2.exe", problem: null });
    expect(planGodotDesktopExport({ manifest, target: "linux", presets: file("godot/export_presets.cfg"), gitignore: file(".gitignore") })).toEqual({ writes: [], changes: [], buildPath: "exports/linux/Valley Quest 2.x86_64", problem: null });
    // Single-threaded: the Play here frame has no cross-origin isolation, so no SharedArrayBuffer.
    expect(file("godot/export_presets.cfg")).toContain("[preset.1.options]\n\nvariant/extensions_support=false\nvariant/thread_support=false\n");
    expect(planGodotWebExport({ manifest, presets: file("godot/export_presets.cfg"), gitignore: file(".gitignore") })).toEqual({ writes: [], changes: [], pagePath: "exports/web/index.html", problem: null });
    expect(etc2AstcEnabled(file("godot/project.godot")!)).toBe(true);
    expect(file(".gitignore")!.split("\n")).toContain("exports/");
    const plan = planGodotExport({ manifest, presets: file("godot/export_presets.cfg"), projectGodot: file("godot/project.godot")!, gitignore: file(".gitignore") });
    expect(plan).toEqual({ writes: [], changes: [], appPath: "exports/macos/Valley Quest 2.app", problem: null });
  });

  it("reads quoted values with escapes and ignores other sections", () => {
    const cfg = '[preset.0]\nname="Web"\nplatform="Web"\nexport_path="build/index.html"\n\n[preset.0.options]\nname="not a preset"\n\n[preset.1]\nname="My \\"Mac\\""\nplatform="macOS"\nexport_path="../out/My Game.app"\n';
    expect(parseGodotPresets(cfg)).toEqual([
      { name: "Web", platform: "Web", exportPath: "build/index.html" },
      { name: 'My "Mac"', platform: "macOS", exportPath: "../out/My Game.app" },
    ]);
  });
});

describe("planning an export for an older project", () => {
  const oldGodot = "config_version=5\n\n[application]\n\nconfig/name=\"Old\"\n\n[rendering]\n\nanti_aliasing/quality/msaa_3d=2\n\n[xr]\n\nopenxr/enabled=true\n";

  it("adds the preset, texture setting and ignore rule, and says so", () => {
    const plan = planGodotExport({ manifest, presets: null, projectGodot: oldGodot, gitignore: "# caches\n.DS_Store\n" });
    expect(plan.problem).toBeNull();
    expect(plan.appPath).toBe("exports/macos/Valley Quest 2.app");
    expect(plan.writes.map((w) => w.path)).toEqual(["godot/export_presets.cfg", "godot/project.godot", ".gitignore"]);
    expect(plan.changes).toHaveLength(3);
    const godot = plan.writes[1]!.content;
    expect(godot).toContain("[rendering]\n\ntextures/vram_compression/import_etc2_astc=true\nanti_aliasing/quality/msaa_3d=2\n");
    expect(godot).toContain("[xr]\n\nopenxr/enabled=true\n");
    expect(plan.writes[2]!.content).toBe("# caches\n.DS_Store\nexports/\n");
  });

  it("flips an explicit false and appends a missing rendering section", () => {
    expect(enableEtc2Astc("[rendering]\ntextures/vram_compression/import_etc2_astc=false\n")).toBe("[rendering]\ntextures/vram_compression/import_etc2_astc=true\n");
    expect(enableEtc2Astc("config_version=5\n")).toBe("config_version=5\n\n[rendering]\n\ntextures/vram_compression/import_etc2_astc=true\n");
    expect(etc2AstcEnabled("textures/vram_compression/import_etc2_astc=false")).toBe(false);
  });

  it("keeps a user's macOS preset and refuses paths that leave the project", () => {
    const mine = '[preset.0]\nname="Mac Release"\nplatform="macOS"\nexport_path="../builds/Mine.app"\n';
    const ok = planGodotExport({ manifest, presets: mine, projectGodot: file("godot/project.godot")!, gitignore: "exports/\n" });
    expect(ok.appPath).toBe("builds/Mine.app");
    expect(ok.writes).toEqual([]);
    for (const bad of ["../../Elsewhere.app", "/Applications/Mine.app", "../builds/Mine.zip", ""]) {
      const plan = planGodotExport({ manifest, presets: mine.replace("../builds/Mine.app", bad), projectGodot: oldGodot, gitignore: null });
      expect(plan.problem, bad).toMatch(/project folder|\.app/);
      expect(plan.writes, bad).toEqual([]);
    }
    expect(planGodotExport({ manifest, presets: '[preset.0]\nname="Web"\nplatform="Web"\n', projectGodot: oldGodot, gitignore: null }).problem).toMatch(/no macOS preset/);
  });
});

describe("planning Play here for an older project", () => {
  const mac = '; mine\n[preset.0]\nname="Mac Release"\nplatform="macOS"\nexport_path="../builds/Mine.app"\n\n[preset.0.options]\n\nbinary_format/architecture="universal"\n';

  it("appends a Web preset after the user's presets, keeping them, and says so", () => {
    expect(webExportPath(manifest)).toBe("../exports/web/index.html");
    const plan = planGodotWebExport({ manifest, presets: mac, gitignore: "exports/\n" });
    expect(plan.problem).toBeNull();
    expect(plan.pagePath).toBe("exports/web/index.html");
    expect(plan.writes.map((w) => w.path)).toEqual(["godot/export_presets.cfg"]);
    const cfg = plan.writes[0]!.content;
    expect(cfg.startsWith(mac)).toBe(true);
    expect(cfg).toContain("\n[preset.1]\n");
    expect(cfg).toContain("[preset.1.options]");
    expect(parseGodotPresets(cfg).map((p) => p.platform)).toEqual(["macOS", "Web"]);
    expect(plan.changes).toEqual([expect.stringContaining("Add a Web preset to godot/export_presets.cfg")]);
  });

  it("creates the presets file and the ignore rule when both are missing", () => {
    const plan = planGodotWebExport({ manifest, presets: null, gitignore: null });
    expect(plan.writes.map((w) => w.path)).toEqual(["godot/export_presets.cfg", ".gitignore"]);
    expect(parseGodotPresets(plan.writes[0]!.content)).toEqual([{ name: "Web", platform: "Web", exportPath: "../exports/web/index.html" }]);
    expect(plan.writes[1]!.content).toBe("exports/\n");
    expect(plan.changes).toHaveLength(2);
  });

  it("keeps a user's Web preset and refuses pages outside the project", () => {
    const mine = '[preset.3]\nname="Browser"\nplatform="Web"\nexport_path="../site/game.html"\n';
    expect(planGodotWebExport({ manifest, presets: mine, gitignore: "exports/\n" })).toEqual({ writes: [], changes: [], pagePath: "site/game.html", problem: null });
    for (const bad of ["../../Elsewhere/index.html", "/tmp/index.html", "../site/game.zip", "", "..\\\\site\\\\game.html"]) {
      const plan = planGodotWebExport({ manifest, presets: mine.replace("../site/game.html", bad), gitignore: null });
      expect(plan.problem, bad).toMatch(/project folder|\.html/);
      expect(plan.writes, bad).toEqual([]);
    }
  });
});

describe("planning a Windows or Linux export for an older project", () => {
  const older = '; mine\n[preset.0]\nname="Mac Release"\nplatform="macOS"\nexport_path="../builds/Mine.app"\n\n[preset.1]\nname="Web"\nplatform="Web"\nexport_path="../exports/web/index.html"\n';

  it("appends the platform's preset after the user's presets, keeping them, and says so", () => {
    expect(desktopExportPath(manifest, "windows")).toBe("../exports/windows/Valley Quest 2.exe");
    expect(desktopExportPath(manifest, "linux")).toBe("../exports/linux/Valley Quest 2.x86_64");
    const plan = planGodotDesktopExport({ manifest, target: "windows", presets: older, gitignore: "exports/\n" });
    expect(plan.problem).toBeNull();
    expect(plan.buildPath).toBe("exports/windows/Valley Quest 2.exe");
    expect(plan.writes.map((w) => w.path)).toEqual(["godot/export_presets.cfg"]);
    const cfg = plan.writes[0]!.content;
    expect(cfg.startsWith(older)).toBe(true);
    expect(cfg).toContain("\n[preset.2]\n");
    expect(parseGodotPresets(cfg).map((p) => p.platform)).toEqual(["macOS", "Web", "Windows Desktop"]);
    expect(plan.changes).toEqual([expect.stringContaining("Add a Windows preset")]);
    // Adding Linux afterwards numbers it after Windows.
    const linux = planGodotDesktopExport({ manifest, target: "linux", presets: cfg, gitignore: "exports/\n" });
    expect(linux.writes[0]!.content).toContain("\n[preset.3]\n");
    expect(parseGodotPresets(linux.writes[0]!.content).map((p) => p.name)).toEqual(["Mac Release", "Web", "Windows", "Linux"]);
  });

  it("creates the presets file and the ignore rule when both are missing", () => {
    const plan = planGodotDesktopExport({ manifest, target: "linux", presets: null, gitignore: null });
    expect(plan.writes.map((w) => w.path)).toEqual(["godot/export_presets.cfg", ".gitignore"]);
    expect(parseGodotPresets(plan.writes[0]!.content)).toEqual([{ name: "Linux", platform: "Linux", exportPath: "../exports/linux/Valley Quest 2.x86_64" }]);
    expect(plan.writes[1]!.content).toBe("exports/\n");
    expect(plan.changes).toHaveLength(2);
  });

  it("keeps a user's own preset, including Godot 4.1's Linux/X11 name, and refuses paths outside the project", () => {
    const mine = '[preset.5]\nname="PC"\nplatform="Windows Desktop"\nexport_path="../dist/pc/Game.exe"\n';
    expect(planGodotDesktopExport({ manifest, target: "windows", presets: mine, gitignore: "exports/\n" })).toEqual({ writes: [], changes: [], buildPath: "dist/pc/Game.exe", problem: null });
    const x11 = '[preset.0]\nname="Penguin"\nplatform="Linux/X11"\nexport_path="../dist/linux/game"\n';
    expect(planGodotDesktopExport({ manifest, target: "linux", presets: x11, gitignore: "exports/\n" })).toEqual({ writes: [], changes: [], buildPath: "dist/linux/game", problem: null });
    for (const bad of ["../../Elsewhere/Game.exe", "/tmp/Game.exe", "../dist/pc/Game.zip", "", "..\\\\dist\\\\Game.exe", "../dist/pc/", "../dist/.exe", "../../../.."]) {
      const plan = planGodotDesktopExport({ manifest, target: "windows", presets: mine.replace("../dist/pc/Game.exe", bad), gitignore: null });
      expect(plan.problem, bad).toMatch(/project folder|\.exe/);
      expect(plan.writes, bad).toEqual([]);
    }
    for (const bad of ["../../outside/game", "/usr/local/bin/game", "", "../dist/linux/", "../.."]) {
      const plan = planGodotDesktopExport({ manifest, target: "linux", presets: x11.replace("../dist/linux/game", bad), gitignore: null });
      expect(plan.problem, bad).toMatch(/project folder|a file/);
    }
  });
});
