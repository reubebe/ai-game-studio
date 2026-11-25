import { LIMITS, type Expr, type RuleProgram, type Scalar, type Stmt } from "./ir";
import { applyOp, OP_ARITY, RuleRuntimeError } from "./ops";
import { toText } from "./format";

export type CallResult = Record<string, Scalar> | void | undefined;

export interface RuleHost {
  /** Actions with side effects. May return named result fields for downstream data pins. */
  call(fn: string, args: Record<string, Scalar>): CallResult;
  /** Pure reads of game state. */
  query(fn: string, args: Record<string, Scalar>): Scalar;
}

export interface RunResult {
  handled: boolean;
  halted: boolean;
  /** Node ids in execution order (for editor highlighting). */
  trace: string[];
  logs: string[];
  statements: number;
  error?: { message: string; node?: string };
}

class Halt extends Error {}

export class RuleRuntime {
  private vars: Record<string, Scalar> = {};

  constructor(readonly program: RuleProgram) {
    this.reset();
  }

  reset(): void {
    this.vars = Object.fromEntries(Object.entries(this.program.variables).map(([k, v]) => [k, v.initial]));
  }

  get variables(): Readonly<Record<string, Scalar>> {
    return { ...this.vars };
  }

  setVariables(values: Record<string, Scalar>): void {
    for (const [k, v] of Object.entries(values)) if (k in this.program.variables) this.vars[k] = v;
  }

  hasHandler(event: string): boolean {
    return Object.hasOwn(this.program.handlers, event);
  }

  run(event: string, payload: Record<string, Scalar>, host: RuleHost, maxStatements: number = LIMITS.maxStatementsPerRun): RunResult {
    const result: RunResult = { handled: false, halted: false, trace: [], logs: [], statements: 0 };
    const handler = this.program.handlers[event];
    if (!handler) return result;
    result.handled = true;
    const temps: Record<string, Record<string, Scalar>> = {};
    let current: string | undefined;

    const evalExpr = (expr: Expr): Scalar => {
      switch (expr.e) {
        case "const":
          return expr.v;
        case "var": {
          if (!Object.hasOwn(this.vars, expr.name)) throw new RuleRuntimeError(`Unknown variable '${expr.name}'`, current);
          return this.vars[expr.name] as Scalar;
        }
        case "param": {
          const v = payload[expr.name];
          if (v === undefined) throw new RuleRuntimeError(`Event '${event}' is missing '${expr.name}'`, current);
          return v;
        }
        case "temp": {
          const record = temps[expr.name];
          const v = record?.[expr.field];
          if (v === undefined) throw new RuleRuntimeError(`Value '${expr.field}' is not available yet`, current);
          return v;
        }
        case "op": {
          if (expr.args.length !== OP_ARITY[expr.op]) throw new RuleRuntimeError(`Operator '${expr.op}' has the wrong number of inputs`, current);
          try {
            return applyOp(expr.op, expr.args.map(evalExpr));
          } catch (error) {
            if (error instanceof RuleRuntimeError && !error.node) throw new RuleRuntimeError(error.message, current);
            throw error;
          }
        }
        case "query": {
          const args = Object.fromEntries(Object.entries(expr.args).map(([k, v]) => [k, evalExpr(v)]));
          const value = host.query(expr.fn, args);
          if (value === undefined || value === null) throw new RuleRuntimeError(`Query '${expr.fn}' returned no value`, current);
          return value;
        }
      }
    };

    const exec = (stmts: Stmt[]): void => {
      for (const stmt of stmts) {
        result.statements += 1;
        if (result.statements > maxStatements) throw new RuleRuntimeError(`Stopped after ${maxStatements} steps (possible runaway rule)`, current);
        if (stmt.node) current = stmt.node;
        switch (stmt.s) {
          case "trace":
            current = stmt.node;
            if (result.trace[result.trace.length - 1] !== stmt.node) result.trace.push(stmt.node);
            break;
          case "set": {
            const decl = this.program.variables[stmt.var];
            if (!decl) throw new RuleRuntimeError(`Unknown variable '${stmt.var}'`, current);
            let value = evalExpr(stmt.value);
            if (decl.type === "text") value = toText(value);
            const ok = (decl.type === "number" && typeof value === "number") || (decl.type === "boolean" && typeof value === "boolean") || (decl.type === "text" && typeof value === "string");
            if (!ok) throw new RuleRuntimeError(`Variable '${stmt.var}' needs ${decl.type}`, current);
            this.vars[stmt.var] = value;
            break;
          }
          case "call": {
            const args = Object.fromEntries(Object.entries(stmt.args).map(([k, v]) => [k, evalExpr(v)]));
            if (stmt.fn === "core.log") {
              result.logs.push(toText(args["message"] ?? ""));
              if (stmt.out) temps[stmt.out] = {};
              break;
            }
            const out = host.call(stmt.fn, args);
            if (stmt.out) temps[stmt.out] = out && typeof out === "object" ? { ...out } : {};
            break;
          }
          case "if": {
            const cond = evalExpr(stmt.cond);
            if (typeof cond !== "boolean") throw new RuleRuntimeError("Branch condition must be true or false", current);
            exec(cond ? stmt.then : stmt.else);
            break;
          }
          case "switch": {
            const value = toText(evalExpr(stmt.value));
            exec(Object.hasOwn(stmt.cases, value) ? (stmt.cases[value] as Stmt[]) : stmt.default);
            break;
          }
          case "repeat": {
            const n = evalExpr(stmt.count);
            if (typeof n !== "number" || !Number.isFinite(n)) throw new RuleRuntimeError("Repeat count must be a number", current);
            const times = Math.max(0, Math.min(LIMITS.maxRepeatCount, Math.floor(n)));
            for (let i = 0; i < times; i++) {
              temps[stmt.index] = { index: i };
              exec(stmt.body);
            }
            delete temps[stmt.index];
            break;
          }
          case "halt":
            throw new Halt();
        }
      }
    };

    try {
      exec(handler.body);
    } catch (error) {
      if (error instanceof Halt) result.halted = true;
      else if (error instanceof RuleRuntimeError) result.error = { message: error.message, node: error.node ?? current };
      else result.error = { message: error instanceof Error ? error.message : String(error), node: current };
    }
    return result;
  }
}
