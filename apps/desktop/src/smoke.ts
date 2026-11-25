import { compileGraph, type RuleGraph } from "@gamestudio/rules-core";
import { OwareMatch } from "@gamestudio/oware";
import { agentById, runAgent, runChat, type GenerateFn } from "@gamestudio/agents";
import { grassKeepOut, placeTufts, thornwoodRuins, type World } from "@gamestudio/explore";
import { DESKTOP_TARGETS, exportAppName, planGodotDesktopExport, planGodotExport, planGodotWebExport } from "@gamestudio/project";
import { backend, errorMessage } from "./lib/backend";
import { streamGenerate } from "./lib/backend/stream";
import { registry } from "./lib/registry";
import { useProject } from "./state/project";
import { useEnv } from "./state/env";
import { useRuns, type RunRecord } from "./state/runs";
import { invoke } from "@tauri-apps/api/core";
import type { LevelView } from "./views/world/level3d-view";
import type { Material, Mesh } from "three";
import { MODEL_BOUNDS, SPAWN_ID } from "./views/world/level3d";
import { parseSaves } from "./views/play/saves";

/**
 * End-to-end self-test of the real desktop app, started with:  <app> --smoke-test <folder>
 * Exercises the webview, the stores, the Rust commands, Godot and the local model, then writes
 * <folder>/smoke-report.json and exits (code 0 when every check passed).
 */
interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

// Driving the real window: the checks below click buttons in this webview, so they go through the
// same React handlers, stores and Rust commands as a person's clicks.
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

async function until<T>(read: () => T | null | undefined | false, timeoutMs: number, what: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

function buttonNamed(name: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim() === name) ?? null;
}

async function clickButton(name: string, timeoutMs = 15_000): Promise<void> {
  const button = await until(() => {
    const b = buttonNamed(name);
    return b && !b.disabled ? b : null;
  }, timeoutMs, `an enabled "${name}" button`);
  button.click();
}

/** Clicks a Play view button and waits for the run it starts to finish. */
async function runFromButton(name: string, action: RunRecord["action"], timeoutMs: number): Promise<RunRecord> {
  const before = new Set(useRuns.getState().runs.map((r) => r.id));
  await clickButton(name);
  const started = await until(() => useRuns.getState().runs.find((r) => !before.has(r.id) && r.action === action), 60_000, `the "${name}" run to start`);
  return until(() => {
    const r = useRuns.getState().runs.find((x) => x.id === started.id);
    return r && r.status !== "running" ? r : null;
  }, timeoutMs, `the "${name}" run to finish`);
}

/** Types into a React-controlled input or textarea the way a person's typing reaches React. */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Chooses an option in a select, as a person's choice reaches React. */
function choose(el: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const lastLines = (run: RunRecord, n: number) => run.lines.filter((l) => !l.text.startsWith("GSTUDIO")).slice(-n).map((l) => l.text).join(" | ");

/**
 * Native input (src-tauri/src/native.rs): the events AppKit makes for a mouse, a trackpad and the keyboard,
 * handed to this web view, so WebKit turns them into trusted DOM events the way it does for a person.
 * Points are in CSS pixels from the top left of the window's page.
 */
type InputStep =
  | { kind: "down" | "drag" | "up"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; dy: number }
  | { kind: "pinch"; x: number; y: number; magnification: number; phase: "began" | "changed" | "ended" }
  | { kind: "key"; key: string; code: number; down: boolean }
  | { kind: "move"; x: number; y: number; dx: number; dy: number }
  | { kind: "focus" }
  | { kind: "wait"; ms: number };
const nativeInput = (steps: InputStep[]) => invoke<string[]>("smoke_input", { steps });
const snapshot = (name: string) => invoke<string>("smoke_snapshot", { name });

/** Median colours around points (CSS pixels from the window's top left) in a picture taken with snapshot(). */
/** The Play here sessions in the run list now (newest first), so a check can tell its own from earlier ones. */
function playSessionIds(): Set<string> {
  return new Set(useRuns.getState().runs.filter((r) => r.action === "play-here").map((r) => r.id));
}

async function pictureColours(name: string, points: { x: number; y: number }[], radius = 4): Promise<[number, number, number][]> {
  const png = new Blob([await invoke<ArrayBuffer>("smoke_picture", { name })], { type: "image/png" });
  const bitmap = await createImageBitmap(png, { colorSpaceConversion: "none" }).catch(() => createImageBitmap(png));
  const scale = bitmap.width / window.innerWidth;
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  return points.map(({ x, y }) => {
    const r = Math.max(1, Math.round(radius * scale));
    const data = ctx.getImageData(Math.round(x * scale) - r, Math.round(y * scale) - r, 2 * r + 1, 2 * r + 1).data;
    return [0, 1, 2].map((c) => {
      const values: number[] = [];
      for (let i = c; i < data.length; i += 4) values.push(data[i] ?? 0);
      return values.sort((a, b) => a - b)[values.length >> 1];
    }) as [number, number, number];
  });
}

/** A native mouse drag in `count` steps, then a short wait for the page to handle it. */
async function nativeDrag(from: { x: number; y: number }, to: { x: number; y: number }, count = 8): Promise<void> {
  const steps: InputStep[] = [{ kind: "down", ...from }];
  for (let i = 1; i <= count; i++) steps.push({ kind: "drag", x: from.x + ((to.x - from.x) * i) / count, y: from.y + ((to.y - from.y) * i) / count });
  steps.push({ kind: "up", ...to });
  await nativeInput(steps);
  await sleep(250);
}

/** A native trackpad pinch: fingers apart for amount > 0 (each step multiplies the scale by 1 + amount). */
async function nativePinch(at: { x: number; y: number }, amount: number, count = 3): Promise<void> {
  const steps: InputStep[] = [{ kind: "pinch", ...at, magnification: 0, phase: "began" }];
  for (let i = 0; i < count; i++) steps.push({ kind: "pinch", ...at, magnification: amount, phase: "changed" });
  steps.push({ kind: "pinch", ...at, magnification: 0, phase: "ended" });
  await nativeInput(steps);
  await sleep(250);
}

/** A window on screen as macOS lists it without the Screen Recording permission (no titles). */
interface ScreenWindow {
  owner: string;
  pid: number;
  layer: number;
  width: number;
  height: number;
}

/**
 * Opt-in (--smoke-extras editors): clicks an engine's Open button in the Play view, waits for the editor's log line
 * `ready` (when the editor prints one) and for a large window of the `owner` app on screen, then closes the editor
 * with Stop, which asks first because it does not save.
 */
async function openEditor(button: string, ready: RegExp | null, owner: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  const before = new Set(useRuns.getState().runs.map((r) => r.id));
  const started = Date.now();
  await clickButton(button);
  const current = () => useRuns.getState().runs.find((r) => !before.has(r.id) && r.action === "editor");
  await until(current, 60_000, `the "${button}" run to start`);
  const large = (w: ScreenWindow) => w.owner === owner && w.layer === 0 && w.width >= 800 && w.height >= 500;
  let line: string | null = null;
  let shown: ScreenWindow | undefined;
  let seen: ScreenWindow[] = [];
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(2_000)) {
    const run = current()!;
    if (run.status !== "running") break;
    line = ready ? (run.lines.find((l) => ready.test(l.text))?.text ?? null) : "";
    seen = (await invoke<ScreenWindow[]>("smoke_windows")).filter((w) => w.owner === owner && w.layer === 0);
    shown = seen.find(large);
    if (line !== null && shown) break;
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const open = current()!.status === "running";
  if (open) {
    await clickButton("Stop");
    await clickButton("Close without saving", 10_000);
    await until(() => current()?.status !== "running", 120_000, "the editor to close");
  }
  const run = current()!;
  const ok = open && line !== null && Boolean(shown) && run.status === "stopped";
  // Without a large window, say which windows the editor did show (macOS gives sizes, not titles): on its first
  // start with a window, Unity shows only its software terms (640×508), which a person has to accept.
  const windows = seen.map((w) => `${Math.round(w.width)}×${Math.round(w.height)}`).join(", ") || "none";
  return {
    ok,
    detail: `${seconds} s to ${shown ? `a ${Math.round(shown.width)}×${Math.round(shown.height)} ${owner} window` : `no large ${owner} window (its windows: ${windows})`}${line ? `; log: ${line}` : ready && !line ? "; no ready line in its log" : ""}; steps: ${run.steps.map((s) => s.label).join(", ")}; then ${run.status}${ok ? "" : `; last lines: ${lastLines(run, 3)}`}`,
  };
}

/** Seconds since a person last touched the mouse, trackpad or keyboard (the self-test's own input does not count). */
const personIdle = () => invoke<number>("smoke_idle").catch(() => 99);

/**
 * Native-input checks drive the focused window, and a person's real pointer and keys reach it too. This
 * waits until nobody has touched the mouse, trackpad or keyboard for 1.5 s (2 minutes at most), runs the
 * step, and when the step failed while someone was using them (or `disturbed` says so), waits again and
 * runs it once more. Steps undo their own changes, so a second run starts from the same state.
 */
async function undisturbed<T>(step: () => Promise<T>, ok: (result: T) => boolean, disturbed: (result: T) => boolean = () => false): Promise<{ result: T; note: string }> {
  const settle = async () => {
    const start = Date.now();
    while (Date.now() - start < 120_000 && (await personIdle()) < 1.5) await sleep(400);
    return (Date.now() - start) / 1000;
  };
  const waited = await settle();
  const started = Date.now();
  let result = await step();
  let note = waited >= 1 ? ` (waited ${Math.round(waited)} s for the mouse and keyboard to be still)` : "";
  if (!ok(result) && ((await personIdle()) * 1000 < Date.now() - started || disturbed(result))) {
    await settle();
    result = await step();
    note += "; the mouse or keyboard was in use during the first try, so it ran again";
  }
  return { result, note };
}

/**
 * Loads the isolation probe (served in --smoke-test mode next to a Play here build) in a frame sandboxed
 * like the game's, and returns what it could reach.
 */
async function probeFrame(gameUrl: string): Promise<Record<string, unknown>> {
  const frame = document.createElement("iframe");
  frame.sandbox.add("allow-scripts");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none";
  const report = new Promise<Record<string, unknown>>((resolve) => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || (e.data as { source?: unknown } | null)?.source !== "gamestudio-probe") return;
      window.removeEventListener("message", onMessage);
      resolve(e.data as Record<string, unknown>);
    };
    window.addEventListener("message", onMessage);
  });
  frame.src = new URL("__probe.html", gameUrl).href;
  document.body.appendChild(frame);
  try {
    return await Promise.race([report, sleep(10_000).then(() => ({ error: "no report within 10 s" }))]);
  } finally {
    frame.remove();
  }
}

/** Records which DOM events reached an element, and whether WebKit marked them trusted. */
function eventLog(el: EventTarget, types: string[]) {
  const seen: string[] = [];
  const record = (e: Event) => seen.push(`${e.type}${e.isTrusted ? "" : " (synthetic)"}`);
  for (const t of types) el.addEventListener(t, record, true);
  return {
    trusted: (type: string) => seen.includes(type),
    summary: () => [...new Set(seen)].join(", ") || "none",
    stop: () => {
      for (const t of types) el.removeEventListener(t, record, true);
    },
  };
}

export async function runSmoke(dir: string, extras: string[] = []): Promise<void> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
  const env: Record<string, unknown> = { extras };
  const store = () => useProject.getState();
  try {
    const info = await backend.appInfo();
    check("app reports its version and data folder", info.version === "0.1.0" && info.dataDir.startsWith(dir), info.dataDir);
    await backend.settingsSet("smoke.flag", true);
    check("settings round-trip through SQLite", (await backend.settingsGet())["smoke.flag"] === true);
    let refused = false;
    try {
      await backend.settingsSet("ai.anthropic.apiKey", "sk-not-a-real-key-123");
    } catch {
      refused = true;
    }
    check("settings refuse credential-like keys", refused);

    let engines = await backend.enginesDiscover();
    const godot = engines.find((e) => e.id === "godot")?.installs.find((i) => i.compatible) ?? null;
    env["godot"] = godot ? `${godot.version} (${godot.source})` : null;
    env["cpp"] = engines.find((e) => e.id === "cpp")?.capabilities.find((c) => c.id === "sfml-template")?.status;
    check("engine discovery reports all four engine families", engines.map((e) => e.id).join(",") === "godot,unity,unreal,cpp", engines.map((e) => `${e.id}:${e.installs.length}`).join(" "));

    // Opt-in (--smoke-extras templates): with the Godot export templates missing, install them from the Engines
    // view's button as a person would: the official 1.3 GB archive, checked against the release's SHA-512 list and
    // unpacked where Godot reads it. Every export below then builds with the templates this installed.
    if (extras.includes("templates")) {
      const exportStatus = () => engines.find((e) => e.id === "godot")?.capabilities.find((c) => c.id === "export")?.status;
      if (exportStatus() === "available") {
        check("export templates install skipped: they are already installed (move the 4.7.2.stable templates folder away to try the button)", true, "");
      } else {
        await clickButton("Engines");
        await clickButton("Export templates", 20_000);
        const started = Date.now();
        await clickButton("Download and install", 10_000);
        const outcome = await until(() => {
          const error = document.querySelector(".dialog .notice--error")?.textContent;
          if (error) return { error };
          return buttonNamed("Download and install") ? null : { error: "" };
        }, 2_400_000, "the export templates to download and install");
        engines = await backend.enginesDiscover();
        const statuses = ["export", "play-web", "export-windows", "export-linux"].map((id) => `${id} ${engines.find((e) => e.id === "godot")?.capabilities.find((c) => c.id === id)?.status}`);
        check(
          "the Engines view's Export templates button downloads the official templates, checks them and installs them, and every export becomes available",
          !outcome.error && statuses.every((s) => s.endsWith(" available")),
          `${Math.round((Date.now() - started) / 1000)} s; ${statuses.join(", ")}${outcome.error ? `; ${outcome.error}` : ""}`,
        );
        await clickButton("Home");
      }
    }

    // No dead ends, checked in the real web view: with no project open every navigation button works,
    // a project screen explains itself, and a disabled button hands the hover to the wrapper that shows
    // its reason (WebKit sends no pointer events to disabled buttons).
    const railButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('nav[aria-label="Main navigation"] button'));
    check("every navigation button works with no project open", railButtons.length >= 8 && railButtons.every((b) => !b.disabled), `${railButtons.length} buttons; disabled: ${railButtons.filter((b) => b.disabled).map((b) => b.getAttribute("aria-label")).join(", ")}`);
    await clickButton("AI assistant");
    const explained = await until(() => Array.from(document.querySelectorAll("h3")).find((h) => h.textContent === "AI assistant needs an open project"), 5_000, "the no-project screen").then(() => true, () => false);
    check("a project screen with no project open explains itself and offers New project and Open folder", explained && Boolean(buttonNamed("New project")) && Boolean(buttonNamed("Open folder")));
    const probe = document.createElement("span");
    probe.dataset["tip"] = "reason";
    probe.innerHTML = '<button type="button" disabled>probe</button>';
    document.body.appendChild(probe);
    const passThrough = getComputedStyle(probe.querySelector("button")!).pointerEvents;
    const wrapperCursor = getComputedStyle(probe).cursor;
    probe.remove();
    check("disabled buttons pass the hover to the reason beside them", passThrough === "none" && wrapperCursor === "not-allowed", `pointer-events ${passThrough}, wrapper cursor ${wrapperCursor}`);
    await clickButton("Home");

    // Oware: create, edit the rule graph, save, reopen, play through the graph, snapshot.
    check("creates an Oware project", await store().create("oware-abapa", "Smoke Oware", dir));
    const owareRoot = store().root!;
    const graphPath = store().manifest!.rules[0]!.path;
    const graph = (await store().loadDoc(graphPath))!.data as RuleGraph;
    store().updateDoc(graphPath, { ...graph, nodes: graph.nodes.map((n) => (n.id === "capture" ? { ...n, params: { ...n.params, counts: [2, 3, 4] } } : n)) });
    check("saves the edited rule graph", await store().save());
    await store().close();
    check("reopens the project", await store().open(owareRoot));
    const reopened = (await store().loadDoc(graphPath))!.data as RuleGraph;
    check("the edit survived closing and reopening", JSON.stringify(reopened.nodes.find((n) => n.id === "capture")?.params["counts"]) === "[2,3,4]");
    const program = compileGraph(reopened, registry);
    const match = new OwareMatch(program.program!);
    const moved = match.play(2);
    check("plays Oware through the compiled graph", program.ok && moved.accepted && match.state.toMove === 1, JSON.stringify(match.state.pits));
    check("takes a snapshot", await store().takeSnapshot("Smoke checkpoint"));
    const snaps = await backend.snapshotList(owareRoot, 10);
    check("lists the creation and checkpoint snapshots", snaps.length >= 2, snaps.map((s) => s.message).join(" | "));

    // Security boundaries enforced by the Rust backend.
    const denied = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return false;
      } catch (e) {
        return /denied|not an allowed|not open|Only files/i.test(errorMessage(e));
      }
    };
    check("refuses paths outside the project", await denied(() => backend.projectRead(owareRoot, "../../etc/hosts")));
    check("refuses writes into .git", await denied(() => backend.projectWrite(owareRoot, [{ path: ".git/config", content: "x" }])));
    check("refuses importing files the user did not choose", await denied(() => backend.projectImport(owareRoot, ["/etc/hosts"], "assets")));
    check("refuses projects that are not open", await denied(() => backend.projectRead("/tmp", "x")));

    // Exploration: edit the world, save, confirm the Godot data sync, run the game headlessly.
    check("creates a 3D exploration project", await store().create("exploration-3d", "Smoke Valley", dir));
    const valleyRoot = store().root!;
    const worldPath = store().manifest!.data[0]!.path;
    const world = (await store().loadDoc(worldPath))!.data as World;
    store().updateDoc(worldPath, { ...world, objects: [...world.objects, { id: "tree_smoke", type: "tree", x: 6, z: 26, rotation: 0, scale: 1, variant: "round" }] });
    check("saves the edited world", await store().save());
    const synced = await backend.projectRead(valleyRoot, "godot/gamestudio_data/world.json");
    check("save syncs the layout into the Godot project", synced.includes("tree_smoke"));
    /** The library model placed in the world, when the library could be reached. */
    let placedModel = "";
    /** Whether the player and Elder Ama got characters in the world editor. */
    let charactersPlaced = false;

    // Characters: the free library dialog (Assets, Free library, Characters) adds the Robot and the Fox,
    // each checked against its pinned checksum, with licence and author recorded.
    const ROBOT = "assets/characters/robot-expressive/RobotExpressive.glb";
    const FOX = "assets/characters/fox/Fox.glb";
    const COIN = "assets/audio/kenney/coin.ogg";
    const STEPS = "assets/audio/kenney/walking.ogg";
    let charactersAdded = false;
    let soundsAdded = false;
    /** Whether the level got library sounds and a textured rock in the world editor. */
    let soundsSet = false;
    let rockTextured = false;
    {
      let note = "";
      try {
        await clickButton("Asset library");
        await clickButton("Free library", 20_000);
        await clickButton("Characters");
        for (const name of ["Robot (expressive)", "Fox"]) {
          await clickButton(`Add ${name}`, 20_000);
          await until(() => buttonNamed(`Add ${name}`)?.textContent?.includes("Added") || document.querySelector('[role="dialog"] .notice--error'), 90_000, `${name} to be added`);
        }
        // Sounds from the same dialog: the coin and the footsteps.
        await clickButton("Sounds");
        for (const name of ["Coin", "Footsteps"]) {
          await clickButton(`Add sound ${name}`, 20_000);
          await until(() => buttonNamed(`Add sound ${name}`)?.textContent?.includes("Added") || document.querySelector('[role="dialog"] .notice--error'), 60_000, `the ${name} sound to be added`);
        }
        note = document.querySelector('[role="dialog"] .notice--error')?.textContent ?? "";
        await clickButton("Done");
      } catch (e) {
        note = errorMessage(e);
      }
      await store().refresh();
      const index = JSON.parse(await backend.projectRead(valleyRoot, store().manifest!.assetsIndex).catch(() => "{}")) as { assets?: { path: string; license: string; author: string; tags: string[] }[] };
      const entries = (index.assets ?? []).filter((a) => a.path === `godot/${ROBOT}` || a.path === `godot/${FOX}`);
      charactersAdded = entries.length === 2 && store().files.some((f) => f.path === `godot/${ROBOT}`) && store().files.some((f) => f.path === `godot/${FOX}`);
      soundsAdded = store().files.some((f) => f.path === `godot/${COIN}`) && store().files.some((f) => f.path === `godot/${STEPS}`);
      const soundEntries = (index.assets ?? []).filter((a) => a.path === `godot/${COIN}` || a.path === `godot/${STEPS}`);
      if (soundsAdded || !/reach|connect|answer|internet/i.test(note)) {
        check("the free library dialog adds CC0 sound effects, each checked against its pinned checksum", soundsAdded && soundEntries.length === 2 && soundEntries.every((e) => e.license === "CC0 1.0"), `${soundEntries.map((e) => e.path).join("; ")}${note ? `; ${note}` : ""}`);
      }
      if (charactersAdded || !/reach|connect|answer|internet/i.test(note)) {
        check("the free library dialog adds animated characters, each checked against its pinned checksum, with its licence recorded", charactersAdded && entries.every((e) => /CC/.test(e.license) && e.author && e.tags.includes("character")), `${entries.map((e) => `${e.path} (${e.license})`).join("; ")}${note ? `; ${note}` : ""}`);
      } else {
        check("character library check skipped: the files could not be downloaded", true, note);
      }
    }

    // The 3D view, in this web view, driven with native mouse and trackpad events: WebGL 2 draws the level,
    // a click picks the object under it, dragging an object or its turning ring goes through the world
    // editor's own handlers and undo history, scrolling and pinching zoom, torches and crystals light the
    // ground, and the camera stays put when switching to the map and back.
    {
      const VIEW_KEY = "gamestudio.world.view";
      const savedChoice = (() => {
        try {
          return localStorage.getItem(VIEW_KEY);
        } catch {
          return null;
        }
      })();
      await clickButton("Workspace: rules, world and files");
      if (!document.querySelector('[role="group"][aria-label="View"]')) Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("World layout"))?.click();
      await clickButton("3D");
      const canvas = await until(() => document.querySelector<HTMLCanvasElement & { levelView?: LevelView }>('[data-testid="world-3d"] canvas'), 20_000, "the 3D view's canvas");
      const view = await until(() => canvas.levelView, 10_000, "the 3D view to start");
      const tree = () => (store().docs[worldPath]!.data as World).objects.find((o) => o.id === "tree_smoke")!;
      view.focus(6, 26);
      const at = view.screenPoint(6, 1.2, 26)!;
      const pixel = view.samplePixel(at.x, at.y);
      const stats = view.stats();
      check("the 3D view draws the level with WebGL 2 in the app's web view", stats.calls > 20 && stats.triangles > 1000 && pixel[3]! > 0 && pixel[0]! + pixel[1]! + pixel[2]! > 30, `${stats.calls} draw calls, ${stats.triangles} triangles, pixel under tree_smoke rgba(${pixel.join(", ")}), ${stats.renderer}`);
      const host = canvas.parentElement!;
      const events = eventLog(host, ["pointerdown", "pointerup", "wheel", "gesturestart", "gesturechange"]);
      const inspectorTitle = () => document.querySelector(".inspector__title")?.textContent ?? "";
      const clicked = await undisturbed(async () => {
        await nativeInput([{ kind: "down", ...at }, { kind: "up", ...at }]);
        await sleep(250);
        return inspectorTitle();
      }, (title) => title === "tree_smoke");
      check("a mouse click in the 3D view selects the object under the pointer", clicked.result === "tree_smoke" && events.trusted("pointerdown"), `inspector shows "${clicked.result}"; events: ${events.summary()}${clicked.note}`);

      // A person's mouse moving over the focused window during the drag is the same pointer to the page,
      // so it moves the object too; pointer moves off the drag's own path show that happened.
      const dragOnce = async () => {
        const stray: string[] = [];
        const watch = (e: PointerEvent) => {
          if (Math.abs(e.clientY - at.y) > 3 || e.clientX < at.x - 3 || e.clientX > at.x + 93) stray.push(`${Math.round(e.clientX)},${Math.round(e.clientY)}`);
        };
        host.addEventListener("pointermove", watch, true);
        await nativeDrag(at, { x: at.x + 90, y: at.y });
        host.removeEventListener("pointermove", watch, true);
        const moved = { ...tree() };
        await clickButton("Undo (⌘Z)");
        await sleep(150);
        return { moved, back: { ...tree() }, stray };
      };
      const dragWorked = (d: Awaited<ReturnType<typeof dragOnce>>) => d.moved.x > 6 && d.moved.z === 26 && d.back.x === 6 && d.back.z === 26;
      const dragged = await undisturbed(dragOnce, dragWorked, (d) => d.stray.length > 0);
      const drag = dragged.result;
      check("dragging an object with the mouse in the 3D view moves it, and Undo puts it back", dragWorked(drag), `dragged to (${drag.moved.x}, ${drag.moved.z}); after Undo (${drag.back.x}, ${drag.back.z})${dragged.note}`);

      const r = view.model.ringRadiusNow(drag.back);
      const east = view.screenPoint(6 + r, 0.12, 26)!;
      const south = view.screenPoint(6, 0.12, 26 + r)!;
      const ring = await undisturbed(async () => {
        await nativeDrag(east, south, 12);
        const turned = tree().rotation;
        await clickButton("Undo (⌘Z)");
        await sleep(150);
        return { turned, after: tree().rotation };
      }, (t) => t.turned === 90 && t.after === 0);
      check("dragging the ring with the mouse in the 3D view turns the object a quarter turn, and Undo turns it back", ring.result.turned === 90 && ring.result.after === 0, `rotation ${ring.result.turned}°, after Undo ${ring.result.after}°${ring.note}`);

      // Trackpad: a two-finger scroll (wheel events) and a pinch (WebKit's gesture events) both zoom.
      const distance = () => {
        const c = view.cameraState();
        return Math.hypot(c.position[0] - c.target[0], c.position[1] - c.target[1], c.position[2] - c.target[2]);
      };
      const box = canvas.getBoundingClientRect();
      const middle = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      const zoomed = await undisturbed(async () => {
        const d0 = distance();
        await nativeInput([{ kind: "scroll", ...middle, dy: 60 }, { kind: "scroll", ...middle, dy: 60 }]);
        await sleep(250);
        const d1 = distance();
        await nativePinch(middle, 0.1);
        return { d0, d1, d2: distance() };
      }, (z) => z.d1 > z.d0 * 1.03 && z.d2 < z.d1 * 0.85);
      const { d0, d1, d2 } = zoomed.result;
      check("trackpad scrolling and pinching zoom the 3D view", d1 > d0 * 1.03 && d2 < d1 * 0.85 && events.trusted("wheel") && events.trusted("gesturechange"), `camera ${d0.toFixed(1)} m away, after scrolling ${d1.toFixed(1)} m, after pinching ${d2.toFixed(1)} m; events: ${events.summary()}${zoomed.note}`);
      events.stop();

      // Torches and crystals give off light like the game's OmniLight3D: ground next to a torch is warmer
      // than ground 10 m away. The picture is kept with the report.
      view.fit();
      view.focus(-9, -26.5);
      view.zoom(0.3);
      await sleep(150);
      const lights = view.stats().lights;
      const nearTorch = view.screenPoint(-4, 0, -26.5);
      const awayFromTorch = view.screenPoint(-14, 0, -26.5);
      const near = nearTorch ? view.samplePixel(nearTorch.x, nearTorch.y) : [0, 0, 0, 0];
      const away = awayFromTorch ? view.samplePixel(awayFromTorch.x, awayFromTorch.y) : [0, 0, 0, 0];
      let picture = "";
      try {
        picture = await snapshot("world-3d-torches");
      } catch (e) {
        picture = `no picture: ${errorMessage(e)}`;
      }
      check("torches and crystals light the ground in the 3D view", lights === 5 && near[0]! > away[0]! + 8, `${lights} point lights; ground by torch_1 rgba(${near.join(", ")}), 10 m away rgba(${away.join(", ")}); ${picture}`);

      // The camera stays where it was across a trip to the map, where a pinch zooms the map.
      const camera = view.cameraState();
      await clickButton("Map");
      // The map's layout panel also carries data-testid="world-map" (react-resizable-panels copies its id).
      const svg = await until(() => document.querySelector<SVGSVGElement>('svg[data-testid="world-map"]'), 10_000, "the map");
      const mapWidth = () => Number((svg.getAttribute("viewBox") ?? "0 0 0 0").split(" ")[2]);
      const mapEvents = eventLog(svg, ["gesturechange"]);
      const mapBox = svg.getBoundingClientRect();
      const mapZoom = await undisturbed(async () => {
        const w = mapWidth();
        await nativePinch({ x: mapBox.left + mapBox.width / 2, y: mapBox.top + mapBox.height / 2 }, 0.1);
        return { w0: w, w1: mapWidth() };
      }, (m) => m.w1 < m.w0 * 0.85);
      const { w0, w1 } = mapZoom.result;
      mapEvents.stop();
      await clickButton("3D");
      const canvas2 = await until(() => document.querySelector<HTMLCanvasElement & { levelView?: LevelView }>('[data-testid="world-3d"] canvas'), 20_000, "the 3D view's canvas again");
      const view2 = await until(() => (canvas2.levelView && canvas2.levelView !== view ? canvas2.levelView : null), 10_000, "the 3D view to start again");
      const restored = view2.cameraState();
      const same = [...camera.position, ...camera.target].every((v, i) => Math.abs(v - [...restored.position, ...restored.target][i]!) < 1e-6);
      check("a pinch zooms the map, and the 3D view keeps its camera across the switch", w1 < w0 * 0.85 && mapEvents.trusted("gesturechange") && same, `map ${w0.toFixed(1)} m wide, after pinching ${w1.toFixed(1)} m; camera ${same ? "kept" : `moved from ${JSON.stringify(camera)} to ${JSON.stringify(restored)}`}${mapZoom.note}`);

      // Free library: a Poly Haven model downloads (each file checked against the library's MD5), is
      // placed in the world, and the 3D view draws it from the project's own files. Needs the internet.
      {
        let reason = "";
        const listed = await backend.libraryList("models").catch((e) => ((reason = errorMessage(e)), null));
        const pick = listed?.find((a) => a.id === "Barrel_01") ?? listed?.find((a) => /barrel|crate|box/i.test(a.name)) ?? listed?.[0];
        const files = pick ? await backend.libraryDownload(valleyRoot, "models", pick.id, "1k", "godot/assets/models").catch((e) => ((reason = errorMessage(e)), null)) : null;
        const gltf = files?.find((f) => f.path.endsWith(".gltf"));
        if (pick && files && gltf) {
          const asset = gltf.path.replace(/^godot\//, "");
          await store().refresh();
          const w = store().docs[worldPath]!.data as World;
          store().updateDoc(worldPath, { ...w, environment: { ...w.environment, quality: "high" }, objects: [...w.objects, { id: "model_smoke", type: "model", x: -6, z: 26, rotation: 0, scale: 1, asset, collide: true }] });
          const settled = await until(() => (MODEL_BOUNDS.has(asset) || view2.model.modelErrors.has(asset) ? true : null), 60_000, "the model to load").catch(() => null);
          const problem = view2.model.modelErrors.get(asset);
          let vertices = 0;
          view2.model.group("model_smoke")?.traverse((o) => {
            const g = (o as { geometry?: { getAttribute(n: string): { count: number } | undefined } }).geometry;
            vertices += g?.getAttribute("position")?.count ?? 0;
          });
          view2.focus(-6, 26);
          await sleep(300);
          let picture = "";
          try {
            picture = await snapshot("world-3d-model");
          } catch (e) {
            picture = `no picture: ${errorMessage(e)}`;
          }
          placedModel = asset;
          check("a free Poly Haven model downloads with verified checksums and the 3D view draws it from the project", Boolean(settled) && !problem && vertices > 100, `${pick.name} (${pick.id}): ${files.length} files, ${vertices} vertices${problem ? `, error: ${problem}` : ""}; ${picture}`);
          await store().save();
        } else {
          check("free library check skipped: Poly Haven could not be reached", true, reason || "no models listed");
        }
      }

      // Characters chosen in the world editor itself: the Robot as the player (World settings, "Play as a free
      // character", which uses the copy already in Assets rather than downloading it again) and the Fox as Elder
      // Ama (her Character model). The editor reads each file to suggest a height and pick animations by name,
      // and the 3D view plays them on the characters' own skeletons.
      if (charactersAdded) {
        const host3d = canvas2.parentElement!;
        host3d.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        const playAs = await until(() => document.querySelector<HTMLSelectElement>("#p-play-as"), 20_000, "Play as a free character").catch(() => null);
        if (playAs) {
          choose(playAs, "robot-expressive");
          await clickButton("Play as it");
        }
        const player = await until(() => (store().docs[worldPath]!.data as World).player.character, 30_000, "the player character to be set").catch(() => undefined);
        Array.from(document.querySelectorAll<HTMLButtonElement>(".tree-item")).find((b) => b.textContent?.includes("elder"))?.click();
        const npcPick = await until(() => document.querySelector<HTMLSelectElement>("#obj-npc-model"), 10_000, "Elder Ama's Character model").catch(() => null);
        if (npcPick) choose(npcPick, FOX);
        const elder = await until(() => (store().docs[worldPath]!.data as World).objects.find((o) => o.id === "elder" && o.type === "npc" && o.model), 30_000, "Elder Ama's model").catch(() => undefined);
        const playing = await until(() => {
          const p = view2.model.playing();
          return p[SPAWN_ID] && p["elder"] ? p : null;
        }, 60_000, "the characters to animate").catch(() => view2.model.playing());
        // A bone in the player's character must move while the view plays.
        const bone = () => {
          let q = "";
          view2.model.group(SPAWN_ID)?.traverse((o) => {
            if (!q && (o as { isBone?: boolean }).isBone && /arm|hand|head|leg/i.test(o.name)) q = `${o.name}:${o.quaternion.toArray().map((v) => v.toFixed(4)).join(",")}`;
          });
          return q;
        };
        view2.focus(world.player.spawn.x, world.player.spawn.z);
        const b0 = bone();
        await sleep(700);
        const b1 = bone();
        let picture = "";
        try {
          picture = await snapshot("world-3d-characters");
        } catch (e) {
          picture = `no picture: ${errorMessage(e)}`;
        }
        check(
          "choosing characters in the world editor animates the player and Elder Ama in the 3D view",
          player?.asset === ROBOT && Boolean(player.walk) && elder?.type === "npc" && elder.model === FOX && playing[SPAWN_ID] === (player.idle ?? "") && Boolean(playing["elder"]) && b0 !== "" && b0 !== b1,
          `${playAs ? "Play as a free character" : "no Play as control"}; player ${JSON.stringify(player)}; elder ${elder?.type === "npc" ? `${elder.model}, ${elder.height} m, ${elder.animation}` : "unchanged"}; playing ${JSON.stringify(playing)}; bone ${b0} → ${b1}; ${picture}`,
        );
        charactersPlaced = Boolean(player?.walk && elder);
        await store().save();
      }

      // A texture set on a rock (from the free library's Textures, chosen in the rock's inspector), drawn
      // in the 3D view with the same world-space projection the game uses.
      {
        const texFiles = await backend.libraryDownload(valleyRoot, "textures", "rock_wall_02", "1k", "godot/assets/textures").catch(() => null);
        const albedo = texFiles?.find((f) => /_diff_/.test(f.path))?.path.replace(/^godot\//, "");
        if (albedo) {
          await store().refresh();
          Array.from(document.querySelectorAll<HTMLButtonElement>(".tree-item")).find((b) => b.textContent?.includes("rock_1"))?.click();
          const texPick = await until(() => document.querySelector<HTMLSelectElement>("#obj-texture"), 10_000, "the rock's Texture setting").catch(() => null);
          if (texPick) choose(texPick, albedo);
          const rock = await until(() => (store().docs[worldPath]!.data as World).objects.find((o) => o.id === "rock_1" && o.type === "rock" && o.material), 15_000, "the rock's texture").catch(() => undefined);
          const parts = await until(() => view2.model.textured.get("rock_1"), 30_000, "the textured rock in the 3D view").catch(() => 0);
          const r = rock?.type === "rock" ? rock : undefined;
          if (r) view2.focus(r.x, r.z);
          await sleep(400);
          let picture = "";
          try {
            picture = await snapshot("world-3d-texture");
          } catch (e) {
            picture = `no picture: ${errorMessage(e)}`;
          }
          rockTextured = Boolean(r?.material && parts);
          check("a texture set from the free library goes on a rock and the 3D view draws it", rockTextured && Boolean(r?.material?.normal && r.material.roughness), `${JSON.stringify(r?.material)}; ${parts} textured part(s); ${picture}`);
        } else {
          check("texture check skipped: Poly Haven could not be reached", true, "");
        }
      }

      // A photographed sky from the free library's Skies (Poly Haven, checked against its MD5), chosen in
      // World settings: the 3D view draws it behind the level and lights the level with it, as the game does
      // (photo_sky.gdshader). Then back to the sky colours, so Play here's colour check sees the standard sky.
      {
        const SKY = "kloofendal_48d_partly_cloudy_puresky";
        let skyReason = "";
        const skyFiles = await backend.libraryDownload(valleyRoot, "hdris", SKY, "1k", "godot/assets/skies").catch((e) => {
          skyReason = errorMessage(e);
          return null;
        });
        const hdr = skyFiles?.find((f) => f.path.endsWith(".hdr"))?.path.replace(/^godot\//, "");
        if (hdr) {
          await store().refresh();
          canvas2.parentElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          const skyPick = await until(() => document.querySelector<HTMLSelectElement>("#e-sky:not([disabled])"), 10_000, "the Sky setting").catch(() => null);
          if (skyPick) choose(skyPick, hdr);
          const set = await until(() => ((store().docs[worldPath]!.data as World).environment.skyImage === hdr ? true : null), 15_000, "the sky setting").catch(() => null);
          const shown = await until(() => view2.model.photoSky, 30_000, "the photographed sky in the 3D view").catch(() => null);
          await sleep(400);
          let picture = "";
          try {
            picture = await snapshot("world-3d-sky");
          } catch (e) {
            picture = `no picture: ${errorMessage(e)}`;
          }
          check("a photographed sky from the free library becomes the level's sky, and the 3D view draws it and lights the level with it", Boolean(set && shown), `${hdr} (${skyFiles?.[0]?.bytes ?? 0} bytes); in the 3D view: ${shown ? "yes" : "no"}; ${picture}`);
          const back = document.querySelector<HTMLSelectElement>("#e-sky");
          if (back) choose(back, "");
          await until(() => (!(store().docs[worldPath]!.data as World).environment.skyImage ? true : null), 10_000, "the sky colours again").catch(() => null);
        } else {
          check("photographed sky check skipped: Poly Haven could not be reached", true, skyReason);
        }
      }

      // The realistic style draws trees and rocks in detail (nature.ts: the same meshes as the game's
      // nature.gd), the leaves with the picture in the template's leaf_atlas.gd. Then back to the standard style.
      {
        canvas2.parentElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        const stylePick = await until(() => document.querySelector<HTMLSelectElement>("#e-style:not([disabled])"), 10_000, "the Style setting").catch(() => null);
        if (stylePick) choose(stylePick, "realistic");
        const level = store().docs[worldPath]!.data as World;
        const tree = level.objects.find((o) => o.type === "tree");
        const rock = level.objects.find((o) => o.type === "rock");
        const drawn = await until(() => {
          const leaves = tree ? (view2.model.group(tree.id)?.getObjectByName("Leaves") as Mesh | undefined) : undefined;
          const stone = rock ? view2.model.group(rock.id)?.getObjectByName("Rock") : undefined;
          return leaves && (leaves.material as Material).visible && stone ? true : null;
        }, 20_000, "detailed trees and rocks in the 3D view").catch(() => null);
        if (tree) view2.focus(tree.x, tree.z);
        await sleep(400);
        let picture = "";
        try {
          picture = await snapshot("world-3d-realistic");
        } catch (e) {
          picture = `no picture: ${errorMessage(e)}`;
        }
        check("the realistic style draws trees and rocks in detail in the 3D view, leaves and all", Boolean(drawn), `${tree?.id ?? "no tree"} and ${rock?.id ?? "no rock"}; ${picture}`);
        const back = document.querySelector<HTMLSelectElement>("#e-style");
        if (back) choose(back, "standard");
        await until(() => (((store().docs[worldPath]!.data as World).environment.style ?? "standard") === "standard" ? true : null), 10_000, "the standard style again").catch(() => null);
      }

      // The level's Sound settings: the footsteps loop as music and the coin replaces the chime. The
      // preview player loads both files through the asset protocol (muted, so nothing is heard).
      if (soundsAdded) {
        canvas2.parentElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        const music = await until(() => document.querySelector<HTMLSelectElement>('select[aria-label="Music"]'), 10_000, "the Music setting").catch(() => null);
        if (music) choose(music, STEPS);
        const chime = await until(() => document.querySelector<HTMLSelectElement>('select[aria-label="Chime sound"]'), 10_000, "the Chime sound setting").catch(() => null);
        if (chime) choose(chime, COIN);
        const audio = await until(() => {
          const a = (store().docs[worldPath]!.data as World).audio;
          return a?.music && a.sounds?.["chime"] ? a : null;
        }, 15_000, "the level's sound settings").catch(() => undefined);
        const playable = async (asset: string) => {
          const el = new Audio(backend.assetUrl(valleyRoot, `godot/${asset}`) ?? "");
          el.muted = true;
          el.preload = "auto";
          return new Promise<number>((resolve) => {
            el.onloadedmetadata = () => resolve(el.duration);
            el.onerror = () => resolve(-1);
            setTimeout(() => resolve(-2), 10_000);
          });
        };
        const durations = [await playable(STEPS), await playable(COIN)];
        soundsSet = Boolean(audio);
        check("the Sound settings use library files for the music and the chime, and previews can load them", soundsSet && durations.every((d) => d > 0), `${JSON.stringify(audio)}; durations ${durations.map((d) => d.toFixed(2)).join(", ")} s`);
        await store().save();
      }

      await clickButton("Map");
      try {
        if (savedChoice === null) localStorage.removeItem(VIEW_KEY);
        else localStorage.setItem(VIEW_KEY, savedChoice);
      } catch {
        // storage unavailable: nothing was kept
      }
      await store().save();
    }
    if (godot) {
      await clickButton("Play and run");
      const selfTest = await runFromButton("Self-test", "smoke", 240_000);
      // With a library model placed, the game imports it (the run adds an import step for new assets), loads it and gives it a collision box.
      const modelOk = !placedModel || (selfTest.smoke?.observations?.["models"] === 1 && Boolean(selfTest.smoke?.checks?.some((c) => c.name === "solid models block the player" && c.ok)));
      // With characters, the game's own checks cover the player's idle and walk, and Elder Ama loops her animation.
      const passed = (prefix: string) => Boolean(selfTest.smoke?.checks?.some((c) => c.name.startsWith(prefix) && c.ok));
      const soundOk = !soundsSet || (passed("the level's imported sounds load") && passed("the level's music plays") && passed("replaced sounds play from their files"));
      const textureOk = !rockTextured || Boolean((selfTest.smoke?.observations?.["textured"] as Record<string, number> | undefined)?.["rock_1"]);
      const characterOk = !charactersPlaced || (Boolean(selfTest.smoke?.checks?.some((c) => c.name.startsWith("the player character stands idle") && c.ok)) && Boolean((selfTest.smoke?.observations?.["animations"] as Record<string, string> | undefined)?.["elder"]));
      check("the Self-test button runs the Godot game headlessly and its self-test passes", selfTest.status === "passed" && Boolean(selfTest.smoke?.pass) && modelOk && characterOk && soundOk && textureOk, `${JSON.stringify(selfTest.smoke?.observations ?? lastLines(selfTest, 5))}; ${(selfTest.smoke?.checks ?? []).filter((c) => /character|sound|music/.test(c.name)).map((c) => `${c.name}: ${c.detail}`).join(" | ")}`);

      // Export: a new project needs no preparation; the exported app must pass the same self-test.
      const exportCap = engines.find((e) => e.id === "godot")?.capabilities.find((c) => c.id === "export");
      env["export"] = exportCap?.status ?? null;
      if (exportCap?.status === "available") {
        const plan = planGodotExport({
          manifest: store().manifest!,
          presets: await backend.projectRead(valleyRoot, "godot/export_presets.cfg"),
          projectGodot: await backend.projectRead(valleyRoot, "godot/project.godot"),
          gitignore: await backend.projectRead(valleyRoot, ".gitignore"),
        });
        const exported = await runFromButton("Export for macOS", "export", 300_000);
        const finder = await until(() => buttonNamed("Show in Finder"), 5_000, "Show in Finder").catch(() => null);
        check(
          "the Export for macOS button builds an app, the exported game passes its self-test and Show in Finder appears",
          plan.writes.length === 0 && plan.appPath === "exports/macos/Smoke Valley.app" && exported.status === "passed" && Boolean(exported.smoke?.pass) && Boolean(finder),
          `${plan.appPath} · ${exported.status} · ${lastLines(exported, 2)}`,
        );
      } else {
        check("export skipped: Godot export templates are not installed", true, exportCap?.reason ?? "");
      }

      // Windows and Linux: a new project needs no preparation either. Their programs cannot run on a Mac,
      // so each run ends with Godot running the exported game data (the .pck) through the same self-test.
      for (const target of ["windows", "linux"] as const) {
        const { label, suffix } = DESKTOP_TARGETS[target];
        const cap = engines.find((e) => e.id === "godot")?.capabilities.find((c) => c.id === `export-${target}`);
        env[`export-${target}`] = cap?.status ?? null;
        if (cap?.status !== "available") {
          check(`${label} export skipped: its Godot export template is not installed`, true, cap?.reason ?? "");
          continue;
        }
        const plan = planGodotDesktopExport({ manifest: store().manifest!, target, presets: await backend.projectRead(valleyRoot, "godot/export_presets.cfg"), gitignore: await backend.projectRead(valleyRoot, ".gitignore") });
        const exported = await runFromButton(`Export for ${label}`, `export-${target}`, 300_000);
        const files = await backend.projectFiles(valleyRoot);
        const pack = `${plan.buildPath?.replace(/\.[^./]+$/, "")}.pck`;
        const size = (path: string | null) => files.find((f) => f.path === path && f.kind === "file")?.size ?? 0;
        const finder = await until(() => buttonNamed("Show in Finder"), 5_000, "Show in Finder").catch(() => null);
        check(
          `the Export for ${label} button builds a 64-bit ${label} game and the exported game data passes its self-test`,
          plan.writes.length === 0 && plan.buildPath === `exports/${target}/Smoke Valley${suffix}` && exported.status === "passed" && Boolean(exported.smoke?.pass) && size(plan.buildPath) > 10_000_000 && size(pack) > 20_000 && Boolean(finder),
          `${plan.buildPath} (${(size(plan.buildPath) / 1e6).toFixed(0)} MB) and ${pack} (${(size(pack) / 1e6).toFixed(1)} MB) · ${exported.status}, ${(exported.smoke?.checks ?? []).length} game checks · ${lastLines(exported, 2)}`,
        );
      }

      // Play here: the Play view builds the web version and plays it in a sandboxed frame. The game is
      // driven with the native keyboard, and the frame must not reach Game Studio.
      const webCap = engines.find((e) => e.id === "godot")?.capabilities.find((c) => c.id === "play-web");
      env["playHere"] = webCap?.status ?? null;
      if (webCap?.status === "available") {
        const plan = planGodotWebExport({ manifest: store().manifest!, presets: await backend.projectRead(valleyRoot, "godot/export_presets.cfg"), gitignore: await backend.projectRead(valleyRoot, ".gitignore") });
        // Only this game's sessions: earlier projects' stopped sessions stay in the list, and the new one
        // starts a moment after the frame appears.
        const earlier = playSessionIds();
        const build = await runFromButton("Play here", "web", 300_000);
        const frame = await until(() => document.querySelector<HTMLIFrameElement>('[data-testid="play-here-frame"]'), 30_000, "the game frame").catch(() => null);
        const session = () => useRuns.getState().runs.find((r) => r.action === "play-here" && !earlier.has(r.id));
        const lastPerf = () => session()?.perf.at(-1);
        const started = await until(() => {
          const s = session();
          return s && s.perf.length >= 2 && s.lines.some((l) => l.text.startsWith("The game started")) ? s : null;
        }, 120_000, "the game to start and report frames").catch(() => null);
        const p = lastPerf();
        check(
          "Play here builds the web version and plays it inside Game Studio",
          plan.writes.length === 0 && plan.pagePath === "exports/web/index.html" && build.status === "passed" && Boolean(frame) && Boolean(started) && (p?.fps ?? 0) > 0 && (p?.drawCalls ?? 0) > 20,
          `${build.status}; ${p ? `${Math.round(p.fps)} fps, ${p.drawCalls} draw calls, ${p.nodes} nodes` : "no frames"}; ${started ? started.lines.filter((l) => l.stream !== "studio" && !l.text.startsWith("GSTUDIO")).slice(0, 3).map((l) => l.text).join(" | ") : lastLines(build, 3)}`,
        );
        if (frame && started) {
          // A click gives the game the keyboard (and may capture the pointer: Esc frees it again); then W is
          // held for 1.5 s.
          const box = frame.getBoundingClientRect();
          const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
          const esc: InputStep[] = [{ kind: "key", key: "\u001b", code: 53, down: true }, { kind: "key", key: "\u001b", code: 53, down: false }];
          const walk = await undisturbed(async () => {
            const from = lastPerf()?.player;
            // A pause after releasing W lets the game see the release before Esc frees the pointer (a release
            // that arrives with the pointer change can be lost, and the player then walks on).
            await nativeInput([{ kind: "down", ...centre }, { kind: "up", ...centre }, { kind: "wait", ms: 300 }, { kind: "key", key: "w", code: 13, down: true }, { kind: "wait", ms: 1500 }, { kind: "key", key: "w", code: 13, down: false }, { kind: "wait", ms: 300 }, ...esc]);
            await sleep(1500);
            const to = lastPerf()?.player;
            return { from, to, walked: from && to ? Math.hypot(to[0] - from[0], to[2] - from[2]) : 0 };
          }, (w) => w.walked > 2);
          const { from: before, to: after, walked } = walk.result;
          let picture = "";
          try {
            picture = await snapshot("play-here");
          } catch (e) {
            picture = `no picture: ${errorMessage(e)}`;
          }
          const now = lastPerf();
          check("holding W on the keyboard walks the player in the game playing here", walked > 2, `player ${JSON.stringify(before)} → ${JSON.stringify(after)}, ${walked.toFixed(1)} m; then ${Math.round(now?.fps ?? 0)} fps, ${now?.drawCalls ?? 0} draw calls; ${picture}${walk.note}`);

          // Colours: over this patch of grassy ground (the median of a square about 50 px across, so a tuft
          // or a patch does not decide it) Godot's desktop renderer draws about rgb(112, 168, 94), seen from
          // anywhere the walk ends (measured from five spots: 108-115, 164-170, 93-95). With the sun casting
          // its own shadows on the web renderer it washes out (green above 240), which is why the template
          // draws web shadows itself (sun_shadows.gd).
          const ground = await pictureColours("play-here", [{ x: box.left + box.width * 0.08, y: box.top + box.height * 0.88 }], 25).catch(() => null);
          const g = ground?.[0];
          check(
            "Play here draws the ground in the colours Godot's desktop renderer gives it, not washed out",
            Boolean(g && Math.abs(g[0] - 112) <= 30 && Math.abs(g[1] - 168) <= 30 && Math.abs(g[2] - 94) <= 30),
            g ? `ground rgb(${g.join(", ")}); Godot's desktop renderer rgb(112, 168, 94)` : "no picture",
          );

          // Mouse look: a click captures the pointer (WebKit allows it only in the focused window), moving
          // the mouse turns the camera, and Esc gives the pointer back.
          const mouseState = () => document.querySelector<HTMLElement>(".play-stage")?.dataset["mouse"];
          const look = await undisturbed(async () => {
            await nativeInput([{ kind: "focus" }, { kind: "down", ...centre }, { kind: "up", ...centre }]);
            const capturedAt = await until(() => mouseState() === "captured", 3_000, "the game to capture the pointer").then(() => lastPerf()?.look, () => null);
            let turned = 0;
            let freed = false;
            if (capturedAt) {
              await nativeInput(Array.from({ length: 6 }, () => [{ kind: "move" as const, ...centre, dx: 30, dy: 0 }, { kind: "wait" as const, ms: 30 }]).flat());
              await sleep(1200);
              const lookAfter = lastPerf()?.look;
              turned = lookAfter ? Math.abs(lookAfter[0] - capturedAt[0]) : 0;
              await nativeInput(esc);
              freed = await until(() => mouseState() === "free", 3_000, "Esc to free the pointer").then(() => true, () => false);
            }
            return { capturedAt, turned, freed };
          }, (l) => Boolean(l.capturedAt) && l.turned > 0.2 && l.freed);
          const { capturedAt, turned, freed } = look.result;
          check(
            "a click in the game captures the mouse pointer, moving the mouse turns the view, and Esc gives the pointer back",
            Boolean(capturedAt) && turned > 0.2 && freed,
            (capturedAt ? `captured; 180 px of mouse movement turned the view ${turned.toFixed(2)} rad; ${freed ? "Esc freed the pointer" : "the pointer stayed captured after Esc"}` : "the pointer was not captured") + look.note,
          );
          if (!freed) await nativeInput(esc).catch(() => undefined);

          const probe = await probeFrame(frame.src);
          check(
            "the game's frame is cut off from Game Studio: no studio scripts, no access to its page, commands refused",
            probe["origin"] === "null" && probe["tauriInternals"] === "undefined" && probe["parentDocument"] === "SecurityError" && typeof probe["ipc"] === "string" && !probe["ipc"].startsWith("answered 200"),
            JSON.stringify(probe),
          );
        }
        // Saves: the game writes user://progress.json as it plays; Play here keeps it on disk for the project.
        const savedProgress = async () => {
          const text = await backend.playSavesRead(valleyRoot).catch(() => null);
          const entry = text ? [...parseSaves(text)].find(([path]) => path.endsWith("/progress.json"))?.[1] : undefined;
          try {
            return entry?.contents ? (JSON.parse(new TextDecoder().decode(entry.contents)) as { player?: number[] }) : null;
          } catch {
            return null;
          }
        };
        let kept: { player?: number[] } | null = null;
        if (frame && started) {
          for (const end = Date.now() + 20_000; Date.now() < end; await sleep(500)) {
            kept = await savedProgress();
            if ((kept?.player?.[2] ?? 99) < 26) break;
          }
          check("the game's saves reach Game Studio, which keeps them on disk for the project", (kept?.player?.[2] ?? 99) < 26, kept ? `progress.json: player at ${JSON.stringify(kept.player)}` : "no saves kept");

          // A villager who answers with AI: the question goes from the game, through its page, to Game
          // Studio, which asks the AI chosen in Settings; the answer comes back into the game (its telemetry
          // reports it). The question is put to the game the way the player's typing would be.
          const usable = (useEnv.getState().providers ?? []).filter((p) => p.allowed && p.available);
          if (usable.length > 0) {
            const asked = session()?.chats.length ?? 0;
            frame.contentWindow?.postMessage({ type: "npc-chat-test", npcId: "elder", question: "Where should I look for the sun crystals?" }, "*");
            const reply = await until(() => {
              const c = session()?.chats ?? [];
              return c.length > asked ? c[c.length - 1]! : null;
            }, 90_000, "the elder's answer").catch(() => null);
            const note = session()?.lines.filter((l) => /answered with|could not answer|was refused/.test(l.text)).at(-1)?.text ?? "";
            check(
              "a villager answers a typed question with AI inside Game Studio, through the game's page and the AI chosen in Settings",
              Boolean(reply && !reply.error && reply.answer.length > 10),
              reply ? `${reply.npc}: "${reply.question}" → "${reply.answer}"${reply.error ? ` (error: ${reply.error})` : ""}; ${note}` : `no answer; ${note}`,
            );
          } else {
            check("villager chat check skipped: no AI provider is set up", true, "");
          }
        }
        const firstSession = session()?.id;
        // What the game last saved before it stops: the player stands still in the conversation, so this is
        // the save Play here restores next (an earlier read can be older if the player moved after it).
        const lastSave = frame && started ? await savedProgress() : null;
        if (lastSave?.player) kept = lastSave;
        await clickButton("Stop the game").catch(() => undefined);
        await sleep(300);
        check("Stop closes the game and ends its run", !document.querySelector('[data-testid="play-here-frame"]') && session()?.status === "stopped", `run ${session()?.status ?? "missing"}`);

        // Play here again: the game carries on from its save. Then Clear saves: it starts from the beginning.
        const progressOf = (r: RunRecord | undefined) => {
          const line = r?.lines.find((l) => l.text.startsWith("GSTUDIO ") && l.text.includes('"type":"progress"'));
          try {
            return line ? (JSON.parse(line.text.slice("GSTUDIO ".length)) as { restored?: boolean; player?: number[] }) : null;
          } catch {
            return null;
          }
        };
        if (kept?.player) {
          await runFromButton("Play here", "web", 300_000);
          const resumed = await until(() => {
            const s = session();
            return s && s.id !== firstSession && progressOf(s) ? s : null;
          }, 120_000, "the game to start again").catch(() => null);
          const back = progressOf(resumed ?? undefined);
          const [bx, , bz] = back?.player ?? [];
          const [kx, , kz] = kept.player;
          const gap = bx !== undefined && bz !== undefined && kx !== undefined && kz !== undefined ? Math.hypot(bx - kx, bz - kz) : 99;
          check("after Stop, Play here carries on from the game's save", back?.restored === true && gap < 0.6, `${JSON.stringify(back)}; saved ${JSON.stringify(kept.player)}`);

          const resumedId = resumed?.id;
          await clickButton("Clear saves").catch(() => undefined);
          await clickButton("Delete saves").catch(() => undefined);
          const fresh = await until(() => {
            const s = session();
            return s && s.id !== resumedId && s.id !== firstSession && progressOf(s) ? s : null;
          }, 120_000, "the game to start over").catch(() => null);
          const over = progressOf(fresh ?? undefined);
          await sleep(1000);
          const after = await savedProgress();
          check("Clear saves deletes them and the game starts from the beginning", over?.restored === false && (after?.player?.[2] ?? 0) > 29, `${JSON.stringify(over)}; new save: player at ${JSON.stringify(after?.player)}`);
          await clickButton("Stop the game").catch(() => undefined);
          await sleep(300);
        }
      } else {
        check("Play here skipped: the Godot web export template is not installed", true, webCap?.reason ?? "");
      }
    } else {
      check("Godot run skipped: Godot is not installed", true, "Install Godot to include this check");
    }

    // Assistant with the local model, through the Rust provider adapter.
    const providers = await backend.aiProviders();
    const ollama = providers.find((p) => p.id === "ollama" && p.available);
    env["ollama"] = ollama?.models ?? null;
    const model = ollama?.models.find((m) => m.startsWith("qwen3")) ?? ollama?.models[0];
    if (ollama && model) {
      const docs = (await store().collectDocs())!;
      const generate: GenerateFn = async (input) => {
        const r = await backend.aiGenerate({ provider: "ollama", model, system: input.system, messages: input.messages, schema: input.schema, schemaName: input.schemaName, maxTokens: 8000 }, valleyRoot);
        return { text: r.text, provider: r.provider, model: r.servedBy ?? r.model };
      };
      const run = await runAgent({ agent: agentById("world-builder"), request: "Add one rock next to the player start.", docs, registry, generate, author: "AI assistant ({model})" });
      const attempts = run.attempts.map((a) => `attempt ${a.number}: ${a.problems.join(" / ") || "valid"} :: ${a.raw.slice(0, 500)}`).join(" || ");
      check("the local model proposes a valid world change", run.status === "ready", `${run.status}: ${run.result?.changes.map((c) => c.text).join("; ") || run.message} || ${attempts}`);
      if (run.status === "ready" && run.result) {
        const before = (await backend.snapshotList(valleyRoot, 50)).length;
        check("applies the approved change with snapshots", await store().applyAgentChanges(run.result.docs, run.result.touched, run.message.slice(0, 80)));
        const after = await backend.snapshotList(valleyRoot, 50);
        const savedWorld = await backend.projectRead(valleyRoot, worldPath);
        check("the applied change is on disk and bracketed by snapshots", after.length >= before + 2 && savedWorld.includes('"rock"'), after.slice(0, 2).map((s) => s.message).join(" | "));
      }
    } else {
      check("assistant check skipped: no local model running", true, "Start Ollama to include this check");
    }

    // Chat replies stream through the Rust backend piece by piece, from the local model.
    if (ollama && model) {
      const docs = (await store().collectDocs())!;
      const pieces: string[] = [];
      const generate: GenerateFn = async (input) => {
        const r = await streamGenerate({ provider: "ollama", model, system: input.system, messages: input.messages, schema: input.schema, schemaName: input.schemaName, maxTokens: 4000 }, valleyRoot, (p) => input.onText?.(p)).result;
        return { text: r.text, provider: r.provider, model: r.servedBy ?? r.model };
      };
      const run = await runChat({ agent: agentById("world-builder"), history: [], message: "In one sentence, what is the player's goal in this level?", docs, registry, generate, author: "AI assistant ({model})", onText: (p) => pieces.push(p) });
      check("the local model streams a chat reply through the app", ["no-change", "ready"].includes(run.status) && pieces.length > 1 && pieces.join("") === run.attempts.at(-1)?.raw, `${run.status}, ${pieces.length} pieces: ${run.message.slice(0, 200)}`);
    } else {
      check("chat streaming check skipped: no local model running", true, "Start Ollama to include this check");
    }

    // Cloud assistant: runs only when GEMINI_API_KEY is in the app's environment. Cloud providers are
    // allowed in this run's own throwaway settings; the request is billed to the key's project.
    const gemini = providers.find((p) => p.id === "gemini" && p.available);
    const geminiModel = gemini?.suggestedModels[0];
    env["gemini"] = gemini ? (geminiModel ?? "no suggested model") : null;
    if (gemini && geminiModel) {
      await backend.settingsSet("ai.allowCloud", true);
      const docs = (await store().collectDocs())!;
      const generate: GenerateFn = async (input) => {
        const r = await backend.aiGenerate({ provider: "gemini", model: geminiModel, system: input.system, messages: input.messages, schema: input.schema, schemaName: input.schemaName, maxTokens: 8000 }, valleyRoot);
        return { text: r.text, provider: r.provider, model: r.servedBy ?? r.model };
      };
      const run = await runAgent({ agent: agentById("world-builder"), request: "Add one rock next to the player start.", docs, registry, generate, author: "AI assistant ({model})" });
      const attempts = run.attempts.map((a) => `attempt ${a.number}: ${a.problems.join(" / ") || "valid"} :: ${a.raw.slice(0, 500)}`).join(" || ");
      check(`Gemini (${geminiModel}) proposes a valid world change through the app`, run.status === "ready", `${run.status}: ${run.result?.changes.map((c) => c.text).join("; ") || run.message} || ${attempts}`);
      const pieces: string[] = [];
      const streamed: GenerateFn = async (input) => {
        // If Gemini breaks the answer off and is asked again, the pieces so far no longer count.
        const r = await streamGenerate({ provider: "gemini", model: geminiModel, system: input.system, messages: input.messages, schema: input.schema, schemaName: input.schemaName, maxTokens: 4000 }, valleyRoot, (p) => input.onText?.(p), () => { pieces.length = 0; }).result;
        return { text: r.text, provider: r.provider, model: r.servedBy ?? r.model };
      };
      const chat = await runChat({ agent: agentById("world-builder"), history: [], message: "In two sentences, what could make this level more fun?", docs, registry, generate: streamed, author: "AI assistant ({model})", onText: (p) => pieces.push(p) });
      check(`Gemini (${geminiModel}) streams a chat reply through the app`, ["no-change", "ready"].includes(chat.status) && pieces.length >= 1 && pieces.join("") === chat.attempts.at(-1)?.raw, `${chat.status}, ${pieces.length} pieces: ${chat.message.slice(0, 200)}`);
      await backend.settingsSet("ai.allowCloud", null);
    } else {
      check("Gemini check skipped: no GEMINI_API_KEY in the app's environment", true, "Start the app with GEMINI_API_KEY set to include this check");
    }
    await store().close();

    // Start from an idea, with Gemini: a public page about platform games is read as data, the
    // Producer writes a brief, the template's specialist shapes the starting content, and the game is
    // created with those changes applied, all through the Start from an idea dialog.
    if (gemini && geminiModel) {
      await backend.settingsSet("ai.allowCloud", true);
      const page = await backend.pageFetch("https://en.wikipedia.org/wiki/Platform_game").catch((e) => ({ url: "", title: "", description: "", text: "", error: errorMessage(e) }));
      check("reads a linked public page as plain text", page.title.includes("Platform") && page.text.length > 2000 && !/<script|<\/p>/i.test(page.text), `${page.title}: ${page.text.length} characters${"error" in page ? ` (${page.error})` : ""}`);
      // The dialog itself, used the way a person uses it: an idea, a link, Gemini, Plan my game, Create this game.
      await useEnv.getState().refreshProviders();
      let outcome = "not opened";
      let planText = "";
      let changesShown = 0;
      let created = false;
      const ideaAttempts: string[] = [];
      try {
        await clickButton("Home");
        await clickButton("Start from an idea");
        typeInto(await until(() => document.querySelector<HTMLTextAreaElement>("#idea-text"), 10_000, "the idea box"), "A side-scrolling game where a fox runs along autumn rooftops at dusk collecting acorns, with a few patrolling crows.");
        typeInto(document.querySelector<HTMLInputElement>("#idea-link")!, "https://en.wikipedia.org/wiki/Platform_game");
        choose(await until(() => {
          const sel = document.querySelector<HTMLSelectElement>("#idea-provider");
          return sel && Array.from(sel.options).some((o) => o.value === "gemini") ? sel : null;
        }, 15_000, "Gemini in the dialog's model list"), "gemini");
        choose(await until(() => {
          const sel = document.querySelector<HTMLSelectElement>('select[aria-label="Model name"]');
          return sel && Array.from(sel.options).some((o) => o.value === geminiModel) ? sel : null;
        }, 10_000, `${geminiModel} in the dialog`), geminiModel);
        // A plan whose changes do not validate offers Plan again; a person would press it once, and so does this check (both attempts are reported).
        for (let attempt = 1; attempt <= 2; attempt++) {
          await clickButton(attempt === 1 ? "Plan my game" : "Plan again");
          outcome = await until(() => {
            const create = buttonNamed("Create this game");
            if (create && !create.disabled) return "planned";
            return document.querySelector('[role="dialog"] .notice--error') ? "error" : null;
          }, 240_000, "the plan").catch(() => "timed out");
          planText = (document.querySelector('[data-testid="idea-plan"]') ?? document.querySelector('[role="dialog"] .notice--error'))?.textContent ?? "";
          changesShown = document.querySelectorAll('[data-testid="idea-plan"] .change-line').length;
          const problem = document.querySelector('[role="dialog"] .notice--error')?.textContent ?? "";
          if (outcome === "planned" || !buttonNamed("Plan again")) {
            if (problem) planText = `${problem} | ${planText}`;
            break;
          }
          ideaAttempts.push(`attempt ${attempt}: ${problem.replace(/\s+/g, " ").slice(0, 300)}`);
        }
        if (outcome === "planned") {
          await clickButton("Create this game");
          created = await until(() => (store().root && !document.querySelector('[role="dialog"]') && !store().busy ? true : null), 180_000, "the new project").catch(() => false);
        } else {
          await clickButton("Cancel").catch(() => undefined);
        }
      } catch (e) {
        outcome = errorMessage(e);
      }
      const snaps = created ? await backend.snapshotList(store().root!, 10).catch(() => []) : [];
      const levelName = created && store().manifest?.template.id === "platformer-2d" ? ((await store().loadDoc("data/level.json"))?.data as { name?: string } | undefined)?.name : undefined;
      check(
        `the Start from an idea dialog plans with Gemini (${geminiModel}) from an idea and a link, and creates the game with the planned changes`,
        created && changesShown > 0 && snaps.some((x) => x.message.startsWith("Assistant: New game from an idea")) && Boolean(store().root?.startsWith(dir)),
        `${ideaAttempts.length ? `${ideaAttempts.join(" · ")} · then ` : ""}${outcome}; ${changesShown} changes shown; ${created ? `created "${store().manifest?.title}" (${store().manifest?.template.id})${levelName ? `, level "${levelName}"` : ""} in ${store().root}` : "not created"}; ${planText.replace(/\s+/g, " ").slice(0, 500)}`,
      );
      if (created) await store().close();
      await backend.settingsSet("ai.allowCloud", null);
    } else {
      check("idea check skipped: no GEMINI_API_KEY in the app's environment", true, "Start the app with GEMINI_API_KEY set to include this check");
    }

    // The 3D adventure: the valley's Godot template with enemies, hearts, pushable blocks and a timer. Its own
    // self-test fights a beetle, pushes a block, runs the sunset timer out and wins at the beacon.
    if (godot) {
      check("creates a 3D adventure project", await store().create("adventure-3d", "Smoke Ruins", dir));
      await clickButton("Play and run");
      const ruins = await runFromButton("Self-test", "smoke", 240_000);
      const o = ruins.smoke?.observations ?? {};
      const passedChecks = (ruins.smoke?.checks ?? []).filter((c) => c.ok).map((c) => c.name);
      const fought = [
        "an enemy chases the player who comes within sight",
        "an enemy's touch costs the player hearts, then the player blinks unhurt for a moment",
        "the staff defeats an enemy in as many hits as its health",
        "with no hearts left the player starts again at the spawn point with full hearts",
        "walking into a block pushes it straight ahead",
        "a timer that reaches zero runs On Timer",
      ].every((n) => passedChecks.includes(n));
      check(
        "the 3D adventure's self-test passes: a beetle chases, hurts and falls to the staff, a block is pushed, the plates open the gate, the sunset timer runs out and the beacon wins",
        ruins.status === "passed" && Boolean(ruins.smoke?.pass) && fought && o["won"] === true && JSON.stringify(o["timersFired"]) === '["sunset"]' && (o["defeated"] as string[] | undefined)?.length === 4,
        `${JSON.stringify({ won: o["won"], defeated: o["defeated"], blockZones: o["blockZones"], timersFired: o["timersFired"], health: o["health"] })}; ${(ruins.smoke?.checks ?? []).filter((c) => /enemy|block|timer|hearts/.test(c.name)).map((c) => `${c.name}: ${c.detail}`).join(" | ")}`,
      );
      // The beetles, blocks and gate are models made with Kiln; the beetles walk on their own legs.
      const used = (o["modelsUsed"] ?? {}) as Record<string, string>;
      check(
        "the 3D adventure draws its beetles, blocks and gate from the Kiln models, the beetles walking on their own legs and the gate's door sinking",
        Object.keys(used).length === 7 && Object.values(used).every((a) => a.startsWith("assets/models/kiln/")) && o["enemyWalk"] === "walk/Walk" && (o["doorPieces"] as Record<string, number> | undefined)?.["gate_ruins"] === 4,
        JSON.stringify({ modelsUsed: Object.keys(used).length, enemyWalk: o["enemyWalk"], doorPieces: o["doorPieces"] }),
      );
      // The same ruins in Play here (the web build): the models load there too, and walking north brings them into view.
      const webReady3d = engines.find((e) => e.id === "godot")?.capabilities.find((c) => c.id === "play-web")?.status === "available";
      if (webReady3d) {
        // Only this game's sessions: earlier projects' stopped sessions stay in the list, and the new one
        // starts a moment after the frame appears.
        const earlier = playSessionIds();
        const build = await runFromButton("Play here", "web", 420_000);
        const frame = await until(() => document.querySelector<HTMLIFrameElement>('[data-testid="play-here-frame"]'), 30_000, "the game frame").catch(() => null);
        const session = () => useRuns.getState().runs.find((r) => r.action === "play-here" && !earlier.has(r.id));
        const started = await until(() => {
          const r = session();
          return r && r.perf.filter((p) => p.player).length >= 2 ? r : null;
        }, 180_000, "the ruins to start").catch(() => null);
        // The game's ready line (Godot's JSON.stringify sorts keys, so find it by its type, not its first key).
        let ready: { modelsUsed?: number; modelErrors?: Record<string, string>; grassTufts?: number; drawnShadows?: boolean } = {};
        for (const l of session()?.lines ?? []) {
          if (!l.text.startsWith("GSTUDIO {")) continue;
          try {
            const data = JSON.parse(l.text.slice("GSTUDIO ".length)) as { type?: string };
            if (data.type === "ready") {
              ready = data as typeof ready;
              break;
            }
          } catch {
            /* not telemetry */
          }
        }
        let detail = `${build.status}; ${lastLines(build, 2)}`;
        let walked = 0;
        if (frame && started) {
          const box = frame.getBoundingClientRect();
          const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
          const lastZ = () => session()?.perf.filter((p) => p.player).at(-1)?.player?.[2];
          const run = await undisturbed(async () => {
            const from = lastZ();
            // The click may capture the pointer; Esc frees it again after the walk.
            await nativeInput([{ kind: "down", ...centre }, { kind: "up", ...centre }, { kind: "wait", ms: 300 }, { kind: "key", key: "w", code: 13, down: true }, { kind: "wait", ms: 2500 }, { kind: "key", key: "w", code: 13, down: false }, { kind: "wait", ms: 300 }, { kind: "key", key: "\u001b", code: 53, down: true }, { kind: "key", key: "\u001b", code: 53, down: false }]);
            await sleep(1500);
            const to = lastZ();
            return { from, to, walked: from !== undefined && to !== undefined ? from - to : 0 };
          }, (r) => r.walked > 3);
          walked = run.result.walked;
          let picture = "";
          try {
            picture = await snapshot("play-here-ruins");
          } catch (e) {
            picture = `no picture: ${errorMessage(e)}`;
          }
          const p = session()?.perf.at(-1);
          detail = `${ready.modelsUsed ?? "?"} objects drawn from models, model errors ${JSON.stringify(ready.modelErrors ?? null)}; ${ready.grassTufts ?? "?"} tufts of grass, sun shadows drawn by the game: ${ready.drawnShadows ?? "?"}; z ${run.result.from} → ${run.result.to} m; ${Math.round(p?.fps ?? 0)} fps, ${p?.drawCalls ?? 0} draw calls; ${picture}${run.note}`;
          await clickButton("Stop the game").catch(() => undefined);
          await sleep(300);
        }
        check(
          "the 3D adventure plays inside Game Studio with its Kiln models, and holding W walks north",
          build.status === "passed" && Boolean(started) && ready.modelsUsed === 7 && Object.keys(ready.modelErrors ?? { missing: true }).length === 0 && walked > 3,
          detail,
        );
        // The web build's look: the game draws the sun's shadows itself (sun_shadows.gd) and grows the
        // level's grass where the studio's 3D view shows it.
        const ruins = thornwoodRuins();
        const tufts = placeTufts(ruins.size.width, ruins.size.depth, ruins.environment.grass ?? 0, ruins.environment.groundVariation ?? 0, grassKeepOut(ruins)).length;
        check(
          "the 3D adventure in Play here draws the sun's shadows itself and grows its grass where the 3D view shows it",
          Boolean(started) && ready.drawnShadows === true && ready.grassTufts === tufts,
          `sun shadows drawn by the game: ${ready.drawnShadows ?? "no ready message"}; ${ready.grassTufts ?? "?"} tufts of grass, the 3D view places ${tufts}`,
        );
      }
    }

    // The 2D platformer plays inside the studio: Play here builds it, and holding D runs the player right.
    const webReady = engines.find((e) => e.id === "godot")?.capabilities.find((c) => c.id === "play-web")?.status === "available";
    if (godot && webReady) {
      check("creates a 2D platformer project", await store().create("platformer-2d", "Smoke Cliffs", dir));
      await clickButton("Play and run");
      // Only this game's sessions: earlier projects' stopped sessions stay in the list, and the new one
      // starts a moment after the frame appears.
      const earlier = playSessionIds();
      const build = await runFromButton("Play here", "web", 300_000);
      const frame = await until(() => document.querySelector<HTMLIFrameElement>('[data-testid="play-here-frame"]'), 30_000, "the game frame").catch(() => null);
      const session = () => useRuns.getState().runs.find((r) => r.action === "play-here" && !earlier.has(r.id));
      const started = await until(() => {
        const r = session();
        return r && r.perf.filter((p) => p.player).length >= 2 ? r : null;
      }, 120_000, "the platformer to start").catch(() => null);
      let detail = `${build.status}; ${lastLines(build, 2)}`;
      let ran = 0;
      if (frame && started) {
        const box = frame.getBoundingClientRect();
        const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        const lastX = () => session()?.perf.filter((p) => p.player).at(-1)?.player?.[0];
        const run = await undisturbed(async () => {
          const from = lastX();
          await nativeInput([{ kind: "down", ...centre }, { kind: "up", ...centre }, { kind: "wait", ms: 300 }, { kind: "key", key: "d", code: 2, down: true }, { kind: "wait", ms: 1200 }, { kind: "key", key: "d", code: 2, down: false }]);
          await sleep(1200);
          const to = lastX();
          return { from, to, ran: from !== undefined && to !== undefined ? to - from : 0 };
        }, (r) => r.ran > 3);
        ran = run.result.ran;
        let picture = "";
        try {
          picture = await snapshot("play-here-platformer");
        } catch (e) {
          picture = `no picture: ${errorMessage(e)}`;
        }
        const p = session()?.perf.at(-1);
        detail = `x ${run.result.from} → ${run.result.to} tiles; ${Math.round(p?.fps ?? 0)} fps, ${p?.drawCalls ?? 0} draw calls; ${picture}${run.note}`;
        await clickButton("Stop the game").catch(() => undefined);
        await sleep(300);
      }
      check("the 2D platformer plays inside Game Studio and holding D runs the player right", build.status === "passed" && Boolean(started) && ran > 3, detail);

      // A picture tiled over the first ground platform, chosen in the level editor, drawn in the side view
      // and by the game (the platformer's own headless self-test reports it).
      const cliffsRoot = store().root!;
      const bricks = await backend.libraryDownload(cliffsRoot, "textures", "castle_brick_07", "1k", "godot/assets/textures").catch(() => null);
      const brick = bricks?.find((f) => /_diff_/.test(f.path))?.path.replace(/^godot\//, "");
      if (brick) {
        await store().refresh();
        await clickButton("Workspace: rules, world and files");
        Array.from(document.querySelectorAll<HTMLButtonElement>(".tree-item")).find((b) => b.textContent?.includes("ground_1"))?.click();
        const pick = await until(() => document.querySelector<HTMLSelectElement>('select[aria-label="Platform picture"]'), 10_000, "the platform's Picture setting").catch(() => null);
        if (pick) choose(pick, brick);
        const ground = await until(() => ((store().docs["data/level.json"]?.data as { objects?: { id: string; texture?: string }[] } | undefined)?.objects ?? []).find((o) => o.id === "ground_1" && o.texture), 15_000, "the platform's picture").catch(() => undefined);
        const href = await until(() => document.querySelector('pattern[id="pic-ground_1"] image')?.getAttribute("href"), 10_000, "the side view's picture").catch(() => null);
        const shown = href ? await new Promise<number>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img.naturalWidth);
          img.onerror = () => resolve(0);
          img.src = href;
        }) : 0;
        await store().save();
        await clickButton("Play and run");
        const platformerTest = await runFromButton("Self-test", "smoke", 240_000);
        const pictured = (platformerTest.smoke?.observations?.["texturedPlatforms"] as string[] | undefined) ?? [];
        check("a picture tiled over a platform shows in the side view and in the game", Boolean(ground?.texture) && shown > 0 && platformerTest.status === "passed" && Boolean(platformerTest.smoke?.pass) && pictured.includes("ground_1"), `${ground?.texture}; side view picture ${shown} px wide; game: ${platformerTest.status}, textured ${JSON.stringify(pictured)}`);
      } else {
        check("platform picture check skipped: Poly Haven could not be reached", true, "");
      }
      await store().close();
    }

    // Football: the match's own self-test from the Self-test button, then the match playing inside the
    // studio, where holding D runs the footballer you control to the right.
    if (godot) {
      check("creates a football project", await store().create("football", "Smoke Cup", dir));
      await clickButton("Play and run");
      const cup = await runFromButton("Self-test", "smoke", 240_000);
      const o = cup.smoke?.observations ?? {};
      const score = o["score"] as { home?: number; away?: number } | undefined;
      const goals = (o["goals"] as { name?: string }[] | undefined) ?? [];
      const watched = o["watched"] as { homePasses?: number; awayPasses?: number; shots?: number } | undefined;
      check(
        "the football match's self-test passes: your run, shot and pass, a save, the computer chasing, tackling and scoring, full time with the golden goal, and the computer playing both sides",
        cup.status === "passed" && Boolean(cup.smoke?.pass) && score?.home === 1 && score?.away === 1 && goals.every((g) => Boolean(g.name)) && String(o["ended"]).includes("shared") && (watched?.homePasses ?? 0) > 0 && (watched?.awayPasses ?? 0) > 0,
        `${JSON.stringify({ score, scorers: goals.map((g) => g.name), ended: o["ended"], watched })}; ${(cup.smoke?.checks ?? []).filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(" | ") || "all game checks passed"}`,
      );
      if (webReady) {
        // Only this game's sessions: earlier projects' stopped sessions stay in the list, and the new one
        // starts a moment after the frame appears.
        const earlier = playSessionIds();
        const build = await runFromButton("Play here", "web", 300_000);
        const frame = await until(() => document.querySelector<HTMLIFrameElement>('[data-testid="play-here-frame"]'), 30_000, "the game frame").catch(() => null);
        const session = () => useRuns.getState().runs.find((r) => r.action === "play-here" && !earlier.has(r.id));
        const started = await until(() => {
          const r = session();
          return r && r.perf.filter((p) => p.player).length >= 4 ? r : null;
        }, 120_000, "the match to start").catch(() => null);
        let detail = `${build.status}; ${lastLines(build, 2)}`;
        let ran = 0;
        if (frame && started) {
          const box = frame.getBoundingClientRect();
          const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
          const lastX = () => session()?.perf.filter((p) => p.player).at(-1)?.player?.[0];
          const run = await undisturbed(async () => {
            const from = lastX();
            await nativeInput([{ kind: "down", ...centre }, { kind: "up", ...centre }, { kind: "wait", ms: 300 }, { kind: "key", key: "d", code: 2, down: true }, { kind: "wait", ms: 1200 }, { kind: "key", key: "d", code: 2, down: false }]);
            await sleep(1200);
            const to = lastX();
            return { from, to, ran: from !== undefined && to !== undefined ? to - from : 0 };
          }, (r) => r.ran > 2);
          ran = run.result.ran;
          let picture = "";
          try {
            picture = await snapshot("play-here-football");
          } catch (e) {
            picture = `no picture: ${errorMessage(e)}`;
          }
          const p = session()?.perf.at(-1);
          detail = `x ${run.result.from} → ${run.result.to} m; ${Math.round(p?.fps ?? 0)} fps, ${p?.drawCalls ?? 0} draw calls; ${picture}${run.note}`;
          await clickButton("Stop the game").catch(() => undefined);
          await sleep(300);
        }
        check("the football match plays inside Game Studio and holding D runs your footballer right", build.status === "passed" && Boolean(started) && ran > 2, detail);
      }
      await store().close();
    }

    // The farm: its own self-test plays a season from the Self-test button; then the farm plays inside
    // the studio, where holding D walks the farmer right.
    if (godot) {
      check("creates a farm simulation project", await store().create("farm-sim", "Smoke Acres", dir));
      await clickButton("Play and run");
      const season = await runFromButton("Self-test", "smoke", 240_000);
      const o = season.smoke?.observations ?? {};
      const prices = o["prices"] as Record<string, Record<string, number>> | undefined;
      check(
        "the farm's self-test passes: walking, planting, watering, growing, harvesting, selling, rain, sleeping, market day and the end of the season",
        season.status === "passed" && Boolean(season.smoke?.pass) && prices?.["4"]?.["tomato"] === 12 && prices?.["5"]?.["tomato"] === 6 && String(o["ended"]).startsWith("The season is over"),
        `${JSON.stringify({ money: o["money"], day: o["day"], harvested: o["harvested"], tomatoDay4: prices?.["4"]?.["tomato"], ended: o["ended"] })}; ${(season.smoke?.checks ?? []).filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(" | ") || "all game checks passed"}`,
      );
      if (webReady) {
        // Only this game's sessions: earlier projects' stopped sessions stay in the list, and the new one
        // starts a moment after the frame appears.
        const earlier = playSessionIds();
        const build = await runFromButton("Play here", "web", 300_000);
        const frame = await until(() => document.querySelector<HTMLIFrameElement>('[data-testid="play-here-frame"]'), 30_000, "the game frame").catch(() => null);
        const session = () => useRuns.getState().runs.find((r) => r.action === "play-here" && !earlier.has(r.id));
        const started = await until(() => {
          const r = session();
          return r && r.perf.filter((p) => p.player).length >= 2 ? r : null;
        }, 120_000, "the farm to start").catch(() => null);
        let detail = `${build.status}; ${lastLines(build, 2)}`;
        let walked = 0;
        if (frame && started) {
          const box = frame.getBoundingClientRect();
          const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
          const lastX = () => session()?.perf.filter((p) => p.player).at(-1)?.player?.[0];
          const run = await undisturbed(async () => {
            const from = lastX();
            await nativeInput([{ kind: "down", ...centre }, { kind: "up", ...centre }, { kind: "wait", ms: 300 }, { kind: "key", key: "d", code: 2, down: true }, { kind: "wait", ms: 1200 }, { kind: "key", key: "d", code: 2, down: false }]);
            await sleep(1200);
            const to = lastX();
            return { from, to, walked: from !== undefined && to !== undefined ? to - from : 0 };
          }, (r) => r.walked > 2);
          walked = run.result.walked;
          let picture = "";
          try {
            picture = await snapshot("play-here-farm");
          } catch (e) {
            picture = `no picture: ${errorMessage(e)}`;
          }
          const p = session()?.perf.at(-1);
          detail = `x ${run.result.from} → ${run.result.to} tiles; ${Math.round(p?.fps ?? 0)} fps, ${p?.drawCalls ?? 0} draw calls; ${picture}${run.note}`;
          await clickButton("Stop the game").catch(() => undefined);
          await sleep(300);
        }
        check("the farm plays inside Game Studio and holding D walks the farmer right", build.status === "passed" && Boolean(started) && walked > 2, detail);
      }
      await store().close();
    }

    // Unity: create the template project, build it with the real editor, run the built game's self-test.
    await useEnv.getState().refreshEngines();
    const unity = useEnv.getState().engines?.find((e) => e.id === "unity");
    const unityBuild = unity?.capabilities.find((c) => c.id === "build");
    env["unity"] = unity?.installs.map((i) => i.version) ?? null;
    if (unityBuild?.status === "available") {
      check("creates a Unity project", await store().create("exploration-unity", "Smoke Unity", dir));
      const appName = `${exportAppName(store().manifest!.title)}.app`;
      await clickButton("Play and run");
      const unityRun = await runFromButton("Self-test", "smoke", 900_000);
      const built = unityRun.lines.find((l) => l.text.startsWith("GSTUDIO_BUILD "))?.text;
      const finder = await until(() => buttonNamed("Show in Finder"), 5_000, "Show in Finder").catch(() => null);
      const onDisk = (await backend.projectFiles(store().root!)).some((f) => f.path === `exports/unity-macos/${appName}` && f.kind === "dir");
      // The template's rules ran in C#: the gate opened after the third crystal and the shrine won the level.
      const unityRules = unityRun.smoke?.observations?.["won"] === true && JSON.stringify(unityRun.smoke?.observations?.["gatesOpen"]) === '{"gate_main":true}';
      check(
        "the Unity Self-test button builds the app and the built game passes its self-test, rules included",
        unityRun.status === "passed" && Boolean(unityRun.smoke?.pass) && unityRules && Boolean(finder) && onDisk,
        `${built ?? "no build line"} · ${JSON.stringify(unityRun.smoke?.observations ?? lastLines(unityRun, 4))}`,
      );
      // Opt-in: Open in Unity shows the project in the Unity editor's window, on the main scene.
      if (extras.includes("editors")) {
        const opened = await openEditor("Open in Unity", /Game Studio opened Assets\/GameStudio\/Scenes\/Main\.unity/, "Unity", 900_000);
        check("the Open in Unity button opens the project in the Unity editor, on the main scene, and Stop closes it after asking", opened.ok, opened.detail);
      }
      await store().close();
    } else {
      check("Unity check skipped: Unity cannot build here", true, unityBuild?.reason ?? "Unity is not installed");
    }

    // Unreal: create the template project, then the Play view's Self-test button compiles the C++
    // module, packages the app and runs the packaged game headlessly.
    const unreal = useEnv.getState().engines?.find((e) => e.id === "unreal");
    const unrealBuild = unreal?.capabilities.find((c) => c.id === "build");
    env["unreal"] = unreal?.installs.map((i) => i.version) ?? null;
    if (unrealBuild?.status === "available") {
      check("creates an Unreal project", await store().create("exploration-unreal", "Smoke Unreal", dir));
      await clickButton("Play and run");
      const unrealRun = await runFromButton("Self-test", "smoke", 2_400_000);
      const finder = await until(() => buttonNamed("Show in Finder"), 5_000, "Show in Finder").catch(() => null);
      // The template's rules ran in C++: the gate opened after the third crystal and the shrine won the level.
      const unrealRules = unrealRun.smoke?.observations?.["won"] === true && JSON.stringify(unrealRun.smoke?.observations?.["gatesOpen"]) === '{"gate_main":true}';
      check(
        "the Unreal Self-test button compiles, packages and the packaged game passes its self-test, rules included",
        unrealRun.status === "passed" && Boolean(unrealRun.smoke?.pass) && unrealRules && Boolean(finder),
        `${unrealRun.status} · ${JSON.stringify(unrealRun.smoke?.observations ?? lastLines(unrealRun, 4))}`,
      );
      // Opt-in: Open in Unreal compiles the editor module and shows the project in the Unreal editor's window
      // (the first time, Unreal compiles its editor shaders, which can take many minutes).
      if (extras.includes("editors")) {
        const opened = await openEditor("Open in Unreal", null, "UnrealEditor", 2_700_000);
        check("the Open in Unreal button compiles the C++ module, opens the project in the Unreal editor, and Stop closes it after asking", opened.ok, opened.detail);
      }
      await store().close();
    } else {
      check("Unreal check skipped: Unreal cannot build here", true, unrealBuild?.reason ?? "Unreal Engine is not installed");
    }

    // The realistic Unreal template copies Epic's Game Animation Sample in (clones on APFS) and keeps it out of
    // snapshots. Building it (a long first cook) is checked by the Unreal integration test with UNREAL_SAMPLE.
    const sampleCap = unreal?.capabilities.find((c) => c.id === "animation-sample");
    if (sampleCap?.status === "available") {
      const made = await store().create("exploration-unreal-realistic", "Smoke Realistic", dir);
      const realRoot = store().root;
      let ok = false;
      let detail = "the project was not created";
      if (made && realRoot) {
        const listed = store().files.map((f) => f.path);
        const kellan = listed.includes("unreal/Content/MetaHumans/Kellan/BP_Kellan.uasset");
        const ours = listed.includes("unreal/Content/GameStudioData/world.json");
        const game = await backend.projectRead(realRoot, "unreal/Config/DefaultGame.ini");
        const snapshot = await backend.snapshotStatus(realRoot);
        const merged = game.includes("PlayerLook=/Game/MetaHumans/Kellan/BP_Kellan.BP_Kellan_C");
        ok = kellan && ours && merged && snapshot.initialized && !snapshot.dirty;
        detail = `Kellan ${kellan ? "copied" : "missing"}, GameStudioData ${ours ? "kept" : "missing"}, settings ${merged ? "merged" : "not merged"}, snapshot ${snapshot.dirty ? "has uncommitted files" : "clean"}, ${listed.length} files listed`;
      }
      check("the realistic Unreal template copies Epic's Game Animation Sample in, with MetaHuman Kellan as the player, and keeps it out of snapshots", ok, detail);
      await store().close();
    } else {
      check("realistic Unreal check skipped: Epic's Game Animation Sample is not on this Mac", true, sampleCap?.reason ?? "Unreal Engine is not installed");
    }

    // The Engines view, reached from the navigation rail, shows what discovery found.
    await clickButton("Engines");
    const godotCard = await until(() => document.querySelector('[data-testid="engine-godot"]')?.textContent, 20_000, "the Godot engine card");
    const unityCard = document.querySelector('[data-testid="engine-unity"]')?.textContent ?? "";
    const reports = useEnv.getState().engines ?? [];
    const exportReady = reports.find((e) => e.id === "godot")?.capabilities.find((c) => c.id === "export")?.status === "available";
    const unityVersions = reports.find((e) => e.id === "unity")?.installs.map((i) => i.version) ?? [];
    check(
      "the Engines view lists the Godot export templates and the Unity editors that discovery found",
      (!exportReady || godotCard.includes("4.7.2.stable")) && unityVersions.every((v) => unityCard.includes(v)),
      `export ${exportReady ? "ready" : "not installed"} · Unity ${unityVersions.join(", ") || "none"}`,
    );
  } catch (e) {
    check("no unexpected errors", false, errorMessage(e));
  }
  const pass = checks.every((c) => c.ok);
  await backend.smokeFinish({ pass, finishedAt: new Date().toISOString(), environment: env, checks });
}
