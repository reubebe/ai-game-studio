import { paramsWithDefaults, parseHandle, type NodeRegistry, type RuleGraph } from "@gamestudio/rules-core";

export interface Step {
  nodeId: string;
  depth: number;
  text: string;
  branch?: string;
  editable?: { param: string; value: string };
}

/** Plain-language outline of each event's execution chain, for Creator mode. */
export function describeGraph(graph: RuleGraph, registry: NodeRegistry): { event: string; nodeId: string; steps: Step[] }[] {
  const out = new Map<string, { target: string; pin: string }[]>();
  for (const e of graph.edges) {
    const h = parseHandle(e.sourceHandle);
    if (h?.kind !== "exec") continue;
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source)!.push({ target: e.target, pin: h.pin });
  }
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const handlers: { event: string; nodeId: string; steps: Step[] }[] = [];
  for (const n of graph.nodes) {
    const spec = registry.get(n.type);
    if (spec?.category !== "event") continue;
    const steps: Step[] = [];
    const visit = (id: string, depth: number, seen: Set<string>) => {
      for (const { target, pin } of out.get(id) ?? []) {
        if (seen.has(target) || depth > 24) continue;
        const node = nodeById.get(target);
        const s = node && registry.get(node.type);
        if (!node || !s) continue;
        const params = paramsWithDefaults(s, node);
        const textParam = s.params.find((p) => p.kind === "text" && (p.id === "text" || p.id === "message" || p.id === "reason"));
        const connectedText = graph.edges.some((e) => e.target === node.id && e.targetHandle === `data:${textParam?.id}`);
        const detail = s.params
          .filter((p) => p.kind !== "text" && p.kind !== "scalar")
          .map((p) => `${p.label.replace(/ \(when unconnected\)/, "")}: ${JSON.stringify(params[p.id])}`)
          .slice(0, 2)
          .join(", ");
        const outPins = s.outputs.filter((p) => p.kind === "exec");
        steps.push({
          nodeId: node.id,
          depth,
          branch: outPins.length > 1 || (out.get(id)?.length ?? 0) > 1 ? pin : undefined,
          text: `${s.title}${detail ? ` (${detail})` : ""}`,
          ...(textParam && !connectedText ? { editable: { param: textParam.id, value: String(params[textParam.id] ?? "") } } : {}),
        });
        visit(target, depth + 1, new Set([...seen, target]));
      }
    };
    visit(n.id, 1, new Set([n.id]));
    handlers.push({ event: spec.title, nodeId: n.id, steps });
  }
  return handlers;
}
