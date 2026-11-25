import { generateProject, parseManifest } from "@gamestudio/project";
import type { ProjectDocs } from "./apply";

/** Build parsed project documents from a template, as the studio would after opening it. */
export function docsFromTemplate(templateId: string): ProjectDocs {
  const p = generateProject(templateId, { title: "Agent Test", projectId: "agent-test-0001", now: new Date("2026-11-18T10:00:00Z") });
  const file = (path: string) => JSON.parse(p.files.find((f) => f.path === path)!.content);
  const m = parseManifest(file("gamestudio.json"));
  if (!m.ok) throw new Error(m.errors.join("; "));
  const docs: ProjectDocs = { manifest: m.manifest, rules: {}, lessons: {} };
  for (const r of m.manifest.rules) docs.rules[r.id] = { path: r.path, graph: file(r.path) };
  for (const d of m.manifest.data) {
    if (d.kind === "explore-world") docs.world = { path: d.path, world: file(d.path) };
    if (d.kind === "platformer-level") docs.level = { path: d.path, level: file(d.path) };
    if (d.kind === "football-match") docs.match = { path: d.path, match: file(d.path) };
    if (d.kind === "farm-sim") docs.farm = { path: d.path, farm: file(d.path) };
    if (d.kind === "creature-catalog") docs.catalog = { path: d.path, catalog: file(d.path) };
    if (d.kind === "lesson") docs.lessons[d.id] = { path: d.path, lesson: file(d.path) };
  }
  return docs;
}
