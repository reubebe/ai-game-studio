import { useEffect, useMemo, useRef, useState } from "react";
import { RuleRuntime, type RuleProgram, type Scalar } from "@gamestudio/rules-core";
import { HURT_CAUSES, parseLevel, PlatformerSimHost, type Level, type PlatformerEffect } from "@gamestudio/platformer";
import { useProject } from "../../state/project";
import { Button, Notice } from "../../components/ui";
import { PlayIcon, ResetIcon } from "../../components/icons";

function effectText(e: PlatformerEffect): string {
  switch (e.type) {
    case "message": return `Message (${e.seconds}s): ${e.text}`;
    case "objective": return `Objective: ${e.text}`;
    case "door": return `Door opened: ${e.doorId}`;
    case "sound": return `Sound: ${e.sound}`;
    case "visibility": return `${e.visible ? "Show" : "Hide"} ${e.objectId}`;
    case "win": return `Level complete: ${e.text}`;
  }
}

/** Fires the platformer's events at a model of the level (PlatformerSimHost), without starting Godot. */
export function PlatformerSimulator({ program, onTrace }: { program: RuleProgram; onTrace: (ids: string[]) => void }) {
  const manifest = useProject((s) => s.manifest);
  const loadDoc = useProject((s) => s.loadDoc);
  const levelPath = manifest?.data.find((d) => d.kind === "platformer-level")?.path;
  const levelDoc = useProject((s) => (levelPath ? s.docs[levelPath] : undefined));
  useEffect(() => {
    if (levelPath) void loadDoc(levelPath);
  }, [levelPath, loadDoc]);
  const level = useMemo<Level | null>(() => {
    const r = levelDoc && !levelDoc.error ? parseLevel(levelDoc.data) : null;
    return r?.ok ? r.level : null;
  }, [levelDoc]);
  const sim = useRef<{ runtime: RuleRuntime; host: PlatformerSimHost } | null>(null);
  const [lines, setLines] = useState<{ id: number; text: string; kind: string }[]>([]);
  const n = useRef(0);
  const [, force] = useState(0);
  const push = (text: string, kind: string) => setLines((l) => [{ id: ++n.current, text, kind }, ...l].slice(0, 200));
  const reset = () => {
    sim.current = level ? { runtime: new RuleRuntime(program), host: new PlatformerSimHost(level) } : null;
    setLines([]);
    force((x) => x + 1);
  };
  useEffect(reset, [program, level]); // eslint-disable-line react-hooks/exhaustive-deps
  const [coin, setCoin] = useState("");
  const [checkpoint, setCheckpoint] = useState("");
  const [cause, setCause] = useState<string>("fall");
  const [enemy, setEnemy] = useState("");
  if (!level) return <Notice kind="warn">The level is missing or invalid, so the rules cannot be simulated. Open data/level.json to fix it.</Notice>;
  const s = sim.current;
  if (!s) return null;
  const fire = (event: string, payload: Record<string, Scalar>) => {
    const before = s.host.effects.length;
    const r = s.runtime.run(event, payload, s.host);
    push(`${event} ${JSON.stringify(payload)}${r.handled ? "" : " (no rule handles this event)"}`, "event");
    for (const e of s.host.effects.slice(before)) push(effectText(e), "effect");
    for (const l of r.logs) push(`log: ${l}`, "log");
    if (r.error) push(`Rule error at ${r.error.node}: ${r.error.message}`, "error");
    onTrace(r.trace);
    force((x) => x + 1);
  };
  const coins = level.objects.filter((o) => o.type === "coin" && !s.host.collected.has(o.id));
  const checkpoints = level.objects.filter((o) => o.type === "checkpoint");
  const enemies = level.objects.filter((o) => o.type === "enemy");
  const goal = level.objects.find((o) => o.type === "goal");
  return (
    <div className="sim">
      <div className="row row--wrap" style={{ gap: 8, padding: 10, borderBottom: "1px solid var(--line)" }}>
        <Button size="small" icon={<PlayIcon />} onClick={() => fire("start", {})}>On Start</Button>
        <span className="faint">|</span>
        <select className="select" style={{ width: 120 }} aria-label="Coin to collect" value={coin} onChange={(e) => setCoin(e.target.value)}>
          <option value="">Coin…</option>
          {coins.map((o) => <option key={o.id} value={o.id}>{o.id}</option>)}
        </select>
        <Button size="small" disabled={!coin} tip={coin ? undefined : "Choose a coin first"} onClick={() => { const { kind } = s.host.collect(coin); fire("collect", { itemId: coin, kind }); setCoin(""); }}>Collect</Button>
        <select className="select" style={{ width: 130 }} aria-label="Checkpoint" value={checkpoint} onChange={(e) => setCheckpoint(e.target.value)}>
          <option value="">Checkpoint…</option>
          {checkpoints.map((o) => <option key={o.id} value={o.id}>{o.id}</option>)}
        </select>
        <Button size="small" disabled={!checkpoint} tip={checkpoint ? undefined : "Choose a checkpoint first"} onClick={() => fire("checkpoint", { checkpointId: checkpoint })}>Reach</Button>
        <select className="select" style={{ width: 100 }} aria-label="Hurt cause" value={cause} onChange={(e) => setCause(e.target.value)}>
          {HURT_CAUSES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <Button size="small" onClick={() => { s.host.hurts += 1; fire("hurt", { cause }); }}>Hurt</Button>
        <select className="select" style={{ width: 120 }} aria-label="Enemy" value={enemy} onChange={(e) => setEnemy(e.target.value)}>
          <option value="">Enemy…</option>
          {enemies.map((o) => <option key={o.id} value={o.id}>{o.id}</option>)}
        </select>
        <Button size="small" disabled={!enemy} tip={enemy ? undefined : "Choose an enemy first"} onClick={() => fire("stomp", { enemyId: enemy })}>Stomp</Button>
        <Button size="small" disabled={!goal} tip={goal ? undefined : "The level has no goal flag"} onClick={() => goal && fire("goal", { goalId: goal.id })}>Reach goal</Button>
        <span className="spacer" />
        <Button size="small" variant="ghost" icon={<ResetIcon />} onClick={reset}>Reset</Button>
      </div>
      <div className="sim__cols">
        <div className="console" style={{ flex: 1 }}>
          {lines.length === 0 && <span className="muted">Fire an event to run the compiled rules against a model of the level. Executed nodes light up on the canvas.</span>}
          {lines.map((l) => <div key={l.id} className={l.kind === "error" ? "console__line--stderr" : l.kind === "event" ? "console__line--studio" : ""}>{l.kind === "effect" ? "  → " : ""}{l.text}</div>)}
        </div>
        <div className="sim__state">
          <div className="section-label">Level state</div>
          <dl className="kv">
            <dt>Objective</dt><dd>{s.host.objective || "none yet"}</dd>
            <dt>Coins</dt><dd>{s.host.collected.size} of {level.objects.filter((o) => o.type === "coin").length}</dd>
            <dt>Doors open</dt><dd>{[...s.host.openDoors].join(", ") || "none"}</dd>
            <dt>Times hurt</dt><dd>{s.host.hurts}</dd>
            <dt>Complete</dt><dd>{s.host.won ? "Yes" : "No"}</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
