import { create } from "zustand";
import { backend, type RunAction, type RunEvent } from "../lib/backend";

export interface PerfSample {
  t: number;
  fps: number;
  processMs: number;
  physicsMs: number;
  nodes: number;
  drawCalls: number;
  memoryMb: number;
  /** Where the player is (x, y, z in metres), when the game reports it. */
  player?: [number, number, number];
  /** Where the camera faces (yaw and pitch in radians), when the game reports it. */
  look?: [number, number];
}

export interface RuleActivity {
  t: number;
  program: string;
  event: string;
  payload: Record<string, unknown>;
  trace: string[];
  logs: string[];
  error: string | null;
}

export interface RunRecord {
  id: string;
  /** "play-here" is a game playing in the Play view's frame: its output comes from the page, not a process. */
  action: RunAction | "play-here";
  label: string;
  startedAt: number;
  steps: { label: string; command: string }[];
  lines: { stream: "stdout" | "stderr" | "studio"; text: string }[];
  perf: PerfSample[];
  rules: RuleActivity[];
  /** Questions players asked villagers who answer with AI, and the answers (3D games playing here). */
  chats: { t: number; npc: string; question: string; answer: string; error: string }[];
  smoke: { pass: boolean; checks?: { name: string; ok: boolean; detail: string }[]; observations?: Record<string, unknown>; [k: string]: unknown } | null;
  status: "running" | "passed" | "failed" | "stopped";
  exit: { code: number | null; failedStep: string | null; durationMs: number } | null;
}

interface RunsStore {
  runs: RunRecord[];
  start: (root: string, action: RunAction, label: string, output?: string) => Promise<string | null>;
  stop: (id: string) => Promise<void>;
  handle: (e: RunEvent) => void;
  /** Starts a run fed from the page (Play here); returns its id. */
  startLocal: (label: string) => string;
  /** Adds a line of output to a run started with startLocal. */
  append: (id: string, stream: "stdout" | "stderr" | "studio", text: string) => void;
  /** Ends a run started with startLocal. */
  finishLocal: (id: string, outcome: "passed" | "failed" | "stopped", note: string) => void;
  clear: () => void;
}

const MAX_LINES = 5000;
/** Terminal colour and style codes (Godot's export log uses them); the console shows plain text. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const plainText = (line: string) => line.replace(ANSI, "");

function parseTelemetry(run: RunRecord, line: string): void {
  if (line.startsWith("GSTUDIO_SMOKE ")) {
    try {
      run.smoke = JSON.parse(line.slice("GSTUDIO_SMOKE ".length));
    } catch {
      /* not JSON: leave as plain output */
    }
    return;
  }
  if (!line.startsWith("GSTUDIO ")) return;
  try {
    const data = JSON.parse(line.slice("GSTUDIO ".length)) as Record<string, unknown>;
    if (data["type"] === "perf") {
      const p = data["player"];
      const player = Array.isArray(p) && p.length === 3 && p.every((v) => typeof v === "number" && Number.isFinite(v)) ? (p as [number, number, number]) : undefined;
      const l = data["look"];
      const look = Array.isArray(l) && l.length === 2 && l.every((v) => typeof v === "number" && Number.isFinite(v)) ? (l as [number, number]) : undefined;
      run.perf.push({ t: Date.now(), fps: Number(data["fps"]) || 0, processMs: Number(data["processMs"]) || 0, physicsMs: Number(data["physicsMs"]) || 0, nodes: Number(data["nodes"]) || 0, drawCalls: Number(data["drawCalls"]) || 0, memoryMb: Number(data["memoryMb"]) || 0, ...(player ? { player } : {}), ...(look ? { look } : {}) });
      if (run.perf.length > 240) run.perf.splice(0, run.perf.length - 240);
    } else if (data["type"] === "chat") {
      run.chats.push({ t: Date.now(), npc: String(data["npc"] ?? ""), question: String(data["question"] ?? ""), answer: String(data["answer"] ?? ""), error: String(data["error"] ?? "") });
      if (run.chats.length > 100) run.chats.splice(0, run.chats.length - 100);
    } else if (data["type"] === "rule") {
      run.rules.push({ t: Date.now(), program: String(data["program"]), event: String(data["event"]), payload: (data["payload"] as Record<string, unknown>) ?? {}, trace: (data["trace"] as string[]) ?? [], logs: (data["logs"] as string[]) ?? [], error: (data["error"] as string | null) ?? null });
      if (run.rules.length > 300) run.rules.splice(0, run.rules.length - 300);
    }
  } catch {
    /* ignore malformed telemetry */
  }
}

export const useRuns = create<RunsStore>((set, get) => ({
  runs: [],
  start: async (root, action, label, output) => {
    try {
      const id = await backend.runStart(root, action, output);
      set((s) => ({ runs: [{ id, action, label, startedAt: Date.now(), steps: [], lines: [], perf: [], rules: [], chats: [], smoke: null, status: "running" as const, exit: null }, ...s.runs].slice(0, 12) }));
      return id;
    } catch (e) {
      const message = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
      set((s) => ({ runs: [{ id: `failed-${Date.now()}`, action, label, startedAt: Date.now(), steps: [], lines: [{ stream: "studio" as const, text: message }], perf: [], rules: [], chats: [], smoke: null, status: "failed" as const, exit: { code: null, failedStep: "Start", durationMs: 0 } }, ...s.runs].slice(0, 12) }));
      return null;
    }
  },
  stop: async (id) => {
    await backend.runStop(id);
  },
  startLocal: (label) => {
    const id = `here-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({ runs: [{ id, action: "play-here" as const, label, startedAt: Date.now(), steps: [], lines: [], perf: [], rules: [], chats: [], smoke: null, status: "running" as const, exit: null }, ...s.runs].slice(0, 12) }));
    return id;
  },
  append: (id, stream, text) => {
    if (stream === "studio") {
      set((s) => ({ runs: s.runs.map((r) => (r.id === id ? { ...r, lines: [...r.lines, { stream, text }].slice(-MAX_LINES) } : r)) }));
      return;
    }
    get().handle({ type: "output", runId: id, stream, line: text });
  },
  finishLocal: (id, outcome, note) => {
    const run = get().runs.find((r) => r.id === id);
    if (!run || run.status !== "running") return;
    const exit = { code: outcome === "passed" ? 0 : outcome === "failed" ? 1 : null, failedStep: outcome === "failed" ? "Game" : null, durationMs: Date.now() - run.startedAt };
    set((s) => ({ runs: s.runs.map((r) => (r.id === id ? { ...r, status: outcome, exit, lines: [...r.lines, { stream: "studio" as const, text: note }] } : r)) }));
  },
  handle: (e) => {
    const run = get().runs.find((r) => r.id === e.runId);
    if (!run) return;
    const next: RunRecord = { ...run, lines: run.lines, perf: run.perf, rules: run.rules, chats: run.chats, steps: run.steps };
    if (e.type === "step") {
      next.steps = [...run.steps, { label: e.label, command: e.command }];
      next.lines = [...run.lines, { stream: "studio", text: `▸ ${e.label}` }];
    } else if (e.type === "output") {
      const line = plainText(e.line);
      next.lines = [...run.lines, { stream: e.stream, text: line }].slice(-MAX_LINES);
      next.perf = [...run.perf];
      next.rules = [...run.rules];
      parseTelemetry(next, line);
    } else {
      next.exit = { code: e.code, failedStep: e.failedStep, durationMs: e.durationMs };
      next.status = e.cancelled ? "stopped" : e.code === 0 ? "passed" : "failed";
      next.lines = [...run.lines, { stream: "studio", text: e.cancelled ? "Stopped." : e.code === 0 ? `Finished in ${(e.durationMs / 1000).toFixed(1)} s.` : `${e.failedStep ?? "Run"} failed with exit code ${e.code ?? "unknown"}.` }];
    }
    set((s) => ({ runs: s.runs.map((r) => (r.id === e.runId ? next : r)) }));
  },
  clear: () => set((s) => ({ runs: s.runs.filter((r) => r.status === "running") })),
}));
