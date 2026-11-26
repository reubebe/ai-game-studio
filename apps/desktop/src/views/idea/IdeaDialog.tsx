import { useEffect, useMemo, useRef, useState } from "react";
import { IDEA_TEMPLATES, allowedOperations, applyProposal, partialJsonString, planGame, type GenerateFn, type IdeaPlan } from "@gamestudio/agents";
import { TEMPLATES, folderNameFor } from "@gamestudio/project";
import { backend, errorMessage, type PageText, type ProviderStatus } from "../../lib/backend";
import { streamGenerate } from "../../lib/backend/stream";
import { registry } from "../../lib/registry";
import { useApp } from "../../state/app";
import { useEnv } from "../../state/env";
import { useProject } from "../../state/project";
import { Button, Dialog, Field, Notice } from "../../components/ui";
import { CheckIcon, FolderIcon, LinkIcon, RefreshIcon, StopIcon, WandIcon } from "../../components/icons";

type Stage = "idle" | "page" | "brief" | "design" | "done" | "creating";

const EXAMPLES = [
  "A cosy night-time platformer where a firefly collects lantern seeds and avoids thorny vines",
  "Explore a misty island, find three lost compass pieces and talk to the lighthouse keeper",
  "Ludo where a 1 also brings a token out and captures give an extra roll",
];

/**
 * Start a new game from a description, a link to a game, or both. The assistant plans first (a
 * brief, then the specialist's changes to the template's starting content); the user sees the plan
 * and every change, and nothing is created until they press Create.
 */
export function IdeaDialog() {
  const info = useApp((s) => s.info);
  const settings = useApp((s) => s.settings);
  const close = useApp((s) => s.closeDialog);
  const setRoute = useApp((s) => s.setRoute);
  const toast = useApp((s) => s.toast);
  const create = useProject((s) => s.create);
  const providers = useEnv((s) => s.providers);
  const refreshProviders = useEnv((s) => s.refreshProviders);
  const usable = useMemo(() => (providers ?? []).filter((p) => p.allowed && p.available), [providers]);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [idea, setIdea] = useState("");
  const [link, setLink] = useState("");
  const [parent, setParent] = useState(info?.defaultProjectsDir ?? "");
  const [stage, setStage] = useState<Stage>("idle");
  const [streamed, setStreamed] = useState("");
  const [page, setPage] = useState<PageText | null>(null);
  const [plan, setPlan] = useState<IdeaPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    if (providers === null) void refreshProviders();
  }, [providers, refreshProviders]);
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

  const linkError = link.trim() && !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(link.trim()) ? "Paste a full web address starting with https://" : null;
  const working = stage === "page" || stage === "brief" || stage === "design";
  const blocked = !provider ? "Connect a model first: start Ollama, or allow a cloud provider in Settings" : !model ? "Choose a model first" : !idea.trim() && !link.trim() ? "Describe your game or paste a link" : linkError;

  const run = async () => {
    if (blocked || !provider) return;
    cancelled.current = false;
    setError(null);
    setPlan(null);
    setStreamed("");
    let pageText: PageText | null = null;
    if (link.trim()) {
      setStage("page");
      try {
        pageText = await backend.pageFetch(link.trim());
        setPage(pageText);
      } catch (e) {
        setStage("idle");
        setError(`The link could not be read: ${errorMessage(e)}`);
        return;
      }
    } else setPage(null);
    if (cancelled.current) return setStage("idle");
    const generate: GenerateFn = async (req) => {
      // Only the brief streams into view (it is the call given onText), so only its text is cleared when Gemini is asked again.
      const stream = streamGenerate({ provider: provider.id, model, system: req.system, messages: req.messages, schema: req.schema, schemaName: req.schemaName, maxTokens: 12000 }, null, (piece) => req.onText?.(piece), req.onText ? () => setStreamed("") : undefined);
      stopRef.current = stream.stop;
      try {
        const r = await stream.result;
        return { text: r.text, provider: r.provider, model: r.servedBy ?? r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, notes: r.notes };
      } finally {
        stopRef.current = null;
      }
    };
    const result = await planGame({ input: { idea, page: pageText }, generate, registry, onStage: (s) => setStage(s), onText: (p) => setStreamed((t) => t + p), onRetry: () => setStreamed("") });
    if (cancelled.current) return setStage("idle");
    setPlan(result);
    setStage(result.status === "failed" && !result.brief ? "idle" : "done");
    if (result.status === "failed" && !result.brief) setError(result.message);
  };

  const build = async () => {
    if (!plan?.brief || !plan.agent || !plan.run?.proposal) return;
    const brief = plan.brief;
    setStage("creating");
    if (!(await create(brief.template, brief.title, parent))) return setStage("done");
    // The project is open: apply the same changes to its real documents, with the description.
    const project = useProject.getState();
    const docs = await project.collectDocs();
    if (!docs) return close();
    const operations = [...plan.run.proposal.operations, { op: "project.describe" as const, description: brief.description }];
    const result = applyProposal(docs, { summary: plan.run.proposal.summary, operations }, registry, { allowed: [...allowedOperations(plan.agent), "project.describe"], author: `AI assistant (${plan.model})` });
    if (!result.ok) {
      toast("info", "Created from the template only", `The planned changes no longer apply: ${[...result.errors.map((e) => e.message), ...result.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)].slice(0, 3).join("; ")}`);
      return close();
    }
    if (await project.applyAgentChanges(result.docs, result.touched, `New game from an idea: ${brief.title}`)) {
      void backend.auditAppend(useProject.getState().root!, "assistant", "idea.created", { template: brief.template, provider: provider?.id ?? "", model: plan.model, inspiredBy: brief.inspiredBy, link: page?.url ?? null, changes: result.changes.length });
      toast("success", `${brief.title} is ready`, "Snapshots hold the template's starting point and the planned changes.");
    }
    close();
  };

  const stop = () => {
    cancelled.current = true;
    stopRef.current?.();
  };

  const template = plan?.brief ? TEMPLATES.find((t) => t.id === plan.brief!.template) : undefined;
  const grouped = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const c of plan?.run?.result?.changes ?? []) m.set(c.doc, [...(m.get(c.doc) ?? []), c.text]);
    return [...m.entries()];
  }, [plan]);
  const warnings = plan?.run?.result?.diagnostics.filter((d) => d.severity === "warning") ?? [];
  const usablePlan = plan?.brief && (plan.status === "ready" || plan.status === "no-change");
  const liveReply = partialJsonString(streamed, "reply");

  return (
    <Dialog
      wide
      title="Start from an idea"
      onClose={() => {
        stop();
        close();
      }}
      footer={
        <>
          <span className="xsmall muted" style={{ marginRight: "auto" }}>{usablePlan ? `Creates ${parent}/${folderNameFor(plan!.brief!.title)}` : "Nothing is created until you approve the plan."}</span>
          {working ? (
            <Button icon={<StopIcon />} onClick={stop}>Stop</Button>
          ) : (
            <>
              <Button onClick={close}>Cancel</Button>
              {plan && <Button icon={<RefreshIcon />} disabled={Boolean(blocked) || stage === "creating"} onClick={() => void run()}>Plan again</Button>}
              {usablePlan ? (
                <Button variant="primary" icon={<CheckIcon />} busy={stage === "creating"} disabled={!parent} onClick={() => void build()}>Create this game</Button>
              ) : (
                <Button variant="primary" icon={<WandIcon />} disabled={Boolean(blocked)} tip={blocked ?? undefined} onClick={() => void run()}>Plan my game</Button>
              )}
            </>
          )}
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <Field label="Describe your game" htmlFor="idea-text" help="What you do, where it happens, how it should feel. Mention a game you like if it helps: the plan keeps the idea, not its name, characters or art.">
          <textarea id="idea-text" className="textarea" rows={4} maxLength={4000} value={idea} disabled={working} placeholder={EXAMPLES[0]} onChange={(e) => setIdea(e.target.value)} />
        </Field>
        {!idea && stage === "idle" && (
          <div className="row row--wrap" style={{ gap: 6 }}>
            {EXAMPLES.map((x) => <Button key={x} size="small" onClick={() => setIdea(x)}>{x}</Button>)}
          </div>
        )}
        <Field label={<><LinkIcon width={12} /> Link to a game or a page about it (optional)</>} htmlFor="idea-link" error={linkError} help={backend.kind === "browser" ? "Reading links needs the desktop app." : "The studio reads the page's title and visible text (public sites only) and gives them to the model as information."}>
          <input id="idea-link" className="input" value={link} disabled={working || backend.kind === "browser"} placeholder="https://…" onChange={(e) => setLink(e.target.value)} />
        </Field>
        <div className="row row--wrap" style={{ gap: 8 }}>
          <Field label="Model" htmlFor="idea-provider">
            <div className="row" style={{ gap: 6 }}>
              <select id="idea-provider" className="select" style={{ width: 200 }} value={providerId} disabled={working || usable.length === 0} onChange={(e) => setProviderId(e.target.value)}>
                {usable.length === 0 && <option value="">No model connected</option>}
                {usable.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <select className="select" aria-label="Model name" style={{ width: 200 }} value={model} disabled={working || !provider} onChange={(e) => setModel(e.target.value)}>
                {[...new Set([...(provider?.suggestedModels ?? []), ...(provider?.models ?? [])])].map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </Field>
          <Field label="Location" htmlFor="idea-parent">
            <div className="row" style={{ gap: 6 }}>
              <input id="idea-parent" className="input input--mono" style={{ width: 260 }} value={parent} readOnly />
              <Button icon={<FolderIcon />} disabled={backend.kind === "browser" || working} tip={backend.kind === "browser" ? "The browser preview stores projects in this browser" : undefined} onClick={async () => { const p = await backend.pickDirectory("Choose where to create the project"); if (p) setParent(p); }}>Change</Button>
            </div>
          </Field>
        </div>
        {usable.length === 0 && providers !== null && (
          <Notice kind="warn">No model is connected. Start Ollama, or allow Gemini or OpenAI in Settings. <a href="#" onClick={(e) => { e.preventDefault(); close(); setRoute("settings"); }}>Open Settings</a></Notice>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        {working && (
          <div className="stack" style={{ gap: 6 }} aria-live="polite">
            <div className="row small"><span className="spinner" /> {stage === "page" ? "Reading the link…" : stage === "brief" ? "Choosing a template and writing the brief…" : `${plan?.agent?.name ?? "The specialist"} is shaping the first version…`}</div>
            {liveReply && <div className="chat-msg__text small">{liveReply}</div>}
          </div>
        )}
        {page && !working && <div className="xsmall muted">Read {page.title || page.url}: {page.text.length.toLocaleString()} characters of text.</div>}
        {plan?.brief && !working && (
          <div className="proposal" data-testid="idea-plan">
            <div className="proposal__body">
              <div className="chat-msg__text">{plan.brief.reply}</div>
              <div className="row row--wrap" style={{ gap: 8 }}>
                <strong>{plan.brief.title}</strong>
                <span className="badge">{template?.title ?? plan.brief.template}</span>
                <span className={`badge ${plan.brief.fit === "good" ? "badge--green" : "badge--amber"}`}>{plan.brief.fit === "good" ? "Good fit" : "Partial fit"}</span>
              </div>
              <div className="small muted">{plan.brief.description}</div>
              {plan.brief.notPossible && <Notice kind="warn">Not possible with this template yet: {plan.brief.notPossible}</Notice>}
              {plan.brief.inspiredBy && <div className="xsmall muted">Inspired by {plan.brief.inspiredBy}: the plan takes its genre and mechanics, with an original name, layout and look.</div>}
              <details>
                <summary className="small muted">Design brief</summary>
                <p className="small" style={{ whiteSpace: "pre-wrap" }}>{plan.brief.brief}</p>
              </details>
              {plan.run?.proposal && <div className="small"><strong>{plan.agent?.name}:</strong> {plan.run.proposal.summary}</div>}
              {grouped.map(([doc, lines]) => (
                <div key={doc}>
                  <div className="mono xsmall muted" style={{ marginBottom: 4 }}>{doc}</div>
                  {lines.map((l, i) => <div key={i} className="change-line">{l}</div>)}
                </div>
              ))}
              {warnings.length > 0 && <Notice kind="warn">Check after creating: {warnings.map((w) => w.message).join(" · ")}</Notice>}
              {plan.status === "invalid" && <Notice kind="error">The specialist's changes did not validate ({plan.run?.attempts.at(-1)?.problems.slice(0, 3).join(" · ")}). Plan again, or create the game from the plain template with New project.</Notice>}
              {plan.status === "failed" && <Notice kind="error">{plan.message}</Notice>}
              <div className="xsmall muted">{provider?.label} · {plan.model}</div>
            </div>
          </div>
        )}
        <p className="xsmall muted" style={{ margin: 0 }}>
          Ideas start from one of these templates: {IDEA_TEMPLATES.map((t) => TEMPLATES.find((x) => x.id === t.id)?.title ?? t.id).join(", ")}. The assistant changes their levels, colours, texts and rule settings; it does not write new engine code or make art.
        </p>
      </div>
    </Dialog>
  );
}
