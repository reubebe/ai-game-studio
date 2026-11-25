import { GraphBuilder } from "@gamestudio/rules-core";
import { starterCatalog } from "@gamestudio/rpg";
import { gaitBasicsLesson } from "@gamestudio/learn";
import { baseManifest, commonFiles, finalize, json, type GenerateOptions, type GeneratedProject } from "./common";

export function generateCreatures(o: GenerateOptions): GeneratedProject {
  const manifest = baseManifest(o, {
    template: { id: "creature-collection", version: "1.0.0" },
    genre: ["rpg", "creature-collection"],
    engine: { id: "studio-board", version: "1" },
    modules: ["core.rules", "rpg.creatures"],
    rules: [],
    data: [{ id: "creatures", path: "data/creatures.json", kind: "creature-catalog" }],
    portableFeatures: ["creature-catalog", "encounter-replay"],
  });
  const readme = `# ${manifest.title}

Foundation for an original creature-collection RPG: a creature catalog (\`data/creatures.json\`) and a
deterministic encounter simulator in Game Studio. Every bundled creature is original to this studio;
the catalog records provenance for anything you add.

Not yet included: overworld, catching, quests and saves. See the studio's implementation plan.
`;
  return finalize(manifest, [...commonFiles(manifest, readme), { path: "data/creatures.json", content: json(starterCatalog()) }]);
}

export function generateLesson(o: GenerateOptions): GeneratedProject {
  const lesson = gaitBasicsLesson();
  const manifest = baseManifest(o, {
    template: { id: "science-lesson", version: "1.0.0" },
    genre: ["education", "science", "quiz"],
    engine: { id: "studio-board", version: "1" },
    modules: ["edu.lessons"],
    rules: [],
    data: [{ id: lesson.id, path: `data/lessons/${lesson.id}.json`, kind: "lesson" }],
    portableFeatures: ["lesson", "quiz", "evidence-label"],
  });
  const readme = `# ${manifest.title}

Foundation for educational games: a lesson with objectives, key concepts, a graded quiz and an evidence
label. The sample biomechanics lesson is **illustrative**: its values teach the relationships and are not
a validated physiological model.
`;
  return finalize(manifest, [...commonFiles(manifest, readme), { path: `data/lessons/${lesson.id}.json`, content: json(lesson) }]);
}

export function sandboxGraph() {
  const g = new GraphBuilder("logic-sandbox", "Logic sandbox", "core", "A place to learn visual logic: events, variables, branches and loops.");
  g.variable("total", "number", 0, "Running total");
  g.variable("message", "text", "", "Last message");
  g.node("start", "core.event.start", {}, { x: 0, y: 0 });
  g.node("loop", "core.flow.repeat", { count: 5 }, { x: 300, y: 0 });
  g.node("add", "core.var.add", { variable: "total" }, { x: 620, y: -80 });
  g.node("done", "core.var.set", { variable: "message" }, { x: 620, y: 140 });
  g.node("label", "core.text.join", { a: "Total of 0..4 is " }, { x: 300, y: 260 });
  g.node("total", "core.var.get", { variable: "total" }, { x: 0, y: 260 });
  g.node("log", "core.action.log", {}, { x: 940, y: 140 });
  g.node("message", "core.var.get", { variable: "message" }, { x: 620, y: 300 });
  g.exec("start", "out", "loop").exec("loop", "body", "add").exec("loop", "done", "done").exec("done", "out", "log");
  g.data("loop", "index", "add", "amount").data("total", "value", "label", "b").data("label", "result", "done", "value").data("message", "value", "log", "message");
  return g.build();
}

export function generateSandbox(o: GenerateOptions): GeneratedProject {
  const graph = sandboxGraph();
  const manifest = baseManifest(o, {
    template: { id: "logic-sandbox", version: "1.0.0" },
    genre: ["education", "logic"],
    engine: { id: "studio-board", version: "1" },
    modules: ["core.rules"],
    rules: [{ id: graph.id, path: `rules/${graph.id}.rules.json`, domain: "core" }],
    data: [],
    portableFeatures: ["rules"],
  });
  const readme = `# ${manifest.title}

A visual-logic sandbox. Open **Rules**, run the simulator, and change nodes to see how events,
variables, branches and loops behave.
`;
  return finalize(manifest, [...commonFiles(manifest, readme), { path: `rules/${graph.id}.rules.json`, content: json(graph) }]);
}
