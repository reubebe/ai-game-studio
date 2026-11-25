import { IR_VERSION, LIMITS, type Expr, type RuleProgram, type Stmt, type Scalar, type ValueType } from "./ir";
import { parseHandle, semanticHash, type GraphNode, type RuleGraph } from "./graph";
import { isExecNode, paramsWithDefaults, pinType, type CompileContext, type DataPinSpec, type Diagnostic, type NodeRegistry, type NodeSpec } from "./registry";
import { validateGraph } from "./validate";

export interface CompileResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  program?: RuleProgram;
}

export function tempName(nodeId: string): string {
  return `t_${nodeId}`;
}

class CompileAbort extends Error {}

export function compileGraph(input: unknown, registry: NodeRegistry): CompileResult {
  const validation = validateGraph(input, registry);
  if (!validation.ok || !validation.graph) return { ok: false, diagnostics: validation.diagnostics };
  const graph = validation.graph;
  const diagnostics: Diagnostic[] = [...validation.diagnostics];

  const nodeById = new Map<string, { node: GraphNode; spec: NodeSpec }>();
  for (const node of graph.nodes) nodeById.set(node.id, { node, spec: registry.get(node.type)! });
  const dataIn = new Map<string, { source: string; pin: string }>();
  const execOut = new Map<string, string>();
  for (const e of graph.edges) {
    const sh = parseHandle(e.sourceHandle)!;
    const th = parseHandle(e.targetHandle)!;
    if (sh.kind === "data") dataIn.set(`${e.target}:${th.pin}`, { source: e.source, pin: sh.pin });
    else execOut.set(`${e.source}:${sh.pin}`, e.target);
  }

  let statementCount = 0;
  const count = (stmts: Stmt[]): number => stmts.reduce((n, s) => {
    let k = 1;
    if (s.s === "if") k += count(s.then) + count(s.else);
    if (s.s === "switch") k += Object.values(s.cases).reduce((m, b) => m + count(b), 0) + count(s.default);
    if (s.s === "repeat") k += count(s.body);
    return n + k;
  }, 0);

  const fail = (d: Omit<Diagnostic, "severity">) => diagnostics.push({ severity: "error", ...d });

  const coerceConst = (value: unknown, type: ValueType | "any"): Scalar => {
    if (type === "text" && (typeof value === "number" || typeof value === "boolean")) return typeof value === "number" ? value : value ? "true" : "false";
    return value as Scalar;
  };

  /** Compile the expression feeding a data input. */
  const inputExpr = (handlerEvent: string, consumer: { node: GraphNode; spec: NodeSpec }, pinId: string, assigned: Set<string>, stack: string[]): Expr => {
    const pin = consumer.spec.inputs.find((p) => p.id === pinId && p.kind === "data") as DataPinSpec | undefined;
    if (!pin) {
      fail({ code: "compiler", message: `${consumer.spec.title} has no input '${pinId}'`, nodeId: consumer.node.id });
      throw new CompileAbort();
    }
    const targetType = pinType(consumer.spec, consumer.node, graph, pin);
    const link = dataIn.get(`${consumer.node.id}:${pinId}`);
    let expr: Expr;
    let sourceType: string = targetType;
    if (!link) {
      const params = paramsWithDefaults(consumer.spec, consumer.node);
      const value = pin.param ? params[pin.param] : undefined;
      if (value === undefined) {
        fail({ code: "unconnected-input", message: `${consumer.spec.title}: connect the ${pin.label ?? pin.id} input`, nodeId: consumer.node.id });
        throw new CompileAbort();
      }
      expr = { e: "const", v: coerceConst(value, targetType === "any" ? "any" : targetType) };
      return expr;
    }
    const source = nodeById.get(link.source)!;
    const sourcePin = source.spec.outputs.find((p) => p.id === link.pin && p.kind === "data") as DataPinSpec;
    sourceType = pinType(source.spec, source.node, graph, sourcePin);
    if (source.spec.category === "event") {
      if (source.node.id !== handlerEvent) {
        fail({ code: "foreign-event-data", message: `${consumer.spec.title} uses data from a different event (${source.spec.title})`, nodeId: consumer.node.id });
        throw new CompileAbort();
      }
      expr = { e: "param", name: sourcePin.id };
    } else if (isExecNode(source.spec)) {
      const temp = tempName(source.node.id);
      if (!assigned.has(temp)) {
        fail({ code: "used-before-run", message: `${consumer.spec.title} uses ${source.spec.title}.${sourcePin.label ?? sourcePin.id} before ${source.spec.title} runs. Connect ${source.spec.title} earlier in the same execution path.`, nodeId: consumer.node.id });
        throw new CompileAbort();
      }
      expr = { e: "temp", name: temp, field: sourcePin.field ?? sourcePin.id };
    } else {
      if (stack.includes(source.node.id)) {
        fail({ code: "data-cycle", message: "A calculation depends on itself", nodeId: source.node.id });
        throw new CompileAbort();
      }
      expr = pureExpr(handlerEvent, source, sourcePin.id, assigned, [...stack, source.node.id]);
    }
    if (targetType === "text" && (sourceType === "number" || sourceType === "boolean")) expr = { e: "op", op: "text", args: [expr] };
    return expr;
  };

  const makeCtx = (handlerEvent: string, entry: { node: GraphNode; spec: NodeSpec }, assigned: Set<string>, depth: number, stack: string[]): CompileContext => {
    const params = paramsWithDefaults(entry.spec, entry.node);
    const temp = tempName(entry.node.id);
    return {
      graph,
      node: entry.node,
      spec: entry.spec,
      temp,
      param: <T,>(id: string) => params[id] as T,
      input: (pinId) => inputExpr(handlerEvent, entry, pinId, assigned, stack),
      follow: (pinId) => {
        const target = execOut.get(`${entry.node.id}:${pinId}`);
        if (!target) return [];
        const scope = entry.spec.tempScope;
        const next = new Set(assigned);
        if (!scope || scope.includes(pinId)) next.add(temp);
        return execStmts(handlerEvent, nodeById.get(target)!, next, depth + 1);
      },
      variable: (name) => graph.variables.find((v) => v.name === name),
      error: (code, message) => fail({ code, message, nodeId: entry.node.id }),
    };
  };

  const pureExpr = (handlerEvent: string, entry: { node: GraphNode; spec: NodeSpec }, pin: string, assigned: Set<string>, stack: string[]): Expr => {
    if (!entry.spec.compileExpr) {
      fail({ code: "compiler", message: `${entry.spec.title} cannot be used as a value`, nodeId: entry.node.id });
      throw new CompileAbort();
    }
    return entry.spec.compileExpr(makeCtx(handlerEvent, entry, assigned, 0, stack), pin);
  };

  const execStmts = (handlerEvent: string, entry: { node: GraphNode; spec: NodeSpec }, assigned: Set<string>, depth: number): Stmt[] => {
    if (depth > LIMITS.maxNestingDepth) {
      fail({ code: "too-deep", message: `Execution chains deeper than ${LIMITS.maxNestingDepth} nodes are not supported`, nodeId: entry.node.id });
      throw new CompileAbort();
    }
    if (!entry.spec.compileExec) {
      fail({ code: "compiler", message: `${entry.spec.title} cannot be executed`, nodeId: entry.node.id });
      throw new CompileAbort();
    }
    const stmts = entry.spec.compileExec(makeCtx(handlerEvent, entry, assigned, depth, [entry.node.id]));
    statementCount += 1;
    if (statementCount > LIMITS.maxCompiledStatements) {
      fail({ code: "too-large", message: "The compiled rules are too large. Reduce repeated paths that merge into the same nodes." });
      throw new CompileAbort();
    }
    return stmts;
  };

  const handlers: RuleProgram["handlers"] = {};
  for (const { node, spec } of nodeById.values()) {
    if (spec.category !== "event" || !spec.event) continue;
    try {
      const body = execStmts(node.id, { node, spec }, new Set(), 0);
      if (count(body) > LIMITS.maxCompiledStatements) {
        fail({ code: "too-large", message: `The ${spec.title} handler is too large`, nodeId: node.id });
        continue;
      }
      handlers[spec.event.name] = {
        params: spec.outputs.filter((p) => p.kind === "data").map((p) => p.id),
        body,
      };
    } catch (error) {
      if (!(error instanceof CompileAbort)) throw error;
    }
  }

  if (diagnostics.some((d) => d.severity === "error")) return { ok: false, diagnostics };

  const variables: RuleProgram["variables"] = {};
  for (const v of graph.variables) variables[v.name] = { type: v.type, initial: v.initial };
  const domain = registry.domain(graph.domain);
  const program: RuleProgram = {
    irVersion: IR_VERSION,
    graphId: graph.id,
    graphName: graph.name,
    domain: graph.domain,
    sourceHash: semanticHash(graph),
    domainConfig: domain?.config?.(graph, registry) ?? {},
    variables,
    handlers,
  };
  return { ok: true, diagnostics, program };
}

/** Convenience for callers that expect success (tests, templates). */
export function compileOrThrow(graph: RuleGraph, registry: NodeRegistry): RuleProgram {
  const result = compileGraph(graph, registry);
  if (!result.ok || !result.program) {
    const errors = result.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
    throw new Error(`Rule graph '${graph.id}' does not compile:\n- ${errors.join("\n- ")}`);
  }
  return result.program;
}
