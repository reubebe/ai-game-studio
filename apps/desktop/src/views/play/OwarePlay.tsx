import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { compileGraph, type RuleGraph } from "@gamestudio/rules-core";
import {
  checkMove,
  chooseMove,
  computerAgrees,
  decodeLog,
  describeEvents,
  encodeLog,
  GRAND_SLAM_LABELS,
  housesFor,
  ILLEGAL_MESSAGES,
  ownedPits,
  ownerAt,
  opponent,
  OwareMatch,
  pitLabel,
  playerName,
  resultSentence,
  sweep,
  totalSeeds,
  winThreshold,
  type ActionOutcome,
  type OwareConfig,
  type OwareEvent,
  type OwareState,
  type Player,
} from "@gamestudio/oware";
import { registry } from "../../lib/registry";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { Button, Field, Notice, Segmented } from "../../components/ui";
import { BookIcon, BotIcon, FlagIcon, GraphIcon, HandIcon, PauseIcon, PlayIcon, RedoIcon, ResetIcon, UndoIcon } from "../../components/icons";
import { clearSession, hashText, isPauseKey, loadSession, saveSession, sessionKey } from "./boardSession";

/** What is kept of a game in progress: the moves (as encodeLog writes them) and who plays which side. */
interface OwareSave {
  log: string;
  computer: "off" | "north" | "south";
  depth: 2 | 4 | 6;
}

const NORTH_ROW = [11, 10, 9, 8, 7, 6];
const SOUTH_ROW = [0, 1, 2, 3, 4, 5];

function Seeds({ n }: { n: number }) {
  const shown = Math.min(n, 22);
  return (
    <>
      {Array.from({ length: shown }, (_, i) => {
        const r = 6.6 * Math.sqrt(i + 0.6);
        const a = i * 2.39996;
        return <span key={i} className="seed" style={{ left: `calc(50% + ${Math.cos(a) * r}px)`, top: `calc(50% + ${Math.sin(a) * r}px)` }} />;
      })}
    </>
  );
}

interface LogEntry {
  player: Player;
  pit: number;
  /** Seeds the mover took with this move (fours taken by the other player while sowing are theirs). */
  captured: number;
  round: number;
}

/** Seeds a move gave the mover: their captures, including fours they took while sowing and the last seeds. */
function capturedBy(events: OwareEvent[], player: Player): number {
  return events.reduce((n, e) => n + ((e.type === "capture" || e.type === "last-seeds") && e.player === player ? e.seeds : 0), 0);
}

/** The move in words, the rules' own messages, then how the game ended (once, in plain words). */
function describe(events: OwareEvent[], messages: string[], state: OwareState): string {
  const swept = events.find((e): e is Extract<OwareEvent, { type: "sweep" }> => e.type === "sweep")?.seeds;
  const line = [describeEvents(events), ...messages].filter(Boolean).join(" · ");
  const result = resultSentence(state, swept);
  return [line && `${line}.`, result].filter(Boolean).join(" ");
}

export function OwarePlay({ graphPath }: { graphPath: string }) {
  const doc = useProject((s) => s.docs[graphPath]);
  const openTab = useProject((s) => s.openTab);
  const files = useProject((s) => s.files);
  const setRoute = useApp((s) => s.setRoute);
  const openDialog = useApp((s) => s.openDialog);
  const root = useProject((s) => s.root);
  const compiled = useMemo(() => (doc && !doc.error ? compileGraph(doc.data as RuleGraph, registry) : null), [doc]);
  // A game in progress is kept for this project and rule graph, and only restored under the same rules.
  const rules = useMemo(() => (doc && !doc.error ? hashText(JSON.stringify(doc.data)) : ""), [doc]);
  const key = root ? sessionKey(root, graphPath) : null;
  const program = compiled?.ok ? compiled.program ?? null : null;
  const match = useRef<OwareMatch | null>(null);
  const [state, setState] = useState<OwareState | null>(null);
  const [display, setDisplay] = useState<number[] | null>(null);
  const [animating, setAnimating] = useState(false);
  const [lastPit, setLastPit] = useState<number | null>(null);
  const [flash, setFlash] = useState<number[]>([]);
  const startMessage = program && (program.domainConfig as unknown as OwareConfig).rounds ? "South starts round 1. Choose one of your houses to sow from." : "South moves first. Choose one of your pits.";
  const [message, setMessage] = useState(startMessage);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [computer, setComputer] = useState<"off" | "north" | "south">("north");
  const [depth, setDepth] = useState<2 | 4 | 6>(4);
  const [paused, setPaused] = useState(false);
  const timers = useRef<number[]>([]);
  const current = useRef({ key, rules, computer, depth, paused });
  current.current = { key, rules, computer, depth, paused };

  /** Keep the game (in memory now, in the app's settings soon after, or at once with `now`). */
  const remember = useCallback((now = false) => {
    const m = match.current;
    const c = current.current;
    if (!m || !c.key) return;
    if (m.log.length === 0) return clearSession(c.key);
    saveSession<OwareSave>(c.key, c.rules, { log: encodeLog(m.log), computer: c.computer, depth: c.depth }, now);
  }, []);

  const sync = () => {
    const m = match.current;
    if (!m) return;
    setState(m.state);
    setDisplay(null);
    setLog(rebuildLog(m));
  };

  const newGame = useCallback(() => {
    timers.current.forEach(window.clearTimeout);
    timers.current = [];
    if (!program) return;
    match.current = new OwareMatch(program);
    if (current.current.key) clearSession(current.current.key);
    setState(match.current.state);
    setDisplay(null);
    setAnimating(false);
    setLastPit(null);
    setLog([]);
    setPaused(false);
    setMessage(startMessage);
  }, [program, startMessage]);

  /** New game asks first when a game is under way, since it cannot be undone. */
  const askNewGame = () => {
    const m = match.current;
    if (!m || m.state.status !== "playing" || m.log.length === 0) return newGame();
    openDialog({ kind: "confirm", title: "Start a new game?", body: `The game in progress (${m.log.length} ${m.log.length === 1 ? "move" : "moves"}) will be lost.`, confirmLabel: "New game", onConfirm: () => newGame() });
  };

  const togglePause = useCallback(() => {
    const m = match.current;
    if (!m || m.state.status !== "playing") return;
    const next = !current.current.paused;
    current.current.paused = next;
    setPaused(next);
    setMessage(next ? "Paused. Press Resume (or P) to carry on; leaving the Play view keeps the game too." : `Resumed: ${playerName(m.state.toMove)} to move.`);
    remember(true);
  }, [remember]);

  // Resigning ends the game at once: the other player wins. Against the computer you resign; two people
  // at one board resign for the player whose turn it is.
  const askResign = () => {
    const m = match.current;
    if (!m || m.state.status !== "playing") return;
    const quitter: Player = computer === "north" ? 0 : computer === "south" ? 1 : m.state.toMove;
    openDialog({
      kind: "confirm",
      title: "Resign this game?",
      body: `${playerName(quitter)} gives up and ${playerName(opponent(quitter))} wins.${computer === "off" ? ` It is ${playerName(quitter)}'s turn, so ${playerName(quitter)} resigns.` : ""} Undo takes it back.`,
      confirmLabel: "Resign",
      danger: true,
      onConfirm: () => {
        const o = m.resign(quitter);
        if (!o.accepted) return;
        setPaused(false);
        sync();
        setMessage(resultSentence(m.state) ?? "");
        remember(true);
      },
    });
  };

  // Ending by agreement needs both players: the computer agrees only once the game is going round in
  // circles (a position has come back); two people at the board both confirm.
  const offerToEnd = () => {
    const m = match.current;
    if (!m || m.state.status !== "playing") return;
    const end = (prefix: string) => {
      const o = m.agreeToEnd();
      setState(m.state);
      setMessage(o.accepted ? [prefix, describe(o.events, o.messages, m.state)].filter(Boolean).join(" ") : o.rejection ?? o.error?.message ?? "");
      if (o.accepted) remember();
    };
    const rounds = m.config.rounds;
    const what = rounds ? "round" : "game";
    if (computer === "off") {
      const [south, north] = sweep(m.state).state.scores;
      const houses = housesFor([south, north], m.config);
      const verdict = rounds
        ? `${houses[0]} houses to ${houses[1]}${houses[0] === houses[1] ? ", an even round" : `, so ${playerName(houses[0] > houses[1] ? 0 : 1)} would win the round`}`
        : south === north ? "a draw" : `${playerName(south > north ? 0 : 1)} would win`;
      openDialog({
        kind: "confirm",
        title: `End the ${what} by agreement?`,
        body: rounds
          ? "Both players can agree to end a round that is going round in circles. Each player then takes the seeds in their own houses, and the next round starts."
          : "The rules allow this when both players agree the game is going round in circles, with nothing left to capture. Each player then takes the seeds on their own side.",
        details: [`South would ${rounds ? "have" : "finish with"} ${south} seeds and North ${rounds ? "" : "with "}${north}: ${verdict}.`],
        confirmLabel: "We both agree",
        onConfirm: () => end(""),
      });
      return;
    }
    const cpu = playerName(computer === "north" ? 1 : 0);
    if (computerAgrees(m.state)) end(`${cpu} (the computer) agrees: this position has come up before, so the ${what} is going round in circles.`);
    else setMessage(`${cpu} (the computer) does not agree: the ${what} is not going round in circles yet. It agrees once the same position comes up again.`);
  };

  // Open the game this project left off (paused), or start a new one.
  useEffect(() => {
    if (!program) return;
    const k = current.current.key;
    const saved = k ? loadSession<OwareSave>(k, current.current.rules) : null;
    const actions = saved ? decodeLog(saved.data.log) : null;
    if (saved && actions) {
      try {
        const restored = OwareMatch.replay(program, actions);
        timers.current.forEach(window.clearTimeout);
        timers.current = [];
        match.current = restored;
        setComputer(saved.data.computer);
        setDepth(saved.data.depth);
        setState(restored.state);
        setDisplay(null);
        setAnimating(false);
        setLastPit(null);
        setLog(rebuildLog(restored));
        const playing = restored.state.status === "playing";
        current.current.paused = playing;
        setPaused(playing);
        setMessage(playing ? `Your game is where you left it (${actions.length} ${actions.length === 1 ? "move" : "moves"}), paused. Press Resume (or P) to carry on.` : resultSentence(restored.state) ?? "");
        return;
      } catch {
        if (k) clearSession(k);
      }
    }
    newGame();
  }, [program, newGame]);

  // Leaving the Play view pauses the game and keeps it.
  useEffect(
    () => () => {
      const m = match.current;
      if (m && m.state.status === "playing" && m.log.length > 0) remember(true);
    },
    [remember],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPauseKey(e)) return;
      e.preventDefault();
      togglePause();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePause]);

  const play = useCallback(
    (pit: number) => {
      const m = match.current;
      if (!m || animating) return;
      const before = m.state;
      const mover = before.toMove;
      const outcome: ActionOutcome = m.play(pit);
      if (!outcome.accepted) {
        setMessage(outcome.error ? `Rule error at ${outcome.error.node ?? "?"}: ${outcome.error.message}` : outcome.rejection ?? "That move is not allowed.");
        return;
      }
      const sow = outcome.events.find((e): e is Extract<OwareEvent, { type: "sow" }> => e.type === "sow");
      setLog((l) => [...l, { player: mover, pit, captured: capturedBy(outcome.events, mover), round: before.round ?? 1 }]);
      remember();
      const finish = () => {
        setState(m.state);
        setDisplay(null);
        setAnimating(false);
        setMessage(describe(outcome.events, outcome.messages, m.state));
        const capturePits = outcome.events.flatMap((e) => (e.type === "capture" ? e.pits : []));
        setFlash(capturePits);
        timers.current.push(window.setTimeout(() => setFlash([]), 750));
      };
      if (!sow || sow.path.length === 0) {
        finish();
        return;
      }
      setAnimating(true);
      // Replay the sowing: seeds lifted (relay sowing lifts again where the last seed lands), dropped one
      // by one, and fours taken while sowing. Variants without relay or captures while sowing only drop.
      const steps = sow.steps ?? [{ pit, kind: "lift" as const, seeds: sow.seeds }, ...sow.path.map((p) => ({ pit: p, kind: "drop" as const, seeds: 1 }))];
      const pits = [...before.pits];
      pits[pit] = 0;
      setDisplay([...pits]);
      setLastPit(null);
      const later = steps.slice(1);
      const step = Math.max(35, Math.min(120, (sow.steps ? 3200 : 1400) / later.length));
      later.forEach((st, i) => {
        timers.current.push(
          window.setTimeout(() => {
            if (st.kind === "drop") {
              pits[st.pit] = (pits[st.pit] ?? 0) + 1;
              setLastPit(st.pit);
            } else {
              pits[st.pit] = 0;
              if (st.kind === "capture") setFlash((f) => [...f, st.pit]);
            }
            setDisplay([...pits]);
            if (i === later.length - 1) timers.current.push(window.setTimeout(finish, 220));
          }, step * (i + 1)),
        );
      });
    },
    [animating, remember],
  );

  useEffect(() => {
    const m = match.current;
    if (!m || !state || animating || paused || state.status !== "playing" || computer === "off") return;
    const computerPlayer: Player = computer === "north" ? 1 : 0;
    if (state.toMove !== computerPlayer) return;
    const t = window.setTimeout(() => {
      const choice = chooseMove(m, depth);
      if (choice) play(choice.pit);
    }, 500);
    return () => window.clearTimeout(t);
  }, [state, animating, paused, computer, depth, play]);

  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);

  if (!doc) return null;
  if (!program) {
    return (
      <div style={{ padding: 24, maxWidth: 720 }} className="stack">
        <Notice kind="error">The game's rules do not compile, so the game cannot start: {compiled?.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join("; ") ?? doc.error}</Notice>
        <div><Button icon={<GraphIcon />} onClick={() => { void openTab(graphPath); setRoute("workspace"); }}>Fix the rules</Button></div>
      </div>
    );
  }
  const m = match.current;
  if (!m || !state) return null;
  const pits = display ?? state.pits;
  const legal = animating || paused || state.status !== "playing" ? [] : m.legalMoves();
  const config = program.domainConfig as unknown as OwareConfig;
  const humanTurn = computer === "off" || (computer === "north" ? state.toMove === 0 : state.toMove === 1);
  const rounds = config.rounds;
  const pitWord = rounds ? "house" : "pit";
  const houses: [number, number] = [ownedPits(state, 0).length, ownedPits(state, 1).length];
  // Why a pit cannot be played right now (aria-disabled rather than disabled, so the reason shows on hover).
  const pitReason = (p: number): string | undefined => {
    const owner = ownerAt(state, p);
    if (animating) return "Wait for the seeds to land";
    if (state.status !== "playing") return "The game is over. Start a new game to play again.";
    if (paused) return "The game is paused. Press Resume (or P) to carry on.";
    if (!humanTurn) return "The computer is choosing its move";
    if (owner !== state.toMove) return `${playerName(owner)}'s ${pitWord}: it is ${playerName(state.toMove)}'s turn`;
    if ((pits[p] ?? 0) === 0) return `This ${pitWord} is empty`;
    const check = checkMove(state, p, m.config);
    return check.legal ? "The current rules do not allow this move" : ILLEGAL_MESSAGES[check.reason];
  };
  const pitButton = (p: number, row: "north" | "south") => {
    const isLegal = legal.includes(p) && humanTurn;
    const own = ownerAt(state, p);
    return (
      <button
        key={p}
        type="button"
        className={`oware-pit ${isLegal ? "oware-pit--legal" : ""} ${lastPit === p ? "oware-pit--last" : ""} ${flash.includes(p) ? "oware-pit--captured" : ""} ${rounds ? `oware-pit--house-${own === 0 ? "south" : "north"}` : ""}`}
        aria-disabled={isLegal ? undefined : true}
        data-tip={isLegal ? undefined : pitReason(p)}
        onClick={() => {
          if (isLegal) play(p);
        }}
        aria-label={`Pit ${pitLabel(p)}: ${pits[p]} seeds${rounds ? `, ${playerName(own)}'s house` : ""}${isLegal ? ", playable" : ""}`}
        data-testid={`pit-${p}`}
      >
        <Seeds n={pits[p] ?? 0} />
        <span className="oware-pit__count">{pits[p]}</span>
        <span className={`oware-pit__label oware-pit__label--${row === "north" ? "top" : "bottom"}`}>{pitLabel(p)}</span>
      </button>
    );
  };
  const docPath = files.find((f) => f.path.startsWith("docs/rules/") && f.path.endsWith(".md"))?.path;
  return (
    <div className="oware">
      <div className="oware__stage">
        <div className={`oware-player ${state.toMove === 1 && state.status === "playing" ? "oware-player--active" : ""}`}>
          <span className="oware-player__dot" />
          North {computer === "north" && <span className="badge badge--violet"><BotIcon width={11} /> computer</span>}
          <span className="muted">· captured {state.scores[1]}{rounds ? ` · ${houses[1]} ${houses[1] === 1 ? "house" : "houses"}` : ""}</span>
          {rounds && <span className="badge" data-testid="oware-round">Round {state.round ?? 1}</span>}
        </div>
        <div className="board-wrap">
        <div className="oware-board" role="group" aria-label={program.graphId === "ayo" ? "Ayò board" : "Oware board"}>
          <div className="oware-store" style={{ gridColumn: 1 }} aria-label={`North has captured ${state.scores[1]}`}>
            <span className="oware-store__count">{state.scores[1]}</span>
            <span className="oware-store__label">North</span>
          </div>
          {NORTH_ROW.map((p) => pitButton(p, "north"))}
          <div className="oware-store" style={{ gridColumn: 8, gridRow: "1 / span 2" }} aria-label={`South has captured ${state.scores[0]}`}>
            <span className="oware-store__count">{state.scores[0]}</span>
            <span className="oware-store__label">South</span>
          </div>
          {SOUTH_ROW.map((p) => pitButton(p, "south"))}
        </div>
          {paused && state.status === "playing" && (
            <div className="board-paused" data-testid="board-paused">
              <span className="board-paused__title"><PauseIcon width={18} /> Paused</span>
              <Button variant="primary" icon={<PlayIcon />} onClick={togglePause}>Resume</Button>
            </div>
          )}
        </div>
        <div className={`oware-player ${state.toMove === 0 && state.status === "playing" ? "oware-player--active" : ""}`}>
          <span className="oware-player__dot" />
          South {computer === "south" && <span className="badge badge--violet"><BotIcon width={11} /> computer</span>}
          <span className="muted">· captured {state.scores[0]}{rounds ? ` · ${houses[0]} ${houses[0] === 1 ? "house" : "houses"}` : ""}</span>
        </div>
        <div className="small" style={{ maxWidth: 720, textAlign: "center", minHeight: 40, color: state.status === "finished" ? "var(--accent-2)" : "var(--text-2)" }} role="status" data-testid="oware-message">
          {message}
        </div>
      </div>
      <aside className="oware__side">
        <div className="panel__header"><span className="panel__title">Game</span></div>
        <div style={{ padding: 12 }} className="stack">
          <div className="row row--wrap">
            <Button size="small" icon={<ResetIcon />} onClick={askNewGame}>New game</Button>
            <Button size="small" icon={paused ? <PlayIcon /> : <PauseIcon />} disabled={state.status !== "playing"} tip={state.status !== "playing" ? "The game is over" : paused ? "Carry on playing (P)" : "Stop play for now (P); the computer waits and the game is kept"} onClick={togglePause}>{paused ? "Resume" : "Pause"}</Button>
            <Button size="small" icon={<FlagIcon />} disabled={state.status !== "playing" || animating} tip={state.status !== "playing" ? "The game is over" : animating ? "Wait for the seeds to land" : "End the game now: the other player wins"} onClick={askResign}>Resign</Button>
          </div>
          <div className="row row--wrap">
            <Button size="small" icon={<UndoIcon />} disabled={!m.canUndo || animating} tip={animating ? "Wait for the seeds to land" : !m.canUndo ? "No moves to undo yet" : undefined} onClick={() => { m.undo(); if (computer !== "off" && m.canUndo && m.state.toMove === (computer === "north" ? 1 : 0)) m.undo(); sync(); setMessage(resultSentence(m.state) ?? "Move undone."); remember(); }}>Undo</Button>
            <Button size="small" icon={<RedoIcon />} disabled={!m.canRedo || animating} tip={animating ? "Wait for the seeds to land" : !m.canRedo ? "No undone move to redo" : undefined} onClick={() => { m.redo(); sync(); setMessage(resultSentence(m.state) ?? "Move redone."); remember(); }}>Redo</Button>
            <Button size="small" icon={<HandIcon />} disabled={state.status !== "playing" || animating} tip={state.status !== "playing" ? "The game is over" : animating ? "Wait for the seeds to land" : computer === "off" ? "When the game is going round in circles, both players can agree to end it: each takes the seeds on their own side" : "Offer to end a game that is going round in circles: if the computer agrees, each player takes the seeds on their own side"} onClick={offerToEnd}>Agree to end</Button>
          </div>
          <Field label="Computer plays">
            <Segmented ariaLabel="Computer plays" value={computer} onChange={setComputer} options={[{ value: "off", label: "Nobody", tip: "Two people share this board" }, { value: "north", label: "North" }, { value: "south", label: "South" }]} />
          </Field>
          <Field label="Strength" help="Deterministic minimax search through the rule graph, so house rules are respected.">
            <Segmented ariaLabel="Computer strength" value={String(depth) as "2" | "4" | "6"} onChange={(v) => setDepth(Number(v) as 2 | 4 | 6)} options={[{ value: "2", label: "Gentle" }, { value: "4", label: "Steady" }, { value: "6", label: "Strong" }]} />
          </Field>
        </div>
        <div className="panel__header"><span className="panel__title">Moves</span><span className="xsmall muted">{log.length}</span></div>
        <div className="panel__body">
          <div className="move-log" data-testid="move-log">
            {log.map((e, i) => (
              <div key={i} style={{ display: "contents" }}>
                {rounds && (i === 0 || log[i - 1]!.round !== e.round) && <span className="move-log__round">Round {e.round}</span>}
                <span className="move-log__n">{i + 1}.</span>
                <span>{playerName(e.player)}</span>
                <span>{pitLabel(e.pit)}{e.captured ? ` ×${e.captured}` : ""}</span>
              </div>
            ))}
            {log.length === 0 && <span className="muted" style={{ gridColumn: "1 / span 3" }}>No moves yet.</span>}
          </div>
        </div>
        <div className="panel__header"><span className="panel__title">Rules in play</span></div>
        <div style={{ padding: 12 }} className="stack">
          {rounds ? (
            <dl className="kv" data-testid="oware-rules">
              <dt>Seeds</dt><dd>{config.seedsPerPit} per house, {totalSeeds(config)} in all, every round</dd>
              <dt>Sowing</dt><dd>Anticlockwise{config.relay ? "; lift and sow on until the last seed lands in an empty house" : ""}</dd>
              <dt>Captures</dt><dd>{config.ownerCaptures.length > 0 ? `A house reaching ${config.ownerCaptures.join(" or ")} goes to its owner, in either player's move` : "None while sowing"}; your last seed making {config.captureCounts.join(" or ")} over there is yours</dd>
              <dt>No seeds</dt><dd>{config.emptyPasses ? "That player passes; the other must give them seeds, or the round ends" : config.mustFeed ? "The other player must give them seeds" : "Not required"}</dd>
              <dt>Round end</dt><dd>{config.lastSeeds > 0 ? `With ${config.lastSeeds} seeds left, the next four take the rest` : "When the seeds run out"}</dd>
              <dt>Rounds</dt><dd>Refill {config.seedsPerPit} to a house; extra houses come from the other row. {config.roundStarter === "winner" ? "The round's winner starts the next" : "The players take turns to start"}</dd>
              <dt>Winning</dt><dd>Take all the other player&apos;s houses</dd>
            </dl>
          ) : (
            <dl className="kv" data-testid="oware-rules">
              <dt>Seeds</dt><dd>{config.seedsPerPit} per pit, {totalSeeds(config)} in all; South moves first</dd>
              <dt>Sowing</dt><dd>Counter-clockwise{config.skipOrigin ? "; 12 or more skip the pit they came from" : "; laps also fill the pit they came from"}</dd>
              <dt>Captures</dt><dd>Last seed makes {config.captureCounts.join(" or ")} in an opponent's pit{config.captureChain ? ", and the unbroken run of such pits before it" : ""}</dd>
              <dt>Grand slam</dt><dd>{GRAND_SLAM_LABELS[config.grandSlam]}</dd>
              <dt>Feeding</dt><dd>{config.mustFeed ? "An opponent with no seeds must be given some" : "Not required"}</dd>
              <dt>Winning</dt><dd>{winThreshold(config)} or more; {totalSeeds(config) / 2} each is a draw</dd>
              <dt>Endless cycles</dt><dd>Both players agree to end{config.repetitionLimit > 0 ? `, or a position comes up ${config.repetitionLimit} times` : ""}; each takes their own side</dd>
            </dl>
          )}
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

/** Rebuild the move list (who moved, what they took, in which round) by replaying the match log once. */
function rebuildLog(m: OwareMatch): LogEntry[] {
  const scratch = new OwareMatch(m.program);
  const out: LogEntry[] = [];
  for (const a of m.log) {
    if (a.type !== "move") {
      if (a.type === "agree") scratch.agreeToEnd();
      else scratch.resign(a.player);
      continue;
    }
    const player = scratch.state.toMove;
    const round = scratch.state.round ?? 1;
    const outcome = scratch.play(a.pit);
    out.push({ player, pit: a.pit, captured: capturedBy(outcome.events, player), round });
  }
  return out;
}
