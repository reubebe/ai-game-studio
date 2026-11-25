import { describe, expect, it } from "vitest";
import { coreDomain, createRegistry, compileGraph, compileOrThrow, validateGraph, type RuleGraph } from "@gamestudio/rules-core";
import { ABAPA, applyMove, createInitialState, legalMoves, type OwareConfig } from "./engine";
import { owareDomain, OWARE_NODE } from "./domain";
import { abapaGraph, ayoGraph } from "./presets";
import { OwareMatch, decodeLog, encodeLog } from "./match";
import { chooseMove } from "./ai";
import { pick, rng } from "./test-helpers";

const registry = createRegistry([coreDomain, owareDomain]);

function withParams(graph: RuleGraph, nodeId: string, params: Record<string, unknown>): RuleGraph {
  const g = structuredClone(graph);
  const node = g.nodes.find((n) => n.id === nodeId)!;
  node.params = { ...node.params, ...params };
  return g;
}

describe("Abapa rule graph", () => {
  it("validates and compiles without errors", () => {
    const result = compileGraph(abapaGraph(), registry);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.program!.handlers).sort()).toEqual(["agreeEnd", "move"]);
  });

  it("derives the Abapa variant settings from its nodes", () => {
    expect(compileOrThrow(abapaGraph(), registry).domainConfig).toEqual({ ...ABAPA });
  });

  it("documents its sources", () => {
    const g = abapaGraph();
    expect(g.provenance?.variant).toBe("Oware Abapa");
    expect(g.provenance?.sources.map((s) => s.url)).toContain("https://en.wikipedia.org/wiki/Oware");
  });
});

describe("Ayò rule graph", () => {
  it("compiles to the two-or-three-capture settings, which are Abapa's", () => {
    const program = compileOrThrow(ayoGraph(), registry);
    expect(program.graphId).toBe("ayo");
    expect(program.domainConfig).toEqual({ ...ABAPA });
  });

  it("names its sources and the accounts it does not follow", () => {
    const g = ayoGraph();
    expect(g.provenance?.sources.map((s) => s.url)).toEqual(["https://games.blac.media/heritage/ayo/about", "https://en.wikipedia.org/wiki/Oware"]);
    expect(g.provenance?.notes).toMatch(/relay sowing/);
  });
});

const variants: [string, RuleGraph, OwareConfig][] = [
  ["Abapa", abapaGraph(), ABAPA],
  ["Ayò", ayoGraph(), ABAPA],
  ["forbidden grand slam", withParams(abapaGraph(), "capture", { grandSlam: "forbidden" }), { ...ABAPA, grandSlam: "forbidden" }],
  ["capture-all grand slam", withParams(abapaGraph(), "capture", { grandSlam: "capture-all" }), { ...ABAPA, grandSlam: "capture-all" }],
  ["no origin skip", withParams(abapaGraph(), "sow", { skipOrigin: false }), { ...ABAPA, skipOrigin: false }],
  ["counts 2-4, no chain", withParams(abapaGraph(), "capture", { counts: [2, 3, 4], chain: false }), { ...ABAPA, captureCounts: [2, 3, 4], captureChain: false }],
  ["no feeding rule", withParams(abapaGraph(), "guard", { mustFeed: false }), { ...ABAPA, mustFeed: false }],
  ["repetition limit 2", withParams(abapaGraph(), "end", { repetitionLimit: 2 }), { ...ABAPA, repetitionLimit: 2 }],
  ["five seeds per pit", withParams(abapaGraph(), "board", { seedsPerPit: 5 }), { ...ABAPA, seedsPerPit: 5 }],
];

describe("graph-driven play matches the reference engine", () => {
  for (const [name, graph, config] of variants) {
    it(`move by move, including events (${name})`, () => {
      const program = compileOrThrow(graph, registry);
      expect(program.domainConfig).toEqual({ ...config });
      const random = rng(1234);
      for (let game = 0; game < 60; game++) {
        const match = new OwareMatch(program);
        let reference = createInitialState(config);
        for (let ply = 0; ply < 250 && reference.status === "playing"; ply++) {
          const moves = legalMoves(reference, config);
          expect(match.legalMoves()).toEqual(moves);
          const pit = pick(moves, random);
          const expected = applyMove(reference, pit, config);
          const outcome = match.play(pit);
          expect(outcome.error).toBeUndefined();
          expect(outcome.accepted).toBe(true);
          expect(outcome.events).toEqual(expected.events);
          expect(match.state).toEqual(expected.state);
          reference = expected.state;
        }
      }
    });
  }

  it("rejects illegal moves through the guard without changing anything", () => {
    const match = new OwareMatch(compileOrThrow(abapaGraph(), registry));
    const before = match.state;
    const outcome = match.play(8);
    expect(outcome.accepted).toBe(false);
    expect(outcome.rejection).toMatch(/your own pits/);
    expect(outcome.trace).toEqual(["move", "guard", "reject"]);
    expect(match.state).toBe(before);
    expect(match.log).toEqual([]);
  });
});

describe("editing the graph changes gameplay", () => {
  it("adding 4 to the capture counts makes a four-seed pit capturable", () => {
    const pits = [0, 0, 0, 0, 0, 1, 3, 4, 4, 4, 4, 4];
    const run = (graph: RuleGraph) => {
      const match = new OwareMatch(compileOrThrow(graph, registry));
      // Reach the test position through the host directly: same rules, custom start.
      const sim = match.simulate({ ...createInitialState(match.config), pits, scores: [12, 12] }, match.variables, { type: "move", pit: 5 });
      return sim.state.scores;
    };
    expect(run(abapaGraph())).toEqual([12, 12]);
    expect(run(withParams(abapaGraph(), "capture", { counts: [2, 3, 4] }))).toEqual([16, 12]);
  });

  it("a house rule built from general nodes grants an extra turn after a capture", () => {
    const g = abapaGraph();
    // Continue -> Branch(captured > 0): true skips Next Turn (same player again), false passes the turn.
    g.nodes.push(
      { id: "bonusCheck", type: "core.compare.number", position: { x: 1500, y: 360 }, params: { operator: ">", b: 0 } },
      { id: "bonusBranch", type: "core.flow.branch", position: { x: 1500, y: 260 }, params: {} },
      { id: "bonusMsg", type: OWARE_NODE.announce, position: { x: 1800, y: 360 }, params: { text: "Capture bonus: move again!" } },
    );
    g.edges = g.edges.filter((e) => !(e.source === "end" && e.sourceHandle === "exec:continue"));
    g.edges.push(
      { id: "h1", source: "end", sourceHandle: "exec:continue", target: "bonusBranch", targetHandle: "exec:in" },
      { id: "h2", source: "capture", sourceHandle: "data:captured", target: "bonusCheck", targetHandle: "data:a" },
      { id: "h3", source: "bonusCheck", sourceHandle: "data:result", target: "bonusBranch", targetHandle: "data:condition" },
      { id: "h4", source: "bonusBranch", sourceHandle: "exec:false", target: "next", targetHandle: "exec:in" },
      { id: "h5", source: "bonusBranch", sourceHandle: "exec:true", target: "bonusMsg", targetHandle: "exec:in" },
    );
    const result = compileGraph(g, registry);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const match = new OwareMatch(result.program!);
    const start = { ...createInitialState(ABAPA), pits: [0, 0, 0, 0, 0, 1, 1, 4, 4, 4, 4, 4], scores: [13, 13] as [number, number] };
    const sim = match.simulate(start, match.variables, { type: "move", pit: 5 });
    expect(sim.outcome.accepted).toBe(true);
    expect(sim.outcome.messages).toEqual(["Capture bonus: move again!"]);
    expect(sim.state.toMove).toBe(0);
    const quiet = match.simulate(createInitialState(ABAPA), match.variables, { type: "move", pit: 0 });
    expect(quiet.state.toMove).toBe(1);
  });

  it("refuses graphs without a guard, a sow step or a move event", () => {
    const g = abapaGraph();
    g.nodes = g.nodes.filter((n) => !["guard", "sow", "move"].includes(n.id));
    g.edges = g.edges.filter((e) => !["guard", "sow", "move"].includes(e.source) && !["guard", "sow", "move"].includes(e.target));
    const codes = validateGraph(g, registry).diagnostics.map((d) => d.code);
    expect(codes).toEqual(expect.arrayContaining(["oware-no-guard", "oware-no-sow", "oware-no-move"]));
  });

  it("keeps the state when a custom rule fails at runtime", () => {
    const g = abapaGraph();
    g.variables.push({ name: "ratio", type: "number", initial: 0 });
    g.nodes.push(
      { id: "div", type: "core.math.divide", position: { x: 0, y: 0 }, params: { a: 1 } },
      { id: "set", type: "core.var.set", position: { x: 0, y: 0 }, params: { variable: "ratio" } },
    );
    g.edges = g.edges.filter((e) => !(e.source === "end" && e.sourceHandle === "exec:continue"));
    g.edges.push(
      { id: "x1", source: "end", sourceHandle: "exec:continue", target: "set", targetHandle: "exec:in" },
      { id: "x2", source: "set", sourceHandle: "exec:out", target: "next", targetHandle: "exec:in" },
      { id: "x3", source: "capture", sourceHandle: "data:captured", target: "div", targetHandle: "data:b" },
      { id: "x4", source: "div", sourceHandle: "data:result", target: "set", targetHandle: "data:value" },
    );
    const match = new OwareMatch(compileOrThrow(g, registry));
    const before = match.state;
    const outcome = match.play(0);
    expect(outcome.accepted).toBe(false);
    expect(outcome.error?.message).toMatch(/Division by zero/);
    expect(match.state).toBe(before);
  });
});

describe("OwareMatch history", () => {
  const program = compileOrThrow(abapaGraph(), registry);

  it("undoes and redoes exactly", () => {
    const match = new OwareMatch(program);
    const s0 = match.state;
    match.play(2);
    const s1 = match.state;
    match.play(8);
    expect(match.undo()).toBe(true);
    expect(match.state).toEqual(s1);
    expect(match.undo()).toBe(true);
    expect(match.state).toEqual(s0);
    expect(match.undo()).toBe(false);
    expect(match.redo()).toBe(true);
    expect(match.state).toEqual(s1);
  });

  it("drops redo history when a new move is played after undo", () => {
    const match = new OwareMatch(program);
    match.play(2);
    match.play(8);
    match.undo();
    match.play(9);
    expect(match.log).toEqual([{ type: "move", pit: 2 }, { type: "move", pit: 9 }]);
    expect(match.canRedo).toBe(false);
  });

  it("replays its log to the same state", () => {
    const random = rng(99);
    const match = new OwareMatch(program);
    for (let i = 0; i < 80 && match.state.status === "playing"; i++) match.play(pick(match.legalMoves(), random));
    const replayed = OwareMatch.replay(program, match.log);
    expect(replayed.state).toEqual(match.state);
  });

  it("resigns: the other player wins, Undo takes it back, and the log replays and saves as a short string", () => {
    const match = new OwareMatch(program);
    match.play(2);
    expect(match.resign().accepted).toBe(true);
    expect(match.state.result).toEqual({ winner: 0, reason: "resignation" });
    expect(match.play(8).rejection).toMatch(/over/);
    expect(encodeLog(match.log)).toBe("2N");
    expect(OwareMatch.replay(program, decodeLog("2N")!).state).toEqual(match.state);
    expect(match.undo()).toBe(true);
    expect(match.state.status).toBe("playing");
    expect(decodeLog("2a=S")).toEqual([{ type: "move", pit: 2 }, { type: "move", pit: 10 }, { type: "agree" }, { type: "resign", player: 0 }]);
    expect(decodeLog("2z")).toBeNull();
  });

  it("ends by agreement through the graph's agreement event", () => {
    const match = new OwareMatch(program);
    const outcome = match.agreeToEnd();
    expect(outcome.accepted).toBe(true);
    expect(match.state.result).toEqual({ winner: null, reason: "agreement" });
    expect(match.play(0).rejection).toMatch(/over/);
  });
});

describe("computer opponent", () => {
  const program = compileOrThrow(abapaGraph(), registry);

  it("chooses a legal move deterministically", () => {
    const a = chooseMove(new OwareMatch(program), 3);
    const b = chooseMove(new OwareMatch(program), 3);
    expect(a).not.toBeNull();
    expect(createInitialState().pits[a!.pit]).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it("takes a winning capture when one is available", () => {
    const start = { ...createInitialState(ABAPA), pits: [2, 0, 0, 0, 0, 1, 1, 4, 0, 0, 0, 0], scores: [23, 17] as [number, number] };
    expect(chooseMove(OwareMatch.fromState(program, start), 2)?.pit).toBe(5);
  });

  it("refuses set-up positions that break seed conservation", () => {
    const bad = { ...createInitialState(ABAPA), pits: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
    expect(() => OwareMatch.fromState(program, bad)).toThrow(/total 48/);
  });
});
