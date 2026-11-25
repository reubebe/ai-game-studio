import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GraphBuilder, coreDomain, createRegistry, compileOrThrow } from "./index";
import { testDomain } from "./test-domain";
import { runScenario, type ConformanceFile, type ConformanceScenario } from "./conformance";
import type { Scalar } from "./ir";

const registry = createRegistry([coreDomain, testDomain]);
const FIXTURE = fileURLToPath(new URL("./conformance/fixtures.json", import.meta.url));

type Draft = Omit<ConformanceScenario, "steps" | "program"> & { graph: GraphBuilder; steps: { event: string; payload: Record<string, Scalar> }[] };

function scenarios(): Draft[] {
  const ping = { value: 0, label: "" };
  const out: Draft[] = [];

  {
    const g = new GraphBuilder("counter", "Counter", "testkit");
    g.variable("hits", "number", 0);
    g.node("ping", "test.event.ping");
    g.node("inc", "core.var.add", { variable: "hits", amount: 1 });
    g.node("get", "core.var.get", { variable: "hits" });
    g.node("cmp", "core.compare.number", { operator: ">=", b: 2 });
    g.node("branch", "core.flow.branch");
    g.node("emit", "test.action.emit", { name: "unlocked" });
    g.exec("ping", "out", "inc").exec("inc", "out", "branch").exec("branch", "true", "emit");
    g.data("get", "value", "cmp", "a").data("cmp", "result", "branch", "condition");
    out.push({ name: "counter-threshold", description: "Variables persist across events; branch fires at the threshold.", graph: g, queries: {}, results: {}, steps: [{ event: "ping", payload: ping }, { event: "ping", payload: ping }, { event: "ping", payload: ping }, { event: "start", payload: {} }] });
  }
  {
    const g = new GraphBuilder("formatting", "Formatting", "testkit");
    g.variable("label", "text", "");
    g.node("ping", "test.event.ping");
    g.node("seq", "core.flow.sequence");
    g.node("third", "core.math.divide", { a: 1, b: 3 });
    g.node("log1", "core.action.log");
    g.node("join", "core.text.join", { a: "value=" });
    g.node("log2", "core.action.log");
    g.node("bool", "core.data.boolean", { value: false });
    g.node("log3", "core.action.log");
    g.node("set", "core.var.set", { variable: "label" });
    g.exec("ping", "out", "seq").exec("seq", "first", "log1").exec("log1", "out", "log2").exec("seq", "then", "log3").exec("seq", "finally", "set");
    g.data("third", "result", "log1", "message").data("ping", "value", "join", "b").data("join", "result", "log2", "message").data("bool", "value", "log3", "message").data("ping", "value", "set", "value");
    out.push({ name: "text-formatting", description: "Numbers and booleans convert to text identically in every runtime.", graph: g, queries: {}, results: {}, steps: [{ event: "ping", payload: { value: 2.5, label: "" } }, { event: "ping", payload: { value: -3, label: "" } }, { event: "ping", payload: { value: 0.1 + 0.2, label: "" } }, { event: "ping", payload: { value: -0.125, label: "" } }, { event: "ping", payload: { value: 2.999, label: "" } }, { event: "ping", payload: { value: -0.001, label: "" } }] });
  }
  {
    const g = new GraphBuilder("loops", "Loops", "testkit");
    g.variable("total", "number", 0);
    g.node("ping", "test.event.ping");
    g.node("rep", "core.flow.repeat");
    g.node("add", "core.var.add", { variable: "total" });
    g.node("log", "core.action.log");
    g.node("done", "test.action.emit", { name: "done" });
    g.exec("ping", "out", "rep").exec("rep", "body", "add").exec("add", "out", "log").exec("rep", "done", "done");
    g.data("ping", "value", "rep", "count").data("rep", "index", "add", "amount").data("rep", "index", "log", "message");
    out.push({ name: "repeat-index", description: "Repeat runs the body count times with a zero-based index, then Done.", graph: g, queries: {}, results: {}, steps: [{ event: "ping", payload: { value: 4, label: "" } }, { event: "ping", payload: { value: 0, label: "" } }, { event: "ping", payload: { value: 2.7, label: "" } }] });
  }
  {
    const g = new GraphBuilder("halting", "Halting", "testkit");
    g.node("ping", "test.event.ping");
    g.node("seq", "core.flow.sequence");
    g.node("a", "test.action.emit", { name: "before" });
    g.node("cmp", "core.compare.number", { operator: ">", b: 10 });
    g.node("branch", "core.flow.branch");
    g.node("stop", "core.flow.stop");
    g.node("b", "test.action.emit", { name: "after" });
    g.exec("ping", "out", "seq").exec("seq", "first", "a").exec("a", "out", "branch").exec("branch", "true", "stop").exec("seq", "then", "b");
    g.data("ping", "value", "cmp", "a").data("cmp", "result", "branch", "condition");
    out.push({ name: "stop-halts-handler", description: "Stop ends the handler, skipping later Sequence outputs.", graph: g, queries: {}, results: {}, steps: [{ event: "ping", payload: { value: 1, label: "" } }, { event: "ping", payload: { value: 11, label: "" } }] });
  }
  {
    const g = new GraphBuilder("results", "Results", "testkit");
    g.node("ping", "test.event.ping");
    g.node("roll", "test.action.roll");
    g.node("mul", "core.math.multiply", { b: 2 });
    g.node("join", "core.text.join", { a: "double=" });
    g.node("log", "core.action.log");
    g.node("q", "test.query.counter");
    g.node("emit", "test.action.emit");
    g.exec("ping", "out", "roll").exec("roll", "out", "log").exec("log", "out", "emit");
    g.data("roll", "value", "mul", "a").data("mul", "result", "join", "b").data("join", "result", "log", "message").data("ping", "label", "q", "key").data("q", "value", "emit", "name");
    out.push({ name: "results-and-queries", description: "Action results and host queries feed later nodes.", graph: g, queries: { "test.counter": { by: "key", values: { gems: 7, keys: 2 }, default: 0 } }, results: { "test.roll": { value: 4.25 } }, steps: [{ event: "ping", payload: { value: 0, label: "gems" } }, { event: "ping", payload: { value: 0, label: "other" } }] });
  }
  {
    const g = new GraphBuilder("math", "Math", "testkit");
    g.node("ping", "test.event.ping");
    const ops: [string, string, Record<string, number>][] = [
      ["mod", "core.math.modulo", { b: 12 }],
      ["sub", "core.math.subtract", { b: 5 }],
      ["min", "core.math.min", { b: 0 }],
      ["max", "core.math.max", { b: 0 }],
    ];
    let prev = "ping";
    let prevPin = "out";
    for (const [id, type, params] of ops) {
      g.node(id, type, params);
      g.node(`log_${id}`, "core.action.log");
      g.exec(prev, prevPin, `log_${id}`);
      g.data("ping", "value", id, "a").data(id, "result", `log_${id}`, "message");
      prev = `log_${id}`;
      prevPin = "out";
    }
    for (const op of ["==", "!=", "<", "<=", ">", ">="]) {
      const id = `cmp_${["eq", "ne", "lt", "le", "gt", "ge"][["==", "!=", "<", "<=", ">", ">="].indexOf(op)]}`;
      g.node(id, "core.compare.number", { operator: op, b: 3 });
      g.node(`log_${id}`, "core.action.log");
      g.exec(prev, prevPin, `log_${id}`);
      g.data("ping", "value", id, "a").data(id, "result", `log_${id}`, "message");
      prev = `log_${id}`;
    }
    g.node("teq", "core.compare.text", { b: "gems" });
    g.node("tnot", "core.logic.not");
    g.node("tand", "core.logic.and");
    g.node("tor", "core.logic.or");
    g.node("log_text", "core.action.log");
    g.node("log_logic", "core.action.log");
    g.exec(prev, "out", "log_text").exec("log_text", "out", "log_logic");
    g.data("ping", "label", "teq", "a").data("teq", "result", "log_text", "message");
    g.data("teq", "result", "tnot", "a").data("tnot", "result", "tand", "a").data("teq", "result", "tand", "b").data("tand", "result", "tor", "a").data("teq", "result", "tor", "b").data("tor", "result", "log_logic", "message");
    out.push({ name: "math-and-logic", description: "Modulo, subtraction, min/max, all comparisons, text equality and boolean logic.", graph: g, queries: {}, results: {}, steps: [{ event: "ping", payload: { value: -1, label: "gems" } }, { event: "ping", payload: { value: 3, label: "x" } }, { event: "ping", payload: { value: 25, label: "gems" } }] });
  }
  {
    const g = new GraphBuilder("errors", "Errors", "testkit");
    g.variable("x", "number", 1);
    g.node("ping", "test.event.ping");
    g.node("before", "test.action.emit", { name: "before" });
    g.node("div", "core.math.divide", { a: 10 });
    g.node("set", "core.var.set", { variable: "x" });
    g.node("after", "test.action.emit", { name: "after" });
    g.exec("ping", "out", "before").exec("before", "out", "set").exec("set", "out", "after");
    g.data("ping", "value", "div", "b").data("div", "result", "set", "value");
    out.push({ name: "runtime-error", description: "Division by zero stops the handler and names the failing node.", graph: g, queries: {}, results: {}, steps: [{ event: "ping", payload: { value: 4, label: "" } }, { event: "ping", payload: { value: 0, label: "" } }] });
  }
  return out;
}

function build(): ConformanceFile {
  return {
    format: "gamestudio-rules-conformance",
    version: 1,
    scenarios: scenarios().map((d) => {
      const program = compileOrThrow(d.graph.build(), registry);
      const base = { name: d.name, description: d.description, program, queries: d.queries, results: d.results };
      return { ...base, steps: runScenario({ ...base, steps: d.steps }) };
    }),
  };
}

describe("conformance fixtures", () => {
  it("match the current compiler and TypeScript runtime", () => {
    const current = build();
    const text = JSON.stringify(current, null, 2) + "\n";
    if (process.env["UPDATE_CONFORMANCE"] === "1" || !existsSync(FIXTURE)) writeFileSync(FIXTURE, text);
    const stored = JSON.parse(readFileSync(FIXTURE, "utf8")) as ConformanceFile;
    expect(stored).toEqual(current);
  });

  it("cover the behaviors the GDScript runtime must reproduce", () => {
    const file = build();
    const all = JSON.stringify(file);
    for (const s of ["\"s\":\"repeat\"", "\"s\":\"halt\"", "\"e\":\"query\"", "\"e\":\"temp\"", "\"op\":\"mod\"", "\"op\":\"concat\"", "\"op\":\"text\""]) expect(all).toContain(s);
    const results = file.scenarios.flatMap((s) => s.steps.map((st) => st.expect));
    expect(results.some((r) => r.error)).toBe(true);
    expect(results.some((r) => r.halted)).toBe(true);
    expect(results.some((r) => !r.handled)).toBe(true);
  });
});
