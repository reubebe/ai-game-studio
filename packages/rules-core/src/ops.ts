import type { OpName, Scalar } from "./ir";
import { toText } from "./format";

export class RuleRuntimeError extends Error {
  constructor(message: string, public readonly node?: string) {
    super(message);
    this.name = "RuleRuntimeError";
  }
}

function num(v: Scalar, op: string): number {
  if (typeof v !== "number" || Number.isNaN(v)) throw new RuleRuntimeError(`Operator '${op}' expects a number, received ${typeof v}`);
  return v;
}
function bool(v: Scalar, op: string): boolean {
  if (typeof v !== "boolean") throw new RuleRuntimeError(`Operator '${op}' expects true/false, received ${typeof v}`);
  return v;
}

/** Arity of each operator; checked by the compiler and both runtimes. */
export const OP_ARITY: Record<OpName, number> = {
  add: 2, sub: 2, mul: 2, div: 2, idiv: 2, mod: 2, min: 2, max: 2, neg: 1, abs: 1, floor: 1, ceil: 1, round: 1,
  eq: 2, neq: 2, lt: 2, lte: 2, gt: 2, gte: 2,
  and: 2, or: 2, not: 1,
  text: 1, concat: 2,
};

export function applyOp(op: OpName, args: Scalar[]): Scalar {
  const a = args[0] as Scalar;
  const b = args[1] as Scalar;
  switch (op) {
    case "add": return num(a, op) + num(b, op);
    case "sub": return num(a, op) - num(b, op);
    case "mul": return num(a, op) * num(b, op);
    case "div": {
      const d = num(b, op);
      if (d === 0) throw new RuleRuntimeError("Division by zero");
      return num(a, op) / d;
    }
    case "idiv": {
      const d = num(b, op);
      if (d === 0) throw new RuleRuntimeError("Division by zero");
      return Math.floor(num(a, op) / d);
    }
    case "mod": {
      const d = num(b, op);
      if (d === 0) throw new RuleRuntimeError("Modulo by zero");
      const n = num(a, op);
      return ((n % d) + d) % d;
    }
    case "min": return Math.min(num(a, op), num(b, op));
    case "max": return Math.max(num(a, op), num(b, op));
    case "neg": return -num(a, op);
    case "abs": return Math.abs(num(a, op));
    case "floor": return Math.floor(num(a, op));
    case "ceil": return Math.ceil(num(a, op));
    // Half-up rounding defined explicitly; GDScript's round() rounds half away from zero.
    case "round": return Math.floor(num(a, op) + 0.5);
    case "eq": return a === b;
    case "neq": return a !== b;
    case "lt": return num(a, op) < num(b, op);
    case "lte": return num(a, op) <= num(b, op);
    case "gt": return num(a, op) > num(b, op);
    case "gte": return num(a, op) >= num(b, op);
    case "and": return bool(a, op) && bool(b, op);
    case "or": return bool(a, op) || bool(b, op);
    case "not": return !bool(a, op);
    case "text": return toText(a);
    case "concat": return toText(a) + toText(b);
  }
}
