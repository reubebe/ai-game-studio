import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { handleId, paramsWithDefaults, pinType, type DataPinSpec, type Diagnostic, type GraphNode, type NodeSpec, type PinType, type RuleGraph } from "@gamestudio/rules-core";
import { ActivityIcon, BoxIcon, FlagIcon, GraphIcon, ShieldIcon, SlidersIcon, VariableIcon, ZapIcon, HashIcon } from "./node-icons";

export const CATEGORY_COLOR: Record<string, string> = {
  event: "var(--accent)",
  flow: "#dfe7f2",
  guard: "var(--amber)",
  action: "var(--violet)",
  query: "var(--blue)",
  data: "#8fa3c0",
  math: "#8fa3c0",
  logic: "#f07d9b",
  variable: "#7fd6a8",
  config: "#c9b38a",
};

export const CATEGORY_ICON: Record<string, typeof ZapIcon> = {
  event: ZapIcon,
  flow: GraphIcon,
  guard: ShieldIcon,
  action: ActivityIcon,
  query: BoxIcon,
  data: HashIcon,
  math: HashIcon,
  logic: FlagIcon,
  variable: VariableIcon,
  config: SlidersIcon,
};

export function pinColor(t: PinType): string {
  return t === "number" ? "var(--pin-number)" : t === "boolean" ? "var(--pin-boolean)" : t === "text" ? "var(--pin-text)" : "var(--pin-any)";
}

export interface RuleNodeData extends Record<string, unknown> {
  node: GraphNode;
  spec: NodeSpec;
  graph: RuleGraph;
  diagnostics: Diagnostic[];
  traced: boolean;
  connectedInputs: string[];
}

export type RuleFlowNode = Node<RuleNodeData, "rule">;

function short(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "string") return v.length > 22 ? `“${v.slice(0, 20)}…”` : `“${v}”`;
  return String(v);
}

function RuleNodeView({ data, selected }: NodeProps<RuleFlowNode>) {
  const { node, spec, graph, diagnostics, traced, connectedInputs } = data;
  const params = paramsWithDefaults(spec, node);
  const hasError = diagnostics.some((d) => d.severity === "error");
  const Icon = CATEGORY_ICON[spec.category] ?? BoxIcon;
  const color = CATEGORY_COLOR[spec.category] ?? "var(--text-3)";
  const pinRow = (pin: (typeof spec.inputs)[number], side: "in" | "out") => {
    const id = handleId(pin.kind, pin.id);
    const type = pin.kind === "data" ? pinType(spec, node, graph, pin as DataPinSpec) : null;
    const fallback = side === "in" && pin.kind === "data" && (pin as DataPinSpec).param && !connectedInputs.includes(pin.id) ? params[(pin as DataPinSpec).param!] : undefined;
    return (
      <div key={`${side}-${pin.id}`} className={`rule-pin rule-pin--${side}`}>
        <Handle
          type={side === "in" ? "target" : "source"}
          position={side === "in" ? Position.Left : Position.Right}
          id={id}
          className={pin.kind === "exec" ? "handle--exec" : "handle--data"}
          style={pin.kind === "data" ? { background: pinColor(type ?? "any") } : undefined}
        />
        {side === "out" && fallback === undefined && <span>{pin.label ?? (pin.kind === "exec" && pin.id === "out" ? "" : pin.id)}</span>}
        {side === "in" && <span>{pin.label ?? (pin.kind === "exec" && pin.id === "in" ? "" : pin.id)}</span>}
        {fallback !== undefined && fallback !== "" && <span className="rule-pin__value">{short(fallback)}</span>}
      </div>
    );
  };
  const configParams = spec.params.filter((p) => !spec.inputs.some((i) => i.kind === "data" && (i as DataPinSpec).param === p.id));
  return (
    <div className={`rule-node ${selected ? "selected" : ""} ${traced ? "rule-node--traced" : ""} ${hasError ? "rule-node--error" : ""}`} style={{ ["--cat" as string]: color }} data-node-id={node.id} data-testid={`rule-node-${node.id}`}>
      <div className="rule-node__head">
        <Icon />
        <span className="rule-node__title">{node.label ?? spec.title}</span>
        <span className="rule-node__cat">{spec.category}</span>
      </div>
      {(spec.inputs.length > 0 || spec.outputs.length > 0) && (
        <div className="rule-node__body">
          <div className="rule-node__col">{spec.inputs.map((p) => pinRow(p, "in"))}</div>
          <div className="rule-node__col rule-node__col--out">{spec.outputs.map((p) => pinRow(p, "out"))}</div>
        </div>
      )}
      {configParams.length > 0 && (
        <div className="rule-node__summary">
          {configParams.slice(0, 3).map((p) => (
            <div key={p.id} className="truncate">
              {p.label.replace(/ \(when unconnected\)/, "")}: <span className="mono">{short(params[p.id])}</span>
            </div>
          ))}
        </div>
      )}
      {hasError && <div className="rule-node__summary" style={{ color: "#ffaaa3" }}>{diagnostics.find((d) => d.severity === "error")!.message}</div>}
    </div>
  );
}

export const RuleNode = memo(RuleNodeView);
