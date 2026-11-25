/**
 * Play here keeps the game's user:// files (its saves) for it, because the game's sandboxed frame has
 * no storage of its own. The frame's page (src-tauri/assets/play-shell.html) sends each save as a
 * batch of {puts, deletes}; these helpers check a batch, keep the current set, and turn it into the
 * file the backend stores. src-tauri/src/play_saves.rs checks the same rules again.
 */
export interface SaveEntry {
  timestamp: number;
  mode: number;
  contents?: Uint8Array;
}
export type SaveSet = Map<string, SaveEntry>;
/** What the game's page receives before the game starts. */
export interface FrameSaveEntry extends SaveEntry {
  path: string;
}

export const MAX_SAVE_ENTRIES = 4096;
/** Bytes of file contents (stored as base64, so the file is about a third larger). */
export const MAX_SAVE_BYTES = 32 * 1024 * 1024;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const isDir = (mode: number) => (mode & S_IFMT) === S_IFDIR;
const isFile = (mode: number) => (mode & S_IFMT) === S_IFREG;

/** A file or folder inside the game's user:// folder, which Godot's web build calls /userfs. */
export function isSafeSavePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > 512 || !path.startsWith("/userfs/")) return false;
  // eslint-disable-next-line no-control-regex
  return path.slice("/userfs/".length).split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".." && !/[\u0000-\u001f\u007f-\u009f\\]/.test(seg));
}

export function fileCount(set: SaveSet): number {
  let n = 0;
  for (const e of set.values()) if (isFile(e.mode)) n++;
  return n;
}

function totalBytes(set: SaveSet): number {
  let n = 0;
  for (const e of set.values()) n += e.contents?.length ?? 0;
  return n;
}

const shortPath = (p: unknown) => String(p).slice(0, 80);

/**
 * Applies one batch from the game's page. Returns why it was refused (and changes nothing) when any
 * part is not a plain file or folder inside user://, or the saves would grow too large.
 */
export function applySaveBatch(set: SaveSet, batch: unknown): string | null {
  const { puts, deletes } = (batch ?? {}) as { puts?: unknown; deletes?: unknown };
  if (!Array.isArray(puts) || !Array.isArray(deletes)) return "the game sent something that is not a save";
  const next: SaveSet = new Map(set);
  for (const raw of puts) {
    const e = (raw ?? {}) as { path?: unknown; timestamp?: unknown; mode?: unknown; contents?: unknown };
    if (!isSafeSavePath(e.path)) return `${shortPath(e.path)} is not inside the game's user:// folder`;
    const timestamp = Number(e.timestamp);
    const mode = Number(e.mode);
    if (!Number.isFinite(timestamp) || timestamp < 0 || !Number.isInteger(mode)) return `${e.path} has a bad date or mode`;
    if (isDir(mode) && e.contents === undefined) next.set(e.path, { timestamp, mode });
    else if (isFile(mode) && e.contents instanceof Uint8Array) next.set(e.path, { timestamp, mode, contents: new Uint8Array(e.contents) });
    else return `${e.path} is not a plain file or folder`;
  }
  for (const p of deletes) {
    if (!isSafeSavePath(p)) return `${shortPath(p)} is not inside the game's user:// folder`;
    next.delete(p);
  }
  if (next.size > MAX_SAVE_ENTRIES) return `the game would have more than ${MAX_SAVE_ENTRIES} saved files and folders`;
  if (totalBytes(next) > MAX_SAVE_BYTES) return `the game's saves would be larger than ${MAX_SAVE_BYTES / 1048576} MB`;
  set.clear();
  for (const [k, v] of next) set.set(k, v);
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Reads the stored file ({"version": 1, "entries": {path: {timestamp, mode, data}}}); null means no saves yet. */
export function parseSaves(text: string | null): SaveSet {
  const set: SaveSet = new Map();
  if (!text) return set;
  const doc = JSON.parse(text) as { version?: unknown; entries?: Record<string, { timestamp: number; mode: number; data?: string }> };
  if (doc.version !== 1 || !doc.entries || typeof doc.entries !== "object") throw new Error("The saves file has an unknown format.");
  for (const [path, e] of Object.entries(doc.entries)) {
    if (!isSafeSavePath(path)) continue;
    set.set(path, { timestamp: Number(e.timestamp), mode: Number(e.mode), ...(typeof e.data === "string" ? { contents: fromBase64(e.data) } : {}) });
  }
  return set;
}

export function serializeSaves(set: SaveSet): string {
  const entries: Record<string, { timestamp: number; mode: number; data?: string }> = {};
  for (const [path, e] of [...set].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    entries[path] = { timestamp: e.timestamp, mode: e.mode, ...(e.contents ? { data: toBase64(e.contents) } : {}) };
  }
  return JSON.stringify({ version: 1, entries });
}

export function entriesForFrame(set: SaveSet): FrameSaveEntry[] {
  return [...set].map(([path, e]) => ({ path, timestamp: e.timestamp, mode: e.mode, ...(e.contents ? { contents: new Uint8Array(e.contents) } : {}) }));
}
