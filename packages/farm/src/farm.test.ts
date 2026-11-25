import { describe, expect, it } from "vitest";
import { coreDomain, createRegistry, compileGraph, compileOrThrow, RuleRuntime } from "@gamestudio/rules-core";
import { acreRules, farmDomain, FarmSimHost, paintTile, parseFarm, resizeMap, sunriseAcres, tileAt } from "./index";

const registry = createRegistry([coreDomain, farmDomain]);

function play(farm = sunriseAcres()) {
  const runtime = new RuleRuntime(compileOrThrow(acreRules(), registry));
  const host = new FarmSimHost(farm);
  const run = (event: string, payload: Record<string, string | number | boolean> = {}) => {
    const r = runtime.run(event, payload, host);
    expect(r.error, `${event}: ${r.error?.message}`).toBeUndefined();
  };
  const messages = () => host.effects.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
  return { runtime, host, run, messages };
}

describe("farm settings", () => {
  it("validates Sunrise Acres", () => {
    const r = parseFarm(sunriseAcres());
    expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
    const f = sunriseAcres();
    expect(tileAt(f, f.map.spawn.x, f.map.spawn.y)).toBe("p");
    expect(f.map.rows.join("").split("s").length - 1).toBe(32);
  });

  it("refuses ragged rows, unknown tiles, a blocked start, a missing house or stall, and repeated crop ids", () => {
    const cases: [string, (f: ReturnType<typeof sunriseAcres>) => void, RegExp][] = [
      ["ragged", (f) => { f.map.rows[3] = f.map.rows[3]!.slice(1); }, /Row 4 needs 20 tiles/],
      ["unknown", (f) => { f.map.rows[2] = "x" + f.map.rows[2]!.slice(1); }, /unknown tile 'x'/],
      ["blocked", (f) => { f.map.spawn = { x: 0, y: 0 }; }, /cannot start on tree/],
      ["no house", (f) => { f.map.rows = f.map.rows.map((r) => r.replaceAll("h", "g")); }, /needs a house/],
      ["no stall", (f) => { f.map.rows = f.map.rows.map((r) => r.replaceAll("m", "g")); }, /needs a market stall/],
      ["twice", (f) => { f.crops[1]!.id = f.crops[0]!.id; }, /used twice/],
    ];
    for (const [name, change, message] of cases) {
      const f = sunriseAcres();
      change(f);
      const r = parseFarm(f);
      expect(r.ok, name).toBe(false);
      expect(!r.ok && r.errors.join(" "), name).toMatch(message);
    }
  });

  it("paints tiles and resizes the map, keeping what stays inside it", () => {
    const f = sunriseAcres();
    const painted = paintTile(f, 5, 5, "w");
    expect(tileAt(painted, 5, 5)).toBe("w");
    expect(tileAt(f, 5, 5)).toBe("g");
    const big = resizeMap(f, 24, 14);
    expect(big.map.rows).toHaveLength(14);
    expect(big.map.rows.every((r) => r.length === 24)).toBe(true);
    expect(big.map.rows[2]!.startsWith(f.map.rows[2]!)).toBe(true);
    expect(big.map.rows[13]).toBe("g".repeat(24));
    const small = resizeMap(f, 10, 8);
    expect(small.map.spawn).toEqual({ x: 4, y: 4 });
    expect(small.map.rows.every((r) => r.length === 10)).toBe(true);
  });
});

describe("the simulator stand-in", () => {
  it("pays for seeds, grows watered crops only, harvests, regrows and sells at today's price", () => {
    const host = new FarmSimHost(sunriseAcres());
    expect(host.plant("tomato")).toEqual({ crop: "tomato", cropName: "Tomato" });
    expect(host.money).toBe(52);
    host.plant("cassava");
    host.newDay(false);
    expect(host.plots.map((p) => p.grown)).toEqual([0, 1]);
    for (let i = 0; i < 3; i++) {
      host.waterAll();
      host.newDay(false);
    }
    expect(host.ready("tomato")).toBe(1);
    expect(host.harvest("tomato")).toEqual({ crop: "tomato", cropName: "Tomato", amount: 3 });
    // Tomatoes grow again: two more watered days.
    expect(host.plots.find((p) => p.crop === "tomato")?.grown).toBe(1);
    host.call("farm.setPrice", { crop: "tomato", price: 12 });
    expect(host.sell("tomato")).toEqual({ crop: "tomato", amount: 3, coins: 36 });
    expect(host.money).toBe(52 - 15 + 36);
    expect(() => host.sell("tomato")).toThrow(/no Tomato to sell/);
    expect(() => host.harvest("okra")).toThrow(/No Okra is ready/);
    expect(() => host.plant("pumpkin")).toThrow(/no crop 'pumpkin'/);
  });

  it("rain waters everything; money never goes below zero; counts can cover every crop", () => {
    const host = new FarmSimHost(sunriseAcres());
    host.plant("okra");
    host.call("farm.rain", {});
    host.newDay(false);
    expect(host.plots[0]!.grown).toBe(1);
    host.call("farm.takeMoney", { amount: 1000 });
    expect(host.money).toBe(0);
    expect(() => host.plant("okra")).toThrow(/costs 4/);
    host.call("farm.giveMoney", { amount: 40 });
    expect(host.query("farm.money", {})).toBe(40);
    expect(host.query("farm.harvestedCount", { crop: "" })).toBe(0);
    expect(host.query("farm.basePrice", { crop: "maize" })).toBe(7);
    expect(host.query("farm.growing", {})).toBe(1);
  });
});

describe("Sunrise Acres rules", () => {
  it("compile cleanly", () => {
    expect(compileGraph(acreRules(), registry).diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
  });

  it("set the goal, announce harvests, and double the tomato price on market day only", () => {
    const { host, run, messages } = play();
    run("start");
    expect(host.goal).toBe("Have 300 coins by the morning of day 8.");
    for (let day = 2; day <= 5; day++) run("newDay", host.newDay(false));
    const prices = host.effects.filter((e) => e.type === "price").map((e) => (e as { price: number }).price);
    expect(prices).toEqual([12, 6]);
    expect(messages()).toContain("Market day! Tomatoes sell for double today.");
    host.plant("okra");
    host.waterAll();
    host.newDay(false);
    host.waterAll();
    host.newDay(false);
    run("harvested", host.harvest("okra"));
    expect(messages()).toContain("Harvested 2 Okra");
  });

  it("follow the settings: a dearer tomato is still doubled on market day", () => {
    const farm = sunriseAcres();
    farm.crops.find((c) => c.id === "tomato")!.price = 9;
    const { host, run } = play(farm);
    for (let day = 2; day <= 4; day++) run("newDay", host.newDay(false));
    expect(host.prices["tomato"]).toBe(18);
  });

  it("cheer once when the money reaches 300, and judge the season on the morning of day 8", () => {
    const won = play();
    won.host.call("farm.giveMoney", { amount: 300 });
    won.host.plant("okra");
    won.host.waterAll();
    won.host.newDay(false);
    won.host.waterAll();
    won.host.newDay(false);
    won.host.harvest("okra");
    won.run("sold", won.host.sell("okra"));
    expect(won.host.goal).toBe("300 coins made! Keep farming until the morning of day 8.");
    while (won.host.day < 8) won.run("newDay", won.host.newDay(false));
    expect(won.host.ended).toBe("A fine season! Sunrise Acres made its 300 coins.");
    const lost = play();
    while (lost.host.day < 8) lost.run("newDay", lost.host.newDay(false));
    expect(lost.host.ended).toBe("The season is over, short of 300 coins. Plant early and water every day!");
  });
});
