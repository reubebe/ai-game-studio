# Oware: Abapa ruleset

This project plays the **Abapa** variant of Oware as documented by the sources below. Abapa is one
documented variant. It is not a universal ruleset for every Ghanaian, Nigerian, Ivorian or other
regional tradition, and regional names (Ayò, Awalé, Wari, Ouril and others) often describe
different rules.

## Rules implemented

1. Two rows of six pits; each player owns the row nearest them. Four seeds per pit (48 in total).
   South moves first.
2. A turn: choose a non-empty pit on your side, lift every seed, and sow one per pit counter-clockwise.
3. When sowing 12 or more seeds, the starting pit is skipped on every lap.
4. If the last seed lands in an opponent pit and makes it hold exactly 2 or 3 seeds, capture them.
   Then check the previous pit: capture it too if it is an opponent pit holding 2 or 3, and so on.
5. Grand slam: a move that would capture every seed on the opponent's side is legal, but nothing is captured.
6. If the opponent has no seeds, you must make a move that gives them seeds.
7. If the player to move has no legal move (their opponent has no seeds and they cannot give them any),
   each player captures the seeds on their own side and the game ends.
8. Capturing 25 or more seeds wins. 24 each is a draw.
9. When both players agree the game has become an endless cycle, each captures the seeds on their side
   (the **Agree to end** action). Two people at the board both confirm. The computer agrees only once
   the same position (every pit, with the same player to move) has come up before in the game.

## Pit names

South's pits are A to F and North's are a to f, each counted from that player's left, as in the
sources' diagrams: a sowing from South's F continues into North's a.

## Interpretation choices

- Rule 6 is checked after captures resolve: the opponent must hold at least one seed when the move ends.
  With Abapa's grand-slam rule this is identical to "the move must reach the opponent's side".
- The optional **repetition limit** on the Check Termination node is a studio convention, not a traditional
  rule. It is off (0) by default.

## Sources

- Wikipedia: Oware (Abapa rules section): https://en.wikipedia.org/wiki/Oware (accessed 2026-11-18)
- Joan Sala, Aualé: How to play Oware: http://auale.joansala.com/en/how-to-play-oware/ (accessed 2026-11-18)

## Where the rules live

`rules/oware-abapa.rules.json` is an editable rule graph. Changing node settings (capture counts,
grand-slam policy, feeding rule, starting seeds) changes how the game plays. Automated tests check the
graph against an independent reference implementation for every documented setting.
