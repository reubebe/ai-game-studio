import { useEffect, useRef, useState } from "react";
import { backend, errorMessage } from "./lib/backend";
import { useApp } from "./state/app";
import { useEnv } from "./state/env";
import { useProject } from "./state/project";
import { useRuns } from "./state/runs";
import { Shell } from "./components/shell/Shell";
import { Button, Toasts, TooltipHost } from "./components/ui";
import { PlayIcon } from "./components/icons";
import { Dialogs } from "./views/dialogs";
import { HomeView } from "./views/home/HomeView";
import { NoProjectView } from "./views/home/NoProjectView";
import { WorkspaceView } from "./views/workspace/Workspace";
import { PlayView } from "./views/play/PlayView";
import { AssetsView } from "./views/assets/AssetsView";
import { AssistantView } from "./views/assistant/AssistantView";
import { EnginesView } from "./views/engines/EnginesView";
import { PluginsView } from "./views/plugins/PluginsView";
import { SettingsView } from "./views/settings/SettingsView";
import { runSmoke } from "./smoke";
import { ErrorBoundary } from "./components/ErrorBoundary";

function PlayAction() {
  const route = useApp((s) => s.route);
  const setRoute = useApp((s) => s.setRoute);
  if (route === "play") return null;
  return <Button size="small" variant="primary" icon={<PlayIcon />} tip="Play or run this project" onClick={() => setRoute("play")}>Play</Button>;
}

export function App() {
  const info = useApp((s) => s.info);
  const route = useApp((s) => s.route);
  const boot = useApp((s) => s.boot);
  const hasProject = useProject((s) => Boolean(s.root));
  const projectRoot = useProject((s) => s.root);
  const [bootError, setBootError] = useState<string | null>(null);
  const smokeStarted = useRef(false);

  useEffect(() => {
    boot().catch((e) => setBootError(errorMessage(e)));
    void useEnv.getState().refreshEngines();
    void useEnv.getState().refreshProviders();
    return backend.onRunEvent((e) => useRuns.getState().handle(e));
  }, [boot]);

  useEffect(() => {
    if (info?.smokeDir && !smokeStarted.current) {
      smokeStarted.current = true;
      void runSmoke(info.smokeDir, info.smokeExtras);
    }
  }, [info]);

  if (bootError) {
    return (
      <div className="empty" style={{ height: "100vh" }}>
        <div className="stack" style={{ alignItems: "center" }}>
          <h3>Game Studio could not start</h3>
          <p>{bootError}</p>
        </div>
      </div>
    );
  }
  if (!info) return <div style={{ height: "100vh", background: "var(--bg-0)" }} />;

  const needsProject = ["workspace", "play", "assets", "assistant"].includes(route);
  const view = needsProject && !hasProject ? <NoProjectView route={route} /> : (() => {
    switch (route) {
      case "workspace": return <WorkspaceView />;
      case "play": return <PlayView />;
      case "assets": return <AssetsView />;
      case "assistant": return <AssistantView key={projectRoot ?? ""} />;
      case "engines": return <EnginesView />;
      case "plugins": return <PluginsView />;
      case "settings": return <SettingsView />;
      default: return <HomeView />;
    }
  })();

  return (
    <>
      <Shell action={<PlayAction />}>
        <ErrorBoundary key={route} area={route} onHome={() => useApp.getState().setRoute("home")}>
          {view}
        </ErrorBoundary>
      </Shell>
      <Dialogs />
      <Toasts />
      <TooltipHost />
    </>
  );
}
