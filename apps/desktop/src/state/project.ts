import { create } from "zustand";
import { engineDataDir, generateProject, MANIFEST_FILE, parseManifest, planEngineSync, folderNameFor, templateById, touch, UNREAL_DIR, type ProjectManifest, type SyncProblem } from "@gamestudio/project";
import type { ProjectDocs } from "@gamestudio/agents";
import { backend, errorMessage, type FileEntry, type NewFile, type SnapshotStatus } from "../lib/backend";
import { registry } from "../lib/registry";
import { useApp } from "./app";
import { unityInstall, unrealInstall, useEnv } from "./env";

export type DocKind = "manifest" | "rules" | "world" | "level" | "match" | "farm" | "creatures" | "lesson" | "scene" | "markdown" | "code" | "image" | "cpp-settings" | "binary";

export interface Doc {
  path: string;
  kind: DocKind;
  /** Parsed JSON for structured documents; the text itself for text documents. */
  data: unknown;
  dirty: boolean;
  error: string | null;
  version: number;
}

const TEXT_EXT = /\.(gd|cs|json|cfg|ini|uproject|txt|godot|tres|tscn|cpp|hpp|h|cc|cmake|md|gitignore|gitattributes|svg|import)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

export function kindFor(path: string, manifest: ProjectManifest | null): DocKind {
  if (path === MANIFEST_FILE) return "manifest";
  if (manifest?.rules.some((r) => r.path === path)) return "rules";
  const data = manifest?.data.find((d) => d.path === path);
  if (data?.kind === "explore-world") return "world";
  if (data?.kind === "platformer-level") return "level";
  if (data?.kind === "football-match") return "match";
  if (data?.kind === "farm-sim") return "farm";
  if (data?.kind === "creature-catalog") return "creatures";
  if (data?.kind === "lesson") return "lesson";
  if (manifest?.engine.id === "cpp-sfml" && path === `${manifest.engine.projectDir}/game.cfg`) return "cpp-settings";
  if (path.endsWith(".tscn")) return "scene";
  if (path.endsWith(".md")) return "markdown";
  if (IMAGE_EXT.test(path)) return "image";
  if (TEXT_EXT.test(path) || /(^|\/)(CMakeLists\.txt|README|LICENSE)$/.test(path)) return "code";
  return "binary";
}

const STRUCTURED: DocKind[] = ["manifest", "rules", "world", "level", "match", "farm", "creatures", "lesson"];

export function serialize(doc: Doc): string {
  return STRUCTURED.includes(doc.kind) && doc.error === null ? JSON.stringify(doc.data, null, 2) + "\n" : String(doc.data ?? "");
}

interface ProjectStore {
  root: string | null;
  manifest: ProjectManifest | null;
  files: FileEntry[];
  snapshot: SnapshotStatus | null;
  docs: Record<string, Doc>;
  tabs: string[];
  activeTab: string | null;
  busy: null | "opening" | "creating" | "saving" | "restoring" | "applying";
  syncProblems: SyncProblem[];
  lastSavedAt: string | null;
  open: (path: string) => Promise<boolean>;
  create: (templateId: string, title: string, parent: string) => Promise<boolean>;
  close: () => Promise<void>;
  loadDoc: (path: string) => Promise<Doc | null>;
  updateDoc: (path: string, data: unknown) => void;
  openTab: (path: string) => Promise<void>;
  closeTab: (path: string) => void;
  setActive: (path: string) => void;
  save: () => Promise<boolean>;
  /** Write files outside the editors (for example export settings) and refresh any open copies. */
  writeFiles: (files: { path: string; content: string }[]) => Promise<boolean>;
  refresh: () => Promise<void>;
  takeSnapshot: (message: string) => Promise<boolean>;
  restoreSnapshot: (id: string) => Promise<boolean>;
  collectDocs: () => Promise<ProjectDocs | null>;
  applyAgentChanges: (docs: ProjectDocs, touched: string[], label: string) => Promise<boolean>;
}

const toast = (...args: Parameters<ReturnType<typeof useApp.getState>["toast"]>) => useApp.getState().toast(...args);

function parseDoc(path: string, kind: DocKind, text: string, version: number): Doc {
  if (STRUCTURED.includes(kind)) {
    try {
      return { path, kind, data: JSON.parse(text), dirty: false, error: null, version };
    } catch (e) {
      return { path, kind: "code", data: text, dirty: false, error: `Not valid JSON: ${errorMessage(e)}`, version };
    }
  }
  return { path, kind, data: text, dirty: false, error: null, version };
}

export const useProject = create<ProjectStore>((set, get) => {
  async function adopt(opened: { root: string; manifest: string; files: FileEntry[]; snapshots: SnapshotStatus }): Promise<boolean> {
    let parsed;
    try {
      parsed = parseManifest(JSON.parse(opened.manifest));
    } catch (e) {
      toast("error", "Cannot open project", `gamestudio.json is not valid JSON: ${errorMessage(e)}`);
      return false;
    }
    if (!parsed.ok) {
      toast("error", "Cannot open project", parsed.errors.join("; "));
      return false;
    }
    const manifest = parsed.manifest;
    // Open what a Creator edits first: the world map for 3D projects, otherwise the rules.
    const first = manifest.data.find((d) => d.kind === "explore-world" || d.kind === "platformer-level" || d.kind === "football-match" || d.kind === "farm-sim")?.path ?? manifest.rules[0]?.path ?? manifest.data[0]?.path ?? (manifest.engine.id === "cpp-sfml" ? `${manifest.engine.projectDir}/game.cfg` : "README.md");
    set({ root: opened.root, manifest, files: opened.files, snapshot: opened.snapshots, docs: { [MANIFEST_FILE]: { path: MANIFEST_FILE, kind: "manifest", data: manifest, dirty: false, error: null, version: 0 } }, tabs: [], activeTab: null, syncProblems: [], lastSavedAt: null });
    await get().openTab(first);
    // Rule graphs are small; loading them now gives the outline their real names and the Problems panel their diagnostics.
    await Promise.all(manifest.rules.map((r) => get().loadDoc(r.path)));
    // Stay on the project screen the user was heading to (for example the assistant); otherwise open
    // what this kind of project starts with.
    const current = useApp.getState().route;
    const keep = ["workspace", "play", "assets", "assistant"].includes(current);
    useApp.getState().setRoute(keep ? current : manifest.engine.id === "studio-board" && ["oware-abapa", "oware-namnam", "ayo", "ludo"].includes(manifest.template.id) ? "play" : "workspace");
    return true;
  }

  async function syncEngine(manifest: ProjectManifest, root: string): Promise<SyncProblem[]> {
    if (!engineDataDir(manifest)) return [];
    const documents: Record<string, unknown> = {};
    for (const p of [...manifest.rules.map((r) => r.path), ...manifest.data.map((d) => d.path)]) {
      const doc = await get().loadDoc(p);
      if (doc && !doc.error) documents[p] = doc.data;
    }
    const plan = planEngineSync(manifest, documents, registry);
    if (plan.writes.length > 0) await backend.projectWrite(root, plan.writes);
    set({ syncProblems: plan.problems });
    return plan.problems;
  }

  return {
    root: null,
    manifest: null,
    files: [],
    snapshot: null,
    docs: {},
    tabs: [],
    activeTab: null,
    busy: null,
    syncProblems: [],
    lastSavedAt: null,

    open: async (path) => {
      if (get().root && !(await get().save())) return false;
      set({ busy: "opening" });
      try {
        return await adopt(await backend.projectOpen(path));
      } catch (e) {
        toast("error", "Cannot open project", errorMessage(e));
        return false;
      } finally {
        set({ busy: null });
      }
    },

    create: async (templateId, title, parent) => {
      set({ busy: "creating" });
      try {
        // Unity projects pin the installed editor version, so opening them never triggers an upgrade.
        const engine = templateById(templateId)?.engine;
        const engines = useEnv.getState().engines;
        const engineVersion = engine === "unity" ? unityInstall(engines)?.version : engine === "unreal" ? unrealInstall(engines)?.version : undefined;
        // The realistic Unreal template builds on Epic's Game Animation Sample on this computer.
        const unrealSample = templateId === "exploration-unreal-realistic" ? await backend.unrealSampleFiles() : undefined;
        const generated = generateProject(templateId, { title, engineVersion, unrealSample });
        const opened = await backend.projectCreate(parent, folderNameFor(title), generated.files as NewFile[], `Created from the ${templateId} template`);
        let sampleProblem: string | null = null;
        if (unrealSample) {
          try {
            await backend.unrealSampleAdd(opened.root, UNREAL_DIR);
          } catch (e) {
            sampleProblem = errorMessage(e);
          }
        }
        // The copied content belongs in the file list the project opens with.
        const ok = await adopt(unrealSample && !sampleProblem ? { ...opened, files: await backend.projectFiles(opened.root) } : opened);
        if (ok && sampleProblem) toast("error", "Project created without Epic's sample", `Its content could not be copied (${sampleProblem}). The game cannot be built until it is; delete this project and create it again.`);
        else if (ok) toast("success", "Project created", opened.root);
        return ok;
      } catch (e) {
        toast("error", "Project not created", errorMessage(e));
        return false;
      } finally {
        set({ busy: null });
      }
    },

    close: async () => {
      const { root } = get();
      if (root) await backend.projectClose(root).catch(() => {});
      set({ root: null, manifest: null, files: [], snapshot: null, docs: {}, tabs: [], activeTab: null, syncProblems: [] });
      useApp.getState().setRoute("home");
    },

    loadDoc: async (path) => {
      const { root, manifest, docs } = get();
      if (!root) return null;
      if (docs[path]) return docs[path]!;
      const kind = kindFor(path, manifest);
      if (kind === "image" || kind === "binary") {
        const doc: Doc = { path, kind, data: null, dirty: false, error: null, version: 0 };
        set((s) => ({ docs: { ...s.docs, [path]: doc } }));
        return doc;
      }
      try {
        const doc = parseDoc(path, kind, await backend.projectRead(root, path), 0);
        set((s) => ({ docs: { ...s.docs, [path]: doc } }));
        return doc;
      } catch (e) {
        toast("error", `Cannot open ${path}`, errorMessage(e));
        return null;
      }
    },

    updateDoc: (path, data) => {
      set((s) => {
        const doc = s.docs[path];
        if (!doc) return s;
        const docs = { ...s.docs, [path]: { ...doc, data, dirty: true, version: doc.version + 1 } };
        return path === MANIFEST_FILE && doc.kind === "manifest" ? { docs, manifest: data as ProjectManifest } : { docs };
      });
      useApp.getState().markStep("changed");
    },

    openTab: async (path) => {
      const doc = await get().loadDoc(path);
      if (!doc) return;
      set((s) => ({ tabs: s.tabs.includes(path) ? s.tabs : [...s.tabs, path], activeTab: path }));
    },

    closeTab: (path) =>
      set((s) => {
        const tabs = s.tabs.filter((t) => t !== path);
        const i = s.tabs.indexOf(path);
        return { tabs, activeTab: s.activeTab === path ? (tabs[Math.max(0, i - 1)] ?? null) : s.activeTab };
      }),

    setActive: (path) => set({ activeTab: path }),

    save: async () => {
      const { root, docs } = get();
      let { manifest } = get();
      if (!root || !manifest) return true;
      const dirty = Object.values(docs).filter((d) => d.dirty);
      if (dirty.length === 0) return true;
      const manifestDoc = docs[MANIFEST_FILE];
      if (manifestDoc?.dirty) {
        const check = parseManifest(manifestDoc.data);
        if (!check.ok) {
          toast("error", "Not saved: gamestudio.json is invalid", check.errors.slice(0, 3).join("; "));
          return false;
        }
        manifest = check.manifest;
      }
      set({ busy: "saving" });
      try {
        manifest = touch(manifest);
        const files: NewFile[] = dirty.filter((d) => d.path !== MANIFEST_FILE).map((d) => ({ path: d.path, content: serialize(d) }));
        files.push({ path: MANIFEST_FILE, content: JSON.stringify(manifest, null, 2) + "\n" });
        await backend.projectWrite(root, files);
        set((s) => ({
          manifest,
          lastSavedAt: new Date().toISOString(),
          docs: Object.fromEntries(Object.entries(s.docs).map(([p, d]) => [p, p === MANIFEST_FILE ? { ...d, data: manifest, dirty: false } : { ...d, dirty: false }])),
        }));
        const problems = await syncEngine(manifest, root);
        if (problems.length > 0) toast("info", "Saved. Game data was not updated", problems.map((p) => `${p.source}: ${p.messages[0] ?? ""}`).join("; "));
        await get().refresh();
        return true;
      } catch (e) {
        toast("error", "Save failed", errorMessage(e));
        return false;
      } finally {
        set({ busy: null });
      }
    },

    writeFiles: async (files) => {
      const { root } = get();
      if (!root) return false;
      try {
        await backend.projectWrite(root, files);
      } catch (e) {
        toast("error", "Changes not written", errorMessage(e));
        return false;
      }
      set((s) => {
        const docs = { ...s.docs };
        for (const f of files) {
          const old = docs[f.path];
          if (old) docs[f.path] = parseDoc(f.path, old.kind, f.content, old.version + 1);
        }
        return { docs };
      });
      await get().refresh();
      return true;
    },

    refresh: async () => {
      const { root } = get();
      if (!root) return;
      const [files, snapshot] = await Promise.all([backend.projectFiles(root), backend.snapshotStatus(root)]);
      set({ files, snapshot });
    },

    takeSnapshot: async (message) => {
      const { root } = get();
      if (!root) return false;
      if (!(await get().save())) return false;
      try {
        const snap = await backend.snapshotCreate(root, message);
        toast(snap ? "success" : "info", snap ? `Snapshot ${snap.shortId} saved` : "Nothing changed since the last snapshot");
        await get().refresh();
        return true;
      } catch (e) {
        toast("error", "Snapshot failed", errorMessage(e));
        return false;
      }
    },

    restoreSnapshot: async (id) => {
      const { root } = get();
      if (!root) return false;
      set({ busy: "restoring" });
      try {
        const restored = await backend.snapshotRestore(root, id);
        const opened = await backend.projectOpen(root);
        const parsed = parseManifest(JSON.parse(opened.manifest));
        if (!parsed.ok) throw new Error(parsed.errors.join("; "));
        const reloaded: Record<string, Doc> = {};
        for (const [path, doc] of Object.entries(get().docs)) {
          if (doc.kind === "image" || doc.kind === "binary") {
            reloaded[path] = { ...doc, version: doc.version + 1 };
            continue;
          }
          try {
            reloaded[path] = parseDoc(path, kindFor(path, parsed.manifest), await backend.projectRead(root, path), doc.version + 1);
          } catch {
            /* the file did not exist in that snapshot */
          }
        }
        set((s) => ({ manifest: parsed.manifest, files: opened.files, snapshot: opened.snapshots, docs: reloaded, tabs: s.tabs.filter((t) => reloaded[t]) }));
        toast("success", "Snapshot restored", restored.message);
        return true;
      } catch (e) {
        toast("error", "Restore failed", errorMessage(e));
        return false;
      } finally {
        set({ busy: null });
      }
    },

    collectDocs: async () => {
      const { manifest } = get();
      if (!manifest) return null;
      const docs: ProjectDocs = { manifest, rules: {}, lessons: {} };
      for (const r of manifest.rules) {
        const d = await get().loadDoc(r.path);
        if (d && !d.error) docs.rules[r.id] = { path: r.path, graph: d.data as ProjectDocs["rules"][string]["graph"] };
      }
      for (const entry of manifest.data) {
        const d = await get().loadDoc(entry.path);
        if (!d || d.error) continue;
        if (entry.kind === "explore-world") docs.world = { path: entry.path, world: d.data as NonNullable<ProjectDocs["world"]>["world"] };
        if (entry.kind === "platformer-level") docs.level = { path: entry.path, level: d.data as NonNullable<ProjectDocs["level"]>["level"] };
        if (entry.kind === "football-match") docs.match = { path: entry.path, match: d.data as NonNullable<ProjectDocs["match"]>["match"] };
        if (entry.kind === "farm-sim") docs.farm = { path: entry.path, farm: d.data as NonNullable<ProjectDocs["farm"]>["farm"] };
        if (entry.kind === "creature-catalog") docs.catalog = { path: entry.path, catalog: d.data as NonNullable<ProjectDocs["catalog"]>["catalog"] };
        if (entry.kind === "lesson") docs.lessons[entry.id] = { path: entry.path, lesson: d.data as ProjectDocs["lessons"][string]["lesson"] };
      }
      // Model and texture files the assistant may refer to (Godot projects: res://assets/...).
      if (manifest.engine.id === "godot") {
        const dir = `${manifest.engine.projectDir}/`;
        const inAssets = get().files.filter((f) => f.kind === "file" && f.path.startsWith(`${dir}assets/`)).map((f) => f.path.slice(dir.length));
        docs.assets = { models: inAssets.filter((p) => /\.(glb|gltf|vrm)$/i.test(p)).sort(), textures: inAssets.filter((p) => /\.(png|jpe?g|webp)$/i.test(p)).sort(), audio: inAssets.filter((p) => /\.(ogg|wav|mp3)$/i.test(p)).sort(), skies: inAssets.filter((p) => /\.hdr$/i.test(p)).sort() };
        // The assistant may name only animations a model has: read each model's list (cached for the session).
        const root = get().root;
        if (root && backend.kind !== "browser" && docs.assets.models.length > 0) {
          const clips: Record<string, string[]> = {};
          const { loadModelFile } = await import("../views/world/modelFiles");
          await Promise.all(
            docs.assets.models.map(async (m) => {
              const loaded = await Promise.race([loadModelFile(m, (a) => backend.assetUrl(root, `${dir}${a}`)).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
              if (loaded) clips[m] = loaded.clips.map((c) => c.name);
            }),
          );
          docs.assets.clips = clips;
        }
      }
      return docs;
    },

    applyAgentChanges: async (next, touched, label) => {
      const { root } = get();
      if (!root) return false;
      if (!(await get().save())) return false;
      set({ busy: "applying" });
      try {
        const before = await backend.snapshotCreate(root, `Before assistant change: ${label}`.slice(0, 280)).catch(() => null);
        const byPath: Record<string, unknown> = {};
        for (const g of Object.values(next.rules)) byPath[g.path] = g.graph;
        if (next.world) byPath[next.world.path] = next.world.world;
        if (next.level) byPath[next.level.path] = next.level.level;
        if (next.catalog) byPath[next.catalog.path] = next.catalog.catalog;
        for (const l of Object.values(next.lessons)) byPath[l.path] = l.lesson;
        byPath[MANIFEST_FILE] = touch(next.manifest);
        const files: NewFile[] = touched.map((p) => ({ path: p, content: JSON.stringify(byPath[p], null, 2) + "\n" }));
        await backend.projectWrite(root, files);
        set((s) => {
          const docs = { ...s.docs };
          for (const p of touched) {
            const old = docs[p];
            docs[p] = { path: p, kind: old?.kind ?? kindFor(p, s.manifest), data: byPath[p], dirty: false, error: null, version: (old?.version ?? 0) + 1 };
          }
          return { docs, manifest: touched.includes(MANIFEST_FILE) ? (byPath[MANIFEST_FILE] as ProjectManifest) : s.manifest };
        });
        await syncEngine(get().manifest!, root);
        const after = await backend.snapshotCreate(root, `Assistant: ${label}`.slice(0, 280)).catch(() => null);
        await backend.auditAppend(root, "user", "assistant.apply", { label, touched, before: before?.id ?? null, after: after?.id ?? null });
        await get().refresh();
        return true;
      } catch (e) {
        toast("error", "Changes not applied", errorMessage(e));
        return false;
      } finally {
        set({ busy: null });
      }
    },
  };
});

export function dirtyCount(docs: Record<string, Doc>): number {
  return Object.values(docs).filter((d) => d.dirty).length;
}
