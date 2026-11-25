import type { Backend, EngineReport, FileEntry, NewFile, OpenedProject, ProviderStatus, RecentProject, Settings, Snapshot, AuditEntry, GenerateRequest, GenerateResult, StreamEvent } from "./types";
import { scriptedProposal } from "./scripted-provider";

/**
 * Browser preview backend: projects live in memory and in this browser's local storage.
 * Used for UI development and automated UI tests. Engines, real files and native dialogs
 * are unavailable here and the interface says so.
 */
const STORE_KEY = "gamestudio.preview.v1";
const PREVIEW_ROOT = "/Browser Preview/Projects";

interface Store {
  settings: Settings;
  recents: RecentProject[];
  projects: Record<string, { files: Record<string, string>; snapshots: { id: string; message: string; at: string; files: Record<string, string> }[] }>;
  audit: AuditEntry[];
}

function load(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw) as Store;
  } catch {
    /* storage unavailable: start empty */
  }
  return { settings: {}, recents: [], projects: {}, audit: [] };
}

function err(code: string, message: string): never {
  throw { code, message };
}

export function createBrowserBackend(): Backend {
  const store = load();
  const persist = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch {
      /* quota or private mode: keep working in memory */
    }
  };
  const project = (root: string) => store.projects[root] ?? err("denied", "That project is not open");
  const now = () => new Date().toISOString();
  const listFiles = (root: string): FileEntry[] => {
    const files = Object.keys(project(root).files).sort();
    const dirs = new Set<string>();
    for (const f of files) {
      const parts = f.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    return [...[...dirs].map((d) => ({ path: d, kind: "dir" as const, size: 0, modified: null })), ...files.map((f) => ({ path: f, kind: "file" as const, size: project(root).files[f]!.length, modified: null }))].sort((a, b) => a.path.localeCompare(b.path));
  };
  const status = (root: string) => {
    const p = project(root);
    const head = p.snapshots[p.snapshots.length - 1];
    const dirty = head ? JSON.stringify(head.files) !== JSON.stringify(p.files) : true;
    return { gitAvailable: true, initialized: true, dirty, head: head ? { id: head.id, shortId: head.id.slice(0, 8), message: head.message, at: head.at } : null };
  };
  const snapshot = (root: string, message: string): Snapshot | null => {
    const p = project(root);
    if (!status(root).dirty) return null;
    const id = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");
    p.snapshots.push({ id, message, at: now(), files: structuredClone(p.files) });
    persist();
    return { id, shortId: id.slice(0, 8), message, at: now() };
  };
  const opened = (root: string): OpenedProject => {
    const manifest = project(root).files["gamestudio.json"] ?? err("not-found", "No gamestudio.json");
    const m = JSON.parse(manifest) as { title?: string; template?: { id?: string }; engine?: { id?: string } };
    store.recents = [{ path: root, title: m.title ?? "Untitled", template: m.template?.id ?? "", engine: m.engine?.id ?? "", openedAt: now(), exists: true }, ...store.recents.filter((r) => r.path !== root)].slice(0, 30);
    persist();
    return { root, manifest, files: listFiles(root), snapshots: status(root) };
  };
  const engines: EngineReport[] = (["godot", "unity", "unreal", "cpp"] as const).map((id) => ({
    id,
    name: { godot: "Godot", unity: "Unity", unreal: "Unreal Engine", cpp: "C++ / SFML / OpenGL" }[id],
    summary: "Engine detection needs the desktop app.",
    installs: [],
    tools: [],
    capabilities: [{ id: "detect", label: "Detect installed versions", status: "unavailable", reason: "Browser preview cannot inspect this computer." }],
    officialUrl: "",
    notes: ["You are using the browser preview. Run the desktop app to detect and run engines."],
  }));
  const streams = new Map<string, number>();
  const streamListeners = new Set<(e: StreamEvent) => void>();
  const testProvider: ProviderStatus = { id: "scripted", label: "Scripted test provider (preview only)", kind: "test", endpoint: "in-browser", available: true, credential: null, models: ["scripted-1"], suggestedModels: [], allowed: true, note: "Deterministic answers for interface tests. Not an AI model.", docs: "" };

  return {
    kind: "browser",
    appInfo: async () => ({ version: "0.1.0", dataDir: "browser local storage", platform: "browser", arch: "", gitAvailable: true, devBuild: true, smokeDir: null, smokeExtras: [], defaultProjectsDir: PREVIEW_ROOT }),
    settingsGet: async () => ({ ...store.settings }),
    settingsSet: async (key, value) => {
      if (/(api.?key|secret|token|password)/i.test(key)) err("denied", "Credentials are never stored in settings.");
      if (value === null) delete store.settings[key];
      else store.settings[key] = value;
      persist();
      return { ...store.settings };
    },
    pickDirectory: async () => PREVIEW_ROOT,
    pickFiles: async () => [],
    openExternal: async (url) => {
      window.open(url, "_blank", "noopener");
    },
    revealPath: async () => err("browser", "Revealing files needs the desktop app."),
    recentsList: async () => store.recents.map((r) => ({ ...r, exists: Boolean(store.projects[r.path]) })),
    recentsForget: async (path) => {
      store.recents = store.recents.filter((r) => r.path !== path);
      persist();
    },
    projectCreate: async (parent, folder, files: NewFile[], message) => {
      const root = `${parent}/${folder}`;
      if (store.projects[root]) err("conflict", `A folder named '${folder}' already exists there`);
      store.projects[root] = { files: Object.fromEntries(files.map((f) => [f.path, f.content])), snapshots: [] };
      snapshot(root, message);
      return opened(root);
    },
    projectOpen: async (path) => opened(path),
    projectClose: async () => {},
    projectFiles: async (root) => listFiles(root),
    projectRead: async (root, path) => project(root).files[path] ?? err("not-found", `${path} does not exist`),
    projectWrite: async (root, files) => {
      const p = project(root);
      for (const f of files) p.files[f.path] = f.content;
      persist();
    },
    projectTrash: async (root, path) => {
      const p = project(root);
      const moved = `.gamestudio/trash/${now()}/${path}`;
      for (const key of Object.keys(p.files)) if (key === path || key.startsWith(`${path}/`)) delete p.files[key];
      persist();
      return moved;
    },
    projectImport: async () => err("browser", "Importing files needs the desktop app."),
    libraryList: async () => err("browser", "The free library needs the desktop app."),
    libraryCharacters: async () => err("browser", "The free library needs the desktop app."),
    librarySounds: async () => err("browser", "The free library needs the desktop app."),
    libraryThumbnail: async () => err("browser", "The free library needs the desktop app."),
    libraryDownload: async () => err("browser", "The free library needs the desktop app."),
    pageFetch: async () => err("browser", "Reading links needs the desktop app."),
    unrealSampleFiles: async () => err("browser", "Unreal projects need the desktop app."),
    unrealSampleAdd: async () => err("browser", "Unreal projects need the desktop app."),
    snapshotStatus: async (root) => status(root),
    snapshotList: async (root, limit) =>
      project(root)
        .snapshots.slice()
        .reverse()
        .slice(0, limit)
        .map((s) => ({ id: s.id, shortId: s.id.slice(0, 8), message: s.message, at: s.at })),
    snapshotCreate: async (root, message) => snapshot(root, message),
    snapshotRestore: async (root, id) => {
      const p = project(root);
      const target = p.snapshots.find((s) => s.id === id) ?? err("not-found", "Unknown snapshot");
      snapshot(root, `Before restoring snapshot ${id.slice(0, 8)}`);
      p.files = structuredClone(target.files);
      return snapshot(root, `Restored snapshot ${id.slice(0, 8)}: ${target.message}`) ?? { id, shortId: id.slice(0, 8), message: target.message, at: target.at };
    },
    enginesDiscover: async () => engines,
    engineInstallGodot: async () => err("browser", "Installing engines needs the desktop app."),
    engineInstallGodotTemplates: async () => err("browser", "Installing export templates needs the desktop app."),
    engineOpenTool: async () => err("browser", "Opening applications needs the desktop app."),
    runStart: async () => err("browser", "Running engines needs the desktop app."),
    runStop: async () => false,
    playWebOpen: async () => err("browser", "Play here needs the desktop app: it builds the game with Godot."),
    playSavesRead: async () => null,
    playSavesWrite: async () => err("browser", "Play here needs the desktop app."),
    playSavesClear: async () => undefined,
    aiProviders: async () => [testProvider],
    aiGenerate: async (request: GenerateRequest): Promise<GenerateResult> => {
      if (request.provider !== "scripted") err("browser", "Only the scripted test provider is available in the browser preview.");
      const text = JSON.stringify(scriptedProposal(request));
      return { provider: "scripted", model: "scripted-1", text, inputTokens: null, outputTokens: null, servedBy: "scripted-1", notes: ["Scripted test answer: not produced by an AI model."], durationMs: 5 };
    },
    // The scripted provider streams its answer in small pieces, so the chat can be tested in the preview.
    aiStreamStart: async (streamId: string, request: GenerateRequest) => {
      if (request.provider !== "scripted") err("browser", "Only the scripted test provider is available in the browser preview.");
      const text = JSON.stringify(scriptedProposal(request));
      const pieces = text.match(/[\s\S]{1,14}/g) ?? [];
      // "slowly" in the message slows the scripted stream so tests can press Stop mid-reply.
      const delay = /slowly/i.test(request.messages.at(-1)?.content ?? "") ? 400 : 25;
      const emit = (e: StreamEvent) => streamListeners.forEach((l) => l(e));
      let i = 0;
      const tick = () => {
        if (!streams.has(streamId)) return;
        if (i < pieces.length) {
          emit({ streamId, kind: "delta", text: pieces[i++]! });
          streams.set(streamId, window.setTimeout(tick, delay));
        } else {
          streams.delete(streamId);
          emit({ streamId, kind: "done", result: { provider: "scripted", model: "scripted-1", text, inputTokens: null, outputTokens: null, servedBy: "scripted-1", notes: ["Scripted test answer: not produced by an AI model."], durationMs: 25 * pieces.length } });
        }
      };
      streams.set(streamId, window.setTimeout(tick, delay));
    },
    aiStreamStop: async (streamId: string) => {
      const timer = streams.get(streamId);
      if (timer === undefined) return false;
      window.clearTimeout(timer);
      streams.delete(streamId);
      streamListeners.forEach((l) => l({ streamId, kind: "error", message: "Stopped." }));
      return true;
    },
    listenAiStream: async (cb: (e: StreamEvent) => void) => {
      streamListeners.add(cb);
      return () => void streamListeners.delete(cb);
    },
    auditAppend: async (projectRoot, actor, action, detail) => {
      const id = store.audit.length + 1;
      store.audit.push({ id, at: now(), project: projectRoot, actor, action, detail });
      persist();
      return id;
    },
    auditList: async (projectRoot, limit) => store.audit.filter((a) => !projectRoot || a.project === projectRoot).slice(-limit).reverse(),
    smokeFinish: async () => {},
    onRunEvent: () => () => {},
    onInstallProgress: () => () => {},
    onFilesDropped: () => () => {},
    assetUrl: () => null,
  };
}
