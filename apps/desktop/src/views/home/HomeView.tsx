import { useEffect, useMemo, useState, type ReactNode } from "react";
import { TEMPLATES, type TemplateInfo } from "@gamestudio/project";
import { backend, errorMessage, type RecentProject } from "../../lib/backend";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { godotInstall, useEnv } from "../../state/env";
import { ENGINE_LABEL } from "./labels";
import { Button, IconButton, formatWhen } from "../../components/ui";
import { AtomIcon, BirdIcon, CloseIcon, CodeIcon, CubeIcon, DiceIcon, EditIcon, EnginesIcon, GameIcon, GemIcon, GraphIcon, LessonIcon, OpenIcon, PlayIcon, PlusIcon, SwordsIcon, XrIcon, CircleIcon, CommitIcon, BotIcon, WandIcon, TrophyIcon, SproutIcon, PersonIcon } from "../../components/icons";

const CATEGORY_ICON: Record<TemplateInfo["category"], ReactNode> = {
  traditional: <CircleIcon />,
  "3d": <GemIcon />,
  rpg: <SwordsIcon />,
  education: <LessonIcon />,
  logic: <GraphIcon />,
  xr: <XrIcon />,
  arcade: <GameIcon />,
  sports: <TrophyIcon />,
  simulation: <SproutIcon />,
};
type Category = TemplateInfo["category"];
/** Templates that share a kind but deserve their own picture. */
const TEMPLATE_ICON: Partial<Record<string, ReactNode>> = {
  ludo: <DiceIcon />,
  "adventure-3d": <SwordsIcon />,
  "exploration-unity": <CubeIcon />,
  "exploration-unreal": <CubeIcon />,
  "exploration-unreal-realistic": <PersonIcon />,
  "cpp-sfml-arcade": <CodeIcon />,
  "creature-collection": <BirdIcon />,
};
const iconFor = (id: string, category: Category): ReactNode => TEMPLATE_ICON[id] ?? CATEGORY_ICON[category];
/** What each kind of template is called in the gallery's filter. */
const CATEGORY_LABEL: Record<Category, string> = {
  traditional: "Board games",
  "3d": "3D",
  sports: "Sports",
  simulation: "Simulation",
  arcade: "Arcade",
  logic: "Logic",
  rpg: "RPG",
  education: "Learning",
  xr: "XR",
};
const RECENTS_SHOWN = 4;

const CATEGORY_HUE: Record<TemplateInfo["category"], string> = {
  traditional: "var(--amber)",
  "3d": "var(--accent)",
  rpg: "var(--violet)",
  education: "var(--blue)",
  logic: "var(--violet)",
  xr: "var(--accent)",
  arcade: "var(--green)",
  sports: "var(--amber)",
  simulation: "var(--green)",
};

function TemplateCard({ t }: { t: TemplateInfo }) {
  const openDialog = useApp((s) => s.openDialog);
  const planned = t.status === "planned";
  return (
    <button
      type="button"
      className="template-card card card--interactive"
      disabled={planned}
      data-tip={planned ? t.note : undefined}
      onClick={() => openDialog({ kind: "new-project", templateId: t.id })}
      aria-label={`${t.title}${planned ? " (planned)" : ""}`}
    >
      <div className="template-card__art" style={{ ["--hue" as string]: CATEGORY_HUE[t.category] }}>
        {iconFor(t.id, t.category)}
      </div>
      <div className="template-card__body">
        <div className="row" style={{ gap: 6 }}>
          <span className="template-card__title">{t.title}</span>
        </div>
        <p className="template-card__summary">{t.summary}</p>
        <div className="row row--wrap" style={{ gap: 6, marginTop: "auto" }}>
          <span className="badge badge--outline">{ENGINE_LABEL[t.engine]}</span>
          {t.status === "ready" && <span className="badge badge--green">Ready</span>}
          {t.status === "foundation" && <span className="badge badge--amber" data-tip={t.note}>Foundation</span>}
          {planned && <span className="badge">Planned</span>}
        </div>
      </div>
    </button>
  );
}

function ProjectCard({ r, isOpen, onPlay, onEdit, onForget }: { r: RecentProject; isOpen: boolean; onPlay: () => void; onEdit: () => void; onForget: () => void }) {
  const t = TEMPLATES.find((x) => x.id === r.template);
  const category: Category = t?.category ?? "logic";
  const missing = !r.exists;
  return (
    <div className={`project-card card ${isOpen ? "project-card--open" : ""} ${missing ? "project-card--missing" : ""}`} data-testid="project-card">
      <div className="project-card__art" style={{ ["--hue" as string]: CATEGORY_HUE[category] }}>{iconFor(r.template, category)}</div>
      <div className="project-card__body">
        <div className="project-card__head">
          <span className="project-card__title truncate" data-tip={r.path}>{r.title}</span>
          <IconButton small label={`Remove ${r.title} from recent projects`} tip="Remove from this list (the folder is not touched)" onClick={onForget}>
            <CloseIcon />
          </IconButton>
        </div>
        <span className="xsmall muted truncate">{t?.title ?? r.template}</span>
        <span className="xsmall muted">{missing ? "Folder not found" : isOpen ? "Open now" : `Opened ${formatWhen(r.openedAt)}`}</span>
        <div className="row" style={{ gap: 6, marginTop: "auto", paddingTop: 8 }}>
          <Button size="small" variant="primary" icon={<PlayIcon />} disabled={missing} tip={missing ? `Not found: ${r.path}` : undefined} aria-label={`Play ${r.title}`} onClick={onPlay}>Play</Button>
          <Button size="small" icon={<EditIcon />} disabled={missing} tip={missing ? `Not found: ${r.path}` : undefined} aria-label={`Edit ${r.title}`} onClick={onEdit}>Edit</Button>
        </div>
      </div>
    </div>
  );
}

function EnvRow({ icon, label, value, ok, action }: { icon: ReactNode; label: string; value: ReactNode; ok: boolean | null; action?: ReactNode }) {
  return (
    <div className="env-row">
      <span className="env-row__icon">{icon}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="small" style={{ color: "var(--text-2)" }}>{label}</div>
        <div className="xsmall muted truncate">{value}</div>
      </div>
      <span className={`dot ${ok === null ? "dot--busy" : ok ? "dot--ok" : "dot--warn"}`} />
      {action}
    </div>
  );
}

export function HomeView() {
  const info = useApp((s) => s.info);
  const setRoute = useApp((s) => s.setRoute);
  const toast = useApp((s) => s.toast);
  const openDialog = useApp((s) => s.openDialog);
  const open = useProject((s) => s.open);
  const openRoot = useProject((s) => s.root);
  const [kind, setKind] = useState<Category | "all">("all");
  const [allRecents, setAllRecents] = useState(false);
  const engines = useEnv((s) => s.engines);
  const providers = useEnv((s) => s.providers);
  const [recents, setRecents] = useState<RecentProject[] | null>(null);
  const reload = () => backend.recentsList().then(setRecents).catch(() => setRecents([]));
  useEffect(() => {
    void reload();
  }, []);
  const buildable = TEMPLATES.filter((t) => t.status !== "planned");
  // The kinds present, in the order they first appear, for the gallery's filter.
  const kinds = useMemo(() => [...new Set(buildable.map((t) => t.category))], [buildable]);
  const shownKind = (t: TemplateInfo) => kind === "all" || t.category === kind;
  const ready = TEMPLATES.filter((t) => t.status === "ready" && shownKind(t));
  const foundations = TEMPLATES.filter((t) => t.status === "foundation" && shownKind(t));
  const planned = TEMPLATES.filter((t) => t.status === "planned");
  const godot = godotInstall(engines);
  const ollama = providers?.find((p) => p.id === "ollama");
  const cloud = providers?.filter((p) => p.kind === "cloud") ?? [];

  /** Open a recent project (unless it is already open) and go to its Play or Workspace view. */
  const goTo = async (r: RecentProject, route: "play" | "workspace") => {
    if (r.path !== openRoot && !(await open(r.path))) return void reload();
    setRoute(route);
  };
  const shownRecents = (recents ?? []).slice(0, allRecents ? 20 : RECENTS_SHOWN);

  const openFolder = async () => {
    try {
      const path = await backend.pickDirectory("Open a Game Studio project folder");
      if (path) await open(path);
    } catch (e) {
      toast("error", "Cannot open folder", errorMessage(e));
    }
  };

  return (
    <div className="view">
      <div className="view__body view__body--padded">
        <div className="page home">
          <section className="home__hero">
            <div>
              <h1 className="home__title">Build games you can play, edit and understand.</h1>
              <p className="home__lead">Start from a template, change it with visual rules or the world map, ask the assistant for help, and run it in Godot. Every change stays editable.</p>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <Button variant="primary" size="large" icon={<PlusIcon />} onClick={() => openDialog({ kind: "new-project" })}>
                New project
              </Button>
              <Button size="large" icon={<WandIcon />} onClick={() => openDialog({ kind: "idea" })} tip="Describe a game or paste a link; the assistant plans an original first version from a template">
                Start from an idea
              </Button>
              <Button size="large" icon={<OpenIcon />} onClick={() => void openFolder()}>
                Open folder
              </Button>
            </div>
          </section>

          {recents !== null && recents.length > 0 && (
            <section className="stack" aria-label="Continue" data-testid="home-continue">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="row" style={{ gap: 10 }}>
                  <div className="section-label">Continue</div>
                  <span className="xsmall muted">Your recent projects. Play opens the game; Edit opens the workspace.</span>
                </div>
                {recents.length > RECENTS_SHOWN && (
                  <Button size="small" variant="ghost" onClick={() => setAllRecents((v) => !v)}>{allRecents ? "Show fewer" : `Show all ${recents.length}`}</Button>
                )}
              </div>
              <div className="project-grid">
                {shownRecents.map((r) => (
                  <ProjectCard
                    key={r.path}
                    r={r}
                    isOpen={r.path === openRoot}
                    onPlay={() => void goTo(r, "play")}
                    onEdit={() => void goTo(r, "workspace")}
                    onForget={() => void backend.recentsForget(r.path).then(reload)}
                  />
                ))}
              </div>
            </section>
          )}

          <div className="home__grid">
            <div className="stack" style={{ gap: 26 }}>
              <section className="stack">
                <div className="row row--wrap" style={{ justifyContent: "space-between", gap: 10 }}>
                  <div className="section-label">{recents && recents.length > 0 ? "Start a new game" : "Ready to play"}</div>
                  <div className="chips" role="group" aria-label="Kinds of game">
                    <button type="button" className="chip" aria-pressed={kind === "all"} onClick={() => setKind("all")}>All <span className="chip__count">{buildable.length}</span></button>
                    {kinds.map((k) => (
                      <button key={k} type="button" className="chip" aria-pressed={kind === k} onClick={() => setKind(k)}>
                        {CATEGORY_LABEL[k]} <span className="chip__count">{buildable.filter((t) => t.category === k).length}</span>
                      </button>
                    ))}
                  </div>
                </div>
                {ready.length > 0 ? <div className="template-grid">{ready.map((t) => <TemplateCard key={t.id} t={t} />)}</div> : <div className="xsmall muted">No ready templates of this kind yet; see the foundations below.</div>}
              </section>
              {foundations.length > 0 && <section className="stack">
                <div className="row">
                  <div className="section-label">Foundations</div>
                  <span className="xsmall muted">Working parts of larger modules. Each card says what is not built yet.</span>
                </div>
                <div className="template-grid">{foundations.map((t) => <TemplateCard key={t.id} t={t} />)}</div>
              </section>}
              {planned.length > 0 && <section className="stack">
                <div className="section-label">Planned</div>
                <div className="planned-list">
                  {planned.map((t) => (
                    <div key={t.id} className="planned-row">
                      <span className="planned-row__icon">{CATEGORY_ICON[t.category]}</span>
                      <span className="small" style={{ color: "var(--text-2)" }}>{t.title}</span>
                      <span className="xsmall muted truncate">{t.note}</span>
                    </div>
                  ))}
                </div>
              </section>}
            </div>

            <aside className="stack" style={{ gap: 22 }}>
              {recents !== null && recents.length === 0 && (
                <section className="card home__panel">
                  <div className="home__panel-head">
                    <span className="section-label">Your projects</span>
                  </div>
                  <div className="xsmall muted" style={{ padding: "0 14px 16px", lineHeight: 1.5 }}>Projects you create or open appear at the top of Home, with Play and Edit buttons.</div>
                </section>
              )}

              <section className="card home__panel">
                <div className="home__panel-head">
                  <span className="section-label">This computer</span>
                  <Button size="small" variant="ghost" onClick={() => setRoute("engines")}>Engines</Button>
                </div>
                <div className="stack" style={{ gap: 2, padding: "0 6px 8px" }}>
                  <EnvRow icon={<EnginesIcon />} label="Godot" ok={engines ? Boolean(godot) : null} value={godot ? `${godot.version} ${godot.channel} · ${godot.source}` : engines ? "Not installed. Install the official release from Engines." : "Checking…"} />
                  <EnvRow icon={<CommitIcon />} label="Snapshots (Git)" ok={info ? info.gitAvailable : null} value={info?.gitAvailable ? "Available: every project keeps a restorable history" : "Git not found: snapshots are unavailable"} />
                  <EnvRow icon={<BotIcon />} label="Local AI (Ollama)" ok={providers ? Boolean(ollama?.available) : null} value={ollama?.available ? ollama.models.join(", ") : ollama?.note ?? (providers ? "Not available" : "Checking…")} />
                  <EnvRow icon={<AtomIcon />} label="Cloud AI" ok={providers ? cloud.some((c) => c.allowed && c.available) || null : null} value={cloud.some((c) => c.allowed) ? `Allowed: ${cloud.filter((c) => c.available).map((c) => c.label).join(", ") || "no keys found"}` : "Off. Turn on in Settings to send context to a cloud provider."} />
                  <EnvRow icon={<CodeIcon />} label="App data" ok={true} value={info?.dataDir ?? ""} />
                </div>
              </section>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
