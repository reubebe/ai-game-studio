import type { Expr, Stmt, ValueType, Scalar } from "./ir";
import type { GraphNode, GraphVariable, RuleGraph } from "./graph";

export type PinType = ValueType | "any";

export interface ExecPinSpec {
  id: string;
  kind: "exec";
  label?: string;
}

export interface DataPinSpec {
  id: string;
  kind: "data";
  type: PinType;
  label?: string;
  /** When the input is unconnected, use this parameter's value as a constant. */
  param?: string;
  /** Output pins of exec nodes are produced by the node's call; field name in the call result. */
  field?: string;
}

export type PinSpec = ExecPinSpec | DataPinSpec;

interface ParamBase {
  id: string;
  label: string;
  help?: string;
}
export type ParamSpec =
  | (ParamBase & { kind: "number"; default: number; min?: number; max?: number; integer?: boolean })
  | (ParamBase & { kind: "boolean"; default: boolean })
  | (ParamBase & { kind: "text"; default: string; maxLength?: number; multiline?: boolean })
  | (ParamBase & { kind: "select"; default: string; options: { value: string; label: string }[] })
  | (ParamBase & { kind: "numberList"; default: number[]; min?: number; max?: number; integer?: boolean; maxItems?: number })
  | (ParamBase & { kind: "variable"; default: string; variableType?: ValueType })
  | (ParamBase & { kind: "scalar"; default: Scalar; typeFromVariableParam: string });

export type NodeCategory = "event" | "flow" | "guard" | "action" | "query" | "data" | "math" | "logic" | "variable" | "config";

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  field?: string;
}

export interface CompileContext {
  readonly graph: RuleGraph;
  readonly node: GraphNode;
  readonly spec: NodeSpec;
  param<T = unknown>(id: string): T;
  /** Expression for a data input pin: its connected source or its parameter fallback. */
  input(pinId: string): Expr;
  /** Compiled statements of the chain connected to an exec output pin. */
  follow(pinId: string): Stmt[];
  /** Register name holding this node's call result (available to downstream data pins). */
  readonly temp: string;
  variable(name: string): GraphVariable | undefined;
  error(code: string, message: string): void;
}

export interface NodeSpec {
  type: string;
  domain: string;
  category: NodeCategory;
  title: string;
  description: string;
  inputs: PinSpec[];
  outputs: PinSpec[];
  params: ParamSpec[];
  /** Event nodes declare the handler name and payload. Payload fields become data output pins. */
  event?: { name: string };
  /** Upper bound of instances per graph (events are 1). */
  maxPerGraph?: number;
  /** Exec outputs whose successors may read this node's result values (default: all). */
  tempScope?: string[];
  /** Override pin types that depend on parameters (for example, Get Variable). */
  pinTypes?: (node: GraphNode, graph: RuleGraph) => Record<string, PinType>;
  /** Pure data nodes compile one output pin to an expression. */
  compileExpr?: (ctx: CompileContext, outputPin: string) => Expr;
  /** Exec nodes compile to statements (and use ctx.follow for successors). */
  compileExec?: (ctx: CompileContext) => Stmt[];
  /** Shown in the palette search. */
  keywords?: string[];
  /**
   * Engines whose games can run this node (manifest engine ids such as "godot"). Leave it out for
   * nodes every runtime of the domain supports. Projects for other engines cannot use the node.
   */
  engines?: readonly string[];
}

export interface DomainSpec {
  id: string;
  title: string;
  description: string;
  nodes: NodeSpec[];
  /** Domain-wide checks, such as "exactly one Sow node". */
  validate?: (graph: RuleGraph, registry: NodeRegistry) => Diagnostic[];
  /** Aggregates domain configuration (for example, variant settings) from node parameters. */
  config?: (graph: RuleGraph, registry: NodeRegistry) => Record<string, unknown>;
  /** Host functions (calls and queries) the runtime must provide; used for IR checks. */
  hostFunctions?: { calls: string[]; queries: string[] };
}

export interface NodeRegistry {
  readonly domains: ReadonlyMap<string, DomainSpec>;
  get(type: string): NodeSpec | undefined;
  list(domain?: string): NodeSpec[];
  /** Node types usable in a graph of the given domain (core + that domain). */
  forGraphDomain(domain: string): NodeSpec[];
  domain(id: string): DomainSpec | undefined;
}

export function isExecNode(spec: NodeSpec): boolean {
  return spec.inputs.some((p) => p.kind === "exec") || spec.outputs.some((p) => p.kind === "exec");
}

export function createRegistry(domains: DomainSpec[]): NodeRegistry {
  const byType = new Map<string, NodeSpec>();
  const domainMap = new Map<string, DomainSpec>();
  for (const domain of domains) {
    if (domainMap.has(domain.id)) throw new Error(`Duplicate rule domain '${domain.id}'`);
    domainMap.set(domain.id, domain);
    for (const spec of domain.nodes) {
      if (byType.has(spec.type)) throw new Error(`Duplicate node type '${spec.type}'`);
      if (spec.domain !== domain.id) throw new Error(`Node '${spec.type}' declares domain '${spec.domain}' but is registered in '${domain.id}'`);
      const ids = new Set<string>();
      for (const pin of [...spec.inputs, ...spec.outputs]) {
        const key = `${spec.inputs.includes(pin) ? "in" : "out"}:${pin.id}`;
        if (ids.has(key)) throw new Error(`Node '${spec.type}' has duplicate pin '${pin.id}'`);
        ids.add(key);
      }
      if (!spec.compileExec && !spec.compileExpr && spec.category !== "config") throw new Error(`Node '${spec.type}' has no compiler`);
      byType.set(spec.type, spec);
    }
  }
  return {
    domains: domainMap,
    get: (type) => byType.get(type),
    list: (domain) => [...byType.values()].filter((s) => !domain || s.domain === domain),
    forGraphDomain: (domain) => [...byType.values()].filter((s) => s.domain === "core" || s.domain === domain),
    domain: (id) => domainMap.get(id),
  };
}

const ENGINE_NAMES: Record<string, string> = { godot: "Godot", unity: "Unity", unreal: "Unreal", "studio-board": "Game Studio", "cpp-sfml": "C++" };

/** Whether a project built with `engine` can run the node. */
export function nodeRunsOn(spec: NodeSpec, engine: string): boolean {
  return !spec.engines || spec.engines.includes(engine);
}

/** Why a node cannot be used with an engine ("Works in Godot projects only"), or null when it can. */
export function engineLimit(spec: NodeSpec, engine: string): string | null {
  if (nodeRunsOn(spec, engine)) return null;
  const names = (spec.engines ?? []).map((e) => ENGINE_NAMES[e] ?? e);
  return `Works in ${names.join(" and ")} projects only`;
}

/** Errors for nodes in a graph that a project built with `engine` cannot run. */
export function engineDiagnostics(graph: RuleGraph, registry: NodeRegistry, engine: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const node of graph.nodes) {
    const spec = registry.get(node.type);
    const limit = spec ? engineLimit(spec, engine) : null;
    if (spec && limit) out.push({ severity: "error", code: "engine-unsupported", nodeId: node.id, message: `"${spec.title}" works in ${(spec.engines ?? []).map((e) => ENGINE_NAMES[e] ?? e).join(" and ")} projects only, and this project uses ${ENGINE_NAMES[engine] ?? engine}.` });
  }
  return out;
}

/** Resolved type of a pin, honoring parameter-dependent overrides. */
export function pinType(spec: NodeSpec, node: GraphNode, graph: RuleGraph, pin: DataPinSpec): PinType {
  const override = spec.pinTypes?.(node, graph)[pin.id];
  return override ?? pin.type;
}

/** Fill missing parameters with defaults; unknown parameters are kept for diagnostics. */
export function paramsWithDefaults(spec: NodeSpec, node: GraphNode): Record<string, unknown> {
  const out: Record<string, unknown> = { ...node.params };
  for (const p of spec.params) if (!(p.id in out)) out[p.id] = Array.isArray(p.default) ? [...p.default] : p.default;
  return out;
}
