import { RuleRuntimeError, type CallResult, type RuleHost, type Scalar } from "@gamestudio/rules-core";
import {
  captureEvents,
  checkMove,
  checkTermination,
  finish,
  ILLEGAL_MESSAGES,
  opponent,
  ownedPits,
  ownerAt,
  passTurn,
  planCapture,
  playAgain,
  resolveCapture,
  seedsOwned,
  sowingEvents,
  sowMove,
  startNextRound,
  sweep,
  PIT_COUNT,
  type EndReason,
  type OwareConfig,
  type OwareEvent,
  type OwareState,
  type Player,
} from "./engine";

const END_REASONS: EndReason[] = ["majority", "draw", "no-legal-move", "repetition", "agreement", "territory"];

function int(value: Scalar | undefined, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new RuleRuntimeError(`'${name}' must be a whole number from ${min} to ${max}`);
  }
  return value;
}

/**
 * Executes the oware.* host functions used by compiled rule graphs.
 * Holds an immutable OwareState that is replaced at every step, so a caller can
 * discard all changes from a rejected or failed run by ignoring `host.state`.
 */
export class OwareHost implements RuleHost {
  events: OwareEvent[] = [];
  messages: string[] = [];
  rejected: string | null = null;

  constructor(readonly config: OwareConfig, public state: OwareState) {}

  call(fn: string, args: Record<string, Scalar>): CallResult {
    const s = this.state;
    switch (fn) {
      case "oware.checkLegal": {
        const check = checkMove(s, int(args["pit"], "pit", 0, PIT_COUNT - 1), this.config);
        return check.legal ? { legal: true, reason: "" } : { legal: false, reason: ILLEGAL_MESSAGES[check.reason] };
      }
      case "oware.reject":
        this.rejected = typeof args["reason"] === "string" && args["reason"] ? args["reason"] : "That move is not allowed.";
        return;
      case "oware.sow": {
        const pit = int(args["pit"], "pit", 0, PIT_COUNT - 1);
        if (s.status !== "playing") throw new RuleRuntimeError("The game is over");
        if (ownerAt(s, pit) !== s.toMove) throw new RuleRuntimeError(`Pit ${pit} is not the moving player's`);
        const seeds = s.pits[pit] ?? 0;
        if (seeds === 0) throw new RuleRuntimeError(`Pit ${pit} is empty`);
        const sown = sowMove(s.pits, s.scores, s.owners, s.toMove, pit, this.config);
        if (sown.endless) throw new RuleRuntimeError(ILLEGAL_MESSAGES.endless);
        this.state = { ...s, pits: sown.pits, scores: sown.scores, ply: s.ply + 1 };
        this.events.push(...sowingEvents(s.toMove, pit, seeds, sown, this.config));
        return { lastPit: sown.lastPit, sown: seeds };
      }
      case "oware.capture": {
        const lastPit = int(args["lastPit"], "lastPit", 0, PIT_COUNT - 1);
        const mover = s.toMove;
        const plan = planCapture(s.pits, mover, lastPit, this.config, s.owners);
        const cap = resolveCapture(s.pits, s.scores, mover, lastPit, this.config, s.owners);
        this.events.push(...captureEvents(mover, cap, plan, this.config));
        this.state = { ...s, pits: cap.pits, scores: cap.scores };
        return { captured: cap.captured, grandSlam: cap.grandSlam };
      }
      case "oware.checkEnd": {
        const t = checkTermination(s, this.config);
        return { outcome: t.outcome, winner: t.outcome === "win" ? t.winner : -1 };
      }
      case "oware.sweep": {
        const swept = sweep(s);
        this.state = swept.state;
        this.events.push({ type: "sweep", seeds: swept.seeds });
        return;
      }
      case "oware.finish": {
        const reason = END_REASONS.includes(args["reason"] as EndReason) ? (args["reason"] as EndReason) : "majority";
        this.state = finish(s, reason);
        this.events.push({ type: "end", result: this.state.result!, scores: [this.state.scores[0], this.state.scores[1]] });
        return;
      }
      case "oware.nextTurn": {
        if (s.status !== "playing") return;
        this.state = passTurn(s);
        this.events.push({ type: "turn", player: this.state.toMove });
        return;
      }
      case "oware.again": {
        if (s.status !== "playing") return;
        this.state = playAgain(s);
        this.events.push({ type: "pass", player: opponent(s.toMove) });
        return;
      }
      case "oware.nextRound": {
        if (s.status !== "playing") return { over: false };
        const next = startNextRound(s, this.config);
        this.state = next.state;
        this.events.push(next.event);
        return { over: next.over };
      }
      case "oware.announce":
        this.messages.push(String(args["text"] ?? ""));
        return;
      default:
        throw new RuleRuntimeError(`Unknown Oware action '${fn}'`);
    }
  }

  query(fn: string, args: Record<string, Scalar>): Scalar {
    const s = this.state;
    switch (fn) {
      case "oware.seeds":
        return s.pits[int(args["pit"], "pit", 0, PIT_COUNT - 1)] ?? 0;
      case "oware.score":
        return s.scores[int(args["player"], "player", 0, 1) as Player];
      case "oware.toMove":
        return s.toMove;
      case "oware.owner":
        return ownerAt(s, int(args["pit"], "pit", 0, PIT_COUNT - 1));
      case "oware.sideSeeds":
        return seedsOwned(s.pits, s.owners, int(args["player"], "player", 0, 1) as Player);
      case "oware.houses":
        return ownedPits(s, int(args["player"], "player", 0, 1) as Player).length;
      case "oware.round":
        return s.round ?? 1;
      default:
        throw new RuleRuntimeError(`Unknown Oware query '${fn}'`);
    }
  }
}
