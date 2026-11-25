import { paramsWithDefaults, pinType, type DataPinSpec, type GraphNode, type NodeSpec, type ParamSpec, type RuleGraph, type Scalar } from "@gamestudio/rules-core";
import { Button, Field, IconButton, NumberInput, Switch, TextInput } from "../../components/ui";
import { PlusIcon, TrashIcon } from "../../components/icons";
import { pinColor } from "./RuleNode";
import { useState } from "react";

function ParamEditor({ spec, value, graph, node, onChange }: { spec: ParamSpec; value: unknown; graph: RuleGraph; node: GraphNode; onChange: (v: unknown) => void }) {
  const id = `param-${node.id}-${spec.id}`;
  switch (spec.kind) {
    case "number":
      return <NumberInput id={id} value={typeof value === "number" ? value : spec.default} min={spec.min} max={spec.max} onCommit={(n) => onChange(spec.integer ? Math.round(n) : n)} />;
    case "boolean":
      return <Switch checked={value === true} onChange={onChange} label={value === true ? "On" : "Off"} />;
    case "text":
      return spec.multiline ? (
        <textarea id={id} className="textarea" rows={3} maxLength={spec.maxLength} defaultValue={String(value ?? "")} key={`${node.id}-${String(value)}`} onBlur={(e) => e.target.value !== value && onChange(e.target.value)} />
      ) : (
        <TextInput id={id} value={String(value ?? "")} maxLength={spec.maxLength} onCommit={onChange} />
      );
    case "select":
      return (
        <select id={id} className="select" value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {spec.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "numberList":
      return (
        <TextInput
          id={id}
          mono
          value={Array.isArray(value) ? value.join(", ") : ""}
          placeholder="e.g. 2, 3"
          onCommit={(s) => {
            const parts = s.split(/[\s,]+/).filter(Boolean).map(Number);
            if (parts.every((n) => Number.isFinite(n))) onChange(parts);
          }}
        />
      );
    case "variable":
      return (
        <select id={id} className="select" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose a variable…</option>
          {graph.variables
            .filter((v) => !spec.variableType || v.type === spec.variableType)
            .map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.type})
              </option>
            ))}
        </select>
      );
    case "scalar": {
      const variable = graph.variables.find((v) => v.name === node.params[spec.typeFromVariableParam]);
      if (variable?.type === "boolean") return <Switch checked={value === true} onChange={onChange} label={value === true ? "true" : "false"} />;
      if (variable?.type === "number") return <NumberInput id={id} value={typeof value === "number" ? value : 0} onCommit={onChange} />;
      return <TextInput id={id} value={String(value ?? "")} onCommit={onChange} />;
    }
  }
}

export function NodeInspector({ node, spec, graph, connectedInputs, onParam, onLabel, onDelete }: { node: GraphNode; spec: NodeSpec; graph: RuleGraph; connectedInputs: string[]; onParam: (id: string, v: unknown) => void; onLabel: (label: string) => void; onDelete: () => void }) {
  const params = paramsWithDefaults(spec, node);
  return (
    <div className="inspector">
      <div className="stack" style={{ gap: 4 }}>
        <div className="section-label">{spec.category} · {spec.domain}</div>
        <div className="inspector__title">{spec.title}</div>
        <p className="small muted" style={{ lineHeight: 1.5 }}>{spec.description}</p>
      </div>
      <Field label="Label on canvas" htmlFor={`label-${node.id}`} help={`Node id: ${node.id}`}>
        <TextInput id={`label-${node.id}`} value={node.label ?? ""} placeholder={spec.title} onCommit={onLabel} maxLength={120} />
      </Field>
      {spec.params.map((p) => {
        const pin = spec.inputs.find((i) => i.kind === "data" && (i as DataPinSpec).param === p.id);
        const wired = pin ? connectedInputs.includes(pin.id) : false;
        return (
          <Field key={p.id} label={p.label} help={wired ? "This input is connected, so the value comes from the wire." : p.help} htmlFor={`param-${node.id}-${p.id}`}>
            <div style={{ opacity: wired ? 0.45 : 1, pointerEvents: wired ? "none" : undefined }}>
              <ParamEditor spec={p} value={params[p.id]} graph={graph} node={node} onChange={(v) => onParam(p.id, v)} />
            </div>
          </Field>
        );
      })}
      <div className="stack" style={{ gap: 6 }}>
        <div className="section-label">Pins</div>
        {[...spec.inputs.map((p) => ({ p, side: "in" })), ...spec.outputs.map((p) => ({ p, side: "out" }))].map(({ p, side }) => {
          const t = p.kind === "data" ? pinType(spec, node, graph, p as DataPinSpec) : null;
          return (
            <div key={`${side}${p.id}`} className="pin-doc">
              <span className="pin-swatch" style={{ background: p.kind === "exec" ? "var(--pin-exec)" : pinColor(t ?? "any"), borderRadius: p.kind === "exec" ? 1 : "50%" }} />
              <span>{side === "in" ? "In" : "Out"}: {p.label ?? p.id}</span>
              <span className="faint">{p.kind === "exec" ? "execution" : t}</span>
            </div>
          );
        })}
      </div>
      <Button variant="danger" size="small" icon={<TrashIcon />} onClick={onDelete}>
        Delete node
      </Button>
    </div>
  );
}

export function GraphInspector({ graph, onChange }: { graph: RuleGraph; onChange: (g: RuleGraph) => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"number" | "boolean" | "text">("number");
  const nameOk = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) && !graph.variables.some((v) => v.name === name);
  const nameProblem = nameOk ? null : name === "" ? "Type a name for the new variable first" : graph.variables.some((v) => v.name === name) ? `There is already a variable called ${name}` : "Names start with a letter or _, then use only letters, digits and _ (up to 64)";
  return (
    <div className="inspector">
      <div className="stack" style={{ gap: 4 }}>
        <div className="section-label">Rule graph</div>
        <div className="inspector__title">{graph.name}</div>
        <p className="xsmall muted">Domain: {graph.domain} · {graph.nodes.length} nodes · {graph.edges.length} connections</p>
      </div>
      <Field label="Name" htmlFor="graph-name">
        <TextInput id="graph-name" value={graph.name} maxLength={120} onCommit={(v) => v.trim() && onChange({ ...graph, name: v.trim() })} />
      </Field>
      <Field label="Description" htmlFor="graph-desc">
        <textarea id="graph-desc" className="textarea" rows={3} key={graph.description ?? ""} defaultValue={graph.description ?? ""} onBlur={(e) => e.target.value !== (graph.description ?? "") && onChange({ ...graph, description: e.target.value })} />
      </Field>
      <div className="stack" style={{ gap: 8 }}>
        <div className="section-label">Variables</div>
        {graph.variables.length === 0 && <p className="xsmall muted">No variables. Variables keep values between events (scores, flags, counters).</p>}
        {graph.variables.map((v, i) => (
          <div key={v.name} className="row" style={{ gap: 6 }}>
            <span className="mono small" style={{ flex: 1 }}>{v.name}</span>
            <span className="badge">{v.type}</span>
            <div style={{ width: 90 }}>
              {v.type === "number" ? (
                <NumberInput ariaLabel={`Initial value of ${v.name}`} value={Number(v.initial)} onCommit={(n) => onChange({ ...graph, variables: graph.variables.map((x, j) => (j === i ? { ...x, initial: n } : x)) })} />
              ) : v.type === "boolean" ? (
                <Switch checked={v.initial === true} label="" onChange={(b) => onChange({ ...graph, variables: graph.variables.map((x, j) => (j === i ? { ...x, initial: b } : x)) })} />
              ) : (
                <TextInput ariaLabel={`Initial value of ${v.name}`} value={String(v.initial)} onCommit={(s) => onChange({ ...graph, variables: graph.variables.map((x, j) => (j === i ? { ...x, initial: s } : x)) })} />
              )}
            </div>
            <button
              type="button"
              className="icon-btn icon-btn--small"
              aria-label={`Remove variable ${v.name}`}
              data-tip={graph.nodes.some((n) => n.params["variable"] === v.name) ? "Used by nodes: remove those nodes first" : "Remove variable"}
              disabled={graph.nodes.some((n) => n.params["variable"] === v.name)}
              onClick={() => onChange({ ...graph, variables: graph.variables.filter((_, j) => j !== i) })}
            >
              <TrashIcon />
            </button>
          </div>
        ))}
        <div className="row" style={{ gap: 6 }}>
          <input className="input input--mono" aria-label="New variable name" placeholder="newVariable" value={name} onChange={(e) => setName(e.target.value)} />
          <select className="select" aria-label="New variable type" style={{ width: 108, flex: "none" }} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="number">number</option>
            <option value="boolean">boolean</option>
            <option value="text">text</option>
          </select>
          <IconButton
            label="Add variable"
            tip={nameProblem ?? `Add ${name}`}
            disabled={!nameOk}
            onClick={() => {
              const initial: Scalar = type === "number" ? 0 : type === "boolean" ? false : "";
              onChange({ ...graph, variables: [...graph.variables, { name, type, initial }] });
              setName("");
            }}
          >
            <PlusIcon />
          </IconButton>
        </div>
      </div>
      {graph.provenance && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="section-label">Provenance</div>
          {graph.provenance.variant && <div className="small">{graph.provenance.variant}</div>}
          {graph.provenance.sources.map((s) => (
            <div key={s.title} className="xsmall muted">
              {s.title}
              {s.accessed ? ` (accessed ${s.accessed})` : ""}
            </div>
          ))}
          {graph.provenance.notes && <p className="xsmall muted" style={{ lineHeight: 1.5 }}>{graph.provenance.notes}</p>}
        </div>
      )}
    </div>
  );
}
