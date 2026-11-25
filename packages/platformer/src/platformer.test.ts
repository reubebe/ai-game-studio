import { describe, expect, it } from "vitest";
import { coreDomain, compileGraph, createRegistry, RuleRuntime } from "@gamestudio/rules-core";
import { cliffRules, platformerDomain } from "./domain";
import { LEVEL_OBJECT_DEFAULTS, LEVEL_OBJECT_TYPES, objectBox, parseLevel, sunsetCliffs } from "./level";
import { PlatformerSimHost } from "./sim-host";

const registry = createRegistry([coreDomain, platformerDomain]);

describe("platformer level", () => {
  it("the starter level is valid and every coin, flag and door is on or over solid ground", () => {
    const parsed = parseLevel(sunsetCliffs());
    expect(parsed.ok).toBe(true);
    const level = sunsetCliffs();
    const tops = level.objects.filter((o) => o.type === "platform").map((o) => objectBox(o));
    const standsOn = (x: number, y: number) => tops.some((b) => x >= b.x && x <= b.x + b.width && Math.abs(b.y + b.height - y) < 0.01);
    for (const o of level.objects) {
      if (o.type === "checkpoint" || o.type === "goal" || o.type === "door" || o.type === "enemy" || o.type === "sign" || o.type === "spike") expect(standsOn(o.x + (o.type === "spike" ? o.width / 2 : 0), o.y), o.id).toBe(true);
    }
    expect(standsOn(level.player.spawn.x, level.player.spawn.y)).toBe(true);
  });

  it("no step up is higher than the player can jump", () => {
    const level = sunsetCliffs();
    const tops = level.objects.filter((o) => o.type === "platform").map((o) => objectBox(o)).map((b) => b.y + b.height);
    const heights = [...new Set(tops)].sort((a, b) => a - b);
    for (let i = 1; i < heights.length; i++) expect(heights[i]! - heights[i - 1]!, `from ${heights[i - 1]} to ${heights[i]}`).toBeLessThan(level.player.jumpHeight);
  });

  it("refuses duplicate ids, objects outside the level and a level without a goal", () => {
    const level = sunsetCliffs();
    level.objects.push({ ...level.objects[0]!, x: 999 });
    const r = parseLevel(level);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/used twice/);
    const noGoal = { ...sunsetCliffs(), objects: sunsetCliffs().objects.filter((o) => o.type !== "goal") };
    const r2 = parseLevel(noGoal);
    expect(r2.ok).toBe(false);
  });

  it("has a default for every object type", () => {
    for (const t of LEVEL_OBJECT_TYPES) expect(LEVEL_OBJECT_DEFAULTS[t](`${t}_1`, 5, 5).type).toBe(t);
  });
});

describe("Sunset Cliffs rules", () => {
  it("compile, set the objective, open the gate after the last coin and win at the flag", () => {
    const result = compileGraph(cliffRules(), registry);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const runtime = new RuleRuntime(result.program!);
    const host = new PlatformerSimHost(sunsetCliffs());
    expect(runtime.run("start", {}, host).error).toBeUndefined();
    expect(host.objective).toBe("Collect all 8 sun coins to open the gate, then reach the flag.");
    const coins = sunsetCliffs().objects.filter((o) => o.type === "coin");
    for (const c of coins) {
      const { kind } = host.collect(c.id);
      expect(runtime.run("collect", { itemId: c.id, kind }, host).error).toBeUndefined();
    }
    expect(host.openDoors.has("door_goal")).toBe(true);
    expect(host.effects.filter((e) => e.type === "message").map((e) => (e as { text: string }).text)).toContain("Sun coin 8 of 8");
    expect(runtime.run("checkpoint", { checkpointId: "checkpoint_1" }, host).error).toBeUndefined();
    expect(runtime.run("hurt", { cause: "spike" }, host).error).toBeUndefined();
    expect(runtime.run("goal", { goalId: "goal" }, host).error).toBeUndefined();
    expect(host.won).toMatch(/Level complete/);
  });
});

import { reachWarnings as reach } from "./level";
describe("reach warnings", () => {
  it("finds nothing to warn about in Sunset Cliffs, and catches a coin and a ledge set too high", () => {
    const level = sunsetCliffs();
    expect(reach(level)).toEqual([]);
    level.objects.push({ id: "coin_high", type: "coin", x: 1, y: 12, kind: "coin", label: "Coin" });
    level.objects.push({ id: "ledge_high", type: "platform", x: 8, y: 10, width: 3, height: 1, style: "stone" });
    level.objects.push({ id: "sign_air", type: "sign", x: 3, y: 9, text: "Hi" });
    const w = reach(level);
    expect(w.some((m) => m.startsWith("'coin_high'"))).toBe(true);
    expect(w.some((m) => m.startsWith("'ledge_high'"))).toBe(true);
    expect(w.some((m) => m.startsWith("'sign_air'"))).toBe(true);
  });
});

import { spriteSchema } from "./level";
describe("player sprite sheets", () => {
  it("accepts a sheet in the assets folder and refuses frames outside its grid", () => {
    const level = sunsetCliffs();
    const sprite = { asset: "assets/sprites/hero.png", columns: 4, rows: 2, idle: [0, 1], run: [4, 5, 6, 7], jump: [3] };
    const ok = parseLevel({ ...level, player: { ...level.player, sprite } });
    expect(ok.ok && ok.level.player.sprite).toEqual({ ...sprite, fps: 10, height: 1.5, facing: "right", pixelArt: true });
    expect(spriteSchema.safeParse({ ...sprite, run: [8] }).error?.issues[0]?.message).toMatch(/Frame 8 is outside the 4 x 2 sheet/);
    expect(spriteSchema.safeParse({ ...sprite, idle: [] }).success).toBe(false);
    for (const asset of ["sprites/hero.png", "assets/../hero.png", "assets/hero.gif", "/assets/hero.png"]) expect(spriteSchema.safeParse({ ...sprite, asset }).success, asset).toBe(false);
  });
});
