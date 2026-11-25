import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetEntry } from "@gamestudio/project";
import { backend, errorMessage, type ImportedFile, type LibraryAsset, type LibraryCharacter, type LibrarySound } from "../../lib/backend";
import { Button, Dialog, Notice, Segmented } from "../../components/ui";
import { BoxIcon, DownloadIcon, SearchIcon } from "../../components/icons";
import { characterEntries, libraryCharacters } from "./characters";

type Kind = "models" | "textures" | "skies" | "characters" | "sounds";
type Resolution = "1k" | "2k" | "4k";

/** Lists last while the app runs, so reopening the library is instant. */
const lists = new Map<"models" | "textures" | "hdris", LibraryAsset[]>();

/** The sound effects: fixed CC0 files, each with its length and use. */
function Sounds({ added, busy, onAdd }: { added: string[]; busy: string | null; onAdd: (c: LibrarySound) => void }) {
  const [list, setList] = useState<LibrarySound[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    backend.librarySounds().then(setList, (e) => setError(errorMessage(e)));
  }, []);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!list) return <div className="row small muted"><span className="spinner" /> Loading…</div>;
  return (
    <div className="stack" style={{ gap: 6 }}>
      {list.map((c) => (
        <div key={c.id} className="row" style={{ gap: 8, padding: "6px 8px", border: "1px solid var(--line)", borderRadius: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="small"><strong>{c.name}</strong> <span className="xsmall muted">{c.file} · {c.seconds.toFixed(2)} s · {Math.round(c.bytes / 1024)} KB</span></div>
            <div className="xsmall muted">{c.description} Licence: {c.license}, by {c.author}.</div>
          </div>
          <Button size="small" variant={added.includes(c.id) ? "ghost" : "primary"} icon={<DownloadIcon />} busy={busy === c.id} disabled={busy !== null && busy !== c.id} onClick={() => onAdd(c)} aria-label={`Add sound ${c.name}`}>
            {added.includes(c.id) ? "Added" : "Add"}
          </Button>
        </div>
      ))}
    </div>
  );
}

/** The animated characters: fixed files from open collections, each with its licence and animations. */
function Characters({ added, busy, onAdd }: { added: string[]; busy: string | null; onAdd: (c: LibraryCharacter) => void }) {
  const [list, setList] = useState<LibraryCharacter[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    libraryCharacters().then(setList, (e) => setError(errorMessage(e)));
  }, []);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!list) return <div className="row small muted"><span className="spinner" /> Loading…</div>;
  return (
    <div className="stack" style={{ gap: 8 }}>
      {list.map((c) => (
        <div key={c.id} className="proposal">
          <div className="proposal__body">
            <div className="row" style={{ gap: 8 }}>
              <strong>{c.name}</strong>
              <span className="xsmall muted">{c.bytes >= 1_000_000 ? `${Math.round(c.bytes / 1_000_000)} MB` : `${Math.round(c.bytes / 1024)} KB`} · about {c.height} m tall{c.needsGodot ? " · converted with Godot" : ""}</span>
              <span className="spacer" />
              <Button size="small" variant={added.includes(c.id) ? "ghost" : "primary"} icon={<DownloadIcon />} busy={busy === c.id} disabled={busy !== null && busy !== c.id} onClick={() => onAdd(c)} aria-label={`Add ${c.name}`}>
                {added.includes(c.id) ? "Added" : "Add"}
              </Button>
            </div>
            <div className="small">{c.description}</div>
            <div className="xsmall muted">Animations: {c.clips.join(", ")}</div>
            <div className="xsmall muted">Licence: {c.license}. By {c.author}.</div>
          </div>
        </div>
      ))}
    </div>
  );
}
const thumbs = new Map<string, string>();
const PAGE = 48;

function Thumb({ id }: { id: string }) {
  const [src, setSrc] = useState(thumbs.get(id) ?? null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (src || !ref.current) return;
    let cancelled = false;
    // Fetched through the app (the page itself never loads pictures from the internet), once visible.
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      backend.libraryThumbnail(id).then((url) => {
        thumbs.set(id, url);
        if (!cancelled) setSrc(url);
      }, () => {});
    });
    io.observe(ref.current);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [id, src]);
  return <div ref={ref} className="asset-tile__thumb">{src ? <img src={src} alt="" /> : <BoxIcon />}</div>;
}

/**
 * Poly Haven's free models and textures (CC0: no attribution needed, commercial use allowed). A
 * download lands in the project's assets folder with its licence, author and source recorded.
 */
export function LibraryBrowser({ root, baseDir, onClose, onAdded }: { root: string; baseDir: string; onClose: () => void; onAdded: (entries: AssetEntry[], kind: Kind) => Promise<void> }) {
  const [kind, setKind] = useState<Kind>("models");
  const [list, setList] = useState<LibraryAsset[] | null>(lists.get("models") ?? null);
  // Poly Haven calls its photographed skies "hdris".
  const listKind = kind === "characters" || kind === "sounds" ? null : kind === "skies" ? "hdris" : kind;
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [resolution, setResolution] = useState<Resolution>("1k");
  const [busy, setBusy] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setShown(PAGE);
    if (!listKind) return;
    const cached = lists.get(listKind);
    if (cached) {
      setList(cached);
      return;
    }
    setList(null);
    setError(null);
    backend.libraryList(listKind).then(
      (l) => {
        lists.set(listKind, l);
        if (!cancelled) setList(l);
      },
      (e) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [listKind]);

  const filtered = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!list) return [];
    return words.length === 0 ? list : list.filter((a) => words.every((w) => a.name.toLowerCase().includes(w) || a.tags.some((t) => t.includes(w)) || a.categories.some((c) => c.includes(w))));
  }, [list, query]);

  const addCharacter = async (c: LibraryCharacter) => {
    setBusy(c.id);
    setError(null);
    try {
      const files = await backend.libraryDownload(root, "characters", c.id, "1k", `${baseDir}/characters`);
      await onAdded(characterEntries(files, c), "characters");
      setAdded((x) => [...x, c.id]);
    } catch (e) {
      setError(`${c.name}: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const addSound = async (c: LibrarySound) => {
    setBusy(c.id);
    setError(null);
    try {
      const files = await backend.libraryDownload(root, "sounds", c.id, "1k", `${baseDir}/audio/kenney`);
      const now = new Date().toISOString();
      await onAdded(files.map((f) => ({ path: f.path, kind: "audio" as const, bytes: f.bytes, sha256: f.sha256, importedAt: now, source: f.sourceName, license: c.license, author: c.author, notes: `${c.name}: ${c.description}`, tags: ["sound"] })), "sounds");
      setAdded((x) => [...x, c.id]);
    } catch (e) {
      setError(`${c.name}: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const add = async (a: LibraryAsset) => {
    setBusy(a.id);
    setError(null);
    try {
      if (!listKind) return;
      const files: ImportedFile[] = await backend.libraryDownload(root, listKind, a.id, resolution, `${baseDir}/${kind}`);
      const now = new Date().toISOString();
      const entries: AssetEntry[] = files.map((f) => ({
        path: f.path,
        kind: /\.(gltf|glb)$/i.test(f.path) ? "model" : /\.(png|jpe?g|webp|hdr)$/i.test(f.path) ? "image" : "data",
        bytes: f.bytes,
        sha256: f.sha256,
        importedAt: now,
        source: f.sourceName,
        license: "CC0 1.0",
        author: a.authors.join(", "),
        notes: `${a.name} from Poly Haven (${resolution}).`,
        tags: [...(kind === "skies" ? ["sky"] : []), ...a.tags].slice(0, 20),
      }));
      await onAdded(entries, kind);
      setAdded((x) => [...x, a.id]);
    } catch (e) {
      setError(`${a.name}: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      wide
      title="Free library: Poly Haven"
      onClose={onClose}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="stack" style={{ gap: 10 }}>
        <p className="small muted" style={{ margin: 0 }}>
          {kind === "sounds"
            ? "Sound effects from Kenney's 3D platformer kit, released as CC0. Each file is checked against a fixed checksum before it is saved. Use them in a level's Sound settings, in place of the template's built-in sounds, or as looping background music."
            : kind === "characters"
            ? "Animated characters from open collections. Each file is checked against a fixed checksum before it is saved, and its licence is recorded; CC BY parts need credit in your game. Use one as the player (World settings, Character) or on a villager."
            : kind === "skies"
            ? "Photographed skies (HDRIs) from Poly Haven, released as CC0 (public domain): free for any use, no credit required. A sky lights the level the way the real one did and fills the background. Files are checked against Poly Haven's checksums before they are saved. Use one in World settings, Sky; set the sun's height and heading to match the photo's sun."
            : <>Photo-scanned models and textures from Poly Haven, released as CC0 (public domain): free for any use, no credit required. Files are checked against Poly Haven's checksums before they are saved. {kind === "models" ? "Place models from the World editor's 3D model button." : "Use textures as the ground in World settings."}</>}
        </p>
        <div className="row row--wrap" style={{ gap: 8 }}>
          <Segmented
            ariaLabel="Library section"
            value={kind}
            onChange={(k) => {
              setKind(k);
              // A sky needs at least 2k to look sharp behind the level; objects and textures start at 1k.
              setResolution(k === "skies" ? "2k" : "1k");
            }}
            options={[{ value: "models", label: "Models" }, { value: "textures", label: "Textures" }, { value: "skies", label: "Skies" }, { value: "characters", label: "Characters" }, { value: "sounds", label: "Sounds" }]}
          />
          {kind !== "characters" && kind !== "sounds" && (
            <>
          <div className="row" style={{ gap: 6, flex: 1, minWidth: 180 }}>
            <SearchIcon style={{ width: 14, height: 14, color: "var(--text-3)" }} />
            <input className="input" placeholder={kind === "skies" ? "Search: sunset, cloudy, meadow…" : "Search: rock, barrel, grass…"} aria-label="Search the library" value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }} />
          </div>
          {kind === "skies" ? (
            <Segmented ariaLabel="Sky resolution" value={resolution} onChange={setResolution} options={[{ value: "2k", label: "2k", tip: "About 5 MB; lights the level well, a little soft behind it" }, { value: "4k", label: "4k", tip: "About 20 MB; sharp behind the level" }]} />
          ) : (
            <Segmented ariaLabel="Texture resolution" value={resolution} onChange={setResolution} options={[{ value: "1k", label: "1k", tip: "Smaller files, fine for most objects" }, { value: "2k", label: "2k", tip: "Sharper close up, about four times the size" }]} />
          )}
            </>
          )}
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        {kind === "characters" && <Characters added={added} busy={busy} onAdd={(c) => void addCharacter(c)} />}
        {kind === "sounds" && <Sounds added={added} busy={busy} onAdd={(c) => void addSound(c)} />}
        {listKind && !list && !error && <div className="row small muted"><span className="spinner" /> Loading the {kind} list…</div>}
        {listKind && list && (
          <>
            <div className="xsmall muted">{filtered.length} {kind}{query ? ` matching "${query}"` : ""}</div>
            <div className="asset-grid" style={{ maxHeight: "52vh", overflow: "auto" }}>
              {filtered.slice(0, shown).map((a) => (
                <div key={a.id} className="asset-tile" style={{ cursor: "default" }}>
                  <Thumb id={a.id} />
                  <div className="asset-tile__meta">
                    <span className="small truncate" title={a.description || a.name}>{a.name}</span>
                    <span className="row xsmall muted" style={{ gap: 6 }}>
                      {a.dimensions ? `${(a.dimensions[0] / 1000).toFixed(1)} × ${(a.dimensions[1] / 1000).toFixed(1)} × ${(a.dimensions[2] / 1000).toFixed(1)} m` : a.categories.slice(0, 2).join(", ")}
                    </span>
                    <div className="row" style={{ gap: 4, marginTop: 4 }}>
                      <Button size="small" variant={added.includes(a.id) ? "ghost" : "primary"} icon={<DownloadIcon />} busy={busy === a.id} disabled={busy !== null && busy !== a.id} onClick={() => void add(a)}>
                        {added.includes(a.id) ? "Added" : "Add"}
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {filtered.length > shown && <Button size="small" onClick={() => setShown((n) => n + PAGE)}>Show more</Button>}
          </>
        )}
      </div>
    </Dialog>
  );
}
