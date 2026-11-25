import { useEffect, useRef, useState } from "react";
import { backend, errorMessage, type PlayWebInfo } from "../../lib/backend";
import { useRuns } from "../../state/runs";
import { useApp } from "../../state/app";
import { Button, Notice } from "../../components/ui";
import { ResetIcon, StopIcon, TrashIcon } from "../../components/icons";
import { applySaveBatch, entriesForFrame, fileCount, parseSaves, serializeSaves, type SaveSet } from "./saves";
import { parseWorld } from "@gamestudio/explore";
import { useProject } from "../../state/project";
import { useEnv } from "../../state/env";
import { aiVillager, chatPrompt, ChatLimiter, cleanAnswer, readChatRequest } from "./npcChat";

/** What the Play here page (src-tauri/assets/play-shell.html) tells the Play view. */
type FrameMessage =
  | { type: "print" | "printError"; text: unknown }
  | { type: "progress"; current: unknown; total: unknown }
  | { type: "started" }
  | { type: "error"; message: unknown }
  | { type: "exit"; code: unknown }
  | { type: "saves-request" }
  | { type: "pointer"; captured: unknown }
  | { type: "saves-write"; puts: unknown; deletes: unknown }
  | { type: "npc-chat"; request: unknown };

/** The answer's shape asked of the model (every provider supports a small JSON schema). */
const ANSWER_SCHEMA = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string", description: "What the character says: one to three short sentences." } } };

/**
 * Answers a villager question from the game frame: the persona comes from the project's own world
 * layout, the provider and model from Settings (the assistant's default), and only the answer goes back.
 */
async function answerVillager(request: unknown, limiter: ChatLimiter): Promise<{ id: number | null; text?: string; error?: string; note: string }> {
  const r = readChatRequest(request);
  const rawId = request && typeof request === "object" ? Number((request as { id?: unknown }).id) : NaN;
  if (!r.ok) return { id: Number.isInteger(rawId) ? rawId : null, error: `Game Studio refused the question (${r.error}).`, note: `A villager question was refused: ${r.error}.` };
  const q = r.request;
  const project = useProject.getState();
  const worldPath = project.manifest?.data.find((d) => d.kind === "explore-world")?.path;
  const doc = worldPath ? project.docs[worldPath] : undefined;
  const parsed = doc && !doc.error ? parseWorld(doc.data) : null;
  const villager = aiVillager(parsed?.ok ? parsed.world : null, q.npcId);
  if (!villager) return { id: q.id, error: "this villager has no AI persona in the project", note: `${q.npcId} was asked a question but has no AI persona in the world layout.` };
  if (!limiter.allow(Date.now())) return { id: q.id, error: "too many questions at once; wait a moment", note: "A villager question was held back: one at a time, at most 12 a minute." };
  const settings = useApp.getState().settings;
  const usable = (useEnv.getState().providers ?? []).filter((p) => p.allowed && p.available);
  const provider = usable.find((p) => p.id === settings["ai.defaultProvider"]) ?? usable.find((p) => p.kind === "local" || p.kind === "test") ?? usable[0];
  if (!provider) return { id: q.id, error: "no AI provider is set up in Game Studio (Settings, AI providers)", note: `${villager.name} could not answer: no AI provider is set up (Settings, AI providers).` };
  const saved = settings["ai.defaultModel"];
  const options = [...provider.suggestedModels, ...provider.models];
  const model = typeof saved === "string" && options.includes(saved) ? saved : provider.models.find((m) => m.startsWith("qwen3")) ?? options[0] ?? "";
  const prompt = chatPrompt(project.manifest?.title ?? "this game", villager, q);
  limiter.busy = true;
  try {
    const result = await backend.aiGenerate({ provider: provider.id, model, system: prompt.system, messages: prompt.messages, schema: ANSWER_SCHEMA, schemaName: "villager_answer", maxTokens: 400 }, project.root);
    let answer = "";
    try {
      answer = String((JSON.parse(result.text) as { answer?: unknown }).answer ?? "");
    } catch {
      answer = result.text;
    }
    const text = cleanAnswer(answer);
    if (!text) return { id: q.id, error: "the AI gave no answer", note: `${villager.name}'s answer from ${provider.label} was empty.` };
    return { id: q.id, text, note: `${villager.name} answered with ${provider.label} (${result.model}) in ${(result.durationMs / 1000).toFixed(1)} s.` };
  } catch (err) {
    return { id: q.id, error: "the AI could not be reached just now", note: `${villager.name} could not answer: ${errorMessage(err)}` };
  } finally {
    limiter.busy = false;
  }
}

/**
 * Play here: the game's web build in a sandboxed frame. The frame may run scripts and lock the pointer,
 * nothing else: its origin is opaque, so it cannot reach Game Studio's page, storage or commands. Its
 * output goes into a run of its own, so the console, performance and rule panels work as they do for a
 * game in a Godot window. Its saves (user:// files) come here too and are kept on disk for the project
 * (see saves.ts), so they survive Stop and Restart.
 */
export function WebGame({ root, game, hint, onClose }: { root: string; game: PlayWebInfo; hint?: string; onClose: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<"loading" | "running" | "ended">("loading");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** WebKit sometimes fails to compile a shader when the computer is very busy; the game may then show nothing. */
  const [shaderTrouble, setShaderTrouble] = useState(false);
  const [saveFiles, setSaveFiles] = useState<number | null>(null);
  const [captured, setCaptured] = useState(false);
  const openDialog = useApp((s) => s.openDialog);
  const toast = useApp((s) => s.toast);
  const mb = (game.bytes / 1048576).toFixed(0);
  // The game's saves: read when its page asks, changed by each batch it sends, written shortly after.
  const saves = useRef<SaveSet>(new Map());
  const keepSaves = useRef(false);
  const pendingWrite = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writing = useRef<Promise<void>>(Promise.resolve());

  const writeSaves = (report: (message: string) => void) => {
    if (pendingWrite.current) clearTimeout(pendingWrite.current);
    pendingWrite.current = null;
    const text = serializeSaves(saves.current);
    writing.current = writing.current.then(() =>
      backend.playSavesWrite(root, text).then(
        () => undefined,
        (e) => report(errorMessage(e)),
      ),
    );
  };

  const clearSaves = () =>
    openDialog({
      kind: "confirm",
      danger: true,
      title: "Delete this game's saves?",
      body: "Play here forgets everything this game saved here, and the game starts again from the beginning. Saves made while playing in Godot or in an exported build stay as they are.",
      confirmLabel: "Delete saves",
      onConfirm: async () => {
        keepSaves.current = false;
        if (pendingWrite.current) clearTimeout(pendingWrite.current);
        pendingWrite.current = null;
        await writing.current;
        try {
          await backend.playSavesClear(root);
        } catch (e) {
          toast("error", "Saves not deleted", errorMessage(e));
          return;
        }
        saves.current = new Map();
        setSaveFiles(0);
        setAttempt((a) => a + 1);
      },
    });

  const focusGame = () => {
    frame.current?.focus();
    frame.current?.contentWindow?.postMessage({ type: "focus" }, "*");
  };

  useEffect(() => {
    const { startLocal, append, finishLocal } = useRuns.getState();
    // The run starts with the frame's first message, so a mount that never loads leaves no empty run.
    let run: string | null = null;
    const ensureRun = () => {
      if (!run) {
        run = startLocal(attempt ? "Playing here (restarted)" : "Playing here");
        append(run, "studio", `▸ ${game.page} in Game Studio (${mb} MB)`);
      }
      return run;
    };
    setPhase("loading");
    setProgress(0);
    setError(null);
    setShaderTrouble(false);
    setCaptured(false);
    let toldAboutMouse = false;
    const replySaves = (entries: ReturnType<typeof entriesForFrame>) => frame.current?.contentWindow?.postMessage({ type: "saves", entries }, "*");
    const limiter = new ChatLimiter();
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as ({ source?: unknown } & FrameMessage) | null;
      if (!d || typeof d !== "object" || d.source !== "gamestudio-play") return;
      const id = ensureRun();
      switch (d.type) {
        case "pointer":
          setCaptured(d.captured === true);
          if (d.captured === true && !toldAboutMouse) {
            toldAboutMouse = true;
            append(id, "studio", "The game has the mouse pointer: move the mouse to look around, press Esc to get it back.");
          }
          break;
        case "saves-request":
          keepSaves.current = false;
          backend
            .playSavesRead(root)
            .then((text) => {
              saves.current = parseSaves(text);
              keepSaves.current = true;
              setSaveFiles(fileCount(saves.current));
              replySaves(entriesForFrame(saves.current));
            })
            .catch((err) => {
              saves.current = new Map();
              setSaveFiles(null);
              append(id, "stderr", `${errorMessage(err)} The game starts without them, and what it saves now lasts until it stops.`);
              replySaves([]);
            });
          break;
        case "saves-write": {
          if (!keepSaves.current) break;
          const problem = applySaveBatch(saves.current, d);
          if (problem) {
            append(id, "stderr", `Game Studio did not keep a save: ${problem}.`);
            break;
          }
          setSaveFiles(fileCount(saves.current));
          if (pendingWrite.current) clearTimeout(pendingWrite.current);
          pendingWrite.current = setTimeout(() => writeSaves((m) => append(id, "stderr", m)), 250);
          break;
        }
        case "npc-chat": {
          const target = frame.current.contentWindow;
          void answerVillager(d.request, limiter).then((a) => {
            append(id, a.error ? "stderr" : "studio", a.note);
            if (a.id !== null) target?.postMessage({ type: "npc-chat-reply", id: a.id, ...(a.text ? { text: a.text } : { error: a.error }) }, "*");
          });
          break;
        }
        case "print":
          append(id, "stdout", String(d.text));
          break;
        case "printError":
          append(id, "stderr", String(d.text));
          if (/shader compilation failed|Program linking failed/i.test(String(d.text))) setShaderTrouble(true);
          break;
        case "progress": {
          const current = Number(d.current);
          const total = Number(d.total);
          if (total > 0) setProgress(Math.min(1, current / total));
          break;
        }
        case "started":
          setPhase("running");
          append(id, "studio", "The game started. Click it to play; Esc frees the mouse.");
          focusGame();
          break;
        case "error":
          setError(String(d.message));
          append(id, "stderr", String(d.message));
          finishLocal(id, "failed", "The game could not start.");
          break;
        case "exit":
          setPhase("ended");
          finishLocal(id, Number(d.code) === 0 ? "passed" : "failed", `The game quit with code ${String(d.code)}.`);
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      // Stop or Restart right after the game saved: keep that save.
      if (pendingWrite.current && keepSaves.current) writeSaves((m) => toast("error", "The game's last save was not kept", m));
      keepSaves.current = false;
      if (run) finishLocal(run, "stopped", "Stopped.");
    };
    // A new address or a restart is a new session.
  }, [game.url, game.page, mb, attempt, root]); // eslint-disable-line react-hooks/exhaustive-deps

  const status = error ? "Could not start" : phase === "loading" ? `Loading ${Math.round(progress * 100)}%` : phase === "running" ? (captured ? "Playing here · mouse captured, Esc frees it" : "Playing here") : "The game quit";
  return (
    <div className="play-stage" data-mouse={captured ? "captured" : "free"}>
      <div className="play-stage__bar">
        <span className={`dot ${error ? "dot--error" : phase === "running" ? "dot--ok" : "dot--busy"}`} />
        <span className="small">{status}</span>
        <span className="xsmall muted truncate">
          {hint ? `${hint} · ` : ""}
          {mb} MB web build · {saveFiles === null ? "saves not loaded" : saveFiles === 0 ? "no saves yet" : `${saveFiles} saved file${saveFiles === 1 ? "" : "s"} kept`}
        </span>
        <span className="spacer" />
        <Button
          size="small"
          icon={<TrashIcon />}
          disabled={!saveFiles}
          tip={saveFiles ? "Delete what this game saved here and start it again from the beginning" : "This game has not saved anything here yet"}
          onClick={clearSaves}
        >
          Clear saves
        </Button>
        <Button size="small" icon={<ResetIcon />} tip="Start this build again from the beginning. Play here builds your latest changes." onClick={() => setAttempt((a) => a + 1)}>Restart</Button>
        <Button size="small" variant="danger" icon={<StopIcon />} aria-label="Stop the game" tip="Close the game" onClick={onClose}>Stop</Button>
      </div>
      <div className="play-stage__screen">
        <iframe
          key={attempt}
          ref={frame}
          className="play-stage__frame"
          data-testid="play-here-frame"
          title="The game, playing inside Game Studio"
          src={game.url}
          sandbox="allow-scripts allow-pointer-lock"
          allow="autoplay; gamepad; fullscreen"
        />
        {shaderTrouble && !error && (
          <div className="play-stage__over" style={{ pointerEvents: "none", alignItems: "flex-start" }}>
            <Notice kind="warn">The web view could not compile some of the game's shaders. This happens when the computer is very busy (for example during an engine build). If parts of the game are missing or the picture stays still, press Restart.</Notice>
          </div>
        )}
        {error && (
          <div className="play-stage__over">
            <Notice kind="error">{error}</Notice>
          </div>
        )}
      </div>
    </div>
  );
}
