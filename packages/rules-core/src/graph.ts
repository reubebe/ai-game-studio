import { z } from "zod";

/** Editor/storage format of a rule graph (positions included). Compiles to RuleProgram IR. */
export const RULE_GRAPH_SCHEMA_VERSION = "1.0.0";

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "Use letters, digits and underscores; start with a letter");
const scalar = z.union([z.number().finite(), z.boolean(), z.string().max(2000)]);

export const ruleGraphSchema = z
  .object({
    schemaVersion: z.literal(RULE_GRAPH_SCHEMA_VERSION),
    kind: z.literal("rule-graph"),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Graph id must be lowercase letters, digits or dashes"),
    name: z.string().trim().min(1).max(120),
    domain: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    description: z.string().max(4000).optional(),
    provenance: z
      .object({
        variant: z.string().max(200).optional(),
        sources: z
          .array(
            z.object({
              title: z.string().max(300),
              url: z.string().url().max(500).optional(),
              accessed: z.string().max(40).optional(),
              note: z.string().max(1000).optional(),
            }),
          )
          .max(20),
        notes: z.string().max(4000).optional(),
      })
      .optional(),
    variables: z
      .array(
        z.object({
          name: identifier,
          type: z.enum(["number", "boolean", "text"]),
          initial: scalar,
          description: z.string().max(500).optional(),
        }),
      )
      .max(200),
    nodes: z
      .array(
        z.object({
          id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
          type: z.string().min(1).max(120),
          position: z.object({ x: z.number().finite(), y: z.number().finite() }),
          params: z.record(z.string(), z.unknown()).default({}),
          label: z.string().max(120).optional(),
          comment: z.string().max(1000).optional(),
        }),
      )
      .max(2000),
    edges: z
      .array(
        z.object({
          id: z.string().regex(/^[A-Za-z0-9_:.-]{1,160}$/),
          source: z.string(),
          sourceHandle: z.string(),
          target: z.string(),
          targetHandle: z.string(),
        }),
      )
      .max(6000),
  })
  .strict();

export type RuleGraph = z.infer<typeof ruleGraphSchema>;
export type GraphNode = RuleGraph["nodes"][number];
export type GraphEdge = RuleGraph["edges"][number];
export type GraphVariable = RuleGraph["variables"][number];

/** Handle ids encode the pin kind so React Flow and the validator agree: "exec:out", "data:pit". */
export function handleId(kind: "exec" | "data", pin: string): string {
  return `${kind}:${pin}`;
}

export function parseHandle(handle: string): { kind: "exec" | "data"; pin: string } | null {
  const match = /^(exec|data):([A-Za-z0-9_]{1,64})$/.exec(handle);
  if (!match) return null;
  return { kind: match[1] as "exec" | "data", pin: match[2] as string };
}

export function emptyGraph(id: string, name: string, domain: string): RuleGraph {
  return { schemaVersion: RULE_GRAPH_SCHEMA_VERSION, kind: "rule-graph", id, name, domain, variables: [], nodes: [], edges: [] };
}

/** Canonical JSON with sorted keys, used for hashing and stable diffs. */
export function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, normalize((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(normalize(value));
}

/** FNV-1a 32-bit hash; enough to detect stale compiled output, not a security primitive. */
export function stableHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Hash of the semantic graph content: node positions and comments do not affect behavior. */
export function semanticHash(graph: RuleGraph): string {
  const semantic = {
    id: graph.id,
    domain: graph.domain,
    variables: graph.variables,
    nodes: [...graph.nodes].map((n) => ({ id: n.id, type: n.type, params: n.params })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges]
      .map((e) => ({ s: e.source, sh: e.sourceHandle, t: e.target, th: e.targetHandle }))
      .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
  };
  return stableHash(canonicalJson(semantic));
}
