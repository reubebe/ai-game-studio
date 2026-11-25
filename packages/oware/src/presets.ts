import { GraphBuilder, type RuleGraph } from "@gamestudio/rules-core";
import { OWARE_DOMAIN, OWARE_NODE as N } from "./domain";

export const ABAPA_PROVENANCE: NonNullable<RuleGraph["provenance"]> = {
  variant: "Oware Abapa",
  sources: [
    { title: "Wikipedia: Oware (Abapa rules section)", url: "https://en.wikipedia.org/wiki/Oware", accessed: "2026-11-18" },
    { title: "Joan Sala, Aualé: How to play Oware", url: "http://auale.joansala.com/en/how-to-play-oware/", accessed: "2026-11-18" },
  ],
  notes:
    "Abapa is one documented Oware variant, not a universal ruleset for every Ghanaian, Nigerian or other regional tradition. " +
    "Both sources agree on 4 seeds per pit, counter-clockwise sowing that skips the starting pit on laps, captures of 2 or 3 chained backwards, " +
    "forfeited grand-slam captures, the obligation to feed an opponent with no seeds, and a 25-seed majority. " +
    "Endless cycles end by agreement (the 'On Players Agree to End' event); automatic repetition endings are off by default.",
};

export const AYO_PROVENANCE: NonNullable<RuleGraph["provenance"]> = {
  variant: "Ayò Olópón (two-or-three captures)",
  sources: [
    { title: "BLAC Games: Ayò, about the game", url: "https://games.blac.media/heritage/ayo/about", accessed: "2026-11-19" },
    { title: "Wikipedia: Oware (names ayò and ayoayo among the names of oware and its variants)", url: "https://en.wikipedia.org/wiki/Oware", accessed: "2026-11-19" },
  ],
  notes:
    "Written sources disagree about Ayò. This template follows the two-or-three-capture rules (4 seeds per pit, the starting pit skipped on " +
    "laps, captures of 2 or 3 chained backwards, forfeited grand-slam captures, feeding, more than 24 wins), which are the same as Oware Abapa. " +
    "Other accounts describe relay sowing with captures opposite an empty pit (John Pratt; Wikipedia 'Ayoayo') or captures at four " +
    "(Chidi Williams, as played in Lagos). Communities play different house rules; change the node settings to match yours.",
};

/**
 * The Abapa turn as an editable rule graph: Event -> Guard -> Sow -> Capture Check -> Termination -> Next State,
 * the structure of the blueprint's deterministic rule-graph illustration.
 */
export function abapaGraph(): RuleGraph {
  return sowingGraph(
    "oware-abapa",
    "Oware: Abapa turn",
    "One complete Abapa turn. Change node settings to explore documented variants, or add general nodes for house rules.",
    ABAPA_PROVENANCE,
  );
}

/** Ayò with two-or-three captures: the same turn structure and settings as Abapa, with its own name and sources. */
export function ayoGraph(): RuleGraph {
  return sowingGraph(
    "ayo",
    "Ayò: a turn",
    "One complete Ayò turn (two-or-three captures). Change node settings to play your own house rules.",
    AYO_PROVENANCE,
  );
}

function sowingGraph(id: string, name: string, description: string, provenance: NonNullable<RuleGraph["provenance"]>): RuleGraph {
  const g = new GraphBuilder(id, name, OWARE_DOMAIN, description).provenance(provenance);

  g.node("board", N.board, { seedsPerPit: 4 }, { x: 0, y: -240 }, { comment: "48 seeds in total; 25 wins." });
  g.node("move", N.move, {}, { x: 0, y: 0 });
  g.node("guard", N.guard, { mustFeed: true }, { x: 320, y: 0 });
  g.node("reject", N.reject, {}, { x: 640, y: 220 });
  g.node("sow", N.sow, { skipOrigin: true }, { x: 640, y: -40 });
  g.node("capture", N.capture, { counts: [2, 3], chain: true, grandSlam: "no-capture" }, { x: 960, y: -40 });
  g.node("end", N.termination, { repetitionLimit: 0 }, { x: 1280, y: 0 });
  g.node("finishWin", N.finish, { reason: "majority" }, { x: 1640, y: -300 });
  g.node("finishDraw", N.finish, { reason: "draw" }, { x: 1640, y: -170 });
  g.node("sweepBlocked", N.sweep, {}, { x: 1640, y: -40 });
  g.node("finishBlocked", N.finish, { reason: "no-legal-move" }, { x: 1960, y: -40 });
  g.node("sweepCycle", N.sweep, {}, { x: 1640, y: 90 });
  g.node("finishCycle", N.finish, { reason: "repetition" }, { x: 1960, y: 90 });
  g.node("next", N.nextTurn, {}, { x: 1640, y: 220 });
  g.node("agree", N.agree, {}, { x: 0, y: 420 });
  g.node("sweepAgree", N.sweep, {}, { x: 320, y: 420 });
  g.node("finishAgree", N.finish, { reason: "agreement" }, { x: 640, y: 420 });

  g.exec("move", "out", "guard");
  g.exec("guard", "legal", "sow");
  g.exec("guard", "illegal", "reject");
  g.exec("sow", "out", "capture");
  g.exec("capture", "out", "end");
  g.exec("end", "win", "finishWin");
  g.exec("end", "draw", "finishDraw");
  g.exec("end", "blocked", "sweepBlocked");
  g.exec("sweepBlocked", "out", "finishBlocked");
  g.exec("end", "cycle", "sweepCycle");
  g.exec("sweepCycle", "out", "finishCycle");
  g.exec("end", "continue", "next");
  g.exec("agree", "out", "sweepAgree");
  g.exec("sweepAgree", "out", "finishAgree");

  g.data("move", "pit", "guard", "pit");
  g.data("move", "pit", "sow", "pit");
  g.data("guard", "reason", "reject", "reason");
  g.data("sow", "lastPit", "capture", "lastPit");
  return g.build();
}

export const NAMNAM_PROVENANCE: NonNullable<RuleGraph["provenance"]> = {
  variant: "Oware Nam-nam (beginner rules)",
  sources: [
    { title: "oware.org: Nam-Nam Rules", url: "http://www.oware.org/nam_nam.asp", accessed: "2026-11-21" },
    { title: "First Step Tours (Angy Dadson): Basic Oware Rules for Beginners, video, 2:23 to 4:28", url: "https://www.youtube.com/watch?v=HunzMxlbghQ", accessed: "2026-11-21" },
  ],
  notes:
    "Nam-nam is the Ghanaian children's game on the Oware board: relay sowing, fours taken by the owner of the house as they form " +
    "(a last seed that makes four in an opponent's house is the sower's), the player who captures four of the last eight seeds also " +
    "takes the last four, and rounds in which each player refills houses from their captures and the player who fills more houses " +
    "takes houses from the other row, until one player has none. oware.org says the players take turns to start; the video has the " +
    "round's winner start (a setting on Start Next Round).",
};

/**
 * Nam-nam as an editable rule graph: the same turn structure as Abapa with relay sowing, captures of four, the last
 * eight seeds and rounds. Every way a round can end leads to Start Next Round.
 */
export function namnamGraph(): RuleGraph {
  const g = new GraphBuilder(
    "oware-namnam",
    "Oware: a Nam-nam turn",
    OWARE_DOMAIN,
    "One complete Nam-nam turn and round. Change node settings to play house rules, for example who starts each round.",
  ).provenance(NAMNAM_PROVENANCE);

  g.node("board", N.board, { seedsPerPit: 4 }, { x: 0, y: -240 }, { comment: "Four seeds in each house at the start of every round." });
  g.node("move", N.move, {}, { x: 0, y: 0 });
  g.node("guard", N.guard, { mustFeed: true }, { x: 320, y: 0 });
  g.node("reject", N.reject, {}, { x: 640, y: 220 });
  g.node("sow", N.sow, { skipOrigin: false, relay: true, ownerCaptures: [4] }, { x: 640, y: -40 }, { comment: "Relay sowing; a house that reaches four goes to its owner." });
  g.node("capture", N.capture, { counts: [4], chain: false, grandSlam: "capture-all" }, { x: 960, y: -40 }, { comment: "A last seed that makes four in the opponent's house is the sower's." });
  g.node("end", N.termination, { majority: false, lastSeeds: 8, emptyPasses: true, repetitionLimit: 0 }, { x: 1280, y: 0 });
  g.node("sweepBlocked", N.sweep, {}, { x: 1640, y: -120 });
  g.node("sweepCycle", N.sweep, {}, { x: 1640, y: 120 });
  g.node("again", N.again, {}, { x: 1640, y: 250 });
  g.node("next", N.nextTurn, {}, { x: 1640, y: 380 });
  g.node("newRound", N.nextRound, { starter: "alternate" }, { x: 1960, y: -40 }, { comment: "Refill four to a house; the player with more houses takes the other row's first houses." });
  g.node("finishGame", N.finish, { reason: "territory" }, { x: 2280, y: -40 });
  g.node("agree", N.agree, {}, { x: 0, y: 420 });
  g.node("sweepAgree", N.sweep, {}, { x: 320, y: 420 });

  g.exec("move", "out", "guard");
  g.exec("guard", "legal", "sow");
  g.exec("guard", "illegal", "reject");
  g.exec("sow", "out", "capture");
  g.exec("capture", "out", "end");
  g.exec("end", "round", "newRound");
  g.exec("end", "blocked", "sweepBlocked");
  g.exec("sweepBlocked", "out", "newRound");
  g.exec("end", "cycle", "sweepCycle");
  g.exec("sweepCycle", "out", "newRound");
  g.exec("end", "again", "again");
  g.exec("end", "continue", "next");
  g.exec("newRound", "over", "finishGame");
  g.exec("agree", "out", "sweepAgree");
  g.exec("sweepAgree", "out", "newRound");

  g.data("move", "pit", "guard", "pit");
  g.data("move", "pit", "sow", "pit");
  g.data("guard", "reason", "reject", "reason");
  g.data("sow", "lastPit", "capture", "lastPit");
  return g.build();
}
