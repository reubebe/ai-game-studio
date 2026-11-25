import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applySaveBatch, entriesForFrame, fileCount, isSafeSavePath, MAX_SAVE_BYTES, parseSaves, serializeSaves, type SaveSet } from "./saves";

// The stand-in database pasted into Play here's page (src-tauri/assets/play-saves.js).
type Req = { result: unknown; onsuccess: ((e: { target: Req }) => void) | null; onerror: unknown };
type Tx = { objectStore(n: string): Store; oncomplete: (() => void) | null };
type Store = { index(n: string): { openKeyCursor(): Req }; get(p: string): Req; put(e: unknown, p: string): Req; delete(p: string): Req; indexNames: { contains(n: string): boolean } };
type Db = { transaction(s: string[], mode: string): Tx; objectStoreNames: { contains(n: string): boolean }; close(): void };
type Factory = { open(name: string, version: number): Req };
type Batch = { puts: { path: string; timestamp: number; mode: number; contents?: Uint8Array }[]; deletes: string[] };
const source = readFileSync(new URL("../../../src-tauri/assets/play-saves.js", import.meta.url), "utf8");
const makeStore = new Function(`${source}; return gamestudioSaveStore;`)() as (initial: unknown[], onCommit: (b: Batch) => void) => Factory;

const FILE = 0o100666;
const DIR = 0o040777;
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const request = <T,>(r: Req) => new Promise<T>((resolve) => (r.onsuccess = (e) => resolve(e.target.result as T)));
const complete = (tx: Tx) => new Promise<void>((resolve) => (tx.oncomplete = () => resolve()));

async function openDb(factory: Factory): Promise<Db> {
  return request<Db>(factory.open("/userfs", 21));
}

// Emscripten's IDBFS reads the stored set this way (getRemoteSet).
async function remoteSet(db: Db): Promise<Record<string, number>> {
  const tx = db.transaction(["FILE_DATA"], "readonly");
  const cursorReq = tx.objectStore("FILE_DATA").index("timestamp").openKeyCursor();
  const out: Record<string, number> = {};
  await new Promise<void>((resolve) => {
    cursorReq.onsuccess = (e) => {
      const cursor = e.target.result as { primaryKey: string; key: Date; continue(): void } | null;
      if (!cursor) return resolve();
      out[cursor.primaryKey] = cursor.key.getTime();
      cursor.continue();
    };
  });
  return out;
}

describe("Play here's stand-in for the game's save database", () => {
  it("lists the saves Game Studio kept, the way Godot reads them at start", async () => {
    const factory = makeStore([{ path: "/userfs/saves", timestamp: 5, mode: DIR }, { path: "/userfs/saves/p.json", timestamp: 9, mode: FILE, contents: bytes("{}") }], () => {});
    const db = await openDb(factory);
    expect(db.objectStoreNames.contains("FILE_DATA")).toBe(true);
    expect(await remoteSet(db)).toEqual({ "/userfs/saves": 5, "/userfs/saves/p.json": 9 });
    const tx = db.transaction(["FILE_DATA"], "readwrite");
    const done = complete(tx);
    const entry = await request<{ timestamp: Date; mode: number; contents: Uint8Array }>(tx.objectStore("FILE_DATA").get("/userfs/saves/p.json"));
    expect(entry.timestamp).toBeInstanceOf(Date);
    expect(text(entry.contents)).toBe("{}");
    entry.contents[0] = 0; // Godot takes ownership of what it reads; the stored copy must not change
    await done;
    const again = await request<{ contents: Uint8Array }>(db.transaction(["FILE_DATA"], "readonly").objectStore("FILE_DATA").get("/userfs/saves/p.json"));
    expect(text(again.contents)).toBe("{}");
  });

  it("hands each finished save to Game Studio once, with copies of the bytes", async () => {
    const batches: Batch[] = [];
    const factory = makeStore([{ path: "/userfs/old.json", timestamp: 1, mode: FILE, contents: bytes("old") }], (b) => batches.push(b));
    const db = await openDb(factory);
    const tx = db.transaction(["FILE_DATA"], "readwrite");
    const store = tx.objectStore("FILE_DATA");
    const buffer = bytes("progress");
    store.put({ timestamp: new Date(42), mode: FILE, contents: buffer }, "/userfs/progress.json");
    store.delete("/userfs/old.json");
    buffer[0] = 0; // the caller may reuse its buffer at once
    await complete(tx);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.deletes).toEqual(["/userfs/old.json"]);
    expect(batches[0]!.puts.map((p) => [p.path, p.timestamp, p.mode, text(p.contents!)])).toEqual([["/userfs/progress.json", 42, FILE, "progress"]]);
    expect(await remoteSet(db)).toEqual({ "/userfs/progress.json": 42 });
    // Reading inside a read-write transaction (as Godot does when it loads) sends nothing.
    const readTx = db.transaction(["FILE_DATA"], "readwrite");
    readTx.objectStore("FILE_DATA").get("/userfs/progress.json");
    await complete(readTx);
    expect(batches).toHaveLength(1);
  });

  it("refuses writes in read-only transactions", async () => {
    const db = await openDb(makeStore([], () => {}));
    const store = db.transaction(["FILE_DATA"], "readonly").objectStore("FILE_DATA");
    expect(() => store.put({ timestamp: new Date(1), mode: FILE, contents: bytes("x") }, "/userfs/x")).toThrow(/ReadOnly/);
    expect(() => store.delete("/userfs/x")).toThrow(/ReadOnly/);
  });
});

describe("the saves Game Studio keeps for Play here", () => {
  it("only accepts paths inside the game's user:// folder", () => {
    for (const ok of ["/userfs/progress.json", "/userfs/saves/slot 1.dat"]) expect(isSafeSavePath(ok)).toBe(true);
    for (const bad of ["/userfs/", "/userfs/../x", "/userfs//x", "/tmp/x", "/userfs/a\\b", "/userfs/a\u0000b", "/userfs/./x", 7, null]) expect(isSafeSavePath(bad)).toBe(false);
  });

  it("applies batches from the game and refuses bad ones whole", () => {
    const set: SaveSet = new Map();
    expect(applySaveBatch(set, { puts: [{ path: "/userfs/d", timestamp: 1, mode: DIR }, { path: "/userfs/d/a", timestamp: 2, mode: FILE, contents: bytes("a") }], deletes: [] })).toBeNull();
    expect(fileCount(set)).toBe(1);
    expect(applySaveBatch(set, { puts: [{ path: "/userfs/b", timestamp: 3, mode: FILE, contents: bytes("b") }, { path: "/etc/passwd", timestamp: 3, mode: FILE, contents: bytes("x") }], deletes: [] })).toMatch(/not inside/);
    expect(set.has("/userfs/b")).toBe(false);
    expect(applySaveBatch(set, { puts: [{ path: "/userfs/l", timestamp: 3, mode: 0o120777 }], deletes: [] })).toMatch(/plain file/);
    expect(applySaveBatch(set, { puts: [{ path: "/userfs/f", timestamp: 3, mode: FILE, contents: "text" }], deletes: [] })).toMatch(/plain file/);
    expect(applySaveBatch(set, { puts: [{ path: "/userfs/big", timestamp: 3, mode: FILE, contents: new Uint8Array(MAX_SAVE_BYTES + 1) }], deletes: [] })).toMatch(/larger than/);
    expect(applySaveBatch(set, "nonsense")).toMatch(/not a save/);
    expect(applySaveBatch(set, { puts: [], deletes: ["/userfs/d/a"] })).toBeNull();
    expect(fileCount(set)).toBe(0);
  });

  it("stores and reads back the same files", () => {
    const set: SaveSet = new Map([
      ["/userfs/d", { timestamp: 1, mode: DIR }],
      ["/userfs/d/p.json", { timestamp: 1700000000123, mode: FILE, contents: bytes('{"a":1}') }],
      ["/userfs/blob", { timestamp: 2, mode: FILE, contents: new Uint8Array(70000).map((_, i) => i % 256) }],
    ]);
    const stored = serializeSaves(set);
    expect(JSON.parse(stored).version).toBe(1);
    const back = parseSaves(stored);
    expect([...back.keys()].sort()).toEqual([...set.keys()].sort());
    expect(text(back.get("/userfs/d/p.json")!.contents!)).toBe('{"a":1}');
    expect(back.get("/userfs/blob")!.contents).toEqual(set.get("/userfs/blob")!.contents);
    expect(parseSaves(null).size).toBe(0);
    expect(() => parseSaves('{"version":3}')).toThrow(/unknown format/);
    const frame = entriesForFrame(back);
    frame[0]!.contents?.fill(0);
    expect(serializeSaves(back)).toBe(stored);
  });
});
