import { describe, expect, it } from "vitest";
import { coreDomain, createRegistry, compileOrThrow } from "@gamestudio/rules-core";
import { ABAPA, applyMove, legalMoves, type OwareState, type Player } from "./engine";
import { owareDomain } from "./domain";
import { abapaGraph } from "./presets";
import { OwareMatch } from "./match";
import { position, rng } from "./test-helpers";

/**
 * A second Abapa implementation, written straight from the sources' sentences and sharing no code with
 * the engine, compared with the engine and the compiled rule graph on whole games and random positions.
 * It uses Aualé's form of the feeding rule ("a move that would leave all the holes empty on the
 * opponent's side is not legal") where the engine uses Wikipedia's ("If an opponent's houses are all
 * empty, the current player must make a move that gives the opponent seeds"), so agreement also shows
 * the two forms play the same game. Houses 0-5 are South's and 6-11 North's, in sowing order.
 */
namespace Independent {
  export interface Game { pits: number[]; scores: [number, number]; toMove: Player; over: boolean; winner: Player | null }
  const houses = (p: Player) => (p === 0 ? [0, 1, 2, 3, 4, 5] : [6, 7, 8, 9, 10, 11]);
  const onSide = (pits: number[], p: Player) => houses(p).reduce((n, h) => n + pits[h]!, 0);

  /** Sow, then capture; returns the board and what the mover captured. */
  function move(pits: number[], mover: Player, house: number): { pits: number[]; captured: number } {
    const next = [...pits];
    let seeds = next[house]!;
    next[house] = 0;
    let at = house;
    // "dropping one in each house counter-clockwise ... nor into the house drawn from"
    while (seeds > 0) {
      at = (at + 1) % 12;
      if (at === house) continue;
      next[at]! += 1;
      seeds -= 1;
    }
    // "brings the count of an opponent's house to exactly two or three with the final seed ... If the
    // previous-to-last seed also brought an opponent's house to two or three, these are captured as well"
    const theirs = houses(mover === 0 ? 1 : 0);
    const taken: number[] = [];
    for (let h = at; theirs.includes(h) && (next[h] === 2 || next[h] === 3); h -= 1) taken.push(h);
    const captured = taken.reduce((n, h) => n + next[h]!, 0);
    // "if a move would capture all of an opponent's seeds, the capture is forfeited"
    if (taken.length === 0 || captured === onSide(next, mover === 0 ? 1 : 0)) return { pits: next, captured: 0 };
    for (const h of taken) next[h] = 0;
    return { pits: next, captured };
  }

  export function legal(g: Game): number[] {
    return houses(g.toMove).filter((h) => g.pits[h]! > 0 && onSide(move(g.pits, g.toMove, h).pits, g.toMove === 0 ? 1 : 0) > 0);
  }

  export function play(g: Game, house: number): Game {
    const r = move(g.pits, g.toMove, house);
    const scores: [number, number] = [...g.scores];
    scores[g.toMove] += r.captured;
    const next: Game = { pits: r.pits, scores, toMove: g.toMove === 0 ? 1 : 0, over: false, winner: null };
    // "The game is over when one player has captured 25 or more seeds, or each player has taken 24 seeds"
    if (Math.max(...scores) >= 25 || (scores[0] === 24 && scores[1] === 24)) return finish(next);
    // "a player cannot make any legal move on his turn, in such a case, each player captures the remaining seeds on their side"
    if (legal(next).length === 0) {
      next.scores = [scores[0] + onSide(r.pits, 0), scores[1] + onSide(r.pits, 1)];
      next.pits = new Array<number>(12).fill(0);
      return finish(next);
    }
    return next;
  }

  function finish(g: Game): Game {
    return { ...g, over: true, winner: g.scores[0] > g.scores[1] ? 0 : g.scores[1] > g.scores[0] ? 1 : null };
  }
}

const program = compileOrThrow(abapaGraph(), createRegistry([coreDomain, owareDomain]));

/** The engine and the rule graph against the independent implementation, for every house of the player to move. */
function compare(g: Independent.Game): void {
  const state: OwareState = position([...g.pits], g.toMove, [...g.scores] as [number, number]);
  const allowed = Independent.legal(g);
  expect(legalMoves(state, ABAPA), JSON.stringify(g)).toEqual(allowed);
  for (const house of g.toMove === 0 ? [0, 1, 2, 3, 4, 5] : [6, 7, 8, 9, 10, 11]) {
    const engine = applyMove(state, house, ABAPA);
    const match = OwareMatch.fromState(program, state);
    const graph = match.play(house);
    const where = `house ${house} in ${JSON.stringify(g)}`;
    expect(engine.legal, where).toBe(allowed.includes(house));
    expect(graph.accepted, where).toBe(allowed.includes(house));
    if (!allowed.includes(house)) continue;
    const want = Independent.play(g, house);
    for (const got of [engine.state, match.state]) {
      expect({ pits: got.pits, scores: got.scores, over: got.status === "finished", winner: got.result?.winner ?? null, toMove: want.over ? want.toMove : got.toMove }, where).toEqual({
        pits: want.pits,
        scores: want.scores,
        over: want.over,
        winner: want.winner,
        toMove: want.toMove,
      });
    }
  }
}

describe("Abapa checked against an independent implementation of the sources", () => {
  it("agrees on whole games from the opening", () => {
    const random = rng(2026);
    for (let game = 0; game < 40; game++) {
      let g: Independent.Game = { pits: new Array<number>(12).fill(4), scores: [0, 0], toMove: 0, over: false, winner: null };
      for (let ply = 0; ply < 200 && !g.over; ply++) {
        compare(g);
        const moves = Independent.legal(g);
        g = Independent.play(g, moves[Math.floor(random() * moves.length)]!);
      }
    }
  });

  it("agrees on random positions: big handfuls, nearly empty sides, grand slams, feeding and endings", () => {
    const random = rng(1121);
    let checked = 0;
    while (checked < 1500) {
      const onBoard = 1 + Math.floor(random() * 48);
      const weights = Array.from({ length: 12 }, () => random() ** 3);
      const total = weights.reduce((a, b) => a + b, 0);
      const pits = new Array<number>(12).fill(0);
      for (let i = 0; i < onBoard; i++) {
        let r = random() * total;
        let h = 0;
        while (h < 11 && r >= weights[h]!) r -= weights[h++]!;
        pits[h]! += 1;
      }
      const rest = 48 - onBoard;
      const south = Math.max(0, rest - 24) + Math.floor(random() * (Math.min(24, rest) - Math.max(0, rest - 24) + 1));
      const scores: [number, number] = [south, rest - south];
      if (Math.max(...scores) >= 25 || (scores[0] === 24 && scores[1] === 24)) continue;
      compare({ pits, scores, toMove: random() < 0.5 ? 0 : 1, over: false, winner: null });
      checked += 1;
    }
  });
});
