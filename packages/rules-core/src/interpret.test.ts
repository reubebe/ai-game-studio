import { describe, expect, it } from "vitest";
import { GraphBuilder, RecordingHost, RuleRuntime, coreDomain, createRegistry, compileOrThrow, formatNumber, applyOp } from "./index";
import { testDomain } from "./test-domain";

const registry = createRegistry([coreDomain, testDomain]);

function counterGraph(threshold: number) {
  const g = new GraphBuilder("counter", "Counter", "testkit");
  g.variable("hits", "number", 0);
  g.node("ping", "test.event.ping");
  g.node("inc", "core.var.add", { variable: "hits", amount: 1 });
  g.node("get", "core.var.get", { variable: "hits" });
  g.node("cmp", "core.compare.number", { operator: ">=", b: threshold });
  g.node("branch", "core.flow.branch");
  g.node("emit", "test.action.emit", { name: "unlocked" });
  g.exec("ping", "out", "inc").exec("inc", "out", "branch").exec("branch", "true", "emit");
  g.data("get", "value", "cmp", "a").data("cmp", "result", "branch", "condition");
  return g.build();
}

describe("RuleRuntime", () => {
  it("updates variables and branches at a threshold", () => {
    const runtime = new RuleRuntime(compileOrThrow(counterGraph(3), registry));
    const host = new RecordingHost();
    for (let i = 0; i < 2; i++) runtime.run("ping", { value: 0, label: "" }, host);
    expect(host.calls).toEqual([]);
    const third = runtime.run("ping", { value: 0, label: "" }, host);
    expect(runtime.variables["hits"]).toBe(3);
    expect(host.calls).toEqual([{ fn: "test.emit", args: { name: "unlocked" } }]);
    expect(third.trace).toEqual(["ping", "inc", "branch", "emit"]);
  });

  it("reports unhandled events without side effects", () => {
    const runtime = new RuleRuntime(compileOrThrow(counterGraph(3), registry));
    expect(runtime.run("start", {}, new RecordingHost()).handled).toBe(false);
  });

  it("stops at a Stop node", () => {
    const g = new GraphBuilder("stop", "Stop", "testkit");
    g.node("start", "core.event.start");
    g.node("seq", "core.flow.sequence");
    g.node("stop", "core.flow.stop");
    g.node("emit", "test.action.emit");
    g.exec("start", "out", "seq").exec("seq", "first", "stop").exec("seq", "then", "emit");
    const host = new RecordingHost();
    const result = new RuleRuntime(compileOrThrow(g.build(), registry)).run("start", {}, host);
    expect(result.halted).toBe(true);
    expect(host.calls).toEqual([]);
  });

  it("repeats a body with an index", () => {
    const g = new GraphBuilder("rep", "Repeat", "testkit");
    g.node("start", "core.event.start");
    g.node("rep", "core.flow.repeat", { count: 3 });
    g.node("log", "core.action.log");
    g.exec("start", "out", "rep").exec("rep", "body", "log");
    g.data("rep", "index", "log", "message");
    const result = new RuleRuntime(compileOrThrow(g.build(), registry)).run("start", {}, new RecordingHost());
    expect(result.logs).toEqual(["0", "1", "2"]);
  });

  it("passes action results to later nodes", () => {
    const g = new GraphBuilder("roll", "Roll", "testkit");
    g.node("ping", "test.event.ping");
    g.node("roll", "test.action.roll");
    g.node("join", "core.text.join", { a: "rolled " });
    g.node("log", "core.action.log");
    g.exec("ping", "out", "roll").exec("roll", "out", "log");
    g.data("roll", "value", "join", "b").data("join", "result", "log", "message");
    const host = new RecordingHost({}, { "test.roll": { value: 2.5 } });
    const result = new RuleRuntime(compileOrThrow(g.build(), registry)).run("ping", { value: 1, label: "x" }, host);
    expect(result.logs).toEqual(["rolled 2.5"]);
  });

  it("reports runtime errors with the failing node", () => {
    const g = new GraphBuilder("div", "Divide", "testkit");
    g.variable("x", "number", 1);
    g.node("start", "core.event.start");
    g.node("div", "core.math.divide", { a: 1, b: 0 });
    g.node("set", "core.var.set", { variable: "x" });
    g.exec("start", "out", "set");
    g.data("div", "result", "set", "value");
    const result = new RuleRuntime(compileOrThrow(g.build(), registry)).run("start", {}, new RecordingHost());
    expect(result.error?.message).toMatch(/Division by zero/);
    expect(result.error?.node).toBe("set");
  });

  it("stops runaway programs at the step limit", () => {
    const g = new GraphBuilder("loop", "Loop", "testkit");
    g.variable("n", "number", 0);
    g.node("start", "core.event.start");
    g.node("rep", "core.flow.repeat", { count: 1000 });
    g.node("inc", "core.var.add", { variable: "n" });
    g.exec("start", "out", "rep").exec("rep", "body", "inc");
    const result = new RuleRuntime(compileOrThrow(g.build(), registry)).run("start", {}, new RecordingHost(), 500);
    expect(result.error?.message).toMatch(/Stopped after 500 steps/);
  });

  it("reads host queries", () => {
    const g = new GraphBuilder("q", "Query", "testkit");
    g.node("start", "core.event.start");
    g.node("q", "test.query.counter", { key: "gems" });
    g.node("log", "core.action.log");
    g.exec("start", "out", "log");
    g.data("q", "value", "log", "message");
    const host = new RecordingHost({ "test.counter": (args) => (args["key"] === "gems" ? 7 : 0) });
    expect(new RuleRuntime(compileOrThrow(g.build(), registry)).run("start", {}, host).logs).toEqual(["7"]);
  });
});

describe("shared value semantics", () => {
  it("formats numbers identically for every runtime", () => {
    expect(formatNumber(3)).toBe("3");
    expect(formatNumber(-2)).toBe("-2");
    expect(formatNumber(2.5)).toBe("2.5");
    expect(formatNumber(1 / 3)).toBe("0.33");
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(-0.125)).toBe("-0.12");
    expect(formatNumber(0.125)).toBe("0.13");
    expect(formatNumber(-0.001)).toBe("0");
    expect(formatNumber(2.999)).toBe("3");
    expect(formatNumber(-0)).toBe("0");
  });

  it("uses mathematical modulo and half-up rounding", () => {
    expect(applyOp("mod", [-1, 12])).toBe(11);
    expect(applyOp("mod", [13, 12])).toBe(1);
    expect(applyOp("round", [-2.5])).toBe(-2);
    expect(applyOp("round", [2.5])).toBe(3);
    expect(applyOp("idiv", [-7, 2])).toBe(-4);
  });

  it("compares values strictly by type", () => {
    expect(applyOp("eq", [1, "1"])).toBe(false);
    expect(applyOp("eq", ["a", "a"])).toBe(true);
  });
});
