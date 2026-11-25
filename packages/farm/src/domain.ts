import { callStmt, GraphBuilder, type DomainSpec, type NodeSpec, type ParamSpec, type PinSpec, type RuleGraph, type Stmt } from "@gamestudio/rules-core";

const EXEC_IN = { id: "in", kind: "exec" } as const;
const EXEC_OUT = { id: "out", kind: "exec" } as const;
const trace = (node: string): Stmt => ({ s: "trace", node });

export const FARM_DOMAIN = "farm";

export const FARM_NODE = {
  newDay: "farm.event.newDay",
  planted: "farm.event.planted",
  harvested: "farm.event.harvested",
  sold: "farm.event.sold",
  message: "farm.action.message",
  goal: "farm.action.goal",
  sound: "farm.action.sound",
  giveMoney: "farm.action.giveMoney",
  takeMoney: "farm.action.takeMoney",
  setPrice: "farm.action.setPrice",
  rain: "farm.action.rain",
  endSeason: "farm.action.endSeason",
  money: "farm.query.money",
  day: "farm.query.day",
  harvestedCount: "farm.query.harvestedCount",
  soldCount: "farm.query.soldCount",
  price: "farm.query.price",
  basePrice: "farm.query.basePrice",
  growing: "farm.query.growing",
  raining: "farm.query.raining",
} as const;

/** The template's generated sounds that rules can play. */
export const FARM_SOUNDS = ["chime", "coins", "rooster", "rain"] as const;

function event(type: string, name: string, title: string, description: string, payload: { id: string; label: string; type: "text" | "number" | "boolean" }[]): NodeSpec {
  return {
    type,
    domain: FARM_DOMAIN,
    category: "event",
    title,
    description,
    inputs: [],
    outputs: [EXEC_OUT, ...payload.map((p) => ({ id: p.id, kind: "data" as const, type: p.type, label: p.label }))],
    params: [],
    event: { name },
    maxPerGraph: 1,
    compileExec: (ctx) => [trace(ctx.node.id), ...ctx.follow("out")],
  };
}

const cropInput: PinSpec = { id: "crop", kind: "data", type: "text", label: "Crop id", param: "crop" };
const cropParam = (fallback: string, label = "Crop id (when unconnected)"): ParamSpec => ({ id: "crop", label, kind: "text", default: fallback, maxLength: 24 });
const amountInput: PinSpec = { id: "amount", kind: "data", type: "number", label: "Amount", param: "amount" };
const amountParam: ParamSpec = { id: "amount", label: "Amount (when unconnected)", kind: "number", default: 10, min: 0, max: 100000 };

export const farmNodes: NodeSpec[] = [
  event(FARM_NODE.newDay, "newDay", "On New Day", "A new morning: the farmer slept (or the day ran out) and the crops grew. Rain tells whether it is raining today.", [
    { id: "day", label: "Day", type: "number" },
    { id: "rain", label: "Raining", type: "boolean" },
  ]),
  event(FARM_NODE.planted, "planted", "On Planted", "The farmer planted a seed (after paying for it).", [
    { id: "crop", label: "Crop id", type: "text" },
    { id: "cropName", label: "Crop name", type: "text" },
  ]),
  event(FARM_NODE.harvested, "harvested", "On Harvest", "The farmer harvested a grown tile.", [
    { id: "crop", label: "Crop id", type: "text" },
    { id: "cropName", label: "Crop name", type: "text" },
    { id: "amount", label: "Amount", type: "number" },
  ]),
  event(FARM_NODE.sold, "sold", "On Sold", "The farmer sold the harvest of one crop at the market stall (after being paid).", [
    { id: "crop", label: "Crop id", type: "text" },
    { id: "amount", label: "Amount", type: "number" },
    { id: "coins", label: "Coins paid", type: "number" },
  ]),
  {
    type: FARM_NODE.message,
    domain: FARM_DOMAIN,
    category: "action",
    title: "Show Message",
    description: "Shows a message on screen for a few seconds.",
    inputs: [EXEC_IN, { id: "text", kind: "data", type: "text", label: "Text", param: "text" }],
    outputs: [EXEC_OUT],
    params: [
      { id: "text", label: "Text (when unconnected)", kind: "text", default: "", maxLength: 300, multiline: true },
      { id: "seconds", label: "Seconds on screen", kind: "number", default: 4, min: 1, max: 20 },
    ],
    keywords: ["say", "notice", "hud"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("farm.message", { text: ctx.input("text"), seconds: { e: "const", v: ctx.param<number>("seconds") } }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: FARM_NODE.goal,
    domain: FARM_DOMAIN,
    category: "action",
    title: "Set Goal",
    description: "Replaces the goal shown in the corner of the screen.",
    inputs: [EXEC_IN, { id: "text", kind: "data", type: "text", label: "Text", param: "text" }],
    outputs: [EXEC_OUT],
    params: [{ id: "text", label: "Goal (when unconnected)", kind: "text", default: "", maxLength: 200 }],
    keywords: ["objective", "quest", "target"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("farm.goal", { text: ctx.input("text") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: FARM_NODE.sound,
    domain: FARM_DOMAIN,
    category: "action",
    title: "Play Sound",
    description: "Plays one of the template's generated sounds.",
    inputs: [EXEC_IN],
    outputs: [EXEC_OUT],
    params: [{ id: "sound", label: "Sound", kind: "select", default: "chime", options: FARM_SOUNDS.map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) })) }],
    keywords: ["audio", "sfx"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("farm.sound", { sound: { e: "const", v: ctx.param<string>("sound") } }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: FARM_NODE.giveMoney,
    domain: FARM_DOMAIN,
    category: "action",
    title: "Give Money",
    description: "Adds money (a prize, a grant, a sale outside the market).",
    inputs: [EXEC_IN, amountInput],
    outputs: [EXEC_OUT],
    params: [amountParam],
    keywords: ["coins", "reward", "bonus", "income"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("farm.giveMoney", { amount: ctx.input("amount") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: FARM_NODE.takeMoney,
    domain: FARM_DOMAIN,
    category: "action",
    title: "Take Money",
    description: "Takes money (rent, a fee, a loss); the money never goes below zero.",
    inputs: [EXEC_IN, amountInput],
    outputs: [EXEC_OUT],
    params: [amountParam],
    keywords: ["coins", "rent", "cost", "tax"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("farm.takeMoney", { amount: ctx.input("amount") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: FARM_NODE.setPrice,
    domain: FARM_DOMAIN,
    category: "action",
    title: "Set Crop Price",
    description: "Changes what the market pays for one of a crop (market days, gluts, festivals).",
    inputs: [EXEC_IN, cropInput, { id: "price", kind: "data", type: "number", label: "Price", param: "price" }],
    outputs: [EXEC_OUT],
    params: [cropParam("tomato"), { id: "price", label: "Price (when unconnected)", kind: "number", default: 10, min: 0, max: 10000 }],
    keywords: ["market", "economy", "sell"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("farm.setPrice", { crop: ctx.input("crop"), price: ctx.input("price") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: FARM_NODE.rain,
    domain: FARM_DOMAIN,
    category: "action",
    title: "Make It Rain",
    description: "Rain for the rest of today: every crop counts as watered.",
    inputs: [EXEC_IN],
    outputs: [EXEC_OUT],
    params: [],
    keywords: ["weather", "water", "storm"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("farm.rain", {}, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: FARM_NODE.endSeason,
    domain: FARM_DOMAIN,
    category: "action",
    title: "End Season",
    description: "Ends the game with a closing message (a win, or the season running out).",
    inputs: [EXEC_IN, { id: "text", kind: "data", type: "text", label: "Text", param: "text" }],
    outputs: [EXEC_OUT],
    params: [{ id: "text", label: "Message (when unconnected)", kind: "text", default: "The season is over.", maxLength: 200 }],
    keywords: ["win", "finish", "game over"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("farm.endSeason", { text: ctx.input("text") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: FARM_NODE.money,
    domain: FARM_DOMAIN,
    category: "query",
    title: "Money",
    description: "The farmer's money now.",
    inputs: [],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Money" }],
    params: [],
    keywords: ["coins", "cash", "balance"],
    compileExpr: () => ({ e: "query", fn: "farm.money", args: {} }),
  },
  {
    type: FARM_NODE.day,
    domain: FARM_DOMAIN,
    category: "query",
    title: "Day",
    description: "Today's day number (1 on the first morning).",
    inputs: [],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Day" }],
    params: [],
    keywords: ["date", "calendar", "time"],
    compileExpr: () => ({ e: "query", fn: "farm.day", args: {} }),
  },
  {
    type: FARM_NODE.harvestedCount,
    domain: FARM_DOMAIN,
    category: "query",
    title: "Total Harvested",
    description: "How many of a crop the farmer has harvested so far (leave the crop empty for every crop).",
    inputs: [cropInput],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Count" }],
    params: [cropParam("", "Crop id (when unconnected; empty for all)")],
    keywords: ["count", "yield"],
    compileExpr: (ctx) => ({ e: "query", fn: "farm.harvestedCount", args: { crop: ctx.input("crop") } }),
  },
  {
    type: FARM_NODE.soldCount,
    domain: FARM_DOMAIN,
    category: "query",
    title: "Total Sold",
    description: "How many of a crop the farmer has sold so far (leave the crop empty for every crop).",
    inputs: [cropInput],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Count" }],
    params: [cropParam("", "Crop id (when unconnected; empty for all)")],
    keywords: ["count", "sales"],
    compileExpr: (ctx) => ({ e: "query", fn: "farm.soldCount", args: { crop: ctx.input("crop") } }),
  },
  {
    type: FARM_NODE.price,
    domain: FARM_DOMAIN,
    category: "query",
    title: "Crop Price",
    description: "What the market pays for one of a crop now.",
    inputs: [cropInput],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Price" }],
    params: [cropParam("tomato")],
    keywords: ["market", "value"],
    compileExpr: (ctx) => ({ e: "query", fn: "farm.price", args: { crop: ctx.input("crop") } }),
  },
  {
    type: FARM_NODE.basePrice,
    domain: FARM_DOMAIN,
    category: "query",
    title: "Price In Settings",
    description: "The crop's price as the farm's settings give it (Set Crop Price does not change this).",
    inputs: [cropInput],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Price" }],
    params: [cropParam("tomato")],
    keywords: ["market", "normal", "base"],
    compileExpr: (ctx) => ({ e: "query", fn: "farm.basePrice", args: { crop: ctx.input("crop") } }),
  },
  {
    type: FARM_NODE.growing,
    domain: FARM_DOMAIN,
    category: "query",
    title: "Tiles Planted",
    description: "How many tiles have a crop growing (or ready) on them now.",
    inputs: [],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Tiles" }],
    params: [],
    keywords: ["fields", "planted", "count"],
    compileExpr: () => ({ e: "query", fn: "farm.growing", args: {} }),
  },
  {
    type: FARM_NODE.raining,
    domain: FARM_DOMAIN,
    category: "query",
    title: "Is It Raining?",
    description: "True when it rains today.",
    inputs: [],
    outputs: [{ id: "value", kind: "data", type: "boolean", label: "Raining" }],
    params: [],
    keywords: ["weather", "rain"],
    compileExpr: () => ({ e: "query", fn: "farm.raining", args: {} }),
  },
];

export const farmDomain: DomainSpec = {
  id: FARM_DOMAIN,
  title: "Farm",
  description: "Days, planting, harvests, the market, money and the weather for farm simulations.",
  nodes: farmNodes,
  hostFunctions: {
    calls: ["farm.message", "farm.goal", "farm.sound", "farm.giveMoney", "farm.takeMoney", "farm.setPrice", "farm.rain", "farm.endSeason"],
    queries: ["farm.money", "farm.day", "farm.harvestedCount", "farm.soldCount", "farm.price", "farm.basePrice", "farm.growing", "farm.raining"],
  },
};

/**
 * Rules for Sunrise Acres: earn 300 coins by the morning of day 8. Day 4 is market day (tomatoes sell
 * for double, back to normal the next morning); the morning of day 8 judges the season.
 */
export function acreRules(): RuleGraph {
  const N = FARM_NODE;
  const g = new GraphBuilder("acre-rules", "Sunrise Acres rules", FARM_DOMAIN, "The goal, market day, harvest and sale messages, and the end of the season.");
  g.variable("goalMet", "boolean", false, "Has the farmer reached 300 coins yet?");

  // On Start: the goal and how to play.
  g.node("start", "core.event.start", {}, { x: 0, y: -300 });
  g.node("goal1", N.goal, { text: "Have 300 coins by the morning of day 8." }, { x: 300, y: -300 });
  g.node("welcome", N.message, { text: "Welcome to Sunrise Acres! W A S D walk, E works the tile in front (plant, water, harvest), Q picks the seed, and the stall buys your harvest. Sleep in the house to start a new day.", seconds: 8 }, { x: 600, y: -300 });
  g.exec("start", "out", "goal1").exec("goal1", "out", "welcome");

  // On New Day: the rooster; market day on day 4 (tomatoes double), prices back on day 5; the season ends on day 8.
  g.node("morning", N.newDay, {}, { x: 0, y: 0 });
  g.node("rooster", N.sound, { sound: "rooster" }, { x: 300, y: 0 });
  g.node("isMarketDay", "core.compare.number", { operator: "==", b: 4 }, { x: 300, y: 160 });
  g.node("marketBranch", "core.flow.branch", {}, { x: 600, y: 0 });
  g.node("tomatoPrice", N.basePrice, { crop: "tomato" }, { x: 900, y: -220 });
  g.node("doubled", "core.math.multiply", { b: 2 }, { x: 1200, y: -220 });
  g.node("doublePrice", N.setPrice, { crop: "tomato" }, { x: 900, y: -80 });
  g.node("marketMsg", N.message, { text: "Market day! Tomatoes sell for double today.", seconds: 5 }, { x: 1200, y: -80 });
  g.node("isDayAfter", "core.compare.number", { operator: "==", b: 5 }, { x: 600, y: 160 });
  g.node("afterBranch", "core.flow.branch", {}, { x: 900, y: 60 });
  g.node("normalPrice", N.setPrice, { crop: "tomato" }, { x: 1200, y: 60 });
  g.node("isLastDay", "core.compare.number", { operator: ">=", b: 8 }, { x: 900, y: 240 });
  g.node("seasonBranch", "core.flow.branch", {}, { x: 1200, y: 200 });
  g.node("money1", N.money, {}, { x: 1200, y: 360 });
  g.node("enough1", "core.compare.number", { operator: ">=", b: 300 }, { x: 1500, y: 360 });
  g.node("wonBranch", "core.flow.branch", {}, { x: 1500, y: 200 });
  g.node("won", N.endSeason, { text: "A fine season! Sunrise Acres made its 300 coins." }, { x: 1800, y: 140 });
  g.node("lost", N.endSeason, { text: "The season is over, short of 300 coins. Plant early and water every day!" }, { x: 1800, y: 260 });
  g.node("seq", "core.flow.sequence", {}, { x: 450, y: -60 });
  g.exec("morning", "out", "rooster").exec("rooster", "out", "seq");
  g.exec("seq", "first", "marketBranch").exec("marketBranch", "true", "doublePrice").exec("doublePrice", "out", "marketMsg");
  g.exec("seq", "then", "afterBranch").exec("afterBranch", "true", "normalPrice");
  g.exec("seq", "finally", "seasonBranch").exec("seasonBranch", "true", "wonBranch").exec("wonBranch", "true", "won").exec("wonBranch", "false", "lost");
  g.data("morning", "day", "isMarketDay", "a").data("isMarketDay", "result", "marketBranch", "condition");
  g.data("tomatoPrice", "value", "doubled", "a").data("doubled", "result", "doublePrice", "price").data("tomatoPrice", "value", "normalPrice", "price");
  g.data("morning", "day", "isDayAfter", "a").data("isDayAfter", "result", "afterBranch", "condition");
  g.data("morning", "day", "isLastDay", "a").data("isLastDay", "result", "seasonBranch", "condition");
  g.data("money1", "value", "enough1", "a").data("enough1", "result", "wonBranch", "condition");

  // On Harvest: how many came in.
  g.node("harvest", N.harvested, {}, { x: 0, y: 560 });
  g.node("harvestText1", "core.text.join", { a: "Harvested " }, { x: 300, y: 700 });
  g.node("harvestText2", "core.text.join", { b: " " }, { x: 600, y: 700 });
  g.node("harvestText3", "core.text.join", {}, { x: 900, y: 700 });
  g.node("harvestMsg", N.message, { seconds: 2 }, { x: 300, y: 560 });
  g.exec("harvest", "out", "harvestMsg");
  g.data("harvest", "amount", "harvestText1", "b").data("harvestText1", "result", "harvestText2", "a").data("harvestText2", "result", "harvestText3", "a").data("harvest", "cropName", "harvestText3", "b").data("harvestText3", "result", "harvestMsg", "text");

  // On Sold: the coins, and a cheer the first time the money reaches 300.
  g.node("sold", N.sold, {}, { x: 0, y: 900 });
  g.node("coinsSound", N.sound, { sound: "coins" }, { x: 300, y: 900 });
  g.node("money2", N.money, {}, { x: 300, y: 1060 });
  g.node("enough2", "core.compare.number", { operator: ">=", b: 300 }, { x: 600, y: 1060 });
  g.node("metBefore", "core.var.get", { variable: "goalMet" }, { x: 600, y: 1180 });
  g.node("notMetBefore", "core.logic.not", {}, { x: 900, y: 1180 });
  g.node("justMet", "core.logic.and", {}, { x: 900, y: 1060 });
  g.node("metBranch", "core.flow.branch", {}, { x: 600, y: 900 });
  g.node("remember", "core.var.set", { variable: "goalMet", value: true }, { x: 900, y: 900 });
  g.node("cheer", N.sound, { sound: "chime" }, { x: 1200, y: 900 });
  g.node("goal2", N.goal, { text: "300 coins made! Keep farming until the morning of day 8." }, { x: 1500, y: 900 });
  g.node("metMsg", N.message, { text: "300 coins! The goal is met; the season still runs to the morning of day 8.", seconds: 5 }, { x: 1800, y: 900 });
  g.exec("sold", "out", "coinsSound").exec("coinsSound", "out", "metBranch").exec("metBranch", "true", "remember").exec("remember", "out", "cheer").exec("cheer", "out", "goal2").exec("goal2", "out", "metMsg");
  g.data("money2", "value", "enough2", "a").data("enough2", "result", "justMet", "a").data("metBefore", "value", "notMetBefore", "a").data("notMetBefore", "result", "justMet", "b").data("justMet", "result", "metBranch", "condition");
  return g.build();
}
