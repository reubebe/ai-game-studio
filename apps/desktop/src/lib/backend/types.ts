/** Data shapes exchanged with the Rust backend (src-tauri/src). Keep in sync with the serde structs. */

export interface BackendError {
  code: "invalid" | "not-found" | "denied" | "conflict" | "unavailable" | "io" | "db" | "internal" | "browser";
  message: string;
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

export interface AppInfo {
  version: string;
  dataDir: string;
  platform: string;
  arch: string;
  gitAvailable: boolean;
  devBuild: boolean;
  smokeDir: string | null;
  /** Opt-in self-test checks (--smoke-extras): "editors", "templates". */
  smokeExtras: string[];
  defaultProjectsDir: string;
}

export type Settings = Record<string, unknown>;

export interface RecentProject {
  path: string;
  title: string;
  template: string;
  engine: string;
  openedAt: string;
  exists: boolean;
}

export interface FileEntry {
  path: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  modified: string | null;
}

export interface Snapshot {
  id: string;
  shortId: string;
  message: string;
  at: string;
}

export interface SnapshotStatus {
  gitAvailable: boolean;
  initialized: boolean;
  dirty: boolean;
  head: Snapshot | null;
}

export interface OpenedProject {
  root: string;
  manifest: string;
  files: FileEntry[];
  snapshots: SnapshotStatus;
}

export interface ImportedFile {
  path: string;
  sourceName: string;
  bytes: number;
  sha256: string;
}

export interface LibraryAsset {
  id: string;
  name: string;
  categories: string[];
  tags: string[];
  authors: string[];
  description: string;
  /** Millimetres (x, y, z) for models, when listed. */
  dimensions: [number, number, number] | null;
}

export interface LibraryCharacter {
  id: string;
  /** Converted with Godot after downloading (realistic people from Microsoft Rocketbox). */
  needsGodot: boolean;
  name: string;
  /** The model file inside the character's folder (other files, such as textures, sit beside it). */
  main: string;
  bytes: number;
  license: string;
  author: string;
  source: string;
  clips: string[];
  /** A height that suits it, in metres. */
  height: number;
  description: string;
}

export interface LibrarySound {
  id: string;
  name: string;
  file: string;
  bytes: number;
  seconds: number;
  license: string;
  author: string;
  source: string;
  description: string;
}

/** The text parts of Epic's Game Animation Sample on this computer. */
export interface UnrealSampleInfo {
  path: string;
  engineVersion: string | null;
  config: Record<string, string>;
  uproject: string;
}

export interface PageText {
  url: string;
  title: string;
  description: string;
  text: string;
}

export interface EngineInstall {
  version: string;
  fullVersion: string;
  channel: string;
  flavor: string;
  executable: string;
  bundle: string | null;
  source: string;
  compatible: boolean;
  note: string | null;
}

export interface ToolInfo {
  name: string;
  found: boolean;
  version: string | null;
  path: string | null;
  problem: string | null;
}

export interface Capability {
  id: string;
  label: string;
  status: "available" | "unavailable" | "planned";
  reason: string | null;
}

export interface EngineReport {
  id: "godot" | "unity" | "unreal" | "cpp";
  name: string;
  summary: string;
  installs: EngineInstall[];
  tools: ToolInfo[];
  capabilities: Capability[];
  officialUrl: string;
  notes: string[];
}

/** Engine runs the backend starts. "web" builds a Godot project for Play here. */
/** export builds the macOS app; export-windows and export-linux build 64-bit x86 programs. */
export type RunAction = "play" | "editor" | "smoke" | "conformance" | "xr" | "build" | "test" | "export" | "export-windows" | "export-linux" | "web";

/** A web build served to the Play view's sandboxed frame (Play here). */
export interface PlayWebInfo {
  url: string;
  /** The build's page, relative to the project root. */
  page: string;
  /** Bytes the frame downloads (engine and game data). */
  bytes: number;
}

export type RunEvent =
  | { type: "step"; runId: string; step: number; label: string; command: string }
  | { type: "output"; runId: string; stream: "stdout" | "stderr"; line: string }
  | { type: "exit"; runId: string; code: number | null; cancelled: boolean; failedStep: string | null; durationMs: number };

export interface InstallProgress {
  stage: "checksums" | "downloading" | "verifying" | "extracting" | "done";
  received: number;
  total: number | null;
  message: string;
}

export interface ProviderStatus {
  id: string;
  label: string;
  kind: "local" | "cloud" | "test";
  endpoint: string;
  available: boolean;
  credential: string | null;
  models: string[];
  suggestedModels: string[];
  allowed: boolean;
  note: string | null;
  docs: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  provider: string;
  model: string;
  system: string;
  messages: ChatMessage[];
  schema: Record<string, unknown>;
  schemaName: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
}

export interface GenerateResult {
  provider: string;
  model: string;
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  servedBy: string | null;
  notes: string[];
  durationMs: number;
}

/**
 * One event of a streamed reply: a piece of text, "restart" (the provider broke the answer off partway
 * and is being asked again, so the text so far no longer counts), the finished result, or why it ended early.
 */
export interface StreamEvent {
  streamId: string;
  kind: "delta" | "restart" | "done" | "error";
  text?: string | null;
  result?: GenerateResult | null;
  message?: string | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  project: string | null;
  actor: string;
  action: string;
  detail: unknown;
}

export interface NewFile {
  path: string;
  content: string;
}

export interface Backend {
  readonly kind: "tauri" | "browser";
  appInfo(): Promise<AppInfo>;
  settingsGet(): Promise<Settings>;
  settingsSet(key: string, value: unknown): Promise<Settings>;
  pickDirectory(title: string): Promise<string | null>;
  pickFiles(title: string, extensions: string[], multiple: boolean): Promise<string[]>;
  openExternal(url: string): Promise<void>;
  revealPath(root: string, path?: string): Promise<void>;
  recentsList(): Promise<RecentProject[]>;
  recentsForget(path: string): Promise<void>;
  projectCreate(parent: string, folder: string, files: NewFile[], message: string): Promise<OpenedProject>;
  projectOpen(path: string): Promise<OpenedProject>;
  projectClose(root: string): Promise<void>;
  projectFiles(root: string): Promise<FileEntry[]>;
  projectRead(root: string, path: string): Promise<string>;
  projectWrite(root: string, files: NewFile[]): Promise<void>;
  projectTrash(root: string, path: string): Promise<string>;
  projectImport(root: string, sources: string[], destDir: string): Promise<ImportedFile[]>;
  /** Poly Haven's free (CC0) models or textures. */
  libraryList(kind: "models" | "textures" | "hdris"): Promise<LibraryAsset[]>;
  /** Free animated characters (pinned files with checksums and licences). */
  libraryCharacters(): Promise<LibraryCharacter[]>;
  /** Free sound effects (pinned files with checksums and licences). */
  librarySounds(): Promise<LibrarySound[]>;
  /** A library preview picture as a data: URL. */
  libraryThumbnail(id: string): Promise<string>;
  /** Downloads a library asset into `<destDir>/<id>/`, each file checked against the library's checksum. */
  libraryDownload(root: string, kind: "models" | "textures" | "hdris" | "characters" | "sounds", id: string, resolution: "1k" | "2k" | "4k", destDir: string): Promise<ImportedFile[]>;
  /** The title, description and visible text of a public web page (never a local or private address). */
  pageFetch(url: string): Promise<PageText>;
  /** Epic's Game Animation Sample (Documents/Unreal Projects): its settings, for the realistic Unreal template. */
  unrealSampleFiles(): Promise<UnrealSampleInfo>;
  /** Copies the sample's content into an open project's Unreal folder. */
  unrealSampleAdd(root: string, engineDir: string): Promise<{ files: number; bytes: number }>;
  snapshotStatus(root: string): Promise<SnapshotStatus>;
  snapshotList(root: string, limit: number): Promise<Snapshot[]>;
  snapshotCreate(root: string, message: string): Promise<Snapshot | null>;
  snapshotRestore(root: string, id: string): Promise<Snapshot>;
  enginesDiscover(): Promise<EngineReport[]>;
  engineInstallGodot(version: string): Promise<string>;
  /** Official export templates for a Godot release, into Godot's own templates folder. */
  engineInstallGodotTemplates(version: string): Promise<string>;
  engineOpenTool(tool: "unity-hub" | "epic-launcher"): Promise<void>;
  /** `output` names the built app (Unity builds), for example "Sun Crystal Valley.app". */
  runStart(root: string, action: RunAction, output?: string): Promise<string>;
  /** Serves the project's web build (made by the "web" run) to the Play view's frame. */
  playWebOpen(root: string): Promise<PlayWebInfo>;
  /** The game's saves that Play here keeps for it (src-tauri/src/play_saves.rs); null when there are none yet. */
  playSavesRead(root: string): Promise<string | null>;
  /** Replaces them; returns how many files they hold. */
  playSavesWrite(root: string, text: string): Promise<number>;
  playSavesClear(root: string): Promise<void>;
  runStop(runId: string): Promise<boolean>;
  aiProviders(): Promise<ProviderStatus[]>;
  aiGenerate(request: GenerateRequest, project: string | null): Promise<GenerateResult>;
  /** Starts streaming a reply; listen with listenAiStream first. The caller chooses the id (a UUID). */
  aiStreamStart(streamId: string, request: GenerateRequest, project: string | null): Promise<void>;
  aiStreamStop(streamId: string): Promise<boolean>;
  /** Resolves once listening, so no event sent after it resolves can be missed. */
  listenAiStream(cb: (e: StreamEvent) => void): Promise<() => void>;
  auditAppend(project: string | null, actor: "user" | "assistant" | "studio", action: string, detail: unknown): Promise<number>;
  auditList(project: string | null, limit: number): Promise<AuditEntry[]>;
  smokeFinish(report: unknown): Promise<void>;
  onRunEvent(cb: (e: RunEvent) => void): () => void;
  onInstallProgress(cb: (p: InstallProgress) => void): () => void;
  onFilesDropped(cb: (paths: string[]) => void): () => void;
  /** URL the webview can load for an image inside a project, or null when unavailable. */
  assetUrl(root: string, path: string): string | null;
}
