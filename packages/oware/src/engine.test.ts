import { describe, expect, it } from "vitest";
import {
  ABAPA,
  applyMove,
  checkMove,
  checkTermination,
  createInitialState,
  endByAgreement,
  legalMoves,
  positionKey,
  seedCount,
  sowPits,
  winThreshold,
  type OwareConfig,
  type OwareState,
} from "./engine";
import { parsePitLabel, pitLabel } from "./notation";
import { pick, position, rng } from "./test-helpers";

const variant = (patch: Partial<OwareConfig>): OwareConfig => ({ ...ABAPA, ...patch });

describe("Abapa setup", () => {
  it("starts with four seeds in each of twelve pits and South to move", () => {
    const s = createInitialState();
    expect(s.pits).toEqual(new Array(12).fill(4));
    expect(seedCount(s)).toBe(48);
    expect(s.toMove).toBe(0);
    expect(s.scores).toEqual([0, 0]);
  });

  it("lets South choose any of its six pits first", () => {
    expect(legalMoves(createInitialState(), ABAPA)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("needs a majority of 25 of 48 seeds to win", () => {
    expect(winThreshold(ABAPA)).toBe(25);
  });
});

describe("move legality", () => {
  it("rejects pits on the opponent's side without changing the state", () => {
    const s = createInitialState();
    const r = applyMove(s, 7, ABAPA);
    expect(r.legal).toBe(false);
    expect(r.reason).toBe("not-your-pit");
    expect(r.state).toBe(s);
    expect(r.events).toEqual([]);
  });

  it("rejects empty pits", () => {
    const s = position([0, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4], 0, [2, 2]);
    expect(applyMove(s, 0, ABAPA)).toMatchObject({ legal: false, reason: "empty-pit" });
  });

  it("rejects numbers that are not pits", () => {
    const s = createInitialState();
    expect(checkMove(s, 12, ABAPA)).toEqual({ legal: false, reason: "not-a-pit" });
    expect(checkMove(s, -1, ABAPA)).toEqual({ legal: false, reason: "not-a-pit" });
    expect(checkMove(s, 1.5, ABAPA)).toEqual({ legal: false, reason: "not-a-pit" });
  });

  it("refuses every move once the game is over", () => {
    const over: OwareState = { ...createInitialState(), status: "finished", result: { winner: 0, reason: "majority" } };
    expect(applyMove(over, 0, ABAPA)).toMatchObject({ legal: false, reason: "game-over" });
    expect(legalMoves(over, ABAPA)).toEqual([]);
  });
});

describe("sowing", () => {
  it("drops one seed in each following pit counter-clockwise", () => {
    const r = applyMove(createInitialState(), 0, ABAPA);
    expect(r.state.pits).toEqual([0, 5, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4]);
    expect(r.events[0]).toEqual({ type: "sow", player: 0, pit: 0, seeds: 4, path: [1, 2, 3, 4] });
  });

  it("continues from North's last pit into South's first pit", () => {
    const s = { ...createInitialState(), toMove: 1 as const };
    const r = applyMove(s, 10, ABAPA);
    expect(r.state.pits).toEqual([5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 0, 5]);
  });

  it("passes the turn after an ordinary move", () => {
    const r = applyMove(createInitialState(), 2, ABAPA);
    expect(r.state.toMove).toBe(1);
    expect(r.events.at(-1)).toEqual({ type: "turn", player: 1 });
  });

  it("skips the starting pit when sowing twelve or more seeds", () => {
    const s = position([12, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 3], 0, [9, 9]);
    const r = applyMove(s, 0, ABAPA);
    expect(r.state.pits).toEqual([0, 2, 1, 1, 1, 1, 4, 4, 4, 4, 4, 4]);
  });

  it("can sow into the starting pit when the skip rule is turned off", () => {
    expect(sowPits([12, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 3], 0, false)).toMatchObject({ lastPit: 0, pits: [1, 1, 1, 1, 1, 1, 4, 4, 4, 4, 4, 4] });
  });

  it("skips the starting pit on every lap", () => {
    const r = sowPits([23, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0, true);
    expect(r.pits).toEqual([0, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    expect(r.lastPit).toBe(1);
  });
});

describe("captures", () => {
  it("captures an opponent pit brought to exactly two", () => {
    const s = position([0, 0, 0, 0, 0, 1, 1, 4, 4, 4, 4, 4], 0, [13, 13]);
    const r = applyMove(s, 5, ABAPA);
    expect(r.state.pits[6]).toBe(0);
    expect(r.state.scores).toEqual([15, 13]);
    expect(r.events).toContainEqual({ type: "capture", player: 0, pits: [6], seeds: 2 });
  });

  it("captures an opponent pit brought to exactly three", () => {
    const s = position([0, 0, 0, 0, 0, 1, 2, 4, 4, 4, 4, 4], 0, [12, 13]);
    expect(applyMove(s, 5, ABAPA).state.scores).toEqual([15, 13]);
  });

  it("does not capture a pit brought to four", () => {
    const s = position([0, 0, 0, 0, 0, 1, 3, 4, 4, 4, 4, 4], 0, [12, 12]);
    const r = applyMove(s, 5, ABAPA);
    expect(r.state.pits[6]).toBe(4);
    expect(r.state.scores).toEqual([12, 12]);
  });

  it("does not capture a pit brought to one", () => {
    const s = position([0, 0, 0, 0, 0, 1, 0, 4, 4, 4, 4, 4], 0, [13, 14]);
    expect(applyMove(s, 5, ABAPA).state.scores).toEqual([13, 14]);
  });

  it("never captures on the mover's own side", () => {
    const s = position([1, 1, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4], 0, [3, 3]);
    const r = applyMove(s, 0, ABAPA);
    expect(r.state.pits[1]).toBe(2);
    expect(r.state.scores).toEqual([3, 3]);
  });

  it("chains backwards through preceding opponent pits of two or three", () => {
    const s = position([0, 0, 0, 0, 0, 3, 1, 2, 1, 4, 0, 0], 0, [18, 19]);
    const r = applyMove(s, 5, ABAPA);
    expect(r.events).toContainEqual({ type: "capture", player: 0, pits: [8, 7, 6], seeds: 7 });
    expect(r.state.pits).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0]);
    expect(r.state.scores).toEqual([25, 19]);
  });

  it("stops the chain at a pit that does not hold two or three", () => {
    const s = position([0, 0, 0, 0, 0, 3, 3, 2, 1, 4, 0, 0], 0, [17, 18]);
    const r = applyMove(s, 5, ABAPA);
    expect(r.events).toContainEqual({ type: "capture", player: 0, pits: [8, 7], seeds: 5 });
    expect(r.state.pits[6]).toBe(4);
  });

  it("stops the chain at the edge of the opponent's side", () => {
    // North sows two seeds from pit 10: pit 11 (North's own) becomes 2 and South's pit 0 becomes 2.
    const s = position([1, 4, 4, 4, 2, 2, 0, 0, 0, 0, 2, 1], 1, [14, 14]);
    const r = applyMove(s, 10, ABAPA);
    expect(r.events).toContainEqual({ type: "capture", player: 1, pits: [0], seeds: 2 });
    expect(r.state.pits[11]).toBe(2);
    expect(r.state.scores).toEqual([14, 16]);
  });

  it("captures only the last pit when chaining is off", () => {
    const s = position([0, 0, 0, 0, 0, 3, 1, 2, 1, 4, 0, 0], 0, [18, 19]);
    const r = applyMove(s, 5, variant({ captureChain: false }));
    expect(r.events).toContainEqual({ type: "capture", player: 0, pits: [8], seeds: 2 });
  });

  it("supports other capture counts when a variant asks for them", () => {
    const s = position([0, 0, 0, 0, 0, 1, 3, 4, 4, 4, 4, 4], 0, [12, 12]);
    expect(applyMove(s, 5, variant({ captureCounts: [2, 3, 4] })).state.scores).toEqual([16, 12]);
  });

  it("captures after a lap of twelve or more seeds", () => {
    const s = position([17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0, [15, 16]);
    const r = applyMove(s, 0, ABAPA);
    expect(r.state.pits).toEqual([0, 2, 2, 2, 2, 2, 0, 1, 1, 1, 1, 1]);
    expect(r.state.scores).toEqual([17, 16]);
  });
});

describe("grand slam", () => {
  const slam = () => position([10, 0, 0, 0, 0, 2, 1, 1, 0, 0, 0, 0], 0, [17, 17]);

  it("Abapa forfeits a capture that would take every opponent seed", () => {
    const r = applyMove(slam(), 5, ABAPA);
    expect(r.legal).toBe(true);
    expect(r.state.pits.slice(6)).toEqual([2, 2, 0, 0, 0, 0]);
    expect(r.state.scores).toEqual([17, 17]);
    expect(r.events).toContainEqual({ type: "grand-slam", player: 0, policy: "no-capture", pits: [7, 6] });
  });

  it("is an illegal move when the variant forbids grand slams", () => {
    const s = slam();
    const r = applyMove(s, 5, variant({ grandSlam: "forbidden" }));
    expect(r).toMatchObject({ legal: false, reason: "grand-slam-forbidden" });
    expect(r.state).toBe(s);
  });

  it("captures everything when the variant allows it, then ends because North cannot move", () => {
    const r = applyMove(slam(), 5, variant({ grandSlam: "capture-all" }));
    expect(r.state.status).toBe("finished");
    expect(r.state.scores).toEqual([31, 17]);
    expect(r.state.result).toEqual({ winner: 0, reason: "no-legal-move" });
  });
});

describe("feeding and the end of the game", () => {
  it("requires a move that gives seeds to an opponent with none", () => {
    const s = position([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0], 0, [23, 23]);
    expect(checkMove(s, 0, ABAPA)).toEqual({ legal: false, reason: "must-feed" });
    expect(legalMoves(s, ABAPA)).toEqual([5]);
  });

  it("allows non-feeding moves when the feeding rule is off", () => {
    const s = position([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0], 0, [23, 23]);
    expect(legalMoves(s, variant({ mustFeed: false }))).toEqual([0, 5]);
  });

  it("ends the game when the next player cannot feed, giving each player their own seeds", () => {
    const s = position([0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 1, [22, 22]);
    const r = applyMove(s, 11, ABAPA);
    expect(r.state.status).toBe("finished");
    expect(r.state.scores).toEqual([26, 22]);
    expect(r.state.result).toEqual({ winner: 0, reason: "no-legal-move" });
    expect(r.events).toContainEqual({ type: "sweep", seeds: [4, 0] });
  });

  it("is a draw when the final sweep leaves 24 each", () => {
    const s = position([0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 1, [20, 24]);
    expect(applyMove(s, 11, ABAPA).state.result).toEqual({ winner: null, reason: "no-legal-move" });
  });

  it("is won by the first player to capture 25 seeds", () => {
    const s = position([2, 0, 0, 0, 0, 1, 1, 4, 0, 0, 0, 0], 0, [23, 17]);
    const r = applyMove(s, 5, ABAPA);
    expect(r.state.scores[0]).toBe(25);
    expect(r.state.result).toEqual({ winner: 0, reason: "majority" });
    expect(r.events.at(-1)).toMatchObject({ type: "end" });
  });

  it("is a draw at 24 each when every seed has been captured", () => {
    const s = position([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0], 0, [22, 24]);
    const r = applyMove(s, 5, variant({ grandSlam: "capture-all" }));
    expect(r.state.scores).toEqual([24, 24]);
    expect(r.state.result).toEqual({ winner: null, reason: "draw" });
  });

  it("ends by agreement with each player taking their own side", () => {
    const s = position([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], 0, [22, 23]);
    const r = endByAgreement(s);
    expect(r.state.scores).toEqual([23, 25]);
    expect(r.state.result).toEqual({ winner: 1, reason: "agreement" });
  });

  it("can end on a repeated position when the optional studio rule is on", () => {
    const base = position([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 0, [23, 23]);
    const after = [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    const s: OwareState = { ...base, positions: { ...base.positions, [positionKey(after, 1)]: 2 } };
    const cfg = variant({ repetitionLimit: 3, mustFeed: false });
    expect(checkTermination({ ...s, pits: after }, cfg)).toEqual({ outcome: "cycle" });
    const r = applyMove(s, 0, cfg);
    expect(r.state.result).toEqual({ winner: null, reason: "repetition" });
    expect(r.state.scores).toEqual([24, 24]);
  });
});

describe("invariants over random games", () => {
  const configs: [string, OwareConfig][] = [
    ["Abapa", ABAPA],
    ["capture-all", variant({ grandSlam: "capture-all" })],
    ["forbidden", variant({ grandSlam: "forbidden" })],
    ["no skip, chain off", variant({ skipOrigin: false, captureChain: false })],
  ];
  for (const [name, cfg] of configs) {
    it(`conserves seeds, keeps counts non-negative and alternates turns (${name})`, () => {
      const random = rng(42);
      for (let game = 0; game < 120; game++) {
        let s = createInitialState(cfg);
        for (let ply = 0; ply < 300 && s.status === "playing"; ply++) {
          const moves = legalMoves(s, cfg);
          expect(moves.length).toBeGreaterThan(0);
          for (const m of moves) {
            expect((s.pits[m] ?? 0) > 0).toBe(true);
            expect(Math.floor(m / 6)).toBe(s.toMove);
          }
          const mover = s.toMove;
          const r = applyMove(s, pick(moves, random), cfg);
          expect(r.legal).toBe(true);
          s = r.state;
          expect(seedCount(s)).toBe(48);
          expect(s.pits.every((n) => n >= 0 && Number.isInteger(n))).toBe(true);
          if (s.status === "playing") expect(s.toMove).toBe(mover === 0 ? 1 : 0);
        }
      }
    });
  }

  it("replays a move log to the identical final position", () => {
    const random = rng(7);
    let s = createInitialState();
    const log: number[] = [];
    while (s.status === "playing" && log.length < 400) {
      const m = pick(legalMoves(s, ABAPA), random);
      log.push(m);
      s = applyMove(s, m, ABAPA).state;
    }
    let replayed = createInitialState();
    for (const m of log) replayed = applyMove(replayed, m, ABAPA).state;
    expect(replayed).toEqual(s);
  });
});

describe("notation", () => {
  it("labels South's pits A-F and North's pits a-f, as the sources' diagrams do", () => {
    expect([0, 5, 6, 11].map(pitLabel)).toEqual(["A", "F", "a", "f"]);
    for (let p = 0; p < 12; p++) expect(parsePitLabel(pitLabel(p))).toBe(p);
    expect(parsePitLabel("g")).toBeNull();
  });
});
