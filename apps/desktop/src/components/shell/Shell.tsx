import { useEffect, type ReactNode } from "react";
import { backend } from "../../lib/backend";
import { useApp, type Route } from "../../state/app";
import { dirtyCount, useProject } from "../../state/project";
import { godotInstall, useEnv } from "../../state/env";
import { AssetsIcon, AssistantIcon, CloudIcon, EnginesIcon, GemIcon, HistoryIcon, HomeIcon, LocalIcon, PlayIcon, PluginsIcon, SaveIcon, SettingsIcon, WorkspaceIcon } from "../icons";
import { Button, Segmented } from "../ui";

// Each button shows a short name under its icon (icons alone were hard to find); the full name is its
// tooltip and its accessible name, which the tests and the self-test click by.
type RailEntry = { route: Route; label: string; short: string; icon: ReactNode; needsProject?: boolean };
const RAIL: RailEntry[] = [
  { route: "home", label: "Home", short: "Home", icon: <HomeIcon /> },
  { route: "workspace", label: "Workspace: rules, world and files", short: "Workspace", icon: <WorkspaceIcon />, needsProject: true },
  { route: "play", label: "Play and run", short: "Play", icon: <PlayIcon />, needsProject: true },
  { route: "assets", label: "Asset library", short: "Assets", icon: <AssetsIcon />, needsProject: true },
  { route: "assistant", label: "AI assistant", short: "Assistant", icon: <AssistantIcon />, needsProject: true },
];
const RAIL_BOTTOM: RailEntry[] = [
  { route: "engines", label: "Engines", short: "Engines", icon: <EnginesIcon /> },
  { route: "plugins", label: "Plugins and modules", short: "Plugins", icon: <PluginsIcon /> },
  { route: "settings", label: "Settings", short: "Settings", icon: <SettingsIcon /> },
];

function Rail() {
  const route = useApp((s) => s.route);
  const setRoute = useApp((s) => s.setRoute);
  const hasProject = useProject((s) => Boolean(s.root));
  // Every rail button works. Without an open project, a project screen explains itself and offers
  // New project, Open folder and recent projects (NoProjectView).
  const item = (r: RailEntry) => (
    <button key={r.route} type="button" className="rail__item" aria-label={r.label} aria-current={route === r.route ? "page" : undefined} data-tip={r.needsProject && !hasProject ? `${r.label} (needs an open project)` : r.label} onClick={() => setRoute(r.route)}>
      {r.icon}
      <span className="rail__label" aria-hidden>{r.short}</span>
    </button>
  );
  return (
    <nav className="rail" aria-label="Main navigation">
      {backend.kind === "browser" && (
        <div className="rail__brand" aria-hidden>
          <GemIcon />
        </div>
      )}
      {RAIL.map(item)}
      <div className="rail__spacer" />
      {RAIL_BOTTOM.map(item)}
    </nav>
  );
}

function TopBar({ action }: { action?: ReactNode }) {
  const mode = useApp((s) => s.mode);
  const setMode = useApp((s) => s.setMode);
  const openDialog = useApp((s) => s.openDialog);
  const manifest = useProject((s) => s.manifest);
  const docs = useProject((s) => s.docs);
  const busy = useProject((s) => s.busy);
  const save = useProject((s) => s.save);
  const dirty = dirtyCount(docs);
  return (
    <header className="topbar" data-tauri-drag-region>
      {backend.kind === "tauri" && <div style={{ width: 66, flex: "none" }} data-tauri-drag-region />}
      <div className="topbar__project" data-tauri-drag-region>
        {manifest ? (
          <>
            <span className="muted small" data-tauri-drag-region>
              Project
            </span>
            <span className="topbar__crumb">/</span>
            <span className="topbar__title" title={manifest.title}>
              {manifest.title}
            </span>
            <span className="badge badge--outline">{manifest.template.id}</span>
          </>
        ) : (
          <span className="topbar__title" data-tauri-drag-region>
            Universal AI Game Studio
          </span>
        )}
      </div>
      <Segmented
        ariaLabel="Work mode"
        value={mode}
        onChange={setMode}
        options={[
          { value: "creator", label: <><span className="segmented__dot" />Creator</>, tip: "Templates, forms and drag-and-drop" },
          { value: "designer", label: <><span className="segmented__dot" />Designer</>, tip: "Rule graphs, world layout and scenes" },
          { value: "developer", label: <><span className="segmented__dot" />Developer</>, tip: "Files, code, engine runs and diagnostics" },
        ]}
      />
      <div className="topbar__actions">
        {backend.kind === "browser" && (
          <span className="badge badge--amber" data-tip="Files are kept in this browser. Engines, imports and native dialogs need the desktop app.">
            Browser preview
          </span>
        )}
        {manifest && (
          <>
            <Button size="small" icon={<SaveIcon />} disabled={dirty === 0} busy={busy === "saving"} tip={dirty === 0 ? "No unsaved changes" : `Save ${dirty} change${dirty === 1 ? "" : "s"} (⌘S)`} onClick={() => void save()}>
              Save{dirty > 0 ? ` (${dirty})` : ""}
            </Button>
            <Button size="small" icon={<HistoryIcon />} tip="Save a restorable snapshot of the whole project (⌘⇧S)" onClick={() => openDialog({ kind: "snapshot" })}>
              Snapshot
            </Button>
            {action}
          </>
        )}
      </div>
    </header>
  );
}

function StatusBar() {
  const root = useProject((s) => s.root);
  const docs = useProject((s) => s.docs);
  const snapshot = useProject((s) => s.snapshot);
  const syncProblems = useProject((s) => s.syncProblems);
  const engines = useEnv((s) => s.engines);
  const providers = useEnv((s) => s.providers);
  const mode = useApp((s) => s.mode);
  const info = useApp((s) => s.info);
  const setRoute = useApp((s) => s.setRoute);
  const dirty = dirtyCount(docs);
  const godot = godotInstall(engines);
  const ollama = providers?.find((p) => p.id === "ollama");
  const cloud = providers?.filter((p) => p.kind === "cloud" && p.allowed && p.available) ?? [];
  return (
    <footer className="statusbar">
      {root ? (
        <>
          <button type="button" className="statusbar__item truncate" style={{ maxWidth: 360 }} data-tip={backend.kind === "tauri" ? "Show in Finder" : root} onClick={() => backend.kind === "tauri" && void backend.revealPath(root)}>
            <span className="truncate">{root}</span>
          </button>
          <span className="statusbar__item">
            <span className={`dot ${dirty ? "dot--warn" : "dot--ok"}`} />
            {dirty ? `${dirty} unsaved` : "Saved"}
          </span>
          {snapshot && (
            <span className="statusbar__item" data-tip={snapshot.head ? `Last snapshot: ${snapshot.head.message}` : "No snapshots yet"}>
              {snapshot.gitAvailable ? (snapshot.dirty ? "Changes since snapshot" : "Snapshot up to date") : "Snapshots need Git"}
            </span>
          )}
          {syncProblems.length > 0 && (
            <span className="statusbar__item" style={{ color: "var(--amber)" }} data-tip={syncProblems.map((p) => `${p.source}: ${p.messages.join(" ")}`).join("\n")}>
              Game data out of date
            </span>
          )}
        </>
      ) : (
        <span className="statusbar__item">No project open</span>
      )}
      <span className="spacer" />
      <button type="button" className="statusbar__item" onClick={() => setRoute("engines")} data-tip="Open the Engine Manager">
        <span className={`dot ${godot ? "dot--ok" : engines ? "dot--warn" : ""}`} />
        {godot ? `Godot ${godot.version}` : engines ? "Godot not installed" : "Checking engines"}
      </button>
      <button type="button" className="statusbar__item" onClick={() => setRoute("settings")} data-tip="AI providers">
        {cloud.length > 0 ? <CloudIcon /> : <LocalIcon />}
        {ollama?.available ? `Ollama · ${ollama.models.length} model${ollama.models.length === 1 ? "" : "s"}` : providers?.some((p) => p.available) ? "AI ready" : "No AI provider"}
        {cloud.length > 0 && ` · cloud on`}
      </button>
      <span className="statusbar__item" style={{ textTransform: "capitalize" }}>
        {mode}
      </span>
      {info && <span className="statusbar__item faint">v{info.version}</span>}
    </footer>
  );
}

export function Shell({ children, action }: { children: ReactNode; action?: ReactNode }) {
  const mode = useApp((s) => s.mode);
  const openDialog = useApp((s) => s.openDialog);
  const save = useProject((s) => s.save);
  const root = useProject((s) => s.root);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !root) return;
      if (e.key.toLowerCase() === "s" && e.shiftKey) {
        e.preventDefault();
        openDialog({ kind: "snapshot" });
      } else if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [root, save, openDialog]);
  return (
    <div className={`shell ${backend.kind === "browser" ? "shell--browser" : ""}`} data-mode={mode}>
      <Rail />
      <TopBar action={action} />
      <main className="content">{children}</main>
      <StatusBar />
    </div>
  );
}
