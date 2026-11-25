import { HOME, isStartSquare, LAST_TRACK, squareOf, YARD, type LudoState } from "./engine";
import type { LudoMatch } from "./match";

export interface LudoChoice {
  token: number;
  score: number;
}

/**
 * The computer player's choice of token for the current roll. Every candidate move runs through the
 * match's compiled rule graph, so edited rules are respected. Scoring prefers, in order of weight:
 * finishing, capturing, leaving the yard, escaping danger and progress, and avoids stopping where an
 * opponent can reach it with one roll. Ties go to the lowest token, so the same position always gives the same move.
 */
export function chooseToken(match: LudoMatch): LudoChoice | null {
  const state = match.state;
  const me = state.toMove;
  let best: LudoChoice | null = null;
  for (const token of match.legalMoves()) {
    const sim = match.simulate(state, match.variables, { type: "move", token });
    if (!sim.outcome.accepted) continue;
    const before = state.tokens[me]![token]!;
    const after = sim.state.tokens[me]?.[token] ?? before;
    let score = after - Math.max(before, 0);
    if (sim.state.status === "finished") score += 10000;
    if (after === HOME) score += 400;
    if (before === YARD) score += 250;
    if (sim.outcome.events.some((e) => e.type === "capture")) score += 600;
    if (after > LAST_TRACK) score += 120;
    score -= 300 * danger(sim.state, me, token, match.config.safeStarts);
    score += 200 * danger(state, me, token, match.config.safeStarts);
    if (!best || score > best.score) best = { token, score };
  }
  return best;
}

/** 1 when an opponent token stands 1-6 squares behind this token on the main track (and it is not safe). */
function danger(state: LudoState, player: number, token: number, safeStarts: boolean): number {
  const square = squareOf(state.seats[player]!, state.tokens[player]![token]!);
  if (square === null || (safeStarts && isStartSquare(square))) return 0;
  for (let other = 0; other < state.seats.length; other++) {
    if (other === player) continue;
    for (const p of state.tokens[other]!) {
      const at = squareOf(state.seats[other]!, p);
      if (at === null) continue;
      const gap = (square - at + 52) % 52;
      if (gap >= 1 && gap <= 6 && p + gap <= LAST_TRACK) return 1;
    }
  }
  return 0;
}
