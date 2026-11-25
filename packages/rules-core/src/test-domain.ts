import type { DomainSpec } from "./registry";
import { callStmt } from "./core-nodes";

/** A minimal domain used by unit tests and conformance fixtures. Not exposed in the studio. */
export const testDomain: DomainSpec = {
  id: "testkit",
  title: "Test kit",
  description: "Nodes used only by automated tests.",
  hostFunctions: { calls: ["test.emit", "test.roll"], queries: ["test.counter"] },
  nodes: [
    {
      type: "test.event.ping",
      domain: "testkit",
      category: "event",
      title: "On Ping",
      description: "Test event with a number and a label.",
      inputs: [],
      outputs: [
        { id: "out", kind: "exec" },
        { id: "value", kind: "data", type: "number", label: "Value" },
        { id: "label", kind: "data", type: "text", label: "Label" },
      ],
      params: [],
      event: { name: "ping" },
      maxPerGraph: 1,
      compileExec: (ctx) => [{ s: "trace", node: ctx.node.id }, ...ctx.follow("out")],
    },
    {
      type: "test.action.emit",
      domain: "testkit",
      category: "action",
      title: "Emit",
      description: "Records a named effect.",
      inputs: [{ id: "in", kind: "exec" }, { id: "name", kind: "data", type: "text", label: "Name", param: "name" }],
      outputs: [{ id: "out", kind: "exec" }],
      params: [{ id: "name", label: "Name", kind: "text", default: "effect" }],
      compileExec: (ctx) => [{ s: "trace", node: ctx.node.id }, callStmt("test.emit", { name: ctx.input("name") }, ctx.node.id), ...ctx.follow("out")],
    },
    {
      type: "test.action.roll",
      domain: "testkit",
      category: "action",
      title: "Roll",
      description: "Asks the host for a value.",
      inputs: [{ id: "in", kind: "exec" }],
      outputs: [{ id: "out", kind: "exec" }, { id: "value", kind: "data", type: "number", label: "Value" }],
      params: [],
      compileExec: (ctx) => [{ s: "trace", node: ctx.node.id }, callStmt("test.roll", {}, ctx.node.id, ctx.temp), ...ctx.follow("out")],
    },
    {
      type: "test.query.counter",
      domain: "testkit",
      category: "query",
      title: "Counter",
      description: "Reads a host counter.",
      inputs: [{ id: "key", kind: "data", type: "text", label: "Key", param: "key" }],
      outputs: [{ id: "value", kind: "data", type: "number", label: "Value" }],
      params: [{ id: "key", label: "Key", kind: "text", default: "a" }],
      compileExpr: (ctx) => ({ e: "query", fn: "test.counter", args: { key: ctx.input("key") } }),
    },
  ],
};
