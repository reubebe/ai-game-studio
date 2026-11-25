import { callStmt, paramsWithDefaults, type Diagnostic, type DomainSpec, type NodeSpec, type RuleGraph, type NodeRegistry, type Stmt } from "@gamestudio/rules-core";
import { ABAPA, type GrandSlamPolicy, type OwareConfig, type RoundStarter } from "./engine";

const EXEC_IN = { id: "in", kind: "exec" } as const;
const EXEC_OUT = { id: "out", kind: "exec" } as const;
const trace = (node: string): Stmt => ({ s: "trace", node });

export const OWARE_DOMAIN = "oware";

export const OWARE_NODE = {
  move: "oware.event.move",
  agree: "oware.event.agree",
  board: "oware.config.board",
  guard: "oware.guard.legal",
  reject: "oware.action.reject",
  sow: "oware.action.sow",
  capture: "oware.action.capture",
  termination: "oware.guard.termination",
  sweep: "oware.action.sweep",
  finish: "oware.action.finish",
  nextTurn: "oware.action.nextTurn",
  again: "oware.action.again",
  nextRound: "oware.action.nextRound",
  announce: "oware.action.announce",
  seeds: "oware.query.seeds",
  score: "oware.query.score",
  toMove: "oware.query.toMove",
  owner: "oware.query.owner",
  sideSeeds: "oware.query.sideSeeds",
  houses: "oware.query.houses",
  round: "oware.query.round",
} as const;

/** What each grand-slam setting means, for the node's choices and the players' rules summary. */
export const GRAND_SLAM_LABELS: Record<GrandSlamPolicy, string> = {
  "no-capture": "Legal, but nothing is captured (Abapa)",
  forbidden: "Not a legal move",
  "capture-all": "Legal, and everything is captured",
};

const GRAND_SLAM_OPTIONS: { value: GrandSlamPolicy; label: string }[] = (["no-capture", "forbidden", "capture-all"] as const).map((value) => ({ value, label: GRAND_SLAM_LABELS[value] }));

export const owareNodes: NodeSpec[] = [
  {
    type: OWARE_NODE.move,
    domain: OWARE_DOMAIN,
    category: "event",
    title: "On Move Chosen",
    description: "A player has chosen a pit to sow from. Pit is 0-11 in sowing order; Player is 0 (South) or 1 (North).",
    inputs: [],
    outputs: [EXEC_OUT, { id: "pit", kind: "data", type: "number", label: "Pit" }, { id: "player", kind: "data", type: "number", label: "Player" }],
    params: [],
    event: { name: "move" },
    maxPerGraph: 1,
    keywords: ["turn", "player", "choose"],
    compileExec: (ctx) => [trace(ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: OWARE_NODE.agree,
    domain: OWARE_DOMAIN,
    category: "event",
    title: "On Players Agree to End",
    description: "Both players agree the game has become an endless cycle.",
    inputs: [],
    outputs: [EXEC_OUT],
    params: [],
    event: { name: "agreeEnd" },
    maxPerGraph: 1,
    keywords: ["cycle", "draw", "stop"],
    compileExec: (ctx) => [trace(ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: OWARE_NODE.board,
    domain: OWARE_DOMAIN,
    category: "config",
    title: "Board Setup",
    description: "Seeds placed in each of the twelve pits at the start. The win threshold is more than half of all seeds.",
    inputs: [],
    outputs: [],
    params: [{ id: "seedsPerPit", label: "Seeds per pit", kind: "number", default: ABAPA.seedsPerPit, min: 1, max: 12, integer: true }],
    maxPerGraph: 1,
    keywords: ["setup", "initial", "seeds"],
  },
  {
    type: OWARE_NODE.guard,
    domain: OWARE_DOMAIN,
    category: "guard",
    title: "Guard: Legal Move?",
    description: "Checks the chosen pit against the variant: own side, not empty, feeding rule and grand-slam policy.",
    inputs: [EXEC_IN, { id: "pit", kind: "data", type: "number", label: "Pit" }],
    outputs: [
      { id: "legal", kind: "exec", label: "Legal" },
      { id: "illegal", kind: "exec", label: "Illegal" },
      { id: "reason", kind: "data", type: "text", label: "Reason" },
    ],
    params: [{ id: "mustFeed", label: "Must feed an opponent who has no seeds", kind: "boolean", default: ABAPA.mustFeed, help: "Abapa: if the opponent's side is empty, the move must give them seeds." }],
    maxPerGraph: 1,
    tempScope: ["illegal"],
    keywords: ["check", "valid", "legal", "feed"],
    compileExec: (ctx) => [
      trace(ctx.node.id),
      callStmt("oware.checkLegal", { pit: ctx.input("pit") }, ctx.node.id, ctx.temp),
      { s: "if", cond: { e: "temp", name: ctx.temp, field: "legal" }, then: ctx.follow("legal"), else: ctx.follow("illegal"), node: ctx.node.id },
    ],
  },
  {
    type: OWARE_NODE.reject,
    domain: OWARE_DOMAIN,
    category: "action",
    title: "Reject Move",
    description: "Refuses the move and stops. The board does not change.",
    inputs: [EXEC_IN, { id: "reason", kind: "data", type: "text", label: "Reason", param: "reason" }],
    outputs: [],
    params: [{ id: "reason", label: "Reason (when unconnected)", kind: "text", default: "That move is not allowed." }],
    keywords: ["illegal", "refuse"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("oware.reject", { reason: ctx.input("reason") }, ctx.node.id), { s: "halt", node: ctx.node.id }],
  },
  {
    type: OWARE_NODE.sow,
    domain: OWARE_DOMAIN,
    category: "action",
    title: "Sow Seeds",
    description: "Lifts every seed from the pit and drops them one by one counter-clockwise. With relay sowing, a last seed that lands in a pit holding seeds lifts them and sows on, until the last seed lands in an empty pit.",
    inputs: [EXEC_IN, { id: "pit", kind: "data", type: "number", label: "Pit" }],
    outputs: [EXEC_OUT, { id: "lastPit", kind: "data", type: "number", label: "Last pit" }, { id: "sown", kind: "data", type: "number", label: "Seeds sown" }],
    params: [
      { id: "skipOrigin", label: "Skip the starting pit on full laps (12+ seeds)", kind: "boolean", default: ABAPA.skipOrigin },
      { id: "relay", label: "Keep sowing from where the last seed lands (relay)", kind: "boolean", default: ABAPA.relay, help: "Nam-nam: if the last seed drops in a house with seeds in it, lift them all and sow on until the last seed lands in an empty house." },
      {
        id: "ownerCaptures",
        label: "A house reaching this is taken by its owner",
        kind: "numberList",
        default: [...ABAPA.ownerCaptures],
        min: 1,
        max: 48,
        integer: true,
        maxItems: 12,
        help: "Nam-nam: 4. During either player's move, a house that a seed brings to this count goes at once to whoever owns it. A last seed that makes the Capture Check's count in an opponent's house is the sower's instead.",
      },
    ],
    maxPerGraph: 1,
    keywords: ["sow", "distribute", "seeds"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("oware.sow", { pit: ctx.input("pit") }, ctx.node.id, ctx.temp), ...ctx.follow("out")],
  },
  {
    type: OWARE_NODE.capture,
    domain: OWARE_DOMAIN,
    category: "action",
    title: "Capture Check",
    description: "If the last seed makes an opponent pit hold a capture count, take those seeds (and, with chaining, the preceding opponent pits that also qualify).",
    inputs: [EXEC_IN, { id: "lastPit", kind: "data", type: "number", label: "Last pit" }],
    outputs: [EXEC_OUT, { id: "captured", kind: "data", type: "number", label: "Captured" }, { id: "grandSlam", kind: "data", type: "boolean", label: "Grand slam" }],
    params: [
      { id: "counts", label: "Capture when a pit holds", kind: "numberList", default: [...ABAPA.captureCounts], min: 1, max: 48, integer: true, maxItems: 12 },
      { id: "chain", label: "Chain backwards through opponent pits", kind: "boolean", default: ABAPA.captureChain },
      { id: "grandSlam", label: "Capturing all opponent seeds (grand slam)", kind: "select", default: ABAPA.grandSlam, options: GRAND_SLAM_OPTIONS },
    ],
    maxPerGraph: 1,
    keywords: ["take", "capture", "grand slam"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("oware.capture", { lastPit: ctx.input("lastPit") }, ctx.node.id, ctx.temp), ...ctx.follow("out")],
  },
  {
    type: OWARE_NODE.termination,
    domain: OWARE_DOMAIN,
    category: "guard",
    title: "Check Termination",
    description: "Win (more than half the seeds), draw (24-24), round over (no seeds left in play), blocked (next player cannot move), same player again (the other has no seeds), cycle (optional repetition rule) or continue.",
    inputs: [EXEC_IN],
    outputs: [
      { id: "win", kind: "exec", label: "Win" },
      { id: "draw", kind: "exec", label: "Draw" },
      { id: "round", kind: "exec", label: "Round over" },
      { id: "blocked", kind: "exec", label: "Next player blocked" },
      { id: "again", kind: "exec", label: "Other player has no seeds" },
      { id: "cycle", kind: "exec", label: "Repetition" },
      { id: "continue", kind: "exec", label: "Continue" },
      { id: "winner", kind: "data", type: "number", label: "Winner" },
    ],
    params: [
      { id: "majority", label: "End when a player has more than half the seeds", kind: "boolean", default: ABAPA.majority, help: "Abapa: 25 of 48 wins and 24 each draws. Off (Nam-nam): a round goes on until the seeds run out." },
      {
        id: "lastSeeds",
        label: "Last seeds: when this many are left, the next capture takes them all (0 = off)",
        kind: "number",
        default: ABAPA.lastSeeds,
        min: 0,
        max: 48,
        integer: true,
        help: "Nam-nam: 8. Whoever captures the penultimate four also gains the last four, which ends the round.",
      },
      { id: "emptyPasses", label: "A player with no seeds passes; the other plays on", kind: "boolean", default: ABAPA.emptyPasses, help: "Nam-nam: if a player has no seeds, the other player moves again and must give them seeds if they can." },
      {
        id: "repetitionLimit",
        label: "End on repeated position (0 = off)",
        kind: "number",
        default: ABAPA.repetitionLimit,
        min: 0,
        max: 10,
        integer: true,
        help: "Studio convention, not traditional Abapa: ends the game when the same position would occur this many times. Traditional play ends cycles by agreement.",
      },
    ],
    maxPerGraph: 1,
    keywords: ["end", "win", "draw", "game over"],
    compileExec: (ctx) => [
      trace(ctx.node.id),
      callStmt("oware.checkEnd", {}, ctx.node.id, ctx.temp),
      {
        s: "switch",
        value: { e: "temp", name: ctx.temp, field: "outcome" },
        cases: { win: ctx.follow("win"), draw: ctx.follow("draw"), round: ctx.follow("round"), blocked: ctx.follow("blocked"), again: ctx.follow("again"), cycle: ctx.follow("cycle"), continue: ctx.follow("continue") },
        default: [],
        node: ctx.node.id,
      },
    ],
  },
  {
    type: OWARE_NODE.sweep,
    domain: OWARE_DOMAIN,
    category: "action",
    title: "Players Take Own Seeds",
    description: "Each player captures the seeds remaining in the houses they own.",
    inputs: [EXEC_IN],
    outputs: [EXEC_OUT],
    params: [],
    keywords: ["sweep", "remaining"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("oware.sweep", {}, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: OWARE_NODE.finish,
    domain: OWARE_DOMAIN,
    category: "action",
    title: "Finish Game",
    description: "Ends the game. The player with more captured seeds wins; equal scores draw.",
    inputs: [EXEC_IN],
    outputs: [EXEC_OUT],
    params: [
      {
        id: "reason",
        label: "Reason",
        kind: "select",
        default: "majority",
        options: [
          { value: "majority", label: "Majority of seeds" },
          { value: "draw", label: "Draw" },
          { value: "no-legal-move", label: "No legal move" },
          { value: "repetition", label: "Repeated position" },
          { value: "agreement", label: "Agreement" },
          { value: "territory", label: "A player lost every house" },
        ],
      },
    ],
    keywords: ["end", "game over", "result"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("oware.finish", { reason: { e: "const", v: ctx.param<string>("reason") } }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: OWARE_NODE.nextTurn,
    domain: OWARE_DOMAIN,
    category: "action",
    title: "Next Turn",
    description: "Passes the turn to the other player. Leave it out of a path to give the same player another move.",
    inputs: [EXEC_IN],
    outputs: [EXEC_OUT],
    params: [],
    keywords: ["turn", "switch", "pass"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("oware.nextTurn", {}, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: OWARE_NODE.again,
    domain: OWARE_DOMAIN,
    category: "action",
    title: "Same Player Again",
    description: "The other player has no seeds, so the player who just moved goes again (and must give them seeds if the feeding rule is on).",
    inputs: [EXEC_IN],
    outputs: [EXEC_OUT],
    params: [],
    keywords: ["again", "pass", "no seeds", "feed"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("oware.again", {}, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: OWARE_NODE.nextRound,
    domain: OWARE_DOMAIN,
    category: "action",
    title: "Start Next Round",
    description:
      "The round is over: each player fills houses with their captured seeds, four to a house (Board Setup's seeds per pit). The player who fills more houses also takes the other row's first houses for the next round. Game over when a player has no houses left.",
    inputs: [EXEC_IN],
    outputs: [
      { id: "next", kind: "exec", label: "Next round" },
      { id: "over", kind: "exec", label: "A player has no houses" },
    ],
    params: [
      {
        id: "starter",
        label: "Who starts the next round",
        kind: "select",
        default: ABAPA.roundStarter,
        options: [
          { value: "alternate", label: "The players take turns (oware.org)" },
          { value: "winner", label: "The round's winner (First Step Tours)" },
        ],
      },
    ],
    maxPerGraph: 1,
    keywords: ["round", "houses", "territory", "refill"],
    compileExec: (ctx) => [
      trace(ctx.node.id),
      callStmt("oware.nextRound", {}, ctx.node.id, ctx.temp),
      { s: "if", cond: { e: "temp", name: ctx.temp, field: "over" }, then: ctx.follow("over"), else: ctx.follow("next"), node: ctx.node.id },
    ],
  },
  {
    type: OWARE_NODE.announce,
    domain: OWARE_DOMAIN,
    category: "action",
    title: "Announce",
    description: "Shows a message to the players.",
    inputs: [EXEC_IN, { id: "text", kind: "data", type: "text", label: "Text", param: "text" }],
    outputs: [EXEC_OUT],
    params: [{ id: "text", label: "Text (when unconnected)", kind: "text", default: "", maxLength: 300 }],
    keywords: ["message", "say", "show"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("oware.announce", { text: ctx.input("text") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: OWARE_NODE.seeds,
    domain: OWARE_DOMAIN,
    category: "query",
    title: "Seeds In Pit",
    description: "How many seeds a pit holds right now.",
    inputs: [{ id: "pit", kind: "data", type: "number", label: "Pit", param: "pit" }],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Seeds" }],
    params: [{ id: "pit", label: "Pit (when unconnected)", kind: "number", default: 0, min: 0, max: 11, integer: true }],
    compileExpr: (ctx) => ({ e: "query", fn: "oware.seeds", args: { pit: ctx.input("pit") } }),
  },
  {
    type: OWARE_NODE.score,
    domain: OWARE_DOMAIN,
    category: "query",
    title: "Captured Seeds",
    description: "How many seeds a player has captured.",
    inputs: [{ id: "player", kind: "data", type: "number", label: "Player", param: "player" }],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Captured" }],
    params: [{ id: "player", label: "Player (when unconnected)", kind: "number", default: 0, min: 0, max: 1, integer: true }],
    keywords: ["score"],
    compileExpr: (ctx) => ({ e: "query", fn: "oware.score", args: { player: ctx.input("player") } }),
  },
  {
    type: OWARE_NODE.toMove,
    domain: OWARE_DOMAIN,
    category: "query",
    title: "Player To Move",
    description: "0 for South, 1 for North.",
    inputs: [],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Player" }],
    params: [],
    compileExpr: () => ({ e: "query", fn: "oware.toMove", args: {} }),
  },
  {
    type: OWARE_NODE.owner,
    domain: OWARE_DOMAIN,
    category: "query",
    title: "Pit Owner",
    description: "Who owns the pit: 0 for South, 1 for North. A pit belongs to its row's player unless a round gave it to the other.",
    inputs: [{ id: "pit", kind: "data", type: "number", label: "Pit", param: "pit" }],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Player" }],
    params: [{ id: "pit", label: "Pit (when unconnected)", kind: "number", default: 0, min: 0, max: 11, integer: true }],
    compileExpr: (ctx) => ({ e: "query", fn: "oware.owner", args: { pit: ctx.input("pit") } }),
  },
  {
    type: OWARE_NODE.sideSeeds,
    domain: OWARE_DOMAIN,
    category: "query",
    title: "Seeds On Side",
    description: "Total seeds in the pits a player owns.",
    inputs: [{ id: "player", kind: "data", type: "number", label: "Player", param: "player" }],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Seeds" }],
    params: [{ id: "player", label: "Player (when unconnected)", kind: "number", default: 0, min: 0, max: 1, integer: true }],
    compileExpr: (ctx) => ({ e: "query", fn: "oware.sideSeeds", args: { player: ctx.input("player") } }),
  },
  {
    type: OWARE_NODE.houses,
    domain: OWARE_DOMAIN,
    category: "query",
    title: "Houses Owned",
    description: "How many pits a player owns (6 each at the start; rounds move houses between players).",
    inputs: [{ id: "player", kind: "data", type: "number", label: "Player", param: "player" }],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Houses" }],
    params: [{ id: "player", label: "Player (when unconnected)", kind: "number", default: 0, min: 0, max: 1, integer: true }],
    keywords: ["territory", "houses"],
    compileExpr: (ctx) => ({ e: "query", fn: "oware.houses", args: { player: ctx.input("player") } }),
  },
  {
    type: OWARE_NODE.round,
    domain: OWARE_DOMAIN,
    category: "query",
    title: "Round",
    description: "The round being played, from 1.",
    inputs: [],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Round" }],
    params: [],
    compileExpr: () => ({ e: "query", fn: "oware.round", args: {} }),
  },
];

/** Read the variant settings from the node parameters of a graph. */
export function owareConfigFromGraph(graph: RuleGraph, registry: NodeRegistry): OwareConfig {
  const find = (type: string) => {
    const node = graph.nodes.find((n) => n.type === type);
    const spec = registry.get(type);
    return node && spec ? paramsWithDefaults(spec, node) : undefined;
  };
  const board = find(OWARE_NODE.board);
  const sow = find(OWARE_NODE.sow);
  const capture = find(OWARE_NODE.capture);
  const guard = find(OWARE_NODE.guard);
  const end = find(OWARE_NODE.termination);
  const round = find(OWARE_NODE.nextRound);
  const counts = capture?.["counts"];
  const ownerCounts = sow?.["ownerCaptures"];
  return {
    seedsPerPit: typeof board?.["seedsPerPit"] === "number" ? board["seedsPerPit"] : ABAPA.seedsPerPit,
    skipOrigin: typeof sow?.["skipOrigin"] === "boolean" ? sow["skipOrigin"] : ABAPA.skipOrigin,
    relay: typeof sow?.["relay"] === "boolean" ? sow["relay"] : ABAPA.relay,
    captureCounts: Array.isArray(counts) ? (counts as number[]) : [...ABAPA.captureCounts],
    captureChain: typeof capture?.["chain"] === "boolean" ? capture["chain"] : ABAPA.captureChain,
    ownerCaptures: Array.isArray(ownerCounts) ? (ownerCounts as number[]) : [...ABAPA.ownerCaptures],
    grandSlam: (capture?.["grandSlam"] as GrandSlamPolicy | undefined) ?? ABAPA.grandSlam,
    mustFeed: typeof guard?.["mustFeed"] === "boolean" ? guard["mustFeed"] : ABAPA.mustFeed,
    emptyPasses: typeof end?.["emptyPasses"] === "boolean" ? end["emptyPasses"] : ABAPA.emptyPasses,
    majority: typeof end?.["majority"] === "boolean" ? end["majority"] : ABAPA.majority,
    lastSeeds: typeof end?.["lastSeeds"] === "number" ? end["lastSeeds"] : ABAPA.lastSeeds,
    rounds: round !== undefined,
    roundStarter: round?.["starter"] === "winner" ? "winner" : ("alternate" as RoundStarter),
    repetitionLimit: typeof end?.["repetitionLimit"] === "number" ? end["repetitionLimit"] : ABAPA.repetitionLimit,
  };
}

function validateOware(graph: RuleGraph): Diagnostic[] {
  const out: Diagnostic[] = [];
  const has = (type: string) => graph.nodes.some((n) => n.type === type);
  if (!has(OWARE_NODE.move)) out.push({ severity: "error", code: "oware-no-move", message: "Add an 'On Move Chosen' event: without it, choosing a pit does nothing." });
  if (!has(OWARE_NODE.sow)) out.push({ severity: "error", code: "oware-no-sow", message: "Add a 'Sow Seeds' node: every Oware move sows seeds." });
  if (!has(OWARE_NODE.guard)) out.push({ severity: "error", code: "oware-no-guard", message: "Add a 'Guard: Legal Move?' node so illegal moves are rejected before the board changes." });
  if (!has(OWARE_NODE.termination)) out.push({ severity: "warning", code: "oware-no-end", message: "No 'Check Termination' node: the game will never end on its own." });
  if (!has(OWARE_NODE.nextTurn)) out.push({ severity: "warning", code: "oware-no-turn", message: "No 'Next Turn' node: the same player will move every time." });
  const capture = graph.nodes.find((n) => n.type === OWARE_NODE.capture);
  const counts = capture?.params["counts"];
  if (Array.isArray(counts) && counts.length === 0) out.push({ severity: "warning", code: "oware-no-counts", message: "Capture Check has no capture counts, so nothing can ever be captured.", nodeId: capture?.id });
  return out;
}

export const owareDomain: DomainSpec = {
  id: OWARE_DOMAIN,
  title: "Oware (mancala)",
  description: "Two-row sowing game: pits, seeds, captures and turn order.",
  nodes: owareNodes,
  validate: validateOware,
  config: (graph, registry) => ({ ...owareConfigFromGraph(graph, registry) }),
  hostFunctions: {
    calls: ["oware.checkLegal", "oware.reject", "oware.sow", "oware.capture", "oware.checkEnd", "oware.sweep", "oware.finish", "oware.nextTurn", "oware.again", "oware.nextRound", "oware.announce"],
    queries: ["oware.seeds", "oware.score", "oware.toMove", "oware.owner", "oware.sideSeeds", "oware.houses", "oware.round"],
  },
};
