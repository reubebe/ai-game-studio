import { describe, expect, it } from "vitest";
import { coreDomain, createRegistry, compileOrThrow } from "@gamestudio/rules-core";
import { ABAPA, applyMove, endByAgreement, legalMoves, type MoveResult, type OwareState, type Player } from "./engine";
import { owareDomain } from "./domain";
import { abapaGraph } from "./presets";
import { OwareMatch } from "./match";
import { computerAgrees } from "./ai";
import { describeEvents, parsePitLabel, resultSentence } from "./notation";
import { position } from "./test-helpers";

// The sentences and worked examples of the two sources the Abapa ruleset cites, checked against the
// engine and against the game's own rule graph (the path Play uses):
//  - Wikipedia, "Oware", Rules (abapa), read again on 2026-11-21
//  - Joan Sala, Aualé, "How to Play Oware" (https://auale.joansala.com/en/how-to-play-oware/), read again on 2026-11-21
// Pit names follow the sources' diagrams: South's A-F and North's a-f, each from that player's left.

const registry = createRegistry([coreDomain, owareDomain]);
const program = compileOrThrow(abapaGraph(), registry);
const pit = (label: string) => parsePitLabel(label)!;

/** A position given as the sources draw it: South's A-F, North's a-f, captured seeds and who moves. */
function board(south: number[], north: number[], scores: [number, number], toMove: Player = 0): OwareState {
  return position([...south, ...north], toMove, scores);
}

/** Plays a move with the engine and through the compiled rule graph; both must give the same game. */
function play(state: OwareState, label: string): MoveResult {
  const r = applyMove(state, pit(label), ABAPA);
  const match = OwareMatch.fromState(program, state);
  const o = match.play(pit(label));
  expect(o.accepted, o.rejection ?? o.error?.message).toBe(r.legal);
  if (r.legal) {
    const { pits, scores, toMove, status, result } = match.state;
    expect({ pits, scores, toMove, status, result }).toEqual({ pits: r.state.pits, scores: r.state.scores, toMove: r.state.toMove, status: r.state.status, result: r.state.result });
  }
  return r;
}

describe("Abapa as the sources state it", () => {
  it("sows counter-clockwise, one seed per house, from South's row into North's a", () => {
    // Wikipedia: "dropping one in each house counter-clockwise from this house".
    const r = play(board([4, 4, 4, 4, 4, 4], [4, 4, 4, 4, 4, 4], [0, 0]), "C");
    expect(r.state.pits).toEqual([4, 4, 0, 5, 5, 5, 5, 4, 4, 4, 4, 4]);
  });

  it("skips the house a big handful came from and places the twelfth seed in the next house", () => {
    // Wikipedia: "if it contained 12 (or more) seeds, it is skipped, and the twelfth seed is placed in the next house."
    const r = play(board([12, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1], [15, 15]), "A");
    expect(r.state.pits).toEqual([0, 2, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    // Every North house now holds 2, but the last seed fell on South's own B, so nothing is captured.
    expect(r.state.scores).toEqual([15, 15]);
  });

  it("Wikipedia's example turn: sowing from E captures e, d and c but not b (four seeds) or a (not contiguous)", () => {
    // Before: South A-F 3 1 4 0 6 2; North a-f 1 3 2 1 2 2 (the article's first diagram).
    const r = play(board([3, 1, 4, 0, 6, 2], [1, 3, 2, 1, 2, 2], [10, 11]), "E");
    expect(r.events).toContainEqual({ type: "capture", player: 0, pits: [pit("e"), pit("d"), pit("c")], seeds: 8 });
    // After: South 3 1 4 0 0 3; North a 2, b 4 and f 2 stay (the article's second diagram, less the captured houses).
    expect(r.state.pits).toEqual([3, 1, 4, 0, 0, 3, 2, 4, 0, 0, 0, 2]);
    expect(r.state.scores).toEqual([18, 11]);
    expect(describeEvents(r.events)).toBe("South sowed 6 from E · captured 8 (e, d, c)");
  });

  it("Aualé's example: three seeds from F, and South captures 5 seeds from b and c", () => {
    // Aualé's picture: South's F holds 3; North's a, b and c hold 0, 2 and 1 (other houses filled in to make 48).
    const r = play(board([4, 4, 4, 4, 0, 3], [0, 2, 1, 4, 4, 4], [7, 7]), "F");
    expect(r.events).toContainEqual({ type: "capture", player: 0, pits: [pit("c"), pit("b")], seeds: 5 });
    expect(r.state.pits[pit("a")]).toBe(1);
  });

  it("captures only in the opponent's houses", () => {
    // Aualé: "players can only capture seeds from their opponents holes and never from their own holes."
    const r = play(board([0, 0, 0, 1, 1, 4], [4, 4, 4, 4, 4, 4], [9, 9]), "D");
    expect(r.state.pits[pit("E")]).toBe(2);
    expect(r.state.scores).toEqual([9, 9]);
  });

  it("forfeits a capture that would take every seed the opponent has", () => {
    // Wikipedia: "the capture is forfeited ... and the seeds are instead left on the board".
    // Aualé: "that player will sow normally but will not capture any seeds."
    const r = play(board([10, 0, 0, 0, 0, 2], [1, 1, 0, 0, 0, 0], [17, 17]), "F");
    expect(r.legal).toBe(true);
    expect(r.state.pits.slice(6)).toEqual([2, 2, 0, 0, 0, 0]);
    expect(r.state.scores).toEqual([17, 17]);
    expect(describeEvents(r.events)).toBe("South sowed 2 from F · that would have taken every seed North had (a grand slam), so nothing was captured");
  });

  it("makes a player give seeds to an opponent whose houses are all empty", () => {
    // Wikipedia: "If an opponent's houses are all empty, the current player must make a move that gives the opponent seeds."
    const s = board([1, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0], [23, 23]);
    expect(legalMoves(s, ABAPA)).toEqual([pit("F")]);
    expect(play(s, "A").legal).toBe(false);
  });

  it("ends the game when that is impossible, the player who cannot feed taking the seeds in their own territory", () => {
    // Wikipedia: "If no such move is possible, the current player captures all seeds in their own territory, ending the game."
    // North sows its last seed from f into South's A; South (A 1, B 3) cannot reach North's row.
    const r = play(board([0, 3, 0, 0, 0, 0], [0, 0, 0, 0, 0, 1], [22, 22], 1), "f");
    expect(r.state.status).toBe("finished");
    expect(r.state.scores).toEqual([26, 22]);
    expect(resultSentence(r.state, [4, 0])).toBe("North had no seeds and South could not give them any, so each player took the seeds on their own side. South wins 26 to 22.");
  });

  it("is won with 25 seeds, and 24 each is a draw", () => {
    // Wikipedia: "The game is over when one player has captured 25 or more seeds, or each player has taken 24 seeds (draw)."
    const won = play(board([2, 0, 0, 0, 0, 1], [1, 4, 0, 0, 0, 0], [23, 17]), "F");
    expect(won.state.result).toEqual({ winner: 0, reason: "majority" });
    expect(resultSentence(won.state)).toBe("South wins 25 to 17.");
  });

  it("ends an endless cycle by agreement, each player taking the seeds on their side; the computer agrees only once a position comes back", () => {
    // Wikipedia: "If both players agree that the game has been reduced to an endless cycle ... each player captures the seeds on their side of the board."
    // One seed each: these twelve moves (no captures) bring back the starting position, South to move.
    const start = board([1, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0], [23, 23]);
    const match = OwareMatch.fromState(program, start);
    expect(computerAgrees(match.state)).toBe(false);
    for (const label of ["A", "a", "B", "b", "C", "c", "D", "d", "E", "e", "F", "f"]) {
      expect(match.play(pit(label)).accepted, label).toBe(true);
      if (label !== "f") expect(computerAgrees(match.state), label).toBe(false);
    }
    expect(match.state.pits).toEqual(start.pits);
    expect(match.state.toMove).toBe(0);
    expect(computerAgrees(match.state)).toBe(true);
    const ended = endByAgreement(match.state);
    expect(ended.state.scores).toEqual([24, 24]);
    expect(resultSentence(ended.state)).toBe("Ended by agreement: each player took the seeds on their own side. A draw, 24 seeds each.");
    expect(match.agreeToEnd().accepted).toBe(true);
    expect(match.state.result).toEqual({ winner: null, reason: "agreement" });
  });
});
