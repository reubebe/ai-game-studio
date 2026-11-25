import { useEffect, useMemo, useRef, useState } from "react";
import { AGENTS, agentById, diffJson, partialJsonString, routeRequest, runChat, type AgentRun, type ChatTurn, type GenerateFn, type ProjectDocs } from "@gamestudio/agents";
import { backend, errorMessage, type ProviderStatus } from "../../lib/backend";
import { streamGenerate } from "../../lib/backend/stream";
import { registry } from "../../lib/registry";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { useEnv } from "../../state/env";
import { Button, Field, Notice } from "../../components/ui";
import { BotIcon, BrainIcon, CheckIcon, CloseIcon, CloudIcon, LocalIcon, MapIcon, GraphIcon, SwordsIcon, LessonIcon, ShieldIcon, SendIcon, WandIcon, RefreshIcon, StopIcon, PlusIcon, TrophyIcon, SproutIcon } from "../../components/icons";

/** One exchange: what the user wrote and the specialist's reply, with any changes it proposes. */
interface Turn {
  id: number;
  message: string;
  agent: string;
  reason: string;
  status: "thinking" | "ready" | "no-change" | "invalid" | "failed" | "applied" | "rejected" | "stopped";
  /** Raw answer text received so far in the current attempt (JSON while it arrives). */
  streamed: string;
  attempt: number;
  run: AgentRun | null;
  before: ProjectDocs | null;
  provider: string;
  model: string;
}

/** Conversations last while the app runs, one per project, so leaving the assistant keeps the chat. */
const conversations = new Map<string, Turn[]>();

const AGENT_ICON: Record<string, React.ReactNode> = { "world-builder": <MapIcon />, "level-designer": <MapIcon />, "match-designer": <TrophyIcon />, "farm-designer": <SproutIcon />, "rules-engineer": <GraphIcon />, "creature-designer": <SwordsIcon />, "lesson-designer": <LessonIcon />, "rules-reviewer": <ShieldIcon /> };

function docOf(docs: ProjectDocs, path: string): unknown {
  for (const g of Object.values(docs.rules)) if (g.path === path) return g.graph;
  if (docs.world?.path === path) return docs.world.world;
  if (docs.level?.path === path) return docs.level.level;
  if (docs.match?.path === path) return docs.match.match;
  if (docs.farm?.path === path) return docs.farm.farm;
  if (docs.catalog?.path === path) return docs.catalog.catalog;
  for (const l of Object.values(docs.lessons)) if (l.path === path) return l.lesson;
  if (path === "gamestudio.json") return docs.manifest;
  return undefined;
}

/** The changes a reply proposes, with Apply and Reject. Nothing is written until Apply. */
function ChangeCard({ turn, onApply, onReject }: { turn: Turn; onApply: () => void; onReject: () => void }) {
  const mode = useApp((s) => s.mode);
  const busy = useProject((s) => s.busy);
  const run = turn.run;
  const grouped = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const c of run?.result?.changes ?? []) m.set(c.doc, [...(m.get(c.doc) ?? []), c.text]);
    return [...m.entries()];
  }, [run]);
  const warnings = run?.result?.diagnostics.filter((d) => d.severity === "warning") ?? [];
  return (
    <div className="proposal" data-testid="proposal">
      <div className="proposal__body">
        {grouped.map(([doc, lines]) => (
          <div key={doc}>
            <div className="mono xsmall muted" style={{ marginBottom: 4 }}>{doc}</div>
            {lines.map((l, i) => <div key={i} className="change-line">{l}</div>)}
          </div>
        ))}
        {warnings.length > 0 && <Notice kind="warn">After this change: {warnings.map((w) => w.message).join(" · ")}</Notice>}
        {run && run.attempts.length > 1 && <div className="xsmall muted">Needed {run.attempts.length} attempts. First attempt problems: {run.attempts[0]!.problems.join(" · ")}</div>}
        {mode === "developer" && run?.result && turn.before && (
          <details>
            <summary className="small muted">Structural diff and raw output</summary>
            {run.result.touched.map((p) => (
              <div key={p} className="diff" style={{ marginTop: 6 }}>
                <div className="muted">{p}</div>
                {diffJson(docOf(turn.before!, p), docOf(run.result!.docs, p)).map((d, i) => (
                  <div key={i} className={d.kind === "added" ? "diff__add" : d.kind === "removed" ? "diff__del" : "diff__chg"}>
                    {d.kind === "added" ? "+" : d.kind === "removed" ? "−" : "~"} {d.path} {d.kind === "changed" ? `${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}` : JSON.stringify(d.kind === "added" ? d.after : d.before).slice(0, 200)}
                  </div>
                ))}
              </div>
            ))}
            <pre className="diff" style={{ marginTop: 6 }}>{run.attempts.at(-1)?.raw}</pre>
          </details>
        )}
      </div>
      {turn.status === "ready" && (
        <div className="proposal__foot">
          <span className="xsmall muted" style={{ flex: 1 }}>Nothing has changed yet. Applying saves your work, takes a snapshot, writes these changes and snapshots again.</span>
          <Button size="small" icon={<CloseIcon />} onClick={onReject}>Reject</Button>
          <Button size="small" variant="primary" icon={<CheckIcon />} busy={busy === "applying"} onClick={onApply}>Apply changes</Button>
        </div>
      )}
      {turn.status === "applied" && <div className="proposal__foot"><span className="row small" style={{ color: "var(--green)" }}><CheckIcon width={14} /> Applied and snapshotted. Use Snapshots to undo.</span></div>}
      {turn.status === "rejected" && <div className="proposal__foot"><span className="small muted">Rejected. Nothing was changed.</span></div>}
    </div>
  );
}

function Reply({ turn, onApply, onReject }: { turn: Turn; onApply: () => void; onReject: () => void }) {
  const agent = agentById(turn.agent);
  const live = turn.status === "thinking";
  const text = live ? (partialJsonString(turn.streamed, "summary") ?? "") : turn.run?.proposal?.summary ?? "";
  const hasChanges = Boolean(turn.run?.result?.changes.length) && ["ready", "applied", "rejected"].includes(turn.status);
  // The reply text is complete but the answer is still arriving: the proposed changes come next.
  const preparing = live && /"summary"\s*:\s*"(?:[^"\\]|\\.)*"/.test(turn.streamed);
  return (
    <div className="chat-msg chat-msg--assistant" data-testid="reply">
      <div className="chat-msg__meta">
        {AGENT_ICON[turn.agent]}
        <strong>{agent.name}</strong>
        <span className="truncate">{turn.reason}</span>
        <span className="spacer" />
        <span className="mono">{turn.provider} · {turn.model}</span>
      </div>
      {(text || live) && (
        <div className="chat-msg__text">
          {text}
          {live && !text && <span className="muted">{turn.attempt > 1 ? "Fixing the first answer…" : "Thinking…"}</span>}
          {live && <span className="chat-caret" aria-hidden />}
        </div>
      )}
      {preparing && <div className="row xsmall muted"><span className="spinner" /> Preparing the proposed changes…</div>}
      {hasChanges && <ChangeCard turn={turn} onApply={onApply} onReject={onReject} />}
      {turn.status === "invalid" && turn.run && <Notice kind="error">The proposed change could not be applied: {turn.run.attempts.at(-1)?.problems.join(" · ")}</Notice>}
      {turn.status === "failed" && <Notice kind="error">{turn.run?.message}</Notice>}
      {turn.status === "stopped" && <div className="xsmall muted">Stopped. Nothing was changed.</div>}
    </div>
  );
}

export function AssistantView() {
  const root = useProject((s) => s.root)!;
  const manifest = useProject((s) => s.manifest)!;
  const collectDocs = useProject((s) => s.collectDocs);
  const applyAgentChanges = useProject((s) => s.applyAgentChanges);
  const settings = useApp((s) => s.settings);
  const setRoute = useApp((s) => s.setRoute);
  const providers = useEnv((s) => s.providers);
  const refreshProviders = useEnv((s) => s.refreshProviders);
  const usable = (providers ?? []).filter((p) => p.allowed && p.available);
  const [providerId, setProviderId] = useState<string>("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<"low" | "medium" | "high">("medium");
  const [agentChoice, setAgentChoice] = useState<string>("auto");
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>(() => conversations.get(root) ?? []);
  const [docs, setDocs] = useState<ProjectDocs | null>(null);
  const seq = useRef(Math.max(0, ...turns.map((t) => t.id)));
  const stopRef = useRef<(() => void) | null>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    conversations.set(root, turns);
  }, [root, turns]);
  useEffect(() => {
    void collectDocs().then(setDocs);
  }, [collectDocs]);
  useEffect(() => {
    if (providerId || usable.length === 0) return;
    const preferred = usable.find((p) => p.id === settings["ai.defaultProvider"]) ?? usable.find((p) => p.kind === "local" || p.kind === "test") ?? usable[0]!;
    setProviderId(preferred.id);
  }, [usable, providerId, settings]);
  const provider: ProviderStatus | undefined = usable.find((p) => p.id === providerId);
  useEffect(() => {
    if (!provider) return;
    const saved = settings["ai.defaultModel"];
    const options = [...provider.suggestedModels, ...provider.models];
    setModel(typeof saved === "string" && options.includes(saved) ? saved : provider.models.find((m) => m.startsWith("qwen3")) ?? options[0] ?? "");
  }, [provider, settings]);
  // Follow the conversation as replies arrive. Braces matter: scroll methods return a Promise in
  // current WebKit/Chromium, and an effect must not return one.
  useEffect(() => {
    timeline.current?.scrollTo({ top: timeline.current.scrollHeight });
  }, [turns]);

  const available = docs ? AGENTS.filter((a) => a.available(docs)) : [];
  const thinking = turns.some((t) => t.status === "thinking");
  const update = (id: number, patch: (t: Turn) => Partial<Turn>) => setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch(t) } : t)));

  const send = async () => {
    const message = text.trim();
    if (!message || !provider || !model || thinking) return;
    const current = await collectDocs();
    if (!current) return;
    const routed = agentChoice === "auto" ? routeRequest(message, current) : { agent: agentById(agentChoice), reason: "Chosen by you." };
    // Earlier exchanges go back to the model as they happened: what you wrote and the answer it gave.
    const history: ChatTurn[] = turns.flatMap((t) => {
      const raw = t.run?.attempts.at(-1)?.raw;
      return raw && t.status !== "failed" && t.status !== "stopped" ? [{ role: "user" as const, content: t.message }, { role: "assistant" as const, content: raw }] : [];
    });
    const id = ++seq.current;
    setTurns((ts) => [...ts, { id, message, agent: routed.agent.id, reason: routed.reason, status: "thinking", streamed: "", attempt: 1, run: null, before: current, provider: provider.id, model }]);
    setText("");
    const generate: GenerateFn = async (req) => {
      const stream = streamGenerate({ provider: provider.id, model, system: req.system, messages: req.messages, schema: req.schema, schemaName: req.schemaName, maxTokens: 8000, ...(provider.id === "anthropic" ? { effort } : {}) }, root, (piece) => req.onText?.(piece), req.onText ? () => update(id, () => ({ streamed: "" })) : undefined);
      stopRef.current = stream.stop;
      try {
        const r = await stream.result;
        return { text: r.text, provider: r.provider, model: r.servedBy ?? r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, notes: r.notes };
      } finally {
        stopRef.current = null;
      }
    };
    const run = await runChat({
      agent: routed.agent,
      history,
      message,
      docs: current,
      registry,
      generate,
      author: "AI assistant ({model})",
      onText: (piece) => update(id, (t) => ({ streamed: t.streamed + piece })),
      onAttempt: (n) => update(id, () => ({ attempt: n, streamed: "" })),
    });
    update(id, () => ({ status: run.status === "failed" && run.message === "Stopped." ? "stopped" : run.status, run }));
    void backend.auditAppend(root, "assistant", "chat.reply", { agent: routed.agent.id, provider: provider.id, model, status: run.status, attempts: run.attempts.length, changes: run.result?.changes.map((c) => c.text) ?? [] });
    input.current?.focus();
  };
  const sendSafely = () => void send().catch((err) => useApp.getState().toast("error", "Assistant failed", errorMessage(err)));
  const apply = async (turn: Turn) => {
    if (!turn.run?.result) return;
    const ok = await applyAgentChanges(turn.run.result.docs, turn.run.result.touched, turn.run.message.slice(0, 120));
    if (ok) {
      update(turn.id, () => ({ status: "applied" }));
      setDocs(await collectDocs());
    }
  };
  const reject = (turn: Turn) => {
    update(turn.id, () => ({ status: "rejected" }));
    void backend.auditAppend(root, "user", "proposal.rejected", { agent: turn.agent, summary: turn.run?.message ?? "" });
  };

  const sendBlocked = !provider
    ? "Connect a model first: start Ollama, or allow a cloud provider in Settings"
    : !model
      ? "Choose a model first"
      : !text.trim()
        ? "Type a message first"
        : null;
  const suggestions = manifest.rules.some((r) => r.domain === "oware")
    ? ["Make pits with 4 seeds capturable too", "How does a capture work in this variant?"]
    : manifest.rules.some((r) => r.domain === "ludo")
      ? ["Let a 1 bring a token out too", "Give an extra roll for a capture"]
    : manifest.data.some((d) => d.kind === "farm-sim")
      ? ["Add a pumpkin crop that takes 5 days and sells for 20", "Make the farm bigger with a second field of soil by the pond", "Make it rain every Sunday"]
    : manifest.data.some((d) => d.kind === "football-match")
      ? ["Rename my team's players and make the striker faster", "Make it a three-a-side night match on a smaller pitch", "Give a bonus goal for a goal scored in the last minute"]
    : manifest.data.some((d) => d.kind === "platformer-level")
      ? ["Add a harder stretch with two beetles and a spike pit before the gate", "Make it a night level with a deep purple sky", "How do checkpoints work in these rules?"]
    : manifest.data.some((d) => d.kind === "explore-world")
      ? ["Add two rocks next to the lake", "Make the player a little faster", "Turn on high-quality graphics", "What could make this level more fun?"]
      : manifest.data.some((d) => d.kind === "creature-catalog")
        ? ["Add an original river creature that is slow but sturdy"]
        : manifest.data.some((d) => d.kind === "lesson")
          ? ["Add a numeric question about stride length"]
          : ["Add a node that logs the total"];

  return (
    <div className="assistant">
      <aside className="assistant__side">
        <div className="stack" style={{ gap: 8 }}>
          <div className="row"><span className="section-label" style={{ flex: 1 }}>Model</span><Button size="small" variant="ghost" icon={<RefreshIcon />} onClick={() => void refreshProviders()}>Refresh</Button></div>
          {usable.length === 0 ? (
            <Notice kind="warn">No model provider is ready. Start Ollama for local models, or allow a cloud provider in <a href="#" onClick={(e) => { e.preventDefault(); setRoute("settings"); }}>Settings</a>.</Notice>
          ) : (
            <>
              <select className="select" aria-label="Provider" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                {usable.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <select className="select" aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
                {provider && provider.suggestedModels.length > 0 && provider.models.length > 0 ? (
                  <>
                    <optgroup label="Suggested">{provider.suggestedModels.map((m) => <option key={m} value={m}>{m}</option>)}</optgroup>
                    <optgroup label="All models for this key">{provider.models.filter((m) => !provider.suggestedModels.includes(m)).map((m) => <option key={m} value={m}>{m}</option>)}</optgroup>
                  </>
                ) : (
                  [...new Set([...(provider?.suggestedModels ?? []), ...(provider?.models ?? [])])].map((m) => <option key={m} value={m}>{m}</option>)
                )}
              </select>
              {provider && <div className="row xsmall muted">{provider.kind === "cloud" ? <CloudIcon width={12} /> : <LocalIcon width={12} />}{provider.kind === "cloud" ? "Sends project context to the provider; billed to your account." : provider.kind === "test" ? "Scripted answers for interface tests." : "Runs on this computer."}</div>}
              {provider?.id === "anthropic" && (
                <Field label="Effort" htmlFor="ai-effort"><select id="ai-effort" className="select" value={effort} onChange={(e) => setEffort(e.target.value as typeof effort)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></Field>
              )}
            </>
          )}
          {(providers ?? []).filter((p) => !(p.allowed && p.available)).length > 0 && (
            <details>
              <summary className="xsmall muted">Unavailable providers</summary>
              {(providers ?? []).filter((p) => !(p.allowed && p.available)).map((p) => <div key={p.id} className="xsmall muted" style={{ marginTop: 4 }}><strong>{p.label}:</strong> {p.note}</div>)}
            </details>
          )}
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <div className="section-label">Specialist</div>
          <button type="button" className="agent-option" aria-pressed={agentChoice === "auto"} onClick={() => setAgentChoice("auto")}>
            <WandIcon />
            <span><span className="small" style={{ color: "var(--text-1)" }}>Automatic</span><br /><span className="xsmall muted">The Producer picks one specialist for each message.</span></span>
          </button>
          {available.map((a) => (
            <button key={a.id} type="button" className="agent-option" aria-pressed={agentChoice === a.id} onClick={() => setAgentChoice(a.id)} data-tip={a.boundary}>
              {AGENT_ICON[a.id]}
              <span><span className="small" style={{ color: "var(--text-1)" }}>{a.name}</span><br /><span className="xsmall muted">{a.role}</span></span>
            </button>
          ))}
        </div>
      </aside>
      <div className="assistant__main">
        {turns.length > 0 && (
          <div className="assistant__bar">
            <span className="xsmall muted" style={{ flex: 1 }}>Conversation about {manifest.title}</span>
            <Button size="small" variant="ghost" icon={<PlusIcon />} disabled={thinking} tip={thinking ? "Wait for the reply, or stop it first" : "Start a new conversation (the project is not changed)"} onClick={() => setTurns([])}>New chat</Button>
          </div>
        )}
        <div className="assistant__timeline" ref={timeline} role="log" aria-label="Conversation">
          {turns.length === 0 && (
            <div className="stack" style={{ maxWidth: 640, gap: 12, margin: "20px auto", textAlign: "center", alignItems: "center" }}>
              <BrainIcon width={30} height={30} style={{ color: "var(--text-4)" }} />
              <h3>Talk to the assistant about {manifest.title}</h3>
              <p className="muted" style={{ lineHeight: 1.55 }}>Ask questions, brainstorm, or describe a change. Replies appear as they are written. When a reply proposes a change, it is validated and listed first; nothing is written until you apply it, and every applied change is snapshotted so you can roll it back.</p>
              <div className="row row--wrap" style={{ justifyContent: "center" }}>
                {suggestions.map((s) => (
                  <Button key={s} size="small" onClick={() => { setText(s); input.current?.focus(); }}>{s}</Button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t) => (
            <div key={t.id} className="stack" style={{ gap: 10 }}>
              <div className="chat-msg chat-msg--user">{t.message}</div>
              <Reply turn={t} onApply={() => void apply(t)} onReject={() => reject(t)} />
            </div>
          ))}
        </div>
        <div className="assistant__composer">
          <textarea
            ref={input}
            className="textarea"
            rows={3}
            placeholder={usable.length ? "Message the assistant…  (Enter to send, Shift+Enter for a new line)" : "Connect a model provider to use the assistant"}
            aria-label="Message for the assistant"
            value={text}
            disabled={usable.length === 0}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!thinking) sendSafely();
              }
            }}
          />
          <div className="row">
            <span className="xsmall muted" style={{ flex: 1 }}><BotIcon width={12} style={{ verticalAlign: -2 }} /> Changes can only use the operations each specialist is allowed. Every message and decision is recorded under Activity.</span>
            {thinking ? (
              <Button icon={<StopIcon />} tip="Stop this reply; nothing will be changed" onClick={() => stopRef.current?.()}>Stop</Button>
            ) : (
              <Button variant="primary" icon={<SendIcon />} disabled={Boolean(sendBlocked)} tip={sendBlocked ?? "Send (Enter)"} onClick={sendSafely}>Send</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
