import { RuleRuntimeError, type CallResult, type RuleHost, type Scalar } from "@gamestudio/rules-core";
import type { Crop, Farm } from "./farm";

export type FarmEffect =
  | { type: "message"; text: string; seconds: number }
  | { type: "goal"; text: string }
  | { type: "sound"; sound: string }
  | { type: "money"; change: number; money: number }
  | { type: "price"; crop: string; price: number }
  | { type: "rain" }
  | { type: "end"; text: string };

/** A planted tile: its crop, the days it has grown, and whether it was watered today. */
export interface SimPlot {
  crop: string;
  grown: number;
  watered: boolean;
}

/**
 * In-studio stand-in for the Godot farm: answers the same host calls from the farm's settings, so rules
 * can be tested without launching the engine. It keeps money, days, prices, the harvest and what grows
 * on how many tiles, not where they are.
 */
export class FarmSimHost implements RuleHost {
  money: number;
  day = 1;
  raining = false;
  prices: Record<string, number>;
  plots: SimPlot[] = [];
  inventory: Record<string, number> = {};
  harvested: Record<string, number> = {};
  sold: Record<string, number> = {};
  goal = "";
  ended: string | null = null;
  effects: FarmEffect[] = [];
  readonly soilTiles: number;

  constructor(readonly farm: Farm) {
    this.money = farm.startMoney;
    this.prices = Object.fromEntries(farm.crops.map((c) => [c.id, c.price]));
    this.soilTiles = farm.map.rows.join("").split("").filter((ch) => ch === "s").length;
  }

  crop(id: string): Crop {
    const c = this.farm.crops.find((x) => x.id === id);
    if (!c) throw new RuleRuntimeError(`There is no crop '${id}' on this farm`);
    return c;
  }

  /** Plants one tile (paying for the seed first, as the game does). */
  plant(cropId: string): { crop: string; cropName: string } {
    const c = this.crop(cropId);
    if (this.plots.length >= this.soilTiles) throw new Error("Every soil tile is planted");
    if (this.money < c.seedCost) throw new Error(`A ${c.name} seed costs ${c.seedCost}; there is only ${this.money}`);
    this.money -= c.seedCost;
    this.plots.push({ crop: c.id, grown: 0, watered: this.raining });
    return { crop: c.id, cropName: c.name };
  }

  /** Waters every planted tile for today. */
  waterAll(): number {
    for (const p of this.plots) p.watered = true;
    return this.plots.length;
  }

  /** Tiles of a crop ready to harvest. */
  ready(cropId: string): number {
    const c = this.crop(cropId);
    return this.plots.filter((p) => p.crop === c.id && p.grown >= c.days).length;
  }

  /** Harvests one ready tile of a crop: its yield goes to the basket; a crop that regrows stays planted. */
  harvest(cropId: string): { crop: string; cropName: string; amount: number } {
    const c = this.crop(cropId);
    const i = this.plots.findIndex((p) => p.crop === c.id && p.grown >= c.days);
    if (i < 0) throw new Error(`No ${c.name} is ready to harvest`);
    if (c.regrow > 0) this.plots[i]!.grown = c.days - c.regrow;
    else this.plots.splice(i, 1);
    this.inventory[c.id] = (this.inventory[c.id] ?? 0) + c.yield;
    this.harvested[c.id] = (this.harvested[c.id] ?? 0) + c.yield;
    return { crop: c.id, cropName: c.name, amount: c.yield };
  }

  /** Sells all of a crop in the basket at today's price (paid before the rules hear of it). */
  sell(cropId: string): { crop: string; amount: number; coins: number } {
    const c = this.crop(cropId);
    const amount = this.inventory[c.id] ?? 0;
    if (amount <= 0) throw new Error(`There is no ${c.name} to sell`);
    const coins = amount * (this.prices[c.id] ?? c.price);
    this.money += coins;
    this.inventory[c.id] = 0;
    this.sold[c.id] = (this.sold[c.id] ?? 0) + amount;
    return { crop: c.id, amount, coins };
  }

  /** The next morning: tiles that were watered (or rained on, or need no water) grow a day. */
  newDay(rain: boolean): { day: number; rain: boolean } {
    if (this.ended !== null) throw new Error("The season has ended");
    for (const p of this.plots) {
      const c = this.crop(p.crop);
      if (p.watered || this.raining || !c.needsWater) p.grown = Math.min(p.grown + 1, c.days);
      p.watered = rain;
    }
    this.day += 1;
    this.raining = rain;
    return { day: this.day, rain };
  }

  private text(value: Scalar | undefined): string {
    return typeof value === "string" ? value : String(value ?? "");
  }

  private amount(value: Scalar | undefined, what: string): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new RuleRuntimeError(`${what} needs a number of 0 or more`);
    return Math.round(n);
  }

  call(fn: string, args: Record<string, Scalar>): CallResult {
    switch (fn) {
      case "farm.message":
        this.effects.push({ type: "message", text: this.text(args["text"]), seconds: typeof args["seconds"] === "number" ? args["seconds"] : 4 });
        return;
      case "farm.goal":
        this.goal = this.text(args["text"]);
        this.effects.push({ type: "goal", text: this.goal });
        return;
      case "farm.sound":
        this.effects.push({ type: "sound", sound: this.text(args["sound"]) });
        return;
      case "farm.giveMoney": {
        const n = this.amount(args["amount"], "Give Money");
        this.money += n;
        this.effects.push({ type: "money", change: n, money: this.money });
        return;
      }
      case "farm.takeMoney": {
        const n = Math.min(this.amount(args["amount"], "Take Money"), this.money);
        this.money -= n;
        this.effects.push({ type: "money", change: -n, money: this.money });
        return;
      }
      case "farm.setPrice": {
        const c = this.crop(this.text(args["crop"]));
        const price = this.amount(args["price"], "Set Crop Price");
        this.prices[c.id] = price;
        this.effects.push({ type: "price", crop: c.id, price });
        return;
      }
      case "farm.rain":
        this.raining = true;
        for (const p of this.plots) p.watered = true;
        this.effects.push({ type: "rain" });
        return;
      case "farm.endSeason":
        this.ended = this.text(args["text"]);
        this.effects.push({ type: "end", text: this.ended });
        return;
      default:
        throw new RuleRuntimeError(`Unknown farm action '${fn}'`);
    }
  }

  private count(table: Record<string, number>, crop: string): number {
    if (crop === "") return Object.values(table).reduce((a, b) => a + b, 0);
    return table[this.crop(crop).id] ?? 0;
  }

  query(fn: string, args: Record<string, Scalar>): Scalar {
    switch (fn) {
      case "farm.money":
        return this.money;
      case "farm.day":
        return this.day;
      case "farm.harvestedCount":
        return this.count(this.harvested, this.text(args["crop"]).trim());
      case "farm.soldCount":
        return this.count(this.sold, this.text(args["crop"]).trim());
      case "farm.price": {
        const c = this.crop(this.text(args["crop"]));
        return this.prices[c.id] ?? c.price;
      }
      case "farm.basePrice":
        return this.crop(this.text(args["crop"])).price;
      case "farm.growing":
        return this.plots.length;
      case "farm.raining":
        return this.raining;
      default:
        throw new RuleRuntimeError(`Unknown farm query '${fn}'`);
    }
  }
}
