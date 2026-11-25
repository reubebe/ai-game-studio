import { describe, expect, it } from "vitest";
import { GraphBuilder, coreDomain, createRegistry, compileGraph, semanticHash } from "./index";
import { testDomain } from "./test-domain";

const registry = createRegistry([coreDomain, testDomain]);

describe("compileGraph", () => {
  it("compiles events into handlers with traced statements", () => {
    const g = new GraphBuilder("demo", "Demo", "testkit");
    g.variable("score", "number", 0);
    g.node("start", "core.event.start");
    g.node("inc", "core.var.add", { variable: "score", amount: 2 });
    g.exec("start", "out", "inc");
    const result = compileGraph(g.build(), registry);
    expect(result.ok).toBe(true);
    const handler = result.program!.handlers["start"]!;
    expect(handler.params).toEqual([]);
    expect(handler.body).toEqual([
      { s: "trace", node: "start" },
      { s: "trace", node: "inc" },
      { s: "set", var: "score", value: { e: "op", op: "add", args: [{ e: "var", name: "score" }, { e: "const", v: 2 }] }, node: "inc" },
    ]);
    expect(result.program!.variables).toEqual({ score: { type: "number", initial: 0 } });
  });

  it("exposes event payload fields as parameters", () => {
    const g = new GraphBuilder("demo", "Demo", "testkit");
    g.node("ping", "test.event.ping");
    g.node("emit", "test.action.emit");
    g.exec("ping", "out", "emit");
    g.data("ping", "label", "emit", "name");
    const program = compileGraph(g.build(), registry).program!;
    expect(program.handlers["ping"]!.params).toEqual(["value", "label"]);
    expect(JSON.stringify(program.handlers["ping"]!.body)).toContain('{"e":"param","name":"label"}');
  });

  it("lets later nodes read an action's result", () => {
    const g = new GraphBuilder("demo", "Demo", "testkit");
    g.node("ping", "test.event.ping");
    g.node("roll", "test.action.roll");
    g.node("log", "core.action.log");
    g.exec("ping", "out", "roll");
    g.exec("roll", "out", "log");
    g.data("roll", "value", "log", "message");
    const result = compileGraph(g.build(), registry);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.program)).toContain('"e":"temp","name":"t_roll","field":"value"');
  });

  it("refuses to read an action's result before the action runs", () => {
    const g = new GraphBuilder("demo", "Demo", "testkit");
    g.node("ping", "test.event.ping");
    g.node("log", "core.action.log");
    g.node("roll", "test.action.roll");
    g.exec("ping", "out", "log");
    g.exec("log", "out", "roll");
    g.data("roll", "value", "log", "message");
    const result = compileGraph(g.build(), registry);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("used-before-run");
  });

  it("refuses data from a different event's payload", () => {
    const g = new GraphBuilder("demo", "Demo", "testkit");
    g.node("ping", "test.event.ping");
    g.node("start", "core.event.start");
    g.node("log", "core.action.log");
    g.exec("start", "out", "log");
    g.data("ping", "label", "log", "message");
    const result = compileGraph(g.build(), registry);
    expect(result.diagnostics.map((d) => d.code)).toContain("foreign-event-data");
  });

  it("converts numbers to text where text is required", () => {
    const g = new GraphBuilder("demo", "Demo", "testkit");
    g.node("start", "core.event.start");
    g.node("n", "core.data.number", { value: 4 });
    g.node("log", "core.action.log");
    g.exec("start", "out", "log");
    g.data("n", "value", "log", "message");
    const body = JSON.stringify(compileGraph(g.build(), registry).program!.handlers["start"]);
    expect(body).toContain('{"e":"op","op":"text","args":[{"e":"const","v":4}]}');
  });

  it("scopes a Repeat index to the loop body", () => {
    const g = new GraphBuilder("demo", "Demo", "testkit");
    g.node("start", "core.event.start");
    g.node("rep", "core.flow.repeat", { count: 2 });
    g.node("log", "core.action.log");
    g.exec("start", "out", "rep");
    g.exec("rep", "done", "log");
    g.data("rep", "index", "log", "message");
    const result = compileGraph(g.build(), registry);
    expect(result.diagnostics.map((d) => d.code)).toContain("used-before-run");
  });

  it("hashes semantics, not layout", () => {
    const g = new GraphBuilder("demo", "Demo", "testkit");
    g.node("start", "core.event.start", {}, { x: 0, y: 0 });
    const a = g.build();
    const b = structuredClone(a);
    b.nodes[0]!.position = { x: 500, y: 90 };
    expect(semanticHash(a)).toBe(semanticHash(b));
    b.nodes[0]!.params = { extra: 1 };
    expect(semanticHash(a)).not.toBe(semanticHash(b));
  });

  it("does not compile graphs with validation errors", () => {
    const g = new GraphBuilder("demo", "Demo", "testkit");
    g.node("x", "core.unknown");
    expect(compileGraph(g.build(), registry).ok).toBe(false);
  });
});
