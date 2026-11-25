import { callStmt, GraphBuilder, type DomainSpec, type NodeSpec, type RuleGraph, type Stmt } from "@gamestudio/rules-core";

const EXEC_IN = { id: "in", kind: "exec" } as const;
const EXEC_OUT = { id: "out", kind: "exec" } as const;
const trace = (node: string): Stmt => ({ s: "trace", node });

export const EXPLORE_DOMAIN = "explore";

export const EXPLORE_NODE = {
  collect: "explore.event.collect",
  interact: "explore.event.interact",
  enterZone: "explore.event.enterZone",
  message: "explore.action.message",
  objective: "explore.action.objective",
  openGate: "explore.action.openGate",
  sound: "explore.action.sound",
  setVisible: "explore.action.setVisible",
  win: "explore.action.win",
  collected: "explore.query.collected",
  total: "explore.query.total",
  gateOpen: "explore.query.gateOpen",
  // Adventure pieces (Godot projects only): enemies and health, pushable blocks, timers.
  enemyDefeated: "explore.event.enemyDefeated",
  playerHurt: "explore.event.playerHurt",
  playerDefeated: "explore.event.playerDefeated",
  blockInZone: "explore.event.blockInZone",
  timer: "explore.event.timer",
  hurtPlayer: "explore.action.hurtPlayer",
  healPlayer: "explore.action.healPlayer",
  startTimer: "explore.action.startTimer",
  stopTimer: "explore.action.stopTimer",
  health: "explore.query.health",
  defeated: "explore.query.defeated",
  enemies: "explore.query.enemies",
  blocksInZone: "explore.query.blocksInZone",
  timeLeft: "explore.query.timeLeft",
} as const;

/** Nodes for enemies, health, blocks and timers run only in the Godot game (the Unity and Unreal valleys have none of these). */
const GODOT_ONLY = ["godot"] as const;

export const SOUNDS = ["chime", "gate", "success", "error"] as const;

function event(type: string, name: string, title: string, description: string, payload: { id: string; label: string }[], engines?: readonly string[]): NodeSpec {
  return {
    type,
    domain: EXPLORE_DOMAIN,
    category: "event",
    title,
    description,
    inputs: [],
    outputs: [EXEC_OUT, ...payload.map((p) => ({ id: p.id, kind: "data" as const, type: "text" as const, label: p.label }))],
    params: [],
    event: { name },
    maxPerGraph: 1,
    compileExec: (ctx) => [trace(ctx.node.id), ...ctx.follow("out")],
    ...(engines ? { engines } : {}),
  };
}

export const exploreNodes: NodeSpec[] = [
  event(EXPLORE_NODE.collect, "collect", "On Item Collected", "The player picked up a collectible.", [
    { id: "itemId", label: "Item id" },
    { id: "kind", label: "Kind" },
  ]),
  event(EXPLORE_NODE.interact, "interact", "On Interact", "The player pressed the interact key next to a character or sign.", [{ id: "targetId", label: "Target id" }]),
  event(EXPLORE_NODE.enterZone, "enterZone", "On Enter Zone", "The player walked into a zone.", [{ id: "zoneId", label: "Zone id" }]),
  {
    type: EXPLORE_NODE.message,
    domain: EXPLORE_DOMAIN,
    category: "action",
    title: "Show Message",
    description: "Shows a message on screen for a few seconds.",
    inputs: [EXEC_IN, { id: "text", kind: "data", type: "text", label: "Text", param: "text" }],
    outputs: [EXEC_OUT],
    params: [
      { id: "text", label: "Text (when unconnected)", kind: "text", default: "", maxLength: 300, multiline: true },
      { id: "seconds", label: "Seconds on screen", kind: "number", default: 4, min: 1, max: 20 },
    ],
    keywords: ["say", "dialogue", "text", "hud"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("explore.message", { text: ctx.input("text"), seconds: { e: "const", v: ctx.param<number>("seconds") } }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: EXPLORE_NODE.objective,
    domain: EXPLORE_DOMAIN,
    category: "action",
    title: "Set Objective",
    description: "Replaces the objective shown in the corner of the screen.",
    inputs: [EXEC_IN, { id: "text", kind: "data", type: "text", label: "Text", param: "text" }],
    outputs: [EXEC_OUT],
    params: [{ id: "text", label: "Objective (when unconnected)", kind: "text", default: "", maxLength: 200 }],
    keywords: ["quest", "goal", "task"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("explore.objective", { text: ctx.input("text") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: EXPLORE_NODE.openGate,
    domain: EXPLORE_DOMAIN,
    category: "action",
    title: "Open Gate",
    description: "Opens a gate so the player can pass.",
    inputs: [EXEC_IN, { id: "gateId", kind: "data", type: "text", label: "Gate id", param: "gateId" }],
    outputs: [EXEC_OUT],
    params: [{ id: "gateId", label: "Gate id (when unconnected)", kind: "text", default: "gate_main", maxLength: 48 }],
    keywords: ["door", "unlock"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("explore.openGate", { gateId: ctx.input("gateId") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: EXPLORE_NODE.sound,
    domain: EXPLORE_DOMAIN,
    category: "action",
    title: "Play Sound",
    description: "Plays one of the template's generated sound cues.",
    inputs: [EXEC_IN],
    outputs: [EXEC_OUT],
    params: [{ id: "sound", label: "Sound", kind: "select", default: "chime", options: SOUNDS.map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) })) }],
    keywords: ["audio", "sfx"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("explore.sound", { sound: { e: "const", v: ctx.param<string>("sound") } }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: EXPLORE_NODE.setVisible,
    domain: EXPLORE_DOMAIN,
    category: "action",
    title: "Show or Hide Object",
    description: "Shows or hides a world object (hidden objects also stop colliding).",
    inputs: [EXEC_IN, { id: "objectId", kind: "data", type: "text", label: "Object id", param: "objectId" }],
    outputs: [EXEC_OUT],
    params: [
      { id: "objectId", label: "Object id (when unconnected)", kind: "text", default: "", maxLength: 48 },
      { id: "visible", label: "Visible", kind: "boolean", default: true },
    ],
    keywords: ["hide", "reveal", "appear"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("explore.setVisible", { objectId: ctx.input("objectId"), visible: { e: "const", v: ctx.param<boolean>("visible") } }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: EXPLORE_NODE.win,
    domain: EXPLORE_DOMAIN,
    category: "action",
    title: "Complete Level",
    description: "Ends the level with a victory message.",
    inputs: [EXEC_IN, { id: "text", kind: "data", type: "text", label: "Text", param: "text" }],
    outputs: [EXEC_OUT],
    params: [{ id: "text", label: "Message (when unconnected)", kind: "text", default: "Level complete!", maxLength: 200 }],
    keywords: ["victory", "finish", "end"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("explore.win", { text: ctx.input("text") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: EXPLORE_NODE.collected,
    domain: EXPLORE_DOMAIN,
    category: "query",
    title: "Items Collected",
    description: "How many collectibles of a kind the player has picked up.",
    inputs: [{ id: "kind", kind: "data", type: "text", label: "Kind", param: "kind" }],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Count" }],
    params: [{ id: "kind", label: "Kind (when unconnected)", kind: "text", default: "crystal", maxLength: 32 }],
    keywords: ["count", "inventory"],
    compileExpr: (ctx) => ({ e: "query", fn: "explore.collectedCount", args: { kind: ctx.input("kind") } }),
  },
  {
    type: EXPLORE_NODE.total,
    domain: EXPLORE_DOMAIN,
    category: "query",
    title: "Items In Level",
    description: "How many collectibles of a kind the level contains in total.",
    inputs: [{ id: "kind", kind: "data", type: "text", label: "Kind", param: "kind" }],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Count" }],
    params: [{ id: "kind", label: "Kind (when unconnected)", kind: "text", default: "crystal", maxLength: 32 }],
    keywords: ["count", "total"],
    compileExpr: (ctx) => ({ e: "query", fn: "explore.totalCount", args: { kind: ctx.input("kind") } }),
  },
  {
    type: EXPLORE_NODE.gateOpen,
    domain: EXPLORE_DOMAIN,
    category: "query",
    title: "Is Gate Open?",
    description: "True once the gate has been opened.",
    inputs: [{ id: "gateId", kind: "data", type: "text", label: "Gate id", param: "gateId" }],
    outputs: [{ id: "value", kind: "data", type: "boolean", label: "Open" }],
    params: [{ id: "gateId", label: "Gate id (when unconnected)", kind: "text", default: "gate_main", maxLength: 48 }],
    compileExpr: (ctx) => ({ e: "query", fn: "explore.isGateOpen", args: { gateId: ctx.input("gateId") } }),
  },

  // ---- Enemies and health (Godot) --------------------------------------------------------
  event(EXPLORE_NODE.enemyDefeated, "enemyDefeated", "On Enemy Defeated", "The player's attack took an enemy's last health point.", [
    { id: "enemyId", label: "Enemy id" },
    { id: "kind", label: "Kind" },
  ], GODOT_ONLY),
  event(EXPLORE_NODE.playerHurt, "playerHurt", "On Player Hurt", "An enemy hit the player and took hearts (Hurt Player does not fire this).", [{ id: "sourceId", label: "Enemy id" }], GODOT_ONLY),
  event(EXPLORE_NODE.playerDefeated, "playerDefeated", "On Player Defeated", "The player ran out of hearts. Afterwards the game brings the player back at the spawn point with full health.", [{ id: "sourceId", label: "Cause (enemy id or rules)" }], GODOT_ONLY),
  {
    type: EXPLORE_NODE.hurtPlayer,
    domain: EXPLORE_DOMAIN,
    category: "action",
    title: "Hurt Player",
    description: "Takes hearts from the player (for traps, lava or a failed challenge). At none, On Player Defeated runs.",
    inputs: [EXEC_IN, { id: "amount", kind: "data", type: "number", label: "Hearts", param: "amount" }],
    outputs: [EXEC_OUT],
    params: [{ id: "amount", label: "Hearts (when unconnected)", kind: "number", default: 1, min: 1, max: 20 }],
    keywords: ["damage", "health", "hearts", "trap"],
    engines: GODOT_ONLY,
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("explore.hurtPlayer", { amount: ctx.input("amount") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: EXPLORE_NODE.healPlayer,
    domain: EXPLORE_DOMAIN,
    category: "action",
    title: "Heal Player",
    description: "Gives the player hearts back, up to the level's starting health.",
    inputs: [EXEC_IN, { id: "amount", kind: "data", type: "number", label: "Hearts", param: "amount" }],
    outputs: [EXEC_OUT],
    params: [{ id: "amount", label: "Hearts (when unconnected)", kind: "number", default: 1, min: 1, max: 20 }],
    keywords: ["health", "hearts", "restore", "potion"],
    engines: GODOT_ONLY,
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("explore.healPlayer", { amount: ctx.input("amount") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: EXPLORE_NODE.health,
    domain: EXPLORE_DOMAIN,
    category: "query",
    title: "Player Health",
    description: "How many hearts the player has now.",
    inputs: [],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Hearts" }],
    params: [],
    keywords: ["hearts", "life", "hp"],
    engines: GODOT_ONLY,
    compileExpr: () => ({ e: "query", fn: "explore.playerHealth", args: {} }),
  },
  {
    type: EXPLORE_NODE.defeated,
    domain: EXPLORE_DOMAIN,
    category: "query",
    title: "Enemies Defeated",
    description: "How many enemies of a kind the player has defeated.",
    inputs: [{ id: "kind", kind: "data", type: "text", label: "Kind", param: "kind" }],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Count" }],
    params: [{ id: "kind", label: "Kind (when unconnected)", kind: "text", default: "beetle", maxLength: 32 }],
    keywords: ["count", "kills", "enemy"],
    engines: GODOT_ONLY,
    compileExpr: (ctx) => ({ e: "query", fn: "explore.defeatedCount", args: { kind: ctx.input("kind") } }),
  },
  {
    type: EXPLORE_NODE.enemies,
    domain: EXPLORE_DOMAIN,
    category: "query",
    title: "Enemies In Level",
    description: "How many enemies of a kind the level contains in total.",
    inputs: [{ id: "kind", kind: "data", type: "text", label: "Kind", param: "kind" }],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Count" }],
    params: [{ id: "kind", label: "Kind (when unconnected)", kind: "text", default: "beetle", maxLength: 32 }],
    keywords: ["count", "total", "enemy"],
    engines: GODOT_ONLY,
    compileExpr: (ctx) => ({ e: "query", fn: "explore.enemyCount", args: { kind: ctx.input("kind") } }),
  },

  // ---- Pushable blocks (Godot) -----------------------------------------------------------
  event(EXPLORE_NODE.blockInZone, "blockInZone", "On Block Enters Zone", "The player pushed a block into a zone (its middle crossed the zone's edge).", [
    { id: "blockId", label: "Block id" },
    { id: "zoneId", label: "Zone id" },
  ], GODOT_ONLY),
  {
    type: EXPLORE_NODE.blocksInZone,
    domain: EXPLORE_DOMAIN,
    category: "query",
    title: "Blocks In Zone",
    description: "How many blocks stand in a zone now (a block counts while its middle is inside the zone).",
    inputs: [{ id: "zoneId", kind: "data", type: "text", label: "Zone id", param: "zoneId" }],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Count" }],
    params: [{ id: "zoneId", label: "Zone id (when unconnected)", kind: "text", default: "", maxLength: 48 }],
    keywords: ["crate", "plate", "switch", "push", "puzzle"],
    engines: GODOT_ONLY,
    compileExpr: (ctx) => ({ e: "query", fn: "explore.blocksInZone", args: { zoneId: ctx.input("zoneId") } }),
  },

  // ---- Timers (Godot) -------------------------------------------------------------------
  event(EXPLORE_NODE.timer, "timer", "On Timer", "A timer started with Start Timer ran out (a repeating timer fires each time round).", [{ id: "timerId", label: "Timer" }], GODOT_ONLY),
  {
    type: EXPLORE_NODE.startTimer,
    domain: EXPLORE_DOMAIN,
    category: "action",
    title: "Start Timer",
    description: "Starts (or restarts) a named timer; On Timer runs when it reaches zero. With a countdown label, the time left shows on screen.",
    inputs: [
      EXEC_IN,
      { id: "timerId", kind: "data", type: "text", label: "Timer", param: "timerId" },
      { id: "seconds", kind: "data", type: "number", label: "Seconds", param: "seconds" },
    ],
    outputs: [EXEC_OUT],
    params: [
      { id: "timerId", label: "Timer (when unconnected)", kind: "text", default: "timer", maxLength: 32 },
      { id: "seconds", label: "Seconds (when unconnected)", kind: "number", default: 30, min: 0.1, max: 3600 },
      { id: "repeat", label: "Repeat", kind: "boolean", default: false },
      { id: "countdown", label: "Countdown label (empty hides it)", kind: "text", default: "", maxLength: 40 },
    ],
    keywords: ["clock", "countdown", "time", "delay", "wait", "every"],
    engines: GODOT_ONLY,
    compileExec: (ctx) => [
      trace(ctx.node.id),
      callStmt(
        "explore.startTimer",
        { timerId: ctx.input("timerId"), seconds: ctx.input("seconds"), repeat: { e: "const", v: ctx.param<boolean>("repeat") }, countdown: { e: "const", v: ctx.param<string>("countdown") } },
        ctx.node.id,
      ),
      ...ctx.follow("out"),
    ],
  },
  {
    type: EXPLORE_NODE.stopTimer,
    domain: EXPLORE_DOMAIN,
    category: "action",
    title: "Stop Timer",
    description: "Stops a named timer without running On Timer, and hides its countdown.",
    inputs: [EXEC_IN, { id: "timerId", kind: "data", type: "text", label: "Timer", param: "timerId" }],
    outputs: [EXEC_OUT],
    params: [{ id: "timerId", label: "Timer (when unconnected)", kind: "text", default: "timer", maxLength: 32 }],
    keywords: ["clock", "cancel", "time"],
    engines: GODOT_ONLY,
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("explore.stopTimer", { timerId: ctx.input("timerId") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: EXPLORE_NODE.timeLeft,
    domain: EXPLORE_DOMAIN,
    category: "query",
    title: "Time Left",
    description: "Seconds left on a named timer (0 when it is not running).",
    inputs: [{ id: "timerId", kind: "data", type: "text", label: "Timer", param: "timerId" }],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Seconds" }],
    params: [{ id: "timerId", label: "Timer (when unconnected)", kind: "text", default: "timer", maxLength: 32 }],
    keywords: ["clock", "countdown", "remaining"],
    engines: GODOT_ONLY,
    compileExpr: (ctx) => ({ e: "query", fn: "explore.timeLeft", args: { timerId: ctx.input("timerId") } }),
  },
];

export const exploreDomain: DomainSpec = {
  id: EXPLORE_DOMAIN,
  title: "3D world",
  description: "Collectibles, characters, gates, zones and on-screen messages for 3D exploration and adventure games; in Godot projects also enemies, health, pushable blocks and timers.",
  nodes: exploreNodes,
  hostFunctions: {
    calls: ["explore.message", "explore.objective", "explore.openGate", "explore.sound", "explore.setVisible", "explore.win", "explore.hurtPlayer", "explore.healPlayer", "explore.startTimer", "explore.stopTimer"],
    queries: ["explore.collectedCount", "explore.totalCount", "explore.isGateOpen", "explore.playerHealth", "explore.defeatedCount", "explore.enemyCount", "explore.blocksInZone", "explore.timeLeft"],
  },
};

/** Rules for Sun Crystal Valley: collect three crystals to open the shrine gate, then enter the shrine. */
export function valleyRules(): RuleGraph {
  const N = EXPLORE_NODE;
  const g = new GraphBuilder("valley-rules", "Sun Crystal Valley rules", EXPLORE_DOMAIN, "Objectives, crystal counting, the elder's dialogue and the shrine gate.");
  g.variable("talkedToElder", "boolean", false, "Has the player spoken to Elder Ama?");

  // On Start: objective from the number of crystals in the level.
  g.node("start", "core.event.start", {}, { x: 0, y: -360 });
  g.node("totalStart", N.total, { kind: "crystal" }, { x: 0, y: -220 });
  g.node("objText1", "core.text.join", { a: "Find the " }, { x: 300, y: -220 });
  g.node("objText2", "core.text.join", { b: " sun crystals hidden in the valley." }, { x: 600, y: -220 });
  g.node("objective1", N.objective, {}, { x: 300, y: -380 });
  g.node("welcome", N.message, { text: "Welcome, traveller. Walk with W A S D, look with the mouse, press E to talk.", seconds: 6 }, { x: 900, y: -380 });
  g.exec("start", "out", "objective1").exec("objective1", "out", "welcome");
  g.data("totalStart", "value", "objText1", "b").data("objText1", "result", "objText2", "a").data("objText2", "result", "objective1", "text");

  // On Item Collected: chime, progress message, open the gate when all crystals are found.
  g.node("collect", N.collect, {}, { x: 0, y: 0 });
  g.node("chime", N.sound, { sound: "chime" }, { x: 300, y: 0 });
  g.node("got", N.collected, { kind: "crystal" }, { x: 300, y: 160 });
  g.node("all", N.total, { kind: "crystal" }, { x: 300, y: 280 });
  g.node("progress1", "core.text.join", { a: "Sun crystal " }, { x: 600, y: 160 });
  g.node("progress2", "core.text.join", { a: " of " }, { x: 600, y: 280 });
  g.node("progress3", "core.text.join", {}, { x: 900, y: 220 });
  g.node("progressMsg", N.message, { seconds: 3 }, { x: 600, y: 0 });
  g.node("enough", "core.compare.number", { operator: ">=" }, { x: 900, y: 360 });
  g.node("allFound", "core.flow.branch", {}, { x: 900, y: 0 });
  g.node("open", N.openGate, { gateId: "gate_main" }, { x: 1200, y: 0 });
  g.node("gateSound", N.sound, { sound: "gate" }, { x: 1500, y: 0 });
  g.node("objective2", N.objective, { text: "The shrine gate is open. Enter the sun shrine." }, { x: 1800, y: 0 });
  g.exec("collect", "out", "chime").exec("chime", "out", "progressMsg").exec("progressMsg", "out", "allFound").exec("allFound", "true", "open").exec("open", "out", "gateSound").exec("gateSound", "out", "objective2");
  g.data("got", "value", "progress1", "b").data("all", "value", "progress2", "b").data("progress1", "result", "progress3", "a").data("progress2", "result", "progress3", "b").data("progress3", "result", "progressMsg", "text");
  g.data("got", "value", "enough", "a").data("all", "value", "enough", "b").data("enough", "result", "allFound", "condition");

  // On Interact: Elder Ama's dialogue changes after the first conversation.
  g.node("interact", N.interact, {}, { x: 0, y: 560 });
  g.node("isElder", "core.compare.text", { b: "elder" }, { x: 300, y: 700 });
  g.node("elderBranch", "core.flow.branch", {}, { x: 300, y: 560 });
  g.node("talked", "core.var.get", { variable: "talkedToElder" }, { x: 600, y: 700 });
  g.node("firstTime", "core.flow.branch", {}, { x: 600, y: 560 });
  g.node("again", N.message, { text: "Elder Ama: “Have you found every crystal? The shrine waits in the north.”", seconds: 5 }, { x: 900, y: 460 });
  g.node("remember", "core.var.set", { variable: "talkedToElder", value: true }, { x: 900, y: 600 });
  g.node("hint", N.message, { text: "Elder Ama: “Three sun crystals hide by the water, among the stones and beneath the great baobab.”", seconds: 7 }, { x: 1200, y: 600 });
  g.exec("interact", "out", "elderBranch").exec("elderBranch", "true", "firstTime").exec("firstTime", "true", "again").exec("firstTime", "false", "remember").exec("remember", "out", "hint");
  g.data("interact", "targetId", "isElder", "a").data("isElder", "result", "elderBranch", "condition").data("talked", "value", "firstTime", "condition");

  // On Enter Zone: entering the shrine after the gate opens completes the level.
  g.node("zone", N.enterZone, {}, { x: 0, y: 900 });
  g.node("isShrine", "core.compare.text", { b: "shrine" }, { x: 300, y: 1040 });
  g.node("shrineBranch", "core.flow.branch", {}, { x: 300, y: 900 });
  g.node("gateOpen", N.gateOpen, { gateId: "gate_main" }, { x: 600, y: 1040 });
  g.node("openBranch", "core.flow.branch", {}, { x: 600, y: 900 });
  g.node("fanfare", N.sound, { sound: "success" }, { x: 900, y: 900 });
  g.node("victory", N.win, { text: "You reached the sun shrine. The valley glows again!" }, { x: 1200, y: 900 });
  g.exec("zone", "out", "shrineBranch").exec("shrineBranch", "true", "openBranch").exec("openBranch", "true", "fanfare").exec("fanfare", "out", "victory");
  g.data("zone", "zoneId", "isShrine", "a").data("isShrine", "result", "shrineBranch", "condition").data("gateOpen", "value", "openBranch", "condition");
  return g.build();
}

/**
 * Rules for Thornwood Ruins: defeat the thorn beetles, push both stone blocks onto the plates to open
 * the gate (which starts the sunset timer), and light the beacon; the spring heals.
 */
export function ruinsRules(): RuleGraph {
  const N = EXPLORE_NODE;
  const g = new GraphBuilder("ruins-rules", "Thornwood Ruins rules", EXPLORE_DOMAIN, "Beetles, the plates and the gate, the sunset timer, the spring and the beacon.");
  g.variable("talkedToRanger", "boolean", false, "Has the player spoken to Ranger Kofi?");
  g.variable("sunsetBonus", "boolean", true, "Still before sunset? The sunset timer turns it off.");

  // On Start: objective from the number of beetles.
  g.node("start", "core.event.start", {}, { x: 0, y: -400 });
  g.node("beetlesStart", N.enemies, { kind: "beetle" }, { x: 0, y: -260 });
  g.node("objText1", "core.text.join", { a: "Defeat the " }, { x: 300, y: -260 });
  g.node("objText2", "core.text.join", { b: " thorn beetles in the ruins." }, { x: 600, y: -260 });
  g.node("objective1", N.objective, {}, { x: 300, y: -420 });
  g.node("welcome", N.message, { text: "Ranger Kofi waits by the camp fires. Press E to talk to him, and F or a click to swing your staff.", seconds: 6 }, { x: 900, y: -420 });
  g.exec("start", "out", "objective1").exec("objective1", "out", "welcome");
  g.data("beetlesStart", "value", "objText1", "b").data("objText1", "result", "objText2", "a").data("objText2", "result", "objective1", "text");

  // On Enemy Defeated: count, and once all are down (and the gate is still shut) point at the blocks.
  g.node("defeated", N.enemyDefeated, {}, { x: 0, y: 0 });
  g.node("chime", N.sound, { sound: "chime" }, { x: 300, y: 0 });
  g.node("down", N.defeated, { kind: "beetle" }, { x: 300, y: 160 });
  g.node("all", N.enemies, { kind: "beetle" }, { x: 300, y: 280 });
  g.node("count1", "core.text.join", { a: "Thorn beetle defeated: " }, { x: 600, y: 160 });
  g.node("count2", "core.text.join", { a: " of " }, { x: 600, y: 280 });
  g.node("count3", "core.text.join", {}, { x: 900, y: 220 });
  g.node("countMsg", N.message, { seconds: 3 }, { x: 600, y: 0 });
  g.node("allDown", "core.compare.number", { operator: ">=" }, { x: 900, y: 360 });
  g.node("allBranch", "core.flow.branch", {}, { x: 900, y: 0 });
  g.node("gateOpen1", N.gateOpen, { gateId: "gate_ruins" }, { x: 1200, y: 160 });
  g.node("gateShut1", "core.logic.not", {}, { x: 1200, y: 280 });
  g.node("shutBranch", "core.flow.branch", {}, { x: 1200, y: 0 });
  g.node("objective2", N.objective, { text: "Push the two stone blocks onto the glowing plates." }, { x: 1500, y: 0 });
  g.node("clearMsg", N.message, { text: "The ruins are clear. Two stone blocks wait south of the old gate.", seconds: 5 }, { x: 1800, y: 0 });
  g.exec("defeated", "out", "chime").exec("chime", "out", "countMsg").exec("countMsg", "out", "allBranch").exec("allBranch", "true", "shutBranch").exec("shutBranch", "true", "objective2").exec("objective2", "out", "clearMsg");
  g.data("down", "value", "count1", "b").data("all", "value", "count2", "b").data("count1", "result", "count3", "a").data("count2", "result", "count3", "b").data("count3", "result", "countMsg", "text");
  g.data("down", "value", "allDown", "a").data("all", "value", "allDown", "b").data("allDown", "result", "allBranch", "condition");
  g.data("gateOpen1", "value", "gateShut1", "a").data("gateShut1", "result", "shutBranch", "condition");

  // On Player Hurt: a hint when one heart is left.
  g.node("hurt", N.playerHurt, {}, { x: 0, y: 560 });
  g.node("hearts", N.health, {}, { x: 300, y: 700 });
  g.node("low", "core.compare.number", { operator: "<=", b: 1 }, { x: 600, y: 700 });
  g.node("lowBranch", "core.flow.branch", {}, { x: 300, y: 560 });
  g.node("lowMsg", N.message, { text: "Careful! The healing spring west of the camp restores your hearts.", seconds: 5 }, { x: 600, y: 560 });
  g.exec("hurt", "out", "lowBranch").exec("lowBranch", "true", "lowMsg");
  g.data("hearts", "value", "low", "a").data("low", "result", "lowBranch", "condition");

  // On Player Defeated: the game sends the player back to the camp with full health.
  g.node("fallen", N.playerDefeated, {}, { x: 0, y: 860 });
  g.node("fallenMsg", N.message, { text: "The beetles drove you back to the camp. What you did in the ruins still stands.", seconds: 5 }, { x: 300, y: 860 });
  g.exec("fallen", "out", "fallenMsg");

  // On Interact: Ranger Kofi explains once, then reminds.
  g.node("interact", N.interact, {}, { x: 0, y: 1060 });
  g.node("isRanger", "core.compare.text", { b: "ranger" }, { x: 300, y: 1200 });
  g.node("rangerBranch", "core.flow.branch", {}, { x: 300, y: 1060 });
  g.node("talked", "core.var.get", { variable: "talkedToRanger" }, { x: 600, y: 1200 });
  g.node("firstTime", "core.flow.branch", {}, { x: 600, y: 1060 });
  g.node("again", N.message, { text: "Ranger Kofi: “Beetles first, then the blocks onto the plates. Light the beacon before the sun goes down!”", seconds: 5 }, { x: 900, y: 960 });
  g.node("remember", "core.var.set", { variable: "talkedToRanger", value: true }, { x: 900, y: 1100 });
  g.node("brief", N.message, { text: "Ranger Kofi: “Thorn beetles have taken the old ruins. Strike them with your staff. Then push the two stone blocks onto the plates and the gate will open.”", seconds: 7 }, { x: 1200, y: 1100 });
  g.exec("interact", "out", "rangerBranch").exec("rangerBranch", "true", "firstTime").exec("firstTime", "true", "again").exec("firstTime", "false", "remember").exec("remember", "out", "brief");
  g.data("interact", "targetId", "isRanger", "a").data("isRanger", "result", "rangerBranch", "condition").data("talked", "value", "firstTime", "condition");

  // On Block Enters Zone: both plates pressed and the gate still shut → open it and start the sunset timer.
  g.node("pushed", N.blockInZone, {}, { x: 0, y: 1400 });
  g.node("onPlate1", N.blocksInZone, { zoneId: "plate_1" }, { x: 300, y: 1540 });
  g.node("onPlate2", N.blocksInZone, { zoneId: "plate_2" }, { x: 300, y: 1660 });
  g.node("pressed1", "core.compare.number", { operator: ">=", b: 1 }, { x: 600, y: 1540 });
  g.node("pressed2", "core.compare.number", { operator: ">=", b: 1 }, { x: 600, y: 1660 });
  g.node("bothPressed", "core.logic.and", {}, { x: 900, y: 1600 });
  g.node("gateOpen2", N.gateOpen, { gateId: "gate_ruins" }, { x: 900, y: 1720 });
  g.node("gateShut2", "core.logic.not", {}, { x: 1200, y: 1720 });
  g.node("readyToOpen", "core.logic.and", {}, { x: 1200, y: 1600 });
  g.node("openBranch", "core.flow.branch", {}, { x: 300, y: 1400 });
  g.node("open", N.openGate, { gateId: "gate_ruins" }, { x: 600, y: 1400 });
  g.node("gateSound", N.sound, { sound: "gate" }, { x: 900, y: 1400 });
  g.node("objective3", N.objective, { text: "Light the beacon beyond the gate before sunset." }, { x: 1200, y: 1400 });
  g.node("sunset", N.startTimer, { timerId: "sunset", seconds: 90, repeat: false, countdown: "Sunset in" }, { x: 1500, y: 1400 });
  g.node("hurryMsg", N.message, { text: "The gate grinds open. Hurry, the sun is going down!", seconds: 5 }, { x: 1800, y: 1400 });
  g.exec("pushed", "out", "openBranch").exec("openBranch", "true", "open").exec("open", "out", "gateSound").exec("gateSound", "out", "objective3").exec("objective3", "out", "sunset").exec("sunset", "out", "hurryMsg");
  g.data("onPlate1", "value", "pressed1", "a").data("onPlate2", "value", "pressed2", "a").data("pressed1", "result", "bothPressed", "a").data("pressed2", "result", "bothPressed", "b");
  g.data("gateOpen2", "value", "gateShut2", "a").data("bothPressed", "result", "readyToOpen", "a").data("gateShut2", "result", "readyToOpen", "b").data("readyToOpen", "result", "openBranch", "condition");

  // On Timer: the sun sets; the beacon still works, without the bonus.
  g.node("timer", N.timer, {}, { x: 0, y: 1900 });
  g.node("isSunset", "core.compare.text", { b: "sunset" }, { x: 300, y: 2040 });
  g.node("sunsetBranch", "core.flow.branch", {}, { x: 300, y: 1900 });
  g.node("noBonus", "core.var.set", { variable: "sunsetBonus", value: false }, { x: 600, y: 1900 });
  g.node("sunsetMsg", N.message, { text: "The sun has set. The beacon can still be lit, but the sunset bonus is gone.", seconds: 6 }, { x: 900, y: 1900 });
  g.exec("timer", "out", "sunsetBranch").exec("sunsetBranch", "true", "noBonus").exec("noBonus", "out", "sunsetMsg");
  g.data("timer", "timerId", "isSunset", "a").data("isSunset", "result", "sunsetBranch", "condition");

  // On Enter Zone: the spring heals; the beacon (with the gate open) wins.
  g.node("zone", N.enterZone, {}, { x: 0, y: 2200 });
  g.node("isSpring", "core.compare.text", { b: "spring" }, { x: 300, y: 2340 });
  g.node("springBranch", "core.flow.branch", {}, { x: 300, y: 2200 });
  g.node("heal", N.healPlayer, { amount: 20 }, { x: 600, y: 2120 });
  g.node("healMsg", N.message, { text: "The spring's water restores your hearts.", seconds: 3 }, { x: 900, y: 2120 });
  g.node("isBeacon", "core.compare.text", { b: "beacon" }, { x: 600, y: 2440 });
  g.node("beaconBranch", "core.flow.branch", {}, { x: 600, y: 2280 });
  g.node("gateOpen3", N.gateOpen, { gateId: "gate_ruins" }, { x: 900, y: 2440 });
  g.node("litBranch", "core.flow.branch", {}, { x: 900, y: 2280 });
  g.node("stopSunset", N.stopTimer, { timerId: "sunset" }, { x: 1200, y: 2280 });
  g.node("fanfare", N.sound, { sound: "success" }, { x: 1500, y: 2280 });
  g.node("bonus", "core.var.get", { variable: "sunsetBonus" }, { x: 1500, y: 2440 });
  g.node("bonusBranch", "core.flow.branch", {}, { x: 1800, y: 2280 });
  g.node("winBonus", N.win, { text: "You lit the beacon before sunset! Thornwood is safe again." }, { x: 2100, y: 2200 });
  g.node("winLate", N.win, { text: "You lit the beacon. Thornwood is safe again." }, { x: 2100, y: 2360 });
  g.exec("zone", "out", "springBranch").exec("springBranch", "true", "heal").exec("heal", "out", "healMsg").exec("springBranch", "false", "beaconBranch");
  g.exec("beaconBranch", "true", "litBranch").exec("litBranch", "true", "stopSunset").exec("stopSunset", "out", "fanfare").exec("fanfare", "out", "bonusBranch").exec("bonusBranch", "true", "winBonus").exec("bonusBranch", "false", "winLate");
  g.data("zone", "zoneId", "isSpring", "a").data("isSpring", "result", "springBranch", "condition").data("zone", "zoneId", "isBeacon", "a").data("isBeacon", "result", "beaconBranch", "condition");
  g.data("gateOpen3", "value", "litBranch", "condition").data("bonus", "value", "bonusBranch", "condition");
  return g.build();
}
