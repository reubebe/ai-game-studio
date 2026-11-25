import { ruleGraphSchema, parseHandle, type RuleGraph, type GraphNode } from "./graph";
import {
  isExecNode,
  paramsWithDefaults,
  pinType,
  type DataPinSpec,
  type Diagnostic,
  type NodeRegistry,
  type NodeSpec,
  type ParamSpec,
  type PinType,
} from "./registry";

export interface ValidationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  /** Present when the input passed the schema check. */
  graph?: RuleGraph;
}

/** Can a value of type `from` flow into a pin of type `to`? Numbers and booleans convert to text. */
export function typesCompatible(from: PinType, to: PinType): boolean {
  if (from === to || from === "any" || to === "any") return true;
  return to === "text" && (from === "number" || from === "boolean");
}

function checkParam(spec: ParamSpec, value: unknown, graph: RuleGraph): string | null {
  switch (spec.kind) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if (spec.integer && !Number.isInteger(value)) return "must be a whole number";
      if (spec.min !== undefined && value < spec.min) return `must be at least ${spec.min}`;
      if (spec.max !== undefined && value > spec.max) return `must be at most ${spec.max}`;
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "text":
      if (typeof value !== "string") return "must be text";
      if (spec.maxLength !== undefined && value.length > spec.maxLength) return `must be at most ${spec.maxLength} characters`;
      return null;
    case "select":
      return typeof value === "string" && spec.options.some((o) => o.value === value) ? null : "is not one of the allowed options";
    case "numberList": {
      if (!Array.isArray(value)) return "must be a list of numbers";
      if (spec.maxItems !== undefined && value.length > spec.maxItems) return `must have at most ${spec.maxItems} items`;
      for (const n of value) {
        if (typeof n !== "number" || !Number.isFinite(n)) return "must contain only numbers";
        if (spec.integer && !Number.isInteger(n)) return "must contain whole numbers";
        if (spec.min !== undefined && n < spec.min) return `values must be at least ${spec.min}`;
        if (spec.max !== undefined && n > spec.max) return `values must be at most ${spec.max}`;
      }
      return null;
    }
    case "variable": {
      if (typeof value !== "string" || !value) return "select a variable";
      const v = graph.variables.find((x) => x.name === value);
      if (!v) return `refers to unknown variable '${value}'`;
      if (spec.variableType && v.type !== spec.variableType) return `needs a ${spec.variableType} variable; '${value}' is ${v.type}`;
      return null;
    }
    case "scalar":
      return typeof value === "number" || typeof value === "boolean" || typeof value === "string" ? null : "must be a number, text or true/false";
  }
}

function zodDiagnostics(error: { issues: { path: PropertyKey[]; message: string }[] }): Diagnostic[] {
  return error.issues.slice(0, 50).map((issue) => ({
    severity: "error" as const,
    code: "schema",
    message: `${issue.path.map(String).join(".") || "graph"}: ${issue.message}`,
  }));
}

export function validateGraph(input: unknown, registry: NodeRegistry): ValidationResult {
  const parsed = ruleGraphSchema.safeParse(input);
  if (!parsed.success) return { ok: false, diagnostics: zodDiagnostics(parsed.error) };
  const graph = parsed.data;
  const diagnostics: Diagnostic[] = [];
  const error = (d: Omit<Diagnostic, "severity">) => diagnostics.push({ severity: "error", ...d });
  const warn = (d: Omit<Diagnostic, "severity">) => diagnostics.push({ severity: "warning", ...d });

  if (!registry.domain(graph.domain)) error({ code: "unknown-domain", message: `Unknown rule domain '${graph.domain}'` });

  // Variables
  const varNames = new Set<string>();
  for (const v of graph.variables) {
    if (varNames.has(v.name)) error({ code: "duplicate-variable", message: `Variable '${v.name}' is declared twice`, field: v.name });
    varNames.add(v.name);
    const ok = (v.type === "number" && typeof v.initial === "number") || (v.type === "boolean" && typeof v.initial === "boolean") || (v.type === "text" && typeof v.initial === "string");
    if (!ok) error({ code: "variable-initial", message: `Variable '${v.name}' has an initial value that is not ${v.type}`, field: v.name });
  }

  // Nodes
  const nodes = new Map<string, { node: GraphNode; spec: NodeSpec }>();
  const typeCounts = new Map<string, number>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) {
      error({ code: "duplicate-node", message: `Node id '${node.id}' is used twice`, nodeId: node.id });
      continue;
    }
    const spec = registry.get(node.type);
    if (!spec) {
      error({ code: "unknown-node", message: `Unknown node type '${node.type}'`, nodeId: node.id });
      continue;
    }
    if (spec.domain !== "core" && spec.domain !== graph.domain) {
      error({ code: "wrong-domain", message: `'${spec.title}' belongs to the ${spec.domain} domain, not ${graph.domain}`, nodeId: node.id });
    }
    nodes.set(node.id, { node, spec });
    typeCounts.set(spec.type, (typeCounts.get(spec.type) ?? 0) + 1);
    const params = paramsWithDefaults(spec, node);
    for (const p of spec.params) {
      const problem = checkParam(p, params[p.id], graph);
      if (problem) error({ code: "bad-param", message: `${spec.title}: ${p.label} ${problem}`, nodeId: node.id, field: p.id });
    }
    for (const key of Object.keys(node.params)) {
      if (!spec.params.some((p) => p.id === key)) warn({ code: "unknown-param", message: `${spec.title}: ignoring unknown setting '${key}'`, nodeId: node.id, field: key });
    }
  }
  for (const [type, count] of typeCounts) {
    const spec = registry.get(type);
    if (spec?.maxPerGraph !== undefined && count > spec.maxPerGraph) {
      for (const { node } of [...nodes.values()].filter((x) => x.node.type === type)) {
        error({ code: "too-many", message: `Only ${spec.maxPerGraph} '${spec.title}' node is allowed per graph`, nodeId: node.id });
      }
    }
  }
  if (![...nodes.values()].some(({ spec }) => spec.category === "event")) {
    warn({ code: "no-events", message: "This graph has no event nodes, so it never runs. Add an event such as On Start." });
  }

  // Edges
  const edgeIds = new Set<string>();
  const incomingData = new Map<string, string>(); // `${node}:${pin}` -> edge id
  const outgoingExec = new Map<string, string>();
  const execAdj = new Map<string, Set<string>>();
  const dataAdj = new Map<string, Set<string>>(); // source -> targets among pure nodes
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) error({ code: "duplicate-edge", message: `Edge id '${edge.id}' is used twice`, edgeId: edge.id });
    edgeIds.add(edge.id);
    const src = nodes.get(edge.source);
    const dst = nodes.get(edge.target);
    if (!src || !dst) {
      error({ code: "dangling-edge", message: "A connection points to a missing node", edgeId: edge.id });
      continue;
    }
    const sh = parseHandle(edge.sourceHandle);
    const th = parseHandle(edge.targetHandle);
    const sPin = sh && src.spec.outputs.find((p) => p.id === sh.pin && p.kind === sh.kind);
    const tPin = th && dst.spec.inputs.find((p) => p.id === th.pin && p.kind === th.kind);
    if (!sh || !th || !sPin || !tPin) {
      error({ code: "bad-handle", message: `Connection from ${src.spec.title} to ${dst.spec.title} uses a pin that does not exist`, edgeId: edge.id });
      continue;
    }
    if (sPin.kind !== tPin.kind) {
      error({ code: "kind-mismatch", message: `Cannot connect a ${sPin.kind} pin to a ${tPin.kind} pin`, edgeId: edge.id });
      continue;
    }
    if (edge.source === edge.target) {
      error({ code: "self-loop", message: `${src.spec.title} cannot connect to itself`, edgeId: edge.id, nodeId: edge.source });
      continue;
    }
    if (sPin.kind === "data" && tPin.kind === "data") {
      const from = pinType(src.spec, src.node, graph, sPin);
      const to = pinType(dst.spec, dst.node, graph, tPin);
      if (!typesCompatible(from, to)) {
        error({ code: "type-mismatch", message: `${src.spec.title}.${sPin.label ?? sPin.id} gives ${from} but ${dst.spec.title}.${tPin.label ?? tPin.id} needs ${to}`, edgeId: edge.id, nodeId: edge.target });
      }
      const key = `${edge.target}:${tPin.id}`;
      if (incomingData.has(key)) error({ code: "multiple-inputs", message: `${dst.spec.title}.${tPin.label ?? tPin.id} has more than one connection`, edgeId: edge.id, nodeId: edge.target });
      incomingData.set(key, edge.id);
      if (!isExecNode(src.spec) && !isExecNode(dst.spec)) {
        if (!dataAdj.has(edge.source)) dataAdj.set(edge.source, new Set());
        dataAdj.get(edge.source)!.add(edge.target);
      }
    } else {
      const key = `${edge.source}:${sPin.id}`;
      if (outgoingExec.has(key)) error({ code: "multiple-exec", message: `${src.spec.title} → ${sPin.label ?? sPin.id} can connect to only one node; use a Sequence node to run several`, edgeId: edge.id, nodeId: edge.source });
      outgoingExec.set(key, edge.id);
      if (!execAdj.has(edge.source)) execAdj.set(edge.source, new Set());
      execAdj.get(edge.source)!.add(edge.target);
    }
  }

  // Required data inputs
  for (const { node, spec } of nodes.values()) {
    for (const pin of spec.inputs) {
      if (pin.kind !== "data") continue;
      const connected = incomingData.has(`${node.id}:${pin.id}`);
      if (!connected && !pin.param) {
        error({ code: "unconnected-input", message: `${spec.title}: connect the ${pin.label ?? pin.id} input`, nodeId: node.id, field: pin.id });
      }
      if (!connected && pin.param) {
        const paramSpec = spec.params.find((p) => p.id === pin.param);
        const value = paramsWithDefaults(spec, node)[pin.param];
        const expected = pinType(spec, node, graph, pin as DataPinSpec);
        if (paramSpec?.kind === "scalar" && expected !== "any") {
          const actual = typeof value === "string" ? "text" : typeof value;
          if (actual !== expected) error({ code: "bad-param", message: `${spec.title}: the value must be ${expected} to match the variable`, nodeId: node.id, field: pin.param });
        }
      }
    }
  }

  // Cycles
  const findCycle = (adj: Map<string, Set<string>>): string | null => {
    const state = new Map<string, 1 | 2>();
    const visit = (n: string): string | null => {
      state.set(n, 1);
      for (const m of adj.get(n) ?? []) {
        const s = state.get(m);
        if (s === 1) return m;
        if (s === undefined) {
          const found = visit(m);
          if (found) return found;
        }
      }
      state.set(n, 2);
      return null;
    };
    for (const n of adj.keys()) if (!state.has(n)) {
      const found = visit(n);
      if (found) return found;
    }
    return null;
  };
  const execCycle = findCycle(execAdj);
  if (execCycle) error({ code: "exec-cycle", message: "The execution flow loops back on itself. Use a Repeat node for loops.", nodeId: execCycle });
  const dataCycle = findCycle(dataAdj);
  if (dataCycle) error({ code: "data-cycle", message: "These calculations depend on themselves (a data cycle).", nodeId: dataCycle });

  // Reachability of exec nodes from events
  const reachable = new Set<string>();
  const stack = [...nodes.values()].filter(({ spec }) => spec.category === "event").map(({ node }) => node.id);
  while (stack.length) {
    const n = stack.pop()!;
    if (reachable.has(n)) continue;
    reachable.add(n);
    for (const m of execAdj.get(n) ?? []) stack.push(m);
  }
  const usedAsSource = new Set(graph.edges.map((e) => e.source));
  for (const { node, spec } of nodes.values()) {
    if (isExecNode(spec) && spec.category !== "event" && !reachable.has(node.id)) {
      warn({ code: "unreachable", message: `${spec.title} is not connected to any event, so it never runs`, nodeId: node.id });
    }
    if (!isExecNode(spec) && spec.category !== "config" && !usedAsSource.has(node.id)) {
      diagnostics.push({ severity: "info", code: "unused", message: `${spec.title} is not used by any other node`, nodeId: node.id });
    }
  }

  const domain = registry.domain(graph.domain);
  if (domain?.validate) diagnostics.push(...domain.validate(graph, registry));

  return { ok: !diagnostics.some((d) => d.severity === "error"), diagnostics, graph };
}
