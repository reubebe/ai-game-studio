import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Backend, InstallProgress, RunEvent, StreamEvent } from "./types";

function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  listen<T>(event, (e) => cb(e.payload)).then((u) => {
    if (cancelled) u();
    else unlisten = u;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

export function createTauriBackend(): Backend {
  return {
    kind: "tauri",
    appInfo: () => invoke("app_info"),
    settingsGet: () => invoke("settings_get"),
    settingsSet: (key, value) => invoke("settings_set", { key, value }),
    pickDirectory: (title) => invoke("pick_directory", { title }),
    pickFiles: (title, extensions, multiple) => invoke("pick_files", { title, extensions, multiple }),
    openExternal: (url) => invoke("open_external", { url }),
    revealPath: (root, path) => invoke("reveal_path", { root, path: path ?? null }),
    recentsList: () => invoke("recents_list"),
    recentsForget: (path) => invoke("recents_forget", { path }),
    projectCreate: (parent, folder, files, message) => invoke("project_create", { parent, folder, files, message }),
    projectOpen: (path) => invoke("project_open", { path }),
    projectClose: (root) => invoke("project_close", { root }),
    projectFiles: (root) => invoke("project_files", { root }),
    projectRead: (root, path) => invoke("project_read", { root, path }),
    projectWrite: (root, files) => invoke("project_write", { root, files }),
    projectTrash: (root, path) => invoke("project_trash", { root, path }),
    projectImport: (root, sources, destDir) => invoke("project_import", { root, sources, destDir }),
    libraryList: (kind) => invoke("library_list", { kind }),
    libraryCharacters: () => invoke("library_characters"),
    librarySounds: () => invoke("library_sounds"),
    libraryThumbnail: (id) => invoke("library_thumbnail", { id }),
    libraryDownload: (root, kind, id, resolution, destDir) => invoke("library_download", { root, kind, id, resolution, destDir }),
    pageFetch: (url) => invoke("page_fetch", { url }),
    unrealSampleFiles: () => invoke("unreal_sample_files"),
    unrealSampleAdd: (root, engineDir) => invoke("unreal_sample_add", { root, engineDir }),
    snapshotStatus: (root) => invoke("snapshot_status", { root }),
    snapshotList: (root, limit) => invoke("snapshot_list", { root, limit }),
    snapshotCreate: (root, message) => invoke("snapshot_create", { root, message }),
    snapshotRestore: (root, id) => invoke("snapshot_restore", { root, id }),
    enginesDiscover: () => invoke("engines_discover"),
    engineInstallGodot: (version) => invoke("engine_install_godot", { version, approved: true }),
    engineInstallGodotTemplates: (version) => invoke("engine_install_godot_templates", { version, approved: true }),
    engineOpenTool: (tool) => invoke("engine_open_tool", { tool }),
    runStart: (root, action, output) => invoke("run_start", { root, action, output: output ?? null }),
    runStop: (runId) => invoke("run_stop", { runId }),
    playWebOpen: (root) => invoke("play_web_open", { root }),
    playSavesRead: (root) => invoke("play_saves_read", { root }),
    playSavesWrite: (root, text) => invoke("play_saves_write", { root, text }),
    playSavesClear: (root) => invoke("play_saves_clear", { root }),
    aiProviders: () => invoke("ai_providers"),
    aiGenerate: (request, project) => invoke("ai_generate", { request, project }),
    aiStreamStart: (streamId, request, project) => invoke("ai_stream_start", { streamId, request, project }),
    aiStreamStop: (streamId) => invoke("ai_stream_stop", { streamId }),
    listenAiStream: (cb) => listen<StreamEvent>("ai-stream", (e) => cb(e.payload)),
    auditAppend: (project, actor, action, detail) => invoke("audit_append", { project, actor, action, detail }),
    auditList: (project, limit) => invoke("audit_list", { project, limit }),
    smokeFinish: (report) => invoke("smoke_finish", { report }),
    onRunEvent: (cb) => subscribe<RunEvent>("run-event", cb),
    onInstallProgress: (cb) => subscribe<InstallProgress>("installer-progress", cb),
    onFilesDropped: (cb) => subscribe<string[]>("files-dropped", cb),
    assetUrl: (root, path) => convertFileSrc(`${root}/${path}`),
  };
}
