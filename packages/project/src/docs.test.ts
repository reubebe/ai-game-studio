import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { owareRulesDoc } from "./templates/oware";
import { ayoRulesDoc } from "./templates/ayo";
import { namnamRulesDoc } from "./templates/namnam";
import { ludoRulesDoc } from "./templates/ludo";

// The repository copy of the Oware rules (referenced from packages/oware/src/engine.ts) must match
// the document every new Oware project receives. Regenerate with UPDATE_DOCS=1.
const DOC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/rulesets/oware-abapa.md");

describe("rules documentation", () => {
  it("docs/rulesets/oware-abapa.md matches the generated project document", () => {
    if (process.env["UPDATE_DOCS"]) {
      mkdirSync(dirname(DOC), { recursive: true });
      writeFileSync(DOC, owareRulesDoc());
    }
    expect(readFileSync(DOC, "utf8")).toBe(owareRulesDoc());
  });

  it("docs/rulesets/ayo.md matches the generated project document", () => {
    const path = resolve(dirname(DOC), "ayo.md");
    if (process.env["UPDATE_DOCS"]) writeFileSync(path, ayoRulesDoc());
    expect(readFileSync(path, "utf8")).toBe(ayoRulesDoc());
  });

  it("docs/rulesets/oware-namnam.md matches the generated project document", () => {
    const path = resolve(dirname(DOC), "oware-namnam.md");
    if (process.env["UPDATE_DOCS"]) writeFileSync(path, namnamRulesDoc());
    expect(readFileSync(path, "utf8")).toBe(namnamRulesDoc());
  });

  it("docs/rulesets/ludo-classic.md matches the generated project document", () => {
    const path = resolve(dirname(DOC), "ludo-classic.md");
    if (process.env["UPDATE_DOCS"]) writeFileSync(path, ludoRulesDoc());
    expect(readFileSync(path, "utf8")).toBe(ludoRulesDoc());
  });
});
