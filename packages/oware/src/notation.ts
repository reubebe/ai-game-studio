import { opponent, owner, PITS_PER_SIDE, type OwareEvent, type OwareState, type Player } from "./engine";

/**
 * Pit names as in the sources' diagrams (Wikipedia's worked example, Aualé): South's pits are A-F and
 * North's are a-f, each from that player's left, so a sowing from South's F continues into North's a.
 */
export function pitLabel(pit: number): string {
  const side = owner(pit);
  const i = pit - side * PITS_PER_SIDE;
  return side === 0 ? String.fromCharCode(65 + i) : String.fromCharCode(97 + i);
}

export function parsePitLabel(label: string): number | null {
  if (!/^[a-fA-F]$/.test(label)) return null;
  const code = label.charCodeAt(0);
  return code >= 97 ? PITS_PER_SIDE + (code - 97) : code - 65;
}

export function playerName(player: Player): string {
  return player === 0 ? "South" : "North";
}

function list(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** What a move (or an agreement) did, in a line for the players. */
export function describeEvents(events: OwareEvent[]): string {
  const parts: string[] = [];
  const roundOver = events.some((e) => e.type === "round");
  for (const e of events) {
    if (e.type === "sow") {
      const relays = (e.steps ?? []).slice(1).filter((step) => step.kind === "lift").map((step) => pitLabel(step.pit));
      parts.push(`${playerName(e.player)} sowed ${e.seeds} from ${pitLabel(e.pit)}${relays.length ? `, lifting again from ${list(relays)}` : ""}`);
    }
    // Only worth saying when it explains why nothing was captured; otherwise the capture says what was taken.
    if (e.type === "grand-slam" && e.policy === "no-capture") parts.push(`that would have taken every seed ${playerName(opponent(e.player))} had (a grand slam), so nothing was captured`);
    if (e.type === "capture") parts.push(e.whileSowing ? `${playerName(e.player)} took ${e.seeds} from ${list(e.pits.map(pitLabel))}` : `captured ${e.seeds} (${e.pits.map(pitLabel).join(", ")})`);
    if (e.type === "last-seeds") parts.push(`${playerName(e.player)} also took the last ${e.seeds}`);
    if (e.type === "pass") parts.push(`${playerName(e.player)} has no seeds, so ${playerName(opponent(e.player))} plays again`);
    if (e.type === "sweep" && roundOver) parts.push(`each player took the seeds in their own houses (South ${e.seeds[0]}, North ${e.seeds[1]})`);
    if (e.type === "round") {
      const [south, north] = e.houses;
      const filled = `South fills ${south} ${south === 1 ? "house" : "houses"}, North ${north}`;
      const verdict = south === north ? "an even round" : `${playerName(south > north ? 0 : 1)} wins the round`;
      parts.push(`round ${e.round} over, South ${e.seeds[0]} seeds to North's ${e.seeds[1]}: ${filled}, ${verdict}${e.next ? `; ${playerName(e.next.starter)} starts round ${e.round + 1}` : ""}`);
    }
  }
  return parts.join(" · ");
}

/**
 * How the game ended, in words, or undefined while it is being played. `swept` is the sweep event's
 * seeds (South, North) when known: it tells apart a player who had no seeds from one who could not feed.
 */
export function resultSentence(state: OwareState, swept?: readonly [number, number]): string | undefined {
  if (state.status !== "finished" || !state.result) return undefined;
  const [south, north] = state.scores;
  const { winner, reason } = state.result;
  const score = winner === null ? `a draw, ${south} seeds each` : `${playerName(winner)} wins ${Math.max(south, north)} to ${Math.min(south, north)}`;
  const outcome = score.charAt(0).toUpperCase() + score.slice(1);
  switch (reason) {
    case "majority":
      return `${outcome}.`;
    case "draw":
      return `${outcome}.`;
    case "no-legal-move": {
      // The turn was not passed, so the player who could not move is the one after the last mover.
      const mover = state.toMove;
      const stuck = opponent(mover);
      const why =
        swept && swept[mover] === 0 && swept[stuck] > 0
          ? `${playerName(mover)} had no seeds and ${playerName(stuck)} could not give them any`
          : swept && swept[stuck] === 0
            ? `${playerName(stuck)} had no seeds to sow`
            : `${playerName(stuck)} had no legal move`;
      return `${why}, so each player took the seeds on their own side. ${outcome}.`;
    }
    case "repetition":
      return `The same position kept coming back, so each player took the seeds on their own side. ${outcome}.`;
    case "agreement":
      return `Ended by agreement: each player took the seeds on their own side. ${outcome}.`;
    case "resignation":
      return winner === null ? "The game ended." : `${playerName(opponent(winner))} resigned, so ${playerName(winner)} wins.`;
    case "territory": {
      const rounds = state.history?.length ?? 1;
      if (winner === null) return `The game is over after ${rounds} ${rounds === 1 ? "round" : "rounds"}.`;
      return `${playerName(opponent(winner))} has no houses left, so ${playerName(winner)} wins the game after ${rounds} ${rounds === 1 ? "round" : "rounds"}.`;
    }
  }
}
