import type { Scalar } from "@gamestudio/rules-core";
import { checkMove, opponent, ownedPits, positionKey, type OwareState, type Player } from "./engine";
import type { OwareMatch } from "./match";

export interface AiChoice {
  pit: number;
  score: number;
  /** Positions examined. */
  nodes: number;
}

const WIN = 1000;

/**
 * Deterministic minimax with alpha-beta pruning. Every simulated move runs through the
 * match's compiled rule graph, so custom rules (for example an extra turn) are respected.
 * Ties go to the lowest pit index, so the same position always produces the same move.
 */
export function chooseMove(match: OwareMatch, depth = 4, nodeBudget = 40000): AiChoice | null {
  const root = match.state;
  if (root.status !== "playing") return null;
  const me: Player = root.toMove;
  let nodes = 0;

  const candidates = (state: OwareState) => ownedPits(state, state.toMove).filter((p) => checkMove(state, p, match.config).legal);
  // With rounds, each house is worth a house's seeds: winning a round 28 to 20 gives 7 houses to 5.
  const perHouse = match.config.rounds ? match.config.seedsPerPit : 0;

  const evaluate = (state: OwareState, ply: number): number => {
    if (state.status === "finished") {
      const w = state.result?.winner;
      if (w === me) return WIN - ply;
      if (w === opponent(me)) return -WIN + ply;
      return 0;
    }
    const houses = perHouse ? perHouse * (ownedPits(state, me).length - ownedPits(state, opponent(me)).length) : 0;
    return state.scores[me] - state.scores[opponent(me)] + houses;
  };

  const search = (state: OwareState, vars: Record<string, Scalar>, d: number, ply: number, alpha: number, beta: number): number => {
    nodes += 1;
    if (d === 0 || state.status !== "playing" || nodes > nodeBudget) return evaluate(state, ply);
    const moves = candidates(state);
    if (moves.length === 0) return evaluate(state, ply);
    const maximizing = state.toMove === me;
    let best = maximizing ? -Infinity : Infinity;
    for (const pit of moves) {
      const sim = match.simulate(state, vars, { type: "move", pit });
      if (!sim.outcome.accepted) continue;
      const value = search(sim.state, sim.variables, d - 1, ply + 1, alpha, beta);
      if (maximizing) {
        best = Math.max(best, value);
        alpha = Math.max(alpha, value);
      } else {
        best = Math.min(best, value);
        beta = Math.min(beta, value);
      }
      if (beta <= alpha) break;
    }
    return best === Infinity || best === -Infinity ? evaluate(state, ply) : best;
  };

  let choice: AiChoice | null = null;
  const vars = match.variables;
  for (const pit of candidates(root)) {
    const sim = match.simulate(root, vars, { type: "move", pit });
    if (!sim.outcome.accepted) continue;
    const value = search(sim.state, sim.variables, depth - 1, 1, -Infinity, Infinity);
    if (!choice || value > choice.score) choice = { pit, score: value, nodes: 0 };
  }
  if (choice) choice.nodes = nodes;
  return choice;
}

/**
 * Whether the computer accepts an offer to end the game by agreement. The rules allow that only when
 * both players agree the game has been reduced to an endless cycle, so the computer agrees once the
 * position it is asked about (every pit, with the same player to move) has come up before in this game.
 * A position can only come back when nothing was captured in between, since captured seeds leave the
 * board for good.
 */
export function computerAgrees(state: OwareState): boolean {
  return state.status === "playing" && (state.positions[positionKey(state.pits, state.toMove)] ?? 0) >= 2;
}
