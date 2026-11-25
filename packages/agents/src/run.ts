import type { NodeRegistry } from "@gamestudio/rules-core";
import { allowedOperations, type AgentDef } from "./agents";
import { applyProposal, type ApplyResult, type ProjectDocs } from "./apply";
import { proposalJsonSchema, proposalSchema, type Proposal } from "./operations";
import { chatSystemPrompt, systemPrompt, userPrompt } from "./prompt";

export interface GenerateInput {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  schema: Record<string, unknown>;
  schemaName: string;
  /** Called with each new piece of text while a streaming provider writes the answer. */
  onText?: (piece: string) => void;
}

export interface GenerateOutput {
  text: string;
  provider: string;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  notes?: string[];
}

export type GenerateFn = (input: GenerateInput) => Promise<GenerateOutput>;

export interface Attempt {
  number: number;
  raw: string;
  problems: string[];
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AgentRun {
  status: "ready" | "no-change" | "invalid" | "failed";
  agent: string;
  proposal: Proposal | null;
  result: ApplyResult | null;
  attempts: Attempt[];
  message: string;
}

/** Strip a Markdown code fence or leading prose some local models add around JSON. */
export function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text.trim();
}

function problemsOf(raw: string, docs: ProjectDocs, registry: NodeRegistry, agent: AgentDef, author: string): { proposal: Proposal | null; result: ApplyResult | null; problems: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(extractJson(raw));
  } catch {
    return { proposal: null, result: null, problems: ["The answer was not valid JSON."] };
  }
  const parsed = proposalSchema.safeParse(json);
  if (!parsed.success) {
    return { proposal: null, result: null, problems: parsed.error.issues.slice(0, 8).map((i) => `${i.path.map(String).join(".") || "proposal"}: ${i.message}`) };
  }
  const result = applyProposal(docs, parsed.data, registry, { allowed: allowedOperations(agent), author });
  const problems = [...result.errors.map((e) => `Operation ${e.op + 1}: ${e.message}`), ...result.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.doc}: ${d.message}`)];
  return { proposal: parsed.data, result, problems };
}

/**
 * One request, at most two model calls: the first answer and, if it does not validate, one
 * repair attempt that is told exactly what failed. Nothing is written by this function.
 */
export async function runAgent(args: { agent: AgentDef; request: string; docs: ProjectDocs; registry: NodeRegistry; generate: GenerateFn; author: string; maxAttempts?: 1 | 2 }): Promise<AgentRun> {
  const messages: GenerateInput["messages"] = [{ role: "user", content: userPrompt(args.agent, args.request, args.docs, args.registry) }];
  return attempt({ ...args, system: systemPrompt(args.agent), messages });
}

/** One earlier exchange in a chat: what the user wrote, or the answer JSON the assistant gave. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Earlier turns sent with each new message (the newest message carries the project context). */
export const MAX_CHAT_TURNS = 12;

/**
 * One message in a conversation with a specialist. The answer's summary is the reply shown to the
 * user; its operations (often none) are validated exactly like a one-shot proposal and applied only
 * when the user approves. `onText` streams the raw answer; `onAttempt` marks the start of each try.
 */
export async function runChat(args: { agent: AgentDef; history: ChatTurn[]; message: string; docs: ProjectDocs; registry: NodeRegistry; generate: GenerateFn; author: string; onText?: (piece: string) => void; onAttempt?: (n: number) => void; maxAttempts?: 1 | 2 }): Promise<AgentRun> {
  const messages: GenerateInput["messages"] = [...args.history.slice(-MAX_CHAT_TURNS), { role: "user", content: userPrompt(args.agent, args.message, args.docs, args.registry) }];
  return attempt({ ...args, system: chatSystemPrompt(args.agent), messages });
}

async function attempt(args: { agent: AgentDef; system: string; messages: GenerateInput["messages"]; docs: ProjectDocs; registry: NodeRegistry; generate: GenerateFn; author: string; onText?: (piece: string) => void; onAttempt?: (n: number) => void; maxAttempts?: 1 | 2 }): Promise<AgentRun> {
  const { agent, system, docs, registry, generate } = args;
  const maxAttempts = args.maxAttempts ?? 2;
  const schema = proposalJsonSchema(allowedOperations(agent));
  const messages = [...args.messages];
  const attempts: Attempt[] = [];
  for (let n = 1; n <= maxAttempts; n++) {
    args.onAttempt?.(n);
    let out: GenerateOutput;
    try {
      out = await generate({ system, messages, schema, schemaName: "game_studio_proposal", ...(args.onText ? { onText: args.onText } : {}) });
    } catch (e) {
      const message = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
      return { status: "failed", agent: agent.id, proposal: null, result: null, attempts, message };
    }
    const { proposal, result, problems } = problemsOf(out.text, docs, registry, agent, args.author.replace("{model}", out.model));
    attempts.push({ number: n, raw: out.text, problems, model: out.model, inputTokens: out.inputTokens ?? null, outputTokens: out.outputTokens ?? null });
    if (problems.length === 0 && proposal && result) {
      if (proposal.operations.length === 0) return { status: "no-change", agent: agent.id, proposal, result, attempts, message: proposal.summary };
      return { status: "ready", agent: agent.id, proposal, result, attempts, message: proposal.summary };
    }
    if (n < maxAttempts) {
      messages.push({ role: "assistant", content: out.text });
      messages.push({ role: "user", content: `That proposal cannot be applied:\n- ${problems.join("\n- ")}\nReturn a corrected proposal as JSON matching the schema.` });
    } else {
      return { status: "invalid", agent: agent.id, proposal, result, attempts, message: `The assistant's proposal still had problems after ${maxAttempts} attempts.` };
    }
  }
  return { status: "failed", agent: agent.id, proposal: null, result: null, attempts, message: "No attempts were made." };
}

/**
 * The string value of `key` in a JSON object that may still be arriving: what has been written so
 * far, or null before the key appears. Used to show a streamed reply's text while it is written.
 */
export function partialJsonString(text: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(text);
  if (!m) return null;
  const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
  let out = "";
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') return out;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) return out;
    if (next === "u") {
      const hex = text.slice(i + 2, i + 6);
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    out += escapes[next] ?? next;
    i += 1;
  }
  return out;
}
