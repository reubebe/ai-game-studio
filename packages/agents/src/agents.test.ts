import { describe, expect, it } from "vitest";
import { createStudioRegistry } from "@gamestudio/project";
import { agentById, allowedOperations, applyProposal, diffJson, OPERATION_KINDS, proposalJsonSchema, routeRequest, runAgent, runChat, partialJsonString, extractJson, AGENTS, SKILLS, MAX_CHAT_TURNS, type ChatTurn, type GenerateFn, type Proposal } from "./index";
import { docsFromTemplate } from "./test-docs";

const registry = createStudioRegistry();
const allWorld = allowedOperations(agentById("world-builder"));

function walk(node: unknown, visit: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (node && typeof node === "object") {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((v) => walk(v, visit));
  }
}

describe("proposal schema sent to providers", () => {
  it("stays inside the structured-output subset every provider accepts", () => {
    const schema = proposalJsonSchema(OPERATION_KINDS);
    walk(schema, (o) => {
      if (o["type"] === "object") expect(o["additionalProperties"], JSON.stringify(o).slice(0, 80)).toBe(false);
      for (const banned of ["minimum", "maximum", "minLength", "maxLength", "multipleOf", "minItems", "maxItems", "$ref"]) expect(o).not.toHaveProperty(banned);
    });
  });

  it("offers each agent only the operations its skills grant", () => {
    expect(allowedOperations(agentById("rules-reviewer"))).toEqual([]);
    expect(allWorld.every((k) => k.startsWith("world."))).toBe(true);
    for (const a of AGENTS) for (const s of a.skills) expect(SKILLS.some((x) => x.id === s)).toBe(true);
  });
});

describe("applying proposals", () => {
  it("applies world operations to a copy and describes each change", () => {
    const docs = docsFromTemplate("exploration-3d");
    const proposal: Proposal = {
      summary: "Add a tree, move a crystal, rename the elder, thicken the fog and speed up the player.",
      operations: [
        { op: "world.add", objectType: "tree", id: "tree_9", x: 10, z: 12, attributes: [{ name: "variant", value: "baobab" }, { name: "scale", value: 1.4 }] },
        { op: "world.move", id: "crystal_1", x: -20, z: 2 },
        { op: "world.set", id: "elder", name: "name", value: "Elder Kofi" },
        { op: "world.environment", name: "fogDensity", value: 0.02 },
        { op: "world.player", name: "speed", value: 8 },
      ],
    };
    const r = applyProposal(docs, proposal, registry, { allowed: allWorld, author: "test" });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.touched).toEqual(["data/world.json"]);
    expect(r.changes.map((c) => c.text)).toEqual([
      "Add tree 'tree_9' at (10, 12)",
      "Move 'crystal_1' from (-24, 6) to (-20, 2)",
      'Set \'elder\' name: "Elder Ama" → "Elder Kofi"',
      "Environment fogDensity: 0.008 → 0.02",
      "Player speed: 6 → 8",
    ]);
    expect(docs.world!.world.objects.some((o) => o.id === "tree_9")).toBe(false);
    expect(r.docs.world!.world.objects.find((o) => o.id === "tree_9")).toMatchObject({ variant: "baobab", scale: 1.4 });
  });

  it("sets the look: sunlight, clouds, grass, the anime or realistic style and a photographed sky, Godot projects only", () => {
    const docs = { ...docsFromTemplate("exploration-3d"), assets: { models: [], textures: [], audio: [], skies: ["assets/skies/meadow/meadow_2k.hdr"] } };
    const ok = applyProposal(
      docs,
      {
        summary: "An evening look with a photographed sky.",
        operations: [
          { op: "world.environment", name: "sunColor", value: "#ffcc88" },
          { op: "world.environment", name: "grass", value: 0.9 },
          { op: "world.environment", name: "style", value: "realistic" },
          { op: "world.environment", name: "skyImage", value: "assets/skies/meadow/meadow_2k.hdr" },
          { op: "world.environment", name: "skyBrightness", value: 1.3 },
        ],
      },
      registry,
      { allowed: allWorld, author: "test" },
    );
    expect(ok.errors).toEqual([]);
    expect(ok.docs.world!.world.environment).toMatchObject({ sunColor: "#ffcc88", grass: 0.9, style: "realistic", skyImage: "assets/skies/meadow/meadow_2k.hdr", skyBrightness: 1.3 });
    expect(ok.changes.map((c) => c.text)).toContain("Style: standard → realistic");
    // Only listed skies; style names checked; numbers kept in range by the level schema.
    const unknown = applyProposal(docs, { summary: "x", operations: [{ op: "world.environment", name: "skyImage", value: "assets/skies/nowhere.hdr" }] }, registry, { allowed: allWorld, author: "t" });
    expect(unknown.errors[0]!.message).toMatch(/There is no sky 'assets\/skies\/nowhere.hdr'. Skies: assets\/skies\/meadow\/meadow_2k.hdr/);
    const style = applyProposal(docs, { summary: "x", operations: [{ op: "world.environment", name: "style", value: "pixel" }] }, registry, { allowed: allWorld, author: "t" });
    expect(style.errors[0]!.message).toMatch(/'standard', 'anime' or 'realistic'/);
    const tooMuch = applyProposal(docs, { summary: "x", operations: [{ op: "world.environment", name: "grass", value: 3 }] }, registry, { allowed: allWorld, author: "t" });
    expect(tooMuch.ok).toBe(false);
    // A Unity project draws none of these.
    const unity = applyProposal(docsFromTemplate("exploration-unity"), { summary: "x", operations: [{ op: "world.environment", name: "style", value: "anime" }] }, registry, { allowed: allWorld, author: "t" });
    expect(unity.errors[0]!.message).toMatch(/drawn by the Godot game only/);
  });

  it("rejects the whole proposal when any operation fails or the result is invalid", () => {
    const docs = docsFromTemplate("exploration-3d");
    const r = applyProposal(docs, { summary: "x", operations: [{ op: "world.move", id: "ghost", x: 0, z: 0 }, { op: "world.player", name: "speed", value: 7 }] }, registry, { allowed: allWorld, author: "t" });
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toMatch(/No object 'ghost'/);
    const outside = applyProposal(docs, { summary: "x", operations: [{ op: "world.move", id: "crystal_1", x: 500, z: 0 }] }, registry, { allowed: allWorld, author: "t" });
    expect(outside.ok).toBe(false);
    expect(outside.diagnostics.map((d) => d.message).join(" ")).toMatch(/outside the map/);
    const sneaky = applyProposal(docs, { summary: "x", operations: [{ op: "rules.removeNode", graph: "valley-rules", id: "open" }] }, registry, { allowed: allWorld, author: "t" });
    expect(sneaky.errors[0]!.message).toMatch(/not allowed/);
  });

  it("edits rule graphs, inferring pin kinds and validating the result", () => {
    const docs = docsFromTemplate("oware-abapa");
    const allowed = allowedOperations(agentById("rules-engineer"));
    const r = applyProposal(docs, { summary: "Capture fours too", operations: [{ op: "rules.setParam", graph: "oware-abapa", node: "capture", name: "counts", value: [2, 3, 4] }] }, registry, { allowed, author: "t" });
    expect(r.ok).toBe(true);
    expect(r.changes[0]!.text).toBe("Capture Check (capture) › Capture when a pit holds: [2,3] → [2,3,4]");
    const withNode = applyProposal(docs, {
      summary: "Announce captures",
      operations: [
        { op: "rules.addNode", graph: "oware-abapa", id: "say", type: "oware.action.announce", x: 1640, y: 360, params: [{ name: "text", value: "Captured!" }] },
        { op: "rules.disconnect", graph: "oware-abapa", from: "end", fromPin: "continue", to: "next", toPin: "in" },
        { op: "rules.connect", graph: "oware-abapa", from: "end", fromPin: "continue", to: "say", toPin: "in" },
        { op: "rules.connect", graph: "oware-abapa", from: "say", fromPin: "out", to: "next", toPin: "in" },
      ],
    }, registry, { allowed, author: "t" });
    expect(withNode.errors).toEqual([]);
    expect(withNode.ok).toBe(true);
    const broken = applyProposal(docs, { summary: "bad", operations: [{ op: "rules.connect", graph: "oware-abapa", from: "move", fromPin: "pit", to: "guard", toPin: "in" }] }, registry, { allowed, author: "t" });
    expect(broken.ok).toBe(false);
  });

  it("places enemies and blocks in Godot projects and refuses them, and hearts, elsewhere", () => {
    const docs = docsFromTemplate("adventure-3d");
    const r = applyProposal(docs, {
      summary: "A tougher guard, a crate and more hearts",
      operations: [
        { op: "world.add", objectType: "enemy", id: "guard_1", x: 0, z: -20, attributes: [{ name: "kind", value: "guard" }, { name: "health", value: 4.4 }, { name: "speed", value: 0 }, { name: "sight", value: 6 }] },
        { op: "world.add", objectType: "crate", id: "crate_9", x: 3, z: 10, attributes: [{ name: "variant", value: "stone" }] },
        { op: "world.set", id: "beetle_1", name: "damage", value: 2 },
        { op: "world.player", name: "health", value: 8 },
      ],
    }, registry, { allowed: allWorld, author: "t" });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    const w = r.docs.world!.world;
    expect(w.objects.find((o) => o.id === "guard_1")).toMatchObject({ type: "enemy", kind: "guard", health: 4, speed: 0, sight: 6 });
    expect(w.objects.find((o) => o.id === "beetle_1")).toMatchObject({ damage: 2 });
    expect(w.player.health).toBe(8);
    const bad = applyProposal(docs, { summary: "x", operations: [{ op: "world.set", id: "block_1", name: "health", value: 3 }] }, registry, { allowed: allWorld, author: "t" });
    expect(bad.errors[0]!.message).toMatch(/A crate has no 'health' setting/);
    const unity = docsFromTemplate("exploration-unity");
    for (const op of [
      { op: "world.add" as const, objectType: "enemy" as const, id: "e1", x: 0, z: 0, attributes: [] },
      { op: "world.add" as const, objectType: "crate" as const, id: "c1", x: 0, z: 0, attributes: [] },
      { op: "world.player" as const, name: "health" as const, value: 5 },
    ]) {
      const refused = applyProposal(unity, { summary: "x", operations: [op] }, registry, { allowed: allWorld, author: "t" });
      expect(refused.ok, op.op).toBe(false);
      expect(refused.errors[0]!.message, op.op).toMatch(/Godot projects only/);
    }
  });

  it("keeps Godot-only rule nodes out of Unity rules, and out of the Rules Engineer's palette there", () => {
    const allowed = allowedOperations(agentById("rules-engineer"));
    const unity = docsFromTemplate("exploration-unity");
    const r = applyProposal(unity, { summary: "A timer", operations: [{ op: "rules.addNode", graph: "valley-rules", id: "clock", type: "explore.action.startTimer", x: 0, y: 2000, params: [] }] }, registry, { allowed, author: "t" });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.map((d) => d.message)).toContain('"Start Timer" works in Godot projects only, and this project uses Unity.');
    const unityContext = agentById("rules-engineer").context(unity, registry);
    expect(unityContext).not.toMatch(/explore\.action\.startTimer/);
    expect(unityContext).toMatch(/explore\.action\.openGate/);
    expect(agentById("rules-engineer").context(docsFromTemplate("adventure-3d"), registry)).toMatch(/explore\.action\.startTimer/);
  });

  it("Match Designer renames teams and players, changes skills and settings, and refuses what the match cannot take", () => {
    const docs = docsFromTemplate("football");
    const allowed = allowedOperations(agentById("match-designer"));
    expect(allowed.sort()).toEqual(["match.player", "match.set", "match.team"]);
    const r = applyProposal(docs, {
      summary: "A night three-a-side for the Coast Comets",
      operations: [
        { op: "match.team", team: "home", name: "name", value: "Coast Comets" },
        { op: "match.team", team: "home", name: "short", value: "com" },
        { op: "match.player", team: "home", slot: 5, name: "name", value: "Abena Quaye" },
        { op: "match.player", team: "home", slot: 5, name: "pace", value: "9" },
        { op: "match.set", name: "teamSize", value: 3 },
        { op: "match.set", name: "control", value: "none" },
        { op: "match.set", name: "grass", value: "#22543d" },
      ],
    }, registry, { allowed, author: "t" });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    const m = r.docs.match!.match;
    expect(m.home).toMatchObject({ name: "Coast Comets", short: "COM" });
    expect(m.home.players[4]).toMatchObject({ name: "Abena Quaye", pace: 9 });
    expect(m).toMatchObject({ teamSize: 3, control: "none" });
    expect(m.pitch.grass).toBe("#22543d");
    expect(r.changes.map((c) => c.text)).toContain('Coast Comets player 5 (Abena Quaye) pace: 8 → 9');
    for (const [op, message] of [
      [{ op: "match.player" as const, team: "away" as const, slot: 6, name: "name" as const, value: "X" }, /slot is 1 to 5/],
      [{ op: "match.set" as const, name: "difficulty" as const, value: "impossible" }, /difficulty is one of/],
      [{ op: "match.set" as const, name: "control" as const, value: "both" }, /control is one of/],
    ] as const) {
      const bad = applyProposal(docs, { summary: "x", operations: [op] }, registry, { allowed, author: "t" });
      expect(bad.errors[0]?.message, JSON.stringify(op)).toMatch(message);
    }
    const twice = applyProposal(docs, { summary: "x", operations: [{ op: "match.player", team: "away", slot: 2, name: "number", value: 1 }] }, registry, { allowed, author: "t" });
    expect(twice.ok).toBe(false);
    expect(twice.diagnostics.map((d) => d.message).join(" ")).toMatch(/Shirt number 1 is used twice/);
    expect(routeRequest("rename my team's players", docs).agent.id).toBe("match-designer");
    expect(routeRequest("give a bonus goal when the score is level", docs).agent.id).toBe("rules-engineer");
  });

  it("Farm Designer adds and changes crops, paints the map and refuses what the farm cannot take", () => {
    const docs = docsFromTemplate("farm-sim");
    const allowed = allowedOperations(agentById("farm-designer"));
    expect(allowed.sort()).toEqual(["farm.addCrop", "farm.crop", "farm.fill", "farm.removeCrop", "farm.set"]);
    const r = applyProposal(docs, {
      summary: "Pumpkins and a second field",
      operations: [
        { op: "farm.addCrop", crop: "pumpkin", name: "Pumpkin" },
        { op: "farm.crop", crop: "pumpkin", name: "days", value: 5 },
        { op: "farm.crop", crop: "pumpkin", name: "price", value: "20" },
        { op: "farm.crop", crop: "pumpkin", name: "needsWater", value: "false" },
        { op: "farm.fill", x: 2, y: 6, width: 2, height: 3, tile: "soil" },
        { op: "farm.set", name: "farmerName", value: "Kojo" },
        { op: "farm.set", name: "rainChance", value: 0.5 },
        { op: "farm.set", name: "width", value: 22 },
      ],
    }, registry, { allowed, author: "t" });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    const f = r.docs.farm!.farm;
    expect(f.crops.find((c) => c.id === "pumpkin")).toMatchObject({ name: "Pumpkin", days: 5, price: 20, needsWater: false });
    expect(f.map.rows[6]!.slice(2, 4)).toBe("ss");
    expect(f.map.width).toBe(22);
    expect(f.map.rows.every((row) => row.length === 22)).toBe(true);
    expect(f.farmer.name).toBe("Kojo");
    expect(f.rainChance).toBe(0.5);
    for (const [op, message] of [
      [{ op: "farm.fill" as const, x: 18, y: 0, width: 5, height: 1, tile: "water" as const }, /leaves the 20 by 12 map/],
      [{ op: "farm.crop" as const, crop: "melon", name: "price" as const, value: 3 }, /no crop 'melon'.*farm\.addCrop/],
      [{ op: "farm.addCrop" as const, crop: "Bad Id", name: "x" }, /not a valid crop id/],
    ] as const) {
      const bad = applyProposal(docs, { summary: "x", operations: [op] }, registry, { allowed, author: "t" });
      expect(bad.errors[0]?.message, JSON.stringify(op)).toMatch(message);
    }
    // Painting over the only house leaves the farm without one: the change is refused as a whole.
    const noHouse = applyProposal(docs, { summary: "x", operations: [{ op: "farm.fill", x: 2, y: 2, width: 2, height: 2, tile: "grass" }] }, registry, { allowed, author: "t" });
    expect(noHouse.ok).toBe(false);
    expect(noHouse.diagnostics.map((d) => d.message).join(" ")).toMatch(/needs a house/);
    expect(routeRequest("add a pumpkin crop", docs).agent.id).toBe("farm-designer");
    expect(agentById("farm-designer").context(docs, registry)).toMatch(/ 5 tggpggssssssssgpgggt/);
  });

  it("adds original creatures with provenance and refuses out-of-range stats", () => {
    const docs = docsFromTemplate("creature-collection");
    const allowed = allowedOperations(agentById("creature-designer"));
    const creature = { op: "creatures.add" as const, id: "galeling", name: "Galeling", element: "plain" as const, description: "A kite-winged lizard that rides warm air.", hp: 48, attack: 52, defense: 38, speed: 77, moves: [{ id: "gust", name: "Gust", element: "plain" as const, power: 40, description: "A sharp burst of wind." }] };
    const r = applyProposal(docs, { summary: "Add Galeling", operations: [creature] }, registry, { allowed, author: "AI assistant (test-model)" });
    expect(r.ok).toBe(true);
    expect(r.docs.catalog!.catalog.creatures.at(-1)!.provenance).toMatchObject({ origin: "original", author: "AI assistant (test-model)" });
    const bad = applyProposal(docs, { summary: "x", operations: [{ ...creature, attack: 900 }] }, registry, { allowed, author: "t" });
    expect(bad.ok).toBe(false);
  });

  it("adds lesson questions of both kinds", () => {
    const docs = docsFromTemplate("science-lesson");
    const allowed = allowedOperations(agentById("lesson-designer"));
    const r = applyProposal(docs, {
      summary: "Two questions",
      operations: [
        { op: "lesson.addQuestion", lesson: "gait-basics", id: "cadence_unit", kind: "single", prompt: "Cadence is measured in?", options: ["Steps per minute", "Metres"], answer: 0, tolerance: 0, unit: "", explanation: "Cadence counts steps per minute." },
        { op: "lesson.addQuestion", lesson: "gait-basics", id: "stride_calc", kind: "numeric", prompt: "Step length 0.75 m. Stride length?", options: [], answer: 1.5, tolerance: 0.01, unit: "m", explanation: "A stride is two steps." },
      ],
    }, registry, { allowed, author: "t" });
    expect(r.ok).toBe(true);
    expect(r.docs.lessons["gait-basics"]!.lesson.questions).toHaveLength(6);
  });
});

describe("value coercion", () => {
  it("converts only unambiguous strings to the declared kind", async () => {
    const { coerceToKind } = await import("./apply");
    expect(coerceToKind("numberList", "[2,3,4]")).toEqual([2, 3, 4]);
    expect(coerceToKind("numberList", "2, 3")).toEqual([2, 3]);
    expect(coerceToKind("numberList", 4)).toEqual([4]);
    expect(coerceToKind("numberList", "two")).toBe("two");
    expect(coerceToKind("number", "4.5")).toBe(4.5);
    expect(coerceToKind("number", "4 seeds")).toBe("4 seeds");
    expect(coerceToKind("boolean", "false")).toBe(false);
    expect(coerceToKind("text", "42")).toBe("42");
  });

  it("lets a stringly-typed list from a small model become a valid setting", () => {
    const docs = docsFromTemplate("oware-abapa");
    const r = applyProposal(docs, { summary: "x", operations: [{ op: "rules.setParam", graph: "oware-abapa", node: "capture", name: "counts", value: "[2,3,4]" }] }, registry, { allowed: allowedOperations(agentById("rules-engineer")), author: "t" });
    expect(r.ok).toBe(true);
    expect(r.docs.rules["oware-abapa"]!.graph.nodes.find((n) => n.id === "capture")!.params["counts"]).toEqual([2, 3, 4]);
  });
});

describe("diffJson", () => {
  it("matches arrays of objects by id", () => {
    const d = diffJson({ objects: [{ id: "a", x: 1 }, { id: "b", x: 2 }] }, { objects: [{ id: "b", x: 3 }, { id: "c", x: 4 }] });
    expect(d).toEqual([
      { path: "/objects[a]", kind: "removed", before: { id: "a", x: 1 } },
      { path: "/objects[b]/x", kind: "changed", before: 2, after: 3 },
      { path: "/objects[c]", kind: "added", after: { id: "c", x: 4 } },
    ]);
  });
});

describe("routing", () => {
  it("picks one specialist per request", () => {
    const explore = docsFromTemplate("exploration-3d");
    const oware = docsFromTemplate("oware-abapa");
    expect(routeRequest("Add three trees near the lake", explore).agent.id).toBe("world-builder");
    expect(routeRequest("When the player collects a crystal, show a different message", explore).agent.id).toBe("rules-engineer");
    expect(routeRequest("Make pits with four seeds capturable", oware).agent.id).toBe("rules-engineer");
    expect(routeRequest("Review the variant sources", oware).agent.id).toBe("rules-reviewer");
    expect(routeRequest("Add a creature", explore).agent.id).not.toBe("creature-designer");
  });
});

describe("runAgent", () => {
  const docs = docsFromTemplate("exploration-3d");
  const agent = agentById("world-builder");
  const good = JSON.stringify({ summary: "Add a rock", operations: [{ op: "world.add", objectType: "rock", id: "rock_9", x: 0, z: 0, attributes: [] }] });

  it("repairs once after an invalid answer", async () => {
    const answers = ["not json at all", "```json\n" + good + "\n```"];
    const seen: number[] = [];
    const generate: GenerateFn = async (input) => {
      seen.push(input.messages.length);
      return { text: answers.shift()!, provider: "fake", model: "fake-1" };
    };
    const run = await runAgent({ agent, request: "Add a rock", docs, registry, generate, author: "AI assistant ({model})" });
    expect(run.status).toBe("ready");
    expect(run.attempts).toHaveLength(2);
    expect(run.attempts[0]!.problems).toEqual(["The answer was not valid JSON."]);
    expect(seen).toEqual([1, 3]);
  });

  it("stops after two failed attempts", async () => {
    let calls = 0;
    const generate: GenerateFn = async () => {
      calls++;
      return { text: JSON.stringify({ summary: "x", operations: [{ op: "world.move", id: "nope", x: 0, z: 0 }] }), provider: "fake", model: "fake-1" };
    };
    const run = await runAgent({ agent, request: "Move nope", docs, registry, generate, author: "t" });
    expect(run.status).toBe("invalid");
    expect(calls).toBe(2);
  });

  it("reports provider failures and empty proposals", async () => {
    const failing: GenerateFn = async () => {
      throw { code: "unavailable", message: "Ollama is not running" };
    };
    expect(await runAgent({ agent, request: "x", docs, registry, generate: failing, author: "t" })).toMatchObject({ status: "failed", message: "Ollama is not running" });
    const empty: GenerateFn = async () => ({ text: JSON.stringify({ summary: "Nothing to change.", operations: [] }), provider: "fake", model: "f" });
    expect((await runAgent({ agent, request: "x", docs, registry, generate: empty, author: "t" })).status).toBe("no-change");
  });

  it("extracts JSON from fenced or chatty answers", () => {
    expect(extractJson("Sure! {\"a\":1} hope that helps")).toBe('{"a":1}');
    expect(extractJson("```\n{\"b\":2}\n```")).toBe('{"b":2}');
  });
});

describe("chat", () => {
  const docs = docsFromTemplate("exploration-3d");
  const agent = agentById("world-builder");

  it("sends earlier turns, puts the project context on the newest message and streams the answer", async () => {
    const history: ChatTurn[] = [
      { role: "user", content: "What makes a good first level?" },
      { role: "assistant", content: JSON.stringify({ summary: "A short path with one clear goal.", operations: [] }) },
    ];
    let sent: Parameters<GenerateFn>[0] | null = null;
    const pieces: string[] = [];
    const attempts: number[] = [];
    const answer = JSON.stringify({ summary: "Then add a rock by the start.", operations: [{ op: "world.add", objectType: "rock", id: "rock_chat", x: 1, z: 1, attributes: [] }] });
    const generate: GenerateFn = async (input) => {
      sent = input;
      for (const piece of answer.match(/[\s\S]{1,9}/g)!) input.onText?.(piece);
      return { text: answer, provider: "fake", model: "fake-1" };
    };
    const run = await runChat({ agent, history, message: "Add a rock by the start", docs, registry, generate, author: "t", onText: (p) => pieces.push(p), onAttempt: (n) => attempts.push(n) });
    expect(run.status).toBe("ready");
    expect(run.message).toBe("Then add a rock by the start.");
    expect(pieces.join("")).toBe(answer);
    expect(attempts).toEqual([1]);
    expect(sent!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(sent!.messages[0]!.content).toBe("What makes a good first level?");
    expect(sent!.messages[2]!.content).toContain("Request: Add a rock by the start");
    expect(sent!.messages[2]!.content).toContain("Current project context:");
    expect(sent!.system).toContain("This is a conversation with the user");
  });

  it("answers questions without changes and keeps only recent turns", async () => {
    const long: ChatTurn[] = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i}` }));
    let count = 0;
    const generate: GenerateFn = async (input) => {
      count = input.messages.length;
      return { text: JSON.stringify({ summary: "Crystals glow so players can find them.", operations: [] }), provider: "fake", model: "f" };
    };
    const run = await runChat({ agent, history: long, message: "Why do crystals glow?", docs, registry, generate, author: "t" });
    expect(run.status).toBe("no-change");
    expect(run.message).toBe("Crystals glow so players can find them.");
    expect(count).toBe(MAX_CHAT_TURNS + 1);
  });

  it("reads a reply's text while the JSON is still arriving", () => {
    expect(partialJsonString('{"operat', "summary")).toBeNull();
    expect(partialJsonString('{"summary": "Hel', "summary")).toBe("Hel");
    expect(partialJsonString('{"summary":"Line one\\nLine \\"two\\"", "operations"', "summary")).toBe('Line one\nLine "two"');
    expect(partialJsonString('{"summary":"caf\\u00e9 and \\', "summary")).toBe("café and ");
    expect(partialJsonString('{"summary":"half \\u00', "summary")).toBe("half ");
  });
});

/** Live test with the local Ollama service (free). Enable with OLLAMA_LIVE=1. */
describe.skipIf(process.env["OLLAMA_LIVE"] !== "1")("live local model (Ollama)", () => {
  const model = process.env["OLLAMA_MODEL"] ?? "qwen3:8b";
  const generate: GenerateFn = async (input) => {
    const resp = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      body: JSON.stringify({ model, stream: false, think: false, format: input.schema, options: { temperature: 0.2 }, messages: [{ role: "system", content: input.system }, ...input.messages] }),
    });
    const body = (await resp.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
    return { text: body.message?.content ?? "", provider: "ollama", model, inputTokens: body.prompt_eval_count ?? null, outputTokens: body.eval_count ?? null };
  };

  it("World Builder turns a request into a valid, applicable proposal", async () => {
    const docs = docsFromTemplate("exploration-3d");
    const run = await runAgent({ agent: agentById("world-builder"), request: "Add two rocks next to the lake.", docs, registry, generate, author: `AI assistant (${model})` });
    console.log(JSON.stringify({ status: run.status, attempts: run.attempts.map((a) => a.problems), changes: run.result?.changes.map((c) => c.text) }, null, 1));
    expect(run.status).toBe("ready");
    expect(run.result!.changes.some((c) => /Add rock/.test(c.text))).toBe(true);
  }, 240000);

  it("Rules Engineer changes an Oware setting through the graph", async () => {
    const docs = docsFromTemplate("oware-abapa");
    const run = await runAgent({ agent: agentById("rules-engineer"), request: "Change the capture rule so pits holding 2, 3 or 4 seeds are captured.", docs, registry, generate, author: `AI assistant (${model})` });
    console.log(JSON.stringify({ status: run.status, attempts: run.attempts.map((a) => a.problems), changes: run.result?.changes.map((c) => c.text) }, null, 1));
    expect(run.status).toBe("ready");
    expect(run.result!.docs.rules["oware-abapa"]!.graph.nodes.find((n) => n.id === "capture")!.params["counts"]).toEqual([2, 3, 4]);
  }, 240000);
});
