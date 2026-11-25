import { useCallback, useEffect, useMemo, useState } from "react";
import { assetIndexSchema, emptyAssetIndex, type AssetEntry, type AssetIndex } from "@gamestudio/project";
import { backend, errorMessage } from "../../lib/backend";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { Button, Empty, Field, Notice, TextInput, formatBytes, formatWhen } from "../../components/ui";
import { AssetsIcon, BoxIcon, FileIcon, ImportIcon, TrashIcon, TagIcon, PackageIcon } from "../../components/icons";
import { LibraryBrowser } from "./LibraryBrowser";

const KIND_BY_EXT: [RegExp, AssetEntry["kind"], string][] = [
  [/\.(png|jpe?g|webp|gif|svg)$/i, "image", "images"],
  [/\.(glb|gltf|vrm|fbx|obj|blend)$/i, "model", "models"],
  [/\.(ogg|wav|mp3|flac)$/i, "audio", "audio"],
  [/\.(ttf|otf|woff2?)$/i, "font", "fonts"],
  [/\.(json|csv|txt)$/i, "data", "data"],
];
const kindOf = (p: string): [AssetEntry["kind"], string] => {
  const hit = KIND_BY_EXT.find(([re]) => re.test(p));
  return hit ? [hit[1], hit[2]] : ["other", "other"];
};
const IMPORT_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "svg", "glb", "gltf", "fbx", "obj", "blend", "ogg", "wav", "mp3", "flac", "ttf", "otf", "json", "csv", "txt"];

export function AssetsView() {
  const root = useProject((s) => s.root)!;
  const manifest = useProject((s) => s.manifest)!;
  const files = useProject((s) => s.files);
  const refresh = useProject((s) => s.refresh);
  const toast = useApp((s) => s.toast);
  const openDialog = useApp((s) => s.openDialog);
  const [index, setIndex] = useState<AssetIndex | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<AssetEntry["kind"] | "all">("all");
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [library, setLibrary] = useState(false);
  const baseDir = manifest.engine.id === "godot" ? `${manifest.engine.projectDir}/assets` : "assets";

  const loadIndex = useCallback(async () => {
    try {
      const parsed = assetIndexSchema.safeParse(JSON.parse(await backend.projectRead(root, manifest.assetsIndex)));
      if (parsed.success) {
        setIndex(parsed.data);
        setIndexError(null);
      } else {
        setIndexError(parsed.error.issues[0]?.message ?? "Invalid asset index");
        setIndex(emptyAssetIndex());
      }
    } catch {
      setIndex(emptyAssetIndex());
    }
  }, [root, manifest.assetsIndex]);
  useEffect(() => {
    void loadIndex();
  }, [loadIndex]);

  const writeIndex = async (next: AssetIndex) => {
    await backend.projectWrite(root, [{ path: manifest.assetsIndex, content: JSON.stringify(next, null, 2) + "\n" }]);
    setIndex(next);
  };

  const importPaths = useCallback(
    async (paths: string[]) => {
      if (!index || paths.length === 0) return;
      setBusy(true);
      try {
        const now = new Date().toISOString();
        const entries: AssetEntry[] = [];
        for (const p of paths) {
          const [kind, folder] = kindOf(p);
          const imported = await backend.projectImport(root, [p], `${baseDir}/${folder}`);
          for (const f of imported) entries.push({ path: f.path, kind, bytes: f.bytes, sha256: f.sha256, importedAt: now, source: f.sourceName, license: "", author: "", notes: "", tags: [] });
        }
        await writeIndex({ ...index, assets: [...index.assets.filter((a) => !entries.some((e) => e.path === a.path)), ...entries] });
        await refresh();
        toast("success", `Imported ${entries.length} file${entries.length === 1 ? "" : "s"}`, "Record a licence for each one before you share the project.");
        if (entries[0]) setSelected(entries[0].path);
      } catch (e) {
        toast("error", "Import failed", errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [index, root, baseDir, refresh, toast], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => backend.onFilesDropped((paths) => void importPaths(paths)), [importPaths]);

  const onDisk = useMemo(() => files.filter((f) => f.kind === "file" && (f.path.startsWith("assets/") || f.path.startsWith(`${baseDir}/`)) && f.path !== manifest.assetsIndex), [files, baseDir, manifest.assetsIndex]);
  const rows = useMemo(() => {
    const byPath = new Map(index?.assets.map((a) => [a.path, a]) ?? []);
    return onDisk.map((f) => ({ file: f, entry: byPath.get(f.path) ?? null, kind: byPath.get(f.path)?.kind ?? kindOf(f.path)[0] })).filter((r) => filter === "all" || r.kind === filter);
  }, [onDisk, index, filter]);
  const current = rows.find((r) => r.file.path === selected);
  const update = (patch: Partial<AssetEntry>) => {
    if (!index || !current) return;
    const base: AssetEntry = current.entry ?? { path: current.file.path, kind: current.kind, bytes: current.file.size, importedAt: new Date().toISOString(), source: "", license: "", author: "", notes: "", tags: [] };
    const entry = { ...base, ...patch };
    void writeIndex({ ...index, assets: [...index.assets.filter((a) => a.path !== entry.path), entry] }).catch((e) => toast("error", "Not saved", errorMessage(e)));
  };
  const unlicensed = rows.filter((r) => !r.entry?.license).length;

  return (
    <div className="view">
      <div className="view__header">
        <div style={{ flex: 1 }}>
          <div className="view__title">Asset library</div>
          <div className="view__subtitle">Files in {baseDir}/ with their source and licence. {manifest.engine.id === "godot" ? "Godot can load them as res://assets/…" : ""}</div>
        </div>
        <select className="select" style={{ width: 140 }} aria-label="Filter by kind" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          {["all", "image", "model", "audio", "font", "data", "other"].map((k) => <option key={k} value={k}>{k === "all" ? "All kinds" : k}</option>)}
        </select>
        <Button icon={<PackageIcon />} disabled={backend.kind === "browser"} tip={backend.kind === "browser" ? "The free library needs the desktop app" : "Free CC0 models and textures from Poly Haven"} onClick={() => setLibrary(true)}>
          Free library
        </Button>
        <Button variant="primary" icon={<ImportIcon />} busy={busy} disabled={backend.kind === "browser"} tip={backend.kind === "browser" ? "Importing files needs the desktop app" : "Copy files into the project"} onClick={async () => importPaths(await backend.pickFiles("Import assets", IMPORT_EXTENSIONS, true))}>
          Import files
        </Button>
      </div>
      {library && index && (
        <LibraryBrowser
          root={root}
          baseDir={baseDir}
          onClose={() => setLibrary(false)}
          onAdded={async (entries, kind) => {
            const latest = await (async () => {
              try {
                const parsed = assetIndexSchema.safeParse(JSON.parse(await backend.projectRead(root, manifest.assetsIndex)));
                return parsed.success ? parsed.data : index;
              } catch {
                return index;
              }
            })();
            await writeIndex({ ...latest, assets: [...latest.assets.filter((a) => !entries.some((e) => e.path === a.path)), ...entries] });
            await refresh();
            const main = entries.find((e) => e.kind === "model") ?? entries[0];
            if (main) setSelected(main.path);
            toast("success", kind === "models" ? "Model added" : kind === "characters" ? "Character added" : kind === "sounds" ? "Sound added" : kind === "skies" ? "Sky added" : "Texture added", kind === "models" ? "Place it with the World editor's 3D model button." : kind === "characters" ? "Play as it (World settings, Character) or put it on a villager (select the villager, Character model)." : kind === "sounds" ? "Use it in the level's Sound settings (World or Level settings)." : kind === "skies" ? "Choose it as the sky in World settings (Sky)." : "Choose it as the ground texture in World settings.");
          }}
        />
      )}
      <div className="split" style={{ gridTemplateColumns: "minmax(0,1fr) 320px", flex: 1, minHeight: 0 }}>
        <div className="split__list" style={{ borderRight: "1px solid var(--line)" }} onDragEnter={() => setDropping(true)} onDragLeave={() => setDropping(false)} onDrop={() => setDropping(false)}>
          {indexError && <div style={{ padding: 16 }}><Notice kind="warn">{manifest.assetsIndex} is invalid ({indexError}); a new index will be written on the next change.</Notice></div>}
          {unlicensed > 0 && <div style={{ padding: "16px 16px 0" }}><Notice kind="warn">{unlicensed} file{unlicensed === 1 ? " has" : "s have"} no licence recorded.</Notice></div>}
          {rows.length === 0 ? (
            <div style={{ padding: 24 }}>
              <div className={`dropzone ${dropping ? "dropzone--active" : ""}`}>
                <AssetsIcon width={28} height={28} />
                <p style={{ marginTop: 8 }}>{backend.kind === "browser" ? "Importing needs the desktop app." : "Drop images, models, audio or fonts here, or use Import files."}</p>
              </div>
            </div>
          ) : (
            <div className="asset-grid">
              {rows.map((r) => {
                const url = r.kind === "image" ? backend.assetUrl(root, r.file.path) : null;
                return (
                  <button key={r.file.path} type="button" className="asset-tile" aria-selected={selected === r.file.path} onClick={() => setSelected(r.file.path)}>
                    <div className="asset-tile__thumb">{url ? <img src={url} alt="" loading="lazy" /> : r.kind === "model" ? <BoxIcon /> : <FileIcon />}</div>
                    <div className="asset-tile__meta">
                      <span className="small truncate">{r.file.path.split("/").pop()}</span>
                      <span className="row xsmall muted" style={{ gap: 6 }}>{r.kind} · {formatBytes(r.file.size)}{!r.entry?.license && <span className="badge badge--amber">no licence</span>}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="split__main" style={{ padding: 14 }}>
          {current ? (
            <div className="stack" style={{ gap: 12 }}>
              <div className="mono small" style={{ overflowWrap: "anywhere" }}>{current.file.path}</div>
              <dl className="kv">
                <dt>Kind</dt><dd>{current.kind}</dd>
                <dt>Size</dt><dd>{formatBytes(current.file.size)}</dd>
                {current.entry?.importedAt && <><dt>Imported</dt><dd>{formatWhen(current.entry.importedAt)}</dd></>}
                {current.entry?.sha256 && <><dt>SHA-256</dt><dd className="mono xsmall">{current.entry.sha256.slice(0, 16)}…</dd></>}
              </dl>
              <Field label="Licence" htmlFor="as-lic" help="For example CC0, CC BY 4.0, or 'Original work'."><TextInput id="as-lic" value={current.entry?.license ?? ""} onCommit={(license) => update({ license })} /></Field>
              <Field label="Author" htmlFor="as-author"><TextInput id="as-author" value={current.entry?.author ?? ""} onCommit={(author) => update({ author })} /></Field>
              <Field label="Source" htmlFor="as-src" help="Where it came from: a URL or the original file name."><TextInput id="as-src" value={current.entry?.source ?? ""} onCommit={(source) => update({ source })} /></Field>
              <Field label={<><TagIcon width={12} /> Tags</>} htmlFor="as-tags"><TextInput id="as-tags" value={(current.entry?.tags ?? []).join(", ")} onCommit={(t) => update({ tags: t.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20) })} /></Field>
              <Field label="Notes" htmlFor="as-notes"><TextInput id="as-notes" value={current.entry?.notes ?? ""} onCommit={(notes) => update({ notes })} /></Field>
              <Button size="small" variant="danger" icon={<TrashIcon />} onClick={() => openDialog({ kind: "confirm", title: "Move this asset to the trash?", body: `${current.file.path} moves to .gamestudio/trash in the project. Anything that uses it will stop finding it.`, confirmLabel: "Move to trash", danger: true, onConfirm: async () => { await backend.projectTrash(root, current.file.path); if (index) await writeIndex({ ...index, assets: index.assets.filter((a) => a.path !== current.file.path) }); setSelected(null); await refresh(); } })}>
                Move to trash
              </Button>
            </div>
          ) : (
            <Empty icon={<AssetsIcon />} title="Select an asset">Choose a file to see its details and record its source and licence.</Empty>
          )}
        </div>
      </div>
    </div>
  );
}
