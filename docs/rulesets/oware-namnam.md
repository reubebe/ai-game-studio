# Oware: Nam-nam ruleset

This project plays **Nam-nam**, the Oware game Ghanaian children learn first, as written up on oware.org
("Nam-Nam Rules") and taught in First Step Tours' video "Basic Oware Rules for Beginners". oware.org
explains the name as a Twi word meaning "to roam", and says the game is also played along the West
African coast and in the Caribbean under other names, such as Jerin-Jerin (Yoruba, Nigeria) and Round &
Round (Antigua). It is a different game from Abapa, the other Oware template.

## Rules implemented

1. Two rows of six houses; each row is the territory of the player sitting nearest it. Four seeds in
   every house at the start of each round (48 in all). South starts the first round.
2. A turn: choose a house in your own territory, scoop up every seed, and sow one per house anticlockwise.
3. If the last seed drops in a house that already held seeds, scoop them all up and sow on. The turn ends
   when the last seed lands in an empty house.
4. Whenever a seed sown by either player makes four in a house, the owner of that house captures the four
   at once, even during the other player's turn.
5. The exception: when your last seed makes four in a house in your opponent's territory, you capture it.
6. If a player has no seeds, the other player must sow from a house that gives them seeds. If that is not
   possible, the round ends and each player takes the seeds in their own territory.
7. When eight seeds are left in play, whoever captures the next four also takes the last four, which ends
   the round.
8. After a round, each player fills houses in their territory with the seeds they won, four to a house.
   The player who fills more houses wins the round, and the houses they fill on the other side become
   part of their territory for the next round. If both fill six, the round is a draw. Lost houses can be
   won back in later rounds.
9. The players take turns to start the rounds.
10. The game ends when one player's territory is completely captured.

## Interpretation choices

The sources leave some situations open. This project settles them as follows:

- A last seed that makes four ends the turn: the capture empties the house, so there is nothing to scoop.
- Fours are captured the moment they form, so nobody misses one. Over a real board, a player who is slow
  to collect a four loses it when another seed lands there (the video, 3:42). Houses that hold four when a
  round starts were not made by sowing, so they stay until a seed changes them.
- When your move leaves your opponent with no seeds, you move again and must give them seeds (rule 6).
  A move that ends the round under rule 7 counts as giving seeds, since nobody needs them any more.
- The houses a round's winner takes are the ones right after their own row in sowing order, as the video
  shows at 4:16 (the winner's six houses plus the first house of the other row). Houses go back from the
  same edge.
- If a round ends under rule 6 and the seeds do not fill whole houses, the player with more seeds fills
  the last house.
- Who starts each round is a setting on the **Start Next Round** node. oware.org says the players take turns
  (the default); in the video, the round's winner starts.
- **Agree to end** is not in the sources. If a round goes round in circles, both players can agree to end
  it: each takes the seeds in their own territory and the next round starts. The computer agrees only once
  the same position has come up before in the round.
- A sowing that would go round the board for ever cannot be played. Ordinary play never meets one.

## Pit names

South's houses are A to F and North's are a to f, each counted from that player's left. A house keeps its
name when it changes hands; on the board, a ring around each house shows who owns it.

## Sources

- oware.org: Nam-Nam Rules: http://www.oware.org/nam_nam.asp (accessed 2026-11-21)
- First Step Tours (Angy Dadson): Basic Oware Rules for Beginners, video, 2:23 to 4:28: https://www.youtube.com/watch?v=HunzMxlbghQ (accessed 2026-11-21)

## Where the rules live

`rules/oware-namnam.rules.json` is an editable rule graph. Its node settings hold the rules above: relay
sowing and the owner's four on **Sow Seeds**, the last seed's four on **Capture Check**, the last eight seeds
and passing on **Check Termination**, and the rounds on **Start Next Round**. Automated tests play the graph
against the reference engine and against a separate implementation written from the rules text.
