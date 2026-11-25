import type { GenerateRequest } from "./types";

/**
 * Deterministic stand-in for a model, available only in the browser preview so interface tests
 * can exercise the proposal → review → apply flow. It is labelled as not being an AI model.
 */
export function scriptedProposal(request: GenerateRequest): unknown {
  if (request.schemaName === "game_idea_brief") {
    return {
      reply: "Scripted plan: a night-time 2D platformer suits this idea.",
      template: "platformer-2d",
      fit: "good",
      notPossible: "",
      title: "Lantern Ridge",
      description: "A firefly runs and jumps along a moonlit ridge collecting lantern seeds.",
      brief: "Night theme with a deep blue sky and violet hills. Rename the level to Lantern Ridge and change the start sign.",
      inspiredBy: "",
    };
  }
  // The newest message carries the request and the current project context (earlier chat turns come first).
  const text = request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
  const ask = /Request: (.*)/.exec(text)?.[1]?.toLowerCase() ?? "";
  if (ask.trim().endsWith("?")) {
    return { summary: "Scripted answer: a question gets a reply and no changes. Ask me to add a tree, or to change Oware captures, to see a proposal.", operations: [] };
  }
  const allowed = JSON.stringify(request.schema);
  if (/tree/.test(ask) && allowed.includes("world.add")) {
    return { summary: "Add one round tree near the player start.", operations: [{ op: "world.add", objectType: "tree", id: "tree_scripted", x: 8, z: 26, attributes: [{ name: "variant", value: "round" }] }] };
  }
  if (/brand-new project called/.test(text) && allowed.includes("level.settings")) {
    return {
      summary: "Scripted design: renamed the level, made the sky night-blue and rewrote the start sign.",
      operations: [
        { op: "level.settings", name: "name", value: "Lantern Ridge" },
        { op: "level.settings", name: "skyTop", value: "#0d1b3d" },
        { op: "level.settings", name: "hills", value: "#4b3a78" },
        { op: "level.set", id: "sign_start", name: "text", value: "Gather every lantern seed to light the gate." },
      ],
    };
  }
  const graph = /Graph "([a-z0-9-]+)"/.exec(text)?.[1];
  if (/captur/.test(ask) && allowed.includes("rules.setParam") && graph && /- capture: oware\.action\.capture/.test(text)) {
    return { summary: "Also capture pits that hold four seeds.", operations: [{ op: "rules.setParam", graph, node: "capture", name: "counts", value: [2, 3, 4] }] };
  }
  return { summary: "The scripted test provider only answers two requests: add a tree, or change Oware captures.", operations: [] };
}
