import { RuleRuntimeError, type CallResult, type RuleHost, type Scalar } from "@gamestudio/rules-core";
import { advance, checkMove, hasWon, HOME, ILLEGAL_MESSAGES, legalTokens, passTurn, resolveCapture, rollDie, YARD, type LudoConfig, type LudoEvent, type LudoState } from "./engine";

function int(value: Scalar | undefined, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new RuleRuntimeError(`'${name}' must be a whole number from ${min} to ${max}`);
  return value;
}

/**
 * Executes the ludo.* host functions used by compiled rule graphs. Holds an immutable LudoState that is
 * replaced at every step, so a caller can discard a rejected or failed run by ignoring `host.state`.
 */
export class LudoHost implements RuleHost {
  events: LudoEvent[] = [];
  messages: string[] = [];
  rejected: string | null = null;
  private captured = 0;
  private reachedHome = false;

  constructor(readonly config: LudoConfig, public state: LudoState) {}

  call(fn: string, args: Record<string, Scalar>): CallResult {
    const s = this.state;
    const player = s.toMove;
    switch (fn) {
      case "ludo.roll": {
        if (s.status !== "playing") throw new RuleRuntimeError("The game is over");
        if (s.dice !== null) throw new RuleRuntimeError("The last roll has not been used yet");
        const r = rollDie(s);
        const sixes = r.value === 6 ? s.sixes + 1 : s.sixes;
        this.state = { ...r.state, dice: r.value, sixes };
        this.events.push({ type: "roll", player, value: r.value });
        return { value: r.value, sixes };
      }
      case "ludo.checkSixes": {
        const over = s.dice === 6 && this.config.maxSixes > 0 && s.sixes >= this.config.maxSixes;
        if (over) this.events.push({ type: "sixes", player, count: s.sixes });
        return { over };
      }
      case "ludo.canMove": {
        const yes = legalTokens(s, this.config).length > 0;
        if (!yes) this.events.push({ type: "no-move", player, value: s.dice ?? 0 });
        return { yes };
      }
      case "ludo.checkMove": {
        const check = checkMove(s, int(args["token"], "token", 0, 3), this.config);
        return check.legal ? { legal: true, reason: "" } : { legal: false, reason: ILLEGAL_MESSAGES[check.reason] };
      }
      case "ludo.reject":
        this.rejected = typeof args["reason"] === "string" && args["reason"] ? args["reason"] : "That move is not allowed.";
        return;
      case "ludo.advance": {
        const token = int(args["token"], "token", 0, 3);
        const check = checkMove(s, token, this.config);
        if (!check.legal) throw new RuleRuntimeError(ILLEGAL_MESSAGES[check.reason]);
        const from = s.tokens[player]![token]!;
        this.state = advance(s, token, check.to);
        this.events.push(from === YARD ? { type: "enter", player, token } : { type: "move", player, token, from, to: check.to });
        this.reachedHome = check.to === HOME;
        if (this.reachedHome) this.events.push({ type: "home", player, token });
        return { home: this.reachedHome };
      }
      case "ludo.capture": {
        const cap = resolveCapture(s, int(args["token"], "token", 0, 3), this.config);
        this.state = cap.state;
        this.captured = cap.victims.length;
        if (cap.victims.length > 0) this.events.push({ type: "capture", player, victims: cap.victims });
        return { captured: cap.victims.length };
      }
      case "ludo.checkWin":
        return { won: hasWon(s, player) };
      case "ludo.finish":
        this.state = { ...s, dice: null, status: "finished", winner: player };
        this.events.push({ type: "win", player });
        return;
      case "ludo.bonus": {
        const again = (s.dice === 6 && this.config.bonusOnSix) || (this.captured > 0 && this.config.bonusOnCapture) || (this.reachedHome && this.config.bonusOnHome);
        return { again };
      }
      case "ludo.again":
        if (s.status !== "playing") return;
        this.state = { ...s, dice: null };
        this.events.push({ type: "again", player });
        return;
      case "ludo.nextTurn":
        if (s.status !== "playing") return;
        this.state = passTurn(s);
        this.events.push({ type: "turn", player: this.state.toMove });
        return;
      case "ludo.announce":
        this.messages.push(String(args["text"] ?? ""));
        return;
      default:
        throw new RuleRuntimeError(`Unknown Ludo action '${fn}'`);
    }
  }

  query(fn: string, args: Record<string, Scalar>): Scalar {
    const s = this.state;
    switch (fn) {
      case "ludo.toMove":
        return s.toMove;
      case "ludo.lastRoll":
        return s.dice ?? 0;
      case "ludo.home":
        return (s.tokens[int(args["player"], "player", 0, s.seats.length - 1)] ?? []).filter((p) => p === HOME).length;
      case "ludo.progress": {
        const list = s.tokens[int(args["player"], "player", 0, s.seats.length - 1)] ?? [];
        return list[int(args["token"], "token", 0, list.length - 1)] ?? YARD;
      }
      default:
        throw new RuleRuntimeError(`Unknown Ludo query '${fn}'`);
    }
  }
}
