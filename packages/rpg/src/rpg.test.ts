import { describe, expect, it } from "vitest";
import { bestMove, damageFor, parseCatalog, playRound, replayEncounter, startEncounter, starterCatalog } from "./index";

describe("creature catalog", () => {
  it("validates the original starter catalog", () => {
    expect(parseCatalog(starterCatalog()).ok).toBe(true);
    for (const c of starterCatalog().creatures) expect(c.provenance.origin).toBe("original");
  });

  it("rejects duplicate ids, unknown elements and out-of-range stats", () => {
    const bad = starterCatalog();
    bad.creatures.push({ ...bad.creatures[0]!, stats: { ...bad.creatures[0]!.stats, attack: 999 } });
    (bad.effectiveness as Record<string, Record<string, number>>)["lava"] = { sun: 2 };
    const r = parseCatalog(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const text = r.errors.join("\n");
      expect(text).toMatch(/used twice/);
      expect(text).toMatch(/Unknown element 'lava'/);
      expect(text).toMatch(/attack/);
    }
  });
});

describe("encounters", () => {
  const catalog = starterCatalog();

  it("applies the original damage formula and element chart", () => {
    const s = startEncounter(catalog, "emberpip", "mossback");
    const cinder = s.a.moves.find((m) => m.id === "cinder_flick")!;
    // floor(50 * 58 / (68 + 20) * 1.5 / 2) = floor(24.71...) = 24
    expect(damageFor(catalog, s.a, s.b, cinder)).toEqual({ damage: 24, effectiveness: 1.5 });
  });

  it("lets the faster creature act first and stops a fainted creature from acting", () => {
    let s = startEncounter(catalog, "emberpip", "mossback");
    while (!s.winner) s = playRound(catalog, s, "cinder_flick", "vine_snap");
    expect(s.winner).toBe("a");
    const last = s.events.filter((e) => e.type === "move").at(-1);
    expect(last).toMatchObject({ side: "a" });
    expect(s.events.at(-1)).toEqual({ type: "end", winner: "a", xp: 38 });
  });

  it("replays identically", () => {
    // Worked by hand: Emberpip 52 -> 40 -> 10 -> 0; Ripplet 60 -> 46 -> 31 -> 16.
    const rounds: [string, string][] = [["nip", "peck"], ["splash_tail", "cinder_flick"], ["splash_tail", "cinder_flick"]];
    const first = replayEncounter(catalog, "ripplet", "emberpip", rounds);
    expect(first.winner).toBe("a");
    expect([first.a.hp, first.b.hp]).toEqual([16, 0]);
    expect(replayEncounter(catalog, "ripplet", "emberpip", rounds)).toEqual(first);
  });

  it("chooses the most damaging move deterministically", () => {
    const s = startEncounter(catalog, "ripplet", "emberpip");
    expect(bestMove(catalog, s.a, s.b)).toBe("splash_tail");
  });

  it("refuses moves a creature does not know and rounds after the end", () => {
    let s = startEncounter(catalog, "ripplet", "emberpip");
    expect(() => playRound(catalog, s, "vine_snap", "peck")).toThrow(/does not know/);
    while (!s.winner) s = playRound(catalog, s, "splash_tail", "peck");
    expect(() => playRound(catalog, s, "nip", "peck")).toThrow(/over/);
  });
});
