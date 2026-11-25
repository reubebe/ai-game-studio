import { IdeaDialog } from "./idea/IdeaDialog";
import { useEffect, useMemo, useState } from "react";
import { folderNameFor, TEMPLATES } from "@gamestudio/project";
import { backend, errorMessage, type Snapshot } from "../lib/backend";
import { useApp } from "../state/app";
import { useProject } from "../state/project";
import { godotInstall, unityInstall, unrealInstall, useEnv } from "../state/env";
import { Button, Dialog, Field, Notice, formatWhen } from "../components/ui";
import { FolderIcon, ResetIcon } from "../components/icons";
import { ENGINE_LABEL } from "./home/labels";

const DEFAULT_TITLES: Record<string, string> = {
  "oware-abapa": "Oware Evening",
  "oware-namnam": "Nam-nam Morning",
  "ayo": "Ayo Afternoon",
  "ludo": "Ludo Night",
  "exploration-3d": "Sun Crystal Valley",
  "adventure-3d": "Thornwood Ruins",
  "platformer-2d": "Sunset Cliffs",
  "football": "Harbour Cup Final",
  "farm-sim": "Sunrise Acres",
  "logic-sandbox": "Logic Sandbox",
  "creature-collection": "Forest Quest Creatures",
  "science-lesson": "Gait Basics Lesson",
  "xr-foundation": "Valley XR",
  "cpp-sfml-arcade": "Crystal Catcher",
  "exploration-unity": "Sun Crystal Valley Unity",
  "exploration-unreal": "Sun Crystal Valley Unreal",
  "exploration-unreal-realistic": "Realistic Valley",
};

function NewProjectDialog({ templateId }: { templateId?: string }) {
  const info = useApp((s) => s.info);
  const close = useApp((s) => s.closeDialog);
  const setRoute = useApp((s) => s.setRoute);
  const create = useProject((s) => s.create);
  const busy = useProject((s) => s.busy);
  const engines = useEnv((s) => s.engines);
  const available = TEMPLATES.filter((t) => t.status !== "planned");
  const groups = [
    { label: "Ready to play", items: available.filter((t) => t.status === "ready") },
    { label: "Foundations", items: available.filter((t) => t.status === "foundation") },
  ];
  // Nothing is picked until the person picks one (or came from a template's card on Home): opening on
  // the first template, in a closed list, made New project look as if it only made Oware games.
  const [template, setTemplate] = useState<string | null>(templateId && available.some((t) => t.id === templateId) ? templateId : null);
  const [title, setTitle] = useState(template ? DEFAULT_TITLES[template] ?? "New Game" : "");
  const [parent, setParent] = useState(info?.defaultProjectsDir ?? "");
  const [touchedTitle, setTouchedTitle] = useState(false);
  const pick = (id: string) => {
    setTemplate(id);
    // Set in the same update as the template, so the empty-title warning never flashes up.
    if (!touchedTitle) setTitle(DEFAULT_TITLES[id] ?? "New Game");
  };
  const t = TEMPLATES.find((x) => x.id === template) ?? null;
  const folder = useMemo(() => folderNameFor(title), [title]);
  const cpp = engines?.find((e) => e.id === "cpp");
  const needsGodot = t?.engine === "godot" && engines && !godotInstall(engines);
  const needsCpp = t?.engine === "cpp-sfml" && cpp && cpp.capabilities.find((c) => c.id === "sfml-template")?.status !== "available";
  const unity = t?.engine === "unity" && engines ? unityInstall(engines) : null;
  const needsUnity = t?.engine === "unity" && engines && !unity;
  const unreal = t?.engine === "unreal" && engines ? unrealInstall(engines) : null;
  const needsUnreal = t?.engine === "unreal" && engines && !unreal;
  // The realistic Unreal template copies Epic's Game Animation Sample, so it cannot be made without it.
  const sample =
    t?.id === "exploration-unreal-realistic" && engines
      ? (engines.find((e) => e.id === "unreal")?.capabilities.find((c) => c.id === "animation-sample") ?? { status: "unavailable", reason: "Checking for it needs the desktop app." })
      : null;
  const needsSample = Boolean(sample && sample.status !== "available");
  const titleError = !t ? null : title.trim() === "" ? "Give the project a title" : title.length > 120 ? "At most 120 characters" : null;

  const choose = async () => {
    const p = await backend.pickDirectory("Choose where to create the project");
    if (p) setParent(p);
  };
  const submit = async () => {
    if (!template || titleError || needsSample) return;
    if (await create(template, title.trim(), parent)) close();
  };

  return (
    <Dialog
      title="New project"
      wide
      onClose={close}
      footer={
        <>
          <span className="xsmall muted" style={{ marginRight: "auto" }}>{t ? "A Git snapshot is taken right after creation." : "Choose a template to create the project."}</span>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" busy={busy === "creating"} disabled={!t || Boolean(titleError) || !parent || needsSample} tip={needsSample ? "Needs Epic's Game Animation Sample first (see the note above)" : undefined} onClick={() => void submit()}>
            Create project
          </Button>
        </>
      }
    >
      <div className="field">
        <div className="field__label" id="np-template-label">Template</div>
        <div className="template-pick" role="radiogroup" aria-labelledby="np-template-label" tabIndex={-1} data-autofocus={t ? undefined : true}>
          {groups.map((g) => (
            <div key={g.label} className="template-pick__group">
              <div className="section-label">{g.label}</div>
              <div className="template-pick__grid">
                {g.items.map((x) => (
                  <label key={x.id} className="template-pick__option">
                    <input type="radio" name="np-template" value={x.id} checked={template === x.id} onChange={() => pick(x.id)} data-autofocus={template === x.id ? true : undefined} />
                    <span className="template-pick__title">{x.title}</span>
                    <span className="badge badge--outline">{ENGINE_LABEL[x.engine]}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <p className="small" style={{ lineHeight: 1.5 }}>
        {t ? (
          <>
            {t.summary}
            {t.note && <span className="muted"> {t.note}</span>}
          </>
        ) : (
          <span className="muted">Pick a template to see what it includes.</span>
        )}
      </p>
      <Field label="Title" htmlFor="np-title" error={titleError}>
        <input
          id="np-title"
          className="input"
          value={title}
          maxLength={120}
          aria-invalid={Boolean(titleError)}
          onChange={(e) => {
            setTitle(e.target.value);
            setTouchedTitle(true);
          }}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
      </Field>
      <Field label="Location" help={t ? <>The project folder will be <span className="mono">{parent}/{folder}</span></> : undefined}>
        <div className="row">
          <input className="input input--mono" value={parent} readOnly aria-label="Project location" />
          <Button icon={<FolderIcon />} onClick={() => void choose()} disabled={backend.kind === "browser"} tip={backend.kind === "browser" ? "The browser preview stores projects in this browser" : undefined}>
            Change
          </Button>
        </div>
      </Field>
      {needsGodot && (
        <Notice kind="warn">
          Godot is not installed yet. You can create and edit this project now; running it needs Godot 4.7.{" "}
          <a href="#" onClick={(e) => { e.preventDefault(); close(); setRoute("engines"); }}>Open Engines</a>
        </Notice>
      )}
      {needsCpp && <Notice kind="warn">Building this project needs a working CMake and SFML 3 (brew install cmake sfml). You can still create and edit it.</Notice>}
      {needsUnity && <Notice kind="warn">Unity is not installed. You can create and edit this project now; opening and building it needs Unity 6 from Unity Hub.</Notice>}
      {unity && <p className="xsmall muted">The project will use Unity {unity.version}, the editor found on this computer.</p>}
      {needsUnreal && <Notice kind="warn">Unreal Engine is not installed. You can create and edit this project now; building it needs Unreal Engine 5 from the Epic Games Launcher, plus Xcode.</Notice>}
      {unreal && <p className="xsmall muted">The project will use Unreal Engine {unreal.version}, found on this computer.</p>}
      {needsSample && (
        <Notice kind="warn">
          This template needs Epic's free Game Animation Sample on this Mac first. {sample?.reason}{" "}
          <a href="#" onClick={(e) => { e.preventDefault(); void backend.openExternal("https://www.fab.com/listings/880e319a-a59e-4ed2-b268-b32dac7fa016"); }}>Open it on Fab</a>
        </Notice>
      )}
      {sample && !needsSample && <p className="xsmall muted">{sample.reason}</p>}
    </Dialog>
  );
}

function SnapshotDialog() {
  const close = useApp((s) => s.closeDialog);
  const openDialog = useApp((s) => s.openDialog);
  const root = useProject((s) => s.root);
  const status = useProject((s) => s.snapshot);
  const takeSnapshot = useProject((s) => s.takeSnapshot);
  const restore = useProject((s) => s.restoreSnapshot);
  const [message, setMessage] = useState(`Checkpoint ${new Date().toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`);
  const [list, setList] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (root) backend.snapshotList(root, 30).then(setList).catch((e) => setError(errorMessage(e)));
  }, [root]);
  if (!status?.gitAvailable) {
    return (
      <Dialog title="Snapshots" onClose={close}>
        <Notice kind="warn">Snapshots use Git, which was not found on this computer. Install the Xcode Command Line Tools (xcode-select --install) to enable them.</Notice>
      </Dialog>
    );
  }
  return (
    <Dialog
      title="Snapshots"
      wide
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Close</Button>
          <Button variant="primary" busy={saving} disabled={!message.trim()} onClick={async () => { setSaving(true); if (await takeSnapshot(message.trim())) close(); setSaving(false); }}>
            Save snapshot
          </Button>
        </>
      }
    >
      <Field label="Describe this snapshot" htmlFor="snap-msg" help="Unsaved edits are saved first. Snapshots are Git commits inside the project folder.">
        <input id="snap-msg" className="input" value={message} maxLength={280} onChange={(e) => setMessage(e.target.value)} />
      </Field>
      <div className="section-label">History</div>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="snapshot-list">
        {list?.length === 0 && <div className="small muted">No snapshots yet.</div>}
        {list?.map((s, i) => (
          <div key={s.id} className="snapshot-row">
            <span className="mono xsmall muted">{s.shortId}</span>
            <span className="small truncate" style={{ flex: 1 }}>{s.message}</span>
            <span className="xsmall muted">{formatWhen(s.at)}</span>
            <Button
              size="small"
              icon={<ResetIcon />}
              disabled={i === 0 && !status.dirty}
              tip={i === 0 && !status.dirty ? "The project already matches this snapshot" : "Make the project match this snapshot. Current work is snapshotted first."}
              onClick={() =>
                openDialog({
                  kind: "confirm",
                  title: `Restore snapshot ${s.shortId}?`,
                  body: `The project will match "${s.message}". Your current state is saved as a snapshot first, so you can come back to it.`,
                  confirmLabel: "Restore",
                  onConfirm: async () => {
                    await restore(s.id);
                  },
                })
              }
            >
              Restore
            </Button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

function ConfirmDialog({ title, body, details, confirmLabel, danger, onConfirm, onCancel }: { title: string; body: string; details?: string[]; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void>; onCancel?: () => void }) {
  const close = useApp((s) => s.closeDialog);
  const [busy, setBusy] = useState(false);
  const cancel = () => {
    onCancel?.();
    close();
  };
  return (
    <Dialog
      title={title}
      onClose={cancel}
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} busy={busy} onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); close(); } }}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p style={{ lineHeight: 1.55 }}>{body}</p>
      {details && details.length > 0 && (
        <ul className="small" style={{ lineHeight: 1.55, paddingLeft: 18, margin: 0 }}>
          {details.map((d) => <li key={d}>{d}</li>)}
        </ul>
      )}
    </Dialog>
  );
}

export function Dialogs() {
  const dialog = useApp((s) => s.dialog);
  if (!dialog) return null;
  if (dialog.kind === "new-project") return <NewProjectDialog templateId={dialog.templateId} />;
  if (dialog.kind === "idea") return <IdeaDialog />;
  if (dialog.kind === "snapshot") return <SnapshotDialog />;
  return <ConfirmDialog {...dialog} />;
}
