import { useEffect, useState } from "react";
import { backend } from "../../lib/backend";
import { useApp, type Mode } from "../../state/app";
import { useEnv } from "../../state/env";
import { Button, Field, Notice, Segmented, Switch } from "../../components/ui";
import { CloudIcon, LocalIcon, ExternalIcon, ShieldIcon } from "../../components/icons";

const LICENSES: [string, string][] = [
  ["Tauri 2", "MIT or Apache-2.0"], ["React 19", "MIT"], ["React Flow (xyflow) 12", "MIT"], ["react-resizable-panels", "MIT"], ["Zustand", "MIT"], ["Zod", "MIT"],
  ["CodeMirror 6", "MIT"], ["Lucide icons", "ISC"], ["rusqlite / SQLite", "MIT / public domain"], ["reqwest", "MIT or Apache-2.0"], ["Godot Engine (separate download)", "MIT"], ["SFML (Homebrew)", "zlib"],
];

export function SettingsView() {
  const info = useApp((s) => s.info);
  const settings = useApp((s) => s.settings);
  const mode = useApp((s) => s.mode);
  const setMode = useApp((s) => s.setMode);
  const setSetting = useApp((s) => s.setSetting);
  const providers = useEnv((s) => s.providers);
  const refreshProviders = useEnv((s) => s.refreshProviders);
  const [consent, setConsent] = useState(false);
  const allowCloud = settings["ai.allowCloud"] === true;
  const usable = (providers ?? []).filter((p) => p.allowed && p.available);
  const chosen = usable.find((p) => p.id === settings["ai.defaultProvider"]);
  const modelOptions = chosen ? [...new Set([...chosen.suggestedModels, ...chosen.models])] : [];
  const savedModel = typeof settings["ai.defaultModel"] === "string" && modelOptions.includes(settings["ai.defaultModel"] as string) ? (settings["ai.defaultModel"] as string) : "";
  useEffect(() => {
    void refreshProviders();
  }, [allowCloud, refreshProviders]);
  return (
    <div className="view">
      <div className="view__header"><div className="view__title">Settings</div></div>
      <div className="view__body view__body--padded">
        <div className="page stack" style={{ maxWidth: 820, gap: 26 }}>
          <section className="stack">
            <div className="section-label">Work mode</div>
            <Segmented<Mode> ariaLabel="Default work mode" value={mode} onChange={setMode} options={[{ value: "creator", label: "Creator" }, { value: "designer", label: "Designer" }, { value: "developer", label: "Developer" }]} />
            <p className="small muted" style={{ lineHeight: 1.5 }}>Creator shows forms, the world map and plain-language rules. Designer adds the node graph, scenes and simulation. Developer adds files, code, raw JSON and compiled output. All modes edit the same project.</p>
          </section>

          <section className="stack">
            <div className="section-label">AI providers</div>
            <Notice kind="info">AI is optional: every project plays, saves and runs without it. Keys are read from environment variables (for example ANTHROPIC_API_KEY) and are never stored, logged or passed to games.</Notice>
            <div className="card" style={{ padding: 14 }}>
              {(providers ?? []).map((p) => (
                <div key={p.id} className="row" style={{ padding: "6px 0", borderBottom: "1px solid var(--line)", alignItems: "flex-start" }}>
                  {p.kind === "cloud" ? <CloudIcon width={15} style={{ marginTop: 2 }} /> : <LocalIcon width={15} style={{ marginTop: 2 }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="small">{p.label} <span className={`dot ${p.available && p.allowed ? "dot--ok" : p.available ? "dot--warn" : ""}`} /></div>
                    <div className="xsmall muted">{p.note}{p.credential ? ` (key from ${p.credential})` : ""}</div>
                    {p.models.length > 0 && <div className="xsmall mono muted truncate">{p.models.join(", ")}</div>}
                  </div>
                  {p.docs && <Button size="small" variant="ghost" icon={<ExternalIcon />} onClick={() => void backend.openExternal(p.docs).catch(() => {})}>Docs</Button>}
                </div>
              ))}
              <div className="stack" style={{ gap: 8, marginTop: 12 }}>
                {!allowCloud && (
                  <label className="row small" style={{ alignItems: "flex-start", gap: 8 }}>
                    <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
                    <span>I understand that cloud providers receive the project context I send (rules, layout, creature or lesson data) and bill my account for each request.</span>
                  </label>
                )}
                <Switch checked={allowCloud} disabled={!allowCloud && !consent} onChange={(v) => void setSetting("ai.allowCloud", v ? true : null)} label={allowCloud ? "Cloud providers allowed" : "Allow cloud providers"} />
              </div>
            </div>
            <div className="field-row" style={{ alignItems: "flex-start" }}>
              <Field label="Default provider" htmlFor="ai-default-provider" help="Answers for villagers who talk with players, and the first choice in the assistant and Start from an idea (each can still pick another there).">
                <select id="ai-default-provider" className="select" value={chosen?.id ?? ""} disabled={usable.length === 0} onChange={(e) => { void setSetting("ai.defaultProvider", e.target.value || null); void setSetting("ai.defaultModel", null); }}>
                  <option value="">{usable.length ? "Automatic (a local model first)" : "None ready"}</option>
                  {usable.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </Field>
              <Field label="Default model" htmlFor="ai-default-model" help={chosen ? "Smaller models answer villagers faster." : "Choose a provider first."}>
                <select id="ai-default-model" className="select" value={savedModel} disabled={!chosen} onChange={(e) => void setSetting("ai.defaultModel", e.target.value || null)}>
                  <option value="">Automatic</option>
                  {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </Field>
            </div>
          </section>

          <section className="stack">
            <div className="section-label">This installation</div>
            <dl className="kv">
              <dt>Version</dt><dd>{info?.version} ({info?.devBuild ? "development build" : "release"})</dd>
              <dt>Platform</dt><dd>{info?.platform} {info?.arch}</dd>
              <dt>App data</dt><dd className="mono xsmall">{info?.dataDir}</dd>
              <dt>New projects</dt><dd className="mono xsmall">{info?.defaultProjectsDir}</dd>
              <dt>Snapshots</dt><dd>{info?.gitAvailable ? "Git available" : "Git not found: snapshots disabled"}</dd>
            </dl>
          </section>

          <section className="stack">
            <div className="section-label"><ShieldIcon width={12} style={{ verticalAlign: -2 }} /> Safety boundaries</div>
            <ul className="small muted" style={{ lineHeight: 1.6, margin: 0, paddingLeft: 18 }}>
              <li>File access is limited to projects you open or create; symbolic links are not followed and hidden files other than .gitignore are off limits.</li>
              <li>Assets can be imported only from files you choose or drop on the window.</li>
              <li>Games and editors run without credential environment variables.</li>
              <li>Engines are installed only from official sources after you confirm, with checksum and signature checks.</li>
              <li>Assistant changes are typed, validated, shown before applying, and snapshotted.</li>
            </ul>
          </section>

          <section className="stack">
            <div className="section-label">Open-source components</div>
            <div className="form-grid">{LICENSES.map(([n, l]) => <div key={n} className="row small"><span style={{ flex: 1 }}>{n}</span><span className="muted">{l}</span></div>)}</div>
          </section>
        </div>
      </div>
    </div>
  );
}
