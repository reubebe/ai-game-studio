import { describe, expect, it } from "vitest";
import { coreDomain, createRegistry, compileOrThrow, type RuleGraph } from "@gamestudio/rules-core";
import { applyMove, createInitialState, endByAgreement, legalMoves, NAMNAM, ownedPits, ownerAt, positionKey, type MoveResult, type OwareConfig, type OwareState, type Player } from "./engine";
import { owareDomain } from "./domain";
import { namnamGraph } from "./presets";
import { OwareMatch } from "./match";
import { chooseMove } from "./ai";
import { describeEvents, parsePitLabel, resultSentence } from "./notation";
import { pick, rng } from "./test-helpers";

// Nam-nam, checked rule by rule against oware.org's "Nam-Nam Rules" (the text the user supplied) and First
// Step Tours' video "Basic Oware Rules for Beginners". Each check runs on the engine and through the
// compiled rule graph. Pit names: South's A-F, North's a-f, each from that player's left.

const registry = createRegistry([coreDomain, owareDomain]);
const program = compileOrThrow(namnamGraph(), registry);
const winnerStarts = (() => {
  const g: RuleGraph = structuredClone(namnamGraph());
  g.nodes.find((n) => n.id === "newRound")!.params["starter"] = "winner";
  return compileOrThrow(g, registry);
})();
const pit = (label: string) => parsePitLabel(label)!;

/** A Nam-nam position: South's A-F, North's a-f, seeds captured this round, who moves, and who owns which house. */
function board(south: number[], north: number[], scores: [number, number], toMove: Player = 0, owners?: Player[]): OwareState {
  const pits = [...south, ...north];
  return { ...createInitialState(NAMNAM), pits, scores, toMove, owners: owners ?? createInitialState(NAMNAM).owners, positions: { [positionKey(pits, toMove)]: 1 } };
}

/** Plays a move with the engine and through the compiled rule graph; both must give the same game and events. */
function play(state: OwareState, label: string, config: OwareConfig = NAMNAM, compiled = program): MoveResult {
  const r = applyMove(state, pit(label), config);
  const match = OwareMatch.fromState(compiled, state);
  const o = match.play(pit(label));
  expect(o.accepted, o.rejection ?? o.error?.message).toBe(r.legal);
  if (r.legal) {
    expect(o.events).toEqual(r.events);
    expect(match.state).toEqual(r.state);
  }
  return r;
}

describe("Nam-nam as oware.org and the video state it", () => {
  it("starts each round with four seeds in every house, each row its player's territory", () => {
    // "Four seeds are placed in each house ... Each row of six houses is the territory of the player sitting nearest to them."
    const s = createInitialState(NAMNAM);
    expect(s.pits).toEqual(new Array(12).fill(4));
    expect(ownedPits(s, 0)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ownedPits(s, 1)).toEqual([6, 7, 8, 9, 10, 11]);
    expect(s.round).toBe(1);
    expect(program.domainConfig).toEqual({ ...NAMNAM });
  });

  it("scoops a house in your own territory and sows on from wherever the last seed lands in a house with seeds", () => {
    // "If the last seed drops in a house with seeds in it, all the seeds are scooped up and then sown until ones last seed lands in a house, which is empty."
    const r = play(board([2, 0, 1, 0, 0, 0], [5, 5, 5, 5, 5, 5], [8, 7]), "A");
    expect(r.state.pits).toEqual([0, 1, 0, 1, 1, 0, 5, 5, 5, 5, 5, 5]);
    expect(r.state.toMove).toBe(1);
    expect(describeEvents(r.events)).toBe("South sowed 2 from A, lifting again from C");
    expect(play(board([2, 0, 1, 0, 0, 0], [5, 5, 5, 5, 5, 5], [8, 7]), "a").reason).toBe("not-your-pit");
  });

  it("gives a four to the owner of the house, even in the other player's turn", () => {
    // "Seeds are captured when the sowing of seeds by either player creates four seeds on ones territory."
    // The video: "even if it is not during the turn" (3:14).
    const r = play(board([0, 0, 0, 0, 0, 3], [3, 0, 0, 9, 9, 9], [8, 7]), "F");
    expect(r.events).toContainEqual({ type: "capture", player: 1, pits: [pit("a")], seeds: 4, whileSowing: true });
    expect(r.state.scores).toEqual([8, 11]);
    expect(r.state.pits.slice(6)).toEqual([0, 1, 1, 9, 9, 9]);
    expect(describeEvents(r.events)).toBe("South sowed 3 from F · North took 4 from a");
  });

  it("gives the sower a four made by their last seed in the opponent's territory, and the turn ends", () => {
    // "One can only capture seeds on ones own territory, except when four seeds are made with ones last seed on the opponent's territory."
    const r = play(board([0, 0, 0, 0, 0, 1], [3, 9, 9, 9, 0, 0], [8, 9]), "F");
    expect(r.events).toContainEqual({ type: "capture", player: 0, pits: [pit("a")], seeds: 4 });
    expect(r.state.scores).toEqual([12, 9]);
    expect(r.state.toMove).toBe(1);
  });

  it("gives you a four your last seed makes in your own territory, and the turn ends", () => {
    const r = play(board([1, 3, 0, 0, 0, 0], [9, 9, 9, 9, 0, 0], [4, 4]), "A");
    expect(r.events).toContainEqual({ type: "capture", player: 0, pits: [pit("B")], seeds: 4, whileSowing: true });
    expect(r.state.scores).toEqual([8, 4]);
    expect(r.state.toMove).toBe(1);
  });

  it("makes you give seeds to a player who has none, and lets them pass", () => {
    // "If at any point in the game one player does not have any seeds, the other player must sow seeds from a house that would provide the opponent with seeds"
    const s = board([1, 0, 0, 0, 0, 2], [0, 0, 0, 0, 0, 0], [24, 21]);
    expect(legalMoves(s, NAMNAM)).toEqual([pit("F")]);
    expect(play(s, "A").reason).toBe("must-feed");
    // South's last seed makes four in North's only house: South takes it, North has no seeds, so South plays again and must feed North.
    const r = play(board([0, 5, 0, 0, 2, 1], [3, 0, 0, 0, 0, 0], [17, 20]), "F");
    expect(r.events).toContainEqual({ type: "pass", player: 1 });
    expect(r.state.toMove).toBe(0);
    expect(legalMoves(r.state, NAMNAM)).toEqual([pit("B"), pit("E")]);
    expect(describeEvents(r.events)).toBe("South sowed 1 from F · captured 4 (a) · North has no seeds, so South plays again");
  });

  it("ends the round when the seeds cannot be shared, each player taking the seeds in their territory", () => {
    // "If this is not possible then the game comes to an end, with the remaining seeds going the player who has the seeds on their territory."
    // North sows its last seed into South's A; South (A 1, B 1) cannot reach North's row.
    const r = play(board([0, 1, 0, 0, 0, 0], [0, 0, 0, 0, 0, 1], [24, 22], 1), "f");
    expect(r.events).toContainEqual({ type: "sweep", seeds: [2, 0] });
    expect(r.events).toContainEqual({ type: "round", round: 1, seeds: [26, 22], houses: [7, 5], next: { owners: [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1], starter: 1 } });
    expect(r.state.round).toBe(2);
  });

  it("gives whoever captures four of the last eight seeds the last four as well, ending the round", () => {
    // "When there are eight seeds left in play ... The player who captures the penultimate set of four seeds, also gains the last set of four on the board, this then ends the round."
    const r = play(board([0, 0, 0, 0, 0, 1], [3, 0, 2, 2, 0, 0], [20, 20]), "F");
    expect(r.events).toContainEqual({ type: "capture", player: 0, pits: [pit("a")], seeds: 4 });
    expect(r.events).toContainEqual({ type: "last-seeds", player: 0, seeds: 4 });
    expect(r.events).toContainEqual({ type: "round", round: 1, seeds: [28, 20], houses: [7, 5], next: { owners: [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1], starter: 1 } });
    // Even when the four is made in the middle of a sowing: here North takes a's four, and the rest (in South's hand too).
    const mid = play(board([0, 0, 0, 0, 0, 3], [3, 0, 2, 0, 0, 0], [20, 20]), "F");
    expect(mid.events).toContainEqual({ type: "capture", player: 1, pits: [pit("a")], seeds: 4, whileSowing: true });
    expect(mid.events).toContainEqual({ type: "last-seeds", player: 1, seeds: 4 });
    expect(mid.events.find((e) => e.type === "round")).toMatchObject({ seeds: [20, 28], houses: [5, 7] });
  });

  it("moves houses to the player who fills more, the first ones after their own row, as the video shows at 4:16", () => {
    // "if one player is able to fill more houses than that which they started with then those houses filled, on the opponents side now become part of their territory in the next round"
    const r = play(board([0, 0, 0, 0, 0, 1], [3, 0, 2, 2, 0, 0], [20, 20]), "F");
    const next = r.state;
    expect(next.pits).toEqual(new Array(12).fill(4));
    expect(ownedPits(next, 0)).toEqual([0, 1, 2, 3, 4, 5, pit("a")]);
    expect(ownerAt(next, pit("a"))).toBe(0);
    // The players take turns to start ("Each player takes it in turns to start"): South started round 1, so North starts round 2.
    expect(next.toMove).toBe(1);
    expect(legalMoves(next, NAMNAM)).toEqual([7, 8, 9, 10, 11]);
    // South may sow from the house it won on North's side.
    expect(legalMoves({ ...next, toMove: 0 }, NAMNAM)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // A four made in a won house is South's, during North's move too: North's eight seeds from f pass through a.
    const won = play(board([0, 0, 0, 0, 0, 0], [3, 0, 9, 9, 0, 8], [9, 10], 1, [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1]), "f");
    expect(won.events).toContainEqual({ type: "capture", player: 0, pits: [pit("a")], seeds: 4, whileSowing: true });
    expect(won.state.scores).toEqual([13, 10]);
  });

  it("lets the round's winner start the next round when the setting says so, as in the video", () => {
    // The video: "The player with the majority houses wins the round and they can now start the game" (4:10).
    const r = play(board([0, 0, 0, 0, 0, 1], [3, 0, 2, 2, 0, 0], [20, 20]), "F", { ...NAMNAM, roundStarter: "winner" }, winnerStarts);
    expect(r.state.toMove).toBe(0);
    expect(r.state.starter).toBe(0);
  });

  it("calls an even round a draw and gives each player their own row back", () => {
    // "If each is able to fill the same number of houses then it is a draw." "lost territory can always be reclaimed"
    const s = board([0, 0, 0, 0, 0, 1], [3, 0, 2, 2, 0, 0], [16, 24], 0, [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
    const r = play(s, "F");
    expect(r.events.find((e) => e.type === "round")).toMatchObject({ seeds: [24, 24], houses: [6, 6] });
    expect(ownedPits(r.state, 0)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(describeEvents(r.events)).toContain("South fills 6 houses, North 6, an even round; North starts round 2");
  });

  it("ends the game when a player's territory is completely captured", () => {
    // "The game ends when one persons territory is completely captured, all six houses."
    const s = board([0, 0, 0, 0, 0, 1], [3, 0, 2, 2, 0, 0], [40, 0], 0, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    const r = play(s, "F");
    expect(r.state.status).toBe("finished");
    expect(r.state.result).toEqual({ winner: 0, reason: "territory" });
    expect(resultSentence(r.state)).toBe("North has no houses left, so South wins the game after 1 round.");
  });

  it("ends a round by agreement, each player taking the seeds in their own houses, and starts the next", () => {
    const s = board([1, 0, 0, 0, 0, 3], [0, 0, 2, 2, 0, 0], [20, 20]);
    const ended = endByAgreement(s, NAMNAM);
    expect(ended.events).toContainEqual({ type: "sweep", seeds: [4, 4] });
    expect(ended.state.round).toBe(2);
    const match = OwareMatch.fromState(program, s);
    expect(match.agreeToEnd().events).toEqual(ended.events);
    expect(match.state).toEqual(ended.state);
  });
});

describe("Nam-nam: the rule graph plays the reference engine's game", () => {
  for (const [name, compiled, config] of [
    ["players take turns to start", program, NAMNAM],
    ["the round's winner starts", winnerStarts, { ...NAMNAM, roundStarter: "winner" as const }],
  ] as const) {
    it(`move by move, through rounds, to the end of the game (${name})`, () => {
      const random = rng(2111);
      let rounds = 0;
      let finished = 0;
      for (let game = 0; game < 12; game++) {
        const match = new OwareMatch(compiled);
        let reference = createInitialState(config);
        for (let ply = 0; ply < 1500 && reference.status === "playing"; ply++) {
          const moves = legalMoves(reference, config);
          expect(match.legalMoves()).toEqual(moves);
          expect(moves.length).toBeGreaterThan(0);
          const choice = pick(moves, random);
          const expected = applyMove(reference, choice, config);
          const outcome = match.play(choice);
          expect(outcome.error).toBeUndefined();
          expect(outcome.events).toEqual(expected.events);
          expect(match.state).toEqual(expected.state);
          expect(expected.state.pits.reduce((a, b) => a + b, 0) + expected.state.scores[0] + expected.state.scores[1]).toBe(48);
          if (expected.events.some((e) => e.type === "round")) rounds += 1;
          reference = expected.state;
        }
        if (reference.status === "finished") finished += 1;
      }
      expect(rounds).toBeGreaterThan(20);
      expect(finished).toBeGreaterThan(0);
    });
  }
});

/**
 * A second Nam-nam implementation, written from oware.org's rules text and sharing no code with the engine,
 * compared with the engine on whole games and random positions. Where the text is silent it follows the
 * choices in docs/rulesets/oware-namnam.md.
 */
namespace Independent {
  export interface Game { houses: number[]; owner: Player[]; won: [number, number]; turn: Player; starter: Player; round: number; over: boolean; winner: Player | null }
  const other = (p: Player): Player => (p === 0 ? 1 : 0);
  const mine = (g: Game, p: Player) => g.houses.reduce((n, s, h) => n + (g.owner[h] === p ? s : 0), 0);

  /** Scoop from `from` and sow; null when the sowing would never end. */
  function sow(g: Game, from: number): { g: Game; roundEnded: boolean } | null {
    const houses = [...g.houses];
    const won: [number, number] = [...g.won];
    let hand = houses[from]!;
    houses[from] = 0;
    let at = from;
    const scooped = new Set<string>();
    for (;;) {
      at = (at + 1) % 12;
      houses[at]! += 1;
      hand -= 1;
      const lastSeed = hand === 0;
      // "creates four seeds on ones territory ... except when four seeds are made with ones last seed on the opponent's territory"
      if (houses[at] === 4) {
        const taker = lastSeed && g.owner[at] !== g.turn ? g.turn : g.owner[at]!;
        const inPlay = houses.reduce((a, b) => a + b, 0) + hand;
        won[taker] += 4;
        houses[at] = 0;
        // "When there are eight seeds left in play ... also gains the last set of four"
        if (inPlay <= 8) {
          won[taker] += houses.reduce((a, b) => a + b, 0) + hand;
          return { g: { ...g, houses: new Array(12).fill(0), won }, roundEnded: true };
        }
        if (lastSeed) return { g: { ...g, houses, won }, roundEnded: false };
        continue;
      }
      if (!lastSeed) continue;
      // "until ones last seed lands in a house, which is empty"
      if (houses[at] === 1) return { g: { ...g, houses, won }, roundEnded: false };
      const key = `${at}|${houses.join(",")}`;
      if (scooped.has(key)) return null;
      scooped.add(key);
      hand = houses[at]!;
      houses[at] = 0;
    }
  }

  export function moves(g: Game): number[] {
    if (g.over) return [];
    return g.houses
      .map((_, h) => h)
      .filter((h) => {
        if (g.owner[h] !== g.turn || g.houses[h] === 0) return false;
        const r = sow(g, h);
        if (!r) return false;
        // "the other player must sow seeds from a house that would provide the opponent with seeds"
        return mine(g, other(g.turn)) > 0 || r.roundEnded || mine(r.g, other(g.turn)) > 0;
      });
  }

  function nextRound(g: Game, starters: "alternate" | "winner"): Game {
    // "each player places the seeds they have won back in the houses on their territory four seeds in each house"
    const filled: [number, number] = [Math.floor(g.won[0] / 4), Math.floor(g.won[1] / 4)];
    const spare = 12 - filled[0] - filled[1];
    if (spare > 0) filled[g.won[0] >= g.won[1] ? 0 : 1] += spare;
    // "The game ends when one persons territory is completely captured"
    if (filled[0] === 0 || filled[1] === 0) return { ...g, over: true, winner: filled[0] > 0 ? 0 : 1 };
    const owner: Player[] = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
    if (filled[0] !== filled[1]) {
      const big: Player = filled[0] > filled[1] ? 0 : 1;
      for (let i = 0; i < filled[big] - 6; i++) owner[(big === 0 ? 6 : 0) + i] = big;
    }
    const starter: Player = starters === "winner" && filled[0] !== filled[1] ? (filled[0] > filled[1] ? 0 : 1) : other(g.starter);
    return { houses: new Array(12).fill(4), owner, won: [0, 0], turn: starter, starter, round: g.round + 1, over: false, winner: null };
  }

  export function play(g: Game, h: number, starters: "alternate" | "winner"): Game {
    const r = sow(g, h)!;
    if (r.roundEnded) return nextRound(r.g, starters);
    if (moves({ ...r.g, turn: other(g.turn) }).length > 0) return { ...r.g, turn: other(g.turn) };
    // "If at any point in the game one player does not have any seeds, the other player must sow"
    if (mine(r.g, other(g.turn)) === 0 && moves(r.g).length > 0) return r.g;
    // "If this is not possible then the game comes to an end, with the remaining seeds going the player who has the seeds on their territory."
    const won: [number, number] = [r.g.won[0] + mine(r.g, 0), r.g.won[1] + mine(r.g, 1)];
    return nextRound({ ...r.g, houses: new Array(12).fill(0), won }, starters);
  }
}

function compareWithIndependent(g: Independent.Game, config: OwareConfig): void {
  const state: OwareState = { ...createInitialState(NAMNAM), pits: g.houses, scores: g.won, toMove: g.turn, owners: g.owner, round: g.round, starter: g.starter, positions: { [positionKey(g.houses, g.turn)]: 1 } };
  const where = JSON.stringify(g);
  expect(legalMoves(state, config), where).toEqual(Independent.moves(g));
  for (const h of Independent.moves(g)) {
    const want = Independent.play(g, h, config.roundStarter);
    const got = applyMove(state, h, config).state;
    expect(
      { houses: got.pits, owner: Array.from({ length: 12 }, (_, p) => ownerAt(got, p)), won: got.scores, turn: want.over ? want.turn : got.toMove, round: want.over ? want.round : got.round, over: got.status === "finished", winner: got.result?.winner ?? null },
      `house ${h} in ${where}`,
    ).toEqual({ houses: want.over ? got.pits : want.houses, owner: want.over ? Array.from({ length: 12 }, (_, p) => ownerAt(got, p)) : want.owner, won: want.over ? got.scores : want.won, turn: want.turn, round: want.round, over: want.over, winner: want.winner });
  }
}

describe("Nam-nam checked against an independent implementation of the rules text", () => {
  it("agrees on whole games, round after round", () => {
    const random = rng(4242);
    for (const starters of ["alternate", "winner"] as const) {
      const config = { ...NAMNAM, roundStarter: starters };
      for (let game = 0; game < 10; game++) {
        let g: Independent.Game = { houses: new Array(12).fill(4), owner: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1], won: [0, 0], turn: 0, starter: 0, round: 1, over: false, winner: null };
        for (let ply = 0; ply < 400 && !g.over; ply++) {
          compareWithIndependent(g, config);
          const options = Independent.moves(g);
          if (options.length === 0) break;
          g = Independent.play(g, options[Math.floor(random() * options.length)]!, starters);
        }
      }
    }
  });

  it("agrees on random positions and territories", () => {
    const random = rng(1121);
    let checked = 0;
    while (checked < 1200) {
      const onBoard = 1 + Math.floor(random() * 48);
      const pits = new Array<number>(12).fill(0);
      for (let i = 0; i < onBoard; i++) pits[Math.floor(random() * 12)]! += 1;
      const rest = 48 - onBoard;
      const south = Math.floor(random() * (rest + 1));
      const southHouses = 1 + Math.floor(random() * 11);
      const owner: Player[] = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
      if (southHouses > 6) for (let i = 0; i < southHouses - 6; i++) owner[6 + i] = 0;
      if (southHouses < 6) for (let i = 0; i < 6 - southHouses; i++) owner[i] = 1;
      const g: Independent.Game = { houses: pits, owner, won: [south, rest - south], turn: random() < 0.5 ? 0 : 1, starter: random() < 0.5 ? 0 : 1, round: 3, over: false, winner: null };
      compareWithIndependent(g, NAMNAM);
      checked += 1;
    }
  });
});

describe("Nam-nam computer opponent", () => {
  it("takes a four when it can, and plays a whole game through the rule graph", () => {
    const start = board([0, 0, 0, 0, 0, 1], [3, 9, 9, 9, 0, 0], [8, 9]);
    expect(chooseMove(OwareMatch.fromState(program, start), 2)?.pit).toBe(pit("F"));
    const match = new OwareMatch(program);
    const t0 = Date.now();
    for (let i = 0; i < 400 && match.state.status === "playing"; i++) {
      const choice = chooseMove(match, 2);
      expect(choice).not.toBeNull();
      expect(match.play(choice!.pit).accepted).toBe(true);
    }
    expect(match.state.round).toBeGreaterThan(1);
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 90_000);
});
