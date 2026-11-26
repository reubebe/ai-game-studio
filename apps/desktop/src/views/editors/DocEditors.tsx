import { useEffect, useMemo, useRef, useState } from "react";
import { BUILTIN_PLUGINS, checkModules, pluginById } from "@gamestudio/plugins";
import { parseCatalog, type Catalog, type Creature } from "@gamestudio/rpg";
import { parseLesson, type Lesson, type Question } from "@gamestudio/learn";
import type { ProjectManifest } from "@gamestudio/project";
import { backend, errorMessage } from "../../lib/backend";
import { useApp } from "../../state/app";
import { useProject, type Doc } from "../../state/project";
import { useRuns } from "../../state/runs";
import { godotInstall, useEnv } from "../../state/env";
import { Button, Empty, Field, Notice, NumberInput, Switch, TextInput } from "../../components/ui";
import { BoxIcon, EyeIcon, FileIcon, PlusIcon, TrashIcon, EditIcon, RunIcon } from "../../components/icons";
import { CodeEditor, languageLabel } from "./CodeEditor";
import { parseTscn, type SceneNode } from "./tscn";
import { renderMarkdown } from "./markdown";
import { readCfg, setCfgValue } from "./cfg";

export function TextDocEditor({ doc }: { doc: Doc }) {
  const updateDoc = useProject((s) => s.updateDoc);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {doc.error && <div style={{ padding: "8px 10px" }}><Notice kind="warn">{doc.error}. Showing the raw text; save once it is valid again.</Notice></div>}
      <div className="row xsmall muted" style={{ padding: "4px 12px", borderBottom: "1px solid var(--line)" }}>{languageLabel(doc.path)}</div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <CodeEditor path={doc.path} value={String(doc.data ?? "")} version={doc.version} onChange={(t) => updateDoc(doc.path, t)} />
      </div>
    </div>
  );
}

/**
 * A structured document (world, level, match, farm, project settings) as its JSON text. Each edit that parses
 * updates the document, so the visual editors see it at once; text that does not parse stays here with the
 * reason and is not applied.
 */
export function JsonDocEditor({ doc }: { doc: Doc }) {
  const updateDoc = useProject((s) => s.updateDoc);
  const format = (d: unknown) => `${JSON.stringify(d, null, 2)}\n`;
  const [text, setText] = useState(() => format(doc.data));
  const [shown, setShown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const mine = useRef(doc.version);
  useEffect(() => {
    // A change from elsewhere (the visual editor, the assistant, a reload): show it.
    if (doc.version === mine.current) return;
    mine.current = doc.version;
    setText(format(doc.data));
    setError(null);
    setShown((v) => v + 1);
  }, [doc.version, doc.data]);
  const change = (t: string) => {
    setText(t);
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch (e) {
      setError(`Not valid JSON yet (${errorMessage(e)}); the last valid version is kept.`);
      return;
    }
    setError(null);
    mine.current = doc.version + 1;
    updateDoc(doc.path, parsed);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="row xsmall muted" style={{ padding: "4px 12px", borderBottom: "1px solid var(--line)" }}>JSON · edits apply as soon as the text is valid</div>
      {error && <div style={{ padding: "6px 10px" }}><Notice kind="warn">{error}</Notice></div>}
      <div style={{ flex: 1, minHeight: 0 }}>
        <CodeEditor path={doc.path} value={text} version={shown} onChange={change} />
      </div>
    </div>
  );
}

function SceneTree({ node, depth, selected, onSelect }: { node: SceneNode; depth: number; selected: string; onSelect: (p: string) => void }) {
  return (
    <>
      <button type="button" className="scene-tree-node" style={{ paddingLeft: 8 + depth * 14 }} aria-selected={selected === node.path} onClick={() => onSelect(node.path)}>
        <BoxIcon width={13} />
        <span>{node.name}</span>
        <span className="faint xsmall">{node.type}</span>
      </button>
      {node.children.map((c) => <SceneTree key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />)}
    </>
  );
}

export function SceneViewer({ doc }: { doc: Doc }) {
  const mode = useApp((s) => s.mode);
  const root = useProject((s) => s.root);
  const manifest = useProject((s) => s.manifest);
  const start = useRuns((s) => s.start);
  const engines = useEnv((s) => s.engines);
  const scene = useMemo(() => parseTscn(String(doc.data ?? "")), [doc.data]);
  const [selected, setSelected] = useState("");
  const [raw, setRaw] = useState(false);
  const all: SceneNode[] = [];
  const walk = (n: SceneNode) => {
    all.push(n);
    n.children.forEach(walk);
  };
  if (scene.root) walk(scene.root);
  const node = all.find((n) => n.path === selected) ?? scene.root;
  const godot = godotInstall(engines);
  if (raw && mode === "developer") return <div style={{ height: "100%", display: "flex", flexDirection: "column" }}><div style={{ padding: 6 }}><Button size="small" onClick={() => setRaw(false)}>Back to scene tree</Button></div><div style={{ flex: 1 }}><TextDocEditor doc={doc} /></div></div>;
  return (
    <div className="split">
      <div className="split__list">
        <div className="panel__header"><span className="panel__title">Scene tree</span></div>
        <div style={{ padding: "6px 0" }}>{scene.root ? <SceneTree node={scene.root} depth={0} selected={node?.path ?? ""} onSelect={setSelected} /> : <p className="xsmall muted" style={{ padding: 12 }}>No nodes.</p>}</div>
      </div>
      <div className="split__main stack">
        <div className="row">
          <div>
            <div className="view__title" style={{ fontSize: 16 }}>{doc.path}</div>
            <div className="view__subtitle">Godot scene · {all.length} nodes · {scene.extResources.length} external resources</div>
          </div>
          <span className="spacer" />
          {mode === "developer" && <Button size="small" icon={<EditIcon />} onClick={() => setRaw(true)}>Edit as text</Button>}
          <Button size="small" icon={<RunIcon />} disabled={!godot || !root || manifest?.engine.id !== "godot"} tip={godot ? "Open the project in the Godot editor to change scenes" : "Install Godot from Engines first"} onClick={() => root && void start(root, "editor", "Godot editor")}>Open in Godot</Button>
        </div>
        <Notice>Scenes are edited in the Godot editor; this view shows their structure. In the exploration template the level's objects are built at runtime from data/world.json, so they appear in the game rather than in this file.</Notice>
        {scene.problems.length > 0 && <Notice kind="warn">{scene.problems.join(" ")}</Notice>}
        {node && (
          <div className="card" style={{ padding: 14 }}>
            <div className="row" style={{ marginBottom: 8 }}>
              <strong>{node.name}</strong>
              <span className="badge badge--violet">{node.type}</span>
              {node.groups.map((g) => <span key={g} className="badge badge--outline">group: {g}</span>)}
            </div>
            {node.instance && <div className="small muted">Instance of {scene.extResources.find((r) => r.id === node.instance)?.path ?? node.instance}</div>}
            {node.properties.length === 0 ? <p className="xsmall muted">No properties set in this file (defaults apply).</p> : (
              <dl className="kv" style={{ marginTop: 8 }}>
                {node.properties.map((p) => (
                  <div key={p.key} style={{ display: "contents" }}>
                    <dt className="mono">{p.key}</dt>
                    <dd className="mono xsmall">{p.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ManifestEditor({ doc }: { doc: Doc }) {
  const mode = useApp((s) => s.mode);
  const updateDoc = useProject((s) => s.updateDoc);
  const [raw, setRaw] = useState(false);
  const m = doc.data as ProjectManifest;
  const problems = useMemo(() => checkModules(m.modules ?? []), [m.modules]);
  if (doc.error) return <TextDocEditor doc={doc} />;
  if (raw) return <div style={{ height: "100%", display: "flex", flexDirection: "column" }}><div style={{ padding: 6 }}><Button size="small" onClick={() => setRaw(false)}>Back to form</Button></div><div style={{ flex: 1 }}><JsonDocEditor doc={doc} /></div></div>;
  return (
    <div className="view__body view__body--padded">
      <div className="page stack" style={{ maxWidth: 780, gap: 18 }}>
        <div className="row">
          <div className="view__title">Project settings</div>
          <span className="spacer" />
          {mode === "developer" && <Button size="small" icon={<EditIcon />} onClick={() => setRaw(true)}>Edit gamestudio.json</Button>}
        </div>
        <Field label="Title" htmlFor="m-title"><TextInput id="m-title" value={m.title} maxLength={120} onCommit={(title) => title.trim() && updateDoc(doc.path, { ...m, title: title.trim() })} /></Field>
        <Field label="Description" htmlFor="m-desc">
          <textarea id="m-desc" className="textarea" rows={3} maxLength={2000} key={m.description} defaultValue={m.description} onBlur={(e) => e.target.value !== m.description && updateDoc(doc.path, { ...m, description: e.target.value })} />
        </Field>
        <dl className="kv">
          <dt>Template</dt><dd>{m.template.id} {m.template.version}</dd>
          <dt>Engine</dt><dd>{m.engine.id} {m.engine.version}{"projectDir" in m.engine ? ` · folder ${m.engine.projectDir}/` : ""}</dd>
          <dt>Project id</dt><dd className="mono">{m.projectId}</dd>
          <dt>Created</dt><dd>{new Date(m.createdAt).toLocaleString()}</dd>
          <dt>Format</dt><dd>gamestudio.json {m.schemaVersion}</dd>
        </dl>
        <div className="stack" style={{ gap: 8 }}>
          <div className="section-label">Modules</div>
          {m.modules.map((id) => {
            const p = pluginById(id);
            return (
              <div key={id} className="row card" style={{ padding: "8px 12px" }}>
                <span className="small" style={{ flex: 1 }}>{p?.name ?? id}</span>
                <span className="mono xsmall muted">{id}</span>
                {p && <span className={`badge ${p.status === "stable" ? "badge--green" : "badge--amber"}`}>{p.status}</span>}
              </div>
            );
          })}
          {problems.length > 0 && <Notice kind="warn">{problems.join(" ")}</Notice>}
          <p className="xsmall muted">{BUILTIN_PLUGINS.length} built-in modules are available; see Plugins for what each one provides.</p>
        </div>
      </div>
    </div>
  );
}

export function MarkdownView({ doc }: { doc: Doc }) {
  const mode = useApp((s) => s.mode);
  const [edit, setEdit] = useState(false);
  const html = useMemo(() => renderMarkdown(String(doc.data ?? "")), [doc.data]);
  if (edit) return <div style={{ height: "100%", display: "flex", flexDirection: "column" }}><div style={{ padding: 6 }}><Button size="small" icon={<EyeIcon />} onClick={() => setEdit(false)}>Preview</Button></div><div style={{ flex: 1 }}><TextDocEditor doc={doc} /></div></div>;
  return (
    <div className="view__body">
      {mode !== "creator" && <div style={{ padding: "8px 26px 0" }}><Button size="small" icon={<EditIcon />} onClick={() => setEdit(true)}>Edit</Button></div>}
      <div
        className="markdown"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest("a[data-external]") as HTMLAnchorElement | null;
          if (a) {
            e.preventDefault();
            void backend.openExternal(a.href).catch((err) => useApp.getState().toast("error", "Link not opened", String(err?.message ?? err)));
          }
        }}
      />
    </div>
  );
}

export function ImageViewer({ doc }: { doc: Doc }) {
  const root = useProject((s) => s.root);
  const url = root && doc.path.startsWith("assets/") ? backend.assetUrl(root, doc.path) : null;
  return url ? (
    <div className="asset-tile__thumb" style={{ height: "100%" }}><img src={url} alt={doc.path} /></div>
  ) : (
    <Empty icon={<FileIcon />} title={doc.path}>Image previews are available for files in the assets folder in the desktop app.</Empty>
  );
}

function CreatureForm({ c, onChange }: { c: Creature; onChange: (c: Creature) => void }) {
  const set = <K extends keyof Creature>(k: K, v: Creature[K]) => onChange({ ...c, [k]: v });
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="form-grid">
        <Field label="Name" htmlFor="c-name"><TextInput id="c-name" value={c.name} maxLength={40} onCommit={(v) => set("name", v)} /></Field>
        <Field label="Element" htmlFor="c-el">
          <select id="c-el" className="select" value={c.element} onChange={(e) => set("element", e.target.value as Creature["element"])}>
            {["plain", "sun", "river", "forest"].map((x) => <option key={x}>{x}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Description" htmlFor="c-desc"><textarea id="c-desc" className="textarea" rows={2} key={c.description} defaultValue={c.description} onBlur={(e) => set("description", e.target.value)} /></Field>
      <div className="form-grid form-grid--4">
        {(["hp", "attack", "defense", "speed"] as const).map((k) => (
          <Field key={k} label={k === "hp" ? "HP" : k[0]!.toUpperCase() + k.slice(1)} htmlFor={`c-${k}`}><NumberInput id={`c-${k}`} value={c.stats[k]} min={1} max={255} onCommit={(n) => set("stats", { ...c.stats, [k]: Math.round(n) })} /></Field>
        ))}
      </div>
      <div className="section-label">Moves</div>
      {c.moves.map((m, i) => (
        <div key={i} className="card" style={{ padding: 12 }}>
          <div className="form-grid form-grid--4">
            <Field label="Name" htmlFor={`mv-n${i}`}><TextInput id={`mv-n${i}`} value={m.name} onCommit={(v) => set("moves", c.moves.map((x, j) => (j === i ? { ...x, name: v } : x)))} /></Field>
            <Field label="Id" htmlFor={`mv-i${i}`}><TextInput id={`mv-i${i}`} mono value={m.id} onCommit={(v) => set("moves", c.moves.map((x, j) => (j === i ? { ...x, id: v } : x)))} /></Field>
            <Field label="Element" htmlFor={`mv-e${i}`}>
              <select id={`mv-e${i}`} className="select" value={m.element} onChange={(e) => set("moves", c.moves.map((x, j) => (j === i ? { ...x, element: e.target.value as Creature["element"] } : x)))}>
                {["plain", "sun", "river", "forest"].map((x) => <option key={x}>{x}</option>)}
              </select>
            </Field>
            <Field label="Power" htmlFor={`mv-p${i}`}><NumberInput id={`mv-p${i}`} value={m.power} min={10} max={120} onCommit={(n) => set("moves", c.moves.map((x, j) => (j === i ? { ...x, power: Math.round(n) } : x)))} /></Field>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <TextInput ariaLabel="Move description" value={m.description} onCommit={(v) => set("moves", c.moves.map((x, j) => (j === i ? { ...x, description: v } : x)))} />
            <Button size="small" variant="ghost" icon={<TrashIcon />} disabled={c.moves.length <= 1} tip={c.moves.length <= 1 ? "A creature needs at least one move" : "Remove move"} onClick={() => set("moves", c.moves.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        </div>
      ))}
      <div><Button size="small" icon={<PlusIcon />} disabled={c.moves.length >= 4} tip={c.moves.length >= 4 ? "At most four moves" : undefined} onClick={() => set("moves", [...c.moves, { id: `move_${c.moves.length + 1}`, name: "New move", element: "plain", power: 30, description: "" }])}>Add move</Button></div>
      <div className="section-label">Provenance</div>
      <div className="form-grid">
        <Field label="Origin" htmlFor="c-origin">
          <select id="c-origin" className="select" value={c.provenance.origin} onChange={(e) => set("provenance", { ...c.provenance, origin: e.target.value as Creature["provenance"]["origin"] })}>
            <option value="original">Original</option>
            <option value="licensed">Licensed</option>
            <option value="third-party">Third-party</option>
          </select>
        </Field>
        <Field label="Author" htmlFor="c-author"><TextInput id="c-author" value={c.provenance.author} onCommit={(v) => set("provenance", { ...c.provenance, author: v })} /></Field>
        <Field label="Licence" htmlFor="c-lic"><TextInput id="c-lic" value={c.provenance.license} onCommit={(v) => set("provenance", { ...c.provenance, license: v })} /></Field>
        <Field label="Notes" htmlFor="c-notes"><TextInput id="c-notes" value={c.provenance.notes} onCommit={(v) => set("provenance", { ...c.provenance, notes: v })} /></Field>
      </div>
      {c.provenance.origin !== "original" && <Notice kind="warn">Record the licence and source for non-original designs. Never use creatures, names or art from existing franchises without permission.</Notice>}
    </div>
  );
}

export function CreatureEditor({ doc }: { doc: Doc }) {
  const updateDoc = useProject((s) => s.updateDoc);
  const catalog = doc.data as Catalog;
  const [selected, setSelected] = useState(catalog.creatures[0]?.id ?? "");
  const validation = useMemo(() => parseCatalog(catalog), [catalog]);
  const current = catalog.creatures.find((c) => c.id === selected);
  const set = (next: Catalog) => updateDoc(doc.path, next);
  const add = () => {
    let n = catalog.creatures.length + 1;
    while (catalog.creatures.some((c) => c.id === `creature_${n}`)) n++;
    const id = `creature_${n}`;
    set({ ...catalog, creatures: [...catalog.creatures, { id, name: "New creature", element: "plain", description: "", stats: { hp: 50, attack: 50, defense: 50, speed: 50 }, moves: [{ id: "tackle", name: "Tackle", element: "plain", power: 35, description: "" }], provenance: { origin: "original", author: "", license: "Project content", notes: "" } }] });
    setSelected(id);
  };
  return (
    <div className="split">
      <div className="split__list">
        <div className="panel__header"><span className="panel__title">Creatures ({catalog.creatures.length})</span></div>
        {catalog.creatures.map((c) => (
          <button key={c.id} type="button" className="outline-item" aria-selected={c.id === selected} onClick={() => setSelected(c.id)}>
            <span className="badge">{c.element}</span>
            <span className="outline-item__text"><span className="outline-item__title">{c.name}</span><span className="outline-item__sub">{c.id} · {c.provenance.origin}</span></span>
          </button>
        ))}
        <div style={{ padding: 10 }}><Button size="small" icon={<PlusIcon />} onClick={add}>Add creature</Button></div>
      </div>
      <div className="split__main">
        {!validation.ok && <div style={{ marginBottom: 12 }}><Notice kind="error">{validation.errors.slice(0, 4).join(" · ")}</Notice></div>}
        {current ? (
          <div className="stack" style={{ gap: 14, maxWidth: 820 }}>
            <div className="row">
              <div className="view__title">{current.name}</div>
              <span className="spacer" />
              <Button size="small" variant="danger" icon={<TrashIcon />} onClick={() => { set({ ...catalog, creatures: catalog.creatures.filter((c) => c.id !== current.id) }); setSelected(catalog.creatures[0]?.id ?? ""); }}>Delete</Button>
            </div>
            <CreatureForm key={current.id} c={current} onChange={(c) => set({ ...catalog, creatures: catalog.creatures.map((x) => (x.id === current.id ? c : x)) })} />
          </div>
        ) : (
          <Empty title="No creature selected">Add a creature or pick one from the list.</Empty>
        )}
      </div>
    </div>
  );
}

function QuestionEditor({ q, onChange, onDelete }: { q: Question; onChange: (q: Question) => void; onDelete: () => void }) {
  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="badge">{q.kind}</span>
        <span className="mono xsmall muted">{q.id}</span>
        <span className="spacer" />
        <Button size="small" variant="ghost" icon={<TrashIcon />} onClick={onDelete}>Remove</Button>
      </div>
      <Field label="Prompt" htmlFor={`q-${q.id}`}><textarea id={`q-${q.id}`} className="textarea" rows={2} key={q.prompt} defaultValue={q.prompt} onBlur={(e) => onChange({ ...q, prompt: e.target.value })} /></Field>
      {q.kind === "numeric" ? (
        <div className="form-grid form-grid--4" style={{ marginTop: 8 }}>
          <Field label="Answer" htmlFor={`qa-${q.id}`}><NumberInput id={`qa-${q.id}`} value={q.answer} onCommit={(n) => onChange({ ...q, answer: n })} /></Field>
          <Field label="Tolerance" htmlFor={`qt-${q.id}`}><NumberInput id={`qt-${q.id}`} value={q.tolerance} min={0} onCommit={(n) => onChange({ ...q, tolerance: n })} /></Field>
          <Field label="Unit" htmlFor={`qu-${q.id}`}><TextInput id={`qu-${q.id}`} value={q.unit} onCommit={(unit) => onChange({ ...q, unit })} /></Field>
        </div>
      ) : (
        <div className="stack" style={{ gap: 6, marginTop: 8 }}>
          {q.options.map((o, i) => {
            const correct = q.kind === "single" ? q.answer === i : q.answers.includes(i);
            return (
              <div key={i} className="row">
                <Switch checked={correct} label="" onChange={(on) => onChange(q.kind === "single" ? { ...q, answer: i } : { ...q, answers: on ? [...q.answers, i] : q.answers.filter((a) => a !== i) })} />
                <TextInput ariaLabel={`Option ${i + 1}`} value={o} onCommit={(v) => onChange({ ...q, options: q.options.map((x, j) => (j === i ? v : x)) } as Question)} />
              </div>
            );
          })}
        </div>
      )}
      <div style={{ marginTop: 8 }}><Field label="Explanation shown after answering" htmlFor={`qe-${q.id}`}><TextInput id={`qe-${q.id}`} value={q.explanation} onCommit={(explanation) => onChange({ ...q, explanation })} /></Field></div>
    </div>
  );
}

export function LessonEditor({ doc }: { doc: Doc }) {
  const updateDoc = useProject((s) => s.updateDoc);
  const lesson = doc.data as Lesson;
  const validation = useMemo(() => parseLesson(lesson), [lesson]);
  const set = (l: Lesson) => updateDoc(doc.path, l);
  return (
    <div className="view__body view__body--padded">
      <div className="page stack" style={{ maxWidth: 860, gap: 16 }}>
        {!validation.ok && <Notice kind="error">{validation.errors.slice(0, 4).join(" · ")}</Notice>}
        <div className="form-grid">
          <Field label="Title" htmlFor="l-title"><TextInput id="l-title" value={lesson.title} onCommit={(title) => set({ ...lesson, title })} /></Field>
          <Field label="Audience" htmlFor="l-aud"><TextInput id="l-aud" value={lesson.audience} onCommit={(audience) => set({ ...lesson, audience })} /></Field>
        </div>
        <div className="card" style={{ padding: 14 }}>
          <div className="section-label" style={{ marginBottom: 8 }}>Evidence label</div>
          <div className="form-grid">
            <Field label="Status" htmlFor="l-ev">
              <select id="l-ev" className="select" value={lesson.evidence.status} onChange={(e) => set({ ...lesson, evidence: { ...lesson.evidence, status: e.target.value as Lesson["evidence"]["status"] } })}>
                <option value="illustrative">Illustrative (teaching example)</option>
                <option value="simulated">Simulated (model output)</option>
                <option value="validated">Validated (needs sources)</option>
              </select>
            </Field>
            <Field label="Mastery threshold" htmlFor="l-mastery" help="Share of questions answered correctly.">
              <NumberInput id="l-mastery" value={lesson.masteryThreshold} min={0} max={1} step={0.05} onCommit={(masteryThreshold) => set({ ...lesson, masteryThreshold })} />
            </Field>
          </div>
          <div style={{ marginTop: 10 }}><Field label="Statement shown to learners" htmlFor="l-st"><TextInput id="l-st" value={lesson.evidence.statement} onCommit={(statement) => set({ ...lesson, evidence: { ...lesson.evidence, statement } })} /></Field></div>
        </div>
        <div className="section-label">Objectives</div>
        {lesson.objectives.map((o, i) => (
          <div key={i} className="row">
            <TextInput ariaLabel={`Objective ${i + 1}`} value={o} onCommit={(v) => set({ ...lesson, objectives: lesson.objectives.map((x, j) => (j === i ? v : x)) })} />
            <Button size="small" variant="ghost" icon={<TrashIcon />} disabled={lesson.objectives.length <= 1} onClick={() => set({ ...lesson, objectives: lesson.objectives.filter((_, j) => j !== i) })}>Remove</Button>
          </div>
        ))}
        <div><Button size="small" icon={<PlusIcon />} onClick={() => set({ ...lesson, objectives: [...lesson.objectives, "New objective"] })}>Add objective</Button></div>
        <div className="section-label">Questions ({lesson.questions.length})</div>
        {lesson.questions.map((q, i) => (
          <QuestionEditor key={q.id} q={q} onChange={(nq) => set({ ...lesson, questions: lesson.questions.map((x, j) => (j === i ? nq : x)) })} onDelete={() => set({ ...lesson, questions: lesson.questions.filter((_, j) => j !== i) })} />
        ))}
        <div className="row">
          <Button size="small" icon={<PlusIcon />} onClick={() => { let n = lesson.questions.length + 1; while (lesson.questions.some((q) => q.id === `question_${n}`)) n++; set({ ...lesson, questions: [...lesson.questions, { id: `question_${n}`, kind: "single", prompt: "New question", options: ["First option", "Second option"], answer: 0, explanation: "" }] }); }}>Add multiple-choice question</Button>
          <Button size="small" icon={<PlusIcon />} onClick={() => { let n = lesson.questions.length + 1; while (lesson.questions.some((q) => q.id === `question_${n}`)) n++; set({ ...lesson, questions: [...lesson.questions, { id: `question_${n}`, kind: "numeric", prompt: "New question", answer: 0, tolerance: 0, unit: "", explanation: "" }] }); }}>Add numeric question</Button>
        </div>
      </div>
    </div>
  );
}

const CPP_KEYS: { key: string; label: string; min: number; max: number; step?: number; integer?: boolean }[] = [
  { key: "player_speed", label: "Player speed (px/s)", min: 50, max: 2000 },
  { key: "player_width", label: "Paddle width (px)", min: 20, max: 400 },
  { key: "fall_speed", label: "Fall speed (px/s)", min: 20, max: 1500 },
  { key: "speed_up_per_crystal", label: "Speed-up per crystal", min: 0, max: 100 },
  { key: "spawn_interval", label: "Seconds between crystals", min: 0.1, max: 10, step: 0.05 },
  { key: "lives", label: "Lives", min: 1, max: 99, integer: true },
  { key: "target_score", label: "Crystals to win", min: 1, max: 9999, integer: true },
  { key: "seed", label: "Random seed", min: 0, max: 4294967295, integer: true },
];

export function CppSettingsEditor({ doc }: { doc: Doc }) {
  const updateDoc = useProject((s) => s.updateDoc);
  const mode = useApp((s) => s.mode);
  const text = String(doc.data ?? "");
  const values = readCfg(text);
  if (mode === "developer") return <TextDocEditor doc={doc} />;
  return (
    <div className="view__body view__body--padded">
      <div className="page stack" style={{ maxWidth: 700, gap: 16 }}>
        <div>
          <div className="view__title">Game settings</div>
          <div className="view__subtitle">Saved to {doc.path}. The game reads them at start; build and run from Play.</div>
        </div>
        <div className="form-grid">
          {CPP_KEYS.map((k) => (
            <Field key={k.key} label={k.label} htmlFor={`cfg-${k.key}`} help={values[k.key] === undefined ? "Not set: the game's default applies." : undefined}>
              <NumberInput id={`cfg-${k.key}`} value={values[k.key] ?? 0} min={k.min} max={k.max} step={k.step} onCommit={(n) => updateDoc(doc.path, setCfgValue(text, k.key, k.integer ? Math.round(n) : n))} />
            </Field>
          ))}
        </div>
      </div>
    </div>
  );
}

export function BinaryInfo({ doc }: { doc: Doc }) {
  return <Empty icon={<FileIcon />} title={doc.path}>This file type cannot be edited in Game Studio. Open it with the tool that made it.</Empty>;
}
