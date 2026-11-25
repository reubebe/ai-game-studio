import type { RuleProgram, Scalar } from "./ir";
import { RuleRuntime, type RuleHost, type CallResult } from "./interpret";

/**
 * Conformance fixtures are shared with the engine runtimes: GDScript
 * (engine-addons/godot/gamestudio_runtime/tests/run_conformance.gd), C#
 * (engine-addons/unity/tests/Conformance.cs) and C++ (engine-addons/unreal/tests/conformance.cpp).
 * Each scenario runs events in order against a scripted host; results must match.
 */
export type QueryAnswer = Scalar | { by: string; values: Record<string, Scalar>; default: Scalar };

export interface ConformanceStep {
  event: string;
  payload: Record<string, Scalar>;
  expect: {
    handled: boolean;
    halted: boolean;
    error: boolean;
    errorNode: string | null;
    variables: Record<string, Scalar>;
    calls: { fn: string; args: Record<string, Scalar> }[];
    logs: string[];
    trace: string[];
  };
}

export interface ConformanceScenario {
  name: string;
  description: string;
  program: RuleProgram;
  queries: Record<string, QueryAnswer>;
  results: Record<string, Record<string, Scalar>>;
  steps: ConformanceStep[];
}

export interface ConformanceFile {
  format: "gamestudio-rules-conformance";
  version: 1;
  scenarios: ConformanceScenario[];
}

export class ScriptedHost implements RuleHost {
  calls: { fn: string; args: Record<string, Scalar> }[] = [];
  constructor(
    private readonly queries: Record<string, QueryAnswer>,
    private readonly results: Record<string, Record<string, Scalar>>,
  ) {}
  call(fn: string, args: Record<string, Scalar>): CallResult {
    this.calls.push({ fn, args });
    const r = this.results[fn];
    return r ? { ...r } : undefined;
  }
  query(fn: string, args: Record<string, Scalar>): Scalar {
    const answer = this.queries[fn];
    if (answer === undefined) throw new Error(`No scripted answer for '${fn}'`);
    if (typeof answer === "object") {
      const key = String(args[answer.by]);
      return Object.hasOwn(answer.values, key) ? (answer.values[key] as Scalar) : answer.default;
    }
    return answer;
  }
}

/** Execute a scenario with the TypeScript runtime and return the observed step results. */
export function runScenario(s: Omit<ConformanceScenario, "steps"> & { steps: { event: string; payload: Record<string, Scalar> }[] }): ConformanceStep[] {
  const runtime = new RuleRuntime(s.program);
  return s.steps.map((step) => {
    const host = new ScriptedHost(s.queries, s.results);
    const r = runtime.run(step.event, step.payload, host);
    return {
      event: step.event,
      payload: step.payload,
      expect: {
        handled: r.handled,
        halted: r.halted,
        error: Boolean(r.error),
        errorNode: r.error?.node ?? null,
        variables: { ...runtime.variables },
        calls: host.calls,
        logs: r.logs,
        trace: r.trace,
      },
    };
  });
}
