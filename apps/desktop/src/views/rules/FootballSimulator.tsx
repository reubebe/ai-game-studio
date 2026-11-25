import { useEffect, useMemo, useRef, useState } from "react";
import { RuleRuntime, type RuleProgram, type Scalar } from "@gamestudio/rules-core";
import { FootballSimHost, parseMatch, type FootballEffect, type Match, type TeamSide } from "@gamestudio/football";
import { useProject } from "../../state/project";
import { Button, Notice } from "../../components/ui";
import { PlayIcon, ResetIcon } from "../../components/icons";

function effectText(e: FootballEffect): string {
  switch (e.type) {
    case "message": return `Message (${e.seconds}s): ${e.text}`;
    case "caption": return `Caption: ${e.text}`;
    case "sound": return `Sound: ${e.sound}`;
    case "time": return `Added ${e.seconds} s: ${e.left} s left`;
    case "score": return `Score changed (${e.team} ${e.change >= 0 ? "+" : ""}${e.change}): ${e.home} – ${e.away}`;
    case "end": return `Match over: ${e.text}`;
  }
}

/** Whole seconds rounded up, as the game's scoreboard shows them. */
const clockText = (seconds: number) => {
  const whole = Math.ceil(Math.max(0, seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/** Fires the match's events at a model of it (FootballSimHost): the score and the clock, without starting Godot. */
export function FootballSimulator({ program, onTrace }: { program: RuleProgram; onTrace: (ids: string[]) => void }) {
  const manifest = useProject((s) => s.manifest);
  const loadDoc = useProject((s) => s.loadDoc);
  const matchPath = manifest?.data.find((d) => d.kind === "football-match")?.path;
  const matchDoc = useProject((s) => (matchPath ? s.docs[matchPath] : undefined));
  useEffect(() => {
    if (matchPath) void loadDoc(matchPath);
  }, [matchPath, loadDoc]);
  const match = useMemo<Match | null>(() => {
    const r = matchDoc && !matchDoc.error ? parseMatch(matchDoc.data) : null;
    return r?.ok ? r.match : null;
  }, [matchDoc]);
  const sim = useRef<{ runtime: RuleRuntime; host: FootballSimHost } | null>(null);
  const [lines, setLines] = useState<{ id: number; text: string; kind: string }[]>([]);
  const n = useRef(0);
  const [, force] = useState(0);
  const [scorer, setScorer] = useState("");
  const push = (text: string, kind: string) => setLines((l) => [{ id: ++n.current, text, kind }, ...l].slice(0, 200));
  const reset = () => {
    sim.current = match ? { runtime: new RuleRuntime(program), host: new FootballSimHost(match) } : null;
    setLines([]);
    force((x) => x + 1);
  };
  useEffect(reset, [program, match]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!match) return <Notice kind="warn">The match settings are missing or invalid, so the rules cannot be simulated. Open data/match.json to fix them.</Notice>;
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
  /** The clock reached zero: On Full Time, then the game's own final whistle if no rule ended the match or added time. */
  const fullTime = () => {
    s.host.runOut();
    fire("fullTime", {});
    if (s.host.ended === null && s.host.secondsLeft <= 0) {
      s.host.ended = s.host.defaultResult();
      push(`Final whistle (no rule ended the match): ${s.host.ended}`, "effect");
      force((x) => x + 1);
    }
  };
  const over = s.host.ended !== null;
  // Another full minute fits before the clock runs out.
  const played = match.minutes * 60 - s.host.secondsLeft;
  const minuteFits = 60 - (played % 60) < s.host.secondsLeft;
  return (
    <div className="sim">
      <div className="row row--wrap" style={{ gap: 8, padding: 10, borderBottom: "1px solid var(--line)" }}>
        <Button size="small" icon={<PlayIcon />} onClick={() => fire("start", {})}>On Start</Button>
        <span className="faint">|</span>
        <select className="select" style={{ width: 190 }} aria-label="Scorer" value={scorer} onChange={(e) => setScorer(e.target.value)}>
          <option value="">Scorer…</option>
          {(["home", "away"] as const).map((side) => (
            <optgroup key={side} label={match[side].name}>
              {s.host.lineUp(side).map((p, i) => <option key={`${side}:${i}`} value={`${side}:${i}`}>{match[side].short} {p.number} {p.name}</option>)}
            </optgroup>
          ))}
        </select>
        <Button size="small" disabled={over || !scorer} tip="The chosen player scores" onClick={() => { const [side, slot] = scorer.split(":"); fire("goal", s.host.goal(side as TeamSide, Number(slot))); }}>Goal</Button>
        <span className="faint">|</span>
        <Button size="small" disabled={over || !minuteFits} tip="Plays on to the next full minute (On Minute)" onClick={() => { const minute = s.host.nextMinute(); if (minute !== null) fire("minute", { minute }); }}>Next minute</Button>
        <Button size="small" disabled={over} tip="Plays on until the clock reaches zero (On Full Time)" onClick={fullTime}>Full time</Button>
        <span className="spacer" />
        <Button size="small" variant="ghost" icon={<ResetIcon />} onClick={reset}>Reset</Button>
      </div>
      <div className="sim__cols">
        <div className="console" style={{ flex: 1 }}>
          {lines.length === 0 && <span className="muted">Fire an event to run the compiled rules against a model of the match. Executed nodes light up on the canvas.</span>}
          {lines.map((l) => <div key={l.id} className={l.kind === "error" ? "console__line--stderr" : l.kind === "event" ? "console__line--studio" : ""}>{l.kind === "effect" ? "  → " : ""}{l.text}</div>)}
        </div>
        <div className="sim__state">
          <div className="section-label">Match state</div>
          <dl className="kv">
            <dt>Score</dt><dd>{match.home.short} {s.host.score.home} – {s.host.score.away} {match.away.short}</dd>
            <dt>Clock</dt><dd className="mono">{clockText(s.host.secondsLeft)}</dd>
            <dt>Caption</dt><dd>{s.host.caption || "none yet"}</dd>
            <dt>Result</dt><dd>{s.host.ended ?? "still playing"}</dd>
          </dl>
          <div className="section-label">Variables</div>
          <dl className="kv">
            {Object.entries(s.runtime.variables).map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt className="mono">{k}</dt>
                <dd className="mono">{JSON.stringify(v)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
