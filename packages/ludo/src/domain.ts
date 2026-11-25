import { callStmt, paramsWithDefaults, type Diagnostic, type DomainSpec, type NodeRegistry, type NodeSpec, type RuleGraph, type Stmt } from "@gamestudio/rules-core";
import { CLASSIC, type LudoConfig } from "./engine";

const EXEC_IN = { id: "in", kind: "exec" } as const;
const EXEC_OUT = { id: "out", kind: "exec" } as const;
const trace = (node: string): Stmt => ({ s: "trace", node });

export const LUDO_DOMAIN = "ludo";

export const LUDO_NODE = {
  roll: "ludo.event.roll",
  move: "ludo.event.move",
  setup: "ludo.config.setup",
  rollDie: "ludo.action.rollDie",
  sixes: "ludo.guard.sixes",
  canMove: "ludo.guard.canMove",
  legal: "ludo.guard.legal",
  reject: "ludo.action.reject",
  advance: "ludo.action.advance",
  capture: "ludo.action.capture",
  win: "ludo.guard.win",
  finish: "ludo.action.finish",
  bonus: "ludo.guard.bonus",
  again: "ludo.action.again",
  nextTurn: "ludo.action.nextTurn",
  announce: "ludo.action.announce",
  toMove: "ludo.query.toMove",
  lastRoll: "ludo.query.lastRoll",
  home: "ludo.query.home",
  progress: "ludo.query.progress",
} as const;

const branch = (ctx: { node: { id: string }; temp: string; follow: (pin: string) => Stmt[] }, field: string, yes: string, no: string): Stmt => ({
  s: "if",
  cond: { e: "temp", name: ctx.temp, field },
  then: ctx.follow(yes),
  else: ctx.follow(no),
  node: ctx.node.id,
});

export const ludoNodes: NodeSpec[] = [
  {
    type: LUDO_NODE.roll,
    domain: LUDO_DOMAIN,
    category: "event",
    title: "On Roll",
    description: "The player whose turn it is rolls the die.",
    inputs: [],
    outputs: [EXEC_OUT, { id: "player", kind: "data", type: "number", label: "Player" }],
    params: [],
    event: { name: "roll" },
    maxPerGraph: 1,
    keywords: ["dice", "die", "throw"],
    compileExec: (ctx) => [trace(ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: LUDO_NODE.move,
    domain: LUDO_DOMAIN,
    category: "event",
    title: "On Token Chosen",
    description: "The player has chosen a token to move with the roll. Token is 0-3; Player is the index in play order.",
    inputs: [],
    outputs: [EXEC_OUT, { id: "token", kind: "data", type: "number", label: "Token" }, { id: "player", kind: "data", type: "number", label: "Player" }],
    params: [],
    event: { name: "move" },
    maxPerGraph: 1,
    keywords: ["piece", "choose", "move"],
    compileExec: (ctx) => [trace(ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: LUDO_NODE.setup,
    domain: LUDO_DOMAIN,
    category: "config",
    title: "Game Setup",
    description: "Tokens each player brings home to win.",
    inputs: [],
    outputs: [],
    params: [{ id: "tokens", label: "Tokens per player", kind: "number", default: CLASSIC.tokens, min: 1, max: 4, integer: true }],
    maxPerGraph: 1,
    keywords: ["setup", "pieces"],
  },
  {
    type: LUDO_NODE.rollDie,
    domain: LUDO_DOMAIN,
    category: "action",
    title: "Roll Die",
    description: "Rolls one six-sided die from the game's seeded dice, so a game replays exactly.",
    inputs: [EXEC_IN],
    outputs: [EXEC_OUT, { id: "value", kind: "data", type: "number", label: "Roll" }, { id: "sixes", kind: "data", type: "number", label: "6s in a row" }],
    params: [],
    maxPerGraph: 1,
    keywords: ["dice", "random"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("ludo.roll", {}, ctx.node.id, ctx.temp), ...ctx.follow("out")],
  },
  {
    type: LUDO_NODE.sixes,
    domain: LUDO_DOMAIN,
    category: "guard",
    title: "Too Many Sixes?",
    description: "Classic: a third 6 in a row cannot be used and the turn passes.",
    inputs: [EXEC_IN],
    outputs: [
      { id: "over", kind: "exec", label: "Too many" },
      { id: "ok", kind: "exec", label: "OK" },
    ],
    params: [{ id: "maxSixes", label: "6s in a row that lose the turn (0 = no limit)", kind: "number", default: CLASSIC.maxSixes, min: 0, max: 6, integer: true }],
    maxPerGraph: 1,
    keywords: ["three sixes", "forfeit"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("ludo.checkSixes", {}, ctx.node.id, ctx.temp), branch(ctx, "over", "over", "ok")],
  },
  {
    type: LUDO_NODE.canMove,
    domain: LUDO_DOMAIN,
    category: "guard",
    title: "Any Token Can Move?",
    description: "Whether the roll lets any of the player's tokens move (the Legal Token Move guard's settings decide).",
    inputs: [EXEC_IN],
    outputs: [
      { id: "yes", kind: "exec", label: "Yes: choose a token" },
      { id: "no", kind: "exec", label: "No" },
    ],
    params: [],
    maxPerGraph: 1,
    keywords: ["stuck", "pass"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("ludo.canMove", {}, ctx.node.id, ctx.temp), branch(ctx, "yes", "yes", "no")],
  },
  {
    type: LUDO_NODE.legal,
    domain: LUDO_DOMAIN,
    category: "guard",
    title: "Guard: Legal Token Move?",
    description: "Checks the chosen token against the roll: leaving the yard, overshooting home, blocks.",
    inputs: [EXEC_IN, { id: "token", kind: "data", type: "number", label: "Token" }],
    outputs: [
      { id: "legal", kind: "exec", label: "Legal" },
      { id: "illegal", kind: "exec", label: "Illegal" },
      { id: "reason", kind: "data", type: "text", label: "Reason" },
    ],
    params: [
      { id: "enterOn", label: "Rolls that bring a token out", kind: "numberList", default: [...CLASSIC.enterOn], min: 1, max: 6, integer: true, maxItems: 6 },
      { id: "exactFinish", label: "Exact count needed to reach home", kind: "boolean", default: CLASSIC.exactFinish },
      { id: "blocks", label: "Two tokens of one colour form a block", kind: "boolean", default: CLASSIC.blocks, help: "A common house rule (Nigeria, India): opponents can neither pass nor land on a block." },
    ],
    maxPerGraph: 1,
    tempScope: ["illegal"],
    keywords: ["check", "valid", "enter", "exact"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("ludo.checkMove", { token: ctx.input("token") }, ctx.node.id, ctx.temp), branch(ctx, "legal", "legal", "illegal")],
  },
  {
    type: LUDO_NODE.reject,
    domain: LUDO_DOMAIN,
    category: "action",
    title: "Reject Move",
    description: "Refuses the move and stops. Nothing changes; the player can choose another token.",
    inputs: [EXEC_IN, { id: "reason", kind: "data", type: "text", label: "Reason", param: "reason" }],
    outputs: [],
    params: [{ id: "reason", label: "Reason (when unconnected)", kind: "text", default: "That move is not allowed." }],
    keywords: ["illegal", "refuse"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("ludo.reject", { reason: ctx.input("reason") }, ctx.node.id), { s: "halt", node: ctx.node.id }],
  },
  {
    type: LUDO_NODE.advance,
    domain: LUDO_DOMAIN,
    category: "action",
    title: "Move Token",
    description: "Moves the token by the roll: out of the yard onto its start square, along the track, up its home column.",
    inputs: [EXEC_IN, { id: "token", kind: "data", type: "number", label: "Token" }],
    outputs: [EXEC_OUT, { id: "home", kind: "data", type: "boolean", label: "Reached home" }],
    params: [],
    maxPerGraph: 1,
    keywords: ["advance", "step"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("ludo.advance", { token: ctx.input("token") }, ctx.node.id, ctx.temp), ...ctx.follow("out")],
  },
  {
    type: LUDO_NODE.capture,
    domain: LUDO_DOMAIN,
    category: "action",
    title: "Capture",
    description: "Opponent tokens on the square the token landed on go back to their yards.",
    inputs: [EXEC_IN, { id: "token", kind: "data", type: "number", label: "Token" }],
    outputs: [EXEC_OUT, { id: "captured", kind: "data", type: "number", label: "Captured" }],
    params: [{ id: "safeStarts", label: "Start squares are safe", kind: "boolean", default: CLASSIC.safeStarts, help: "A common house rule: no token can be captured on any of the four start squares." }],
    maxPerGraph: 1,
    keywords: ["take", "knock", "send home"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("ludo.capture", { token: ctx.input("token") }, ctx.node.id, ctx.temp), ...ctx.follow("out")],
  },
  {
    type: LUDO_NODE.win,
    domain: LUDO_DOMAIN,
    category: "guard",
    title: "Check Win",
    description: "Wins when all of the player's tokens are home.",
    inputs: [EXEC_IN],
    outputs: [
      { id: "win", kind: "exec", label: "Win" },
      { id: "continue", kind: "exec", label: "Continue" },
    ],
    params: [],
    maxPerGraph: 1,
    keywords: ["end", "game over"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("ludo.checkWin", {}, ctx.node.id, ctx.temp), branch(ctx, "won", "win", "continue")],
  },
  {
    type: LUDO_NODE.finish,
    domain: LUDO_DOMAIN,
    category: "action",
    title: "Finish Game",
    description: "Ends the game; the player to move wins.",
    inputs: [EXEC_IN],
    outputs: [EXEC_OUT],
    params: [],
    keywords: ["end", "winner"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("ludo.finish", {}, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: LUDO_NODE.bonus,
    domain: LUDO_DOMAIN,
    category: "guard",
    title: "Another Roll?",
    description: "Whether this turn earns another roll: after a 6, a capture or bringing a token home, as set here.",
    inputs: [EXEC_IN],
    outputs: [
      { id: "again", kind: "exec", label: "Roll again" },
      { id: "pass", kind: "exec", label: "Pass" },
    ],
    params: [
      { id: "onSix", label: "A 6 earns another roll", kind: "boolean", default: CLASSIC.bonusOnSix },
      { id: "onCapture", label: "A capture earns another roll", kind: "boolean", default: CLASSIC.bonusOnCapture },
      { id: "onHome", label: "Bringing a token home earns another roll", kind: "boolean", default: CLASSIC.bonusOnHome },
    ],
    maxPerGraph: 2,
    keywords: ["bonus", "extra turn"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("ludo.bonus", {}, ctx.node.id, ctx.temp), branch(ctx, "again", "again", "pass")],
  },
  {
    type: LUDO_NODE.again,
    domain: LUDO_DOMAIN,
    category: "action",
    title: "Roll Again",
    description: "The same player rolls again.",
    inputs: [EXEC_IN],
    outputs: [EXEC_OUT],
    params: [],
    keywords: ["bonus", "extra"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("ludo.again", {}, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: LUDO_NODE.nextTurn,
    domain: LUDO_DOMAIN,
    category: "action",
    title: "Next Turn",
    description: "Passes the turn clockwise to the next player.",
    inputs: [EXEC_IN],
    outputs: [EXEC_OUT],
    params: [],
    keywords: ["turn", "pass"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("ludo.nextTurn", {}, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: LUDO_NODE.announce,
    domain: LUDO_DOMAIN,
    category: "action",
    title: "Announce",
    description: "Shows a message to the players.",
    inputs: [EXEC_IN, { id: "text", kind: "data", type: "text", label: "Text", param: "text" }],
    outputs: [EXEC_OUT],
    params: [{ id: "text", label: "Text (when unconnected)", kind: "text", default: "", maxLength: 300 }],
    keywords: ["message", "say"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("ludo.announce", { text: ctx.input("text") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: LUDO_NODE.toMove,
    domain: LUDO_DOMAIN,
    category: "query",
    title: "Player To Move",
    description: "The index in play order of the player whose turn it is.",
    inputs: [],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Player" }],
    params: [],
    compileExpr: () => ({ e: "query", fn: "ludo.toMove", args: {} }),
  },
  {
    type: LUDO_NODE.lastRoll,
    domain: LUDO_DOMAIN,
    category: "query",
    title: "Current Roll",
    description: "The roll waiting to be used (0 before rolling).",
    inputs: [],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Roll" }],
    params: [],
    compileExpr: () => ({ e: "query", fn: "ludo.lastRoll", args: {} }),
  },
  {
    type: LUDO_NODE.home,
    domain: LUDO_DOMAIN,
    category: "query",
    title: "Tokens Home",
    description: "How many of a player's tokens are home.",
    inputs: [{ id: "player", kind: "data", type: "number", label: "Player", param: "player" }],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Home" }],
    params: [{ id: "player", label: "Player (when unconnected)", kind: "number", default: 0, min: 0, max: 3, integer: true }],
    compileExpr: (ctx) => ({ e: "query", fn: "ludo.home", args: { player: ctx.input("player") } }),
  },
  {
    type: LUDO_NODE.progress,
    domain: LUDO_DOMAIN,
    category: "query",
    title: "Token Progress",
    description: "-1 in the yard, 0-50 on the track, 51-55 in the home column, 56 at home.",
    inputs: [
      { id: "player", kind: "data", type: "number", label: "Player", param: "player" },
      { id: "token", kind: "data", type: "number", label: "Token", param: "token" },
    ],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Progress" }],
    params: [
      { id: "player", label: "Player (when unconnected)", kind: "number", default: 0, min: 0, max: 3, integer: true },
      { id: "token", label: "Token (when unconnected)", kind: "number", default: 0, min: 0, max: 3, integer: true },
    ],
    compileExpr: (ctx) => ({ e: "query", fn: "ludo.progress", args: { player: ctx.input("player"), token: ctx.input("token") } }),
  },
];

/** Read the variant settings from the node parameters of a graph. */
export function ludoConfigFromGraph(graph: RuleGraph, registry: NodeRegistry): LudoConfig {
  const find = (type: string) => {
    const node = graph.nodes.find((n) => n.type === type);
    const spec = registry.get(type);
    return node && spec ? paramsWithDefaults(spec, node) : undefined;
  };
  const setup = find(LUDO_NODE.setup);
  const sixes = find(LUDO_NODE.sixes);
  const legal = find(LUDO_NODE.legal);
  const capture = find(LUDO_NODE.capture);
  const bonus = find(LUDO_NODE.bonus);
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const enterOn = legal?.["enterOn"];
  return {
    tokens: typeof setup?.["tokens"] === "number" ? setup["tokens"] : CLASSIC.tokens,
    enterOn: Array.isArray(enterOn) ? (enterOn as number[]) : [...CLASSIC.enterOn],
    bonusOnSix: bool(bonus?.["onSix"], CLASSIC.bonusOnSix),
    maxSixes: typeof sixes?.["maxSixes"] === "number" ? sixes["maxSixes"] : sixes ? CLASSIC.maxSixes : 0,
    bonusOnCapture: bool(bonus?.["onCapture"], CLASSIC.bonusOnCapture),
    bonusOnHome: bool(bonus?.["onHome"], CLASSIC.bonusOnHome),
    blocks: bool(legal?.["blocks"], CLASSIC.blocks),
    safeStarts: bool(capture?.["safeStarts"], CLASSIC.safeStarts),
    exactFinish: bool(legal?.["exactFinish"], CLASSIC.exactFinish),
  };
}

function validateLudo(graph: RuleGraph): Diagnostic[] {
  const out: Diagnostic[] = [];
  const has = (type: string) => graph.nodes.some((n) => n.type === type);
  if (!has(LUDO_NODE.roll)) out.push({ severity: "error", code: "ludo-no-roll", message: "Add an 'On Roll' event: without it, rolling the die does nothing." });
  if (!has(LUDO_NODE.rollDie)) out.push({ severity: "error", code: "ludo-no-die", message: "Add a 'Roll Die' node after 'On Roll'." });
  if (!has(LUDO_NODE.move)) out.push({ severity: "error", code: "ludo-no-move", message: "Add an 'On Token Chosen' event: without it, tokens never move." });
  if (!has(LUDO_NODE.legal)) out.push({ severity: "error", code: "ludo-no-guard", message: "Add a 'Guard: Legal Token Move?' node so illegal moves are rejected before the board changes." });
  if (!has(LUDO_NODE.advance)) out.push({ severity: "error", code: "ludo-no-advance", message: "Add a 'Move Token' node: every move moves a token." });
  if (!has(LUDO_NODE.win)) out.push({ severity: "warning", code: "ludo-no-win", message: "No 'Check Win' node: the game will never end." });
  if (!has(LUDO_NODE.nextTurn)) out.push({ severity: "warning", code: "ludo-no-turn", message: "No 'Next Turn' node: the same player will play every time." });
  const enterOn = graph.nodes.find((n) => n.type === LUDO_NODE.legal)?.params["enterOn"];
  if (Array.isArray(enterOn) && enterOn.length === 0) out.push({ severity: "warning", code: "ludo-no-entry", message: "No roll brings a token out of its yard, so nobody can ever move." });
  const bonuses = graph.nodes.filter((n) => n.type === LUDO_NODE.bonus);
  if (bonuses.length === 2 && JSON.stringify(bonuses[0]!.params) !== JSON.stringify(bonuses[1]!.params)) {
    out.push({ severity: "warning", code: "ludo-bonus-differ", message: "The two 'Another Roll?' nodes have different settings; the game uses the first one's.", nodeId: bonuses[1]!.id });
  }
  return out;
}

export const ludoDomain: DomainSpec = {
  id: LUDO_DOMAIN,
  title: "Ludo (race game)",
  description: "Dice race for 2-4 players: rolls, tokens, captures and turn order.",
  nodes: ludoNodes,
  validate: validateLudo,
  config: (graph, registry) => ({ ...ludoConfigFromGraph(graph, registry) }),
  hostFunctions: {
    calls: ["ludo.roll", "ludo.checkSixes", "ludo.canMove", "ludo.checkMove", "ludo.reject", "ludo.advance", "ludo.capture", "ludo.checkWin", "ludo.finish", "ludo.bonus", "ludo.again", "ludo.nextTurn", "ludo.announce"],
    queries: ["ludo.toMove", "ludo.lastRoll", "ludo.home", "ludo.progress"],
  },
};
