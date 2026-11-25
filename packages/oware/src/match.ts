import { RuleRuntime, type RuleProgram, type Scalar } from "@gamestudio/rules-core";
import { createInitialState, checkMove, ownedPits, resign, type OwareConfig, type OwareEvent, type OwareState, type Player } from "./engine";
import { OwareHost } from "./host";

export type MatchAction = { type: "move"; pit: number } | { type: "agree" } | { type: "resign"; player: Player };

const PIT_CHARS = "0123456789ab";

/** A replay log as a short string, one character an action: pits 0-11 as 0-9, a, b; agreement "="; resignation "S" or "N". */
export function encodeLog(actions: readonly MatchAction[]): string {
  return actions.map((a) => (a.type === "move" ? PIT_CHARS[a.pit] ?? "?" : a.type === "agree" ? "=" : a.player === 0 ? "S" : "N")).join("");
}

/** Reads a log written by encodeLog; null if any character is not an action. */
export function decodeLog(text: string): MatchAction[] | null {
  const out: MatchAction[] = [];
  for (const c of text) {
    if (c === "=") out.push({ type: "agree" });
    else if (c === "S" || c === "N") out.push({ type: "resign", player: c === "S" ? 0 : 1 });
    else if (PIT_CHARS.includes(c)) out.push({ type: "move", pit: PIT_CHARS.indexOf(c) });
    else return null;
  }
  return out;
}

export interface ActionOutcome {
  accepted: boolean;
  /** Present when the rules rejected the action. */
  rejection?: string;
  /** Present when the rule graph failed at runtime; the state did not change. */
  error?: { message: string; node?: string };
  events: OwareEvent[];
  messages: string[];
  trace: string[];
}

interface Frame {
  state: OwareState;
  variables: Record<string, Scalar>;
}

export interface MatchSnapshot {
  state: OwareState;
  history: MatchAction[];
  cursor: number;
}

/** Plays Oware by running a compiled rule graph; keeps undo/redo history and an exact replay log. */
export class OwareMatch {
  readonly config: OwareConfig;
  private readonly runtime: RuleRuntime;
  private frames: Frame[];
  private actions: MatchAction[] = [];
  private cursor = 0;

  constructor(readonly program: RuleProgram, start?: OwareState) {
    if (program.domain !== "oware") throw new Error(`Expected an Oware rule program, got domain '${program.domain}'`);
    this.config = program.domainConfig as unknown as OwareConfig;
    this.runtime = new RuleRuntime(program);
    this.frames = [{ state: start ?? createInitialState(this.config), variables: { ...this.runtime.variables } }];
  }

  /** Start from a set-up position (puzzles, tests, teaching examples). */
  static fromState(program: RuleProgram, state: OwareState): OwareMatch {
    const total = state.pits.reduce((a, b) => a + b, 0) + state.scores[0] + state.scores[1];
    const config = program.domainConfig as unknown as OwareConfig;
    if (state.pits.length !== 12 || state.pits.some((n) => !Number.isInteger(n) || n < 0)) throw new Error("A position needs twelve non-negative whole-number pits");
    if (total !== config.seedsPerPit * 12) throw new Error(`Seeds on the board plus captured seeds must total ${config.seedsPerPit * 12}`);
    return new OwareMatch(program, state);
  }

  get state(): OwareState {
    return this.frames[this.cursor]!.state;
  }

  get variables(): Record<string, Scalar> {
    return { ...this.frames[this.cursor]!.variables };
  }

  /** Actions applied so far (the replay log); excludes undone actions. */
  get log(): MatchAction[] {
    return this.actions.slice(0, this.cursor);
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.actions.length;
  }

  /** Pits the guard would accept, for highlighting. The graph still decides when a move is played. */
  legalMoves(): number[] {
    if (this.state.status !== "playing") return [];
    return ownedPits(this.state, this.state.toMove).filter((p) => checkMove(this.state, p, this.config).legal);
  }

  play(pit: number): ActionOutcome {
    return this.apply({ type: "move", pit });
  }

  agreeToEnd(): ActionOutcome {
    return this.apply({ type: "agree" });
  }

  /** A player gives up (by default the player to move); the other wins. Kept in the history, so Undo takes it back. */
  resign(player: Player = this.state.toMove): ActionOutcome {
    return this.apply({ type: "resign", player });
  }

  /** Apply without touching history: used by the computer opponent's search. */
  simulate(state: OwareState, variables: Record<string, Scalar>, action: MatchAction): { outcome: ActionOutcome; state: OwareState; variables: Record<string, Scalar> } {
    if (action.type === "resign") {
      const r = resign(state, action.player);
      return { outcome: { accepted: r.legal, events: r.events, messages: [], trace: [], ...(r.legal ? {} : { rejection: "The game is over." }) }, state: r.state, variables };
    }
    const host = new OwareHost(this.config, state);
    this.runtime.reset();
    this.runtime.setVariables(variables);
    const run = action.type === "move" ? this.runtime.run("move", { pit: action.pit, player: state.toMove }, host) : this.runtime.run("agreeEnd", {}, host);
    const outcome: ActionOutcome = { accepted: false, events: host.events, messages: host.messages, trace: run.trace };
    if (run.error) outcome.error = run.error;
    else if (!run.handled) outcome.rejection = action.type === "agree" ? "These rules have no 'On Players Agree to End' event." : "These rules have no 'On Move Chosen' event.";
    else if (host.rejected !== null) outcome.rejection = host.rejected;
    else if (host.state === state && host.events.length === 0) outcome.rejection = "The rules did not change the game.";
    else outcome.accepted = true;
    return outcome.accepted ? { outcome, state: host.state, variables: { ...this.runtime.variables } } : { outcome, state, variables };
  }

  private apply(action: MatchAction): ActionOutcome {
    if (this.state.status !== "playing") return { accepted: false, rejection: "The game is over.", events: [], messages: [], trace: [] };
    const frame = this.frames[this.cursor]!;
    const result = this.simulate(frame.state, frame.variables, action);
    if (result.outcome.accepted) {
      this.frames = this.frames.slice(0, this.cursor + 1);
      this.actions = this.actions.slice(0, this.cursor);
      this.frames.push({ state: result.state, variables: result.variables });
      this.actions.push(action);
      this.cursor += 1;
    }
    return result.outcome;
  }

  undo(): boolean {
    if (!this.canUndo) return false;
    this.cursor -= 1;
    return true;
  }

  redo(): boolean {
    if (!this.canRedo) return false;
    this.cursor += 1;
    return true;
  }

  /** Rebuild a match from a replay log; throws if any action is no longer accepted by the rules. */
  static replay(program: RuleProgram, actions: MatchAction[]): OwareMatch {
    const match = new OwareMatch(program);
    actions.forEach((action, i) => {
      const outcome = action.type === "move" ? match.play(action.pit) : action.type === "agree" ? match.agreeToEnd() : match.resign(action.player);
      if (!outcome.accepted) throw new Error(`Replay diverged at action ${i + 1}: ${outcome.rejection ?? outcome.error?.message ?? "rejected"}`);
    });
    return match;
  }
}
