/**
 * Rule IR v1: the engine-neutral, compiled form of a rule graph.
 *
 * The IR is structured (nested statement lists), not jump-based, so it can be
 * interpreted with identical semantics by the TypeScript runtime and by the
 * engine runtimes in engine-addons/ (GDScript for Godot, C# for Unity, C++ for
 * Unreal). Any change here must be mirrored in all three and covered by the
 * conformance fixtures in ./conformance (runtimes.test.ts runs the C# and C++
 * ones; the Godot integration test runs the GDScript one).
 */

export const IR_VERSION = 1 as const;

export type Scalar = number | boolean | string;
export type ValueType = "number" | "boolean" | "text";

export type OpName =
  | "add" | "sub" | "mul" | "div" | "idiv" | "mod" | "min" | "max" | "neg" | "abs" | "floor" | "ceil" | "round"
  | "eq" | "neq" | "lt" | "lte" | "gt" | "gte"
  | "and" | "or" | "not"
  | "text" | "concat";

export type Expr =
  | { e: "const"; v: Scalar }
  | { e: "var"; name: string }
  | { e: "param"; name: string }
  | { e: "temp"; name: string; field: string }
  | { e: "op"; op: OpName; args: Expr[] }
  | { e: "query"; fn: string; args: Record<string, Expr> };

export type Stmt =
  | { s: "call"; fn: string; args: Record<string, Expr>; out?: string; node?: string }
  | { s: "set"; var: string; value: Expr; node?: string }
  | { s: "if"; cond: Expr; then: Stmt[]; else: Stmt[]; node?: string }
  | { s: "switch"; value: Expr; cases: Record<string, Stmt[]>; default: Stmt[]; node?: string }
  | { s: "repeat"; count: Expr; index: string; body: Stmt[]; node?: string }
  | { s: "trace"; node: string }
  | { s: "halt"; node?: string };

export interface VariableDecl {
  type: ValueType;
  initial: Scalar;
}

export interface Handler {
  /** Payload field names the event supplies. */
  params: string[];
  body: Stmt[];
}

export interface RuleProgram {
  irVersion: typeof IR_VERSION;
  graphId: string;
  graphName: string;
  domain: string;
  /** Stable hash of the source graph's semantic content (positions excluded). */
  sourceHash: string;
  /** Domain configuration aggregated from node parameters (for example, Oware variant settings). */
  domainConfig: Record<string, unknown>;
  variables: Record<string, VariableDecl>;
  handlers: Record<string, Handler>;
}

/** Hard limits shared by both runtimes. */
export const LIMITS = {
  maxStatementsPerRun: 20000,
  maxRepeatCount: 1000,
  maxCompiledStatements: 5000,
  maxNestingDepth: 64,
} as const;
