import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { compileGraph, type RuleGraph } from "@gamestudio/rules-core";
import { bestMove, damageFor, parseCatalog, playRound, startEncounter, type Catalog, type EncounterState } from "@gamestudio/rpg";
import { grade, parseLesson, summarize, type Lesson, type Response } from "@gamestudio/learn";
import { DESKTOP_TARGETS, exportAppName, planGodotDesktopExport, planGodotExport, planGodotWebExport, UNITY_EXPORT_DIR, UNREAL_EXPORT_DIR, UNREAL_PROJECT, type DesktopExportPlan, type DesktopTarget } from "@gamestudio/project";
import { backend, errorMessage, type BackendError, type PlayWebInfo, type RunAction } from "../../lib/backend";
import { registry } from "../../lib/registry";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { useRuns, type RunRecord } from "../../state/runs";
import { godotInstall, unityInstall, unrealInstall, useEnv } from "../../state/env";
import { Button, Empty, Field, Notice, Switch } from "../../components/ui";
import { CheckIcon, CloseIcon, CodeIcon, EnginesIcon, ExternalIcon, FlaskIcon, GaugeIcon, OpenIcon, PackageIcon, PlayIcon, ResetIcon, RunIcon, StopIcon, SwordsIcon, TerminalIcon, WrenchIcon, XrIcon, OkIcon, ErrorIcon } from "../../components/icons";
import { OwarePlay } from "./OwarePlay";
import { LudoPlay } from "./LudoPlay";
import { WebGame } from "./WebGame";
import { Simulator } from "../rules/Simulator";

function Sparkline({ values, max }: { values: number[]; max: number }) {
  if (values.length < 2) return <svg className="sparkline" />;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${40 - Math.min(1, v / max) * 36}`).join(" ");
  return (
    <svg className="sparkline" viewBox="0 0 100 44" preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Console({ run, hideTelemetry }: { run: RunRecord; hideTelemetry: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [run.lines.length]);
  const lines = hideTelemetry ? run.lines.filter((l) => !l.text.startsWith("GSTUDIO ")) : run.lines;
  return (
    <div className="console" data-testid="run-console">
      {lines.map((l, i) => <div key={i} className={l.stream === "stderr" ? "console__line--stderr" : l.stream === "studio" ? "console__line--studio" : l.text.startsWith("GSTUDIO") ? "console__line--telemetry" : ""}>{l.text}</div>)}
      <div ref={end} />
    </div>
  );
}

function SmokeResult({ run }: { run: RunRecord }) {
  if (!run.smoke) return null;
  const checks = run.smoke.checks ?? [];
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row"><span className="section-label">Self-test</span><span className={`badge ${run.smoke.pass ? "badge--green" : "badge--red"}`}>{run.smoke.pass ? "passed" : "failed"}</span></div>
      {checks.map((c) => (
        <div key={c.name} className="check-row">
          {c.ok ? <OkIcon style={{ color: "var(--green)" }} /> : <ErrorIcon style={{ color: "var(--red)" }} />}
          <span>{c.name}</span>
          <span className="xsmall muted truncate">{c.detail}</span>
        </div>
      ))}
      {run.smoke.observations && <pre className="console" style={{ padding: 8, background: "var(--bg-2)", borderRadius: 6 }}>{JSON.stringify(run.smoke.observations, null, 1)}</pre>}
      {!run.smoke.checks && <pre className="console" style={{ padding: 8 }}>{JSON.stringify(run.smoke, null, 1)}</pre>}
    </div>
  );
}

interface RunActionSpec {
  action: RunAction;
  label: string;
  icon: ReactNode;
  primary?: boolean;
  tip: string;
  /** Set when this action cannot run yet; shown as the button's tooltip. */
  disabledReason?: string;
  /** File name of the app a build action writes. */
  output?: string;
  /** Name of the run in the run tabs, when it differs from the button's. */
  runLabel?: string;
}

function RunPanel({ engineLabel, actions, ready, notReadyReason, onBeforeRun, extra, stage }: { engineLabel: string; actions: RunActionSpec[]; ready: boolean; notReadyReason: string; onBeforeRun: (action: RunAction) => Promise<boolean>; extra?: ReactNode; stage?: ReactNode }) {
  const root = useProject((s) => s.root)!;
  const runs = useRuns((s) => s.runs);
  const start = useRuns((s) => s.start);
  const stop = useRuns((s) => s.stop);
  const setRoute = useApp((s) => s.setRoute);
  const openDialog = useApp((s) => s.openDialog);
  const [selected, setSelected] = useState<string | null>(null);
  const [hideTelemetry, setHideTelemetry] = useState(true);
  // When a game starts playing here, show its output rather than its build log.
  const newest = runs[0];
  useEffect(() => {
    if (newest?.action === "play-here" && newest.status === "running") setSelected(newest.id);
  }, [newest?.id, newest?.action, newest?.status]);
  const run = runs.find((r) => r.id === selected) ?? runs[0];
  // A game playing here has its own Stop; it does not hold up the engine buttons.
  const running = runs.find((r) => r.status === "running" && r.action !== "play-here");
  const launch = async (action: RunAction, label: string, output?: string) => {
    if (!(await onBeforeRun(action))) return;
    const id = await start(root, action, label, output);
    if (id) setSelected(id);
  };
  const perf = run?.perf ?? [];
  const last = perf[perf.length - 1];
  return (
    <div className="run-grid">
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div className="row row--wrap" style={{ padding: 12, borderBottom: "1px solid var(--line)", gap: 8 }}>
          <span className="small" style={{ marginRight: 6 }}>{engineLabel}</span>
          {actions.map((a) => (
            <Button key={a.action} variant={a.primary ? "primary" : "default"} size="small" icon={a.icon} disabled={!ready || Boolean(running) || Boolean(a.disabledReason)} tip={!ready ? notReadyReason : a.disabledReason ?? (running ? "Stop the current run first" : a.tip)} onClick={() => void launch(a.action, a.runLabel ?? a.label, a.output)}>
              {a.label}
            </Button>
          ))}
          {running && (
            <Button
              size="small"
              variant="danger"
              icon={<StopIcon />}
              tip={running.action === "editor" ? "Close the editor at once (asks first: nothing is saved)" : undefined}
              onClick={() =>
                // Stopping ends the process at once, so an editor would lose unsaved work: ask first.
                running.action === "editor"
                  ? openDialog({
                      kind: "confirm",
                      title: "Close the editor without saving?",
                      body: "Stop closes the editor at once and does not save. To keep your changes, save in the editor and quit it there; the run ends by itself.",
                      confirmLabel: "Close without saving",
                      danger: true,
                      onConfirm: () => void stop(running.id),
                    })
                  : void stop(running.id)
              }
            >
              Stop
            </Button>
          )}
          {extra}
          <span className="spacer" />
          {!ready && <Button size="small" icon={<EnginesIcon />} onClick={() => setRoute("engines")}>Open Engines</Button>}
        </div>
        {stage}
        {runs.length > 1 && (
          <div className="tabs">
            {runs.map((r) => (
              <button key={r.id} type="button" className="tab" aria-selected={r.id === run?.id} onClick={() => setSelected(r.id)}>
                <span className={`dot ${r.status === "running" ? "dot--busy" : r.status === "passed" ? "dot--ok" : r.status === "failed" ? "dot--error" : ""}`} />
                {r.label}
              </button>
            ))}
          </div>
        )}
        <div className={`panel__body${stage ? " panel__body--short" : ""}`} style={{ background: "var(--bg-0)" }}>
          {run ? <Console run={run} hideTelemetry={hideTelemetry} /> : <Empty icon={<TerminalIcon />} title="No runs yet">{ready ? "Run the game or a test. Output from the engine appears here, line by line." : notReadyReason}</Empty>}
        </div>
      </div>
      <aside className="run-side">
        <div className="panel__header"><span className="panel__title">Run</span>{run && <span className={`badge ${run.status === "passed" ? "badge--green" : run.status === "failed" ? "badge--red" : run.status === "running" ? "badge--accent" : ""}`}>{run.status}</span>}</div>
        <div style={{ padding: 12 }} className="stack">
          <Switch checked={hideTelemetry} onChange={setHideTelemetry} label="Hide telemetry lines in the console" />
          {run?.exit && <div className="xsmall muted">{run.exit.failedStep ? `${run.exit.failedStep} · exit ${run.exit.code ?? "?"}` : `Finished in ${(run.exit.durationMs / 1000).toFixed(1)} s`}</div>}
          {perf.length > 0 && (
            <>
              <div className="section-label"><GaugeIcon width={12} style={{ verticalAlign: -2 }} /> Performance (from the running game)</div>
              <div className="form-grid">
                <div className="metric"><span className="metric__value">{Math.round(last?.fps ?? 0)}</span><span className="metric__label">frames per second</span></div>
                <div className="metric"><span className="metric__value">{(last?.processMs ?? 0).toFixed(1)}</span><span className="metric__label">ms per frame (process)</span></div>
                <div className="metric"><span className="metric__value">{last?.drawCalls ?? 0}</span><span className="metric__label">draw calls</span></div>
                <div className="metric"><span className="metric__value">{last?.nodes ?? 0}</span><span className="metric__label">nodes</span></div>
              </div>
              <Sparkline values={perf.map((p) => p.fps)} max={Math.max(60, ...perf.map((p) => p.fps))} />
              {last?.player && <div className="xsmall muted" data-testid="player-position">Player at x {last.player[0].toFixed(1)}, z {last.player[2].toFixed(1)}</div>}
            </>
          )}
          {run && run.rules.length > 0 && (
            <>
              <div className="section-label">Rule activity</div>
              <div className="stack" style={{ gap: 4 }}>
                {run.rules.slice(-12).reverse().map((r, i) => (
                  <div key={i} className="xsmall" style={{ color: r.error ? "#ffaaa3" : "var(--text-2)" }}>
                    <span className="mono">{r.event}</span> {Object.values(r.payload).join(" ")} · {r.trace.length} nodes{r.error ? ` · ${r.error}` : ""}
                  </div>
                ))}
              </div>
            </>
          )}
          {run && <SmokeResult run={run} />}
        </div>
      </aside>
    </div>
  );
}

/** Play here builds already shown, so coming back to the Play view does not reopen a game that was stopped. */
const shownBuilds = new Set<string>();
/** The Export buttons' runs, newest first in the run list; Show in Finder follows the latest one. */
const EXPORT_ACTIONS: readonly RunAction[] = ["export", "export-windows", "export-linux"];

function GodotPlay() {
  const manifest = useProject((s) => s.manifest)!;
  const root = useProject((s) => s.root)!;
  const save = useProject((s) => s.save);
  const writeFiles = useProject((s) => s.writeFiles);
  const openDialog = useApp((s) => s.openDialog);
  const toast = useApp((s) => s.toast);
  const engines = useEnv((s) => s.engines);
  const runs = useRuns((s) => s.runs);
  // What each Export button built, relative to the project root, for Show in Finder.
  const [built, setBuilt] = useState<Partial<Record<RunAction, string>>>({});
  const [game, setGame] = useState<PlayWebInfo | null>(null);
  const godot = godotInstall(engines);
  const capability = (id: string) => engines?.find((e) => e.id === "godot")?.capabilities.find((c) => c.id === id);
  const unavailable = (id: string) => {
    const c = capability(id);
    return c?.status === "available" ? undefined : c?.reason ?? "Checking for export templates…";
  };
  const webCap = capability("play-web");
  // When a Play here build finishes, show it.
  const lastBuild = runs.find((r) => r.action === "web");
  useEffect(() => {
    if (!lastBuild || lastBuild.status !== "passed" || shownBuilds.has(lastBuild.id)) return;
    shownBuilds.add(lastBuild.id);
    backend.playWebOpen(root).then(setGame, (e) => toast("error", "Could not open the game", errorMessage(e)));
  }, [lastBuild?.id, lastBuild?.status, root, toast]);
  const actions: RunActionSpec[] = [
    {
      action: "web",
      label: "Play here",
      icon: <PlayIcon />,
      primary: true,
      tip: "Save, build the game for the web and play it inside Game Studio",
      runLabel: "Web build",
      disabledReason: webCap?.status === "available" ? undefined : webCap?.reason ?? "Checking for export templates…",
    },
    { action: "play", label: "Play in Godot", icon: <ExternalIcon />, tip: "Save, then run the game in a Godot window with live telemetry" },
    { action: "editor", label: "Open Godot editor", icon: <CodeIcon />, tip: "Edit scenes and scripts in the Godot editor" },
    { action: "smoke", label: "Self-test", icon: <FlaskIcon />, tip: "Headless check of loading, physics, movement, collecting, zones and rules" },
    { action: "conformance", label: "Rules conformance", icon: <CheckIcon />, tip: "Run the shared rule-runtime fixtures in Godot's GDScript runtime" },
    {
      action: "export",
      label: "Export for macOS",
      icon: <PackageIcon />,
      tip: "Build a standalone macOS app in exports/macos, then run the exported game's self-test",
      disabledReason: unavailable("export"),
    },
    {
      action: "export-windows",
      label: "Export for Windows",
      icon: <PackageIcon />,
      tip: "Build a 64-bit Windows game (an .exe with its .pck) in exports/windows, then self-test the exported game data here. The .exe itself runs only on Windows.",
      disabledReason: unavailable("export-windows"),
    },
    {
      action: "export-linux",
      label: "Export for Linux",
      icon: <PackageIcon />,
      tip: "Build a 64-bit Linux game (an x86_64 program with its .pck) in exports/linux, then self-test the exported game data here. The program itself runs only on Linux.",
      disabledReason: unavailable("export-linux"),
    },
  ];
  if (manifest.xr?.enabled) actions.push({ action: "xr", label: "XR scene", icon: <XrIcon />, tip: "Run the OpenXR scene (needs an OpenXR runtime and headset; not verified by the studio)" });

  const readOptional = async (path: string): Promise<string | null> => {
    try {
      return await backend.projectRead(root, path);
    } catch (e) {
      if ((e as BackendError | null)?.code === "not-found") return null;
      throw e;
    }
  };
  // Export needs a macOS preset, ETC2/ASTC textures and an ignored exports folder. New projects have
  // all three; older ones get them only after the user agrees to the listed changes.
  const prepareExport = async (): Promise<boolean> => {
    if (!(await save()) || manifest.engine.id !== "godot") return false;
    const dir = manifest.engine.projectDir;
    let plan: ReturnType<typeof planGodotExport>;
    try {
      plan = planGodotExport({ manifest, presets: await readOptional(`${dir}/export_presets.cfg`), projectGodot: await backend.projectRead(root, `${dir}/project.godot`), gitignore: await readOptional(".gitignore") });
    } catch (e) {
      toast("error", "Could not prepare the export", errorMessage(e));
      return false;
    }
    if (plan.problem) {
      toast("error", "Cannot export yet", plan.problem);
      return false;
    }
    const appPath = plan.appPath;
    if (appPath) setBuilt((b) => ({ ...b, export: appPath }));
    if (plan.writes.length === 0) return true;
    return new Promise<boolean>((resolve) =>
      openDialog({
        kind: "confirm",
        title: "Prepare this project for export?",
        body: "Game Studio will make these changes before exporting:",
        details: plan.changes,
        confirmLabel: "Make changes and export",
        onConfirm: async () => resolve(await writeFiles(plan.writes)),
        onCancel: () => resolve(false),
      }),
    );
  };
  // Windows and Linux exports need the platform's preset and an ignored exports folder. New projects have
  // both; older ones get them only after the user agrees to the listed changes.
  const prepareDesktop = async (target: DesktopTarget): Promise<boolean> => {
    if (!(await save()) || manifest.engine.id !== "godot") return false;
    let plan: DesktopExportPlan;
    try {
      plan = planGodotDesktopExport({ manifest, target, presets: await readOptional(`${manifest.engine.projectDir}/export_presets.cfg`), gitignore: await readOptional(".gitignore") });
    } catch (e) {
      toast("error", "Could not prepare the export", errorMessage(e));
      return false;
    }
    if (plan.problem || !plan.buildPath) {
      toast("error", "Cannot export yet", plan.problem ?? "The export has no file to write.");
      return false;
    }
    const buildPath = plan.buildPath;
    setBuilt((b) => ({ ...b, [`export-${target}`]: buildPath }));
    if (plan.writes.length === 0) return true;
    return new Promise<boolean>((resolve) =>
      openDialog({
        kind: "confirm",
        title: `Prepare this project for ${DESKTOP_TARGETS[target].label}?`,
        body: "Game Studio will make these changes before exporting:",
        details: plan.changes,
        confirmLabel: "Make changes and export",
        onConfirm: async () => resolve(await writeFiles(plan.writes)),
        onCancel: () => resolve(false),
      }),
    );
  };
  // Play here needs a Web preset (single-threaded) and an ignored exports folder. New projects have both;
  // older ones get them only after the user agrees to the listed changes.
  const prepareWeb = async (): Promise<boolean> => {
    setGame(null); // a new build replaces the game being played
    if (!(await save()) || manifest.engine.id !== "godot") return false;
    let plan: ReturnType<typeof planGodotWebExport>;
    try {
      plan = planGodotWebExport({ manifest, presets: await readOptional(`${manifest.engine.projectDir}/export_presets.cfg`), gitignore: await readOptional(".gitignore") });
    } catch (e) {
      toast("error", "Could not prepare Play here", errorMessage(e));
      return false;
    }
    if (plan.problem) {
      toast("error", "Cannot play here yet", plan.problem);
      return false;
    }
    if (plan.writes.length === 0) return true;
    return new Promise<boolean>((resolve) =>
      openDialog({
        kind: "confirm",
        title: "Prepare this project for Play here?",
        body: "Game Studio will make these changes before building the game for the web:",
        details: plan.changes,
        confirmLabel: "Make changes and play",
        onConfirm: async () => resolve(await writeFiles(plan.writes)),
        onCancel: () => resolve(false),
      }),
    );
  };
  const lastExport = runs.find((r) => EXPORT_ACTIONS.includes(r.action as RunAction));
  const exported = lastExport?.status === "passed" ? built[lastExport.action as RunAction] : undefined;
  const hint =
    manifest.template.id === "exploration-3d" || manifest.template.id === "adventure-3d"
      ? `Click the game to look around with the mouse · W A S D move · Space jump · E interact (villagers with a persona answer what you type)${manifest.template.id === "adventure-3d" ? " · F or click swings your staff · walk into blocks to push them" : ""} · F9 start over`
      : manifest.template.id === "platformer-2d"
        ? "Click the game, then A D or arrows run · Space jumps (hold for higher) · F9 start over"
        : manifest.template.id === "football"
          ? "Click the game, then W A S D run · Shift sprint · Space shoot · E pass or tackle · Q switch player · F9 restart"
          : manifest.template.id === "farm-sim"
            ? "Click the game, then W A S D walk · E works the tile in front (plant, water, harvest, sell, sleep) · Q next seed · F9 start over"
            : undefined;
  return (
    <RunPanel
      engineLabel={godot ? `Godot ${godot.version} (${godot.source})` : "Godot"}
      actions={actions}
      ready={Boolean(godot)}
      notReadyReason={backend.kind === "browser" ? "The browser preview cannot run engines. Open the desktop app to play in Godot." : engines ? "Godot is not installed. Install the official release, or locate an existing copy, in Engines." : "Checking for Godot…"}
      onBeforeRun={(action) => (action === "export" ? prepareExport() : action === "export-windows" ? prepareDesktop("windows") : action === "export-linux" ? prepareDesktop("linux") : action === "web" ? prepareWeb() : save())}
      extra={exported && <Button size="small" icon={<OpenIcon />} tip={`Show ${exported} in Finder`} onClick={() => void backend.revealPath(root, exported).catch((e) => toast("error", "Not shown", errorMessage(e)))}>Show in Finder</Button>}
      stage={game && <WebGame key={game.url} root={root} game={game} hint={hint} onClose={() => setGame(null)} />}
    />
  );
}

function UnityPlay() {
  const manifest = useProject((s) => s.manifest)!;
  const root = useProject((s) => s.root)!;
  const save = useProject((s) => s.save);
  const toast = useApp((s) => s.toast);
  const engines = useEnv((s) => s.engines);
  const runs = useRuns((s) => s.runs);
  const version = manifest.engine.id === "unity" ? manifest.engine.version : "";
  const install = unityInstall(engines, version);
  const build = engines?.find((e) => e.id === "unity")?.capabilities.find((c) => c.id === "build");
  const buildReason = build?.status === "available" ? undefined : build?.reason ?? "Checking Unity…";
  const appName = `${exportAppName(manifest.title)}.app`;
  const appPath = `${UNITY_EXPORT_DIR}/${appName}`;
  const built = runs.some((r) => (r.action === "build" || r.action === "play" || r.action === "smoke") && r.status === "passed");
  const installed = engines?.find((e) => e.id === "unity")?.installs.map((i) => i.version).join(", ");
  return (
    <RunPanel
      engineLabel={`Unity ${version}${install ? "" : " (not installed)"}`}
      actions={[
        { action: "editor", label: "Open in Unity", icon: <CodeIcon />, primary: true, tip: "Open the project in the Unity editor, on the main scene. The first time, Unity may ask you to accept its terms." },
        { action: "play", label: "Build and run", icon: <PlayIcon />, tip: `Build ${appName} into ${UNITY_EXPORT_DIR} and run it`, disabledReason: buildReason, output: appName },
        { action: "smoke", label: "Self-test", icon: <FlaskIcon />, tip: "Build, then run the game headlessly: loading, ground, walking and collecting", disabledReason: buildReason, output: appName },
        { action: "build", label: "Build only", icon: <WrenchIcon />, tip: `Build ${appName} into ${UNITY_EXPORT_DIR} without running it`, disabledReason: buildReason, output: appName },
      ]}
      ready={Boolean(install)}
      notReadyReason={
        backend.kind === "browser"
          ? "The browser preview cannot run engines. Open the desktop app."
          : !engines
            ? "Checking for Unity…"
            : `This project uses Unity ${version}${installed ? `; this computer has ${installed}` : ""}. Install ${version} with Unity Hub.`
      }
      onBeforeRun={() => save()}
      extra={
        <>
          {built && <Button size="small" icon={<OpenIcon />} tip={`Show ${appPath} in Finder`} onClick={() => void backend.revealPath(root, appPath).catch((e) => toast("error", "Not shown", errorMessage(e)))}>Show in Finder</Button>}
        </>
      }
    />
  );
}

function UnrealPlay() {
  const manifest = useProject((s) => s.manifest)!;
  const root = useProject((s) => s.root)!;
  const save = useProject((s) => s.save);
  const toast = useApp((s) => s.toast);
  const engines = useEnv((s) => s.engines);
  const runs = useRuns((s) => s.runs);
  const version = manifest.engine.id === "unreal" ? manifest.engine.version : "";
  const install = unrealInstall(engines, version);
  const report = engines?.find((e) => e.id === "unreal");
  const reason = (id: string) => {
    const c = report?.capabilities.find((x) => x.id === id);
    return c?.status === "available" ? undefined : c?.reason ?? "Checking Unreal Engine…";
  };
  const appPath = `${UNREAL_EXPORT_DIR}/Mac/${UNREAL_PROJECT}.app`;
  const built = runs.some((r) => (r.action === "build" || r.action === "play" || r.action === "smoke") && r.status === "passed");
  const installed = report?.installs.map((i) => i.version).join(", ");
  const slow = "The first package compiles shaders and takes several minutes.";
  return (
    <RunPanel
      engineLabel={`Unreal Engine ${version}${install ? "" : " (not installed)"}`}
      actions={[
        { action: "editor", label: "Open in Unreal", icon: <CodeIcon />, primary: true, tip: "Compile the C++ module, then open the project in the Unreal editor (press Play there)", disabledReason: reason("open-editor") },
        { action: "play", label: "Package and run", icon: <PlayIcon />, tip: `Package a macOS app into ${UNREAL_EXPORT_DIR} and run it. ${slow}`, disabledReason: reason("build") },
        { action: "smoke", label: "Self-test", icon: <FlaskIcon />, tip: `Package, then run the game headlessly: loading, ground, walking and collecting. ${slow}`, disabledReason: reason("build") },
        { action: "build", label: "Package only", icon: <WrenchIcon />, tip: `Package the macOS app into ${UNREAL_EXPORT_DIR} without running it. ${slow}`, disabledReason: reason("build") },
      ]}
      ready={Boolean(install)}
      notReadyReason={
        backend.kind === "browser"
          ? "The browser preview cannot run engines. Open the desktop app."
          : !engines
            ? "Checking for Unreal Engine…"
            : `This project uses Unreal Engine ${version}${installed ? `; this computer has ${installed}` : ""}. Install it from the Epic Games Launcher.`
      }
      onBeforeRun={() => save()}
      extra={
        <>
          {built && <Button size="small" icon={<OpenIcon />} tip={`Show ${appPath} in Finder`} onClick={() => void backend.revealPath(root, appPath).catch((e) => toast("error", "Not shown", errorMessage(e)))}>Show in Finder</Button>}
        </>
      }
    />
  );
}

function CppPlay() {
  const save = useProject((s) => s.save);
  const engines = useEnv((s) => s.engines);
  const cpp = engines?.find((e) => e.id === "cpp");
  const cap = cpp?.capabilities.find((c) => c.id === "sfml-template");
  return (
    <RunPanel
      engineLabel="C++ / SFML via CMake"
      actions={[
        { action: "play", label: "Build and run", icon: <PlayIcon />, primary: true, tip: "Configure, build and open the game window" },
        { action: "build", label: "Build", icon: <WrenchIcon />, tip: "Configure and build only" },
        { action: "test", label: "Unit tests", icon: <CheckIcon />, tip: "Build and run the CTest suite" },
        { action: "smoke", label: "Self-test", icon: <FlaskIcon />, tip: "Run the rules headlessly with an autopilot" },
      ]}
      ready={cap?.status === "available"}
      notReadyReason={backend.kind === "browser" ? "The browser preview cannot build C++. Open the desktop app." : cap?.reason ?? "Checking the C++ toolchain…"}
      onBeforeRun={() => save()}
    />
  );
}

function EncounterPlay({ catalogPath }: { catalogPath: string }) {
  const doc = useProject((s) => s.docs[catalogPath]);
  const parsed = useMemo(() => (doc && !doc.error ? parseCatalog(doc.data) : null), [doc]);
  const catalog: Catalog | null = parsed?.ok ? parsed.catalog : null;
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [state, setState] = useState<EncounterState | null>(null);
  const [rounds, setRounds] = useState<[string, string][]>([]);
  useEffect(() => {
    if (catalog && !a) {
      setA(catalog.creatures[0]?.id ?? "");
      setB(catalog.creatures[1]?.id ?? catalog.creatures[0]?.id ?? "");
    }
  }, [catalog, a]);
  if (!catalog) return <div style={{ padding: 20 }}><Notice kind="error">The creature catalog is invalid{parsed && !parsed.ok ? `: ${parsed.errors[0]}` : ""}.</Notice></div>;
  const begin = () => {
    setState(startEncounter(catalog, a, b));
    setRounds([]);
  };
  const move = (id: string) => {
    if (!state || state.winner) return;
    const reply = bestMove(catalog, state.b, state.a);
    setState(playRound(catalog, state, id, reply));
    setRounds((r) => [...r, [id, reply]]);
  };
  const name = (side: "a" | "b") => (state ? state[side].name : "");
  const moveName = (id: string) => (state ? [...state.a.moves, ...state.b.moves].find((m) => m.id === id)?.name ?? id : id);
  return (
    <div className="view__body view__body--padded">
      <div className="page stack" style={{ maxWidth: 860, gap: 18 }}>
        <div>
          <div className="view__title">Encounter simulator</div>
          <div className="view__subtitle">Deterministic: every move hits, the faster creature acts first, the opponent always picks its most damaging move.</div>
        </div>
        <div className="row row--wrap" style={{ gap: 10 }}>
          <Field label="Your creature"><select className="select" value={a} onChange={(e) => setA(e.target.value)}>{catalog.creatures.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Opponent"><select className="select" value={b} onChange={(e) => setB(e.target.value)}>{catalog.creatures.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <div style={{ alignSelf: "flex-end" }}><Button variant="primary" icon={<SwordsIcon />} onClick={begin}>Start encounter</Button></div>
        </div>
        {state && (
          <>
            <div className="form-grid">
              {(["a", "b"] as const).map((side) => (
                <div key={side} className="card" style={{ padding: 14 }}>
                  <div className="row"><strong>{state[side].name}</strong><span className="badge">{state[side].element}</span><span className="spacer" /><span className="mono small">{state[side].hp}/{state[side].maxHp}</span></div>
                  <div className="hp-bar" style={{ marginTop: 8 }}><div className="hp-bar__fill" style={{ width: `${(state[side].hp / state[side].maxHp) * 100}%`, background: state[side].hp / state[side].maxHp < 0.3 ? "var(--red)" : "var(--green)" }} /></div>
                </div>
              ))}
            </div>
            {!state.winner ? (
              <div className="row row--wrap">
                {state.a.moves.map((m) => {
                  const preview = damageFor(catalog, state.a, state.b, m);
                  return <Button key={m.id} onClick={() => move(m.id)} tip={m.description}>{m.name} · {preview.damage} dmg{preview.effectiveness !== 1 ? ` (×${preview.effectiveness})` : ""}</Button>;
                })}
              </div>
            ) : (
              <Notice kind={state.winner === "a" ? "ok" : "warn"}>{state.winner === "a" ? `${name("a")} wins` : `${name("b")} wins`} after {state.round} round{state.round === 1 ? "" : "s"}. Reward: {(state.events.at(-1) as { xp?: number } | undefined)?.xp ?? 0} XP.</Notice>
            )}
            <div className="card" style={{ padding: 12 }}>
              <div className="section-label" style={{ marginBottom: 6 }}>Log</div>
              {state.events.map((e, i) => (
                <div key={i} className="small">
                  {e.type === "move" ? `${name(e.side)} used ${moveName(e.move)}: ${e.damage} damage${e.effectiveness > 1 ? " (effective)" : e.effectiveness < 1 ? " (resisted)" : ""}` : e.type === "faint" ? `${name(e.side)} fainted` : `Encounter over`}
                </div>
              ))}
              <div className="xsmall muted" style={{ marginTop: 8 }}>Replay: <span className="mono">{JSON.stringify(rounds)}</span></div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function QuizPlay({ lessonPath }: { lessonPath: string }) {
  const doc = useProject((s) => s.docs[lessonPath]);
  const parsed = useMemo(() => (doc && !doc.error ? parseLesson(doc.data) : null), [doc]);
  const [responses, setResponses] = useState<Record<string, Response>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  if (!parsed?.ok) return <div style={{ padding: 20 }}><Notice kind="error">The lesson is invalid{parsed && !parsed.ok ? `: ${parsed.errors[0]}` : ""}.</Notice></div>;
  const lesson: Lesson = parsed.lesson;
  const summary = summarize(lesson, responses);
  const allChecked = lesson.questions.every((q) => checked[q.id]);
  return (
    <div className="view__body view__body--padded">
      <div className="page stack" style={{ maxWidth: 760, gap: 16 }}>
        <div>
          <div className="view__title">{lesson.title}</div>
          <div className="view__subtitle">{lesson.audience}</div>
        </div>
        <Notice kind={lesson.evidence.status === "validated" ? "ok" : "info"}><strong style={{ textTransform: "capitalize" }}>{lesson.evidence.status}.</strong> {lesson.evidence.statement}</Notice>
        <div className="card" style={{ padding: 14 }}>
          <div className="section-label" style={{ marginBottom: 6 }}>You will be able to</div>
          {lesson.objectives.map((o) => <div key={o} className="small">• {o}</div>)}
        </div>
        {lesson.questions.map((q, n) => {
          const done = checked[q.id];
          const right = done ? grade(q, responses[q.id] ?? null) : null;
          return (
            <div key={q.id} className="card" style={{ padding: 14 }} data-testid={`question-${q.id}`}>
              <div className="small" style={{ marginBottom: 10 }}><strong>{n + 1}.</strong> {q.prompt}</div>
              {q.kind === "numeric" ? (
                <div className="row">
                  <input className="input input--mono" style={{ width: 140 }} aria-label={`Answer to question ${n + 1}`} inputMode="decimal" disabled={done} onChange={(e) => setResponses((r) => ({ ...r, [q.id]: e.target.value.trim() === "" ? null : Number(e.target.value) }))} />
                  <span className="muted small">{q.unit}</span>
                </div>
              ) : (
                <div className="stack" style={{ gap: 6 }}>
                  {q.options.map((o, i) => {
                    const r = responses[q.id];
                    const picked = q.kind === "single" ? r === i : Array.isArray(r) && r.includes(i);
                    const isAnswer = q.kind === "single" ? q.answer === i : q.answers.includes(i);
                    return (
                      <button key={i} type="button" disabled={done} aria-pressed={picked} className={`quiz-option ${done && isAnswer ? "quiz-option--right" : ""} ${done && picked && !isAnswer ? "quiz-option--wrong" : ""}`} onClick={() => setResponses((rs) => ({ ...rs, [q.id]: q.kind === "single" ? i : picked ? (rs[q.id] as number[]).filter((x) => x !== i) : [...((rs[q.id] as number[] | undefined) ?? []), i] }))}>
                        {o}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="row" style={{ marginTop: 10 }}>
                {!done ? <Button size="small" variant="primary" disabled={responses[q.id] === undefined || responses[q.id] === null} tip={responses[q.id] === undefined || responses[q.id] === null ? "Choose or enter an answer first" : undefined} onClick={() => setChecked((c) => ({ ...c, [q.id]: true }))}>Check</Button> : (
                  <span className="row small" style={{ color: right ? "var(--green)" : "#ffaaa3" }}>{right ? <CheckIcon width={14} /> : <CloseIcon width={14} />}{right ? "Correct." : "Not quite."}</span>
                )}
              </div>
              {done && <p className="small muted" style={{ marginTop: 8, lineHeight: 1.5 }}>{q.explanation}</p>}
            </div>
          );
        })}
        {allChecked && (
          <Notice kind={summary.mastered ? "ok" : "warn"}>
            {summary.correct} of {summary.total} correct ({Math.round(summary.ratio * 100)}%). {summary.mastered ? "Mastery reached." : `Mastery needs ${Math.round(lesson.masteryThreshold * 100)}%.`}{" "}
            <Button size="small" variant="ghost" icon={<ResetIcon />} onClick={() => { setResponses({}); setChecked({}); }}>Try again</Button>
          </Notice>
        )}
      </div>
    </div>
  );
}

function SandboxPlay({ graphPath }: { graphPath: string }) {
  const doc = useProject((s) => s.docs[graphPath]);
  const compiled = useMemo(() => (doc && !doc.error ? compileGraph(doc.data as RuleGraph, registry) : null), [doc]);
  return (
    <div className="view__body" style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 20px 0" }}>
        <div className="view__title">Run the rules</div>
        <div className="view__subtitle">Fire events and watch variables and logs. Open the graph in the Workspace to see executed nodes light up.</div>
      </div>
      <Simulator program={compiled?.ok ? compiled.program ?? null : null} onTrace={() => {}} />
    </div>
  );
}

export function PlayView() {
  const manifest = useProject((s) => s.manifest);
  const loadDoc = useProject((s) => s.loadDoc);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!manifest) return;
    Promise.all([...manifest.rules.map((r) => loadDoc(r.path)), ...manifest.data.map((d) => loadDoc(d.path))]).then(() => setReady(true));
  }, [manifest, loadDoc]);
  if (!manifest || !ready) return null;
  if (manifest.engine.id === "godot") return <GodotPlay />;
  if (manifest.engine.id === "cpp-sfml") return <CppPlay />;
  if (manifest.engine.id === "unity") return <UnityPlay />;
  if (manifest.engine.id === "unreal") return <UnrealPlay />;
  const owareRules = manifest.rules.find((r) => r.domain === "oware");
  if (owareRules) return <OwarePlay graphPath={owareRules.path} />;
  const ludoRules = manifest.rules.find((r) => r.domain === "ludo");
  if (ludoRules) return <LudoPlay graphPath={ludoRules.path} />;
  const catalog = manifest.data.find((d) => d.kind === "creature-catalog");
  if (catalog) return <EncounterPlay catalogPath={catalog.path} />;
  const lesson = manifest.data.find((d) => d.kind === "lesson");
  if (lesson) return <QuizPlay lessonPath={lesson.path} />;
  const rules = manifest.rules[0];
  if (rules) return <SandboxPlay graphPath={rules.path} />;
  return <Empty icon={<RunIcon />} title="Nothing to play">This project has no playable content yet.</Empty>;
}
