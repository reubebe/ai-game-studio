import { RuleRuntimeError, type CallResult, type RuleHost, type Scalar } from "@gamestudio/rules-core";
import type { Level } from "./level";

export type PlatformerEffect =
  | { type: "message"; text: string; seconds: number }
  | { type: "objective"; text: string }
  | { type: "door"; doorId: string }
  | { type: "sound"; sound: string }
  | { type: "visibility"; objectId: string; visible: boolean }
  | { type: "win"; text: string };

/**
 * In-studio stand-in for the Godot game: answers the same host calls from the level layout, so rules can
 * be tested without launching the engine. Mirrors platformer_host.gd in the Godot template.
 */
export class PlatformerSimHost implements RuleHost {
  collected = new Set<string>();
  openDoors = new Set<string>();
  hidden = new Set<string>();
  hurts = 0;
  objective = "";
  won: string | null = null;
  effects: PlatformerEffect[] = [];

  constructor(readonly level: Level) {}

  /** Mark a coin collected before the rules handle the collect event (the game does the same). */
  collect(itemId: string): { kind: string } {
    const item = this.level.objects.find((o) => o.id === itemId);
    if (!item || item.type !== "coin") throw new Error(`'${itemId}' is not a coin in this level`);
    if (this.collected.has(itemId)) throw new Error(`'${itemId}' was already collected`);
    this.collected.add(itemId);
    return { kind: item.kind };
  }

  private text(value: Scalar | undefined): string {
    return typeof value === "string" ? value : String(value ?? "");
  }

  call(fn: string, args: Record<string, Scalar>): CallResult {
    switch (fn) {
      case "platformer.message":
        this.effects.push({ type: "message", text: this.text(args["text"]), seconds: typeof args["seconds"] === "number" ? args["seconds"] : 3 });
        return;
      case "platformer.objective":
        this.objective = this.text(args["text"]);
        this.effects.push({ type: "objective", text: this.objective });
        return;
      case "platformer.openDoor": {
        const id = this.text(args["doorId"]);
        if (!this.level.objects.some((o) => o.id === id && o.type === "door")) throw new RuleRuntimeError(`There is no door '${id}' in this level`);
        this.openDoors.add(id);
        this.effects.push({ type: "door", doorId: id });
        return;
      }
      case "platformer.sound":
        this.effects.push({ type: "sound", sound: this.text(args["sound"]) });
        return;
      case "platformer.setVisible": {
        const id = this.text(args["objectId"]);
        if (!this.level.objects.some((o) => o.id === id)) throw new RuleRuntimeError(`There is no object '${id}' in this level`);
        const visible = args["visible"] === true;
        if (visible) this.hidden.delete(id);
        else this.hidden.add(id);
        this.effects.push({ type: "visibility", objectId: id, visible });
        return;
      }
      case "platformer.win":
        this.won = this.text(args["text"]);
        this.effects.push({ type: "win", text: this.won });
        return;
      default:
        throw new RuleRuntimeError(`Unknown platformer action '${fn}'`);
    }
  }

  query(fn: string, args: Record<string, Scalar>): Scalar {
    switch (fn) {
      case "platformer.collectedCount": {
        const kind = this.text(args["kind"]);
        return [...this.collected].filter((id) => this.level.objects.some((o) => o.id === id && o.type === "coin" && o.kind === kind)).length;
      }
      case "platformer.totalCount": {
        const kind = this.text(args["kind"]);
        return this.level.objects.filter((o) => o.type === "coin" && o.kind === kind).length;
      }
      case "platformer.isDoorOpen":
        return this.openDoors.has(this.text(args["doorId"]));
      case "platformer.hurtCount":
        return this.hurts;
      default:
        throw new RuleRuntimeError(`Unknown platformer query '${fn}'`);
    }
  }
}
