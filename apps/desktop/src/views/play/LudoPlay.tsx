import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { compileGraph, type RuleGraph } from "@gamestudio/rules-core";
import { chooseToken, decodeLudoLog, encodeLudoLog, HOME, LAST_TRACK, LudoMatch, playerName, YARD, type LudoConfig, type LudoEvent, type LudoOutcome } from "@gamestudio/ludo";
import { registry } from "../../lib/registry";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { Button, Field, Notice, Segmented } from "../../components/ui";
import { BookIcon, BotIcon, DiceIcon, FlagIcon, GraphIcon, PauseIcon, PlayIcon, RedoIcon, ResetIcon, UndoIcon } from "../../components/icons";
import { clearSession, hashText, isPauseKey, loadSession, saveSession, sessionKey } from "./boardSession";
import { cellPaint, SEAT_COLOURS, tokenCell } from "./ludoBoard";

type Who = "person" | "computer";

/** What is kept of a game in progress: the dice seed, the actions (as encodeLudoLog writes them) and who plays which seat. */
interface LudoSave {
  seed: number;
  players: "2" | "3" | "4";
  who: Who[];
  log: string;
}
const PIPS: Record<number, [number, number][]> = {
  1: [[50, 50]],
  2: [[28, 28], [72, 72]],
  3: [[26, 26], [50, 50], [74, 74]],
  4: [[28, 28], [72, 28], [28, 72], [72, 72]],
  5: [[26, 26], [74, 26], [50, 50], [26, 74], [74, 74]],
  6: [[28, 24], [72, 24], [28, 50], [72, 50], [28, 76], [72, 76]],
};

function newSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]!;
}

function describe(match: LudoMatch, events: LudoEvent[], messages: string[]): string {
  const s = match.state;
  const name = (p: number) => playerName(s, p);
  const parts: string[] = [];
  for (const e of events) {
    if (e.type === "roll") parts.push(`${name(e.player)} rolled ${e.value}`);
    if (e.type === "sixes") parts.push(`a third 6 in a row: the turn passes`);
    if (e.type === "no-move") parts.push(`no token can move`);
    if (e.type === "enter") parts.push(`token ${e.token + 1} comes out`);
    if (e.type === "move") parts.push(e.to > LAST_TRACK && e.to !== HOME ? `token ${e.token + 1} moves into the home column` : `token ${e.token + 1} moves ${e.to - e.from}`);
    if (e.type === "capture") parts.push(`captured ${e.victims.map((v) => name(v.player)).join(" and ")}, back to the yard`);
    if (e.type === "home") parts.push(`token ${e.token + 1} is home`);
    if (e.type === "again") parts.push(`roll again`);
    if (e.type === "turn") parts.push(`${name(e.player)}'s turn`);
    if (e.type === "win") parts.push(`${name(e.player)} wins!`);
  }
  return [...parts, ...messages].join(" · ");
}

function Die({ value, rolling }: { value: number | null; rolling: boolean }) {
  return (
    <svg className={`ludo-die ${rolling ? "ludo-die--rolling" : ""}`} viewBox="0 0 100 100" aria-hidden="true">
      <rect x="4" y="4" width="92" height="92" rx="18" />
      {(value ? PIPS[value] ?? [] : []).map(([x, y], i) => <circle key={i} cx={x} cy={y} r="8.5" />)}
    </svg>
  );
}

export function LudoPlay({ graphPath }: { graphPath: string }) {
  const doc = useProject((s) => s.docs[graphPath]);
  const openTab = useProject((s) => s.openTab);
  const files = useProject((s) => s.files);
  const setRoute = useApp((s) => s.setRoute);
  const openDialog = useApp((s) => s.openDialog);
  const root = useProject((s) => s.root);
  const compiled = useMemo(() => (doc && !doc.error ? compileGraph(doc.data as RuleGraph, registry) : null), [doc]);
  const rules = useMemo(() => (doc && !doc.error ? hashText(JSON.stringify(doc.data)) : ""), [doc]);
  const key = root ? sessionKey(root, graphPath) : null;
  const program = compiled?.ok ? compiled.program ?? null : null;
  const match = useRef<LudoMatch | null>(null);
  const [players, setPlayers] = useState<"2" | "3" | "4">("2");
  const [who, setWho] = useState<Who[]>(["person", "computer", "computer", "computer"]);
  const [seed, setSeed] = useState(newSeed);
  const [, setTick] = useState(0);
  const [message, setMessage] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [rolling, setRolling] = useState(false);
  const [paused, setPaused] = useState(false);
  const refresh = () => setTick((t) => t + 1);
  const current = useRef({ key, rules, players, who, seed, paused });
  current.current = { key, rules, players, who, seed, paused };
  const restored = useRef(false);
  // Restoring a game with another number of players changes `players`, which would otherwise start a new game.
  const restoringPlayers = useRef<string | null>(null);

  /** Keep the game (in memory now, in the app's settings soon after, or at once with `now`). */
  const remember = useCallback((now = false) => {
    const m = match.current;
    const c = current.current;
    if (!m || !c.key) return;
    if (m.log.length === 0) return clearSession(c.key);
    saveSession<LudoSave>(c.key, c.rules, { seed: c.seed, players: c.players, who: c.who, log: encodeLudoLog(m.log) }, now);
  }, []);

  const start = useCallback(
    (nextSeed: number) => {
      if (!program) return;
      match.current = new LudoMatch(program, Number(players), nextSeed);
      if (current.current.key) clearSession(current.current.key);
      setSeed(nextSeed);
      setLog([]);
      setPaused(false);
      current.current.paused = false;
      setMessage(`${playerName(match.current.state, 0)} starts. Roll the die.`);
      refresh();
    },
    [program, players],
  );

  // Open the game this project left off (paused), or start a new one. Changing the number of players starts a new game.
  useEffect(() => {
    if (!program) return;
    if (restoringPlayers.current !== null && restoringPlayers.current === players) {
      restoringPlayers.current = null;
      return;
    }
    const k = current.current.key;
    const saved = !restored.current && k ? loadSession<LudoSave>(k, current.current.rules) : null;
    restored.current = true;
    const actions = saved ? decodeLudoLog(saved.data.log) : null;
    if (saved && actions) {
      try {
        const again = LudoMatch.replay(program, Number(saved.data.players), saved.data.seed, actions);
        match.current = again;
        if (saved.data.players !== players) restoringPlayers.current = saved.data.players;
        setPlayers(saved.data.players);
        setWho(saved.data.who);
        setSeed(saved.data.seed);
        setLog([]);
        const playing = again.state.status === "playing";
        current.current.paused = playing;
        setPaused(playing);
        setMessage(playing ? `Your game is where you left it (${actions.length} ${actions.length === 1 ? "action" : "actions"}), paused. Press Resume (or P) to carry on.` : "This game is over. Start a new game to play again.");
        refresh();
        return;
      } catch {
        if (k) clearSession(k);
      }
    }
    start(newSeed());
  }, [start, program, players]);

  // Leaving the Play view pauses the game and keeps it.
  useEffect(
    () => () => {
      const m = match.current;
      if (m && m.state.status === "playing" && m.log.length > 0) remember(true);
    },
    [remember],
  );

  const after = useCallback((outcome: LudoOutcome) => {
    const m = match.current;
    if (!m) return;
    if (!outcome.accepted) {
      setMessage(outcome.error ? `Rule error at ${outcome.error.node ?? "?"}: ${outcome.error.message}` : outcome.rejection ?? "That is not allowed.");
      return;
    }
    const text = describe(m, outcome.events, outcome.messages);
    setMessage(text);
    setLog((l) => [...l, text].slice(-200));
    refresh();
    remember();
  }, [remember]);

  const togglePause = useCallback(() => {
    const m = match.current;
    if (!m || m.state.status !== "playing") return;
    const next = !current.current.paused;
    current.current.paused = next;
    setPaused(next);
    setMessage(next ? "Paused. Press Resume (or P) to carry on; leaving the Play view keeps the game too." : `Resumed: ${playerName(m.state, m.state.toMove)} to play.`);
    remember(true);
  }, [remember]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPauseKey(e)) return;
      e.preventDefault();
      togglePause();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePause]);

  /** New game asks first when a game is under way, since it cannot be undone. */
  const askNewGame = () => {
    const m = match.current;
    if (!m || m.state.status !== "playing" || m.log.length === 0) return start(newSeed());
    openDialog({ kind: "confirm", title: "Start a new game?", body: "The game in progress will be lost.", confirmLabel: "New game", onConfirm: () => start(newSeed()) });
  };

  /** The players stop before anyone has won: the game ends with no winner (Undo takes it back). */
  const askEnd = () => {
    const m = match.current;
    if (!m || m.state.status !== "playing") return;
    openDialog({
      kind: "confirm",
      title: "End this game?",
      body: "The game stops here and nobody wins. Undo takes it back.",
      confirmLabel: "End game",
      danger: true,
      onConfirm: () => {
        if (!m.endGame().accepted) return;
        setPaused(false);
        current.current.paused = false;
        setMessage("Game ended. Nobody won.");
        setLog((l) => [...l, "The players ended the game."].slice(-200));
        refresh();
        remember(true);
      },
    });
  };

  const roll = useCallback(() => {
    const m = match.current;
    if (!m) return;
    setRolling(true);
    window.setTimeout(() => setRolling(false), 350);
    after(m.roll());
  }, [after]);

  const move = useCallback((token: number) => {
    const m = match.current;
    if (m) after(m.move(token));
  }, [after]);

  const m = match.current;
  const state = m?.state;
  const seatOf = (player: number) => state?.seats[player] ?? 0;
  const computerTurn = !!state && state.status === "playing" && who[seatOf(state.toMove)] === "computer";
  const thinking = computerTurn && !paused;

  useEffect(() => {
    if (!m || !state || !thinking) return;
    const t = window.setTimeout(() => {
      if (m.state.dice === null) roll();
      else {
        const choice = chooseToken(m);
        if (choice) move(choice.token);
      }
    }, state.dice === null ? 650 : 550);
    return () => window.clearTimeout(t);
  });

  if (!doc) return null;
  if (!program) {
    return (
      <div style={{ padding: 24 }}>
        <Notice kind="error">The game's rules do not compile, so the game cannot start: {compiled?.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join("; ") ?? doc.error}</Notice>
      </div>
    );
  }
  if (!m || !state) return null;
  const config = program.domainConfig as unknown as LudoConfig;
  const legal = computerTurn || paused ? [] : m.legalMoves();
  const currentName = playerName(state, state.toMove);
  const rollReason = state.status !== "playing" ? "The game is over. Start a new game to play again." : paused ? "The game is paused. Press Resume (or P) to carry on." : computerTurn ? "The computer is playing" : state.dice !== null ? "Move a token with this roll first" : undefined;
  const docPath = files.find((f) => f.path.startsWith("docs/rules/") && f.path.endsWith(".md"))?.path;

  const cells = [];
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const paint = cellPaint(r, c);
      if (paint.kind === "none" || paint.kind === "yard") continue;
      const colour = paint.seat !== undefined ? SEAT_COLOURS[paint.seat] : undefined;
      cells.push(<div key={`${r}-${c}`} className={`ludo-cell ludo-cell--${paint.kind}`} style={{ gridRow: r + 1, gridColumn: c + 1, ...(colour ? { ["--seat" as string]: colour } : {}) }} />);
    }
  }
  const tokens = state.tokens.flatMap((list, player) =>
    list.map((progress, token) => {
      const seat = seatOf(player);
      const [r, c] = tokenCell(seat, progress, token);
      const stacked = progress !== YARD && progress !== HOME ? list.slice(0, token).filter((p) => p === progress).length : 0;
      const playable = player === state.toMove && legal.includes(token);
      const where = progress === YARD ? "in the yard" : progress === HOME ? "home" : progress > LAST_TRACK ? `in the home column (${progress - LAST_TRACK} of 5)` : `${progress} squares along`;
      return (
        <button
          key={`${player}-${token}`}
          type="button"
          className={`ludo-token ${playable ? "ludo-token--legal" : ""}`}
          style={{ top: `${(r / 15) * 100 + stacked * 1.2}%`, left: `${(c / 15) * 100 + stacked * 1.2}%`, ["--seat" as string]: SEAT_COLOURS[seat] }}
          aria-disabled={playable ? undefined : true}
          data-tip={playable ? undefined : paused ? "The game is paused" : player !== state.toMove ? `${playerName(state, player)}'s token` : state.dice === null ? "Roll the die first" : "This token cannot move with this roll"}
          aria-label={`${playerName(state, player)} token ${token + 1}, ${where}${playable ? ", can move" : ""}`}
          data-testid={`token-${seat}-${token}`}
          onClick={() => {
            if (playable) move(token);
          }}
        >
          {token + 1}
        </button>
      );
    }),
  );

  return (
    <div className="oware">
      <div className="oware__stage">
        <div className="ludo-turn" role="status" data-testid="ludo-turn">
          <span className="ludo-turn__dot" style={{ background: SEAT_COLOURS[seatOf(state.toMove)] }} />
          {state.status === "finished" ? (state.winner === null ? "Game ended" : `${playerName(state, state.winner)} wins`) : `${currentName}'s turn${computerTurn ? " (computer)" : ""}${paused ? " · paused" : ""}`}
        </div>
        <div className="board-wrap">
        <div className="ludo-board" role="group" aria-label="Ludo board">
          {[0, 1, 2, 3].map((s) => (
            <div key={s} className={`ludo-yard ${state.seats.includes(s) ? "" : "ludo-yard--empty"}`} style={{ gridRow: s < 2 ? "1 / span 6" : "10 / span 6", gridColumn: s === 0 || s === 3 ? "1 / span 6" : "10 / span 6", ["--seat" as string]: SEAT_COLOURS[s] }}>
              <div className="ludo-yard__inner" />
            </div>
          ))}
          {cells}
          <div className="ludo-centre" style={{ gridRow: "7 / span 3", gridColumn: "7 / span 3" }} />
          {tokens}
        </div>
          {paused && state.status === "playing" && (
            <div className="board-paused" data-testid="board-paused">
              <span className="board-paused__title"><PauseIcon width={18} /> Paused</span>
              <Button variant="primary" icon={<PlayIcon />} onClick={togglePause}>Resume</Button>
            </div>
          )}
        </div>
        <div className="row" style={{ gap: 14 }}>
          <Die value={state.dice} rolling={rolling} />
          <Button variant="primary" icon={<DiceIcon />} disabled={rollReason !== undefined} tip={rollReason} onClick={roll} data-testid="ludo-roll">Roll</Button>
        </div>
        <div className="small" style={{ maxWidth: 720, textAlign: "center", minHeight: 40, color: state.status === "finished" ? "var(--accent-2)" : "var(--text-2)" }} data-testid="ludo-message">
          {message}
        </div>
      </div>
      <aside className="oware__side">
        <div className="panel__header"><span className="panel__title">Game</span></div>
        <div style={{ padding: 12 }} className="stack">
          <div className="row row--wrap">
            <Button size="small" icon={<ResetIcon />} onClick={askNewGame}>New game</Button>
            <Button size="small" icon={paused ? <PlayIcon /> : <PauseIcon />} disabled={state.status !== "playing"} tip={state.status !== "playing" ? "The game is over" : paused ? "Carry on playing (P)" : "Stop play for now (P); the computer waits and the game is kept"} onClick={togglePause}>{paused ? "Resume" : "Pause"}</Button>
            <Button size="small" icon={<FlagIcon />} disabled={state.status !== "playing"} tip={state.status !== "playing" ? "The game is over" : "Stop the game here; nobody wins"} onClick={askEnd}>End game</Button>
          </div>
          <div className="row row--wrap">
            <Button size="small" icon={<UndoIcon />} disabled={!m.canUndo} tip={!m.canUndo ? "Nothing to undo yet" : undefined} onClick={() => { m.undo(); refresh(); setMessage("Undone. The dice are seeded, so rolling again gives the same number."); remember(); }}>Undo</Button>
            <Button size="small" icon={<RedoIcon />} disabled={!m.canRedo} tip={!m.canRedo ? "Nothing undone to redo" : undefined} onClick={() => { m.redo(); refresh(); remember(); }}>Redo</Button>
          </div>
          <Field label="Players" help="Two players sit opposite each other. Changing this starts a new game.">
            <Segmented ariaLabel="Players" value={players} onChange={setPlayers} options={[{ value: "2", label: "2" }, { value: "3", label: "3" }, { value: "4", label: "4" }]} />
          </Field>
          {state.seats.map((seat) => (
            <Field key={seat} label={<span className="row" style={{ gap: 6 }}><span className="ludo-turn__dot" style={{ background: SEAT_COLOURS[seat] }} />{playerName(state, state.seats.indexOf(seat))}</span>}>
              <Segmented ariaLabel={`${playerName(state, state.seats.indexOf(seat))} is played by`} value={who[seat]!} onChange={(v) => setWho((w) => w.map((x, i) => (i === seat ? v : x)))} options={[{ value: "person", label: "Person" }, { value: "computer", label: <span className="row" style={{ gap: 4 }}><BotIcon width={11} /> Computer</span> }]} />
            </Field>
          ))}
          <div className="xsmall muted" data-testid="ludo-seed">Dice seed {seed}: the same seed and moves replay the same game.</div>
        </div>
        <div className="panel__header"><span className="panel__title">What happened</span><span className="xsmall muted">{log.length}</span></div>
        <div className="panel__body">
          <div className="stack" style={{ padding: "8px 14px", gap: 4 }} data-testid="ludo-log">
            {log.slice(-40).map((line, i) => <div key={i} className="xsmall muted">{line}</div>)}
            {log.length === 0 && <span className="xsmall muted">Nothing yet.</span>}
          </div>
        </div>
        <div className="panel__header"><span className="panel__title">Rules in play</span></div>
        <div style={{ padding: 12 }} className="stack">
          <dl className="kv">
            <dt>Out of the yard</dt><dd>on {config.enterOn.join(" or ")}</dd>
            <dt>Another roll</dt><dd>{[config.bonusOnSix && "after a 6", config.bonusOnCapture && "after a capture", config.bonusOnHome && "after reaching home"].filter(Boolean).join(", ") || "never"}</dd>
            <dt>Sixes</dt><dd>{config.maxSixes > 0 ? `${config.maxSixes} in a row lose the turn` : "no limit"}</dd>
            <dt>Blocks</dt><dd>{config.blocks ? "two tokens block the way" : "tokens share squares"}</dd>
            <dt>Start squares</dt><dd>{config.safeStarts ? "safe" : "not safe"}</dd>
            <dt>Reaching home</dt><dd>{config.exactFinish ? "exact count" : "any count"}</dd>
          </dl>
          <div className="row row--wrap">
            <Button size="small" icon={<GraphIcon />} onClick={() => { void openTab(graphPath); setRoute("workspace"); }}>Edit rules</Button>
            {docPath && <Button size="small" icon={<BookIcon />} onClick={() => { void openTab(docPath); setRoute("workspace"); }}>Sources</Button>}
          </div>
          {doc.dirty && <span className="xsmall" style={{ color: "var(--amber)" }}>Playing with unsaved rule changes.</span>}
        </div>
      </aside>
    </div>
  );
}
