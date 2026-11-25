import { RULE_GRAPH_SCHEMA_VERSION, handleId, type RuleGraph } from "./graph";
import type { Scalar, ValueType } from "./ir";

/**
 * Small fluent builder used by templates and tests to author rule graphs in code.
 * The output is ordinary editor JSON: users can open and change it in the rule editor.
 */
export class GraphBuilder {
  private readonly graph: RuleGraph;
  private edgeCount = 0;
  private autoX = 0;

  constructor(id: string, name: string, domain: string, description?: string) {
    this.graph = { schemaVersion: RULE_GRAPH_SCHEMA_VERSION, kind: "rule-graph", id, name, domain, variables: [], nodes: [], edges: [] };
    if (description) this.graph.description = description;
  }

  provenance(p: NonNullable<RuleGraph["provenance"]>): this {
    this.graph.provenance = p;
    return this;
  }

  variable(name: string, type: ValueType, initial: Scalar, description?: string): this {
    this.graph.variables.push(description ? { name, type, initial, description } : { name, type, initial });
    return this;
  }

  node(id: string, type: string, params: Record<string, unknown> = {}, position?: { x: number; y: number }, extra?: { label?: string; comment?: string }): string {
    const pos = position ?? { x: (this.autoX += 260), y: 0 };
    this.graph.nodes.push({ id, type, position: pos, params, ...(extra ?? {}) });
    return id;
  }

  exec(source: string, sourcePin: string, target: string, targetPin = "in"): this {
    this.graph.edges.push({ id: `e${++this.edgeCount}`, source, sourceHandle: handleId("exec", sourcePin), target, targetHandle: handleId("exec", targetPin) });
    return this;
  }

  data(source: string, sourcePin: string, target: string, targetPin: string): this {
    this.graph.edges.push({ id: `e${++this.edgeCount}`, source, sourceHandle: handleId("data", sourcePin), target, targetHandle: handleId("data", targetPin) });
    return this;
  }

  build(): RuleGraph {
    return structuredClone(this.graph);
  }
}
