import { callStmt, GraphBuilder, type DomainSpec, type NodeSpec, type ParamSpec, type PinSpec, type RuleGraph, type Stmt } from "@gamestudio/rules-core";

const EXEC_IN = { id: "in", kind: "exec" } as const;
const EXEC_OUT = { id: "out", kind: "exec" } as const;
const trace = (node: string): Stmt => ({ s: "trace", node });

export const FOOTBALL_DOMAIN = "football";

export const FOOTBALL_NODE = {
  goal: "football.event.goal",
  minute: "football.event.minute",
  fullTime: "football.event.fullTime",
  message: "football.action.message",
  caption: "football.action.caption",
  sound: "football.action.sound",
  addTime: "football.action.addTime",
  changeScore: "football.action.changeScore",
  endMatch: "football.action.endMatch",
  score: "football.query.score",
  timeLeft: "football.query.timeLeft",
  teamName: "football.query.teamName",
} as const;

/** The template's generated sounds that rules can play. */
export const FOOTBALL_SOUNDS = ["whistle", "goal", "cheer", "kick"] as const;

function event(type: string, name: string, title: string, description: string, payload: { id: string; label: string; type: "text" | "number" }[]): NodeSpec {
  return {
    type,
    domain: FOOTBALL_DOMAIN,
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

const teamInput: PinSpec = { id: "team", kind: "data", type: "text", label: "Team (home or away)", param: "team" };
const teamParam: ParamSpec = { id: "team", label: "Team (when unconnected)", kind: "select", default: "home", options: [{ value: "home", label: "Home (the player's)" }, { value: "away", label: "Away (the computer's)" }] };

export const footballNodes: NodeSpec[] = [
  event(FOOTBALL_NODE.goal, "goal", "On Goal", "A team scored (after the score has gone up). Team is home or away; the scorer is whoever touched the ball last (an own goal counts for the other team).", [
    { id: "team", label: "Team", type: "text" },
    { id: "scorer", label: "Scorer's number", type: "number" },
    { id: "scorerName", label: "Scorer's name", type: "text" },
  ]),
  event(FOOTBALL_NODE.minute, "minute", "On Minute", "Another full minute of play has passed (1, 2, 3 ...).", [{ id: "minute", label: "Minutes played", type: "number" }]),
  event(FOOTBALL_NODE.fullTime, "fullTime", "On Full Time", "The clock reached zero. The match ends here unless a rule adds time.", []),
  {
    type: FOOTBALL_NODE.message,
    domain: FOOTBALL_DOMAIN,
    category: "action",
    title: "Show Message",
    description: "Shows a message across the pitch for a few seconds.",
    inputs: [EXEC_IN, { id: "text", kind: "data", type: "text", label: "Text", param: "text" }],
    outputs: [EXEC_OUT],
    params: [
      { id: "text", label: "Text (when unconnected)", kind: "text", default: "", maxLength: 300, multiline: true },
      { id: "seconds", label: "Seconds on screen", kind: "number", default: 3, min: 1, max: 20 },
    ],
    keywords: ["say", "announce", "commentary", "hud"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("football.message", { text: ctx.input("text"), seconds: { e: "const", v: ctx.param<number>("seconds") } }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: FOOTBALL_NODE.caption,
    domain: FOOTBALL_DOMAIN,
    category: "action",
    title: "Set Caption",
    description: "Replaces the line shown under the scoreboard.",
    inputs: [EXEC_IN, { id: "text", kind: "data", type: "text", label: "Text", param: "text" }],
    outputs: [EXEC_OUT],
    params: [{ id: "text", label: "Caption (when unconnected)", kind: "text", default: "", maxLength: 120 }],
    keywords: ["banner", "title", "objective"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("football.caption", { text: ctx.input("text") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: FOOTBALL_NODE.sound,
    domain: FOOTBALL_DOMAIN,
    category: "action",
    title: "Play Sound",
    description: "Plays one of the template's generated sounds.",
    inputs: [EXEC_IN],
    outputs: [EXEC_OUT],
    params: [{ id: "sound", label: "Sound", kind: "select", default: "whistle", options: FOOTBALL_SOUNDS.map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) })) }],
    keywords: ["audio", "sfx", "whistle"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("football.sound", { sound: { e: "const", v: ctx.param<string>("sound") } }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: FOOTBALL_NODE.addTime,
    domain: FOOTBALL_DOMAIN,
    category: "action",
    title: "Add Time",
    description: "Puts more seconds on the clock. From On Full Time this plays on (extra time, a golden goal).",
    inputs: [EXEC_IN, { id: "seconds", kind: "data", type: "number", label: "Seconds", param: "seconds" }],
    outputs: [EXEC_OUT],
    params: [{ id: "seconds", label: "Seconds (when unconnected)", kind: "number", default: 60, min: 1, max: 600 }],
    keywords: ["extra time", "stoppage", "clock", "golden goal"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("football.addTime", { seconds: ctx.input("seconds") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: FOOTBALL_NODE.changeScore,
    domain: FOOTBALL_DOMAIN,
    category: "action",
    title: "Change Score",
    description: "Adds goals to (or takes them from) a team's score, without a goal being scored.",
    inputs: [EXEC_IN, teamInput, { id: "amount", kind: "data", type: "number", label: "Goals", param: "amount" }],
    outputs: [EXEC_OUT],
    params: [teamParam, { id: "amount", label: "Goals (when unconnected)", kind: "number", default: 1, min: -20, max: 20 }],
    keywords: ["points", "bonus", "penalty"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("football.changeScore", { team: ctx.input("team"), amount: ctx.input("amount") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: FOOTBALL_NODE.endMatch,
    domain: FOOTBALL_DOMAIN,
    category: "action",
    title: "End Match",
    description: "Stops play and shows the final result with this text.",
    inputs: [EXEC_IN, { id: "text", kind: "data", type: "text", label: "Text", param: "text" }],
    outputs: [EXEC_OUT],
    params: [{ id: "text", label: "Result (when unconnected)", kind: "text", default: "Full time!", maxLength: 200 }],
    keywords: ["finish", "result", "win", "final whistle"],
    compileExec: (ctx) => [trace(ctx.node.id), callStmt("football.endMatch", { text: ctx.input("text") }, ctx.node.id), ...ctx.follow("out")],
  },
  {
    type: FOOTBALL_NODE.score,
    domain: FOOTBALL_DOMAIN,
    category: "query",
    title: "Score",
    description: "A team's goals so far.",
    inputs: [teamInput],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Goals" }],
    params: [teamParam],
    keywords: ["goals", "points", "result"],
    compileExpr: (ctx) => ({ e: "query", fn: "football.score", args: { team: ctx.input("team") } }),
  },
  {
    type: FOOTBALL_NODE.timeLeft,
    domain: FOOTBALL_DOMAIN,
    category: "query",
    title: "Time Left",
    description: "Seconds of play left on the clock.",
    inputs: [],
    outputs: [{ id: "value", kind: "data", type: "number", label: "Seconds" }],
    params: [],
    keywords: ["clock", "minutes", "remaining"],
    compileExpr: () => ({ e: "query", fn: "football.timeLeft", args: {} }),
  },
  {
    type: FOOTBALL_NODE.teamName,
    domain: FOOTBALL_DOMAIN,
    category: "query",
    title: "Team Name",
    description: "A team's name from the match settings.",
    inputs: [teamInput],
    outputs: [{ id: "value", kind: "data", type: "text", label: "Name" }],
    params: [teamParam],
    keywords: ["club", "side"],
    compileExpr: (ctx) => ({ e: "query", fn: "football.teamName", args: { team: ctx.input("team") } }),
  },
];

export const footballDomain: DomainSpec = {
  id: FOOTBALL_DOMAIN,
  title: "Football",
  description: "Goals, the match clock, full time, the score and announcements for football matches.",
  nodes: footballNodes,
  hostFunctions: {
    calls: ["football.message", "football.caption", "football.sound", "football.addTime", "football.changeScore", "football.endMatch"],
    queries: ["football.score", "football.timeLeft", "football.teamName"],
  },
};

/**
 * Rules for the Harbour Cup Final: kick-off, goal announcements with the score, a last-minute warning, and
 * at full time a win, a loss or (when level) one golden-goal minute, then a shared cup.
 */
export function cupRules(): RuleGraph {
  const N = FOOTBALL_NODE;
  const g = new GraphBuilder("cup-rules", "Harbour Cup rules", FOOTBALL_DOMAIN, "Kick-off, goals and the score, the last minute, full time and the golden goal.");
  g.variable("goldenGoal", "boolean", false, "Has the golden-goal minute started?");

  // On Start: the whistle, the caption and how to play.
  g.node("start", "core.event.start", {}, { x: 0, y: -300 });
  g.node("kickoffWhistle", N.sound, { sound: "whistle" }, { x: 300, y: -300 });
  g.node("caption1", N.caption, { text: "Win the Harbour Cup!" }, { x: 600, y: -300 });
  g.node("howTo", N.message, { text: "Kick-off! W A S D run, Space shoots, E passes (or tackles), Q switches player, Shift sprints.", seconds: 6 }, { x: 900, y: -300 });
  g.exec("start", "out", "kickoffWhistle").exec("kickoffWhistle", "out", "caption1").exec("caption1", "out", "howTo");

  // On Goal: the cheer and the score; during the golden goal the scorer wins the cup.
  g.node("goal", N.goal, {}, { x: 0, y: 0 });
  g.node("goalSound", N.sound, { sound: "goal" }, { x: 300, y: 0 });
  g.node("scoringTeam", N.teamName, {}, { x: 300, y: 160 });
  g.node("homeGoals", N.score, { team: "home" }, { x: 300, y: 280 });
  g.node("awayGoals", N.score, { team: "away" }, { x: 300, y: 400 });
  g.node("goalText0", "core.text.join", { a: "GOAL! " }, { x: 300, y: 40 });
  g.node("goalText1", "core.text.join", { a: " for " }, { x: 600, y: 160 });
  g.node("goalText1b", "core.text.join", {}, { x: 600, y: 80 });
  g.node("goalText2", "core.text.join", { b: "  " }, { x: 900, y: 160 });
  g.node("scoreText1", "core.text.join", { b: " – " }, { x: 600, y: 280 });
  g.node("scoreText2", "core.text.join", {}, { x: 900, y: 340 });
  g.node("goalText3", "core.text.join", {}, { x: 1200, y: 220 });
  g.node("goalMsg", N.message, { seconds: 3 }, { x: 600, y: 0 });
  g.node("golden1", "core.var.get", { variable: "goldenGoal" }, { x: 900, y: 520 });
  g.node("goldenBranch", "core.flow.branch", {}, { x: 900, y: 0 });
  g.node("goldenText", "core.text.join", { a: "Golden goal! ", b: "" }, { x: 1200, y: 520 });
  g.node("goldenText2", "core.text.join", { b: " win the Harbour Cup!" }, { x: 1500, y: 520 });
  g.node("goldenEnd", N.endMatch, {}, { x: 1200, y: 0 });
  g.exec("goal", "out", "goalSound").exec("goalSound", "out", "goalMsg").exec("goalMsg", "out", "goldenBranch").exec("goldenBranch", "true", "goldenEnd");
  g.data("goal", "scorerName", "goalText0", "b").data("goal", "team", "scoringTeam", "team").data("scoringTeam", "value", "goalText1", "b");
  g.data("goalText0", "result", "goalText1b", "a").data("goalText1", "result", "goalText1b", "b").data("goalText1b", "result", "goalText2", "a");
  g.data("homeGoals", "value", "scoreText1", "a").data("scoreText1", "result", "scoreText2", "a").data("awayGoals", "value", "scoreText2", "b");
  g.data("goalText2", "result", "goalText3", "a").data("scoreText2", "result", "goalText3", "b").data("goalText3", "result", "goalMsg", "text");
  g.data("golden1", "value", "goldenBranch", "condition").data("scoringTeam", "value", "goldenText", "b").data("goldenText", "result", "goldenText2", "a").data("goldenText2", "result", "goldenEnd", "text");

  // On Minute: a warning when one minute or less is left.
  g.node("minute", N.minute, {}, { x: 0, y: 760 });
  g.node("left1", N.timeLeft, {}, { x: 300, y: 900 });
  g.node("lastMinute", "core.compare.number", { operator: "<=", b: 60 }, { x: 600, y: 900 });
  g.node("stillPlaying", "core.compare.number", { operator: ">", b: 0 }, { x: 600, y: 1020 });
  g.node("warnNow", "core.logic.and", {}, { x: 900, y: 960 });
  g.node("warnBranch", "core.flow.branch", {}, { x: 300, y: 760 });
  g.node("warn", N.message, { text: "Last minute!", seconds: 3 }, { x: 600, y: 760 });
  g.exec("minute", "out", "warnBranch").exec("warnBranch", "true", "warn");
  g.data("left1", "value", "lastMinute", "a").data("left1", "value", "stillPlaying", "a").data("lastMinute", "result", "warnNow", "a").data("stillPlaying", "result", "warnNow", "b").data("warnNow", "result", "warnBranch", "condition");

  // On Full Time: level and no golden goal yet → one more minute; otherwise the result.
  g.node("fullTime", N.fullTime, {}, { x: 0, y: 1200 });
  g.node("homeAtEnd", N.score, { team: "home" }, { x: 300, y: 1340 });
  g.node("awayAtEnd", N.score, { team: "away" }, { x: 300, y: 1460 });
  g.node("level", "core.compare.number", { operator: "==" }, { x: 600, y: 1340 });
  g.node("golden2", "core.var.get", { variable: "goldenGoal" }, { x: 600, y: 1460 });
  g.node("notGolden", "core.logic.not", {}, { x: 900, y: 1460 });
  g.node("playOn", "core.logic.and", {}, { x: 900, y: 1340 });
  g.node("playOnBranch", "core.flow.branch", {}, { x: 300, y: 1200 });
  g.node("startGolden", "core.var.set", { variable: "goldenGoal", value: true }, { x: 600, y: 1100 });
  g.node("moreTime", N.addTime, { seconds: 60 }, { x: 900, y: 1100 });
  g.node("caption2", N.caption, { text: "Golden goal: the next goal wins!" }, { x: 1200, y: 1100 });
  g.node("goldenMsg", N.message, { text: "Level at full time! One more minute: the next goal wins the cup.", seconds: 5 }, { x: 1500, y: 1100 });
  g.exec("fullTime", "out", "playOnBranch").exec("playOnBranch", "true", "startGolden").exec("startGolden", "out", "moreTime").exec("moreTime", "out", "caption2").exec("caption2", "out", "goldenMsg");
  g.data("homeAtEnd", "value", "level", "a").data("awayAtEnd", "value", "level", "b").data("golden2", "value", "notGolden", "a").data("level", "result", "playOn", "a").data("notGolden", "result", "playOn", "b").data("playOn", "result", "playOnBranch", "condition");
  // The result: home ahead, away ahead, or still level after the golden-goal minute.
  g.node("homeAhead", "core.compare.number", { operator: ">" }, { x: 600, y: 1640 });
  g.node("awayAhead", "core.compare.number", { operator: "<" }, { x: 600, y: 1760 });
  g.node("homeWinsBranch", "core.flow.branch", {}, { x: 600, y: 1300 });
  g.node("awayWinsBranch", "core.flow.branch", {}, { x: 900, y: 1500 });
  g.node("homeName", N.teamName, { team: "home" }, { x: 900, y: 1640 });
  g.node("awayName", N.teamName, { team: "away" }, { x: 900, y: 1760 });
  g.node("homeWinText1", "core.text.join", { a: "Full time: " }, { x: 1200, y: 1640 });
  g.node("homeWinText2", "core.text.join", { b: " win the Harbour Cup!" }, { x: 1500, y: 1640 });
  g.node("awayWinText1", "core.text.join", { a: "Full time: " }, { x: 1200, y: 1760 });
  g.node("awayWinText2", "core.text.join", { b: " win the Harbour Cup." }, { x: 1500, y: 1760 });
  g.node("homeWins", N.endMatch, {}, { x: 900, y: 1300 });
  g.node("awayWins", N.endMatch, {}, { x: 1200, y: 1450 });
  g.node("shared", N.endMatch, { text: "Full time: still level after the golden goal. The cup is shared!" }, { x: 1200, y: 1560 });
  g.exec("playOnBranch", "false", "homeWinsBranch").exec("homeWinsBranch", "true", "homeWins").exec("homeWinsBranch", "false", "awayWinsBranch").exec("awayWinsBranch", "true", "awayWins").exec("awayWinsBranch", "false", "shared");
  g.data("homeAtEnd", "value", "homeAhead", "a").data("awayAtEnd", "value", "homeAhead", "b").data("homeAtEnd", "value", "awayAhead", "a").data("awayAtEnd", "value", "awayAhead", "b");
  g.data("homeAhead", "result", "homeWinsBranch", "condition").data("awayAhead", "result", "awayWinsBranch", "condition");
  g.data("homeName", "value", "homeWinText1", "b").data("homeWinText1", "result", "homeWinText2", "a").data("homeWinText2", "result", "homeWins", "text");
  g.data("awayName", "value", "awayWinText1", "b").data("awayWinText1", "result", "awayWinText2", "a").data("awayWinText2", "result", "awayWins", "text");
  return g.build();
}
