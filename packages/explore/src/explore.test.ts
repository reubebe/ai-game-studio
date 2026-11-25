import { describe, expect, it } from "vitest";
import { coreDomain, createRegistry, compileGraph, compileOrThrow, RuleRuntime } from "@gamestudio/rules-core";
import { exploreDomain, valleyRules, ExploreSimHost, sunCrystalValley, parseWorld, nextObjectId, OBJECT_DEFAULTS, OBJECT_TYPES } from "./index";

const registry = createRegistry([coreDomain, exploreDomain]);

function play() {
  const world = sunCrystalValley();
  const runtime = new RuleRuntime(compileOrThrow(valleyRules(), registry));
  const host = new ExploreSimHost(world);
  return { world, runtime, host };
}

describe("world layout", () => {
  it("validates the starter level", () => {
    const r = parseWorld(sunCrystalValley());
    expect(r.ok).toBe(true);
  });

  it("rejects duplicate ids and objects outside the map", () => {
    const w = sunCrystalValley();
    w.objects.push({ ...w.objects[0]!, x: 500 });
    const r = parseWorld(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/used twice|outside the map/);
  });

  it("creates valid defaults for every object type", () => {
    const w = sunCrystalValley();
    for (const t of OBJECT_TYPES) {
      const o = OBJECT_DEFAULTS[t](nextObjectId(w, t), 1, 1);
      // A model's file is chosen when it is placed.
      if (o.type === "model") o.asset = "assets/models/crate.glb";
      w.objects.push(o);
    }
    expect(parseWorld(w).ok).toBe(true);
  });

  it("accepts model and texture files only inside the assets folder", () => {
    const w = sunCrystalValley();
    const model = (asset: string) => ({ ...w, objects: [{ id: "m", type: "model" as const, x: 0, z: 0, rotation: 0, scale: 40, asset, collide: true }] });
    expect(parseWorld(model("assets/models/Barrel 01/Barrel_01_1k.gltf")).ok).toBe(true);
    for (const bad of ["", "models/a.glb", "assets/../secret.glb", "assets/models/../../x.glb", "/assets/a.glb", "assets/a.fbx", "assets/.hidden/a.glb"]) expect(parseWorld(model(bad)).ok, bad).toBe(false);
    // An empty model path explains itself.
    const r = parseWorld(model(""));
    expect(!r.ok && r.errors.join(" ")).toMatch(/Choose a \.glb/);
    const ground = { ...w, environment: { ...w.environment, quality: "high" as const, groundMaterial: { albedo: "assets/textures/rocks_diff_1k.jpg", normal: "assets/textures/rocks_nor_gl_1k.jpg", tile: 4 } } };
    expect(parseWorld(ground).ok).toBe(true);
    expect(parseWorld({ ...ground, environment: { ...ground.environment, groundMaterial: { albedo: "../rocks.jpg", tile: 4 } } }).ok).toBe(false);
  });
});

describe("Sun Crystal Valley rules", () => {
  it("compile cleanly", () => {
    const result = compileGraph(valleyRules(), registry);
    expect(result.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
  });

  it("set the objective from the number of crystals in the level", () => {
    const { runtime, host } = play();
    runtime.run("start", {}, host);
    expect(host.objective).toBe("Find the 3 sun crystals hidden in the valley.");
  });

  it("count crystals, open the gate on the last one and allow the shrine to be completed", () => {
    const { runtime, host } = play();
    runtime.run("enterZone", { zoneId: "shrine" }, host);
    expect(host.won).toBeNull();
    for (const id of ["crystal_1", "crystal_2"]) runtime.run("collect", { itemId: id, ...host.collect(id) }, host);
    expect(host.openGates.size).toBe(0);
    expect(host.effects.filter((e) => e.type === "message").map((e) => (e as { text: string }).text)).toEqual(["Sun crystal 1 of 3", "Sun crystal 2 of 3"]);
    const last = runtime.run("collect", { itemId: "crystal_3", ...host.collect("crystal_3") }, host);
    expect(last.error).toBeUndefined();
    expect(host.openGates.has("gate_main")).toBe(true);
    expect(host.objective).toMatch(/gate is open/);
    runtime.run("enterZone", { zoneId: "shrine" }, host);
    expect(host.won).toMatch(/sun shrine/);
  });

  it("changes the elder's dialogue after the first conversation", () => {
    const { runtime, host } = play();
    runtime.run("interact", { targetId: "elder" }, host);
    runtime.run("interact", { targetId: "elder" }, host);
    runtime.run("interact", { targetId: "sign_path" }, host);
    const lines = host.effects.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/Three sun crystals/);
    expect(lines[1]).toMatch(/Have you found every crystal/);
    expect(runtime.variables["talkedToElder"]).toBe(true);
  });

  it("follows level edits: a fourth crystal raises the target", () => {
    const { world, runtime } = play();
    world.objects.push(OBJECT_DEFAULTS.collectible("crystal_4", 0, 0));
    const host = new ExploreSimHost(world);
    for (const id of ["crystal_1", "crystal_2", "crystal_3"]) runtime.run("collect", { itemId: id, ...host.collect(id) }, host);
    expect(host.openGates.size).toBe(0);
    runtime.run("collect", { itemId: "crystal_4", ...host.collect("crystal_4") }, host);
    expect(host.openGates.has("gate_main")).toBe(true);
  });

  it("reports a rule error when an action names a missing gate", () => {
    const g = valleyRules();
    g.nodes.find((n) => n.id === "open")!.params["gateId"] = "gate_missing";
    const runtime = new RuleRuntime(compileOrThrow(g, registry));
    const host = new ExploreSimHost(sunCrystalValley());
    let result;
    for (const id of ["crystal_1", "crystal_2", "crystal_3"]) result = runtime.run("collect", { itemId: id, ...host.collect(id) }, host);
    expect(result!.error?.message).toMatch(/no gate 'gate_missing'/);
    expect(result!.error?.node).toBe("open");
  });
});

import { guessClips, characterSchema } from "./world";
describe("characters", () => {
  it("guesses idle, walk, run and jump from animation names", () => {
    expect(guessClips(["Dance", "Death", "Idle", "Jump", "No", "Punch", "Running", "Sitting", "Standing", "ThumbsUp", "Walking", "WalkJump", "Wave", "Yes"])).toEqual({ idle: "Idle", walk: "Walking", run: "Running", jump: "Jump" });
    expect(guessClips(["Survey", "Walk", "Run"])).toEqual({ idle: "Survey", walk: "Walk", run: "Run" });
    expect(guessClips(["Armature|mixamo.com|Layer0"])).toEqual({});
    expect(guessClips(["CharacterArmature|Idle_Neutral", "CharacterArmature|Walk_Cycle", "CharacterArmature|Run_Fast", "CharacterArmature|Jump_Idle"])).toEqual({ idle: "CharacterArmature|Idle_Neutral", walk: "CharacterArmature|Walk_Cycle", run: "CharacterArmature|Run_Fast", jump: "CharacterArmature|Jump_Idle" });
  });

  it("accepts a player character and villager models only with files in the assets folder", () => {
    const w = sunCrystalValley();
    const withChar = { ...w, player: { ...w.player, character: { asset: "assets/characters/robot.glb", idle: "Idle", walk: "Walking" } } };
    const r = parseWorld(withChar);
    expect(r.ok && r.world.player.character).toEqual({ asset: "assets/characters/robot.glb", height: 1.8, turn: 180, idle: "Idle", walk: "Walking" });
    expect(parseWorld({ ...w, player: { ...w.player, character: { asset: "../robot.glb" } } }).ok).toBe(false);
    expect(characterSchema.safeParse({ asset: "assets/a.glb", height: 50 }).success).toBe(false);
    const elder = { id: "elder", type: "npc" as const, x: 4, z: 24, rotation: 200, scale: 1, name: "Elder Ama", color: "#c8873a", model: "assets/characters/fox.glb", animation: "Survey", height: 1.2 };
    expect(parseWorld({ ...w, objects: [elder] }).ok).toBe(true);
    expect(parseWorld({ ...w, objects: [{ ...elder, model: "assets/fox.fbx" }] }).ok).toBe(false);
  });
});

import { engineDiagnostics, engineLimit } from "@gamestudio/rules-core";
import { ruinsRules, thornwoodRuins, EXPLORE_NODE, GODOT_ONLY_TYPES } from "./index";

function ruins() {
  const world = thornwoodRuins();
  const runtime = new RuleRuntime(compileOrThrow(ruinsRules(), registry));
  const host = new ExploreSimHost(world);
  /** Runs an event and the ones the game raises after it, as the simulator and the game do. */
  const fire = (event: string, payload: Record<string, string> = {}) => {
    const queue = [{ event, payload }];
    while (queue.length) {
      const next = queue.shift()!;
      const r = runtime.run(next.event, next.payload, host);
      expect(r.error, `${next.event}: ${r.error?.message}`).toBeUndefined();
      queue.push(...(host.pending.splice(0) as { event: string; payload: Record<string, string> }[]));
    }
  };
  const messages = () => host.effects.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
  return { world, runtime, host, fire, messages };
}

describe("Thornwood Ruins", () => {
  it("is a valid level whose rules compile cleanly", () => {
    expect(parseWorld(thornwoodRuins()).ok).toBe(true);
    expect(compileGraph(ruinsRules(), registry).diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
  });

  it("keeps every enemy further from the spawn point than it can see", () => {
    const w = thornwoodRuins();
    for (const o of w.objects) if (o.type === "enemy") expect(Math.hypot(o.x - w.player.spawn.x, o.z - w.player.spawn.z), o.id).toBeGreaterThan(o.sight + 2);
  });

  it("plays through: beetles, both plates, the gate and the sunset timer, then the beacon", () => {
    const { host, fire, messages } = ruins();
    fire("start");
    expect(host.objective).toBe("Defeat the 4 thorn beetles in the ruins.");
    for (const id of ["beetle_1", "beetle_2", "beetle_3"]) fire("enemyDefeated", { enemyId: id, ...host.defeat(id) });
    expect(host.objective).toBe("Defeat the 4 thorn beetles in the ruins.");
    fire("enemyDefeated", { enemyId: "beetle_4", ...host.defeat("beetle_4") });
    expect(messages()).toContain("Thorn beetle defeated: 4 of 4");
    expect(host.objective).toBe("Push the two stone blocks onto the glowing plates.");
    // One plate is not enough; the beacon does nothing while the gate is shut.
    host.push("block_1", "plate_1");
    fire("blockInZone", { blockId: "block_1", zoneId: "plate_1" });
    expect(host.openGates.size).toBe(0);
    fire("enterZone", { zoneId: "beacon" });
    expect(host.won).toBeNull();
    host.push("block_2", "plate_2");
    fire("blockInZone", { blockId: "block_2", zoneId: "plate_2" });
    expect(host.openGates.has("gate_ruins")).toBe(true);
    expect(host.timers.get("sunset")).toEqual({ left: 90, seconds: 90, repeat: false, countdown: "Sunset in" });
    fire("enterZone", { zoneId: "beacon" });
    expect(host.won).toBe("You lit the beacon before sunset! Thornwood is safe again.");
    expect(host.timers.size).toBe(0);
  });

  it("loses the sunset bonus when the timer runs out first", () => {
    const { host, fire, messages, runtime } = ruins();
    for (const [b, z] of [["block_1", "plate_2"], ["block_2", "plate_1"]] as const) {
      host.push(b, z);
      fire("blockInZone", { blockId: b, zoneId: z });
    }
    expect(host.openGates.has("gate_ruins")).toBe(true);
    host.runOut("sunset");
    fire("timer", { timerId: "sunset" });
    expect(runtime.variables["sunsetBonus"]).toBe(false);
    expect(messages().at(-1)).toMatch(/The sun has set/);
    fire("enterZone", { zoneId: "beacon" });
    expect(host.won).toBe("You lit the beacon. Thornwood is safe again.");
  });

  it("takes hearts on a beetle's touch, warns at one heart, starts again at none, and the spring heals", () => {
    const { host, fire, messages } = ruins();
    expect(host.health).toBe(5);
    for (let i = 0; i < 4; i++) for (const e of host.hitBy("beetle_1")) fire(e.event, e.payload as Record<string, string>);
    expect(host.health).toBe(1);
    expect(messages().filter((m) => /Careful!/.test(m))).toHaveLength(1);
    const last = host.hitBy("beetle_1");
    expect(last.map((e) => e.event)).toEqual(["playerHurt", "playerDefeated"]);
    for (const e of last) fire(e.event, e.payload as Record<string, string>);
    expect(host.health).toBe(5);
    expect(messages().at(-1)).toMatch(/drove you back to the camp/);
    for (const e of host.hitBy("beetle_2")) fire(e.event, e.payload as Record<string, string>);
    fire("enterZone", { zoneId: "spring" });
    expect(host.health).toBe(5);
    expect(messages().at(-1)).toMatch(/restores your hearts/);
  });
});

describe("enemies, blocks and timers in the simulator", () => {
  it("counts enemies and defeats by kind, and blocks by zone", () => {
    const host = new ExploreSimHost(thornwoodRuins());
    expect(host.query("explore.enemyCount", { kind: "beetle" })).toBe(4);
    expect(host.query("explore.enemyCount", { kind: "wolf" })).toBe(0);
    host.defeat("beetle_2");
    expect(host.query("explore.defeatedCount", { kind: "beetle" })).toBe(1);
    expect(() => host.defeat("beetle_2")).toThrow(/already defeated/);
    expect(() => host.defeat("ranger")).toThrow(/not an enemy/);
    host.push("block_1", "plate_1");
    host.push("block_2", "plate_1");
    expect(host.query("explore.blocksInZone", { zoneId: "plate_1" })).toBe(2);
    host.push("block_2", "plate_2");
    expect(host.query("explore.blocksInZone", { zoneId: "plate_1" })).toBe(1);
    expect(() => host.push("block_1", "plate_1")).toThrow(/already stands/);
    expect(() => host.push("ranger", "plate_1")).toThrow(/not a block/);
  });

  it("hurts, heals within the starting hearts, and raises On Player Defeated for a Hurt Player that takes the last one", () => {
    const host = new ExploreSimHost(thornwoodRuins());
    host.call("explore.hurtPlayer", { amount: 2 });
    expect(host.query("explore.playerHealth", {})).toBe(3);
    host.call("explore.healPlayer", { amount: 10 });
    expect(host.health).toBe(5);
    expect(host.pending).toEqual([]);
    host.call("explore.hurtPlayer", { amount: 9 });
    expect(host.health).toBe(5);
    expect(host.pending).toEqual([{ event: "playerDefeated", payload: { sourceId: "rules" } }]);
    expect(new ExploreSimHost(sunCrystalValley()).health).toBe(3);
  });

  it("starts, restarts, repeats and stops timers", () => {
    const host = new ExploreSimHost(thornwoodRuins());
    host.call("explore.startTimer", { timerId: "tick", seconds: 5, repeat: true, countdown: "" });
    host.runOut("tick");
    expect(host.query("explore.timeLeft", { timerId: "tick" })).toBe(5);
    host.call("explore.stopTimer", { timerId: "tick" });
    expect(host.query("explore.timeLeft", { timerId: "tick" })).toBe(0);
    expect(() => host.runOut("tick")).toThrow(/No timer/);
    expect(() => host.call("explore.startTimer", { timerId: "x", seconds: 0, repeat: false, countdown: "" })).toThrow(/above 0/);
    expect(() => host.call("explore.startTimer", { timerId: " ", seconds: 3, repeat: false, countdown: "" })).toThrow(/needs a name/);
  });
});

describe("Godot-only pieces", () => {
  it("marks every enemy, health, block and timer node as Godot-only, and only those", () => {
    const godotOnly = exploreDomain.nodes.filter((n) => n.engines).map((n) => n.type).sort();
    const expected = [
      EXPLORE_NODE.enemyDefeated, EXPLORE_NODE.playerHurt, EXPLORE_NODE.playerDefeated, EXPLORE_NODE.blockInZone, EXPLORE_NODE.timer,
      EXPLORE_NODE.hurtPlayer, EXPLORE_NODE.healPlayer, EXPLORE_NODE.startTimer, EXPLORE_NODE.stopTimer,
      EXPLORE_NODE.health, EXPLORE_NODE.defeated, EXPLORE_NODE.enemies, EXPLORE_NODE.blocksInZone, EXPLORE_NODE.timeLeft,
    ].sort();
    expect(godotOnly).toEqual(expected);
    for (const n of exploreDomain.nodes.filter((x) => x.engines)) expect(n.engines).toEqual(["godot"]);
    expect([...GODOT_ONLY_TYPES].sort()).toEqual(["crate", "enemy", "model"]);
  });

  it("explains why a Unity or Unreal project cannot use them, and lets Godot projects", () => {
    const spec = registry.get(EXPLORE_NODE.startTimer)!;
    expect(engineLimit(spec, "godot")).toBeNull();
    expect(engineLimit(spec, "unity")).toBe("Works in Godot projects only");
    expect(engineDiagnostics(valleyRules(), registry, "unreal")).toEqual([]);
    const d = engineDiagnostics(ruinsRules(), registry, "unity");
    expect(d.length).toBeGreaterThan(5);
    expect(d[0]).toMatchObject({ severity: "error", code: "engine-unsupported" });
    expect(d.map((x) => x.message)).toContain('"Start Timer" works in Godot projects only, and this project uses Unity.');
  });
});
