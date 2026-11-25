import { RuleRuntimeError, type CallResult, type RuleHost, type Scalar } from "@gamestudio/rules-core";
import type { World } from "./world";

export type SimEffect =
  | { type: "message"; text: string; seconds: number }
  | { type: "objective"; text: string }
  | { type: "gate"; gateId: string }
  | { type: "sound"; sound: string }
  | { type: "visibility"; objectId: string; visible: boolean }
  | { type: "win"; text: string }
  | { type: "health"; health: number; max: number; change: number }
  | { type: "timer"; timerId: string; seconds: number; repeat: boolean; countdown: string }
  | { type: "timerStopped"; timerId: string };

/** A running timer: seconds left, its length, whether it starts again, and the label shown with the countdown. */
export interface SimTimer {
  left: number;
  seconds: number;
  repeat: boolean;
  countdown: string;
}

/** An event the game raises after a rule action (the simulator runs it next, as the game does). */
export interface SimEvent {
  event: string;
  payload: Record<string, Scalar>;
}

/** Hearts the player has when the level does not say. */
export const DEFAULT_HEALTH = 3;

/**
 * In-studio stand-in for the Godot game: answers the same host calls from the world layout,
 * so rules can be tested without launching the engine. It models game state, not physics.
 */
export class ExploreSimHost implements RuleHost {
  collected = new Set<string>();
  openGates = new Set<string>();
  hidden = new Set<string>();
  defeated = new Set<string>();
  /** Which zone each block stands in (blocks outside every zone are left out). */
  blockZones = new Map<string, string>();
  timers = new Map<string, SimTimer>();
  readonly maxHealth: number;
  health: number;
  objective = "";
  won: string | null = null;
  effects: SimEffect[] = [];
  /** Events the game would raise because of what the rules did (a Hurt Player that took the last heart). */
  pending: SimEvent[] = [];

  constructor(readonly world: World) {
    this.maxHealth = world.player.health ?? DEFAULT_HEALTH;
    this.health = this.maxHealth;
  }

  private object(id: string, type: string): World["objects"][number] {
    const o = this.world.objects.find((x) => x.id === id && x.type === type);
    if (!o) throw new Error(`'${id}' is not ${type === "enemy" ? "an enemy" : type === "crate" ? "a block" : `a ${type}`} in this level`);
    return o;
  }

  /** Mark an item as collected before the rules handle the collect event (the game does the same). */
  collect(itemId: string): { kind: string } {
    const item = this.object(itemId, "collectible");
    if (item.type !== "collectible") throw new Error(`'${itemId}' is not a collectible in this level`);
    if (this.collected.has(itemId)) throw new Error(`'${itemId}' was already collected`);
    this.collected.add(itemId);
    return { kind: item.kind };
  }

  /** The player's attack took an enemy's last health point (before the rules hear of it, as in the game). */
  defeat(enemyId: string): { kind: string } {
    const enemy = this.object(enemyId, "enemy");
    if (enemy.type !== "enemy") throw new Error(`'${enemyId}' is not an enemy in this level`);
    if (this.defeated.has(enemyId)) throw new Error(`'${enemyId}' was already defeated`);
    this.defeated.add(enemyId);
    return { kind: enemy.kind };
  }

  /**
   * An enemy touched the player: hearts go down by its damage. Returns the events the game raises, in
   * order: On Player Hurt, and On Player Defeated when no hearts are left (the player then starts again
   * with full health).
   */
  hitBy(enemyId: string): SimEvent[] {
    const enemy = this.object(enemyId, "enemy");
    if (enemy.type !== "enemy") throw new Error(`'${enemyId}' is not an enemy in this level`);
    if (this.defeated.has(enemyId)) throw new Error(`'${enemyId}' has been defeated`);
    const events: SimEvent[] = [{ event: "playerHurt", payload: { sourceId: enemyId } }];
    if (this.loseHearts(enemy.damage)) events.push({ event: "playerDefeated", payload: { sourceId: enemyId } });
    return events;
  }

  /** Takes hearts; true when that took the last one (health is then full again, as after the game's respawn). */
  private loseHearts(amount: number): boolean {
    const before = this.health;
    this.health = Math.max(0, this.health - amount);
    this.effects.push({ type: "health", health: this.health, max: this.maxHealth, change: this.health - before });
    if (this.health > 0) return false;
    this.health = this.maxHealth;
    this.effects.push({ type: "health", health: this.health, max: this.maxHealth, change: this.maxHealth });
    return true;
  }

  /** The player pushed a block into a zone (it leaves any zone it stood in). */
  push(blockId: string, zoneId: string): void {
    this.object(blockId, "crate");
    this.object(zoneId, "zone");
    if (this.blockZones.get(blockId) === zoneId) throw new Error(`'${blockId}' already stands in '${zoneId}'`);
    this.blockZones.set(blockId, zoneId);
  }

  /** A running timer reaches zero: a repeating one starts again, others stop. */
  runOut(timerId: string): void {
    const t = this.timers.get(timerId);
    if (!t) throw new Error(`No timer called '${timerId}' is running`);
    if (t.repeat) t.left = t.seconds;
    else this.timers.delete(timerId);
  }

  private text(value: Scalar | undefined): string {
    return typeof value === "string" ? value : String(value ?? "");
  }

  private hearts(value: Scalar | undefined): number {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n < 0) throw new RuleRuntimeError("Hearts must be a number of 0 or more");
    return Math.floor(n);
  }

  call(fn: string, args: Record<string, Scalar>): CallResult {
    switch (fn) {
      case "explore.message":
        this.effects.push({ type: "message", text: this.text(args["text"]), seconds: typeof args["seconds"] === "number" ? args["seconds"] : 4 });
        return;
      case "explore.objective":
        this.objective = this.text(args["text"]);
        this.effects.push({ type: "objective", text: this.objective });
        return;
      case "explore.openGate": {
        const id = this.text(args["gateId"]);
        if (!this.world.objects.some((o) => o.id === id && o.type === "gate")) throw new RuleRuntimeError(`There is no gate '${id}' in this level`);
        this.openGates.add(id);
        this.effects.push({ type: "gate", gateId: id });
        return;
      }
      case "explore.sound":
        this.effects.push({ type: "sound", sound: this.text(args["sound"]) });
        return;
      case "explore.setVisible": {
        const id = this.text(args["objectId"]);
        if (!this.world.objects.some((o) => o.id === id)) throw new RuleRuntimeError(`There is no object '${id}' in this level`);
        const visible = args["visible"] === true;
        if (visible) this.hidden.delete(id);
        else this.hidden.add(id);
        this.effects.push({ type: "visibility", objectId: id, visible });
        return;
      }
      case "explore.win":
        this.won = this.text(args["text"]);
        this.timers.clear();
        this.effects.push({ type: "win", text: this.won });
        return;
      case "explore.hurtPlayer": {
        const amount = this.hearts(args["amount"]);
        if (amount > 0 && this.loseHearts(amount)) this.pending.push({ event: "playerDefeated", payload: { sourceId: "rules" } });
        return;
      }
      case "explore.healPlayer": {
        const before = this.health;
        this.health = Math.min(this.maxHealth, this.health + this.hearts(args["amount"]));
        this.effects.push({ type: "health", health: this.health, max: this.maxHealth, change: this.health - before });
        return;
      }
      case "explore.startTimer": {
        const id = this.text(args["timerId"]).trim();
        const seconds = typeof args["seconds"] === "number" ? args["seconds"] : Number(args["seconds"]);
        if (!id) throw new RuleRuntimeError("A timer needs a name");
        if (!Number.isFinite(seconds) || seconds <= 0) throw new RuleRuntimeError(`Timer '${id}' needs a number of seconds above 0`);
        const t: SimTimer = { left: seconds, seconds, repeat: args["repeat"] === true, countdown: this.text(args["countdown"]) };
        this.timers.set(id, t);
        this.effects.push({ type: "timer", timerId: id, seconds, repeat: t.repeat, countdown: t.countdown });
        return;
      }
      case "explore.stopTimer": {
        const id = this.text(args["timerId"]);
        if (this.timers.delete(id)) this.effects.push({ type: "timerStopped", timerId: id });
        return;
      }
      default:
        throw new RuleRuntimeError(`Unknown exploration action '${fn}'`);
    }
  }

  query(fn: string, args: Record<string, Scalar>): Scalar {
    switch (fn) {
      case "explore.collectedCount": {
        const kind = this.text(args["kind"]);
        return [...this.collected].filter((id) => this.world.objects.some((o) => o.id === id && o.type === "collectible" && o.kind === kind)).length;
      }
      case "explore.totalCount": {
        const kind = this.text(args["kind"]);
        return this.world.objects.filter((o) => o.type === "collectible" && o.kind === kind).length;
      }
      case "explore.isGateOpen":
        return this.openGates.has(this.text(args["gateId"]));
      case "explore.playerHealth":
        return this.health;
      case "explore.defeatedCount": {
        const kind = this.text(args["kind"]);
        return [...this.defeated].filter((id) => this.world.objects.some((o) => o.id === id && o.type === "enemy" && o.kind === kind)).length;
      }
      case "explore.enemyCount": {
        const kind = this.text(args["kind"]);
        return this.world.objects.filter((o) => o.type === "enemy" && o.kind === kind).length;
      }
      case "explore.blocksInZone": {
        const zone = this.text(args["zoneId"]);
        return [...this.blockZones.values()].filter((z) => z === zone).length;
      }
      case "explore.timeLeft":
        return this.timers.get(this.text(args["timerId"]))?.left ?? 0;
      default:
        throw new RuleRuntimeError(`Unknown exploration query '${fn}'`);
    }
  }
}
