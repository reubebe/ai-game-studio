import { useEffect, useState, type ReactNode } from "react";
import { backend, errorMessage, type EngineReport, type InstallProgress } from "../../lib/backend";
import { useApp } from "../../state/app";
import { godotInstall, useEnv } from "../../state/env";
import { Button, Dialog, Notice, formatBytes } from "../../components/ui";
import { CodeIcon, CopyIcon, DownloadIcon, ExternalIcon, GemIcon, OpenIcon, RefreshIcon, ShieldIcon, BoxIcon, RocketIcon } from "../../components/icons";

const MARK: Record<EngineReport["id"], { icon: ReactNode; hue: string }> = {
  godot: { icon: <GemIcon />, hue: "var(--accent)" },
  unity: { icon: <BoxIcon />, hue: "var(--violet)" },
  unreal: { icon: <RocketIcon />, hue: "var(--amber)" },
  cpp: { icon: <CodeIcon />, hue: "var(--blue)" },
};
const GODOT_VERSION = "4.7.2";

type InstallKind = { kind: "godot" } | { kind: "templates"; version: string };

function installDetails(what: InstallKind) {
  if (what.kind === "godot") {
    return {
      title: `Install Godot ${GODOT_VERSION}`,
      intro: "Game Studio downloads the official macOS build and checks it before anything runs.",
      rows: [
        ["Source", `github.com/godotengine/godot-builds · ${GODOT_VERSION}-stable`],
        ["Size", "About 171 MB download, 340 MB installed"],
        ["Licence", "MIT (no account or licence acceptance)"],
        ["Checks", "SHA-512 against the release's checksum list, then Apple code-signature verification"],
        ["Location", "The studio's own engines folder; nothing is added to Applications or your PATH"],
      ],
      run: () => backend.engineInstallGodot(GODOT_VERSION),
      done: `Godot ${GODOT_VERSION} installed`,
    };
  }
  const v = what.version;
  return {
    title: `Install Godot ${v} export templates`,
    intro: "Export templates are the prebuilt game runtimes Godot packs a project into. One archive holds every platform; Game Studio builds macOS, Windows and Linux games and the web version for Play here from it.",
    rows: [
      ["Source", `github.com/godotengine/godot-builds · Godot_v${v}-stable_export_templates.tpz`],
      ["Size", "About 1.3 GB download, 1.9 GB installed"],
      ["Licence", "MIT, like Godot itself"],
      ["Checks", "SHA-512 against the release's checksum list; every file must sit inside templates/, with no links"],
      ["Location", `~/Library/Application Support/Godot/export_templates/${v}.stable, where Godot looks for them. An existing folder is never replaced.`],
    ],
    run: () => backend.engineInstallGodotTemplates(v),
    done: `Godot ${v} export templates installed`,
  };
}

function InstallDialog({ what, onClose }: { what: InstallKind; onClose: () => void }) {
  const refresh = useEnv((s) => s.refreshEngines);
  const toast = useApp((s) => s.toast);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => backend.onInstallProgress(setProgress), []);
  const details = installDetails(what);
  const install = async () => {
    setRunning(true);
    setError(null);
    try {
      const path = await details.run();
      toast("success", details.done, path);
      await refresh();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };
  const pct = progress?.total ? Math.round((progress.received / progress.total) * 100) : null;
  return (
    <Dialog
      title={details.title}
      onClose={() => !running && onClose()}
      footer={
        <>
          <Button onClick={onClose} disabled={running}>Cancel</Button>
          <Button variant="primary" icon={<DownloadIcon />} busy={running} onClick={() => void install()}>Download and install</Button>
        </>
      }
    >
      <p style={{ lineHeight: 1.55 }}>{details.intro}</p>
      <dl className="kv">
        {details.rows.map(([k, v]) => [<dt key={`${k}-t`}>{k}</dt>, <dd key={`${k}-d`} className={k === "Source" ? "mono xsmall" : undefined}>{v}</dd>])}
      </dl>
      {progress && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="row small"><ShieldIcon width={14} /> {progress.message}{pct !== null && progress.stage === "downloading" ? ` · ${pct}% (${formatBytes(progress.received)})` : ""}</div>
          {pct !== null && <div className="progress"><div className="progress__bar" style={{ width: `${pct}%` }} /></div>}
        </div>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </Dialog>
  );
}

function CopyCommand({ command }: { command: string }) {
  const toast = useApp((s) => s.toast);
  return (
    <div className="row" style={{ gap: 6 }}>
      <code className="mono small" style={{ flex: 1, padding: "5px 8px", background: "var(--bg-1)", borderRadius: 5, border: "1px solid var(--line)" }}>{command}</code>
      <Button size="small" icon={<CopyIcon />} tip="Copy the command. Game Studio does not run installers for you." onClick={() => void navigator.clipboard.writeText(command).then(() => toast("info", "Copied", command))}>Copy</Button>
    </div>
  );
}

function EngineCard({ report, onInstall }: { report: EngineReport; onInstall: (what: InstallKind) => void }) {
  const toast = useApp((s) => s.toast);
  const settings = useApp((s) => s.settings);
  const setSetting = useApp((s) => s.setSetting);
  const refresh = useEnv((s) => s.refreshEngines);
  const configured = typeof settings["engines.godot.path"] === "string" ? (settings["engines.godot.path"] as string) : null;
  const act = (p: Promise<unknown>) => p.catch((e) => toast("error", "Action failed", errorMessage(e)));
  const locate = async () => {
    const [path] = await backend.pickFiles("Locate the Godot application", ["app"], false);
    if (path && (await setSetting("engines.godot.path", path))) await refresh();
  };
  const engines = useEnv((s) => s.engines);
  const chosen = report.id === "godot" ? godotInstall(engines) : null;
  const status = (id: string) => report.capabilities.find((c) => c.id === id)?.status;
  const needsTemplates = chosen !== null && status("install-templates") === "available" && status("export") !== "available";
  const hub = report.tools.find((t) => t.name === "Unity Hub");
  const launcher = report.tools.find((t) => t.name === "Epic Games Launcher");
  return (
    <section className="card engine-card" data-testid={`engine-${report.id}`}>
      <div className="engine-card__head">
        <div className="engine-card__mark" style={{ ["--hue" as string]: MARK[report.id].hue }}>{MARK[report.id].icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row"><h3 style={{ fontSize: 16 }}>{report.name}</h3>{report.installs.length > 0 ? <span className="badge badge--green">{report.installs.length} found</span> : report.tools.some((t) => t.found) ? <span className="badge badge--blue">tools found</span> : <span className="badge">not found</span>}</div>
          <div className="small muted" style={{ marginTop: 2 }}>{report.summary}</div>
        </div>
        <div className="row row--wrap" style={{ justifyContent: "flex-end" }}>
          {report.id === "godot" && (
            <>
              <Button variant={report.installs.length ? "default" : "primary"} size="small" icon={<DownloadIcon />} disabled={backend.kind === "browser"} onClick={() => onInstall({ kind: "godot" })}>Install {GODOT_VERSION}</Button>
              {needsTemplates && <Button size="small" icon={<DownloadIcon />} tip="Needed to export standalone games (about 1.3 GB)" onClick={() => onInstall({ kind: "templates", version: chosen.version })}>Export templates</Button>}
              <Button size="small" icon={<OpenIcon />} disabled={backend.kind === "browser"} onClick={() => void locate()}>Locate…</Button>
            </>
          )}
          {report.id === "unity" && (hub?.found ? <Button size="small" icon={<OpenIcon />} onClick={() => act(backend.engineOpenTool("unity-hub"))}>Open Unity Hub</Button> : <Button size="small" icon={<ExternalIcon />} onClick={() => act(backend.openExternal("https://unity.com/download"))}>Get Unity Hub</Button>)}
          {report.id === "unreal" && (launcher?.found ? <Button size="small" icon={<OpenIcon />} onClick={() => act(backend.engineOpenTool("epic-launcher"))}>Open Epic Games Launcher</Button> : <Button size="small" icon={<ExternalIcon />} onClick={() => act(backend.openExternal("https://www.unrealengine.com/download"))}>Get Unreal Engine</Button>)}
          {report.officialUrl && report.id !== "unity" && report.id !== "unreal" && <Button size="small" variant="ghost" icon={<ExternalIcon />} onClick={() => act(backend.openExternal(report.officialUrl))}>Website</Button>}
        </div>
      </div>
      <div className="engine-card__body">
        <div className="engine-card__section">
          <div className="section-label">{report.installs.length ? "Installed versions" : report.tools.length ? "Tools" : "Installed versions"}</div>
          {report.installs.length === 0 && report.tools.length === 0 && <p className="small muted">Nothing found on this computer.</p>}
          {report.installs.map((i) => (
            <div key={i.executable} className="stack" style={{ gap: 2 }}>
              <div className="row small"><strong>{i.version}</strong><span className="badge badge--outline">{i.channel}</span>{i.flavor !== "standard" && <span className="badge">{i.flavor}</span>}<span className="badge">{i.source}</span>{i.compatible && <span className="badge badge--green">compatible</span>}</div>
              <div className="mono xsmall muted truncate" title={i.bundle ?? i.executable}>{i.bundle ?? i.executable}</div>
              {i.note && <div className="xsmall" style={{ color: "var(--amber)" }}>{i.note}</div>}
            </div>
          ))}
          {report.tools.map((t) => (
            <div key={t.name} className="row small" style={{ alignItems: "flex-start" }}>
              <span className={`dot ${t.found && !t.problem?.startsWith("exited") ? "dot--ok" : "dot--warn"}`} style={{ marginTop: 6 }} />
              <div style={{ minWidth: 0 }}>
                <div>{t.name} {t.version && <span className="muted">· {t.version}</span>}</div>
                {t.path && <div className="mono xsmall muted truncate">{t.path}</div>}
                {t.problem && <div className="xsmall muted">{t.problem}</div>}
                {!t.found && <div className="xsmall muted">Not found</div>}
              </div>
            </div>
          ))}
          {report.id === "godot" && configured && (
            <div className="row xsmall muted">Configured path: <span className="mono truncate">{configured}</span><Button size="small" variant="ghost" onClick={() => void setSetting("engines.godot.path", null).then(refresh)}>Clear</Button></div>
          )}
          {report.id === "unreal" && (
            <div className="stack" style={{ gap: 6 }}>
              {report.tools.find((t) => t.name === "Xcode" && t.problem?.includes("xcode-select")) && <CopyCommand command="sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" />}
              {report.tools.find((t) => t.name === "Metal toolchain" && !t.found) && <CopyCommand command="xcodebuild -downloadComponent MetalToolchain" />}
            </div>
          )}
          {report.id === "cpp" && (
            <div className="stack" style={{ gap: 6 }}>
              {report.tools.find((t) => t.name === "clang++" && !t.found) && <CopyCommand command="xcode-select --install" />}
              {report.tools.some((t) => (t.name === "CMake" || t.name === "SFML") && !t.found) && <CopyCommand command="brew install cmake sfml" />}
            </div>
          )}
        </div>
        <div className="engine-card__section">
          <div className="section-label">What Game Studio can do</div>
          {report.capabilities.map((c) => (
            <div key={c.id} className="cap-row">
              <span className={`badge ${c.status === "available" ? "badge--green" : c.status === "planned" ? "badge--outline" : "badge--amber"}`}>{c.status}</span>
              <div>
                <div>{c.label}</div>
                {c.reason && <div className="xsmall muted">{c.reason}</div>}
              </div>
            </div>
          ))}
          {report.notes.map((n, i) => <p key={i} className="xsmall muted" style={{ lineHeight: 1.5 }}>{n}</p>)}
        </div>
      </div>
    </section>
  );
}

export function EnginesView() {
  const engines = useEnv((s) => s.engines);
  const loading = useEnv((s) => s.loadingEngines);
  const error = useEnv((s) => s.engineError);
  const refresh = useEnv((s) => s.refreshEngines);
  const [installing, setInstalling] = useState<InstallKind | null>(null);
  return (
    <div className="view">
      <div className="view__header">
        <div style={{ flex: 1 }}>
          <div className="view__title">Engines</div>
          <div className="view__subtitle">Detected on this computer. Engines are installed only through official sources and only when you ask.</div>
        </div>
        <Button icon={<RefreshIcon />} busy={loading} onClick={() => void refresh()}>Check again</Button>
      </div>
      <div className="view__body view__body--padded">
        <div className="page stack" style={{ gap: 16 }}>
          {backend.kind === "browser" && <Notice kind="warn">The browser preview cannot inspect this computer. Run the desktop app to detect engines.</Notice>}
          {error && <Notice kind="error">{error}</Notice>}
          {!engines && loading && <div className="row small muted"><span className="spinner" /> Checking installed engines…</div>}
          {engines?.map((r) => <EngineCard key={r.id} report={r} onInstall={setInstalling} />)}
        </div>
      </div>
      {installing && <InstallDialog what={installing} onClose={() => setInstalling(null)} />}
    </div>
  );
}
