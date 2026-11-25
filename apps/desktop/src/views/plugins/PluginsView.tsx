import { useState } from "react";
import { BUILTIN_PLUGINS, checkExternalPlugin } from "@gamestudio/plugins";
import { useProject } from "../../state/project";
import { Button, Notice } from "../../components/ui";
import { CheckIcon } from "../../components/icons";

export function PluginsView() {
  const manifest = useProject((s) => s.manifest);
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const check = () => {
    try {
      const r = checkExternalPlugin(JSON.parse(text));
      setResult(r.ok ? { ok: true, lines: [`${r.plugin.name} ${r.plugin.version} is a valid declarative plugin manifest.`] } : { ok: false, lines: r.errors });
    } catch (e) {
      setResult({ ok: false, lines: [`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`] });
    }
  };
  return (
    <div className="view">
      <div className="view__header">
        <div>
          <div className="view__title">Plugins and modules</div>
          <div className="view__subtitle">Each module contributes rule domains, templates, editors, data types and assistant skills. Foundations say what is not built yet.</div>
        </div>
      </div>
      <div className="view__body view__body--padded">
        <div className="page stack" style={{ gap: 14 }}>
          <div className="template-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
            {BUILTIN_PLUGINS.map((p) => (
              <section key={p.id} className="card" style={{ padding: 16 }} data-testid={`plugin-${p.id}`}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <strong>{p.name}</strong>
                  <span className={`badge ${p.status === "stable" ? "badge--green" : p.status === "foundation" ? "badge--amber" : ""}`}>{p.status}</span>
                  <span className="spacer" />
                  {manifest?.modules.includes(p.id) && <span className="badge badge--accent">in this project</span>}
                </div>
                <div className="mono xsmall muted">{p.id} · {p.version} · {p.kind}</div>
                <p className="small" style={{ margin: "8px 0", lineHeight: 1.5, color: "var(--text-2)" }}>{p.description}</p>
                <dl className="kv">
                  {Object.entries(p.contributes).filter(([, v]) => v.length > 0).map(([k, v]) => (
                    <div key={k} style={{ display: "contents" }}>
                      <dt>{k.replace(/([A-Z])/g, " $1").toLowerCase()}</dt>
                      <dd className="mono xsmall">{v.join(", ")}</dd>
                    </div>
                  ))}
                  {p.requires.length > 0 && <><dt>requires</dt><dd className="mono xsmall">{p.requires.join(", ")}</dd></>}
                </dl>
                {p.limitations.length > 0 && <ul className="xsmall muted" style={{ margin: "8px 0 0", paddingLeft: 16, lineHeight: 1.5 }}>{p.limitations.map((l) => <li key={l}>{l}</li>)}</ul>}
              </section>
            ))}
          </div>
          <section className="card" style={{ padding: 16 }}>
            <div className="section-label" style={{ marginBottom: 6 }}>Check an external plugin manifest</div>
            <p className="small muted" style={{ lineHeight: 1.5, marginBottom: 10 }}>This version accepts declarative plugins only: they can describe templates, data and skills but cannot run code. Paste a plugin.json to validate it.</p>
            <textarea className="textarea input--mono" rows={6} aria-label="Plugin manifest JSON" placeholder='{ "id": "community.ludo", "name": "Ludo", ... }' value={text} onChange={(e) => setText(e.target.value)} />
            <div className="row" style={{ marginTop: 8 }}>
              <Button size="small" icon={<CheckIcon />} disabled={!text.trim()} onClick={check}>Validate</Button>
            </div>
            {result && <div style={{ marginTop: 10 }}><Notice kind={result.ok ? "ok" : "error"}>{result.lines.join(" · ")}</Notice></div>}
          </section>
        </div>
      </div>
    </div>
  );
}
