import { describe, expect, it } from "vitest";
import { BUILTIN_PLUGINS, checkExternalPlugin, checkModules } from "./index";

describe("plugin registry", () => {
  it("has unique ids and resolvable dependencies", () => {
    const ids = BUILTIN_PLUGINS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of BUILTIN_PLUGINS) for (const d of p.requires) expect(ids).toContain(d);
  });

  it("labels foundations honestly", () => {
    for (const p of BUILTIN_PLUGINS.filter((x) => x.status === "foundation")) expect(p.limitations.length).toBeGreaterThan(0);
    expect(BUILTIN_PLUGINS.find((p) => p.id === "xr.openxr")!.limitations.join(" ")).toMatch(/Not verified on a headset/);
  });

  it("accepts declarative external plugins and refuses code or reserved ids", () => {
    const base = { id: "community.ludo", name: "Ludo", version: "0.1.0", description: "Ludo template", author: "Someone", license: "MIT", studioApi: 1, status: "planned", kind: "genre", contributes: { templates: ["ludo"] }, requires: ["core.rules"], limitations: [], executesCode: false };
    expect(checkExternalPlugin(base).ok).toBe(true);
    const code = checkExternalPlugin({ ...base, executesCode: true });
    expect(code.ok).toBe(false);
    expect(checkExternalPlugin({ ...base, id: "game.oware" }).ok).toBe(false);
    expect(checkExternalPlugin({ ...base, id: "nodots" }).ok).toBe(false);
  });

  it("checks project module dependencies", () => {
    expect(checkModules(["core.rules", "game.oware"])).toEqual([]);
    expect(checkModules(["game.oware"])).toEqual(["Oware (Abapa) needs Visual rules."]);
    expect(checkModules(["nope"])).toEqual(["Unknown module 'nope'."]);
  });
});
