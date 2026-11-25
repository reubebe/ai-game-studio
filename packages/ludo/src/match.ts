import { RuleRuntime, type RuleProgram, type Scalar } from "@gamestudio/rules-core";
import { createInitialState, legalTokens, type LudoConfig, type LudoEvent, type LudoState } from "./engine";
import { LudoHost } from "./host";

export type LudoAction = { type: "roll" } | { type: "move"; token: number } | { type: "end" };

/** A replay log as a short string: "r" a roll, "0"-"3" a token moved, "x" the players ending the game. */
export function encodeLudoLog(actions: readonly LudoAction[]): string {
  return actions.map((a) => (a.type === "roll" ? "r" : a.type === "end" ? "x" : String(a.token))).join("");
}

/** Reads a log written by encodeLudoLog; null if any character is not an action. */
export function decodeLudoLog(text: string): LudoAction[] | null {
  const out: LudoAction[] = [];
  for (const c of text) {
    if (c === "r") out.push({ type: "roll" });
    else if (c === "x") out.push({ type: "end" });
    else if (/^[0-3]$/.test(c)) out.push({ type: "move", token: Number(c) });
    else return null;
  }
  return out;
}

export interface LudoOutcome {
  accepted: boolean;
  /** Present when the rules rejected the action. */
  rejection?: string;
  /** Present when the rule graph failed at runtime; the state did not change. */
  error?: { message: string; node?: string };
  events: LudoEvent[];
  messages: string[];
  trace: string[];
}

interface Frame {
  state: LudoState;
  variables: Record<string, Scalar>;
}

/** Plays Ludo by running a compiled rule graph; keeps undo/redo history and an exact replay log (seed + actions). */
export class LudoMatch {
  readonly config: LudoConfig;
  private readonly runtime: RuleRuntime;
  private frames: Frame[];
  private actions: LudoAction[] = [];
  private cursor = 0;

  constructor(readonly program: RuleProgram, players: number, seed: number) {
    if (program.domain !== "ludo") throw new Error(`Expected a Ludo rule program, got domain '${program.domain}'`);
    this.config = program.domainConfig as unknown as LudoConfig;
    this.runtime = new RuleRuntime(program);
    this.frames = [{ state: createInitialState(this.config, players, seed), variables: { ...this.runtime.variables } }];
  }

  get state(): LudoState {
    return this.frames[this.cursor]!.state;
  }

  get variables(): Record<string, Scalar> {
    return { ...this.frames[this.cursor]!.variables };
  }

  get log(): LudoAction[] {
    return this.actions.slice(0, this.cursor);
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.actions.length;
  }

  /** Tokens the guard would accept, for highlighting. The graph still decides when a move is played. */
  legalMoves(): number[] {
    return legalTokens(this.state, this.config);
  }

  roll(): LudoOutcome {
    return this.apply({ type: "roll" });
  }

  move(token: number): LudoOutcome {
    return this.apply({ type: "move", token });
  }

  /** The players stop the game before anyone has won: it ends with no winner. Kept in the history, so Undo takes it back. */
  endGame(): LudoOutcome {
    return this.apply({ type: "end" });
  }

  /** Apply without touching history: used by the computer players. */
  simulate(state: LudoState, variables: Record<string, Scalar>, action: LudoAction): { outcome: LudoOutcome; state: LudoState; variables: Record<string, Scalar> } {
    if (action.type === "end") {
      // Not a rule of play, so no rule graph runs.
      return { outcome: { accepted: true, events: [], messages: [], trace: [] }, state: { ...state, dice: null, status: "finished", winner: null }, variables };
    }
    const host = new LudoHost(this.config, state);
    this.runtime.reset();
    this.runtime.setVariables(variables);
    const run = action.type === "roll" ? this.runtime.run("roll", { player: state.toMove }, host) : this.runtime.run("move", { token: action.token, player: state.toMove }, host);
    const outcome: LudoOutcome = { accepted: false, events: host.events, messages: host.messages, trace: run.trace };
    if (run.error) outcome.error = run.error;
    else if (!run.handled) outcome.rejection = action.type === "roll" ? "These rules have no 'On Roll' event." : "These rules have no 'On Token Chosen' event.";
    else if (host.rejected !== null) outcome.rejection = host.rejected;
    else if (host.state === state && host.events.length === 0) outcome.rejection = "The rules did not change the game.";
    else outcome.accepted = true;
    return outcome.accepted ? { outcome, state: host.state, variables: { ...this.runtime.variables } } : { outcome, state, variables };
  }

  private apply(action: LudoAction): LudoOutcome {
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

  /** Rebuild a match from its seed and replay log; throws if any action is no longer accepted by the rules. */
  static replay(program: RuleProgram, players: number, seed: number, actions: LudoAction[]): LudoMatch {
    const match = new LudoMatch(program, players, seed);
    actions.forEach((action, i) => {
      const outcome = action.type === "roll" ? match.roll() : action.type === "end" ? match.endGame() : match.move(action.token);
      if (!outcome.accepted) throw new Error(`Replay diverged at action ${i + 1}: ${outcome.rejection ?? outcome.error?.message ?? "rejected"}`);
    });
    return match;
  }
}
