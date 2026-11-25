import { RuleRuntimeError, type CallResult, type RuleHost, type Scalar } from "@gamestudio/rules-core";
import type { Match, TeamSide } from "./match";

export type FootballEffect =
  | { type: "message"; text: string; seconds: number }
  | { type: "caption"; text: string }
  | { type: "sound"; sound: string }
  | { type: "time"; seconds: number; left: number }
  | { type: "score"; team: TeamSide; change: number; home: number; away: number }
  | { type: "end"; text: string };

/**
 * In-studio stand-in for the Godot match: answers the same host calls from the match settings, so rules
 * can be tested without launching the engine. It keeps the score and the clock, not the players.
 */
export class FootballSimHost implements RuleHost {
  score: Record<TeamSide, number> = { home: 0, away: 0 };
  secondsLeft: number;
  /** Minutes of play that have passed (On Minute's number). */
  minutesPlayed = 0;
  caption = "";
  ended: string | null = null;
  effects: FootballEffect[] = [];

  constructor(readonly match: Match) {
    this.secondsLeft = match.minutes * 60;
  }

  private side(value: Scalar | undefined): TeamSide {
    const t = String(value ?? "").trim().toLowerCase();
    if (t !== "home" && t !== "away") throw new RuleRuntimeError(`Team must be home or away, not '${String(value ?? "")}'`);
    return t;
  }

  /** The players on the pitch for a side: the first teamSize of its squad (the first keeps goal). */
  lineUp(team: TeamSide): Match["home"]["players"] {
    return this.match[team].players.slice(0, this.match.teamSize);
  }

  /**
   * A goal by a player in the line-up (slot 0 is the keeper; by default the side's last, its forward).
   * The score goes up before the rules hear of it, as in the game.
   */
  goal(team: TeamSide, slot?: number): { team: TeamSide; scorer: number; scorerName: string } {
    if (this.ended !== null) throw new Error("The match has ended");
    const players = this.lineUp(team);
    const scorer = players[slot ?? players.length - 1];
    if (!scorer) throw new Error(`There is no player ${String(slot)} in ${this.match[team].name}'s line-up`);
    this.score[team] += 1;
    return { team, scorer: scorer.number, scorerName: scorer.name };
  }

  /** Plays on to the next full minute; returns On Minute's number, or null when the clock runs out first. */
  nextMinute(): number | null {
    if (this.ended !== null) throw new Error("The match has ended");
    const total = this.match.minutes * 60;
    const played = total - this.secondsLeft;
    const toNext = 60 - (played % 60);
    if (toNext >= this.secondsLeft) return null;
    this.secondsLeft -= toNext;
    this.minutesPlayed += 1;
    return this.minutesPlayed;
  }

  /** Plays on until the clock reaches zero (On Full Time follows). */
  runOut(): void {
    if (this.ended !== null) throw new Error("The match has ended");
    this.secondsLeft = 0;
  }

  /** What the game does at full time when no rule ended the match or added time: the score decides. */
  defaultResult(): string {
    const { home, away } = this.score;
    return home === away ? `Full time: ${home} – ${away}` : `Full time: ${home > away ? this.match.home.name : this.match.away.name} win ${Math.max(home, away)} – ${Math.min(home, away)}`;
  }

  private text(value: Scalar | undefined): string {
    return typeof value === "string" ? value : String(value ?? "");
  }

  call(fn: string, args: Record<string, Scalar>): CallResult {
    switch (fn) {
      case "football.message":
        this.effects.push({ type: "message", text: this.text(args["text"]), seconds: typeof args["seconds"] === "number" ? args["seconds"] : 3 });
        return;
      case "football.caption":
        this.caption = this.text(args["text"]);
        this.effects.push({ type: "caption", text: this.caption });
        return;
      case "football.sound":
        this.effects.push({ type: "sound", sound: this.text(args["sound"]) });
        return;
      case "football.addTime": {
        const seconds = Number(args["seconds"]);
        if (!Number.isFinite(seconds) || seconds <= 0) throw new RuleRuntimeError("Add Time needs a number of seconds above 0");
        this.secondsLeft += seconds;
        this.effects.push({ type: "time", seconds, left: this.secondsLeft });
        return;
      }
      case "football.changeScore": {
        const team = this.side(args["team"]);
        const amount = Math.trunc(Number(args["amount"]));
        if (!Number.isFinite(amount)) throw new RuleRuntimeError("Change Score needs a whole number of goals");
        this.score[team] = Math.max(0, this.score[team] + amount);
        this.effects.push({ type: "score", team, change: amount, home: this.score.home, away: this.score.away });
        return;
      }
      case "football.endMatch":
        this.ended = this.text(args["text"]);
        this.effects.push({ type: "end", text: this.ended });
        return;
      default:
        throw new RuleRuntimeError(`Unknown football action '${fn}'`);
    }
  }

  query(fn: string, args: Record<string, Scalar>): Scalar {
    switch (fn) {
      case "football.score":
        return this.score[this.side(args["team"])];
      case "football.timeLeft":
        return this.secondsLeft;
      case "football.teamName":
        return this.match[this.side(args["team"])].name;
      default:
        throw new RuleRuntimeError(`Unknown football query '${fn}'`);
    }
  }
}
