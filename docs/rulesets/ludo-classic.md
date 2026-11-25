# Ludo: Classic rules

This project plays Ludo with the **Classic** rules below. Ludo has many family and regional rules; the
sourced ones are marked, and the two house rules this template chose are settings you can change.

## Rules implemented

1. Two to four players, four tokens each, starting in their yards. Two players sit opposite each other.
   Play passes clockwise; Red starts. *(Sourced.)*
2. A token leaves its yard only on a 6, onto its colour's start square. *(Sourced.)*
3. A 6 earns another roll. A third 6 in a row cannot be used, and the turn passes at once. *(Sourced.)*
4. A token moves clockwise the number rolled, around the 52-square track and up its colour's
   five-square home column. If no token can move, the turn passes (a 6 still earns its roll).
5. Landing on an opponent's token sends it back to its yard; it needs another 6 to come out. *(Sourced.)*
6. Reaching home needs the exact count. *(Sourced.)*
7. The first player with every token home wins. *(Sourced; the game ends there.)*

## House rules chosen for this template

- **Tokens share squares.** Two tokens of one colour on a square do not form a block (the *Two tokens of
  one colour form a block* setting on **Guard: Legal Token Move?** turns blocks on).
- **Start squares are safe.** No token can be captured on any of the four start squares (the
  *Start squares are safe* setting on **Capture**).

Other common house rules are settings too: a 1 bringing tokens out, extra rolls for captures or for
reaching home, overshooting home, no limit on 6s, fewer tokens.

## Dice

Dice come from a seeded generator (mulberry32) stored with the game. Each new game takes a fresh random
seed, shown in the Play view; the same seed and the same moves always replay the same game, which is how
undo, replays and the automated tests work. Undo does not re-roll: rolling again after an undo gives the
same number.

## Sources

- Wikipedia: Ludo (rules of play, citing Parlett 1999 p. 49 and the Diagram Group 1975 p. 13): https://en.wikipedia.org/wiki/Ludo (accessed 2026-11-19)

## Where the rules live

`rules/ludo-classic.rules.json` is an editable rule graph. Changing node settings changes how the game
plays. Automated tests play the graph against an independent reference implementation, roll by roll, for
the Classic rules and five sets of house rules.
