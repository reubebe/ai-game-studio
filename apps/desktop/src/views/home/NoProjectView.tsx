import { useEffect, useState, type ReactNode } from "react";
import { backend, errorMessage, type RecentProject } from "../../lib/backend";
import { useApp, type Route } from "../../state/app";
import { useProject } from "../../state/project";
import { Button, formatWhen } from "../../components/ui";
import { AssetsIcon, AssistantIcon, OpenIcon, PlayIcon, PlusIcon, WorkspaceIcon } from "../../components/icons";

const VIEWS: Partial<Record<Route, { title: string; what: string; icon: ReactNode }>> = {
  workspace: { title: "Workspace", what: "Here you edit a project's rules, world map and files.", icon: <WorkspaceIcon /> },
  play: { title: "Play and run", what: "Here you play a project, or build and run it with its game engine.", icon: <PlayIcon /> },
  assets: { title: "Asset library", what: "Here you keep a project's images, models and sounds, with their sources and licences.", icon: <AssetsIcon /> },
  assistant: { title: "AI assistant", what: "Here the assistant proposes changes to a project, and you approve each one.", icon: <AssistantIcon /> },
};

/** Shown instead of a project screen while no project is open: says what the screen is for and how to get there. */
export function NoProjectView({ route }: { route: Route }) {
  const openDialog = useApp((s) => s.openDialog);
  const toast = useApp((s) => s.toast);
  const open = useProject((s) => s.open);
  const [recents, setRecents] = useState<RecentProject[]>([]);
  useEffect(() => {
    backend.recentsList().then(setRecents).catch(() => setRecents([]));
  }, []);
  const v = VIEWS[route] ?? VIEWS.workspace!;

  const openFolder = async () => {
    try {
      const path = await backend.pickDirectory("Open a Game Studio project folder");
      if (path) await open(path);
    } catch (e) {
      toast("error", "Cannot open folder", errorMessage(e));
    }
  };

  const available = recents.filter((r) => r.exists).slice(0, 5);
  return (
    <div className="view">
      <div className="view__body view__body--padded">
        <div className="empty no-project">
          <div className="stack" style={{ alignItems: "center", gap: 12 }}>
            {v.icon}
            <h3>{v.title} needs an open project</h3>
            <p>{v.what} Create a project or open one, and you will land back here.</p>
            <div className="row" style={{ gap: 8, justifyContent: "center" }}>
              <Button variant="primary" icon={<PlusIcon />} onClick={() => openDialog({ kind: "new-project" })}>
                New project
              </Button>
              <Button icon={<OpenIcon />} onClick={() => void openFolder()}>
                Open folder
              </Button>
            </div>
            {available.length > 0 && (
              <div className="no-project__recents card">
                <div className="section-label" style={{ padding: "10px 14px 4px" }}>Recent projects</div>
                <div className="list" style={{ paddingBottom: 6 }}>
                  {available.map((r) => (
                    <div key={r.path} className="recent-row">
                      <button type="button" className="recent-row__main" onClick={() => void open(r.path)} data-tip={r.path}>
                        <span className="recent-row__title truncate">{r.title}</span>
                        <span className="xsmall muted truncate">{`${r.template} · ${formatWhen(r.openedAt)}`}</span>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
