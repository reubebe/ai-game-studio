import type { Expr, OpName, Stmt } from "./ir";
import type { DomainSpec, NodeSpec, PinType } from "./registry";
import type { GraphNode, RuleGraph } from "./graph";

const EXEC_IN = { id: "in", kind: "exec" } as const;
const EXEC_OUT = { id: "out", kind: "exec" } as const;

const trace = (node: string): Stmt => ({ s: "trace", node });

function varType(node: GraphNode, graph: RuleGraph): PinType {
  const name = node.params["variable"];
  const v = graph.variables.find((x) => x.name === name);
  return v ? v.type : "any";
}

function mathNode(type: string, title: string, op: OpName, description: string, defaults: [number, number]): NodeSpec {
  return {
    type,
    domain: "core",
    category: "math",
    title,
    description,
    inputs: [
      { id: "a", kind: "data", type: "number", label: "A", param: "a" },
      { id: "b", kind: "data", type: "number", label: "B", param: "b" },
    ],
    outputs: [{ id: "result", kind: "data", type: "number", label: "Result" }],
    params: [
      { id: "a", label: "A (when unconnected)", kind: "number", default: defaults[0] },
      { id: "b", label: "B (when unconnected)", kind: "number", default: defaults[1] },
    ],
    keywords: [op],
    compileExpr: (ctx) => ({ e: "op", op, args: [ctx.input("a"), ctx.input("b")] }),
  };
}

const COMPARE_OPS: Record<string, OpName> = { "==": "eq", "!=": "neq", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" };

export const coreNodes: NodeSpec[] = [
  // ---- Events -----------------------------------------------------------------------------
  {
    type: "core.event.start",
    domain: "core",
    category: "event",
    title: "On Start",
    description: "Runs once when the game or match starts.",
    inputs: [],
    outputs: [EXEC_OUT],
    params: [],
    event: { name: "start" },
    maxPerGraph: 1,
    keywords: ["begin", "init"],
    compileExec: (ctx) => [trace(ctx.node.id), ...ctx.follow("out")],
  },

  // ---- Flow -------------------------------------------------------------------------------
  {
    type: "core.flow.branch",
    domain: "core",
    category: "flow",
    title: "Branch",
    description: "Continues through True or False depending on the condition.",
    inputs: [EXEC_IN, { id: "condition", kind: "data", type: "boolean", label: "Condition" }],
    outputs: [
      { id: "true", kind: "exec", label: "True" },
      { id: "false", kind: "exec", label: "False" },
    ],
    params: [],
    keywords: ["if", "condition"],
    compileExec: (ctx) => [
      trace(ctx.node.id),
      { s: "if", cond: ctx.input("condition"), then: ctx.follow("true"), else: ctx.follow("false"), node: ctx.node.id },
    ],
  },
  {
    type: "core.flow.sequence",
    domain: "core",
    category: "flow",
    title: "Sequence",
    description: "Runs each connected output in order: First, Then, Finally.",
    inputs: [EXEC_IN],
    outputs: [
      { id: "first", kind: "exec", label: "First" },
      { id: "then", kind: "exec", label: "Then" },
      { id: "finally", kind: "exec", label: "Finally" },
    ],
    params: [],
    keywords: ["order", "steps"],
    compileExec: (ctx) => [trace(ctx.node.id), ...ctx.follow("first"), ...ctx.follow("then"), ...ctx.follow("finally")],
  },
  {
    type: "core.flow.repeat",
    domain: "core",
    category: "flow",
    title: "Repeat",
    description: "Runs Body a number of times (at most 1000), then continues through Done.",
    inputs: [EXEC_IN, { id: "count", kind: "data", type: "number", label: "Count", param: "count" }],
    outputs: [
      { id: "body", kind: "exec", label: "Body" },
      { id: "done", kind: "exec", label: "Done" },
      { id: "index", kind: "data", type: "number", label: "Index" },
    ],
    params: [{ id: "count", label: "Count (when unconnected)", kind: "number", default: 3, min: 0, max: 1000, integer: true }],
    tempScope: ["body"],
    keywords: ["loop", "for"],
    compileExec: (ctx) => [
      trace(ctx.node.id),
      { s: "repeat", count: ctx.input("count"), index: ctx.temp, body: ctx.follow("body"), node: ctx.node.id },
      ...ctx.follow("done"),
    ],
  },
  {
    type: "core.flow.stop",
    domain: "core",
    category: "flow",
    title: "Stop",
    description: "Ends this event's handling immediately.",
    inputs: [EXEC_IN],
    outputs: [],
    params: [],
    keywords: ["halt", "return", "end"],
    compileExec: (ctx) => [trace(ctx.node.id), { s: "halt", node: ctx.node.id }],
  },

  // ---- Variables --------------------------------------------------------------------------
  {
    type: "core.var.get",
    domain: "core",
    category: "variable",
    title: "Get Variable",
    description: "Reads the current value of a graph variable.",
    inputs: [],
    outputs: [{ id: "value", kind: "data", type: "any", label: "Value" }],
    params: [{ id: "variable", label: "Variable", kind: "variable", default: "" }],
    pinTypes: (node, graph) => ({ value: varType(node, graph) }),
    keywords: ["read"],
    compileExpr: (ctx) => ({ e: "var", name: ctx.param<string>("variable") }),
  },
  {
    type: "core.var.set",
    domain: "core",
    category: "variable",
    title: "Set Variable",
    description: "Stores a value in a graph variable.",
    inputs: [EXEC_IN, { id: "value", kind: "data", type: "any", label: "Value", param: "value" }],
    outputs: [EXEC_OUT],
    params: [
      { id: "variable", label: "Variable", kind: "variable", default: "" },
      { id: "value", label: "Value (when unconnected)", kind: "scalar", default: 0, typeFromVariableParam: "variable" },
    ],
    pinTypes: (node, graph) => ({ value: varType(node, graph) }),
    keywords: ["assign", "write"],
    compileExec: (ctx) => [
      trace(ctx.node.id),
      { s: "set", var: ctx.param<string>("variable"), value: ctx.input("value"), node: ctx.node.id },
      ...ctx.follow("out"),
    ],
  },
  {
    type: "core.var.add",
    domain: "core",
    category: "variable",
    title: "Add to Variable",
    description: "Adds an amount to a number variable (use a negative amount to subtract).",
    inputs: [EXEC_IN, { id: "amount", kind: "data", type: "number", label: "Amount", param: "amount" }],
    outputs: [EXEC_OUT],
    params: [
      { id: "variable", label: "Variable", kind: "variable", default: "", variableType: "number" },
      { id: "amount", label: "Amount (when unconnected)", kind: "number", default: 1 },
    ],
    keywords: ["increment", "counter", "score"],
    compileExec: (ctx) => {
      const name = ctx.param<string>("variable");
      return [
        trace(ctx.node.id),
        { s: "set", var: name, value: { e: "op", op: "add", args: [{ e: "var", name }, ctx.input("amount")] }, node: ctx.node.id },
        ...ctx.follow("out"),
      ];
    },
  },

  // ---- Literals ---------------------------------------------------------------------------
  {
    type: "core.data.number",
    domain: "core",
    category: "data",
    title: "Number",
    description: "A constant number.",
    inputs: [],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Value" }],
    params: [{ id: "value", label: "Value", kind: "number", default: 0 }],
    keywords: ["constant", "literal"],
    compileExpr: (ctx) => ({ e: "const", v: ctx.param<number>("value") }),
  },
  {
    type: "core.data.boolean",
    domain: "core",
    category: "data",
    title: "True / False",
    description: "A constant true or false value.",
    inputs: [],
    outputs: [{ id: "value", kind: "data", type: "boolean", label: "Value" }],
    params: [{ id: "value", label: "Value", kind: "boolean", default: true }],
    keywords: ["constant", "bool"],
    compileExpr: (ctx) => ({ e: "const", v: ctx.param<boolean>("value") }),
  },
  {
    type: "core.data.text",
    domain: "core",
    category: "data",
    title: "Text",
    description: "A constant piece of text.",
    inputs: [],
    outputs: [{ id: "value", kind: "data", type: "text", label: "Value" }],
    params: [{ id: "value", label: "Text", kind: "text", default: "", maxLength: 2000, multiline: true }],
    keywords: ["string", "message", "constant"],
    compileExpr: (ctx) => ({ e: "const", v: ctx.param<string>("value") }),
  },

  // ---- Math -------------------------------------------------------------------------------
  mathNode("core.math.add", "Add", "add", "A + B", [0, 1]),
  mathNode("core.math.subtract", "Subtract", "sub", "A − B", [0, 1]),
  mathNode("core.math.multiply", "Multiply", "mul", "A × B", [1, 1]),
  mathNode("core.math.divide", "Divide", "div", "A ÷ B (division by zero stops the rule with an error)", [0, 1]),
  mathNode("core.math.modulo", "Modulo", "mod", "Remainder of A ÷ B, always between 0 and B", [0, 12]),
  mathNode("core.math.min", "Minimum", "min", "The smaller of A and B", [0, 0]),
  mathNode("core.math.max", "Maximum", "max", "The larger of A and B", [0, 0]),

  // ---- Comparison and logic -------------------------------------------------------------
  {
    type: "core.compare.number",
    domain: "core",
    category: "logic",
    title: "Compare Numbers",
    description: "Compares A and B with the chosen operator.",
    inputs: [
      { id: "a", kind: "data", type: "number", label: "A", param: "a" },
      { id: "b", kind: "data", type: "number", label: "B", param: "b" },
    ],
    outputs: [{ id: "result", kind: "data", type: "boolean", label: "Result" }],
    params: [
      {
        id: "operator",
        label: "Operator",
        kind: "select",
        default: ">=",
        options: Object.keys(COMPARE_OPS).map((v) => ({ value: v, label: v })),
      },
      { id: "a", label: "A (when unconnected)", kind: "number", default: 0 },
      { id: "b", label: "B (when unconnected)", kind: "number", default: 0 },
    ],
    keywords: ["greater", "less", "equal", "if"],
    compileExpr: (ctx) => {
      const op = COMPARE_OPS[ctx.param<string>("operator")];
      if (!op) {
        ctx.error("bad-operator", "Unknown comparison operator");
        return { e: "const", v: false };
      }
      return { e: "op", op, args: [ctx.input("a"), ctx.input("b")] };
    },
  },
  {
    type: "core.compare.text",
    domain: "core",
    category: "logic",
    title: "Text Equals",
    description: "True when A and B are the same text (or different, if Negate is on).",
    inputs: [
      { id: "a", kind: "data", type: "text", label: "A", param: "a" },
      { id: "b", kind: "data", type: "text", label: "B", param: "b" },
    ],
    outputs: [{ id: "result", kind: "data", type: "boolean", label: "Result" }],
    params: [
      { id: "a", label: "A (when unconnected)", kind: "text", default: "" },
      { id: "b", label: "B (when unconnected)", kind: "text", default: "" },
      { id: "negate", label: "Negate (true when different)", kind: "boolean", default: false },
    ],
    keywords: ["string", "match", "same"],
    compileExpr: (ctx) => ({ e: "op", op: ctx.param<boolean>("negate") ? "neq" : "eq", args: [ctx.input("a"), ctx.input("b")] }),
  },
  {
    type: "core.logic.and",
    domain: "core",
    category: "logic",
    title: "And",
    description: "True when both A and B are true.",
    inputs: [
      { id: "a", kind: "data", type: "boolean", label: "A" },
      { id: "b", kind: "data", type: "boolean", label: "B" },
    ],
    outputs: [{ id: "result", kind: "data", type: "boolean", label: "Result" }],
    params: [],
    compileExpr: (ctx) => ({ e: "op", op: "and", args: [ctx.input("a"), ctx.input("b")] }),
  },
  {
    type: "core.logic.or",
    domain: "core",
    category: "logic",
    title: "Or",
    description: "True when A or B (or both) are true.",
    inputs: [
      { id: "a", kind: "data", type: "boolean", label: "A" },
      { id: "b", kind: "data", type: "boolean", label: "B" },
    ],
    outputs: [{ id: "result", kind: "data", type: "boolean", label: "Result" }],
    params: [],
    compileExpr: (ctx) => ({ e: "op", op: "or", args: [ctx.input("a"), ctx.input("b")] }),
  },
  {
    type: "core.logic.not",
    domain: "core",
    category: "logic",
    title: "Not",
    description: "Inverts a true/false value.",
    inputs: [{ id: "a", kind: "data", type: "boolean", label: "A" }],
    outputs: [{ id: "result", kind: "data", type: "boolean", label: "Result" }],
    params: [],
    keywords: ["invert", "negate"],
    compileExpr: (ctx) => ({ e: "op", op: "not", args: [ctx.input("a")] }),
  },

  // ---- Text and diagnostics ---------------------------------------------------------------
  {
    type: "core.text.join",
    domain: "core",
    category: "data",
    title: "Join Text",
    description: "Joins A and B into one text. Numbers are written without trailing zeros.",
    inputs: [
      { id: "a", kind: "data", type: "text", label: "A", param: "a" },
      { id: "b", kind: "data", type: "text", label: "B", param: "b" },
    ],
    outputs: [{ id: "result", kind: "data", type: "text", label: "Text" }],
    params: [
      { id: "a", label: "A (when unconnected)", kind: "text", default: "" },
      { id: "b", label: "B (when unconnected)", kind: "text", default: "" },
    ],
    keywords: ["concat", "string", "format"],
    compileExpr: (ctx) => ({ e: "op", op: "concat", args: [ctx.input("a"), ctx.input("b")] }),
  },
  {
    type: "core.action.log",
    domain: "core",
    category: "action",
    title: "Log",
    description: "Writes a line to the rule log (shown in the simulator and the engine output).",
    inputs: [EXEC_IN, { id: "message", kind: "data", type: "text", label: "Message", param: "message" }],
    outputs: [EXEC_OUT],
    params: [{ id: "message", label: "Message (when unconnected)", kind: "text", default: "", maxLength: 500 }],
    keywords: ["print", "debug"],
    compileExec: (ctx) => [
      trace(ctx.node.id),
      { s: "call", fn: "core.log", args: { message: ctx.input("message") }, node: ctx.node.id },
      ...ctx.follow("out"),
    ],
  },
];

export const coreDomain: DomainSpec = {
  id: "core",
  title: "Core",
  description: "Engine-neutral events, flow control, variables, math and logic.",
  nodes: coreNodes,
  hostFunctions: { calls: ["core.log"], queries: [] },
};

/** Helper for domain authors: a call statement whose result is stored in the node's temp register. */
export function callStmt(fn: string, args: Record<string, Expr>, nodeId: string, out?: string): Stmt {
  return out ? { s: "call", fn, args, out, node: nodeId } : { s: "call", fn, args, node: nodeId };
}
