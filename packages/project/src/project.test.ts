import { describe, expect, it } from "vitest";
import { compileGraph } from "@gamestudio/rules-core";
import { valleyRules, parseWorld } from "@gamestudio/explore";
import { parseCatalog } from "@gamestudio/rpg";
import { parseLesson } from "@gamestudio/learn";
import {
  TEMPLATES,
  createStudioRegistry,
  folderNameFor,
  generateProject,
  godotString,
  isSafeRelativePath,
  parseManifest,
  planEngineSync,
  slugify,
  type GeneratedProject,
} from "./index";

const registry = createStudioRegistry();
const now = new Date("2026-11-18T09:00:00.000Z");
// The realistic Unreal template needs Epic's Game Animation Sample; a stand-in with no settings of its own.
const SAMPLE = { config: { "DefaultEngine.ini": "" }, uproject: JSON.stringify({ EngineAssociation: "5.8" }) };
const make = (id: string, title = "Test Game"): GeneratedProject => generateProject(id, { title, projectId: "test-game-0001", now, unrealSample: SAMPLE });
const file = (p: GeneratedProject, path: string) => p.files.find((f) => f.path === path)?.content;

describe("paths", () => {
  it("accepts ordinary project paths and refuses escapes", () => {
    for (const ok of ["gamestudio.json", "rules/a.rules.json", "godot/scenes/main.tscn", "assets/My Image (1).png", ".gitignore", "godot/.gitattributes"]) expect(isSafeRelativePath(ok)).toBe(true);
    for (const bad of ["", "/etc/passwd", "../x", "a/../../b", "a//b", "a\\b", "./a", ".hidden", "a/.git/config", "a\0b", ".env", ".gitignore/x", ".git"]) expect(isSafeRelativePath(bad)).toBe(false);
  });

  it("derives slugs and folder names", () => {
    expect(slugify("Sun Crystal Valley!")).toBe("sun-crystal-valley");
    expect(slugify("Ọ̀wàrẹ́")).toBe("oware");
    expect(slugify("!!")).toBe("game-project");
    expect(folderNameFor("My: Game/2")).toBe("My Game 2");
  });
});

describe("manifest", () => {
  it("round-trips a generated manifest", () => {
    const p = make("oware-abapa");
    expect(parseManifest(JSON.parse(file(p, "gamestudio.json")!))).toEqual({ ok: true, manifest: p.manifest });
  });

  it("explains when a project comes from a newer studio", () => {
    const m = { ...make("oware-abapa").manifest, schemaVersion: "2.0.0" };
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/newer Game Studio/);
  });

  it("rejects unsafe paths inside a manifest", () => {
    const m = make("oware-abapa").manifest;
    const r = parseManifest({ ...m, rules: [{ id: "x", path: "../../outside.json", domain: "oware" }] });
    expect(r.ok).toBe(false);
  });
});

describe("templates", () => {
  const available = TEMPLATES.filter((t) => t.status !== "planned");

  for (const t of available) {
    it(`${t.id} produces a valid, self-consistent project`, () => {
      const p = make(t.id);
      expect(parseManifest(p.manifest).ok).toBe(true);
      expect(p.manifest.template.id).toBe(t.id);
      for (const f of p.files) expect(isSafeRelativePath(f.path)).toBe(true);
      for (const r of p.manifest.rules) {
        const doc = JSON.parse(file(p, r.path)!);
        const result = compileGraph(doc, registry);
        expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      }
      for (const d of p.manifest.data) {
        const doc = JSON.parse(file(p, d.path)!);
        if (d.kind === "explore-world") expect(parseWorld(doc).ok).toBe(true);
        if (d.kind === "creature-catalog") expect(parseCatalog(doc).ok).toBe(true);
        if (d.kind === "lesson") expect(parseLesson(doc).ok).toBe(true);
      }
      expect(file(p, p.manifest.assetsIndex)).toBeDefined();
    });
  }

  it("offers every listed template and refuses empty titles", () => {
    expect(TEMPLATES.filter((t) => t.status === "planned")).toEqual([]);
    expect(() => generateProject("oware-abapa", { title: "   " })).toThrow(/title/);
    expect(() => generateProject("nope", { title: "x" })).toThrow(/Unknown template/);
  });

  it("documents the Oware variant and its sources", () => {
    const doc = file(make("oware-abapa"), "docs/rules/oware-abapa.md")!;
    expect(doc).toMatch(/not a universal ruleset/);
    expect(doc).toMatch(/wikipedia\.org\/wiki\/Oware/);
  });
});

describe("Godot exploration project", () => {
  const p = make("exploration-3d", 'Valley "Quest" \\ 2');

  it("writes an escaped title into project.godot", () => {
    expect(godotString('a "b" \\ c')).toBe('a \\"b\\" \\\\ c');
    expect(file(p, "godot/project.godot")).toContain('config/name="Valley \\"Quest\\" \\\\ 2"');
    expect(file(p, "godot/project.godot")).toContain('run/main_scene="res://scenes/main.tscn"');
  });

  it("includes the runtime, its conformance fixtures and compiled engine data", () => {
    for (const path of ["godot/addons/gamestudio_runtime/rules_vm.gd", "godot/addons/gamestudio_runtime/tests/run_conformance.gd", "godot/addons/gamestudio_runtime/tests/fixtures.json", "godot/gamestudio_data/world.json", "godot/gamestudio_data/rules_index.json"]) {
      expect(file(p, path), path).toBeDefined();
    }
    const ir = JSON.parse(file(p, "godot/gamestudio_data/rules/valley-rules.ir.json")!);
    expect(ir).toEqual(compileGraph(valleyRules(), registry).program);
    expect(JSON.parse(file(p, "godot/gamestudio_data/rules_index.json")!).programs).toEqual(["valley-rules.ir.json"]);
  });

  it("resolves every res:// reference to a generated file", () => {
    const paths = new Set(p.files.map((f) => f.path));
    const missing: string[] = [];
    for (const f of p.files.filter((x) => /\.(gd|tscn|godot)$/.test(x.path))) {
      for (const m of f.content.matchAll(/res:\/\/([A-Za-z0-9_\/.-]+\.(?:gdshader|gd|tscn|svg|json))(?![A-Za-z0-9_])/g)) {
        const target = `godot/${m[1]}`;
        // The VRM add-on names a file it writes when exporting a character (not one it reads).
        const written = f.path.startsWith("godot/addons/vrm/") && m[1] === "saved_outgoing_vrm.tscn";
        if (!paths.has(target) && !written && !m[1]!.startsWith("gamestudio_data/rules/")) missing.push(`${f.path} -> ${target}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("indents GDScript with tabs only", () => {
    const offenders = p.files.filter((f) => f.path.endsWith(".gd")).flatMap((f) => f.content.split("\n").map((line, i) => ({ path: f.path, line: i + 1, text: line })).filter((l) => /^ +\S/.test(l.text) || /^\t* +\t/.test(l.text)));
    expect(offenders).toEqual([]);
  });

  it("keeps generated scenes in Godot 4 text format", () => {
    for (const f of p.files.filter((x) => x.path.endsWith(".tscn"))) expect(f.content.startsWith("[gd_scene format=3]")).toBe(true);
  });
});

describe("C++ / SFML project", () => {
  const p = make("cpp-sfml-arcade");

  it("contains a CMake project with tests and a settings file", () => {
    expect(p.manifest.engine).toEqual({ id: "cpp-sfml", version: "3", projectDir: "cpp", target: "crystal_catcher" });
    for (const path of ["cpp/CMakeLists.txt", "cpp/src/game.cpp", "cpp/src/main.cpp", "cpp/tests/game_tests.cpp", "cpp/game.cfg"]) expect(file(p, path), path).toBeDefined();
    expect(file(p, "cpp/CMakeLists.txt")).toContain("find_package(SFML 3 REQUIRED");
    expect(file(p, ".gitignore")).toContain("cpp/build/");
  });
});

describe("XR foundation", () => {
  const p = make("xr-foundation");

  it("enables OpenXR, adds the XR scene and says it is unverified", () => {
    expect(file(p, "godot/project.godot")).toMatch(/\[xr\]\s+openxr\/enabled=true/);
    // Without this, Godot shows a modal startup alert when no OpenXR runtime exists and the run never starts.
    expect(file(p, "godot/project.godot")).toContain("openxr/startup_alert=false");
    expect(file(p, "godot/scenes/xr_main.tscn")).toContain('type="XROrigin3D"');
    expect(p.manifest.xr?.verifiedOnHeadset).toBe(false);
    expect(file(p, "docs/xr-checklist.md")).toMatch(/not verified on a headset/);
  });
});

describe("engine sync", () => {
  const p = make("exploration-3d");
  const docs = Object.fromEntries(p.files.filter((f) => f.path.endsWith(".json")).map((f) => [f.path, JSON.parse(f.content)]));

  it("compiles rules and copies the validated layout into the Godot project", () => {
    const plan = planEngineSync(p.manifest, docs, registry);
    expect(plan.ok).toBe(true);
    expect(plan.writes.map((w) => w.path).sort()).toEqual(["godot/gamestudio_data/rules/valley-rules.ir.json", "godot/gamestudio_data/rules_index.json", "godot/gamestudio_data/world.json"]);
    for (const w of plan.writes) expect(w.content).toBe(file(p, w.path));
  });

  it("writes no rules when any graph fails to compile", () => {
    const broken = structuredClone(docs);
    (broken["rules/valley-rules.rules.json"] as { nodes: unknown[] }).nodes.push({ id: "bad", type: "core.unknown", position: { x: 0, y: 0 }, params: {} });
    const plan = planEngineSync(p.manifest, broken, registry);
    expect(plan.ok).toBe(false);
    expect(plan.writes.map((w) => w.path)).toEqual(["godot/gamestudio_data/world.json"]);
    expect(plan.problems[0]!.messages.join(" ")).toMatch(/Unknown node type/);
  });

  it("reports an invalid layout without writing it", () => {
    const broken = structuredClone(docs);
    (broken["data/world.json"] as { player: { speed: number } }).player.speed = 999;
    const plan = planEngineSync(p.manifest, broken, registry);
    expect(plan.ok).toBe(false);
    expect(plan.writes.some((w) => w.path.endsWith("world.json"))).toBe(false);
  });

  it("does nothing for studio-board projects", () => {
    expect(planEngineSync(make("oware-abapa").manifest, {}, registry)).toEqual({ ok: true, writes: [], problems: [] });
  });

  it("writes the adventure's rules, with enemies, blocks and timers, into its Godot project", () => {
    const a = make("adventure-3d");
    const adocs = Object.fromEntries(a.files.filter((f) => f.path.endsWith(".json")).map((f) => [f.path, JSON.parse(f.content)]));
    const plan = planEngineSync(a.manifest, adocs, registry);
    expect(plan.ok).toBe(true);
    expect(plan.writes.map((w) => w.path).sort()).toEqual(["godot/gamestudio_data/rules/ruins-rules.ir.json", "godot/gamestudio_data/rules_index.json", "godot/gamestudio_data/world.json"]);
    expect(plan.writes.find((w) => w.path.endsWith("ruins-rules.ir.json"))!.content).toMatch(/explore\.startTimer/);
  });

  it("refuses Godot-only nodes in Unity and Unreal projects and leaves their game's rules as they were", () => {
    for (const engine of ["exploration-unity", "exploration-unreal"]) {
      const u = make(engine);
      const rules = JSON.parse(file(u, "rules/valley-rules.rules.json")!);
      rules.nodes.push({ id: "clock", type: "explore.action.startTimer", position: { x: 0, y: 2000 }, params: { timerId: "t", seconds: 10, repeat: false, countdown: "" } });
      rules.edges.push({ id: "e-clock", source: "welcome", sourceHandle: "exec:out", target: "clock", targetHandle: "exec:in" });
      expect(compileGraph(rules, registry).ok, engine).toBe(true);
      const plan = planEngineSync(u.manifest, { "rules/valley-rules.rules.json": rules, "data/world.json": JSON.parse(file(u, "data/world.json")!) }, registry);
      expect(plan.ok, engine).toBe(false);
      expect(plan.problems[0]!.messages, engine).toEqual([`"Start Timer" works in Godot projects only, and this project uses ${engine === "exploration-unity" ? "Unity" : "Unreal"}.`]);
      expect(plan.writes.some((w) => w.path.includes("rules")), engine).toBe(false);
    }
  });
});

describe("3D adventure project", () => {
  const a = make("adventure-3d", "Ruins Test");
  const v = make("exploration-3d", "Ruins Test");

  it("is the valley's Godot project with the ruins' layout and rules", () => {
    const godot = (p: GeneratedProject) => p.files.filter((f) => f.path.startsWith("godot/") && !f.path.startsWith("godot/gamestudio_data/") && !f.path.startsWith("godot/assets/")).map((f) => `${f.path}\n${f.content}`).sort();
    expect(godot(a)).toEqual(godot(v));
    // The adventure also ships the models made with Kiln that its layout uses (the valley ships none).
    expect(a.files.filter((f) => f.path.startsWith("godot/assets/")).map((f) => f.path).sort()).toEqual(
      ["shrine-gate", "stone-block", "thorn-beetle", "wood-crate"].map((n) => `godot/assets/models/kiln/${n}.gltf`),
    );
    expect(v.files.some((f) => f.path.startsWith("godot/assets/"))).toBe(false);
    const layout = JSON.parse(file(a, "data/world.json")!) as { objects: { id: string; model?: string }[] };
    const used = layout.objects.filter((o) => o.model).map((o) => o.model!);
    expect(new Set(used)).toEqual(new Set(["assets/models/kiln/thorn-beetle.gltf", "assets/models/kiln/stone-block.gltf", "assets/models/kiln/shrine-gate.gltf"]));
    for (const model of used) expect(JSON.parse(file(a, `godot/${model}`)!).asset.version).toBe("2.0");
    expect(JSON.parse(file(a, "data/world.json")!).name).toBe("Thornwood Ruins");
    expect(a.manifest.rules).toEqual([{ id: "ruins-rules", path: "rules/ruins-rules.rules.json", domain: "explore" }]);
    expect(a.manifest.genre).toEqual(["adventure", "action", "3d"]);
    expect(file(a, "README.md")).toMatch(/F or a click swings your staff/);
  });
});
