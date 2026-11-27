import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { validateGraph, type RuleGraph } from "@gamestudio/rules-core";
import { parseWorld } from "@gamestudio/explore";
import { parseLevel } from "@gamestudio/platformer";
import { parseMatch } from "@gamestudio/football";
import { parseFarm } from "@gamestudio/farm";
import { parseCatalog } from "@gamestudio/rpg";
import { parseLesson } from "@gamestudio/learn";
import { MANIFEST_FILE, parseManifest } from "@gamestudio/project";
import { checkModules } from "@gamestudio/plugins";
import { backend, errorMessage, type AuditEntry, type FileEntry } from "../../lib/backend";
import { registry } from "../../lib/registry";
import { useApp } from "../../state/app";
import { useProject, type Doc } from "../../state/project";
import { useFocus } from "../../state/focus";
import { useRuns } from "../../state/runs";
import { Button, Empty, IconButton, Segmented, formatWhen } from "../../components/ui";
import { AssistantIcon, BookIcon, BoxIcon, PlayIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, CodeFileIcon, ErrorIcon, FileIcon, FolderIcon, GraphIcon, InfoIcon, JsonFileIcon, LessonIcon, MapIcon, OkIcon, SettingsIcon, SlidersIcon, SwordsIcon, TextFileIcon, TrashIcon, TrophyIcon, SproutIcon, WarnIcon, AssetsIcon } from "../../components/icons";
import { RuleEditor } from "../rules/RuleEditor";
import { WorldEditor } from "../world/WorldEditor";
import { LevelEditor } from "../level/LevelEditor";
import { MatchEditor } from "../match/MatchEditor";
import { FarmEditor } from "../farm/FarmEditor";
import { BinaryInfo, CppSettingsEditor, CreatureEditor, ImageViewer, JsonDocEditor, LessonEditor, ManifestEditor, MarkdownView, SceneViewer, TextDocEditor } from "../editors/DocEditors";

export interface Problem {
  path: string;
  severity: "error" | "warning";
  message: string;
  nodeId?: string;
}

export function projectProblems(docs: Record<string, Doc>, syncProblems: { source: string; messages: string[] }[]): Problem[] {
  const out: Problem[] = [];
  for (const doc of Object.values(docs)) {
    if (doc.error) {
      out.push({ path: doc.path, severity: "error", message: doc.error });
      continue;
    }
    if (doc.kind === "rules") for (const d of validateGraph(doc.data, registry).diagnostics) if (d.severity !== "info") out.push({ path: doc.path, severity: d.severity, message: d.message, ...(d.nodeId ? { nodeId: d.nodeId } : {}) });
    const check = doc.kind === "world" ? parseWorld(doc.data) : doc.kind === "level" ? parseLevel(doc.data) : doc.kind === "match" ? parseMatch(doc.data) : doc.kind === "farm" ? parseFarm(doc.data) : doc.kind === "creatures" ? parseCatalog(doc.data) : doc.kind === "lesson" ? parseLesson(doc.data) : doc.kind === "manifest" ? parseManifest(doc.data) : null;
    if (check && !check.ok) for (const e of check.errors) out.push({ path: doc.path, severity: "error", message: e });
    if (doc.kind === "manifest" && check?.ok) for (const m of checkModules((doc.data as { modules: string[] }).modules)) out.push({ path: doc.path, severity: "warning", message: m });
  }
  for (const p of syncProblems) out.push({ path: p.source, severity: "warning", message: `Game data not updated: ${p.messages[0] ?? "rules have errors"}` });
  return out;
}

export function fileIcon(path: string): ReactNode {
  if (path.endsWith(".rules.json")) return <GraphIcon />;
  if (path.endsWith(".json")) return <JsonFileIcon />;
  if (/\.(gd|cpp|hpp|h|cmake)$/.test(path) || path.endsWith("CMakeLists.txt")) return <CodeFileIcon />;
  if (path.endsWith(".tscn")) return <BoxIcon />;
  if (path.endsWith(".md")) return <TextFileIcon />;
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(path)) return <AssetsIcon />;
  return <FileIcon />;
}

function Outline() {
  const manifest = useProject((s) => s.manifest)!;
  const files = useProject((s) => s.files);
  const docs = useProject((s) => s.docs);
  const active = useProject((s) => s.activeTab);
  const openTab = useProject((s) => s.openTab);
  const mode = useApp((s) => s.mode);
  const item = (path: string, title: string, sub: string, icon: ReactNode) => (
    <button key={path} type="button" className="outline-item" aria-selected={active === path} onClick={() => void openTab(path)}>
      {icon}
      <span className="outline-item__text"><span className="outline-item__title">{title}</span><span className="outline-item__sub">{sub}</span></span>
    </button>
  );
  const group = (label: string, children: ReactNode[]) => children.length === 0 ? null : (
    <div className="outline-group" key={label}>
      <div className="section-label outline-group__label">{label}</div>
      {children}
    </div>
  );
  const godotDir = manifest.engine.id === "godot" ? manifest.engine.projectDir : null;
  const scenes = godotDir ? files.filter((f) => f.kind === "file" && f.path.startsWith(`${godotDir}/scenes/`) && f.path.endsWith(".tscn")) : [];
  const unityDir = manifest.engine.id === "unity" ? manifest.engine.projectDir : null;
  const unrealDir = manifest.engine.id === "unreal" ? manifest.engine.projectDir : null;
  const scripts = godotDir
    ? files.filter((f) => f.kind === "file" && f.path.startsWith(`${godotDir}/scripts/`) && f.path.endsWith(".gd"))
    : unityDir
      ? files.filter((f) => f.kind === "file" && f.path.startsWith(`${unityDir}/Assets/GameStudio/`) && f.path.endsWith(".cs"))
      : unrealDir
        ? files.filter((f) => f.kind === "file" && f.path.startsWith(`${unrealDir}/Source/`) && /\.(h|cpp)$/.test(f.path))
        : [];
  // Documents that came with add-ons (godot/addons/...) are someone else's notes, not this game's.
  const docsMd = files.filter((f) => f.kind === "file" && f.path.endsWith(".md") && !f.path.includes("/addons/") && (mode !== "creator" || !f.path.includes("/")));
  return (
    <div className="panel__body">
      {group("Project", [item(MANIFEST_FILE, "Project settings", manifest.title, <SettingsIcon />)])}
      {group(mode === "creator" ? "Behaviour" : "Rules", manifest.rules.map((r) => item(r.path, (docs[r.path]?.data as RuleGraph | undefined)?.name ?? r.id, r.path, <GraphIcon />)))}
      {group("Content", [
        ...manifest.data.map((d) => item(d.path, d.kind === "explore-world" ? "World layout" : d.kind === "platformer-level" ? "Level" : d.kind === "football-match" ? "Match settings" : d.kind === "farm-sim" ? "Farm" : d.kind === "creature-catalog" ? "Creatures" : d.kind === "lesson" ? `Lesson: ${d.id}` : d.id, d.path, d.kind === "explore-world" || d.kind === "platformer-level" ? <MapIcon /> : d.kind === "football-match" ? <TrophyIcon /> : d.kind === "farm-sim" ? <SproutIcon /> : d.kind === "creature-catalog" ? <SwordsIcon /> : <LessonIcon />)),
        ...(manifest.engine.id === "cpp-sfml" ? [item(`${manifest.engine.projectDir}/game.cfg`, "Game settings", `${manifest.engine.projectDir}/game.cfg`, <SlidersIcon />)] : []),
      ])}
      {mode !== "creator" && group("Godot scenes", scenes.map((f) => item(f.path, f.path.split("/").pop()!, f.path, <BoxIcon />)))}
      {mode === "developer" && group("Scripts", scripts.map((f) => item(f.path, f.path.split("/").pop()!, f.path, <CodeFileIcon />)))}
      {group("Documents", docsMd.map((f) => item(f.path, f.path === "README.md" ? "About this game" : f.path.split("/").pop()!, f.path, <BookIcon />)))}
    </div>
  );
}

interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNode[];
}

function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", dir: true, children: [] };
  const dirs = new Map<string, TreeNode>([["", root]]);
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    const parent = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    const node: TreeNode = { name: f.path.split("/").pop()!, path: f.path, dir: f.kind === "dir", children: [] };
    (dirs.get(parent) ?? root).children.push(node);
    if (node.dir) dirs.set(f.path, node);
  }
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

function FileTree() {
  const files = useProject((s) => s.files);
  const root = useProject((s) => s.root)!;
  const active = useProject((s) => s.activeTab);
  const openTab = useProject((s) => s.openTab);
  const refresh = useProject((s) => s.refresh);
  const closeTab = useProject((s) => s.closeTab);
  const openDialog = useApp((s) => s.openDialog);
  const toast = useApp((s) => s.toast);
  const tree = useMemo(() => buildTree(files), [files]);
  const [open, setOpen] = useState<Set<string>>(new Set(["rules", "data", "godot"]));
  const toggle = (p: string) => setOpen((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const row = (n: TreeNode, depth: number): ReactNode => (
    <div key={n.path}>
      <div className="row" style={{ gap: 0 }}>
        <button type="button" className="tree-item" style={{ paddingLeft: 8 + depth * 13 }} aria-selected={active === n.path} aria-expanded={n.dir ? open.has(n.path) : undefined} onClick={() => (n.dir ? toggle(n.path) : void openTab(n.path))}>
          {n.dir ? (open.has(n.path) ? <ChevronDownIcon /> : <ChevronRightIcon />) : <span style={{ width: 14 }} />}
          {n.dir ? <FolderIcon /> : fileIcon(n.path)}
          <span className="tree-item__name">{n.name}</span>
        </button>
        {!n.dir && n.path !== MANIFEST_FILE && (
          <IconButton small label={`Move ${n.name} to the project trash`} onClick={() => openDialog({ kind: "confirm", title: `Move ${n.name} to the trash?`, body: `${n.path} moves to .gamestudio/trash inside the project, so it can be recovered. Snapshots also keep earlier versions.`, confirmLabel: "Move to trash", danger: true, onConfirm: async () => { try { await backend.projectTrash(root, n.path); closeTab(n.path); await refresh(); } catch (e) { toast("error", "Not moved", errorMessage(e)); } } })}>
            <TrashIcon />
          </IconButton>
        )}
      </div>
      {n.dir && open.has(n.path) && n.children.map((c) => row(c, depth + 1))}
    </div>
  );
  return <div className="panel__body" style={{ paddingTop: 4 }}>{tree.map((n) => row(n, 0))}</div>;
}

/** Documents with a visual editor that Developer mode can also show as JSON. */
const JSON_VIEWABLE = new Set<Doc["kind"]>(["world", "level", "match", "farm", "creatures", "lesson"]);

function EditorFor({ doc }: { doc: Doc }) {
  const mode = useApp((s) => s.mode);
  const [asJson, setAsJson] = useState(false);
  if (doc.error) return <TextDocEditor doc={doc} />;
  if (mode === "developer" && JSON_VIEWABLE.has(doc.kind)) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div className="row" style={{ padding: "4px 10px", borderBottom: "1px solid var(--line)", gap: 8 }}>
          <span className="xsmall muted">Developer view</span>
          <Segmented ariaLabel="Show the document as" value={asJson ? "json" : "editor"} onChange={(v) => setAsJson(v === "json")} options={[{ value: "editor", label: "Editor" }, { value: "json", label: "JSON" }]} />
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>{asJson ? <JsonDocEditor doc={doc} /> : <VisualEditor doc={doc} />}</div>
      </div>
    );
  }
  return <VisualEditor doc={doc} />;
}

function VisualEditor({ doc }: { doc: Doc }) {
  switch (doc.kind) {
    case "rules": return <RuleEditor path={doc.path} />;
    case "world": return <WorldEditor path={doc.path} />;
    case "level": return <LevelEditor path={doc.path} />;
    case "match": return <MatchEditor path={doc.path} />;
    case "farm": return <FarmEditor path={doc.path} />;
    case "creatures": return <CreatureEditor doc={doc} />;
    case "lesson": return <LessonEditor doc={doc} />;
    case "scene": return <SceneViewer doc={doc} />;
    case "markdown": return <MarkdownView doc={doc} />;
    case "manifest": return <ManifestEditor doc={doc} />;
    case "cpp-settings": return <CppSettingsEditor doc={doc} />;
    case "image": return <ImageViewer doc={doc} />;
    case "binary": return <BinaryInfo doc={doc} />;
    default: return <TextDocEditor doc={doc} />;
  }
}

function BottomPanel() {
  const docs = useProject((s) => s.docs);
  const syncProblems = useProject((s) => s.syncProblems);
  const root = useProject((s) => s.root);
  const openTab = useProject((s) => s.openTab);
  const focus = useFocus((s) => s.focus);
  const runs = useRuns((s) => s.runs);
  const setRoute = useApp((s) => s.setRoute);
  const [tab, setTab] = useState<"problems" | "output" | "activity">("problems");
  const problems = useMemo(() => projectProblems(docs, syncProblems), [docs, syncProblems]);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  useEffect(() => {
    if (tab === "activity" && root) backend.auditList(root, 100).then(setAudit).catch(() => setAudit([]));
  }, [tab, root]);
  const latest = runs[0];
  return (
    <div className="bottom-panel">
      <div className="tabs" role="tablist">
        <button type="button" role="tab" className="tab" aria-selected={tab === "problems"} onClick={() => setTab("problems")}>Problems {problems.length > 0 && <span className="tab__count">{problems.length}</span>}</button>
        <button type="button" role="tab" className="tab" aria-selected={tab === "output"} onClick={() => setTab("output")}>Output {latest?.status === "running" && <span className="dot dot--busy" />}</button>
        <button type="button" role="tab" className="tab" aria-selected={tab === "activity"} onClick={() => setTab("activity")}>Activity</button>
      </div>
      <div className="panel__body">
        {tab === "problems" && (problems.length === 0 ? (
          <div className="row small" style={{ padding: 12, color: "var(--green)" }}><OkIcon width={14} /> No problems in the open documents.</div>
        ) : (
          <div className="problems">
            {problems.map((p, i) => (
              <button key={i} type="button" className={`problem-row problem-row--${p.severity}`} onClick={() => { void openTab(p.path); focus(p.path, p.nodeId ? { nodeId: p.nodeId } : undefined); }}>
                {p.severity === "error" ? <ErrorIcon /> : <WarnIcon />}
                <span>{p.message}</span>
                <span className="mono xsmall faint" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>{p.path}{p.nodeId ? ` · ${p.nodeId}` : ""}</span>
              </button>
            ))}
          </div>
        ))}
        {tab === "output" && (latest ? (
          <div className="console">
            <div className="console__line--studio">{latest.label} · {latest.status} · <a href="#" onClick={(e) => { e.preventDefault(); setRoute("play"); }}>open in Play</a></div>
            {latest.lines.slice(-300).map((l, i) => <div key={i} className={l.stream === "stderr" ? "console__line--stderr" : l.stream === "studio" ? "console__line--studio" : l.text.startsWith("GSTUDIO") ? "console__line--telemetry" : ""}>{l.text}</div>)}
          </div>
        ) : <div className="row small muted" style={{ padding: 12 }}><InfoIcon width={14} /> Run the game from Play to see engine output here.</div>)}
        {tab === "activity" && (
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
            <tbody>
              {(audit ?? []).map((a) => (
                <tr key={a.id}><td>{formatWhen(a.at)}</td><td>{a.actor}</td><td className="mono">{a.action}</td><td className="mono xsmall truncate" style={{ maxWidth: 420 }}>{JSON.stringify(a.detail)}</td></tr>
              ))}
              {audit?.length === 0 && <tr><td colSpan={4} className="muted">No recorded activity yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function WorkspaceView() {
  const mode = useApp((s) => s.mode);
  const tabs = useProject((s) => s.tabs);
  const active = useProject((s) => s.activeTab);
  const docs = useProject((s) => s.docs);
  const setActive = useProject((s) => s.setActive);
  const closeTab = useProject((s) => s.closeTab);
  const [explorer, setExplorer] = useState<"outline" | "files">(mode === "developer" ? "files" : "outline");
  useEffect(() => {
    setExplorer(mode === "developer" ? "files" : "outline");
  }, [mode]);
  const doc = active ? docs[active] : undefined;
  return (
    <div className="workspace">
      <Group orientation="horizontal" style={{ height: "100%" }}>
        <Panel id="explorer" defaultSize={250} minSize={190} maxSize={420} collapsible>
          <div className="panel">
            <div className="tabs" role="tablist" aria-label="Explorer">
              <button type="button" role="tab" className="tab" aria-selected={explorer === "outline"} onClick={() => setExplorer("outline")}>Outline</button>
              {mode !== "creator" && <button type="button" role="tab" className="tab" aria-selected={explorer === "files"} onClick={() => setExplorer("files")}>Files</button>}
            </div>
            {explorer === "outline" || mode === "creator" ? <Outline /> : <FileTree />}
          </div>
        </Panel>
        <Separator className="sep sep--v" />
        <Panel id="main" minSize={400}>
          <Group orientation="vertical" style={{ height: "100%" }}>
            <Panel id="editors" minSize={240}>
              <div className="panel" style={{ background: "var(--bg-1)" }}>
                <div className="tabs" role="tablist" aria-label="Open documents">
                  {tabs.map((t) => (
                    <div key={t} className="row" style={{ gap: 0 }}>
                      <button type="button" role="tab" className="tab" aria-selected={t === active} onClick={() => setActive(t)} title={t}>
                        {fileIcon(t)}
                        {t.split("/").pop()}
                        {docs[t]?.dirty && <span className="tab__dirty" aria-label="unsaved changes" />}
                      </button>
                      <button type="button" className="tab__close" aria-label={`Close ${t}`} onClick={() => closeTab(t)}><CloseIcon width={12} /></button>
                    </div>
                  ))}
                </div>
                <Coach />
                <div className="editor-host">{doc ? <EditorFor key={doc.path} doc={doc} /> : <Empty icon={<FileIcon />} title="Nothing open">Choose an item in the outline to open it.</Empty>}</div>
              </div>
            </Panel>
            {/* Problems, output and the activity log are for Designer and Developer; Creator keeps the room for the editor. */}
            {mode !== "creator" && <Separator className="sep sep--h" />}
            {mode !== "creator" && (
              <Panel id="bottom" defaultSize={120} minSize={34} collapsible>
                <BottomPanel />
              </Panel>
            )}
          </Group>
        </Panel>
      </Group>
    </div>
  );
}

/**
 * First steps for someone new: shown in the Workspace until dismissed (setting "ui.coach.done"), with buttons that
 * do each step.
 */
function Coach() {
  const settings = useApp((s) => s.settings);
  const setSetting = useApp((s) => s.setSetting);
  const setRoute = useApp((s) => s.setRoute);
  const manifest = useProject((s) => s.manifest);
  if (!settings || settings["ui.coach.done"] === true || !manifest) return null;
  const board = manifest.engine.id === "studio-board";
  const change = board ? "open the rules and change a setting, such as how many seeds each pit starts with" : "drag something from Add objects into the level, or change a setting on the right";
  const steps = [
    { key: "played", title: "Try it", text: <>press <strong>Play</strong> to play your game.</> },
    { key: "changed", title: "Change it", text: <>{change}.</> },
    { key: "asked", title: "Ask for help", text: <>the <strong>Assistant</strong> makes changes for you, for example "make the player a little faster".</> },
  ] as const;
  const ticked = steps.filter((s) => settings[`ui.coach.${s.key}`] === true).length;
  const all = ticked === steps.length;
  return (
    <div className={`coach ${all ? "coach--done" : ""}`} role="note" aria-label="First steps">
      {all ? (
        <div className="coach__done"><strong>You've played, changed and asked.</strong> That's how every game here is made: keep changing things and pressing Play.</div>
      ) : (
        <ol className="coach__steps">
          {steps.map((s) => {
            const done = settings[`ui.coach.${s.key}`] === true;
            return (
              <li key={s.key} className={done ? "coach__step--done" : ""} aria-label={`${s.title}${done ? " (done)" : ""}`}>
                <span className="coach__tick" aria-hidden="true">{done ? "✓" : ""}</span>
                <span><strong>{s.title}:</strong> {s.text}</span>
              </li>
            );
          })}
        </ol>
      )}
      <div className="row" style={{ gap: 6, flex: "none" }}>
        {!all && <span className="xsmall muted">{ticked} of {steps.length}</span>}
        {!all && <Button size="small" variant="primary" icon={<PlayIcon />} onClick={() => setRoute("play")}>Play now</Button>}
        {!all && <Button size="small" icon={<AssistantIcon />} onClick={() => setRoute("assistant")}>Assistant</Button>}
        <Button size="small" variant={all ? "primary" : "ghost"} onClick={() => void setSetting("ui.coach.done", true)}>{all ? "Done" : "Got it"}</Button>
      </div>
    </div>
  );
}
