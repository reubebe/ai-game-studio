import type { Scalar } from "./ir";
import type { CallResult, RuleHost } from "./interpret";

export interface RecordedCall {
  fn: string;
  args: Record<string, Scalar>;
}

/**
 * Deterministic host for tests and conformance fixtures: records every call and
 * answers queries and call results from scripted tables.
 */
export class RecordingHost implements RuleHost {
  readonly calls: RecordedCall[] = [];
  constructor(
    private readonly queries: Record<string, Scalar | ((args: Record<string, Scalar>) => Scalar)> = {},
    private readonly results: Record<string, Record<string, Scalar> | ((args: Record<string, Scalar>) => CallResult)> = {},
  ) {}

  call(fn: string, args: Record<string, Scalar>): CallResult {
    this.calls.push({ fn, args });
    const r = this.results[fn];
    return typeof r === "function" ? r(args) : r;
  }

  query(fn: string, args: Record<string, Scalar>): Scalar {
    const q = this.queries[fn];
    if (q === undefined) throw new Error(`No scripted answer for query '${fn}'`);
    return typeof q === "function" ? q(args) : q;
  }
}
