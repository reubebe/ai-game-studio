import { describe, expect, it } from "vitest";
import { coreDomain, compileGraph, compileOrThrow, createRegistry, type RuleGraph } from "@gamestudio/rules-core";
import { applyMove, applyRoll, CLASSIC, createInitialState, legalTokens, type LudoConfig, type LudoState } from "./engine";
import { ludoDomain } from "./domain";
import { classicGraph } from "./presets";
import { LudoMatch, decodeLudoLog, encodeLudoLog } from "./match";
import { chooseToken } from "./ai";

const registry = createRegistry([coreDomain, ludoDomain]);

function withParams(graph: RuleGraph, ids: string[], params: Record<string, unknown>): RuleGraph {
  const g = structuredClone(graph);
  for (const id of ids) {
    const node = g.nodes.find((n) => n.id === id)!;
    node.params = { ...node.params, ...params };
  }
  return g;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("Classic Ludo rule graph", () => {
  it("validates and compiles to the Classic settings", () => {
    const result = compileGraph(classicGraph(), registry);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.program!.handlers).sort()).toEqual(["move", "roll"]);
    expect(result.program!.domainConfig).toEqual({ ...CLASSIC });
  });

  it("documents its sources and house rules", () => {
    const g = classicGraph();
    expect(g.provenance?.sources.map((s) => s.url)).toEqual(["https://en.wikipedia.org/wiki/Ludo"]);
    expect(g.provenance?.notes).toMatch(/house rules/i);
  });

  it("replays a whole game exactly from its seed and actions", () => {
    const program = compileOrThrow(classicGraph(), registry);
    const match = new LudoMatch(program, 4, 2026);
    for (let i = 0; i < 3000 && match.state.status === "playing"; i++) {
      if (match.state.dice === null) match.roll();
      else match.move(chooseToken(match)!.token);
    }
    expect(match.state.status).toBe("finished");
    const again = LudoMatch.replay(program, 4, 2026, match.log);
    expect(again.state).toEqual(match.state);
  });
});

const variants: [string, RuleGraph, LudoConfig][] = [
  ["Classic", classicGraph(), CLASSIC],
  ["blocks", withParams(classicGraph(), ["guard"], { blocks: true }), { ...CLASSIC, blocks: true }],
  ["start squares not safe", withParams(classicGraph(), ["capture"], { safeStarts: false }), { ...CLASSIC, safeStarts: false }],
  ["1 or 6 to enter, extra rolls on captures and home", withParams(withParams(classicGraph(), ["guard"], { enterOn: [1, 6] }), ["bonus", "stuckBonus"], { onCapture: true, onHome: true }), { ...CLASSIC, enterOn: [1, 6], bonusOnCapture: true, bonusOnHome: true }],
  ["no three-sixes limit, overshoot finishes", withParams(withParams(classicGraph(), ["sixes"], { maxSixes: 0 }), ["guard"], { exactFinish: false }), { ...CLASSIC, maxSixes: 0, exactFinish: false }],
  ["two tokens each, no bonus on 6", withParams(withParams(classicGraph(), ["setup"], { tokens: 2 }), ["bonus", "stuckBonus"], { onSix: false }), { ...CLASSIC, tokens: 2, bonusOnSix: false }],
];

describe("graph-driven play matches the reference engine", () => {
  for (const [name, graph, config] of variants) {
    it(`roll by roll and move by move, including events (${name})`, () => {
      const program = compileOrThrow(graph, registry);
      expect(program.domainConfig).toEqual({ ...config });
      const random = rng(99);
      for (let game = 0; game < 24; game++) {
        const players = 2 + (game % 3);
        const match = new LudoMatch(program, players, 1000 + game);
        let reference: LudoState = createInitialState(config, players, 1000 + game);
        for (let step = 0; step < 4000 && reference.status === "playing"; step++) {
          if (reference.dice === null) {
            const ref = applyRoll(reference, config);
            const out = match.roll();
            expect(out.accepted).toBe(true);
            expect(out.events).toEqual(ref.events);
            reference = ref.state;
          } else {
            const moves = legalTokens(reference, config);
            expect(match.legalMoves()).toEqual(moves);
            const illegal = [0, 1, 2, 3].find((t) => !moves.includes(t));
            if (illegal !== undefined) expect(match.move(illegal).accepted).toBe(false);
            const token = moves[Math.floor(random() * moves.length)]!;
            const ref = applyMove(reference, token, config)!;
            const out = match.move(token);
            expect(out.accepted).toBe(true);
            expect(out.events).toEqual(ref.events);
            reference = ref.state;
          }
          expect(match.state).toEqual(reference);
        }
        expect(reference.status).toBe("finished");
      }
    });
  }
});

describe("ending a Ludo game and saving its log", () => {
  it("ends with nobody winning, Undo takes it back, and the log replays from a short string", () => {
    const program = compileOrThrow(classicGraph(), createRegistry([coreDomain, ludoDomain]));
    const match = new LudoMatch(program, 2, 7);
    match.roll();
    if (match.state.dice !== null) {
      const token = match.legalMoves()[0];
      if (token !== undefined) match.move(token);
    }
    expect(match.endGame().accepted).toBe(true);
    expect(match.state).toMatchObject({ status: "finished", winner: null, dice: null });
    expect(match.roll().accepted).toBe(false);
    const text = encodeLudoLog(match.log);
    expect(text.endsWith("x")).toBe(true);
    expect(LudoMatch.replay(program, 2, 7, decodeLudoLog(text)!).state).toEqual(match.state);
    expect(match.undo()).toBe(true);
    expect(match.state.status).toBe("playing");
    expect(decodeLudoLog("r0r3x")).toEqual([{ type: "roll" }, { type: "move", token: 0 }, { type: "roll" }, { type: "move", token: 3 }, { type: "end" }]);
    expect(decodeLudoLog("r9")).toBeNull();
  });
});

