import { useEffect, useMemo, useRef, useState } from "react";
import { RecordingHost, RuleRuntime, type RuleProgram, type Scalar } from "@gamestudio/rules-core";
import { ExploreSimHost, parseWorld, type SimEffect, type SimEvent, type World } from "@gamestudio/explore";
import { useProject } from "../../state/project";
import { useApp } from "../../state/app";
import { Button, Notice } from "../../components/ui";
import { PlayIcon, ResetIcon } from "../../components/icons";
import { PlatformerSimulator } from "./PlatformerSimulator";
import { FootballSimulator } from "./FootballSimulator";
import { FarmSimulator } from "./FarmSimulator";

interface LogLine {
  id: number;
  text: string;
  kind: "event" | "effect" | "log" | "error";
}

function useLog() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const n = useRef(0);
  return { lines, push: (text: string, kind: LogLine["kind"]) => setLines((l) => [{ id: ++n.current, text, kind }, ...l].slice(0, 200)), clear: () => setLines([]) };
}

function effectText(e: SimEffect): string {
  switch (e.type) {
    case "message": return `Message (${e.seconds}s): ${e.text}`;
    case "objective": return `Objective: ${e.text}`;
    case "gate": return `Gate opened: ${e.gateId}`;
    case "sound": return `Sound: ${e.sound}`;
    case "visibility": return `${e.visible ? "Show" : "Hide"} ${e.objectId}`;
    case "win": return `Level complete: ${e.text}`;
    case "health": return `Hearts: ${e.health} of ${e.max} (${e.change >= 0 ? "+" : ""}${e.change})`;
    case "timer": return `Timer ${e.timerId} started: ${e.seconds} s${e.repeat ? ", repeating" : ""}${e.countdown ? `, showing "${e.countdown}"` : ""}`;
    case "timerStopped": return `Timer ${e.timerId} stopped`;
  }
}

function Variables({ vars }: { vars: Readonly<Record<string, Scalar>> }) {
  const entries = Object.entries(vars);
  if (entries.length === 0) return <span className="xsmall muted">No variables</span>;
  return (
    <dl className="kv">
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt className="mono">{k}</dt>
          <dd className="mono">{JSON.stringify(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function ExploreSimulator({ program, onTrace }: { program: RuleProgram; onTrace: (ids: string[]) => void }) {
  const manifest = useProject((s) => s.manifest);
  const loadDoc = useProject((s) => s.loadDoc);
  const worldPath = manifest?.data.find((d) => d.kind === "explore-world")?.path;
  const worldDoc = useProject((s) => (worldPath ? s.docs[worldPath] : undefined));
  useEffect(() => {
    if (worldPath) void loadDoc(worldPath);
  }, [worldPath, loadDoc]);
  const world = useMemo<World | null>(() => {
    const r = worldDoc && !worldDoc.error ? parseWorld(worldDoc.data) : null;
    return r?.ok ? r.world : null;
  }, [worldDoc]);
  const sim = useRef<{ runtime: RuleRuntime; host: ExploreSimHost } | null>(null);
  const [, force] = useState(0);
  const log = useLog();
  const reset = () => {
    sim.current = world ? { runtime: new RuleRuntime(program), host: new ExploreSimHost(world) } : null;
    log.clear();
    force((x) => x + 1);
  };
  useEffect(reset, [program, world]); // eslint-disable-line react-hooks/exhaustive-deps
  const [collect, setCollect] = useState("");
  const [target, setTarget] = useState("");
  const [zone, setZone] = useState("");
  const [enemy, setEnemy] = useState("");
  const [block, setBlock] = useState("");
  const [blockZone, setBlockZone] = useState("");
  const [timer, setTimer] = useState("");
  if (!world) return <Notice kind="warn">The world layout is missing or invalid, so the rules cannot be simulated. Open data/world.json to fix it.</Notice>;
  const s = sim.current;
  if (!s) return null;
  /** Runs one event, then the ones the game would raise because of it (a Hurt Player that took the last heart). */
  const fire = (event: string, payload: Record<string, Scalar>) => {
    const queue: SimEvent[] = [{ event, payload }];
    const trace: string[] = [];
    for (let n = 0; queue.length > 0 && n < 32; n++) {
      const next = queue.shift()!;
      const before = s.host.effects.length;
      const r = s.runtime.run(next.event, next.payload, s.host);
      log.push(`${next.event} ${JSON.stringify(next.payload)}${r.handled ? "" : " (no rule handles this event)"}`, "event");
      for (const e of s.host.effects.slice(before)) log.push(effectText(e), "effect");
      for (const l of r.logs) log.push(`log: ${l}`, "log");
      if (r.error) log.push(`Rule error at ${r.error.node}: ${r.error.message}`, "error");
      trace.push(...r.trace);
      queue.push(...s.host.pending.splice(0));
    }
    onTrace(trace);
    force((x) => x + 1);
  };
  const fireAll = (events: SimEvent[]) => {
    for (const e of events) fire(e.event, e.payload);
  };
  const collectibles = world.objects.filter((o) => o.type === "collectible" && !s.host.collected.has(o.id));
  const targets = world.objects.filter((o) => o.type === "npc" || o.type === "sign");
  const zones = world.objects.filter((o) => o.type === "zone");
  const enemies = world.objects.filter((o) => o.type === "enemy" && !s.host.defeated.has(o.id));
  const blocks = world.objects.filter((o) => o.type === "crate");
  const timers = [...s.host.timers.keys()];
  const fights = world.objects.some((o) => o.type === "enemy") || "playerHurt" in program.handlers || "playerDefeated" in program.handlers;
  return (
    <div className="sim">
      <div className="row row--wrap" style={{ gap: 8, padding: 10, borderBottom: "1px solid var(--line)" }}>
        <Button size="small" icon={<PlayIcon />} onClick={() => fire("start", {})}>On Start</Button>
        <span className="faint">|</span>
        <select className="select" style={{ width: 150 }} aria-label="Collectible to collect" value={collect} onChange={(e) => setCollect(e.target.value)}>
          <option value="">Collectible…</option>
          {collectibles.map((o) => <option key={o.id} value={o.id}>{o.id}</option>)}
        </select>
        <Button size="small" disabled={!collect} onClick={() => { const { kind } = s.host.collect(collect); fire("collect", { itemId: collect, kind }); setCollect(""); }}>Collect</Button>
        <select className="select" style={{ width: 140 }} aria-label="Character or sign" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Talk to…</option>
          {targets.map((o) => <option key={o.id} value={o.id}>{o.id}</option>)}
        </select>
        <Button size="small" disabled={!target} onClick={() => fire("interact", { targetId: target })}>Interact</Button>
        <select className="select" style={{ width: 130 }} aria-label="Zone" value={zone} onChange={(e) => setZone(e.target.value)}>
          <option value="">Zone…</option>
          {zones.map((o) => <option key={o.id} value={o.id}>{o.id}</option>)}
        </select>
        <Button size="small" disabled={!zone} onClick={() => fire("enterZone", { zoneId: zone })}>Enter</Button>
        <span className="spacer" />
        <Button size="small" variant="ghost" icon={<ResetIcon />} onClick={reset}>Reset</Button>
      </div>
      {(fights || blocks.length > 0 || timers.length > 0 || "timer" in program.handlers) && (
        <div className="row row--wrap" style={{ gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--line)" }}>
          {fights && (
            <>
              <select className="select" style={{ width: 140 }} aria-label="Enemy" value={enemy} onChange={(e) => setEnemy(e.target.value)}>
                <option value="">Enemy…</option>
                {enemies.map((o) => <option key={o.id} value={o.id}>{o.id}</option>)}
              </select>
              <Button size="small" disabled={!enemy} tip="The player's staff takes its last health point" onClick={() => { const { kind } = s.host.defeat(enemy); fire("enemyDefeated", { enemyId: enemy, kind }); setEnemy(""); }}>Defeat</Button>
              <Button size="small" disabled={!enemy} tip="It touches the player, taking its damage in hearts" onClick={() => fireAll(s.host.hitBy(enemy))}>Hits the player</Button>
              <span className="faint">|</span>
            </>
          )}
          {blocks.length > 0 && (
            <>
              <select className="select" style={{ width: 120 }} aria-label="Block to push" value={block} onChange={(e) => setBlock(e.target.value)}>
                <option value="">Block…</option>
                {blocks.map((o) => <option key={o.id} value={o.id}>{o.id}</option>)}
              </select>
              <select className="select" style={{ width: 120 }} aria-label="Zone to push the block into" value={blockZone} onChange={(e) => setBlockZone(e.target.value)}>
                <option value="">into zone…</option>
                {zones.filter((o) => s.host.blockZones.get(block) !== o.id).map((o) => <option key={o.id} value={o.id}>{o.id}</option>)}
              </select>
              <Button size="small" disabled={!block || !blockZone} onClick={() => { s.host.push(block, blockZone); fire("blockInZone", { blockId: block, zoneId: blockZone }); setBlockZone(""); }}>Push in</Button>
              <span className="faint">|</span>
            </>
          )}
          <select className="select" style={{ width: 130 }} aria-label="Running timer" value={timer} disabled={timers.length === 0} onChange={(e) => setTimer(e.target.value)}>
            <option value="">{timers.length ? "Timer…" : "No timer running"}</option>
            {timers.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
          <Button size="small" disabled={!timer || !s.host.timers.has(timer)} tip="Skips to the end of the timer, as if its time ran out" onClick={() => { s.host.runOut(timer); fire("timer", { timerId: timer }); if (!s.host.timers.has(timer)) setTimer(""); }}>Run out</Button>
        </div>
      )}
      <div className="sim__cols">
        <div className="console" style={{ flex: 1 }}>
          {log.lines.length === 0 && <span className="muted">Fire an event to run the compiled rules against a model of the level. Executed nodes light up on the canvas.</span>}
          {log.lines.map((l) => <div key={l.id} className={l.kind === "error" ? "console__line--stderr" : l.kind === "event" ? "console__line--studio" : ""}>{l.kind === "effect" ? "  → " : ""}{l.text}</div>)}
        </div>
        <div className="sim__state">
          <div className="section-label">Level state</div>
          <dl className="kv">
            <dt>Objective</dt><dd>{s.host.objective || "none yet"}</dd>
            <dt>Collected</dt><dd>{[...s.host.collected].join(", ") || "none"}</dd>
            <dt>Gates open</dt><dd>{[...s.host.openGates].join(", ") || "none"}</dd>
            {fights && <><dt>Hearts</dt><dd>{s.host.health} of {s.host.maxHealth}</dd></>}
            {fights && <><dt>Defeated</dt><dd>{[...s.host.defeated].join(", ") || "none"}</dd></>}
            {blocks.length > 0 && <><dt>Blocks</dt><dd>{[...s.host.blockZones].map(([b, z]) => `${b} in ${z}`).join(", ") || "none in a zone"}</dd></>}
            {(timers.length > 0 || "timer" in program.handlers) && <><dt>Timers</dt><dd>{[...s.host.timers].map(([id, t]) => `${id} ${t.left} s`).join(", ") || "none running"}</dd></>}
            <dt>Complete</dt><dd>{s.host.won ? "Yes" : "No"}</dd>
          </dl>
          <div className="section-label">Variables</div>
          <Variables vars={s.runtime.variables} />
        </div>
      </div>
    </div>
  );
}

function CoreSimulator({ program, onTrace }: { program: RuleProgram; onTrace: (ids: string[]) => void }) {
  const runtime = useRef(new RuleRuntime(program));
  const [, force] = useState(0);
  const log = useLog();
  useEffect(() => {
    runtime.current = new RuleRuntime(program);
    log.clear();
    force((x) => x + 1);
  }, [program]); // eslint-disable-line react-hooks/exhaustive-deps
  const events = Object.keys(program.handlers);
  return (
    <div className="sim">
      <div className="row" style={{ gap: 8, padding: 10, borderBottom: "1px solid var(--line)" }}>
        {events.map((ev) => (
          <Button key={ev} size="small" icon={<PlayIcon />} onClick={() => {
            const r = runtime.current.run(ev, {}, new RecordingHost());
            log.push(`${ev}`, "event");
            for (const l of r.logs) log.push(l, "log");
            if (r.error) log.push(`Rule error at ${r.error.node}: ${r.error.message}`, "error");
            onTrace(r.trace);
            force((x) => x + 1);
          }}>Run {ev}</Button>
        ))}
        <span className="spacer" />
        <Button size="small" variant="ghost" icon={<ResetIcon />} onClick={() => { runtime.current = new RuleRuntime(program); log.clear(); force((x) => x + 1); }}>Reset variables</Button>
      </div>
      <div className="sim__cols">
        <div className="console" style={{ flex: 1 }}>
          {log.lines.length === 0 && <span className="muted">Run an event to execute the compiled graph. Logs and variables appear here; executed nodes light up.</span>}
          {log.lines.map((l) => <div key={l.id} className={l.kind === "error" ? "console__line--stderr" : l.kind === "event" ? "console__line--studio" : ""}>{l.text}</div>)}
        </div>
        <div className="sim__state">
          <div className="section-label">Variables</div>
          <Variables vars={runtime.current.variables} />
        </div>
      </div>
    </div>
  );
}

export function Simulator({ program, onTrace }: { program: RuleProgram | null; onTrace: (ids: string[]) => void }) {
  const setRoute = useApp((s) => s.setRoute);
  if (!program) return <div style={{ padding: 12 }}><Notice kind="warn">The rules have errors, so they cannot run. Fix the items under Problems.</Notice></div>;
  if (program.domain === "explore") return <ExploreSimulator program={program} onTrace={onTrace} />;
  if (program.domain === "platformer") return <PlatformerSimulator program={program} onTrace={onTrace} />;
  if (program.domain === "football") return <FootballSimulator program={program} onTrace={onTrace} />;
  if (program.domain === "farm") return <FarmSimulator program={program} onTrace={onTrace} />;
  if (program.domain === "oware" || program.domain === "ludo") {
    return (
      <div style={{ padding: 14 }} className="stack">
        <div className="small">These rules compile. The variant they define:</div>
        <dl className="kv">
          {Object.entries(program.domainConfig).map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt className="mono">{k}</dt>
              <dd className="mono">{JSON.stringify(v)}</dd>
            </div>
          ))}
        </dl>
        <div><Button variant="primary" size="small" icon={<PlayIcon />} onClick={() => setRoute("play")}>Play on the board with these rules</Button></div>
      </div>
    );
  }
  return <CoreSimulator program={program} onTrace={onTrace} />;
}
