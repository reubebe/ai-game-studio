import { GraphBuilder, type RuleGraph } from "@gamestudio/rules-core";
import { LUDO_DOMAIN, LUDO_NODE as N } from "./domain";

export const CLASSIC_PROVENANCE: NonNullable<RuleGraph["provenance"]> = {
  variant: "Ludo (Classic)",
  sources: [
    { title: "Wikipedia: Ludo (rules of play, citing Parlett 1999 p. 49 and the Diagram Group 1975 p. 13)", url: "https://en.wikipedia.org/wiki/Ludo", accessed: "2026-11-19" },
  ],
  notes:
    "Sourced: a 6 brings a token out, a 6 earns another roll, a third 6 in a row loses the turn, landing on an opponent sends it back to its yard, " +
    "and reaching home needs the exact count; the first player with every token home wins. House rules chosen for this template (settings on the nodes): " +
    "tokens of one colour share a square instead of forming a block, and the four start squares are safe. Dice are seeded so games replay exactly.",
};

/**
 * Classic Ludo as an editable rule graph. Two events: On Roll (roll, the three-sixes rule, whether any token can move)
 * and On Token Chosen (guard, move, capture, win check, another roll or next turn).
 */
export function classicGraph(): RuleGraph {
  const g = new GraphBuilder("ludo-classic", "Ludo: Classic turn", LUDO_DOMAIN, "A Ludo turn with the Classic rules. Change node settings for house rules such as blocks or extra rolls.").provenance(CLASSIC_PROVENANCE);

  g.node("setup", N.setup, { tokens: 4 }, { x: 0, y: -260 }, { comment: "First player with every token home wins." });
  g.node("roll", N.roll, {}, { x: 0, y: 0 });
  g.node("die", N.rollDie, {}, { x: 300, y: 0 });
  g.node("sixes", N.sixes, { maxSixes: 3 }, { x: 600, y: 0 });
  g.node("forfeit", N.nextTurn, {}, { x: 900, y: -120 });
  g.node("canMove", N.canMove, {}, { x: 900, y: 40 });
  g.node("stuckBonus", N.bonus, { onSix: true, onCapture: false, onHome: false }, { x: 1200, y: 120 });
  g.node("stuckAgain", N.again, {}, { x: 1500, y: 60 });
  g.node("stuckPass", N.nextTurn, {}, { x: 1500, y: 200 });

  g.node("move", N.move, {}, { x: 0, y: 460 });
  g.node("guard", N.legal, { enterOn: [6], exactFinish: true, blocks: false }, { x: 300, y: 460 });
  g.node("reject", N.reject, {}, { x: 600, y: 640 });
  g.node("advance", N.advance, {}, { x: 600, y: 420 });
  g.node("capture", N.capture, { safeStarts: true }, { x: 900, y: 420 });
  g.node("win", N.win, {}, { x: 1200, y: 420 });
  g.node("finish", N.finish, {}, { x: 1500, y: 320 });
  g.node("bonus", N.bonus, { onSix: true, onCapture: false, onHome: false }, { x: 1500, y: 480 });
  g.node("again", N.again, {}, { x: 1800, y: 420 });
  g.node("next", N.nextTurn, {}, { x: 1800, y: 560 });

  g.exec("roll", "out", "die");
  g.exec("die", "out", "sixes");
  g.exec("sixes", "over", "forfeit");
  g.exec("sixes", "ok", "canMove");
  g.exec("canMove", "no", "stuckBonus");
  g.exec("stuckBonus", "again", "stuckAgain");
  g.exec("stuckBonus", "pass", "stuckPass");

  g.exec("move", "out", "guard");
  g.exec("guard", "legal", "advance");
  g.exec("guard", "illegal", "reject");
  g.exec("advance", "out", "capture");
  g.exec("capture", "out", "win");
  g.exec("win", "win", "finish");
  g.exec("win", "continue", "bonus");
  g.exec("bonus", "again", "again");
  g.exec("bonus", "pass", "next");

  g.data("move", "token", "guard", "token");
  g.data("move", "token", "advance", "token");
  g.data("move", "token", "capture", "token");
  g.data("guard", "reason", "reject", "reason");
  return g.build();
}
