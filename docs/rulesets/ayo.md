# Ayò Olópón: two-or-three-capture rules

Ayò is the Yoruba sowing game of two rows of six pits. Written accounts of its rules disagree, and
communities play their own house rules. This project plays the **two-or-three-capture** rules below,
which are the same as Oware Abapa; the sources and the other accounts are listed so you can see the choice.

## Rules implemented

1. Two rows of six pits; each player owns the row nearest them. Four seeds per pit (48 in total).
2. A turn: choose a non-empty pit on your side, lift every seed, and sow one per pit counter-clockwise.
3. A handful of 12 or more seeds skips the pit it came from on every lap.
4. If your last seed lands in an opponent's pit and brings it to exactly 2 or 3 seeds, you capture them,
   plus any unbroken run of opponent pits holding 2 or 3 immediately behind it.
5. A move that would capture all of your opponent's seeds is allowed, but nothing is captured.
6. If your opponent has no seeds, you must play a move that reaches their row if you can.
7. If you cannot, the game ends and each player collects the seeds on their own side.
8. The first player to capture more than 24 seeds wins. 24 each is a draw.
9. When both players agree the game has become an endless cycle, each collects the seeds on their side
   (the **Agree to end** action). Two people at the board both confirm. The computer agrees only once
   the same position (every pit, with the same player to move) has come up before in the game.

## Other accounts of Ayò (not implemented)

- **Relay sowing, opposite capture** (John P. Pratt, "Ayoayo Rules", johnpratt.com, 2009; Wikipedia, "Ayoayo"):
  if the last seed lands in an occupied pit you lift those seeds and keep sowing; the turn ends in an empty pit,
  and if that pit is yours you capture the seeds in the pit opposite.
- **Capture at four** (Chidi Williams, "Building an Ayoayo implementation", rules learned in Lagos): relay sowing,
  and a pit that reaches four seeds is captured by the owner of its row.

A. O. Odeleye's book *Ayo: A Popular Yoruba Game* (University Press, Ibadan) is the standard printed reference;
it is not available online, so this ruleset has not been checked against it.

## Interpretation choices

- Rule 6 is checked after captures resolve: the opponent must hold at least one seed when the move ends.
  With rule 5 this is the same as "the move must reach the opponent's row".
- The optional **repetition limit** on the Check Termination node is a studio convention, not a traditional
  rule. It is off (0) by default.

## Sources

- BLAC Games: Ayò, about the game: https://games.blac.media/heritage/ayo/about (accessed 2026-11-19)
- Wikipedia: Oware (names ayò and ayoayo among the names of oware and its variants): https://en.wikipedia.org/wiki/Oware (accessed 2026-11-19)

## Where the rules live

`rules/ayo.rules.json` is an editable rule graph. Changing node settings (capture counts, grand-slam policy,
feeding rule, starting seeds) changes how the game plays. The graph runs on the same tested sowing nodes as
the Oware template, which automated tests check against an independent reference implementation.
