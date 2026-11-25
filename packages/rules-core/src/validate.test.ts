import { describe, expect, it } from "vitest";
import { GraphBuilder, coreDomain, createRegistry, validateGraph } from "./index";
import { testDomain } from "./test-domain";

const registry = createRegistry([coreDomain, testDomain]);
const codes = (graph: unknown) => validateGraph(graph, registry).diagnostics.map((d) => `${d.severity}:${d.code}`);

function base() {
  const g = new GraphBuilder("demo", "Demo", "testkit");
  g.variable("score", "number", 0);
  g.node("start", "core.event.start");
  g.node("log", "core.action.log", { message: "hello" });
  g.exec("start", "out", "log");
  return g;
}

describe("validateGraph", () => {
  it("accepts a minimal valid graph", () => {
    const result = validateGraph(base().build(), registry);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("rejects malformed documents through the schema", () => {
    const g = base().build() as unknown as Record<string, unknown>;
    g["id"] = "Bad Id!";
    expect(codes(g)).toContain("error:schema");
  });

  it("reports unknown node types", () => {
    const g = base();
    g.node("x", "core.does.not.exist");
    expect(codes(g.build())).toContain("error:unknown-node");
  });

  it("reports nodes from another domain", () => {
    const g = new GraphBuilder("demo", "Demo", "core");
    g.node("ping", "test.event.ping");
    expect(codes(g.build())).toContain("error:wrong-domain");
  });

  it("rejects data type mismatches", () => {
    const g = base();
    g.node("num", "core.data.number", { value: 3 });
    g.node("branch", "core.flow.branch");
    g.exec("log", "out", "branch");
    g.data("num", "value", "branch", "condition");
    expect(codes(g.build())).toContain("error:type-mismatch");
  });

  it("allows numbers to flow into text inputs", () => {
    const g = base();
    g.node("num", "core.data.number", { value: 3 });
    g.node("log2", "core.action.log");
    g.exec("log", "out", "log2");
    g.data("num", "value", "log2", "message");
    expect(validateGraph(g.build(), registry).ok).toBe(true);
  });

  it("rejects exec-to-data connections", () => {
    const g = base();
    g.node("branch", "core.flow.branch");
    const graph = g.build();
    graph.edges.push({ id: "bad", source: "log", sourceHandle: "exec:out", target: "branch", targetHandle: "data:condition" });
    expect(codes(graph)).toContain("error:kind-mismatch");
  });

  it("rejects handles that name pins the node does not have", () => {
    const graph = base().build();
    graph.edges.push({ id: "bad", source: "start", sourceHandle: "exec:nowhere", target: "log", targetHandle: "exec:in" });
    expect(codes(graph)).toContain("error:bad-handle");
  });

  it("rejects two connections into one data input", () => {
    const g = base();
    g.node("t", "core.data.boolean", { value: true });
    g.node("f", "core.data.boolean", { value: false });
    g.node("branch", "core.flow.branch");
    g.exec("log", "out", "branch");
    g.data("t", "value", "branch", "condition");
    g.data("f", "value", "branch", "condition");
    expect(codes(g.build())).toContain("error:multiple-inputs");
  });

  it("rejects an exec output with two targets", () => {
    const g = base();
    g.node("a", "core.action.log");
    g.node("b", "core.action.log");
    g.exec("log", "out", "a");
    g.exec("log", "out", "b");
    expect(codes(g.build())).toContain("error:multiple-exec");
  });

  it("rejects execution cycles", () => {
    const g = base();
    g.node("a", "core.action.log");
    g.exec("log", "out", "a");
    g.exec("a", "out", "log");
    expect(codes(g.build())).toContain("error:exec-cycle");
  });

  it("rejects data cycles between pure nodes", () => {
    const g = base();
    g.node("m1", "core.math.add");
    g.node("m2", "core.math.add");
    g.data("m1", "result", "m2", "a");
    g.data("m2", "result", "m1", "a");
    expect(codes(g.build())).toContain("error:data-cycle");
  });

  it("warns about nodes no event reaches", () => {
    const g = base();
    g.node("orphan", "core.action.log");
    expect(codes(g.build())).toContain("warning:unreachable");
  });

  it("requires connections for inputs without a fallback value", () => {
    const g = base();
    g.node("branch", "core.flow.branch");
    g.exec("log", "out", "branch");
    expect(codes(g.build())).toContain("error:unconnected-input");
  });

  it("validates variable references and types", () => {
    const g = base();
    g.variable("name", "text", "x");
    g.node("inc", "core.var.add", { variable: "name" });
    g.node("bad", "core.var.add", { variable: "missing" });
    g.exec("log", "out", "inc");
    g.exec("inc", "out", "bad");
    const messages = validateGraph(g.build(), registry).diagnostics.map((d) => d.message).join("\n");
    expect(messages).toMatch(/needs a number variable/);
    expect(messages).toMatch(/unknown variable 'missing'/);
  });

  it("enforces one handler per event", () => {
    const g = base();
    g.node("start2", "core.event.start");
    expect(codes(g.build())).toContain("error:too-many");
  });

  it("checks parameter ranges", () => {
    const g = base();
    g.node("rep", "core.flow.repeat", { count: 5000 });
    g.exec("log", "out", "rep");
    expect(codes(g.build())).toContain("error:bad-param");
  });

  it("checks scalar fallback values against the variable type", () => {
    const g = base();
    g.node("set", "core.var.set", { variable: "score", value: "ten" });
    g.exec("log", "out", "set");
    expect(codes(g.build())).toContain("error:bad-param");
  });

  it("warns when a graph has no events", () => {
    const g = new GraphBuilder("empty", "Empty", "core");
    g.node("n", "core.data.number");
    expect(codes(g.build())).toContain("warning:no-events");
  });
});
