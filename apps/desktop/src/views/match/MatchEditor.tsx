import { useCallback, useMemo, useRef, useState } from "react";
import { CONTROLS, DIFFICULTIES, FORMATIONS, PLAYER_SKILLS, parseMatch, type Control, type Match, type Player, type PlayerSkill, type Team, type TeamSide } from "@gamestudio/football";
import { useProject } from "../../state/project";
import { Field, IconButton, Notice, NumberInput, Segmented, Switch, TextInput } from "../../components/ui";
import { RedoIcon, UndoIcon } from "../../components/icons";

const CONTROL_LABEL: Record<Control, string> = { home: "Home team", away: "Away team", none: "Watch" };
const CONTROL_TIP: Record<Control, string> = {
  home: "You control the home team, attacking the goal on the right",
  away: "You control the away team, attacking the goal on the left",
  none: "The computer plays both sides while you watch",
};
const sideLabel = (side: TeamSide, control: Control) => `${side === "home" ? "Home" : "Away"} team${control === side ? " (yours)" : " (the computer's)"}`;
const DIFFICULTY_TIP: Record<(typeof DIFFICULTIES)[number], string> = {
  easy: "Slower players who think longer, lose more tackles and shoot wider; keepers reach less",
  normal: "A fair match",
  hard: "Quick, sharp players who win more tackles and shoot straighter; keepers reach further",
};

/** The pitch from above, with each team's kick-off line-up in its colours (the game lines up the same way, match.gd). */
function PitchPreview({ match }: { match: Match }) {
  const { length, width, goalWidth, grass, lines, stripes } = match.pitch;
  const hl = length / 2;
  const hw = width / 2;
  const pad = 3;
  const depth = Math.min(6, hl / 3);
  const area = Math.min(goalWidth / 2 + 3, hw - 1);
  const bands = Math.max(1, Math.round((length + 2) / 4));
  const lineW = 0.15;
  const players = (side: TeamSide) =>
    (FORMATIONS[match.teamSize] ?? []).map((f, i) => {
      const x = (-hl + f.x * hl) * (side === "home" ? 1 : -1);
      const z = f.z * (hw - 2) * (side === "home" ? 1 : -1);
      const t = match[side];
      const player = t.players[i];
      return (
        <g key={`${side}-${i}`} transform={`translate(${x} ${z})`}>
          <title>{player ? `${player.number} ${player.name}` : `Player ${i + 1}`}</title>
          <circle r={0.75} fill={i === 0 ? t.keeper : t.shirt} stroke={t.shorts} strokeWidth={0.25} />
          <text y={0.35} fontSize={0.95} textAnchor="middle" fill="#0b0f16" fontWeight={700}>{player?.number ?? i + 1}</text>
          {player && <text y={-1.1} fontSize={0.8} textAnchor="middle" fill="#ffffff" stroke="#0b0f16" strokeWidth={0.12} paintOrder="stroke">{player.name.split(" ").at(-1)}</text>}
        </g>
      );
    });
  return (
    <svg className="match-preview" viewBox={`${-hl - pad} ${-hw - pad} ${length + pad * 2} ${width + pad * 2}`} role="img" aria-label={`Pitch ${length} by ${width} metres with ${match.teamSize} players a side`}>
      <rect x={-hl - pad} y={-hw - pad} width={length + pad * 2} height={width + pad * 2} fill="#2b3a2a" />
      {Array.from({ length: bands }, (_, i) => {
        const w = (length + 2) / bands;
        return <rect key={i} x={-hl - 1 + i * w} y={-hw - 0.5} width={w + 0.01} height={width + 1} fill={grass} opacity={stripes && i % 2 === 1 ? 0.88 : 1} />;
      })}
      <g fill="none" stroke={lines} strokeWidth={lineW}>
        <rect x={-hl} y={-hw} width={length} height={width} />
        <line x1={0} y1={-hw} x2={0} y2={hw} />
        <circle r={3} />
        <rect x={-hl} y={-area} width={depth} height={area * 2} />
        <rect x={hl - depth} y={-area} width={depth} height={area * 2} />
      </g>
      <rect x={-hl - 1.2} y={-goalWidth / 2} width={1.2} height={goalWidth} fill="rgba(255,255,255,0.35)" stroke="#f4f4f4" strokeWidth={0.15} />
      <rect x={hl} y={-goalWidth / 2} width={1.2} height={goalWidth} fill="rgba(255,255,255,0.35)" stroke="#f4f4f4" strokeWidth={0.15} />
      <circle r={0.3} fill="#ffffff" />
      {players("home")}
      {players("away")}
    </svg>
  );
}

const SKILL_LABEL: Record<PlayerSkill, string> = { pace: "Pace", shooting: "Shot", tackling: "Tackle" };
const SKILL_TIP: Record<PlayerSkill, string> = {
  pace: "Running speed (1 to 10; 5 is standard)",
  shooting: "How hard and how straight shots go (1 to 10)",
  tackling: "How often a tackle wins the ball (1 to 10)",
};

/** The squad: five players with names, shirt numbers and skills; a smaller side plays the first ones. */
function Squad({ side, team, teamSize, onChange }: { side: TeamSide; team: Team; teamSize: number; onChange: (players: Player[]) => void }) {
  const set = (i: number, patch: Partial<Player>) => onChange(team.players.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <table className="squad" aria-label={`${team.name} squad`}>
      <thead>
        <tr>
          <th scope="col">No.</th>
          <th scope="col">Name</th>
          {PLAYER_SKILLS.map((k) => <th key={k} scope="col" data-tip={SKILL_TIP[k]}>{SKILL_LABEL[k]}</th>)}
        </tr>
      </thead>
      <tbody>
        {team.players.map((p, i) => (
          <tr key={i} className={i >= teamSize ? "squad__bench" : undefined} data-tip={i >= teamSize ? `Not playing: ${teamSize} a side fields the first ${teamSize}` : i === 0 ? "Keeps goal" : undefined}>
            <td><NumberInput ariaLabel={`${side} player ${i + 1} shirt number`} value={p.number} min={1} max={99} onCommit={(number) => set(i, { number: Math.round(number) })} /></td>
            <td><TextInput ariaLabel={`${side} player ${i + 1} name`} value={p.name} maxLength={24} onCommit={(name) => name.trim() && set(i, { name: name.trim() })} />{i === 0 && <span className="squad__role">GK</span>}</td>
            {PLAYER_SKILLS.map((k) => (
              <td key={k}><NumberInput ariaLabel={`${side} player ${i + 1} ${k}`} value={p[k]} min={1} max={10} onCommit={(v) => set(i, { [k]: Math.round(v) } as Partial<Player>)} /></td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TeamFields({ side, team, teamSize, control, onChange }: { side: TeamSide; team: Team; teamSize: number; control: Control; onChange: (t: Team) => void }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="section-label">{sideLabel(side, control)}</div>
      <div className="field-row">
        <Field label="Name" htmlFor={`m-${side}-name`}><TextInput id={`m-${side}-name`} value={team.name} maxLength={40} onCommit={(name) => name.trim() && onChange({ ...team, name: name.trim() })} /></Field>
        <Field label="Short name" htmlFor={`m-${side}-short`} help="2 to 4 letters, on the scoreboard">
          <TextInput id={`m-${side}-short`} mono value={team.short} maxLength={4} onCommit={(s) => /^[A-Za-z0-9]{2,4}$/.test(s.trim()) && onChange({ ...team, short: s.trim().toUpperCase() })} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Shirts" htmlFor={`m-${side}-shirt`}><input id={`m-${side}-shirt`} type="color" className="input" style={{ padding: 2 }} value={team.shirt} onChange={(e) => onChange({ ...team, shirt: e.target.value })} /></Field>
        <Field label="Shorts" htmlFor={`m-${side}-shorts`}><input id={`m-${side}-shorts`} type="color" className="input" style={{ padding: 2 }} value={team.shorts} onChange={(e) => onChange({ ...team, shorts: e.target.value })} /></Field>
        <Field label="Keeper" htmlFor={`m-${side}-keeper`}><input id={`m-${side}-keeper`} type="color" className="input" style={{ padding: 2 }} value={team.keeper} onChange={(e) => onChange({ ...team, keeper: e.target.value })} /></Field>
      </div>
      <Squad side={side} team={team} teamSize={teamSize} onChange={(players) => onChange({ ...team, players })} />
    </div>
  );
}

export function MatchEditor({ path }: { path: string }) {
  const doc = useProject((s) => s.docs[path]);
  const updateDoc = useProject((s) => s.updateDoc);
  const match = doc?.data as Match | undefined;
  const validation = useMemo(() => (match ? parseMatch(match) : null), [match]);
  const past = useRef<Match[]>([]);
  const future = useRef<Match[]>([]);
  const [, bump] = useState(0);
  const commit = useCallback(
    (next: Match) => {
      if (!match) return;
      past.current.push(match);
      if (past.current.length > 100) past.current.shift();
      future.current = [];
      updateDoc(path, next);
      bump((x) => x + 1);
    },
    [match, path, updateDoc],
  );
  if (!match || !validation) return <div style={{ padding: 16 }}><Notice kind="warn">The match settings could not be read.</Notice></div>;
  if (!validation.ok) {
    return (
      <div style={{ padding: 16 }} className="stack">
        <Notice kind="error">These match settings have problems: {validation.errors.join("; ")}</Notice>
        <p className="small muted">Open {path} as text (Developer mode) to fix them, or undo the last change.</p>
      </div>
    );
  }
  const m = validation.match;
  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(match);
    updateDoc(path, prev);
    bump((x) => x + 1);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(match);
    updateDoc(path, next);
    bump((x) => x + 1);
  };
  const setPitch = (patch: Partial<Match["pitch"]>) => commit({ ...m, pitch: { ...m.pitch, ...patch } });
  const goalLimit = m.pitch.width - 6;
  return (
    <div className="match-editor">
      <div className="match-editor__form inspector" aria-label="Match settings">
        <div className="row" style={{ gap: 6, justifyContent: "space-between" }}>
          <div className="section-label">Match</div>
          <div className="row" style={{ gap: 2 }}>
            <IconButton label="Undo" tip={past.current.length ? "Undo" : "Nothing to undo"} disabled={!past.current.length} onClick={undo}><UndoIcon /></IconButton>
            <IconButton label="Redo" tip={future.current.length ? "Redo" : "Nothing to redo"} disabled={!future.current.length} onClick={redo}><RedoIcon /></IconButton>
          </div>
        </div>
        <TextInput ariaLabel="Match name" value={m.name} maxLength={80} onCommit={(name) => name.trim() && commit({ ...m, name: name.trim() })} />
        <Field label="Players a side" help="The goalkeeper included.">
          <Segmented ariaLabel="Players a side" value={String(m.teamSize) as "5"} options={(["2", "3", "4", "5"] as const).map((n) => ({ value: n as "5", label: n }))} onChange={(n) => commit({ ...m, teamSize: Number(n) })} />
        </Field>
        <div className="field-row">
          <Field label="Minutes" htmlFor="m-minutes" help="Of play; the clock stops for goals and kick-offs."><NumberInput id="m-minutes" value={m.minutes} min={1} max={20} step={0.5} onCommit={(minutes) => commit({ ...m, minutes })} /></Field>
        </div>
        <Field label="You play">
          <Segmented ariaLabel="You play" value={m.control} options={CONTROLS.map((c) => ({ value: c, label: CONTROL_LABEL[c], tip: CONTROL_TIP[c] }))} onChange={(control) => commit({ ...m, control })} />
        </Field>
        <Field label="The computer's skill">
          <Segmented ariaLabel="The computer's skill" value={m.difficulty} options={DIFFICULTIES.map((d) => ({ value: d, label: d[0]!.toUpperCase() + d.slice(1), tip: DIFFICULTY_TIP[d] }))} onChange={(difficulty) => commit({ ...m, difficulty })} />
        </Field>
        <TeamFields side="home" team={m.home} teamSize={m.teamSize} control={m.control} onChange={(home) => commit({ ...m, home })} />
        <TeamFields side="away" team={m.away} teamSize={m.teamSize} control={m.control} onChange={(away) => commit({ ...m, away })} />
        <div className="section-label">Pitch</div>
        <div className="field-row">
          <Field label="Length (m)" htmlFor="m-length"><NumberInput id="m-length" value={m.pitch.length} min={24} max={70} onCommit={(length) => setPitch({ length })} /></Field>
          <Field label="Width (m)" htmlFor="m-width"><NumberInput id="m-width" value={m.pitch.width} min={Math.max(14, m.pitch.goalWidth + 6)} max={45} onCommit={(width) => setPitch({ width })} /></Field>
          <Field label="Goal width (m)" htmlFor="m-goal"><NumberInput id="m-goal" value={m.pitch.goalWidth} min={2} max={Math.min(7.5, goalLimit)} step={0.5} onCommit={(goalWidth) => setPitch({ goalWidth })} /></Field>
        </div>
        <div className="field-row">
          <Field label="Grass" htmlFor="m-grass"><input id="m-grass" type="color" className="input" style={{ padding: 2 }} value={m.pitch.grass} onChange={(e) => setPitch({ grass: e.target.value })} /></Field>
          <Field label="Lines" htmlFor="m-lines"><input id="m-lines" type="color" className="input" style={{ padding: 2 }} value={m.pitch.lines} onChange={(e) => setPitch({ lines: e.target.value })} /></Field>
        </div>
        <Switch checked={m.pitch.stripes} label="Mown stripes" onChange={(stripes) => setPitch({ stripes })} />
        <p className="xsmall muted" style={{ margin: 0 }}>The pitch is walled, so the ball never goes out: no throw-ins or corners. The computer plays both keepers and everyone you are not controlling.</p>
      </div>
      <div className="match-editor__preview">
        <div className="match-editor__board" aria-label="Scoreboard preview">
          <span className="match-swatch" style={{ background: m.home.shirt }} />
          <strong>{m.home.short}</strong>
          <span className="muted">0 – 0</span>
          <strong>{m.away.short}</strong>
          <span className="match-swatch" style={{ background: m.away.shirt }} />
          <span className="mono muted">{Math.floor(m.minutes)}:{String(Math.round((m.minutes % 1) * 60)).padStart(2, "0")}</span>
        </div>
        <PitchPreview match={m} />
        <div className="xsmall muted">{m.name}: {m.home.name} against {m.away.name}, {m.teamSize} a side</div>
      </div>
    </div>
  );
}
