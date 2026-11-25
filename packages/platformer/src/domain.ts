import { callStmt, GraphBuilder, type DomainSpec, type NodeSpec, type RuleGraph, type Stmt } from "@gamestudio/rules-core";

const EXEC_IN = { id: "in", kind: "exec" } as const;
const EXEC_OUT = { id: "out", kind: "exec" } as const;
const trace = (node: string): Stmt => ({ s: "trace", node });

export const PLATFORMER_DOMAIN = "platformer";

export const PLATFORMER_NODE = {
  collect: "platformer.event.collect",
  checkpoint: "platformer.event.checkpoint",
  goal: "platformer.event.goal",
  hurt: "platformer.event.hurt",
  stomp: "platformer.event.stomp",
  message: "platformer.action.message",
  objective: "platformer.action.objective",
  openDoor: "platformer.action.openDoor",
  sound: "platformer.action.sound",
  setVisible: "platformer.action.setVisible",
  win: "platformer.action.win",
  collected: "platformer.query.collected",
  total: "platformer.query.total",
  doorOpen: "platformer.query.doorOpen",
  hurts: "platformer.query.hurts",
} as const;

export const PLATFORMER_SOUNDS = ["coin", "jump", "checkpoint", "door", "hurt", "stomp", "success"] as const;
export const HURT_CAUSES = ["fall", "spike", "enemy"] as const;

function event(type: string, name: string, title: string, description: string, payload: { id: string; label: string }[]): NodeSpec {
  return {
    type,
    domain: PLATFORMER_DOMAIN,
    category: "event",
    title,
    description,
    inputs: [],
    outputs: [EXEC_OUT, ...payload.map((p) => ({ id: p.id, kind: "data" as const, type: "text" as const, label: p.label }))],
    params: [],
    event: { name },
    maxPerGraph: 1,
    compileExec: (ctx) => [trace(ctx.node.id), ...ctx.follow("out")],
  };
}

export const platformerNodes: NodeSpec[] = [
  event(PLATFORMER_NODE.collect, "collect", "On Coin Collected", "The player touched a coin.", [
    { id: "itemId", label: "Coin id" },
    { id: "kind", label: "Kind" },
  ]),
  event(PLATFORMER_NODE.checkpoint, "checkpoint", "On Checkpoint Reached", "The player touched a checkpoint flag for the first time. They come back here after being hurt.", [{ id: "checkpointId", label: "Checkpoint id" }]),
  event(PLATFORMER_NODE.goal, "goal", "On Goal Reached", "The player touched a goal flag.", [{ id: "goalId", label: "Goal id" }]),
  event(PLATFORMER_NODE.hurt, "hurt", "On Player Hurt", "The player fell, touched spikes or ran into an enemy, and went back to the last checkpoint. Cause is fall, spike or enemy.", [{ id: "cause", label: "Cause" }]),
  event(PLATFORMER_NODE.stomp, "stomp", "On Enemy Stomped", "The player jumped on an enemy, which is gone.", [{ id: "enemyId", label: "Enemy id" }]),
  {
    type: PLATFORMER_NODE.message,
    domain: PLATFORMER_DOMAIN,
    category: "action",
    title: "Show Message",
    description: "Shows a message on screen for a few seconds.",
    inputs: [EXEC_IN, { id: "text", kind: "data", type: "text", label: "Text", param: "text" }],
    outputs: [EXEC_OUT],
    params: [
      { id: "text", label: "Text (when unconnected)", kind: "text", default: "", maxLength: 300, multiline: true },
      { id: "seconds", label: "Seconds on screen", kind: "number", default: 3, min: 1, max: 20 },
    ],
    keywords: ["say", "text", "hud"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("platformer.message", { text: ctx.input("text"), seconds: { e: "const", v: ctx.param<number>("seconds") } }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: PLATFORMER_NODE.objective,
    domain: PLATFORMER_DOMAIN,
    category: "action",
    title: "Set Objective",
    description: "Replaces the objective shown at the top of the screen.",
    inputs: [EXEC_IN, { id: "text", kind: "data", type: "text", label: "Text", param: "text" }],
    outputs: [EXEC_OUT],
    params: [{ id: "text", label: "Objective (when unconnected)", kind: "text", default: "", maxLength: 200 }],
    keywords: ["goal", "task"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("platformer.objective", { text: ctx.input("text") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: PLATFORMER_NODE.openDoor,
    domain: PLATFORMER_DOMAIN,
    category: "action",
    title: "Open Door",
    description: "Opens a door so the player can pass.",
    inputs: [EXEC_IN, { id: "doorId", kind: "data", type: "text", label: "Door id", param: "doorId" }],
    outputs: [EXEC_OUT],
    params: [{ id: "doorId", label: "Door id (when unconnected)", kind: "text", default: "door_goal", maxLength: 48 }],
    keywords: ["gate", "unlock"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("platformer.openDoor", { doorId: ctx.input("doorId") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: PLATFORMER_NODE.sound,
    domain: PLATFORMER_DOMAIN,
    category: "action",
    title: "Play Sound",
    description: "Plays one of the template's generated sound cues.",
    inputs: [EXEC_IN],
    outputs: [EXEC_OUT],
    params: [{ id: "sound", label: "Sound", kind: "select", default: "coin", options: PLATFORMER_SOUNDS.map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) })) }],
    keywords: ["audio", "sfx"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("platformer.sound", { sound: { e: "const", v: ctx.param<string>("sound") } }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: PLATFORMER_NODE.setVisible,
    domain: PLATFORMER_DOMAIN,
    category: "action",
    title: "Show or Hide Object",
    description: "Shows or hides a level object (hidden objects also stop colliding).",
    inputs: [EXEC_IN, { id: "objectId", kind: "data", type: "text", label: "Object id", param: "objectId" }],
    outputs: [EXEC_OUT],
    params: [
      { id: "objectId", label: "Object id (when unconnected)", kind: "text", default: "", maxLength: 48 },
      { id: "visible", label: "Visible", kind: "boolean", default: true },
    ],
    keywords: ["hide", "reveal", "appear"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("platformer.setVisible", { objectId: ctx.input("objectId"), visible: { e: "const", v: ctx.param<boolean>("visible") } }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: PLATFORMER_NODE.win,
    domain: PLATFORMER_DOMAIN,
    category: "action",
    title: "Win Level",
    description: "Shows the level-complete screen.",
    inputs: [EXEC_IN, { id: "text", kind: "data", type: "text", label: "Text", param: "text" }],
    outputs: [EXEC_OUT],
    params: [{ id: "text", label: "Text (when unconnected)", kind: "text", default: "Level complete!", maxLength: 200 }],
    keywords: ["finish", "victory", "end"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("platformer.win", { text: ctx.input("text") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: PLATFORMER_NODE.collected,
    domain: PLATFORMER_DOMAIN,
    category: "query",
    title: "Coins Collected",
    description: "How many coins of a kind the player has collected.",
    inputs: [],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Collected" }],
    params: [{ id: "kind", label: "Kind", kind: "text", default: "coin", maxLength: 32 }],
    compileExpr: (ctx) => ({ e: "query", fn: "platformer.collectedCount", args: { kind: { e: "const", v: ctx.param<string>("kind") } } }),
  },
  {
    type: PLATFORMER_NODE.total,
    domain: PLATFORMER_DOMAIN,
    category: "query",
    title: "Coins In Level",
    description: "How many coins of a kind the level holds.",
    inputs: [],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Total" }],
    params: [{ id: "kind", label: "Kind", kind: "text", default: "coin", maxLength: 32 }],
    compileExpr: (ctx) => ({ e: "query", fn: "platformer.totalCount", args: { kind: { e: "const", v: ctx.param<string>("kind") } } }),
  },
  {
    type: PLATFORMER_NODE.doorOpen,
    domain: PLATFORMER_DOMAIN,
    category: "query",
    title: "Is Door Open?",
    description: "Whether a door has been opened.",
    inputs: [],
    outputs: [{ id: "value", kind: "data", type: "boolean", label: "Open" }],
    params: [{ id: "doorId", label: "Door id", kind: "text", default: "door_goal", maxLength: 48 }],
    compileExpr: (ctx) => ({ e: "query", fn: "platformer.isDoorOpen", args: { doorId: { e: "const", v: ctx.param<string>("doorId") } } }),
  },
  {
    type: PLATFORMER_NODE.hurts,
    domain: PLATFORMER_DOMAIN,
    category: "query",
    title: "Times Hurt",
    description: "How many times the player has been hurt so far.",
    inputs: [],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Times" }],
    params: [],
    compileExpr: () => ({ e: "query", fn: "platformer.hurtCount", args: {} }),
  },
];

export const platformerDomain: DomainSpec = {
  id: PLATFORMER_DOMAIN,
  title: "2D platformer",
  description: "Side-scrolling level: coins, checkpoints, hazards, enemies, doors and the goal.",
  nodes: platformerNodes,
  hostFunctions: {
    calls: ["platformer.message", "platformer.objective", "platformer.openDoor", "platformer.sound", "platformer.setVisible", "platformer.win"],
    queries: ["platformer.collectedCount", "platformer.totalCount", "platformer.isDoorOpen", "platformer.hurtCount"],
  },
};

/** The Sunset Cliffs rules: objective from the coin count, progress messages, the gate, checkpoints and the win. */
export function cliffRules(): RuleGraph {
  const N = PLATFORMER_NODE;
  const g = new GraphBuilder("cliff-rules", "Sunset Cliffs rules", PLATFORMER_DOMAIN, "Coin counting, the coin-locked gate, checkpoints, hazards and reaching the flag.");

  g.node("start", "core.event.start", {}, { x: 0, y: -360 });
  g.node("totalStart", N.total, { kind: "coin" }, { x: 0, y: -220 });
  g.node("objText1", "core.text.join", { a: "Collect all " }, { x: 300, y: -220 });
  g.node("objText2", "core.text.join", { b: " sun coins to open the gate, then reach the flag." }, { x: 600, y: -220 });
  g.node("objective1", N.objective, {}, { x: 300, y: -380 });
  g.node("welcome", N.message, { text: "Arrow keys or A and D run, Space jumps (hold it to jump higher). Jump on beetles to stomp them.", seconds: 6 }, { x: 900, y: -380 });
  g.exec("start", "out", "objective1").exec("objective1", "out", "welcome");
  g.data("totalStart", "value", "objText1", "b").data("objText1", "result", "objText2", "a").data("objText2", "result", "objective1", "text");

  g.node("collect", N.collect, {}, { x: 0, y: 0 });
  g.node("coinSound", N.sound, { sound: "coin" }, { x: 300, y: 0 });
  g.node("got", N.collected, { kind: "coin" }, { x: 300, y: 160 });
  g.node("all", N.total, { kind: "coin" }, { x: 300, y: 280 });
  g.node("progress1", "core.text.join", { a: "Sun coin " }, { x: 600, y: 160 });
  g.node("progress2", "core.text.join", { a: " of " }, { x: 600, y: 280 });
  g.node("progress3", "core.text.join", {}, { x: 900, y: 220 });
  g.node("progressMsg", N.message, { seconds: 2 }, { x: 600, y: 0 });
  g.node("enough", "core.compare.number", { operator: ">=" }, { x: 900, y: 360 });
  g.node("allFound", "core.flow.branch", {}, { x: 900, y: 0 });
  g.node("open", N.openDoor, { doorId: "door_goal" }, { x: 1200, y: 0 });
  g.node("doorSound", N.sound, { sound: "door" }, { x: 1500, y: 0 });
  g.node("objective2", N.objective, { text: "The gate is open. Run to the sunset flag!" }, { x: 1800, y: 0 });
  g.exec("collect", "out", "coinSound").exec("coinSound", "out", "progressMsg").exec("progressMsg", "out", "allFound").exec("allFound", "true", "open").exec("open", "out", "doorSound").exec("doorSound", "out", "objective2");
  g.data("got", "value", "progress1", "b").data("all", "value", "progress2", "b").data("progress1", "result", "progress3", "a").data("progress2", "result", "progress3", "b").data("progress3", "result", "progressMsg", "text");
  g.data("got", "value", "enough", "a").data("all", "value", "enough", "b").data("enough", "result", "allFound", "condition");

  g.node("checkpoint", N.checkpoint, {}, { x: 0, y: 560 });
  g.node("cpSound", N.sound, { sound: "checkpoint" }, { x: 300, y: 560 });
  g.node("cpMsg", N.message, { text: "Checkpoint! You come back here if you get hurt.", seconds: 3 }, { x: 600, y: 560 });
  g.exec("checkpoint", "out", "cpSound").exec("cpSound", "out", "cpMsg");

  g.node("hurt", N.hurt, {}, { x: 0, y: 760 });
  g.node("hurtSound", N.sound, { sound: "hurt" }, { x: 300, y: 760 });
  g.exec("hurt", "out", "hurtSound");

  g.node("stomp", N.stomp, {}, { x: 0, y: 900 });
  g.node("stompSound", N.sound, { sound: "stomp" }, { x: 300, y: 900 });
  g.exec("stomp", "out", "stompSound");

  g.node("goal", N.goal, {}, { x: 0, y: 1060 });
  g.node("fanfare", N.sound, { sound: "success" }, { x: 300, y: 1060 });
  g.node("victory", N.win, { text: "You reached the sunset flag. Level complete!" }, { x: 600, y: 1060 });
  g.exec("goal", "out", "fanfare").exec("fanfare", "out", "victory");
  return g.build();
}
