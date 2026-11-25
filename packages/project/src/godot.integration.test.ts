import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { grassKeepOut, natureMeshes, placeTufts, sunCrystalValley, thornwoodRuins, turnOf, variantOf, type NatureKind, type World } from "@gamestudio/explore";
import { generateProject } from "./index";
import { boxGlb, characterGlb, checkerPng, humanoidVrm, skyHdr, spriteSheetPng, toneWav } from "./test-assets";

/**
 * Runs the generated Godot project in a real engine. Skipped unless GODOT_BIN points to a
 * Godot 4.7 executable, for example:
 *   GODOT_BIN=/Applications/Godot.app/Contents/MacOS/Godot npx vitest run packages/project/src/godot.integration.test.ts
 */
/** Engines run from inside the generated project, so a relative path such as .engines/... is resolved from where the tests were started. */
const binPath = (value: string | undefined) => (value?.includes("/") ? resolve(value) : value);
const GODOT = binPath(process.env["GODOT_BIN"]);

/** The game grew its grass where the studio's 3D view draws it (grass.gd and @gamestudio/explore, placeTufts). */
function expectSameGrass(observed: unknown, world: World) {
  const e = world.environment;
  const tufts = placeTufts(world.size.width, world.size.depth, e.grass ?? 0, e.groundVariation ?? 0, grassKeepOut(world));
  const g = observed as { tufts: number; sample: number[][] };
  expect(tufts.length).toBeGreaterThan(1000);
  expect(g.tufts).toBe(tufts.length);
  const want = [...tufts.slice(0, 3), tufts[tufts.length - 1]!];
  expect(g.sample.length).toBe(4);
  g.sample.forEach((t, n) => t.forEach((v, k) => expect(v, `tuft ${n}, value ${k}`).toBeCloseTo(want[n]![k]!, 6)));
}

type NatureReport = Record<string, { turn: number; parts: { vertices: number; triangles: number; sample: number[][] }[] }>;

/**
 * The realistic style built every tree and rock as the studio's 3D view does (nature.gd and
 * @gamestudio/explore, natureMeshes): same shape for the id, same turn, same corners and colours (Godot
 * keeps vertex colours as 8-bit values, hence the colour tolerance).
 */
function expectSameNature(observed: unknown, objects: { id: string; type: string; variant?: string }[]) {
  const nature = observed as NatureReport;
  const detailed = objects.filter((o) => o.type === "tree" || o.type === "rock");
  expect(detailed.length).toBeGreaterThan(4);
  expect(Object.keys(nature).sort()).toEqual(detailed.map((o) => o.id).sort());
  for (const o of detailed) {
    const got = nature[o.id]!;
    const want = natureMeshes((o.type === "rock" ? "rock" : (o.variant ?? "round")) as NatureKind, variantOf(o.id));
    expect(got.turn, o.id).toBeCloseTo(turnOf(o.id), 5);
    expect(got.parts.length, o.id).toBe(want.length);
    got.parts.forEach((part, k) => {
      const m = want[k]!;
      const count = m.positions.length / 3;
      expect(part.vertices, `${o.id} mesh ${k}`).toBe(count);
      expect(part.triangles, `${o.id} mesh ${k}`).toBe(m.indices.length / 3);
      [0, count >> 1, count - 1].forEach((i, n) => {
        const s = part.sample[n]!;
        for (let a = 0; a < 3; a++) expect(s[a], `${o.id} mesh ${k} corner ${i} axis ${a}`).toBeCloseTo(m.positions[i * 3 + a]!, 3);
        for (let c = 0; c < 3; c++) expect(Math.abs(s[3 + c]! - m.colors[i * 3 + c]!), `${o.id} mesh ${k} corner ${i} colour ${c}`).toBeLessThan(1 / 255 + 1e-6);
      });
    });
  }
}

/**
 * Optional: CONTAINER_BIN=podman (or docker) also runs the exported Windows and Linux programs themselves, in
 * x86-64 Linux containers (emulated on Apple silicon): the Linux one in Debian, the Windows one under Wine from
 * Debian's packages (tests/containers/wine, built on first use). No network; the build is mounted read-only.
 */
const CONTAINER = binPath(process.env["CONTAINER_BIN"]);
const TEMPLATES = join(homedir(), "Library/Application Support/Godot/export_templates/4.7.2.stable");
const DESKTOP_TEMPLATES = ["windows_release_x86_64.exe", "linux_release.x86_64"].map((f) => join(TEMPLATES, f));
/** Debian 12 slim, pinned by its multi-platform digest. */
const DEBIAN = "docker.io/library/debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc";
const WINE_IMAGE = "localhost/gamestudio-wine:bookworm";

/** A program's output whether or not it succeeded, for reading its GSTUDIO_SMOKE line. */
function output(file: string, args: string[], cwd: string, timeout = 300000): string {
  try {
    return execFileSync(file, args, { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  }
}

interface SmokeReport {
  pass: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
  observations: Record<string, unknown>;
}

/** The game's self-test report (its GSTUDIO_SMOKE line). */
function smokeReport(out: string, where: string): SmokeReport {
  const line = out.split("\n").find((l) => l.includes("GSTUDIO_SMOKE {"));
  expect(line, `${where}: ${out.slice(-4000)}`).toBeDefined();
  return JSON.parse(line!.slice(line!.indexOf("GSTUDIO_SMOKE ") + "GSTUDIO_SMOKE ".length)) as SmokeReport;
}

/** Builds the Wine image the first time it is needed. If apt says a Release file is "not valid yet", the container VM's clock is behind. */
function wineImage(): string {
  try {
    execFileSync(CONTAINER!, ["image", "inspect", WINE_IMAGE], { stdio: "ignore" });
  } catch {
    const context = fileURLToPath(new URL("../../../tests/containers/wine", import.meta.url));
    execFileSync(CONTAINER!, ["build", "--platform", "linux/amd64", "-t", WINE_IMAGE, context], { stdio: "inherit", timeout: 1_800_000 });
  }
  return WINE_IMAGE;
}

/**
 * Exports the project with its Windows and Linux presets, checks the program and its .pck, runs the exported game
 * data's self-test with Godot here (what the studio's Export buttons do), and with CONTAINER_BIN runs the programs.
 */
function exportDesktopBuilds(root: string, godotDir: string, title: string, judge: (report: SmokeReport, where: string) => void): void {
  for (const [preset, rel] of [["Windows", `exports/windows/${title}.exe`], ["Linux", `exports/linux/${title}.x86_64`]] as const) {
    const program = join(root, rel);
    mkdirSync(dirname(program), { recursive: true });
    const exported = output(GODOT!, ["--headless", "--path", godotDir, "--export-release", preset, program], godotDir);
    expect(existsSync(program), exported.slice(-3000)).toBe(true);
    const pack = program.replace(/\.[^./]+$/, ".pck");
    expect(statSync(pack).size).toBeGreaterThan(20_000);
    const magic = readFileSync(program).subarray(0, 4).toString("latin1");
    expect(preset === "Windows" ? magic.slice(0, 2) : magic, preset).toBe(preset === "Windows" ? "MZ" : "\x7fELF");
    judge(smokeReport(output(GODOT!, ["--headless", "--main-pack", pack, "--", "--studio-smoke"], dirname(program)), `${preset} game data`), `${preset} game data in Godot here`);
    if (!CONTAINER) continue;
    const dir = realpathSync(dirname(program));
    const run = ["run", "--rm", "--platform", "linux/amd64", "--network", "none", "-v", `${dir}:/game:ro`];
    const out =
      preset === "Linux"
        ? output(CONTAINER, [...run, DEBIAN, `/game/${basename(program)}`, "--headless", "--", "--studio-smoke"], dir, 900000)
        : output(CONTAINER, [...run, wineImage(), "wine", `/game/${basename(program)}`, "--headless", "--", "--studio-smoke"], dir, 900000);
    judge(smokeReport(out, `${preset} program`), `${preset} program in a container`);
  }
}

/** Writes a generated project into a new temporary folder. Call it from beforeAll: describe bodies run even for skipped suites. */
function writeProject(prefix: string, files: { path: string; content: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const f of files) {
    const path = join(root, f.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.content);
  }
  return root;
}

describe.skipIf(!GODOT)("Godot integration (real engine)", () => {
  let root = "";
  let godotDir = "";
  beforeAll(() => {
    root = writeProject("gamestudio-godot-", generateProject("exploration-3d", { title: "Integration Valley", projectId: "integration-valley-0001" }).files);
    godotDir = join(root, "godot");
  });
  const run = (args: string[], timeout = 240000) => {
    try {
      return { code: 0, out: execFileSync(GODOT!, args, { cwd: godotDir, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
    }
  };

  it("imports the project", () => {
    const r = run(["--headless", "--path", godotDir, "--import"]);
    expect(existsSync(join(godotDir, ".godot"))).toBe(true);
    expect(r.out).not.toMatch(/SCRIPT ERROR|Parse Error/);
  }, 300000);

  it("runs the GDScript rules VM against the shared conformance fixtures", () => {
    const r = run(["--headless", "--path", godotDir, "--script", "res://addons/gamestudio_runtime/tests/run_conformance.gd"]);
    expect(r.out).toMatch(/GSTUDIO_CONFORMANCE PASS 22 steps/);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/leaked at exit/);
  }, 120000);

  it("plays the level headlessly: physics, movement, collecting, the gate and the shrine", () => {
    const r = run(["--headless", "--path", godotDir, "--", "--studio-smoke"]);
    const line = r.out.split("\n").find((l) => l.startsWith("GSTUDIO_SMOKE "));
    expect(line, r.out.slice(-4000)).toBeDefined();
    const report = JSON.parse(line!.slice("GSTUDIO_SMOKE ".length));
    expect(report.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.observations.gatesOpen).toEqual({ gate_main: true });
    expect(report.observations.won).toBe(true);
    expect(report.observations.objective).toMatch(/gate is open/);
    // Elder Ama answers typed questions (through a stand-in for Game Studio in this headless run).
    expect(report.checks.map((c: { name: string }) => c.name)).toContain("a typed question goes to Game Studio and the villager's answer appears");
    expect(report.observations.chats).toEqual([{ npc: "elder", question: "What do you look after here?", answer: "A stand-in answer to: What do you look after here?", error: "" }]);
    expectSameGrass(report.observations.grass, sunCrystalValley());
    expect(r.out).not.toMatch(/SCRIPT ERROR/);
    expect(r.out).not.toMatch(/leaked at exit/);
  }, 120000);

  it("opens in the Godot editor, including the @tool layout preview, without script errors", () => {
    const r = run(["--headless", "--editor", "--path", godotDir, "--quit-after", "120"]);
    expect(r.out).not.toMatch(/SCRIPT ERROR|Parse Error/);
  }, 180000);

  // Needs the official 4.7.2 export templates where Godot looks for them; skipped otherwise.
  const templates = join(homedir(), "Library/Application Support/Godot/export_templates/4.7.2.stable/macos.zip");
  it.skipIf(!existsSync(templates))("exports a universal macOS app with the generated preset, and the exported game passes its self-test", () => {
    const app = join(root, "exports/macos/Integration Valley.app");
    mkdirSync(dirname(app), { recursive: true });
    const r = run(["--headless", "--path", godotDir, "--export-release", "macOS", app], 300000);
    expect(r.code, r.out.slice(-3000)).toBe(0);
    const exe = join(app, "Contents/MacOS/Integration Valley");
    expect(existsSync(exe)).toBe(true);
    expect(execFileSync("/usr/bin/lipo", ["-archs", exe], { encoding: "utf8" }).trim().split(" ").sort()).toEqual(["arm64", "x86_64"]);
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    let out: string;
    try {
      out = execFileSync(exe, ["--headless", "--", "--studio-smoke"], { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    }
    const line = out.split("\n").find((l) => l.startsWith("GSTUDIO_SMOKE "));
    expect(line, out.slice(-3000)).toBeDefined();
    const report = JSON.parse(line!.slice("GSTUDIO_SMOKE ".length));
    expect(report.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    expect(report.observations.won).toBe(true);
  }, 420000);

  // Play here: the single-threaded web template, from the same release.
  const webTemplate = join(homedir(), "Library/Application Support/Godot/export_templates/4.7.2.stable/web_nothreads_debug.zip");
  it.skipIf(!existsSync(webTemplate))("builds the single-threaded web version that Play here shows, with the generated Web preset", () => {
    const page = join(root, "exports/web/index.html");
    mkdirSync(dirname(page), { recursive: true });
    const r = run(["--headless", "--path", godotDir, "--export-debug", "Web", page], 300000);
    expect(r.code, r.out.slice(-3000)).toBe(0);
    for (const f of ["index.js", "index.wasm", "index.pck"]) expect(existsSync(join(root, "exports/web", f)), f).toBe(true);
    // The level data and compiled rules travel in the pack; a threaded build would need cross-origin isolation.
    expect(statSync(join(root, "exports/web/index.pck")).size).toBeGreaterThan(10_000);
    expect(readFileSync(page, "utf8")).toMatch(/GODOT_THREADS_ENABLED\s*=\s*false/);
  }, 360000);

  it.skipIf(!DESKTOP_TEMPLATES.every((f) => existsSync(f)))("exports 64-bit Windows and Linux builds with the generated presets, and the exported games pass their self-test", () => {
    exportDesktopBuilds(root, godotDir, "Integration Valley", (report, where) => {
      expect(report.checks.filter((c) => !c.ok), where).toEqual([]);
      expect(report.observations["won"], where).toBe(true);
      expect(report.observations["gatesOpen"], where).toEqual({ gate_main: true });
    });
  }, 1_800_000);

  it("cleans up", () => {
    if (process.env["KEEP_GODOT_PROJECT"]) console.log(`kept ${root}`);
    else rmSync(root, { recursive: true, force: true });
  });
});

describe.skipIf(!GODOT)("Godot 3D adventure: Thornwood Ruins (real engine)", () => {
  let root = "";
  let godotDir = "";
  beforeAll(() => {
    // Drawn in the anime style, so the Kiln models and the player go through style.gd too.
    const files = generateProject("adventure-3d", { title: "Adventure Check", projectId: "adventure-check-0001" }).files.map((f) => {
      if (!f.path.endsWith("world.json")) return f;
      const world = JSON.parse(f.content);
      world.environment.style = "anime";
      return { ...f, content: JSON.stringify(world, null, 2) };
    });
    root = writeProject("gamestudio-adventure-", files);
    godotDir = join(root, "godot");
  });
  const run = (args: string[], timeout = 240000) => {
    try {
      return { code: 0, out: execFileSync(GODOT!, args, { cwd: godotDir, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
    }
  };

  it("imports the project", () => {
    const r = run(["--headless", "--path", godotDir, "--import"]);
    expect(existsSync(join(godotDir, ".godot"))).toBe(true);
    expect(r.out).not.toMatch(/SCRIPT ERROR|Parse Error/);
  }, 300000);

  it("plays the ruins headlessly: beetles chase, hurt and fall to the staff, blocks push onto the plates, the gate opens, the sunset timer runs out and the beacon wins", () => {
    const r = run(["--headless", "--path", godotDir, "--", "--studio-smoke"]);
    const report = smokeReport(r.out, "Thornwood Ruins");
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    const names = report.checks.map((c) => c.name);
    for (const name of [
      "hearts show in a level with enemies",
      "an enemy chases the player who comes within sight",
      "an enemy's touch costs the player hearts, then the player blinks unhurt for a moment",
      "the staff defeats an enemy in as many hits as its health",
      "a defeated enemy disappears and stops colliding",
      "with no hearts left the player starts again at the spawn point with full hearts",
      "every enemy can be defeated",
      "walking into a block pushes it straight ahead",
      "blocks pushed into zones count as standing there",
      "running timers count down and show their countdown",
      "a timer that reaches zero runs On Timer",
      "E beside a villager who answers with AI opens a conversation and stops walking",
      "a typed question goes to Game Studio and the villager's answer appears",
      "Esc ends the conversation and gives the controls back",
    ]) expect(names, name).toContain(name);
    expect(report.pass).toBe(true);
    const o = report.observations;
    expect(o["won"]).toBe(true);
    expect(o["gatesOpen"]).toEqual({ gate_ruins: true });
    // The beetles, blocks and gate are drawn from the models made with Kiln; the gate's four door pieces sank with its door.
    expect(o["modelsUsed"]).toEqual({
      beetle_1: "assets/models/kiln/thorn-beetle.gltf",
      beetle_2: "assets/models/kiln/thorn-beetle.gltf",
      beetle_3: "assets/models/kiln/thorn-beetle.gltf",
      beetle_4: "assets/models/kiln/thorn-beetle.gltf",
      block_1: "assets/models/kiln/stone-block.gltf",
      block_2: "assets/models/kiln/stone-block.gltf",
      gate_ruins: "assets/models/kiln/shrine-gate.gltf",
    });
    expect(o["doorPieces"]).toEqual({ gate_ruins: 4 });
    // The beetle model's own legs walk while it chases (Kiln's Walk clip).
    expect(names).toContain("an enemy drawn from an animated model walks while it chases");
    expect(o["enemyWalk"]).toBe("walk/Walk");
    expect((o["defeated"] as string[]).sort()).toEqual(["beetle_1", "beetle_2", "beetle_3", "beetle_4"]);
    expect(o["blockZones"]).toEqual({ block_1: ["plate_1"], block_2: ["plate_2"] });
    expect(o["timersFired"]).toEqual(["sunset"]);
    // Half a second into 90: the countdown shows whole seconds rounded up.
    expect((o["countdownsSeen"] as string[])[0]).toMatch(/^Sunset in 1:(30|2\d)$/);
    expect(o["maxHealth"]).toBe(5);
    expect(o["health"]).toBe(5);
    expect(o["objective"]).toBe("Light the beacon beyond the gate before sunset.");
    const messages = (o["messages"] as string[]).join("\n");
    expect(messages).toMatch(/Thorn beetle defeated: 4 of 4/);
    expect(messages).toMatch(/The gate grinds open/);
    expect(messages).toMatch(/The sun has set/);
    expect(messages).toMatch(/restores your hearts/);
    expectSameGrass(o["grass"], thornwoodRuins());
    // The anime style restyled the beetles, blocks, gate and the rest; glowing parts kept their look.
    expect(o["style"]).toBe("anime");
    expect(o["toonMaterials"] as number).toBeGreaterThan(20);
    // Only the realistic style draws trees and rocks in detail.
    expect(o["nature"]).toEqual({});
    expect(r.out).not.toMatch(/SCRIPT ERROR/);
    expect(r.out).not.toMatch(/leaked at exit/);
  }, 180000);

  it("opens in the Godot editor, with the enemies and blocks in the layout preview, without script errors", () => {
    const r = run(["--headless", "--editor", "--path", godotDir, "--quit-after", "120"]);
    expect(r.out).not.toMatch(/SCRIPT ERROR|Parse Error/);
  }, 180000);

  it("cleans up", () => {
    if (process.env["KEEP_GODOT_PROJECT"]) console.log(`kept ${root}`);
    else rmSync(root, { recursive: true, force: true });
  });
});

describe.skipIf(!GODOT)("Godot football: Harbour Cup Final (real engine)", () => {
  let root = "";
  let godotDir = "";
  beforeAll(() => {
    root = writeProject("gamestudio-football-", generateProject("football", { title: "Football Check", projectId: "football-check-0001" }).files);
    godotDir = join(root, "godot");
  });
  const run = (args: string[], timeout = 240000) => {
    try {
      return { code: 0, out: execFileSync(GODOT!, args, { cwd: godotDir, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
    }
  };

  it("imports the project", () => {
    const r = run(["--headless", "--path", godotDir, "--import"]);
    expect(existsSync(join(godotDir, ".godot"))).toBe(true);
    expect(r.out).not.toMatch(/SCRIPT ERROR|Parse Error/);
  }, 300000);

  it("plays the match headlessly: running, the ball, a goal and the restart, a save, the computer chasing, scoring and tackling, a pass, the boards, a minute, full time with the golden goal, and the computer playing both sides", () => {
    const r = run(["--headless", "--path", godotDir, "--", "--studio-smoke"]);
    const report = smokeReport(r.out, "Harbour Cup Final");
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.checks.length).toBe(20);
    expect(report.pass).toBe(true);
    const o = report.observations;
    expect(o["players"]).toBe(10);
    expect(o["score"]).toEqual({ home: 1, away: 1 });
    const goals = o["goals"] as { team: string; scorer: number; name: string; own: boolean }[];
    expect(goals.map((g) => g.team)).toEqual(["home", "away"]);
    expect(goals.every((g) => g.name !== "" && !g.own)).toBe(true);
    // Level at full time: the cup's rules play a golden-goal minute, then share the cup.
    expect(o["levelAtFullTime"]).toBe(true);
    expect(o["afterFirstFullTime"]).toMatchObject({ phase: "play", caption: "Golden goal: the next goal wins!" });
    expect(o["ended"]).toBe("Full time: still level after the golden goal. The cup is shared!");
    const messages = (o["messages"] as string[]).join("\n");
    expect(messages).toMatch(new RegExp(`GOAL! ${goals[0]!.name} for Harbour Lions  1 – 0`));
    expect(messages).toMatch(new RegExp(`GOAL! ${goals[1]!.name} for Hilltop Rovers  1 – 1`));
    expect(messages).toMatch(/One more minute: the next goal wins the cup/);
    expect((o["events"] as string[]).filter((e) => e === "fullTime")).toHaveLength(2);
    // The scorers are named from the squads.
    expect(goals.map((g) => g.name)).toEqual(["Kofi Antwi", "Nina Kovac"]);
    const watched = o["watched"] as { homePasses: number; awayPasses: number; shots: number; youControl: boolean };
    expect(watched.homePasses).toBeGreaterThan(0);
    expect(watched.awayPasses).toBeGreaterThan(0);
    expect(watched.shots).toBeGreaterThan(0);
    expect(watched.youControl).toBe(false);
    expect(r.out).not.toMatch(/SCRIPT ERROR/);
    expect(r.out).not.toMatch(/leaked at exit/);
  }, 180000);

  it("opens in the Godot editor, with the stadium preview, without script errors", () => {
    const r = run(["--headless", "--editor", "--path", godotDir, "--quit-after", "120"]);
    expect(r.out).not.toMatch(/SCRIPT ERROR|Parse Error/);
  }, 180000);

  it("cleans up", () => {
    if (process.env["KEEP_GODOT_PROJECT"]) console.log(`kept ${root}`);
    else rmSync(root, { recursive: true, force: true });
  });
});

describe.skipIf(!GODOT)("Godot farm: Sunrise Acres (real engine)", () => {
  let root = "";
  let godotDir = "";
  beforeAll(() => {
    root = writeProject("gamestudio-farm-", generateProject("farm-sim", { title: "Farm Check", projectId: "farm-check-0001" }).files);
    godotDir = join(root, "godot");
  });
  const run = (args: string[], timeout = 240000) => {
    try {
      return { code: 0, out: execFileSync(GODOT!, args, { cwd: godotDir, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
    }
  };

  it("imports the project", () => {
    const r = run(["--headless", "--path", godotDir, "--import"]);
    expect(existsSync(join(godotDir, ".godot"))).toBe(true);
    expect(r.out).not.toMatch(/SCRIPT ERROR|Parse Error/);
  }, 300000);

  it("plays a season headlessly: walking, planting, watering, growing, harvesting, selling, rain, sleeping, market day and the end of the season", () => {
    const r = run(["--headless", "--path", godotDir, "--", "--studio-smoke"]);
    const report = smokeReport(r.out, "Sunrise Acres");
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.checks).toHaveLength(16);
    expect(report.pass).toBe(true);
    const o = report.observations;
    // Two okra seeds (4 each) from 60, one tile harvested (2 okra) and sold at 5.
    expect(o["money"]).toBe(62);
    expect(o["harvested"]).toMatchObject({ okra: 2 });
    expect(o["sold"]).toMatchObject({ okra: 2 });
    // Market day: tomatoes at double their settings price on day 4, back on day 5.
    const prices = o["prices"] as Record<string, Record<string, number>>;
    expect(prices["4"]?.["tomato"]).toBe(12);
    expect(prices["5"]?.["tomato"]).toBe(6);
    expect(o["day"]).toBe(8);
    expect(o["ended"]).toBe("The season is over, short of 300 coins. Plant early and water every day!");
    const messages = (o["messages"] as string[]).join("\n");
    expect(messages).toMatch(/Harvested 2 Okra/);
    expect(messages).toMatch(/Market day! Tomatoes sell for double today/);
    expect((o["events"] as string[]).filter((e) => e === "newDay")).toHaveLength(7);
    expect(r.out).not.toMatch(/SCRIPT ERROR/);
    expect(r.out).not.toMatch(/leaked at exit/);
  }, 180000);

  it("opens in the Godot editor, with the farm preview, without script errors", () => {
    const r = run(["--headless", "--editor", "--path", godotDir, "--quit-after", "120"]);
    expect(r.out).not.toMatch(/SCRIPT ERROR|Parse Error/);
  }, 180000);

  it("cleans up", () => {
    if (process.env["KEEP_GODOT_PROJECT"]) console.log(`kept ${root}`);
    else rmSync(root, { recursive: true, force: true });
  });
});

describe.skipIf(!GODOT)("Godot imported models, ground texture and high quality (real engine)", () => {
  let root = "";
  let godotDir = "";
  let levelObjects: { id: string; type: string; variant?: string }[] = [];
  beforeAll(() => {
    const files = generateProject("exploration-3d", { title: "Model Check", projectId: "model-check-0001" }).files.map((f) => {
      if (!f.path.endsWith("world.json")) return f;
      const world = JSON.parse(f.content);
      levelObjects = world.objects;
      world.environment.quality = "high";
      world.environment.style = "realistic";
      world.environment.skyImage = "assets/skies/test/test_sky.hdr";
      world.environment.skyBrightness = 1.2;
      world.environment.groundMaterial = { albedo: "assets/textures/check_diff_1k.png", tile: 4 };
      world.objects.push({ id: "crate_1", type: "model", x: 6, z: 20, rotation: 30, scale: 1.5, asset: "assets/models/crate.glb", collide: true });
      world.objects.push({ id: "crate_2", type: "model", x: -6, z: 20, rotation: 0, scale: 1, asset: "assets/models/crate.glb", collide: false });
      // An animated character as scenery, as the elder (picking its idle by name) and as the player.
      world.objects.push({ id: "dancer", type: "model", x: 10, z: 12, rotation: 0, scale: 1, asset: "assets/characters/tester.glb", collide: false, animation: "Walk" });
      // A VRM character (as VRoid Studio makes them) with no animations of its own: it walks with Game Studio's.
      world.objects.push({ id: "vrm_walker", type: "model", x: -10, z: 12, rotation: 0, scale: 1, asset: "assets/characters/humanoid.vrm", collide: false, animation: "Walk" });
      const elder = world.objects.find((o: { id: string }) => o.id === "elder");
      Object.assign(elder, { model: "assets/characters/tester.glb", height: 1.7 });
      world.player.character = { asset: "assets/characters/tester.glb", height: 1.8, turn: 180 };
      // Texture sets on built-in objects: a rock with its own colours, a gate tinted by its parts' colours.
      for (const o of world.objects) {
        if (o.type === "rock") o.material = { albedo: "assets/textures/check_diff_1k.png", tile: 0.5 };
        if (o.type === "gate") o.material = { albedo: "assets/textures/check_diff_1k.png", tile: 1, tint: true };
      }
      // The level's own sounds: music and a replaced chime (played when a crystal is collected).
      world.audio = { music: { asset: "assets/audio/theme.wav", volume: 0.5 }, sounds: { chime: "assets/audio/pling.wav" } };
      return { ...f, content: JSON.stringify(world, null, 2) };
    });
    root = writeProject("gamestudio-models-", files);
    godotDir = join(root, "godot");
    mkdirSync(join(godotDir, "assets/models"), { recursive: true });
    mkdirSync(join(godotDir, "assets/textures"), { recursive: true });
    writeFileSync(join(godotDir, "assets/models/crate.glb"), boxGlb(2, 1.5, 2));
    writeFileSync(join(godotDir, "assets/textures/check_diff_1k.png"), checkerPng());
    mkdirSync(join(godotDir, "assets/skies/test"), { recursive: true });
    writeFileSync(join(godotDir, "assets/skies/test/test_sky.hdr"), skyHdr());
    mkdirSync(join(godotDir, "assets/characters"), { recursive: true });
    writeFileSync(join(godotDir, "assets/characters/tester.glb"), characterGlb());
    writeFileSync(join(godotDir, "assets/characters/humanoid.vrm"), humanoidVrm());
    mkdirSync(join(godotDir, "assets/audio"), { recursive: true });
    writeFileSync(join(godotDir, "assets/audio/theme.wav"), toneWav(1.5, 220));
    writeFileSync(join(godotDir, "assets/audio/pling.wav"), toneWav(0.2, 1320));
  });

  it("imports the models and texture, places them, gives the solid model a collision box, and animates the characters", () => {
    execFileSync(GODOT!, ["--headless", "--path", godotDir, "--import"], { cwd: godotDir, stdio: "ignore", timeout: 240000 });
    let out = "";
    try {
      out = execFileSync(GODOT!, ["--headless", "--path", godotDir, "--", "--studio-smoke"], { cwd: godotDir, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    }
    const line = out.split("\n").find((l) => l.startsWith("GSTUDIO_SMOKE "));
    expect(line, out.slice(-4000)).toBeDefined();
    const report = JSON.parse(line!.slice("GSTUDIO_SMOKE ".length));
    expect(report.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    const names = report.checks.map((c: { name: string; detail: string }) => `${c.name}: ${c.detail}`);
    expect(names).toContain("solid models block the player: 1 of 1");
    expect(report.observations.models).toBe(4);
    // The player character: idle at rest, walking while moving (clips chosen from their names), idle again.
    expect(names).toContain("the player character loads: ");
    expect(names.find((n: string) => n.startsWith("the player character stands idle"))).toMatch(/at rest idle, walking walk/);
    expect(names.some((n: string) => n.startsWith("the player character returns to idle: now idle"))).toBe(true);
    expect(report.observations.animations).toEqual({ dancer: "Walk", elder: "Idle", vrm_walker: "Walk" });
    // The VRM character's left thigh a quarter and three quarters into Walk: as humanoid_poses.json says
    // (-2 + 24 sin) and as the studio's 3D view poses it (humanoid.test.ts).
    const [quarter, threeQuarters] = report.observations.vrmWalk as number[];
    expect(quarter).toBeCloseTo(22, 0);
    expect(threeQuarters).toBeCloseTo(-26, 0);
    expect(names).toContain("the level's imported sounds load: {}");
    expect(names.some((n: string) => n.startsWith("the level's music plays"))).toBe(true);
    // Every rock and the gate drew their plain parts with the texture (the gate's glowing disc keeps its colour).
    expect(Object.keys(report.observations.textured).sort()).toEqual(["gate_main", "rock_1", "rock_2", "rock_3"]);
    expect(report.observations.textured.gate_main).toBe(4);
    expect(names.find((n: string) => n.startsWith("replaced sounds play from their files"))).toMatch(/played \["chime","chime","chime"\]/);
    expect(report.observations.music).toBe(true);
    // Headless runs use the dummy renderer, not Compatibility, so the high-quality settings apply.
    expect(report.observations.highQuality).toBe(true);
    // The realistic style under a photographed sky: the photo lit the level and its desktop effects are on
    // (headless runs use the dummy renderer, which counts as the desktop one here).
    expect(report.observations.style).toBe("realistic");
    expect(report.observations.skyPhoto).toBe(true);
    expect(report.observations.realisticEffects).toBe(true);
    expect(report.observations.toonMaterials).toBe(0);
    // Its trees and rocks are drawn in detail, exactly as the studio's 3D view draws them.
    expectSameNature(report.observations.nature, levelObjects);
    expect(out).not.toMatch(/SCRIPT ERROR/);
    expect(out).not.toMatch(/leaked at exit/);
  }, 400000);

  it("opens in the Godot editor with the characters and models, without script errors", () => {
    let out = "";
    try {
      out = execFileSync(GODOT!, ["--headless", "--editor", "--path", godotDir, "--quit-after", "120"], { cwd: godotDir, encoding: "utf8", timeout: 180000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    }
    expect(out).not.toMatch(/SCRIPT ERROR|Parse Error/);
  }, 200000);

  it("cleans up", () => {
    if (process.env["KEEP_GODOT_PROJECT"]) console.log(`kept ${root}`);
    else rmSync(root, { recursive: true, force: true });
  });
});

describe.skipIf(!GODOT)("Godot 2D platformer (real engine)", () => {
  let root = "";
  let godotDir = "";
  beforeAll(() => {
    root = writeProject("gamestudio-platformer-", generateProject("platformer-2d", { title: "Platformer Check", projectId: "platformer-check-0001" }).files);
    godotDir = join(root, "godot");
  });
  const run = (args: string[], timeout = 240000) => {
    try {
      return { code: 0, out: execFileSync(GODOT!, args, { cwd: godotDir, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
    }
  };

  it("imports the project", () => {
    const r = run(["--headless", "--path", godotDir, "--import"]);
    expect(existsSync(join(godotDir, ".godot"))).toBe(true);
    expect(r.out).not.toMatch(/SCRIPT ERROR|Parse Error/);
  }, 300000);

  it("plays Sunset Cliffs headlessly: running, jumping, coins, spikes, stomping, the coin gate and the goal", () => {
    const r = run(["--headless", "--path", godotDir, "--", "--studio-smoke"]);
    const line = r.out.split("\n").find((l) => l.startsWith("GSTUDIO_SMOKE "));
    expect(line, r.out.slice(-4000)).toBeDefined();
    const report = JSON.parse(line!.slice("GSTUDIO_SMOKE ".length));
    expect(report.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.observations.won).toBe(true);
    expect(report.observations.doorsOpen).toEqual({ door_goal: true });
    expect(r.out).not.toMatch(/SCRIPT ERROR/);
    expect(r.out).not.toMatch(/leaked at exit/);
  }, 120000);

  it("opens in the Godot editor without script errors", () => {
    const r = run(["--headless", "--editor", "--path", godotDir, "--quit-after", "120"]);
    expect(r.out).not.toMatch(/SCRIPT ERROR|Parse Error/);
  }, 180000);

  const webTemplate = join(homedir(), "Library/Application Support/Godot/export_templates/4.7.2.stable/web_nothreads_debug.zip");
  it.skipIf(!existsSync(webTemplate))("builds the single-threaded web version that Play here shows", () => {
    const page = join(root, "exports/web/index.html");
    mkdirSync(dirname(page), { recursive: true });
    const r = run(["--headless", "--path", godotDir, "--export-debug", "Web", page], 300000);
    expect(r.code, r.out.slice(-3000)).toBe(0);
    for (const f of ["index.js", "index.wasm", "index.pck"]) expect(existsSync(join(root, "exports/web", f)), f).toBe(true);
    expect(readFileSync(page, "utf8")).toMatch(/GODOT_THREADS_ENABLED\s*=\s*false/);
  }, 360000);

  it.skipIf(!DESKTOP_TEMPLATES.every((f) => existsSync(f)))("exports 64-bit Windows and Linux builds, and the exported games pass their self-test", () => {
    exportDesktopBuilds(root, godotDir, "Platformer Check", (report, where) => {
      expect(report.checks.filter((c) => !c.ok), where).toEqual([]);
      expect(report.observations["won"], where).toBe(true);
      expect(report.observations["doorsOpen"], where).toEqual({ door_goal: true });
    });
  }, 1_800_000);

  it("draws the player from a sprite sheet: idle when standing, running when moving, facing the way it runs", () => {
    const dir = writeProject("gamestudio-sprite-", generateProject("platformer-2d", { title: "Sprite Check", projectId: "sprite-check-0001" }).files.map((f) => {
      if (!f.path.endsWith("level.json")) return f;
      const level = JSON.parse(f.content);
      level.player.sprite = { asset: "assets/sprites/hero.png", columns: 4, rows: 1, idle: [0], run: [1, 2], jump: [3], fps: 10, height: 1.5, facing: "right", pixelArt: true };
      level.audio = { music: { asset: "assets/audio/theme.wav", volume: 0.4 }, sounds: { coin: "assets/audio/coin.wav", jump: "assets/audio/hop.wav" } };
      for (const o of level.objects) if (o.id === "ground_1" || o.id === "ledge_1") Object.assign(o, { texture: "assets/sprites/tiles.png", tile: 2 });
      return { ...f, content: JSON.stringify(level, null, 2) };
    }));
    const g = join(dir, "godot");
    mkdirSync(join(g, "assets/sprites"), { recursive: true });
    writeFileSync(join(g, "assets/sprites/hero.png"), spriteSheetPng(4, 16, 24));
    writeFileSync(join(g, "assets/sprites/tiles.png"), checkerPng(32));
    mkdirSync(join(g, "assets/audio"), { recursive: true });
    writeFileSync(join(g, "assets/audio/theme.wav"), toneWav(1.5, 196));
    writeFileSync(join(g, "assets/audio/coin.wav"), toneWav(0.15, 1500));
    writeFileSync(join(g, "assets/audio/hop.wav"), toneWav(0.1, 660));
    execFileSync(GODOT!, ["--headless", "--path", g, "--import"], { cwd: g, stdio: "ignore", timeout: 240000 });
    let out = "";
    try {
      out = execFileSync(GODOT!, ["--headless", "--path", g, "--", "--studio-smoke"], { cwd: g, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    }
    const line = out.split("\n").find((l) => l.startsWith("GSTUDIO_SMOKE "));
    expect(line, out.slice(-4000)).toBeDefined();
    const report = JSON.parse(line!.slice("GSTUDIO_SMOKE ".length));
    expect(report.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    const names = report.checks.map((c: { name: string; detail: string }) => `${c.name}: ${c.detail}`);
    expect(names).toContain("the player's sprite sheet loads: ");
    expect(names.find((n: string) => n.startsWith("the player's sprite stands idle"))).toMatch(/standing idle, running run \(facing right true\), now idle/);
    expect(names).toContain("the level's imported sounds load: {}");
    expect(report.observations.music).toBe(true);
    expect(report.observations.soundFiles).toContain("coin");
    expect(report.observations.soundFiles).toContain("jump");
    expect(names).toContain("platform pictures load: 2 textured; {}");
    expect(report.observations.texturedPlatforms).toEqual(["ground_1", "ledge_1"]);
    expect(report.observations.won).toBe(true);
    expect(out).not.toMatch(/SCRIPT ERROR/);
    expect(out).not.toMatch(/leaked at exit/);
    rmSync(dir, { recursive: true, force: true });
  }, 400000);

  it("cleans up", () => {
    if (process.env["KEEP_GODOT_PROJECT"]) console.log(`kept ${root}`);
    else rmSync(root, { recursive: true, force: true });
  });
});

describe.skipIf(!GODOT)("Godot XR foundation (real engine, no headset)", () => {
  let root = "";
  let godotDir = "";
  beforeAll(() => {
    root = writeProject("gamestudio-xr-", generateProject("xr-foundation", { title: "XR Check", projectId: "xr-check-0001" }).files);
    godotDir = join(root, "godot");
  });

  it("starts the XR scene and falls back cleanly when no OpenXR runtime is present", () => {
    execFileSync(GODOT!, ["--headless", "--path", godotDir, "--import"], { cwd: godotDir, stdio: "ignore", timeout: 240000 });
    let out = "";
    try {
      out = execFileSync(GODOT!, ["--headless", "--path", godotDir, "res://scenes/xr_main.tscn", "--quit-after", "90"], { cwd: godotDir, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    }
    expect(out).toMatch(/GSTUDIO_XR (no-openxr-runtime|openxr-initialized)/);
    expect(out).not.toMatch(/SCRIPT ERROR|Parse Error/);
    rmSync(root, { recursive: true, force: true });
  }, 300000);
});

/**
 * Builds and runs the C++ template with the real toolchain. Skipped unless CMAKE_BIN points to a
 * working CMake and SFML is installed (for example CMAKE_BIN=/opt/homebrew/bin/cmake).
 */
const CMAKE = binPath(process.env["CMAKE_BIN"]);
describe.skipIf(!CMAKE)("C++ / SFML template (real toolchain)", () => {
  it("configures, builds, passes its unit tests and its headless self-test", () => {
    const root = writeProject("gamestudio-cpp-", generateProject("cpp-sfml-arcade", { title: "Cpp Check", projectId: "cpp-check-0001" }).files);
    const cpp = join(root, "cpp");
    const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: cpp, encoding: "utf8", timeout: 300000, stdio: ["ignore", "pipe", "pipe"] });
    run(CMAKE!, ["-S", cpp, "-B", join(cpp, "build"), "-DCMAKE_BUILD_TYPE=Debug", "-DCMAKE_PREFIX_PATH=/opt/homebrew"]);
    const build = run(CMAKE!, ["--build", join(cpp, "build"), "-j", "8"]);
    expect(build).not.toMatch(/warning:/);
    expect(run(join(dirname(CMAKE!), "ctest"), ["--test-dir", join(cpp, "build"), "--output-on-failure"])).toMatch(/100% tests passed/);
    const smoke = run(join(cpp, "build", "crystal_catcher"), ["--smoke"]);
    expect(JSON.parse(smoke.split("GSTUDIO_SMOKE ")[1]!)).toMatchObject({ pass: true });
    rmSync(root, { recursive: true, force: true });
  }, 600000);
});
