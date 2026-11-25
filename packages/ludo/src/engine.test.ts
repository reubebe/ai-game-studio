import { describe, expect, it } from "vitest";
import { applyMove, applyRoll, checkMove, CLASSIC, createInitialState, HOME, nextRandom, squareOf, YARD, type LudoConfig, type LudoState } from "./engine";

const C: LudoConfig = { ...CLASSIC };
/** A two-player position with a given roll waiting (player 0 = Red, seat 0; player 1 = Yellow, seat 2). */
function position(red: number[], yellow: number[], dice: number, config: LudoConfig = C, sixes = 0): LudoState {
  return { ...createInitialState(config, 2, 1), tokens: [red, yellow], dice, sixes: dice === 6 ? Math.max(sixes, 1) : sixes };
}

describe("Ludo reference rules (Classic)", () => {
  it("seeded dice are uniform enough and replay exactly", () => {
    const counts = [0, 0, 0, 0, 0, 0];
    let rng = 42;
    const first: number[] = [];
    for (let i = 0; i < 60000; i++) {
      const r = nextRandom(rng);
      rng = r.rng;
      const v = Math.floor(r.value * 6);
      counts[v]! += 1;
      if (i < 10) first.push(v);
    }
    for (const n of counts) expect(Math.abs(n - 10000)).toBeLessThan(400);
    let again = 42;
    expect(first).toEqual(Array.from({ length: 10 }, () => { const r = nextRandom(again); again = r.rng; return Math.floor(r.value * 6); }));
  });

  it("a token leaves its yard only on a 6, onto its start square", () => {
    expect(checkMove(position([YARD, YARD, YARD, YARD], [YARD, YARD, YARD, YARD], 5), 0, C)).toEqual({ legal: false, reason: "needs-entry-roll" });
    expect(checkMove(position([YARD, YARD, YARD, YARD], [YARD, YARD, YARD, YARD], 6), 0, C)).toEqual({ legal: true, to: 0 });
    expect(squareOf(2, 0)).toBe(26);
  });

  it("a 6 earns another roll, and a third 6 in a row loses the turn", () => {
    const moved = applyMove(position([0, YARD, YARD, YARD], [YARD, YARD, YARD, YARD], 6), 0, C)!;
    expect(moved.state.toMove).toBe(0);
    expect(moved.state.dice).toBeNull();
    // Force a third six: find a seed whose next roll is a 6.
    let seed = 0;
    while (Math.floor(nextRandom(seed).value * 6) !== 5) seed++;
    const s: LudoState = { ...createInitialState(C, 2, seed), sixes: 2, tokens: [[0, YARD, YARD, YARD], [YARD, YARD, YARD, YARD]] };
    const r = applyRoll(s, C);
    expect(r.events.map((e) => e.type)).toEqual(["roll", "sixes", "turn"]);
    expect(r.state.toMove).toBe(1);
  });

  it("landing on an opponent sends it back to its yard; start squares are safe", () => {
    // Red token at progress 10 (square 10); Yellow token at its progress 36 = square (26 + 36) % 52 = 10.
    const hit = applyMove(position([7, YARD, YARD, YARD], [36, YARD, YARD, YARD], 3), 0, C)!;
    expect(hit.state.tokens[1]![0]).toBe(YARD);
    expect(hit.events.some((e) => e.type === "capture")).toBe(true);
    // Yellow on Green's start square (13) = Yellow progress 39; Red lands there with progress 13.
    const safe = applyMove(position([10, YARD, YARD, YARD], [39, YARD, YARD, YARD], 3), 0, C)!;
    expect(safe.state.tokens[1]![0]).toBe(39);
  });

  it("home needs the exact count unless overshooting is allowed", () => {
    expect(checkMove(position([54, YARD, YARD, YARD], [YARD, YARD, YARD, YARD], 3), 0, C)).toEqual({ legal: false, reason: "overshoot" });
    expect(checkMove(position([54, YARD, YARD, YARD], [YARD, YARD, YARD, YARD], 2), 0, C)).toEqual({ legal: true, to: HOME });
    expect(checkMove(position([54, YARD, YARD, YARD], [YARD, YARD, YARD, YARD], 3, { ...C, exactFinish: false }), 0, { ...C, exactFinish: false })).toEqual({ legal: true, to: HOME });
  });

  it("the first player with every token home wins", () => {
    const won = applyMove(position([HOME, HOME, HOME, 53], [YARD, YARD, YARD, YARD], 3), 3, C)!;
    expect(won.state.status).toBe("finished");
    expect(won.state.winner).toBe(0);
  });

  it("with blocks on, two opponent tokens on a square cannot be passed", () => {
    const blocked = { ...C, blocks: true };
    // Yellow pair at its progress 30 = square 4. Red at progress 2 rolling 4 would pass square 4.
    expect(checkMove(position([2, YARD, YARD, YARD], [30, 30, YARD, YARD], 4, blocked), 0, blocked)).toEqual({ legal: false, reason: "blocked" });
    expect(checkMove(position([2, YARD, YARD, YARD], [30, 30, YARD, YARD], 4), 0, C)).toEqual({ legal: true, to: 6 });
  });
});
